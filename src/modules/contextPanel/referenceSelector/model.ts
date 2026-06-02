import {
  buildMineruTagIndex,
  computeMineruTagAvailability,
  filterMineruItemsForTagView,
  getSortedMineruTagInfos,
  normalizeMineruTagName,
  type MineruTagAvailability,
  type MineruTagInfo,
  type MineruTagMatchMode,
  type MineruTagScope,
} from "../../mineruTagIndex";
import type {
  PaperBrowseCollectionCandidate,
  PaperSearchAttachmentCandidate,
  PaperSearchGroupCandidate,
  PaperSearchTagCandidate,
} from "../paperSearch";
import type {
  CollectionContextRef,
  OtherContextRef,
  PaperContextRef,
  TagContextRef,
} from "../types";

export type ReferenceSelectorMode = "browse" | "search" | "empty";
export type ReferenceSelectorFolderScope = "all" | number;
export type ReferenceSelectionState =
  | "none"
  | "explicit"
  | "coveredByCollection"
  | "coveredByTag"
  | "noteText"
  | "otherReference";

export type ReferenceSelectorRow =
  | {
      kind: "collection";
      collectionId: number;
      depth: number;
    }
  | {
      kind: "tag";
      tagName: string;
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

export type ReferenceSelectorTagIndexItem = {
  attachmentId: number;
  tags: readonly string[];
  tagsAuto: readonly string[];
  group: PaperSearchGroupCandidate;
};

export type ReferenceSelectorState = {
  mode: ReferenceSelectorMode;
  emptyMessage: string;
  groups: PaperSearchGroupCandidate[];
  collections: PaperBrowseCollectionCandidate[];
  tagCandidates: PaperSearchTagCandidate[];
  groupByItemId: Map<number, PaperSearchGroupCandidate>;
  collectionById: Map<number, PaperBrowseCollectionCandidate>;
  tagCandidateByName: Map<string, PaperSearchTagCandidate>;
  expandedPaperKeys: Set<number>;
  expandedCollectionKeys: Set<number>;
  rows: ReferenceSelectorRow[];
  activeRowIndex: number;
  activeFolderScope: ReferenceSelectorFolderScope;
  folderFilterQuery: string;
  tagScope: MineruTagScope;
  selectedTags: Set<string>;
  tagFilterQuery: string;
  tagMatchMode: MineruTagMatchMode;
  showAutomaticTags: boolean;
  tagFilterMenuOpen: boolean;
};

export type ReferenceSelectorViewModel = {
  rows: ReferenceSelectorRow[];
  activeRowIndex: number;
  allBrowseGroups: PaperSearchGroupCandidate[];
  folderScopedGroups: PaperSearchGroupCandidate[];
  visibleGroups: PaperSearchGroupCandidate[];
};

export type ReferenceSelectorTagViewModel = {
  baseGroups: PaperSearchGroupCandidate[];
  visibleGroups: PaperSearchGroupCandidate[];
  baseItems: ReferenceSelectorTagIndexItem[];
  allTagInfos: MineruTagInfo[];
  filteredTagInfos: MineruTagInfo[];
  availability: Map<string, MineruTagAvailability>;
  allTaggedCount: number;
  untaggedCount: number;
};

export function compareReferenceSelectorGroupsByAdded(
  a: PaperSearchGroupCandidate,
  b: PaperSearchGroupCandidate,
): number {
  const addedDelta = (b.addedAt || 0) - (a.addedAt || 0);
  if (addedDelta !== 0) return addedDelta;
  const modifiedDelta = b.modifiedAt - a.modifiedAt;
  if (modifiedDelta !== 0) return modifiedDelta;
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
}

export function createReferenceSelectorState(): ReferenceSelectorState {
  return {
    mode: "browse",
    emptyMessage: "No references available.",
    groups: [],
    collections: [],
    tagCandidates: [],
    groupByItemId: new Map<number, PaperSearchGroupCandidate>(),
    collectionById: new Map<number, PaperBrowseCollectionCandidate>(),
    tagCandidateByName: new Map<string, PaperSearchTagCandidate>(),
    expandedPaperKeys: new Set<number>(),
    expandedCollectionKeys: new Set<number>(),
    rows: [],
    activeRowIndex: 0,
    activeFolderScope: "all",
    folderFilterQuery: "",
    tagScope: "all",
    selectedTags: new Set<string>(),
    tagFilterQuery: "",
    tagMatchMode: "and",
    showAutomaticTags: false,
    tagFilterMenuOpen: false,
  };
}

export function buildReferenceSelectorTagIndexItems(
  groups: readonly PaperSearchGroupCandidate[],
): ReferenceSelectorTagIndexItem[] {
  return groups.map((group) => ({
    attachmentId: group.itemId,
    tags: group.tags || [],
    tagsAuto: group.tagsAuto || [],
    group,
  }));
}

export function filterReferenceSelectorGroupsForTagView(
  groups: readonly PaperSearchGroupCandidate[],
  options: {
    tagScope?: MineruTagScope;
    selectedTags?: Iterable<string>;
    includeAutomatic?: boolean;
    tagMatchMode?: MineruTagMatchMode;
  } = {},
): PaperSearchGroupCandidate[] {
  return filterMineruItemsForTagView(
    buildReferenceSelectorTagIndexItems(groups),
    {
      scope: options.tagScope,
      selectedTags: options.selectedTags,
      includeAutomatic: options.includeAutomatic,
      matchMode: options.tagMatchMode,
    },
  ).map((item) => item.group);
}

export function setReferenceSelectorSearchResults(
  state: ReferenceSelectorState,
  groups: PaperSearchGroupCandidate[],
  collections: PaperBrowseCollectionCandidate[],
  tags: PaperSearchTagCandidate[] = [],
): void {
  state.mode =
    groups.length || collections.length || tags.length ? "search" : "empty";
  state.emptyMessage = "No items matched.";
  state.groups = groups;
  state.collections = collections;
  state.tagCandidates = tags;
  state.groupByItemId = new Map<number, PaperSearchGroupCandidate>();
  state.collectionById = new Map<number, PaperBrowseCollectionCandidate>();
  state.tagCandidateByName = new Map<string, PaperSearchTagCandidate>();
  state.expandedPaperKeys = new Set<number>();
  state.expandedCollectionKeys = new Set<number>();
  for (const group of groups) state.groupByItemId.set(group.itemId, group);
  for (const collection of collections) {
    state.collectionById.set(collection.collectionId, collection);
  }
  for (const tag of tags) state.tagCandidateByName.set(tag.name, tag);
  rebuildReferenceSelectorRows(state);
}

export function setReferenceSelectorCollections(
  state: ReferenceSelectorState,
  collections: PaperBrowseCollectionCandidate[],
): void {
  state.mode = collections.length ? "browse" : "empty";
  state.emptyMessage = "No references available.";
  state.groups = [];
  state.collections = collections;
  state.tagCandidates = [];
  state.groupByItemId = new Map<number, PaperSearchGroupCandidate>();
  state.collectionById = new Map<number, PaperBrowseCollectionCandidate>();
  state.tagCandidateByName = new Map<string, PaperSearchTagCandidate>();
  state.expandedPaperKeys = new Set<number>();
  state.expandedCollectionKeys = new Set<number>();

  const registerCollection = (collection: PaperBrowseCollectionCandidate) => {
    state.collectionById.set(collection.collectionId, collection);
    for (const paper of collection.papers) state.groupByItemId.set(paper.itemId, paper);
    for (const child of collection.childCollections) registerCollection(child);
  };
  for (const collection of collections) registerCollection(collection);
  if (
    state.activeFolderScope !== "all" &&
    !state.collectionById.has(state.activeFolderScope)
  ) {
    state.activeFolderScope = "all";
  }
  rebuildReferenceSelectorRows(state);
}

export function getReferenceSelectorAllBrowseGroups(
  state: ReferenceSelectorState,
): PaperSearchGroupCandidate[] {
  const groupsById = new Map<number, PaperSearchGroupCandidate>();
  const visitCollection = (collection: PaperBrowseCollectionCandidate) => {
    for (const group of collection.papers) groupsById.set(group.itemId, group);
    for (const child of collection.childCollections) visitCollection(child);
  };
  for (const collection of state.collections) visitCollection(collection);
  return [...groupsById.values()].sort(compareReferenceSelectorGroupsByAdded);
}

export function collectReferenceSelectorCollectionGroups(
  collection: PaperBrowseCollectionCandidate,
): PaperSearchGroupCandidate[] {
  const groupsById = new Map<number, PaperSearchGroupCandidate>();
  const visitCollection = (node: PaperBrowseCollectionCandidate) => {
    for (const group of node.papers) groupsById.set(group.itemId, group);
    for (const child of node.childCollections) visitCollection(child);
  };
  visitCollection(collection);
  return [...groupsById.values()].sort(compareReferenceSelectorGroupsByAdded);
}

export function getReferenceSelectorFolderScopedGroups(
  state: ReferenceSelectorState,
): PaperSearchGroupCandidate[] {
  if (state.mode !== "browse") return [...state.groups];
  if (state.activeFolderScope === "all") {
    return getReferenceSelectorAllBrowseGroups(state);
  }
  const collection = state.collectionById.get(state.activeFolderScope);
  if (!collection) return [];
  return collectReferenceSelectorCollectionGroups(collection);
}

export function getReferenceSelectorVisibleGroups(
  state: ReferenceSelectorState,
): PaperSearchGroupCandidate[] {
  return filterReferenceSelectorGroupsForTagView(
    getReferenceSelectorFolderScopedGroups(state),
    {
      tagScope: state.tagScope,
      selectedTags: state.selectedTags,
      includeAutomatic: state.showAutomaticTags,
      tagMatchMode: state.tagMatchMode,
    },
  );
}

export function isReferenceSelectorGroupExpanded(
  state: ReferenceSelectorState,
  itemId: number,
): boolean {
  const group = state.groupByItemId.get(itemId);
  if (!group || group.attachments.length <= 1) return false;
  return state.expandedPaperKeys.has(itemId);
}

export function isReferenceSelectorCollectionExpanded(
  state: ReferenceSelectorState,
  collectionId: number,
): boolean {
  return state.expandedCollectionKeys.has(collectionId);
}

export function toggleReferenceSelectorGroupExpanded(
  state: ReferenceSelectorState,
  itemId: number,
  expanded?: boolean,
): boolean {
  const group = state.groupByItemId.get(itemId);
  if (!group || group.attachments.length <= 1) return false;
  const currentlyExpanded = state.expandedPaperKeys.has(itemId);
  const nextExpanded = expanded === undefined ? !currentlyExpanded : expanded;
  if (nextExpanded === currentlyExpanded) return false;
  if (nextExpanded) state.expandedPaperKeys.add(itemId);
  else state.expandedPaperKeys.delete(itemId);
  rebuildReferenceSelectorRows(state);
  return true;
}

export function toggleReferenceSelectorCollectionExpanded(
  state: ReferenceSelectorState,
  collectionId: number,
  expanded?: boolean,
): boolean {
  const collection = state.collectionById.get(collectionId);
  if (!collection) return false;
  const currentlyExpanded = state.expandedCollectionKeys.has(collectionId);
  const nextExpanded = expanded === undefined ? !currentlyExpanded : expanded;
  if (nextExpanded === currentlyExpanded) return false;
  if (nextExpanded) state.expandedCollectionKeys.add(collectionId);
  else state.expandedCollectionKeys.delete(collectionId);
  rebuildReferenceSelectorRows(state);
  return true;
}

export function setReferenceSelectorFolderScope(
  state: ReferenceSelectorState,
  scope: ReferenceSelectorFolderScope,
): void {
  state.activeFolderScope = scope;
  state.activeRowIndex = 0;
  state.expandedPaperKeys = new Set<number>();
  rebuildReferenceSelectorRows(state);
}

export function resetReferenceSelectorReferenceFilters(
  state: ReferenceSelectorState,
): void {
  state.activeRowIndex = 0;
  state.expandedPaperKeys = new Set<number>();
  rebuildReferenceSelectorRows(state);
}

export function rebuildReferenceSelectorRows(
  state: ReferenceSelectorState,
): ReferenceSelectorRow[] {
  const rows: ReferenceSelectorRow[] = [];
  const appendPaperRow = (
    group: PaperSearchGroupCandidate,
    depth: number,
  ) => {
    rows.push({ kind: "paper", itemId: group.itemId, depth });
    if (group.attachments.length <= 1) return;
    if (!isReferenceSelectorGroupExpanded(state, group.itemId)) return;
    group.attachments.forEach((_attachment, attachmentIndex) => {
      rows.push({
        kind: "attachment",
        itemId: group.itemId,
        attachmentIndex,
        depth: depth + 1,
      });
    });
  };

  if (state.mode === "browse") {
    getReferenceSelectorVisibleGroups(state).forEach((group) =>
      appendPaperRow(group, 0),
    );
  } else if (state.mode === "search") {
    for (const collection of state.collections) {
      rows.push({
        kind: "collection",
        collectionId: collection.collectionId,
        depth: 0,
      });
    }
    for (const tag of state.tagCandidates) {
      rows.push({ kind: "tag", tagName: tag.name, depth: 0 });
    }
    state.groups.forEach((group) => appendPaperRow(group, 0));
  }

  state.rows = rows;
  state.activeRowIndex = clampReferenceSelectorActiveRow(
    state.activeRowIndex,
    rows.length,
  );
  return rows;
}

export function clampReferenceSelectorActiveRow(
  activeRowIndex: number,
  rowCount: number,
): number {
  if (!rowCount) return 0;
  return Math.max(0, Math.min(rowCount - 1, activeRowIndex));
}

export function getReferenceSelectorRowAt(
  state: ReferenceSelectorState,
  index: number,
): ReferenceSelectorRow | null {
  return state.rows[index] || null;
}

export function findReferenceSelectorPaperRowIndex(
  rows: readonly ReferenceSelectorRow[],
  itemId: number,
): number {
  return rows.findIndex((row) => row.kind === "paper" && row.itemId === itemId);
}

export function findReferenceSelectorFirstAttachmentRowIndex(
  rows: readonly ReferenceSelectorRow[],
  itemId: number,
): number {
  return rows.findIndex(
    (row) => row.kind === "attachment" && row.itemId === itemId,
  );
}

export function findReferenceSelectorParentRowIndex(
  rows: readonly ReferenceSelectorRow[],
  index: number,
): number {
  const row = rows[index];
  if (!row || row.depth <= 0) return -1;
  for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const candidateRow = rows[candidateIndex];
    if (candidateRow && candidateRow.depth === row.depth - 1) {
      return candidateIndex;
    }
  }
  return -1;
}

export function findReferenceSelectorFirstChildRowIndex(
  rows: readonly ReferenceSelectorRow[],
  index: number,
): number {
  const row = rows[index];
  if (!row) return -1;
  const nextRow = rows[index + 1];
  return nextRow && nextRow.depth === row.depth + 1 ? index + 1 : -1;
}

export function buildReferenceSelectorViewModel(
  state: ReferenceSelectorState,
): ReferenceSelectorViewModel {
  const allBrowseGroups = getReferenceSelectorAllBrowseGroups(state);
  const folderScopedGroups =
    state.mode === "browse"
      ? state.activeFolderScope === "all"
        ? allBrowseGroups
        : getReferenceSelectorFolderScopedGroups(state)
      : [...state.groups];
  const visibleGroups = filterReferenceSelectorGroupsForTagView(
    folderScopedGroups,
    {
      tagScope: state.tagScope,
      selectedTags: state.selectedTags,
      includeAutomatic: state.showAutomaticTags,
      tagMatchMode: state.tagMatchMode,
    },
  );
  const rows = rebuildReferenceSelectorRowsFromVisibleGroups(
    state,
    visibleGroups,
  );
  state.rows = rows;
  state.activeRowIndex = clampReferenceSelectorActiveRow(
    state.activeRowIndex,
    rows.length,
  );
  return {
    rows,
    activeRowIndex: state.activeRowIndex,
    allBrowseGroups,
    folderScopedGroups,
    visibleGroups,
  };
}

function rebuildReferenceSelectorRowsFromVisibleGroups(
  state: ReferenceSelectorState,
  visibleGroups: readonly PaperSearchGroupCandidate[],
): ReferenceSelectorRow[] {
  const rows: ReferenceSelectorRow[] = [];
  const appendPaperRow = (
    group: PaperSearchGroupCandidate,
    depth: number,
  ) => {
    rows.push({ kind: "paper", itemId: group.itemId, depth });
    if (group.attachments.length <= 1) return;
    if (!isReferenceSelectorGroupExpanded(state, group.itemId)) return;
    group.attachments.forEach((_attachment, attachmentIndex) => {
      rows.push({
        kind: "attachment",
        itemId: group.itemId,
        attachmentIndex,
        depth: depth + 1,
      });
    });
  };
  if (state.mode === "browse") {
    visibleGroups.forEach((group) => appendPaperRow(group, 0));
  } else if (state.mode === "search") {
    for (const collection of state.collections) {
      rows.push({
        kind: "collection",
        collectionId: collection.collectionId,
        depth: 0,
      });
    }
    for (const tag of state.tagCandidates) {
      rows.push({ kind: "tag", tagName: tag.name, depth: 0 });
    }
    state.groups.forEach((group) => appendPaperRow(group, 0));
  }
  return rows;
}

export function buildReferenceSelectorTagViewModel(
  state: ReferenceSelectorState,
  baseGroups: readonly PaperSearchGroupCandidate[],
  visibleGroups: readonly PaperSearchGroupCandidate[],
  getColor?: (name: string) => string | null,
): ReferenceSelectorTagViewModel {
  const baseItems = buildReferenceSelectorTagIndexItems(baseGroups);
  const baseTagIndex = buildMineruTagIndex(baseItems, {
    includeAutomatic: state.showAutomaticTags,
    getColor,
  });
  const allTagInfos = getSortedMineruTagInfos(baseTagIndex);
  const query = state.tagFilterQuery.trim().toLowerCase();
  const filteredTagInfos = allTagInfos.filter(
    (info) => !query || info.name.toLowerCase().includes(query),
  );
  const availabilityItems =
    state.tagMatchMode === "or" && state.selectedTags.size > 0
      ? baseItems
      : buildReferenceSelectorTagIndexItems(visibleGroups);
  const availability = computeMineruTagAvailability(
    allTagInfos,
    availabilityItems,
    state.selectedTags,
    state.showAutomaticTags,
  );
  return {
    baseGroups: [...baseGroups],
    visibleGroups: [...visibleGroups],
    baseItems,
    allTagInfos,
    filteredTagInfos,
    availability,
    allTaggedCount: filterReferenceSelectorGroupsForTagView(baseGroups, {
      tagScope: "allTagged",
      includeAutomatic: state.showAutomaticTags,
    }).length,
    untaggedCount: filterReferenceSelectorGroupsForTagView(baseGroups, {
      tagScope: "untagged",
      includeAutomatic: state.showAutomaticTags,
    }).length,
  };
}

export function referenceSelectorCollectionMatchesFilter(
  collection: PaperBrowseCollectionCandidate,
  normalizedQuery: string,
  unfiledLabel: string,
): boolean {
  const label = collection.collectionId === 0 ? unfiledLabel : collection.name;
  if (label.toLowerCase().includes(normalizedQuery)) return true;
  return collection.childCollections.some((child) =>
    referenceSelectorCollectionMatchesFilter(child, normalizedQuery, unfiledLabel),
  );
}

export function buildReferenceSelectorTagContextKey(ref: TagContextRef): string {
  const libraryID = Math.max(0, Math.floor(Number(ref.libraryID) || 0));
  if (ref.scope) {
    return `${libraryID}:scope:${ref.scope}:${
      ref.includeAutomatic ? "auto" : "manual"
    }`;
  }
  return `${libraryID}:tag:${normalizeReferenceSelectorTagIdentityName(ref.normalizedName || ref.name)}`;
}

export function normalizeReferenceSelectorTagIdentityName(value: unknown): string {
  const name = normalizeMineruTagName(value);
  return name ? name.toLowerCase() : "";
}

export function isReferenceSelectorGroupCoveredBySelectedCollection(
  state: ReferenceSelectorState,
  group: PaperSearchGroupCandidate,
  selectedCollections: readonly CollectionContextRef[],
): boolean {
  if (!selectedCollections.length) return false;
  for (const collectionRef of selectedCollections) {
    if (group.collectionIds.includes(collectionRef.collectionId)) return true;
    const collection = state.collectionById.get(collectionRef.collectionId);
    if (!collection) continue;
    if (
      collectReferenceSelectorCollectionGroups(collection).some(
        (candidate) => candidate.itemId === group.itemId,
      )
    ) {
      return true;
    }
  }
  return false;
}

export function isReferenceSelectorGroupCoveredBySelectedTag(
  group: PaperSearchGroupCandidate,
  selectedTags: readonly TagContextRef[],
  options: {
    includeAutomaticFallback?: boolean;
    tagMatchMode?: MineruTagMatchMode;
  } = {},
): boolean {
  if (!selectedTags.length) return false;
  for (const tagRef of selectedTags) {
    const includeAutomatic =
      typeof tagRef.includeAutomatic === "boolean"
        ? tagRef.includeAutomatic
        : options.includeAutomaticFallback;
    if (tagRef.scope) {
      if (
        filterReferenceSelectorGroupsForTagView([group], {
          tagScope: tagRef.scope,
          includeAutomatic,
          tagMatchMode: options.tagMatchMode,
        }).length
      ) {
        return true;
      }
      continue;
    }
    const normalizedName = normalizeReferenceSelectorTagIdentityName(
      tagRef.normalizedName || tagRef.name,
    );
    if (
      normalizedName &&
      getReferenceSelectorGroupTagIdentityNames(
        group,
        includeAutomatic === true,
      ).has(normalizedName)
    ) {
      return true;
    }
  }
  return false;
}

function getReferenceSelectorGroupTagIdentityNames(
  group: PaperSearchGroupCandidate,
  includeAutomatic: boolean,
): Set<string> {
  const names = new Set<string>();
  const addTagName = (tagName: string) => {
    const normalizedName = normalizeReferenceSelectorTagIdentityName(tagName);
    if (normalizedName) {
      names.add(normalizedName);
    }
  };
  for (const tagName of group.tags || []) {
    addTagName(tagName);
  }
  if (includeAutomatic) {
    for (const tagName of group.tagsAuto || []) {
      addTagName(tagName);
    }
  }
  return names;
}

export function resolveReferenceSelectorAttachmentSelectionState(params: {
  state: ReferenceSelectorState;
  group: PaperSearchGroupCandidate;
  attachment: PaperSearchAttachmentCandidate;
  selectedCollections?: readonly CollectionContextRef[];
  selectedTags?: readonly TagContextRef[];
  autoLoadedPaperContext?: PaperContextRef | null;
  selectedPapers?: readonly PaperContextRef[];
  selectedOtherRefs?: readonly OtherContextRef[];
  selectedNoteContextItemIds?: ReadonlySet<number>;
}): ReferenceSelectionState {
  const {
    state,
    group,
    attachment,
    selectedCollections = [],
    selectedTags = [],
    autoLoadedPaperContext,
    selectedPapers = [],
    selectedOtherRefs = [],
    selectedNoteContextItemIds = new Set<number>(),
  } = params;
  if (
    isReferenceSelectorGroupCoveredBySelectedCollection(
      state,
      group,
      selectedCollections,
    )
  ) {
    return "coveredByCollection";
  }
  if (
    isReferenceSelectorGroupCoveredBySelectedTag(group, selectedTags, {
      includeAutomaticFallback: state.showAutomaticTags,
      tagMatchMode: state.tagMatchMode,
    })
  ) {
    return "coveredByTag";
  }
  if (
    (autoLoadedPaperContext?.itemId === group.itemId &&
      autoLoadedPaperContext.contextItemId === attachment.contextItemId) ||
    selectedPapers.some(
      (paper) => paper.contextItemId === attachment.contextItemId,
    )
  ) {
    return "explicit";
  }
  if (
    selectedOtherRefs.some(
      (ref) => ref.contextItemId === attachment.contextItemId,
    )
  ) {
    return "otherReference";
  }
  if (selectedNoteContextItemIds.has(attachment.contextItemId)) {
    return "noteText";
  }
  return "none";
}

export function resolveReferenceSelectorGroupSelectionState(params: {
  state: ReferenceSelectorState;
  group: PaperSearchGroupCandidate;
  selectedCollections?: readonly CollectionContextRef[];
  selectedTags?: readonly TagContextRef[];
  autoLoadedPaperContext?: PaperContextRef | null;
  selectedPapers?: readonly PaperContextRef[];
  selectedOtherRefs?: readonly OtherContextRef[];
  selectedNoteContextItemIds?: ReadonlySet<number>;
}): ReferenceSelectionState {
  for (const attachment of params.group.attachments) {
    const state = resolveReferenceSelectorAttachmentSelectionState({
      ...params,
      attachment,
    });
    if (state !== "none") return state;
  }
  return "none";
}

export function isReferenceSelectorDirectSelection(
  state: ReferenceSelectionState,
): boolean {
  return (
    state === "explicit" || state === "noteText" || state === "otherReference"
  );
}

export function isReferenceSelectorSelected(
  state: ReferenceSelectionState,
): boolean {
  return state !== "none";
}
