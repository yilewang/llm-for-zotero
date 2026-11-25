/**
 * Focused facade tool for importing papers into Zotero by DOI, ISBN, arXiv ID, PMID, or ADS bibcode.
 * Provides a self-describing schema for importing papers by identifier.
 */
import {
  LibraryMutationService,
  type ImportIdentifiersOperation,
} from "../../services/libraryMutationService";
import { describeLibraryMutationInput } from "../../contracts/actionContract";
import { discoveryImportRefusal } from "../../services/literatureDiscovery";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import type { AgentWriteToolDefinition } from "../../types";
import { ToolInputRejection } from "../execution/failure";
import { canShowLiteratureReview } from "../read/reviewLiterature";
import {
  fail,
  normalizePositiveInt,
  normalizeStringArray,
  ok,
  validateObject,
} from "../shared";
import {
  executeAndRecordUndo,
  importedItemCount,
  normalizeChecklistSelectionFromResolution,
  planLibraryMutations,
} from "./mutateLibraryShared";

const IDENTIFIERS_CHECKLIST_FIELD_ID = "identifiersChecklist";

type ImportIdentifiersInput = {
  operation: ImportIdentifiersOperation;
};

export function createImportIdentifiersTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<ImportIdentifiersInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    describeAction: describeLibraryMutationInput,
    effectOperations: ["import_identifiers"],
    spec: {
      name: "import_identifiers",
      description:
        "Import papers into Zotero by DOI, ISBN, arXiv ID, PMID, or ADS bibcode.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["identifiers"],
        properties: {
          identifiers: {
            type: "array",
            items: { type: "string" },
            description:
              "DOI, ISBN, arXiv ID, PMID, or ADS bibcode values to import.",
          },
          targetCollectionId: {
            type: "number",
            description: "Collection to add imported items to.",
          },
          libraryID: {
            type: "number",
            description: "Library ID (for group libraries).",
          },
        },
      },
      executionClass: "external_effect",
      workCategory: "zotero_action",
    },

    presentation: {
      label: "Import Papers",
      summaries: {
        onCall: "Preparing paper import",
        onPending: "Waiting for confirmation to import papers",
        onApproved: "Importing papers",
        onDenied: "Paper import cancelled",
        onSuccess: ({ content }) => {
          const count = importedItemCount(content);
          return count > 0
            ? `Imported ${count} paper${count === 1 ? "" : "s"}`
            : "Papers imported";
        },
      },
    },

    acceptInheritedApproval: async (_input, approval) => {
      // Accept review-mode approvals from literature_search review cards
      return (
        (approval.sourceMode === "review" ||
          (approval.sourceMode === "approval" &&
            approval.sourceToolName === "discover_related")) &&
        approval.sourceActionId === "import"
      );
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          'Expected an object with identifiers. Example: { identifiers: ["10.1234/example"] }',
        );
      }

      const identifiers = normalizeStringArray(args.identifiers);
      if (!identifiers?.length) {
        return fail(
          "identifiers must be a non-empty array of strings. " +
            'Example: { identifiers: ["10.1234/example", "arxiv:2301.00001"] }',
        );
      }

      // Zotero has no page-URL translator path; a URL only resolves when it
      // embeds a DOI (the importer extracts it). Mirrors
      // ImportCapability.describeUnresolvableIdentifier.
      const url = identifiers.find(
        (id) => /^https?:\/\//i.test(id.trim()) && !/10\.\d{4,}\/\S+/.test(id),
      );
      if (url) {
        return fail(
          `"${url}" is a page URL; identifier import accepts DOI, ISBN, arXiv ID, PMID, or ADS bibcode. Take the DOI or arXiv ID off the page instead.`,
        );
      }

      const operation: ImportIdentifiersOperation = {
        type: "import_identifiers",
        identifiers,
        targetCollectionId:
          normalizePositiveInt(args.targetCollectionId) ||
          normalizePositiveInt(args.collectionId),
        libraryID: normalizePositiveInt(args.libraryID),
      };

      return ok({ operation });
    },

    createPendingAction(input) {
      const operation = input.operation;
      const collection = operation.targetCollectionId
        ? zoteroGateway.getCollectionSummary(operation.targetCollectionId)
        : null;
      const collectionLabel = collection
        ? collection.path || collection.name
        : null;
      const description = collectionLabel
        ? `Import ${operation.identifiers.length} identifier${operation.identifiers.length === 1 ? "" : "s"} into "${collectionLabel}".`
        : `Import ${operation.identifiers.length} identifier${operation.identifiers.length === 1 ? "" : "s"} into the library.`;

      return {
        toolName: "import_identifiers",
        title: "Import papers",
        description,
        confirmLabel: "Import",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "checklist" as const,
            id: IDENTIFIERS_CHECKLIST_FIELD_ID,
            label: "Identifiers to import",
            items: operation.identifiers.map((identifier, index) => ({
              id: `${index}`,
              label: identifier,
              checked: true,
            })),
          },
        ],
      };
    },

    applyConfirmation(input, resolutionData) {
      const selected = normalizeChecklistSelectionFromResolution(
        resolutionData,
        IDENTIFIERS_CHECKLIST_FIELD_ID,
      );
      // No resolution — automatic / non-HITL path.
      if (selected === undefined) {
        return ok(input);
      }
      if (!selected.length) {
        return fail(
          "No identifiers were left checked, so nothing was imported. Check the identifiers you want to import, or cancel the operation.",
        );
      }
      // Row ids are indices into operation.identifiers, so "0" is a valid id.
      const chosen = new Set(selected);
      const identifiers = input.operation.identifiers.filter((_, index) =>
        chosen.has(String(index)),
      );
      if (!identifiers.length) {
        return fail(
          "The confirmed selection did not match any of the identifiers in this request. Nothing was imported.",
        );
      }
      return ok({
        ...input,
        operation: { ...input.operation, identifiers },
      });
    },

    async planInvocation(input, context) {
      // Papers a discovery found reach Zotero only through its selection
      // card. Planning runs before review and policy, so the refusal holds in
      // Safe, Auto and YOLO alike; the card's own Import passes because the
      // user chose those papers.
      if (canShowLiteratureReview(context)) {
        const refusal = await discoveryImportRefusal(
          input.operation.identifiers,
          context,
        );
        if (refusal) throw new ToolInputRejection(refusal);
      }
      return planLibraryMutations(mutationService, [input.operation], context);
    },

    async execute(input, context) {
      return executeAndRecordUndo(
        mutationService,
        input.operation,
        context,
        "import_identifiers",
      );
    },
  };
}
