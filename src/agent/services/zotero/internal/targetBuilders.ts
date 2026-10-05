/**
 * Building the paper and item targets the model sees.
 *
 * A "target" is the gateway's answer to "what is in this library": id, title,
 * creator, year, attachments, tags and collection membership, in the one
 * shape every read path returns. Two builders rather than one because a
 * paper target is defined by having a readable PDF and an item target is not.
 */

import { joinLocalPath } from "../../../../utils/localPath";
import { paperTextStore } from "../../../../services/paperContent/paperTextStore";
import { getCollectionIDs } from "./collections";
import { getItemTypeName, resolveRegularItem } from "./itemResolution";
import { normalizeText } from "./normalize";
import type {
  ItemLookup,
  LibraryItemTarget,
  LibraryItemTargetAttachment,
  LibraryPaperTarget,
} from "./types";

export function getPdfChildAttachments(item: Zotero.Item): Zotero.Item[] {
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

export function getAllChildAttachments(item: Zotero.Item): Zotero.Item[] {
  const out: Zotero.Item[] = [];
  if (!item?.isRegularItem?.()) return out;
  for (const attachmentId of item.getAttachments()) {
    const att = Zotero.Items.get(attachmentId) || null;
    if (att && att.isAttachment?.()) out.push(att);
  }
  return out;
}

export function resolveAttachmentTitle(
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

export function resolveAnyAttachmentTitle(
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

export function getItemTags(
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

export function buildPaperTargetFromItem(
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

export function buildItemTargetFromItem(
  item: Zotero.Item,
): LibraryItemTarget | null {
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

export function buildPaperTargetsForIds(
  gateway: ItemLookup,
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

export function buildItemTargetsForIds(
  gateway: ItemLookup,
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

export const FULLTEXT_INDEX_STATE_MAP: Record<
  number,
  LibraryItemTargetAttachment["indexingState"]
> = {
  0: "unavailable",
  1: "unindexed",
  2: "partial",
  3: "indexed",
  4: "queued",
};

/**
 * Cheap, extraction-free size of the text the host can read for a PDF: the
 * cached extraction when present, otherwise Zotero's full-text cache file or
 * the MinerU markdown on disk. Undefined when nothing measurable exists.
 */
export async function measureReadableTextChars(
  attachment: Zotero.Item,
  mineruCacheDir: string | undefined,
): Promise<number | undefined> {
  const cached = paperTextStore.peek(attachment.id);
  if (cached?.fullLength) return cached.fullLength;
  const stat = async (path: string) => {
    try {
      const io = (globalThis as unknown as { IOUtils?: any }).IOUtils;
      const info = await io?.stat?.(path);
      const size = Number(info?.size);
      return Number.isFinite(size) && size > 0 ? size : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    const fulltext = (
      Zotero as unknown as {
        Fulltext?: { getItemCacheFile?: (item: Zotero.Item) => nsIFile };
      }
    ).Fulltext;
    const cacheFile = fulltext?.getItemCacheFile?.(attachment);
    if (
      cacheFile &&
      (typeof cacheFile.exists !== "function" || cacheFile.exists())
    ) {
      const size = Number((cacheFile as { fileSize?: number }).fileSize);
      if (Number.isFinite(size) && size > 0) return size;
      if (cacheFile.path) {
        const measured = await stat(cacheFile.path);
        if (measured) return measured;
      }
    }
  } catch {
    // Fall through to MinerU.
  }
  if (mineruCacheDir?.trim()) {
    const measured = await stat(
      joinLocalPath(mineruCacheDir.trim(), "full.md"),
    );
    if (measured) return measured;
  }
  return undefined;
}
