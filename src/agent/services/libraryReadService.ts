import type { PaperContextRef } from "../../shared/types";
import type { AgentRuntimeRequest } from "../types";
import type {
  CollectionSummary,
  LibraryItemTargetAttachment,
  PaperAnnotationRecord,
  PaperNoteRecord,
  ZoteroGateway,
} from "./zoteroGateway";
import { createZoteroMetadataResolver } from "../../services/zoteroMetadata/resolver";
import { projectLibraryReadMetadata } from "../../services/zoteroMetadata/projections";
import type { LibraryReadMetadataV1 } from "../../services/zoteroMetadata/types";

export type ReadLibrarySection =
  | "metadata"
  | "notes"
  | "annotations"
  | "attachments"
  | "collections"
  | "content";

export type ReadLibraryResultEntry = {
  itemId: number;
  title: string;
  metadata?: LibraryReadMetadataV1;
  notes?: PaperNoteRecord[];
  annotations?: PaperAnnotationRecord[];
  attachments?: LibraryItemTargetAttachment[];
  collections?: CollectionSummary[];
};

export type ReadLibraryServiceResult = {
  results: Record<string, ReadLibraryResultEntry>;
  warnings: string[];
};

function uniqueNumbers(values: number[]): number[] {
  return Array.from(
    new Set(values.filter((value) => Number.isFinite(value) && value > 0)),
  );
}

function canUseActiveItemFallback(request: AgentRuntimeRequest): boolean {
  return (
    request.conversationKind !== "global" &&
    !request.turnPaperScope.collections.length &&
    !request.turnPaperScope.tags.length
  );
}

export class LibraryReadService {
  constructor(private readonly zoteroGateway: ZoteroGateway) {}

  resolveItemIds(params: {
    request: AgentRuntimeRequest;
    itemIds?: number[];
    paperContexts?: PaperContextRef[];
    selectorMode?: "explicit" | "ambient";
  }): number[] {
    const explicitItemIds = [
      ...(params.itemIds || []),
      ...(params.paperContexts || []).map((entry) => entry.itemId),
    ];
    const explicit = uniqueNumbers(explicitItemIds);
    if (params.selectorMode === "explicit" || explicit.length) return explicit;
    const itemIds = this.zoteroGateway
      .listPaperContexts(params.request)
      .map((entry) => entry.itemId);
    if (canUseActiveItemFallback(params.request)) {
      itemIds.push(Number(params.request.activeItemId) || 0);
    }
    return uniqueNumbers(itemIds);
  }

  async readItems(params: {
    request: AgentRuntimeRequest;
    itemIds?: number[];
    paperContexts?: PaperContextRef[];
    sections: ReadLibrarySection[];
    maxNotes?: number;
    maxAnnotations?: number;
    selectorMode?: "explicit" | "ambient";
  }): Promise<ReadLibraryServiceResult> {
    const itemIds = this.resolveItemIds(params);
    const targetMap = new Map(
      this.zoteroGateway
        .getPaperTargetsByItemIds(itemIds)
        .map((target) => [target.itemId, target] as const),
    );
    const sectionSet = new Set(params.sections);
    const results: Record<string, ReadLibraryResultEntry> = {};
    const warnings: string[] = [];
    const resolver = createZoteroMetadataResolver({
      getItem: (itemId) => this.zoteroGateway.getItem(itemId),
    });
    const addUnsupportedSectionWarnings = (
      itemId: number,
      kind: "attachment" | "note",
      supported: ReadonlySet<ReadLibrarySection>,
    ) => {
      for (const section of sectionSet) {
        if (supported.has(section)) continue;
        warnings.push(
          `Section '${section}' does not apply to ${kind} item ${itemId}`,
        );
      }
    };
    for (const itemId of itemIds) {
      const rawItem = this.zoteroGateway.getItem(itemId);
      if (!rawItem) {
        warnings.push(`Item ${itemId} was not found`);
        continue;
      }
      const metadataResolution = sectionSet.has("metadata")
        ? resolver.resolveItemMetadata(itemId, {
            detail: "complete",
            includeSystemMetadata: true,
          })
        : null;
      const metadata =
        metadataResolution?.status === "resolved"
          ? projectLibraryReadMetadata(metadataResolution.value)
          : undefined;

      // Note path — handles both standalone notes and child notes attached to a paper
      if ((rawItem as any).isNote?.()) {
        const noteContent =
          sectionSet.has("notes") || sectionSet.has("content")
            ? this.zoteroGateway.getStandaloneNoteContent({ noteId: itemId })
            : null;
        results[String(itemId)] = {
          itemId,
          title: noteContent?.title || metadata?.title || `Note ${itemId}`,
          metadata,
          notes: noteContent ? [noteContent] : undefined,
          // A standalone note can be a collection member, and this branch
          // never reported that — so filing a note could not be verified.
          collections: sectionSet.has("collections")
            ? this.zoteroGateway
                .getItemCollectionIds(itemId)
                .map((collectionId) =>
                  this.zoteroGateway.getCollectionSummary(collectionId),
                )
                .filter((entry): entry is CollectionSummary => Boolean(entry))
            : undefined,
        };
        addUnsupportedSectionWarnings(
          itemId,
          "note",
          new Set<ReadLibrarySection>([
            "metadata",
            "notes",
            "content",
            "collections",
          ]),
        );
        continue;
      }

      if (rawItem.isAttachment?.()) {
        const collectionIds = this.zoteroGateway.getItemCollectionIds(itemId);
        results[String(itemId)] = {
          itemId,
          title:
            metadata?.title ||
            `${rawItem.getDisplayTitle?.() || `Attachment ${itemId}`}`,
          metadata,
          collections: sectionSet.has("collections")
            ? collectionIds
                .map((collectionId) =>
                  this.zoteroGateway.getCollectionSummary(collectionId),
                )
                .filter((entry): entry is CollectionSummary => Boolean(entry))
            : undefined,
        };
        addUnsupportedSectionWarnings(
          itemId,
          "attachment",
          new Set<ReadLibrarySection>(["metadata", "collections"]),
        );
        continue;
      }

      // Regular item path
      const item = this.zoteroGateway.resolveMetadataItem({ itemId });
      if (!item) continue;
      const target = targetMap.get(itemId);
      // Read membership from the item itself. The paper-target map is
      // PDF-gated, so a book or a PDF-less paper reported no collections at
      // all — the exact items most likely to be filed by hand.
      const collectionIds = this.zoteroGateway.getItemCollectionIds(itemId);
      results[String(itemId)] = {
        itemId,
        title:
          metadata?.title ||
          target?.title ||
          `${item.getDisplayTitle?.() || `Item ${itemId}`}`,
        metadata,
        notes: sectionSet.has("notes")
          ? this.zoteroGateway.getPaperNotes({
              item,
              maxNotes: params.maxNotes,
            })
          : undefined,
        annotations: sectionSet.has("annotations")
          ? this.zoteroGateway.getPaperAnnotations({
              item,
              maxAnnotations: params.maxAnnotations,
            })
          : undefined,
        // For attachments, show all child attachment types (not just PDFs) with indexing state
        attachments: sectionSet.has("attachments")
          ? await this.zoteroGateway.getAllChildAttachmentInfos(itemId)
          : undefined,
        collections: sectionSet.has("collections")
          ? collectionIds
              .map((collectionId) =>
                this.zoteroGateway.getCollectionSummary(collectionId),
              )
              .filter((entry): entry is CollectionSummary => Boolean(entry))
          : undefined,
      };
    }
    return { results, warnings };
  }
}
