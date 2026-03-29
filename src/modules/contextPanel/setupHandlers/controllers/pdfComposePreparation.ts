import type { PdfSupport } from "../../../../providers";
import type { ChatAttachment, PaperContextRef } from "../../types";

type StatusLevel = "ready" | "warning" | "error";

export async function preparePdfComposeInputs(params: {
  paperContexts: PaperContextRef[];
  pdfSupport: PdfSupport;
  modelName: string;
  apiBase?: string;
  apiKey?: string;
  resolvePdfPaperAttachments: (
    paperContexts: PaperContextRef[],
  ) => Promise<ChatAttachment[]>;
  renderPdfPagesAsImages: (
    paperContexts: PaperContextRef[],
  ) => Promise<string[]>;
  uploadPdfForProvider: (params: {
    apiBase: string;
    apiKey: string;
    pdfBytes: Uint8Array;
    fileName: string;
  }) => Promise<{ systemMessageContent: string; label: string } | null>;
  resolvePdfBytes: (paperContext: PaperContextRef) => Promise<Uint8Array>;
  isScreenshotUnsupportedModel?: (modelName: string) => boolean;
  onStatus?: (message: string, level: StatusLevel) => void;
}): Promise<{
  attachments: ChatAttachment[];
  images: string[];
  pdfUploadSystemMessages: string[];
  warnings: string[];
}> {
  const result = {
    attachments: [] as ChatAttachment[],
    images: [] as string[],
    pdfUploadSystemMessages: [] as string[],
    warnings: [] as string[],
  };
  if (!params.paperContexts.length) {
    return result;
  }

  if (params.pdfSupport === "none") {
    const warning =
      "This model does not support PDF or image input. PDF papers were skipped.";
    params.onStatus?.(warning, "error");
    result.warnings.push(warning);
    return result;
  }

  if (params.pdfSupport === "error") {
    const warning =
      "The selected provider/protocol combination does not support PDF mode.";
    params.onStatus?.(warning, "error");
    result.warnings.push(warning);
    return result;
  }

  if (
    params.pdfSupport === "file_upload" ||
    params.pdfSupport === "inline_base64_pdf" ||
    params.pdfSupport === "native_inline_pdf"
  ) {
    params.onStatus?.(`Preparing PDF attachments for ${params.modelName}...`, "ready");
    result.attachments = await params.resolvePdfPaperAttachments(
      params.paperContexts,
    );
    return result;
  }

  if (params.pdfSupport === "provider_upload") {
    if (!params.apiBase || !params.apiKey) {
      const warning =
        "Provider-specific PDF upload requires both API base and API key.";
      params.onStatus?.(warning, "error");
      result.warnings.push(warning);
      return result;
    }
    params.onStatus?.(`Uploading PDF to ${params.modelName}...`, "ready");
    for (const paperContext of params.paperContexts) {
      try {
        const uploadResult = await params.uploadPdfForProvider({
          apiBase: params.apiBase,
          apiKey: params.apiKey,
          pdfBytes: await params.resolvePdfBytes(paperContext),
          fileName: (() => {
            const raw =
              paperContext.attachmentTitle || paperContext.title || "document";
            return /\.pdf$/i.test(raw) ? raw : `${raw}.pdf`;
          })(),
        });
        if (!uploadResult) continue;
        result.pdfUploadSystemMessages.push(uploadResult.systemMessageContent);
        params.onStatus?.(uploadResult.label, "ready");
      } catch (error) {
        ztoolkit.log(
          "LLM: PDF upload failed for",
          paperContext.contextItemId,
          error,
        );
        const warning =
          "PDF upload failed. Falling back to text mode for that paper.";
        params.onStatus?.(warning, "error");
        result.warnings.push(warning);
      }
    }
    return result;
  }

  if (params.pdfSupport === "vision_pages") {
    if (params.isScreenshotUnsupportedModel?.(params.modelName)) {
      const warning =
        "This model does not support image input. PDF pages will be sent as text.";
      params.onStatus?.(warning, "warning");
      result.warnings.push(warning);
      return result;
    }
    params.onStatus?.(
      `Rendering PDF pages as images for ${params.modelName}...`,
      "ready",
    );
    result.images = await params.renderPdfPagesAsImages(params.paperContexts);
    params.onStatus?.(
      `Sending ${result.images.length} page image(s)...`,
      "ready",
    );
  }

  return result;
}
