/**
 * Focused facade tool for importing papers into Zotero by DOI, ISBN, arXiv ID, or URL.
 * Provides a self-describing schema for importing papers by identifier.
 */
import type { AgentToolDefinition } from "../../types";
import {
  LibraryMutationService,
  type ImportIdentifiersOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  ok,
  fail,
  validateObject,
  normalizePositiveInt,
  normalizeStringArray,
} from "../shared";
import { executeAndRecordUndo } from "./mutateLibraryShared";

type ImportIdentifiersInput = {
  operation: ImportIdentifiersOperation;
};

export function createImportIdentifiersTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<ImportIdentifiersInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "import_identifiers",
      description: "Import papers into Zotero by DOI, ISBN, arXiv ID, or URL.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["identifiers"],
        properties: {
          identifiers: {
            type: "array",
            items: { type: "string" },
            description: "DOIs, ISBNs, arXiv IDs, or URLs to import.",
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
      mutability: "write",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Import Papers",
      summaries: {
        onCall: "Preparing paper import",
        onPending: "Waiting for confirmation to import papers",
        onApproved: "Importing papers",
        onDenied: "Paper import cancelled",
        onSuccess: ({ content }) => {
          const result =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const resultInner =
            result.result && typeof result.result === "object"
              ? (result.result as Record<string, unknown>)
              : {};
          const count = Number(
            resultInner.importedCount || result.importedCount || 0,
          );
          return count > 0
            ? `Imported ${count} paper${count === 1 ? "" : "s"}`
            : "Papers imported";
        },
      },
    },

    acceptInheritedApproval: async (_input, approval) => {
      // Accept review-mode approvals from search_literature_online review cards
      return (
        approval.sourceMode === "review" && approval.sourceActionId === "import"
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
            'Example: { identifiers: ["10.1234/example", "arXiv:2301.00001"] }',
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
            id: "identifiersChecklist",
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

    applyConfirmation(input, _resolutionData) {
      // Checklist is informational; pass through unchanged
      return ok(input);
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
