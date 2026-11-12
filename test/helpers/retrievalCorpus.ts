/**
 * Synthetic retrieval corpus fixtures.
 *
 * The fixtures are invented prose that mirrors the *structure* of real papers
 * (a `##`-heading maths paper and a `#`-heading life-science paper). They exist
 * so the retrieval benchmark can measure section labelling and ranking on a
 * stable, offline corpus. No real paper text is stored in this repository.
 */
import fs from "node:fs";
import path from "node:path";
import { writeMineruCacheFiles } from "../../src/services/mineru/mineruCache";
import {
  buildPaperRetrievalCandidates,
  ensurePDFTextCached,
} from "../../src/services/paperContent/pdfContext";
import { pdfTextCache } from "../../src/services/paperContent/contextCache";
import { buildRetrievalQueryPlan } from "../../src/services/retrieval/retrievalQueryPlan";
import type { PaperContextRef } from "../../src/modules/contextPanel/types";
import type {
  PdfContext,
  RetrievalExplanation,
} from "../../src/services/paperContent/types";

const encoder = new TextEncoder();

/**
 * Fixture "PDF text" per attachment id. Zotero's full-text cache file and
 * PDFWorker both serve it, so a test can tell the two sources apart only by
 * `sourceType` and `pdfWorkerCalls`. Empty by default: existing suites keep
 * falling through to an empty context.
 */
const fulltextCacheText = new Map<number, string>();
/** Attachment ids passed to the stubbed `Zotero.PDFWorker.getFullText`. */
const pdfWorkerCalls: number[] = [];
const FULLTEXT_CACHE_DIR = "/tmp/zotero-fulltext-cache";

function fulltextCacheIdForPath(filePath: string): number | null {
  const match = /^\/tmp\/zotero-fulltext-cache\/(\d+)\.cache$/.exec(filePath);
  return match ? Number(match[1]) : null;
}

export type MemoryIO = {
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
  writes: string[];
};

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/\/+$/g, "") || "/";
}

function parentPath(filePath: string): string {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function addDir(dirs: Set<string>, dirPath: string): void {
  let current = normalizePath(dirPath);
  const ancestors: string[] = [];
  while (current && current !== "/") {
    ancestors.push(current);
    current = parentPath(current);
  }
  ancestors.push("/");
  for (const dir of ancestors.reverse()) dirs.add(dir);
}

export function setupMemoryIO(): MemoryIO {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const writes: string[] = [];
  addDir(dirs, "/tmp/zotero");

  const io = {
    exists: async (filePath: string) => {
      const normalized = normalizePath(filePath);
      return files.has(normalized) || dirs.has(normalized);
    },
    read: async (filePath: string) => {
      const normalized = normalizePath(filePath);
      const data = files.get(normalized);
      if (!data) {
        const fulltextId = fulltextCacheIdForPath(normalized);
        const text =
          fulltextId === null ? undefined : fulltextCacheText.get(fulltextId);
        if (text !== undefined) return encoder.encode(text);
        throw new Error(`Missing file: ${filePath}`);
      }
      return data;
    },
    makeDirectory: async (filePath: string) => {
      addDir(dirs, filePath);
    },
    write: async (filePath: string, data: Uint8Array) => {
      const normalized = normalizePath(filePath);
      addDir(dirs, parentPath(normalized));
      files.set(normalized, data);
      writes.push(normalized);
    },
    remove: async (filePath: string) => {
      const normalized = normalizePath(filePath);
      for (const key of [...files.keys()]) {
        if (key === normalized || key.startsWith(`${normalized}/`)) {
          files.delete(key);
        }
      }
      for (const key of [...dirs.keys()]) {
        if (key === normalized || key.startsWith(`${normalized}/`)) {
          dirs.delete(key);
        }
      }
    },
    getChildren: async (filePath: string) => {
      const normalized = normalizePath(filePath);
      const prefix = normalized === "/" ? "/" : `${normalized}/`;
      const children = new Set<string>();
      for (const key of [...dirs, ...files.keys()]) {
        if (!key.startsWith(prefix) || key === normalized) continue;
        const rest = key.slice(prefix.length);
        const childName = rest.split("/")[0];
        if (childName) children.add(`${prefix}${childName}`);
      }
      return [...children];
    },
  };

  (globalThis as unknown as { IOUtils: typeof io }).IOUtils = io;
  return { files, dirs, writes };
}

export function setupZoteroGlobals(parentTitle = "Mock MinerU Paper"): void {
  const parentItem = {
    getField: (field: string) => (field === "title" ? parentTitle : ""),
  };
  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    DataDirectory: { dir: "/tmp/zotero" },
    Profile: { dir: "/tmp/profile" },
    Prefs: {
      get: (key: string) => (key.endsWith(".mineruEnabled") ? true : undefined),
      set: () => {},
    },
    Items: {
      get: (id: number) => (id === 100 ? parentItem : null),
    },
    Fulltext: {
      getItemCacheFile: (item: { id: number }) => ({
        exists: () => fulltextCacheText.has(item.id),
        path: `${FULLTEXT_CACHE_DIR}/${item.id}.cache`,
      }),
    },
    PDFWorker: {
      getFullText: async (id: number) => {
        pdfWorkerCalls.push(id);
        return { text: fulltextCacheText.get(id) || "" };
      },
    },
  };
  (globalThis as unknown as { ztoolkit: unknown }).ztoolkit = {
    log: () => {},
  };
}

type StubbedGlobalName = "Zotero" | "IOUtils" | "ztoolkit";

const STUBBED_GLOBAL_NAMES: StubbedGlobalName[] = [
  "Zotero",
  "IOUtils",
  "ztoolkit",
];

export type TestGlobalSnapshot = {
  present: Partial<Record<StubbedGlobalName, unknown>>;
  absent: StubbedGlobalName[];
  /** Shared with the stubbed Zotero globals; see {@link setupZoteroGlobals}. */
  fulltextCacheText: Map<number, string>;
  pdfWorkerCalls: number[];
};

/** Record the globals this helper replaces so a suite can put them back. */
export function snapshotTestGlobals(): TestGlobalSnapshot {
  const scope = globalThis as unknown as Record<string, unknown>;
  fulltextCacheText.clear();
  pdfWorkerCalls.length = 0;
  const snapshot: TestGlobalSnapshot = {
    present: {},
    absent: [],
    fulltextCacheText,
    pdfWorkerCalls,
  };
  for (const name of STUBBED_GLOBAL_NAMES) {
    if (name in scope) snapshot.present[name] = scope[name];
    else snapshot.absent.push(name);
  }
  return snapshot;
}

/**
 * Restore the globals recorded by {@link snapshotTestGlobals} and drop the
 * cached fixture contexts, so corpus suites cannot leak state into the rest of
 * the unit suite.
 */
export function restoreTestGlobals(snapshot: TestGlobalSnapshot): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(snapshot.present)) {
    scope[name] = value;
  }
  for (const name of snapshot.absent) {
    delete scope[name];
  }
  fulltextCacheText.clear();
  pdfWorkerCalls.length = 0;
  pdfTextCache.clear();
}

export function mockPdfAttachment(id: number): Zotero.Item {
  return {
    id,
    parentID: 100,
    attachmentContentType: "application/pdf",
    isAttachment: () => true,
    getField: (field: string) => (field === "title" ? "PDF" : ""),
  } as unknown as Zotero.Item;
}

export type CorpusName = "mathDoubleHash" | "bioSingleHash";

export function loadRetrievalCorpusFixture(name: CorpusName) {
  const dir = path.join(__dirname, "..", "fixtures", "retrievalCorpus");
  return {
    md: fs.readFileSync(path.join(dir, `${name}.md`), "utf8"),
    contentList: JSON.parse(
      fs.readFileSync(path.join(dir, `${name}.contentList.json`), "utf8"),
    ) as unknown[],
  };
}

export async function buildFixturePdfContext(
  name: CorpusName,
  attachmentId: number,
): Promise<PdfContext> {
  setupMemoryIO();
  setupZoteroGlobals();
  pdfTextCache.clear();
  const { md, contentList } = loadRetrievalCorpusFixture(name);
  await writeMineruCacheFiles(attachmentId, md, [
    { relativePath: "full.md", data: encoder.encode(md) },
    {
      relativePath: "content_list.json",
      data: encoder.encode(JSON.stringify(contentList)),
    },
  ]);
  await ensurePDFTextCached(mockPdfAttachment(attachmentId));
  const context = pdfTextCache.get(attachmentId);
  if (!context) throw new Error("fixture context not built");
  return context;
}

/**
 * MinerU markdown with one short paragraph under each heading, as MinerU
 * writes it: every heading at `#`, whatever its depth in the paper. Each
 * heading's text fits one chunk, so chunk i is heading i. `extra` adds words
 * under the headings it names.
 */
export function headingSequenceMarkdown(
  headings: string[],
  extra: Record<string, string> = {},
): string {
  return `${headings
    .map(
      (heading, index) =>
        `# ${heading}\n\nPassage ${index} under this heading reports its part of the work in plain words.${extra[heading] ? ` ${extra[heading]}` : ""}`,
    )
    .join("\n\n")}\n`;
}

/** The PdfContext the plugin builds from a MinerU cache holding `markdown`. */
export async function buildMarkdownPdfContext(
  markdown: string,
  attachmentId: number,
): Promise<PdfContext> {
  setupMemoryIO();
  setupZoteroGlobals();
  pdfTextCache.clear();
  await writeMineruCacheFiles(attachmentId, markdown, [
    { relativePath: "full.md", data: encoder.encode(markdown) },
  ]);
  await ensurePDFTextCached(mockPdfAttachment(attachmentId));
  const context = pdfTextCache.get(attachmentId);
  if (!context) throw new Error("markdown context not built");
  return context;
}

// ── Structure and ranking metrics ────────────────────────────────────────────

export type CorpusMetrics = {
  /**
   * Share of body chunks that carry any `sectionLabel`. "Body chunks" are the
   * chunks that start after the opening chunk, which holds the title block.
   */
  labelCoverage: number;
  /**
   * Share of body chunks whose `sectionLabel` names the heading that actually
   * encloses the chunk, compared after dropping enumerators and case. This is
   * the number that exposes sticky or missing section labels; it needs the
   * source markdown and is `null` without it.
   */
  labelAccuracy: number | null;
  /** Share of self-retrieval probes whose own chunk ranks first. */
  selfRetrievalTop1: number;
  /** Share of self-retrieval probes whose own chunk ranks in the top three. */
  selfRetrievalTop3: number;
  /** Chunk indexes returned, in rank order, for a query with no lexical match. */
  nonsenseQueryChunkIndexes: number[];
  /** Self-retrieval probes whose rank-1 chunk is a Conclusion-kind chunk. */
  conclusionFirstCount: number;
  /** Number of self-retrieval probes that could be built. */
  probeCount: number;
  /** Number of chunks in the context. */
  chunkCount: number;
};

/** Query that matches no term in any paper; exposes the tie-break order. */
export const NONSENSE_RETRIEVAL_QUERY = "zxqv wploq mmzk";

/**
 * Pick the middle natural-language sentence of a chunk: 60–240 characters, no
 * maths, not a heading. Returns undefined when a chunk has no such sentence
 * (equation-only chunks and reference lists often do not).
 */
export function pickProbeSentence(chunk: string): string | undefined {
  const sentences = (
    chunk.replace(/\n+/g, " ").match(/[^.!?]{60,240}[.!?]/g) || []
  )
    .map((sentence) => sentence.trim())
    .filter(
      (sentence) =>
        !sentence.includes("$") &&
        !sentence.startsWith("#") &&
        /[a-z]{4}/.test(sentence),
    );
  if (!sentences.length) return undefined;
  return sentences[Math.floor(sentences.length / 2)];
}

/** Markdown headings of a document, with their character offsets. */
export function listMarkdownHeadings(
  markdown: string,
): { offset: number; level: number; heading: string }[] {
  const pattern = /^(#{1,3})\s+(.+)$/gm;
  const headings: { offset: number; level: number; heading: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    headings.push({
      offset: match.index,
      level: match[1].length,
      heading: match[2].trim(),
    });
  }
  return headings;
}

/** Drop enumerators ("2.1 ", "IV. ", "a) ") and case so labels can be compared. */
function normalizeHeadingForComparison(value: string): string {
  return value
    .trim()
    .replace(/^(?:\d+(?:\.\d+)*\.?|[ivxlcdm]+\.|[a-z]\))\s+/i, "")
    .replace(/[\s:.–—-]+$/, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

export type RankedChunk = {
  rank: number;
  chunkIndex: number;
  chunkKind?: string;
  sectionLabel?: string;
  sectionPath?: string;
  why?: RetrievalExplanation;
  evidenceScore: number;
  hybridScore: number;
  bm25Score: number;
  embeddingScore: number;
  matchedQueryVariant?: string;
  sourceStart?: number;
  sourceEnd?: number;
};

/** Run the shipped retrieval path for one query and return the ranked chunks. */
export async function rankChunksForQuery(params: {
  paperRef: PaperContextRef;
  ctx: PdfContext;
  query: string;
  variants?: string[];
  topK: number;
}): Promise<RankedChunk[]> {
  const plan = buildRetrievalQueryPlan({
    query: params.query,
    ...(params.variants?.length ? { queryVariants: params.variants } : {}),
  });
  const candidates = await buildPaperRetrievalCandidates(
    params.paperRef,
    params.ctx,
    params.query,
    { queryPlan: plan },
    { topK: params.topK, mode: "evidence", queryPlan: plan },
  );
  return candidates.map((candidate, index) => ({
    rank: index + 1,
    chunkIndex: candidate.chunkIndex,
    chunkKind: candidate.chunkKind,
    sectionLabel: candidate.sectionLabel,
    sectionPath: candidate.sectionPath,
    why: candidate.why,
    evidenceScore: candidate.evidenceScore,
    hybridScore: candidate.hybridScore,
    bm25Score: candidate.bm25Score,
    embeddingScore: candidate.embeddingScore,
    matchedQueryVariant: candidate.matchedQueryVariant,
    sourceStart: candidate.sourceStart,
    sourceEnd: candidate.sourceEnd,
  }));
}

/**
 * Locate a chunk in the source markdown and report the heading that encloses
 * it. Falls back to the recorded `sourceStart` when the text cannot be found
 * (HTML tables are rewritten after chunking, so exact matches can fail).
 */
export function enclosingHeadingForChunk(params: {
  chunkText: string;
  sourceStart?: number;
  markdown: string;
  headings: ReturnType<typeof listMarkdownHeadings>;
}): string | undefined {
  const probe = params.chunkText.slice(0, 120);
  const located = probe ? params.markdown.indexOf(probe) : -1;
  const offset = located >= 0 ? located : (params.sourceStart ?? -1);
  if (offset < 0) return undefined;
  let current: string | undefined;
  for (const heading of params.headings) {
    if (heading.offset <= offset) current = heading.heading;
    else break;
  }
  return current;
}

/**
 * Measure how well the shipped retrieval path distinguishes the chunks of one
 * document: section-label coverage and accuracy, self-retrieval accuracy, the
 * tie-break order for a query nothing matches, and how often a Conclusion
 * chunk wins.
 */
export async function measureCorpus(
  ctx: PdfContext,
  paperRef: PaperContextRef,
  options: { fullMarkdown?: string } = {},
): Promise<CorpusMetrics> {
  const firstChunkLength = ctx.chunks[0]?.length ?? 0;
  const bodyMeta = ctx.chunkMeta.filter(
    (meta) => (meta.sourceStart ?? 0) >= firstChunkLength,
  );
  const labelCoverage = bodyMeta.length
    ? bodyMeta.filter((meta) => Boolean(meta.sectionLabel)).length /
      bodyMeta.length
    : 0;

  let labelAccuracy: number | null = null;
  const fullMarkdown = options.fullMarkdown;
  if (fullMarkdown && bodyMeta.length) {
    const headings = listMarkdownHeadings(fullMarkdown);
    const correct = bodyMeta.filter((meta) => {
      if (!meta.sectionLabel) return false;
      const enclosing = enclosingHeadingForChunk({
        chunkText: meta.text,
        sourceStart: meta.sourceStart,
        markdown: fullMarkdown,
        headings,
      });
      if (!enclosing) return false;
      return (
        normalizeHeadingForComparison(enclosing) ===
        normalizeHeadingForComparison(meta.sectionLabel)
      );
    }).length;
    labelAccuracy = correct / bodyMeta.length;
  }

  const probes: { chunkIndex: number; query: string }[] = [];
  for (const [chunkIndex, chunk] of ctx.chunks.entries()) {
    const query = pickProbeSentence(chunk);
    if (query) probes.push({ chunkIndex, query });
  }

  let top1 = 0;
  let top3 = 0;
  let conclusionFirstCount = 0;
  for (const probe of probes) {
    const ranked = await rankChunksForQuery({
      paperRef,
      ctx,
      query: probe.query,
      topK: 99,
    });
    const rank =
      ranked.findIndex((row) => row.chunkIndex === probe.chunkIndex) + 1;
    if (rank === 1) top1 += 1;
    if (rank >= 1 && rank <= 3) top3 += 1;
    if (ranked[0]?.chunkKind === "conclusion") conclusionFirstCount += 1;
  }

  const nonsense = await rankChunksForQuery({
    paperRef,
    ctx,
    query: NONSENSE_RETRIEVAL_QUERY,
    topK: 8,
  });

  return {
    labelCoverage,
    labelAccuracy,
    selfRetrievalTop1: probes.length ? top1 / probes.length : 0,
    selfRetrievalTop3: probes.length ? top3 / probes.length : 0,
    nonsenseQueryChunkIndexes: nonsense.map((row) => row.chunkIndex),
    conclusionFirstCount,
    probeCount: probes.length,
    chunkCount: ctx.chunks.length,
  };
}
