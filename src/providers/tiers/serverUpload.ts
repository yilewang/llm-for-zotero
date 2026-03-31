import type { ProviderCapabilities, ProviderParams } from "../types";

/**
 * Tier 2 — Providers with server-side PDF upload endpoints.
 *
 * Qwen DashScope and Kimi Moonshot expose their own /files endpoints
 * that accept a PDF upload and return a file reference for use in
 * subsequent chat requests.
 */

export function matches(params: ProviderParams): boolean {
  const base = (params.apiBase || "").toLowerCase();
  return (
    base.includes("dashscope.aliyuncs.com") ||
    base.includes("dashscope-intl.aliyuncs.com") ||
    base.includes("api.moonshot.cn") ||
    base.includes("api.moonshot.ai")
  );
}

export const capabilities: Omit<ProviderCapabilities, "multimodal"> = {
  tier: "server_upload",
  label: "Server-side upload",
  pdf: "upload",
  images: true,
};
