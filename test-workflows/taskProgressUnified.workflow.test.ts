/**
 * One task-progress UI: a built-in action and Codex's own plan show in the
 * Task progress row and its Steps block (no in-chat "Working" card, no
 * checklist trace row); a stored conversation reopened after a restart gets
 * its counts, paper states and steps back; deleting it clears the record.
 */
import { assert } from "chai";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";
import { findCurrentTaskProgressSteps } from "../src/modules/contextPanel/taskProgress/view";
import { executionCheckpointEvent } from "../src/agent/execution/checkpointEvents";
import type { ExecutionCheckpoint } from "../src/agent/types";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const TITLES = [
  "Representational drift in hippocampal CA1",
  "Synaptic turnover predicts place field drift",
  "Drift scales with experience, not time",
  "Homeostatic control of drifting assemblies",
];

describe("workflow: task progress unified", function () {
  this.timeout(120000);
  const prefs: Array<[string, unknown]> = [
    ["extensions.zotero.llmforzotero.enableAgentMode", true],
    ["extensions.zotero.llmforzotero.lastUsedRuntimeMode", "agent"],
  ];
  const saved = new Map<string, unknown>();
  let api: WorkflowTestApi;
  let win: any;
  let libraryID: number;
  let collection: Zotero.Collection;
  const fixtures: WorkflowTestFixture[] = [];
  const shots: string[] = [];

  async function until(check: () => boolean, message: string | (() => string)) {
    const deadline = Date.now() + 15000;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(40);
    assert.isTrue(check(), typeof message === "function" ? message() : message);
  }

  function rootOf(panelId: string): HTMLElement {
    return win.document.querySelector(
      `[data-workflow-panel-id="${panelId}"]`,
    ) as HTMLElement;
  }

  function view(panelId: string) {
    const root = rootOf(panelId);
    return {
      root,
      row: root.querySelector("#llm-task-progress") as HTMLButtonElement,
      count: () =>
        root.querySelector(".llm-task-progress-count")?.textContent || "",
      drawer: root.querySelector("#llm-task-progress-drawer") as HTMLElement,
      /** The current question's visible Steps block, re-queried each read. */
      get steps() {
        return findCurrentTaskProgressSteps(root);
      },
      head: () =>
        root.querySelector(".llm-task-progress-head")?.textContent || "",
      box: root.querySelector("#llm-chat-box") as HTMLElement,
      items: () =>
        Array.from(root.querySelectorAll(".llm-task-paper")) as HTMLElement[],
    };
  }

  /** Bring the synthetic panel on screen, as a sidebar-sized column. */
  function showOnScreen(panelId: string): () => void {
    const host = rootOf(panelId).closest(
      "[data-llm-workflow-test]",
    ) as HTMLElement;
    const previous = host.getAttribute("style");
    host.style.left = "0";
    host.style.width = "420px";
    host.style.height = "760px";
    host.style.zIndex = "99999";
    host.style.background = "var(--material-background, #fff)";
    return () => {
      if (previous === null) host.removeAttribute("style");
      else host.setAttribute("style", previous);
    };
  }

  async function capture(panelId: string, filename: string) {
    const rect = rootOf(panelId).getBoundingClientRect();
    const canvas = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    );
    const scale = win.devicePixelRatio || 1;
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);
    canvas.width = width * scale;
    canvas.height = height * scale;
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    context.drawWindow(win, rect.left, rect.top, width, height, "#ffffff");
    const binary = win.atob(canvas.toDataURL("image/png").split(",")[1]);
    const path = `${Zotero.DataDirectory.dir}/${filename}`;
    await win.IOUtils.write(
      path,
      Uint8Array.from(binary, (char: any) => char.charCodeAt(0)),
    );
    shots.push(path);
  }

  function key(index: number): string {
    return `${libraryID}:${fixtures[index].parentItemId}`;
  }

  function delta(
    callId: string,
    runId: string,
    entries: Array<[number, "matched" | "skimmed" | "read"]>,
  ) {
    return {
      version: 1 as const,
      callId,
      runId,
      toolName: "library_retrieve",
      papers: entries.map(([index, state]) => ({
        key: key(index),
        libraryID,
        itemId: fixtures[index].parentItemId,
        title: TITLES[index],
        text: "pdf_text" as const,
        state,
      })),
      reads: entries.map(([index, state]) => ({
        key: key(index),
        callId,
        toolName: "library_retrieve",
        granularity:
          state === "read" ? ("passage" as const) : ("metadata" as const),
        method: "bm25",
        ...(state === "read"
          ? { label: "Results", snippet: `${TITLES[index]} — key passage.` }
          : {}),
      })),
    };
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    win = Zotero.getMainWindow();
    for (const [name, value] of prefs) {
      saved.set(name, Zotero.Prefs.get(name, true));
      Zotero.Prefs.set(name, value as never, true);
    }
    libraryID = Zotero.Libraries.userLibraryID;
    collection = new Zotero.Collection();
    (collection as { libraryID: number }).libraryID = libraryID;
    collection.name = `Drift unified ${Date.now()}`;
    await collection.saveTx();
    for (const title of TITLES) {
      const fixture = await api.createPaperWithPdfFixture({
        title,
        pdfTitle: title,
        pages: [`${title} evidence.`],
      });
      fixtures.push(fixture);
      const item = Zotero.Items.get(fixture.parentItemId);
      item.setCollections([collection.id]);
      await item.saveTx();
    }
  });

  after(async function () {
    await api.reset();
    for (const fixture of fixtures) await api.cleanupFixture(fixture);
    await collection?.eraseTx().catch(() => undefined);
    for (const [name, value] of saved) {
      if (value === undefined) Zotero.Prefs.clear(name, true);
      else Zotero.Prefs.set(name, value as never, true);
    }
    Zotero.debug(`TASK_PROGRESS_M5_SCREENSHOTS ${JSON.stringify(shots)}`, 1);
  });

  it("shows a slash action's steps in the row of a one-paper chat, with no card", async function () {
    const panel = await api.renderPanelForItem(fixtures[0].parentItemId);
    const restore = showOnScreen(panel.panelId);
    try {
      const tp = () => view(panel.panelId);
      api.flushTaskProgress();
      assert.isTrue(tp().row.hidden, "a one-paper chat has no row at rest");

      const action = await api.startTaskProgressAction({
        panelId: panel.panelId,
        actionName: "auto_tag",
      });
      action.step("Reading the paper", 1, 3);
      action.summary("Reading the paper", "Read 1 paper");
      action.step("Proposing tags", 2, 3);
      await until(
        () => {
          api.flushTaskProgress();
          return (
            !tp().row.hidden && tp().count() === "1/3 steps · Proposing tags"
          );
        },
        () =>
          `the row shows the action: ${JSON.stringify({ hidden: tp().row.hidden, count: tp().count() })}`,
      );
      assert.equal(tp().row.dataset.state, "working");
      assert.equal(action.chatCards(), 0, "no Working card in the chat");
      assert.lengthOf(
        win.document.querySelectorAll(".llm-action-progress-card"),
        0,
      );
      tp().row.click();
      assert.isFalse(tp().drawer.hidden);
      await until(
        () => {
          api.flushTaskProgress();
          return tp().items().length === 1;
        },
        () => `the one paper in scope lists: ${tp().head()}`,
      );
      assert.notInclude(tp().head(), "Preparing");
      assert.isOk(tp().steps, "the Steps block shows the action");
      const stepsText = tp().steps?.textContent || "";
      assert.include(stepsText, "Auto Tag");
      assert.include(stepsText, "Reading the paper");
      assert.include(stepsText, "Proposing tags");
      await until(
        () => tp().drawer.dataset.state === "open",
        "the drawer settles open",
      );
      await capture(panel.panelId, "tp-m5-slash-action.png");
      tp().row.click();

      await action.finish({ ok: true, output: { tagged: 2 } });
      api.flushTaskProgress();
      assert.equal(tp().row.dataset.state, "completed");
      assert.equal(tp().count(), "3/3 steps · Tagged 2 items");
      assert.isFalse(tp().row.hidden, "the row stays after the action");
      assert.isOk(
        tp().box.querySelector(".llm-action-inline-card-status"),
        "the completion card still reports the result",
      );

      const failing = await api.startTaskProgressAction({
        panelId: panel.panelId,
        actionName: "auto_tag",
      });
      failing.step("Reading the paper", 1, 2);
      await failing.finish({ ok: false, error: "offline" });
      api.flushTaskProgress();
      assert.equal(tp().row.dataset.state, "failed");
      assert.equal(tp().count(), "0/2 steps · Auto Tag failed: offline");

      const stopped = await api.startTaskProgressAction({
        panelId: panel.panelId,
        actionName: "auto_tag",
      });
      stopped.step("Reading the paper", 1, 2);
      await stopped.stop();
      api.flushTaskProgress();
      assert.equal(tp().row.dataset.state, "cancelled");
      assert.equal(action.chatCards(), 0);
    } finally {
      restore();
    }
  });

  it("shows Codex's own checklist as the Steps, never as a trace row, and restores it", async function () {
    const panel = await api.renderPanelForItem(fixtures[1].parentItemId);
    const restore = showOnScreen(panel.panelId);
    try {
      const tp = () => view(panel.panelId);
      const codex = await api.startCodexTaskProgressReplay({
        panelId: panel.panelId,
        user: { text: "Compare the methods of the drift papers" },
      });
      codex.planUpdated([
        { content: "Inspect the scope", status: "completed" },
        { content: "Read the methods sections", status: "in_progress" },
        { content: "Compare the results", status: "pending" },
      ]);
      codex.read("mcp-1", delta("mcp-1", codex.runId, [[1, "read"]]));
      await until(
        () => {
          api.flushTaskProgress();
          return tp().count().startsWith("1/3 steps · ");
        },
        () => `the row counts Codex's steps: ${tp().count()}`,
      );
      assert.isFalse(tp().row.hidden, "a Codex plan shows the row");
      assert.notInclude(
        tp().box.textContent || "",
        "Compare the results",
        "no checklist row in the chat trace",
      );
      tp().row.click();
      const lines = Array.from(
        tp().steps!.querySelectorAll(".llm-plan-task"),
      ) as HTMLElement[];
      assert.deepEqual(
        lines.map((line) => line.className.replace("llm-plan-task ", "")),
        [
          "llm-plan-task-completed",
          "llm-plan-task-in_progress",
          "llm-plan-task-pending",
        ],
      );
      await capture(panel.panelId, "tp-m5-codex-plan-steps.png");
      tp().row.click();
      codex.answer("The methods differ in imaging windows.");
      await codex.finish();
      await until(() => {
        api.flushTaskProgress();
        return tp().row.dataset.state === "completed";
      }, "the finished Codex plan shows as completed");

      // Reopened after a restart: the steps come back from the stored run,
      // and the trace still renders no checklist row.
      await api.reopenTaskProgressConversation({ panelId: panel.panelId });
      const snapshot = api.getTaskProgressSnapshot(codex.conversationKey)!;
      assert.isTrue(snapshot.hydrated);
      assert.equal(snapshot.checklist?.source, "codex");
      assert.deepEqual(
        snapshot.checklist?.steps.map((step) => step.status),
        ["completed", "in_progress", "pending"],
      );
      assert.equal(snapshot.paperStates[key(1)], "read");
      await until(
        () => (tp().box.textContent || "").includes("imaging windows"),
        "the stored answer renders again",
      );
      assert.notInclude(tp().box.textContent || "", "Compare the results");
      assert.isFalse(tp().row.hidden);
      assert.isTrue(tp().count().startsWith("1/3 steps · "), tp().count());
    } finally {
      restore();
    }
  });

  it("shows Claude Code's steps in the Steps block, from Claude, and restores them", async function () {
    const panel = await api.renderPanelForItem(fixtures[2].parentItemId);
    const restore = showOnScreen(panel.panelId);
    const steps = (statuses: string[]) => ({
      type: "codex_progress" as const,
      itemId: "codex-plan-checklist",
      text: "",
      runtime: "claude" as const,
      steps: ["Screen the papers", "Skim the relevant", "Write the review"].map(
        (content, index) => ({ content, status: statuses[index] }),
      ),
    });
    try {
      const tp = () => view(panel.panelId);
      // Live: Claude Code's step list moves through the agent turn's own
      // event handler, one snapshot per change.
      const handle = await api.startTaskProgressReplay({
        panelId: panel.panelId,
        historyTurns: 0,
        user: {},
      });
      await handle.emit(steps(["in_progress", "pending", "pending"]));
      await handle.emit(steps(["completed", "in_progress", "pending"]));
      await until(
        () => {
          api.flushTaskProgress();
          return tp().count().startsWith("1/3 steps");
        },
        () => `the row counts Claude's steps: ${tp().count()}`,
      );
      assert.equal(
        api.getTaskProgressSnapshot(handle.conversationKey)?.checklist?.source,
        "claude",
      );
      assert.notInclude(
        tp().box.textContent || "",
        "Write the review",
        "no checklist row in the chat trace",
      );
      handle.finish();
      await api.clickPanelDelete(panel.panelId).catch(() => undefined);

      // Stored: the same snapshots come back after a restart.
      const second = await api.renderPanelForItem(fixtures[3].parentItemId);
      const runId = `tp-claude-steps-${Date.now()}`;
      const seeded = await api.seedTaskProgressConversation({
        panelId: second.panelId,
        turns: [
          {
            runId,
            user: { text: "Review the drift papers" },
            answer: "Reviewed.",
            events: [
              steps(["in_progress", "pending", "pending"]),
              steps(["completed", "completed", "in_progress"]),
            ],
          },
        ],
      });
      await api.reopenTaskProgressConversation({ panelId: second.panelId });
      await until(() => {
        api.flushTaskProgress();
        return Boolean(
          api.getTaskProgressSnapshot(seeded.conversationKey)?.hydrated,
        );
      }, "the conversation is rebuilt");
      const snapshot = api.getTaskProgressSnapshot(seeded.conversationKey)!;
      assert.equal(snapshot.checklist?.source, "claude");
      assert.deepEqual(
        snapshot.checklist?.steps.map((step) => step.status),
        ["completed", "completed", "in_progress"],
      );
      // Later scenarios render this paper as a fresh chat.
      await api.clickPanelDelete(second.panelId);
    } finally {
      restore();
    }
  });

  it("lists the context bar's papers before any question, and removes them from both", async function () {
    const panel = await api.renderPanelForItem(fixtures[3].parentItemId);
    const restore = showOnScreen(panel.panelId);
    try {
      const tp = () => view(panel.panelId);
      const composer = () =>
        api.readTaskProgressComposerContexts({ panelId: panel.panelId });
      api.flushTaskProgress();
      assert.isTrue(tp().row.hidden, "one paper: no card");

      // A folder plus one paper added on its own; nothing sent yet.
      await api.setTaskProgressComposerContexts({
        panelId: panel.panelId,
        paperContexts: [
          {
            libraryID,
            itemId: fixtures[1].parentItemId,
            contextItemId: fixtures[1].pdfAttachmentId,
            title: TITLES[1],
          },
        ],
        collectionContexts: [
          { collectionId: collection.id, name: collection.name, libraryID },
        ],
      });
      await until(
        () => {
          api.flushTaskProgress();
          return !tp().row.hidden && tp().count() === "4 papers in scope";
        },
        () =>
          `the card lists the context bar before a question: ${JSON.stringify({
            hidden: tp().row.hidden,
            count: tp().count(),
          })}`,
      );
      tp().row.click();
      await until(() => {
        api.flushTaskProgress();
        return tp().items().length === 4;
      }, "the four papers list");
      const removeFor = (index: number) =>
        tp()
          .items()
          .find(
            (item) => item.dataset.itemId === `${fixtures[index].parentItemId}`,
          )
          ?.querySelector(".llm-task-paper-remove") as HTMLButtonElement;
      assert.isTrue(removeFor(3).hidden, "the chat's own paper stays");
      assert.isFalse(removeFor(1).hidden);

      // Remove the paper added on its own (it also came with the folder).
      removeFor(1).click();
      await until(
        () => {
          api.flushTaskProgress();
          return tp().items().length === 3;
        },
        () => `the removed paper leaves the list (${tp().items().length})`,
      );
      let bar = await composer();
      assert.notInclude(bar.paperItemIds, fixtures[1].parentItemId);
      assert.deepEqual(bar.collections[0].excludedItemIds, [
        fixtures[1].parentItemId,
      ]);
      assert.include(bar.chipLabels[0], "1 excluded");

      // Remove a paper that came only with the folder.
      removeFor(0).click();
      await until(() => {
        api.flushTaskProgress();
        return tp().items().length === 2;
      }, "the folder's paper leaves the list");
      bar = await composer();
      assert.sameMembers(bar.collections[0].excludedItemIds, [
        fixtures[1].parentItemId,
        fixtures[0].parentItemId,
      ]);
      assert.include(bar.chipLabels[0], "2 excluded");
      await until(
        () => tp().drawer.dataset.state === "open",
        "the card settles open",
      );
      assert.closeTo(
        tp().drawer.getBoundingClientRect().height,
        (
          tp().root.querySelector(
            ".llm-task-progress-drawer-body",
          ) as HTMLElement
        ).getBoundingClientRect().height + 1,
        1,
        "the card fits its remaining papers",
      );
      await capture(panel.panelId, "tp-context-sync.png");
    } finally {
      await api.setTaskProgressComposerContexts({ panelId: panel.panelId });
      restore();
    }
  });

  it("restores counts and paper states when a stored conversation is reopened, and deletion clears them", async function () {
    const panel = await api.renderPanelForItem(fixtures[2].parentItemId);
    const restore = showOnScreen(panel.panelId);
    try {
      const tp = () => view(panel.panelId);
      const scope = {
        selectedCollectionContexts: [
          { collectionId: collection.id, name: collection.name, libraryID },
        ],
      };
      const cite = buildQuoteCitation({
        quoteText: `${TITLES[1]} — key passage.`,
        citationLabel: "(Mau, 2021)",
        itemId: fixtures[1].parentItemId,
        contextItemId: fixtures[1].pdfAttachmentId,
      })!;
      const first = `tp-stored-1-${Date.now()}`;
      const second = `tp-stored-2-${Date.now()}`;
      const seeded = await api.seedTaskProgressConversation({
        panelId: panel.panelId,
        turns: [
          {
            runId: first,
            user: { text: "Which papers measure drift?", ...scope },
            answer: `Two measure it [[quote:${cite.id}]].`,
            quoteCitations: [cite],
            events: [
              {
                type: "paper_ledger_update",
                callId: "c1",
                delta: delta("c1", first, [
                  [0, "read"],
                  [1, "read"],
                ]),
              },
            ],
          },
          {
            runId: second,
            user: { text: "And how do they explain it?", ...scope },
            answer: "By experience.",
            events: [
              {
                type: "paper_ledger_update",
                callId: "c2",
                delta: delta("c2", second, [
                  [2, "read"],
                  [3, "matched"],
                ]),
              },
            ],
          },
        ],
      });
      await api.reopenTaskProgressConversation({ panelId: panel.panelId });
      await until(() => {
        api.flushTaskProgress();
        const snapshot = api.getTaskProgressSnapshot(seeded.conversationKey);
        return Boolean(snapshot?.hydrated && snapshot.listingLoaded);
      }, "the conversation is rebuilt and its scope listed");
      api.flushTaskProgress();
      const snapshot = api.getTaskProgressSnapshot(seeded.conversationKey)!;
      assert.equal(snapshot.runState, "completed");
      assert.equal(snapshot.turnIndex, 2);
      assert.deepEqual(
        [0, 1, 2, 3].map((index) => snapshot.paperStates[key(index)]),
        ["read", "cited", "read", "matched"],
      );
      assert.isFalse(tp().row.hidden);
      assert.equal(tp().row.dataset.state, "completed");
      assert.equal(
        tp().count(),
        "1 of 4 read",
        "the row counts the latest question",
      );
      assert.deepEqual(
        snapshot.questions.map((question) => [question.turn, question.text]),
        [
          [1, "Which papers measure drift?"],
          [2, "And how do they explain it?"],
        ],
        "both questions come back with their words",
      );
      tp().row.click();
      // Every question is a section, newest first. None of the latest
      // question's papers was used in its answer: they sit under a fold.
      const sectionsNow = () =>
        Array.from(
          tp().root.querySelectorAll(".llm-task-progress-question-section"),
        ) as HTMLElement[];
      const openFold = async (section: HTMLElement) => {
        const fold = () =>
          section.querySelector(
            ".llm-task-fold-slot .llm-task-fold",
          ) as HTMLButtonElement | null;
        await until(() => {
          api.flushTaskProgress();
          return Boolean(fold());
        }, "the unused papers sit under a fold");
        if (fold()!.getAttribute("aria-expanded") !== "true") fold()!.click();
        await until(() => {
          api.flushTaskProgress();
          return section.querySelectorAll(".llm-task-paper").length > 0;
        }, "the opened fold lists its papers");
      };
      const sections = sectionsNow();
      assert.lengthOf(sections, 2);
      await openFold(sections[0]);
      const stateOf = (index: number) =>
        tp()
          .items()
          .find((item) => item.dataset.key === key(index))?.dataset.state;
      // The latest question's papers show its own reads.
      assert.lengthOf(sections[0].querySelectorAll(".llm-task-paper"), 4);
      assert.deepEqual(
        [0, 1, 2, 3].map(
          (index) =>
            (
              Array.from(
                sections[0].querySelectorAll(".llm-task-paper"),
              ) as HTMLElement[]
            ).find((item) => item.dataset.key === key(index))?.dataset.state,
        ),
        ["listed", "listed", "read", "matched"],
      );
      assert.equal(tp().head(), "", "no summary line above the paper list");
      // The first question is folded under its own header, newest first.
      const earlier = sections[1].querySelector(
        ".llm-task-progress-question",
      ) as HTMLButtonElement;
      assert.equal(earlier.getAttribute("aria-expanded"), "false");
      assert.equal(
        earlier.querySelector(".llm-task-progress-dock-question-words")
          ?.textContent,
        "Which papers measure drift?",
      );
      assert.equal(
        sections[1].querySelector(".llm-task-progress-question-name")
          ?.textContent,
        "Question 1",
      );
      earlier.click();
      await until(() => {
        api.flushTaskProgress();
        return sections[1].querySelectorAll(".llm-task-paper").length > 0;
      }, "the earlier question lists its cited paper");
      await openFold(sections[1]);
      const earlierStates = (
        Array.from(sections[1].querySelectorAll(".llm-task-paper"), (item) => [
          (item as HTMLElement).dataset.key,
          (item as HTMLElement).dataset.state,
        ]) as string[][]
      ).sort((a, b) => a[0].localeCompare(b[0]));
      assert.deepEqual(
        earlierStates,
        [
          [key(0), "read"],
          [key(1), "cited"],
        ].sort((a, b) => a[0].localeCompare(b[0])),
      );
      await capture(panel.panelId, "tp-m5-reopened.png");
      earlier.click();
      tp().row.click();

      await api.clickPanelDelete(panel.panelId);
      assert.isNull(
        api.getTaskProgressSnapshot(seeded.conversationKey),
        "deleting the conversation clears its record",
      );
      api.flushTaskProgress();
      await Zotero.Promise.delay(200);
      assert.isNull(
        api.getTaskProgressSnapshot(seeded.conversationKey),
        "and a conversation being deleted is never rebuilt",
      );
    } finally {
      restore();
    }
  });

  it("reopens a run's outcome steps and honest end state after a restart", async function () {
    /** One outcome of a stored ledger, as the host recorded it. */
    function outcome(
      runId: string,
      local: string,
      fields: Record<string, unknown>,
    ) {
      return {
        taskId: `${runId}:task:${local}`,
        dependencies: [],
        journalActionIds: [],
        verifiedReceiptIds: [],
        readEvidenceIds: [],
        materialRefs: [],
        createdAt: 1,
        updatedAt: 2,
        effect: "mutation",
        ...fields,
      };
    }
    function ledger(runId: string, tasks: Array<Record<string, unknown>>) {
      return {
        type: "execution_checkpoint",
        checkpoint: {
          version: 1,
          executionId: runId,
          conversationKey: 1,
          conversationGeneration: 0,
          tasks,
          createdAt: 1,
          updatedAt: 2,
          end: { state: "completed_with_exceptions" },
        },
      } as never;
    }
    async function reopened(title: string, runId: string, events: never[]) {
      const fixture = await api.createPaperWithPdfFixture({
        title,
        pdfTitle: title,
        pages: [`${title} evidence.`],
      });
      fixtures.push(fixture);
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const seeded = await api.seedTaskProgressConversation({
        panelId: panel.panelId,
        turns: [
          {
            runId,
            user: { text: "Tag these papers and save a summary as a note" },
            answer: "Done, with exceptions.",
            events,
          },
        ],
      });
      await api.reopenTaskProgressConversation({ panelId: panel.panelId });
      const tp = () => view(panel.panelId);
      await until(() => {
        api.flushTaskProgress();
        return Boolean(
          api.getTaskProgressSnapshot(seeded.conversationKey)?.hydrated &&
          !tp().row.hidden,
        );
      }, "the conversation is rebuilt, and its outcomes show the row in a one-paper chat");
      api.flushTaskProgress();
      return { panel, tp };
    }

    const rejected = fixtures[1].parentItemId;
    const applied = fixtures[0].parentItemId;
    const first = `tp-outcomes-1-${Date.now()}`;
    const summary = await reopened("Outcome ledger summary paper", first, [
      ledger(first, [
        outcome(first, "save", {
          description: "Save the summary as a note",
          status: "completed",
          origin: "model",
          capability: "zotero.notes",
        }),
        outcome(first, "host-tags", {
          description: "Added tags",
          status: "completed",
          origin: "host",
          capability: "zotero.tags",
          operation: "apply_tags",
          targets: [`item:${applied}`, `item:${rejected}`],
          doneTargets: [`item:${applied}`],
          exceptions: [
            {
              targets: [`item:${rejected}`],
              reason: "In a group library you cannot edit",
            },
          ],
        }),
      ]),
    ]);
    const restore = showOnScreen(summary.panel.panelId);
    try {
      const tp = summary.tp;
      const pill = tp().root.querySelector(
        ".llm-task-progress-pill",
      ) as HTMLElement;
      assert.equal(pill.textContent, "Partly done");
      assert.isFalse(pill.hidden);
      assert.equal(tp().row.dataset.state, "completed_with_exceptions");
      assert.match(tp().count(), /^2\/2 steps/);
      tp().row.click();
      await until(
        () => Boolean(tp().steps),
        "the Steps block shows the outcomes",
      );
      const lines = Array.from(
        tp().steps!.querySelectorAll(".llm-plan-task"),
      ) as HTMLElement[];
      const label = (line: HTMLElement) =>
        line.querySelector(".llm-plan-task-label")?.textContent || "";
      assert.deepEqual(lines.map(label), [
        "Save the summary as a note",
        "Added tags · 1 of 2",
        "1 not done",
      ]);
      const detail =
        lines[2].querySelector(".llm-plan-task-original")?.textContent || "";
      assert.include(detail, "In a group library you cannot edit");
      assert.include(detail, `(${TITLES[1]}, n.d.)`);
      assert.equal(
        tp().steps!.querySelector(".llm-plan-status")?.textContent,
        "Completed with exceptions",
      );
      // Steps sit further apart than a wrapped label's lines, so each step
      // reads as one block.
      for (const [index, line] of lines.slice(1).entries()) {
        const gap =
          line.getBoundingClientRect().top -
          lines[index].getBoundingClientRect().bottom;
        assert.isAtLeast(gap, 6, `the gap above step ${index + 2}`);
      }
      // The pill fades in and the drawer opens before the screenshot.
      await Zotero.Promise.delay(400);
      await capture(summary.panel.panelId, "tp-outcomes-reopened.png");
      tp().row.click();
      await api.clickPanelDelete(summary.panel.panelId);
    } finally {
      restore();
    }

    const second = `tp-outcomes-2-${Date.now()}`;
    const targets = Array.from(
      { length: 10 },
      (_, index) => `item:${910_000 + index}`,
    );
    const batch = await reopened("Outcome ledger batch paper", second, [
      ledger(second, [
        outcome(second, "host-batch", {
          description: "Updated metadata",
          status: "completed",
          origin: "host",
          capability: "zotero.metadata",
          operation: "update_metadata",
          targets,
          doneTargets: targets.slice(0, 8),
          exceptions: [
            {
              targets: targets.slice(8),
              reason: "In a group library you cannot edit",
            },
          ],
        }),
      ]),
    ]);
    try {
      assert.match(batch.tp().count(), /^8 of 10 done/);
    } finally {
      await api.clickPanelDelete(batch.panel.panelId);
    }
  });

  it("counts a part over every paper of a folder on its row, and names the folder's size", async function () {
    const panel = await api.renderPanelForItem(fixtures[0].parentItemId);
    const restore = showOnScreen(panel.panelId);
    const handle = await api.startTaskProgressReplay({
      panelId: panel.panelId,
      historyTurns: 0,
      user: {
        selectedCollectionContexts: [
          { collectionId: collection.id, name: collection.name, libraryID },
        ],
      },
    });
    try {
      const tp = () => view(panel.panelId);
      const targets = fixtures
        .slice(0, TITLES.length)
        .map((fixture) => `item:${fixture.parentItemId}`);
      const readAll = `Read each paper in ${collection.name}`;
      const ledger = (done: number): ExecutionCheckpoint => ({
        version: 1,
        executionId: handle.runId,
        conversationKey: handle.conversationKey,
        conversationGeneration: 0,
        tasks: [
          {
            taskId: `${handle.runId}:task:read-all`,
            description: readAll,
            dependencies: [],
            status: "pending",
            journalActionIds: [],
            verifiedReceiptIds: [],
            readEvidenceIds: [],
            materialRefs: [],
            createdAt: 1,
            updatedAt: 2 + done,
            effect: "read",
            origin: "model",
            scope: true,
            targets,
            doneTargets: targets.slice(0, done),
          },
        ],
        createdAt: 1,
        updatedAt: 2 + done,
      });
      await handle.emit(executionCheckpointEvent(undefined, ledger(2)));
      await until(
        () => {
          api.flushTaskProgress();
          return tp().count() === "0/1 steps · 4 papers in scope";
        },
        () => `the row names the folder's size: ${tp().count()}`,
      );
      assert.equal(tp().row.dataset.state, "working");
      tp().row.click();
      await until(() => Boolean(tp().steps), "the Steps block shows the part");
      const line = tp().steps!.querySelector(".llm-plan-task") as HTMLElement;
      assert.equal(
        line.querySelector(".llm-plan-task-label")?.textContent,
        `${readAll} · 2 of 4`,
      );
      assert.isTrue(
        (line.querySelector(".llm-plan-task-pill") as HTMLElement).hidden,
        "a part still in progress shows no pill",
      );
      // The runtime publishes each later change as a delta.
      const delta = executionCheckpointEvent(ledger(2), ledger(3));
      assert.equal(delta.type, "execution_checkpoint_delta");
      await handle.emit(delta);
      await until(
        () => {
          api.flushTaskProgress();
          return (
            tp()
              .steps?.querySelector(".llm-plan-task-label")
              ?.textContent?.endsWith("· 3 of 4") || false
          );
        },
        () =>
          `the delta moves the count: ${tp().steps!.querySelector(".llm-plan-task-label")?.textContent}`,
      );
      await until(
        () => tp().drawer.dataset.state === "open",
        "the drawer settles open",
      );
      await capture(panel.panelId, "tp-scope-part-partial.png");
      tp().row.click();
    } finally {
      handle.finish();
      restore();
    }
  });
  it("pages a long job over a folder, with Task progress counting each page's papers", async function () {
    const folder = new Zotero.Collection();
    (folder as { libraryID: number }).libraryID = libraryID;
    folder.name = `Drift long job ${Date.now()}`;
    await folder.saveTx();
    const extra: WorkflowTestFixture[] = [];
    try {
      for (const title of ["Drift in the cortex", "Drift in songbirds"]) {
        const fixture = await api.createPaperWithPdfFixture({
          title,
          pdfTitle: title,
          pages: [`${title} evidence.`],
        });
        extra.push(fixture);
      }
      const papers = [...fixtures.slice(0, TITLES.length), ...extra];
      for (const fixture of papers) {
        const paper = Zotero.Items.get(fixture.parentItemId);
        paper.addToCollection(folder.id);
        await paper.saveTx();
      }
      const panel = await api.renderPanelForItem(papers[0].parentItemId);
      const restore = showOnScreen(panel.panelId);
      try {
        const result = await api.exerciseLongJobReplay({
          panelId: panel.panelId,
          collection: {
            collectionId: folder.id,
            name: folder.name,
            libraryID,
          },
          papers: papers.map((fixture) => ({
            itemId: fixture.parentItemId,
            title: Zotero.Items.get(fixture.parentItemId).getField("title"),
          })),
          inputTokenCap: 40_000,
        });
        assert.equal(result.runStatus, "completed", JSON.stringify(result));
        const pages = result.pages.filter(
          (page) => typeof (page as { page?: unknown }).page === "number",
        );
        assert.isAtLeast(pages.length, 2, JSON.stringify(result.pages));
        assert.include(result.pages[result.pages.length - 1], {
          complete: true,
          papers: 6,
        });
        // The job's step counts its papers as each page is read.
        const counts = result.stepLabels.flatMap((label) => {
          const match = / · (\d+) of 6$/.exec(label);
          return match ? [Number(match[1])] : [];
        });
        assert.equal(counts[counts.length - 1], 6, JSON.stringify(result));
        assert.isAtLeast(new Set(counts).size, 3, JSON.stringify(counts));
        assert.deepEqual(
          counts,
          [...counts].sort((a, b) => a - b),
          "the count only advances",
        );
        assert.isTrue(
          result.rowCounts.some((count) => count.endsWith("6 papers in scope")),
          JSON.stringify(result.rowCounts),
        );
        await capture(panel.panelId, "tp-long-job-paged.png");
      } finally {
        restore();
        await api.clickPanelDelete(panel.panelId).catch(() => undefined);
      }
    } finally {
      for (const fixture of extra) await api.cleanupFixture(fixture);
      await folder.eraseTx().catch(() => undefined);
    }
  });
});
