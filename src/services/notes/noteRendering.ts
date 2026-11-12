import { appLogger } from "../../core/logging";
import { renderMarkdownForNote } from "../../utils/markdown";
import { escapeNoteHtml, sanitizeText } from "../../utils/textSanitization";
import {
  NOTE_EMBED_TOKEN_PATTERN,
  replaceNoteEmbedsWithTokens,
  type NoteEmbed,
} from "../../utils/noteEmbeds";
import {
  decodeNoteHtmlEntities,
  stripNoteHtml,
  stripNoteMarkup,
} from "../../utils/noteText";

export function isLikelyHtmlNoteContent(text: string): boolean {
  if (!text || !/[<>]/.test(text)) return false;
  return /<\/?(?:p|div|span|strong|b|em|i|u|a|ul|ol|li|blockquote|h[1-6]|br|hr|code|pre)\b/i.test(
    text,
  );
}

export function normalizeNoteSourceText(contentText: string): string {
  const raw = sanitizeText(contentText || "").trim();
  if (!raw) return "";
  if (!isLikelyHtmlNoteContent(raw)) return raw;
  return decodeNoteHtmlEntities(noteHtmlToMarkdown(raw)) || stripNoteHtml(raw);
}

/** Compose first; decode entities once at the public HTML-to-text boundary. */
function noteHtmlToMarkdown(raw: string): string {
  let normalized = raw.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  const quote =
    /<blockquote\b[^>]*>((?:(?!<\/?blockquote\b)[\s\S])*)<\/blockquote>/gi;
  while (/<blockquote\b/i.test(normalized)) {
    const next = normalized.replace(
      quote,
      (_match, body: string) =>
        `\n\n${noteHtmlToMarkdown(body)
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n")}\n\n`,
    );
    if (next === normalized) break;
    normalized = next;
  }

  normalized = normalized.replace(
    /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, _quote, href, text) => {
      const label = stripNoteMarkup(text).trim();
      const target = `${href || ""}`.trim();
      if (!label) return target;
      return target ? `[${label}](${target})` : label;
    },
  );
  normalized = normalized.replace(
    /<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi,
    (_match, _tag, text) => `**${stripNoteMarkup(text).trim()}**`,
  );
  normalized = normalized.replace(
    /<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi,
    (_match, _tag, text) => `*${stripNoteMarkup(text).trim()}*`,
  );
  normalized = normalized.replace(
    /<code[^>]*>([\s\S]*?)<\/code>/gi,
    (_match, text) => `\`${stripNoteMarkup(text).trim()}\``,
  );
  // Zotero's display equations are stored as <pre class="math">$$…$$</pre>.
  // Read them back as Markdown math, not as a code block, so a rewrite
  // renders them as equations again.
  normalized = normalized.replace(
    /<pre\b[^>]*\bclass\s*=\s*(["'])(?:[^"']*\s)?math(?:\s[^"']*)?\1[^>]*>([\s\S]*?)<\/pre>/gi,
    (_match, _quote, text) => `\n\n${stripNoteMarkup(text).trim()}\n\n`,
  );
  normalized = normalized.replace(
    /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
    (_match, text) => `\n\n\`\`\`\n${stripNoteMarkup(text)}\n\`\`\`\n\n`,
  );
  normalized = normalized.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");
  normalized = normalized.replace(/<br\s*\/?>/gi, "\n");
  normalized = normalized.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_match, level, text) =>
      `\n\n${"#".repeat(Number(level) || 1)} ${stripNoteMarkup(text).trim()}\n\n`,
  );
  normalized = normalized.replace(/<li[^>]*>/gi, "\n- ");
  normalized = normalized.replace(/<\/li>/gi, "");
  normalized = normalized.replace(
    /<\/?(?:p|div|section|article)\b[^>]*>/gi,
    "\n\n",
  );
  normalized = normalized.replace(/<(?!img\b)[^>]+>/g, "");
  return normalized
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderRawNoteHtml(contentText: string): string {
  const raw = normalizeNoteSourceText(contentText);
  if (!raw) return "<p></p>";
  try {
    return renderMarkdownForNote(raw);
  } catch (error) {
    appLogger.warn("Note markdown render error:", error);
    return escapeNoteHtml(raw).replace(/\n/g, "<br/>");
  }
}

/**
 * A note as the model reads it: Markdown, with each embedded item (citation,
 * PDF highlight, picture) shown as a `{{kind:id label}}` placeholder that
 * renderNoteMarkdownWithEmbeds turns back into the item.
 */
export function noteHtmlToModelText(html: string): string {
  const tokenized = replaceNoteEmbedsWithTokens(html || "");
  if (tokenized === html) return normalizeNoteSourceText(html);
  return normalizeNoteSourceText(`<div>${tokenized}</div>`);
}

/**
 * Render model-written Markdown into note HTML, turning each placeholder back
 * into the exact item it names. Placeholders are swapped for plain words
 * before rendering, so Markdown cannot reinterpret a label. Placeholders
 * the registry does not hold are left as text and reported.
 */
export function renderNoteMarkdownWithEmbeds(
  markdown: string,
  registry: Map<string, NoteEmbed>,
): { html: string; unknown: string[] } {
  const unknown: string[] = [];
  const ids: string[] = [];
  let nonce = 0;
  while (markdown.includes(`ZQ${nonce}E`)) nonce++;
  const text = markdown.replace(
    NOTE_EMBED_TOKEN_PATTERN,
    (token, _kind, id) => {
      if (!registry.has(id)) {
        unknown.push(token);
        return token;
      }
      ids.push(id);
      return `ZQ${nonce}E${ids.length - 1}QZ`;
    },
  );
  const html = renderRawNoteHtml(text);
  if (!ids.length) return { html, unknown };
  return {
    html: html.replace(
      new RegExp(`ZQ${nonce}E(\\d+)QZ`, "g"),
      (_match, index) => registry.get(ids[Number(index)])!.html,
    ),
    unknown,
  };
}

export function appendNoteHtml(
  existingHtml: string,
  newAnswerHtml: string,
): string {
  const base = (existingHtml || "").trim();
  const addition = (newAnswerHtml || "").trim();
  if (!base) return addition;
  if (!addition) return base;
  const schema = base.match(
    /^(<div\b[^>]*\bdata-schema-version=[^>]*>)([\s\S]*)<\/div>$/i,
  );
  if (schema) {
    return `${schema[1]}${schema[2].trim()}\n<hr>\n${addition}\n</div>`;
  }
  return `${base}<hr/>${addition}`;
}
