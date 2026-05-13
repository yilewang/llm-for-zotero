import type { PdfSupport } from "../../../../providers";
import type { ProviderProtocol } from "../../../../utils/providerProtocol";
import type { ChatAttachment, PaperContextRef } from "../../types";
import { FULL_PDF_UNSUPPORTED_MESSAGE } from "../../pdfSupportMessages";

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
    profile,
    currentModelName,
    isWebChat = false,
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

  if (
    !isWebChat &&
    pdfSupport !== "native" &&
    (paperContexts.length > 0 || selectedPdfFiles.length > 0)
  ) {
    return fail(deps, pdfSupport, FULL_PDF_UNSUPPORTED_MESSAGE);
  }

  if (hasProviderProcessedPdfs) {
    displayPdfPaperAttachments =
      await deps.resolvePdfPaperAttachments(paperContexts);
    if (displayPdfPaperAttachments.length !== paperContexts.length) {
      return fail(
        deps,
        pdfSupport,
        "Could not resolve the selected paper PDF attachment.",
      );
    }

    deps.setStatusMessage?.(`Sending native PDF to ${modelName}...`, "ready");
    modelPdfPaperAttachments = displayPdfPaperAttachments;
    modelSelectedPdfAttachments = selectedPdfFiles;
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
