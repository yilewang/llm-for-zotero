/**
 * Pure helpers for the search-routing live suite
 * (searchRouting.live.workflow.test.ts): which evidence rung a tool call
 * belongs to, the per-rep routing summary, and the summary table. No Zotero
 * access here, so the rules can be read and checked on their own.
 */

/**
 * The evidence ladder's rungs, as tool families:
 * - local: the turn's papers and the user's library
 * - scholarly: outside scholarly search
 * - web: outside web search and page reads
 * - card: the paper selection (import) card
 * - shell: shell commands (for example curl to a literature API); not a rung,
 *   counted because outside sources must not be read this way
 * - other: everything else (skills, task updates, writes)
 */
export type ToolFamily =
  | "local"
  | "scholarly"
  | "web"
  | "card"
  | "shell"
  | "other";

const FAMILY_BY_TOOL: Record<string, ToolFamily> = {
  paper_read: "local",
  library_retrieve: "local",
  library_search: "local",
  library_read: "local",
  context_read: "local",
  // Reads an attachment of the turn's papers; the same rung as paper_read.
  read_attachment: "local",
  literature_search: "scholarly",
  // Reads one outside paper found by literature_search.
  literature_read: "scholarly",
  web_search: "web",
  web_read: "web",
  literature_review: "card",
  // The plugin registry's only shell tool.
  run_command: "shell",
};

export function classifyTool(name: string): ToolFamily {
  return FAMILY_BY_TOOL[name] || "other";
}

export function isOutsideFamily(family: ToolFamily): boolean {
  return family === "scholarly" || family === "web";
}

export type RoutingCall = {
  name: string;
  family: ToolFamily;
  /** One-based model round the call was made in (agent requests so far). */
  round: number;
  args: unknown;
  ok?: boolean;
  error?: string;
  startedMs: number;
  /** Results in the tool result, when it carried a results list. */
  resultCount?: number;
  /** The provider's message in the result (for example a failed source). */
  providerMessage?: string;
  /** The provider's warnings in the result. */
  warnings?: string[];
  /** The result's nextStep carried the finish-now note (K >= 6). */
  nudgeFired?: boolean;
  /** The call failed with a turn latch message (see latchOf). */
  latch?: OutsideLatch;
  /**
   * Set by summarizeRoutingRep: the call was refused by a latch an earlier
   * call set, so it reached no provider.
   */
  latchRejection?: boolean;
};

/**
 * Fragments of the host's model-visible texts (outsideSearchLedger.ts).
 * Kept literal here so a wording change shows up as a suite change.
 */
export const NUDGE_MARKER =
  "Finish the request now with what these searches found";
const LATCH_MARKERS: Array<[OutsideLatch, string]> = [
  ["openalex", "OpenAlex is rate-limited for the rest of this turn"],
  ["web", "Web search is unavailable for the rest of this turn"],
];
const VALIDATION_PREFIX = "Invalid tool input";

export type OutsideLatch = "openalex" | "web";

/** The latch a tool error names, if any. */
export function latchOf(
  error: string | undefined,
  providerMessage?: string,
): OutsideLatch | undefined {
  const text = error || providerMessage;
  if (!text) return undefined;
  return LATCH_MARKERS.find(([, marker]) => text.includes(marker))?.[0];
}

/** What a tool result shows: result count, provider notes, the nudge. */
export function observeToolResult(
  content: unknown,
): Pick<
  RoutingCall,
  "resultCount" | "providerMessage" | "warnings" | "nudgeFired"
> {
  if (!content || typeof content !== "object" || Array.isArray(content))
    return {};
  const record = content as Record<string, unknown>;
  const observed: Pick<
    RoutingCall,
    "resultCount" | "providerMessage" | "warnings" | "nudgeFired"
  > = {};
  if (Array.isArray(record.results))
    observed.resultCount = record.results.length;
  if (typeof record.message === "string" && record.message.trim())
    observed.providerMessage = record.message.slice(0, 300);
  if (Array.isArray(record.warnings) && record.warnings.length)
    observed.warnings = record.warnings.map((warning) =>
      String(warning).slice(0, 300),
    );
  if (typeof record.nextStep === "string")
    observed.nudgeFired = record.nextStep.includes(NUDGE_MARKER);
  return observed;
}

/**
 * Approximate: whether an answer says a search found no study. A plain
 * regex over English phrasings ("no other studies", "did not find",
 * "found no", "not found", "none of the searches"); it misses other
 * wordings and other languages, and can fire on an unrelated negation.
 */
const ABSENCE_PATTERNS = [
  /\bno (?:other |further |additional |published |independent |direct |prior |later )*(?:stud(?:y|ies)|papers?|replications?|evidence)\b/i,
  /\b(?:did not|didn't|could not|couldn't|was unable to|were unable to) (?:find|identify|locate)\b/i,
  /\bfound no\b/i,
  /\bnot found\b/i,
  /\bnone of the (?:searches|results)\b/i,
];

export function statesAbsence(answer: string): boolean {
  return ABSENCE_PATTERNS.some((pattern) => pattern.test(answer));
}

/** Lowercase, with runs of whitespace and emphasis marks made one space. */
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Approximate: whether the answer names one of the given paper titles. A
 * title matches when its first 40 normalized characters appear in the
 * answer; a paraphrased or translated title is missed.
 */
export function namesAnyTitle(answer: string, titles: string[]): boolean {
  const text = normalizeForMatch(answer);
  return titles.some((title) => {
    const head = normalizeForMatch(title).slice(0, 40);
    return head.length > 0 && text.includes(head);
  });
}

/**
 * Approximate: whether the answer offers to search outside the library. One
 * sentence must hold an offer ("would you like", "do you want", "I can",
 * "let me know if", "shall I", "want me to"), a search verb (search, look,
 * find) and an outside or more-papers word (outside, beyond, external,
 * online, web, scholarly, OpenAlex, databases, more, further, additional,
 * new, other). English only; it misses other wordings and can fire on an
 * offer that is not about outside sources.
 */
const OFFER_PATTERN =
  /\b(?:would you like|do you want|want me to|shall i|should i|i can|i could|let me know if|if you(?:'d| would)? like|if you want)\b/i;
const SEARCH_VERB_PATTERN = /\b(?:search|look|find)\w*/i;
const OUTSIDE_WORD_PATTERN =
  /\b(?:outside|beyond|external|online|web|scholarly|openalex|databases?|more|further|additional|new|other)\b/i;

export function offersOutsideSearch(answer: string): boolean {
  return answer
    .split(/(?<=[.?!\u3002\uff1f\uff01])\s*|\n+/)
    .some(
      (sentence) =>
        OFFER_PATTERN.test(sentence) &&
        SEARCH_VERB_PATTERN.test(sentence) &&
        OUTSIDE_WORD_PATTERN.test(sentence),
    );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Approximate: outside search calls of one family that reached a provider (the ledger's K); a call that failed before its provider for another reason still counts. */
function reachedProvider(call: RoutingCall): boolean {
  if (call.error?.startsWith(VALIDATION_PREFIX)) return false;
  if (call.latchRejection) return false;
  if (call.name === "literature_search")
    return record(call.args).mode !== "metadata";
  return call.name === "web_search";
}

export type RoutingCard = {
  toolName: string;
  title: string;
  rows: number;
  resolvedAs: string;
};

export type RoutingRepSummary = {
  toolSequence: string;
  families: ToolFamily[];
  familyCounts: Record<ToolFamily, number>;
  outsideCalls: number;
  localCalls: number;
  /** Shell commands run in the rep (run_command). */
  shellCalls: number;
  literatureReviewCalls: number;
  confirmations: number;
  firstLocalRound: number | null;
  firstOutsideRound: number | null;
  /**
   * Whether a local (rung 1 or 2) call came before, or in the same round
   * as, the first outside call. null when the rep made no outside call.
   */
  localBeforeOutside: boolean | null;
  /**
   * Whether a local call came in an earlier round than the first outside
   * call, so its results were in before the model chose to go outside (a
   * same-round call does not count). null when the rep made no outside call.
   */
  localResultBeforeOutside: boolean | null;
  /** Approximate: Outside searches that reached a provider, per family (the ledger's K). */
  outsideSearchesScholarly: number;
  outsideSearchesWeb: number;
  /** A result carried the finish-now note; outside calls made after it. */
  nudgeFired: boolean;
  callsAfterNudge: number;
  /** A latch was set; outside calls after it, and how many it refused. */
  latchFired: OutsideLatch[];
  callsAfterLatch: number;
  latchRejections: number;
  /** literature_search calls with workflow:'review' (find or recommend). */
  reviewWorkflowCalls: number;
};

/** One rep's routing facts, from its ordered tool calls and cards. */
export function summarizeRoutingRep(
  calls: RoutingCall[],
  cards: RoutingCard[],
): RoutingRepSummary {
  const familyCounts: Record<ToolFamily, number> = {
    local: 0,
    scholarly: 0,
    web: 0,
    card: 0,
    shell: 0,
    other: 0,
  };
  for (const call of calls) familyCounts[call.family] += 1;
  // The first call that names a latch set it (it reached the provider);
  // later calls naming the same latch were refused without one. Calls in
  // the same round may both have reached the provider; this counts the
  // later one as refused.
  const latched = new Set<OutsideLatch>();
  let firstLatchIndex = -1;
  calls.forEach((call, index) => {
    call.latch = latchOf(call.error, call.providerMessage);
    if (!call.latch) return;
    if (latched.has(call.latch)) call.latchRejection = true;
    else {
      latched.add(call.latch);
      if (firstLatchIndex < 0) firstLatchIndex = index;
    }
  });
  const firstNudgeIndex = calls.findIndex((call) => call.nudgeFired);
  const outsideAfter = (index: number) =>
    index < 0
      ? 0
      : calls.slice(index + 1).filter((call) => isOutsideFamily(call.family))
          .length;
  const firstLocal = calls.find((call) => call.family === "local");
  const firstOutside = calls.find((call) => isOutsideFamily(call.family));
  const firstLocalRound = firstLocal ? firstLocal.round : null;
  const firstOutsideRound = firstOutside ? firstOutside.round : null;
  return {
    toolSequence: calls.map((call) => call.name).join(" → "),
    families: (Object.keys(familyCounts) as ToolFamily[]).filter(
      (family) => familyCounts[family] > 0,
    ),
    familyCounts,
    outsideCalls: familyCounts.scholarly + familyCounts.web,
    localCalls: familyCounts.local,
    shellCalls: familyCounts.shell,
    literatureReviewCalls: calls.filter(
      (call) => call.name === "literature_review",
    ).length,
    confirmations: cards.length,
    firstLocalRound,
    firstOutsideRound,
    localBeforeOutside:
      firstOutsideRound === null
        ? null
        : firstLocalRound !== null && firstLocalRound <= firstOutsideRound,
    localResultBeforeOutside:
      firstOutsideRound === null
        ? null
        : firstLocalRound !== null && firstLocalRound < firstOutsideRound,
    outsideSearchesScholarly: calls.filter(
      (call) => call.family === "scholarly" && reachedProvider(call),
    ).length,
    outsideSearchesWeb: calls.filter(
      (call) => call.family === "web" && reachedProvider(call),
    ).length,
    nudgeFired: firstNudgeIndex >= 0,
    callsAfterNudge: outsideAfter(firstNudgeIndex),
    latchFired: [...latched],
    callsAfterLatch: outsideAfter(firstLatchIndex),
    latchRejections: calls.filter((call) => call.latchRejection).length,
    reviewWorkflowCalls: calls.filter(
      (call) =>
        call.name === "literature_search" &&
        record(call.args).workflow === "review",
    ).length,
  };
}

/** Key-shaped strings removed from anything written to a report. */
export function redactSecrets<T>(value: T): T {
  if (typeof value === "string")
    return value
      .replace(/\bsk-[\w*-]{6,}/g, "[key]")
      .replace(/\btvly-[\w-]{6,}/g, "[key]")
      .replace(/\bAIza[\w-]{10,}/g, "[key]")
      .replace(/\bBearer\s+[\w.-]{8,}/gi, "Bearer [key]") as T;
  if (Array.isArray(value)) return value.map(redactSecrets) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = /api[-_]?key|authorization|secret|token$/i.test(key)
        ? "[redacted]"
        : redactSecrets(entry);
    }
    return out as T;
  }
  return value;
}

export type SummaryRow = {
  caseId: string;
  rep: number | string;
  status: string;
  wallSeconds?: number;
  rounds?: number;
  local?: number;
  scholarly?: number;
  web?: number;
  shell?: number;
  card?: number;
  confirmations?: number;
  localBeforeOutside?: boolean | null;
  /** A local call in an earlier round than the first outside call. */
  localResultBeforeOutside?: boolean | null;
  /** Outside searches that reached a provider: scholarly and web. */
  searchesScholarly?: number;
  searchesWeb?: number;
  nudgeFired?: boolean;
  callsAfterNudge?: number;
  latchFired?: string[];
  callsAfterLatch?: number;
  latchRejections?: number;
  /** Approximate (statesAbsence). */
  absenceAnswer?: boolean;
  /** Approximate (namesAnyTitle or a citation): the answer names library papers. */
  namesLibraryPaper?: boolean;
  /** Approximate (offersOutsideSearch). */
  offersOutside?: boolean;
  reviewWorkflowCalls?: number;
  citesPaper?: boolean;
  answerChars?: number;
  hardFailures?: string[];
  toolSequence?: string;
};

const SUMMARY_COLUMNS: Array<[string, (row: SummaryRow) => unknown]> = [
  ["case", (row) => row.caseId],
  ["rep", (row) => row.rep],
  ["status", (row) => row.status],
  ["wall s", (row) => row.wallSeconds],
  ["rounds", (row) => row.rounds],
  ["local", (row) => row.local],
  ["scholarly", (row) => row.scholarly],
  ["web", (row) => row.web],
  ["shell", (row) => row.shell],
  ["card", (row) => row.card],
  ["confirms", (row) => row.confirmations],
  [
    "local first",
    (row) =>
      row.localBeforeOutside === undefined
        ? ""
        : row.localBeforeOutside === null
          ? "n/a"
          : row.localBeforeOutside
            ? "yes"
            : "no",
  ],
  [
    "local earlier",
    (row) =>
      row.localResultBeforeOutside === undefined
        ? ""
        : row.localResultBeforeOutside === null
          ? "n/a"
          : row.localResultBeforeOutside
            ? "yes"
            : "no",
  ],
  [
    "K sch/web",
    (row) =>
      row.searchesScholarly === undefined
        ? ""
        : `${row.searchesScholarly}/${row.searchesWeb ?? 0}`,
  ],
  [
    "nudge (after)",
    (row) =>
      row.nudgeFired === undefined
        ? ""
        : row.nudgeFired
          ? `yes (${row.callsAfterNudge ?? 0})`
          : "no",
  ],
  [
    "latch (after, refused)",
    (row) =>
      row.latchFired === undefined
        ? ""
        : row.latchFired.length
          ? `${row.latchFired.join("+")} (${row.callsAfterLatch ?? 0}, ${row.latchRejections ?? 0})`
          : "no",
  ],
  [
    "absence~",
    (row) =>
      row.absenceAnswer === undefined ? "" : row.absenceAnswer ? "yes" : "no",
  ],
  [
    "lib paper~",
    (row) =>
      row.namesLibraryPaper === undefined
        ? ""
        : row.namesLibraryPaper
          ? "yes"
          : "no",
  ],
  [
    "offer~",
    (row) =>
      row.offersOutside === undefined ? "" : row.offersOutside ? "yes" : "no",
  ],
  ["review calls", (row) => row.reviewWorkflowCalls],
  [
    "cites paper",
    (row) =>
      row.citesPaper === undefined ? "" : row.citesPaper ? "yes" : "no",
  ],
  ["answer chars", (row) => row.answerChars],
  ["hard failures", (row) => (row.hardFailures || []).join("; ")],
  ["tools", (row) => row.toolSequence],
];

/** A Markdown table of every rep, one row each. */
export function formatSummaryTable(rows: SummaryRow[]): string {
  const cell = (value: unknown) =>
    String(value ?? "")
      .replace(/\|/g, "\\|")
      .replace(/\n/g, " ");
  return [
    `| ${SUMMARY_COLUMNS.map(([name]) => name).join(" | ")} |`,
    `|${"---|".repeat(SUMMARY_COLUMNS.length)}`,
    ...rows.map(
      (row) =>
        `| ${SUMMARY_COLUMNS.map(([, value]) => cell(value(row))).join(" | ")} |`,
    ),
  ].join("\n");
}
