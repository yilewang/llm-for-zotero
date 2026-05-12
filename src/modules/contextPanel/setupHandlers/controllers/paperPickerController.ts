import { createElement } from "../../../../utils/domHelpers";
import { t } from "../../../../utils/i18n";
import { MAX_SELECTED_PAPER_CONTEXTS } from "../../constants";
import {
  selectedCollectionContextCache,
  selectedOtherRefContextCache,
  selectedPaperContextCache,
  selectedPaperPreviewExpandedCache,
} from "../../state";
import { appendSelectedTextContextForItem } from "../../contextResolution";
import { resolvePaperContextRefFromItem } from "../../paperAttribution";
import {
  browseAllItemCandidates,
  normalizePaperSearchText,
  parseAtSearchToken,
  searchAllItemCandidates,
  searchCollectionCandidates,
  ZOTERO_NOTE_CONTENT_TYPE,
  type PaperBrowseCollectionCandidate,
  type PaperSearchAttachmentCandidate,
  type PaperSearchGroupCandidate,
  type PaperSearchSlashToken,
} from "../../paperSearch";
import { readNoteSnapshot } from "../../notes";
import type {
  CollectionContextRef,
  OtherContextRef,
  PaperContextRef,
} from "../../types";
import { setPaperModeOverride } from "../../contexts/paperContextState";
import { isSamePaperContextRef } from "../../modeBehavior";
import { resolvePaperContextDisplayMetadata } from "./composeContextController";

type StatusLevel = "ready" | "warning" | "error";
type ActiveSlashToken = PaperSearchSlashToken;
type PaperPickerMode = "browse" | "search" | "empty";
type PaperPickerRow =
  | {
      kind: "collection";
      collectionId: number;
      depth: number;
    }
  | {
      kind: "paper";
      itemId: number;
      depth: number;
    }
  | {
      kind: "attachment";
      itemId: number;
      attachmentIndex: number;
      depth: number;
    };

type PaperPickerControllerDeps = {
  body: Element;
  panelRoot: HTMLElement;
  inputBox: HTMLTextAreaElement;
  paperPicker: HTMLDivElement | null;
  paperPickerList: HTMLDivElement | null;
  getItem: () => Zotero.Item | null;
  getCurrentLibraryID: () => number;
  isWebChatMode: () => boolean;
  resolveAutoLoadedPaperContext: () => PaperContextRef | null;
  getManualPaperContextsForItem: (
    itemId: number,
    autoLoadedPaperContext: PaperContextRef | null,
  ) => PaperContextRef[];
  isPaperContextMineru: (paperContext: PaperContextRef) => boolean;
  getTextContextConversationKey: () => number | null;
  persistDraftInputForCurrentConversation: () => void;
  updatePaperPreviewPreservingScroll: () => void;
  updateSelectedTextPreviewPreservingScroll: () => void;
  setStatusMessage?: (message: string, level: StatusLevel) => void;
  log: (message: string, ...args: unknown[]) => void;
};

export function createPaperPickerController(deps: PaperPickerControllerDeps): {
  getActiveAtToken: () => ActiveSlashToken | null;
  isPaperPickerOpen: () => boolean;
  closePaperPicker: () => void;
  schedulePaperPickerSearch: () => void;
  moveActiveRow: (delta: number) => void;
  selectActiveRow: () => void;
  handleArrowRight: () => void;
  handleArrowLeft: () => void;
  addZoteroItemsAsPaperContext: (items: Zotero.Item[]) => void;
} {
  const { body, inputBox, panelRoot, paperPicker, paperPickerList } = deps;
  let paperPickerMode: PaperPickerMode = "browse";
  let paperPickerEmptyMessage = "No references available.";
  let paperPickerGroups: PaperSearchGroupCandidate[] = [];
  let paperPickerCollections: PaperBrowseCollectionCandidate[] = [];
  let paperPickerGroupByItemId = new Map<number, PaperSearchGroupCandidate>();
  let paperPickerCollectionById = new Map<
    number,
    PaperBrowseCollectionCandidate
  >();
  let paperPickerExpandedPaperKeys = new Set<number>();
  let paperPickerExpandedCollectionKeys = new Set<number>();
  let paperPickerRows: PaperPickerRow[] = [];
  let paperPickerActiveRowIndex = 0;
  let paperPickerRequestSeq = 0;
  let paperPickerDebounceTimer: number | null = null;

  const setStatus = (message: string, level: StatusLevel) => {
    deps.setStatusMessage?.(message, level);
  };

  const getActiveAtToken = (): ActiveSlashToken | null => {
    const caretEnd =
      typeof inputBox.selectionStart === "number"
        ? inputBox.selectionStart
        : inputBox.value.length;
    return parseAtSearchToken(inputBox.value, caretEnd);
  };

  const clearPaperPickerDebounceTimer = () => {
    if (paperPickerDebounceTimer === null) return;
    const win = body.ownerDocument?.defaultView;
    if (win) {
      win.clearTimeout(paperPickerDebounceTimer);
    } else {
      clearTimeout(paperPickerDebounceTimer);
    }
    paperPickerDebounceTimer = null;
  };

  const resetPaperPickerState = () => {
    paperPickerMode = "browse";
    paperPickerEmptyMessage = "No references available.";
    paperPickerGroups = [];
    paperPickerCollections = [];
    paperPickerGroupByItemId = new Map<number, PaperSearchGroupCandidate>();
    paperPickerCollectionById = new Map<
      number,
      PaperBrowseCollectionCandidate
    >();
    paperPickerExpandedPaperKeys = new Set<number>();
    paperPickerExpandedCollectionKeys = new Set<number>();
    paperPickerRows = [];
    paperPickerActiveRowIndex = 0;
  };

  const consumeActiveAtToken = (): boolean => {
    const token = getActiveAtToken();
    if (!token) return false;
    const beforeAt = inputBox.value.slice(0, token.slashStart);
    const afterCaret = inputBox.value.slice(token.caretEnd);
    inputBox.value = `${beforeAt}${afterCaret}`;
    deps.persistDraftInputForCurrentConversation();
    const nextCaret = beforeAt.length;
    inputBox.setSelectionRange(nextCaret, nextCaret);
    return true;
  };

  const consumeAtQueryOnly = (): boolean => {
    const token = getActiveAtToken();
    if (!token || token.query.length === 0) return false;
    const beforeQuery = inputBox.value.slice(0, token.slashStart + 1);
    const afterCaret = inputBox.value.slice(token.caretEnd);
    inputBox.value = `${beforeQuery}${afterCaret}`;
    deps.persistDraftInputForCurrentConversation();
    const nextCaret = token.slashStart + 1;
    inputBox.setSelectionRange(nextCaret, nextCaret);
    return true;
  };

  const isPaperPickerOpen = () =>
    Boolean(paperPicker && paperPicker.style.display !== "none");

  const closePaperPicker = () => {
    consumeActiveAtToken();
    paperPickerRequestSeq += 1;
    clearPaperPickerDebounceTimer();
    resetPaperPickerState();
    if (paperPicker) {
      paperPicker.style.display = "none";
      paperPicker.classList.remove("llm-paper-picker-below");
    }
    if (paperPickerList) {
      paperPickerList.innerHTML = "";
    }
  };

  function buildPaperMetaText(paper: {
    citationKey?: string;
    firstCreator?: string;
    year?: string;
  }): string {
    const parts = [
      paper.firstCreator || "",
      paper.year || "",
      paper.citationKey || "",
    ].filter(Boolean);
    return parts.join(" · ");
  }

  function resolvePickerItemKind(
    contentType?: string,
  ): "pdf" | "note" | "figure" | "other" {
    if (!contentType) return "other";
    if (contentType === "application/pdf") return "pdf";
    if (contentType === ZOTERO_NOTE_CONTENT_TYPE) return "note";
    if (contentType.startsWith("image/")) return "figure";
    return "other";
  }

  function resolvePickerKindIcon(
    kind: "pdf" | "note" | "figure" | "other",
  ): string {
    if (kind === "pdf") return "📚";
    if (kind === "note") return "📝";
    if (kind === "figure") return "🖼";
    return "📎";
  }

  function resolvePickerKindLabel(
    kind: "pdf" | "note" | "figure" | "other",
  ): string {
    if (kind === "pdf") return "PDF";
    if (kind === "note") return "Note";
    if (kind === "figure") return "Figure";
    return "File";
  }

  function resolveGroupIcon(group: PaperSearchGroupCandidate): string {
    if (group.itemKind === "standalone-note") return "📝";
    const hasPdf = group.attachments.some(
      (attachment) => resolvePickerItemKind(attachment.contentType) === "pdf",
    );
    if (hasPdf) return "📚";
    const hasFigure = group.attachments.some(
      (attachment) =>
        resolvePickerItemKind(attachment.contentType) === "figure",
    );
    if (hasFigure) return "🖼";
    const hasNote = group.attachments.some(
      (attachment) => resolvePickerItemKind(attachment.contentType) === "note",
    );
    if (hasNote) return "📝";
    if (group.attachments.length > 0) return "📎";
    return "📄";
  }

  const getPaperPickerAttachmentDisplayTitle = (
    group: PaperSearchGroupCandidate,
    attachment: PaperSearchAttachmentCandidate,
    attachmentIndex: number,
  ): string => {
    const normalizedTitle = (attachment.title || "").trim();
    if (normalizedTitle) return normalizedTitle;
    const kind = resolvePickerItemKind(attachment.contentType);
    return group.attachments.length > 1
      ? `${resolvePickerKindLabel(kind)} ${attachmentIndex + 1}`
      : resolvePickerKindLabel(kind);
  };

  const getPaperPickerGroupByItemId = (itemId: number) =>
    paperPickerGroupByItemId.get(itemId) || null;

  const getPaperPickerCollectionById = (collectionId: number) =>
    paperPickerCollectionById.get(collectionId) || null;

  const isPaperPickerGroupExpanded = (itemId: number): boolean => {
    const group = getPaperPickerGroupByItemId(itemId);
    if (!group || group.attachments.length <= 1) return false;
    return paperPickerExpandedPaperKeys.has(itemId);
  };

  const isPaperPickerCollectionExpanded = (collectionId: number): boolean =>
    paperPickerExpandedCollectionKeys.has(collectionId);

  const togglePaperPickerGroupExpanded = (
    itemId: number,
    expanded?: boolean,
  ): boolean => {
    const group = getPaperPickerGroupByItemId(itemId);
    if (!group || group.attachments.length <= 1) return false;
    const currentlyExpanded = paperPickerExpandedPaperKeys.has(itemId);
    const nextExpanded = expanded === undefined ? !currentlyExpanded : expanded;
    if (nextExpanded === currentlyExpanded) return false;
    if (nextExpanded) {
      paperPickerExpandedPaperKeys.add(itemId);
    } else {
      paperPickerExpandedPaperKeys.delete(itemId);
    }
    rebuildPaperPickerRows();
    return true;
  };

  const togglePaperPickerCollectionExpanded = (
    collectionId: number,
    expanded?: boolean,
  ): boolean => {
    const collection = getPaperPickerCollectionById(collectionId);
    if (!collection) return false;
    const currentlyExpanded =
      paperPickerExpandedCollectionKeys.has(collectionId);
    const nextExpanded = expanded === undefined ? !currentlyExpanded : expanded;
    if (nextExpanded === currentlyExpanded) return false;
    if (nextExpanded) {
      paperPickerExpandedCollectionKeys.add(collectionId);
    } else {
      paperPickerExpandedCollectionKeys.delete(collectionId);
    }
    rebuildPaperPickerRows();
    return true;
  };

  const setPaperPickerSearchResults = (
    groups: PaperSearchGroupCandidate[],
    collections: PaperBrowseCollectionCandidate[],
  ): void => {
    paperPickerMode = groups.length || collections.length ? "search" : "empty";
    paperPickerEmptyMessage = "No items matched.";
    paperPickerGroups = groups;
    paperPickerCollections = collections;
    paperPickerGroupByItemId = new Map<number, PaperSearchGroupCandidate>();
    paperPickerCollectionById = new Map<
      number,
      PaperBrowseCollectionCandidate
    >();
    paperPickerExpandedPaperKeys = new Set<number>();
    paperPickerExpandedCollectionKeys = new Set<number>();
    for (const group of groups)
      paperPickerGroupByItemId.set(group.itemId, group);
    for (const collection of collections) {
      paperPickerCollectionById.set(collection.collectionId, collection);
    }
  };

  const setPaperPickerCollections = (
    collections: PaperBrowseCollectionCandidate[],
  ): void => {
    paperPickerMode = collections.length ? "browse" : "empty";
    paperPickerEmptyMessage = "No references available.";
    paperPickerGroups = [];
    paperPickerCollections = collections;
    paperPickerGroupByItemId = new Map<number, PaperSearchGroupCandidate>();
    paperPickerCollectionById = new Map<
      number,
      PaperBrowseCollectionCandidate
    >();
    paperPickerExpandedPaperKeys = new Set<number>();
    paperPickerExpandedCollectionKeys = new Set<number>();

    const registerCollection = (collection: PaperBrowseCollectionCandidate) => {
      paperPickerCollectionById.set(collection.collectionId, collection);
      for (const paper of collection.papers) {
        paperPickerGroupByItemId.set(paper.itemId, paper);
      }
      for (const child of collection.childCollections) {
        registerCollection(child);
      }
    };
    for (const collection of collections) registerCollection(collection);
  };

  const rebuildPaperPickerRows = () => {
    const rows: PaperPickerRow[] = [];
    const appendPaperRow = (
      group: PaperSearchGroupCandidate,
      depth: number,
    ) => {
      rows.push({ kind: "paper", itemId: group.itemId, depth });
      if (group.attachments.length <= 1) return;
      if (!isPaperPickerGroupExpanded(group.itemId)) return;
      group.attachments.forEach((_attachment, attachmentIndex) => {
        rows.push({
          kind: "attachment",
          itemId: group.itemId,
          attachmentIndex,
          depth: depth + 1,
        });
      });
    };
    const appendCollectionRows = (
      collections: PaperBrowseCollectionCandidate[],
      depth: number,
    ) => {
      for (const collection of collections) {
        rows.push({
          kind: "collection",
          collectionId: collection.collectionId,
          depth,
        });
        if (!isPaperPickerCollectionExpanded(collection.collectionId)) continue;
        appendCollectionRows(collection.childCollections, depth + 1);
        for (const paper of collection.papers) appendPaperRow(paper, depth + 1);
      }
    };

    if (paperPickerMode === "browse") {
      appendCollectionRows(paperPickerCollections, 0);
    } else if (paperPickerMode === "search") {
      for (const collection of paperPickerCollections) {
        rows.push({
          kind: "collection",
          collectionId: collection.collectionId,
          depth: 0,
        });
      }
      paperPickerGroups.forEach((group) => appendPaperRow(group, 0));
    }

    paperPickerRows = rows;
    if (!paperPickerRows.length) {
      paperPickerActiveRowIndex = 0;
      return;
    }
    paperPickerActiveRowIndex = Math.max(
      0,
      Math.min(paperPickerRows.length - 1, paperPickerActiveRowIndex),
    );
  };

  const getPaperPickerRowAt = (index: number): PaperPickerRow | null =>
    paperPickerRows[index] || null;

  const findPaperPickerPaperRowIndex = (itemId: number): number =>
    paperPickerRows.findIndex(
      (row) => row.kind === "paper" && row.itemId === itemId,
    );

  const findPaperPickerFirstAttachmentRowIndex = (itemId: number): number =>
    paperPickerRows.findIndex(
      (row) => row.kind === "attachment" && row.itemId === itemId,
    );

  const findPaperPickerParentRowIndex = (index: number): number => {
    const row = getPaperPickerRowAt(index);
    if (!row || row.depth <= 0) return -1;
    for (
      let candidateIndex = index - 1;
      candidateIndex >= 0;
      candidateIndex -= 1
    ) {
      const candidateRow = paperPickerRows[candidateIndex];
      if (candidateRow && candidateRow.depth === row.depth - 1) {
        return candidateIndex;
      }
    }
    return -1;
  };

  const findPaperPickerFirstChildRowIndex = (index: number): number => {
    const row = getPaperPickerRowAt(index);
    if (!row) return -1;
    const nextRow = getPaperPickerRowAt(index + 1);
    return nextRow && nextRow.depth === row.depth + 1 ? index + 1 : -1;
  };

  const positionPaperPickerForVisibleAnchor = () => {
    if (!paperPicker) return;
    const ownerDoc = body.ownerDocument;
    const ownerWin = ownerDoc?.defaultView;
    const composeArea = paperPicker.parentElement as HTMLElement | null;
    if (!ownerDoc || !ownerWin || !composeArea) {
      paperPicker.classList.remove("llm-paper-picker-below");
      return;
    }
    const anchorRect = composeArea.getBoundingClientRect();
    const panelRect = panelRoot.getBoundingClientRect?.();
    const viewportTop = Math.max(0, panelRect?.top ?? 0);
    const viewportBottom = Math.min(
      ownerWin.innerHeight || ownerDoc.documentElement?.clientHeight || 0,
      panelRect?.bottom ?? Number.POSITIVE_INFINITY,
    );
    const margin = 12;
    const pickerHeight = Math.max(
      1,
      paperPicker.getBoundingClientRect().height || paperPicker.scrollHeight,
    );
    const spaceAbove = Math.max(0, anchorRect.top - viewportTop - margin);
    const spaceBelow = Math.max(0, viewportBottom - anchorRect.bottom - margin);
    paperPicker.classList.toggle(
      "llm-paper-picker-below",
      spaceAbove < pickerHeight && spaceBelow > spaceAbove,
    );
  };

  const showPaperPicker = () => {
    if (!paperPicker) return;
    paperPicker.style.display = "block";
    positionPaperPickerForVisibleAnchor();
  };

  const upsertPaperContext = (paper: PaperContextRef): boolean => {
    const item = deps.getItem();
    if (!item) return false;
    const autoLoadedPaperContext = deps.resolveAutoLoadedPaperContext();
    if (isSamePaperContextRef(paper, autoLoadedPaperContext)) {
      setStatus(t("Paper already selected"), "warning");
      return false;
    }
    const selectedPapers = deps.getManualPaperContextsForItem(
      item.id,
      autoLoadedPaperContext,
    );
    const duplicate = selectedPapers.some(
      (entry) =>
        entry.itemId === paper.itemId &&
        entry.contextItemId === paper.contextItemId,
    );
    if (duplicate) {
      setStatus(t("Paper already selected"), "warning");
      return false;
    }
    if (selectedPapers.length >= MAX_SELECTED_PAPER_CONTEXTS) {
      setStatus(`Paper Context up to ${MAX_SELECTED_PAPER_CONTEXTS}`, "error");
      return false;
    }
    const metadata = resolvePaperContextDisplayMetadata(paper);
    const nextPapers = [
      ...selectedPapers,
      {
        ...paper,
        firstCreator: metadata.firstCreator || paper.firstCreator,
        year: metadata.year || paper.year,
      },
    ];
    selectedPaperContextCache.set(item.id, nextPapers);
    setPaperModeOverride(
      item.id,
      nextPapers[nextPapers.length - 1],
      "full-next",
    );
    selectedPaperPreviewExpandedCache.set(item.id, false);
    deps.updatePaperPreviewPreservingScroll();
    const addedPaper = nextPapers[nextPapers.length - 1];
    const mineruTag = deps.isPaperContextMineru(addedPaper)
      ? ` ${t("(MinerU)")}`
      : "";
    setStatus(
      `${t("Paper context added. Full text will be sent on the next turn.")}${mineruTag}`,
      "ready",
    );
    return true;
  };

  const upsertNoteTextContext = (contextItemId: number): boolean => {
    const item = deps.getItem();
    const textContextKey = deps.getTextContextConversationKey();
    if (!item || !textContextKey) return false;
    const noteItem = Zotero.Items.get(contextItemId) || null;
    const snapshot = readNoteSnapshot(noteItem);
    if (!snapshot?.text) {
      setStatus(t("Selected note is empty"), "warning");
      return false;
    }
    const appended = appendSelectedTextContextForItem(
      textContextKey,
      snapshot.text,
      "note",
      undefined,
      undefined,
      {
        libraryID: snapshot.libraryID,
        noteItemKey: snapshot.noteItemKey || "",
        noteItemId: snapshot.noteId,
        parentItemId: snapshot.parentItemId,
        parentItemKey: snapshot.parentItemKey,
        noteKind: snapshot.noteKind,
        title: snapshot.title || `Note ${snapshot.noteId}`,
      },
    );
    if (!appended) {
      setStatus(t("Note already selected"), "warning");
      return false;
    }
    deps.updateSelectedTextPreviewPreservingScroll();
    setStatus(t("Note context added as text."), "ready");
    return true;
  };

  const addZoteroItemsAsPaperContext = (zoteroItems: Zotero.Item[]): void => {
    if (!deps.getItem()) return;
    let added = 0;
    let skipped = 0;
    for (const zoteroItem of zoteroItems) {
      if ((zoteroItem as any).isNote?.()) {
        if (upsertNoteTextContext(zoteroItem.id)) added += 1;
        else skipped += 1;
        continue;
      }
      const ref = resolvePaperContextRefFromItem(zoteroItem);
      if (!ref) {
        skipped += 1;
        continue;
      }
      if (upsertPaperContext(ref)) added += 1;
      else skipped += 1;
    }
    if (zoteroItems.length > 1) {
      if (added > 0 && skipped > 0) {
        setStatus(`Added ${added} paper(s), ${skipped} skipped`, "warning");
      } else if (added > 0) {
        setStatus(`Added ${added} paper(s) as context`, "ready");
      }
    }
  };

  const upsertOtherRefContext = (ref: OtherContextRef): boolean => {
    const item = deps.getItem();
    if (!item) return false;
    const existing = selectedOtherRefContextCache.get(item.id) || [];
    if (existing.some((entry) => entry.contextItemId === ref.contextItemId)) {
      setStatus(t("File already selected"), "warning");
      return false;
    }
    selectedOtherRefContextCache.set(item.id, [...existing, ref]);
    deps.updatePaperPreviewPreservingScroll();
    setStatus(
      `${ref.refKind === "figure" ? "Figure" : "File"} context added.`,
      "ready",
    );
    return true;
  };

  const selectPaperPickerAttachment = (
    itemId: number,
    attachmentIndex: number,
    selectionKind: "paper-single" | "attachment",
  ): boolean => {
    const selectedGroup = getPaperPickerGroupByItemId(itemId);
    if (!selectedGroup) return false;
    const selectedAttachment = selectedGroup.attachments[attachmentIndex];
    if (!selectedAttachment) return false;
    const contentType = selectedAttachment.contentType;
    const kind = resolvePickerItemKind(contentType);
    deps.log("LLM: Picker selection", {
      selectionKind,
      kind,
      itemId: selectedGroup.itemId,
      contextItemId: selectedAttachment.contextItemId,
    });
    if (kind === "pdf") {
      upsertPaperContext({
        itemId: selectedGroup.itemId,
        contextItemId: selectedAttachment.contextItemId,
        title: selectedGroup.title,
        attachmentTitle: selectedAttachment.title,
        citationKey: selectedGroup.citationKey,
        firstCreator: selectedGroup.firstCreator,
        year: selectedGroup.year,
      });
    } else if (kind === "note") {
      upsertNoteTextContext(selectedAttachment.contextItemId);
    } else {
      upsertOtherRefContext({
        contextItemId: selectedAttachment.contextItemId,
        parentItemId:
          selectedGroup.itemId !== selectedAttachment.contextItemId
            ? selectedGroup.itemId
            : undefined,
        title: selectedAttachment.title || selectedGroup.title,
        contentType: contentType || "application/octet-stream",
        refKind: kind === "figure" ? "figure" : "other",
      });
    }
    consumeAtQueryOnly();
    schedulePaperPickerSearch();
    renderPaperPicker();
    inputBox.focus({ preventScroll: true });
    return true;
  };

  const selectCollectionFromPickerUnified = (collectionId: number): boolean => {
    const item = deps.getItem();
    if (!item) return false;
    const collection = getPaperPickerCollectionById(collectionId);
    if (!collection) return false;
    const libraryID = deps.getCurrentLibraryID();
    const ref: CollectionContextRef = {
      collectionId: collection.collectionId,
      name: collection.name,
      libraryID,
    };
    const existing = selectedCollectionContextCache.get(item.id) || [];
    if (existing.some((entry) => entry.collectionId === ref.collectionId)) {
      setStatus(t("Collection already selected"), "warning");
      return false;
    }
    selectedCollectionContextCache.set(item.id, [...existing, ref]);
    consumeAtQueryOnly();
    schedulePaperPickerSearch();
    deps.updatePaperPreviewPreservingScroll();
    renderPaperPicker();
    inputBox.focus({ preventScroll: true });
    setStatus(t("Collection context added."), "ready");
    return true;
  };

  const selectPaperPickerRowAt = (index: number): boolean => {
    const row = getPaperPickerRowAt(index);
    if (!row) return false;
    if (row.kind === "collection") {
      if (paperPickerMode === "search") {
        return selectCollectionFromPickerUnified(row.collectionId);
      }
      togglePaperPickerCollectionExpanded(row.collectionId);
      renderPaperPicker();
      return true;
    }
    if (row.kind === "attachment") {
      return selectPaperPickerAttachment(
        row.itemId,
        row.attachmentIndex,
        "attachment",
      );
    }
    const group = getPaperPickerGroupByItemId(row.itemId);
    if (!group) return false;
    if (group.attachments.length <= 1) {
      return selectPaperPickerAttachment(row.itemId, 0, "paper-single");
    }
    if (!isPaperPickerGroupExpanded(row.itemId)) {
      togglePaperPickerGroupExpanded(row.itemId, true);
      deps.log("LLM: Paper picker expanded group via keyboard", {
        itemId: group.itemId,
      });
      renderPaperPicker();
      return true;
    }
    const firstChildIndex = findPaperPickerFirstAttachmentRowIndex(row.itemId);
    if (firstChildIndex >= 0) {
      paperPickerActiveRowIndex = firstChildIndex;
      renderPaperPicker();
      return true;
    }
    return false;
  };

  const handleArrowRight = () => {
    const activeRow = getPaperPickerRowAt(paperPickerActiveRowIndex);
    if (!activeRow) return;
    if (activeRow.kind === "collection") {
      if (!isPaperPickerCollectionExpanded(activeRow.collectionId)) {
        togglePaperPickerCollectionExpanded(activeRow.collectionId, true);
        renderPaperPicker();
        return;
      }
      const firstChildIndex = findPaperPickerFirstChildRowIndex(
        paperPickerActiveRowIndex,
      );
      if (firstChildIndex >= 0) {
        paperPickerActiveRowIndex = firstChildIndex;
        renderPaperPicker();
      }
      return;
    }
    if (activeRow.kind !== "paper") return;
    const group = getPaperPickerGroupByItemId(activeRow.itemId);
    if (!group || group.attachments.length <= 1) return;
    if (!isPaperPickerGroupExpanded(activeRow.itemId)) {
      togglePaperPickerGroupExpanded(activeRow.itemId, true);
      renderPaperPicker();
      return;
    }
    const firstChildIndex = findPaperPickerFirstAttachmentRowIndex(
      activeRow.itemId,
    );
    if (firstChildIndex >= 0 && firstChildIndex !== paperPickerActiveRowIndex) {
      paperPickerActiveRowIndex = firstChildIndex;
      renderPaperPicker();
    }
  };

  const handleArrowLeft = () => {
    const activeRow = getPaperPickerRowAt(paperPickerActiveRowIndex);
    if (!activeRow) return;
    if (activeRow.kind === "collection") {
      if (isPaperPickerCollectionExpanded(activeRow.collectionId)) {
        togglePaperPickerCollectionExpanded(activeRow.collectionId, false);
        renderPaperPicker();
        return;
      }
      const parentIndex = findPaperPickerParentRowIndex(
        paperPickerActiveRowIndex,
      );
      if (parentIndex >= 0) {
        paperPickerActiveRowIndex = parentIndex;
        renderPaperPicker();
      }
      return;
    }
    if (activeRow.kind === "attachment") {
      const parentIndex = findPaperPickerPaperRowIndex(activeRow.itemId);
      if (parentIndex >= 0 && parentIndex !== paperPickerActiveRowIndex) {
        paperPickerActiveRowIndex = parentIndex;
        renderPaperPicker();
      }
      return;
    }
    const group = getPaperPickerGroupByItemId(activeRow.itemId);
    if (
      group &&
      group.attachments.length > 1 &&
      isPaperPickerGroupExpanded(activeRow.itemId)
    ) {
      togglePaperPickerGroupExpanded(activeRow.itemId, false);
      renderPaperPicker();
      return;
    }
    const parentIndex = findPaperPickerParentRowIndex(
      paperPickerActiveRowIndex,
    );
    if (parentIndex >= 0) {
      paperPickerActiveRowIndex = parentIndex;
      renderPaperPicker();
    }
  };

  const renderPaperPicker = () => {
    if (!paperPicker || !paperPickerList) return;
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc) return;
    if (paperPickerMode === "empty") {
      paperPickerList.innerHTML = "";
      paperPicker.scrollTop = 0;
      paperPickerList.appendChild(
        createElement(ownerDoc, "div", "llm-paper-picker-empty", {
          textContent: paperPickerEmptyMessage,
        }),
      );
      showPaperPicker();
      return;
    }
    rebuildPaperPickerRows();
    if (!paperPickerRows.length) {
      const emptyMessage =
        paperPickerMode === "browse"
          ? "No items available."
          : "No items matched.";
      paperPickerMode = "empty";
      paperPickerEmptyMessage = emptyMessage;
      renderPaperPicker();
      return;
    }
    paperPickerList.innerHTML = "";
    paperPickerRows.forEach((row, rowIndex) => {
      const option = createElement(
        ownerDoc,
        "div",
        `llm-paper-picker-item ${
          row.kind === "attachment"
            ? "llm-paper-picker-attachment-row"
            : row.kind === "paper"
              ? "llm-paper-picker-group-row"
              : "llm-paper-picker-group-row llm-paper-picker-collection-row"
        }`,
      );
      option.setAttribute("role", "option");
      option.setAttribute(
        "aria-selected",
        rowIndex === paperPickerActiveRowIndex ? "true" : "false",
      );
      option.tabIndex = -1;
      option.style.paddingLeft = `${9 + row.depth * 14}px`;

      const item = deps.getItem();
      if (item && (row.kind === "paper" || row.kind === "attachment")) {
        const autoLoadedPaperContext = deps.resolveAutoLoadedPaperContext();
        const selectedPapers = deps.getManualPaperContextsForItem(
          item.id,
          autoLoadedPaperContext,
        );
        const selectedOtherRefs =
          selectedOtherRefContextCache.get(item.id) || [];
        const group = getPaperPickerGroupByItemId(row.itemId);
        if (group) {
          const attachmentIndex =
            row.kind === "attachment" ? row.attachmentIndex : 0;
          const attachment = group.attachments[attachmentIndex];
          if (attachment) {
            const isSelected =
              (autoLoadedPaperContext?.itemId === group.itemId &&
                autoLoadedPaperContext.contextItemId ===
                  attachment.contextItemId) ||
              selectedPapers.some(
                (paper) => paper.contextItemId === attachment.contextItemId,
              ) ||
              selectedOtherRefs.some(
                (ref) => ref.contextItemId === attachment.contextItemId,
              );
            option.classList.toggle("llm-paper-picker-selected", isSelected);
          }
        }
      }

      if (row.kind === "collection") {
        const collection = getPaperPickerCollectionById(row.collectionId);
        if (!collection) return;
        if (item) {
          const selectedCollections =
            selectedCollectionContextCache.get(item.id) || [];
          option.classList.toggle(
            "llm-paper-picker-selected",
            selectedCollections.some(
              (collectionRef) =>
                collectionRef.collectionId === row.collectionId,
            ),
          );
        }
        option.setAttribute(
          "aria-expanded",
          isPaperPickerCollectionExpanded(row.collectionId) ? "true" : "false",
        );
        const rowMain = createElement(
          ownerDoc,
          "div",
          "llm-paper-picker-group-row-main",
        );
        const titleLine = createElement(
          ownerDoc,
          "div",
          "llm-paper-picker-group-title-line",
        );
        const chevron = createElement(
          ownerDoc,
          "span",
          isPaperPickerCollectionExpanded(row.collectionId)
            ? "llm-paper-picker-group-chevron llm-folder-open"
            : "llm-paper-picker-group-chevron llm-folder-closed",
        );
        const title = createElement(
          ownerDoc,
          "span",
          "llm-paper-picker-title",
          { textContent: collection.name, title: collection.name },
        );
        titleLine.append(chevron, title);
        rowMain.appendChild(titleLine);
        option.appendChild(rowMain);
        const addBtn = createElement(
          ownerDoc,
          "button",
          "llm-paper-picker-collection-add-btn",
          { textContent: "+", title: t("Add collection as context") },
        );
        addBtn.addEventListener("mousedown", (event: Event) => {
          event.preventDefault();
          event.stopPropagation();
          selectCollectionFromPickerUnified(row.collectionId);
        });
        option.appendChild(addBtn);
      } else if (row.kind === "paper") {
        const group = getPaperPickerGroupByItemId(row.itemId);
        if (!group) return;
        const isMultiAttachment = group.attachments.length > 1;
        const expanded = isPaperPickerGroupExpanded(row.itemId);
        if (isMultiAttachment)
          option.setAttribute("aria-expanded", expanded ? "true" : "false");
        const rowMain = createElement(
          ownerDoc,
          "div",
          "llm-paper-picker-group-row-main",
        );
        const titleLine = createElement(
          ownerDoc,
          "div",
          "llm-paper-picker-group-title-line",
        );
        titleLine.append(
          createElement(ownerDoc, "span", "llm-paper-picker-item-icon", {
            textContent: resolveGroupIcon(group),
          }),
          createElement(ownerDoc, "span", "llm-paper-picker-title", {
            textContent: group.title,
            title: group.title,
          }),
        );
        if (isMultiAttachment) {
          titleLine.appendChild(
            createElement(ownerDoc, "span", "llm-paper-picker-badge", {
              textContent: `${group.attachments.length} files`,
            }),
          );
        }
        rowMain.appendChild(titleLine);
        const metaText = buildPaperMetaText(group);
        if (metaText) {
          rowMain.appendChild(
            createElement(ownerDoc, "span", "llm-paper-picker-meta", {
              textContent: metaText,
            }),
          );
        }
        option.appendChild(rowMain);
      } else {
        const group = getPaperPickerGroupByItemId(row.itemId);
        if (!group) return;
        const attachment = group.attachments[row.attachmentIndex];
        if (!attachment) return;
        const attachmentKind = resolvePickerItemKind(attachment.contentType);
        const attachmentText = createElement(
          ownerDoc,
          "div",
          "llm-paper-picker-attachment-text",
        );
        attachmentText.append(
          createElement(ownerDoc, "span", "llm-paper-picker-title", {
            textContent: getPaperPickerAttachmentDisplayTitle(
              group,
              attachment,
              row.attachmentIndex,
            ),
            title: getPaperPickerAttachmentDisplayTitle(
              group,
              attachment,
              row.attachmentIndex,
            ),
          }),
          createElement(ownerDoc, "span", "llm-paper-picker-meta", {
            textContent: `${resolvePickerKindLabel(attachmentKind)} attachment`,
          }),
        );
        const attachmentMain = createElement(
          ownerDoc,
          "div",
          "llm-paper-picker-attachment-main",
        );
        attachmentMain.append(
          createElement(ownerDoc, "span", "llm-paper-picker-item-icon", {
            textContent: resolvePickerKindIcon(attachmentKind),
          }),
          attachmentText,
        );
        option.append(
          createElement(ownerDoc, "span", "llm-paper-picker-attachment-indent"),
          attachmentMain,
        );
      }

      option.addEventListener("mousedown", (event: Event) => {
        const mouse = event as MouseEvent;
        if (typeof mouse.button === "number" && mouse.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        paperPickerActiveRowIndex = rowIndex;
        selectPaperPickerRowAt(rowIndex);
      });
      option.addEventListener("click", (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      paperPickerList.appendChild(option);
    });
    showPaperPicker();
    const activeOption = paperPickerList.children[
      paperPickerActiveRowIndex
    ] as HTMLElement | null;
    if (paperPickerActiveRowIndex <= 0) {
      paperPicker.scrollTop = 0;
    } else {
      activeOption?.scrollIntoView({ block: "nearest" });
    }
  };

  const schedulePaperPickerSearch = () => {
    const item = deps.getItem();
    if (!item || !paperPicker || !paperPickerList) {
      closePaperPicker();
      return;
    }
    try {
      if (deps.isWebChatMode()) {
        closePaperPicker();
        return;
      }
    } catch {
      /* keep closed if mode cannot be resolved */
    }
    const slashToken = getActiveAtToken();
    if (!slashToken) {
      closePaperPicker();
      return;
    }
    clearPaperPickerDebounceTimer();
    const requestId = ++paperPickerRequestSeq;
    const runSearch = async () => {
      paperPickerDebounceTimer = null;
      if (!deps.getItem()) return;
      const activeSlashToken = getActiveAtToken();
      if (!activeSlashToken) {
        closePaperPicker();
        return;
      }
      const libraryID = deps.getCurrentLibraryID();
      if (!libraryID) {
        closePaperPicker();
        return;
      }
      if (!normalizePaperSearchText(activeSlashToken.query)) {
        const collections = await browseAllItemCandidates(libraryID);
        if (requestId !== paperPickerRequestSeq) return;
        if (!getActiveAtToken()) {
          closePaperPicker();
          return;
        }
        setPaperPickerCollections(collections);
        paperPickerActiveRowIndex = 0;
        renderPaperPicker();
        return;
      }
      const [paperResults, collectionResults] = await Promise.all([
        searchAllItemCandidates(libraryID, activeSlashToken.query, 20),
        searchCollectionCandidates(libraryID, activeSlashToken.query),
      ]);
      if (requestId !== paperPickerRequestSeq) return;
      if (!getActiveAtToken()) {
        closePaperPicker();
        return;
      }
      setPaperPickerSearchResults(paperResults, collectionResults);
      paperPickerActiveRowIndex = 0;
      renderPaperPicker();
    };
    const win = body.ownerDocument?.defaultView;
    if (win) {
      paperPickerDebounceTimer = win.setTimeout(() => {
        void runSearch();
      }, 120);
    } else {
      paperPickerDebounceTimer =
        (setTimeout(() => {
          void runSearch();
        }, 120) as unknown as number) || 0;
    }
  };

  const moveActiveRow = (delta: number) => {
    if (!paperPickerRows.length) return;
    paperPickerActiveRowIndex =
      (paperPickerActiveRowIndex + delta + paperPickerRows.length) %
      paperPickerRows.length;
    renderPaperPicker();
  };

  return {
    getActiveAtToken,
    isPaperPickerOpen,
    closePaperPicker,
    schedulePaperPickerSearch,
    moveActiveRow,
    selectActiveRow: () => {
      selectPaperPickerRowAt(paperPickerActiveRowIndex);
    },
    handleArrowRight,
    handleArrowLeft,
    addZoteroItemsAsPaperContext,
  };
}
