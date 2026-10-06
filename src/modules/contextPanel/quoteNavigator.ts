/**
 * How a click on a quote moves the reader to it.
 *
 * `navigateToQuote` takes the papers a caller has already resolved, the
 * wordings of the quote, and a policy, and reports what happened. Every quote
 * path (trusted and untrusted quote cards, Task progress) verifies first: it
 * reads the candidates' text in the background and opens only the paper that
 * holds the quote, at the page it was found on. It owns the steps in between:
 * opening a reader, the paragraph jump, and the verified page cache. Callers
 * keep what a user sees around a click: status text, button state, busy
 * guards, and any event they raise afterwards.
 *
 * The steps it is built from are exported too, because the rest of the
 * citation code still drives some of them directly.
 */
import { appLogger } from "../../core/logging";
import { sanitizeText } from "../../utils/textSanitization";
import { getActiveReaderForSelectedTab } from "../../services/pdf/zoteroReaderTabs";
import {
  buildCitationQuoteHash,
  citationPageDisplayLabel,
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
  pageLabel?: string;
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
  /** The reader's printed label for the page, when it reports one. */
  pageLabel?: string;
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
 * Said when a trusted click stays on a copy of the paper whose PDF is not
 * the one the answer quoted.
 */
export const DIFFERENT_COPY_STATUS =
  "Opened a different copy of this paper; the quote could not be confirmed here.";

export function buildParagraphJumpFailureStatus(
  pageLabel: string,
  paragraphJump: ExactQuoteJumpResult,
): string {
  const reason = sanitizeText(paragraphJump.reason || "")
    .replace(/\s+/g, " ")
    .trim();
  return reason
    ? `Jumped to page ${pageLabel}. Paragraph jump failed: ${reason}`
    : `Jumped to page ${pageLabel}. Paragraph jump failed.`;
}

export function buildParagraphJumpSuccessStatus(
  pageLabel: string,
  paragraphJump: ExactQuoteJumpResult,
  samePageCopyCount?: number,
): string {
  const jumped =
    paragraphJump.navigationStatus === "paragraph-selected"
      ? `Jumped to cited source (page ${pageLabel}, paragraph matched)`
      : `Jumped to cited source (page ${pageLabel}, quote found; exact occurrence not selected)`;
  // Only a jump that selected an occurrence highlighted the first copy.
  return paragraphJump.navigationStatus === "paragraph-selected" &&
    samePageCopyCount !== undefined &&
    samePageCopyCount > 1
    ? `${jumped}. ${buildFirstOfSamePageCopiesNote(samePageCopyCount)}`
    : jumped;
}

/**
 * Said after a jump to a page that holds the quote more than once, when
 * nothing recorded which copy the answer quoted.
 */
function buildFirstOfSamePageCopiesNote(samePageCopyCount: number): string {
  const times =
    samePageCopyCount === 2 ? "twice" : `${samePageCopyCount} times`;
  return `This quote appears ${times} on the page; the first copy is highlighted.`;
}

// ---------------------------------------------------------------------------
// The verified page cache

/**
 * Record the page a jump verified. `pageLabel` is the reader's printed
 * label, when it reported one; none is guessed from the page index. Returns
 * how the page is shown, or null when nothing was stored.
 */
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
  if (!Number.isFinite(pageIndex) || pageIndex < 0) return null;
  return rememberCitationPage({
    contextItemId: normalizedContextItemId,
    quoteText: normalizedQuoteText,
    pageIndex: Math.floor(pageIndex),
    pageLabel,
  });
}

/**
 * The page a jump verified for this quote: its index, and the printed label
 * the reader reported, if any. Note saving uses it to replace the LLM's
 * claimed page with the actual page verified by FindController.
 */
export function lookupCachedCitationPageLocation(
  contextItemId: number,
  quoteText: string,
): ReaderPageLocation | null {
  const entry = lookupCitationPage({
    contextItemId,
    quoteText: sanitizeText(quoteText || "").trim(),
  });
  if (!entry) return null;
  return entry.pageLabel
    ? { pageIndex: entry.pageIndex, pageLabel: entry.pageLabel }
    : { pageIndex: entry.pageIndex };
}

/** How the verified page for this quote is shown, if one is cached. */
export function lookupCachedCitationPage(
  contextItemId: number,
  quoteText: string,
): string | null {
  const location = lookupCachedCitationPageLocation(contextItemId, quoteText);
  return location ? citationPageDisplayLabel(location) : null;
}

// ---------------------------------------------------------------------------
// Background verification and the viewer fallback

type ResolvedQuoteCitationMatch = {
  candidate: QuoteTargetCandidate;
  pageIndex: number;
  /**
   * Set only by the viewer fallback, and only when the reader reports a
   * printed label for the page. The page index drives navigation; the label
   * is for display and saved-note links, so none is guessed from the index.
   */
  pageLabel?: string;
  quoteText: string;
  sourceMatchText?: string;
  sourceMatchPageOccurrence?: number;
  /** See QuoteTargetVerification.samePageCopyCount. */
  samePageCopyCount?: number;
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
 * Where the answer recorded its quote. It only chooses among identical
 * copies of the quote in a PDF that was read; it is never a page to open.
 */
export type RecordedQuoteLocation = {
  /**
   * Preferred page when complete copies sit on several pages. When every
   * copy sits on this one page, it also settles that tie.
   */
  pageIndex?: number;
  /** Which copy on its page the answer quoted, counting from 0. */
  occurrence?: number;
};

/**
 * A quote that occurs more than once on one page is "ambiguous" to the
 * locator, though its page is certain. When the answer recorded which copy
 * it quoted, or recorded that very page, the page is verified and the jump
 * picks the copy.
 */
function settleCopiesOnOnePage(
  result: LivePdfSelectionLocateResult,
  recorded: RecordedQuoteLocation | undefined,
): SettledLocateResult {
  if (result.status !== "ambiguous" || !recorded) return result;
  const pages = new Set(result.matchedPageIndexes);
  if (pages.size !== 1) return result;
  const [pageIndex] = pages;
  // Without a recorded copy, only the recorded page may settle the tie.
  if (recorded.occurrence === undefined && recorded.pageIndex !== pageIndex) {
    return result;
  }
  const settled = {
    ...result,
    status: "resolved" as const,
    computedPageIndex: pageIndex,
    reason:
      "The complete quote occurs more than once on one PDF page; the recorded page or occurrence picks it.",
  };
  if (recorded.occurrence !== undefined) {
    return { ...settled, sourceMatchPageOccurrence: recorded.occurrence };
  }
  // Nothing says which copy the answer quoted. Without an occurrence the
  // jump cannot align one of identical copies, so it highlights the first
  // and the status line says so.
  return {
    ...settled,
    sourceMatchPageOccurrence: 0,
    samePageCopyCount: Math.max(2, Math.floor(result.totalMatches) || 0),
  };
}

/** A located result, plus how many copies a settled tie left unpicked. */
type SettledLocateResult = LivePdfSelectionLocateResult & {
  /** See QuoteTargetVerification.samePageCopyCount. */
  samePageCopyCount?: number;
};

/**
 * Read a candidate's PDF text in the background to decide whether it really
 * contains the quote.  This deliberately does not open a reader tab: a click
 * may have several candidates in range and only the winner should ever appear
 * on screen.
 */
async function verifyQuoteInCitationCandidate(
  candidate: QuoteTargetCandidate,
  quoteText: string,
  recorded?: RecordedQuoteLocation,
): Promise<QuoteTargetVerification> {
  const result = settleCopiesOnOnePage(
    await verifyQuoteLocationForAttachment(
      candidate.contextItemId,
      quoteText,
      recorded?.pageIndex !== undefined
        ? { expectedPageIndex: recorded.pageIndex }
        : undefined,
    ),
    recorded,
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
    ...(result.samePageCopyCount !== undefined
      ? { samePageCopyCount: result.samePageCopyCount }
      : {}),
    reason: result.reason,
  };
}

/**
 * Opening a paper that turns out not to hold the quote is exactly the tab
 * spam this path exists to avoid, so only the few best guesses are tried,
 * at most this many per click.
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
    /** How many readers this call may still open. */
    limit: number;
    recorded?: RecordedQuoteLocation;
  },
  deps: QuoteNavigatorDeps,
): Promise<{
  matches: ResolvedQuoteCitationMatch[];
  reason: string;
  /** Readers this call tried to open. */
  attempted: number;
  /** Papers that would not open, or that the viewer read without the quote. */
  missed: number[];
}> {
  const matches: ResolvedQuoteCitationMatch[] = [];
  const missed: number[] = [];
  let reason = "";
  let attempted = 0;
  const recordedPage = params.recorded?.pageIndex;
  for (const candidate of params.candidates.slice(
    0,
    Math.max(0, params.limit),
  )) {
    attempted += 1;
    const reader = await deps.openReader(candidate.contextItemId);
    if (!reader) {
      reason = "Could not open the cited paper.";
      missed.push(candidate.contextItemId);
      continue;
    }
    for (const searchText of params.searchTexts) {
      const result = settleCopiesOnOnePage(
        await deps.locateInReader(
          reader,
          searchText,
          recordedPage !== undefined
            ? { expectedPageIndex: recordedPage }
            : undefined,
        ),
        params.recorded,
      );
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
          pageLabel: deps.pageLabelFor(reader, pageIndex) || undefined,
          quoteText: searchText,
          sourceMatchText: result.sourceMatchText,
          sourceMatchPageOccurrence: result.sourceMatchPageOccurrence,
          ...(result.samePageCopyCount !== undefined
            ? { samePageCopyCount: result.samePageCopyCount }
            : {}),
        });
        break;
      }
      if (result.reason) reason = result.reason;
    }
    if (matches.length) break;
    missed.push(candidate.contextItemId);
  }
  return { matches, reason, attempted, missed };
}

// ---------------------------------------------------------------------------
// navigateToQuote

/** The steps `navigateToQuote` drives; tests replace them. */
export type QuoteNavigatorDeps = {
  /** Read a candidate's PDF text, without opening it, for the quote. */
  verifyInBackground: (
    candidate: QuoteTargetCandidate,
    quoteText: string,
    recorded?: RecordedQuoteLocation,
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
    options?: { exactOnly?: boolean; expectedPageIndex?: number | null },
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
  /** Record the page a successful jump landed on in the page cache. */
  rememberPage: boolean;
  /** Also hand the jump every search text as a wording. */
  jumpFallbackTexts?: boolean;
  /**
   * With no candidate at all, search the reader that is already open: its
   * text must hold the complete quote before the jump moves it. A caller
   * turns this on only when it resolved no candidate whatsoever.
   */
  activeReaderFallback?: boolean;
};

/** What the answer recorded about where its quote came from. */
export type QuoteNavigationCertificate = {
  citationId?: string;
  sourceFingerprint?: string;
  /**
   * Which copy of the quote on its page the answer quoted. Verification
   * also uses it to accept a page that holds the quote more than once.
   */
  sourceMatchPageOccurrence?: number;
  /**
   * The page the answer recorded the quote on. It only chooses among
   * identical copies on several pages; it is never a page to open.
   */
  pageIndex?: number;
  /**
   * The quote matched the PDF.js text exactly, so the jump must highlight
   * the whole quote and not a partial span of it.
   */
  verifiedFullSpan?: boolean;
};

/** Which step found the quote. */
export type QuoteNavigationTier = "verified" | "active-reader";

export type QuoteNavigationRequest = {
  /**
   * The papers to try, as the caller resolved and ranked them. A candidate's
   * `cachedPage` only moves it earlier in the reading order.
   */
  candidates: readonly QuoteTargetCandidate[];
  /**
   * More papers, asked for only when none of `candidates` holds the quote.
   * Their verdict is merged with the first one's, which keeps precedence.
   */
  moreCandidates?: () => Promise<readonly QuoteTargetCandidate[]>;
  /** The wordings to verify, best first. */
  searchTexts: readonly string[];
  /** The fuller displayed passage, which the jump tries before the quote. */
  preferredFullQuoteText?: string;
  /** The citation label the jump logs. */
  displayCitationLabel: string;
  /** Whether a candidate whose text would not read may open in the viewer. */
  openableInViewer?: (contextItemId: number) => boolean;
  certificate?: QuoteNavigationCertificate;
  policy: QuoteNavigationPolicy;
  /** Called with each timing stage the caller may want to record. */
  trace?: (stage: string, details?: unknown) => void;
};

export type QuoteNavigationOutcome =
  /** The quote was found and highlighted. */
  | {
      kind: "jumped";
      tier: QuoteNavigationTier;
      contextItemId: number;
      pageIndex: number;
      pageLabel: string;
      jump: ExactQuoteJumpResult;
      /**
       * Set when the page holds the quote this many times and nothing
       * recorded which copy the answer quoted; the first is highlighted.
       */
      samePageCopyCount?: number;
    }
  /** The reader is on the verified page, but the highlight failed. */
  | {
      kind: "page-only";
      contextItemId: number;
      pageIndex: number;
      pageLabel: string;
      jump: ExactQuoteJumpResult;
      /**
       * The paper holds the quote, but its PDF is not the one the answer
       * quoted (another copy or version), and no other paper held it.
       */
      differentCopy?: true;
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
 * Move the reader to a quote and report what happened. Nothing here touches
 * the status line or the button.
 *
 * Every candidate's PDF text is read in the background first, and only the
 * paper found to hold the quote is opened, at the page it was found on. A PDF
 * whose text cannot be read in the background is opened in the viewer
 * instead, a few at most, and must hold the quote there before the reader
 * moves to it. No cached page or page hint opens or moves a reader before
 * the quote is verified.
 */
export async function navigateToQuote(
  req: QuoteNavigationRequest,
  deps: QuoteNavigatorDeps = defaultQuoteNavigatorDeps,
): Promise<QuoteNavigationOutcome> {
  if (!req.searchTexts.length) return { kind: "no-candidates" };
  if (!req.candidates.length) {
    return req.policy.activeReaderFallback
      ? navigateInActiveReader(req, deps)
      : { kind: "no-candidates" };
  }
  const candidatesByContextItemId = new Map(
    req.candidates.map((candidate) => [candidate.contextItemId, candidate]),
  );
  const certificate = req.certificate || {};
  const recorded: RecordedQuoteLocation | undefined = req.certificate
    ? {
        pageIndex: certificate.pageIndex,
        occurrence: certificate.sourceMatchPageOccurrence,
      }
    : undefined;
  // A jump that finds another PDF than the certificate names rules that
  // attachment out, and so does a viewer read that found no quote; the rest
  // are verified again without them.
  const ruledOut = new Set<number>();
  const notRuledOut = (candidates: readonly QuoteTargetCandidate[]) =>
    candidates.filter((candidate) => !ruledOut.has(candidate.contextItemId));
  const verifyCandidates = (candidates: readonly QuoteTargetCandidate[]) =>
    resolveVerifiedQuoteTarget({
      candidates,
      searchTexts: req.searchTexts,
      verify: (candidate, quoteText) =>
        recorded
          ? deps.verifyInBackground(candidate, quoteText, recorded)
          : deps.verifyInBackground(candidate, quoteText),
    });
  let fallbackCandidates: QuoteTargetCandidate[] | null = null;
  let viewerOpensLeft = MAX_OPENED_QUOTE_VERIFICATION_CANDIDATES;
  let wrongPdf: QuoteNavigationOutcome | null = null;

  for (;;) {
    let resolution = await verifyCandidates(notRuledOut(req.candidates));
    if (resolution.status !== "resolved" && req.moreCandidates) {
      // The first papers did not hold the quote after all (for a recorded
      // paper, its item id may have been reused, or its text may not
      // extract). Rather than dead-end, look further, once per click.
      if (!fallbackCandidates) {
        const searched = await req.moreCandidates();
        fallbackCandidates = searched.filter(
          (candidate) =>
            !candidatesByContextItemId.has(candidate.contextItemId),
        );
        for (const candidate of fallbackCandidates) {
          candidatesByContextItemId.set(candidate.contextItemId, candidate);
        }
      }
      const remaining = notRuledOut(fallbackCandidates);
      if (remaining.length) {
        // Only the papers the first pass skipped are re-read, so the second
        // verdict covers fewer papers than the click does.  Merging keeps the
        // first papers' standing — a scanned PDF stays eligible for the viewer
        // fallback instead of being written off by a search that failed
        // somewhere else.
        resolution = mergeQuoteTargetResolutions({
          recorded: resolution,
          searched: await verifyCandidates(remaining),
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
          ...(resolution.samePageCopyCount !== undefined
            ? { samePageCopyCount: resolution.samePageCopyCount }
            : {}),
        };
      }
    } else if (resolution.status === "unverifiable") {
      // Background text extraction failed for these; fall back to the viewer.
      const opened = await locateQuoteByOpeningCitationCandidates(
        {
          candidates: resolution.contextItemIds
            .map((contextItemId) =>
              candidatesByContextItemId.get(contextItemId),
            )
            .filter(
              (candidate): candidate is QuoteTargetCandidate =>
                Boolean(candidate) &&
                (req.openableInViewer?.(candidate!.contextItemId) ?? true),
            ),
          searchTexts: req.searchTexts,
          limit: viewerOpensLeft,
          recorded,
        },
        deps,
      );
      viewerOpensLeft -= opened.attempted;
      for (const contextItemId of opened.missed) ruledOut.add(contextItemId);
      match = opened.matches[0] || null;
      if (opened.reason) lastReason = opened.reason;
      if (!match && !opened.reason) lastReason = resolution.reason;
    } else {
      lastReason = resolution.reason;
    }

    if (!match) {
      if (wrongPdf) return wrongPdf;
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
      deps.pageLabelFor(reader, match.pageIndex) || match.pageLabel;

    const jump = await deps.jump({
      reader,
      contextItemId,
      displayCitationLabel: req.displayCitationLabel,
      quoteText: match.quoteText,
      pageIndex: match.pageIndex,
      ...(pageLabel ? { pageLabel } : {}),
      sourceMatchPageOccurrence:
        certificate.sourceMatchPageOccurrence ??
        match.sourceMatchPageOccurrence,
      verifiedSourceMatchText: match.sourceMatchText,
      ...answerJumpInputs(req),
      ...(req.policy.jumpFallbackTexts
        ? { fallbackQuoteTexts: req.searchTexts.slice() }
        : {}),
    });
    const landed = jumpedPage(
      reader,
      jump,
      { pageIndex: match.pageIndex, pageLabel },
      deps.pageLabelFor,
    );
    if (!jump.matched) {
      const pageOnly: QuoteNavigationOutcome = {
        kind: "page-only",
        contextItemId,
        pageIndex: landed.pageIndex,
        pageLabel: citationPageDisplayLabel(landed),
        jump,
      };
      if (jump.failureStage !== "source-fingerprint-mismatch") return pageOnly;
      // The quote is in this paper, but it is not the PDF the answer quoted
      // (a second copy or version). Try the others before settling here.
      ruledOut.add(contextItemId);
      wrongPdf = { ...pageOnly, differentCopy: true };
      continue;
    }
    if (req.policy.rememberPage) {
      deps.rememberPage(
        contextItemId,
        match.quoteText,
        landed.pageIndex,
        landed.pageLabel,
      );
    }
    return {
      kind: "jumped",
      tier: "verified",
      contextItemId,
      pageIndex: landed.pageIndex,
      pageLabel: citationPageDisplayLabel(landed),
      jump,
      // The copy count describes the duplicated quote. When the jump matched
      // a fuller passage instead, occurrence 0 picked that passage, which
      // may hold any of the copies.
      ...(match.samePageCopyCount !== undefined &&
      jump.wordingUsed === sanitizeText(match.quoteText || "").trim()
        ? { samePageCopyCount: match.samePageCopyCount }
        : {}),
    };
  }
}

/**
 * The page a jump left the reader on: the one FindController matched on,
 * which wins over the predicted page, else the predicted page. Its label is
 * the reader's printed label, when it reports one; none is guessed. Show it
 * with `citationPageDisplayLabel`.
 */
export function jumpedPage(
  reader: any,
  jump: ExactQuoteJumpResult,
  predicted: { pageIndex: number; pageLabel?: string },
  pageLabelFor: QuoteNavigatorDeps["pageLabelFor"] = getPageLabelForIndex,
): ReaderPageLocation {
  const matchedPageIndex = jump.matched ? jump.matchedPageIndex : undefined;
  const pageIndex = matchedPageIndex ?? predicted.pageIndex;
  // Read again: a reader just opened may report its labels only now.
  const pageLabel =
    pageLabelFor(reader, pageIndex) ||
    (pageIndex === predicted.pageIndex ? predicted.pageLabel : undefined);
  return pageLabel ? { pageIndex, pageLabel } : { pageIndex };
}

/**
 * What the answer itself recorded for the jump: its certificate and the
 * fuller passage it displayed. Absent for a quote with no such record.
 */
function answerJumpInputs(
  req: QuoteNavigationRequest,
): Partial<CitationParagraphJumpParams> {
  const certificate = req.certificate;
  return {
    ...(certificate
      ? {
          citationId: certificate.citationId,
          sourceFingerprint: certificate.sourceFingerprint,
          // Only the answer's own certificate turns on `verifiedFullSpan`:
          // for a passage verified here, it would switch off the page's
          // largest-unique-partial-span fallback the passage may need.
          verifiedFullSpan: certificate.verifiedFullSpan,
        }
      : {}),
    ...(req.preferredFullQuoteText
      ? { preferredFullQuoteText: req.preferredFullQuoteText }
      : {}),
  };
}

/**
 * With no candidate at all, look in the reader that is already open. Its
 * text is searched for the complete quote before the jump moves it.
 */
async function navigateInActiveReader(
  req: QuoteNavigationRequest,
  deps: QuoteNavigatorDeps,
): Promise<QuoteNavigationOutcome> {
  const activeReader = getActiveReaderForSelectedTab();
  if (!activeReader) {
    return { kind: "not-found", reason: "No PDF reader is currently open." };
  }
  const quoteText = req.searchTexts[0];
  const certificate = req.certificate || {};
  req.trace?.("full quote locate", { source: "active-reader", phase: "start" });
  const result = await deps.locateInReader(activeReader, quoteText, {
    exactOnly: true,
  });
  req.trace?.("full quote locate", {
    source: "active-reader",
    status: result.status,
    computedPageIndex: result.computedPageIndex,
  });
  if (result.status !== "resolved" || result.computedPageIndex === null) {
    return {
      kind: "not-found",
      reason:
        result.reason ||
        (result.status === "not-found"
          ? "The cited quote was not found in the paper text."
          : result.status === "ambiguous"
            ? "The cited quote matched multiple pages."
            : "Could not resolve the cited quote to a unique page."),
    };
  }
  const pageIndex = Math.floor(result.computedPageIndex);
  const pageLabel = deps.pageLabelFor(activeReader, pageIndex) || undefined;
  const contextItemId = getReaderItemId(activeReader);
  const jump = await deps.jump({
    reader: activeReader,
    contextItemId,
    displayCitationLabel: req.displayCitationLabel,
    quoteText,
    pageIndex,
    ...(pageLabel ? { pageLabel } : {}),
    sourceMatchPageOccurrence:
      certificate.sourceMatchPageOccurrence ?? result.sourceMatchPageOccurrence,
    verifiedSourceMatchText: result.sourceMatchText,
    ...answerJumpInputs(req),
  });
  req.trace?.("paragraph jump", {
    source: "full-quote-locate-active-reader",
    matched: jump.matched,
    matchedPageIndex: jump.matchedPageIndex,
  });
  // FindController's page wins if it landed somewhere other than the page
  // the text search predicted.
  const landed = jumpedPage(
    activeReader,
    jump,
    { pageIndex, pageLabel },
    deps.pageLabelFor,
  );
  if (!jump.matched) {
    return {
      kind: "page-only",
      contextItemId,
      pageIndex: landed.pageIndex,
      pageLabel: citationPageDisplayLabel(landed),
      jump,
    };
  }
  if (req.policy.rememberPage) {
    deps.rememberPage(
      contextItemId,
      quoteText,
      landed.pageIndex,
      landed.pageLabel,
    );
  }
  return {
    kind: "jumped",
    tier: "active-reader",
    contextItemId,
    pageIndex: landed.pageIndex,
    pageLabel: citationPageDisplayLabel(landed),
    jump,
  };
}
