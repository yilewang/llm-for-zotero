import { isPdfContextAttachment } from "./contextAttachmentSupport";
import { scrollToSelectedTextInReader } from "./livePdfSelectionLocator";
import type { SelectedTextContext } from "./types";

type ReaderLocation = {
  pageIndex: number;
  pageLabel: string;
};

export type SelectedTextContextTargetResolutionDeps = {
  getActiveContextAttachment: () => any;
  getCurrentItem: () => any;
  resolveCurrentPaperBaseItem: () => any;
  getItemById: (itemId: number) => any;
};

export type SelectedTextContextNavigationDeps =
  SelectedTextContextTargetResolutionDeps & {
    getActiveReaderForSelectedTab: () => any;
    getSelectedTabId: () => string | number | null | undefined;
    getReaderByTabId: (tabId: string | number) => any;
    openReader?: (itemId: number, location: ReaderLocation) => Promise<any>;
    viewPdf?: (itemId: number, location: ReaderLocation) => Promise<void>;
  };

function asFinitePositiveItemId(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

export function resolveSelectedTextContextTargetItemId(
  selectedContext: SelectedTextContext,
  deps: SelectedTextContextTargetResolutionDeps,
): number | null {
  const explicitContextItemId = asFinitePositiveItemId(
    selectedContext.contextItemId,
  );
  if (explicitContextItemId) return explicitContextItemId;

  const paperContextItemId = asFinitePositiveItemId(
    selectedContext.paperContext?.contextItemId,
  );
  if (paperContextItemId) return paperContextItemId;

  const activeContextItemId = asFinitePositiveItemId(
    deps.getActiveContextAttachment()?.id,
  );
  if (activeContextItemId) return activeContextItemId;

  const currentItem = deps.getCurrentItem();
  const currentPanelItemId = asFinitePositiveItemId(
    isPdfContextAttachment(currentItem) ? currentItem?.id : 0,
  );
  if (currentPanelItemId) return currentPanelItemId;

  const basePaper = deps.resolveCurrentPaperBaseItem();
  if (!basePaper) return null;
  const attachments = basePaper.getAttachments?.() || [];
  for (const attachmentId of attachments) {
    const attachment = deps.getItemById(attachmentId) || null;
    if (isPdfContextAttachment(attachment)) return attachment.id;
  }
  return null;
}

async function focusSelectedTextInReader(
  reader: any,
  selectedContext: SelectedTextContext,
  pageIndex: number,
): Promise<void> {
  if (selectedContext.text) {
    await scrollToSelectedTextInReader(reader, selectedContext.text, {
      expectedPageIndex: pageIndex,
    }).catch((_error) => undefined);
  }
}

export async function navigateSelectedTextContextToPage(
  selectedContext: SelectedTextContext,
  deps: SelectedTextContextNavigationDeps,
): Promise<boolean> {
  const rawPageIndex = Number(selectedContext.pageIndex);
  if (!Number.isFinite(rawPageIndex) || rawPageIndex < 0) return false;
  const pageIndex = Math.floor(rawPageIndex);
  const pageLabel = selectedContext.pageLabel || `${pageIndex + 1}`;
  const targetItemId = resolveSelectedTextContextTargetItemId(
    selectedContext,
    deps,
  );
  if (!targetItemId) return false;

  const location = { pageIndex, pageLabel };
  const activeReader = deps.getActiveReaderForSelectedTab();
  const activeReaderItemId = asFinitePositiveItemId(
    activeReader?._item?.id || activeReader?.itemID,
  );
  if (
    activeReaderItemId === targetItemId &&
    typeof activeReader?.navigate === "function"
  ) {
    await activeReader.navigate(location);
    await focusSelectedTextInReader(activeReader, selectedContext, pageIndex);
    return true;
  }

  if (deps.openReader) {
    const openedReader = await deps.openReader(targetItemId, location);
    let readerFromSelectedTab = null;
    if (!openedReader) {
      const selectedTabId = deps.getSelectedTabId();
      readerFromSelectedTab =
        selectedTabId !== undefined && selectedTabId !== null
          ? deps.getReaderByTabId(`${selectedTabId}`)
          : null;
    }
    const nextReader =
      openedReader ||
      readerFromSelectedTab ||
      deps.getActiveReaderForSelectedTab();
    if (nextReader) {
      await focusSelectedTextInReader(nextReader, selectedContext, pageIndex);
    }
    return true;
  }

  if (deps.viewPdf) {
    await deps.viewPdf(targetItemId, location);
    const nextReader = deps.getActiveReaderForSelectedTab();
    if (nextReader) {
      await focusSelectedTextInReader(nextReader, selectedContext, pageIndex);
    }
    return true;
  }

  return false;
}
