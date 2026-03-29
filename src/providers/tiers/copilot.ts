import type { ProviderCapabilities, ProviderParams } from "../types";

/**
 * Tier 4 — GitHub Copilot OAuth.
 *
 * Standard image_url content parts with image MIME types work (user
 * confirmed).  However the copilot proxy rejects application/pdf MIME
 * in image_url, so the image_url PDF trick does not work here.  PDF
 * pages are rendered as images and sent via vision_pages mode, but
 * reliability is not guaranteed.
 */

export function matches(params: ProviderParams): boolean {
  return (params.authMode || "").toLowerCase() === "copilot_auth";
}

export function resolve(
  params: ProviderParams,
): Omit<ProviderCapabilities, "multimodal" | "fileInputs"> {
  const proto = (params.protocol || "").toLowerCase();
  return {
    providerFamily: "copilot",
    label: "GitHub Copilot",
    pdf:
      proto === "openai_chat_compat" || proto === "responses_api"
        ? "vision_pages"
        : "error",
    images: true,
  };
}
