/**
 * Reading a paper for the chat (a full PDF parse, chunking, the search index
 * write-through, and quote page text) is heavy. Opening a PDF must not pay for
 * it: three PDFs opened together used to parse three papers while the reader
 * was still drawing its first page, which left it blank (#524).
 *
 * A panel therefore warms its paper only once the user starts to use the chat
 * in that panel: focusing or typing in the composer. Sending, Add Text and
 * every other question path still load what they need on their own, so this
 * only gets a head start while the question is being written.
 */

type IntentEventTarget = {
  addEventListener: (type: string, listener: (event: Event) => void) => void;
};

/** What a warm reads: the paper and the conversation it belongs to. */
export type PaperWarmTarget = {
  contextItemId: number;
  conversationKey: number;
};

const COMPOSER_SELECTOR = "#llm-input";
const INTENT_EVENTS = ["focusin", "input"] as const;

const installedBodies = new WeakSet<object>();
/** The paper each body last warmed, so typing does not re-warm per key. */
const lastWarmedContextItemIds = new WeakMap<object, number>();

function isComposerEvent(event: Event): boolean {
  const target = event.target as { closest?: (s: string) => unknown } | null;
  return Boolean(target?.closest?.(COMPOSER_SELECTOR));
}

/**
 * Warms the panel's paper the first time the user reaches for its composer.
 * The target is resolved at that moment, so a panel reused for another paper
 * (or another tab's paper) warms the paper it shows then. Installing twice on
 * one body is a no-op.
 */
export function installPaperWarmOnIntent(
  body: IntentEventTarget,
  resolveTarget: () => PaperWarmTarget | null,
  warm: (target: PaperWarmTarget) => void,
): void {
  if (installedBodies.has(body)) return;
  installedBodies.add(body);
  const onIntent = (event: Event) => {
    if (!isComposerEvent(event)) return;
    let target: PaperWarmTarget | null = null;
    try {
      target = resolveTarget();
    } catch {
      return;
    }
    if (!target || !(target.contextItemId > 0)) return;
    if (lastWarmedContextItemIds.get(body) === target.contextItemId) return;
    lastWarmedContextItemIds.set(body, target.contextItemId);
    warm(target);
  };
  for (const type of INTENT_EVENTS) body.addEventListener(type, onIntent);
}
