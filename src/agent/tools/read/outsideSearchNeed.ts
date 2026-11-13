import type { AgentTraceDetail } from "../../types";

/**
 * Why an outside search (literature_search, web_search) is needed: the
 * turn's papers and the library cannot hold the need. The model states it
 * with every outside evidence search, and the progress view shows it on the
 * call's trace line. The value does not change what the search returns.
 */
export const OUTSIDE_SEARCH_NEEDS = [
  "not_in_scope_or_library",
  "current_or_public_facts",
  "user_named_outside_source",
] as const;

export type OutsideSearchNeed = (typeof OUTSIDE_SEARCH_NEEDS)[number];

/**
 * A host action (Discover related) searches on the user's explicit command.
 * literature_search validation accepts this value; the model schema never
 * lists it, and execution honors it only when the action executor built the
 * call (AgentToolContext.hostAction).
 */
export const HOST_ACTION_SEARCH_NEED = "host_action";

/** The model-visible definition of need and gap (schemas drop descriptions). */
export const OUTSIDE_SEARCH_NEED_SENTENCE =
  "Set need to why this search goes outside the turn's papers and library; not_in_scope_or_library also needs gap: what they lack";

/**
 * The last line of every outside evidence search result (literature_search
 * workflow:'answer', web_search) below the finish threshold
 * (outsideSearchLedger.ts): answer once the results cover the need, and
 * report an absence instead of searching on. It rides in the tool result,
 * so the cached prompt prefix is unchanged.
 */
export const OUTSIDE_SEARCH_STOP_NOTE =
  "If these results cover the need, stop searching and finish the request. Absence is also an answer: when two differently worded searches on the sources that index this field return no study that tests the claim, say so, name the searches, and give the closest studies as what was found. Search again only for one specific gap you can name.";

/**
 * A find-paper search (literature_search workflow:'review') states no
 * reason: neither need nor gap (user decision 1a, 2026-10-20). Its results
 * lead to the selection card, not to an answer. The description clause.
 */
export const REVIEW_SEARCH_NEED_CLAUSE = "workflow:'review' needs neither";

export const OUTSIDE_SEARCH_NEED_MESSAGE =
  "Add need: not_in_scope_or_library (with gap: what the turn's papers and library lack), current_or_public_facts, or user_named_outside_source.";

/**
 * The rejection for a find-paper search where the selection card cannot
 * open (a side chat, an MCP client): it is then a plain outside search.
 */
export const REVIEW_WITHOUT_CARD_NEED_MESSAGE = `The paper selection card is not available here, so workflow:'review' needs a reason too. ${OUTSIDE_SEARCH_NEED_MESSAGE}`;

export const OUTSIDE_SEARCH_GAP_MESSAGE =
  "need not_in_scope_or_library requires gap: what the turn's papers and library lack.";

export const OUTSIDE_SEARCH_NEED_PROPERTIES = {
  need: { type: "string", enum: [...OUTSIDE_SEARCH_NEEDS] },
  gap: { type: "string" },
} as const;

function readGap(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The rejection for a call's need and gap, or null when they are valid.
 * A find-paper search (workflow:'review') states neither (user decision 1a).
 * Only a tool that host actions call accepts host_action, and it checks the
 * caller before it searches.
 */
export function outsideSearchNeedError(
  args: Record<string, unknown>,
  options: { review?: boolean; acceptsHostAction?: boolean } = {},
): string | null {
  const need = args.need;
  if (options.review) return null;
  if (options.acceptsHostAction && need === HOST_ACTION_SEARCH_NEED)
    return null;
  if (!OUTSIDE_SEARCH_NEEDS.includes(need as OutsideSearchNeed)) {
    return OUTSIDE_SEARCH_NEED_MESSAGE;
  }
  if (need === "not_in_scope_or_library" && !readGap(args.gap)) {
    return OUTSIDE_SEARCH_GAP_MESSAGE;
  }
  return null;
}

const NEED_TRACE_TEXT: Record<OutsideSearchNeed, string> = {
  not_in_scope_or_library: "Not in this chat's papers or your library",
  current_or_public_facts: "Current or public facts",
  user_named_outside_source: "You named an outside source",
};

/** The progress view shows at most this many characters of a gap. */
const GAP_TRACE_MAX_CHARACTERS = 200;

function formatGapForTrace(gap: string): string {
  const flat = gap.replace(/\s+/g, " ");
  return flat.length > GAP_TRACE_MAX_CHARACTERS
    ? `${flat.slice(0, GAP_TRACE_MAX_CHARACTERS - 1).trimEnd()}…`
    : flat;
}

/** The "Why outside" row for a call's trace line, when the model gave one. */
export function buildOutsideSearchReasonDetail(
  args: unknown,
): AgentTraceDetail | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  const need = record.need as OutsideSearchNeed;
  if (!OUTSIDE_SEARCH_NEEDS.includes(need)) return null;
  const gap = readGap(record.gap);
  const text = NEED_TRACE_TEXT[need];
  return {
    label: "Why outside",
    value: gap ? `${text}: ${formatGapForTrace(gap)}` : text,
  };
}
