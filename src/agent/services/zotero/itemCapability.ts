/**
 * Items: finding them, listing them, searching them, and the writes that
 * change what an item is — creating one from scratch, moving it under a
 * different parent, relating a pair, rewriting its metadata, trashing and
 * restoring it, and merging duplicates.
 *
 * Split out of `zoteroGateway.ts`. The capability never names the facade:
 * the item lookups these paths used to reach through `this` arrive as
 * constructor dependencies, so a caller (or a test) that supplies its own
 * lookups gets exactly the behaviour it asked for.
 */

import {
  libraryIndexService,
  normalizeLibraryIndexText,
} from "../../../services/libraryIndexService";
import { appLogger } from "../../../core/logging";
import type { PaperContextRef } from "../../../shared/types";
import type {
  EditableArticleCreator,
  EditableArticleMetadataField,
  EditableArticleMetadataPatch,
  EditableArticleMetadataSnapshot,
} from "../libraryMutation/valueTypes";
import type { AgentRuntimeRequest } from "../../types";
import {
  getItemTypeName,
  isFieldValidForItemType,
  listEditableFieldsForItem,
  resolveMatrixItem,
  resolveRegularItem,
} from "./internal/itemResolution";
import {
  buildAgentLibrarySearch,
  indexItemMatchesType,
  libraryItemTargetMatchesFilters,
  libraryItemTargetMatchesYear,
  orderedGatewayPaperIds,
  orderedIndexIds,
  pageIds,
  planSearchConditions,
  sortAndPageIndexIds,
  validateSearchConditions,
} from "./internal/libraryIndex";
import {
  EDITABLE_ARTICLE_METADATA_FIELDS,
  NON_EDITABLE_METADATA_FIELDS,
  normalizeCreatorForSnapshot,
} from "./internal/metadataTables";
import {
  normalizeMetadataValue,
  normalizeResultLimit,
  normalizeText,
} from "./internal/normalize";
import {
  buildItemTargetFromItem,
  buildItemTargetsForIds,
  buildPaperTargetFromItem,
} from "./internal/targetBuilders";
import type {
  AgentLibraryFilters,
  AgentSearchCondition,
  CollectionSummary,
  ItemLookup,
  LibraryItemTarget,
  LibraryPaperTarget,
} from "./internal/types";

export type RelatedPaperResult = LibraryPaperTarget & {
  matchScore: number;
  matchReasons: string[];
};

/**
 * One set of items Zotero considers duplicates. `papers` holds every regular
 * item in the set, with or without an attachment.
 */
export type DuplicateGroup = {
  matchReason: string;
  papers: LibraryItemTarget[];
};

/**
 * What the item paths need from the rest of the gateway.
 *
 * These are the facade's own resolvers rather than the free functions in
 * `internal/` on purpose: the facade passes thunks that call its methods, so
 * an instance-level override still steers these paths — which is what
 * `metadataFieldWidening.test.ts` and the journey tests rely on when they
 * replace `getItem` on a gateway instance. `resolveBibliographicItem` is both
 * called directly here and completes the `ItemLookup` the shared target
 * builders take, which the gateway satisfied by passing itself.
 */
export type ItemCapabilityDeps = {
  getItem(itemId: number | undefined): Zotero.Item | null;
  getCollectionSummary(
    collectionId: number | undefined,
  ): CollectionSummary | null;
  resolveBibliographicItem(
    item: Zotero.Item | null | undefined,
  ): Zotero.Item | null;
};

export class ItemCapability {
  constructor(private readonly deps: ItemCapabilityDeps) {}

  /**
   * The lookups the shared target builders take, forwarded to the same
   * thunks so an instance-level override still reaches them.
   */
  private readonly itemLookup: ItemLookup = {
    getItem: (itemId) => this.deps.getItem(itemId),
    resolveBibliographicItem: (item) =>
      this.deps.resolveBibliographicItem(item),
  };

  getPaperTargetsByItemIds(itemIds: number[]): LibraryPaperTarget[] {
    const out: LibraryPaperTarget[] = [];
    const seen = new Set<number>();
    for (const rawItemId of itemIds) {
      const item = this.deps.resolveBibliographicItem(
        this.deps.getItem(rawItemId),
      );
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      const target = buildPaperTargetFromItem(item);
      if (target) {
        out.push(target);
      }
    }
    return out;
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
      items: buildItemTargetsForIds(
        this.itemLookup,
        pageIds(ids, params.limit),
      ).filter((target) => !target.noteKind),
      totalCount: ids.length,
    };
  }

  getBibliographicItemTargetsByItemIds(itemIds: number[]): LibraryItemTarget[] {
    const out: LibraryItemTarget[] = [];
    const seen = new Set<number>();
    for (const rawItemId of itemIds) {
      const item = this.deps.resolveBibliographicItem(
        this.deps.getItem(rawItemId),
      );
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      const target = buildItemTargetFromItem(item);
      if (target && !target.noteKind) {
        out.push(target);
      }
    }
    return out;
  }

  resolveMetadataItem(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    itemId?: number;
    paperContext?: PaperContextRef | null;
  }): Zotero.Item | null {
    const byItemId = resolveRegularItem(this.deps.getItem(params.itemId));
    if (byItemId) return byItemId;
    const byPaperContext = resolveRegularItem(
      this.deps.getItem(params.paperContext?.itemId),
    );
    if (byPaperContext) return byPaperContext;
    const byActiveItem = resolveRegularItem(
      this.deps.getItem(params.request?.activeItemId),
    );
    if (byActiveItem) return byActiveItem;
    return resolveRegularItem(params.item || null);
  }

  /**
   * The object a metadata write lands on, or why it may not.
   *
   * `resolveMetadataItem` is a read resolver: it turns a PDF into its paper
   * and falls back to the open item when the id names nothing it likes. On
   * the write path that meant a child attachment's title edit rewrote the
   * parent, and a standalone note's id edited whatever paper was open. A
   * named id is therefore taken exactly as named, and refused rather than
   * redirected; only a write that names no id keeps the paper-context and
   * open-item path.
   */
  resolveMetadataWriteTarget(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    itemId?: number;
    paperContext?: PaperContextRef | null;
  }): { item: Zotero.Item } | { refusal: string } {
    const itemId = Number(params.itemId);
    if (Number.isFinite(itemId) && itemId > 0) {
      const resolution = resolveMatrixItem(
        this.deps.getItem(itemId),
        itemId,
        "update",
      );
      if ("refusal" in resolution) return resolution;
      const target = resolution.item;
      if (target.isNote?.()) {
        return {
          refusal: `Item ${itemId} is a note, which has no metadata fields; edit its text with note_write instead`,
        };
      }
      if (target.isAnnotation?.()) {
        return {
          refusal: `Item ${itemId} is an annotation, which has no metadata fields`,
        };
      }
      return { item: target };
    }
    const fallback = this.resolveMetadataItem({ ...params, itemId: undefined });
    return fallback
      ? { item: fallback }
      : {
          refusal:
            "No item to update: name an itemId, or open the paper whose metadata should change",
        };
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
      items: buildItemTargetsForIds(
        this.itemLookup,
        pageIds(ids, params.limit),
      ),
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
    const collection = this.deps.getCollectionSummary(params.collectionId);
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
      items: buildItemTargetsForIds(
        this.itemLookup,
        pageIds(ids, params.limit),
      ),
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
      items: buildItemTargetsForIds(
        this.itemLookup,
        pageIds(ids, params.limit),
      ),
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
      items: buildItemTargetsForIds(
        this.itemLookup,
        pageIds(ids, params.limit),
      ),
      totalCount: ids.length,
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
   *
   * The simple `filters` (collection, unfiled, item type, author, tag, year)
   * narrow the result by intersection with their own search, never by adding
   * clauses to the condition search: a `fulltextContent` clause matches the
   * child PDF while `collectionID` matches the parent paper, so one
   * joinMode-all search would match nothing. `hasPdf` is not a search clause
   * and is refused rather than ignored.
   */
  async searchItemsByConditions(params: {
    libraryID: number;
    conditions: AgentSearchCondition[];
    joinMode?: "all" | "any";
    resolveToParents?: boolean;
    includeTrashed?: boolean;
    filters?: AgentLibraryFilters;
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
    const filters = params.filters || {};
    if (filters.hasPdf !== undefined) {
      throw new Error(
        "filters.hasPdf cannot be combined with search conditions, because it is applied outside Zotero's search engine.",
      );
    }
    const narrowsByFilters = Boolean(
      filters.collectionId ||
      filters.unfiled ||
      filters.itemType ||
      filters.author ||
      filters.tag ||
      filters.yearFrom != null ||
      filters.yearTo != null,
    );
    const narrowsByYear = filters.yearFrom != null || filters.yearTo != null;

    const search = new Zotero.Search({ libraryID });
    for (const step of planSearchConditions(params)) {
      search.addCondition(
        step.condition as never,
        step.operator as never,
        step.value as never,
        step.required,
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
        // Walk to the top-level item: an annotation's parent is its PDF, and
        // the paper is one level further up. Stopping after one step
        // returned the attachment, which neither deduped with the paper's own
        // match nor passed a collection or tag filter.
        targetId = topLevelItemId(item);
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

    let matching = resolved;
    if (narrowsByFilters) {
      const filterSearch = buildAgentLibrarySearch(libraryID, {
        ...filters,
        deleted: params.includeTrashed === true,
      });
      const allowed = new Set<number>();
      for (const id of (await filterSearch.search()) as number[]) {
        const item = Zotero.Items.get(id);
        // Top-level rows only, as the filtered list keeps them.
        if (!item || item.parentID || item.isAnnotation?.()) continue;
        allowed.add(Number(id));
      }
      matching = matching.filter((id) => allowed.has(id));
    }
    // The SQL date clause only narrows; the exact year bound needs the parsed
    // year, so those targets are built here and reused for the page.
    const prebuilt = new Map<number, LibraryItemTarget>();
    if (narrowsByYear) {
      matching = matching.filter((id) => {
        const item = this.deps.getItem(id);
        const target = item ? buildItemTargetFromItem(item) : null;
        if (!target || !libraryItemTargetMatchesYear(target, filters)) {
          return false;
        }
        prebuilt.set(id, target);
        return true;
      });
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
    const page = matching.slice(offset, offset + limit);

    const items: LibraryItemTarget[] = [];
    for (const itemId of page) {
      const cached = prebuilt.get(itemId);
      if (cached) {
        items.push(cached);
        continue;
      }
      const item = this.deps.getItem(itemId);
      if (!item) continue;
      const target = buildItemTargetFromItem(item);
      if (target) items.push(target);
    }

    const nextOffset = offset + page.length;
    return {
      items,
      totalCount: matching.length,
      returnedCount: items.length,
      offset,
      nextOffset: nextOffset < matching.length ? nextOffset : undefined,
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
      const rawItem = this.deps.getItem(assignment.itemId);
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
        const parent = this.deps.getItem(assignment.parentItemId);
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
    const rawItem = this.deps.getItem(params.itemId);
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
      const otherRaw = this.deps.getItem(relatedItemId);
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
          this.itemLookup,
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
      appLogger.debug(
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
        this.itemLookup,
        sortAndPageIndexIds(snapshot, ids, params),
      ),
      totalCount: ids.length,
    };
  }

  async searchAllLibraryItems(params: {
    libraryID: number;
    query: string;
    filters?: AgentLibraryFilters;
    allowedItemIds?: number[];
    limit?: number;
    offset?: number;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID || !params.query?.trim()) {
      return { items: [], totalCount: 0 };
    }
    const normalizedLimit = normalizeResultLimit(params.limit) || 50;
    const offset =
      Number.isFinite(params.offset) && Number(params.offset) > 0
        ? Math.floor(Number(params.offset))
        : 0;
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
        // An annotation sits two levels down (annotation -> PDF -> paper), so
        // a single parent hop would name the PDF, not the paper.
        const topId = topLevelItemId(item);
        if (allowedItemIds && !allowedItemIds.has(topId)) continue;
        if (!seen.has(topId)) {
          seen.add(topId);
          resolvedIds.push(topId);
        }
      }
      const targets: LibraryItemTarget[] = [];
      for (const itemId of resolvedIds) {
        const item = this.deps.getItem(itemId);
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
        items: targets.slice(offset, offset + normalizedLimit),
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
    const referenceItem = this.deps.resolveBibliographicItem(
      this.deps.getItem(params.referenceItemId),
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
      const item = this.deps.resolveBibliographicItem(
        this.deps.getItem(candidateId),
      );
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

  /**
   * Duplicate groups as Zotero's own Duplicate Items view finds them.
   *
   * Grouping is `Zotero.Duplicates`: same ISBN (books), same DOI, or same
   * normalised title with a shared creator and a year within one, never
   * across a conflicting DOI or ISBN; trashed items are excluded. It runs
   * over every regular item, so a metadata-only record and its PDF-backed
   * twin land in one group. The scan this replaced walked PDF-backed papers
   * only and reported the capped page size as the total.
   *
   * Groups are ordered by their lowest item id so `offset` pages stably;
   * `totalGroups` counts every group, not the page.
   */
  async detectDuplicatesInLibrary(params: {
    libraryID: number;
    limit?: number;
    offset?: number;
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
    const offset =
      Number.isFinite(params.offset) && Number(params.offset) > 0
        ? Math.floor(Number(params.offset))
        : 0;

    const idSets = await findZoteroDuplicateSets(libraryID);
    const groupIds: number[][] = [];
    for (const ids of idSets) {
      const members = ids.filter((id) => {
        const item = this.deps.getItem(id);
        return Boolean(item?.isRegularItem?.() && !item.deleted);
      });
      if (members.length >= 2) groupIds.push(members);
    }

    const groups: DuplicateGroup[] = [];
    for (const ids of groupIds.slice(offset, offset + limit)) {
      const members = ids
        .map((id) => this.deps.getItem(id))
        .filter((item): item is Zotero.Item => Boolean(item));
      const papers = members
        .map((item) => buildItemTargetFromItem(item))
        .filter((target): target is LibraryItemTarget => Boolean(target));
      groups.push({ matchReason: duplicateMatchReason(members), papers });
    }
    return { totalGroups: groupIds.length, groups };
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
      const item = this.deps.getItem(itemId);
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
      const item = this.deps.getItem(itemId);
      if (!item || !item.deleted) continue;
      item.deleted = false;
      await item.saveTx();
      restored.push(Number(item.id));
    }
    return { restoredCount: restored.length, itemIds: restored };
  }

  // ── Merge duplicates ──────────────────────────────────────────────

  /**
   * Why these duplicate groups may not be merged, or null when they may.
   *
   * Every item must exist, be a regular item, be out of the trash, and sit in
   * the one library all the groups share: Zotero cannot merge across
   * libraries, and a duplicate already in the trash is what an earlier merge
   * leaves, so re-running a group that already merged is refused here rather
   * than merged twice.
   */
  mergeRefusal(
    groups: ReadonlyArray<{ masterItemId: number; otherItemIds: number[] }>,
  ): string | null {
    let libraryID: number | undefined;
    for (const group of groups) {
      for (const itemId of [group.masterItemId, ...group.otherItemIds]) {
        const role =
          itemId === group.masterItemId ? "Master item" : "Duplicate item";
        const item = this.deps.getItem(itemId);
        if (!item) {
          return `${role} ${itemId} no longer exists, so its group (master ${group.masterItemId}) cannot be merged.`;
        }
        if (item.isRegularItem?.() !== true) {
          return `${role} ${itemId} is not a regular item (notes, attachments and annotations cannot be merged).`;
        }
        if ((item as Zotero.Item & { deleted?: boolean }).deleted) {
          return `${role} ${itemId} is already in the trash, as a merged duplicate is; leave it out, or restore it before merging.`;
        }
        const itemLibraryID = Number(item.libraryID);
        if (libraryID === undefined) libraryID = itemLibraryID;
        if (itemLibraryID !== libraryID) {
          return `Item ${itemId} is in a different library than the other items, and Zotero cannot merge across libraries.`;
        }
      }
    }
    return null;
  }

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
    const masterItem = this.deps.getItem(params.masterItemId);
    if (!masterItem)
      throw new Error(`Master item ${params.masterItemId} not found`);
    const masterTitle = String(
      masterItem.getField?.("title") || `Item ${params.masterItemId}`,
    );

    const others: Zotero.Item[] = [];
    for (const otherId of params.otherItemIds) {
      if (otherId === params.masterItemId) continue;
      const otherItem = this.deps.getItem(otherId);
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
}

/**
 * The id of the top-level item above `item`: the paper for an annotation
 * (annotation -> PDF -> paper), a note or attachment's parent, or the item
 * itself when it has no parent. The visited set stops a corrupt parent cycle.
 */
function topLevelItemId(item: Zotero.Item): number {
  let current: Zotero.Item = item;
  const visited = new Set<number>([Number(current.id)]);
  for (;;) {
    const parentID = Number(
      (current as { parentID?: number | false }).parentID || 0,
    );
    if (!parentID || visited.has(parentID)) break;
    const parent = Zotero.Items.get(parentID) as Zotero.Item | false | null;
    if (!parent) return parentID;
    visited.add(parentID);
    current = parent;
  }
  return Number(current.id);
}

type ZoteroDuplicatesEngine = {
  getSearchObject(): Promise<{
    conditions?: Record<
      string,
      { condition?: string; operator?: string; value?: unknown }
    >;
    search(): Promise<number[]>;
  }>;
  getSetItemsByItemID(itemID: number): number[];
};

/**
 * Every duplicate set in the library, from Zotero's own engine, each sorted
 * by item id and the sets ordered by their lowest id.
 *
 * `getSearchObject` runs the matching and backs its search with a temporary
 * table that Zotero's own caller drops when the view closes, so it is
 * dropped here once the ids are read.
 */
async function findZoteroDuplicateSets(libraryID: number): Promise<number[][]> {
  const Duplicates = (
    Zotero as unknown as {
      Duplicates?: new (libraryID: number) => ZoteroDuplicatesEngine;
    }
  ).Duplicates;
  if (typeof Duplicates !== "function") {
    throw new Error(
      "This Zotero build does not expose Zotero.Duplicates, so duplicates cannot be detected.",
    );
  }
  const duplicates = new Duplicates(libraryID);
  const search = await duplicates.getSearchObject();
  let ids: number[];
  try {
    ids = (await search.search()).map(Number);
  } finally {
    const tempTable = Object.values(search.conditions || {}).find(
      (condition) => condition?.condition === "tempTable",
    )?.value;
    if (typeof tempTable === "string" && /^\w+$/.test(tempTable)) {
      try {
        // Not cached, as Zotero's own drop of this table is: a cached
        // statement would hold a handle on the table it just removed.
        await Zotero.DB.queryAsync(
          `DROP TABLE IF EXISTS ${tempTable}`,
          undefined,
          {
            noCache: true,
          },
        );
      } catch (error) {
        appLogger.warn("Could not drop the duplicates temp table", error);
      }
    }
  }
  const live = new Set(ids);
  const assigned = new Set<number>();
  const sets: number[][] = [];
  for (const id of [...live].sort((a, b) => a - b)) {
    if (assigned.has(id)) continue;
    const members = duplicates
      .getSetItemsByItemID(id)
      .map(Number)
      .filter((member) => live.has(member) && !assigned.has(member))
      .sort((a, b) => a - b);
    for (const member of members) assigned.add(member);
    if (members.length >= 2) sets.push(members);
  }
  return sets;
}

/**
 * Why a set matched, from the fields Zotero's engine compares: a DOI or ISBN
 * two members share, otherwise the title rule.
 */
function duplicateMatchReason(items: Zotero.Item[]): string {
  const shared = (read: (item: Zotero.Item) => string): string | undefined => {
    const seen = new Set<string>();
    for (const item of items) {
      const value = read(item);
      if (!value) continue;
      if (seen.has(value)) return value;
      seen.add(value);
    }
    return undefined;
  };
  const field = (item: Zotero.Item, name: string): string => {
    try {
      return normalizeText(String(item.getField?.(name) ?? ""));
    } catch {
      // getField throws for a field the item type does not have.
      return "";
    }
  };
  const doi = shared((item) => field(item, "DOI").toLowerCase());
  if (doi) return `Same DOI: ${doi}`;
  const isbn = shared((item) =>
    field(item, "ISBN")
      .replace(/[^0-9X]/gi, "")
      .toUpperCase(),
  );
  if (isbn) return `Same ISBN: ${isbn}`;
  return "Same title";
}
