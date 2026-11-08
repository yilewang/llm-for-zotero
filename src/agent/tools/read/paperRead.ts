import {
  formatPaperDisplayLabel,
  type PaperDisplayMetadata,
} from "../../../shared/paperDisplayLabels";
import type {
  AgentToolContext,
  AgentToolDefinition,
  AgentToolArtifact,
  AgentToolResult,
  AgentToolGuidance,
} from "../../types";
import type { QuoteCitation } from "../../../shared/types";
import { parseDocumentReferences } from "../../../shared/documentReferences";
import type { PdfService } from "../../services/pdfService";
import type { PdfPageService } from "../../services/pdfPageService";
import { parsePageSelectionValue } from "../../services/pdfPageService";
import type { RetrievalService } from "../../services/retrievalService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import { joinLocalPath } from "../../../utils/localPath";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../../services/paperContent/paperAttribution";
import {
  ensureManifest,
  stripMineruSourceImageEmbedsFromMarkdown,
} from "../../../services/mineru/mineruCache";
import type { MineruManifest } from "../../../services/mineru/mineruCache";
import {
  buildBookmarkOutline,
  buildDocumentOutline,
  sectionIdForIndex,
} from "../../../services/paperContent/pdfContext";
import type {
  DocumentOutline,
  PdfContext,
} from "../../../services/paperContent/types";
import {
  formatDocumentMap,
  formatSectionPages,
} from "../../../services/paperContent/documentMap";
import {
  decideSectionRead,
  embeddedOutline,
  formatPageMapLine,
  outlineLevel,
  withDescendants,
} from "./documentSectionReads";
import { estimateTextTokens } from "../../../utils/modelInputCap";
import { tokenizeRetrievalText } from "../../../services/retrieval/retrievalTokenizer";
import {
  buildQuoteCitation,
  mergeQuoteCitations,
} from "../../../services/quotes/quoteCitations";
import {
  QUOTE_ANCHOR_MAX_CHARS,
  QUOTE_ANCHOR_MIN_CHARS,
} from "../../../services/quotes/claimAnchoring";
import {
  splitBodyBlocks,
  splitSentences,
} from "../../../services/quotes/sentenceSplit";
import { fail, normalizePositiveInt, ok, validateObject } from "../shared";
import {
  PAPER_TARGET_SELECTOR_SCHEMA,
  buildCaptureFollowupMessage,
  normalizeExplicitTargetSyntax,
  describeNoDefaultPaperTarget,
  resolveDefaultTargets,
} from "./pdfToolUtils";
import type { PdfTarget } from "./pdfToolUtils";
import { createPdfPageRenderer } from "./pdfPageRenderer";
import {
  readDocumentsExhaustively,
  resolveFullReadBatchTokenBudget,
  type ExhaustiveBatchAnalyzer,
  type ExhaustiveSourceChunk,
  type FullReadCoverageReceipt,
  type FullReadPaperResult,
} from "../../../shared/exhaustiveDocumentReader";
import { getTurnPapersWithRoles } from "../../context/requestTurnPaperScope";
import { createCodexAppServerExhaustiveReaderSession } from "../../../codexAppServer/exhaustiveReader";
import { createClaudeBridgeExhaustiveReaderSession } from "../../../claudeCode/exhaustiveReader";
import { createClaudeBridgeCompletion } from "../../../claudeCode/structuredCompletion";
import { createCodexResponsesCompletion } from "../../../codexAppServer/readerCompletion";
import {
  ReaderCompletionError,
  limitReaderCompletion,
} from "../../../shared/readerCompletion";
import { hostReaderCallLimiter } from "../../reader/readerLimiter";
import {
  mapReaderCompletion,
  type ReaderAdapterFactories,
  type ReaderChoice,
} from "../../reader/resolveReader";
import {
  readerChoiceFromSelection,
  type ReaderEntryLookup,
} from "../../reader/readerChoiceFromSelection";
import {
  resolveReaderWithFallback,
  type ReaderFallbackNote,
} from "../../reader/readerFallback";
import { createReaderBatchAnalyzer } from "../../reader/readerBatchAnalyzer";
import type { UtilityLLMParams } from "../../../utils/utilityLLM";
import { createZoteroMetadataResolver } from "../../../services/zoteroMetadata/resolver";
import { projectPaperMetadata } from "../../../services/zoteroMetadata/projections";
import type {
  ProjectedPaperMetadata,
  ZoteroMetadataResolver,
} from "../../../services/zoteroMetadata/types";
import { resolveOutputReserve } from "../../../utils/outputTokenPolicy";
import { resolveModelInputTokenLimit } from "../../../utils/modelInputCap";
import { resolveAdaptiveReadingBudget } from "../../context/readingBudget";
import {
  READ_SCOPE_TEXT_SOURCES,
  SECTIONS_NOT_FOUND_RULE,
  SectionPickError,
  describeNotFound,
  isFullReadScope,
  renderCoveredParts,
  shownPartName,
  userPartNames,
  type CoveredPart,
  type ReadScope,
  type ScopedNotFound,
  type ScopedPaperText,
} from "../../digests/readScope";
import {
  buildChunkOutline,
  createSectionPicker,
  isPlainAbstractName,
  outlineFirstLine,
  pickedBlockCovered,
  readPickedSections,
  type PickedSections,
  type SectionPicker,
} from "../../digests/sectionPicker";
import {
  readShare,
  withoutDigestQuoteCitations,
} from "../../digests/paperDigestWorker";
import {
  isAbstractSectionName,
  LEAD_ABSTRACT_LABEL,
  readScopeSectionKind,
  selectLeadAbstract,
  selectMineruScopeSections,
  selectPageScope,
  chooseMineruScopeSections,
  chunkIndexesForMineruSections,
  chunkIndexesForText,
  pdfChunkIndexesForSection,
  selectPdfChunkScopeSections,
  type MineruScopeChoice,
  type ScopePageText,
} from "../../digests/readScopeText";

type PaperReadMode =
  | "overview"
  | "outline"
  | "targeted"
  | "full"
  | "figures"
  | "visual"
  | "capture";

type PaperReadInput = {
  mode: PaperReadMode;
  target?: PdfTarget;
  targets?: PdfTarget[];
  query?: string;
  figureLabels?: string[];
  includeSupplementary?: boolean;
  queryVariants?: string[];
  sections?: string[];
  sectionIds?: string[];
  /** Outline mode: the section whose sections to list. */
  sectionId?: string;
  /** With sectionIds and no query: read a section with its sections. */
  whole?: boolean;
  pages?: number[];
  neighborPages?: number;
  maxChars?: number;
  topK?: number;
  visualInput?: unknown;
};

/** analyze-figures' failure rule, carried on every failed figures result. */
export const FIGURE_CROP_FAILURE_GUIDANCE =
  "No figure crop was extracted: answer from captions and surrounding paper text only, without page screenshots, source images, or image placeholders.";

export type PaperReadFigureExtractionResult = {
  mode: "figures";
  status: "ok" | "mineru_required" | "no_figures" | "error";
  query?: string;
  guidance?: string;
  expectedFigures?: Array<Record<string, unknown>>;
  missingFigures?: Array<Record<string, unknown>>;
  figures?: Array<Record<string, unknown>>;
  artifacts?: AgentToolArtifact[];
  warnings?: string[];
};

export type PaperReadFullResult = {
  mode: "full";
  status: "complete" | "partial" | "unreadable";
  papers: (Omit<FullReadPaperResult, "exactEvidence"> & {
    /** Each chunk with the citation id the host minted from its text. */
    exactEvidence: (ExhaustiveSourceChunk & { quoteCitationId?: string })[];
    displayLabel: string;
  })[];
  /** The records of those ids; the model sees the ids only. */
  quoteCitations: QuoteCitation[];
  coverageReceipt: FullReadCoverageReceipt;
  synthesisContext: string;
  warnings: string[];
  /** The chosen reader failed for a configuration reason; main model read. */
  readerFallback?: ReaderFallbackNote;
  /** The model that read, when the user picked a reader model. */
  reader?: { route: string; model: string };
};

/** Test seams for the reader a full read uses. */
export type PaperReadReaderOptions = {
  /** An explicit reader; by default the request's `readerSelection`. */
  readerChoice?: (context: AgentToolContext) => ReaderChoice | undefined;
  /** Where a picked API reader's model entry is looked up. */
  lookupReaderEntry?: ReaderEntryLookup;
  readerFactories?: ReaderAdapterFactories;
  llmCall?: UtilityLLMParams["llmCall"];
};

/**
 * The reader that picks a paper_read call's named sections
 * (`sectionPicker.ts`): the one full mode reads with (the picked reader,
 * else the runtime's own tool-free route), under the host's one reader
 * limit, for the user's request. With no reader the picker fails, and the
 * call returns each paper's outline instead. `fallbackNote` names the main
 * model picking for a chosen reader that failed, as full mode names it.
 */
function paperReadSectionPicker(
  context: AgentToolContext,
  readerOptions: PaperReadReaderOptions,
  query?: string,
): {
  picker: SectionPicker;
  fallbackNote: () => ReaderFallbackNote | undefined;
} {
  const request = context.request;
  const { resolution, fallbackNote } = resolveReaderWithFallback({
    request,
    choice: readerOptions.readerChoice
      ? readerOptions.readerChoice(context)
      : readerChoiceFromSelection({
          selection: request.readerSelection,
          request,
          lookupEntry: readerOptions.lookupReaderEntry,
        }),
    llmCall: readerOptions.llmCall,
    factories: readerOptions.readerFactories,
  });
  if (!resolution.ok) {
    const detail = resolution.detail;
    return {
      picker: async () => {
        throw new SectionPickError(
          `No reader model can choose the named sections: ${detail}`,
          new ReaderCompletionError({ reason: "not_configured", detail }),
        );
      },
      fallbackNote,
    };
  }
  const question = `${request.userText || ""}`.trim() || query?.trim();
  return {
    picker: createSectionPicker({
      reader: mapReaderCompletion(resolution.reader, (complete) =>
        limitReaderCompletion(complete, hostReaderCallLimiter),
      ),
      ...(question ? { question } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    }),
    fallbackNote,
  };
}

/**
 * `paperReadSectionPicker`, resolved at the first pick: a call whose names
 * need no pick (the abstract, from the Zotero field) resolves no reader and
 * reports no fallback.
 */
function lazySectionPicker(
  context: AgentToolContext,
  readerOptions: PaperReadReaderOptions,
  query?: string,
): ReturnType<typeof paperReadSectionPicker> {
  let made: ReturnType<typeof paperReadSectionPicker> | undefined;
  const get = () =>
    (made ||= paperReadSectionPicker(context, readerOptions, query));
  return {
    picker: (request) => get().picker(request),
    fallbackNote: () => made?.fallbackNote(),
  };
}

/**
 * What a failed pick attaches: the section outline, else (a plain PDF has no
 * headings) the chunk outline with its pages, else with none.
 */
type PickFallback = "sections" | "pages" | "chunks";

/** Why a paper's named sections were not chosen, for the model. */
function sectionPickFailureWarning(
  citationLabel: string,
  error: SectionPickError,
  fallback: PickFallback = "sections",
): string {
  const failed = `The reader could not choose the named sections in ${citationLabel} (${error.message}); nothing of it was read in their place.`;
  if (fallback === "sections")
    return `${failed} Its outline is attached: call paper_read mode:'targeted' with sectionIds from it.`;
  if (fallback === "pages")
    return `${failed} It has no headings; its chunk outline is attached: call paper_read mode:'targeted' with the pages of the chunks you need (pages:'3-4').`;
  return `${failed} It has no headings or page numbers: read it with a query, or with mode:'full'.`;
}

/** One entry of a chunk outline: a run of chunks, its pages, its first line. */
type ChunkOutlineEntry = { chunks: string; pages?: string; firstLine: string };

/** "3" or "3-5". */
function rangeText(from: number, to: number): string {
  return from === to ? `${from}` : `${from}-${to}`;
}

/**
 * A plain PDF's chunk outline, which a failed pick returns in place of its
 * missing section outline: one entry per chunk, or per run of chunks when
 * there are more than the embedded outline's bound.
 */
function buildFallbackChunkOutline(
  content: PdfContext | undefined,
): ChunkOutlineEntry[] {
  const outline = content
    ? buildChunkOutline(content, { group: false })
    : undefined;
  if (outline?.kind !== "chunks" || !outline.chunks.length) return [];
  const size = Math.ceil(outline.chunks.length / MAX_CHUNK_OUTLINE_ENTRIES);
  const entries: ChunkOutlineEntry[] = [];
  for (let start = 0; start < outline.chunks.length; start += size) {
    const run = outline.chunks.slice(start, start + size);
    const starts = run.flatMap((chunk) =>
      chunk.pageStart !== undefined ? [chunk.pageStart] : [],
    );
    const ends = run.flatMap((chunk) =>
      chunk.pageEnd !== undefined ? [chunk.pageEnd] : [],
    );
    entries.push({
      chunks: rangeText(run[0].index, run[run.length - 1].index),
      ...(starts.length && ends.length
        ? { pages: rangeText(Math.min(...starts), Math.max(...ends)) }
        : {}),
      firstLine: run.find((chunk) => chunk.firstLine)?.firstLine || "",
    });
  }
  return entries;
}

/**
 * What a failed pick returns for one paper: its section outline, else its
 * chunk outline, and which of them the warning points to.
 */
function pickFallbackOf(content: PdfContext | undefined): {
  fallback: PickFallback;
  outline?: DocumentOutline;
  chunkOutline?: ChunkOutlineEntry[];
} {
  const outline = embeddedOutline(buildDocumentOutline(content));
  if (outline.sections.length) return { fallback: "sections", outline };
  const chunkOutline = buildFallbackChunkOutline(content);
  return {
    fallback: chunkOutline.some((entry) => entry.pages) ? "pages" : "chunks",
    ...(chunkOutline.length ? { chunkOutline } : {}),
  };
}

export type PaperReadFigureExtractionService = {
  extractFigures: (params: {
    input: PaperReadInput;
    context: AgentToolContext;
    paperContexts: NonNullable<PdfTarget["paperContext"]>[];
  }) => Promise<PaperReadFigureExtractionResult>;
};

const MAX_TARGETED_TARGETS = 10;
const MAX_FULL_TARGETS = Number.MAX_SAFE_INTEGER;
const MAX_OVERVIEW_QUOTES_PER_RESULT = 3;
/**
 * A targeted passage is one piece of evidence, so it gets one anchor. Three
 * anchors per passage produced 8–29 anchors per reply of which the model used
 * 0–2, which buried the ones it did use.
 */
const MAX_TARGETED_QUOTES_PER_PASSAGE = 1;
/** Overview anchors obey the shared quote-anchor length bounds. */
const MIN_OVERVIEW_QUOTE_CHARS = QUOTE_ANCHOR_MIN_CHARS;
const MAX_OVERVIEW_QUOTE_CHARS = QUOTE_ANCHOR_MAX_CHARS;
/** The most entries a failed pick's chunk outline lists before it groups chunks. */
const MAX_CHUNK_OUTLINE_ENTRIES = 40;

function normalizeMode(value: unknown): PaperReadMode {
  return value === "targeted" ||
    value === "full" ||
    value === "figures" ||
    value === "visual" ||
    value === "capture" ||
    value === "outline" ||
    value === "overview"
    ? value
    : "overview";
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map((entry) => normalizeString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return entries.length ? Array.from(new Set(entries)) : undefined;
}

function normalizePages(value: unknown): number[] | undefined {
  return parsePageSelectionValue(value)?.pageIndexes;
}

/** True when a call gives `pages` a value: not absent, blank or empty. */
function hasPagesValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function resolveFullReadTargets(params: {
  input: PaperReadInput;
  context: AgentToolContext;
  zoteroGateway: ZoteroGateway;
}): NonNullable<PdfTarget["paperContext"]>[] {
  const explicitTargets =
    params.input.target || params.input.targets?.length
      ? resolveDefaultTargets(
          params.input.target,
          params.input.targets,
          params.context,
          params.zoteroGateway,
          MAX_FULL_TARGETS,
        )
      : [];
  const request = params.context.request;
  // The main agent chooses reading depth through the actual paper_read call.
  // Explicit selectors are already host-resolved and therefore define the
  // intended read set without a preliminary model gate.
  if (explicitTargets.length) return explicitTargets;
  const active = getTurnPapersWithRoles(request, ["active"]).slice(0, 1);
  if (!active.length)
    throw new Error(
      "The full-read target is unresolved. Pass explicit paper targets or open an active paper.",
    );
  return active;
}

function readTextFile(filePath: string): Promise<string> {
  const IOUtils = (globalThis as any).IOUtils;
  if (IOUtils?.read) {
    return IOUtils.read(filePath).then((data: Uint8Array | ArrayBuffer) => {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      return new TextDecoder().decode(bytes);
    });
  }
  const OS = (globalThis as any).OS;
  if (OS?.File?.read) {
    return OS.File.read(filePath).then((data: Uint8Array | ArrayBuffer) => {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      return new TextDecoder().decode(bytes);
    });
  }
  throw new Error("No file reader is available for MinerU markdown");
}

function selectMineruOverview(
  fullMd: string,
  maxChars: number,
): {
  text: string;
  sections: string[];
} {
  const clean = fullMd.trim();
  const sections: string[] = ["frontmatter"];
  const intro = clean.slice(
    0,
    Math.min(clean.length, Math.floor(maxChars * 0.6)),
  );
  const headingPattern =
    /^#{1,6}\s+.*\b(discussion|conclusion|conclusions|summary|general discussion)\b.*$/gim;
  const matches = Array.from(clean.matchAll(headingPattern));
  const tailStart = matches.length
    ? Math.max(0, matches[matches.length - 1].index || 0)
    : Math.max(0, clean.length - Math.floor(maxChars * 0.4));
  const tail = clean.slice(tailStart, tailStart + Math.floor(maxChars * 0.5));
  if (tailStart > 0) sections.push("discussion_or_conclusion");
  const combined =
    tail && !intro.includes(tail.slice(0, 200))
      ? `${intro}\n\n[Later overview section]\n${tail}`
      : intro;
  return {
    text: combined.slice(0, maxChars).trim(),
    sections,
  };
}

async function tryReadMineruOverview(
  paperContext: NonNullable<PdfTarget["paperContext"]>,
  maxChars: number,
): Promise<unknown | null> {
  const cacheDir = normalizeString(paperContext.mineruCacheDir);
  if (!cacheDir) return null;
  try {
    const filePath = joinLocalPath(cacheDir, "full.md");
    const fullMd = stripMineruSourceImageEmbedsFromMarkdown(
      await readTextFile(filePath),
    );
    const selected = selectMineruOverview(fullMd, maxChars);
    return {
      backend: "mineru",
      filePath,
      text: selected.text,
      sections: selected.sections,
      selectedCharacters: selected.text.length,
      totalCharacters: fullMd.length,
      coverage:
        selected.text.length >= fullMd.length ? "complete" : "capacity_sampled",
      citationLabel: formatPaperCitationLabel(paperContext),
      sourceLabel: formatPaperSourceLabel(paperContext),
      paperContext,
    };
  } catch (error) {
    return {
      backend: "mineru",
      ok: false,
      warning: `Could not read MinerU full.md: ${
        error instanceof Error ? error.message : String(error)
      }`,
      paperContext,
    };
  }
}

/**
 * The text a host-owned paper digest reads for one paper: the whole of
 * MinerU `full.md` when its cache is readable, else the whole extracted PDF
 * text (each chunk under its `[chunk N]` marker). A paper longer than one
 * model call is read in batches by the digest worker.
 * `maxChars` is the digest text limit (`DIGEST_TEXT_MAX_CHARS`). Over it, the
 * read is the v3.9.15 overview selection with that limit: the introduction
 * and the tail from the last discussion or conclusion heading for MinerU
 * text, and a PDF excerpt sampled across chunks for PDF text. Its
 * `totalCharacters` then exceeds the text, so the digest reports it as
 * partial. `null` when neither source yields text.
 */
export async function readPaperTextForDigest(params: {
  paperContext: NonNullable<PdfTarget["paperContext"]>;
  pdfService: Pick<PdfService, "getOverviewExcerpt">;
  maxChars: number;
}): Promise<{
  backend: "mineru" | "pdf";
  text: string;
  totalCharacters: number;
} | null> {
  const ceiling = Math.max(1, Math.floor(params.maxChars));
  const cacheDir = normalizeString(params.paperContext.mineruCacheDir);
  if (cacheDir) {
    try {
      const clean = stripMineruSourceImageEmbedsFromMarkdown(
        await readTextFile(joinLocalPath(cacheDir, "full.md")),
      ).trim();
      if (clean && clean.length <= ceiling) {
        return {
          backend: "mineru",
          text: clean,
          totalCharacters: clean.length,
        };
      }
      if (clean) {
        const { text } = selectMineruOverview(clean, ceiling);
        if (text) {
          // Always partial: the selection is shorter than the whole file.
          return {
            backend: "mineru",
            text,
            totalCharacters: Math.max(clean.length, text.length + 1),
          };
        }
      }
    } catch {
      // Unreadable MinerU cache: fall back to the PDF, as the overview read does.
    }
  }
  try {
    // At or under the limit the excerpt is the whole text; over it, the
    // excerpt samples chunks, as the v3.9.15 digest read did.
    const overview = await params.pdfService.getOverviewExcerpt({
      paperContext: params.paperContext,
      maxChars: ceiling,
    });
    const text = typeof overview.text === "string" ? overview.text.trim() : "";
    if (!text) return null;
    const chunksRead = Array.isArray(overview.chunkIndexes)
      ? overview.chunkIndexes.length
      : 0;
    const totalChunks = Number(overview.totalChunks) || 0;
    // An excerpt that left chunks out is never reported as whole; its total
    // is scaled by its chunk share.
    return {
      backend: "pdf",
      text,
      totalCharacters:
        chunksRead >= totalChunks
          ? text.length
          : Math.max(
              text.length + 1,
              Math.round((text.length * totalChunks) / Math.max(1, chunksRead)),
            ),
    };
  } catch {
    return null;
  }
}

/** What `readPaperScopeText` reads besides the paper's text. */
export type PaperScopeTextReaders = {
  pdfService: Pick<PdfService, "getOverviewExcerpt" | "ensurePaperContext">;
  /** The item's Zotero `abstractNote`, empty when it has none. */
  readAbstractNote?: (
    paper: NonNullable<PdfTarget["paperContext"]>,
  ) => string | Promise<string>;
  /** The item's child notes as plain text, as library_read reads them. */
  readNotes?: (
    paper: NonNullable<PdfTarget["paperContext"]>,
  ) =>
    | ReadonlyArray<{ title?: string; noteText: string }>
    | Promise<ReadonlyArray<{ title?: string; noteText: string }>>;
  /** The item's Zotero record as text (title, creators, date, venue, ...). */
  readMetadata?: (
    paper: NonNullable<PdfTarget["paperContext"]>,
  ) => string | Promise<string>;
  /** The PDF's own page text, by 0-based page index. */
  readPageTexts?: (
    paper: NonNullable<PdfTarget["paperContext"]>,
  ) => Promise<ReadonlyArray<ScopePageText>>;
};

/** MinerU `full.md` without its image embeds, or null when unreadable. */
async function readMineruMarkdown(
  paperContext: NonNullable<PdfTarget["paperContext"]>,
): Promise<string | null> {
  const cacheDir = normalizeString(paperContext.mineruCacheDir);
  if (!cacheDir) return null;
  try {
    const clean = stripMineruSourceImageEmbedsFromMarkdown(
      await readTextFile(joinLocalPath(cacheDir, "full.md")),
    ).trim();
    return clean || null;
  } catch {
    return null;
  }
}

/** The text without a leading heading line ("## Abstract", "Abstract."). */
function withoutLeadingHeading(text: string): string {
  return text
    .replace(/^\s*#{1,6}\s+[^\n]*\n+/, "")
    .replace(/^\s*abstract\s*[:.—–-]?\s*\n?/i, "")
    .trim();
}

/** The text without `[chunk N]` markers, as one passage. */
function withoutChunkMarkers(text: string): string {
  return text
    .replace(/^\s*\[chunk \d+\]\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type AbstractPart = {
  /** The abstract alone, without heading or markers. */
  text: string;
  /** The abstract as a section of a sections read, with its heading. */
  block: string;
  source: string;
  bounds: "exact" | "approximate";
  /** What the read covered: "Abstract", or the lead read in its place. */
  label: string;
  backend: ScopedPaperText["backend"];
};

/**
 * The paper's abstract by the abstract rule: the Zotero abstract field, else
 * the PDF's abstract (the MinerU Abstract section, else the PDF chunks the
 * reader classed as abstract, else the MinerU text's unheaded lead
 * paragraph, approximate), or null when it has none of them. Plain PDF
 * text has no paragraph bounds, so it has no lead paragraph.
 */
async function readAbstractPart(params: {
  paperContext: NonNullable<PdfTarget["paperContext"]>;
  readers: PaperScopeTextReaders;
  markdown: () => Promise<string | null>;
  pdfContext: () => Promise<PdfContext | undefined>;
}): Promise<AbstractPart | null> {
  let note = "";
  try {
    note =
      `${(await params.readers.readAbstractNote?.(params.paperContext)) || ""}`.trim();
  } catch {
    note = "";
  }
  if (note) {
    return {
      text: note,
      block: `## Abstract\n${note}`,
      source: READ_SCOPE_TEXT_SOURCES.zoteroAbstract,
      bounds: "exact",
      label: "Abstract",
      backend: "text",
    };
  }
  const markdown = await params.markdown();
  const found = await choosePaperTextAbstract(markdown, params.pdfContext);
  if (!found) return null;
  if (found.via === "mineru")
    return {
      text: found.text,
      block: found.block,
      source: READ_SCOPE_TEXT_SOURCES.pdfAbstract,
      bounds: "exact",
      label: "Abstract",
      backend: "mineru",
    };
  if (found.via === "chunks")
    return {
      text: found.text,
      block: found.block,
      source: READ_SCOPE_TEXT_SOURCES.pdfAbstract,
      bounds: "approximate",
      label: "Abstract",
      backend: "pdf",
    };
  return {
    text: found.text,
    block: `## ${LEAD_ABSTRACT_LABEL}\n${found.text}`,
    source: READ_SCOPE_TEXT_SOURCES.pdfAbstractLead,
    bounds: "approximate",
    label: LEAD_ABSTRACT_LABEL,
    backend: "mineru",
  };
}

/** Where a paper's own text holds its abstract, and its text there. */
type PaperTextAbstract =
  | {
      via: "mineru";
      text: string;
      block: string;
      choice: MineruScopeChoice;
    }
  | { via: "chunks"; text: string; block: string; chunkIndexes: number[] }
  | { via: "lead"; text: string };

/**
 * The abstract in a paper's own text, in the order every sections read
 * tries (after the Zotero abstract field, which only the whole-sections
 * read can return): the MinerU abstract section (a heading, or Cell's
 * Summary), else the chunks the PDF reader classed as abstract (for MinerU
 * text only those no heading classed), else MinerU's unheaded lead
 * paragraph. Null when the text has none.
 */
async function choosePaperTextAbstract(
  markdown: string | null,
  pdfContext: () => Promise<PdfContext | undefined>,
): Promise<PaperTextAbstract | null> {
  if (markdown) {
    const choice = chooseMineruScopeSections(markdown, ["abstract"]);
    const block = selectMineruScopeSections(markdown, ["abstract"]).text;
    const text = withoutLeadingHeading(block);
    if (text) return { via: "mineru", text, block, choice };
  }
  const context = await pdfContext();
  if (context?.chunks?.length) {
    const options = { headingsJudged: Boolean(markdown) };
    const selected = selectPdfChunkScopeSections(
      context,
      ["abstract"],
      options,
    );
    const text = withoutLeadingHeading(withoutChunkMarkers(selected.text));
    if (text)
      return {
        via: "chunks",
        text,
        block: selected.text,
        chunkIndexes: pdfChunkIndexesForSection(context, "abstract", options),
      };
  }
  const lead = markdown ? selectLeadAbstract(markdown) : "";
  return lead ? { via: "lead", text: lead } : null;
}

/** `text` cut to `ceiling` characters, with what the cut kept. */
function cutToCeiling(
  text: string,
  ceiling: number,
): { text: string; totalCharacters: number; complete: boolean } {
  if (text.length <= ceiling)
    return { text, totalCharacters: text.length, complete: true };
  return {
    text: text.slice(0, ceiling).trimEnd(),
    totalCharacters: text.length,
    complete: false,
  };
}

/** A scoped read that found nothing the scope names. */
function emptyScopedText(
  unmatched: string[],
  source: string,
  backend: ScopedPaperText["backend"] = "text",
): ScopedPaperText {
  return {
    backend,
    text: "",
    totalCharacters: 0,
    covered: [],
    unmatched,
    bounds: "exact",
    complete: false,
    source,
  };
}

/**
 * One paper's text cut to a read scope, the one extractor every reader of a
 * scope uses (the digest worker for a digest part and for `paper_digest`).
 *
 * - full (or no scope): today's digest read (`readPaperTextForDigest`): the
 *   whole MinerU or PDF text up to `maxChars`, over it the introduction and
 *   tail, so it is partial.
 * - abstract: the Zotero abstract field; when it is empty the PDF's abstract
 *   (MinerU section, else the chunks classed as abstract, else the MinerU
 *   text's unheaded lead paragraph, approximate). `source` names which.
 * - sections: each name; "abstract" by the abstract rule, the rest by the
 *   MinerU heading bounds with descendants (an unheaded results span by its
 *   place, approximate), else by the PDF chunk kinds (approximate bounds).
 *   With `pickSections`, the reader picks the rest instead, over the MinerU
 *   headings or the PDF chunks (`sectionPicker.ts`), in any language; what
 *   it read is named by the paper's own headings (`coveredParts`), and why
 *   a paper has none of a name by its judgment (`notFound`). A name it
 *   judges to mean the abstract ("摘要") is served the Zotero abstract
 *   field first, as "abstract" is. A failed pick throws
 *   `SectionPickError`: nothing is read in its place.
 *   Names nothing matches are `unmatched`; when none matches, the text is
 *   empty: nothing is read in its place.
 * - pages: the PDF's page text for the named pages.
 * - notes and metadata: what library_read returns for them.
 *
 * Every scoped text is cut to `maxChars` (`complete` false when cut). Null
 * when the paper has no readable text for the scope at all.
 */
export async function readPaperScopeText(
  params: {
    paperContext: NonNullable<PdfTarget["paperContext"]>;
    scope?: ReadScope;
    maxChars: number;
    /**
     * The reader's choice of named sections; without it the names resolve
     * by their headings' kinds, as before.
     */
    pickSections?: SectionPicker;
  } & PaperScopeTextReaders,
): Promise<ScopedPaperText | null> {
  const { paperContext, scope } = params;
  const ceiling = Math.max(1, Math.floor(params.maxChars));
  if (isFullReadScope(scope)) {
    const read = await readPaperTextForDigest({
      paperContext,
      pdfService: params.pdfService,
      maxChars: ceiling,
    });
    if (!read) return null;
    return {
      ...read,
      covered: ["full text"],
      unmatched: [],
      bounds: "exact",
      complete: read.text.length >= read.totalCharacters,
      source:
        read.backend === "mineru"
          ? READ_SCOPE_TEXT_SOURCES.mineruText
          : READ_SCOPE_TEXT_SOURCES.pdfText,
    };
  }
  let markdownRead: Promise<string | null> | undefined;
  const markdown = () => (markdownRead ||= readMineruMarkdown(paperContext));
  let contextRead: Promise<PdfContext | undefined> | undefined;
  const pdfContext = () =>
    (contextRead ||= params.pdfService
      .ensurePaperContext(paperContext)
      .catch(() => undefined));
  const finish = (
    text: string,
    fields: Omit<ScopedPaperText, "text" | "totalCharacters" | "complete">,
  ): ScopedPaperText => ({ ...fields, ...cutToCeiling(text, ceiling) });

  switch (scope!.source) {
    case "abstract": {
      const part = await readAbstractPart({
        paperContext,
        readers: params,
        markdown,
        pdfContext,
      });
      if (!part)
        return emptyScopedText(
          ["abstract"],
          READ_SCOPE_TEXT_SOURCES.zoteroAbstract,
        );
      return finish(part.text, {
        backend: part.backend,
        covered: [part.label],
        unmatched: [],
        bounds: part.bounds,
        ...(part.label === LEAD_ABSTRACT_LABEL
          ? { approximateByPosition: true }
          : {}),
        source: part.source,
      });
    }
    case "sections": {
      const names = scope!.sections || [];
      // With a picker only the plain name "abstract" takes the abstract
      // rule, and only when the paper has an abstract to read (the Zotero
      // field, a classified section or chunks, else the lead paragraph);
      // else it is picked with the other names.
      const abstractNames = names.filter(
        params.pickSections ? isPlainAbstractName : isAbstractSectionName,
      );
      let abstractPart: AbstractPart | null = null;
      if (abstractNames.length) {
        abstractPart = await readAbstractPart({
          paperContext,
          readers: params,
          markdown,
          pdfContext,
        });
      }
      const toPick = new Set(
        params.pickSections && !abstractPart ? abstractNames : [],
      );
      const wantsAbstract = abstractNames.length > 0 && !toPick.size;
      const others = names.filter(
        (name) => !abstractNames.includes(name) || toPick.has(name),
      );
      const blocks: string[] = [];
      const covered: string[] = [];
      // What a picked read covered, by heading and name; `covered` is
      // rendered from it when the reader picked.
      const coveredParts: CoveredPart[] = [];
      const picked = Boolean(params.pickSections) && others.length > 0;
      let notFound: ScopedNotFound | undefined;
      let paperCharacters: number | undefined;
      const unmatched: string[] = [];
      const sources: string[] = [];
      let approximate = false;
      // Approximate for another reason than a section found by its place.
      let approximateOtherwise = false;
      let backend: ScopedPaperText["backend"] = "text";
      let anyText = false;
      if (wantsAbstract) {
        const part = abstractPart;
        if (part) {
          blocks.push(part.block);
          covered.push(part.label);
          coveredParts.push({
            label: part.label,
            for: abstractNames[0],
            kind: "abstract",
          });
          sources.push(part.source);
          if (part.bounds === "approximate") {
            approximate = true;
            if (part.label !== LEAD_ABSTRACT_LABEL) approximateOtherwise = true;
          }
          anyText = true;
        } else {
          unmatched.push(abstractNames[0]);
        }
      }
      if (picked) {
        const read = await readPickedSections({
          names: others,
          ...(paperContext.title ? { title: paperContext.title } : {}),
          markdown,
          pdfContext,
          picker: params.pickSections!,
          ...(params.readAbstractNote
            ? { abstractField: () => params.readAbstractNote!(paperContext) }
            : {}),
        });
        if (read) {
          anyText = true;
          backend = read.backend;
          for (const block of read.blocks) {
            if (!block.text) continue;
            const source = block.source || read.source;
            if (!sources.includes(source)) sources.push(source);
            // The Zotero abstract field is exact; the paper's chunks are not.
            if (!block.source && read.approximate) {
              approximate = true;
              approximateOtherwise = true;
            }
          }
          if (read.text) blocks.push(read.text);
          coveredParts.push(...read.covered);
          unmatched.push(...read.unmatched);
          notFound = read.notFound;
          paperCharacters = read.paperCharacters;
        } else {
          unmatched.push(...others);
        }
      } else if (others.length) {
        const md = await markdown();
        if (md) {
          anyText = true;
          backend = "mineru";
          const selected = selectMineruScopeSections(md, others);
          if (selected.text) {
            blocks.push(selected.text);
            sources.push(...selected.sources);
          }
          // A results span found by its place has approximate bounds.
          if (selected.approximate) approximate = true;
          covered.push(...selected.covered);
          unmatched.push(...selected.unmatched);
        } else {
          const context = await pdfContext();
          if (context?.chunks?.length) {
            anyText = true;
            backend = "pdf";
            const selected = selectPdfChunkScopeSections(context, others);
            if (selected.text) {
              blocks.push(selected.text);
              sources.push(READ_SCOPE_TEXT_SOURCES.pdfSections);
              approximate = true;
              approximateOtherwise = true;
            }
            covered.push(...selected.covered);
            unmatched.push(...selected.unmatched);
          } else {
            unmatched.push(...others);
          }
        }
      }
      // No abstract and nothing else asked: the paper may still have text,
      // which makes this "no matching sections", not "no readable text".
      if (!anyText && !others.length)
        anyText = Boolean(
          (await markdown()) || (await pdfContext())?.chunks?.length,
        );
      if (!anyText) return null;
      const order = new Map(
        names.map((name, index) => [name.toLowerCase(), index]),
      );
      const ordered = (list: string[]) =>
        [...list].sort(
          (a, b) =>
            (order.get(a.toLowerCase()) ?? 0) -
            (order.get(b.toLowerCase()) ?? 0),
        );
      return finish(blocks.join("\n\n").trim(), {
        backend,
        covered: picked ? renderCoveredParts(coveredParts) : covered,
        ...(picked ? { coveredParts } : {}),
        ...(notFound && unmatched.length ? { notFound } : {}),
        ...(paperCharacters ? { paperCharacters } : {}),
        unmatched: ordered(unmatched),
        bounds: approximate ? "approximate" : "exact",
        ...(approximate && !approximateOtherwise
          ? { approximateByPosition: true }
          : {}),
        source: sources.join("; ") || READ_SCOPE_TEXT_SOURCES.pdfSections,
      });
    }
    case "pages": {
      let pages: ReadonlyArray<ScopePageText> = [];
      try {
        pages = (await params.readPageTexts?.(paperContext)) || [];
      } catch {
        pages = [];
      }
      if (!pages.length) return null;
      const selected = selectPageScope(pages, scope!.pages || []);
      return finish(selected.text, {
        backend: "pdf",
        covered: selected.covered,
        unmatched: selected.unmatched,
        bounds: "exact",
        source: READ_SCOPE_TEXT_SOURCES.pdfPages,
      });
    }
    case "notes": {
      let notes: ReadonlyArray<{ title?: string; noteText: string }> = [];
      try {
        notes = (await params.readNotes?.(paperContext)) || [];
      } catch {
        notes = [];
      }
      const text = notes
        .filter((note) => note.noteText?.trim())
        .map((note) =>
          note.title?.trim()
            ? `## ${note.title.trim()}\n${note.noteText.trim()}`
            : note.noteText.trim(),
        )
        .join("\n\n");
      if (!text)
        return emptyScopedText(["notes"], READ_SCOPE_TEXT_SOURCES.zoteroNotes);
      return finish(text, {
        backend: "text",
        covered: ["notes"],
        unmatched: [],
        bounds: "exact",
        source: READ_SCOPE_TEXT_SOURCES.zoteroNotes,
      });
    }
    case "metadata": {
      let text = "";
      try {
        text = `${(await params.readMetadata?.(paperContext)) || ""}`.trim();
      } catch {
        text = "";
      }
      if (!text)
        return emptyScopedText(
          ["metadata"],
          READ_SCOPE_TEXT_SOURCES.zoteroRecord,
        );
      return finish(text, {
        backend: "text",
        covered: ["metadata"],
        unmatched: [],
        bounds: "exact",
        source: READ_SCOPE_TEXT_SOURCES.zoteroRecord,
      });
    }
    default:
      return null;
  }
}

/**
 * The characters a whole-sections read returns per paper when the turn has
 * no live context budget (an MCP client, a test): a long results section
 * fits, and a longer one is cut and marked partial.
 */
const WHOLE_SECTIONS_DEFAULT_MAX_CHARS = 24_000;
/** Read each section whole first; the read budget then cuts what returns. */
const WHOLE_SECTION_READ_CEILING = 2_000_000;

/** A heading line of MinerU markdown ("## 2 Results"). */
const MARKDOWN_HEADING_LINE = /^\s*#{1,6}\s+\S/;
/** The chunk marker a PDF text section carries per chunk. */
const CHUNK_MARKER_LINE = /^\s*\[chunk (\d+)\]\s*$/;

type SectionPassage = { text: string; chunkIndex?: number };

/**
 * A section's text as passages: one per PDF chunk (under its `[chunk N]`
 * marker), else one per paragraph, a heading kept with the paragraph under
 * it.
 */
function splitSectionPassages(text: string): SectionPassage[] {
  const lines = text.split("\n");
  if (lines.some((line) => CHUNK_MARKER_LINE.test(line))) {
    const passages: SectionPassage[] = [];
    let current: { chunkIndex?: number; lines: string[] } = { lines: [] };
    const flush = () => {
      const body = current.lines.join("\n").trim();
      if (body)
        passages.push({
          text: body,
          ...(current.chunkIndex !== undefined
            ? { chunkIndex: current.chunkIndex }
            : {}),
        });
    };
    for (const line of lines) {
      const marker = CHUNK_MARKER_LINE.exec(line);
      if (marker) {
        flush();
        current = { chunkIndex: Number(marker[1]), lines: [] };
      } else {
        current.lines.push(line);
      }
    }
    flush();
    return passages;
  }
  const passages: SectionPassage[] = [];
  let headings: string[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const clean = block.trim();
    if (!clean) continue;
    if (clean.split("\n").every((line) => MARKDOWN_HEADING_LINE.test(line))) {
      headings.push(clean);
      continue;
    }
    passages.push({ text: [...headings, clean].join("\n") });
    headings = [];
  }
  if (headings.length) passages.push({ text: headings.join("\n") });
  return passages;
}

/** The text a passage's quote is cut from: no leading heading lines. */
function passageQuoteText(text: string): string {
  return text.replace(/^(?:\s*#{1,6}\s+[^\n]*(?:\n+|$))+/, "").trim();
}

/**
 * `text` cut to `budget` characters, at the last paragraph break past half
 * of it when there is one, else at a word.
 */
function cutSectionText(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= 0) return "";
  const head = text.slice(0, budget);
  const paragraph = head.lastIndexOf("\n\n");
  if (paragraph >= budget / 2) return head.slice(0, paragraph).trimEnd();
  const space = head.lastIndexOf(" ");
  return (space >= budget / 2 ? head.slice(0, space) : head).trimEnd();
}

/**
 * The per-paper size of a read of named sections: the adaptive budget when
 * the runtime has one, else the default. The model's `maxChars` does not
 * apply.
 */
function adaptiveBudgetOrDefault(
  budget: number | undefined,
  fallback: number,
): number {
  return budget || fallback;
}

/** A whole-sections read of one paper, as the result lists it. */
type WholeSectionsPaper = {
  paperContext: NonNullable<PdfTarget["paperContext"]>;
  /**
   * complete: every matched section whole; partial: the read budget cut
   * one, or a named section had no readable text; no_matching_sections: none of the names is in the paper (nothing
   * of it was read); unreadable: the paper has no readable text.
   */
  status:
    | "complete"
    | "partial"
    | "no_matching_sections"
    | "unreadable"
    /** The reader could not choose the named sections: see `outline`. */
    | "sections_not_chosen";
  sourceKind: "paper_text";
  backend?: ScopedPaperText["backend"];
  citationLabel: string;
  sourceLabel: string;
  displayLabel?: string;
  covered: string[];
  unmatched: string[];
  /** Why the paper has none of `unmatched`, as its reader judged. */
  notFound?: ScopedPaperText["notFound"];
  /** A failed pick: the sections the model may name by `sectionIds`. */
  outline?: DocumentOutline;
  /** A failed pick in a paper without headings: its chunks and pages. */
  chunkOutline?: ChunkOutlineEntry[];
  bounds?: ScopedPaperText["bounds"];
  textSource?: string;
  /** The paper's whole text length, when the reader picked its sections. */
  paperCharacters?: number;
  /** How much of the paper's text the sections read are ("12% of ..."). */
  readShare?: string;
  /** Each section read, whole or cut by the read budget. */
  sections: Array<{
    /** The paper's own heading. */
    section: string;
    /** The requested names a picked section was read for. */
    for?: string[];
    complete: boolean;
    characters: number;
    totalCharacters: number;
  }>;
  passages: Array<Record<string, unknown>>;
};

/**
 * paper_read with `sections` and no query: each named section whole, by the
 * one scope extractor (`readPaperScopeText`, sections scope: MinerU heading
 * bounds, else the PDF chunk kinds, approximate; "abstract" by the abstract
 * rule). Each passage carries a host-minted citation id. Above
 * `maxCharsPerPaper` the sections that do not fit are cut, and the result
 * says what was cut. A paper with none of the named sections reads nothing
 * and is named; nothing else of it is read in their place. A call that
 * names only the abstract comes here with a query too, and is told the query
 * was not used. An abstract found only as the unheaded lead is named as such.
 *
 * With `pickSections` the reader picks every name but the abstract, in one
 * call per paper (`readPickedSections`): each picked section is read whole
 * under its own heading, a paper with none of a name says why
 * (`notFound`), and a paper whose pick failed returns its outline instead.
 * A name the reader judges to mean the abstract is read as "Abstract", the
 * Zotero abstract field first.
 */
async function readWholeSections(params: {
  names: readonly string[];
  /** The reader's choice of the named sections, but the abstract. */
  pickSections?: SectionPicker;
  /** An abstract-only call's query, which the whole read does not use. */
  queryIgnored?: boolean;
  targets: NonNullable<PdfTarget["paperContext"]>[];
  maxCharsPerPaper: number;
  pdfService: PdfService;
  zoteroGateway: ZoteroGateway;
  displayLabelFor: (paper: NonNullable<PdfTarget["paperContext"]>) => string;
}): Promise<Record<string, unknown>> {
  const quoteCitations: QuoteCitation[] = [];
  const warnings: string[] = params.queryIgnored
    ? ["Read the abstract whole; a query does not search it."]
    : [];
  const nothingRead: string[] = [];
  const papers: WholeSectionsPaper[] = [];
  const targets = await hydrateFigureTargetsWithMineruMetadata(
    params.targets,
    params.zoteroGateway,
  );
  let anyNotFound = false;
  const readAbstractNote = (
    paper: NonNullable<PdfTarget["paperContext"]>,
  ): string => {
    const field = (
      params.zoteroGateway.getItem(paper.itemId) as
        | { getField?: (field: string) => unknown }
        | null
        | undefined
    )?.getField?.("abstractNote");
    return typeof field === "string" ? field : "";
  };
  // Every paper's pick starts before the first is read: the host reader
  // limiter holds the calls to its own cap, so papers are picked in
  // parallel instead of one after another.
  type SettledPick = { value: PickedSections | null } | { error: unknown };
  const plans = new Map<
    NonNullable<PdfTarget["paperContext"]>,
    {
      // The names the abstract rule serves, with what it read.
      fast: Array<{ name: string; read: ScopedPaperText | null }>;
      // The names the reader picks, with the pick started for them.
      picked: string[];
      pick?: Promise<SettledPick>;
    }
  >();
  for (const paperContext of targets) {
    // The reader picks every name but the plain "abstract", which keeps its
    // rule (the Zotero abstract field first, else a classified abstract
    // section); an "abstract" neither holds is picked with the others.
    const fast: Array<{ name: string; read: ScopedPaperText | null }> = [];
    const picked: string[] = [];
    for (const name of params.names) {
      if (params.pickSections && !isPlainAbstractName(name)) {
        picked.push(name);
        continue;
      }
      const read = await readPaperScopeText({
        paperContext,
        scope: params.pickSections
          ? { source: "abstract" }
          : { source: "sections", sections: [name] },
        maxChars: WHOLE_SECTION_READ_CEILING,
        pdfService: params.pdfService,
        readAbstractNote,
      });
      if (params.pickSections && (!read || !read.text)) picked.push(name);
      else fast.push({ name, read });
    }
    plans.set(paperContext, {
      fast,
      picked,
      ...(picked.length
        ? {
            pick: readPickedSections({
              names: picked,
              ...(paperContext.title ? { title: paperContext.title } : {}),
              markdown: () => readMineruMarkdown(paperContext),
              pdfContext: () =>
                params.pdfService
                  .ensurePaperContext(paperContext)
                  .catch(() => undefined),
              picker: params.pickSections!,
              abstractField: () => readAbstractNote(paperContext),
            }).then(
              (value): SettledPick => ({ value }),
              (error): SettledPick => ({ error }),
            ),
          }
        : {}),
    });
  }
  for (const paperContext of targets) {
    const citationLabel = formatPaperCitationLabel(paperContext);
    const sourceLabel = formatPaperSourceLabel(paperContext);
    const row: WholeSectionsPaper = {
      paperContext,
      status: "complete",
      sourceKind: "paper_text",
      citationLabel,
      sourceLabel,
      displayLabel: params.displayLabelFor(paperContext),
      covered: [],
      unmatched: [],
      sections: [],
      passages: [],
    };
    let remaining = Math.max(1, Math.floor(params.maxCharsPerPaper));
    let readable = false;
    let approximate = false;
    const sources: string[] = [];
    const seen = new Set<string>();
    const cut: string[] = [];
    const unreadableNames: string[] = [];
    /** One section read whole, cut to what the read budget leaves. */
    const addSection = (section: {
      label: string;
      /**
       * What a passage of it is called to the user, when its `label` is
       * where it was found ("pages 3–4") or an internal name ("Results
       * (unlabelled sections)") and not a heading of the paper.
       */
      passageLabel?: string;
      text: string;
      covered: string;
      for?: string[];
      approximate: boolean;
      source: string;
      backend: ScopedPaperText["backend"];
    }) => {
      const whole = section.text.trim();
      if (!whole || seen.has(whole)) return;
      seen.add(whole);
      const label = section.label;
      const passageLabel = section.passageLabel || label;
      const kept = cutSectionText(whole, remaining);
      remaining = Math.max(0, remaining - kept.length);
      const complete = kept.length >= whole.length;
      // A section the budget left no room for is listed as cut, not read.
      if (kept) row.covered.push(section.covered);
      if (section.approximate) approximate = true;
      for (const source of section.source.split("; "))
        if (source && !sources.includes(source)) sources.push(source);
      // The paper's text backend; a Zotero abstract field is not one.
      if (!row.backend || row.backend === "text") row.backend = section.backend;
      row.sections.push({
        section: label,
        ...(section.for ? { for: [...section.for] } : {}),
        complete,
        characters: kept.length,
        totalCharacters: whole.length,
      });
      if (!complete) cut.push(`${label}: ${kept.length} of ${whole.length}`);
      const chunkKind = isAbstractSectionName(label)
        ? "abstract"
        : readScopeSectionKind(label) || "body";
      for (const passage of splitSectionPassages(kept)) {
        const result: Record<string, unknown> = {
          paperContext,
          text: passage.text,
          sectionLabel: passageLabel,
          chunkKind,
          citationLabel,
          sourceLabel,
          ...(passage.chunkIndex !== undefined
            ? { chunkIndex: passage.chunkIndex }
            : {}),
        };
        // One id per passage with body text, as a targeted passage has.
        const [citation] = buildChunkQuoteCitations(result, passage.text);
        if (citation) quoteCitations.push(citation);
        row.passages.push({
          text: passage.text,
          sectionLabel: passageLabel,
          chunkKind,
          ...(passage.chunkIndex !== undefined
            ? { chunkIndex: passage.chunkIndex }
            : {}),
          ...(citation ? { quoteCitationId: citation.id } : {}),
        });
      }
    };
    const plan = plans.get(paperContext)!;
    const { picked } = plan;
    for (const { name, read } of plan.fast) {
      if (!read) {
        // A name with no readable text is reported, never dropped quietly.
        row.unmatched.push(name);
        unreadableNames.push(name);
        continue;
      }
      readable = true;
      row.unmatched.push(...read.unmatched);
      const label = read.covered[0] || name;
      addSection({
        label,
        // The user reads "Abstract" and "Results" for a part found by place.
        passageLabel: shownPartName(label),
        text: read.text,
        covered: label,
        approximate: read.bounds === "approximate",
        source: read.source,
        backend: read.backend,
      });
    }
    let pickFailure: SectionPickError | undefined;
    if (picked.length) {
      let read: PickedSections | null = null;
      const settled = await plan.pick!;
      if ("error" in settled) {
        if (!(settled.error instanceof SectionPickError)) throw settled.error;
        pickFailure = settled.error;
      } else read = settled.value;
      if (pickFailure) {
        readable = true;
        const content = await params.pdfService
          .ensurePaperContext(paperContext)
          .catch(() => undefined);
        const { fallback, outline, chunkOutline } = pickFallbackOf(content);
        if (outline) row.outline = outline;
        if (chunkOutline) row.chunkOutline = chunkOutline;
        warnings.push(
          sectionPickFailureWarning(citationLabel, pickFailure, fallback),
        );
      } else if (!read) {
        row.unmatched.push(...picked);
        unreadableNames.push(...picked);
      } else {
        readable = true;
        row.unmatched.push(...read.unmatched);
        row.paperCharacters = read.paperCharacters;
        if (read.notFound && read.unmatched.length)
          row.notFound = read.notFound;
        for (const block of read.blocks)
          addSection({
            label: block.label,
            // A run of plain PDF text has no heading of its own: its
            // passages are the parts the user asked for, as the reader judged.
            ...(block.chunkIndexes && !block.kind
              ? {
                  passageLabel:
                    userPartNames(block.for).join(", ") || undefined,
                }
              : {}),
            text: block.text,
            covered: renderCoveredParts(pickedBlockCovered(block))[0],
            for: block.for,
            // The Zotero abstract field has its own source, exact bounds and
            // no paper text backend.
            approximate: !block.source && read.approximate,
            source: block.source || read.source,
            backend: block.source ? "text" : read.backend,
          });
      }
    }
    if (row.sections.length) {
      row.bounds = approximate ? "approximate" : "exact";
      row.textSource = sources.join("; ");
      // As a digest reports it: how much of the paper this read is.
      if (row.paperCharacters)
        row.readShare = `${readShare(
          row.sections.reduce((sum, entry) => sum + entry.characters, 0),
          row.paperCharacters,
        )} of the paper's text`;
    }
    if (!readable) {
      row.status = "unreadable";
      nothingRead.push(
        `${citationLabel} (item:${paperContext.itemId}): no readable text`,
      );
    } else if (pickFailure && !row.sections.length) {
      row.status = "sections_not_chosen";
      nothingRead.push(
        `${citationLabel} (item:${paperContext.itemId}): the named sections could not be chosen`,
      );
    } else if (!row.sections.length) {
      row.status = "no_matching_sections";
      nothingRead.push(
        `${citationLabel} (item:${paperContext.itemId}): none of the named sections were found`,
      );
    } else if (cut.length || unreadableNames.length || pickFailure) {
      row.status = "partial";
    }
    if (row.sections.length && cut.length)
      warnings.push(
        `Cut by the read budget, ${citationLabel}: ${cut
          .map((entry) => `${entry} characters`)
          .join("; ")}. Read that section alone.`,
      );
    // An abstract found only by position: no Zotero field, no labelled
    // abstract section, no abstract chunks (`readAbstractPart`).
    if (row.covered.includes(LEAD_ABSTRACT_LABEL))
      warnings.push(
        `${citationLabel}: no abstract section or Zotero abstract; this ${LEAD_ABSTRACT_LABEL} was found by position and may be the introduction.`,
      );
    if (row.sections.length && unreadableNames.length)
      warnings.push(
        `No readable text for ${citationLabel}: ${unreadableNames.join(", ")}.`,
      );
    // A name the paper has no section for; a section found without
    // readable text is reported above, not here.
    const notFound = row.unmatched.filter(
      (name) => !unreadableNames.includes(name),
    );
    if (notFound.length) {
      warnings.push(
        `Not found in ${citationLabel}: ${notFound.join(", ")}${describeNotFound(
          row.notFound,
        )}.`,
      );
      anyNotFound = true;
    }
    papers.push(row);
  }
  // The rule once per result, not once per paper.
  if (anyNotFound) warnings.push(SECTIONS_NOT_FOUND_RULE);
  return {
    mode: "targeted",
    read: "whole_sections",
    sections: [...params.names],
    papers,
    quoteCitations: mergeQuoteCitations(quoteCitations),
    ...(warnings.length ? { warnings } : {}),
    ...(nothingRead.length
      ? { note: `Nothing read for ${nothingRead.join("; ")}.` }
      : {}),
  };
}

/** One section of a section-by-id read, as the result lists it. */
type SectionMapEntry = {
  sectionId: string;
  title: string;
  pages?: string;
  tokens: number;
  /** has_sections: listed by its sections; does_not_fit: the read cannot fit. */
  reason: "has_sections" | "does_not_fit";
  /** One line per section (id | heading | pages | size | sections) or per page. */
  lines: string[];
};

/**
 * One paper's sections read by the informed-choice rule
 * (`decideSectionRead`): text passages with ids for what is read, map
 * entries for what is listed. `remaining` is the measured context left; each
 * text read spends from it. A section nested in one already read is not
 * read twice.
 */
function readOutlineSections(params: {
  paperContext: NonNullable<PdfTarget["paperContext"]>;
  content: PdfContext;
  outline: DocumentOutline;
  sectionIds: readonly string[];
  whole: boolean;
  remaining: number;
  /**
   * The model's `maxChars` for this paper. Only the overview passes it; a
   * read of named sections does not.
   */
  maxChars?: number;
  quoteCitations: QuoteCitation[];
}): {
  sections: WholeSectionsPaper["sections"];
  passages: Array<Record<string, unknown>>;
  map: SectionMapEntry[];
  unmatched: string[];
  remaining: number;
  /** What is left of `maxChars`, when one was given. */
  remainingChars?: number;
} {
  const { content, outline, paperContext } = params;
  const citationLabel = formatPaperCitationLabel(paperContext);
  const sourceLabel = formatPaperSourceLabel(paperContext);
  const position = new Map(
    outline.sections.map((section, index) => [section.sectionId, index]),
  );
  const requested = [...new Set(params.sectionIds)];
  const unmatched = requested.filter((id) => !position.has(id));
  const ordered = requested
    .filter((id) => position.has(id))
    .sort((a, b) => position.get(a)! - position.get(b)!);
  const read = new Set<string>();
  const sections: WholeSectionsPaper["sections"] = [];
  const passages: Array<Record<string, unknown>> = [];
  const map: SectionMapEntry[] = [];
  let remaining = params.remaining;
  let remainingChars = params.maxChars;
  for (const id of ordered) {
    if (read.has(id)) continue;
    const section = outline.sections[position.get(id)!];
    const decision = decideSectionRead({
      outline,
      content,
      section,
      whole: params.whole,
      remainingTokens: remaining,
      ...(remainingChars !== undefined ? { remainingChars } : {}),
    });
    if (decision.kind === "map") {
      const pages = formatSectionPages(section);
      map.push({
        sectionId: section.sectionId,
        title: section.title,
        ...(pages ? { pages } : {}),
        tokens: section.tokens,
        reason: decision.reason,
        lines: decision.lines,
      });
      continue;
    }
    for (const covered of withDescendants(outline, [section.sectionId]))
      read.add(covered);
    let characters = 0;
    const [from, to] = section.chunkIndexes;
    for (let chunkIndex = from; chunkIndex <= to; chunkIndex += 1) {
      const text = (content.chunks[chunkIndex] || "").trim();
      if (!text) continue;
      const meta = content.chunkMeta[chunkIndex];
      const sectionLabel = meta?.sectionLabel || section.title;
      const pages =
        meta?.pageStart !== undefined
          ? {
              pageStart: meta.pageStart,
              pageEnd: meta.pageEnd ?? meta.pageStart,
            }
          : {};
      const [citation] = buildChunkQuoteCitations(
        {
          paperContext,
          text,
          sectionLabel,
          chunkKind: meta?.chunkKind || "body",
          citationLabel,
          sourceLabel,
          chunkIndex,
          ...(meta?.sourceFingerprint
            ? { sourceFingerprint: meta.sourceFingerprint }
            : {}),
          ...pages,
        },
        text,
      );
      if (citation) params.quoteCitations.push(citation);
      passages.push({
        text,
        sectionLabel,
        ...(meta?.sectionIndex !== undefined
          ? { sectionId: sectionIdForIndex(meta.sectionIndex) }
          : {}),
        chunkKind: meta?.chunkKind || "body",
        chunkIndex,
        ...pages,
        ...(citation ? { quoteCitationId: citation.id } : {}),
      });
      characters += text.length;
      remaining -= estimateTextTokens(text);
    }
    if (remainingChars !== undefined)
      remainingChars = Math.max(0, remainingChars - section.chars);
    sections.push({
      section: section.title,
      sectionId: section.sectionId,
      complete: true,
      characters,
      totalCharacters: characters,
    } as WholeSectionsPaper["sections"][number]);
  }
  return {
    sections,
    passages,
    map,
    unmatched,
    remaining,
    ...(remainingChars !== undefined ? { remainingChars } : {}),
  };
}

/**
 * What the model is told when a section read answers with a map. A part
 * named without `whole` is listed by its sections; one named with it, by
 * the smaller parts that fit.
 */
function sectionMapNextStep(params: { whole: boolean }): string {
  return params.whole
    ? "Sections listed in map were not read: they do not fit. Read the parts the answer needs from the sections or pages each map entry lists, with sectionIds or pages."
    : "Sections listed in map were not read: read the ones the answer needs with sectionIds, or a whole part with sectionIds and whole:true.";
}

/**
 * paper_read with `sectionIds` and no query: each named section by the
 * informed-choice rule, in the whole-sections result shape (so the ledgers
 * record what was read), with a `map` entry per section that was listed
 * instead of read.
 */
async function readSectionsById(params: {
  sectionIds: string[];
  whole: boolean;
  targets: NonNullable<PdfTarget["paperContext"]>[];
  pdfService: PdfService;
  displayLabelFor: (paper: NonNullable<PdfTarget["paperContext"]>) => string;
  remainingTokens: number;
}): Promise<Record<string, unknown>> {
  const quoteCitations: QuoteCitation[] = [];
  const warnings: string[] = [];
  const nothingRead: string[] = [];
  const papers: Array<Record<string, unknown>> = [];
  let remaining = params.remainingTokens;
  let anyNotFound = false;
  let anyMap = false;
  for (const paperContext of params.targets) {
    const citationLabel = formatPaperCitationLabel(paperContext);
    const content = await params.pdfService
      .ensurePaperContext(paperContext)
      .catch(() => undefined);
    const base = {
      paperContext,
      sourceKind: "paper_text",
      citationLabel,
      sourceLabel: formatPaperSourceLabel(paperContext),
      displayLabel: params.displayLabelFor(paperContext),
    };
    if (!content?.chunks.length) {
      nothingRead.push(
        `${citationLabel} (item:${paperContext.itemId}): no readable text`,
      );
      papers.push({
        ...base,
        status: "unreadable",
        covered: [],
        unmatched: [...params.sectionIds],
        sections: [],
        passages: [],
      });
      continue;
    }
    // An unchaptered document's ids name its bookmark sections, the map
    // its preload shows when its whole text does not fit.
    const outline =
      buildBookmarkOutline(content) ?? buildDocumentOutline(content);
    const read = readOutlineSections({
      paperContext,
      content,
      outline,
      sectionIds: params.sectionIds,
      whole: params.whole,
      remaining,
      quoteCitations,
    });
    remaining = read.remaining;
    if (read.unmatched.length) {
      anyNotFound = true;
      warnings.push(
        `Not found in ${citationLabel}: ${read.unmatched.join(", ")}.`,
      );
    }
    if (read.map.length) anyMap = true;
    const status = !read.sections.length
      ? read.map.length
        ? "map"
        : "no_matching_sections"
      : read.map.length || read.unmatched.length
        ? "partial"
        : "complete";
    if (status === "no_matching_sections")
      nothingRead.push(
        `${citationLabel} (item:${paperContext.itemId}): none of the named sections were found`,
      );
    papers.push({
      ...base,
      status,
      backend: content.sourceType === "mineru" ? "mineru" : "pdf",
      covered: read.sections.map((entry) => entry.section),
      unmatched: read.unmatched,
      bounds: "exact",
      sections: read.sections,
      passages: read.passages,
      ...(read.map.length ? { map: read.map } : {}),
    });
  }
  if (anyNotFound) warnings.push(SECTIONS_NOT_FOUND_RULE);
  if (anyMap) warnings.push(sectionMapNextStep({ whole: params.whole }));
  return {
    mode: "targeted",
    read: "whole_sections",
    sectionIds: [...params.sectionIds],
    ...(params.whole ? { whole: true } : {}),
    papers,
    quoteCitations: mergeQuoteCitations(quoteCitations),
    ...(warnings.length ? { warnings } : {}),
    ...(nothingRead.length
      ? { note: `Nothing read for ${nothingRead.join("; ")}.` }
      : {}),
  };
}

/** The parts an overview of a document with chapters opens with. */
const MAP_OVERVIEW_PARTS = ["abstract", "introduction"];

/**
 * An overview of a document with chapters: its map, and the abstract and
 * introduction as the reader picks them from the map (`readPickedSections`
 * over the document's sections), each read by the informed-choice rule. A
 * failed pick leaves the map alone, with the reason. Never the whole text.
 */
async function readDocumentMapOverview(params: {
  paperContext: NonNullable<PdfTarget["paperContext"]>;
  content: PdfContext;
  picker: SectionPicker;
  abstractField: () => string;
  remainingTokens: number;
  /** The model's `maxChars` for this paper, when it gave one. */
  maxChars?: number;
}): Promise<{
  result: Record<string, unknown>;
  remainingTokens: number;
  quoteCitations: QuoteCitation[];
}> {
  const { paperContext, content } = params;
  const outline = buildDocumentOutline(content);
  const warnings: string[] = [];
  const quoteCitations: QuoteCitation[] = [];
  const passages: Array<Record<string, unknown>> = [];
  let remaining = params.remainingTokens;
  let remainingChars = params.maxChars;
  const blocks: string[] = [];
  const parts: Array<Record<string, unknown>> = [];
  const map: SectionMapEntry[] = [];
  try {
    const picked = await readPickedSections({
      names: MAP_OVERVIEW_PARTS,
      ...(paperContext.title ? { title: paperContext.title } : {}),
      markdown: async () => null,
      pdfContext: async () => content,
      picker: params.picker,
      documentSections: true,
      abstractField: params.abstractField,
    });
    for (const block of picked?.blocks || []) {
      if (block.source) {
        // The Zotero abstract field: short, and not part of the map.
        blocks.push(block.text);
        remaining -= estimateTextTokens(block.text);
        parts.push({ section: block.label, for: block.for, read: "text" });
        continue;
      }
      const ids = (block.sectionIndexes || []).map(sectionIdForIndex);
      const read = readOutlineSections({
        paperContext,
        content,
        outline,
        sectionIds: ids.slice(0, 1),
        whole: false,
        remaining,
        ...(remainingChars !== undefined ? { maxChars: remainingChars } : {}),
        quoteCitations,
      });
      remaining = read.remaining;
      remainingChars = read.remainingChars;
      passages.push(...read.passages);
      if (read.passages.length)
        blocks.push(
          read.passages.map((passage) => String(passage.text)).join("\n\n"),
        );
      map.push(...read.map);
      parts.push({
        section: block.label,
        sectionId: ids[0],
        for: block.for,
        read: read.passages.length ? "text" : "map",
      });
    }
    if (picked?.unmatched.length)
      warnings.push(`Not in the document: ${picked.unmatched.join(", ")}.`);
  } catch (error) {
    if (!(error instanceof SectionPickError)) throw error;
    warnings.push(
      `The reader could not choose the opening parts (${error.message}); the map alone follows.`,
    );
  }
  const text = blocks.join("\n\n").trim();
  const minted = mergeQuoteCitations(quoteCitations);
  const passageIds = passages.flatMap((passage) =>
    typeof passage.quoteCitationId === "string"
      ? [passage.quoteCitationId]
      : [],
  );
  return {
    remainingTokens: remaining,
    quoteCitations: minted,
    result: {
      paperContext,
      backend: "document_map",
      coverage: "map",
      citationLabel: formatPaperCitationLabel(paperContext),
      sourceLabel: formatPaperSourceLabel(paperContext),
      map: formatDocumentMap(outline),
      text,
      selectedCharacters: text.length,
      parts,
      // The read parts' passages, each with the id its own text was given.
      passages,
      ...(passageIds.length
        ? {
            quoteCitationIds: passageIds,
            quoteAnchors: passageIds.map((id) => `[[quote:${id}]]`),
          }
        : {}),
      ...(map.length ? { partMaps: map } : {}),
      guidance:
        "The map lists the document's parts with ids, pages and sizes; read the ones the answer needs with mode:'targeted' and sectionIds.",
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    },
  };
}

/**
 * A full read's exact evidence chunks, each with body text given one
 * citation id minted from its own text, as a targeted passage has; a chunk
 * that is only a heading gets none. The records go to `collector`.
 */
function withFullReadQuoteCitations(
  paper: FullReadPaperResult,
  collector: QuoteCitation[],
): (ExhaustiveSourceChunk & { quoteCitationId?: string })[] {
  return paper.exactEvidence.map((chunk) => {
    const [citation] = buildQuoteCitationsFromResult(
      {
        paperContext: paper.paperContext,
        text: chunk.text,
        chunkIndex: chunk.chunkIndex,
        sectionLabel: chunk.sectionLabel,
        citationLabel: formatPaperCitationLabel(paper.paperContext),
        sourceLabel: formatPaperSourceLabel(paper.paperContext),
      },
      MAX_TARGETED_QUOTES_PER_PASSAGE,
    );
    if (!citation) return chunk;
    collector.push(citation);
    return { ...chunk, quoteCitationId: citation.id };
  });
}

/**
 * Whether the model reads a paper_read result's citation ids without their
 * records: a whole-sections read and a full read.
 */
function hidesQuoteCitationRecords(result: unknown): boolean {
  return (
    validateObject<Record<string, unknown>>(result) &&
    (result.read === "whole_sections" || result.mode === "full")
  );
}

function targetForPageTool(input: PaperReadInput): Record<string, unknown> {
  const target = input.target || input.targets?.[0];
  return {
    ...(target ? { target } : {}),
    ...(input.query ? { question: input.query } : {}),
    ...(input.pages?.length
      ? { pages: input.pages.map((pageIndex) => pageIndex + 1) }
      : {}),
    ...(input.neighborPages ? { neighborPages: input.neighborPages } : {}),
    ...(input.mode === "capture" ? { capture: true } : {}),
  };
}

async function buildMineruVisualRedirect(params: {
  input: PaperReadInput;
  context: AgentToolContext;
  zoteroGateway: ZoteroGateway;
}): Promise<Record<string, unknown> | null> {
  if (params.input.pages?.length) return null;
  let targets: NonNullable<PdfTarget["paperContext"]>[] = [];
  try {
    targets = resolveDefaultTargets(
      params.input.target,
      params.input.targets?.slice(0, 1),
      params.context,
      params.zoteroGateway,
      1,
    );
  } catch {
    return null;
  }
  const paperContext = targets[0] || null;
  const mineruCacheDir = normalizeString(paperContext?.mineruCacheDir);
  if (!paperContext) return null;
  const query = params.input.query || params.context.request.userText || "";
  return {
    mode: "visual",
    status: "use_figures_mode",
    backend: "pdf_figure_extraction",
    query,
    paperContext,
    ...(mineruCacheDir ? { mineruCacheDir } : {}),
    guidance:
      "This is a figure/image request for a Zotero library PDF. Do not read MinerU image paths and do not use paper_read mode:'visual' for figure interpretation. Call paper_read({ mode:'figures', query:'<figure/table label or all figures>' }) to get precise PDF crops plus captions/provenance. Use mode:'visual' only for explicit raw/rendered PDF page or layout inspection.",
    nextSteps: [
      `paper_read({ mode:'figures', query:'${query.replace(/'/g, "\\'")}' })`,
    ],
  };
}

function normalizeMetadataValue(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function resolveMetadataOverviewTitle(
  metadata: ProjectedPaperMetadata,
): string {
  const bibliographicTitle = normalizeMetadataValue(metadata.title);
  if (bibliographicTitle) return bibliographicTitle;
  const contentSource = metadata.contentSource;
  const standaloneContentTitle =
    contentSource?.itemId === metadata.itemId &&
    contentSource.parentItemId === undefined
      ? normalizeMetadataValue(contentSource.title)
      : "";
  return standaloneContentTitle || `Paper ${metadata.itemId}`;
}

export const resolveMetadataOverviewTitleForTests =
  resolveMetadataOverviewTitle;

function buildMetadataOverview(params: {
  paperContext: NonNullable<PdfTarget["paperContext"]>;
  metadataResolver: ZoteroMetadataResolver;
  warning?: string;
}): unknown | null {
  const metadata = projectPaperMetadata(
    params.metadataResolver.resolvePaperMetadata(params.paperContext),
    params.paperContext,
  );
  const title = resolveMetadataOverviewTitle(metadata);
  const authors = normalizeMetadataValue(metadata.creatorDisplay);
  const abstract = normalizeMetadataValue(metadata.abstract);
  const lines = [
    `Title: ${title}`,
    authors ? `Authors: ${authors}` : "",
    metadata.publicationDate ? `Date: ${metadata.publicationDate}` : "",
    metadata.year ? `Year: ${metadata.year}` : "",
    metadata.containerTitle
      ? `Container: ${metadata.containerTitle} (Zotero field: ${metadata.containerSourceField})`
      : "",
    metadata.eventTitle
      ? `Event: ${metadata.eventTitle} (Zotero field: ${metadata.eventSourceField})`
      : "",
    metadata.doi ? `DOI: ${metadata.doi}` : "",
    abstract ? `Abstract: ${abstract}` : "",
  ].filter(Boolean);
  if (!lines.length) return null;
  const warningText = params.warning || "";
  const contentStatus = /no\s+pdf\s+attachment/i.test(warningText)
    ? "no_pdf_attachment"
    : "no_extractable_pdf_text";
  return {
    backend: "zotero_metadata",
    sourceKind: "zotero_metadata",
    coverage: abstract ? "abstract_only" : "metadata_only",
    contentStatus,
    warning:
      params.warning ||
      "No extractable PDF text was available; using Zotero metadata and abstract.",
    text: lines.join("\n"),
    citationLabel: formatPaperCitationLabel(params.paperContext),
    sourceLabel: formatPaperSourceLabel(params.paperContext),
    paperContext: params.paperContext,
  };
}

function paperContextKey(
  paperContext: NonNullable<PdfTarget["paperContext"]>,
): string {
  return `${paperContext.itemId}:${paperContext.contextItemId}`;
}

function buildTargetedPaperGroups(
  targets: NonNullable<PdfTarget["paperContext"]>[],
  results: Array<Record<string, unknown>>,
  quoteCitationCollector?: QuoteCitation[],
  outlineByPaper?: Map<string, DocumentOutline>,
): Array<Record<string, unknown>> {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const result of results) {
    const paperContext = validateObject<Record<string, unknown>>(
      result.paperContext,
    )
      ? result.paperContext
      : undefined;
    const itemId = normalizePositiveInt(paperContext?.itemId);
    const contextItemId = normalizePositiveInt(paperContext?.contextItemId);
    if (!itemId || !contextItemId) continue;
    const key = `${itemId}:${contextItemId}`;
    const passage: Record<string, unknown> = {
      text: normalizeString(result.text) || "",
      sourceLabel: normalizeString(result.sourceLabel),
      citationLabel: normalizeString(result.citationLabel),
    };
    const chunkIndex = Number(result.chunkIndex);
    if (Number.isFinite(chunkIndex))
      passage.chunkIndex = Math.floor(chunkIndex);
    const score = Number(result.score);
    if (Number.isFinite(score)) passage.score = score;
    const sectionLabel = normalizeString(result.sectionLabel);
    if (sectionLabel) passage.sectionLabel = sectionLabel;
    const sectionPath = normalizeString(result.sectionPath);
    if (sectionPath) passage.sectionPath = sectionPath;
    const sectionId = normalizeString(result.sectionId);
    if (sectionId) passage.sectionId = sectionId;
    if (validateObject<Record<string, unknown>>(result.why)) {
      passage.why = result.why;
    }
    const chunkKind = normalizeString(result.chunkKind);
    if (chunkKind) passage.chunkKind = chunkKind;
    const pageIndex = Number(result.pageIndex);
    if (Number.isFinite(pageIndex) && pageIndex >= 0) {
      passage.pageIndex = Math.floor(pageIndex);
    }
    const pageLabel = normalizeString(result.pageLabel);
    if (pageLabel) passage.pageLabel = pageLabel;
    for (const field of [
      "sourceStart",
      "sourceEnd",
      "pageStart",
      "pageEnd",
    ] as const) {
      const value = Number(result[field]);
      if (Number.isFinite(value) && value >= 0) {
        passage[field] = Math.floor(value);
      }
    }
    const sourceFingerprint = normalizeString(result.sourceFingerprint);
    if (sourceFingerprint) passage.sourceFingerprint = sourceFingerprint;
    const quoteCitations = buildQuoteCitationsFromResult(
      result,
      MAX_TARGETED_QUOTES_PER_PASSAGE,
    );
    quoteCitationCollector?.push(...quoteCitations);
    if (quoteCitations.length) {
      if (quoteCitations.length === 1) {
        passage.quoteCitationId = quoteCitations[0].id;
      }
      passage.quoteCitationIds = quoteCitations.map((citation) => citation.id);
      passage.quoteAnchors = quoteCitations.map(
        (citation) => `[[quote:${citation.id}]]`,
      );
    }
    const entries = groups.get(key) || [];
    entries.push(passage);
    groups.set(key, entries);
  }

  return targets.map((paperContext) => {
    const key = paperContextKey(paperContext);
    const passages = groups.get(key) || [];
    const outline = outlineByPaper?.get(key);
    return {
      paperContext,
      // Retrieval keeps every paper's best candidate whatever the call's
      // topK, so a paper without passages had no candidate in scope.
      status: !passages.length
        ? "no_matches"
        : passages.every(
              (passage) =>
                (passage.why as { querySignal?: string } | undefined)
                  ?.querySignal === "none",
            )
          ? "exploratory"
          : "matched",
      evidenceAssessment: {
        support: "not_assessed",
        scope: "retrieved_passages",
      },
      sourceKind: "paper_text",
      citationLabel: formatPaperCitationLabel(paperContext),
      sourceLabel: formatPaperSourceLabel(paperContext),
      passages,
      ...(outline?.sections.length ? { outline } : {}),
    };
  });
}

/**
 * Parse health for an outline read, when the paper has a MinerU cache. A
 * missing or unreadable manifest is not an error: the outline still comes from
 * the chunk metadata, only without the `structure` block.
 */
async function readManifestStructure(
  paperContext: NonNullable<PdfTarget["paperContext"]>,
): Promise<MineruManifest["structure"]> {
  const contextItemId = Math.floor(Number(paperContext.contextItemId || 0));
  if (!contextItemId) return undefined;
  try {
    return (await ensureManifest(contextItemId))?.structure;
  } catch (_error) {
    void _error;
    return undefined;
  }
}

/**
 * Does any chunk of this paper sit in one of the requested sections and carry
 * text? The outline that resolved those ids is built from the same chunk
 * metadata, so this is the honest answer to "is the requested scope empty?",
 * and it is known before the read.
 */
function sectionsHoldText(
  paperContent: PdfContext | undefined,
  sectionIds: readonly string[],
): boolean {
  const wanted = new Set(sectionIds);
  return (paperContent?.chunkMeta || []).some((meta) => {
    if (!meta || meta.sectionIndex === undefined) return false;
    if (!wanted.has(sectionIdForIndex(meta.sectionIndex))) return false;
    const chunkText = paperContent?.chunks?.[meta.chunkIndex] ?? meta.text;
    return Boolean(chunkText?.trim());
  });
}

type ResolvedSectionFilter = {
  /** Section ids in the paper's outline. */
  sectionIds: string[];
  /** Chunks the named sections hold. */
  chunkIndexes: number[];
  /** Names and ids the paper has none of; never searched in their place. */
  notFound: string[];
  /** An abstract the paper has only in its Zotero record, not in its text. */
  abstractInRecord: boolean;
  /**
   * Names found in the MinerU text that no chunk holds, so a query cannot
   * search them; a read with no query reads them.
   */
  unsearchable: string[];
  /** Why the paper has none of a picked name, as its reader judged. */
  notFoundReason?: ScopedNotFound;
};

/**
 * One paper's scope from the two ways a call names sections. Explicit
 * `sectionIds` come from an outline read. Names are found by the rules a
 * whole-sections read uses, mapped to the chunks that hold them: the
 * abstract by `choosePaperTextAbstract`; with MinerU text, any other name
 * by `chooseMineruScopeSections` (a standard name by its heading's kind,
 * Cell's Summary as the abstract, the results of a paper with no Results
 * heading by their place; any other name by a heading that holds every
 * word of it; with subsections); without it, a standard name by the
 * chunks' kind and any other name by the outline titles that hold every
 * word of it. A name or id the paper has none of is reported, never
 * replaced by the whole document.
 *
 * With `picker`, the reader picks every name but the abstract instead
 * (`readPickedSections`), and its sections map to their chunks the same
 * way; the text before the first heading by its text, a plain PDF's chunk
 * ranges as they are. A failed pick throws `SectionPickError`.
 */
async function resolveSectionFilter(params: {
  sectionIds?: string[];
  sections?: string[];
  /** The reader's choice of the named sections, but the abstract. */
  picker?: SectionPicker;
  title?: string;
  outline: DocumentOutline;
  content: PdfContext | undefined;
  markdown: string | null;
  abstractNote: () => string;
}): Promise<ResolvedSectionFilter> {
  const outlineSections = params.outline.sections;
  const content = params.content || { chunks: [], chunkMeta: [] };
  const known = new Set(outlineSections.map((section) => section.sectionId));
  const sectionIds = new Set<string>();
  const chunkIndexes = new Set<number>();
  const missing = new Set<string>();
  const unsearchable = new Set<string>();
  let abstractInRecord = false;
  const chunksNameSections = (content.chunkMeta || []).some(
    (meta) => meta?.sectionIndex !== undefined,
  );
  for (const sectionId of params.sectionIds || []) {
    if (!known.has(sectionId)) {
      missing.add(sectionId);
      continue;
    }
    // A section's range includes the sections nested under it.
    for (const id of withDescendants(params.outline, [sectionId])) {
      sectionIds.add(id);
      // Chunks that name no section (a plain PDF's bookmark parts) are
      // scoped by the part's chunk range.
      if (!chunksNameSections) {
        const range = outlineSections.find((s) => s.sectionId === id);
        if (range)
          for (let i = range.chunkIndexes[0]; i <= range.chunkIndexes[1]; i++)
            chunkIndexes.add(i);
      }
    }
  }
  const names = params.sections || [];
  const add = (name: string, indexes: readonly number[]) => {
    for (const index of indexes) chunkIndexes.add(index);
    if (!indexes.length) missing.add(name);
  };
  // Chosen MinerU sections, as chunks: by the section the chunks name, else
  // (flat chunks name none) by the sections' text.
  const mineruChunks = (
    sections: MineruScopeChoice["sections"],
    indexes: readonly number[],
  ): number[] => {
    const named = chunkIndexesForMineruSections(content, sections, indexes);
    if (named.length || !params.markdown) return named;
    const byText = new Set<number>();
    for (const index of indexes) {
      const section = sections[index];
      if (!section) continue;
      const raw = params.markdown.slice(section.charStart, section.charEnd);
      const body = raw.replace(/^\s*#{1,6}\s+[^\n]*\n*/, "");
      // A short body may repeat elsewhere; its heading line pins it.
      const probe = body.replace(/\s+/g, " ").trim().length < 80 ? raw : body;
      for (const chunk of chunkIndexesForText(content, probe))
        byText.add(chunk);
    }
    return [...byText].sort((a, b) => a - b);
  };
  // With a picker only the plain name "abstract" takes the abstract rule,
  // and only when the Zotero field or a classified abstract section holds
  // it; else the reader picks it with the other names.
  const abstractNames = names.filter(
    params.picker ? isPlainAbstractName : isAbstractSectionName,
  );
  const abstractToPick = new Set<string>();
  for (const name of abstractNames) {
    const found = await choosePaperTextAbstract(
      params.markdown,
      async () => params.content,
    );
    if (params.picker && !params.abstractNote().trim() && !found) {
      abstractToPick.add(name);
      continue;
    }
    const indexes = !found
      ? []
      : found.via === "mineru"
        ? mineruChunks(
            found.choice.sections,
            found.choice.parts.flatMap((part) => part.indexes),
          )
        : found.via === "chunks"
          ? found.chunkIndexes
          : chunkIndexesForText(content, found.text);
    if (!indexes.length && params.abstractNote().trim()) {
      abstractInRecord = true;
      continue;
    }
    if (!indexes.length && found && found.via !== "chunks") {
      unsearchable.add(name);
      continue;
    }
    add(name, indexes);
  }
  const others = names.filter(
    (name) => !abstractNames.includes(name) || abstractToPick.has(name),
  );
  let notFoundReason: ScopedNotFound | undefined;
  if (others.length && params.picker) {
    const picked = await readPickedSections({
      names: others,
      ...(params.title ? { title: params.title } : {}),
      markdown: async () => params.markdown,
      pdfContext: async () => params.content,
      picker: params.picker,
    });
    if (!picked) {
      for (const name of others) missing.add(name);
    } else {
      const byName = new Map<string, Set<number>>();
      for (const block of picked.blocks) {
        const indexes = block.chunkIndexes
          ? block.chunkIndexes
          : block.preamble
            ? chunkIndexesForText(content, block.text)
            : mineruChunks(picked.sections || [], block.sectionIndexes || []);
        for (const name of block.for) {
          const set = byName.get(name) || new Set<number>();
          for (const index of indexes) set.add(index);
          byName.set(name, set);
        }
      }
      // A name the reader judged the abstract that no chunk holds is
      // served by the Zotero abstract field, as the abstract rule has it.
      const inRecord = (name: string) =>
        picked.abstractNames.includes(name) &&
        Boolean(params.abstractNote().trim());
      for (const [name, indexes] of byName) {
        if (indexes.size)
          add(
            name,
            [...indexes].sort((a, b) => a - b),
          );
        else if (inRecord(name)) abstractInRecord = true;
        else unsearchable.add(name);
      }
      const unmatched = picked.unmatched.filter((name) => {
        if (!inRecord(name)) return true;
        abstractInRecord = true;
        return false;
      });
      for (const name of unmatched) missing.add(name);
      if (picked.notFound && unmatched.length) notFoundReason = picked.notFound;
    }
  } else if (others.length && params.markdown) {
    const choice = chooseMineruScopeSections(params.markdown, others);
    for (const part of choice.parts) {
      const indexes = mineruChunks(choice.sections, part.indexes);
      if (indexes.length) add(part.name, indexes);
      else unsearchable.add(part.name);
    }
    for (const name of choice.unmatched) missing.add(name);
  } else {
    const words = (text: string) =>
      tokenizeRetrievalText(text, { filterStopwords: true });
    for (const name of others) {
      if (readScopeSectionKind(name)) {
        add(name, pdfChunkIndexesForSection(content, name));
        continue;
      }
      const nameWords = words(name);
      let found = false;
      outlineSections.forEach((section, index) => {
        if (!nameWords.length) return;
        const title = new Set(words(section.title || ""));
        if (!nameWords.every((word) => title.has(word))) return;
        found = true;
        sectionIds.add(section.sectionId);
        // Its subsections: the deeper sections that follow it.
        for (const next of outlineSections.slice(index + 1)) {
          if (next.level <= section.level) break;
          sectionIds.add(next.sectionId);
        }
      });
      if (!found) missing.add(name);
    }
  }
  // In the call's order: ids, then names.
  const notFound = [...(params.sectionIds || []), ...names].filter(
    (entry, index, list) => missing.has(entry) && list.indexOf(entry) === index,
  );
  return {
    sectionIds: [...sectionIds],
    chunkIndexes: [...chunkIndexes],
    notFound,
    abstractInRecord,
    unsearchable: names.filter((name) => unsearchable.has(name)),
    ...(notFoundReason ? { notFoundReason } : {}),
  };
}

function buildQuoteCitationFromResult(
  result: Record<string, unknown>,
  quoteText?: string,
): ReturnType<typeof buildQuoteCitation> {
  const paperContext = validateObject<Record<string, unknown>>(
    result.paperContext,
  )
    ? result.paperContext
    : undefined;
  const itemId = Number(paperContext?.itemId);
  const contextItemId = Number(paperContext?.contextItemId);
  if (
    !Number.isFinite(itemId) ||
    itemId <= 0 ||
    !Number.isFinite(contextItemId) ||
    contextItemId <= 0
  ) {
    return undefined;
  }
  const explicitPageIndex = Number(result.pageIndex);
  const pageStart = Number(result.pageStart);
  const pageEnd = Number(result.pageEnd);
  const pageHintIndex =
    Number.isFinite(explicitPageIndex) && explicitPageIndex >= 0
      ? Math.floor(explicitPageIndex)
      : Number.isFinite(pageStart) &&
          Number.isFinite(pageEnd) &&
          pageStart >= 0 &&
          pageStart === pageEnd
        ? Math.floor(pageStart)
        : undefined;
  const exactQuoteText = normalizeString(quoteText) || "";
  if (!exactQuoteText) return undefined;
  return buildQuoteCitation({
    quoteText: exactQuoteText,
    sourceMatchText: exactQuoteText,
    sourceMatchKind: "exact",
    // Tool text carries no page-text fingerprint, and a MinerU chunk's single
    // page is its section heading's page, so the page stays a hint. Only the
    // answer-time gate, reading the PDF's own page text, records a location.
    sourceMatchSource: "context-text",
    citationLabel:
      normalizeString(result.sourceLabel) ||
      normalizeString(result.citationLabel),
    sourceSectionLabel: result.sectionLabel,
    sourceChunkKind: result.chunkKind,
    contextItemId,
    itemId,
    sourceFingerprint: result.sourceFingerprint,
    pageHintIndex,
    pageHintLabel: result.pageLabel,
    allowShortQuoteText: true,
  });
}

/**
 * The citations a result's candidates yield, as the returned citation list
 * registers them. Every candidate is built and filtered before any is chosen,
 * so a rejected first sentence run does not leave the passage without an
 * anchor; and the merge filter runs here, so an id shown with a passage is
 * never one that the returned list later drops.
 */
function buildRegisteredQuoteCitations(
  result: Record<string, unknown>,
  quoteTexts: string[],
): QuoteCitation[] {
  return mergeQuoteCitations(
    quoteTexts
      .map((quoteText) => buildQuoteCitationFromResult(result, quoteText))
      .filter((entry): entry is QuoteCitation => Boolean(entry)),
  );
}

function buildQuoteCitationsFromResult(
  result: Record<string, unknown>,
  maxQuotes: number,
): QuoteCitation[] {
  return buildChunkQuoteCitations(
    result,
    normalizeString(result.text) || "",
  ).slice(0, Math.max(1, Math.floor(maxQuotes)));
}

const QUOTE_METADATA_LINE =
  /^(?:title|authors?|date|publication|doi|abstract):/i;

/**
 * The texts a chunk's one id may be cut from, in text order: the first
 * eligible sentence run of the first block that has one comes first. The id
 * names the chunk, so the order only picks the text it shows and locates by
 * default.
 */
function chunkQuoteTexts(text: string): string[] {
  return splitOverviewQuoteCandidates(text, Number.MAX_SAFE_INTEGER);
}

/**
 * The citations a chunk's text yields. A chunk with no quotable sentence, or
 * whose sentences all fail to build, falls back to its text below its
 * headings; a chunk that is only headings yields nothing.
 */
function buildChunkQuoteCitations(
  result: Record<string, unknown>,
  text: string,
): QuoteCitation[] {
  const candidates = chunkQuoteTexts(text);
  const built = buildRegisteredQuoteCitations(result, candidates);
  if (built.length) return built;
  const fallback = passageQuoteText(text);
  return fallback && !candidates.includes(fallback)
    ? buildRegisteredQuoteCitations(result, [fallback])
    : [];
}

/**
 * A chunk's blocks as single lines: chunk markers are dropped, and a heading
 * line ends a block and is dropped, so a heading neither becomes a quote nor
 * joins the text on both sides of it.
 */
function quotableBlocks(text: string): string[] {
  return splitBodyBlocks(text.replace(/^\s*\[chunk\s+\d+\]\s*$/gim, ""));
}

/**
 * A block's quotable sentence runs: each sentence of the shared splitter,
 * extended forward to the quote-anchor bounds, cut from the block itself.
 */
function blockQuoteRuns(block: string): string[] {
  const sentences = splitSentences(block);
  const runs: string[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const start = sentences[i].start;
    let end = sentences[i].end;
    for (
      let j = i + 1;
      end - start < MIN_OVERVIEW_QUOTE_CHARS && j < sentences.length;
      j++
    ) {
      if (sentences[j].end - start > MAX_OVERVIEW_QUOTE_CHARS) break;
      end = sentences[j].end;
    }
    const run = block.slice(start, end);
    if (
      run.length < MIN_OVERVIEW_QUOTE_CHARS ||
      run.length > MAX_OVERVIEW_QUOTE_CHARS ||
      QUOTE_METADATA_LINE.test(run)
    ) {
      continue;
    }
    runs.push(run);
  }
  return runs;
}

/**
 * One quote text per block, up to `limit`: the block's first sentence run.
 * A front-matter block yields none.
 */
function splitOverviewQuoteCandidates(
  text: string,
  limit = MAX_OVERVIEW_QUOTES_PER_RESULT,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const block of quotableBlocks(text)) {
    if (QUOTE_METADATA_LINE.test(block)) continue;
    const runs = blockQuoteRuns(block);
    const candidate = runs[0];
    if (!candidate) continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= limit) break;
  }
  return out;
}

function buildOverviewQuoteCitationPack(
  results: Array<Record<string, unknown>>,
  /** Ids already given to a result's passages (a document map's reads). */
  mintedFor: Map<Record<string, unknown>, QuoteCitation[]> = new Map(),
): {
  results: Array<Record<string, unknown>>;
  quoteCitations: QuoteCitation[];
} {
  const quoteCitations: QuoteCitation[] = [];
  const resultsWithAnchors = results.map((result) => {
    const minted = mintedFor.get(result);
    if (minted) {
      quoteCitations.push(...minted);
      return result;
    }
    if (
      normalizeString(result.backend) === "zotero_metadata" ||
      normalizeString(result.sourceKind) === "zotero_metadata"
    ) {
      return result;
    }
    const resultCitations = buildRegisteredQuoteCitations(
      result,
      splitOverviewQuoteCandidates(normalizeString(result.text) || ""),
    );
    quoteCitations.push(...resultCitations);
    return resultCitations.length
      ? {
          ...result,
          quoteCitationIds: resultCitations.map((citation) => citation.id),
          quoteAnchors: resultCitations.map(
            (citation) => `[[quote:${citation.id}]]`,
          ),
        }
      : result;
  });
  return {
    results: resultsWithAnchors,
    quoteCitations: mergeQuoteCitations(quoteCitations),
  };
}

function getUniqueSourceLabels(entries: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const record = validateObject<Record<string, unknown>>(entry)
      ? entry
      : null;
    const sourceLabel =
      normalizeString(record?.displayLabel) ||
      normalizeString(record?.sourceLabel);
    if (!sourceLabel || seen.has(sourceLabel)) continue;
    seen.add(sourceLabel);
    out.push(sourceLabel);
  }
  return out;
}

function countGroupedPassages(papers: unknown[]): number {
  return papers.reduce<number>((count, paper) => {
    const record = validateObject<Record<string, unknown>>(paper)
      ? paper
      : null;
    const passages = Array.isArray(record?.passages) ? record.passages : [];
    return count + passages.length;
  }, 0);
}

function extractWarningText(value: unknown): string | undefined {
  if (!validateObject<Record<string, unknown>>(value)) return undefined;
  return normalizeString(value.warning);
}

function combineWarnings(
  ...warnings: Array<string | undefined>
): string | undefined {
  const unique = Array.from(
    new Set(warnings.map((entry) => normalizeString(entry)).filter(Boolean)),
  );
  return unique.length ? unique.join("; ") : undefined;
}

function formatSourcePhrase(
  sourceLabels: string[],
  fallbackPaperCount?: number,
): string | null {
  if (sourceLabels.length === 1) return sourceLabels[0];
  if (sourceLabels.length > 1) return `${sourceLabels.length} sources`;
  if (fallbackPaperCount && fallbackPaperCount > 0) {
    const paperLabel = fallbackPaperCount === 1 ? "paper" : "papers";
    return `${fallbackPaperCount} ${paperLabel}`;
  }
  return null;
}

async function hydrateFigureTargetsWithMineruMetadata(
  targets: NonNullable<PdfTarget["paperContext"]>[],
  zoteroGateway: ZoteroGateway,
): Promise<NonNullable<PdfTarget["paperContext"]>[]> {
  const attachmentInfoLoader = (
    zoteroGateway as unknown as {
      getAllChildAttachmentInfos?: (itemId: number) => Promise<
        Array<{
          contextItemId?: number;
          mineruCacheDir?: string;
        }>
      >;
    }
  ).getAllChildAttachmentInfos;
  const attachmentInfoByItem = new Map<
    number,
    Promise<Array<{ contextItemId?: number; mineruCacheDir?: string }>>
  >();
  const hydrated: NonNullable<PdfTarget["paperContext"]>[] = [];
  for (const target of targets) {
    if (normalizeString(target.mineruCacheDir)) {
      hydrated.push(target);
      continue;
    }
    if (!attachmentInfoLoader) {
      hydrated.push(target);
      continue;
    }
    const itemId = Math.floor(Number(target.itemId || 0));
    const contextItemId = Math.floor(Number(target.contextItemId || 0));
    if (!itemId || !contextItemId) {
      hydrated.push(target);
      continue;
    }
    let infoPromise = attachmentInfoByItem.get(itemId);
    if (!infoPromise) {
      infoPromise = attachmentInfoLoader.call(zoteroGateway, itemId);
      attachmentInfoByItem.set(itemId, infoPromise);
    }
    let infos: Array<{ contextItemId?: number; mineruCacheDir?: string }> = [];
    try {
      infos = await infoPromise;
    } catch (_error) {
      void _error;
    }
    const matchingAttachment = infos.find(
      (entry) => Math.floor(Number(entry.contextItemId || 0)) === contextItemId,
    );
    const mineruCacheDir = normalizeString(matchingAttachment?.mineruCacheDir);
    if (!mineruCacheDir) {
      hydrated.push(target);
      continue;
    }
    hydrated.push({
      ...target,
      contentSourceMode: target.contentSourceMode || "mineru",
      mineruCacheDir,
    });
  }
  return hydrated;
}

/** What the model is told when a page read answers with a map. */
const PAGE_MAP_NEXT_STEP =
  "Pages listed in map were not read: they do not fit the remaining context. Read fewer pages at a time.";

/**
 * paper_read with `pages`: each paper's pages as text, by the informed-choice
 * rule: when their text is larger than the measured context left, the paper
 * answers with its requested pages' map (page, size, first line) instead,
 * never with cut text. The model's `maxChars` does not apply.
 */
async function readExplicitPageTargets(params: {
  input: PaperReadInput;
  targets: NonNullable<PdfTarget["paperContext"]>[];
  context: AgentToolContext;
  pdfPageService: PdfPageService;
  remainingTokens: number;
}): Promise<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  const quoteCitations: QuoteCitation[] = [];
  const mapByPaper = new Map<string, string[]>();
  let remaining = params.remainingTokens;
  for (const paperContext of params.targets) {
    const pageResult = await params.pdfPageService.readPageTexts({
      paperContext,
      request: params.context.request,
      pages: params.input.pages || [],
      neighborPages: params.input.neighborPages,
    });
    const tokens = pageResult.pages.map((page) =>
      estimateTextTokens(page.text || ""),
    );
    const total = tokens.reduce((sum, value) => sum + value, 0);
    if (total > remaining) {
      mapByPaper.set(
        paperContextKey(paperContext),
        pageResult.pages.map((page, index) =>
          formatPageMapLine({
            label: `page ${page.pageIndex + 1}`,
            tokens: tokens[index],
            firstLine: outlineFirstLine(page.text || ""),
          }),
        ),
      );
      continue;
    }
    remaining -= total;
    for (const page of pageResult.pages) {
      results.push({
        paperContext,
        text: page.text,
        sourceKind: "paper_page_text",
        chunkKind: "page",
        pageIndex: page.pageIndex,
        pageLabel: page.pageLabel,
        sectionLabel: `Page ${page.pageLabel}`,
        score: 1,
        citationLabel: formatPaperCitationLabel(paperContext),
        sourceLabel: formatPaperSourceLabel(paperContext),
      });
    }
  }
  const papers = buildTargetedPaperGroups(
    params.targets,
    results,
    quoteCitations,
  ).map((group) => {
    const map = mapByPaper.get(
      paperContextKey(
        group.paperContext as NonNullable<PdfTarget["paperContext"]>,
      ),
    );
    return map
      ? { ...group, status: "map", reason: "does_not_fit", map }
      : group;
  });
  return {
    mode: params.input.mode,
    results,
    papers,
    quoteCitations: mergeQuoteCitations(quoteCitations),
    ...(mapByPaper.size ? { warnings: [PAGE_MAP_NEXT_STEP] } : {}),
  };
}

/**
 * The mode a call asked for, however its arguments arrived.
 *
 * A call relayed from a connected client can carry its arguments as the JSON
 * text the model produced rather than as an object.
 */
function readPaperReadModeFromArgs(args: unknown): string {
  let value = args;
  if (typeof value === "string") {
    const clean = value.trim();
    if (!clean.startsWith("{")) return "";
    try {
      value = JSON.parse(clean) as unknown;
    } catch {
      return "";
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const mode = (value as Record<string, unknown>).mode;
  return typeof mode === "string" ? mode.trim() : "";
}

type PaperReadGuidance = AgentToolGuidance;

/**
 * The reading rules apply whenever the turn can reach paper_read: a paper, a
 * selected passage, a collection, or a tag in context, or a library (global)
 * conversation, where the model may read explicitly targeted papers.
 */
export function matchesPaperReadGuidance(
  request: Parameters<PaperReadGuidance["matches"]>[0],
): boolean {
  const scope = request.turnPaperScope;
  if (!scope) return false;
  return (
    scope.conversationKind === "global" ||
    scope.papers.length > 0 ||
    scope.selectedPassagePaperRefs.length > 0 ||
    scope.collections.length > 0 ||
    scope.tags.length > 0
  );
}

/** The single owner of paper-reading rules (mode choice, depth, progress). */
export const PAPER_READ_GUIDANCE: PaperReadGuidance = {
  matches: matchesPaperReadGuidance,
  instruction: [
    "Use supplied paper text directly when it supports the answer. Otherwise read only what the user named, if they limited the reading (only the abstract, named sections), or choose the paper_read mode from the evidence the answer needs: mode:'overview' for a bounded overview; mode:'targeted' with sections (as the user named them, any language) and no query to read those parts whole, or with query for a specific passage (for a single factual lookup start with topK:3 and widen only for several requested facts or comparison dimensions); mode:'outline' for section addresses; mode:'full' for comprehensive reading when useful; mode:'figures' for extracted figure crops; mode:'visual' or mode:'capture' only for explicit page, layout, or current-reader inspection. An overview or targeted read never satisfies an explicit full-read request.",
    "In collection, tag, or library scope the active-reader paper is never an implicit target: pass explicit targets, batching several papers in one call.",
    "For eligible textual paper_read results, use paperEvidenceProgress as factual retrieval state. Its recommendations are advisory: decide whether held evidence supports the requested explanation, and freely retrieve missing methods, results, qualifications, or other relevant passages. Avoid repeating unchanged reads; disclose unavailable sources.",
    "If overview falls back to Zotero metadata or an abstract, answer from that evidence when sufficient and state the limitation. If there is no PDF attachment and the user needs more than local metadata or abstract evidence, say what is missing and label any outside evidence separately.",
  ].join("\n"),
};

export function createPaperReadTool(
  pdfService: PdfService,
  retrievalService: RetrievalService,
  pdfPageService: PdfPageService,
  zoteroGateway: ZoteroGateway,
  figureExtractionService?: PaperReadFigureExtractionService,
  fullReadAnalyzer?: ExhaustiveBatchAnalyzer,
  readerOptions: PaperReadReaderOptions = {},
): AgentToolDefinition<PaperReadInput, unknown> {
  const pageRenderer = createPdfPageRenderer(pdfPageService);
  return {
    spec: {
      name: "paper_read",
      description:
        "Read content from the active or targeted paper through one semantic tool. Provide target or targets, never both; omit both to use the current turn's paper scope. Use mode:'overview' for bounded summaries, mode:'targeted' with sections (as the user named them, any language) and no query to read those parts whole, or with query for specific textual evidence, mode:'outline' for section ids and sizes, mode:'full' for comprehensive full-text reading when useful, mode:'figures' for precise extracted figures from Zotero library PDFs, mode:'visual' for rendered PDF pages/layout, and mode:'capture' for the currently visible Zotero reader page.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: {
            type: "string",
            enum: [
              "overview",
              "outline",
              "targeted",
              "full",
              "figures",
              "visual",
              "capture",
            ],
            description:
              "overview = bounded summary/main message; outline = one level of the section tree with ids, pages and sizes; targeted = relevance-ranked text evidence; full = exhaustive processing of every extractable text chunk; figures = precise extracted figures; visual = rendered pages/layout; capture = current reader page.",
          },
          target: {
            type: "object",
            description:
              "Optional explicit paper or visual target. Provide target or targets, never both; omit both to use the current turn's paper scope.",
            properties: {
              ...PAPER_TARGET_SELECTOR_SCHEMA.properties,
              attachmentId: { type: "string" },
              name: { type: "string" },
            },
            additionalProperties: false,
            anyOf: [
              { required: ["itemId"] },
              { required: ["attachmentId"] },
              { required: ["name"] },
            ],
          },
          targets: {
            type: "array",
            minItems: 1,
            description:
              "Optional explicit paper targets. Provide target or targets, never both; omit both to use the current turn's paper scope.",
            items: PAPER_TARGET_SELECTOR_SCHEMA,
          },
          query: { type: "string" },
          figureLabels: {
            type: "array",
            items: { type: "string" },
            description:
              "For figures mode: exact labels such as Figure 1 or Supplementary Figure S2; [] selects all main figures.",
          },
          includeSupplementary: { type: "boolean" },
          queryVariants: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional search probes such as translations, acronyms, notation variants, or technical equivalents.",
          },
          sections: {
            type: "array",
            items: { type: "string" },
            description:
              "Parts of the paper as the user named them, in any language; the reader picks the paper's matching sections and reads them whole.",
          },
          sectionIds: {
            type: "array",
            items: { type: "string" },
            description:
              "Section ids from an outline. No query: a section without subsections is read whole, one with subsections lists them. With query: searches them.",
          },
          sectionId: {
            type: "string",
            description:
              "Outline: list this section's subsections, not the top level.",
          },
          whole: {
            type: "boolean",
            description: "sectionIds: read whole with subsections.",
          },
          pages: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "array", items: { type: "number" } },
            ],
          },
          neighborPages: { type: "number" },
          maxChars: {
            type: "number",
            description:
              "A character limit on the text of an overview. Reads by sectionIds, sections, or pages ignore it: they return the text when it fits the context left, else a map with sizes in tokens.",
          },
          topK: { type: "number" },
        },
      },
      executionClass: "read",
      workCategory: "retrieval",
      exposure: "model",
    },
    guidance: PAPER_READ_GUIDANCE,
    // A whole-sections or full read shows the model each passage's citation
    // id, not the citation records: they would repeat every passage's
    // quote. The run's collector and the panel read the whole result.
    modelContent: (result) =>
      hidesQuoteCitationRecords(result)
        ? withoutDigestQuoteCitations(result)
        : result,
    presentation: {
      label: "Read Paper",
      traceIcon: "library",
      /**
       * The same figure count, for a call a connected client relayed.
       *
       * Such a call reaches the trace with its image artifacts and no result
       * payload, so the count comes from the artifacts the extraction
       * produced rather than from the figures the result would have listed.
       */
      buildTraceSummary: ({ args, artifacts, phase, ok: succeeded }) => {
        if (phase !== "completed" || succeeded === false) return null;
        if (readPaperReadModeFromArgs(args) !== "figures") return null;
        const figures = (artifacts || []).filter(
          (artifact) => artifact?.kind === "image",
        );
        if (!figures.length) return null;
        return figures.length === 1
          ? "Extracted 1 figure"
          : `Extracted ${figures.length} figures`;
      },
      summaries: {
        onCall: ({ args }) => {
          const mode =
            args && typeof args === "object"
              ? String((args as Record<string, unknown>).mode || "overview")
              : "overview";
          if (mode === "visual")
            return "Preparing paper pages for visual review";
          if (mode === "figures")
            return "Extracting precise figures from the paper";
          if (mode === "capture") return "Capturing current paper page";
          if (mode === "outline") return "Reading the paper's section outline";
          if (mode === "targeted") return "Reading targeted paper content";
          if (mode === "full") return "Reading the complete paper text";
          return "Reading paper overview";
        },
        onPending: "Waiting for your approval before sending document content",
        onApproved: "Approval received - sending document content",
        onDenied: "Paper reading cancelled",
        onSuccess: ({ content }) => {
          const c = content as Record<string, unknown> | null;
          const mode = typeof c?.mode === "string" ? c.mode : undefined;
          const results = Array.isArray(c?.results) ? c.results : undefined;
          const papers = Array.isArray(c?.papers) ? c.papers : undefined;
          if (mode === "outline") {
            if (papers?.length === 1) {
              const outline = validateObject<Record<string, unknown>>(
                (papers[0] as Record<string, unknown>)?.outline,
              )
                ? ((papers[0] as Record<string, unknown>).outline as Record<
                    string,
                    unknown
                  >)
                : undefined;
              const sections = Array.isArray(outline?.sections)
                ? outline.sections
                : [];
              return `Read outline (${sections.length} sections)`;
            }
            const sourcePhrase = formatSourcePhrase(
              getUniqueSourceLabels(papers || []),
              papers?.length,
            );
            return sourcePhrase
              ? `Read outlines from ${sourcePhrase}`
              : "Read paper outlines";
          }
          if (mode === "targeted") {
            const passageCount =
              results?.length ?? (papers ? countGroupedPassages(papers) : 0);
            if (passageCount > 0) {
              const passageLabel = passageCount === 1 ? "passage" : "passages";
              const sourcePhrase = formatSourcePhrase(
                getUniqueSourceLabels(papers || results || []),
                papers?.length,
              );
              return sourcePhrase
                ? `Read ${passageCount} ${passageLabel} from ${sourcePhrase}`
                : `Read ${passageCount} ${passageLabel}`;
            }
            return "Read paper content";
          }
          if (mode === "full") {
            const receipt = c?.coverageReceipt as
              | { processedChunks?: number; totalChunks?: number }
              | undefined;
            const sources = formatSourcePhrase(
              getUniqueSourceLabels(papers || []),
            );
            return `Read ${receipt?.processedChunks || 0}/${receipt?.totalChunks || 0} full-text chunks${sources ? ` from ${sources}` : ""}`;
          }
          if (mode === "overview" && results?.length) {
            const sourcePhrase = formatSourcePhrase(
              getUniqueSourceLabels(results),
            );
            if (sourcePhrase) {
              const overviewLabel =
                results.length === 1 ? "paper overview" : "paper overviews";
              return `Read ${overviewLabel} from ${sourcePhrase}`;
            }
          }
          if (mode === "visual" && c?.status === "use_figures_mode") {
            return "Use figure extraction for this figure request";
          }
          // Visual and capture results carry no mode: the page renderer's
          // content shape identifies them, since trace rows summarize a
          // result without its call arguments.
          if (!mode && c?.capturedPageIndex !== undefined) {
            return "Captured the current reader page";
          }
          if (
            !mode &&
            typeof c?.pageCount === "number" &&
            (Array.isArray(c?.pageTexts) || Array.isArray(c?.results))
          ) {
            const count = c.pageCount;
            return count > 0
              ? `Prepared ${count} PDF page image${count === 1 ? "" : "s"}`
              : "Prepared PDF pages";
          }
          if (mode === "figures") {
            const figures = Array.isArray(c?.figures) ? c.figures : [];
            if (c?.status === "mineru_required") {
              return "Figure extraction requires MinerU cache";
            }
            return figures.length === 1
              ? "Extracted 1 figure"
              : `Extracted ${figures.length} figures`;
          }
          const resultCount = results?.length ?? 1;
          return resultCount > 1
            ? `Read ${resultCount} papers`
            : "Read paper content";
        },
      },
    },
    validate(args) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const mode = normalizeMode(args.mode);
      if (
        args.figureLabels !== undefined &&
        (!Array.isArray(args.figureLabels) ||
          args.figureLabels.some(
            (label) => typeof label !== "string" || !label.trim(),
          ))
      ) {
        return fail(
          "figureLabels must be an array of non-empty labels, or [] for all figures.",
        );
      }
      if (
        args.includeSupplementary !== undefined &&
        typeof args.includeSupplementary !== "boolean"
      ) {
        return fail("includeSupplementary must be a boolean.");
      }
      if (args.whole !== undefined && typeof args.whole !== "boolean") {
        return fail("whole must be a boolean.");
      }
      const maxTargets =
        mode === "overview"
          ? MAX_FULL_TARGETS
          : mode === "full"
            ? MAX_FULL_TARGETS
            : MAX_TARGETED_TARGETS;
      const targetSyntax = normalizeExplicitTargetSyntax({
        targetProvided: Object.prototype.hasOwnProperty.call(args, "target"),
        target: args.target,
        targetsProvided: Object.prototype.hasOwnProperty.call(args, "targets"),
        targets: args.targets,
        mode: mode === "visual" || mode === "capture" ? "visual" : "paper",
        maxCount: maxTargets,
      });
      if (targetSyntax.kind === "invalid") {
        return fail(`${targetSyntax.code}: ${targetSyntax.message}`);
      }
      const explicitTarget =
        targetSyntax.kind === "visual_selector"
          ? {
              ...targetSyntax.selector.paperSelector,
              attachmentId: targetSyntax.selector.attachmentId,
              name: targetSyntax.selector.name,
            }
          : undefined;
      const input: PaperReadInput = {
        mode,
        target: explicitTarget,
        targets:
          targetSyntax.kind === "paper_selectors"
            ? [...targetSyntax.selectors]
            : undefined,
        query: normalizeString(args.query),
        figureLabels: Array.isArray(args.figureLabels)
          ? (args.figureLabels as string[]).map((label) => label.trim())
          : undefined,
        includeSupplementary:
          typeof args.includeSupplementary === "boolean"
            ? args.includeSupplementary
            : undefined,
        queryVariants: normalizeStringArray(args.queryVariants),
        sections: normalizeStringArray(args.sections),
        sectionIds: normalizeStringArray(args.sectionIds),
        sectionId: normalizeString(args.sectionId),
        whole: args.whole === true ? true : undefined,
        pages: normalizePages(args.pages),
        neighborPages: normalizePositiveInt(args.neighborPages),
        maxChars: normalizePositiveInt(args.maxChars),
        topK: normalizePositiveInt(args.topK),
      };
      // Pages the call names but that name no page would otherwise drop out
      // and leave an unscoped search of the whole document.
      if (hasPagesValue(args.pages) && !input.pages?.length) {
        return fail(
          `pages: ${JSON.stringify(args.pages)} names no page. Give PDF page numbers from 1: pages:[4,5], pages:'4-5' or pages:'4, 5'.`,
        );
      }
      // A targeted read that names one section by sectionId means that
      // section, the same as sectionIds with one id. Ignoring it would fall
      // through to an unscoped search of the whole document.
      if (mode === "targeted" && input.sectionId && !input.sectionIds?.length) {
        input.sectionIds = [input.sectionId];
        input.sectionId = undefined;
      }
      if (mode === "visual" || mode === "capture") {
        const visualValidation = pageRenderer.validate(
          targetForPageTool(input),
        );
        if (!visualValidation.ok) return fail(visualValidation.error);
        input.visualInput = visualValidation.value;
      }
      return ok(input);
    },
    // No paper_read mode asks for approval up front; the page renderer has no
    // approval hook of its own.
    async shouldRequireConfirmation() {
      return false;
    },
    async createPendingAction(input, context) {
      if (input.mode !== "visual" && input.mode !== "capture") {
        throw new Error("Only visual and capture paper_read modes need review");
      }
      const action = await pageRenderer.createPendingAction(
        input.visualInput as never,
        context,
      );
      return {
        ...action,
        toolName: "paper_read",
      };
    },
    applyConfirmation(input, resolutionData) {
      if (input.mode !== "visual" && input.mode !== "capture") return ok(input);
      const resolved = pageRenderer.applyConfirmation(
        input.visualInput as never,
        resolutionData,
      );
      if (!resolved.ok) return fail(resolved.error);
      return ok({
        ...input,
        visualInput: resolved.value,
      });
    },
    planInvocation: (input) =>
      readOnlyInvocationPlan({
        domains:
          input.mode === "visual" || input.mode === "capture"
            ? ["zotero_library", "filesystem", "network"]
            : ["zotero_library", "filesystem"],
        effects:
          input.mode === "visual" || input.mode === "capture"
            ? ["read", "egress"]
            : ["read"],
        reason:
          input.mode === "visual" || input.mode === "capture"
            ? "The host renders selected PDF pages and sends reviewed images to the model."
            : "The host-owned paper reader returns metadata or extracted text without changing the source.",
      }),
    async execute(input, context) {
      if (input.mode === "visual" || input.mode === "capture") {
        if (input.mode === "visual") {
          const mineruRedirect = await buildMineruVisualRedirect({
            input,
            context,
            zoteroGateway,
          });
          if (mineruRedirect) return mineruRedirect;
        }
        return pageRenderer.execute(input.visualInput as never, context);
      }
      const mode: PaperReadMode = input.mode;
      const targets =
        mode === "full"
          ? resolveFullReadTargets({ input, context, zoteroGateway })
          : resolveDefaultTargets(
              input.target,
              input.targets,
              context,
              zoteroGateway,
              mode === "overview" ? MAX_FULL_TARGETS : MAX_TARGETED_TARGETS,
            );
      const displayLabels = context.request.metadata?.paperDisplayLabels as
        | Record<string, string>
        | undefined;
      const displayLabelFor = (
        paper: PaperDisplayMetadata & {
          libraryID?: number;
          itemKey?: string;
          itemId?: number;
        },
      ) => {
        const native =
          displayLabels && paper.itemId
            ? zoteroGateway.getItem(paper.itemId)
            : undefined;
        const identity = `${paper.libraryID || native?.libraryID}:${paper.itemKey || native?.key}`;
        return displayLabels?.[identity] || formatPaperDisplayLabel(paper);
      };
      if (!targets.length) {
        throw new Error(describeNoDefaultPaperTarget(context.request));
      }
      if (mode === "figures") {
        const explicitTablesOnly =
          Boolean(input.figureLabels?.length) &&
          input.figureLabels!.every((label) => {
            const references = parseDocumentReferences(label);
            return (
              references.length > 0 &&
              references.every((ref) => ref.kind === "table")
            );
          });
        if (explicitTablesOnly) {
          return {
            mode: "figures",
            status: "no_figures",
            query: input.query || context.request.userText || "",
            guidance:
              "Tables are handled through extracted MinerU text/table content, not the figure-crop extractor. Use paper_read mode:'targeted' with the table label and surrounding discussion.",
          };
        }
        const figureTargets = await hydrateFigureTargetsWithMineruMetadata(
          targets,
          zoteroGateway,
        );
        if (!figureExtractionService) {
          return {
            mode: "figures",
            status: "error",
            query: input.query || context.request.userText || "",
            warning: "Precise figure extraction service is not available.",
            guidance: FIGURE_CROP_FAILURE_GUIDANCE,
          };
        }
        const extracted = await figureExtractionService.extractFigures({
          input,
          context,
          paperContexts: figureTargets,
        });
        const figureResult =
          extracted.status === "ok" || extracted.guidance
            ? extracted
            : { ...extracted, guidance: FIGURE_CROP_FAILURE_GUIDANCE };
        const { artifacts, ...content } = figureResult;
        return artifacts?.length ? { content, artifacts } : content;
      }
      if (mode === "full") {
        if (
          !fullReadAnalyzer &&
          context.request.exhaustiveReadBackend === "unavailable"
        ) {
          throw new Error(
            "Exhaustive paper reading cannot run because a tool-free full-read backend is unavailable for this MCP scope. Use mode:'targeted', or start the request from a provider-backed chat that supports exhaustive reading.",
          );
        }
        const nativeFullReadModel = `${context.request.model || ""}`.trim();
        // The reader the user picked, if any. The plugin Agent always reads
        // through the resolver; Codex and Claude Code keep their native
        // sessions for the main model and use it only for a picked reader.
        const readerChoice = fullReadAnalyzer
          ? undefined
          : readerOptions.readerChoice
            ? readerOptions.readerChoice(context)
            : readerChoiceFromSelection({
                selection: context.request.readerSelection,
                request: context.request,
                lookupEntry: readerOptions.lookupReaderEntry,
              });
        const isNativeRuntime =
          context.request.authMode === "codex_app_server" ||
          context.request.exhaustiveReadBackend === "claude_bridge";
        const useResolver =
          !fullReadAnalyzer && (readerChoice !== undefined || !isNativeRuntime);
        if (
          !fullReadAnalyzer &&
          !readerChoice &&
          context.request.authMode === "codex_app_server" &&
          (!nativeFullReadModel || nativeFullReadModel === "codex-app-server")
        ) {
          throw new Error(
            "Exhaustive paper reading cannot run because the Codex tool-free full-read backend has no selected model.",
          );
        }
        const useClaudeBridgeReader =
          !fullReadAnalyzer &&
          !useResolver &&
          context.request.exhaustiveReadBackend === "claude_bridge";
        if (useClaudeBridgeReader && !nativeFullReadModel) {
          throw new Error(
            "Exhaustive paper reading cannot run because the Claude tool-free full-read backend has no selected model.",
          );
        }
        const resolvedReader = useResolver
          ? resolveReaderWithFallback({
              request: context.request,
              choice: readerChoice,
              llmCall: readerOptions.llmCall,
              factories: readerOptions.readerFactories,
            })
          : null;
        if (resolvedReader && !resolvedReader.resolution.ok) {
          throw new Error(
            `Exhaustive paper reading cannot run: ${resolvedReader.resolution.detail}`,
          );
        }
        const paperInputs = [];
        for (const paperContext of targets) {
          paperInputs.push({
            paperContext,
            pdfContext: await pdfService.ensurePaperContext(paperContext),
          });
        }
        const inputTokenCap = Math.max(
          2048,
          Math.floor(Number(context.request.advanced?.inputTokenCap || 12000)),
        );
        const resolverReader =
          resolvedReader && resolvedReader.resolution.ok
            ? resolvedReader.resolution.reader
            : null;
        // A batch is sized from the reader model's own window, up to a
        // ceiling; the synthesis that returns to the agent stays sized from
        // the agent's cap, so a large window does not grow it.
        const readerWindowTokens =
          readerChoice && resolverReader
            ? resolverReader.windowTokens
            : resolveModelInputTokenLimit(
                nativeFullReadModel,
                context.request.advanced?.inputTokenCap,
                {
                  apiBase: context.request.apiBase,
                  protocol: context.request.providerProtocol,
                  authMode: context.request.authMode,
                  profileOverride: context.request.advanced?.profileOverride,
                },
              ).limitTokens;
        const batchTokenBudget =
          resolveFullReadBatchTokenBudget(readerWindowTokens);
        // Native reader calls share the host's one reader limit with
        // paper_digest.
        const resolverAnalyzer = resolverReader
          ? createReaderBatchAnalyzer(
              isNativeRuntime
                ? mapReaderCompletion(resolverReader, (complete) =>
                    limitReaderCompletion(complete, hostReaderCallLimiter),
                  )
                : resolverReader,
            )
          : null;
        const nativeReaderSession = useClaudeBridgeReader
          ? createClaudeBridgeExhaustiveReaderSession({
              model: nativeFullReadModel,
              reasoning: context.request.reasoning,
              complete: limitReaderCompletion(
                createClaudeBridgeCompletion(),
                hostReaderCallLimiter,
              ),
            })
          : !fullReadAnalyzer &&
              !useResolver &&
              context.request.authMode === "codex_app_server"
            ? createCodexAppServerExhaustiveReaderSession({
                model: nativeFullReadModel,
                reasoning: context.request.reasoning,
                profileOverride: context.request.advanced?.profileOverride,
                complete: limitReaderCompletion(
                  createCodexResponsesCompletion({
                    profileOverride: context.request.advanced?.profileOverride,
                  }),
                  hostReaderCallLimiter,
                ),
              })
            : null;
        const result = await (async () => {
          try {
            return await readDocumentsExhaustively({
              papers: paperInputs,
              question:
                input.query ||
                context.request.userText ||
                "Read the full text.",
              batchTokenBudget,
              finalTokenBudget: Math.max(
                1024,
                Math.floor(inputTokenCap * 0.45),
              ),
              analyzeBatch:
                fullReadAnalyzer ||
                resolverAnalyzer ||
                nativeReaderSession?.analyzeBatch,
              signal: context.signal,
              llm: {
                model: context.request.model,
                apiBase: context.request.apiBase,
                apiKey: context.request.apiKey,
                authMode: context.request.authMode,
                providerProtocol: context.request.providerProtocol,
                reasoning: context.request.reasoning,
                profileOverride: context.request.advanced?.profileOverride,
              },
            });
          } finally {
            nativeReaderSession?.dispose();
          }
        })();
        const fallbackNote = resolvedReader?.fallbackNote();
        const fullQuoteCitations: QuoteCitation[] = [];
        const output: PaperReadFullResult = {
          mode: "full",
          status: result.status,
          papers: result.papers.map((paper) => ({
            ...paper,
            exactEvidence: withFullReadQuoteCitations(
              paper,
              fullQuoteCitations,
            ),
            displayLabel: displayLabelFor(paper.paperContext),
          })),
          quoteCitations: mergeQuoteCitations(fullQuoteCitations),
          coverageReceipt: result.receipt,
          synthesisContext: result.contextText,
          warnings: result.warnings,
          // The trace names who read when the user picked the reader.
          ...(readerChoice && resolverReader
            ? {
                reader: {
                  route: resolverReader.route,
                  model: resolverReader.model,
                },
              }
            : {}),
          ...(fallbackNote ? { readerFallback: fallbackNote } : {}),
        };
        return output;
      }
      // The share of the live context a read of each paper may take.
      const adaptiveReadingBudget = () => {
        const runtimeBudget = context.request.runtimeContextBudget;
        return runtimeBudget
          ? resolveAdaptiveReadingBudget({
              ...runtimeBudget,
              outputReserveTokens: resolveOutputReserve(
                context.request.advanced?.outputTokenLimit,
                context.request.model || context.modelName,
                {
                  apiBase: context.request.apiBase,
                  protocol: context.request.providerProtocol,
                  authMode: context.request.authMode,
                  profileOverride: context.request.advanced?.profileOverride,
                },
              ),
              paperCount: targets.length,
            })
          : undefined;
      };
      // What a read may still add: the live context left after the output
      // reserve (a long job's page share bounds it), else the model's input
      // limit. A physical bound, not a share: the informed-choice rule, not
      // this number, keeps unrequested text out.
      const measuredRemainingTokens = (): number => {
        const outputReserveTokens = resolveOutputReserve(
          context.request.advanced?.outputTokenLimit,
          context.request.model || context.modelName,
          {
            apiBase: context.request.apiBase,
            protocol: context.request.providerProtocol,
            authMode: context.request.authMode,
            profileOverride: context.request.advanced?.profileOverride,
          },
        );
        const runtimeBudget = context.request.runtimeContextBudget;
        if (runtimeBudget) {
          const measured = resolveAdaptiveReadingBudget({
            ...runtimeBudget,
            outputReserveTokens,
            paperCount: 1,
          });
          return runtimeBudget.maxTokensPerPaper &&
            runtimeBudget.maxTokensPerPaper > 0
            ? Math.min(
                measured.remainingInputTokens,
                runtimeBudget.maxTokensPerPaper,
              )
            : measured.remainingInputTokens;
        }
        const limit = resolveModelInputTokenLimit(
          `${context.request.model || context.modelName || ""}`,
          context.request.advanced?.inputTokenCap,
          {
            apiBase: context.request.apiBase,
            protocol: context.request.providerProtocol,
            authMode: context.request.authMode,
            profileOverride: context.request.advanced?.profileOverride,
          },
        ).limitTokens;
        return Math.max(0, limit - outputReserveTokens);
      };
      if (mode === "overview") {
        const adaptiveBudget = adaptiveReadingBudget();
        const maxChars =
          input.maxChars || adaptiveBudget?.maxCharactersPerPaper || 6000;
        const results = [];
        const metadataResolver = createZoteroMetadataResolver({
          getItem: (itemId) => zoteroGateway.getItem(itemId),
        });
        let remainingTokens: number | undefined;
        const mintedFor = new Map<Record<string, unknown>, QuoteCitation[]>();
        for (const paperContext of targets) {
          // A document with chapters: its map and its picked opening parts,
          // never its whole text.
          const content = await pdfService
            .ensurePaperContext(paperContext)
            .catch(() => undefined);
          if (content?.documentStructure) {
            remainingTokens ??= measuredRemainingTokens();
            const overview = await readDocumentMapOverview({
              paperContext,
              content,
              picker: lazySectionPicker(context, readerOptions, input.query)
                .picker,
              abstractField: () => {
                const field = (
                  zoteroGateway.getItem?.(paperContext.itemId) as
                    | { getField?: (field: string) => unknown }
                    | null
                    | undefined
                )?.getField?.("abstractNote");
                return typeof field === "string" ? field : "";
              },
              remainingTokens,
              ...(input.maxChars ? { maxChars: input.maxChars } : {}),
            });
            remainingTokens = overview.remainingTokens;
            results.push(overview.result);
            mintedFor.set(overview.result, overview.quoteCitations);
            continue;
          }
          const mineru = await tryReadMineruOverview(paperContext, maxChars);
          if (mineru && (mineru as { ok?: boolean }).ok !== false) {
            results.push(mineru);
            continue;
          }
          try {
            const overview = await pdfService.getOverviewExcerpt({
              paperContext,
              maxChars,
            });
            results.push({
              ...overview,
              selectedCharacters: overview.text.length,
              coverage:
                Array.isArray(overview.chunkIndexes) &&
                overview.chunkIndexes.length >= overview.totalChunks
                  ? "complete"
                  : "capacity_sampled",
            });
          } catch (error) {
            const warning = combineWarnings(
              extractWarningText(mineru),
              error instanceof Error ? error.message : String(error),
            );
            const metadataOverview = buildMetadataOverview({
              paperContext,
              metadataResolver,
              warning,
            });
            if (metadataOverview) {
              results.push(metadataOverview);
            } else if (mineru) {
              results.push(mineru);
            } else {
              throw error;
            }
          }
        }
        const overviewQuotePack = buildOverviewQuoteCitationPack(
          results as Array<Record<string, unknown>>,
          mintedFor,
        );
        const coverageKinds = overviewQuotePack.results.map((result) =>
          String((result as Record<string, unknown>).coverage || "unknown"),
        );
        return {
          mode,
          results: overviewQuotePack.results.map((result) => {
            const paper = (result as Record<string, unknown>).paperContext as
              | (PaperDisplayMetadata & {
                  libraryID?: number;
                  itemKey?: string;
                  itemId?: number;
                })
              | undefined;
            return {
              ...result,
              displayLabel: paper
                ? displayLabelFor(paper)
                : (result as Record<string, unknown>).sourceLabel,
            };
          }),
          quoteCitations: overviewQuotePack.quoteCitations,
          readingReceipt: {
            strategy: adaptiveBudget ? "capacity_adaptive" : "default",
            requestedPapers: targets.length,
            returnedPapers: overviewQuotePack.results.length,
            completePapers: coverageKinds.filter(
              (coverage) => coverage === "complete",
            ).length,
            capacitySampledPapers: coverageKinds.filter(
              (coverage) => coverage === "capacity_sampled",
            ).length,
            abstractOnlyPapers: coverageKinds.filter(
              (coverage) => coverage === "abstract_only",
            ).length,
            metadataOnlyPapers: coverageKinds.filter(
              (coverage) => coverage === "metadata_only",
            ).length,
            maxCharactersPerPaper: maxChars,
            ...(adaptiveBudget || {}),
          },
        };
      }

      if (mode === "outline") {
        const warnings: string[] = [];
        const papers = [];
        for (const paperContext of targets) {
          let paperOutline: DocumentOutline = { sections: [], totalChunks: 0 };
          try {
            const paperContent =
              await pdfService.ensurePaperContext(paperContext);
            const tree =
              buildBookmarkOutline(paperContent) ??
              buildDocumentOutline(
                paperContent,
                await readManifestStructure(paperContext),
              );
            // One level at a time: the top level, or one section's sections.
            const level = outlineLevel(tree, input.sectionId);
            if (!level)
              warnings.push(
                `Not found in ${formatPaperCitationLabel(paperContext)}: ${input.sectionId}.`,
              );
            paperOutline = {
              ...tree,
              sections: level || [],
              ...(input.sectionId ? { expanded: input.sectionId } : {}),
            } as DocumentOutline;
          } catch (error) {
            warnings.push(
              `Could not read ${formatPaperSourceLabel(paperContext)}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          papers.push({
            paperContext,
            sourceLabel: formatPaperSourceLabel(paperContext),
            citationLabel: formatPaperCitationLabel(paperContext),
            status: paperOutline.sections.length ? "matched" : "no_structure",
            outline: paperOutline,
          });
        }
        return {
          mode,
          papers,
          ...(warnings.length ? { warnings } : {}),
        };
      }

      if (input.pages?.length) {
        return readExplicitPageTargets({
          input,
          targets,
          context,
          pdfPageService,
          remainingTokens: measuredRemainingTokens(),
        });
      }

      // Section ids and no query: each section by the informed-choice rule.
      if (
        mode === "targeted" &&
        input.sectionIds?.length &&
        !input.query &&
        !input.sections?.length
      ) {
        return readSectionsById({
          sectionIds: input.sectionIds,
          whole: input.whole === true,
          targets,
          pdfService,
          displayLabelFor,
          remainingTokens: measuredRemainingTokens(),
        });
      }

      // Named sections and no query: the whole sections, not ranked passages.
      // A call that names only the abstract reads it whole even with a
      // query: the abstract is short, so a search over it could only return
      // the chunk around it, and the lead found by position in its place.
      const abstractOnly = Boolean(
        input.sections?.length && input.sections.every(isPlainAbstractName),
      );
      if (
        mode === "targeted" &&
        input.sections?.length &&
        (!input.query || abstractOnly) &&
        !input.sectionIds?.length
      ) {
        const picking = lazySectionPicker(context, readerOptions, input.query);
        const whole = await readWholeSections({
          names: input.sections,
          ...(picking ? { pickSections: picking.picker } : {}),
          queryIgnored: Boolean(input.query),
          targets,
          maxCharsPerPaper: adaptiveBudgetOrDefault(
            adaptiveReadingBudget()?.maxCharactersPerPaper,
            WHOLE_SECTIONS_DEFAULT_MAX_CHARS,
          ),
          pdfService,
          zoteroGateway,
          displayLabelFor,
        });
        // The trace names the main model picking for a failed chosen reader.
        const pickFallbackNote = picking?.fallbackNote();
        return pickFallbackNote
          ? { ...whole, readerFallback: pickFallbackNote }
          : whole;
      }

      const contentByPaper = new Map<string, PdfContext | undefined>();
      const outlineByPaper = new Map<string, DocumentOutline>();
      for (const paper of targets) {
        const paperContent = await pdfService.ensurePaperContext(paper);
        contentByPaper.set(paperContextKey(paper), paperContent);
        outlineByPaper.set(
          paperContextKey(paper),
          buildBookmarkOutline(paperContent) ??
            buildDocumentOutline(paperContent),
        );
      }
      const sectionIdsByPaper = new Map<number, string[]>();
      const chunkIndexesByPaper = new Map<number, number[]>();
      // Retrieval never widens a requested scope, so a scope with no text is
      // reported here, before the read, from the paper's own chunks.
      const emptyScopeWarnings: string[] = [];
      // Named sections bound the search: a paper with none of them is not
      // searched, and a missing name is reported, not searched as words.
      const notFoundWarnings: string[] = [];
      const nothingRead: string[] = [];
      const unsearched = new Set<string>();
      const notFoundPapers = new Set<string>();
      const scoped = Boolean(
        input.sections?.length || input.sectionIds?.length,
      );
      // Named sections are found in the MinerU text when the paper has one.
      const readers = input.sections?.length
        ? new Map(
            (
              await hydrateFigureTargetsWithMineruMetadata(
                targets,
                zoteroGateway,
              )
            ).map((paper) => [paperContextKey(paper), paper]),
          )
        : undefined;
      const recordOnly: string[] = [];
      const unsearchableNotes: string[] = [];
      // Named sections are the reader's to pick, but the plain "abstract"
      // that the Zotero field or a classified section holds.
      const picking = input.sections?.length
        ? lazySectionPicker(context, readerOptions, input.query)
        : undefined;
      const picker = picking?.picker;
      const pickFailures: string[] = [];
      const notChosenPapers = new Set<string>();
      // A paper without headings that was not chosen: its chunk outline.
      const chunkOutlines = new Map<string, ChunkOutlineEntry[]>();
      // Every paper's filter, and so its pick, starts before the first is
      // read: the host reader limiter holds the calls to its own cap.
      const filterRuns = new Map<
        string,
        Promise<{ filter: ResolvedSectionFilter } | { error: unknown }>
      >();
      for (const paper of targets) {
        const hydrated = readers?.get(paperContextKey(paper));
        filterRuns.set(
          paperContextKey(paper),
          (async () =>
            resolveSectionFilter({
              sectionIds: input.sectionIds,
              sections: input.sections,
              ...(picker ? { picker } : {}),
              ...(paper.title ? { title: paper.title } : {}),
              outline: outlineByPaper.get(paperContextKey(paper))!,
              content: contentByPaper.get(paperContextKey(paper)),
              markdown: hydrated ? await readMineruMarkdown(hydrated) : null,
              abstractNote: () => {
                const field = (
                  zoteroGateway.getItem?.(paper.itemId) as
                    | { getField?: (field: string) => unknown }
                    | null
                    | undefined
                )?.getField?.("abstractNote");
                return typeof field === "string" ? field : "";
              },
            }))().then(
            (filter) => ({ filter }),
            (error: unknown) => ({ error }),
          ),
        );
      }
      for (const paper of targets) {
        const settled = (await filterRuns.get(paperContextKey(paper))!) as
          | { filter: ResolvedSectionFilter }
          | { error: unknown };
        let filter: ResolvedSectionFilter;
        if ("filter" in settled) filter = settled.filter;
        else {
          const error = settled.error;
          if (!(error instanceof SectionPickError)) throw error;
          // Not searched: the paper's outline (in its group) is the way on.
          unsearched.add(paperContextKey(paper));
          notChosenPapers.add(paperContextKey(paper));
          const { fallback, chunkOutline } = pickFallbackOf(
            contentByPaper.get(paperContextKey(paper)),
          );
          if (chunkOutline)
            chunkOutlines.set(paperContextKey(paper), chunkOutline);
          pickFailures.push(
            sectionPickFailureWarning(
              formatPaperCitationLabel(paper),
              error,
              fallback,
            ),
          );
          nothingRead.push(
            `${formatPaperCitationLabel(paper)} (item:${paper.itemId}): the named sections could not be chosen`,
          );
          continue;
        }
        sectionIdsByPaper.set(paper.contextItemId, filter.sectionIds);
        if (filter.chunkIndexes.length)
          chunkIndexesByPaper.set(paper.contextItemId, filter.chunkIndexes);
        if (filter.notFound.length)
          notFoundWarnings.push(
            `Not found in ${formatPaperCitationLabel(paper)}: ${filter.notFound.join(", ")}${describeNotFound(
              filter.notFoundReason,
            )}.`,
          );
        if (filter.abstractInRecord)
          recordOnly.push(formatPaperCitationLabel(paper));
        if (filter.unsearchable.length)
          unsearchableNotes.push(
            `${formatPaperCitationLabel(paper)}: ${filter.unsearchable.join(", ")} cannot be searched with a query; read ${
              filter.unsearchable.length === 1 ? "it" : "them"
            } with sections:[${filter.unsearchable.map((name) => `'${name}'`).join(",")}] and no query.`,
          );
        if (
          scoped &&
          !filter.sectionIds.length &&
          !filter.chunkIndexes.length
        ) {
          unsearched.add(paperContextKey(paper));
          // Nothing read: a missing name says so, beside any pointer.
          if (filter.notFound.length) {
            notFoundPapers.add(paperContextKey(paper));
            nothingRead.push(
              `${formatPaperCitationLabel(paper)} (item:${paper.itemId}): none of the named sections were found`,
            );
          }
        }
        if (
          filter.sectionIds.length &&
          !filter.chunkIndexes.length &&
          !sectionsHoldText(
            contentByPaper.get(paperContextKey(paper)),
            filter.sectionIds,
          )
        ) {
          // One paper's empty scope must name that paper when several are read.
          const paperSuffix =
            targets.length > 1 ? ` (${formatPaperCitationLabel(paper)})` : "";
          emptyScopeWarnings.push(
            `Requested sections contain no passages: ${filter.sectionIds.join(", ")}${paperSuffix}`,
          );
        }
      }
      const warnings = [
        ...new Set([
          ...emptyScopeWarnings,
          ...notFoundWarnings,
          // The rule once per result, not once per paper.
          ...(notFoundWarnings.length ? [SECTIONS_NOT_FOUND_RULE] : []),
          // Its text has no abstract to search; its record has one.
          ...(recordOnly.length
            ? [
                `The abstract of ${recordOnly.join(", ")} is only in the Zotero record: read it with sections:['abstract'] and no query.`,
              ]
            : []),
          ...unsearchableNotes,
          ...pickFailures,
        ]),
      ];
      const question = input.query || context.request.userText || "";
      const searched = targets.filter(
        (paper) => !unsearched.has(paperContextKey(paper)),
      );
      const results = !searched.length
        ? []
        : await retrievalService.retrieveEvidence({
            papers: searched,
            question,
            queryVariants: input.queryVariants,
            model: context.request.model,
            apiBase: context.request.apiBase,
            apiKey: context.request.apiKey,
            authMode: context.request.authMode,
            providerProtocol: context.request.providerProtocol,
            profileOverride: context.request.advanced?.profileOverride,
            topK: input.topK,
            perPaperTopK: input.topK,
            sectionIdsByPaper,
            chunkIndexesByPaper,
          });
      const pickFallbackNote = picking?.fallbackNote();
      const quoteCitations: QuoteCitation[] = [];
      const embeddedOutlines = new Map<string, DocumentOutline>();
      for (const [key, outline] of outlineByPaper) {
        const readIds = (results as Array<Record<string, unknown>>)
          .filter((result) => {
            const paper = result.paperContext as
              | NonNullable<PdfTarget["paperContext"]>
              | undefined;
            return Boolean(paper) && paperContextKey(paper!) === key;
          })
          .flatMap((result) =>
            typeof result.sectionId === "string" ? [result.sectionId] : [],
          );
        embeddedOutlines.set(key, embeddedOutline(outline, readIds));
      }
      return {
        mode,
        results,
        papers: buildTargetedPaperGroups(
          targets,
          results as Array<Record<string, unknown>>,
          quoteCitations,
          embeddedOutlines,
        ).map((group, index) =>
          notChosenPapers.has(paperContextKey(targets[index]))
            ? {
                ...group,
                status: "sections_not_chosen",
                ...(chunkOutlines.has(paperContextKey(targets[index]))
                  ? {
                      chunkOutline: chunkOutlines.get(
                        paperContextKey(targets[index]),
                      ),
                    }
                  : {}),
              }
            : notFoundPapers.has(paperContextKey(targets[index]))
              ? { ...group, status: "no_matching_sections" }
              : group,
        ),
        quoteCitations: mergeQuoteCitations(quoteCitations),
        ...(warnings.length ? { warnings } : {}),
        ...(nothingRead.length
          ? { note: `Nothing read for ${nothingRead.join("; ")}.` }
          : {}),
        ...(pickFallbackNote ? { readerFallback: pickFallbackNote } : {}),
      };
    },
    async buildFollowupMessage(result: AgentToolResult) {
      const content =
        result.content && typeof result.content === "object"
          ? (result.content as { capturedPageIndex?: unknown })
          : null;
      if (content?.capturedPageIndex !== undefined) {
        return buildCaptureFollowupMessage(result);
      }
      return null;
    },
  };
}
