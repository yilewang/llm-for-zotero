/**
 * Tool for importing local files (PDFs, etc.) into the Zotero library.
 * PDFs go through Zotero's metadata recognition; bibliography files (.ris,
 * .bib, .enw, .nbib, RDF) are read through Zotero's translators rather than
 * attached, which is what "import my references" means.
 */
import type { AgentWriteToolDefinition } from "../../types";
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
import {
  executeAndRecordUndo,
  normalizeChecklistSelectionFromResolution,
  planLibraryMutations,
} from "./mutateLibraryShared";

const FILES_CHECKLIST_FIELD_ID = "filesChecklist";

type ImportLocalFilesInput = {
  operation: ImportLocalFilesOperation;
};

export function createImportLocalFilesTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<ImportLocalFilesInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "import_local_files",
      description:
        "Import local files from the filesystem into Zotero. A bibliography file (.ris, .bib, .enw, .nbib, RDF) is read through Zotero's translators, so its references become real items; other files are attached, and PDFs go through Zotero's metadata recognition so they arrive with a title, authors and DOI rather than as a bare file.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["filePaths"],
        properties: {
          filePaths: {
            type: "array",
            items: { type: "string" },
            description:
              "Absolute file paths to import (e.g. ['/Users/me/Desktop/paper.pdf'] or ['C:\\\\Users\\\\me\\\\Desktop\\\\paper.pdf']).",
          },
          mode: {
            type: "string",
            enum: ["auto", "translate", "attach"],
            default: "auto",
            description:
              "'auto' (default) reads bibliography files as references and attaches everything else. 'translate' insists on reading the file as a bibliography and fails if Zotero has no translator for it. 'attach' stores the file as an attachment even if it is a bibliography.",
          },
          recognize: {
            type: "boolean",
            default: true,
            description:
              "Run Zotero's metadata lookup on imported PDFs, so they arrive as a proper item rather than a bare file. Set false to skip it.",
          },
          targetCollectionId: {
            type: "number",
            description: "Optional collection ID to add imported items to.",
          },
          libraryID: {
            type: "number",
            description:
              "Target library ID. Defaults to the user's personal library.",
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
        "First use run_command to list files (for example `dir %USERPROFILE%\\\\Desktop\\\\*.pdf` on Windows or `ls ~/Desktop/*.pdf` on macOS/Linux) to discover file paths, then call import_local_files with the paths. " +
        "A bibliography file (.ris, .bib, .enw, .nbib, RDF) has its references imported as items; other files are attached. PDFs go through metadata recognition. " +
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
          "filePaths must be a non-empty array of absolute file paths, e.g. ['/Users/me/Desktop/paper.pdf'] or ['C:\\Users\\me\\Desktop\\paper.pdf']",
        );
      }
      const operation: ImportLocalFilesOperation = {
        type: "import_local_files",
        filePaths,
        targetCollectionId: normalizePositiveInt(args.targetCollectionId),
        libraryID: normalizePositiveInt(args.libraryID),
        mode:
          args.mode === "translate" || args.mode === "attach"
            ? args.mode
            : undefined,
        recognize: args.recognize === false ? false : undefined,
      };
      return ok<ImportLocalFilesInput>({ operation });
    },

    createPendingAction(input) {
      const { operation } = input;
      const fileNames = operation.filePaths.map((p) => {
        const parts = p.split(/[\\/]/);
        return parts[parts.length - 1] || p;
      });

      return {
        toolName: "import_local_files",
        title: `Import ${operation.filePaths.length} file${operation.filePaths.length === 1 ? "" : "s"}`,
        description: `Import local files into your Zotero library. Bibliography files (.ris, .bib, .enw, .nbib, RDF) have their references imported as items; other files are attached, and Zotero looks up metadata for PDFs.`,
        confirmLabel: "Import",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "checklist" as const,
            id: FILES_CHECKLIST_FIELD_ID,
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

    applyConfirmation(input, resolutionData) {
      const selected = normalizeChecklistSelectionFromResolution(
        resolutionData,
        FILES_CHECKLIST_FIELD_ID,
      );
      // No resolution — auto_approve / non-HITL path.
      if (selected === undefined) {
        return ok(input);
      }
      if (!selected.length) {
        return fail(
          "No files were left checked, so nothing was imported. Check the files you want to import, or cancel the operation.",
        );
      }
      // Row ids are the file paths themselves.
      const chosen = new Set(selected);
      const filePaths = input.operation.filePaths.filter((path) =>
        chosen.has(path),
      );
      if (!filePaths.length) {
        return fail(
          "The confirmed selection did not match any of the files in this request. Nothing was imported.",
        );
      }
      return ok({
        ...input,
        operation: { ...input.operation, filePaths },
      });
    },

    planMutation: (input, context) =>
      planLibraryMutations(mutationService, [input.operation], context),

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
