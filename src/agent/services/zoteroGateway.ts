import {
  libraryIndexService,
  normalizeLibraryIndexText,
  type LibraryIndexItem,
  type LibraryIndexSnapshot,
} from "../../services/libraryIndexService";
import {
  createNoteFromAssistantText,
  createStandaloneNoteFromAssistantText,
  normalizeNoteSourceText,
  readNoteSnapshot,
  renderRawNoteHtml,
  stripNoteHtml,
} from "../../modules/contextPanel/notes";
import {
  importNoteImageAsset,
  type NoteImageImportInput,
} from "../../modules/contextPanel/noteImages";
import {
  getActiveContextAttachmentFromTabs,
  resolveContextSourceItem,
} from "../../modules/contextPanel/contextResolution";
import { resolvePaperContextRefFromAttachment } from "../../modules/contextPanel/paperAttribution";
import { invalidateCachedContextText } from "../../modules/contextPanel/pdfContext";
import { ensureMineruCacheDirForAttachment } from "../../modules/contextPanel/mineruSync";
import {
  persistVerifiedNoteHtml,
  type CreatedZoteroNoteReceipt,
} from "../../modules/contextPanel/notePersistence";
import type { AgentRuntimeRequest } from "../types";
import { getTurnPapers } from "../context/requestTurnPaperScope";
import type {
  GeneratedChatImage,
  PaperContentSourceMode,
  PaperContextRef,
  TagContextRef,
} from "../../shared/types";
import {
  isGlobalPortalItem,
  isPaperPortalItem,
  resolvePaperPortalBaseItem,
} from "../../modules/contextPanel/portalScope";
import {
  refusalFor,
  type LibraryOperation,
} from "../capabilities/libraryObjects";
import type {
  BatchTagAssignment,
  EditableArticleCreator,
  EditableArticleMetadataField,
  EditableArticleMetadataPatch,
  EditableArticleMetadataSnapshot,
} from "./libraryMutation/valueTypes";
export type {
  BatchTagAssignment,
  EditableArticleCreator,
  EditableArticleMetadataField,
  EditableArticleMetadataPatch,
  EditableArticleMetadataSnapshot,
} from "./libraryMutation/valueTypes";

export const EDITABLE_ARTICLE_METADATA_FIELDS = [
  "title",
  "shortTitle",
  "abstractNote",
  "publicationTitle",
  "journalAbbreviation",
  "proceedingsTitle",
  "date",
  "volume",
  "issue",
  "pages",
  "DOI",
  "url",
  "language",
  "extra",
  "ISSN",
  "ISBN",
  "publisher",
  "place",
] as const;

export type LibraryPaperTargetAttachment = {
  contextItemId: number;
  title: string;
};

export type LibraryPaperTarget = {
  itemId: number;
  libraryID?: number;
  title: string;
  firstCreator?: string;
  year?: string;
  dateAdded?: string;
  attachments: LibraryPaperTargetAttachment[];
  tags: string[];
  collectionIds: number[];
};

export type LibraryItemTargetAttachment = {
  contextItemId: number;
  title: string;
  contentType: string;
  /** For PDF attachments: Zotero full-text indexing state. Omitted for non-PDFs. */
  indexingState?:
    | "indexed"
    | "partial"
    | "unindexed"
    | "queued"
    | "unavailable";
  /** If MinerU has parsed this PDF, the cache directory path containing markdown + images. */
  mineruCacheDir?: string;
};

export type LibraryItemTarget = {
  itemId: number;
  libraryID?: number;
  itemType: string;
  title: string;
  firstCreator?: string;
  year?: string;
  dateAdded?: string;
  attachments: LibraryItemTargetAttachment[];
  tags: string[];
  collectionIds: number[];
  noteKind?: "item" | "standalone";
};

export type CollectionBrowseNode = {
  collectionId: number;
  name: string;
  paperCount: number;
  descendantPaperCount: number;
  childCollections: CollectionBrowseNode[];
};

/**
 * Result of `saveAnswerToNote`.
 *
 * The bare `"created" | "appended" | "standalone_created"` string this
 * replaced is why no caller could act on a note it had just written — the id
 * existed two layers down and was thrown away on the way up (issue #374).
 */
export type SaveAnswerToNoteResult = {
  status: "created" | "appended" | "standalone_created";
  noteId?: number;
  collections?: number[];
  createdNoteReceipt?: CreatedZoteroNoteReceipt;
};

export type CollectionSummary = {
  collectionId: number;
  name: string;
  libraryID: number;
  path?: string;
};

export type BatchTagItemResult = {
  itemId: number;
  title: string;
  status: "updated" | "skipped" | "missing";
  addedTags: string[];
  skippedTags: string[];
  reason?: string;
};

export type BatchMoveItemResult = {
  itemId: number;
  title: string;
  status: "moved" | "skipped" | "missing";
  targetCollectionId?: number;
  targetCollectionName?: string;
  reason?: string;
};

export type BatchMoveAssignment = {
  itemId: number;
  targetCollectionId: number;
};

/**
 * The exact collection membership an item should end up with.
 *
 * This is the primitive a real "move" needs. Membership is a *set*, so the
 * only way to move an item without corrupting it is to state the whole set
 * at once — and the only inverse that restores a move is the set it had
 * before. Expressing a move as add-then-remove cannot do either.
 */
export type ItemCollectionSet = {
  itemId: number;
  collectionIds: number[];
};

export type PaperNoteRecord = {
  noteId: number;
  title: string;
  noteText: string;
  wordCount: number;
};

export type PaperAnnotationRecord = {
  annotationId: number;
  type: string;
  text: string;
  comment?: string;
  color?: string;
  pageLabel?: string;
};

export type RelatedPaperResult = LibraryPaperTarget & {
  matchScore: number;
  matchReasons: string[];
};

export type DuplicateGroup = {
  matchReason: string;
  papers: LibraryPaperTarget[];
};

function normalizeMetadataValue(value: unknown): string {
  return `${value ?? ""}`.trim();
}

function normalizeText(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim();
}

/**
 * Resolves an item for a collection-membership write and reports why it may
 * not proceed, using the declared capability matrix rather than the old
 * regular-item filter.
 *
 * The behaviour change that matters: standalone notes and standalone
 * attachments are legal collection members in Zotero and are now filed
 * instead of being reported as "Item not found", and a child attachment is
 * refused explicitly instead of silently filing its parent.
 *
 * Portal pseudo-items are still unwrapped first — they stand in for a real
 * paper and must be resolved before the matrix sees them.
 */
function resolveMatrixItem(
  item: Zotero.Item | null | undefined,
  itemId: number,
  operation: LibraryOperation,
): { item: Zotero.Item } | { refusal: string } {
  if (!item) {
    return { refusal: `No item with ID ${itemId} exists in this library` };
  }
  if (isGlobalPortalItem(item)) {
    return { refusal: "The library portal is not an item that can be filed" };
  }
  const resolved = isPaperPortalItem(item)
    ? resolvePaperPortalBaseItem(item)
    : item;
  if (!resolved) {
    return { refusal: `No item with ID ${itemId} exists in this library` };
  }
  const refusal = refusalFor(operation, resolved, itemId);
  return refusal ? { refusal } : { item: resolved };
}

function resolveRegularItem(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  if (!item) return null;
  if (isGlobalPortalItem(item)) return null;
  if (isPaperPortalItem(item)) {
    return resolvePaperPortalBaseItem(item);
  }
  if (item.isAttachment() && item.parentID) {
    const parent = Zotero.Items.get(item.parentID) || null;
    return parent?.isRegularItem?.() ? parent : null;
  }
  return item?.isRegularItem?.() ? item : null;
}

function getItemTypeName(item: Zotero.Item): string {
  try {
    const name = (
      Zotero as unknown as { ItemTypes?: { getName?: (id: number) => string } }
    ).ItemTypes?.getName?.(item.itemTypeID);
    return typeof name === "string" && name.trim() ? name.trim() : "";
  } catch (_error) {
    void _error;
    return "";
  }
}

/**
 * Fields that are never patchable, whatever the item type.
 *
 * These are primary or computed columns rather than `itemData` fields.
 * `setField` throws for most of them, and the few it accepts (`dateAdded`,
 * `dateModified`) would let the agent rewrite provenance -- so they are
 * refused here with a reason rather than surfacing as a raw Zotero throw.
 */
const NON_EDITABLE_METADATA_FIELDS = new Set([
  "id",
  "key",
  "libraryID",
  "itemID",
  "itemType",
  "itemTypeID",
  "dateAdded",
  "dateModified",
  "version",
  "synced",
  "deleted",
  "firstCreator",
  "numChildren",
  "parentItem",
  "parentID",
  "parentKey",
  "relations",
  "collections",
  "tags",
  "note",
  "createdByUserID",
  "lastModifiedByUserID",
]);

/**
 * Whether a field can be written on this particular item.
 *
 * Two defects here, both of which reported success while doing the wrong
 * thing:
 *
 * - No base-field mapping. `publicationTitle` is a *base* field whose
 *   type-specific name is `bookTitle` on a book section and
 *   `proceedingsTitle` on a conference paper. Checking the base id against
 *   the type said "invalid" for fields Zotero writes happily. `setField`
 *   itself resolves this with `getFieldIDFromTypeAndBase`, so the check has
 *   to as well or it disagrees with the write it is guarding.
 * - Fail-open. The `catch` returned `true`, so if `Zotero.ItemFields` were
 *   missing every field was declared valid and the error surfaced later as a
 *   raw throw from `setField`. No test defines `ItemFields`, so that branch
 *   has never run in CI.
 */
/**
 * Builds the file handle Zotero's file APIs expect.
 *
 * Zotero accepts an `nsIFile` on these paths and a plain path string on some
 * of them; constructing the `nsIFile` when `Components` is available keeps
 * both happy, and falling back to the string keeps this callable from the
 * node test harness.
 */
/**
 * Zotero preferences the agent may read and write.
 *
 * An allowlist rather than open access to `Zotero.Prefs`: the pref tree
 * includes sync credentials, data directory paths and proxy settings, and an
 * agent that can rewrite those can lock a user out of their own library. Each
 * entry here changes behaviour the user might reasonably ask about.
 */
const AGENT_WRITABLE_PREFS: Record<
  string,
  { type: "boolean" | "number" | "string"; description: string }
> = {
  recursiveCollections: {
    type: "boolean",
    description: "Show items from subcollections in a collection",
  },
  sortNotesChronologically: {
    type: "boolean",
    description: "Sort child notes by date rather than title",
  },
  showTrashWhenEmpty: {
    type: "boolean",
    description: "Keep the Trash row visible when it is empty",
  },
  automaticSnapshots: {
    type: "boolean",
    description: "Save a snapshot when creating an item from a web page",
  },
  automaticTags: {
    type: "boolean",
    description: "Add keywords and subject headings as automatic tags",
  },
  trashAutoEmptyDays: {
    type: "number",
    description: "Days before trashed items are erased automatically",
  },
  "export.quickCopy.setting": {
    type: "string",
    description: "The Quick Copy citation style or export format",
  },
  "export.quickCopy.locale": {
    type: "string",
    description: "Locale used for Quick Copy citations",
  },
  attachmentRenameTemplate: {
    type: "string",
    description: "Filename template used when renaming attachments",
  },
  autoRenameFiles: {
    type: "boolean",
    description: "Rename attachment files from their parent's metadata",
  },
  "annotations.noteTemplates.title": {
    type: "string",
    description: "Template for the title of a note built from annotations",
  },
  "annotations.noteTemplates.note": {
    type: "string",
    description: "Template for each annotation in such a note",
  },
  fontSize: { type: "number", description: "Interface font size" },
  "note.fontSize": { type: "number", description: "Note editor font size" },
  layout: {
    type: "string",
    description: "Item pane layout ('standard' or 'stacked')",
  },
};

function toLocalFileHandle(filePath: string): unknown {
  try {
    const components = (
      globalThis as unknown as {
        Components?: {
          classes: Record<
            string,
            { createInstance: (iid: unknown) => unknown }
          >;
          interfaces: Record<string, unknown>;
        };
      }
    ).Components;
    if (components?.classes?.["@mozilla.org/file/local;1"]) {
      const file = components.classes[
        "@mozilla.org/file/local;1"
      ].createInstance(components.interfaces.nsIFile) as {
        initWithPath: (path: string) => void;
      };
      file.initWithPath(filePath);
      return file;
    }
  } catch {
    // Fall through to the path string.
  }
  return filePath;
}

function isFieldValidForItemType(
  item: Zotero.Item,
  fieldName: string,
): boolean {
  if (NON_EDITABLE_METADATA_FIELDS.has(fieldName)) return false;
  const itemFields = (
    Zotero as unknown as {
      ItemFields?: {
        getID?: (name: string) => number | false;
        isValidForType?: (fieldId: number, itemTypeId: number) => boolean;
        getFieldIDFromTypeAndBase?: (
          itemTypeId: number,
          baseFieldId: number,
        ) => number | false;
      };
    }
  ).ItemFields;
  // Fail closed: without the schema there is no way to tell a valid field
  // from a typo, and guessing "valid" turns a typo into a thrown write.
  if (!itemFields?.getID || typeof itemFields.isValidForType !== "function") {
    return false;
  }
  try {
    const baseFieldId = itemFields.getID(fieldName);
    if (!baseFieldId) return false;
    const itemTypeID = item.itemTypeID;
    // Mirrors setField: prefer the type-specific field, fall back to the base.
    const fieldId =
      itemFields.getFieldIDFromTypeAndBase?.(itemTypeID, baseFieldId) ||
      baseFieldId;
    return Boolean(itemFields.isValidForType(fieldId, itemTypeID));
  } catch {
    return false;
  }
}

/**
 * Every field this item type accepts, for telling the model what it may set.
 */
export function listEditableFieldsForItem(item: Zotero.Item): string[] {
  const itemFields = (
    Zotero as unknown as {
      ItemFields?: {
        getItemTypeFields?: (itemTypeId: number) => number[];
        getName?: (fieldId: number) => string;
      };
    }
  ).ItemFields;
  if (!itemFields?.getItemTypeFields || !itemFields.getName) return [];
  try {
    return itemFields
      .getItemTypeFields(item.itemTypeID)
      .map((fieldId) => itemFields.getName?.(fieldId) || "")
      .filter((name) => name && !NON_EDITABLE_METADATA_FIELDS.has(name));
  } catch {
    return [];
  }
}

function normalizeCreatorForSnapshot(
  creator: _ZoteroTypes.Item.CreatorJSON | _ZoteroTypes.Item.Creator,
): EditableArticleCreator | null {
  const creatorType =
    typeof (creator as { creatorType?: unknown }).creatorType === "string" &&
    (creator as { creatorType?: string }).creatorType?.trim()
      ? (creator as { creatorType: string }).creatorType.trim()
      : "author";
  const name =
    typeof (creator as { name?: unknown }).name === "string" &&
    (creator as { name?: string }).name?.trim()
      ? (creator as { name: string }).name.trim()
      : undefined;
  const firstName =
    typeof (creator as { firstName?: unknown }).firstName === "string" &&
    (creator as { firstName?: string }).firstName?.trim()
      ? (creator as { firstName: string }).firstName.trim()
      : undefined;
  const lastName =
    typeof (creator as { lastName?: unknown }).lastName === "string" &&
    (creator as { lastName?: string }).lastName?.trim()
      ? (creator as { lastName: string }).lastName.trim()
      : undefined;
  const fieldMode =
    Number((creator as { fieldMode?: unknown }).fieldMode) === 1 || name
      ? 1
      : 0;
  if (!name && !firstName && !lastName) return null;
  return {
    creatorType,
    name,
    firstName,
    lastName,
    fieldMode,
  };
}

function isPaperContentSourceMode(
  value: unknown,
): value is PaperContentSourceMode {
  return (
    value === "text" ||
    value === "mineru" ||
    value === "pdf" ||
    value === "markdown" ||
    value === "html" ||
    value === "txt" ||
    value === "docx"
  );
}

function normalizePaperContexts(
  entries: PaperContextRef[] | undefined,
): PaperContextRef[] {
  if (!Array.isArray(entries)) return [];
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry) continue;
    const libraryID = Number(entry.libraryID);
    const itemId = Number(entry.itemId);
    const contextItemId = Number(entry.contextItemId);
    if (!Number.isFinite(itemId) || !Number.isFinite(contextItemId)) continue;
    const normalized: PaperContextRef = {
      ...(Number.isFinite(libraryID) && libraryID > 0
        ? { libraryID: Math.floor(libraryID) }
        : {}),
      itemId: Math.floor(itemId),
      contextItemId: Math.floor(contextItemId),
      title: `${entry.title || `Paper ${Math.floor(itemId)}`}`.trim(),
      attachmentTitle: entry.attachmentTitle?.trim() || undefined,
      citationKey: entry.citationKey?.trim() || undefined,
      firstCreator: entry.firstCreator?.trim() || undefined,
      year: entry.year?.trim() || undefined,
    };
    if (isPaperContentSourceMode(entry.contentSourceMode)) {
      normalized.contentSourceMode = entry.contentSourceMode;
    }
    if (entry.mineruCacheDir?.trim()) {
      normalized.mineruCacheDir = entry.mineruCacheDir.trim();
    }
    const key = `${normalized.libraryID || 0}:${normalized.itemId}:${normalized.contextItemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function getCollectionIDs(item: Zotero.Item | null | undefined): number[] {
  if (!item) return [];
  try {
    return item
      .getCollections()
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
      .map((id) => Math.floor(id));
  } catch (_error) {
    void _error;
    return [];
  }
}

function resolveLibraryDisplayName(libraryID: number): string {
  try {
    const libraries = (
      Zotero as unknown as {
        Libraries?: {
          getName?: (targetLibraryID: number) => unknown;
          get?: (
            targetLibraryID: number,
          ) => { name?: unknown } | null | undefined;
        };
      }
    ).Libraries;
    const directName = normalizeText(libraries?.getName?.(libraryID));
    if (directName) return directName;
    const library = libraries?.get?.(libraryID);
    const objectName = normalizeText(library?.name);
    if (objectName) return objectName;
  } catch (_error) {
    void _error;
  }
  return "My Library";
}

function getPdfChildAttachments(item: Zotero.Item): Zotero.Item[] {
  const out: Zotero.Item[] = [];
  if (!item?.isRegularItem?.()) return out;
  for (const attachmentId of item.getAttachments()) {
    const attachment = Zotero.Items.get(attachmentId) || null;
    const filename = normalizeText(
      (attachment as (Zotero.Item & { attachmentFilename?: string }) | null)
        ?.attachmentFilename,
    );
    if (
      attachment &&
      attachment.isAttachment?.() &&
      (normalizeText(attachment.attachmentContentType).toLowerCase() ===
        "application/pdf" ||
        filename.toLowerCase().endsWith(".pdf"))
    ) {
      out.push(attachment);
    }
  }
  return out;
}

function getAllChildAttachments(item: Zotero.Item): Zotero.Item[] {
  const out: Zotero.Item[] = [];
  if (!item?.isRegularItem?.()) return out;
  for (const attachmentId of item.getAttachments()) {
    const att = Zotero.Items.get(attachmentId) || null;
    if (att && att.isAttachment?.()) out.push(att);
  }
  return out;
}

function resolveAttachmentTitle(
  attachment: Zotero.Item,
  index: number,
  total: number,
): string {
  const title = normalizeText(attachment.getField?.("title"));
  if (title) return title;
  const filename = normalizeText(
    (attachment as unknown as { attachmentFilename?: string })
      .attachmentFilename,
  );
  if (filename) return filename;
  return total > 1 ? `PDF ${index + 1}` : "PDF";
}

function resolveAnyAttachmentTitle(
  attachment: Zotero.Item,
  index: number,
  total: number,
): string {
  const title = normalizeText(attachment.getField?.("title"));
  if (title) return title;
  const filename = normalizeText(
    (attachment as unknown as { attachmentFilename?: string })
      .attachmentFilename,
  );
  if (filename) return filename;
  const contentType = normalizeText(attachment.attachmentContentType);
  if (contentType) {
    const ext = contentType.split("/").pop() || contentType;
    return total > 1 ? `${ext.toUpperCase()} ${index + 1}` : ext.toUpperCase();
  }
  return total > 1 ? `Attachment ${index + 1}` : "Attachment";
}

function getItemTags(
  item: Zotero.Item | null | undefined,
  options: { includeAutomatic?: boolean } = {},
): string[] {
  if (!item) return [];
  const includeAutomatic = options.includeAutomatic !== false;
  try {
    const out = (item.getTags?.() || [])
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object") {
          const typed = entry as {
            tag?: unknown;
            name?: unknown;
            type?: unknown;
          };
          if (typed.type === 1 && !includeAutomatic) return "";
          return typeof typed.tag === "string"
            ? typed.tag
            : typeof typed.name === "string"
              ? typed.name
              : "";
        }
        return "";
      })
      .map((entry) => normalizeText(entry))
      .filter(Boolean);
    return Array.from(new Set(out)).sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: "base" }),
    );
  } catch (_error) {
    void _error;
    return [];
  }
}

function buildPaperTargetFromItem(
  item: Zotero.Item,
): LibraryPaperTarget | null {
  const target = resolveRegularItem(item);
  if (!target) return null;
  const attachments = getPdfChildAttachments(target).map(
    (attachment, index, list) => ({
      contextItemId: attachment.id,
      title: resolveAttachmentTitle(attachment, index, list.length),
    }),
  );
  if (!attachments.length) return null;
  return {
    itemId: target.id,
    libraryID: Number(target.libraryID) || undefined,
    title:
      normalizeText(target.getField?.("title")) ||
      normalizeText(target.getDisplayTitle?.()) ||
      `Item ${target.id}`,
    firstCreator:
      normalizeText(target.firstCreator) ||
      normalizeText(target.getField?.("firstCreator")) ||
      undefined,
    year:
      normalizeText(target.getField?.("date")).match(/\b(19|20)\d{2}\b/)?.[0] ||
      undefined,
    dateAdded: normalizeText(target.getField?.("dateAdded")) || undefined,
    attachments,
    tags: getItemTags(target),
    collectionIds: getCollectionIDs(target),
  };
}

function buildItemTargetFromItem(item: Zotero.Item): LibraryItemTarget | null {
  // Standalone attachment/file (no parent item)
  if (item.isAttachment?.() && !item.parentID) {
    const title = resolveAnyAttachmentTitle(item, 0, 1);
    return {
      itemId: item.id,
      libraryID: Number(item.libraryID) || undefined,
      itemType: "attachment",
      title,
      dateAdded: normalizeText(item.getField?.("dateAdded")) || undefined,
      attachments: [
        {
          contextItemId: item.id,
          title,
          contentType:
            normalizeText(item.attachmentContentType) ||
            "application/octet-stream",
        },
      ],
      tags: getItemTags(item),
      collectionIds: getCollectionIDs(item),
    };
  }
  // Standalone note (no parent)
  if ((item as any).isNote?.() && !item.parentID) {
    const rawTitle = normalizeText(
      (item as any).getNoteTitle?.() || item.getDisplayTitle?.() || "",
    );
    return {
      itemId: item.id,
      libraryID: Number(item.libraryID) || undefined,
      itemType: "note",
      title: rawTitle || `Note ${item.id}`,
      dateAdded: normalizeText(item.getField?.("dateAdded")) || undefined,
      attachments: [],
      tags: getItemTags(item),
      collectionIds: getCollectionIDs(item),
      noteKind: "standalone",
    };
  }
  // Regular item (with or without PDF)
  const target = resolveRegularItem(item);
  if (!target) return null;
  const allAtts = getAllChildAttachments(target);
  return {
    itemId: target.id,
    libraryID: Number(target.libraryID) || undefined,
    itemType: getItemTypeName(target),
    title:
      normalizeText(target.getField?.("title")) ||
      normalizeText(target.getDisplayTitle?.()) ||
      `Item ${target.id}`,
    firstCreator:
      normalizeText(target.firstCreator) ||
      normalizeText(target.getField?.("firstCreator")) ||
      undefined,
    year:
      normalizeText(target.getField?.("date")).match(/\b(19|20)\d{2}\b/)?.[0] ||
      undefined,
    dateAdded: normalizeText(target.getField?.("dateAdded")) || undefined,
    attachments: allAtts.map((att, index, list) => ({
      contextItemId: att.id,
      title: resolveAnyAttachmentTitle(att, index, list.length),
      contentType:
        normalizeText(att.attachmentContentType) || "application/octet-stream",
    })),
    tags: getItemTags(target),
    collectionIds: getCollectionIDs(target),
  };
}

function indexItemMatchesType(
  item: LibraryIndexItem,
  requestedType?: string,
): boolean {
  const normalized = requestedType?.trim().toLowerCase();
  return !normalized || item.itemType.toLowerCase() === normalized;
}

function indexItemHasGatewayPdf(
  snapshot: LibraryIndexSnapshot,
  itemId: number,
): boolean {
  return (snapshot.childAttachmentIdsByItemId.get(itemId) || []).some(
    (attachmentId) => snapshot.attachmentById.get(attachmentId)?.isPdf,
  );
}

function indexItemMatchesAggregateTagScope(
  item: LibraryIndexItem,
  scope: "allTagged" | "untagged",
  includeAutomatic: boolean,
): boolean {
  const tagged =
    item.tags.length > 0 || (includeAutomatic && item.automaticTags.length > 0);
  return scope === "allTagged" ? tagged : !tagged;
}

function orderedIndexIds(
  snapshot: LibraryIndexSnapshot,
  predicate: (item: LibraryIndexItem) => boolean,
): number[] {
  return snapshot.topLevelItemOrder.filter((itemId) => {
    const item = snapshot.itemById.get(itemId);
    return Boolean(item && !item.deleted && predicate(item));
  });
}

function orderedGatewayPaperIds(snapshot: LibraryIndexSnapshot): number[] {
  return orderedIndexIds(
    snapshot,
    (item) =>
      item.kind === "regular" && indexItemHasGatewayPdf(snapshot, item.itemId),
  ).sort((leftId, rightId) => {
    const left = snapshot.itemById.get(leftId)!;
    const right = snapshot.itemById.get(rightId)!;
    const modifiedDelta = right.modifiedAt - left.modifiedAt;
    if (modifiedDelta !== 0) return modifiedDelta;
    return left.title.localeCompare(right.title, undefined, {
      sensitivity: "base",
    });
  });
}

function pageIds(ids: number[], limit: unknown): number[] {
  const normalized = normalizeResultLimit(limit);
  return normalized ? ids.slice(0, normalized) : ids;
}

function sortAndPageIndexIds(
  snapshot: LibraryIndexSnapshot,
  ids: number[],
  options: {
    sort?: "dateAdded" | "title";
    order?: "asc" | "desc";
    offset?: number;
    limit?: number;
  },
): number[] {
  const sorted =
    options.sort === "dateAdded" || options.sort === "title"
      ? [...ids].sort((leftId, rightId) => {
          const left = snapshot.itemById.get(leftId);
          const right = snapshot.itemById.get(rightId);
          const leftValue =
            options.sort === "title"
              ? left?.title || ""
              : left?.dateAdded || "";
          const rightValue =
            options.sort === "title"
              ? right?.title || ""
              : right?.dateAdded || "";
          if (!leftValue && !rightValue) return 0;
          if (!leftValue) return 1;
          if (!rightValue) return -1;
          const compared =
            options.sort === "title"
              ? leftValue.localeCompare(rightValue)
              : leftValue < rightValue
                ? -1
                : leftValue > rightValue
                  ? 1
                  : 0;
          const descending =
            options.sort === "title"
              ? options.order === "desc"
              : options.order !== "asc";
          return descending ? -compared : compared;
        })
      : ids;
  const offset =
    Number.isFinite(options.offset) && Number(options.offset) > 0
      ? Math.floor(Number(options.offset))
      : 0;
  return pageIds(offset ? sorted.slice(offset) : sorted, options.limit);
}

function buildPaperTargetsForIds(
  gateway: ZoteroGateway,
  ids: number[],
): LibraryPaperTarget[] {
  const results: LibraryPaperTarget[] = [];
  for (const id of ids) {
    const item = gateway.resolveBibliographicItem(gateway.getItem(id));
    if (!item) continue;
    const target = buildPaperTargetFromItem(item);
    if (target) results.push(target);
  }
  return results;
}

function buildItemTargetsForIds(
  gateway: ZoteroGateway,
  ids: number[],
): LibraryItemTarget[] {
  const results: LibraryItemTarget[] = [];
  for (const id of ids) {
    const item = gateway.getItem(id);
    if (!item) continue;
    const target = buildItemTargetFromItem(item);
    if (target) results.push(target);
  }
  return results;
}

function listLibraryCollections(libraryID: number): Zotero.Collection[] {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return [];
  try {
    return Zotero.Collections.getByLibrary(Math.floor(libraryID), true) || [];
  } catch (_error) {
    void _error;
    return [];
  }
}

function buildCollectionPathMap(
  collections: Zotero.Collection[],
): Map<number, string> {
  const byId = new Map<number, Zotero.Collection>();
  const pathById = new Map<number, string>();
  for (const collection of collections) {
    byId.set(collection.id, collection);
  }
  const resolvePath = (collectionId: number): string => {
    const cached = pathById.get(collectionId);
    if (cached) return cached;
    const collection = byId.get(collectionId);
    if (!collection) return "";
    const name =
      normalizeText(collection.name) || `Collection ${collection.id}`;
    const parentId = Number(collection.parentID);
    if (!Number.isFinite(parentId) || parentId <= 0 || !byId.has(parentId)) {
      pathById.set(collectionId, name);
      return name;
    }
    const path = `${resolvePath(Math.floor(parentId))} / ${name}`;
    pathById.set(collectionId, path);
    return path;
  };
  for (const collection of collections) {
    resolvePath(collection.id);
  }
  return pathById;
}

function normalizeResultLimit(limit: unknown): number | undefined {
  return Number.isFinite(limit) && Number(limit) > 0
    ? Math.max(1, Math.floor(Number(limit)))
    : undefined;
}

function libraryItemTargetHasPdf(target: LibraryItemTarget): boolean {
  return target.attachments.some((attachment) => {
    const contentType = normalizeText(attachment.contentType).toLowerCase();
    const title = normalizeText(attachment.title).toLowerCase();
    return (
      contentType === "application/pdf" ||
      title.endsWith(".pdf") ||
      title === "pdf"
    );
  });
}

function libraryItemTargetMatchesFilters(
  target: LibraryItemTarget,
  filters?: { hasPdf?: boolean },
): boolean {
  if (filters?.hasPdf === undefined) return true;
  return libraryItemTargetHasPdf(target) === filters.hasPdf;
}

// ── Zotero.Search-backed listing helpers ──────────────────────────────────────

export type AgentLibraryFilters = {
  collectionId?: number;
  unfiled?: boolean;
  hasPdf?: boolean;
  itemType?: string;
  author?: string;
  yearFrom?: number;
  yearTo?: number;
  tag?: string;
  /** List the trash instead of the library. */
  deleted?: boolean;
};

/**
 * One clause of an advanced search, forwarded to `Zotero.Search`.
 *
 * The agent previously had nine hand-written filters against Zotero's own
 * ~130 conditions x 15 operators. Re-implementing that vocabulary a filter at
 * a time is how it stayed nine for so long, so this forwards the vocabulary
 * instead of mirroring it: new Zotero versions add conditions for free.
 */
export type AgentSearchCondition = {
  condition: string;
  operator: string;
  value?: string | number;
  /**
   * Sub-mode for the few conditions that take one, e.g. `fulltextContent`
   * with `phrase` or `regexp`. Zotero spells this `condition/mode`.
   */
  mode?: string;
  /** Zotero's per-condition `required` flag. */
  required?: boolean;
};

export type AgentSearchConditionError = {
  condition: string;
  reason: string;
  validOperators?: string[];
};

/**
 * Checks conditions before any of them reach `Zotero.Search`.
 *
 * `addCondition` throws for both an unknown condition and an unsupported
 * operator, and a throw mid-build leaves a half-populated search. Worse, the
 * callers used to swallow it into an empty result, which is how a year filter
 * silently reported "no matching library results" on every library. Validate
 * first, and tell the model which operators the condition actually takes --
 * an error it cannot act on is as useless as an empty result.
 */
export function validateSearchConditions(
  conditions: AgentSearchCondition[],
): AgentSearchConditionError[] {
  const registry = (
    Zotero as unknown as {
      SearchConditions?: {
        get?: (
          name: string,
        ) => { operators?: Record<string, boolean> } | undefined;
      };
    }
  ).SearchConditions;
  if (!registry?.get) return [];
  const errors: AgentSearchConditionError[] = [];
  for (const entry of conditions) {
    const name = String(entry?.condition || "").trim();
    if (!name) {
      errors.push({ condition: "", reason: "A condition name is required" });
      continue;
    }
    // A block flips joinMode for the WHOLE query: any block sets
    // hasQuicksearch, and joinModeAny is `_joinMode == 'any' || hasQuicksearch`.
    // Exposing them would let one clause silently turn an AND search into OR.
    if (name === "blockStart" || name === "blockEnd") {
      errors.push({
        condition: name,
        reason:
          "Grouping blocks are not available: opening one flips every other condition in the query from AND to OR. Use joinMode instead, or run separate searches.",
      });
      continue;
    }
    const declared = registry.get(name);
    if (!declared) {
      errors.push({
        condition: name,
        reason: `"${name}" is not a Zotero search condition`,
      });
      continue;
    }
    const operator = String(entry?.operator || "").trim();
    const validOperators = Object.keys(declared.operators || {});
    if (!operator || !declared.operators?.[operator]) {
      errors.push({
        condition: name,
        reason: `"${operator || "(missing)"}" is not a valid operator for "${name}"`,
        validOperators,
      });
    }
  }
  return errors;
}

/**
 * Applies the exact year range in JS.
 *
 * The SQL side can only narrow: Zotero compares dates as strings, and an
 * `isAfter` on a bare year matches everything later in *that same* year. So
 * the range is enforced here, on the parsed year, exactly as the in-memory
 * fallback path already did. Items with no parseable year are excluded, which
 * is what a year-bounded question means.
 */
function libraryItemTargetMatchesYear(
  target: LibraryItemTarget,
  filters?: { yearFrom?: number; yearTo?: number },
): boolean {
  if (filters?.yearFrom == null && filters?.yearTo == null) return true;
  const year = parseInt(String(target.year ?? ""), 10);
  if (Number.isNaN(year)) return false;
  if (filters.yearFrom != null && year < filters.yearFrom) return false;
  if (filters.yearTo != null && year > filters.yearTo) return false;
  return true;
}

/**
 * Builds the `Zotero.Search` behind the agent's structured filters.
 *
 * Two conditions here were wrong in ways that silently produced empty or
 * over-broad results:
 *
 * 1. `year` was given `isGreaterThan`/`isLessThan`, which it does not accept
 *    (`searchConditions.js` allows only is/isNot/contains/doesNotContain).
 *    `addCondition` *throws* on an unsupported operator, and both callers
 *    swallowed the throw — so every text search combined with a year filter
 *    reported "no matching library results", always. The list path happened
 *    to fall back to an in-memory filter, which is why this went unnoticed.
 *    Year is now narrowed with `date`, which does support ranges, and made
 *    exact by `libraryItemTargetMatchesYear`.
 *
 * 2. The author filter was an OR block. Any block sets `hasQuicksearch`, and
 *    `joinModeAny` is `_joinMode == 'any' || hasQuicksearch` — so opening a
 *    block flipped *every other condition* in the query from AND to OR. A
 *    search for "papers by Peyrache in collection X" returned everything by
 *    Peyrache plus everything in X. `creator` matches all creator roles in
 *    one condition, so no block is needed.
 */
function buildAgentLibrarySearch(
  libraryID: number,
  filters: AgentLibraryFilters,
): Zotero.Search {
  const search = new Zotero.Search({ libraryID });
  if (filters.collectionId) {
    search.addCondition("collectionID", "is", filters.collectionId);
  }
  if (filters.unfiled) {
    search.addCondition("unfiled", "true", "");
  }
  if (filters.itemType) {
    search.addCondition("itemType", "is", filters.itemType);
  }
  if (filters.author) {
    // `creator` spans author, editor, bookAuthor and the rest.
    search.addCondition("creator", "contains", filters.author);
  }
  if (filters.yearFrom != null) {
    // `> 'YYYY-00-00'`, so this may admit part of the preceding year; the
    // exact bound is applied afterwards.
    search.addCondition("date", "isAfter", String(filters.yearFrom - 1));
  }
  if (filters.yearTo != null) {
    // `< 'YYYY-00-00'` for the following year, which is an exact upper bound.
    search.addCondition("date", "isBefore", String(filters.yearTo + 1));
  }
  if (filters.tag) {
    search.addCondition("tag", "is", filters.tag);
  }
  if (filters.deleted) {
    // Zotero excludes trashed items from every search unless asked, so
    // without this the trash could not be enumerated -- and restoring
    // something the user deleted meant knowing its id already.
    search.addCondition("deleted", "true" as never, "");
  }
  return search;
}

const FULLTEXT_INDEX_STATE_MAP: Record<
  number,
  LibraryItemTargetAttachment["indexingState"]
> = {
  0: "unavailable",
  1: "unindexed",
  2: "partial",
  3: "indexed",
  4: "queued",
};

export class ZoteroGateway {
  getItem(itemId: number | undefined): Zotero.Item | null {
    if (!Number.isFinite(itemId) || !itemId || itemId <= 0) return null;
    return Zotero.Items.get(Math.floor(itemId)) || null;
  }

  getCollection(collectionId: number | undefined): Zotero.Collection | null {
    if (!Number.isFinite(collectionId) || !collectionId || collectionId <= 0) {
      return null;
    }
    return Zotero.Collections.get(Math.floor(collectionId)) || null;
  }

  resolveLibraryID(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    libraryID?: number;
  }): number {
    const explicitLibraryID = Number(params.libraryID);
    if (Number.isFinite(explicitLibraryID) && explicitLibraryID > 0) {
      return Math.floor(explicitLibraryID);
    }
    const itemLibraryID = Number(params.item?.libraryID);
    if (Number.isFinite(itemLibraryID) && itemLibraryID > 0) {
      return Math.floor(itemLibraryID);
    }
    const requestLibraryID = Number(params.request?.libraryID);
    if (Number.isFinite(requestLibraryID) && requestLibraryID > 0) {
      return Math.floor(requestLibraryID);
    }
    const activeItemLibraryID = Number(
      this.getItem(params.request?.activeItemId)?.libraryID,
    );
    if (Number.isFinite(activeItemLibraryID) && activeItemLibraryID > 0) {
      return Math.floor(activeItemLibraryID);
    }
    return 0;
  }

  invalidateLibrarySearchCache(libraryID?: number): void {
    libraryIndexService.invalidate(libraryID);
  }

  getCollectionSummary(
    collectionId: number | undefined,
  ): CollectionSummary | null {
    const collection = this.getCollection(collectionId);
    if (!collection) return null;
    const libraryID = Number(collection.libraryID) || 0;
    const snapshot = libraryIndexService.peekSnapshot(libraryID);
    const indexed = snapshot?.collectionById.get(collection.id);
    if (indexed) {
      return {
        collectionId: indexed.collectionId,
        name: indexed.name,
        libraryID: indexed.libraryID,
        path:
          snapshot?.collectionPathById.get(indexed.collectionId) ||
          indexed.name,
      };
    }
    const pathMap = buildCollectionPathMap(listLibraryCollections(libraryID));
    return {
      collectionId: collection.id,
      name: normalizeText(collection.name) || `Collection ${collection.id}`,
      libraryID,
      path:
        pathMap.get(collection.id) ||
        normalizeText(collection.name) ||
        `Collection ${collection.id}`,
    };
  }

  /** Uncached native state used to verify collection mutation receipts. */
  getCollectionNativeState(collectionId: number): {
    exists: boolean;
    name: string;
    parentCollectionId: number | null;
    deleted: boolean;
  } {
    const collection = this.getCollection(collectionId);
    return collection
      ? {
          exists: true,
          name: normalizeText(collection.name),
          parentCollectionId:
            Number(collection.parentID) > 0
              ? Number(collection.parentID)
              : null,
          deleted: Boolean(
            (collection as Zotero.Collection & { deleted?: boolean }).deleted,
          ),
        }
      : {
          exists: false,
          name: "",
          parentCollectionId: null,
          deleted: false,
        };
  }

  listCollectionSummaries(libraryID: number): CollectionSummary[] {
    const normalizedLibraryID = Number.isFinite(libraryID)
      ? Math.floor(libraryID)
      : 0;
    if (!normalizedLibraryID) return [];
    const snapshot = libraryIndexService.peekSnapshot(normalizedLibraryID);
    if (snapshot) {
      return [...snapshot.collectionById.values()]
        .filter((collection) => !collection.deleted)
        .map((collection) => ({
          collectionId: collection.collectionId,
          name: collection.name,
          libraryID: collection.libraryID,
          path:
            snapshot.collectionPathById.get(collection.collectionId) ||
            collection.name,
        }))
        .sort((left, right) =>
          (left.path || left.name).localeCompare(
            right.path || right.name,
            undefined,
            { sensitivity: "base" },
          ),
        );
    }
    return this.listCurrentCollectionSummaries(normalizedLibraryID);
  }

  listCurrentCollectionSummaries(libraryID: number): CollectionSummary[] {
    const normalizedLibraryID = Number.isFinite(libraryID)
      ? Math.floor(libraryID)
      : 0;
    if (!normalizedLibraryID) return [];
    const collections = listLibraryCollections(normalizedLibraryID);
    const pathMap = buildCollectionPathMap(collections);
    return collections
      .map((collection) => ({
        collectionId: collection.id,
        name: normalizeText(collection.name) || `Collection ${collection.id}`,
        libraryID: Number(collection.libraryID) || normalizedLibraryID,
        path:
          pathMap.get(collection.id) ||
          normalizeText(collection.name) ||
          `Collection ${collection.id}`,
      }))
      .sort((left, right) =>
        (left.path || left.name).localeCompare(
          right.path || right.name,
          undefined,
          {
            sensitivity: "base",
          },
        ),
      );
  }

  listCurrentCollectionTargetIds(params: {
    libraryID: number;
    collectionId: number;
    targetKind: "papers" | "items";
  }): number[] {
    const collection = this.getCollection(params.collectionId);
    if (!collection || Number(collection.libraryID) !== params.libraryID) {
      return [];
    }
    let memberIds: number[];
    try {
      memberIds = collection.getChildItems?.(true, false) || [];
    } catch (_error) {
      return [];
    }
    const directIds = [
      ...new Set(
        memberIds
          .map(Number)
          .filter((itemId) => Number.isInteger(itemId) && itemId > 0),
      ),
    ];
    if (params.targetKind === "items") return directIds;
    return directIds.filter(
      (itemId) => this.getItem(itemId)?.isRegularItem?.() === true,
    );
  }

  async listCurrentLibraryTargetIds(params: {
    libraryID: number;
    targetKind: "papers" | "items";
  }): Promise<number[]> {
    const items: Zotero.Item[] = await Zotero.Items.getAll(
      params.libraryID,
      true,
      false,
      false,
    );
    return items
      .filter((item) => {
        if (params.targetKind === "papers") return item.isRegularItem?.();
        return Boolean(
          item.isRegularItem?.() || item.isNote?.() || item.isAttachment?.(),
        );
      })
      .map((item) => item.id)
      .filter((itemId) => Number.isInteger(itemId) && itemId > 0);
  }

  async getAllChildAttachmentInfos(
    itemId: number,
  ): Promise<LibraryItemTargetAttachment[]> {
    const item = this.getItem(itemId);
    if (!item) return [];
    const allAtts = getAllChildAttachments(
      item.isRegularItem?.()
        ? item
        : this.resolveBibliographicItem(item) || item,
    );
    const results: LibraryItemTargetAttachment[] = [];
    for (let i = 0; i < allAtts.length; i++) {
      const att = allAtts[i];
      const contentType =
        normalizeText(att.attachmentContentType) || "application/octet-stream";
      let indexingState: LibraryItemTargetAttachment["indexingState"];
      let mineruCacheDir: string | undefined;
      if (contentType === "application/pdf") {
        try {
          const stateNum = await Zotero.Fulltext.getIndexedState(att);
          indexingState = FULLTEXT_INDEX_STATE_MAP[stateNum] ?? "unavailable";
        } catch (err) {
          ztoolkit.log("LLM: Fulltext index state check failed", err);
          indexingState = "unavailable";
        }
        // Check if MinerU has parsed this PDF
        try {
          mineruCacheDir = await ensureMineruCacheDirForAttachment(att);
        } catch (err) {
          ztoolkit.log("LLM: MinerU cache check failed", err);
        }
      }
      results.push({
        contextItemId: att.id,
        title: resolveAnyAttachmentTitle(att, i, allAtts.length),
        contentType,
        indexingState,
        mineruCacheDir,
      });
    }
    return results;
  }

  async listLibraryPaperTargets(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    papers: LibraryPaperTarget[];
    totalCount: number;
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) {
      throw new Error("No active library available for listing papers");
    }
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const ids = orderedGatewayPaperIds(snapshot);
    return {
      // Page IDs first. Only the returned page is enriched from live Zotero
      // objects; broad warm listing stays proportional to the page size.
      papers: buildPaperTargetsForIds(this, pageIds(ids, params.limit)),
      totalCount: ids.length,
    };
  }

  getPaperTargetsByItemIds(itemIds: number[]): LibraryPaperTarget[] {
    const out: LibraryPaperTarget[] = [];
    const seen = new Set<number>();
    for (const rawItemId of itemIds) {
      const item = this.resolveBibliographicItem(this.getItem(rawItemId));
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      const target = buildPaperTargetFromItem(item);
      if (target) {
        out.push(target);
      }
    }
    return out;
  }

  resolvePaperContextTarget(params: {
    itemId?: number;
    contextItemId?: number;
  }): PaperContextRef | null {
    const itemId =
      Number.isFinite(params.itemId) && Number(params.itemId) > 0
        ? Math.floor(Number(params.itemId))
        : undefined;
    const contextItemId =
      Number.isFinite(params.contextItemId) && Number(params.contextItemId) > 0
        ? Math.floor(Number(params.contextItemId))
        : undefined;

    if (contextItemId) {
      const paperContext = resolvePaperContextRefFromAttachment(
        this.getItem(contextItemId),
      );
      if (!paperContext) return null;
      if (itemId && paperContext.itemId !== itemId) return null;
      return paperContext;
    }

    if (!itemId) return null;
    const item = this.resolveBibliographicItem(this.getItem(itemId));
    if (!item) return null;
    const target = buildPaperTargetFromItem(item);
    const firstAttachment = target?.attachments[0];
    if (!target || !firstAttachment) return null;
    return (
      resolvePaperContextRefFromAttachment(
        this.getItem(firstAttachment.contextItemId),
      ) || {
        itemId: target.itemId,
        contextItemId: firstAttachment.contextItemId,
        title: target.title,
        attachmentTitle: firstAttachment.title,
        firstCreator: target.firstCreator,
        year: target.year,
      }
    );
  }

  async listBibliographicItemTargets(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    items: LibraryItemTarget[];
    totalCount: number;
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) {
      throw new Error(
        "No active library available for listing bibliographic items",
      );
    }
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const ids = orderedIndexIds(snapshot, (item) => item.kind === "regular");
    return {
      items: buildItemTargetsForIds(this, pageIds(ids, params.limit)).filter(
        (target) => !target.noteKind,
      ),
      totalCount: ids.length,
    };
  }

  getBibliographicItemTargetsByItemIds(itemIds: number[]): LibraryItemTarget[] {
    const out: LibraryItemTarget[] = [];
    const seen = new Set<number>();
    for (const rawItemId of itemIds) {
      const item = this.resolveBibliographicItem(this.getItem(rawItemId));
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      const target = buildItemTargetFromItem(item);
      if (target && !target.noteKind) {
        out.push(target);
      }
    }
    return out;
  }

  resolveBibliographicItem(
    item: Zotero.Item | null | undefined,
  ): Zotero.Item | null {
    return resolveRegularItem(item);
  }

  resolveMetadataItem(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    itemId?: number;
    paperContext?: PaperContextRef | null;
  }): Zotero.Item | null {
    const byItemId = resolveRegularItem(this.getItem(params.itemId));
    if (byItemId) return byItemId;
    const byPaperContext = resolveRegularItem(
      this.getItem(params.paperContext?.itemId),
    );
    if (byPaperContext) return byPaperContext;
    const byActiveItem = resolveRegularItem(
      this.getItem(params.request?.activeItemId),
    );
    if (byActiveItem) return byActiveItem;
    return resolveRegularItem(params.item || null);
  }

  getActiveContextItem(
    item: Zotero.Item | null | undefined,
  ): Zotero.Item | null {
    if (item) {
      return resolveContextSourceItem(item).contextItem;
    }
    return getActiveContextAttachmentFromTabs();
  }

  getActivePaperContext(
    item: Zotero.Item | null | undefined,
  ): PaperContextRef | null {
    return resolvePaperContextRefFromAttachment(
      this.getActiveContextItem(item),
    );
  }

  /**
   * The note an edit applies to.
   *
   * `noteId` makes any note in the library editable. Without it only the note
   * the user happened to have open could be edited, so "fix the typo in the
   * note on paper X" was unreachable unless they opened it first -- and
   * `targetNoteId` already existed in the schema, stripped by `validate()`
   * for every mode except append.
   */
  resolveActiveNoteItem(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    noteId?: number;
  }): Zotero.Item | null {
    const explicitNoteId = Number(params.noteId || 0);
    if (Number.isFinite(explicitNoteId) && explicitNoteId > 0) {
      const explicit = this.getItem(Math.floor(explicitNoteId));
      // Deliberately no fallback: a bad id must surface as "note not found"
      // rather than silently editing whatever note happened to be open.
      return (explicit as any)?.isNote?.() ? explicit : null;
    }
    const requestNoteId = Number(
      params.request?.activeNoteContext?.noteId || 0,
    );
    if (Number.isFinite(requestNoteId) && requestNoteId > 0) {
      const noteItem = this.getItem(Math.floor(requestNoteId));
      if ((noteItem as any)?.isNote?.()) {
        return noteItem;
      }
    }
    const candidate =
      params.item ||
      params.request?.item ||
      this.getItem(params.request?.activeItemId);
    return (candidate as any)?.isNote?.() ? candidate : null;
  }

  getActiveNoteSnapshot(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    noteId?: number;
  }) {
    return readNoteSnapshot(this.resolveActiveNoteItem(params));
  }

  async replaceCurrentNote(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    noteId?: number;
    content: string;
    expectedOriginalHtml?: string;
    /** Pre-patched HTML that bypasses the text→HTML conversion.  When
     *  provided, this HTML is set directly on the note, preserving
     *  images, list numbering, and other structure that the plain-text
     *  roundtrip would destroy. */
    preRenderedHtml?: string;
  }): Promise<{
    noteId: number;
    title: string;
    previousHtml: string;
    previousText: string;
    nextText: string;
  }> {
    const noteItem = this.resolveActiveNoteItem(params);
    if (!noteItem) {
      throw new Error("No active note is available to edit");
    }
    const snapshot = readNoteSnapshot(noteItem);
    if (!snapshot) {
      throw new Error("Could not read the active note");
    }
    if (
      typeof params.expectedOriginalHtml === "string" &&
      normalizeText(snapshot.text) !==
        normalizeText(stripNoteHtml(params.expectedOriginalHtml))
    ) {
      throw new Error(
        "The active note changed before this edit was applied. Refresh and try again.",
      );
    }
    const nextText = normalizeNoteSourceText(
      typeof params.content === "string"
        ? params.content
        : String(params.content || ""),
    );
    await persistVerifiedNoteHtml(
      noteItem,
      params.preRenderedHtml || renderRawNoteHtml(nextText),
    );
    invalidateCachedContextText(snapshot.noteId);
    return {
      noteId: snapshot.noteId,
      title: snapshot.title,
      previousHtml: snapshot.html,
      previousText: snapshot.text,
      nextText,
    };
  }

  async restoreNoteHtml(params: {
    noteId: number;
    html: string;
  }): Promise<void> {
    const noteItem = this.getItem(params.noteId);
    if (!noteItem || !(noteItem as any).isNote?.()) {
      throw new Error("Note not found for undo");
    }
    await persistVerifiedNoteHtml(
      noteItem,
      typeof params.html === "string" ? params.html : "",
    );
    invalidateCachedContextText(Math.floor(params.noteId));
  }

  getEditableArticleMetadata(
    item: Zotero.Item | null | undefined,
  ): EditableArticleMetadataSnapshot | null {
    // Matches the write path: resolveRegularItem redirects a child
    // attachment to its parent, so reading back after writing on an
    // attachment returned the parent's fields and confirmed a change that
    // never happened to the object the user named.
    const resolution = resolveMatrixItem(item, Number(item?.id) || 0, "update");
    if ("refusal" in resolution) return null;
    const target = resolution.item;
    // Every field this item type actually has, not the fixed 18. The union
    // keeps the well-known names present (as empty strings) so existing card
    // layouts and callers still find them.
    const typeFields = listEditableFieldsForItem(target);
    const fieldNames = Array.from(
      new Set<string>([
        ...(EDITABLE_ARTICLE_METADATA_FIELDS as readonly string[]),
        ...typeFields,
      ]),
    );
    const fields = Object.fromEntries(
      fieldNames.map((fieldName) => {
        let value = "";
        try {
          // includeBaseMapped: `publicationTitle` is stored as `bookTitle` on
          // a book section and `proceedingsTitle` on a conference paper, so
          // without this it reads back empty on nine item types.
          value = normalizeMetadataValue(
            (
              target as unknown as {
                getField: (
                  name: string,
                  unformatted?: boolean,
                  includeBaseMapped?: boolean,
                ) => string;
              }
            ).getField(fieldName, false, true),
          );
        } catch (_error) {
          void _error;
        }
        return [fieldName, value];
      }),
    ) as Record<EditableArticleMetadataField, string>;
    let creators: EditableArticleCreator[] = [];
    try {
      creators = (target.getCreatorsJSON?.() || [])
        .map((creator) => normalizeCreatorForSnapshot(creator))
        .filter((creator): creator is EditableArticleCreator =>
          Boolean(creator),
        );
    } catch (_error) {
      void _error;
    }
    return {
      itemId: target.id,
      itemType: getItemTypeName(target),
      title:
        normalizeMetadataValue(target.getDisplayTitle?.()) ||
        fields.title ||
        `Item ${target.id}`,
      fields,
      creators,
    };
  }

  isEditableArticleMetadataFieldSupported(
    item: Zotero.Item | null | undefined,
    fieldName: EditableArticleMetadataField,
  ): boolean {
    const target = resolveRegularItem(item);
    if (!target) return false;
    return isFieldValidForItemType(target, fieldName);
  }

  supportsEditableArticleCreators(
    item: Zotero.Item | null | undefined,
  ): boolean {
    const target = resolveRegularItem(item);
    if (!target) return false;
    try {
      const creatorTypes = (
        Zotero as unknown as {
          CreatorTypes?: {
            itemTypeHasCreators?: (itemTypeId: number) => boolean;
          };
        }
      ).CreatorTypes;
      return typeof creatorTypes?.itemTypeHasCreators === "function"
        ? creatorTypes.itemTypeHasCreators(target.itemTypeID)
        : true;
    } catch (_error) {
      void _error;
      return true;
    }
  }

  listPaperContexts(request: AgentRuntimeRequest): PaperContextRef[] {
    return normalizePaperContexts([...getTurnPapers(request)]);
  }

  async browseCollections(params: { libraryID: number }): Promise<{
    libraryID: number;
    libraryName: string;
    collections: CollectionBrowseNode[];
    unfiled: {
      name: string;
      paperCount: number;
    };
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) {
      throw new Error("No active library available for browsing collections");
    }
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const paperIds = new Set(orderedGatewayPaperIds(snapshot));
    const nodes = new Map<number, CollectionBrowseNode>();
    for (const collection of snapshot.collectionById.values()) {
      if (collection.deleted) continue;
      const directIds = snapshot.directItemIdsByCollectionId.get(
        collection.collectionId,
      );
      nodes.set(collection.collectionId, {
        collectionId: collection.collectionId,
        name: collection.name,
        paperCount: directIds
          ? [...directIds].filter((itemId) => paperIds.has(itemId)).length
          : 0,
        descendantPaperCount: 0,
        childCollections: [],
      });
    }
    const countDescendants = (node: CollectionBrowseNode): number => {
      node.descendantPaperCount =
        node.paperCount +
        node.childCollections.reduce(
          (sum, child) => sum + countDescendants(child),
          0,
        );
      return node.descendantPaperCount;
    };
    for (const collection of snapshot.collectionById.values()) {
      const node = nodes.get(collection.collectionId);
      if (!node) continue;
      for (const childId of snapshot.childCollectionIdsByCollectionId.get(
        collection.collectionId,
      ) || []) {
        const child = nodes.get(childId);
        if (child) node.childCollections.push(child);
      }
    }
    const collections = [...snapshot.collectionById.values()]
      .filter(
        (collection) =>
          !collection.deleted &&
          (!collection.parentCollectionId ||
            !nodes.has(collection.parentCollectionId)),
      )
      .map((collection) => nodes.get(collection.collectionId)!)
      .filter(Boolean);
    collections.forEach(countDescendants);
    return {
      libraryID,
      libraryName: snapshot.libraryName,
      collections,
      unfiled: {
        name: "Unfiled",
        paperCount: [...snapshot.unfiledItemIds].filter((itemId) =>
          paperIds.has(itemId),
        ).length,
      },
    };
  }

  async listCollectionPaperTargets(params: {
    libraryID: number;
    collectionId: number;
    limit?: number;
  }): Promise<{
    collection: CollectionSummary;
    papers: LibraryPaperTarget[];
    totalCount: number;
  }> {
    const collection = this.getCollectionSummary(params.collectionId);
    if (!collection) {
      throw new Error("Collection not found");
    }
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) {
      throw new Error(
        "No active library available for listing collection papers",
      );
    }
    if (collection.libraryID && collection.libraryID !== libraryID) {
      throw new Error("Collection does not belong to the active library");
    }
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const memberIds =
      snapshot.directItemIdsByCollectionId.get(collection.collectionId) ||
      new Set<number>();
    const ids = orderedGatewayPaperIds(snapshot).filter((itemId) =>
      memberIds.has(itemId),
    );
    return {
      collection,
      papers: buildPaperTargetsForIds(this, pageIds(ids, params.limit)),
      totalCount: ids.length,
    };
  }

  async listUnfiledPaperTargets(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    papers: LibraryPaperTarget[];
    totalCount: number;
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) {
      throw new Error("No active library available for listing unfiled papers");
    }
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const ids = orderedGatewayPaperIds(snapshot).filter((itemId) =>
      snapshot.unfiledItemIds.has(itemId),
    );
    return {
      papers: buildPaperTargetsForIds(this, pageIds(ids, params.limit)),
      totalCount: ids.length,
    };
  }

  async listUntaggedPaperTargets(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    papers: LibraryPaperTarget[];
    totalCount: number;
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) {
      throw new Error(
        "No active library available for listing untagged papers",
      );
    }
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const ids = orderedGatewayPaperIds(snapshot).filter((itemId) =>
      snapshot.untaggedItemIds.has(itemId),
    );
    return {
      papers: buildPaperTargetsForIds(this, pageIds(ids, params.limit)),
      totalCount: ids.length,
    };
  }

  // ── Universal item listing (all item types, not PDF-only) ──────────────────

  async listLibraryItemTargets(params: {
    libraryID: number;
    limit?: number;
    itemType?: string;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID)
      throw new Error("No active library available for listing items");
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const ids = orderedIndexIds(snapshot, (item) =>
      indexItemMatchesType(item, params.itemType),
    );
    return {
      items: buildItemTargetsForIds(this, pageIds(ids, params.limit)),
      totalCount: ids.length,
    };
  }

  async listCollectionItemTargets(params: {
    libraryID: number;
    collectionId: number;
    limit?: number;
    itemType?: string;
  }): Promise<{
    collection: CollectionSummary;
    items: LibraryItemTarget[];
    totalCount: number;
  }> {
    const collection = this.getCollectionSummary(params.collectionId);
    if (!collection) throw new Error("Collection not found");
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const members =
      snapshot.directItemIdsByCollectionId.get(params.collectionId) ||
      new Set<number>();
    const ids = orderedIndexIds(
      snapshot,
      (item) =>
        members.has(item.itemId) && indexItemMatchesType(item, params.itemType),
    );
    return {
      collection,
      items: buildItemTargetsForIds(this, pageIds(ids, params.limit)),
      totalCount: ids.length,
    };
  }

  async listUnfiledItemTargets(params: {
    libraryID: number;
    limit?: number;
    itemType?: string;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const ids = orderedIndexIds(
      snapshot,
      (item) =>
        snapshot.unfiledItemIds.has(item.itemId) &&
        indexItemMatchesType(item, params.itemType),
    );
    return {
      items: buildItemTargetsForIds(this, pageIds(ids, params.limit)),
      totalCount: ids.length,
    };
  }

  async listUntaggedItemTargets(params: {
    libraryID: number;
    limit?: number;
    itemType?: string;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const ids = orderedIndexIds(
      snapshot,
      (item) =>
        snapshot.untaggedItemIds.has(item.itemId) &&
        indexItemMatchesType(item, params.itemType),
    );
    return {
      items: buildItemTargetsForIds(this, pageIds(ids, params.limit)),
      totalCount: ids.length,
    };
  }

  async listTagItemTargets(params: {
    libraryID: number;
    tagContext: TagContextRef;
    limit?: number;
    itemType?: string;
  }): Promise<{
    tagName: string;
    items: LibraryItemTarget[];
    totalCount: number;
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const tagName = normalizeText(params.tagContext.name);
    const normalizedName = normalizeText(
      params.tagContext.normalizedName || params.tagContext.name,
    )
      .toLowerCase()
      .trim();
    const includeAutomatic = params.tagContext.includeAutomatic === true;
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    let members: ReadonlySet<number>;
    if (params.tagContext.scope === "allTagged") {
      members = new Set(
        snapshot.topLevelItemOrder.filter((itemId) => {
          const item = snapshot.itemById.get(itemId);
          return Boolean(
            item &&
            indexItemMatchesAggregateTagScope(
              item,
              "allTagged",
              includeAutomatic,
            ),
          );
        }),
      );
    } else if (params.tagContext.scope === "untagged") {
      members = new Set(
        snapshot.topLevelItemOrder.filter((itemId) => {
          const item = snapshot.itemById.get(itemId);
          return Boolean(
            item &&
            indexItemMatchesAggregateTagScope(
              item,
              "untagged",
              includeAutomatic,
            ),
          );
        }),
      );
    } else {
      members = libraryIndexService.tagItemIds(
        snapshot,
        tagName || normalizedName,
        includeAutomatic,
      );
    }
    const ids = orderedIndexIds(
      snapshot,
      (item) =>
        members.has(item.itemId) && indexItemMatchesType(item, params.itemType),
    );
    return {
      tagName,
      items: buildItemTargetsForIds(this, pageIds(ids, params.limit)),
      totalCount: ids.length,
    };
  }

  async resolveLibraryScopeItemIds(params: {
    libraryID: number;
    itemIds?: number[];
    collectionIds?: number[];
    tagContexts?: TagContextRef[];
  }): Promise<{
    itemIds: number[];
    tagItemIds: number[];
    collectionNames: string[];
    tagNames: string[];
    summedScopeCount: number;
  }> {
    const snapshot = await libraryIndexService.getSnapshot(params.libraryID);
    const union = new Set<number>();
    const tagItemIds = new Set<number>();
    let summedScopeCount = 0;
    const add = (ids: Iterable<number>): number => {
      let count = 0;
      for (const id of ids) {
        const item = snapshot.itemById.get(id);
        // Retrieval is bibliographic: standalone notes/files remain available
        // to library_search but are not paper resources.
        if (!item || item.kind !== "regular" || item.deleted) continue;
        union.add(id);
        count += 1;
      }
      return count;
    };
    add(params.itemIds || []);
    const collectionNames: string[] = [];
    for (const collectionId of params.collectionIds || []) {
      const collection = snapshot.collectionById.get(collectionId);
      if (!collection || collection.libraryID !== params.libraryID) continue;
      collectionNames.push(
        snapshot.collectionPathById.get(collectionId) || collection.name,
      );
      summedScopeCount += add(
        snapshot.directItemIdsByCollectionId.get(collectionId) || [],
      );
    }
    const tagNames: string[] = [];
    for (const tagContext of params.tagContexts || []) {
      let ids: Set<number>;
      if (tagContext.scope === "allTagged") {
        ids = new Set(
          snapshot.topLevelItemOrder.filter((itemId) => {
            const item = snapshot.itemById.get(itemId);
            return Boolean(
              item &&
              indexItemMatchesAggregateTagScope(
                item,
                "allTagged",
                tagContext.includeAutomatic === true,
              ),
            );
          }),
        );
      } else if (tagContext.scope === "untagged") {
        ids = new Set(
          snapshot.topLevelItemOrder.filter((itemId) => {
            const item = snapshot.itemById.get(itemId);
            return Boolean(
              item &&
              indexItemMatchesAggregateTagScope(
                item,
                "untagged",
                tagContext.includeAutomatic === true,
              ),
            );
          }),
        );
      } else {
        ids = libraryIndexService.tagItemIds(
          snapshot,
          tagContext.name || tagContext.normalizedName || "",
          tagContext.includeAutomatic === true,
        );
      }
      tagNames.push(tagContext.name);
      summedScopeCount += add(ids);
      for (const id of ids) {
        if (snapshot.itemById.get(id)?.kind === "regular") tagItemIds.add(id);
      }
    }
    return {
      itemIds: [...union],
      tagItemIds: [...tagItemIds].filter((id) => union.has(id)),
      collectionNames,
      tagNames,
      summedScopeCount,
    };
  }

  /**
   * Runs an advanced search expressed in Zotero's own condition vocabulary.
   *
   * The nine hand-written filters could express a fraction of what the
   * Advanced Search window can. Rather than growing them one at a time, this
   * forwards conditions straight to `Zotero.Search`, so the agent inherits
   * every condition Zotero has — including ones added in future versions.
   *
   * Three things this must get right:
   *
   * - **Page before enriching.** The existing paths enrich every match and
   *   then slice, so a condition matching 20k items built 20k objects to show
   *   50. Here the id array is windowed first.
   * - **Resolve to parents.** `Zotero.Search` returns child items, and
   *   list-style callers drop anything with a `parentID` — so `fulltextContent`,
   *   `annotationText` and `childNote` would match and then vanish.
   * - **Never omit the library.** A `Zotero.Search` with no `libraryID`
   *   searches *every* library, including group libraries the user did not ask
   *   about.
   */
  async searchItemsByConditions(params: {
    libraryID: number;
    conditions: AgentSearchCondition[];
    joinMode?: "all" | "any";
    resolveToParents?: boolean;
    includeTrashed?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{
    items: LibraryItemTarget[];
    totalCount: number;
    returnedCount: number;
    offset: number;
    nextOffset?: number;
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");

    const errors = validateSearchConditions(params.conditions);
    if (errors.length) {
      const detail = errors
        .map((error) =>
          error.validOperators?.length
            ? `${error.reason}. Valid operators: ${error.validOperators.join(", ")}`
            : error.reason,
        )
        .join("; ");
      throw new Error(`Invalid search conditions: ${detail}`);
    }

    const search = new Zotero.Search({ libraryID });
    if (params.joinMode === "any" || params.joinMode === "all") {
      search.addCondition("joinMode", params.joinMode as never, "");
    }
    // Zotero excludes trashed items unless told otherwise, so listing the
    // trash was impossible without this -- which in turn made restore
    // unusable, because nothing could enumerate what was in there.
    if (params.includeTrashed) {
      search.addCondition("deleted", "true" as never, "");
    }
    for (const entry of params.conditions) {
      const name = entry.mode
        ? `${entry.condition}/${entry.mode}`
        : entry.condition;
      search.addCondition(
        name as never,
        entry.operator as never,
        entry.value === undefined ? "" : (entry.value as never),
        entry.required,
      );
    }

    const rawIds: number[] = await search.search();

    const resolved: number[] = [];
    const seen = new Set<number>();
    for (const id of rawIds) {
      const item = Zotero.Items.get(id);
      if (!item) continue;
      let targetId = Number(id);
      if (params.resolveToParents) {
        const parentID = (item as { parentID?: number | false }).parentID;
        if (parentID) targetId = Number(parentID);
      } else if (
        (item as { parentID?: number | false }).parentID ||
        item.isAnnotation?.()
      ) {
        continue;
      }
      if (seen.has(targetId)) continue;
      seen.add(targetId);
      resolved.push(targetId);
    }

    const offset =
      Number.isFinite(params.offset) && Number(params.offset) > 0
        ? Math.floor(Number(params.offset))
        : 0;
    const limit = Math.min(
      Math.max(
        Number.isFinite(params.limit) && Number(params.limit) > 0
          ? Math.floor(Number(params.limit))
          : 50,
        1,
      ),
      200,
    );
    // The window is taken on ids, so enrichment only runs for what is
    // actually returned.
    const page = resolved.slice(offset, offset + limit);

    const items: LibraryItemTarget[] = [];
    for (const itemId of page) {
      const item = this.getItem(itemId);
      if (!item) continue;
      const target = buildItemTargetFromItem(item);
      if (target) items.push(target);
    }

    const nextOffset = offset + page.length;
    return {
      items,
      totalCount: resolved.length,
      returnedCount: items.length,
      offset,
      nextOffset: nextOffset < resolved.length ? nextOffset : undefined,
    };
  }

  /**
   * Lists Zotero's item types and, optionally, the fields each one accepts.
   *
   * Without this the model guesses field names, and a guess is not a soft
   * failure: `setField` throws for a field the type does not have. Creating an
   * item of any type is impossible without knowing what types exist.
   */
  listItemTypes(params?: { itemType?: string; includeFields?: boolean }): {
    itemTypes: Array<{
      itemType: string;
      localized?: string;
      fields?: string[];
      creatorTypes?: string[];
    }>;
  } {
    const itemTypes = (
      Zotero as unknown as {
        ItemTypes?: {
          getTypes?: () => Array<{ id: number; name: string }>;
          getAll?: () => Array<{ id: number; name: string }>;
          getLocalizedString?: (idOrName: number | string) => string;
        };
      }
    ).ItemTypes;
    const itemFields = (
      Zotero as unknown as {
        ItemFields?: {
          getItemTypeFields?: (itemTypeId: number) => number[];
          getName?: (fieldId: number) => string;
        };
      }
    ).ItemFields;
    const creatorTypes = (
      Zotero as unknown as {
        CreatorTypes?: {
          getTypesForItemType?: (
            itemTypeId: number,
          ) => Array<{ id: number; name: string }>;
        };
      }
    ).CreatorTypes;

    const all = itemTypes?.getTypes?.() || itemTypes?.getAll?.() || [];
    const wanted = params?.itemType
      ? all.filter((entry) => entry.name === params.itemType)
      : all;

    return {
      itemTypes: wanted.map((entry) => {
        const row: {
          itemType: string;
          localized?: string;
          fields?: string[];
          creatorTypes?: string[];
        } = { itemType: entry.name };
        try {
          const localized = itemTypes?.getLocalizedString?.(entry.id);
          if (localized) row.localized = localized;
        } catch {
          // A missing localisation must not hide the type itself.
        }
        // Fields are only included on request or for a single type: all ~35
        // types with their fields is a large payload to spend on a lookup.
        if (params?.includeFields || params?.itemType) {
          try {
            row.fields = (itemFields?.getItemTypeFields?.(entry.id) || [])
              .map((fieldId) => itemFields?.getName?.(fieldId) || "")
              .filter(
                (name) => name && !NON_EDITABLE_METADATA_FIELDS.has(name),
              );
          } catch {
            row.fields = [];
          }
          try {
            row.creatorTypes = (
              creatorTypes?.getTypesForItemType?.(entry.id) || []
            ).map((creator) => creator.name);
          } catch {
            row.creatorTypes = [];
          }
        }
        return row;
      }),
    };
  }

  /**
   * Creates items from scratch.
   *
   * Everything the agent could add came from outside — an identifier lookup
   * or a file import — so a book with no DOI, a thesis, a dataset, or a
   * personal communication simply could not be entered. That is an ordinary
   * thing to ask of a reference manager.
   */
  async createItems(params: {
    libraryID: number;
    items: Array<{
      itemType: string;
      fields?: Record<string, string>;
      creators?: EditableArticleCreator[];
      tags?: string[];
      collections?: number[];
    }>;
  }): Promise<{
    createdCount: number;
    items: Array<{
      itemId?: number;
      itemType: string;
      title: string;
      status: "created" | "error";
      reason?: string;
    }>;
  }> {
    const results: Array<{
      itemId?: number;
      itemType: string;
      title: string;
      status: "created" | "error";
      reason?: string;
    }> = [];
    let createdCount = 0;

    for (const spec of params.items) {
      const itemType = String(spec.itemType || "").trim();
      const title = String(spec.fields?.title || "").trim();
      try {
        const itemTypeId = (
          Zotero as unknown as {
            ItemTypes?: { getID?: (name: string) => number | false };
          }
        ).ItemTypes?.getID?.(itemType);
        if (!itemTypeId) {
          results.push({
            itemType,
            title,
            status: "error",
            reason: `"${itemType}" is not a Zotero item type. Use library_search({ entity:'itemTypes', mode:'list' }) to see the valid ones.`,
          });
          continue;
        }
        const item = new Zotero.Item(itemType as never);
        item.libraryID = params.libraryID;

        const invalid: string[] = [];
        for (const [fieldName, value] of Object.entries(spec.fields || {})) {
          if (!isFieldValidForItemType(item, fieldName)) {
            invalid.push(fieldName);
            continue;
          }
          item.setField(fieldName, String(value ?? ""));
        }
        if (invalid.length) {
          results.push({
            itemType,
            title,
            status: "error",
            reason: `Fields not valid for ${itemType}: ${invalid.join(", ")}. Valid fields: ${listEditableFieldsForItem(item).join(", ")}.`,
          });
          continue;
        }

        if (spec.creators?.length) {
          item.setCreators(spec.creators as never);
        }
        for (const tag of spec.tags || []) {
          if (tag) item.addTag(String(tag));
        }
        for (const collectionId of spec.collections || []) {
          if (collectionId > 0) item.addToCollection(collectionId);
        }

        await item.saveTx();
        createdCount += 1;
        results.push({
          itemId: Number(item.id),
          itemType,
          title: title || String(item.getDisplayTitle?.() || ""),
          status: "created",
        });
      } catch (error) {
        results.push({
          itemType,
          title,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { createdCount, items: results };
  }

  /**
   * Moves an item under a different parent, or detaches it to top level.
   *
   * The capability matrix declared reparent allowed for notes and attachments
   * and nothing implemented it, so "move this note onto that paper" — an
   * everyday tidy-up — had no path but a raw script.
   */
  async reparentItems(params: {
    assignments: Array<{ itemId: number; parentItemId: number | null }>;
  }): Promise<{
    changedCount: number;
    items: Array<{
      itemId: number;
      title: string;
      status: "reparented" | "skipped" | "error";
      previousParentId?: number | null;
      reason?: string;
    }>;
  }> {
    const results: Array<{
      itemId: number;
      title: string;
      status: "reparented" | "skipped" | "error";
      previousParentId?: number | null;
      reason?: string;
    }> = [];
    let changedCount = 0;

    for (const assignment of params.assignments) {
      const rawItem = this.getItem(assignment.itemId);
      const resolution = resolveMatrixItem(
        rawItem,
        assignment.itemId,
        "reparent",
      );
      if ("refusal" in resolution) {
        results.push({
          itemId: assignment.itemId,
          title: rawItem
            ? normalizeText(rawItem.getDisplayTitle?.()) ||
              `Item ${assignment.itemId}`
            : `Item ${assignment.itemId}`,
          status: "error",
          reason: resolution.refusal,
        });
        continue;
      }
      const item = resolution.item;
      const title =
        normalizeText(item.getDisplayTitle?.()) || `Item ${item.id}`;
      const previousParentId =
        (item as unknown as { parentID?: number | false }).parentID || null;

      // A parent must be a regular item: Zotero cannot nest a note under an
      // attachment, and attaching to a child would silently produce an
      // unreachable item.
      if (assignment.parentItemId != null) {
        const parent = this.getItem(assignment.parentItemId);
        if (!parent) {
          results.push({
            itemId: Number(item.id),
            title,
            status: "error",
            reason: `No item with ID ${assignment.parentItemId} exists in this library`,
          });
          continue;
        }
        if (!parent.isRegularItem?.()) {
          results.push({
            itemId: Number(item.id),
            title,
            status: "error",
            reason:
              "A parent must be a regular bibliographic item; notes and attachments cannot hold children",
          });
          continue;
        }
      }

      if (previousParentId === (assignment.parentItemId ?? null)) {
        results.push({
          itemId: Number(item.id),
          title,
          status: "skipped",
          previousParentId,
          reason: "Already attached there",
        });
        continue;
      }

      try {
        (item as unknown as { parentID: number | false }).parentID =
          assignment.parentItemId ?? false;
        await item.saveTx();
        changedCount += 1;
        results.push({
          itemId: Number(item.id),
          title,
          status: "reparented",
          previousParentId,
        });
      } catch (error) {
        results.push({
          itemId: Number(item.id),
          title,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { changedCount, items: results };
  }

  /**
   * Adds or removes Zotero's "Related" links between items.
   *
   * Relations are bidirectional in Zotero, so both sides are saved together;
   * writing one side leaves the pair inconsistent.
   */
  async relateItems(params: {
    itemId: number;
    relatedItemIds: number[];
    action: "add" | "remove";
  }): Promise<{
    itemId: number;
    changedCount: number;
    items: Array<{
      relatedItemId: number;
      status: "related" | "unrelated" | "skipped" | "error";
      reason?: string;
    }>;
  }> {
    const rawItem = this.getItem(params.itemId);
    const resolution = resolveMatrixItem(rawItem, params.itemId, "relate");
    if ("refusal" in resolution) throw new Error(resolution.refusal);
    const item = resolution.item;

    const results: Array<{
      relatedItemId: number;
      status: "related" | "unrelated" | "skipped" | "error";
      reason?: string;
    }> = [];
    let changedCount = 0;

    for (const relatedItemId of params.relatedItemIds) {
      if (relatedItemId === params.itemId) {
        results.push({
          relatedItemId,
          status: "skipped",
          reason: "An item cannot be related to itself",
        });
        continue;
      }
      const otherRaw = this.getItem(relatedItemId);
      const otherResolution = resolveMatrixItem(
        otherRaw,
        relatedItemId,
        "relate",
      );
      if ("refusal" in otherResolution) {
        results.push({
          relatedItemId,
          status: "error",
          reason: otherResolution.refusal,
        });
        continue;
      }
      const other = otherResolution.item;
      let forward = false;
      let backward = false;
      try {
        const db = (
          Zotero as unknown as {
            DB?: {
              executeTransaction?: (task: () => Promise<void>) => Promise<void>;
            };
          }
        ).DB;
        const forwardItem = item as Zotero.Item & {
          save?: () => Promise<unknown>;
        };
        const backwardItem = other as Zotero.Item & {
          save?: () => Promise<unknown>;
        };
        if (
          typeof db?.executeTransaction !== "function" ||
          typeof forwardItem.save !== "function" ||
          typeof backwardItem.save !== "function"
        ) {
          throw new Error(
            "Atomic bidirectional relation persistence is unavailable",
          );
        }
        await db.executeTransaction(async () => {
          // Both sides are evaluated, never short-circuited: `a && b` would
          // apply one direction and skip the other, leaving Zotero's
          // bidirectional relation half-written and permanently inconsistent.
          if (params.action === "add") {
            forward = item.addRelatedItem(other);
            backward = other.addRelatedItem(item);
          } else {
            forward = await item.removeRelatedItem(other);
            backward = await other.removeRelatedItem(item);
          }
          if (forward !== backward) {
            // One side was already in the target state. Put the other side
            // back so the pair remains symmetric without committing either.
            if (params.action === "add") {
              if (forward) await item.removeRelatedItem(other);
              if (backward) await other.removeRelatedItem(item);
            } else {
              if (forward) item.addRelatedItem(other);
              if (backward) other.addRelatedItem(item);
            }
            return;
          }
          if (forward && backward) {
            await forwardItem.save();
            await backwardItem.save();
          }
        });
        const changed = forward && backward;
        if (!changed) {
          results.push({
            relatedItemId,
            status: "skipped",
            reason:
              params.action === "add" ? "Already related" : "Was not related",
          });
          continue;
        }
        changedCount += 1;
        results.push({
          relatedItemId,
          status: params.action === "add" ? "related" : "unrelated",
        });
      } catch (error) {
        // A rejected transaction rolls the database back, but Zotero item
        // objects can retain their in-memory relation mutation. Restore that
        // representation as well so a later retry starts from database truth.
        try {
          if (params.action === "add") {
            if (forward) await item.removeRelatedItem(other);
            if (backward) await other.removeRelatedItem(item);
          } else {
            if (forward) item.addRelatedItem(other);
            if (backward) other.addRelatedItem(item);
          }
        } catch {
          await Promise.all([
            (
              item as Zotero.Item & { reload?: () => Promise<unknown> }
            ).reload?.(),
            (
              other as Zotero.Item & { reload?: () => Promise<unknown> }
            ).reload?.(),
          ]);
        }
        results.push({
          relatedItemId,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { itemId: params.itemId, changedCount, items: results };
  }

  async listItemsByFilters(params: {
    libraryID: number;
    filters?: AgentLibraryFilters;
    limit?: number;
    offset?: number;
    sort?: "dateAdded" | "title";
    order?: "asc" | "desc";
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    try {
      const search = buildAgentLibrarySearch(libraryID, params.filters || {});
      const rawIds: number[] = await search.search();
      // Drop child items (child notes, annotations, attachments)
      const topIds: number[] = [];
      const seen = new Set<number>();
      for (const id of rawIds) {
        const item = Zotero.Items.get(id);
        if (item && !item.parentID && !item.isAnnotation?.() && !seen.has(id)) {
          seen.add(id);
          topIds.push(id);
        }
      }
      const snapshot = await libraryIndexService.getSnapshot(libraryID);
      const matchingIds: number[] = [];
      for (const id of topIds) {
        const indexed = snapshot.itemById.get(id);
        if (!indexed) continue;
        const wantsDeleted = params.filters?.deleted === true;
        if (wantsDeleted ? !indexed.deleted : indexed.deleted) continue;
        const hasPdf = (snapshot.childAttachmentIdsByItemId.get(id) || []).some(
          (attachmentId) => snapshot.attachmentById.get(attachmentId)?.isPdf,
        );
        if (
          params.filters?.hasPdf !== undefined &&
          hasPdf !== params.filters.hasPdf
        ) {
          continue;
        }
        const year = Number(indexed.year);
        if (
          params.filters?.yearFrom != null &&
          (!year || year < params.filters.yearFrom)
        ) {
          continue;
        }
        if (
          params.filters?.yearTo != null &&
          (!year || year > params.filters.yearTo)
        ) {
          continue;
        }
        matchingIds.push(id);
      }
      return {
        items: buildItemTargetsForIds(
          this,
          sortAndPageIndexIds(snapshot, matchingIds, params),
        ),
        totalCount: matchingIds.length,
      };
    } catch (error) {
      // The in-memory path reads the live library, so it cannot answer a
      // trash query. Falling back would quietly return the user's ordinary
      // items when they asked what was in the trash.
      if (params.filters?.deleted) throw error;
      // Otherwise a genuine fallback: the in-memory path applies the same
      // filters and returns correct results. It is logged because silence is
      // what masked the `year` operator bug for as long as it existed.
      Zotero.debug(
        `[agent] Zotero.Search listing failed, falling back to in-memory filtering: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this._listItemsByFiltersInMemory(params);
    }
  }

  private async _listItemsByFiltersInMemory(params: {
    libraryID: number;
    filters?: AgentLibraryFilters;
    limit?: number;
    offset?: number;
    sort?: "dateAdded" | "title";
    order?: "asc" | "desc";
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const filters = params.filters || {};
    const snapshot = await libraryIndexService.getSnapshot(params.libraryID);
    const author = normalizeLibraryIndexText(filters.author || "");
    const ids = orderedIndexIds(snapshot, (item) => {
      if (!indexItemMatchesType(item, filters.itemType)) return false;
      if (
        filters.collectionId &&
        !item.collectionIds.includes(filters.collectionId)
      ) {
        return false;
      }
      if (filters.unfiled && item.collectionIds.length) return false;
      if (
        author &&
        !normalizeLibraryIndexText(item.firstCreator).includes(author)
      ) {
        return false;
      }
      const year = Number(item.year);
      if (filters.yearFrom != null && (!year || year < filters.yearFrom)) {
        return false;
      }
      if (filters.yearTo != null && (!year || year > filters.yearTo)) {
        return false;
      }
      if (
        filters.tag &&
        ![...item.tags, ...item.automaticTags].includes(filters.tag)
      ) {
        return false;
      }
      if (filters.hasPdf !== undefined) {
        const hasPdf = (
          snapshot.childAttachmentIdsByItemId.get(item.itemId) || []
        ).some((attachmentId) =>
          Boolean(snapshot.attachmentById.get(attachmentId)?.isPdf),
        );
        if (hasPdf !== filters.hasPdf) return false;
      }
      return true;
    });
    return {
      items: buildItemTargetsForIds(
        this,
        sortAndPageIndexIds(snapshot, ids, params),
      ),
      totalCount: ids.length,
    };
  }

  async listStandaloneNotes(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{ notes: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const ids = orderedIndexIds(
      snapshot,
      (item) => item.kind === "standalone-note",
    );
    return {
      notes: buildItemTargetsForIds(this, pageIds(ids, params.limit)),
      totalCount: ids.length,
    };
  }

  getStandaloneNoteContent(params: { noteId: number }): PaperNoteRecord | null {
    const noteItem = this.getItem(params.noteId);
    if (!noteItem || !(noteItem as any).isNote?.()) return null;
    const html = noteItem.getNote?.() || "";
    const text = normalizeNoteSourceText(html);
    if (!text.trim()) return null;
    const rawTitle = normalizeText(
      (noteItem as any).getNoteTitle?.() || noteItem.getDisplayTitle?.() || "",
    ).trim();
    return {
      noteId: noteItem.id,
      title: rawTitle || `Note ${noteItem.id}`,
      noteText: text,
      wordCount: text.split(/\s+/).filter(Boolean).length,
    };
  }

  getAttachmentInfo(params: { attachmentId: number }): {
    attachmentId: number;
    parentItemId?: number;
    title: string;
    contentType: string;
    filename?: string;
    hasFile: boolean;
    linkMode: string;
  } | null {
    const item = this.getItem(params.attachmentId);
    if (!item || !item.isAttachment?.()) return null;
    const filename = normalizeText(
      (item as any).attachmentFilename || item.getField?.("title") || "",
    );
    const hasFile = !!(item as any).hasFile;
    const rawLinkMode = (item as any).attachmentLinkMode;
    const linkModeMap: Record<number, string> = {
      0: "imported_file",
      1: "imported_url",
      2: "linked_file",
      3: "linked_url",
    };
    const linkMode =
      typeof rawLinkMode === "number"
        ? linkModeMap[rawLinkMode] || String(rawLinkMode)
        : "unknown";
    return {
      attachmentId: item.id,
      parentItemId: item.parentID || undefined,
      title:
        normalizeText(item.getField?.("title")) ||
        filename ||
        `Attachment ${item.id}`,
      contentType:
        normalizeText(item.attachmentContentType) || "application/octet-stream",
      filename: filename || undefined,
      hasFile,
      linkMode,
    };
  }

  async searchAllLibraryItems(params: {
    libraryID: number;
    query: string;
    filters?: AgentLibraryFilters;
    allowedItemIds?: number[];
    limit?: number;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID || !params.query?.trim()) {
      return { items: [], totalCount: 0 };
    }
    const normalizedLimit = normalizeResultLimit(params.limit) || 50;
    const allowedItemIds = Array.isArray(params.allowedItemIds)
      ? new Set(
          params.allowedItemIds
            .map((itemId) =>
              Number.isFinite(itemId) && itemId > 0 ? Math.floor(itemId) : 0,
            )
            .filter(Boolean),
        )
      : null;
    try {
      const search = params.filters
        ? buildAgentLibrarySearch(libraryID, params.filters)
        : new Zotero.Search({ libraryID });
      search.addCondition(
        "quicksearch-everything",
        "contains",
        params.query.trim(),
      );
      const rawIds: number[] = await search.search();
      // Resolve child items (notes/attachments) to their top-level parent, de-duplicate
      const resolvedIds: number[] = [];
      const seen = new Set<number>();
      for (const id of rawIds) {
        const item = Zotero.Items.get(id);
        if (!item) continue;
        const topId = (item.parentID as number | false | undefined) || id;
        if (allowedItemIds && !allowedItemIds.has(topId)) continue;
        if (!seen.has(topId)) {
          seen.add(topId);
          resolvedIds.push(topId);
        }
      }
      const targets: LibraryItemTarget[] = [];
      for (const itemId of resolvedIds) {
        const item = this.getItem(itemId);
        if (!item) continue;
        const target = buildItemTargetFromItem(item);
        if (
          target &&
          libraryItemTargetMatchesFilters(target, params.filters) &&
          libraryItemTargetMatchesYear(target, params.filters)
        ) {
          targets.push(target);
        }
      }
      return {
        items:
          normalizedLimit && targets.length > normalizedLimit
            ? targets.slice(0, normalizedLimit)
            : targets,
        totalCount: targets.length,
      };
    } catch (error) {
      // Deliberately not swallowed into an empty result. Reporting "no
      // matching library results" for a *broken query* is indistinguishable
      // from a genuine miss, which is exactly how the `year` operator bug
      // stayed invisible: the agent confidently told users their library had
      // nothing. A thrown error surfaces as a tool failure instead.
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async searchAllNotes(params: {
    libraryID: number;
    query: string;
    limit?: number;
  }): Promise<
    Array<
      LibraryItemTarget & { parentItemId?: number; parentItemTitle?: string }
    >
  > {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const query = params.query?.trim();
    if (!query) return [];
    const normalizedLimit = Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit as number))
      : 200;
    try {
      const search = new Zotero.Search({ libraryID });
      search.addCondition("itemType", "is", "note");
      search.addCondition("quicksearch-everything", "contains", query);
      const noteIds: number[] = await search.search();
      return this._buildNoteResults(noteIds, normalizedLimit);
    } catch (_error) {
      void _error;
      // Fallback: in-memory scan across all items and child notes
      return this._searchAllNotesInMemory({
        libraryID,
        query,
        limit: normalizedLimit,
      });
    }
  }

  private _buildNoteResults(
    noteIds: number[],
    limit: number,
  ): Array<
    LibraryItemTarget & { parentItemId?: number; parentItemTitle?: string }
  > {
    const results: Array<
      LibraryItemTarget & { parentItemId?: number; parentItemTitle?: string }
    > = [];
    for (const noteId of noteIds) {
      if (results.length >= limit) break;
      const noteItem = this.getItem(noteId);
      if (!noteItem?.isNote?.()) continue;
      const rawTitle = normalizeText(
        (noteItem as any).getNoteTitle?.() ||
          noteItem.getDisplayTitle?.() ||
          "",
      ).trim();
      const title = rawTitle || `Note ${noteItem.id}`;
      if (noteItem.parentID) {
        const parentItem = this.getItem(noteItem.parentID as number);
        const parentTitle = parentItem
          ? normalizeText(parentItem.getDisplayTitle?.() || "").trim() ||
            `Item ${parentItem.id}`
          : undefined;
        results.push({
          itemId: noteItem.id,
          itemType: "note",
          title,
          attachments: [],
          tags: getItemTags(noteItem),
          collectionIds: [],
          noteKind: "item",
          parentItemId: noteItem.parentID as number,
          parentItemTitle: parentTitle,
        });
      } else {
        const target = buildItemTargetFromItem(noteItem);
        if (target) results.push({ ...target, noteKind: "standalone" });
      }
    }
    return results;
  }

  private async _searchAllNotesInMemory(params: {
    libraryID: number;
    query: string;
    limit: number;
  }): Promise<
    Array<
      LibraryItemTarget & { parentItemId?: number; parentItemTitle?: string }
    >
  > {
    const queryLower = params.query.toLowerCase();
    const snapshot = await libraryIndexService.getSnapshot(params.libraryID);
    const results: Array<
      LibraryItemTarget & { parentItemId?: number; parentItemTitle?: string }
    > = [];
    for (const itemId of snapshot.topLevelItemOrder) {
      if (results.length >= params.limit) break;
      const indexed = snapshot.itemById.get(itemId);
      const item = this.getItem(itemId);
      if (!indexed || indexed.deleted || !item) continue;
      if (indexed.kind === "standalone-note") {
        const html = item.getNote?.() || "";
        const text = normalizeNoteSourceText(html);
        const rawTitle = normalizeText(
          (item as any).getNoteTitle?.() || item.getDisplayTitle?.() || "",
        ).trim();
        const title = rawTitle || `Note ${item.id}`;
        if (!`${title} ${text}`.toLowerCase().includes(queryLower)) continue;
        const target = buildItemTargetFromItem(item);
        if (target) results.push({ ...target, noteKind: "standalone" });
        continue;
      }
      if (indexed.kind !== "regular") continue;
      const noteIds = snapshot.childNoteIdsByItemId.get(itemId) || [];
      if (!noteIds.length) continue;
      const parentTitle =
        normalizeText(item.getDisplayTitle?.() || "").trim() ||
        `Item ${item.id}`;
      for (const noteId of noteIds) {
        if (results.length >= params.limit) break;
        const noteItem = Zotero.Items.get(noteId);
        if (
          !noteItem?.isNote?.() ||
          Boolean((noteItem as Zotero.Item & { deleted?: unknown }).deleted)
        )
          continue;
        const html = noteItem.getNote?.() || "";
        const text = normalizeNoteSourceText(html);
        const rawTitle = normalizeText(
          (noteItem as any).getNoteTitle?.() ||
            noteItem.getDisplayTitle?.() ||
            "",
        ).trim();
        const title = rawTitle || `Note ${noteItem.id}`;
        if (!`${title} ${text}`.toLowerCase().includes(queryLower)) continue;
        results.push({
          itemId: noteItem.id,
          itemType: "note",
          title,
          attachments: [],
          tags: getItemTags(noteItem),
          collectionIds: [],
          noteKind: "item",
          parentItemId: item.id,
          parentItemTitle: parentTitle,
        });
      }
    }
    return results;
  }

  async indexPdfAttachment(params: { attachmentId: number }): Promise<{
    attachmentId: number;
    indexingState: string;
    triggered: boolean;
  }> {
    const item = this.getItem(params.attachmentId);
    if (!item?.isAttachment?.()) throw new Error("Not an attachment item");
    if (!(item as any).isPDFAttachment?.())
      throw new Error("Not a PDF attachment");
    await Zotero.Fulltext.indexItems([params.attachmentId]);
    let indexingState = "unavailable";
    try {
      const stateNum = await Zotero.Fulltext.getIndexedState(item);
      indexingState = FULLTEXT_INDEX_STATE_MAP[stateNum] ?? "unavailable";
    } catch (err) {
      ztoolkit.log("LLM: Attachment indexing state check failed", err);
    }
    return {
      attachmentId: params.attachmentId,
      indexingState,
      triggered: true,
    };
  }

  async listLibraryTags(params: {
    libraryID: number;
    query?: string;
    limit?: number;
  }): Promise<{ name: string; type: number }[]> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const raw = await Zotero.Tags.getAll(libraryID);
    let tags = raw.map((t) => ({ name: t.tag, type: t.type ?? 0 }));
    if (params.query) {
      const q = params.query.toLowerCase();
      tags = tags.filter((t) => t.name.toLowerCase().includes(q));
    }
    const normalizedLimit = Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit as number))
      : undefined;
    return normalizedLimit ? tags.slice(0, normalizedLimit) : tags;
  }

  listAllLibraries(): {
    libraryID: number;
    name: string;
    type: string;
    editable: boolean;
  }[] {
    return Zotero.Libraries.getAll().map((lib) => ({
      libraryID: lib.libraryID,
      name: lib.name,
      type: Zotero.Libraries.getType(lib.libraryID),
      editable: Zotero.Libraries.isEditable(lib.libraryID),
    }));
  }

  async applyTagAssignments(params: {
    assignments: BatchTagAssignment[];
  }): Promise<{
    selectedCount: number;
    updatedCount: number;
    skippedCount: number;
    items: BatchTagItemResult[];
  }> {
    const normalizedAssignments: BatchTagAssignment[] = [];
    const seen = new Set<number>();
    for (const entry of params.assignments) {
      const itemId = Number.isFinite(entry.itemId)
        ? Math.floor(entry.itemId)
        : 0;
      const tags = Array.from(
        new Set(
          (Array.isArray(entry.tags) ? entry.tags : [])
            .map((tag) => normalizeText(tag))
            .filter(Boolean),
        ),
      );
      if (!itemId || !tags.length || seen.has(itemId)) continue;
      seen.add(itemId);
      normalizedAssignments.push({
        itemId,
        tags,
      });
    }
    if (!normalizedAssignments.length) {
      throw new Error("No valid tag assignments were provided");
    }
    const results: BatchTagItemResult[] = [];
    let updatedCount = 0;
    for (const assignment of normalizedAssignments) {
      // Tags live on the item itself. The old resolver redirected a child
      // attachment to its parent -- a wrong-object write that then reported
      // the PARENT's id and title as the target -- and rejected standalone
      // notes outright as "Item not found".
      const resolution = resolveMatrixItem(
        this.getItem(assignment.itemId),
        assignment.itemId,
        "update",
      );
      const item = "item" in resolution ? resolution.item : null;
      if (!item) {
        results.push({
          itemId: assignment.itemId,
          title: `Item ${assignment.itemId}`,
          status: "missing",
          addedTags: [],
          skippedTags: assignment.tags,
          reason:
            "refusal" in resolution
              ? resolution.refusal
              : `Item ${assignment.itemId} could not be resolved`,
        });
        continue;
      }
      const target = buildPaperTargetFromItem(item);
      const title =
        target?.title ||
        normalizeText(item.getDisplayTitle?.()) ||
        `Item ${item.id}`;
      const addedTags: string[] = [];
      const skippedTags: string[] = [];
      for (const tag of assignment.tags) {
        if (!tag) continue;
        if (item.hasTag?.(tag)) {
          skippedTags.push(tag);
          continue;
        }
        item.addTag?.(tag, 0);
        addedTags.push(tag);
      }
      if (addedTags.length) {
        await item.saveTx();
        updatedCount += 1;
      }
      results.push({
        itemId: item.id,
        title,
        status: addedTags.length ? "updated" : "skipped",
        addedTags,
        skippedTags,
        reason: addedTags.length ? undefined : "All tags already existed",
      });
    }
    return {
      selectedCount: normalizedAssignments.length,
      updatedCount,
      skippedCount: results.length - updatedCount,
      items: results,
    };
  }

  async applyTagsToItems(params: {
    itemIds: number[];
    tags: string[];
  }): Promise<{
    selectedCount: number;
    updatedCount: number;
    skippedCount: number;
    items: BatchTagItemResult[];
  }> {
    return this.applyTagAssignments({
      assignments: params.itemIds.map((itemId) => ({
        itemId,
        tags: params.tags,
      })),
    });
  }

  /**
   * Sets an item's collection membership to exactly the given set.
   *
   * Every other collection write in this file was an add or a single remove,
   * which is why "move" was a lie: `addItemsToCollections` only ever called
   * `addToCollection`, so a move left the item in both the old and the new
   * collection while reporting `status: "moved"`.
   *
   * Membership is a set, so it has to be written as one:
   *
   * - The whole destination set for an item is resolved before any write.
   *   One item can legitimately carry several destinations in a single call,
   *   and applying them pairwise makes the second assignment undo the first.
   * - Both `addToCollection` and `removeFromCollection` are checked against
   *   the capability matrix *before* anything is written. The matrix refuses
   *   child items for removal, so an add-then-refuse would leave the item
   *   filed in both places — the exact corruption this replaces.
   * - Adds and removes for one item share a single `saveTx`, so an item is
   *   never observable in a half-moved state.
   */
  async setItemCollections(params: {
    assignments: ItemCollectionSet[];
  }): Promise<{
    items: BatchMoveItemResult[];
    changedCount: number;
    priorCollections: ItemCollectionSet[];
  }> {
    // Collapse to one destination set per item before touching anything.
    const desired = new Map<number, Set<number>>();
    const order: number[] = [];
    for (const entry of params.assignments) {
      const itemId = Number.isFinite(entry.itemId)
        ? Math.floor(entry.itemId)
        : 0;
      if (!itemId) continue;
      if (!desired.has(itemId)) {
        desired.set(itemId, new Set());
        order.push(itemId);
      }
      const set = desired.get(itemId) as Set<number>;
      for (const raw of entry.collectionIds || []) {
        const collectionId = Number.isFinite(raw) ? Math.floor(raw) : 0;
        if (collectionId > 0) set.add(collectionId);
      }
    }

    const results: BatchMoveItemResult[] = [];
    const priorCollections: ItemCollectionSet[] = [];
    let changedCount = 0;

    for (const itemId of order) {
      const targets = desired.get(itemId) as Set<number>;
      const rawItem = this.getItem(itemId);

      // Check both verbs up front: a move that may not remove must not add.
      const addResolution = resolveMatrixItem(
        rawItem,
        itemId,
        "addToCollection",
      );
      const removeResolution = resolveMatrixItem(
        rawItem,
        itemId,
        "removeFromCollection",
      );
      const blocked =
        "refusal" in addResolution
          ? addResolution.refusal
          : "refusal" in removeResolution
            ? removeResolution.refusal
            : null;
      if (blocked || !("item" in addResolution)) {
        results.push({
          itemId,
          title: rawItem
            ? normalizeText(rawItem.getDisplayTitle?.()) || `Item ${itemId}`
            : `Item ${itemId}`,
          status: "missing",
          targetCollectionId: 0,
          reason: blocked || `Item ${itemId} could not be resolved`,
        });
        continue;
      }
      const item = addResolution.item;

      const prior = this.getItemCollectionIds(Number(item.id));
      const priorSet = new Set(prior);
      const toAdd = [...targets].filter((id) => !priorSet.has(id));
      const toRemove = prior.filter((id) => !targets.has(id));

      const title =
        normalizeText(item.getDisplayTitle?.()) || `Item ${item.id}`;
      const primaryTarget = [...targets][0] ?? 0;
      const targetSummary = primaryTarget
        ? this.getCollectionSummary(primaryTarget)
        : null;

      if (!toAdd.length && !toRemove.length) {
        results.push({
          itemId: Number(item.id),
          title,
          status: "skipped",
          targetCollectionId: primaryTarget,
          targetCollectionName: targetSummary?.path || targetSummary?.name,
          reason: "Already filed exactly here",
        });
        continue;
      }

      try {
        for (const collectionId of toAdd) {
          item.addToCollection(collectionId);
        }
        for (const collectionId of toRemove) {
          item.removeFromCollection(collectionId);
        }
        // One transaction per item: never observable half-moved.
        await item.saveTx();
      } catch (error) {
        results.push({
          itemId: Number(item.id),
          title,
          status: "missing",
          targetCollectionId: primaryTarget,
          targetCollectionName: targetSummary?.path || targetSummary?.name,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      // Recorded per item, so the inverse restores the exact prior set —
      // including items that were in three collections, or in none.
      priorCollections.push({ itemId: Number(item.id), collectionIds: prior });
      changedCount += 1;
      results.push({
        itemId: Number(item.id),
        title,
        status: "moved",
        targetCollectionId: primaryTarget,
        targetCollectionName: targetSummary?.path || targetSummary?.name,
      });
    }

    return { items: results, changedCount, priorCollections };
  }

  /**
   * Files items into collections.
   *
   * `mode: "add"` is the historical behaviour and stays the default: the item
   * gains the destination and keeps everything else.
   *
   * `mode: "move"` actually moves. Until now the vocabulary said "moved"
   * everywhere — the result field, the row status, the button — while the
   * code only ever added, so asking to move a paper left it filed in both
   * the old and the new collection.
   *
   * `from` is required for a move and never inferred: `from: <collectionId>`
   * takes it out of that one collection, `from: "all"` makes the destination
   * set exhaustive. Guessing would silently unfile items from collections the
   * user never mentioned.
   */
  async addItemsToCollections(params: {
    assignments: BatchMoveAssignment[];
    mode?: "add" | "move";
    from?: number | "all";
  }): Promise<{
    selectedCount: number;
    movedCount: number;
    skippedCount: number;
    collections: CollectionSummary[];
    items: BatchMoveItemResult[];
    priorCollections?: ItemCollectionSet[];
  }> {
    const normalizedAssignments: BatchMoveAssignment[] = [];
    const seen = new Set<string>();
    for (const entry of params.assignments) {
      const itemId = Number.isFinite(entry.itemId)
        ? Math.floor(entry.itemId)
        : 0;
      const targetCollectionId = Number.isFinite(entry.targetCollectionId)
        ? Math.floor(entry.targetCollectionId)
        : 0;
      const key = `${itemId}:${targetCollectionId}`;
      if (!itemId || !targetCollectionId || seen.has(key)) continue;
      seen.add(key);
      normalizedAssignments.push({
        itemId,
        targetCollectionId,
      });
    }
    if (!normalizedAssignments.length) {
      throw new Error("No valid collection assignments were provided");
    }
    const collectionMap = new Map<number, CollectionSummary>();
    for (const assignment of normalizedAssignments) {
      if (collectionMap.has(assignment.targetCollectionId)) continue;
      const collection = this.getCollectionSummary(
        assignment.targetCollectionId,
      );
      if (!collection) {
        throw new Error("Collection not found");
      }
      collectionMap.set(assignment.targetCollectionId, collection);
    }

    if (params.mode === "move") {
      if (params.from == null) {
        throw new Error(
          'A move needs an explicit source: pass from:<collectionId> to take items out of one collection, or from:"all" to replace their collection membership entirely.',
        );
      }
      // Collapse every assignment into one destination set per item first.
      // Handling them pairwise would let the second assignment for an item
      // undo the first.
      const destinations = new Map<number, Set<number>>();
      for (const assignment of normalizedAssignments) {
        const set = destinations.get(assignment.itemId) || new Set<number>();
        set.add(assignment.targetCollectionId);
        destinations.set(assignment.itemId, set);
      }
      const sets: ItemCollectionSet[] = [];
      for (const [itemId, targets] of destinations) {
        const keep =
          params.from === "all"
            ? []
            : this.getItemCollectionIds(itemId).filter(
                (id) => id !== params.from,
              );
        sets.push({
          itemId,
          collectionIds: Array.from(new Set([...keep, ...targets])),
        });
      }
      const outcome = await this.setItemCollections({ assignments: sets });
      return {
        selectedCount: sets.length,
        movedCount: outcome.changedCount,
        skippedCount: outcome.items.length - outcome.changedCount,
        collections: Array.from(collectionMap.values()),
        items: outcome.items,
        priorCollections: outcome.priorCollections,
      };
    }

    const results: BatchMoveItemResult[] = [];
    let movedCount = 0;
    for (const assignment of normalizedAssignments) {
      const collection = collectionMap.get(assignment.targetCollectionId);
      if (!collection) {
        results.push({
          itemId: assignment.itemId,
          title: `Item ${assignment.itemId}`,
          status: "missing",
          targetCollectionId: assignment.targetCollectionId,
          reason: "Collection not found",
        });
        continue;
      }
      const rawItem = this.getItem(assignment.itemId);
      const resolution = resolveMatrixItem(
        rawItem,
        assignment.itemId,
        "addToCollection",
      );
      const item = "item" in resolution ? resolution.item : null;
      if (!item) {
        // "Item not found" was reported for items that plainly exist — a
        // note, a standalone attachment, a child attachment — because the
        // filter that rejected them could not say why. An agent reading that
        // reason has no way to correct itself, and a user reading it in the
        // trace is simply told something false.
        results.push({
          itemId: assignment.itemId,
          title: rawItem
            ? normalizeText(rawItem.getDisplayTitle?.()) ||
              `Item ${assignment.itemId}`
            : `Item ${assignment.itemId}`,
          status: "missing",
          targetCollectionId: collection.collectionId,
          targetCollectionName: collection.path || collection.name,
          reason:
            "refusal" in resolution
              ? resolution.refusal
              : `Item ${assignment.itemId} could not be resolved`,
        });
        continue;
      }
      const target = buildPaperTargetFromItem(item);
      const title =
        target?.title ||
        normalizeText(item.getDisplayTitle?.()) ||
        `Item ${item.id}`;
      if (item.inCollection?.(collection.collectionId)) {
        results.push({
          itemId: item.id,
          title,
          status: "skipped",
          targetCollectionId: collection.collectionId,
          targetCollectionName: collection.path || collection.name,
          reason: "Paper is already in this collection",
        });
        continue;
      }
      item.addToCollection(collection.collectionId);
      await item.saveTx();
      movedCount += 1;
      results.push({
        itemId: item.id,
        title,
        status: "moved",
        targetCollectionId: collection.collectionId,
        targetCollectionName: collection.path || collection.name,
      });
    }
    return {
      selectedCount: normalizedAssignments.length,
      movedCount,
      skippedCount: results.length - movedCount,
      collections: Array.from(collectionMap.values()),
      items: results,
    };
  }

  async addItemsToCollection(params: {
    itemIds: number[];
    targetCollectionId: number;
  }): Promise<{
    selectedCount: number;
    movedCount: number;
    skippedCount: number;
    collection: CollectionSummary;
    items: BatchMoveItemResult[];
  }> {
    const collection = this.getCollectionSummary(params.targetCollectionId);
    if (!collection) {
      throw new Error("Collection not found");
    }
    const result = await this.addItemsToCollections({
      assignments: params.itemIds.map((itemId) => ({
        itemId,
        targetCollectionId: params.targetCollectionId,
      })),
    });
    return {
      selectedCount: result.selectedCount,
      movedCount: result.movedCount,
      skippedCount: result.skippedCount,
      collection,
      items: result.items,
    };
  }

  async saveAnswerToNote(params: {
    item: Zotero.Item | null;
    libraryID?: number;
    content: string;
    modelName: string;
    target?: "item" | "standalone";
    appendToTrackedNote?: boolean;
    generatedImages?: GeneratedChatImage[];
    /** Collections to file a standalone note into. Ignored for child notes. */
    collections?: number[];
  }): Promise<SaveAnswerToNoteResult> {
    if (params.target === "standalone") {
      const libraryID =
        Number.isFinite(params.libraryID) && (params.libraryID as number) > 0
          ? Math.floor(params.libraryID as number)
          : params.item?.libraryID || 0;
      const created = await createStandaloneNoteFromAssistantText(
        libraryID,
        params.content,
        params.modelName,
        undefined,
        undefined,
        params.generatedImages,
        undefined,
        undefined,
        params.collections,
      );
      return {
        status: "standalone_created",
        noteId: created.noteId,
        collections: created.collections,
        ...(created.createdNoteReceipt
          ? { createdNoteReceipt: created.createdNoteReceipt }
          : {}),
      };
    }
    if (!params.item) {
      throw new Error("No Zotero item is active for item-note creation");
    }
    return createNoteFromAssistantText(
      params.item,
      params.content,
      params.modelName,
      undefined,
      {
        appendToTrackedNote: params.appendToTrackedNote === true,
        rememberCreatedNote: params.appendToTrackedNote === true,
        generatedImages: params.generatedImages,
      },
    );
  }

  getPaperNotes(params: {
    item: Zotero.Item | null | undefined;
    maxNotes?: number;
  }): PaperNoteRecord[] {
    const target = resolveRegularItem(params.item);
    if (!target) return [];
    const limit =
      Number.isFinite(params.maxNotes) && (params.maxNotes as number) > 0
        ? Math.floor(params.maxNotes as number)
        : 20;
    try {
      const noteIds: number[] = target.getNotes?.() || [];
      const results: PaperNoteRecord[] = [];
      for (const noteId of noteIds) {
        if (results.length >= limit) break;
        const noteItem = Zotero.Items.get(noteId);
        if (!noteItem?.isNote?.()) continue;
        const html = noteItem.getNote?.() || "";
        const text = normalizeNoteSourceText(html);
        if (!text.trim()) continue;
        const rawTitle = normalizeText(
          (
            noteItem as unknown as { getNoteTitle?: () => unknown }
          ).getNoteTitle?.() || "",
        ).trim();
        results.push({
          noteId: noteItem.id,
          title: rawTitle || `Note ${noteItem.id}`,
          noteText:
            text.length > 10000 ? `${text.slice(0, 10000)}\u2026` : text,
          wordCount: text.split(/\s+/).filter(Boolean).length,
        });
      }
      return results;
    } catch (_error) {
      void _error;
      return [];
    }
  }

  getPaperAnnotations(params: {
    item: Zotero.Item | null | undefined;
    maxAnnotations?: number;
  }): PaperAnnotationRecord[] {
    const target = resolveRegularItem(params.item);
    if (!target) return [];
    const limit =
      Number.isFinite(params.maxAnnotations) &&
      (params.maxAnnotations as number) > 0
        ? Math.floor(params.maxAnnotations as number)
        : 100;
    const results: PaperAnnotationRecord[] = [];
    try {
      const pdfs = getPdfChildAttachments(target);
      for (const pdf of pdfs) {
        if (results.length >= limit) break;
        const annotationIds: number[] =
          (
            pdf as unknown as { getAnnotations?: () => number[] }
          ).getAnnotations?.() || [];
        for (const annotationId of annotationIds) {
          if (results.length >= limit) break;
          const annotation = Zotero.Items.get(annotationId);
          if (!annotation?.isAnnotation?.()) continue;
          const ann = annotation as unknown as {
            annotationText?: string;
            annotationComment?: string;
            annotationType?: string;
            annotationColor?: string;
            annotationPageLabel?: string;
          };
          const text = normalizeText(ann.annotationText || "");
          const comment =
            normalizeText(ann.annotationComment || "") || undefined;
          if (!text && !comment) continue;
          results.push({
            annotationId: annotation.id,
            type: normalizeText(ann.annotationType || "") || "highlight",
            text: text.length > 500 ? `${text.slice(0, 500)}\u2026` : text,
            comment:
              comment && comment.length > 500
                ? `${comment.slice(0, 500)}\u2026`
                : comment,
            color: normalizeText(ann.annotationColor || "") || undefined,
            pageLabel:
              normalizeText(ann.annotationPageLabel || "") || undefined,
          });
        }
      }
    } catch (_error) {
      void _error;
    }
    return results;
  }

  async createCollection(params: {
    name: string;
    parentCollectionId?: number;
    libraryID: number;
  }): Promise<CollectionSummary> {
    const normalizedName = normalizeText(params.name).trim();
    if (!normalizedName) {
      throw new Error("Collection name is required");
    }
    const libraryID =
      Number.isFinite(params.libraryID) && params.libraryID > 0
        ? Math.floor(params.libraryID)
        : 0;
    if (!libraryID) {
      throw new Error("No library available for collection creation");
    }
    if (params.parentCollectionId) {
      const parentCollection = this.getCollection(params.parentCollectionId);
      if (!parentCollection) {
        throw new Error(
          `Parent collection ${params.parentCollectionId} not found`,
        );
      }
    }
    const collection = new Zotero.Collection();
    (collection as unknown as { libraryID: number }).libraryID = libraryID;
    collection.name = normalizedName;
    if (params.parentCollectionId) {
      collection.parentID = params.parentCollectionId;
    }
    await collection.saveTx();
    const allCollections = listLibraryCollections(libraryID);
    const pathMap = buildCollectionPathMap(allCollections);
    return {
      collectionId: collection.id,
      name: normalizedName,
      libraryID,
      path: pathMap.get(collection.id) || normalizedName,
    };
  }

  /**
   * Describes a collection before it is deleted.
   *
   * Deleting now trashes rather than erases, so the inverse is a restore by
   * id and this snapshot is no longer load-bearing for undo. It still
   * describes the collection for the confirmation card, and
   * `childCollectionCount` tells the user how much of their tree a delete
   * would take with it. Returns `null` when the collection does not exist.
   */
  snapshotCollectionForDelete(params: { collectionId: number }): {
    name: string;
    parentCollectionId?: number;
    libraryID: number;
    itemIds: number[];
    childCollectionCount: number;
  } | null {
    const collection = this.getCollection(params.collectionId) as
      | (Zotero.Collection & {
          getChildItems?: (asIDs: true, includeDeleted?: boolean) => number[];
          getChildCollections?: (asIDs: true) => number[];
        })
      | null;
    if (!collection) return null;
    let itemIds: number[] = [];
    try {
      itemIds = collection.getChildItems?.(true) || [];
    } catch {
      itemIds = [];
    }
    let childCollectionCount = 0;
    try {
      childCollectionCount = (collection.getChildCollections?.(true) || [])
        .length;
    } catch {
      childCollectionCount = 0;
    }
    const parentID = Number((collection as { parentID?: unknown }).parentID);
    return {
      name:
        normalizeText(collection.name) || `Collection ${params.collectionId}`,
      parentCollectionId:
        Number.isFinite(parentID) && parentID > 0 ? parentID : undefined,
      libraryID: Number(collection.libraryID) || 0,
      itemIds,
      childCollectionCount,
    };
  }

  /**
   * Moves a collection to the trash, matching what Zotero's own UI does.
   *
   * This used to call `eraseTx()`, which is Zotero's *permanent* erase — it
   * wipes the collection and every descendant with no way back. Zotero has
   * had a collection trash since `deletedCollections` landed, and its own
   * "Delete Collection" sets `deleted = true`; only "Delete Permanently"
   * erases. The agent was therefore more destructive than the UI while
   * telling the user the opposite ("Zotero has no trash for collections").
   *
   * Setting `deleted` routes through `Zotero.Collection.trash()`, which
   * trashes descendant collections too and preserves every id, so a restore
   * brings back the original objects rather than rebuilding lookalikes.
   *
   * Items are left in the library unless `deleteItems` is set — again
   * matching Zotero, whose menu offers "Delete Collection" and "Delete
   * Collection and Items" as separate commands.
   */
  /**
   * Renames a collection, moves it under a different parent, or promotes it
   * to top level.
   *
   * The matrix declared collection update and reparent allowed and nothing
   * implemented them, so `collection_update` could only create and delete --
   * a typo in a folder name meant deleting it and rebuilding it, losing the
   * id every filed item referenced.
   */
  async updateCollection(params: {
    collectionId: number;
    name?: string;
    parentCollectionId?: number | null;
  }): Promise<{
    collectionId: number;
    name: string;
    previousName: string;
    previousParentCollectionId: number | null;
    status: "updated" | "unchanged" | "not_found";
    reason?: string;
  }> {
    const collection = this.getCollection(params.collectionId) as
      | (Zotero.Collection & { parentID?: number | false })
      | null;
    if (!collection) {
      return {
        collectionId: params.collectionId,
        name: "",
        previousName: "",
        previousParentCollectionId: null,
        status: "not_found",
      };
    }
    const previousName = normalizeText(collection.name);
    const previousParentRaw = Number(collection.parentID);
    const previousParentCollectionId =
      Number.isFinite(previousParentRaw) && previousParentRaw > 0
        ? previousParentRaw
        : null;

    const nextName = params.name?.trim();
    const wantsReparent = params.parentCollectionId !== undefined;
    const nextParent =
      params.parentCollectionId === null
        ? null
        : params.parentCollectionId === undefined
          ? previousParentCollectionId
          : Math.floor(params.parentCollectionId);

    if (wantsReparent && nextParent !== null) {
      if (nextParent === params.collectionId) {
        return {
          collectionId: params.collectionId,
          name: previousName,
          previousName,
          previousParentCollectionId,
          status: "not_found",
          reason: "A collection cannot be its own parent",
        };
      }
      const target = this.getCollection(nextParent);
      if (!target) {
        return {
          collectionId: params.collectionId,
          name: previousName,
          previousName,
          previousParentCollectionId,
          status: "not_found",
          reason: `No collection with ID ${nextParent} exists in this library`,
        };
      }
      // Zotero would accept this and produce an orphaned cycle that no
      // longer appears anywhere in the tree.
      const descendants = new Set(
        (
          (
            collection as unknown as {
              getDescendents?: (
                nested: boolean,
                type: "collection" | null,
              ) => Array<{ id: number; type: string }>;
            }
          ).getDescendents?.(false, "collection") || []
        ).map((entry) => Number(entry.id)),
      );
      if (descendants.has(nextParent)) {
        return {
          collectionId: params.collectionId,
          name: previousName,
          previousName,
          previousParentCollectionId,
          status: "not_found",
          reason:
            "That collection is inside this one, so moving it there would detach the whole subtree from the library",
        };
      }
    }

    const nameChanged = Boolean(nextName) && nextName !== previousName;
    const parentChanged =
      wantsReparent && nextParent !== previousParentCollectionId;
    if (!nameChanged && !parentChanged) {
      return {
        collectionId: params.collectionId,
        name: previousName,
        previousName,
        previousParentCollectionId,
        status: "unchanged",
      };
    }

    if (nameChanged) collection.name = nextName as string;
    if (parentChanged) {
      (collection as unknown as { parentID: number | false }).parentID =
        nextParent ?? false;
    }
    await (
      collection as unknown as { saveTx: () => Promise<unknown> }
    ).saveTx();
    return {
      collectionId: params.collectionId,
      name: normalizeText(collection.name),
      previousName,
      previousParentCollectionId,
      status: "updated",
    };
  }

  /**
   * Operates on a tag as an object, across the whole library.
   *
   * The existing tag path only ever put tags on items or took them off. A
   * *tag* — the thing in the tag selector — could not be renamed, deleted,
   * merged or coloured, so fixing a typo in a tag used by 500 papers meant
   * 500 removals and 500 additions.
   */
  async updateLibraryTag(params: {
    libraryID: number;
    action: "rename" | "delete" | "merge" | "setColor";
    tag: string;
    newTag?: string;
    color?: string;
    position?: number;
  }): Promise<{
    action: string;
    tag: string;
    newTag?: string;
    destinationExisted?: boolean;
    status: "applied" | "not_found" | "error";
    itemCount?: number;
    reason?: string;
  }> {
    const tags = (
      Zotero as unknown as {
        Tags?: {
          getID?: (name: string) => number | false;
          getTagItems?: (libraryID: number, tagID: number) => Promise<number[]>;
          rename?: (
            libraryID: number,
            oldName: string,
            newName: string,
          ) => Promise<void>;
          removeFromLibrary?: (
            libraryID: number,
            tagIDs: number[],
          ) => Promise<void>;
          setColor?: (
            libraryID: number,
            name: string,
            color: string,
            position: number,
          ) => Promise<void>;
        };
      }
    ).Tags;
    if (!tags?.getID) {
      return {
        action: params.action,
        tag: params.tag,
        status: "error",
        reason: "Zotero.Tags is not available in this build",
      };
    }

    const tagId = tags.getID(params.tag);
    if (params.action !== "setColor" && (tagId === false || !tagId)) {
      return {
        action: params.action,
        tag: params.tag,
        status: "not_found",
        reason: `No tag named "${params.tag}" exists in this library`,
      };
    }

    let itemCount: number | undefined;
    try {
      if (tagId) {
        itemCount = (await tags.getTagItems?.(params.libraryID, tagId))?.length;
      }
    } catch {
      // A count is nice to report but must not block the operation.
    }

    try {
      switch (params.action) {
        case "rename":
        case "merge": {
          const newTag = params.newTag?.trim();
          if (!newTag) {
            return {
              action: params.action,
              tag: params.tag,
              status: "error",
              reason: `"${params.action}" needs newTag`,
            };
          }
          // Zotero implements rename-to-an-existing-name as a merge. Capture
          // that fact before the write so callers never advertise a lossy
          // rename as fully reversible.
          const destinationTagId = tags.getID(newTag);
          let destinationExisted = Boolean(destinationTagId);
          if (destinationTagId && tags.getTagItems) {
            try {
              destinationExisted =
                (await tags.getTagItems(params.libraryID, destinationTagId))
                  .length > 0;
            } catch {
              // A failed membership read must remain conservative.
              destinationExisted = true;
            }
          }
          // Zotero's rename merges when the destination already exists, so
          // rename and merge are the same call -- the distinction is only
          // what the user is told on the card.
          await tags.rename?.(params.libraryID, params.tag, newTag);
          return {
            action: params.action,
            tag: params.tag,
            newTag,
            destinationExisted,
            status: "applied",
            itemCount,
          };
        }
        case "delete": {
          await tags.removeFromLibrary?.(params.libraryID, [tagId as number]);
          return {
            action: params.action,
            tag: params.tag,
            status: "applied",
            itemCount,
          };
        }
        case "setColor": {
          const color = params.color?.trim();
          if (!color) {
            return {
              action: params.action,
              tag: params.tag,
              status: "error",
              reason: '"setColor" needs a color, e.g. "#FF6666"',
            };
          }
          await tags.setColor?.(
            params.libraryID,
            params.tag,
            color,
            Number.isFinite(params.position) ? Number(params.position) : 0,
          );
          return {
            action: params.action,
            tag: params.tag,
            status: "applied",
            itemCount,
          };
        }
      }
    } catch (error) {
      return {
        action: params.action,
        tag: params.tag,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      action: params.action,
      tag: params.tag,
      status: "error",
      reason: `Unknown tag action "${params.action}"`,
    };
  }

  /**
   * Sets an item's tags to exactly the given list.
   *
   * The existing path is add-only, which is why "give my library exactly
   * these 20 tags" drifted: each batch added its own tags and nothing ever
   * removed the ones a previous batch had chosen. Replacing the set is what
   * that request actually means.
   */
  async setItemTags(params: {
    assignments: Array<{ itemId: number; tags: string[] }>;
  }): Promise<{
    changedCount: number;
    items: Array<{
      itemId: number;
      title: string;
      status: "updated" | "skipped" | "error";
      previousTags?: string[];
      reason?: string;
    }>;
  }> {
    const results: Array<{
      itemId: number;
      title: string;
      status: "updated" | "skipped" | "error";
      previousTags?: string[];
      reason?: string;
    }> = [];
    let changedCount = 0;

    for (const assignment of params.assignments) {
      const rawItem = this.getItem(assignment.itemId);
      const resolution = resolveMatrixItem(
        rawItem,
        assignment.itemId,
        "update",
      );
      if ("refusal" in resolution) {
        results.push({
          itemId: assignment.itemId,
          title: rawItem
            ? normalizeText(rawItem.getDisplayTitle?.()) ||
              `Item ${assignment.itemId}`
            : `Item ${assignment.itemId}`,
          status: "error",
          reason: resolution.refusal,
        });
        continue;
      }
      const item = resolution.item;
      const title =
        normalizeText(item.getDisplayTitle?.()) || `Item ${item.id}`;
      const previousTags = (item.getTags?.() || []).map((entry) =>
        String(entry.tag),
      );
      const nextTags = Array.from(new Set(assignment.tags || []))
        .map((tag) => String(tag).trim())
        .filter(Boolean);

      const unchanged =
        previousTags.length === nextTags.length &&
        previousTags.every((tag) => nextTags.includes(tag));
      if (unchanged) {
        results.push({
          itemId: Number(item.id),
          title,
          status: "skipped",
          previousTags,
        });
        continue;
      }

      try {
        item.setTags(nextTags);
        await item.saveTx();
        changedCount += 1;
        results.push({
          itemId: Number(item.id),
          title,
          status: "updated",
          // The prior set is the only thing an inverse can restore.
          previousTags,
        });
      } catch (error) {
        results.push({
          itemId: Number(item.id),
          title,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { changedCount, items: results };
  }

  /**
   * Lists saved searches and the conditions behind them.
   *
   * Saved searches were entirely invisible: the matrix declared CRUD allowed
   * and nothing implemented any of it, and no query path enumerated them.
   */
  listSavedSearches(libraryID: number): Array<{
    savedSearchId: number;
    name: string;
    conditions: Array<{ condition: string; operator: string; value: string }>;
  }> {
    const searches = (
      Zotero as unknown as {
        Searches?: {
          getByLibrary?: (libraryID: number) => Array<{
            id: number;
            name: string;
            getConditions?: () => Record<
              string,
              { condition: string; operator: string; value: string }
            >;
          }>;
        };
      }
    ).Searches;
    try {
      return (searches?.getByLibrary?.(libraryID) || []).map((search) => ({
        savedSearchId: Number(search.id),
        name: normalizeText(search.name),
        conditions: Object.values(search.getConditions?.() || {}).map(
          (entry) => ({
            condition: String(entry.condition || ""),
            operator: String(entry.operator || ""),
            value: String(entry.value ?? ""),
          }),
        ),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Creates or replaces a saved search from a condition set.
   *
   * A saved search *is* a set of conditions, which is why this had to wait
   * for the condition vocabulary: without it there was nothing to save.
   */
  async saveSavedSearch(params: {
    libraryID: number;
    name: string;
    conditions: AgentSearchCondition[];
    joinMode?: "all" | "any";
    savedSearchId?: number;
  }): Promise<{
    savedSearchId: number;
    name: string;
    status: "created" | "updated";
  }> {
    const errors = validateSearchConditions(params.conditions);
    if (errors.length) {
      const detail = errors
        .map((error) =>
          error.validOperators?.length
            ? `${error.reason}. Valid operators: ${error.validOperators.join(", ")}`
            : error.reason,
        )
        .join("; ");
      throw new Error(`Invalid search conditions: ${detail}`);
    }

    const existing = params.savedSearchId
      ? (
          Zotero as unknown as {
            Searches?: { get?: (id: number) => unknown };
          }
        ).Searches?.get?.(params.savedSearchId)
      : null;

    const search = (existing ||
      new (Zotero as unknown as { Search: new () => unknown }).Search()) as {
      id?: number;
      libraryID: number;
      name: string;
      addCondition: (
        condition: string,
        operator: string,
        value?: string | number,
        required?: boolean,
      ) => void;
      removeCondition: (id: number) => void;
      getConditions?: () => Record<string, unknown>;
      saveTx: () => Promise<unknown>;
    };

    search.libraryID = params.libraryID;
    search.name = params.name;
    // Replace rather than append: updating a saved search means the
    // conditions given, not those plus whatever was there before.
    for (const conditionId of Object.keys(search.getConditions?.() || {})) {
      try {
        search.removeCondition(Number(conditionId));
      } catch {
        // A condition that will not come off must not block the save.
      }
    }
    if (params.joinMode) {
      search.addCondition("joinMode", params.joinMode, "");
    }
    for (const entry of params.conditions) {
      search.addCondition(
        entry.mode ? `${entry.condition}/${entry.mode}` : entry.condition,
        entry.operator,
        entry.value === undefined ? "" : entry.value,
        entry.required,
      );
    }
    await search.saveTx();
    return {
      savedSearchId: Number(search.id),
      name: params.name,
      status: existing ? "updated" : "created",
    };
  }

  /** Moves a saved search to the trash. Zotero tracks these in `deletedSearches`. */
  async deleteSavedSearch(params: {
    savedSearchId: number;
    permanent?: boolean;
  }): Promise<{
    savedSearchId: number;
    status: "trashed" | "erased" | "not_found";
  }> {
    const search = (
      Zotero as unknown as {
        Searches?: {
          get?: (id: number) =>
            | (Zotero.Search & {
                deleted?: boolean;
                eraseTx?: () => Promise<void>;
                saveTx?: () => Promise<unknown>;
              })
            | null;
        };
      }
    ).Searches?.get?.(params.savedSearchId);
    if (!search) {
      return { savedSearchId: params.savedSearchId, status: "not_found" };
    }
    if (params.permanent) {
      await search.eraseTx?.();
      return { savedSearchId: params.savedSearchId, status: "erased" };
    }
    (search as unknown as { deleted: boolean }).deleted = true;
    await search.saveTx?.();
    return { savedSearchId: params.savedSearchId, status: "trashed" };
  }

  /** Reads the preferences the agent is allowed to see. */
  listSettings(): Array<{
    key: string;
    value: unknown;
    type: string;
    description: string;
  }> {
    const prefs = (
      Zotero as unknown as { Prefs?: { get?: (key: string) => unknown } }
    ).Prefs;
    return Object.entries(AGENT_WRITABLE_PREFS).map(([key, spec]) => {
      let value: unknown = undefined;
      try {
        value = prefs?.get?.(key);
      } catch {
        // An unset pref reads as undefined rather than failing the listing.
      }
      return { key, value, type: spec.type, description: spec.description };
    });
  }

  getSettingNativeState(key: string): { exists: boolean; value: unknown } {
    const setting = this.listSettings().find((entry) => entry.key === key);
    return setting
      ? { exists: true, value: setting.value }
      : { exists: false, value: undefined };
  }

  /** Restore an allowlisted preference without applying user-input coercion. */
  restoreSetting(params: {
    key: string;
    existed: boolean;
    value?: unknown;
  }): void {
    if (!AGENT_WRITABLE_PREFS[params.key]) {
      throw new Error(`Preference "${params.key}" is not agent-writable`);
    }
    const prefs = (
      Zotero as unknown as {
        Prefs?: {
          set?: (key: string, value: unknown) => void;
          clear?: (key: string) => void;
        };
      }
    ).Prefs;
    if (params.existed) {
      if (typeof prefs?.set !== "function") {
        throw new Error("Zotero.Prefs.set is unavailable");
      }
      prefs.set(params.key, params.value);
      return;
    }
    if (typeof prefs?.clear !== "function") {
      throw new Error(
        "Zotero.Prefs.clear is unavailable; an originally unset preference cannot be restored safely",
      );
    }
    prefs.clear(params.key);
  }

  /**
   * Writes one allowlisted preference.
   *
   * Anything outside the allowlist is refused by name. `Zotero.Prefs` also
   * holds sync credentials, the data directory and proxy settings, and an
   * agent that can rewrite those can lock a user out of their own library.
   */
  async updateSetting(params: { key: string; value: unknown }): Promise<{
    key: string;
    previousValue: unknown;
    value: unknown;
    status: "updated" | "unchanged" | "refused";
    reason?: string;
  }> {
    const spec = AGENT_WRITABLE_PREFS[params.key];
    if (!spec) {
      return {
        key: params.key,
        previousValue: undefined,
        value: params.value,
        status: "refused",
        reason: `"${params.key}" is not a preference the agent may change. The ones it may are listed by library_settings with action:'list'.`,
      };
    }
    const prefs = (
      Zotero as unknown as {
        Prefs?: {
          get?: (key: string) => unknown;
          set?: (key: string, value: unknown) => void;
        };
      }
    ).Prefs;
    if (!prefs?.set) {
      return {
        key: params.key,
        previousValue: undefined,
        value: params.value,
        status: "refused",
        reason: "Zotero.Prefs is not available in this build",
      };
    }

    let coerced: unknown = params.value;
    if (spec.type === "boolean") coerced = Boolean(params.value);
    else if (spec.type === "number") {
      const numeric = Number(params.value);
      if (!Number.isFinite(numeric)) {
        return {
          key: params.key,
          previousValue: prefs.get?.(params.key),
          value: params.value,
          status: "refused",
          reason: `"${params.key}" expects a number`,
        };
      }
      coerced = numeric;
    } else coerced = String(params.value ?? "");

    const previousValue = prefs.get?.(params.key);
    if (previousValue === coerced) {
      return {
        key: params.key,
        previousValue,
        value: coerced,
        status: "unchanged",
      };
    }
    prefs.set(params.key, coerced);
    return {
      key: params.key,
      previousValue,
      value: coerced,
      status: "updated",
    };
  }

  /** Sync state, and a way to start one. */
  getSyncStatus(): {
    configured: boolean;
    username?: string;
    lastSyncAt?: number;
    inProgress: boolean;
  } {
    const sync = Zotero as unknown as {
      Sync?: {
        Runner?: { syncInProgress?: boolean; lastSyncStatus?: string };
      };
      Users?: { getCurrentUsername?: () => string };
      Prefs?: { get?: (key: string) => unknown };
    };
    let username: string | undefined;
    try {
      username = sync.Users?.getCurrentUsername?.() || undefined;
    } catch {
      username = undefined;
    }
    return {
      configured: Boolean(username),
      username,
      inProgress: Boolean(sync.Sync?.Runner?.syncInProgress),
    };
  }

  /** The export formats Zotero can write. */
  listExportFormats(): Array<{ id: string; label: string }> {
    const translators = (
      Zotero as unknown as {
        Translators?: {
          getAllForType?: (
            type: string,
          ) => Promise<Array<{ translatorID: string; label: string }>>;
        };
      }
    ).Translators;
    void translators;
    // Deliberately synchronous and static: the async translator listing is a
    // separate call shape, and these are the formats users actually name.
    return [
      { id: "14763d24-8ba0-45df-8f52-b8d1108e7ac9", label: "BibTeX" },
      { id: "9cb70025-a888-4a29-a210-93ec52da40d4", label: "BibLaTeX" },
      { id: "32d59d2d-b65a-4da4-b0a3-bdd3cfb979e7", label: "RIS" },
      { id: "bc03b4fe-436d-4a1f-ba59-de4d2d7a63f7", label: "CSL JSON" },
      { id: "14763d25-8ba0-45df-8f52-b8d1108e7ac9", label: "Zotero RDF" },
      { id: "b8f9f5e6-b6a9-4b0e-a3f0-9e29ff9e14cf", label: "Simple Evernote" },
    ];
  }

  /**
   * Exports items through a Zotero translator.
   *
   * All export was unreachable: the census found the whole domain at zero
   * covered operations, so "give me these as BibTeX" had no path.
   */
  async exportItems(params: {
    itemIds: number[];
    translatorId: string;
  }): Promise<{ output: string; itemCount: number }> {
    const TranslateExport = (
      Zotero as unknown as {
        Translate?: { Export?: new () => unknown };
      }
    ).Translate?.Export;
    if (!TranslateExport) {
      throw new Error("Zotero.Translate.Export is not available in this build");
    }
    const items = params.itemIds
      .map((itemId) => this.getItem(itemId))
      .filter((item): item is Zotero.Item => Boolean(item));
    if (!items.length) {
      throw new Error("None of those item IDs resolved to an item.");
    }

    const translation = new TranslateExport() as {
      setItems: (items: unknown[]) => void;
      setTranslator: (id: string) => void;
      setHandler: (
        event: string,
        handler: (...args: unknown[]) => void,
      ) => void;
      translate: () => void;
      string?: string;
    };
    translation.setItems(items);
    translation.setTranslator(params.translatorId);

    return new Promise((resolve, reject) => {
      translation.setHandler("done", (_obj: unknown, worked: unknown) => {
        if (!worked) {
          reject(
            new Error(
              `Zotero could not export with translator ${params.translatorId}.`,
            ),
          );
          return;
        }
        resolve({
          output: String(translation.string || ""),
          itemCount: items.length,
        });
      });
      try {
        translation.translate();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** The citation styles installed in Zotero. */
  listCitationStyles(): Array<{ id: string; title: string }> {
    const styles = (
      Zotero as unknown as {
        Styles?: {
          getVisible?: () => Array<{ styleID: string; title: string }>;
          getAll?: () => Record<string, { styleID: string; title: string }>;
        };
      }
    ).Styles;
    try {
      const visible = styles?.getVisible?.();
      if (visible?.length) {
        return visible.map((style) => ({
          id: String(style.styleID),
          title: normalizeText(style.title),
        }));
      }
      return Object.values(styles?.getAll?.() || {}).map((style) => ({
        id: String(style.styleID),
        title: normalizeText(style.title),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Formats citations or a bibliography through Zotero's own CSL engine.
   *
   * The most dangerous everyday gap in the whole census: asked for "the APA
   * reference for this paper" the agent had no tool at all, so it produced a
   * plausible-looking citation from memory. A fabricated reference is worse
   * than a refusal in a reference manager, and it is the one thing this
   * product exists to get right.
   */
  formatBibliography(params: {
    itemIds: number[];
    styleId?: string;
    locale?: string;
    format?: "text" | "html";
    mode?: "bibliography" | "citation";
  }): {
    styleId: string;
    styleTitle: string;
    output: string;
    format: "text" | "html";
    itemCount: number;
  } {
    const Styles = (
      Zotero as unknown as {
        Styles?: {
          get?: (id: string) => unknown;
          getVisible?: () => Array<{ styleID: string; title: string }>;
        };
      }
    ).Styles;
    const Cite = (
      Zotero as unknown as {
        Cite?: {
          makeFormattedBibliographyOrCitationList?: (
            engine: unknown,
            items: unknown[],
            format: string,
          ) => string;
        };
      }
    ).Cite;
    if (!Styles?.get || !Cite?.makeFormattedBibliographyOrCitationList) {
      throw new Error(
        "Zotero's citation engine is not available in this build, so a citation cannot be formatted. Do not write one from memory.",
      );
    }

    const styleId =
      params.styleId ||
      String(
        (
          Zotero as unknown as {
            Prefs?: { get?: (key: string) => unknown };
          }
        ).Prefs?.get?.("export.quickCopy.setting") || "",
      ).replace(/^bibliography(?:\/[^/]*)?=/, "") ||
      "http://www.zotero.org/styles/apa";

    const style = Styles.get(styleId) as {
      title?: string;
      getCiteProc?: (
        locale: string,
        format: string,
        options?: { cache?: boolean },
      ) => {
        free?: () => void;
        updateItems?: (ids: number[]) => void;
        previewCitationCluster?: (
          citation: unknown,
          a: unknown[],
          b: unknown[],
          format: string,
        ) => string;
      };
    } | null;
    if (!style?.getCiteProc) {
      throw new Error(
        `Citation style "${styleId}" is not installed. List the available ones with library_search({ entity:'citationStyles', mode:'list' }).`,
      );
    }

    const items = params.itemIds
      .map((itemId) => this.getItem(itemId))
      .filter((item): item is Zotero.Item => Boolean(item))
      .filter((item) => !item.isNote?.());
    if (!items.length) {
      throw new Error("None of those item IDs resolved to a citable item.");
    }

    const outputFormat = params.format === "html" ? "html" : "text";
    const locale = params.locale || "en-US";
    const engine = style.getCiteProc(locale, outputFormat, { cache: true });
    try {
      if (params.mode === "citation") {
        engine.updateItems?.(items.map((item) => Number(item.id)));
        const output =
          engine.previewCitationCluster?.(
            {
              citationItems: items.map((item) => ({ id: item.id })),
              properties: {},
            },
            [],
            [],
            outputFormat,
          ) || "";
        return {
          styleId,
          styleTitle: normalizeText(style.title) || styleId,
          output,
          format: outputFormat,
          itemCount: items.length,
        };
      }
      const output =
        Cite.makeFormattedBibliographyOrCitationList(
          engine,
          items,
          outputFormat,
        ) || "";
      return {
        styleId,
        styleTitle: normalizeText(style.title) || styleId,
        output,
        format: outputFormat,
        itemCount: items.length,
      };
    } finally {
      engine.free?.();
    }
  }

  async deleteCollection(params: {
    collectionId: number;
    deleteItems?: boolean;
    permanent?: boolean;
  }): Promise<void> {
    const collection = this.getCollection(params.collectionId);
    if (!collection) return;
    const libraryID = Number(collection.libraryID) || 0;
    if (params.permanent) {
      await (
        collection as unknown as {
          eraseTx: (options?: { deleteItems?: boolean }) => Promise<void>;
        }
      ).eraseTx({ deleteItems: !!params.deleteItems });
    } else {
      (collection as unknown as { deleted: boolean }).deleted = true;
      await (
        collection as unknown as {
          saveTx: (options?: { deleteItems?: boolean }) => Promise<unknown>;
        }
      ).saveTx({ deleteItems: !!params.deleteItems });
    }
  }

  /**
   * Brings collections back out of the trash.
   *
   * Descendants are restored alongside their parent, mirroring both what
   * `trash()` took down and what Zotero's own "Restore to Library" does
   * (`zoteroPane.js` restores `getDescendents(false, 'collection', true)`).
   * Without that, restoring a parent would leave its subtree stranded in the
   * trash.
   */
  async restoreCollections(params: {
    collectionIds: number[];
  }): Promise<{ restoredCount: number; collectionIds: number[] }> {
    const seen = new Set<number>();
    const restored: number[] = [];
    for (const collectionId of params.collectionIds) {
      const collection = this.getCollection(collectionId) as
        | (Zotero.Collection & {
            deleted?: boolean;
            getDescendents?: (
              nested: boolean,
              type: "collection" | "item" | null,
              includeDeletedItems?: boolean,
            ) => Array<{ id: number; type: string }>;
          })
        | null;
      if (!collection) continue;
      const targets: Array<Zotero.Collection & { deleted?: boolean }> = [
        collection,
      ];
      try {
        for (const descendent of collection.getDescendents?.(
          false,
          "collection",
          true,
        ) || []) {
          const child = this.getCollection(descendent.id) as
            | (Zotero.Collection & { deleted?: boolean })
            | null;
          if (child) targets.push(child);
        }
      } catch {
        // A missing descendant must not block restoring the parent.
      }
      for (const target of targets) {
        const id = Number(target.id);
        if (seen.has(id)) continue;
        seen.add(id);
        if (!target.deleted) continue;
        target.deleted = false;
        await (
          target as unknown as { saveTx: () => Promise<unknown> }
        ).saveTx();
        restored.push(id);
      }
    }
    return { restoredCount: restored.length, collectionIds: restored };
  }

  /**
   * Removes tags and reports which ones were actually on the item.
   *
   * It used to return `void`, and the caller derived its count from the
   * paper-target map — which `buildPaperTargetFromItem` gates on having a PDF
   * child. So removing a tag from a book worked, reported `removedCount: 0`,
   * and recorded no undo. Once `effect` started reading that count, the same
   * stale zero also told the user nothing had changed.
   */
  async removeTagsFromItem(params: {
    itemId: number;
    tags: string[];
  }): Promise<{ removed: string[] }> {
    // Tags live on the item itself — including notes and standalone
    // attachments, which the regular-item filter used to exclude — so this
    // resolves through the capability matrix rather than the paper map.
    const raw = this.getItem(params.itemId);
    const resolution = resolveMatrixItem(raw, params.itemId, "update");
    const item = "item" in resolution ? resolution.item : null;
    if (!item || !params.tags.length) return { removed: [] };
    const removed: string[] = [];
    for (const tag of params.tags) {
      if (!tag) continue;
      if (item.hasTag?.(tag)) {
        item.removeTag?.(tag);
        removed.push(tag);
      }
    }
    if (removed.length) {
      await item.saveTx();
    }
    return { removed };
  }

  /**
   * Returns whether the item was actually removed. It used to return `void`
   * and bail silently on an unresolvable item, while the caller counted every
   * requested id as removed — so a request to unfile ten notes reported
   * "removedCount: 10" having done nothing at all.
   */
  /**
   * Reads an item's real collection membership.
   *
   * The read path used to take this from the paper-target map, which is built
   * by `buildPaperTargetFromItem` and returns `null` for any item without a
   * PDF child — so a book sitting in three collections reported none, and a
   * note reported nothing at all. That is the channel an agent uses to verify
   * a filing operation, so it silently failed exactly where it mattered.
   */
  getItemCollectionIds(itemId: number): number[] {
    const item = this.getItem(itemId);
    if (!item) return [];
    try {
      const ids = (
        item as unknown as { getCollections?: () => number[] }
      ).getCollections?.();
      return Array.isArray(ids)
        ? ids.filter((id) => Number.isFinite(id) && id > 0)
        : [];
    } catch {
      return [];
    }
  }

  async removeItemFromCollection(params: {
    itemId: number;
    collectionId: number;
  }): Promise<{ removed: boolean; reason?: string }> {
    const resolution = resolveMatrixItem(
      this.getItem(params.itemId),
      params.itemId,
      "removeFromCollection",
    );
    if (!("item" in resolution)) {
      return { removed: false, reason: resolution.refusal };
    }
    const item = resolution.item;
    if (!item.inCollection?.(params.collectionId)) {
      return {
        removed: false,
        reason: "The item was not in that collection",
      };
    }
    item.removeFromCollection(params.collectionId);
    await item.saveTx();
    const collection = this.getCollection(params.collectionId);
    return { removed: true };
  }

  async findRelatedPapersInLibrary(params: {
    libraryID: number;
    referenceItemId: number;
    limit?: number;
  }): Promise<{
    referenceTitle: string;
    relatedPapers: RelatedPaperResult[];
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const referenceItem = this.resolveBibliographicItem(
      this.getItem(params.referenceItemId),
    );
    if (!referenceItem) throw new Error("Reference paper not found");
    const referenceTarget = buildPaperTargetFromItem(referenceItem);
    if (!referenceTarget)
      throw new Error("Reference paper has no PDF attachment");
    const limit =
      Number.isFinite(params.limit) && (params.limit as number) > 0
        ? Math.floor(params.limit as number)
        : 10;
    const refTitle = normalizeText(referenceTarget.title).toLowerCase();
    const refTitleWords = new Set(
      refTitle.split(/\W+/).filter((w) => w.length > 3),
    );
    const refAuthor = normalizeText(
      referenceTarget.firstCreator || "",
    ).toLowerCase();
    const refYear = referenceTarget.year ? Number(referenceTarget.year) : null;
    const refJournal = normalizeText(
      String(referenceItem.getField?.("publicationTitle") ?? ""),
    ).toLowerCase();
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const scored: RelatedPaperResult[] = [];
    for (const candidateId of orderedGatewayPaperIds(snapshot)) {
      if (candidateId === referenceTarget.itemId) continue;
      const item = this.resolveBibliographicItem(this.getItem(candidateId));
      if (!item) continue;
      const target = buildPaperTargetFromItem(item);
      if (!target) continue;
      let score = 0;
      const reasons: string[] = [];
      const candAuthor = normalizeText(target.firstCreator || "").toLowerCase();
      if (refAuthor && candAuthor && refAuthor === candAuthor) {
        score += 40;
        reasons.push(`Same first author: ${target.firstCreator}`);
      }
      const candTitle = normalizeText(target.title).toLowerCase();
      const candTitleWords = new Set(
        candTitle.split(/\W+/).filter((w) => w.length > 3),
      );
      const sharedWords = [...refTitleWords].filter((w) =>
        candTitleWords.has(w),
      );
      if (sharedWords.length >= 2) {
        score += Math.min(sharedWords.length * 8, 30);
        reasons.push(
          `Shared title keywords: ${sharedWords.slice(0, 3).join(", ")}`,
        );
      }
      const candJournal = normalizeText(
        String(item.getField?.("publicationTitle") ?? ""),
      ).toLowerCase();
      if (refJournal && candJournal && refJournal === candJournal) {
        score += 15;
        reasons.push(`Same journal: ${item.getField?.("publicationTitle")}`);
      }
      const candYear = target.year ? Number(target.year) : null;
      if (refYear && candYear && Math.abs(refYear - candYear) <= 3) {
        score += 5;
      }
      const sharedTags = referenceTarget.tags.filter((t) =>
        target.tags.includes(t),
      );
      if (sharedTags.length > 0) {
        score += sharedTags.length * 5;
        reasons.push(`Shared tags: ${sharedTags.slice(0, 3).join(", ")}`);
      }
      if (score > 0) {
        scored.push({ ...target, matchScore: score, matchReasons: reasons });
      }
    }
    scored.sort((a, b) => b.matchScore - a.matchScore);
    return {
      referenceTitle: referenceTarget.title,
      relatedPapers: scored.slice(0, limit),
    };
  }

  async detectDuplicatesInLibrary(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    totalGroups: number;
    groups: DuplicateGroup[];
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const limit =
      Number.isFinite(params.limit) && (params.limit as number) > 0
        ? Math.floor(params.limit as number)
        : 20;
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const byDoi = new Map<string, LibraryPaperTarget[]>();
    const byNormalizedTitle = new Map<string, LibraryPaperTarget[]>();
    for (const candidateId of orderedGatewayPaperIds(snapshot)) {
      const item = this.resolveBibliographicItem(this.getItem(candidateId));
      if (!item) continue;
      const target = buildPaperTargetFromItem(item);
      if (!target) continue;
      const doi = normalizeText(
        String(item.getField?.("DOI") ?? ""),
      ).toLowerCase();
      if (doi) {
        const existing = byDoi.get(doi) || [];
        existing.push(target);
        byDoi.set(doi, existing);
      }
      const normalizedTitle = normalizeText(target.title)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (normalizedTitle.length > 10) {
        const existing = byNormalizedTitle.get(normalizedTitle) || [];
        existing.push(target);
        byNormalizedTitle.set(normalizedTitle, existing);
      }
    }
    const groups: DuplicateGroup[] = [];
    const seenItemIds = new Set<number>();
    for (const [doi, papers] of byDoi) {
      if (papers.length < 2) continue;
      if (groups.length >= limit) break;
      const newPapers = papers.filter((p) => !seenItemIds.has(p.itemId));
      if (newPapers.length < 2) continue;
      groups.push({ matchReason: `Same DOI: ${doi}`, papers: newPapers });
      for (const p of newPapers) seenItemIds.add(p.itemId);
    }
    for (const [, papers] of byNormalizedTitle) {
      if (papers.length < 2) continue;
      if (groups.length >= limit) break;
      const newPapers = papers.filter((p) => !seenItemIds.has(p.itemId));
      if (newPapers.length < 2) continue;
      groups.push({ matchReason: "Same title", papers: newPapers });
      for (const p of newPapers) seenItemIds.add(p.itemId);
    }
    return { totalGroups: groups.length, groups };
  }

  async updateArticleMetadata(params: {
    item: Zotero.Item | null;
    metadata: EditableArticleMetadataPatch;
  }): Promise<{
    status: "updated";
    itemId: number;
    title: string;
    changedFields: string[];
  }> {
    // resolveRegularItem silently substitutes the PARENT for a child
    // attachment, so writing metadata on an attachment edited a different
    // object and then read the parent back as confirmation -- a self-verifying
    // false success. The matrix answers per kind instead.
    const resolution = resolveMatrixItem(
      params.item,
      Number(params.item?.id) || 0,
      "update",
    );
    if ("refusal" in resolution) throw new Error(resolution.refusal);
    const item = resolution.item;

    // Every key in the patch is a candidate now. The 18-name allowlist was
    // never the real schema -- Zotero's own field table is -- and it silently
    // dropped anything outside it, so "set the publisher on this book"
    // reported success with nothing written.
    const fieldNames = Object.keys(params.metadata).filter(
      (fieldName) => fieldName !== "creators",
    );
    const unsupportedFields = fieldNames.filter(
      (fieldName) => !isFieldValidForItemType(item, fieldName),
    );
    if (unsupportedFields.length) {
      const itemTypeName = getItemTypeName(item) || "this item type";
      const available = listEditableFieldsForItem(item);
      throw new Error(
        `Unsupported metadata fields for ${itemTypeName}: ${unsupportedFields.join(", ")}.` +
          (available.length
            ? ` Fields this item type accepts: ${available.join(", ")}.`
            : ""),
      );
    }

    const rejectedFields: string[] = [];
    for (const fieldName of fieldNames) {
      const value =
        (params.metadata as Record<string, unknown>)[fieldName] ?? "";
      // setField returns false rather than throwing for a value it cannot
      // parse -- `accessDate: "yesterday"` is the common case -- and the old
      // code ignored that and reported success anyway.
      // The bundled typings declare setField as void; Zotero returns a
      // boolean (item.js:653), false meaning the value was not taken.
      const accepted = (
        item as unknown as {
          setField: (field: string, value: string) => boolean | void;
        }
      ).setField(fieldName, String(value));
      if (accepted === false && String(value).trim()) {
        const before = normalizeText(item.getField?.(fieldName));
        if (before !== String(value).trim()) rejectedFields.push(fieldName);
      }
    }
    if (rejectedFields.length) {
      throw new Error(
        `Zotero rejected these values: ${rejectedFields.join(", ")}. Check the format — dates must be real dates, not phrases like "yesterday".`,
      );
    }

    if (Array.isArray(params.metadata.creators)) {
      const creatorTypes = (
        Zotero as unknown as {
          CreatorTypes?: {
            itemTypeHasCreators?: (itemTypeId: number) => boolean;
          };
        }
      ).CreatorTypes;
      const supportsCreators =
        typeof creatorTypes?.itemTypeHasCreators === "function"
          ? creatorTypes.itemTypeHasCreators(item.itemTypeID)
          : true;
      if (!supportsCreators) {
        const itemTypeName = getItemTypeName(item) || "this item type";
        throw new Error(`Creators are not supported for ${itemTypeName}`);
      }
      item.setCreators(
        params.metadata.creators as Array<
          _ZoteroTypes.Item.CreatorJSON | _ZoteroTypes.Item.Creator
        >,
        { strict: true },
      );
    }

    await item.saveTx();
    const changedFields = [
      ...fieldNames,
      ...(Array.isArray(params.metadata.creators) ? ["creators"] : []),
    ];
    const snapshot = this.getEditableArticleMetadata(item);
    return {
      status: "updated",
      itemId: item.id,
      title: snapshot?.title || `Item ${item.id}`,
      changedFields,
    };
  }

  async trashItems(params: { itemIds: number[] }): Promise<{
    trashedCount: number;
    items: Array<{
      itemId: number;
      title: string;
      status: "trashed" | "skipped" | "error";
      reason?: string;
    }>;
  }> {
    const items: Array<{
      itemId: number;
      title: string;
      status: "trashed" | "skipped" | "error";
      reason?: string;
    }> = [];
    let trashedCount = 0;
    for (const itemId of params.itemIds) {
      const item = this.getItem(itemId);
      if (!item) {
        items.push({
          itemId,
          title: `Item ${itemId}`,
          status: "skipped",
          reason: "Item not found",
        });
        continue;
      }
      const title = String(item.getField?.("title") || `Item ${itemId}`);
      if (item.deleted) {
        items.push({
          itemId,
          title,
          status: "skipped",
          reason: "Already in trash",
        });
        continue;
      }
      try {
        item.deleted = true;
        await item.saveTx();
        trashedCount++;
        items.push({ itemId, title, status: "trashed" });
      } catch (error) {
        items.push({
          itemId,
          title,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { trashedCount, items };
  }

  /**
   * Brings items back out of the trash.
   *
   * Reports which ids it actually restored, rather than `void`: an item that
   * was never trashed is skipped, so a caller that assumed every requested id
   * came back would build an inverse that re-trashes items this call never
   * touched.
   */
  async restoreItems(params: {
    itemIds: number[];
  }): Promise<{ restoredCount: number; itemIds: number[] }> {
    const restored: number[] = [];
    for (const itemId of params.itemIds) {
      const item = this.getItem(itemId);
      if (!item || !item.deleted) continue;
      item.deleted = false;
      await item.saveTx();
      restored.push(Number(item.id));
    }
    return { restoredCount: restored.length, itemIds: restored };
  }

  /**
   * Brings saved searches back out of the trash. Zotero tracks these in
   * `deletedSearches`, exactly as it does collections.
   */
  async restoreSavedSearches(params: {
    savedSearchIds: number[];
  }): Promise<{ restoredCount: number; savedSearchIds: number[] }> {
    const restored: number[] = [];
    for (const savedSearchId of params.savedSearchIds) {
      const search = (
        Zotero.Searches as unknown as {
          get?: (id: number) => (Zotero.Search & { deleted?: boolean }) | null;
        }
      ).get?.(savedSearchId);
      if (!search || !search.deleted) continue;
      (search as unknown as { deleted: boolean }).deleted = false;
      await (search as unknown as { saveTx: () => Promise<unknown> }).saveTx();
      restored.push(savedSearchId);
    }
    return { restoredCount: restored.length, savedSearchIds: restored };
  }

  // ── Merge duplicates ──────────────────────────────────────────────

  /**
   * Merges duplicates, delegating to Zotero's own merge.
   *
   * This used to be hand-rolled, and diverged from Zotero in ways that
   * quietly damaged the library:
   *
   * - It never wrote the `dc:replaces` relation onto the survivor.
   *   `integration.js` resolves a Word or LibreOffice citation pointing at a
   *   merged-away item *only* through that predicate, so on the next citation
   *   refresh the user got "the item could not be found in your library" and
   *   had to hand-pick a replacement for every affected citation. Zotero's
   *   own merge repoints them silently.
   * - It never deduplicated identical PDF attachments by hash, so the
   *   survivor accumulated a copy of the same file per duplicate.
   * - It never remapped old item keys inside merged note HTML
   *   (`Zotero.Notes.replaceItemKey`), leaving dead links in notes.
   * - It never took the earliest `dateAdded`.
   * - It ran outside a transaction, saving each object separately, so a
   *   failure part-way left the library half-merged.
   * - It dropped tag types, turning manual tags into automatic ones.
   *
   * Zotero's implementation does all of this inside one transaction.
   */
  async mergeItems(params: {
    masterItemId: number;
    otherItemIds: number[];
  }): Promise<{
    mergedCount: number;
    masterItemId: number;
    masterTitle: string;
    trashedIds: number[];
  }> {
    const masterItem = this.getItem(params.masterItemId);
    if (!masterItem)
      throw new Error(`Master item ${params.masterItemId} not found`);
    const masterTitle = String(
      masterItem.getField?.("title") || `Item ${params.masterItemId}`,
    );

    const others: Zotero.Item[] = [];
    for (const otherId of params.otherItemIds) {
      if (otherId === params.masterItemId) continue;
      const otherItem = this.getItem(otherId);
      if (!otherItem) continue;
      if (Number(otherItem.libraryID) !== Number(masterItem.libraryID)) {
        throw new Error(
          `Item ${otherId} is in a different library than the master item, and Zotero cannot merge across libraries.`,
        );
      }
      others.push(otherItem);
    }
    if (!others.length) {
      return {
        mergedCount: 0,
        masterItemId: params.masterItemId,
        masterTitle,
        trashedIds: [],
      };
    }

    const merge = (
      Zotero.Items as unknown as {
        merge?: (item: Zotero.Item, otherItems: Zotero.Item[]) => Promise<void>;
      }
    ).merge;
    if (typeof merge !== "function") {
      // Refuse rather than fall back to the hand-rolled path: a merge that
      // silently omits dc:replaces breaks the user's citations, and they
      // would not find out until the next time they refreshed a document.
      throw new Error(
        "This Zotero build does not expose Zotero.Items.merge, so duplicates cannot be merged safely.",
      );
    }
    await merge.call(Zotero.Items, masterItem, others);

    const trashedIds = others.map((item) => Number(item.id));
    return {
      mergedCount: trashedIds.length,
      masterItemId: params.masterItemId,
      masterTitle,
      trashedIds,
    };
  }

  // ── Attachment management ──────────────────────────────────────────

  /**
   * Delete an attachment (moves to trash).
   */
  async deleteAttachment(params: { attachmentId: number }): Promise<{
    attachmentId: number;
    title: string;
    status: "deleted" | "not_found";
  }> {
    const item = this.getItem(params.attachmentId);
    if (!item || !item.isAttachment?.()) {
      return {
        attachmentId: params.attachmentId,
        title: "",
        status: "not_found",
      };
    }
    const title = String(
      (item as unknown as { attachmentFilename?: string }).attachmentFilename ||
        item.getField?.("title") ||
        `Attachment ${params.attachmentId}`,
    );
    item.deleted = true;
    await item.saveTx();
    return { attachmentId: params.attachmentId, title, status: "deleted" };
  }

  /**
   * Rename an attachment's filename on disk.
   */
  /**
   * Renames an attachment's file on disk.
   *
   * This used to probe `Zotero.Attachments.renameAttachmentFile`, which does
   * not exist — the method lives on `Zotero.Item.prototype`. The probe was
   * therefore always false, every rename silently fell through to setting the
   * *title* field, and the result still said `status: "renamed"`. The file on
   * disk never moved.
   *
   * `updateTitle` mirrors Zotero's own behaviour: the title follows the
   * filename only when it was tracking it to begin with. `unique` means a
   * name collision produces `paper-1.pdf` rather than failing, so the actual
   * filename is read back rather than assumed.
   */
  async renameAttachment(params: {
    attachmentId: number;
    newName: string;
  }): Promise<{
    attachmentId: number;
    previousName: string;
    newName: string;
    status: "renamed" | "unchanged" | "not_found" | "no_file" | "error";
    titleUpdated?: boolean;
    reason?: string;
  }> {
    const item = this.getItem(params.attachmentId);
    if (!item || !item.isAttachment?.()) {
      return {
        attachmentId: params.attachmentId,
        previousName: "",
        newName: params.newName,
        status: "not_found",
      };
    }
    const attachment = item as unknown as {
      attachmentFilename?: string;
      attachmentLinkMode?: number;
      renameAttachmentFile?: (
        newName: string,
        options?: {
          overwrite?: boolean;
          unique?: boolean;
          updateTitle?: boolean;
          out?: { noChange?: boolean; titleUpdated?: boolean };
        },
      ) => Promise<boolean | -1 | -2>;
    };
    const previousName = String(attachment.attachmentFilename || "");

    // A linked URL has no file, so "rename" can only mean the title. Handled
    // explicitly rather than by silently falling through, which is what made
    // the old bug invisible.
    if (
      attachment.attachmentLinkMode === 3 ||
      !attachment.renameAttachmentFile
    ) {
      try {
        item.setField("title", params.newName);
        await item.saveTx();
        return {
          attachmentId: params.attachmentId,
          previousName: String(item.getField?.("title") || previousName),
          newName: params.newName,
          status: "renamed",
          titleUpdated: true,
        };
      } catch (error) {
        return {
          attachmentId: params.attachmentId,
          previousName,
          newName: params.newName,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }

    try {
      const out: { noChange?: boolean; titleUpdated?: boolean } = {};
      const outcome = await attachment.renameAttachmentFile(params.newName, {
        unique: true,
        updateTitle: true,
        out,
      });
      if (outcome === false) {
        return {
          attachmentId: params.attachmentId,
          previousName,
          newName: params.newName,
          status: "no_file",
          reason:
            "The attachment's file is missing, so there is nothing to rename. Re-link it to a file first.",
        };
      }
      if (outcome === -1) {
        return {
          attachmentId: params.attachmentId,
          previousName,
          newName: params.newName,
          status: "error",
          reason: "A file with that name already exists.",
        };
      }
      if (outcome === -2) {
        return {
          attachmentId: params.attachmentId,
          previousName,
          newName: params.newName,
          status: "error",
          reason: "Zotero could not rename the file.",
        };
      }
      // `unique` may have appended a suffix, so report what the file is
      // actually called rather than what was requested.
      const actualName = String(
        attachment.attachmentFilename || params.newName,
      );
      return {
        attachmentId: params.attachmentId,
        previousName,
        newName: actualName,
        status: out.noChange ? "unchanged" : "renamed",
        titleUpdated: !!out.titleUpdated,
      };
    } catch (error) {
      return {
        attachmentId: params.attachmentId,
        previousName,
        newName: params.newName,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Points an attachment at a different file on disk.
   *
   * This used to refuse anything that was not `linkMode === 2`, so a user
   * whose *stored* PDF had gone missing — the common case, and exactly what
   * Zotero's own "Locate File…" repairs — was told "Only linked-file
   * attachments can be re-linked". Zotero refuses only linked *URLs*.
   *
   * It also assigned `attachmentPath` directly, skipping filename
   * sanitisation, the copy-into-storage step that stored attachments need,
   * the cached file-state refresh, and the notifier event that clears the
   * missing-file emblem. Delegating to Zotero's own method gets all four.
   */
  async relinkAttachment(params: {
    attachmentId: number;
    newPath: string;
  }): Promise<{
    attachmentId: number;
    previousPath: string;
    newPath: string;
    status: "relinked" | "not_found" | "not_linked_file" | "error";
    reason?: string;
  }> {
    const item = this.getItem(params.attachmentId);
    if (!item || !item.isAttachment?.()) {
      return {
        attachmentId: params.attachmentId,
        previousPath: "",
        newPath: params.newPath,
        status: "not_found",
      };
    }
    const attachment = item as unknown as {
      attachmentLinkMode?: number;
      attachmentPath?: string;
      getFilePathAsync?: () => Promise<string | false>;
      relinkAttachmentFile?: (path: string) => Promise<boolean>;
    };
    // 3 = LINK_MODE_LINKED_URL, the only mode Zotero itself rejects.
    if (attachment.attachmentLinkMode === 3) {
      return {
        attachmentId: params.attachmentId,
        previousPath: "",
        newPath: params.newPath,
        status: "not_linked_file",
        reason:
          "This attachment is a linked URL, which has no file to re-link.",
      };
    }
    const previousPath = String((await attachment.getFilePathAsync?.()) || "");
    try {
      if (attachment.relinkAttachmentFile) {
        await attachment.relinkAttachmentFile(params.newPath);
      } else {
        attachment.attachmentPath = params.newPath;
        await item.saveTx();
      }
      return {
        attachmentId: params.attachmentId,
        previousPath,
        newPath: String(
          (await attachment.getFilePathAsync?.()) || params.newPath,
        ),
        status: "relinked",
      };
    } catch (error) {
      return {
        attachmentId: params.attachmentId,
        previousPath,
        newPath: params.newPath,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  // ── Embed image in note ──────────────────────────────────────────

  /**
   * Import an image file as an embedded note attachment and return its key.
   * The key can then be used in note HTML: <img data-attachment-key="KEY" />
   */
  async importNoteImage(
    params: NoteImageImportInput,
  ): Promise<{ key: string } | null> {
    return importNoteImageAsset(params);
  }

  // ── Import local files ──────────────────────────────────────────

  /**
   * Imports a bibliography file through Zotero's translators.
   *
   * `importLocalFiles` attached whatever it was given, so handing it a
   * `.ris` or `.bib` produced **one dead attachment row named refs.ris** and
   * reported "Imported 1 file" -- not a single reference reached the library.
   * This is the path that actually reads the file.
   */
  async importBibliographyFile(params: {
    filePath: string;
    libraryID: number;
    targetCollectionId?: number;
  }): Promise<{
    status: "imported" | "unsupported" | "error";
    itemIds: number[];
    reason?: string;
  }> {
    const TranslateImport = (
      Zotero as unknown as {
        Translate?: { Import?: new () => unknown };
      }
    ).Translate?.Import;
    if (!TranslateImport) {
      return {
        status: "error",
        itemIds: [],
        reason: "Zotero.Translate.Import is not available in this build",
      };
    }
    try {
      const translation = new TranslateImport() as {
        setLocation: (file: unknown) => void;
        getTranslators: () => Promise<unknown[]>;
        setTranslator: (translator: unknown) => void;
        translate: (options: {
          libraryID: number;
          collections: number[] | null;
        }) => Promise<Array<{ id: number }>>;
      };
      translation.setLocation(toLocalFileHandle(params.filePath));
      const translators = await translation.getTranslators();
      if (!translators.length) {
        // Distinct from an error: the file is fine, Zotero just has no
        // translator for it. Reported so the caller can fall back to
        // attaching rather than failing outright.
        return {
          status: "unsupported",
          itemIds: [],
          reason: `No Zotero translator recognises ${params.filePath}`,
        };
      }
      translation.setTranslator(translators[0]);
      const imported = await translation.translate({
        libraryID: params.libraryID,
        collections: params.targetCollectionId
          ? [params.targetCollectionId]
          : null,
      });
      const itemIds = (imported || [])
        .map((item) => Number(item?.id))
        .filter((id) => Number.isFinite(id) && id > 0);
      return { status: "imported", itemIds };
    } catch (error) {
      return {
        status: "error",
        itemIds: [],
        // Zotero rejects with a bare string, not an Error.
        reason:
          error instanceof Error
            ? error.message
            : String(error) || "Import failed",
      };
    }
  }

  /**
   * Import local files (PDFs, etc.) into the Zotero library.
   * Uses Zotero.Attachments.importFromFile to create items with attached files.
   */
  async importLocalFiles(params: {
    filePaths: string[];
    libraryID?: number;
    targetCollectionId?: number;
    /**
     * `translate` reads bibliography files (.ris, .bib, .enw, .nbib, RDF)
     * through Zotero's translators. `attach` stores the file as an
     * attachment. `auto` picks by extension, which is what a user means by
     * "import this file".
     */
    mode?: "auto" | "translate" | "attach";
    /** Run Zotero's PDF metadata recognition on imported PDFs. */
    recognize?: boolean;
  }): Promise<{
    succeeded: number;
    failed: number;
    items: Array<{
      filePath: string;
      status: "imported" | "error" | "not_found";
      itemId?: number;
      title?: string;
      reason?: string;
    }>;
  }> {
    const targetLibraryID =
      params.libraryID ??
      (Zotero as unknown as { Libraries?: { userLibraryID?: number } })
        .Libraries?.userLibraryID ??
      1;
    const targetCollection = params.targetCollectionId
      ? this.getCollection(params.targetCollectionId)
      : null;

    let succeeded = 0;
    let failed = 0;
    const items: Array<{
      filePath: string;
      status: "imported" | "error" | "not_found";
      itemId?: number;
      title?: string;
      reason?: string;
    }> = [];

    const Attachments = (Zotero as any).Attachments;

    for (const filePath of params.filePaths) {
      try {
        // Check file exists
        const fileExists = await (async () => {
          try {
            const IOUtils = (globalThis as any).IOUtils;
            if (IOUtils?.exists) return await IOUtils.exists(filePath);
            const OSFile = (globalThis as any).OS?.File;
            if (OSFile?.exists) return await OSFile.exists(filePath);
            return true; // assume exists if we can't check
          } catch {
            return false;
          }
        })();

        if (!fileExists) {
          items.push({
            filePath,
            status: "not_found",
            reason: "File not found",
          });
          failed++;
          continue;
        }

        // Create a nsIFile reference
        let nsFile: any;
        const Components = (globalThis as any).Components;
        if (Components?.classes) {
          nsFile = Components.classes[
            "@mozilla.org/file/local;1"
          ].createInstance(Components.interfaces.nsIFile);
          nsFile.initWithPath(filePath);
        }

        // Bibliography files are read, not attached. Handing a .ris to
        // importFromFile produced one dead attachment row and reported
        // success, so not a single reference reached the library.
        const isBibliography =
          /\.(ris|bib|bibtex|enw|nbib|rdf|xml|json|mods|refer|txt)$/i.test(
            filePath,
          );
        const wantsTranslate =
          params.mode === "translate" ||
          (params.mode !== "attach" && isBibliography);
        if (wantsTranslate) {
          const translated = await this.importBibliographyFile({
            filePath,
            libraryID: targetLibraryID,
            targetCollectionId: targetCollection?.id,
          });
          if (translated.status === "imported") {
            items.push({
              filePath,
              status: "imported",
              itemId: translated.itemIds[0],
              title: `${translated.itemIds.length} reference${
                translated.itemIds.length === 1 ? "" : "s"
              } from ${filePath.split(/[\\/]/).pop()}`,
            });
            succeeded++;
            continue;
          }
          if (params.mode === "translate") {
            // Explicitly asked to translate, so falling back to attaching
            // would answer a different question than the one asked.
            items.push({
              filePath,
              status: "error",
              reason: translated.reason || "No translator recognised the file",
            });
            failed++;
            continue;
          }
          // Auto mode: an unrecognised file is still worth attaching.
        }

        let attachmentItem: any;

        if (Attachments?.importFromFile && nsFile) {
          // Primary: Zotero.Attachments.importFromFile({ file, libraryID })
          attachmentItem = await Attachments.importFromFile({
            file: nsFile,
            libraryID: targetLibraryID,
          });
        } else if (Attachments?.importFromFile) {
          // Try with path string
          attachmentItem = await Attachments.importFromFile({
            file: filePath,
            libraryID: targetLibraryID,
          });
        } else {
          items.push({
            filePath,
            status: "error",
            reason: "Zotero.Attachments.importFromFile is not available",
          });
          failed++;
          continue;
        }

        if (!attachmentItem) {
          items.push({
            filePath,
            status: "error",
            reason: "Import returned no item",
          });
          failed++;
          continue;
        }

        const itemId = Number(attachmentItem.id);
        const title = String(
          attachmentItem.getField?.("title") ||
            (attachmentItem as any).attachmentFilename ||
            filePath.split(/[\\/]/).pop() ||
            filePath,
        );

        // If there's a parent item (Zotero auto-created from metadata retrieval),
        // use that for collection assignment
        const parentId = attachmentItem.parentID;
        const targetItem = parentId
          ? this.getItem(parentId) || attachmentItem
          : attachmentItem;

        // importFromFile returns a top-level ATTACHMENT, so isRegularItem()
        // is false and the gate silently dropped targetCollectionId for
        // every local-file import. Zotero files top-level attachments into
        // collections perfectly well.
        if (targetCollection && !targetItem.parentID) {
          targetItem.addToCollection(targetCollection.id);
          await targetItem.saveTx();
        }

        // Metadata retrieval never ran for any file, PDFs included --
        // Attachments.importFromFile has no recognition step, and Zotero
        // wires autoRecognizeItems only to the UI drop handlers and the
        // browser connector. The tool description promised it anyway, so a
        // PDF import produced a bare attachment titled paper.pdf with no
        // title, authors, year or DOI.
        let recognizedParentId: number | undefined;
        if (params.recognize !== false && attachmentItem.isPDFAttachment?.()) {
          const recognizer = (
            Zotero as unknown as {
              RecognizeDocument?: {
                recognizeItems?: (items: unknown[]) => Promise<unknown>;
              };
            }
          ).RecognizeDocument;
          if (recognizer?.recognizeItems) {
            try {
              await recognizer.recognizeItems([attachmentItem]);
              const newParent = Number(attachmentItem.parentID);
              if (Number.isFinite(newParent) && newParent > 0) {
                recognizedParentId = newParent;
              }
            } catch {
              // A failed lookup leaves a plain attachment, which is the old
              // behaviour -- it must not fail the import.
            }
          }
        }
        // Recognition creates a parent item, and that is what belongs in the
        // collection, not the attachment underneath it.
        if (recognizedParentId && targetCollection) {
          const parent = this.getItem(recognizedParentId);
          if (parent) {
            parent.addToCollection(targetCollection.id);
            await parent.saveTx();
          }
        }

        items.push({
          filePath,
          status: "imported",
          itemId: recognizedParentId || parentId || itemId,
          title,
        });
        succeeded++;
      } catch (error) {
        items.push({
          filePath,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
        failed++;
      }
    }

    return { succeeded, failed, items };
  }

  /**
   * Fetch canonical metadata for a paper by identifier (DOI, arXiv ID, or ISBN)
   * using Zotero's built-in Translate.Search engine — the same engine that powers
   * "Add Item by Identifier". Returns a complete metadata patch with ALL fields
   * without creating any item in the library.
   *
   * Falls back to creating a temporary item and reading its fields if the
   * translator does not support libraryID: false.
   */
  /**
   * Parses a user- or model-supplied identifier into Zotero's translator
   * shape.
   *
   * The import path used to have its own two-branch version: a
   * case-SENSITIVE `arxiv:` prefix, else "assume DOI". So the ISBNs and URLs
   * both schemas advertised silently failed, and — worse — the tool's own
   * validation hint suggested `"arXiv:2301.00001"` with a capital V, which
   * failed its own check.
   */
  /**
   * Works out what kind of identifier a string is.
   *
   * The hand-rolled version had four branches and fell through to "assume
   * DOI", which mis-sent several forms the schema advertises:
   *
   * - a bare arXiv ID (`2301.00001`) failed the ISBN test because of the dot
   *   and became a DOI -- and that is the form a literature search most often
   *   produces, so the most common arXiv case never worked
   * - a bare PMID (8-9 digits) fell under the 10-character ISBN threshold and
   *   became a DOI
   * - ADS bibcodes had no branch at all
   *
   * `Zotero.Utilities.extractIdentifiers` is the same parser Zotero's own
   * "Add Item by Identifier" uses, so these all resolve correctly. It has no
   * URL branch either, which is why URLs are handled separately below rather
   * than being silently turned into a DOI.
   */
  private parseImportIdentifier(rawIdentifier: string): Record<string, string> {
    const trimmed = rawIdentifier.trim();
    const extract = (
      Zotero as unknown as {
        Utilities?: {
          extractIdentifiers?: (text: string) => Array<Record<string, string>>;
        };
      }
    ).Utilities?.extractIdentifiers;
    if (extract) {
      try {
        const found = extract(trimmed);
        if (found?.length) return found[0];
      } catch {
        // Fall through to the legacy branches below.
      }
    }
    if (/^arxiv:/i.test(trimmed)) {
      return { arXiv: trimmed.replace(/^arxiv:/i, "").trim() };
    }
    const withoutIsbnPrefix = trimmed.replace(/^isbn[:\s]?/i, "");
    if (/^[\d-]{10,}$/.test(withoutIsbnPrefix)) {
      return { ISBN: withoutIsbnPrefix.trim() };
    }
    if (/^pmid[:\s]?\d+$/i.test(trimmed)) {
      return { PMID: trimmed.replace(/^pmid[:\s]?/i, "").trim() };
    }
    return { DOI: trimmed.replace(/^https?:\/\/doi\.org\//i, "") };
  }

  /**
   * Whether this identifier can be resolved at all.
   *
   * `Translate.Search.setIdentifier` throws for anything outside
   * DOI/ISBN/PMID/arXiv/adsBibcode, and a plain URL is not among them --
   * Zotero's own Add-by-Identifier box does not accept URLs either. The
   * schemas advertised URL import, so pasting an arXiv abstract page, a
   * Nature article page or a PubMed page came back "No translator could
   * resolve this identifier". URLs whose path happens to contain a DOI worked
   * by accident, which made the failure look random rather than systematic.
   */
  private describeUnresolvableIdentifier(raw: string): string | null {
    const trimmed = raw.trim();
    if (!/^https?:\/\//i.test(trimmed)) return null;
    // A DOI anywhere in the URL is extractable, so those still work.
    if (/10\.\d{4,}\/[^\s]+/.test(trimmed)) return null;
    return (
      "Zotero cannot import from a page URL — only DOIs, ISBNs, PMIDs, arXiv IDs and ADS bibcodes. " +
      "Open the page and use the DOI or arXiv ID from it instead."
    );
  }

  async fetchMetadataByIdentifier(
    rawIdentifier: string,
  ): Promise<EditableArticleMetadataPatch | null> {
    try {
      const isArXiv = /^arxiv:/i.test(rawIdentifier);
      const isIsbn = /^(isbn[:\s]?)?[\d-]{10,}$/i.test(
        rawIdentifier.replace(/^isbn[:\s]?/i, ""),
      );
      const identifier: Record<string, string> = isArXiv
        ? { arXiv: rawIdentifier.replace(/^arxiv:/i, "") }
        : isIsbn
          ? { ISBN: rawIdentifier.replace(/^isbn[:\s]?/i, "").trim() }
          : { DOI: rawIdentifier.replace(/^https?:\/\/doi\.org\//i, "") };

      const translate = new (
        Zotero as unknown as {
          Translate: {
            Search: new () => {
              setIdentifier(id: Record<string, string>): void;
              getTranslators(): Promise<unknown[]>;
              setTranslator(t: unknown): void;
              translate(opts?: {
                libraryID?: number | false;
                saveAttachments?: boolean;
              }): Promise<unknown[]>;
            };
          };
        }
      ).Translate.Search();

      translate.setIdentifier(identifier);
      const translators = await translate.getTranslators();
      if (!translators || translators.length === 0) return null;
      translate.setTranslator(translators);

      // Try libraryID: false first — returns raw JSON without saving to DB
      let rawItems: unknown[];
      let tempItemId: number | null = null;
      try {
        rawItems = await translate.translate({
          libraryID: false as unknown as number,
          saveAttachments: false,
        });
      } catch {
        // Fallback: create a temporary item, read its metadata, then delete it
        const targetLibraryID =
          (Zotero as unknown as { Libraries?: { userLibraryID?: number } })
            .Libraries?.userLibraryID ?? 1;
        rawItems = await translate.translate({ libraryID: targetLibraryID });
        if (rawItems?.[0] && typeof rawItems[0] === "object") {
          const id = Number((rawItems[0] as { id?: unknown }).id);
          if (Number.isFinite(id) && id > 0) tempItemId = Math.floor(id);
        }
      }

      if (!rawItems || rawItems.length === 0) return null;
      const raw = rawItems[0] as Record<string, unknown>;

      // If we got a real Zotero item (fallback path), read fields from it
      if (tempItemId) {
        const item = this.getItem(tempItemId);
        if (item) {
          const snapshot = this.getEditableArticleMetadata(item);
          // Clean up the temporary item
          try {
            item.deleted = true;
            await item.saveTx();
            await item.eraseTx();
          } catch {
            // Best-effort cleanup
          }
          if (snapshot) {
            const patch: EditableArticleMetadataPatch = {};
            for (const [key, value] of Object.entries(snapshot.fields)) {
              if (value) {
                patch[key as EditableArticleMetadataField] = value;
              }
            }
            if (snapshot.creators.length) patch.creators = snapshot.creators;
            return Object.keys(patch).length ? patch : null;
          }
        }
        return null;
      }

      // libraryID: false path — raw is a translator JSON object
      return this.translatorJsonToPatch(raw);
    } catch {
      return null;
    }
  }

  /**
   * Convert a raw Zotero translator JSON result (from libraryID: false) into
   * an EditableArticleMetadataPatch.
   */
  private translatorJsonToPatch(
    raw: Record<string, unknown>,
  ): EditableArticleMetadataPatch | null {
    const patch: EditableArticleMetadataPatch = {};
    for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
      const value = raw[fieldName];
      if (typeof value === "string" && value.trim()) {
        patch[fieldName] = value.trim();
      } else if (typeof value === "number") {
        patch[fieldName] = String(value);
      }
    }
    // Creators from translator JSON come as [{firstName, lastName, creatorType}]
    const rawCreators = Array.isArray(raw.creators) ? raw.creators : [];
    const creators: EditableArticleCreator[] = [];
    for (const entry of rawCreators) {
      if (!entry || typeof entry !== "object") continue;
      const c = entry as Record<string, unknown>;
      const creatorType =
        typeof c.creatorType === "string" && c.creatorType.trim()
          ? c.creatorType.trim()
          : "author";
      const firstName =
        typeof c.firstName === "string" && c.firstName.trim()
          ? c.firstName.trim()
          : undefined;
      const lastName =
        typeof c.lastName === "string" && c.lastName.trim()
          ? c.lastName.trim()
          : undefined;
      const name =
        typeof c.name === "string" && c.name.trim() ? c.name.trim() : undefined;
      if (!name && !firstName && !lastName) continue;
      creators.push({
        creatorType,
        firstName,
        lastName,
        name,
        fieldMode: (name && !firstName && !lastName ? 1 : 0) as 0 | 1,
      });
    }
    if (creators.length) patch.creators = creators;
    return Object.keys(patch).length ? patch : null;
  }

  /**
   * Import papers into the Zotero library by identifier (DOI or arXiv ID).
   *
   * - Plain DOI strings (starting with "10.") → `{ DOI: id }`
   * - arXiv IDs prefixed with `"arxiv:"` (e.g. `"arxiv:2301.12345"`) → `{ arXiv: id }`
   *
   * Uses Zotero's built-in `Translate.Search` API, which fetches metadata from
   * CrossRef / arXiv translators and saves items to the target library.
   * Zotero will also attempt to attach a PDF if one is openly available.
   */
  async importPapersByIdentifiers(
    identifiers: string[],
    libraryID?: number,
    targetCollectionId?: number,
  ): Promise<{
    succeeded: number;
    failed: number;
    itemIds?: number[];
    items: Array<{
      identifier: string;
      status: "imported" | "not_found" | "error";
      itemId?: number;
      reason?: string;
    }>;
  }> {
    let succeeded = 0;
    let failed = 0;
    const itemIds: number[] = [];
    // Per-identifier rows: "10 of 50 failed" was previously unattributable,
    // so a user had no way to know which ten to retry.
    const rows: Array<{
      identifier: string;
      status: "imported" | "not_found" | "error";
      itemId?: number;
      reason?: string;
    }> = [];
    const targetLibraryID =
      libraryID ??
      (Zotero as unknown as { Libraries?: { userLibraryID?: number } })
        .Libraries?.userLibraryID ??
      1;
    const targetCollection = targetCollectionId
      ? this.getCollection(targetCollectionId)
      : null;
    if (targetCollectionId && !targetCollection) {
      throw new Error("Target collection not found");
    }

    for (const rawId of identifiers) {
      try {
        const identifier = this.parseImportIdentifier(rawId);

        const translate = new (
          Zotero as unknown as {
            Translate: {
              Search: new () => {
                setIdentifier(id: Record<string, string>): void;
                getTranslators(): Promise<unknown[]>;
                setTranslator(t: unknown): void;
                translate(opts?: { libraryID?: number }): Promise<unknown[]>;
              };
            };
          }
        ).Translate.Search();

        translate.setIdentifier(identifier);
        const translators = await translate.getTranslators();
        if (!translators || translators.length === 0) {
          failed++;
          rows.push({
            identifier: rawId,
            status: "not_found",
            reason:
              this.describeUnresolvableIdentifier(rawId) ||
              "No translator could resolve this identifier",
          });
          continue;
        }
        translate.setTranslator(translators);
        const items = await translate.translate({ libraryID: targetLibraryID });
        if (items && items.length > 0) {
          const importedRegularItemIds = items
            .map((item) =>
              item && typeof item === "object"
                ? Number((item as { id?: unknown }).id)
                : NaN,
            )
            .filter((itemId) => Number.isFinite(itemId) && itemId > 0)
            .map((itemId) => Math.floor(itemId))
            .filter((itemId) => {
              const importedItem = this.getItem(itemId);
              return Boolean(importedItem?.isRegularItem?.());
            });
          if (targetCollection) {
            for (const itemId of importedRegularItemIds) {
              const importedItem = this.getItem(itemId);
              if (
                !importedItem ||
                importedItem.inCollection?.(targetCollection.id)
              ) {
                continue;
              }
              importedItem.addToCollection(targetCollection.id);
              await importedItem.saveTx();
            }
          }
          itemIds.push(...importedRegularItemIds);
          // Previously `|| items.length`, which reported success when the
          // translator returned something but nothing survived the
          // regular-item filter — so nothing was filed and it still counted.
          if (importedRegularItemIds.length) {
            succeeded += importedRegularItemIds.length;
            for (const itemId of importedRegularItemIds) {
              rows.push({ identifier: rawId, status: "imported", itemId });
            }
          } else {
            failed++;
            rows.push({
              identifier: rawId,
              status: "error",
              reason:
                "The translator returned no regular item for this identifier",
            });
          }
        } else {
          failed++;
          rows.push({
            identifier: rawId,
            status: "not_found",
            reason: "The translator returned no items",
          });
        }
      } catch (error) {
        failed++;
        rows.push({
          identifier: rawId,
          status: "error",
          // Zotero rejects a translation with a bare STRING, not an Error
          // ("No items returned from any translator"), so assuming Error
          // flattened every real translator failure to the two words "Import
          // failed" and told the user nothing.
          reason:
            error instanceof Error
              ? error.message
              : typeof error === "string" && error.trim()
                ? error.trim()
                : "Import failed",
        });
      }
    }

    // A follow-up library_search would not have seen the new items.

    return { succeeded, failed, itemIds, items: rows };
  }
}
