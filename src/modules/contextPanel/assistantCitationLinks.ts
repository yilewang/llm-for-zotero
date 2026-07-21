import { sanitizeText, setStatus } from "./textUtils";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
  isTextLikeAttachmentSourceMode,
  resolvePaperContextDisplayRef,
  resolvePaperContextRefFromAttachment,
  type PaperContextDisplayCache,
} from "./paperAttribution";
import {
  normalizePaperContextRefs,
  normalizeSelectedTextPaperContexts,
} from "./normalizers";
import {
  findMatchingTrustedQuoteCitation,
  normalizeQuoteCitations,
  QUOTE_CITATION_PATTERN,
  stripQuoteCitationAnchorsFromDisplayText,
} from "./quoteCitations";
import {
  buildQuoteRenderPlan,
  getMessageQuoteDisplay,
  QUOTE_RENDER_OCCURRENCE_PATTERN,
  type QuoteRenderOccurrence,
} from "./quoteRenderPlan";
import { stripLeadingCitationSeparators } from "./citationText";
import {
  extractCitationAuthorKey,
  extractCitationYear,
  isCitationControlCharCode,
  isLikelyStandaloneSourceCitationLabel,
  normalizeCitationKey,
  normalizeCitationLabel,
  parseStandaloneCitationLabel,
  stripCitationControlChars,
  stripCitationKeyFromLabel,
} from "./citationLabelParser";
import {
  buildAutoNavigableCitationCandidateKeys as buildResolverAutoNavigableCitationCandidateKeys,
  rankCitationResolverCandidate,
  type CitationResolverCandidate,
  type RankedCitationCandidate,
} from "./citationCandidateResolver";
import {
  getActiveReaderForSelectedTab,
  resolveContextSourceItem,
} from "./contextResolution";
import { persistPendingChatScrollRestoreForElement } from "./chatScrollSnapshots";
import { isPdfContextAttachment } from "./contextAttachmentSupport";
import {
  buildCitationQuoteHash,
  clearCitationPageCache,
  lookupCitationPage,
  rememberCitationPage,
} from "./citationNavigationCache";
import {
  type ExactQuoteJumpResult,
  locateQuoteInLivePdfReader,
  getPageLabelForIndex,
  lookupCachedQuoteLocationForAttachment,
  resolvePageIndexForLabel,
  scrollToExactQuoteInReader,
  warmPageTextCache,
  warmQuoteLocationCacheForAttachment,
} from "./livePdfSelectionLocator";
import { resolveConversationBaseItem } from "./portalScope";
import { searchPaperCandidates } from "./paperSearch";
import { resolveQuoteCitationLookupText } from "./quoteNavigationText";
import {
  beginQuoteNavigationActivity,
  QUOTE_PROVENANCE_REVALIDATION_REQUEST_EVENT,
} from "./quoteValidationActivity";
import { renderRenderedMarkdownInto } from "./renderedMarkdown";
import type { Message, PaperContextRef, QuoteCitation } from "./types";

type CitationParagraphJumpNavigation = {
  reader: any;
  contextItemId: number;
  pageIndex: number;
  pageLabel: string;
  paragraphJump: ExactQuoteJumpResult;
};

type QuoteCitationPageHint = {
  pageIndex?: number;
  pageLabel?: string;
};

type QuoteNavigationProvenance = {
  citationId?: string;
  sourceFingerprint?: string;
  sourceMatchPageOccurrence?: number;
  preferredFullQuoteText?: string;
  verifiedSourceMatchText?: string;
};

type CitationCandidateProvenance =
  | "message-context"
  | "quote-citation"
  | "active-reader"
  | "base-paper"
  | "library-search";
type EffectiveCitationCandidateProvenance =
  | CitationCandidateProvenance
  | "unknown";

type CitationNavigationTiming = {
  startedAt: number;
  marks: Array<{ stage: string; elapsedMs: number; details?: unknown }>;
};

const citationButtonCandidateCache = new WeakMap<
  HTMLButtonElement,
  AssistantCitationPaperCandidate[]
>();

const citationButtonQuoteCitationCache = new WeakMap<
  HTMLButtonElement,
  QuoteCitation
>();

type CitationNavigationMode =
  | "inline-citation"
  | "trusted-quote"
  | "untrusted-quote";

type QuoteCitationTrust = "trusted-anchor" | "source-backed-unverified";

const citationButtonNavigationModeCache = new WeakMap<
  HTMLButtonElement,
  CitationNavigationMode
>();

function getCitationNavigationMode(
  button: HTMLButtonElement,
  hasQuoteText: boolean,
): CitationNavigationMode {
  const cached = citationButtonNavigationModeCache.get(button);
  if (cached) return cached;
  const raw = button.dataset.citationNavigationMode;
  if (
    raw === "inline-citation" ||
    raw === "trusted-quote" ||
    raw === "untrusted-quote"
  ) {
    return raw;
  }
  return hasQuoteText ? "trusted-quote" : "inline-citation";
}

function allowLibrarySearchForCitationNavigation(params: {
  navigationMode: CitationNavigationMode;
  hasQuoteText: boolean;
  staticCandidateCount: number;
}): boolean {
  return (
    params.navigationMode === "inline-citation" &&
    !params.hasQuoteText &&
    params.staticCandidateCount === 0
  );
}

function startCitationNavigationTiming(): CitationNavigationTiming {
  return { startedAt: Date.now(), marks: [] };
}

function markCitationNavigationTiming(
  timing: CitationNavigationTiming,
  stage: string,
  details?: unknown,
): void {
  timing.marks.push({
    stage,
    elapsedMs: Date.now() - timing.startedAt,
    details,
  });
}

function logCitationNavigationTiming(
  timing: CitationNavigationTiming,
  outcome: string,
): void {
  ztoolkit.log("LLM citation navigation timing", {
    outcome,
    totalMs: Date.now() - timing.startedAt,
    marks: timing.marks,
  });
}

function resolveQuoteCitationPageHint(
  citation: QuoteCitation | null | undefined,
): QuoteCitationPageHint | null {
  if (!citation) return null;
  const rawPageIndex = Number(citation.pageHintIndex);
  const pageIndex =
    Number.isFinite(rawPageIndex) && rawPageIndex >= 0
      ? Math.floor(rawPageIndex)
      : undefined;
  const pageLabel = sanitizeText(citation.pageHintLabel || "").trim();
  if (pageIndex === undefined && !pageLabel) return null;
  const hint: QuoteCitationPageHint = {};
  if (pageIndex !== undefined) hint.pageIndex = pageIndex;
  if (pageLabel) hint.pageLabel = pageLabel;
  return hint;
}

export const resolveQuoteCitationPageHintForTests =
  resolveQuoteCitationPageHint;

export type AssistantCitationPaperCandidate = {
  paperContext: PaperContextRef;
  displayPaperContext: PaperContextRef;
  contextItemId: number;
  sourceLabel: string;
  citationLabel: string;
  displaySourceLabel: string;
  displayCitationLabel: string;
  normalizedSourceLabel: string;
  normalizedCitationLabel: string;
  normalizedDisplaySourceLabel: string;
  normalizedDisplayCitationLabel: string;
  provenance?: CitationCandidateProvenance;
};

type ExtractedCitationLabel = {
  sourceLabel: string;
  citationLabel: string;
  displayCitationLabel: string;
  citationKey?: string;
  pageLabel?: string;
  normalizedSourceLabel: string;
  normalizedCitationLabel: string;
  normalizedDisplayCitationLabel: string;
  normalizedCitationKey?: string;
};

type BlockquoteTailCitationMatch = {
  quoteText: string;
  extractedCitation: ExtractedCitationLabel;
};

type InlineCitationMatch = {
  start: number;
  end: number;
  rawText: string;
  extractedCitation: ExtractedCitationLabel;
};

type GroupedInlineCitationSegment = {
  relativeStart: number;
  relativeEnd: number;
  extractedCitation: ExtractedCitationLabel;
};

type GroupedInlineCitationParseResult = {
  attempted: boolean;
  segments: GroupedInlineCitationSegment[];
};

export const INLINE_CITATION_SKIP_SELECTOR = [
  "blockquote",
  "button",
  "a",
  "code",
  "pre",
  ".llm-paper-citation-row",
  ".llm-paper-citation-link",
  ".llm-citation-row-container",
  ".llm-citation-row",
  ".llm-citation-inline-wrap",
  ".llm-citation-text",
  ".llm-citation-icon",
  ".llm-quote-citation-anchor",
  ".llm-quote-card",
].join(", ");

const INLINE_CITATION_PATTERN =
  /(\([^()]+?\)(?:\s*\[[^\]]+\])?(?:\s*,?\s*page\s+[^,.;:!?]+)?)/gi;
const INLINE_NARRATIVE_CITATION_PATTERN =
  /\b([A-Z][\p{L}'’.-]+(?:\s+(?:and|&)\s+[A-Z][\p{L}'’.-]+)?(?:\s+et\s+al\.?)?)\s*\(\s*((?:19|20)\d{2}[a-z]?)\s*\)/gu;
const INLINE_NARRATIVE_COMMA_CITATION_PATTERN =
  /\b([A-Z][\p{L}'’.-]+(?:\s+(?:and|&)\s+[A-Z][\p{L}'’.-]+)?(?:\s+et\s+al\.?)?)\s*,\s*((?:19|20)\d{2}[a-z]?)\b/gu;

type CitationMatchBuffer = {
  cleanText: string;
  cleanToOriginalIndex: number[];
};

const INLINE_CITATION_LEADING_CUE_PATTERN =
  /^(?:e\.?\s*g\.?|i\.?\s*e\.?|see(?:\s+also)?|cf\.?|compare|for\s+example|for\s+instance|such\s+as|as\s+in|and\b|&)\s*[:,]?\s*/i;

function buildCitationMatchBuffer(source: string): CitationMatchBuffer {
  const cleanToOriginalIndex: number[] = [];
  let cleanText = "";
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (isCitationControlCharCode(code)) continue;
    cleanToOriginalIndex.push(index);
    cleanText += source[index];
  }
  return { cleanText, cleanToOriginalIndex };
}

function mapCleanRangeToSourceRange(
  cleanStart: number,
  cleanEnd: number,
  cleanToOriginalIndex: number[],
): { start: number; end: number } | null {
  if (!cleanToOriginalIndex.length) return null;
  if (!Number.isFinite(cleanStart) || !Number.isFinite(cleanEnd)) return null;
  const boundedStart = Math.max(0, Math.floor(cleanStart));
  const boundedEnd = Math.max(boundedStart + 1, Math.floor(cleanEnd));
  if (boundedStart >= cleanToOriginalIndex.length) return null;
  const sourceStart = cleanToOriginalIndex[boundedStart];
  const sourceEndIndex =
    cleanToOriginalIndex[
      Math.min(cleanToOriginalIndex.length - 1, boundedEnd - 1)
    ];
  return {
    start: sourceStart,
    end: sourceEndIndex + 1,
  };
}

function isYearOnlyCitationLabel(value: string): boolean {
  const normalized = normalizeCitationLabel(value).replace(/[()]/g, "").trim();
  return /^(?:19|20)\d{2}[a-z]?$/.test(normalized);
}

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

export function clearCachedCitationPagesForTests(): void {
  clearCitationPageCache();
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

export function formatSourceLabelWithPage(
  baseSourceLabel: string,
  pageLabel: string,
): string {
  if (!pageLabel) return baseSourceLabel;
  const match = baseSourceLabel.match(/^\((.+)\)$/);
  if (!match) return baseSourceLabel;
  return `(${match[1]}, page ${pageLabel})`;
}

export function formatUnverifiedCitationChipLabel(
  displayCitationLabel: string,
): string {
  return stripCitationKeyFromLabel(displayCitationLabel)
    .replace(/,?\s*page\s+[^,)]+/i, "")
    .trim();
}

function formatCitationDisplayTextWithPage(
  displayCitationLabel: string,
  pageLabel?: string,
): string {
  const cleanCitation = formatUnverifiedCitationChipLabel(displayCitationLabel);
  const cleanPage = sanitizeText(pageLabel || "").trim();
  if (!cleanPage) return cleanCitation;
  if (cleanCitation.endsWith(")")) {
    return cleanCitation.replace(/\)$/, `, page ${cleanPage})`);
  }
  return `${cleanCitation}, page ${cleanPage}`;
}

function setCitationButtonLabel(
  button: HTMLButtonElement,
  displayCitationLabel: string,
  pageLabel?: string,
): void {
  const labelText = formatCitationDisplayTextWithPage(
    displayCitationLabel,
    pageLabel,
  );
  // In the new icon-based layout the text span is a sibling of the button
  // inside a shared .llm-citation-row / .llm-citation-inline-wrap container.
  const container = button.parentElement;
  const textSpan = container?.querySelector(
    ".llm-citation-text",
  ) as HTMLSpanElement | null;
  if (textSpan) {
    const rawText = textSpan.dataset.rawText;
    if (rawText) {
      textSpan.textContent = formatCitationDisplayTextWithPage(
        rawText,
        pageLabel,
      );
    } else {
      textSpan.textContent = labelText;
    }
  }
  button.setAttribute("aria-label", `Jump to cited source: ${labelText}`);
}

function getCitationBaseLabelForRefresh(textSpan: Element): string {
  const rawText = sanitizeText(
    (textSpan as HTMLElement).dataset?.rawText || "",
  ).trim();
  if (rawText) return rawText;
  const currentText = sanitizeText(textSpan.textContent || "").trim();
  if (!currentText) return "";
  return currentText.replace(/,\s*page\s+[^,)]*(\))$/i, "$1").trim();
}

function normalizeQuoteKey(value: string): string {
  return sanitizeText(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseCitationContextItemIds(value: unknown): number[] {
  const raw = sanitizeText(String(value || "")).trim();
  if (!raw) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const part of raw.split(",")) {
    const parsed = Number(part.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    const id = Math.floor(parsed);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function buildCitationContextItemIdsDataset(
  candidates: AssistantCitationPaperCandidate[],
): string {
  return candidates
    .map((candidate) => Math.floor(Number(candidate.contextItemId)))
    .filter((id) => Number.isFinite(id) && id > 0)
    .filter((id, index, all) => all.indexOf(id) === index)
    .join(",");
}

function lookupCachedCitationPageForContextIds(
  contextItemIds: number[],
  quoteText: string,
): string | null {
  const normalizedQuoteText = sanitizeText(quoteText || "").trim();
  if (!normalizedQuoteText) return null;
  for (const contextItemId of contextItemIds) {
    const cached = lookupCitationPage({
      contextItemId,
      quoteText: normalizedQuoteText,
    });
    const pageLabel = sanitizeText(cached?.pageLabel || "").trim();
    if (pageLabel) return pageLabel;
  }
  return null;
}

export function lookupCachedCitationPageForContextIdsForTests(
  contextItemIds: string,
  quoteText: string,
): string | null {
  return lookupCachedCitationPageForContextIds(
    parseCitationContextItemIds(contextItemIds),
    quoteText,
  );
}

function citationButtonsShareContext(
  left: HTMLButtonElement,
  right: HTMLButtonElement,
): boolean {
  const leftIds = parseCitationContextItemIds(
    left.dataset.citationContextItemIds,
  );
  const rightIds = parseCitationContextItemIds(
    right.dataset.citationContextItemIds,
  );
  if (!leftIds.length || !rightIds.length) return false;
  const rightIdSet = new Set(rightIds);
  return leftIds.some((id) => rightIdSet.has(id));
}

function extractStoredCitationYear(value: unknown): string | undefined {
  const text = sanitizeText(String(value || "")).trim();
  if (!text) return undefined;
  const match = text.match(/\b(19|20)\d{2}\b/);
  return match?.[0];
}

function formatStoredPaperCitationLabel(
  paperContext: PaperContextRef | null | undefined,
): string {
  if (!paperContext) return "Paper";
  const creator = sanitizeText(paperContext.firstCreator || "").trim();
  const year = extractStoredCitationYear(paperContext.year);
  if (creator) {
    return year ? `${creator}, ${year}` : creator;
  }
  const fallbackId =
    Number.isFinite(paperContext.itemId) && paperContext.itemId > 0
      ? Math.floor(paperContext.itemId)
      : Number.isFinite(paperContext.contextItemId) &&
          paperContext.contextItemId > 0
        ? Math.floor(paperContext.contextItemId)
        : 0;
  return fallbackId > 0 ? `Paper ${fallbackId}` : "Paper";
}

function formatStoredPaperAttachmentTitle(
  paperContext: PaperContextRef | null | undefined,
): string {
  if (!paperContext) return "selected attachment";
  const attachmentTitle = sanitizeText(
    paperContext.attachmentTitle || "",
  ).trim();
  if (attachmentTitle) return attachmentTitle;
  const contextItemId = Math.floor(Number(paperContext.contextItemId || 0));
  return contextItemId > 0
    ? `Attachment ${contextItemId}`
    : "selected attachment";
}

function formatStoredPaperSourceLabel(
  paperContext: PaperContextRef | null | undefined,
): string {
  if (isTextLikeAttachmentSourceMode(paperContext?.contentSourceMode)) {
    const attachmentTitle = formatStoredPaperAttachmentTitle(paperContext);
    const parentLabel = formatStoredPaperCitationLabel(paperContext);
    return `(${attachmentTitle}, attachment under ${parentLabel})`;
  }
  return `(${formatStoredPaperCitationLabel(paperContext)})`;
}

function getReaderItemId(reader: any): number {
  const raw = Number(reader?._item?.id || reader?.itemID || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function isPdfBackedCitationCandidate(
  candidate: AssistantCitationPaperCandidate,
): boolean {
  if (
    isTextLikeAttachmentSourceMode(candidate.paperContext.contentSourceMode) ||
    isTextLikeAttachmentSourceMode(
      candidate.displayPaperContext.contentSourceMode,
    )
  ) {
    return false;
  }
  try {
    return isPdfContextAttachment(
      Zotero.Items.get(Math.floor(Number(candidate.contextItemId))) || null,
    );
  } catch (_err) {
    void _err;
    return false;
  }
}

export const isPdfBackedCitationCandidateForTests =
  isPdfBackedCitationCandidate;

function buildCitationCandidateKey(
  candidate: AssistantCitationPaperCandidate,
): string {
  return `${Math.floor(candidate.paperContext.itemId)}:${Math.floor(
    candidate.contextItemId,
  )}`;
}

function getSelectedTextCount(message: Message | null | undefined): number {
  const selectedTexts = Array.isArray(message?.selectedTexts)
    ? message!.selectedTexts!.filter(
        (entry): entry is string =>
          typeof entry === "string" && Boolean(entry.trim()),
      )
    : [];
  if (selectedTexts.length) return selectedTexts.length;
  return typeof message?.selectedText === "string" &&
    message.selectedText.trim()
    ? 1
    : 0;
}

function getFirstPdfAttachment(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  return getPdfAttachments(item)[0] || null;
}

function getPdfAttachments(
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

function getSinglePdfAttachment(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  const attachments = getPdfAttachments(item);
  return attachments.length === 1 ? attachments[0] : null;
}

function addCitationCandidate(
  out: AssistantCitationPaperCandidate[],
  seen: Set<string>,
  paperContext: PaperContextRef | null | undefined,
  contextItemId?: number | null,
  displayCache?: PaperContextDisplayCache,
  provenance?: CitationCandidateProvenance,
): void {
  const normalizedContextItemId = Number(
    contextItemId || paperContext?.contextItemId || 0,
  );
  if (
    !paperContext ||
    !Number.isFinite(normalizedContextItemId) ||
    normalizedContextItemId <= 0
  ) {
    return;
  }
  const dedupeKey = `${Math.floor(paperContext.itemId)}:${Math.floor(normalizedContextItemId)}`;
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  const sourceLabel = formatStoredPaperSourceLabel(paperContext);
  const citationLabel = formatStoredPaperCitationLabel(paperContext);
  const displayPaperContext = resolvePaperContextDisplayRef(
    paperContext,
    displayCache,
  );
  const displaySourceLabel = formatPaperSourceLabel(displayPaperContext);
  const displayCitationLabel = formatPaperCitationLabel(displayPaperContext);
  out.push({
    paperContext,
    displayPaperContext,
    contextItemId: Math.floor(normalizedContextItemId),
    sourceLabel,
    citationLabel,
    displaySourceLabel,
    displayCitationLabel,
    normalizedSourceLabel: normalizeCitationLabel(sourceLabel),
    normalizedCitationLabel: normalizeCitationLabel(citationLabel),
    normalizedDisplaySourceLabel: normalizeCitationLabel(displaySourceLabel),
    normalizedDisplayCitationLabel:
      normalizeCitationLabel(displayCitationLabel),
    provenance,
  });
}

function withCitationCandidateProvenance(
  candidate: AssistantCitationPaperCandidate,
  provenance: CitationCandidateProvenance,
): AssistantCitationPaperCandidate {
  return { ...candidate, provenance };
}

function getEffectiveCitationCandidateProvenance(
  candidate: AssistantCitationPaperCandidate,
  isStaticCandidate = false,
): EffectiveCitationCandidateProvenance {
  return (
    candidate.provenance || (isStaticCandidate ? "message-context" : "unknown")
  );
}

function rankCitationCandidateProvenance(
  provenance: EffectiveCitationCandidateProvenance,
): number {
  switch (provenance) {
    case "quote-citation":
      return 50;
    case "message-context":
      return 40;
    case "library-search":
      return 20;
    case "base-paper":
      return 10;
    case "active-reader":
      return 10;
    default:
      return 0;
  }
}

function isAuthoritativeCitationCandidateProvenance(
  provenance: EffectiveCitationCandidateProvenance,
): boolean {
  return provenance === "quote-citation" || provenance === "message-context";
}

export function collectAssistantCitationCandidates(
  panelItem: Zotero.Item,
  pairedUserMessage: Message | null | undefined,
): AssistantCitationPaperCandidate[] {
  const out: AssistantCitationPaperCandidate[] = [];
  const seen = new Set<string>();
  const displayCache: PaperContextDisplayCache = new Map();

  const selectedTextPaperContexts = normalizeSelectedTextPaperContexts(
    pairedUserMessage?.selectedTextPaperContexts,
    getSelectedTextCount(pairedUserMessage),
    { sanitizeText },
  );
  for (const paperContext of selectedTextPaperContexts) {
    addCitationCandidate(
      out,
      seen,
      paperContext,
      paperContext?.contextItemId,
      displayCache,
      "message-context",
    );
  }

  const paperContexts = normalizePaperContextRefs(
    pairedUserMessage?.paperContexts,
    { sanitizeText },
  );
  for (const paperContext of paperContexts) {
    addCitationCandidate(
      out,
      seen,
      paperContext,
      paperContext.contextItemId,
      displayCache,
      "message-context",
    );
  }

  const fullTextPaperContexts = normalizePaperContextRefs(
    pairedUserMessage?.fullTextPaperContexts,
    { sanitizeText },
  );
  for (const paperContext of fullTextPaperContexts) {
    addCitationCandidate(
      out,
      seen,
      paperContext,
      paperContext.contextItemId,
      displayCache,
      "message-context",
    );
  }

  const citationPaperContexts = normalizePaperContextRefs(
    pairedUserMessage?.citationPaperContexts,
    { sanitizeText },
  );
  for (const paperContext of citationPaperContexts) {
    addCitationCandidate(
      out,
      seen,
      paperContext,
      paperContext.contextItemId,
      displayCache,
      "message-context",
    );
  }

  if (out.length) return out;

  const resolvedContextItem = resolveContextSourceItem(panelItem).contextItem;
  const resolvedContextRef =
    resolvePaperContextRefFromAttachment(resolvedContextItem);
  addCitationCandidate(
    out,
    seen,
    resolvedContextRef,
    resolvedContextItem?.id,
    displayCache,
    "active-reader",
  );

  const basePaper = resolveConversationBaseItem(panelItem);
  const basePaperAttachment = getSinglePdfAttachment(basePaper);
  const basePaperRef =
    resolvePaperContextRefFromAttachment(basePaperAttachment);
  addCitationCandidate(
    out,
    seen,
    basePaperRef,
    basePaperAttachment?.id,
    displayCache,
    "base-paper",
  );

  return out;
}

function buildCandidateListFromPaperContexts(
  paperContexts: PaperContextRef[],
): AssistantCitationPaperCandidate[] {
  const candidates: AssistantCitationPaperCandidate[] = [];
  const seen = new Set<string>();
  const displayCache: PaperContextDisplayCache = new Map();
  for (const paperContext of paperContexts) {
    addCitationCandidate(
      candidates,
      seen,
      paperContext,
      paperContext.contextItemId,
      displayCache,
      "message-context",
    );
  }
  return candidates;
}

function getNextElementSibling(element: Element): Element | null {
  let current = element.nextElementSibling;
  while (current) {
    const text = sanitizeText(current.textContent || "").trim();
    if (text) return current;
    current = current.nextElementSibling;
  }
  return null;
}

function createSyntheticCitationElement(params: {
  ownerDoc: Document;
  blockquote: Element;
  citationEl: Element | null;
  extractedCitation: ExtractedCitationLabel;
}): Element | null {
  const syntheticCitationEl = params.ownerDoc.createElement("p");
  syntheticCitationEl.textContent = params.extractedCitation.sourceLabel;
  const insertParent = params.blockquote.parentElement;
  if (!insertParent) return params.citationEl;
  insertParent.insertBefore(
    syntheticCitationEl,
    params.citationEl || params.blockquote.nextSibling,
  );
  return syntheticCitationEl;
}

function extractedCitationLabelsMatch(
  left: ExtractedCitationLabel,
  right: ExtractedCitationLabel,
): boolean {
  if (left.normalizedSourceLabel === right.normalizedSourceLabel) return true;
  if (left.normalizedCitationLabel === right.normalizedCitationLabel)
    return true;
  if (
    left.normalizedDisplayCitationLabel &&
    left.normalizedDisplayCitationLabel === right.normalizedDisplayCitationLabel
  ) {
    return true;
  }
  return Boolean(
    left.normalizedCitationKey &&
    left.normalizedCitationKey === right.normalizedCitationKey,
  );
}

function isStandaloneCitationElementForQuote(
  element: Element,
  extractedCitation: ExtractedCitationLabel,
): boolean {
  const parsed = extractStandalonePaperSourceLabel(element.textContent || "");
  return Boolean(
    parsed && extractedCitationLabelsMatch(parsed, extractedCitation),
  );
}

function findConsumedCitationRemovalElement(
  citationEl: Element,
  extractedCitation: ExtractedCitationLabel,
): Element | null {
  if (!isStandaloneCitationElementForQuote(citationEl, extractedCitation)) {
    return null;
  }
  let removalTarget: Element = citationEl;
  let parent = citationEl.parentElement;
  while (parent && !parent.classList.contains("llm-quote-card")) {
    if (!isStandaloneCitationElementForQuote(parent, extractedCitation)) break;
    removalTarget = parent;
    parent = parent.parentElement;
  }
  return removalTarget;
}

function removeConsumedSourceBackedQuoteCitation(params: {
  anchorElement: Element;
  citationEl: Element;
  extractedCitation: ExtractedCitationLabel;
  replacementText?: string | null;
}): void {
  if (params.replacementText !== undefined && params.replacementText !== null) {
    replaceElementWithRenderedMarkdown(
      params.citationEl,
      params.replacementText,
    );
  } else {
    const removalTarget = findConsumedCitationRemovalElement(
      params.citationEl,
      params.extractedCitation,
    );
    removalTarget?.parentNode?.removeChild(removalTarget);
  }

  let next = getNextElementSibling(params.anchorElement);
  while (
    next &&
    isStandaloneCitationElementForQuote(next, params.extractedCitation)
  ) {
    const duplicate = next;
    next = getNextElementSibling(next);
    duplicate.parentNode?.removeChild(duplicate);
  }
}

function replaceElementWithRenderedMarkdown(
  element: Element,
  text: string,
): void {
  const parent = element.parentNode;
  const ownerDoc = element.ownerDocument;
  if (!parent || !ownerDoc) return;
  const safeText = sanitizeText(text || "").trim();
  if (!safeText) {
    parent.removeChild(element);
    return;
  }
  const container = ownerDoc.createElement("div");
  renderRenderedMarkdownInto(container, safeText, ownerDoc);
  const fragment = ownerDoc.createDocumentFragment();
  if (!container.firstChild) {
    fragment.appendChild(ownerDoc.createTextNode(safeText));
  } else {
    while (container.firstChild) {
      fragment.appendChild(container.firstChild);
    }
  }
  parent.replaceChild(fragment, element);
}

export function extractStandalonePaperSourceLabel(
  value: string,
): ExtractedCitationLabel | null {
  return parseStandaloneCitationLabel(value);
}

function normalizeCitationRemainderText(value: string): string {
  return stripLeadingCitationSeparators(sanitizeText(value || ""));
}

function extractLeadingPaperSourceLabelWithRemainder(value: string): {
  extractedCitation: ExtractedCitationLabel;
  remainder: string;
} | null {
  const text = sanitizeText(value || "").trim();
  if (!text.startsWith("(")) return null;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === "(") depth += 1;
    if (ch !== ")") continue;
    depth -= 1;
    if (depth !== 0) continue;
    const sourceCandidate = text.slice(0, index + 1);
    const extractedCitation =
      extractStandalonePaperSourceLabel(sourceCandidate);
    if (!extractedCitation) return null;
    const remainder = normalizeCitationRemainderText(text.slice(index + 1));
    return { extractedCitation, remainder };
  }
  return null;
}

function isLikelyStandaloneCitationLabel(value: string): boolean {
  return isLikelyStandaloneSourceCitationLabel(value);
}

export function extractBlockquoteTailCitation(
  value: string,
): BlockquoteTailCitationMatch | null {
  const raw = sanitizeText(value || "").replace(/\r\n?/g, "\n");
  if (!raw.trim()) return null;

  const lines = raw
    .split("\n")
    .map((line) => sanitizeText(line || "").trim())
    .filter(Boolean);
  if (lines.length >= 2) {
    const tailLine = lines[lines.length - 1];
    if (isLikelyStandaloneCitationLabel(tailLine)) {
      const extractedCitation = extractStandalonePaperSourceLabel(tailLine);
      if (extractedCitation) {
        const quoteText = sanitizeText(lines.slice(0, -1).join(" ")).trim();
        if (quoteText.length >= 8) {
          return { quoteText, extractedCitation };
        }
      }
    }
  }

  const compact = sanitizeText(raw).replace(/\s+/g, " ").trim();
  const tailMatch = compact.match(
    /(\([^()]+?\)(?:\s*\[[^\]]+\])?(?:\s*,?\s*page\s+[^,;]+)?\.?)$/i,
  );
  if (!tailMatch) return null;
  const tailCitation = sanitizeText(tailMatch[1] || "").trim();
  if (!isLikelyStandaloneCitationLabel(tailCitation)) return null;
  const extractedCitation = extractStandalonePaperSourceLabel(tailCitation);
  if (!extractedCitation) return null;

  const quoteText = sanitizeText(
    compact.slice(0, compact.length - tailCitation.length),
  ).trim();
  if (quoteText.length < 8) return null;
  return { quoteText, extractedCitation };
}

function normalizeMarkdownBlockquoteLines(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && !sanitizeText(lines[start] || "").trim()) start += 1;
  while (end > start && !sanitizeText(lines[end - 1] || "").trim()) end -= 1;
  return lines.slice(start, end).join("\n").trim();
}

export function extractMarkdownBlockquoteTextsForCitationDecoration(
  markdown: string,
): string[] {
  const out: string[] = [];
  const lines = sanitizeText(markdown || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  let current: string[] = [];
  const flush = () => {
    if (!current.length) return;
    const text = normalizeMarkdownBlockquoteLines(current);
    if (text) out.push(text);
    current = [];
  };
  let fencedCode: { char: "`" | "~"; length: number } | null = null;

  for (const line of lines) {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fencedCode) {
      if (
        fenceMatch &&
        fenceMatch[1]?.[0] === fencedCode.char &&
        fenceMatch[1].length >= fencedCode.length &&
        new RegExp(
          `^\\s{0,3}\\${fencedCode.char}{${fencedCode.length},}\\s*$`,
        ).test(line)
      ) {
        fencedCode = null;
      }
      continue;
    }
    if (fenceMatch) {
      flush();
      const marker = fenceMatch[1] || "";
      fencedCode = {
        char: marker[0] === "~" ? "~" : "`",
        length: marker.length,
      };
      continue;
    }
    const match = line.match(/^\s{0,3}>\s?(.*)$/);
    if (match) {
      current.push(match[1] || "");
      continue;
    }
    flush();
  }
  flush();
  return out;
}

function stripLeadingInlineCitationCue(value: string): {
  stripped: string;
  consumed: number;
} {
  let remaining = String(value || "");
  let consumed = 0;
  while (remaining) {
    const cueMatch = remaining.match(INLINE_CITATION_LEADING_CUE_PATTERN);
    if (!cueMatch) break;
    consumed += cueMatch[0].length;
    remaining = remaining.slice(cueMatch[0].length);
  }
  return {
    stripped: remaining,
    consumed,
  };
}

function parseGroupedInlineCitationMatch(
  rawMatchText: string,
): GroupedInlineCitationParseResult {
  const raw = String(rawMatchText || "");
  const openParenIndex = raw.indexOf("(");
  const closeParenIndex = raw.lastIndexOf(")");
  if (openParenIndex < 0 || closeParenIndex <= openParenIndex) {
    return { attempted: false, segments: [] };
  }

  const suffix = raw.slice(closeParenIndex + 1).trim();
  if (suffix) {
    return { attempted: false, segments: [] };
  }

  const inner = raw.slice(openParenIndex + 1, closeParenIndex);
  if (!inner.includes(";")) {
    return { attempted: false, segments: [] };
  }

  const segments: GroupedInlineCitationSegment[] = [];
  let partStart = 0;
  for (let cursor = 0; cursor <= inner.length; cursor += 1) {
    const isBoundary = cursor === inner.length || inner[cursor] === ";";
    if (!isBoundary) continue;

    const rawPart = inner.slice(partStart, cursor);
    const leadingSpaceLen = rawPart.match(/^\s*/)?.[0]?.length || 0;
    const trimmedPart = rawPart.trim();
    if (trimmedPart) {
      const { stripped, consumed } = stripLeadingInlineCitationCue(trimmedPart);
      const strippedPart = stripped.trim();
      if (strippedPart) {
        if (!isLikelyStandaloneCitationLabel(strippedPart)) {
          partStart = cursor + 1;
          continue;
        }
        const extractedCitation = extractStandalonePaperSourceLabel(
          `(${strippedPart})`,
        );
        if (
          extractedCitation &&
          !isYearOnlyCitationLabel(extractedCitation.citationLabel)
        ) {
          const relativeStart =
            openParenIndex + 1 + partStart + leadingSpaceLen + consumed;
          const relativeEnd = relativeStart + strippedPart.length;
          if (relativeEnd > relativeStart) {
            segments.push({
              relativeStart,
              relativeEnd,
              extractedCitation,
            });
          }
        }
      }
    }

    partStart = cursor + 1;
  }

  return {
    attempted: true,
    segments,
  };
}

export function extractInlineCitationMentions(
  value: string,
): InlineCitationMatch[] {
  const source = String(value || "");
  if (!source) return [];
  const { cleanText, cleanToOriginalIndex } = buildCitationMatchBuffer(source);
  if (!cleanText || !cleanToOriginalIndex.length) return [];
  const out: InlineCitationMatch[] = [];
  const hasOverlap = (start: number, end: number): boolean =>
    out.some((entry) => start < entry.end && end > entry.start);

  const pushMatch = (
    cleanStart: number,
    cleanEnd: number,
    extractedCitation: ExtractedCitationLabel,
  ): void => {
    const mapped = mapCleanRangeToSourceRange(
      cleanStart,
      cleanEnd,
      cleanToOriginalIndex,
    );
    if (!mapped) return;
    if (mapped.end <= mapped.start || hasOverlap(mapped.start, mapped.end))
      return;
    out.push({
      start: mapped.start,
      end: mapped.end,
      rawText: source.slice(mapped.start, mapped.end),
      extractedCitation,
    });
  };

  INLINE_CITATION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = INLINE_CITATION_PATTERN.exec(cleanText))) {
    const rawMatchText = String(match[1] || "");
    const start = Number(match.index || 0);
    const grouped = parseGroupedInlineCitationMatch(rawMatchText);
    if (grouped.attempted) {
      for (const segment of grouped.segments) {
        pushMatch(
          start + segment.relativeStart,
          start + segment.relativeEnd,
          segment.extractedCitation,
        );
      }
      continue;
    }

    const rawText = stripCitationControlChars(
      sanitizeText(rawMatchText),
    ).trim();
    if (!rawText) continue;
    if (!isLikelyStandaloneCitationLabel(rawText)) continue;
    const extractedCitation = extractStandalonePaperSourceLabel(rawText);
    if (!extractedCitation) continue;
    const end = start + rawMatchText.length;

    if (isYearOnlyCitationLabel(extractedCitation.citationLabel)) {
      const yearLabel = rawText.match(/\(([^)]+)\)/)?.[1]?.trim() || "";
      const leftContextStart = Math.max(0, start - 128);
      const leftContext = cleanText.slice(leftContextStart, start);
      const authorMatch = leftContext.match(
        /([A-Z][\p{L}'’.-]+(?:\s+(?:and|&)\s+[A-Z][\p{L}'’.-]+)?(?:\s+et\s+al\.?)?)\s*$/u,
      );
      if (authorMatch) {
        const authorText = stripCitationControlChars(
          sanitizeText(String(authorMatch[1] || "")),
        ).trim();
        if (authorText) {
          const syntheticCitation = `(${authorText}, ${yearLabel})`;
          const extractedFromNarrative =
            extractStandalonePaperSourceLabel(syntheticCitation);
          if (extractedFromNarrative) {
            const authorOffset =
              typeof authorMatch.index === "number" ? authorMatch.index : -1;
            if (authorOffset < 0) continue;
            const authorCleanStart = leftContextStart + authorOffset;
            pushMatch(authorCleanStart, end, extractedFromNarrative);
            continue;
          }
        }
      }
      continue;
    }

    pushMatch(start, end, extractedCitation);
  }

  const findPrevNonSpaceChar = (index: number): string => {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const ch = cleanText[cursor];
      if (!ch || /\s/.test(ch)) continue;
      return ch;
    }
    return "";
  };

  const findNextNonSpaceChar = (index: number): string => {
    for (let cursor = index; cursor < cleanText.length; cursor += 1) {
      const ch = cleanText[cursor];
      if (!ch || /\s/.test(ch)) continue;
      return ch;
    }
    return "";
  };

  const isWrappedByParentheses = (
    cleanStart: number,
    cleanEnd: number,
  ): boolean =>
    findPrevNonSpaceChar(cleanStart) === "(" &&
    findNextNonSpaceChar(cleanEnd) === ")";

  INLINE_NARRATIVE_CITATION_PATTERN.lastIndex = 0;
  let narrativeMatch: RegExpExecArray | null = null;
  while ((narrativeMatch = INLINE_NARRATIVE_CITATION_PATTERN.exec(cleanText))) {
    const rawMatchText = String(narrativeMatch[0] || "");
    const authorText = stripCitationControlChars(
      sanitizeText(String(narrativeMatch[1] || "")),
    ).trim();
    const yearText = stripCitationControlChars(
      sanitizeText(String(narrativeMatch[2] || "")),
    ).trim();
    if (!rawMatchText || !authorText || !yearText) continue;
    const syntheticCitation = `(${authorText}, ${yearText})`;
    const extractedCitation =
      extractStandalonePaperSourceLabel(syntheticCitation);
    if (!extractedCitation) continue;
    const start = Number(narrativeMatch.index || 0);
    const end = start + rawMatchText.length;
    if (isWrappedByParentheses(start, end)) continue;
    pushMatch(start, end, extractedCitation);
  }

  INLINE_NARRATIVE_COMMA_CITATION_PATTERN.lastIndex = 0;
  let narrativeCommaMatch: RegExpExecArray | null = null;
  while (
    (narrativeCommaMatch =
      INLINE_NARRATIVE_COMMA_CITATION_PATTERN.exec(cleanText))
  ) {
    const rawMatchText = String(narrativeCommaMatch[0] || "");
    const authorText = stripCitationControlChars(
      sanitizeText(String(narrativeCommaMatch[1] || "")),
    ).trim();
    const yearText = stripCitationControlChars(
      sanitizeText(String(narrativeCommaMatch[2] || "")),
    ).trim();
    if (!rawMatchText || !authorText || !yearText) continue;
    const syntheticCitation = `(${authorText}, ${yearText})`;
    const extractedCitation =
      extractStandalonePaperSourceLabel(syntheticCitation);
    if (!extractedCitation) continue;
    const start = Number(narrativeCommaMatch.index || 0);
    const end = start + rawMatchText.length;
    if (isWrappedByParentheses(start, end)) continue;
    pushMatch(start, end, extractedCitation);
  }
  out.sort((left, right) => left.start - right.start);
  return out;
}

export function matchAssistantCitationCandidates(
  citationLineText: string,
  paperContexts: PaperContextRef[],
): AssistantCitationPaperCandidate[] {
  const extracted = extractStandalonePaperSourceLabel(citationLineText);
  if (!extracted) return [];
  return resolveMatchingCandidatesForExtractedCitation(
    extracted,
    buildCandidateListFromPaperContexts(paperContexts),
  );
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

type ReaderPageLocation = {
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

async function openReaderForItem(
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

async function navigateReaderToPage(
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

function buildParagraphJumpFailureStatus(
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

function buildParagraphJumpSuccessStatus(
  pageLabel: string,
  paragraphJump: ExactQuoteJumpResult,
): string {
  return paragraphJump.navigationStatus === "paragraph-selected"
    ? `Jumped to cited source (page ${pageLabel}, paragraph matched)`
    : `Jumped to cited source (page ${pageLabel}, quote found; exact occurrence not selected)`;
}

function logParagraphJumpFailure(params: {
  contextItemId: number;
  displayCitationLabel: string;
  quoteText: string;
  pageIndex: number;
  pageLabel: string;
  paragraphJump: ExactQuoteJumpResult;
}): void {
  ztoolkit.log("LLM citation paragraph jump failed", {
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

async function attemptCitationParagraphJump(params: {
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
}): Promise<ExactQuoteJumpResult> {
  const quoteTexts = Array.from(
    new Set(
      [
        params.preferredFullQuoteText,
        params.verifiedSourceMatchText,
        params.quoteText,
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

/**
 * Resolve the effective page label after a paragraph jump.  If
 * FindController landed on a different page than the text search
 * predicted, use FindController's result — it is authoritative.
 */
function resolveJumpedPageLabel(
  reader: any,
  paragraphJump: ExactQuoteJumpResult,
  fallbackPageLabel: string,
): string {
  if (paragraphJump.matched && paragraphJump.matchedPageIndex !== undefined) {
    return (
      getPageLabelForIndex(reader, paragraphJump.matchedPageIndex) ||
      `${paragraphJump.matchedPageIndex + 1}`
    );
  }
  return fallbackPageLabel;
}

async function navigateToCachedCitationPage(
  contextItemId: number,
  quoteText: string,
  displayCitationLabel: string,
  provenance?: QuoteNavigationProvenance,
): Promise<CitationParagraphJumpNavigation | null> {
  const cached = lookupCitationPage({ contextItemId, quoteText });
  if (!cached) return null;
  const targetPageIndex = Math.floor(cached.pageIndex);
  const targetPageLabel =
    typeof cached.pageLabel === "string" && cached.pageLabel.trim()
      ? cached.pageLabel.trim()
      : `${targetPageIndex + 1}`;

  const reader = await openReaderForItem(contextItemId, {
    pageIndex: targetPageIndex,
    pageLabel: targetPageLabel,
  });
  if (!reader) return null;

  const paragraphJump = await attemptCitationParagraphJump({
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

async function navigateToHiddenQuoteLocation(params: {
  contextItemId: number;
  quoteText: string;
  displayCitationLabel: string;
  pageIndex: number;
  citationId?: string;
  sourceFingerprint?: string;
  sourceMatchPageOccurrence?: number;
  preferredFullQuoteText?: string;
  verifiedSourceMatchText?: string;
}): Promise<CitationParagraphJumpNavigation | null> {
  const targetPageIndex = Math.floor(params.pageIndex);
  if (!Number.isFinite(targetPageIndex) || targetPageIndex < 0) return null;

  const reader = await openReaderForItem(params.contextItemId, {
    pageIndex: targetPageIndex,
  });
  if (!reader) return null;

  const targetPageLabel =
    getPageLabelForIndex(reader, targetPageIndex) || `${targetPageIndex + 1}`;

  const paragraphJump = await attemptCitationParagraphJump({
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
  });
  return {
    reader,
    contextItemId: params.contextItemId,
    pageIndex: targetPageIndex,
    pageLabel: targetPageLabel,
    paragraphJump,
  };
}

async function navigateToStoredQuotePageHint(params: {
  contextItemId: number;
  quoteText: string;
  displayCitationLabel: string;
  pageHint: QuoteCitationPageHint;
  citationId?: string;
  sourceFingerprint?: string;
  sourceMatchPageOccurrence?: number;
  preferredFullQuoteText?: string;
  onReaderOpened?: () => void;
}): Promise<CitationParagraphJumpNavigation | null> {
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
      ? await openReaderForItem(params.contextItemId, {
          pageIndex: hintedPageIndex,
          pageLabel: hintedPageLabel || undefined,
        })
      : await openReaderForItem(params.contextItemId);
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
    getPageLabelForIndex(reader, targetPageIndex) ||
    `${targetPageIndex + 1}`;

  const paragraphJump = await attemptCitationParagraphJump({
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
  });
  return {
    reader,
    contextItemId: params.contextItemId,
    pageIndex: targetPageIndex,
    pageLabel: targetPageLabel,
    paragraphJump,
  };
}

function sortCandidatesForActiveReader(
  candidates: AssistantCitationPaperCandidate[],
): AssistantCitationPaperCandidate[] {
  const activeReaderItemId = getReaderItemId(getActiveReaderForSelectedTab());
  if (!activeReaderItemId) return candidates.slice();
  return candidates.slice().sort((left, right) => {
    const leftProvenance = getEffectiveCitationCandidateProvenance(left);
    const rightProvenance = getEffectiveCitationCandidateProvenance(right);
    if (leftProvenance !== rightProvenance) {
      return (
        rankCitationCandidateProvenance(rightProvenance) -
        rankCitationCandidateProvenance(leftProvenance)
      );
    }
    return (
      Number(right.contextItemId === activeReaderItemId) -
      Number(left.contextItemId === activeReaderItemId)
    );
  });
}

const scheduledCitationCacheWarmReaders = new WeakSet<object>();
const startedCitationCacheWarmReaders = new WeakSet<object>();
const MAX_WARM_CANDIDATES_PER_QUOTE = 2;
const MAX_PARALLEL_QUOTE_WARMS = 1;
const queuedCitationQuoteWarms: Array<{
  key: string;
  contextItemId: number;
  quoteText: string;
}> = [];
const activeCitationQuoteWarmKeys = new Set<string>();
const queuedCitationQuoteWarmKeys = new Set<string>();
let activeCitationQuoteWarmCount = 0;

function getCitationCacheWarmReaderKey(reader: any): object | null {
  if (!reader) return null;
  const type = typeof reader;
  return type === "object" || type === "function" ? (reader as object) : null;
}

function startCitationPageTextCacheWarm(reader: any): void {
  const readerKey = getCitationCacheWarmReaderKey(reader);
  if (!readerKey || startedCitationCacheWarmReaders.has(readerKey)) return;
  startedCitationCacheWarmReaders.add(readerKey);
  void warmPageTextCache(reader).catch((_err) => {
    void _err;
  });
}

function drainCitationQuoteWarmQueue(): void {
  while (
    activeCitationQuoteWarmCount < MAX_PARALLEL_QUOTE_WARMS &&
    queuedCitationQuoteWarms.length
  ) {
    const task = queuedCitationQuoteWarms.shift();
    if (!task) return;
    queuedCitationQuoteWarmKeys.delete(task.key);
    activeCitationQuoteWarmKeys.add(task.key);
    activeCitationQuoteWarmCount += 1;
    void warmQuoteLocationCacheForAttachment(task.contextItemId, task.quoteText)
      .catch((_err) => {
        void _err;
      })
      .finally(() => {
        activeCitationQuoteWarmCount = Math.max(
          0,
          activeCitationQuoteWarmCount - 1,
        );
        activeCitationQuoteWarmKeys.delete(task.key);
        drainCitationQuoteWarmQueue();
      });
  }
}

function enqueueCitationQuoteWarm(
  contextItemId: number,
  quoteText: string,
): boolean {
  const normalizedContextItemId = Math.floor(Number(contextItemId));
  const normalizedQuoteText = sanitizeText(quoteText || "").trim();
  if (
    !Number.isFinite(normalizedContextItemId) ||
    normalizedContextItemId <= 0 ||
    !normalizedQuoteText
  ) {
    return false;
  }
  const quoteHash = buildCitationQuoteHash(normalizedQuoteText);
  if (!quoteHash) return false;
  const key = `${normalizedContextItemId}\u241f${quoteHash}`;
  if (
    queuedCitationQuoteWarmKeys.has(key) ||
    activeCitationQuoteWarmKeys.has(key)
  ) {
    return false;
  }
  queuedCitationQuoteWarmKeys.add(key);
  queuedCitationQuoteWarms.push({
    key,
    contextItemId: normalizedContextItemId,
    quoteText: normalizedQuoteText,
  });
  drainCitationQuoteWarmQueue();
  return true;
}

function startCitationQuoteLocationCacheWarm(
  candidates: AssistantCitationPaperCandidate[],
  quoteText: string,
): void {
  const normalizedQuoteText = sanitizeText(quoteText || "").trim();
  if (!normalizedQuoteText || !candidates.length) return;
  const seen = new Set<number>();
  const uniquePdfCandidates: AssistantCitationPaperCandidate[] = [];
  for (const candidate of candidates) {
    if (!isPdfBackedCitationCandidate(candidate)) continue;
    const contextItemId = Math.floor(Number(candidate.contextItemId));
    if (!Number.isFinite(contextItemId) || contextItemId <= 0) continue;
    if (seen.has(contextItemId)) continue;
    seen.add(contextItemId);
    uniquePdfCandidates.push(candidate);
  }
  const warmCandidates = uniquePdfCandidates.slice(
    0,
    MAX_WARM_CANDIDATES_PER_QUOTE,
  );
  let queued = 0;
  for (const candidate of warmCandidates) {
    if (
      enqueueCitationQuoteWarm(candidate.contextItemId, normalizedQuoteText)
    ) {
      queued += 1;
    }
  }
  if (warmCandidates.length || queued) {
    ztoolkit.log("LLM citation quote warm", {
      candidateCount: candidates.length,
      warmCandidateCount: warmCandidates.length,
      queued,
      deduped: warmCandidates.length - queued,
    });
  }
}

function scheduleCitationPageTextCacheWarm(
  reader: any,
  ownerDoc?: Document | null,
): void {
  const readerKey = getCitationCacheWarmReaderKey(reader);
  if (
    !readerKey ||
    scheduledCitationCacheWarmReaders.has(readerKey) ||
    startedCitationCacheWarmReaders.has(readerKey)
  ) {
    return;
  }
  scheduledCitationCacheWarmReaders.add(readerKey);

  const win = ownerDoc?.defaultView as
    | (Window & {
        requestIdleCallback?: (
          callback: () => void,
          options?: { timeout?: number },
        ) => number;
      })
    | null
    | undefined;
  if (typeof win?.requestIdleCallback === "function") {
    win.requestIdleCallback(() => startCitationPageTextCacheWarm(reader), {
      timeout: 1600,
    });
    return;
  }
  if (win?.setTimeout) {
    win.setTimeout(() => startCitationPageTextCacheWarm(reader), 100);
  } else {
    setTimeout(() => startCitationPageTextCacheWarm(reader), 100);
  }
}

function updateCitationButtonPage(
  button: HTMLButtonElement,
  displayCitationLabel: string,
  pageLabel: string,
): void {
  if (!button || !pageLabel) return;
  if (!button.isConnected) return;
  setCitationButtonLabel(button, displayCitationLabel, pageLabel);
  // Direct DOM fallback: if setCitationButtonLabel didn't update the text
  // (e.g. DOM structure mismatch), force-update the text span directly.
  try {
    const container = button.parentElement;
    const textSpan = container?.querySelector(
      ".llm-citation-text",
    ) as HTMLElement | null;
    if (textSpan) {
      const current = textSpan.textContent || "";
      if (current && !current.includes(`page ${pageLabel}`)) {
        const stripped = current.replace(/,?\s*page\s+\S+/i, "").trim();
        if (stripped.endsWith(")")) {
          textSpan.textContent = stripped.replace(
            /\)$/,
            `, page ${pageLabel})`,
          );
        } else {
          textSpan.textContent = `${stripped}, page ${pageLabel}`;
        }
      }
    }
  } catch {
    /* best-effort */
  }

  const syncKey = sanitizeText(button.dataset.citationSyncKey || "").trim();
  if (!syncKey) return;

  const docs = new Set<Document>();
  const pushDoc = (doc?: Document | null) => {
    if (doc) docs.add(doc);
  };
  pushDoc(button.ownerDocument || null);
  try {
    pushDoc(Zotero.getMainWindow?.()?.document || null);
  } catch (_err) {
    void _err;
  }
  try {
    const windows = Zotero.getMainWindows?.() || [];
    for (const win of windows) {
      pushDoc(win?.document || null);
    }
  } catch (_err) {
    void _err;
  }

  for (const doc of docs) {
    try {
      const syncButtons = Array.from(
        doc.querySelectorAll("button.llm-citation-icon"),
      ) as HTMLButtonElement[];
      for (const syncButton of syncButtons) {
        if (syncButton === button) continue;
        if (
          sanitizeText(syncButton.dataset.citationSyncKey || "").trim() !==
          syncKey
        ) {
          continue;
        }
        if (!citationButtonsShareContext(button, syncButton)) continue;
        if (!syncButton.isConnected) continue;
        setCitationButtonLabel(syncButton, displayCitationLabel, pageLabel);
      }
    } catch (_err) {
      void _err;
    }
  }
}

function lookupVerifiedCachedCitationPageForButton(
  candidates: AssistantCitationPaperCandidate[],
  quoteText: string,
): string | undefined {
  const normalizedQuoteText = sanitizeText(quoteText || "").trim();
  if (!normalizedQuoteText) return undefined;
  for (const candidate of candidates) {
    if (!isPdfBackedCitationCandidate(candidate)) continue;
    const cached = lookupCitationPage({
      contextItemId: candidate.contextItemId,
      quoteText: normalizedQuoteText,
    });
    const pageLabel = sanitizeText(cached?.pageLabel || "").trim();
    if (pageLabel) return pageLabel;
  }
  return undefined;
}

/**
 * Dynamically resolve fallback candidates from the panel item / active reader
 * at interaction time.  This runs when the static candidate list from the user
 * message turns out to be empty (e.g. because paperContexts weren't stored or
 * the agent was not enabled).
 */
function resolveFallbackCandidates(
  panelItem: Zotero.Item,
): AssistantCitationPaperCandidate[] {
  const out: AssistantCitationPaperCandidate[] = [];
  const seen = new Set<string>();

  // 1. Try the contextItem resolved from the active PDF reader tab
  const resolvedContextItem = resolveContextSourceItem(panelItem).contextItem;
  const resolvedContextRef =
    resolvePaperContextRefFromAttachment(resolvedContextItem);
  addCitationCandidate(
    out,
    seen,
    resolvedContextRef,
    resolvedContextItem?.id,
    undefined,
    "active-reader",
  );

  // 2. Try the base paper only when it has one unambiguous PDF attachment.
  const basePaper = resolveConversationBaseItem(panelItem);
  const basePaperAttachment = getSinglePdfAttachment(basePaper);
  const basePaperRef =
    resolvePaperContextRefFromAttachment(basePaperAttachment);
  addCitationCandidate(
    out,
    seen,
    basePaperRef,
    basePaperAttachment?.id,
    undefined,
    "base-paper",
  );

  // 3. Try the active reader directly (handles cases where panelItem
  //    doesn't resolve but a PDF reader IS open)
  if (!out.length) {
    const activeReader = getActiveReaderForSelectedTab();
    const readerItemId = getReaderItemId(activeReader);
    if (readerItemId > 0) {
      const readerItem = Zotero.Items.get(readerItemId) || null;
      if (readerItem) {
        const readerRef = resolvePaperContextRefFromAttachment(readerItem);
        addCitationCandidate(
          out,
          seen,
          readerRef,
          readerItemId,
          undefined,
          "active-reader",
        );
      }
    }
  }

  return out;
}

function uniqueNormalizedLabels(labels: Array<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    const normalized = normalizeCitationLabel(label || "");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function getCandidateCitationKeys(
  candidate: AssistantCitationPaperCandidate,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of [
    candidate.paperContext.citationKey,
    candidate.displayPaperContext.citationKey,
  ]) {
    const normalized = normalizeCitationKey(key || "");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function getCandidateNormalizedSourceLabels(
  candidate: AssistantCitationPaperCandidate,
): string[] {
  return uniqueNormalizedLabels([
    candidate.sourceLabel,
    candidate.displaySourceLabel,
  ]);
}

function getCandidateNormalizedCitationLabels(
  candidate: AssistantCitationPaperCandidate,
): string[] {
  return uniqueNormalizedLabels([
    candidate.citationLabel,
    candidate.displayCitationLabel,
  ]);
}

function candidateHasCitationKey(
  candidate: AssistantCitationPaperCandidate,
  normalizedCitationKey: string,
): boolean {
  return Boolean(
    normalizedCitationKey &&
    getCandidateCitationKeys(candidate).includes(normalizedCitationKey),
  );
}

function buildCitationResolverCandidate(
  candidate: AssistantCitationPaperCandidate,
  staticCandidateKeys?: Set<string>,
): CitationResolverCandidate<AssistantCitationPaperCandidate> {
  const key = buildCitationCandidateKey(candidate);
  return {
    key,
    candidate,
    sourceLabels: getCandidateNormalizedSourceLabels(candidate),
    citationLabels: getCandidateNormalizedCitationLabels(candidate),
    citationKeys: getCandidateCitationKeys(candidate),
    isStatic: Boolean(staticCandidateKeys?.has(key)),
  };
}

function buildCitationResolverCandidates(
  candidates: AssistantCitationPaperCandidate[],
  staticCandidates: AssistantCitationPaperCandidate[],
): CitationResolverCandidate<AssistantCitationPaperCandidate>[] {
  const staticCandidateKeys = new Set(
    staticCandidates.map((candidate) => buildCitationCandidateKey(candidate)),
  );
  return candidates.map((candidate) =>
    buildCitationResolverCandidate(candidate, staticCandidateKeys),
  );
}

function rankCitationCandidateMatch(
  extracted: ExtractedCitationLabel,
  candidate: AssistantCitationPaperCandidate,
): RankedCitationCandidate<AssistantCitationPaperCandidate> {
  return rankCitationResolverCandidate(
    extracted,
    buildCitationResolverCandidate(candidate),
  );
}

function rankCitationSearchMatch(
  extracted: ExtractedCitationLabel,
  candidate: AssistantCitationPaperCandidate,
): number {
  return rankCitationCandidateMatch(extracted, candidate).score;
}

function rankCandidateForCitation(
  extractedCitation: ExtractedCitationLabel | null,
  candidate: AssistantCitationPaperCandidate,
): number {
  if (!extractedCitation) return 0;
  return rankCitationSearchMatch(extractedCitation, candidate);
}

function buildAutoNavigableCitationCandidateKeys(params: {
  extractedCitation: ExtractedCitationLabel | null;
  orderedCandidates: AssistantCitationPaperCandidate[];
  staticCandidates: AssistantCitationPaperCandidate[];
}): Set<string> {
  const keys = buildResolverAutoNavigableCitationCandidateKeys({
    extractedCitation: params.extractedCitation,
    candidates: buildCitationResolverCandidates(
      params.orderedCandidates,
      params.staticCandidates,
    ),
  });
  if (keys.size <= 1) return keys;

  const allowedCandidates = params.orderedCandidates.filter((candidate) =>
    keys.has(buildCitationCandidateKey(candidate)),
  );
  const byParent = new Map<number, AssistantCitationPaperCandidate[]>();
  for (const candidate of allowedCandidates) {
    const itemId = Math.floor(Number(candidate.paperContext.itemId || 0));
    if (!Number.isFinite(itemId) || itemId <= 0) continue;
    const group = byParent.get(itemId) || [];
    group.push(candidate);
    byParent.set(itemId, group);
  }

  for (const group of byParent.values()) {
    const distinctAttachmentIds = new Set(
      group.map((candidate) => Math.floor(Number(candidate.contextItemId))),
    );
    if (distinctAttachmentIds.size <= 1) continue;
    const quoteSpecific = group.filter(
      (candidate) => candidate.provenance === "quote-citation",
    );
    if (quoteSpecific.length === 1) {
      for (const candidate of group) {
        if (candidate !== quoteSpecific[0]) {
          keys.delete(buildCitationCandidateKey(candidate));
        }
      }
      continue;
    }
    for (const candidate of group) {
      keys.delete(buildCitationCandidateKey(candidate));
    }
  }

  return keys;
}

function isAutoNavigableCitationCandidate(
  candidate: AssistantCitationPaperCandidate,
  autoNavigableCandidateKeys: Set<string>,
): boolean {
  return autoNavigableCandidateKeys.has(buildCitationCandidateKey(candidate));
}

export function resolveAutoNavigableCitationCandidatesForTests(input: {
  extractedCitation: ExtractedCitationLabel | null;
  orderedCandidates: AssistantCitationPaperCandidate[];
  staticCandidates: AssistantCitationPaperCandidate[];
}): AssistantCitationPaperCandidate[] {
  const keys = buildAutoNavigableCitationCandidateKeys(input);
  return input.orderedCandidates.filter((candidate) =>
    isAutoNavigableCitationCandidate(candidate, keys),
  );
}

function selectSingleAutoNavigablePdfHintCandidate(params: {
  orderedCandidates: AssistantCitationPaperCandidate[];
  autoNavigableCandidateKeys: Set<string>;
}): AssistantCitationPaperCandidate | null {
  const autoNavigableCandidates = params.orderedCandidates.filter(
    (candidate) =>
      isPdfBackedCitationCandidate(candidate) &&
      isAutoNavigableCitationCandidate(
        candidate,
        params.autoNavigableCandidateKeys,
      ),
  );
  return autoNavigableCandidates.length === 1
    ? autoNavigableCandidates[0]
    : null;
}

function mergeCitationCandidates(
  ...candidateSets: AssistantCitationPaperCandidate[][]
): AssistantCitationPaperCandidate[] {
  const merged: AssistantCitationPaperCandidate[] = [];
  const seen = new Set<string>();
  for (const set of candidateSets) {
    for (const candidate of set) {
      const key = buildCitationCandidateKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(candidate);
    }
  }
  return merged;
}

async function resolveCitationCandidatesFromLibrarySearch(
  panelItem: Zotero.Item,
  extractedCitation: ExtractedCitationLabel | null,
): Promise<AssistantCitationPaperCandidate[]> {
  if (!extractedCitation) return [];
  const libraryID = Number(panelItem.libraryID || 0);
  if (!Number.isFinite(libraryID) || libraryID <= 0) return [];

  const normalizedLibraryID = Math.floor(libraryID);
  const queryTokens = extractedCitation.citationLabel
    .replace(/[()[\],]/g, " ")
    .replace(/\bet\s+al\.?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!queryTokens) return [];

  const groups = await searchPaperCandidates(
    normalizedLibraryID,
    queryTokens,
    null,
    24,
  );
  if (!groups.length) return [];

  const candidates: AssistantCitationPaperCandidate[] = [];
  const seen = new Set<string>();
  const displayCache: PaperContextDisplayCache = new Map();
  for (const group of groups) {
    if (group.attachments.length !== 1) continue;
    const attachment = group.attachments[0];
    const paperContext: PaperContextRef = {
      itemId: Math.floor(group.itemId),
      contextItemId: Math.floor(attachment.contextItemId),
      citationKey: group.citationKey,
      title: group.title,
      firstCreator: group.firstCreator,
      year: group.year,
    };
    addCitationCandidate(
      candidates,
      seen,
      paperContext,
      attachment.contextItemId,
      displayCache,
      "library-search",
    );
  }
  if (!candidates.length) return [];

  return candidates
    .map((candidate) => ({
      candidate,
      rank: rankCitationSearchMatch(extractedCitation, candidate),
    }))
    .filter((entry) => entry.rank > 0)
    .sort((left, right) => {
      const rankDelta = right.rank - left.rank;
      if (rankDelta !== 0) return rankDelta;
      return left.candidate.displayPaperContext.title.localeCompare(
        right.candidate.displayPaperContext.title,
        undefined,
        { sensitivity: "base" },
      );
    })
    .map((entry) => entry.candidate);
}

async function buildOrderedCitationCandidates(
  panelItem: Zotero.Item,
  extractedCitation: ExtractedCitationLabel | null,
  staticCandidates: AssistantCitationPaperCandidate[],
  options?: { allowLibrarySearch?: boolean },
): Promise<AssistantCitationPaperCandidate[]> {
  const dynamicFallbackCandidates = staticCandidates.length
    ? []
    : resolveFallbackCandidates(panelItem);
  const localCandidates = mergeCitationCandidates(
    staticCandidates,
    dynamicFallbackCandidates,
  );
  const hasUsefulLocalCandidate = extractedCitation
    ? localCandidates.some(
        (candidate) =>
          rankCandidateForCitation(extractedCitation, candidate) > 0,
      )
    : localCandidates.length > 0;
  const searchedCandidates =
    options?.allowLibrarySearch === false || hasUsefulLocalCandidate
      ? []
      : await resolveCitationCandidatesFromLibrarySearch(
          panelItem,
          extractedCitation,
        );
  const effectiveCandidates = mergeCitationCandidates(
    staticCandidates,
    searchedCandidates,
    dynamicFallbackCandidates,
  );
  ztoolkit.log(
    "LLM citation navigation: candidate resolution",
    JSON.stringify({
      citationLabel: extractedCitation?.sourceLabel || "",
      staticCandidateIds: staticCandidates.map(
        (candidate) => candidate.contextItemId,
      ),
      searchedCandidateIds: searchedCandidates.map(
        (candidate) => candidate.contextItemId,
      ),
      fallbackCandidateIds: dynamicFallbackCandidates.map(
        (candidate) => candidate.contextItemId,
      ),
      effectiveCandidateIds: effectiveCandidates.map(
        (candidate) => candidate.contextItemId,
      ),
      provenance: effectiveCandidates.map((candidate) => ({
        contextItemId: candidate.contextItemId,
        provenance: candidate.provenance || "unknown",
      })),
    }),
  );
  // Track which candidates came from conversation context so they receive a
  // ranking boost.  This handles cross-language author name mismatches (e.g.
  // Chinese 王一乐 → LLM writes "Wang") where the correct context paper would
  // otherwise be outranked by an unrelated library result with a matching
  // romanized name.
  const staticKeySet = new Set(
    staticCandidates.map((candidate) => buildCitationCandidateKey(candidate)),
  );
  const activeReaderItemId = getReaderItemId(getActiveReaderForSelectedTab());
  return effectiveCandidates.slice().sort((left, right) => {
    const leftKey = buildCitationCandidateKey(left);
    const rightKey = buildCitationCandidateKey(right);
    const leftIsContext = staticKeySet.has(leftKey);
    const rightIsContext = staticKeySet.has(rightKey);
    const leftProvenance = getEffectiveCitationCandidateProvenance(
      left,
      leftIsContext,
    );
    const rightProvenance = getEffectiveCitationCandidateProvenance(
      right,
      rightIsContext,
    );
    const authoritativeDelta =
      Number(isAuthoritativeCitationCandidateProvenance(rightProvenance)) -
      Number(isAuthoritativeCitationCandidateProvenance(leftProvenance));
    if (authoritativeDelta !== 0) return authoritativeDelta;
    if (
      isAuthoritativeCitationCandidateProvenance(leftProvenance) &&
      isAuthoritativeCitationCandidateProvenance(rightProvenance)
    ) {
      const authoritativeProvenanceDelta =
        rankCitationCandidateProvenance(rightProvenance) -
        rankCitationCandidateProvenance(leftProvenance);
      if (authoritativeProvenanceDelta !== 0) {
        return authoritativeProvenanceDelta;
      }
    }
    const leftRank =
      rankCandidateForCitation(extractedCitation, left) +
      (leftIsContext ? 1 : 0);
    const rightRank =
      rankCandidateForCitation(extractedCitation, right) +
      (rightIsContext ? 1 : 0);
    const rankDelta = rightRank - leftRank;
    if (rankDelta !== 0) return rankDelta;
    const contextDelta = Number(rightIsContext) - Number(leftIsContext);
    if (contextDelta !== 0) return contextDelta;
    const provenanceDelta =
      rankCitationCandidateProvenance(rightProvenance) -
      rankCitationCandidateProvenance(leftProvenance);
    if (provenanceDelta !== 0) return provenanceDelta;
    if (leftProvenance === rightProvenance) {
      const activeDelta =
        Number(right.contextItemId === activeReaderItemId) -
        Number(left.contextItemId === activeReaderItemId);
      if (activeDelta !== 0) return activeDelta;
    }
    return left.displayPaperContext.title.localeCompare(
      right.displayPaperContext.title,
      undefined,
      { sensitivity: "base" },
    );
  });
}

async function resolveCandidatesForCitationNavigation(params: {
  panelItem: Zotero.Item;
  extractedCitation: ExtractedCitationLabel | null;
  staticCandidates: AssistantCitationPaperCandidate[];
  quoteText: string;
  trust: QuoteCitationTrust;
  allowLibrarySearch: boolean;
}): Promise<AssistantCitationPaperCandidate[]> {
  const allowLibrarySearch =
    params.trust === "trusted-anchor"
      ? params.allowLibrarySearch
      : params.allowLibrarySearch &&
        Boolean(params.extractedCitation?.normalizedCitationKey);
  return buildOrderedCitationCandidates(
    params.panelItem,
    params.extractedCitation,
    params.staticCandidates,
    { allowLibrarySearch },
  );
}

function resolveAuthoritativeNonPdfCitationCandidate(input: {
  orderedCandidates: AssistantCitationPaperCandidate[];
  staticCandidates: AssistantCitationPaperCandidate[];
  extractedCitation: ExtractedCitationLabel | null;
}): AssistantCitationPaperCandidate | null {
  const topCandidate = input.orderedCandidates[0];
  if (!topCandidate || isPdfBackedCitationCandidate(topCandidate)) return null;
  const autoNavigableCandidateKeys = buildAutoNavigableCitationCandidateKeys({
    extractedCitation: input.extractedCitation,
    orderedCandidates: input.orderedCandidates,
    staticCandidates: input.staticCandidates,
  });
  return isAutoNavigableCitationCandidate(
    topCandidate,
    autoNavigableCandidateKeys,
  )
    ? topCandidate
    : null;
}

export const resolveAuthoritativeNonPdfCitationCandidateForTests =
  resolveAuthoritativeNonPdfCitationCandidate;

async function navigateUntrustedQuoteCitation(params: {
  status: HTMLElement | null;
  button: HTMLButtonElement;
  panelItem: Zotero.Item;
  extractedCitation: ExtractedCitationLabel | null;
  staticCandidates: AssistantCitationPaperCandidate[];
  displayCitationLabel: string;
  quoteText: string;
  paragraphQuoteTexts: string[];
}): Promise<boolean> {
  const resolvedCandidates = await resolveCandidatesForCitationNavigation({
    panelItem: params.panelItem,
    extractedCitation: params.extractedCitation,
    staticCandidates: params.staticCandidates,
    quoteText: params.quoteText,
    trust: "source-backed-unverified",
    allowLibrarySearch: false,
  });
  const pdfCandidates = resolvedCandidates.filter((candidate) =>
    isPdfBackedCitationCandidate(candidate),
  );
  if (!pdfCandidates.length) {
    if (params.status) {
      setStatus(
        params.status,
        "The cited quote is unverified and no explicit PDF context is available.",
        "error",
      );
    }
    return false;
  }

  if (params.status) {
    setStatus(params.status, "Locating cited quote...", "sending");
  }

  const matchedCandidates: Array<{
    candidate: AssistantCitationPaperCandidate;
    pageIndex: number;
    pageLabel: string;
    quoteText: string;
    sourceMatchText?: string;
    sourceMatchPageOccurrence?: number;
  }> = [];
  const searchTexts = Array.from(
    new Set(
      [params.quoteText, ...params.paragraphQuoteTexts]
        .map((text) => sanitizeText(text || "").trim())
        .filter(Boolean),
    ),
  );
  let lastReason = "The cited quote was not found in the explicit PDF context.";

  for (const candidate of pdfCandidates) {
    const reader = await openReaderForItem(candidate.contextItemId);
    if (!reader) {
      lastReason = "Could not open an explicit PDF context for this quote.";
      continue;
    }
    for (const searchText of searchTexts) {
      const result = await locateQuoteInLivePdfReader(reader, searchText, {
        skipFindController: true,
        exactOnly: true,
      });
      if (result.status === "resolved" && result.computedPageIndex !== null) {
        const pageIndex = Math.floor(result.computedPageIndex);
        matchedCandidates.push({
          candidate,
          pageIndex,
          pageLabel:
            getPageLabelForIndex(reader, pageIndex) || `${pageIndex + 1}`,
          quoteText: searchText,
          sourceMatchText: result.sourceMatchText,
          sourceMatchPageOccurrence: result.sourceMatchPageOccurrence,
        });
        break;
      }
      if (result.reason) {
        lastReason = result.reason;
      } else if (result.status === "ambiguous") {
        lastReason = "The cited quote matched multiple pages.";
      } else if (result.status === "not-found") {
        lastReason =
          "The cited quote was not found in the explicit PDF context.";
      }
    }
    if (matchedCandidates.length > 1) break;
  }

  if (matchedCandidates.length > 1) {
    if (params.status) {
      setStatus(
        params.status,
        "The cited quote matched more than one explicit PDF. Its citation was preserved, but no automatic jump is available.",
        "error",
      );
    }
    return false;
  }

  const match = matchedCandidates[0];
  if (!match) {
    if (params.status) setStatus(params.status, lastReason, "error");
    return false;
  }

  const reader = await openReaderForItem(match.candidate.contextItemId, {
    pageIndex: match.pageIndex,
    pageLabel: match.pageLabel,
  });
  if (!reader) {
    if (params.status) {
      setStatus(
        params.status,
        "Could not open the cited paper. The citation was preserved.",
        "error",
      );
    }
    return false;
  }

  const paragraphJump = await attemptCitationParagraphJump({
    reader,
    contextItemId: match.candidate.contextItemId,
    displayCitationLabel: params.displayCitationLabel,
    quoteText: match.quoteText,
    pageIndex: match.pageIndex,
    pageLabel: match.pageLabel,
    sourceMatchPageOccurrence: match.sourceMatchPageOccurrence,
    verifiedSourceMatchText: match.sourceMatchText,
  });
  const jumpedLabel = resolveJumpedPageLabel(
    reader,
    paragraphJump,
    match.pageLabel,
  );
  if (paragraphJump.matched) {
    rememberCachedCitationPage(
      match.candidate.contextItemId,
      match.quoteText,
      paragraphJump.matchedPageIndex ?? match.pageIndex,
      jumpedLabel,
    );
    updateCitationButtonPage(
      params.button,
      params.displayCitationLabel,
      jumpedLabel,
    );
  }
  if (params.status) {
    const statusMessage = paragraphJump.matched
      ? buildParagraphJumpSuccessStatus(jumpedLabel, paragraphJump)
      : buildParagraphJumpFailureStatus(jumpedLabel, paragraphJump);
    setStatus(
      params.status,
      statusMessage,
      paragraphJump.matched ? "ready" : "error",
    );
  }
  return paragraphJump.matched;
}

async function resolveAndNavigateAssistantCitation(params: {
  body: Element;
  button: HTMLButtonElement;
  baseSourceLabel: string;
  displayCitationLabel: string;
  candidates: AssistantCitationPaperCandidate[];
  panelItem: Zotero.Item;
  quoteText: string;
  paragraphQuoteText?: string;
}): Promise<void> {
  const status = params.body.querySelector("#llm-status") as HTMLElement | null;
  if (params.button.dataset.loading === "true") return;
  const endNavigationActivity = beginQuoteNavigationActivity();
  params.button.dataset.loading = "true";
  params.button.disabled = true;
  const timing = startCitationNavigationTiming();
  let timingOutcome = "started";
  const hasQuoteText = Boolean(sanitizeText(params.quoteText || "").trim());
  let quoteJumpSucceeded = false;

  try {
    const normalizedQuoteText = sanitizeText(params.quoteText || "").trim();
    const paragraphQuoteTexts = Array.from(
      new Set(
        [params.paragraphQuoteText, normalizedQuoteText]
          .map((text) => sanitizeText(text || "").trim())
          .filter(Boolean),
      ),
    );
    const preferredFullQuoteText = paragraphQuoteTexts.find(
      (quoteText) => quoteText !== normalizedQuoteText,
    );
    const extractedCitation = extractStandalonePaperSourceLabel(
      params.baseSourceLabel,
    );
    // Build effective candidates from all available sources, then rank by
    // citation-label relevance first (so open-chat clicks don't get hijacked
    // by whichever unrelated PDF is currently active).
    const buttonCandidates = citationButtonCandidateCache.get(params.button);
    const staticCandidates = buttonCandidates?.length
      ? buttonCandidates
      : params.candidates.length
        ? params.candidates
        : [];
    const quoteCitation = citationButtonQuoteCitationCache.get(params.button);
    const navigationMode = getCitationNavigationMode(
      params.button,
      Boolean(normalizedQuoteText),
    );
    if (navigationMode === "untrusted-quote" && normalizedQuoteText) {
      quoteJumpSucceeded = await navigateUntrustedQuoteCitation({
        status,
        button: params.button,
        panelItem: params.panelItem,
        extractedCitation,
        staticCandidates,
        displayCitationLabel: params.displayCitationLabel,
        quoteText: normalizedQuoteText,
        paragraphQuoteTexts,
      });
      timingOutcome = quoteJumpSucceeded
        ? "untrusted-quote-success"
        : "untrusted-quote-failure";
      return;
    }
    const orderedCandidates = await resolveCandidatesForCitationNavigation({
      panelItem: params.panelItem,
      extractedCitation,
      staticCandidates,
      quoteText: normalizedQuoteText,
      trust: "trusted-anchor",
      allowLibrarySearch: allowLibrarySearchForCitationNavigation({
        navigationMode,
        hasQuoteText: Boolean(normalizedQuoteText),
        staticCandidateCount: staticCandidates.length,
      }),
    });
    markCitationNavigationTiming(timing, "candidate resolution", {
      staticCandidateCount: staticCandidates.length,
      orderedCandidateCount: orderedCandidates.length,
      navigationMode,
    });
    const autoNavigableCandidateKeys = buildAutoNavigableCitationCandidateKeys({
      extractedCitation,
      orderedCandidates,
      staticCandidates,
    });
    const nonPdfCandidate = resolveAuthoritativeNonPdfCitationCandidate({
      orderedCandidates,
      staticCandidates,
      extractedCitation,
    });
    if (nonPdfCandidate) {
      if (status)
        setStatus(
          status,
          normalizedQuoteText
            ? "The cited source is not a searchable PDF. The citation was preserved, but page navigation is unavailable."
            : "Cited source is not a PDF; page jump is unavailable.",
          "error",
        );
      return;
    }
    // General inline citations may not have a quote snippet to page-locate.
    // In that case, open the best matching paper directly.
    if (!normalizedQuoteText) {
      const firstCandidate = orderedCandidates.find(
        (candidate) =>
          isPdfBackedCitationCandidate(candidate) &&
          isAutoNavigableCitationCandidate(
            candidate,
            autoNavigableCandidateKeys,
          ),
      );
      if (!firstCandidate) {
        if (status)
          setStatus(
            status,
            autoNavigableCandidateKeys.size
              ? "Cited source is not a PDF; page jump is unavailable."
              : "Could not resolve citation to a unique PDF attachment.",
            "error",
          );
        return;
      }
      const opened = await openReaderForItem(firstCandidate.contextItemId);
      if (opened) {
        if (status) {
          setStatus(
            status,
            "Opened cited paper. Paragraph jump skipped: no quote text was available.",
            "ready",
          );
        }
        return;
      }
      if (status) setStatus(status, "Could not open the cited paper.", "error");
      return;
    }

    let lastReason = "Could not resolve the cited quote to a unique page.";

    // Cache check — skip rank-0 candidates to avoid stale entries from
    // whatever PDF happens to be open winning over the actual cited paper.
    for (const candidate of orderedCandidates) {
      if (!isPdfBackedCitationCandidate(candidate)) continue;
      if (
        !isAutoNavigableCitationCandidate(candidate, autoNavigableCandidateKeys)
      )
        continue;
      const cached = await navigateToCachedCitationPage(
        candidate.contextItemId,
        normalizedQuoteText,
        params.displayCitationLabel,
        {
          citationId: quoteCitation?.id,
          sourceFingerprint: quoteCitation?.sourceFingerprint,
          sourceMatchPageOccurrence: quoteCitation?.sourceMatchPageOccurrence,
          preferredFullQuoteText,
        },
      );
      if (cached) {
        markCitationNavigationTiming(timing, "cache lookup", {
          cache: "verified-page",
          contextItemId: cached.contextItemId,
        });
        const effectiveLabel = resolveJumpedPageLabel(
          cached.reader,
          cached.paragraphJump,
          cached.pageLabel,
        );
        if (cached.paragraphJump.matched) {
          // Use FindController's actual page if it landed somewhere different
          // than the cached (possibly wrong) page.
          rememberCachedCitationPage(
            cached.contextItemId,
            normalizedQuoteText,
            cached.paragraphJump.matchedPageIndex ?? cached.pageIndex,
            effectiveLabel,
          );
          updateCitationButtonPage(
            params.button,
            params.displayCitationLabel,
            effectiveLabel,
          );
          if (status) {
            setStatus(
              status,
              buildParagraphJumpSuccessStatus(
                effectiveLabel,
                cached.paragraphJump,
              ),
              "ready",
            );
          }
          timingOutcome = "verified-cache";
          quoteJumpSucceeded = true;
          return;
        }
        lastReason = buildParagraphJumpFailureStatus(
          effectiveLabel,
          cached.paragraphJump,
        );
        // A stale/early cache miss is not a verdict. Continue to the full
        // live-PDF locator before deciding that a quote is unsearchable.
      }
    }
    markCitationNavigationTiming(timing, "cache lookup", {
      cache: "verified-page",
      result: "miss",
    });

    // Hidden page-index cache — never shown during render, but lets click
    // navigation jump to the likely page immediately before FindController
    // verifies/refines the paragraph and page label.
    for (const candidate of orderedCandidates) {
      if (!isPdfBackedCitationCandidate(candidate)) continue;
      if (
        !isAutoNavigableCitationCandidate(candidate, autoNavigableCandidateKeys)
      )
        continue;
      const hiddenLocation =
        lookupCachedQuoteLocationForAttachment(
          candidate.contextItemId,
          normalizedQuoteText,
        ) ??
        (await warmQuoteLocationCacheForAttachment(
          candidate.contextItemId,
          normalizedQuoteText,
        ));
      if (!hiddenLocation) continue;
      const cached = await navigateToHiddenQuoteLocation({
        contextItemId: candidate.contextItemId,
        quoteText: normalizedQuoteText,
        displayCitationLabel: params.displayCitationLabel,
        pageIndex: hiddenLocation.pageIndex,
        citationId: quoteCitation?.id,
        sourceFingerprint:
          quoteCitation?.sourceFingerprint || hiddenLocation.sourceFingerprint,
        sourceMatchPageOccurrence:
          quoteCitation?.sourceMatchPageOccurrence ??
          hiddenLocation.sourceMatchPageOccurrence,
        preferredFullQuoteText,
        verifiedSourceMatchText: hiddenLocation.sourceMatchText,
      });
      if (!cached) continue;
      markCitationNavigationTiming(timing, "cache lookup", {
        cache: "hidden-quote-location",
        contextItemId: cached.contextItemId,
      });

      const effectiveLabel = resolveJumpedPageLabel(
        cached.reader,
        cached.paragraphJump,
        cached.pageLabel,
      );
      if (cached.paragraphJump.matched) {
        rememberCachedCitationPage(
          cached.contextItemId,
          normalizedQuoteText,
          cached.paragraphJump.matchedPageIndex ?? cached.pageIndex,
          effectiveLabel,
        );
        updateCitationButtonPage(
          params.button,
          params.displayCitationLabel,
          effectiveLabel,
        );
        if (status) {
          setStatus(
            status,
            buildParagraphJumpSuccessStatus(
              effectiveLabel,
              cached.paragraphJump,
            ),
            "ready",
          );
        }
        timingOutcome = "hidden-cache";
        quoteJumpSucceeded = true;
        return;
      }
      lastReason = buildParagraphJumpFailureStatus(
        effectiveLabel,
        cached.paragraphJump,
      );
      // The hidden cache is only a fast page hint. Failed verification falls
      // through to an exhaustive live search.
    }
    markCitationNavigationTiming(timing, "cache lookup", {
      cache: "hidden-quote-location",
      result: "miss",
    });

    // Stored quote page hint — non-authoritative fast first paint after
    // verified caches miss. navigateToStoredQuotePageHint calls
    // attemptCitationParagraphJump, and failures continue to full
    // quote-location fallback instead of treating the hinted page as proof.
    const storedPageHint =
      navigationMode === "trusted-quote"
        ? resolveQuoteCitationPageHint(quoteCitation)
        : null;
    const hintedCandidate = storedPageHint
      ? selectSingleAutoNavigablePdfHintCandidate({
          orderedCandidates,
          autoNavigableCandidateKeys,
        })
      : null;
    if (storedPageHint && hintedCandidate) {
      if (status) {
        setStatus(status, "Opening cited page hint...", "sending");
      }
      const hinted = await navigateToStoredQuotePageHint({
        contextItemId: hintedCandidate.contextItemId,
        quoteText: normalizedQuoteText,
        displayCitationLabel: params.displayCitationLabel,
        pageHint: storedPageHint,
        citationId: quoteCitation?.id,
        sourceFingerprint: quoteCitation?.sourceFingerprint,
        sourceMatchPageOccurrence: quoteCitation?.sourceMatchPageOccurrence,
        preferredFullQuoteText,
        onReaderOpened: () => {
          markCitationNavigationTiming(timing, "hint open", {
            contextItemId: hintedCandidate.contextItemId,
            pageHint: storedPageHint,
          });
          if (status) {
            setStatus(status, "Verifying cited quote...", "sending");
          }
        },
      });
      if (hinted) {
        markCitationNavigationTiming(timing, "paragraph jump", {
          source: "stored-page-hint",
          contextItemId: hinted.contextItemId,
          matched: hinted.paragraphJump.matched,
          matchedPageIndex: hinted.paragraphJump.matchedPageIndex,
        });
        const effectiveLabel = resolveJumpedPageLabel(
          hinted.reader,
          hinted.paragraphJump,
          hinted.pageLabel,
        );
        if (hinted.paragraphJump.matched) {
          rememberCachedCitationPage(
            hinted.contextItemId,
            normalizedQuoteText,
            hinted.paragraphJump.matchedPageIndex ?? hinted.pageIndex,
            effectiveLabel,
          );
          updateCitationButtonPage(
            params.button,
            params.displayCitationLabel,
            effectiveLabel,
          );
          if (status) {
            setStatus(
              status,
              buildParagraphJumpSuccessStatus(
                effectiveLabel,
                hinted.paragraphJump,
              ),
              "ready",
            );
          }
          timingOutcome = "stored-page-hint";
          quoteJumpSucceeded = true;
          return;
        }
        lastReason = buildParagraphJumpFailureStatus(
          effectiveLabel,
          hinted.paragraphJump,
        );
        // Wrong or unverified stored hint: continue to full quote-location fallback.
      } else {
        markCitationNavigationTiming(timing, "hint open", {
          result: "unresolved",
          pageHint: storedPageHint,
        });
      }
    }

    // Use the explicit page as a navigation hint only when we do not already
    // have a verified cached page for this quote. The cache stores the
    // authoritative page after eager resolution or a FindController jump.
    const explicitPageLabel = sanitizeText(
      params.button.dataset.citationPageLabel || "",
    ).trim();
    if (explicitPageLabel) {
      const bestRanked = orderedCandidates.find(
        (c) =>
          isPdfBackedCitationCandidate(c) &&
          isAutoNavigableCitationCandidate(c, autoNavigableCandidateKeys),
      );
      if (bestRanked) {
        const target = await openReaderForItem(bestRanked.contextItemId);
        if (target) {
          const pageIndex = resolvePageIndexForLabel(target, explicitPageLabel);
          if (pageIndex === null) {
            lastReason = `Could not resolve cited page label "${explicitPageLabel}".`;
          } else {
            const paragraphJump = await attemptCitationParagraphJump({
              reader: target,
              contextItemId: bestRanked.contextItemId,
              displayCitationLabel: params.displayCitationLabel,
              quoteText: normalizedQuoteText,
              pageIndex,
              pageLabel: explicitPageLabel,
              citationId: quoteCitation?.id,
              sourceFingerprint: quoteCitation?.sourceFingerprint,
              sourceMatchPageOccurrence:
                quoteCitation?.sourceMatchPageOccurrence,
              preferredFullQuoteText,
            });
            const jumpedLabel = resolveJumpedPageLabel(
              target,
              paragraphJump,
              explicitPageLabel,
            );
            if (paragraphJump.matched) {
              rememberCachedCitationPage(
                bestRanked.contextItemId,
                normalizedQuoteText,
                paragraphJump.matchedPageIndex ?? pageIndex,
                jumpedLabel,
              );
              updateCitationButtonPage(
                params.button,
                params.displayCitationLabel,
                jumpedLabel,
              );
              if (status) {
                setStatus(
                  status,
                  buildParagraphJumpSuccessStatus(jumpedLabel, paragraphJump),
                  "ready",
                );
              }
              timingOutcome = "explicit-page-hint";
              quoteJumpSucceeded = true;
              return;
            }
            lastReason = buildParagraphJumpFailureStatus(
              jumpedLabel,
              paragraphJump,
            );
            // A rendered page label is only a hint. Continue through the full
            // PDF text before returning a failure.
          }
        }
      }
    }

    if (status) setStatus(status, "Locating cited quote...", "sending");

    // Last-resort: if there are still no candidates, try the active reader
    // directly without needing a candidate entry.
    if (!orderedCandidates.length) {
      const activeReader = getActiveReaderForSelectedTab();
      if (activeReader) {
        markCitationNavigationTiming(timing, "full quote locate", {
          source: "active-reader",
          phase: "start",
        });
        const result = await locateQuoteInLivePdfReader(
          activeReader,
          normalizedQuoteText,
          { skipFindController: true, exactOnly: true },
        );
        markCitationNavigationTiming(timing, "full quote locate", {
          source: "active-reader",
          status: result.status,
          computedPageIndex: result.computedPageIndex,
        });
        if (result.status === "resolved" && result.computedPageIndex !== null) {
          const pageIndex = Math.floor(result.computedPageIndex);
          const pageLabel =
            getPageLabelForIndex(activeReader, pageIndex) || `${pageIndex + 1}`;
          const paragraphJump = await attemptCitationParagraphJump({
            reader: activeReader,
            contextItemId: getReaderItemId(activeReader),
            displayCitationLabel: params.displayCitationLabel,
            quoteText: normalizedQuoteText,
            pageIndex,
            pageLabel,
            citationId: quoteCitation?.id,
            sourceFingerprint: quoteCitation?.sourceFingerprint,
            sourceMatchPageOccurrence:
              quoteCitation?.sourceMatchPageOccurrence ??
              result.sourceMatchPageOccurrence,
            preferredFullQuoteText,
            verifiedSourceMatchText: result.sourceMatchText,
          });
          markCitationNavigationTiming(timing, "paragraph jump", {
            source: "full-quote-locate-active-reader",
            matched: paragraphJump.matched,
            matchedPageIndex: paragraphJump.matchedPageIndex,
          });
          const jumpedLabel = resolveJumpedPageLabel(
            activeReader,
            paragraphJump,
            pageLabel,
          );
          if (paragraphJump.matched) {
            rememberCachedCitationPage(
              getReaderItemId(activeReader),
              normalizedQuoteText,
              paragraphJump.matchedPageIndex ?? pageIndex,
              jumpedLabel,
            );
            updateCitationButtonPage(
              params.button,
              params.displayCitationLabel,
              jumpedLabel,
            );
            if (status) {
              setStatus(
                status,
                buildParagraphJumpSuccessStatus(jumpedLabel, paragraphJump),
                "ready",
              );
            }
            timingOutcome = "full-search-active-reader";
            quoteJumpSucceeded = true;
            return;
          }
          lastReason = buildParagraphJumpFailureStatus(
            jumpedLabel,
            paragraphJump,
          );
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

    for (const candidate of orderedCandidates) {
      if (!isPdfBackedCitationCandidate(candidate)) continue;
      if (
        !isAutoNavigableCitationCandidate(candidate, autoNavigableCandidateKeys)
      )
        continue;
      const reader = await openReaderForItem(candidate.contextItemId);
      if (!reader) {
        lastReason = "Could not open the cited paper.";
        continue;
      }
      markCitationNavigationTiming(timing, "full quote locate", {
        source: "candidate",
        contextItemId: candidate.contextItemId,
        phase: "start",
      });
      const result = await locateQuoteInLivePdfReader(
        reader,
        normalizedQuoteText,
        { skipFindController: true, exactOnly: true },
      );
      markCitationNavigationTiming(timing, "full quote locate", {
        source: "candidate",
        contextItemId: candidate.contextItemId,
        status: result.status,
        computedPageIndex: result.computedPageIndex,
      });
      if (result.status === "resolved" && result.computedPageIndex !== null) {
        const pageIndex = Math.floor(result.computedPageIndex);
        const pageLabel =
          getPageLabelForIndex(reader, pageIndex) || `${pageIndex + 1}`;
        const paragraphJump = await attemptCitationParagraphJump({
          reader,
          contextItemId: candidate.contextItemId,
          displayCitationLabel: params.displayCitationLabel,
          quoteText: normalizedQuoteText,
          pageIndex,
          pageLabel,
          citationId: quoteCitation?.id,
          sourceFingerprint: quoteCitation?.sourceFingerprint,
          sourceMatchPageOccurrence:
            quoteCitation?.sourceMatchPageOccurrence ??
            result.sourceMatchPageOccurrence,
          preferredFullQuoteText,
          verifiedSourceMatchText: result.sourceMatchText,
        });
        markCitationNavigationTiming(timing, "paragraph jump", {
          source: "full-quote-locate-candidate",
          contextItemId: candidate.contextItemId,
          matched: paragraphJump.matched,
          matchedPageIndex: paragraphJump.matchedPageIndex,
        });
        const jumpedLabel = resolveJumpedPageLabel(
          reader,
          paragraphJump,
          pageLabel,
        );
        if (paragraphJump.matched) {
          rememberCachedCitationPage(
            candidate.contextItemId,
            normalizedQuoteText,
            paragraphJump.matchedPageIndex ?? pageIndex,
            jumpedLabel,
          );
          updateCitationButtonPage(
            params.button,
            params.displayCitationLabel,
            jumpedLabel,
          );
          if (status) {
            setStatus(
              status,
              buildParagraphJumpSuccessStatus(jumpedLabel, paragraphJump),
              "ready",
            );
          }
          timingOutcome = "full-search-candidate";
          quoteJumpSucceeded = true;
          return;
        }
        lastReason = buildParagraphJumpFailureStatus(
          jumpedLabel,
          paragraphJump,
        );
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

    if (status) setStatus(status, lastReason, "error");
    timingOutcome = "not-found";
  } catch (error) {
    timingOutcome = "error";
    ztoolkit.log("LLM: Failed to navigate assistant citation", error);
    if (status) {
      setStatus(
        status,
        hasQuoteText
          ? "Could not open the cited source. The citation was preserved."
          : "Could not open the cited source",
        "error",
      );
    }
  } finally {
    endNavigationActivity();
    if (hasQuoteText && !quoteJumpSucceeded) {
      const EventConstructor =
        params.body.ownerDocument?.defaultView?.Event || null;
      if (EventConstructor) {
        params.body.dispatchEvent(
          new EventConstructor(QUOTE_PROVENANCE_REVALIDATION_REQUEST_EVENT),
        );
      }
    }
    params.button.disabled = false;
    params.button.dataset.loading = "false";
    // After any citation click, refresh all other citation buttons in the
    // panel so their page labels reflect the latest cache (which may have
    // been corrected by FindController during this click).
    refreshAllCitationButtonPages(params.body, params.panelItem);
    logCitationNavigationTiming(timing, timingOutcome);
  }
}

/**
 * Re-resolve page labels for all citation buttons currently in the DOM.
 * Buttons whose quote text already has a cache entry get the cached
 * (FindController-verified) page; others are left unchanged.
 */
function refreshAllCitationButtonPages(
  body: Element,
  panelItem: Zotero.Item,
): void {
  try {
    const buttons = Array.from(
      body.querySelectorAll("button.llm-citation-icon"),
    ) as HTMLButtonElement[];
    for (const button of buttons) {
      if (!button.isConnected) continue;
      const syncKey = sanitizeText(button.dataset.citationSyncKey || "").trim();
      if (!syncKey) continue;
      // The sync key is "normalizedSourceLabel⏟normalizedQuote".
      // Extract the quote portion to look up the cache.
      const sepIdx = syncKey.indexOf("\u241f");
      if (sepIdx < 0) continue;
      const quoteKey = syncKey.slice(sepIdx + 1);
      if (!quoteKey) continue;
      const contextItemIds = parseCitationContextItemIds(
        button.dataset.citationContextItemIds,
      );
      if (!contextItemIds.length) continue;
      const cachedPageLabel = lookupCachedCitationPageForContextIds(
        contextItemIds,
        quoteKey,
      );
      if (!cachedPageLabel) continue;
      // Read the current display label from the button text
      const textSpan = button
        .closest(".llm-citation-row, .llm-citation-inline-wrap")
        ?.querySelector(".llm-citation-text");
      if (!textSpan) continue;
      const baseLabel = getCitationBaseLabelForRefresh(textSpan);
      if (baseLabel) {
        setCitationButtonLabel(button, baseLabel, cachedPageLabel);
      }
    }
  } catch {
    // Best-effort refresh — don't crash if DOM structure is unexpected
  }
}

export const refreshAllCitationButtonPagesForTests =
  refreshAllCitationButtonPages;

function resolveMatchingCandidatesForExtractedCitation(
  extractedCitation: ExtractedCitationLabel,
  candidates: AssistantCitationPaperCandidate[],
): AssistantCitationPaperCandidate[] {
  const isGroupedCitation =
    extractedCitation.normalizedCitationLabel.includes(";");
  if (extractedCitation.normalizedCitationKey) {
    const citationKeyMatches = candidates.filter((candidate) =>
      candidateHasCitationKey(
        candidate,
        extractedCitation.normalizedCitationKey || "",
      ),
    );
    if (citationKeyMatches.length) {
      return citationKeyMatches;
    }
  }
  const out: AssistantCitationPaperCandidate[] = candidates.filter(
    (candidate) =>
      getCandidateNormalizedSourceLabels(candidate).includes(
        extractedCitation.normalizedSourceLabel,
      ) ||
      getCandidateNormalizedCitationLabels(candidate).includes(
        extractedCitation.normalizedCitationLabel,
      ) ||
      getCandidateNormalizedCitationLabels(candidate).includes(
        extractedCitation.normalizedDisplayCitationLabel,
      ),
  );
  // Fuzzy author-key fallback:
  // If the citation has a year (e.g. "Marks & Goard, 2021"), we fuzzy match the author
  // but *require* the year to match exactly to prevent linking to the wrong paper.
  // If no year is present, we allow any paper matching the author.
  if (!out.length && candidates.length && !isGroupedCitation) {
    const extractedYear = extractCitationYear(
      extractedCitation.normalizedCitationLabel,
    );
    const citationAuthorKey = extractCitationAuthorKey(
      extractedCitation.normalizedCitationLabel,
    );

    if (citationAuthorKey) {
      const fuzzy = candidates.filter((candidate) => {
        return getCandidateNormalizedCitationLabels(candidate).some(
          (candidateLabel) => {
            const candidateAuthorKey = extractCitationAuthorKey(candidateLabel);
            if (candidateAuthorKey !== citationAuthorKey) return false;

            if (extractedYear) {
              const candidateYear = extractCitationYear(candidateLabel);
              return candidateYear === extractedYear;
            }

            return true;
          },
        );
      });

      if (fuzzy.length) {
        out.push(...fuzzy);
      }
    }
  }
  return out;
}

function resolveCitationVisibleLabel(
  label: string,
  paperTitle: string,
): string {
  const normalizedLabel = sanitizeText(label || "").trim();
  const normalizedTitle = sanitizeText(paperTitle || "").trim();
  if (
    /^Paper\s+\d+$/i.test(normalizedLabel) &&
    normalizedTitle &&
    !/^Paper\s+\d+$/i.test(normalizedTitle)
  ) {
    return normalizedTitle;
  }
  return normalizedLabel;
}

export const resolveCitationVisibleLabelForTests = resolveCitationVisibleLabel;

function createCitationButton(params: {
  ownerDoc: Document;
  body: Element;
  panelItem: Zotero.Item;
  candidates: AssistantCitationPaperCandidate[];
  extractedCitation: ExtractedCitationLabel;
  quoteText: string;
  quoteCitation?: QuoteCitation;
  paragraphQuoteText?: string;
  navigationMode?: CitationNavigationMode;
  preferRawCitationLabel?: boolean;
  inline?: boolean;
  rawCitationText?: string;
}): HTMLSpanElement {
  const baseSourceLabel = params.extractedCitation.sourceLabel;
  const displayCitationLabel = params.extractedCitation.displayCitationLabel;

  // --- Container ---
  const container = params.ownerDoc.createElement("span");
  container.className = params.inline
    ? "llm-citation-inline-wrap"
    : "llm-citation-row";

  // --- Plain-text citation label ---
  const textSpan = params.ownerDoc.createElement("span");
  textSpan.className = "llm-citation-text";
  const verifiedPageLabel = lookupVerifiedCachedCitationPageForButton(
    params.candidates,
    params.quoteText,
  );
  const primaryDisplayCandidate = params.candidates[0];
  const matchedDisplayLabel = params.preferRawCitationLabel
    ? ""
    : resolveCitationVisibleLabel(
        primaryDisplayCandidate?.displayCitationLabel || "",
        primaryDisplayCandidate?.displayPaperContext.title || "",
      );
  let baseLabelText: string;
  if (matchedDisplayLabel) {
    baseLabelText = params.inline
      ? `(${matchedDisplayLabel})`
      : matchedDisplayLabel;
  } else {
    baseLabelText = params.rawCitationText || displayCitationLabel;
  }
  textSpan.dataset.rawText = baseLabelText;
  textSpan.setAttribute("role", "button");
  textSpan.setAttribute("tabindex", "0");
  const navigationDisplayCitationLabel =
    matchedDisplayLabel || displayCitationLabel;
  const labelText = formatCitationDisplayTextWithPage(
    baseLabelText,
    verifiedPageLabel,
  );
  textSpan.textContent = labelText;
  container.appendChild(textSpan);

  // --- Icon button (label and icon both activate the same jump) ---
  const citationButton = params.ownerDoc.createElement(
    "button",
  ) as HTMLButtonElement;
  citationButton.type = "button";
  citationButton.className = params.inline
    ? "llm-citation-icon llm-citation-icon-inline"
    : "llm-citation-icon";
  citationButtonCandidateCache.set(citationButton, params.candidates.slice());
  if (params.quoteCitation) {
    citationButtonQuoteCitationCache.set(citationButton, params.quoteCitation);
  }
  const navigationMode =
    params.navigationMode ||
    (params.quoteText ? "trusted-quote" : "inline-citation");
  citationButtonNavigationModeCache.set(citationButton, navigationMode);
  citationButton.dataset.citationNavigationMode = navigationMode;
  citationButton.dataset.loading = "false";
  citationButton.dataset.citationSyncKey = `${normalizeCitationLabel(baseSourceLabel)}\u241f${normalizeQuoteKey(params.quoteText)}`;
  citationButton.dataset.citationContextItemIds =
    buildCitationContextItemIdsDataset(params.candidates);
  const primaryContextItemId = parseCitationContextItemIds(
    citationButton.dataset.citationContextItemIds,
  )[0];
  if (primaryContextItemId) {
    citationButton.dataset.primaryCitationContextItemId =
      String(primaryContextItemId);
  }
  if (params.extractedCitation.pageLabel) {
    citationButton.dataset.citationPageLabel =
      params.extractedCitation.pageLabel;
  }

  // Tooltip: show a preview of the quoted text, or fallback to paper title
  const quotePreview = sanitizeText(params.quoteText || "").trim();
  if (quotePreview) {
    const truncated =
      quotePreview.length > 120
        ? quotePreview.slice(0, 117) + "…"
        : quotePreview;
    citationButton.title = truncated;
  } else {
    const paperTitle = params.candidates[0]?.displayPaperContext.title || "";
    citationButton.title = paperTitle
      ? `Jump to: ${paperTitle}`
      : "Jump to cited source";
  }
  citationButton.setAttribute(
    "aria-label",
    `Jump to cited source: ${navigationDisplayCitationLabel}`,
  );

  const handleCitationClick = (anchorElement?: Element | null) => {
    persistPendingChatScrollRestoreForElement(
      params.body,
      anchorElement || citationButton,
    );
    startCitationQuoteLocationCacheWarm(params.candidates, params.quoteText);
    void resolveAndNavigateAssistantCitation({
      body: params.body,
      button: citationButton,
      baseSourceLabel,
      displayCitationLabel: navigationDisplayCitationLabel,
      candidates: params.candidates,
      panelItem: params.panelItem,
      quoteText: params.quoteText,
      paragraphQuoteText: params.paragraphQuoteText,
    });
  };
  const handleCitationMouseDown = (event: Event) => {
    const mouse = event as MouseEvent;
    if (typeof mouse.button === "number" && mouse.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    handleCitationClick(event.currentTarget as Element | null);
  };
  const handleCitationClickEvent = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const handleCitationKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    handleCitationClick(event.currentTarget as Element | null);
  };
  const warmActiveReaderCache = () => {
    if (!citationButton.isConnected && !textSpan.isConnected) return;
    const activeReader = getActiveReaderForSelectedTab();
    if (activeReader) startCitationPageTextCacheWarm(activeReader);
    startCitationQuoteLocationCacheWarm(params.candidates, params.quoteText);
  };

  citationButton.addEventListener("pointerenter", warmActiveReaderCache);
  citationButton.addEventListener("focus", warmActiveReaderCache);
  textSpan.addEventListener("pointerenter", warmActiveReaderCache);
  textSpan.addEventListener("focus", warmActiveReaderCache);

  textSpan.addEventListener("mousedown", handleCitationMouseDown);
  textSpan.addEventListener("click", handleCitationClickEvent);
  textSpan.addEventListener("keydown", handleCitationKeyDown);
  citationButton.addEventListener("mousedown", handleCitationMouseDown);
  citationButton.addEventListener("click", handleCitationClickEvent);
  citationButton.addEventListener("keydown", handleCitationKeyDown);

  container.appendChild(citationButton);

  return container;
}

function resolveQuoteCitationCandidates(
  citation: QuoteCitation,
  extractedCitation: ExtractedCitationLabel | null,
  candidates: AssistantCitationPaperCandidate[],
): AssistantCitationPaperCandidate[] {
  const contextItemId = Number(citation.contextItemId || 0);
  const itemId = Number(citation.itemId || 0);
  if (Number.isFinite(contextItemId) && contextItemId > 0) {
    const matches = candidates.filter(
      (candidate) => candidate.contextItemId === Math.floor(contextItemId),
    );
    if (matches.length) {
      return matches.map((candidate) =>
        withCitationCandidateProvenance(candidate, "quote-citation"),
      );
    }
    const storedMatches = resolveStoredQuoteCitationCandidates(citation).filter(
      (candidate) => candidate.contextItemId === Math.floor(contextItemId),
    );
    return storedMatches.map((candidate) =>
      withCitationCandidateProvenance(candidate, "quote-citation"),
    );
  }
  if (Number.isFinite(itemId) && itemId > 0) {
    const matches = candidates.filter(
      (candidate) => candidate.paperContext.itemId === Math.floor(itemId),
    );
    if (matches.length) {
      return matches.map((candidate) =>
        withCitationCandidateProvenance(candidate, "quote-citation"),
      );
    }
  }
  const storedMatches = resolveStoredQuoteCitationCandidates(citation);
  if (storedMatches.length) return storedMatches;
  return extractedCitation
    ? resolveMatchingCandidatesForExtractedCitation(
        extractedCitation,
        candidates,
      )
    : [];
}

export const resolveQuoteCitationCandidatesForTests =
  resolveQuoteCitationCandidates;

function resolveStoredQuoteCitationCandidates(
  citation: QuoteCitation,
): AssistantCitationPaperCandidate[] {
  const out: AssistantCitationPaperCandidate[] = [];
  const seen = new Set<string>();
  const displayCache: PaperContextDisplayCache = new Map();
  const contextItemId = Math.floor(Number(citation.contextItemId || 0));
  if (contextItemId > 0) {
    try {
      const contextItem = Zotero.Items.get(contextItemId) || null;
      const contextRef = resolvePaperContextRefFromAttachment(contextItem);
      addCitationCandidate(
        out,
        seen,
        contextRef,
        contextItemId,
        displayCache,
        "quote-citation",
      );
    } catch (_err) {
      void _err;
    }
  }

  const itemId = Math.floor(Number(citation.itemId || 0));
  if (itemId > 0) {
    try {
      const item = Zotero.Items.get(itemId) || null;
      for (const attachment of getPdfAttachments(item)) {
        const contextRef = resolvePaperContextRefFromAttachment(attachment);
        addCitationCandidate(
          out,
          seen,
          contextRef,
          attachment.id,
          displayCache,
          "quote-citation",
        );
      }
    } catch (_err) {
      void _err;
    }
  }

  return out;
}

export const getQuoteCitationLookupTextForTests =
  resolveQuoteCitationLookupText;

function getQuoteCitationDisplayText(citation: QuoteCitation): string {
  const displayText = stripQuoteCitationAnchorsFromDisplayText(
    citation.displayQuoteText || citation.quoteText,
  );
  return (
    sanitizeText(displayText).trim() ||
    sanitizeText(
      stripQuoteCitationAnchorsFromDisplayText(citation.quoteText || ""),
    ).trim()
  );
}

type QuoteCardPointerPoint = {
  clientX: number;
  clientY: number;
};

type QuoteCardStatus = "verified" | "unverified" | "not-source";

function isMouseEventLike(event: Event): event is MouseEvent {
  const mouseEvent = event as MouseEvent;
  return (
    typeof mouseEvent.clientX === "number" &&
    typeof mouseEvent.clientY === "number"
  );
}

function quoteCardPointerMoved(
  startPoint: QuoteCardPointerPoint,
  event: MouseEvent,
): boolean {
  const deltaX = event.clientX - startPoint.clientX;
  const deltaY = event.clientY - startPoint.clientY;
  return Math.sqrt(deltaX * deltaX + deltaY * deltaY) > 4;
}

function quoteCardContainsSelectionNode(
  wrapper: HTMLElement,
  node: Node | null,
): boolean {
  if (!node) return false;
  if (node === wrapper) return true;
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return Boolean(element && wrapper.contains(element));
}

function getQuoteCardSelection(ownerDoc: Document): Selection | null {
  return (
    ownerDoc.getSelection?.() || ownerDoc.defaultView?.getSelection?.() || null
  );
}

function hasActiveQuoteCardTextSelection(wrapper: HTMLElement): boolean {
  const selection = getQuoteCardSelection(wrapper.ownerDocument);
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }
  if (
    quoteCardContainsSelectionNode(wrapper, selection.anchorNode) ||
    quoteCardContainsSelectionNode(wrapper, selection.focusNode)
  ) {
    return true;
  }
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (
      quoteCardContainsSelectionNode(wrapper, range.commonAncestorContainer)
    ) {
      return true;
    }
  }
  return false;
}

function renderQuoteCardMarkdownInto(
  target: HTMLElement,
  quoteText: string,
  ownerDoc: Document,
): void {
  const safeText = sanitizeText(quoteText || "").trim();
  if (!safeText) return;
  const container = ownerDoc.createElement("div");
  renderRenderedMarkdownInto(container, safeText, ownerDoc);
  if (!appendQuoteCardBodyContent(target, container)) {
    target.textContent = safeText;
  }
}

function renderQuoteCardPreviewMarkdown(
  preview: HTMLElement,
  quoteText: string,
  ownerDoc: Document,
): void {
  preview.classList.add("llm-rendered-markdown");
  renderQuoteCardMarkdownInto(preview, quoteText, ownerDoc);
}

function renderQuoteCardBodyMarkdown(
  body: HTMLElement,
  quoteText: string,
  ownerDoc: Document,
): void {
  renderQuoteCardMarkdownInto(body, quoteText, ownerDoc);
}

function appendQuoteCardBodyContent(
  body: HTMLElement,
  quoteContent: ParentNode | null | undefined,
): boolean {
  if (!quoteContent?.firstChild) return false;
  body.classList.add("llm-rendered-markdown");
  const firstElement =
    "firstElementChild" in quoteContent ? quoteContent.firstElementChild : null;
  const hasSingleParagraph =
    quoteContent.childNodes.length === 1 &&
    firstElement?.tagName.toLowerCase() === "p";
  const moveSource =
    hasSingleParagraph && firstElement ? firstElement : quoteContent;
  while (moveSource.firstChild) {
    body.appendChild(moveSource.firstChild);
  }
  return true;
}

function createQuoteCardElement(params: {
  ownerDoc: Document;
  quoteText: string;
  quoteCitationId?: string;
  quoteOccurrenceId?: string;
  citationContent?: Node;
  quoteContent?: DocumentFragment | null;
  status?: QuoteCardStatus;
}): HTMLElement {
  const status = params.status || "verified";
  const interactive = status === "verified";
  const wrapper = params.ownerDoc.createElement("div");
  wrapper.className = params.quoteCitationId
    ? "llm-quote-card llm-quote-citation-anchor"
    : "llm-quote-card";
  wrapper.dataset.quoteStatus = status;
  wrapper.dataset.expanded = interactive ? "false" : "true";
  if (interactive) {
    wrapper.dataset.expandable = "pending";
  }
  if (params.quoteCitationId) {
    wrapper.dataset.quoteCitationId = params.quoteCitationId;
  }
  if (params.quoteOccurrenceId) {
    wrapper.dataset.quoteOccurrenceId = params.quoteOccurrenceId;
  }

  const content = params.ownerDoc.createElement("div");
  content.className = "llm-quote-card-content";
  const preview = params.ownerDoc.createElement("span");
  preview.className = "llm-quote-card-preview";
  renderQuoteCardPreviewMarkdown(preview, params.quoteText, params.ownerDoc);

  const body = params.ownerDoc.createElement("div");
  body.className = "llm-quote-card-body";
  if (!appendQuoteCardBodyContent(body, params.quoteContent)) {
    renderQuoteCardBodyMarkdown(body, params.quoteText, params.ownerDoc);
  }
  content.append(preview, body);
  wrapper.appendChild(content);
  if (params.citationContent) {
    const citation = params.ownerDoc.createElement("span");
    citation.className = "llm-quote-card-citation";
    citation.appendChild(params.citationContent);
    wrapper.appendChild(citation);
  }

  if (!interactive) return wrapper;

  const setExpanded = (expanded: boolean) => {
    if (wrapper.dataset.quoteStatus !== "verified") {
      wrapper.dataset.expanded = "true";
      content.removeAttribute("aria-expanded");
      return;
    }
    wrapper.dataset.expanded = expanded ? "true" : "false";
    content.setAttribute("aria-expanded", expanded ? "true" : "false");
  };
  const toggleExpanded = () => {
    if (wrapper.dataset.expandable !== "true") return;
    setExpanded(wrapper.dataset.expanded !== "true");
  };
  const shouldIgnoreToggle = (target: EventTarget | null): boolean => {
    const element =
      target && typeof (target as { closest?: unknown }).closest === "function"
        ? (target as Element)
        : null;
    return Boolean(
      element?.closest(
        ".llm-citation-row, .llm-citation-inline-wrap, .llm-citation-text, .llm-citation-icon",
      ),
    );
  };
  let quoteCardPointerStart: QuoteCardPointerPoint | null = null;
  let shouldSuppressQuoteCardToggle = false;
  wrapper.addEventListener("mousedown", (event: Event) => {
    if (wrapper.dataset.quoteStatus !== "verified") return;
    if (!isMouseEventLike(event)) return;
    quoteCardPointerStart = {
      clientX: event.clientX,
      clientY: event.clientY,
    };
    if (event.button !== 0) {
      shouldSuppressQuoteCardToggle = true;
    }
  });
  wrapper.addEventListener("mouseup", (event: Event) => {
    if (wrapper.dataset.quoteStatus !== "verified") return;
    if (!isMouseEventLike(event)) return;
    if (
      event.button !== 0 ||
      (quoteCardPointerStart &&
        quoteCardPointerMoved(quoteCardPointerStart, event)) ||
      hasActiveQuoteCardTextSelection(wrapper)
    ) {
      shouldSuppressQuoteCardToggle = true;
    }
  });
  wrapper.addEventListener("contextmenu", () => {
    if (wrapper.dataset.quoteStatus !== "verified") return;
    shouldSuppressQuoteCardToggle = true;
  });
  wrapper.addEventListener("click", (event: Event) => {
    if (wrapper.dataset.quoteStatus !== "verified") return;
    if (wrapper.dataset.expandable !== "true") return;
    if (shouldIgnoreToggle(event.target)) return;
    if (shouldSuppressQuoteCardToggle) {
      shouldSuppressQuoteCardToggle = false;
      quoteCardPointerStart = null;
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    quoteCardPointerStart = null;
    toggleExpanded();
  });
  content.addEventListener("keydown", (event: KeyboardEvent) => {
    if (wrapper.dataset.quoteStatus !== "verified") return;
    if (wrapper.dataset.expandable !== "true") return;
    if (event.key !== "Enter" && event.key !== " ") return;
    if (shouldIgnoreToggle(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    toggleExpanded();
  });

  const measureExpandability = () => {
    if (!wrapper.isConnected) return;
    const expandable = preview.scrollHeight > preview.clientHeight + 1;
    wrapper.dataset.expandable = expandable ? "true" : "false";
    if (expandable) {
      content.setAttribute("role", "button");
      content.setAttribute("tabindex", "0");
      content.setAttribute(
        "aria-expanded",
        wrapper.dataset.expanded || "false",
      );
      return;
    }
    wrapper.dataset.expanded = "false";
    content.removeAttribute("role");
    content.removeAttribute("tabindex");
    content.removeAttribute("aria-expanded");
  };
  params.ownerDoc.defaultView?.requestAnimationFrame(measureExpandability);

  return wrapper;
}

function createFallbackQuoteCardElement(params: {
  ownerDoc: Document;
  quoteText: string;
  citationLabel?: string;
  citationContent?: Node;
  quoteContent?: DocumentFragment | null;
}): HTMLElement {
  let citationContent = params.citationContent;
  if (!citationContent) {
    citationContent = params.ownerDoc.createElement("span");
    const citationLabel = sanitizeText(params.citationLabel || "").trim();
    if (citationLabel) {
      citationContent.textContent = citationLabel;
    }
  }
  return createQuoteCardElement({
    ownerDoc: params.ownerDoc,
    quoteText: params.quoteText,
    citationContent,
    quoteContent: params.quoteContent,
  });
}

function createQuoteCitationAnchorElement(params: {
  ownerDoc: Document;
  body: Element;
  panelItem: Zotero.Item;
  candidates: AssistantCitationPaperCandidate[];
  quoteCitation: QuoteCitation;
}): HTMLElement {
  const extractedCitation = extractStandalonePaperSourceLabel(
    params.quoteCitation.citationLabel,
  );
  const displayText = getQuoteCitationDisplayText(params.quoteCitation);
  if (!extractedCitation) {
    return createQuoteCardElement({
      ownerDoc: params.ownerDoc,
      quoteText: displayText,
      quoteCitationId: params.quoteCitation.id,
      status: "unverified",
    });
  }
  const lookupText = resolveQuoteCitationLookupText(params.quoteCitation);
  const matchingCandidates = resolveQuoteCitationCandidates(
    params.quoteCitation,
    extractedCitation,
    params.candidates,
  );
  const citationContent: Node = createCitationButton({
    ownerDoc: params.ownerDoc,
    body: params.body,
    panelItem: params.panelItem,
    candidates: matchingCandidates,
    extractedCitation,
    quoteText: lookupText,
    quoteCitation: params.quoteCitation,
    paragraphQuoteText: params.quoteCitation.quoteText,
    navigationMode: "trusted-quote",
    rawCitationText: params.quoteCitation.citationLabel,
  });
  return createQuoteCardElement({
    ownerDoc: params.ownerDoc,
    quoteText: displayText,
    quoteCitationId: params.quoteCitation.id,
    citationContent,
  });
}

function createQuoteRenderOccurrenceElement(params: {
  ownerDoc: Document;
  body: Element;
  panelItem: Zotero.Item;
  candidates: AssistantCitationPaperCandidate[];
  occurrence: QuoteRenderOccurrence;
}): HTMLElement {
  const trustedCitation = params.occurrence.quoteCitation;
  if (trustedCitation) {
    const extractedCitation = extractStandalonePaperSourceLabel(
      params.occurrence.citationLabel,
    );
    if (!extractedCitation) {
      return createQuoteCardElement({
        ownerDoc: params.ownerDoc,
        quoteText: params.occurrence.displayText,
        quoteCitationId: trustedCitation.id,
        quoteOccurrenceId: params.occurrence.occurrenceId,
        status: "unverified",
      });
    }
    const lookupText = resolveQuoteCitationLookupText(trustedCitation);
    const matchingCandidates = resolveQuoteCitationCandidates(
      trustedCitation,
      extractedCitation,
      params.candidates,
    );
    const citationContent: Node = createCitationButton({
      ownerDoc: params.ownerDoc,
      body: params.body,
      panelItem: params.panelItem,
      candidates: matchingCandidates,
      extractedCitation,
      quoteText: lookupText,
      quoteCitation: trustedCitation,
      paragraphQuoteText: trustedCitation.quoteText,
      navigationMode: "trusted-quote",
      rawCitationText: params.occurrence.citationLabel,
    });
    return createQuoteCardElement({
      ownerDoc: params.ownerDoc,
      quoteText: params.occurrence.displayText,
      quoteCitationId: trustedCitation.id,
      quoteOccurrenceId: params.occurrence.occurrenceId,
      citationContent,
      status: "verified",
    });
  }

  if (params.occurrence.trust === "not-source-quote") {
    return createQuoteCardElement({
      ownerDoc: params.ownerDoc,
      quoteText: params.occurrence.displayText,
      quoteOccurrenceId: params.occurrence.occurrenceId,
      status: "not-source",
    });
  }

  const extractedCitation = extractStandalonePaperSourceLabel(
    params.occurrence.citationLabel,
  );
  if (!extractedCitation) {
    return createQuoteCardElement({
      ownerDoc: params.ownerDoc,
      quoteText: params.occurrence.displayText,
      quoteOccurrenceId: params.occurrence.occurrenceId,
      status: "unverified",
    });
  }
  const citationContent: Node = createCitationButton({
    ownerDoc: params.ownerDoc,
    body: params.body,
    panelItem: params.panelItem,
    candidates: resolveMatchingCandidatesForExtractedCitation(
      extractedCitation,
      params.candidates,
    ),
    extractedCitation,
    quoteText: params.occurrence.lookupText,
    paragraphQuoteText: params.occurrence.lookupText,
    navigationMode: "untrusted-quote",
    preferRawCitationLabel: true,
    rawCitationText: params.occurrence.citationLabel,
  });
  return createQuoteCardElement({
    ownerDoc: params.ownerDoc,
    quoteText: params.occurrence.displayText,
    quoteOccurrenceId: params.occurrence.occurrenceId,
    citationContent,
    status: "verified",
  });
}

function textContainsQuoteCitationPlaceholder(text: string): boolean {
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  const matched = QUOTE_CITATION_PATTERN.test(text);
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  return matched;
}

function hasMeaningfulParagraphContent(paragraph: HTMLElement): boolean {
  if ((paragraph.textContent || "").trim()) return true;
  const childNodes = Array.from(paragraph.childNodes).filter(
    (node): node is Node => Boolean(node),
  );
  return childNodes.some(
    (node) =>
      node.nodeType === 1 && (node as Element).tagName.toLowerCase() !== "br",
  );
}

function liftQuoteCardsOutOfParagraph(paragraph: HTMLElement): void {
  const parent = paragraph.parentNode;
  const ownerDoc = paragraph.ownerDocument;
  if (!parent || !ownerDoc) return;

  const children = Array.from(paragraph.childNodes).filter(
    (node): node is Node => Boolean(node),
  );
  if (
    !children.some(
      (node) =>
        node.nodeType === 1 &&
        (node as Element).classList?.contains("llm-quote-card"),
    )
  ) {
    return;
  }

  const replacement = ownerDoc.createDocumentFragment();
  let inlineParagraph: HTMLElement | null = null;
  const flushInlineParagraph = () => {
    if (!inlineParagraph) return;
    if (hasMeaningfulParagraphContent(inlineParagraph)) {
      replacement.appendChild(inlineParagraph);
    }
    inlineParagraph = null;
  };

  for (const child of children) {
    if (
      child.nodeType === 1 &&
      (child as Element).classList?.contains("llm-quote-card")
    ) {
      flushInlineParagraph();
      replacement.appendChild(child);
      continue;
    }
    if (!inlineParagraph) {
      inlineParagraph = ownerDoc.createElement("p");
    }
    inlineParagraph.appendChild(child);
  }
  flushInlineParagraph();
  parent.replaceChild(replacement, paragraph);
}

export function renderQuoteCitationPlaceholders(params: {
  body: Element;
  panelItem: Zotero.Item;
  bubble: HTMLDivElement;
  assistantMessage: Message;
  pairedUserMessage?: Message | null;
}): void {
  const display = getMessageQuoteDisplay(params.assistantMessage);
  const plan = buildQuoteRenderPlan(display);
  QUOTE_RENDER_OCCURRENCE_PATTERN.lastIndex = 0;
  const hasQuoteOccurrence = QUOTE_RENDER_OCCURRENCE_PATTERN.test(
    params.bubble.textContent || "",
  );
  QUOTE_RENDER_OCCURRENCE_PATTERN.lastIndex = 0;
  if (
    !hasQuoteOccurrence &&
    !textContainsQuoteCitationPlaceholder(params.bubble.textContent || "")
  ) {
    return;
  }
  const occurrencesById = new Map(
    plan.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]),
  );
  const quoteCitations = normalizeQuoteCitations(display.quoteCitations);
  const citationsById = new Map(
    quoteCitations.map((citation) => [citation.id, citation]),
  );
  const ownerDoc = params.bubble.ownerDocument;
  if (!ownerDoc) return;
  const candidates = collectAssistantCitationCandidates(
    params.panelItem,
    params.pairedUserMessage,
  );
  const targets: Text[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const textNode = node as Text;
      const parent = textNode.parentElement;
      if (!parent || shouldSkipInlineCitationNode(parent)) return;
      const text = textNode.nodeValue || "";
      QUOTE_RENDER_OCCURRENCE_PATTERN.lastIndex = 0;
      const hasOccurrence = QUOTE_RENDER_OCCURRENCE_PATTERN.test(text);
      QUOTE_RENDER_OCCURRENCE_PATTERN.lastIndex = 0;
      if (hasOccurrence || textContainsQuoteCitationPlaceholder(text)) {
        targets.push(textNode);
      }
      return;
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      walk(child);
    }
  };
  walk(params.bubble);

  for (const textNode of targets) {
    const text = textNode.nodeValue || "";
    QUOTE_RENDER_OCCURRENCE_PATTERN.lastIndex = 0;
    const occurrenceMatches = Array.from(
      text.matchAll(QUOTE_RENDER_OCCURRENCE_PATTERN),
    );
    QUOTE_RENDER_OCCURRENCE_PATTERN.lastIndex = 0;
    QUOTE_CITATION_PATTERN.lastIndex = 0;
    const matches = Array.from(text.matchAll(QUOTE_CITATION_PATTERN));
    QUOTE_CITATION_PATTERN.lastIndex = 0;
    if (!occurrenceMatches.length && !matches.length) continue;
    const fragment = ownerDoc.createDocumentFragment();
    let cursor = 0;
    const allMatches = [
      ...occurrenceMatches.map((match) => ({
        kind: "occurrence" as const,
        index: match.index || 0,
        token: match[0],
        id: match[1],
      })),
      ...matches.map((match) => ({
        kind: "citation" as const,
        index: match.index || 0,
        token: match[0],
        id: match[1],
      })),
    ].sort((left, right) => left.index - right.index);
    for (const match of allMatches) {
      const start = match.index || 0;
      const end = start + match.token.length;
      if (start > cursor) {
        fragment.appendChild(
          ownerDoc.createTextNode(text.slice(cursor, start)),
        );
      }
      if (match.kind === "occurrence") {
        const occurrence = occurrencesById.get(match.id);
        if (occurrence) {
          fragment.appendChild(
            createQuoteRenderOccurrenceElement({
              ownerDoc,
              body: params.body,
              panelItem: params.panelItem,
              candidates,
              occurrence,
            }),
          );
        }
      } else {
        const quoteCitation = citationsById.get(match.id);
        if (quoteCitation) {
          fragment.appendChild(
            createQuoteCitationAnchorElement({
              ownerDoc,
              body: params.body,
              panelItem: params.panelItem,
              candidates,
              quoteCitation,
            }),
          );
        }
      }
      cursor = end;
    }
    if (cursor < text.length) {
      fragment.appendChild(ownerDoc.createTextNode(text.slice(cursor)));
    }

    const parent = textNode.parentElement;
    const trimmed = text.trim();
    if (
      parent?.tagName.toLowerCase() === "p" &&
      parent.childNodes.length === 1 &&
      allMatches.length === 1 &&
      trimmed === allMatches[0].token
    ) {
      parent.replaceWith(fragment);
    } else {
      textNode.parentNode?.replaceChild(fragment, textNode);
      if (parent?.tagName.toLowerCase() === "p") {
        liftQuoteCardsOutOfParagraph(parent);
      }
    }
  }
}

function shouldSkipInlineCitationNode(element: Element | null): boolean {
  if (!element) return true;
  if (element.closest(INLINE_CITATION_SKIP_SELECTOR)) {
    return true;
  }
  const tag = element.tagName.toLowerCase();
  if (tag === "script" || tag === "style") return true;
  return false;
}

function decorateInlineCitationNodes(params: {
  body: Element;
  bubble: HTMLDivElement;
  ownerDoc: Document;
  panelItem: Zotero.Item;
  candidates: AssistantCitationPaperCandidate[];
}): void {
  const targets: Text[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const textNode = node as Text;
      const parent = textNode.parentElement;
      if (!parent || shouldSkipInlineCitationNode(parent)) return;
      const text = textNode.nodeValue || "";
      if (text.length < 8) return;
      const trimmedText = stripCitationControlChars(sanitizeText(text)).trim();
      if (extractStandalonePaperSourceLabel(trimmedText)) return;
      const mentions = extractInlineCitationMentions(text);
      if (mentions.length) targets.push(textNode);
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (shouldSkipInlineCitationNode(element)) return;
    let child: Node | null = node.firstChild;
    while (child) {
      const next: Node | null = child.nextSibling;
      walk(child);
      child = next;
    }
  };
  walk(params.bubble);
  ztoolkit.log(
    "LLM citation decoration: inline text targets =",
    targets.length,
  );

  for (const textNode of targets) {
    const text = textNode.nodeValue || "";
    const mentions = extractInlineCitationMentions(text);
    if (!mentions.length) continue;
    const frag = params.ownerDoc.createDocumentFragment();
    let cursor = 0;
    let decoratedCount = 0;
    for (const mention of mentions) {
      if (mention.start < cursor) continue;
      const prefix = text.slice(cursor, mention.start);
      if (prefix) {
        frag.appendChild(params.ownerDoc.createTextNode(prefix));
      }

      const matchingCandidates = resolveMatchingCandidatesForExtractedCitation(
        mention.extractedCitation,
        params.candidates,
      );
      // Only create a citation element with an icon when there are matching
      // candidates.  Without matching candidates, render plain text only.
      if (matchingCandidates.length) {
        const citationEl = createCitationButton({
          ownerDoc: params.ownerDoc,
          body: params.body,
          panelItem: params.panelItem,
          candidates: matchingCandidates,
          extractedCitation: mention.extractedCitation,
          quoteText: "",
          navigationMode: "inline-citation",
          inline: true,
          rawCitationText: mention.rawText,
        });
        frag.appendChild(citationEl);
      } else {
        // No match → keep original text as-is (no icon)
        frag.appendChild(
          params.ownerDoc.createTextNode(
            text.slice(mention.start, mention.end),
          ),
        );
      }
      cursor = mention.end;
      decoratedCount += 1;
    }
    if (!decoratedCount) continue;
    if (cursor < text.length) {
      frag.appendChild(params.ownerDoc.createTextNode(text.slice(cursor)));
    }
    textNode.parentNode?.replaceChild(frag, textNode);
  }
}

function replaceBlockquoteWithFallbackQuoteCard(params: {
  ownerDoc: Document;
  blockquote: Element;
  quoteText: string;
  citationLabel?: string;
  citationContent?: Node;
  quoteContent?: DocumentFragment | null;
}): HTMLElement | null {
  const quoteText = sanitizeText(params.quoteText).trim();
  if (!quoteText) return null;
  const quoteCard = createFallbackQuoteCardElement({
    ownerDoc: params.ownerDoc,
    quoteText,
    citationLabel: params.citationLabel,
    citationContent: params.citationContent,
    quoteContent: params.quoteContent,
  });
  const blockquoteParent = params.blockquote.parentNode;
  if (!blockquoteParent) return null;
  blockquoteParent.replaceChild(quoteCard, params.blockquote);
  return quoteCard;
}

function normalizeQuoteCardDisplayText(value: string): string {
  return sanitizeText(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isBlankQuoteCardNode(node: Node | undefined): boolean {
  return Boolean(
    node && node.nodeType === 3 && !sanitizeText(node.textContent || "").trim(),
  );
}

function isStandaloneBlockquoteCitationNode(
  node: Node | undefined,
  extractedCitation: ExtractedCitationLabel | null | undefined,
): boolean {
  if (!node || !extractedCitation) return false;
  const parsed = extractStandalonePaperSourceLabel(node.textContent || "");
  return Boolean(
    parsed &&
    parsed.normalizedSourceLabel === extractedCitation.normalizedSourceLabel,
  );
}

function buildQuoteCardBodyContentFromBlockquote(
  blockquote: Element,
  quoteText: string,
  extractedCitation?: ExtractedCitationLabel | null,
): DocumentFragment | null {
  const ownerDoc = blockquote.ownerDocument;
  if (!ownerDoc) return null;
  const childNodes = Array.from(blockquote.childNodes).filter(
    (node): node is Node => Boolean(node),
  );
  let end = childNodes.length;
  while (end > 0 && isBlankQuoteCardNode(childNodes[end - 1])) end -= 1;
  let removedCitationNode = false;
  if (
    end > 0 &&
    isStandaloneBlockquoteCitationNode(childNodes[end - 1], extractedCitation)
  ) {
    end -= 1;
    removedCitationNode = true;
    while (end > 0 && isBlankQuoteCardNode(childNodes[end - 1])) end -= 1;
  }
  const bodyNodes = childNodes.slice(0, end);
  const displayedText = normalizeQuoteCardDisplayText(
    bodyNodes.map((node) => node.textContent || "").join("\n"),
  );
  if (
    !displayedText ||
    (!extractedCitation &&
      displayedText !== normalizeQuoteCardDisplayText(quoteText))
  ) {
    return null;
  }
  if (
    extractedCitation &&
    !removedCitationNode &&
    extractBlockquoteTailCitation(displayedText)
  ) {
    return null;
  }
  const fragment = ownerDoc.createDocumentFragment();
  for (const node of bodyNodes) {
    fragment.appendChild(node);
  }
  return fragment.firstChild ? fragment : null;
}

export function decorateAssistantCitationLinks(params: {
  body: Element;
  panelItem: Zotero.Item;
  bubble: HTMLDivElement;
  assistantMessage: Message;
  pairedUserMessage?: Message | null;
}): void {
  const display = getMessageQuoteDisplay(params.assistantMessage);
  if (
    !sanitizeText(params.bubble.textContent || display.markdown || "").trim()
  ) {
    return;
  }
  const ownerDoc = params.bubble.ownerDocument;
  if (!ownerDoc) return;
  const quoteCitations = normalizeQuoteCitations(display.quoteCitations);
  const activeReader = getActiveReaderForSelectedTab();
  if (activeReader) {
    scheduleCitationPageTextCacheWarm(activeReader, ownerDoc);
  }

  // Collect paper context candidates from the user message and panel item.
  // This list may be empty (e.g. when the agent is disabled and no paper
  // contexts were forwarded).  Buttons are still created in that case — the
  // click handler will dynamically resolve a fallback from the panel item.
  const candidates = collectAssistantCitationCandidates(
    params.panelItem,
    params.pairedUserMessage,
  );
  const blockquotes = Array.from(
    params.bubble.querySelectorAll("blockquote"),
  ) as Element[];
  const rawBlockquoteTexts =
    extractMarkdownBlockquoteTextsForCitationDecoration(display.markdown);
  ztoolkit.log(
    "LLM citation decoration: blockquotes found =",
    blockquotes.length,
    "candidates =",
    candidates.length,
    "bubble HTML length =",
    String(params.bubble.innerHTML || "").length,
    "bubble child count =",
    params.bubble.childElementCount,
  );
  for (const [blockquoteIndex, blockquote] of blockquotes.entries()) {
    if (
      blockquote.closest(
        ".llm-quote-citation-anchor, [data-quote-status='not-source'], [data-quote-status='unverified']",
      )
    ) {
      continue;
    }
    const sourceBlockquoteText =
      rawBlockquoteTexts[blockquoteIndex] || blockquote.textContent || "";
    if (/(?:^|\n)\s*Not a source quote\s*$/i.test(sourceBlockquoteText)) {
      continue;
    }
    let quoteText = sanitizeText(sourceBlockquoteText).trim();
    if (!quoteText) continue;
    let citationEl = getNextElementSibling(blockquote);
    const tailMatch = extractBlockquoteTailCitation(sourceBlockquoteText);

    // Primary attempt: entire element is a standalone citation label.
    let extractedCitation = citationEl
      ? extractStandalonePaperSourceLabel(citationEl.textContent || "")
      : null;

    // Edge-case fallback: the element may start with a citation label followed
    // by continuation text on the same line or subsequent lines (no clean block
    // boundary in the model output → single <p> block in rendered HTML).
    let citationRemainder: string | null = null;
    if (!extractedCitation && citationEl) {
      const leadingAttempt = extractLeadingPaperSourceLabelWithRemainder(
        citationEl.textContent || "",
      );
      if (leadingAttempt) {
        extractedCitation = leadingAttempt.extractedCitation;
        citationRemainder = leadingAttempt.remainder;
      }
    }

    if (
      extractedCitation &&
      tailMatch &&
      tailMatch.extractedCitation.normalizedSourceLabel ===
        extractedCitation.normalizedSourceLabel
    ) {
      quoteText = tailMatch.quoteText;
    }

    // Some model outputs put the citation on the final line *inside* the same
    // blockquote. Recover by splitting a trailing citation line from quote text.
    if (!extractedCitation && tailMatch) {
      extractedCitation = tailMatch.extractedCitation;
      quoteText = tailMatch.quoteText;
      citationEl = createSyntheticCitationElement({
        ownerDoc,
        blockquote,
        citationEl,
        extractedCitation,
      });
    }

    if (!extractedCitation) {
      if (!citationEl) {
        ztoolkit.log(
          "LLM citation decoration: no sibling citation and no inline tail citation for blockquote, text =",
          (blockquote.textContent || "").slice(0, 80),
        );
      } else {
        ztoolkit.log(
          "LLM citation decoration: sibling text not a citation, text =",
          JSON.stringify((citationEl.textContent || "").slice(0, 80)),
        );
      }
      // A quote card implies provenance.  Leave unresolved blockquotes as
      // plain Markdown instead of showing a source-less evidence card.
      continue;
    }

    if (!citationEl) {
      ztoolkit.log(
        "LLM citation decoration: citation parsed but no target element available",
      );
      continue;
    }
    ztoolkit.log(
      "LLM citation decoration: creating button for",
      extractedCitation.sourceLabel,
    );

    const trustedQuoteCitation = findMatchingTrustedQuoteCitation({
      quoteText,
      citationLabel: extractedCitation.sourceLabel,
      quoteCitations,
    });
    if (!trustedQuoteCitation) {
      ztoolkit.log(
        "LLM citation decoration: rendering untrusted source-backed quote as fallback quote card",
        "source =",
        extractedCitation.sourceLabel,
        "quote =",
        quoteText.slice(0, 120),
      );
      const citationElement = createCitationButton({
        ownerDoc,
        body: params.body,
        panelItem: params.panelItem,
        candidates,
        extractedCitation,
        quoteText,
        paragraphQuoteText: quoteText,
        navigationMode: "untrusted-quote",
        preferRawCitationLabel: true,
      });
      const displayedQuoteContent = buildQuoteCardBodyContentFromBlockquote(
        blockquote,
        quoteText,
        extractedCitation,
      );
      const quoteCard = replaceBlockquoteWithFallbackQuoteCard({
        ownerDoc,
        blockquote,
        quoteText,
        citationLabel: extractedCitation.sourceLabel,
        citationContent: citationElement,
        quoteContent: displayedQuoteContent,
      });
      removeConsumedSourceBackedQuoteCitation({
        anchorElement: quoteCard || blockquote,
        citationEl,
        extractedCitation,
        replacementText: citationRemainder,
      });
      continue;
    }
    const displayedQuoteText = quoteText;
    const displayedQuoteContent = buildQuoteCardBodyContentFromBlockquote(
      blockquote,
      displayedQuoteText,
      extractedCitation,
    );
    const trustedQuoteText = trustedQuoteCitation.quoteText;
    const lookupQuoteText =
      resolveQuoteCitationLookupText(trustedQuoteCitation);

    // Try to match the trusted quote citation against known paper candidates.
    const matchingCandidates = resolveQuoteCitationCandidates(
      trustedQuoteCitation,
      extractedCitation,
      candidates,
    );
    startCitationQuoteLocationCacheWarm(matchingCandidates, lookupQuoteText);
    // NOTE: matchingCandidates may still be empty here.  That is fine — the
    // click handler will resolve fallback candidates dynamically.
    const citationElement = createCitationButton({
      ownerDoc,
      body: params.body,
      panelItem: params.panelItem,
      candidates: matchingCandidates,
      extractedCitation,
      quoteText: lookupQuoteText,
      quoteCitation: trustedQuoteCitation,
      paragraphQuoteText: trustedQuoteText,
      navigationMode: "trusted-quote",
    });

    const quoteCard = createQuoteCardElement({
      ownerDoc,
      quoteText: displayedQuoteText,
      quoteCitationId: trustedQuoteCitation.id,
      citationContent: citationElement,
      quoteContent: displayedQuoteContent,
    });
    const blockquoteParent = blockquote.parentNode;
    if (!blockquoteParent) continue;
    blockquoteParent.replaceChild(quoteCard, blockquote);
    removeConsumedSourceBackedQuoteCitation({
      anchorElement: quoteCard,
      citationEl,
      extractedCitation,
      replacementText: citationRemainder,
    });
  }

  decorateInlineCitationNodes({
    body: params.body,
    bubble: params.bubble,
    ownerDoc,
    panelItem: params.panelItem,
    candidates,
  });
}
