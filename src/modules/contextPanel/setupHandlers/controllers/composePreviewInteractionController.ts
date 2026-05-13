import { t } from "../../../../utils/i18n";
import {
  getActiveContextAttachmentFromTabs,
  getActiveReaderForSelectedTab,
  getSelectedTextContextEntries,
  getSelectedTextContexts,
  getSelectedTextExpandedIndex,
  isNoteContextExpanded,
  refreshActiveNoteChipPreview,
  refreshNoteChipPreview,
  setNoteContextExpanded,
  setSelectedTextContextEntries,
  setSelectedTextExpandedIndex,
  formatSelectedTextContextPageLabel,
} from "../../contextResolution";
import {
  flashPageInLivePdfReader,
  scrollToExactQuoteInReader,
} from "../../livePdfSelectionLocator";
import {
  isManagedBlobPath,
  removeAttachmentFile,
} from "../../attachmentStorage";
import { buildPaperKey } from "../../pdfContext";
import {
  getNextContentSourceMode,
  clearSelectedPaperState,
  isPaperContextFullTextMode,
  setPaperContentSourceOverride,
  setPaperModeOverride,
} from "../../contexts/paperContextState";
import {
  paperContextModeOverrides,
  pinnedFileKeys,
  pinnedImageKeys,
  pinnedSelectedTextKeys,
  selectedCollectionContextCache,
  selectedFileAttachmentCache,
  selectedFilePreviewExpandedCache,
  selectedImageCache,
  selectedImagePreviewActiveIndexCache,
  selectedImagePreviewExpandedCache,
  selectedOtherRefContextCache,
  selectedPaperContextCache,
  selectedPaperPreviewExpandedCache,
} from "../../state";
import type {
  PaperContentSourceMode,
  PaperContextRef,
  SelectedTextContext,
} from "../../types";
import { FULL_PDF_UNSUPPORTED_MESSAGE } from "../../pdfSupportMessages";
import { getModelPdfSupport } from "./modelReasoningController";
import {
  removePinnedSelectedText,
  togglePinnedFile,
  togglePinnedImage,
  togglePinnedSelectedText,
} from "./pinnedContextController";

type StatusLevel = "ready" | "warning" | "error";

type ComposePreviewInteractionControllerDeps = {
  body: Element;
  imagePreview: HTMLDivElement | null;
  selectedContextList: HTMLDivElement | null;
  previewMeta: HTMLButtonElement | null;
  removeImgBtn: HTMLButtonElement | null;
  filePreview: HTMLDivElement | null;
  filePreviewMeta: HTMLButtonElement | null;
  filePreviewClear: HTMLButtonElement | null;
  filePreviewList: HTMLDivElement | null;
  previewStrip: HTMLDivElement | null;
  paperPreview: HTMLDivElement | null;
  getItem: () => Zotero.Item | null;
  getTextContextConversationKey: () => number | null;
  resolveAutoLoadedPaperContext: () => PaperContextRef | null;
  getManualPaperContextsForItem: (
    itemId: number,
    autoLoadedPaperContext: PaperContextRef | null,
  ) => PaperContextRef[];
  resolvePaperContentSourceMode: (
    itemId: number,
    paperContext: PaperContextRef,
  ) => PaperContentSourceMode;
  resolvePaperContextNextSendMode: (
    itemId: number,
    paperContext: PaperContextRef,
  ) => string;
  isPaperContextMineru: (paperContext: PaperContextRef) => boolean;
  isWebChatMode: () => boolean;
  getCurrentRuntimeMode: () => string;
  getSelectedProfile: () => {
    model?: string;
    providerProtocol?: string;
    authMode?: string;
    apiBase?: string;
  } | null;
  getSelectedModelInfo: () => { currentModel: string };
  resolveCurrentPaperBaseItem: () => Zotero.Item | null;
  clearSelectedImageState: (itemId: number) => void;
  clearSelectedFileState: (itemId: number) => void;
  closePaperChipMenu: () => void;
  resolvePaperContextFromChipElement: (
    chip: HTMLElement,
  ) => PaperContextRef | null;
  focusPaperContextInActiveTab: (
    paperContext: PaperContextRef,
  ) => Promise<boolean>;
  updatePaperPreviewPreservingScroll: () => void;
  updateFilePreviewPreservingScroll: () => void;
  updateImagePreviewPreservingScroll: () => void;
  updateSelectedTextPreviewPreservingScroll: () => void;
  scheduleAttachmentGc: () => void;
  setStatusMessage?: (message: string, level: StatusLevel) => void;
  logError: (message: string, error?: unknown) => void;
};

const asFinitePositiveItemId = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
};

export function attachComposePreviewInteractionController(
  deps: ComposePreviewInteractionControllerDeps,
): void {
  const {
    body,
    imagePreview,
    selectedContextList,
    previewMeta,
    removeImgBtn,
    filePreview,
    filePreviewMeta,
    filePreviewClear,
    filePreviewList,
    previewStrip,
    paperPreview,
  } = deps;

  const getItem = () => deps.getItem();
  const setStatus = (message: string, level: StatusLevel) => {
    deps.setStatusMessage?.(message, level);
  };

  const collapseOtherPreviewPanels = (itemId: number): void => {
    const textContextKey = deps.getTextContextConversationKey();
    if (textContextKey) {
      setSelectedTextExpandedIndex(textContextKey, null);
      setNoteContextExpanded(textContextKey, null);
    }
    selectedImagePreviewExpandedCache.set(itemId, false);
    selectedPaperPreviewExpandedCache.set(itemId, false);
    selectedFilePreviewExpandedCache.set(itemId, false);
  };

  if (previewMeta) {
    previewMeta.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = getItem();
      if (!item) return;
      const selectedImages = selectedImageCache.get(item.id) || [];
      if (!selectedImages.length) return;
      const expanded = selectedImagePreviewExpandedCache.get(item.id) === true;
      const nextExpanded = !expanded;
      selectedImagePreviewExpandedCache.set(item.id, nextExpanded);
      if (nextExpanded) {
        selectedImagePreviewActiveIndexCache.set(item.id, 0);
        const textContextKey = deps.getTextContextConversationKey();
        if (textContextKey) {
          setSelectedTextExpandedIndex(textContextKey, null);
          setNoteContextExpanded(textContextKey, null);
        }
        selectedPaperPreviewExpandedCache.set(item.id, false);
        selectedFilePreviewExpandedCache.set(item.id, false);
        selectedImagePreviewExpandedCache.set(item.id, true);
      }
      deps.updatePaperPreviewPreservingScroll();
      deps.updateFilePreviewPreservingScroll();
      deps.updateSelectedTextPreviewPreservingScroll();
      deps.updateImagePreviewPreservingScroll();
    });
  }

  if (removeImgBtn) {
    removeImgBtn.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = getItem();
      if (!item) return;
      deps.clearSelectedImageState(item.id);
      deps.updateImagePreviewPreservingScroll();
      setStatus(t("Figures cleared"), "ready");
    });
  }

  if (filePreviewMeta) {
    filePreviewMeta.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = getItem();
      if (!item) return;
      const selectedFiles = selectedFileAttachmentCache.get(item.id) || [];
      if (!selectedFiles.length) return;
      const expanded = selectedFilePreviewExpandedCache.get(item.id) === true;
      const nextExpanded = !expanded;
      selectedFilePreviewExpandedCache.set(item.id, nextExpanded);
      if (nextExpanded) {
        collapseOtherPreviewPanels(item.id);
        selectedFilePreviewExpandedCache.set(item.id, true);
      }
      deps.updatePaperPreviewPreservingScroll();
      deps.updateSelectedTextPreviewPreservingScroll();
      deps.updateImagePreviewPreservingScroll();
      deps.updateFilePreviewPreservingScroll();
    });
  }

  if (filePreviewClear) {
    filePreviewClear.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = getItem();
      if (!item) return;
      const selectedFiles = selectedFileAttachmentCache.get(item.id) || [];
      for (const entry of selectedFiles) {
        if (!entry?.storedPath) continue;
        if (entry.contentHash || isManagedBlobPath(entry.storedPath)) continue;
        void removeAttachmentFile(entry.storedPath).catch((error) => {
          deps.logError("LLM: Failed to remove cleared attachment file", error);
        });
      }
      deps.clearSelectedFileState(item.id);
      deps.updateFilePreviewPreservingScroll();
      deps.scheduleAttachmentGc();
      setStatus(t("Files cleared"), "ready");
    });
  }

  if (filePreviewList) {
    filePreviewList.addEventListener("contextmenu", (event: Event) => {
      const item = getItem();
      if (!item) return;
      const target = event.target as Element | null;
      if (!target) return;
      const row = target.closest(
        ".llm-file-context-item",
      ) as HTMLDivElement | null;
      if (!row || !filePreviewList.contains(row)) return;
      const index = Number.parseInt(row.dataset.fileContextIndex || "", 10);
      const selectedFiles = selectedFileAttachmentCache.get(item.id) || [];
      if (
        !Number.isFinite(index) ||
        index < 0 ||
        index >= selectedFiles.length
      ) {
        return;
      }
      const targetFile = selectedFiles[index];
      if (!targetFile) return;
      event.preventDefault();
      event.stopPropagation();
      const nextPinned = togglePinnedFile(pinnedFileKeys, item.id, targetFile);
      deps.updateFilePreviewPreservingScroll();
      setStatus(
        nextPinned ? t("File pinned for next sends") : t("File unpinned"),
        "ready",
      );
    });
  }

  if (previewStrip) {
    previewStrip.addEventListener("contextmenu", (event: Event) => {
      const item = getItem();
      if (!item) return;
      const target = event.target as Element | null;
      if (!target) return;
      const thumbItem = target.closest(
        ".llm-preview-item",
      ) as HTMLDivElement | null;
      if (!thumbItem || !previewStrip.contains(thumbItem)) return;
      const index = Number.parseInt(
        thumbItem.dataset.imageContextIndex || "",
        10,
      );
      const selectedImages = selectedImageCache.get(item.id) || [];
      if (
        !Number.isFinite(index) ||
        index < 0 ||
        index >= selectedImages.length
      ) {
        return;
      }
      const targetImage = selectedImages[index];
      if (!targetImage) return;
      event.preventDefault();
      event.stopPropagation();
      const nextPinned = togglePinnedImage(
        pinnedImageKeys,
        item.id,
        targetImage,
      );
      deps.updateImagePreviewPreservingScroll();
      setStatus(
        nextPinned
          ? t("Screenshot pinned for next sends")
          : t("Screenshot unpinned"),
        "ready",
      );
    });
  }

  if (paperPreview) {
    paperPreview.addEventListener("click", (event: Event) => {
      const item = getItem();
      if (!item) return;
      const target = event.target as Element | null;
      if (!target) return;

      const otherClearBtn = target.closest(
        ".llm-other-ref-clear",
      ) as HTMLButtonElement | null;
      if (otherClearBtn) {
        event.preventDefault();
        event.stopPropagation();
        const index = Number.parseInt(
          otherClearBtn.dataset.otherRefIndex || "",
          10,
        );
        const others = selectedOtherRefContextCache.get(item.id) || [];
        if (Number.isFinite(index) && index >= 0 && index < others.length) {
          const next = others.filter((_, itemIndex) => itemIndex !== index);
          if (next.length) {
            selectedOtherRefContextCache.set(item.id, next);
          } else {
            selectedOtherRefContextCache.delete(item.id);
          }
          deps.updatePaperPreviewPreservingScroll();
          setStatus(`File context removed (${next.length})`, "ready");
        }
        return;
      }

      const collectionClearBtn = target.closest(
        ".llm-collection-clear",
      ) as HTMLButtonElement | null;
      if (collectionClearBtn) {
        event.preventDefault();
        event.stopPropagation();
        const index = Number.parseInt(
          collectionClearBtn.dataset.collectionIndex || "",
          10,
        );
        const collections = selectedCollectionContextCache.get(item.id) || [];
        if (
          Number.isFinite(index) &&
          index >= 0 &&
          index < collections.length
        ) {
          const next = collections.filter(
            (_, itemIndex) => itemIndex !== index,
          );
          if (next.length) {
            selectedCollectionContextCache.set(item.id, next);
          } else {
            selectedCollectionContextCache.delete(item.id);
          }
          deps.updatePaperPreviewPreservingScroll();
          setStatus(t("Collection context removed."), "ready");
        }
        return;
      }

      const clearBtn = target.closest(
        ".llm-paper-context-clear",
      ) as HTMLButtonElement | null;
      if (!clearBtn) return;
      event.preventDefault();
      event.stopPropagation();
      const index = Number.parseInt(
        clearBtn.dataset.paperContextIndex || "",
        10,
      );
      const selectedPapers = deps.getManualPaperContextsForItem(
        item.id,
        deps.resolveAutoLoadedPaperContext(),
      );
      if (
        !Number.isFinite(index) ||
        index < 0 ||
        index >= selectedPapers.length
      ) {
        return;
      }
      const removedPaper = selectedPapers[index];
      if (removedPaper) {
        paperContextModeOverrides.delete(
          `${item.id}:${buildPaperKey(removedPaper)}`,
        );
      }
      const nextPapers = selectedPapers.filter(
        (_, itemIndex) => itemIndex !== index,
      );
      if (nextPapers.length) {
        selectedPaperContextCache.set(item.id, nextPapers);
      } else {
        clearSelectedPaperState(item.id);
      }
      deps.updatePaperPreviewPreservingScroll();
      setStatus(`Paper context removed (${nextPapers.length})`, "ready");
      deps.closePaperChipMenu();
    });

    paperPreview.addEventListener("contextmenu", (event: Event) => {
      const item = getItem();
      if (!item) return;
      const target = event.target as Element | null;
      if (!target) return;
      const paperChip = target.closest(
        ".llm-paper-context-chip",
      ) as HTMLDivElement | null;
      if (!paperChip || !paperPreview.contains(paperChip)) return;
      if (target.closest(".llm-paper-context-clear")) return;
      const paperContext = deps.resolvePaperContextFromChipElement(paperChip);
      if (!paperContext) return;
      event.preventDefault();
      event.stopPropagation();
      const contentSource = deps.resolvePaperContentSourceMode(
        item.id,
        paperContext,
      );
      if (contentSource === "pdf" && !deps.isWebChatMode()) {
        setStatus(
          t(
            "PDF mode always sends the full file. Switch to Text/MinerU for retrieval mode.",
          ),
          "warning",
        );
        return;
      }
      const currentMode = deps.resolvePaperContextNextSendMode(
        item.id,
        paperContext,
      );
      const nextMode = isPaperContextFullTextMode(currentMode as any)
        ? "retrieval"
        : "full-sticky";
      setPaperModeOverride(item.id, paperContext, nextMode as any);
      const nextIsFullText = isPaperContextFullTextMode(nextMode as any);
      paperChip.dataset.fullText = nextIsFullText ? "true" : "false";
      paperChip.classList.toggle("llm-paper-context-chip-full", nextIsFullText);
      if (contentSource === "pdf") {
        paperChip.classList.toggle(
          "llm-paper-context-chip-pdf",
          nextIsFullText,
        );
      }
      deps.closePaperChipMenu();
      if (deps.isWebChatMode() && contentSource === "pdf") {
        setStatus(
          nextIsFullText
            ? t(
                "WebChat only requires uploading PDF once per session. If already uploaded, no need to send again.",
              )
            : t("Next query will not attach PDF."),
          "ready",
        );
        return;
      }
      const sourceTag = contentSource === "mineru" ? ` ${t("(MinerU)")}` : "";
      setStatus(
        nextMode === "full-sticky"
          ? `${t("Paper set to always send full text.")}${sourceTag}`
          : `${t("Paper set to retrieval mode.")}${sourceTag}`,
        "ready",
      );
    });

    paperPreview.addEventListener("click", (event: Event) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (target.closest(".llm-paper-context-clear")) return;

      const cardRow = target.closest(
        ".llm-paper-chip-menu-row",
      ) as HTMLButtonElement | null;
      if (cardRow) {
        const paperChipForCard = cardRow.closest(
          ".llm-paper-context-chip",
        ) as HTMLDivElement | null;
        if (!paperChipForCard || !paperPreview.contains(paperChipForCard))
          return;
        event.preventDefault();
        event.stopPropagation();
        const paperContextForCard =
          deps.resolvePaperContextFromChipElement(paperChipForCard);
        if (!paperContextForCard) return;
        void deps
          .focusPaperContextInActiveTab(paperContextForCard)
          .then((focused) => {
            if (!focused) setStatus(t("Could not focus this paper"), "error");
          })
          .catch((error) => {
            deps.logError(
              "LLM: Failed to focus paper context from card",
              error,
            );
            setStatus(t("Could not focus this paper"), "error");
          });
        return;
      }

      const item = getItem();
      const paperChip = target.closest(
        ".llm-paper-context-chip",
      ) as HTMLDivElement | null;
      if (!paperChip || !paperPreview.contains(paperChip)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!item) return;
      const paperContext = deps.resolvePaperContextFromChipElement(paperChip);
      if (!paperContext) return;
      const mouse = event as MouseEvent;
      if (mouse.metaKey || mouse.ctrlKey) {
        void openPaperContextInReader(paperContext);
        return;
      }
      if (deps.isWebChatMode()) {
        setStatus(
          t("WebChat mode always uses PDF. Right-click to toggle send/skip."),
          "ready",
        );
        return;
      }
      const currentSource = deps.resolvePaperContentSourceMode(
        item.id,
        paperContext,
      );
      const mineruAvailable = deps.isPaperContextMineru(paperContext);
      const nextSource = getNextContentSourceMode(
        currentSource,
        mineruAvailable,
      );
      if (nextSource === "pdf" && deps.getCurrentRuntimeMode() === "agent") {
        setStatus(
          t(
            "Agent mode normally reads PDF pages on demand. Forcing full PDF mode.",
          ),
          "warning",
        );
      }
      if (nextSource === "pdf") {
        const selectedProfile = deps.getSelectedProfile();
        const modelName = (
          selectedProfile?.model ||
          deps.getSelectedModelInfo().currentModel ||
          ""
        ).trim();
        const pdfSupport = getModelPdfSupport(
          modelName,
          selectedProfile?.providerProtocol,
          selectedProfile?.authMode,
          selectedProfile?.apiBase,
        );
        if (pdfSupport !== "native") {
          setStatus(t(FULL_PDF_UNSUPPORTED_MESSAGE), "error");
          return;
        }
      }
      setPaperContentSourceOverride(item.id, paperContext, nextSource);
      deps.updatePaperPreviewPreservingScroll();
      const modeLabel =
        nextSource === "text"
          ? "Text"
          : nextSource === "mineru"
            ? "MinerU"
            : "PDF";
      if (nextSource === "pdf") {
        setStatus(
          `${t("Content source:")} ${modeLabel}. ${t("Full file will be sent. Right-click retrieval is not available.")}`,
          "ready",
        );
      } else {
        setStatus(`${t("Content source:")} ${modeLabel}`, "ready");
      }
    });
  }

  const openPaperContextInReader = async (
    paperContext: PaperContextRef,
  ): Promise<void> => {
    try {
      const tabs = (
        Zotero as unknown as {
          Tabs?: {
            getTabIDByItemID?: (itemID: number) => string;
            select?: (id: string) => void;
          };
        }
      ).Tabs;
      const existingTabId = tabs?.getTabIDByItemID?.(
        paperContext.contextItemId,
      );
      if (existingTabId && typeof tabs?.select === "function") {
        tabs.select(existingTabId);
        return;
      }
      const readerApi = Zotero.Reader as
        | { open?: (itemID: number) => Promise<unknown> }
        | undefined;
      if (typeof readerApi?.open === "function") {
        await readerApi.open(paperContext.contextItemId);
      } else {
        setStatus(t("Could not open PDF"), "error");
      }
    } catch (error) {
      deps.logError("LLM: Failed to open PDF from chip", error);
      setStatus(t("Could not open PDF"), "error");
    }
  };

  const resolveSelectedContextTargetItemId = (
    selectedContext: SelectedTextContext,
  ): number | null => {
    const explicitContextItemId = asFinitePositiveItemId(
      selectedContext.contextItemId,
    );
    if (explicitContextItemId) return explicitContextItemId;

    const paperContextItemId = asFinitePositiveItemId(
      selectedContext.paperContext?.contextItemId,
    );
    if (paperContextItemId) return paperContextItemId;

    const activeContextItem = getActiveContextAttachmentFromTabs();
    const activeContextItemId = asFinitePositiveItemId(activeContextItem?.id);
    if (activeContextItemId) return activeContextItemId;

    const currentItem = getItem();
    const currentPanelItemId = asFinitePositiveItemId(
      currentItem?.isAttachment?.() &&
        currentItem.attachmentContentType === "application/pdf"
        ? currentItem.id
        : 0,
    );
    if (currentPanelItemId) return currentPanelItemId;

    const basePaper = deps.resolveCurrentPaperBaseItem();
    if (!basePaper) return null;
    const attachments = basePaper.getAttachments?.() || [];
    for (const attachmentId of attachments) {
      const attachment = Zotero.Items.get(attachmentId) || null;
      if (attachment?.attachmentContentType === "application/pdf") {
        return attachment.id;
      }
    }
    return null;
  };

  const navigateSelectedTextContextToPage = async (
    selectedContext: SelectedTextContext,
  ): Promise<boolean> => {
    const rawPageIndex = Number(selectedContext.pageIndex);
    if (!Number.isFinite(rawPageIndex) || rawPageIndex < 0) return false;
    const pageIndex = Math.floor(rawPageIndex);
    const pageLabel = selectedContext.pageLabel || `${pageIndex + 1}`;
    const targetItemId = resolveSelectedContextTargetItemId(selectedContext);
    if (!targetItemId) return false;

    const location = { pageIndex, pageLabel };
    const activeReader = getActiveReaderForSelectedTab();
    const activeReaderItemId = Number(
      activeReader?._item?.id || activeReader?.itemID || 0,
    );
    if (
      Number.isFinite(activeReaderItemId) &&
      activeReaderItemId === targetItemId &&
      typeof activeReader?.navigate === "function"
    ) {
      await activeReader.navigate(location);
      if (selectedContext.text) {
        try {
          await scrollToExactQuoteInReader(activeReader, selectedContext.text);
        } catch {
          await flashPageInLivePdfReader(activeReader, pageIndex);
        }
      } else {
        await flashPageInLivePdfReader(activeReader, pageIndex);
      }
      return true;
    }

    const readerApi = Zotero.Reader as
      | {
          open?: (
            itemID: number,
            location?: _ZoteroTypes.Reader.Location,
          ) => Promise<void | _ZoteroTypes.ReaderInstance>;
        }
      | undefined;
    if (typeof readerApi?.open === "function") {
      const openedReader = await readerApi.open(targetItemId, location);
      const nextReader =
        openedReader ||
        ((
          Zotero.Reader as
            | {
                getByTabID?: (
                  tabID: string | number,
                ) => _ZoteroTypes.ReaderInstance;
              }
            | undefined
        )?.getByTabID &&
          (() => {
            const tabs = (
              Zotero as unknown as {
                Tabs?: { selectedID?: string | number | null };
              }
            ).Tabs;
            const selectedTabId = tabs?.selectedID;
            return selectedTabId !== undefined && selectedTabId !== null
              ? Zotero.Reader.getByTabID?.(`${selectedTabId}`) || null
              : null;
          })()) ||
        getActiveReaderForSelectedTab();
      if (nextReader) {
        if (selectedContext.text) {
          try {
            await scrollToExactQuoteInReader(nextReader, selectedContext.text);
          } catch {
            await flashPageInLivePdfReader(nextReader, pageIndex);
          }
        } else {
          await flashPageInLivePdfReader(nextReader, pageIndex);
        }
      }
      return true;
    }

    const pane = Zotero.getActiveZoteroPane?.() as
      | {
          viewPDF?: (
            itemID: number,
            location: _ZoteroTypes.Reader.Location,
          ) => Promise<void>;
        }
      | undefined;
    if (typeof pane?.viewPDF === "function") {
      await pane.viewPDF(targetItemId, location);
      const nextReader = getActiveReaderForSelectedTab();
      if (nextReader) {
        if (selectedContext.text) {
          try {
            await scrollToExactQuoteInReader(nextReader, selectedContext.text);
          } catch {
            await flashPageInLivePdfReader(nextReader, pageIndex);
          }
        } else {
          await flashPageInLivePdfReader(nextReader, pageIndex);
        }
      }
      return true;
    }

    return false;
  };

  if (selectedContextList) {
    selectedContextList.addEventListener("mouseover", (event: Event) => {
      const target = event.target as Element | null;
      const noteChip = target?.closest(
        "[data-note-chip='true']",
      ) as HTMLDivElement | null;
      if (!noteChip) return;
      if (noteChip.dataset.noteChipKind === "active") {
        refreshActiveNoteChipPreview(body);
      } else {
        refreshNoteChipPreview(noteChip);
      }
    });

    selectedContextList.addEventListener("focusin", (event: Event) => {
      const target = event.target as Element | null;
      const noteChip = target?.closest(
        "[data-note-chip='true']",
      ) as HTMLDivElement | null;
      if (!noteChip) return;
      if (noteChip.dataset.noteChipKind === "active") {
        refreshActiveNoteChipPreview(body);
      } else {
        refreshNoteChipPreview(noteChip);
      }
    });

    selectedContextList.addEventListener("click", (event: Event) => {
      const item = getItem();
      if (!item) return;
      const target = event.target as Element | null;
      if (!target) return;
      const noteChip = target.closest(
        "[data-note-chip='true']",
      ) as HTMLDivElement | null;
      const noteChipKind = noteChip?.dataset.noteChipKind || "";
      const noteMetaBtn = target.closest(
        ".llm-note-context-meta",
      ) as HTMLButtonElement | null;
      if (noteMetaBtn && noteChipKind === "active") {
        event.preventDefault();
        event.stopPropagation();
        const textContextKey = deps.getTextContextConversationKey();
        if (!textContextKey) return;
        refreshActiveNoteChipPreview(body);
        const nextExpanded = !isNoteContextExpanded(textContextKey);
        setNoteContextExpanded(textContextKey, nextExpanded);
        if (nextExpanded) {
          setSelectedTextExpandedIndex(textContextKey, null);
          selectedImagePreviewExpandedCache.set(item.id, false);
          selectedPaperPreviewExpandedCache.set(item.id, false);
          selectedFilePreviewExpandedCache.set(item.id, false);
        }
        deps.updatePaperPreviewPreservingScroll();
        deps.updateFilePreviewPreservingScroll();
        deps.updateImagePreviewPreservingScroll();
        deps.updateSelectedTextPreviewPreservingScroll();
        return;
      }
      if (noteChip && noteChipKind === "active") return;

      const clearBtn = target.closest(
        ".llm-selected-context-clear",
      ) as HTMLButtonElement | null;
      if (clearBtn) {
        event.preventDefault();
        event.stopPropagation();
        const textContextKey = deps.getTextContextConversationKey();
        if (!textContextKey) return;
        const index = Number.parseInt(clearBtn.dataset.contextIndex || "", 10);
        const selectedContexts = getSelectedTextContextEntries(textContextKey);
        if (
          !Number.isFinite(index) ||
          index < 0 ||
          index >= selectedContexts.length
        ) {
          return;
        }
        removePinnedSelectedText(
          pinnedSelectedTextKeys,
          textContextKey,
          selectedContexts[index],
        );
        const nextContexts = selectedContexts.filter(
          (_, itemIndex) => itemIndex !== index,
        );
        setSelectedTextContextEntries(textContextKey, nextContexts);
        setSelectedTextExpandedIndex(textContextKey, null);
        deps.updateSelectedTextPreviewPreservingScroll();
        setStatus(t("Selected text removed"), "ready");
        return;
      }

      const metaBtn = target.closest(
        ".llm-selected-context-meta",
      ) as HTMLButtonElement | null;
      if (!metaBtn) return;
      event.preventDefault();
      event.stopPropagation();
      const textContextKey = deps.getTextContextConversationKey();
      if (!textContextKey) return;
      const index = Number.parseInt(metaBtn.dataset.contextIndex || "", 10);
      const selectedContexts = getSelectedTextContextEntries(textContextKey);
      if (
        !Number.isFinite(index) ||
        index < 0 ||
        index >= selectedContexts.length
      ) {
        return;
      }
      const targetContext = selectedContexts[index];
      const isJumpablePdfContext =
        targetContext?.source === "pdf" &&
        Number.isFinite(targetContext.pageIndex) &&
        (targetContext.pageIndex as number) >= 0;
      if (isJumpablePdfContext) {
        void navigateSelectedTextContextToPage(targetContext)
          .then((navigated) => {
            if (navigated) {
              setStatus(
                `Jumped to ${formatSelectedTextContextPageLabel(targetContext) || "page"}`,
                "ready",
              );
              return;
            }
            setStatus("Could not open the page for this text context", "error");
          })
          .catch((error) => {
            deps.logError(
              "LLM: Failed to navigate selected text context",
              error,
            );
            setStatus("Could not open the page for this text context", "error");
          });
        return;
      }
      const expandedIndex = getSelectedTextExpandedIndex(
        textContextKey,
        selectedContexts.length,
      );
      const nextExpandedIndex = expandedIndex === index ? null : index;
      setSelectedTextExpandedIndex(textContextKey, nextExpandedIndex);
      if (nextExpandedIndex !== null) {
        setNoteContextExpanded(textContextKey, null);
        selectedImagePreviewExpandedCache.set(item.id, false);
        selectedPaperPreviewExpandedCache.set(item.id, false);
        selectedFilePreviewExpandedCache.set(item.id, false);
      }
      deps.updatePaperPreviewPreservingScroll();
      deps.updateFilePreviewPreservingScroll();
      deps.updateImagePreviewPreservingScroll();
      deps.updateSelectedTextPreviewPreservingScroll();
    });

    selectedContextList.addEventListener("contextmenu", (event: Event) => {
      const item = getItem();
      if (!item) return;
      const target = event.target as Element | null;
      if (!target) return;
      const noteChip = target.closest(
        "[data-note-chip='true']",
      ) as HTMLDivElement | null;
      if (noteChip?.dataset.noteChipKind === "active") {
        event.preventDefault();
        event.stopPropagation();
        setStatus(t("Live note preview is pinned while editing"), "ready");
        return;
      }
      const selectedContext = target.closest(
        ".llm-selected-context",
      ) as HTMLDivElement | null;
      if (!selectedContext || !selectedContextList.contains(selectedContext)) {
        return;
      }
      const textContextKey = deps.getTextContextConversationKey();
      if (!textContextKey) return;
      const index = Number.parseInt(
        selectedContext.dataset.contextIndex || "",
        10,
      );
      const selectedContexts = getSelectedTextContextEntries(textContextKey);
      if (
        !Number.isFinite(index) ||
        index < 0 ||
        index >= selectedContexts.length
      ) {
        return;
      }
      if (selectedContexts[index]?.source === "note-edit") {
        event.preventDefault();
        event.stopPropagation();
        setStatus(t("Editing focus syncs to the live note selection"), "ready");
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const nextPinned = togglePinnedSelectedText(
        pinnedSelectedTextKeys,
        textContextKey,
        selectedContexts[index],
      );
      deps.updateSelectedTextPreviewPreservingScroll();
      setStatus(
        nextPinned
          ? t("Text context pinned for next sends")
          : t("Text context unpinned"),
        "ready",
      );
    });
  }

  const bodyWithPinnedDismiss = body as Element & {
    __llmPinnedContextDismissHandler?: (event: MouseEvent) => void;
  };
  if (bodyWithPinnedDismiss.__llmPinnedContextDismissHandler) {
    body.removeEventListener(
      "mousedown",
      bodyWithPinnedDismiss.__llmPinnedContextDismissHandler,
      true,
    );
  }
  const dismissPinnedContextPanels = (event: MouseEvent) => {
    if (event.button !== 0) return;
    const item = getItem();
    if (!item) return;
    const target = event.target as Node | null;
    const clickedInsideTextPanel = Boolean(
      selectedContextList && target && selectedContextList.contains(target),
    );
    const clickedInsideFigurePanel = Boolean(
      imagePreview && target && imagePreview.contains(target),
    );
    const clickedInsideFilePanel = Boolean(
      filePreview && target && filePreview.contains(target),
    );
    const clickedInsidePaperPanel = Boolean(
      paperPreview && target && paperPreview.contains(target),
    );
    if (
      clickedInsideTextPanel ||
      clickedInsideFigurePanel ||
      clickedInsideFilePanel ||
      clickedInsidePaperPanel
    ) {
      return;
    }

    const textContextKey = deps.getTextContextConversationKey();
    if (!textContextKey) return;
    const textPinned =
      getSelectedTextExpandedIndex(
        textContextKey,
        getSelectedTextContexts(textContextKey).length,
      ) >= 0;
    const notePinned = isNoteContextExpanded(textContextKey);
    const figurePinned =
      selectedImagePreviewExpandedCache.get(item.id) === true;
    const paperPinned =
      typeof selectedPaperPreviewExpandedCache.get(item.id) === "number";
    const filePinned = selectedFilePreviewExpandedCache.get(item.id) === true;
    if (
      !textPinned &&
      !notePinned &&
      !figurePinned &&
      !paperPinned &&
      !filePinned
    ) {
      return;
    }

    setSelectedTextExpandedIndex(textContextKey, null);
    setNoteContextExpanded(textContextKey, null);
    selectedImagePreviewExpandedCache.set(item.id, false);
    selectedPaperPreviewExpandedCache.set(item.id, false);
    selectedFilePreviewExpandedCache.set(item.id, false);
    deps.updatePaperPreviewPreservingScroll();
    deps.updateFilePreviewPreservingScroll();
    deps.updateSelectedTextPreviewPreservingScroll();
    deps.updateImagePreviewPreservingScroll();
  };
  body.addEventListener("mousedown", dismissPinnedContextPanels, true);
  bodyWithPinnedDismiss.__llmPinnedContextDismissHandler =
    dismissPinnedContextPanels;
}
