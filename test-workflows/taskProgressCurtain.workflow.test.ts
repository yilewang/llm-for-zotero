/**
 * The Task progress row is there only when it has something to show, and it
 * lowers from under the header, or rises back, like a curtain. A library chat
 * with nothing added has no row; a paper added lowers it, frame by frame, the
 * chat below following it down without a jump; taking the paper away raises
 * it. A run's steps show it with nothing added, and keep it when the last
 * context goes. A conversation switch puts it in its state at once, reduced
 * motion moves nothing, and the chat keeps its bottom or its reading place.
 */
import { assert } from "chai";
import { executionCheckpointEvent } from "../src/agent/execution/checkpointEvents";
import type { ExecutionCheckpoint } from "../src/agent/types";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const TITLES = [
  "Representational drift in hippocampal CA1",
  "Synaptic turnover predicts place field drift",
];
/** The collapsed card: the 38px row and its 1px borders. */
const CARD_HEIGHT = 40;
/** The gap between the card and the chat below it. */
const CARD_GAP = 6;
const REDUCED_MOTION_PREF = "ui.prefersReducedMotion";

type Sample = {
  t: number;
  state: string;
  curtainTop: number;
  curtainBottom: number;
  cardTop: number;
  cardBottom: number;
  boxTop: number;
  opacity: number;
};

describe("workflow: task progress curtain", function () {
  this.timeout(120000);
  const prefs: Array<[string, unknown]> = [
    ["extensions.zotero.llmforzotero.enableAgentMode", true],
    ["extensions.zotero.llmforzotero.lastUsedRuntimeMode", "agent"],
  ];
  const saved = new Map<string, unknown>();
  let api: WorkflowTestApi;
  let win: any;
  let libraryID: number;
  const fixtures: WorkflowTestFixture[] = [];
  const shots: string[] = [];

  async function until(
    check: () => boolean,
    message: string | (() => string),
    timeout = 15000,
  ) {
    const deadline = Date.now() + timeout;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(20);
    assert.isTrue(check(), typeof message === "function" ? message() : message);
  }

  function rootOf(panelId: string): HTMLElement {
    return win.document.querySelector(
      `[data-workflow-panel-id="${panelId}"]`,
    ) as HTMLElement;
  }

  function view(panelId: string) {
    const root = rootOf(panelId);
    const main = root.querySelector("#llm-main") as HTMLElement;
    return {
      root,
      main,
      curtain: root.querySelector(".llm-task-progress-curtain") as HTMLElement,
      card: root.querySelector(".llm-task-progress-card") as HTMLElement,
      row: root.querySelector("#llm-task-progress") as HTMLButtonElement,
      shell: root.querySelector("#llm-chat-shell") as HTMLElement,
      box: root.querySelector("#llm-chat-box") as HTMLElement,
      drawer: root.querySelector("#llm-task-progress-drawer") as HTMLElement,
      steps: root.querySelector(".llm-task-progress-steps") as HTMLElement,
      count: () =>
        root.querySelector(".llm-task-progress-count")?.textContent || "",
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

  function paperRef(index: number) {
    return {
      libraryID,
      itemId: fixtures[index].parentItemId,
      contextItemId: fixtures[index].pdfAttachmentId,
      title: TITLES[index],
    };
  }

  /** Put these papers in the panel's context bar; none empties it. */
  async function contextBar(panelId: string, papers: number[]) {
    await api.setTaskProgressComposerContexts({
      panelId,
      paperContexts: papers.map((index) => paperRef(index)),
    });
  }

  /** A fresh Library chat with nothing added, in a synthetic panel. */
  async function emptyLibraryChat(): Promise<{
    panelId: string;
    restore: () => void;
  }> {
    const panel = await api.renderPanelForItem(fixtures[0].parentItemId);
    const restore = showOnScreen(panel.panelId);
    const kind = () => view(panel.panelId).main.dataset.conversationKind;
    if (kind() !== "global")
      await api.togglePanelConversationMode(panel.panelId);
    await until(() => kind() === "global", "the panel shows Library chat");
    await api.startNewPanelConversation(panel.panelId, {
      allowReusedDraft: true,
    });
    await contextBar(panel.panelId, []);
    await until(() => {
      api.flushTaskProgress();
      return view(panel.panelId).curtain.dataset.curtain === "closed";
    }, "the empty Library chat settles with no row");
    return { panelId: panel.panelId, restore };
  }

  /** Every frame from now until `ms` after `act` resolves. */
  async function sampleMotion(
    panelId: string,
    act: () => Promise<unknown>,
    ms = 700,
  ): Promise<Sample[]> {
    const samples: Sample[] = [];
    const tp = view(panelId);
    const start = win.performance.now();
    let running = true;
    const take = () => {
      const curtain = tp.curtain.getBoundingClientRect();
      const card = tp.card.getBoundingClientRect();
      samples.push({
        t: Math.round(win.performance.now() - start),
        state: tp.curtain.dataset.curtain || "",
        curtainTop: curtain.top,
        curtainBottom: curtain.bottom,
        cardTop: card.top,
        cardBottom: card.bottom,
        boxTop: tp.box.getBoundingClientRect().top,
        opacity: Number(win.getComputedStyle(tp.card).opacity),
      });
    };
    const tick = () => {
      if (!running) return;
      take();
      win.requestAnimationFrame(tick);
    };
    win.requestAnimationFrame(tick);
    await act();
    await Zotero.Promise.delay(ms);
    running = false;
    take();
    return samples;
  }

  const dump = (samples: Sample[]) =>
    JSON.stringify(
      samples.map((sample) => [
        sample.t,
        sample.state,
        Math.round(sample.boxTop * 10) / 10,
        Math.round((sample.curtainBottom - sample.curtainTop) * 10) / 10,
        Math.round(sample.opacity * 100) / 100,
      ]),
    );

  /**
   * The row moved over several frames: the curtain through partial heights,
   * the card sliding inside it from above (its lower edge never below the
   * curtain's), and the chat following one way only, with no jump.
   */
  function assertCurtainMotion(
    samples: Sample[],
    moving: "opening" | "closing",
    from: number,
    to: number,
  ) {
    const frames = samples.filter((sample) => sample.state === moving);
    assert.isAtLeast(
      frames.length,
      3,
      `the row ${moving === "opening" ? "lowers" : "rises"} over several frames: ${dump(samples)}`,
    );
    const full = CARD_HEIGHT + CARD_GAP;
    const partial = frames.filter((sample) => {
      const height = sample.curtainBottom - sample.curtainTop;
      return height > 1 && height < full - 1;
    });
    assert.isAtLeast(
      partial.length,
      2,
      `the curtain passes through partial heights: ${dump(samples)}`,
    );
    for (const sample of frames) {
      assert.isAtMost(
        sample.cardTop,
        sample.curtainTop + 0.5,
        `the card slides from above the curtain's edge: ${dump(samples)}`,
      );
      assert.isAtMost(
        sample.cardBottom,
        sample.curtainBottom + 0.5,
        `the card's lower edge rides the curtain's: ${dump(samples)}`,
      );
    }
    const fading = frames.filter(
      (sample) => sample.opacity > 0.02 && sample.opacity < 0.98,
    );
    assert.isAtLeast(fading.length, 1, `the card fades: ${dump(samples)}`);
    const sign = Math.sign(to - from);
    for (let index = 1; index < samples.length; index++) {
      assert.isAtLeast(
        (samples[index].boxTop - samples[index - 1].boxTop) * sign,
        -0.5,
        `the chat moves one way only: ${dump(samples)}`,
      );
    }
    const between = new Set(
      samples
        .map((sample) => sample.boxTop)
        .filter((top) => (top - from) * sign > 0.5 && (to - top) * sign > 0.5)
        .map((top) => Math.round(top)),
    );
    // Native/headless hosts may withhold rAF for most of a transition while
    // still exposing distinct intermediate layout positions before and after
    // the stall. Two positions, together with the partial-height, fade and
    // monotonicity checks above, prove that the chat did not jump end-to-end.
    assert.isAtLeast(
      between.size,
      2,
      `the chat passes through the way, never jumping: ${dump(samples)}`,
    );
    assert.closeTo(samples[samples.length - 1].boxTop, to, 1, dump(samples));
  }

  /** The row down and settled: full height, under the header, chat below. */
  function assertRowDown(panelId: string) {
    const tp = view(panelId);
    assert.equal(tp.curtain.dataset.curtain, "open");
    assert.isFalse(tp.row.hidden);
    assert.equal(tp.shell.getAttribute("data-task-progress-curtain"), "open");
    assert.equal(tp.curtain.style.height, "", "no height left behind");
    assert.equal(tp.card.style.height, "");
    const card = tp.card.getBoundingClientRect();
    assert.closeTo(card.height, CARD_HEIGHT, 1, "the card at full height");
    assert.closeTo(tp.row.getBoundingClientRect().height, 38, 1);
    assert.isAtMost(
      Math.abs(card.top - tp.shell.getBoundingClientRect().top),
      4,
      "the card sits at the top of the chat area",
    );
    assert.closeTo(
      tp.box.getBoundingClientRect().top,
      card.bottom + CARD_GAP,
      1,
      "the chat starts below the card",
    );
    assert.equal(win.getComputedStyle(tp.card).opacity, "1");
    assert.equal(win.getComputedStyle(tp.card).transform, "none");
  }

  /** The row up and gone: no box, no height. */
  function assertRowGone(panelId: string) {
    const tp = view(panelId);
    assert.equal(tp.curtain.dataset.curtain, "closed");
    assert.isTrue(tp.row.hidden);
    assert.isTrue(tp.curtain.hidden);
    assert.isNull(tp.shell.getAttribute("data-task-progress-curtain"));
    assert.equal(tp.card.getBoundingClientRect().height, 0, "no height");
    assert.equal(tp.row.getBoundingClientRect().height, 0);
    assert.isFalse(tp.shell.classList.contains("llm-task-progress-present"));
  }

  /** Every Task progress motion state a panel passes through while `act` runs. */
  async function recordStates(
    panelId: string,
    act: () => Promise<unknown>,
  ): Promise<string[]> {
    const states: string[] = [];
    // Each record holds the value it replaced, so a value set and replaced
    // within one task is still seen; the values left at the end close it.
    const observer = new win.MutationObserver((mutations: MutationRecord[]) => {
      for (const mutation of mutations) {
        if (mutation.oldValue) states.push(mutation.oldValue);
      }
    });
    const attributeFilter = ["data-curtain", "data-task-progress-curtain"];
    observer.observe(rootOf(panelId), {
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter,
    });
    try {
      await act();
      await Zotero.Promise.delay(500);
      api.flushTaskProgress();
    } finally {
      for (const mutation of observer.takeRecords())
        if (mutation.oldValue) states.push(mutation.oldValue);
      observer.disconnect();
    }
    for (const node of Array.from(
      rootOf(panelId).querySelectorAll(
        "[data-curtain], [data-task-progress-curtain]",
      ),
    ) as Element[]) {
      for (const name of attributeFilter) {
        const value = node.getAttribute(name);
        if (value) states.push(value);
      }
    }
    return states;
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
    for (const title of TITLES) {
      fixtures.push(
        await api.createPaperWithPdfFixture({
          title,
          pdfTitle: title,
          pages: [`${title} evidence.`],
        }),
      );
    }
  });

  after(async function () {
    await api.reset();
    for (const fixture of fixtures) await api.cleanupFixture(fixture);
    for (const [name, value] of saved) {
      if (value === undefined) Zotero.Prefs.clear(name, true);
      else Zotero.Prefs.set(name, value as never, true);
    }
    Zotero.debug(
      `TASK_PROGRESS_CURTAIN_SCREENSHOTS ${JSON.stringify(shots)}`,
      1,
    );
  });

  it("shows no row in an empty Library chat, lowers it when a paper is added and raises it when the paper goes", async function () {
    const { panelId, restore } = await emptyLibraryChat();
    try {
      assertRowGone(panelId);
      const rest = view(panelId).box.getBoundingClientRect().top;
      await capture(panelId, "tp-curtain-a-empty-library.png");

      const lowering = await sampleMotion(panelId, () =>
        contextBar(panelId, [1]),
      );
      await until(
        () => view(panelId).curtain.dataset.curtain === "open",
        "the row settles down",
      );
      const down = view(panelId).box.getBoundingClientRect().top;
      assert.isAbove(down, rest + 20, "the chat moved down for the row");
      assertCurtainMotion(lowering, "opening", rest, down);
      assertRowDown(panelId);
      assert.equal(view(panelId).count(), "1 paper in scope");
      await capture(panelId, "tp-curtain-b-one-paper.png");

      const rising = await sampleMotion(panelId, () => contextBar(panelId, []));
      assertCurtainMotion(rising, "closing", down, rest);
      assertRowGone(panelId);

      // One frame in the middle of the motion, for the record: the first
      // frame past 40% of the way down.
      const loweringAgain = contextBar(panelId, [1]);
      const full = CARD_HEIGHT + CARD_GAP;
      for (
        const deadline = Date.now() + 2000;
        Date.now() < deadline &&
        !(
          view(panelId).curtain.dataset.curtain === "opening" &&
          view(panelId).curtain.getBoundingClientRect().height >= full * 0.4
        );
      )
        await new Promise((resolve) => win.requestAnimationFrame(resolve));
      const mid = view(panelId);
      const midState = mid.curtain.dataset.curtain;
      const midHeight = mid.curtain.getBoundingClientRect().height;
      await capture(panelId, "tp-curtain-c-mid-motion.png");
      await loweringAgain;
      assert.equal(midState, "opening", "the capture is mid-way");
      assert.isAbove(midHeight, 0);
      assert.isBelow(midHeight, full);
      await until(
        () => view(panelId).curtain.dataset.curtain === "open",
        "the row settles down again",
      );

      // Rapid changes reverse mid-way and land where the last one points.
      await contextBar(panelId, []);
      await Zotero.Promise.delay(60);
      assert.equal(view(panelId).curtain.dataset.curtain, "closing");
      await contextBar(panelId, [1]);
      await Zotero.Promise.delay(40);
      await contextBar(panelId, []);
      await contextBar(panelId, [0, 1]);
      await until(
        () => view(panelId).curtain.dataset.curtain === "open",
        "the last change, a paper added, wins",
      );
      await Zotero.Promise.delay(100);
      assertRowDown(panelId);
      await contextBar(panelId, [0]);
      assert.equal(
        view(panelId).curtain.dataset.curtain,
        "open",
        "a paper more or less leaves the row as it is",
      );
      await contextBar(panelId, []);
      await contextBar(panelId, [1]);
      await contextBar(panelId, []);
      await until(
        () => view(panelId).curtain.dataset.curtain === "closed",
        "the last change, the context emptied, wins",
      );
      await Zotero.Promise.delay(100);
      assertRowGone(panelId);
      assert.closeTo(view(panelId).box.getBoundingClientRect().top, rest, 1);
    } finally {
      restore();
    }
  });

  it("lowers the row for a run's steps with nothing added, and keeps it when the last context goes", async function () {
    const { panelId, restore } = await emptyLibraryChat();
    const handle = await api.startTaskProgressReplay({
      panelId,
      historyTurns: 1,
      user: {},
    });
    try {
      api.flushTaskProgress();
      await Zotero.Promise.delay(100);
      assertRowGone(panelId);
      assert.equal(
        api.getTaskProgressSnapshot(handle.conversationKey)?.runState,
        "working",
        "a run with no steps shows nothing",
      );
      const sort = "Sort the unfiled papers into folders";
      const ledger: ExecutionCheckpoint = {
        version: 1,
        executionId: handle.runId,
        conversationKey: handle.conversationKey,
        conversationGeneration: 0,
        tasks: [
          {
            taskId: `${handle.runId}:task:sort`,
            description: sort,
            dependencies: [],
            status: "in_progress",
            journalActionIds: [],
            verifiedReceiptIds: [],
            readEvidenceIds: [],
            materialRefs: [],
            createdAt: 1,
            updatedAt: 2,
            effect: "mutation",
            origin: "model",
          },
        ],
        createdAt: 1,
        updatedAt: 2,
      };
      const rest = view(panelId).box.getBoundingClientRect().top;
      const lowering = await sampleMotion(panelId, () =>
        handle.emit(executionCheckpointEvent(undefined, ledger)),
      );
      await until(
        () => view(panelId).curtain.dataset.curtain === "open",
        "the row settles down for the run's steps",
      );
      assertCurtainMotion(
        lowering,
        "opening",
        rest,
        view(panelId).box.getBoundingClientRect().top,
      );
      assertRowDown(panelId);
      assert.equal(view(panelId).row.dataset.state, "working");
      assert.equal(view(panelId).count(), "0/1 steps");
      view(panelId).row.click();
      await until(() => !view(panelId).steps.hidden, "the steps show");
      assert.include(view(panelId).steps.textContent || "", sort);
      view(panelId).row.click();
      await until(
        () => view(panelId).drawer.dataset.state === "closed",
        "the drawer rolls up",
      );

      // A paper added and taken away again: the steps keep the row.
      const states = await recordStates(panelId, async () => {
        await contextBar(panelId, [1]);
        await contextBar(panelId, []);
      });
      assert.notInclude(states, "closing", JSON.stringify(states));
      assert.notInclude(states, "opening", JSON.stringify(states));
      assertRowDown(panelId);
      assert.equal(view(panelId).count(), "0/1 steps");
    } finally {
      handle.finish();
      // The replay's conversation persisted nothing: a later "new chat" would
      // take it up again as an empty draft, steps and all.
      await api.clickPanelDelete(panelId).catch(() => undefined);
      restore();
    }
  });

  it("puts the row in its state at once on a conversation switch", async function () {
    const { panelId, restore } = await emptyLibraryChat();
    try {
      await contextBar(panelId, [1]);
      await until(
        () => view(panelId).curtain.dataset.curtain === "open",
        "the row is down in Library chat",
      );
      const kind = () => view(panelId).main.dataset.conversationKind;
      // To the one-paper chat: no row there, and no motion getting there.
      const toPaper = await recordStates(panelId, () =>
        api.togglePanelConversationMode(panelId),
      );
      assert.equal(kind(), "paper");
      assert.notInclude(toPaper, "closing", JSON.stringify(toPaper));
      assert.notInclude(toPaper, "opening", JSON.stringify(toPaper));
      assertRowGone(panelId);
      // Back to the Library chat: the row is down, at once.
      const toLibrary = await recordStates(panelId, () =>
        api.togglePanelConversationMode(panelId),
      );
      assert.equal(kind(), "global");
      assert.notInclude(toLibrary, "opening", JSON.stringify(toLibrary));
      assert.notInclude(toLibrary, "closing", JSON.stringify(toLibrary));
      assertRowDown(panelId);
      // A switch while the row rises lands on the other chat's state.
      await contextBar(panelId, []);
      assert.equal(view(panelId).curtain.dataset.curtain, "closing");
      await api.togglePanelConversationMode(panelId);
      api.flushTaskProgress();
      assert.equal(kind(), "paper");
      assertRowGone(panelId);
    } finally {
      restore();
    }
  });

  it("moves nothing when the system asks for reduced motion", async function () {
    const hadValue = Services.prefs.prefHasUserValue(REDUCED_MOTION_PREF);
    const previous = Services.prefs.getIntPref(REDUCED_MOTION_PREF, 0);
    const { panelId, restore } = await emptyLibraryChat();
    try {
      Services.prefs.setIntPref(REDUCED_MOTION_PREF, 1);
      await until(
        () => win.matchMedia("(prefers-reduced-motion: reduce)").matches,
        "the window reports reduced motion",
      );
      const tp = view(panelId);
      assert.equal(win.getComputedStyle(tp.curtain).transitionDuration, "0s");
      const lowering = await recordStates(panelId, () =>
        contextBar(panelId, [1]),
      );
      assert.notInclude(lowering, "opening", JSON.stringify(lowering));
      assertRowDown(panelId);
      const rising = await recordStates(panelId, () => contextBar(panelId, []));
      assert.notInclude(rising, "closing", JSON.stringify(rising));
      assertRowGone(panelId);
    } finally {
      if (hadValue) Services.prefs.setIntPref(REDUCED_MOTION_PREF, previous);
      else Services.prefs.clearUserPref(REDUCED_MOTION_PREF);
      restore();
    }
    await until(
      () => !win.matchMedia("(prefers-reduced-motion: reduce)").matches,
      "motion is back",
    );
  });

  it("keeps the chat at its bottom, or at the reading place, while the row lowers and rises", async function () {
    const { panelId, restore } = await emptyLibraryChat();
    const handle = await api.startTaskProgressReplay({
      panelId,
      historyTurns: 8,
      user: {},
    });
    try {
      const tp = () => view(panelId);
      await until(
        () => tp().box.scrollHeight > tp().box.clientHeight + 400,
        "the chat has history to scroll",
      );
      const bottomGap = () =>
        tp().box.scrollHeight - tp().box.clientHeight - tp().box.scrollTop;
      const settled = (state: "open" | "closed") =>
        until(
          () => tp().curtain.dataset.curtain === state,
          `the row settles ${state}`,
        ).then(() => Zotero.Promise.delay(60));

      tp().box.scrollTop = tp().box.scrollHeight;
      await Zotero.Promise.delay(100);
      assert.isAtMost(bottomGap(), 1, "at the bottom");
      await contextBar(panelId, [1]);
      await settled("open");
      assert.isAtMost(bottomGap(), 1, "still at the bottom, row down");
      await contextBar(panelId, []);
      await settled("closed");
      assert.isAtMost(bottomGap(), 1, "still at the bottom, row up");

      tp().box.scrollTop = Math.round(
        (tp().box.scrollHeight - tp().box.clientHeight) / 2,
      );
      await Zotero.Promise.delay(120);
      // The first message in view, by its timestamp: the chat may render
      // its messages anew (the context bar's refresh does).
      const top = tp().box.getBoundingClientRect().top;
      const node = (
        Array.from(
          tp().box.querySelectorAll(
            ".llm-message-wrapper[data-message-timestamp]",
          ),
        ) as HTMLElement[]
      ).find((candidate) => candidate.getBoundingClientRect().top >= top);
      assert.isOk(node, "a message is in view");
      const anchor = {
        timestamp: node!.dataset.messageTimestamp,
        offset: node!.getBoundingClientRect().top - top,
      };
      const offset = () => {
        const current = tp().box.querySelector(
          `.llm-message-wrapper[data-message-timestamp="${anchor.timestamp}"]`,
        ) as HTMLElement | null;
        assert.isOk(current, "the anchor message is still there");
        return (
          current!.getBoundingClientRect().top -
          tp().box.getBoundingClientRect().top
        );
      };
      await contextBar(panelId, [1]);
      await settled("open");
      assert.closeTo(offset(), anchor.offset, 1, "the reading place, row down");
      await contextBar(panelId, []);
      await settled("closed");
      assert.closeTo(offset(), anchor.offset, 1, "the reading place, row up");
    } finally {
      handle.finish();
      await api.clickPanelDelete(panelId).catch(() => undefined);
      restore();
    }
  });
});
