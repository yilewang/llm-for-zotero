import { appLogger } from "../../core/logging";
import type {
  PaperContextRef,
  ResolvedSelectedTextAnchor,
  SelectedTextContext,
} from "../../shared/types";
import { ensurePDFTextCached } from "../../services/paperContent/pdfContext";
import { warmPageTextCacheForAttachment } from "../../services/pdf/livePdfSelectionLocator";
import type { LivePdfPageText } from "../../services/pdf/livePdfSelectionLocator";
import { normalizeSelectedTextContexts } from "../../services/context/normalizers";
import {
  findUniqueQuoteTextSearchMatch,
  normalizeLocatorText,
} from "../../services/quotes/quoteTextSearch";
import { paperTextStore } from "../../services/paperContent/paperTextStore";
import { sanitizeText } from "../../utils/textSanitization";

export const SELECTED_TEXT_ANCHOR_MAX_CHARS = 6_500;
export const SELECTED_TEXT_ANCHORS_MAX_TOTAL_CHARS = 12_000;

type ProvisionalAnchor = Omit<
  ResolvedSelectedTextAnchor,
  "preferredChunkIndexes" | "contextText" | "injectedChars"
> & {
  chunks: string[];
  desiredChunkIndexes: number[];
  pageFallbackText?: string;
};

function normalizeContextItemId(context: SelectedTextContext): number | null {
  const raw = Number(
    context.contextItemId || context.paperContext?.contextItemId || 0,
  );
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}

function resolvePaperContext(
  context: SelectedTextContext,
  contextItemId: number,
  paperContexts: PaperContextRef[],
): PaperContextRef | undefined {
  return (
    context.paperContext ||
    paperContexts.find(
      (paper) => Math.floor(Number(paper.contextItemId)) === contextItemId,
    )
  );
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalizeLocatorText(value)
      .split(/\s+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
}

function overlapScore(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(1, leftTokens.size);
}

function quoteBelongsToPage(pageText: string, quoteText: string): boolean {
  const normalizedPage = normalizeLocatorText(pageText);
  const normalizedQuote = normalizeLocatorText(quoteText);
  if (!normalizedPage || !normalizedQuote) return false;
  if (normalizedPage.includes(normalizedQuote)) return true;
  return Boolean(
    findUniqueQuoteTextSearchMatch(
      [{ id: "page", text: pageText, debugLabel: "selected-text-page" }],
      quoteText,
      {
        minQueryLength: 12,
        maxSameEntryOccurrences: 3,
        rejectWeakQueries: true,
        includeProgressiveQueries: true,
        debugLabel: "Selected text page",
      },
    ),
  );
}

function selectPrimaryChunk(
  chunks: string[],
  quoteText: string,
  pageText?: string,
): number | null {
  const normalizedQuote = normalizeLocatorText(quoteText);
  if (!normalizedQuote) return null;
  const normalizedChunks = chunks.map((chunk) => normalizeLocatorText(chunk));
  const exactIndexes = normalizedChunks
    .map((chunk, index) => (chunk.includes(normalizedQuote) ? index : -1))
    .filter((index) => index >= 0);
  if (exactIndexes.length === 1) return exactIndexes[0];
  if (exactIndexes.length > 1) {
    const ranked = exactIndexes
      .map((index) => ({
        index,
        score: pageText ? overlapScore(chunks[index], pageText) : 0,
      }))
      .sort(
        (left, right) => right.score - left.score || left.index - right.index,
      );
    if (
      ranked[0].score > 0 &&
      (ranked.length === 1 || ranked[0].score > ranked[1].score + 0.02)
    ) {
      return ranked[0].index;
    }
    const contiguous = exactIndexes.every(
      (index, position) =>
        position === 0 || index === exactIndexes[position - 1] + 1,
    );
    if (contiguous && exactIndexes.length <= 2) return exactIndexes[0];
    return null;
  }

  for (let index = 0; index < normalizedChunks.length - 1; index += 1) {
    const pair = `${normalizedChunks[index]} ${normalizedChunks[index + 1]}`;
    if (pair.includes(normalizedQuote)) {
      const leftScore = overlapScore(quoteText, chunks[index]);
      const rightScore = overlapScore(quoteText, chunks[index + 1]);
      return rightScore > leftScore ? index + 1 : index;
    }
  }

  const progressive = findUniqueQuoteTextSearchMatch(
    chunks.map((text, index) => ({
      id: String(index),
      text,
      debugLabel: `selected-text-chunk-${index}`,
    })),
    quoteText,
    {
      minQueryLength: 20,
      maxSameEntryOccurrences: 3,
      rejectWeakQueries: true,
      includeProgressiveQueries: true,
      debugLabel: "Selected text",
    },
  );
  if (!progressive) return null;
  const parsed = Number(progressive.entryId);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function buildPageFallbackText(pageText: string, quoteText: string): string {
  const cleanPage = sanitizeText(pageText || "").trim();
  if (!cleanPage) return "";
  const cleanQuote = sanitizeText(quoteText || "").trim();
  const directIndex = cleanQuote ? cleanPage.indexOf(cleanQuote) : -1;
  if (directIndex >= 0) {
    const halfWindow = Math.floor(SELECTED_TEXT_ANCHOR_MAX_CHARS / 2);
    const start = Math.max(0, directIndex - halfWindow);
    return cleanPage
      .slice(start, start + SELECTED_TEXT_ANCHOR_MAX_CHARS)
      .trim();
  }
  return cleanPage.slice(0, SELECTED_TEXT_ANCHOR_MAX_CHARS).trim();
}

async function resolveProvisionalAnchor(params: {
  context: SelectedTextContext;
  contextIndex: number;
  paperContexts: PaperContextRef[];
}): Promise<ProvisionalAnchor | null> {
  const { context, contextIndex } = params;
  if (context.source !== "pdf") return null;
  const contextItemId = normalizeContextItemId(context);
  if (!contextItemId) return null;
  const paperContext = resolvePaperContext(
    context,
    contextItemId,
    params.paperContexts,
  );
  const item = Zotero.Items.get(contextItemId) || null;
  if (item) {
    try {
      await ensurePDFTextCached(item, {
        sourceMode: paperContext?.contentSourceMode,
      });
    } catch {
      // Locator-only fallback remains available.
    }
  }
  const pdfContext = paperTextStore.peek(contextItemId);
  const pageCache = await warmPageTextCacheForAttachment(contextItemId).catch(
    () => null,
  );
  return buildProvisionalAnchor({
    context,
    contextIndex,
    paperContexts: params.paperContexts,
    chunks: Array.isArray(pdfContext?.chunks) ? pdfContext.chunks : [],
    pages: pageCache?.pages || [],
    sourceType: pdfContext?.sourceType,
  });
}

function buildProvisionalAnchor(params: {
  context: SelectedTextContext;
  contextIndex: number;
  paperContexts: PaperContextRef[];
  chunks: string[];
  pages: LivePdfPageText[];
  sourceType?: string;
}): ProvisionalAnchor | null {
  const { context, contextIndex } = params;
  if (context.source !== "pdf") return null;
  const contextItemId = normalizeContextItemId(context);
  if (!contextItemId) return null;
  const paperContext = resolvePaperContext(
    context,
    contextItemId,
    params.paperContexts,
  );
  const pageIndex = Number.isFinite(context.pageIndex)
    ? Math.max(0, Math.floor(context.pageIndex as number))
    : undefined;
  const selectedPage =
    pageIndex === undefined
      ? undefined
      : params.pages.find((page) => page.pageIndex === pageIndex);
  const selectedPageVerified = selectedPage
    ? quoteBelongsToPage(selectedPage.text, context.text)
    : true;
  const chunks = params.chunks;
  const primaryChunkIndex =
    chunks.length && selectedPageVerified
      ? selectPrimaryChunk(chunks, context.text, selectedPage?.text)
      : null;
  const desiredChunkIndexes =
    primaryChunkIndex === null
      ? []
      : [
          primaryChunkIndex - 1,
          primaryChunkIndex,
          primaryChunkIndex + 1,
        ].filter((index) => index >= 0 && index < chunks.length);
  const pageFallbackText =
    selectedPage && selectedPageVerified
      ? buildPageFallbackText(selectedPage.text, context.text)
      : "";
  const resolution = desiredChunkIndexes.length
    ? "chunks"
    : pageFallbackText
      ? "page"
      : "locator-only";
  return {
    contextIndex,
    contextItemId,
    pageIndex,
    // Only a printed label; formatting numbers an unlabelled page itself.
    pageLabel:
      sanitizeText(context.pageLabel || selectedPage?.pageLabel || "").trim() ||
      undefined,
    paperContext,
    resolution,
    primaryChunkIndex: primaryChunkIndex ?? undefined,
    chunks,
    desiredChunkIndexes,
    pageFallbackText: pageFallbackText || undefined,
    sourceType: desiredChunkIndexes.length
      ? params.sourceType
      : pageFallbackText
        ? "pdf-page-text"
        : params.sourceType,
  };
}

function formatChunkWindowPart(
  chunkText: string,
  relation: "preceding" | "selected" | "following",
): string {
  return `[${relation} local context]\n${sanitizeText(chunkText).trim()}`;
}

function allocateAnchorText(
  provisional: ProvisionalAnchor[],
): ResolvedSelectedTextAnchor[] {
  const texts = new Map<number, string[]>();
  const indexes = new Map<number, number[]>();
  const anchorChars = new Map<number, number>();
  let totalChars = 0;

  const append = (
    anchor: ProvisionalAnchor,
    text: string,
    chunkIndex?: number,
    relation: "preceding" | "selected" | "following" = "selected",
  ) => {
    const perAnchorRemaining = Math.max(
      0,
      SELECTED_TEXT_ANCHOR_MAX_CHARS -
        (anchorChars.get(anchor.contextIndex) || 0),
    );
    const totalRemaining = Math.max(
      0,
      SELECTED_TEXT_ANCHORS_MAX_TOTAL_CHARS - totalChars,
    );
    const existingParts = texts.get(anchor.contextIndex) || [];
    const separatorChars = existingParts.length ? 2 : 0;
    const allowance =
      Math.min(perAnchorRemaining, totalRemaining) - separatorChars;
    if (allowance <= 0) return;
    const formatted =
      chunkIndex === undefined
        ? `[selected page context]\n${sanitizeText(text).trim()}`
        : formatChunkWindowPart(text, relation);
    const clipped = formatted.slice(0, allowance).trim();
    if (!clipped) return;
    const parts = existingParts;
    parts.push(clipped);
    texts.set(anchor.contextIndex, parts);
    anchorChars.set(
      anchor.contextIndex,
      (anchorChars.get(anchor.contextIndex) || 0) +
        separatorChars +
        clipped.length,
    );
    totalChars += separatorChars + clipped.length;
    if (chunkIndex !== undefined) {
      const selected = indexes.get(anchor.contextIndex) || [];
      if (!selected.includes(chunkIndex)) selected.push(chunkIndex);
      indexes.set(anchor.contextIndex, selected);
    }
  };

  // Fairness: give every anchor its primary evidence before any neighbors.
  for (const anchor of provisional) {
    if (
      anchor.primaryChunkIndex !== undefined &&
      anchor.chunks[anchor.primaryChunkIndex]
    ) {
      append(
        anchor,
        anchor.chunks[anchor.primaryChunkIndex],
        anchor.primaryChunkIndex,
        "selected",
      );
    } else if (anchor.pageFallbackText) {
      append(anchor, anchor.pageFallbackText);
    }
  }
  for (const relationOffset of [-1, 1] as const) {
    for (const anchor of provisional) {
      if (anchor.primaryChunkIndex === undefined) continue;
      const chunkIndex = anchor.primaryChunkIndex + relationOffset;
      if (!anchor.desiredChunkIndexes.includes(chunkIndex)) continue;
      const chunkText = anchor.chunks[chunkIndex];
      if (!chunkText) continue;
      append(
        anchor,
        chunkText,
        chunkIndex,
        relationOffset < 0 ? "preceding" : "following",
      );
    }
  }

  return provisional.map((anchor) => {
    const contextText = (texts.get(anchor.contextIndex) || []).join("\n\n");
    const preferredChunkIndexes = (indexes.get(anchor.contextIndex) || []).sort(
      (left, right) => left - right,
    );
    return {
      contextIndex: anchor.contextIndex,
      contextItemId: anchor.contextItemId,
      pageIndex: anchor.pageIndex,
      pageLabel: anchor.pageLabel,
      paperContext: anchor.paperContext,
      resolution:
        preferredChunkIndexes.length > 0
          ? "chunks"
          : contextText
            ? "page"
            : "locator-only",
      primaryChunkIndex: anchor.primaryChunkIndex,
      preferredChunkIndexes,
      contextText: contextText || undefined,
      sourceType: anchor.sourceType,
      injectedChars: contextText.length,
    };
  });
}

export async function resolveSelectedTextAnchors(params: {
  selectedTextContexts: SelectedTextContext[];
  paperContexts?: PaperContextRef[];
}): Promise<ResolvedSelectedTextAnchor[]> {
  const contexts = normalizeSelectedTextContexts(params.selectedTextContexts, {
    sanitizeText,
  });
  const provisional = (
    await Promise.all(
      contexts.map((context, contextIndex) =>
        resolveProvisionalAnchor({
          context,
          contextIndex,
          paperContexts: params.paperContexts || [],
        }),
      ),
    )
  ).filter((entry): entry is ProvisionalAnchor => Boolean(entry));
  const resolved = allocateAnchorText(provisional);
  for (const anchor of resolved) {
    appLogger.debug("LLM: selected-text anchor resolved", {
      contextIndex: anchor.contextIndex,
      contextItemId: anchor.contextItemId,
      pageIndex: anchor.pageIndex,
      resolution: anchor.resolution,
      preferredChunkIndexes: anchor.preferredChunkIndexes,
      sourceType: anchor.sourceType,
      injectedChars: anchor.injectedChars,
    });
  }
  return resolved;
}

export function resolveSelectedTextAnchorsFromTextSources(params: {
  selectedTextContexts: SelectedTextContext[];
  paperContexts?: PaperContextRef[];
  sources: Record<
    number,
    {
      chunks?: string[];
      pages?: LivePdfPageText[];
      sourceType?: string;
    }
  >;
}): ResolvedSelectedTextAnchor[] {
  const contexts = normalizeSelectedTextContexts(params.selectedTextContexts, {
    sanitizeText,
  });
  const provisional = contexts
    .map((context, contextIndex) => {
      const contextItemId = normalizeContextItemId(context);
      const source = contextItemId ? params.sources[contextItemId] : undefined;
      return buildProvisionalAnchor({
        context,
        contextIndex,
        paperContexts: params.paperContexts || [],
        chunks: source?.chunks || [],
        pages: source?.pages || [],
        sourceType: source?.sourceType,
      });
    })
    .filter((entry): entry is ProvisionalAnchor => Boolean(entry));
  return allocateAnchorText(provisional);
}
