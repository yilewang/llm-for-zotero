import type { ProviderCapabilities, ProviderParams } from "../types";

/**
 * Tier 2 — Providers with server-side PDF upload endpoints.
 *
 * Qwen DashScope and Kimi Moonshot expose their own /files endpoints
 * that accept a PDF upload and return a file reference for use in
 * subsequent chat requests. Those are provider-specific document
 * extraction paths, not native full-PDF chat input, so normal PDF mode
 * stays disabled until an explicit adapter is introduced.
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

export const capabilities: Omit<
  ProviderCapabilities,
  "multimodal" | "promptCache"
> = {
  tier: "server_upload",
  label: "Server-side upload",
  pdf: "none",
  images: true,
};
