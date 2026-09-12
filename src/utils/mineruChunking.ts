export const MINERU_PAGE_CHUNK_SIZE = 200;

export type MineruPageRange = {
  index: number;
  startPage: number;
  endPage: number;
  total: number;
};

export type MineruChunkFile = {
  relativePath: string;
  data: Uint8Array;
};

export type MineruChunkResult = {
  mdContent: string;
  files: MineruChunkFile[];
};

export type MineruChunk = {
  range: MineruPageRange;
  result: MineruChunkResult;
};

export function buildMineruExecutablePathCandidates(
  pathValue: string,
  executableName: string,
  isWindows: boolean,
): string[] {
  const separator = isWindows ? ";" : ":";
  const pathSeparator = isWindows ? "\\" : "/";
  const filename =
    isWindows && !executableName.toLowerCase().endsWith(".exe")
      ? `${executableName}.exe`
      : executableName;

  return pathValue
    .split(separator)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .map(
      (directory) =>
        `${directory.replace(/[\\/]+$/g, "")}${pathSeparator}${filename}`,
    );
}

export function buildMineruDumpDataArguments(
  pdfPath: string,
  outputPath: string,
): string[] {
  return [pdfPath, "dump_data", "output", outputPath];
}

export function selectMineruPageCount(
  detectedCount: number | null,
  pdftkCount: number | null,
): number | null {
  return pdftkCount || detectedCount;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isKnownCacheFile(path: string, basename: string): boolean {
  const normalized = normalizePath(path).toLowerCase();
  if (basename === "content_list.json") {
    const filename = normalized.split("/").pop() || "";
    return filename === basename || filename.endsWith(`_${basename}`);
  }
  return normalized === basename || normalized.endsWith(`/${basename}`);
}

function getMarkdownDirectory(files: MineruChunkFile[]): string[] {
  const markdownPath =
    files
      .map((file) => normalizePath(file.relativePath))
      .find((path) => /(^|\/)full\.md$/i.test(path)) ??
    files
      .map((file) => normalizePath(file.relativePath))
      .find((path) => /\.md$/i.test(path));
  return markdownPath ? markdownPath.split("/").slice(0, -1) : [];
}

function stripMineruArchiveContainer(
  sourcePath: string,
  markdownDirectory: string[],
): string {
  const parts = normalizePath(sourcePath).split("/").filter(Boolean);
  let stripped = parts;
  if (
    markdownDirectory.length &&
    markdownDirectory.every((part, index) => parts[index] === part)
  ) {
    stripped = parts.slice(markdownDirectory.length);
  } else if (markdownDirectory.length && parts[0] === markdownDirectory[0]) {
    stripped = parts.slice(1);
  }
  if (stripped[0]?.toLowerCase() === "auto" && stripped.length > 1) {
    stripped = stripped.slice(1);
  }
  return stripped.join("/");
}

function buildAssetPathMap(
  files: MineruChunkFile[],
  chunkIndex: number,
): Map<string, string> {
  const pathMap = new Map<string, string>();
  // MinerU's cache writer deliberately keeps durable source images below the
  // top-level images directory. Keep chunk assets there so normal cache
  // finalization does not prune them as unknown artifacts.
  const prefix = `images/chunk-${String(chunkIndex + 1).padStart(3, "0")}`;
  const markdownDirectory = getMarkdownDirectory(files);

  for (const file of files) {
    const sourcePath = normalizePath(file.relativePath);
    if (
      isKnownCacheFile(sourcePath, "full.md") ||
      isKnownCacheFile(sourcePath, "content_list.json") ||
      isKnownCacheFile(sourcePath, "manifest.json")
    ) {
      continue;
    }

    const strippedPath = stripMineruArchiveContainer(
      sourcePath,
      markdownDirectory,
    );
    const targetPath = `${prefix}/${strippedPath}`;
    pathMap.set(sourcePath, targetPath);
    pathMap.set(`./${sourcePath}`, targetPath);
    pathMap.set(strippedPath, targetPath);
    pathMap.set(`./${strippedPath}`, targetPath);
  }

  return pathMap;
}

function rewriteMarkdownPathRefs(
  text: string,
  pathMap: Map<string, string>,
): string {
  const rewriteTarget = (target: string): string => {
    const trimmed = target.trim();
    const unwrapped =
      trimmed.startsWith("<") && trimmed.endsWith(">")
        ? trimmed.slice(1, -1)
        : trimmed;
    const mapped = pathMap.get(normalizePath(unwrapped));
    if (!mapped) return target;
    return trimmed.startsWith("<") && trimmed.endsWith(">")
      ? `<${mapped}>`
      : mapped;
  };

  return text
    .replace(
      /(!?\[[^\]]*]\()([^)]+)(\))/g,
      (_match, prefix, target, suffix) =>
        `${prefix}${rewriteTarget(String(target))}${suffix}`,
    )
    .replace(
      /(<img\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi,
      (_match, prefix, target, suffix) =>
        `${prefix}${rewriteTarget(String(target))}${suffix}`,
    );
}

function rewriteContentListPaths(
  value: unknown,
  pathMap: Map<string, string>,
  pageOffset: number,
  parentKey = "",
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      rewriteContentListPaths(item, pathMap, pageOffset, parentKey),
    );
  }

  if (!value || typeof value !== "object") {
    if (typeof value === "number" && parentKey === "page_idx") {
      return value + pageOffset;
    }
    if (typeof value === "string" && /path$/i.test(parentKey)) {
      return pathMap.get(normalizePath(value)) || value;
    }
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      rewriteContentListPaths(child, pathMap, pageOffset, key),
    ]),
  );
}

function readContentList(file: MineruChunkFile | undefined): unknown[] {
  if (!file) throw new Error("MinerU chunk has no content list");
  try {
    const parsed = JSON.parse(new TextDecoder().decode(file.data)) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (Array.isArray(record.content_list)) return record.content_list;
      if (Array.isArray(record.data)) return record.data;
    }
  } catch (error) {
    throw new Error("MinerU chunk has no valid content list", {
      cause: error,
    });
  }
  throw new Error("MinerU chunk has no valid content list");
}

function validateContentListPageIndexes(
  value: unknown,
  sourcePageCount: number,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      validateContentListPageIndexes(item, sourcePageCount);
    }
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (
      key === "page_idx" &&
      (typeof child !== "number" ||
        !Number.isInteger(child) ||
        child < 0 ||
        child >= sourcePageCount)
    ) {
      throw new Error("MinerU content-list page_idx is outside its chunk");
    }
    validateContentListPageIndexes(child, sourcePageCount);
  }
}

function validateContentListAssetPaths(
  value: unknown,
  pathMap: Map<string, string>,
  parentKey = "",
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      validateContentListAssetPaths(item, pathMap, parentKey);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    if (
      typeof value === "string" &&
      /path$/i.test(parentKey) &&
      value.trim() &&
      !/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(value.trim()) &&
      !pathMap.has(normalizePath(value))
    ) {
      throw new Error(`MinerU chunk is missing referenced asset: ${value}`);
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    validateContentListAssetPaths(child, pathMap, key);
  }
}

export function buildMineruPageRanges(
  pageCount: number,
  chunkSize = MINERU_PAGE_CHUNK_SIZE,
): MineruPageRange[] {
  if (!Number.isInteger(pageCount) || pageCount <= 0) {
    throw new Error("MinerU page count must be a positive integer");
  }
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("MinerU chunk size must be a positive integer");
  }

  const ranges: MineruPageRange[] = [];
  for (let startPage = 1, index = 0; startPage <= pageCount; ) {
    const endPage = Math.min(startPage + chunkSize - 1, pageCount);
    ranges.push({ index, startPage, endPage, total: pageCount });
    startPage = endPage + 1;
    index += 1;
  }
  return ranges;
}

export function extractMineruPageCountFromDumpData(
  output: string,
): number | null {
  const counts = [...output.matchAll(/^\s*NumberOfPages:\s*(\d+)\s*$/gim)]
    .map((match) => Number(match[1]))
    .filter((count) => Number.isInteger(count) && count > 0);
  return counts.length ? Math.max(...counts) : null;
}

export function validateMineruSplitPageCount(
  actualPageCount: number | null,
  range: Pick<MineruPageRange, "startPage" | "endPage">,
): void {
  const expectedPageCount = range.endPage - range.startPage + 1;
  if (actualPageCount !== expectedPageCount) {
    throw new Error(
      `MinerU split expected ${expectedPageCount} pages but found ${
        actualPageCount ?? "an unreadable page count"
      }`,
    );
  }
}

function validateMineruChunkRanges(chunks: MineruChunk[]): void {
  const total = chunks[0].range.total;
  let expectedStartPage = 1;

  for (const [position, chunk] of chunks.entries()) {
    const { index, startPage, endPage } = chunk.range;
    if (index !== position) {
      throw new Error("MinerU chunk indexes must be consecutive");
    }
    if (chunk.range.total !== total) {
      throw new Error("MinerU chunks must use the same total page count");
    }
    if (startPage !== expectedStartPage || endPage < startPage) {
      throw new Error("MinerU chunk page ranges must be contiguous");
    }
    expectedStartPage = endPage + 1;
  }

  if (expectedStartPage !== total + 1) {
    throw new Error("MinerU chunk page ranges must cover the entire PDF");
  }
}

export function mergeMineruChunkResults(
  chunks: MineruChunk[],
): MineruChunkResult {
  if (!chunks.length) {
    throw new Error("Cannot merge an empty MinerU chunk result");
  }
  validateMineruChunkRanges(chunks);

  const markdownParts: string[] = [];
  const mergedFiles: MineruChunkFile[] = [];
  const mergedContentList: unknown[] = [];

  for (const chunk of chunks) {
    const pathMap = buildAssetPathMap(chunk.result.files, chunk.range.index);
    const contentListFile = chunk.result.files.find((file) =>
      isKnownCacheFile(file.relativePath, "content_list.json"),
    );
    const contentList = readContentList(contentListFile);
    validateContentListPageIndexes(
      contentList,
      chunk.range.endPage - chunk.range.startPage + 1,
    );
    validateContentListAssetPaths(contentList, pathMap);
    mergedContentList.push(
      ...contentList.map((item) =>
        rewriteContentListPaths(item, pathMap, chunk.range.startPage - 1),
      ),
    );

    markdownParts.push(
      `<!-- MinerU pages ${chunk.range.startPage}-${chunk.range.endPage} -->\n\n${rewriteMarkdownPathRefs(chunk.result.mdContent.trim(), pathMap)}`,
    );

    for (const file of chunk.result.files) {
      const sourcePath = normalizePath(file.relativePath);
      if (
        isKnownCacheFile(sourcePath, "full.md") ||
        isKnownCacheFile(sourcePath, "content_list.json") ||
        isKnownCacheFile(sourcePath, "manifest.json")
      ) {
        continue;
      }
      mergedFiles.push({
        relativePath: pathMap.get(sourcePath) || sourcePath,
        data: file.data,
      });
    }
  }

  mergedFiles.push({
    relativePath: "content_list.json",
    data: new TextEncoder().encode(JSON.stringify(mergedContentList)),
  });

  return {
    mdContent: markdownParts.join("\n\n"),
    files: mergedFiles,
  };
}
