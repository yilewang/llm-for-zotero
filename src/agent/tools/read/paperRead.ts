import type {
  AgentToolContext,
  AgentToolDefinition,
  AgentToolResult,
} from "../../types";
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
  resolveDefaultTargets,
} from "./pdfToolUtils";
import type { PdfTarget } from "./pdfToolUtils";
import { createViewPdfPagesTool } from "./viewPdfPages";

type PaperReadMode = "overview" | "targeted" | "visual" | "capture";

type PaperReadInput = {
  mode: PaperReadMode;
  target?: PdfTarget;
  targets?: PdfTarget[];
  query?: string;
  sections?: string[];
  pages?: number[];
  neighborPages?: number;
  maxChars?: number;
  topK?: number;
  visualInput?: unknown;
};

const MAX_OVERVIEW_TARGETS = 5;
const MAX_TARGETED_TARGETS = 10;

function normalizeMode(value: unknown): PaperReadMode {
  return value === "targeted" ||
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
    ...(input.pages?.length ? { pages: input.pages } : {}),
    ...(input.neighborPages ? { neighborPages: input.neighborPages } : {}),
    ...(input.mode === "capture" ? { capture: true } : {}),
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
  };
}

export function createPaperReadTool(
  pdfService: PdfService,
  retrievalService: RetrievalService,
  pdfPageService: PdfPageService,
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<PaperReadInput, unknown> {
  const visualTool = createViewPdfPagesTool(pdfPageService, zoteroGateway);
  return {
    spec: {
      name: "paper_read",
      description:
        "Read content from the active or targeted paper through one semantic tool. Use mode:'overview' for main-message summaries, mode:'targeted' for textual evidence/sections/pages, mode:'visual' for rendered figures/pages/layout, and mode:'capture' for the currently visible Zotero reader page.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: {
            type: "string",
            enum: ["overview", "targeted", "visual", "capture"],
            description:
              "overview = summary/main message; targeted = text evidence by query/sections/pages; visual = rendered PDF pages/figures/layout; capture = current reader page.",
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
        throw new Error("No paper context available for paper_read");
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
        return {
          mode: input.mode,
          results,
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
        apiBase: context.request.apiBase,
        apiKey: context.request.apiKey,
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
