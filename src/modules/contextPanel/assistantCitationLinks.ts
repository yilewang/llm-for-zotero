import { sanitizeText, setStatus } from "./textUtils";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
  resolvePaperContextRefFromAttachment,
} from "./paperAttribution";
import {
  normalizePaperContextRefs,
  normalizeSelectedTextPaperContexts,
} from "./normalizers";
import {
  getActiveReaderForSelectedTab,
  resolveContextSourceItem,
} from "./contextResolution";
import {
  type ExactQuoteJumpResult,
  flashPageInLivePdfReader,
  type LivePdfPageText,
  locateQuoteByRawPrefixInPages,
  locateQuoteInPageTexts,
  locateQuoteInLivePdfReader,
  getPageLabelForIndex,
  resolvePageIndexForLabel,
  scrollToExactQuoteInReader,
  splitQuoteAtEllipsis,
  stripBoundaryEllipsis,
  warmPageTextCache,
} from "./livePdfSelectionLocator";
import { resolveConversationBaseItem } from "./portalScope";
import { searchPaperCandidates } from "./paperSearch";
import type { Message, PaperContextRef } from "./types";

type CitationParagraphJumpNavigation = {
  pageIndex: number;
  pageLabel: string;
  paragraphJump: ExactQuoteJumpResult;
};

export type AssistantCitationPaperCandidate = {
  paperContext: PaperContextRef;
  contextItemId: number;
  sourceLabel: string;
  citationLabel: string;
  normalizedSourceLabel: string;
  normalizedCitationLabel: string;
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

function isCitationControlCharCode(code: number): boolean {
  return (
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff ||
    code === 0x00ad
  );
}

function stripCitationControlChars(value: string): string {
  const source = String(value || "");
  if (!source) return "";
  let out = "";
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (isCitationControlCharCode(code)) continue;
    out += source[index];
  }
  return out;
}

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

const citationPageCache = new Map<
  string,
  {
    pageIndex: number;
    pageLabel?: string;
  }
>();

const citationPageLookupTasks = new Map<
  string,
  Promise<{
    pageIndex: number;
    pageLabel: string;
  } | null>
>();

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
  return normalizedPageLabel || `${normalizedPageIndex + 1}`;
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
  citationPageCache.set(
    buildCitationCacheKey(normalizedContextItemId, normalizedQuoteText),
    {
      pageIndex: Math.floor(pageIndex),
      pageLabel: normalizedPageLabel,
    },
  );
  return normalizedPageLabel;
}

export function clearCachedCitationPagesForTests(): void {
  citationPageCache.clear();
  citationPageLookupTasks.clear();
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
  const key = buildCitationCacheKey(
    contextItemId,
    sanitizeText(quoteText || "").trim(),
  );
  return citationPageCache.get(key)?.pageLabel ?? null;
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

function normalizeCitationLabel(value: string): string {
  return stripCitationControlChars(sanitizeText(value || ""))
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeCitationKey(value: string): string {
  return stripCitationControlChars(sanitizeText(value || ""))
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function stripCitationKeyFromLabel(value: string): string {
  return stripCitationControlChars(sanitizeText(value || ""))
    .replace(/\s*\[[^\]]+\]\s*$/g, "")
    .trim();
}

function formatCitationChipLabel(
  displayCitationLabel: string,
  pageLabel?: string,
): string {
  const cleanCitation = stripCitationKeyFromLabel(displayCitationLabel);
  const cleanPage = sanitizeText(pageLabel || "").trim();
  return cleanPage ? `${cleanCitation}, page ${cleanPage}` : cleanCitation;
}

function setCitationButtonLabel(
  button: HTMLButtonElement,
  displayCitationLabel: string,
  pageLabel?: string,
): void {
  const labelText = formatCitationChipLabel(displayCitationLabel, pageLabel);
  // In the new icon-based layout the text span is a sibling of the button
  // inside a shared .llm-citation-row / .llm-citation-inline-wrap container.
  const container = button.parentElement;
  const textSpan = container?.querySelector(
    ".llm-citation-text",
  ) as HTMLSpanElement | null;
  if (textSpan) {
    const rawText = textSpan.dataset.rawText;
    if (rawText) {
      if (pageLabel) {
        // Strip any existing "page X" from the raw text before appending the
        // corrected page — the LLM may have written "page 1" which we're now
        // correcting to the actual page found by FindController.
        const stripped = rawText.replace(/,?\s*page\s+[^,)]+/i, "").trim();
        if (stripped.endsWith(")")) {
          textSpan.textContent = stripped.replace(
            /\)$/,
            `, page ${pageLabel})`,
          );
        } else {
          textSpan.textContent = `${stripped}, page ${pageLabel}`;
        }
      } else {
        textSpan.textContent = rawText;
      }
    } else {
      textSpan.textContent = labelText;
    }
  }
  button.setAttribute("aria-label", `Jump to cited source: ${labelText}`);
}

function replaceBlockquoteText(blockquote: Element, quoteText: string): void {
  const ownerDoc = blockquote.ownerDocument;
  if (!ownerDoc) return;
  const normalizedQuote = sanitizeText(quoteText || "").trim();
  if (!normalizedQuote) return;
  blockquote.textContent = normalizedQuote;
}

function extractAuthorKey(normalizedLabel: string): string {
  const stripped = normalizedLabel.replace(/^\(|\)$/g, "").trim();
  // Try to match "Author et al" first
  const matchEtAl = stripped.match(/^(\S+)\s+et\s+al/i);
  if (matchEtAl) return matchEtAl[1].replace(/[,;.]+$/g, "");
  // Otherwise, match the first word before a comma, '&', 'and', or year
  const matchFirst = stripped.match(/^(\p{L}+)/u);
  return matchFirst ? matchFirst[1].toLowerCase() : "";
}

function normalizeQuoteKey(value: string): string {
  return sanitizeText(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildCitationCacheKey(
  contextItemId: number,
  quoteText: string,
): string {
  return `${Math.floor(contextItemId)}\u241f${normalizeQuoteKey(quoteText)}`;
}

function getReaderItemId(reader: any): number {
  const raw = Number(reader?._item?.id || reader?.itemID || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
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
  if (!item) return null;
  if (
    item.isAttachment?.() &&
    item.attachmentContentType === "application/pdf"
  ) {
    return item;
  }
  const attachments = item.getAttachments?.() || [];
  for (const attachmentId of attachments) {
    const attachment = Zotero.Items.get(attachmentId) || null;
    if (attachment?.attachmentContentType === "application/pdf") {
      return attachment;
    }
  }
  return null;
}

function addCitationCandidate(
  out: AssistantCitationPaperCandidate[],
  seen: Set<string>,
  paperContext: PaperContextRef | null | undefined,
  contextItemId?: number | null,
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
  const sourceLabel = formatPaperSourceLabel(paperContext);
  const citationLabel = formatPaperCitationLabel(paperContext);
  out.push({
    paperContext,
    contextItemId: Math.floor(normalizedContextItemId),
    sourceLabel,
    citationLabel,
    normalizedSourceLabel: normalizeCitationLabel(sourceLabel),
    normalizedCitationLabel: normalizeCitationLabel(citationLabel),
  });
}

function collectAssistantCitationCandidates(
  panelItem: Zotero.Item,
  pairedUserMessage: Message | null | undefined,
): AssistantCitationPaperCandidate[] {
  const out: AssistantCitationPaperCandidate[] = [];
  const seen = new Set<string>();

  const selectedTextPaperContexts = normalizeSelectedTextPaperContexts(
    pairedUserMessage?.selectedTextPaperContexts,
    getSelectedTextCount(pairedUserMessage),
    { sanitizeText },
  );
  for (const paperContext of selectedTextPaperContexts) {
    addCitationCandidate(out, seen, paperContext, paperContext?.contextItemId);
  }

  const paperContexts = normalizePaperContextRefs(
    pairedUserMessage?.paperContexts,
    { sanitizeText },
  );
  for (const paperContext of paperContexts) {
    addCitationCandidate(out, seen, paperContext, paperContext.contextItemId);
  }

  const resolvedContextItem = resolveContextSourceItem(panelItem).contextItem;
  const resolvedContextRef =
    resolvePaperContextRefFromAttachment(resolvedContextItem);
  addCitationCandidate(out, seen, resolvedContextRef, resolvedContextItem?.id);

  const basePaper = resolveConversationBaseItem(panelItem);
  const basePaperAttachment = getFirstPdfAttachment(basePaper);
  const basePaperRef =
    resolvePaperContextRefFromAttachment(basePaperAttachment);
  addCitationCandidate(out, seen, basePaperRef, basePaperAttachment?.id);

  return out;
}

function buildCandidateListFromPaperContexts(
  paperContexts: PaperContextRef[],
): AssistantCitationPaperCandidate[] {
  return paperContexts.map((paperContext) => ({
    paperContext,
    contextItemId: Math.floor(paperContext.contextItemId),
    sourceLabel: formatPaperSourceLabel(paperContext),
    citationLabel: formatPaperCitationLabel(paperContext),
    normalizedSourceLabel: normalizeCitationLabel(
      formatPaperSourceLabel(paperContext),
    ),
    normalizedCitationLabel: normalizeCitationLabel(
      formatPaperCitationLabel(paperContext),
    ),
  }));
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

export function extractStandalonePaperSourceLabel(
  value: string,
): ExtractedCitationLabel | null {
  const normalized = stripCitationControlChars(sanitizeText(value || ""))
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;

  const parseCitationParts = (
    rawCitation: string,
    rawKey?: string,
    rawPage?: string,
  ) => {
    const citationWithoutKey = stripCitationKeyFromLabel(rawCitation);
    const matchCitationLabel = stripLeadingCitationCueLabel(citationWithoutKey);
    const citationKeyFromLabelMatch = rawCitation.match(/\[([^\]]+)\]\s*$/);
    const parsedCitationKey = stripCitationControlChars(
      sanitizeText(rawKey || citationKeyFromLabelMatch?.[1] || ""),
    ).trim();
    const parsedPageLabel = stripCitationControlChars(
      sanitizeText(rawPage || ""),
    ).trim();
    const sourceLabel = parsedCitationKey
      ? `(${citationWithoutKey} [${parsedCitationKey}])`
      : `(${citationWithoutKey})`;
    const citationLabel = parsedCitationKey
      ? `${matchCitationLabel} [${parsedCitationKey}]`
      : matchCitationLabel;
    return {
      sourceLabel,
      citationLabel,
      displayCitationLabel: citationWithoutKey,
      citationKey: parsedCitationKey || undefined,
      pageLabel: parsedPageLabel || undefined,
      normalizedSourceLabel: normalizeCitationLabel(sourceLabel),
      normalizedCitationLabel: normalizeCitationLabel(citationLabel),
      normalizedDisplayCitationLabel:
        normalizeCitationLabel(matchCitationLabel),
      normalizedCitationKey:
        normalizeCitationKey(parsedCitationKey) || undefined,
    };
  };

  const wrappedMatch = normalized.match(/^\((.+)\)$/);
  if (wrappedMatch) {
    const inner = wrappedMatch[1].trim();
    // Verify the outer parens form a single top-level group: no unmatched ')'
    // inside the inner content (depth must never go negative). Without this
    // check, a paragraph like "(Author, 2026) Some text... (Author, 2026, page 5)"
    // would incorrectly match because it starts with '(' and ends with ')'.
    let parenDepth = 0;
    let isValidSingleGroup = true;
    for (const ch of inner) {
      if (ch === "(") {
        parenDepth++;
      } else if (ch === ")") {
        parenDepth--;
        if (parenDepth < 0) {
          isValidSingleGroup = false;
          break;
        }
      }
    }
    if (!isValidSingleGroup) {
      // Fall through to the stricter splitMatch path below.
    } else {
      const innerParts = inner.match(
        /^(.*?)(?:\s+\[([^\]]+)\])?(?:\s*,?\s*page\s+([^,;]+))?\.?$/i,
      );
      if (!innerParts) return null;
      const citationLabel = sanitizeText(innerParts[1] || "").trim();
      if (!citationLabel || citationLabel.length < 4) return null;
      return parseCitationParts(citationLabel, innerParts[2], innerParts[3]);
    }
  }

  const splitMatch = normalized.match(
    /^\((.+?)\)\s*(?:\[([^\]]+)\])?(?:\s*,?\s*page\s+([^,;]+))?\.?$/i,
  );
  if (!splitMatch) return null;
  const citationLabel = sanitizeText(splitMatch[1] || "").trim();
  if (!citationLabel || citationLabel.length < 4) return null;
  return {
    ...parseCitationParts(citationLabel, splitMatch[2], splitMatch[3]),
  };
}

function isLikelyStandaloneCitationLabel(value: string): boolean {
  const clean = stripCitationControlChars(sanitizeText(value || ""))
    .replace(/\s+/g, " ")
    .trim();
  const normalized = clean.toLowerCase();
  if (!normalized) return false;
  return (
    /\bet\s+al\b/.test(normalized) ||
    /\b(19|20)\d{2}\b/.test(normalized) ||
    /\bcid:[^\]]+/.test(normalized) ||
    /\[[^\]]+\]/.test(normalized) ||
    /\bpaper(?:\s+\d+)?\b/.test(normalized) ||
    /(?:[A-Z][\p{L}'’.-]+)\s+(?:and|&)\s+(?:[A-Z][\p{L}'’.-]+)/u.test(clean)
  );
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

function stripLeadingCitationCueLabel(value: string): string {
  const { stripped } = stripLeadingInlineCitationCue(value);
  const normalized = sanitizeText(stripped || value).trim();
  return normalized || sanitizeText(value || "").trim();
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
      const pdfAttachment = getFirstPdfAttachment(targetItem);
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

function buildParagraphJumpSuccessStatus(pageLabel: string): string {
  return `Jumped to cited source (page ${pageLabel}, paragraph matched)`;
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
    quoteTextSample: sanitizeText(params.quoteText || "").slice(0, 240),
    quoteTextLength: sanitizeText(params.quoteText || "").length,
    pageIndex: params.pageIndex,
    pageLabel: params.pageLabel,
    expectedPageIndex: params.paragraphJump.expectedPageIndex,
    reason: params.paragraphJump.reason,
    queryUsed: params.paragraphJump.queryUsed,
    queries: params.paragraphJump.queries,
    debugSummary: params.paragraphJump.debugSummary,
  });
}

async function attemptCitationParagraphJump(params: {
  reader: any;
  contextItemId: number;
  displayCitationLabel: string;
  quoteText: string;
  pageIndex: number;
  pageLabel: string;
}): Promise<ExactQuoteJumpResult> {
  const paragraphJump = await scrollToExactQuoteInReader(
    params.reader,
    params.quoteText,
    { expectedPageIndex: params.pageIndex },
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
    // FindController did not navigate; fall back to coarse page-level jump + flash.
    const navigated = await navigateReaderToPage(
      params.reader,
      params.pageIndex,
      params.pageLabel,
    );
    const readerForFlash = navigated
      ? params.reader
      : await openReaderForItem(params.contextItemId, {
          pageIndex: params.pageIndex,
          pageLabel: params.pageLabel,
        });
    await flashPageInLivePdfReader(
      readerForFlash || params.reader,
      params.pageIndex,
    );
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
): Promise<CitationParagraphJumpNavigation | null> {
  const cacheKey = buildCitationCacheKey(contextItemId, quoteText);
  const cached = citationPageCache.get(cacheKey);
  if (!cached) return null;
  let targetPageIndex = Math.floor(cached.pageIndex);
  let targetPageLabel =
    typeof cached.pageLabel === "string" && cached.pageLabel.trim()
      ? cached.pageLabel.trim()
      : `${targetPageIndex + 1}`;

  const reader = await openReaderForItem(contextItemId);
  if (!reader) return null;

  // Skip text-search re-verification — it can return the wrong page (short
  // prefix false-match).  FindController in attemptCitationParagraphJump is
  // authoritative and will correct the page via matchedPageIndex.
  const paragraphJump = await attemptCitationParagraphJump({
    reader,
    contextItemId,
    displayCitationLabel,
    quoteText,
    pageIndex: targetPageIndex,
    pageLabel: targetPageLabel,
  });
  return {
    pageIndex: targetPageIndex,
    pageLabel: targetPageLabel,
    paragraphJump,
  };
}

function buildPageTextsFromPdfWorkerResult(result: any): LivePdfPageText[] {
  if (!result || !result.text) return [];
  const fullText = String(result.text || "");
  const pageChars = Array.isArray(result.pageChars) ? result.pageChars : [];
  if (pageChars.length) {
    const pages: LivePdfPageText[] = [];
    let offset = 0;
    for (let index = 0; index < pageChars.length; index++) {
      const charCount = Number(pageChars[index] || 0);
      if (charCount <= 0) {
        offset += Math.max(0, charCount);
        continue;
      }
      const pageText = fullText.slice(offset, offset + charCount);
      offset += charCount;
      const text = sanitizeText(pageText).trim();
      if (!text) continue;
      pages.push({
        pageIndex: index,
        pageLabel: `${index + 1}`,
        text,
      });
    }
    return pages;
  }

  const ffPages = fullText
    .split("\f")
    .map((text: string) => sanitizeText(text).trim())
    .filter(Boolean);
  return ffPages.map((text: string, index: number) => ({
    pageIndex: index,
    pageLabel: `${index + 1}`,
    text,
  }));
}

async function locateCitationPageWithPdfWorker(
  contextItemId: number,
  quoteText: string,
): Promise<{
  pageIndex: number;
  pageLabel: string;
} | null> {
  const normalizedContextItemId = Math.floor(contextItemId);
  if (
    !Number.isFinite(normalizedContextItemId) ||
    normalizedContextItemId <= 0
  ) {
    return null;
  }

  const lookupKey = buildCitationCacheKey(normalizedContextItemId, quoteText);
  const existingTask = citationPageLookupTasks.get(lookupKey);
  if (existingTask) {
    return existingTask;
  }

  const lookupTask = (async () => {
    try {
      const result = await Zotero.PDFWorker.getFullText(
        normalizedContextItemId,
      );
      const pages = buildPageTextsFromPdfWorkerResult(result);
      if (!pages.length) return null;

      const cleanQuote = stripBoundaryEllipsis(
        sanitizeText(quoteText || "").trim(),
      );
      if (!cleanQuote) return null;

      const exact = locateQuoteInPageTexts(pages, cleanQuote, null);
      if (exact.status === "resolved" && exact.computedPageIndex !== null) {
        const pageIndex = Math.floor(exact.computedPageIndex);
        return { pageIndex, pageLabel: `${pageIndex + 1}` };
      }

      const raw = locateQuoteByRawPrefixInPages(pages, cleanQuote, null);
      if (raw?.status === "resolved" && raw.computedPageIndex !== null) {
        const pageIndex = Math.floor(raw.computedPageIndex);
        return { pageIndex, pageLabel: `${pageIndex + 1}` };
      }

      const segments = splitQuoteAtEllipsis(cleanQuote);
      if (segments.length >= 2) {
        for (const segment of segments) {
          const segmentExact = locateQuoteInPageTexts(pages, segment, null);
          if (
            segmentExact.status === "resolved" &&
            segmentExact.computedPageIndex !== null
          ) {
            const pageIndex = Math.floor(segmentExact.computedPageIndex);
            return { pageIndex, pageLabel: `${pageIndex + 1}` };
          }
          const segmentRaw = locateQuoteByRawPrefixInPages(
            pages,
            segment,
            null,
          );
          if (
            segmentRaw?.status === "resolved" &&
            segmentRaw.computedPageIndex !== null
          ) {
            const pageIndex = Math.floor(segmentRaw.computedPageIndex);
            return { pageIndex, pageLabel: `${pageIndex + 1}` };
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  })();

  citationPageLookupTasks.set(lookupKey, lookupTask);
  try {
    return await lookupTask;
  } finally {
    citationPageLookupTasks.delete(lookupKey);
  }
}

function sortCandidatesForActiveReader(
  candidates: AssistantCitationPaperCandidate[],
): AssistantCitationPaperCandidate[] {
  const activeReaderItemId = getReaderItemId(getActiveReaderForSelectedTab());
  if (!activeReaderItemId) return candidates.slice();
  return candidates
    .slice()
    .sort(
      (left, right) =>
        Number(right.contextItemId === activeReaderItemId) -
        Number(left.contextItemId === activeReaderItemId),
    );
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
        if (!syncButton.isConnected) continue;
        setCitationButtonLabel(syncButton, displayCitationLabel, pageLabel);
      }
    } catch (_err) {
      void _err;
    }
  }
}

async function resolvePageForCitationButton(params: {
  button: HTMLButtonElement;
  displayCitationLabel: string;
  candidates: AssistantCitationPaperCandidate[];
  panelItem: Zotero.Item;
  extractedCitation: ExtractedCitationLabel;
  quoteText: string;
}): Promise<void> {
  try {
    const normalizedQuoteText = sanitizeText(params.quoteText || "").trim();
    const orderedCandidates = await buildOrderedCitationCandidates(
      params.panelItem,
      params.extractedCitation,
      params.candidates,
    );
    if (!orderedCandidates.length) return;

    // No quote snippet -> nothing to resolve eagerly at page level.
    if (!normalizedQuoteText) return;

    // Cache check — skip rank-0 candidates to avoid stale entries from
    // whatever PDF happens to be open winning over the actual cited paper.
    for (const candidate of orderedCandidates) {
      if (rankCandidateForCitation(params.extractedCitation, candidate) === 0)
        continue;
      const cacheKey = buildCitationCacheKey(
        candidate.contextItemId,
        normalizedQuoteText,
      );
      const cached = citationPageCache.get(cacheKey);
      if (cached?.pageLabel) {
        updateCitationButtonPage(
          params.button,
          params.displayCitationLabel,
          cached.pageLabel,
        );
        return;
      }
    }

    // Live-reader text search — only run if the active reader IS a rank > 0
    // candidate for this citation.  If the wrong paper is open (rank 0) we
    // must not search it: a false-positive match would cache that paper and
    // hijack subsequent click navigation.
    const activeReader = getActiveReaderForSelectedTab();
    const activeReaderItemId = getReaderItemId(activeReader);
    if (activeReader && activeReaderItemId) {
      const matchingCandidate = orderedCandidates.find(
        (candidate) =>
          candidate.contextItemId === activeReaderItemId &&
          rankCandidateForCitation(params.extractedCitation, candidate) > 0,
      );
      if (matchingCandidate) {
        const result = await locateQuoteInLivePdfReader(
          activeReader,
          normalizedQuoteText,
          { skipFindController: true },
        );
        if (result.status === "resolved" && result.computedPageIndex !== null) {
          const pageIndex = Math.floor(result.computedPageIndex);
          const pageLabel =
            rememberCachedCitationPage(
              matchingCandidate.contextItemId,
              normalizedQuoteText,
              pageIndex,
              getPageLabelForIndex(activeReader, pageIndex),
            ) || `${pageIndex + 1}`;
          updateCitationButtonPage(
            params.button,
            params.displayCitationLabel,
            pageLabel,
          );
          return;
        }
      }
    }
    // Only run PDF-worker text search for rank > 0 candidates.  Running it on
    // rank-0 fallbacks (e.g. whatever PDF happens to be open in the reader)
    // can produce false-positive cache entries that redirect clicks to the
    // wrong paper.
    for (const candidate of orderedCandidates) {
      if (rankCandidateForCitation(params.extractedCitation, candidate) === 0)
        continue;
      const resolved = await locateCitationPageWithPdfWorker(
        candidate.contextItemId,
        normalizedQuoteText,
      );
      if (!resolved) continue;
      const pageLabel =
        rememberCachedCitationPage(
          candidate.contextItemId,
          normalizedQuoteText,
          resolved.pageIndex,
          resolved.pageLabel,
        ) || resolved.pageLabel;
      updateCitationButtonPage(
        params.button,
        params.displayCitationLabel,
        pageLabel,
      );
      return;
    }
  } catch {
    // Silently ignore eager resolution failures
  }
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
  addCitationCandidate(out, seen, resolvedContextRef, resolvedContextItem?.id);

  // 2. Try the base paper's first PDF attachment
  const basePaper = resolveConversationBaseItem(panelItem);
  const basePaperAttachment = getFirstPdfAttachment(basePaper);
  const basePaperRef =
    resolvePaperContextRefFromAttachment(basePaperAttachment);
  addCitationCandidate(out, seen, basePaperRef, basePaperAttachment?.id);

  // 3. Try the active reader directly (handles cases where panelItem
  //    doesn't resolve but a PDF reader IS open)
  if (!out.length) {
    const activeReader = getActiveReaderForSelectedTab();
    const readerItemId = getReaderItemId(activeReader);
    if (readerItemId > 0) {
      const readerItem = Zotero.Items.get(readerItemId) || null;
      if (readerItem) {
        const readerRef = resolvePaperContextRefFromAttachment(readerItem);
        addCitationCandidate(out, seen, readerRef, readerItemId);
      }
    }
  }

  return out;
}

function extractCitationYear(normalizedCitationLabel: string): string {
  const match = normalizedCitationLabel.match(/\b(19|20)\d{2}\b/);
  return match?.[0] || "";
}

function rankCitationSearchMatch(
  extracted: ExtractedCitationLabel,
  candidate: AssistantCitationPaperCandidate,
): number {
  const extractedKey = extracted.normalizedCitationKey || "";
  const candidateKey = normalizeCitationKey(
    candidate.paperContext.citationKey || "",
  );
  if (extractedKey && candidateKey && extractedKey === candidateKey) {
    return 5;
  }
  if (candidate.normalizedSourceLabel === extracted.normalizedSourceLabel) {
    return 4;
  }
  if (
    candidate.normalizedCitationLabel === extracted.normalizedCitationLabel ||
    candidate.normalizedCitationLabel ===
      extracted.normalizedDisplayCitationLabel
  ) {
    return 4;
  }
  const extractedAuthor = extractAuthorKey(extracted.normalizedCitationLabel);
  const candidateAuthor = extractAuthorKey(candidate.normalizedCitationLabel);
  const extractedYear = extractCitationYear(extracted.normalizedCitationLabel);
  const candidateYear = extractCitationYear(candidate.normalizedCitationLabel);
  const authorMatch = Boolean(
    extractedAuthor && candidateAuthor && extractedAuthor === candidateAuthor,
  );
  const yearMatch = Boolean(
    extractedYear && candidateYear && extractedYear === candidateYear,
  );
  if (authorMatch && yearMatch) return 3;
  if (authorMatch || yearMatch) return 2;
  return 0;
}

function rankCandidateForCitation(
  extractedCitation: ExtractedCitationLabel | null,
  candidate: AssistantCitationPaperCandidate,
): number {
  if (!extractedCitation) return 0;
  return rankCitationSearchMatch(extractedCitation, candidate);
}

function mergeCitationCandidates(
  ...candidateSets: AssistantCitationPaperCandidate[][]
): AssistantCitationPaperCandidate[] {
  const merged: AssistantCitationPaperCandidate[] = [];
  const seen = new Set<string>();
  for (const set of candidateSets) {
    for (const candidate of set) {
      const key = `${Math.floor(candidate.paperContext.itemId)}:${Math.floor(candidate.contextItemId)}`;
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
    .replace(/[()\[\],]/g, " ")
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
  for (const group of groups) {
    if (!group.attachments.length) continue;
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
      return left.candidate.paperContext.title.localeCompare(
        right.candidate.paperContext.title,
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
): Promise<AssistantCitationPaperCandidate[]> {
  const dynamicFallbackCandidates = resolveFallbackCandidates(panelItem);
  const searchedCandidates = await resolveCitationCandidatesFromLibrarySearch(
    panelItem,
    extractedCitation,
  );
  const effectiveCandidates = mergeCitationCandidates(
    staticCandidates,
    searchedCandidates,
    dynamicFallbackCandidates,
  );
  // Track which candidates came from conversation context so they receive a
  // ranking boost.  This handles cross-language author name mismatches (e.g.
  // Chinese 王一乐 → LLM writes "Wang") where the correct context paper would
  // otherwise be outranked by an unrelated library result with a matching
  // romanized name.
  const staticKeySet = new Set(
    staticCandidates.map(
      (c) =>
        `${Math.floor(c.paperContext.itemId)}:${Math.floor(c.contextItemId)}`,
    ),
  );
  const activeReaderItemId = getReaderItemId(getActiveReaderForSelectedTab());
  return effectiveCandidates.slice().sort((left, right) => {
    const leftKey = `${Math.floor(left.paperContext.itemId)}:${Math.floor(left.contextItemId)}`;
    const rightKey = `${Math.floor(right.paperContext.itemId)}:${Math.floor(right.contextItemId)}`;
    const leftIsContext = staticKeySet.has(leftKey);
    const rightIsContext = staticKeySet.has(rightKey);
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
    const activeDelta =
      Number(right.contextItemId === activeReaderItemId) -
      Number(left.contextItemId === activeReaderItemId);
    if (activeDelta !== 0) return activeDelta;
    return left.paperContext.title.localeCompare(
      right.paperContext.title,
      undefined,
      { sensitivity: "base" },
    );
  });
}

async function resolveAndNavigateAssistantCitation(params: {
  body: Element;
  button: HTMLButtonElement;
  baseSourceLabel: string;
  displayCitationLabel: string;
  candidates: AssistantCitationPaperCandidate[];
  panelItem: Zotero.Item;
  quoteText: string;
}): Promise<void> {
  const status = params.body.querySelector("#llm-status") as HTMLElement | null;
  if (params.button.dataset.loading === "true") return;
  params.button.dataset.loading = "true";
  params.button.disabled = true;

  try {
    const normalizedQuoteText = sanitizeText(params.quoteText || "").trim();
    const extractedCitation = extractStandalonePaperSourceLabel(
      params.baseSourceLabel,
    );
    // Build effective candidates from all available sources, then rank by
    // citation-label relevance first (so open-chat clicks don't get hijacked
    // by whichever unrelated PDF is currently active).
    const staticCandidates = params.candidates.length ? params.candidates : [];
    const orderedCandidates = await buildOrderedCitationCandidates(
      params.panelItem,
      extractedCitation,
      staticCandidates,
    );
    // General inline citations may not have a quote snippet to page-locate.
    // In that case, open the best matching paper directly.
    if (!normalizedQuoteText) {
      const firstCandidate = orderedCandidates[0];
      if (!firstCandidate) {
        if (status)
          setStatus(status, "No matching cited paper was found.", "error");
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

    // Cache check — skip rank-0 candidates to avoid stale entries from
    // whatever PDF happens to be open winning over the actual cited paper.
    for (const candidate of orderedCandidates) {
      if (rankCandidateForCitation(extractedCitation, candidate) === 0)
        continue;
      const cached = await navigateToCachedCitationPage(
        candidate.contextItemId,
        normalizedQuoteText,
        params.displayCitationLabel,
      );
      if (cached) {
        // Use FindController's actual page if it landed somewhere different
        // than the cached (possibly wrong) page.
        const reader = getActiveReaderForSelectedTab();
        const effectiveLabel = reader
          ? resolveJumpedPageLabel(
              reader,
              cached.paragraphJump,
              cached.pageLabel,
            )
          : cached.pageLabel;
        rememberCachedCitationPage(
          candidate.contextItemId,
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
            cached.paragraphJump.matched
              ? buildParagraphJumpSuccessStatus(effectiveLabel)
              : buildParagraphJumpFailureStatus(
                  effectiveLabel,
                  cached.paragraphJump,
                ),
            "ready",
          );
        }
        return;
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
        (c) => rankCandidateForCitation(extractedCitation, c) > 0,
      );
      if (bestRanked) {
        const target = await openReaderForItem(bestRanked.contextItemId);
        if (target) {
          const pageIndex = resolvePageIndexForLabel(target, explicitPageLabel);
          const paragraphJump = await attemptCitationParagraphJump({
            reader: target,
            contextItemId: bestRanked.contextItemId,
            displayCitationLabel: params.displayCitationLabel,
            quoteText: normalizedQuoteText,
            pageIndex,
            pageLabel: explicitPageLabel,
          });
          const jumpedLabel = resolveJumpedPageLabel(
            target,
            paragraphJump,
            explicitPageLabel,
          );
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
              paragraphJump.matched
                ? buildParagraphJumpSuccessStatus(jumpedLabel)
                : buildParagraphJumpFailureStatus(jumpedLabel, paragraphJump),
              "ready",
            );
          }
          return;
        }
      }
    }

    if (status) setStatus(status, "Locating cited quote...", "sending");
    let lastReason = "Could not resolve the cited quote to a unique page.";

    // Last-resort: if there are still no candidates, try the active reader
    // directly without needing a candidate entry.
    if (!orderedCandidates.length) {
      const activeReader = getActiveReaderForSelectedTab();
      if (activeReader) {
        const result = await locateQuoteInLivePdfReader(
          activeReader,
          normalizedQuoteText,
        );
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
          });
          const jumpedLabel = resolveJumpedPageLabel(
            activeReader,
            paragraphJump,
            pageLabel,
          );
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
              paragraphJump.matched
                ? buildParagraphJumpSuccessStatus(jumpedLabel)
                : buildParagraphJumpFailureStatus(jumpedLabel, paragraphJump),
              "ready",
            );
          }
          return;
        }
        if (result.reason) lastReason = result.reason;
        else if (result.status === "not-found")
          lastReason = "The cited quote was not found in the paper text.";
        else if (result.status === "ambiguous")
          lastReason = "The cited quote matched multiple pages.";
      } else {
        lastReason = "No PDF reader is currently open.";
      }
    }

    // Two-pass search: first try rank > 0 candidates (high confidence), then
    // fall back to rank-0 (unrelated PDFs) only if no match is found.  This
    // prevents the wrong paper from being opened and searched when a better
    // candidate exists.
    for (const pass of [1, 2] as const) {
      for (const candidate of orderedCandidates) {
        const rank = rankCandidateForCitation(extractedCitation, candidate);
        if (pass === 1 && rank === 0) continue;
        if (pass === 2 && rank !== 0) continue;
        const reader = await openReaderForItem(candidate.contextItemId);
        if (!reader) {
          lastReason = "Could not open the cited paper.";
          continue;
        }
        const result = await locateQuoteInLivePdfReader(
          reader,
          normalizedQuoteText,
        );
        if (result.status === "resolved" && result.computedPageIndex !== null) {
          const pageIndex = Math.floor(result.computedPageIndex);
          const pageLabel =
            rememberCachedCitationPage(
              candidate.contextItemId,
              normalizedQuoteText,
              pageIndex,
              getPageLabelForIndex(reader, pageIndex),
            ) || `${pageIndex + 1}`;
          const paragraphJump = await attemptCitationParagraphJump({
            reader,
            contextItemId: candidate.contextItemId,
            displayCitationLabel: params.displayCitationLabel,
            quoteText: normalizedQuoteText,
            pageIndex,
            pageLabel,
          });
          const jumpedLabel = resolveJumpedPageLabel(
            reader,
            paragraphJump,
            pageLabel,
          );
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
              paragraphJump.matched
                ? buildParagraphJumpSuccessStatus(jumpedLabel)
                : buildParagraphJumpFailureStatus(jumpedLabel, paragraphJump),
              "ready",
            );
          }
          return;
        }
        if (result.reason) {
          lastReason = result.reason;
        } else if (result.status === "ambiguous") {
          lastReason = "The cited quote matched multiple pages.";
        } else if (result.status === "not-found") {
          lastReason = "The cited quote was not found in the paper text.";
        }
      }
    }

    if (status) setStatus(status, lastReason, "error");
  } catch (error) {
    ztoolkit.log("LLM: Failed to navigate assistant citation", error);
    if (status) {
      setStatus(status, "Could not open the cited source", "error");
    }
  } finally {
    params.button.disabled = false;
    params.button.dataset.loading = "false";
    // After any citation click, refresh all other citation buttons in the
    // panel so their page labels reflect the latest cache (which may have
    // been corrected by FindController during this click).
    refreshAllCitationButtonPages(params.body, params.panelItem);
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
    const doc = body.ownerDocument;
    if (!doc) return;
    const buttons = doc.querySelectorAll(
      "button.llm-citation-icon",
    ) as NodeListOf<HTMLButtonElement>;
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
      // Try all candidates to find a cached page
      const activeReader = getActiveReaderForSelectedTab();
      const readerItemId = getReaderItemId(activeReader);
      if (!readerItemId) continue;
      const cacheKey = `${Math.floor(readerItemId)}\u241f${quoteKey}`;
      const cached = citationPageCache.get(cacheKey);
      if (!cached?.pageLabel) continue;
      // Read the current display label from the button text
      const textSpan = button
        .closest(".llm-citation-row, .llm-citation-inline-wrap")
        ?.querySelector(".llm-citation-text");
      if (!textSpan) continue;
      const currentText = sanitizeText(textSpan.textContent || "").trim();
      if (!currentText) continue;
      // Strip existing "page X" suffix to get the base citation label
      const baseLabel = currentText.replace(/,\s*page\s+\S+$/i, "").trim();
      if (baseLabel) {
        setCitationButtonLabel(button, baseLabel, cached.pageLabel);
      }
    }
  } catch {
    // Best-effort refresh — don't crash if DOM structure is unexpected
  }
}

function resolveMatchingCandidatesForExtractedCitation(
  extractedCitation: ExtractedCitationLabel,
  candidates: AssistantCitationPaperCandidate[],
): AssistantCitationPaperCandidate[] {
  const isGroupedCitation =
    extractedCitation.normalizedCitationLabel.includes(";");
  if (extractedCitation.normalizedCitationKey) {
    const citationKeyMatches = candidates.filter(
      (candidate) =>
        normalizeCitationKey(candidate.paperContext.citationKey || "") ===
        extractedCitation.normalizedCitationKey,
    );
    if (citationKeyMatches.length) {
      return citationKeyMatches;
    }
  }
  const out: AssistantCitationPaperCandidate[] = candidates.filter(
    (candidate) =>
      candidate.normalizedSourceLabel ===
        extractedCitation.normalizedSourceLabel ||
      candidate.normalizedCitationLabel ===
        extractedCitation.normalizedCitationLabel,
  );
  // Fuzzy author-key fallback:
  // If the citation has a year (e.g. "Marks & Goard, 2021"), we fuzzy match the author
  // but *require* the year to match exactly to prevent linking to the wrong paper.
  // If no year is present, we allow any paper matching the author.
  if (!out.length && candidates.length && !isGroupedCitation) {
    const extractedYear = extractCitationYear(
      extractedCitation.normalizedCitationLabel,
    );
    const citationAuthorKey = extractAuthorKey(
      extractedCitation.normalizedCitationLabel,
    );

    if (citationAuthorKey) {
      const fuzzy = candidates.filter((candidate) => {
        const candidateAuthorKey = extractAuthorKey(
          candidate.normalizedCitationLabel,
        );
        if (candidateAuthorKey !== citationAuthorKey) return false;

        if (extractedYear) {
          const candidateYear = extractCitationYear(
            candidate.normalizedCitationLabel,
          );
          return candidateYear === extractedYear;
        }

        return true;
      });

      if (fuzzy.length) {
        out.push(...fuzzy);
      }
    }
  }
  return out;
}

function createCitationButton(params: {
  ownerDoc: Document;
  body: Element;
  panelItem: Zotero.Item;
  candidates: AssistantCitationPaperCandidate[];
  extractedCitation: ExtractedCitationLabel;
  quoteText: string;
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
  if (params.rawCitationText) {
    textSpan.dataset.rawText = params.rawCitationText;
  }
  // When we have matched candidates for an inline citation, derive a clean
  // label from the paper's Zotero metadata (creator, year) instead of using
  // the raw LLM text which may include the title.
  let labelText: string;
  if (params.inline && params.candidates.length > 0) {
    const cleanLabel = formatPaperCitationLabel(
      params.candidates[0].paperContext,
    );
    const pageLabel = params.extractedCitation.pageLabel;
    labelText = pageLabel
      ? `(${cleanLabel}, page ${pageLabel})`
      : `(${cleanLabel})`;
  } else {
    labelText =
      params.rawCitationText ||
      formatCitationChipLabel(
        displayCitationLabel,
        params.extractedCitation.pageLabel,
      );
  }
  textSpan.textContent = labelText;
  container.appendChild(textSpan);

  // --- Icon button (the only clickable element) ---
  const citationButton = params.ownerDoc.createElement(
    "button",
  ) as HTMLButtonElement;
  citationButton.type = "button";
  citationButton.className = params.inline
    ? "llm-citation-icon llm-citation-icon-inline"
    : "llm-citation-icon";
  citationButton.dataset.loading = "false";
  citationButton.dataset.citationSyncKey = `${normalizeCitationLabel(baseSourceLabel)}\u241f${normalizeQuoteKey(params.quoteText)}`;
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
    const paperTitle = params.candidates[0]?.paperContext.title || "";
    citationButton.title = paperTitle
      ? `Jump to: ${paperTitle}`
      : "Jump to cited source";
  }
  citationButton.setAttribute(
    "aria-label",
    `Jump to cited source: ${displayCitationLabel}`,
  );

  const handleCitationClick = () => {
    void resolveAndNavigateAssistantCitation({
      body: params.body,
      button: citationButton,
      baseSourceLabel,
      displayCitationLabel,
      candidates: params.candidates,
      panelItem: params.panelItem,
      quoteText: params.quoteText,
    });
  };

  citationButton.addEventListener("mousedown", (event: Event) => {
    const mouse = event as MouseEvent;
    if (typeof mouse.button === "number" && mouse.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    handleCitationClick();
  });
  citationButton.addEventListener("click", (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  citationButton.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    handleCitationClick();
  });

  container.appendChild(citationButton);

  void resolvePageForCitationButton({
    button: citationButton,
    displayCitationLabel,
    candidates: params.candidates,
    panelItem: params.panelItem,
    extractedCitation: params.extractedCitation,
    quoteText: params.quoteText,
  });

  return container;
}

function shouldSkipInlineCitationNode(element: Element | null): boolean {
  if (!element) return true;
  if (
    element.closest(
      "blockquote, button, a, code, pre, .llm-paper-citation-row, .llm-paper-citation-link",
    )
  ) {
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

export function decorateAssistantCitationLinks(params: {
  body: Element;
  panelItem: Zotero.Item;
  bubble: HTMLDivElement;
  assistantMessage: Message;
  pairedUserMessage?: Message | null;
}): void {
  if (!params.assistantMessage.text.trim()) return;
  const ownerDoc = params.bubble.ownerDocument;
  if (!ownerDoc) return;

  // Pre-warm the page text cache in the background so that when the user
  // clicks a citation button the lookup is instant (pure in-memory search).
  const activeReader = getActiveReaderForSelectedTab();
  if (activeReader) {
    void warmPageTextCache(activeReader);
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
  for (const blockquote of blockquotes) {
    let quoteText = sanitizeText(blockquote.textContent || "").trim();
    if (!quoteText) continue;
    let citationEl = getNextElementSibling(blockquote);
    const tailMatch = extractBlockquoteTailCitation(
      blockquote.textContent || "",
    );

    // Primary attempt: entire element is a standalone citation label.
    let extractedCitation = citationEl
      ? extractStandalonePaperSourceLabel(citationEl.textContent || "")
      : null;

    // Edge-case fallback: the element may start with a citation label followed
    // by continuation paragraph text on subsequent lines (no blank line between
    // them in the LLM output → single <p> block in rendered HTML).
    // We extract only the first non-empty line and re-attempt parsing.
    let citationRemainder: string | null = null;
    if (!extractedCitation && citationEl) {
      const rawLines = (citationEl.textContent || "").split("\n");
      const firstLine = sanitizeText(rawLines[0] || "").trim();
      if (firstLine) {
        const leadingAttempt = extractStandalonePaperSourceLabel(firstLine);
        if (leadingAttempt) {
          extractedCitation = leadingAttempt;
          // Collect the remainder so it can be re-inserted as a sibling para.
          const tailLines = rawLines.slice(1).join("\n").trim();
          if (tailLines) citationRemainder = sanitizeText(tailLines).trim();
        }
      }
    }

    if (
      extractedCitation &&
      tailMatch &&
      tailMatch.extractedCitation.normalizedSourceLabel ===
        extractedCitation.normalizedSourceLabel
    ) {
      quoteText = tailMatch.quoteText;
      replaceBlockquoteText(blockquote, quoteText);
    }

    // Some model outputs put the citation on the final line *inside* the same
    // blockquote. Recover by splitting a trailing citation line from quote text.
    if (!extractedCitation && tailMatch) {
      extractedCitation = tailMatch.extractedCitation;
      quoteText = tailMatch.quoteText;
      replaceBlockquoteText(blockquote, quoteText);
      const syntheticCitationEl = ownerDoc.createElement("p");
      syntheticCitationEl.textContent = extractedCitation.sourceLabel;
      const insertParent = blockquote.parentElement;
      if (insertParent) {
        insertParent.insertBefore(
          syntheticCitationEl,
          citationEl || blockquote.nextSibling,
        );
        citationEl = syntheticCitationEl;
      }
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

    // Try to match the citation label against known paper candidates.
    const matchingCandidates = resolveMatchingCandidatesForExtractedCitation(
      extractedCitation,
      candidates,
    );
    // NOTE: matchingCandidates may still be empty here.  That is fine — the
    // click handler will resolve fallback candidates dynamically.
    const citationElement = createCitationButton({
      ownerDoc,
      body: params.body,
      panelItem: params.panelItem,
      candidates: matchingCandidates,
      extractedCitation,
      quoteText,
    });

    citationEl.classList.add("llm-citation-row-container");
    citationEl.textContent = "";
    citationEl.appendChild(citationElement);

    // If the citation was mixed with continuation text (edge-case leading-line
    // extraction), re-insert the remainder as a new paragraph after this element
    // so the overall reading flow is preserved.
    if (citationRemainder) {
      const remainderEl = ownerDoc.createElement("p");
      remainderEl.textContent = citationRemainder;
      citationEl.parentElement?.insertBefore(
        remainderEl,
        citationEl.nextSibling,
      );
    }
  }

  decorateInlineCitationNodes({
    body: params.body,
    bubble: params.bubble,
    ownerDoc,
    panelItem: params.panelItem,
    candidates,
  });
}
