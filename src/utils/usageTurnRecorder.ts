/**
 * Per-turn usage accumulator.
 *
 * WHY THIS EXISTS: `onUsage` does not fire once per question. It fires many
 * times inside one stream, and what it carries differs per provider (see
 * `src/utils/llmClient.ts`):
 *
 *   - Anthropic (`parseAnthropicStreamResponse`): `message_start` carries the
 *     input tokens once; every `message_delta` carries the CUMULATIVE
 *     `output_tokens` so far and reports `promptTokens: 0`.
 *   - Gemini (`parseGeminiStreamResponse`): every chunk's `usageMetadata`
 *     repeats the cumulative `promptTokenCount` / `candidatesTokenCount` /
 *     `totalTokenCount`.
 *   - OpenAI-compatible and Responses streams: usually one final payload per
 *     request, already totalled.
 *
 * Every one of those reporters is cumulative and monotonic WITHIN one provider
 * request, so summing callbacks would inflate a turn enormously. The rule is
 * therefore MAXIMUM, not sum, per numeric field within a request.
 *
 * One user turn can still contain more than one provider request: the agent
 * runtime runs a round per tool step, and the chat path can retry a failed
 * request inside the same turn. Those requests are separate bills, so each one
 * is its own segment and the turn total is the SUM OF THE SEGMENT MAXIMA. A
 * segment is identified by the caller when it knows one (the agent passes its
 * round number); otherwise a segment boundary is inferred from a cumulative
 * counter that went DOWN, which only a fresh request can cause. A reported
 * zero is treated as "not reported" rather than as a decrease, because that is
 * exactly what Anthropic's `message_delta` does with the prompt tokens.
 *
 * Nothing in here may break or delay a chat turn: `record` is synchronous and
 * total, and `flush` catches everything and reports a boolean.
 */

import { isEphemeralConversationKey } from "../shared/conversationKeySpace";
import type { UsageStats } from "../shared/llm";
import { appLogger } from "../core/logging";
import {
  areConversationWritesFrozen,
  isConversationWriteGenerationCurrent,
} from "../shared/conversationWriteFence";
import {
  recordUsageEvent,
  resolveUsageScope,
  type UsageEventRuntime,
} from "./usageStore";

export type UsageTurnIdentity = {
  conversationKey: number;
  /** The write generation captured when the turn started, when the call site has one. */
  conversationGeneration?: number;
  /** False for a retry: its tokens are real, but the question was already counted. */
  countsAsQuestion?: boolean;
  runtime?: UsageEventRuntime;
  model?: string | null;
  provider?: string | null;
};

export type UsageTurnTotals = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type UsageTurnFlushReason = "complete" | "error" | "abort";

export type TurnUsageRecorder = {
  /** Mark the turn as actually dispatched to a provider. */
  markDispatched: () => void;
  /** Fold one provider callback into the turn. Never throws. */
  record: (usage: UsageStats, options?: { segment?: number | string }) => void;
  /** Current turn totals, for tests and diagnostics. */
  snapshot: () => UsageTurnTotals;
  /** Write the single row for this turn. Resolves false when nothing was written. */
  flush: (reason: UsageTurnFlushReason) => Promise<boolean>;
};

export type UsageTurnRecorderDeps = {
  writeEvent?: typeof recordUsageEvent;
  resolveScope?: typeof resolveUsageScope;
  isWriteAllowed?: (identity: UsageTurnIdentity) => boolean;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
};

type SegmentTotals = UsageTurnTotals;

const EMPTY_TOTALS: UsageTurnTotals = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function normalizeTokenCount(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function defaultIsWriteAllowed(identity: UsageTurnIdentity): boolean {
  // A temporary side chat records no usage.
  if (isEphemeralConversationKey(identity.conversationKey)) return false;
  if (areConversationWritesFrozen(identity.conversationKey)) return false;
  if (identity.conversationGeneration === undefined) return true;
  return isConversationWriteGenerationCurrent(
    identity.conversationKey,
    identity.conversationGeneration,
  );
}

function defaultLog(message: string, error?: unknown): void {
  appLogger.warn(`LLM: ${message}`, error);
}

export function createTurnUsageRecorder(
  identity: UsageTurnIdentity,
  deps: UsageTurnRecorderDeps = {},
): TurnUsageRecorder {
  const writeEvent = deps.writeEvent || recordUsageEvent;
  const resolveScope = deps.resolveScope || resolveUsageScope;
  const isWriteAllowed = deps.isWriteAllowed || defaultIsWriteAllowed;
  const now = deps.now || (() => Date.now());
  const log = deps.log || defaultLog;

  /** Segments already closed: their maxima are final and get summed. */
  const bankedSegments: SegmentTotals[] = [];
  let currentSegmentId: number | string | null = null;
  let currentSegment: SegmentTotals | null = null;
  let dispatched = false;
  let sawUsage = false;
  let flushed = false;
  let firstSampleAt: number | null = null;

  const bankCurrentSegment = () => {
    if (currentSegment) bankedSegments.push(currentSegment);
    currentSegment = null;
    currentSegmentId = null;
  };

  const startSegment = (segmentId: number | string | null) => {
    currentSegmentId = segmentId;
    currentSegment = { ...EMPTY_TOTALS };
  };

  const totals = (): UsageTurnTotals => {
    const segments = currentSegment
      ? [...bankedSegments, currentSegment]
      : bankedSegments;
    return segments.reduce<UsageTurnTotals>(
      (sum, segment) => ({
        promptTokens: sum.promptTokens + segment.promptTokens,
        completionTokens: sum.completionTokens + segment.completionTokens,
        // A provider's own total can exceed prompt + completion (Gemini counts
        // thinking tokens there), so keep whichever is larger per segment.
        totalTokens:
          sum.totalTokens +
          Math.max(
            segment.totalTokens,
            segment.promptTokens + segment.completionTokens,
          ),
        cacheReadTokens: sum.cacheReadTokens + segment.cacheReadTokens,
        cacheWriteTokens: sum.cacheWriteTokens + segment.cacheWriteTokens,
      }),
      { ...EMPTY_TOTALS },
    );
  };

  const record: TurnUsageRecorder["record"] = (usage, options) => {
    try {
      if (flushed) return;
      // Obey the same fence as every other conversation write: a frozen or
      // superseded conversation must not accumulate usage either.
      if (!isWriteAllowed(identity)) return;
      const sample: UsageTurnTotals = {
        promptTokens: normalizeTokenCount(usage?.promptTokens),
        completionTokens: normalizeTokenCount(usage?.completionTokens),
        totalTokens: normalizeTokenCount(usage?.totalTokens),
        cacheReadTokens: normalizeTokenCount(usage?.cacheReadTokens),
        cacheWriteTokens: normalizeTokenCount(usage?.cacheWriteTokens),
      };
      if (
        !sample.promptTokens &&
        !sample.completionTokens &&
        !sample.totalTokens &&
        !sample.cacheReadTokens &&
        !sample.cacheWriteTokens
      ) {
        // Context-only telemetry (the agent emits zero-token context events).
        return;
      }
      const segmentId = options?.segment ?? null;
      if (!currentSegment) {
        startSegment(segmentId);
      } else if (segmentId !== null && segmentId !== currentSegmentId) {
        // The caller knows the request boundary (agent round): trust it.
        bankCurrentSegment();
        startSegment(segmentId);
      } else {
        // No caller-supplied boundary: a cumulative counter that went down can
        // only mean a new provider request inside the same turn. A reported
        // zero carries no information (Anthropic's message_delta reports the
        // prompt as zero), so only positive values count as a decrease.
        const promptDropped =
          sample.promptTokens > 0 &&
          sample.promptTokens < currentSegment.promptTokens;
        const completionDropped =
          sample.completionTokens > 0 &&
          sample.completionTokens < currentSegment.completionTokens;
        if (promptDropped || completionDropped) {
          bankCurrentSegment();
          startSegment(segmentId);
        }
      }
      const segment = currentSegment!;
      segment.promptTokens = Math.max(
        segment.promptTokens,
        sample.promptTokens,
      );
      segment.completionTokens = Math.max(
        segment.completionTokens,
        sample.completionTokens,
      );
      segment.totalTokens = Math.max(segment.totalTokens, sample.totalTokens);
      segment.cacheReadTokens = Math.max(
        segment.cacheReadTokens,
        sample.cacheReadTokens,
      );
      segment.cacheWriteTokens = Math.max(
        segment.cacheWriteTokens,
        sample.cacheWriteTokens,
      );
      sawUsage = true;
      if (firstSampleAt === null) firstSampleAt = now();
    } catch (error) {
      log("Failed to accumulate usage for a turn", error);
    }
  };

  const flush: TurnUsageRecorder["flush"] = async (reason) => {
    try {
      // One row per turn: the settle point can run on more than one path
      // (completion, error, abort) and must not write twice.
      if (flushed) return false;
      flushed = true;
      // A turn that never reached a provider is not a question and burned no
      // tokens. An aborted or failed turn that DID dispatch still is: the
      // provider bills the tokens it already produced.
      if (!dispatched && !sawUsage) return false;
      if (!isWriteAllowed(identity)) return false;
      const turnTotals = totals();
      const resolved = await resolveScope(identity.conversationKey);
      // Re-check the fence after the awaits: the conversation may have been
      // deleted while the scope lookup was in flight.
      if (!isWriteAllowed(identity)) return false;
      return await writeEvent({
        timestamp: firstSampleAt ?? now(),
        mode: resolved.mode,
        conversationKey: identity.conversationKey,
        conversationInstanceID: resolved.conversationInstanceID,
        libraryID: resolved.libraryID,
        paperItemID: resolved.paperItemID,
        model: identity.model ?? null,
        provider: identity.provider ?? null,
        runtime: identity.runtime ?? null,
        promptTokens: turnTotals.promptTokens,
        completionTokens: turnTotals.completionTokens,
        totalTokens: turnTotals.totalTokens,
        cacheReadTokens: turnTotals.cacheReadTokens,
        cacheWriteTokens: turnTotals.cacheWriteTokens,
        // A dispatched turn that never saw a usage payload burned tokens
        // nobody counted. Writing zeros without saying so would make it
        // indistinguishable from a genuinely free turn.
        tokenSource: sawUsage ? "provider" : "unreported",
        countsAsQuestion: identity.countsAsQuestion !== false,
      });
    } catch (error) {
      log(`Failed to record usage for a ${reason} turn`, error);
      return false;
    }
  };

  return {
    markDispatched: () => {
      dispatched = true;
    },
    record,
    snapshot: () => totals(),
    flush,
  };
}
