import { createElement } from "../../../../utils/domHelpers";
import { t } from "../../../../utils/i18n";
import {
  addZoteroItemsAsContext,
  isTagContextSelected,
  removeReferenceAttachmentContext,
  removeReferenceGroupContexts,
  toggleCollectionContext,
  toggleTagContext,
  upsertReferenceAttachmentContext,
  type ContextSelectionActionResult,
  type ContextSelectionStatusLevel,
} from "../../contextSelectionActions";
import {
  selectedCollectionContextCache,
  selectedOtherRefContextCache,
  selectedTagContextCache,
} from "../../state";
import { getSelectedTextContextEntries } from "../../contextResolution";
import { resolveContextAttachmentSupportFromMetadata } from "../../contextAttachmentSupport";
import {
  browseAllItemCandidates,
  normalizePaperSearchText,
  parseAtSearchToken,
  searchAllItemCandidates,
  searchCollectionCandidates,
  searchTagCandidates,
  ZOTERO_NOTE_CONTENT_TYPE,
  type PaperBrowseCollectionCandidate,
  type PaperSearchAttachmentCandidate,
  type PaperSearchGroupCandidate,
  type PaperSearchSlashToken,
  type PaperSearchTagCandidate,
} from "../../paperSearch";
import {
  normalizeMineruTagName,
  type MineruTagInfo,
  type MineruTagMatchMode,
  type MineruTagScope,
} from "../../../mineruTagIndex";
import type {
  PaperContextRef,
  TagContextRef,
} from "../../types";
import {
  buildReferenceSelectorTagIndexItems,
  buildReferenceSelectorTagViewModel,
  buildReferenceSelectorViewModel,
  collectReferenceSelectorCollectionGroups,
  createReferenceSelectorState,
  filterReferenceSelectorGroupsForTagView,
  findReferenceSelectorFirstAttachmentRowIndex,
  findReferenceSelectorFirstChildRowIndex,
  findReferenceSelectorPaperRowIndex,
  findReferenceSelectorParentRowIndex,
  getReferenceSelectorRowAt,
  isReferenceSelectorCollectionExpanded,
  isReferenceSelectorDirectSelection,
  isReferenceSelectorGroupExpanded,
  isReferenceSelectorSelected,
  referenceSelectorCollectionMatchesFilter,
  resetReferenceSelectorReferenceFilters,
  resolveReferenceSelectorAttachmentSelectionState,
  setReferenceSelectorCollections,
  setReferenceSelectorFolderScope,
  setReferenceSelectorSearchResults,
  toggleReferenceSelectorCollectionExpanded,
  toggleReferenceSelectorGroupExpanded,
  type ReferenceSelectionState,
  type ReferenceSelectorFolderScope,
  type ReferenceSelectorRow,
  type ReferenceSelectorTagIndexItem,
  type ReferenceSelectorViewModel,
} from "../../referenceSelector/model";
import {
  createReferenceSelectorPanelLayout,
  REFERENCE_SELECTOR_ANCHOR_GAP,
  REFERENCE_SELECTOR_MAX_HEIGHT,
  REFERENCE_SELECTOR_MIN_USEFUL_HEIGHT,
  REFERENCE_SELECTOR_VIEWPORT_FRACTION,
  REFERENCE_SELECTOR_VIEWPORT_MARGIN,
  type ReferenceSelectorPanelKey,
} from "../../referenceSelector/panelLayout";

type StatusLevel = ContextSelectionStatusLevel;
type ActiveSlashToken = PaperSearchSlashToken;
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
  | "collection"
  | "tag";
type PaperPickerFolderScope = ReferenceSelectorFolderScope;
type PaperPickerPanelKey = ReferenceSelectorPanelKey;
export type PaperPickerTagIndexItem = ReferenceSelectorTagIndexItem;
type PaperPickerRow = ReferenceSelectorRow;

export function buildPaperPickerTagIndexItems(
  groups: readonly PaperSearchGroupCandidate[],
): PaperPickerTagIndexItem[] {
  return buildReferenceSelectorTagIndexItems(groups);
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
  return filterReferenceSelectorGroupsForTagView(groups, options);
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
    REFERENCE_SELECTOR_MIN_USEFUL_HEIGHT,
    Math.floor(
      Math.min(
        REFERENCE_SELECTOR_MAX_HEIGHT,
        (viewportHeight ||
          REFERENCE_SELECTOR_MAX_HEIGHT / REFERENCE_SELECTOR_VIEWPORT_FRACTION) *
          REFERENCE_SELECTOR_VIEWPORT_FRACTION,
      ),
    ),
  );
  const spaceAbove = Math.max(
    0,
    anchorRect.top -
      viewportTop -
      REFERENCE_SELECTOR_VIEWPORT_MARGIN -
      REFERENCE_SELECTOR_ANCHOR_GAP,
  );
  const spaceBelow = Math.max(
    0,
    viewportBottom -
      anchorRect.bottom -
      REFERENCE_SELECTOR_VIEWPORT_MARGIN -
      REFERENCE_SELECTOR_ANCHOR_GAP,
  );
  const placeBelow =
    spaceAbove < REFERENCE_SELECTOR_MIN_USEFUL_HEIGHT &&
    spaceBelow > spaceAbove;
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
  let referenceSelectorState = createReferenceSelectorState();
  let paperPickerRequestSeq = 0;
  let paperPickerDebounceTimer: number | null = null;
  const panelLayout = createReferenceSelectorPanelLayout({
    paperPicker,
    paperPickerList,
    getMode: () => referenceSelectorState.mode,
    render: () => renderPaperPicker(),
  });

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
    referenceSelectorState = createReferenceSelectorState();
    panelLayout.reset();
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
    referenceSelectorState.groupByItemId.get(itemId) || null;

  const getPaperPickerCollectionById = (collectionId: number) =>
    referenceSelectorState.collectionById.get(collectionId) || null;

  const getPaperPickerTagCandidateByName = (tagName: string) =>
    referenceSelectorState.tagCandidateByName.get(tagName) || null;

  const collectPaperPickerCollectionGroups = (
    collection: PaperBrowseCollectionCandidate,
  ): PaperSearchGroupCandidate[] =>
    collectReferenceSelectorCollectionGroups(collection);

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
    return isReferenceSelectorGroupExpanded(referenceSelectorState, itemId);
  };

  const isPaperPickerCollectionExpanded = (collectionId: number): boolean =>
    isReferenceSelectorCollectionExpanded(referenceSelectorState, collectionId);

  const togglePaperPickerGroupExpanded = (
    itemId: number,
    expanded?: boolean,
  ): boolean => {
    return toggleReferenceSelectorGroupExpanded(
      referenceSelectorState,
      itemId,
      expanded,
    );
  };

  const togglePaperPickerCollectionExpanded = (
    collectionId: number,
    expanded?: boolean,
  ): boolean => {
    return toggleReferenceSelectorCollectionExpanded(
      referenceSelectorState,
      collectionId,
      expanded,
    );
  };

  const setPaperPickerSearchResults = (
    groups: PaperSearchGroupCandidate[],
    collections: PaperBrowseCollectionCandidate[],
    tags: PaperSearchTagCandidate[] = [],
  ): void => {
    setReferenceSelectorSearchResults(
      referenceSelectorState,
      groups,
      collections,
      tags,
    );
  };

  const setPaperPickerCollections = (
    collections: PaperBrowseCollectionCandidate[],
  ): void => {
    setReferenceSelectorCollections(referenceSelectorState, collections);
  };

  const getPaperPickerRowAt = (index: number): PaperPickerRow | null =>
    getReferenceSelectorRowAt(referenceSelectorState, index);

  const findPaperPickerPaperRowIndex = (itemId: number): number =>
    findReferenceSelectorPaperRowIndex(referenceSelectorState.rows, itemId);

  const findPaperPickerFirstAttachmentRowIndex = (itemId: number): number =>
    findReferenceSelectorFirstAttachmentRowIndex(
      referenceSelectorState.rows,
      itemId,
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
    return findReferenceSelectorParentRowIndex(referenceSelectorState.rows, index);
  };

  const findPaperPickerFirstChildRowIndex = (index: number): number => {
    return findReferenceSelectorFirstChildRowIndex(
      referenceSelectorState.rows,
      index,
    );
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

  const getContextSelectionActionDeps = () => ({
    item: deps.getItem(),
    resolveAutoLoadedPaperContext: deps.resolveAutoLoadedPaperContext,
    getManualPaperContextsForItem: deps.getManualPaperContextsForItem,
    isPaperContextMineru: deps.isPaperContextMineru,
    getTextContextConversationKey: deps.getTextContextConversationKey,
    updatePaperPreviewPreservingScroll: deps.updatePaperPreviewPreservingScroll,
    updateSelectedTextPreviewPreservingScroll:
      deps.updateSelectedTextPreviewPreservingScroll,
  });

  const applyContextSelectionResult = (
    result: ContextSelectionActionResult,
  ): boolean => {
    if (result.statusMessage && result.statusLevel) {
      setStatus(result.statusMessage, result.statusLevel);
    }
    return result.changed;
  };

  const getPaperPickerAttachmentSelectionState = (
    group: PaperSearchGroupCandidate,
    attachment: PaperSearchAttachmentCandidate,
    selectedNoteContextItemIds = getSelectedNoteContextItemIds(),
  ): ReferenceSelectionState => {
    const item = deps.getItem();
    if (!item) return "none";
    const autoLoadedPaperContext = deps.resolveAutoLoadedPaperContext();
    return resolveReferenceSelectorAttachmentSelectionState({
      state: referenceSelectorState,
      group,
      attachment,
      selectedCollections: selectedCollectionContextCache.get(item.id) || [],
      selectedTags: selectedTagContextCache.get(item.id) || [],
      autoLoadedPaperContext,
      selectedPapers: deps.getManualPaperContextsForItem(
        item.id,
        autoLoadedPaperContext,
      ),
      selectedOtherRefs: selectedOtherRefContextCache.get(item.id) || [],
      selectedNoteContextItemIds,
    });
  };

  const getPaperPickerAttachmentSelectionTitle = (
    state: ReferenceSelectionState,
  ): string => {
    if (state === "coveredByCollection") {
      return t("Included by selected collection context");
    }
    if (state === "coveredByTag") {
      return t("Included by selected tag context");
    }
    return state === "none"
      ? t("Add reference context")
      : t("Remove reference context");
  };

  const getPaperPickerAttachmentSelectionStateForRow = (
    group: PaperSearchGroupCandidate,
    attachments: PaperSearchAttachmentCandidate[],
    selectedNoteContextItemIds: Set<number>,
  ): ReferenceSelectionState => {
    for (const attachment of attachments) {
      const state = getPaperPickerAttachmentSelectionState(
        group,
        attachment,
        selectedNoteContextItemIds,
      );
      if (state !== "none") return state;
    }
    return "none";
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

  const addZoteroItemsAsPaperContext = (zoteroItems: Zotero.Item[]): void => {
    applyContextSelectionResult(
      addZoteroItemsAsContext(
        getContextSelectionActionDeps(),
        zoteroItems,
      ),
    );
  };

  const upsertPaperPickerAttachmentContext = (
    selectedGroup: PaperSearchGroupCandidate,
    selectedAttachment: PaperSearchAttachmentCandidate,
  ): boolean => {
    return applyContextSelectionResult(
      upsertReferenceAttachmentContext({
        deps: getContextSelectionActionDeps(),
        selectedGroup,
        selectedAttachment,
        kind: resolvePickerAttachmentKind(selectedAttachment),
      }),
    );
  };

  const removePaperPickerAttachmentContext = (
    selectedGroup: PaperSearchGroupCandidate,
    selectedAttachment: PaperSearchAttachmentCandidate,
    options: { silent?: boolean } = {},
  ): boolean => {
    return applyContextSelectionResult(
      removeReferenceAttachmentContext({
        deps: getContextSelectionActionDeps(),
        selectedGroup,
        selectedAttachment,
        kind: resolvePickerAttachmentKind(selectedAttachment),
        silent: options.silent,
      }),
    );
  };

  const removePaperPickerGroupContexts = (
    group: PaperSearchGroupCandidate,
    options: PaperPickerRenderOptions = {},
  ): boolean => {
    const removed = applyContextSelectionResult(
      removeReferenceGroupContexts({
        deps: getContextSelectionActionDeps(),
        group,
      }),
    );
    if (removed) {
      refreshPaperPickerAfterContextSelection(options);
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
    const selectionState = getPaperPickerAttachmentSelectionState(
      selectedGroup,
      selectedAttachment,
    );
    if (isReferenceSelectorDirectSelection(selectionState)) {
      removePaperPickerAttachmentContext(selectedGroup, selectedAttachment);
    } else if (isReferenceSelectorSelected(selectionState)) {
      setStatus(getPaperPickerAttachmentSelectionTitle(selectionState), "warning");
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
    const changed = applyContextSelectionResult(
      toggleCollectionContext({
        deps: getContextSelectionActionDeps(),
        ref: {
          collectionId: collection.collectionId,
          name: collection.name,
          libraryID: deps.getCurrentLibraryID(),
        },
      }),
    );
    if (changed) {
      refreshPaperPickerAfterContextSelection();
    }
    return changed;
  };

  const selectTagContextFromPickerUnified = (ref: TagContextRef): boolean => {
    if (!deps.getItem()) return false;
    const changed = applyContextSelectionResult(
      toggleTagContext({
        deps: getContextSelectionActionDeps(),
        ref,
        libraryID: deps.getCurrentLibraryID(),
      }),
    );
    if (changed) {
      refreshPaperPickerAfterContextSelection();
    }
    return changed;
  };

  const selectPaperPickerRowAt = (
    index: number,
    options: { preserveReferenceScroll?: boolean } = {},
  ): boolean => {
    const row = getPaperPickerRowAt(index);
    if (!row) return false;
    if (row.kind === "collection") {
      if (referenceSelectorState.mode === "search") {
        return selectCollectionFromPickerUnified(row.collectionId);
      }
      togglePaperPickerCollectionExpanded(row.collectionId);
      renderPaperPicker();
      return true;
    }
    if (row.kind === "tag") {
      const tag = getPaperPickerTagCandidateByName(row.tagName);
      if (!tag) return false;
      return selectTagContextFromPickerUnified({
        name: tag.name,
        normalizedName: tag.normalizedName,
        libraryID: deps.getCurrentLibraryID(),
        includeAutomatic: tag.includeAutomatic,
      });
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
      referenceSelectorState.activeRowIndex = firstChildIndex;
      renderPaperPicker();
      return true;
    }
    return false;
  };

  const handleArrowRight = () => {
    const activeRow = getPaperPickerRowAt(referenceSelectorState.activeRowIndex);
    if (!activeRow) return;
    if (activeRow.kind === "collection") {
      if (!isPaperPickerCollectionExpanded(activeRow.collectionId)) {
        togglePaperPickerCollectionExpanded(activeRow.collectionId, true);
        renderPaperPicker();
        return;
      }
      const firstChildIndex = findPaperPickerFirstChildRowIndex(
        referenceSelectorState.activeRowIndex,
      );
      if (firstChildIndex >= 0) {
        referenceSelectorState.activeRowIndex = firstChildIndex;
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
    if (firstChildIndex >= 0 && firstChildIndex !== referenceSelectorState.activeRowIndex) {
      referenceSelectorState.activeRowIndex = firstChildIndex;
      renderPaperPicker();
    }
  };

  const handleArrowLeft = () => {
    const activeRow = getPaperPickerRowAt(referenceSelectorState.activeRowIndex);
    if (!activeRow) return;
    if (activeRow.kind === "collection") {
      if (isPaperPickerCollectionExpanded(activeRow.collectionId)) {
        togglePaperPickerCollectionExpanded(activeRow.collectionId, false);
        renderPaperPicker();
        return;
      }
      const parentIndex = findPaperPickerParentRowIndex(
        referenceSelectorState.activeRowIndex,
      );
      if (parentIndex >= 0) {
        referenceSelectorState.activeRowIndex = parentIndex;
        renderPaperPicker();
      }
      return;
    }
    if (activeRow.kind === "attachment") {
      const parentIndex = findPaperPickerPaperRowIndex(activeRow.itemId);
      if (parentIndex >= 0 && parentIndex !== referenceSelectorState.activeRowIndex) {
        referenceSelectorState.activeRowIndex = parentIndex;
        renderPaperPicker();
      }
      return;
    }
    if (activeRow.kind === "tag") return;
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
      referenceSelectorState.activeRowIndex,
    );
    if (parentIndex >= 0) {
      referenceSelectorState.activeRowIndex = parentIndex;
      renderPaperPicker();
    }
  };

  const setPaperPickerFolderScope = (scope: PaperPickerFolderScope): void => {
    setReferenceSelectorFolderScope(referenceSelectorState, scope);
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
    resetReferenceSelectorReferenceFilters(referenceSelectorState);
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

  const createPaperPickerPanelSeparator = (
    ownerDoc: Document,
    key: PaperPickerPanelKey,
    panel: HTMLElement,
  ): HTMLElement =>
    panelLayout.createPanelSeparator(ownerDoc, key, panel);

  const isPaperPickerPanelCollapsed = (key: PaperPickerPanelKey): boolean =>
    panelLayout.isCollapsed(key);

  const createPaperPickerPanelToggle = (
    ownerDoc: Document,
    key: PaperPickerPanelKey,
  ): HTMLButtonElement => panelLayout.createPanelToggle(ownerDoc, key);

  const attachPaperPickerPanelHeaderToggle = (
    header: HTMLElement,
    key: PaperPickerPanelKey,
  ): void => panelLayout.attachPanelHeaderToggle(header, key);

  const capturePaperPickerPanelHeights = (): void =>
    panelLayout.capturePanelHeights();

  const capturePaperPickerRenderedPanelHeights =
    (): Map<PaperPickerPanelKey, number> =>
      panelLayout.captureRenderedPanelHeights();

  const applyPaperPickerPanelHeight = (
    panel: HTMLElement,
    key: PaperPickerPanelKey,
  ): void => panelLayout.applyPanelHeight(panel, key);

  const animatePaperPickerPanelHeights = (
    shell: HTMLElement,
    previousHeights: Map<PaperPickerPanelKey, number>,
  ): void => panelLayout.animatePanelHeights(shell, previousHeights);

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
      referenceSelectorState.activeFolderScope === params.scope,
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
    const folderQuery = referenceSelectorState.folderFilterQuery.trim().toLowerCase();
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

  const renderPaperPickerFolderPanel = (
    ownerDoc: Document,
    allBrowseGroups: readonly PaperSearchGroupCandidate[],
  ): HTMLElement => {
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
        textContent: String(allBrowseGroups.length),
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
        count: allBrowseGroups.length,
      }),
    );
    const unfiledCollections: PaperBrowseCollectionCandidate[] = [];
    for (const collection of referenceSelectorState.collections) {
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
        value: referenceSelectorState.folderFilterQuery,
        placeholder: t("Filter Folders"),
      },
    ) as HTMLInputElement;
    input.type = "search";
    input.addEventListener("input", () => {
      referenceSelectorState.folderFilterQuery = input.value;
      const selectionStart =
        input.selectionStart ?? referenceSelectorState.folderFilterQuery.length;
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

  const getPaperPickerGroupsForTagScope = (
    scope: MineruTagScope,
    baseGroups: readonly PaperSearchGroupCandidate[],
  ): PaperSearchGroupCandidate[] =>
    filterPaperPickerGroupsForTagView(baseGroups, {
      tagScope: scope,
      includeAutomatic: referenceSelectorState.showAutomaticTags,
      tagMatchMode: referenceSelectorState.tagMatchMode,
    });

  const getPaperPickerGroupsForTag = (
    tagName: string,
    baseGroups: readonly PaperSearchGroupCandidate[],
  ): PaperSearchGroupCandidate[] =>
    filterPaperPickerGroupsForTagView(baseGroups, {
      selectedTags: [tagName],
      includeAutomatic: referenceSelectorState.showAutomaticTags,
      tagMatchMode: "and",
    });

  const isPaperPickerTagContextSelected = (ref: TagContextRef): boolean => {
    const item = deps.getItem();
    if (!item) return false;
    return isTagContextSelected({ itemId: item.id, ref });
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
    baseGroups: readonly PaperSearchGroupCandidate[],
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
      referenceSelectorState.tagScope === scope && referenceSelectorState.selectedTags.size === 0,
    );
    button.addEventListener("mousedown", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      referenceSelectorState.tagScope =
        referenceSelectorState.tagScope === scope && referenceSelectorState.selectedTags.size === 0
          ? "all"
          : scope;
      referenceSelectorState.selectedTags.clear();
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
          includeAutomatic: referenceSelectorState.showAutomaticTags,
        },
        label,
        getPaperPickerGroupsForTagScope(scope, baseGroups).length === 0,
      ),
    );
    return wrap;
  };

  const createPaperPickerTagChip = (
    ownerDoc: Document,
    info: MineruTagInfo,
    selected: boolean,
    available: boolean,
    baseGroups: readonly PaperSearchGroupCandidate[],
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
      referenceSelectorState.tagScope = "all";
      if (referenceSelectorState.selectedTags.has(normalized)) {
        referenceSelectorState.selectedTags.delete(normalized);
      } else {
        referenceSelectorState.selectedTags.add(normalized);
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
            includeAutomatic: referenceSelectorState.showAutomaticTags,
          },
          info.name,
          getPaperPickerGroupsForTag(normalized, baseGroups).length === 0,
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

  const renderPaperPickerTagPanel = (
    ownerDoc: Document,
    baseGroups: readonly PaperSearchGroupCandidate[],
    visibleGroups: readonly PaperSearchGroupCandidate[],
  ): HTMLElement => {
    const collapsed = isPaperPickerPanelCollapsed("tags");
    const tagViewModel = buildReferenceSelectorTagViewModel(
      referenceSelectorState,
      baseGroups,
      visibleGroups,
      resolvePaperPickerTagColor,
    );
    const { filteredTagInfos, availability } = tagViewModel;

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
        `${t("All Tagged")} ${tagViewModel.allTaggedCount}`,
        baseGroups,
      ),
      createPaperPickerTagScopeButton(
        ownerDoc,
        "untagged",
        `${t("Untagged")} ${tagViewModel.untaggedCount}`,
        baseGroups,
      ),
    );
    tagPanel.appendChild(scopes);

    const chipCloud = createElement(
      ownerDoc,
      "div",
      "llm-paper-picker-tag-cloud",
    );
    for (const info of filteredTagInfos) {
      const selected = referenceSelectorState.selectedTags.has(info.name);
      const state = availability.get(info.name);
      chipCloud.appendChild(
        createPaperPickerTagChip(
          ownerDoc,
          info,
          selected,
          selected || !!state?.available,
          baseGroups,
        ),
      );
    }
    if (!filteredTagInfos.length) {
      chipCloud.appendChild(
        createElement(ownerDoc, "div", "llm-paper-picker-tag-empty", {
          textContent: referenceSelectorState.tagFilterQuery.trim()
            ? t("No matching tags.")
            : t("No tags found."),
        }),
      );
    }
    tagPanel.appendChild(chipCloud);

    if (
      referenceSelectorState.selectedTags.size > 0 ||
      referenceSelectorState.tagScope !== "all" ||
      referenceSelectorState.tagFilterQuery.trim()
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
        value: referenceSelectorState.tagFilterQuery,
        placeholder: t("Filter Tags"),
      },
    ) as HTMLInputElement;
    input.type = "search";
    input.addEventListener("input", () => {
      referenceSelectorState.tagFilterQuery = input.value;
      const selectionStart =
        input.selectionStart ?? referenceSelectorState.tagFilterQuery.length;
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
      referenceSelectorState.tagFilterMenuOpen = !referenceSelectorState.tagFilterMenuOpen;
      renderPaperPicker();
    });
    menuWrap.appendChild(menuButton);
    if (referenceSelectorState.tagFilterMenuOpen) {
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
        referenceSelectorState.tagMatchMode === "or",
        (checked) => {
          referenceSelectorState.tagMatchMode = checked ? "or" : "and";
          referenceSelectorState.tagFilterMenuOpen = false;
          rerenderPaperPickerFilters();
        },
      );
      addCheckboxRow(
        t("Show automatic tags"),
        referenceSelectorState.showAutomaticTags,
        (checked) => {
          referenceSelectorState.showAutomaticTags = checked;
          referenceSelectorState.tagFilterMenuOpen = false;
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
    // Prime placement before panel heights are calculated. On first standalone
    // open the picker has no measured max height yet, so rendering before
    // positioning can leave the panel stack using stale/default geometry.
    showPaperPicker();
    if (referenceSelectorState.mode === "empty") {
      paperPickerList.innerHTML = "";
      paperPicker.scrollTop = 0;
      paperPickerList.appendChild(
        createElement(ownerDoc, "div", "llm-paper-picker-empty", {
          textContent: referenceSelectorState.emptyMessage,
        }),
      );
      showPaperPicker();
      return;
    }
    const viewModel: ReferenceSelectorViewModel =
      buildReferenceSelectorViewModel(referenceSelectorState);
    if (!viewModel.rows.length && referenceSelectorState.mode !== "browse") {
      referenceSelectorState.mode = "empty";
      referenceSelectorState.emptyMessage = "No items matched.";
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
          textContent: String(viewModel.visibleGroups.length),
        }),
      );
      attachPaperPickerPanelHeaderToggle(header, "references");
      return header;
    };

    const rowHost = createElement(ownerDoc, "div", "llm-paper-picker-row-host");
    const renderedOptions: HTMLElement[] = [];
    const referencesCollapsed =
      referenceSelectorState.mode === "browse" && isPaperPickerPanelCollapsed("references");
    const shouldRenderReferenceRows = !referencesCollapsed;
    if (referenceSelectorState.mode === "browse") {
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
        renderPaperPickerFolderPanel(ownerDoc, viewModel.allBrowseGroups),
        main,
        renderPaperPickerTagPanel(
          ownerDoc,
          viewModel.folderScopedGroups,
          viewModel.visibleGroups,
        ),
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
        referenceSelectorState.activeRowIndex = rowIndex;
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

    if (shouldRenderReferenceRows && !referenceSelectorState.rows.length) {
      rowHost.appendChild(
        createElement(ownerDoc, "div", "llm-paper-picker-empty", {
          textContent:
            referenceSelectorState.folderFilterQuery.trim() ||
            referenceSelectorState.tagScope !== "all" ||
            referenceSelectorState.selectedTags.size > 0
              ? "No items matched."
              : "No items available.",
        }),
      );
    }

    if (shouldRenderReferenceRows) {
      referenceSelectorState.rows.forEach((row, rowIndex) => {
        const option = createElement(
          ownerDoc,
          "div",
          `llm-paper-picker-item llm-paper-picker-table-row ${
            row.kind === "attachment"
              ? "llm-paper-picker-attachment-row"
              : row.kind === "paper"
                ? "llm-paper-picker-group-row"
                : row.kind === "collection"
                  ? "llm-paper-picker-group-row llm-paper-picker-collection-row"
                  : "llm-paper-picker-group-row llm-paper-picker-tag-row"
          }`,
        );
        option.setAttribute("role", "option");
        option.setAttribute(
          "aria-selected",
          rowIndex === referenceSelectorState.activeRowIndex ? "true" : "false",
        );
        option.tabIndex = -1;
        option.style.setProperty(
          "--llm-paper-picker-depth-indent",
          `${9 + row.depth * 14}px`,
        );
        option.style.paddingLeft =
          "calc(var(--llm-paper-picker-depth-indent) + var(--llm-paper-picker-selection-gutter, 0px))";

        let rowSelectionState: ReferenceSelectionState = "none";
        let rowSelected = false;

        if (item && (row.kind === "paper" || row.kind === "attachment")) {
          const group = getPaperPickerGroupByItemId(row.itemId);
          if (group) {
            const attachments =
              row.kind === "attachment"
                ? [group.attachments[row.attachmentIndex]].filter(Boolean)
                : group.attachments;
            rowSelectionState = getPaperPickerAttachmentSelectionStateForRow(
              group,
              attachments,
              selectedNoteContextItemIds,
            );
            rowSelected = isReferenceSelectorSelected(rowSelectionState);
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
        } else if (row.kind === "tag") {
          const tag = getPaperPickerTagCandidateByName(row.tagName);
          if (!tag) return;
          const tagRef: TagContextRef = {
            name: tag.name,
            normalizedName: tag.normalizedName,
            libraryID: deps.getCurrentLibraryID(),
            includeAutomatic: tag.includeAutomatic,
          };
          const isTagSelected = item
            ? isPaperPickerTagContextSelected(tagRef)
            : false;
          option.classList.toggle("llm-paper-picker-selected", isTagSelected);
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
            { textContent: tag.name, title: tag.name },
          );
          titleLine.append(createPickerIcon(ownerDoc, "tag"), title);
          rowMain.append(
            titleLine,
            createPaperPickerMetaLine(
              tag.isAutomatic ? t("Automatic tag") : t("Tag"),
              `${tag.count} ${t("items")}`,
            ),
          );
          option.append(rowMain);
          appendActionCell(
            option,
            rowIndex,
            isTagSelected,
            isTagSelected ? t("Remove tag context") : t("Add tag as context"),
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
            getPaperPickerAttachmentSelectionTitle(rowSelectionState),
            () => {
              const noJumpOptions: PaperPickerRenderOptions = {
                preserveReferenceScroll: true,
                skipActiveScroll: true,
              };
              if (isReferenceSelectorDirectSelection(rowSelectionState)) {
                return removePaperPickerGroupContexts(group, noJumpOptions);
              }
              if (isReferenceSelectorSelected(rowSelectionState)) {
                setStatus(
                  getPaperPickerAttachmentSelectionTitle(rowSelectionState),
                  "warning",
                );
                return false;
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
            getPaperPickerAttachmentSelectionTitle(rowSelectionState),
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
          referenceSelectorState.activeRowIndex = rowIndex;
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
    const activeOption = renderedOptions[referenceSelectorState.activeRowIndex] || null;
    if (referenceSelectorState.activeRowIndex <= 0) {
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
        referenceSelectorState.activeRowIndex = 0;
        renderPaperPicker();
        return;
      }
      const [paperResults, collectionResults, tagResults] = await Promise.all([
        searchAllItemCandidates(libraryID, activeSlashToken.query, 20),
        searchCollectionCandidates(libraryID, activeSlashToken.query),
        searchTagCandidates(libraryID, activeSlashToken.query),
      ]);
      if (requestId !== paperPickerRequestSeq) return;
      if (!getActiveAtToken()) {
        closePaperPicker();
        return;
      }
      setPaperPickerSearchResults(paperResults, collectionResults, tagResults);
      referenceSelectorState.activeRowIndex = 0;
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
    if (!referenceSelectorState.rows.length) return;
    referenceSelectorState.activeRowIndex =
      (referenceSelectorState.activeRowIndex + delta + referenceSelectorState.rows.length) %
      referenceSelectorState.rows.length;
    renderPaperPicker();
  };

  return {
    getActiveAtToken,
    isPaperPickerOpen,
    closePaperPicker,
    schedulePaperPickerSearch,
    moveActiveRow,
    selectActiveRow: () => {
      selectPaperPickerRowAt(referenceSelectorState.activeRowIndex);
    },
    handleArrowRight,
    handleArrowLeft,
    addZoteroItemsAsPaperContext,
  };
}
