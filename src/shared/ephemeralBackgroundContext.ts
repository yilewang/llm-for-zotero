/**
 * Background context for a temporary side chat (an ephemeral conversation
 * key, see conversationKeySpace.ts): text the side chat's model reads before
 * each request, such as the window's main chat so far. It is never a composer
 * chip and never a user message, and, like everything else for an ephemeral
 * key, it is never persisted.
 *
 * The side chat registers a provider per key; both request builders (plain
 * chat and the plugin agent runtime) call buildEphemeralBackgroundContextBlock
 * for the key they send on and add the block as a system message.
 */
import { isEphemeralConversationKey } from "./conversationKeySpace";

export const EPHEMERAL_BACKGROUND_CONTEXT_LABEL =
  "Main chat conversation so far (for reference; the user is asking a side question in a separate, temporary side chat):";

type BackgroundContextProvider = () => string | null;

const providers = new Map<number, BackgroundContextProvider>();

function normalizeKey(value: number): number {
  const key = Math.floor(Number(value));
  return Number.isFinite(key) && key > 0 ? key : 0;
}

/** Register the background text source for one ephemeral key. */
export function setEphemeralBackgroundContextProvider(
  conversationKey: number,
  provider: BackgroundContextProvider,
): void {
  const key = normalizeKey(conversationKey);
  if (!key || typeof provider !== "function") return;
  providers.set(key, provider);
}

export function clearEphemeralBackgroundContextProvider(
  conversationKey: number,
): void {
  providers.delete(normalizeKey(conversationKey));
}

/** Carry a side chat's provider over when the side chat changes key. */
export function moveEphemeralBackgroundContextProvider(
  oldKey: number,
  newKey: number,
): void {
  const from = normalizeKey(oldKey);
  const to = normalizeKey(newKey);
  if (!from || !to || from === to) return;
  const provider = providers.get(from);
  providers.delete(from);
  if (provider) providers.set(to, provider);
  else providers.delete(to);
}

/**
 * The labelled background block for a request on `conversationKey`, or "" for
 * a real key, a key with no provider, or a provider that has nothing (or
 * fails).
 */
export function buildEphemeralBackgroundContextBlock(
  conversationKey: number,
): string {
  const key = normalizeKey(conversationKey);
  if (!key || !isEphemeralConversationKey(key)) return "";
  const provider = providers.get(key);
  if (!provider) return "";
  let text = "";
  try {
    const value = provider();
    text = typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
  return text ? `${EPHEMERAL_BACKGROUND_CONTEXT_LABEL}\n\n${text}` : "";
}
