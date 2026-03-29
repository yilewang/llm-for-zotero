import type { ProviderCapabilities, ProviderParams } from "../types";
import { detectProviderPreset } from "../../utils/providerPresets";

/**
 * Tier 1 — Native API providers.
 *
 * OpenAI Responses API (gpt-4o, gpt-5, o-series, chatgpt), Anthropic
 * Messages API, and Gemini Native API.  These providers accept binary
 * PDF data directly in the message payload.
 */

export function matches(params: ProviderParams): boolean {
  const proto = (params.protocol || "").toLowerCase();
  const preset = detectProviderPreset(params.apiBase || "");
  return (
    proto === "anthropic_messages" ||
    proto === "gemini_native" ||
    preset === "openai" ||
    preset === "gemini" ||
    preset === "anthropic"
  );
}

function resolveFamily(params: ProviderParams) {
  const proto = (params.protocol || "").toLowerCase();
  const preset = detectProviderPreset(params.apiBase || "");
  if (proto === "gemini_native" || preset === "gemini") {
    return "native_gemini" as const;
  }
  if (proto === "anthropic_messages" || preset === "anthropic") {
    return "native_anthropic" as const;
  }
  return "native_openai" as const;
}

export function resolve(
  params: ProviderParams,
): Omit<ProviderCapabilities, "multimodal" | "fileInputs"> {
  const proto = (params.protocol || "").toLowerCase();
  const family = resolveFamily(params);
  if (family === "native_openai") {
    return {
      providerFamily: family,
      label: "Native OpenAI",
      pdf:
        proto === "responses_api"
          ? "file_upload"
          : proto === "openai_chat_compat"
            ? "inline_base64_pdf"
            : "error",
      images: true,
    };
  }
  if (family === "native_gemini") {
    return {
      providerFamily: family,
      label: "Native Gemini",
      pdf: proto === "gemini_native" ? "native_inline_pdf" : "error",
      images: true,
    };
  }
  return {
    providerFamily: family,
    label: "Native Anthropic",
    pdf: proto === "anthropic_messages" ? "native_inline_pdf" : "error",
    images: true,
  };
}
