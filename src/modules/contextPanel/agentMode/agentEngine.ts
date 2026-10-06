import { scheduleChatContentScroll } from "../chatScrollSnapshots";
import {
  applyTaskDocumentCitations,
  applyTaskPaperUpdate,
  beginTaskRun,
  completeTaskRun,
  endTaskRun,
  markTaskAnswering,
  markTaskWaiting,
  setTaskOutcomes,
  taskTurnIndexFor,
} from "../taskProgress/store";
/**
 * Agent mode execution engine.
 *
 * This module houses the send and retry flows for agent mode and is the single
 * place that calls agentRuntime.runTurn(). It has zero imports from chat.ts —
 * all chat.ts-owned utilities are injected via AgentEngineDeps so that agent
 * mode can be read and edited without opening chat.ts.
 */
import type { AgentRuntime } from "../../../agent/runtime";
import { ExecutionCheckpointFold } from "../../../agent/execution/checkpointEvents";
import { unansweredTurnError } from "../../../agent/execution/unansweredTurn";
import { taskProgressEffect } from "../taskProgress/runFold";
import type {
  AgentEvent,
  AgentPendingAction,
  AgentRunEventRecord,
  AgentRuntimeOutcome,
  AgentRuntimeRequestInput as AgentRuntimeRequest,
  AgentRuntimeUnansweredOutcome,
} from "../../../agent/types";
import { consumePendingRetentionEvents } from "../../../claudeCode/runtimeRetention";
import {
  captureClaudeSessionInfo,
  buildClaudeScope,
} from "../../../claudeCode/runtime";
import {
  resolveConversationBaseItem,
  resolveDisplayConversationKind,
} from "../portalScope";
import { mergeCitationPaperContexts } from "../citationContexts";
import { toStoredUserRowPatch } from "../storedUserRow";
import { filterMessagesInPendingTurns } from "../turnMessageUtils";
import { resolveStreamInterruptionOutcome } from "../streamInterruption";
import {
  restoreRetryUserSnapshot,
  takeRetryUserSnapshot,
} from "../retryUserSnapshot";
import {
  isGenericAgentStatusText,
  renderPendingActionCard,
} from "../agentTrace/render";
import {
  createBlockStreamCoalescer,
  type BlockStreamFlushReason,
} from "../blockStreamCoalescer";
import {
  createReasoningRefreshCoalescer,
  type ReasoningRefreshCoalescer,
} from "../agentTrace/reasoningRefreshCoalescer";

function buildPendingAgentTraceEvents(body?: Element): AgentRunEventRecord[] {
  const now = Date.now();
  const events: AgentRunEventRecord[] = [
    {
      runId: "pending",
      seq: 1,
      eventType: "status",
      payload: {
        type: "status",
        text: "Checking the request against the attached context.",
      },
      createdAt: now,
    },
    {
      runId: "pending",
      seq: 2,
      eventType: "status",
      payload: {
        type: "status",
        text: "Request and attached context received",
      },
      createdAt: now + 1,
    },
  ];
  if (!body) return events;
  const retentionEvents = consumePendingRetentionEvents(body);
  for (const event of retentionEvents) {
    events.push({
      runId: "pending",
      seq: events.length + 1,
      eventType: event.type,
      payload: event,
      createdAt: Date.now(),
    });
  }
  return events;
}

function applyResolvedClaudeEffortDisplay(
  body: Element,
  event: AgentEvent,
): void {
  if (event.type !== "provider_event") return;
  if (event.providerType !== "runtime_config") return;
  getPanelHandle(body)?.applyResolvedClaudeEffort(
    event.payload?.resolvedEffort,
  );
}
import type {
  AdvancedModelParams,
  ChatAttachment,
  CollectionContextRef,
  LocalDocumentResource,
  NoteContextRef,
  PaperContextRef,
  QuoteCitation,
  ResolvedSelectedTextAnchor,
  SelectedTextContext,
  SelectedTextSource,
  TagContextRef,
} from "../../../shared/types";
import type { ResolvedContextSource } from "../types";
import {
  toAgentRuntimeRequestParams,
  type BuildAgentRuntimeRequestParams,
  type EffectiveRequestConfig,
} from "../requestContext";
import type { UsageStats } from "../../../shared/llm";
import type { ReasoningConfig as LLMReasoningConfig } from "../../../utils/llmClient";
import type { ChatMessage } from "../../../utils/llmClient";
import type { StoredChatMessage } from "../../../utils/chatStore";
import type { Message } from "../types";
import { isClaudeBlockStreamingEnabled } from "../../../claudeCode/prefs";
import { recordContextCacheTelemetry } from "../../../contextCache/manager";
import {
  buildSelectedTextQuoteCitations,
  extractQuoteCitationsFromToolContent,
  mergeQuoteCitations,
  selectUsedQuoteCitations,
} from "../../../services/quotes/quoteCitations";
import { synthesizeSelectedTextContexts } from "../../../services/context/normalizers";
import { resolveSelectedTextAnchors } from "../selectedTextAnchors";
import { getPanelHandle } from "../panelHandle";

function readUsageNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function normalizeAgentUsageForCacheTelemetry(
  event: Extract<AgentEvent, { type: "usage" }>,
): UsageStats {
  const record = event as unknown as Record<string, unknown>;
  const promptTokens =
    readUsageNumber(record, "promptTokens") ||
    readUsageNumber(record, "inputTokens") ||
    readUsageNumber(record, "contextTokens");
  const completionTokens =
    readUsageNumber(record, "completionTokens") ||
    readUsageNumber(record, "outputTokens");
  const totalTokens =
    readUsageNumber(record, "totalTokens") || promptTokens + completionTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens:
      typeof record.cacheReadTokens === "number"
        ? Math.max(0, record.cacheReadTokens)
        : undefined,
    cacheWriteTokens:
      typeof record.cacheWriteTokens === "number"
        ? Math.max(0, record.cacheWriteTokens)
        : undefined,
    cacheMissTokens:
      typeof record.cacheMissTokens === "number"
        ? Math.max(0, record.cacheMissTokens)
        : undefined,
    cacheHitRatio:
      typeof record.cacheHitRatio === "number"
        ? Math.max(0, Math.min(1, record.cacheHitRatio))
        : undefined,
    cacheProvider:
      typeof record.cacheProvider === "string"
        ? record.cacheProvider
        : undefined,
    contextTokens:
      typeof record.contextTokens === "number"
        ? Math.max(0, record.contextTokens)
        : undefined,
    contextWindow:
      typeof record.contextWindow === "number"
        ? Math.max(0, record.contextWindow)
        : undefined,
    contextWindowIsAuthoritative: record.contextWindowIsAuthoritative === true,
  };
}

function shouldSyncVisibleRollbackText(message: Message): boolean {
  return (
    isClaudeBlockStreamingEnabled() || message.modelProviderLabel === "Codex"
  );
}

function appendPendingFinalText(
  message: Message,
  text: string,
  sanitizeText: (text: string) => string,
): void {
  const clean = sanitizeText(text);
  if (!clean) return;
  message.pendingFinalText = `${message.pendingFinalText || ""}${clean}`;
  message.text = message.pendingFinalText || message.text;
}

/**
 * The stored-row patch for a turn's user message, written by the onStart and
 * tool_result persistence in both the send and retry paths and by the retry
 * restore. Every field is named, so no update NULLs one.
 */
function buildStoredUserMessagePatch(
  message: Message,
): Parameters<AgentEngineDeps["updateStoredLatestUserMessage"]>[1] {
  return toStoredUserRowPatch(message, { runMode: "agent" });
}

type AgentTurnEventContext = {
  deps: AgentEngineDeps;
  body: Element;
  ui: PanelRequestUIShape;
  conversationKey: number;
  runtimeRequest: AgentRuntimeRequest;
  assistantMessage: Message;
  pairedUserMessage: Message;
  /** The in-memory history array compact markers are spliced into. */
  history: Message[];
  /** /compact turns skip user-message persistence; retries never compact. */
  isCompactCommand: boolean;
  /**
   * How a context_compacted event treats the streaming assistant bubble:
   * send replaces it (clears text/trace, and drops it from history on manual
   * compacts); retry keeps it untouched.
   */
  compactStyle: "replace-assistant" | "keep-assistant";
  onContextCompacted?: () => void;
  messageDeltaCoalescer: { pushText: (text: string) => void };
  flushMessageDeltas: (reason: BlockStreamFlushReason) => void;
  /**
   * Batches thinking repaints. The turn owns it so every way the turn ends
   * can flush or cancel what is waiting; a caller without one gets a
   * handler-local coalescer.
   */
  reasoningRefreshes?: ReasoningRefreshCoalescer;
  queueRefresh: () => void;
  refreshAssistant: () => void;
  refreshChatSafely: () => void;
  setStatusSafely: (text: string, kind: StatusKind) => void;
  pushTraceEvent: (runId: string, event: AgentEvent) => void;
  scheduleQueueDrain: () => void;
};

/**
 * The per-event consumer for an agent runtime turn. Send and retry previously
 * carried two hand-synchronized ~300-line copies of this switch; they differ
 * only in which user message is paired with the turn, which history array
 * receives compact markers, and how compaction treats the assistant bubble.
 */
export function createAgentTurnEventHandler(
  ctx: AgentTurnEventContext,
): (event: AgentEvent) => Promise<void> {
  const {
    deps,
    body,
    ui,
    conversationKey,
    runtimeRequest,
    assistantMessage,
    pairedUserMessage,
    history,
    isCompactCommand,
    compactStyle,
    onContextCompacted,
    messageDeltaCoalescer,
    flushMessageDeltas,
    queueRefresh,
    refreshChatSafely,
    setStatusSafely,
    pushTraceEvent,
    scheduleQueueDrain,
  } = ctx;
  // Thinking streams in deltas far faster than a repaint is worth: the
  // message records each one, and the trace repaints for them in batches.
  const reasoningRefreshes =
    ctx.reasoningRefreshes ??
    createReasoningRefreshCoalescer({ onFlush: () => queueRefresh() });
  // Task progress follows the run: working from its start, the paper ledger
  // as reads land, answering at the first answer text, ✓ at final.
  let taskRunBegun = false;
  // Approvals already settled. The card's second, delayed paint must not
  // bring back a card settled before it ran (the same chat open in another
  // surface can approve it at once).
  const settledConfirmationIds = new Set<string>();
  // The run's outcome ledger, folded from its whole and delta events.
  const outcomeLedger = new ExecutionCheckpointFold();
  const ensureTaskRun = () => {
    if (taskRunBegun || !assistantMessage.agentRunId) return;
    taskRunBegun = true;
    beginTaskRun(conversationKey, {
      runId: assistantMessage.agentRunId,
      turnIndex: taskTurnIndexFor(history, pairedUserMessage) || undefined,
      text: pairedUserMessage.text,
    });
  };
  // What the event does to Task progress, read by the one fold the rebuild
  // of a stored conversation shares, applied here as the event arrives.
  const applyTaskProgress = (event: AgentEvent): void => {
    const effect = taskProgressEffect(event);
    if (!effect) return;
    const runId = assistantMessage.agentRunId;
    switch (effect.kind) {
      case "paper_delta":
        applyTaskPaperUpdate(conversationKey, effect.delta, runId);
        return;
      case "document_citations":
        // The papers a submitted document cites, under their sections.
        if (effect.citations?.length) {
          applyTaskDocumentCitations(conversationKey, runId, effect.citations);
        }
        return;
      case "outcomes": {
        // The run's outcomes, as its ledger stands, are its Task progress steps.
        const checkpoint = outcomeLedger.apply(effect.event);
        if (runId && checkpoint) {
          setTaskOutcomes(conversationKey, runId, checkpoint);
        }
        return;
      }
      case "answering":
        markTaskAnswering(conversationKey, runId);
        return;
      case "waiting":
        markTaskWaiting(conversationKey, runId, effect.waiting);
        return;
      case "final":
        completeTaskRun(conversationKey, {
          runId,
          quoteCitations: selectUsedQuoteCitations({
            text: assistantMessage.text,
            quoteCitations: assistantMessage.quoteCitations,
          }),
          libraryID: runtimeRequest.libraryID,
        });
        return;
      default:
        // A Codex plan or a retired plan event never reaches this engine's
        // Task progress: native Codex turns are wired in the chat panel.
        return;
    }
  };
  return async (event: AgentEvent): Promise<void> => {
    ensureTaskRun();
    if (assistantMessage.agentRunId) {
      pushTraceEvent(assistantMessage.agentRunId, event);
    }
    if (event.type !== "message_delta") {
      flushMessageDeltas(event.type === "final" ? "final" : "event");
    }
    // Waiting thinking is painted before whatever the run reports next.
    if (event.type !== "reasoning") reasoningRefreshes.flushNow();
    switch (event.type) {
      case "provider_event":
        applyResolvedClaudeEffortDisplay(body, event);
        break;
      case "usage": {
        const usageEvent = event as Extract<AgentEvent, { type: "usage" }>;
        recordContextCacheTelemetry(
          runtimeRequest.contextCache,
          normalizeAgentUsageForCacheTelemetry(usageEvent),
        );
        if (ui.tokenUsageEl) {
          const previous = deps.getContextUsageSnapshot?.(conversationKey);
          const usageRecord = usageEvent as unknown as Record<string, unknown>;
          const hasContextPayload = "contextTokens" in usageRecord;
          if (hasContextPayload) {
            const nextTokens = Math.max(
              0,
              Number(usageRecord.contextTokens) || 0,
            );
            const rawContextWindow = usageRecord.contextWindow;
            const nextWindow =
              typeof rawContextWindow === "number" &&
              Number.isFinite(rawContextWindow)
                ? rawContextWindow
                : previous?.contextWindow;
            const effectiveTokens =
              nextTokens > 0
                ? nextTokens
                : usageRecord.contextWindowIsAuthoritative === true
                  ? (previous?.contextTokens ?? 0)
                  : 0;
            deps.setContextUsageSnapshot?.(conversationKey, {
              contextTokens: effectiveTokens,
              contextWindow: nextWindow,
              contextWindowIsAuthoritative:
                usageRecord.contextWindowIsAuthoritative === true,
              cacheReadTokens:
                typeof usageRecord.cacheReadTokens === "number"
                  ? usageRecord.cacheReadTokens
                  : undefined,
              cacheWriteTokens:
                typeof usageRecord.cacheWriteTokens === "number"
                  ? usageRecord.cacheWriteTokens
                  : undefined,
              cacheMissTokens:
                typeof usageRecord.cacheMissTokens === "number"
                  ? usageRecord.cacheMissTokens
                  : undefined,
              cacheHitRatio:
                typeof usageRecord.cacheHitRatio === "number"
                  ? usageRecord.cacheHitRatio
                  : undefined,
              cacheProvider:
                typeof usageRecord.cacheProvider === "string"
                  ? usageRecord.cacheProvider
                  : undefined,
              estimated: usageRecord.contextWindowIsAuthoritative !== true,
              source:
                usageRecord.contextWindowIsAuthoritative === true
                  ? "provider"
                  : "estimated",
            });
            deps.setTokenUsage(
              ui.tokenUsageEl,
              effectiveTokens,
              nextWindow,
              body.querySelector("#llm-context-gauge") as HTMLElement | null,
              {
                estimated: usageRecord.contextWindowIsAuthoritative !== true,
                cacheReadTokens:
                  typeof usageRecord.cacheReadTokens === "number"
                    ? usageRecord.cacheReadTokens
                    : undefined,
                cacheWriteTokens:
                  typeof usageRecord.cacheWriteTokens === "number"
                    ? usageRecord.cacheWriteTokens
                    : undefined,
                cacheMissTokens:
                  typeof usageRecord.cacheMissTokens === "number"
                    ? usageRecord.cacheMissTokens
                    : undefined,
                cacheHitRatio:
                  typeof usageRecord.cacheHitRatio === "number"
                    ? usageRecord.cacheHitRatio
                    : undefined,
                cacheProvider:
                  typeof usageRecord.cacheProvider === "string"
                    ? usageRecord.cacheProvider
                    : undefined,
              },
            );
          } else if (
            typeof usageRecord.totalTokens === "number" &&
            usageRecord.totalTokens > 0
          ) {
            deps.accumulateSessionTokens(
              conversationKey,
              usageRecord.totalTokens,
            );
          }
        }
        break;
      }
      case "tool_result": {
        if (!event.ok) break;
        mergeAgentToolResultQuoteCitations(assistantMessage, event);
        const toolPaperContexts = deps.normalizePaperContexts([
          ...extractPaperContextCandidatesFromToolContent(event.content),
          ...extractPaperContextCandidatesFromToolContent(event.artifacts),
        ]);
        if (!toolPaperContexts.length) break;
        const before = pairedUserMessage.citationPaperContexts?.length || 0;
        pairedUserMessage.citationPaperContexts = mergeCitationPaperContexts(
          pairedUserMessage.citationPaperContexts,
          toolPaperContexts,
        ).slice(0, MAX_AGENT_EVIDENCE_PAPER_CONTEXTS);
        if ((pairedUserMessage.citationPaperContexts?.length || 0) === before)
          break;
        if (!isCompactCommand) {
          await deps.updateStoredLatestUserMessage(
            conversationKey,
            buildStoredUserMessagePatch(pairedUserMessage),
          );
        }
        break;
      }
      case "status": {
        const isCompactingStatus = /compacting context/i.test(event.text);
        // A status can come before the run starts: the wait for a stopped
        // run, and the Claude bridge adapter's session-resume retry notice.
        if (
          !isCompactingStatus &&
          !assistantMessage.agentRunId &&
          assistantMessage.pendingAgentTraceEvents
        ) {
          assistantMessage.pendingAgentTraceEvents.push({
            runId: "pending",
            seq: assistantMessage.pendingAgentTraceEvents.length + 1,
            eventType: event.type,
            payload: event,
            createdAt: Date.now(),
          });
        }
        setStatusSafely(
          isGenericAgentStatusText(event.text) ? "Working" : event.text,
          "sending",
        );
        if (isCompactingStatus) {
          assistantMessage.pendingAgentTraceEvents = undefined;
        }
        queueRefresh();
        return;
      }
      case "reasoning": {
        if (event.summary) {
          assistantMessage.reasoningSummary = deps.appendReasoningPart(
            assistantMessage.reasoningSummary,
            event.summary,
          );
        }
        if (event.details) {
          assistantMessage.reasoningDetails = deps.appendReasoningPart(
            assistantMessage.reasoningDetails,
            event.details,
          );
        }
        reasoningRefreshes.push(`${event.summary || ""}${event.details || ""}`);
        return;
      }
      case "fallback":
        if (assistantMessage.text === "Compacting context…") {
          assistantMessage.text = "";
        }
        setStatusSafely(event.reason, "sending");
        break;
      case "confirmation_required":
        // The run waits on the user's decision until the card resolves.
        applyTaskProgress(event);
        showInlineConfirmationCard(body, ui, event.requestId, event.action);
        queueRefresh();
        body.ownerDocument?.defaultView?.setTimeout(() => {
          if (settledConfirmationIds.has(event.requestId)) return;
          showInlineConfirmationCard(body, ui, event.requestId, event.action);
        }, 90);
        setStatusSafely("Approval required", "sending");
        return;
      case "confirmation_resolved":
        applyTaskProgress(event);
        settledConfirmationIds.add(event.requestId);
        closeInlineConfirmationCard(body, ui, event.requestId);
        queueRefresh();
        setStatusSafely(
          event.approved ? "Approval sent" : "Action denied",
          "sending",
        );
        return;
      case "message_delta": {
        // The answer is streaming: the row says so and an open overlay
        // collapses, back to the chat the answer arrives in.
        applyTaskProgress(event);
        messageDeltaCoalescer.pushText(deps.sanitizeText(event.text));
        return;
      }
      case "paper_ledger_update":
        applyTaskProgress(event);
        return;
      case "material_finalized":
        applyTaskProgress(event);
        // As before: the assistant refreshes after the event (the store
        // repaints the Task progress view on its own).
        break;
      case "execution_checkpoint":
      case "execution_checkpoint_delta":
        applyTaskProgress(event);
        break;
      case "message_rollback":
        if (typeof event.length === "number" && event.length > 0) {
          assistantMessage.pendingFinalText = (
            assistantMessage.pendingFinalText || ""
          ).slice(
            0,
            Math.max(
              0,
              (assistantMessage.pendingFinalText || "").length - event.length,
            ),
          );
          if (shouldSyncVisibleRollbackText(assistantMessage)) {
            assistantMessage.text = assistantMessage.pendingFinalText || "";
            queueRefresh();
          }
        }
        return;
      case "context_compacted": {
        onContextCompacted?.();
        const compactMarker: Message = {
          role: "assistant",
          text: event.automatic
            ? "Context compacted automatically"
            : "Conversation compacted",
          timestamp: Date.now(),
          runMode: "agent",
          compactMarker: true,
          modelName: assistantMessage.modelName,
          modelEntryId: assistantMessage.modelEntryId,
          modelProviderLabel: assistantMessage.modelProviderLabel,
        };
        const insertIndex = Math.max(0, history.indexOf(assistantMessage));
        history.splice(insertIndex, 0, compactMarker);
        if (compactStyle === "replace-assistant" && !event.automatic) {
          const assistantIndex = history.indexOf(assistantMessage);
          if (assistantIndex >= 0) history.splice(assistantIndex, 1);
        }
        await deps.persistConversationMessage(conversationKey, {
          role: "assistant",
          text: compactMarker.text,
          timestamp: compactMarker.timestamp,
          runMode: "agent",
          modelName: compactMarker.modelName,
          modelEntryId: compactMarker.modelEntryId,
          modelProviderLabel: compactMarker.modelProviderLabel,
          compactMarker: true,
        });
        if (compactStyle === "replace-assistant") {
          assistantMessage.text = "";
          assistantMessage.pendingAgentTraceEvents = undefined;
        }
        refreshChatSafely();
        scheduleQueueDrain();
        await deps.waitForUiStep();
        return;
      }
      case "final":
        applyFinalQuoteCitations(assistantMessage, event.quoteCitations);
        assistantMessage.documentId = event.documentId || event.planDocumentId;
        assistantMessage.planDocumentId = event.planDocumentId;
        assistantMessage.text =
          (assistantMessage.documentId
            ? event.text
            : deps.sanitizeText(event.text)) ||
          assistantMessage.pendingFinalText ||
          assistantMessage.text;
        // Keep the exact final text recoverable until the outcome owner has
        // persisted the chat row and completed its presentation.
        assistantMessage.pendingFinalText = assistantMessage.text;
        assistantMessage.waitingAnimationStartedAt = undefined;
        assistantMessage.streaming = false;
        applyTaskProgress(event);
        break;
      default:
        break;
    }
    ctx.refreshAssistant();
    await deps.waitForUiStep();
  };
}

/**
 * The callbacks a turn's run reports through, shared by send and retry. At
 * its start the run is bound to the assistant and the paired user message,
 * its Task progress row begins, and its trace opens; its events are handled
 * by {@link createAgentTurnEventHandler}. The wait for a stopped run, before
 * the run starts, shows as the run's status did.
 */
function startAgentTurnRun(
  ctx: Omit<AgentTurnEventContext, "pushTraceEvent">,
): {
  onStart: (runId: string) => Promise<void>;
  onEvent: (event: AgentEvent) => Promise<void>;
  onWaiting: (text: string) => Promise<void>;
} {
  const {
    deps,
    conversationKey,
    assistantMessage,
    pairedUserMessage,
    history,
    isCompactCommand,
    refreshChatSafely,
  } = ctx;
  const pushTraceEvent = (runId: string, event: AgentEvent) => {
    const list = deps.agentRunTraceCache.get(runId) || [];
    list.push({
      runId,
      seq: list.length + 1,
      eventType: event.type,
      payload: event,
      createdAt: Date.now(),
    });
    deps.agentRunTraceCache.set(runId, list);
  };
  const onEvent = createAgentTurnEventHandler({ ...ctx, pushTraceEvent });
  return {
    onStart: async (runId) => {
      assistantMessage.agentRunId = runId;
      pairedUserMessage.agentRunId = runId;
      beginTaskRun(conversationKey, {
        runId,
        turnIndex: taskTurnIndexFor(history, pairedUserMessage) || undefined,
        text: pairedUserMessage.text,
      });
      deps.agentRunTraceCache.set(runId, []);
      refreshChatSafely();
      if (!isCompactCommand) {
        await deps.updateStoredLatestUserMessage(
          conversationKey,
          buildStoredUserMessagePatch(pairedUserMessage),
        );
      }
    },
    onEvent,
    onWaiting: (text) => onEvent({ type: "status", text }),
  };
}

/**
 * How a turn ends once its run has: an answered or fallback outcome is
 * finalized; a cancelled one ends as the user's Stop; a failed one, or a
 * thrown error, ends as a failure. Shared by send and retry.
 *
 * What the cancelled or failed ending throws is not a second failure: it
 * leaves the turn, as it did when the run threw instead of returning.
 */
async function settleAgentTurn(ctx: {
  run: () => Promise<AgentRuntimeOutcome>;
  finalize: (
    outcome: Exclude<AgentRuntimeOutcome, AgentRuntimeUnansweredOutcome>,
  ) => Promise<void>;
  reasoningRefreshes: Pick<ReasoningRefreshCoalescer, "flushNow">;
  markCancelled: () => Promise<void>;
  failTurn: (err: unknown) => Promise<void>;
}): Promise<void> {
  let unanswered: AgentRuntimeUnansweredOutcome | undefined;
  try {
    const outcome = await ctx.run();
    if (outcome.kind === "cancelled" || outcome.kind === "failed") {
      unanswered = outcome;
    } else {
      // A run can end without a final event; nothing it streamed may
      // repaint after the outcome below finalizes the message.
      ctx.reasoningRefreshes.flushNow();
      await ctx.finalize(outcome);
    }
  } catch (err) {
    await ctx.failTurn(err);
    return;
  }
  if (unanswered?.kind === "cancelled") await ctx.markCancelled();
  else if (unanswered) await ctx.failTurn(unansweredTurnError(unanswered));
}

/**
 * Post-runTurn success finalization, shared by send and retry: cancellation
 * re-check, final text resolution, quote-citation finalization, persistence,
 * and the Claude session capture.
 */
async function finalizeAgentTurnOutcome(ctx: {
  deps: AgentEngineDeps;
  item: Zotero.Item;
  conversationKey: number;
  thisRequestId: number;
  outcome: Exclude<AgentRuntimeOutcome, AgentRuntimeUnansweredOutcome>;
  assistantMessage: Message;
  pairedUserMessage: Message;
  runtimeRequest: AgentRuntimeRequest;
  refreshChatSafely: () => void;
  markCancelled: () => Promise<void>;
  persistAssistantOnce: () => Promise<void>;
  uiRelease: RequestUiReleaseController;
  /** Send skips the assistant persist when a /compact turn already handled it. */
  skipAssistantPersist: boolean;
}): Promise<void> {
  const {
    deps,
    item,
    conversationKey,
    thisRequestId,
    outcome,
    assistantMessage,
    pairedUserMessage,
    runtimeRequest,
    refreshChatSafely,
    markCancelled,
    persistAssistantOnce,
    uiRelease,
    skipAssistantPersist,
  } = ctx;
  if (
    !uiRelease.isReleased() &&
    (deps.cancelledRequestId(conversationKey) >= thisRequestId ||
      Boolean(deps.currentAbortController(conversationKey)?.signal.aborted))
  ) {
    await markCancelled();
    return;
  }

  assistantMessage.agentRunId = outcome.runId;
  assistantMessage.runMode = "agent";
  assistantMessage.documentId =
    outcome.kind === "completed"
      ? outcome.documentId || outcome.planDocumentId
      : undefined;
  assistantMessage.planDocumentId =
    outcome.kind === "completed" ? outcome.planDocumentId : undefined;
  const finalOutcomeText =
    outcome.kind === "completed"
      ? outcome.text
      : assistantMessage.pendingFinalText || assistantMessage.text;
  assistantMessage.text =
    (assistantMessage.documentId
      ? finalOutcomeText
      : deps.sanitizeText(finalOutcomeText)) ||
    assistantMessage.pendingFinalText ||
    assistantMessage.text ||
    "No response.";
  await deps.finalizeAssistantQuoteCitations(
    assistantMessage,
    pairedUserMessage,
    runtimeRequest,
  );
  // Anchors are bound on use: the completed answer keeps only the quotes it
  // actually used, so what is rendered matches what is persisted.  The full
  // retrieved set stays in the run's tool results (a big one by handle); the
  // final event already carries only the citations the answer uses.
  assistantMessage.quoteCitations = selectUsedQuoteCitations({
    text: assistantMessage.text,
    quoteCitations: assistantMessage.quoteCitations,
  });
  // The row's citations are the chips the answer renders.
  completeTaskRun(conversationKey, {
    runId: assistantMessage.agentRunId,
    quoteCitations: assistantMessage.quoteCitations,
    libraryID: runtimeRequest.libraryID,
  });
  if (!skipAssistantPersist) {
    await persistAssistantOnce();
  }
  assistantMessage.pendingFinalText = undefined;
  assistantMessage.waitingAnimationStartedAt = undefined;
  assistantMessage.streaming = false;
  refreshChatSafely();
  if (deps.getConversationSystem?.() === "claude_code") {
    const conversationKind = resolveDisplayConversationKind(item);
    const baseItem = resolveConversationBaseItem(item);
    await captureClaudeSessionInfo(
      conversationKey,
      buildClaudeScope({
        libraryID: Number(item.libraryID || baseItem?.libraryID || 0),
        kind: conversationKind === "global" ? "global" : "paper",
        paperItemID:
          conversationKind === "paper"
            ? Number(baseItem?.id || 0) || undefined
            : undefined,
        paperTitle:
          conversationKind === "paper"
            ? String(baseItem?.getField?.("title") || "").trim() || undefined
            : undefined,
      }),
      runtimeRequest.conversationGeneration,
    ).catch(() => null);
  }
  uiRelease.releaseReady();
}

/**
 * Shared failure path for an agent turn: keep whatever streamed (marking the
 * reply interrupted) or fall back to the bare error text, then persist and
 * surface the error in the status row.
 */
async function handleAgentTurnFailure(ctx: {
  err: unknown;
  deps: AgentEngineDeps;
  conversationKey: number;
  thisRequestId: number;
  assistantMessage: Message;
  messageDeltaCoalescer: {
    flushNow: (reason: BlockStreamFlushReason) => void;
    cancel: () => void;
  };
  /** Waiting thinking repaints, dropped with the stream they belong to. */
  reasoningRefreshes?: Pick<ReasoningRefreshCoalescer, "cancel">;
  refreshChatSafely: () => void;
  setStatusSafely: (text: string, kind: StatusKind) => void;
  markCancelled: () => Promise<void>;
  persistAssistantOnce: () => Promise<void>;
  /**
   * Retry passes this to restore the pre-retry assistant message when the
   * failed attempt streamed nothing — a preserved interrupted partial (or the
   * previous answer) must not be overwritten by bare error text.
   */
  restorePreviousAssistant?: () => void;
  /**
   * Retry also passes this: rolls the paired user row (model identity,
   * rebuilt contexts, run linkage) back to its pre-retry state and rewrites
   * the stored row that onStart already stamped with the failed retry's
   * metadata. Runs only alongside restorePreviousAssistant, so the stored
   * turn stays a consistent pair.
   */
  restorePairedUser?: () => Promise<void>;
}): Promise<void> {
  const {
    err,
    deps,
    conversationKey,
    thisRequestId,
    assistantMessage,
    messageDeltaCoalescer,
    reasoningRefreshes,
    refreshChatSafely,
    setStatusSafely,
    markCancelled,
    persistAssistantOnce,
    restorePreviousAssistant,
    restorePairedUser,
  } = ctx;
  const isCancelled =
    deps.cancelledRequestId(conversationKey) >= thisRequestId ||
    Boolean(deps.currentAbortController(conversationKey)?.signal.aborted) ||
    (err as { name?: string }).name === "AbortError";
  if (isCancelled) {
    await markCancelled();
    return;
  }
  const errMsg = (err as Error).message || "Error";
  const userFacingError =
    errMsg.includes("[ede_diagnostic]") &&
    errMsg.includes("last_content_type=none")
      ? "The model returned an empty reply. Please retry."
      : errMsg;
  // Preserve whatever streamed before the failure instead of discarding it.
  // Flush the unflushed tail into pendingFinalText and read THAT — unlike the
  // coalescer's grow-only buffer, pendingFinalText respects message_rollback,
  // so text the model retracted between tool rounds is not resurrected.
  messageDeltaCoalescer.flushNow("cancel");
  const partialText = assistantMessage.pendingFinalText || "";
  const finalText =
    assistantMessage.streaming === false ? assistantMessage.text : "";
  messageDeltaCoalescer.cancel();
  reasoningRefreshes?.cancel();
  // A delivery error after the final event does not make the answer partial.
  const outcome = finalText
    ? { text: finalText, interrupted: false }
    : resolveStreamInterruptionOutcome({
        partialText,
        errorMessage: userFacingError,
      });
  // The run stopped early; the row keeps the partial ledger and says how,
  // as the conversation will say once it is reopened.
  endTaskRun(
    conversationKey,
    outcome.interrupted ? "interrupted" : "failed",
    assistantMessage.agentRunId,
  );
  if (!finalText && !outcome.interrupted && restorePreviousAssistant) {
    restorePreviousAssistant();
    await restorePairedUser?.();
    refreshChatSafely();
    setStatusSafely(`Error: ${userFacingError.slice(0, 40)}`, "error");
    return;
  }
  assistantMessage.text = outcome.text;
  assistantMessage.interrupted = outcome.interrupted;
  // Clear the per-turn accumulator so a later retry cannot concatenate
  // this turn's partial onto its own deltas.
  assistantMessage.pendingFinalText = undefined;
  assistantMessage.streaming = false;
  try {
    await persistAssistantOnce();
    refreshChatSafely();
  } finally {
    setStatusSafely(`Error: ${userFacingError.slice(0, 40)}`, "error");
  }
}

export function mergeAgentToolResultQuoteCitations(
  message: { quoteCitations?: QuoteCitation[] },
  event: Pick<Extract<AgentEvent, { type: "tool_result" }>, "ok"> & {
    content?: unknown;
    artifacts?: unknown;
  },
): void {
  if (!event.ok) return;
  const toolQuoteCitations = mergeQuoteCitations(
    extractQuoteCitationsFromToolContent(event.content),
    extractQuoteCitationsFromToolContent(event.artifacts),
  );
  if (!toolQuoteCitations.length) return;
  message.quoteCitations = mergeQuoteCitations(
    message.quoteCitations,
    toolQuoteCitations,
  );
}

/**
 * The runtime's final citations are the same ids re-anchored to their
 * claims; replace by id and keep everything else (selected-text anchors).
 */
export function applyFinalQuoteCitations(
  message: { quoteCitations?: QuoteCitation[] },
  finalCitations: readonly QuoteCitation[] | undefined,
): void {
  if (!finalCitations?.length) return;
  const byId = new Map(
    finalCitations.map((citation) => [citation.id, citation]),
  );
  const current = message.quoteCitations || [];
  const replaced = current.map((citation) => byId.get(citation.id) || citation);
  const known = new Set(replaced.map((citation) => citation.id));
  message.quoteCitations = [
    ...replaced,
    ...finalCitations.filter((citation) => !known.has(citation.id)),
  ];
}

// ---------------------------------------------------------------------------
// Types for panel helpers (defined inline to avoid importing from chat.ts)
// ---------------------------------------------------------------------------

type PanelRequestUIShape = {
  inputBox: HTMLTextAreaElement | null;
  chatBox: HTMLDivElement | null;
  sendBtn: HTMLButtonElement | null;
  cancelBtn: HTMLButtonElement | null;
  status: HTMLElement | null;
  tokenUsageEl: HTMLElement | null;
};

type StatusKind = "ready" | "sending" | "error" | "warning";

type PanelUpdateHelpers = {
  refreshChatSafely: () => void;
  refreshAssistantMessageSafely: (message: Message) => void;
  /** Turn completion: rebuild the finished answer and its prompt only. */
  refreshCompletedAssistantTurnSafely: (message: Message) => void;
  setStatusSafely: (text: string, kind: StatusKind) => void;
};

function syncInlineActionCardState(
  body: Element,
  ui: PanelRequestUIShape,
): void {
  const hasCard = Boolean(ui.chatBox?.querySelector(".llm-action-inline-card"));
  const panelRoot = body as HTMLElement;
  if (hasCard) {
    panelRoot.dataset.hasActionCard = "true";
  } else {
    delete panelRoot.dataset.hasActionCard;
  }
}

function findRenderedPendingActionCard(
  chatBox: HTMLElement,
  requestId: string,
): HTMLElement | null {
  const cards = Array.from(
    chatBox.querySelectorAll(".llm-agent-hitl-card[data-request-id]"),
  ) as HTMLElement[];
  return cards.find((card) => card.dataset.requestId === requestId) || null;
}

function showInlineConfirmationCard(
  body: Element,
  ui: PanelRequestUIShape,
  requestId: string,
  action: AgentPendingAction,
): void {
  const chatBox = ui.chatBox;
  const ownerDoc = body.ownerDocument;
  if (!chatBox || !ownerDoc) return;
  chatBox.querySelector(".llm-action-inline-card")?.remove();
  const renderedCard = findRenderedPendingActionCard(chatBox, requestId);
  if (renderedCard) {
    scheduleChatContentScroll(chatBox);
    syncInlineActionCardState(body, ui);
    return;
  }
  const wrapper = ownerDoc.createElement("div");
  wrapper.className = "llm-action-inline-card llm-action-inline-card-review";
  wrapper.dataset.requestId = requestId;
  wrapper.appendChild(renderPendingActionCard(ownerDoc, { requestId, action }));
  chatBox.appendChild(wrapper);
  scheduleChatContentScroll(chatBox);
  syncInlineActionCardState(body, ui);
}

function closeInlineConfirmationCard(
  body: Element,
  ui: PanelRequestUIShape,
  requestId?: string,
): void {
  const chatBox = ui.chatBox;
  if (!chatBox) return;
  let card: Element | null = null;
  if (requestId) {
    card =
      (
        Array.from(
          chatBox.querySelectorAll(".llm-action-inline-card"),
        ) as HTMLElement[]
      ).find((entry) => entry.dataset.requestId === requestId) ||
      chatBox.querySelector(".llm-action-inline-card");
  } else {
    card = chatBox.querySelector(".llm-action-inline-card");
  }
  card?.remove();
  syncInlineActionCardState(body, ui);
}

/**
 * Provenance for one answer, bounded to roughly the number of evidence
 * snippets a single retrieval returns.  This is a guard against a runaway
 * agent run, not a relevance filter: the cost of consuming these papers is
 * bounded where it is actually paid — background quote-source warming caps
 * how many PDFs it reads, and a quote click caps how many it verifies.
 */
const MAX_AGENT_EVIDENCE_PAPER_CONTEXTS = 80;

/**
 * Recover the papers a tool actually grounded its answer in.
 *
 * Every tool nests this evidence differently — `library_retrieve` only exposes
 * an attachment id on its `snippets`, `paper_read` on its `results` — so this
 * walks the whole result rather than a list of key names that silently goes
 * stale whenever a tool gains a new result shape.  A record counts as a paper
 * only when it can name both the item and the attachment to open, which is
 * specific enough that unrelated payload objects do not qualify.
 */
function extractPaperContextCandidatesFromToolContent(
  content: unknown,
): unknown[] {
  const out: unknown[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      Number.isFinite(Number(record.itemId)) &&
      Number.isFinite(Number(record.contextItemId)) &&
      typeof record.title === "string"
    ) {
      out.push(record);
    }
    for (const nested of Object.values(record)) {
      visit(nested, depth + 1);
    }
  };
  visit(content, 0);
  return out;
}

export const extractPaperContextCandidatesFromToolContentForTests =
  extractPaperContextCandidatesFromToolContent;

type LatestRetryPairShape = {
  userIndex: number;
  userMessage: Message;
  assistantMessage: Message;
};

type ReconstructedRetryPayload = {
  question: string;
  screenshotImages: string[];
  paperContexts: PaperContextRef[];
  pdfPaperContexts: PaperContextRef[];
  fullTextPaperContexts: PaperContextRef[];
  citationPaperContexts?: PaperContextRef[];
  selectedCollectionContexts: CollectionContextRef[];
  selectedTagContexts: TagContextRef[];
};

// ---------------------------------------------------------------------------
// AgentEngineDeps — all external dependencies injected by chat.ts
// ---------------------------------------------------------------------------

export type AgentEngineDeps = {
  /** Captured before the turn starts; Clear bumps this generation. */
  conversationGeneration?: number;
  // Chat history (mutable Map reference; push() on the retrieved array mutates state)
  chatHistory: Map<number, Message[]>;

  // Agent trace cache
  agentRunTraceCache: Map<string, AgentRunEventRecord[]>;

  // Request lifecycle (per-conversation)
  cancelledRequestId: (conversationKey: number) => number;
  currentAbortController: (conversationKey: number) => AbortController | null;
  getAbortControllerCtor: () => (new () => AbortController) | undefined;
  nextRequestId: () => number;
  tryBeginRequest: (
    conversationKey: number,
    requestId: number,
    abortController: AbortController | null,
    startingBody?: Element | null,
  ) => boolean;
  isRequestOwner: (conversationKey: number, requestId: number) => boolean;
  finishRequest: (conversationKey: number, requestId: number) => boolean;
  transferRequest: (
    fromConversationKey: number,
    toConversationKey: number,
    requestId: number,
  ) => boolean;
  // UI helpers
  getPanelRequestUI: (body: Element) => PanelRequestUIShape;
  setRequestUIBusy: (
    body: Element,
    ui: PanelRequestUIShape,
    conversationKey: number,
    text: string,
  ) => void;
  restoreRequestUIIdle: (
    body: Element,
    conversationKey: number,
    requestId: number,
  ) => void;
  scheduleQueuedInputDrain: (
    body: Element,
    scope?: {
      conversationSystem?: string | null;
      conversationKey?: number | null;
      webChatActive?: boolean;
    },
  ) => void;
  createPanelUpdateHelpers: (
    body: Element,
    item: Zotero.Item,
    conversationKey: number,
    ui: PanelRequestUIShape,
  ) => PanelUpdateHelpers;

  // Data helpers
  ensureConversationLoaded: (item: Zotero.Item) => Promise<void>;
  getConversationSystem: () => string;
  accumulateSessionTokens: (conversationKey: number, delta: number) => number;
  getContextUsageSnapshot: (conversationKey: number) =>
    | {
        contextTokens: number;
        contextWindow?: number;
        contextWindowIsAuthoritative?: boolean;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        cacheMissTokens?: number;
        cacheHitRatio?: number;
        cacheProvider?: string;
        estimated?: boolean;
        source?: "estimated" | "provider" | "persisted";
      }
    | undefined;
  setContextUsageSnapshot: (
    conversationKey: number,
    snapshot: {
      contextTokens: number;
      contextWindow?: number;
      contextWindowIsAuthoritative?: boolean;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      cacheMissTokens?: number;
      cacheHitRatio?: number;
      cacheProvider?: string;
      estimated?: boolean;
      source?: "estimated" | "provider" | "persisted";
    },
  ) => void;
  setTokenUsage: (
    el: HTMLElement,
    sessionTokens: number,
    contextWindow?: number,
    gaugeEl?: HTMLElement | null,
    options?: {
      estimated?: boolean;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      cacheMissTokens?: number;
      cacheHitRatio?: number;
      cacheProvider?: string;
    },
  ) => void;
  getConversationKey: (item: Zotero.Item) => number;
  buildLLMHistoryMessages: (history: Message[]) => ChatMessage[];
  buildAgentRuntimeRequest: (
    params: BuildAgentRuntimeRequestParams,
  ) => AgentRuntimeRequest | Promise<AgentRuntimeRequest>;
  resolveLocalPdfResources: (
    paperContexts: PaperContextRef[],
  ) => Promise<readonly LocalDocumentResource[]>;
  preflightLocalPdfCapability: () => Promise<void>;
  resolveEffectiveRequestConfig: (params: {
    item: Zotero.Item;
    model?: string;
    apiBase?: string;
    apiKey?: string;
    authMode?:
      | "api_key"
      | "codex_auth"
      | "codex_app_server"
      | "copilot_auth"
      | "webchat";
    providerProtocol?:
      | "codex_responses"
      | "responses_api"
      | "openai_chat_compat"
      | "anthropic_messages"
      | "gemini_native"
      | "ollama_native"
      | "web_sync";
    modelEntryId?: string;
    modelProviderLabel?: string;
    reasoning?: LLMReasoningConfig;
    advanced?: AdvancedModelParams;
  }) => EffectiveRequestConfig;
  normalizeSelectedTexts: (
    selectedTexts: unknown,
    legacySelectedText?: unknown,
  ) => string[];
  normalizeSelectedTextSources: (
    sources: SelectedTextSource[] | undefined,
    count: number,
  ) => SelectedTextSource[];
  normalizeSelectedTextPaperContextsByIndex: (
    contexts: unknown,
    count: number,
  ) => (PaperContextRef | undefined)[];
  normalizeSelectedTextNoteContextsByIndex: (
    contexts: unknown,
    count: number,
  ) => (NoteContextRef | undefined)[];
  normalizePaperContexts: (paperContexts: unknown) => PaperContextRef[];
  includeAutoLoadedPaperContext: (
    item: Zotero.Item,
    paperContexts?: PaperContextRef[],
    fullTextPaperContexts?: PaperContextRef[],
    excludePaperKeys?: Set<string>,
    contextSource?: ResolvedContextSource | null,
  ) => {
    paperContexts: PaperContextRef[];
    fullTextPaperContexts: PaperContextRef[];
    activePaperContext?: PaperContextRef;
  };
  findLatestRetryPair: (history: Message[]) => LatestRetryPairShape | null;
  reconstructRetryPayload: (userMessage: Message) => ReconstructedRetryPayload;
  isReasoningExpandedByDefault: () => boolean;
  createQueuedRefresh: (refresh: () => void) => () => void;
  waitForUiStep: () => Promise<void>;
  finalizeCancelledAssistantMessage: (
    message: Message,
    fallbackText?: string,
  ) => void;
  sanitizeText: (text: string) => string;
  resetAssistantQuoteDisplay?: (message: Message) => void;
  finalizeAssistantQuoteCitations: (
    assistantMessage: Message,
    pairedUserMessage?: Message | null,
    runtimeRequest?: AgentRuntimeRequest | null,
  ) => Promise<void>;
  appendReasoningPart: (base: string | undefined, next?: string) => string;

  // Persistence
  persistConversationMessage: (
    conversationKey: number,
    message: StoredChatMessage,
  ) => Promise<void>;
  updateStoredLatestUserMessage: (
    conversationKey: number,
    data: Partial<StoredChatMessage>,
  ) => Promise<void>;
  updateStoredLatestAssistantMessage: (
    conversationKey: number,
    data: Partial<StoredChatMessage>,
  ) => Promise<void>;

  // Chat fallback (when model does not support tool calls)
  sendChatFallback: (
    opts: import("../types").SendQuestionOptions,
  ) => Promise<void>;

  // Agent runtime
  getAgentRuntime: () => AgentRuntime;

  // Constant
  maxSelectedImages: number;
};

type RequestUiReleaseController = {
  releaseReady: () => void;
  isReleased: () => boolean;
};

function createRequestUiReleaseController(params: {
  deps: Pick<AgentEngineDeps, "finishRequest" | "restoreRequestUIIdle">;
  body: Element;
  conversationKey: number;
  requestId: number;
  scheduleQueueDrain: () => void;
  setStatusSafely: (text: string, kind: StatusKind) => void;
}): RequestUiReleaseController {
  let released = false;
  const releaseReady = () => {
    if (released) return;
    released = true;
    if (!params.deps.finishRequest(params.conversationKey, params.requestId)) {
      return;
    }
    params.deps.restoreRequestUIIdle(
      params.body,
      params.conversationKey,
      params.requestId,
    );
    params.setStatusSafely("Ready", "ready");
    params.scheduleQueueDrain();
  };
  return {
    releaseReady,
    isReleased: () => released,
  };
}

function refreshAssistantMessageTimestampForPersistence(
  assistantMessage: Pick<Message, "timestamp">,
  pairedUserMessage?: Pick<Message, "timestamp"> | null,
): number {
  const assistantTimestamp = Number(assistantMessage.timestamp);
  const userTimestamp = Number(pairedUserMessage?.timestamp);
  const persistedTimestamp = Math.max(
    Number.isFinite(assistantTimestamp) ? Math.floor(assistantTimestamp) : 0,
    Number.isFinite(userTimestamp) ? Math.floor(userTimestamp) + 1 : 0,
    Date.now(),
  );
  assistantMessage.timestamp = persistedTimestamp;
  return persistedTimestamp;
}

/**
 * Quote anchors to store with an agent answer.  A delivered answer keeps only
 * the anchors it used, so the saved turn shows the same quotes the reader saw.
 * A cancelled or interrupted answer stops mid-sentence, so its text cannot
 * prove an anchor went unused: it keeps whatever it already holds.  Cancelling
 * clears `interrupted` (the turn is stopped, not broken), so the cancel path
 * asks for the raw set explicitly.
 */
function quoteCitationsForAgentPersistence(
  assistantMessage: Pick<Message, "text" | "quoteCitations" | "interrupted">,
  keepAllQuoteCitations = false,
): QuoteCitation[] | undefined {
  const quoteCitations = assistantMessage.quoteCitations;
  if (
    keepAllQuoteCitations ||
    assistantMessage.interrupted ||
    !quoteCitations?.length
  ) {
    return quoteCitations;
  }
  return selectUsedQuoteCitations({
    text: assistantMessage.text,
    quoteCitations,
  });
}

// ---------------------------------------------------------------------------
// sendAgentTurn — extracted from sendAgentQuestion in chat.ts
// ---------------------------------------------------------------------------

export async function sendAgentTurn(
  opts: {
    body: Element;
    item: Zotero.Item;
    requestId?: number;
    onProviderDispatch?: () => void;
    contextSource?: ResolvedContextSource | null;
    question: string;
    images?: string[];
    model?: string;
    apiBase?: string;
    apiKey?: string;
    authMode?:
      | "api_key"
      | "codex_auth"
      | "codex_app_server"
      | "copilot_auth"
      | "webchat";
    providerProtocol?:
      | "codex_responses"
      | "responses_api"
      | "openai_chat_compat"
      | "anthropic_messages"
      | "gemini_native"
      | "ollama_native"
      | "web_sync";
    modelEntryId?: string;
    modelProviderLabel?: string;
    reasoning?: LLMReasoningConfig;
    advanced?: AdvancedModelParams;
    displayQuestion?: string;
    selectedTextContexts?: SelectedTextContext[];
    resolvedSelectedTextAnchors?: ResolvedSelectedTextAnchor[];
    selectedTexts?: string[];
    selectedTextSources?: SelectedTextSource[];
    selectedTextPaperContexts?: (PaperContextRef | undefined)[];
    selectedTextNoteContexts?: (NoteContextRef | undefined)[];
    paperContexts?: PaperContextRef[];
    pdfPaperContexts?: PaperContextRef[];
    fullTextPaperContexts?: PaperContextRef[];
    selectedCollectionContexts?: CollectionContextRef[];
    selectedTagContexts?: TagContextRef[];
    attachments?: ChatAttachment[];
    modelAttachments?: ChatAttachment[];
    localDocuments?: readonly LocalDocumentResource[];
    forcedSkillIds?: string[];
  },
  deps: AgentEngineDeps,
): Promise<void> {
  const {
    body,
    item,
    contextSource,
    question,
    images,
    model,
    apiBase,
    apiKey,
    authMode,
    providerProtocol,
    modelEntryId,
    modelProviderLabel,
    reasoning,
    advanced,
    displayQuestion,
    selectedTextContexts,
    resolvedSelectedTextAnchors,
    selectedTexts,
    selectedTextSources,
    selectedTextPaperContexts,
    selectedTextNoteContexts,
    paperContexts,
    pdfPaperContexts,
    fullTextPaperContexts,
    selectedCollectionContexts,
    selectedTagContexts,
    attachments,
    modelAttachments,
    localDocuments,
    forcedSkillIds,
  } = opts;
  const conversationKey = deps.getConversationKey(item);
  const ui = deps.getPanelRequestUI(body);
  const thisRequestId = opts.requestId ?? deps.nextRequestId();
  if (opts.requestId !== undefined) {
    if (!deps.isRequestOwner(conversationKey, thisRequestId)) return;
  } else {
    const AbortControllerCtor = deps.getAbortControllerCtor();
    if (
      !deps.tryBeginRequest(
        conversationKey,
        thisRequestId,
        AbortControllerCtor ? new AbortControllerCtor() : null,
        body,
      )
    ) {
      return;
    }
  }
  deps.setRequestUIBusy(body, ui, conversationKey, "Preparing agent...");
  if (ui.inputBox) ui.inputBox.disabled = true;

  const selectedTextContextsForMessage = synthesizeSelectedTextContexts({
    selectedTextContexts,
    selectedTexts,
    selectedTextSources,
    selectedTextPaperContexts,
    selectedTextNoteContexts,
    sanitizeText: deps.sanitizeText,
  });
  const selectedTextsForMessage = selectedTextContextsForMessage.map(
    (context) => context.text,
  );
  const selectedTextSourcesForMessage = selectedTextContextsForMessage.map(
    (context) => context.source,
  );
  const selectedTextPaperContextsForMessage =
    selectedTextContextsForMessage.map((context) => context.paperContext);
  const selectedTextNoteContextsForMessage = selectedTextContextsForMessage.map(
    (context) => {
      if (!context.noteContext) return undefined;
      return Object.fromEntries(
        Object.entries(context.noteContext).filter(
          ([, value]) => value !== undefined,
        ),
      ) as NoteContextRef;
    },
  );
  const selectedTextQuoteCitationsForMessage = buildSelectedTextQuoteCitations(
    selectedTextsForMessage,
    selectedTextSourcesForMessage,
    selectedTextPaperContextsForMessage,
  );
  const pdfPaperContextsForMessage = deps
    .normalizePaperContexts(pdfPaperContexts)
    .map((paper) => ({ ...paper, contentSourceMode: "pdf" as const }));
  const shownQuestion = displayQuestion || question;
  const screenshotImagesForMessage = Array.isArray(images)
    ? images
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, deps.maxSelectedImages)
    : [];

  const historyForRun = deps.chatHistory.get(conversationKey) || [];
  const isCompactCommand = /^\/compact(?:\s|$)/i.test(question.trim());
  const userMessage: Message = {
    role: "user",
    text: shownQuestion,
    timestamp: Date.now(),
    runMode: "agent",
    selectedText: selectedTextsForMessage[0] || undefined,
    selectedTextExpanded: false,
    selectedTextContexts: selectedTextContextsForMessage.length
      ? selectedTextContextsForMessage
      : undefined,
    selectedTexts: selectedTextsForMessage.length
      ? selectedTextsForMessage
      : undefined,
    selectedTextSources: selectedTextSourcesForMessage.length
      ? selectedTextSourcesForMessage
      : undefined,
    selectedTextPaperContexts: selectedTextPaperContextsForMessage.some(
      (entry) => Boolean(entry),
    )
      ? selectedTextPaperContextsForMessage
      : undefined,
    selectedTextNoteContexts: selectedTextNoteContextsForMessage.some((entry) =>
      Boolean(entry),
    )
      ? selectedTextNoteContextsForMessage
      : undefined,
    citationPaperContexts: mergeCitationPaperContexts(
      selectedTextPaperContextsForMessage,
    ),
    pdfPaperContexts: pdfPaperContextsForMessage.length
      ? pdfPaperContextsForMessage
      : undefined,
    selectedTextExpandedIndex: -1,
    paperContextsExpanded: false,
    screenshotImages: screenshotImagesForMessage.length
      ? screenshotImagesForMessage
      : undefined,
    screenshotExpanded: false,
    screenshotActiveIndex: 0,
    attachments: attachments?.length ? attachments : undefined,
    selectedCollectionContexts: selectedCollectionContexts?.length
      ? selectedCollectionContexts
      : undefined,
    selectedTagContexts: selectedTagContexts?.length
      ? selectedTagContexts
      : undefined,
    forcedSkillIds: forcedSkillIds?.length ? forcedSkillIds.slice() : undefined,
  };
  if (modelAttachments !== undefined) {
    userMessage.modelAttachments = modelAttachments;
  }
  if (!isCompactCommand) {
    historyForRun.push(userMessage);
    await deps.persistConversationMessage(conversationKey, {
      role: "user",
      text: userMessage.text,
      timestamp: userMessage.timestamp,
      runMode: "agent",
      selectedText: userMessage.selectedText,
      selectedTextContexts: userMessage.selectedTextContexts,
      selectedTexts: userMessage.selectedTexts,
      selectedTextSources: userMessage.selectedTextSources,
      selectedTextPaperContexts: userMessage.selectedTextPaperContexts,
      selectedTextNoteContexts: userMessage.selectedTextNoteContexts,
      forcedSkillIds: userMessage.forcedSkillIds,
      citationPaperContexts: userMessage.citationPaperContexts,
      pdfPaperContexts: userMessage.pdfPaperContexts,
      selectedCollectionContexts: userMessage.selectedCollectionContexts,
      selectedTagContexts: userMessage.selectedTagContexts,
      screenshotImages: userMessage.screenshotImages,
      attachments: userMessage.attachments,
      modelAttachments: userMessage.modelAttachments,
    });
  }

  const effectiveRequestConfig = deps.resolveEffectiveRequestConfig({
    item,
    model,
    apiBase,
    apiKey,
    authMode,
    providerProtocol,
    modelEntryId,
    modelProviderLabel,
    reasoning,
    advanced,
  });
  userMessage.modelName = effectiveRequestConfig.model;
  userMessage.modelEntryId = effectiveRequestConfig.modelEntryId;
  userMessage.modelProviderLabel = effectiveRequestConfig.modelProviderLabel;
  const assistantMessage: Message = {
    role: "assistant",
    text: "",
    timestamp: Date.now(),
    runMode: "agent",
    modelName: effectiveRequestConfig.model,
    modelEntryId: effectiveRequestConfig.modelEntryId,
    modelProviderLabel: effectiveRequestConfig.modelProviderLabel,
    streaming: true,
    waitingAnimationStartedAt:
      effectiveRequestConfig.modelProviderLabel === "Claude Code" ||
      effectiveRequestConfig.modelProviderLabel === "Codex"
        ? Date.now()
        : undefined,
    pendingAgentTraceEvents:
      effectiveRequestConfig.modelProviderLabel === "Claude Code" ||
      effectiveRequestConfig.modelProviderLabel === "Codex"
        ? buildPendingAgentTraceEvents(body)
        : undefined,
    reasoningOpen: deps.isReasoningExpandedByDefault(),
    quoteCitations: selectedTextQuoteCitationsForMessage.length
      ? selectedTextQuoteCitationsForMessage
      : undefined,
  };
  historyForRun.push(assistantMessage);
  const { refreshChatSafely, refreshAssistantMessageSafely, setStatusSafely } =
    deps.createPanelUpdateHelpers(body, item, conversationKey, ui);
  // Streaming flushes only mutate this assistant message, so re-render just
  // its bubble; refreshChat falls back to a full rebuild if the wrapper is
  // not in the DOM yet.
  const queueRefresh = deps.createQueuedRefresh(() =>
    refreshAssistantMessageSafely(assistantMessage),
  );
  const messageDeltaCoalescer = createBlockStreamCoalescer({
    onBlock: (block) => {
      appendPendingFinalText(assistantMessage, block, deps.sanitizeText);
      queueRefresh();
    },
  });
  const reasoningRefreshes = createReasoningRefreshCoalescer({
    onFlush: () => queueRefresh(),
  });
  const flushMessageDeltas = (reason: BlockStreamFlushReason) => {
    messageDeltaCoalescer.flushNow(reason);
    // A final or a cancel ends the stream: waiting thinking is painted now,
    // never by a timer after the turn has been finalized.
    reasoningRefreshes.flushNow();
  };
  const scheduleQueueDrain = () =>
    deps.scheduleQueuedInputDrain(body, {
      conversationSystem: deps.getConversationSystem(),
      conversationKey,
      webChatActive: effectiveRequestConfig.providerProtocol === "web_sync",
    });
  const uiRelease = createRequestUiReleaseController({
    deps,
    body,
    conversationKey,
    requestId: thisRequestId,
    scheduleQueueDrain,
    setStatusSafely,
  });
  setStatusSafely(
    "Checking the request against the attached context.",
    "sending",
  );
  refreshChatSafely();

  await deps.ensureConversationLoaded(item);
  const history = deps.chatHistory.get(conversationKey) || [];
  // A turn queued for deletion is hidden from the user; a failed finalize
  // must not leak it into the prompt (see filterMessagesInPendingTurns).
  const llmHistory = deps.buildLLMHistoryMessages(
    filterMessagesInPendingTurns(conversationKey, history.slice(0, -2)),
  );
  const normalizedPaperContexts = deps.normalizePaperContexts([
    ...(paperContexts || []),
  ]);
  const normalizedFullTextPaperContexts = deps.normalizePaperContexts(
    fullTextPaperContexts,
  );
  const {
    paperContexts: paperContextsForMessage,
    fullTextPaperContexts: fullTextPaperContextsForMessage,
    activePaperContext,
  } = deps.includeAutoLoadedPaperContext(
    item,
    normalizedPaperContexts,
    normalizedFullTextPaperContexts,
    pdfPaperContextsForMessage.length
      ? new Set(
          pdfPaperContextsForMessage.map(
            (paper) =>
              `${Math.floor(Number(paper.libraryID || item.libraryID))}:${paper.itemId}:${paper.contextItemId}`,
          ),
        )
      : undefined,
    contextSource,
  );
  userMessage.paperContexts = paperContextsForMessage.length
    ? paperContextsForMessage
    : undefined;
  userMessage.fullTextPaperContexts = fullTextPaperContextsForMessage.length
    ? fullTextPaperContextsForMessage
    : undefined;
  userMessage.citationPaperContexts = mergeCitationPaperContexts(
    userMessage.selectedTextPaperContexts,
    paperContextsForMessage,
    fullTextPaperContextsForMessage,
  );
  if (!isCompactCommand) {
    await deps.updateStoredLatestUserMessage(conversationKey, {
      text: userMessage.text,
      timestamp: userMessage.timestamp,
      runMode: "agent",
      selectedText: userMessage.selectedText,
      selectedTextContexts: userMessage.selectedTextContexts,
      selectedTexts: userMessage.selectedTexts,
      selectedTextSources: userMessage.selectedTextSources,
      selectedTextPaperContexts: userMessage.selectedTextPaperContexts,
      selectedTextNoteContexts: userMessage.selectedTextNoteContexts,
      forcedSkillIds: userMessage.forcedSkillIds,
      paperContexts: userMessage.paperContexts,
      pdfPaperContexts: userMessage.pdfPaperContexts,
      fullTextPaperContexts: userMessage.fullTextPaperContexts,
      citationPaperContexts: userMessage.citationPaperContexts,
      selectedCollectionContexts: userMessage.selectedCollectionContexts,
      selectedTagContexts: userMessage.selectedTagContexts,
      screenshotImages: userMessage.screenshotImages,
      attachments: userMessage.attachments,
      modelAttachments: userMessage.modelAttachments,
      modelName: userMessage.modelName,
      modelEntryId: userMessage.modelEntryId,
      modelProviderLabel: userMessage.modelProviderLabel,
    });
  }
  const runtimeRequest = await deps.buildAgentRuntimeRequest(
    toAgentRuntimeRequestParams(
      {
        activePaperContext,
        selectedTextContexts: selectedTextContextsForMessage,
        resolvedSelectedTextAnchors,
        selectedTexts: selectedTextsForMessage,
        selectedTextSources: selectedTextSourcesForMessage,
        selectedTextPaperContexts: selectedTextPaperContextsForMessage,
        selectedTextNoteContexts: selectedTextNoteContextsForMessage,
        selectedPaperContexts: paperContextsForMessage,
        pdfPaperContexts: pdfPaperContextsForMessage,
        fullTextPaperContexts: fullTextPaperContextsForMessage,
        citationPaperContexts: userMessage.citationPaperContexts,
        selectedCollectionContexts,
        selectedTagContexts,
        attachments: modelAttachments ?? attachments,
        localDocuments,
        screenshots: images,
        forcedSkillIds,
      },
      {
        conversationKey,
        conversationGeneration: deps.conversationGeneration,
        sourceMessageTimestamp: userMessage.timestamp,
        item,
        userText: question,
        effectiveRequestConfig,
        history: llmHistory,
      },
    ),
  );
  const agentRuntime = deps.getAgentRuntime();
  const capabilities = agentRuntime.getCapabilities(runtimeRequest);
  if (!capabilities.toolCalls) {
    if (ui.inputBox) ui.inputBox.disabled = false;
    opts.onProviderDispatch?.();
    const fallback = await agentRuntime.runTurn({
      request: runtimeRequest,
    });
    // The probe has no Stop and no turn of its own to end: a run it could not
    // finish leaves the send as a thrown error, as it always has.
    if (fallback.kind === "cancelled" || fallback.kind === "failed")
      throw unansweredTurnError(fallback);
    if (fallback.kind === "fallback") {
      historyForRun.pop();
      await deps.sendChatFallback({
        body,
        item,
        requestId: thisRequestId,
        onProviderDispatch: opts.onProviderDispatch,
        question,
        images,
        model,
        apiBase,
        apiKey,
        authMode,
        providerProtocol,
        modelEntryId,
        modelProviderLabel,
        reasoning,
        advanced,
        displayQuestion,
        selectedTextContexts: selectedTextContextsForMessage,
        resolvedSelectedTextAnchors,
        selectedTexts: selectedTextsForMessage,
        selectedTextSources: selectedTextSourcesForMessage,
        selectedTextPaperContexts: selectedTextPaperContextsForMessage,
        selectedTextNoteContexts: selectedTextNoteContextsForMessage,
        paperContexts,
        fullTextPaperContexts,
        selectedCollectionContexts,
        selectedTagContexts,
        attachments,
        modelAttachments,
        runtimeMode: "agent",
        agentRunId: fallback.runId,
        skipAgentDispatch: true,
      });
      return;
    }
  }

  let assistantPersisted = false;
  const persistAssistantOnce = async (options?: {
    keepAllQuoteCitations?: boolean;
  }) => {
    if (assistantPersisted) return;
    const persistedTimestamp = refreshAssistantMessageTimestampForPersistence(
      assistantMessage,
      userMessage,
    );
    const snapshot = deps.getContextUsageSnapshot?.(conversationKey);
    await deps.persistConversationMessage(conversationKey, {
      role: "assistant",
      text: assistantMessage.text,
      timestamp: persistedTimestamp,
      runMode: "agent",
      agentRunId: assistantMessage.agentRunId,
      documentId: assistantMessage.documentId,
      planDocumentId: assistantMessage.planDocumentId,
      modelName: assistantMessage.modelName,
      modelEntryId: assistantMessage.modelEntryId,
      modelProviderLabel: assistantMessage.modelProviderLabel,
      interrupted: assistantMessage.interrupted,
      contextTokens: snapshot?.contextTokens,
      contextWindow: snapshot?.contextWindow,
      quoteCitations: quoteCitationsForAgentPersistence(
        assistantMessage,
        options?.keepAllQuoteCitations,
      ),
    });
    assistantPersisted = true;
  };
  const markCancelled = async () => {
    endTaskRun(conversationKey, "cancelled", assistantMessage.agentRunId);
    flushMessageDeltas("cancel");
    deps.finalizeCancelledAssistantMessage(assistantMessage);
    refreshChatSafely();
    // The answer was stopped mid-sentence, so its text cannot prove which
    // anchors went unused: keep every anchor the turn had gathered.
    await persistAssistantOnce({ keepAllQuoteCitations: true });
    setStatusSafely("Cancelled", "ready");
  };

  try {
    let compactEventHandled = false;
    await settleAgentTurn({
      run: () => {
        if (ui.inputBox) ui.inputBox.disabled = false;
        opts.onProviderDispatch?.();
        return agentRuntime.runTurn({
          request: runtimeRequest,
          signal: deps.currentAbortController(conversationKey)?.signal,
          ...startAgentTurnRun({
            deps,
            body,
            ui,
            conversationKey,
            runtimeRequest,
            assistantMessage,
            pairedUserMessage: userMessage,
            history: historyForRun,
            isCompactCommand,
            compactStyle: "replace-assistant",
            onContextCompacted: () => {
              compactEventHandled = true;
            },
            messageDeltaCoalescer,
            flushMessageDeltas,
            reasoningRefreshes,
            queueRefresh,
            refreshAssistant: () =>
              refreshAssistantMessageSafely(assistantMessage),
            refreshChatSafely,
            setStatusSafely,
            scheduleQueueDrain,
          }),
        });
      },
      finalize: (outcome) =>
        finalizeAgentTurnOutcome({
          deps,
          item,
          conversationKey,
          thisRequestId,
          outcome,
          assistantMessage,
          pairedUserMessage: userMessage,
          runtimeRequest,
          refreshChatSafely,
          markCancelled,
          persistAssistantOnce,
          uiRelease,
          skipAssistantPersist: isCompactCommand && compactEventHandled,
        }),
      reasoningRefreshes,
      markCancelled,
      failTurn: (err) =>
        handleAgentTurnFailure({
          err,
          deps,
          conversationKey,
          thisRequestId,
          assistantMessage,
          messageDeltaCoalescer,
          reasoningRefreshes,
          refreshChatSafely,
          setStatusSafely,
          markCancelled,
          persistAssistantOnce,
        }),
    });
  } finally {
    if (!uiRelease.isReleased()) {
      if (deps.finishRequest(conversationKey, thisRequestId)) {
        deps.restoreRequestUIIdle(body, conversationKey, thisRequestId);
        scheduleQueueDrain();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// retryAgentTurn — extracted from retryLatestAgentResponse in chat.ts
// ---------------------------------------------------------------------------

export async function retryAgentTurn(
  body: Element,
  item: Zotero.Item,
  model: string | undefined,
  apiBase: string | undefined,
  apiKey: string | undefined,
  authMode:
    | "api_key"
    | "codex_auth"
    | "codex_app_server"
    | "copilot_auth"
    | "webchat"
    | undefined,
  providerProtocol:
    | "codex_responses"
    | "responses_api"
    | "openai_chat_compat"
    | "anthropic_messages"
    | "gemini_native"
    | "ollama_native"
    | "web_sync"
    | undefined,
  modelEntryId: string | undefined,
  modelProviderLabel: string | undefined,
  reasoning: LLMReasoningConfig | undefined,
  advanced: AdvancedModelParams | undefined,
  modelAttachmentsOverride: ChatAttachment[] | undefined,
  deps: AgentEngineDeps,
  requestId?: number,
  onProviderDispatch?: () => void,
  activePaperContextOverride?: PaperContextRef,
): Promise<void> {
  const ui = deps.getPanelRequestUI(body);
  const initialConversationKey = deps.getConversationKey(item);
  const thisRequestId = requestId ?? deps.nextRequestId();
  if (requestId !== undefined) {
    if (!deps.isRequestOwner(initialConversationKey, thisRequestId)) return;
  } else {
    const AbortControllerCtor = deps.getAbortControllerCtor();
    if (
      !deps.tryBeginRequest(
        initialConversationKey,
        thisRequestId,
        AbortControllerCtor ? new AbortControllerCtor() : null,
        body,
      )
    ) {
      return;
    }
  }
  deps.setRequestUIBusy(
    body,
    ui,
    initialConversationKey,
    "Preparing agent retry...",
  );
  if (ui.inputBox) ui.inputBox.disabled = true;
  try {
    await deps.ensureConversationLoaded(item);
  } catch (error) {
    if (deps.finishRequest(initialConversationKey, thisRequestId)) {
      deps.restoreRequestUIIdle(body, initialConversationKey, thisRequestId);
    }
    throw error;
  }
  const conversationKey = deps.getConversationKey(item);
  if (
    conversationKey !== initialConversationKey &&
    !deps.transferRequest(
      initialConversationKey,
      conversationKey,
      thisRequestId,
    )
  ) {
    if (deps.finishRequest(initialConversationKey, thisRequestId)) {
      deps.restoreRequestUIIdle(body, initialConversationKey, thisRequestId);
    }
    return;
  }
  const requestIsActive = () =>
    deps.isRequestOwner(conversationKey, thisRequestId) &&
    !deps.currentAbortController(conversationKey)?.signal.aborted &&
    deps.cancelledRequestId(conversationKey) < thisRequestId;
  const releaseRequest = () => {
    if (!deps.finishRequest(conversationKey, thisRequestId)) return false;
    deps.restoreRequestUIIdle(body, conversationKey, thisRequestId);
    deps.scheduleQueuedInputDrain(body, {
      conversationSystem: deps.getConversationSystem(),
      conversationKey,
    });
    return true;
  };
  if (!requestIsActive()) {
    releaseRequest();
    return;
  }
  // Select the retry target and slice the prompt from the user-visible view;
  // turns queued for deletion must stay invisible even if finalize failed.
  const history = filterMessagesInPendingTurns(
    conversationKey,
    deps.chatHistory.get(conversationKey) || [],
  );
  const retryPair = deps.findLatestRetryPair(history);
  if (!retryPair) {
    if (ui.status) {
      // Best-effort status update without full createPanelUpdateHelpers
      ui.status.textContent = "No retryable response found";
    }
    releaseRequest();
    return;
  }
  const reconstructedRetryPayload = deps.reconstructRetryPayload(
    retryPair.userMessage,
  );
  const effectiveRequestConfig = deps.resolveEffectiveRequestConfig({
    item,
    model,
    apiBase,
    apiKey,
    authMode,
    providerProtocol,
    modelEntryId,
    modelProviderLabel,
    reasoning,
    advanced,
  });
  const conversationSystem = deps.getConversationSystem();
  const usesLocalPdfTransport =
    conversationSystem === "claude_code" ||
    (conversationSystem === "codex" &&
      effectiveRequestConfig.authMode === "codex_app_server");

  let retryLocalDocuments: readonly LocalDocumentResource[] | undefined;
  try {
    const pdfPaperContexts = reconstructedRetryPayload.pdfPaperContexts;
    if (usesLocalPdfTransport && pdfPaperContexts.length) {
      retryLocalDocuments =
        await deps.resolveLocalPdfResources(pdfPaperContexts);
      if (!requestIsActive()) {
        releaseRequest();
        return;
      }
      if (retryLocalDocuments.length !== pdfPaperContexts.length) {
        throw new Error("Could not resolve every selected raw PDF.");
      }
      await deps.preflightLocalPdfCapability();
      if (!requestIsActive()) {
        releaseRequest();
        return;
      }
    }
  } catch (error) {
    if (ui.status) {
      ui.status.textContent =
        error instanceof Error && error.message.trim()
          ? error.message
          : "Could not resolve the selected raw PDF.";
    }
    releaseRequest();
    return;
  }

  const assistantMessage = retryPair.assistantMessage;

  // Snapshot the fields the reset below overwrites, so a failed retry that
  // streamed nothing can restore the previous answer (or a preserved
  // interrupted partial) instead of losing it to bare error text.
  const assistantSnapshot = {
    text: assistantMessage.text,
    agentRunId: assistantMessage.agentRunId,
    runMode: assistantMessage.runMode,
    streaming: assistantMessage.streaming,
    interrupted: assistantMessage.interrupted,
    pendingFinalText: assistantMessage.pendingFinalText,
    modelName: assistantMessage.modelName,
    modelEntryId: assistantMessage.modelEntryId,
    modelProviderLabel: assistantMessage.modelProviderLabel,
    waitingAnimationStartedAt: assistantMessage.waitingAnimationStartedAt,
    reasoningSummary: assistantMessage.reasoningSummary,
    reasoningDetails: assistantMessage.reasoningDetails,
    reasoningOpen: assistantMessage.reasoningOpen,
    pendingAgentTraceEvents: assistantMessage.pendingAgentTraceEvents,
  };
  const restorePreviousAssistant = () => {
    Object.assign(assistantMessage, assistantSnapshot);
    assistantMessage.streaming = false;
  };
  // The retry rewrites (and, at onStart, persists) the paired user row's
  // model identity, contexts and run linkage before any output exists. A
  // failed retry that restores the previous answer must roll the user row
  // back with it, or the stored turn pairs the old answer with the failed
  // retry's metadata after a reload.
  const userSnapshot = takeRetryUserSnapshot(retryPair.userMessage);
  const restorePairedUser = async () => {
    restoreRetryUserSnapshot(retryPair.userMessage, userSnapshot);
    await deps.updateStoredLatestUserMessage(
      conversationKey,
      buildStoredUserMessagePatch(retryPair.userMessage),
    );
  };

  // Clear the previous agent run so the trace and text reset immediately.
  assistantMessage.text = "";
  assistantMessage.agentRunId = undefined;
  assistantMessage.runMode = "agent";
  assistantMessage.streaming = true;
  assistantMessage.interrupted = undefined;
  assistantMessage.pendingFinalText = undefined;
  assistantMessage.modelName = effectiveRequestConfig.model;
  assistantMessage.modelEntryId = effectiveRequestConfig.modelEntryId;
  assistantMessage.modelProviderLabel =
    effectiveRequestConfig.modelProviderLabel;
  assistantMessage.waitingAnimationStartedAt =
    assistantMessage.modelProviderLabel === "Claude Code" ||
    assistantMessage.modelProviderLabel === "Codex"
      ? Date.now()
      : undefined;
  assistantMessage.reasoningSummary = undefined;
  assistantMessage.reasoningDetails = undefined;
  assistantMessage.reasoningOpen = deps.isReasoningExpandedByDefault();
  assistantMessage.pendingAgentTraceEvents =
    assistantMessage.modelProviderLabel === "Claude Code" ||
    assistantMessage.modelProviderLabel === "Codex"
      ? buildPendingAgentTraceEvents(body)
      : undefined;

  const { refreshChatSafely, refreshAssistantMessageSafely, setStatusSafely } =
    deps.createPanelUpdateHelpers(body, item, conversationKey, ui);
  // Streaming flushes only mutate this assistant message, so re-render just
  // its bubble; refreshChat falls back to a full rebuild if the wrapper is
  // not in the DOM yet.
  const queueRefresh = deps.createQueuedRefresh(() =>
    refreshAssistantMessageSafely(assistantMessage),
  );
  const messageDeltaCoalescer = createBlockStreamCoalescer({
    onBlock: (block) => {
      appendPendingFinalText(assistantMessage, block, deps.sanitizeText);
      queueRefresh();
    },
  });
  const reasoningRefreshes = createReasoningRefreshCoalescer({
    onFlush: () => queueRefresh(),
  });
  const flushMessageDeltas = (reason: BlockStreamFlushReason) => {
    messageDeltaCoalescer.flushNow(reason);
    // A final or a cancel ends the stream: waiting thinking is painted now,
    // never by a timer after the turn has been finalized.
    reasoningRefreshes.flushNow();
  };
  const scheduleQueueDrain = () =>
    deps.scheduleQueuedInputDrain(body, {
      conversationSystem: deps.getConversationSystem(),
      conversationKey,
      webChatActive: effectiveRequestConfig.providerProtocol === "web_sync",
    });
  const uiRelease = createRequestUiReleaseController({
    deps,
    body,
    conversationKey,
    requestId: thisRequestId,
    scheduleQueueDrain,
    setStatusSafely,
  });
  refreshChatSafely(); // Immediately clear the old trace from view

  const {
    question,
    screenshotImages,
    pdfPaperContexts,
    selectedCollectionContexts,
    selectedTagContexts,
  } = reconstructedRetryPayload;
  let { paperContexts, fullTextPaperContexts } = reconstructedRetryPayload;
  const retryPaperContext = deps.includeAutoLoadedPaperContext(
    item,
    paperContexts,
    fullTextPaperContexts,
    pdfPaperContexts.length
      ? new Set(
          pdfPaperContexts.map(
            (paper) =>
              `${Math.floor(Number(paper.libraryID || item.libraryID))}:${paper.itemId}:${paper.contextItemId}`,
          ),
        )
      : undefined,
  );
  paperContexts = retryPaperContext.paperContexts;
  fullTextPaperContexts = retryPaperContext.fullTextPaperContexts;
  retryPair.userMessage.paperContexts = paperContexts.length
    ? paperContexts
    : undefined;
  retryPair.userMessage.pdfPaperContexts = pdfPaperContexts.length
    ? pdfPaperContexts
    : undefined;
  retryPair.userMessage.fullTextPaperContexts = fullTextPaperContexts.length
    ? fullTextPaperContexts
    : undefined;
  if (!question.trim()) {
    // The assistant bubble was already reset for streaming and the user
    // contexts rewritten — put the turn back or it stays stuck as an empty
    // streaming message that blocks every later retry/edit.
    restorePreviousAssistant();
    restoreRetryUserSnapshot(retryPair.userMessage, userSnapshot);
    refreshChatSafely();
    setStatusSafely("Nothing to retry for latest turn", "error");
    releaseRequest();
    return;
  }

  const selectedTextContextsRaw = synthesizeSelectedTextContexts({
    selectedTextContexts: retryPair.userMessage.selectedTextContexts,
    selectedTexts: retryPair.userMessage.selectedTexts,
    legacySelectedText: retryPair.userMessage.selectedText,
    selectedTextSources: retryPair.userMessage.selectedTextSources,
    selectedTextPaperContexts: retryPair.userMessage.selectedTextPaperContexts,
    selectedTextNoteContexts: retryPair.userMessage.selectedTextNoteContexts,
    sanitizeText: deps.sanitizeText,
  });
  retryPair.userMessage.selectedTextContexts = selectedTextContextsRaw.length
    ? selectedTextContextsRaw
    : undefined;
  const selectedTextsRaw = selectedTextContextsRaw.map(
    (context) => context.text,
  );
  const selectedTextSourcesRaw = selectedTextContextsRaw.map(
    (context) => context.source,
  );
  const selectedTextPaperContextsRaw = selectedTextContextsRaw.map(
    (context) => context.paperContext,
  );
  const resolvedSelectedTextAnchors = await resolveSelectedTextAnchors({
    selectedTextContexts: selectedTextContextsRaw,
    paperContexts: deps.normalizePaperContexts([
      ...paperContexts,
      ...fullTextPaperContexts,
      ...selectedTextPaperContextsRaw.filter(
        (paper): paper is PaperContextRef => Boolean(paper),
      ),
    ]),
  });
  if (!requestIsActive()) {
    restorePreviousAssistant();
    restoreRetryUserSnapshot(retryPair.userMessage, userSnapshot);
    refreshChatSafely();
    releaseRequest();
    return;
  }
  assistantMessage.quoteCitations = buildSelectedTextQuoteCitations(
    selectedTextsRaw,
    selectedTextSourcesRaw,
    selectedTextPaperContextsRaw,
  );
  if (deps.resetAssistantQuoteDisplay) {
    deps.resetAssistantQuoteDisplay(assistantMessage);
  } else {
    assistantMessage.quoteDisplayOverride = undefined;
  }

  const historyForLLM = deps.buildLLMHistoryMessages(
    history.slice(0, retryPair.userIndex),
  );
  if (modelAttachmentsOverride !== undefined) {
    retryPair.userMessage.modelAttachments = modelAttachmentsOverride;
  }
  retryPair.userMessage.modelName = effectiveRequestConfig.model;
  retryPair.userMessage.modelEntryId = effectiveRequestConfig.modelEntryId;
  retryPair.userMessage.modelProviderLabel =
    effectiveRequestConfig.modelProviderLabel;
  const retryModelAttachments =
    modelAttachmentsOverride ??
    retryPair.userMessage.modelAttachments ??
    retryPair.userMessage.attachments?.filter((a) => a.category !== "image");

  // The retry hands over the forced skills the turn stored, as the plain-chat
  // retry does.
  const runtimeRequest = await deps.buildAgentRuntimeRequest(
    toAgentRuntimeRequestParams(
      {
        activePaperContext:
          activePaperContextOverride ?? retryPaperContext.activePaperContext,
        selectedTextContexts: selectedTextContextsRaw,
        resolvedSelectedTextAnchors,
        selectedTexts: selectedTextsRaw,
        selectedTextSources: selectedTextSourcesRaw,
        selectedTextPaperContexts: selectedTextPaperContextsRaw,
        selectedTextNoteContexts:
          retryPair.userMessage.selectedTextNoteContexts,
        selectedPaperContexts: paperContexts,
        pdfPaperContexts,
        fullTextPaperContexts,
        citationPaperContexts: retryPair.userMessage.citationPaperContexts,
        selectedCollectionContexts,
        selectedTagContexts,
        attachments: retryModelAttachments,
        localDocuments: retryLocalDocuments,
        screenshots: screenshotImages,
        forcedSkillIds: retryPair.userMessage.forcedSkillIds,
      },
      {
        conversationKey,
        conversationGeneration: deps.conversationGeneration,
        sourceMessageTimestamp: retryPair.userMessage.timestamp,
        item,
        userText: question,
        effectiveRequestConfig,
        history: historyForLLM,
      },
    ),
  );
  if (!requestIsActive()) {
    restorePreviousAssistant();
    restoreRetryUserSnapshot(retryPair.userMessage, userSnapshot);
    refreshChatSafely();
    releaseRequest();
    return;
  }

  let assistantPersisted = false;
  const persistAssistantOnce = async (options?: {
    keepAllQuoteCitations?: boolean;
  }) => {
    if (assistantPersisted) return;
    const persistedTimestamp = refreshAssistantMessageTimestampForPersistence(
      assistantMessage,
      retryPair.userMessage,
    );
    const snapshot = deps.getContextUsageSnapshot?.(conversationKey);
    await deps.updateStoredLatestAssistantMessage(conversationKey, {
      text: assistantMessage.text,
      timestamp: persistedTimestamp,
      runMode: "agent",
      agentRunId: assistantMessage.agentRunId,
      documentId: assistantMessage.documentId,
      planDocumentId: assistantMessage.planDocumentId,
      modelName: assistantMessage.modelName,
      modelEntryId: assistantMessage.modelEntryId,
      modelProviderLabel: assistantMessage.modelProviderLabel,
      interrupted: assistantMessage.interrupted,
      contextTokens: snapshot?.contextTokens,
      contextWindow: snapshot?.contextWindow,
      quoteCitations: quoteCitationsForAgentPersistence(
        assistantMessage,
        options?.keepAllQuoteCitations,
      ),
    });
    assistantPersisted = true;
  };
  const markCancelled = async () => {
    endTaskRun(conversationKey, "cancelled", assistantMessage.agentRunId);
    flushMessageDeltas("cancel");
    deps.finalizeCancelledAssistantMessage(assistantMessage);
    refreshChatSafely();
    // The answer was stopped mid-sentence, so its text cannot prove which
    // anchors went unused: keep every anchor the turn had gathered.
    await persistAssistantOnce({ keepAllQuoteCitations: true });
    setStatusSafely("Cancelled", "ready");
  };

  const agentRuntime = deps.getAgentRuntime();
  try {
    await settleAgentTurn({
      run: () => {
        if (ui.inputBox) ui.inputBox.disabled = false;
        onProviderDispatch?.();
        return agentRuntime.runTurn({
          request: runtimeRequest,
          signal: deps.currentAbortController(conversationKey)?.signal,
          // A retry re-answers a question the usage ledger already counted;
          // its tokens are recorded, the question tally is not moved again.
          usageCountsAsQuestion: false,
          ...startAgentTurnRun({
            deps,
            body,
            ui,
            conversationKey,
            runtimeRequest,
            assistantMessage,
            pairedUserMessage: retryPair.userMessage,
            history,
            isCompactCommand: false,
            compactStyle: "keep-assistant",
            messageDeltaCoalescer,
            flushMessageDeltas,
            reasoningRefreshes,
            queueRefresh,
            refreshAssistant: () =>
              refreshAssistantMessageSafely(assistantMessage),
            refreshChatSafely,
            setStatusSafely,
            scheduleQueueDrain,
          }),
        });
      },
      finalize: (outcome) =>
        finalizeAgentTurnOutcome({
          deps,
          item,
          conversationKey,
          thisRequestId,
          outcome,
          assistantMessage,
          pairedUserMessage: retryPair.userMessage,
          runtimeRequest,
          refreshChatSafely,
          markCancelled,
          persistAssistantOnce,
          uiRelease,
          skipAssistantPersist: false,
        }),
      reasoningRefreshes,
      markCancelled,
      failTurn: (err) =>
        handleAgentTurnFailure({
          err,
          deps,
          conversationKey,
          thisRequestId,
          assistantMessage,
          messageDeltaCoalescer,
          reasoningRefreshes,
          refreshChatSafely,
          setStatusSafely,
          markCancelled,
          persistAssistantOnce,
          restorePreviousAssistant,
          restorePairedUser,
        }),
    });
  } finally {
    if (!uiRelease.isReleased()) {
      if (deps.finishRequest(conversationKey, thisRequestId)) {
        deps.restoreRequestUIIdle(body, conversationKey, thisRequestId);
        scheduleQueueDrain();
      }
    }
  }
}
