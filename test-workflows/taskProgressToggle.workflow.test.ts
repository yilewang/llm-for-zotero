/**
 * The standalone window's Task progress button, left of Export in the chat's
 * title bar. In a Library chat with nothing added the row is hidden; a click
 * lowers it (the drawer lists nothing yet) and the next raises it. The choice
 * holds for the conversation: a row the user showed stays through a run, and
 * a row the user hid stays hidden while another run declares its steps.
 * Another conversation is back on the automatic rule, and so is this one
 * when the window shows it again. The sidebar header has the same button,
 * left of Open in Window; the Stacked header drops it below its compact
 * width.
 */
import { assert } from "chai";
import { executionCheckpointEvent } from "../src/agent/execution/checkpointEvents";
import type { ExecutionCheckpoint } from "../src/agent/types";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const BUTTON = ".llm-standalone-icon-task-progress";

describe("workflow: task progress button", function () {
  this.timeout(120000);
  const prefs: Array<[string, unknown]> = [
    ["extensions.zotero.llmforzotero.enableAgentMode", true],
    ["extensions.zotero.llmforzotero.lastUsedRuntimeMode", "agent"],
  ];
  const saved = new Map<string, unknown>();
  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | null = null;
  const shots: string[] = [];

  async function until(
    check: () => boolean,
    message: string | (() => string),
    timeout = 15000,
  ) {
    const deadline = Date.now() + timeout;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(25);
    assert.isTrue(check(), typeof message === "function" ? message() : message);
  }

  function standaloneWindow(): any {
    return (Zotero as any).LLMForZotero.data.standaloneWindow;
  }

  function rootOf(): HTMLElement {
    return standaloneWindow().document.querySelector(
      ".llm-standalone-content #llm-main",
    ) as HTMLElement;
  }

  function part() {
    const doc = standaloneWindow().document as Document;
    const root = rootOf();
    return {
      win: standaloneWindow(),
      root,
      actions: Array.from(
        doc.querySelectorAll(".llm-standalone-content-title-actions > button"),
      ) as HTMLButtonElement[],
      button: doc.querySelector(
        `.llm-standalone-content-title-actions ${BUTTON}`,
      ) as HTMLButtonElement,
      exportButton: doc.querySelector(
        ".llm-standalone-content-title-actions .llm-standalone-icon-export",
      ) as HTMLButtonElement,
      row: root.querySelector("#llm-task-progress") as HTMLButtonElement,
      curtain: root.querySelector(".llm-task-progress-curtain") as HTMLElement,
      drawer: root.querySelector("#llm-task-progress-drawer") as HTMLElement,
      papers: () => root.querySelectorAll(".llm-task-paper").length,
      count: () =>
        root.querySelector(".llm-task-progress-count")?.textContent || "",
    };
  }

  function conversationKey(): number {
    return Number(rootOf().dataset.itemId);
  }

  function diagnostics(): string {
    const view = part();
    const key = conversationKey();
    return JSON.stringify({
      key,
      kind: view.root.dataset.conversationKind,
      curtain: view.curtain.dataset.curtain,
      rowHidden: view.row.hidden,
      pressed: view.button?.getAttribute("aria-pressed"),
      label: view.button?.getAttribute("aria-label"),
      display: view.button?.style.display,
      count: view.count(),
      snapshot: api.getTaskProgressSnapshot(key),
    });
  }

  /** The row settled up or down, the button saying the same. */
  async function settleRow(target: "open" | "closed", label: string) {
    await until(
      () => {
        api.flushTaskProgress();
        return part().curtain.dataset.curtain === target;
      },
      () => `${label}: ${diagnostics()}`,
    );
    const view = part();
    assert.equal(view.row.hidden, target === "closed", label);
    assert.equal(
      view.button.getAttribute("aria-pressed"),
      target === "open" ? "true" : "false",
      `${label}: the button is pressed while the row shows`,
    );
    assert.equal(
      view.button.getAttribute("aria-label"),
      target === "open" ? "Hide task progress" : "Show task progress",
      label,
    );
    assert.equal(view.button.title, view.button.getAttribute("aria-label"));
  }

  /** A click on the button; the row starts moving at once. */
  function clickButton(moving: "opening" | "closing", label: string) {
    part().button.click();
    assert.equal(
      part().curtain.dataset.curtain,
      moving,
      `${label}: a click moves the row like any change on screen: ${diagnostics()}`,
    );
  }

  /** A run's outcome ledger with one step in progress. */
  function steps(handle: {
    runId: string;
    conversationKey: number;
  }): ExecutionCheckpoint {
    return {
      version: 1,
      executionId: handle.runId,
      conversationKey: handle.conversationKey,
      conversationGeneration: 0,
      tasks: [
        {
          taskId: `${handle.runId}:task:sort`,
          description: "Sort the unfiled papers into folders",
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
  }

  /** A run in the conversation on screen that declares one step. */
  async function runWithSteps(label: string) {
    const handle = await api.startTaskProgressReplay({
      surface: "standalone",
      historyTurns: 1,
      user: {},
    });
    try {
      await handle.emit(executionCheckpointEvent(undefined, steps(handle)));
      api.flushTaskProgress();
      await until(
        () =>
          Boolean(
            api.getTaskProgressSnapshot(handle.conversationKey)?.planSeen,
          ),
        `${label}: the run declared its steps`,
      );
      // Past the coalesced repaint and the lifecycle's own sync.
      await Zotero.Promise.delay(400);
      api.flushTaskProgress();
    } finally {
      handle.finish();
    }
    await Zotero.Promise.delay(200);
    api.flushTaskProgress();
    return handle;
  }

  async function capture(name: string) {
    shots.push(
      await api.captureStandaloneScreenshot(
        `${Zotero.DataDirectory.dir}/${name}`,
      ),
    );
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    for (const [name, value] of prefs) {
      saved.set(name, Zotero.Prefs.get(name, true));
      Zotero.Prefs.set(name, value as never, true);
    }
    fixture = await api.createPaperWithPdfFixture({
      title: "Representational drift in hippocampal CA1",
      pdfTitle: "Representational drift in hippocampal CA1",
      pages: ["Representational drift evidence."],
    });
  });

  after(async function () {
    await api.closeStandalone().catch(() => undefined);
    await api.reset();
    if (fixture) await api.cleanupFixture(fixture);
    for (const [name, value] of saved) {
      if (value === undefined) Zotero.Prefs.clear(name, true);
      else Zotero.Prefs.set(name, value as never, true);
    }
    Zotero.debug(
      `TASK_PROGRESS_TOGGLE_SCREENSHOTS ${JSON.stringify(shots)}`,
      1,
    );
  });

  it("shows and hides the row from the sidebar header, left of Open in Window", async function () {
    const panel = await api.renderPanelForItem(fixture!.parentItemId);
    const doc = Zotero.getMainWindow().document;
    const body = doc.querySelector(
      `[data-workflow-panel-id="${panel.panelId}"]`,
    ) as HTMLElement;
    assert.isOk(body, "the sidebar panel is rendered");
    assert.isNull(
      body.querySelector(BUTTON),
      "not the standalone title bar's button",
    );
    assert.deepEqual(
      Array.from(body.querySelectorAll(".llm-header-actions > button")).map(
        (node) => (node as HTMLElement).id,
      ),
      [
        "llm-task-progress-toggle",
        "llm-popout",
        "llm-settings",
        "llm-export",
        "llm-clear",
      ],
    );
    const button = body.querySelector(
      "#llm-task-progress-toggle",
    ) as HTMLButtonElement;
    const curtain = () =>
      (body.querySelector(".llm-task-progress-curtain") as HTMLElement).dataset
        .curtain;
    const settle = async (target: "open" | "closed", label: string) => {
      await until(() => {
        api.flushTaskProgress();
        return curtain() === target;
      }, `${label}: curtain ${curtain()}`);
      assert.equal(
        button.getAttribute("aria-pressed"),
        target === "open" ? "true" : "false",
        label,
      );
    };

    const header = body.querySelector(".llm-header") as HTMLElement;
    const layoutPref = "extensions.zotero.llmforzotero.sidebarLayout";
    const savedLayout = Zotero.Prefs.get(layoutPref, true);
    const layout = async (value: "independent" | "stacked") => {
      Zotero.Prefs.set(layoutPref, value, true);
      await until(
        () =>
          doc.documentElement.getAttribute("data-llm-sidebar-layout") === value,
        `${value} layout applies`,
      );
    };
    const width = () => button.getBoundingClientRect().width;
    try {
      await layout("independent");
      await until(() => width() > 0, "a paper chat shows the button");
      await settle("closed", "one paper: the automatic rule hides the row");
      button.click();
      await settle("open", "a click shows the row");
      button.click();
      await settle("closed", "the next click hides it");

      // Independent keeps the button at the compact width too.
      header.style.width = "360px";
      await until(() => width() > 0, "Independent at 360px keeps it");

      await layout("stacked");
      await until(() => width() === 0, "Stacked at 360px drops it");
      header.style.width = "420px";
      await until(() => width() > 0, "Stacked at 420px shows it");
      const actions = body
        .querySelector(".llm-header-actions")!
        .getBoundingClientRect();
      const runtime = body
        .querySelector(".llm-header-runtime-controls")!
        .getBoundingClientRect();
      assert.isAtMost(
        runtime.right,
        actions.left + 0.5,
        "the runtime systems still clear the actions",
      );
    } finally {
      header.style.width = "";
      if (savedLayout === undefined) Zotero.Prefs.clear(layoutPref, true);
      else Zotero.Prefs.set(layoutPref, savedLayout as never, true);
    }
  });

  it("shows and hides the row from the standalone title bar, for the conversation on screen", async function () {
    await api.openStandaloneForItem(fixture!.parentItemId);
    await api.clickStandaloneTab("open");
    await until(
      () => rootOf()?.dataset.conversationKind === "global",
      "the standalone window shows Library chat",
    );
    // A new Library chat (or the empty draft the button takes up again).
    const win = standaloneWindow();
    (rootOf().querySelector("#llm-history-new") as HTMLElement).dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await until(
      () => rootOf()?.dataset.conversationKind === "global",
      "a new Library chat opens",
    );
    await Zotero.Promise.delay(300);
    await api.setTaskProgressComposerContexts({ surface: "standalone" });
    const library = conversationKey();
    assert.isNotOk(
      api.getTaskProgressSnapshot(library)?.planSeen,
      "no run's steps in this Library chat",
    );

    // The button: immediately left of Export, shown, not pressed.
    let view = part();
    assert.isOk(view.button, "the title bar has the button");
    const index = view.actions.indexOf(view.button);
    assert.equal(
      view.actions[index + 1],
      view.exportButton,
      "immediately left of Export",
    );
    assert.deepEqual(
      view.actions.map((node) => node.getAttribute("aria-label")),
      ["Show task progress", "Export", "Delete conversation"],
    );
    assert.notEqual(view.win.getComputedStyle(view.button).display, "none");
    assert.isAbove(view.button.getBoundingClientRect().width, 0);
    assert.closeTo(
      view.button.getBoundingClientRect().width,
      view.exportButton.getBoundingClientRect().width,
      0.01,
      "as wide as Export",
    );
    assert.include(
      String(view.win.getComputedStyle(view.button, "::before").maskImage),
      "action-task-progress.svg",
      "its icon is drawn",
    );
    assert.isNull(
      view.root.querySelector(BUTTON),
      "not in the chat panel's own header",
    );
    await settleRow("closed", "an empty Library chat has no row");
    await capture("tp-toggle-a-hidden.png");

    // Shown on a click, with nothing added: the drawer lists nothing yet.
    clickButton("opening", "show");
    await settleRow("open", "the user showed the row");
    await capture("tp-toggle-b-shown.png");
    view = part();
    view.row.click();
    await until(
      () => part().drawer.dataset.state === "open",
      () => `the drawer opens: ${diagnostics()}`,
    );
    assert.equal(part().papers(), 0, "no papers listed yet");
    part().row.click();
    await until(
      () => part().drawer.dataset.state === "closed",
      "the drawer rolls up",
    );

    // Hidden on the next click.
    clickButton("closing", "hide");
    await settleRow("closed", "the user hid the row");

    // Shown again, then a run: it stays shown.
    clickButton("opening", "show again");
    await settleRow("open", "shown again");
    await runWithSteps("a run while shown");
    await settleRow("open", "a run leaves a row the user showed");
    assert.equal(part().count(), "0/1 steps", diagnostics());

    // Hidden, then another run declares its steps: it stays hidden, though
    // the automatic rule would show it.
    clickButton("closing", "hide again");
    await settleRow("closed", "hidden again");
    await runWithSteps("a run while hidden");
    assert.isTrue(
      api.getTaskProgressSnapshot(library)?.planSeen,
      "the run's steps would show the row",
    );
    await settleRow("closed", "a run does not bring back a row the user hid");
    await capture("tp-toggle-c-hidden-after-run.png");

    // Another conversation: the automatic rule. The one-paper chat has
    // nothing to show; a run's steps there show the row, which the hide
    // in the Library chat does not reach.
    await api.clickStandaloneTab("paper");
    await until(
      () => rootOf()?.dataset.conversationKind === "paper",
      "the standalone window shows the paper chat",
    );
    await settleRow("closed", "the paper chat by the automatic rule");
    assert.notEqual(part().button.style.display, "none", "the button stays");
    await runWithSteps("a run in the paper chat");
    await settleRow("open", "the paper chat's steps show its row");

    // Back to the Library chat: the hide went with the switch, so its run's
    // steps show the row again.
    await api.clickStandaloneTab("open");
    await until(
      () => rootOf()?.dataset.conversationKind === "global",
      "back in Library chat",
    );
    assert.equal(
      conversationKey(),
      library,
      `the Library chat shown is the one the user hid the row in: ${diagnostics()}`,
    );
    await settleRow("open", "the Library chat by the automatic rule");
  });
});
