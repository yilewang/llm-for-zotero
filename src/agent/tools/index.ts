import { AgentToolRegistry } from "./registry";
import { PdfService } from "../services/pdfService";
import { RetrievalService } from "../services/retrievalService";
import { ZoteroGateway } from "../services/zoteroGateway";
import { createQueryLibraryTool } from "./read/queryLibrary";
import { createReadLibraryTool } from "./read/readLibrary";
import { createPaperReadTool } from "./read/paperRead";
import { createReadPaperTool } from "./read/readPaper";
import { createSearchPaperTool } from "./read/searchPaper";
import { createViewPdfPagesTool } from "./read/viewPdfPages";
import { createReadAttachmentTool } from "./read/readAttachment";
import { clearPdfToolCaches } from "./read/pdfToolUtils";
import { createSearchLiteratureOnlineTool } from "./read/searchLiteratureOnline";
import { createWebSearchTool } from "./read/webSearch";
import { createDelegatingTool, createRenamedTool } from "./facade";

import { createEditCurrentNoteTool } from "./write/editCurrentNote";
import { createUndoLastActionTool } from "./write/undoLastAction";
import { createApplyTagsTool } from "./write/applyTags";
import { createMoveToCollectionTool } from "./write/moveToCollection";
import { createUpdateMetadataTool } from "./write/updateMetadata";
import { createManageCollectionsTool } from "./write/manageCollections";
import { createImportIdentifiersTool } from "./write/importIdentifiers";
import { createTrashItemsTool } from "./write/trashItems";
import { createMergeItemsTool } from "./write/mergeItems";
import { createManageAttachmentsTool } from "./write/manageAttachments";
import { createRunCommandTool } from "./write/runCommand";
import { createImportLocalFilesTool } from "./write/importLocalFiles";
import { createFileIOTool } from "./write/fileIO";
import { createZoteroScriptTool } from "./write/zoteroScript";
import { PdfPageService } from "../services/pdfPageService";
import type { AgentToolDefinition } from "../types";
import { fail, ok, validateObject } from "./shared";

type BuiltInAgentToolDeps = {
  zoteroGateway: ZoteroGateway;
  pdfService: PdfService;
  pdfPageService: PdfPageService;
  retrievalService: RetrievalService;
};

function markInternalTool<TInput, TResult>(
  tool: AgentToolDefinition<TInput, TResult>,
): AgentToolDefinition<TInput, TResult> {
  tool.spec.exposure = "internal";
  tool.spec.description = `Legacy internal primitive. Prefer the semantic facade tools in model-visible workflows. ${tool.spec.description}`;
  return tool;
}

function markToolTier<TInput, TResult>(
  tool: AgentToolDefinition<TInput, TResult>,
  tier: "normal" | "advanced",
): AgentToolDefinition<TInput, TResult> {
  tool.spec.tier = tier;
  tool.spec.exposure = "model";
  return tool;
}

function createLibraryUpdateTool(tools: {
  applyTags: AgentToolDefinition<any, any>;
  moveToCollection: AgentToolDefinition<any, any>;
  updateMetadata: AgentToolDefinition<any, any>;
}): AgentToolDefinition<any, unknown> {
  return createDelegatingTool({
    name: "library_update",
    label: "Update Library",
    description:
      "Apply non-destructive Zotero item changes: tags, collection membership, or metadata. Use kind:'tags', kind:'collections', or kind:'metadata'.",
    mutability: "write",
    requiresConfirmation: true,
    inputSchema: {
      type: "object",
      additionalProperties: true,
      required: ["kind"],
      properties: {
        kind: {
          type: "string",
          enum: ["tags", "collections", "metadata"],
        },
      },
    },
    summaries: {
      onCall: "Preparing library changes",
      onPending: "Waiting for confirmation on library changes",
      onApproved: "Applying library changes",
      onDenied: "Library changes cancelled",
      onSuccess: "Library updated",
    },
    chooseDelegate(args) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object with kind");
      }
      const delegateArgs = { ...args };
      delete delegateArgs.kind;
      if (args.kind === "tags") return ok({ tool: tools.applyTags, args: delegateArgs });
      if (args.kind === "collections") {
        return ok({ tool: tools.moveToCollection, args: delegateArgs });
      }
      if (args.kind === "metadata") {
        return ok({ tool: tools.updateMetadata, args: delegateArgs });
      }
      return fail("kind must be one of: tags, collections, metadata");
    },
  });
}

function createLibraryImportTool(tools: {
  importIdentifiers: AgentToolDefinition<any, any>;
  importLocalFiles: AgentToolDefinition<any, any>;
}): AgentToolDefinition<any, unknown> {
  return createDelegatingTool({
    name: "library_import",
    label: "Import to Library",
    description:
      "Import papers or files into Zotero. Use kind:'identifiers' for DOI/ISBN/arXiv/URL imports and kind:'files' for local file imports.",
    mutability: "write",
    requiresConfirmation: true,
    inputSchema: {
      type: "object",
      additionalProperties: true,
      required: ["kind"],
      properties: {
        kind: {
          type: "string",
          enum: ["identifiers", "files"],
        },
      },
    },
    summaries: {
      onCall: "Preparing library import",
      onPending: "Waiting for confirmation on import",
      onApproved: "Importing to Zotero",
      onDenied: "Import cancelled",
      onSuccess: "Import completed",
    },
    chooseDelegate(args) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object with kind");
      }
      const delegateArgs = { ...args };
      delete delegateArgs.kind;
      if (args.kind === "identifiers") {
        return ok({ tool: tools.importIdentifiers, args: delegateArgs });
      }
      if (args.kind === "files") {
        return ok({ tool: tools.importLocalFiles, args: delegateArgs });
      }
      return fail("kind must be one of: identifiers, files");
    },
  });
}

function createLibraryDeleteTool(tools: {
  trashItems: AgentToolDefinition<any, any>;
  mergeItems: AgentToolDefinition<any, any>;
}): AgentToolDefinition<any, unknown> {
  return createDelegatingTool({
    name: "library_delete",
    label: "Delete / Merge Library Items",
    description:
      "Destructive Zotero item operations. Use mode:'trash' to move items to trash or mode:'merge' to merge duplicates into a master item.",
    mutability: "write",
    requiresConfirmation: true,
    inputSchema: {
      type: "object",
      additionalProperties: true,
      required: ["mode"],
      properties: {
        mode: {
          type: "string",
          enum: ["trash", "merge"],
        },
      },
    },
    summaries: {
      onCall: "Preparing destructive library change",
      onPending: "Waiting for confirmation on destructive library change",
      onApproved: "Applying destructive library change",
      onDenied: "Library delete/merge cancelled",
      onSuccess: "Library delete/merge completed",
    },
    chooseDelegate(args) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object with mode");
      }
      const delegateArgs = { ...args };
      delete delegateArgs.mode;
      if (args.mode === "trash") {
        return ok({ tool: tools.trashItems, args: delegateArgs });
      }
      if (args.mode === "merge") {
        return ok({ tool: tools.mergeItems, args: delegateArgs });
      }
      return fail("mode must be one of: trash, merge");
    },
  });
}

export function createBuiltInToolRegistry(
  deps: BuiltInAgentToolDeps,
): AgentToolRegistry {
  const registry = new AgentToolRegistry();
  const queryLibrary = createQueryLibraryTool(deps.zoteroGateway);
  const readLibrary = createReadLibraryTool(deps.zoteroGateway);
  const readPaper = createReadPaperTool(deps.pdfService, deps.zoteroGateway);
  const searchPaper = createSearchPaperTool(
    deps.retrievalService,
    deps.pdfService,
    deps.zoteroGateway,
  );
  const viewPdfPages = createViewPdfPagesTool(
    deps.pdfPageService,
    deps.zoteroGateway,
  );
  const readAttachment = createReadAttachmentTool(
    deps.zoteroGateway,
    deps.pdfPageService,
  );
  const searchLiterature = createSearchLiteratureOnlineTool(deps.zoteroGateway);
  const applyTags = createApplyTagsTool(deps.zoteroGateway);
  const moveToCollection = createMoveToCollectionTool(deps.zoteroGateway);
  const updateMetadata = createUpdateMetadataTool(deps.zoteroGateway);
  const manageCollections = createManageCollectionsTool(deps.zoteroGateway);
  const importIdentifiers = createImportIdentifiersTool(deps.zoteroGateway);
  const trashItems = createTrashItemsTool(deps.zoteroGateway);
  const mergeItems = createMergeItemsTool(deps.zoteroGateway);
  const manageAttachments = createManageAttachmentsTool(deps.zoteroGateway);
  const editCurrentNote = createEditCurrentNoteTool(deps.zoteroGateway);
  const runCommand = createRunCommandTool();
  const importLocalFiles = createImportLocalFilesTool(deps.zoteroGateway);
  const fileIO = createFileIOTool();
  const zoteroScript = createZoteroScriptTool();
  const undoLastAction = createUndoLastActionTool();

  registry.register(
    createRenamedTool({
      tool: queryLibrary,
      name: "library_search",
      label: "Search Library",
      description:
        "Discover, list, filter, and count Zotero items, collections, notes, tags, and libraries. Use this for finding library records; use library_read for detailed item state.",
    }),
  );
  registry.register(
    createRenamedTool({
      tool: readLibrary,
      name: "library_read",
      label: "Read Library",
      description:
        "Read structured Zotero item state: metadata, notes, annotations, attachments, collection membership, and note content. Use paper_read for PDF/paper content.",
    }),
  );
  registry.register(
    createPaperReadTool(
      deps.pdfService,
      deps.retrievalService,
      deps.pdfPageService,
      deps.zoteroGateway,
    ),
  );
  registry.register(
    createRenamedTool({
      tool: searchLiterature,
      name: "literature_search",
      label: "Search Literature",
      description:
        "Search scholarly sources and fetch external scholarly metadata through Zotero-aware review/import workflows. Use web_search for general web lookup.",
    }),
  );
  registry.register(createWebSearchTool());
  registry.register(
    createLibraryUpdateTool({
      applyTags,
      moveToCollection,
      updateMetadata,
    }),
  );
  registry.register(
    createRenamedTool({
      tool: manageCollections,
      name: "collection_update",
      label: "Update Collections",
      description: "Create or delete Zotero collections.",
    }),
  );
  registry.register(
    createRenamedTool({
      tool: editCurrentNote,
      name: "note_write",
      label: "Write Note",
      description:
        "Create, append to, or edit Zotero notes. Use this for note writing instead of returning note-ready text in chat.",
    }),
  );
  registry.register(
    createLibraryImportTool({
      importIdentifiers,
      importLocalFiles,
    }),
  );
  registry.register(createLibraryDeleteTool({ trashItems, mergeItems }));
  registry.register(
    createRenamedTool({
      tool: manageAttachments,
      name: "attachment_update",
      label: "Update Attachments",
      description: "Delete, rename, or re-link Zotero attachments.",
    }),
  );
  registry.register(undoLastAction);
  registry.register(markToolTier(fileIO, "advanced"));
  registry.register(markToolTier(runCommand, "advanced"));
  registry.register(markToolTier(zoteroScript, "advanced"));

  const legacyTools: AgentToolDefinition<any, any>[] = [
    queryLibrary,
    readLibrary,
    readPaper,
    searchPaper,
    viewPdfPages,
    readAttachment,
    searchLiterature,
    applyTags,
    moveToCollection,
    updateMetadata,
    manageCollections,
    importIdentifiers,
    trashItems,
    mergeItems,
    manageAttachments,
    editCurrentNote,
    importLocalFiles,
  ];
  for (const tool of legacyTools) {
    registry.register(markInternalTool(tool));
  }
  return registry;
}

export function clearAllAgentToolCaches(conversationKey: number): void {
  clearPdfToolCaches(conversationKey);
}
