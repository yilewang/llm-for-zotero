import type { ProviderCapabilities, ProviderParams } from "../types";

/**
 * Tier 3 — Third-party OpenAI-compatible providers.
 *
 * OpenRouter, relay/proxy services (e.g. right.codes), and any other
 * provider using /v1/chat/completions or /v1/responses endpoints that
 * are NOT hosted by a native first-party provider.  PDFs are sent as
 * data:application/pdf;base64,... inside an image_url content part —
 * relay services pass this through transparently to the underlying
 * model.
 */

export function matches(params: ProviderParams): boolean {
  const proto = (params.protocol || "").toLowerCase();
  const auth = (params.authMode || "").toLowerCase();
  if (auth === "copilot_auth" || auth === "codex_auth") return false;
  return (
    proto === "openai_chat_compat" ||
    proto === "responses_api" ||
    (!proto && !auth)
  );
}

export const capabilities: Omit<ProviderCapabilities, "multimodal"> = {
  tier: "third_party",
  label: "Third-party (OpenAI-compatible)",
  pdf: "image_url",
  images: true,
};
