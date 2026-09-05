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
import {
  createSearchLiteratureOnlineTool,
  matchesLiteratureSearchGuidance,
} from "./read/searchLiteratureOnline";
import { createToolResultReadTool } from "./read/toolResultRead";
import { createWebSearchTool } from "./read/webSearch";
import { createWebReadTool } from "./read/webRead";
import { createCiteExportTool } from "./read/citeExport";
import { createDelegatingTool, createRenamedTool } from "./facade";

import { createEditCurrentNoteTool } from "./write/editCurrentNote";
import { createRevertChangesTool } from "./write/revertChanges";
import { createAnnotatePdfTool } from "./write/annotatePdf";
import { createUndoLastActionTool } from "./write/undoLastAction";
import { createApplyTagsTool } from "./write/applyTags";
import { createMoveToCollectionTool } from "./write/moveToCollection";
import { createUpdateMetadataTool } from "./write/updateMetadata";
import { createManageCollectionsTool } from "./write/manageCollections";
import { createImportIdentifiersTool } from "./write/importIdentifiers";
import { createTrashItemsTool } from "./write/trashItems";
import { createRestoreFromTrashTool } from "./write/restoreFromTrash";
import { createWriteNotesBatchTool } from "./write/writeNotesBatch";
import { createSavedSearchTool } from "./write/savedSearches";
import { createLibrarySettingsTool } from "./write/librarySettings";
import {
  createSetItemTagsTool,
  createUpdateLibraryTagTool,
} from "./write/tagObjects";
import {
  createCreateItemsTool,
  createRelateItemsTool,
  createReparentItemsTool,
} from "./write/itemStructure";
import { createMergeItemsTool } from "./write/mergeItems";
import { createManageAttachmentsTool } from "./write/manageAttachments";
import { createRunCommandTool } from "./write/runCommand";
import { createImportLocalFilesTool } from "./write/importLocalFiles";
import { createFileIOTool } from "./write/fileIO";
import { createZoteroScriptTool } from "./write/zoteroScript";
import { PdfPageService } from "../services/pdfPageService";
import { PdfFigureExtractionService } from "../services/pdfFigureExtractionService";
import type { AgentToolDefinition } from "../types";
import { inferNoteIntent, WRITE_NOTE_SKILL_ID } from "../skills/noteIntent";
import { fail, ok, PAPER_CONTEXT_REF_SCHEMA, validateObject } from "./shared";
import { ActionContractService } from "../contracts/actionContract";

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
    /\b(unfiled|folder|folders|collection|collections|move|file|organize|organise|categorize|categorise|full[- ]?text|abstract|doi|publisher|isbn|issn|added|modified|since|before|after|retracted|annotation|highlight|citation key|advanced search|trash|deleted)\b/i.test(
      request.userText || "",
    ),
  instruction:
    "For library-organization requests, gather the item IDs first with library_search({ entity:'items', mode:'list', filters:{ unfiled:true } }) when needed. If the user wants you to file or move papers and the exact destination collection IDs are not known yet, call library_update with {kind:'collections', action:'add', itemIds:[...]} and let the confirmation card collect the target folders. Use library_search({ entity:'collections', mode:'list', view:'tree' }) when you need the collection hierarchy to prefill or explain choices. When the user asks to MOVE or reorganize rather than merely file, pass mode:'move' with from:<collectionId> or from:'all'; the default adds, which would leave each item in both its old and new collection." +
    "\n\nFor anything the simple filters cannot express, pass conditions[] — Zotero's own advanced-search vocabulary. Each clause is {condition, operator, value}. Useful conditions: fulltextContent (the PDF text), abstractNote, DOI, ISBN, publisher, publicationTitle, dateAdded, dateModified, note, annotationText, citationKey, retracted, itemType, tag, collection. If a condition and operator do not pair up, the error lists the operators that condition accepts — read it and retry rather than falling back to a plain text search." +
    "\n\nTwo rules that decide whether an advanced search works at all:" +
    "\n- fulltextContent, annotationText and childNote match a child item (an attachment or a note), so pass resolveToParents:true or those matches are dropped and the search looks empty." +
    "\n- joinMode:'all' is the default; use joinMode:'any' for an OR search. There are no grouping blocks, because opening one in Zotero flips every other condition in the query to OR." +
    "\n\nTo see the trash, pass filters:{ deleted:true }. That is the only way to enumerate trashed items, and it is what you need before calling library_delete with mode:'restore'.",
};

const LITERATURE_SEARCH_GUIDANCE: ToolGuidance = {
  matches: matchesLiteratureSearchGuidance,
  instruction:
    "When the request needs external scholarly evidence, call literature_search with workflow:'answer' by default, analyze the results, and answer with explicit source attribution. A mixed request may also use web_search for distinct general-web evidence. Use workflow:'review' only when the user wants to import/add papers to Zotero, save selected search results to a note, refine results inside the card, or review metadata changes. Do not use this tool for questions about the content of papers already in context (e.g. counting references, summarizing, explaining). Preserve the user's language by default." +
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
    /\b(?:tag|untag)\b/i.test(request.userText || "") ||
    /\b(fix|correct|update|enrich|complete|sync|add|apply|assign|remove|set|replace|rename|merge|move|file|organize|organise)\b.*\b(metadata|fields?|title|authors?|doi|year|date|abstract|tags?|folders?|collections?)\b/i.test(
      request.userText || "",
    ),
  instruction:
    "For library write operations, the confirmation card is the deliverable; call library_update directly instead of stopping with a prose summary. Use kind:'tags' for tag changes, kind:'collections' for collection membership, and kind:'metadata' for item metadata fields. Batch one uniform change across all applicable item IDs in a single call. For different per-item changes, use assignments when the schema supports them; use zotero_script only when the semantic tool cannot express the requested computation. When the user asks to fix, correct, or enrich metadata from external sources, use literature_search with workflow:'review' and mode:'metadata' first to fetch canonical data, then continue through the review/update flow. Only call library_update with kind:'metadata' directly when the user provides specific field values to set.",
};

const NOTE_WRITE_GUIDANCE: ToolGuidance = {
  matches: (request, context) =>
    Boolean(
      context?.matchedSkillIds.includes(WRITE_NOTE_SKILL_ID) ||
      request.forcedSkillIds?.includes(WRITE_NOTE_SKILL_ID) ||
      inferNoteIntent(request) ||
      request.actionContract?.obligations.some(
        (obligation) => obligation.capability === "zotero.notes",
      ),
    ),
  instruction:
    "For an open/current Zotero note, use mode:'edit' for revision and prefer patches over a full content replacement. Use mode:'append' for an existing destination note and mode:'create' only for a new child or standalone note. A named Zotero folder means a collection: resolve its ID, create a standalone note, and pass collections:[...]. Pass Markdown unless the user explicitly requests HTML. The requested note must be written with note_write rather than returned as note-ready prose in chat.",
};

const LIBRARY_IMPORT_GUIDANCE: ToolGuidance = {
  matches: (request) =>
    /\b(import.*file|import.*pdf|import.*from.*(desktop|download|folder|directory|disk)|local.*file|add.*file.*library)\b/i.test(
      request.userText || "",
    ),
  instruction:
    "Use library_import with kind:'files' to import local files from the user's filesystem into Zotero. First use run_command to list files when paths are unknown, then call library_import with kind:'files' and the selected paths. A bibliography file (.ris, .bib, .enw, .nbib, RDF) has its references imported as real items; other files are attached, and PDFs go through Zotero's metadata lookup so they arrive with a title and authors. Optionally specify a targetCollectionId to file the results into a collection." +
    "\n\nkind:'identifiers' resolves DOIs, ISBNs, PMIDs, arXiv IDs and ADS bibcodes. It cannot import from a page URL — Zotero has no translator path for that — so take the DOI or arXiv ID off the page instead.",
};

const LIBRARY_DELETE_GUIDANCE: ToolGuidance = {
  matches: (request) =>
    /\b(merge|dedupe|dedup|duplicat|combine|restore|recover|undelete|trash|deleted)\b/i.test(
      request.userText || "",
    ),
  instruction:
    "To merge duplicates: first use library_search({ entity:'items', mode:'duplicates' }) to find duplicate groups, then use library_read to compare metadata and decide which item is the best master, then call library_delete({ mode:'merge', ... }) with the master and the others. The master keeps all children (attachments, notes, tags, collections) from the merged items." +
    "\n\nTo bring something back from the trash, call library_delete with mode:'restore' and itemIds, collectionIds, or savedSearchIds. Restoring a collection restores its subcollections too. Deleting a collection trashes it rather than erasing it, so a collection the user deleted earlier can still be restored this way.",
};

const ATTACHMENT_UPDATE_GUIDANCE: ToolGuidance = {
  matches: (request) =>
    /\b(attachment|rename.*file|relink|broken.*link|missing.*file|delete.*attachment|remove.*attachment)\b/i.test(
      request.userText || "",
    ),
  instruction:
    "Use attachment_update to delete, rename, or re-link a single attachment. To find attachments, use library_read with sections:['attachments'] first. Renaming renames the file on disk, not just the title. Re-linking repairs an attachment whose file has moved or gone missing, and works for stored attachments as well as linked files; only linked URLs cannot be re-linked. For batch renaming with computed filenames, use zotero_script instead.",
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
  reparentItems: AgentToolDefinition<any, any>;
  relateItems: AgentToolDefinition<any, any>;
  updateLibraryTag: AgentToolDefinition<any, any>;
  setItemTags: AgentToolDefinition<any, any>;
}): AgentToolDefinition<any, unknown> {
  return createDelegatingTool({
    name: "library_update",
    label: "Update Library",
    description:
      "Apply Zotero library changes. kind:'tags' for tags on items (action 'add', 'remove', or 'set' to replace an item's whole tag list), kind:'tag' for the tag object itself across the library (rename, merge, delete, setColor), kind:'collections' for collection membership, kind:'metadata' for item fields, kind:'parent' to move a note or attachment to a different parent item (or detach it), kind:'related' for Zotero's Related links.",
    mutability: "write",
    requiresConfirmation: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: {
          type: "string",
          enum: ["tags", "collections", "metadata", "parent", "related", "tag"],
        },
        action: {
          type: "string",
          enum: [
            "add",
            "remove",
            "set",
            "rename",
            "merge",
            "delete",
            "setColor",
          ],
          description:
            "For kind:'tags' and kind:'collections': 'add' or 'remove'. For kind:'tags', 'set' replaces each item's tags with exactly the ones given — use it when the user wants a definite set, since adding is cumulative and drifts across batches. For kind:'tag' (the tag object itself): 'rename', 'merge', 'delete' or 'setColor'.",
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
              parentItemId: {
                type: ["number", "null"],
                description:
                  "For kind:'parent': the item this note or attachment should belong to, or null to detach it to top level.",
              },
            },
            required: ["itemId"],
          },
          description:
            "Per-item assignments: tags for kind:'tags', target collections for kind:'collections', parentItemId for kind:'parent'.",
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
        itemId: {
          type: "number",
          description:
            "Single Zotero item ID for kind:'metadata' or the source item for kind:'related'.",
        },
        relatedItemIds: {
          ...NUMBER_ARRAY_SCHEMA,
          description: "For kind:'related': the items to link to or unlink.",
        },
        mode: {
          type: "string",
          enum: ["add", "move"],
          description:
            "For kind:'collections' with action:'add'. 'add' (default) files the item and leaves its other collections alone. 'move' also takes it out of the collection named by 'from', so the item ends up filed only where the user asked. Use 'move' whenever the user says move, reorganize, or re-file — 'add' leaves the item in both places.",
        },
        from: {
          description:
            "Required when mode:'move'. A collection ID to take the items out of, or the string 'all' to replace their collection membership entirely. Never inferred, because guessing would unfile items from collections the user never mentioned.",
          anyOf: [{ type: "number" }, { type: "string", enum: ["all"] }],
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
        paperContext: PAPER_CONTEXT_REF_SCHEMA,
      },
    },
    summaries: {
      onCall: "Preparing library changes",
      onPending: "Waiting for confirmation on library changes",
      onApproved: "Applying library changes",
      onDenied: "Library changes cancelled",
      onSuccess: ({ effect }) =>
        effect === "none"
          ? "No library items changed"
          : effect === "partial"
            ? "Some library items updated"
            : "Library updated",
    },
    guidance: LIBRARY_UPDATE_GUIDANCE,
    chooseDelegate(args) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object with kind");
      }
      const delegateArgs = { ...args };
      delete delegateArgs.kind;
      if (args.kind === "tags") {
        // "set" is a different operation, not a variant of add: it replaces
        // the item's whole tag list rather than merging into it.
        if (args.action === "set") {
          const setArgs = { ...delegateArgs };
          delete setArgs.action;
          return ok({ tool: tools.setItemTags, args: setArgs });
        }
        return ok({ tool: tools.applyTags, args: delegateArgs });
      }
      if (args.kind === "tag") {
        return ok({ tool: tools.updateLibraryTag, args: delegateArgs });
      }
      if (args.kind === "collections") {
        return ok({ tool: tools.moveToCollection, args: delegateArgs });
      }
      if (args.kind === "metadata") {
        return ok({ tool: tools.updateMetadata, args: delegateArgs });
      }
      if (args.kind === "parent") {
        return ok({ tool: tools.reparentItems, args: delegateArgs });
      }
      if (args.kind === "related") {
        return ok({ tool: tools.relateItems, args: delegateArgs });
      }
      return fail(
        "kind must be one of: tags, collections, metadata, parent, related, tag",
      );
    },
  });
}

function createLibraryImportTool(tools: {
  importIdentifiers: AgentToolDefinition<any, any>;
  importLocalFiles: AgentToolDefinition<any, any>;
  createItems: AgentToolDefinition<any, any>;
}): AgentToolDefinition<any, unknown> {
  return createDelegatingTool({
    name: "library_import",
    label: "Import to Library",
    description:
      "Add items to Zotero. kind:'identifiers' for DOI/ISBN/arXiv lookups, kind:'files' for local files, kind:'manual' to create items from scratch when neither applies (a book with no DOI, a thesis, a dataset).",
    mutability: "write",
    requiresConfirmation: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: {
          type: "string",
          enum: ["identifiers", "files", "manual"],
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
        items: {
          type: "array",
          description:
            "For kind:'manual': the items to create, each { itemType, fields, creators, tags, collections }. Check the type's valid fields first with library_search({ entity:'itemTypes', mode:'list', text:'<itemType>' }).",
          items: { type: "object", additionalProperties: true },
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
      if (args.kind === "manual") {
        return ok({ tool: tools.createItems, args: delegateArgs });
      }
      return fail("kind must be one of: identifiers, files, manual");
    },
  });
}

function createLibraryDeleteTool(tools: {
  trashItems: AgentToolDefinition<any, any>;
  mergeItems: AgentToolDefinition<any, any>;
  restoreFromTrash: AgentToolDefinition<any, any>;
}): AgentToolDefinition<any, unknown> {
  return createDelegatingTool({
    name: "library_delete",
    label: "Delete / Restore / Merge Library Items",
    description:
      "Trash, restore, or merge Zotero objects. Use mode:'trash' to move items to the trash, mode:'restore' to bring trashed items, collections, or saved searches back, or mode:'merge' to merge duplicates into a master item.",
    mutability: "write",
    requiresConfirmation: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: {
          type: "string",
          enum: ["trash", "restore", "merge"],
        },
        itemIds: {
          ...NUMBER_ARRAY_SCHEMA,
          description:
            "Zotero item IDs to trash when mode:'trash', or to restore when mode:'restore'.",
        },
        collectionIds: {
          ...NUMBER_ARRAY_SCHEMA,
          description:
            "Collection IDs to restore when mode:'restore'. Subcollections come back with their parent.",
        },
        savedSearchIds: {
          ...NUMBER_ARRAY_SCHEMA,
          description: "Saved search IDs to restore when mode:'restore'.",
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
      onCall: "Preparing library change",
      onPending: "Waiting for confirmation on library change",
      onApproved: "Applying library change",
      onDenied: "Library delete/restore/merge cancelled",
      onSuccess: "Library delete/restore/merge completed",
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
      if (args.mode === "restore") {
        return ok({ tool: tools.restoreFromTrash, args: delegateArgs });
      }
      if (args.mode === "merge") {
        return ok({ tool: tools.mergeItems, args: delegateArgs });
      }
      return fail("mode must be one of: trash, restore, merge");
    },
  });
}

export function createBuiltInToolRegistry(
  deps: BuiltInAgentToolDeps,
): AgentToolRegistry {
  const registry = new AgentToolRegistry(
    new ActionContractService(deps.zoteroGateway),
  );
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
  const restoreFromTrash = createRestoreFromTrashTool(deps.zoteroGateway);
  const createItems = createCreateItemsTool(deps.zoteroGateway);
  const reparentItems = createReparentItemsTool(deps.zoteroGateway);
  const relateItems = createRelateItemsTool(deps.zoteroGateway);
  const writeNotesBatch = createWriteNotesBatchTool(deps.zoteroGateway);
  const updateLibraryTag = createUpdateLibraryTagTool(deps.zoteroGateway);
  const setItemTags = createSetItemTagsTool(deps.zoteroGateway);
  const savedSearchUpdate = createSavedSearchTool(deps.zoteroGateway);
  const mergeItems = createMergeItemsTool(deps.zoteroGateway);
  const manageAttachments = createManageAttachmentsTool(deps.zoteroGateway);
  const editCurrentNote = createEditCurrentNoteTool(deps.zoteroGateway);
  const runCommand = createRunCommandTool();
  const importLocalFiles = createImportLocalFilesTool(deps.zoteroGateway);
  const fileIO = createFileIOTool();
  const zoteroScript = createZoteroScriptTool();
  const undoLastAction = createUndoLastActionTool(deps.zoteroGateway);

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
  registry.register(createWebSearchTool());
  registry.register(createWebReadTool());
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
      reparentItems,
      relateItems,
      updateLibraryTag,
      setItemTags,
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
        "Create, append to, or edit a single Zotero note. Use this for note writing instead of returning note-ready text in chat. To write a note onto many items, use note_write_batch instead — one card for the whole set, rather than one approval per paper.",
      guidance: NOTE_WRITE_GUIDANCE,
    }),
  );
  registry.register(
    createRenamedTool({
      tool: writeNotesBatch,
      name: "note_write_batch",
      label: "Write Notes",
      description:
        "Write a note onto each of many items in one approved operation. Use this whenever the user asks for a note on several papers — calling note_write once per paper means one confirmation dialog per paper.",
    }),
  );
  registry.register(savedSearchUpdate);
  registry.register(createCiteExportTool(deps.zoteroGateway));
  registry.register(createLibrarySettingsTool(deps.zoteroGateway));
  registry.register(
    createLibraryImportTool({
      importIdentifiers,
      importLocalFiles,
      createItems,
    }),
  );
  registry.register(
    createLibraryDeleteTool({ trashItems, mergeItems, restoreFromTrash }),
  );
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
  registry.register(createRevertChangesTool(deps.zoteroGateway));
  registry.register(createAnnotatePdfTool(deps.zoteroGateway));
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
    restoreFromTrash,
    createItems,
    reparentItems,
    relateItems,
    writeNotesBatch,
    updateLibraryTag,
    setItemTags,
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
