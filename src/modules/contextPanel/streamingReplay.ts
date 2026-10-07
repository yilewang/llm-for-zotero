/** Deterministic native workflow fixture; never invoked by production UI. */
import { createAgentTurnEventHandler } from "./agentMode/agentEngine";
import {
  buildAgentEngineDepsForTests,
  getConversationKey,
  refreshConversationPanels,
  requestChatScrollFollowBottom,
} from "./chat";
import {
  chatHistory,
  tryBeginRequest,
  nextRequestId,
  finishRequest,
} from "./state";
import { composeContextStore } from "./contexts/composeContextStore";
import { agentRunTraceCache } from "./agentState";
import { getConversationWriteGeneration } from "../../shared/conversationWriteFence";
import { createBlockStreamCoalescer } from "./blockStreamCoalescer";
import { persistChatScrollSnapshotForConversationKey } from "./chatScrollSnapshots";
import type { AgentEvent, AgentRunEventRecord } from "../../agent/types";
import type {
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
} from "../../agent/execution/types";
import type { Message } from "./types";
import {
  beginTaskRun,
  clearTaskProgress,
  getTaskProgress,
  setTaskOutcomes,
  taskTurnIndexFor,
} from "./taskProgress/store";
import { flushTaskProgressPanels } from "./taskProgress/panel";

/** The run events Task progress rebuilds from; streaming text reads none. */
const RUN_EVENTS_TABLE = "llm_for_zotero_agent_run_events";

export type StreamingReplayResult = {
  historyTurns: number;
  chunks: number;
  runMode: "agent" | "chat";
  wrapperReplacements: number;
  progressReplacements: number;
  progressMutations: number;
  focusPreserved: boolean;
  manualScrollDelta: number;
  followBottomGap: number;
  exactReasoning: boolean;
  statusVisible: boolean;
  progressUpdatePreserved: boolean;
  finalAnswerVisible: boolean;
  answerVisibleBeforeFinal: boolean;
  actionCardHiddenWhileStreaming: boolean;
  actionCardAfterFinalAnswer: boolean;
  streamingQuoteVisible: boolean;
  streamingQuoteMarkersAbsent: boolean;
  refreshedQuoteVisible: boolean;
  refreshedQuoteMarkersAbsent: boolean;
  /** Task progress history reads while only text streams. */
  ledgerReadsDuringText: number;
  geometryReadsDuringText: number;
  renderMs: number[];
  /** First and last per-flush render costs, for answer-length flatness. */
  flushMsFirst: number[];
  flushMsLast: number[];
  inputFrameMs: number[];
  typingFrameMs: number[];
  composerPreserved: boolean;
  /** Steps block shown in the Task progress drawer while the run works. */
  stepsVisibleWhileRunning: boolean;
  /** Floating progress capsules seen anywhere in the document, ever. */
  floatingCapsuleNodes: number;
};

export async function exerciseStreamingReplay(
  panel: { body: HTMLElement; item: Zotero.Item },
  input: {
    historyTurns: number;
    chunks: number;
    runMode?: "agent" | "chat";
  },
): Promise<StreamingReplayResult> {
  if (input.runMode === "chat")
    return exerciseChatStreamingReplay(panel, input);
  const { body, item } = panel;
  const doc = body.ownerDocument;
  const win = doc.defaultView!;
  const box = body.querySelector<HTMLDivElement>("#llm-chat-box")!;
  // Synthetic harness panels start offscreen. Real sidebar/standalone hosts
  // must keep their native sizing, visibility and stacking throughout replay.
  const previousStyle = body.getAttribute("style");
  const syntheticHost = body.hasAttribute("data-llm-workflow-test");
  if (syntheticHost) {
    body.style.left = "0";
    body.style.zIndex = "99999";
  }
  const key = getConversationKey(item);
  const runId = `stream-replay-${Date.now()}`;
  const history: Message[] = [];
  for (let n = 0; n < input.historyTurns; n++) {
    history.push({
      role: "user",
      text: `Earlier question ${n}`,
      timestamp: n * 2 + 1,
    });
    history.push({
      role: "assistant",
      text: "A completed answer.\n\n".repeat(12),
      timestamp: n * 2 + 2,
    });
  }
  const user: Message = {
    role: "user",
    text: "Review the corpus",
    timestamp: Date.now(),
  };
  const message: Message = {
    role: "assistant",
    text: "",
    timestamp: user.timestamp + 1,
    runMode: "agent",
    agentRunId: runId,
    streaming: true,
  };
  history.push(user, message);
  chatHistory.set(key, history);
  const outcome = (
    local: string,
    description: string,
    status: ExecutionCheckpointTask["status"],
  ): ExecutionCheckpointTask => ({
    taskId: `${runId}:task:${local}`,
    description,
    dependencies: [],
    status,
    journalActionIds: [],
    verifiedReceiptIds: [],
    readEvidenceIds: [],
    materialRefs: [],
    createdAt: 1,
    updatedAt: 1,
    effect: "read",
    origin: "model",
  });
  const checkpoint: ExecutionCheckpoint = {
    version: 1,
    executionId: runId,
    conversationKey: key,
    conversationGeneration: getConversationWriteGeneration(key),
    tasks: [outcome("read", "Read the corpus", "in_progress")],
    createdAt: 1,
    updatedAt: 1,
  };
  const records: AgentRunEventRecord[] = [];
  const push = (_runId: string, event: AgentEvent) =>
    records.push({
      runId,
      seq: records.length + 1,
      eventType: event.type,
      payload: event,
      createdAt: Date.now(),
    });
  push(runId, { type: "execution_checkpoint", checkpoint });
  // Recorded command evidence exercises the outcome card without running a command.
  push(runId, {
    type: "tool_result",
    callId: "recorded-command",
    name: "run_command",
    ok: true,
    content: { command: "printf 'Recorded action'", exitCode: 0 },
    actionReceipts: [
      {
        version: 2,
        id: "recorded-command",
        proposalId: "recorded-command",
        operation: "command_execute",
        capability: "command.execute",
        proofDomain: "execution",
        verification: "execution_only",
        status: "observed",
        requestedTargets: [],
        appliedTargets: [],
        alreadySatisfiedTargets: [],
        rejectedTargets: [],
        reasons: [],
        verifiedFacts: [],
      },
    ],
  });
  for (let n = 0; n < Math.min(input.historyTurns, 55); n++) {
    push(runId, {
      type: "tool_call",
      callId: `paper-${n}`,
      name: "paper_read",
      args: { itemKey: `fixture-${n}` },
    });
    push(runId, {
      type: "tool_result",
      callId: `paper-${n}`,
      name: "paper_read",
      ok: true,
      actionReceipts: [],
      content: { text: "Completed paper evidence. ".repeat(80) },
    });
  }
  const initial = "Existing reasoning paragraph with evidence.\n".repeat(1000);
  push(runId, { type: "reasoning", round: 1, summary: initial });
  message.reasoningSummary = initial;
  agentRunTraceCache.set(runId, records);
  const requestId = nextRequestId();
  if (!tryBeginRequest(key, requestId, null))
    throw new Error("Fixture request is already busy");
  // What the runtime's onStart does: the run is working from here on, and
  // its declared parts are its steps.
  beginTaskRun(key, { runId, turnIndex: input.historyTurns + 1 });
  setTaskOutcomes(key, runId, checkpoint);
  refreshConversationPanels(body, item);
  await Zotero.Promise.delay(100);
  // The scope listing resolves asynchronously from the library index; let it
  // land before measuring, so only text chunks run while mutations count.
  for (
    const deadline = Date.now() + 5000;
    getTaskProgress(key)?.scope &&
    !getTaskProgress(key)?.scope?.listing &&
    Date.now() < deadline;
  )
    await Zotero.Promise.delay(20);
  flushTaskProgressPanels();
  const findWrapper = () =>
    box.querySelector<HTMLElement>(
      `.llm-message-wrapper[data-message-timestamp="${message.timestamp}"]`,
    )!;
  // Steps render only in the Task progress drawer; no capsule, ever.
  const countFloating = () =>
    doc.querySelectorAll(
      ".llm-plan-progress-floating, .llm-plan-container-execution",
    ).length;
  let floatingCapsuleNodes = countFloating();
  const stepsHost = body.querySelector<HTMLElement>(
    ".llm-task-progress-steps",
  )!;
  const findProgress = () =>
    stepsHost.hidden
      ? null
      : stepsHost.querySelector<HTMLElement>(".llm-task-progress-steps-body");
  const stepsShown = () => {
    flushTaskProgressPanels();
    floatingCapsuleNodes += countFloating();
    return Boolean(findProgress());
  };
  const thinkingSummary = box.querySelector<HTMLElement>(
    ".llm-agent-reasoning-summary",
  );
  thinkingSummary?.dispatchEvent(
    new win.MouseEvent("mousedown", { bubbles: true, cancelable: true }),
  );
  await Zotero.Promise.delay(100);
  const trigger = body.querySelector<HTMLButtonElement>("#llm-task-progress")!;
  trigger.click();
  trigger.focus({ preventScroll: true });
  const progress = findProgress()!;
  const stepsVisibleWhileRunning = Boolean(progress) && !trigger.hidden;
  box.dispatchEvent(
    new win.WheelEvent("wheel", { deltaY: -100, bubbles: true }),
  );
  box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight - 400);
  persistChatScrollSnapshotForConversationKey(key, box);
  const scrollTop = box.scrollTop;
  let wrapper = findWrapper();
  let lastProgress: HTMLElement | null = progress;
  const result: StreamingReplayResult = {
    ...input,
    runMode: "agent",
    wrapperReplacements: 0,
    progressReplacements: 0,
    progressMutations: 0,
    focusPreserved: true,
    manualScrollDelta: 0,
    followBottomGap: 0,
    exactReasoning: false,
    statusVisible: false,
    progressUpdatePreserved: false,
    finalAnswerVisible: false,
    answerVisibleBeforeFinal: false,
    actionCardHiddenWhileStreaming: !findWrapper().querySelector(
      ".llm-agent-action-summary-card",
    ),
    actionCardAfterFinalAnswer: false,
    streamingQuoteVisible: false,
    streamingQuoteMarkersAbsent: false,
    refreshedQuoteVisible: false,
    refreshedQuoteMarkersAbsent: false,
    ledgerReadsDuringText: 0,
    geometryReadsDuringText: 0,
    renderMs: [],
    flushMsFirst: [],
    flushMsLast: [],
    inputFrameMs: [],
    typingFrameMs: [],
    composerPreserved: false,
    stepsVisibleWhileRunning,
    floatingCapsuleNodes: 0,
  };
  // Text chunks must do no Task progress work: neither the row nor the
  // Steps block may change while only reasoning streams.
  const observer = new win.MutationObserver((mutations) => {
    result.progressMutations += mutations.length;
  });
  for (const target of [stepsHost, trigger]) {
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
  }
  const query = Zotero.DB.queryAsync;
  Zotero.DB.queryAsync = async function (sql: string, ...args: unknown[]) {
    if (sql.includes(RUN_EVENTS_TABLE)) result.ledgerReadsDuringText++;
    return (query as Function).call(Zotero.DB, sql, ...args);
  } as typeof query;
  const measured = Array.from(
    box.querySelectorAll(".llm-message-wrapper.user"),
  ) as HTMLElement[];
  const restoreGeometry: Array<() => void> = [];
  for (const node of measured) {
    if (!node) continue;
    const measure = node.getBoundingClientRect;
    node.getBoundingClientRect = () => {
      result.geometryReadsDuringText++;
      return measure.call(node);
    };
    restoreGeometry.push(() => {
      node.getBoundingClientRect = measure;
    });
  }
  const deps = buildAgentEngineDepsForTests(
    item,
    "upstream",
    getConversationWriteGeneration(key),
  );
  const ui = deps.getPanelRequestUI(body);
  const helpers = deps.createPanelUpdateHelpers(body, item, key, ui);
  let measuring = true;
  const refresh = () => {
    const start = win.performance.now();
    helpers.refreshAssistantMessageSafely(message);
    if (message.streaming)
      result.actionCardHiddenWhileStreaming &&= !findWrapper().querySelector(
        ".llm-agent-action-summary-card",
      );
    if (measuring) result.renderMs.push(win.performance.now() - start);
  };
  const coalescer = createBlockStreamCoalescer({
    onBlock: (text) => {
      message.pendingFinalText = (message.pendingFinalText || "") + text;
      message.text = message.pendingFinalText;
      refresh();
    },
  });
  const handle = createAgentTurnEventHandler({
    deps,
    body,
    ui,
    conversationKey: key,
    runtimeRequest: {
      conversationKey: key,
      mode: "agent",
      userText: user.text,
    },
    assistantMessage: message,
    pairedUserMessage: user,
    history,
    isCompactCommand: false,
    compactStyle: "replace-assistant",
    messageDeltaCoalescer: coalescer,
    flushMessageDeltas: coalescer.flushNow,
    queueRefresh: refresh,
    refreshAssistant: refresh,
    refreshChatSafely: helpers.refreshChatSafely,
    setStatusSafely: helpers.setStatusSafely,
    pushTraceEvent: push,
    scheduleQueueDrain: () => {},
  });
  let expected = initial;
  try {
    for (let n = 0; n < input.chunks; n++) {
      const delta = `Stream chunk ${n}: compare this evidence.\n`;
      expected += delta;
      const start = win.performance.now();
      await handle({ type: "reasoning", round: 1, summary: delta });
      if (wrapper !== findWrapper()) result.wrapperReplacements++;
      if (lastProgress !== findProgress()) result.progressReplacements++;
      wrapper = findWrapper();
      lastProgress = findProgress();
      result.focusPreserved &&= doc.activeElement === trigger;
      await new Promise<void>((resolve) =>
        win.requestAnimationFrame(() => {
          result.inputFrameMs.push(win.performance.now() - start);
          resolve();
        }),
      );
    }
    result.manualScrollDelta = box.scrollTop - scrollTop;
    // Thinking repaints are coalesced (up to 120 ms behind the last delta),
    // so let the pending repaint land before the text is read back.
    await new Promise<void>((resolve) => win.setTimeout(resolve, 160));
    await new Promise<void>((resolve) =>
      win.requestAnimationFrame(() => resolve()),
    );
    const displayed = Array.from(
      box.querySelectorAll(".llm-agent-reasoning-text"),
    )
      .map((node) => node?.textContent || "")
      .join("");
    result.exactReasoning = displayed.trim() === expected.trim();
    result.flushMsFirst = result.renderMs.slice(0, 5);
    result.flushMsLast = result.renderMs.slice(-5);
    measuring = false;
    observer.disconnect();
    Zotero.DB.queryAsync = query;
    for (const restore of restoreGeometry) restore();
    // Back to the chat: the overlay collapses and the messages resume.
    trigger.click();
    requestChatScrollFollowBottom(body, item, box);
    const nextFrame = () =>
      new Promise<void>((resolve) =>
        win.requestAnimationFrame(() => resolve()),
      );
    await nextFrame();
    for (let n = 0; n < 12; n++) {
      await handle({
        type: "reasoning",
        round: 1,
        summary: `Follow expanded thinking ${n}.\n`.repeat(4),
      });
      // Deliver the previous automatic scroll's event after new text has
      // grown, but before the queued animation frame catches up.
      box.dispatchEvent(new win.Event("scroll"));
      await nextFrame();
      result.followBottomGap = Math.max(
        result.followBottomGap,
        box.scrollHeight - box.clientHeight - box.scrollTop,
      );
    }
    const task = progress?.querySelector(
      ".llm-plan-task-list",
    )?.firstElementChild;
    const changed: ExecutionCheckpoint = {
      ...checkpoint,
      updatedAt: 2,
      tasks: [
        ...checkpoint.tasks,
        outcome("coverage", "Checking corpus coverage", "pending"),
      ],
    };
    await handle({ type: "execution_checkpoint", checkpoint: changed });
    stepsShown();
    result.progressUpdatePreserved =
      Boolean(progress) &&
      findProgress() === progress &&
      body.querySelector("#llm-task-progress") === trigger &&
      progress.querySelector(".llm-plan-task-list")?.firstElementChild ===
        task &&
      Boolean(progress.textContent?.includes("Checking corpus coverage"));
    const composer = ui.inputBox!;
    composer.focus({ preventScroll: true });
    composer.value = "Draft ";
    composer.dispatchEvent(
      new win.CompositionEvent("compositionstart", { bubbles: true }),
    );
    for (let n = 0; n < 10; n++) {
      const start = win.performance.now();
      composer.value += "文";
      composer.setSelectionRange(composer.value.length, composer.value.length);
      composer.dispatchEvent(
        new win.InputEvent("input", {
          bubbles: true,
          data: "文",
          inputType: "insertCompositionText",
          isComposing: true,
        }),
      );
      await handle({
        type: "reasoning",
        round: 1,
        summary: `Interactive chunk ${n}. `,
      });
      await new Promise<void>((resolve) =>
        win.requestAnimationFrame(() => {
          result.typingFrameMs.push(win.performance.now() - start);
          resolve();
        }),
      );
    }
    composer.dispatchEvent(
      new win.CompositionEvent("compositionend", {
        bubbles: true,
        data: "文".repeat(10),
      }),
    );
    result.composerPreserved =
      composer.value === `Draft ${"文".repeat(10)}` &&
      doc.activeElement === composer &&
      composer.selectionStart === composer.value.length;
    await handle({ type: "status", text: "Streaming replay status" });
    result.statusVisible = Boolean(
      ui.status?.textContent?.includes("Streaming replay status"),
    );
    const quote =
      "The source quotation remains readable while the answer is still arriving.";
    const answer = `Final replay answer with **evidence**.\n\n> ${quote}\n>\n> (Workflow, 2026)\n\nThe explanation continues.`;
    await handle({ type: "message_delta", text: answer });
    // Exercise the real timer boundary, before any final or other flush event.
    await Zotero.Promise.delay(700);
    const answerHost = findWrapper().querySelector<HTMLElement>(
      ".llm-assistant-answer",
    );
    result.answerVisibleBeforeFinal = Boolean(
      message.streaming &&
      answerHost &&
      !answerHost.hidden &&
      answerHost.textContent?.includes("The explanation continues."),
    );
    result.streamingQuoteVisible = Boolean(
      answerHost?.textContent?.includes(quote),
    );
    result.streamingQuoteMarkersAbsent = !answerHost?.textContent?.includes(
      "[[quote-occurrence:",
    );
    await handle({ type: "final", text: answer });
    const finalAnswer = findWrapper().querySelector(".llm-assistant-answer");
    const actionCard = findWrapper().querySelector(
      ".llm-assistant-actions .llm-agent-action-summary-card",
    );
    result.actionCardAfterFinalAnswer = Boolean(
      !message.streaming &&
      finalAnswer &&
      actionCard &&
      finalAnswer.textContent?.includes("The explanation continues.") &&
      finalAnswer.compareDocumentPosition(actionCard) & 4 &&
      actionCard.getBoundingClientRect().height > 0,
    );
    message.quoteDisplayOverride = {
      markdown: `Final replay answer with **evidence**.\n\n> Revalidated quotation stays readable.\n>\n> Not a source quote`,
      quoteCitations: [],
    };
    refresh();
    result.refreshedQuoteVisible = Boolean(
      findWrapper()
        .querySelector(".llm-quote-card")
        ?.textContent?.includes("Revalidated quotation stays readable."),
    );
    result.refreshedQuoteMarkersAbsent = !findWrapper().textContent?.includes(
      "[[quote-occurrence:",
    );
    result.finalAnswerVisible = Boolean(
      box.textContent?.includes("Final replay answer with evidence."),
    );
    result.floatingCapsuleNodes = floatingCapsuleNodes + countFloating();
    return result;
  } finally {
    observer.disconnect();
    Zotero.DB.queryAsync = query;
    for (const restore of restoreGeometry) restore();
    coalescer.cancel();
    finishRequest(key, requestId);
    message.streaming = false;
    agentRunTraceCache.delete(runId);
    if (syntheticHost) {
      if (previousStyle === null) body.removeAttribute("style");
      else body.setAttribute("style", previousStyle);
    }
  }
}

/** Ordinary Chat answer chunk: markdown the incremental parser must keep up with. */
function buildChatReplayChunk(n: number): string {
  return (
    `Paragraph ${n}: the reviewed evidence compares **three** conditions ` +
    `with \`p < 0.0${n % 9}\`, and the discussion keeps going for several ` +
    `lines so each flush re-reads a longer answer than the one before it.\n\n` +
    (n % 3 === 0
      ? `- Point ${n}a about the method\n- Point ${n}b about *controls*\n\n`
      : "") +
    (n % 5 === 0
      ? `| Metric | Value |\n|---|---|\n| Accuracy | 0.9${n % 10} |\n\n`
      : "")
  );
}

/**
 * Ordinary Chat streaming, driven exactly the way streamingResponse.ts drives
 * it: append the delta to the message, then refresh that one assistant
 * message. Agent-only instrumentation (Task progress steps, trace focus,
 * history reads) has no counterpart here and is reported as clean.
 */
async function exerciseChatStreamingReplay(
  panel: { body: HTMLElement; item: Zotero.Item },
  input: { historyTurns: number; chunks: number },
): Promise<StreamingReplayResult> {
  const { body, item } = panel;
  const doc = body.ownerDocument;
  const win = doc.defaultView!;
  const box = body.querySelector<HTMLDivElement>("#llm-chat-box")!;
  const previousStyle = body.getAttribute("style");
  const syntheticHost = body.hasAttribute("data-llm-workflow-test");
  if (syntheticHost) {
    body.style.left = "0";
    body.style.zIndex = "99999";
  }
  const key = getConversationKey(item);
  const history: Message[] = [];
  for (let n = 0; n < input.historyTurns; n++) {
    history.push({
      role: "user",
      text: `Earlier question ${n}`,
      timestamp: n * 2 + 1,
    });
    history.push({
      role: "assistant",
      text: "A completed answer.\n\n".repeat(12),
      timestamp: n * 2 + 2,
    });
  }
  const user: Message = {
    role: "user",
    text: "Review the corpus",
    timestamp: Date.now(),
  };
  // No runMode, no agent run id, no trace: an ordinary Chat answer.
  const message: Message = {
    role: "assistant",
    text: "",
    timestamp: user.timestamp + 1,
    streaming: true,
  };
  history.push(user, message);
  chatHistory.set(key, history);
  const requestId = nextRequestId();
  if (!tryBeginRequest(key, requestId, null))
    throw new Error("Fixture request is already busy");
  const result: StreamingReplayResult = {
    historyTurns: input.historyTurns,
    chunks: input.chunks,
    runMode: "chat",
    wrapperReplacements: 0,
    progressReplacements: 0,
    progressMutations: 0,
    focusPreserved: true,
    manualScrollDelta: 0,
    followBottomGap: 0,
    exactReasoning: true,
    statusVisible: false,
    progressUpdatePreserved: true,
    finalAnswerVisible: false,
    answerVisibleBeforeFinal: false,
    actionCardHiddenWhileStreaming: true,
    actionCardAfterFinalAnswer: true,
    streamingQuoteVisible: false,
    streamingQuoteMarkersAbsent: false,
    refreshedQuoteVisible: false,
    refreshedQuoteMarkersAbsent: false,
    ledgerReadsDuringText: 0,
    geometryReadsDuringText: 0,
    renderMs: [],
    flushMsFirst: [],
    flushMsLast: [],
    inputFrameMs: [],
    typingFrameMs: [],
    composerPreserved: false,
    stepsVisibleWhileRunning: true,
    floatingCapsuleNodes: 0,
  };
  const deps = buildAgentEngineDepsForTests(
    item,
    "upstream",
    getConversationWriteGeneration(key),
  );
  const ui = deps.getPanelRequestUI(body);
  const helpers = deps.createPanelUpdateHelpers(body, item, key, ui);
  const findWrapper = () =>
    box.querySelector<HTMLElement>(
      `.llm-message-wrapper[data-message-timestamp="${message.timestamp}"]`,
    );
  const findAnswer = () =>
    findWrapper()?.querySelector<HTMLElement>(".llm-assistant-answer") || null;
  const refresh = () => {
    const start = win.performance.now();
    helpers.refreshAssistantMessageSafely(message);
    return win.performance.now() - start;
  };
  try {
    refreshConversationPanels(body, item);
    await Zotero.Promise.delay(100);
    let wrapper = findWrapper();
    if (!wrapper)
      throw new Error("Chat replay never mounted the streaming answer wrapper");
    // Streaming must update the mounted answer in place, never swap its wrapper.
    const noteWrapper = () => {
      const next = findWrapper();
      if (next !== wrapper) result.wrapperReplacements++;
      wrapper = next;
    };
    // Read an earlier turn: streaming must not move the reader's viewport.
    box.dispatchEvent(
      new win.WheelEvent("wheel", { deltaY: -100, bubbles: true }),
    );
    box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight - 400);
    persistChatScrollSnapshotForConversationKey(key, box);
    const scrollTop = box.scrollTop;
    for (let n = 0; n < input.chunks; n++) {
      const start = win.performance.now();
      message.text += buildChatReplayChunk(n);
      result.renderMs.push(refresh());
      noteWrapper();
      await new Promise<void>((resolve) =>
        win.requestAnimationFrame(() => {
          result.inputFrameMs.push(win.performance.now() - start);
          resolve();
        }),
      );
    }
    result.flushMsFirst = result.renderMs.slice(0, 5);
    result.flushMsLast = result.renderMs.slice(-5);
    result.manualScrollDelta = box.scrollTop - scrollTop;
    const composer = ui.inputBox!;
    composer.focus({ preventScroll: true });
    composer.value = "Draft ";
    composer.dispatchEvent(
      new win.CompositionEvent("compositionstart", { bubbles: true }),
    );
    for (let n = 0; n < 10; n++) {
      const start = win.performance.now();
      composer.value += "文";
      composer.setSelectionRange(composer.value.length, composer.value.length);
      composer.dispatchEvent(
        new win.InputEvent("input", {
          bubbles: true,
          data: "文",
          inputType: "insertCompositionText",
          isComposing: true,
        }),
      );
      message.text += `Interactive chunk ${n}. `;
      refresh();
      noteWrapper();
      await new Promise<void>((resolve) =>
        win.requestAnimationFrame(() => {
          result.typingFrameMs.push(win.performance.now() - start);
          resolve();
        }),
      );
    }
    composer.dispatchEvent(
      new win.CompositionEvent("compositionend", {
        bubbles: true,
        data: "文".repeat(10),
      }),
    );
    result.composerPreserved =
      composer.value === `Draft ${"文".repeat(10)}` &&
      doc.activeElement === composer &&
      composer.selectionStart === composer.value.length;
    helpers.setStatusSafely("Streaming replay status", "sending");
    result.statusVisible = Boolean(
      ui.status?.textContent?.includes("Streaming replay status"),
    );
    const quote =
      "The source quotation remains readable while the answer is still arriving.";
    message.text += `\n\n> ${quote}\n>\n> (Workflow, 2026)\n\nFinal replay answer with **evidence**.\n`;
    refresh();
    await Zotero.Promise.delay(200);
    const answerHost = findAnswer();
    result.answerVisibleBeforeFinal = Boolean(
      message.streaming &&
      answerHost &&
      !answerHost.hidden &&
      answerHost.textContent?.includes("Final replay answer with evidence."),
    );
    result.streamingQuoteVisible = Boolean(
      answerHost?.textContent?.includes(quote),
    );
    result.streamingQuoteMarkersAbsent = !answerHost?.textContent?.includes(
      "[[quote-occurrence:",
    );
    noteWrapper();
    // Turn end keeps the established full render.
    message.streaming = false;
    helpers.refreshChatSafely();
    await Zotero.Promise.delay(200);
    result.finalAnswerVisible = Boolean(
      box.textContent?.includes("Final replay answer with evidence."),
    );
    result.refreshedQuoteVisible = Boolean(
      findWrapper()?.textContent?.includes(quote),
    );
    result.refreshedQuoteMarkersAbsent = !findWrapper()?.textContent?.includes(
      "[[quote-occurrence:",
    );
    return result;
  } finally {
    finishRequest(key, requestId);
    message.streaming = false;
    if (syntheticHost) {
      if (previousStyle === null) body.removeAttribute("style");
      else body.setAttribute("style", previousStyle);
    }
  }
}

export type TaskProgressReplayInput = {
  /** The contexts the turn's user message attached. */
  user: Pick<
    Message,
    | "paperContexts"
    | "fullTextPaperContexts"
    | "selectedCollectionContexts"
    | "selectedTagContexts"
  >;
  /** Earlier completed turns, so the chat has something to scroll. */
  historyTurns?: number;
  /** The user's words; a fixed question by default. */
  question?: string;
  /**
   * Ask the next question in the conversation a previous replay left: its
   * messages and Task progress stay (no earlier turns are added).
   */
  followUp?: boolean;
};

export type TaskProgressReplayHandle = {
  conversationKey: number;
  runId: string;
  assistantTimestamp: number;
  /** Deliver one run event through the real agent turn event handler. */
  emit: (event: AgentEvent) => Promise<void>;
  /** The completed turn's full re-render, as the outcome owner does it. */
  refreshChat: () => void;
  /** End the synthetic request and restore the host. */
  finish: () => void;
};

/**
 * A synthetic agent run for the Task progress view: a user message with the
 * given scope, a streaming answer, and whatever events the test emits, all
 * through `createAgentTurnEventHandler` as a real turn delivers them.
 */
export async function startTaskProgressReplay(
  panel: { body: HTMLElement; item: Zotero.Item },
  input: TaskProgressReplayInput,
): Promise<TaskProgressReplayHandle> {
  const { body, item } = panel;
  const previousStyle = body.getAttribute("style");
  const syntheticHost = body.hasAttribute("data-llm-workflow-test");
  if (syntheticHost) {
    body.style.left = "0";
    body.style.zIndex = "99999";
  }
  const key = getConversationKey(item);
  const runId = `task-progress-replay-${Date.now()}`;
  const history: Message[] = input.followUp ? chatHistory.get(key) || [] : [];
  const earlier = input.followUp
    ? taskTurnIndexFor(history)
    : Math.max(0, input.historyTurns ?? 3);
  const base = Date.now() - 10_000;
  const added = input.followUp ? 0 : earlier;
  for (let n = 0; n < added; n++) {
    history.push({
      role: "user",
      text: `Earlier question ${n}`,
      timestamp: base + n * 2 + 1,
    });
    history.push({
      role: "assistant",
      text: "An earlier completed answer with enough text to scroll.\n\n".repeat(
        10,
      ),
      timestamp: base + n * 2 + 2,
    });
  }
  const user: Message = {
    role: "user",
    text:
      input.question || "What is the commonality of drift across these papers?",
    timestamp: Date.now(),
    ...input.user,
  };
  const message: Message = {
    role: "assistant",
    text: "",
    timestamp: user.timestamp + 1,
    runMode: "agent",
    agentRunId: runId,
    streaming: true,
  };
  user.agentRunId = runId;
  history.push(user, message);
  chatHistory.set(key, history);
  // The context bar holds what the question carried, as it does after a send.
  const copy = <T>(list: readonly T[] | undefined) =>
    list ? [...list] : undefined;
  composeContextStore.papers.replace(key, copy(user.paperContexts));
  composeContextStore.collections.replace(
    key,
    copy(user.selectedCollectionContexts),
  );
  composeContextStore.tags.replace(key, copy(user.selectedTagContexts));
  composeContextStore.initializedConversations.mark(key);
  // The synthetic history replaces the conversation's, so does its ledger;
  // a follow-up keeps both.
  if (!input.followUp) clearTaskProgress(key);
  const requestId = nextRequestId();
  if (!tryBeginRequest(key, requestId, null))
    throw new Error("Fixture request is already busy");
  beginTaskRun(key, { runId, turnIndex: earlier + 1, text: user.text });
  refreshConversationPanels(body, item);
  await Zotero.Promise.delay(100);
  flushTaskProgressPanels();
  const deps = buildAgentEngineDepsForTests(
    item,
    "upstream",
    getConversationWriteGeneration(key),
  );
  const ui = deps.getPanelRequestUI(body);
  const helpers = deps.createPanelUpdateHelpers(body, item, key, ui);
  const refresh = () => helpers.refreshAssistantMessageSafely(message);
  const coalescer = createBlockStreamCoalescer({
    onBlock: (text) => {
      message.pendingFinalText = (message.pendingFinalText || "") + text;
      message.text = message.pendingFinalText;
      refresh();
    },
  });
  const records: AgentRunEventRecord[] = [];
  agentRunTraceCache.set(runId, records);
  const handle = createAgentTurnEventHandler({
    deps,
    body,
    ui,
    conversationKey: key,
    runtimeRequest: {
      conversationKey: key,
      mode: "agent",
      userText: user.text,
      libraryID: item.libraryID,
    },
    assistantMessage: message,
    pairedUserMessage: user,
    history,
    isCompactCommand: false,
    compactStyle: "replace-assistant",
    messageDeltaCoalescer: coalescer,
    flushMessageDeltas: coalescer.flushNow,
    queueRefresh: refresh,
    refreshAssistant: refresh,
    refreshChatSafely: helpers.refreshChatSafely,
    setStatusSafely: helpers.setStatusSafely,
    pushTraceEvent: (_runId, event) =>
      records.push({
        runId,
        seq: records.length + 1,
        eventType: event.type,
        payload: event,
        createdAt: Date.now(),
      }),
    scheduleQueueDrain: () => {},
  });
  let finished = false;
  return {
    conversationKey: key,
    runId,
    assistantTimestamp: message.timestamp,
    async emit(event) {
      await handle(event);
      // Deterministic delivery: the streamed text lands now, not at the
      // coalescer's timer.
      if (event.type === "message_delta") coalescer.flushNow("event");
    },
    refreshChat() {
      message.streaming = false;
      helpers.refreshChatSafely();
    },
    finish() {
      if (finished) return;
      finished = true;
      coalescer.cancel();
      finishRequest(key, requestId);
      message.streaming = false;
      agentRunTraceCache.delete(runId);
      if (getTaskProgress(key)?.runState === "working") {
        // Nothing settled the run: the request ended under it.
        refreshConversationPanels(body, item);
      }
      if (syntheticHost) {
        if (previousStyle === null) body.removeAttribute("style");
        else body.setAttribute("style", previousStyle);
      }
    },
  };
}
