import type { ProviderCapabilities, ProviderParams } from "../types";

/**
 * Tier 4 — GitHub Copilot OAuth.
 *
 * Standard image_url content parts with image MIME types work (user
 * confirmed).  However the copilot proxy rejects application/pdf MIME
 * in image_url, so the image_url PDF trick does not work here.  PDF
 * support is disabled; users should use text mode / MinerU for PDFs.
 */

export function matches(params: ProviderParams): boolean {
  return (params.authMode || "").toLowerCase() === "copilot_auth";
}

export const capabilities: Omit<ProviderCapabilities, "multimodal"> = {
  tier: "copilot",
  label: "GitHub Copilot",
  pdf: "none",
  images: true,
};
