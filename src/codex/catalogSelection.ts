import type { ReasoningConfig } from "../shared/llm";

export type CodexReasoningEffort = {
  value: string;
  description?: string;
};

export type CodexReasoningChoice = {
  value: string;
  label: string;
  description?: string;
};

export type CodexCatalogModelCandidate = {
  model: string;
  displayName: string;
};

export type CodexRuntimeModelCandidate = CodexCatalogModelCandidate & {
  source: "catalog" | "saved";
};

export function formatCodexReasoningLabel(value: string): string {
  const normalized = value.trim();
  if (normalized.toLowerCase() === "xhigh") return "XHigh";
  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function buildCodexReasoningChoices(params: {
  efforts: readonly (string | CodexReasoningEffort)[];
  defaultEffort?: string;
  excludedEfforts?: readonly string[];
  showDefaultInAutoLabel?: boolean;
}): CodexReasoningChoice[] {
  const defaultEffort = params.defaultEffort?.trim() || "";
  const excluded = new Set(
    (params.excludedEfforts || []).map((effort) => effort.trim().toLowerCase()),
  );
  const choices: CodexReasoningChoice[] = [
    {
      value: "auto",
      label:
        params.showDefaultInAutoLabel && defaultEffort
          ? `Auto (${formatCodexReasoningLabel(defaultEffort)})`
          : "Auto",
    },
  ];
  const seen = new Set<string>(["auto"]);

  for (const rawEffort of params.efforts) {
    const value =
      typeof rawEffort === "string" ? rawEffort.trim() : rawEffort.value.trim();
    const key = value.toLowerCase();
    if (!value || excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    const description =
      typeof rawEffort === "string" ? "" : rawEffort.description?.trim() || "";
    choices.push({
      value,
      label: formatCodexReasoningLabel(value),
      ...(description ? { description } : {}),
    });
  }

  return choices;
}

export function reconcileCodexReasoningChoice(
  selection: string,
  choices: CodexReasoningChoice[],
): string {
  const normalized = selection.trim();
  if (!normalized || normalized.toLowerCase() === "auto") return "auto";
  return (
    choices.find(
      (choice) => choice.value.toLowerCase() === normalized.toLowerCase(),
    )?.value || "auto"
  );
}

export function buildCodexRuntimeModelCandidates(params: {
  catalogModels: CodexCatalogModelCandidate[];
  selectedModel: string;
}): CodexRuntimeModelCandidate[] {
  const selectedModel = params.selectedModel.trim();
  const candidates: CodexRuntimeModelCandidate[] = [];
  const seen = new Set<string>();

  if (
    selectedModel &&
    !params.catalogModels.some(
      (model) => model.model.toLowerCase() === selectedModel.toLowerCase(),
    )
  ) {
    candidates.push({
      model: selectedModel,
      displayName: selectedModel,
      source: "saved",
    });
    seen.add(selectedModel.toLowerCase());
  }

  for (const model of params.catalogModels) {
    const modelName = model.model.trim();
    const key = modelName.toLowerCase();
    if (!modelName || seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      model: modelName,
      displayName: model.displayName.trim() || modelName,
      source: "catalog",
    });
  }

  return candidates;
}

export function buildCodexReasoningConfig(
  selection: string,
): ReasoningConfig | undefined {
  const effort = selection.trim();
  if (!effort || effort.toLowerCase() === "auto") return undefined;
  return {
    provider: "openai",
    level: "default",
    effort,
  };
}
