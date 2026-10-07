/**
 * The shared steps of one plain-chat assistant turn.
 *
 * The retry flow (`retryLatestAssistantResponse`) and the send flow
 * (`sendQuestion`) run the same sequence around their model call: stream the
 * answer into the assistant message, attach the native Codex trace, record one
 * usage row, and end the turn by completing, cancelling, or reading an
 * interruption. The steps are the same; the policy around them is not. Each
 * flow still decides how to resolve the final text, which extra fields to
 * stamp, how to write its row, what a failure with no output does, and how to
 * release its request.
 *
 * So this owner holds the shared PRIMITIVES and their ordering rules, and each
 * flow composes them with its own policy. It never imports `chat.ts`: the
 * panel-private pieces (refresh helpers, the frame-coalesced refresh factory,
 * the retry hint) are injected.
 *
 * One owner belongs to one assistant message and one turn.
 *
 * Saving the completed answer is not part of the stream: a save that fails
 * after the model finished leaves a complete answer, not an interrupted one.
 * Both flows save it through `saveCompletion`, which owns that error handling.
 */
import type { BlockStreamFlushReason } from "./blockStreamCoalescer";
import {
  createStreamingResponse,
  type StreamingResponseDeps,
} from "./streamingResponse";
import {
  createCodexNativeActivityTraceController,
  noteExplicitCodexNativeSkillInvocations,
  type CodexNativeActivityTraceController,
} from "./codexNativeTrace/controller";
import { finishCodexNativePanelTurn } from "./codexNative/turnCallbacks";
import { finalizeAssistantMessageQuoteCitations } from "./quoteValidation/scheduling";
import {
  EMPTY_OUTPUT_LIMIT_MESSAGE,
  resolveEmptyModelOutcomeMessage,
} from "./directChatCompletion";
import {
  resolveStreamInterruptionOutcome,
  type StreamInterruptionOutcome,
} from "./streamInterruption";
import { getAbortController, getCancelledRequestId } from "./state";
import type { Message } from "./types";
import { formatCodexZoteroMcpError } from "../../codexAppServer/mcpErrors";
import { normalizeGeneratedChatImages } from "../../shared/generatedImages";
import type { ModelTurnOutcome } from "../../shared/llm";
import type { AgentRunStatus } from "../../agent/types";
import type {
  TurnUsageRecorder,
  UsageTurnFlushReason,
} from "../../utils/usageTurnRecorder";
import { sanitizeText } from "../../utils/textSanitization";
import { t } from "../../utils/i18n";
import { appLogger } from "../../core/logging";

export type AssistantTurnStatusKind = "ready" | "sending" | "error" | "warning";

export type AssistantQuoteFinalization = NonNullable<
  Parameters<typeof finalizeAssistantMessageQuoteCitations>[1]
>;

export type AssistantTurnDeps = {
  /** The assistant message this turn streams into. */
  message: Message;
  conversationKey: number;
  /** The write generation captured when the turn started. */
  conversationGeneration: number;
  /** The panel request this turn runs under; a cancel names it. */
  requestId: number;
  /** A native Codex turn gets a trace and Codex-worded error messages. */
  isCodexNativeTurn: boolean;
  /**
   * The turn's usage ledger. Built by the flow, because whether the turn
   * counts as a question is flow policy (a retry does not).
   */
  usageRecorder: TurnUsageRecorder;
  /** Repaints just this message's bubble. */
  refreshMessage: () => void;
  /** Repaints the whole conversation. */
  refreshChat: () => void;
  /** Repaints the finished answer and its prompt's controls. */
  refreshCompletedTurn: () => void;
  setStatus: (text: string, kind: AssistantTurnStatusKind) => void;
  /** The panel's frame-coalesced refresh factory, bound to the panel body. */
  createQueuedRefresh: StreamingResponseDeps["createQueuedRefresh"];
  /** The advice appended to an error that looks like an image problem. */
  resolveRetryHint: (errorMessage: string, imageCount: number) => string;
  /** Stalled-stream timer seam; omitted in production. */
  setTimer?: StreamingResponseDeps["setTimer"];
  clearTimer?: StreamingResponseDeps["clearTimer"];
  /** Test seam: builds the native trace. Omitted means the real controller. */
  createCodexTrace?: (
    message: Message,
    queueRefresh: () => void,
  ) => CodexNativeActivityTraceController;
  /** Test seam: finalizes quote citations. Omitted means the real one. */
  finalizeQuoteCitations?: typeof finalizeAssistantMessageQuoteCitations;
};

/**
 * How a cancelled turn writes itself.
 *
 * - `"trace-first"`: the owner persists the trace as cancelled, repaints the
 *   conversation, then calls `persist()` for the row (the retry flow).
 * - `"refresh-first"`: the owner repaints first, then calls
 *   `persist("cancelled")`; the flow's persist writes the trace with the row
 *   (the send flow).
 *
 * Either way the trace is persisted before the row, because persisting the
 * trace is what sets the message's `agentRunId` the row stores.
 */
export type AssistantTurnCancelOrder = "trace-first" | "refresh-first";

export type AssistantTurnInterruption = StreamInterruptionOutcome & {
  /** The error as the status row shows it. */
  errorMessage: string;
  /** Advice appended to the error, or "". */
  retryHint: string;
};

export type AssistantTurn = {
  /** Repaints the streaming bubble, at most once per frame. */
  queueRefresh: () => void;
  /** Opens the stream. Deltas pushed before this are dropped. */
  start: () => void;
  /** Feeds one provider delta. */
  push: (delta: string) => void;
  /** Releases the buffered tail now, recording why. */
  flush: (reason: BlockStreamFlushReason) => void;
  /** Everything pushed so far, including the not-yet-released tail. */
  getStreamedText: () => string;
  /** Drops the stream and puts the message text back as it was at `start()`. */
  rollback: () => void;
  /** The native trace, once attached; null otherwise. */
  readonly codexTrace: CodexNativeActivityTraceController | null;
  /**
   * Builds the native trace (native Codex turns only), wired to the stream's
   * repaint, and records the skills the user forced.
   */
  attachCodexTrace: (forcedSkillIds?: string[]) => void;
  /** Persists the trace, if there is one. `status` omitted lets it decide. */
  persistTrace: (status?: AgentRunStatus) => Promise<void> | undefined;
  /** The request is going out: the turn now owes a usage row. */
  dispatched: () => void;
  /**
   * Whether the user stopped this turn. Called with the caught error on the
   * error path, where an `AbortError` also counts.
   */
  wasCancelled: (...caught: [] | [error: unknown]) => boolean;
  /** Records why the usage row is written. Starts as `"complete"`. */
  noteUsageOutcome: (reason: UsageTurnFlushReason) => void;
  /**
   * Finalizes a cancelled turn: flush the stream, flush the trace's buffered
   * commentary, finalize the message, persist in `order`, report "Cancelled".
   * A `persist` that throws propagates, and no status is set.
   */
  cancel: (options: {
    order: AssistantTurnCancelOrder;
    persist: (traceStatus?: AgentRunStatus) => Promise<void>;
  }) => Promise<void>;
  /**
   * Opens the completion: releases the buffered tail, then returns the text a
   * turn with no visible answer shows ("" when it generated images).
   */
  beginCompletion: (outcome: ModelTurnOutcome) => string;
  /**
   * After the flow has set the final text: stamps the completion fields,
   * finalizes quote citations, and closes the native trace and Task run.
   */
  recordCompletion: (
    outcome: ModelTurnOutcome,
    quotes: AssistantQuoteFinalization,
  ) => Promise<void>;
  /**
   * Ends the completion on screen: the compact marker, the cleared
   * interrupted and streaming flags, and the completed-turn repaint.
   */
  presentCompletion: (options: { compactMarker: boolean }) => void;
  /**
   * Saves the completed answer's row with the flow's `save` (attempt 0,
   * then 1). A failed save is logged and tried once more. If that fails
   * too, the answer stays complete in memory and the status warns that it
   * is not saved. Never throws; returns whether the answer was saved.
   */
  saveCompletion: (
    save: (attempt: number) => Promise<void>,
  ) => Promise<boolean>;
  /**
   * Reads what a failed turn leaves behind. The streamed text (and its
   * unreleased tail) is read before the stream is disposed.
   */
  readInterruption: (
    error: unknown,
    options: { codexLabel: string; imageCount: number },
  ) => AssistantTurnInterruption;
  /**
   * The turn is over: stop the trace, and write the usage row without
   * awaiting it. Releasing the request stays with the flow.
   */
  end: () => void;
};

/**
 * What a cancelled answer with no text shows. The Cancel button also writes
 * it into a bubble that shows nothing yet (`setupHandlers.ts`), and Task
 * progress reads it as "cancelled".
 */
const CANCELLED_TEXT = "[Cancelled]";

/** One save, then one more, for a completed answer's row. */
const COMPLETION_SAVE_ATTEMPTS = 2;

/** The status after both saves of a completed answer failed. */
const ANSWER_NOT_SAVED_STATUS =
  "Answer not saved. It will be lost when you reload.";

/** A cancelled answer: whatever streamed, or the fallback text. */
export function finalizeCancelledAssistantMessage(
  message: Message,
  fallbackText = CANCELLED_TEXT,
): void {
  const text = sanitizeText(message.text || "");
  const reasoningSummary = sanitizeText(message.reasoningSummary || "");
  const reasoningDetails = sanitizeText(message.reasoningDetails || "");
  const hasReasoning = Boolean(reasoningSummary || reasoningDetails);

  message.text = text || fallbackText;
  message.timestamp = Date.now();
  message.reasoningSummary = reasoningSummary || undefined;
  message.reasoningDetails = reasoningDetails || undefined;
  message.reasoningOpen = hasReasoning
    ? message.reasoningOpen !== false
    : false;
  message.pendingAgentTraceEvents = undefined;
  message.streaming = false;
  message.interrupted = undefined;
  message.completionStatus = undefined;
  message.completionReason = undefined;
  message.webchatRunState = undefined;
  message.webchatCompletionReason = null;
}

export function createAssistantTurn(deps: AssistantTurnDeps): AssistantTurn {
  const { message, conversationKey, conversationGeneration } = deps;
  const stream = createStreamingResponse({
    message,
    refreshMessage: deps.refreshMessage,
    createQueuedRefresh: deps.createQueuedRefresh,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
  });
  const createCodexTrace =
    deps.createCodexTrace || createCodexNativeActivityTraceController;
  const finalizeQuoteCitations =
    deps.finalizeQuoteCitations || finalizeAssistantMessageQuoteCitations;
  let trace: CodexNativeActivityTraceController | null = null;
  let usageOutcome: UsageTurnFlushReason = "complete";

  return {
    queueRefresh: stream.queueRefresh,
    start: stream.start,
    push: stream.push,
    flush: stream.flush,
    getStreamedText: stream.getStreamedText,
    rollback: stream.rollback,

    get codexTrace() {
      return trace;
    },

    attachCodexTrace(forcedSkillIds?: string[]): void {
      trace = deps.isCodexNativeTurn
        ? createCodexTrace(message, stream.queueRefresh)
        : null;
      noteExplicitCodexNativeSkillInvocations(trace, forcedSkillIds);
    },

    persistTrace(status?: AgentRunStatus) {
      return trace?.persist(conversationKey, conversationGeneration, status);
    },

    dispatched(): void {
      deps.usageRecorder.markDispatched();
    },

    wasCancelled(...caught: [] | [error: unknown]): boolean {
      return (
        getCancelledRequestId(conversationKey) >= deps.requestId ||
        Boolean(getAbortController(conversationKey)?.signal.aborted) ||
        (caught.length > 0 &&
          (caught[0] as { name?: string }).name === "AbortError")
      );
    },

    noteUsageOutcome(reason: UsageTurnFlushReason): void {
      usageOutcome = reason;
    },

    async cancel({ order, persist }): Promise<void> {
      // A Cancel before the first released block leaves the placeholder in
      // the bubble; the buffered text replaces it rather than following it.
      if (message.text === CANCELLED_TEXT && stream.getStreamedText()) {
        message.text = "";
      }
      stream.flush("cancel");
      // The turn never reached finish(), so the trace's own buffers are still
      // holding commentary the model sent. Deliver it before the store write.
      trace?.flushBufferedProgress("cancel");
      finalizeCancelledAssistantMessage(message);
      if (order === "trace-first") {
        await trace?.persist(
          conversationKey,
          conversationGeneration,
          "cancelled",
        );
        deps.refreshChat();
        await persist();
      } else {
        deps.refreshChat();
        await persist("cancelled");
      }
      deps.setStatus("Cancelled", "ready");
    },

    beginCompletion(outcome: ModelTurnOutcome): string {
      stream.flush("final");
      const hasGeneratedOutput = normalizeGeneratedChatImages(
        message.generatedImages,
      ).length;
      const outputLimited =
        outcome.completion.status === "incomplete" &&
        outcome.completion.reason === "output_limit";
      return hasGeneratedOutput
        ? ""
        : outputLimited
          ? EMPTY_OUTPUT_LIMIT_MESSAGE
          : resolveEmptyModelOutcomeMessage(outcome.completion);
    },

    async recordCompletion(
      outcome: ModelTurnOutcome,
      quotes: AssistantQuoteFinalization,
    ): Promise<void> {
      message.completionStatus = outcome.completion.status;
      message.completionReason =
        "reason" in outcome.completion ? outcome.completion.reason : undefined;
      await finalizeQuoteCitations(message, quotes);
      finishCodexNativePanelTurn({
        conversationKey,
        assistantMessage: message,
        codexActivityTrace: trace,
      });
    },

    presentCompletion({ compactMarker }): void {
      message.compactMarker = compactMarker;
      if (message.compactMarker && !message.text.trim()) {
        message.text = "Conversation compacted";
      }
      message.interrupted = undefined;
      message.streaming = false;
      deps.refreshCompletedTurn();
    },

    async saveCompletion(save): Promise<boolean> {
      for (let attempt = 0; attempt < COMPLETION_SAVE_ATTEMPTS; attempt += 1) {
        try {
          await save(attempt);
          return true;
        } catch (error) {
          appLogger.warn(
            `LLM: The completed answer was not saved (attempt ${attempt + 1} of ${COMPLETION_SAVE_ATTEMPTS})`,
            error,
          );
        }
      }
      deps.setStatus(t(ANSWER_NOT_SAVED_STATUS), "warning");
      return false;
    },

    readInterruption(error, { codexLabel, imageCount }) {
      const technicalErrMsg = (error as Error).message || "Error";
      const errorMessage = deps.isCodexNativeTurn
        ? formatCodexZoteroMcpError(error, codexLabel)
        : technicalErrMsg;
      const retryHint = deps.resolveRetryHint(errorMessage, imageCount);
      // Read whatever streamed, including the not-yet-released tail, BEFORE
      // the stream is dropped. The message-text fallback covers content that
      // was released out of a stream torn down before the throw.
      const partialText = sanitizeText(
        stream.getStreamedText() || message.text || "",
      );
      stream.dispose();
      const outcome = resolveStreamInterruptionOutcome({
        partialText,
        errorMessage,
        retryHint,
      });
      return { ...outcome, errorMessage, retryHint };
    },

    end(): void {
      // The trace controller must stop here or a buffered flush lands on a
      // message that was already persisted.
      trace?.dispose();
      // Every path through a turn ends here, so this is where the one usage
      // row is written. It never throws and is deliberately not awaited:
      // usage must not delay the turn.
      void deps.usageRecorder.flush(usageOutcome);
    },
  };
}
