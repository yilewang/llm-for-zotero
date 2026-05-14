import type { ProviderCapabilities, ProviderParams } from "../types";

/**
 * Tier 3 — Third-party compatible providers.
 *
 * OpenRouter, relay/proxy services (e.g. right.codes), and any other
 * provider using OpenAI/Anthropic/Gemini-compatible endpoints that are
 * NOT hosted by a native first-party provider. Full-PDF mode is disabled
 * because compatible chat endpoints do not imply a compatible PDF/file
 * input contract.
 */

export function matches(params: ProviderParams): boolean {
  const proto = (params.protocol || "").toLowerCase();
  const auth = (params.authMode || "").toLowerCase();
  if (auth === "copilot_auth" || auth === "codex_auth" || auth === "codex_app_server") return false;
  return (
    proto === "openai_chat_compat" ||
    proto === "responses_api" ||
    proto === "anthropic_messages" ||
    proto === "gemini_native" ||
    (!proto && !auth)
  );
}

export const capabilities: Omit<
  ProviderCapabilities,
  "multimodal" | "promptCache"
> = {
  tier: "third_party",
  label: "Third-party compatible",
  pdf: "none",
  images: true,
};
