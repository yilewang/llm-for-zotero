/**
 * `ZoteroGateway` — the single surface the agent, its tools and the panel use
 * to reach Zotero.
 *
 * The class is a thin facade. Each group of operations lives in its own
 * capability under `src/agent/services/zotero/`, held here as one instance and
 * reached through a one-line delegation with an unchanged signature. The
 * architecture check (`FACADES` in `scripts/check-architecture-boundaries.cjs`)
 * refuses an import into that directory from anywhere but this file, so this is
 * the one place those names cross the boundary.
 *
 * The capability map:
 *
 * - `zotero/itemCapability.ts` — items: finding, listing, searching, and the
 *   writes that change what an item is (create, reparent, relate, metadata,
 *   trash, restore, merge).
 * - `zotero/collectionCapability.ts` — the collection tree, what is filed
 *   where, collection lifecycle, and the saved searches the same executor owns.
 * - `zotero/tagCapability.ts` — library tags, tag assignment, and the
 *   tag-scoped listings.
 * - `zotero/noteCapability.ts` — reading, searching, writing and restoring
 *   notes, and the annotations attached to a paper.
 * - `zotero/attachmentCapability.ts` — child attachments: their info, indexing,
 *   rename, relink, delete, and note-image import.
 * - `zotero/importCapability.ts` — bringing new items in: local files,
 *   bibliography files, and identifier lookups through Zotero's translators.
 * - `zotero/settingsCapability.ts` — preferences, sync state, export
 *   translators and citation formatting.
 * - `zotero/internal/` — the shared substrate all of them use: item
 *   resolution, target builders, library-index paging and filtering, metadata
 *   tables, collection helpers, normalisation.
 *
 * What stays on the facade is the scope-resolution surface every capability is
 * called *with* rather than *by*: which library, which papers are in scope, and
 * which item the user is looking at (`resolveLibraryID`, `listAllLibraries`,
 * `resolveLibraryScopeItemIds`, `listLibraryPaperTargets`, `listPaperContexts`,
 * `resolvePaperContextTarget`, `getActiveContextItem`, `getActivePaperContext`),
 * plus the trivial resolvers the capabilities take as dependencies (`getItem`,
 * `getCollection`, `getCollectionSummary`, `resolveBibliographicItem`) so an
 * instance-level override in a test still steers every path below them, and two
 * one-line calls into Zotero that belong to no capability
 * (`getItemByLibraryAndKey`, `invalidateLibrarySearchCache`).
 */

import { libraryIndexService } from "../../services/libraryIndexService";
import { resolvePaperScope } from "../../services/libraryIndex/paperScope";
import type { NoteImageImportInput } from "../../services/notes/noteImages";
import {
  getSelectedContextAttachment,
  resolveSelectedContextItem,
} from "../../services/context/contextSelectionBridge";
import { resolvePaperContextRefFromAttachment } from "../../services/paperContent/paperAttribution";
import type { AgentRuntimeRequest } from "../types";
import { getTurnPapers } from "../context/requestTurnPaperScope";
import type {
  GeneratedChatImage,
  PaperContextRef,
  TagContextRef,
} from "../../shared/types";
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
import {
  getCollection,
  getCollectionSummary,
} from "./zotero/internal/collections";
import {
  getItem,
  resolveBibliographicItem,
} from "./zotero/internal/itemResolution";
import {
  orderedGatewayPaperIds,
  pageIds,
} from "./zotero/internal/libraryIndex";
import { normalizePaperContexts } from "./zotero/internal/normalize";
import {
  buildPaperTargetFromItem,
  buildPaperTargetsForIds,
} from "./zotero/internal/targetBuilders";
import type {
  AgentLibraryFilters,
  AgentSearchCondition,
  CollectionSummary,
  LibraryItemTarget,
  LibraryItemTargetAttachment,
  LibraryPaperTarget,
} from "./zotero/internal/types";
import { AttachmentCapability } from "./zotero/attachmentCapability";
import {
  CollectionCapability,
  type BatchMoveAssignment,
  type BatchMoveItemResult,
  type CollectionBrowseNode,
  type ItemCollectionSet,
} from "./zotero/collectionCapability";
import { ImportCapability } from "./zotero/importCapability";
import {
  NoteCapability,
  type PaperAnnotationRecord,
  type PaperNoteRecord,
  type SaveAnswerToNoteResult,
} from "./zotero/noteCapability";
import {
  ItemCapability,
  type DuplicateGroup,
  type RelatedPaperResult,
} from "./zotero/itemCapability";
import { SettingsCapability } from "./zotero/settingsCapability";
import { TagCapability, type BatchTagItemResult } from "./zotero/tagCapability";

/**
 * The shared substrate every capability needs, re-exported under the names
 * callers already use.
 *
 * `src/agent/services/zotero/` is the gateway's internals: the architecture
 * check refuses an import into it from anywhere but this file, so this is the
 * one place the names cross the boundary.
 */
export type {
  AgentLibraryFilters,
  AgentSearchCondition,
  AgentSearchConditionError,
  CollectionSummary,
  LibraryItemTarget,
  LibraryItemTargetAttachment,
  LibraryPaperTarget,
  LibraryPaperTargetAttachment,
} from "./zotero/internal/types";
export { listEditableFieldsForItem } from "./zotero/internal/itemResolution";
export { validateSearchConditions } from "./zotero/internal/libraryIndex";
export { EDITABLE_ARTICLE_METADATA_FIELDS } from "./zotero/internal/metadataTables";
export type {
  PaperAnnotationRecord,
  PaperNoteRecord,
  SaveAnswerToNoteResult,
} from "./zotero/noteCapability";
export type { BatchTagItemResult } from "./zotero/tagCapability";
export type {
  DuplicateGroup,
  RelatedPaperResult,
} from "./zotero/itemCapability";
export type {
  BatchMoveAssignment,
  BatchMoveItemResult,
  CollectionBrowseNode,
  ItemCollectionSet,
} from "./zotero/collectionCapability";

export class ZoteroGateway {
  /**
   * The import paths, split out of this file.
   *
   * The dependencies are thunks rather than bound methods so the lookup they
   * reach is resolved per call: a caller (and every test in
   * `importTranslateAndIdentifiers.test.ts`) that replaces `getItem` or
   * `getCollection` on a gateway instance still steers the import paths.
   */
  private readonly importCapability = new ImportCapability({
    getItem: (itemId) => this.getItem(itemId),
    getCollection: (collectionId) => this.getCollection(collectionId),
    getEditableArticleMetadata: (item) => this.getEditableArticleMetadata(item),
  });

  /**
   * The note paths, split out of this file. Same thunk wiring as the import
   * capability, for the same reason.
   */
  private readonly noteCapability = new NoteCapability({
    getItem: (itemId) => this.getItem(itemId),
    resolveBibliographicItem: (item) => this.resolveBibliographicItem(item),
  });

  /**
   * The attachment paths, split out of this file. Same thunk wiring as the
   * import capability, for the same reason.
   */
  private readonly attachmentCapability = new AttachmentCapability({
    getItem: (itemId) => this.getItem(itemId),
    resolveBibliographicItem: (item) => this.resolveBibliographicItem(item),
  });

  /**
   * The tag paths, split out of this file. Same thunk wiring as the import
   * capability, for the same reason.
   */
  private readonly tagCapability = new TagCapability({
    getItem: (itemId) => this.getItem(itemId),
    resolveBibliographicItem: (item) => this.resolveBibliographicItem(item),
  });

  /**
   * The collection and saved-search paths, split out of this file. Same thunk
   * wiring as the import capability, for the same reason — and here the
   * reason is load-bearing: `collectionMoveSemantics.test.ts` replaces both
   * `getItem` and `getCollectionSummary` on a gateway instance.
   */
  private readonly collectionCapability = new CollectionCapability({
    getItem: (itemId) => this.getItem(itemId),
    getCollection: (collectionId) => this.getCollection(collectionId),
    getCollectionSummary: (collectionId) =>
      this.getCollectionSummary(collectionId),
    resolveBibliographicItem: (item) => this.resolveBibliographicItem(item),
  });

  /**
   * The item paths, split out of this file. Same thunk wiring as the import
   * capability, for the same reason: `metadataFieldWidening.test.ts` and the
   * journey tests replace `getItem` on a gateway instance and still expect the
   * item paths to see it.
   */
  private readonly itemCapability = new ItemCapability({
    getItem: (itemId) => this.getItem(itemId),
    getCollectionSummary: (collectionId) =>
      this.getCollectionSummary(collectionId),
    resolveBibliographicItem: (item) => this.resolveBibliographicItem(item),
  });

  /**
   * The preference, sync, export and citation paths, split out of this file.
   * Same thunk wiring as the import capability, for the same reason.
   */
  private readonly settingsCapability = new SettingsCapability({
    getItem: (itemId) => this.getItem(itemId),
  });

  getItemByLibraryAndKey(libraryID: number, key: string): Zotero.Item | null {
    return Zotero.Items.getByLibraryAndKey(libraryID, key) || null;
  }

  getItem(itemId: number | undefined): Zotero.Item | null {
    return getItem(itemId);
  }

  getCollection(collectionId: number | undefined): Zotero.Collection | null {
    return getCollection(collectionId);
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
    return getCollectionSummary(collectionId);
  }

  /** See `CollectionCapability.getCollectionNativeState`. */
  getCollectionNativeState(collectionId: number): {
    exists: boolean;
    name: string;
    parentCollectionId: number | null;
    deleted: boolean;
  } {
    return this.collectionCapability.getCollectionNativeState(collectionId);
  }

  /** See `CollectionCapability.listCollectionSummaries`. */
  listCollectionSummaries(libraryID: number): CollectionSummary[] {
    return this.collectionCapability.listCollectionSummaries(libraryID);
  }

  /** See `CollectionCapability.listCurrentCollectionSummaries`. */
  listCurrentCollectionSummaries(libraryID: number): CollectionSummary[] {
    return this.collectionCapability.listCurrentCollectionSummaries(libraryID);
  }

  /** See `CollectionCapability.listCurrentCollectionTargetIds`. */
  listCurrentCollectionTargetIds(params: {
    libraryID: number;
    collectionId: number;
    targetKind: "papers" | "items";
  }): number[] {
    return this.collectionCapability.listCurrentCollectionTargetIds(params);
  }

  /** See `CollectionCapability.listCurrentLibraryTargetIds`. */
  async listCurrentLibraryTargetIds(params: {
    libraryID: number;
    targetKind: "papers" | "items";
  }): Promise<number[]> {
    return this.collectionCapability.listCurrentLibraryTargetIds(params);
  }

  /** See `AttachmentCapability.getAllChildAttachmentInfos`. */
  async getAllChildAttachmentInfos(
    itemId: number,
  ): Promise<LibraryItemTargetAttachment[]> {
    return this.attachmentCapability.getAllChildAttachmentInfos(itemId);
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

  /** See `ItemCapability.getPaperTargetsByItemIds`. */
  getPaperTargetsByItemIds(itemIds: number[]): LibraryPaperTarget[] {
    return this.itemCapability.getPaperTargetsByItemIds(itemIds);
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

  /** See `ItemCapability.listBibliographicItemTargets`. */
  async listBibliographicItemTargets(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    items: LibraryItemTarget[];
    totalCount: number;
  }> {
    return this.itemCapability.listBibliographicItemTargets(params);
  }

  /** See `ItemCapability.getBibliographicItemTargetsByItemIds`. */
  getBibliographicItemTargetsByItemIds(itemIds: number[]): LibraryItemTarget[] {
    return this.itemCapability.getBibliographicItemTargetsByItemIds(itemIds);
  }

  resolveBibliographicItem(
    item: Zotero.Item | null | undefined,
  ): Zotero.Item | null {
    return resolveBibliographicItem(item);
  }

  /** See `ItemCapability.resolveMetadataItem`. */
  resolveMetadataItem(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    itemId?: number;
    paperContext?: PaperContextRef | null;
  }): Zotero.Item | null {
    return this.itemCapability.resolveMetadataItem(params);
  }

  getActiveContextItem(
    item: Zotero.Item | null | undefined,
  ): Zotero.Item | null {
    if (item) {
      return resolveSelectedContextItem(item);
    }
    return getSelectedContextAttachment();
  }

  getActivePaperContext(
    item: Zotero.Item | null | undefined,
  ): PaperContextRef | null {
    return resolvePaperContextRefFromAttachment(
      this.getActiveContextItem(item),
    );
  }

  /** The note an edit applies to. See `NoteCapability.resolveActiveNoteItem`. */
  resolveActiveNoteItem(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    noteId?: number;
  }): Zotero.Item | null {
    return this.noteCapability.resolveActiveNoteItem(params);
  }

  /** See `NoteCapability.getActiveNoteSnapshot`. */
  getActiveNoteSnapshot(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    noteId?: number;
  }) {
    return this.noteCapability.getActiveNoteSnapshot(params);
  }

  /** See `NoteCapability.replaceCurrentNote`. */
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
    return this.noteCapability.replaceCurrentNote(params);
  }

  /** See `NoteCapability.restoreNoteHtml`. */
  async restoreNoteHtml(params: {
    noteId: number;
    html: string;
  }): Promise<void> {
    return this.noteCapability.restoreNoteHtml(params);
  }

  /** See `ItemCapability.getEditableArticleMetadata`. */
  getEditableArticleMetadata(
    item: Zotero.Item | null | undefined,
  ): EditableArticleMetadataSnapshot | null {
    return this.itemCapability.getEditableArticleMetadata(item);
  }

  /** See `ItemCapability.isEditableArticleMetadataFieldSupported`. */
  isEditableArticleMetadataFieldSupported(
    item: Zotero.Item | null | undefined,
    fieldName: EditableArticleMetadataField,
  ): boolean {
    return this.itemCapability.isEditableArticleMetadataFieldSupported(
      item,
      fieldName,
    );
  }

  /** See `ItemCapability.supportsEditableArticleCreators`. */
  supportsEditableArticleCreators(
    item: Zotero.Item | null | undefined,
  ): boolean {
    return this.itemCapability.supportsEditableArticleCreators(item);
  }

  listPaperContexts(request: AgentRuntimeRequest): PaperContextRef[] {
    return normalizePaperContexts([...getTurnPapers(request)]);
  }

  /** See `CollectionCapability.browseCollections`. */
  async browseCollections(params: { libraryID: number }): Promise<{
    libraryID: number;
    libraryName: string;
    collections: CollectionBrowseNode[];
    unfiled: {
      name: string;
      paperCount: number;
    };
  }> {
    return this.collectionCapability.browseCollections(params);
  }

  /** See `CollectionCapability.listCollectionPaperTargets`. */
  async listCollectionPaperTargets(params: {
    libraryID: number;
    collectionId: number;
    limit?: number;
  }): Promise<{
    collection: CollectionSummary;
    papers: LibraryPaperTarget[];
    totalCount: number;
  }> {
    return this.collectionCapability.listCollectionPaperTargets(params);
  }

  /** See `CollectionCapability.listUnfiledPaperTargets`. */
  async listUnfiledPaperTargets(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    papers: LibraryPaperTarget[];
    totalCount: number;
  }> {
    return this.collectionCapability.listUnfiledPaperTargets(params);
  }

  /** See `TagCapability.listUntaggedPaperTargets`. */
  async listUntaggedPaperTargets(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    papers: LibraryPaperTarget[];
    totalCount: number;
  }> {
    return this.tagCapability.listUntaggedPaperTargets(params);
  }

  /** See `ItemCapability.listLibraryItemTargets`. */
  async listLibraryItemTargets(params: {
    libraryID: number;
    limit?: number;
    itemType?: string;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    return this.itemCapability.listLibraryItemTargets(params);
  }

  /** See `ItemCapability.listCollectionItemTargets`. */
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
    return this.itemCapability.listCollectionItemTargets(params);
  }

  /** See `ItemCapability.listUnfiledItemTargets`. */
  async listUnfiledItemTargets(params: {
    libraryID: number;
    limit?: number;
    itemType?: string;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    return this.itemCapability.listUnfiledItemTargets(params);
  }

  /** See `ItemCapability.listUntaggedItemTargets`. */
  async listUntaggedItemTargets(params: {
    libraryID: number;
    limit?: number;
    itemType?: string;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    return this.itemCapability.listUntaggedItemTargets(params);
  }

  /** See `TagCapability.listTagItemTargets`. */
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
    return this.tagCapability.listTagItemTargets(params);
  }

  async resolveLibraryScopeItemIds(params: {
    libraryID: number;
    itemIds?: number[];
    collectionIds?: number[];
    tagContexts?: TagContextRef[];
    /** Papers the user removed from the task: never part of the scope. */
    excludedItemIds?: readonly number[];
  }): Promise<{
    itemIds: number[];
    tagItemIds: number[];
    collectionNames: string[];
    tagNames: string[];
    summedScopeCount: number;
  }> {
    const snapshot = await libraryIndexService.getSnapshot(params.libraryID);
    return resolvePaperScope(snapshot, params);
  }

  /** See `ItemCapability.searchItemsByConditions`. */
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
    return this.itemCapability.searchItemsByConditions(params);
  }

  /** See `ItemCapability.listItemTypes`. */
  listItemTypes(params?: { itemType?: string; includeFields?: boolean }): {
    itemTypes: Array<{
      itemType: string;
      localized?: string;
      fields?: string[];
      creatorTypes?: string[];
    }>;
  } {
    return this.itemCapability.listItemTypes(params);
  }

  /** See `ItemCapability.createItems`. */
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
    return this.itemCapability.createItems(params);
  }

  /** See `ItemCapability.reparentItems`. */
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
    return this.itemCapability.reparentItems(params);
  }

  /** See `ItemCapability.relateItems`. */
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
    return this.itemCapability.relateItems(params);
  }

  /** See `ItemCapability.listItemsByFilters`. */
  async listItemsByFilters(params: {
    libraryID: number;
    filters?: AgentLibraryFilters;
    limit?: number;
    offset?: number;
    sort?: "dateAdded" | "title";
    order?: "asc" | "desc";
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    return this.itemCapability.listItemsByFilters(params);
  }

  /** See `NoteCapability.listStandaloneNotes`. */
  async listStandaloneNotes(params: {
    libraryID: number;
    collectionId?: number;
    limit?: number;
  }): Promise<{ notes: LibraryItemTarget[]; totalCount: number }> {
    return this.noteCapability.listStandaloneNotes(params);
  }

  /** See `NoteCapability.getStandaloneNoteContent`. */
  getStandaloneNoteContent(params: { noteId: number }): PaperNoteRecord | null {
    return this.noteCapability.getStandaloneNoteContent(params);
  }

  /** See `AttachmentCapability.getAttachmentInfo`. */
  getAttachmentInfo(params: { attachmentId: number }): {
    attachmentId: number;
    parentItemId?: number;
    title: string;
    contentType: string;
    filename?: string;
    hasFile: boolean;
    linkMode: string;
  } | null {
    return this.attachmentCapability.getAttachmentInfo(params);
  }

  /** See `ItemCapability.searchAllLibraryItems`. */
  async searchAllLibraryItems(params: {
    libraryID: number;
    query: string;
    filters?: AgentLibraryFilters;
    allowedItemIds?: number[];
    limit?: number;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    return this.itemCapability.searchAllLibraryItems(params);
  }

  /** See `NoteCapability.searchAllNotes`. */
  async searchAllNotes(params: {
    libraryID: number;
    collectionId?: number;
    query: string;
    limit?: number;
  }): Promise<
    Array<
      LibraryItemTarget & { parentItemId?: number; parentItemTitle?: string }
    >
  > {
    return this.noteCapability.searchAllNotes(params);
  }

  /** See `AttachmentCapability.indexPdfAttachment`. */
  async indexPdfAttachment(params: { attachmentId: number }): Promise<{
    attachmentId: number;
    indexingState: string;
    triggered: boolean;
  }> {
    return this.attachmentCapability.indexPdfAttachment(params);
  }

  /** See `TagCapability.listLibraryTags`. */
  async listLibraryTags(params: {
    libraryID: number;
    query?: string;
    limit?: number;
  }): Promise<{ name: string; type: number }[]> {
    return this.tagCapability.listLibraryTags(params);
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

  /** See `TagCapability.applyTagAssignments`. */
  async applyTagAssignments(params: {
    assignments: BatchTagAssignment[];
  }): Promise<{
    selectedCount: number;
    updatedCount: number;
    skippedCount: number;
    items: BatchTagItemResult[];
  }> {
    return this.tagCapability.applyTagAssignments(params);
  }

  /** See `CollectionCapability.setItemCollections`. */
  async setItemCollections(params: {
    assignments: ItemCollectionSet[];
  }): Promise<{
    items: BatchMoveItemResult[];
    changedCount: number;
    priorCollections: ItemCollectionSet[];
  }> {
    return this.collectionCapability.setItemCollections(params);
  }

  /** See `CollectionCapability.addItemsToCollections`. */
  async addItemsToCollections(params: {
    assignments: BatchMoveAssignment[];
    mode?: "add" | "move";
    from?: number | "all";
  }): Promise<{
    selectedCount: number;
    movedCount: number;
    addedCount: number;
    skippedCount: number;
    collections: CollectionSummary[];
    items: BatchMoveItemResult[];
    priorCollections?: ItemCollectionSet[];
  }> {
    return this.collectionCapability.addItemsToCollections(params);
  }

  /** See `NoteCapability.saveAnswerToNote`. */
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
    return this.noteCapability.saveAnswerToNote(params);
  }

  /** See `NoteCapability.getPaperNotes`. */
  getPaperNotes(params: {
    item: Zotero.Item | null | undefined;
    maxNotes?: number;
  }): PaperNoteRecord[] {
    return this.noteCapability.getPaperNotes(params);
  }

  /** See `NoteCapability.getPaperAnnotations`. */
  getPaperAnnotations(params: {
    item: Zotero.Item | null | undefined;
    maxAnnotations?: number;
  }): PaperAnnotationRecord[] {
    return this.noteCapability.getPaperAnnotations(params);
  }

  /** See `CollectionCapability.createCollection`. */
  async createCollection(params: {
    name: string;
    parentCollectionId?: number;
    libraryID: number;
  }): Promise<CollectionSummary> {
    return this.collectionCapability.createCollection(params);
  }

  /** See `CollectionCapability.snapshotCollectionForDelete`. */
  snapshotCollectionForDelete(params: { collectionId: number }): {
    name: string;
    parentCollectionId?: number;
    libraryID: number;
    itemIds: number[];
    childCollectionCount: number;
  } | null {
    return this.collectionCapability.snapshotCollectionForDelete(params);
  }

  /** See `CollectionCapability.updateCollection`. */
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
    return this.collectionCapability.updateCollection(params);
  }

  /** See `TagCapability.updateLibraryTag`. */
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
    return this.tagCapability.updateLibraryTag(params);
  }

  /** See `TagCapability.setItemTags`. */
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
    return this.tagCapability.setItemTags(params);
  }

  /** See `CollectionCapability.listSavedSearches`. */
  listSavedSearches(libraryID: number): Array<{
    savedSearchId: number;
    name: string;
    conditions: Array<{ condition: string; operator: string; value: string }>;
  }> {
    return this.collectionCapability.listSavedSearches(libraryID);
  }

  /** See `CollectionCapability.saveSavedSearch`. */
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
    return this.collectionCapability.saveSavedSearch(params);
  }

  /** See `CollectionCapability.deleteSavedSearch`. */
  async deleteSavedSearch(params: {
    savedSearchId: number;
    permanent?: boolean;
  }): Promise<{
    savedSearchId: number;
    status: "trashed" | "erased" | "not_found";
  }> {
    return this.collectionCapability.deleteSavedSearch(params);
  }

  /** See `SettingsCapability.listSettings`. */
  listSettings(): Array<{
    key: string;
    value: unknown;
    type: string;
    description: string;
  }> {
    return this.settingsCapability.listSettings();
  }

  /** See `SettingsCapability.getSettingNativeState`. */
  getSettingNativeState(key: string): { exists: boolean; value: unknown } {
    return this.settingsCapability.getSettingNativeState(key);
  }

  /** See `SettingsCapability.restoreSetting`. */
  restoreSetting(params: {
    key: string;
    existed: boolean;
    value?: unknown;
  }): void {
    return this.settingsCapability.restoreSetting(params);
  }

  /** See `SettingsCapability.updateSetting`. */
  async updateSetting(params: { key: string; value: unknown }): Promise<{
    key: string;
    previousValue: unknown;
    value: unknown;
    status: "updated" | "unchanged" | "refused";
    reason?: string;
  }> {
    return this.settingsCapability.updateSetting(params);
  }

  /** See `SettingsCapability.getSyncStatus`. */
  getSyncStatus(): {
    configured: boolean;
    username?: string;
    lastSyncAt?: number;
    inProgress: boolean;
  } {
    return this.settingsCapability.getSyncStatus();
  }

  /** See `SettingsCapability.listExportFormats`. */
  listExportFormats(): Array<{ id: string; label: string }> {
    return this.settingsCapability.listExportFormats();
  }

  /** See `SettingsCapability.exportItems`. */
  async exportItems(params: {
    itemIds: number[];
    translatorId: string;
  }): Promise<{ output: string; itemCount: number }> {
    return this.settingsCapability.exportItems(params);
  }

  /** See `SettingsCapability.listCitationStyles`. */
  listCitationStyles(): Array<{ id: string; title: string }> {
    return this.settingsCapability.listCitationStyles();
  }

  /** See `SettingsCapability.formatBibliography`. */
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
    return this.settingsCapability.formatBibliography(params);
  }

  /** See `SettingsCapability.formatStructuredCitations`. */
  formatStructuredCitations(params: {
    clusters: Array<{
      citationId: string;
      items: Array<{ itemId: number; pageIndex?: number }>;
    }>;
    styleId?: string;
    locale?: string;
  }): {
    styleId: string;
    styleTitle: string;
    locale: string;
    clusters: Array<{ citationId: string; text: string; html: string }>;
    bibliographyEntries: Array<{
      itemId: number;
      text: string;
      html: string;
    }>;
  } {
    return this.settingsCapability.formatStructuredCitations(params);
  }

  /** See `CollectionCapability.deleteCollection`. */
  async deleteCollection(params: {
    collectionId: number;
    deleteItems?: boolean;
    permanent?: boolean;
  }): Promise<void> {
    return this.collectionCapability.deleteCollection(params);
  }

  /** See `CollectionCapability.restoreCollections`. */
  async restoreCollections(params: {
    collectionIds: number[];
  }): Promise<{ restoredCount: number; collectionIds: number[] }> {
    return this.collectionCapability.restoreCollections(params);
  }

  /** See `TagCapability.removeTagsFromItem`. */
  async removeTagsFromItem(params: {
    itemId: number;
    tags: string[];
  }): Promise<{ removed: string[] }> {
    return this.tagCapability.removeTagsFromItem(params);
  }

  /** See `CollectionCapability.getItemCollectionIds`. */
  getItemCollectionIds(itemId: number): number[] {
    return this.collectionCapability.getItemCollectionIds(itemId);
  }

  /** See `CollectionCapability.removeItemFromCollection`. */
  async removeItemFromCollection(params: {
    itemId: number;
    collectionId: number;
  }): Promise<{ removed: boolean; reason?: string }> {
    return this.collectionCapability.removeItemFromCollection(params);
  }

  /** See `ItemCapability.findRelatedPapersInLibrary`. */
  async findRelatedPapersInLibrary(params: {
    libraryID: number;
    referenceItemId: number;
    limit?: number;
  }): Promise<{
    referenceTitle: string;
    relatedPapers: RelatedPaperResult[];
  }> {
    return this.itemCapability.findRelatedPapersInLibrary(params);
  }

  /** See `ItemCapability.detectDuplicatesInLibrary`. */
  async detectDuplicatesInLibrary(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    totalGroups: number;
    groups: DuplicateGroup[];
  }> {
    return this.itemCapability.detectDuplicatesInLibrary(params);
  }

  /** See `ItemCapability.updateArticleMetadata`. */
  async updateArticleMetadata(params: {
    item: Zotero.Item | null;
    metadata: EditableArticleMetadataPatch;
  }): Promise<{
    status: "updated";
    itemId: number;
    title: string;
    changedFields: string[];
  }> {
    return this.itemCapability.updateArticleMetadata(params);
  }

  /** See `ItemCapability.trashItems`. */
  async trashItems(params: { itemIds: number[] }): Promise<{
    trashedCount: number;
    items: Array<{
      itemId: number;
      title: string;
      status: "trashed" | "skipped" | "error";
      reason?: string;
    }>;
  }> {
    return this.itemCapability.trashItems(params);
  }

  /** See `ItemCapability.restoreItems`. */
  async restoreItems(params: {
    itemIds: number[];
  }): Promise<{ restoredCount: number; itemIds: number[] }> {
    return this.itemCapability.restoreItems(params);
  }

  /** See `CollectionCapability.restoreSavedSearches`. */
  async restoreSavedSearches(params: {
    savedSearchIds: number[];
  }): Promise<{ restoredCount: number; savedSearchIds: number[] }> {
    return this.collectionCapability.restoreSavedSearches(params);
  }

  /** See `ItemCapability.mergeItems`. */
  async mergeItems(params: {
    masterItemId: number;
    otherItemIds: number[];
  }): Promise<{
    mergedCount: number;
    masterItemId: number;
    masterTitle: string;
    trashedIds: number[];
  }> {
    return this.itemCapability.mergeItems(params);
  }

  // ── Attachment management ──────────────────────────────────────────

  /**
   * Delete an attachment (moves to trash). See
   * `AttachmentCapability.deleteAttachment`.
   */
  async deleteAttachment(params: { attachmentId: number }): Promise<{
    attachmentId: number;
    title: string;
    status: "deleted" | "not_found";
  }> {
    return this.attachmentCapability.deleteAttachment(params);
  }

  /**
   * Renames an attachment's file on disk. See
   * `AttachmentCapability.renameAttachment`.
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
    return this.attachmentCapability.renameAttachment(params);
  }

  /**
   * Points an attachment at a different file on disk. See
   * `AttachmentCapability.relinkAttachment`.
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
    return this.attachmentCapability.relinkAttachment(params);
  }
  // ── Embed image in note ──────────────────────────────────────────

  /**
   * Import an image file as an embedded note attachment and return its key.
   * The key can then be used in note HTML: <img data-attachment-key="KEY" />
   * See `AttachmentCapability.importNoteImage`.
   */
  async importNoteImage(
    params: NoteImageImportInput,
  ): Promise<{ key: string } | null> {
    return this.attachmentCapability.importNoteImage(params);
  }

  // ── Import local files ──────────────────────────────────────────

  /**
   * Imports a bibliography file (.ris, .bib, ...) through Zotero's
   * translators. See `ImportCapability.importBibliographyFile`.
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
    return this.importCapability.importBibliographyFile(params);
  }

  /**
   * Import local files (PDFs, bibliography files, ...) into the Zotero
   * library. See `ImportCapability.importLocalFiles`.
   */
  async importLocalFiles(params: {
    filePaths: string[];
    libraryID?: number;
    targetCollectionId?: number;
    /**
     * `translate` reads bibliography files through Zotero's translators,
     * `attach` stores the file as an attachment, `auto` picks by extension.
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
    return this.importCapability.importLocalFiles(params);
  }

  /**
   * Fetch canonical metadata for a paper by identifier (DOI, arXiv ID or
   * ISBN) without creating an item. See
   * `ImportCapability.fetchMetadataByIdentifier`.
   */
  async fetchMetadataByIdentifier(
    rawIdentifier: string,
  ): Promise<EditableArticleMetadataPatch | null> {
    return this.importCapability.fetchMetadataByIdentifier(rawIdentifier);
  }

  /**
   * Import papers into the Zotero library by identifier. See
   * `ImportCapability.importPapersByIdentifiers`.
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
    return this.importCapability.importPapersByIdentifiers(
      identifiers,
      libraryID,
      targetCollectionId,
    );
  }

  /** See `ImportCapability.parseImportIdentifier`. */
  private parseImportIdentifier(rawIdentifier: string): Record<string, string> {
    return this.importCapability.parseImportIdentifier(rawIdentifier);
  }

  /** See `ImportCapability.describeUnresolvableIdentifier`. */
  private describeUnresolvableIdentifier(raw: string): string | null {
    return this.importCapability.describeUnresolvableIdentifier(raw);
  }

  /** See `ImportCapability.translatorJsonToPatch`. */
  private translatorJsonToPatch(
    raw: Record<string, unknown>,
  ): EditableArticleMetadataPatch | null {
    return this.importCapability.translatorJsonToPatch(raw);
  }
}
