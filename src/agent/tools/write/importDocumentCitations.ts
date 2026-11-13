/**
 * The later import of a document's outside papers: library_import
 * kind:'document_citations'. Each outside paper the document cites becomes a
 * Zotero item, found in the library or imported by identifier, and a new
 * version of the document cites those items. The stored document stays.
 */
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import { describeLibraryMutationInput } from "../../contracts/actionContract";
import { DirectDocumentFinalizer } from "../../documents/directFinalization";
import { loadPlanDocument } from "../../documents/store";
import type {
  DocumentArtifactV2,
  OutsidePaperSnapshot,
} from "../../documents/types";
import { materialRefFromDocument } from "../../documents/workflowMaterial";
import {
  LibraryMutationService,
  type ImportIdentifiersOperation,
} from "../../services/libraryMutationService";
import {
  normalizeArxivId,
  normalizeDoi,
} from "../../services/paperWorkIdentity";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import type {
  AgentToolContext,
  AgentToolDefinition,
  AgentToolResult,
} from "../../types";
import {
  documentCitedSources,
  zoteroCitedSourceItem,
} from "../control/submitDocument";
import { ToolInputRejection } from "../execution/failure";
import { fail, normalizePositiveInt, ok, validateObject } from "../shared";
import {
  executeAndRecordUndo,
  planLibraryMutations,
} from "./mutateLibraryShared";

type ImportDocumentCitationsInput = {
  documentId: string;
  libraryID?: number;
  targetCollectionId?: number;
};

type LibraryItemRef = { itemId: number; libraryID: number; itemKey: string };

/** What happened to one outside paper the document cites. */
type CitedPaperOutcome = {
  paperId: string;
  title?: string;
  outcome: "found_existing" | "imported" | "failed" | "not_importable";
  identifier?: string;
  itemId?: number;
  reason?: string;
};

/** One outside paper before the import: in the library, importable, or not. */
type CitedPaperPlan = {
  paper: OutsidePaperSnapshot;
  existing?: LibraryItemRef;
  identifier?: string;
};

type CitationImportPlan = {
  document: DocumentArtifactV2;
  libraryID: number;
  papers: CitedPaperPlan[];
  operation?: ImportIdentifiersOperation;
};

/** The identifier an outside paper is imported by: DOI, then arXiv, then PMID. */
function importIdentifierOf(paper: OutsidePaperSnapshot): string | undefined {
  const doi = normalizeDoi(paper.doi);
  if (doi) return doi;
  const arxiv = normalizeArxivId(paper.arxivId);
  if (arxiv) return `arxiv:${arxiv}`;
  const pmid = String(paper.pmid || "").trim();
  return /^\d+$/.test(pmid) ? `PMID:${pmid}` : undefined;
}

function fieldOf(item: Zotero.Item, field: string): string {
  try {
    return String(item.getField?.(field as never) || "");
  } catch {
    return "";
  }
}

/**
 * The DOIs, arXiv ids and PMIDs a library item names: its DOI field, its
 * arXiv URL or arXiv DOI, and the `DOI:`, `arXiv:` and `PMID:` lines of
 * Extra.
 */
function itemIdentifiers(item: Zotero.Item): {
  dois: Set<string>;
  arxivIds: Set<string>;
  pmids: Set<string>;
} {
  const extra = fieldOf(item, "extra");
  const dois = new Set(
    [
      fieldOf(item, "DOI"),
      ...Array.from(extra.matchAll(/^\s*doi:\s*(\S+)/gim), (match) => match[1]),
    ]
      .map(normalizeDoi)
      .filter(Boolean),
  );
  const arxivIds = new Set(
    [
      fieldOf(item, "url"),
      ...Array.from(extra.matchAll(/arxiv:\s*([^\s\]]+)/gi), (m) => m[1]),
      ...[...dois].map((doi) => /^10\.48550\/arxiv\.(.+)$/.exec(doi)?.[1]),
    ]
      .map(normalizeArxivId)
      .filter(Boolean),
  );
  const pmids = new Set(
    Array.from(extra.matchAll(/^\s*pmid:\s*(\d+)/gim), (match) => match[1]),
  );
  return { dois, arxivIds, pmids };
}

/**
 * The regular item in this library that is this paper, matched by DOI, then
 * arXiv id, then PMID, so a later import never makes a duplicate.
 */
export async function findLibraryItemForPaper(
  gateway: ZoteroGateway,
  libraryID: number,
  paper: Pick<OutsidePaperSnapshot, "doi" | "arxivId" | "pmid">,
): Promise<LibraryItemRef | null> {
  const doi = normalizeDoi(paper.doi);
  const arxiv = normalizeArxivId(paper.arxivId);
  const pmid = String(paper.pmid || "").trim();
  const values = [doi, arxiv, /^\d+$/.test(pmid) ? pmid : ""].filter(Boolean);
  if (!values.length) return null;
  const candidates = new Set<number>();
  for (const value of values) {
    for (const condition of ["DOI", "extra", "url"]) {
      try {
        const found = await gateway.searchItemsByConditions({
          libraryID,
          conditions: [{ condition, operator: "contains", value }],
          limit: 20,
        });
        for (const item of found.items) candidates.add(item.itemId);
      } catch {
        // A field this Zotero version cannot search finds nothing.
      }
    }
  }
  const items = [...candidates]
    .map((itemId) => gateway.getItem(itemId))
    .filter(
      (item): item is Zotero.Item =>
        Boolean(item?.isRegularItem?.()) &&
        !item?.deleted &&
        Number(item?.libraryID) === libraryID,
    )
    .map((item) => ({ item, names: itemIdentifiers(item) }));
  const match =
    (doi && items.find(({ names }) => names.dois.has(doi))) ||
    (arxiv && items.find(({ names }) => names.arxivIds.has(arxiv))) ||
    (pmid && items.find(({ names }) => names.pmids.has(pmid))) ||
    undefined;
  return match
    ? {
        itemId: Number(match.item.id),
        libraryID: Number(match.item.libraryID),
        itemKey: String(match.item.key),
      }
    : null;
}

/** The conversation's document whose outside papers are to be imported. */
async function loadCitingDocument(
  documentId: string,
  context: AgentToolContext,
): Promise<DocumentArtifactV2> {
  const document = await loadPlanDocument(documentId);
  if (
    !document ||
    document.conversationKey !== context.request.conversationKey
  ) {
    throw new ToolInputRejection(
      `There is no document ${documentId} in this conversation.`,
    );
  }
  if (document.version !== 2 || !document.citationBundle.outsidePapers?.length)
    throw new ToolInputRejection(
      `Document ${documentId} cites no outside paper, so there is nothing to import.`,
    );
  // A document of this run cites its outside papers as the user chose on the
  // paper selection card. A version this tool made is not held back, so a
  // retry still finishes.
  if (
    document.origin.kind === "direct" &&
    document.origin.runId === context.runId &&
    !document.revisionOf
  )
    throw new ToolInputRejection(
      `Nothing was imported: document ${documentId} was made in this run and cites its outside papers without importing them, as the user chose. Import them when the user asks in a later turn.`,
    );
  if (!document.citationDraft)
    throw new ToolInputRejection(
      `Document ${documentId} keeps no citation draft, so a new version cannot cite imported items.`,
    );
  return document;
}

async function planCitationImport(
  gateway: ZoteroGateway,
  input: ImportDocumentCitationsInput,
  context: AgentToolContext,
): Promise<CitationImportPlan> {
  const document = await loadCitingDocument(input.documentId, context);
  const libraryID = gateway.resolveLibraryID({
    request: context.request,
    item: context.item,
    libraryID: input.libraryID,
  });
  const papers: CitedPaperPlan[] = [];
  for (const paper of document.citationBundle.outsidePapers || []) {
    const existing = await findLibraryItemForPaper(gateway, libraryID, paper);
    papers.push(
      existing
        ? { paper, existing }
        : { paper, identifier: importIdentifierOf(paper) },
    );
  }
  const identifiers = [
    ...new Set(
      papers.flatMap((entry) =>
        !entry.existing && entry.identifier ? [entry.identifier] : [],
      ),
    ),
  ];
  return {
    document,
    libraryID,
    papers,
    operation: identifiers.length
      ? {
          type: "import_identifiers",
          identifiers,
          libraryID,
          targetCollectionId: input.targetCollectionId,
        }
      : undefined,
  };
}

/** The item ids an import made for each identifier, from its result rows. */
function importedItemIds(content: unknown): Map<string, number> {
  const rows = (
    content as {
      result?: {
        result?: {
          items?: Array<{
            identifier?: unknown;
            status?: unknown;
            itemId?: unknown;
          }>;
        };
      };
    }
  )?.result?.result?.items;
  const out = new Map<string, number>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const itemId = Number(row.itemId);
    if (
      row.status === "imported" &&
      typeof row.identifier === "string" &&
      Number.isInteger(itemId) &&
      itemId > 0 &&
      !out.has(row.identifier)
    )
      out.set(row.identifier, itemId);
  }
  return out;
}

function importFailureReasons(content: unknown): Map<string, string> {
  const rows = (
    content as {
      result?: {
        result?: { items?: Array<{ identifier?: unknown; reason?: unknown }> };
      };
    }
  )?.result?.result?.items;
  const out = new Map<string, string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row.identifier === "string" && typeof row.reason === "string")
      out.set(row.identifier, row.reason);
  }
  return out;
}

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

export function createImportDocumentCitationsTool(
  zoteroGateway: ZoteroGateway,
  options: { finalizer?: DirectDocumentFinalizer } = {},
): AgentToolDefinition<ImportDocumentCitationsInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);
  const finalizer =
    options.finalizer || new DirectDocumentFinalizer(zoteroGateway);
  // One plan per validated input for the checks before execution; the
  // execution plans again, so a paper imported meanwhile is not imported
  // twice.
  const plans = new WeakMap<
    ImportDocumentCitationsInput,
    Promise<CitationImportPlan>
  >();
  const plannedFor = (
    input: ImportDocumentCitationsInput,
    context: AgentToolContext,
  ) => {
    let plan = plans.get(input);
    if (!plan) {
      plan = planCitationImport(zoteroGateway, input, context);
      plans.set(input, plan);
      // A refusal is answered once and planned again on the next call.
      plan.catch(() => plans.delete(input));
    }
    return plan;
  };

  return {
    effectOperations: ["import_identifiers"],
    spec: {
      name: "import_document_citations",
      description:
        "Import the outside papers a document cites, then publish a new version of it that cites the imported items.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["documentId"],
        properties: {
          documentId: { type: "string" },
          targetCollectionId: { type: "number" },
          libraryID: { type: "number" },
        },
      },
      executionClass: "external_effect",
      workCategory: "zotero_action",
    },

    async describeAction(input, context) {
      if (!context) return [];
      const plan = await plannedFor(input, context);
      return plan.operation
        ? describeLibraryMutationInput({ operation: plan.operation })
        : [];
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object with documentId");
      }
      const documentId =
        typeof args.documentId === "string" ? args.documentId.trim() : "";
      if (!documentId) {
        return fail(
          "kind:'document_citations' needs the documentId of a document that cites outside papers.",
        );
      }
      if (
        args.identifiers !== undefined ||
        args.filePaths !== undefined ||
        args.items !== undefined
      ) {
        return fail(
          "kind:'document_citations' imports the papers the document cites; pass only its documentId.",
        );
      }
      return ok({
        documentId,
        libraryID: normalizePositiveInt(args.libraryID),
        targetCollectionId:
          normalizePositiveInt(args.targetCollectionId) ||
          normalizePositiveInt(args.collectionId),
      });
    },

    // An explicit later request: the discovery's card choice does not hold
    // this import back.
    async planInvocation(input, context) {
      const plan = await plannedFor(input, context);
      if (!plan.operation)
        return readOnlyInvocationPlan({
          reason:
            "Every cited paper is already in the library or cannot be imported; only a new document version is published.",
        });
      return planLibraryMutations(mutationService, [plan.operation], context);
    },

    async createPendingAction(input, context) {
      const plan = await plannedFor(input, context);
      const count = plan.operation?.identifiers.length || 0;
      const found = plan.papers.filter((entry) => entry.existing).length;
      return {
        toolName: "import_document_citations",
        title: "Import cited papers",
        description:
          `Import ${plural(count, "paper")} that "${plan.document.title}" cites into the library, then publish a new version of the document that cites ${count === 1 ? "it" : "them"}.` +
          (found
            ? ` ${plural(found, "cited paper")} already in the library ${found === 1 ? "is" : "are"} cited as ${found === 1 ? "it is" : "they are"}.`
            : ""),
        confirmLabel: "Import",
        cancelLabel: "Cancel",
        fields: [],
      };
    },

    async execute(input, context) {
      const plan = await planCitationImport(zoteroGateway, input, context);
      const imported = plan.operation
        ? await executeAndRecordUndo(
            mutationService,
            plan.operation,
            context,
            "import_identifiers",
          )
        : null;
      const importedIds = importedItemIds(imported?.content);
      const reasons = importFailureReasons(imported?.content);
      const items = new Map<string, { libraryID: number; itemKey: string }>();
      const papers: CitedPaperOutcome[] = plan.papers.map((entry) => {
        const paperId = entry.paper.paperId;
        const title = entry.paper.csl.title;
        if (entry.existing) {
          items.set(paperId, entry.existing);
          return {
            paperId,
            title,
            outcome: "found_existing",
            itemId: entry.existing.itemId,
          };
        }
        if (!entry.identifier)
          return {
            paperId,
            title,
            outcome: "not_importable",
            reason:
              "It has no DOI, arXiv ID or PMID, only a web page, so it stays cited as an outside paper.",
          };
        const itemId = importedIds.get(entry.identifier);
        const item = itemId ? zoteroGateway.getItem(itemId) : null;
        if (!itemId || !item?.key)
          return {
            paperId,
            title,
            outcome: "failed",
            identifier: entry.identifier,
            reason:
              reasons.get(entry.identifier) ||
              "The import made no item for it, so it stays cited as an outside paper.",
          };
        items.set(paperId, {
          libraryID: Number(item.libraryID),
          itemKey: String(item.key),
        });
        return {
          paperId,
          title,
          outcome: "imported",
          identifier: entry.identifier,
          itemId,
        };
      });
      const summary = {
        importedCount: papers.filter((paper) => paper.outcome === "imported")
          .length,
        foundExistingCount: papers.filter(
          (paper) => paper.outcome === "found_existing",
        ).length,
        papers,
      };
      if (!items.size) {
        return {
          content: {
            ...summary,
            sourceDocumentId: plan.document.documentId,
            note: "No cited paper is a Zotero item now, so the document is unchanged and no new version was published.",
          },
          effect: imported?.effect || "none",
          actionEvidence: imported?.actionEvidence,
        };
      }
      const runId =
        context.runId ||
        (() => {
          throw new Error("Direct document run identity is unavailable");
        })();
      let document: Awaited<
        ReturnType<DirectDocumentFinalizer["finalizeImportedCitations"]>
      >["document"];
      try {
        ({ document } = await finalizer.finalizeImportedCitations({
          request: context.request,
          runId,
          document: plan.document,
          items,
        }));
      } catch (error) {
        // The import is done and reported; only the new version is missing.
        // A retry finds the imported items and does not import them twice.
        const done = summary.importedCount
          ? "The papers marked imported above are in the library now"
          : "The cited papers were already in the library";
        return {
          content: {
            ...summary,
            sourceDocumentId: plan.document.documentId,
            note: `${done}, but the new version of the document could not be published: ${error instanceof Error ? error.message : String(error)} The document is unchanged. Calling this again is safe once the cause is fixed; a retry finds the imported items and does not import them twice. If the error is permanent, do not call it again.`,
          },
          effect: imported?.effect || "none",
          actionEvidence: imported?.actionEvidence,
        };
      }
      const materialRef = materialRefFromDocument(document);
      const clusters = document.citationBundle.clusters;
      return {
        content: {
          ...summary,
          documentId: document.documentId,
          documentVersion: document.documentVersion,
          revisionOf: {
            documentId: plan.document.documentId,
            documentVersion: plan.document.documentVersion,
          },
          contentHash: document.contentHash,
          materialRef,
          visibleMarkdown: document.visibleMarkdown,
          note: `Published version ${document.documentVersion} of the document as ${document.documentId}; it cites the papers now in Zotero as Zotero items. Do not submit the document again.`,
        },
        effect: imported?.effect || "none",
        actionEvidence: imported?.actionEvidence,
        materialRef,
        materialKind:
          document.version === 2 ? document.documentKind : undefined,
        materialTitle: document.title,
        materialCitedSources: documentCitedSources({
          markdown: plan.document.citationDraft?.markdown || "",
          title: document.title,
          clusters,
          verifiedQuotes: document.verifiedQuotes,
          itemOf: zoteroCitedSourceItem,
        }),
      };
    },

    // The new version is the answer, as a submitted document is.
    resolveTerminalResult: (_input, result: AgentToolResult) => {
      if (!validateObject<Record<string, unknown>>(result.content)) return null;
      const documentId =
        typeof result.content.documentId === "string"
          ? result.content.documentId
          : "";
      const finalText =
        typeof result.content.visibleMarkdown === "string"
          ? result.content.visibleMarkdown
          : "";
      if (!documentId || !finalText) return null;
      return { finalText, documentId, providerTranscript: "tool_only" };
    },
  };
}
