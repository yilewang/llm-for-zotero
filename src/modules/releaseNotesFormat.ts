/**
 * Tidies a GitHub release body for the "What's new" window. Release text is
 * written for the GitHub page, which shows every line break; the chat
 * Markdown renderer joins plain lines into one paragraph. So:
 *
 * - a run of two or more plain lines becomes a bullet list, one line each,
 *   with a short first sentence in bold ("Better library search. ...");
 * - a heading or bold line that only names the release ("v3.9.12",
 *   "Release note", "LLM for Zotero v3.9.11") is dropped, since the window
 *   already shows the date and version.
 *
 * Code blocks and everything that already is Markdown structure are kept.
 */

const BLOCK_START =
  /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~|<|!\[|\s{2,}|\t|-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$|=+\s*$)/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isReleaseTitle(line: string, version: string): boolean {
  const text = line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(\*\*|__)(.*)\1$/, "$2")
    .trim()
    .toLowerCase();
  if (!text) return false;
  const v = escapeRegExp(version.toLowerCase());
  return new RegExp(
    `^(?:(?:llm[- ]for[- ]zotero|release)\\s+)?(?:v?${v}|release\\s*notes?)$`,
  ).test(text);
}

function isHeadingOrBoldOnly(line: string): boolean {
  const trimmed = line.trim();
  return /^#{1,6}\s/.test(trimmed) || /^(\*\*|__)[^*_]+\1$/.test(trimmed);
}

/** "Better search. Related words match." -> "**Better search.** Related…" */
export function boldLeadSentence(line: string): string {
  if (/\*\*|__/.test(line)) return line;
  const match = /^([^.!?]{3,80}[.!?])\s+(\S[\s\S]*)$/.exec(line);
  if (!match) return line;
  return `**${match[1]}** ${match[2]}`;
}

export function tidyReleaseNotesMarkdown(
  body: string,
  version: string,
): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length >= 2) {
      for (const line of paragraph) out.push(`- ${boldLeadSentence(line)}`);
    } else {
      out.push(...paragraph);
    }
    paragraph = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      out.push("");
      continue;
    }
    if (isHeadingOrBoldOnly(line) && isReleaseTitle(line, version)) {
      flush();
      continue;
    }
    // A line that continues a list item or other block keeps its place.
    if (BLOCK_START.test(line) || isHeadingOrBoldOnly(line)) {
      flush();
      out.push(line);
      continue;
    }
    // Lazy continuation of a list item stays with it.
    const previous = out[out.length - 1];
    if (
      !paragraph.length &&
      previous &&
      /^\s*(?:[-*+]|\d+[.)])\s/.test(previous)
    ) {
      out.push(line);
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
