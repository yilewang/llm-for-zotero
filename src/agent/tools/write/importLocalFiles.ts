/**
 * Tool for importing local files (PDFs, etc.) into the Zotero library.
 * Zotero automatically retrieves metadata for recognized PDFs.
 */
import type { AgentToolDefinition } from "../../types";
import {
  LibraryMutationService,
  type ImportLocalFilesOperation,
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

type ImportLocalFilesInput = {
  operation: ImportLocalFilesOperation;
};

export function createImportLocalFilesTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<ImportLocalFilesInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "import_local_files",
      description:
        "Import local files (PDFs, documents, etc.) from the filesystem into the Zotero library. Zotero automatically retrieves metadata for recognized PDFs.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["filePaths"],
        properties: {
          filePaths: {
            type: "array",
            items: { type: "string" },
            description:
              "Absolute file paths to import (e.g. ['/Users/me/Desktop/paper.pdf']).",
          },
          targetCollectionId: {
            type: "number",
            description:
              "Optional collection ID to add imported items to.",
          },
          libraryID: {
            type: "number",
            description: "Target library ID. Defaults to the user's personal library.",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    guidance: {
      matches: (request) =>
        /\b(import.*file|import.*pdf|import.*from.*(desktop|download|folder|directory|disk)|local.*file|add.*file.*library)\b/i.test(
          request.userText || "",
        ),
      instruction:
        "Use import_local_files to import local files (PDFs, etc.) from the user's filesystem into Zotero. " +
        "First use run_command to list files (e.g. ls ~/Desktop/*.pdf) to discover file paths, then call import_local_files with the paths. " +
        "Zotero automatically retrieves metadata for recognized PDFs. " +
        "Optionally specify a targetCollectionId to organize imported items into a collection.",
    },

    presentation: {
      label: "Import Local Files",
      summaries: {
        onCall: ({ args }) => {
          const a =
            args && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {};
          const paths = Array.isArray(a.filePaths) ? a.filePaths : [];
          return `Preparing to import ${paths.length} file${paths.length === 1 ? "" : "s"}`;
        },
        onPending: "Waiting for confirmation to import files",
        onApproved: "Importing files",
        onDenied: "Import cancelled",
        onSuccess: ({ content }) => {
          const r =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const inner =
            r.result && typeof r.result === "object"
              ? (r.result as Record<string, unknown>)
              : {};
          const count = Number(inner.succeeded || r.succeeded || 0);
          return count > 0
            ? `Imported ${count} file${count === 1 ? "" : "s"}`
            : "Import completed";
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object with filePaths");
      }
      const filePaths = normalizeStringArray(args.filePaths);
      if (!filePaths?.length) {
        return fail(
          "filePaths must be a non-empty array of absolute file paths, e.g. ['/Users/me/Desktop/paper.pdf']",
        );
      }
      const operation: ImportLocalFilesOperation = {
        type: "import_local_files",
        filePaths,
        targetCollectionId: normalizePositiveInt(args.targetCollectionId),
        libraryID: normalizePositiveInt(args.libraryID),
      };
      return ok<ImportLocalFilesInput>({ operation });
    },

    createPendingAction(input) {
      const { operation } = input;
      const fileNames = operation.filePaths.map((p) => {
        const parts = p.split("/");
        return parts[parts.length - 1] || p;
      });

      return {
        toolName: "import_local_files",
        title: `Import ${operation.filePaths.length} file${operation.filePaths.length === 1 ? "" : "s"}`,
        description: `Import local files into your Zotero library. Zotero will automatically retrieve metadata for recognized PDFs.`,
        confirmLabel: "Import",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "checklist" as const,
            id: "filesChecklist",
            label: "Files to import",
            items: operation.filePaths.map((path, i) => ({
              id: path,
              label: fileNames[i],
              checked: true,
            })),
          },
        ],
      };
    },

    applyConfirmation(input, _resolutionData) {
      return ok(input);
    },

    async execute(input, context) {
      return executeAndRecordUndo(
        mutationService,
        input.operation,
        context,
        "import_local_files",
      );
    },
  };
}
