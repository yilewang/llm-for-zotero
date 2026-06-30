import type { ModelInputMode } from "../shared/types";

export type ModelInputModeOption = "auto" | ModelInputMode;

export const MODEL_INPUT_MODE_OPTIONS: readonly ModelInputModeOption[] = [
  "auto",
  "text_only",
  "vision_allowed",
] as const;

export function normalizeModelInputMode(
  value: unknown,
): ModelInputMode | undefined {
  if (value === "text_only" || value === "vision_allowed") return value;
  return undefined;
}

export function resolveModelInputMode(value: unknown): ModelInputModeOption {
  return normalizeModelInputMode(value) || "auto";
}

export function getModelInputModeLabel(
  mode: ModelInputModeOption,
): "Auto" | "Text only" | "Vision allowed" {
  if (mode === "text_only") return "Text only";
  if (mode === "vision_allowed") return "Vision allowed";
  return "Auto";
}
