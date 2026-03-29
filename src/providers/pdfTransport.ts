import { resolveProviderCapabilities } from "./registry";
import type { PdfSupport, ProviderParams } from "./types";

export type ProviderRequestLike = Pick<
  ProviderParams,
  "model" | "protocol" | "authMode" | "apiBase"
>;

export type ChatInlineFilePart = {
  type: "file";
  file: {
    filename: string;
    file_data: string;
  };
};

export type ResponsesInlineFilePart =
  | {
      type: "input_file";
      file_id: string;
    }
  | {
      type: "input_file";
      filename: string;
      file_data: string;
    };

export function resolvePdfTransport(request: ProviderRequestLike): PdfSupport {
  return resolveProviderCapabilities({
    model: request.model || "",
    protocol: request.protocol,
    authMode: request.authMode,
    apiBase: request.apiBase,
  }).pdf;
}

export function supportsProviderFileInputs(
  request: ProviderRequestLike,
): boolean {
  return resolveProviderCapabilities({
    model: request.model || "",
    protocol: request.protocol,
    authMode: request.authMode,
    apiBase: request.apiBase,
  }).fileInputs;
}

export function shouldUploadPdfBeforeRequest(
  request: ProviderRequestLike,
): boolean {
  return resolvePdfTransport(request) === "file_upload";
}

export function shouldRenderPdfPages(
  request: ProviderRequestLike,
): boolean {
  return resolvePdfTransport(request) === "vision_pages";
}

export function shouldUseProviderPdfUpload(
  request: ProviderRequestLike,
): boolean {
  return resolvePdfTransport(request) === "provider_upload";
}

export function buildPdfPartForChat(params: {
  request: ProviderRequestLike;
  filename: string;
  dataUrl: string;
}): ChatInlineFilePart[] {
  const protocol = (params.request.protocol || "").trim().toLowerCase();
  const transport = resolvePdfTransport(params.request);
  if (transport !== "inline_base64_pdf") {
    throw new Error(
      `Chat file parts are not supported for PDF transport ${transport}`,
    );
  }
  if (protocol !== "openai_chat_compat") {
    throw new Error(
      `Chat file parts require openai_chat_compat (got ${protocol || "unknown"})`,
    );
  }
  return [
    {
      type: "file",
      file: {
        filename: params.filename,
        file_data: params.dataUrl,
      },
    },
  ];
}

export function buildPdfPartForResponses(params: {
  request: ProviderRequestLike;
  filename: string;
  dataUrl?: string;
  fileIds?: string[];
}): ResponsesInlineFilePart[] {
  const protocol = (params.request.protocol || "").trim().toLowerCase();
  const transport = resolvePdfTransport(params.request);
  if (protocol !== "responses_api" && protocol !== "codex_responses") {
    throw new Error(
      `Responses file parts require responses_api/codex_responses (got ${protocol || "unknown"})`,
    );
  }
  if (transport === "file_upload") {
    const fileIds = Array.isArray(params.fileIds)
      ? params.fileIds
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
    return fileIds.map((fileId) => ({
      type: "input_file",
      file_id: fileId,
    }));
  }
  if (transport === "inline_base64_pdf") {
    if (!params.dataUrl?.trim()) {
      throw new Error("Inline Responses PDF part requires file_data");
    }
    return [
      {
        type: "input_file",
        filename: params.filename,
        file_data: params.dataUrl.trim(),
      },
    ];
  }
  throw new Error(
    `Responses file parts are not supported for PDF transport ${transport}`,
  );
}
