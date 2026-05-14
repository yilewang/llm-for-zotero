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

type ToolGuidance = NonNullable<AgentToolDefinition["guidance"]>;

const LIBRARY_SEARCH_GUIDANCE: ToolGuidance = {
  matches: (request) =>
    /\b(unfiled|folder|folders|collection|collections|move|file|organize|organise|categorize|categorise)\b/i.test(
      request.userText || "",
    ),
  instruction:
    "For library-organization requests, gather the item IDs first with library_search({ entity:'items', mode:'list', filters:{ unfiled:true } }) when needed. If the user wants you to file or move papers and the exact destination collection IDs are not known yet, call library_update with {kind:'collections', action:'add', itemIds:[...]} and let the confirmation card collect the target folders. Use library_search({ entity:'collections', mode:'list', view:'tree' }) when you need the collection hierarchy to prefill or explain choices.",
};

const LITERATURE_SEARCH_GUIDANCE: ToolGuidance = {
  matches: (request) =>
    /\b(related papers?|similar papers?|find papers?|search (the )?(internet|literature)|citations?|references?|papers? (by|from)|publications? (by|from))\b/i.test(
      request.userText || "",
    ),
  instruction:
    "When the user explicitly asks to discover, find, or search for papers online, call literature_search and let the review card present the result. Do not use this tool for questions about the content of papers already in context (e.g. counting references, summarizing, explaining)." +
    "\n\nSource selection:" +
    "\n- recommendations, references, citations modes -> always use source:'openalex' (only OpenAlex supports these)." +
    "\n- search mode -> source:'openalex' (default, broadest coverage), source:'arxiv' (preprints, CS/ML/physics), or source:'europepmc' (biomedical/life sciences)." +
    "\n\nAuthor search:" +
    "\n- When the user wants papers by a specific author, use the 'author' parameter (e.g. author:'Adrien Peyrache')." +
    "\n- You can combine 'author' with 'query' to find an author's papers on a specific topic." +
    "\n- Do NOT put author names in the 'query' parameter; use 'author' instead.",
};

const LIBRARY_UPDATE_GUIDANCE: ToolGuidance = {
  matches: (request) =>
    /\b(fix|correct|update|enrich|complete|sync|tag|tags|move|file|folder|collection|collections)\b.*\b(metadata|fields?|title|authors?|doi|year|date|abstract|tag|tags|folder|folders|collection|collections)\b/i.test(
      request.userText || "",
    ),
  instruction:
    "For library write operations, the confirmation card is the deliverable; call library_update directly instead of stopping with a prose summary. Use kind:'tags' for tag changes, kind:'collections' for collection membership, and kind:'metadata' for item metadata fields. When the user asks to fix, correct, or enrich metadata from external sources, use literature_search with mode:'metadata' first to fetch canonical data, then continue through the review/update flow. Only call library_update with kind:'metadata' directly when the user provides specific field values to set.",
};

const NOTE_WRITE_GUIDANCE: ToolGuidance = {
  matches: () => true,
  instruction:
    "When a Zotero note is already open/current and the user asks to edit, rewrite, revise, polish, or update that note, call note_write with mode:'edit'. NEVER output note text directly in chat. For edits, PREFER patches (find-and-replace pairs) over content (full rewrite). When the user asks to append/add content to an existing note, call note_write with mode:'append' and content; pass targetNoteId when the destination note is known. When the user asks to create/write/save a new item note, call note_write with mode:'create', target:'item', and content; create means a brand-new child note, not appending to the response-save note. For standalone notes, call note_write with mode:'create', target:'standalone', and content. Pass Markdown by default. When the user explicitly requests HTML output (e.g. for styled note templates), pass well-formed HTML with inline styles directly. When the note discusses a specific figure or table you previously read via file_io, embed the image: `![Figure N](file:///{path})`; it is auto-imported as a Zotero attachment.",
};

const LIBRARY_IMPORT_GUIDANCE: ToolGuidance = {
  matches: (request) =>
    /\b(import.*file|import.*pdf|import.*from.*(desktop|download|folder|directory|disk)|local.*file|add.*file.*library)\b/i.test(
      request.userText || "",
    ),
  instruction:
    "Use library_import with kind:'files' to import local files (PDFs, etc.) from the user's filesystem into Zotero. First use run_command to list files when paths are unknown, then call library_import with kind:'files' and the selected paths. Zotero automatically retrieves metadata for recognized PDFs. Optionally specify a targetCollectionId to organize imported items into a collection.",
};

const LIBRARY_DELETE_GUIDANCE: ToolGuidance = {
  matches: (request) =>
    /\b(merge|dedupe|dedup|duplicat|combine)\b/i.test(request.userText || ""),
  instruction:
    "To merge duplicates: first use library_search({ entity:'items', mode:'duplicates' }) to find duplicate groups, then use library_read to compare metadata and decide which item is the best master, then call library_delete({ mode:'merge', ... }) with the master and the others. The master keeps all children (attachments, notes, tags, collections) from the merged items.",
};

const ATTACHMENT_UPDATE_GUIDANCE: ToolGuidance = {
  matches: (request) =>
    /\b(attachment|rename.*file|relink|broken.*link|missing.*file|delete.*attachment|remove.*attachment)\b/i.test(
      request.userText || "",
    ),
  instruction:
    "Use attachment_update to delete, rename, or re-link a single attachment. To find attachments, use library_read with sections:['attachments'] first. Re-linking only works for linked-file attachments, not imported copies. For batch renaming with computed filenames, use zotero_script instead.",
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
    guidance: LIBRARY_UPDATE_GUIDANCE,
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
    guidance: LIBRARY_IMPORT_GUIDANCE,
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
    guidance: LIBRARY_DELETE_GUIDANCE,
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
      guidance: LIBRARY_SEARCH_GUIDANCE,
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
      guidance: LITERATURE_SEARCH_GUIDANCE,
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
      guidance: NOTE_WRITE_GUIDANCE,
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
      guidance: ATTACHMENT_UPDATE_GUIDANCE,
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
