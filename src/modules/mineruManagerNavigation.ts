type MineruManagerSelectionTarget = (
  attachmentIds: readonly number[],
) => boolean | void;
type MineruManagerOpenTarget = () => boolean | void;

type ZoteroItemResolver = (
  attachmentId: number,
) => Zotero.Item | null | undefined;

const selectionTargets = new Set<MineruManagerSelectionTarget>();
const openTargets = new Set<MineruManagerOpenTarget>();
let pendingAttachmentIds: number[] | null = null;
let pendingOpenRequest = false;

function normalizeAttachmentIds(attachmentIds: readonly number[]): number[] {
  return [
    ...new Set(
      attachmentIds.filter(
        (attachmentId) => Number.isInteger(attachmentId) && attachmentId > 0,
      ),
    ),
  ];
}

function isPdfAttachment(item: Zotero.Item | null | undefined): boolean {
  return Boolean(
    item?.isAttachment?.() && item.attachmentContentType === "application/pdf",
  );
}

export function collectMineruPdfAttachmentIds(
  items: readonly Zotero.Item[],
  resolveItem: ZoteroItemResolver = (attachmentId) =>
    Zotero.Items.get(attachmentId),
  supportedLibraryId: number = Zotero.Libraries.userLibraryID,
): number[] {
  const attachmentIds: number[] = [];

  for (const item of items) {
    if (!item) continue;
    if (item.libraryID !== supportedLibraryId) continue;
    if (isPdfAttachment(item)) {
      attachmentIds.push(item.id);
      continue;
    }
    if (!item.isRegularItem?.()) continue;

    let childIds: number[] = [];
    try {
      childIds = item.getAttachments();
    } catch {
      continue;
    }
    for (const childId of Array.isArray(childIds) ? childIds : []) {
      let child: Zotero.Item | null | undefined;
      try {
        child = resolveItem(childId);
      } catch {
        continue;
      }
      if (child?.libraryID === supportedLibraryId && isPdfAttachment(child)) {
        attachmentIds.push(childId);
      }
    }
  }

  return normalizeAttachmentIds(attachmentIds);
}

export function requestMineruManagerOpen(): void {
  pendingOpenRequest = true;
  let handled = false;
  for (const target of openTargets) {
    try {
      handled = target() !== false || handled;
    } catch {
      /* keep the request pending for another/next preferences target */
    }
  }
  if (handled) pendingOpenRequest = false;
}

export function registerMineruManagerOpenTarget(
  target: MineruManagerOpenTarget,
): () => void {
  openTargets.add(target);
  if (pendingOpenRequest) {
    try {
      if (target() !== false) pendingOpenRequest = false;
    } catch {
      /* leave the request pending so a later target can apply it */
    }
  }

  return () => {
    openTargets.delete(target);
  };
}

export function hasPendingMineruManagerOpenRequest(): boolean {
  return pendingOpenRequest;
}

export function requestMineruManagerSelection(
  attachmentIds: readonly number[],
): boolean {
  const normalized = normalizeAttachmentIds(attachmentIds);
  if (!normalized.length) return false;

  pendingAttachmentIds = normalized;
  let handled = false;
  for (const target of selectionTargets) {
    try {
      handled = target(normalized) !== false || handled;
    } catch {
      /* keep the request pending for another/next manager target */
    }
  }
  if (handled) pendingAttachmentIds = null;
  return true;
}

export function registerMineruManagerSelectionTarget(
  target: MineruManagerSelectionTarget,
): () => void {
  selectionTargets.add(target);
  if (pendingAttachmentIds) {
    try {
      if (target(pendingAttachmentIds) !== false) {
        pendingAttachmentIds = null;
      }
    } catch {
      /* leave the request pending so a later target can apply it */
    }
  }

  return () => {
    selectionTargets.delete(target);
  };
}

export function hasPendingMineruManagerSelection(): boolean {
  return Boolean(pendingAttachmentIds?.length);
}

export function clearMineruManagerNavigationForTests(): void {
  selectionTargets.clear();
  openTargets.clear();
  pendingAttachmentIds = null;
  pendingOpenRequest = false;
}
