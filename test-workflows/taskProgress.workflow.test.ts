/**
 * The Task progress row and its drawer, on every surface that hosts the chat:
 * the sidebar in its independent and stacked layouts, and the standalone
 * window. A synthetic agent run goes through the real turn event handler:
 * paper ledger updates, the first answer text, and the final answer with a
 * quote citation. The drawer's geometry is read from live layout: attached
 * under the row, as tall as a short list, capped above a strip of chat for a
 * long one, draggable, and never moving the chat's reading place. A Library
 * chat with nothing added has no row; a folder added lowers it from under
 * the header and taking it away raises it, the chat following it smoothly.
 */
import { assert } from "chai";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";
import {
  buildDigestFailureLedgerDelta,
  buildDigestLedgerDelta,
} from "../src/agent/context/taskPaperLedger";
import { executionCheckpointEvent } from "../src/agent/execution/checkpointEvents";
import type {
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
} from "../src/agent/execution/types";
import { decideRunEnd, settleOutcomes } from "../src/agent/loop/outcomes";
import type {
  HostPaperDigest,
  PaperDigestFailure,
} from "../src/agent/digests/paperDigestWorker";
import { getReaderContextPanelForTab } from "../src/modules/contextPanel/readerPopupPanelRouting";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const PAPERS = [
  { title: "Representational drift in hippocampal CA1", author: "Ziv" },
  { title: "Stable population codes under constant behavior", author: "Rule" },
  { title: "Synaptic turnover predicts place field drift", author: "Mau" },
  { title: "Drift scales with experience, not time", author: "Geva" },
  { title: "Continual learning with noisy plasticity", author: "Kossio" },
  { title: "Homeostatic control of drifting assemblies", author: "Aitken" },
];
const SNIPPETS: Record<number, string> = {
  2: "Turnover of dendritic spines predicts the rate at which place fields reorganize over two weeks.",
  3: "The rate of drift scaled with the amount of experience in the environment rather than elapsed time.",
};

type Surface = "independent" | "stacked" | "standalone";

/** Papers in the long folder: more than one window of rows (80). */
const LONG_COUNT = 90;
/** The chat strip the CSS keeps below the drawer. */
const CHAT_STRIP = 96;
/** The least height a drag leaves the drawer. */
const DRAWER_MIN = 96;
/** The gap between the Task progress card and the chat below it. */
const CARD_GAP = 6;

describe("workflow: task progress", function () {
  this.timeout(240000);
  const layoutPref = "extensions.zotero.llmforzotero.sidebarLayout";
  // Reads are recorded in Agent mode; plain chat lists the scope only.
  const agentPrefs: Array<[string, unknown]> = [
    ["extensions.zotero.llmforzotero.enableAgentMode", true],
    ["extensions.zotero.llmforzotero.lastUsedRuntimeMode", "agent"],
  ];
  const savedAgentPrefs = new Map<string, unknown>();
  let api: WorkflowTestApi;
  let win: any;
  let savedLayout: unknown;
  let savedWindowSize: { width: number; height: number } | null = null;
  const fixtures: WorkflowTestFixture[] = [];
  let collection: Zotero.Collection;
  let longCollection: Zotero.Collection;
  const longItems: Zotero.Item[] = [];
  let libraryID: number;
  const shots: string[] = [];
  /** Keeps Zotero's own banners out of this file's layout; removed after. */
  let bannerStyle: Element | null = null;

  async function until(check: () => boolean, message: string | (() => string)) {
    const deadline = Date.now() + 15000;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(40);
    assert.isTrue(check(), typeof message === "function" ? message() : message);
  }

  async function capture(target: any, filename: string) {
    const canvas = target.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    );
    const scale = target.devicePixelRatio || 1;
    canvas.width = target.innerWidth * scale;
    canvas.height = target.innerHeight * scale;
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    context.drawWindow(
      target,
      0,
      0,
      target.innerWidth,
      target.innerHeight,
      "#ffffff",
    );
    const binary = target.atob(canvas.toDataURL("image/png").split(",")[1]);
    const path = `${Zotero.DataDirectory.dir}/${filename}`;
    await win.IOUtils.write(
      path,
      Uint8Array.from(binary, (char: any) => char.charCodeAt(0)),
    );
    shots.push(path);
  }

  function paperId(index: number): number {
    return fixtures[index].parentItemId;
  }

  function paperKey(index: number): string {
    return `${libraryID}:${paperId(index)}`;
  }

  function paperRef(index: number) {
    return {
      itemId: paperId(index),
      contextItemId: fixtures[index].pdfAttachmentId,
      title: PAPERS[index].title,
      libraryID,
    };
  }

  /**
   * A `paper_ledger_update` as `library_retrieve` would emit it; a read's
   * passage is the paper's own unless `snippets` gives another.
   */
  function ledgerUpdate(
    callId: string,
    entries: Array<[number, "matched" | "skimmed" | "read"]>,
    snippets: Record<number, string> = SNIPPETS,
  ) {
    return {
      type: "paper_ledger_update" as const,
      callId,
      delta: {
        version: 1 as const,
        callId,
        toolName: "library_retrieve",
        papers: entries.map(([index, state]) => ({
          key: paperKey(index),
          libraryID,
          itemId: paperId(index),
          title: PAPERS[index].title,
          text: "pdf_text" as const,
          state,
        })),
        reads: entries.map(([index, state]) => ({
          key: paperKey(index),
          callId,
          toolName: "library_retrieve",
          granularity:
            state === "read"
              ? ("passage" as const)
              : state === "skimmed"
                ? ("abstract" as const)
                : ("metadata" as const),
          method: "bm25",
          ...(state === "read"
            ? { label: "Results", snippet: snippets[index] }
            : {}),
        })),
      },
    };
  }

  function activeDetails(): any {
    const readerPane = getReaderContextPanelForTab(
      win.document,
      win.Zotero_Tabs.selectedID,
    );
    if (readerPane) return readerPane;
    return Array.from(win.document.querySelectorAll("item-details")).find(
      (node: any) =>
        node.tabType === "library" && node.getBoundingClientRect().width > 0,
    );
  }

  /** Select the first paper and open its chat in a sidebar layout. */
  async function openSidebarChat(
    layout: "independent" | "stacked",
  ): Promise<HTMLElement> {
    Zotero.Prefs.set(layoutPref, layout, true);
    const view = layout === "independent" ? "chat" : "stacked";
    await win.ZoteroPane.selectItem(paperId(0));
    const details = activeDetails();
    assert.isOk(details, "native item details is visible");
    const section = () =>
      details.querySelector(".llm-dedicated-chat-pane") as HTMLElement;
    const mainVisible = () =>
      (section()?.querySelector("#llm-main")?.getBoundingClientRect().height ||
        0) > 0;
    if (
      win.document.documentElement.getAttribute("data-llm-pane-view") !==
        view ||
      details.sidenav._collapsed ||
      !mainVisible()
    ) {
      const paneID = section()?.dataset.pane;
      const button: any = Array.from(
        details.sidenav.querySelectorAll("[data-pane]"),
      ).find((node: any) => node.getAttribute("data-pane") === paneID);
      assert.isOk(button, "the plugin's rail icon exists");
      button.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, detail: 1, button: 0 }),
      );
    }
    await until(
      () =>
        win.document.documentElement.getAttribute("data-llm-pane-view") ===
          view &&
        !details.sidenav._collapsed &&
        mainVisible(),
      `${layout} chat is open`,
    );
    if (layout === "stacked") section().scrollIntoView?.();
    const root = section().querySelector("#llm-main") as HTMLElement;
    // A previous test may have left the pane in Library chat.
    if (root.dataset.conversationKind === "global") {
      (root.querySelector("#llm-paper-chat-tab") as HTMLElement).dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    }
    await until(
      () =>
        root.dataset.conversationKind === "paper" &&
        root.dataset.basePaperItemId === String(paperId(0)),
      "the chat shows the first paper",
    );
    return root;
  }

  async function openStandaloneChat(): Promise<{
    root: HTMLElement;
    window: any;
  }> {
    await api.openStandaloneForItem(paperId(0));
    await api.clickStandaloneTab("paper");
    const standalone = (Zotero as any).LLMForZotero.data.standaloneWindow;
    const root = () =>
      standalone.document.querySelector(
        ".llm-standalone-content #llm-main",
      ) as HTMLElement | null;
    await until(
      () => root()?.dataset.conversationKind === "paper",
      "the standalone window shows a paper chat",
    );
    return { root: root()!, window: standalone };
  }

  function part(root: HTMLElement) {
    return {
      row: root.querySelector("#llm-task-progress") as HTMLButtonElement,
      curtain: root.querySelector(".llm-task-progress-curtain") as HTMLElement,
      card: root.querySelector(".llm-task-progress-card") as HTMLElement,
      count: () =>
        root.querySelector(".llm-task-progress-count")?.textContent || "",
      shell: root.querySelector("#llm-chat-shell") as HTMLElement,
      box: root.querySelector("#llm-chat-box") as HTMLElement,
      drawer: root.querySelector("#llm-task-progress-drawer") as HTMLElement,
      body: root.querySelector(".llm-task-progress-drawer-body") as HTMLElement,
      grip: root.querySelector(".llm-task-progress-drawer-grip") as HTMLElement,
      items: () =>
        Array.from(root.querySelectorAll(".llm-task-paper")) as HTMLElement[],
    };
  }

  type View = ReturnType<typeof part>;

  async function settle(view: View, state: "open" | "closed", label: string) {
    await until(
      () => view.drawer.dataset.state === state,
      () =>
        `${label}: the drawer settles ${state} (${view.drawer.dataset.state})`,
    );
    // One more frame for the chat's scroll owner.
    await Zotero.Promise.delay(40);
  }

  /** The row lowered (open) or rose (closed) and settled there. */
  async function settleRow(
    rootOf: () => HTMLElement,
    state: "open" | "closed",
    label: string,
  ) {
    await until(
      () => {
        api.flushTaskProgress();
        return part(rootOf()).curtain.dataset.curtain === state;
      },
      () =>
        `${label}: the row settles ${state} (${part(rootOf()).curtain.dataset.curtain})`,
    );
    await Zotero.Promise.delay(40);
  }

  /** The top of the first visible thing under the chat: shortcuts or composer. */
  function composerTop(root: HTMLElement): number {
    const tops = ["#llm-shortcuts", ".llm-input-section"]
      .map((selector) => root.querySelector(selector) as HTMLElement | null)
      .map((node) => node?.getBoundingClientRect())
      .filter((rect): rect is DOMRect => Boolean(rect && rect.height > 0))
      .map((rect) => rect.top);
    assert.isNotEmpty(tops, "the composer is laid out");
    return Math.min(...tops);
  }

  /** Visible horizontal lines (bottom borders) just above the row. */
  function linesAboveRow(root: HTMLElement): string[] {
    const doc = root.ownerDocument;
    const win = doc.defaultView as any;
    const row = part(root).row.getBoundingClientRect();
    const lines: string[] = [];
    for (const node of Array.from(doc.querySelectorAll("*")) as HTMLElement[]) {
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (rect.right <= row.left || rect.left >= row.right) continue;
      if (rect.bottom < row.top - 6 || rect.bottom > row.top + 0.5) continue;
      const style = win.getComputedStyle(node);
      if (style.visibility !== "visible") continue;
      const width = parseFloat(style.borderBottomWidth) || 0;
      const color = style.borderBottomColor;
      if (
        width > 0 &&
        style.borderBottomStyle !== "none" &&
        color !== "transparent" &&
        !/rgba\([^)]*,\s*0\)$/.test(color)
      ) {
        lines.push(`${node.tagName}.${node.className} ${width}px ${color}`);
      }
    }
    return lines;
  }

  /** The first message whose top is inside the chat viewport, and its offset. */
  function readingAnchor(box: HTMLElement): { node: Element; offset: number } {
    const top = box.getBoundingClientRect().top;
    const node = (
      Array.from(
        box.querySelectorAll(".llm-message-wrapper, .llm-bubble"),
      ) as Element[]
    ).find((candidate) => candidate.getBoundingClientRect().top >= top);
    assert.isOk(node, "a message is in view");
    return { node: node!, offset: node!.getBoundingClientRect().top - top };
  }

  function bottomGap(box: HTMLElement): number {
    return box.scrollHeight - box.clientHeight - box.scrollTop;
  }

  /**
   * One container: the drawer unrolls inside the card, right under its
   * header row and exactly as wide.
   */
  function assertAttached(view: View, surface: Surface) {
    const row = view.row.getBoundingClientRect();
    const drawer = view.drawer.getBoundingClientRect();
    const card = view.card.getBoundingClientRect();
    assert.closeTo(drawer.top, row.bottom, 1, `under the header (${surface})`);
    assert.closeTo(drawer.left, row.left, 0.5, `same card (${surface}, left)`);
    assert.closeTo(
      drawer.right,
      row.right,
      0.5,
      `same card (${surface}, right)`,
    );
    assert.isAtMost(
      card.top,
      row.top + 0.5,
      `the card holds the header (${surface})`,
    );
    assert.isAtLeast(
      card.bottom,
      drawer.bottom - 0.5,
      `the card holds the drawer (${surface})`,
    );
  }

  /**
   * The chat's height above the floating chips and composer: the chat box runs
   * on under them (a negative bottom margin), so its own height adds that part.
   */
  function shownChatHeight(view: View): number {
    const win = view.box.ownerDocument.defaultView as any;
    const style = win.getComputedStyle(view.box);
    return (
      view.box.getBoundingClientRect().height +
      (Number.parseFloat(style.marginBottom) || 0)
    );
  }

  /** Open every fold of unused library papers: a settled answer folds them. */
  async function openUnusedFolds(root: HTMLElement) {
    await until(() => {
      api.flushTaskProgress();
      return (
        root.querySelectorAll(
          ".llm-task-paper, .llm-task-fold-slot .llm-task-fold",
        ).length > 0
      );
    }, "the papers or their fold list");
    for (const fold of Array.from(
      root.querySelectorAll(".llm-task-fold-slot .llm-task-fold"),
    ) as HTMLButtonElement[])
      if (fold.getAttribute("aria-expanded") !== "true") fold.click();
    api.flushTaskProgress();
  }

  /** The chat under the drawer: its viewport starts at the drawer's bottom. */
  function assertChatBelow(view: View, root: HTMLElement, surface: Surface) {
    const drawer = view.drawer.getBoundingClientRect();
    const box = view.box.getBoundingClientRect();
    assert.closeTo(
      box.top,
      view.card.getBoundingClientRect().bottom + CARD_GAP,
      1,
      `the chat starts below the card (${surface})`,
    );
    assert.isAtLeast(
      box.height,
      CHAT_STRIP - 1,
      `a strip of chat stays (${surface})`,
    );
    assert.isAtMost(
      drawer.bottom,
      composerTop(root) - CHAT_STRIP + 1,
      `the drawer stays clear of the composer by the strip (${surface})`,
    );
    const view$ = root.ownerDocument.defaultView as any;
    assert.isTrue(view.box.isConnected, "messages stay mounted");
    assert.equal(view$.getComputedStyle(view.box).visibility, "visible");
    assert.notEqual(view$.getComputedStyle(view.box).display, "none");
  }

  function surfaceOf(surface: Surface): "embedded" | "standalone" {
    return surface === "standalone" ? "standalone" : "embedded";
  }

  /**
   * In a paper chat the card is for multi-paper work: hidden for one paper
   * and for four, shown from five (the chat's own paper counts).
   */
  async function assertPaperChatThreshold(
    rootOf: () => HTMLElement,
    surface: Surface,
    shotWindow: any,
  ) {
    const noHeaderDivider = (label: string) => {
      if (surface === "standalone") return;
      const navRow = rootOf().querySelector(
        ".llm-header-nav-row",
      ) as HTMLElement;
      const style = (
        rootOf().ownerDocument.defaultView as any
      ).getComputedStyle(navRow);
      assert.equal(
        style.borderBottomStyle,
        "none",
        `no divider under the header ${label} (${surface})`,
      );
    };
    for (const papers of [[], [1, 2, 3]]) {
      const small = await api.startTaskProgressReplay({
        surface: surfaceOf(surface),
        user: papers.length
          ? { paperContexts: papers.map((index) => paperRef(index)) }
          : {},
      });
      try {
        // A card left by an earlier run rises first.
        await settleRow(rootOf, "closed", `${papers.length + 1} papers`);
        assert.isTrue(
          part(rootOf()).row.hidden,
          `a ${papers.length + 1}-paper chat has no card (${surface})`,
        );
        noHeaderDivider("without the card");
      } finally {
        small.finish();
      }
    }
    const four = await api.startTaskProgressReplay({
      surface: surfaceOf(surface),
      user: {
        paperContexts: [paperRef(1), paperRef(2), paperRef(3), paperRef(4)],
      },
    });
    try {
      await until(
        () => {
          api.flushTaskProgress();
          return part(rootOf()).count() === "0 of 5 read";
        },
        () =>
          `a five-paper chat shows the card (${surface}): ${JSON.stringify({
            count: part(rootOf()).count(),
            hidden: part(rootOf()).row.hidden,
            snapshot: api.getTaskProgressSnapshot(four.conversationKey),
            key: four.conversationKey,
            itemId: rootOf().dataset.itemId,
          })}`,
      );
      await settleRow(rootOf, "open", `five papers (${surface})`);
      noHeaderDivider("with the card");
      const root = rootOf();
      const view = part(root);
      assert.isFalse(view.row.hidden);
      assert.deepEqual(
        linesAboveRow(root),
        [],
        `no line between the header and the row (${surface})`,
      );
      await capture(shotWindow, `tp-dropdown-collapsed-${surface}.png`);

      // A short list: the drawer is exactly as tall as its content.
      await until(() => {
        api.flushTaskProgress();
        return Boolean(
          api.getTaskProgressSnapshot(four.conversationKey)?.listingLoaded,
        );
      }, "the five papers list");
      view.row.click();
      await settle(view, "open", `short list (${surface})`);
      assert.lengthOf(view.items(), 5);
      assertAttached(view, surface);
      assertChatBelow(view, root, surface);
      // The list scrolls only when the drawer cannot grow: it is at the
      // dragged height, or the chat below it is down to its strip.
      {
        const drawerRect = view.drawer.getBoundingClientRect();
        const dragged = Number.parseFloat(
          view.drawer.style.getPropertyValue("--llm-task-progress-drawer-max"),
        );
        // The chat below shrinks to its least height (a strip plus the composer's floor) and no further: then the drawer is
        // at the most space it may take.
        const chatHeight = view.box.getBoundingClientRect().height;
        const atDraggedCap =
          Number.isFinite(dragged) && drawerRect.height >= dragged - 2;
        const chatMin =
          Number.parseFloat(
            (root.ownerDocument.defaultView as any).getComputedStyle(view.box)
              .minHeight,
          ) || 0;
        const atSpaceCap = chatHeight <= chatMin + 1;
        assert.isTrue(
          view.body.scrollHeight <= view.body.clientHeight + 1 ||
            atDraggedCap ||
            atSpaceCap,
          `a short list does not scroll while the drawer can grow (${surface}): ${JSON.stringify(
            {
              scrollHeight: view.body.scrollHeight,
              clientHeight: view.body.clientHeight,
              drawerHeight: drawerRect.height,
              draggedMax: dragged,
              chatHeight,
              chatMinHeight: chatMin,
            },
          )}`,
        );
      }
      // The unscrolled body plus the card's 1px bottom border.
      assert.closeTo(
        view.drawer.getBoundingClientRect().height,
        view.body.getBoundingClientRect().height + 1,
        0.5,
        `a short list's drawer is its content's height (${surface})`,
      );
      await capture(shotWindow, `tp-dropdown-short-${surface}.png`);
      view.row.click();
      await settle(view, "closed", `short list (${surface})`);
      assert.isTrue(view.drawer.hidden);
    } finally {
      four.finish();
    }
  }

  async function switchToLibrary(rootOf: () => HTMLElement, surface: Surface) {
    const root = rootOf();
    if (surface === "standalone") await api.clickStandaloneTab("open");
    else
      (
        root.querySelector("#llm-library-chat-tab") as HTMLElement
      ).dispatchEvent(
        new (root.ownerDocument.defaultView as any).MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        }),
      );
    await until(
      () => rootOf()?.dataset.conversationKind === "global",
      `library chat opens (${surface})`,
    );
  }

  /**
   * A Library chat with nothing added has no row. A folder added to the
   * context bar lowers it from under the header, frame by frame, the chat
   * below following it down; taking the folder away raises it, and the chat
   * comes back to where it was. Read from live layout on each surface.
   */
  async function exerciseCurtain(
    rootOf: () => HTMLElement,
    surface: Surface,
    shotWindow: any,
  ) {
    const surfaceKey = surfaceOf(surface);
    const win$ = rootOf().ownerDocument.defaultView as any;
    // A new Library chat (or the empty draft the button takes up again).
    (rootOf().querySelector("#llm-history-new") as HTMLElement).dispatchEvent(
      new win$.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await until(
      () => rootOf()?.dataset.conversationKind === "global",
      `a new Library chat opens (${surface})`,
    );
    await Zotero.Promise.delay(300);
    const key = Number(rootOf().dataset.itemId);
    assert.isNotOk(
      api.getTaskProgressSnapshot(key)?.planSeen,
      `no run's steps in this Library chat (${surface})`,
    );
    await api.setTaskProgressComposerContexts({ surface: surfaceKey });
    await settleRow(rootOf, "closed", `nothing added (${surface})`);
    const empty = part(rootOf());
    assert.isTrue(
      empty.row.hidden,
      `no row in a Library chat with nothing added (${surface})`,
    );
    assert.isTrue(empty.curtain.hidden);
    assert.equal(empty.card.getBoundingClientRect().height, 0);
    const rest = empty.box.getBoundingClientRect().top;
    await capture(shotWindow, `tp-curtain-empty-${surface}.png`);

    // Lowering, sampled every frame.
    const frames: Array<{ state: string; boxTop: number; curtain: number }> =
      [];
    let sampling = true;
    const sample = () => {
      if (!sampling) return;
      const view = part(rootOf());
      frames.push({
        state: view.curtain.dataset.curtain || "",
        boxTop: view.box.getBoundingClientRect().top,
        curtain: view.curtain.getBoundingClientRect().height,
      });
      win$.requestAnimationFrame(sample);
    };
    win$.requestAnimationFrame(sample);
    await api.setTaskProgressComposerContexts({
      surface: surfaceKey,
      collectionContexts: [
        { collectionId: collection.id, name: collection.name, libraryID },
      ],
    });
    await settleRow(rootOf, "open", `a folder added (${surface})`);
    sampling = false;
    const shown = part(rootOf());
    const down = shown.box.getBoundingClientRect().top;
    const trace = JSON.stringify(
      frames.map((frame) => [frame.state, Math.round(frame.boxTop)]),
    );
    const lowering = frames.filter((frame) => frame.state === "opening");
    assert.isAtLeast(
      lowering.filter((frame) => frame.curtain > 1 && frame.curtain < 45)
        .length,
      2,
      `the row lowers through partial heights (${surface}): ${trace}`,
    );
    assert.isAbove(down, rest + 20, `the chat moves down (${surface})`);
    for (let index = 1; index < frames.length; index++) {
      assert.isAtLeast(
        frames[index].boxTop,
        frames[index - 1].boxTop - 0.5,
        `the chat only moves down (${surface}): ${trace}`,
      );
    }
    assert.isAtLeast(
      new Set(
        frames
          .map((frame) => Math.round(frame.boxTop))
          .filter((top) => top > rest + 0.5 && top < down - 0.5),
      ).size,
      3,
      `the chat follows the row, never jumping (${surface}): ${trace}`,
    );
    assert.closeTo(shown.row.getBoundingClientRect().height, 38, 1);
    assert.closeTo(shown.card.getBoundingClientRect().height, 40, 1);
    assert.isAtMost(
      shown.card.getBoundingClientRect().top -
        shown.shell.getBoundingClientRect().top,
      4,
      `the card sits at the top of the chat area (${surface})`,
    );
    assert.closeTo(
      down,
      shown.card.getBoundingClientRect().bottom + CARD_GAP,
      1,
      `the chat starts below the card (${surface})`,
    );
    assert.equal(shown.curtain.style.height, "", "no height left behind");
    await capture(shotWindow, `tp-curtain-shown-${surface}.png`);

    // Rising: the folder taken away.
    await api.setTaskProgressComposerContexts({ surface: surfaceKey });
    assert.equal(
      part(rootOf()).curtain.dataset.curtain,
      "closing",
      `the row rises (${surface})`,
    );
    if (surface === "independent") {
      await Zotero.Promise.delay(90);
      assert.equal(part(rootOf()).curtain.dataset.curtain, "closing");
      await capture(shotWindow, "tp-curtain-mid-rise-independent.png");
    }
    await settleRow(rootOf, "closed", `the folder taken away (${surface})`);
    const gone = part(rootOf());
    assert.isTrue(gone.row.hidden, `the row is gone (${surface})`);
    assert.closeTo(
      gone.box.getBoundingClientRect().top,
      rest,
      1,
      `the chat is back where it was (${surface})`,
    );
  }

  async function exerciseLibraryRun(
    rootOf: () => HTMLElement,
    surface: Surface,
    shotWindow: any,
  ) {
    const handle = await api.startTaskProgressReplay({
      surface: surfaceOf(surface),
      historyTurns: 4,
      user: {
        selectedCollectionContexts: [
          { collectionId: collection.id, name: collection.name, libraryID },
        ],
      },
    });
    const root = rootOf();
    const view = part(root);
    const doc = root.ownerDocument;
    const view$ = doc.defaultView as any;
    try {
      await until(() => {
        api.flushTaskProgress();
        return Boolean(
          api.getTaskProgressSnapshot(handle.conversationKey)?.listingLoaded,
        );
      }, "the scope listing resolves");
      api.flushTaskProgress();
      const snapshot = api.getTaskProgressSnapshot(handle.conversationKey)!;
      assert.sameMembers(
        snapshot.scopeKeys,
        PAPERS.map((_, index) => paperKey(index)),
        "the folder's papers are the scope",
      );
      assert.equal(snapshot.label, collection.name);
      await settleRow(rootOf, "open", `the folder's run (${surface})`);
      assert.isFalse(
        view.row.hidden,
        `library chat shows the row (${surface})`,
      );
      assert.closeTo(view.row.getBoundingClientRect().height, 38, 1);
      assert.isFalse(view.card.hidden, "the card shows with its header");
      assert.isAtMost(
        view.card.getBoundingClientRect().top -
          view.shell.getBoundingClientRect().top,
        4,
        "the card sits at the top of the chat area",
      );
      assert.equal(view.row.dataset.state, "working");
      assert.equal(view.count(), "0 of 6 read");

      await handle.emit(
        ledgerUpdate("retrieve-1", [
          [0, "matched"],
          [1, "skimmed"],
          [2, "read"],
          [3, "read"],
        ]),
      );
      api.flushTaskProgress();
      assert.equal(view.count(), "3 of 6 read");
      await capture(shotWindow, `task-progress-${surface}-row-mid-run.png`);

      // Open: the drawer unrolls under the row and the chat below shrinks;
      // the messages stay mounted and keep their reading place.
      view.box.scrollTop = Math.max(
        0,
        (view.box.scrollHeight - view.box.clientHeight) / 2,
      );
      await Zotero.Promise.delay(80);
      const scrollTop = view.box.scrollTop;
      assert.isAbove(scrollTop, 0, "the chat has history to scroll");
      const anchor = readingAnchor(view.box);
      const boxHeight = view.box.getBoundingClientRect().height;
      const shellRect = view.shell.getBoundingClientRect();
      view.row.click();
      assert.equal(view.row.getAttribute("aria-expanded"), "true");
      assert.equal(view.drawer.dataset.state, "opening", "it unrolls");
      assert.isFalse(view.drawer.hidden);
      await settle(view, "open", `open (${surface})`);
      assert.equal(view.drawer.style.height, "", "no height left behind");
      assertAttached(view, surface);
      assertChatBelow(view, root, surface);
      assert.closeTo(
        view.box.getBoundingClientRect().height,
        boxHeight - view.drawer.getBoundingClientRect().height,
        1,
        "the chat gives the drawer its height",
      );
      const shellNow = view.shell.getBoundingClientRect();
      assert.closeTo(shellNow.top, shellRect.top, 0.5, "the shell stays put");
      assert.closeTo(shellNow.height, shellRect.height, 0.5);
      assert.closeTo(view.box.scrollTop, scrollTop, 1, "scrollTop is kept");
      assert.closeTo(
        anchor.node.getBoundingClientRect().top -
          view.box.getBoundingClientRect().top,
        anchor.offset,
        1,
        "the reading anchor stays where it was",
      );

      const items = view.items();
      assert.lengthOf(items, 6);
      assert.deepEqual(
        items.map((item) => item.dataset.key),
        snapshot.scopeKeys,
        "rows follow scope order",
      );
      assert.deepEqual(
        items.map(
          (item) => item.querySelector(".llm-task-paper-index")!.textContent,
        ),
        ["1", "2", "3", "4", "5", "6"],
      );
      const stateOf = (index: number) =>
        items.find((item) => item.dataset.key === paperKey(index))!.dataset
          .state;
      assert.deepEqual([0, 1, 2, 3, 4, 5].map(stateOf), [
        "matched",
        "skimmed",
        "read",
        "read",
        "listed",
        "listed",
      ]);

      const readItem = items.find((item) => item.dataset.key === paperKey(2))!;
      const summary = readItem.querySelector(
        ".llm-task-paper-summary",
      ) as HTMLButtonElement;
      summary.click();
      const details = readItem.querySelector(
        ".llm-task-paper-details",
      ) as HTMLElement;
      assert.isFalse(details.hidden, "a paper expands");
      assert.include(details.textContent!, SNIPPETS[2]);
      // One question read it: no question heading, no tool or method names.
      assert.notInclude(details.textContent!, "Question");
      assert.notInclude(details.textContent!, "Retrieve Library");
      await Zotero.Promise.delay(450); // the reads fade in
      await capture(shotWindow, `tp-paper-details-${surface}.png`);
      // Scrolling the drawer never moves the chat below it.
      view.body.scrollTop +=
        readItem.getBoundingClientRect().top -
        view.body.getBoundingClientRect().top;
      await Zotero.Promise.delay(50);
      assert.closeTo(view.box.scrollTop, scrollTop, 1);
      summary.click();
      assert.isTrue(details.hidden, "and collapses");

      summary.dispatchEvent(
        new view$.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      assert.equal(view.drawer.dataset.state, "closing", "Escape rolls it up");
      assert.equal(view.row.getAttribute("aria-expanded"), "false");
      await settle(view, "closed", `Escape (${surface})`);
      assert.isTrue(view.drawer.hidden);
      assert.isFalse(view.shell.classList.contains("llm-task-progress-shown"));
      assert.closeTo(view.box.getBoundingClientRect().height, boxHeight, 1);
      assert.closeTo(
        view.box.scrollTop,
        scrollTop,
        1,
        "the chat's scroll position survives the drawer",
      );

      // At the bottom, the chat stays at the bottom through both motions.
      view.box.scrollTop = view.box.scrollHeight;
      await Zotero.Promise.delay(80);
      assert.isAtMost(bottomGap(view.box), 1);
      view.row.click();
      await settle(view, "open", `follow bottom (${surface})`);
      assert.isAtMost(bottomGap(view.box), 1, "still at the bottom, open");
      view.row.click();
      await settle(view, "closed", `follow bottom (${surface})`);
      assert.isAtMost(bottomGap(view.box), 1, "still at the bottom, closed");

      // The first answer text collapses an open drawer.
      view.row.click();
      await settle(view, "open", `before the answer (${surface})`);
      const quote = SNIPPETS[3];
      const citation = buildQuoteCitation({
        quoteText: quote,
        citationLabel: `(${PAPERS[3].author}, 2021)`,
        sourceMatchText: quote,
        sourceMatchKind: "exact",
        sourceMatchSource: "context-text",
        itemId: paperId(3),
        contextItemId: fixtures[3].pdfAttachmentId,
      })!;
      const answer =
        `Across the folder, drift tracks experience.\n\n> ${quote}\n\n` +
        `(${PAPERS[3].author}, 2021)\n\n[[quote:${citation.id}]] ` +
        "Population readouts stay stable while single cells change.\n\n" +
        "Further discussion follows so the answer has length.\n\n".repeat(8);
      await handle.emit({ type: "message_delta", text: "Across the folder, " });
      assert.equal(
        view.drawer.dataset.state,
        "closing",
        "the answer rolls the drawer up",
      );
      await settle(view, "closed", `answer (${surface})`);
      api.flushTaskProgress();
      assert.equal(view.row.dataset.state, "answering");

      await handle.emit({
        type: "final",
        text: answer,
        quoteCitations: [citation],
      });
      handle.refreshChat();
      await Zotero.Promise.delay(200);
      api.flushTaskProgress();
      assert.equal(view.row.dataset.state, "completed", "✓ at final");
      assert.equal(view.count(), "3 of 6 read · 1 cited");
      await capture(shotWindow, `task-progress-${surface}-completed.png`);

      // "Cited" lists the passage the answer quotes as a card (a card has no
      // number), and folds the reads it did not cite; "Show in answer" asks
      // the panel to light the passage, and the drawer stays open. The
      // panel's own lighting is covered by the docked workflow, so the
      // request is caught before the panel here.
      view.box.scrollTop = 0;
      await Zotero.Promise.delay(50);
      view.row.click();
      await settle(view, "open", `citation (${surface})`);
      const citedItem = view
        .items()
        .find((item) => item.dataset.key === paperKey(3))!;
      assert.equal(citedItem.dataset.state, "cited");
      (
        citedItem.querySelector(".llm-task-paper-summary") as HTMLElement
      ).click();
      assert.isNull(
        citedItem.querySelector(".llm-task-paper-citation"),
        "the old list of cited passages is gone",
      );
      const headings = Array.from(
        citedItem.querySelectorAll(".llm-task-paper-turn"),
      ).map((node) => (node as HTMLElement).textContent);
      assert.deepEqual(headings, ["Cited"]);
      assert.notInclude(citedItem.textContent!, "Passages read");
      const passage = (
        Array.from(
          citedItem.querySelectorAll(".llm-task-cited-item"),
        ) as HTMLElement[]
      ).find((block) =>
        (
          block.querySelector(".llm-task-paper-snippet")?.textContent || ""
        ).includes(quote.slice(0, 30)),
      );
      assert.isOk(passage, "the cited paper lists the quoted passage");
      assert.isNull(
        passage!.querySelector(".llm-task-cited-number"),
        "a passage quoted as a card has no number",
      );
      assert.isOk(passage!.querySelector(".llm-task-paper-open"), "Source");
      const link = passage!.querySelector(
        ".llm-task-cited-foot .llm-task-source-link",
      ) as HTMLButtonElement;
      assert.isOk(link, "Show in answer under the passage");
      const requests: any[] = [];
      const catchRequest = (event: Event) => {
        requests.push((event as CustomEvent).detail);
        event.stopPropagation();
      };
      citedItem.addEventListener(
        "llm-task-progress-show-in-answer",
        catchRequest,
      );
      try {
        link.click();
      } finally {
        citedItem.removeEventListener(
          "llm-task-progress-show-in-answer",
          catchRequest,
        );
      }
      assert.lengthOf(requests, 1, "the link asks to show its passage");
      assert.include(requests[0], {
        itemId: paperId(3),
        key: paperKey(3),
        citationId: citation.id,
      });
      assert.deepEqual(requests[0].texts, [], "a card lights itself");
      assert.equal(view.drawer.dataset.state, "open", "the drawer stays open");
      view.row.click();
      await settle(view, "closed", `citation (${surface})`);
      assert.equal(
        doc.querySelectorAll(
          ".llm-plan-progress-floating, .llm-plan-container-execution",
        ).length,
        0,
        "no floating plan capsule",
      );

      // A finalized document cites a paper from its Discussion: the paper's
      // row counts it as cited and lists the section under "Cited in
      // document"; a source named only by key joins the same row.
      await handle.emit({
        type: "material_finalized",
        materialRef: {
          documentId: "review-1",
          documentVersion: 1,
          contentHash: "review-hash",
        },
        materialKind: "literature_review",
        materialTitle: "Drift review",
        callId: "submit-1",
        citedSources: [
          {
            citationId: "C1",
            libraryID,
            itemKey: Zotero.Items.get(paperId(2)).key,
            itemId: paperId(2),
            sectionLabel: "Discussion",
          },
          {
            citationId: "C2",
            libraryID,
            itemKey: Zotero.Items.get(paperId(2)).key,
          },
        ],
      });
      api.flushTaskProgress();
      assert.equal(view.count(), "3 of 6 read · 2 cited");
      view.row.click();
      await settle(view, "open", `document citations (${surface})`);
      const documentCited = view
        .items()
        .find((item) => item.dataset.key === paperKey(2))!;
      assert.equal(documentCited.dataset.state, "cited");
      const documentSummary = documentCited.querySelector(
        ".llm-task-paper-summary",
      ) as HTMLElement;
      if (documentSummary.getAttribute("aria-expanded") !== "true")
        documentSummary.click();
      const documentDetails = documentCited.querySelector(
        ".llm-task-paper-details",
      ) as HTMLElement;
      assert.include(documentDetails.textContent!, "Cited in document");
      assert.deepEqual(
        Array.from(
          documentDetails.querySelectorAll(".llm-task-paper-citation"),
        ).map((node) => (node as HTMLElement).textContent),
        ["↳ Discussion", "↳ Cited in document"],
      );
      assert.notInclude(
        documentDetails.textContent!,
        "Cited in answer",
        "a document's citations are not the answer's",
      );
      documentSummary.click();
      view.row.click();
      await settle(view, "closed", `document citations (${surface})`);
    } finally {
      handle.finish();
    }
  }

  /**
   * Two questions in one conversation. The drawer lists them newest first:
   * the current question named above its own papers, the earlier one folded
   * to its words, ending and count. Unrolled, the earlier one shows its own
   * papers with its own reads; a paper both read is in both, each with that
   * question's passage only.
   */
  async function exerciseQuestionHistory(
    rootOf: () => HTMLElement,
    surface: Surface,
    shotWindow: any,
  ) {
    const scope = {
      selectedCollectionContexts: [
        { collectionId: collection.id, name: collection.name, libraryID },
      ],
    };
    const firstWords = "Which papers measure drift over weeks?";
    const secondWords = "How do they explain it?";
    const secondRead = "Spine turnover sets the pace of the drift.";
    const first = await api.startTaskProgressReplay({
      surface: surfaceOf(surface),
      historyTurns: 0,
      question: firstWords,
      user: scope,
    });
    try {
      await first.emit(
        ledgerUpdate("history-1", [
          [2, "read"],
          [3, "read"],
        ]),
      );
      await first.emit({ type: "final", text: "Two of them measure it." });
      first.refreshChat();
    } finally {
      first.finish();
    }
    const second = await api.startTaskProgressReplay({
      surface: surfaceOf(surface),
      followUp: true,
      question: secondWords,
      user: scope,
    });
    const view = part(rootOf());
    const root = rootOf();
    try {
      await until(() => {
        api.flushTaskProgress();
        return Boolean(
          api.getTaskProgressSnapshot(second.conversationKey)?.listingLoaded,
        );
      }, `the scope lists (${surface})`);
      await second.emit(
        ledgerUpdate(
          "history-2",
          [
            [2, "read"],
            [4, "skimmed"],
          ],
          { 2: secondRead },
        ),
      );
      await second.emit({ type: "final", text: "Spine turnover." });
      second.refreshChat();
      await Zotero.Promise.delay(150);
      api.flushTaskProgress();
      const snapshot = api.getTaskProgressSnapshot(second.conversationKey)!;
      assert.deepEqual(
        snapshot.questions.map((question) => [question.turn, question.text]),
        [
          [1, firstWords],
          [2, secondWords],
        ],
      );
      await settleRow(rootOf, "open", `question history (${surface})`);
      assert.equal(view.row.dataset.state, "completed");
      assert.equal(
        view.count(),
        "2 of 6 read",
        "the row describes the latest question",
      );

      view.row.click();
      await settle(view, "open", `question history (${surface})`);
      // Every question is one section, newest first; each has the same head.
      const sections = Array.from(
        root.querySelectorAll(".llm-task-progress-question-section"),
      ) as HTMLElement[];
      assert.lengthOf(sections, 2, `both questions are sections (${surface})`);
      const headOf = (section: HTMLElement) =>
        section.querySelector(
          ".llm-task-progress-question",
        ) as HTMLButtonElement;
      const wordsOf = (section: HTMLElement) =>
        section.querySelector(".llm-task-progress-dock-question-words")
          ?.textContent;
      const currentHead = headOf(sections[0]);
      assert.equal(wordsOf(sections[0]), secondWords);
      assert.equal(
        sections[0].querySelector(".llm-task-progress-question-name")
          ?.textContent,
        "Question 2",
        `the current question is named (${surface})`,
      );
      assert.equal(currentHead.getAttribute("aria-expanded"), "true");
      const head = headOf(sections[1]);
      assert.equal(head.tagName.toLowerCase(), "button");
      assert.equal(head.getAttribute("aria-expanded"), "false");
      assert.equal(wordsOf(sections[1]), firstWords);
      assert.equal(
        sections[1].querySelector(".llm-task-progress-question-name")
          ?.textContent,
        "Question 1",
      );
      assert.equal(
        head.querySelector(".llm-task-progress-dock-question-status")
          ?.textContent,
        "Completed",
      );
      assert.equal(
        head.querySelector(".llm-task-progress-question-counts")?.textContent,
        "2 read · 0 cited",
      );
      assert.lengthOf(
        sections[1].querySelectorAll(".llm-task-paper"),
        0,
        "a folded question builds no rows",
      );
      // Newest first: the current question, then the earlier one.
      assert.isAtLeast(
        head.getBoundingClientRect().top,
        currentHead.getBoundingClientRect().bottom - 1,
        "the earlier question is below the current one",
      );
      // None of the papers was used in the answer: they sit under a fold
      // that opens them.
      const openFold = async (section: HTMLElement, label: string) => {
        const fold = () =>
          section.querySelector(
            ".llm-task-fold-slot .llm-task-fold",
          ) as HTMLButtonElement | null;
        await until(() => {
          api.flushTaskProgress();
          return Boolean(fold());
        }, `${label}: the unused papers sit under a fold (${surface})`);
        if (fold()!.getAttribute("aria-expanded") !== "true") fold()!.click();
        await until(() => {
          api.flushTaskProgress();
          return section.querySelectorAll(".llm-task-paper").length > 0;
        }, `${label}: the opened fold lists its papers (${surface})`);
      };
      await openFold(sections[0], "the current question");
      const list = sections[0].querySelector(
        ".llm-task-progress-list",
      ) as HTMLElement;
      const currentItems = Array.from(
        sections[0].querySelectorAll(".llm-task-paper"),
      ) as HTMLElement[];
      const stateIn = (items: HTMLElement[], index: number) =>
        items.find((item) => item.dataset.key === paperKey(index))?.dataset
          .state;
      assert.deepEqual(
        [0, 1, 2, 3, 4, 5].map((index) => stateIn(currentItems, index)),
        ["listed", "listed", "read", "listed", "skimmed", "listed"],
      );
      assert.isOk(list, "the current question has its papers list");
      const detailsOf = (item: HTMLElement) => {
        const summary = item.querySelector(
          ".llm-task-paper-summary",
        ) as HTMLButtonElement;
        if (summary.getAttribute("aria-expanded") !== "true") summary.click();
        return (
          (item.querySelector(".llm-task-paper-details") as HTMLElement)
            .textContent || ""
        );
      };
      const shared = currentItems.find(
        (item) => item.dataset.key === paperKey(2),
      )!;
      const sharedNow = detailsOf(shared);
      assert.include(sharedNow, secondRead);
      assert.notInclude(sharedNow, SNIPPETS[2]);
      assert.notInclude(sharedNow, "Question");

      head.click();
      assert.equal(head.getAttribute("aria-expanded"), "true");
      await openFold(sections[1], "the earlier question");
      const earlierItems = Array.from(
        sections[1].querySelectorAll(".llm-task-paper"),
      ) as HTMLElement[];
      assert.deepEqual(
        earlierItems.map((item) => [item.dataset.key, item.dataset.state]),
        [
          [paperKey(2), "read"],
          [paperKey(3), "read"],
        ],
      );
      const sharedThen = detailsOf(earlierItems[0]);
      assert.include(sharedThen, SNIPPETS[2]);
      assert.notInclude(sharedThen, secondRead);
      assert.notInclude(sharedThen, "Question");
      assert.lengthOf(
        view.items().filter((item) => item.dataset.key === paperKey(2)),
        2,
        "a paper both questions read is in both",
      );
      // Unrolled questions stay unrolled through a repaint.
      api.flushTaskProgress();
      assert.equal(head.getAttribute("aria-expanded"), "true");
      await Zotero.Promise.delay(450); // the reads fade in
      await capture(shotWindow, `tp-question-history-${surface}.png`);
      head.click();
      assert.equal(head.getAttribute("aria-expanded"), "false");
      assert.lengthOf(sections[1].querySelectorAll(".llm-task-paper"), 0);
      view.row.click();
      await settle(view, "closed", `question history (${surface})`);
    } finally {
      second.finish();
    }
  }

  /**
   * A digest part: the host summarizes each paper itself. The steps block
   * counts the papers summarized ("· 1 of 2"), a digested paper's row counts
   * its verified evidence and shows its summary in a Summary block, and a
   * paper whose digest failed says why.
   */
  async function exerciseDigestRun(
    rootOf: () => HTMLElement,
    surface: Surface,
  ) {
    const handle = await api.startTaskProgressReplay({
      surface: surfaceOf(surface),
      historyTurns: 1,
      user: {
        selectedCollectionContexts: [
          { collectionId: collection.id, name: collection.name, libraryID },
        ],
      },
    });
    const view = part(rootOf());
    try {
      await until(() => {
        api.flushTaskProgress();
        return Boolean(
          api.getTaskProgressSnapshot(handle.conversationKey)?.listingLoaded,
        );
      }, `the scope listing resolves (${surface})`);
      const targets = [0, 1].map((index) => `item:${paperId(index)}`);
      const ledger = (done: string[], updatedAt: number) => ({
        version: 1 as const,
        executionId: `digest-${surface}`,
        conversationKey: handle.conversationKey,
        conversationGeneration: 0,
        createdAt: 1,
        updatedAt,
        tasks: [
          {
            taskId: `digest-${surface}:task:summaries`,
            description: "Summarize each selected paper",
            dependencies: [],
            status: "in_progress" as const,
            journalActionIds: [],
            verifiedReceiptIds: [],
            readEvidenceIds: [],
            materialRefs: [],
            createdAt: 1,
            updatedAt,
            effect: "digest" as const,
            origin: "model" as const,
            targets,
            doneTargets: done,
          },
        ],
      });
      const before = ledger([], 2);
      const after = ledger(targets.slice(0, 1), 3);
      await handle.emit(executionCheckpointEvent(undefined, before));
      const summaryText =
        "Place fields reorganize over weeks as spines turn over.";
      // Typed as the worker's own records: the builders take them as they are.
      const digest: HostPaperDigest = {
        schema: 2,
        itemId: paperId(0),
        contextItemId: fixtures[0].pdfAttachmentId,
        title: PAPERS[0].title,
        answer: summaryText,
        evidence: [{ section: "Results", quote: SNIPPETS[2] }],
        facets: [],
        gaps: [],
        source: {
          backend: "pdf",
          readCharacters: 2000,
          totalCharacters: 2000,
          complete: true,
        },
        model: "workflow-model",
        producedAt: 1,
        cacheKey: `digest-${surface}`,
      };
      const digested = buildDigestLedgerDelta({
        runId: handle.runId,
        callId: "task-update-1",
        toolName: "task_update",
        digest,
        paper: { ...paperRef(0) },
      });
      await handle.emit({
        type: "paper_ledger_update",
        callId: digested.callId,
        delta: digested,
      });
      const delta = executionCheckpointEvent(before, after);
      assert.equal(delta.type, "execution_checkpoint_delta");
      await handle.emit(delta);
      const failure: PaperDigestFailure = {
        target: targets[1],
        itemId: paperId(1),
        reason: "No readable text",
      };
      const failed = buildDigestFailureLedgerDelta({
        runId: handle.runId,
        callId: "task-update-1",
        toolName: "task_update",
        failure,
        paper: { ...paperRef(1) },
      });
      await handle.emit({
        type: "paper_ledger_update",
        callId: failed.callId,
        delta: failed,
      });
      api.flushTaskProgress();
      await settleRow(rootOf, "open", `the digest run (${surface})`);
      if (view.row.getAttribute("aria-expanded") !== "true") {
        view.row.click();
        await settle(view, "open", `digest drawer (${surface})`);
      }
      const label = () =>
        Array.from(
          rootOf().querySelectorAll(
            ".llm-task-progress-steps .llm-plan-task-label",
          ),
        ).map((node) => (node as HTMLElement).textContent);
      await until(
        () => {
          api.flushTaskProgress();
          return label().includes("Summarize each selected paper · 1 of 2");
        },
        () => `the digest step counts 1 of 2 (${label().join(" | ")})`,
      );
      const rowOf = (index: number) =>
        view.items().find((item) => item.dataset.key === paperKey(index))!;
      const tailOf = (index: number) =>
        rowOf(index).querySelector(".llm-task-paper-tail")!.textContent;
      assert.equal(rowOf(0).dataset.state, "read");
      assert.equal(tailOf(1), "Summary failed");
      (
        rowOf(0).querySelector(".llm-task-paper-summary") as HTMLElement
      ).click();
      const details = rowOf(0).querySelector(
        ".llm-task-paper-details",
      ) as HTMLElement;
      assert.isFalse(details.hidden, "the digested paper expands");
      const block = details.querySelector(".llm-task-paper-digest")!;
      assert.isOk(block, "a Summary block");
      assert.equal(
        block.querySelector(".llm-task-paper-turn")!.textContent,
        // The reader read every character of this paper's text.
        "Summary · Full",
      );
      assert.equal(
        block.querySelector(".llm-task-paper-snippet")!.textContent,
        summaryText,
      );
      assert.include(details.textContent!, "Results");
      assert.include(details.textContent!, SNIPPETS[2]);
      assert.lengthOf(
        details.querySelectorAll(".llm-task-paper-open"),
        1,
        "only the evidence opens its source",
      );
      (
        rowOf(1).querySelector(".llm-task-paper-summary") as HTMLElement
      ).click();
      assert.include(
        (rowOf(1).querySelector(".llm-task-paper-details") as HTMLElement)
          .textContent!,
        "No readable text",
      );
      view.row.click();
      await settle(view, "closed", `digest drawer (${surface})`);
    } finally {
      handle.finish();
    }
  }

  /**
   * A run whose parts changed: two digest parts over one paper (one judged
   * its relevance), a review that left a paper out, and a read part the
   * model replaced. The paper's row shows one block per part under its
   * label, and its tail names the part whose answer came last; the step
   * rows say "Replaced: <reason>" and "Excluded: <reason>: <paper>", and
   * neither makes the run Partly done.
   */
  async function exercisePartsRun(rootOf: () => HTMLElement, surface: Surface) {
    const handle = await api.startTaskProgressReplay({
      surface: surfaceOf(surface),
      historyTurns: 1,
      user: {
        selectedCollectionContexts: [
          { collectionId: collection.id, name: collection.name, libraryID },
        ],
      },
    });
    const view = part(rootOf());
    try {
      await until(() => {
        api.flushTaskProgress();
        return Boolean(
          api.getTaskProgressSnapshot(handle.conversationKey)?.listingLoaded,
        );
      }, `the scope listing resolves (${surface})`);
      const executionId = `parts-${surface}`;
      const [paper, other] = [0, 1].map((index) => `item:${paperId(index)}`);
      const BRIEF = "Summarize each paper";
      const DRIFT = "Evidence for representational drift";
      const replacedWhy = "The user narrowed the question";
      const excludedWhy = "Off the question";
      const task = (
        local: string,
        description: string,
        fields: Partial<ExecutionCheckpointTask>,
      ): ExecutionCheckpointTask => ({
        taskId: `${executionId}:task:${local}`,
        description,
        dependencies: [],
        status: "pending",
        journalActionIds: [],
        verifiedReceiptIds: [],
        readEvidenceIds: [],
        materialRefs: [],
        createdAt: 1,
        updatedAt: 1,
        origin: "model",
        ...fields,
      });
      const ledger = (done: boolean): ExecutionCheckpoint => ({
        version: 1,
        executionId,
        conversationKey: handle.conversationKey,
        conversationGeneration: 0,
        createdAt: 1,
        updatedAt: done ? 3 : 2,
        tasks: [
          task("read-drift", "Read each paper on drift", {
            effect: "read",
            targets: [paper, other],
            ...(done
              ? {
                  status: "cancelled",
                  reason: replacedWhy,
                  supersededBy: `${executionId}:task:drift`,
                }
              : {}),
          }),
          task("brief", BRIEF, {
            effect: "digest",
            targets: [paper],
            ...(done ? { status: "completed", doneTargets: [paper] } : {}),
          }),
          task("drift", DRIFT, {
            effect: "digest",
            targets: [paper],
            ...(done ? { status: "completed", doneTargets: [paper] } : {}),
          }),
          task("review", "Write the review", {
            effect: "artifact",
            targets: [paper, other],
            ...(done
              ? {
                  status: "completed",
                  doneTargets: [paper],
                  excludedTargets: [{ targets: [other], reason: excludedWhy }],
                }
              : {}),
          }),
        ],
      });
      const before = ledger(false);
      const finished = ledger(true);
      // Settled as the host settles a run whose answer is final.
      const after = settleOutcomes(
        finished,
        decideRunEnd(finished, {
          status: "completed",
          stopRule: "final_answer",
        }),
        3,
      );
      assert.equal(after.end?.state, "completed", "the host's own ending");
      await handle.emit(executionCheckpointEvent(undefined, before));
      const briefText = "Place fields reorganize over weeks.";
      const driftText = "Drift follows spine turnover in CA1.";
      const relevanceWhy = "It measures drift over weeks.";
      const digest = (
        answer: string,
        extra: Partial<HostPaperDigest> = {},
      ): HostPaperDigest => ({
        schema: 2,
        itemId: paperId(0),
        contextItemId: fixtures[0].pdfAttachmentId,
        title: PAPERS[0].title,
        answer,
        evidence: [],
        facets: [],
        gaps: [],
        source: {
          backend: "pdf",
          readCharacters: 2000,
          totalCharacters: 2000,
          complete: true,
        },
        model: "workflow-model",
        producedAt: 1,
        cacheKey: `parts-${surface}-${answer.length}`,
        ...extra,
      });
      for (const delta of [
        buildDigestLedgerDelta({
          runId: handle.runId,
          callId: "task-update-brief",
          toolName: "task_update",
          partId: "brief",
          label: BRIEF,
          digest: digest(briefText),
          paper: { ...paperRef(0) },
        }),
        buildDigestLedgerDelta({
          runId: handle.runId,
          callId: "task-update-drift",
          toolName: "task_update",
          partId: "drift",
          label: DRIFT,
          digest: digest(driftText, {
            relevance: { level: "direct", reason: relevanceWhy },
          }),
          paper: { ...paperRef(0) },
        }),
      ]) {
        await handle.emit({
          type: "paper_ledger_update",
          callId: delta.callId,
          delta,
        });
      }
      const delta = executionCheckpointEvent(before, after);
      assert.equal(delta.type, "execution_checkpoint_delta");
      await handle.emit(delta);
      api.flushTaskProgress();
      await settleRow(rootOf, "open", `the revised run (${surface})`);
      if (view.row.getAttribute("aria-expanded") !== "true") {
        view.row.click();
        await settle(view, "open", `revised drawer (${surface})`);
      }
      const stepRows = () =>
        Array.from(
          rootOf().querySelectorAll(".llm-task-progress-steps .llm-plan-task"),
        ) as HTMLElement[];
      const textOf = (node: Element, selector: string) =>
        node.querySelector(selector)?.textContent || "";
      await until(
        () => {
          api.flushTaskProgress();
          const first = stepRows()[0];
          return (
            Boolean(first) &&
            textOf(first, ".llm-plan-task-pill") === "Replaced"
          );
        },
        () =>
          `the replaced part reads Replaced (${stepRows()
            .map((row) => row.textContent)
            .join(" | ")})`,
      );
      assert.deepEqual(
        stepRows().map((row) => [
          textOf(row, ".llm-plan-task-label"),
          textOf(row, ".llm-plan-task-original"),
          textOf(row, ".llm-plan-task-pill"),
        ]),
        [
          [
            "Read each paper on drift · 0 of 2",
            `Replaced: ${replacedWhy}`,
            "Replaced",
          ],
          [BRIEF, "", "Done"],
          [DRIFT, "", "Done"],
          [
            "Write the review",
            `Excluded: ${excludedWhy}: (${PAPERS[1].author}, 2021)`,
            "Done",
          ],
        ],
        "no not-done row: an excluded paper is not left undone",
      );
      assert.equal(
        textOf(rootOf(), ".llm-task-progress-pill"),
        "Completed",
        "neither the replaced part nor the excluded paper is Partly done",
      );
      assert.equal(
        textOf(rootOf(), ".llm-task-progress-steps .llm-plan-status"),
        "Completed",
      );
      assert.match(view.count(), /(^| · )3\/3 steps( · |$)/);
      await openUnusedFolds(rootOf());
      const rowOf = (index: number) =>
        view.items().find((item) => item.dataset.key === paperKey(index))!;
      (
        rowOf(0).querySelector(".llm-task-paper-summary") as HTMLElement
      ).click();
      const details = rowOf(0).querySelector(
        ".llm-task-paper-details",
      ) as HTMLElement;
      assert.isFalse(details.hidden, "the digested paper expands");
      const blocks = (
        Array.from(
          details.querySelectorAll(".llm-task-paper-digest"),
        ) as HTMLElement[]
      ).map((block) => [
        textOf(block, ".llm-task-paper-turn"),
        (
          Array.from(
            block.querySelectorAll(".llm-task-paper-how"),
          ) as HTMLElement[]
        ).map((line) => line.textContent),
        textOf(block, ".llm-task-paper-snippet"),
      ]);
      // Each reader read every character of the paper's text.
      assert.deepEqual(blocks, [
        [`${BRIEF} · Full`, [], briefText],
        [`${DRIFT} · Full`, [`Directly relevant — ${relevanceWhy}`], driftText],
      ]);
      assert.notInclude(details.textContent!, "Summary");
      view.row.click();
      await settle(view, "closed", `revised drawer (${surface})`);
    } finally {
      handle.finish();
    }
  }

  /** Drag the drawer's handle by `dy` pixels, as a mouse would. */
  async function dragGrip(view: View, dy: number) {
    const doc = view.grip.ownerDocument;
    const win = doc.defaultView as any;
    const rect = view.grip.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const mouse = (type: string, clientY: number) =>
      new win.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: x,
        clientY,
      });
    view.grip.dispatchEvent(mouse("mousedown", y));
    for (const step of [0.5, 1]) {
      doc.documentElement.dispatchEvent(mouse("mousemove", y + dy * step));
      await Zotero.Promise.delay(20);
    }
    doc.documentElement.dispatchEvent(mouse("mouseup", y + dy));
    await Zotero.Promise.delay(60);
  }

  const heightOf = (node: HTMLElement) => node.getBoundingClientRect().height;

  /**
   * A folder longer than the chat: the drawer takes all but a strip of chat,
   * scrolls inside, windows its rows, and drags between its bounds.
   */
  async function exerciseLongList(
    rootOf: () => HTMLElement,
    surface: Surface,
    shotWindow: any,
  ) {
    const handle = await api.startTaskProgressReplay({
      surface: surfaceOf(surface),
      historyTurns: 4,
      user: {
        selectedCollectionContexts: [
          {
            collectionId: longCollection.id,
            name: longCollection.name,
            libraryID,
          },
        ],
      },
    });
    const root = rootOf();
    const view = part(root);
    try {
      await until(() => {
        api.flushTaskProgress();
        return Boolean(
          api.getTaskProgressSnapshot(handle.conversationKey)?.listingLoaded,
        );
      }, "the long folder lists");
      await settleRow(rootOf, "open", `long list (${surface})`);
      assert.equal(view.count(), `0 of ${LONG_COUNT} read`);
      view.box.scrollTop = Math.max(
        0,
        (view.box.scrollHeight - view.box.clientHeight) / 2,
      );
      await Zotero.Promise.delay(80);
      const scrollTop = view.box.scrollTop;
      const anchor = readingAnchor(view.box);
      const shell = view.shell.getBoundingClientRect();
      const closedBox = heightOf(view.box);
      view.row.click();
      if (surface === "independent") {
        await Zotero.Promise.delay(70);
        await capture(shotWindow, "tp-dropdown-mid-animation.png");
      }
      await settle(view, "open", `long list (${surface})`);
      assertAttached(view, surface);
      assertChatBelow(view, root, surface);
      assert.closeTo(
        shownChatHeight(view),
        CHAT_STRIP,
        1,
        `a long list takes all but the chat strip (${surface})`,
      );
      assert.isAbove(
        view.body.scrollHeight,
        view.body.clientHeight + 100,
        "and scrolls inside",
      );
      assert.closeTo(view.box.scrollTop, scrollTop, 1, "scrollTop is kept");
      assert.closeTo(
        anchor.node.getBoundingClientRect().top -
          view.box.getBoundingClientRect().top,
        anchor.offset,
        1,
        "the reading anchor stays where it was",
      );
      assert.lengthOf(view.items(), 80, "one window of rows");
      await capture(shotWindow, `tp-dropdown-long-${surface}.png`);
      view.body.scrollTop = view.body.scrollHeight;
      await until(
        () => view.items().length === LONG_COUNT,
        () => `scrolling the drawer adds rows (${view.items().length})`,
      );
      view.body.scrollTop = 0;

      // Drag to about half of the chat area.
      const half = Math.round(shell.height / 2);
      await dragGrip(view, half - heightOf(view.drawer));
      assert.closeTo(heightOf(view.drawer), half, 1.5, "dragged to half");
      assert.closeTo(heightOf(view.box), closedBox - half, 1.5);
      assertChatBelow(view, root, surface);
      await capture(shotWindow, `tp-dropdown-dragged-${surface}.png`);
      await dragGrip(view, -5000);
      assert.closeTo(heightOf(view.drawer), DRAWER_MIN, 1, "down to its least");
      await dragGrip(view, 5000);
      assert.closeTo(
        shownChatHeight(view),
        CHAT_STRIP,
        1,
        "up to the chat strip",
      );
      await dragGrip(view, half - heightOf(view.drawer));
      assert.closeTo(heightOf(view.drawer), half, 1.5);
      // The dragged height is kept when the drawer opens again.
      view.row.click();
      await settle(view, "closed", `long list (${surface})`);
      assert.closeTo(heightOf(view.box), closedBox, 1);
      view.row.click();
      await settle(view, "open", `long list again (${surface})`);
      assert.closeTo(heightOf(view.drawer), half, 1.5, "remembered");
      // Double-click: back to the content's height, up to the strip.
      view.grip.dispatchEvent(
        new (root.ownerDocument.defaultView as any).MouseEvent("dblclick", {
          bubbles: true,
          cancelable: true,
        }),
      );
      await Zotero.Promise.delay(60);
      assert.closeTo(shownChatHeight(view), CHAT_STRIP, 1, "reset");
      view.row.click();
      await settle(view, "closed", `long list (${surface})`);
    } finally {
      handle.finish();
    }
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    win = Zotero.getMainWindow();
    // A window tall enough that a four-paper list fits above the chat strip
    // in every sidebar layout; restored afterwards.
    if (win.outerHeight < 900) {
      savedWindowSize = { width: win.outerWidth, height: win.outerHeight };
      win.resizeTo(win.outerWidth, 900);
      const deadline = Date.now() + 5000;
      while (win.outerHeight < 900 && Date.now() < deadline)
        await Zotero.Promise.delay(50);
    }
    savedLayout = Zotero.Prefs.get(layoutPref, true);
    // Zotero raises its own banners (post-upgrade, sync reminder, ...) a while
    // after startup, above every pane: arriving mid-measurement, one moves
    // the whole sidebar by its height. Keep them out of this file's layout.
    const style = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "style",
    );
    style.textContent = ".banner-container { display: none !important; }";
    win.document.documentElement.appendChild(style);
    bannerStyle = style;
    for (const [key, value] of agentPrefs) {
      savedAgentPrefs.set(key, Zotero.Prefs.get(key, true));
      Zotero.Prefs.set(key, value as never, true);
    }
    libraryID = Zotero.Libraries.userLibraryID;
    collection = new Zotero.Collection();
    (collection as { libraryID: number }).libraryID = libraryID;
    collection.name = `Drift ${Date.now()}`;
    await collection.saveTx();
    for (const [index, paper] of PAPERS.entries()) {
      const fixture = await api.createPaperWithPdfFixture({
        title: paper.title,
        pdfTitle: paper.title,
        pages: [SNIPPETS[index] || `${paper.title} evidence.`],
      });
      fixtures.push(fixture);
      const item = Zotero.Items.get(fixture.parentItemId);
      item.setCreators([
        { creatorType: "author", firstName: "Test", lastName: paper.author },
      ]);
      item.setField("date", "2021");
      item.setCollections([collection.id]);
      item.addTag(index % 2 ? "drift" : "place cells");
      await item.saveTx();
    }
    longCollection = new Zotero.Collection();
    (longCollection as { libraryID: number }).libraryID = libraryID;
    longCollection.name = `Drift long ${Date.now()}`;
    await longCollection.saveTx();
    await Zotero.DB.executeTransaction(async () => {
      for (let index = 0; index < LONG_COUNT; index++) {
        const item = new Zotero.Item("journalArticle");
        item.libraryID = libraryID;
        item.setField("title", `Drift study ${index + 1}`);
        item.setField("date", `${2000 + (index % 25)}`);
        item.setCollections([longCollection.id]);
        await item.save();
        longItems.push(item);
      }
    });
  });

  after(async function () {
    await api.reset();
    for (const fixture of fixtures) await api.cleanupFixture(fixture);
    await collection?.eraseTx().catch(() => undefined);
    if (longItems.length) {
      await Zotero.Items.erase(longItems.map((item) => item.id)).catch(
        () => undefined,
      );
    }
    await longCollection?.eraseTx().catch(() => undefined);
    for (const [key, value] of savedAgentPrefs) {
      if (value === undefined) Zotero.Prefs.clear(key, true);
      else Zotero.Prefs.set(key, value as never, true);
    }
    if (savedWindowSize) {
      win.resizeTo(savedWindowSize.width, savedWindowSize.height);
      await Zotero.Promise.delay(200);
    }
    if (savedLayout === undefined) Zotero.Prefs.clear(layoutPref, true);
    else Zotero.Prefs.set(layoutPref, savedLayout as string, true);
    bannerStyle?.remove();
    Zotero.debug(`TASK_PROGRESS_SCREENSHOTS ${JSON.stringify(shots)}`, 1);
  });

  for (const layout of ["independent", "stacked"] as const) {
    it(`runs in the sidebar (${layout})`, async function () {
      await openSidebarChat(layout);
      const rootOf = () =>
        activeDetails().querySelector(
          ".llm-dedicated-chat-pane #llm-main",
        ) as HTMLElement;
      await assertPaperChatThreshold(rootOf, layout, win);
      await switchToLibrary(rootOf, layout);
      await exerciseCurtain(rootOf, layout, win);
      await exerciseLibraryRun(rootOf, layout, win);
      await exerciseQuestionHistory(rootOf, layout, win);
      await exerciseDigestRun(rootOf, layout);
      await exercisePartsRun(rootOf, layout);
      await exerciseLongList(rootOf, layout, win);
    });
  }

  it("runs in the standalone window", async function () {
    const { window } = await openStandaloneChat();
    const rootOf = () =>
      window.document.querySelector(
        ".llm-standalone-content #llm-main",
      ) as HTMLElement;
    await assertPaperChatThreshold(rootOf, "standalone", window);
    await switchToLibrary(rootOf, "standalone");
    await exerciseCurtain(rootOf, "standalone", window);
    await exerciseLibraryRun(rootOf, "standalone", window);
    await exerciseQuestionHistory(rootOf, "standalone", window);
    await exerciseDigestRun(rootOf, "standalone");
    await exercisePartsRun(rootOf, "standalone");
    await exerciseLongList(rootOf, "standalone", window);
    await api.closeStandalone();
    // A closed window's elements still report isConnected; its panel must
    // leave the registry, or every later sync keeps repainting it.
    assert.deepEqual(
      api
        .listTaskProgressPanels()
        .filter(
          (panel) => panel.gone || panel.documentURI.includes("standaloneChat"),
        ),
      [],
      "the closed window leaves no Task progress panel behind",
    );
  });
});
