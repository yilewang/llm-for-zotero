import { createElement } from "../../../../utils/domHelpers";
import { t } from "../../../../utils/i18n";
import { MAX_SELECTED_PAPER_CONTEXTS } from "../../constants";
import {
  selectedCollectionContextCache,
  selectedOtherRefContextCache,
  selectedPaperContextCache,
  selectedPaperPreviewExpandedCache,
  paperContextModeOverrides,
  selectedTagContextCache,
} from "../../state";
import {
  appendSelectedTextContextForItem,
  getSelectedTextContextEntries,
  setSelectedTextContextEntries,
} from "../../contextResolution";
import { resolveContextAttachmentSupportFromMetadata } from "../../contextAttachmentSupport";
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
import {
  buildMineruTagIndex,
  computeMineruTagAvailability,
  filterMineruItemsForTagView,
  getSortedMineruTagInfos,
  normalizeMineruTagName,
  type MineruTagInfo,
  type MineruTagMatchMode,
  type MineruTagScope,
} from "../../../mineruTagIndex";
import { readNoteSnapshot } from "../../notes";
import type {
  CollectionContextRef,
  OtherContextRef,
  PaperContextRef,
  TagContextRef,
} from "../../types";
import { setPaperModeOverride } from "../../contexts/paperContextState";
import { isSamePaperContextRef } from "../../modeBehavior";
import { buildPaperKey } from "../../pdfContext";
import { resolvePaperContextDisplayMetadata } from "./composeContextController";

type StatusLevel = "ready" | "warning" | "error";
type ActiveSlashToken = PaperSearchSlashToken;
type PaperPickerMode = "browse" | "search" | "empty";
type PaperPickerRenderOptions = {
  preserveReferenceScroll?: boolean;
  skipActiveScroll?: boolean;
};
type PickerIconName =
  | "paper"
  | "pdf"
  | "note"
  | "image"
  | "file"
  | "collection";
type PaperPickerFolderScope = "all" | number;
type PaperPickerPanelKey = "folders" | "tags" | "references";
export type PaperPickerTagIndexItem = {
  attachmentId: number;
  tags: readonly string[];
  tagsAuto: readonly string[];
  group: PaperSearchGroupCandidate;
};
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

const PAPER_PICKER_VIEWPORT_MARGIN = 12;
const PAPER_PICKER_ANCHOR_GAP = 8;
const PAPER_PICKER_MIN_USEFUL_HEIGHT = 120;
const PAPER_PICKER_MAX_HEIGHT = 720;
const PAPER_PICKER_VIEWPORT_FRACTION = 0.82;
const PAPER_PICKER_DEFAULT_COLLAPSED_PANELS: PaperPickerPanelKey[] = ["tags"];
const PAPER_PICKER_PANEL_DEFAULT_HEIGHT: Record<PaperPickerPanelKey, number> = {
  folders: 190,
  tags: 180,
  references: 360,
};
const PAPER_PICKER_PANEL_MIN_HEIGHT: Record<PaperPickerPanelKey, number> = {
  folders: 165,
  tags: 150,
  references: 240,
};
const PAPER_PICKER_PANEL_MAX_HEIGHT: Record<PaperPickerPanelKey, number> = {
  folders: 420,
  tags: 300,
  references: 520,
};
const PAPER_PICKER_PANEL_KEYS: PaperPickerPanelKey[] = [
  "folders",
  "references",
  "tags",
];
const PAPER_PICKER_PANEL_COLLAPSED_HEIGHT = 28;
const PAPER_PICKER_LIST_VERTICAL_PADDING = 12;

function comparePaperPickerGroupsByAdded(
  a: PaperSearchGroupCandidate,
  b: PaperSearchGroupCandidate,
): number {
  const addedDelta = (b.addedAt || 0) - (a.addedAt || 0);
  if (addedDelta !== 0) return addedDelta;
  const modifiedDelta = b.modifiedAt - a.modifiedAt;
  if (modifiedDelta !== 0) return modifiedDelta;
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
}

export function buildPaperPickerTagIndexItems(
  groups: readonly PaperSearchGroupCandidate[],
): PaperPickerTagIndexItem[] {
  return groups.map((group) => ({
    attachmentId: group.itemId,
    tags: group.tags || [],
    tagsAuto: group.tagsAuto || [],
    group,
  }));
}

export function filterPaperPickerGroupsForTagView(
  groups: readonly PaperSearchGroupCandidate[],
  options: {
    tagScope?: MineruTagScope;
    selectedTags?: Iterable<string>;
    includeAutomatic?: boolean;
    tagMatchMode?: MineruTagMatchMode;
  } = {},
): PaperSearchGroupCandidate[] {
  return filterMineruItemsForTagView(buildPaperPickerTagIndexItems(groups), {
    scope: options.tagScope,
    selectedTags: options.selectedTags,
    includeAutomatic: options.includeAutomatic,
    matchMode: options.tagMatchMode,
  }).map((item) => item.group);
}

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

export function positionPaperPickerForAnchor(params: {
  body: Element;
  panelRoot: HTMLElement;
  paperPicker: HTMLDivElement;
  anchor: HTMLElement | null;
}): void {
  const { body, panelRoot, paperPicker, anchor } = params;
  const ownerDoc = body.ownerDocument;
  const ownerWin = ownerDoc?.defaultView;
  if (!ownerDoc || !ownerWin || !anchor) {
    paperPicker.classList.remove("llm-paper-picker-below");
    paperPicker.style.removeProperty("--llm-paper-picker-max-height");
    return;
  }

  const anchorRect = anchor.getBoundingClientRect();
  const panelRect = panelRoot.getBoundingClientRect?.();
  const viewportHeight =
    ownerWin.innerHeight || ownerDoc.documentElement?.clientHeight || 0;
  const viewportTop = Math.max(0, panelRect?.top ?? 0);
  const viewportBottom = Math.min(
    viewportHeight || Number.POSITIVE_INFINITY,
    panelRect?.bottom ?? Number.POSITIVE_INFINITY,
  );
  const preferredMaxHeight = Math.max(
    PAPER_PICKER_MIN_USEFUL_HEIGHT,
    Math.floor(
      Math.min(
        PAPER_PICKER_MAX_HEIGHT,
        (viewportHeight ||
          PAPER_PICKER_MAX_HEIGHT / PAPER_PICKER_VIEWPORT_FRACTION) *
          PAPER_PICKER_VIEWPORT_FRACTION,
      ),
    ),
  );
  const spaceAbove = Math.max(
    0,
    anchorRect.top -
      viewportTop -
      PAPER_PICKER_VIEWPORT_MARGIN -
      PAPER_PICKER_ANCHOR_GAP,
  );
  const spaceBelow = Math.max(
    0,
    viewportBottom -
      anchorRect.bottom -
      PAPER_PICKER_VIEWPORT_MARGIN -
      PAPER_PICKER_ANCHOR_GAP,
  );
  const placeBelow =
    spaceAbove < PAPER_PICKER_MIN_USEFUL_HEIGHT && spaceBelow > spaceAbove;
  const availableHeight = placeBelow ? spaceBelow : spaceAbove;
  const maxHeight = Math.max(
    1,
    Math.floor(Math.min(preferredMaxHeight, availableHeight)),
  );

  paperPicker.classList.toggle("llm-paper-picker-below", placeBelow);
  paperPicker.style.setProperty(
    "--llm-paper-picker-max-height",
    `${maxHeight}px`,
  );
}

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
  let paperPickerActiveFolderScope: PaperPickerFolderScope = "all";
  let paperPickerFolderFilterQuery = "";
  let paperPickerTagScope: MineruTagScope = "all";
  let paperPickerSelectedTags = new Set<string>();
  let paperPickerTagFilterQuery = "";
  let paperPickerTagMatchMode: MineruTagMatchMode = "and";
  let paperPickerShowAutomaticTags = false;
  let paperPickerTagFilterMenuOpen = false;
  let paperPickerCollapsedPanels = new Set<PaperPickerPanelKey>(
    PAPER_PICKER_DEFAULT_COLLAPSED_PANELS,
  );
  let paperPickerPanelHeights = new Map<PaperPickerPanelKey, number>();

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
    paperPickerActiveFolderScope = "all";
    paperPickerFolderFilterQuery = "";
    paperPickerTagScope = "all";
    paperPickerSelectedTags = new Set<string>();
    paperPickerTagFilterQuery = "";
    paperPickerTagMatchMode = "and";
    paperPickerShowAutomaticTags = false;
    paperPickerTagFilterMenuOpen = false;
    paperPickerCollapsedPanels = new Set<PaperPickerPanelKey>(
      PAPER_PICKER_DEFAULT_COLLAPSED_PANELS,
    );
    paperPickerPanelHeights = new Map<PaperPickerPanelKey, number>();
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

  function resolvePickerItemKind(
    contentType?: string,
    filename?: string,
  ): "pdf" | "note" | "figure" | "other" {
    if (!contentType) return "other";
    if (
      resolveContextAttachmentSupportFromMetadata({
        contentType,
        filename,
      })?.kind === "pdf"
    ) {
      return "pdf";
    }
    if (contentType === ZOTERO_NOTE_CONTENT_TYPE) return "note";
    if (contentType.startsWith("image/")) return "figure";
    return "other";
  }

  function resolvePickerKindIcon(
    kind: "pdf" | "note" | "figure" | "other",
  ): PickerIconName {
    if (kind === "pdf") return "pdf";
    if (kind === "note") return "note";
    if (kind === "figure") return "image";
    return "file";
  }

  function resolvePickerAttachmentKind(
    attachment: PaperSearchAttachmentCandidate,
  ): "pdf" | "note" | "figure" | "other" {
    return resolvePickerItemKind(attachment.contentType, attachment.title);
  }

  function resolvePickerKindLabel(
    kind: "pdf" | "note" | "figure" | "other",
  ): string {
    if (kind === "pdf") return "PDF";
    if (kind === "note") return "Note";
    if (kind === "figure") return "Figure";
    return "File";
  }

  function resolveGroupIcon(group: PaperSearchGroupCandidate): PickerIconName {
    if (group.itemKind === "standalone-note") return "note";
    const hasPdf = group.attachments.some(
      (attachment) => resolvePickerAttachmentKind(attachment) === "pdf",
    );
    if (hasPdf) return "paper";
    const hasFigure = group.attachments.some(
      (attachment) => resolvePickerAttachmentKind(attachment) === "figure",
    );
    if (hasFigure) return "image";
    const hasNote = group.attachments.some(
      (attachment) => resolvePickerAttachmentKind(attachment) === "note",
    );
    if (hasNote) return "note";
    if (group.attachments.length > 0) return "file";
    return "file";
  }

  const createPickerIcon = (
    ownerDoc: Document,
    icon: PickerIconName,
  ): HTMLSpanElement =>
    createElement(
      ownerDoc,
      "span",
      `llm-paper-picker-item-icon llm-paper-picker-icon-${icon}`,
    );

  const getPaperPickerAttachmentDisplayTitle = (
    group: PaperSearchGroupCandidate,
    attachment: PaperSearchAttachmentCandidate,
    attachmentIndex: number,
  ): string => {
    const normalizedTitle = (attachment.title || "").trim();
    if (normalizedTitle) return normalizedTitle;
    const kind = resolvePickerAttachmentKind(attachment);
    return group.attachments.length > 1
      ? `${resolvePickerKindLabel(kind)} ${attachmentIndex + 1}`
      : resolvePickerKindLabel(kind);
  };

  const getPaperPickerGroupByItemId = (itemId: number) =>
    paperPickerGroupByItemId.get(itemId) || null;

  const getPaperPickerCollectionById = (collectionId: number) =>
    paperPickerCollectionById.get(collectionId) || null;

  const getPaperPickerAllBrowseGroups = (): PaperSearchGroupCandidate[] => {
    const groupsById = new Map<number, PaperSearchGroupCandidate>();
    const visitCollection = (collection: PaperBrowseCollectionCandidate) => {
      for (const group of collection.papers) {
        groupsById.set(group.itemId, group);
      }
      for (const child of collection.childCollections) visitCollection(child);
    };
    for (const collection of paperPickerCollections)
      visitCollection(collection);
    return [...groupsById.values()].sort(comparePaperPickerGroupsByAdded);
  };

  const collectPaperPickerCollectionGroups = (
    collection: PaperBrowseCollectionCandidate,
  ): PaperSearchGroupCandidate[] => {
    const groupsById = new Map<number, PaperSearchGroupCandidate>();
    const visitCollection = (node: PaperBrowseCollectionCandidate) => {
      for (const group of node.papers) groupsById.set(group.itemId, group);
      for (const child of node.childCollections) visitCollection(child);
    };
    visitCollection(collection);
    return [...groupsById.values()].sort(comparePaperPickerGroupsByAdded);
  };

  const getPaperPickerFolderScopedGroups = (): PaperSearchGroupCandidate[] => {
    if (paperPickerMode !== "browse") return [...paperPickerGroups];
    if (paperPickerActiveFolderScope === "all") {
      return getPaperPickerAllBrowseGroups();
    }
    const collection = getPaperPickerCollectionById(
      paperPickerActiveFolderScope,
    );
    if (!collection) return [];
    return collectPaperPickerCollectionGroups(collection);
  };

  const getPaperPickerVisibleGroups = (): PaperSearchGroupCandidate[] =>
    filterPaperPickerGroupsForTagView(getPaperPickerFolderScopedGroups(), {
      tagScope: paperPickerTagScope,
      selectedTags: paperPickerSelectedTags,
      includeAutomatic: paperPickerShowAutomaticTags,
      tagMatchMode: paperPickerTagMatchMode,
    });

  const resolvePaperPickerTagColor = (name: string): string | null => {
    try {
      const color = (
        Zotero as unknown as {
          Tags?: { getColor?: (libraryID: number, name: string) => unknown };
        }
      ).Tags?.getColor?.(deps.getCurrentLibraryID(), name);
      if (typeof color === "string") return color;
      if (
        color &&
        typeof color === "object" &&
        typeof (color as { color?: unknown }).color === "string"
      ) {
        return (color as { color: string }).color;
      }
    } catch {
      /* ignore unavailable Zotero tag colors */
    }
    return null;
  };

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
    if (
      paperPickerActiveFolderScope !== "all" &&
      !paperPickerCollectionById.has(paperPickerActiveFolderScope)
    ) {
      paperPickerActiveFolderScope = "all";
    }
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
    if (paperPickerMode === "browse") {
      getPaperPickerVisibleGroups().forEach((group) =>
        appendPaperRow(group, 0),
      );
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

  const findPaperPickerDescendantByClass = (
    element: Element | undefined,
    className: string,
  ): HTMLElement | null => {
    if (!element) return null;
    if (
      element.classList?.contains(className) ||
      (typeof (element as { className?: unknown }).className === "string" &&
        (element as { className: string }).className
          .split(/\s+/)
          .includes(className))
    ) {
      return element as HTMLElement;
    }
    for (const child of Array.from(element.children || [])) {
      const match = findPaperPickerDescendantByClass(child, className);
      if (match) return match;
    }
    return null;
  };

  const getRenderedPaperPickerReferenceRowHost = (): HTMLElement | null => {
    const root = paperPickerList?.children[0] as HTMLElement | undefined;
    return findPaperPickerDescendantByClass(root, "llm-paper-picker-row-host");
  };

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
    positionPaperPickerForAnchor({
      body,
      panelRoot,
      paperPicker,
      anchor: paperPicker.parentElement as HTMLElement | null,
    });
  };

  const showPaperPicker = () => {
    if (!paperPicker) return;
    paperPicker.style.display = "block";
    positionPaperPickerForVisibleAnchor();
  };

  const refreshPaperPickerAfterContextSelection = (
    options: PaperPickerRenderOptions = {},
  ) => {
    const scrollTop = paperPicker?.scrollTop ?? 0;
    consumeAtQueryOnly();
    paperPickerRequestSeq += 1;
    clearPaperPickerDebounceTimer();
    renderPaperPicker(options);
    if (paperPicker) paperPicker.scrollTop = scrollTop;
    inputBox.focus({ preventScroll: true });
  };

  const getSelectedNoteContextItemIds = (): Set<number> => {
    const textContextKey = deps.getTextContextConversationKey();
    if (!textContextKey) return new Set();
    const noteIds = getSelectedTextContextEntries(textContextKey)
      .filter((entry) => entry.source === "note")
      .map((entry) =>
        Number(entry.noteContext?.noteItemId || entry.contextItemId),
      )
      .filter((noteId) => Number.isFinite(noteId) && noteId > 0)
      .map((noteId) => Math.floor(noteId));
    return new Set(noteIds);
  };

  const isPaperPickerGroupCoveredBySelectedCollection = (
    group: PaperSearchGroupCandidate,
  ): boolean => {
    const item = deps.getItem();
    if (!item) return false;
    const selectedCollections =
      selectedCollectionContextCache.get(item.id) || [];
    if (!selectedCollections.length) return false;
    for (const collectionRef of selectedCollections) {
      if (group.collectionIds.includes(collectionRef.collectionId)) return true;
      const collection = getPaperPickerCollectionById(
        collectionRef.collectionId,
      );
      if (!collection) continue;
      if (
        collectPaperPickerCollectionGroups(collection).some(
          (candidate) => candidate.itemId === group.itemId,
        )
      ) {
        return true;
      }
    }
    return false;
  };

  const buildPaperPickerTagContextKey = (ref: TagContextRef): string => {
    const libraryID = Math.max(0, Math.floor(Number(ref.libraryID) || 0));
    if (ref.scope) {
      return `${libraryID}:scope:${ref.scope}:${
        ref.includeAutomatic ? "auto" : "manual"
      }`;
    }
    return `${libraryID}:tag:${normalizeMineruTagName(ref.normalizedName || ref.name)}`;
  };

  const isPaperPickerGroupCoveredBySelectedTag = (
    group: PaperSearchGroupCandidate,
  ): boolean => {
    const item = deps.getItem();
    if (!item) return false;
    const selectedTags = selectedTagContextCache.get(item.id) || [];
    if (!selectedTags.length) return false;
    for (const tagRef of selectedTags) {
      const includeAutomatic =
        typeof tagRef.includeAutomatic === "boolean"
          ? tagRef.includeAutomatic
          : paperPickerShowAutomaticTags;
      if (tagRef.scope) {
        if (
          filterPaperPickerGroupsForTagView([group], {
            tagScope: tagRef.scope,
            includeAutomatic,
            tagMatchMode: paperPickerTagMatchMode,
          }).length
        ) {
          return true;
        }
        continue;
      }
      const normalizedName = normalizeMineruTagName(
        tagRef.normalizedName || tagRef.name,
      );
      if (
        normalizedName &&
        filterPaperPickerGroupsForTagView([group], {
          selectedTags: [normalizedName],
          includeAutomatic,
          tagMatchMode: "and",
        }).length
      ) {
        return true;
      }
    }
    return false;
  };

  const isPaperPickerAttachmentSelected = (
    group: PaperSearchGroupCandidate,
    attachment: PaperSearchAttachmentCandidate,
    selectedNoteContextItemIds = getSelectedNoteContextItemIds(),
  ): boolean => {
    const item = deps.getItem();
    if (!item) return false;
    if (isPaperPickerGroupCoveredBySelectedCollection(group)) return true;
    if (isPaperPickerGroupCoveredBySelectedTag(group)) return true;
    const autoLoadedPaperContext = deps.resolveAutoLoadedPaperContext();
    const selectedPapers = deps.getManualPaperContextsForItem(
      item.id,
      autoLoadedPaperContext,
    );
    const selectedOtherRefs = selectedOtherRefContextCache.get(item.id) || [];
    return (
      (autoLoadedPaperContext?.itemId === group.itemId &&
        autoLoadedPaperContext.contextItemId === attachment.contextItemId) ||
      selectedPapers.some(
        (paper) => paper.contextItemId === attachment.contextItemId,
      ) ||
      selectedOtherRefs.some(
        (ref) => ref.contextItemId === attachment.contextItemId,
      ) ||
      selectedNoteContextItemIds.has(attachment.contextItemId)
    );
  };

  const isPaperPickerGroupSelected = (
    group: PaperSearchGroupCandidate,
  ): boolean => {
    const selectedNoteContextItemIds = getSelectedNoteContextItemIds();
    return group.attachments.some((attachment) =>
      isPaperPickerAttachmentSelected(
        group,
        attachment,
        selectedNoteContextItemIds,
      ),
    );
  };

  const getDefaultPaperPickerAttachmentIndex = (
    group: PaperSearchGroupCandidate,
  ): number => {
    const pdfIndex = group.attachments.findIndex(
      (attachment) => resolvePickerAttachmentKind(attachment) === "pdf",
    );
    if (pdfIndex >= 0) return pdfIndex;
    return group.attachments.length ? 0 : -1;
  };

  const getDefaultPaperPickerAttachment = (
    group: PaperSearchGroupCandidate,
  ): PaperSearchAttachmentCandidate | null => {
    const index = getDefaultPaperPickerAttachmentIndex(group);
    return index >= 0 ? group.attachments[index] : null;
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
      { contextItemId: snapshot.noteId },
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

  const upsertPaperPickerAttachmentContext = (
    selectedGroup: PaperSearchGroupCandidate,
    selectedAttachment: PaperSearchAttachmentCandidate,
  ): boolean => {
    const kind = resolvePickerAttachmentKind(selectedAttachment);
    if (kind === "pdf") {
      return upsertPaperContext({
        itemId: selectedGroup.itemId,
        contextItemId: selectedAttachment.contextItemId,
        title: selectedGroup.title,
        attachmentTitle: selectedAttachment.title,
        citationKey: selectedGroup.citationKey,
        firstCreator: selectedGroup.firstCreator,
        year: selectedGroup.year,
      });
    }
    if (kind === "note") {
      return upsertNoteTextContext(selectedAttachment.contextItemId);
    }
    return upsertOtherRefContext({
      contextItemId: selectedAttachment.contextItemId,
      parentItemId:
        selectedGroup.itemId !== selectedAttachment.contextItemId
          ? selectedGroup.itemId
          : undefined,
      title: selectedAttachment.title || selectedGroup.title,
      contentType: selectedAttachment.contentType || "application/octet-stream",
      refKind: kind === "figure" ? "figure" : "other",
    });
  };

  const removePaperPickerAttachmentContext = (
    selectedGroup: PaperSearchGroupCandidate,
    selectedAttachment: PaperSearchAttachmentCandidate,
    options: { silent?: boolean } = {},
  ): boolean => {
    const item = deps.getItem();
    if (!item) return false;
    const kind = resolvePickerAttachmentKind(selectedAttachment);
    let removed = false;
    if (kind === "pdf") {
      const existing = selectedPaperContextCache.get(item.id) || [];
      const removedPapers = existing.filter(
        (paper) =>
          paper.itemId === selectedGroup.itemId &&
          paper.contextItemId === selectedAttachment.contextItemId,
      );
      if (removedPapers.length) {
        const next = existing.filter(
          (paper) =>
            !(
              paper.itemId === selectedGroup.itemId &&
              paper.contextItemId === selectedAttachment.contextItemId
            ),
        );
        if (next.length) selectedPaperContextCache.set(item.id, next);
        else selectedPaperContextCache.delete(item.id);
        for (const paper of removedPapers) {
          paperContextModeOverrides.delete(`${item.id}:${buildPaperKey(paper)}`);
        }
        selectedPaperPreviewExpandedCache.set(item.id, false);
        deps.updatePaperPreviewPreservingScroll();
        removed = true;
      }
    } else if (kind === "note") {
      const textContextKey = deps.getTextContextConversationKey();
      if (textContextKey) {
        const existing = getSelectedTextContextEntries(textContextKey);
        const next = existing.filter((entry) => {
          if (entry.source !== "note") return true;
          const noteItemId = Number(
            entry.noteContext?.noteItemId || entry.contextItemId || 0,
          );
          return noteItemId !== selectedAttachment.contextItemId;
        });
        if (next.length !== existing.length) {
          setSelectedTextContextEntries(textContextKey, next);
          deps.updateSelectedTextPreviewPreservingScroll();
          removed = true;
        }
      }
    } else {
      const existing = selectedOtherRefContextCache.get(item.id) || [];
      const next = existing.filter(
        (ref) => ref.contextItemId !== selectedAttachment.contextItemId,
      );
      if (next.length !== existing.length) {
        if (next.length) selectedOtherRefContextCache.set(item.id, next);
        else selectedOtherRefContextCache.delete(item.id);
        deps.updatePaperPreviewPreservingScroll();
        removed = true;
      }
    }
    if (removed && !options.silent) {
      setStatus(t("Reference context removed."), "ready");
    }
    return removed;
  };

  const removePaperPickerGroupContexts = (
    group: PaperSearchGroupCandidate,
    options: PaperPickerRenderOptions = {},
  ): boolean => {
    const item = deps.getItem();
    if (!item) return false;
    const attachmentIds = new Set(
      group.attachments.map((attachment) => attachment.contextItemId),
    );
    let removed = false;

    const existingPapers = selectedPaperContextCache.get(item.id) || [];
    const removedPapers = existingPapers.filter(
      (paper) =>
        paper.itemId === group.itemId || attachmentIds.has(paper.contextItemId),
    );
    if (removedPapers.length) {
      const nextPapers = existingPapers.filter(
        (paper) =>
          !(paper.itemId === group.itemId || attachmentIds.has(paper.contextItemId)),
      );
      if (nextPapers.length) selectedPaperContextCache.set(item.id, nextPapers);
      else selectedPaperContextCache.delete(item.id);
      for (const paper of removedPapers) {
        paperContextModeOverrides.delete(`${item.id}:${buildPaperKey(paper)}`);
      }
      selectedPaperPreviewExpandedCache.set(item.id, false);
      removed = true;
    }

    const existingOtherRefs = selectedOtherRefContextCache.get(item.id) || [];
    const nextOtherRefs = existingOtherRefs.filter(
      (ref) => !attachmentIds.has(ref.contextItemId),
    );
    if (nextOtherRefs.length !== existingOtherRefs.length) {
      if (nextOtherRefs.length) {
        selectedOtherRefContextCache.set(item.id, nextOtherRefs);
      } else {
        selectedOtherRefContextCache.delete(item.id);
      }
      removed = true;
    }

    const textContextKey = deps.getTextContextConversationKey();
    if (textContextKey) {
      const existingTexts = getSelectedTextContextEntries(textContextKey);
      const nextTexts = existingTexts.filter((entry) => {
        if (entry.source !== "note") return true;
        const noteItemId = Number(
          entry.noteContext?.noteItemId || entry.contextItemId || 0,
        );
        return !attachmentIds.has(noteItemId);
      });
      if (nextTexts.length !== existingTexts.length) {
        setSelectedTextContextEntries(textContextKey, nextTexts);
        deps.updateSelectedTextPreviewPreservingScroll();
        removed = true;
      }
    }

    if (removed) {
      deps.updatePaperPreviewPreservingScroll();
      refreshPaperPickerAfterContextSelection(options);
      setStatus(t("Reference context removed."), "ready");
    }
    return removed;
  };

  const selectPaperPickerAttachment = (
    itemId: number,
    attachmentIndex: number,
    selectionKind: "paper-single" | "attachment",
    options: PaperPickerRenderOptions = {},
  ): boolean => {
    const selectedGroup = getPaperPickerGroupByItemId(itemId);
    if (!selectedGroup) return false;
    const selectedAttachment = selectedGroup.attachments[attachmentIndex];
    if (!selectedAttachment) return false;
    const kind = resolvePickerAttachmentKind(selectedAttachment);
    deps.log("LLM: Picker selection", {
      selectionKind,
      kind,
      itemId: selectedGroup.itemId,
      contextItemId: selectedAttachment.contextItemId,
    });
    if (isPaperPickerAttachmentSelected(selectedGroup, selectedAttachment)) {
      if (!removePaperPickerAttachmentContext(selectedGroup, selectedAttachment)) {
        setStatus(t("Paper already selected"), "warning");
      }
    } else {
      upsertPaperPickerAttachmentContext(selectedGroup, selectedAttachment);
    }
    refreshPaperPickerAfterContextSelection(options);
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
    const existingIndex = existing.findIndex(
      (entry) => entry.collectionId === ref.collectionId,
    );
    if (existingIndex >= 0) {
      const next = existing.filter((_, index) => index !== existingIndex);
      if (next.length) {
        selectedCollectionContextCache.set(item.id, next);
      } else {
        selectedCollectionContextCache.delete(item.id);
      }
      deps.updatePaperPreviewPreservingScroll();
      refreshPaperPickerAfterContextSelection();
      setStatus(t("Collection context removed."), "ready");
      return true;
    }
    selectedCollectionContextCache.set(item.id, [...existing, ref]);
    deps.updatePaperPreviewPreservingScroll();
    refreshPaperPickerAfterContextSelection();
    setStatus(t("Collection context added."), "ready");
    return true;
  };

  const selectTagContextFromPickerUnified = (ref: TagContextRef): boolean => {
    const item = deps.getItem();
    if (!item) return false;
    const libraryID = deps.getCurrentLibraryID();
    const normalizedRef: TagContextRef = {
      ...ref,
      libraryID,
      name: ref.name.trim(),
      normalizedName: ref.normalizedName
        ? normalizeMineruTagName(ref.normalizedName) || undefined
        : ref.scope
          ? undefined
          : normalizeMineruTagName(ref.name) || undefined,
    };
    if (
      !normalizedRef.name ||
      (!normalizedRef.scope && !normalizedRef.normalizedName)
    ) {
      return false;
    }
    const existing = selectedTagContextCache.get(item.id) || [];
    const nextKey = buildPaperPickerTagContextKey(normalizedRef);
    const existingIndex = existing.findIndex(
      (entry) => buildPaperPickerTagContextKey(entry) === nextKey,
    );
    if (existingIndex >= 0) {
      const next = existing.filter((_, index) => index !== existingIndex);
      if (next.length) {
        selectedTagContextCache.set(item.id, next);
      } else {
        selectedTagContextCache.delete(item.id);
      }
      deps.updatePaperPreviewPreservingScroll();
      refreshPaperPickerAfterContextSelection();
      setStatus(t("Tag context removed."), "ready");
      return true;
    }
    selectedTagContextCache.set(item.id, [...existing, normalizedRef]);
    deps.updatePaperPreviewPreservingScroll();
    refreshPaperPickerAfterContextSelection();
    setStatus(t("Tag context added."), "ready");
    return true;
  };

  const selectPaperPickerRowAt = (
    index: number,
    options: { preserveReferenceScroll?: boolean } = {},
  ): boolean => {
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
        {
          preserveReferenceScroll: options.preserveReferenceScroll,
          skipActiveScroll: options.preserveReferenceScroll,
        },
      );
    }
    const group = getPaperPickerGroupByItemId(row.itemId);
    if (!group) return false;
    if (group.attachments.length <= 1) {
      return selectPaperPickerAttachment(row.itemId, 0, "paper-single", {
        preserveReferenceScroll: options.preserveReferenceScroll,
        skipActiveScroll: options.preserveReferenceScroll,
      });
    }
    if (!isPaperPickerGroupExpanded(row.itemId)) {
      togglePaperPickerGroupExpanded(row.itemId, true);
      deps.log("LLM: Paper picker expanded group via keyboard", {
        itemId: group.itemId,
      });
      renderPaperPicker({
        preserveReferenceScroll: options.preserveReferenceScroll,
        skipActiveScroll: options.preserveReferenceScroll,
      });
      return true;
    }
    const firstChildIndex = findPaperPickerFirstAttachmentRowIndex(row.itemId);
    if (firstChildIndex >= 0) {
      if (options.preserveReferenceScroll) {
        togglePaperPickerGroupExpanded(row.itemId, false);
        renderPaperPicker({
          preserveReferenceScroll: true,
          skipActiveScroll: true,
        });
        return true;
      }
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

  const setPaperPickerFolderScope = (scope: PaperPickerFolderScope): void => {
    paperPickerActiveFolderScope = scope;
    paperPickerActiveRowIndex = 0;
    paperPickerExpandedPaperKeys = new Set<number>();
    renderPaperPicker();
  };

  const isPaperPickerFolderActionSelected = (
    scope: PaperPickerFolderScope,
  ): boolean => {
    const item = deps.getItem();
    if (!item || typeof scope !== "number" || scope <= 0) return false;
    return (selectedCollectionContextCache.get(item.id) || []).some(
      (collectionRef) => collectionRef.collectionId === scope,
    );
  };

  const createPaperPickerFolderAction = (
    ownerDoc: Document,
    scope: PaperPickerFolderScope,
    label: string,
  ): HTMLButtonElement | null => {
    if (typeof scope !== "number" || scope <= 0) return null;
    const selected = isPaperPickerFolderActionSelected(scope);
    const action = createElement(
      ownerDoc,
      "button",
      "llm-paper-picker-scope-action",
      {
        textContent: selected ? "✓" : "+",
        title: selected
          ? t("Remove collection context")
          : `${t("Add collection as context")}: ${label}`,
      },
    );
    action.type = "button";
    action.addEventListener("mousedown", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      selectCollectionFromPickerUnified(scope);
    });
    action.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    return action;
  };

  const rerenderPaperPickerFilters = (): void => {
    paperPickerActiveRowIndex = 0;
    paperPickerExpandedPaperKeys = new Set<number>();
    renderPaperPicker();
  };

  const createPaperPickerScopeIcon = (
    ownerDoc: Document,
    extraClassName: string,
  ): HTMLSpanElement =>
    createElement(
      ownerDoc,
      "span",
      `llm-context-svg-icon llm-context-icon-collection ${extraClassName}`,
    );

  const getPaperPickerPanelStackBudget = (): number => {
    const rawMaxHeight =
      paperPicker?.style.getPropertyValue("--llm-paper-picker-max-height") ||
      "";
    const maxHeight = Number.parseFloat(rawMaxHeight);
    const safeMaxHeight =
      Number.isFinite(maxHeight) && maxHeight > 0
        ? maxHeight
        : PAPER_PICKER_MAX_HEIGHT;
    return Math.max(0, safeMaxHeight - PAPER_PICKER_LIST_VERTICAL_PADDING);
  };

  const getPaperPickerPanelBudgetHeight = (
    key: PaperPickerPanelKey,
  ): number => {
    if (paperPickerCollapsedPanels.has(key)) {
      return PAPER_PICKER_PANEL_COLLAPSED_HEIGHT;
    }
    const height =
      paperPickerPanelHeights.get(key) ??
      PAPER_PICKER_PANEL_DEFAULT_HEIGHT[key];
    return Math.max(
      PAPER_PICKER_PANEL_MIN_HEIGHT[key],
      Math.min(PAPER_PICKER_PANEL_MAX_HEIGHT[key], Math.floor(height)),
    );
  };

  const getPaperPickerPanelAvailableMaxHeight = (
    key: PaperPickerPanelKey,
  ): number => {
    const reservedHeight = PAPER_PICKER_PANEL_KEYS.filter(
      (panelKey) => panelKey !== key,
    ).reduce(
      (total, panelKey) =>
        total + getPaperPickerPanelBudgetHeight(panelKey),
      0,
    );
    const availableHeight = getPaperPickerPanelStackBudget() - reservedHeight;
    return Math.max(
      PAPER_PICKER_PANEL_MIN_HEIGHT[key],
      Math.min(PAPER_PICKER_PANEL_MAX_HEIGHT[key], availableHeight),
    );
  };

  const clampPaperPickerPanelHeight = (
    key: PaperPickerPanelKey,
    height: number,
  ): number =>
    Math.max(
      PAPER_PICKER_PANEL_MIN_HEIGHT[key],
      Math.min(getPaperPickerPanelAvailableMaxHeight(key), Math.floor(height)),
    );

  const capturePaperPickerPanelHeights = (): void => {
    if (!paperPickerList || paperPickerMode !== "browse") return;
    const shell = paperPickerList.children[0] as HTMLElement | undefined;
    if (!shell) return;
    const panels: Array<[PaperPickerPanelKey, HTMLElement | undefined]> = [
      ["folders", shell.children[0] as HTMLElement | undefined],
      ["references", shell.children[1] as HTMLElement | undefined],
      ["tags", shell.children[2] as HTMLElement | undefined],
    ];
    for (const [key, panel] of panels) {
      if (!panel) continue;
      if (panel.classList.contains("llm-paper-picker-panel-collapsed"))
        continue;
      const rect =
        typeof panel.getBoundingClientRect === "function"
          ? panel.getBoundingClientRect()
          : null;
      const cssHeight = Number.parseFloat(
        panel.style.getPropertyValue("height") || "",
      );
      const height =
        rect && Number.isFinite(rect.height) && rect.height > 0
          ? rect.height
          : cssHeight;
      if (!Number.isFinite(height) || height <= 0) continue;
      paperPickerPanelHeights.set(
        key,
        clampPaperPickerPanelHeight(key, height),
      );
    }
  };

  const getPaperPickerPanelRenderedHeight = (
    panel: HTMLElement | undefined,
    key: PaperPickerPanelKey,
  ): number => {
    if (!panel) return 0;
    if (panel.classList.contains("llm-paper-picker-panel-collapsed")) {
      return PAPER_PICKER_PANEL_COLLAPSED_HEIGHT;
    }
    const rect =
      typeof panel.getBoundingClientRect === "function"
        ? panel.getBoundingClientRect()
        : null;
    if (rect && Number.isFinite(rect.height) && rect.height > 0) {
      return rect.height;
    }
    const cssHeight = Number.parseFloat(
      panel.style.getPropertyValue("height") || "",
    );
    if (Number.isFinite(cssHeight) && cssHeight > 0) return cssHeight;
    return PAPER_PICKER_PANEL_DEFAULT_HEIGHT[key];
  };

  const capturePaperPickerRenderedPanelHeights =
    (): Map<PaperPickerPanelKey, number> => {
      const heights = new Map<PaperPickerPanelKey, number>();
      if (!paperPickerList || paperPickerMode !== "browse") return heights;
      const shell = paperPickerList.children[0] as HTMLElement | undefined;
      if (!shell) return heights;
      const panels: Array<[PaperPickerPanelKey, HTMLElement | undefined]> = [
        ["folders", shell.children[0] as HTMLElement | undefined],
        ["references", shell.children[1] as HTMLElement | undefined],
        ["tags", shell.children[2] as HTMLElement | undefined],
      ];
      for (const [key, panel] of panels) {
        const height = getPaperPickerPanelRenderedHeight(panel, key);
        if (Number.isFinite(height) && height > 0) heights.set(key, height);
      }
      return heights;
    };

  const applyPaperPickerPanelHeight = (
    panel: HTMLElement,
    key: PaperPickerPanelKey,
  ): void => {
    if (isPaperPickerPanelCollapsed(key)) return;
    const height =
      paperPickerPanelHeights.get(key) ??
      PAPER_PICKER_PANEL_DEFAULT_HEIGHT[key];
    panel.style.height = `${clampPaperPickerPanelHeight(key, height)}px`;
  };

  const beginPaperPickerPanelResize = (
    key: PaperPickerPanelKey,
    panel: HTMLElement,
    event: MouseEvent,
  ): void => {
    const ownerWin = panel.ownerDocument?.defaultView;
    if (!ownerWin || isPaperPickerPanelCollapsed(key)) return;
    const startY = event.clientY;
    const startHeight = getPaperPickerPanelRenderedHeight(panel, key);
    panel.classList.add("llm-paper-picker-panel-resizing");
    const onMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      const nextHeight = clampPaperPickerPanelHeight(
        key,
        startHeight + startY - moveEvent.clientY,
      );
      paperPickerPanelHeights.set(key, nextHeight);
      panel.style.height = `${nextHeight}px`;
    };
    const onUp = () => {
      ownerWin.removeEventListener("mousemove", onMove);
      ownerWin.removeEventListener("mouseup", onUp);
      panel.classList.remove("llm-paper-picker-panel-resizing");
      capturePaperPickerPanelHeights();
    };
    ownerWin.addEventListener("mousemove", onMove);
    ownerWin.addEventListener("mouseup", onUp);
  };

  const createPaperPickerPanelSeparator = (
    ownerDoc: Document,
    key: PaperPickerPanelKey,
    panel: HTMLElement,
  ): HTMLElement => {
    const separator = createElement(
      ownerDoc,
      "div",
      "llm-paper-picker-panel-separator",
      {
        title: t("Resize panel"),
      },
    );
    separator.setAttribute("role", "separator");
    separator.setAttribute("aria-orientation", "horizontal");
    separator.setAttribute("aria-label", t("Resize panel"));
    separator.addEventListener("mousedown", (event: Event) => {
      const mouse = event as MouseEvent;
      if (typeof mouse.button === "number" && mouse.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      beginPaperPickerPanelResize(key, panel, mouse);
    });
    separator.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    return separator;
  };

  const animatePaperPickerPanelHeight = (
    panel: HTMLElement,
    key: PaperPickerPanelKey,
    fromHeight: number | undefined,
  ): void => {
    const ownerWin = panel.ownerDocument?.defaultView;
    if (
      !ownerWin ||
      typeof ownerWin.requestAnimationFrame !== "function" ||
      !fromHeight ||
      !Number.isFinite(fromHeight) ||
      fromHeight <= 0
    ) {
      return;
    }
    const targetHeight = getPaperPickerPanelRenderedHeight(panel, key);
    if (!Number.isFinite(targetHeight) || Math.abs(targetHeight - fromHeight) < 1)
      return;
    const media = ownerWin.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (media?.matches) return;
    const target = `${targetHeight}px`;
    panel.style.transition = "none";
    panel.style.height = `${fromHeight}px`;
    void panel.offsetHeight;
    ownerWin.requestAnimationFrame?.(() => {
      panel.style.removeProperty("transition");
      panel.style.height = target;
    });
  };

  const animatePaperPickerPanelHeights = (
    shell: HTMLElement,
    previousHeights: Map<PaperPickerPanelKey, number>,
  ): void => {
    const panels: Array<[PaperPickerPanelKey, HTMLElement | undefined]> = [
      ["folders", shell.children[0] as HTMLElement | undefined],
      ["references", shell.children[1] as HTMLElement | undefined],
      ["tags", shell.children[2] as HTMLElement | undefined],
    ];
    for (const [key, panel] of panels) {
      if (!panel) continue;
      animatePaperPickerPanelHeight(panel, key, previousHeights.get(key));
    }
  };

  const isPaperPickerPanelCollapsed = (key: PaperPickerPanelKey): boolean =>
    paperPickerCollapsedPanels.has(key);

  const togglePaperPickerPanelCollapsed = (key: PaperPickerPanelKey): void => {
    const next = new Set(paperPickerCollapsedPanels);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    paperPickerCollapsedPanels = next;
    renderPaperPicker();
  };

  const createPaperPickerPanelToggle = (
    ownerDoc: Document,
    key: PaperPickerPanelKey,
  ): HTMLButtonElement => {
    const collapsed = isPaperPickerPanelCollapsed(key);
    const button = createElement(
      ownerDoc,
      "button",
      "llm-paper-picker-panel-toggle",
      {
        textContent: collapsed ? "›" : "▾",
        title: collapsed ? t("Expand panel") : t("Collapse panel"),
      },
    );
    button.type = "button";
    button.setAttribute("aria-expanded", collapsed ? "false" : "true");
    button.addEventListener("mousedown", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      togglePaperPickerPanelCollapsed(key);
    });
    button.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    return button;
  };

  const attachPaperPickerPanelHeaderToggle = (
    header: HTMLElement,
    key: PaperPickerPanelKey,
  ): void => {
    header.addEventListener("mousedown", (event: Event) => {
      const mouse = event as MouseEvent;
      if (typeof mouse.button === "number" && mouse.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      togglePaperPickerPanelCollapsed(key);
    });
    header.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  };

  const renderPaperPickerFolderRow = (
    ownerDoc: Document,
    params: {
      label: string;
      scope: PaperPickerFolderScope;
      depth: number;
      count: number;
      hasChildren?: boolean;
    },
  ): HTMLElement => {
    const row = createElement(
      ownerDoc,
      "div",
      "llm-paper-picker-sidebar-row llm-paper-picker-sidebar-folder-row",
    );
    row.style.setProperty(
      "--llm-paper-picker-sidebar-depth",
      `${params.depth}`,
    );
    row.classList.toggle(
      "llm-paper-picker-sidebar-row-active",
      paperPickerActiveFolderScope === params.scope,
    );

    const chevron = createElement(
      ownerDoc,
      "button",
      "llm-paper-picker-sidebar-chevron",
      {
        textContent: params.hasChildren
          ? isPaperPickerCollectionExpanded(Number(params.scope))
            ? "▾"
            : "›"
          : "",
        title: params.hasChildren ? t("Expand folder") : "",
      },
    );
    chevron.type = "button";
    if (params.hasChildren && typeof params.scope === "number") {
      chevron.addEventListener("mousedown", (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        togglePaperPickerCollectionExpanded(params.scope as number);
        renderPaperPicker();
      });
    }
    row.appendChild(chevron);

    row.appendChild(
      createPaperPickerScopeIcon(
        ownerDoc,
        "llm-paper-picker-sidebar-folder-icon",
      ),
    );
    row.appendChild(
      createElement(ownerDoc, "span", "llm-paper-picker-sidebar-label", {
        textContent: params.label,
        title: params.label,
      }),
    );
    row.appendChild(
      createElement(ownerDoc, "span", "llm-paper-picker-sidebar-count", {
        textContent: String(params.count),
      }),
    );
    const action = createPaperPickerFolderAction(
      ownerDoc,
      params.scope,
      params.label,
    );
    if (action) row.appendChild(action);

    row.addEventListener("mousedown", (event: Event) => {
      const mouse = event as MouseEvent;
      if (typeof mouse.button === "number" && mouse.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      setPaperPickerFolderScope(params.scope);
    });
    return row;
  };

  const renderPaperPickerCollectionTree = (
    ownerDoc: Document,
    parent: HTMLElement,
    collection: PaperBrowseCollectionCandidate,
    depth: number,
  ): void => {
    const folderQuery = paperPickerFolderFilterQuery.trim().toLowerCase();
    const isFilteringFolders = folderQuery.length > 0;
    if (
      isFilteringFolders &&
      !paperPickerCollectionMatchesFilter(collection, folderQuery)
    ) {
      return;
    }
    const hasChildren = collection.childCollections.length > 0;
    const isUnfiled = collection.collectionId === 0;
    parent.appendChild(
      renderPaperPickerFolderRow(ownerDoc, {
        label: isUnfiled ? t("Unfiled Items") : collection.name,
        scope: collection.collectionId,
        depth,
        count: collectPaperPickerCollectionGroups(collection).length,
        hasChildren,
      }),
    );
    if (
      !hasChildren ||
      (!isFilteringFolders &&
        !isPaperPickerCollectionExpanded(collection.collectionId))
    ) {
      return;
    }
    for (const child of collection.childCollections) {
      renderPaperPickerCollectionTree(ownerDoc, parent, child, depth + 1);
    }
  };

  const paperPickerCollectionMatchesFilter = (
    collection: PaperBrowseCollectionCandidate,
    normalizedQuery: string,
  ): boolean => {
    const label =
      collection.collectionId === 0 ? t("Unfiled Items") : collection.name;
    if (label.toLowerCase().includes(normalizedQuery)) return true;
    return collection.childCollections.some((child) =>
      paperPickerCollectionMatchesFilter(child, normalizedQuery),
    );
  };

  const renderPaperPickerFolderPanel = (ownerDoc: Document): HTMLElement => {
    const collapsed = isPaperPickerPanelCollapsed("folders");
    const folderPanel = createElement(
      ownerDoc,
      "div",
      `llm-paper-picker-folder-panel ${
        collapsed ? "llm-paper-picker-panel-collapsed" : ""
      }`,
    );
    applyPaperPickerPanelHeight(folderPanel, "folders");
    const header = createElement(
      ownerDoc,
      "div",
      "llm-paper-picker-folder-header",
    );
    header.append(
      createPaperPickerPanelToggle(ownerDoc, "folders"),
      createElement(ownerDoc, "span", "llm-paper-picker-folder-title", {
        textContent: t("Folders"),
      }),
      createElement(ownerDoc, "span", "llm-paper-picker-folder-count", {
        textContent: String(getPaperPickerAllBrowseGroups().length),
      }),
    );
    attachPaperPickerPanelHeaderToggle(header, "folders");
    if (!collapsed) {
      folderPanel.appendChild(
        createPaperPickerPanelSeparator(ownerDoc, "folders", folderPanel),
      );
    }
    folderPanel.appendChild(header);
    if (collapsed) return folderPanel;

    const folderPane = createElement(
      ownerDoc,
      "div",
      "llm-paper-picker-folder-pane",
    );
    folderPane.appendChild(
      renderPaperPickerFolderRow(ownerDoc, {
        label: t("My Library"),
        scope: "all",
        depth: 0,
        count: getPaperPickerAllBrowseGroups().length,
      }),
    );
    const unfiledCollections: PaperBrowseCollectionCandidate[] = [];
    for (const collection of paperPickerCollections) {
      if (collection.collectionId === 0) {
        unfiledCollections.push(collection);
      } else {
        renderPaperPickerCollectionTree(ownerDoc, folderPane, collection, 0);
      }
    }
    for (const collection of unfiledCollections) {
      renderPaperPickerCollectionTree(ownerDoc, folderPane, collection, 0);
    }
    folderPanel.appendChild(folderPane);

    const filterBar = createElement(
      ownerDoc,
      "div",
      "llm-paper-picker-folder-filter-bar",
    );
    const input = createElement(
      ownerDoc,
      "input",
      "llm-paper-picker-folder-filter",
      {
        value: paperPickerFolderFilterQuery,
        placeholder: t("Filter Folders"),
      },
    ) as HTMLInputElement;
    input.type = "search";
    input.addEventListener("input", () => {
      paperPickerFolderFilterQuery = input.value;
      const selectionStart =
        input.selectionStart ?? paperPickerFolderFilterQuery.length;
      renderPaperPicker();
      if (typeof ownerDoc.querySelector === "function") {
        const nextInput = ownerDoc.querySelector(
          ".llm-paper-picker-folder-filter",
        ) as HTMLInputElement | null;
        nextInput?.focus();
        nextInput?.setSelectionRange(selectionStart, selectionStart);
      }
    });
    filterBar.appendChild(input);
    folderPanel.appendChild(filterBar);
    return folderPanel;
  };

  const getAllTaggedCount = (
    groups: readonly PaperSearchGroupCandidate[],
  ): number =>
    filterPaperPickerGroupsForTagView(groups, {
      tagScope: "allTagged",
      includeAutomatic: paperPickerShowAutomaticTags,
    }).length;

  const getUntaggedCount = (
    groups: readonly PaperSearchGroupCandidate[],
  ): number =>
    filterPaperPickerGroupsForTagView(groups, {
      tagScope: "untagged",
      includeAutomatic: paperPickerShowAutomaticTags,
    }).length;

  const getPaperPickerGroupsForTagScope = (
    scope: MineruTagScope,
  ): PaperSearchGroupCandidate[] =>
    filterPaperPickerGroupsForTagView(getPaperPickerFolderScopedGroups(), {
      tagScope: scope,
      includeAutomatic: paperPickerShowAutomaticTags,
      tagMatchMode: paperPickerTagMatchMode,
    });

  const getPaperPickerGroupsForTag = (
    tagName: string,
  ): PaperSearchGroupCandidate[] =>
    filterPaperPickerGroupsForTagView(getPaperPickerFolderScopedGroups(), {
      selectedTags: [tagName],
      includeAutomatic: paperPickerShowAutomaticTags,
      tagMatchMode: "and",
    });

  const isPaperPickerTagContextSelected = (ref: TagContextRef): boolean => {
    const item = deps.getItem();
    if (!item) return false;
    const key = buildPaperPickerTagContextKey(ref);
    return (selectedTagContextCache.get(item.id) || []).some(
      (entry) => buildPaperPickerTagContextKey(entry) === key,
    );
  };

  const createPaperPickerTagContextAction = (
    ownerDoc: Document,
    ref: TagContextRef,
    sourceLabel: string,
    disabled = false,
  ): HTMLButtonElement => {
    const selected = isPaperPickerTagContextSelected(ref);
    const action = createElement(
      ownerDoc,
      "button",
      "llm-paper-picker-scope-action",
      {
        textContent: selected ? "✓" : "+",
        title: selected
          ? t("Remove tag context")
          : `${t("Add tag as context")}: ${sourceLabel}`,
      },
    );
    action.type = "button";
    action.disabled = disabled;
    action.addEventListener("mousedown", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!disabled) selectTagContextFromPickerUnified(ref);
    });
    action.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    return action;
  };

  const createPaperPickerTagScopeButton = (
    ownerDoc: Document,
    scope: Exclude<MineruTagScope, "all">,
    label: string,
  ): HTMLElement => {
    const wrap = createElement(
      ownerDoc,
      "div",
      "llm-paper-picker-tag-scope-wrap",
    );
    const button = createElement(
      ownerDoc,
      "button",
      "llm-paper-picker-tag-scope",
      { textContent: label },
    );
    button.type = "button";
    button.classList.toggle(
      "llm-paper-picker-tag-scope-active",
      paperPickerTagScope === scope && paperPickerSelectedTags.size === 0,
    );
    button.addEventListener("mousedown", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      paperPickerTagScope =
        paperPickerTagScope === scope && paperPickerSelectedTags.size === 0
          ? "all"
          : scope;
      paperPickerSelectedTags.clear();
      rerenderPaperPickerFilters();
    });
    wrap.append(
      button,
      createPaperPickerTagContextAction(
        ownerDoc,
        {
          name: label,
          libraryID: deps.getCurrentLibraryID(),
          scope,
          includeAutomatic: paperPickerShowAutomaticTags,
        },
        label,
        getPaperPickerGroupsForTagScope(scope).length === 0,
      ),
    );
    return wrap;
  };

  const createPaperPickerTagChip = (
    ownerDoc: Document,
    info: MineruTagInfo,
    selected: boolean,
    available: boolean,
  ): HTMLElement => {
    const normalized = normalizeMineruTagName(info.name);
    const wrap = createElement(
      ownerDoc,
      "div",
      "llm-paper-picker-tag-chip-wrap",
    );
    const chip = createElement(
      ownerDoc,
      "button",
      "llm-paper-picker-tag-chip llm-paper-picker-tag-chip-label",
      {
        textContent: selected || available ? info.name : `(${info.name})`,
        title: `${info.name} (${info.count})`,
      },
    );
    chip.type = "button";
    if (info.color) {
      chip.style.setProperty("--llm-paper-picker-tag-color", info.color);
      chip.classList.add("llm-paper-picker-tag-chip-colored");
    }
    chip.classList.toggle("llm-paper-picker-tag-chip-selected", selected);
    chip.classList.toggle("llm-paper-picker-tag-chip-unavailable", !available);
    chip.disabled = !available;
    chip.addEventListener("mousedown", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!available) return;
      if (!normalized) return;
      paperPickerTagScope = "all";
      if (paperPickerSelectedTags.has(normalized)) {
        paperPickerSelectedTags.delete(normalized);
      } else {
        paperPickerSelectedTags.add(normalized);
      }
      rerenderPaperPickerFilters();
    });
    wrap.append(chip);
    if (normalized) {
      wrap.append(
        createPaperPickerTagContextAction(
          ownerDoc,
          {
            name: info.name,
            normalizedName: normalized,
            libraryID: deps.getCurrentLibraryID(),
            includeAutomatic: paperPickerShowAutomaticTags,
          },
          info.name,
          getPaperPickerGroupsForTag(normalized).length === 0,
        ),
      );
    }
    return wrap;
  };

  const createPaperPickerTagFilterIcon = (
    ownerDoc: Document,
  ): SVGSVGElement => {
    const svg = ownerDoc.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    ) as unknown as SVGSVGElement;
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("aria-hidden", "true");
    const path = ownerDoc.createElementNS(
      "http://www.w3.org/2000/svg",
      "path",
    ) as unknown as SVGPathElement;
    path.setAttribute("d", "M5 6.5h14l-5.4 6.2v4.5l-3.2 2.3v-6.8L5 6.5z");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.65");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-linecap", "round");
    svg.appendChild(path);
    return svg;
  };

  const renderPaperPickerTagPanel = (ownerDoc: Document): HTMLElement => {
    const collapsed = isPaperPickerPanelCollapsed("tags");
    const baseGroups = getPaperPickerFolderScopedGroups();
    const visibleGroups = getPaperPickerVisibleGroups();
    const baseItems = buildPaperPickerTagIndexItems(baseGroups);
    const baseTagIndex = buildMineruTagIndex(baseItems, {
      includeAutomatic: paperPickerShowAutomaticTags,
      getColor: resolvePaperPickerTagColor,
    });
    const allTagInfos = getSortedMineruTagInfos(baseTagIndex);
    const filteredTagInfos = allTagInfos.filter((info) => {
      const query = paperPickerTagFilterQuery.trim().toLowerCase();
      return !query || info.name.toLowerCase().includes(query);
    });
    const availabilityItems =
      paperPickerTagMatchMode === "or" && paperPickerSelectedTags.size > 0
        ? baseItems
        : buildPaperPickerTagIndexItems(visibleGroups);
    const availability = computeMineruTagAvailability(
      allTagInfos,
      availabilityItems,
      paperPickerSelectedTags,
      paperPickerShowAutomaticTags,
    );

    const tagPanel = createElement(
      ownerDoc,
      "div",
      `llm-paper-picker-tag-panel ${
        collapsed ? "llm-paper-picker-panel-collapsed" : ""
      }`,
    );
    applyPaperPickerPanelHeight(tagPanel, "tags");
    const header = createElement(
      ownerDoc,
      "div",
      "llm-paper-picker-tag-header",
    );
    header.append(
      createPaperPickerPanelToggle(ownerDoc, "tags"),
      createElement(ownerDoc, "span", "llm-paper-picker-tag-title", {
        textContent: t("Tags"),
      }),
      createElement(ownerDoc, "span", "llm-paper-picker-tag-count", {
        textContent: String(baseGroups.length),
      }),
    );
    attachPaperPickerPanelHeaderToggle(header, "tags");
    if (!collapsed) {
      tagPanel.appendChild(
        createPaperPickerPanelSeparator(ownerDoc, "tags", tagPanel),
      );
    }
    tagPanel.appendChild(header);
    if (collapsed) return tagPanel;

    const scopes = createElement(
      ownerDoc,
      "div",
      "llm-paper-picker-tag-scopes",
    );
    scopes.append(
      createPaperPickerTagScopeButton(
        ownerDoc,
        "allTagged",
        `${t("All Tagged")} ${getAllTaggedCount(baseGroups)}`,
      ),
      createPaperPickerTagScopeButton(
        ownerDoc,
        "untagged",
        `${t("Untagged")} ${getUntaggedCount(baseGroups)}`,
      ),
    );
    tagPanel.appendChild(scopes);

    const chipCloud = createElement(
      ownerDoc,
      "div",
      "llm-paper-picker-tag-cloud",
    );
    for (const info of filteredTagInfos) {
      const selected = paperPickerSelectedTags.has(info.name);
      const state = availability.get(info.name);
      chipCloud.appendChild(
        createPaperPickerTagChip(
          ownerDoc,
          info,
          selected,
          selected || !!state?.available,
        ),
      );
    }
    if (!filteredTagInfos.length) {
      chipCloud.appendChild(
        createElement(ownerDoc, "div", "llm-paper-picker-tag-empty", {
          textContent: paperPickerTagFilterQuery.trim()
            ? t("No matching tags.")
            : t("No tags found."),
        }),
      );
    }
    tagPanel.appendChild(chipCloud);

    if (
      paperPickerSelectedTags.size > 0 ||
      paperPickerTagScope !== "all" ||
      paperPickerTagFilterQuery.trim()
    ) {
      const summary = createElement(
        ownerDoc,
        "div",
        "llm-paper-picker-tag-summary",
        {
          textContent: `${visibleGroups.length} ${t("papers match")}`,
        },
      );
      tagPanel.appendChild(summary);
    }

    const filterBar = createElement(
      ownerDoc,
      "div",
      "llm-paper-picker-tag-filter-bar",
    );
    const input = createElement(
      ownerDoc,
      "input",
      "llm-paper-picker-tag-filter",
      {
        value: paperPickerTagFilterQuery,
        placeholder: t("Filter Tags"),
      },
    ) as HTMLInputElement;
    input.type = "search";
    input.addEventListener("input", () => {
      paperPickerTagFilterQuery = input.value;
      const selectionStart =
        input.selectionStart ?? paperPickerTagFilterQuery.length;
      renderPaperPicker();
      if (typeof ownerDoc.querySelector === "function") {
        const nextInput = ownerDoc.querySelector(
          ".llm-paper-picker-tag-filter",
        ) as HTMLInputElement | null;
        nextInput?.focus();
        nextInput?.setSelectionRange(selectionStart, selectionStart);
      }
    });
    filterBar.appendChild(input);

    const menuWrap = createElement(
      ownerDoc,
      "div",
      "llm-paper-picker-tag-menu-wrap",
    );
    const menuButton = createElement(
      ownerDoc,
      "button",
      "llm-paper-picker-tag-menu-button",
    );
    menuButton.type = "button";
    menuButton.title = t("Tag filter options");
    menuButton.appendChild(createPaperPickerTagFilterIcon(ownerDoc));
    menuButton.addEventListener("mousedown", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      paperPickerTagFilterMenuOpen = !paperPickerTagFilterMenuOpen;
      renderPaperPicker();
    });
    menuWrap.appendChild(menuButton);
    if (paperPickerTagFilterMenuOpen) {
      const menu = createElement(ownerDoc, "div", "llm-paper-picker-tag-menu");
      const addCheckboxRow = (
        label: string,
        checked: boolean,
        onChange: (checked: boolean) => void,
      ) => {
        const row = createElement(
          ownerDoc,
          "label",
          "llm-paper-picker-tag-menu-row",
        );
        const checkbox = createElement(ownerDoc, "input") as HTMLInputElement;
        checkbox.type = "checkbox";
        checkbox.checked = checked;
        checkbox.addEventListener("change", () => onChange(checkbox.checked));
        row.append(
          checkbox,
          createElement(ownerDoc, "span", "", { textContent: label }),
        );
        menu.appendChild(row);
      };
      addCheckboxRow(
        t("Use OR rule"),
        paperPickerTagMatchMode === "or",
        (checked) => {
          paperPickerTagMatchMode = checked ? "or" : "and";
          paperPickerTagFilterMenuOpen = false;
          rerenderPaperPickerFilters();
        },
      );
      addCheckboxRow(
        t("Show automatic tags"),
        paperPickerShowAutomaticTags,
        (checked) => {
          paperPickerShowAutomaticTags = checked;
          paperPickerTagFilterMenuOpen = false;
          rerenderPaperPickerFilters();
        },
      );
      menuWrap.appendChild(menu);
    }
    filterBar.appendChild(menuWrap);
    tagPanel.appendChild(filterBar);
    return tagPanel;
  };

  const renderPaperPicker = (options: PaperPickerRenderOptions = {}) => {
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
    if (!paperPickerRows.length && paperPickerMode !== "browse") {
      paperPickerMode = "empty";
      paperPickerEmptyMessage = "No items matched.";
      renderPaperPicker();
      return;
    }
    const previousPanelHeights = capturePaperPickerRenderedPanelHeights();
    capturePaperPickerPanelHeights();
    const preservedReferenceScrollTop = options.preserveReferenceScroll
      ? getRenderedPaperPickerReferenceRowHost()?.scrollTop
      : undefined;
    paperPickerList.innerHTML = "";
    const item = deps.getItem();
    const selectedNoteContextItemIds = item
      ? getSelectedNoteContextItemIds()
      : new Set<number>();

    const createItemPanelHeader = (): HTMLElement => {
      const header = createElement(
        ownerDoc,
        "div",
        "llm-paper-picker-item-header",
      );
      header.append(
        createPaperPickerPanelToggle(ownerDoc, "references"),
        createElement(ownerDoc, "span", "llm-paper-picker-item-title", {
          textContent: t("Items"),
        }),
        createElement(ownerDoc, "span", "llm-paper-picker-item-count", {
          textContent: String(getPaperPickerVisibleGroups().length),
        }),
      );
      attachPaperPickerPanelHeaderToggle(header, "references");
      return header;
    };

    const rowHost = createElement(ownerDoc, "div", "llm-paper-picker-row-host");
    const renderedOptions: HTMLElement[] = [];
    const referencesCollapsed =
      paperPickerMode === "browse" && isPaperPickerPanelCollapsed("references");
    const shouldRenderReferenceRows = !referencesCollapsed;
    if (paperPickerMode === "browse") {
      const shell = createElement(ownerDoc, "div", "llm-paper-picker-shell");
      const main = createElement(
        ownerDoc,
        "div",
        `llm-paper-picker-main ${
          referencesCollapsed ? "llm-paper-picker-panel-collapsed" : ""
        }`,
      );
      applyPaperPickerPanelHeight(main, "references");
      shell.append(
        renderPaperPickerFolderPanel(ownerDoc),
        main,
        renderPaperPickerTagPanel(ownerDoc),
      );
      if (!referencesCollapsed) {
        main.append(
          createPaperPickerPanelSeparator(ownerDoc, "references", main),
          createItemPanelHeader(),
          rowHost,
        );
      } else {
        main.append(createItemPanelHeader());
      }
      paperPickerList.appendChild(shell);
      animatePaperPickerPanelHeights(shell, previousPanelHeights);
    } else {
      const main = createElement(
        ownerDoc,
        "div",
        "llm-paper-picker-main llm-paper-picker-main-full",
      );
      main.append(rowHost);
      paperPickerList.appendChild(main);
    }

    const appendActionCell = (
      option: HTMLElement,
      rowIndex: number,
      selected: boolean,
      label: string,
      onAction?: () => boolean,
    ): void => {
      const action = createElement(
        ownerDoc,
        "button",
        "llm-paper-picker-scope-action llm-paper-picker-row-action llm-paper-picker-cell-action",
        {
          textContent: selected ? "✓" : "+",
          title: label,
        },
      );
      action.type = "button";
      action.addEventListener("mousedown", (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        paperPickerActiveRowIndex = rowIndex;
        if (onAction) onAction();
        else selectPaperPickerRowAt(rowIndex);
      });
      action.addEventListener("click", (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      option.appendChild(action);
    };

    const createPaperPickerMetaLine = (
      firstCreator?: string,
      year?: string,
    ): HTMLElement => {
      const parts = [firstCreator, year]
        .map((part) => (part || "").trim())
        .filter(Boolean);
      return createElement(ownerDoc, "div", "llm-paper-picker-row-meta-line", {
        textContent: parts.join(", "),
        title: parts.join(", "),
      });
    };

    if (shouldRenderReferenceRows && !paperPickerRows.length) {
      rowHost.appendChild(
        createElement(ownerDoc, "div", "llm-paper-picker-empty", {
          textContent:
            paperPickerFolderFilterQuery.trim() ||
            paperPickerTagScope !== "all" ||
            paperPickerSelectedTags.size > 0
              ? "No items matched."
              : "No items available.",
        }),
      );
    }

    if (shouldRenderReferenceRows) {
      paperPickerRows.forEach((row, rowIndex) => {
        const option = createElement(
          ownerDoc,
          "div",
          `llm-paper-picker-item llm-paper-picker-table-row ${
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
        option.style.setProperty(
          "--llm-paper-picker-depth-indent",
          `${9 + row.depth * 14}px`,
        );
        option.style.paddingLeft =
          "calc(var(--llm-paper-picker-depth-indent) + var(--llm-paper-picker-selection-gutter, 0px))";

        let rowSelected = false;

        if (item && (row.kind === "paper" || row.kind === "attachment")) {
          const group = getPaperPickerGroupByItemId(row.itemId);
          if (group) {
            const attachments =
              row.kind === "attachment"
                ? [group.attachments[row.attachmentIndex]].filter(Boolean)
                : group.attachments;
            rowSelected = attachments.some((attachment) =>
              isPaperPickerAttachmentSelected(
                group,
                attachment,
                selectedNoteContextItemIds,
              ),
            );
            option.classList.toggle("llm-paper-picker-selected", rowSelected);
          }
        }

        if (row.kind === "collection") {
          const collection = getPaperPickerCollectionById(row.collectionId);
          if (!collection) return;
          let isCollectionSelected = false;
          if (item) {
            const selectedCollections =
              selectedCollectionContextCache.get(item.id) || [];
            isCollectionSelected = selectedCollections.some(
              (collectionRef) =>
                collectionRef.collectionId === row.collectionId,
            );
            option.classList.toggle(
              "llm-paper-picker-selected",
              isCollectionSelected,
            );
          }
          const rowMain = createElement(
            ownerDoc,
            "div",
            "llm-paper-picker-group-row-main llm-paper-picker-cell-title",
          );
          const titleLine = createElement(
            ownerDoc,
            "div",
            "llm-paper-picker-group-title-line",
          );
          const title = createElement(
            ownerDoc,
            "span",
            "llm-paper-picker-title",
            { textContent: collection.name, title: collection.name },
          );
          titleLine.append(createPickerIcon(ownerDoc, "collection"), title);
          rowMain.append(titleLine, createPaperPickerMetaLine(t("Folder"), ""));
          option.append(rowMain);
          appendActionCell(
            option,
            rowIndex,
            isCollectionSelected,
            isCollectionSelected
              ? t("Remove collection context")
              : t("Add collection as context"),
          );
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
            "llm-paper-picker-group-row-main llm-paper-picker-cell-title",
          );
          const titleLine = createElement(
            ownerDoc,
            "div",
            "llm-paper-picker-group-title-line",
          );
          titleLine.append(
            createPickerIcon(ownerDoc, resolveGroupIcon(group)),
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
          rowMain.append(
            titleLine,
            createPaperPickerMetaLine(group.firstCreator, group.year),
          );
          option.append(rowMain);
          appendActionCell(
            option,
            rowIndex,
            rowSelected,
            rowSelected
              ? t("Remove reference context")
              : t("Add reference context"),
            () => {
              const noJumpOptions: PaperPickerRenderOptions = {
                preserveReferenceScroll: true,
                skipActiveScroll: true,
              };
              if (rowSelected) {
                return removePaperPickerGroupContexts(group, noJumpOptions);
              }
              const defaultAttachmentIndex =
                getDefaultPaperPickerAttachmentIndex(group);
              if (defaultAttachmentIndex < 0) return false;
              return selectPaperPickerAttachment(
                row.itemId,
                defaultAttachmentIndex,
                "paper-single",
                noJumpOptions,
              );
            },
          );
        } else {
          const group = getPaperPickerGroupByItemId(row.itemId);
          if (!group) return;
          const attachment = group.attachments[row.attachmentIndex];
          if (!attachment) return;
          const attachmentKind = resolvePickerAttachmentKind(attachment);
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
              textContent: [
                `${resolvePickerKindLabel(attachmentKind)} attachment`,
                group.firstCreator,
                group.year,
              ]
                .map((part) => (part || "").trim())
                .filter(Boolean)
                .join(", "),
            }),
          );
          const attachmentMain = createElement(
            ownerDoc,
            "div",
            "llm-paper-picker-attachment-main llm-paper-picker-cell-title",
          );
          attachmentMain.append(
            createPickerIcon(ownerDoc, resolvePickerKindIcon(attachmentKind)),
            attachmentText,
          );
          option.append(attachmentMain);
          appendActionCell(
            option,
            rowIndex,
            rowSelected,
            rowSelected
              ? t("Remove reference context")
              : t("Add reference context"),
            () =>
              selectPaperPickerAttachment(
                row.itemId,
                row.attachmentIndex,
                "attachment",
                {
                  preserveReferenceScroll: true,
                  skipActiveScroll: true,
                },
              ),
          );
        }

        option.addEventListener("mousedown", (event: Event) => {
          const mouse = event as MouseEvent;
          if (typeof mouse.button === "number" && mouse.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          paperPickerActiveRowIndex = rowIndex;
          const group =
            row.kind === "paper"
              ? getPaperPickerGroupByItemId(row.itemId)
              : null;
          selectPaperPickerRowAt(rowIndex, {
            preserveReferenceScroll:
              row.kind === "attachment" ||
              (!!group && group.attachments.length > 0),
          });
        });
        option.addEventListener("click", (event: Event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        rowHost.appendChild(option);
        renderedOptions.push(option);
      });
    }
    showPaperPicker();
    if (
      options.preserveReferenceScroll &&
      typeof preservedReferenceScrollTop === "number"
    ) {
      rowHost.scrollTop = preservedReferenceScrollTop;
    }
    if (options.skipActiveScroll) return;
    const activeOption = renderedOptions[paperPickerActiveRowIndex] || null;
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
