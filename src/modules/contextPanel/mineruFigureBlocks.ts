export type MineruContentListEntry = {
  type: string;
  text?: string;
  text_level?: number;
  page_idx?: number;
  img_path?: string;
  image_caption?: string[];
  image_footnote?: string[];
  table_body?: string;
  table_caption?: string[];
  table_footnote?: string[];
};

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

export type MineruFigureBlockQueryResult = {
  blocks: MineruFigureBlock[];
  panelHint?: string;
};

export type FigureBlockEmbedValidationResult = {
  block: MineruFigureBlock;
  embeddedCount: number;
  availableCount: number;
  availablePaths: string[];
  severity: "block" | "advisory";
  message: string;
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

type FigureQueryRef = {
  baseLabel: string;
  panelHint?: string;
};

const MD_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)\n]+)\)/g;
const HTML_IMG_PATTERN = /<img\b[^>]*>/gi;
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
    /^(Supplementary\s+)?(Fig(?:ure)?\.?|Table)\s*([sS]?\d+)([a-z])?\b/i,
  );
  if (!match) return trimmed;
  const prefix = match[1] ? "Supplementary " : "";
  const kind = /^table$/i.test(match[2]) ? "Table" : "Figure";
  const number = match[3].toUpperCase();
  return `${prefix}${kind} ${number}`;
}

function parseBaseLabel(
  value: string,
): { kind: "Figure" | "Table"; number: string; supplementary: boolean } | null {
  const match = value
    .trim()
    .match(/^(Supplementary\s+)?(Figure|Table)\s+([sS]?\d+)$/i);
  if (!match) return null;
  return {
    kind: /^table$/i.test(match[2]) ? "Table" : "Figure",
    number: match[3].toUpperCase(),
    supplementary: Boolean(match[1]),
  };
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

function labelMentionPattern(baseLabel: string): RegExp | null {
  const parsed = parseBaseLabel(baseLabel);
  if (!parsed) return null;
  const number = parsed.number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const kind = parsed.kind === "Figure" ? "Fig(?:ure)?s?\\.?" : "Tables?";
  const supplementary = parsed.supplementary
    ? "Supplementary\\s+"
    : "(?:Supplementary\\s+)?";
  return new RegExp(`\\b${supplementary}${kind}\\s*${number}[a-z]?\\b`, "i");
}

function extractQueryRefs(query: string): FigureQueryRef[] {
  const refs: FigureQueryRef[] = [];
  const pattern =
    /\b(Supplementary\s+)?(Fig(?:ure)?s?\.?|Tables?)\s*([sS]?\d+)([a-z])?/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query)) !== null) {
    const kind = /^table/i.test(match[2]) ? "Table" : "Figure";
    const prefix = match[1] ? "Supplementary " : "";
    refs.push({
      baseLabel: `${prefix}${kind} ${match[3].toUpperCase()}`,
      ...(match[4] ? { panelHint: match[4].toLowerCase() } : {}),
    });
    const tail = query.slice(pattern.lastIndex);
    const tailPattern = /^\s*(?:,|and|&)\s*([sS]?\d+)([a-z])?/i;
    let tailMatch = tail.match(tailPattern);
    let consumed = 0;
    while (tailMatch) {
      refs.push({
        baseLabel: `${prefix}${kind} ${tailMatch[1].toUpperCase()}`,
        ...(tailMatch[2] ? { panelHint: tailMatch[2].toLowerCase() } : {}),
      });
      consumed += tailMatch[0].length;
      tailMatch = tail.slice(consumed).match(tailPattern);
    }
  }
  return refs;
}

function blockMatchesBaseLabel(
  block: MineruFigureBlock,
  baseLabel: string,
): boolean {
  if (block.labelHints.some((label) => label === baseLabel)) return true;
  const pattern = labelMentionPattern(baseLabel);
  if (!pattern) return false;
  return block.captionHints.some((caption) => pattern.test(caption));
}

export function resolveMineruFigureBlocksForQuery(
  query: string,
  blocks: MineruFigureBlock[],
): MineruFigureBlockQueryResult {
  const refs = extractQueryRefs(query);
  const matched: MineruFigureBlock[] = [];
  let panelHint: string | undefined;
  for (const ref of refs) {
    if (!panelHint && ref.panelHint) panelHint = ref.panelHint;
    for (const block of blocks) {
      if (blockMatchesBaseLabel(block, ref.baseLabel)) {
        matched.push(block);
      }
    }
  }
  return {
    blocks: uniqueBlocks(matched),
    ...(panelHint ? { panelHint } : {}),
  };
}

function uniqueBlocks(blocks: MineruFigureBlock[]): MineruFigureBlock[] {
  const seen = new Set<string>();
  const out: MineruFigureBlock[] = [];
  for (const block of blocks) {
    if (seen.has(block.blockId)) continue;
    seen.add(block.blockId);
    out.push(block);
  }
  return out;
}

export function findMineruFigureBlockByImagePath(
  path: string,
  blocks: MineruFigureBlock[],
): MineruFigureBlock | null {
  return (
    blocks.find((block) =>
      block.imagePaths.some((imagePath) => pathsMatch(imagePath, path)),
    ) || null
  );
}

function attrValue(tag: string, attr: string): string {
  const match = tag.match(
    new RegExp(`\\b${attr}\\s*=\\s*["']([^"']*)["']`, "i"),
  );
  return match?.[1] || "";
}

function extractEmbeddedImages(content: string): Array<{
  alt: string;
  target: string;
}> {
  const embeds: Array<{ alt: string; target: string }> = [];
  const mdPattern = new RegExp(MD_IMAGE_PATTERN.source, MD_IMAGE_PATTERN.flags);
  let mdMatch: RegExpExecArray | null;
  while ((mdMatch = mdPattern.exec(content)) !== null) {
    embeds.push({ alt: mdMatch[1] || "", target: mdMatch[2] || "" });
  }
  let htmlMatch: RegExpExecArray | null;
  const htmlPattern = new RegExp(
    HTML_IMG_PATTERN.source,
    HTML_IMG_PATTERN.flags,
  );
  while ((htmlMatch = htmlPattern.exec(content)) !== null) {
    const tag = htmlMatch[0];
    const target =
      attrValue(tag, "src") ||
      attrValue(tag, "data-source-path") ||
      attrValue(tag, "data-original-path");
    embeds.push({
      alt: attrValue(tag, "alt"),
      target,
    });
  }
  return embeds;
}

function getEmbedCoveredBlockPaths(
  embed: { alt: string; target: string },
  block: MineruFigureBlock,
): string[] {
  if (!embed.target) return [];
  return block.imagePaths.filter((imagePath) =>
    pathsMatch(imagePath, embed.target),
  );
}

function embedMentionsBlock(
  embed: { alt: string; target: string },
  block: MineruFigureBlock,
): boolean {
  if (getEmbedCoveredBlockPaths(embed, block).length) return true;
  const haystack = `${embed.alt} ${embed.target}`;
  return block.labelHints.some((label) =>
    labelMentionPattern(label)?.test(haystack),
  );
}

function contentMentionsBlock(
  content: string,
  requestText: string,
  block: MineruFigureBlock,
): boolean {
  const text = `${requestText}\n${content}`;
  return block.labelHints.some((label) =>
    labelMentionPattern(label)?.test(text),
  );
}

function statesAmbiguity(content: string, block: MineruFigureBlock): boolean {
  if (!block.ambiguous) return false;
  return /\b(?:ambiguous|ambiguity|uncertain|unclear|not clear|cannot determine|could not determine|block boundary|panel mapping)\b/i.test(
    content,
  );
}

export function validateFigureBlockEmbeds(args: {
  content: string;
  requestText: string;
  blocks: MineruFigureBlock[];
}): FigureBlockEmbedValidationResult | null {
  const embeds = extractEmbeddedImages(args.content);
  for (const block of args.blocks) {
    if (block.imagePaths.length <= 1) continue;
    const coveredImagePaths = new Set<string>();
    let hasBlockEmbedMention = false;
    for (const embed of embeds) {
      const coveredPaths = getEmbedCoveredBlockPaths(embed, block);
      for (const path of coveredPaths) {
        coveredImagePaths.add(normalizePath(path));
      }
      if (coveredPaths.length || embedMentionsBlock(embed, block)) {
        hasBlockEmbedMention = true;
      }
    }
    const embeddedCount = coveredImagePaths.size;
    const discussed =
      hasBlockEmbedMention ||
      contentMentionsBlock(args.content, args.requestText, block);
    if (!discussed) continue;
    if (embeddedCount >= block.imagePaths.length) continue;
    if (block.ambiguous && statesAmbiguity(args.content, block)) continue;
    const severity: "block" | "advisory" = block.ambiguous
      ? "advisory"
      : "block";
    const label = block.labelHints[0] || block.sectionHeading || "figure block";
    return {
      block,
      embeddedCount,
      availableCount: block.imagePaths.length,
      availablePaths: block.imagePaths,
      severity,
      message:
        `Incomplete MinerU figure block: ${label} has ${block.imagePaths.length} adjacent image${block.imagePaths.length === 1 ? "" : "s"}, ` +
        `but this note embeds ${embeddedCount}. Embed every image in source order` +
        (severity === "advisory"
          ? " or explicitly state the block boundary/panel mapping ambiguity"
          : "") +
        `. Available paths: ${block.imagePaths.join(", ")}`,
    };
  }
  return null;
}
