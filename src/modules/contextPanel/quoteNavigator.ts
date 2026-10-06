/**
 * How a click on a quote moves the reader to it.
 *
 * `navigateToQuote` takes the papers a caller has already resolved, the
 * wordings of the quote, and a policy, and reports what happened. Two
 * strategies share it: "verify-first" (untrusted quotes, Task progress) reads
 * candidates in the background and opens only the winner; "hint-ladder"
 * (trusted quotes) opens the most likely page first and lets the jump verify
 * it. It owns the steps in between: opening a reader, the paragraph jump, and
 * the verified page cache. Callers keep what a user sees around a click:
 * status text, button state, busy guards, and any event they raise afterwards.
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
  lookupCachedQuoteLocationForAttachment,
  resolvePageIndexForLabel,
  scrollToExactQuoteInReader,
  verifyQuoteLocationForAttachment,
  warmQuoteLocationCacheForAttachment,
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
): string {
  return paragraphJump.navigationStatus === "paragraph-selected"
    ? `Jumped to cited source (page ${pageLabel}, paragraph matched)`
    : `Jumped to cited source (page ${pageLabel}, quote found; exact occurrence not selected)`;
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
// The trusted ladder's tiers

/** What a tier's jump did, on the reader that tier opened. */
type CitationParagraphJumpNavigation = {
  reader: any;
  contextItemId: number;
  pageIndex: number;
  pageLabel: string;
  paragraphJump: ExactQuoteJumpResult;
};

type QuoteNavigationProvenance = {
  citationId?: string;
  sourceFingerprint?: string;
  sourceMatchPageOccurrence?: number;
  preferredFullQuoteText?: string;
  verifiedSourceMatchText?: string;
  verifiedFullSpan?: boolean;
};

async function navigateToCachedCitationPage(
  contextItemId: number,
  quoteText: string,
  displayCitationLabel: string,
  provenance: QuoteNavigationProvenance | undefined,
  deps: QuoteNavigatorDeps,
): Promise<CitationParagraphJumpNavigation | null> {
  const cached = lookupCitationPage({ contextItemId, quoteText });
  if (!cached) return null;
  const targetPageIndex = Math.floor(cached.pageIndex);
  const targetPageLabel =
    typeof cached.pageLabel === "string" && cached.pageLabel.trim()
      ? cached.pageLabel.trim()
      : `${targetPageIndex + 1}`;

  const reader = await deps.openReader(contextItemId, {
    pageIndex: targetPageIndex,
    pageLabel: targetPageLabel,
  });
  if (!reader) return null;

  const paragraphJump = await deps.jump({
    reader,
    contextItemId,
    displayCitationLabel,
    quoteText,
    pageIndex: targetPageIndex,
    pageLabel: targetPageLabel,
    ...provenance,
  });
  return {
    reader,
    contextItemId,
    pageIndex: targetPageIndex,
    pageLabel: targetPageLabel,
    paragraphJump,
  };
}

async function navigateToHiddenQuoteLocation(
  params: {
    contextItemId: number;
    quoteText: string;
    displayCitationLabel: string;
    pageIndex: number;
    citationId?: string;
    sourceFingerprint?: string;
    sourceMatchPageOccurrence?: number;
    preferredFullQuoteText?: string;
    verifiedSourceMatchText?: string;
    verifiedFullSpan?: boolean;
  },
  deps: QuoteNavigatorDeps,
): Promise<CitationParagraphJumpNavigation | null> {
  const targetPageIndex = Math.floor(params.pageIndex);
  if (!Number.isFinite(targetPageIndex) || targetPageIndex < 0) return null;

  const reader = await deps.openReader(params.contextItemId, {
    pageIndex: targetPageIndex,
  });
  if (!reader) return null;

  const targetPageLabel =
    deps.pageLabelFor(reader, targetPageIndex) || `${targetPageIndex + 1}`;

  const paragraphJump = await deps.jump({
    reader,
    contextItemId: params.contextItemId,
    displayCitationLabel: params.displayCitationLabel,
    quoteText: params.quoteText,
    pageIndex: targetPageIndex,
    pageLabel: targetPageLabel,
    citationId: params.citationId,
    sourceFingerprint: params.sourceFingerprint,
    sourceMatchPageOccurrence: params.sourceMatchPageOccurrence,
    preferredFullQuoteText: params.preferredFullQuoteText,
    verifiedSourceMatchText: params.verifiedSourceMatchText,
    verifiedFullSpan: params.verifiedFullSpan,
  });
  return {
    reader,
    contextItemId: params.contextItemId,
    pageIndex: targetPageIndex,
    pageLabel: targetPageLabel,
    paragraphJump,
  };
}

async function navigateToStoredQuotePageHint(
  params: {
    contextItemId: number;
    quoteText: string;
    displayCitationLabel: string;
    pageHint: QuoteNavigationPageHint;
    citationId?: string;
    sourceFingerprint?: string;
    sourceMatchPageOccurrence?: number;
    preferredFullQuoteText?: string;
    verifiedFullSpan?: boolean;
    onReaderOpened?: () => void;
  },
  deps: QuoteNavigatorDeps,
): Promise<CitationParagraphJumpNavigation | null> {
  const hintedPageIndex =
    params.pageHint.pageIndex !== undefined
      ? Math.floor(params.pageHint.pageIndex)
      : undefined;
  const hintedPageLabel = sanitizeText(params.pageHint.pageLabel || "").trim();
  if (
    hintedPageIndex !== undefined &&
    (!Number.isFinite(hintedPageIndex) || hintedPageIndex < 0)
  ) {
    return null;
  }
  if (hintedPageIndex === undefined && !hintedPageLabel) return null;

  const reader =
    hintedPageIndex !== undefined
      ? await deps.openReader(params.contextItemId, {
          pageIndex: hintedPageIndex,
          pageLabel: hintedPageLabel || undefined,
        })
      : await deps.openReader(params.contextItemId);
  if (!reader) return null;
  params.onReaderOpened?.();

  let targetPageIndex = hintedPageIndex;
  if (targetPageIndex === undefined) {
    const resolvedPageIndex = resolvePageIndexForLabel(reader, hintedPageLabel);
    if (resolvedPageIndex === null) return null;
    targetPageIndex = resolvedPageIndex;
    await navigateReaderToPage(reader, targetPageIndex, hintedPageLabel);
  }

  const targetPageLabel =
    hintedPageLabel ||
    deps.pageLabelFor(reader, targetPageIndex) ||
    `${targetPageIndex + 1}`;

  const paragraphJump = await deps.jump({
    reader,
    contextItemId: params.contextItemId,
    displayCitationLabel: params.displayCitationLabel,
    quoteText: params.quoteText,
    pageIndex: targetPageIndex,
    pageLabel: targetPageLabel,
    citationId: params.citationId,
    sourceFingerprint: params.sourceFingerprint,
    sourceMatchPageOccurrence: params.sourceMatchPageOccurrence,
    preferredFullQuoteText: params.preferredFullQuoteText,
    verifiedFullSpan: params.verifiedFullSpan,
  });
  return {
    reader,
    contextItemId: params.contextItemId,
    pageIndex: targetPageIndex,
    pageLabel: targetPageLabel,
    paragraphJump,
  };
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
   *
   * "hint-ladder": open the most likely page first and let the jump verify
   * it there, falling through cached pages and hints to a full search (see
   * `navigateByHintLadder`).
   */
  strategy: "verify-first" | "hint-ladder";
  /** Record the page a successful jump landed on in the page cache. */
  rememberPage: boolean;
  /** verify-first: also hand the jump every search text as a wording. */
  jumpFallbackTexts?: boolean;
  /** hint-ladder: the full search accepts only the complete quote. */
  fullSearchExactOnly?: boolean;
  /**
   * hint-ladder: with no candidate at all, search the reader that is open.
   * A caller turns this on only when it resolved no candidate whatsoever.
   */
  activeReaderFallback?: boolean;
};

/** What the answer recorded about where its quote came from. */
export type QuoteNavigationCertificate = {
  citationId?: string;
  sourceFingerprint?: string;
  sourceMatchPageOccurrence?: number;
  /**
   * The quote matched the PDF.js text exactly, so the jump must highlight
   * the whole quote and not a partial span of it.
   */
  verifiedFullSpan?: boolean;
};

export type QuoteNavigationPageHint = {
  pageIndex?: number;
  pageLabel?: string;
};

/** hint-ladder: pages to try before a full search. */
export type QuoteNavigationHints = {
  /** A page stored with the quote, for the one candidate it applies to. */
  storedPage?: { contextItemId: number; pageHint: QuoteNavigationPageHint };
  /** A page label written in the citation; tried on the first candidate. */
  pageLabel?: string;
};

/** hint-ladder steps a caller may want to show while they run. */
export type QuoteNavigationProgress =
  | "opening-page-hint"
  | "verifying-page-hint"
  | "locating";

/** Which step found the quote. */
export type QuoteNavigationTier =
  | "verified"
  | "verified-cache"
  | "hidden-cache"
  | "stored-page-hint"
  | "explicit-page-hint"
  | "full-search-active-reader"
  | "full-search-candidate";

export type QuoteNavigationRequest = {
  /** The papers to try, as the caller resolved and ranked them. */
  candidates: readonly QuoteTargetCandidate[];
  /**
   * verify-first: more papers, asked for only when none of `candidates`
   * holds the quote. Their verdict is merged with the first one's, which
   * keeps precedence.
   */
  moreCandidates?: () => Promise<readonly QuoteTargetCandidate[]>;
  /**
   * The wordings to verify, best first. The hint ladder searches for the
   * first one only.
   */
  searchTexts: readonly string[];
  /** hint-ladder: the fuller displayed passage, tried before the quote. */
  preferredFullQuoteText?: string;
  /** The citation label the jump logs. */
  displayCitationLabel: string;
  /** verify-first: whether a candidate may be opened in the viewer. */
  openableInViewer?: (contextItemId: number) => boolean;
  certificate?: QuoteNavigationCertificate;
  hints?: QuoteNavigationHints;
  policy: QuoteNavigationPolicy;
  /** Called with each timing stage the caller may want to record. */
  trace?: (stage: string, details?: unknown) => void;
  /** Called as hint-ladder steps start. */
  onProgress?: (step: QuoteNavigationProgress) => void;
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
    }
  /** The reader is on the verified page, but the highlight failed. */
  | {
      kind: "page-only";
      contextItemId: number;
      pageIndex: number;
      pageLabel: string;
      jump: ExactQuoteJumpResult;
    }
  /**
   * No candidate holds the quote. For the hint ladder: every tier missed,
   * and `reason` is the last one's.
   */
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
  return req.policy.strategy === "hint-ladder"
    ? navigateByHintLadder(req, deps)
    : navigateVerifyFirst(req, deps);
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
    tier: "verified",
    contextItemId,
    pageIndex: jumpedPageIndex,
    pageLabel: jumpedLabel,
    jump,
  };
}

/**
 * The trusted ladder: try the cheapest known page first and fall through
 * on any failed jump. The verified page cache, then the hidden quote-location
 * cache, then the stored page hint, then the citation's own page label, then
 * a full search of each candidate (or, with none, of the active reader).
 * Every tier opens the reader before the quote is verified there (D1).
 */
async function navigateByHintLadder(
  req: QuoteNavigationRequest,
  deps: QuoteNavigatorDeps,
): Promise<QuoteNavigationOutcome> {
  const quoteText = req.searchTexts[0] || "";
  const displayCitationLabel = req.displayCitationLabel;
  const certificate = req.certificate || {};
  const preferredFullQuoteText = req.preferredFullQuoteText;
  const verifiedFullSpan = certificate.verifiedFullSpan;
  const trace = (stage: string, details?: unknown) =>
    req.trace?.(stage, details);
  let lastReason = "Could not resolve the cited quote to a unique page.";

  // A matched jump ends the click on the page it landed on; a failed one is
  // only the latest reason, and the next tier runs.
  const settle = (
    tier: QuoteNavigationTier,
    navigation: CitationParagraphJumpNavigation,
  ): QuoteNavigationOutcome | null => {
    // FindController's page wins if it landed somewhere different than the
    // (possibly wrong) page this tier opened.
    const effectiveLabel = resolveJumpedPageLabel(
      navigation.reader,
      navigation.paragraphJump,
      navigation.pageLabel,
      deps.pageLabelFor,
    );
    if (!navigation.paragraphJump.matched) {
      lastReason = buildParagraphJumpFailureStatus(
        effectiveLabel,
        navigation.paragraphJump,
      );
      return null;
    }
    const pageIndex =
      navigation.paragraphJump.matchedPageIndex ?? navigation.pageIndex;
    if (req.policy.rememberPage) {
      deps.rememberPage(
        navigation.contextItemId,
        quoteText,
        pageIndex,
        effectiveLabel,
      );
    }
    return {
      kind: "jumped",
      tier,
      contextItemId: navigation.contextItemId,
      pageIndex,
      pageLabel: effectiveLabel,
      jump: navigation.paragraphJump,
    };
  };

  // Verified page cache. The caller has already dropped candidates that are
  // not auto-navigable, so a stale entry from whatever PDF happens to be open
  // cannot win over the cited paper.
  for (const candidate of req.candidates) {
    const cached = await navigateToCachedCitationPage(
      candidate.contextItemId,
      quoteText,
      displayCitationLabel,
      {
        citationId: certificate.citationId,
        sourceFingerprint: certificate.sourceFingerprint,
        sourceMatchPageOccurrence: certificate.sourceMatchPageOccurrence,
        preferredFullQuoteText,
        verifiedFullSpan,
      },
      deps,
    );
    if (cached) {
      trace("cache lookup", {
        cache: "verified-page",
        contextItemId: cached.contextItemId,
      });
      const settled = settle("verified-cache", cached);
      if (settled) return settled;
      // A stale/early cache miss is not a verdict. Continue to the full
      // live-PDF locator before deciding that a quote is unsearchable.
    }
  }
  trace("cache lookup", { cache: "verified-page", result: "miss" });

  // Hidden page-index cache — never shown during render, but lets click
  // navigation jump to the likely page immediately before FindController
  // verifies/refines the paragraph and page label.
  for (const candidate of req.candidates) {
    const hiddenLocation =
      lookupCachedQuoteLocationForAttachment(
        candidate.contextItemId,
        quoteText,
      ) ??
      (await warmQuoteLocationCacheForAttachment(
        candidate.contextItemId,
        quoteText,
      ));
    if (!hiddenLocation) continue;
    const cached = await navigateToHiddenQuoteLocation(
      {
        contextItemId: candidate.contextItemId,
        quoteText,
        displayCitationLabel,
        pageIndex: hiddenLocation.pageIndex,
        citationId: certificate.citationId,
        sourceFingerprint:
          certificate.sourceFingerprint || hiddenLocation.sourceFingerprint,
        sourceMatchPageOccurrence:
          certificate.sourceMatchPageOccurrence ??
          hiddenLocation.sourceMatchPageOccurrence,
        preferredFullQuoteText,
        verifiedSourceMatchText: hiddenLocation.sourceMatchText,
        verifiedFullSpan,
      },
      deps,
    );
    if (!cached) continue;
    trace("cache lookup", {
      cache: "hidden-quote-location",
      contextItemId: cached.contextItemId,
    });
    const settled = settle("hidden-cache", cached);
    if (settled) return settled;
    // The hidden cache is only a fast page hint. Failed verification falls
    // through to an exhaustive live search.
  }
  trace("cache lookup", { cache: "hidden-quote-location", result: "miss" });

  // Stored quote page hint — non-authoritative fast first paint after
  // verified caches miss. navigateToStoredQuotePageHint calls deps.jump
  // (attemptCitationParagraphJump), and failures continue to full
  // quote-location fallback instead of treating the hinted page as proof.
  const storedPage = req.hints?.storedPage;
  if (storedPage) {
    req.onProgress?.("opening-page-hint");
    const hinted = await navigateToStoredQuotePageHint(
      {
        contextItemId: storedPage.contextItemId,
        quoteText,
        displayCitationLabel,
        pageHint: storedPage.pageHint,
        citationId: certificate.citationId,
        sourceFingerprint: certificate.sourceFingerprint,
        sourceMatchPageOccurrence: certificate.sourceMatchPageOccurrence,
        preferredFullQuoteText,
        verifiedFullSpan,
        onReaderOpened: () => {
          trace("hint open", {
            contextItemId: storedPage.contextItemId,
            pageHint: storedPage.pageHint,
          });
          req.onProgress?.("verifying-page-hint");
        },
      },
      deps,
    );
    if (hinted) {
      trace("paragraph jump", {
        source: "stored-page-hint",
        contextItemId: hinted.contextItemId,
        matched: hinted.paragraphJump.matched,
        matchedPageIndex: hinted.paragraphJump.matchedPageIndex,
      });
      const settled = settle("stored-page-hint", hinted);
      if (settled) return settled;
      // Wrong or unverified stored hint: continue to full quote-location fallback.
    } else {
      trace("hint open", {
        result: "unresolved",
        pageHint: storedPage.pageHint,
      });
    }
  }

  // Use the explicit page as a navigation hint only when we do not already
  // have a verified cached page for this quote. The cache stores the
  // authoritative page after eager resolution or a FindController jump.
  const explicitPageLabel = req.hints?.pageLabel || "";
  if (explicitPageLabel) {
    const bestRanked = req.candidates[0];
    if (bestRanked) {
      const target = await deps.openReader(bestRanked.contextItemId);
      if (target) {
        const pageIndex = resolvePageIndexForLabel(target, explicitPageLabel);
        if (pageIndex === null) {
          lastReason = `Could not resolve cited page label "${explicitPageLabel}".`;
        } else {
          const paragraphJump = await deps.jump({
            reader: target,
            contextItemId: bestRanked.contextItemId,
            displayCitationLabel,
            quoteText,
            pageIndex,
            pageLabel: explicitPageLabel,
            citationId: certificate.citationId,
            sourceFingerprint: certificate.sourceFingerprint,
            sourceMatchPageOccurrence: certificate.sourceMatchPageOccurrence,
            preferredFullQuoteText,
            verifiedFullSpan,
          });
          const settled = settle("explicit-page-hint", {
            reader: target,
            contextItemId: bestRanked.contextItemId,
            pageIndex,
            pageLabel: explicitPageLabel,
            paragraphJump,
          });
          if (settled) return settled;
          // A rendered page label is only a hint. Continue through the full
          // PDF text before returning a failure.
        }
      }
    }
  }

  req.onProgress?.("locating");

  // Last-resort: if there are still no candidates, try the active reader
  // directly without needing a candidate entry.
  if (req.policy.activeReaderFallback && !req.candidates.length) {
    const activeReader = getActiveReaderForSelectedTab();
    if (activeReader) {
      trace("full quote locate", { source: "active-reader", phase: "start" });
      const result = await deps.locateInReader(activeReader, quoteText, {
        exactOnly: req.policy.fullSearchExactOnly,
      });
      trace("full quote locate", {
        source: "active-reader",
        status: result.status,
        computedPageIndex: result.computedPageIndex,
      });
      if (result.status === "resolved" && result.computedPageIndex !== null) {
        const pageIndex = Math.floor(result.computedPageIndex);
        const pageLabel =
          deps.pageLabelFor(activeReader, pageIndex) || `${pageIndex + 1}`;
        const contextItemId = getReaderItemId(activeReader);
        const paragraphJump = await deps.jump({
          reader: activeReader,
          contextItemId,
          displayCitationLabel,
          quoteText,
          pageIndex,
          pageLabel,
          citationId: certificate.citationId,
          sourceFingerprint: certificate.sourceFingerprint,
          sourceMatchPageOccurrence:
            certificate.sourceMatchPageOccurrence ??
            result.sourceMatchPageOccurrence,
          preferredFullQuoteText,
          verifiedSourceMatchText: result.sourceMatchText,
          verifiedFullSpan,
        });
        trace("paragraph jump", {
          source: "full-quote-locate-active-reader",
          matched: paragraphJump.matched,
          matchedPageIndex: paragraphJump.matchedPageIndex,
        });
        const settled = settle("full-search-active-reader", {
          reader: activeReader,
          contextItemId,
          pageIndex,
          pageLabel,
          paragraphJump,
        });
        if (settled) return settled;
      }
      if (result.status !== "resolved") {
        if (result.reason) lastReason = result.reason;
        else if (result.status === "not-found")
          lastReason = "The cited quote was not found in the paper text.";
        else if (result.status === "ambiguous")
          lastReason = "The cited quote matched multiple pages.";
      }
    } else {
      lastReason = "No PDF reader is currently open.";
    }
  }

  for (const candidate of req.candidates) {
    const reader = await deps.openReader(candidate.contextItemId);
    if (!reader) {
      lastReason = "Could not open the cited paper.";
      continue;
    }
    trace("full quote locate", {
      source: "candidate",
      contextItemId: candidate.contextItemId,
      phase: "start",
    });
    const result = await deps.locateInReader(reader, quoteText, {
      exactOnly: req.policy.fullSearchExactOnly,
    });
    trace("full quote locate", {
      source: "candidate",
      contextItemId: candidate.contextItemId,
      status: result.status,
      computedPageIndex: result.computedPageIndex,
    });
    if (result.status === "resolved" && result.computedPageIndex !== null) {
      const pageIndex = Math.floor(result.computedPageIndex);
      const pageLabel =
        deps.pageLabelFor(reader, pageIndex) || `${pageIndex + 1}`;
      const paragraphJump = await deps.jump({
        reader,
        contextItemId: candidate.contextItemId,
        displayCitationLabel,
        quoteText,
        pageIndex,
        pageLabel,
        citationId: certificate.citationId,
        sourceFingerprint: certificate.sourceFingerprint,
        sourceMatchPageOccurrence:
          certificate.sourceMatchPageOccurrence ??
          result.sourceMatchPageOccurrence,
        preferredFullQuoteText,
        verifiedSourceMatchText: result.sourceMatchText,
        verifiedFullSpan,
      });
      trace("paragraph jump", {
        source: "full-quote-locate-candidate",
        contextItemId: candidate.contextItemId,
        matched: paragraphJump.matched,
        matchedPageIndex: paragraphJump.matchedPageIndex,
      });
      const settled = settle("full-search-candidate", {
        reader,
        contextItemId: candidate.contextItemId,
        pageIndex,
        pageLabel,
        paragraphJump,
      });
      if (settled) return settled;
      continue;
    }
    if (result.reason) {
      lastReason = result.reason;
    } else if (result.status === "ambiguous") {
      lastReason = "The cited quote matched multiple pages.";
    } else if (result.status === "not-found") {
      lastReason = "The cited quote was not found in the paper text.";
    }
  }

  return { kind: "not-found", reason: lastReason };
}
