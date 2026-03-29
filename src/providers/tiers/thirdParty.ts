import type { ProviderCapabilities, ProviderParams } from "../types";

/**
 * Tier 3 — Third-party OpenAI-compatible providers.
 *
 * OpenRouter, relay/proxy services, xAI, and any other provider using
 * OpenAI-style /responses or /chat/completions endpoints without the
 * native OpenAI/Gemini/Anthropic families above.
 */

export function matches(params: ProviderParams): boolean {
  const proto = (params.protocol || "").toLowerCase();
  const auth = (params.authMode || "").toLowerCase();
  return (
    (proto === "openai_chat_compat" || proto === "responses_api") &&
    auth !== "copilot_auth" &&
    auth !== "codex_auth"
  );
}

export function resolve(
  params: ProviderParams,
): Omit<ProviderCapabilities, "multimodal" | "fileInputs"> {
  const proto = (params.protocol || "").toLowerCase();
  return {
    providerFamily: "third_party",
    label: "Third-party",
    pdf:
      proto === "openai_chat_compat" || proto === "responses_api"
        ? "inline_base64_pdf"
        : "error",
    images: true,
  };
}
