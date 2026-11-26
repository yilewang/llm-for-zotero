import { config } from "../../package.json";

/**
 * An opaque, stable id for one conversation, for providers that route on it.
 *
 * Some gateways ask clients to send a session id so consecutive turns of the
 * same conversation land on the same backend and reuse its prompt cache —
 * OpenCode Zen's `x-opencode-session` is the case that prompted this (#439).
 * The value is routing metadata: the model never sees it, and it carries no
 * conversation state of its own.
 *
 * It is derived rather than stored. A conversation already has a stable key,
 * so the id is a digest of that key salted with one random value generated
 * once per install. That yields an id that is the same on every turn of a
 * conversation, different between conversations, and different between two
 * people whose libraries happen to produce the same key — while adding a
 * single preference instead of a row per conversation.
 *
 * The salt is what makes the digest opaque. Without it the id would be a
 * digest of a small integer, which anyone receiving it could reverse by
 * enumeration, and the conversation key would effectively leave the machine.
 */

const SESSION_SALT_KEY = `${config.prefsPrefix}.providerSessionSalt`;

type ZoteroPrefsLike = {
  get?: (key: string, global?: boolean) => unknown;
  set?: (key: string, value: unknown, global?: boolean) => void;
};

function prefs(): ZoteroPrefsLike | undefined {
  return (globalThis as { Zotero?: { Prefs?: ZoteroPrefsLike } }).Zotero?.Prefs;
}

function randomHex(byteLength: number): string {
  const cryptoObject = (globalThis as { crypto?: Crypto }).crypto;
  const bytes = new Uint8Array(byteLength);
  if (cryptoObject?.getRandomValues) {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One salt per install, minted on first use and kept in preferences. */
function resolveSalt(): string {
  const store = prefs();
  const existing = store?.get?.(SESSION_SALT_KEY, true);
  if (typeof existing === "string" && existing.length >= 16) return existing;
  const salt = randomHex(16);
  store?.set?.(SESSION_SALT_KEY, salt, true);
  return salt;
}

const sessionIdCache = new Map<string, string>();

async function digest(value: string): Promise<string> {
  const cryptoObject = (globalThis as { crypto?: Crypto }).crypto;
  if (!cryptoObject?.subtle) {
    // Never substitute a fresh id for an existing conversation. The dispatch
    // boundary rejects a provider-required session when derivation is unavailable.
    return "";
  }
  const bytes = new TextEncoder().encode(value);
  const stable = new Uint8Array(bytes.byteLength);
  stable.set(bytes);
  const hashed = await cryptoObject.subtle.digest("SHA-256", stable.buffer);
  return [...new Uint8Array(hashed)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/**
 * The session id for a conversation, or undefined when there is no
 * conversation to identify. Standalone operations use their own scope instead;
 * the transport must not send a provider-required header with an empty value.
 */
export async function resolveProviderSessionId(
  conversationKey: number | string | null | undefined,
): Promise<string | undefined> {
  if (conversationKey === null || conversationKey === undefined) {
    return undefined;
  }
  const key = String(conversationKey).trim();
  if (!key) return undefined;
  const cached = sessionIdCache.get(key);
  if (cached) return cached;
  const derived = await digest(`${resolveSalt()}:${key}`);
  if (!derived) return undefined;
  sessionIdCache.set(key, derived);
  return derived;
}

/** A standalone test or utility run is its own session, shared by its retries. */
export function createProviderOperationId(): string {
  return randomHex(16);
}
