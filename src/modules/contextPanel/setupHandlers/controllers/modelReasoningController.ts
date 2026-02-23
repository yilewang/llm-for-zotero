import type {
  ReasoningOption,
  ReasoningProviderKind,
} from "../../types";
import type { ReasoningLevel as LLMReasoningLevel } from "../../../../utils/llmClient";

export function isScreenshotUnsupportedModel(modelName: string): boolean {
  const normalized = modelName.trim().toLowerCase();
  return /^deepseek-(?:chat|reasoner)(?:$|[.-])/.test(normalized);
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
