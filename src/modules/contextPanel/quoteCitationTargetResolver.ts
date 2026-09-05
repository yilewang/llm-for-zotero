/**
 * Verify-before-navigate resolution for cited quotes.
 *
 * A citation label written by the model is a hint, not a key: it can name the
 * wrong author or year.  The quote text itself is the key — a verbatim span is
 * self-identifying even across a whole library.  So navigation never trusts a
 * candidate because it *looks* right; it reads the candidate's PDF text and
 * only jumps once the quote is actually found there.
 *
 * Because verification is the safety net, the search space can be wide: papers
 * carried by the conversation first, then papers found by searching the
 * library for the citation label.
 *
 * Reading a PDF's text costs on the order of a second, so the search space
 * being wide must not make a click slow.  Candidates are ordered best-first
 * and the first one holding the quote wins immediately.  That loses nothing:
 * since the order is already best-first, reading on could only turn up equal
 * or worse matches.
 */

export type QuoteTargetVerificationStatus =
  | "resolved"
  | "ambiguous"
  | "not-found"
  | "unavailable";

export type QuoteTargetVerification = {
  status: QuoteTargetVerificationStatus;
  /** Zero-based page the quote was found on. */
  pageIndex?: number | null;
  sourceMatchText?: string;
  sourceMatchPageOccurrence?: number;
  reason?: string;
};

export type QuoteTargetCandidate = {
  contextItemId: number;
  /**
   * True for papers the conversation itself carries (message contexts, quote
   * bindings, the open reader).  These are checked before papers that a
   * library search merely proposed.
   */
  authoritative: boolean;
  /** Higher means the citation label agrees more strongly with this paper. */
  labelRank: number;
};

export type QuoteTargetResolution =
  | {
      status: "resolved";
      contextItemId: number;
      pageIndex: number;
      quoteText: string;
      sourceMatchText?: string;
      sourceMatchPageOccurrence?: number;
      authoritative: boolean;
      /** PDFs read to reach this answer; 1 on the common path. */
      readCount: number;
    }
  | {
      status: "unverifiable";
      contextItemIds: number[];
      reason: string;
      readCount: number;
    }
  | { status: "not-found"; reason: string; readCount: number };

/**
 * Upper bound on how many PDFs one verification pass may read before giving up.
 * Only the failing path can reach it — a successful pass stops at its first
 * hit.  A click that verifies recorded papers and then searches the library
 * runs two passes, and each gets its own budget.
 */
export const DEFAULT_QUOTE_TARGET_VERIFICATION_BUDGET = 8;

/** PDFs read to reach a verdict; `unverifiable` carries one too, so a merged
 * click can report what it actually cost. */
function resolutionReadCount(resolution: QuoteTargetResolution): number {
  return resolution.readCount || 0;
}

/**
 * Fold the library-search pass's verdict into the recorded pass's.
 *
 * A click may verify twice: the papers the answer recorded, then — if those do
 * not hold the quote — papers found by searching the library.  The second pass
 * reads only the papers the first one did not, so its verdict describes fewer
 * papers than the click as a whole and cannot simply replace the first.
 *
 * "Unverifiable" is the case that matters.  It means a PDF's text could not be
 * extracted in the background, which is not a "no" — opening it in the reader
 * is the one remaining way to find the quote.  A later pass that merely fails
 * to find the quote elsewhere must not retire that option.
 *
 * The two are named rather than positional because swapping them is silent:
 * both are the same type, and the only visible symptom is that the recorded
 * paper stops being offered first.
 */
export function mergeQuoteTargetResolutions(params: {
  /** The papers the answer itself recorded — always verified first. */
  recorded: QuoteTargetResolution;
  /** The papers a library label search proposed afterwards. */
  searched: QuoteTargetResolution;
}): QuoteTargetResolution {
  const { recorded, searched } = params;
  const readCount =
    resolutionReadCount(recorded) + resolutionReadCount(searched);
  // A paper the answer used outranks a same-label lookalike, so its hit is
  // taken first even though the caller only reaches here when it had none.
  if (recorded.status === "resolved") return { ...recorded, readCount };
  if (searched.status === "resolved") return { ...searched, readCount };

  if (
    recorded.status === "unverifiable" ||
    searched.status === "unverifiable"
  ) {
    // Recorded papers first: the answer named them, so they are the reader's
    // best guess, and this order is what the viewer fallback opens by.
    const contextItemIds = [
      ...(recorded.status === "unverifiable" ? recorded.contextItemIds : []),
      ...(searched.status === "unverifiable" ? searched.contextItemIds : []),
    ];
    return {
      status: "unverifiable",
      contextItemIds: Array.from(new Set(contextItemIds)),
      reason:
        (recorded.status === "unverifiable" ? recorded.reason : "") ||
        (searched.status === "unverifiable" ? searched.reason : "") ||
        "Could not read the cited paper's PDF text.",
      readCount,
    };
  }

  return {
    status: "not-found",
    // The recorded paper is the one the user asked about, so its verdict is
    // the one worth showing.
    reason: recorded.reason || searched.reason,
    readCount,
  };
}

const DEFAULT_NOT_FOUND_REASON =
  "The cited quote was not found in any matching paper.";

function normalizeContextItemId(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeLabelRank(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePageIndex(value: unknown): number | null {
  // Number(null) and Number("") are 0, which would silently become page 1.
  if (value === null || value === undefined || value === "") return null;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Collapse repeated attachments and order the survivors so the cheapest, most
 * likely wins come first: conversation papers before library guesses, and
 * within each group the strongest label agreement first.  Order is otherwise
 * stable so a click is deterministic.
 */
function prioritizeCandidates(
  candidates: readonly QuoteTargetCandidate[],
): QuoteTargetCandidate[] {
  const byContextItemId = new Map<number, QuoteTargetCandidate>();
  for (const candidate of candidates || []) {
    const contextItemId = normalizeContextItemId(candidate?.contextItemId);
    if (!contextItemId) continue;
    const normalized: QuoteTargetCandidate = {
      contextItemId,
      authoritative: Boolean(candidate.authoritative),
      labelRank: normalizeLabelRank(candidate.labelRank),
    };
    const existing = byContextItemId.get(contextItemId);
    if (!existing) {
      byContextItemId.set(contextItemId, normalized);
      continue;
    }
    // The same attachment can arrive from several sources; keep its strongest
    // standing so one weak duplicate cannot demote it out of the budget.
    byContextItemId.set(contextItemId, {
      contextItemId,
      authoritative: existing.authoritative || normalized.authoritative,
      labelRank: Math.max(existing.labelRank, normalized.labelRank),
    });
  }
  return Array.from(byContextItemId.values())
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      const authoritativeDelta =
        Number(right.candidate.authoritative) -
        Number(left.candidate.authoritative);
      if (authoritativeDelta !== 0) return authoritativeDelta;
      const labelDelta = right.candidate.labelRank - left.candidate.labelRank;
      if (labelDelta !== 0) return labelDelta;
      return left.index - right.index;
    })
    .map((entry) => entry.candidate);
}

function normalizeSearchTexts(searchTexts: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const searchText of searchTexts || []) {
    const text = typeof searchText === "string" ? searchText.trim() : "";
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

export async function resolveVerifiedQuoteTarget(params: {
  candidates: readonly QuoteTargetCandidate[];
  searchTexts: readonly string[];
  verify: (
    candidate: QuoteTargetCandidate,
    quoteText: string,
  ) => Promise<QuoteTargetVerification>;
  verificationBudget?: number;
}): Promise<QuoteTargetResolution> {
  const searchTexts = normalizeSearchTexts(params.searchTexts);
  if (!searchTexts.length) {
    return {
      status: "not-found",
      reason: "No quote text was available.",
      readCount: 0,
    };
  }

  const budgetInput = Number(params.verificationBudget);
  const budget =
    Number.isFinite(budgetInput) && budgetInput > 0
      ? Math.floor(budgetInput)
      : DEFAULT_QUOTE_TARGET_VERIFICATION_BUDGET;

  const candidates = prioritizeCandidates(params.candidates);
  const unverifiableContextItemIds: number[] = [];
  let unverifiableReason = "";
  // Candidates are read best-first, so the first verdict is the one about the
  // paper most likely to be meant.  Reporting the last one instead explains a
  // failure in terms of whichever unrelated paper happened to be checked last.
  let bestReason = "";
  let spent = 0;

  // Conversation papers are settled before library guesses are read at all, so
  // a paper the answer actually used always wins over a same-label lookalike.
  for (const tier of [true, false]) {
    for (const candidate of candidates) {
      if (candidate.authoritative !== tier) continue;
      if (spent >= budget) break;
      spent += 1;
      for (const quoteText of searchTexts) {
        let verification: QuoteTargetVerification;
        try {
          verification = await params.verify(candidate, quoteText);
        } catch (_err) {
          void _err;
          verification = {
            status: "unavailable",
            reason: "Could not read this PDF's text.",
          };
        }
        if (verification?.reason && !bestReason) {
          bestReason = verification.reason;
        }
        if (verification?.status === "unavailable") {
          if (!unverifiableContextItemIds.includes(candidate.contextItemId)) {
            unverifiableContextItemIds.push(candidate.contextItemId);
          }
          if (!unverifiableReason && verification.reason) {
            unverifiableReason = verification.reason;
          }
          break;
        }
        if (verification?.status !== "resolved") continue;
        const pageIndex = normalizePageIndex(verification.pageIndex);
        if (pageIndex === null) continue;
        // Best-first order means no later candidate can beat this one.
        return {
          status: "resolved",
          contextItemId: candidate.contextItemId,
          pageIndex,
          quoteText,
          sourceMatchText: verification.sourceMatchText,
          sourceMatchPageOccurrence: verification.sourceMatchPageOccurrence,
          authoritative: candidate.authoritative,
          readCount: spent,
        };
      }
    }
  }

  if (unverifiableContextItemIds.length) {
    return {
      status: "unverifiable",
      contextItemIds: unverifiableContextItemIds,
      reason:
        unverifiableReason || "Could not read the cited paper's PDF text.",
      readCount: spent,
    };
  }
  return {
    status: "not-found",
    reason: bestReason || DEFAULT_NOT_FOUND_REASON,
    readCount: spent,
  };
}
