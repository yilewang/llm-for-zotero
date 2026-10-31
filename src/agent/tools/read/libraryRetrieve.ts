import type { AgentToolDefinition, AgentToolGuidance } from "../../types";
import { buildLibraryRetrieveModelView } from "../../services/libraryRetrieveModelView";
import { modelViewRoomTokens } from "./modelViewRoom";
import { matchesLibraryLevelTurn } from "./librarySearch";
import {
  LIBRARY_RETRIEVE_DEFAULT_BUDGETS,
  LIBRARY_RETRIEVE_HARD_CAPS,
  type LibraryRetrieveDepth,
  type LibraryRetrieveInput,
  type LibraryRetrieveIntent,
  type LibraryRetrieveMethod,
  type LibraryRetrieveResult,
  type LibraryRetrieveService,
} from "../../services/libraryRetrieveService";
import {
  fail,
  normalizePositiveInt,
  normalizePositiveIntArray,
  ok,
  validateObject,
} from "../shared";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import {
  EVIDENCE_SECTION_KINDS,
  type EvidenceSectionKind,
} from "../../../shared/libraryChatEvidencePolicy";

const VALID_SECTION = new Set<string>(EVIDENCE_SECTION_KINDS);

const VALID_DEPTH = new Set<LibraryRetrieveDepth>([
  "pool",
  "metadata",
  "evidence",
  "verify",
]);

const VALID_METHOD = new Set<LibraryRetrieveMethod>([
  "metadata",
  "abstract",
  "exact",
  "fts",
  "semantic",
]);

const VALID_INTENT = new Set<LibraryRetrieveIntent>([
  "enumerate",
  "verify",
  "summarize",
]);

function normalizeDepth(value: unknown): LibraryRetrieveDepth | undefined {
  return typeof value === "string" &&
    VALID_DEPTH.has(value as LibraryRetrieveDepth)
    ? (value as LibraryRetrieveDepth)
    : undefined;
}

function normalizeMethods(value: unknown): LibraryRetrieveMethod[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const methods = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry): entry is LibraryRetrieveMethod =>
      VALID_METHOD.has(entry as LibraryRetrieveMethod),
    );
  return methods.length ? Array.from(new Set(methods)) : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return entries.length ? Array.from(new Set(entries)) : undefined;
}

function sectionKind(entry: unknown): EvidenceSectionKind | undefined {
  const kind = typeof entry === "string" ? entry.trim().toLowerCase() : "";
  return VALID_SECTION.has(kind) ? (kind as EvidenceSectionKind) : undefined;
}

/** Absent sections are none; anything else must be a list of section kinds. */
function parseSections(
  value: unknown,
): { sections?: EvidenceSectionKind[] } | { error: string } {
  if (value === undefined || value === null) return {};
  const kinds = EVIDENCE_SECTION_KINDS.join(", ");
  if (!Array.isArray(value)) {
    return {
      error: `library_retrieve sections must be an array of section kinds: ${kinds}.`,
    };
  }
  const unknown = value.filter((entry) => !sectionKind(entry));
  if (unknown.length) {
    return {
      error: `library_retrieve sections: unknown section kind ${unknown.map((entry) => JSON.stringify(entry)).join(", ")}; the section kinds are ${kinds}.`,
    };
  }
  const sections = [...new Set(value.map((entry) => sectionKind(entry)!))];
  return sections.length ? { sections } : {};
}

function normalizeTagScopes(
  value: unknown,
): Array<"allTagged" | "untagged"> | undefined {
  const entries = normalizeStringArray(value)?.filter(
    (entry): entry is "allTagged" | "untagged" =>
      entry === "allTagged" || entry === "untagged",
  );
  return entries?.length ? entries : undefined;
}

function normalizeIntent(value: unknown): LibraryRetrieveIntent | undefined {
  if (value === "discover") return "enumerate";
  return typeof value === "string" &&
    VALID_INTENT.has(value as LibraryRetrieveIntent)
    ? (value as LibraryRetrieveIntent)
    : undefined;
}

function normalizeBudget(value: unknown, hardCap: number): number | undefined {
  const parsed = normalizePositiveInt(value);
  if (!parsed) return undefined;
  return Math.min(parsed, hardCap);
}

function normalizeScope(value: unknown): LibraryRetrieveInput["scope"] {
  if (!validateObject<Record<string, unknown>>(value)) return undefined;
  const libraryID = normalizePositiveInt(value.libraryID);
  const collectionIds =
    normalizePositiveIntArray(value.collectionIds) || undefined;
  const tagNames = normalizeStringArray(value.tagNames);
  const tagScopes = normalizeTagScopes(value.tagScopes);
  const includeAutomaticTags =
    value.includeAutomaticTags === true ? true : undefined;
  const itemIds = normalizePositiveIntArray(value.itemIds) || undefined;
  if (
    !libraryID &&
    !collectionIds?.length &&
    !tagNames?.length &&
    !tagScopes?.length &&
    !itemIds?.length
  )
    return undefined;
  return {
    libraryID,
    collectionIds,
    tagNames,
    tagScopes,
    includeAutomaticTags,
    itemIds,
  };
}

export function normalizeLibraryRetrieveArgs(
  args: unknown,
): LibraryRetrieveInput | null {
  if (!validateObject<Record<string, unknown>>(args)) return null;
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return null;
  const sections = parseSections(args.sections);
  const input: LibraryRetrieveInput = {
    query,
    queryVariants: normalizeStringArray(args.queryVariants),
    sections: "sections" in sections ? sections.sections : undefined,
    scope: normalizeScope(args.scope),
    intent: normalizeIntent(args.intent),
    depth: normalizeDepth(args.depth),
    methods: normalizeMethods(args.methods),
    maxMetadataItems: normalizeBudget(
      args.maxMetadataItems,
      LIBRARY_RETRIEVE_HARD_CAPS.maxMetadataItems,
    ),
    maxCandidatePapers: normalizeBudget(
      args.maxCandidatePapers,
      LIBRARY_RETRIEVE_HARD_CAPS.maxCandidatePapers,
    ),
    maxFullTextPapers: normalizeBudget(
      args.maxFullTextPapers,
      LIBRARY_RETRIEVE_HARD_CAPS.maxFullTextPapers,
    ),
    maxSnippetPapers: normalizeBudget(
      args.maxSnippetPapers,
      LIBRARY_RETRIEVE_HARD_CAPS.maxFullTextPapers,
    ),
    perPaperTopK: normalizeBudget(
      args.perPaperTopK,
      LIBRARY_RETRIEVE_HARD_CAPS.perPaperTopK,
    ),
    maxTotalSnippets: normalizeBudget(
      args.maxTotalSnippets,
      LIBRARY_RETRIEVE_HARD_CAPS.maxTotalSnippets,
    ),
    requireExact: args.requireExact === true,
  };
  return input;
}

/** The single owner of library-evidence routing and coverage rules. */
export const LIBRARY_RETRIEVE_GUIDANCE: AgentToolGuidance = {
  matches: matchesLibraryLevelTurn,
  instruction: [
    "Use library_search for catalog discovery, library_read for structured item state, library_retrieve for evidence search and synthesis across a collection or library, and paper_read for close reading known papers.",
    "For library_retrieve, preserve the returned coverage boundary and use paperMatches as the paper ledger. Query variants improve recall but are not evidence. Do not turn sampled, metadata-only, abstract-only, partial, or unreadable coverage into exhaustive claims.",
    "A strong match is a candidate: check its title and authors against what was asked, and name it as a candidate with what matches and what does not. A passage search cannot show a claim is absent from a paper; a title or author lookup with library_search can show a paper is absent from the library.",
    `When the user asks about particular parts of papers, in any language, pass library_retrieve sections from: ${EVIDENCE_SECTION_KINDS.join(", ")}.`,
    "Unless the user limited the reading to titles or abstracts, for bounded collection or tag synthesis, require body evidence when readable papers are available (coverage papersBodyRead > 0), or answer by naming what is missing. Do not silently substitute titles or abstracts for requested paper-level synthesis.",
    "If a references or bibliography section follows library_retrieve, either include all planned papers, or label the list as body-evidence references and separately identify metadata or abstract-only papers from the coverage frontier.",
  ].join("\n"),
};

/**
 * Result-time coverage rule. Paper chat renders no library_retrieve turn
 * guidance, so a result whose coverage is not complete says it itself.
 */
export const LIBRARY_RETRIEVE_COVERAGE_GUIDANCE =
  "This coverage is not complete: do not present sampled, metadata-only, abstract-only, or partial coverage as exhaustive; name what was not read.";

function hasIncompleteCoverage(result: LibraryRetrieveResult): boolean {
  const contract = result.answerContract;
  const receipt = result.coverageReceipt;
  if (!contract || !receipt) return false;
  return (
    contract.metadataCoverage !== "complete" ||
    contract.indexedTextCoverage !== "complete" ||
    contract.snippetCoverage === "sampled" ||
    receipt.papersMetadataOnly > 0 ||
    receipt.papersBodyRead < receipt.papersPlanned
  );
}

export function createLibraryRetrieveTool(
  libraryRetrieveService: LibraryRetrieveService,
): AgentToolDefinition<
  LibraryRetrieveInput,
  LibraryRetrieveResult & { guidance?: string }
> {
  return {
    spec: {
      name: "library_retrieve",
      description:
        "Comprehensively search a Zotero library, collection, tag, or explicit item pool as a lazy resource tree. Use this for broad folder/tag/library evidence questions: it maps metadata broadly, scans indexed/searchable text for paper-level matches, expands selected snippets, returns a ranked paper-level ledger/frontier, and reports coverage. For bounded selected synthesis, comparison, commonality, or theme questions, intent:'summarize' prefers body-evidence coverage and a paper synthesis digest instead of stopping at titles or abstracts. Query variants are standard search probes for translations, acronyms, notation variants, or technical equivalents. Use library_search for catalog lookup and paper_read for close reading one known paper.",
      inputSchema: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          scope: {
            type: "object",
            additionalProperties: false,
            properties: {
              libraryID: { type: "number" },
              collectionIds: {
                type: "array",
                items: { type: "number" },
              },
              tagNames: {
                type: "array",
                items: { type: "string" },
              },
              tagScopes: {
                type: "array",
                items: {
                  type: "string",
                  enum: ["allTagged", "untagged"],
                },
              },
              includeAutomaticTags: { type: "boolean" },
              itemIds: {
                type: "array",
                items: { type: "number" },
              },
            },
            description:
              "Optional search pool. Omit to use selected collection/tag scope when present, otherwise the active library.",
          },
          query: {
            type: "string",
            description:
              "Search question, keywords, or exact phrase to retrieve evidence for.",
          },
          queryVariants: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional bounded search probes such as translations, acronyms, notation variants, or technical equivalents. Variants improve recall but are not evidence by themselves.",
          },
          // The section kinds are listed in the turn guidance, not as an enum:
          // the ordinary tool payload has no room for one.
          sections: {
            type: "array",
            items: { type: "string" },
            description: `Optional paper sections the user asked about, in any language: ${EVIDENCE_SECTION_KINDS.join(", ")}. Snippet ranking prefers evidence from them.`,
          },
          intent: {
            type: "string",
            enum: ["enumerate", "verify", "summarize"],
            description:
              "Retrieval intent. Use enumerate for comprehensive evidence search across the scoped resource pool, verify for exact presence/absence, and summarize for broad taxonomy/theme/commonality/comparison synthesis over the retrieved ledger.",
          },
          depth: {
            type: "string",
            enum: ["pool", "metadata", "evidence", "verify"],
            description:
              "How deeply to traverse the resource pool. Default evidence.",
          },
          methods: {
            type: "array",
            items: {
              type: "string",
              enum: ["metadata", "abstract", "exact", "fts", "semantic"],
            },
          },
          maxMetadataItems: {
            type: "number",
            description: `Default ${LIBRARY_RETRIEVE_DEFAULT_BUDGETS.maxMetadataItems}, hard max ${LIBRARY_RETRIEVE_HARD_CAPS.maxMetadataItems}.`,
          },
          maxCandidatePapers: {
            type: "number",
            description: `Default ${LIBRARY_RETRIEVE_DEFAULT_BUDGETS.maxCandidatePapers}, hard max ${LIBRARY_RETRIEVE_HARD_CAPS.maxCandidatePapers}.`,
          },
          maxFullTextPapers: {
            type: "number",
            description: `Deprecated alias for maxSnippetPapers. Default ${LIBRARY_RETRIEVE_DEFAULT_BUDGETS.maxFullTextPapers}, hard max ${LIBRARY_RETRIEVE_HARD_CAPS.maxFullTextPapers}.`,
          },
          maxSnippetPapers: {
            type: "number",
            description: `Maximum papers expanded into returned snippets. Default ${LIBRARY_RETRIEVE_DEFAULT_BUDGETS.maxFullTextPapers}, hard max ${LIBRARY_RETRIEVE_HARD_CAPS.maxFullTextPapers}.`,
          },
          perPaperTopK: {
            type: "number",
            description: `Default ${LIBRARY_RETRIEVE_DEFAULT_BUDGETS.perPaperTopK}, hard max ${LIBRARY_RETRIEVE_HARD_CAPS.perPaperTopK}.`,
          },
          maxTotalSnippets: {
            type: "number",
            description: `Default ${LIBRARY_RETRIEVE_DEFAULT_BUDGETS.maxTotalSnippets}, hard max ${LIBRARY_RETRIEVE_HARD_CAPS.maxTotalSnippets}.`,
          },
          requireExact: {
            type: "boolean",
            description:
              "Require exact keyword/phrase support in returned snippets. Implied by depth:'verify'.",
          },
        },
      },
      executionClass: "read",
      workCategory: "retrieval",
      exposure: "model",
    },
    guidance: LIBRARY_RETRIEVE_GUIDANCE,
    buildModelView: (input, result, context) =>
      buildLibraryRetrieveModelView({
        input,
        result,
        roomTokens: modelViewRoomTokens(context.request),
      }),
    presentation: {
      label: "Retrieve Library",
      traceIcon: "library",
      summaries: {
        onCall: ({ args }) => {
          const record = validateObject<Record<string, unknown>>(args)
            ? args
            : {};
          const depth =
            typeof record.depth === "string" ? record.depth : "evidence";
          const intent =
            typeof record.intent === "string" ? record.intent : "auto";
          return `Retrieving library evidence (${intent}/${depth})`;
        },
        onSuccess: ({ content }) => {
          const result = validateObject<Record<string, unknown>>(content)
            ? content
            : {};
          const pool = validateObject<Record<string, unknown>>(
            result.resourcePool,
          )
            ? result.resourcePool
            : {};
          const coverage = validateObject<Record<string, unknown>>(
            pool.queryCoverage,
          )
            ? pool.queryCoverage
            : {};
          const total = Number(pool.totalItems) || 0;
          const metadata = Number(coverage.metadataInspected) || 0;
          const indexedScanned = Number(coverage.indexedTextScanned) || 0;
          const indexedAvailable = Number(coverage.indexedTextAvailable) || 0;
          const expanded =
            Number(coverage.snippetPapersExpanded) ||
            Number(coverage.fullTextSearched) ||
            0;
          const snippets = Number(coverage.snippetsReturned) || 0;
          return `Retrieved ${snippets} snippets; inspected metadata ${metadata}/${total}, scanned indexed/searchable text ${indexedScanned}/${indexedAvailable}, expanded snippets from ${expanded} papers`;
        },
      },
      buildChips: ({ args }) => {
        const record = validateObject<Record<string, unknown>>(args)
          ? args
          : {};
        const chips = [
          {
            label: `depth:${typeof record.depth === "string" ? record.depth : "evidence"}`,
          },
        ];
        if (typeof record.intent === "string") {
          chips.push({ label: `intent:${record.intent}` });
        }
        const scope = validateObject<Record<string, unknown>>(record.scope)
          ? record.scope
          : {};
        const collectionIds = Array.isArray(scope.collectionIds)
          ? scope.collectionIds
          : [];
        if (collectionIds.length) {
          chips.push({ label: `${collectionIds.length} collections` });
        }
        const tagNames = Array.isArray(scope.tagNames) ? scope.tagNames : [];
        const tagScopes = Array.isArray(scope.tagScopes) ? scope.tagScopes : [];
        const tagCount = tagNames.length + tagScopes.length;
        if (tagCount) {
          chips.push({ label: `${tagCount} tags` });
        }
        return chips;
      },
    },
    validate(args) {
      const sections = parseSections(
        validateObject<Record<string, unknown>>(args)
          ? args.sections
          : undefined,
      );
      if ("error" in sections) return fail(sections.error);
      const input = normalizeLibraryRetrieveArgs(args);
      if (!input) {
        return fail("query is required for library_retrieve");
      }
      return ok(input);
    },
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: ["zotero_library"],
        reason:
          "Library retrieval reads indexed Zotero records without changing them.",
      }),
    async execute(input, context) {
      const result = await libraryRetrieveService.retrieve({
        ...input,
        request: context.request,
        item: context.item,
        model: context.request.model,
        apiBase: context.request.apiBase,
        apiKey: context.request.apiKey,
        authMode: context.request.authMode,
        providerProtocol: context.request.providerProtocol,
        profileOverride: context.request.advanced?.profileOverride,
        signal: context.signal,
      });
      // Leading field, so a truncated preview of a large result keeps it.
      return hasIncompleteCoverage(result)
        ? { guidance: LIBRARY_RETRIEVE_COVERAGE_GUIDANCE, ...result }
        : result;
    },
  };
}
