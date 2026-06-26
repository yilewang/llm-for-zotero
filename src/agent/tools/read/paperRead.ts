import type {
  AgentToolContext,
  AgentToolDefinition,
  AgentToolArtifact,
  AgentToolResult,
} from "../../types";
import type { QuoteCitation } from "../../../shared/types";
import type { PdfService } from "../../services/pdfService";
import type { PdfPageService } from "../../services/pdfPageService";
import { parsePageSelectionValue } from "../../services/pdfPageService";
import type { RetrievalService } from "../../services/retrievalService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { joinLocalPath } from "../../../utils/localPath";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../../modules/contextPanel/paperAttribution";
import {
  buildQuoteCitation,
  mergeQuoteCitations,
} from "../../../modules/contextPanel/quoteCitations";
import {
  fail,
  normalizePositiveInt,
  ok,
  PAPER_CONTEXT_REF_SCHEMA,
  validateObject,
} from "../shared";
import {
  buildCaptureFollowupMessage,
  inferPdfMode,
  normalizeTarget,
  normalizeTargets,
  describeNoDefaultPaperTarget,
  resolveDefaultTargets,
} from "./pdfToolUtils";
import type { PdfTarget } from "./pdfToolUtils";
import { createViewPdfPagesTool } from "./viewPdfPages";

type PaperReadMode = "overview" | "targeted" | "figures" | "visual" | "capture";

type PaperReadInput = {
  mode: PaperReadMode;
  target?: PdfTarget;
  targets?: PdfTarget[];
  query?: string;
  queryVariants?: string[];
  sections?: string[];
  pages?: number[];
  neighborPages?: number;
  maxChars?: number;
  topK?: number;
  visualInput?: unknown;
};

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

export type PaperReadFigureExtractionService = {
  extractFigures: (params: {
    input: PaperReadInput;
    context: AgentToolContext;
    paperContexts: NonNullable<PdfTarget["paperContext"]>[];
  }) => Promise<PaperReadFigureExtractionResult>;
};

const MAX_OVERVIEW_TARGETS = 5;
const MAX_TARGETED_TARGETS = 10;
const MAX_OVERVIEW_QUOTES_PER_RESULT = 3;
const MIN_OVERVIEW_QUOTE_CHARS = 40;
const MAX_OVERVIEW_QUOTE_CHARS = 360;

function normalizeMode(value: unknown): PaperReadMode {
  return value === "targeted" ||
    value === "figures" ||
    value === "visual" ||
    value === "capture" ||
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
    const fullMd = await readTextFile(filePath);
    const selected = selectMineruOverview(fullMd, maxChars);
    return {
      backend: "mineru",
      filePath,
      text: selected.text,
      sections: selected.sections,
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

function isExplicitPdfVisualRequest(
  input: PaperReadInput,
  requestText: string | undefined,
): boolean {
  if (input.pages?.length) return true;
  const text = [input.query || "", requestText || ""]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!text) return false;
  return (
    /\b(?:raw|rendered?)\s+pdf\b/.test(text) ||
    /\bpdf\s+(?:page|pages|render|renders|screenshot|screenshots|layout)\b/.test(
      text,
    ) ||
    /\b(?:render|renders|rendered|screenshot|screenshots|capture|captures|captured)\s+(?:the\s+)?(?:pdf\s+)?pages?\b/.test(
      text,
    ) ||
    /\b(?:current|visible)\s+(?:reader\s+)?pages?\b/.test(text) ||
    /\bpage\s+(?:image|images|layout|screenshot|screenshots|render|renders|rendered)\b/.test(
      text,
    ) ||
    /\bexact\s+pages?\b/.test(text) ||
    /\bpages?\s+\d+(?:\s*(?:-|–|to|,|and)\s*\d+)?\b/.test(text) ||
    /\bp\.?\s*\d+\b/.test(text) ||
    /\bpaper_read\s*\(\s*\{\s*mode\s*:\s*['"]visual['"]/.test(text)
  );
}

function getCombinedQueryText(
  input: Pick<PaperReadInput, "query">,
  requestText: string | undefined,
): string {
  return [input.query || "", requestText || ""]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isTableOnlyInterpretationRequest(
  input: Pick<PaperReadInput, "query">,
  requestText: string | undefined,
): boolean {
  const text = getCombinedQueryText(input, requestText);
  if (!text) return false;
  const hasTable = /\btables?\s+(?:[sS]?\d+|[IVX]+)\b/i.test(text);
  if (!hasTable) return false;
  const hasFigure = /\b(?:fig(?:ure)?s?\.?|figs?\.?)\s*[sS]?\d+\b/i.test(
    text,
  );
  return !hasFigure;
}

async function buildMineruVisualRedirect(params: {
  input: PaperReadInput;
  context: AgentToolContext;
  zoteroGateway: ZoteroGateway;
}): Promise<Record<string, unknown> | null> {
  if (
    isExplicitPdfVisualRequest(params.input, params.context.request.userText)
  ) {
    return null;
  }
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
  const paperContext = targets.find((entry) =>
    Boolean(normalizeString(entry.mineruCacheDir)),
  );
  const mineruCacheDir = normalizeString(paperContext?.mineruCacheDir);
  if (!paperContext || !mineruCacheDir) return null;
  const query = params.input.query || params.context.request.userText || "";
  if (
    isTableOnlyInterpretationRequest(params.input, params.context.request.userText)
  ) {
    return {
      mode: "visual",
      status: "use_text_mode",
      backend: "mineru",
      query,
      paperContext,
      mineruCacheDir,
      guidance:
        "This is a table request for a MinerU-ready paper. Do not render PDF pages and do not use the figure-crop extractor. Call paper_read({ mode:'targeted', query:'<table label and surrounding discussion>' }) so the answer comes from MinerU table text, captions, and surrounding extracted text. Use direct file_io manifest/full.md inspection only for explicit filesystem/cache-inspection tasks.",
      nextSteps: [
        `paper_read({ mode:'targeted', query:'${query.replace(/'/g, "\\'")}' })`,
      ],
    };
  }
  return {
    mode: "visual",
    status: "use_figures_mode",
    backend: "pdf_figure_extraction",
    query,
    paperContext,
    mineruCacheDir,
    guidance:
      "This is a figure/image request for a MinerU-ready paper. Do not read MinerU image paths and do not use paper_read mode:'visual' for figure interpretation. Call paper_read({ mode:'figures', query:'<figure/table label or all figures>' }) to get precise PDF crops plus captions/provenance. Use mode:'visual' only for explicit raw/rendered PDF page or layout inspection.",
    nextSteps: [
      `paper_read({ mode:'figures', query:'${query.replace(/'/g, "\\'")}' })`,
    ],
  };
}

function normalizeMetadataValue(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function formatCreatorList(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const creators = value
    .map((creator) => {
      if (!creator || typeof creator !== "object") return "";
      const record = creator as Record<string, unknown>;
      const name = normalizeMetadataValue(record.name);
      if (name) return name;
      return [record.firstName, record.lastName]
        .map(normalizeMetadataValue)
        .filter(Boolean)
        .join(" ");
    })
    .filter(Boolean);
  return creators.join(", ");
}

function buildMetadataOverview(params: {
  paperContext: NonNullable<PdfTarget["paperContext"]>;
  context: AgentToolContext;
  zoteroGateway: ZoteroGateway;
  warning?: string;
}): unknown | null {
  const item = params.zoteroGateway.resolveMetadataItem({
    request: params.context.request,
    item: params.context.item,
    paperContext: params.paperContext,
  });
  const metadata = params.zoteroGateway.getEditableArticleMetadata(item);
  const fields = (metadata?.fields || {}) as Record<string, unknown>;
  const title =
    normalizeMetadataValue(metadata?.title) ||
    normalizeMetadataValue(params.paperContext.title) ||
    `Paper ${params.paperContext.itemId}`;
  const authors = formatCreatorList(metadata?.creators);
  const abstract = normalizeMetadataValue(fields.abstractNote);
  const lines = [
    `Title: ${title}`,
    authors ? `Authors: ${authors}` : "",
    normalizeMetadataValue(fields.date)
      ? `Date: ${normalizeMetadataValue(fields.date)}`
      : "",
    normalizeMetadataValue(fields.publicationTitle)
      ? `Publication: ${normalizeMetadataValue(fields.publicationTitle)}`
      : "",
    normalizeMetadataValue(fields.DOI)
      ? `DOI: ${normalizeMetadataValue(fields.DOI)}`
      : "",
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
    const chunkKind = normalizeString(result.chunkKind);
    if (chunkKind) passage.chunkKind = chunkKind;
    const pageLabel = normalizeString(result.pageLabel);
    if (pageLabel) passage.pageLabel = pageLabel;
    const quoteCitation = buildQuoteCitationFromResult(result);
    if (quoteCitation) passage.quoteCitationId = quoteCitation.id;
    const entries = groups.get(key) || [];
    entries.push(passage);
    groups.set(key, entries);
  }

  return targets.map((paperContext) => {
    const passages = groups.get(paperContextKey(paperContext)) || [];
    return {
      paperContext,
      status: passages.length ? "matched" : "no_matches",
      sourceKind: "paper_text",
      citationLabel: formatPaperCitationLabel(paperContext),
      sourceLabel: formatPaperSourceLabel(paperContext),
      passages,
    };
  });
}

function buildQuoteCitationFromResult(
  result: Record<string, unknown>,
): ReturnType<typeof buildQuoteCitation> {
  const paperContext = validateObject<Record<string, unknown>>(
    result.paperContext,
  )
    ? result.paperContext
    : undefined;
  return buildQuoteCitation({
    quoteText: result.text,
    citationLabel:
      normalizeString(result.sourceLabel) ||
      normalizeString(result.citationLabel),
    contextItemId: paperContext?.contextItemId,
    itemId: paperContext?.itemId,
  });
}

function buildQuoteCitationsForResults(
  results: Array<Record<string, unknown>>,
) {
  const citations: NonNullable<ReturnType<typeof buildQuoteCitation>>[] = [];
  for (const result of results) {
    const citation = buildQuoteCitationFromResult(result);
    if (citation) citations.push(citation);
  }
  return mergeQuoteCitations(citations);
}

function splitOverviewQuoteCandidates(text: string): string[] {
  const withoutChunkMarkers = text.replace(/^\s*\[chunk\s+\d+\]\s*$/gim, "");
  const blocks = withoutChunkMarkers
    .split(/\n{2,}/)
    .map((block) =>
      block
        .split("\n")
        .map((line) => line.replace(/^#{1,6}\s+/, "").trim())
        .filter(Boolean)
        .join(" "),
    )
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const sentences = block.match(/[^.!?。！？]+[.!?。！？]+(?=\s|$)/g) || [
      block,
    ];
    let candidate = "";
    for (const sentence of sentences) {
      const next = `${candidate}${candidate ? " " : ""}${sentence.trim()}`;
      if (next.length > MAX_OVERVIEW_QUOTE_CHARS) break;
      candidate = next;
      if (candidate.length >= MIN_OVERVIEW_QUOTE_CHARS) break;
    }
    candidate = candidate || block;
    if (
      candidate.length < MIN_OVERVIEW_QUOTE_CHARS ||
      candidate.length > MAX_OVERVIEW_QUOTE_CHARS
    ) {
      continue;
    }
    if (/^(?:title|authors?|date|publication|doi|abstract):/i.test(candidate)) {
      continue;
    }
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= MAX_OVERVIEW_QUOTES_PER_RESULT) break;
  }
  return out;
}

function buildOverviewQuoteCitationPack(
  results: Array<Record<string, unknown>>,
): {
  results: Array<Record<string, unknown>>;
  quoteCitations: QuoteCitation[];
} {
  const quoteCitations: QuoteCitation[] = [];
  const resultsWithAnchors = results.map((result) => {
    if (
      normalizeString(result.backend) === "zotero_metadata" ||
      normalizeString(result.sourceKind) === "zotero_metadata"
    ) {
      return result;
    }
    const paperContext = validateObject<Record<string, unknown>>(
      result.paperContext,
    )
      ? result.paperContext
      : undefined;
    const quoteTexts = splitOverviewQuoteCandidates(
      normalizeString(result.text) || "",
    );
    const resultCitations = quoteTexts
      .map((quoteText) =>
        buildQuoteCitation({
          quoteText,
          citationLabel:
            normalizeString(result.sourceLabel) ||
            normalizeString(result.citationLabel),
          contextItemId: paperContext?.contextItemId,
          itemId: paperContext?.itemId,
        }),
      )
      .filter((entry): entry is QuoteCitation => Boolean(entry));
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
    const sourceLabel = normalizeString(record?.sourceLabel);
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

async function hydrateMineruReadyFigureTargets(
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
    if (!attachmentInfoLoader) continue;
    const itemId = Math.floor(Number(target.itemId || 0));
    const contextItemId = Math.floor(Number(target.contextItemId || 0));
    if (!itemId || !contextItemId) continue;
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
    if (!mineruCacheDir) continue;
    hydrated.push({
      ...target,
      contentSourceMode: target.contentSourceMode || "mineru",
      mineruCacheDir,
    });
  }
  return hydrated;
}

async function readExplicitPageTargets(params: {
  input: PaperReadInput;
  targets: NonNullable<PdfTarget["paperContext"]>[];
  context: AgentToolContext;
  pdfPageService: PdfPageService;
}): Promise<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  for (const paperContext of params.targets) {
    const pageResult = await params.pdfPageService.readPageTexts({
      paperContext,
      request: params.context.request,
      pages: params.input.pages || [],
      neighborPages: params.input.neighborPages,
    });
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
  return {
    mode: params.input.mode,
    results,
    papers: buildTargetedPaperGroups(params.targets, results),
    quoteCitations: buildQuoteCitationsForResults(results),
  };
}

export function createPaperReadTool(
  pdfService: PdfService,
  retrievalService: RetrievalService,
  pdfPageService: PdfPageService,
  zoteroGateway: ZoteroGateway,
  figureExtractionService?: PaperReadFigureExtractionService,
): AgentToolDefinition<PaperReadInput, unknown> {
  const visualTool = createViewPdfPagesTool(pdfPageService, zoteroGateway);
  return {
    spec: {
      name: "paper_read",
      description:
        "Read content from the active or targeted paper through one semantic tool. Use mode:'overview' for main-message summaries, mode:'targeted' for textual evidence/sections/pages, mode:'figures' for precise extracted figures from MinerU-ready PDFs, mode:'visual' for rendered PDF pages/layout, and mode:'capture' for the currently visible Zotero reader page.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: {
            type: "string",
            enum: ["overview", "targeted", "figures", "visual", "capture"],
            description:
              "overview = summary/main message; targeted = text evidence by query/sections/pages; figures = precise extracted figures from MinerU-ready PDFs; visual = rendered PDF pages/layout; capture = current reader page.",
          },
          target: {
            type: "object",
            properties: {
              contextItemId: { type: "number" },
              itemId: { type: "number" },
              paperContext: PAPER_CONTEXT_REF_SCHEMA,
              attachmentId: { type: "string" },
              name: { type: "string" },
            },
            additionalProperties: false,
          },
          targets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                contextItemId: { type: "number" },
                itemId: { type: "number" },
                paperContext: PAPER_CONTEXT_REF_SCHEMA,
              },
              additionalProperties: false,
            },
          },
          query: { type: "string" },
          queryVariants: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional search probes such as translations, acronyms, notation variants, or technical equivalents.",
          },
          sections: { type: "array", items: { type: "string" } },
          pages: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "array", items: { type: "number" } },
            ],
          },
          neighborPages: { type: "number" },
          maxChars: { type: "number" },
          topK: { type: "number" },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
      exposure: "model",
      tier: "normal",
    },
    presentation: {
      label: "Read Paper",
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
          if (mode === "targeted") return "Reading targeted paper content";
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
      const input: PaperReadInput = {
        mode,
        target: normalizeTarget(args.target),
        targets: normalizeTargets(
          args.targets,
          mode === "overview" ? MAX_OVERVIEW_TARGETS : MAX_TARGETED_TARGETS,
        ),
        query: normalizeString(args.query),
        queryVariants: normalizeStringArray(args.queryVariants),
        sections: normalizeStringArray(args.sections),
        pages: normalizePages(args.pages),
        neighborPages: normalizePositiveInt(args.neighborPages),
        maxChars: normalizePositiveInt(args.maxChars),
        topK: normalizePositiveInt(args.topK),
      };
      if (mode === "visual" || mode === "capture") {
        const visualValidation = visualTool.validate(targetForPageTool(input));
        if (!visualValidation.ok) return fail(visualValidation.error);
        input.visualInput = visualValidation.value;
      }
      return ok(input);
    },
    async shouldRequireConfirmation(input, context) {
      if (input.mode !== "visual" && input.mode !== "capture") return false;
      return Boolean(
        await visualTool.shouldRequireConfirmation?.(
          input.visualInput as never,
          context,
        ),
      );
    },
    async createPendingAction(input, context) {
      if (input.mode !== "visual" && input.mode !== "capture") {
        throw new Error("Only visual and capture paper_read modes need review");
      }
      const action = await visualTool.createPendingAction!(
        input.visualInput as never,
        context,
      );
      return {
        ...action,
        toolName: "paper_read",
      };
    },
    applyConfirmation(input, resolutionData, context) {
      if (input.mode !== "visual" && input.mode !== "capture") return ok(input);
      const resolved = visualTool.applyConfirmation?.(
        input.visualInput as never,
        resolutionData,
        context,
      );
      if (!resolved) return ok(input);
      if (!resolved.ok) return fail(resolved.error);
      return ok({
        ...input,
        visualInput: resolved.value,
      });
    },
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
        return visualTool.execute(input.visualInput as never, context);
      }
      const targets = resolveDefaultTargets(
        input.target,
        input.targets,
        context,
        zoteroGateway,
        input.mode === "overview" ? MAX_OVERVIEW_TARGETS : MAX_TARGETED_TARGETS,
      );
      if (!targets.length) {
        throw new Error(describeNoDefaultPaperTarget(context.request));
      }
      if (input.mode === "figures") {
        if (isTableOnlyInterpretationRequest(input, context.request.userText)) {
          return {
            mode: "figures",
            status: "no_figures",
            query: input.query || context.request.userText || "",
            guidance:
              "Tables are handled through extracted MinerU text/table content, not the figure-crop extractor. Use paper_read mode:'targeted' with the table label and surrounding discussion.",
          };
        }
        const mineruTargets = await hydrateMineruReadyFigureTargets(
          targets,
          zoteroGateway,
        );
        if (!mineruTargets.length) {
          return {
            mode: "figures",
            status: "mineru_required",
            query: input.query || context.request.userText || "",
            warning:
              "Precise figure extraction is available only for MinerU-ready papers.",
          };
        }
        if (!figureExtractionService) {
          return {
            mode: "figures",
            status: "error",
            query: input.query || context.request.userText || "",
            warning: "Precise figure extraction service is not available.",
          };
        }
        const figureResult = await figureExtractionService.extractFigures({
          input,
          context,
          paperContexts: mineruTargets,
        });
        const { artifacts, ...content } = figureResult;
        return artifacts?.length ? { content, artifacts } : content;
      }
      if (input.mode === "overview") {
        const maxChars = input.maxChars || 6000;
        const results = [];
        for (const paperContext of targets) {
          const mineru = await tryReadMineruOverview(paperContext, maxChars);
          if (mineru && (mineru as { ok?: boolean }).ok !== false) {
            results.push(mineru);
            continue;
          }
          try {
            results.push(
              await pdfService.getOverviewExcerpt({ paperContext, maxChars }),
            );
          } catch (error) {
            const warning = combineWarnings(
              extractWarningText(mineru),
              error instanceof Error ? error.message : String(error),
            );
            const metadataOverview = buildMetadataOverview({
              paperContext,
              context,
              zoteroGateway,
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
        );
        return {
          mode: input.mode,
          results: overviewQuotePack.results,
          quoteCitations: overviewQuotePack.quoteCitations,
        };
      }

      if (input.pages?.length) {
        return readExplicitPageTargets({
          input,
          targets,
          context,
          pdfPageService,
        });
      }

      const question = [
        input.query || context.request.userText,
        input.sections?.length
          ? `Relevant sections: ${input.sections.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      for (const paper of targets) {
        await pdfService.ensurePaperContext(paper);
      }
      const results = await retrievalService.retrieveEvidence({
        papers: targets,
        question,
        queryVariants: input.queryVariants,
        model: context.request.model,
        apiBase: context.request.apiBase,
        apiKey: context.request.apiKey,
        authMode: context.request.authMode,
        providerProtocol: context.request.providerProtocol,
        reasoning: context.request.reasoning,
        topK: input.topK,
        perPaperTopK: input.topK,
      });
      return {
        mode: input.mode,
        results,
        papers: buildTargetedPaperGroups(
          targets,
          results as Array<Record<string, unknown>>,
        ),
        quoteCitations: buildQuoteCitationsForResults(
          results as Array<Record<string, unknown>>,
        ),
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
