import { AgentToolRegistry } from "./registry";
import { PdfService } from "../services/pdfService";
import { RetrievalService } from "../services/retrievalService";
import { LibraryRetrieveService } from "../services/libraryRetrieveService";
import { ZoteroGateway } from "../services/zoteroGateway";
import { createQueryLibraryTool } from "./read/queryLibrary";
import { createReadLibraryTool } from "./read/readLibrary";
import { createLibraryRetrieveTool } from "./read/libraryRetrieve";
import { createPaperReadTool } from "./read/paperRead";
import { createReadPaperTool } from "./read/readPaper";
import { createSearchPaperTool } from "./read/searchPaper";
import { createViewPdfPagesTool } from "./read/viewPdfPages";
import { createReadAttachmentTool } from "./read/readAttachment";
import { clearPdfToolCaches } from "./read/pdfToolUtils";
import { createSearchLiteratureOnlineTool } from "./read/searchLiteratureOnline";
import { createToolResultReadTool } from "./read/toolResultRead";
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
import { PdfFigureExtractionService } from "../services/pdfFigureExtractionService";
import type { AgentToolDefinition } from "../types";
import { fail, ok, PAPER_CONTEXT_REF_SCHEMA, validateObject } from "./shared";

type BuiltInAgentToolDeps = {
  zoteroGateway: ZoteroGateway;
  pdfService: PdfService;
  pdfPageService: PdfPageService;
  retrievalService: RetrievalService;
};

type ToolGuidance = NonNullable<AgentToolDefinition["guidance"]>;

const STRING_ARRAY_SCHEMA = {
  type: "array" as const,
  items: { type: "string" as const },
};

const NUMBER_ARRAY_SCHEMA = {
  type: "array" as const,
  items: { type: "number" as const },
};

const METADATA_PATCH_SCHEMA = {
  type: "object" as const,
  additionalProperties: true,
  description: "Metadata fields to update.",
};

const LIBRARY_UPDATE_OPERATION_SCHEMA = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    id: { type: "string" as const },
    itemId: { type: "number" as const },
    paperContext: PAPER_CONTEXT_REF_SCHEMA,
    metadata: METADATA_PATCH_SCHEMA,
    patch: METADATA_PATCH_SCHEMA,
  },
};

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
    /\b(related papers?|similar papers?|find papers?|search (the )?(internet|online|web|literature)|online search|web search|citations?|references?|papers? (by|from)|publications? (by|from))\b/i.test(
      request.userText || "",
    ),
  instruction:
    "When the user explicitly asks to search online or search the literature, call literature_search with workflow:'answer' by default, analyze the scholarly results, and answer in chat with explicit source attribution. Use workflow:'review' only when the user wants to import/add papers to Zotero, save selected search results to a note, refine results inside the card, or review metadata changes. If the request is not answerable from scholarly sources, say that limitation instead of pretending general web search is available. Do not use this tool for questions about the content of papers already in context (e.g. counting references, summarizing, explaining)." +
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
    "For library write operations, the confirmation card is the deliverable; call library_update directly instead of stopping with a prose summary. Use kind:'tags' for tag changes, kind:'collections' for collection membership, and kind:'metadata' for item metadata fields. When the user asks to fix, correct, or enrich metadata from external sources, use literature_search with workflow:'review' and mode:'metadata' first to fetch canonical data, then continue through the review/update flow. Only call library_update with kind:'metadata' directly when the user provides specific field values to set.",
};

const NOTE_WRITE_GUIDANCE: ToolGuidance = {
  matches: () => true,
  instruction:
    "When a Zotero note is already open/current and the user asks to edit, rewrite, revise, polish, or update that note, call note_write with mode:'edit'. NEVER output note text directly in chat. For edits, PREFER patches (find-and-replace pairs) over content (full rewrite). When the user asks to append/add content to an existing note, call note_write with mode:'append' and content; pass targetNoteId when the destination note is known. When the user asks to create/write/save a new item note, call note_write with mode:'create', target:'item', and content; create means a brand-new child note, not appending to the response-save note. For standalone notes, call note_write with mode:'create', target:'standalone', and content. Pass Markdown by default. When the note discusses a specific figure, first call paper_read with mode:'figures' and embed the extracted PDF crop path: `![Figure N](file:///{path})`; it is auto-imported as a Zotero attachment. When the note discusses a table, use paper_read mode:'targeted' for the table text and surrounding discussion instead of the figure-crop extractor. If paper_read mode:'figures' returns no_figures, mineru_required, error, zero figures, or no image artifact, do not call note_write for that figure note and do not create a text-only substitute. Do not embed MinerU source image paths for figure notes; text-only models may still copy/embed extracted crop paths but must not make unsupported visual claims.",
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
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: {
          type: "string",
          enum: ["tags", "collections", "metadata"],
        },
        action: {
          type: "string",
          enum: ["add", "remove"],
          description:
            "For tags and collections: whether to add or remove entries.",
        },
        itemIds: {
          ...NUMBER_ARRAY_SCHEMA,
          description: "Zotero item IDs to update.",
        },
        tags: {
          ...STRING_ARRAY_SCHEMA,
          description: "Tags to add or remove when kind:'tags'.",
        },
        assignments: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              itemId: { type: "number" },
              tags: STRING_ARRAY_SCHEMA,
              targetCollectionId: { type: "number" },
              targetCollectionName: { type: "string" },
            },
            required: ["itemId"],
          },
          description:
            "Per-item tag or collection assignments for kind:'tags' or kind:'collections'.",
        },
        targetCollectionId: {
          type: "number",
          description: "Target collection ID for kind:'collections'.",
        },
        targetCollectionName: {
          type: "string",
          description:
            "Target collection name for kind:'collections'; resolved in the confirmation card.",
        },
        collectionId: {
          type: "number",
          description:
            "Collection ID to remove items from when kind:'collections' and action:'remove'.",
        },
        metadata: METADATA_PATCH_SCHEMA,
        operations: {
          type: "array",
          items: LIBRARY_UPDATE_OPERATION_SCHEMA,
          description: "Batch metadata operations when kind:'metadata'.",
        },
        itemId: {
          type: "number",
          description: "Single Zotero item ID for kind:'metadata'.",
        },
        paperContext: PAPER_CONTEXT_REF_SCHEMA,
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
      if (args.kind === "tags")
        return ok({ tool: tools.applyTags, args: delegateArgs });
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
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: {
          type: "string",
          enum: ["identifiers", "files"],
        },
        identifiers: {
          ...STRING_ARRAY_SCHEMA,
          description:
            "DOIs, ISBNs, arXiv IDs, or URLs to import when kind:'identifiers'.",
        },
        filePaths: {
          ...STRING_ARRAY_SCHEMA,
          description: "Absolute local file paths to import when kind:'files'.",
        },
        targetCollectionId: {
          type: "number",
          description: "Collection to add imported items to.",
        },
        collectionId: {
          type: "number",
          description: "Deprecated alias for targetCollectionId.",
        },
        libraryID: {
          type: "number",
          description: "Target library ID. Defaults to the user's library.",
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
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: {
          type: "string",
          enum: ["trash", "merge"],
        },
        itemIds: {
          ...NUMBER_ARRAY_SCHEMA,
          description: "Zotero item IDs to trash when mode:'trash'.",
        },
        masterItemId: {
          type: "number",
          description: "The surviving master item ID when mode:'merge'.",
        },
        otherItemIds: {
          ...NUMBER_ARRAY_SCHEMA,
          description:
            "Duplicate item IDs to merge into the master when mode:'merge'.",
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
  const libraryRetrieve = createLibraryRetrieveTool(
    new LibraryRetrieveService(deps.zoteroGateway, deps.pdfService),
  );
  const figureExtractionService = new PdfFigureExtractionService(
    deps.pdfPageService,
  );
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
        "Read structured Zotero item state: metadata, notes, annotations, attachments, collection membership, and note content. Use paper_read for primary PDF/paper content. For explicit child-attachment requests, enumerate attachments then use read_attachment for Markdown/HTML/TXT/DOCX.",
    }),
  );
  registry.register(libraryRetrieve);
  registry.register(
    createPaperReadTool(
      deps.pdfService,
      deps.retrievalService,
      deps.pdfPageService,
      deps.zoteroGateway,
      figureExtractionService,
    ),
  );
  registry.register(
    createRenamedTool({
      tool: searchLiterature,
      name: "literature_search",
      label: "Search Literature",
      description:
        "Search scholarly sources and fetch external scholarly metadata. Use workflow:'answer' for source-cited chat answers, or workflow:'review' for Zotero import/review-card workflows.",
      guidance: LITERATURE_SEARCH_GUIDANCE,
    }),
  );
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
  registry.register(createToolResultReadTool());

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
