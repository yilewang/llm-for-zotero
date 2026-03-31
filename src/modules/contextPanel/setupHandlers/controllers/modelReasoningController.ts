import type {
  ReasoningOption,
  ReasoningProviderKind,
} from "../../types";
import type { ReasoningLevel as LLMReasoningLevel } from "../../../../utils/llmClient";

import {
  isTextOnlyModel,
  resolveProviderCapabilities,
  type PdfSupport,
} from "../../../../providers";

export function isScreenshotUnsupportedModel(modelName: string): boolean {
  return isTextOnlyModel(modelName);
}

export type ModelPdfSupport = PdfSupport;

export function getModelPdfSupport(
  modelName: string,
  providerProtocol?: string,
  authMode?: string,
  apiBase?: string,
): ModelPdfSupport {
  return resolveProviderCapabilities({
    model: modelName,
    protocol: providerProtocol,
    authMode,
    apiBase,
  }).pdf;
}

export function getScreenshotDisabledHint(modelName: string): string {
  const label = modelName.trim() || "current model";
  return `Screenshots are disabled for ${label}`;
}

export function getReasoningLevelDisplayLabel(
  level: LLMReasoningLevel,
  provider: ReasoningProviderKind,
  modelName: string,
  options: ReasoningOption[],
): string {
  const option = options.find((entry) => entry.level === level);
  if (option?.label) {
    return option.label;
  }
  if (level !== "default") {
    return level;
  }
  if (provider === "deepseek") {
    return "enabled";
  }
  if (provider === "kimi") {
    return "model";
  }
  void modelName;
  return "default";
}

export function isReasoningDisplayLabelActive(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return normalized !== "off" && normalized !== "disabled";
}
