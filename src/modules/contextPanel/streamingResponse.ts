/**
 * The streaming response of one assistant turn.
 *
 * A provider delivers an answer as a long run of small deltas. Painting each
 * one would repaint the bubble hundreds of times, so the deltas are buffered by
 * a block coalescer and released as readable blocks: each released block is
 * appended to the assistant message and the bubble is repainted once, through a
 * frame-coalesced refresh the panel owns.
 *
 * The retry flow (`retryLatestAssistantResponse`) and the send flow
 * (`sendQuestion`) used to carry a copy of that wiring each. This owner holds
 * it once. One owner belongs to one assistant message and one turn: it records
 * the message's pre-stream text at `start()`, so `rollback()` can put the
 * message back the way it was, and everything it owns lives in this closure.
 */
import {
  createBlockStreamCoalescer,
  type BlockStreamCoalescer,
  type BlockStreamCoalescerOptions,
  type BlockStreamFlushReason,
} from "./blockStreamCoalescer";
import type { Message } from "./types";
import { sanitizeText } from "../../utils/textSanitization";

export type StreamingResponseDeps = {
  /** The assistant message being streamed into. */
  message: Message;
  /** Repaints just this message's bubble. */
  refreshMessage: () => void;
  /**
   * The panel's frame-coalesced refresh factory, already bound to the panel
   * body. Injected rather than imported: the scheduler it produces is tracked
   * per panel by `chat.ts`, which cancels it when the panel is torn down.
   */
  createQueuedRefresh: (refresh: () => void) => () => void;
  /**
   * Arms the coalescer's stalled-stream timer. Omitted in production, where the
   * coalescer falls back to the global `setTimeout`; a test injects one to hold
   * the timer still or fire it on demand.
   */
  setTimer?: BlockStreamCoalescerOptions["setTimer"];
  /** Disarms a timer `setTimer` returned. Omitted means `clearTimeout`. */
  clearTimer?: BlockStreamCoalescerOptions["clearTimer"];
};

export type StreamingResponse = {
  /**
   * Repaints the streaming message's bubble, at most once per frame. Shared
   * with the turn's other writers (the native trace controller and the
   * reasoning handler) so their repaints coalesce with the stream's.
   */
  queueRefresh: () => void;
  /** Opens the stream. Deltas pushed before this are dropped. */
  start: () => void;
  /** Feeds one provider delta. Sanitized first; empty deltas are ignored. */
  push: (delta: string) => void;
  /** Releases the buffered tail now, recording why. */
  flush: (reason: BlockStreamFlushReason) => void;
  /** Everything pushed so far, including the not-yet-released tail. */
  getStreamedText: () => string;
  /** Drops the stream and puts the message text back as it was at `start()`. */
  rollback: () => void;
  /** Drops the buffered tail and refuses later deltas. Idempotent. */
  dispose: () => void;
};

export function createStreamingResponse(
  deps: StreamingResponseDeps,
): StreamingResponse {
  const queueRefresh = deps.createQueuedRefresh(deps.refreshMessage);
  let coalescer: BlockStreamCoalescer | null = null;
  let preStreamText = "";

  return {
    queueRefresh,

    start(): void {
      if (coalescer) return;
      preStreamText = deps.message.text;
      coalescer = createBlockStreamCoalescer({
        onBlock: (chunk) => {
          deps.message.text += chunk;
          queueRefresh();
        },
        setTimer: deps.setTimer,
        clearTimer: deps.clearTimer,
      });
    },

    push(delta: string): void {
      const chunk = sanitizeText(delta);
      if (!chunk) return;
      coalescer?.pushText(chunk);
    },

    flush(reason: BlockStreamFlushReason): void {
      coalescer?.flushNow(reason);
    },

    getStreamedText(): string {
      return coalescer?.getFullText() || "";
    },

    rollback(): void {
      if (!coalescer) return;
      coalescer.cancel();
      deps.message.text = preStreamText;
    },

    dispose(): void {
      coalescer?.cancel();
    },
  };
}
