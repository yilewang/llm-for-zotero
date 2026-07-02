import { isTextOnlyModel } from "./modelChecks";
import type { ProviderCapabilities, ProviderParams } from "./types";
import * as native from "./tiers/native";
import * as serverUpload from "./tiers/serverUpload";
import * as copilot from "./tiers/copilot";
import * as codex from "./tiers/codex";
import * as thirdParty from "./tiers/thirdParty";
import { resolvePromptCacheCapability } from "../contextCache/manager";
import { resolveModelInputMode } from "../utils/modelInputMode";

// Evaluate in priority order: auth-mode tiers (copilot, codex) must come
// before protocol-based tiers (native) so that e.g. copilot+responses_api
// is treated as copilot, not as native (which would try /v1/files upload
// against a proxy that doesn't expose it).
const TIERS = [copilot, codex, serverUpload, native, thirdParty] as const;

/**
 * Resolve the full provider capability set for the given request
 * parameters.  This is the single entry point that replaces the
 * scattered getModelPdfSupport / isScreenshotUnsupportedModel /
 * isMultimodalRequestSupported checks.
 */
export function resolveProviderCapabilities(
  params: ProviderParams,
): ProviderCapabilities {
  const matched = TIERS.find((tier) => tier.matches(params));
  const base = matched?.capabilities ?? thirdParty.capabilities;
  const inputMode = resolveModelInputMode(params.inputMode);
  const textOnly =
    inputMode === "text_only" ||
    (inputMode === "auto" && isTextOnlyModel(params.model));
  const images =
    inputMode === "vision_allowed" ? true : textOnly ? false : base.images;

  return {
    ...base,
    promptCache: resolvePromptCacheCapability(params),
    images,
    multimodal: images || (!textOnly && base.pdf !== "none"),
    ...(textOnly ? { pdf: "none" as const, images: false } : {}),
  };
}
