import {
  MAX_SELECTED_IMAGES,
  MAX_UPLOAD_PDF_SIZE_BYTES,
} from "../../constants";
import {
  persistAttachmentBlob,
  readAttachmentBytes,
} from "../../attachmentStorage";
import type { ChatAttachment, PaperContextRef } from "../../types";

type PdfPaperAttachmentResolverDeps = {
  logError?: (message: string, ...args: unknown[]) => void;
};

async function resolvePdfAttachmentFilePath(
  contextItemId: number,
): Promise<string | null> {
  const attachment = Zotero.Items.get(contextItemId);
  if (
    !attachment?.isAttachment?.() ||
    attachment.attachmentContentType !== "application/pdf"
  ) {
    return null;
  }
  const asyncPath = await (
    attachment as unknown as {
      getFilePathAsync?: () => Promise<string | false>;
    }
  ).getFilePathAsync?.();
  if (asyncPath) return asyncPath as string;
  if (
    typeof (attachment as { getFilePath?: () => string | undefined })
      .getFilePath === "function"
  ) {
    return (
      (attachment as { getFilePath: () => string | undefined }).getFilePath() ??
      null
    );
  }
  return (
    (attachment as unknown as { attachmentPath?: string }).attachmentPath ??
    null
  );
}

function bytesToPngDataUrl(bytes: Uint8Array): string | null {
  if (bytes.byteLength <= 0) return null;
  let binaryStr = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binaryStr += String.fromCharCode(
      ...bytes.subarray(i, Math.min(bytes.length, i + chunkSize)),
    );
  }
  return `data:image/png;base64,${btoa(binaryStr)}`;
}

export function createPdfPaperAttachmentResolver(
  deps: PdfPaperAttachmentResolverDeps = {},
): {
  resolvePdfPaperAttachments: (
    paperContexts: PaperContextRef[],
  ) => Promise<ChatAttachment[]>;
  renderPdfPagesAsImages: (
    paperContexts: PaperContextRef[],
    maxImages?: number,
  ) => Promise<string[]>;
  uploadPdfForProvider: (params: {
    apiBase: string;
    apiKey: string;
    pdfBytes: Uint8Array<ArrayBufferLike>;
    fileName: string;
  }) => Promise<{ systemMessageContent: string; label: string } | null>;
  resolvePdfBytes: (
    paperContext: PaperContextRef,
  ) => Promise<Uint8Array<ArrayBufferLike>>;
} {
  return {
    resolvePdfPaperAttachments: async (paperContexts) => {
      const results: ChatAttachment[] = [];
      for (const paperContext of paperContexts) {
        try {
          const filePath = await resolvePdfAttachmentFilePath(
            paperContext.contextItemId,
          );
          if (!filePath) continue;
          const bytes = await readAttachmentBytes(filePath);
          if (bytes.byteLength > MAX_UPLOAD_PDF_SIZE_BYTES) continue;
          const fileName = filePath.split(/[\\/]/).pop() || "document.pdf";
          const persisted = await persistAttachmentBlob(
            fileName,
            new Uint8Array(bytes),
          );
          results.push({
            id: `pdf-paper-${paperContext.contextItemId}-${Date.now()}`,
            name: fileName,
            mimeType: "application/pdf",
            sizeBytes: bytes.byteLength,
            category: "pdf",
            storedPath: persisted.storedPath,
            contentHash: persisted.contentHash,
          });
        } catch (err) {
          deps.logError?.("LLM: Failed to resolve PDF paper attachment", err);
        }
      }
      return results;
    },
    renderPdfPagesAsImages: async (paperContexts, maxImages) => {
      const { renderAllPdfPages } =
        await import("../../../../agent/services/pdfPageService");
      const dataUrls: string[] = [];
      const limit = Math.max(0, Math.floor(maxImages ?? MAX_SELECTED_IMAGES));
      for (const paperContext of paperContexts) {
        if (dataUrls.length >= limit) break;
        try {
          const pages = await renderAllPdfPages(paperContext.contextItemId, {
            maxPages: Math.max(0, limit - dataUrls.length),
          });
          for (const page of pages) {
            if (dataUrls.length >= limit) break;
            const bytes = await readAttachmentBytes(page.storedPath);
            const dataUrl = bytesToPngDataUrl(bytes);
            if (dataUrl) dataUrls.push(dataUrl);
          }
        } catch (err) {
          deps.logError?.(
            "LLM: Failed to render PDF pages for",
            paperContext.contextItemId,
            err,
          );
        }
      }
      return dataUrls;
    },
    uploadPdfForProvider: async (params) => {
      const { detectPdfUploadProvider, uploadPdfForProvider } =
        await import("../../../../utils/pdfUploadPreprocessor");
      const provider = detectPdfUploadProvider(params.apiBase);
      return uploadPdfForProvider({ provider, ...params });
    },
    resolvePdfBytes: async (paperContext) => {
      const filePath = await resolvePdfAttachmentFilePath(
        paperContext.contextItemId,
      );
      if (!filePath) throw new Error("Could not locate PDF file");
      return readAttachmentBytes(filePath);
    },
  };
}
