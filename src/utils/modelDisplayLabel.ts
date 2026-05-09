const CLAUDE_RUNTIME_DISPLAY_MODELS = new Set(["haiku", "sonnet", "opus"]);

export function formatDisplayModelName(
  modelName: string | undefined,
  modelProviderLabel: string | undefined,
  options?: { suppressProviderPrefix?: boolean },
): string {
  const normalizedModel = (modelName || "").trim();
  if (!normalizedModel) return "";
  const normalizedModelLower = normalizedModel.toLowerCase();
  if (
    options?.suppressProviderPrefix === true &&
    CLAUDE_RUNTIME_DISPLAY_MODELS.has(normalizedModelLower)
  ) {
    return normalizedModelLower;
  }
  const provider = (modelProviderLabel || "").trim().toLowerCase();
  if (provider.includes("(codex auth")) {
    return `codex/${normalizedModel}`;
  }
  if (provider.includes("(app server")) {
    return `codex-app/${normalizedModel}`;
  }
  if (provider.includes("(copilot auth")) {
    return `copilot/${normalizedModel}`;
  }
  return normalizedModel;
}
