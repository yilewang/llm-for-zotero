/**
 * Runtime mode switching must leave the chat panel usable.
 *
 * The author's report: after putting the chat panel into Codex mode
 * "everything is stuck and unusable" and Zotero could not even be quit.
 *
 * The mechanism is not a busy main thread. The panel installs a capture-phase
 * ownership fence over pointerdown/mousedown/click/command/keydown/input/
 * change/paste/drop (`enforcePanelOwnershipForEvent` in setupHandlers.ts). When
 * the fence decides the panel no longer owns its own conversation it calls
 * `preventDefault()` + `stopImmediatePropagation()`, so every click and
 * keystroke aimed at the panel is destroyed before any handler -- including the
 * runtime toggle's own -- ever sees it.
 *
 * So the assertions below are about input still reaching the panel, and about
 * the conversation key moving into the key space of the runtime being entered,
 * which is what keeps the panel's scope and its item agreeing.
 */
import "./hostSurfaceBootstrap";
import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";
import { isConversationKeyForKind } from "../src/shared/conversationKeySpace";

const PREF_PREFIX = "extensions.zotero.llmforzotero";

/** The control the reader presses to enter and leave Codex. */
const CODEX_TOGGLE_SELECTOR =
  ".llm-panel-runtime-system-toggle[data-conversation-system='codex']";

const AGENT_AND_CODEX_PREFS = {
  enableAgentMode: true,
  enableClaudeCodeMode: false,
  enableCodexAppServerMode: true,
  conversationSystem: "upstream",
  agentLibraryWriteMode: "auto",
};

async function withPrefs<T>(
  prefs: Record<string, unknown>,
  task: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, unknown>();
  for (const [key, value] of Object.entries(prefs)) {
    const fullKey = `${PREF_PREFIX}.${key}`;
    previous.set(fullKey, Zotero.Prefs.get(fullKey, true));
    Zotero.Prefs.set(fullKey, value as string | number | boolean, true);
  }
  try {
    return await task();
  } finally {
    for (const [fullKey, value] of previous) {
      if (value === undefined) {
        Zotero.Prefs.clear?.(fullKey, true);
      } else {
        Zotero.Prefs.set(fullKey, value as string | number | boolean, true);
      }
    }
  }
}

/**
 * One completed native Codex turn: a stage bracketing a tool call that started
 * and completed. This is what a Codex conversation the user actually worked in
 * leaves behind for the panel to re-render after a runtime switch.
 */
function buildCodexNativeTraceEvents(
  runId: string,
): import("../src/agent/types").AgentRunEventRecord[] {
  const createdAt = Date.now();
  const record = (
    seq: number,
    payload: import("../src/agent/types").AgentEvent,
  ): import("../src/agent/types").AgentRunEventRecord => ({
    runId,
    seq,
    eventType: payload.type,
    payload,
    createdAt: createdAt + seq,
  });
  return [
    record(0, {
      type: "agent_stage",
      stage: "write",
      status: "started",
      toolName: "zotero_tag",
    } as unknown as import("../src/agent/types").AgentEvent),
    record(1, {
      type: "codex_tool_activity",
      itemId: "call-1",
      phase: "started",
      toolName: "zotero_tag",
      toolLabel: "Tag items",
      args: { itemIds: [1], tag: "native-review" },
      workCategory: "write",
      mutability: "write",
    } as unknown as import("../src/agent/types").AgentEvent),
    record(2, {
      type: "codex_tool_activity",
      itemId: "call-1",
      phase: "completed",
      toolName: "zotero_tag",
      toolLabel: "Tag items",
      ok: true,
      text: "Tagged 1 item",
      workCategory: "write",
      mutability: "write",
    } as unknown as import("../src/agent/types").AgentEvent),
    record(3, {
      type: "agent_stage",
      stage: "write",
      status: "completed",
      toolName: "zotero_tag",
    } as unknown as import("../src/agent/types").AgentEvent),
  ];
}

/**
 * A turn recorded before the runtime emitted stages at all: tool work with no
 * `agent_stage` event anywhere, which is what forces the stage projection to
 * reconstruct stages while rendering.
 */
function buildLegacyAgentTraceEvents(
  runId: string,
): import("../src/agent/types").AgentRunEventRecord[] {
  const createdAt = Date.now();
  const record = (
    seq: number,
    payload: import("../src/agent/types").AgentEvent,
  ): import("../src/agent/types").AgentRunEventRecord => ({
    runId,
    seq,
    eventType: payload.type,
    payload,
    createdAt: createdAt + seq,
  });
  return [
    record(0, {
      type: "tool_call",
      callId: "legacy-1",
      name: "zotero_search",
      args: { query: "brain" },
    } as import("../src/agent/types").AgentEvent),
    record(1, {
      type: "tool_result",
      callId: "legacy-1",
      name: "zotero_search",
      ok: true,
      actionReceipts: [],
      content: { summary: "3 items" },
    } as import("../src/agent/types").AgentEvent),
    record(2, {
      type: "tool_call",
      callId: "legacy-2",
      name: "zotero_tag",
      args: { tag: "x" },
    } as import("../src/agent/types").AgentEvent),
    record(3, {
      type: "tool_result",
      callId: "legacy-2",
      name: "zotero_tag",
      ok: true,
      actionReceipts: [],
      content: { summary: "tagged" },
    } as import("../src/agent/types").AgentEvent),
    record(4, {
      type: "final",
      text: "Done.",
    } as import("../src/agent/types").AgentEvent),
  ];
}

/**
 * A native turn the user abandoned by switching runtimes: a stage that opened
 * and a tool call that started, with nothing closing either.
 */
function buildUnfinishedCodexTraceEvents(
  runId: string,
): import("../src/agent/types").AgentRunEventRecord[] {
  const createdAt = Date.now();
  const record = (
    seq: number,
    payload: import("../src/agent/types").AgentEvent,
  ): import("../src/agent/types").AgentRunEventRecord => ({
    runId,
    seq,
    eventType: payload.type,
    payload,
    createdAt: createdAt + seq,
  });
  return [
    record(0, {
      type: "agent_stage",
      stage: "retrieval",
      status: "started",
      toolName: "zotero_search",
    } as import("../src/agent/types").AgentEvent),
    record(1, {
      type: "codex_tool_activity",
      itemId: "open-call",
      phase: "started",
      toolName: "zotero_search",
      toolLabel: "Search library",
      args: { query: "unfinished" },
      workCategory: "retrieval",
      mutability: "read",
    } as import("../src/agent/types").AgentEvent),
    record(2, {
      type: "codex_progress",
      itemId: "open-call",
      text: "Still searching",
      status: "running",
    } as import("../src/agent/types").AgentEvent),
  ];
}

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

/**
 * A `setTimeout(0)` round trip on the panel's own window, so a genuinely busy
 * main thread is reported as such instead of stalling the suite forever.
 */
async function assertMainThreadResponsive(
  label: string,
  budgetMs = 2000,
): Promise<number> {
  const win = Zotero.getMainWindow();
  const started = Date.now();
  const roundTrip = await new Promise<number | null>((resolve) => {
    let settled = false;
    win.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(Date.now() - started);
    }, 0);
    win.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, budgetMs);
  });
  assert.isNotNull(
    roundTrip,
    `${label}: a setTimeout(0) round trip did not complete within ${budgetMs}ms`,
  );
  return roundTrip as number;
}

function getPanelRoot(panelId: string): HTMLElement {
  const doc = Zotero.getMainWindow().document;
  const root = doc.querySelector<HTMLElement>(
    `[data-workflow-panel-id="${panelId}"]`,
  );
  assert.isOk(root, "workflow panel root should be in the document");
  return root as HTMLElement;
}

/**
 * Does a click aimed at the panel still reach a listener on its target?
 *
 * The ownership fence runs at capture on the panel body, so a blocked click
 * never reaches any listener on the element the user aimed at. Probing with an
 * own listener separates "the button's handler decided to do nothing" from
 * "the event was destroyed before the button saw it".
 */
function mouseEventReachesPanelTarget(
  panelId: string,
  selector: string,
  eventType: "click" | "mousedown",
): boolean {
  const root = getPanelRoot(panelId);
  const target = root.querySelector<HTMLElement>(selector);
  assert.isOk(target, `panel should render ${selector}`);
  let reached = 0;
  const probe = () => {
    reached += 1;
  };
  target!.addEventListener(eventType, probe);
  try {
    const eventCtor = (root.ownerDocument.defaultView as any)?.MouseEvent;
    target!.dispatchEvent(
      new eventCtor(eventType, { bubbles: true, cancelable: true }),
    );
  } finally {
    target!.removeEventListener(eventType, probe);
  }
  return reached > 0;
}

/** The click the reader makes; it also performs the switch. */
function clickReachesPanelTarget(panelId: string, selector: string): boolean {
  return mouseEventReachesPanelTarget(panelId, selector, "click");
}

/**
 * The same reachability question aimed at a control the fence does NOT exempt,
 * and with an event the panel does not act on, so a pass means the fence is
 * delivering ordinary pointer input rather than that this particular control is
 * privileged. `#llm-history-toggle` is always rendered and is not a runtime
 * control.
 */
const NON_EXEMPT_PANEL_CONTROL = "#llm-history-toggle";

function pointerReachesPanelTarget(panelId: string, selector: string): boolean {
  return mouseEventReachesPanelTarget(panelId, selector, "mousedown");
}

/**
 * Type into the composer the way a reader does, through the event path.
 *
 * A synthetic `keydown` carries no default action, so this performs the one the
 * browser would: the character is only appended when the keydown survived the
 * capture-phase fence, and the `input` event that tells the panel about it must
 * survive too. Assigning `input.value` directly — as this probe used to — would
 * pass on a panel that destroys every keystroke.
 */
async function typeIntoComposer(
  panelId: string,
  text: string,
): Promise<{
  value: string;
  keystrokesDelivered: number;
  inputsDelivered: number;
}> {
  const root = getPanelRoot(panelId);
  const view = root.ownerDocument.defaultView as any;
  const input = root.querySelector<HTMLTextAreaElement>("#llm-input");
  assert.isOk(input, "composer should be rendered");
  let keystrokesDelivered = 0;
  let inputsDelivered = 0;
  for (const character of text) {
    const keyEvent = new view.KeyboardEvent("keydown", {
      key: character,
      bubbles: true,
      cancelable: true,
    });
    input!.dispatchEvent(keyEvent);
    if (keyEvent.defaultPrevented) break;
    keystrokesDelivered += 1;
    // The default action the fence just allowed.
    input!.value = `${input!.value}${character}`;
    const inputEvent = new view.Event("input", {
      bubbles: true,
      cancelable: true,
    });
    input!.dispatchEvent(inputEvent);
    if (inputEvent.defaultPrevented) break;
    inputsDelivered += 1;
  }
  await Zotero.Promise.delay(50);
  return { value: input!.value, keystrokesDelivered, inputsDelivered };
}

async function clearComposer(panelId: string): Promise<void> {
  const root = getPanelRoot(panelId);
  const view = root.ownerDocument.defaultView as any;
  const input = root.querySelector<HTMLTextAreaElement>("#llm-input");
  if (!input) return;
  input.value = "";
  input.dispatchEvent(new view.Event("input", { bubbles: true }));
  await Zotero.Promise.delay(20);
}

/**
 * The composer must take what the reader types and the panel must see it: the
 * text has to arrive in the panel's own diagnostics, not only in the DOM.
 */
async function assertComposerAcceptsInput(
  panelId: string,
  api: WorkflowTestApi,
  label = "after the switch",
): Promise<void> {
  await clearComposer(panelId);
  const typed = `responsive${Date.now() % 100000}`;
  const result = await typeIntoComposer(panelId, typed);
  assert.equal(
    result.keystrokesDelivered,
    typed.length,
    `${label}: every keystroke the reader types must reach the composer`,
  );
  assert.equal(
    result.inputsDelivered,
    typed.length,
    `${label}: the panel must be told about each keystroke`,
  );
  assert.equal(
    result.value,
    typed,
    `${label}: the composer must hold what the reader typed`,
  );
  const diagnostics = await api.getDiagnostics(panelId);
  assert.equal(
    diagnostics.inputValue,
    typed,
    `${label}: the panel itself must have seen the typed text`,
  );
  await clearComposer(panelId);
}

/**
 * A keystroke aimed at the composer must not be destroyed at capture.
 *
 * Deliberately an unmodified key: the fence exempts application accelerators
 * (Cmd+Q and friends) by design, so probing with one would pass even on a panel
 * that swallows everything the reader actually types.
 */
function keydownReachesComposer(panelId: string): boolean {
  const root = getPanelRoot(panelId);
  const input = root.querySelector<HTMLTextAreaElement>("#llm-input");
  assert.isOk(input, "composer should be rendered");
  let reached = 0;
  const probe = () => {
    reached += 1;
  };
  input!.addEventListener("keydown", probe);
  try {
    input!.dispatchEvent(
      new (root.ownerDocument.defaultView as any).KeyboardEvent("keydown", {
        key: "a",
        bubbles: true,
        cancelable: true,
      }),
    );
  } finally {
    input!.removeEventListener("keydown", probe);
  }
  return reached > 0;
}

/**
 * Cmd+Q typed with focus in the panel must still reach Zotero.
 *
 * This one is a *design exemption*, not evidence that the panel is healthy: the
 * fence deliberately delivers application accelerators it does not bind, so
 * this probe passes on a blocked panel too. It is here because "Zotero cannot
 * even be quit" was the reported symptom, and it must never come back.
 */
function quitShortcutSurvivesPanel(panelId: string): boolean {
  const root = getPanelRoot(panelId);
  const input = root.querySelector<HTMLTextAreaElement>("#llm-input");
  assert.isOk(input, "composer should be rendered");
  const event = new (root.ownerDocument.defaultView as any).KeyboardEvent(
    "keydown",
    { key: "q", metaKey: true, bubbles: true, cancelable: true },
  );
  input!.dispatchEvent(event);
  return !event.defaultPrevented;
}

describe("workflow: runtime mode switch", function () {
  this.timeout(120000);

  let api: WorkflowTestApi;
  const fixtures: WorkflowTestFixture[] = [];

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
    Zotero.Prefs.clear?.(`${PREF_PREFIX}.lastUsedRuntimeMode`, true);
  });

  afterEach(async function () {
    while (fixtures.length) {
      await api.cleanupFixture(fixtures.pop()!);
    }
    await api.reset();
    Zotero.Prefs.clear?.(`${PREF_PREFIX}.lastUsedRuntimeMode`, true);
  });

  async function createPaper(title: string): Promise<WorkflowTestFixture> {
    const fixture = await api.createPaperWithPdfFixture({
      title,
      pdfTitle: `${title} PDF`,
    });
    fixtures.push(fixture);
    return fixture;
  }

  /**
   * What the reader must always be able to do after a runtime switch: type into
   * the composer and have the panel see it, use an ordinary panel control, and
   * quit Zotero.
   *
   * Every probe here except the last is aimed at something the fence does NOT
   * exempt, so none of them can pass on a panel that is refusing its input.
   */
  async function assertPanelStillUsable(
    panelId: string,
    label: string,
  ): Promise<void> {
    await assertMainThreadResponsive(label);
    assert.isTrue(
      keydownReachesComposer(panelId),
      `${label}: a keystroke aimed at the composer must reach it`,
    );
    await assertComposerAcceptsInput(panelId, api, label);
    assert.isTrue(
      pointerReachesPanelTarget(panelId, NON_EXEMPT_PANEL_CONTROL),
      `${label}: pointer input aimed at an ordinary panel control must reach it`,
    );
    assert.isTrue(
      quitShortcutSurvivesPanel(panelId),
      `${label}: Cmd+Q typed in the panel must still reach Zotero`,
    );
  }

  /** Wait for the panel to settle on a runtime, then report its diagnostics. */
  async function waitForConversationSystem(
    panelId: string,
    system: string,
  ): Promise<Awaited<ReturnType<WorkflowTestApi["getDiagnostics"]>>> {
    const deadline = Date.now() + 8000;
    let diagnostics = await api.getDiagnostics(panelId);
    const settled = () =>
      diagnostics.conversationSystem === system &&
      diagnostics.runtimeSystemToggles
        .filter((toggle) => toggle.visible)
        .every((toggle) => !toggle.disabled);
    // The conversation identity changes before the async switch finishes.
    // Clicking back while its control is disabled is ignored by the browser.
    while (!settled() && Date.now() < deadline) {
      await Zotero.Promise.delay(50);
      diagnostics = await api.getDiagnostics(panelId);
    }
    assert.equal(
      diagnostics.conversationSystem,
      system,
      `the panel must settle on the ${system} runtime`,
    );
    assert.isTrue(settled(), "runtime controls must finish switching");
    return diagnostics;
  }

  it("stays responsive returning to Agent mode from an empty Codex conversation", async function () {
    await withPrefs(AGENT_AND_CODEX_PREFS, async () => {
      const paper = await createPaper("Mode Switch Empty");
      const panel = await api.renderPanelForItem(paper.parentItemId);

      const agent = await api.clickPanelRuntimeModeToggle(panel.panelId);
      assert.equal(agent.runtimeMode, "agent");

      const codex = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(codex.conversationSystem, "codex");

      const back = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(back.conversationSystem, "upstream");
      assert.equal(
        back.runtimeMode,
        "agent",
        "returning from Codex restores the agent mode the user had on",
      );

      await assertMainThreadResponsive("empty Codex conversation");
      await assertComposerAcceptsInput(panel.panelId, api, "after the switch");

      const secondCodex = await api.clickPanelSystemToggle(
        panel.panelId,
        "codex",
      );
      assert.equal(secondCodex.conversationSystem, "codex");
      const secondBack = await api.clickPanelSystemToggle(
        panel.panelId,
        "codex",
      );
      assert.equal(secondBack.conversationSystem, "upstream");
      await assertMainThreadResponsive("second empty switch");
    });
  });

  it("stays responsive returning to Agent mode from a Codex conversation with a completed turn", async function () {
    await withPrefs(AGENT_AND_CODEX_PREFS, async () => {
      const paper = await createPaper("Mode Switch Turn");
      const panel = await api.renderPanelForItem(paper.parentItemId);

      const agent = await api.clickPanelRuntimeModeToggle(panel.panelId);
      assert.equal(agent.runtimeMode, "agent");

      const codex = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(codex.conversationSystem, "codex");

      const runId = `mode-switch-${Date.now()}`;
      await api.seedPanelStoredTurn(
        panel.panelId,
        "Tag every paper in this collection",
        "Tagged one item.",
        {
          runMode: "agent",
          agentRunId: runId,
          pendingAgentTraceEvents: buildCodexNativeTraceEvents(runId),
        },
      );
      await Zotero.Promise.delay(200);

      const back = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(back.conversationSystem, "upstream");
      assert.equal(back.runtimeMode, "agent");

      await assertMainThreadResponsive("Codex conversation with a turn");
      await assertComposerAcceptsInput(panel.panelId, api, "after the switch");

      const secondCodex = await api.clickPanelSystemToggle(
        panel.panelId,
        "codex",
      );
      assert.equal(secondCodex.conversationSystem, "codex");
      const secondBack = await api.clickPanelSystemToggle(
        panel.panelId,
        "codex",
      );
      assert.equal(secondBack.conversationSystem, "upstream");
      await assertMainThreadResponsive("second switch after a turn");
    });
  });

  it("stays responsive when the Agent toggle is pressed right after returning from Codex", async function () {
    await withPrefs(AGENT_AND_CODEX_PREFS, async () => {
      const paper = await createPaper("Mode Switch Toggle");
      const panel = await api.renderPanelForItem(paper.parentItemId);

      const codex = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(codex.conversationSystem, "codex");

      const back = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(back.conversationSystem, "upstream");

      const agent = await api.clickPanelRuntimeModeToggle(panel.panelId);
      assert.equal(agent.runtimeMode, "agent");
      await assertMainThreadResponsive("agent toggle after Codex");
      await assertComposerAcceptsInput(panel.panelId, api, "after the switch");

      const chat = await api.clickPanelRuntimeModeToggle(panel.panelId);
      assert.equal(chat.runtimeMode, "chat");
      await assertMainThreadResponsive("chat toggle after Codex");
    });
  });

  it("stays responsive returning to an Agent conversation whose trace predates stages", async function () {
    await withPrefs(AGENT_AND_CODEX_PREFS, async () => {
      const paper = await createPaper("Mode Switch Legacy Trace");
      const panel = await api.renderPanelForItem(paper.parentItemId);

      const agent = await api.clickPanelRuntimeModeToggle(panel.panelId);
      assert.equal(agent.runtimeMode, "agent");

      // The upstream conversation the user comes back to is old: its trace
      // carries no `agent_stage` events, so the stage projection runs on it.
      const legacyRunId = `legacy-trace-${Date.now()}`;
      await api.seedPanelStoredTurn(
        panel.panelId,
        "Summarize this paper and tag it",
        "Done.",
        {
          runMode: "agent",
          agentRunId: legacyRunId,
          pendingAgentTraceEvents: buildLegacyAgentTraceEvents(legacyRunId),
        },
      );
      await Zotero.Promise.delay(200);

      const codex = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(codex.conversationSystem, "codex");

      const unfinishedRunId = `unfinished-${Date.now()}`;
      await api.seedPanelStoredTurn(
        panel.panelId,
        "Start a long native run",
        "Working...",
        {
          runMode: "agent",
          agentRunId: unfinishedRunId,
          pendingAgentTraceEvents:
            buildUnfinishedCodexTraceEvents(unfinishedRunId),
        },
      );
      await Zotero.Promise.delay(200);

      const back = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(back.conversationSystem, "upstream");
      assert.equal(back.runtimeMode, "agent");

      await assertMainThreadResponsive("legacy trace after Codex");
      await assertComposerAcceptsInput(panel.panelId, api, "after the switch");
    });
  });

  // The reproduction of the reported failure. Switching a library conversation
  // into Codex used to declare the new runtime on the panel before the
  // conversation key moved into that runtime's key space, so the panel's own
  // ownership check refused the rest of the switch, the mismatch became
  // permanent, and the fence destroyed every click and keystroke aimed at the
  // panel -- including the one that would switch back.
  it("keeps accepting input after a library conversation enters Codex", async function () {
    await withPrefs(AGENT_AND_CODEX_PREFS, async () => {
      const paper = await createPaper("Mode Switch Library");
      const panel = await api.renderPanelForItem(paper.parentItemId);
      const global = await api.togglePanelConversationMode(panel.panelId);
      assert.equal(global.conversationKind, "global");

      assert.isTrue(
        keydownReachesComposer(panel.panelId),
        "the panel delivers keystrokes before the switch",
      );

      const codex = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(codex.conversationSystem, "codex");
      await assertMainThreadResponsive("library conversation in Codex");
      // The panel settles into the state the reader sees before the fence is
      // probed: the divergence appeared once the switch had finished applying.
      await Zotero.Promise.delay(1500);

      assert.isTrue(
        keydownReachesComposer(panel.panelId),
        "the panel must not destroy keystrokes aimed at the composer after entering Codex",
      );
      await assertComposerAcceptsInput(panel.panelId, api, "after the switch");

      // The click the reader actually makes to go back to the original Agent
      // mode, with a probe on the same element so a swallowed event is told
      // apart from a handler that ran and did nothing.
      assert.isTrue(
        clickReachesPanelTarget(panel.panelId, CODEX_TOGGLE_SELECTOR),
        "the click that returns to Agent mode must reach the Codex toggle",
      );
      const back = await waitForConversationSystem(panel.panelId, "upstream");
      assert.equal(
        back.conversationKind,
        "global",
        "the reader must come back to the library conversation they left",
      );
    });
  });

  it("round trips an empty library conversation between Codex and Agent", async function () {
    await withPrefs(AGENT_AND_CODEX_PREFS, async () => {
      const paper = await createPaper("Mode Switch Library Empty");
      const panel = await api.renderPanelForItem(paper.parentItemId);
      const global = await api.togglePanelConversationMode(panel.panelId);
      assert.equal(global.conversationKind, "global");
      const upstreamKey = global.conversationKey || 0;
      await assertPanelStillUsable(panel.panelId, "library chat before Codex");

      const codex = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(codex.conversationSystem, "codex");
      assert.notEqual(
        codex.conversationKey,
        upstreamKey,
        "entering Codex must move the panel off the upstream library conversation",
      );
      assert.isTrue(
        isConversationKeyForKind("codex", "global", codex.conversationKey || 0),
        `a Codex library chat must use a Codex key, got ${codex.conversationKey}`,
      );
      await assertPanelStillUsable(
        panel.panelId,
        "empty library chat in Codex",
      );

      const back = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(back.conversationSystem, "upstream");
      assert.equal(
        back.conversationKey,
        upstreamKey,
        "returning must land back on the library conversation the reader left",
      );
      await assertPanelStillUsable(
        panel.panelId,
        "empty library chat back in Agent",
      );

      const again = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(again.conversationSystem, "codex");
      assert.equal(
        again.conversationKey,
        codex.conversationKey,
        "re-entering Codex must reuse the Codex library chat, not start a third one",
      );
      await assertPanelStillUsable(panel.panelId, "second entry into Codex");
    });
  });

  it("round trips a library conversation that already carries a turn", async function () {
    await withPrefs(AGENT_AND_CODEX_PREFS, async () => {
      const paper = await createPaper("Mode Switch Library Turn");
      const panel = await api.renderPanelForItem(paper.parentItemId);
      const global = await api.togglePanelConversationMode(panel.panelId);
      assert.equal(global.conversationKind, "global");

      const upstreamRunId = `library-upstream-${Date.now()}`;
      await api.seedPanelStoredTurn(
        panel.panelId,
        "Tag everything I read this week",
        "Tagged one item.",
        {
          runMode: "agent",
          agentRunId: upstreamRunId,
          pendingAgentTraceEvents: buildLegacyAgentTraceEvents(upstreamRunId),
        },
      );
      await Zotero.Promise.delay(200);

      const codex = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(codex.conversationSystem, "codex");
      assert.isTrue(
        isConversationKeyForKind("codex", "global", codex.conversationKey || 0),
        `a Codex library chat must use a Codex key, got ${codex.conversationKey}`,
      );
      await assertPanelStillUsable(
        panel.panelId,
        "library chat with a turn in Codex",
      );

      const codexRunId = `library-codex-${Date.now()}`;
      await api.seedPanelStoredTurn(
        panel.panelId,
        "Now do the same natively",
        "Tagged one item.",
        {
          runMode: "agent",
          agentRunId: codexRunId,
          pendingAgentTraceEvents: buildCodexNativeTraceEvents(codexRunId),
        },
      );
      await Zotero.Promise.delay(200);

      const back = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(back.conversationSystem, "upstream");
      assert.equal(back.conversationKind, "global");
      // Returning from a runtime opens a fresh draft rather than resuming a
      // conversation that already has turns, so only the key space is pinned.
      assert.isTrue(
        isConversationKeyForKind(
          "upstream",
          "global",
          back.conversationKey || 0,
        ),
        `returning must land on an upstream library key, got ${back.conversationKey}`,
      );
      assert.notEqual(
        back.conversationKey,
        codex.conversationKey,
        "returning must not leave the panel on the Codex conversation key",
      );
      await assertPanelStillUsable(
        panel.panelId,
        "library chat with a turn back in Agent",
      );
    });
  });

  it("round trips the standalone Library Chat between Codex and Agent", async function () {
    await withPrefs(AGENT_AND_CODEX_PREFS, async () => {
      const paper = await createPaper("Mode Switch Standalone Library");
      await api.openStandaloneForItem(paper.parentItemId);
      try {
        const library = await api.clickStandaloneTab("open");
        assert.equal(library.conversationKind, "global");
        assert.equal(library.conversationSystem, "upstream");

        const codex = await api.clickStandaloneSystemToggle("codex");
        assert.equal(codex.conversationSystem, "codex");
        assert.isTrue(
          isConversationKeyForKind(
            "codex",
            "global",
            codex.conversationKey || 0,
          ),
          `a standalone Codex library chat must use a Codex key, got ${codex.conversationKey}`,
        );
        await assertMainThreadResponsive("standalone library chat in Codex");

        // The toggle still answering is the proof the window did not go deaf.
        const back = await api.clickStandaloneSystemToggle("codex");
        assert.equal(back.conversationSystem, "upstream");
        assert.equal(back.conversationKind, "global");
        assert.isTrue(
          isConversationKeyForKind(
            "upstream",
            "global",
            back.conversationKey || 0,
          ),
          `returning must land on an upstream library key, got ${back.conversationKey}`,
        );
        assert.notEqual(
          back.conversationKey,
          codex.conversationKey,
          "returning must not leave the window on the Codex conversation key",
        );
        await assertMainThreadResponsive(
          "standalone library chat back in Agent",
        );
      } finally {
        await api.closeStandalone();
      }
    });
  });

  /**
   * The escape hatch itself, tested on the exact state the old bug produced: a
   * panel whose declared runtime no longer matches the conversation it is
   * showing. The toggle must not merely receive the click — it must repair the
   * drift and switch, or the reader is still trapped.
   */
  it("recovers a panel whose declared runtime has drifted when the toggle is pressed", async function () {
    await withPrefs(AGENT_AND_CODEX_PREFS, async () => {
      const paper = await createPaper("Mode Switch Drift Recovery");
      const panel = await api.renderPanelForItem(paper.parentItemId);
      const global = await api.togglePanelConversationMode(panel.panelId);
      assert.equal(global.conversationKind, "global");
      assert.equal(global.conversationSystem, "upstream");

      // Force the drift by hand, exactly as the old switch order produced it:
      // the panel declares Codex while its conversation is still the upstream
      // library chat.
      const main = getPanelRoot(panel.panelId).querySelector<HTMLElement>(
        "#llm-main",
      );
      assert.isOk(main, "the panel root should be rendered");
      main!.dataset.conversationSystem = "codex";

      assert.isFalse(
        keydownReachesComposer(panel.panelId),
        "a drifted panel is expected to refuse ordinary input; the test is worthless otherwise",
      );
      assert.isTrue(
        quitShortcutSurvivesPanel(panel.panelId),
        "even while refusing, the panel must never eat Cmd+Q",
      );

      // The reader's way out.
      assert.isTrue(
        clickReachesPanelTarget(panel.panelId, CODEX_TOGGLE_SELECTOR),
        "the click that ends the blocked state must reach the toggle",
      );
      const recovered = await waitForConversationSystem(panel.panelId, "codex");
      assert.isTrue(
        isConversationKeyForKind(
          "codex",
          "global",
          recovered.conversationKey || 0,
        ),
        `recovery must land on a real Codex conversation, got ${recovered.conversationKey}`,
      );
      await assertPanelStillUsable(panel.panelId, "after drift recovery");

      const back = await api.clickPanelSystemToggle(panel.panelId, "codex");
      assert.equal(back.conversationSystem, "upstream");
      await assertPanelStillUsable(
        panel.panelId,
        "back in Agent after recovery",
      );
    });
  });
});
