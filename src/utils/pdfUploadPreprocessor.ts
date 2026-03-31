/**
 * PDF file upload preprocessors for providers that support server-side
 * document processing (Qwen/DashScope, Kimi/Moonshot).
 *
 * These providers use OpenAI-compatible chat completions but require
 * a separate file upload step before the PDF can be referenced in messages.
 */

type UploadResult = {
  systemMessageContent: string;
  label: string;
};

function getFetch(): typeof fetch {
  return ztoolkit.getGlobal("fetch") as typeof fetch;
}

// ── Provider detection ──────────────────────────────────────────────────────

export type PdfUploadProvider = "qwen" | "kimi" | null;

export function detectPdfUploadProvider(apiBase: string): PdfUploadProvider {
  const normalized = (apiBase || "").toLowerCase();
  if (
    normalized.includes("dashscope.aliyuncs.com") ||
    normalized.includes("dashscope-intl.aliyuncs.com")
  ) {
    return "qwen";
  }
  if (
    normalized.includes("api.moonshot.cn") ||
    normalized.includes("api.moonshot.ai")
  ) {
    return "kimi";
  }
  return null;
}

// ── Multipart form builder (Zotero-compatible) ──────────────────────────────

/**
 * Build a multipart/form-data body manually since Zotero's FormData
 * may not work reliably with fetch for file uploads.
 */
function buildMultipartBody(
  fields: Array<{ name: string; value: string } | { name: string; filename: string; contentType: string; data: Uint8Array }>,
): { contentType: string; body: Uint8Array } {
  const boundary = `----FormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  for (const field of fields) {
    if ("data" in field) {
      // File field
      const safeName = (field.name || "").replace(/[\r\n"]/g, "_");
      const safeFilename = (field.filename || "").replace(/[\r\n"]/g, "_");
      const safeContentType = (field.contentType || "application/octet-stream").replace(/[\r\n"]/g, "_");
      const header = `--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"; filename="${safeFilename}"\r\nContent-Type: ${safeContentType}\r\n\r\n`;
      parts.push(encoder.encode(header));
      parts.push(field.data);
      parts.push(encoder.encode("\r\n"));
    } else {
      // Text field
      const part = `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`;
      parts.push(encoder.encode(part));
    }
  }
  parts.push(encoder.encode(`--${boundary}--\r\n`));

  // Concatenate all parts
  let totalLength = 0;
  for (const p of parts) totalLength += p.length;
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const p of parts) {
    body.set(p, offset);
    offset += p.length;
  }

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body,
  };
}

// ── Qwen (DashScope) ────────────────────────────────────────────────────────

/**
 * Normalize the Qwen/DashScope API base to the compatible-mode root
 * so that `/files` is appended to the correct path regardless of which
 * URL variant the user entered.
 *
 * Accepted inputs:
 *   https://dashscope.aliyuncs.com/compatible-mode/v1
 *   https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
 *   https://dashscope.aliyuncs.com/api/v2/apps/protocols/compatible-mode/v1
 *   https://dashscope-intl.aliyuncs.com/compatible-mode/v1
 *
 * All resolve to: https://dashscope{-intl}.aliyuncs.com/compatible-mode/v1
 */
function normalizeQwenFileUploadBase(apiBase: string): string {
  const raw = apiBase.replace(/\/+$/, "");
  const match = raw.match(
    /^(https?:\/\/dashscope(?:-intl)?\.aliyuncs\.com)/i,
  );
  if (match) return `${match[1]}/compatible-mode/v1`;
  return raw;
}

async function uploadPdfToQwen(
  apiBase: string,
  apiKey: string,
  pdfBytes: Uint8Array,
  fileName: string,
): Promise<UploadResult> {
  const fetchFn = getFetch();
  const base = normalizeQwenFileUploadBase(apiBase);

  ztoolkit.log("LLM: Qwen PDF upload starting", { base, fileName, size: pdfBytes.byteLength });

  const { contentType, body } = buildMultipartBody([
    { name: "file", filename: fileName, contentType: "application/pdf", data: pdfBytes },
    { name: "purpose", value: "file-extract" },
  ]);

  const uploadResponse = await fetchFn(`${base}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": contentType,
    },
    body,
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text().catch(() => "");
    throw new Error(`Qwen file upload failed: ${uploadResponse.status} ${errorText.slice(0, 300)}`);
  }

  const uploadData = (await uploadResponse.json()) as { id?: string; status?: string };
  ztoolkit.log("LLM: Qwen PDF upload response", uploadData);
  const fileId = uploadData?.id;
  if (!fileId) {
    throw new Error("Qwen file upload returned no file ID");
  }

  return {
    systemMessageContent: `fileid://${fileId}`,
    label: `Uploaded to DashScope (${fileId})`,
  };
}

// ── Kimi (Moonshot) ──────────────────────────────────────────────────────────

async function uploadPdfToKimi(
  apiBase: string,
  apiKey: string,
  pdfBytes: Uint8Array,
  fileName: string,
): Promise<UploadResult> {
  const fetchFn = getFetch();
  const base = apiBase.replace(/\/+$/, "");

  ztoolkit.log("LLM: Kimi PDF upload starting", { base, fileName, size: pdfBytes.byteLength });

  const { contentType, body } = buildMultipartBody([
    { name: "file", filename: fileName, contentType: "application/pdf", data: pdfBytes },
    { name: "purpose", value: "file-extract" },
  ]);

  const uploadResponse = await fetchFn(`${base}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": contentType,
    },
    body,
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text().catch(() => "");
    throw new Error(`Kimi file upload failed: ${uploadResponse.status} ${errorText.slice(0, 300)}`);
  }

  const uploadData = (await uploadResponse.json()) as { id?: string; status?: string };
  ztoolkit.log("LLM: Kimi PDF upload response", uploadData);
  const fileId = uploadData?.id;
  if (!fileId) {
    throw new Error("Kimi file upload returned no file ID");
  }

  // Extract file content
  ztoolkit.log("LLM: Kimi extracting file content", { fileId });
  const contentResponse = await fetchFn(`${base}/files/${fileId}/content`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!contentResponse.ok) {
    const errorText = await contentResponse.text().catch(() => "");
    throw new Error(`Kimi file content extraction failed: ${contentResponse.status} ${errorText.slice(0, 300)}`);
  }

  const extractedText = await contentResponse.text();
  ztoolkit.log("LLM: Kimi extracted text length", extractedText?.length || 0);
  if (!extractedText?.trim()) {
    throw new Error("Kimi returned empty extracted content");
  }

  return {
    systemMessageContent: extractedText,
    label: `Extracted via Kimi (${fileId})`,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function uploadPdfForProvider(params: {
  provider: PdfUploadProvider;
  apiBase: string;
  apiKey: string;
  pdfBytes: Uint8Array;
  fileName: string;
}): Promise<UploadResult | null> {
  const { provider, apiBase, apiKey, pdfBytes, fileName } = params;
  if (!provider) return null;

  switch (provider) {
    case "qwen":
      return uploadPdfToQwen(apiBase, apiKey, pdfBytes, fileName);
    case "kimi":
      return uploadPdfToKimi(apiBase, apiKey, pdfBytes, fileName);
    default:
      return null;
  }
}
