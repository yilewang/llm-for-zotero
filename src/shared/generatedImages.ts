import type { GeneratedChatImage, GeneratedChatImageFigure } from "./types";

function cleanGeneratedImageText(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export function isRenderableGeneratedImageSrc(value: unknown): value is string {
  const src = cleanGeneratedImageText(value, Number.MAX_SAFE_INTEGER);
  if (!src) return false;
  return (
    /^file:\/\//i.test(src) ||
    /^https?:\/\//i.test(src) ||
    /^data:image\/[a-z0-9.+-]+[;,]/i.test(src)
  );
}

function normalizeGeneratedImageFigure(
  value: unknown,
): GeneratedChatImageFigure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const pageIndexRaw = Number(record.pageIndex);
  const pageIndex =
    record.pageIndex !== undefined &&
    record.pageIndex !== null &&
    Number.isFinite(pageIndexRaw) &&
    pageIndexRaw >= 0
      ? Math.floor(pageIndexRaw)
      : undefined;
  const pageLabel = cleanGeneratedImageText(record.pageLabel, 40);
  let paper: GeneratedChatImageFigure["paper"];
  const paperRecord = record.paper;
  if (
    paperRecord &&
    typeof paperRecord === "object" &&
    !Array.isArray(paperRecord)
  ) {
    const p = paperRecord as Record<string, unknown>;
    const itemId = Math.floor(Number(p.itemId));
    const contextItemId = Math.floor(Number(p.contextItemId));
    if (itemId > 0 && contextItemId > 0) {
      const title = cleanGeneratedImageText(p.title, 400);
      paper = { itemId, contextItemId, ...(title ? { title } : {}) };
    }
  }
  if (pageIndex === undefined && !pageLabel && !paper) return undefined;
  return {
    ...(pageIndex !== undefined ? { pageIndex } : {}),
    ...(pageLabel ? { pageLabel } : {}),
    ...(paper ? { paper } : {}),
  };
}

export function normalizeGeneratedChatImages(
  value: unknown,
): GeneratedChatImage[] {
  if (!Array.isArray(value)) return [];
  const images: GeneratedChatImage[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = cleanGeneratedImageText(record.id, 200);
    if (!id || seen.has(id)) continue;
    const path = cleanGeneratedImageText(record.path, 4000);
    let src = cleanGeneratedImageText(record.src, Number.MAX_SAFE_INTEGER);
    if (path && src && /^data:image\//i.test(src)) {
      src = undefined;
    }
    if (src && !isRenderableGeneratedImageSrc(src)) {
      src = undefined;
    }
    if (!path && !src) continue;
    seen.add(id);
    images.push({
      id,
      ...(cleanGeneratedImageText(record.label, 240)
        ? { label: cleanGeneratedImageText(record.label, 240) }
        : {}),
      ...(path ? { path } : {}),
      ...(src ? { src } : {}),
      ...(cleanGeneratedImageText(record.revisedPrompt, 8000)
        ? { revisedPrompt: cleanGeneratedImageText(record.revisedPrompt, 8000) }
        : {}),
      ...(normalizeGeneratedImageFigure(record.figure)
        ? { figure: normalizeGeneratedImageFigure(record.figure) }
        : {}),
    });
  }
  return images;
}
