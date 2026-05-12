import {
  ensurePDFTextCached,
} from "../../modules/contextPanel/pdfContext";
import { pdfTextCache } from "../../modules/contextPanel/state";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
  resolvePaperContextRefFromAttachment,
} from "../../modules/contextPanel/paperAttribution";
import type { PaperContextRef } from "../../shared/types";
import type { PdfContext } from "../../modules/contextPanel/types";

function getFirstPdfChildAttachment(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  if (!item) return null;
  if (item.isAttachment?.() && item.attachmentContentType === "application/pdf") {
    return item;
  }
  if (!item.isRegularItem?.()) return null;
  for (const attachmentId of item.getAttachments()) {
    const attachment = Zotero.Items.get(attachmentId);
    if (
      attachment &&
      attachment.isAttachment?.() &&
      attachment.attachmentContentType === "application/pdf"
    ) {
      return attachment;
    }
  }
  return null;
}

export function resolveContextItemFromPaperContext(
  paperContext: PaperContextRef,
): Zotero.Item | null {
  const direct = Zotero.Items.get(paperContext.contextItemId);
  if (
    direct &&
    direct.isAttachment?.() &&
    direct.attachmentContentType === "application/pdf"
  ) {
    return direct;
  }
  const item = Zotero.Items.get(paperContext.itemId);
  return getFirstPdfChildAttachment(item);
}

function canInspectZoteroItems(): boolean {
  return typeof (globalThis as any).Zotero?.Items?.get === "function";
}

export class PdfService {
  async ensurePaperContext(
    paperContext: PaperContextRef,
  ): Promise<PdfContext | undefined> {
    const contextItem = resolveContextItemFromPaperContext(paperContext);
    if (!contextItem) return undefined;
    await ensurePDFTextCached(contextItem);
    return pdfTextCache.get(contextItem.id);
  }

  async getChunkExcerpt(params: {
    paperContext: PaperContextRef;
    chunkIndex: number;
  }): Promise<{
    text: string;
    chunkIndex: number;
    totalChunks: number;
    citationLabel: string;
    sourceLabel: string;
    paperContext: PaperContextRef;
  }> {
    const contextItem = canInspectZoteroItems()
      ? resolveContextItemFromPaperContext(params.paperContext)
      : null;
    if (canInspectZoteroItems() && !contextItem) {
      throw new Error("No PDF attachment is available for this Zotero item");
    }
    const pdfContext = await this.ensurePaperContext(params.paperContext);
    const chunkIndex = Number.isFinite(params.chunkIndex)
      ? Math.max(0, Math.floor(params.chunkIndex))
      : 0;
    if (!pdfContext || !pdfContext.chunks.length) {
      throw new Error("No extractable PDF text available for this paper");
    }
    if (chunkIndex >= pdfContext.chunks.length) {
      throw new Error("Chunk index is out of range");
    }
    return {
      text: pdfContext.chunks[chunkIndex],
      chunkIndex,
      totalChunks: pdfContext.chunks.length,
      citationLabel: formatPaperCitationLabel(params.paperContext),
      sourceLabel: formatPaperSourceLabel(params.paperContext),
      paperContext: params.paperContext,
    };
  }

  async getFrontMatterExcerpt(params: {
    paperContext: PaperContextRef;
    maxChunks?: number;
    maxChars?: number;
  }): Promise<{
    text: string;
    chunkIndexes: number[];
    totalChunks: number;
    citationLabel: string;
    sourceLabel: string;
    paperContext: PaperContextRef;
  }> {
    const contextItem = canInspectZoteroItems()
      ? resolveContextItemFromPaperContext(params.paperContext)
      : null;
    if (canInspectZoteroItems() && !contextItem) {
      throw new Error("No PDF attachment is available for this Zotero item");
    }
    const pdfContext = await this.ensurePaperContext(params.paperContext);
    if (!pdfContext || !pdfContext.chunks.length) {
      throw new Error("No extractable PDF text available for this paper");
    }
    const maxChunks = Number.isFinite(params.maxChunks)
      ? Math.max(1, Math.min(4, Math.floor(params.maxChunks as number)))
      : 2;
    const maxChars = Number.isFinite(params.maxChars)
      ? Math.max(200, Math.min(4000, Math.floor(params.maxChars as number)))
      : 2000;
    const selectedChunks = pdfContext.chunks.slice(0, maxChunks);
    const text = selectedChunks.join("\n\n").slice(0, maxChars).trim();
    return {
      text,
      chunkIndexes: selectedChunks.map((_, index) => index),
      totalChunks: pdfContext.chunks.length,
      citationLabel: formatPaperCitationLabel(params.paperContext),
      sourceLabel: formatPaperSourceLabel(params.paperContext),
      paperContext: params.paperContext,
    };
  }

  async getOverviewExcerpt(params: {
    paperContext: PaperContextRef;
    maxChars?: number;
  }): Promise<{
    text: string;
    chunkIndexes: number[];
    totalChunks: number;
    citationLabel: string;
    sourceLabel: string;
    paperContext: PaperContextRef;
    backend: "raw_pdf_text";
  }> {
    const contextItem = canInspectZoteroItems()
      ? resolveContextItemFromPaperContext(params.paperContext)
      : null;
    if (canInspectZoteroItems() && !contextItem) {
      throw new Error("No PDF attachment is available for this Zotero item");
    }
    const pdfContext = await this.ensurePaperContext(params.paperContext);
    if (!pdfContext || !pdfContext.chunks.length) {
      throw new Error("No extractable PDF text available for this paper");
    }
    const maxChars = Number.isFinite(params.maxChars)
      ? Math.max(800, Math.min(9000, Math.floor(params.maxChars as number)))
      : 6000;
    const selected = new Map<number, string>();
    pdfContext.chunks.slice(0, 3).forEach((chunk, index) => {
      selected.set(index, chunk);
    });
    const conclusionIndex = pdfContext.chunks.findIndex((chunk) =>
      /\b(discussion|conclusion|conclusions|summary|general discussion)\b/i.test(
        chunk.slice(0, 1200),
      ),
    );
    if (conclusionIndex >= 0) {
      selected.set(conclusionIndex, pdfContext.chunks[conclusionIndex]);
      const next = conclusionIndex + 1;
      if (next < pdfContext.chunks.length) {
        selected.set(next, pdfContext.chunks[next]);
      }
    } else if (pdfContext.chunks.length > 4) {
      selected.set(pdfContext.chunks.length - 1, pdfContext.chunks[pdfContext.chunks.length - 1]);
    }
    const ordered = Array.from(selected.entries()).sort((left, right) => left[0] - right[0]);
    const text = ordered
      .map(([index, chunk]) => `[chunk ${index}]\n${chunk.trim()}`)
      .join("\n\n")
      .slice(0, maxChars)
      .trim();
    return {
      text,
      chunkIndexes: ordered.map(([index]) => index),
      totalChunks: pdfContext.chunks.length,
      citationLabel: formatPaperCitationLabel(params.paperContext),
      sourceLabel: formatPaperSourceLabel(params.paperContext),
      paperContext: params.paperContext,
      backend: "raw_pdf_text",
    };
  }

  getPaperContextForItem(item: Zotero.Item | null | undefined): PaperContextRef | null {
    const attachment = getFirstPdfChildAttachment(item);
    return resolvePaperContextRefFromAttachment(attachment);
  }
}
