/**
 * Makes every setTimeout of at least `minMs` fire on the next turn instead,
 * so a test of code that sleeps between polls does not wait in real time.
 * Shorter timers keep their delay, so ordering between short timers holds.
 * Returns the function that puts the real setTimeout back.
 */
export function shortenLongWaits(minMs = 1000): () => void {
  const realSetTimeout = globalThis.setTimeout;
  const patched = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
    realSetTimeout(
      handler as (...callbackArgs: unknown[]) => void,
      (ms ?? 0) >= minMs ? 0 : ms,
      ...args,
    )) as typeof setTimeout;
  globalThis.setTimeout = patched;
  return () => {
    if (globalThis.setTimeout === patched)
      globalThis.setTimeout = realSetTimeout;
  };
}
