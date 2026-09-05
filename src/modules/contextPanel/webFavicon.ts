import { normalizePublicWebUrl } from "../../webAccess/tavilyClient";

export function normalizeWebFaviconUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return normalizePublicWebUrl(value);
  } catch {
    return undefined;
  }
}

export function createWebFaviconImage(
  doc: Document,
  value: unknown,
  className: string,
): HTMLImageElement | null {
  const faviconUrl = normalizeWebFaviconUrl(value);
  if (!faviconUrl) return null;
  const image = doc.createElement("img");
  image.className = className;
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.setAttribute("aria-hidden", "true");
  image.addEventListener("error", () => {
    image.hidden = true;
  });
  image.src = faviconUrl;
  return image;
}
