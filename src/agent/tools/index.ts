import { LibraryRetrieveService } from "../services/libraryRetrieveService";
import { PdfService } from "../services/pdfService";
import { RetrievalService } from "../services/retrievalService";
import { ZoteroGateway } from "../services/zoteroGateway";
import { createWorkflowScriptTool } from "./control/workflowScript";
import { createDelegatingTool } from "./facade";
import { userTextSignal } from "./guidance";
import { createCiteExportTool } from "./read/citeExport";
import { createLibraryRetrieveTool } from "./read/libraryRetrieve";
import { createLoadSkillTool } from "./read/loadSkill";
import { createPaperReadTool } from "./read/paperRead";
import { clearPdfToolCaches } from "./read/pdfToolUtils";
import { createLibrarySearchTool } from "./read/librarySearch";
import { createReadAttachmentTool } from "./read/readAttachment";
import { createLibraryReadTool } from "./read/libraryRead";
import { createLiteratureReviewTool } from "./read/reviewLiterature";
import { createLiteratureSearchTool } from "./read/literatureSearch";
import { createContextReadTool } from "./read/contextRead";
import { createWebReadTool } from "./read/webRead";
import { createWebSearchTool } from "./read/webSearch";
import { AgentToolRegistry } from "./registry";

import { ActionContractService } from "../contracts/actionContract";
import { PdfFigureExtractionService } from "../services/pdfFigureExtractionService";
import { PdfPageService } from "../services/pdfPageService";
import type { AgentToolDefinition } from "../types";
import { createRequestUserInputTool } from "./control/requestUserInput";
import { createSubmitDocumentTool } from "./control/submitDocument";
import { createTaskUpdateTool } from "./control/taskUpdate";
import { createZoteroPaperDigestSources } from "../digests/digestJobHost";
import { SEARCH_CONDITION_SCHEMA } from "./searchConditions";
import {
  fail,
  normalizePositiveInt,
  ok,
  PAPER_CONTEXT_REF_SCHEMA,
  validateObject,
} from "./shared";
import { createAnnotatePdfTool } from "./write/annotatePdf";
import { createApplyTagsTool } from "./write/applyTags";
import { createAttachmentUpdateTool } from "./write/attachmentUpdate";
import { createCollectionUpdateTool } from "./write/collectionUpdate";
import { createFileIOTool } from "./write/fileIO";
import { createImportIdentifiersTool } from "./write/importIdentifiers";
import { createImportLocalFilesTool } from "./write/importLocalFiles";
import {
  createCreateItemsTool,
  createRelateItemsTool,
  createReparentItemsTool,
} from "./write/itemStructure";
import { createLibrarySettingsTool } from "./write/librarySettings";
import { createMergeItemsTool } from "./write/mergeItems";
import { createMoveToCollectionTool } from "./write/moveToCollection";
import { createRestoreFromTrashTool } from "./write/restoreFromTrash";
import { createRunCommandTool } from "./write/runCommand";
import { createSavedSearchTool } from "./write/savedSearches";
import {
  createSetItemTagsTool,
  createUpdateLibraryTagTool,
} from "./write/tagObjects";
import { createTrashItemsTool } from "./write/trashItems";
import { createUndoTool } from "./write/undo";
import { createUpdateMetadataTool } from "./write/updateMetadata";
import { createNoteWriteTool } from "./write/noteWrite";
import { createNoteWriteBatchTool } from "./write/noteWriteBatch";
import { createZoteroScriptTool } from "./write/zoteroScript";

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

const LIBRARY_UPDATE_GUIDANCE: ToolGuidance = {
  // Only the attachment signal selects it.
  matches: (request) =>
    userTextSignal(request, (signals) => signals.mentionsAttachment),
  instruction:
    "Make the requested library changes with library_update and report its verified receipts. Central policy decides whether a review card is required. Use kind:'tags' for tag changes, kind:'collections' for collection membership, and kind:'metadata' for item metadata fields. Batch one uniform change across all applicable item IDs in a single call. For different per-item changes, use assignments when the schema supports them. A zotero_script computation goes through the same authorization; the mechanism alone adds no confirmation. When metadata should come from external sources, use literature_search with workflow:'review' and mode:'metadata' to fetch canonical data, then continue through its review/update flow. Set metadata fields to the values the user asked for or approved in that review." +
    "\n\nUse kind:'attachment' to delete, rename, or re-link a single attachment. To find attachments, use library_read with sections:['attachments'] first. Renaming renames the file on disk, not just the title. Re-linking repairs an attachment whose file has moved or gone missing, and works for stored attachments as well as linked files; only linked URLs cannot be re-linked. Batch renaming with computed filenames requires separately authorized computation and exact attachment targets.",
};

const LIBRARY_IMPORT_GUIDANCE: ToolGuidance = {
  matches: (request) =>
    userTextSignal(request, (signals) => signals.mentionsImport),
  instruction:
    "Use library_import with kind:'files' to import local files from the user's filesystem into Zotero. Use only paths the user gave or that you resolved; when one is missing, find it or ask. Importing files does not authorize running commands. A bibliography file (.ris, .bib, .enw, .nbib, RDF) has its references imported as real items; other files are attached, and PDFs go through Zotero's metadata lookup so they arrive with a title and authors. Optionally specify a targetCollectionId to file the results into a collection." +
    "\n\nkind:'identifiers' resolves DOIs, ISBNs, PMIDs, arXiv IDs and ADS bibcodes. It cannot import from a page URL — Zotero has no translator path for that — so take the DOI or arXiv ID off the page instead.",
};

const LIBRARY_DELETE_GUIDANCE: ToolGuidance = {
  matches: (request) =>
    userTextSignal(
      request,
      (signals) => signals.mentionsDuplicates || signals.mentionsTrash,
    ),
  instruction:
    "To merge duplicates: first use library_search({ entity:'items', mode:'duplicates' }) to find duplicate groups, then use library_read to compare metadata and decide which item is the best master, then call library_delete({ mode:'merge', ... }) with the master and the others. The master keeps all children (attachments, notes, tags, collections) from the merged items." +
    "\n\nTo bring something back from the trash, call library_delete with mode:'restore' and itemIds, collectionIds, or savedSearchIds. Restoring a collection restores its subcollections too. Deleting a collection trashes it rather than erasing it, so a collection the user deleted earlier can still be restored this way.",
};

function createLibraryUpdateTool(tools: {
  applyTags: AgentToolDefinition<any, any>;
  moveToCollection: AgentToolDefinition<any, any>;
  updateMetadata: AgentToolDefinition<any, any>;
  reparentItems: AgentToolDefinition<any, any>;
  relateItems: AgentToolDefinition<any, any>;
  updateLibraryTag: AgentToolDefinition<any, any>;
  setItemTags: AgentToolDefinition<any, any>;
  collectionUpdate: AgentToolDefinition<any, any>;
  attachmentUpdate: AgentToolDefinition<any, any>;
  savedSearchUpdate: AgentToolDefinition<any, any>;
}): AgentToolDefinition<any, unknown> {
  return createDelegatingTool({
    name: "library_update",
    label: "Update Library",
    description:
      "Apply Zotero library changes. kind:'tags' for tags on items (action 'add', 'remove', or 'set' to replace an item's whole tag list), kind:'tag' for the tag object itself across the library (rename, merge, delete, setColor), kind:'collections' for collection membership, kind:'metadata' for item fields, kind:'parent' to move a note or attachment to a different parent item (or detach it), kind:'related' for Zotero's Related links, kind:'collection' for the collection itself (create, rename, move, delete), kind:'attachment' for one attachment (rename, relink, delete), kind:'savedSearch' for a saved search (save creates or replaces one, delete trashes it).",
    executionClass: "external_effect",
    workCategory: "zotero_action",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: {
          type: "string",
          enum: [
            "tags",
            "collections",
            "metadata",
            "parent",
            "related",
            "tag",
            "collection",
            "attachment",
            "savedSearch",
          ],
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
            "create",
            "move",
            "relink",
            "save",
          ],
          description:
            "For kind:'tags' and kind:'collections': 'add' or 'remove'. For kind:'tags', 'set' replaces each item's tags with exactly the ones given: use it only when the user asked to replace the tags, and add or remove otherwise. For kind:'tag' (the tag object itself): 'rename', 'merge', 'delete' or 'setColor'. For kind:'collection': 'create', 'rename', 'move' or 'delete'. For kind:'attachment': 'rename', 'relink' or 'delete'. For kind:'savedSearch': 'save' or 'delete'.",
        },
        itemIds: {
          ...NUMBER_ARRAY_SCHEMA,
          description: "Zotero item IDs to update.",
        },
        tags: {
          ...STRING_ARRAY_SCHEMA,
          description:
            "Uniform tags to add, remove, or set on itemIds when kind:'tags'. For action:'set', this is the complete replacement list (an empty array clears tags). Use assignments instead only when different items need different lists.",
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
            "For kind:'collections' with action:'add': mode:'add' preserves every existing membership. mode:'move' additionally removes only the membership named by from. Omission means add-only and is never treated as a move, so when the user asks to move papers, pass mode:'move' with from.",
        },
        from: {
          description:
            "Required when mode:'move'. A collection ID to take the items out of, or the string 'all' to replace their collection membership entirely. Never inferred, because guessing would unfile items from collections the user never mentioned.",
          anyOf: [{ type: "number" }, { type: "string", enum: ["all"] }],
        },
        collectionId: {
          type: "number",
          description:
            "Collection ID to remove items from when kind:'collections' and action:'remove'; the collection to rename, move, or delete when kind:'collection'.",
        },
        name: {
          type: "string",
          description:
            "For kind:'collection' action:'create': the new collection's name. For kind:'savedSearch' action:'save': the saved search name.",
        },
        newName: {
          type: "string",
          description:
            "For kind:'collection' action:'rename': the new collection name. For kind:'attachment' action:'rename': the new filename.",
        },
        parentCollectionId: {
          type: ["number", "null"],
          description:
            "For kind:'collection': the parent for 'create', or the new parent for 'move' (null moves it to top level).",
        },
        deleteItems: {
          type: "boolean",
          description:
            "For kind:'collection' action:'delete': also trash the collection's items. Defaults to false, which leaves them in the library.",
        },
        permanent: {
          type: "boolean",
          description:
            "For kind:'collection' or kind:'savedSearch' action:'delete': erase instead of trashing. Cannot be undone; only when the user explicitly asked.",
        },
        attachmentId: {
          type: "number",
          description: "For kind:'attachment': the attachment's item ID.",
        },
        newPath: {
          type: "string",
          description:
            "For kind:'attachment' action:'relink': the file's new absolute path.",
        },
        conditions: {
          type: "array",
          items: SEARCH_CONDITION_SCHEMA,
          description:
            "For kind:'savedSearch' action:'save': the conditions, in the shape library_search takes.",
        },
        joinMode: {
          type: "string",
          enum: ["all", "any"],
          description: "For kind:'savedSearch' action:'save'.",
        },
        savedSearchId: {
          type: "number",
          description:
            "For kind:'savedSearch': the saved search to replace with 'save', or to remove with 'delete'.",
        },
        tag: {
          type: "string",
          description: "For kind:'tag': the existing tag name.",
        },
        newTag: {
          type: "string",
          description:
            "For kind:'tag' action:'rename' or 'merge': the new tag name.",
        },
        color: {
          type: "string",
          description:
            "For kind:'tag' action:'setColor': a hex colour, e.g. '#FF6666'.",
        },
        position: {
          type: "number",
          description:
            "For kind:'tag' action:'setColor': the coloured-tag slot, starting at 0.",
        },
        libraryID: {
          type: "number",
          description:
            "Library ID for kind:'tag' and kind:'collection' (group libraries).",
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
    delegates: Object.values(tools),
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
          if (
            args.assignments !== undefined &&
            (args.itemIds !== undefined || args.tags !== undefined)
          ) {
            return fail(
              "Use either itemIds with tags for one uniform replacement, or per-item assignments, not both.",
            );
          }
          if (
            args.assignments === undefined &&
            Array.isArray(args.itemIds) &&
            Array.isArray(args.tags)
          ) {
            setArgs.assignments = args.itemIds.map((itemId) => ({
              itemId,
              tags: args.tags,
            }));
          }
          delete setArgs.itemIds;
          delete setArgs.tags;
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
        // The metadata delegate names one item per operation. itemIds is the
        // facade's uniform-change list, so each named item gets its own
        // operation; dropping it would write the open paper instead.
        const itemIds = [
          ...new Set(
            [args.itemId, ...(Array.isArray(args.itemIds) ? args.itemIds : [])]
              .map((value) => normalizePositiveInt(value))
              .filter((value): value is number => Boolean(value)),
          ),
        ];
        if (Array.isArray(args.operations)) {
          return args.itemIds === undefined
            ? ok({ tool: tools.updateMetadata, args: delegateArgs })
            : fail(
                "Use either itemIds with one metadata patch, or per-item operations, not both.",
              );
        }
        const metadataArgs = { ...delegateArgs };
        delete metadataArgs.itemIds;
        if (itemIds.length > 1) {
          delete metadataArgs.itemId;
          delete metadataArgs.metadata;
          metadataArgs.operations = itemIds.map((itemId) => ({
            itemId,
            metadata: args.metadata,
          }));
        } else if (itemIds.length === 1) {
          metadataArgs.itemId = itemIds[0];
        }
        return ok({ tool: tools.updateMetadata, args: metadataArgs });
      }
      if (args.kind === "parent") {
        return ok({ tool: tools.reparentItems, args: delegateArgs });
      }
      if (args.kind === "related") {
        return ok({ tool: tools.relateItems, args: delegateArgs });
      }
      if (args.kind === "collection") {
        return ok({ tool: tools.collectionUpdate, args: delegateArgs });
      }
      if (args.kind === "attachment") {
        return ok({ tool: tools.attachmentUpdate, args: delegateArgs });
      }
      if (args.kind === "savedSearch") {
        return ok({ tool: tools.savedSearchUpdate, args: delegateArgs });
      }
      return fail(
        "kind must be one of: tags, collections, metadata, parent, related, tag, collection, attachment, savedSearch",
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
      "Add items to Zotero. kind:'identifiers' for DOI, ISBN, arXiv ID, PMID, or ADS bibcode lookups, kind:'files' for local files, kind:'manual' to create items from scratch when neither applies (a book with no DOI, a thesis, a dataset).",
    // Adding items to Zotero. A files-mode call resolves to the local-files delegate
    // and is labelled external_system for that call.
    executionClass: "external_effect",
    workCategory: "zotero_action",
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
            "DOI, ISBN, arXiv ID, PMID, or ADS bibcode values to import when kind:'identifiers'.",
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
    delegates: Object.values(tools),
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
    executionClass: "external_effect",
    workCategory: "zotero_action",
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
    delegates: Object.values(tools),
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
  registry.register(
    createWorkflowScriptTool((request) =>
      registry.listToolsForRequest(request),
    ),
  );
  const libraryRetrieve = createLibraryRetrieveTool(
    new LibraryRetrieveService(deps.zoteroGateway, deps.pdfService),
  );
  const figureExtractionService = new PdfFigureExtractionService(
    deps.pdfPageService,
  );
  const readAttachment = createReadAttachmentTool(
    deps.zoteroGateway,
    deps.pdfPageService,
  );
  const applyTags = createApplyTagsTool(deps.zoteroGateway);
  const moveToCollection = createMoveToCollectionTool(deps.zoteroGateway);
  const updateMetadata = createUpdateMetadataTool(deps.zoteroGateway);
  const importIdentifiers = createImportIdentifiersTool(deps.zoteroGateway);
  const trashItems = createTrashItemsTool(deps.zoteroGateway);
  const restoreFromTrash = createRestoreFromTrashTool(deps.zoteroGateway);
  const createItems = createCreateItemsTool(deps.zoteroGateway);
  const reparentItems = createReparentItemsTool(deps.zoteroGateway);
  const relateItems = createRelateItemsTool(deps.zoteroGateway);
  const updateLibraryTag = createUpdateLibraryTagTool(deps.zoteroGateway);
  const setItemTags = createSetItemTagsTool(deps.zoteroGateway);
  const collectionUpdate = createCollectionUpdateTool(deps.zoteroGateway);
  const attachmentUpdate = createAttachmentUpdateTool(deps.zoteroGateway);
  const savedSearchUpdate = createSavedSearchTool(deps.zoteroGateway);
  const mergeItems = createMergeItemsTool(deps.zoteroGateway);
  const runCommand = createRunCommandTool();
  const importLocalFiles = createImportLocalFilesTool(deps.zoteroGateway);
  const fileIO = createFileIOTool();
  const zoteroScript = createZoteroScriptTool();

  registry.register(createLibrarySearchTool(deps.zoteroGateway));
  registry.register(createWebSearchTool());
  registry.register(createWebReadTool());
  registry.register(createLibraryReadTool(deps.zoteroGateway));
  registry.register(readAttachment);
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
  registry.register(createLiteratureSearchTool(deps.zoteroGateway));
  registry.register(createLiteratureReviewTool(deps.zoteroGateway));
  registry.register(
    createLibraryUpdateTool({
      applyTags,
      moveToCollection,
      updateMetadata,
      reparentItems,
      relateItems,
      updateLibraryTag,
      setItemTags,
      collectionUpdate,
      attachmentUpdate,
      savedSearchUpdate,
    }),
  );
  registry.register(createNoteWriteTool(deps.zoteroGateway));
  registry.register(createNoteWriteBatchTool(deps.zoteroGateway));
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
  registry.register(createUndoTool(deps.zoteroGateway));
  registry.register(createAnnotatePdfTool(deps.zoteroGateway));
  registry.register(fileIO);
  registry.register(runCommand);
  registry.register(zoteroScript);
  registry.register(createContextReadTool());
  registry.register(
    createLoadSkillTool({
      getToolDefinitions: (request) =>
        registry.listToolDefinitionsForRequest(request),
    }),
  );
  registry.register(createRequestUserInputTool());
  registry.register(
    createTaskUpdateTool({
      digests: createZoteroPaperDigestSources({
        zoteroGateway: deps.zoteroGateway,
        pdfService: deps.pdfService,
      }),
    }),
  );
  registry.register(createSubmitDocumentTool(deps.zoteroGateway));
  return registry;
}

export function clearAllAgentToolCaches(conversationKey: number): void {
  clearPdfToolCaches(conversationKey);
}
