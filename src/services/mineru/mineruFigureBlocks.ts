import type { MineruContentListEntry } from "../../utils/mineruZip";
export type { MineruContentListEntry } from "../../utils/mineruZip";

export type MineruFigureBlockKind = "figure" | "table" | "image" | "mixed";

export type MineruFigureBlock = {
  blockId: string;
  kind: MineruFigureBlockKind;
  imagePaths: string[];
  markdownStart: number;
  markdownEnd: number;
  contextStart: number;
  contextEnd: number;
  labelHints: string[];
  captionHints: string[];
  sectionHeading: string | null;
  pageStart?: number;
  pageEnd?: number;
  confidence: "high" | "low";
  ambiguous: boolean;
};

type MarkdownImageRef = {
  alt: string;
  path: string;
  start: number;
  end: number;
};

type ImageMeta = {
  path: string;
  kind: MineruFigureBlockKind;
  captionHints: string[];
  labelHints: string[];
  page?: number;
  sectionHeading: string | null;
};

const MD_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)\n]+)\)/g;
const MAX_HIGH_CONFIDENCE_BLOCK_IMAGES = 50;

function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/^file:\/\/\/?/i, "")
    .replace(/^<|>$/g, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/g, "");
}

function pathBaseName(value: string): string {
  return normalizePath(value).split("/").pop() || normalizePath(value);
}

function pathsMatch(left: string, right: string): boolean {
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (!a || !b) return false;
  return (
    a === b ||
    a.endsWith(`/${b}`) ||
    b.endsWith(`/${a}`) ||
    pathBaseName(a) === pathBaseName(b)
  );
}

function uniqueStrings(values: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** Extract a figure/table label like "Fig. 1", "Figure 3", or "Table 2". */
export function extractFigureLabel(caption: string): string {
  const match = caption
    .trim()
    .match(
      /^(Supplementary\s+)?(Fig(?:ure)?\.?|Table)\s*([sS]?\d+)([a-z])?\b/i,
    );
  if (!match) return "";
  return `${match[1] || ""}${match[2]} ${match[3]}${match[4] || ""}`.trim();
}

export function getManifestFigureBaseLabel(label: string): string {
  const trimmed = label.trim();
  const match = trimmed.match(
    /^(Supplementary[\s_-]+)?(Fig(?:ure)?\.?|Table)[\s._-]*([sS]?\d+)([a-z])?\b/i,
  );
  if (!match) return trimmed;
  const prefix = match[1] ? "Supplementary " : "";
  const kind = /^table$/i.test(match[2]) ? "Table" : "Figure";
  const number = match[3].toUpperCase();
  return `${prefix}${kind} ${number}`;
}

function isCaptionLikeText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (extractFigureLabel(trimmed)) return true;
  return /^\(?[a-z]\)?\s*[.:;-]\s+/i.test(trimmed) && trimmed.length < 250;
}

function extractMarkdownImages(fullMd: string): MarkdownImageRef[] {
  const refs: MarkdownImageRef[] = [];
  const pattern = new RegExp(MD_IMAGE_PATTERN.source, MD_IMAGE_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(fullMd)) !== null) {
    const path = normalizePath(match[2] || "");
    if (!path || /^https?:\/\//i.test(path)) continue;
    refs.push({
      alt: match[1] || "",
      path,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return refs;
}

function textBetweenImagesHasBody(fullMd: string, start: number, end: number) {
  const between = fullMd.slice(start, end).trim();
  if (!between) return false;
  const stripped = between
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isCaptionLikeText(line));
  return stripped.length > 0;
}

function extractCaptionsFromText(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && isCaptionLikeText(line));
}

function sectionHeadingBefore(fullMd: string, index: number): string | null {
  const before = fullMd.slice(0, Math.max(0, index));
  const matches = [...before.matchAll(/^#{1,6}\s+(.+)$/gm)];
  const last = matches[matches.length - 1];
  return last ? last[1].trim() : null;
}

function paragraphBoundaryBefore(fullMd: string, index: number): number {
  const before = fullMd.slice(0, Math.max(0, index));
  const boundary = before.lastIndexOf("\n\n");
  return boundary >= 0 ? boundary + 2 : 0;
}

function paragraphBoundaryAfter(fullMd: string, index: number): number {
  const after = fullMd.slice(index);
  const boundary = after.indexOf("\n\n");
  return boundary >= 0 ? index + boundary : fullMd.length;
}

function entryKind(entry: MineruContentListEntry): MineruFigureBlockKind {
  if (entry.type === "table") return "table";
  if (entry.type === "image") return "figure";
  return "image";
}

function captionsForEntry(entry: MineruContentListEntry): string[] {
  const captions =
    entry.type === "table"
      ? [...(entry.table_caption || []), ...(entry.table_footnote || [])]
      : [...(entry.image_caption || []), ...(entry.image_footnote || [])];
  return uniqueStrings(captions.map((caption) => caption.trim()));
}

function buildContentListMeta(
  contentList: MineruContentListEntry[] | undefined,
): Map<string, ImageMeta> {
  const out = new Map<string, ImageMeta>();
  let currentSection: string | null = null;
  for (const entry of contentList || []) {
    if (entry.type === "text" && entry.text_level === 1 && entry.text?.trim()) {
      currentSection = entry.text.trim();
      continue;
    }
    if (
      entry.type !== "image" &&
      entry.type !== "table" &&
      entry.type !== "equation"
    ) {
      continue;
    }
    if (!entry.img_path) continue;
    const captionHints = captionsForEntry(entry);
    const labelHints = uniqueStrings(
      captionHints
        .map(extractFigureLabel)
        .filter(Boolean)
        .map(getManifestFigureBaseLabel),
    );
    out.set(normalizePath(entry.img_path), {
      path: normalizePath(entry.img_path),
      kind: entryKind(entry),
      captionHints,
      labelHints,
      page: entry.page_idx === undefined ? undefined : entry.page_idx + 1,
      sectionHeading: currentSection,
    });
  }
  return out;
}

function metaForPath(
  path: string,
  metaByPath: Map<string, ImageMeta>,
): ImageMeta | null {
  const normalized = normalizePath(path);
  return (
    metaByPath.get(normalized) ||
    [...metaByPath.values()].find((meta) =>
      pathsMatch(meta.path, normalized),
    ) ||
    null
  );
}

function splitGroupOnConflictingLabels(
  group: MarkdownImageRef[],
  metaByPath: Map<string, ImageMeta>,
): MarkdownImageRef[][] {
  const out: MarkdownImageRef[][] = [];
  let current: MarkdownImageRef[] = [];
  let currentLabel = "";
  for (const ref of group) {
    const labels = metaForPath(ref.path, metaByPath)?.labelHints || [];
    const label = labels[0] || "";
    if (current.length && label && currentLabel && label !== currentLabel) {
      out.push(current);
      current = [];
      currentLabel = "";
    }
    current.push(ref);
    if (label) currentLabel = label;
  }
  if (current.length) out.push(current);
  return out;
}

function inferBlockKind(metas: ImageMeta[]): MineruFigureBlockKind {
  const kinds = uniqueStrings(metas.map((meta) => meta.kind));
  if (kinds.length === 1) return kinds[0] as MineruFigureBlockKind;
  if (kinds.length > 1) return "mixed";
  return "image";
}

function buildBlock(
  refs: MarkdownImageRef[],
  index: number,
  fullMd: string,
  metaByPath: Map<string, ImageMeta>,
  hasContentList: boolean,
): MineruFigureBlock {
  const metas = refs
    .map((ref) => metaForPath(ref.path, metaByPath))
    .filter((meta): meta is ImageMeta => Boolean(meta));
  const start = refs[0]?.start ?? 0;
  const end = refs[refs.length - 1]?.end ?? start;
  const contextStart = paragraphBoundaryBefore(fullMd, start);
  const contextEnd = paragraphBoundaryAfter(fullMd, end);
  const inlineCaptions = extractCaptionsFromText(
    fullMd.slice(contextStart, contextEnd),
  );
  const captionHints = uniqueStrings([
    ...metas.flatMap((meta) => meta.captionHints),
    ...inlineCaptions,
  ]);
  const labelHints = uniqueStrings([
    ...metas.flatMap((meta) => meta.labelHints),
    ...refs
      .map((ref) => extractFigureLabel(ref.alt))
      .filter(Boolean)
      .map(getManifestFigureBaseLabel),
    ...captionHints
      .map(extractFigureLabel)
      .filter(Boolean)
      .map(getManifestFigureBaseLabel),
  ]);
  const pages = metas
    .map((meta) => meta.page)
    .filter((page): page is number => Number.isFinite(page));
  const pageStart = pages.length ? Math.min(...pages) : undefined;
  const pageEnd = pages.length ? Math.max(...pages) : undefined;
  const sectionHeading =
    metas.find((meta) => meta.sectionHeading)?.sectionHeading ||
    sectionHeadingBefore(fullMd, start);
  const pageSpans =
    pageStart !== undefined && pageEnd !== undefined && pageStart !== pageEnd;
  const overlong = refs.length > MAX_HIGH_CONFIDENCE_BLOCK_IMAGES;
  const fallbackLow = refs.length > 1 && !hasContentList;
  const confidence = pageSpans || overlong || fallbackLow ? "low" : "high";
  const firstPath = refs[0]?.path || String(index);
  return {
    blockId: `${index}:${firstPath}`,
    kind: inferBlockKind(metas),
    imagePaths: refs.map((ref) => ref.path),
    markdownStart: start,
    markdownEnd: end,
    contextStart,
    contextEnd,
    labelHints,
    captionHints,
    sectionHeading,
    ...(pageStart !== undefined ? { pageStart } : {}),
    ...(pageEnd !== undefined ? { pageEnd } : {}),
    confidence,
    ambiguous: confidence === "low",
  };
}

export function buildMineruFigureBlocks(source: {
  fullMd: string;
  contentList?: MineruContentListEntry[];
  manifestLike?: {
    allFigures?: Array<{
      path?: string;
      label?: string;
      baseLabel?: string;
      caption?: string;
      section?: string;
      page?: number;
    }>;
    allTables?: Array<{
      path?: string;
      label?: string;
      baseLabel?: string;
      caption?: string;
      section?: string;
      page?: number;
    }>;
  };
}): MineruFigureBlock[] {
  const refs = extractMarkdownImages(source.fullMd);
  if (!refs.length) return [];
  const metaByPath = buildContentListMeta(source.contentList);
  const manifestEntries = [
    ...(source.manifestLike?.allFigures || []).map((entry) => ({
      ...entry,
      kind: "figure" as MineruFigureBlockKind,
    })),
    ...(source.manifestLike?.allTables || []).map((entry) => ({
      ...entry,
      kind: "table" as MineruFigureBlockKind,
    })),
  ];
  for (const entry of manifestEntries) {
    if (!entry.path) continue;
    const normalized = normalizePath(entry.path);
    const existing = metaForPath(normalized, metaByPath);
    const captionHints = entry.caption ? [entry.caption] : [];
    const labelHints = uniqueStrings([
      ...(entry.baseLabel ? [entry.baseLabel] : []),
      ...(entry.label ? [getManifestFigureBaseLabel(entry.label)] : []),
      ...captionHints
        .map(extractFigureLabel)
        .filter(Boolean)
        .map(getManifestFigureBaseLabel),
    ]);
    metaByPath.set(normalized, {
      path: normalized,
      kind: existing?.kind || entry.kind,
      captionHints: uniqueStrings([
        ...(existing?.captionHints || []),
        ...captionHints,
      ]),
      labelHints: uniqueStrings([
        ...(existing?.labelHints || []),
        ...labelHints,
      ]),
      page: existing?.page || entry.page,
      sectionHeading: existing?.sectionHeading || entry.section || null,
    });
  }

  const adjacentGroups: MarkdownImageRef[][] = [];
  let current: MarkdownImageRef[] = [];
  for (const ref of refs) {
    const previous = current[current.length - 1];
    if (
      previous &&
      textBetweenImagesHasBody(source.fullMd, previous.end, ref.start)
    ) {
      adjacentGroups.push(current);
      current = [];
    }
    current.push(ref);
  }
  if (current.length) adjacentGroups.push(current);

  const groups = adjacentGroups.flatMap((group) =>
    splitGroupOnConflictingLabels(group, metaByPath),
  );
  const hasContentList = Boolean(source.contentList?.length);
  return groups.map((group, index) =>
    buildBlock(group, index, source.fullMd, metaByPath, hasContentList),
  );
}
