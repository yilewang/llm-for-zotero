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

function isDeepseekModel(candidate: string): boolean {
  return /^deepseek(?:$|[-.])/.test(candidate);
}

function isExplicitTextOnlyModel(candidate: string): boolean {
  return /text-only|embedding/.test(candidate);
}

function isExplicitVisionModel(candidate: string): boolean {
  return /(?:^|[-.])(?:vision|multimodal|vl\d*)(?:$|[-.])/.test(candidate);
}

function isKnownTextOnlyDeepseekModel(candidate: string): boolean {
  return /^deepseek-(?:chat|reasoner|v4-(?:flash|pro))(?:$|[-.])/.test(
    candidate,
  );
}

export function isTextOnlyModel(model: string): boolean {
  const candidates = getModelNameCandidates(model);
  const deepseekCandidates = candidates.filter(isDeepseekModel);
  if (deepseekCandidates.length) {
    if (deepseekCandidates.some(isExplicitTextOnlyModel)) return true;
    if (deepseekCandidates.some(isExplicitVisionModel)) return false;
    return deepseekCandidates.some(isKnownTextOnlyDeepseekModel);
  }
  return candidates.some(
    (candidate) =>
      /reasoner/.test(candidate) || isExplicitTextOnlyModel(candidate),
  );
}
