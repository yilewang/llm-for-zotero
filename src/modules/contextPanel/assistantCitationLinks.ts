import { sanitizeText, setStatus } from "./textUtils";
import { formatPaperCitationLabel, formatPaperSourceLabel, resolvePaperContextRefFromAttachment } from "./paperAttribution";
import {
  normalizePaperContextRefs,
  normalizeSelectedTextPaperContexts,
} from "./normalizers";
import { getActiveReaderForSelectedTab, resolveContextSourceItem } from "./contextResolution";
import {
  flashPageInLivePdfReader,
  type LivePdfPageText,
  locateQuoteByRawPrefixInPages,
  locateQuoteInPageTexts,
  locateQuoteInLivePdfReader,
  splitQuoteAtEllipsis,
  stripBoundaryEllipsis,
  warmPageTextCache,
} from "./livePdfSelectionLocator";
import { resolveConversationBaseItem } from "./portalScope";
import { searchPaperCandidates } from "./paperSearch";
import type { Message, PaperContextRef } from "./types";

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

const citationPageCache = new Map<
  string,
  {
    pageIndex: number;
    pageLabel?: string;
  }
>();

const citationPageLookupTasks = new Map<
  string,
  Promise<
    | {
        pageIndex: number;
        pageLabel: string;
      }
    | null
  >
>();

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
  return sanitizeText(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeCitationKey(value: string): string {
  return sanitizeText(value || "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function stripCitationKeyFromLabel(value: string): string {
  return sanitizeText(value || "")
    .replace(/\s*\[[^\]]+\]\s*$/g, "")
    .trim();
}

function formatCitationChipLabel(
  displayCitationLabel: string,
  pageLabel?: string,
): string {
  const cleanCitation = stripCitationKeyFromLabel(displayCitationLabel);
  const cleanPage = sanitizeText(pageLabel || "").trim();
  return cleanPage
    ? `(${cleanCitation}, page ${cleanPage})`
    : `(${cleanCitation})`;
}

function setCitationButtonLabel(
  button: HTMLButtonElement,
  displayCitationLabel: string,
  pageLabel?: string,
): void {
  const labelText = formatCitationChipLabel(displayCitationLabel, pageLabel);
  let labelNode = button.querySelector(
    ".llm-paper-citation-link-label",
  ) as HTMLSpanElement | null;
  if (!labelNode) {
    const doc = button.ownerDocument || Zotero.getMainWindow?.()?.document;
    if (!doc) return;
    labelNode = doc.createElement("span");
    labelNode.className =
      "llm-paper-citation-link-label llm-paper-context-chip-label";
    button.appendChild(labelNode);
  }
  labelNode.textContent = labelText;
  button.title = `Jump to cited source: ${labelText}`;
  button.setAttribute("aria-label", `Jump to cited source: ${labelText}`);
}

/**
 * Extract the author surname from a citation label for fuzzy matching.
 * E.g. "zheng et al., 2026" → "zheng", "(zheng et al., 2026)" → "zheng"
 */
function extractAuthorKey(normalizedLabel: string): string {
  const stripped = normalizedLabel.replace(/^\(|\)$/g, "").trim();
  const match = stripped.match(/^(\S+)\s+et\s+al/i);
  return match ? match[1].replace(/[,;.]+$/g, "") : "";
}

function normalizeQuoteKey(value: string): string {
  return sanitizeText(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildCitationCacheKey(contextItemId: number, quoteText: string): string {
  return `${Math.floor(contextItemId)}\u241f${normalizeQuoteKey(quoteText)}`;
}

function getReaderItemId(reader: any): number {
  const raw = Number(reader?._item?.id || reader?.itemID || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function getSelectedTextCount(message: Message | null | undefined): number {
  const selectedTexts = Array.isArray(message?.selectedTexts)
    ? message!.selectedTexts!.filter(
        (entry): entry is string => typeof entry === "string" && Boolean(entry.trim()),
      )
    : [];
  if (selectedTexts.length) return selectedTexts.length;
  return typeof message?.selectedText === "string" && message.selectedText.trim()
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
  const normalizedContextItemId = Number(contextItemId || paperContext?.contextItemId || 0);
  if (!paperContext || !Number.isFinite(normalizedContextItemId) || normalizedContextItemId <= 0) {
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
    addCitationCandidate(
      out,
      seen,
      paperContext,
      paperContext?.contextItemId,
    );
  }

  const paperContexts = normalizePaperContextRefs(
    pairedUserMessage?.paperContexts,
    { sanitizeText },
  );
  for (const paperContext of paperContexts) {
    addCitationCandidate(out, seen, paperContext, paperContext.contextItemId);
  }

  const resolvedContextItem = resolveContextSourceItem(panelItem).contextItem;
  const resolvedContextRef = resolvePaperContextRefFromAttachment(resolvedContextItem);
  addCitationCandidate(
    out,
    seen,
    resolvedContextRef,
    resolvedContextItem?.id,
  );

  const basePaper = resolveConversationBaseItem(panelItem);
  const basePaperAttachment = getFirstPdfAttachment(basePaper);
  const basePaperRef = resolvePaperContextRefFromAttachment(basePaperAttachment);
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
    normalizedSourceLabel: normalizeCitationLabel(formatPaperSourceLabel(paperContext)),
    normalizedCitationLabel: normalizeCitationLabel(formatPaperCitationLabel(paperContext)),
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
  const normalized = sanitizeText(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  const parseCitationParts = (
    rawCitation: string,
    rawKey?: string,
    rawPage?: string,
  ) => {
    const citationWithoutKey = stripCitationKeyFromLabel(rawCitation);
    const citationKeyFromLabelMatch = rawCitation.match(/\[([^\]]+)\]\s*$/);
    const parsedCitationKey = sanitizeText(
      rawKey || citationKeyFromLabelMatch?.[1] || "",
    ).trim();
    const parsedPageLabel = sanitizeText(rawPage || "").trim();
    const sourceLabel = parsedCitationKey
      ? `(${citationWithoutKey} [${parsedCitationKey}])`
      : `(${citationWithoutKey})`;
    const citationLabel = parsedCitationKey
      ? `${citationWithoutKey} [${parsedCitationKey}]`
      : citationWithoutKey;
    return {
      sourceLabel,
      citationLabel,
      displayCitationLabel: citationWithoutKey,
      citationKey: parsedCitationKey || undefined,
      pageLabel: parsedPageLabel || undefined,
      normalizedSourceLabel: normalizeCitationLabel(sourceLabel),
      normalizedCitationLabel: normalizeCitationLabel(citationLabel),
      normalizedDisplayCitationLabel: normalizeCitationLabel(citationWithoutKey),
      normalizedCitationKey: normalizeCitationKey(parsedCitationKey) || undefined,
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
      if (ch === "(") { parenDepth++; }
      else if (ch === ")") {
        parenDepth--;
        if (parenDepth < 0) { isValidSingleGroup = false; break; }
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
  const normalized = sanitizeText(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return (
    /\bet\s+al\b/.test(normalized) ||
    /\b(19|20)\d{2}\b/.test(normalized) ||
    /\bcid:[^\]]+/.test(normalized) ||
    /\[[^\]]+\]/.test(normalized) ||
    /\bpaper(?:\s+\d+)?\b/.test(normalized)
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

export function matchAssistantCitationCandidates(
  citationLineText: string,
  paperContexts: PaperContextRef[],
): AssistantCitationPaperCandidate[] {
  const extracted = extractStandalonePaperSourceLabel(citationLineText);
  if (!extracted) return [];
  const candidates = buildCandidateListFromPaperContexts(paperContexts);
  return candidates.filter((candidate) => {
    const candidateCitationKey = normalizeCitationKey(
      candidate.paperContext.citationKey || "",
    );
    if (extracted.normalizedCitationKey) {
      return Boolean(
        candidateCitationKey &&
        extracted.normalizedCitationKey === candidateCitationKey,
      );
    }
    return (
      candidate.normalizedSourceLabel === extracted.normalizedSourceLabel ||
      candidate.normalizedCitationLabel === extracted.normalizedCitationLabel ||
      candidate.normalizedCitationLabel === extracted.normalizedDisplayCitationLabel
    );
  });
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
  return rawPageLabel
    ? { pageIndex, pageLabel: rawPageLabel }
    : { pageIndex };
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
  const normalizedLocation = normalizeReaderPageLocation(location);
  const zoteroLocation = toZoteroReaderLocation(normalizedLocation);
  const activeReader = getActiveReaderForSelectedTab();
  if (getReaderItemId(activeReader) === normalizedTargetItemId) {
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
    const openedReader = await readerApi.open(normalizedTargetItemId, zoteroLocation);
    if (getReaderItemId(openedReader) === normalizedTargetItemId) {
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
      await pane.viewPDF(normalizedTargetItemId, zoteroLocation || {});
    }
  }

  const waitedReader = await waitForReaderForItem(normalizedTargetItemId);
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

async function navigateToCachedCitationPage(
  contextItemId: number,
  quoteText: string,
): Promise<boolean> {
  const cacheKey = buildCitationCacheKey(contextItemId, quoteText);
  const cached = citationPageCache.get(cacheKey);
  if (!cached) return false;
  let targetPageIndex = Math.floor(cached.pageIndex);
  let targetPageLabel =
    typeof cached.pageLabel === "string" && cached.pageLabel.trim()
      ? cached.pageLabel.trim()
      : `${targetPageIndex + 1}`;

  const reader = await openReaderForItem(contextItemId, {
    pageIndex: targetPageIndex,
    pageLabel: targetPageLabel,
  });
  if (!reader) return false;

  try {
    const verified = await locateQuoteInLivePdfReader(reader, quoteText);
    if (verified.status === "resolved" && verified.computedPageIndex !== null) {
      const verifiedPageIndex = Math.floor(verified.computedPageIndex);
      if (verifiedPageIndex >= 0 && verifiedPageIndex !== targetPageIndex) {
        targetPageIndex = verifiedPageIndex;
        targetPageLabel = `${verifiedPageIndex + 1}`;
        citationPageCache.set(cacheKey, {
          pageIndex: verifiedPageIndex,
          pageLabel: targetPageLabel,
        });
      }
    }
  } catch (_err) {
    void _err;
  }

  const navigated = await navigateReaderToPage(
    reader,
    targetPageIndex,
    targetPageLabel,
  );
  const readerForFlash =
    navigated
      ? reader
      : await openReaderForItem(contextItemId, {
          pageIndex: targetPageIndex,
          pageLabel: targetPageLabel,
        });
  await flashPageInLivePdfReader(readerForFlash || reader, targetPageIndex);
  return true;
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
): Promise<
  | {
      pageIndex: number;
      pageLabel: string;
    }
  | null
> {
  const normalizedContextItemId = Math.floor(contextItemId);
  if (!Number.isFinite(normalizedContextItemId) || normalizedContextItemId <= 0) {
    return null;
  }

  const lookupKey = buildCitationCacheKey(normalizedContextItemId, quoteText);
  const existingTask = citationPageLookupTasks.get(lookupKey);
  if (existingTask) {
    return existingTask;
  }

  const lookupTask = (async () => {
    try {
      const result = await Zotero.PDFWorker.getFullText(normalizedContextItemId);
      const pages = buildPageTextsFromPdfWorkerResult(result);
      if (!pages.length) return null;

      const cleanQuote = stripBoundaryEllipsis(sanitizeText(quoteText || "").trim());
      if (!cleanQuote) return null;

      const raw = locateQuoteByRawPrefixInPages(pages, cleanQuote, null);
      if (raw?.status === "resolved" && raw.computedPageIndex !== null) {
        const pageIndex = Math.floor(raw.computedPageIndex);
        return { pageIndex, pageLabel: `${pageIndex + 1}` };
      }

      const exact = locateQuoteInPageTexts(pages, cleanQuote, null);
      if (exact.status === "resolved" && exact.computedPageIndex !== null) {
        const pageIndex = Math.floor(exact.computedPageIndex);
        return { pageIndex, pageLabel: `${pageIndex + 1}` };
      }

      const segments = splitQuoteAtEllipsis(cleanQuote);
      if (segments.length >= 2) {
        for (const segment of segments) {
          const segmentRaw = locateQuoteByRawPrefixInPages(pages, segment, null);
          if (
            segmentRaw?.status === "resolved" &&
            segmentRaw.computedPageIndex !== null
          ) {
            const pageIndex = Math.floor(segmentRaw.computedPageIndex);
            return { pageIndex, pageLabel: `${pageIndex + 1}` };
          }
          const segmentExact = locateQuoteInPageTexts(pages, segment, null);
          if (
            segmentExact.status === "resolved" &&
            segmentExact.computedPageIndex !== null
          ) {
            const pageIndex = Math.floor(segmentExact.computedPageIndex);
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
    .sort((left, right) =>
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
        doc.querySelectorAll("button.llm-paper-citation-link"),
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
    const orderedCandidates = await buildOrderedCitationCandidates(
      params.panelItem,
      params.extractedCitation,
      params.candidates,
    );
    if (!orderedCandidates.length) return;

    // Fast path: if the citation carried an explicit page number and we can
    // match it to a high-confidence candidate, trust the number directly.
    // This MUST run before the cache check so stale rank-0 entries (e.g.
    // whatever PDF is currently open in the reader) cannot shadow the result.
    const eagerExplicitPage = sanitizeText(
      params.button.dataset.citationPageLabel || "",
    ).trim();
    if (eagerExplicitPage) {
      const bestRanked = orderedCandidates.find(
        (c) => rankCandidateForCitation(params.extractedCitation, c) > 0,
      );
      if (bestRanked) {
        const pageIndex = Math.max(0, parseInt(eagerExplicitPage, 10) - 1);
        citationPageCache.set(
          buildCitationCacheKey(bestRanked.contextItemId, params.quoteText),
          { pageIndex, pageLabel: eagerExplicitPage },
        );
        updateCitationButtonPage(
          params.button,
          params.displayCitationLabel,
          eagerExplicitPage,
        );
        return;
      }
    }

    // Cache check — skip rank-0 candidates to avoid stale entries from
    // whatever PDF happens to be open winning over the actual cited paper.
    for (const candidate of orderedCandidates) {
      if (rankCandidateForCitation(params.extractedCitation, candidate) === 0) continue;
      const cacheKey = buildCitationCacheKey(candidate.contextItemId, params.quoteText);
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
        const result = await locateQuoteInLivePdfReader(activeReader, params.quoteText);
        if (result.status === "resolved" && result.computedPageIndex !== null) {
          const pageIndex = Math.floor(result.computedPageIndex);
          const pageLabel = `${pageIndex + 1}`;
          citationPageCache.set(
            buildCitationCacheKey(matchingCandidate.contextItemId, params.quoteText),
            { pageIndex, pageLabel },
          );
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
      if (rankCandidateForCitation(params.extractedCitation, candidate) === 0) continue;
      const resolved = await locateCitationPageWithPdfWorker(
        candidate.contextItemId,
        params.quoteText,
      );
      if (!resolved) continue;
      citationPageCache.set(
        buildCitationCacheKey(candidate.contextItemId, params.quoteText),
        { pageIndex: resolved.pageIndex, pageLabel: resolved.pageLabel },
      );
      updateCitationButtonPage(
        params.button,
        params.displayCitationLabel,
        resolved.pageLabel,
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
  const resolvedContextRef = resolvePaperContextRefFromAttachment(resolvedContextItem);
  addCitationCandidate(out, seen, resolvedContextRef, resolvedContextItem?.id);

  // 2. Try the base paper's first PDF attachment
  const basePaper = resolveConversationBaseItem(panelItem);
  const basePaperAttachment = getFirstPdfAttachment(basePaper);
  const basePaperRef = resolvePaperContextRefFromAttachment(basePaperAttachment);
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
  const candidateKey = normalizeCitationKey(candidate.paperContext.citationKey || "");
  if (extractedKey && candidateKey && extractedKey === candidateKey) {
    return 5;
  }
  if (candidate.normalizedSourceLabel === extracted.normalizedSourceLabel) {
    return 4;
  }
  if (
    candidate.normalizedCitationLabel === extracted.normalizedCitationLabel ||
    candidate.normalizedCitationLabel === extracted.normalizedDisplayCitationLabel
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

  const groups = await searchPaperCandidates(normalizedLibraryID, queryTokens, null, 24);
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
  const activeReaderItemId = getReaderItemId(getActiveReaderForSelectedTab());
  return effectiveCandidates
    .slice()
    .sort((left, right) => {
      const rankDelta =
        rankCandidateForCitation(extractedCitation, right) -
        rankCandidateForCitation(extractedCitation, left);
      if (rankDelta !== 0) return rankDelta;
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
    const extractedCitation = extractStandalonePaperSourceLabel(
      params.baseSourceLabel,
    );
    // Build effective candidates from all available sources, then rank by
    // citation-label relevance first (so open-chat clicks don't get hijacked
    // by whichever unrelated PDF is currently active).
    const staticCandidates = params.candidates.length
      ? params.candidates
      : [];
    const orderedCandidates = await buildOrderedCitationCandidates(
      params.panelItem,
      extractedCitation,
      staticCandidates,
    );

    // Fast path: if the citation carried an explicit page number (e.g.
    // "(Carrasco et al., 2026, page 41)") AND we have a high-confidence label
    // match (rank > 0), navigate directly to that page without any PDF text
    // search.  This is the most reliable path and prevents false-positive
    // matches from an unrelated PDF that happens to be open (rank-0 fallback).
    const explicitPageLabel = sanitizeText(
      params.button.dataset.citationPageLabel || "",
    ).trim();
    if (explicitPageLabel) {
      const bestRanked = orderedCandidates.find(
        (c) => rankCandidateForCitation(extractedCitation, c) > 0,
      );
      if (bestRanked) {
        const pageIndex = Math.max(0, parseInt(explicitPageLabel, 10) - 1);
        const target = await openReaderForItem(bestRanked.contextItemId, {
          pageIndex,
          pageLabel: explicitPageLabel,
        });
        if (target) {
          await flashPageInLivePdfReader(target, pageIndex);
          updateCitationButtonPage(
            params.button,
            params.displayCitationLabel,
            explicitPageLabel,
          );
          if (status)
            setStatus(status, `Jumped to page ${explicitPageLabel}`, "ready");
          return;
        }
      }
    }

    for (const candidate of orderedCandidates) {
      const cached = await navigateToCachedCitationPage(
        candidate.contextItemId,
        params.quoteText,
      );
      if (cached) {
        const cacheKey = buildCitationCacheKey(candidate.contextItemId, params.quoteText);
        const cachedEntry = citationPageCache.get(cacheKey);
        if (cachedEntry?.pageLabel) {
          updateCitationButtonPage(
            params.button,
            params.displayCitationLabel,
            cachedEntry.pageLabel,
          );
        }
        if (status) setStatus(status, "Jumped to cited source", "ready");
        return;
      }
    }

    if (status) setStatus(status, "Locating cited quote...", "sending");
    let lastReason = "Could not resolve the cited quote to a unique page.";

    // Last-resort: if there are still no candidates, try the active reader
    // directly without needing a candidate entry.
    if (!orderedCandidates.length) {
      const activeReader = getActiveReaderForSelectedTab();
      if (activeReader) {
        const result = await locateQuoteInLivePdfReader(activeReader, params.quoteText);
        if (result.status === "resolved" && result.computedPageIndex !== null) {
          const pageIndex = Math.floor(result.computedPageIndex);
          const pageLabel = `${pageIndex + 1}`;
          await navigateReaderToPage(activeReader, pageIndex, pageLabel);
          await flashPageInLivePdfReader(activeReader, pageIndex);
          updateCitationButtonPage(
            params.button,
            params.displayCitationLabel,
            pageLabel,
          );
          if (status) setStatus(status, `Jumped to cited source (page ${pageLabel})`, "ready");
          return;
        }
        if (result.reason) lastReason = result.reason;
        else if (result.status === "not-found") lastReason = "The cited quote was not found in the paper text.";
        else if (result.status === "ambiguous") lastReason = "The cited quote matched multiple pages.";
      } else {
        lastReason = "No PDF reader is currently open.";
      }
    }

    for (const candidate of orderedCandidates) {
      const reader = await openReaderForItem(candidate.contextItemId);
      if (!reader) {
        lastReason = "Could not open the cited paper.";
        continue;
      }
      const result = await locateQuoteInLivePdfReader(reader, params.quoteText);
      if (result.status === "resolved" && result.computedPageIndex !== null) {
        const pageIndex = Math.floor(result.computedPageIndex);
        const pageLabel = `${pageIndex + 1}`;
        citationPageCache.set(
          buildCitationCacheKey(candidate.contextItemId, params.quoteText),
          { pageIndex, pageLabel },
        );
        const targetReader =
          (await openReaderForItem(candidate.contextItemId, {
            pageIndex,
            pageLabel,
          })) || reader;
        await navigateReaderToPage(targetReader, pageIndex, pageLabel);
        await flashPageInLivePdfReader(targetReader, pageIndex);
        updateCitationButtonPage(
          params.button,
          params.displayCitationLabel,
          pageLabel,
        );
        if (status) {
          setStatus(status, `Jumped to cited source (page ${pageLabel})`, "ready");
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

    if (status) setStatus(status, lastReason, "error");
  } catch (error) {
    ztoolkit.log("LLM: Failed to navigate assistant citation", error);
    if (status) {
      setStatus(status, "Could not open the cited source", "error");
    }
  } finally {
    params.button.disabled = false;
    params.button.dataset.loading = "false";
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
  ztoolkit.log("LLM citation decoration: blockquotes found =", blockquotes.length,
    "candidates =", candidates.length,
    "bubble HTML length =", String(params.bubble.innerHTML || "").length,
    "bubble child count =", params.bubble.childElementCount);
  for (const blockquote of blockquotes) {
    let quoteText = sanitizeText(blockquote.textContent || "").trim();
    if (!quoteText) continue;
    let citationEl = getNextElementSibling(blockquote);

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

    // Some model outputs put the citation on the final line *inside* the same
    // blockquote. Recover by splitting a trailing citation line from quote text.
    if (!extractedCitation) {
      const tailMatch = extractBlockquoteTailCitation(
        blockquote.textContent || "",
      );
      if (tailMatch) {
        extractedCitation = tailMatch.extractedCitation;
        quoteText = tailMatch.quoteText;
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
    }

    if (!extractedCitation) {
      if (!citationEl) {
        ztoolkit.log(
          "LLM citation decoration: no sibling citation and no inline tail citation for blockquote, text =",
          (blockquote.textContent || "").slice(0, 80),
        );
      } else {
        ztoolkit.log("LLM citation decoration: sibling text not a citation, text =",
          JSON.stringify((citationEl.textContent || "").slice(0, 80)));
      }
      continue;
    }

    if (!citationEl) {
      ztoolkit.log(
        "LLM citation decoration: citation parsed but no target element available",
      );
      continue;
    }
    ztoolkit.log("LLM citation decoration: creating button for", extractedCitation.sourceLabel);

    // Try to match the citation label against known paper candidates.
    const matchingCandidates: AssistantCitationPaperCandidate[] = candidates.filter(
      (candidate) =>
        candidate.normalizedSourceLabel === extractedCitation.normalizedSourceLabel ||
        candidate.normalizedCitationLabel === extractedCitation.normalizedCitationLabel,
    );
    if (!matchingCandidates.length && candidates.length) {
      // Fuzzy fallback: match by author surname only
      const citationAuthorKey = extractAuthorKey(extractedCitation.normalizedCitationLabel);
      if (citationAuthorKey) {
        const fuzzy = candidates.filter(
          (candidate) => extractAuthorKey(candidate.normalizedCitationLabel) === citationAuthorKey,
        );
        if (fuzzy.length) {
          matchingCandidates.push(...fuzzy);
        }
      }
    }
    if (!matchingCandidates.length && candidates.length === 1) {
      // Single-candidate fallback: if only one paper in context, use it
      matchingCandidates.push(candidates[0]);
    }
    // NOTE: matchingCandidates may still be empty here.  That is fine — the
    // click handler will resolve fallback candidates dynamically.

    const baseSourceLabel = extractedCitation.sourceLabel;
    const displayCitationLabel = extractedCitation.displayCitationLabel;
    const citationButton = ownerDoc.createElement("button") as HTMLButtonElement;
    citationButton.type = "button";
    citationButton.className =
      "llm-paper-citation-link llm-paper-context-chip-header";
    citationButton.title = "Jump to the cited source in the paper";
    citationButton.dataset.loading = "false";
    citationButton.dataset.citationSyncKey =
      `${normalizeCitationLabel(baseSourceLabel)}\u241f${normalizeQuoteKey(quoteText)}`;
    setCitationButtonLabel(citationButton, displayCitationLabel, extractedCitation.pageLabel);
    // Persist the explicit page label (if any) so the click handler can navigate
    // directly without a PDF text-match search — prevents wrong-paper navigation.
    if (extractedCitation.pageLabel) {
      citationButton.dataset.citationPageLabel = extractedCitation.pageLabel;
    }

    const handleCitationClick = () => {
      void resolveAndNavigateAssistantCitation({
        body: params.body,
        button: citationButton,
        baseSourceLabel,
        displayCitationLabel,
        candidates: matchingCandidates,
        panelItem: params.panelItem,
        quoteText,
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

    citationEl.classList.add(
      "llm-paper-citation-row",
      "llm-paper-context-chip",
      "llm-paper-context-chip-pinned",
    );
    citationEl.textContent = "";
    citationEl.appendChild(citationButton);

    // If the citation was mixed with continuation text (edge-case leading-line
    // extraction), re-insert the remainder as a new paragraph after this element
    // so the overall reading flow is preserved.
    if (citationRemainder) {
      const remainderEl = ownerDoc.createElement("p");
      remainderEl.textContent = citationRemainder;
      citationEl.parentElement?.insertBefore(remainderEl, citationEl.nextSibling);
    }

    void resolvePageForCitationButton({
      button: citationButton,
      displayCitationLabel,
      candidates: matchingCandidates,
      panelItem: params.panelItem,
      extractedCitation,
      quoteText,
    });
  }
}
