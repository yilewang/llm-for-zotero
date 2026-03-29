import { isTextOnlyModel } from "./modelChecks";
import type { ProviderCapabilities, ProviderParams } from "./types";
import * as native from "./tiers/native";
import * as serverUpload from "./tiers/serverUpload";
import * as copilot from "./tiers/copilot";
import * as codex from "./tiers/codex";
import * as thirdParty from "./tiers/thirdParty";

// Evaluate in priority order: auth-mode tiers (copilot, codex) must come
// before protocol-based tiers (native) so that e.g. copilot+responses_api
// is treated as copilot, not as native (which would try /v1/files upload
// against a proxy that doesn't expose it).
const TIERS = [copilot, codex, serverUpload, native, thirdParty] as const;

function supportsResolvedFileInputs(pdf: ProviderCapabilities["pdf"]): boolean {
  return (
    pdf === "file_upload" ||
    pdf === "inline_base64_pdf" ||
    pdf === "native_inline_pdf" ||
    pdf === "provider_upload"
  );
}

const capabilityCache = new Map<string, { result: ProviderCapabilities; ts: number }>();
const CAPABILITY_CACHE_TTL_MS = 5_000;

/**
 * Resolve the full provider capability set for the given request
 * parameters.  This is the single entry point that replaces the
 * scattered getModelPdfSupport / isScreenshotUnsupportedModel /
 * isMultimodalRequestSupported checks.
 */
export function resolveProviderCapabilities(
  params: ProviderParams,
): ProviderCapabilities {
  const cacheKey = `${params.model}|${params.protocol}|${params.authMode ?? ""}|${params.apiBase ?? ""}`;
  const now = Date.now();
  const cached = capabilityCache.get(cacheKey);
  if (cached && now - cached.ts < CAPABILITY_CACHE_TTL_MS) {
    return cached.result;
  }

  const textOnly = isTextOnlyModel(params.model);

  const matched = TIERS.find((tier) => tier.matches(params));
  const base = matched
    ? matched.resolve(params)
    : thirdParty.resolve(params);

  const result: ProviderCapabilities = {
    ...base,
    multimodal: !textOnly,
    fileInputs: !textOnly && supportsResolvedFileInputs(base.pdf),
    ...(textOnly
      ? { pdf: "none" as const, images: false, fileInputs: false }
      : {}),
  };

  capabilityCache.set(cacheKey, { result, ts: now });
  return result;
}
