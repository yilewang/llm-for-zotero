export function chooseCurrentPaperBaseItemForMode<T>(params: {
  isGlobalMode: boolean;
  liveRawBaseItem: T | null;
  activeReaderBaseItem: T | null;
  cachedBasePaperItem: T | null;
  currentItemBaseItem: T | null;
}): T | null {
  if (params.isGlobalMode) {
    return (
      params.liveRawBaseItem ||
      params.activeReaderBaseItem ||
      params.cachedBasePaperItem ||
      params.currentItemBaseItem ||
      null
    );
  }
  return (
    params.cachedBasePaperItem ||
    params.currentItemBaseItem ||
    params.activeReaderBaseItem ||
    params.liveRawBaseItem ||
    null
  );
}

export function chooseAutoLoadedContextPanelItem<T>(params: {
  isGlobalMode: boolean;
  currentItem: T | null;
  currentPaperBaseItem: T | null;
  liveRawPanelItem: T | null;
  liveRawPanelItemIsSupportedAttachment?: boolean;
}): T | null {
  if (!params.currentItem) return null;
  if (params.liveRawPanelItemIsSupportedAttachment) {
    return params.liveRawPanelItem;
  }
  if (params.isGlobalMode) {
    return params.liveRawPanelItem || params.currentItem;
  }
  return (
    params.currentPaperBaseItem || params.liveRawPanelItem || params.currentItem
  );
}

export function isAutoLoadedSnapshotForCurrentPaper(params: {
  currentOwnerItemId: number | null;
  snapshotOwnerItemId: number | null;
  currentContextItemId?: number | null;
  snapshotContextItemId?: number | null;
  currentContentSourceMode?: string | null;
  snapshotContentSourceMode?: string | null;
  allowExplicitContextOverride?: boolean;
}): boolean {
  if (
    !params.currentOwnerItemId ||
    !params.snapshotOwnerItemId ||
    params.currentOwnerItemId !== params.snapshotOwnerItemId
  ) {
    return false;
  }
  if (params.allowExplicitContextOverride) {
    return true;
  }
  if (
    params.currentContextItemId &&
    params.snapshotContextItemId &&
    params.currentContextItemId !== params.snapshotContextItemId
  ) {
    return false;
  }
  const currentMode = `${params.currentContentSourceMode || ""}`;
  const snapshotMode = `${params.snapshotContentSourceMode || ""}`;
  if (currentMode && snapshotMode && currentMode !== snapshotMode) {
    return false;
  }
  return true;
}
