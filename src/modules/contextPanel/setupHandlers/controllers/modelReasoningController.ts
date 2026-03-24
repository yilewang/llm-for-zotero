import type {
  ReasoningOption,
  ReasoningProviderKind,
} from "../../types";
import type { ReasoningLevel as LLMReasoningLevel } from "../../../../utils/llmClient";

export function isScreenshotUnsupportedModel(modelName: string): boolean {
  const normalized = modelName.trim().toLowerCase();
  return /^deepseek-(?:chat|reasoner)(?:$|[.-])/.test(normalized);
}

export type ModelPdfSupport = "native" | "vision" | "none";

export function getModelPdfSupport(
  modelName: string,
  providerProtocol?: string,
): ModelPdfSupport {
  const m = modelName.trim().toLowerCase();
  // Text-only models: no PDF, no vision
  if (isScreenshotUnsupportedModel(m)) return "none";
  if (/reasoner|text-only|embedding/.test(m)) return "none";
  // Only first-party APIs support native PDF file upload
  const proto = (providerProtocol || "").trim().toLowerCase();
  if (proto === "anthropic_messages") return "native";
  if (proto === "gemini_native") return "native";
  if (proto === "responses_api" && /gpt-4o|gpt-5|o[1-9]|chatgpt/.test(m)) return "native";
  // OpenAI-compatible (openai_chat_compat), codex, and unknown: fall back to vision
  return "vision";
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
