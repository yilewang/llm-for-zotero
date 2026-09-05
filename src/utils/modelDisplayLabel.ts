export function formatDisplayModelName(
  modelName: string | undefined,
  modelProviderLabel: string | undefined,
  options?: { suppressProviderPrefix?: boolean },
): string {
  const normalizedModel = (modelName || "").trim();
  if (!normalizedModel) return "";
  const provider = (modelProviderLabel || "").trim().toLowerCase();
  if (
    options?.suppressProviderPrefix === true &&
    provider.includes("claude code")
  ) {
    return normalizedModel;
  }
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
