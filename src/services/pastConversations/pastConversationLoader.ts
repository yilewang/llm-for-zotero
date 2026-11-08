/**
 * Loads attached past conversations and builds the past-chat message.
 *
 * Every read checks the catalog again: the chat must still exist, carry the
 * conversationID the reference saved (a reused key is another chat), belong
 * to the current library, and not be queued for deletion.
 *
 * The conversation repository is imported lazily: it imports the stores,
 * and the stores reach the agent tool registry, which imports this file
 * through past_chat_read. A static import would close that cycle.
 */
import type {
  AttachedConversationRef,
  ConversationSystem,
} from "../../shared/types";
import {
  PAST_CHAT_FULL_TEXT_MAX_TOKENS,
  buildPastChatMessage,
  resolvePastChatFullTextBudget,
  cleanPastConversationMessages,
  estimatePastConversationTokens,
  formatPastConversationFull,
  formatPastConversationOutline,
  formatPastConversationTrimmed,
  formatPastChatUnavailableSection,
  pastConversationId,
  pastConversationModeLabel,
  type PastConversationLoadResult,
} from "./pastConversationText";
import {
  catalogEntryToPastConversationCandidate,
  indexMatchToPastConversationCandidate,
  listPastConversationCatalog,
  matchesPastConversationFilters,
  searchPastConversationIndex,
  type PastConversationCandidate,
  type PastConversationSearchFilters,
} from "./pastConversationSearch";

/** Most stored messages read from one past chat (the newest ones). */
export const PAST_CHAT_LOAD_MESSAGE_LIMIT = 400;

/** The catalog facts a past chat is checked against. */
export type PastConversationCatalogEntry = {
  conversationID: string;
  libraryID: number;
  kind: "paper" | "global";
  title?: string;
  paperItemID?: number;
  lastActivityAt: number;
  createdAt: number;
  /** A web chat session row: never attached. */
  webchatSession?: boolean;
};

/** Where past chats are read from; tests pass a fake. */
export type PastConversationSource = {
  getCatalogEntry(target: {
    system: ConversationSystem;
    conversationKey: number;
    kind?: "paper" | "global";
  }): Promise<PastConversationCatalogEntry | null>;
  loadMessages(target: {
    system: ConversationSystem;
    conversationKey: number;
    limit?: number;
  }): Promise<ReadonlyArray<Record<string, unknown>>>;
  isPendingDeletion(conversationKey: number): boolean | Promise<boolean>;
  resolvePaperTitle?(paperItemID: number): string | undefined;
  /**
   * Chats of every system in one library whose title or text contains any of
   * the query's words, or every word with `matchAllWords`, inside the filters
   * (past_chat_search). At most `limit` per system, newest first.
   */
  searchChats?(
    params: {
      libraryID: number;
      query: string;
      limit: number;
      matchAllWords?: boolean;
    } & PastConversationSearchFilters,
  ): Promise<PastConversationCandidate[]>;
  /**
   * Chats of every system in one library inside the filters, at most `limit`
   * per system, newest first. No text (catalog rows).
   */
  listChats?(
    params: {
      libraryID: number;
      limit: number;
    } & PastConversationSearchFilters,
  ): Promise<PastConversationCandidate[]>;
};

function resolveZoteroPaperTitle(paperItemID: number): string | undefined {
  try {
    if (typeof Zotero === "undefined") return undefined;
    const item = Zotero.Items.get(paperItemID) as Zotero.Item | false | null;
    if (!item) return undefined;
    const title = String(item.getField?.("title") || "").trim();
    return title || undefined;
  } catch {
    return undefined;
  }
}

export const defaultPastConversationSource: PastConversationSource = {
  async getCatalogEntry(target) {
    const { conversationRepository } =
      await import("../../core/conversations/repository");
    return conversationRepository.getCatalogEntry(target);
  },
  async loadMessages(target) {
    const { conversationRepository } =
      await import("../../core/conversations/repository");
    return (await conversationRepository.loadMessages(target)) as ReadonlyArray<
      Record<string, unknown>
    >;
  },
  async isPendingDeletion(conversationKey) {
    const { pendingDeletionStore } =
      await import("../../core/conversations/pendingDeletionStore");
    return pendingDeletionStore.isConversationPendingDeletion(conversationKey);
  },
  resolvePaperTitle: resolveZoteroPaperTitle,
  async searchChats(params) {
    return (await searchPastConversationIndex(params)).map(
      indexMatchToPastConversationCandidate,
    );
  },
  async listChats(params) {
    return (await listPastConversationCatalog(params))
      .map(catalogEntryToPastConversationCandidate)
      .filter((candidate) => matchesPastConversationFilters(candidate, params));
  },
};

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isoDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  try {
    return new Date(timestamp).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

/**
 * The catalog row of an attached chat, or null when the chat is gone: queued
 * for deletion, no row for its key, or a row with another conversationID (the
 * key was reused). Throws when the catalog cannot be read. The library check
 * is the caller's.
 */
export async function findPastConversationCatalogEntry(
  ref: AttachedConversationRef,
  source: PastConversationSource = defaultPastConversationSource,
): Promise<PastConversationCatalogEntry | null> {
  if (await source.isPendingDeletion(ref.conversationKey)) return null;
  const entry = await source.getCatalogEntry({
    system: ref.system,
    conversationKey: ref.conversationKey,
    kind: ref.kind,
  });
  if (!entry) return null;
  if (ref.conversationID && entry.conversationID !== ref.conversationID) {
    return null;
  }
  return entry;
}

/**
 * Reads one attached past chat after checking it again in the catalog.
 * Never throws: a chat that cannot be read comes back with its reason.
 */
export async function loadPastConversation(
  ref: AttachedConversationRef,
  options: { libraryID: number | undefined; source?: PastConversationSource },
): Promise<PastConversationLoadResult> {
  const source = options.source || defaultPastConversationSource;
  const id = pastConversationId(ref);
  const unavailable = (
    status: "deleted" | "other_library" | "error",
    title = ref.title,
  ): PastConversationLoadResult => ({
    status,
    ref,
    id,
    title: singleLine(title) || `Conversation ${ref.conversationKey}`,
  });
  const libraryID = Math.floor(Number(options.libraryID));
  if (!(libraryID > 0) || ref.libraryID !== libraryID) {
    return unavailable("other_library");
  }
  try {
    const checked = await findPastConversationCatalogEntry(ref, source);
    if (!checked) return unavailable("deleted");
    const entry = checked;
    if (entry.libraryID !== libraryID) return unavailable("other_library");
    const title =
      singleLine(entry.title || "") ||
      singleLine(ref.title) ||
      `Conversation ${ref.conversationKey}`;
    const stored = await source.loadMessages({
      system: ref.system,
      conversationKey: ref.conversationKey,
      limit: PAST_CHAT_LOAD_MESSAGE_LIMIT,
    });
    const messages = cleanPastConversationMessages(stored);
    const paperItemID = entry.paperItemID || ref.paperItemID;
    const paperLabel =
      entry.kind === "paper"
        ? (paperItemID && source.resolvePaperTitle
            ? singleLine(source.resolvePaperTitle(paperItemID) || "")
            : "") || "Paper chat"
        : "Library chat";
    return {
      status: "ok",
      ref,
      id,
      title,
      modeLabel: pastConversationModeLabel(ref.system),
      date: isoDate(entry.lastActivityAt || entry.createdAt || 0),
      paperLabel,
      messages,
      tokenEstimate: estimatePastConversationTokens(messages),
    };
  } catch {
    return unavailable("error");
  }
}

export type PastChatRenderMode =
  /**
   * The built-in agent: a chat goes in full when it is at most 8,000 tokens
   * and the turn's full-text budget still has room; otherwise an outline.
   */
  | { kind: "agent"; fullTextBudgetTokens: number }
  /** Simple chat (no tools): each chat cut to its share of `totalMaxChars`. */
  | { kind: "trimmed"; totalMaxChars: number };

/** One section per chat, in the order given, for the past-chat message. */
export function renderPastChatSections(
  results: readonly PastConversationLoadResult[],
  mode: PastChatRenderMode,
): string[] {
  const loaded = results.length || 1;
  if (mode.kind === "trimmed") {
    const share = Math.floor(Math.max(0, mode.totalMaxChars) / loaded);
    return results.map((result) =>
      result.status === "ok"
        ? formatPastConversationTrimmed(result, share)
        : formatPastChatUnavailableSection(result, { readTool: false }),
    );
  }
  const budget = Math.max(0, Math.floor(mode.fullTextBudgetTokens));
  const outlineMaxTokens = Math.floor(budget / loaded);
  let used = 0;
  return results.map((result) => {
    if (result.status !== "ok")
      return formatPastChatUnavailableSection(result, { readTool: true });
    if (
      result.tokenEstimate <= PAST_CHAT_FULL_TEXT_MAX_TOKENS &&
      used + result.tokenEstimate <= budget
    ) {
      used += result.tokenEstimate;
      return formatPastConversationFull(result);
    }
    return formatPastConversationOutline(result, {
      maxTokens: outlineMaxTokens,
    });
  });
}

/**
 * The past-chat message for the chats one user message attached, or null
 * when it attached none. Rendered once; callers keep the text so later turns
 * send the same bytes.
 */
export async function buildPastChatMessageText(
  params: PastChatMessageParams,
): Promise<string | null> {
  return (await renderPastChatMessage(params)).text;
}

type PastChatMessageParams = {
  refs: readonly AttachedConversationRef[] | undefined;
  libraryID: number | undefined;
  mode: PastChatRenderMode;
  source?: PastConversationSource;
};

/**
 * The past-chat message, and whether a chat in it failed to load (a read or
 * database error). Such a message must not be remembered: the next build
 * tries the chat again.
 */
async function renderPastChatMessage(
  params: PastChatMessageParams,
): Promise<{ text: string | null; loadFailed: boolean }> {
  const refs = params.refs || [];
  if (!refs.length) return { text: null, loadFailed: false };
  const results = await Promise.all(
    refs.map((ref) =>
      loadPastConversation(ref, {
        libraryID: params.libraryID,
        source: params.source,
      }),
    ),
  );
  return {
    text: buildPastChatMessage(renderPastChatSections(results, params.mode)),
    loadFailed: results.some((result) => result.status === "error"),
  };
}

/**
 * Inserts a past-chat message before each source message that attached past
 * chats. `mapped[i]` is the model message built from `source[i]`; `build`
 * returns the message to insert, or null for none.
 */
export async function insertPastChatMessagesBeforeAttachingTurns<T>(
  source: ReadonlyArray<{
    role?: unknown;
    attachedConversations?: readonly AttachedConversationRef[];
  }>,
  mapped: readonly T[],
  build: (message: (typeof source)[number], index: number) => Promise<T | null>,
): Promise<T[]> {
  if (source.length !== mapped.length) return [...mapped];
  const inserts = await Promise.all(
    source.map((message, index) =>
      message.role === "user" && message.attachedConversations?.length
        ? build(message, index)
        : Promise.resolve(null),
    ),
  );
  const out: T[] = [];
  mapped.forEach((message, index) => {
    const insert = inserts[index];
    if (insert) out.push(insert);
    out.push(message);
  });
  return out;
}

const RENDER_MEMO_LIMIT = 256;
const renderMemo = new Map<string, string | null>();

/**
 * `buildPastChatMessageText` with an in-memory memo, so a message rebuilt for
 * a later turn sends the same bytes as before. `hostKey` names the host
 * conversation and the user message; the refs and the render mode are added
 * to the key here. A message in which a chat failed to load is not
 * remembered.
 */
export async function buildPastChatMessageTextMemoized(
  hostKey: string,
  params: PastChatMessageParams,
): Promise<string | null> {
  const mode =
    params.mode.kind === "agent"
      ? `agent:${params.mode.fullTextBudgetTokens}`
      : `trimmed:${params.mode.totalMaxChars}`;
  const refs = (params.refs || [])
    .map((ref) => `${pastConversationId(ref)}/${ref.conversationID || ""}`)
    .join(",");
  const memoKey = `${hostKey}|${params.libraryID}|${mode}|${refs}`;
  if (renderMemo.has(memoKey)) {
    // A hit refreshes the entry, so the memo drops the least recently used.
    const hit = renderMemo.get(memoKey) ?? null;
    renderMemo.delete(memoKey);
    renderMemo.set(memoKey, hit);
    return hit;
  }
  const { text, loadFailed } = await renderPastChatMessage(params);
  // A chat that failed to load is tried again next time, not remembered.
  if (loadFailed) return text;
  renderMemo.set(memoKey, text);
  while (renderMemo.size > RENDER_MEMO_LIMIT) {
    const oldest = renderMemo.keys().next().value;
    if (oldest === undefined) break;
    renderMemo.delete(oldest);
  }
  return text;
}

/**
 * Memo key of the agent's past-chat message for one user message, shared by
 * the attaching turn (agent runtime) and later history rebuilds (agent
 * engine), so a rebuild within the session sends the same bytes.
 */
export function agentPastChatMemoKey(
  conversationKey: number,
  userMessageTimestamp: number,
): string {
  return `agent:${conversationKey}:${userMessageTimestamp}`;
}

/**
 * The agent-mode past-chat message for the chats one user message delivers:
 * full text for a small chat while the turn's budget (min 12,000 tokens, 15%
 * of `contextWindowTokens`) has room, otherwise an outline opened with
 * past_chat_read. Memoized under agentPastChatMemoKey when the message has a
 * timestamp, so every caller that renders this message in this session sends
 * the same bytes: the built-in agent's attaching turn and history rebuilds,
 * and Claude Code's current-turn prefix and resume-fallback history.
 *
 * Path redaction is the caller's: it lives in the agent layer.
 */
export async function renderAgentPastChatMessageText(params: {
  conversationKey: number;
  /** Timestamp of the user message that delivers the chats. */
  userMessageTimestamp: unknown;
  refs: readonly AttachedConversationRef[] | undefined;
  libraryID: number | undefined;
  contextWindowTokens: number | undefined;
  source?: PastConversationSource;
}): Promise<string | null> {
  if (!params.refs?.length) return null;
  const renderParams: PastChatMessageParams = {
    refs: params.refs,
    libraryID: params.libraryID,
    mode: {
      kind: "agent",
      fullTextBudgetTokens: resolvePastChatFullTextBudget(
        params.contextWindowTokens,
      ),
    },
    source: params.source,
  };
  const timestamp = Number(params.userMessageTimestamp);
  return Number.isFinite(timestamp) && timestamp > 0
    ? buildPastChatMessageTextMemoized(
        agentPastChatMemoKey(params.conversationKey, timestamp),
        renderParams,
      )
    : buildPastChatMessageText(renderParams);
}

export function clearPastChatRenderMemoForTests(): void {
  renderMemo.clear();
}
