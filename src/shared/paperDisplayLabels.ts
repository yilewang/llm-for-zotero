/** Display identity is separate from selectors and evidence identity. */
export type PaperDisplayMetadata = {
  title?: string;
  firstCreator?: string;
  year?: string;
  versionLabel?: string;
  libraryLabel?: string;
};

export function formatPaperDisplayLabel(
  paper: PaperDisplayMetadata,
  options: { preserveUndatedCitation?: boolean } = {},
): string {
  const creator = paper.firstCreator?.trim();
  const author = creator || paper.title?.trim() || "Untitled paper";
  const year = paper.year?.trim();
  // Existing quote source labels remain matchable when their year was absent.
  if (options.preserveUndatedCitation && creator && !year) return `(${author})`;
  return `(${author}, ${year || "n.d."})`;
}

export function buildPaperDisplayLabels(
  papers: readonly (PaperDisplayMetadata & { identity: string })[],
): Map<string, string> {
  const unique = [
    ...new Map(papers.map((paper) => [paper.identity, paper])).values(),
  ];
  const labels = new Map(
    unique.map((paper) => [paper.identity, formatPaperDisplayLabel(paper)]),
  );
  const groups = () => {
    const result = new Map<string, typeof unique>();
    for (const paper of unique) {
      const label = labels.get(paper.identity)!;
      result.set(label, [...(result.get(label) || []), paper]);
    }
    return [...result.entries()].filter(([, group]) => group.length > 1);
  };
  for (const [label, group] of groups())
    for (const paper of group) {
      const title = paper.title?.trim();
      if (title)
        labels.set(
          paper.identity,
          `${label.slice(0, -1)} — ${title.length > 90 ? title.slice(0, 89) + "…" : title})`,
        );
    }
  for (const [label, group] of groups())
    for (const paper of group) {
      const detail = [paper.versionLabel, paper.libraryLabel]
        .filter(Boolean)
        .join(", ");
      if (detail)
        labels.set(paper.identity, `${label.slice(0, -1)}; ${detail})`);
    }
  for (const [label, group] of groups())
    group.forEach((paper, index) =>
      labels.set(
        paper.identity,
        `${label.slice(0, -1)}; duplicate ${index + 1}/${group.length})`,
      ),
    );
  return labels;
}

/** Only exact, known identities in ordinary Markdown prose are projected. */
export function projectPaperReferences(
  text: string,
  labels: ReadonlyMap<string, string>,
): string {
  const aliases = new Map(labels);
  const keys = new Map<string, string[]>();
  for (const [identity, label] of labels) {
    const key = identity.split(":").at(-1)!;
    keys.set(key, [...(keys.get(key) || []), label]);
  }
  for (const [key, values] of keys)
    if (values.length === 1 && /^[A-Z0-9]{8}$/.test(key))
      aliases.set(key, values[0]);
  if (!aliases.size) return text;
  const escape = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_:])(?:${[...aliases.keys()]
      .sort((a, b) => b.length - a.length)
      .map(escape)
      .join("|")})(?![A-Za-z0-9_])`,
    "g",
  );
  const protectedText =
    /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|\]\([^\n)]*\)|\[\[(?:quote|cite):[^\]]*\]\]|^\s*>[^\n]*|https?:\/\/\S+|zotero:\/\/\S+|["“][^"”\n]*["”])/gm;
  return text
    .split(protectedText)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(pattern, (identity) => aliases.get(identity)!),
    )
    .join("");
}
