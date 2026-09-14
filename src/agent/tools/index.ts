import { ModelSemanticReferenceResolver } from "../model/semanticReferenceResolver";
import { LibraryRetrieveService } from "../services/libraryRetrieveService";
import { PdfService } from "../services/pdfService";
import { RetrievalService } from "../services/retrievalService";
import { ZoteroGateway } from "../services/zoteroGateway";
import { createWorkflowScriptTool } from "./control/workflowScript";
import { createDelegatingTool, createRenamedTool } from "./facade";
import { registerPreparedLibraryActions } from "./preparedLibraryActions";
import { createCiteExportTool } from "./read/citeExport";
import { createLibraryRetrieveTool } from "./read/libraryRetrieve";
import { createPaperReadTool } from "./read/paperRead";
import { clearPdfToolCaches } from "./read/pdfToolUtils";
import { createQueryLibraryTool } from "./read/queryLibrary";
import { createReadAttachmentTool } from "./read/readAttachment";
import { createReadLibraryTool } from "./read/readLibrary";
import { createReadPaperTool } from "./read/readPaper";
import { createLiteratureReviewTool } from "./read/reviewLiterature";
import {
  createSearchLiteratureOnlineTool,
  LITERATURE_WORKFLOW_GUIDANCE,
  matchesLiteratureSearchGuidance,
} from "./read/searchLiteratureOnline";
import { createSearchPaperTool } from "./read/searchPaper";
import { createToolResultReadTool } from "./read/toolResultRead";
import { createViewPdfPagesTool } from "./read/viewPdfPages";
import { createWebReadTool } from "./read/webRead";
import { createWebSearchTool } from "./read/webSearch";
import { AgentToolRegistry } from "./registry";

import { ActionContractService } from "../contracts/actionContract";
import { PlanAmendmentService } from "../plans/amendments";
import { PdfFigureExtractionService } from "../services/pdfFigureExtractionService";
import { PdfPageService } from "../services/pdfPageService";
import { requestsNoteAction, WRITE_NOTE_SKILL_ID } from "../skills/noteIntent";
import type { AgentToolDefinition } from "../types";
import { createAmendPlanTool } from "./plan/amendPlan";
import { createApproveResearchExpansionTool } from "./plan/approveResearchExpansion";
import { createApproveResearchMutationTool } from "./plan/approveResearchMutation";
import { createPreparePlanExecutionTool } from "./plan/preparePlanExecution";
import { createRequestUserInputTool } from "./plan/requestUserInput";
import { createResearchUpdateTool } from "./plan/researchUpdate";
import {
  createSubmitDocumentTool,
  createSubmitPlanDocumentTool,
} from "./plan/submitPlanDocument";
import { createTaskUpdateTool } from "./plan/taskUpdate";
import { createUpdatePlanTool } from "./plan/updatePlan";
import { fail, ok, PAPER_CONTEXT_REF_SCHEMA, validateObject } from "./shared";
import { createAnnotatePdfTool } from "./write/annotatePdf";
import { createApplyTagsTool } from "./write/applyTags";
import {
  createEditCurrentNoteTool,
  SOURCE_NOTE_COPY_GUIDANCE,
} from "./write/editCurrentNote";
import { createFileIOTool } from "./write/fileIO";
import { createImportIdentifiersTool } from "./write/importIdentifiers";
import { createImportLocalFilesTool } from "./write/importLocalFiles";
import {
  createCreateItemsTool,
  createRelateItemsTool,
  createReparentItemsTool,
} from "./write/itemStructure";
import { createLibrarySettingsTool } from "./write/librarySettings";
import { createManageAttachmentsTool } from "./write/manageAttachments";
import { createManageCollectionsTool } from "./write/manageCollections";
import { createMergeItemsTool } from "./write/mergeItems";
import { createMoveToCollectionTool } from "./write/moveToCollection";
import { createRestoreFromTrashTool } from "./write/restoreFromTrash";
import { createRevertChangesTool } from "./write/revertChanges";
import { createRunCommandTool } from "./write/runCommand";
import { createSavedSearchTool } from "./write/savedSearches";
import {
  createSetItemTagsTool,
  createUpdateLibraryTagTool,
} from "./write/tagObjects";
import { createTrashItemsTool } from "./write/trashItems";
import { createUndoLastActionTool } from "./write/undoLastAction";
import { createUpdateMetadataTool } from "./write/updateMetadata";
import { createWriteNotesBatchTool } from "./write/writeNotesBatch";
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

const LIBRARY_SEARCH_GUIDANCE: ToolGuidance = {
  matches: (request) =>
    Boolean(
      request.classifiedIntent &&
      (request.classifiedIntent.retrievalIntent !== "none" ||
        request.classifiedIntent.actionIntents.length),
    ),
  instruction:
    "Use the host-resolved action contract for library operations. For a move_to_collection obligation, use its exact frozen item IDs and destinationCollectionId (or destination scope.collectionId). Set mode:'move' only when constraints.collectionMode is 'move', and set from only to the authorized sourceCollectionId. Otherwise use mode:'add' to preserve every existing membership. Never infer removal from the original wording or use from:'all' without that exact contract parameter. Missing or ambiguous references require semantic preparation or request_user_input before a mutation proposal. library_search({ entity:'collections', mode:'list', view:'tree' }) supplies collection metadata for permitted reference discovery." +
    "\n\nFor anything the simple filters cannot express, pass conditions[] — Zotero's own advanced-search vocabulary. Each clause is {condition, operator, value}. Useful conditions: fulltextContent (the PDF text), abstractNote, DOI, ISBN, publisher, publicationTitle, dateAdded, dateModified, note, annotationText, citationKey, retracted, itemType, tag, collection. If a condition and operator do not pair up, the error lists the operators that condition accepts — read it and retry rather than falling back to a plain text search." +
    "\n\nTwo rules that decide whether an advanced search works at all:" +
    "\n- fulltextContent, annotationText and childNote match a child item (an attachment or a note), so pass resolveToParents:true or those matches are dropped and the search looks empty." +
    "\n- joinMode:'all' is the default; use joinMode:'any' for an OR search. There are no grouping blocks, because opening one in Zotero flips every other condition in the query to OR." +
    "\n\nTo see the trash, pass filters:{ deleted:true }. That is the only way to enumerate trashed items, and it is what you need before calling library_delete with mode:'restore'.",
};

const LITERATURE_SEARCH_GUIDANCE: ToolGuidance = {
  matches: matchesLiteratureSearchGuidance,
  instruction:
    LITERATURE_WORKFLOW_GUIDANCE +
    "\n\nSource selection:" +
    "\n- recommendations, references, citations modes -> always use source:'openalex' (only OpenAlex supports these)." +
    "\n- search mode -> source:'openalex' (default, broadest coverage), source:'arxiv' (preprints, CS/ML/physics), or source:'europepmc' (biomedical/life sciences)." +
    "\n\nAuthor search:" +
    "\n- Encode an author filter from the prepared research scope in the 'author' parameter (e.g. author:'Adrien Peyrache')." +
    "\n- You can combine 'author' with 'query' to find an author's papers on a specific topic." +
    "\n- Do NOT put author names in the 'query' parameter; use 'author' instead.",
};

const LIBRARY_UPDATE_GUIDANCE: ToolGuidance = {
  matches: (request) =>
    Boolean(
      request.classifiedIntent?.actionIntents.some((action) =>
        ["zotero.tags", "zotero.metadata", "zotero.collections"].includes(
          action.capability,
        ),
      ),
    ),
  instruction:
    "Execute resolved library write obligations with library_update and report verified receipts. Central policy decides whether a review card is required. Use kind:'tags' for tag changes, kind:'collections' for collection membership, and kind:'metadata' for item metadata fields. Batch one uniform change across all applicable item IDs in a single call. For different per-item changes, use assignments when the schema supports them; A computation using zotero_script uses the same exact-effect authority; the mechanism alone adds no confirmation. Explicit script prohibitions remain binding. For metadata obligations with permitted external evidence discovery, use literature_search with workflow:'review' and mode:'metadata' to fetch canonical data, then continue through the exact review/update flow. Bind direct metadata updates to the field values in the resolved obligation or approved review.",
};

const NOTE_WRITE_GUIDANCE: ToolGuidance = {
  matches: (request, context) =>
    Boolean(
      context?.matchedSkillIds.includes(WRITE_NOTE_SKILL_ID) ||
      request.forcedSkillIds?.includes(WRITE_NOTE_SKILL_ID) ||
      requestsNoteAction(request) ||
      request.actionContract?.obligations.some(
        (obligation) => obligation.capability === "zotero.notes",
      ),
    ),
  instruction:
    "Execute a resolved note_edit obligation with note_write mode:'edit' against its exact note target. For a bound Selected text passage, pass selection:{index:<1-based Selected text number>,replacement:<final Markdown>}. The host binds its owning note, replaces the selected structure, preserves surrounding content and embedded assets, and saves and verifies in one action. Preserve headings and list structure in the replacement unless the user requests changing them. Do not copy find text, reconstruct native HTML, or call a separate readback tool after verified success. For precise edits without a bound selection, use patches with plain replacement text; findFormat:'markdown' interprets Markdown copied from library_read. Do not substitute chat alternatives for the requested edit. Auto applies clear edits directly and displays the actual verified diff afterward. Requested review and Safe use the existing diff card before applying. Map the resolved note_append obligation to mode:'append' and note_create to mode:'create'. Use only the contract's resolved parent or collection destination; unresolved names return to semantic preparation. Pass the finalized asset in its declared format. The requested note must be written with note_write rather than returned as note-ready prose in chat. Requested new notes ordinarily need no draft confirmation, except for action UI or an explicit review preference; after verification the UI displays the saved content and a direct link to the native note. Do not repeat the full saved content in the completion message. After an edit or append tool returns verified success, the change is saved; do not claim a diff is still awaiting review. " +
    SOURCE_NOTE_COPY_GUIDANCE,
};

const LIBRARY_IMPORT_GUIDANCE: ToolGuidance = {
  matches: (request) =>
    Boolean(
      request.classifiedIntent?.actionIntents.some((action) =>
        ["import_local_files"].includes(action.operation),
      ),
    ),
  instruction:
    "Use library_import with kind:'files' to import local files from the user's filesystem into Zotero. Use only resolved paths within the contract's source boundary. Missing paths require preparation; this import obligation does not independently authorize command execution. A bibliography file (.ris, .bib, .enw, .nbib, RDF) has its references imported as real items; other files are attached, and PDFs go through Zotero's metadata lookup so they arrive with a title and authors. Optionally specify a targetCollectionId to file the results into a collection." +
    "\n\nkind:'identifiers' resolves DOIs, ISBNs, PMIDs, arXiv IDs and ADS bibcodes. It cannot import from a page URL — Zotero has no translator path for that — so take the DOI or arXiv ID off the page instead.",
};

const LIBRARY_DELETE_GUIDANCE: ToolGuidance = {
  matches: (request) =>
    Boolean(
      request.classifiedIntent?.actionIntents.some((action) =>
        ["merge_items", "trash_items", "restore_from_trash"].includes(
          action.operation,
        ),
      ),
    ),
  instruction:
    "To merge duplicates: first use library_search({ entity:'items', mode:'duplicates' }) to find duplicate groups, then use library_read to compare metadata and decide which item is the best master, then call library_delete({ mode:'merge', ... }) with the master and the others. The master keeps all children (attachments, notes, tags, collections) from the merged items." +
    "\n\nTo bring something back from the trash, call library_delete with mode:'restore' and itemIds, collectionIds, or savedSearchIds. Restoring a collection restores its subcollections too. Deleting a collection trashes it rather than erasing it, so a collection the user deleted earlier can still be restored this way.",
};

const ATTACHMENT_UPDATE_GUIDANCE: ToolGuidance = {
  matches: (request) =>
    Boolean(
      request.classifiedIntent?.actionIntents.some((action) =>
        [
          "delete_attachment",
          "rename_attachment",
          "relink_attachment",
        ].includes(action.operation),
      ),
    ),
  instruction:
    "Use attachment_update to delete, rename, or re-link a single attachment. To find attachments, use library_read with sections:['attachments'] first. Renaming renames the file on disk, not just the title. Re-linking repairs an attachment whose file has moved or gone missing, and works for stored attachments as well as linked files; only linked URLs cannot be re-linked. Batch renaming with computed filenames requires separately authorized computation and exact attachment targets.",
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
    executionClass: "external_effect",
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
            "For kind:'tags' and kind:'collections': 'add' or 'remove'. For kind:'tags', 'set' replaces each item's tags with exactly the ones given and corresponds only to a set_item_tags obligation; add/remove correspond to apply_tags/remove_tags. For kind:'tag' (the tag object itself): 'rename', 'merge', 'delete' or 'setColor'.",
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
            "For kind:'collections' with action:'add', follow the resolved obligation: constraints.collectionMode:'move' requires mode:'move' and from equal to its exact sourceCollectionId. Otherwise mode:'add' preserves all existing memberships. The original request wording cannot override this contract.",
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
    executionClass: "external_effect",
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
    executionClass: "external_effect",
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
  const planAmendments = new PlanAmendmentService(deps.zoteroGateway);
  const registry = new AgentToolRegistry(
    new ActionContractService(
      deps.zoteroGateway,
      new ModelSemanticReferenceResolver(),
    ),
    planAmendments,
  );
  registry.register(
    createWorkflowScriptTool((request) =>
      registry.listToolsForRequest(request),
    ),
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
        "Search scholarly sources and return saved candidates for ranking. Discovery then uses literature_review; explicit imports use library_import directly. Use workflow:'review', mode:'metadata' for external metadata review.",
      guidance: LITERATURE_SEARCH_GUIDANCE,
    }),
  );
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
        "Create, append to, or edit a single Zotero note. Requested new notes are created directly and shown as saved-note cards. Use this for note writing instead of returning note-ready text in chat. To write a note onto many items, use note_write_batch instead.",
      guidance: NOTE_WRITE_GUIDANCE,
    }),
  );
  registry.register(
    createRenamedTool({
      tool: writeNotesBatch,
      name: "note_write_batch",
      label: "Write Notes",
      description:
        "Write a note onto each of many items in one batch operation. Use this for resolved per-item note_create obligations covering those exact papers.",
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
  registry.register(createUpdatePlanTool(deps.zoteroGateway));
  registry.register(createPreparePlanExecutionTool(deps.zoteroGateway));
  registry.register(
    createRequestUserInputTool((request) =>
      registry.createActionContract(request),
    ),
  );
  registry.register(createTaskUpdateTool());
  registry.register(createSubmitDocumentTool(deps.zoteroGateway));
  registry.register(createSubmitPlanDocumentTool(deps.zoteroGateway));
  registry.register(createResearchUpdateTool(deps.zoteroGateway));
  registry.register(createApproveResearchExpansionTool(planAmendments));
  registry.register(createAmendPlanTool(deps.zoteroGateway, planAmendments));
  registry.register(createApproveResearchMutationTool());

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
  registerPreparedLibraryActions(registry, deps.zoteroGateway);
  return registry;
}

export function clearAllAgentToolCaches(conversationKey: number): void {
  clearPdfToolCaches(conversationKey);
}
