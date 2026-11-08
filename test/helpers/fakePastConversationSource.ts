import type {
  PastConversationCatalogEntry,
  PastConversationSource,
} from "../../src/services/pastConversations/pastConversationLoader";
import {
  matchesPastConversationFilters,
  type PastConversationCandidate,
} from "../../src/services/pastConversations/pastConversationSearch";
import type { ConversationSystem } from "../../src/shared/types";

export type FakePastChat = {
  system?: ConversationSystem;
  conversationKey: number;
  entry: Partial<PastConversationCatalogEntry> | null;
  messages: Array<Record<string, unknown>>;
};

/** An in-memory conversation store for past-chat tests. */
export function createFakePastConversationSource(
  chats: FakePastChat[],
  options: {
    pendingDeletion?: number[];
    paperTitles?: Record<number, string>;
    failLoads?: boolean;
  } = {},
): PastConversationSource & {
  loads: string[];
  /** Every searchChats and listChats call, in order. */
  searches: Array<Record<string, unknown>>;
  lists: Array<Record<string, unknown>>;
} {
  const find = (system: ConversationSystem, conversationKey: number) =>
    chats.find(
      (chat) =>
        (chat.system || "upstream") === system &&
        chat.conversationKey === conversationKey,
    );
  const loads: string[] = [];
  const entryOf = (chat: FakePastChat): PastConversationCatalogEntry => ({
    conversationID: `conv-${chat.conversationKey}`,
    libraryID: 1,
    kind: "global",
    lastActivityAt: Date.UTC(2026, 9, 1),
    createdAt: Date.UTC(2026, 8, 1),
    ...chat.entry,
  });
  // A chat as the search index holds it: title and every message's text.
  const candidates = (libraryID: number): PastConversationCandidate[] =>
    chats
      .filter((chat) => chat.entry && entryOf(chat).libraryID === libraryID)
      .map((chat) => {
        const entry = entryOf(chat);
        return {
          system: chat.system || "upstream",
          conversationKey: chat.conversationKey,
          conversationID: entry.conversationID,
          kind: entry.kind,
          libraryID: entry.libraryID,
          ...(entry.paperItemID ? { paperItemID: entry.paperItemID } : {}),
          title: entry.title || "",
          bodyText: chat.messages
            .map((row) => String(row.text || ""))
            .join("\n"),
          lastActivityAt: entry.lastActivityAt,
          userTurnCount: chat.messages.filter((row) => row.role === "user")
            .length,
          ...(entry.webchatSession ? { webchatSession: true } : {}),
        };
      });
  const searches: Array<Record<string, unknown>> = [];
  const lists: Array<Record<string, unknown>> = [];
  return {
    loads,
    searches,
    lists,
    async getCatalogEntry(target) {
      if (options.failLoads) throw new Error("database unavailable");
      const chat = find(target.system, target.conversationKey);
      if (!chat?.entry) return null;
      return entryOf(chat);
    },
    async searchChats(params) {
      if (options.failLoads) throw new Error("database unavailable");
      searches.push({ ...params });
      // The index's rule: the title or the text contains any of the words,
      // or every word with matchAllWords; filters in the read; newest first;
      // at most `limit` rows per system.
      const words = params.query.toLowerCase().split(/\s+/).filter(Boolean);
      const has = (candidate: PastConversationCandidate, word: string) =>
        candidate.title.toLowerCase().includes(word) ||
        candidate.bodyText.toLowerCase().includes(word);
      return newestPerSystem(
        candidates(params.libraryID).filter(
          (candidate) =>
            matchesPastConversationFilters(candidate, params) &&
            (params.matchAllWords
              ? words.every((word) => has(candidate, word))
              : words.some((word) => has(candidate, word))),
        ),
        params.limit,
      );
    },
    async listChats(params) {
      if (options.failLoads) throw new Error("database unavailable");
      lists.push({ ...params });
      return newestPerSystem(
        candidates(params.libraryID).filter((candidate) =>
          matchesPastConversationFilters(candidate, params),
        ),
        params.limit,
      );
    },
    async loadMessages(target) {
      loads.push(`${target.system}:${target.conversationKey}`);
      return find(target.system, target.conversationKey)?.messages || [];
    },
    isPendingDeletion(conversationKey) {
      return (options.pendingDeletion || []).includes(conversationKey);
    },
    resolvePaperTitle(paperItemID) {
      return options.paperTitles?.[paperItemID];
    },
  };
}

/** Alternating user / assistant rows, oldest first. */
export function pastChatRows(
  count: number,
  textFor: (n: number) => string = (n) => `text ${n}`,
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    text: textFor(index + 1),
    timestamp: 1_000 + index,
  }));
}

/** Newest first, at most `limit` per system, as the index and catalog read. */
function newestPerSystem(
  rows: PastConversationCandidate[],
  limit: number,
): PastConversationCandidate[] {
  const counts = new Map<string, number>();
  return [...rows]
    .sort(
      (left, right) =>
        right.lastActivityAt - left.lastActivityAt ||
        right.conversationKey - left.conversationKey,
    )
    .filter((row) => {
      const count = (counts.get(row.system) || 0) + 1;
      counts.set(row.system, count);
      return count <= limit;
    });
}
