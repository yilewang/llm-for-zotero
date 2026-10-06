/**
 * How a click on a quote moves the reader to it.
 *
 * `navigateToQuote` takes the papers a caller has already resolved, the
 * wordings of the quote, and a policy, and reports what happened. It owns the
 * steps in between: reading candidates in the background, opening a reader,
 * the paragraph jump, and the verified page cache. Callers keep what a user
 * sees around a click: status text, button state, busy guards, and any event
 * they raise afterwards.
 *
 * The steps it is built from are exported too, because the rest of the
 * citation code still drives some of them directly.
 */
import { appLogger } from "../../core/logging";
import { sanitizeText } from "../../utils/textSanitization";
import { getActiveReaderForSelectedTab } from "../../services/pdf/zoteroReaderTabs";
import {
  buildCitationQuoteHash,
  lookupCitationPage,
  rememberCitationPage,
} from "../../services/pdf/citationNavigationCache";
import {
  type ExactQuoteJumpResult,
  type LivePdfSelectionLocateResult,
  getPageLabelForIndex,
  locateQuoteInLivePdfReader,
  scrollToExactQuoteInReader,
  verifyQuoteLocationForAttachment,
} from "../../services/pdf/livePdfSelectionLocator";
import {
  MIN_NEAR_COMPLETE_QUOTE_SUPPORT_COVERAGE,
  MIN_NEAR_COMPLETE_QUOTE_SUPPORTED_TOKENS,
} from "../../services/quotes/quoteCitations";
import {
  mergeQuoteTargetResolutions,
  resolveVerifiedQuoteTarget,
  type QuoteTargetCandidate,
  type QuoteTargetVerification,
} from "./quoteCitationTargetResolver";

// ---------------------------------------------------------------------------
// Readers

export function getReaderItemId(reader: any): number {
  const raw = Number(reader?._item?.id || reader?.itemID || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export function getPdfAttachments(
  item: Zotero.Item | null | undefined,
): Zotero.Item[] {
  if (!item) return [];
  if (
    item.isAttachment?.() &&
    item.attachmentContentType === "application/pdf"
  ) {
    return [item];
  }
  const out: Zotero.Item[] = [];
  const attachments = item.getAttachments?.() || [];
  for (const attachmentId of attachments) {
    const attachment = Zotero.Items.get(attachmentId) || null;
    if (attachment?.attachmentContentType === "application/pdf") {
      out.push(attachment);
    }
  }
  return out;
}

export function getSinglePdfAttachment(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  const attachments = getPdfAttachments(item);
  return attachments.length === 1 ? attachments[0] : null;
}

async function waitForReaderForItem(targetItemId: number): Promise<any | null> {
  const normalizedTargetItemId = Math.floor(targetItemId);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1600) {
    const activeReader = getActiveReaderForSelectedTab();
    if (getReaderItemId(activeReader) === normalizedTargetItemId) {
      return activeReader;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return null;
}

export type ReaderPageLocation = {
  pageIndex: number;
  pageLabel?: string;
};

function normalizeReaderPageLocation(
  location: ReaderPageLocation | null | undefined,
): ReaderPageLocation | undefined {
  if (!location) return undefined;
  const rawPageIndex = Number(location.pageIndex);
  if (!Number.isFinite(rawPageIndex) || rawPageIndex < 0) return undefined;
  const pageIndex = Math.floor(rawPageIndex);
  const rawPageLabel = sanitizeText(location.pageLabel || "").trim();
  return rawPageLabel ? { pageIndex, pageLabel: rawPageLabel } : { pageIndex };
}

function toZoteroReaderLocation(
  location: ReaderPageLocation | undefined,
): _ZoteroTypes.Reader.Location | undefined {
  if (!location) return undefined;
  return location.pageLabel
    ? { pageIndex: location.pageIndex, pageLabel: location.pageLabel }
    : { pageIndex: location.pageIndex };
}

export async function openReaderForItem(
  targetItemId: number,
  location?: ReaderPageLocation,
): Promise<any | null> {
  const normalizedTargetItemId = Math.floor(targetItemId);

  // Guard: only attempt to open items that Zotero's Reader can handle (PDFs).
  // Non-PDF attachments (EPUB, HTML snapshot, etc.) cause "Unsupported
  // attachment type" errors from the Reader API.
  // When the target is a regular (non-attachment) item, resolve to its first
  // PDF child attachment so Zotero.Reader.open() doesn't pick a non-PDF.
  let effectiveTargetItemId = normalizedTargetItemId;
  const targetItem = Zotero.Items.get(normalizedTargetItemId) || null;
  if (targetItem) {
    if (
      targetItem.isAttachment?.() &&
      targetItem.attachmentContentType &&
      targetItem.attachmentContentType !== "application/pdf"
    ) {
      return null;
    }
    if (targetItem.isRegularItem?.() && !targetItem.isAttachment?.()) {
      const pdfAttachment = getSinglePdfAttachment(targetItem);
      if (!pdfAttachment) return null;
      effectiveTargetItemId = Math.floor(pdfAttachment.id);
    }
  }

  const normalizedLocation = normalizeReaderPageLocation(location);
  const zoteroLocation = toZoteroReaderLocation(normalizedLocation);
  const activeReader = getActiveReaderForSelectedTab();
  if (getReaderItemId(activeReader) === effectiveTargetItemId) {
    if (normalizedLocation) {
      await navigateReaderToPage(
        activeReader,
        normalizedLocation.pageIndex,
        normalizedLocation.pageLabel,
      );
    }
    return activeReader;
  }

  const readerApi = Zotero.Reader as
    | {
        open?: (
          itemID: number,
          location?: _ZoteroTypes.Reader.Location,
        ) => Promise<void | _ZoteroTypes.ReaderInstance>;
      }
    | undefined;
  if (typeof readerApi?.open === "function") {
    const openedReader = await readerApi.open(
      effectiveTargetItemId,
      zoteroLocation,
    );
    if (getReaderItemId(openedReader) === effectiveTargetItemId) {
      if (normalizedLocation) {
        await navigateReaderToPage(
          openedReader,
          normalizedLocation.pageIndex,
          normalizedLocation.pageLabel,
        );
      }
      return openedReader;
    }
  } else {
    const pane = Zotero.getActiveZoteroPane?.() as
      | {
          viewPDF?: (
            itemID: number,
            location: _ZoteroTypes.Reader.Location,
          ) => Promise<void>;
        }
      | undefined;
    if (typeof pane?.viewPDF === "function") {
      await pane.viewPDF(effectiveTargetItemId, zoteroLocation || {});
    }
  }

  const waitedReader = await waitForReaderForItem(effectiveTargetItemId);
  if (waitedReader && normalizedLocation) {
    await navigateReaderToPage(
      waitedReader,
      normalizedLocation.pageIndex,
      normalizedLocation.pageLabel,
    );
  }
  return waitedReader;
}

export async function navigateReaderToPage(
  reader: any,
  pageIndex: number,
  pageLabel?: string,
): Promise<boolean> {
  if (typeof reader?.navigate !== "function") return false;
  const normalizedPageIndex = Math.floor(pageIndex);
  const normalizedPageLabel = sanitizeText(pageLabel || "").trim();
  try {
    if (normalizedPageLabel) {
      await reader.navigate({
        pageIndex: normalizedPageIndex,
        pageLabel: normalizedPageLabel,
      });
    } else {
      await reader.navigate({
        pageIndex: normalizedPageIndex,
      });
    }
    return true;
  } catch {
    try {
      await reader.navigate({
        pageIndex: normalizedPageIndex,
      });
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// The paragraph jump

function logParagraphJumpFailure(params: {
  contextItemId: number;
  displayCitationLabel: string;
  quoteText: string;
  pageIndex: number;
  pageLabel: string;
  paragraphJump: ExactQuoteJumpResult;
}): void {
  appLogger.warn("LLM citation paragraph jump failed", {
    contextItemId: params.contextItemId,
    citationLabel: params.displayCitationLabel,
    quoteTextLength: sanitizeText(params.quoteText || "").length,
    quoteTextHash: buildCitationQuoteHash(params.quoteText),
    pageIndex: params.pageIndex,
    pageLabel: params.pageLabel,
    expectedPageIndex: params.paragraphJump.expectedPageIndex,
    failureStage: params.paragraphJump.failureStage,
    reason: params.paragraphJump.reason,
    attempts: params.paragraphJump.queries.map((attempt) => ({
      queryLength: attempt.query.length,
      queryHash: buildCitationQuoteHash(attempt.query),
      matchedPageIndexes: attempt.matchedPageIndexes,
      totalMatches: attempt.totalMatches,
    })),
  });
}

export type CitationParagraphJumpParams = {
  reader: any;
  contextItemId: number;
  displayCitationLabel: string;
  quoteText: string;
  pageIndex: number;
  pageLabel: string;
  citationId?: string;
  sourceFingerprint?: string;
  sourceMatchPageOccurrence?: number;
  preferredFullQuoteText?: string;
  verifiedSourceMatchText?: string;
  verifiedFullSpan?: boolean;
  /** More wordings of the same passage, tried after the ones above. */
  fallbackQuoteTexts?: string[];
};

let citationParagraphJumpObserverForTests:
  | ((params: CitationParagraphJumpParams) => void)
  | null = null;

/**
 * Test-only: hand every paragraph jump's arguments to `observer` before the
 * jump runs (null stops observing). Lets the characterization tests pin what
 * each navigation tier asks the jump for. Not used by production code.
 */
export function observeCitationParagraphJumpsForTests(
  observer: ((params: CitationParagraphJumpParams) => void) | null,
): void {
  citationParagraphJumpObserverForTests = observer;
}

export async function attemptCitationParagraphJump(
  params: CitationParagraphJumpParams,
): Promise<ExactQuoteJumpResult> {
  citationParagraphJumpObserverForTests?.(params);
  // Source navigation is user-initiated. Raise an existing PDF above standalone
  // chat/document windows too, even if its paragraph cannot be highlighted.
  Zotero.getMainWindow()?.focus();
  // A cached source locator can be only a unique fragment. Try all complete
  // displayed wording before that fallback, or its early success truncates
  // the highlight even when the full passage is searchable.
  const quoteTexts = Array.from(
    new Set(
      [
        params.preferredFullQuoteText,
        params.quoteText,
        params.verifiedSourceMatchText,
        ...(params.fallbackQuoteTexts || []),
      ]
        .map((value) => sanitizeText(value || "").trim())
        .filter(Boolean),
    ),
  );
  const paragraphJump = await scrollToExactQuoteInReader(
    params.reader,
    quoteTexts[0] || params.quoteText,
    {
      citationId: params.citationId,
      expectedPageIndex: params.pageIndex,
      sourceFingerprint: params.sourceFingerprint,
      sourceMatchPageOccurrence: params.sourceMatchPageOccurrence,
      fallbackQuoteTexts: quoteTexts.slice(1),
      verifiedFullSpan: params.verifiedFullSpan,
    },
  );
  if (!paragraphJump.matched) {
    logParagraphJumpFailure({
      contextItemId: params.contextItemId,
      displayCitationLabel: params.displayCitationLabel,
      quoteText: params.quoteText,
      pageIndex: params.pageIndex,
      pageLabel: params.pageLabel,
      paragraphJump,
    });
  }
  return paragraphJump;
}

export const attemptCitationParagraphJumpForTests =
  attemptCitationParagraphJump;

/**
 * Resolve the effective page label after a paragraph jump.  If
 * FindController landed on a different page than the text search
 * predicted, use FindController's result — it is authoritative.
 */
export function resolveJumpedPageLabel(
  reader: any,
  paragraphJump: ExactQuoteJumpResult,
  fallbackPageLabel: string,
  pageLabelFor: QuoteNavigatorDeps["pageLabelFor"] = getPageLabelForIndex,
): string {
  if (paragraphJump.matched && paragraphJump.matchedPageIndex !== undefined) {
    return (
      pageLabelFor(reader, paragraphJump.matchedPageIndex) ||
      `${paragraphJump.matchedPageIndex + 1}`
    );
  }
  return fallbackPageLabel;
}

// ---------------------------------------------------------------------------
// The verified page cache

function normalizeCachedCitationPageLabel(
  pageIndex: number,
  pageLabel?: string,
): string | null {
  const normalizedPageIndex = Number.isFinite(pageIndex)
    ? Math.floor(pageIndex)
    : NaN;
  if (!Number.isFinite(normalizedPageIndex) || normalizedPageIndex < 0) {
    return null;
  }
  const normalizedPageLabel = sanitizeText(pageLabel || "").trim();
  return normalizedPageLabel || null;
}

export function rememberCachedCitationPage(
  contextItemId: number,
  quoteText: string,
  pageIndex: number,
  pageLabel?: string,
): string | null {
  const normalizedContextItemId = Number.isFinite(contextItemId)
    ? Math.floor(contextItemId)
    : NaN;
  if (
    !Number.isFinite(normalizedContextItemId) ||
    normalizedContextItemId <= 0
  ) {
    return null;
  }
  const normalizedQuoteText = sanitizeText(quoteText || "").trim();
  if (!normalizedQuoteText) return null;
  const normalizedPageLabel = normalizeCachedCitationPageLabel(
    pageIndex,
    pageLabel,
  );
  if (!normalizedPageLabel) return null;
  return rememberCitationPage({
    contextItemId: normalizedContextItemId,
    quoteText: normalizedQuoteText,
    pageIndex: Math.floor(pageIndex),
    pageLabel: normalizedPageLabel,
  });
}

/**
 * Look up the citation page cache for a corrected page label.
 * Used by note saving to replace the LLM's claimed page with the
 * actual page verified by FindController.
 */
export function lookupCachedCitationPage(
  contextItemId: number,
  quoteText: string,
): string | null {
  return (
    lookupCitationPage({
      contextItemId,
      quoteText: sanitizeText(quoteText || "").trim(),
    })?.pageLabel ?? null
  );
}

// ---------------------------------------------------------------------------
// Background verification and the viewer fallback

type ResolvedQuoteCitationMatch = {
  candidate: QuoteTargetCandidate;
  pageIndex: number;
  /**
   * Set only by the viewer fallback, from `getPageLabelForIndex`. When the
   * reader exposes no printed label for the page, that helper returns
   * `${pageIndex + 1}`, so this label can be a guess rather than one the
   * reader reported. Zotero navigates by label when one is supplied, and a
   * PDF's printed labels need not track its page order, so a guessed label
   * can land on the wrong page.
   */
  pageLabel?: string;
  quoteText: string;
  sourceMatchText?: string;
  sourceMatchPageOccurrence?: number;
};

/**
 * A quote must have one substantial passage in common with a paper before that
 * paper can be called its source.  Coverage alone cannot tell a real passage
 * from several stock phrases unioned together: a same-field paper sharing
 * "we recorded from hippocampal CA1", "population activity was not stable" and
 * "behavioural performance remained unchanged" reaches 0.82 coverage while its
 * longest common run is under a third of the quote.
 */
const MIN_QUOTE_SOURCE_ANCHOR_TOKENS = 12;

/**
 * Whether a located result is strong enough to call this paper the quote's
 * source.  A complete alignment answers yes on its own; anything partial has
 * to clear the answer-time gate's own bars — the same coverage ratio, the same
 * minimum of supported tokens — plus one substantial contiguous passage.
 */
function locatedResultIdentifiesQuoteSource(
  result: LivePdfSelectionLocateResult,
): boolean {
  const pooled = Number(result.sourceMatchQuoteTokenSupportCoverage);
  if (!Number.isFinite(pooled)) {
    // No pooled figure means the whole quote aligned as one span.
    return true;
  }
  const supportedTokens = Number(result.sourceMatchSupportedQuoteTokenCount);
  const longestRun = Number(result.sourceMatchLongestRunTokenCount);
  return (
    pooled >= MIN_NEAR_COMPLETE_QUOTE_SUPPORT_COVERAGE &&
    (!Number.isFinite(supportedTokens) ||
      supportedTokens >= MIN_NEAR_COMPLETE_QUOTE_SUPPORTED_TOKENS) &&
    (!Number.isFinite(longestRun) ||
      longestRun >= MIN_QUOTE_SOURCE_ANCHOR_TOKENS)
  );
}

export const locatedResultIdentifiesQuoteSourceForTests =
  locatedResultIdentifiesQuoteSource;

/**
 * Whether a hit found by *opening* a candidate may move the reader.
 *
 * The background verifier refuses a paper that a library search merely proposed
 * when it accounts for only part of the quote.  This path is reached for the
 * papers whose text would not extract in the background, and it must apply the
 * same rule: otherwise a scanned decoy sharing one long phrase walks straight
 * through the gate its extractable twin is held to, and the click parks the
 * user on a paper the answer never used.
 *
 * A paper the conversation itself carries keeps the latitude it has elsewhere —
 * writers stitch quotes, and no single span need cover the whole of one.
 */
function acceptsOpenedQuoteMatch(params: {
  authoritative: boolean;
  result: LivePdfSelectionLocateResult;
}): boolean {
  if (params.result.status !== "resolved") return false;
  if (params.result.computedPageIndex === null) return false;
  return (
    params.authoritative || locatedResultIdentifiesQuoteSource(params.result)
  );
}

export const acceptsOpenedQuoteMatchForTests = acceptsOpenedQuoteMatch;

/**
 * Read a candidate's PDF text in the background to decide whether it really
 * contains the quote.  This deliberately does not open a reader tab: a click
 * may have several candidates in range and only the winner should ever appear
 * on screen.
 */
async function verifyQuoteInCitationCandidate(
  candidate: QuoteTargetCandidate,
  quoteText: string,
): Promise<QuoteTargetVerification> {
  const result = await verifyQuoteLocationForAttachment(
    candidate.contextItemId,
    quoteText,
  );
  // When the whole quote does not align, the locator falls back to the largest
  // contiguous span that occurs exactly once.  A short shared phrase must not
  // be enough to send the reader to a paper the conversation never used — but
  // "partial" is not the same as "a fragment".  Writers quote by stitching,
  // and a quote assembled from three passages of the right paper is fully
  // accounted for by it while no single span covers even half.  So judge on
  // how much of the quote this document accounts for in total, using the same
  // threshold the answer-time quote gate already trusts.
  if (
    result.status === "resolved" &&
    !candidate.authoritative &&
    !locatedResultIdentifiesQuoteSource(result)
  ) {
    return {
      status: "not-found",
      reason: "Only part of the cited quote appears in this paper.",
    };
  }
  return {
    // A quote too short to identify a page is a property of the quote, not of
    // this PDF, so it counts as "not here" rather than "could not be read" —
    // re-reading it through the viewer would give the same verdict.
    status:
      result.status === "selection-too-short" ? "not-found" : result.status,
    pageIndex: result.computedPageIndex,
    sourceMatchText: result.sourceMatchText,
    sourceMatchPageOccurrence: result.sourceMatchPageOccurrence,
    reason: result.reason,
  };
}

/**
 * Opening a paper that turns out not to hold the quote is exactly the tab
 * spam this path exists to avoid, so only the few best guesses are tried.
 */
const MAX_OPENED_QUOTE_VERIFICATION_CANDIDATES = 3;

/**
 * Last resort for PDFs whose text the background worker cannot read (scanned
 * or otherwise unextractable).  Opening the reader lets the viewer supply text
 * the worker could not, which is how this path behaved before verification
 * moved into the background.
 */
async function locateQuoteByOpeningCitationCandidates(
  params: {
    candidates: readonly QuoteTargetCandidate[];
    searchTexts: readonly string[];
  },
  deps: QuoteNavigatorDeps,
): Promise<{
  matches: ResolvedQuoteCitationMatch[];
  reason: string;
}> {
  const matches: ResolvedQuoteCitationMatch[] = [];
  let reason = "";
  for (const candidate of params.candidates.slice(
    0,
    MAX_OPENED_QUOTE_VERIFICATION_CANDIDATES,
  )) {
    const reader = await deps.openReader(candidate.contextItemId);
    if (!reader) {
      reason = "Could not open the cited paper.";
      continue;
    }
    for (const searchText of params.searchTexts) {
      const result = await deps.locateInReader(reader, searchText);
      if (
        acceptsOpenedQuoteMatch({
          authoritative: candidate.authoritative,
          result,
        })
      ) {
        const pageIndex = Math.floor(result.computedPageIndex as number);
        matches.push({
          candidate,
          pageIndex,
          // A guessed `${pageIndex + 1}` when the reader has no printed label
          // for this page; see ResolvedQuoteCitationMatch.pageLabel.
          pageLabel: deps.pageLabelFor(reader, pageIndex) || undefined,
          quoteText: searchText,
          sourceMatchText: result.sourceMatchText,
          sourceMatchPageOccurrence: result.sourceMatchPageOccurrence,
        });
        break;
      }
      if (result.reason) reason = result.reason;
    }
    if (matches.length) break;
  }
  return { matches, reason };
}

// ---------------------------------------------------------------------------
// navigateToQuote

/** The steps `navigateToQuote` drives; tests replace them. */
export type QuoteNavigatorDeps = {
  /** Read a candidate's PDF text, without opening it, for the quote. */
  verifyInBackground: (
    candidate: QuoteTargetCandidate,
    quoteText: string,
  ) => Promise<QuoteTargetVerification>;
  /** Open (or reuse) an attachment's reader, at a page when one is given. */
  openReader: (
    contextItemId: number,
    location?: ReaderPageLocation,
  ) => Promise<any | null>;
  /** Find the quote's page in an open reader's PDF text. */
  locateInReader: (
    reader: any,
    quoteText: string,
    options?: { exactOnly?: boolean },
  ) => Promise<LivePdfSelectionLocateResult>;
  /** Scroll the reader to the quote and highlight it. */
  jump: (params: CitationParagraphJumpParams) => Promise<ExactQuoteJumpResult>;
  /** The page label a reader shows for a page index. */
  pageLabelFor: (reader: any, pageIndex: number) => string | undefined;
  /** Record the page a jump verified, for later clicks and saved notes. */
  rememberPage: (
    contextItemId: number,
    quoteText: string,
    pageIndex: number,
    pageLabel?: string,
  ) => string | null;
};

export const defaultQuoteNavigatorDeps: QuoteNavigatorDeps = {
  verifyInBackground: verifyQuoteInCitationCandidate,
  openReader: openReaderForItem,
  locateInReader: locateQuoteInLivePdfReader,
  jump: attemptCitationParagraphJump,
  pageLabelFor: getPageLabelForIndex,
  rememberPage: rememberCachedCitationPage,
};

export type QuoteNavigationPolicy = {
  /**
   * "verify-first": read every candidate's text in the background and open
   * only the paper found to hold the quote. A PDF whose text cannot be read
   * in the background is opened in the viewer instead, a few at most.
   */
  strategy: "verify-first";
  /** Also hand the jump every search text as a further wording. */
  jumpFallbackTexts: boolean;
  /** Record the page a successful jump landed on in the page cache. */
  rememberPage: boolean;
};

export type QuoteNavigationRequest = {
  /** The papers to try, as the caller resolved and ranked them. */
  candidates: readonly QuoteTargetCandidate[];
  /**
   * More papers, asked for only when none of `candidates` holds the quote.
   * Their verdict is merged with the first one's, which keeps precedence.
   */
  moreCandidates?: () => Promise<readonly QuoteTargetCandidate[]>;
  /** The wordings to verify, best first. */
  searchTexts: readonly string[];
  /** The citation label the jump logs. */
  displayCitationLabel: string;
  /** Whether a candidate may be opened in the viewer; default yes. */
  openableInViewer?: (contextItemId: number) => boolean;
  policy: QuoteNavigationPolicy;
  /** Called with each timing stage the caller may want to record. */
  trace?: (stage: string, details?: unknown) => void;
};

export type QuoteNavigationOutcome =
  /** The quote was found and highlighted. */
  | {
      kind: "jumped";
      contextItemId: number;
      pageIndex: number;
      pageLabel: string;
      jump: ExactQuoteJumpResult;
    }
  /** The reader is on the verified page, but the highlight failed. */
  | {
      kind: "page-only";
      contextItemId: number;
      pageIndex: number;
      pageLabel: string;
      jump: ExactQuoteJumpResult;
    }
  /** No candidate holds the quote. */
  | { kind: "not-found"; reason: string }
  /** No candidate's text could be read, and the viewer did not find it. */
  | { kind: "unverifiable"; reason: string }
  /** The paper holding the quote would not open. */
  | { kind: "open-failed"; contextItemId: number }
  /** There was no paper or no quote text to look for. */
  | { kind: "no-candidates" };

/**
 * Move the reader to a quote, the way `req.policy` says, and report what
 * happened. Nothing here touches the status line or the button.
 */
export async function navigateToQuote(
  req: QuoteNavigationRequest,
  deps: QuoteNavigatorDeps = defaultQuoteNavigatorDeps,
): Promise<QuoteNavigationOutcome> {
  return navigateVerifyFirst(req, deps);
}

async function navigateVerifyFirst(
  req: QuoteNavigationRequest,
  deps: QuoteNavigatorDeps,
): Promise<QuoteNavigationOutcome> {
  if (!req.candidates.length || !req.searchTexts.length) {
    return { kind: "no-candidates" };
  }
  let candidatesByContextItemId = new Map(
    req.candidates.map((candidate) => [candidate.contextItemId, candidate]),
  );
  const verifyCandidates = (candidates: readonly QuoteTargetCandidate[]) =>
    resolveVerifiedQuoteTarget({
      candidates,
      searchTexts: req.searchTexts,
      verify: deps.verifyInBackground,
    });
  let resolution = await verifyCandidates(req.candidates);
  if (resolution.status !== "resolved" && req.moreCandidates) {
    // The first papers did not hold the quote after all (for a recorded
    // paper, its item id may have been reused, or its text may not extract).
    // Rather than dead-end, look further.
    const searched = await req.moreCandidates();
    const fallbackCandidates = searched.filter(
      (candidate) => !candidatesByContextItemId.has(candidate.contextItemId),
    );
    if (fallbackCandidates.length) {
      candidatesByContextItemId = new Map(
        [...req.candidates, ...fallbackCandidates].map((candidate) => [
          candidate.contextItemId,
          candidate,
        ]),
      );
      // Only the papers the first pass skipped are re-read, so the second
      // verdict covers fewer papers than the click does.  Merging keeps the
      // first papers' standing — a scanned PDF stays eligible for the viewer
      // fallback instead of being written off by a search that failed
      // somewhere else.
      resolution = mergeQuoteTargetResolutions({
        recorded: resolution,
        searched: await verifyCandidates(fallbackCandidates),
      });
    }
  }
  req.trace?.("quote verification", {
    status: resolution.status,
    // How many PDFs this click had to read. A jump to a paper the answer
    // recorded should be 1; higher means the label search did the work.
    pdfsRead: resolution.readCount,
  });

  let match: ResolvedQuoteCitationMatch | null = null;
  let lastReason = "The cited quote was not found in the cited paper.";
  if (resolution.status === "resolved") {
    const candidate = candidatesByContextItemId.get(resolution.contextItemId);
    if (candidate) {
      match = {
        candidate,
        pageIndex: resolution.pageIndex,
        quoteText: resolution.quoteText,
        sourceMatchText: resolution.sourceMatchText,
        sourceMatchPageOccurrence: resolution.sourceMatchPageOccurrence,
      };
    }
  } else if (resolution.status === "unverifiable") {
    // Background text extraction failed for these; fall back to the viewer.
    const opened = await locateQuoteByOpeningCitationCandidates(
      {
        candidates: resolution.contextItemIds
          .map((contextItemId) => candidatesByContextItemId.get(contextItemId))
          .filter(
            (candidate): candidate is QuoteTargetCandidate =>
              Boolean(candidate) &&
              (req.openableInViewer?.(candidate!.contextItemId) ?? true),
          ),
        searchTexts: req.searchTexts,
      },
      deps,
    );
    match = opened.matches[0] || null;
    if (opened.reason) lastReason = opened.reason;
    if (!match && !opened.reason) lastReason = resolution.reason;
  } else {
    lastReason = resolution.reason;
  }

  if (!match) {
    return resolution.status === "unverifiable"
      ? { kind: "unverifiable", reason: lastReason }
      : { kind: "not-found", reason: lastReason };
  }

  // Only the verified winner is ever opened, so a click can never leave the
  // user parked on a paper that does not contain the quote.
  const contextItemId = match.candidate.contextItemId;
  const reader = await deps.openReader(contextItemId, {
    pageIndex: match.pageIndex,
    pageLabel: match.pageLabel,
  });
  if (!reader) return { kind: "open-failed", contextItemId };
  const pageLabel =
    deps.pageLabelFor(reader, match.pageIndex) ||
    match.pageLabel ||
    `${match.pageIndex + 1}`;

  const jump = await deps.jump({
    reader,
    contextItemId,
    displayCitationLabel: req.displayCitationLabel,
    quoteText: match.quoteText,
    pageIndex: match.pageIndex,
    pageLabel,
    sourceMatchPageOccurrence: match.sourceMatchPageOccurrence,
    verifiedSourceMatchText: match.sourceMatchText,
    // Never `verifiedFullSpan`: it would switch off the page's
    // largest-unique-partial-span fallback a verified passage may need.
    ...(req.policy.jumpFallbackTexts
      ? { fallbackQuoteTexts: req.searchTexts.slice() }
      : {}),
  });
  const jumpedLabel = resolveJumpedPageLabel(
    reader,
    jump,
    pageLabel,
    deps.pageLabelFor,
  );
  if (!jump.matched) {
    return {
      kind: "page-only",
      contextItemId,
      pageIndex: match.pageIndex,
      pageLabel: jumpedLabel,
      jump,
    };
  }
  const jumpedPageIndex = jump.matchedPageIndex ?? match.pageIndex;
  if (req.policy.rememberPage) {
    deps.rememberPage(
      contextItemId,
      match.quoteText,
      jumpedPageIndex,
      jumpedLabel,
    );
  }
  return {
    kind: "jumped",
    contextItemId,
    pageIndex: jumpedPageIndex,
    pageLabel: jumpedLabel,
    jump,
  };
}
