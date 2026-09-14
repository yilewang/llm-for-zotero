import type { PaperContextRef } from "../../../shared/types";
import type {
  AgentRuntimeRequest,
  AgentToolContext,
  AgentToolDefinition,
  AgentTraceDetail,
} from "../../types";
import { LiteratureSearchService } from "../../services/literatureSearchService";
import { identifyLiteratureCandidates } from "../../services/literatureDiscovery";
import {
  isExplicitLiteratureImport,
  isLiteratureDiscovery,
} from "../../model/literatureIntent";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import {
  createSearchLiteratureReviewAction,
  resolveSearchLiteratureReview,
} from "../../reviewCards";
import {
  fail,
  normalizePositiveInt,
  normalizeToolPaperContext,
  ok,
  PAPER_CONTEXT_REF_SCHEMA,
  validateObject,
} from "../shared";

type SearchLiteratureOnlineMode =
  | "recommendations"
  | "references"
  | "citations"
  | "search"
  | "metadata";

type SearchLiteratureOnlineWorkflow = "answer" | "review";

export const LITERATURE_WORKFLOW_GUIDANCE =
  "Use literature_search to retrieve scholarly candidates, not to present a raw result pool. When the user only asks to find/recommend relevant papers, read the current paper, search and assess titles/abstracts, then call literature_review with the requested number (five when unspecified) of ranked candidate references and short evidence-based relevance reasons. Search further if results are weak; never pad a shortlist. Respect explicit references/citations/source constraints. A Find more continuation requests another batch of the original size: assess unused saved candidates first, then search further as needed, and submit only new candidates with the provided sessionId and revision. The paper-only import-selection card is required in Safe, Auto and YOLO, and discovery never imports silently. Explicit import requests instead use workflow:'answer' to gather and rank candidates, skip existing duplicates, then call library_import for exactly the requested number and destination. Central mutation authorization handles Safe confirmation and direct Auto/YOLO execution. Do not substitute a discovery card for an explicit import. Use workflow:'answer' for evidence supporting an answer/review document; only metadata review continues to use workflow:'review', mode:'metadata'.";

type SearchLiteratureOnlineInput = {
  workflow: SearchLiteratureOnlineWorkflow;
  mode: SearchLiteratureOnlineMode;
  source?: "openalex" | "arxiv" | "europepmc";
  itemId?: number;
  paperContext?: PaperContextRef;
  doi?: string;
  title?: string;
  arxivId?: string;
  query?: string;
  author?: string;
  limit?: number;
  libraryID?: number;
};

export function matchesLiteratureSearchGuidance(
  request: Pick<AgentRuntimeRequest, "classifiedIntent">,
): boolean {
  const intent = request.classifiedIntent?.externalSearchIntent;
  if (intent !== undefined) {
    return intent === "literature" || intent === "both";
  }
  return false;
}

function readTraceString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildLiteratureTraceUrl(
  result: Record<string, unknown>,
): string | undefined {
  const directUrl =
    readTraceString(result.openAccessUrl) || readTraceString(result.sourceUrl);
  if (directUrl) return directUrl;
  const doi = readTraceString(result.doi)?.replace(
    /^https?:\/\/(?:dx\.)?doi\.org\//i,
    "",
  );
  return doi ? `https://doi.org/${doi}` : undefined;
}

function buildLiteratureTraceCreator(
  paper: Record<string, unknown>,
  patch: Record<string, unknown>,
): string {
  const authors = Array.isArray(paper.authors)
    ? paper.authors.map(readTraceString).filter(Boolean)
    : [];
  if (authors.length) {
    return `${authors[0]}${authors.length > 1 ? " et al." : ""}`;
  }

  const creators = Array.isArray(patch.creators) ? patch.creators : [];
  for (const entry of creators) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const creator = entry as Record<string, unknown>;
    const name =
      readTraceString(creator.name) ||
      [readTraceString(creator.firstName), readTraceString(creator.lastName)]
        .filter(Boolean)
        .join(" ");
    if (name) return name;
  }
  return "Unknown creator";
}

function buildLiteratureTraceYear(
  paper: Record<string, unknown>,
  patch: Record<string, unknown>,
): string {
  if (typeof paper.year === "number" && Number.isFinite(paper.year)) {
    return String(Math.trunc(paper.year));
  }
  const explicitYear = readTraceString(paper.year);
  if (explicitYear && /^\d{4}$/.test(explicitYear)) return explicitYear;
  const date = readTraceString(patch.date);
  return date?.match(/\b\d{4}\b/)?.[0] || "n.d.";
}

function buildLiteratureTraceDetails(
  args: unknown,
  content: unknown,
): AgentTraceDetail[] {
  const input =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const result =
    content && typeof content === "object" && !Array.isArray(content)
      ? (content as Record<string, unknown>)
      : {};
  const details: AgentTraceDetail[] = [];
  const query =
    readTraceString(input.query) ||
    readTraceString(input.title) ||
    readTraceString(input.author);
  if (query) details.push({ label: "Query", value: query });

  const results = Array.isArray(result.results) ? result.results : [];
  for (const entry of results) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const paper = entry as Record<string, unknown>;
    const patch =
      paper.patch &&
      typeof paper.patch === "object" &&
      !Array.isArray(paper.patch)
        ? (paper.patch as Record<string, unknown>)
        : {};
    const title =
      readTraceString(paper.title) ||
      readTraceString(paper.displayTitle) ||
      readTraceString(patch.title);
    if (!title) continue;
    const creator = buildLiteratureTraceCreator(paper, patch);
    const year = buildLiteratureTraceYear(paper, patch);
    const value = `${creator}, ${year}, ${title}`;
    const href = buildLiteratureTraceUrl({ ...patch, ...paper });
    details.push({
      label: "Paper",
      value,
      timeline: { icon: "paper", ...(href ? { href } : {}) },
    });
  }
  return details;
}

export function createSearchLiteratureOnlineTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<SearchLiteratureOnlineInput, unknown> {
  const service = new LiteratureSearchService(zoteroGateway);
  return {
    spec: {
      name: "search_literature_online",
      description:
        "Search scholarly sources and return saved candidate references for ranking. Use literature_review afterward for discovery selection, or library_import directly for an explicit import request. Metadata review uses workflow:'review', mode:'metadata'.",
      inputSchema: {
        type: "object",
        required: ["mode"],
        additionalProperties: false,
        properties: {
          workflow: {
            type: "string",
            enum: ["answer", "review"],
            description:
              "answer returns scholarly evidence. review marks discovery candidates for subsequent ranking and literature_review; only mode:'metadata' opens review immediately.",
          },
          mode: {
            type: "string",
            enum: [
              "recommendations",
              "references",
              "citations",
              "search",
              "metadata",
            ],
          },
          source: {
            type: "string",
            enum: ["openalex", "arxiv", "europepmc"],
            description:
              "Search source. OpenAlex (default) supports all modes. arXiv (preprints, CS/ML/physics) and europepmc (biomedical) only support search mode.",
          },
          itemId: { type: "number" },
          paperContext: PAPER_CONTEXT_REF_SCHEMA,
          doi: { type: "string" },
          title: { type: "string" },
          arxivId: { type: "string" },
          query: { type: "string" },
          author: {
            type: "string",
            description:
              "Author name to filter results by. When provided alone (without query), returns the author's papers sorted by citation count. When combined with query, narrows keyword results to this author.",
          },
          limit: { type: "number" },
          libraryID: { type: "number" },
        },
      },
      executionClass: "read",
      requiresConfirmation: false,
    },
    guidance: {
      matches: matchesLiteratureSearchGuidance,
      instruction:
        LITERATURE_WORKFLOW_GUIDANCE +
        "\n\nSource selection:" +
        "\n• recommendations, references, citations modes → always use source:'openalex' (only OpenAlex supports these)." +
        "\n• search mode → source:'openalex' (default, broadest coverage), source:'arxiv' (preprints, CS/ML/physics), or source:'europepmc' (biomedical/life sciences)." +
        "\n\nAuthor search:" +
        "\n• When the user wants papers by a specific author, use the 'author' parameter (e.g. author:'Adrien Peyrache')." +
        "\n• You can combine 'author' with 'query' to find an author's papers on a specific topic." +
        "\n• Do NOT put author names in the 'query' parameter — use 'author' instead.",
    },
    presentation: {
      label: "Search Literature Online",
      traceIcon: "library",
      mergeResultIntoCallTrace: true,
      buildTraceDetails: ({ args, content }) =>
        buildLiteratureTraceDetails(args, content),
      summaries: {
        onCall: ({ args }) => {
          const a =
            args && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {};
          const mode = String(a.mode || "search");
          const author = typeof a.author === "string" ? a.author : undefined;
          const query = typeof a.query === "string" ? a.query : undefined;
          const detail =
            author && query ? `${query} by ${author}` : author || query || mode;
          return `Searching live literature (${detail})`;
        },
        onSuccess: ({ content }) => {
          const results =
            content &&
            typeof content === "object" &&
            Array.isArray((content as { results?: unknown[] }).results)
              ? (content as { results: unknown[] }).results
              : [];
          return results.length > 0
            ? `Found ${results.length} online result${results.length === 1 ? "" : "s"}`
            : "No online results found";
        },
        onPending: "Waiting for your review of the online search results",
        onApproved:
          "Review received - continuing with the selected literature action",
        onDenied: "Stopped after reviewing the online search results",
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const itemId = normalizePositiveInt(args.itemId);
      const mode =
        args.mode === "recommendations" ||
        args.mode === "references" ||
        args.mode === "citations" ||
        args.mode === "search" ||
        args.mode === "metadata"
          ? (args.mode as SearchLiteratureOnlineMode)
          : null;
      if (!mode) {
        return fail("mode is required");
      }
      const paperContext = validateObject<Record<string, unknown>>(
        args.paperContext,
      )
        ? normalizeToolPaperContext(args.paperContext) || undefined
        : undefined;
      const query =
        typeof args.query === "string" && args.query.trim()
          ? args.query.trim()
          : undefined;
      const title =
        typeof args.title === "string" && args.title.trim()
          ? args.title.trim()
          : undefined;
      const doi =
        typeof args.doi === "string" && args.doi.trim()
          ? args.doi.trim()
          : undefined;
      const arxivId =
        typeof args.arxivId === "string" && args.arxivId.trim()
          ? args.arxivId.trim()
          : undefined;
      if (
        mode === "metadata" &&
        !doi &&
        !title &&
        !arxivId &&
        !query &&
        !itemId &&
        !paperContext
      ) {
        return fail(
          "metadata mode requires doi, title, arxivId, query, itemId, or paperContext",
        );
      }
      const author =
        typeof args.author === "string" && args.author.trim()
          ? args.author.trim()
          : undefined;
      if (mode === "search" && !query && !title && !author) {
        return fail("search mode requires query, title, or author");
      }
      // Only OpenAlex supports recommendations, references, and citations.
      // Auto-correct source for these modes to prevent silent degradation.
      const requiresOpenAlex =
        mode === "recommendations" ||
        mode === "references" ||
        mode === "citations";
      const rawSource =
        args.source === "openalex" ||
        args.source === "arxiv" ||
        args.source === "europepmc"
          ? args.source
          : undefined;
      const source = requiresOpenAlex ? "openalex" : rawSource;
      const workflow =
        args.workflow === "review" || args.workflow === "answer"
          ? args.workflow
          : "answer";

      return ok<SearchLiteratureOnlineInput>({
        workflow,
        mode,
        source,
        itemId,
        paperContext,
        doi,
        title,
        arxivId,
        query,
        author,
        limit: normalizePositiveInt(args.limit),
        libraryID: normalizePositiveInt(args.libraryID),
      });
    },
    planInvocation: (input) =>
      readOnlyInvocationPlan({
        domains: ["network"],
        effects: ["read", "egress"],
        targets: input.query ? [input.query] : [],
        reason:
          "The literature provider receives the query and returns public metadata without changing Zotero.",
      }),
    execute: async (input, context) => {
      const results = await service.execute(input, context);
      const content = {
        workflow: input.mode === "metadata" ? input.workflow : "answer",
        mode: input.mode,
        ...((results && typeof results === "object"
          ? results
          : { results }) as object),
      };
      if (input.mode === "metadata") return content;
      return identifyLiteratureCandidates(
        content,
        context,
        !isExplicitLiteratureImport(context.request) &&
          (isLiteratureDiscovery(context.request) ||
            input.workflow === "review"),
      );
    },
    createResultReviewAction: (input, result, context) =>
      input.mode === "metadata" && input.workflow === "review"
        ? createSearchLiteratureReviewAction(result, context, input)
        : null,
    resolveResultReview: (input, result, resolution, context) =>
      resolveSearchLiteratureReview(input, result, resolution, context),
  };
}
