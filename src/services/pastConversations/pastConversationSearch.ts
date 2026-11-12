/**
 * Reads the chats of all three conversation systems of one library: the chat
 * search index (title and text) and the catalog.
 *
 * The "Add past conversation" picker (modules/contextPanel/
 * pastConversationSource.ts) and the agent's past_chat_search both search
 * through here, so they see the same chats.
 *
 * The index and the repository are imported lazily, as in
 * pastConversationLoader.ts: the stores reach the agent tool registry, which
 * imports this file through past_chat_search. Even a type import of them
 * would close that cycle, so their row types are inferred from the lazy
 * imports.
 */
import type { ConversationSystem } from "../../shared/types";

export const PAST_CONVERSATION_SYSTEMS: readonly ConversationSystem[] = [
  "upstream",
  "claude_code",
  "codex",
];

/** One chat as the agent's search reads it. */
export type PastConversationCandidate = {
  system: ConversationSystem;
  conversationKey: number;
  conversationID: string;
  kind: "paper" | "global";
  libraryID: number;
  paperItemID?: number;
  title: string;
  /** Indexed text of the chat (all roles, cut at the index's limit). */
  bodyText: string;
  lastActivityAt: number;
  userTurnCount: number;
  /** A web chat session row: never offered. */
  webchatSession?: boolean;
};

/** Filters the agent's search applies where the chats are read. */
export type PastConversationSearchFilters = {
  /** Only these systems (the mode filter); all three when absent. */
  systems?: readonly ConversationSystem[];
  /** Only paper chats of this Zotero item. */
  paperItemID?: number;
  /** Only chats whose last activity is at or after this time (ms). */
  minLastActivityAt?: number;
};

/**
 * The index result of each system for one library, with its status: the
 * matches, and whether the index was ready, empty, stale, truncated or
 * unavailable. An empty or stale index is refreshed once; a refresh that
 * finds the index unavailable keeps the first result. A system whose index
 * throws gives `result: null`, so a caller can fall back for that system.
 * `limit` is per system; without it the index's own limit applies.
 */
export async function searchPastConversationIndexBySystem(
  params: {
    libraryID: number;
    query: string;
    limit?: number;
    matchAllWords?: boolean;
  } & PastConversationSearchFilters,
) {
  const { searchConversationIndexWithStatus } =
    await import("../../shared/conversationSearchIndex");
  type IndexResult = Awaited<
    ReturnType<typeof searchConversationIndexWithStatus>
  >;
  const systems = params.systems || PAST_CONVERSATION_SYSTEMS;
  return await Promise.all(
    systems.map(
      async (
        system,
      ): Promise<{
        system: ConversationSystem;
        result: IndexResult | null;
      }> => {
        try {
          const request = {
            system,
            libraryID: params.libraryID,
            query: params.query,
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
            ...(params.matchAllWords ? { matchAllWords: true } : {}),
            ...(params.paperItemID ? { paperItemID: params.paperItemID } : {}),
            ...(params.minLastActivityAt
              ? { minLastActivityAt: params.minLastActivityAt }
              : {}),
          };
          let indexed = await searchConversationIndexWithStatus({
            ...request,
            refresh: false,
          });
          if (indexed.status === "empty" || indexed.status === "stale") {
            const refreshed = await searchConversationIndexWithStatus({
              ...request,
              refresh: true,
            });
            if (refreshed.status !== "unavailable") indexed = refreshed;
          }
          return { system, result: indexed };
        } catch {
          return { system, result: null };
        }
      },
    ),
  );
}

/**
 * Index matches of every system for one library: chats whose title or text
 * contains any of the query's words (or, with `matchAllWords`, every word),
 * newest first per system, at most `limit` per system, inside the filters.
 * An empty or stale index is refreshed once. A system whose index cannot be
 * read gives no matches. The index holds at most the first 200,000
 * characters of a chat: words after that cut are not found.
 */
export async function searchPastConversationIndex(
  params: {
    libraryID: number;
    query: string;
    limit: number;
    matchAllWords?: boolean;
  } & PastConversationSearchFilters,
) {
  const perSystem = await searchPastConversationIndexBySystem(params);
  return perSystem.flatMap(({ result }) => result?.matches || []);
}

/**
 * Catalog rows of every system for one library, at most `limit` per system.
 * A system whose catalog cannot be read gives no rows.
 */
export async function listPastConversationCatalog(params: {
  libraryID: number;
  limit: number;
  systems?: readonly ConversationSystem[];
}) {
  const { conversationRepository } =
    await import("../../core/conversations/repository");
  const perSystem = await Promise.all(
    (params.systems || PAST_CONVERSATION_SYSTEMS).map(async (system) => {
      try {
        return await conversationRepository.listAllCatalogEntries({
          system,
          libraryID: params.libraryID,
          limit: params.limit,
        });
      } catch {
        return [];
      }
    }),
  );
  return perSystem.flat();
}

type IndexMatch = Awaited<
  ReturnType<typeof searchPastConversationIndex>
>[number];
type CatalogRow = Awaited<
  ReturnType<typeof listPastConversationCatalog>
>[number];

export function indexMatchToPastConversationCandidate(
  match: IndexMatch,
): PastConversationCandidate {
  return {
    system: match.system,
    conversationKey: match.conversationKey,
    conversationID: match.conversationID,
    kind: match.kind,
    libraryID: match.libraryID,
    ...(match.paperItemID ? { paperItemID: match.paperItemID } : {}),
    title: match.title || "",
    bodyText: match.bodyText || "",
    lastActivityAt: match.lastActivityAt,
    userTurnCount: match.userTurnCount,
  };
}

export function catalogEntryToPastConversationCandidate(
  entry: CatalogRow,
): PastConversationCandidate {
  return {
    system: entry.system,
    conversationKey: entry.conversationKey,
    conversationID: entry.conversationID,
    kind: entry.kind,
    libraryID: entry.libraryID,
    ...(entry.paperItemID ? { paperItemID: entry.paperItemID } : {}),
    title: entry.title || "",
    bodyText: "",
    lastActivityAt: entry.lastActivityAt || entry.createdAt || 0,
    userTurnCount: entry.userTurnCount,
    ...(entry.webchatSession ? { webchatSession: true } : {}),
  };
}

/** True when a candidate is inside the filters. */
export function matchesPastConversationFilters(
  candidate: Pick<
    PastConversationCandidate,
    "system" | "kind" | "paperItemID" | "lastActivityAt"
  >,
  filters: PastConversationSearchFilters,
): boolean {
  if (filters.systems && !filters.systems.includes(candidate.system))
    return false;
  if (
    filters.paperItemID &&
    !(
      candidate.kind === "paper" &&
      candidate.paperItemID === filters.paperItemID
    )
  ) {
    return false;
  }
  if (
    filters.minLastActivityAt &&
    !(candidate.lastActivityAt >= filters.minLastActivityAt)
  ) {
    return false;
  }
  return true;
}
