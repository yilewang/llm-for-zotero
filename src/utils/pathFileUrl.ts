export function fileUrlToPath(url: string | undefined): string | undefined {
  const raw = (url || "").trim();
  if (!raw) return undefined;
  if (!/^file:\/\//i.test(raw)) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "file:") return undefined;
    let pathname = decodeURIComponent(parsed.pathname || "");
    if (!pathname) return undefined;
    if (/^\/[A-Za-z]:\//.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname;
  } catch (_err) {
    return undefined;
  }
}

export function toFileUrl(path: string | undefined): string | undefined {
  const raw = (path || "").trim();
  if (!raw) return undefined;
  if (/^file:\/\//i.test(raw)) return raw;
  const normalized = raw.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }
  if (normalized.startsWith("/")) {
    return `file://${encodeURI(normalized)}`;
  }
  return undefined;
}

export const pathToFileUrl = toFileUrl;
