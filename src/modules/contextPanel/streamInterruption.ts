/**
 * Recovery for streamed assistant replies that are cut off before they finish
 * (most commonly a mid-stream connectivity drop that surfaces as
 * "Error in input stream").
 *
 * Historically the streaming send path overwrote the whole assistant message
 * with a bare `Error: …` string on failure, discarding everything that had
 * already streamed. This helper keeps the partial content instead and lets the
 * caller flag the message as interrupted so the UI can render a neutral
 * "interrupted" footer without polluting the message body with error text.
 */

export interface StreamInterruptionParams {
  /**
   * Text that streamed before the break. Callers should pass the coalescer's
   * full text (sanitized) so the last, not-yet-flushed sentence is included.
   */
  partialText: string;
  /** The caught error's message. */
  errorMessage: string;
  /** Optional trailing hint appended to the bare-error fallback (e.g. quota advice). */
  retryHint?: string;
}

export interface StreamInterruptionOutcome {
  /** Final text for the assistant bubble. */
  text: string;
  /**
   * True when partial content was preserved and the reply is incomplete. Drives
   * the interrupted footer; the raw error is surfaced separately (status row).
   */
  interrupted: boolean;
}

/**
 * Decide how to finalize an assistant message after a streaming error.
 *
 * - If any text streamed before the break, keep it verbatim (no error text
 *   mixed into the body) and mark the message interrupted.
 * - If nothing streamed, fall back to the previous `Error: …` message since
 *   there is no partial content worth preserving.
 */
export function resolveStreamInterruptionOutcome(
  params: StreamInterruptionParams,
): StreamInterruptionOutcome {
  const partialText = params.partialText || "";
  if (partialText.trim()) {
    return { text: partialText, interrupted: true };
  }
  const notice = `Error: ${params.errorMessage || "Error"}${
    params.retryHint || ""
  }`;
  return { text: notice, interrupted: false };
}

/**
 * Neutral, provider-agnostic label for the interrupted footer. The concrete
 * error is shown separately in the status row, so this stays short.
 */
export function getStreamInterruptionLabel(): string {
  return "Response interrupted before it finished — retry to continue.";
}
