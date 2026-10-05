import { createStreamingResponse } from "../../src/modules/contextPanel/streamingResponse";
import type { Message } from "../../src/modules/contextPanel/types";
import type { RenderFlightRun } from "../../src/agent/flightMetrics";

/**
 * The rig behind the render flight numbers.
 *
 * Every run drives the real streaming-response owner
 * (`src/modules/contextPanel/streamingResponse.ts`) exactly as the send and
 * retry flows drive it: start, push each provider delta, flush "final". The
 * rig injects only the owner's two seams a test needs: a refresh factory that
 * counts scheduled repaints and paints nothing, and a stall timer the rig holds
 * still or fires on demand.
 *
 * The counts are read from the outside. A released block is a write to the
 * message text, a delta is a push that grew the owner's streamed text, and a
 * repaint is a call of the queued refresh, so `blocksReleased` and
 * `refreshesScheduled` are measured independently of each other.
 */

/** The fixed transcript length every run pushes, in characters. */
export const RENDER_TRANSCRIPT_CHARS = 2000;

/** One sentence of the synthetic answer; deliberately dull and repeatable. */
const SENTENCE =
  "A streamed answer reaches the panel as many small deltas, not as blocks. ";

/** Four sentences and a blank line: one paragraph the coalescer can end on. */
const PARAGRAPH = `${SENTENCE.repeat(4).trimEnd()}\n\n`;

/**
 * The transcript, built rather than pasted so it is exactly as long as it says
 * and identical on every machine.
 */
export function buildRenderTranscript(
  totalChars: number = RENDER_TRANSCRIPT_CHARS,
): string {
  let text = "";
  while (text.length < totalChars) text += PARAGRAPH;
  return text.slice(0, totalChars);
}

export type RenderFlightDriveOptions = {
  /** The name this run is pinned under. */
  id: string;
  /** How many characters the provider hands over at a time. */
  deltaChars: number;
  /** Defaults to the fixed 2,000-character transcript. */
  transcript?: string;
  /**
   * Fires the stalled-stream timer after every delta: the worst case, where no
   * natural boundary ever arrives before the coalescer gives up waiting.
   */
  fireStallTimer?: boolean;
};

/**
 * What released a block, as the rig sees it from outside the owner: a pushed
 * delta that reached a boundary or the hard cap, the stall timer, or the final
 * flush that ends the turn.
 */
export type RenderFlightReleaseCause = "delta" | "timer" | "final";

export type RenderFlightDriveResult = {
  run: RenderFlightRun;
  /** What the message bubble holds once the turn ends. */
  text: string;
  /** What released each block, in order. */
  releasedBy: RenderFlightReleaseCause[];
};

/** Pushes one transcript through the streaming-response owner and counts what it cost. */
export function driveRenderFlight(
  options: RenderFlightDriveOptions,
): RenderFlightDriveResult {
  const transcript = options.transcript ?? buildRenderTranscript();
  const releasedBy: RenderFlightReleaseCause[] = [];
  let cause: RenderFlightReleaseCause = "delta";
  let text = "";
  let refreshesScheduled = 0;
  let blocksReleased = 0;
  let stallTimer: (() => void) | null = null;

  /** The owner appends each released block with one write to the text. */
  const message = {
    role: "assistant",
    get text() {
      return text;
    },
    set text(next: string) {
      text = next;
      blocksReleased += 1;
      releasedBy.push(cause);
    },
  } as Message;

  const streamingResponse = createStreamingResponse({
    message,
    refreshMessage: () => {},
    /** Stands in for the panel's frame-coalesced refresh; counts, paints nothing. */
    createQueuedRefresh: () => () => {
      refreshesScheduled += 1;
    },
    setTimer: (callback) => {
      stallTimer = callback;
      return "stall-timer";
    },
    clearTimer: () => {
      stallTimer = null;
    },
  });

  /** Disarms the armed stall timer and hands back its callback, if any. */
  const takeStallTimer = (): (() => void) | null => {
    const armed = stallTimer;
    stallTimer = null;
    return armed;
  };

  streamingResponse.start();
  let deltas = 0;
  for (let at = 0; at < transcript.length; at += options.deltaChars) {
    const streamedBefore = streamingResponse.getStreamedText().length;
    cause = "delta";
    streamingResponse.push(transcript.slice(at, at + options.deltaChars));
    if (streamingResponse.getStreamedText().length > streamedBefore)
      deltas += 1;
    if (options.fireStallTimer) {
      const fire = takeStallTimer();
      cause = "timer";
      fire?.();
    }
  }
  cause = "final";
  streamingResponse.flush("final");
  const charsPushed = streamingResponse.getStreamedText().length;

  return {
    run: {
      id: options.id,
      deltaChars: options.deltaChars,
      deltas,
      charsPushed,
      blocksReleased,
      refreshesScheduled,
      stallTimerFires: Boolean(options.fireStallTimer),
    },
    text,
    releasedBy,
  };
}

/**
 * The four runs the render baseline pins: the fixed transcript at three delta
 * sizes, plus the same 16-character stream stalling before every delta.
 */
export function measureRenderFlight(): RenderFlightRun[] {
  const transcript = buildRenderTranscript();
  return [
    driveRenderFlight({ id: "delta1", deltaChars: 1, transcript }),
    driveRenderFlight({ id: "delta16", deltaChars: 16, transcript }),
    driveRenderFlight({ id: "delta128", deltaChars: 128, transcript }),
    driveRenderFlight({
      id: "delta16Stalled",
      deltaChars: 16,
      transcript,
      fireStallTimer: true,
    }),
  ].map((driven) => driven.run);
}
