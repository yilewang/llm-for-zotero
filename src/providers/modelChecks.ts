/**
 * Cross-cutting model restriction check.
 *
 * Returns true for models that are text-only and cannot process images,
 * PDFs, or any non-text content regardless of which provider tier they
 * belong to.
 */
export function isTextOnlyModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return (
    /^deepseek-(?:chat|reasoner)(?:$|[.-])/.test(m) ||
    /reasoner|text-only|embedding/.test(m)
  );
}
