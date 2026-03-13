import {
  browsePaperCollectionCandidates,
  invalidatePaperSearchCache,
  listLibraryPaperCandidates,
  searchPaperCandidates,
  searchAllItemCandidates,
  type PaperBrowseCollectionCandidate,
  type PaperSearchGroupCandidate,
} from "../../modules/contextPanel/paperSearch";
import {
  createNoteFromAssistantText,
  createStandaloneNoteFromAssistantText,
  readNoteSnapshot,
  renderRawNoteHtml,
} from "../../modules/contextPanel/notes";
import {
  getActiveContextAttachmentFromTabs,
  resolveContextSourceItem,
} from "../../modules/contextPanel/contextResolution";
import { resolvePaperContextRefFromAttachment } from "../../modules/contextPanel/paperAttribution";
import { invalidateCachedContextText } from "../../modules/contextPanel/pdfContext";
import type { AgentRuntimeRequest } from "../types";
import type { PaperContextRef } from "../../shared/types";
import {
  isGlobalPortalItem,
  isPaperPortalItem,
  resolvePaperPortalBaseItem,
} from "../../modules/contextPanel/portalScope";

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

export type EditableArticleMetadataField =
  (typeof EDITABLE_ARTICLE_METADATA_FIELDS)[number];

export type EditableArticleCreator = {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  fieldMode?: 0 | 1;
};

export type EditableArticleMetadataPatch = Partial<
  Record<EditableArticleMetadataField, string>
> & {
  creators?: EditableArticleCreator[];
};

export type EditableArticleMetadataSnapshot = {
  itemId: number;
  itemType: string;
  title: string;
  fields: Record<EditableArticleMetadataField, string>;
  creators: EditableArticleCreator[];
};

export type LibraryPaperTargetAttachment = {
  contextItemId: number;
  title: string;
};

export type LibraryPaperTarget = {
  itemId: number;
  title: string;
  firstCreator?: string;
  year?: string;
  attachments: LibraryPaperTargetAttachment[];
  tags: string[];
  collectionIds: number[];
};

export type LibraryItemTargetAttachment = {
  contextItemId: number;
  title: string;
  contentType: string;
};

export type LibraryItemTarget = {
  itemId: number;
  itemType: string;
  title: string;
  firstCreator?: string;
  year?: string;
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

export type BatchTagAssignment = {
  itemId: number;
  tags: string[];
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

function stripHtmlContent(html: string): string {
  return html
    .replace(/<\/p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n---\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeText(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim();
}

function resolveRegularItem(item: Zotero.Item | null | undefined): Zotero.Item | null {
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
    const name = (Zotero as unknown as { ItemTypes?: { getName?: (id: number) => string } })
      .ItemTypes?.getName?.(item.itemTypeID);
    return typeof name === "string" && name.trim() ? name.trim() : "";
  } catch (_error) {
    void _error;
    return "";
  }
}

function isFieldValidForItemType(
  item: Zotero.Item,
  fieldName: EditableArticleMetadataField,
): boolean {
  try {
    const itemFields = (Zotero as unknown as {
      ItemFields?: {
        getID?: (name: string) => number | false;
        isValidForType?: (fieldId: number, itemTypeId: number) => boolean;
      };
    }).ItemFields;
    const fieldId = itemFields?.getID?.(fieldName);
    if (fieldId === false || !fieldId) return false;
    if (typeof itemFields?.isValidForType !== "function") return true;
    return Boolean(itemFields.isValidForType(fieldId, item.itemTypeID));
  } catch (_error) {
    void _error;
    return true;
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
    Number((creator as { fieldMode?: unknown }).fieldMode) === 1 || name ? 1 : 0;
  if (!name && !firstName && !lastName) return null;
  return {
    creatorType,
    name,
    firstName,
    lastName,
    fieldMode,
  };
}

function normalizePaperContexts(
  entries: PaperContextRef[] | undefined,
): PaperContextRef[] {
  if (!Array.isArray(entries)) return [];
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry) continue;
    const itemId = Number(entry.itemId);
    const contextItemId = Number(entry.contextItemId);
    if (!Number.isFinite(itemId) || !Number.isFinite(contextItemId)) continue;
    const normalized: PaperContextRef = {
      itemId: Math.floor(itemId),
      contextItemId: Math.floor(contextItemId),
      title: `${entry.title || `Paper ${Math.floor(itemId)}`}`.trim(),
      attachmentTitle: entry.attachmentTitle?.trim() || undefined,
      citationKey: entry.citationKey?.trim() || undefined,
      firstCreator: entry.firstCreator?.trim() || undefined,
      year: entry.year?.trim() || undefined,
    };
    const key = `${normalized.itemId}:${normalized.contextItemId}`;
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
    const libraries = (Zotero as unknown as {
      Libraries?: {
        getName?: (targetLibraryID: number) => unknown;
        get?: (targetLibraryID: number) => { name?: unknown } | null | undefined;
      };
    }).Libraries;
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
    if (
      attachment &&
      attachment.isAttachment?.() &&
      attachment.attachmentContentType === "application/pdf"
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
    (attachment as unknown as { attachmentFilename?: string }).attachmentFilename,
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
    (attachment as unknown as { attachmentFilename?: string }).attachmentFilename,
  );
  if (filename) return filename;
  const contentType = normalizeText(attachment.attachmentContentType);
  if (contentType) {
    const ext = contentType.split("/").pop() || contentType;
    return total > 1 ? `${ext.toUpperCase()} ${index + 1}` : ext.toUpperCase();
  }
  return total > 1 ? `Attachment ${index + 1}` : "Attachment";
}

function getItemTags(item: Zotero.Item | null | undefined): string[] {
  if (!item) return [];
  try {
    const out = (item.getTags?.() || [])
      .map((entry) => normalizeText(entry?.tag))
      .filter(Boolean);
    return Array.from(new Set(out)).sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: "base" }),
    );
  } catch (_error) {
    void _error;
    return [];
  }
}

function buildPaperTargetFromItem(item: Zotero.Item): LibraryPaperTarget | null {
  const target = resolveRegularItem(item);
  if (!target) return null;
  const attachments = getPdfChildAttachments(target).map((attachment, index, list) => ({
    contextItemId: attachment.id,
    title: resolveAttachmentTitle(attachment, index, list.length),
  }));
  if (!attachments.length) return null;
  return {
    itemId: target.id,
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
    attachments,
    tags: getItemTags(target),
    collectionIds: getCollectionIDs(target),
  };
}

function buildItemTargetFromItem(item: Zotero.Item): LibraryItemTarget | null {
  // Standalone note (no parent)
  if ((item as any).isNote?.() && !item.parentID) {
    const rawTitle = normalizeText(
      (item as any).getNoteTitle?.() || item.getDisplayTitle?.() || "",
    );
    return {
      itemId: item.id,
      itemType: "note",
      title: rawTitle || `Note ${item.id}`,
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
    attachments: allAtts.map((att, index, list) => ({
      contextItemId: att.id,
      title: resolveAnyAttachmentTitle(att, index, list.length),
      contentType: normalizeText(att.attachmentContentType) || "application/octet-stream",
    })),
    tags: getItemTags(target),
    collectionIds: getCollectionIDs(target),
  };
}

function summarizeCollectionNode(
  candidate: PaperBrowseCollectionCandidate,
): CollectionBrowseNode {
  const childCollections = candidate.childCollections.map((entry) =>
    summarizeCollectionNode(entry),
  );
  const paperCount = candidate.papers.length;
  const descendantPaperCount =
    paperCount +
    childCollections.reduce((sum, entry) => sum + entry.descendantPaperCount, 0);
  return {
    collectionId: candidate.collectionId,
    name: normalizeText(candidate.name) || `Collection ${candidate.collectionId}`,
    paperCount,
    descendantPaperCount,
    childCollections,
  };
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
    const name = normalizeText(collection.name) || `Collection ${collection.id}`;
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

async function getAllLibraryItems(libraryID: number): Promise<Zotero.Item[]> {
  try {
    const items: Zotero.Item[] = await Zotero.Items.getAll(libraryID, true, false, false);
    return items.filter((item) => {
      // Include regular items and standalone notes; exclude child attachments, annotations, child notes
      if ((item as any).isNote?.()) return !item.parentID;
      if (item.isAttachment?.()) return false;
      return item.isRegularItem?.() ?? false;
    });
  } catch (_error) {
    void _error;
    return [];
  }
}

function buildItemTargets(
  items: Zotero.Item[],
  options?: { itemType?: string; limit?: number },
): LibraryItemTarget[] {
  const normalizedLimit =
    Number.isFinite(options?.limit) && (options?.limit as number) > 0
      ? Math.floor(options!.limit as number)
      : undefined;
  const typeFilter = options?.itemType?.trim().toLowerCase();
  const results: LibraryItemTarget[] = [];
  for (const item of items) {
    if (normalizedLimit && results.length >= normalizedLimit) break;
    const target = buildItemTargetFromItem(item);
    if (!target) continue;
    if (typeFilter && target.itemType.toLowerCase() !== typeFilter) continue;
    results.push(target);
  }
  return results;
}

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

  getCollectionSummary(collectionId: number | undefined): CollectionSummary | null {
    const collection = this.getCollection(collectionId);
    if (!collection) return null;
    const pathMap = buildCollectionPathMap(
      listLibraryCollections(Number(collection.libraryID) || 0),
    );
    return {
      collectionId: collection.id,
      name: normalizeText(collection.name) || `Collection ${collection.id}`,
      libraryID: Number(collection.libraryID) || 0,
      path:
        pathMap.get(collection.id) ||
        normalizeText(collection.name) ||
        `Collection ${collection.id}`,
    };
  }

  listCollectionSummaries(libraryID: number): CollectionSummary[] {
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
        (left.path || left.name).localeCompare(right.path || right.name, undefined, {
          sensitivity: "base",
        }),
      );
  }

  getAllChildAttachmentInfos(itemId: number): LibraryItemTargetAttachment[] {
    const item = this.getItem(itemId);
    if (!item) return [];
    const allAtts = getAllChildAttachments(item.isRegularItem?.() ? item : (this.resolveBibliographicItem(item) || item));
    return allAtts.map((att, index, list) => ({
      contextItemId: att.id,
      title: resolveAnyAttachmentTitle(att, index, list.length),
      contentType: normalizeText(att.attachmentContentType) || "application/octet-stream",
    }));
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
    const candidates = await listLibraryPaperCandidates(libraryID);
    const papers: LibraryPaperTarget[] = [];
    for (const candidate of candidates) {
      const item = this.resolveBibliographicItem(this.getItem(candidate.itemId));
      if (!item) continue;
      const target = buildPaperTargetFromItem(item);
      if (target) {
        papers.push(target);
      }
    }
    const normalizedLimit = Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit as number))
      : undefined;
    return {
      papers:
        normalizedLimit && papers.length > normalizedLimit
          ? papers.slice(0, normalizedLimit)
          : papers,
      totalCount: papers.length,
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
    const byPaperContext = resolveRegularItem(this.getItem(params.paperContext?.itemId));
    if (byPaperContext) return byPaperContext;
    const byActiveItem = resolveRegularItem(
      this.getItem(params.request?.activeItemId),
    );
    if (byActiveItem) return byActiveItem;
    return resolveRegularItem(params.item || null);
  }

  getActiveContextItem(item: Zotero.Item | null | undefined): Zotero.Item | null {
    if (item) {
      return resolveContextSourceItem(item).contextItem;
    }
    return getActiveContextAttachmentFromTabs();
  }

  getActivePaperContext(
    item: Zotero.Item | null | undefined,
  ): PaperContextRef | null {
    return resolvePaperContextRefFromAttachment(this.getActiveContextItem(item));
  }

  resolveActiveNoteItem(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
  }): Zotero.Item | null {
    const requestNoteId = Number(params.request?.activeNoteContext?.noteId || 0);
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
  }) {
    return readNoteSnapshot(this.resolveActiveNoteItem(params));
  }

  async replaceCurrentNote(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    content: string;
    expectedOriginalHtml?: string;
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
      snapshot.html !== params.expectedOriginalHtml
    ) {
      throw new Error(
        "The active note changed before this edit was applied. Refresh and try again.",
      );
    }
    const nextText =
      typeof params.content === "string" ? params.content : String(params.content || "");
    noteItem.setNote(renderRawNoteHtml(nextText));
    await noteItem.saveTx();
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
    noteItem.setNote(typeof params.html === "string" ? params.html : "");
    await noteItem.saveTx();
    invalidateCachedContextText(Math.floor(params.noteId));
  }

  getEditableArticleMetadata(
    item: Zotero.Item | null | undefined,
  ): EditableArticleMetadataSnapshot | null {
    const target = resolveRegularItem(item);
    if (!target) return null;
    const fields = Object.fromEntries(
      EDITABLE_ARTICLE_METADATA_FIELDS.map((fieldName) => {
        let value = "";
        try {
          value = normalizeMetadataValue(target.getField(fieldName));
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
        .filter((creator): creator is EditableArticleCreator => Boolean(creator));
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

  listPaperContexts(request: AgentRuntimeRequest): PaperContextRef[] {
    const out = [
      ...normalizePaperContexts(request.selectedPaperContexts),
      ...normalizePaperContexts(request.fullTextPaperContexts),
      ...normalizePaperContexts(request.pinnedPaperContexts),
    ];
    const activeItem = this.getItem(request.activeItemId);
    const activeContext = this.getActivePaperContext(activeItem);
    if (activeContext) {
      const key = `${activeContext.itemId}:${activeContext.contextItemId}`;
      if (!out.some((entry) => entry && `${entry.itemId}:${entry.contextItemId}` === key)) {
        out.unshift(activeContext);
      }
    }
    return out;
  }

  async browseCollections(params: {
    libraryID: number;
  }): Promise<{
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
    const candidates = await browsePaperCollectionCandidates(libraryID);
    const collections = candidates
      .filter((entry) => entry.collectionId > 0)
      .map((entry) => summarizeCollectionNode(entry));
    const unfiledNode =
      candidates.find((entry) => entry.collectionId === 0) || null;
    return {
      libraryID,
      libraryName: resolveLibraryDisplayName(libraryID),
      collections,
      unfiled: {
        name: "Unfiled",
        paperCount: unfiledNode?.papers.length || 0,
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
      throw new Error("No active library available for listing collection papers");
    }
    if (collection.libraryID && collection.libraryID !== libraryID) {
      throw new Error("Collection does not belong to the active library");
    }
    const candidates = await listLibraryPaperCandidates(libraryID);
    const papers: LibraryPaperTarget[] = [];
    for (const candidate of candidates) {
      const item = this.resolveBibliographicItem(this.getItem(candidate.itemId));
      if (!item?.inCollection?.(collection.collectionId)) continue;
      const target = buildPaperTargetFromItem(item);
      if (target) {
        papers.push(target);
      }
    }
    const normalizedLimit = Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit as number))
      : undefined;
    return {
      collection,
      papers:
        normalizedLimit && papers.length > normalizedLimit
          ? papers.slice(0, normalizedLimit)
          : papers,
      totalCount: papers.length,
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
    const candidates = await listLibraryPaperCandidates(libraryID);
    const papers: LibraryPaperTarget[] = [];
    for (const candidate of candidates) {
      const item = this.resolveBibliographicItem(this.getItem(candidate.itemId));
      if (!item) continue;
      const target = buildPaperTargetFromItem(item);
      if (target && target.collectionIds.length === 0) {
        papers.push(target);
      }
    }
    const normalizedLimit = Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit as number))
      : undefined;
    return {
      papers:
        normalizedLimit && papers.length > normalizedLimit
          ? papers.slice(0, normalizedLimit)
          : papers,
      totalCount: papers.length,
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
      throw new Error("No active library available for listing untagged papers");
    }
    const candidates = await listLibraryPaperCandidates(libraryID);
    const papers: LibraryPaperTarget[] = [];
    for (const candidate of candidates) {
      const item = this.resolveBibliographicItem(this.getItem(candidate.itemId));
      if (!item) continue;
      const target = buildPaperTargetFromItem(item);
      if (target && target.tags.length === 0) {
        papers.push(target);
      }
    }
    const normalizedLimit = Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit as number))
      : undefined;
    return {
      papers:
        normalizedLimit && papers.length > normalizedLimit
          ? papers.slice(0, normalizedLimit)
          : papers,
      totalCount: papers.length,
    };
  }

  async searchLibraryItems(params: {
    libraryID: number;
    query: string;
    excludeContextItemId?: number | null;
    limit?: number;
  }): Promise<PaperSearchGroupCandidate[]> {
    return searchPaperCandidates(
      params.libraryID,
      params.query,
      params.excludeContextItemId,
      params.limit,
    );
  }

  // ── Universal item listing (all item types, not PDF-only) ──────────────────

  async listLibraryItemTargets(params: {
    libraryID: number;
    limit?: number;
    itemType?: string;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID) ? Math.floor(params.libraryID) : 0;
    if (!libraryID) throw new Error("No active library available for listing items");
    const rawItems = await getAllLibraryItems(libraryID);
    const items = buildItemTargets(rawItems, { itemType: params.itemType, limit: params.limit });
    return { items, totalCount: items.length };
  }

  async listCollectionItemTargets(params: {
    libraryID: number;
    collectionId: number;
    limit?: number;
    itemType?: string;
  }): Promise<{ collection: CollectionSummary; items: LibraryItemTarget[]; totalCount: number }> {
    const collection = this.getCollectionSummary(params.collectionId);
    if (!collection) throw new Error("Collection not found");
    const libraryID = Number.isFinite(params.libraryID) ? Math.floor(params.libraryID) : 0;
    if (!libraryID) throw new Error("No active library available");
    const rawItems = await getAllLibraryItems(libraryID);
    const inCollection = rawItems.filter((item) => {
      const ids = getCollectionIDs(item);
      return ids.includes(params.collectionId);
    });
    const items = buildItemTargets(inCollection, { itemType: params.itemType, limit: params.limit });
    return { collection, items, totalCount: items.length };
  }

  async listUnfiledItemTargets(params: {
    libraryID: number;
    limit?: number;
    itemType?: string;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID) ? Math.floor(params.libraryID) : 0;
    if (!libraryID) throw new Error("No active library available");
    const rawItems = await getAllLibraryItems(libraryID);
    const unfiled = rawItems.filter((item) => getCollectionIDs(item).length === 0);
    const items = buildItemTargets(unfiled, { itemType: params.itemType, limit: params.limit });
    return { items, totalCount: items.length };
  }

  async listUntaggedItemTargets(params: {
    libraryID: number;
    limit?: number;
    itemType?: string;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID) ? Math.floor(params.libraryID) : 0;
    if (!libraryID) throw new Error("No active library available");
    const rawItems = await getAllLibraryItems(libraryID);
    const untagged = rawItems.filter((item) => getItemTags(item).length === 0);
    const items = buildItemTargets(untagged, { itemType: params.itemType, limit: params.limit });
    return { items, totalCount: items.length };
  }

  async listStandaloneNotes(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{ notes: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID) ? Math.floor(params.libraryID) : 0;
    if (!libraryID) throw new Error("No active library available");
    const rawItems = await getAllLibraryItems(libraryID);
    const standaloneNotes: LibraryItemTarget[] = [];
    const normalizedLimit = Number.isFinite(params.limit) ? Math.max(1, Math.floor(params.limit as number)) : undefined;
    for (const item of rawItems) {
      if (normalizedLimit && standaloneNotes.length >= normalizedLimit) break;
      if (!(item as any).isNote?.() || item.parentID) continue;
      const target = buildItemTargetFromItem(item);
      if (target) standaloneNotes.push(target);
    }
    return { notes: standaloneNotes, totalCount: standaloneNotes.length };
  }

  getStandaloneNoteContent(params: { noteId: number }): PaperNoteRecord | null {
    const noteItem = this.getItem(params.noteId);
    if (!noteItem || !(noteItem as any).isNote?.()) return null;
    const html = noteItem.getNote?.() || "";
    const text = stripHtmlContent(html);
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
        ? (linkModeMap[rawLinkMode] || String(rawLinkMode))
        : "unknown";
    return {
      attachmentId: item.id,
      parentItemId: item.parentID || undefined,
      title: normalizeText(item.getField?.("title")) || filename || `Attachment ${item.id}`,
      contentType: normalizeText(item.attachmentContentType) || "application/octet-stream",
      filename: filename || undefined,
      hasFile,
      linkMode,
    };
  }

  async searchAllLibraryItems(params: {
    libraryID: number;
    query: string;
    limit?: number;
  }): Promise<LibraryItemTarget[]> {
    const libraryID = Number.isFinite(params.libraryID) ? Math.floor(params.libraryID) : 0;
    if (!libraryID || !params.query?.trim()) return [];
    const normalizedLimit = Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit as number))
      : 50;
    try {
      const search = new Zotero.Search({ libraryID });
      search.addCondition("quicksearch-everything", "contains", params.query.trim());
      const rawIds: number[] = await search.search();
      // Resolve child items (notes/attachments) to their top-level parent, de-duplicate
      const resolvedIds: number[] = [];
      const seen = new Set<number>();
      for (const id of rawIds) {
        const item = Zotero.Items.get(id);
        if (!item) continue;
        const topId = (item.parentID as number | false | undefined) || id;
        if (!seen.has(topId)) {
          seen.add(topId);
          resolvedIds.push(topId);
        }
      }
      const targets: LibraryItemTarget[] = [];
      for (const itemId of resolvedIds) {
        if (targets.length >= normalizedLimit) break;
        const item = this.getItem(itemId);
        if (!item) continue;
        const target = buildItemTargetFromItem(item);
        if (target) targets.push(target);
      }
      return targets;
    } catch (_error) {
      void _error;
      return [];
    }
  }

  async searchAllNotes(params: {
    libraryID: number;
    query: string;
    limit?: number;
  }): Promise<Array<LibraryItemTarget & { parentItemId?: number; parentItemTitle?: string }>> {
    const libraryID = Number.isFinite(params.libraryID) ? Math.floor(params.libraryID) : 0;
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
      return this._searchAllNotesInMemory({ libraryID, query, limit: normalizedLimit });
    }
  }

  private _buildNoteResults(
    noteIds: number[],
    limit: number,
  ): Array<LibraryItemTarget & { parentItemId?: number; parentItemTitle?: string }> {
    const results: Array<LibraryItemTarget & { parentItemId?: number; parentItemTitle?: string }> = [];
    for (const noteId of noteIds) {
      if (results.length >= limit) break;
      const noteItem = this.getItem(noteId);
      if (!noteItem?.isNote?.()) continue;
      const rawTitle = normalizeText(
        (noteItem as any).getNoteTitle?.() || noteItem.getDisplayTitle?.() || "",
      ).trim();
      const title = rawTitle || `Note ${noteItem.id}`;
      if (noteItem.parentID) {
        const parentItem = this.getItem(noteItem.parentID as number);
        const parentTitle = parentItem
          ? normalizeText(parentItem.getDisplayTitle?.() || "").trim() || `Item ${parentItem.id}`
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
  }): Promise<Array<LibraryItemTarget & { parentItemId?: number; parentItemTitle?: string }>> {
    const queryLower = params.query.toLowerCase();
    const rawItems = await getAllLibraryItems(params.libraryID);
    const results: Array<LibraryItemTarget & { parentItemId?: number; parentItemTitle?: string }> = [];
    for (const item of rawItems) {
      if (results.length >= params.limit) break;
      if ((item as any).isNote?.() && !item.parentID) {
        const html = item.getNote?.() || "";
        const text = stripHtmlContent(html);
        const rawTitle = normalizeText(
          (item as any).getNoteTitle?.() || item.getDisplayTitle?.() || "",
        ).trim();
        const title = rawTitle || `Note ${item.id}`;
        if (!`${title} ${text}`.toLowerCase().includes(queryLower)) continue;
        const target = buildItemTargetFromItem(item);
        if (target) results.push({ ...target, noteKind: "standalone" });
        continue;
      }
      if (!(item as any).isRegularItem?.()) continue;
      const noteIds: number[] = (item as any).getNotes?.() || [];
      if (!noteIds.length) continue;
      const parentTitle =
        normalizeText(item.getDisplayTitle?.() || "").trim() || `Item ${item.id}`;
      for (const noteId of noteIds) {
        if (results.length >= params.limit) break;
        const noteItem = Zotero.Items.get(noteId);
        if (!noteItem?.isNote?.()) continue;
        const html = noteItem.getNote?.() || "";
        const text = stripHtmlContent(html);
        const rawTitle = normalizeText(
          (noteItem as any).getNoteTitle?.() || noteItem.getDisplayTitle?.() || "",
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
      const itemId = Number.isFinite(entry.itemId) ? Math.floor(entry.itemId) : 0;
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
      const item = this.resolveBibliographicItem(this.getItem(assignment.itemId));
      if (!item) {
        results.push({
          itemId: assignment.itemId,
          title: `Item ${assignment.itemId}`,
          status: "missing",
          addedTags: [],
          skippedTags: assignment.tags,
          reason: "Item not found",
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

  async addItemsToCollections(params: {
    assignments: BatchMoveAssignment[];
  }): Promise<{
    selectedCount: number;
    movedCount: number;
    skippedCount: number;
    collections: CollectionSummary[];
    items: BatchMoveItemResult[];
  }> {
    const normalizedAssignments: BatchMoveAssignment[] = [];
    const seen = new Set<string>();
    for (const entry of params.assignments) {
      const itemId = Number.isFinite(entry.itemId) ? Math.floor(entry.itemId) : 0;
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
      const collection = this.getCollectionSummary(assignment.targetCollectionId);
      if (!collection) {
        throw new Error("Collection not found");
      }
      collectionMap.set(assignment.targetCollectionId, collection);
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
      const item = this.resolveBibliographicItem(this.getItem(assignment.itemId));
      if (!item) {
        results.push({
          itemId: assignment.itemId,
          title: `Item ${assignment.itemId}`,
          status: "missing",
          targetCollectionId: collection.collectionId,
          targetCollectionName: collection.path || collection.name,
          reason: "Item not found",
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
    if (movedCount > 0) {
      const touchedLibraryIDs = new Set<number>();
      for (const collection of collectionMap.values()) {
        if (collection.libraryID > 0) {
          touchedLibraryIDs.add(collection.libraryID);
        }
      }
      for (const libraryID of touchedLibraryIDs) {
        invalidatePaperSearchCache(libraryID);
      }
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
  }): Promise<"created" | "appended" | "standalone_created"> {
    if (params.target === "standalone") {
      const libraryID =
        Number.isFinite(params.libraryID) && (params.libraryID as number) > 0
          ? Math.floor(params.libraryID as number)
          : params.item?.libraryID || 0;
      await createStandaloneNoteFromAssistantText(
        libraryID,
        params.content,
        params.modelName,
      );
      return "standalone_created";
    }
    if (!params.item) {
      throw new Error("No Zotero item is active for item-note creation");
    }
    return createNoteFromAssistantText(
      params.item,
      params.content,
      params.modelName,
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
        const text = stripHtmlContent(html);
        if (!text.trim()) continue;
        const rawTitle = normalizeText(
          (noteItem as unknown as { getNoteTitle?: () => unknown }).getNoteTitle?.() || "",
        ).trim();
        results.push({
          noteId: noteItem.id,
          title: rawTitle || `Note ${noteItem.id}`,
          noteText: text.length > 10000 ? `${text.slice(0, 10000)}\u2026` : text,
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
        const annotationIds: number[] = (
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
          const comment = normalizeText(ann.annotationComment || "") || undefined;
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
            pageLabel: normalizeText(ann.annotationPageLabel || "") || undefined,
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
    invalidatePaperSearchCache(libraryID);
    const allCollections = listLibraryCollections(libraryID);
    const pathMap = buildCollectionPathMap(allCollections);
    return {
      collectionId: collection.id,
      name: normalizedName,
      libraryID,
      path: pathMap.get(collection.id) || normalizedName,
    };
  }

  async deleteCollection(params: { collectionId: number }): Promise<void> {
    const collection = this.getCollection(params.collectionId);
    if (!collection) return;
    const libraryID = Number(collection.libraryID) || 0;
    await (collection as unknown as { eraseTx: () => Promise<void> }).eraseTx();
    if (libraryID > 0) invalidatePaperSearchCache(libraryID);
  }

  async removeTagsFromItem(params: {
    itemId: number;
    tags: string[];
  }): Promise<void> {
    const item = this.resolveBibliographicItem(this.getItem(params.itemId));
    if (!item || !params.tags.length) return;
    let changed = false;
    for (const tag of params.tags) {
      if (!tag) continue;
      if (item.hasTag?.(tag)) {
        item.removeTag?.(tag);
        changed = true;
      }
    }
    if (changed) {
      await item.saveTx();
    }
  }

  async removeItemFromCollection(params: {
    itemId: number;
    collectionId: number;
  }): Promise<void> {
    const item = this.resolveBibliographicItem(this.getItem(params.itemId));
    if (!item) return;
    item.removeFromCollection(params.collectionId);
    await item.saveTx();
    const collection = this.getCollection(params.collectionId);
    const libraryID = Number(collection?.libraryID) || 0;
    if (libraryID > 0) invalidatePaperSearchCache(libraryID);
  }

  async findRelatedPapersInLibrary(params: {
    libraryID: number;
    referenceItemId: number;
    limit?: number;
  }): Promise<{
    referenceTitle: string;
    relatedPapers: RelatedPaperResult[];
  }> {
    const libraryID =
      Number.isFinite(params.libraryID) ? Math.floor(params.libraryID) : 0;
    if (!libraryID) throw new Error("No active library available");
    const referenceItem = this.resolveBibliographicItem(
      this.getItem(params.referenceItemId),
    );
    if (!referenceItem) throw new Error("Reference paper not found");
    const referenceTarget = buildPaperTargetFromItem(referenceItem);
    if (!referenceTarget) throw new Error("Reference paper has no PDF attachment");
    const limit =
      Number.isFinite(params.limit) && (params.limit as number) > 0
        ? Math.floor(params.limit as number)
        : 10;
    const refTitle = normalizeText(referenceTarget.title).toLowerCase();
    const refTitleWords = new Set(
      refTitle.split(/\W+/).filter((w) => w.length > 3),
    );
    const refAuthor = normalizeText(referenceTarget.firstCreator || "").toLowerCase();
    const refYear = referenceTarget.year ? Number(referenceTarget.year) : null;
    const refJournal = normalizeText(
      String(referenceItem.getField?.("publicationTitle") ?? ""),
    ).toLowerCase();
    const candidates = await listLibraryPaperCandidates(libraryID);
    const scored: RelatedPaperResult[] = [];
    for (const candidate of candidates) {
      if (candidate.itemId === referenceTarget.itemId) continue;
      const item = this.resolveBibliographicItem(this.getItem(candidate.itemId));
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
      const sharedWords = [...refTitleWords].filter((w) => candTitleWords.has(w));
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
        reasons.push(
          `Same journal: ${item.getField?.("publicationTitle")}`,
        );
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
    const libraryID =
      Number.isFinite(params.libraryID) ? Math.floor(params.libraryID) : 0;
    if (!libraryID) throw new Error("No active library available");
    const limit =
      Number.isFinite(params.limit) && (params.limit as number) > 0
        ? Math.floor(params.limit as number)
        : 20;
    const candidates = await listLibraryPaperCandidates(libraryID);
    const byDoi = new Map<string, LibraryPaperTarget[]>();
    const byNormalizedTitle = new Map<string, LibraryPaperTarget[]>();
    for (const candidate of candidates) {
      const item = this.resolveBibliographicItem(this.getItem(candidate.itemId));
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
    const item = resolveRegularItem(params.item);
    if (!item) {
      throw new Error("No Zotero bibliographic item is active for metadata editing");
    }

    const fieldNames = EDITABLE_ARTICLE_METADATA_FIELDS.filter((fieldName) =>
      Object.prototype.hasOwnProperty.call(params.metadata, fieldName),
    );
    const unsupportedFields = fieldNames.filter(
      (fieldName) => !isFieldValidForItemType(item, fieldName),
    );
    if (unsupportedFields.length) {
      const itemTypeName = getItemTypeName(item) || "this item type";
      throw new Error(
        `Unsupported metadata fields for ${itemTypeName}: ${unsupportedFields.join(", ")}`,
      );
    }

    for (const fieldName of fieldNames) {
      item.setField(fieldName, params.metadata[fieldName] || "");
    }

    if (Array.isArray(params.metadata.creators)) {
      const creatorTypes = (Zotero as unknown as {
        CreatorTypes?: { itemTypeHasCreators?: (itemTypeId: number) => boolean };
      }).CreatorTypes;
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

  async trashItems(params: {
    itemIds: number[];
  }): Promise<{
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
    const touchedLibraryIDs = new Set<number>();
    for (const itemId of params.itemIds) {
      const item = this.getItem(itemId);
      if (!item) {
        items.push({ itemId, title: `Item ${itemId}`, status: "skipped", reason: "Item not found" });
        continue;
      }
      const title = String(item.getField?.("title") || `Item ${itemId}`);
      if (item.deleted) {
        items.push({ itemId, title, status: "skipped", reason: "Already in trash" });
        continue;
      }
      try {
        item.deleted = true;
        await item.saveTx();
        trashedCount++;
        touchedLibraryIDs.add(Number(item.libraryID));
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
    for (const libraryID of touchedLibraryIDs) {
      invalidatePaperSearchCache(libraryID);
    }
    return { trashedCount, items };
  }

  async restoreItems(params: { itemIds: number[] }): Promise<void> {
    const touchedLibraryIDs = new Set<number>();
    for (const itemId of params.itemIds) {
      const item = this.getItem(itemId);
      if (!item || !item.deleted) continue;
      item.deleted = false;
      await item.saveTx();
      touchedLibraryIDs.add(Number(item.libraryID));
    }
    for (const libraryID of touchedLibraryIDs) {
      invalidatePaperSearchCache(libraryID);
    }
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
  ): Promise<{ succeeded: number; failed: number }> {
    let succeeded = 0;
    let failed = 0;
    const targetLibraryID =
      libraryID ??
      (Zotero as unknown as { Libraries?: { userLibraryID?: number } })
        .Libraries?.userLibraryID ??
      1;

    for (const rawId of identifiers) {
      try {
        const isArXiv = rawId.startsWith("arxiv:");
        const identifier: Record<string, string> = isArXiv
          ? { arXiv: rawId.slice("arxiv:".length) }
          : { DOI: rawId.replace(/^https?:\/\/doi\.org\//i, "") };

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
          continue;
        }
        translate.setTranslator(translators);
        const items = await translate.translate({ libraryID: targetLibraryID });
        if (items && items.length > 0) {
          succeeded += items.length;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }

    return { succeeded, failed };
  }
}
