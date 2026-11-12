/**
 * The evidence half of the quote gate: what source text a paper context can
 * prove a quote against, and how much of it is already cached.
 *
 * Nothing here decides anything. It answers "what can we check this against
 * right now", so the gate and the background validator both work from one
 * reading of the caches.
 */
import { appLogger } from "../../../core/logging";
import { paragraphCitationIds } from "../../../services/quotes/paragraphCitations";
import { quoteTokenPattern } from "../../../services/quotes/quoteTokenIds";
import type { AgentRuntimeRequestInput as AgentRuntimeRequest } from "../../../agent/types";
import {
  getActiveReaderForSelectedTab,
  getAllOpenReaders,
} from "../../../services/pdf/zoteroReaderTabs";
import { paperTextStore } from "../../../services/paperContent/paperTextStore";
import { formatPaperSourceLabel } from "../../../services/paperContent/paperAttribution";
import {
  ensureNoteTextCached,
  ensurePDFTextCached,
} from "../../../services/paperContent/pdfContext";
import {
  hasVerifiedQuoteLocation,
  type QuoteSourceText,
} from "../../../services/quotes/quoteCitations";
import { normalizePaperContextRefs } from "../../../services/context/normalizers";
import { isPdfContextAttachment } from "../../../services/paperContent/contextAttachmentSupport";
import type { QuoteCitation } from "../../../shared/types";
import { t } from "../../../utils/i18n";
import { sanitizeText } from "../../../utils/textSanitization";
import { fnv1a32Raw } from "../../../utils/fnv1a";
import {
  getCachedPageTextForAttachment,
  hasCompleteSearchablePageTextForAttachment,
  warmPageTextCacheForAttachment,
} from "../../../services/pdf/livePdfSelectionLocator";
import type { Message, PaperContextRef } from "../types";

function quoteSourcePaperKey(paper: PaperContextRef): string {
  return `${Math.floor(Number(paper.itemId || 0))}:${Math.floor(
    Number(paper.contextItemId || 0),
  )}:${paper.contentSourceMode || ""}`;
}

function cachedQuoteSourceText(contextItemId: number): string {
  const cached = paperTextStore.peek(contextItemId);
  return Array.isArray(cached?.chunks) ? cached.chunks.join("\n\n") : "";
}

function cachedQuoteSourceChunks(contextItemId: number): QuoteSourceText[] {
  const cached = paperTextStore.peek(contextItemId);
  if (!Array.isArray(cached?.chunks) || !cached.chunks.length) return [];
  const chunkMeta = Array.isArray(cached.chunkMeta) ? cached.chunkMeta : [];
  const out: QuoteSourceText[] = [];
  for (let index = 0; index < cached.chunks.length; index += 1) {
    const sourceText = sanitizeText(cached.chunks[index] || "").trim();
    if (!sourceText) continue;
    const meta = chunkMeta[index];
    out.push({
      sourceText,
      sectionLabel: meta?.sectionLabel,
      chunkKind: meta?.chunkKind,
      sourceFingerprint: meta?.sourceFingerprint,
      ...(meta?.pageStart !== undefined && meta?.pageStart === meta?.pageEnd
        ? { pageHintIndex: meta.pageStart }
        : {}),
    });
  }
  return out;
}

function hasCachedQuoteSourceText(contextItemId: number): boolean {
  return Boolean(cachedQuoteSourceText(contextItemId).trim());
}

function canUsePdfPageTextQuoteSource(
  paper: PaperContextRef,
  contextItem: Zotero.Item | null,
): boolean {
  if (!contextItem?.isAttachment?.()) return false;
  return !["markdown", "html", "txt", "docx"].includes(
    paper.contentSourceMode || "",
  );
}

function resolveQuoteSourceContextItem(
  paper: PaperContextRef,
): Zotero.Item | null {
  const contextItemId = Math.floor(Number(paper.contextItemId || 0));
  if (!Number.isFinite(contextItemId) || contextItemId <= 0) return null;
  try {
    const item = Zotero.Items.get(contextItemId);
    return item || null;
  } catch (error) {
    appLogger.warn("LLM: unable to resolve quote source context item", {
      contextItemId,
      error,
    });
    return null;
  }
}

async function ensureQuoteSourceTextCachedForPaper(
  paper: PaperContextRef,
): Promise<void> {
  const contextItemId = Math.floor(Number(paper.contextItemId || 0));
  if (!Number.isFinite(contextItemId) || contextItemId <= 0) return;

  const contextItem = resolveQuoteSourceContextItem(paper);
  if (!contextItem) return;

  // An empty cache entry means an earlier extraction attempt did not provide
  // searchable text. Retry here before the provenance finalizer gives up.
  paperTextStore.discardEmptyEntry(contextItemId);

  try {
    if ((contextItem as any).isNote?.()) {
      if (hasCachedQuoteSourceText(contextItemId)) return;
      await ensureNoteTextCached(contextItem);
    } else {
      await ensurePDFTextCached(contextItem, {
        sourceMode: paper.contentSourceMode,
      });
    }
  } catch (error) {
    appLogger.debug("LLM: quote source text cache warm failed", {
      contextItemId,
      sourceMode: paper.contentSourceMode,
      error,
    });
  }
}

function cachedPdfPageQuoteSourcesForPaper(
  paper: PaperContextRef,
): QuoteSourceText[] {
  const contextItemId = Math.floor(Number(paper.contextItemId || 0));
  if (!Number.isFinite(contextItemId) || contextItemId <= 0) return [];
  const contextItem = resolveQuoteSourceContextItem(paper);
  if (!canUsePdfPageTextQuoteSource(paper, contextItem)) return [];
  return cachedPdfPageQuoteSourcesForAttachment(contextItemId);
}

function cachedPdfPageQuoteSourcesForAttachment(
  contextItemId: number,
): QuoteSourceText[] {
  const cached = getCachedPageTextForAttachment(contextItemId);
  const normalizedByPageIndex = new Map(
    (cached?.normalised || []).map((page) => [page.pageIndex, page]),
  );
  return (cached?.pages || []).flatMap((page) => {
    const sourceText = sanitizeText(page.text || "").trim();
    const normalizedPage = normalizedByPageIndex.get(page.pageIndex);
    return sourceText
      ? [
          {
            sourceText,
            textIndex: normalizedPage?.textIndex,
            pageHintIndex: page.pageIndex,
            pageHintLabel: page.pageLabel,
            sourceFingerprint: cached?.sourceFingerprint,
            requiresPageHint: true,
          },
        ]
      : [];
  });
}

function collectQuoteSourcePapers(
  ...groups: Array<PaperContextRef[] | undefined | null>
): PaperContextRef[] {
  const papers = normalizePaperContextRefs(
    groups.flatMap((group) => group || []),
    { sanitizeText },
  );
  const seen = new Set<string>();
  const uniquePapers: PaperContextRef[] = [];
  for (const paper of papers) {
    const contextItemId = Number(paper.contextItemId || 0);
    if (!Number.isFinite(contextItemId) || contextItemId <= 0) continue;
    const key = quoteSourcePaperKey(paper);
    if (seen.has(key)) continue;
    seen.add(key);
    uniquePapers.push(paper);
  }
  return uniquePapers;
}

export type QuoteSourceEvidence = {
  sourceTexts: QuoteSourceText[];
  complete: boolean;
};

/**
 * Kept under the page-text cache's own entry limit so background warming
 * cannot evict the pages it just read.
 */
export const MAX_WARMED_QUOTE_SOURCE_PAPERS = 40;

function hasUnresolvedQuoteSourceScope(
  ...groups: Array<PaperContextRef[] | undefined | null>
): boolean {
  return groups.some((group) =>
    (group || []).some(
      (paper) =>
        !Number.isFinite(Number(paper?.itemId)) ||
        Number(paper?.itemId) <= 0 ||
        !Number.isFinite(Number(paper?.contextItemId)) ||
        Number(paper?.contextItemId) <= 0 ||
        !sanitizeText(paper?.title || "").trim(),
    ),
  );
}

export function buildCachedQuoteSourceEvidenceForPaperContexts(
  ...groups: Array<PaperContextRef[] | undefined | null>
): QuoteSourceEvidence {
  const uniquePapers = collectQuoteSourcePapers(...groups);
  const out: QuoteSourceText[] = [];
  let complete =
    uniquePapers.length > 0 && !hasUnresolvedQuoteSourceScope(...groups);
  for (const paper of uniquePapers) {
    const contextItemId = Math.floor(Number(paper.contextItemId || 0));
    if (!Number.isFinite(contextItemId) || contextItemId <= 0) {
      complete = false;
      continue;
    }
    const contextItem = resolveQuoteSourceContextItem(paper);
    if (!contextItem) complete = false;
    const usesPdfPageText = canUsePdfPageTextQuoteSource(paper, contextItem);
    const pdfPageSources = cachedPdfPageQuoteSourcesForPaper(paper);
    for (const pageSource of pdfPageSources) {
      out.push({
        ...pageSource,
        sourceLabel: formatPaperSourceLabel(paper),
        metadataTexts: [paper.title, paper.attachmentTitle],
        sourceMatchSource: "pdf-page-text",
        contextItemId: paper.contextItemId,
        itemId: paper.itemId,
      });
    }
    const cachedChunks = cachedQuoteSourceChunks(contextItemId);
    const paperComplete = usesPdfPageText
      ? hasCompleteSearchablePageTextForAttachment(contextItemId)
      : cachedChunks.length > 0;
    if (!paperComplete) complete = false;
    if (!cachedChunks.length) continue;
    for (const chunk of cachedChunks) {
      out.push({
        ...chunk,
        requiresPageHint: usesPdfPageText,
        sourceLabel: formatPaperSourceLabel(paper),
        metadataTexts: [paper.title, paper.attachmentTitle],
        sourceMatchSource: "context-text",
        contextItemId: paper.contextItemId,
        itemId: paper.itemId,
      });
    }
  }
  return { sourceTexts: out, complete };
}

/**
 * Add the cached PDF page text of each attachment that the message's own
 * citations name but its paper contexts do not cover. Old paper chats stored
 * no paper contexts, so without this their citations could be warmed yet
 * never checked. The pages carry their own attachment id and the citing
 * record's label; a paragraph citation is only ever located on the pages of
 * its own attachment. Context papers plus added attachments stay within the
 * warming cap. Completeness is unchanged: an added attachment never turns a
 * missing match into an absence verdict.
 */
export function addCitedAttachmentPageEvidence(
  evidence: QuoteSourceEvidence,
  quoteCitations: readonly QuoteCitation[] | undefined,
): QuoteSourceEvidence {
  const covered = new Set<number>();
  for (const source of evidence.sourceTexts) {
    const contextItemId = positiveContextItemId(source.contextItemId);
    if (contextItemId) covered.add(contextItemId);
  }
  const added: QuoteSourceText[] = [];
  const considered = new Set<number>();
  for (const citation of quoteCitations || []) {
    const contextItemId = positiveContextItemId(citation.contextItemId);
    if (
      !contextItemId ||
      covered.has(contextItemId) ||
      considered.has(contextItemId)
    ) {
      continue;
    }
    if (covered.size + considered.size >= MAX_WARMED_QUOTE_SOURCE_PAPERS) {
      break;
    }
    considered.add(contextItemId);
    if (!isPdfContextAttachment(resolveContextItemById(contextItemId))) {
      continue;
    }
    for (const pageSource of cachedPdfPageQuoteSourcesForAttachment(
      contextItemId,
    )) {
      added.push({
        ...pageSource,
        sourceLabel: citation.citationLabel,
        sourceMatchSource: "pdf-page-text",
        contextItemId,
        itemId: citation.itemId,
      });
    }
  }
  return added.length
    ? {
        sourceTexts: [...evidence.sourceTexts, ...added],
        complete: evidence.complete,
      }
    : evidence;
}

/** The most items whose Zotero abstract one review adds as evidence. */
const MAX_CITED_ABSTRACT_EVIDENCE = 50;

function zoteroAbstractFingerprint(itemId: number, abstract: string): string {
  return `zotero-abstract:${itemId}:${abstract.length}:${fnv1a32Raw(abstract).toString(36)}`;
}

/**
 * Add the Zotero abstract field of each item that an abstract-kind citation
 * names, as evidence for that item. The field is read natively from the
 * item here, never from the citation record, whose own text is never
 * evidence. A quote taken from the abstract field (an abstract read alone,
 * or a sections read that includes it) can then be checked even when the
 * item has no PDF or its PDF differs from the record. Completeness is
 * unchanged: the field never turns a missing match into an absence verdict
 * for the PDF text.
 */
export function addCitedAbstractEvidence(
  evidence: QuoteSourceEvidence,
  quoteCitations: readonly QuoteCitation[] | undefined,
): QuoteSourceEvidence {
  const added: QuoteSourceText[] = [];
  const considered = new Set<string>();
  for (const citation of quoteCitations || []) {
    if (citation.sourceChunkKind !== "abstract") continue;
    const itemId = positiveContextItemId(citation.itemId);
    if (!itemId) continue;
    const key = `${itemId}\u241f${citation.citationLabel}`;
    if (considered.has(key)) continue;
    if (considered.size >= MAX_CITED_ABSTRACT_EVIDENCE) break;
    considered.add(key);
    let abstract = "";
    try {
      const item = Zotero.Items.get(itemId) as any;
      if (item?.isRegularItem?.() === false) continue;
      const field = item?.getField?.("abstractNote");
      abstract = typeof field === "string" ? sanitizeText(field).trim() : "";
    } catch (error) {
      appLogger.debug("LLM: unable to read the Zotero abstract field", {
        itemId,
        error,
      });
    }
    if (!abstract) continue;
    const contextItemId = positiveContextItemId(citation.contextItemId);
    added.push({
      sourceText: abstract,
      sourceLabel: citation.citationLabel,
      sectionLabel: "Abstract",
      chunkKind: "abstract",
      sourceMatchSource: "context-text",
      sourceFingerprint: zoteroAbstractFingerprint(itemId, abstract),
      zoteroAbstractField: true,
      ...(contextItemId ? { contextItemId } : {}),
      itemId,
    });
  }
  return added.length
    ? {
        sourceTexts: [...evidence.sourceTexts, ...added],
        complete: evidence.complete,
      }
    : evidence;
}

export type QuoteSourceWarmResult = {
  /** Attachments this warm worked on, in the order it worked on them. */
  attemptedContextItemIds: number[];
  /** Attachments whose PDF page text this warm added to the cache. */
  addedPageTextContextItemIds: number[];
};

type QuoteSourceWarmTarget = {
  contextItemId: number;
  /** Absent for an attachment known only from a citation. */
  paper?: PaperContextRef;
};

function positiveContextItemId(value: unknown): number | null {
  const id = Math.floor(Number(value || 0));
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Order warm work: attachments the message's own citations name come first
 * (in citation order), then the remaining context papers in group order.
 */
function orderQuoteSourceWarmTargets(
  papers: PaperContextRef[],
  priorityContextItemIds: readonly number[] | undefined,
): QuoteSourceWarmTarget[] {
  const targets: QuoteSourceWarmTarget[] = [];
  const placed = new Set<PaperContextRef>();
  const seenPriorityIds = new Set<number>();
  for (const rawId of priorityContextItemIds || []) {
    const contextItemId = positiveContextItemId(rawId);
    if (!contextItemId || seenPriorityIds.has(contextItemId)) continue;
    seenPriorityIds.add(contextItemId);
    const matches = papers.filter(
      (paper) => positiveContextItemId(paper.contextItemId) === contextItemId,
    );
    if (!matches.length) {
      targets.push({ contextItemId });
      continue;
    }
    for (const paper of matches) {
      placed.add(paper);
      targets.push({ contextItemId, paper });
    }
  }
  for (const paper of papers) {
    if (placed.has(paper)) continue;
    const contextItemId = positiveContextItemId(paper.contextItemId);
    if (contextItemId) targets.push({ contextItemId, paper });
  }
  return targets;
}

function resolveContextItemById(contextItemId: number): Zotero.Item | null {
  try {
    return Zotero.Items.get(contextItemId) || null;
  } catch {
    return null;
  }
}

export async function warmQuoteSourceCachesForPaperContexts(
  groups: Array<PaperContextRef[] | undefined | null>,
  options?: {
    yieldToMain?: () => Promise<void>;
    shouldContinue?: () => boolean;
    /** Attachments named by the message's own citations; warmed first. */
    priorityContextItemIds?: readonly number[];
    /** Lower bound than the default cap, for early warms. */
    maxPapers?: number;
  },
): Promise<QuoteSourceWarmResult> {
  const result: QuoteSourceWarmResult = {
    attemptedContextItemIds: [],
    addedPageTextContextItemIds: [],
  };
  // A library-chat answer can cite dozens of papers. Reading more of them than
  // the page-text cache can hold would evict the earlier ones before they are
  // used, so warming stops short of thrashing its own cache; quotes in the
  // remainder simply stay deferred and resolve when clicked.
  const maxPapers = Math.min(
    MAX_WARMED_QUOTE_SOURCE_PAPERS,
    Math.max(0, Math.floor(Number(options?.maxPapers ?? Infinity))),
  );
  const targets = orderQuoteSourceWarmTargets(
    collectQuoteSourcePapers(...groups),
    options?.priorityContextItemIds,
  ).slice(0, maxPapers);
  for (const { contextItemId, paper } of targets) {
    if (options?.shouldContinue?.() === false) return result;
    if (options?.yieldToMain) await options.yieldToMain();
    result.attemptedContextItemIds.push(contextItemId);
    const contextItem = paper
      ? resolveQuoteSourceContextItem(paper)
      : resolveContextItemById(contextItemId);
    // An attachment known only from a citation has no recorded source mode;
    // only a PDF can supply page text for it.
    const usesPdfPageText = paper
      ? canUsePdfPageTextQuoteSource(paper, contextItem)
      : isPdfContextAttachment(contextItem);
    if (usesPdfPageText) {
      const hadPageText = Boolean(
        getCachedPageTextForAttachment(contextItemId),
      );
      try {
        const activeReader = getActiveReaderForSelectedTab();
        const activeReaderItemId = Math.floor(
          Number(activeReader?._item?.id || activeReader?.itemID || 0),
        );
        await warmPageTextCacheForAttachment(contextItemId, {
          yieldToMain: options?.yieldToMain,
          shouldContinue: options?.shouldContinue,
          // Opening chat from the library may leave its source PDF in an
          // inactive tab. Reuse that reader under the existing fallback and
          // work budget; tab selection does not change the source identity.
          reader:
            activeReaderItemId === contextItemId
              ? activeReader
              : getAllOpenReaders().find(
                  (reader) =>
                    Number(reader?._item?.id || reader?.itemID) ===
                    contextItemId,
                ),
        });
      } catch (error) {
        appLogger.debug("LLM: PDF page quote source text cache warm failed", {
          contextItemId,
          error,
        });
      }
      if (!hadPageText && getCachedPageTextForAttachment(contextItemId)) {
        result.addedPageTextContextItemIds.push(contextItemId);
      }
      if (options?.shouldContinue?.() === false) return result;
    }
    if (paper && (!usesPdfPageText || paper.contentSourceMode === "mineru")) {
      await ensureQuoteSourceTextCachedForPaper(paper);
    }
  }
  return result;
}

function hasParagraphCitations(markdown: string): boolean {
  return /\[\[cite:/.test(markdown) && paragraphCitationIds(markdown).size > 0;
}

export function assistantMarkdownNeedsQuoteSourceSearch(
  markdown: string,
): boolean {
  return (
    /^[ \t]*>/.test(markdown || "") ||
    /\n[ \t]*>/.test(markdown || "") ||
    quoteTokenPattern("quote", "").test(markdown || "") ||
    hasParagraphCitations(markdown || "")
  );
}

export function assistantMarkdownNeedsBackgroundQuoteSearch(
  markdown: string,
  quoteCitations: QuoteCitation[] | undefined,
): boolean {
  const knownIds = new Set(
    (quoteCitations || [])
      .filter(hasVerifiedQuoteLocation)
      .map((citation) => citation.id),
  );
  let hasUnresolvedAnchor = false;
  const withoutResolvedAnchors = (markdown || "").replace(
    quoteTokenPattern("quote"),
    (token, id: string) => {
      if (knownIds.has(id)) return "";
      hasUnresolvedAnchor = true;
      return token;
    },
  );
  if (hasUnresolvedAnchor) return true;
  // A paragraph citation with a record still needs its page located; an id
  // without a record has nothing to locate.
  if (hasParagraphCitations(markdown || "")) {
    const recordedIds = new Set(
      (quoteCitations || []).map((citation) => citation.id),
    );
    for (const id of paragraphCitationIds(markdown)) {
      if (recordedIds.has(id) && !knownIds.has(id)) return true;
    }
  }
  const withoutEmptyBlockquotes = withoutResolvedAnchors.replace(
    /^[ \t]*>[ \t]*$/gm,
    "",
  );
  return (
    /^[ \t]*>/.test(withoutEmptyBlockquotes) ||
    /\n[ \t]*>/.test(withoutEmptyBlockquotes)
  );
}

function countQuoteScopedPapers(
  pairedUserMessage?: Message | null,
  runtimeRequest?: AgentRuntimeRequest | null,
): number {
  const papers = [
    ...(pairedUserMessage?.paperContexts || []),
    ...(pairedUserMessage?.fullTextPaperContexts || []),
    ...(pairedUserMessage?.citationPaperContexts || []),
    ...(runtimeRequest?.selectedPaperContexts || []),
    ...(runtimeRequest?.fullTextPaperContexts || []),
    ...(runtimeRequest?.citationPaperContexts || []),
  ];
  const keys = new Set<string>();
  for (const paper of papers) {
    keys.add(quoteSourcePaperKey(paper));
  }
  return keys.size;
}

export function shouldRequireBodyEvidenceQuoteSearch(params: {
  assistantMarkdown: string;
  pairedUserMessage?: Message | null;
  runtimeRequest?: AgentRuntimeRequest | null;
}): boolean {
  if (!assistantMarkdownNeedsQuoteSourceSearch(params.assistantMarkdown)) {
    return false;
  }
  const hasScopedPool = Boolean(
    params.pairedUserMessage?.selectedCollectionContexts?.length ||
    params.pairedUserMessage?.selectedTagContexts?.length ||
    params.runtimeRequest?.selectedCollectionContexts?.length ||
    params.runtimeRequest?.selectedTagContexts?.length ||
    countQuoteScopedPapers(params.pairedUserMessage, params.runtimeRequest) > 1,
  );
  return hasScopedPool;
}

export type AssistantQuoteFinalizationOptions = {
  pairedUserMessage?: Message | null;
  runtimeRequest?: AgentRuntimeRequest | null;
  paperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  citationPaperContexts?: PaperContextRef[];
  conversationKey?: number;
};

export function hasOpenEndedQuoteSourceScope(
  options: AssistantQuoteFinalizationOptions,
): boolean {
  return Boolean(
    options.pairedUserMessage?.selectedCollectionContexts?.length ||
    options.pairedUserMessage?.selectedTagContexts?.length ||
    options.runtimeRequest?.selectedCollectionContexts?.length ||
    options.runtimeRequest?.selectedTagContexts?.length,
  );
}

export function quoteSourcePaperContextGroups(
  options: AssistantQuoteFinalizationOptions,
): Array<PaperContextRef[] | undefined | null> {
  return [
    options.paperContexts,
    options.fullTextPaperContexts,
    options.citationPaperContexts,
    options.runtimeRequest?.selectedPaperContexts,
    options.runtimeRequest?.fullTextPaperContexts,
    options.runtimeRequest?.citationPaperContexts,
    options.pairedUserMessage?.paperContexts,
    options.pairedUserMessage?.fullTextPaperContexts,
    options.pairedUserMessage?.citationPaperContexts,
    options.pairedUserMessage?.selectedTextPaperContexts?.filter(
      (entry): entry is PaperContextRef => Boolean(entry),
    ),
  ];
}

export function registeredQuoteCitationsForReview(
  markdown: string,
  quoteCitations: QuoteCitation[] | undefined,
): QuoteCitation[] {
  const anchoredIds = new Set(
    Array.from(
      (markdown || "").matchAll(quoteTokenPattern("quote")),
      (match) => match[1],
    ),
  );
  for (const id of paragraphCitationIds(markdown)) anchoredIds.add(id);
  return (quoteCitations || []).filter(
    (citation) =>
      anchoredIds.has(citation.id) ||
      citation.sourceMatchKind === "selected-text" ||
      citation.sourceMatchKind === "trusted",
  );
}
