import type { GeneratedChatImage } from "./types";

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

function cleanPdfLocation(value: unknown): GeneratedChatImage["pdfLocation"] {
  if (!value || typeof value !== "object") return undefined;
  const { contextItemId, pageIndex } = value as Record<string, unknown>;
  if (!Number.isInteger(contextItemId) || (contextItemId as number) <= 0) {
    return undefined;
  }
  if (!Number.isInteger(pageIndex) || (pageIndex as number) < 0) {
    return undefined;
  }
  return {
    contextItemId: contextItemId as number,
    pageIndex: pageIndex as number,
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
    const pdfLocation = cleanPdfLocation(record.pdfLocation);
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
      ...(pdfLocation ? { pdfLocation } : {}),
    });
  }
  return images;
}
