import { getLocalParentPath, joinLocalPath } from "../../utils/localPath";

const MINERU_CACHE_DIR_NAME = "llm-for-zotero-mineru";

export type MineruCacheFile = {
  relativePath: string;
  data: Uint8Array;
};

type IOUtilsLike = {
  exists?: (path: string) => Promise<boolean>;
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
  write?: (path: string, data: Uint8Array) => Promise<unknown>;
  remove?: (
    path: string,
    options?: { recursive?: boolean; ignoreAbsent?: boolean },
  ) => Promise<void>;
};

type OSFileLike = {
  exists?: (path: string) => Promise<boolean>;
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  makeDir?: (
    path: string,
    options?: { from?: string; ignoreExisting?: boolean },
  ) => Promise<void>;
  writeAtomic?: (path: string, data: Uint8Array) => Promise<void>;
  remove?: (
    path: string,
    options?: { ignoreAbsent?: boolean },
  ) => Promise<void>;
  removeDir?: (
    path: string,
    options?: { ignoreAbsent?: boolean; ignorePermissions?: boolean },
  ) => Promise<void>;
};

function getIOUtils(): IOUtilsLike | undefined {
  return (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils;
}

function getOSFile(): OSFileLike | undefined {
  return (globalThis as { OS?: { File?: OSFileLike } }).OS?.File;
}

function getBaseDir(): string {
  const zotero = Zotero as unknown as {
    DataDirectory?: { dir?: string };
    Profile?: { dir?: string };
  };
  const dataDir = zotero.DataDirectory?.dir;
  if (typeof dataDir === "string" && dataDir.trim()) return dataDir.trim();
  const profileDir = zotero.Profile?.dir;
  if (typeof profileDir === "string" && profileDir.trim())
    return profileDir.trim();
  throw new Error("Cannot resolve data directory for MinerU cache");
}

export function getMineruCacheDir(): string {
  return joinLocalPath(getBaseDir(), MINERU_CACHE_DIR_NAME);
}

export function getMineruItemDir(id: number): string {
  return joinLocalPath(getMineruCacheDir(), String(id));
}

// The md content is stored at a well-known path for quick access
function getMineruMdPath(id: number): string {
  return joinLocalPath(getMineruItemDir(id), "full.md");
}

// Legacy path (pre-full.md, used _content.md as the well-known name)
function getLegacyContentMdPath(id: number): string {
  return joinLocalPath(getMineruItemDir(id), "_content.md");
}

// Legacy path (pre-directory cache)
function getLegacyMdPath(id: number): string {
  return joinLocalPath(getMineruCacheDir(), `${id}.md`);
}

async function ensureDir(path: string): Promise<void> {
  const io = getIOUtils();
  if (io?.makeDirectory) {
    await io.makeDirectory(path, {
      createAncestors: true,
      ignoreExisting: true,
    });
    return;
  }
  const osFile = getOSFile();
  if (osFile?.makeDir) {
    await osFile.makeDir(path, { ignoreExisting: true });
  }
}

async function pathExists(path: string): Promise<boolean> {
  const io = getIOUtils();
  if (io?.exists) {
    try {
      return Boolean(await io.exists(path));
    } catch {
      return false;
    }
  }
  const osFile = getOSFile();
  if (osFile?.exists) {
    try {
      return Boolean(await osFile.exists(path));
    } catch {
      return false;
    }
  }
  return false;
}

async function readFileBytes(path: string): Promise<Uint8Array | null> {
  const io = getIOUtils();
  if (io?.read) {
    try {
      const data = await io.read(path);
      return data instanceof Uint8Array
        ? data
        : new Uint8Array(data as ArrayBuffer);
    } catch {
      return null;
    }
  }
  const osFile = getOSFile();
  if (osFile?.read) {
    try {
      const data = await osFile.read(path);
      return data instanceof Uint8Array
        ? data
        : new Uint8Array(data as ArrayBuffer);
    } catch {
      return null;
    }
  }
  return null;
}

async function writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
  const io = getIOUtils();
  if (io?.write) {
    await io.write(path, bytes);
    return;
  }
  const osFile = getOSFile();
  if (osFile?.writeAtomic) {
    await osFile.writeAtomic(path, bytes);
  }
}

async function removePath(path: string): Promise<void> {
  const io = getIOUtils();
  if (io?.remove) {
    try {
      await io.remove(path, { recursive: true, ignoreAbsent: true });
    } catch {
      /* ignore */
    }
    return;
  }
  const osFile = getOSFile();
  if (osFile?.removeDir) {
    try {
      await osFile.removeDir(path, {
        ignoreAbsent: true,
        ignorePermissions: false,
      });
    } catch {
      /* ignore */
    }
  } else if (osFile?.remove) {
    try {
      await osFile.remove(path, { ignoreAbsent: true });
    } catch {
      /* ignore */
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function hasCachedMineruMd(id: number): Promise<boolean> {
  if (await pathExists(getMineruMdPath(id))) return true;
  // Check legacy _content.md path
  if (await pathExists(getLegacyContentMdPath(id))) return true;
  // Check legacy single-file cache
  return await pathExists(getLegacyMdPath(id));
}

export async function readCachedMineruMd(id: number): Promise<string | null> {
  // Try full.md (current canonical path)
  const bytes = await readFileBytes(getMineruMdPath(id));
  if (bytes) return new TextDecoder("utf-8").decode(bytes);
  // Try legacy _content.md
  const legacyContentBytes = await readFileBytes(getLegacyContentMdPath(id));
  if (legacyContentBytes)
    return new TextDecoder("utf-8").decode(legacyContentBytes);
  // Try legacy single-file cache
  const legacyBytes = await readFileBytes(getLegacyMdPath(id));
  if (legacyBytes) return new TextDecoder("utf-8").decode(legacyBytes);
  return null;
}

export async function writeMineruCacheFiles(
  id: number,
  mdContent: string,
  files: MineruCacheFile[],
): Promise<void> {
  const itemDir = getMineruItemDir(id);
  await ensureDir(itemDir);

  // Write all extracted files from ZIP, skipping PDFs (the original
  // PDF is included in the MinerU ZIP but we already have it in Zotero)
  for (const file of files) {
    if (/\.pdf$/i.test(file.relativePath)) continue;
    // Split relative path into individual components so PathUtils.join
    // doesn't reject segments containing '/'.
    const parts = file.relativePath.split(/[\\/]+/).filter(Boolean);
    const filePath = joinLocalPath(itemDir, ...parts);
    const parentDir = getLocalParentPath(filePath);
    if (parentDir !== itemDir) {
      await ensureDir(parentDir);
    }
    await writeFileBytes(filePath, file.data);
  }

  // Ensure full.md exists (the ZIP normally includes it, but write as
  // a safety fallback in case the MinerU ZIP structure changes)
  const mdPath = getMineruMdPath(id);
  if (!(await pathExists(mdPath))) {
    await writeFileBytes(mdPath, new TextEncoder().encode(mdContent));
  }

  // Clean up legacy _content.md if it exists
  const legacyContentPath = getLegacyContentMdPath(id);
  if (await pathExists(legacyContentPath)) {
    await removePath(legacyContentPath);
  }

  // Clean up legacy single-file cache if it exists
  const legacyPath = getLegacyMdPath(id);
  if (await pathExists(legacyPath)) {
    await removePath(legacyPath);
  }

  // Build manifest.json from content_list + full.md (best effort)
  try {
    await buildAndWriteManifest(id);
  } catch {
    // Non-critical — manifest is an optimization, not required
  }
}

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export async function readMineruImageAsBase64(
  attachmentId: number,
  relativePath: string,
): Promise<string | null> {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  const filePath = joinLocalPath(getMineruItemDir(attachmentId), ...parts);
  const bytes = await readFileBytes(filePath);
  if (!bytes || bytes.length === 0) return null;
  const ext = (relativePath.match(/\.(\w+)$/)?.[1] || "png").toLowerCase();
  const mime = EXT_MIME[ext] || "image/png";
  return `data:${mime};base64,${toBase64(bytes)}`;
}

// ── Manifest ─────────────────────────────────────────────────────────────────

export type ManifestFigure = {
  label: string;
  path: string;
  caption: string;
  page?: number;
};

export type ManifestTable = {
  label: string;
  path: string;
  caption: string;
  page?: number;
};

export type ManifestSection = {
  heading: string;
  page?: number;
  charStart: number;
  charEnd: number;
  figures: ManifestFigure[];
  tables: ManifestTable[];
  equationCount: number;
};

export type MineruManifest = {
  sections: ManifestSection[];
  allFigures: (ManifestFigure & { section: string })[];
  allTables: (ManifestTable & { section: string })[];
  totalPages?: number;
  totalChars: number;
  noSections?: boolean;
};

function getManifestPath(id: number): string {
  return joinLocalPath(getMineruItemDir(id), "manifest.json");
}

/** Headings that are journal/publisher metadata noise, not real sections. */
const NOISE_HEADING_BLOCKLIST = new Set([
  "cell reports",
  "cell",
  "neuron",
  "current biology",
  "nature",
  "nature neuroscience",
  "nature communications",
  "science",
  "elife",
  "pnas",
  "check for updates",
  "authors",
  "author",
  "highlights",
  "correspondence",
  "graphical abstract",
  "in brief",
  "a r t i c l e",
  "a r t i c l e i n f o",
  "a b s t r a c t",
  "key points",
  "star methods",
  "resource availability",
  "lead contact",
  "data and code",
  "experimental model",
  "funding information",
]);

function isNoiseHeading(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3) return true;
  if (NOISE_HEADING_BLOCKLIST.has(trimmed.toLowerCase())) return true;
  // Unicode garbage from OCR artifacts (e.g. \uf0da sequences)
  if (/^[\uf000-\uf0ff\s]+$/.test(trimmed)) return true;
  return false;
}

/** Extract a figure/table label like "Fig. 1", "Figure 3", "Table 2" from caption text. */
function extractFigureLabel(caption: string): string {
  const match = caption.match(
    /^(Fig(?:ure)?\.?\s*\d+|Table\s*\d+|Supplementary\s+Fig(?:ure)?\.?\s*\d+)/i,
  );
  return match ? match[1] : "";
}

type ContentListEntry = {
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

/**
 * Build a manifest from full.md + content_list.json.
 *
 * 1. Scan full.md for `^# heading` lines to get char offsets for sections.
 * 2. Parse content_list.json for figure/table metadata per section.
 * 3. Combine into a lightweight manifest the agent can read quickly.
 */
export function buildManifest(
  mdContent: string,
  contentList: ContentListEntry[],
): MineruManifest {
  // ── Step 1: Extract section offsets from full.md ──
  const headingPattern = /^#\s+(.+)$/gm;
  const mdHeadings: { heading: string; charStart: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(mdContent)) !== null) {
    const heading = match[1].trim();
    if (!isNoiseHeading(heading)) {
      mdHeadings.push({ heading, charStart: match.index });
    }
  }

  // ── Step 2: Map content_list figures/tables/equations to sections ──
  // Build a section index from content_list using text_level: 1 entries
  type CLSection = {
    heading: string;
    page?: number;
    figures: ManifestFigure[];
    tables: ManifestTable[];
    equationCount: number;
  };
  const clSections: CLSection[] = [];
  let currentCLSection: CLSection | null = null;
  let totalPages = 0;

  for (const entry of contentList) {
    if (entry.page_idx !== undefined && entry.page_idx + 1 > totalPages) {
      totalPages = entry.page_idx + 1;
    }

    if (
      entry.type === "text" &&
      entry.text_level === 1 &&
      entry.text &&
      !isNoiseHeading(entry.text)
    ) {
      currentCLSection = {
        heading: entry.text.trim(),
        page: entry.page_idx,
        figures: [],
        tables: [],
        equationCount: 0,
      };
      clSections.push(currentCLSection);
      continue;
    }

    if (!currentCLSection) continue;

    if (entry.type === "image" && entry.img_path) {
      const captionText = (entry.image_caption || []).join(" ").trim();
      const label = extractFigureLabel(captionText);
      currentCLSection.figures.push({
        label: label || `image-${currentCLSection.figures.length + 1}`,
        path: entry.img_path,
        caption: captionText.slice(0, 300),
        page: entry.page_idx,
      });
    }

    if (entry.type === "table" && entry.img_path) {
      const captionText = (entry.table_caption || []).join(" ").trim();
      const footnoteText = (entry.table_footnote || []).join(" ").trim();
      const label = extractFigureLabel(captionText || footnoteText);
      currentCLSection.tables.push({
        label: label || `table-${currentCLSection.tables.length + 1}`,
        path: entry.img_path,
        caption: (captionText || footnoteText).slice(0, 300),
        page: entry.page_idx,
      });
    }

    if (entry.type === "equation") {
      currentCLSection.equationCount += 1;
    }
  }

  // ── Step 3: Build manifest sections by combining md offsets + cl metadata ──
  // Match md headings to content_list sections by heading text
  const clSectionByHeading = new Map<string, CLSection>();
  for (const cls of clSections) {
    clSectionByHeading.set(cls.heading, cls);
  }

  const sections: ManifestSection[] = [];
  for (let i = 0; i < mdHeadings.length; i++) {
    const { heading, charStart } = mdHeadings[i];
    const charEnd =
      i + 1 < mdHeadings.length
        ? mdHeadings[i + 1].charStart
        : mdContent.length;

    const cls = clSectionByHeading.get(heading);

    sections.push({
      heading,
      page: cls?.page,
      charStart,
      charEnd,
      figures: cls?.figures || [],
      tables: cls?.tables || [],
      equationCount: cls?.equationCount || 0,
    });
  }

  // Handle edge case: 0-2 real sections → noSections mode
  if (sections.length <= 2) {
    return {
      sections,
      allFigures: [],
      allTables: [],
      totalPages: totalPages || undefined,
      totalChars: mdContent.length,
      noSections: true,
    };
  }

  // If too many sections (50+), merge adjacent small ones (< 500 chars)
  if (sections.length > 50) {
    const merged: ManifestSection[] = [];
    for (const section of sections) {
      const prevSection = merged.length > 0 ? merged[merged.length - 1] : null;
      if (
        prevSection &&
        prevSection.charEnd - prevSection.charStart < 500 &&
        section.charEnd - section.charStart < 500
      ) {
        // Merge small adjacent section into previous
        prevSection.charEnd = section.charEnd;
        prevSection.figures.push(...section.figures);
        prevSection.tables.push(...section.tables);
        prevSection.equationCount += section.equationCount;
      } else {
        merged.push({
          ...section,
          figures: [...section.figures],
          tables: [...section.tables],
        });
      }
    }
    sections.length = 0;
    sections.push(...merged);
  }

  // Build flat figure/table lists
  const allFigures: (ManifestFigure & { section: string })[] = [];
  const allTables: (ManifestTable & { section: string })[] = [];
  for (const section of sections) {
    for (const fig of section.figures) {
      allFigures.push({ ...fig, section: section.heading });
    }
    for (const tbl of section.tables) {
      allTables.push({ ...tbl, section: section.heading });
    }
  }

  return {
    sections,
    allFigures,
    allTables,
    totalPages: totalPages || undefined,
    totalChars: mdContent.length,
  };
}

/**
 * Find the content_list.json file in a MinerU cache directory.
 * The filename is `{uuid}_content_list.json` where uuid varies per paper.
 */
async function findContentListPath(itemDir: string): Promise<string | null> {
  const io = getIOUtils();
  const ioAny = io as Record<string, unknown> | undefined;
  const getChildren =
    ioAny && typeof ioAny.getChildren === "function"
      ? (ioAny.getChildren as (path: string) => Promise<string[]>)
      : null;
  if (!getChildren) return null;

  let entries: string[];
  try {
    entries = await getChildren(itemDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const basename = entry.split(/[\\/]/).pop() || "";
    if (basename.endsWith("_content_list.json")) {
      return entry;
    }
  }
  return null;
}

/**
 * Build and write manifest.json for a cached paper.
 * Reads full.md and content_list.json from the cache directory.
 */
export async function buildAndWriteManifest(
  id: number,
): Promise<MineruManifest | null> {
  const itemDir = getMineruItemDir(id);
  if (!(await pathExists(itemDir))) return null;

  const mdBytes = await readFileBytes(getMineruMdPath(id));
  if (!mdBytes) return null;
  const mdContent = new TextDecoder("utf-8").decode(mdBytes);

  const contentListPath = await findContentListPath(itemDir);
  let contentList: ContentListEntry[] = [];
  if (contentListPath) {
    const clBytes = await readFileBytes(contentListPath);
    if (clBytes) {
      try {
        contentList = JSON.parse(new TextDecoder("utf-8").decode(clBytes));
      } catch {
        // Invalid JSON — proceed without content_list
      }
    }
  }

  const manifest = buildManifest(mdContent, contentList);

  // Write manifest.json
  const manifestPath = getManifestPath(id);
  await writeFileBytes(
    manifestPath,
    new TextEncoder().encode(JSON.stringify(manifest)),
  );

  return manifest;
}

/**
 * Read a previously built manifest.json from cache.
 */
export async function readManifest(id: number): Promise<MineruManifest | null> {
  const manifestPath = getManifestPath(id);
  const bytes = await readFileBytes(manifestPath);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Get or build the manifest for a cached paper.
 * Reads from disk if available, otherwise builds and writes it.
 */
export async function ensureManifest(
  id: number,
): Promise<MineruManifest | null> {
  const existing = await readManifest(id);
  if (existing) return existing;
  return buildAndWriteManifest(id);
}

export async function invalidateMineruMd(id: number): Promise<void> {
  // Remove the directory-based cache
  await removePath(getMineruItemDir(id));
  // Also remove legacy single-file cache
  await removePath(getLegacyMdPath(id));
  // Cascade: clear embedding cache since chunks will change
  try {
    const { clearEmbeddingCache } = await import("./embeddingCache");
    await clearEmbeddingCache(id);
  } catch {
    /* embedding cache module may not be loaded yet */
  }
}

/**
 * One-time migration: remove legacy `_content.md` files from all cache
 * directories where `full.md` already exists.
 */
export async function cleanupLegacyContentMdFiles(): Promise<void> {
  const cacheDir = getMineruCacheDir();
  if (!(await pathExists(cacheDir))) return;

  const io = getIOUtils();
  if (!io?.exists || !io?.remove) return;

  // IOUtils.getChildren lists immediate children of a directory
  const ioAny = io as Record<string, unknown>;
  const getChildren =
    typeof ioAny.getChildren === "function"
      ? (ioAny.getChildren as (path: string) => Promise<string[]>)
      : null;
  if (!getChildren) return;

  let entries: string[];
  try {
    entries = await getChildren(cacheDir);
  } catch {
    return;
  }

  let cleaned = 0;
  for (const entry of entries) {
    // Only process numbered directories (attachment IDs)
    const basename = entry.split(/[\\/]/).pop() || "";
    if (!/^\d+$/.test(basename)) continue;

    const fullMdPath = joinLocalPath(entry, "full.md");
    const contentMdPath = joinLocalPath(entry, "_content.md");

    if ((await pathExists(fullMdPath)) && (await pathExists(contentMdPath))) {
      await removePath(contentMdPath);
      cleaned += 1;
    }
  }

  if (cleaned > 0) {
    ztoolkit.log(`LLM: Cleaned up ${cleaned} legacy _content.md file(s).`);
  }
}
