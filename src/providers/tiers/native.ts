import type { ProviderCapabilities, ProviderParams } from "../types";
import { detectProviderPreset } from "../../utils/providerPresets";

/**
 * Tier 1 — Native API providers.
 *
 * OpenAI, Anthropic, Gemini, and Grok official endpoints.  These
 * providers accept binary PDF data directly in the message payload
 * (or via /v1/files upload for Responses API).
 *
 * Detection uses the API base URL (via provider presets) rather than
 * model-name matching to prevent third-party relays that happen to
 * use `responses_api` protocol from being misclassified as native.
 */

export function matches(params: ProviderParams): boolean {
  const proto = (params.protocol || "").toLowerCase();
  if (proto === "anthropic_messages" || proto === "gemini_native") return true;
  // Only match for actual first-party provider endpoints
  const preset = detectProviderPreset(params.apiBase || "");
  return (
    preset === "openai" ||
    preset === "gemini" ||
    preset === "anthropic" ||
    preset === "grok"
  );
}

export const capabilities: Omit<ProviderCapabilities, "multimodal"> = {
  tier: "native",
  label: "Native API",
  pdf: "native",
  images: true,
};
