import { MAX_SELECTED_IMAGES } from "../../constants";
import type { PdfSupport } from "../../../../providers";
import type { ProviderProtocol } from "../../../../utils/providerProtocol";
import type { ChatAttachment, PaperContextRef } from "../../types";

type StatusLevel = "ready" | "warning" | "error";

export type PdfPaperModelInputProfile = {
  model?: string;
  apiBase?: string;
  apiKey?: string;
  authMode?:
    | "api_key"
    | "codex_auth"
    | "codex_app_server"
    | "copilot_auth"
    | "webchat";
  providerProtocol?: ProviderProtocol;
} | null;

export type PdfPaperModelInputDeps = {
  setInputDisabled?: (disabled: boolean) => void;
  setStatusMessage?: (message: string, level: StatusLevel) => void;
  logError?: (message: string, ...args: unknown[]) => void;
  isScreenshotUnsupportedModel: (modelName: string) => boolean;
  getModelPdfSupport: (
    modelName: string,
    providerProtocol?: string,
    authMode?: string,
    apiBase?: string,
  ) => PdfSupport;
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
};

export type PdfPaperModelInputResult =
  | {
      ok: true;
      pdfSupport: PdfSupport;
      selectedFiles: ChatAttachment[];
      modelFiles: ChatAttachment[];
      displayPdfPaperAttachments: ChatAttachment[];
      modelPdfPaperAttachments: ChatAttachment[];
      modelSelectedPdfAttachments: ChatAttachment[];
      selectedPdfFiles: ChatAttachment[];
      selectedNonPdfFiles: ChatAttachment[];
      pdfPageImageDataUrls: string[];
      pdfUploadSystemMessages: string[];
    }
  | {
      ok: false;
      pdfSupport: PdfSupport;
    };

export function isPdfAttachment(attachment: ChatAttachment): boolean {
  const name = typeof attachment.name === "string" ? attachment.name : "";
  const mime =
    typeof attachment.mimeType === "string"
      ? attachment.mimeType.trim().toLowerCase()
      : "";
  return (
    attachment.category === "pdf" ||
    mime === "application/pdf" ||
    /\.pdf$/i.test(name)
  );
}

function pdfFileNameForPaper(paperContext: PaperContextRef): string {
  const raw = paperContext.attachmentTitle || paperContext.title || "document";
  return /\.pdf$/i.test(raw) ? raw : `${raw}.pdf`;
}

function fail(
  deps: PdfPaperModelInputDeps,
  pdfSupport: PdfSupport,
  message: string,
  level: StatusLevel = "error",
): PdfPaperModelInputResult {
  deps.setInputDisabled?.(false);
  deps.setStatusMessage?.(message, level);
  return { ok: false, pdfSupport };
}

export async function resolvePdfModeModelInputs(params: {
  deps: PdfPaperModelInputDeps;
  paperContexts: PaperContextRef[];
  selectedBaseFiles: ChatAttachment[];
  selectedImageCountForBudget: number;
  profile: PdfPaperModelInputProfile;
  currentModelName: string;
  isWebChat?: boolean;
  useCodexAttachmentPolicy?: boolean;
}): Promise<PdfPaperModelInputResult> {
  const {
    deps,
    paperContexts,
    selectedBaseFiles,
    selectedImageCountForBudget,
    profile,
    currentModelName,
    isWebChat = false,
    useCodexAttachmentPolicy = false,
  } = params;
  const modelName = (profile?.model || currentModelName || "").trim();
  const selectedPdfFiles = selectedBaseFiles.filter(isPdfAttachment);
  const selectedNonPdfFiles = selectedBaseFiles.filter(
    (attachment) => !isPdfAttachment(attachment),
  );
  const pdfSupport = deps.getModelPdfSupport(
    modelName,
    profile?.providerProtocol,
    profile?.authMode,
    profile?.apiBase,
  );
  let displayPdfPaperAttachments: ChatAttachment[] = [];
  let modelPdfPaperAttachments: ChatAttachment[] = [];
  let modelSelectedPdfAttachments = selectedPdfFiles;
  let pdfPageImageDataUrls: string[] = [];
  const pdfUploadSystemMessages: string[] = [];
  const hasProviderProcessedPdfs = paperContexts.length > 0 && !isWebChat;

  if (hasProviderProcessedPdfs) {
    if (pdfSupport === "none") {
      return fail(
        deps,
        pdfSupport,
        "This model does not support PDF or image input. Remove the PDF attachment or switch models.",
      );
    }

    displayPdfPaperAttachments =
      await deps.resolvePdfPaperAttachments(paperContexts);
    if (displayPdfPaperAttachments.length !== paperContexts.length) {
      return fail(
        deps,
        pdfSupport,
        "Could not resolve the selected paper PDF attachment.",
      );
    }

    if (pdfSupport === "upload") {
      if (!profile?.apiBase || !profile?.apiKey) {
        return fail(
          deps,
          pdfSupport,
          "PDF upload requires a configured provider API key.",
        );
      }
      const isQwen = profile.apiBase.toLowerCase().includes("dashscope");
      const isQwenLong = /^qwen-long(?:[.-]|$)/i.test(modelName);
      if (isQwen && !isQwenLong) {
        return fail(
          deps,
          pdfSupport,
          `Only qwen-long supports PDF upload on DashScope. Current model: ${modelName}.`,
        );
      }
      deps.setInputDisabled?.(true);
      deps.setStatusMessage?.(`Uploading PDF to ${modelName}...`, "ready");
      const uploadTargets = paperContexts.map((paperContext) => ({
        label: `${paperContext.contextItemId}`,
        fileName: pdfFileNameForPaper(paperContext),
        bytes: () => deps.resolvePdfBytes(paperContext),
      }));
      for (const target of uploadTargets) {
        try {
          const result = await deps.uploadPdfForProvider({
            apiBase: profile.apiBase,
            apiKey: profile.apiKey,
            pdfBytes: await target.bytes(),
            fileName: target.fileName,
          });
          if (!result) {
            return fail(deps, pdfSupport, "PDF upload failed.");
          }
          pdfUploadSystemMessages.push(result.systemMessageContent);
          deps.setStatusMessage?.(`${result.label}`, "ready");
        } catch (err) {
          deps.logError?.("LLM: PDF upload failed for", target.label, err);
          return fail(deps, pdfSupport, "PDF upload failed.");
        }
      }
      modelPdfPaperAttachments = [];
      deps.setInputDisabled?.(false);
    } else if (pdfSupport === "vision") {
      if (deps.isScreenshotUnsupportedModel(modelName)) {
        return fail(
          deps,
          pdfSupport,
          "This model does not support image input. Remove the PDF attachment or switch models.",
        );
      }
      const maxPdfImages =
        MAX_SELECTED_IMAGES - Math.max(0, selectedImageCountForBudget);
      if (maxPdfImages <= 0) {
        return fail(
          deps,
          pdfSupport,
          `PDF page rendering needs image input capacity. Remove some screenshots or keep at most ${MAX_SELECTED_IMAGES} image inputs.`,
        );
      }
      deps.setInputDisabled?.(true);
      deps.setStatusMessage?.(
        "This provider cannot read PDFs directly. Sending the Zotero PDF as page images.",
        "warning",
      );
      try {
        pdfPageImageDataUrls = (
          await deps.renderPdfPagesAsImages(paperContexts, maxPdfImages)
        ).slice(0, maxPdfImages);
      } catch (err) {
        deps.logError?.("LLM: PDF page rendering failed", err);
        return fail(
          deps,
          pdfSupport,
          err instanceof Error && err.message.trim()
            ? err.message
            : "PDF page rendering failed.",
        );
      }
      if (!pdfPageImageDataUrls.length) {
        return fail(deps, pdfSupport, "PDF page rendering failed.");
      }
      modelPdfPaperAttachments = [];
      deps.setStatusMessage?.(
        `Sending ${pdfPageImageDataUrls.length} PDF page image(s)...`,
        "ready",
      );
      deps.setInputDisabled?.(false);
    } else {
      deps.setStatusMessage?.(`Sending native PDF to ${modelName}...`, "ready");
      modelPdfPaperAttachments = displayPdfPaperAttachments;
      modelSelectedPdfAttachments = selectedPdfFiles;
    }
  }

  if (
    selectedPdfFiles.length > 0 &&
    pdfSupport === "vision" &&
    !isWebChat &&
    !useCodexAttachmentPolicy
  ) {
    deps.setStatusMessage?.(
      "This provider may not read uploaded PDFs directly.",
      "warning",
    );
  }

  const selectedFiles = [
    ...selectedNonPdfFiles,
    ...selectedPdfFiles,
    ...displayPdfPaperAttachments,
  ];
  const modelFiles = [
    ...selectedNonPdfFiles,
    ...modelSelectedPdfAttachments,
    ...modelPdfPaperAttachments,
  ];

  return {
    ok: true,
    pdfSupport,
    selectedFiles,
    modelFiles,
    displayPdfPaperAttachments,
    modelPdfPaperAttachments,
    modelSelectedPdfAttachments,
    selectedPdfFiles,
    selectedNonPdfFiles,
    pdfPageImageDataUrls,
    pdfUploadSystemMessages,
  };
}
