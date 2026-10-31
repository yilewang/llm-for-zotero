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
   * Import an image file as an embedded note attachment and return its key.
   * The key can then be used in note HTML: <img data-attachment-key="KEY" />
   */
  async importNoteImage(
    params: NoteImageImportInput,
  ): Promise<{ key: string } | null> {
    return importNoteImageAsset(params);
  }
}
