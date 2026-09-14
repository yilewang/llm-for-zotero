/** Decode serialized note text once, preserving deliberately escaped entities. */
export function decodeNoteHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    nbsp: " ",
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi,
    (entity, key: string) => {
      if (!key.startsWith("#")) return named[key.toLowerCase()] || entity;
      const hex = key[1].toLowerCase() === "x";
      const code = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : entity;
    },
  );
}

/** Block endings and explicit breaks used by both note reading and patch matching. */
export const NOTE_TEXT_BREAK_PATTERN =
  /<\/(p|div|h[1-6]|li|tr|blockquote)\s*>|<br\s*\/?>/i;

/** Preserve entities while composing Markdown; decode only the final text. */
export function stripNoteMarkup(html: string): string {
  if (!html) return "";
  let text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(new RegExp(NOTE_TEXT_BREAK_PATTERN.source, "gi"), "\n");
  text = text.replace(/<[^>]+>/g, "");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export function stripNoteHtml(html: string): string {
  return decodeNoteHtmlEntities(stripNoteMarkup(html));
}

/** Compare visible text without interpreting literal HTML or Markdown again. */
export function normalizeNotePlainText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
