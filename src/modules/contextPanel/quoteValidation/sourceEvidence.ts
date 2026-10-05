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
import type { QuoteCitation } from "../../../shared/types";
import { t } from "../../../utils/i18n";
import { sanitizeText } from "../../../utils/textSanitization";
import {
  getCachedPageTextForAttachment,
  hasCompleteSearchablePageTextForAttachment,
  warmPageTextCacheForAttachment,
} from "../livePdfSelectionLocator";
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
const MAX_WARMED_QUOTE_SOURCE_PAPERS = 40;

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

export async function warmQuoteSourceCachesForPaperContexts(
  groups: Array<PaperContextRef[] | undefined | null>,
  options?: {
    yieldToMain?: () => Promise<void>;
    shouldContinue?: () => boolean;
  },
): Promise<void> {
  // A library-chat answer can cite dozens of papers. Reading more of them than
  // the page-text cache can hold would evict the earlier ones before they are
  // used, so warming stops short of thrashing its own cache; quotes in the
  // remainder simply stay deferred and resolve when clicked.
  const uniquePapers = collectQuoteSourcePapers(...groups).slice(
    0,
    MAX_WARMED_QUOTE_SOURCE_PAPERS,
  );
  for (const paper of uniquePapers) {
    if (options?.shouldContinue?.() === false) return;
    if (options?.yieldToMain) await options.yieldToMain();
    const contextItemId = Math.floor(Number(paper.contextItemId || 0));
    const contextItem = resolveQuoteSourceContextItem(paper);
    const usesPdfPageText =
      Number.isFinite(contextItemId) &&
      contextItemId > 0 &&
      canUsePdfPageTextQuoteSource(paper, contextItem);
    if (usesPdfPageText) {
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
      if (options?.shouldContinue?.() === false) return;
    }
    if (!usesPdfPageText || paper.contentSourceMode === "mineru") {
      await ensureQuoteSourceTextCachedForPaper(paper);
    }
  }
}

export function assistantMarkdownNeedsQuoteSourceSearch(
  markdown: string,
): boolean {
  return (
    /^[ \t]*>/.test(markdown || "") ||
    /\n[ \t]*>/.test(markdown || "") ||
    /\[\[quote:[A-Za-z0-9_-]+\]\]/.test(markdown || "")
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
    /\[\[quote:([A-Za-z0-9_-]+)\]\]/g,
    (token, id: string) => {
      if (knownIds.has(id)) return "";
      hasUnresolvedAnchor = true;
      return token;
    },
  );
  if (hasUnresolvedAnchor) return true;
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
      (markdown || "").matchAll(/\[\[quote:([A-Za-z0-9_-]+)\]\]/g),
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
