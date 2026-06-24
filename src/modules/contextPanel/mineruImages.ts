import { getMineruItemDir, readMineruImageAsBase64 } from "./mineruCache";
import {
  loadMineruFigureBlocksFromCacheDir,
  toAbsoluteMineruPath,
  type LoadedMineruFigureBlocks,
} from "./mineruFigureBlockCache";
import { findMineruFigureBlockByImagePath } from "./mineruFigureBlocks";

const MD_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)]+)\)/g;
export const MAX_MINERU_CONTEXT_IMAGES = 50;

export type MineruImageRef = {
  alt: string;
  relativePath: string;
};

export type MineruContextImageInventoryEntry = {
  requestedPath: string;
  imagePaths: string[];
  absoluteImagePaths?: string[];
  blockId?: string;
  labelHints?: string[];
  captionHints?: string[];
  sectionHeading?: string | null;
  ambiguous?: boolean;
};

/**
 * Extract markdown image references from text.
 * Dedupes by relativePath, returns in order of appearance.
 */
export function extractImageRefsFromText(text: string): MineruImageRef[] {
  const seen = new Set<string>();
  const refs: MineruImageRef[] = [];
  let match: RegExpExecArray | null;
  const pattern = new RegExp(MD_IMAGE_PATTERN.source, MD_IMAGE_PATTERN.flags);
  while ((match = pattern.exec(text)) !== null) {
    const relativePath = match[2].trim();
    if (!relativePath || seen.has(relativePath)) continue;
    // Skip external URLs (http/https) — only resolve local paths
    if (/^https?:\/\//i.test(relativePath)) continue;
    seen.add(relativePath);
    refs.push({ alt: match[1], relativePath });
  }
  return refs;
}

function dedupeImageRefs(refs: MineruImageRef[]): MineruImageRef[] {
  const seen = new Set<string>();
  const out: MineruImageRef[] = [];
  for (const ref of refs) {
    const key = ref.relativePath.replace(/\\/g, "/");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

async function loadBlocksForAttachment(
  attachmentId: number,
): Promise<LoadedMineruFigureBlocks | null> {
  const cacheDir = getMineruItemDir(attachmentId);
  try {
    const blocks = await loadMineruFigureBlocksFromCacheDir(cacheDir);
    if (!blocks.length) return null;
    return { cacheDir, blocks };
  } catch {
    return null;
  }
}

export async function resolveContextImageInventory(params: {
  contextText: string;
  attachmentId: number;
}): Promise<MineruContextImageInventoryEntry[]> {
  const refs = extractImageRefsFromText(params.contextText);
  const loaded = await loadBlocksForAttachment(params.attachmentId);
  if (!loaded) {
    return refs.map((ref) => ({
      requestedPath: ref.relativePath,
      imagePaths: [ref.relativePath],
    }));
  }

  const out: MineruContextImageInventoryEntry[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const block = findMineruFigureBlockByImagePath(
      ref.relativePath,
      loaded.blocks,
    );
    const imagePaths = block?.imagePaths.length
      ? block.imagePaths
      : [ref.relativePath];
    const key = block?.blockId || imagePaths.join("\n");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      requestedPath: ref.relativePath,
      imagePaths,
      absoluteImagePaths: imagePaths.map((path) =>
        toAbsoluteMineruPath(loaded.cacheDir, path),
      ),
      ...(block
        ? {
            blockId: block.blockId,
            labelHints: block.labelHints,
            captionHints: block.captionHints,
            sectionHeading: block.sectionHeading,
            ambiguous: block.ambiguous,
          }
        : {}),
    });
  }
  return out;
}

export async function expandImageRefsToFigureBlocks(params: {
  contextText: string;
  attachmentId: number;
}): Promise<MineruImageRef[]> {
  const refs = extractImageRefsFromText(params.contextText);
  const loaded = await loadBlocksForAttachment(params.attachmentId);
  if (!loaded) return refs;

  const expanded: MineruImageRef[] = [];
  for (const ref of refs) {
    const block = findMineruFigureBlockByImagePath(
      ref.relativePath,
      loaded.blocks,
    );
    if (!block || block.imagePaths.length <= 1) {
      expanded.push(ref);
      continue;
    }
    for (const imagePath of block.imagePaths) {
      expanded.push({ alt: ref.alt, relativePath: imagePath });
    }
  }
  return dedupeImageRefs(expanded);
}

/**
 * Given context text and the attachment ID, resolve image references
 * to base64 data URLs. Returns at most maxImages results.
 * Skips references that cannot be resolved (missing files).
 */
// ── Resolved image cache (for synchronous lookup by the markdown renderer) ───

const resolvedImageCache = new Map<string, string | null>();

function cacheKey(attachmentId: number, relativePath: string): string {
  return `${attachmentId}:${relativePath}`;
}

/**
 * Given context text and the attachment ID, resolve image references
 * to base64 data URLs. Returns at most maxImages results.
 * Also populates the resolved image cache for sync lookups.
 */
export async function resolveContextImages(params: {
  contextText: string;
  attachmentId: number;
  maxImages?: number;
}): Promise<string[]> {
  const refs = await expandImageRefsToFigureBlocks({
    contextText: params.contextText,
    attachmentId: params.attachmentId,
  });
  const max = params.maxImages ?? MAX_MINERU_CONTEXT_IMAGES;
  const results: string[] = [];
  for (const ref of refs) {
    if (results.length >= max) break;
    const key = cacheKey(params.attachmentId, ref.relativePath);
    try {
      const dataUrl = await readMineruImageAsBase64(
        params.attachmentId,
        ref.relativePath,
      );
      resolvedImageCache.set(key, dataUrl);
      if (dataUrl) results.push(dataUrl);
    } catch {
      resolvedImageCache.set(key, null);
    }
  }
  return results;
}

/**
 * Build a synchronous image resolver for the markdown renderer.
 * Looks up previously resolved images from the cache, and triggers
 * async resolution for cache misses (result available on next render).
 */
export function buildImageResolver(
  attachmentId: number,
): (src: string) => string | null {
  return (src: string): string | null => {
    const key = cacheKey(attachmentId, src.trim());
    const cached = resolvedImageCache.get(key);
    if (cached !== undefined) return cached;
    // Cache miss — trigger async load for next render
    void readMineruImageAsBase64(attachmentId, src.trim()).then(
      (url) => resolvedImageCache.set(key, url),
      () => resolvedImageCache.set(key, null),
    );
    return null;
  };
}
