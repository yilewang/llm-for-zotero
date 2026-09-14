import {
  formatPaperDisplayLabel,
  type PaperDisplayMetadata,
} from "../../../shared/paperDisplayLabels";
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
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import { joinLocalPath } from "../../../utils/localPath";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../../modules/contextPanel/paperAttribution";
import { stripMineruSourceImageEmbedsFromMarkdown } from "../../../modules/contextPanel/mineruCache";
import {
  buildQuoteCitation,
  mergeQuoteCitations,
} from "../../../modules/contextPanel/quoteCitations";
import { fail, normalizePositiveInt, ok, validateObject } from "../shared";
import {
  PAPER_TARGET_SELECTOR_SCHEMA,
  buildCaptureFollowupMessage,
  semanticPdfMode,
  normalizeExplicitTargetSyntax,
  describeNoDefaultPaperTarget,
  resolveDefaultTargets,
} from "./pdfToolUtils";
import type { PdfTarget } from "./pdfToolUtils";
import { createViewPdfPagesTool } from "./viewPdfPages";
import {
  readDocumentsExhaustively,
  type ExhaustiveBatchAnalyzer,
  type FullReadCoverageReceipt,
  type FullReadPaperResult,
} from "../../../shared/exhaustiveDocumentReader";
import { getTurnPapersWithRoles } from "../../context/requestTurnPaperScope";
import { createCodexAppServerExhaustiveReaderSession } from "../../../codexAppServer/exhaustiveReader";
import { createZoteroMetadataResolver } from "../../../services/zoteroMetadata/resolver";
import { projectPaperMetadata } from "../../../services/zoteroMetadata/projections";
import type {
  ProjectedPaperMetadata,
  ZoteroMetadataResolver,
} from "../../../services/zoteroMetadata/types";
import { resolveOutputReserve } from "../../../utils/outputTokenPolicy";
import { resolveAdaptiveReadingBudget } from "../../research/readingBudget";

type PaperReadMode =
  | "overview"
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

export type PaperReadFullResult = {
  mode: "full";
  status: "complete" | "partial" | "unreadable";
  papers: (FullReadPaperResult & { displayLabel: string })[];
  coverageReceipt: FullReadCoverageReceipt;
  synthesisContext: string;
  warnings: string[];
};

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
const MIN_OVERVIEW_QUOTE_CHARS = 40;
const MAX_OVERVIEW_QUOTE_CHARS = 360;

function normalizeMode(value: unknown): PaperReadMode {
  return value === "targeted" ||
    value === "full" ||
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

function dedupePaperContexts(
  paperContexts: NonNullable<PdfTarget["paperContext"]>[],
): NonNullable<PdfTarget["paperContext"]>[] {
  const seen = new Set<string>();
  return paperContexts.filter((paperContext) => {
    const key = `${paperContext.libraryID || 0}:${paperContext.itemId}:${paperContext.contextItemId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function hasApprovedFullReadAuthorization(
  request: AgentToolContext["request"],
): boolean {
  return Boolean(
    request.planContext?.phase === "executing" &&
    request.actionContract?.obligations.some(
      (obligation) => obligation.operation === "read_full",
    ),
  );
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
  if (
    request.classifiedIntent?.semantic?.reading.coverage !== "exhaustive" &&
    !hasApprovedFullReadAuthorization(request)
  ) {
    throw new Error(
      "Exhaustive reading requires a resolved semantic reading intent or approved full-read contract.",
    );
  }
  const available = dedupePaperContexts(
    params.zoteroGateway.listPaperContexts(request),
  );
  const obligations =
    request.actionContract?.obligations.filter(
      (entry) => entry.operation === "read_full",
    ) || [];
  const ids = obligations.flatMap(
    (entry) =>
      entry.targetBoundary?.frozenTargetIds ||
      entry.targetSelectors?.flatMap((selector) =>
        selector.kind === "item_id" ? [selector.value] : [],
      ) ||
      [],
  );
  const intendedTargets = ids.length
    ? available.filter((paper) => ids.includes(paper.itemId))
    : request.classifiedIntent?.paperTargetIntent === "all_visible"
      ? available
      : request.classifiedIntent?.paperTargetIntent === "added"
        ? getTurnPapersWithRoles(request, ["selected"])
        : getTurnPapersWithRoles(request, ["active"]).slice(0, 1);
  if (!intendedTargets.length)
    throw new Error("The requested full-read targets are unresolved.");
  if (explicitTargets.length) {
    const intendedKeys = new Set(
      intendedTargets.map(
        (paperContext) =>
          `${paperContext.libraryID || 0}:${paperContext.itemId}:${paperContext.contextItemId}`,
      ),
    );
    const explicitKeys = new Set(
      explicitTargets.map(
        (paperContext) =>
          `${paperContext.libraryID || 0}:${paperContext.itemId}:${paperContext.contextItemId}`,
      ),
    );
    const targetsAgree =
      intendedKeys.size === explicitKeys.size &&
      [...intendedKeys].every((key) => explicitKeys.has(key));
    if (!targetsAgree) {
      throw new Error(
        `The explicit paper_read full target conflicts with the user's requested paper scope. Requested: ${intendedTargets.map((paperContext) => paperContext.title).join("; ")}. Tool supplied: ${explicitTargets.map((paperContext) => paperContext.title).join("; ")}. Omit target/targets or retry with the requested papers.`,
      );
    }
  }
  return [...intendedTargets];
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
  if (
    params.input.pages?.length ||
    params.context.request.classifiedIntent?.semantic?.reading.source ===
      "rendered_pages"
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
  const paperContext = targets[0] || null;
  const mineruCacheDir = normalizeString(paperContext?.mineruCacheDir);
  if (!paperContext) return null;
  const query = params.input.query || params.context.request.userText || "";
  if (
    params.context.request.classifiedIntent?.semantic?.figures?.kind ===
    "tables"
  ) {
    if (!mineruCacheDir) return null;
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
    const quoteCitations = buildQuoteCitationsFromResult(result);
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
    sourceMatchSource:
      pageHintIndex === undefined ? "context-text" : "pdf-page-text",
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

function buildQuoteCitationsFromResult(
  result: Record<string, unknown>,
): QuoteCitation[] {
  const resultText = normalizeString(result.text) || "";
  const candidates = splitOverviewQuoteCandidates(resultText);
  const quoteTexts = candidates.length ? candidates : [resultText];
  return quoteTexts
    .map((quoteText) => buildQuoteCitationFromResult(result, quoteText))
    .filter((entry): entry is QuoteCitation => Boolean(entry));
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
    const quoteTexts = splitOverviewQuoteCandidates(
      normalizeString(result.text) || "",
    );
    const resultCitations = quoteTexts
      .map((quoteText) => buildQuoteCitationFromResult(result, quoteText))
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

async function readExplicitPageTargets(params: {
  input: PaperReadInput;
  targets: NonNullable<PdfTarget["paperContext"]>[];
  context: AgentToolContext;
  pdfPageService: PdfPageService;
}): Promise<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  const quoteCitations: QuoteCitation[] = [];
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
    papers: buildTargetedPaperGroups(params.targets, results, quoteCitations),
    quoteCitations: mergeQuoteCitations(quoteCitations),
  };
}

export function createPaperReadTool(
  pdfService: PdfService,
  retrievalService: RetrievalService,
  pdfPageService: PdfPageService,
  zoteroGateway: ZoteroGateway,
  figureExtractionService?: PaperReadFigureExtractionService,
  fullReadAnalyzer?: ExhaustiveBatchAnalyzer,
): AgentToolDefinition<PaperReadInput, unknown> {
  const visualTool = createViewPdfPagesTool(pdfPageService, zoteroGateway);
  return {
    spec: {
      name: "paper_read",
      description:
        "Read content from the active or targeted paper through one semantic tool. Provide target or targets, never both; omit both to use the current turn's paper scope. Use mode:'overview' for bounded summaries, mode:'targeted' for relevance-ranked textual evidence, mode:'full' only when the user explicitly requests exhaustive full-text reading, mode:'figures' for precise extracted figures from Zotero library PDFs, mode:'visual' for rendered PDF pages/layout, and mode:'capture' for the currently visible Zotero reader page.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: {
            type: "string",
            enum: [
              "overview",
              "targeted",
              "full",
              "figures",
              "visual",
              "capture",
            ],
            description:
              "overview = bounded summary/main message; targeted = relevance-ranked text evidence; full = exhaustive processing of every extractable text chunk for an explicit full-read request; figures = precise extracted figures; visual = rendered pages/layout; capture = current reader page.",
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
      executionClass: "read",
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
        return visualTool.execute(input.visualInput as never, context);
      }
      // Inside an approved research plan the host manifest owns reading
      // depth: overview already delivers each paper's host-sized text at the
      // required depth, so an explicit "full" read of manifest targets is
      // served as overview instead of failing on missing full-read authority.
      const servedFullAsOverview =
        input.mode === "full" &&
        context.request.planContext?.phase === "executing" &&
        Boolean(input.target || input.targets?.length);
      const mode: PaperReadMode = servedFullAsOverview
        ? "overview"
        : input.mode;
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
        if (
          context.request.classifiedIntent?.semantic?.figures?.kind === "tables"
        ) {
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
          };
        }
        const figureResult = await figureExtractionService.extractFigures({
          input,
          context,
          paperContexts: figureTargets,
        });
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
        if (
          !fullReadAnalyzer &&
          context.request.authMode === "codex_app_server" &&
          (!nativeFullReadModel || nativeFullReadModel === "codex-app-server")
        ) {
          throw new Error(
            "Exhaustive paper reading cannot run because the Codex tool-free full-read backend has no selected model.",
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
        const nativeReaderSession =
          !fullReadAnalyzer && context.request.authMode === "codex_app_server"
            ? createCodexAppServerExhaustiveReaderSession({
                model: nativeFullReadModel,
                reasoning: context.request.reasoning,
                profileOverride: context.request.advanced?.profileOverride,
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
              batchTokenBudget: Math.max(1024, Math.floor(inputTokenCap * 0.5)),
              finalTokenBudget: Math.max(
                1024,
                Math.floor(inputTokenCap * 0.45),
              ),
              analyzeBatch:
                fullReadAnalyzer || nativeReaderSession?.analyzeBatch,
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
        const output: PaperReadFullResult = {
          mode: "full",
          status: result.status,
          papers: result.papers.map((paper) => ({
            ...paper,
            displayLabel: displayLabelFor(paper.paperContext),
          })),
          coverageReceipt: result.receipt,
          synthesisContext: result.contextText,
          warnings: result.warnings,
        };
        return output;
      }
      if (mode === "overview") {
        const runtimeBudget = context.request.runtimeContextBudget;
        const adaptiveBudget = runtimeBudget
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
        const maxChars =
          input.maxChars || adaptiveBudget?.maxCharactersPerPaper || 6000;
        const results = [];
        const metadataResolver = createZoteroMetadataResolver({
          getItem: (itemId) => zoteroGateway.getItem(itemId),
        });
        for (const paperContext of targets) {
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
        );
        const coverageKinds = overviewQuotePack.results.map((result) =>
          String((result as Record<string, unknown>).coverage || "unknown"),
        );
        return {
          mode,
          ...(servedFullAsOverview
            ? {
                readingNote:
                  "mode 'full' was served as 'overview': inside an approved research plan the host manifest owns reading depth, and overview delivers each paper's host-sized text at the required depth. Record these papers with research_update record_papers.",
              }
            : {}),
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
        intent: context.request.classifiedIntent,
        papers: targets,
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
      });
      const quoteCitations: QuoteCitation[] = [];
      return {
        mode,
        results,
        papers: buildTargetedPaperGroups(
          targets,
          results as Array<Record<string, unknown>>,
          quoteCitations,
        ),
        quoteCitations: mergeQuoteCitations(quoteCitations),
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
