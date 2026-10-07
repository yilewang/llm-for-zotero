import { isQuoteTokenId } from "./quoteTokenIds";

/** Paragraph support and reading recommendations share IDs, not presentation. */
const CITATION_RUN = /\[\[cite:[^\]\n]*\]\](?:[ \t]*\[\[cite:[^\]\n]*\]\])*/g;

export function transformParagraphCitations(
  markdown: string,
  replace: (ids: string[]) => string,
): string {
  let fence: { char: string; length: number } | undefined;
  return markdown
    .split("\n")
    .map((line) => {
      const delimiter = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (delimiter) {
        if (!fence) fence = { char: delimiter[0], length: delimiter.length };
        else if (
          delimiter[0] === fence.char &&
          delimiter.length >= fence.length
        )
          fence = undefined;
        return line;
      }
      if (fence || /^(?: {4}|\t)/.test(line)) return line;
      // Preserve inline code (including code delimited by multiple backticks).
      return line
        .split(/(`+[^`]*(?:`(?!`)[^`]*)*?`+)/g)
        .map((part) => {
          if (part.startsWith("`")) return part;
          return part.replace(CITATION_RUN, (token, offset: number) => {
            if (offset > 0 && part[offset - 1] === "\\") return token;
            const ids = [...token.matchAll(/\[\[cite:([^\]]+)\]\]/g)]
              .flatMap((match) => match[1].split(",").map((id) => id.trim()))
              .filter(isQuoteTokenId);
            return replace([...new Set(ids)]);
          });
        })
        .join("");
    })
    .join("\n");
}

export function paragraphCitationIds(markdown: string): Set<string> {
  const ids = new Set<string>();
  transformParagraphCitations(markdown, (group) => {
    for (const id of group) ids.add(id);
    return "";
  });
  return ids;
}

export function normalizeParagraphCitations(
  markdown: string,
  validIds: ReadonlySet<string>,
): string {
  return transformParagraphCitations(markdown, (ids) => {
    const known = ids.filter((id) => validIds.has(id));
    return known.length ? `[[cite:${known.join(",")}]]` : "";
  });
}
