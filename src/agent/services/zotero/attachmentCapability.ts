/**
 * Attachments: what a paper's files are, indexing a PDF for full-text
 * search, and the three repairs — delete, rename on disk, re-link — plus the
 * image import a note embeds.
 *
 * Split out of `zoteroGateway.ts`. The capability never names the facade:
 * the item lookups the attachment paths used to reach through `this` arrive
 * as constructor dependencies, so a caller (or a test) that supplies its own
 * lookup gets exactly the behaviour it asked for.
 */

import { appLogger } from "../../../core/logging";
import { ensureMineruCacheDirForAttachment } from "../../../services/mineru/sync";
import {
  importNoteImageAsset,
  type NoteImageImportInput,
} from "../../../services/notes/noteImages";
import { normalizeText } from "./internal/normalize";
import {
  FULLTEXT_INDEX_STATE_MAP,
  getAllChildAttachments,
  measureReadableTextChars,
  resolveAnyAttachmentTitle,
} from "./internal/targetBuilders";
import type { LibraryItemTargetAttachment } from "./internal/types";
import { normalizeWebAddress } from "../libraryMutation/valueTypes";

/**
 * What the attachment paths need from the rest of the gateway.
 *
 * Both are the facade's own resolvers rather than the free functions in
 * `internal/` on purpose: the facade passes thunks that call its methods, so
 * an instance-level override still steers the attachment paths.
 */
export type AttachmentCapabilityDeps = {
  getItem(itemId: number | undefined): Zotero.Item | null;
  resolveBibliographicItem(
    item: Zotero.Item | null | undefined,
  ): Zotero.Item | null;
};

/** An attachment an attach or a find created, as its result names it. */
export type CreatedAttachment = {
  attachmentId: number;
  title: string;
  linkMode: "imported_file" | "imported_url" | "linked_file" | "linked_url";
  contentType: string;
  url?: string;
  path?: string;
};

const LINK_MODE_NAMES: Record<number, CreatedAttachment["linkMode"]> = {
  0: "imported_file",
  1: "imported_url",
  2: "linked_file",
  3: "linked_url",
};

function describeCreatedAttachment(item: Zotero.Item): CreatedAttachment {
  const url = String(item.getField("url") || "");
  const path = (item.isFileAttachment() && item.getFilePath()) || "";
  return {
    attachmentId: item.id,
    title: String(item.getField("title") || ""),
    linkMode: LINK_MODE_NAMES[item.attachmentLinkMode] || "imported_file",
    contentType: String(item.attachmentContentType || ""),
    ...(url ? { url } : {}),
    ...(path ? { path } : {}),
  };
}

const LINK_MODE_IMPORTED_FILE = 0;
const LINK_MODE_IMPORTED_URL = 1;
const LINK_MODE_LINKED_FILE = 2;
const LINK_MODE_LINKED_URL = 3;

/** The item's attachments that are not in the trash. */
function liveChildAttachments(parent: Zotero.Item): Zotero.Item[] {
  return Zotero.Items.get(parent.getAttachments()).filter(
    (item) => item && !item.deleted,
  );
}

type FileStat = { type?: string; size?: number };

async function statFile(path: string): Promise<FileStat | null> {
  const io = (
    globalThis as { IOUtils?: { stat?: (path: string) => Promise<FileStat> } }
  ).IOUtils;
  try {
    return (await io?.stat?.(path)) || null;
  } catch {
    return null;
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * The attachment of `parent` that already is what attaching `filePath`
 * would make: a link to that path, or a stored copy with the file's name
 * (as Zotero stores it) and size.
 */
async function existingFileAttachment(
  parent: Zotero.Item,
  filePath: string,
  link: boolean,
): Promise<Zotero.Item | undefined> {
  const children = liveChildAttachments(parent);
  if (link)
    return children.find(
      (item) =>
        item.attachmentLinkMode === LINK_MODE_LINKED_FILE &&
        item.getFilePath() === filePath,
    );
  const name = baseName(filePath);
  const valid = (
    Zotero.File as unknown as { getValidFileName?: (name: string) => string }
  ).getValidFileName?.(name);
  const names = new Set([name, valid || name]);
  const size = (await statFile(filePath))?.size;
  if (size === undefined) return undefined;
  for (const item of children) {
    if (
      item.attachmentLinkMode !== LINK_MODE_IMPORTED_FILE ||
      !names.has(String(item.attachmentFilename || ""))
    )
      continue;
    const stored = item.getFilePath();
    if (stored && (await statFile(stored))?.size === size) return item;
  }
  return undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AttachmentCapability {
  constructor(private readonly deps: AttachmentCapabilityDeps) {}

  async getAllChildAttachmentInfos(
    itemId: number,
  ): Promise<LibraryItemTargetAttachment[]> {
    const item = this.deps.getItem(itemId);
    if (!item) return [];
    const allAtts = getAllChildAttachments(
      item.isRegularItem?.()
        ? item
        : this.deps.resolveBibliographicItem(item) || item,
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
          appLogger.warn("LLM: Fulltext index state check failed", err);
          indexingState = "unavailable";
        }
        // Check if MinerU has parsed this PDF
        try {
          mineruCacheDir = await ensureMineruCacheDirForAttachment(att);
        } catch (err) {
          appLogger.warn("LLM: MinerU cache check failed", err);
        }
      }
      const readableTextChars =
        contentType === "application/pdf"
          ? await measureReadableTextChars(att, mineruCacheDir)
          : undefined;
      results.push({
        contextItemId: att.id,
        title: resolveAnyAttachmentTitle(att, i, allAtts.length),
        filename: normalizeText(att.attachmentFilename) || undefined,
        contentType,
        indexingState,
        mineruCacheDir,
        ...(readableTextChars !== undefined ? { readableTextChars } : {}),
      });
    }
    return results;
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
    const item = this.deps.getItem(params.attachmentId);
    if (!item || !item.isAttachment?.()) return null;
    const filename = normalizeText(
      (item as any).attachmentFilename || item.getField?.("title") || "",
    );
    // A native Zotero item has no `hasFile` property, so reading it alone
    // reported "no file" for every real attachment. A stored file is a file
    // attachment with a resolved path; whether the bytes can be read is
    // decided by the read itself.
    const reportedHasFile = (item as any).hasFile;
    const hasFile =
      typeof reportedHasFile === "boolean"
        ? reportedHasFile
        : !!(item.isFileAttachment?.() && item.getFilePath?.());
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

  async indexPdfAttachment(params: { attachmentId: number }): Promise<{
    attachmentId: number;
    indexingState: string;
    triggered: boolean;
  }> {
    const item = this.deps.getItem(params.attachmentId);
    if (!item?.isAttachment?.()) throw new Error("Not an attachment item");
    if (!(item as any).isPDFAttachment?.())
      throw new Error("Not a PDF attachment");
    await Zotero.Fulltext.indexItems([params.attachmentId]);
    let indexingState = "unavailable";
    try {
      const stateNum = await Zotero.Fulltext.getIndexedState(item);
      indexingState = FULLTEXT_INDEX_STATE_MAP[stateNum] ?? "unavailable";
    } catch (err) {
      appLogger.warn("LLM: Attachment indexing state check failed", err);
    }
    return {
      attachmentId: params.attachmentId,
      indexingState,
      triggered: true,
    };
  }

  /**
   * Delete an attachment (moves to trash).
   */
  async deleteAttachment(params: { attachmentId: number }): Promise<{
    attachmentId: number;
    title: string;
    status: "deleted" | "not_found";
  }> {
    const item = this.deps.getItem(params.attachmentId);
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
    const item = this.deps.getItem(params.attachmentId);
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
    const item = this.deps.getItem(params.attachmentId);
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

  /**
   * Attaches a local file to a regular item: a stored copy by default, a
   * link to the file where it is when `link` is set. The caller has checked
   * the parent and the file.
   *
   * An attachment the item already has counts as done and is returned
   * instead of a second one: a link to the same path, or a stored copy with
   * the same file name and size. That makes a retry after a crash or a lost
   * result safe. Decided by the main session (W5-C review): a deliberate
   * second copy of the same file on the same item is not made.
   */
  async attachFile(params: {
    parentItemId: number;
    filePath: string;
    link?: boolean;
  }): Promise<
    | { status: "attached" | "already_attached"; attachment: CreatedAttachment }
    | { status: "refused"; reason: string }
  > {
    const parent = this.deps.getItem(params.parentItemId);
    if (!parent)
      return { status: "refused", reason: "The item was not found." };
    if (
      params.link &&
      (
        Zotero.Libraries.get(parent.libraryID) as {
          allowsLinkedFiles?: boolean;
        } | null
      )?.allowsLinkedFiles === false
    )
      return {
        status: "refused",
        reason:
          "This library does not allow linked files; attach a stored copy instead.",
      };
    const existing = await existingFileAttachment(
      parent,
      params.filePath,
      Boolean(params.link),
    );
    if (existing)
      return {
        status: "already_attached",
        attachment: describeCreatedAttachment(existing),
      };
    const options = {
      file: params.filePath,
      parentItemID: params.parentItemId,
    };
    const created = params.link
      ? await Zotero.Attachments.linkFromFile(options)
      : await Zotero.Attachments.importFromFile(options);
    return {
      status: "attached",
      attachment: describeCreatedAttachment(created),
    };
  }

  /**
   * Saves a web page to a regular item as a stored snapshot and a link.
   *
   * The snapshot comes first: `importFromURL` loads an HTML page in a hidden
   * browser and stores Zotero's own snapshot of it, and downloads any other
   * type as a file. A link or a snapshot of the same address the item
   * already has counts as done and is reused, so a retry after a crash
   * between the two adds only the missing one, and an exact repeat adds
   * nothing. Decided by the main session (W5-C review): a deliberate second
   * snapshot of the same page on the same item is not made.
   *
   * If the snapshot fails, nothing new was written. If the link then fails,
   * a snapshot this call made is erased again, so "failed" means nothing new
   * remains. An erase that fails throws an error that names the snapshot,
   * which the next try reuses.
   */
  async attachUrl(params: {
    parentItemId: number;
    libraryID: number;
    url: string;
  }): Promise<
    | {
        status: "attached" | "already_attached";
        attachments: CreatedAttachment[];
        createdIds: number[];
      }
    | { status: "failed"; reason: string }
  > {
    const parent = this.deps.getItem(params.parentItemId);
    const address = normalizeWebAddress(params.url);
    const children = parent ? liveChildAttachments(parent) : [];
    const sameAddress = (item: Zotero.Item, linkMode: number) =>
      item.attachmentLinkMode === linkMode &&
      normalizeWebAddress(String(item.getField("url") || "")) === address;
    let snapshot = children.find((item) =>
      sameAddress(item, LINK_MODE_IMPORTED_URL),
    );
    let link = children.find((item) => sameAddress(item, LINK_MODE_LINKED_URL));
    const created: Zotero.Item[] = [];
    if (!snapshot) {
      try {
        snapshot = await Zotero.Attachments.importFromURL({
          libraryID: params.libraryID,
          url: params.url,
          parentItemID: params.parentItemId,
        } as never);
      } catch (error) {
        return { status: "failed", reason: errorText(error) };
      }
      created.push(snapshot);
    }
    if (!link) {
      try {
        link = await Zotero.Attachments.linkFromURL({
          url: params.url,
          parentItemID: params.parentItemId,
        } as never);
      } catch (error) {
        const reason = errorText(error);
        for (const item of created) {
          try {
            await item.eraseTx();
          } catch (eraseError) {
            throw new Error(
              `Zotero saved a snapshot of ${params.url} (attachment ${item.id}, key ${item.key}) but could not link the page (${reason}) or erase the snapshot again (${errorText(eraseError)}). The snapshot remains; trying again reuses it.`,
            );
          }
        }
        return { status: "failed", reason };
      }
      created.push(link);
    }
    return {
      status: created.length ? "attached" : "already_attached",
      attachments: [
        describeCreatedAttachment(link),
        describeCreatedAttachment(snapshot),
      ],
      createdIds: created.map((item) => item.id),
    };
  }

  /**
   * Zotero's own Find Available PDF for one item: the resolvers its menu
   * command uses (DOI, URL, open-access lookup, custom resolvers). An item
   * the command would skip, or a search that finds no file, is "not found".
   */
  async findAvailablePdf(
    item: Zotero.Item,
  ): Promise<
    | { status: "found"; attachment: CreatedAttachment }
    | { status: "not_found"; reason: string }
  > {
    const attachments = Zotero.Attachments as unknown as {
      canFindFileForItem?: (item: Zotero.Item) => boolean;
    };
    if (attachments.canFindFileForItem?.(item) === false) {
      const hasLookup = Boolean(
        item.getField("DOI") ||
        item.getField("url") ||
        item.getExtraField?.("DOI"),
      );
      return {
        status: "not_found",
        reason: hasLookup
          ? "Not searched: the item already has a PDF or another full-text file."
          : "Not searched: the item has no DOI or URL to look a PDF up by.",
      };
    }
    const found = await Zotero.Attachments.addAvailableFile(item, {
      methods: ["doi", "url", "oa", "custom"],
    });
    return found
      ? { status: "found", attachment: describeCreatedAttachment(found) }
      : {
          status: "not_found",
          reason: "No PDF found online.",
        };
  }

  /**
   * Sets an annotation's comment and color, and returns the values it had,
   * as Zotero normalizes them (an empty comment is stored as none).
   */
  async updateAnnotation(params: {
    annotation: Zotero.Item;
    comment?: string;
    color?: string;
  }): Promise<{
    status: "updated" | "unchanged";
    previous: { comment: string; color: string };
    comment: string;
    color: string;
  }> {
    const { annotation } = params;
    const previous = {
      comment: String(annotation.annotationComment || ""),
      color: String(annotation.annotationColor || ""),
    };
    if (params.comment !== undefined)
      annotation.annotationComment = params.comment;
    if (params.color !== undefined) annotation.annotationColor = params.color;
    const changed = annotation.hasChanged();
    if (changed) await annotation.saveTx();
    return {
      status: changed ? "updated" : "unchanged",
      previous,
      comment: String(annotation.annotationComment || ""),
      color: String(annotation.annotationColor || ""),
    };
  }

  /**
   * Import an image file as an embedded note attachment and return its key.
   * The key can then be used in note HTML: <img data-attachment-key="KEY" />
   */
  async importNoteImage(
    params: NoteImageImportInput,
  ): Promise<{ key: string } | null> {
    return importNoteImageAsset(params);
  }
}
