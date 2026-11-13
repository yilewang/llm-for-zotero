import type {
  AgentToolContext,
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../../types";
import type { ConversationSystem } from "../../../shared/types";
import { isEphemeralConversationKey } from "../../../shared/conversationKeySpace";
import { fail, ok } from "../shared";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import {
  PAST_CHAT_ATTACH_TOOL_NAME,
  PAST_CHAT_READ_TOOL_NAME,
  PAST_CHAT_SEARCH_TOOL_NAME,
  pastConversationId,
  pastConversationModeLabel,
  snippetAround,
} from "../../../services/pastConversations/pastConversationText";
import {
  defaultPastConversationSource,
  type PastConversationSource,
} from "../../../services/pastConversations/pastConversationLoader";
import type {
  PastConversationCandidate,
  PastConversationSearchFilters,
} from "../../../services/pastConversations/pastConversationSearch";
import {
  normalizeHistorySearchQuery,
  normalizeHistorySearchText,
  tokenizeHistorySearchQuery,
} from "../../../services/pastConversations/historySearchCore";

/**
 * past_chat_search: finds the user's earlier chats in this library by a few
 * words, so the agent can add one with past_chat_attach.
 *
 * It reads the chat search index of all three systems (title and text), or
 * the catalog when only filters are given, and lists any chat of the
 * conversation's library: never the current conversation (by system and key:
 * paper chats of different systems can share a key), a temporary side chat,
 * a web chat session, or a chat queued for deletion. The words are split and
 * lowercased as the history search does (historySearchCore.ts), so the same
 * query finds the same chats as the picker. Snippets are short; the full text
 * is read only after an attach.
 *
 * The full matches come from their own index read that requires every word
 * (AND), with the filters applied in the read itself, so a common word or a
 * busy library cannot push an older full match out of the rows read. A
 * second read (any word, OR) adds the partial matches. Each read stops at a
 * limit per system (CANDIDATE_LIMIT_PER_SYSTEM; the catalog read for filters
 * only at CATALOG_LIMIT_PER_SYSTEM); `candidateCount` counts what was read
 * and `more` says a read hit its limit. A full-match read that hits its limit
 * is never "clear". The index holds the first 200,000 characters of a chat:
 * words after that cut are not counted.
 *
 * The code, not the model, labels the result (`match`):
 * - none: no chat contains any of the words (with filters only: no chat
 *   passes the filters);
 * - clear: exactly one chat contains every word, and the query has two or
 *   more words or a filter narrows it (with filters only: exactly one chat);
 * - several: everything else.
 * The result's `hint` says what to do next for that label.
 *
 * Read-only: the scope (attachedConversationScope) does not change.
 */

type PastChatMode = "chat" | "codex" | "claude_code";

type PastChatSearchInput = {
  query?: string;
  paperItemId?: number;
  withinDays?: number;
  mode?: PastChatMode;
};

/** Longest query, in characters. */
const MAX_QUERY_CHARS = 200;
const MAX_WITHIN_DAYS = 3_650;
/** Most chats one call returns. */
const MAX_RESULTS = 5;
/**
 * Most index rows read per system and read. Index rows carry the chat's
 * text (up to 200,000 characters), so this stays small.
 */
const CANDIDATE_LIMIT_PER_SYSTEM = 100;
/** Most catalog rows read per system for a filter-only search (no text). */
const CATALOG_LIMIT_PER_SYSTEM = 5_000;
/** Length of a result's snippet, in characters. */
const SNIPPET_CHARS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

const MODE_SYSTEMS: Record<PastChatMode, ConversationSystem> = {
  chat: "upstream",
  codex: "codex",
  claude_code: "claude_code",
};

const NO_LIBRARY = "This conversation has no library to search.";
const UNAVAILABLE = "Past chats cannot be searched right now.";

function validatePastChatSearchInput(
  args: unknown,
): AgentToolInputValidation<PastChatSearchInput> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return fail(`${PAST_CHAT_SEARCH_TOOL_NAME} expects an object input`);
  }
  const record = args as Record<string, unknown>;
  let query: string | undefined;
  if (record.query !== undefined) {
    query = typeof record.query === "string" ? record.query.trim() : "";
    if (!query || query.length > MAX_QUERY_CHARS) {
      return fail(`query must be a text of 1 to ${MAX_QUERY_CHARS} characters`);
    }
  }
  if (
    record.paperItemId !== undefined &&
    (!Number.isSafeInteger(record.paperItemId) ||
      Number(record.paperItemId) < 1)
  ) {
    return fail("paperItemId must be a Zotero item id");
  }
  if (
    record.withinDays !== undefined &&
    (!Number.isSafeInteger(record.withinDays) ||
      Number(record.withinDays) < 1 ||
      Number(record.withinDays) > MAX_WITHIN_DAYS)
  ) {
    return fail(`withinDays must be a whole number of 1 to ${MAX_WITHIN_DAYS}`);
  }
  if (
    record.mode !== undefined &&
    !(
      typeof record.mode === "string" &&
      Object.prototype.hasOwnProperty.call(MODE_SYSTEMS, record.mode)
    )
  ) {
    return fail("mode must be chat, codex or claude_code");
  }
  const input: PastChatSearchInput = {
    ...(query && searchTerms(query).length ? { query } : {}),
    ...(record.paperItemId !== undefined
      ? { paperItemId: Number(record.paperItemId) }
      : {}),
    ...(record.withinDays !== undefined
      ? { withinDays: Number(record.withinDays) }
      : {}),
    ...(record.mode !== undefined ? { mode: record.mode as PastChatMode } : {}),
  };
  if (!input.query && !hasFilter(input)) {
    return fail(
      "Give query (a few distinctive words), or paperItemId, withinDays or mode",
    );
  }
  return ok(input);
}

/** The query's terms, split and lowercased as the history search does. */
function searchTerms(query: string | undefined): string[] {
  return tokenizeHistorySearchQuery(normalizeHistorySearchQuery(query || ""));
}

function hasFilter(input: PastChatSearchInput): boolean {
  return (
    input.paperItemId !== undefined ||
    input.withinDays !== undefined ||
    input.mode !== undefined
  );
}

function isoDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  try {
    return new Date(timestamp).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

type ScoredCandidate = {
  candidate: PastConversationCandidate;
  termsMatched: number;
  /** Normalized body text and the first matched term's position in it. */
  body: string;
  bodyPosition: number;
};

function scoreCandidate(
  candidate: PastConversationCandidate,
  terms: readonly string[],
): ScoredCandidate {
  // Lowercased as the query's terms are (normalizeHistorySearchQuery).
  const title = normalizeHistorySearchText(candidate.title).toLocaleLowerCase();
  const text = normalizeHistorySearchText(candidate.bodyText);
  const lowerText = text.toLocaleLowerCase();
  let termsMatched = 0;
  let bodyPosition = -1;
  for (const term of terms) {
    const at = lowerText.indexOf(term);
    if (at >= 0 && (bodyPosition < 0 || at < bodyPosition)) bodyPosition = at;
    if (at >= 0 || title.includes(term)) termsMatched += 1;
  }
  // The position belongs to the lowercased text. Lowercasing keeps the length
  // for almost all text, and then the snippet is cut from the original; when
  // it does not (a few letters such as "İ"), the snippet is cut from the
  // lowercased text, so it is centred on the word.
  const body = lowerText.length === text.length ? text : lowerText;
  return { candidate, termsMatched, body, bodyPosition };
}

/**
 * The chats the search may list: this library, not the current conversation
 * (system and key), not temporary, not a web chat, with a user turn, not
 * queued for deletion, and inside the filters. One entry per system and key.
 */
async function filterCandidates(
  candidates: readonly PastConversationCandidate[],
  params: {
    input: PastChatSearchInput;
    libraryID: number;
    current: { system: ConversationSystem; conversationKey: number };
    source: PastConversationSource;
    now: number;
  },
): Promise<PastConversationCandidate[]> {
  const { input, current } = params;
  const modeSystem = input.mode ? MODE_SYSTEMS[input.mode] : undefined;
  const since = input.withinDays
    ? params.now - input.withinDays * DAY_MS
    : undefined;
  const seen = new Set<string>();
  const out: PastConversationCandidate[] = [];
  for (const candidate of candidates) {
    const id = pastConversationId(candidate);
    if (seen.has(id)) continue;
    if (candidate.libraryID !== params.libraryID) continue;
    if (
      candidate.system === current.system &&
      candidate.conversationKey === current.conversationKey
    ) {
      continue;
    }
    if (isEphemeralConversationKey(candidate.conversationKey)) continue;
    if (candidate.webchatSession) continue;
    if (!(Number(candidate.userTurnCount) > 0)) continue;
    if (modeSystem && candidate.system !== modeSystem) continue;
    if (
      input.paperItemId !== undefined &&
      !(
        candidate.kind === "paper" &&
        candidate.paperItemID === input.paperItemId
      )
    ) {
      continue;
    }
    if (since !== undefined && !(candidate.lastActivityAt >= since)) continue;
    // The deletion queue is keyed by conversation key only (the picker uses
    // the same check). The key ranges of the three systems do not overlap,
    // so this hides no other system's chat.
    if (await params.source.isPendingDeletion(candidate.conversationKey))
      continue;
    seen.add(id);
    out.push(candidate);
  }
  return out;
}

type MatchLabel = "clear" | "several" | "none";

/** True when some system gave `limit` rows or more: the read was cut. */
function hitsLimit(
  rows: readonly PastConversationCandidate[],
  limit: number,
): boolean {
  const perSystem = new Map<string, number>();
  for (const row of rows) {
    const count = (perSystem.get(row.system) || 0) + 1;
    if (count >= limit) return true;
    perSystem.set(row.system, count);
  }
  return false;
}

function buildHint(params: {
  match: MatchLabel;
  first?: { id: string; alreadyAttached: boolean };
  terms: readonly string[];
  fullMatches: number;
  oneWordOnly: boolean;
}): string {
  if (params.match === "none") {
    return "No earlier chat matched. Tell the user, and suggest / → Add past conversation to pick one.";
  }
  if (params.match === "clear" && params.first) {
    return params.first.alreadyAttached
      ? `One chat matches and it is already attached: open it with ${PAST_CHAT_READ_TOOL_NAME} (chat "${params.first.id}").`
      : `One chat matches: call ${PAST_CHAT_ATTACH_TOOL_NAME} with chat "${params.first.id}" now, without asking the user.`;
  }
  if (params.oneWordOnly) {
    return `Only one chat contains "${params.terms[0]}", but one word is not enough to be sure. Confirm with the user before you call ${PAST_CHAT_ATTACH_TOOL_NAME}.`;
  }
  const lead =
    params.terms.length && !params.fullMatches
      ? "No chat contains every word; these contain some."
      : "Several chats match.";
  return `${lead} Ask the user which one they mean (with request_user_input, or in your answer when it is not available), listing each title and date. Do not call ${PAST_CHAT_ATTACH_TOOL_NAME} until the user picks.`;
}

async function executePastChatSearch(
  input: PastChatSearchInput,
  context: AgentToolContext,
  source: PastConversationSource,
  now: () => number,
): Promise<unknown> {
  const request = context.request;
  const libraryID = Math.floor(Number(request.libraryID));
  if (!(libraryID > 0)) return { ok: false, error: NO_LIBRARY };
  if (!source.searchChats || !source.listChats) {
    return { ok: false, error: UNAVAILABLE };
  }
  const terms = searchTerms(input.query);
  const nowMs = now();
  const filters: PastConversationSearchFilters = {
    ...(input.mode ? { systems: [MODE_SYSTEMS[input.mode]] } : {}),
    ...(input.paperItemId ? { paperItemID: input.paperItemId } : {}),
    ...(input.withinDays
      ? { minLastActivityAt: nowMs - input.withinDays * DAY_MS }
      : {}),
  };
  let candidates: PastConversationCandidate[];
  // A full-match read that hit its limit: more full matches may exist.
  let fullReadCapped = false;
  let more = false;
  try {
    let read: PastConversationCandidate[];
    if (terms.length) {
      const full = await source.searchChats({
        libraryID,
        query: input.query || "",
        limit: CANDIDATE_LIMIT_PER_SYSTEM,
        matchAllWords: true,
        ...filters,
      });
      fullReadCapped = hitsLimit(full, CANDIDATE_LIMIT_PER_SYSTEM);
      // With one word every match is a full match.
      const partial =
        terms.length > 1
          ? await source.searchChats({
              libraryID,
              query: input.query || "",
              limit: CANDIDATE_LIMIT_PER_SYSTEM,
              ...filters,
            })
          : [];
      more = fullReadCapped || hitsLimit(partial, CANDIDATE_LIMIT_PER_SYSTEM);
      read = [...full, ...partial];
    } else {
      read = await source.listChats({
        libraryID,
        limit: CATALOG_LIMIT_PER_SYSTEM,
        ...filters,
      });
      fullReadCapped = hitsLimit(read, CATALOG_LIMIT_PER_SYSTEM);
      more = fullReadCapped;
    }
    candidates = await filterCandidates(read, {
      input,
      libraryID,
      current: {
        system: context.conversationSystem || "upstream",
        conversationKey: Math.floor(Number(request.conversationKey)),
      },
      source,
      now: nowMs,
    });
  } catch {
    return { ok: false, error: UNAVAILABLE };
  }
  const scored = candidates
    .map((candidate) => scoreCandidate(candidate, terms))
    .filter((entry) => !terms.length || entry.termsMatched > 0)
    .sort(
      (left, right) =>
        Number(right.termsMatched === terms.length) -
          Number(left.termsMatched === terms.length) ||
        right.termsMatched - left.termsMatched ||
        right.candidate.lastActivityAt - left.candidate.lastActivityAt ||
        right.candidate.conversationKey - left.candidate.conversationKey,
    );
  const fullMatches = terms.length
    ? scored.filter((entry) => entry.termsMatched === terms.length).length
    : scored.length;
  const narrowed = terms.length >= 2 || hasFilter(input);
  const match: MatchLabel = !scored.length
    ? "none"
    : fullMatches === 1 && narrowed && !fullReadCapped
      ? "clear"
      : "several";
  const scope = request.attachedConversationScope || [];
  const attachedIds = new Set(scope.map((ref) => pastConversationId(ref)));
  const chats = scored.slice(0, MAX_RESULTS).map((entry) => {
    const { candidate } = entry;
    const id = pastConversationId(candidate);
    const paper =
      candidate.kind === "paper" && candidate.paperItemID
        ? source.resolvePaperTitle?.(candidate.paperItemID)
        : undefined;
    const snippet = !terms.length
      ? undefined
      : entry.bodyPosition >= 0
        ? snippetAround(entry.body, entry.bodyPosition, SNIPPET_CHARS)
        : normalizeHistorySearchText(candidate.title) || undefined;
    return {
      chat: id,
      title:
        normalizeHistorySearchText(candidate.title) ||
        `Conversation ${candidate.conversationKey}`,
      mode: pastConversationModeLabel(candidate.system),
      ...(paper ? { paper } : {}),
      lastActive: isoDate(candidate.lastActivityAt) || undefined,
      questions: candidate.userTurnCount,
      ...(terms.length ? { termsMatched: entry.termsMatched } : {}),
      ...(snippet ? { snippet } : {}),
      alreadyAttached: attachedIds.has(id),
    };
  });
  return {
    ok: true,
    ...(input.query ? { query: input.query } : {}),
    match,
    candidateCount: scored.length,
    ...(more ? { more: true } : {}),
    chats,
    hint: buildHint({
      match,
      first: chats[0]
        ? { id: chats[0].chat, alreadyAttached: chats[0].alreadyAttached }
        : undefined,
      terms,
      fullMatches,
      oneWordOnly:
        terms.length === 1 &&
        fullMatches === 1 &&
        !hasFilter(input) &&
        !fullReadCapped,
    }),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createPastChatSearchTool(
  source: PastConversationSource = defaultPastConversationSource,
  options: { now?: () => number } = {},
): AgentToolDefinition<PastChatSearchInput, unknown> {
  const now = options.now || (() => Date.now());
  return {
    spec: {
      name: PAST_CHAT_SEARCH_TOOL_NAME,
      description:
        "Find the user's earlier chats in this library by distinctive words, plus paperItemId, withinDays or mode when named. Use it for an earlier chat that is not attached; follow the result's hint.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: MAX_QUERY_CHARS,
            description: "A few distinctive words from the chat.",
          },
          paperItemId: {
            type: "integer",
            minimum: 1,
            description: "Only chats about this Zotero item.",
          },
          withinDays: {
            type: "integer",
            minimum: 1,
            maximum: MAX_WITHIN_DAYS,
            description: "Only chats active in the last N days.",
          },
          mode: {
            type: "string",
            enum: ["chat", "codex", "claude_code"],
            description: "Only chats of this mode.",
          },
        },
      },
      executionClass: "read",
      workCategory: "retrieval",
    },
    validate: validatePastChatSearchInput,
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        effects: ["read"],
        reason: "Search the user's earlier chats in this library.",
      }),
    execute: (input, context) =>
      executePastChatSearch(input, context, source, now),
    presentation: {
      label: "Search Past Chats",
      summaries: {
        onCall: "Searching past chats",
        onSuccess: ({ content }) => {
          const result = record(content);
          if (result.ok !== true) return "Could not search past chats";
          const count = Number(result.candidateCount) || 0;
          return `Searched past chats, ${count} ${
            count === 1 ? "match" : "matches"
          }`;
        },
      },
    },
  };
}
