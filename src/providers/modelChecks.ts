/**
 * Cross-cutting model restriction check.
 *
 * Returns true for models that are text-only and cannot process images,
 * PDFs, or any non-text content regardless of which provider tier they
 * belong to.
 */
function getModelNameCandidates(model: string): string[] {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return [];
  const tail = normalized.split("/").pop() || "";
  return tail && tail !== normalized ? [normalized, tail] : [normalized];
}

function isDeepseekTextOnlyModel(candidate: string): boolean {
  return /^deepseek-(?:chat|reasoner|v4-(?:flash|pro))(?:$|[.-])/.test(
    candidate,
  );
}

export function isTextOnlyModel(model: string): boolean {
  const candidates = getModelNameCandidates(model);
  return candidates.some(
    (candidate) =>
      isDeepseekTextOnlyModel(candidate) ||
      /reasoner|text-only|embedding/.test(candidate),
  );
}
