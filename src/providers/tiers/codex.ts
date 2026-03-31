import type { ProviderCapabilities, ProviderParams } from "../types";

/**
 * Tier 5 — Codex / ChatGPT auth.
 *
 * Uses the Responses API format.  The ChatGPT backend validates MIME
 * types in input_image and rejects application/pdf, so PDFs must be
 * rendered as page images (vision mode) before sending.
 */

export function matches(params: ProviderParams): boolean {
  const auth = (params.authMode || "").toLowerCase();
  const proto = (params.protocol || "").toLowerCase();
  return auth === "codex_auth" || proto === "codex_responses";
}

export const capabilities: Omit<ProviderCapabilities, "multimodal"> = {
  tier: "codex",
  label: "Codex / ChatGPT",
  pdf: "vision",
  images: true,
};
