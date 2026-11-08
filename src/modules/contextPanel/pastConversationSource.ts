/**
 * Data source for the "Add past conversation" picker and for the chips that
 * show an attached past chat.
 *
 * The picker lists chats of all three conversation systems for one library.
 * Pure merge, filter, and sort rules are exported so they can be unit tested.
 * The async loaders read the catalog and the search index.
 */
import type { ConversationCatalogEntry } from "../../core/conversations/repository";
import { pendingDeletionStore } from "../../core/conversations/pendingDeletionStore";
import type { ConversationSearchIndexMatch } from "../../shared/conversationSearchIndex";
import { isEphemeralConversationKey } from "../../shared/conversationKeySpace";
import type {
  AttachedConversationRef,
  ConversationSystem,
} from "../../shared/types";
import { normalizeAttachedConversationRefs } from "../../services/context/normalizers";
import { findPastConversationCatalogEntry } from "../../services/pastConversations/pastConversationLoader";
import {
  PAST_CONVERSATION_SYSTEMS,
  listPastConversationCatalog,
  searchPastConversationIndex,
} from "../../services/pastConversations/pastConversationSearch";
import { t } from "../../utils/i18n";
import {
  formatGlobalHistoryTimestamp,
  normalizeHistoryTitle,
  type ConversationHistoryEntry,
} from "./setupHandlers/controllers/conversationHistoryController";
import {
  buildHistorySearchResults,
  createHistorySearchDocument,
  normalizeHistorySearchQuery,
  type HistorySearchDocument,
  type HistorySearchResult,
} from "./setupHandlers/controllers/historySearchController";

export { PAST_CONVERSATION_SYSTEMS };

/** A picker row: the popup's entry plus the system the chat belongs to. */
export type PastConversationEntry = ConversationHistoryEntry & {
  system: ConversationSystem;
};

/** User-visible name of a conversation system. */
export function getPastConversationSystemLabel(
  system: ConversationSystem,
): string {
  if (system === "codex") return "Codex";
  if (system === "claude_code") return "Claude Code";
  return t("Chat");
}

export function isPastConversationEntry(
  entry: ConversationHistoryEntry | null | undefined,
): entry is PastConversationEntry {
  const system = (entry as { system?: unknown } | null | undefined)?.system;
  return (
    system === "upstream" || system === "claude_code" || system === "codex"
  );
}

type EntrySource = {
  system: ConversationSystem;
  kind: "paper" | "global";
  conversationID?: string;
  conversationKey: number;
  title?: string;
  lastActivityAt: number;
  userTurnCount: number;
  paperItemID?: number;
};

function toPastEntry(source: EntrySource): PastConversationEntry {
  const lastActivityAt = Number.isFinite(source.lastActivityAt)
    ? Math.max(0, Math.floor(source.lastActivityAt))
    : 0;
  const paperItemID =
    source.kind === "paper" &&
    Number.isFinite(source.paperItemID) &&
    (source.paperItemID as number) > 0
      ? Math.floor(source.paperItemID as number)
      : undefined;
  return {
    system: source.system,
    kind: source.kind,
    sourceState: "active",
    section: source.kind === "paper" ? "paper" : "open",
    sectionTitle: source.kind === "paper" ? "Paper chat" : "Library chat",
    conversationID: source.conversationID,
    conversationKey: source.conversationKey,
    title: normalizeHistoryTitle(source.title) || "Untitled chat",
    timestampText: formatGlobalHistoryTimestamp(lastActivityAt) || "",
    deletable: false,
    isDraft: false,
    isPendingDelete: false,
    lastActivityAt,
    userTurnCount: source.userTurnCount,
    paperItemID,
    catalogPaperItemID: paperItemID,
  };
}

export function catalogEntryToPastEntry(
  entry: ConversationCatalogEntry,
): PastConversationEntry {
  return toPastEntry({
    system: entry.system,
    kind: entry.kind,
    conversationID: entry.conversationID,
    conversationKey: entry.conversationKey,
    title: entry.title,
    lastActivityAt: entry.lastActivityAt || entry.createdAt || 0,
    userTurnCount: entry.userTurnCount,
    paperItemID: entry.paperItemID,
  });
}

export function indexMatchToPastEntry(
  match: ConversationSearchIndexMatch,
): PastConversationEntry {
  return toPastEntry({
    system: match.system,
    kind: match.kind,
    conversationID: match.conversationID,
    conversationKey: match.conversationKey,
    title: match.title,
    lastActivityAt: match.lastActivityAt,
    userTurnCount: match.userTurnCount,
    paperItemID: match.paperItemID,
  });
}

/**
 * Drops chats the picker must not offer: the current chat, chats without a
 * user turn, temporary side chats, and chats queued for deletion.
 * Keeps the first entry for a repeated system and key.
 */
export function filterPastConversationEntries(
  entries: readonly PastConversationEntry[],
  options: {
    excludeConversationKey?: number | null;
    isPendingDeletion?: (conversationKey: number) => boolean;
  } = {},
): PastConversationEntry[] {
  const out: PastConversationEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!(Number(entry.userTurnCount) > 0)) continue;
    if (entry.conversationKey === options.excludeConversationKey) continue;
    if (isEphemeralConversationKey(entry.conversationKey)) continue;
    if (options.isPendingDeletion?.(entry.conversationKey)) continue;
    const dedupeKey = `${entry.system}:${entry.conversationKey}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(entry);
  }
  return out;
}

/** Newest activity first; the larger conversation key breaks a tie. */
export function sortPastConversationEntries(
  entries: readonly PastConversationEntry[],
): PastConversationEntry[] {
  return [...entries].sort((a, b) => {
    if (b.lastActivityAt !== a.lastActivityAt) {
      return b.lastActivityAt - a.lastActivityAt;
    }
    return b.conversationKey - a.conversationKey;
  });
}

/**
 * Ranks merged search matches from several systems.
 * Order: number of query matches (most first), then newest activity.
 * This is the rule the history popup uses, so rows rank the same way here.
 * `bodyText` of each match is the text searched for the preview line.
 */
export function rankPastConversationMatches(
  matches: ReadonlyArray<{
    entry: PastConversationEntry;
    bodyText: string;
  }>,
  query: string,
): {
  entries: PastConversationEntry[];
  resultsByKey: Map<number, HistorySearchResult>;
} {
  const documents = new Map<number, HistorySearchDocument>();
  const entries: PastConversationEntry[] = [];
  for (const { entry, bodyText } of matches) {
    entries.push(entry);
    documents.set(
      entry.conversationKey,
      createHistorySearchDocument(entry, [{ text: bodyText }]),
    );
  }
  const results = buildHistorySearchResults(
    entries,
    normalizeHistorySearchQuery(query),
    documents,
  );
  const resultsByKey = new Map<number, HistorySearchResult>();
  for (const result of results) {
    resultsByKey.set(result.entry.conversationKey, result);
  }
  return {
    entries: results.map((result) => result.entry as PastConversationEntry),
    resultsByKey,
  };
}

/** Builds the reference stored with a message; it holds no chat text. */
export function buildAttachedConversationRef(
  entry: PastConversationEntry,
  libraryID: number,
): AttachedConversationRef | null {
  const refs = normalizeAttachedConversationRefs([
    {
      system: entry.system,
      conversationKey: entry.conversationKey,
      conversationID: entry.conversationID,
      title: entry.title,
      libraryID,
      kind: entry.kind,
      paperItemID: entry.paperItemID,
    },
  ]);
  return refs[0] || null;
}

const DEFAULT_LIST_LIMIT = 100;

const isPendingDeletion = (key: number) =>
  pendingDeletionStore.isConversationPendingDeletion(key);

/** Lists attachable past chats of all systems, newest first. */
export async function listPastConversationEntries(params: {
  libraryID: number;
  excludeConversationKey?: number | null;
  limit?: number;
}): Promise<PastConversationEntry[]> {
  const limit = params.limit ?? DEFAULT_LIST_LIMIT;
  const catalog = await listPastConversationCatalog({
    libraryID: params.libraryID,
    limit,
  });
  const entries = catalog
    .filter((entry) => entry.webchatSession !== true)
    .map(catalogEntryToPastEntry);
  return sortPastConversationEntries(
    filterPastConversationEntries(entries, {
      excludeConversationKey: params.excludeConversationKey,
      isPendingDeletion,
    }),
  ).slice(0, limit);
}

/** Searches the chat index of all systems; an empty query lists instead. */
export async function searchPastConversationEntries(params: {
  libraryID: number;
  query: string;
  excludeConversationKey?: number | null;
  limit?: number;
}): Promise<{
  entries: PastConversationEntry[];
  resultsByKey: Map<number, HistorySearchResult>;
}> {
  const limit = params.limit ?? DEFAULT_LIST_LIMIT;
  if (!params.query.trim()) {
    return {
      entries: await listPastConversationEntries(params),
      resultsByKey: new Map(),
    };
  }
  const matches = await searchPastConversationIndex({
    libraryID: params.libraryID,
    query: params.query,
    limit,
  });
  const candidates = matches.map((match) => ({
    entry: indexMatchToPastEntry(match),
    bodyText: match.bodyText,
  }));
  const allowed = new Set(
    filterPastConversationEntries(
      candidates.map((candidate) => candidate.entry),
      {
        excludeConversationKey: params.excludeConversationKey,
        isPendingDeletion,
      },
    ),
  );
  const ranked = rankPastConversationMatches(
    candidates.filter((candidate) => allowed.has(candidate.entry)),
    params.query,
  );
  const entries = ranked.entries.slice(0, limit);
  const keptKeys = new Set(entries.map((entry) => entry.conversationKey));
  return {
    entries,
    resultsByKey: new Map(
      Array.from(ranked.resultsByKey.entries()).filter(([key]) =>
        keptKeys.has(key),
      ),
    ),
  };
}

// ---------------------------------------------------------------------------
// Deleted-chat check for chips on sent messages.
// The message renderer is synchronous, so existence is looked up ahead of
// render and read back here. "Unknown" (never checked) renders as normal.
// ---------------------------------------------------------------------------

const existenceCache = new Map<string, boolean>();

function existenceKey(ref: AttachedConversationRef): string {
  return `${ref.system}:${ref.conversationKey}:${ref.conversationID || ""}`;
}

/** true when a check found the chat deleted; false when exists or unknown. */
export function isAttachedConversationDeleted(
  ref: AttachedConversationRef,
): boolean {
  return existenceCache.get(existenceKey(ref)) === false;
}

/** Chip text: title and system, or "Deleted chat" and system. */
export function formatAttachedConversationLabel(
  ref: AttachedConversationRef,
): string {
  const title = isAttachedConversationDeleted(ref)
    ? t("Deleted chat")
    : ref.title;
  return `${title} \u00B7 ${getPastConversationSystemLabel(ref.system)}`;
}

/** Seeds or clears the cache; for tests. */
export function setAttachedConversationExistenceForTests(
  ref: AttachedConversationRef | null,
  exists?: boolean,
): void {
  if (!ref) {
    existenceCache.clear();
    return;
  }
  existenceCache.set(existenceKey(ref), exists !== false);
}

/**
 * Looks up each ref in the catalog and stores the result.
 * A ref is deleted when the catalog has no row for its key, when the row has
 * another conversationID (the key was reused), or when deletion is queued.
 * Returns true when at least one ref changed to deleted.
 */
export async function refreshAttachedConversationExistence(
  refs: readonly AttachedConversationRef[],
): Promise<boolean> {
  const unique = new Map<string, AttachedConversationRef>();
  for (const ref of refs) unique.set(existenceKey(ref), ref);
  let flippedToDeleted = false;
  await Promise.all(
    Array.from(unique.entries()).map(async ([key, ref]) => {
      let exists: boolean;
      try {
        exists = Boolean(await findPastConversationCatalogEntry(ref));
      } catch {
        // Unreadable catalog: leave the state as it was.
        return;
      }
      const before = existenceCache.get(key);
      existenceCache.set(key, exists);
      if (!exists && before !== false) flippedToDeleted = true;
    }),
  );
  return flippedToDeleted;
}
