/**
 * The runtime turns (Claude Code, Codex, Antigravity) still running for each
 * conversation, from the moment the runtime is asked until its turn has
 * settled, including a stopped turn the runtime is still winding down.
 *
 * A conversation's runtime session must not be reset while one of its turns
 * is in flight: a Codex thread archived under a turn that is still finishing,
 * or a Claude session dropped before the turn's own end writes it back,
 * leaves the chat naming the wrong session (docs: runtime session lifecycle).
 * runtimeSessionReset.ts refuses a reset then; the user retries once the turn
 * has settled.
 */

const inFlight = new Map<number, number>();

/** Registers a turn of the conversation; call the result when it settles. */
export function beginRuntimeTurn(conversationKey: number): () => void {
  const key = Math.floor(Number(conversationKey)) || 0;
  if (!(key > 0)) return () => undefined;
  inFlight.set(key, (inFlight.get(key) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (inFlight.get(key) || 1) - 1;
    if (left > 0) inFlight.set(key, left);
    else inFlight.delete(key);
  };
}

/** Whether a runtime turn of the conversation has not settled yet. */
export function isRuntimeTurnInFlight(conversationKey: number): boolean {
  return (inFlight.get(Math.floor(Number(conversationKey)) || 0) || 0) > 0;
}
