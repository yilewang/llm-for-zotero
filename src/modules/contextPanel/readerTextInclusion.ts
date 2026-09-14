import { t } from "../../utils/i18n";
import {
  appendSelectedTextContextForItem,
  applySelectedTextPreview,
  updateSelectedTextContextLocationForItem,
  type SelectedTextPageLocation,
} from "./contextResolution";
import {
  getCurrentSelectionPageLocationFromReader,
  resolveCurrentSelectionPageLocationFromReader,
} from "./livePdfSelectionLocator";
import { activeContextPanels, activeContextPanelStateSync } from "./state";
import { normalizeSelectedText, setStatus } from "./textUtils";
import type { PaperContextRef } from "./types";
import {
  capturePanelOperationLease,
  getPanelHostBinding,
  isPanelHostCompatibleWithPaper,
  isPanelOperationLeaseCurrent,
  requireCurrentPanelOwnership,
} from "./panelHostOwnership";

export type IncludeReaderSelectedTextOutcome =
  | "added"
  | "no-selection"
  | "not-added"
  | "invalid-target";

export type IncludeReaderSelectedTextResult = {
  outcome: IncludeReaderSelectedTextOutcome;
  added: boolean;
  location: SelectedTextPageLocation | null;
  locationEnriched: boolean;
};

export type IncludeReaderSelectedTextInput = {
  body: Element;
  conversationKey: number;
  selectedText: string;
  reader?: any | null;
  paperContext?: PaperContextRef | null;
  initialLocation?: SelectedTextPageLocation | null;
  log?: (message: string, ...args: unknown[]) => void;
};

export type ReaderTextInclusionDependencies = {
  getCurrentLocation: typeof getCurrentSelectionPageLocationFromReader;
  resolveLocation: typeof resolveCurrentSelectionPageLocationFromReader;
};

const defaultDependencies: ReaderTextInclusionDependencies = {
  getCurrentLocation: getCurrentSelectionPageLocationFromReader,
  resolveLocation: resolveCurrentSelectionPageLocationFromReader,
};

function getPanelConversationKey(body: Element): number {
  const root = body.querySelector("#llm-main") as HTMLElement | null;
  const parsed = Number(root?.dataset.itemId || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function refreshSelectedTextPanels(
  primaryBody: Element,
  conversationKey: number,
): void {
  const bodies = new Set<Element>([
    primaryBody,
    ...activeContextPanels.keys(),
    ...activeContextPanelStateSync.keys(),
  ]);

  for (const body of bodies) {
    if (body !== primaryBody && !body.isConnected) {
      activeContextPanels.delete(body);
      activeContextPanelStateSync.delete(body);
      continue;
    }
    if (
      body !== primaryBody &&
      getPanelConversationKey(body) !== conversationKey
    ) {
      continue;
    }
    const syncPanelState = activeContextPanelStateSync.get(body);
    if (syncPanelState) {
      syncPanelState();
    } else {
      applySelectedTextPreview(body, conversationKey);
    }
  }
}

function getReaderContextItemId(reader: any): number | undefined {
  const parsed = Number(reader?._item?.id || reader?.itemID || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function getZoteroItem(itemID: number | undefined): Zotero.Item | null {
  if (!itemID || typeof Zotero === "undefined") return null;
  try {
    return (Zotero.Items?.get?.(itemID) as Zotero.Item | null) || null;
  } catch (_error) {
    return null;
  }
}

function hasPageLocation(
  location: SelectedTextPageLocation | null | undefined,
): boolean {
  const pageIndex = Number(location?.pageIndex);
  return Number.isFinite(pageIndex) && pageIndex >= 0;
}

export async function includeReaderSelectedText(
  input: IncludeReaderSelectedTextInput,
  dependencies: ReaderTextInclusionDependencies = defaultDependencies,
): Promise<IncludeReaderSelectedTextResult> {
  const conversationKey = Math.floor(Number(input.conversationKey || 0));
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) {
    input.log?.("LLM addText: invalid conversation target", {
      conversationKey: input.conversationKey,
    });
    return {
      outcome: "invalid-target",
      added: false,
      location: null,
      locationEnriched: false,
    };
  }

  const targetItem = activeContextPanels.get(input.body)?.() || null;
  const targetBinding = getPanelHostBinding(input.body);
  const targetRoot = input.body.querySelector(
    "#llm-main",
  ) as HTMLElement | null;
  const hasEstablishedPanelOwner = Boolean(
    targetBinding || targetRoot?.dataset.handlersInitialized,
  );
  const readerTabID = `${input.reader?.tabID ?? input.reader?._tabID ?? ""}`;
  const readerContextItemId = getReaderContextItemId(input.reader);
  const readerContextItem = getZoteroItem(readerContextItemId);
  const readerPaperItem = readerContextItem?.parentID
    ? getZoteroItem(readerContextItem.parentID)
    : readerContextItem;
  const mountedKind = targetRoot?.dataset.conversationKind;
  const invalidReaderRoute =
    hasEstablishedPanelOwner &&
    (!targetItem ||
      getPanelConversationKey(input.body) !== conversationKey ||
      !requireCurrentPanelOwnership(
        input.body,
        targetItem,
        "add-reader-text",
      ) ||
      (targetBinding?.surface === "reader" &&
        (!readerTabID || readerTabID !== targetBinding.tabID)) ||
      (mountedKind === "paper" &&
        (!readerPaperItem ||
          !isPanelHostCompatibleWithPaper(input.body, readerPaperItem))) ||
      (Boolean(readerContextItem) &&
        Boolean(targetBinding?.libraryID) &&
        Number(readerContextItem?.libraryID || 0) !==
          targetBinding?.libraryID));
  if (invalidReaderRoute) {
    input.log?.("LLM addText: rejected mismatched reader/panel ownership");
    return {
      outcome: "invalid-target",
      added: false,
      location: null,
      locationEnriched: false,
    };
  }
  const operationLease = capturePanelOperationLease(input.body);
  if (hasEstablishedPanelOwner && !operationLease) {
    return {
      outcome: "invalid-target",
      added: false,
      location: null,
      locationEnriched: false,
    };
  }

  const selectedText = normalizeSelectedText(input.selectedText || "");
  const status = input.body.querySelector("#llm-status") as HTMLElement | null;
  if (!selectedText) {
    if (status) {
      setStatus(status, t("Select text in the reader first"), "warning");
    }
    input.log?.("LLM addText: no text selected");
    return {
      outcome: "no-selection",
      added: false,
      location: null,
      locationEnriched: false,
    };
  }

  const directLocation =
    input.initialLocation ||
    (input.reader
      ? dependencies.getCurrentLocation(input.reader, selectedText)
      : null);
  const initialLocation: SelectedTextPageLocation | null = directLocation
    ? {
        contextItemId:
          directLocation.contextItemId || readerContextItemId || undefined,
        pageIndex: directLocation.pageIndex,
        pageLabel: directLocation.pageLabel,
      }
    : readerContextItemId
      ? { contextItemId: readerContextItemId }
      : null;

  const added = appendSelectedTextContextForItem(
    conversationKey,
    selectedText,
    "pdf",
    input.paperContext,
    initialLocation,
  );
  if (!added) {
    if (status) {
      setStatus(status, t("Text Context up to 5"), "error");
    }
    input.log?.("LLM addText: selected text was not added");
    return {
      outcome: "not-added",
      added: false,
      location: initialLocation,
      locationEnriched: false,
    };
  }

  // Commit and repaint before any asynchronous locator work so both entry
  // points provide the same immediate feedback.
  refreshSelectedTextPanels(input.body, conversationKey);
  if (status) {
    setStatus(status, t("Selected text included"), "ready");
  }
  const inputEl = input.body.querySelector(
    "#llm-input",
  ) as HTMLTextAreaElement | null;
  inputEl?.focus({ preventScroll: true });

  if (hasPageLocation(initialLocation) || !input.reader) {
    return {
      outcome: "added",
      added: true,
      location: initialLocation,
      locationEnriched: false,
    };
  }

  try {
    const resolvedLocation = await dependencies.resolveLocation(
      input.reader,
      selectedText,
    );
    if (
      (operationLease && !isPanelOperationLeaseCurrent(operationLease)) ||
      (targetItem &&
        !requireCurrentPanelOwnership(
          input.body,
          targetItem,
          "add-reader-text-location",
        ))
    ) {
      return {
        outcome: "added",
        added: true,
        location: initialLocation,
        locationEnriched: false,
      };
    }
    if (!resolvedLocation) {
      return {
        outcome: "added",
        added: true,
        location: initialLocation,
        locationEnriched: false,
      };
    }
    const updated = updateSelectedTextContextLocationForItem(
      conversationKey,
      selectedText,
      "pdf",
      input.paperContext,
      resolvedLocation,
    );
    if (updated) {
      refreshSelectedTextPanels(input.body, conversationKey);
    }
    return {
      outcome: "added",
      added: true,
      location: updated ? resolvedLocation : initialLocation,
      locationEnriched: updated,
    };
  } catch (error) {
    input.log?.("LLM addText: page-location enrichment failed", error);
    return {
      outcome: "added",
      added: true,
      location: initialLocation,
      locationEnriched: false,
    };
  }
}
