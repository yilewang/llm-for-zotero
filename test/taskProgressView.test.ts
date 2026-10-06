import { assert } from "chai";
import type { TaskPaperScopeEntry } from "../src/agent/context/taskPaperScopeListing";
import {
  taskPaperDigestPartLabel,
  type TaskPaperLedgerDelta,
  type TaskPaperLedgerEntry,
  type TaskPaperReadEvent,
} from "../src/agent/context/taskPaperLedger";
import type { ExecutionCheckpointTask } from "../src/agent/execution/types";
import type { AgentRunEventRecord } from "../src/agent/types";
import { buildTaskProgressHistory } from "../src/modules/contextPanel/taskProgress/history";
import {
  applyTaskDocumentCitations,
  applyTaskPaperUpdate,
  beginTaskAction,
  beginTaskRun,
  endTaskAction,
  setTaskActionStep,
  setTaskActionSummary,
  setTaskChecklist,
  clearAllTaskProgress,
  clearTaskProgress,
  completeTaskRun,
  endTaskRun,
  getTaskProgress,
  hydrateTaskProgress,
  markTaskAnswering,
  markTaskWaiting,
  setTaskOutcomes,
  setTaskScope,
  taskReadInDepth,
} from "../src/modules/contextPanel/taskProgress/store";
import {
  OUTCOME_REASONS,
  applyOutcomeEvidence,
  decideRunEnd,
  settleOutcomes,
} from "../src/agent/loop/outcomes";
import { executionCheckpointEvent } from "../src/agent/execution/checkpointEvents";
import { DIGEST_FAILURE_REASONS } from "../src/agent/digests/paperDigestWorker";
import { initI18n, t } from "../src/utils/i18n";
import {
  TASK_PROGRESS_FLASH_MS,
  TASK_PROGRESS_OPEN_PASSAGE_EVENT,
  TASK_PROGRESS_DRAWER_MIN_PX,
  TASK_PROGRESS_WINDOW,
  createTaskProgressCurtain,
  createTaskProgressDrawer,
  createTaskProgressRow,
  cleanTaskPaperSnippet,
  formatTaskPaperPassageLabel,
  formatTaskPaperTail,
  formatTaskProgressCount,
  getRememberedTaskProgressDrawerHeight,
  mountTaskProgressView,
  resetTaskProgressDrawerHeight,
  type TaskProgressLayout,
  type TaskProgressPaperRow,
  type TaskProgressView,
  type TaskProgressViewInput,
} from "../src/modules/contextPanel/taskProgress/view";
import { collectFakeText, fakeDocument, FakeElement } from "./helpers/fakeDom";
import {
  digestLedgerDelta,
  ledgerDelta,
  outcomeCheckpoint,
  outcomeTask,
  quoteCitation,
} from "./helpers/taskProgressFixtures";

const KEY = 42;

function scopeEntries(count: number): TaskPaperScopeEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `1:${index + 1}`,
    libraryID: 1,
    itemId: index + 1,
    title: `Paper ${index + 1}`,
    year: "2021",
    firstCreator: "Smith",
    collectionPaths: ["Drift"],
    tags: ["drift"],
    text: "pdf" as const,
  }));
}

function seedScope(count = 200) {
  setTaskScope(KEY, {
    signature: "drift",
    libraryID: 1,
    contexts: { collections: [{ collectionId: 5 }] },
    label: "Drift + Learning",
    listing: {
      libraryID: 1,
      wholeLibrary: false,
      entries: scopeEntries(count),
      totalItems: count,
      listedItems: count,
      truncated: false,
    },
  });
}

type Harness = {
  view: TaskProgressView;
  row: FakeElement;
  drawer: FakeElement;
  body: FakeElement;
  grip: FakeElement;
  shell: FakeElement;
  chatBox: FakeElement;
  panel: FakeElement;
  messages: FakeElement;
  timers: Map<number, { callback: () => void; ms: number }>;
  runTimers: () => void;
  navigated: FakeElement[];
  mineruAsked: number[];
  count: () => string;
  items: () => FakeElement[];
};

function mount(
  input: Partial<TaskProgressViewInput> = {},
  options: {
    mineru?: (itemId: number) => boolean;
    layout?: TaskProgressLayout;
    doc?: Document;
    /** Set to true to make timers throw, as a closed window's do. */
    windowClosed?: { value: boolean };
    resolvePaperLabel?: (itemId: number) => string | null;
  } = {},
): Harness {
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let handle = 0;
  let now = 0;
  const row = createTaskProgressRow(fakeDocument) as unknown as FakeElement;
  const drawer = createTaskProgressDrawer(
    fakeDocument,
  ) as unknown as FakeElement;
  const shell = new FakeElement("div");
  shell.className = "llm-chat-shell";
  const messages = new FakeElement("div");
  messages.className = "llm-messages";
  shell.append(drawer, messages);
  const chatBox = messages;
  const panel = new FakeElement("div");
  panel.append(row, shell);
  const navigated: FakeElement[] = [];
  const mineruAsked: number[] = [];
  const view = mountTaskProgressView({
    doc: options.doc || fakeDocument,
    row: row as unknown as HTMLButtonElement,
    drawer: drawer as unknown as HTMLElement,
    shell: shell as unknown as HTMLElement,
    chatBox: chatBox as unknown as HTMLElement,
    keyTarget: panel as unknown as HTMLElement,
    deps: {
      setTimeout: (callback, ms) => {
        if (options.windowClosed?.value) {
          throw new Error("Component not initialized");
        }
        timers.set(++handle, { callback, ms });
        return handle;
      },
      clearTimeout: (id) => {
        if (options.windowClosed?.value) {
          throw new Error("Component not initialized");
        }
        timers.delete(id as number);
      },
      now: () => now,
      resolveMineru: options.mineru
        ? async ({ itemId }) => {
            mineruAsked.push(itemId);
            return options.mineru!(itemId);
          }
        : undefined,
      navigateToCitation: (card) => navigated.push(card as never),
      layout: options.layout,
      resolvePaperLabel: options.resolvePaperLabel,
    },
  });
  view.setInput({
    conversationKey: KEY,
    recordsReads: true,
    visibility: {
      conversationKind: "global",
      isWebChat: false,
      isNoteSession: false,
      collectionCount: 1,
      tagCount: 0,
      paperCount: 0,
    },
    ...input,
  });
  return {
    view,
    row,
    drawer,
    body: drawer.findByClass("llm-task-progress-drawer-body")!,
    grip: drawer.findByClass("llm-task-progress-drawer-grip")!,
    shell,
    chatBox,
    panel,
    messages,
    timers,
    runTimers() {
      now += 1000;
      for (const [id, timer] of Array.from(timers)) {
        timers.delete(id);
        timer.callback();
      }
    },
    navigated,
    mineruAsked,
    count: () => row.findByClass("llm-task-progress-count")!.textContent,
    items: () => drawer.findAllByClass("llm-task-paper"),
  };
}

const MAX_VAR = "--llm-task-progress-drawer-max";

/** A layout whose motion, chat strip and resize callbacks a test drives. */
function fakeLayout(options: { ms?: number; strip?: number } = {}) {
  const observers: Array<() => void> = [];
  let chatResized = 0;
  const layout: TaskProgressLayout = {
    motionMs: () => options.ms ?? 200,
    curtainMs: () => options.ms ?? 200,
    chatStripPx: () => options.strip ?? 96,
    observeResize: (_target, onResize) => {
      observers.push(onResize);
      return () => observers.splice(0);
    },
    onChatResized: () => {
      chatResized += 1;
    },
  };
  return {
    layout,
    fireResize: () => observers.forEach((onResize) => onResize()),
    chatResized: () => chatResized,
  };
}

/**
 * Give the fake drawer and chat heights: the drawer is `natural` tall unless
 * an inline height or a dragged maximum says less; the chat takes the rest of
 * a `shell` tall column.
 */
function fakeHeights(
  harness: Harness,
  natural: number,
  shell: number,
): () => number {
  const drawerHeight = () => {
    const inline = String(harness.drawer.style.height || "");
    if (inline) return parseFloat(inline);
    const max = parseFloat(String(harness.drawer.style[MAX_VAR] || ""));
    return Number.isFinite(max) ? Math.min(natural, max) : natural;
  };
  (harness.drawer as any).getBoundingClientRect = () => ({
    height: drawerHeight(),
  });
  (harness.chatBox as any).getBoundingClientRect = () => ({
    height: shell - drawerHeight(),
  });
  return drawerHeight;
}

function transitionEnd(target: FakeElement, propertyName = "height") {
  return target.dispatchFakeEvent("transitionend", {
    target,
    propertyName,
  } as never);
}

/** A document the drag listeners can attach to. */
function draggableDocument(): { doc: Document; target: FakeElement } {
  const target = new FakeElement("document");
  const doc = {
    ...(fakeDocument as unknown as Record<string, unknown>),
    addEventListener: (type: string, listener: (event: any) => void) =>
      target.addEventListener(type, listener),
    removeEventListener: (type: string, listener: (event: any) => void) =>
      target.removeEventListener(type, listener),
  } as unknown as Document;
  return { doc, target };
}

describe("task progress view", function () {
  const views: TaskProgressView[] = [];
  afterEach(function () {
    for (const view of views.splice(0)) view.dispose();
    clearAllTaskProgress();
    resetTaskProgressDrawerHeight();
  });
  function track(harness: Harness): Harness {
    views.push(harness.view);
    return harness;
  }

  it("stops listening once its window is gone, without breaking store writers", function () {
    seedScope();
    const windowClosed = { value: false };
    const harness = track(mount({}, { windowClosed }));
    beginTaskRun(KEY, { runId: "run-a" });
    harness.runTimers();
    windowClosed.value = true;
    // A write repaints every view; this one's timer throws. The writer must
    // still finish, and the view must stop listening.
    assert.doesNotThrow(() => clearTaskProgress(KEY));
    windowClosed.value = false;
    beginTaskRun(KEY, { runId: "run-b" });
    assert.equal(harness.timers.size, 0, "a dead view schedules nothing");
  });

  it("tears down whole when its window closed with timers pending", function () {
    seedScope(5);
    const windowClosed = { value: false };
    const motion = fakeLayout({ ms: 200 });
    const harness = track(mount({}, { windowClosed, layout: motion.layout }));
    fakeHeights(harness, 300, 700);
    beginTaskRun(KEY, { runId: "run-a" });
    harness.runTimers();
    // The drawer is mid-motion and a repaint is due when the window closes.
    harness.row.dispatchFakeEvent("click");
    applyTaskPaperUpdate(KEY, ledgerDelta("c1", [[1, "read"]]), "run-a");
    assert.isAtLeast(harness.timers.size, 2, "timers are pending");
    windowClosed.value = true;
    // A closed window's clearTimeout throws, as its setTimeout does.
    assert.doesNotThrow(() => harness.view.dispose());
    windowClosed.value = false;
    assert.isFalse(
      harness.row.dispatchFakeEvent("click").defaultPrevented,
      "the row stopped listening",
    );
    assert.isFalse(
      harness.grip.dispatchFakeEvent("dblclick").defaultPrevented,
      "the grip stopped listening",
    );
    const resized = motion.chatResized();
    motion.fireResize();
    assert.equal(motion.chatResized(), resized, "the drawer is not observed");
  });

  it("hides the row where it does not apply and names the scope where it does", function () {
    seedScope();
    const hidden = track(
      mount({
        visibility: {
          conversationKind: "paper",
          isWebChat: false,
          isNoteSession: false,
          collectionCount: 0,
          tagCount: 0,
          paperCount: 1,
        },
      }),
    );
    assert.isTrue((hidden.row as any).hidden);
    const shown = track(mount());
    assert.isFalse((shown.row as any).hidden);
    assert.equal(shown.row.dataset.state, "idle");
    assert.equal(shown.count(), "200 papers in scope");
    assert.equal(shown.row.getAttribute("aria-expanded"), "false");
    assert.equal(
      shown.row.getAttribute("aria-controls"),
      "llm-task-progress-drawer",
    );
    assert.equal(shown.drawer.getAttribute("role"), "region");
  });

  it("walks the row through working, answering, completed, failed and cancelled", function () {
    seedScope();
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "run-a" });
    harness.view.flush();
    assert.equal(harness.row.dataset.state, "working");
    assert.equal(harness.count(), "0 of 200 read");
    applyTaskPaperUpdate(
      KEY,
      ledgerDelta("c1", [
        [1, "read", "One"],
        [2, "skimmed"],
        [3, "matched"],
      ]),
      "run-a",
    );
    harness.view.flush();
    assert.equal(harness.count(), "2 of 200 read");
    markTaskAnswering(KEY, "run-a");
    harness.view.flush();
    assert.equal(harness.row.dataset.state, "answering");
    assert.equal(harness.count(), "Answering… · 2 of 200 read");
    completeTaskRun(KEY, {
      runId: "run-a",
      quoteCitations: [quoteCitation("q1", 1)],
    });
    harness.view.flush();
    assert.equal(harness.row.dataset.state, "completed");
    assert.equal(harness.count(), "2 of 200 read · 1 cited");
    const pill = () => harness.row.findByClass("llm-task-progress-pill") as any;
    assert.isFalse(pill().hidden);
    assert.equal(pill().textContent, "Completed");

    beginTaskRun(KEY, { runId: "run-b" });
    endTaskRun(KEY, "failed", "run-b");
    harness.view.flush();
    assert.equal(harness.row.dataset.state, "failed");
    assert.equal(
      harness.count(),
      "0 of 200 read",
      "the row summarizes the latest question",
    );
    assert.equal(pill().textContent, "Failed");
    assert.equal(pill().dataset.tone, "failed");
    beginTaskRun(KEY, { runId: "run-c" });
    endTaskRun(KEY, "cancelled");
    harness.view.flush();
    assert.equal(harness.row.dataset.state, "cancelled");
    assert.equal(harness.count(), "0 of 200 read");
    assert.equal(pill().textContent, "Cancelled");
  });

  it("offers removal for the context bar's papers, never the chat's own paper", function () {
    seedScope(3);
    const harness = track(mount({ basePaperItemId: 2 }));
    harness.view.flush();
    harness.row.dispatchFakeEvent("click");
    const [first, own, third] = harness.items();
    const removeOf = (item: FakeElement) =>
      item.findByClass("llm-task-paper-remove") as any;
    assert.isFalse(removeOf(first).hidden);
    assert.isTrue(removeOf(own).hidden, "the paper chat's own paper stays");
    assert.isFalse(removeOf(third).hidden);
    assert.include(first.className, "llm-task-paper-removable");
  });

  it("lists only the scope in plain chat, with the Agent-mode note", function () {
    seedScope(12);
    const harness = track(mount({ recordsReads: false }));
    beginTaskRun(KEY);
    harness.view.flush();
    assert.equal(harness.count(), "12 papers in scope");
    harness.row.dispatchFakeEvent("click");
    const note = harness.drawer.findByClass("llm-task-progress-note")!;
    assert.isFalse((note as any).hidden);
    const first = harness.items()[0];
    first.findByClass("llm-task-paper-summary")!.dispatchFakeEvent("click");
    assert.include(
      collectFakeText(first.findByClass("llm-task-paper-details")),
      "Reads are recorded in Agent mode.",
    );
  });
  it("unrolls in the chat shell, windows the list and grows it on scroll", function () {
    seedScope(200);
    const harness = track(mount());
    harness.row.dispatchFakeEvent("click");
    assert.isTrue(harness.view.isOpen());
    assert.isFalse((harness.drawer as any).hidden);
    assert.equal(harness.drawer.dataset.state, "open");
    assert.isTrue(harness.shell.classList.contains("llm-task-progress-shown"));
    assert.equal(harness.row.getAttribute("aria-expanded"), "true");
    assert.isUndefined(
      (harness.messages.style as any).display,
      "messages are never display:none",
    );
    assert.equal(harness.view.renderedRowCount(), TASK_PROGRESS_WINDOW);
    assert.deepEqual(
      harness
        .items()
        .slice(0, 3)
        .map((item) => item.findByClass("llm-task-paper-index")!.textContent),
      ["1", "2", "3"],
    );
    Object.assign(harness.body, {
      scrollHeight: 4000,
      clientHeight: 600,
      scrollTop: 3300,
    });
    harness.body.dispatchFakeEvent("scroll");
    assert.equal(harness.view.renderedRowCount(), 2 * TASK_PROGRESS_WINDOW);
    assert.equal(
      harness.items()[159].findByClass("llm-task-paper-index")!.textContent,
      "160",
    );
    harness.row.dispatchFakeEvent("click");
    assert.isFalse(harness.view.isOpen());
    assert.isTrue((harness.drawer as any).hidden);
    assert.equal(harness.drawer.dataset.state, "closed");
    assert.isFalse(harness.shell.classList.contains("llm-task-progress-shown"));
  });

  it("expands a paper to show its reads grouped by question", function () {
    seedScope(5);
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "run-a" });
    applyTaskPaperUpdate(
      KEY,
      ledgerDelta("c1", [
        [2, "read", "Drift grows with time."],
        [3, "matched"],
      ]),
      "run-a",
    );
    harness.row.dispatchFakeEvent("click");
    const [first, second, third] = harness.items();
    assert.equal(first.dataset.state, "listed");
    assert.equal(second.dataset.state, "read");
    assert.equal(third.dataset.state, "matched");
    assert.equal(
      second.findByClass("llm-task-paper-tail")!.textContent,
      "Results",
      "a labelled passage names its section, not a passage count",
    );
    assert.equal(
      second.findByClass("llm-task-paper-meta-text")!.textContent,
      "Smith 2021 · Drift · drift",
    );
    const summary = second.findByClass("llm-task-paper-summary")!;
    summary.dispatchFakeEvent("click");
    const details = second.findByClass("llm-task-paper-details")!;
    assert.isFalse((details as any).hidden);
    assert.equal(summary.getAttribute("aria-expanded"), "true");
    const text = collectFakeText(details);
    // Where it was read, and what: no tool, method or question heading when
    // a single question read the paper.
    assert.include(text, "Results");
    assert.include(text, "Drift grows with time.");
    assert.notInclude(text, "Retrieve Library");
    assert.notInclude(text, "BM25");
    assert.notInclude(text, "Question");
    third.findByClass("llm-task-paper-summary")!.dispatchFakeEvent("click");
    assert.include(
      collectFakeText(third.findByClass("llm-task-paper-details")),
      "Matched by title or abstract; text not opened.",
    );
    first.findByClass("llm-task-paper-summary")!.dispatchFakeEvent("click");
    assert.include(
      collectFakeText(first.findByClass("llm-task-paper-details")),
      "Listed in scope; not read for this question.",
    );
    summary.dispatchFakeEvent("click");
    assert.isTrue((details as any).hidden);
    assert.equal(summary.getAttribute("aria-expanded"), "false");
  });

  it("labels a read by its section, never by the paper's own title", function () {
    const read = (patch: Partial<TaskPaperReadEvent>): TaskPaperReadEvent => ({
      key: "1:1",
      callId: "c",
      toolName: "library_retrieve",
      granularity: "passage",
      ...patch,
    });
    const title = "Emergence of stable striatal ensembles";
    assert.equal(
      formatTaskPaperPassageLabel(read({ label: "Methods §2.3" }), title),
      "Methods §2.3",
    );
    assert.equal(
      formatTaskPaperPassageLabel(
        read({ label: "Emergence of stable striatal ensembles" }),
        title,
      ),
      "Passage",
    );
    assert.equal(
      formatTaskPaperPassageLabel(read({ granularity: "abstract" }), title),
      "Abstract",
    );
    assert.equal(
      formatTaskPaperPassageLabel(
        read({ granularity: "full", label: "12/40 chunks" }),
        title,
      ),
      "Full text",
    );
    assert.equal(
      cleanTaskPaperSnippet(
        "# Emergence of stable ensembles\nMeng-jun Sheng, Di $\\mathbf { L }$ Lu and Mu-ming Poo",
      ),
      "Emergence of stable ensembles Meng-jun Sheng, Di Lu and Mu-ming Poo",
    );
  });

  it("says Full text for a complete read, names sections for targeted reads, and counts passages otherwise", function () {
    const row = (
      reads: Partial<TaskPaperReadEvent>[],
      options: { citations?: number } = {},
    ): TaskProgressPaperRow => {
      const entry: TaskPaperLedgerEntry = {
        key: "1:1",
        libraryID: 1,
        itemId: 1,
        contextItemIds: [],
        text: "unknown",
        state: options.citations ? "cited" : "read",
        latestTurn: 1,
        turns: {
          1: {
            state: options.citations ? "cited" : "read",
            readState: "read",
            reads: reads.map((read) => ({
              key: "1:1",
              callId: "c",
              toolName: "paper_read",
              granularity: "passage" as const,
              ...read,
            })),
            droppedReads: 0,
            citations: Array.from(
              { length: options.citations || 0 },
              (_, index) => ({ citationId: `q${index}`, turnIndex: 1 }),
            ),
            droppedCitations: 0,
          },
        },
      };
      return {
        key: "1:1",
        index: 1,
        libraryID: 1,
        itemId: 1,
        title: "Paper",
        creator: "",
        year: "",
        folders: [],
        tags: [],
        scopeText: "unknown",
        inScope: true,
        entry,
        state: entry.state,
        turnState: entry.state,
      };
    };
    assert.equal(
      formatTaskPaperTail(row([{ granularity: "full", snippet: "Body." }])),
      "Full text",
    );
    assert.equal(
      formatTaskPaperTail(
        row([
          { granularity: "section", label: "Methods", snippet: "a" },
          { granularity: "section", label: "Results", snippet: "b" },
        ]),
      ),
      "Methods, Results",
    );
    assert.equal(
      formatTaskPaperTail(
        row(
          ["A", "B", "C", "D"].map((label) => ({
            granularity: "section" as const,
            label,
            snippet: label,
          })),
        ),
      ),
      "A, B, C…",
    );
    assert.equal(
      formatTaskPaperTail(row([{ snippet: "a" }, { snippet: "b" }])),
      "2 passages",
    );
    assert.equal(
      formatTaskPaperTail(
        row([
          { label: "p. 4", snippet: "a" },
          { label: "Paper", snippet: "b" },
        ]),
      ),
      "2 passages",
      "a page label or the paper's own title names no section",
    );
    assert.equal(
      formatTaskPaperTail(
        row([{ granularity: "full", snippet: "Body." }], { citations: 2 }),
      ),
      "Full text · cited 2",
    );
    assert.equal(
      cleanTaskPaperSnippet("[chunk 0] # Title\nBody"),
      "Title Body",
    );
    assert.equal(
      cleanTaskPaperSnippet("[chunk 3 p. 2]\n## Results\nBody"),
      "Results Body",
    );
  });

  it("counts distinct passages, and strips inline heading marks from a snippet", function () {
    const entry: TaskPaperLedgerEntry = {
      key: "1:1",
      libraryID: 1,
      itemId: 1,
      contextItemIds: [],
      text: "unknown",
      state: "read",
      latestTurn: 2,
      turns: {
        1: {
          state: "read",
          readState: "read",
          reads: ["a", "b"].map((snippet) => ({
            key: "1:1",
            callId: "c1",
            toolName: "paper_read",
            granularity: "passage" as const,
            snippet,
          })),
          droppedReads: 0,
          citations: [],
          droppedCitations: 0,
        },
        2: {
          state: "read",
          readState: "read",
          reads: ["a", "b", "c"].map((snippet) => ({
            key: "1:1",
            callId: "c2",
            toolName: "paper_read",
            granularity: "passage" as const,
            snippet,
          })),
          droppedReads: 0,
          citations: [],
          droppedCitations: 0,
        },
      },
    };
    assert.equal(
      formatTaskPaperTail({
        key: "1:1",
        index: 1,
        libraryID: 1,
        itemId: 1,
        title: "Paper",
        creator: "",
        year: "",
        folders: [],
        tags: [],
        scopeText: "unknown",
        inScope: true,
        entry,
        state: "read",
        turnState: "read",
      }),
      "3 passages",
    );
    assert.equal(
      cleanTaskPaperSnippet(
        "Grid cells Jane Doe1 ## Abstract Grid cells in the entorhinal cortex",
      ),
      "Grid cells Jane Doe1 Abstract Grid cells in the entorhinal cortex",
    );
    assert.equal(
      cleanTaskPaperSnippet("C# code and #1 rank"),
      "C# code and #1 rank",
    );
  });

  it("numbers the listed rows after metadata-only rows fold away", function () {
    seedScope(3);
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "run-a" });
    applyTaskPaperUpdate(
      KEY,
      {
        version: 1,
        callId: "overview",
        runId: "run-a",
        toolName: "paper_read",
        papers: [
          {
            key: "1:2",
            libraryID: 1,
            itemId: 2,
            text: "none",
            state: "matched",
          },
        ],
        reads: [
          {
            key: "1:2",
            callId: "overview",
            toolName: "paper_read",
            granularity: "metadata",
            method: "overview",
          },
        ],
      },
      "run-a",
    );
    harness.runTimers();
    harness.row.dispatchFakeEvent("click");
    const rows = harness
      .items()
      .map((item) => [
        item.findByClass("llm-task-paper-index")!.textContent,
        item.findByClass("llm-task-paper-title")!.textContent,
      ]);
    assert.deepEqual(rows, [
      ["1", "Paper 1"],
      ["2", "Paper 3"],
    ]);
  });

  it("lists every section a document cites a paper in", function () {
    seedScope(3);
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "run-a" });
    applyTaskDocumentCitations(KEY, "run-a", [
      {
        citationId: "d1",
        libraryID: 1,
        itemKey: "PAPER002",
        itemId: 2,
        sectionLabel: "Introduction",
        sectionLabels: ["Introduction", "Discussion"],
      },
    ]);
    harness.row.dispatchFakeEvent("click");
    const paper = harness.items()[1];
    paper.findByClass("llm-task-paper-summary")!.dispatchFakeEvent("click");
    const details = paper.findByClass("llm-task-paper-details")!;
    assert.deepEqual(
      details
        .findAllByClass("llm-task-paper-citation")
        .map((link) => link.textContent),
      ["↳ Introduction", "↳ Discussion"],
    );
  });

  it("folds papers paper_read found no text for into the count, not the list", function () {
    seedScope(13);
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "run-a" });
    applyTaskPaperUpdate(
      KEY,
      {
        version: 1,
        callId: "overview",
        runId: "run-a",
        toolName: "paper_read",
        papers: Array.from({ length: 12 }, (_, index) => ({
          key: `1:${index + 1}`,
          libraryID: 1,
          itemId: index + 1,
          text: "none" as const,
          state: "matched" as const,
        })),
        reads: Array.from({ length: 12 }, (_, index) => ({
          key: `1:${index + 1}`,
          callId: "overview",
          toolName: "paper_read",
          granularity: "metadata" as const,
          method: "overview",
        })),
      },
      "run-a",
    );
    applyTaskPaperUpdate(
      KEY,
      {
        version: 1,
        callId: "search",
        runId: "run-a",
        toolName: "library_search",
        papers: [{ key: "1:13", libraryID: 1, itemId: 13, state: "matched" }],
        reads: [
          {
            key: "1:13",
            callId: "search",
            toolName: "library_search",
            granularity: "metadata",
            method: "search",
          },
        ],
      },
      "run-a",
    );
    harness.runTimers();
    const before = harness.count();
    harness.row.dispatchFakeEvent("click");
    const titles = harness
      .items()
      .map((item) => item.findByClass("llm-task-paper-title")!.textContent);
    assert.deepEqual(titles, ["Paper 13"]);
    assert.equal(harness.count(), before, "the header still counts them");
    assert.include(before, "of 13");
  });

  it("lists a document's citations of a paper by section, and opens the paper from them", function () {
    seedScope(3);
    class FakeCustomEvent {
      constructor(
        public type: string,
        public init: { bubbles?: boolean; detail?: unknown },
      ) {}
    }
    const doc = {
      ...(fakeDocument as unknown as Record<string, unknown>),
      defaultView: { CustomEvent: FakeCustomEvent },
    } as unknown as Document;
    const harness = track(mount({}, { doc }));
    beginTaskRun(KEY, { runId: "run-a" });
    applyTaskPaperUpdate(
      KEY,
      ledgerDelta("c1", [[2, "read", "Drift grows with time."]]),
      "run-a",
    );
    applyTaskDocumentCitations(KEY, "run-a", [
      {
        citationId: "d1",
        libraryID: 1,
        itemKey: "PAPER002",
        itemId: 2,
        sectionLabel: "Discussion",
      },
      { citationId: "d2", libraryID: 1, itemKey: "PAPER002", itemId: 2 },
    ]);
    harness.row.dispatchFakeEvent("click");
    const paper = harness.items()[1];
    assert.equal(paper.dataset.state, "cited");
    assert.equal(
      paper.findByClass("llm-task-paper-tail")!.textContent,
      "Results · cited 2",
    );
    paper.findByClass("llm-task-paper-summary")!.dispatchFakeEvent("click");
    const details = paper.findByClass("llm-task-paper-details")!;
    const text = collectFakeText(details);
    assert.include(text, "Cited in document");
    assert.notInclude(text, "Cited in answer");
    const links = details.findAllByClass("llm-task-paper-citation");
    assert.deepEqual(
      links.map((link) => link.textContent),
      ["↳ Discussion", "↳ Cited in document"],
    );
    const dispatched: FakeCustomEvent[] = [];
    (links[0] as any).dispatchEvent = (event: FakeCustomEvent) => {
      dispatched.push(event);
      return true;
    };
    links[0].dispatchFakeEvent("click");
    assert.lengthOf(dispatched, 1);
    assert.equal(dispatched[0].type, TASK_PROGRESS_OPEN_PASSAGE_EVENT);
    assert.deepInclude(dispatched[0].init.detail as object, {
      itemId: 2,
      libraryID: 1,
      granularity: "full",
      rawSnippet: "",
      label: "Discussion",
    });
    assert.deepEqual(harness.navigated, [], "no quote chip jump");
  });

  it("closes on Escape and returns focus to the row", function () {
    seedScope(5);
    const harness = track(mount());
    let focused = 0;
    (harness.row as any).focus = () => focused++;
    harness.row.dispatchFakeEvent("click");
    const other = harness.panel.dispatchFakeEvent("keydown", { key: "Enter" });
    assert.isTrue(harness.view.isOpen());
    assert.isFalse(other.defaultPrevented);
    const escape = harness.panel.dispatchFakeEvent("keydown", {
      key: "Escape",
    });
    assert.isFalse(harness.view.isOpen());
    assert.isTrue(escape.defaultPrevented);
    assert.equal(focused, 1);
    const ignored = harness.panel.dispatchFakeEvent("keydown", {
      key: "Escape",
    });
    assert.isFalse(ignored.defaultPrevented, "a closed drawer leaves Escape");
  });

  it("collapses the moment the answer starts streaming", function () {
    seedScope(5);
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "run-a" });
    harness.row.dispatchFakeEvent("click");
    assert.isTrue(harness.view.isOpen());
    markTaskAnswering(KEY, "run-a");
    assert.isFalse(harness.view.isOpen(), "no coalescing delay");
    assert.isFalse(harness.shell.classList.contains("llm-task-progress-shown"));
    harness.row.dispatchFakeEvent("click");
    assert.isTrue(harness.view.isOpen(), "it reopens on request");
    harness.view.flush();
    assert.isTrue(harness.view.isOpen(), "a later paint does not collapse it");
  });

  it("coalesces store updates to at most four repaints a second", function () {
    seedScope(20);
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "run-a" });
    harness.runTimers();
    for (let n = 1; n <= 10; n++) {
      applyTaskPaperUpdate(KEY, ledgerDelta(`c${n}`, [[n, "read"]]), "run-a");
    }
    assert.equal(harness.timers.size, 1, "one pending repaint");
    const [timer] = Array.from(harness.timers.values());
    assert.isAtLeast(timer.ms, 0);
    assert.isAtMost(timer.ms, 250);
    assert.equal(harness.count(), "0 of 20 read", "not painted yet");
    harness.runTimers();
    assert.equal(harness.count(), "10 of 20 read");
  });

  it("offers Source on passages with text or a named page, and asks the panel to open it", function () {
    seedScope(3);
    class FakeCustomEvent {
      constructor(
        public type: string,
        public init: { bubbles?: boolean; detail?: unknown },
      ) {}
    }
    const doc = {
      ...(fakeDocument as unknown as Record<string, unknown>),
      defaultView: { CustomEvent: FakeCustomEvent },
    } as unknown as Document;
    const harness = track(mount({}, { doc }));
    applyTaskPaperUpdate(
      KEY,
      {
        version: 1,
        callId: "c1",
        toolName: "library_retrieve",
        papers: [
          {
            key: "1:2",
            libraryID: 1,
            itemId: 2,
            contextItemId: 22,
            title: "Paper 2",
            state: "read",
          },
        ],
        reads: [
          {
            key: "1:2",
            callId: "c1",
            toolName: "library_retrieve",
            granularity: "section",
            label: "Results",
            snippet: "## Results\nDrift grows with time…",
          },
          {
            key: "1:2",
            callId: "c1",
            toolName: "paper_read",
            granularity: "page",
            label: "p. 3",
          },
          {
            key: "1:2",
            callId: "c1",
            toolName: "paper_read",
            granularity: "page",
            label: "Figures",
          },
          {
            key: "1:2",
            callId: "c1",
            toolName: "library_retrieve",
            granularity: "outline",
            label: "Methods",
          },
        ],
      },
      "run-a",
    );
    harness.row.dispatchFakeEvent("click");
    const paper = harness.items()[1];
    const summary = paper.findByClass("llm-task-paper-summary")!;
    summary.dispatchFakeEvent("click");
    const details = paper.findByClass("llm-task-paper-details")!;
    const reads = details.findAllByClass("llm-task-paper-read");
    assert.lengthOf(reads, 4);
    const sources = reads.map((node) =>
      node.findByClass("llm-task-paper-open"),
    );
    assert.deepEqual(
      sources.map(Boolean),
      [true, true, false, false],
      "a snippet or a named page: never a page read without one, nor an outline",
    );
    const source = sources[0]!;
    assert.equal(source.tagName.toLowerCase(), "button");
    assert.equal(source.type, "button");
    assert.equal(source.textContent, "Source");
    assert.equal(
      source.attributes["aria-label"],
      "Open this passage in the paper",
    );
    assert.equal(
      reads[0].findByClass("llm-task-paper-how")!.textContent,
      "Results",
      "the label row keeps its label text",
    );
    const dispatched: FakeCustomEvent[] = [];
    (source as any).dispatchEvent = (event: FakeCustomEvent) => {
      dispatched.push(event);
      return true;
    };
    const click = source.dispatchFakeEvent("click");
    assert.isTrue(click.propagationStopped, "the click stays on the button");
    assert.lengthOf(dispatched, 1);
    assert.equal(dispatched[0].type, TASK_PROGRESS_OPEN_PASSAGE_EVENT);
    assert.isTrue(dispatched[0].init.bubbles);
    assert.deepEqual(dispatched[0].init.detail, {
      itemId: 2,
      contextItemId: 22,
      libraryID: 1,
      rawSnippet: "## Results\nDrift grows with time…",
      cleanedSnippet: "Results Drift grows with time…",
      label: "Results",
      granularity: "section",
    });
    assert.isFalse((details as any).hidden, "the paper stays expanded");
    assert.equal(summary.getAttribute("aria-expanded"), "true");
    assert.isTrue(harness.view.isOpen(), "the drawer stays open");

    const page = sources[1]!;
    (page as any).dispatchEvent = (event: FakeCustomEvent) => {
      dispatched.push(event);
      return true;
    };
    page.dispatchFakeEvent("click");
    assert.deepInclude(dispatched[1].init.detail as object, {
      rawSnippet: "",
      cleanedSnippet: "",
      label: "p. 3",
      granularity: "page",
    });
  });

  it("jumps from a citation to its quote chip, collapsing the drawer", function () {
    seedScope(5);
    const harness = track(mount());
    const card = new FakeElement("div");
    card.className = "llm-quote-card llm-quote-citation-anchor";
    card.dataset.quoteCitationId = "q1";
    const decoy = new FakeElement("div");
    decoy.className = "llm-quote-card llm-quote-citation-anchor";
    decoy.dataset.quoteCitationId = "q2";
    harness.chatBox.append(decoy, card);
    beginTaskRun(KEY, { runId: "run-a" });
    applyTaskPaperUpdate(KEY, ledgerDelta("c1", [[1, "read", "One"]]), "run-a");
    completeTaskRun(KEY, {
      runId: "run-a",
      quoteCitations: [quoteCitation("q1", 1)],
    });
    harness.row.dispatchFakeEvent("click");
    const item = harness.items()[0];
    assert.equal(item.dataset.state, "cited");
    assert.equal(
      item.findByClass("llm-task-paper-tail")!.textContent,
      "Results · cited 1",
    );
    item.findByClass("llm-task-paper-summary")!.dispatchFakeEvent("click");
    const link = item.findByClass("llm-task-paper-citation")!;
    assert.include(link.textContent, "Quoted evidence q1");
    link.dispatchFakeEvent("click");
    assert.isFalse(harness.view.isOpen());
    assert.deepEqual(harness.navigated, [card]);
    assert.isTrue(card.classList.contains("llm-task-progress-flash"));
    const flash = Array.from(harness.timers.values()).find(
      (timer) => timer.ms === TASK_PROGRESS_FLASH_MS,
    );
    assert.exists(flash);
    flash!.callback();
    assert.isFalse(card.classList.contains("llm-task-progress-flash"));
  });

  it("jumps to the quote chip whose id contains '.' and ':', not to a look-alike", function () {
    seedScope(5);
    const harness = track(mount());
    const card = new FakeElement("div");
    card.className = "llm-quote-card llm-quote-citation-anchor";
    card.dataset.quoteCitationId = "Q1.a:p2";
    const decoy = new FakeElement("div");
    decoy.className = "llm-quote-card llm-quote-citation-anchor";
    decoy.dataset.quoteCitationId = "Q1ap2";
    harness.chatBox.append(card, decoy);
    beginTaskRun(KEY, { runId: "run-a" });
    applyTaskPaperUpdate(KEY, ledgerDelta("c1", [[1, "read", "One"]]), "run-a");
    completeTaskRun(KEY, {
      runId: "run-a",
      quoteCitations: [quoteCitation("Q1.a:p2", 1)],
    });
    harness.row.dispatchFakeEvent("click");
    const item = harness.items()[0];
    item.findByClass("llm-task-paper-summary")!.dispatchFakeEvent("click");
    const link = item.findByClass("llm-task-paper-citation")!;
    assert.equal(link.dataset.citationId, "Q1.a:p2");
    link.dispatchFakeEvent("click");
    assert.deepEqual(harness.navigated, [card]);
  });

  it("asks for MinerU text only for the rows on screen", async function () {
    seedScope(200);
    const harness = track(mount({}, { mineru: (itemId) => itemId === 2 }));
    assert.lengthOf(harness.mineruAsked, 0, "nothing asked while closed");
    harness.row.dispatchFakeEvent("click");
    assert.lengthOf(harness.mineruAsked, TASK_PROGRESS_WINDOW);
    await Promise.resolve();
    await Promise.resolve();
    const sources = harness
      .items()
      .slice(0, 3)
      .map((item) => item.findByClass("llm-task-paper-source")!.textContent);
    assert.deepEqual(sources, ["PDF", "MinerU", "PDF"]);
  });

  it("starts fresh when the panel switches conversation", function () {
    seedScope(5);
    const harness = track(mount());
    harness.row.dispatchFakeEvent("click");
    assert.equal(harness.view.renderedRowCount(), 5);
    harness.view.setInput({
      conversationKey: KEY + 1,
      recordsReads: true,
      visibility: {
        conversationKind: "paper",
        isWebChat: false,
        isNoteSession: false,
        collectionCount: 0,
        tagCount: 0,
        paperCount: 1,
      },
    });
    assert.isFalse(harness.view.isOpen());
    assert.equal(harness.view.renderedRowCount(), 0);
    assert.isTrue((harness.row as any).hidden);
    assert.isNull(getTaskProgress(KEY + 1));
  });

  it("formats an empty scope without inventing counts", function () {
    assert.equal(formatTaskProgressCount(null, true), "");
  });

  it("shows each question's own papers once there are two, and counts the latest question", function () {
    seedScope(5);
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "q1", turnIndex: 1 });
    applyTaskPaperUpdate(
      KEY,
      ledgerDelta("c1", [
        [1, "read", "Earlier passage."],
        [2, "skimmed"],
      ]),
      "q1",
    );
    completeTaskRun(KEY, {
      runId: "q1",
      quoteCitations: [quoteCitation("a", 2)],
    });
    beginTaskRun(KEY, { runId: "q2", turnIndex: 2 });
    applyTaskPaperUpdate(KEY, ledgerDelta("c2", [[3, "read", "Now."]]), "q2");
    harness.view.flush();
    assert.equal(
      harness.count(),
      "1 of 5 read",
      "the row counts the latest question",
    );
    harness.row.dispatchFakeEvent("click");
    const [first, second, third, fourth] = harness.items();
    assert.equal(first.dataset.state, "listed", "question 2 did not read it");
    assert.equal(second.dataset.state, "listed");
    assert.equal(third.dataset.state, "read");
    assert.equal(fourth.dataset.state, "listed");
    const head = harness.drawer.findByClass("llm-task-progress-head")!;
    assert.isTrue(head.hidden, "no summary line above the paper list");
    assert.equal(collectFakeText(head), "");
    // Question 1's papers are under its own header.
    const earlier = harness.drawer.findByClass(
      "llm-task-progress-question-section",
    )!;
    earlier
      .findByClass("llm-task-progress-question")!
      .dispatchFakeEvent("click");
    const [read, cited] = earlier.findAllByClass("llm-task-paper");
    assert.equal(read.dataset.state, "read", "read in question 1 stays read");
    assert.equal(cited.dataset.state, "cited");
    assert.equal(
      read.findByClass("llm-task-paper-tail")!.textContent,
      "Results",
    );
    read.findByClass("llm-task-paper-summary")!.dispatchFakeEvent("click");
    const details = collectFakeText(
      read.findByClass("llm-task-paper-details")!,
    );
    assert.include(details, "Earlier passage.");
    assert.notInclude(details, "not read for this question");
  });

  it("shows a built-in action as the row's steps, even in a one-paper chat", function () {
    seedScope(1);
    const harness = track(
      mount({
        visibility: {
          conversationKind: "paper",
          isWebChat: false,
          isNoteSession: false,
          collectionCount: 0,
          tagCount: 0,
          paperCount: 1,
        },
      }),
    );
    assert.isTrue((harness.row as any).hidden, "hidden before any action");
    beginTaskAction(KEY, { runId: "action-1", title: "Auto Tag" });
    setTaskActionStep(KEY, "action-1", {
      step: "Reading papers",
      index: 1,
      total: 3,
    });
    harness.view.flush();
    assert.isFalse((harness.row as any).hidden);
    assert.equal(harness.row.dataset.state, "working");
    assert.equal(harness.count(), "0/3 steps · Reading papers");
    setTaskActionSummary(KEY, "action-1", "Read 4 papers");
    harness.view.flush();
    assert.equal(harness.count(), "0/3 steps · Read 4 papers");
    harness.row.dispatchFakeEvent("click");
    const steps = harness.drawer.findByClass("llm-task-progress-steps")!;
    assert.isFalse((steps as any).hidden);
    const text = collectFakeText(steps);
    assert.include(text, "Auto Tag");
    assert.include(text, "Reading papers");
    assert.include(text, "Read 4 papers");
    endTaskAction(KEY, "action-1", "completed", "Tagged 3 items");
    harness.view.flush();
    assert.equal(harness.row.dataset.state, "completed");
    assert.equal(harness.count(), "3/3 steps · Tagged 3 items");
    assert.include(collectFakeText(steps), "Tagged 3 items");
    assert.isFalse((harness.row as any).hidden, "the row stays afterwards");
  });

  it("says why an action failed", function () {
    seedScope(1);
    const harness = track(mount());
    beginTaskAction(KEY, { runId: "action-2", title: "Auto Tag" });
    setTaskActionStep(KEY, "action-2", {
      step: "Proposing",
      index: 2,
      total: 3,
    });
    endTaskAction(KEY, "action-2", "failed", "Auto Tag failed: offline");
    harness.view.flush();
    assert.equal(harness.row.dataset.state, "failed");
    assert.equal(harness.count(), "1/3 steps · Auto Tag failed: offline");
    harness.row.dispatchFakeEvent("click");
    const failure = harness.drawer.findByClass("llm-plan-task-failure");
    assert.equal(failure?.textContent, "Auto Tag failed: offline");
  });

  it("shows Codex's plan as the steps, with the read counts", function () {
    seedScope(6);
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "codex-1", turnIndex: 1 });
    setTaskChecklist(KEY, {
      source: "codex",
      runId: "codex-1",
      steps: [
        { label: "Inspect the scope", status: "completed" },
        { label: "Read the methods", status: "in_progress" },
        { label: "Compare results", status: "pending" },
      ],
    });
    applyTaskPaperUpdate(KEY, ledgerDelta("m1", [[1, "read"]]), "codex-1");
    harness.view.flush();
    assert.equal(harness.count(), "1/3 steps · 1 of 6 read");
    harness.row.dispatchFakeEvent("click");
    const steps = harness.drawer.findByClass("llm-task-progress-steps")!;
    assert.isFalse((steps as any).hidden);
    const lines = steps.findAllByClass("llm-plan-task");
    assert.deepEqual(
      lines.map((line) => line.className),
      [
        "llm-plan-task llm-plan-task-completed",
        "llm-plan-task llm-plan-task-in_progress",
        "llm-plan-task llm-plan-task-pending",
      ],
    );
    assert.include(collectFakeText(steps), "Compare results");
  });

  it("unrolls and rolls up between measured heights, settling on transitionend", function () {
    seedScope(5);
    const motion = fakeLayout({ ms: 200 });
    const harness = track(mount({}, { layout: motion.layout }));
    fakeHeights(harness, 300, 700);
    harness.row.dispatchFakeEvent("click");
    assert.isTrue(harness.view.isOpen());
    assert.equal(harness.row.getAttribute("aria-expanded"), "true");
    assert.equal(harness.drawer.dataset.state, "opening");
    assert.equal(harness.view.drawerState(), "opening");
    assert.isFalse((harness.drawer as any).hidden);
    assert.isTrue(harness.shell.classList.contains("llm-task-progress-shown"));
    assert.equal(harness.drawer.style.height, "300px", "toward its content");
    assert.isTrue(
      Array.from(harness.timers.values()).some((timer) => timer.ms === 280),
      "a fallback settles a missed transitionend",
    );
    transitionEnd(harness.drawer, "box-shadow");
    const child = harness.drawer.findByClass("llm-task-progress-list")!;
    harness.drawer.dispatchFakeEvent("transitionend", {
      target: child,
      propertyName: "height",
    } as never);
    assert.equal(harness.drawer.dataset.state, "opening", "only its height");
    transitionEnd(harness.drawer);
    assert.equal(harness.drawer.dataset.state, "open");
    assert.equal(harness.drawer.style.height, "", "released to its content");

    harness.row.dispatchFakeEvent("click");
    assert.isFalse(harness.view.isOpen());
    assert.equal(harness.row.getAttribute("aria-expanded"), "false");
    assert.equal(harness.drawer.dataset.state, "closing");
    assert.isFalse((harness.drawer as any).hidden, "still rolling up");
    assert.equal(harness.drawer.style.height, "0px");
    assert.isTrue(harness.shell.classList.contains("llm-task-progress-shown"));
    transitionEnd(harness.drawer);
    assert.equal(harness.drawer.dataset.state, "closed");
    assert.isTrue((harness.drawer as any).hidden);
    assert.equal(harness.drawer.style.height, "");
    assert.isFalse(harness.shell.classList.contains("llm-task-progress-shown"));
  });

  it("reverses mid-way and settles from the fallback when no transitionend comes", function () {
    seedScope(5);
    const harness = track(mount({}, { layout: fakeLayout().layout }));
    fakeHeights(harness, 300, 700);
    harness.row.dispatchFakeEvent("click");
    harness.row.dispatchFakeEvent("click");
    assert.equal(harness.drawer.dataset.state, "closing");
    assert.equal(harness.drawer.style.height, "0px");
    harness.row.dispatchFakeEvent("click");
    assert.equal(harness.drawer.dataset.state, "opening");
    assert.equal(harness.drawer.style.height, "300px");
    harness.runTimers();
    assert.equal(harness.drawer.dataset.state, "open");
    assert.equal(harness.drawer.style.height, "");
  });

  it("rolls up with the same motion on Escape and at the first answer text", function () {
    seedScope(5);
    const harness = track(mount({}, { layout: fakeLayout().layout }));
    fakeHeights(harness, 300, 700);
    let focused = 0;
    (harness.row as any).focus = () => focused++;
    const settleOpen = () => {
      harness.row.dispatchFakeEvent("click");
      transitionEnd(harness.drawer);
      assert.equal(harness.drawer.dataset.state, "open");
    };
    settleOpen();
    harness.panel.dispatchFakeEvent("keydown", { key: "Escape" });
    assert.equal(harness.drawer.dataset.state, "closing");
    assert.equal(focused, 1, "Escape returns focus to the row");
    transitionEnd(harness.drawer);
    beginTaskRun(KEY, { runId: "run-a" });
    settleOpen();
    markTaskAnswering(KEY, "run-a");
    assert.equal(harness.drawer.dataset.state, "closing");
    transitionEnd(harness.drawer);
    assert.equal(harness.drawer.dataset.state, "closed");
  });

  it("settles at once when motion is reduced", function () {
    seedScope(5);
    const harness = track(mount({}, { layout: fakeLayout({ ms: 0 }).layout }));
    fakeHeights(harness, 300, 700);
    harness.row.dispatchFakeEvent("click");
    assert.equal(harness.drawer.dataset.state, "open");
    assert.equal(harness.drawer.style.height, "");
    harness.panel.dispatchFakeEvent("keydown", { key: "Escape" });
    assert.equal(harness.drawer.dataset.state, "closed");
    assert.isTrue((harness.drawer as any).hidden);
  });

  it("closes without motion when the panel switches conversation", function () {
    seedScope(5);
    const harness = track(mount({}, { layout: fakeLayout().layout }));
    fakeHeights(harness, 300, 700);
    harness.row.dispatchFakeEvent("click");
    harness.view.setInput({
      conversationKey: KEY + 1,
      recordsReads: true,
      visibility: {
        conversationKind: "global",
        isWebChat: false,
        isNoteSession: false,
        collectionCount: 1,
        tagCount: 0,
        paperCount: 0,
      },
    });
    assert.equal(harness.drawer.dataset.state, "closed");
    assert.isTrue((harness.drawer as any).hidden);
    assert.isFalse(harness.shell.classList.contains("llm-task-progress-shown"));
  });

  it("drops the header divider only while the row shows", function () {
    seedScope(5);
    const shown = track(mount());
    assert.equal(shown.panel.getAttribute("data-task-progress-row"), "shown");
    shown.view.setInput({
      conversationKey: KEY,
      recordsReads: true,
      visibility: {
        conversationKind: "paper",
        isWebChat: false,
        isNoteSession: false,
        collectionCount: 0,
        tagCount: 0,
        paperCount: 1,
      },
    });
    assert.isTrue((shown.row as any).hidden);
    assert.isNull(shown.panel.getAttribute("data-task-progress-row"));
  });

  it("keeps the chat's place while the drawer changes size", function () {
    seedScope(5);
    const motion = fakeLayout();
    const harness = track(mount({}, { layout: motion.layout }));
    fakeHeights(harness, 300, 700);
    motion.fireResize();
    assert.equal(motion.chatResized(), 0, "nothing while closed");
    harness.row.dispatchFakeEvent("click");
    motion.fireResize();
    assert.equal(motion.chatResized(), 1);
    assert.equal(harness.shell.style["--llm-task-progress-inset"], "300px");
    transitionEnd(harness.drawer);
    harness.row.dispatchFakeEvent("click");
    transitionEnd(harness.drawer);
    assert.equal(harness.shell.style["--llm-task-progress-inset"], "");
  });

  it("drags the handle within its bounds and remembers the height for the session", function () {
    seedScope(40);
    const { doc, target } = draggableDocument();
    const harness = track(
      mount({}, { layout: fakeLayout({ ms: 0 }).layout, doc }),
    );
    const drawerHeight = fakeHeights(harness, 500, 700);
    const down = (clientY: number) =>
      harness.grip.dispatchFakeEvent("mousedown", {
        button: 0,
        clientY,
      } as never);
    const move = (clientY: number) =>
      target.dispatchFakeEvent("mousemove", { clientY } as never);
    down(500);
    assert.isFalse(
      harness.panel.classList.contains("llm-task-progress-resizing"),
      "a closed drawer has no handle to hold",
    );
    harness.row.dispatchFakeEvent("click");
    down(500);
    assert.isTrue(
      harness.panel.classList.contains("llm-task-progress-resizing"),
    );
    move(300);
    assert.equal(harness.drawer.style[MAX_VAR], "300px");
    move(-1000);
    assert.equal(
      harness.drawer.style[MAX_VAR],
      `${TASK_PROGRESS_DRAWER_MIN_PX}px`,
      "no shorter than the minimum",
    );
    move(5000);
    // 500 now, plus the chat's 200 less its 96px strip.
    assert.equal(
      harness.drawer.style[MAX_VAR],
      "604px",
      "the chat keeps a strip",
    );
    move(350);
    assert.isNull(getRememberedTaskProgressDrawerHeight(), "not until release");
    target.dispatchFakeEvent("mouseup", { clientY: 350 } as never);
    assert.isFalse(
      harness.panel.classList.contains("llm-task-progress-resizing"),
    );
    assert.equal(getRememberedTaskProgressDrawerHeight(), 350);
    move(100);
    assert.equal(harness.drawer.style[MAX_VAR], "350px", "released");
    assert.equal(drawerHeight(), 350);

    harness.panel.dispatchFakeEvent("keydown", { key: "Escape" });
    harness.row.dispatchFakeEvent("click");
    assert.equal(harness.drawer.style[MAX_VAR], "350px", "reopens at it");
    const other = track(mount({}, { layout: fakeLayout({ ms: 0 }).layout }));
    // Another view of the conversation comes back open, as it was left.
    assert.isTrue(other.view.isOpen());
    assert.equal(
      other.drawer.style[MAX_VAR],
      "350px",
      "every panel, this session",
    );

    const key = (name: string, shiftKey = false) =>
      harness.grip.dispatchFakeEvent("keydown", {
        key: name,
        shiftKey,
      } as never);
    key("ArrowUp");
    assert.equal(getRememberedTaskProgressDrawerHeight(), 334);
    key("ArrowDown", true);
    assert.equal(getRememberedTaskProgressDrawerHeight(), 398);
    key("Home");
    assert.equal(
      getRememberedTaskProgressDrawerHeight(),
      TASK_PROGRESS_DRAWER_MIN_PX,
    );
    harness.grip.dispatchFakeEvent("dblclick");
    assert.isNull(getRememberedTaskProgressDrawerHeight());
    assert.equal(harness.drawer.style[MAX_VAR], "", "back to its content");
  });

  describe("per-conversation card state", function () {
    const OTHER = KEY + 1;
    function seedOther() {
      setTaskScope(OTHER, {
        signature: "other",
        libraryID: 1,
        contexts: { collections: [{ collectionId: 6 }] },
        label: "Other",
        listing: {
          libraryID: 1,
          wholeLibrary: false,
          entries: scopeEntries(5),
          totalItems: 5,
          listedItems: 5,
          truncated: false,
        },
      });
    }
    const globalInput = (conversationKey: number): TaskProgressViewInput => ({
      conversationKey,
      recordsReads: true,
      visibility: {
        conversationKind: "global",
        isWebChat: false,
        isNoteSession: false,
        collectionCount: 1,
        tagCount: 0,
        paperCount: 0,
      },
    });
    const expandedKeys = (harness: Harness) =>
      harness
        .items()
        .filter(
          (item) =>
            item
              .findByClass("llm-task-paper-summary")!
              .getAttribute("aria-expanded") === "true",
        )
        .map((item) => item.dataset.key);
    function openAndExpand(harness: Harness, index: number) {
      harness.row.dispatchFakeEvent("click");
      const item = harness.items()[index];
      item.findByClass("llm-task-paper-summary")!.dispatchFakeEvent("click");
    }

    it("comes back open, expanded, windowed and scrolled on a new mount, without motion", function () {
      seedScope(200);
      const first = track(mount());
      openAndExpand(first, 1);
      Object.assign(first.body, {
        scrollHeight: 4000,
        clientHeight: 600,
        scrollTop: 3300,
      });
      first.body.dispatchFakeEvent("scroll");
      assert.equal(first.view.renderedRowCount(), 2 * TASK_PROGRESS_WINDOW);
      first.view.dispose();

      // The panel is rebuilt (a tab switch): the new view takes it up again.
      const again = track(
        mount({}, { layout: fakeLayout({ ms: 200 }).layout }),
      );
      assert.isTrue(again.view.isOpen(), "the drawer is open");
      assert.equal(again.drawer.dataset.state, "open", "with no motion");
      assert.isFalse((again.drawer as any).hidden);
      assert.equal(again.row.getAttribute("aria-expanded"), "true");
      assert.deepEqual(expandedKeys(again), ["1:2"], "the paper is expanded");
      const details = again
        .items()[1]
        .findByClass("llm-task-paper-details")! as any;
      assert.isFalse(details.hidden, "with its details");
      assert.equal(again.view.renderedRowCount(), 2 * TASK_PROGRESS_WINDOW);
      assert.equal(again.body.scrollTop, 3300, "at the same place");
    });

    it("keeps the user's own close on the next mount", function () {
      seedScope(5);
      const first = track(mount());
      openAndExpand(first, 0);
      first.row.dispatchFakeEvent("click");
      assert.isFalse(first.view.isOpen());
      first.view.dispose();
      const closed = track(mount());
      assert.isFalse(closed.view.isOpen(), "the user closed it");
      closed.row.dispatchFakeEvent("click");
      assert.deepEqual(
        expandedKeys(closed),
        ["1:1"],
        "the paper stays expanded",
      );
    });

    it("stays closed after the answer starts, mounted or not", function () {
      seedScope(5);
      beginTaskRun(KEY, { runId: "run-a" });
      const first = track(mount());
      first.row.dispatchFakeEvent("click");
      markTaskAnswering(KEY, "run-a");
      assert.isFalse(first.view.isOpen(), "the answer collapses it");
      first.view.dispose();
      assert.isFalse(track(mount()).view.isOpen(), "and it stays collapsed");

      beginTaskRun(KEY, { runId: "run-b" });
      const reopened = track(mount());
      reopened.row.dispatchFakeEvent("click");
      assert.isTrue(reopened.view.isOpen());
      reopened.view.dispose();
      // No view shows the conversation when its next answer starts.
      markTaskAnswering(KEY, "run-b");
      assert.isFalse(track(mount()).view.isOpen(), "collapsed while away");
    });

    it("forgets the state when the conversation's record is cleared", function () {
      seedScope(5);
      const first = track(mount());
      openAndExpand(first, 0);
      first.view.dispose();
      clearTaskProgress(KEY);
      seedScope(5);
      const fresh = track(mount());
      assert.isFalse(fresh.view.isOpen());
      fresh.row.dispatchFakeEvent("click");
      assert.deepEqual(expandedKeys(fresh), [], "nothing expanded");
    });

    it("drops the expanded papers of a record cleared under a mounted view", function () {
      seedScope(5);
      const harness = track(mount());
      openAndExpand(harness, 0);
      clearTaskProgress(KEY);
      seedScope(5);
      harness.view.flush();
      if (!harness.view.isOpen()) harness.row.dispatchFakeEvent("click");
      assert.deepEqual(
        expandedKeys(harness),
        [],
        "the rebuilt list starts folded",
      );
      // Its next write must not bring the old expansion back either.
      harness.row.dispatchFakeEvent("click");
      harness.view.dispose();
      const again = track(mount());
      again.row.dispatchFakeEvent("click");
      assert.deepEqual(expandedKeys(again), []);
    });

    it("keeps each conversation's own state when the panel switches", function () {
      seedScope(200);
      seedOther();
      const harness = track(mount());
      openAndExpand(harness, 2);
      harness.view.setInput(globalInput(OTHER));
      assert.isFalse(
        harness.view.isOpen(),
        "another conversation starts closed",
      );
      harness.row.dispatchFakeEvent("click");
      assert.deepEqual(expandedKeys(harness), [], "with nothing expanded");
      harness
        .items()[4]
        .findByClass("llm-task-paper-summary")!
        .dispatchFakeEvent("click");
      harness.row.dispatchFakeEvent("click");
      assert.isFalse(harness.view.isOpen());

      harness.view.setInput(globalInput(KEY));
      assert.isTrue(
        harness.view.isOpen(),
        "the first conversation is open again",
      );
      assert.equal(harness.drawer.dataset.state, "open");
      assert.deepEqual(expandedKeys(harness), ["1:3"]);
      harness.view.setInput(globalInput(OTHER));
      assert.isFalse(harness.view.isOpen(), "the other one was closed");
      harness.row.dispatchFakeEvent("click");
      assert.deepEqual(expandedKeys(harness), ["1:5"]);
    });
  });
});

describe("task progress view of an outcome ledger", function () {
  const views: TaskProgressView[] = [];
  afterEach(function () {
    for (const view of views.splice(0)) view.dispose();
    clearAllTaskProgress();
    resetTaskProgressDrawerHeight();
  });
  function track(harness: Harness): Harness {
    views.push(harness.view);
    return harness;
  }
  const pill = (harness: Harness) =>
    harness.row.findByClass("llm-task-progress-pill") as any;
  function openSteps(harness: Harness): FakeElement {
    harness.row.dispatchFakeEvent("click");
    const steps = harness.drawer.findByClass("llm-task-progress-steps")!;
    assert.isFalse((steps as any).hidden, "the Steps block shows");
    return steps;
  }
  const headerStatus = (steps: FakeElement) =>
    steps.findByClass("llm-plan-status")!.textContent;
  const rows = (steps: FakeElement) => steps.findAllByClass("llm-plan-task");
  const labelOf = (row: FakeElement) =>
    row.findByClass("llm-plan-task-label")!.textContent;
  const detailOf = (row: FakeElement) =>
    row.findByClass("llm-plan-task-original")?.textContent || "";

  const read = outcomeTask("read", {
    description: "Read the paper",
    effect: "read",
    status: "completed",
  });
  const save = outcomeTask("save", {
    description: "Save the summary as a note",
  });

  it("while the run is live: no pill, the steps count first, and one row per outcome", function () {
    seedScope();
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "run-a" });
    setTaskOutcomes(KEY, "run-a", outcomeCheckpoint([read, save]));
    harness.view.flush();
    assert.isTrue(pill(harness).hidden);
    assert.equal(harness.row.dataset.state, "working");
    assert.equal(harness.count(), "1/2 steps · 0 of 200 read");
    const steps = openSteps(harness);
    assert.equal(headerStatus(steps), "In progress");
    assert.include(collectFakeText(steps), "Steps");
    const [readRow, saveRow] = rows(steps);
    assert.deepEqual(
      [readRow.className, saveRow.className],
      [
        "llm-plan-task llm-plan-task-completed",
        "llm-plan-task llm-plan-task-pending",
      ],
    );
    assert.equal(readRow.findByClass("llm-plan-task-badge")!.textContent, "✓");
    assert.equal(
      saveRow.findByClass("llm-plan-task-badge")!.textContent,
      "2",
      "a pending part shows its number",
    );
    assert.equal(
      readRow.findByClass("llm-plan-task-pill")!.textContent,
      "Done",
    );
    assert.isTrue((saveRow.findByClass("llm-plan-task-pill") as any).hidden);
    assert.equal(labelOf(saveRow), "Save the summary as a note");
  });

  it("while a decision card is open: Needs your decision", function () {
    seedScope();
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "run-a" });
    setTaskOutcomes(KEY, "run-a", outcomeCheckpoint([save]));
    markTaskWaiting(KEY, "run-a", true);
    harness.view.flush();
    assert.equal(harness.row.dataset.state, "waiting");
    assert.equal(pill(harness).textContent, "Needs input");
    assert.equal(pill(harness).dataset.tone, "waiting");
    assert.equal(harness.count(), "0/1 steps · 0 of 200 read");
    markTaskWaiting(KEY, "run-a", false);
    harness.view.flush();
    assert.isTrue(pill(harness).hidden);
    assert.equal(harness.row.dataset.state, "working");
  });

  it("completed with exceptions: the pill, the steps count, and a not-done row naming reasons and papers", function () {
    seedScope(6);
    const harness = track(
      mount(
        {},
        {
          resolvePaperLabel: (itemId) => (itemId === 4 ? "(Lee, 2020)" : null),
        },
      ),
    );
    beginTaskRun(KEY, { runId: "run-a" });
    setTaskOutcomes(
      KEY,
      "run-a",
      outcomeCheckpoint(
        [
          // A model outcome counts its targets as a host one does.
          {
            ...save,
            status: "completed",
            targets: ["item:5", "item:6"],
            doneTargets: ["item:5", "item:6"],
          },
          outcomeTask("host-tags", {
            description: "Added tags",
            origin: "host",
            status: "completed",
            targets: ["item:3", "item:4", "item:99", "file:/tmp/export.csv"],
            doneTargets: ["item:3"],
            exceptions: [
              {
                targets: ["item:4", "item:99"],
                reason: "In a group library you cannot edit",
              },
              { targets: ["file:/tmp/export.csv"], reason: "Not applied" },
            ],
          }),
        ],
        "completed_with_exceptions",
      ),
    );
    completeTaskRun(KEY, { runId: "run-a" });
    harness.view.flush();
    assert.equal(harness.row.dataset.state, "completed_with_exceptions");
    assert.equal(pill(harness).textContent, "Partly done");
    assert.equal(pill(harness).dataset.tone, "completed_with_exceptions");
    assert.match(harness.count(), /^2\/2 steps · /);
    assert.equal(
      harness.row.getAttribute("aria-label"),
      `Task progress, Partly done, ${harness.count()}`,
    );
    const steps = openSteps(harness);
    assert.equal(headerStatus(steps), "Completed with exceptions");
    assert.equal(
      (steps.findByClass("llm-plan-status") as any).dataset.status,
      "completed_with_exceptions",
    );
    const [saveRow, hostRow, notDone] = rows(steps);
    assert.equal(labelOf(saveRow), "Save the summary as a note · 2 of 2");
    assert.equal(labelOf(hostRow), "Added tags · 1 of 4");
    assert.equal(notDone.findByClass("llm-plan-task-badge")!.textContent, "!");
    assert.equal(labelOf(notDone), "3 not done");
    assert.equal(
      detailOf(notDone),
      "In a group library you cannot edit: (Lee, 2020), item:99 · Not applied: file:/tmp/export.csv",
    );
  });

  it("completed with exceptions for one targeted write: counts its targets", function () {
    seedScope(6);
    const targets = Array.from(
      { length: 10 },
      (_, index) => `item:${index + 1}`,
    );
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "run-a" });
    setTaskOutcomes(
      KEY,
      "run-a",
      outcomeCheckpoint(
        [
          outcomeTask("host-batch", {
            description: "Updated metadata",
            origin: "host",
            status: "completed",
            targets,
            doneTargets: targets.slice(0, 8),
            exceptions: [
              {
                targets: targets.slice(8),
                reason: "In a group library you cannot edit",
              },
            ],
          }),
        ],
        "completed_with_exceptions",
      ),
    );
    completeTaskRun(KEY, { runId: "run-a" });
    harness.view.flush();
    assert.match(harness.count(), /^8 of 10 done · /);
  });

  it("counts a step's targets only when there are several, and counts targets only for an exception", function () {
    seedScope();
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "run-a" });
    setTaskOutcomes(
      KEY,
      "run-a",
      outcomeCheckpoint(
        [
          outcomeTask("host-tag", {
            description: "Added tags",
            origin: "host",
            status: "completed",
            targets: ["item:3"],
            doneTargets: ["item:3"],
          }),
        ],
        "completed",
      ),
    );
    completeTaskRun(KEY, { runId: "run-a" });
    harness.view.flush();
    assert.equal(pill(harness).textContent, "Completed");
    assert.match(harness.count(), /^1\/1 steps · /);
    const [row] = rows(openSteps(harness));
    assert.equal(labelOf(row), "Added tags");
  });

  it("names at most five targets per reason, and reads each paper's label once", function () {
    seedScope();
    const lookedUp: number[] = [];
    const harness = track(
      mount(
        {},
        {
          resolvePaperLabel: (itemId) => {
            lookedUp.push(itemId);
            return `(Author ${itemId}, 2020)`;
          },
        },
      ),
    );
    const undone = Array.from(
      { length: 8 },
      (_, index) => `item:${index + 11}`,
    );
    const tags = outcomeTask("host-tags", {
      description: "Added tags",
      origin: "host",
      status: "completed",
      targets: [...undone, "item:30"],
      doneTargets: ["item:30"],
      exceptions: [
        { targets: undone, reason: "In a group library you cannot edit" },
      ],
    });
    const expected =
      "In a group library you cannot edit: (Author 11, 2020), (Author 12, 2020), (Author 13, 2020), (Author 14, 2020), (Author 15, 2020) and 3 more";
    beginTaskRun(KEY, { runId: "run-a" });
    setTaskOutcomes(KEY, "run-a", outcomeCheckpoint([save, tags]));
    harness.view.flush();
    const steps = openSteps(harness);
    assert.equal(labelOf(rows(steps)[2]), "8 not done");
    assert.equal(detailOf(rows(steps)[2]), expected);
    // Repaints as the ledger moves on reuse the labels already read.
    const saved = { ...save, status: "completed" as const };
    setTaskOutcomes(KEY, "run-a", outcomeCheckpoint([saved, tags]));
    harness.view.flush();
    setTaskOutcomes(
      KEY,
      "run-a",
      outcomeCheckpoint([saved, tags], "completed_with_exceptions"),
    );
    harness.view.flush();
    // Each repaint rebuilt the Steps block; the labels were read only once.
    assert.equal(detailOf(rows(steps)[2]), expected);
    assert.deepEqual(lookedUp, [11, 12, 13, 14, 15]);
  });

  describe("a part that leaves papers out or was replaced", function () {
    const items = (count: number, from = 1) =>
      Array.from({ length: count }, (_, index) => `item:${from + index}`);
    /** The ledger as the host settles it when the answer is final. */
    const settled = (tasks: ExecutionCheckpointTask[]) => {
      const ledger = outcomeCheckpoint(tasks);
      return settleOutcomes(
        ledger,
        decideRunEnd(ledger, { status: "completed", stopRule: "final_answer" }),
        3,
      );
    };
    const pillOf = (row: FakeElement) =>
      row.findByClass("llm-plan-task-pill")!.textContent;
    const review = (overrides: Partial<ExecutionCheckpointTask> = {}) =>
      outcomeTask("review", {
        description: "Write the literature review",
        effect: "artifact",
        status: "completed",
        targets: items(8),
        doneTargets: items(1),
        excludedTargets: [
          { targets: items(6, 2), reason: "Off the question" },
          { targets: ["item:8"], reason: "A methods note" },
        ],
        ...overrides,
      });
    const label = (itemId: number) => `(Author ${itemId}, 2020)`;

    it("names excluded papers with the reason on the part's row, and leaves nothing open", function () {
      seedScope();
      const harness = track(mount({}, { resolvePaperLabel: label }));
      beginTaskRun(KEY, { runId: "run-a" });
      const ledger = settled([review()]);
      assert.equal(ledger.end?.state, "completed", "the host's own ending");
      setTaskOutcomes(KEY, "run-a", ledger);
      completeTaskRun(KEY, { runId: "run-a" });
      harness.view.flush();
      assert.equal(pill(harness).textContent, "Completed");
      assert.notEqual(pill(harness).textContent, "Partly done");
      assert.match(harness.count(), /^1\/1 steps · /);
      const steps = openSteps(harness);
      assert.equal(headerStatus(steps), "Completed");
      assert.lengthOf(rows(steps), 1, "excluded papers make no not-done row");
      const [row] = rows(steps);
      assert.equal(labelOf(row), "Write the literature review");
      assert.equal(pillOf(row), "Done");
      assert.equal(
        detailOf(row),
        "Excluded: Off the question: (Author 2, 2020), (Author 3, 2020), (Author 4, 2020), (Author 5, 2020), (Author 6, 2020) and 1 more · Excluded: A methods note: (Author 8, 2020)",
      );
    });

    it("replays the papers a submitted document left out as its part's Excluded line", function () {
      seedScope();
      const declared = outcomeCheckpoint([
        outcomeTask("review", {
          description: "Write the literature review",
          effect: "artifact",
          targets: items(3),
        }),
      ]);
      // submit_document named the part and left item:3 out.
      const delivered = applyOutcomeEvidence(
        declared,
        {
          kind: "material",
          materialRef: {
            documentId: "doc-1",
            documentVersion: 1,
            contentHash: "sha256:doc-1",
          },
          taskId: "review",
          citedTargets: items(2),
          excluded: [{ targets: ["3"], reason: "Off the question" }],
        },
        3,
      ).checkpoint;
      const events: AgentRunEventRecord[] = [
        executionCheckpointEvent(undefined, declared),
        executionCheckpointEvent(declared, settled(delivered.tasks)),
      ].map((payload, index) => ({
        runId: "run-x",
        seq: index + 1,
        eventType: payload.type,
        payload,
        createdAt: index + 1,
      }));
      assert.equal(events[1].payload.type, "execution_checkpoint_delta");
      hydrateTaskProgress(
        KEY,
        buildTaskProgressHistory(
          [
            { role: "user", text: "Review these papers", timestamp: 1 },
            {
              role: "assistant",
              text: "Done.",
              timestamp: 2,
              runMode: "agent",
              agentRunId: "run-x",
            },
          ],
          new Map([["run-x", events]]),
          1,
        ),
      );
      const harness = track(mount({}, { resolvePaperLabel: label }));
      harness.view.flush();
      assert.equal(pill(harness).textContent, "Completed");
      const [row] = rows(openSteps(harness));
      assert.equal(labelOf(row), "Write the literature review");
      assert.equal(pillOf(row), "Done");
      assert.equal(
        detailOf(row),
        "Excluded: Off the question: (Author 3, 2020)",
      );
    });

    it("counts only a part's exceptions as not done when it also excluded papers", function () {
      seedScope();
      const harness = track(mount({}, { resolvePaperLabel: label }));
      beginTaskRun(KEY, { runId: "run-a" });
      setTaskOutcomes(
        KEY,
        "run-a",
        settled([
          review({
            exceptions: [
              {
                targets: ["item:7"],
                reason: OUTCOME_REASONS.notCovered,
              },
            ],
            excludedTargets: [
              { targets: items(5, 2), reason: "Off the question" },
            ],
          }),
        ]),
      );
      completeTaskRun(KEY, { runId: "run-a" });
      harness.view.flush();
      assert.equal(pill(harness).textContent, "Partly done");
      const [row, notDone] = rows(openSteps(harness));
      assert.equal(
        detailOf(row),
        "Excluded: Off the question: (Author 2, 2020), (Author 3, 2020), (Author 4, 2020), (Author 5, 2020), (Author 6, 2020)",
      );
      assert.equal(labelOf(notDone), "1 not done");
      assert.equal(
        detailOf(notDone),
        `${OUTCOME_REASONS.notCovered}: (Author 7, 2020)`,
      );
    });

    it("a replaced part says why and reads Replaced; the run stays Completed and its steps count without it", function () {
      seedScope();
      const harness = track(mount());
      beginTaskRun(KEY, { runId: "run-a" });
      const replaced = outcomeTask("read-drift", {
        description: "Read each paper on drift",
        effect: "read",
        status: "cancelled",
        reason: "The user narrowed the question",
        supersededBy: "execution-1:task:read-ca1",
        targets: items(3),
        doneTargets: items(1),
      });
      const successor = outcomeTask("read-ca1", {
        description: "Read each paper on CA1 drift",
        effect: "read",
        status: "completed",
        targets: items(2),
        doneTargets: items(2),
      });
      const ledger = settled([replaced, successor]);
      assert.equal(ledger.end?.state, "completed", "the host's own ending");
      setTaskOutcomes(KEY, "run-a", ledger);
      completeTaskRun(KEY, { runId: "run-a" });
      harness.view.flush();
      assert.equal(pill(harness).textContent, "Completed");
      assert.match(
        harness.count(),
        /^1\/1 steps · /,
        "a replaced part is no step left open",
      );
      const steps = openSteps(harness);
      assert.equal(headerStatus(steps), "Completed");
      assert.equal(
        steps.findByClass("llm-plan-progress")!.getAttribute("aria-valuemax"),
        "1",
      );
      assert.lengthOf(rows(steps), 2);
      const [oldRow, newRow] = rows(steps);
      assert.equal(labelOf(oldRow), "Read each paper on drift · 1 of 3");
      assert.equal(pillOf(oldRow), "Replaced");
      assert.equal(
        detailOf(oldRow),
        "Replaced: The user narrowed the question",
      );
      assert.equal(pillOf(newRow), "Done");
      assert.equal(detailOf(newRow), "");
    });

    it("keeps a '$' in the model's reasons as written", function () {
      seedScope();
      const harness = track(mount());
      beginTaskRun(KEY, { runId: "run-a" });
      setTaskOutcomes(
        KEY,
        "run-a",
        outcomeCheckpoint([
          review({
            excludedTargets: [{ targets: ["item:2"], reason: "Costs $& more" }],
          }),
          outcomeTask("old", {
            description: "Read the papers",
            status: "cancelled",
            reason: "Uses $1 now",
            supersededBy: "execution-1:task:review",
          }),
        ]),
      );
      harness.view.flush();
      const [reviewRow, oldRow] = rows(openSteps(harness));
      assert.equal(detailOf(reviewRow), "Excluded: Costs $& more: item:2");
      assert.equal(detailOf(oldRow), "Replaced: Uses $1 now");
    });

    it("a part cancelled without a replacement still reads Cancelled", function () {
      seedScope();
      const harness = track(mount());
      beginTaskRun(KEY, { runId: "run-a" });
      setTaskOutcomes(
        KEY,
        "run-a",
        outcomeCheckpoint([
          outcomeTask("save", {
            description: "Save the summary as a note",
            status: "cancelled",
            reason: "The user stopped it",
          }),
        ]),
      );
      harness.view.flush();
      const [row] = rows(openSteps(harness));
      assert.equal(pillOf(row), "Cancelled");
      assert.equal(detailOf(row), "The user stopped it");
      assert.match(harness.count(), /^0\/1 steps · /);
    });
  });

  describe("a part over every paper in the scope", function () {
    const items = (count: number, from = 1) =>
      Array.from({ length: count }, (_, index) => `item:${from + index}`);
    const readAll = (targets: string[], done: string[]) =>
      outcomeTask("read-all", {
        description: "Read each paper in Drift",
        effect: "read",
        scope: true,
        status: done.length === targets.length ? "completed" : "pending",
        targets,
        doneTargets: done,
      });
    const noteAll = (targets: string[], done: string[]) =>
      outcomeTask("note-all", {
        description: "Write a note on each paper",
        capability: "zotero.notes",
        scope: true,
        targets,
        doneTargets: done,
      });

    it("counts done of total on its row: Read each paper in Drift · 48 of 48", function () {
      seedScope(48);
      const harness = track(mount());
      beginTaskRun(KEY, { runId: "run-a" });
      setTaskOutcomes(
        KEY,
        "run-a",
        outcomeCheckpoint([
          readAll(items(48), items(48)),
          noteAll(items(48), items(20)),
        ]),
      );
      harness.view.flush();
      const [readRow, noteRow] = rows(openSteps(harness));
      assert.equal(labelOf(readRow), "Read each paper in Drift · 48 of 48");
      assert.equal(labelOf(noteRow), "Write a note on each paper · 20 of 48");
      assert.equal(
        readRow.findByClass("llm-plan-task-pill")!.textContent,
        "Done",
      );
    });

    it("names the papers in scope in the row: 2/4 steps · 212 papers in scope", function () {
      seedScope(200);
      const harness = track(mount());
      beginTaskRun(KEY, { runId: "run-a" });
      setTaskOutcomes(
        KEY,
        "run-a",
        outcomeCheckpoint([
          readAll(items(212), items(212)),
          outcomeTask("explain", {
            description: "Explain the common thread",
            effect: "answer",
            status: "completed",
          }),
          noteAll(items(212), items(120)),
          outcomeTask("tag", {
            description: "Tag the papers",
            capability: "zotero.tags",
          }),
        ]),
      );
      harness.view.flush();
      // The frozen part, not the listing, sizes the scope.
      assert.equal(harness.count(), "2/4 steps · 212 papers in scope");
      markTaskAnswering(KEY, "run-a");
      harness.view.flush();
      assert.equal(
        harness.count(),
        "Answering… · 2/4 steps · 212 papers in scope",
      );
    });

    it("sizes a whole-library scope that lists no papers", function () {
      const harness = track(mount());
      beginTaskRun(KEY, { runId: "run-a" });
      setTaskOutcomes(KEY, "run-a", outcomeCheckpoint([readAll(items(1), [])]));
      harness.view.flush();
      assert.equal(harness.count(), "0/1 steps · 1 paper in scope");
      const [row] = rows(openSteps(harness));
      assert.equal(
        labelOf(row),
        "Read each paper in Drift",
        "one paper needs no count",
      );
    });

    it("counts only what reads and writes tick, not a part the answer completes", function () {
      const harness = track(mount());
      beginTaskRun(KEY, { runId: "run-a" });
      setTaskOutcomes(
        KEY,
        "run-a",
        outcomeCheckpoint([
          outcomeTask("compare", {
            description: "Compare the papers in Drift",
            effect: "answer",
            status: "completed",
            scope: true,
            targets: items(12),
          }),
          outcomeTask("draft", {
            description: "Draft a review of Drift",
            effect: "artifact",
            targets: items(12),
          }),
        ]),
      );
      harness.view.flush();
      const [compareRow, draftRow] = rows(openSteps(harness));
      assert.equal(labelOf(compareRow), "Compare the papers in Drift");
      assert.equal(labelOf(draftRow), "Draft a review of Drift");
    });

    it("keeps the read count for a run without one", function () {
      seedScope();
      const harness = track(mount());
      beginTaskRun(KEY, { runId: "run-a" });
      setTaskOutcomes(
        KEY,
        "run-a",
        outcomeCheckpoint([
          outcomeTask("read", {
            description: "Read both papers",
            effect: "read",
            targets: items(2),
            doneTargets: items(1),
          }),
        ]),
      );
      harness.view.flush();
      assert.equal(harness.count(), "0/1 steps · 0 of 200 read");
      const [row] = rows(openSteps(harness));
      assert.equal(labelOf(row), "Read both papers · 1 of 2");
    });
  });

  it("blocked: Needs your decision, the steps count, and why", function () {
    seedScope();
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "run-a" });
    setTaskOutcomes(
      KEY,
      "run-a",
      outcomeCheckpoint(
        [{ ...save, status: "blocked", reason: OUTCOME_REASONS.declined }],
        "blocked",
      ),
    );
    completeTaskRun(KEY, { runId: "run-a" });
    harness.view.flush();
    assert.equal(harness.row.dataset.state, "blocked");
    assert.equal(pill(harness).textContent, "Needs input");
    assert.equal(pill(harness).dataset.tone, "blocked");
    assert.match(harness.count(), /^0\/1 steps · /);
    const steps = openSteps(harness);
    assert.equal(headerStatus(steps), "Needs your decision");
    assert.equal(
      (steps.findByClass("llm-plan-status") as any).dataset.status,
      "waiting_for_user",
      "a blocked ledger's header takes the amber waiting look",
    );
    const [row] = rows(steps);
    assert.equal(row.className, "llm-plan-task llm-plan-task-blocked");
    assert.equal(row.findByClass("llm-plan-task-badge")!.textContent, "!");
    assert.equal(row.findByClass("llm-plan-task-pill")!.textContent, "Blocked");
    assert.equal(detailOf(row), "You declined this change.");
  });

  it("interrupted: the pill, the header, and how to resume", function () {
    seedScope();
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "run-a" });
    setTaskOutcomes(
      KEY,
      "run-a",
      outcomeCheckpoint([read, save], "interrupted"),
    );
    endTaskRun(KEY, "failed", "run-a");
    harness.view.flush();
    assert.equal(harness.row.dataset.state, "interrupted");
    assert.equal(pill(harness).textContent, "Interrupted");
    assert.equal(pill(harness).dataset.tone, "interrupted");
    assert.match(harness.count(), /^1\/2 steps · /);
    const steps = openSteps(harness);
    assert.equal(headerStatus(steps), "Interrupted");
    assert.include(collectFakeText(steps), "Say “continue” to resume.");
  });

  it("an end with no outcome shows no steps", function () {
    seedScope();
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "run-a" });
    setTaskOutcomes(KEY, "run-a", outcomeCheckpoint([], "blocked"));
    harness.view.flush();
    assert.equal(harness.count(), "0 of 200 read");
    assert.equal(pill(harness).textContent, "Needs input");
    harness.row.dispatchFakeEvent("click");
    const steps = harness.drawer.findByClass("llm-task-progress-steps")!;
    assert.isTrue((steps as any).hidden);
  });

  describe("a digest part", function () {
    const items = (count: number) =>
      Array.from({ length: count }, (_, index) => `item:${index + 1}`);
    const summaries = (done: number, total = 12) =>
      outcomeTask("summaries", {
        description: "Summarize each selected paper",
        effect: "digest",
        scope: true,
        targets: items(total),
        doneTargets: items(done),
      });
    function paperRow(harness: Harness, key: string): FakeElement {
      const found = harness.items().find((item) => item.dataset.key === key);
      assert.isOk(found, `row ${key}`);
      return found!;
    }
    const tailOf = (row: FakeElement) =>
      row.findByClass("llm-task-paper-tail")!.textContent;
    function expand(row: FakeElement): FakeElement {
      row.findByClass("llm-task-paper-summary")!.dispatchFakeEvent("click");
      return row.findByClass("llm-task-paper-details")!;
    }

    it("counts its papers on its row: Summarize each selected paper · 7 of 12", function () {
      seedScope(12);
      const harness = track(mount());
      beginTaskRun(KEY, { runId: "run-d" });
      setTaskOutcomes(KEY, "run-d", outcomeCheckpoint([summaries(7)]));
      harness.view.flush();
      const [row] = rows(openSteps(harness));
      assert.equal(labelOf(row), "Summarize each selected paper · 7 of 12");
    });

    it("a digested paper's row counts its evidence passages and shows the summary and its evidence by section", function () {
      seedScope(2);
      const harness = track(mount());
      beginTaskRun(KEY, { runId: "run-d" });
      applyTaskPaperUpdate(
        KEY,
        digestLedgerDelta("call-s", 1, {
          runId: "run-d",
          summary: "Cells drift slowly over days.",
          evidence: [
            { section: "Methods", quote: "We recorded 40 cells over 10 days." },
            { section: "Results", quote: "Drift grew with experience." },
          ],
        }),
        "run-d",
      );
      applyTaskPaperUpdate(
        KEY,
        digestLedgerDelta("call-s", 2, {
          runId: "run-d",
          summary: "No passage survived verification.",
        }),
        "run-d",
      );
      harness.row.dispatchFakeEvent("click");
      const first = paperRow(harness, "1:1");
      assert.equal(first.dataset.state, "read");
      assert.equal(tailOf(first), "2 passages");
      assert.equal(
        tailOf(paperRow(harness, "1:2")),
        "Summary",
        "a digest with no surviving evidence still has its summary",
      );
      const details = expand(first);
      const text = collectFakeText(details);
      assert.include(text, "Summary");
      assert.include(text, "Cells drift slowly over days.");
      assert.include(text, "Methods");
      assert.include(text, "We recorded 40 cells over 10 days.");
      assert.include(text, "Results");
      const block = details.findByClass("llm-task-paper-digest")!;
      assert.equal(
        block.findByClass("llm-task-paper-turn")!.textContent,
        "Summary",
        "the summary sits in a block like Cited in document",
      );
      assert.equal(
        block.findByClass("llm-task-paper-snippet")!.textContent,
        "Cells drift slowly over days.",
      );
      assert.equal(
        text.split("Cells drift slowly over days.").length - 1,
        1,
        "the summary shows once",
      );
      assert.lengthOf(
        details.findAllByClass("llm-task-paper-open"),
        2,
        "only the evidence passages open the source",
      );
    });

    it("shows a long summary whole in its Summary block", function () {
      seedScope(2);
      const harness = track(mount());
      beginTaskRun(KEY, { runId: "run-d" });
      const summary = `${"Place fields drift across days of recording. ".repeat(33).trim()} End.`;
      assert.isAbove(summary.length, 1400);
      applyTaskPaperUpdate(
        KEY,
        digestLedgerDelta("call-s", 1, { runId: "run-d", summary }),
        "run-d",
      );
      harness.row.dispatchFakeEvent("click");
      const details = expand(paperRow(harness, "1:1"));
      assert.equal(
        details
          .findByClass("llm-task-paper-digest")!
          .findByClass("llm-task-paper-snippet")!.textContent,
        summary,
      );
    });

    it("a whole-paper read keeps Full text on the row, and a citation follows", function () {
      seedScope(2);
      const harness = track(mount());
      beginTaskRun(KEY, { runId: "run-d" });
      applyTaskPaperUpdate(
        KEY,
        {
          version: 1,
          callId: "full",
          runId: "run-d",
          toolName: "paper_read",
          papers: [{ key: "1:1", libraryID: 1, itemId: 1, state: "read" }],
          reads: [
            {
              key: "1:1",
              callId: "full",
              toolName: "paper_read",
              granularity: "full",
              method: "full",
            },
          ],
        },
        "run-d",
      );
      applyTaskPaperUpdate(
        KEY,
        digestLedgerDelta("call-s", 1, {
          runId: "run-d",
          evidence: [{ section: "Methods", quote: "We recorded cells." }],
        }),
        "run-d",
      );
      applyTaskDocumentCitations(KEY, "run-d", [
        { citationId: "d1", libraryID: 1, itemKey: "P1", itemId: 1 },
      ]);
      harness.row.dispatchFakeEvent("click");
      assert.equal(tailOf(paperRow(harness, "1:1")), "Full text · cited 1");
    });

    it("a failed digest shows its reason on the row", function () {
      seedScope(2);
      const harness = track(mount());
      beginTaskRun(KEY, { runId: "run-d" });
      applyTaskPaperUpdate(
        KEY,
        digestLedgerDelta("call-s", 1, {
          runId: "run-d",
          failure: "No readable text",
        }),
        "run-d",
      );
      harness.row.dispatchFakeEvent("click");
      const row = paperRow(harness, "1:1");
      assert.equal(row.dataset.state, "matched");
      assert.equal(tailOf(row), "Summary failed");
      const details = expand(row);
      const text = collectFakeText(details);
      assert.include(text, "Summary");
      assert.include(text, "No readable text");
      assert.notInclude(
        text,
        "Matched by title or abstract",
        "the failure explains the row",
      );
      assert.lengthOf(details.findAllByClass("llm-task-paper-open"), 0);
    });

    it("a later digest of a failed paper replaces its failure", function () {
      seedScope(2);
      const harness = track(mount());
      beginTaskRun(KEY, { runId: "run-d" });
      applyTaskPaperUpdate(
        KEY,
        digestLedgerDelta("call-s", 1, {
          runId: "run-d",
          failure: "The summary call timed out",
        }),
        "run-d",
      );
      applyTaskPaperUpdate(
        KEY,
        digestLedgerDelta("call-t", 1, {
          runId: "run-d",
          summary: "Retried and summarized.",
          evidence: [{ quote: "One sentence." }],
        }),
        "run-d",
      );
      harness.row.dispatchFakeEvent("click");
      const row = paperRow(harness, "1:1");
      assert.equal(tailOf(row), "1 passage");
      const text = collectFakeText(expand(row));
      assert.include(text, "Retried and summarized.");
      assert.notInclude(text, "timed out");
    });

    describe("over several parts", function () {
      const BRIEF = "Summarize each paper";
      const PATH = "Evidence for path integration";
      /** Each digest block of an expanded row, as a reader sees it. */
      const blocksOf = (details: FakeElement) =>
        details.findAllByClass("llm-task-paper-digest").map((block) => ({
          heading: block.findByClass("llm-task-paper-turn")!.textContent,
          lines: block
            .findAllByClass("llm-task-paper-how")
            .map((line) => line.textContent),
          answer: block.findByClass("llm-task-paper-snippet")?.textContent,
          note: block.findByClass("llm-task-paper-empty")?.textContent,
        }));
      const apply = (delta: ReturnType<typeof digestLedgerDelta>) =>
        applyTaskPaperUpdate(KEY, delta, "run-d");
      const brief = (callId: string, itemId: number, summary: string) =>
        digestLedgerDelta(callId, itemId, {
          runId: "run-d",
          partId: "brief",
          label: BRIEF,
          summary,
        });
      const path = (
        callId: string,
        itemId: number,
        result: { summary: string } | { failure: string },
      ) =>
        digestLedgerDelta(callId, itemId, {
          runId: "run-d",
          partId: "path",
          label: PATH,
          ...result,
          ...("summary" in result
            ? {
                relevance: {
                  level: "direct" as const,
                  reason: "It measures belief during navigation.",
                },
                stance: {
                  position: "supports" as const,
                  reason: "Eye movements follow the latent position.",
                },
              }
            : {}),
        });

      it("shows one block per part under its label, the newest result of each, in the order the parts first appeared", function () {
        seedScope(2);
        const harness = track(mount());
        beginTaskRun(KEY, { runId: "run-d" });
        apply(brief("call-a", 1, "First brief."));
        apply(path("call-b", 1, { failure: "The model call timed out" }));
        apply(path("call-c", 1, { summary: "Gaze tracks the belief." }));
        apply(brief("call-d", 1, "Second brief."));
        // A later failure of a part does not hide the part's result.
        apply(path("call-e", 1, { failure: "The model call failed" }));
        harness.row.dispatchFakeEvent("click");
        const row = paperRow(harness, "1:1");
        const details = expand(row);
        assert.deepEqual(blocksOf(details), [
          {
            heading: BRIEF,
            lines: [],
            answer: "Second brief.",
            note: undefined,
          },
          {
            heading: PATH,
            lines: [
              "Directly relevant — It measures belief during navigation.",
              "Supports — Eye movements follow the latent position.",
            ],
            answer: "Gaze tracks the belief.",
            note: undefined,
          },
        ]);
        const text = collectFakeText(details);
        assert.notInclude(text, "First brief.");
        assert.notInclude(text, "timed out");
        assert.notInclude(text, "Summary", "every block has its part's label");
        assert.equal(
          tailOf(row),
          BRIEF,
          "the tail names the part whose result came last",
        );
      });

      it("a failed part shows '<label> failed' with the host's reason beside a part that succeeded", function () {
        seedScope(2);
        const harness = track(mount());
        beginTaskRun(KEY, { runId: "run-d" });
        apply(path("call-b", 1, { failure: "The model call timed out" }));
        apply(brief("call-a", 1, "In brief."));
        // Paper 2: its only part failed.
        apply(path("call-c", 2, { failure: "No readable text" }));
        harness.row.dispatchFakeEvent("click");
        const first = paperRow(harness, "1:1");
        assert.deepEqual(blocksOf(expand(first)), [
          {
            heading: `${PATH} failed`,
            lines: [],
            answer: undefined,
            note: "The model call timed out",
          },
          {
            heading: BRIEF,
            lines: [],
            answer: "In brief.",
            note: undefined,
          },
        ]);
        assert.equal(tailOf(first), BRIEF);
        const second = paperRow(harness, "1:2");
        assert.equal(second.dataset.state, "matched");
        assert.equal(tailOf(second), `${PATH} failed`);
        const details = expand(second);
        assert.deepEqual(blocksOf(details), [
          {
            heading: `${PATH} failed`,
            lines: [],
            answer: undefined,
            note: "No readable text",
          },
        ]);
        assert.notInclude(
          collectFakeText(details),
          "Matched by title or abstract",
          "the failure explains the row",
        );
      });

      it("a row saved before parts were recorded keeps its one Summary block beside a part's block", function () {
        seedScope(2);
        const harness = track(mount());
        beginTaskRun(KEY, { runId: "run-d" });
        apply(
          digestLedgerDelta("call-old", 1, {
            runId: "run-d",
            summary: "Saved summary.",
          }),
        );
        apply(
          digestLedgerDelta("call-older", 1, {
            runId: "run-d",
            failure: "The summary call timed out",
          }),
        );
        apply(path("call-c", 1, { summary: "Gaze tracks the belief." }));
        harness.row.dispatchFakeEvent("click");
        const row = paperRow(harness, "1:1");
        const blocks = blocksOf(expand(row));
        assert.deepEqual(
          blocks.map((block) => [block.heading, block.answer]),
          [
            ["Summary", "Saved summary."],
            [PATH, "Gaze tracks the belief."],
          ],
        );
        assert.equal(tailOf(row), PATH);
      });

      it("keeps two questions' parts apart when both declare a part 'papers': the part is named by its execution-qualified id", function () {
        seedScope(2);
        const harness = track(mount());
        const question = (
          runId: string,
          turnIndex: number,
          result: { summary: string } | { failure: string },
          label: string,
        ) => {
          beginTaskRun(KEY, { runId, turnIndex });
          applyTaskPaperUpdate(
            KEY,
            digestLedgerDelta(`call-${runId}`, 1, {
              runId,
              partId: `exec-${runId}:task:papers`,
              label,
              ...result,
            }),
            runId,
          );
          completeTaskRun(KEY, { runId });
        };
        question("q1", 1, { summary: "Gaze tracks the belief." }, BRIEF);
        // The newer question's part fails; it must not hide the older result.
        question("q2", 2, { failure: "The model call timed out" }, PATH);
        harness.row.dispatchFakeEvent("click");
        const row = paperRow(harness, "1:1");
        assert.deepEqual(blocksOf(expand(row)), [
          {
            heading: `${PATH} failed`,
            lines: [],
            answer: undefined,
            note: "The model call timed out",
          },
        ]);
        // The older question keeps its own result, under its own header.
        const earlier = harness.drawer.findByClass(
          "llm-task-progress-question-section",
        )!;
        earlier
          .findByClass("llm-task-progress-question")!
          .dispatchFakeEvent("click");
        assert.deepEqual(
          blocksOf(expand(earlier.findAllByClass("llm-task-paper")[0])),
          [
            {
              heading: BRIEF,
              lines: [],
              answer: "Gaze tracks the belief.",
              note: undefined,
            },
          ],
        );
      });

      it("heads a block with the label the host cut at a word, and clips a longer one", function () {
        seedScope(3);
        const harness = track(mount());
        beginTaskRun(KEY, { runId: "run-d" });
        const label = taskPaperDigestPartLabel(
          "For each paper, list the evidence that connects it to path integration during naturalistic navigation. Name the task.",
        )!;
        assert.isAtMost(label.length, 60);
        assert.match(label, /…$/);
        apply(
          digestLedgerDelta("call-a", 1, {
            runId: "run-d",
            partId: "evidence",
            label,
          }),
        );
        // A label saved longer than the host writes is clipped, not trusted.
        apply(
          digestLedgerDelta("call-b", 2, {
            runId: "run-d",
            partId: "long",
            label: "x".repeat(80),
          }),
        );
        harness.row.dispatchFakeEvent("click");
        const first = paperRow(harness, "1:1");
        assert.equal(blocksOf(expand(first))[0].heading, label);
        assert.equal(tailOf(first), label);
        const second = blocksOf(expand(paperRow(harness, "1:2")))[0];
        assert.lengthOf(second.heading!, 60);
      });

      it("renders the same blocks after the run is replayed from its saved events", function () {
        seedScope(2);
        const deltas = [
          brief("call-a", 1, "In brief."),
          path("call-b", 1, { summary: "Gaze tracks the belief." }),
          path("call-c", 2, { failure: "No readable text" }),
        ];
        const events: AgentRunEventRecord[] = deltas.map((delta, index) => ({
          runId: "run-d",
          seq: index + 1,
          eventType: "paper_ledger_update",
          payload: {
            type: "paper_ledger_update",
            callId: delta.callId,
            delta,
          },
          createdAt: index + 1,
        }));
        hydrateTaskProgress(
          KEY,
          buildTaskProgressHistory(
            [
              { role: "user", text: "Summarize them", timestamp: 1 },
              {
                role: "assistant",
                text: "Done.",
                timestamp: 2,
                runMode: "agent",
                agentRunId: "run-d",
              },
            ],
            new Map([["run-d", events]]),
            1,
          ),
        );
        const harness = track(mount());
        harness.row.dispatchFakeEvent("click");
        const first = paperRow(harness, "1:1");
        assert.deepEqual(
          blocksOf(expand(first)).map((block) => [
            block.heading,
            block.lines,
            block.answer,
          ]),
          [
            [BRIEF, [], "In brief."],
            [
              PATH,
              [
                "Directly relevant — It measures belief during navigation.",
                "Supports — Eye movements follow the latent position.",
              ],
              "Gaze tracks the belief.",
            ],
          ],
        );
        assert.equal(tailOf(first), PATH);
        assert.equal(tailOf(paperRow(harness, "1:2")), `${PATH} failed`);
      });
    });
  });

  describe("in Chinese", function () {
    const globals = globalThis as unknown as { Zotero?: unknown };
    let previousZotero: unknown;
    before(function () {
      previousZotero = globals.Zotero;
      globals.Zotero = { Prefs: { get: () => "zh-CN" }, locale: "zh-CN" };
      initI18n();
    });
    after(function () {
      if (previousZotero === undefined) delete globals.Zotero;
      else globals.Zotero = previousZotero;
      initI18n();
    });

    it("translates every host reason and new string, and keeps the model's words as written", function () {
      for (const value of [
        ...Object.values(OUTCOME_REASONS),
        "Needs your decision",
        "Partly done",
        "{done} of {total} done",
        "{count} not done",
        "{done} of {total}",
        "Say “continue” to resume.",
      ]) {
        assert.notEqual(t(value), value, value);
      }
      seedScope();
      const harness = track(mount());
      beginTaskRun(KEY, { runId: "run-a" });
      setTaskOutcomes(
        KEY,
        "run-a",
        outcomeCheckpoint(
          [
            { ...save, status: "blocked", reason: OUTCOME_REASONS.declined },
            outcomeTask("ask", {
              description: "Ask which collection to use",
              status: "blocked",
              reason: "Needs the user's choice of collection",
            }),
            // The model's words stay as written even when they read like a
            // string the plugin translates.
            outcomeTask("pick", {
              description: "Pick a collection",
              status: "blocked",
              reason: "Needs input",
            }),
          ],
          "blocked",
        ),
      );
      harness.view.flush();
      const [declinedRow, askRow, pickRow] = rows(openSteps(harness));
      assert.equal(detailOf(declinedRow), t(OUTCOME_REASONS.declined));
      assert.equal(detailOf(askRow), "Needs the user's choice of collection");
      assert.equal(labelOf(askRow), "Ask which collection to use");
      assert.notEqual(t("Needs input"), "Needs input");
      assert.equal(detailOf(pickRow), "Needs input");
    });

    it("translates the digest labels and the host's digest failure reasons", function () {
      for (const value of [
        "Summary",
        "Summary failed",
        ...Object.values(DIGEST_FAILURE_REASONS),
      ]) {
        assert.notEqual(t(value), value, value);
      }
      assert.notEqual(
        t("Summary"),
        t("Abstract"),
        "a summary is not an abstract",
      );
    });

    it("translates the relevance and stance words, a part's failure, exclusions and replacements, and keeps the model's words as written", function () {
      const words = [
        "Directly relevant",
        "Partly relevant",
        "Not relevant",
        "Relevance unclear",
        "Supports",
        "Challenges",
        "Mixed",
        "Stance unclear",
      ];
      for (const value of [
        ...words,
        "{label} failed",
        "Excluded: {reason}",
        "Replaced: {reason}",
        "Replaced",
      ]) {
        assert.notEqual(t(value), value, value);
      }
      assert.lengthOf(
        new Set(words.map(t)),
        words.length,
        "each value reads differently",
      );
      seedScope(2);
      const harness = track(mount());
      beginTaskRun(KEY, { runId: "run-d" });
      const label = "路径整合的证据";
      applyTaskPaperUpdate(
        KEY,
        digestLedgerDelta("call-p", 1, {
          runId: "run-d",
          partId: "path",
          label,
          summary: "注视追踪信念。",
          relevance: { level: "partial", reason: "只涉及导航的一部分。" },
          stance: { position: "mixed", reason: "结果不一。" },
        }),
        "run-d",
      );
      applyTaskPaperUpdate(
        KEY,
        digestLedgerDelta("call-q", 2, {
          runId: "run-d",
          partId: "path",
          label,
          failure: "No readable text",
        }),
        "run-d",
      );
      harness.row.dispatchFakeEvent("click");
      const rowOf = (key: string) =>
        harness.items().find((item) => item.dataset.key === key)!;
      const open = (key: string) => {
        rowOf(key)
          .findByClass("llm-task-paper-summary")!
          .dispatchFakeEvent("click");
        return rowOf(key)
          .findByClass("llm-task-paper-details")!
          .findByClass("llm-task-paper-digest")!;
      };
      const block = open("1:1");
      assert.equal(
        block.findByClass("llm-task-paper-turn")!.textContent,
        label,
      );
      assert.deepEqual(
        block
          .findAllByClass("llm-task-paper-how")
          .map((line) => line.textContent),
        [
          `${t("Partly relevant")} — 只涉及导航的一部分。`,
          `${t("Mixed")} — 结果不一。`,
        ],
      );
      const failed = open("1:2");
      const heading = t("{label} failed").replace("{label}", label);
      assert.equal(
        failed.findByClass("llm-task-paper-turn")!.textContent,
        heading,
      );
      assert.equal(
        failed.findByClass("llm-task-paper-empty")!.textContent,
        t("No readable text"),
      );
      assert.equal(
        rowOf("1:2").findByClass("llm-task-paper-tail")!.textContent,
        heading,
      );
    });

    it("says Excluded and Replaced in the reader's language, with the model's reasons as written", function () {
      seedScope();
      const harness = track(mount());
      beginTaskRun(KEY, { runId: "run-a" });
      setTaskOutcomes(
        KEY,
        "run-a",
        outcomeCheckpoint([
          outcomeTask("review", {
            description: "Write the review",
            effect: "artifact",
            status: "completed",
            targets: ["item:1", "item:2"],
            doneTargets: ["item:1"],
            excludedTargets: [{ targets: ["item:2"], reason: "化学论文" }],
          }),
          outcomeTask("old", {
            description: "Read the papers",
            effect: "read",
            status: "cancelled",
            reason: "问题变了",
            supersededBy: "execution-1:task:review",
          }),
        ]),
      );
      harness.view.flush();
      const [reviewRow, oldRow] = rows(openSteps(harness));
      assert.equal(
        detailOf(reviewRow),
        t("Excluded: {reason}").replace("{reason}", "化学论文: item:2"),
      );
      assert.equal(
        detailOf(oldRow),
        t("Replaced: {reason}").replace("{reason}", "问题变了"),
      );
      assert.equal(
        oldRow.findByClass("llm-plan-task-pill")!.textContent,
        t("Replaced"),
      );
    });
  });
});

describe("task progress row count with nothing attached", function () {
  const views: TaskProgressView[] = [];
  afterEach(function () {
    for (const view of views.splice(0)) view.dispose();
    clearAllTaskProgress();
  });
  function track(harness: Harness): Harness {
    views.push(harness.view);
    return harness;
  }

  /** A Library chat with an empty context bar, as the panel sets it. */
  function seedWholeLibrary() {
    setTaskScope(KEY, {
      signature: "library",
      libraryID: 1,
      contexts: {},
      label: "",
      listing: {
        libraryID: 1,
        wholeLibrary: true,
        entries: [],
        totalItems: 0,
        listedItems: 0,
        truncated: false,
      },
    });
  }

  /** A paper_read of one paper, at the depth and by the method given. */
  function paperRead(
    callId: string,
    itemId: number,
    granularity: TaskPaperReadEvent["granularity"],
    method: string,
  ): TaskPaperLedgerDelta {
    return {
      version: 1,
      callId,
      runId: "run-w",
      toolName: "paper_read",
      papers: [
        {
          key: `1:${itemId}`,
          libraryID: 1,
          itemId,
          title: `Paper ${itemId}`,
          state: granularity === "full" ? "read" : "skimmed",
        },
      ],
      reads: [
        {
          key: `1:${itemId}`,
          callId,
          toolName: "paper_read",
          granularity,
          method,
          snippet: "Body text.",
        },
      ],
    };
  }

  const steps = outcomeCheckpoint([
    outcomeTask("papers", {
      description: "Summarize each chosen paper",
      effect: "digest",
      status: "completed",
      targets: ["item:1", "item:2", "item:3"],
      doneTargets: ["item:1", "item:2", "item:3"],
    }),
    outcomeTask("answer", {
      description: "Answer the question",
      effect: "answer",
      status: "completed",
    }),
  ]);

  /**
   * Eighteen papers the search found; digests answer 1-3 and fail on 4; a
   * paper_read takes in 5's overview and 7's whole text, and only a targeted
   * passage of 6; the answer cites 1 and 2.
   */
  function runOverLibrary(view: TaskProgressView) {
    beginTaskRun(KEY, { runId: "run-w", turnIndex: 1 });
    setTaskOutcomes(KEY, "run-w", steps);
    applyTaskPaperUpdate(
      KEY,
      {
        ...ledgerDelta(
          "c-search",
          Array.from(
            { length: 18 },
            (_, index): [number, "skimmed", string] => [
              index + 1,
              "skimmed",
              `Hit ${index + 1}.`,
            ],
          ),
          "run-w",
        ),
      },
      "run-w",
    );
    view.flush();
    for (const itemId of [1, 2, 3])
      applyTaskPaperUpdate(
        KEY,
        digestLedgerDelta(`c-digest-${itemId}`, itemId, { runId: "run-w" }),
        "run-w",
      );
    applyTaskPaperUpdate(
      KEY,
      digestLedgerDelta("c-digest-4", 4, {
        runId: "run-w",
        failure: "No readable text",
      }),
      "run-w",
    );
    applyTaskPaperUpdate(
      KEY,
      paperRead("c-read-5", 5, "passage", "overview"),
      "run-w",
    );
    applyTaskPaperUpdate(
      KEY,
      paperRead("c-read-6", 6, "section", "targeted"),
      "run-w",
    );
    applyTaskPaperUpdate(
      KEY,
      paperRead("c-read-7", 7, "full", "full"),
      "run-w",
    );
    completeTaskRun(KEY, {
      runId: "run-w",
      quoteCitations: [quoteCitation("a", 1), quoteCitation("b", 2)],
    });
    view.flush();
  }

  const library = {
    visibility: {
      conversationKind: "global" as const,
      isWebChat: false,
      isNoteSession: false,
      collectionCount: 0,
      tagCount: 0,
      paperCount: 0,
    },
  };

  it("separates the papers read in depth from those the search only found", function () {
    seedWholeLibrary();
    const harness = track(mount(library));
    beginTaskRun(KEY, { runId: "run-w", turnIndex: 1 });
    setTaskOutcomes(KEY, "run-w", steps);
    harness.view.flush();
    assert.equal(harness.count(), "2/2 steps", "a zero term is dropped");
    runOverLibrary(harness.view);
    assert.equal(
      harness.count(),
      "2/2 steps · 5 read in depth · 13 found · 2 cited",
    );
  });

  it("shows the row once a paper is read in depth, with nothing attached and no steps", function () {
    seedWholeLibrary();
    const harness = track(mount(library));
    beginTaskRun(KEY, { runId: "run-w", turnIndex: 1 });
    // Search hits alone leave a plain library question without a row.
    applyTaskPaperUpdate(
      KEY,
      ledgerDelta("c-search", [[1, "skimmed", "Hit."]], "run-w"),
      "run-w",
    );
    harness.view.flush();
    assert.isTrue((harness.row as any).hidden, "nothing read in depth yet");
    // The agent reads a paper in depth without declaring a step.
    applyTaskPaperUpdate(
      KEY,
      paperRead("c-read-1", 1, "full", "full"),
      "run-w",
    );
    harness.view.flush();
    assert.isFalse((harness.row as any).hidden);
    assert.equal(harness.count(), "1 read in depth");
  });

  it("names only the search's hits before any paper is read in depth, and says Answering…", function () {
    seedWholeLibrary();
    const harness = track(mount(library));
    beginTaskRun(KEY, { runId: "run-w", turnIndex: 1 });
    setTaskOutcomes(KEY, "run-w", steps);
    applyTaskPaperUpdate(
      KEY,
      ledgerDelta(
        "c-search",
        [
          [1, "skimmed", "Hit."],
          [2, "matched"],
        ],
        "run-w",
      ),
      "run-w",
    );
    markTaskAnswering(KEY, "run-w");
    harness.view.flush();
    assert.equal(harness.count(), "Answering… · 2/2 steps · 2 found");
  });

  it("counts the latest question only", function () {
    seedWholeLibrary();
    const harness = track(mount(library));
    runOverLibrary(harness.view);
    beginTaskRun(KEY, { runId: "run-x", turnIndex: 2 });
    applyTaskPaperUpdate(
      KEY,
      ledgerDelta("c-search-2", [[30, "skimmed", "Hit."]], "run-x"),
      "run-x",
    );
    harness.view.flush();
    assert.equal(harness.count(), "1 found");
  });

  it("keeps the count of an attached scope as it was", function () {
    seedScope(20);
    const harness = track(mount());
    runOverLibrary(harness.view);
    assert.equal(harness.count(), "2/2 steps · 18 of 20 read · 2 cited");
  });

  describe("in Chinese", function () {
    const globals = globalThis as unknown as { Zotero?: unknown };
    let previousZotero: unknown;
    before(function () {
      previousZotero = globals.Zotero;
      globals.Zotero = { Prefs: { get: () => "zh-CN" }, locale: "zh-CN" };
      initI18n();
    });
    after(function () {
      if (previousZotero === undefined) delete globals.Zotero;
      else globals.Zotero = previousZotero;
      initI18n();
    });

    it("translates the in-depth and found terms", function () {
      for (const value of ["{count} read in depth", "{count} found"])
        assert.notEqual(t(value), value, value);
      seedWholeLibrary();
      const harness = track(mount(library));
      runOverLibrary(harness.view);
      assert.equal(harness.count(), "2/2 步 · 精读 5 · 检索到 13 · 引用 2");
    });
  });
});

describe("task progress history by question", function () {
  const views: TaskProgressView[] = [];
  afterEach(function () {
    for (const view of views.splice(0)) view.dispose();
    clearAllTaskProgress();
  });
  function track(harness: Harness): Harness {
    views.push(harness.view);
    return harness;
  }

  const REVIEW =
    "Write a review on path integration in the entorhinal cortex and its computational models";
  const GAZE = "Find papers that use gaze to study belief";

  /** Question 1 declares two steps, reads papers 1 and 2 and cites 2. */
  function askFirst() {
    beginTaskRun(KEY, { runId: "q1", turnIndex: 1, text: REVIEW });
    setTaskOutcomes(
      KEY,
      "q1",
      outcomeCheckpoint(
        [
          outcomeTask("read", {
            description: "Read the papers",
            effect: "read",
            status: "completed",
          }),
          outcomeTask("write", {
            description: "Write the review",
            status: "completed",
          }),
        ],
        "completed",
      ),
    );
    applyTaskPaperUpdate(
      KEY,
      ledgerDelta("c1", [
        [1, "read", "Grid cells integrate self-motion."],
        [2, "read", "Path integration drifts without landmarks."],
      ]),
      "q1",
    );
    completeTaskRun(KEY, {
      runId: "q1",
      quoteCitations: [quoteCitation("cite-1", 2)],
    });
  }

  /** Question 2 reads papers 2 and 3, with no steps. */
  function askSecond() {
    beginTaskRun(KEY, { runId: "q2", turnIndex: 2, text: GAZE });
    applyTaskPaperUpdate(
      KEY,
      ledgerDelta("c2", [
        [2, "read", "Gaze tracks the animal's belief."],
        [3, "read", "Saccades follow expected reward."],
      ]),
      "q2",
    );
    completeTaskRun(KEY, { runId: "q2" });
  }

  const sectionsOf = (harness: Harness) =>
    harness.drawer.findAllByClass("llm-task-progress-question-section");
  const headOf = (section: FakeElement) =>
    section.findByClass("llm-task-progress-question")!;
  const labelOf = (head: FakeElement) =>
    // The name and the words are two parts, so narrow drawers cut the words
    // and never the number.
    `${head.findByClass("llm-task-progress-question-name")!.textContent}${
      head.findByClass("llm-task-progress-question-words")!.textContent
    }`;
  const pillOf = (head: FakeElement) =>
    head.findByClass("llm-task-progress-pill") as FakeElement & {
      hidden: boolean;
    };
  const countsOf = (head: FakeElement) =>
    head.findByClass("llm-task-progress-question-counts")!.textContent;
  const currentHead = (harness: Harness) =>
    harness.drawer.findByClass("llm-task-progress-question-current");
  /** The current question's rows: the drawer's own list. */
  const currentItems = (harness: Harness) =>
    harness.drawer
      .findByClass("llm-task-progress-list")!
      .findAllByClass("llm-task-paper");
  const itemOf = (items: FakeElement[], itemId: number) =>
    items.find((item) => item.dataset.key === `1:${itemId}`)!;
  const detailsOf = (item: FakeElement) => {
    const summary = item.findByClass("llm-task-paper-summary")!;
    if (summary.getAttribute("aria-expanded") !== "true")
      summary.dispatchFakeEvent("click");
    return collectFakeText(item.findByClass("llm-task-paper-details"));
  };

  it("looks as it did with one question: no question header", function () {
    seedScope(5);
    const harness = track(mount());
    askFirst();
    harness.view.flush();
    harness.row.dispatchFakeEvent("click");
    assert.isNull(currentHead(harness));
    assert.isNull(harness.drawer.findByClass("llm-task-progress-history"));
    assert.isNull(harness.drawer.findByClass("llm-task-progress-question"));
    assert.isNull(harness.drawer.findByClass("llm-task-progress-papers-title"));
    assert.lengthOf(harness.items(), 5);
  });

  it("lists the questions newest first, the earlier one folded with its words, ending and counts", function () {
    seedScope(5);
    const harness = track(mount());
    askFirst();
    askSecond();
    harness.view.flush();
    assert.equal(
      harness.count(),
      "2 of 5 read",
      "the row still describes the latest question",
    );
    harness.row.dispatchFakeEvent("click");
    const current = currentHead(harness)!;
    assert.isOk(current, "the current question has a header");
    assert.notEqual(current.tagName, "button", "it is not a control");
    assert.equal(labelOf(current), `Question 2 · “${GAZE}”`);
    assert.equal(pillOf(current).textContent, "Completed");
    assert.equal(
      harness.drawer.findByClass("llm-task-progress-papers-title")!.textContent,
      "Papers (5)",
    );

    const [earlier, ...rest] = sectionsOf(harness);
    assert.lengthOf(rest, 0, "one earlier question");
    const head = headOf(earlier);
    assert.equal(head.tagName, "button");
    assert.equal(head.getAttribute("aria-expanded"), "false");
    assert.equal(
      labelOf(head),
      "Question 1 · “Write a review on path integration in the entorhinal…”",
    );
    assert.equal(pillOf(head).textContent, "Completed");
    assert.equal(pillOf(head).dataset.tone, "completed");
    assert.equal(countsOf(head), "2/2 steps · 2 papers");
    assert.lengthOf(
      earlier.findAllByClass("llm-task-paper"),
      0,
      "a folded question builds no rows",
    );
    assert.isNull(earlier.findByClass("llm-task-progress-steps"));

    // The current question's rows show its reads only.
    const items = currentItems(harness);
    assert.deepEqual(
      items.map((item) => item.dataset.state),
      ["listed", "read", "read", "listed", "listed"],
    );
    const shared = detailsOf(itemOf(items, 2));
    assert.include(shared, "Gaze tracks the animal's belief.");
    assert.notInclude(shared, "Path integration drifts");
    assert.notInclude(shared, "Question");
    assert.notInclude(shared, "Cited in answer");
  });

  it("unrolls an earlier question's own steps and papers, and folds it again", function () {
    seedScope(5);
    const harness = track(mount());
    askFirst();
    askSecond();
    harness.view.flush();
    harness.row.dispatchFakeEvent("click");
    const [earlier] = sectionsOf(harness);
    const head = headOf(earlier);
    head.dispatchFakeEvent("click");
    assert.equal(head.getAttribute("aria-expanded"), "true");
    const steps = earlier.findByClass("llm-task-progress-steps")!;
    assert.include(collectFakeText(steps), "Read the papers");
    assert.include(collectFakeText(steps), "Write the review");
    assert.equal(
      earlier.findByClass("llm-task-progress-papers-title")!.textContent,
      "Papers (2)",
    );
    const items = earlier.findAllByClass("llm-task-paper");
    assert.deepEqual(
      items.map((item) => [item.dataset.key, item.dataset.state]),
      [
        ["1:1", "read"],
        ["1:2", "cited"],
      ],
    );
    const remove = itemOf(items, 1).findByClass("llm-task-paper-remove") as any;
    assert.isTrue(
      remove.hidden,
      "an earlier question's paper is not removable",
    );
    const shared = detailsOf(itemOf(items, 2));
    assert.include(shared, "Path integration drifts without landmarks.");
    assert.include(shared, "Cited in answer");
    assert.notInclude(shared, "Gaze tracks");
    assert.notInclude(shared, "Question");
    assert.lengthOf(
      harness.items().filter((item) => item.dataset.key === "1:2"),
      2,
      "a paper both questions read is in both",
    );
    head.dispatchFakeEvent("click");
    assert.equal(head.getAttribute("aria-expanded"), "false");
    assert.lengthOf(earlier.findAllByClass("llm-task-paper"), 0);
    assert.isNull(earlier.findByClass("llm-task-progress-steps"));
  });

  it("keeps an unrolled question unrolled through a repaint and a new mount", function () {
    seedScope(5);
    const first = track(mount());
    askFirst();
    askSecond();
    first.view.flush();
    first.row.dispatchFakeEvent("click");
    headOf(sectionsOf(first)[0]).dispatchFakeEvent("click");
    applyTaskPaperUpdate(KEY, ledgerDelta("c3", [[4, "read", "More."]]), "q2");
    first.view.flush();
    let [earlier] = sectionsOf(first);
    assert.equal(headOf(earlier).getAttribute("aria-expanded"), "true");
    assert.lengthOf(earlier.findAllByClass("llm-task-paper"), 2);
    first.view.dispose();

    const again = track(mount());
    assert.isTrue(again.view.isOpen());
    [earlier] = sectionsOf(again);
    assert.equal(headOf(earlier).getAttribute("aria-expanded"), "true");
    assert.lengthOf(earlier.findAllByClass("llm-task-paper"), 2);
  });

  it("leaves out an earlier question that has no steps and no papers", function () {
    seedScope(5);
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "q1", turnIndex: 1, text: "Hello" });
    completeTaskRun(KEY, { runId: "q1" });
    askSecond();
    harness.view.flush();
    harness.row.dispatchFakeEvent("click");
    assert.isNull(currentHead(harness), "nothing to go back to: no history");
    assert.lengthOf(sectionsOf(harness), 0);
  });

  it("gives a built-in action its own section, titled with the action", function () {
    seedScope(5);
    const harness = track(mount());
    askFirst();
    beginTaskAction(KEY, {
      runId: "action-1",
      title: "Auto Tag",
      text: "tag the drift papers",
    });
    setTaskActionStep(KEY, "action-1", { step: "Tagging", index: 1, total: 1 });
    endTaskAction(KEY, "action-1", "completed", "Tagged 2 items");
    harness.view.flush();
    harness.row.dispatchFakeEvent("click");
    assert.equal(
      labelOf(currentHead(harness)!),
      "Auto Tag · “tag the drift papers”",
    );
    askSecond();
    harness.view.flush();
    const [action, question] = sectionsOf(harness);
    assert.equal(labelOf(headOf(action)), "Auto Tag · “tag the drift papers”");
    assert.equal(pillOf(headOf(action)).textContent, "Completed");
    assert.equal(countsOf(headOf(action)), "1/1 steps");
    assert.match(labelOf(headOf(question)), /^Question 1 · /);
    headOf(action).dispatchFakeEvent("click");
    assert.include(
      collectFakeText(action.findByClass("llm-task-progress-steps")),
      "Steps · Auto Tag",
    );
    assert.lengthOf(action.findAllByClass("llm-task-paper"), 0);
  });

  it("names an action by its title alone when no request was typed", function () {
    seedScope(5);
    const harness = track(mount());
    askFirst();
    beginTaskAction(KEY, { runId: "action-1", title: "Auto Tag" });
    endTaskAction(KEY, "action-1", "failed", "offline");
    harness.view.flush();
    harness.row.dispatchFakeEvent("click");
    assert.equal(labelOf(currentHead(harness)!), "Auto Tag");
    assert.equal(pillOf(currentHead(harness)!).textContent, "Failed");
  });

  describe("in Chinese", function () {
    const globals = globalThis as unknown as { Zotero?: unknown };
    let previousZotero: unknown;
    before(function () {
      previousZotero = globals.Zotero;
      globals.Zotero = { Prefs: { get: () => "zh-CN" }, locale: "zh-CN" };
      initI18n();
    });
    after(function () {
      if (previousZotero === undefined) delete globals.Zotero;
      else globals.Zotero = previousZotero;
      initI18n();
    });

    it("names each question once, in the reader's language", function () {
      for (const value of [
        "Papers ({count})",
        "{count} paper",
        "{count} papers",
      ])
        assert.notEqual(t(value), value, value);
      seedScope(5);
      const harness = track(mount());
      askFirst();
      askSecond();
      harness.view.flush();
      harness.row.dispatchFakeEvent("click");
      const head = headOf(sectionsOf(harness)[0]);
      assert.equal(
        labelOf(head),
        "第 1 个问题 · “Write a review on path integration in the entorhinal…”",
      );
      assert.equal(pillOf(head).textContent, "已完成");
      assert.equal(countsOf(head), "2/2 步 · 2 篇论文");
      assert.equal(labelOf(currentHead(harness)!), `第 2 个问题 · “${GAZE}”`);
      const text = collectFakeText(harness.drawer);
      assert.equal(
        text.split("第 1 个问题").length - 1,
        1,
        "the earlier question is named once",
      );
      assert.equal(
        harness.drawer.findByClass("llm-task-progress-papers-title")!
          .textContent,
        "论文（5）",
      );
    });
  });
});

describe("task progress curtain", function () {
  const views: TaskProgressView[] = [];
  afterEach(function () {
    for (const view of views.splice(0)) view.dispose();
    clearAllTaskProgress();
    resetTaskProgressDrawerHeight();
  });

  /** The card's collapsed height: the 38px row and its 1px borders. */
  const CARD = 40;
  /** The card's gap to the chat below, inside the curtain while it moves. */
  const GAP = 6;
  /** The drawer's content height when it is open. */
  const DRAWER = 300;

  const libraryInput = (
    contexts: { paperCount?: number; collectionCount?: number } = {},
    extra: Partial<TaskProgressViewInput> = {},
  ): TaskProgressViewInput => ({
    conversationKey: KEY,
    recordsReads: true,
    composerReady: true,
    visibility: {
      conversationKind: "global",
      isWebChat: false,
      isNoteSession: false,
      collectionCount: contexts.collectionCount || 0,
      tagCount: 0,
      paperCount: contexts.paperCount || 0,
    },
    ...extra,
  });

  /**
   * The row as `buildUI` places it: in its card, in the curtain, first in
   * the chat shell. Heights are faked: the card is 40px (more with the drawer
   * open) unless frozen; the curtain is its inline height, or the card and
   * its gap.
   */
  function mountCurtain(
    input: TaskProgressViewInput = libraryInput(),
    options: {
      curtainMs?: number;
      layout?: false;
      onVisibilityChange?: (visible: boolean) => void;
    } = {},
  ) {
    const timers = new Map<number, { callback: () => void; ms: number }>();
    let handle = 0;
    const curtain = createTaskProgressCurtain(
      fakeDocument,
    ) as unknown as FakeElement;
    const card = curtain.findByClass("llm-task-progress-card")!;
    const row = card.findByClass("llm-task-progress")!;
    const drawer = card.findByClass("llm-task-progress-drawer")!;
    const shell = new FakeElement("div");
    shell.className = "llm-chat-shell";
    const messages = new FakeElement("div");
    messages.className = "llm-messages";
    shell.append(curtain, messages);
    const panel = new FakeElement("div");
    panel.className = "llm-panel";
    panel.append(shell);
    const observed: Array<{ target: unknown; onResize: () => void }> = [];
    let chatResized = 0;
    const cardHeight = () => {
      const inline = parseFloat(String(card.style.height || ""));
      if (Number.isFinite(inline)) return inline;
      return CARD + ((drawer as any).hidden === false ? DRAWER : 0);
    };
    (card as any).getBoundingClientRect = () => ({ height: cardHeight() });
    (curtain as any).getBoundingClientRect = () => {
      const inline = parseFloat(String(curtain.style.height || ""));
      return { height: Number.isFinite(inline) ? inline : cardHeight() + GAP };
    };
    (drawer as any).getBoundingClientRect = () => ({
      height: (drawer as any).hidden === false ? DRAWER : 0,
    });
    const layout: TaskProgressLayout = {
      motionMs: () => 0,
      curtainMs: () => options.curtainMs ?? 300,
      chatStripPx: () => 96,
      observeResize: (target, onResize) => {
        const entry = { target, onResize };
        observed.push(entry);
        return () => observed.splice(observed.indexOf(entry), 1);
      },
      onChatResized: () => {
        chatResized += 1;
      },
    };
    const view = mountTaskProgressView({
      doc: fakeDocument,
      row: row as unknown as HTMLButtonElement,
      drawer: drawer as unknown as HTMLElement,
      shell: shell as unknown as HTMLElement,
      chatBox: messages as unknown as HTMLElement,
      keyTarget: panel as unknown as HTMLElement,
      deps: {
        setTimeout: (callback, ms) => {
          timers.set(++handle, { callback, ms });
          return handle;
        },
        clearTimeout: (id) => timers.delete(id as number),
        now: () => 0,
        layout: options.layout === false ? undefined : layout,
        onVisibilityChange: options.onVisibilityChange,
      },
    });
    views.push(view);
    view.setInput(input);
    return {
      view,
      curtain,
      card,
      row,
      drawer,
      shell,
      panel,
      timers,
      chatResized: () => chatResized,
      /** The curtain's own resize observer, as the browser would fire it. */
      resizeCurtain: () =>
        observed
          .filter((entry) => entry.target === curtain)
          .forEach((entry) => entry.onResize()),
      /** The context bar now holds this many papers and folders. */
      context: (
        contexts: { paperCount?: number; collectionCount?: number },
        extra: Partial<TaskProgressViewInput> = {},
      ) => view.setInput(libraryInput(contexts, extra)),
      settleByTimer: () => {
        for (const [id, timer] of Array.from(timers)) {
          if (timer.ms < 300) continue;
          timers.delete(id);
          timer.callback();
        }
      },
      state: () => curtain.dataset.curtain,
    };
  }

  const hidden = (node: FakeElement) => (node as any).hidden === true;
  /** The inline height a node carries; "" when none was ever written. */
  const inline = (node: FakeElement) => String(node.style.height || "");
  const curtainAttr = "data-task-progress-curtain";

  it("shows no row in a library chat with nothing added", function () {
    const tp = mountCurtain();
    assert.isFalse(tp.view.isVisible());
    assert.equal(tp.state(), "closed");
    assert.isTrue(hidden(tp.curtain), "the curtain takes no room");
    assert.isTrue(hidden(tp.card));
    assert.isTrue(hidden(tp.row));
    assert.isFalse(tp.shell.classList.contains("llm-task-progress-present"));
    assert.isNull(tp.shell.getAttribute(curtainAttr));
  });

  it("lowers the row from under the header when a paper is added, and raises it when the last goes", function () {
    const tp = mountCurtain();
    // What the shell says while the row moves: its gap under the header
    // follows "opening" and "open" only, never the pose a lowering starts
    // from.
    const shellStates: Array<string | null> = [];
    const setAttribute = tp.shell.setAttribute.bind(tp.shell);
    tp.shell.setAttribute = (name: string, value: string) => {
      if (name === curtainAttr) shellStates.push(value);
      setAttribute(name, value);
    };
    tp.context({ paperCount: 1 });
    assert.deepEqual(shellStates, ["closed", "opening"]);
    assert.isTrue(tp.view.isVisible());
    assert.equal(tp.state(), "opening");
    assert.isFalse(hidden(tp.curtain));
    assert.isFalse(hidden(tp.card));
    assert.isFalse(hidden(tp.row));
    assert.equal(
      inline(tp.curtain),
      `${CARD + GAP}px`,
      "toward the card and its gap",
    );
    assert.isTrue(tp.shell.classList.contains("llm-task-progress-present"));
    assert.equal(tp.shell.getAttribute(curtainAttr), "opening");
    assert.isTrue(
      Array.from(tp.timers.values()).some((timer) => timer.ms === 380),
      "a fallback settles a missed transitionend",
    );
    // Only the curtain's own height ends the motion.
    tp.curtain.dispatchFakeEvent("transitionend", {
      target: tp.card,
      propertyName: "transform",
    } as never);
    assert.equal(tp.state(), "opening");
    tp.curtain.dispatchFakeEvent("transitionend", {
      target: tp.curtain,
      propertyName: "height",
    } as never);
    assert.equal(tp.state(), "open");
    assert.equal(inline(tp.curtain), "", "released to the card");
    assert.equal(tp.shell.getAttribute(curtainAttr), "open");

    tp.context({ paperCount: 0 });
    assert.isFalse(tp.view.isVisible());
    assert.equal(tp.state(), "closing");
    assert.equal(inline(tp.curtain), "0px");
    assert.equal(inline(tp.card), `${CARD}px`, "the card moves rigid");
    assert.isFalse(hidden(tp.row), "the row stays drawn while it rises");
    assert.equal(tp.shell.getAttribute(curtainAttr), "closing");
    assert.isTrue(tp.shell.classList.contains("llm-task-progress-present"));
    tp.curtain.dispatchFakeEvent("transitionend", {
      target: tp.curtain,
      propertyName: "height",
    } as never);
    assert.equal(tp.state(), "closed");
    assert.isTrue(hidden(tp.curtain));
    assert.isTrue(hidden(tp.card));
    assert.isTrue(hidden(tp.row));
    assert.equal(inline(tp.curtain), "");
    assert.equal(inline(tp.card), "");
    assert.isFalse(tp.shell.classList.contains("llm-task-progress-present"));
    assert.isNull(tp.shell.getAttribute(curtainAttr));
  });

  it("reverses mid-way, and settles where the last change points", function () {
    const tp = mountCurtain();
    tp.context({ paperCount: 1 });
    tp.context({ paperCount: 0 });
    assert.equal(tp.state(), "closing");
    assert.equal(inline(tp.curtain), "0px");
    tp.context({ paperCount: 1 });
    assert.equal(tp.state(), "opening");
    assert.equal(inline(tp.curtain), `${CARD + GAP}px`);
    tp.settleByTimer();
    assert.equal(tp.state(), "open");
    assert.isFalse(hidden(tp.row));
    assert.equal(inline(tp.curtain), "");

    tp.context({ paperCount: 0 });
    tp.context({ paperCount: 1 });
    tp.context({ paperCount: 0 });
    assert.equal(tp.state(), "closing");
    tp.settleByTimer();
    assert.equal(tp.state(), "closed");
    assert.isTrue(hidden(tp.row));
    assert.equal(inline(tp.card), "");
    assert.isFalse(tp.shell.classList.contains("llm-task-progress-present"));
  });

  it("lets a motion run through repaints that change nothing it shows", function () {
    const tp = mountCurtain();
    beginTaskRun(KEY, { runId: "run-a" });
    tp.view.flush();
    tp.context({ paperCount: 1 });
    assert.equal(tp.state(), "opening");
    applyTaskPaperUpdate(KEY, ledgerDelta("c1", [[1, "read"]]), "run-a");
    tp.view.flush();
    tp.context({ paperCount: 2 });
    assert.equal(tp.state(), "opening", "still lowering");
    assert.equal(inline(tp.curtain), `${CARD + GAP}px`);
    tp.settleByTimer();
    tp.context({ paperCount: 0 });
    assert.equal(tp.state(), "closing");
    applyTaskPaperUpdate(KEY, ledgerDelta("c2", [[2, "read"]]), "run-a");
    tp.view.flush();
    assert.equal(tp.state(), "closing", "still rising");
    assert.isFalse(hidden(tp.row));
  });

  it("puts the row in its state at once on mount and on a conversation switch, even mid-way", function () {
    const shown = mountCurtain(libraryInput({ paperCount: 1 }));
    assert.equal(shown.state(), "open", "a mount shows it as it is");
    assert.isFalse(hidden(shown.row));
    assert.equal(inline(shown.curtain), "");
    assert.equal(shown.shell.getAttribute(curtainAttr), "open");

    shown.view.setInput(libraryInput({}, { conversationKey: KEY + 1 }));
    assert.equal(shown.state(), "closed", "another conversation, no motion");
    assert.isTrue(hidden(shown.row));
    shown.view.setInput(libraryInput({ paperCount: 1 }));
    assert.equal(shown.state(), "open");

    shown.context({ paperCount: 0 });
    assert.equal(shown.state(), "closing");
    shown.view.setInput(
      libraryInput({ collectionCount: 1 }, { conversationKey: KEY + 1 }),
    );
    assert.equal(shown.state(), "open", "the switch lands on its state");
    assert.equal(inline(shown.curtain), "");
    assert.equal(inline(shown.card), "");
    assert.equal(shown.shell.getAttribute(curtainAttr), "open");
    shown.view.setInput(libraryInput({ paperCount: 1 }));
    shown.context({ paperCount: 0 });
    shown.view.setInput(libraryInput({}, { conversationKey: KEY + 1 }));
    assert.equal(shown.state(), "closed");
    assert.isTrue(hidden(shown.curtain));
    assert.isFalse(shown.shell.classList.contains("llm-task-progress-present"));
  });

  it("puts the row in its state at once while the context bar is set up from history", function () {
    const tp = mountCurtain(libraryInput({}, { composerReady: false }));
    tp.context({ paperCount: 1 });
    assert.equal(tp.state(), "open");
    assert.equal(tp.shell.getAttribute(curtainAttr), "open");
  });

  it("lowers the row for a live run's steps with nothing added, never for a run without steps", function () {
    const tp = mountCurtain();
    beginTaskRun(KEY, { runId: "run-a" });
    tp.view.flush();
    assert.equal(tp.state(), "closed", "a run with no steps shows nothing");
    setTaskOutcomes(
      KEY,
      "run-a",
      outcomeCheckpoint([outcomeTask("read", { effect: "read" })]),
    );
    tp.view.flush();
    assert.equal(tp.state(), "opening");
    tp.settleByTimer();
    completeTaskRun(KEY, { runId: "run-a" });
    tp.view.flush();
    assert.equal(tp.state(), "open", "and it stays once the run is done");
  });

  it("shows steps rebuilt from history at once", function () {
    const tp = mountCurtain();
    hydrateTaskProgress(KEY, {
      runs: [],
      latestTurn: 1,
      settled: "completed",
      planSeen: true,
      checklist: null,
    });
    tp.view.flush();
    assert.equal(tp.state(), "open");
    assert.isFalse(hidden(tp.row));
  });

  it("keeps the row when the last context goes while a run's steps are there", function () {
    const tp = mountCurtain(libraryInput({ paperCount: 1 }));
    beginTaskAction(KEY, { runId: "action-1", title: "Auto Tag" });
    tp.view.flush();
    tp.context({ paperCount: 0 });
    assert.equal(tp.state(), "open");
    assert.isFalse(hidden(tp.row));
    assert.equal(tp.shell.getAttribute(curtainAttr), "open");
  });

  it("settles at once when motion is reduced, or without a window", function () {
    for (const options of [{ curtainMs: 0 }, { layout: false as const }]) {
      const tp = mountCurtain(libraryInput(), options);
      tp.context({ paperCount: 1 });
      assert.equal(tp.state(), "open", JSON.stringify(options));
      assert.isFalse(hidden(tp.row));
      assert.equal(inline(tp.curtain), "");
      tp.context({ paperCount: 0 });
      assert.equal(tp.state(), "closed", JSON.stringify(options));
      assert.isTrue(hidden(tp.row));
      assert.isNull(tp.shell.getAttribute(curtainAttr));
    }
  });

  it("raises an open drawer with the row, and rolls it up once the row is gone", function () {
    seedScope(5);
    const tp = mountCurtain(libraryInput({ collectionCount: 1 }));
    tp.row.dispatchFakeEvent("click");
    assert.isTrue(tp.view.isOpen());
    tp.context({});
    assert.equal(tp.state(), "closing");
    assert.isTrue(tp.view.isOpen(), "the drawer rises inside the card");
    assert.equal(inline(tp.card), `${CARD + DRAWER}px`);
    assert.equal(tp.drawer.dataset.state, "open");
    tp.settleByTimer();
    assert.equal(tp.state(), "closed");
    assert.isFalse(tp.view.isOpen());
    assert.equal(tp.drawer.dataset.state, "closed");
    assert.isTrue(hidden(tp.drawer));
    assert.equal(tp.row.getAttribute("aria-expanded"), "false");
  });

  it("finishes lowering at once when the drawer is opened mid-way", function () {
    seedScope(5);
    const tp = mountCurtain();
    tp.context({ collectionCount: 1 });
    assert.equal(tp.state(), "opening");
    tp.row.dispatchFakeEvent("click");
    assert.equal(tp.state(), "open");
    assert.equal(inline(tp.curtain), "");
    assert.isTrue(tp.view.isOpen());
  });

  it("keeps the chat's place on every frame the row moves", function () {
    const tp = mountCurtain();
    tp.resizeCurtain();
    assert.equal(tp.chatResized(), 0, "nothing at rest");
    tp.context({ paperCount: 1 });
    tp.resizeCurtain();
    tp.resizeCurtain();
    assert.equal(tp.chatResized(), 2);
    tp.settleByTimer();
    tp.resizeCurtain();
    assert.equal(tp.chatResized(), 2, "nothing once it settled");
    tp.context({ paperCount: 0 });
    tp.resizeCurtain();
    assert.equal(tp.chatResized(), 3);
  });

  describe("the user's choice", function () {
    const chosen = (
      userChoice: "shown" | "hidden" | undefined,
      contexts: { paperCount?: number; collectionCount?: number } = {},
    ): TaskProgressViewInput => {
      const input = libraryInput(contexts);
      return { ...input, visibility: { ...input.visibility, userChoice } };
    };

    it("lowers the row the user asked for in an empty Library chat, with no record, and lists nothing", function () {
      const tp = mountCurtain();
      assert.isNull(getTaskProgress(KEY), "no record yet");
      tp.view.setInput(chosen("shown"));
      assert.isTrue(tp.view.isVisible());
      assert.equal(tp.state(), "opening", "the user's click moves the row");
      tp.settleByTimer();
      assert.equal(tp.state(), "open");
      assert.isFalse(hidden(tp.row));
      tp.row.dispatchFakeEvent("click");
      assert.isTrue(tp.view.isOpen(), "the drawer opens");
      assert.lengthOf(tp.drawer.findAllByClass("llm-task-paper"), 0);
      assert.isTrue(
        hidden(tp.drawer.findByClass("llm-task-progress-steps")!),
        "no steps",
      );
      assert.equal(tp.view.renderedRowCount(), 0);
    });

    it("raises a row the automatic rule showed when the user hides it", function () {
      const tp = mountCurtain(libraryInput({ collectionCount: 1 }));
      assert.equal(tp.state(), "open");
      tp.view.setInput(chosen("hidden", { collectionCount: 1 }));
      assert.isFalse(tp.view.isVisible());
      assert.equal(tp.state(), "closing");
      tp.settleByTimer();
      assert.equal(tp.state(), "closed");
      assert.isTrue(hidden(tp.row));
    });

    it("keeps a row the user hid when a run reads a paper in depth or declares its steps", function () {
      const tp = mountCurtain(chosen("hidden"));
      beginTaskRun(KEY, { runId: "run-a" });
      applyTaskPaperUpdate(
        KEY,
        {
          version: 1,
          callId: "read-1",
          runId: "run-a",
          toolName: "paper_read",
          papers: [
            {
              key: "1:1",
              libraryID: 1,
              itemId: 1,
              title: "Paper 1",
              state: "read",
            },
          ],
          reads: [
            {
              key: "1:1",
              callId: "read-1",
              toolName: "paper_read",
              granularity: "full",
              method: "full",
            },
          ],
        },
        "run-a",
      );
      tp.view.flush();
      assert.isTrue(taskReadInDepth(getTaskProgress(KEY)), "read in depth");
      assert.isFalse(tp.view.isVisible());
      assert.equal(tp.state(), "closed");
      beginTaskAction(KEY, { runId: "action-1", title: "Auto Tag" });
      tp.view.flush();
      assert.isTrue(getTaskProgress(KEY)!.planSeen, "the run had steps");
      assert.isFalse(tp.view.isVisible());
      assert.equal(tp.state(), "closed");
      assert.isTrue(hidden(tp.row));
      // Without the choice the same record shows the row.
      tp.view.setInput(chosen(undefined));
      assert.isTrue(tp.view.isVisible());
    });

    it("keeps a row the user showed when the last context goes", function () {
      const tp = mountCurtain(chosen("shown", { paperCount: 1 }));
      tp.view.setInput(chosen("shown"));
      assert.equal(tp.state(), "open");
      assert.isTrue(tp.view.isVisible());
    });

    it("says when the row comes and goes, once per change", function () {
      const seen: boolean[] = [];
      const tp = mountCurtain(libraryInput(), {
        onVisibilityChange: (visible) => seen.push(visible),
      });
      assert.deepEqual(seen, [false], "the first paint");
      tp.view.flush();
      assert.deepEqual(seen, [false], "a repaint that changes nothing");
      tp.context({ paperCount: 1 });
      tp.context({ paperCount: 2 });
      assert.deepEqual(seen, [false, true]);
      // A store change alone, with no new input, shows it too.
      tp.view.setInput(chosen(undefined));
      assert.deepEqual(seen, [false, true, false]);
      beginTaskAction(KEY, { runId: "action-1", title: "Auto Tag" });
      tp.view.flush();
      assert.deepEqual(seen, [false, true, false, true]);
    });
  });
});
