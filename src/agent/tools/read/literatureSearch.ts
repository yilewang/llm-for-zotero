import { isEphemeralConversationKey } from "../../../shared/conversationKeySpace";
import type { PaperContextRef } from "../../../shared/types";
import type {
  AgentToolContext,
  AgentToolDefinition,
  AgentTraceDetail,
} from "../../types";
import {
  isOpenAlexRateLimit,
  LiteratureSearchService,
} from "../../services/literatureSearchService";
import {
  identifyLiteratureCandidates,
  MAX_DISCOVERY_COUNT,
  parseDiscoveryCount,
} from "../../services/literatureDiscovery";
import { ToolInputRejection } from "../execution/failure";
import { canShowLiteratureReview } from "./reviewLiterature";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import { outsidePaperId } from "../../context/outsidePaperRecords";
import {
  buildOutsideSearchReasonDetail,
  HOST_ACTION_SEARCH_NEED,
  OUTSIDE_SEARCH_NEED_MESSAGE,
  OUTSIDE_SEARCH_NEED_PROPERTIES,
  OUTSIDE_SEARCH_NEED_SENTENCE,
  OUTSIDE_SEARCH_STOP_NOTE,
  outsideSearchNeedError,
  REVIEW_SEARCH_NEED_CLAUSE,
  REVIEW_WITHOUT_CARD_NEED_MESSAGE,
} from "./outsideSearchNeed";
import {
  buildOutsideSearchNote,
  latchOutsideSearch,
  tracksOutsideSearchTurn,
  OPENALEX_RATE_LIMIT_MESSAGE,
  outsideSearchLatch,
  recordOutsideSearch,
} from "./outsideSearchLedger";
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

type LiteratureSearchMode =
  | "recommendations"
  | "references"
  | "citations"
  | "search"
  | "metadata";

type LiteratureSearchWorkflow = "answer" | "review";

type LiteratureSearchInput = {
  workflow: LiteratureSearchWorkflow;
  mode: LiteratureSearchMode;
  source?: "openalex" | "arxiv" | "europepmc";
  itemId?: number;
  paperContext?: PaperContextRef;
  doi?: string;
  title?: string;
  arxivId?: string;
  query?: string;
  author?: string;
  limit?: number;
  /** Discovery: the number of papers the user asked for. */
  count?: number;
  /**
   * Discovery: the papers are candidates for a literature review the Agent
   * will write, so the card asks whether to import and cite them or to cite
   * them without importing.
   */
  forLiteratureReview?: true;
  libraryID?: number;
  /**
   * The call claims need:'host_action': a host action (Discover related)
   * searched on the user's command. Execution honors it only when the action
   * executor built the call; then it is not one of the turn's outside
   * searches and never latches a provider.
   */
  hostAction?: true;
  /** A find-paper search's reason, checked where no card can open. */
  need?: unknown;
  gap?: unknown;
};

/**
 * The need check that depends on the caller, which validation cannot see:
 * only the action executor may claim host_action, and a find-paper search
 * skips the reason only where it can lead to the selection card.
 */
function callerNeedError(
  input: LiteratureSearchInput,
  context: AgentToolContext,
): string | null {
  if (input.mode === "metadata") return null;
  if (input.hostAction)
    return context.hostAction ? null : OUTSIDE_SEARCH_NEED_MESSAGE;
  if (input.workflow !== "review" || canShowLiteratureReview(context))
    return null;
  return outsideSearchNeedError({ need: input.need, gap: input.gap })
    ? REVIEW_WITHOUT_CARD_NEED_MESSAGE
    : null;
}

/** How the turn's outside-search ledger names a call. */
function literatureQueryLabel(input: LiteratureSearchInput): string {
  const source =
    input.source && input.source !== "openalex" ? ` [${input.source}]` : "";
  if (input.mode === "search") {
    const query = input.query || input.title || "";
    const author = input.author ? `author:${input.author}` : "";
    return `${[query, author].filter(Boolean).join(" ")}${source}`;
  }
  const seed =
    input.doi ||
    input.title ||
    input.arxivId ||
    input.query ||
    (input.itemId ? `item ${input.itemId}` : "the turn's paper");
  return `${input.mode} for ${seed}${source}`;
}

/**
 * The source and author rules, in the description the plugin Agent reads and
 * in the MCP description (server.ts). validate() already moves the
 * recommendations, references and citations modes to OpenAlex; this tells
 * the model which source suits a search.
 */
export const LITERATURE_SOURCE_SENTENCE =
  "Search mode can use source:'arxiv' (preprints) or source:'europepmc' (biomedical); recommendations, references and citations always use OpenAlex. Put author names in author, not in query.";

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
  const reason = buildOutsideSearchReasonDetail(input);
  if (reason) details.push(reason);

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

export function createLiteratureSearchTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<LiteratureSearchInput, unknown> {
  const service = new LiteratureSearchService(zoteroGateway);
  return {
    spec: {
      name: "literature_search",
      description:
        "Search scholarly sources outside the library. Use workflow:'answer' for any search that informs an answer, including whether other studies found or tested something, and explicit imports (then library_import). Use workflow:'review' when the user asks for papers themselves (find, recommend or suggest papers; with nothing attached, only if the library holds no relevant papers or the user asks for papers outside it); it leads to the selection card (literature_review); discovery never imports silently. A literature review that needs outside papers finds them with workflow:'review' and forLiteratureReview:true. To read a paper's abstract or full text, use literature_read. workflow:'review' with mode:'metadata' proposes changes to approve; use it only when the user asks to check or fix an item's metadata. " +
        OUTSIDE_SEARCH_NEED_SENTENCE +
        `; ${REVIEW_SEARCH_NEED_CLAUSE}; mode:'metadata' needs none. ` +
        LITERATURE_SOURCE_SENTENCE,
      inputSchema: {
        type: "object",
        required: ["mode"],
        additionalProperties: false,
        properties: {
          workflow: {
            type: "string",
            enum: ["answer", "review"],
            description:
              "answer returns scholarly evidence. review marks discovery candidates for subsequent ranking and literature_review; with mode:'metadata' it proposes metadata changes for the user to approve.",
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
          count: {
            type: "integer",
            minimum: 1,
            maximum: MAX_DISCOVERY_COUNT,
            description:
              "workflow:'review': papers the user asked for, five when unspecified.",
          },
          forLiteratureReview: {
            type: "boolean",
            description:
              "workflow:'review': true when the papers are candidates for a literature review you will write.",
          },
          libraryID: { type: "number" },
          ...OUTSIDE_SEARCH_NEED_PROPERTIES,
        },
      },
      executionClass: "read",
      workCategory: "retrieval",
    },
    presentation: {
      label: "Search Literature",
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
          const unavailable = (content as { unavailable?: unknown } | undefined)
            ?.unavailable;
          if (unavailable) return "Online search unavailable this turn";
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
          ? (args.mode as LiteratureSearchMode)
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
        return fail(
          "search mode requires query, title, or author; to read one paper by DOI, PMID, PMCID or arXiv ID, use literature_read.",
        );
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
      const count = parseDiscoveryCount(args.count);
      if (count === null)
        return fail(
          `count must be an integer from 1 to ${MAX_DISCOVERY_COUNT}.`,
        );
      // A metadata lookup identifies a known item; every other mode brings
      // outside evidence and states why the turn and library cannot hold it.
      // Execution checks the two exemptions against the caller.
      const needError =
        mode === "metadata"
          ? null
          : outsideSearchNeedError(args, {
              review: workflow === "review",
              acceptsHostAction: true,
            });
      if (needError) return fail(needError);

      return ok<LiteratureSearchInput>({
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
        count,
        libraryID: normalizePositiveInt(args.libraryID),
        ...(args.need === HOST_ACTION_SEARCH_NEED
          ? { hostAction: true as const }
          : {}),
        ...(workflow === "review" && mode !== "metadata"
          ? { need: args.need, gap: args.gap }
          : {}),
        ...(workflow === "review" &&
        mode !== "metadata" &&
        args.forLiteratureReview === true
          ? { forLiteratureReview: true as const }
          : {}),
      });
    },
    planInvocation: (input, context) => {
      // Nothing has run yet, so a refused need is an input rejection, not a
      // failing tool; it is checked before authorization and receipts.
      const needError = callerNeedError(input, context);
      if (needError) throw new ToolInputRejection(needError);
      return readOnlyInvocationPlan({
        domains: ["network"],
        effects: ["read", "egress"],
        targets: input.query ? [input.query] : [],
        reason:
          "The literature provider receives the query and returns public metadata without changing Zotero.",
      });
    },
    execute: async (input, context) => {
      // The turn's outside searches: not a metadata lookup or a host action.
      const turn =
        input.mode === "metadata" ||
        input.hostAction ||
        !tracksOutsideSearchTurn(context.runId)
          ? undefined
          : context.runId;
      const usesOpenAlex = (input.source ?? "openalex") === "openalex";
      const latched =
        turn && usesOpenAlex ? outsideSearchLatch(turn, "openalex") : undefined;
      if (latched)
        return {
          workflow: "answer",
          mode: input.mode,
          results: [],
          source: "OpenAlex",
          unavailable: "rate_limited",
          message: latched,
          nextStep: latched,
        };
      if (turn)
        recordOutsideSearch(turn, "scholarly", literatureQueryLabel(input));
      let results: Awaited<ReturnType<LiteratureSearchService["execute"]>>;
      try {
        results = await service.execute(input, context);
      } catch (error) {
        if (turn && isOpenAlexRateLimit(error)) {
          latchOutsideSearch(turn, "openalex", OPENALEX_RATE_LIMIT_MESSAGE);
          throw new Error(OPENALEX_RATE_LIMIT_MESSAGE);
        }
        throw error;
      }
      const content: Record<string, unknown> = {
        workflow: input.mode === "metadata" ? input.workflow : "answer",
        mode: input.mode,
        ...((results && typeof results === "object"
          ? results
          : { results }) as object),
      };
      if (input.mode === "metadata") return content;
      // Each paper's paperId: a document cites an outside paper by it.
      if (Array.isArray(content.results)) {
        content.results = content.results.map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry))
            return entry;
          const paperId = outsidePaperId(
            entry as Record<string, unknown>,
            [],
            context.request,
          );
          return paperId ? { ...entry, paperId } : entry;
        });
      }
      // Route explicit imports only where the caller can open the card (MCP
      // never offers literature_review).
      return identifyLiteratureCandidates(
        content,
        context,
        input.workflow === "review" && canShowLiteratureReview(context),
        canShowLiteratureReview(context),
        input.count,
        turn
          ? buildOutsideSearchNote(turn, "scholarly")
          : OUTSIDE_SEARCH_STOP_NOTE,
        input.forLiteratureReview,
      );
    },
    // A temporary side chat is read-only: its Apply would be refused, so it
    // shows no metadata card and the proposed changes reach the model as text.
    createResultReviewAction: (input, result, context) =>
      input.mode === "metadata" &&
      input.workflow === "review" &&
      !isEphemeralConversationKey(context.request.conversationKey)
        ? createSearchLiteratureReviewAction(
            result,
            context,
            input,
            zoteroGateway,
          )
        : null,
    resolveResultReview: (input, result, resolution, context) =>
      resolveSearchLiteratureReview(
        input,
        result,
        resolution,
        context,
        zoteroGateway,
      ),
  };
}
