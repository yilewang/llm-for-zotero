/**
 * The reader model a user picked in the composer's model menu.
 *
 * One selection per runtime (plugin Agent, Codex, Claude Code), kept across
 * chats. The selection holds no credentials: an API reader is named by its
 * model entry ID and the host looks the entry up when a paper is read, so a
 * deleted entry simply reads as "Same as main". A runtime's own reader is
 * named by model name.
 *
 * Stored as one string per runtime: "" (Same as main), "entry:<entryId>" or
 * "model:<name>".
 */
import type { ConversationSystem } from "./types";

export type ReaderSelection =
  | { kind: "entry"; entryId: string }
  | { kind: "model"; model: string };

/** The runtimes that keep a reader selection of their own. */
export type ReaderRuntimeKey = "agent" | "codex" | "claude";

export const READER_RUNTIME_KEYS: readonly ReaderRuntimeKey[] = [
  "agent",
  "codex",
  "claude",
];

export function isReaderRuntimeKey(value: unknown): value is ReaderRuntimeKey {
  return (
    typeof value === "string" &&
    (READER_RUNTIME_KEYS as readonly string[]).includes(value)
  );
}

/** The reader slot a conversation system uses. */
export function readerRuntimeKeyForSystem(
  system: ConversationSystem | null | undefined,
): ReaderRuntimeKey {
  if (system === "codex") return "codex";
  if (system === "claude_code") return "claude";
  return "agent";
}

const ENTRY_PREFIX = "entry:";
const MODEL_PREFIX = "model:";

/** The stored form; "" for no selection (Same as main). */
export function encodeReaderSelection(
  selection: ReaderSelection | null | undefined,
): string {
  if (!selection) return "";
  if (selection.kind === "entry") {
    const entryId = selection.entryId.trim();
    return entryId ? `${ENTRY_PREFIX}${entryId}` : "";
  }
  const model = selection.model.trim();
  return model ? `${MODEL_PREFIX}${model}` : "";
}

/** The selection a stored string names; null for "" and anything unknown. */
export function decodeReaderSelection(raw: unknown): ReaderSelection | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.startsWith(ENTRY_PREFIX)) {
    const entryId = value.slice(ENTRY_PREFIX.length).trim();
    return entryId ? { kind: "entry", entryId } : null;
  }
  if (value.startsWith(MODEL_PREFIX)) {
    const model = value.slice(MODEL_PREFIX.length).trim();
    return model ? { kind: "model", model } : null;
  }
  return null;
}

/** A stored string in its canonical form; "" when it names nothing. */
export function normalizeStoredReaderSelection(raw: unknown): string {
  return encodeReaderSelection(decodeReaderSelection(raw));
}

export function sameReaderSelection(
  a: ReaderSelection | null | undefined,
  b: ReaderSelection | null | undefined,
): boolean {
  return encodeReaderSelection(a) === encodeReaderSelection(b);
}
