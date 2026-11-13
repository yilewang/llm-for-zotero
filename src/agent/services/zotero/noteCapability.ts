/**
 * Notes: the note an edit applies to, reading and rewriting note HTML,
 * listing and searching notes, and the annotations a paper carries.
 *
 * Split out of `zoteroGateway.ts`. The capability never names the facade:
 * the item lookups the note paths used to reach through `this` arrive as
 * constructor dependencies, so a caller (or a test) that supplies its own
 * lookup gets exactly the behaviour it asked for.
 */

import { libraryIndexService } from "../../../services/libraryIndexService";
import {
  normalizeNoteSourceText,
  noteHtmlToModelText,
  renderRawNoteHtml,
} from "../../../services/notes/noteRendering";
import {
  readNoteSnapshot,
  stripNoteHtml,
} from "../../../services/notes/noteSnapshot";
import { invalidateCachedContextText } from "../../../services/paperContent/pdfContext";
import { persistVerifiedNoteHtml } from "../../../services/notePersistence";
import {
  writeAssistantItemNote,
  writeAssistantStandaloneNote,
  type AssistantNoteWriteResult,
} from "../../../services/notes/assistantNoteWriterBridge";
import type { GeneratedChatImage } from "../../../shared/types";
import type { AgentRuntimeRequest } from "../../types";
import { resolveRegularItem } from "./internal/itemResolution";
import { orderedIndexIds, pageIds } from "./internal/libraryIndex";
import { normalizeText } from "./internal/normalize";
import {
  buildItemTargetFromItem,
  buildItemTargetsForIds,
  getItemTags,
  getPdfChildAttachments,
} from "./internal/targetBuilders";
import type { ItemLookup, LibraryItemTarget } from "./internal/types";

/**
 * Result of `saveAnswerToNote`.
 *
 * The bare `"created" | "appended" | "standalone_created"` string this
 * replaced is why no caller could act on a note it had just written — the id
 * existed two layers down and was thrown away on the way up (issue #374).
 */
export type SaveAnswerToNoteResult = AssistantNoteWriteResult;

export type PaperNoteRecord = {
  noteId: number;
  title: string;
  noteText: string;
  wordCount: number;
};

/** One notes-search row; a child note names the paper it hangs from. */
export type NoteSearchResult = LibraryItemTarget & {
  parentItemId?: number;
  parentItemTitle?: string;
};

export type PaperAnnotationRecord = {
  annotationId: number;
  type: string;
  text: string;
  comment?: string;
  color?: string;
  pageLabel?: string;
};

/**
 * What the note paths need from the rest of the gateway.
 *
 * `getItem` is the facade's own resolver rather than the free function in
 * `internal/` on purpose: the facade passes thunks that call its methods, so
 * an instance-level override still steers the note paths.
 * `resolveBibliographicItem` is never called directly here — it completes the
 * `ItemLookup` the shared target builders take, which the gateway satisfied
 * by passing itself.
 */
export type NoteCapabilityDeps = {
  getItem(itemId: number | undefined): Zotero.Item | null;
  resolveBibliographicItem(
    item: Zotero.Item | null | undefined,
  ): Zotero.Item | null;
};

export class NoteCapability {
  constructor(private readonly deps: NoteCapabilityDeps) {}

  /**
   * The lookups the shared target builders take, forwarded to the same
   * thunks so an instance-level override still reaches them.
   */
  private readonly itemLookup: ItemLookup = {
    getItem: (itemId) => this.deps.getItem(itemId),
    resolveBibliographicItem: (item) =>
      this.deps.resolveBibliographicItem(item),
  };

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
      const explicit = this.deps.getItem(Math.floor(explicitNoteId));
      // Deliberately no fallback: a bad id must surface as "note not found"
      // rather than silently editing whatever note happened to be open.
      return (explicit as any)?.isNote?.() ? explicit : null;
    }
    const requestNoteId = Number(
      params.request?.activeNoteContext?.noteId || 0,
    );
    if (Number.isFinite(requestNoteId) && requestNoteId > 0) {
      const noteItem = this.deps.getItem(Math.floor(requestNoteId));
      if ((noteItem as any)?.isNote?.()) {
        return noteItem;
      }
    }
    const candidate =
      params.item ||
      params.request?.item ||
      this.deps.getItem(params.request?.activeItemId);
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
    const noteItem = this.deps.getItem(params.noteId);
    if (!noteItem || !(noteItem as any).isNote?.()) {
      throw new Error("Note not found for undo");
    }
    await persistVerifiedNoteHtml(
      noteItem,
      typeof params.html === "string" ? params.html : "",
    );
    invalidateCachedContextText(Math.floor(params.noteId));
  }

  /**
   * Standalone notes in index order, paged with `offset`/`limit`;
   * `totalCount` counts every standalone note in scope, not the page.
   */
  async listStandaloneNotes(params: {
    libraryID: number;
    collectionId?: number;
    limit?: number;
    offset?: number;
  }): Promise<{ notes: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const ids = orderedIndexIds(
      snapshot,
      (item) =>
        item.kind === "standalone-note" &&
        (!params.collectionId ||
          item.collectionIds.includes(params.collectionId)),
    );
    const offset =
      Number.isFinite(params.offset) && Number(params.offset) > 0
        ? Math.floor(Number(params.offset))
        : 0;
    return {
      notes: buildItemTargetsForIds(
        this.itemLookup,
        pageIds(ids.slice(offset), params.limit),
      ),
      totalCount: ids.length,
    };
  }

  getStandaloneNoteContent(params: { noteId: number }): PaperNoteRecord | null {
    const noteItem = this.deps.getItem(params.noteId);
    if (!noteItem || !(noteItem as any).isNote?.()) return null;
    const html = noteItem.getNote?.() || "";
    const text = noteHtmlToModelText(html);
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

  /**
   * Finds notes whose title or text matches the query.
   *
   * Every match is counted before the page is cut, so `totalCount` is the
   * true number of matches and `offset` walks the rest. The page used to stop
   * at its limit and report itself as the whole answer.
   */
  async searchAllNotes(params: {
    libraryID: number;
    collectionId?: number;
    query: string;
    limit?: number;
    offset?: number;
  }): Promise<{ notes: NoteSearchResult[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const query = params.query?.trim();
    if (!query) return { notes: [], totalCount: 0 };
    const normalizedLimit = Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit as number))
      : 200;
    const offset =
      Number.isFinite(params.offset) && Number(params.offset) > 0
        ? Math.floor(Number(params.offset))
        : 0;
    let matches: NoteSearchResult[];
    try {
      const search = new Zotero.Search({ libraryID });
      search.addCondition("itemType", "is", "note");
      search.addCondition("quicksearch-everything", "contains", query);
      const noteIds: number[] = await search.search();
      matches = this._buildNoteResults(noteIds, params.collectionId);
    } catch (_error) {
      void _error;
      // Fallback: in-memory scan across all items and child notes
      matches = await this._searchAllNotesInMemory({
        libraryID,
        collectionId: params.collectionId,
        query,
      });
    }
    return {
      notes: matches.slice(offset, offset + normalizedLimit),
      totalCount: matches.length,
    };
  }

  private _buildNoteResults(
    noteIds: number[],
    collectionId?: number,
  ): NoteSearchResult[] {
    const results: NoteSearchResult[] = [];
    for (const noteId of noteIds) {
      const noteItem = this.deps.getItem(noteId);
      if (!noteItem?.isNote?.()) continue;
      const owner = noteItem.parentID
        ? this.deps.getItem(noteItem.parentID)
        : noteItem;
      const collectionIds = owner?.getCollections() || [];
      if (collectionId && !collectionIds.includes(collectionId)) continue;
      const rawTitle = normalizeText(
        (noteItem as any).getNoteTitle?.() ||
          noteItem.getDisplayTitle?.() ||
          "",
      ).trim();
      const title = rawTitle || `Note ${noteItem.id}`;
      if (noteItem.parentID) {
        const parentItem = this.deps.getItem(noteItem.parentID as number);
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
          collectionIds,
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
    collectionId?: number;
    query: string;
  }): Promise<NoteSearchResult[]> {
    const queryLower = params.query.toLowerCase();
    const snapshot = await libraryIndexService.getSnapshot(params.libraryID);
    const results: NoteSearchResult[] = [];
    for (const itemId of snapshot.topLevelItemOrder) {
      const indexed = snapshot.itemById.get(itemId);
      const item = this.deps.getItem(itemId);
      if (!indexed || indexed.deleted || !item) continue;
      if (
        params.collectionId &&
        !indexed.collectionIds.includes(params.collectionId)
      )
        continue;
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
          collectionIds: [...indexed.collectionIds],
          noteKind: "item",
          parentItemId: item.id,
          parentItemTitle: parentTitle,
        });
      }
    }
    return results;
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
      return writeAssistantStandaloneNote({
        libraryID,
        content: params.content,
        modelName: params.modelName,
        generatedImages: params.generatedImages,
        collections: params.collections,
      });
    }
    if (!params.item) {
      throw new Error("No Zotero item is active for item-note creation");
    }
    return writeAssistantItemNote({
      item: params.item,
      content: params.content,
      modelName: params.modelName,
      appendToTrackedNote: params.appendToTrackedNote === true,
      generatedImages: params.generatedImages,
    });
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
        const text = noteHtmlToModelText(html);
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
    const target = params.item;
    if (!target) return [];
    const limit =
      Number.isFinite(params.maxAnnotations) &&
      (params.maxAnnotations as number) > 0
        ? Math.floor(params.maxAnnotations as number)
        : 100;
    const results: PaperAnnotationRecord[] = [];
    try {
      const pdfs = target.isAttachment?.()
        ? [target]
        : getPdfChildAttachments(target);
      for (const pdf of pdfs) {
        if (results.length >= limit) break;
        const annotations = pdf.getAnnotations();
        for (const annotation of annotations) {
          if (results.length >= limit) break;
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
}
