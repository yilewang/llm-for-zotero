/**
 * The chat panel's side of one native Codex turn: the callbacks the
 * app-server client calls while the turn runs, the review cards its
 * approvals and host questions open, and the one dispatch the send and
 * retry flows share.
 */
import { appLogger } from "../../../core/logging";
import {
  readNativeQuestions,
  buildNativeQuestionAction,
  nativeQuestionAnswers,
} from "../../../codexAppServer/nativeQuestions";
import {
  applyTaskPaperUpdate,
  beginTaskRun,
  completeTaskRun,
  markTaskAnswering,
  setTaskChecklist,
  taskTurnIndexFor,
} from "../taskProgress/store";
import { CODEX_PLAN_CHECKLIST_ITEM_ID } from "../taskProgress/codexPlan";
import { taskProgressEffect } from "../taskProgress/runFold";
import { paperLedgerUpdateFromMcpActivity } from "../../../agent/context/taskPaperLedgerRecorder";
import {
  buildCodexNativeApprovalPendingAction,
  buildCodexNativeApprovalResponseFromResolution,
  isCodexNativeBuiltInApprovalRequest,
  resolveCodexNativeApprovalRequest,
  runCodexAppServerNativeTurn,
  type CodexNativeApprovalRequest,
  type CodexNativeDiagnostics,
} from "../../../codexAppServer/nativeClient";
import { formatCodexZoteroMcpError } from "../../../codexAppServer/mcpErrors";
import type {
  ModelTurnOutcome,
  ReasoningEvent,
  UsageStats,
} from "../../../utils/llmClient";
import { scheduleChatContentScroll } from "../chatScrollSnapshots";
import type { BlockStreamFlushReason } from "../blockStreamCoalescer";
import { requireCurrentPanelOwnership } from "../panelHostOwnership";
import type { Message } from "../types";
import {
  chatHistory,
  isConversationWriteGenerationCurrent,
  areConversationWritesFrozen,
} from "../state";
import { setStatus } from "../textUtils";
import { sanitizeText } from "../../../utils/textSanitization";
import { renderPendingActionCard } from "../agentTrace/render";
import {
  createCodexNativeActivityTraceController,
  isCodexNativeAgentMessageItem,
  type CodexNativeActivityTraceController,
} from "../codexNativeTrace/controller";
import { mergeQuoteCitations } from "../../../services/quotes/quoteCitations";
import { getAgentApi } from "../../../agent/index";
import { createAgentRunEventJournal } from "../../../agent/store/traceStore";
import type {
  AgentConfirmationResolution,
  AgentEvent,
  AgentPendingAction,
} from "../../../agent/types";
import { getPanelRequestUI } from "../panelRequestUI";

function syncInlineActionCardAttr(body: Element): void {
  const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
  if (!panelRoot) return;
  const hasCard = Boolean(body.querySelector(".llm-action-inline-card"));
  if (hasCard) {
    panelRoot.dataset.hasActionCard = "true";
  } else {
    delete panelRoot.dataset.hasActionCard;
  }
}

function findNativeMcpActionCard(
  chatBox: HTMLElement,
  requestId: string,
): HTMLElement | null {
  const cards = Array.from(
    chatBox.querySelectorAll(
      ".llm-agent-hitl-card[data-request-id], .llm-action-inline-card[data-request-id]",
    ),
  ) as HTMLElement[];
  return cards.find((card) => card.dataset.requestId === requestId) || null;
}

let codexNativeApprovalRequestCounter = 0;

function closeNativeMcpActionCard(body: Element, requestId?: string): void {
  const ui = getPanelRequestUI(body);
  const chatBox = ui.chatBox;
  if (!chatBox) return;
  let card: Element | null = null;
  if (requestId) {
    card =
      findNativeMcpActionCard(chatBox, requestId) ||
      (
        Array.from(
          chatBox.querySelectorAll(".llm-action-inline-card"),
        ) as HTMLElement[]
      ).find((entry) => entry.dataset.requestId === requestId) ||
      null;
  } else {
    card = chatBox.querySelector(".llm-action-inline-card");
  }
  card?.remove();
  syncInlineActionCardAttr(body);
}

function showNativeMcpActionCard(
  body: Element,
  requestId: string,
  action: AgentPendingAction,
  signal?: AbortSignal,
  traceOwnsCard = false,
): Promise<AgentConfirmationResolution> {
  return new Promise((resolve) => {
    const cancel = () => {
      getAgentApi().resolveConfirmation(requestId, false);
    };
    if (signal?.aborted) {
      resolve({ approved: false });
      return;
    }
    appLogger.debug("Codex app-server native confirmation requested", {
      requestId,
      toolName: action.toolName,
      mode: action.mode || "approval",
      title: action.title,
    });
    const ui = getPanelRequestUI(body);
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc || !ui.chatBox) {
      appLogger.warn("Codex app-server native confirmation unavailable", {
        requestId,
        reason: "missing_panel_review_card_ui",
      });
      throw new Error(
        "Zotero review card UI is unavailable for native confirmation.",
      );
    }

    try {
      getAgentApi().registerPendingConfirmation(requestId, (resolution) => {
        appLogger.debug("Codex app-server native confirmation resolved", {
          requestId,
          approved: resolution.approved,
          actionId: resolution.actionId,
        });
        signal?.removeEventListener("abort", cancel);
        closeNativeMcpActionCard(body, requestId);
        resolve(resolution);
      });
    } catch (error) {
      appLogger.warn("Codex app-server native confirmation unavailable", {
        requestId,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw new Error(
        `Zotero review card UI could not register native confirmation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      return;
    }
    // The queued assistant trace owns persistent review cards. Register the
    // response now, but do not race that render with a second inline card.
    if (traceOwnsCard) return;
    const renderedCard = findNativeMcpActionCard(ui.chatBox, requestId);
    if (renderedCard) {
      scheduleChatContentScroll(ui.chatBox);
      syncInlineActionCardAttr(body);
      appLogger.debug("Codex app-server native confirmation rendered", {
        requestId,
        toolName: action.toolName,
        mode: action.mode || "approval",
        source: "trace",
      });
      return;
    }
    ui.chatBox.querySelector(".llm-action-inline-card")?.remove();
    const wrapper = ownerDoc.createElement("div");
    wrapper.className = "llm-action-inline-card llm-action-inline-card-review";
    wrapper.dataset.requestId = requestId;
    wrapper.appendChild(
      renderPendingActionCard(ownerDoc, { requestId, action }),
    );
    ui.chatBox.appendChild(wrapper);
    scheduleChatContentScroll(ui.chatBox);
    syncInlineActionCardAttr(body);
    appLogger.debug("Codex app-server native confirmation rendered", {
      requestId,
      toolName: action.toolName,
      mode: action.mode || "approval",
      source: "inline",
    });
  });
}

type CodexNativeApprovalTrace = {
  noteMcpConfirmationRequired?: (
    requestId: string,
    action: AgentPendingAction,
  ) => void;
  noteMcpConfirmationResolved?: (
    requestId: string,
    resolution: AgentConfirmationResolution,
  ) => void;
};

export async function resolveCodexNativeHostInteractionWithTrace(params: {
  body: Element;
  action: AgentPendingAction;
  trace?: CodexNativeApprovalTrace | null;
  showActionCard?: typeof showNativeMcpActionCard;
  nextRequestId?: () => string;
  isCurrent?: () => boolean;
}): Promise<AgentConfirmationResolution> {
  if (params.isCurrent && !params.isCurrent()) return { approved: false };
  const requestId =
    params.nextRequestId?.() ||
    `host-review-${Date.now()}-${++codexNativeApprovalRequestCounter}`;
  params.trace?.noteMcpConfirmationRequired?.(requestId, params.action);
  let resolution: AgentConfirmationResolution;
  try {
    resolution = await (params.showActionCard || showNativeMcpActionCard)(
      params.body,
      requestId,
      params.action,
      undefined,
      Boolean(params.trace?.noteMcpConfirmationRequired),
    );
  } catch (error) {
    params.trace?.noteMcpConfirmationResolved?.(requestId, {
      approved: false,
    });
    throw error;
  }
  if (params.isCurrent && !params.isCurrent()) {
    resolution = { approved: false };
  }
  params.trace?.noteMcpConfirmationResolved?.(requestId, resolution);
  return resolution;
}

export async function resolveCodexNativeApprovalWithOptionalReviewCard(params: {
  body: Element;
  request: CodexNativeApprovalRequest;
  trace?: CodexNativeApprovalTrace | null;
  setStatusSafely: (
    text: string,
    kind: Parameters<typeof setStatus>[2],
  ) => void;
  showActionCard?: (
    body: Element,
    requestId: string,
    action: AgentPendingAction,
    signal?: AbortSignal,
    traceOwnsCard?: boolean,
  ) => Promise<AgentConfirmationResolution>;
  nextRequestId?: () => string;
  isCurrent?: () => boolean;
}): Promise<unknown> {
  const questions = readNativeQuestions(params.request);
  const defaultDecision = resolveCodexNativeApprovalRequest(params.request);
  if (
    params.request.signal?.aborted ||
    (params.isCurrent && !params.isCurrent())
  ) {
    return questions ? { answers: {} } : defaultDecision.response;
  }
  if (defaultDecision.approved) {
    params.setStatusSafely("Codex approved Zotero MCP access", "sending");
    return defaultDecision.response;
  }
  if (questions) {
    const requestId = `codex-question-${Date.now()}-${++codexNativeApprovalRequestCounter}`;
    const action = buildNativeQuestionAction(questions);
    params.setStatusSafely("Codex is waiting for your input", "sending");
    params.trace?.noteMcpConfirmationRequired?.(requestId, action);
    let resolution: AgentConfirmationResolution;
    try {
      resolution = await (params.showActionCard || showNativeMcpActionCard)(
        params.body,
        requestId,
        action,
        params.request.signal,
        Boolean(params.trace?.noteMcpConfirmationRequired),
      );
    } catch (error) {
      params.trace?.noteMcpConfirmationResolved?.(requestId, {
        approved: false,
      });
      throw error;
    }
    if (
      params.request.signal?.aborted ||
      (params.isCurrent && !params.isCurrent())
    )
      resolution = { approved: false };
    params.trace?.noteMcpConfirmationResolved?.(requestId, resolution);
    return nativeQuestionAnswers(questions, resolution);
  }
  if (defaultDecision.reason === "unsupported_mcp_elicitation") {
    params.setStatusSafely(
      "Codex declined unsupported MCP elicitation",
      "sending",
    );
    return defaultDecision.response;
  }
  if (!isCodexNativeBuiltInApprovalRequest(params.request)) {
    params.setStatusSafely(
      "Codex denied a built-in or untrusted approval request",
      "error",
    );
    return defaultDecision.response;
  }

  const requestId =
    params.nextRequestId?.() ||
    `codex-native-approval-${Date.now()}-${++codexNativeApprovalRequestCounter}`;
  const action = buildCodexNativeApprovalPendingAction(params.request);
  const showActionCard = params.showActionCard || showNativeMcpActionCard;
  try {
    params.setStatusSafely("Codex is waiting for your approval", "sending");
    params.trace?.noteMcpConfirmationRequired?.(requestId, action);
    const resolution = await showActionCard(
      params.body,
      requestId,
      action,
      params.request.signal,
      Boolean(params.trace?.noteMcpConfirmationRequired),
    );
    if (params.isCurrent && !params.isCurrent()) {
      return defaultDecision.response;
    }
    params.trace?.noteMcpConfirmationResolved?.(requestId, resolution);
    return buildCodexNativeApprovalResponseFromResolution(
      params.request,
      resolution,
    );
  } catch (error) {
    if (typeof ztoolkit !== "undefined") {
      appLogger.warn(
        "Codex app-server native approval UI unavailable; denying request",
        {
          method: params.request.method,
          reason: error instanceof Error ? error.message : String(error),
        },
      );
    }
    params.setStatusSafely(
      "Codex denied a built-in approval request because the approval UI was unavailable",
      "error",
    );
    return defaultDecision.response;
  }
}

function formatCodexNativeDiagnosticsStatus(
  diagnostics: CodexNativeDiagnostics,
): string {
  const threadId = sanitizeText(diagnostics.threadId || "");
  const threadShort = threadId ? threadId.slice(0, 10) : "unknown";
  const source = sanitizeText(diagnostics.threadSource || "appServer");
  const libraryName = sanitizeText(diagnostics.libraryName || "");
  const libraryLabel = libraryName
    ? `${diagnostics.libraryID} ${libraryName}`
    : `${diagnostics.libraryID}`;
  const mcpLabel = diagnostics.mcpServerName
    ? `${sanitizeText(diagnostics.mcpServerName)} ${
        diagnostics.mcpReady ? "ready" : "not ready"
      }`
    : "MCP disabled";
  const historyLabel =
    diagnostics.historyVerified === undefined
      ? ""
      : `, history ${diagnostics.historyVerified ? "verified" : "unverified"}`;
  return `Codex app-server ${threadShort} (${source}), library ${libraryLabel}, ${mcpLabel}${historyLabel}`;
}

type CodexNativeTurnCallbacks = Pick<
  Parameters<typeof runCodexAppServerNativeTurn>[0],
  | "eventJournal"
  | "onSkillActivated"
  | "onDelta"
  | "onAgentMessageDelta"
  | "onReasoning"
  | "onUsage"
  | "onItemStarted"
  | "onItemCompleted"
  | "onPlanUpdated"
  | "onMcpToolActivity"
  | "onHostEvent"
  | "onMcpSetupWarning"
  | "onDiagnostics"
  | "onApprovalRequest"
  | "onHostInteraction"
>;

/**
 * The Codex app-server native-turn callback set, previously duplicated
 * verbatim between the send and retry pipelines.
 */
function buildCodexNativeTurnCallbacks(ctx: {
  body: Element;
  item: Zotero.Item;
  assistantMessage: Message;
  codexActivityTrace: ReturnType<
    typeof createCodexNativeActivityTraceController
  > | null;
  flushResponseStream: (reason: BlockStreamFlushReason) => void;
  setStatusSafely: (
    text: string,
    kind: Parameters<typeof setStatus>[2],
  ) => void;
  handleDelta: (delta: string) => void;
  handleReasoning: (reasoning: ReasoningEvent) => void;
  handleUsage: (usage: UsageStats) => void;
  conversationKey: number;
  conversationGeneration: number;
  skillRoutingReceipt?: import("../../../agent/types").AgentRuntimeRequest["skillRoutingReceipt"];
}): CodexNativeTurnCallbacks {
  const {
    body,
    assistantMessage,
    codexActivityTrace,
    flushResponseStream,
    setStatusSafely,
    handleDelta,
    handleReasoning,
    handleUsage,
  } = ctx;
  const isLive = () =>
    !areConversationWritesFrozen(ctx.conversationKey) &&
    isConversationWriteGenerationCurrent(
      ctx.conversationKey,
      ctx.conversationGeneration,
    );
  // The Task progress row follows this turn: working now, answering at the
  // first streamed text, and each MCP read's paper ledger delta as it lands.
  {
    const history = chatHistory.get(ctx.conversationKey) || [];
    const position = history.indexOf(assistantMessage);
    const asked = position >= 0 ? history.slice(0, position) : history;
    const question = asked
      .filter((message) => message.role === "user" && !message.compactMarker)
      .pop();
    beginTaskRun(ctx.conversationKey, {
      runId: assistantMessage.agentRunId,
      turnIndex: taskTurnIndexFor(asked),
      text: question?.text,
    });
  }
  const noteAnswering = () =>
    markTaskAnswering(ctx.conversationKey, assistantMessage.agentRunId);
  // What a run event does to Task progress, read by the one fold the agent
  // engine and the rebuild of a stored conversation share, applied as the
  // event arrives.
  const applyTaskProgress = (event: AgentEvent): void => {
    const effect = taskProgressEffect(event);
    if (!effect) return;
    const runId = assistantMessage.agentRunId;
    switch (effect.kind) {
      case "paper_delta":
        applyTaskPaperUpdate(ctx.conversationKey, effect.delta, runId);
        return;
      case "codex_checklist":
        if (runId) {
          setTaskChecklist(ctx.conversationKey, {
            source: "codex",
            runId,
            steps: effect.steps,
          });
        }
        return;
      default:
        // Only reads and Codex's plan arrive here: the answer is marked at
        // its first text, and the panel's flow completes the run.
        return;
    }
  };
  return {
    eventJournal: createAgentRunEventJournal({
      conversationKey: ctx.conversationKey,
      conversationGeneration: ctx.conversationGeneration,
      model: assistantMessage.modelName,
    }),
    onSkillActivated: (skillId) => {
      if (!isLive()) return;
      flushResponseStream("event");
      codexActivityTrace?.noteSkillActivated(skillId);
      setStatusSafely(`Codex skill activated: ${skillId}`, "sending");
    },
    onDelta: (delta) => {
      if (!isLive()) return;
      noteAnswering();
      handleDelta(delta);
    },
    onAgentMessageDelta: (event) => {
      if (!isLive()) return;
      noteAnswering();
      if (!codexActivityTrace?.appendAgentMessageDelta(event)) {
        handleDelta(event.delta);
      }
    },
    onReasoning: (reasoning) => {
      if (isLive()) handleReasoning(reasoning);
    },
    onUsage: (usage) => {
      if (isLive()) handleUsage(usage);
    },
    onItemStarted: (event) => {
      if (!isLive()) return;
      flushResponseStream("event");
      codexActivityTrace?.appendItemStatus(event, "started");
      const itemType = sanitizeText(event.type || "");
      if (itemType && !isCodexNativeAgentMessageItem(event)) {
        setStatusSafely(`Codex: ${itemType} started`, "sending");
      }
    },
    onItemCompleted: (event) => {
      if (!isLive()) return;
      flushResponseStream("event");
      codexActivityTrace?.noteAgentMessageCompleted(event);
      codexActivityTrace?.appendItemStatus(event, "completed");
      const itemType = sanitizeText(event.type || "");
      if (itemType && !isCodexNativeAgentMessageItem(event)) {
        setStatusSafely(`Codex: ${itemType} completed`, "sending");
      }
    },
    onPlanUpdated: (event) => {
      if (!isLive()) return;
      // Codex's plan is the run's steps in Task progress; the trace keeps it
      // as a persisted event and renders no row for it.
      codexActivityTrace?.appendNativePlanProgress(event.steps);
      applyTaskProgress({
        type: "codex_progress",
        itemId: CODEX_PLAN_CHECKLIST_ITEM_ID,
        // Only the steps are read; the text form is for older stored runs.
        text: "",
        steps: event.steps,
      });
    },
    onHostEvent: (event) => {
      if (!isLive()) return;
      flushResponseStream("event");
      codexActivityTrace?.appendHostEvent(event);
    },
    onMcpToolActivity: (event) => {
      if (!isLive()) return;
      flushResponseStream("event");
      codexActivityTrace?.noteMcpToolActivity(event);
      const ledgerUpdate = paperLedgerUpdateFromMcpActivity(event);
      if (ledgerUpdate) applyTaskProgress(ledgerUpdate);
      assistantMessage.quoteCitations = mergeQuoteCitations(
        assistantMessage.quoteCitations,
        event.quoteCitations,
      );
      const label =
        sanitizeText(event.toolLabel || "").trim() ||
        sanitizeText(event.toolName || "")
          .replace(/_/g, " ")
          .trim();
      if (label) {
        setStatusSafely(
          event.phase === "completed"
            ? `Codex: used ${label}`
            : `Codex: using ${label}`,
          "sending",
        );
      }
    },
    onMcpSetupWarning: (message) => {
      if (!isLive()) return;
      flushResponseStream("event");
      setStatusSafely(
        formatCodexZoteroMcpError(
          message,
          "Native conversation MCP setup warning",
        ),
        "error",
      );
    },
    onDiagnostics: (diagnostics) => {
      if (!isLive()) return;
      flushResponseStream("event");
      setStatusSafely(
        formatCodexNativeDiagnosticsStatus(diagnostics),
        "sending",
      );
    },
    onHostInteraction: async (action) => {
      return resolveCodexNativeHostInteractionWithTrace({
        body,
        action,
        trace: codexActivityTrace,
        isCurrent: isLive,
      });
    },
    onApprovalRequest: async (request) => {
      if (!isLive())
        return { approved: false, reason: "conversation_not_live" };
      flushResponseStream("event");
      return resolveCodexNativeApprovalWithOptionalReviewCard({
        body,
        request,
        trace: codexActivityTrace,
        setStatusSafely,
        isCurrent: () =>
          requireCurrentPanelOwnership(body, ctx.item, "agent-confirmation"),
      });
    },
  };
}

export const buildCodexNativeTurnCallbacksForTests =
  buildCodexNativeTurnCallbacks;

/**
 * One native Codex turn from the panel, shared by the send and retry flows.
 *
 * `turn` is what each flow sends Codex; `panel` is how the turn reaches the
 * panel while it runs. The assistant message takes the run and document the
 * turn reports, and the answer is the turn's text.
 */
export async function runCodexNativePanelTurn(
  turn: Omit<
    Parameters<typeof runCodexAppServerNativeTurn>[0],
    keyof CodexNativeTurnCallbacks
  >,
  panel: Parameters<typeof buildCodexNativeTurnCallbacks>[0],
  runNativeTurn: typeof runCodexAppServerNativeTurn = runCodexAppServerNativeTurn,
): Promise<ModelTurnOutcome> {
  const result = await runNativeTurn({
    ...turn,
    ...buildCodexNativeTurnCallbacks(panel),
  });
  panel.assistantMessage.agentRunId = result.agentRunId;
  if (result.documentId) {
    panel.assistantMessage.documentId = result.documentId;
  }
  return {
    text: result.text,
    completion: { status: "complete" as const },
  };
}

/**
 * The turn's answer is final: close its trace and show ✓ on its Task
 * progress run, with the papers the answer cites.
 *
 * Task progress follows the run the trace names. Until the trace persists,
 * the message holds the native turn's journal run instead, which Task
 * progress never saw.
 */
export function finishCodexNativePanelTurn(params: {
  conversationKey: number;
  assistantMessage: Message;
  codexActivityTrace: CodexNativeActivityTraceController | null;
}): void {
  const trace = params.codexActivityTrace;
  if (!trace) return;
  trace.finish(params.assistantMessage.text);
  completeTaskRun(params.conversationKey, {
    runId: trace.runId,
    quoteCitations: params.assistantMessage.quoteCitations,
  });
}
