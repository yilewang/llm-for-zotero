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
  recordLivePlanExecution,
  finishRequest,
} from "./state";
import { agentRunTraceCache } from "./agentState";
import { getConversationWriteGeneration } from "../../shared/conversationWriteFence";
import { createBlockStreamCoalescer } from "./blockStreamCoalescer";
import { persistChatScrollSnapshotForConversationKey } from "./chatScrollSnapshots";
import type { AgentEvent, AgentRunEventRecord } from "../../agent/types";
import type { PlanExecutionLedger } from "../../agent/plans/types";
import type { Message } from "./types";

export type StreamingReplayResult = {
  historyTurns: number;
  chunks: number;
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
  streamingQuoteVisible: boolean;
  streamingQuoteMarkersAbsent: boolean;
  refreshedQuoteVisible: boolean;
  refreshedQuoteMarkersAbsent: boolean;
  ledgerReadsDuringText: number;
  geometryReadsDuringText: number;
  renderMs: number[];
  inputFrameMs: number[];
  typingFrameMs: number[];
  composerPreserved: boolean;
  resumeVisibilityCorrect: boolean;
  singleExecutionProgress: boolean;
  completedProgressNodes: number;
  reopenedProgressNodes: number;
  pausedProgressNodes: number[];
  resumeStartsProgress: boolean;
  inactiveProgressReads: number;
};

export async function exerciseStreamingReplay(
  panel: { body: HTMLElement; item: Zotero.Item },
  input: { historyTurns: number; chunks: number },
): Promise<StreamingReplayResult> {
  const { body, item } = panel;
  const doc = body.ownerDocument;
  const win = doc.defaultView!;
  const box = body.querySelector<HTMLDivElement>("#llm-chat-box")!;
  // A visible, sized native viewport is required for timing and focus evidence.
  body.style.left = "0";
  body.style.zIndex = "99999";
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
  const ledger = {
    version: 1,
    executionId: runId,
    planId: runId,
    revision: 1,
    conversationKey: key,
    planDigest: "fixture",
    attempt: 1,
    provider: "original",
    status: "running",
    grant: {
      version: 1,
      planId: runId,
      revision: 1,
      planDigest: "fixture",
      conversationKey: key,
      conversationGeneration: 0,
      authority: "user",
      approvedAt: 1,
    },
    activeTaskId: "read",
    createdAt: 1,
    startedAt: 1,
    updatedAt: 1,
    evidence: [],
    tasks: [
      {
        version: 1,
        taskId: "read",
        planStepId: "read",
        executionId: runId,
        kind: "required_step",
        content: "Read the corpus",
        activeForm: "Reading the corpus",
        acceptanceCriteria: [],
        expectedEffect: "read",
        obligationIds: [],
        status: "in_progress",
        attemptCount: 1,
        evidenceIds: [],
        failureReasons: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  } as PlanExecutionLedger;
  const records: AgentRunEventRecord[] = [];
  const push = (_runId: string, event: AgentEvent) =>
    records.push({
      runId,
      seq: records.length + 1,
      eventType: event.type,
      payload: event,
      createdAt: Date.now(),
    });
  push(runId, { type: "plan_execution_updated", ledger });
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
  recordLivePlanExecution(key, requestId, runId, ledger);
  refreshConversationPanels(body, item);
  await Zotero.Promise.delay(100);
  const findWrapper = () =>
    box.querySelector<HTMLElement>(
      `.llm-message-wrapper[data-message-timestamp="${message.timestamp}"]`,
    )!;
  const findProgress = () =>
    box.querySelector<HTMLElement>(".llm-plan-container-execution")!;
  const thinkingSummary = box.querySelector<HTMLElement>(
    ".llm-agent-reasoning-summary",
  );
  thinkingSummary?.dispatchEvent(
    new win.MouseEvent("mousedown", { bubbles: true, cancelable: true }),
  );
  await Zotero.Promise.delay(100);
  const progress = findProgress();
  const trigger = progress.querySelector<HTMLButtonElement>(
    ".llm-plan-progress-trigger",
  )!;
  trigger.click();
  trigger.focus({ preventScroll: true });
  box.dispatchEvent(
    new win.WheelEvent("wheel", { deltaY: -100, bubbles: true }),
  );
  box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight - 400);
  persistChatScrollSnapshotForConversationKey(key, box);
  const scrollTop = box.scrollTop;
  let wrapper = findWrapper();
  let lastProgress = progress;
  const result: StreamingReplayResult = {
    ...input,
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
    streamingQuoteVisible: false,
    streamingQuoteMarkersAbsent: false,
    refreshedQuoteVisible: false,
    refreshedQuoteMarkersAbsent: false,
    ledgerReadsDuringText: 0,
    geometryReadsDuringText: 0,
    renderMs: [],
    inputFrameMs: [],
    typingFrameMs: [],
    composerPreserved: false,
    singleExecutionProgress: false,
    completedProgressNodes: -1,
    reopenedProgressNodes: -1,
    pausedProgressNodes: [],
    resumeStartsProgress: true,
    inactiveProgressReads: 0,
    resumeVisibilityCorrect: !box.querySelector(".llm-plan-recovery-card"),
  };
  const observer = new win.MutationObserver((mutations) => {
    result.progressMutations += mutations.length;
  });
  observer.observe(progress, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  const query = Zotero.DB.queryAsync;
  Zotero.DB.queryAsync = async function (sql: string, ...args: unknown[]) {
    if (sql.includes("llm_for_zotero_plan_executions"))
      result.ledgerReadsDuringText++;
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
    uiRelease: { releaseReady: () => {} },
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
    const displayed = Array.from(
      box.querySelectorAll(".llm-agent-reasoning-text"),
    )
      .map((node) => node?.textContent || "")
      .join("");
    result.exactReasoning = displayed.trim() === expected.trim();
    measuring = false;
    observer.disconnect();
    Zotero.DB.queryAsync = query;
    for (const restore of restoreGeometry) restore();
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
    const task = progress.querySelector(
      ".llm-plan-task-list",
    )?.firstElementChild;
    const changed = {
      ...ledger,
      updatedAt: 2,
      tasks: ledger.tasks.map((task) => ({
        ...task,
        activeForm: "Checking corpus coverage",
        updatedAt: 2,
      })),
    };
    await handle({ type: "plan_execution_updated", ledger: changed });
    result.progressUpdatePreserved =
      findProgress() === progress &&
      progress.querySelector(".llm-plan-progress-trigger") === trigger &&
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
    let nextUpdate = 3;
    for (const status of [
      "waiting_for_user",
      "blocked",
      "interrupted",
    ] as const) {
      await handle({
        type: "plan_execution_updated",
        ledger: { ...changed, status, updatedAt: nextUpdate++ },
      });
      result.pausedProgressNodes.push(
        box.querySelectorAll(".llm-plan-container-execution").length,
      );
      await handle({
        type: "plan_execution_updated",
        ledger: { ...changed, status: "running", updatedAt: nextUpdate++ },
      });
      result.resumeStartsProgress &&= Boolean(findProgress());
    }
    await handle({
      type: "plan_execution_updated",
      ledger: { ...changed, status: "interrupted", updatedAt: nextUpdate++ },
    });
    result.resumeVisibilityCorrect &&=
      !findProgress() &&
      Boolean(box.querySelector(".llm-plan-recovery-card button"));
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
    // Older and resumed turns can share an execution ID. Restoring these
    // interrupted history entries must not recreate live progress.
    const resumedRunId = `${runId}-resumed`;
    agentRunTraceCache.set(resumedRunId, [
      {
        ...records[0],
        runId: resumedRunId,
        payload: {
          type: "plan_execution_updated",
          ledger: { ...changed, status: "interrupted", updatedAt: 4 },
        },
      },
    ]);
    history.push(
      { ...user, text: "Approved plan", timestamp: user.timestamp + 2 },
      {
        ...message,
        text: "[Cancelled]",
        agentRunId: resumedRunId,
        streaming: false,
        timestamp: user.timestamp + 3,
      },
    );
    refreshConversationPanels(body, item);
    result.singleExecutionProgress =
      box.querySelectorAll(".llm-plan-container-execution").length === 0;
    agentRunTraceCache.delete(resumedRunId);
    history.splice(-2);
    await handle({
      type: "plan_execution_updated",
      ledger: { ...changed, status: "completed", updatedAt: nextUpdate++ },
    });
    result.completedProgressNodes = box.querySelectorAll(
      ".llm-plan-container-execution",
    ).length;
    finishRequest(key, requestId);
    // A stale restored streaming flag and running snapshot are never live authority.
    message.streaming = true;
    agentRunTraceCache.set(runId, [
      { ...records[0], payload: { type: "plan_execution_updated", ledger } },
    ]);
    Zotero.DB.queryAsync = async function (sql: string, ...args: unknown[]) {
      if (
        /SELECT.*|FROM/s.test(sql) &&
        sql.includes("llm_for_zotero_plan_executions")
      )
        result.inactiveProgressReads++;
      return (query as Function).call(Zotero.DB, sql, ...args);
    } as typeof query;
    refreshConversationPanels(body, item);
    await Zotero.Promise.delay(100);
    result.reopenedProgressNodes = box.querySelectorAll(
      ".llm-plan-container-execution",
    ).length;
    return result;
  } finally {
    observer.disconnect();
    Zotero.DB.queryAsync = query;
    for (const restore of restoreGeometry) restore();
    coalescer.cancel();
    finishRequest(key, requestId);
    message.streaming = false;
    agentRunTraceCache.delete(runId);
    body.style.left = "-10000px";
  }
}
