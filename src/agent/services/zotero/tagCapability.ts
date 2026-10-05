/**
 * Tags: what tags a library holds, which items carry one, putting tags on
 * items and taking them off, and the tag itself as an object to rename,
 * merge, delete or colour.
 *
 * Split out of `zoteroGateway.ts`. The capability never names the facade:
 * the item lookups the tag paths used to reach through `this` arrive as
 * constructor dependencies, so a caller (or a test) that supplies its own
 * lookup gets exactly the behaviour it asked for.
 */

import { indexItemMatchesAggregateTagScope } from "../../../services/libraryIndex/paperScope";
import { libraryIndexService } from "../../../services/libraryIndexService";
import type { TagContextRef } from "../../../shared/types";
import type { BatchTagAssignment } from "../libraryMutation/valueTypes";
import { resolveMatrixItem } from "./internal/itemResolution";
import {
  indexItemMatchesType,
  orderedGatewayPaperIds,
  orderedIndexIds,
  pageIds,
} from "./internal/libraryIndex";
import { normalizeText } from "./internal/normalize";
import {
  buildItemTargetsForIds,
  buildPaperTargetFromItem,
  buildPaperTargetsForIds,
} from "./internal/targetBuilders";
import type {
  ItemLookup,
  LibraryItemTarget,
  LibraryPaperTarget,
} from "./internal/types";

export type BatchTagItemResult = {
  itemId: number;
  title: string;
  status: "updated" | "skipped" | "missing";
  addedTags: string[];
  skippedTags: string[];
  reason?: string;
};

/**
 * What the tag paths need from the rest of the gateway.
 *
 * `getItem` is the facade's own resolver rather than the free function in
 * `internal/` on purpose: the facade passes thunks that call its methods, so
 * an instance-level override still steers the tag paths.
 * `resolveBibliographicItem` is never called directly here — it completes the
 * `ItemLookup` the shared target builders take, which the gateway satisfied
 * by passing itself.
 */
export type TagCapabilityDeps = {
  getItem(itemId: number | undefined): Zotero.Item | null;
  resolveBibliographicItem(
    item: Zotero.Item | null | undefined,
  ): Zotero.Item | null;
};

export class TagCapability {
  constructor(private readonly deps: TagCapabilityDeps) {}

  /**
   * The lookups the shared target builders take, forwarded to the same
   * thunks so an instance-level override still reaches them.
   */
  private readonly itemLookup: ItemLookup = {
    getItem: (itemId) => this.deps.getItem(itemId),
    resolveBibliographicItem: (item) =>
      this.deps.resolveBibliographicItem(item),
  };

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
      papers: buildPaperTargetsForIds(
        this.itemLookup,
        pageIds(ids, params.limit),
      ),
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
      items: buildItemTargetsForIds(
        this.itemLookup,
        pageIds(ids, params.limit),
      ),
      totalCount: ids.length,
    };
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
        this.deps.getItem(assignment.itemId),
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
      const rawItem = this.deps.getItem(assignment.itemId);
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
    const raw = this.deps.getItem(params.itemId);
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
}
