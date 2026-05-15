export type MineruTagScope = "all" | "allTagged" | "untagged";
export type MineruFolderScope = number | "all" | "unfiled";
export type MineruTagMatchMode = "and" | "or";

export type MineruTagIndexItem = {
  attachmentId: number;
  tags: readonly string[];
  tagsAuto: readonly string[];
};

export type MineruFolderTagIndexItem = MineruTagIndexItem & {
  collectionIds: readonly number[];
};

export type MineruTagInfo = {
  name: string;
  count: number;
  color: string | null;
  isAutomatic: boolean;
  itemIds: Set<number>;
};

export type MineruTagAvailability = {
  name: string;
  selected: boolean;
  available: boolean;
};

export function normalizeMineruTagName(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  return name ? name : null;
}

function uniqueSortedTags(tags: Iterable<string>): string[] {
  return [...new Set(tags)].sort((a, b) => a.localeCompare(b));
}

export function getMineruItemTags(
  item: MineruTagIndexItem,
  includeAutomatic: boolean,
): string[] {
  const tags = item.tags
    .map(normalizeMineruTagName)
    .filter(Boolean) as string[];
  if (includeAutomatic) {
    for (const tag of item.tagsAuto) {
      const name = normalizeMineruTagName(tag);
      if (name) tags.push(name);
    }
  }
  return uniqueSortedTags(tags);
}

export function buildMineruTagIndex(
  items: readonly MineruTagIndexItem[],
  options: {
    includeAutomatic?: boolean;
    getColor?: (name: string) => string | null | undefined;
  } = {},
): Map<string, MineruTagInfo> {
  const index = new Map<
    string,
    MineruTagInfo & { manualOccurrences: number; automaticOccurrences: number }
  >();
  const includeAutomatic = options.includeAutomatic ?? false;

  for (const item of items) {
    const manualTags = uniqueSortedTags(
      item.tags.map(normalizeMineruTagName).filter(Boolean) as string[],
    );
    const autoTags = uniqueSortedTags(
      item.tagsAuto.map(normalizeMineruTagName).filter(Boolean) as string[],
    );
    const visibleTags = includeAutomatic
      ? uniqueSortedTags([...manualTags, ...autoTags])
      : manualTags;

    for (const name of visibleTags) {
      let info = index.get(name);
      if (!info) {
        let color: string | null = null;
        try {
          color = options.getColor?.(name) || null;
        } catch {
          color = null;
        }
        info = {
          name,
          count: 0,
          color,
          isAutomatic: false,
          itemIds: new Set<number>(),
          manualOccurrences: 0,
          automaticOccurrences: 0,
        };
        index.set(name, info);
      }
      if (!info.itemIds.has(item.attachmentId)) {
        info.itemIds.add(item.attachmentId);
        info.count += 1;
      }
      if (manualTags.includes(name)) info.manualOccurrences += 1;
      else if (autoTags.includes(name)) info.automaticOccurrences += 1;
    }
  }

  for (const info of index.values()) {
    info.isAutomatic =
      info.automaticOccurrences > 0 && info.manualOccurrences === 0;
  }

  return index as Map<string, MineruTagInfo>;
}

export function getSortedMineruTagInfos(
  index: ReadonlyMap<string, MineruTagInfo>,
): MineruTagInfo[] {
  return [...index.values()].sort((a, b) => {
    const countDelta = b.count - a.count;
    return countDelta || a.name.localeCompare(b.name);
  });
}

export function filterMineruItemsForTagView<T extends MineruTagIndexItem>(
  items: readonly T[],
  options: {
    scope?: MineruTagScope;
    selectedTags?: Iterable<string>;
    includeAutomatic?: boolean;
    matchMode?: MineruTagMatchMode;
  } = {},
): T[] {
  const scope = options.scope ?? "all";
  const includeAutomatic = options.includeAutomatic ?? false;
  const matchMode = options.matchMode ?? "and";
  const selectedTags = uniqueSortedTags(
    [...(options.selectedTags || [])]
      .map(normalizeMineruTagName)
      .filter(Boolean) as string[],
  );

  return items.filter((item) => {
    const tags = getMineruItemTags(item, includeAutomatic);
    if (scope === "allTagged" && tags.length === 0) return false;
    if (scope === "untagged" && tags.length > 0) return false;
    if (selectedTags.length > 0) {
      if (matchMode === "or") {
        return selectedTags.some((tag) => tags.includes(tag));
      }
      return selectedTags.every((tag) => tags.includes(tag));
    }
    return true;
  });
}

export function filterMineruItemsForFolderScope<
  T extends MineruFolderTagIndexItem,
>(
  items: readonly T[],
  options: {
    folderScope?: MineruFolderScope;
    folderItemIds?: ReadonlySet<number>;
  } = {},
): T[] {
  const folderScope = options.folderScope ?? "all";
  if (folderScope === "all") return [...items];
  if (folderScope === "unfiled") {
    return items.filter((item) => item.collectionIds.length === 0);
  }
  const folderItemIds = options.folderItemIds;
  if (folderItemIds) {
    return items.filter((item) => folderItemIds.has(item.attachmentId));
  }
  return items.filter((item) => item.collectionIds.includes(folderScope));
}

export function filterMineruItemsForFolderAndTagView<
  T extends MineruFolderTagIndexItem,
>(
  items: readonly T[],
  options: {
    folderScope?: MineruFolderScope;
    folderItemIds?: ReadonlySet<number>;
    tagScope?: MineruTagScope;
    selectedTags?: Iterable<string>;
    includeAutomatic?: boolean;
    tagMatchMode?: MineruTagMatchMode;
  } = {},
): T[] {
  return filterMineruItemsForTagView(
    filterMineruItemsForFolderScope(items, {
      folderScope: options.folderScope,
      folderItemIds: options.folderItemIds,
    }),
    {
      scope: options.tagScope,
      selectedTags: options.selectedTags,
      includeAutomatic: options.includeAutomatic,
      matchMode: options.tagMatchMode,
    },
  );
}

export function computeMineruTagAvailability(
  tagInfos: readonly MineruTagInfo[],
  filteredItems: readonly MineruTagIndexItem[],
  selectedTags: Iterable<string>,
  includeAutomatic: boolean,
): Map<string, MineruTagAvailability> {
  const selected = new Set(
    [...selectedTags].map(normalizeMineruTagName).filter(Boolean) as string[],
  );
  const visibleTagNames = new Set<string>();
  for (const item of filteredItems) {
    for (const tag of getMineruItemTags(item, includeAutomatic)) {
      visibleTagNames.add(tag);
    }
  }

  const availability = new Map<string, MineruTagAvailability>();
  for (const tag of tagInfos) {
    const isSelected = selected.has(tag.name);
    availability.set(tag.name, {
      name: tag.name,
      selected: isSelected,
      available: isSelected || visibleTagNames.has(tag.name),
    });
  }
  return availability;
}
