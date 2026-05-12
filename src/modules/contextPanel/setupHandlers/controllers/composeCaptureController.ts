import { t } from "../../../../utils/i18n";
import { MAX_SELECTED_IMAGES } from "../../constants";
import {
  activeContextPanels,
  selectedImageCache,
  selectedImagePreviewActiveIndexCache,
  selectedImagePreviewExpandedCache,
} from "../../state";
import {
  appendSelectedTextContextForItem,
  applySelectedTextPreview,
  getActiveContextAttachmentFromTabs,
  getActiveReaderForSelectedTab,
  getActiveReaderSelectionText,
} from "../../contextResolution";
import { resolvePaperContextRefFromAttachment } from "../../paperAttribution";
import { resolveCurrentSelectionPageLocationFromReader } from "../../livePdfSelectionLocator";
import {
  captureScreenshotSelection,
  optimizeImageDataUrl,
} from "../../screenshot";
import { captureCurrentPdfPage } from "../../pdfPageCapture";
import {
  getScreenshotDisabledHint,
  isScreenshotUnsupportedModel,
} from "./modelReasoningController";
import {
  isFloatingMenuOpen,
  MODEL_MENU_OPEN_CLASS,
  REASONING_MENU_OPEN_CLASS,
  RETRY_MODEL_MENU_OPEN_CLASS,
  setFloatingMenuOpen,
} from "./menuController";

type StatusLevel = "ready" | "warning" | "error" | "sending";
type ActiveAtToken = { slashStart: number; caretEnd: number } | null;

type ComposeCaptureControllerDeps = {
  body: Element;
  inputBox: HTMLTextAreaElement;
  screenshotBtn: HTMLButtonElement | null;
  uploadBtn: HTMLButtonElement | null;
  uploadInput: HTMLInputElement | null;
  slashMenu: HTMLDivElement | null;
  slashUploadOption: HTMLButtonElement | null;
  slashReferenceOption: HTMLButtonElement | null;
  slashPdfPageOption: HTMLButtonElement | null;
  slashPdfMultiplePagesOption: HTMLButtonElement | null;
  modelMenu: HTMLDivElement | null;
  reasoningMenu: HTMLDivElement | null;
  retryModelMenu: HTMLDivElement | null;
  getItem: () => Zotero.Item | null;
  getConversationKey: (item: Zotero.Item) => number;
  getSelectedModelInfo: () => { currentModel: string };
  getActiveAtToken: () => ActiveAtToken;
  consumeActiveActionToken: () => boolean;
  persistDraftInputForCurrentConversation: () => void;
  processIncomingFiles: (files: File[]) => Promise<void>;
  renderDynamicSlashMenuSections: () => void;
  openSlashMenuWithSelection: () => void;
  closeSlashMenu: () => void;
  closeHistoryNewMenu: () => void;
  closeHistoryMenu: () => void;
  closeResponseMenu: () => void;
  closePromptMenu: () => void;
  closeExportMenu: () => void;
  schedulePaperPickerSearch: () => void;
  updateImagePreviewPreservingScroll: () => void;
  setStatusMessage?: (message: string, level: StatusLevel) => void;
  log: (message: string, ...args: unknown[]) => void;
};

export function attachComposeCaptureController(
  deps: ComposeCaptureControllerDeps,
): void {
  const {
    body,
    inputBox,
    screenshotBtn,
    uploadBtn,
    uploadInput,
    slashMenu,
    slashUploadOption,
    slashReferenceOption,
    slashPdfPageOption,
    slashPdfMultiplePagesOption,
    modelMenu,
    reasoningMenu,
    retryModelMenu,
  } = deps;

  const setStatus = (message: string, level: StatusLevel) => {
    deps.setStatusMessage?.(message, level);
  };

  const closeModelMenu = () =>
    setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, false);
  const closeReasoningMenu = () =>
    setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
  const closeRetryModelMenu = () =>
    setFloatingMenuOpen(retryModelMenu, RETRY_MODEL_MENU_OPEN_CLASS, false);

  {
    const bodyDelegation = body as Element & {
      __llmAddTextPointerDown?: EventListener;
      __llmAddTextMouseDown?: EventListener;
      __llmAddTextClick?: EventListener;
    };
    if (bodyDelegation.__llmAddTextPointerDown) {
      body.removeEventListener(
        "pointerdown",
        bodyDelegation.__llmAddTextPointerDown,
        true,
      );
    }
    if (bodyDelegation.__llmAddTextMouseDown) {
      body.removeEventListener(
        "mousedown",
        bodyDelegation.__llmAddTextMouseDown,
        true,
      );
    }
    if (bodyDelegation.__llmAddTextClick) {
      body.removeEventListener("click", bodyDelegation.__llmAddTextClick, true);
    }

    let pendingSelectedText = "";

    const cacheSelectionBeforeFocusShift = (event: Event) => {
      if (!(event.target as Element)?.closest?.("#llm-select-text")) return;
      const currentItem = activeContextPanels.get(body)?.() ?? deps.getItem();
      if (!currentItem) return;
      pendingSelectedText = getActiveReaderSelectionText(
        body.ownerDocument as Document,
        currentItem,
      );
    };

    const addTextClickHandler = async (event: Event) => {
      if (!(event.target as Element)?.closest?.("#llm-select-text")) return;
      event.preventDefault();
      event.stopPropagation();

      const currentItem = activeContextPanels.get(body)?.() ?? deps.getItem();
      const root = body.querySelector("#llm-main") as HTMLDivElement | null;
      const conversationKind = root?.dataset?.conversationKind || "";
      const isGlobal = conversationKind === "global";
      const conversationKey = currentItem
        ? deps.getConversationKey(currentItem)
        : Number(root?.dataset?.itemId || 0);

      if (!conversationKey) {
        deps.log("LLM addText: no conversationKey");
        return;
      }

      let selectedText = pendingSelectedText;
      pendingSelectedText = "";
      if (!selectedText) {
        const nextItem = activeContextPanels.get(body)?.() ?? deps.getItem();
        if (nextItem) {
          selectedText = getActiveReaderSelectionText(
            body.ownerDocument as Document,
            nextItem,
          );
        }
      }
      if (!selectedText) {
        deps.log("LLM addText: no text selected");
        return;
      }

      const readerAttachment = getActiveContextAttachmentFromTabs();
      const readerPaperContext =
        resolvePaperContextRefFromAttachment(readerAttachment);
      const paperContext = isGlobal ? readerPaperContext : null;

      const reader = getActiveReaderForSelectedTab();
      const selectedTextLocation =
        await resolveCurrentSelectionPageLocationFromReader(
          reader,
          selectedText,
        );

      const added = appendSelectedTextContextForItem(
        conversationKey,
        selectedText,
        "pdf",
        paperContext,
        selectedTextLocation,
      );
      if (added) {
        applySelectedTextPreview(body, conversationKey);
      }
    };

    bodyDelegation.__llmAddTextPointerDown =
      cacheSelectionBeforeFocusShift as EventListener;
    bodyDelegation.__llmAddTextMouseDown =
      cacheSelectionBeforeFocusShift as EventListener;
    bodyDelegation.__llmAddTextClick = addTextClickHandler as EventListener;

    body.addEventListener(
      "pointerdown",
      cacheSelectionBeforeFocusShift as EventListener,
      true,
    );
    body.addEventListener(
      "mousedown",
      cacheSelectionBeforeFocusShift as EventListener,
      true,
    );
    body.addEventListener("click", addTextClickHandler as EventListener, true);
  }

  if (screenshotBtn) {
    screenshotBtn.addEventListener("click", async (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = deps.getItem();
      if (!item) return;
      const { currentModel } = deps.getSelectedModelInfo();
      if (isScreenshotUnsupportedModel(currentModel)) {
        setStatus(getScreenshotDisabledHint(currentModel), "error");
        deps.updateImagePreviewPreservingScroll();
        return;
      }

      let mainWindow: Window | null = Zotero.getMainWindow();
      deps.log("Screenshot: Zotero.getMainWindow() =", mainWindow);
      if (!mainWindow) {
        const panelWin = body.ownerDocument?.defaultView;
        mainWindow = panelWin?.top || panelWin || null;
        deps.log("Screenshot: Using panel's top window");
      }
      if (!mainWindow) {
        deps.log("Screenshot: No window found");
        return;
      }
      deps.log(
        "Screenshot: Using window, body exists:",
        !!mainWindow.document.body,
      );
      deps.log(
        "Screenshot: documentElement exists:",
        !!mainWindow.document.documentElement,
      );

      const currentImages = selectedImageCache.get(item.id) || [];
      if (currentImages.length >= MAX_SELECTED_IMAGES) {
        setStatus(
          `Maximum ${MAX_SELECTED_IMAGES} screenshots allowed`,
          "error",
        );
        deps.updateImagePreviewPreservingScroll();
        return;
      }
      setStatus(t("Select a region..."), "sending");

      try {
        deps.log("Screenshot: Starting capture selection...");
        const dataUrl = await captureScreenshotSelection(mainWindow);
        deps.log(
          "Screenshot: Capture returned:",
          dataUrl ? "image data" : "null",
        );
        if (dataUrl) {
          const optimized = await optimizeImageDataUrl(mainWindow, dataUrl);
          const existingImages = selectedImageCache.get(item.id) || [];
          const nextImages = [...existingImages, optimized].slice(
            0,
            MAX_SELECTED_IMAGES,
          );
          selectedImageCache.set(item.id, nextImages);
          const expandedBeforeCapture = selectedImagePreviewExpandedCache.get(
            item.id,
          );
          selectedImagePreviewExpandedCache.set(
            item.id,
            typeof expandedBeforeCapture === "boolean"
              ? expandedBeforeCapture
              : false,
          );
          selectedImagePreviewActiveIndexCache.set(
            item.id,
            nextImages.length - 1,
          );
          deps.updateImagePreviewPreservingScroll();
          setStatus(`Screenshot captured (${nextImages.length})`, "ready");
        } else {
          setStatus(t("Selection cancelled"), "ready");
        }
      } catch (error) {
        deps.log("Screenshot selection error:", error);
        setStatus(t("Screenshot failed"), "error");
      }
    });
  }

  const openReferenceSlashFromMenu = () => {
    const item = deps.getItem();
    if (!item) return;
    const existingToken = deps.getActiveAtToken();
    if (!existingToken) {
      const selectionStart =
        typeof inputBox.selectionStart === "number"
          ? inputBox.selectionStart
          : inputBox.value.length;
      const selectionEnd =
        typeof inputBox.selectionEnd === "number"
          ? inputBox.selectionEnd
          : selectionStart;
      const before = inputBox.value.slice(0, selectionStart);
      const after = inputBox.value.slice(selectionEnd);
      const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
      const insertion = `${needsLeadingSpace ? " " : ""}@`;
      inputBox.value = `${before}${insertion}${after}`;
      deps.persistDraftInputForCurrentConversation();
      const nextCaret = before.length + insertion.length;
      inputBox.setSelectionRange(nextCaret, nextCaret);
    }
    inputBox.focus({ preventScroll: true });
    deps.schedulePaperPickerSearch();
    setStatus(
      t("Reference picker ready. Browse collections or type to search papers."),
      "ready",
    );
  };

  if (uploadBtn && uploadInput) {
    uploadBtn.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!deps.getItem()) return;
      if (!slashMenu) {
        uploadInput.click();
        return;
      }
      if (isFloatingMenuOpen(slashMenu)) {
        deps.closeSlashMenu();
        return;
      }
      closeRetryModelMenu();
      closeModelMenu();
      closeReasoningMenu();
      deps.closeHistoryNewMenu();
      deps.closeHistoryMenu();
      deps.closeResponseMenu();
      deps.closePromptMenu();
      deps.closeExportMenu();
      deps.renderDynamicSlashMenuSections();
      deps.openSlashMenuWithSelection();
      uploadBtn.setAttribute("aria-expanded", "true");
    });
    uploadInput.addEventListener("change", async () => {
      if (!deps.getItem()) return;
      const files = Array.from(uploadInput.files || []);
      uploadInput.value = "";
      await deps.processIncomingFiles(files);
    });
  }

  if (slashUploadOption && uploadInput) {
    slashUploadOption.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!deps.getItem()) return;
      deps.consumeActiveActionToken();
      deps.closeSlashMenu();
      uploadInput.click();
    });
  }

  if (slashReferenceOption) {
    slashReferenceOption.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      deps.consumeActiveActionToken();
      deps.closeSlashMenu();
      openReferenceSlashFromMenu();
    });
  }

  if (slashPdfPageOption) {
    slashPdfPageOption.addEventListener("click", async (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = deps.getItem();
      if (!item) return;
      deps.consumeActiveActionToken();
      deps.closeSlashMenu();
      const { currentModel } = deps.getSelectedModelInfo();
      if (isScreenshotUnsupportedModel(currentModel)) {
        setStatus(getScreenshotDisabledHint(currentModel), "error");
        return;
      }
      const currentImages = selectedImageCache.get(item.id) || [];
      if (currentImages.length >= MAX_SELECTED_IMAGES) {
        setStatus(`Maximum ${MAX_SELECTED_IMAGES} images allowed`, "error");
        return;
      }
      setStatus(t("Capturing PDF page..."), "sending");
      try {
        const dataUrl = await captureCurrentPdfPage();
        if (dataUrl) {
          const win =
            body.ownerDocument?.defaultView ||
            (Zotero.getMainWindow?.() as Window | null);
          const optimized = win
            ? await optimizeImageDataUrl(win, dataUrl)
            : dataUrl;
          const existingImages = selectedImageCache.get(item.id) || [];
          const nextImages = [...existingImages, optimized].slice(
            0,
            MAX_SELECTED_IMAGES,
          );
          selectedImageCache.set(item.id, nextImages);
          const expandedBefore = selectedImagePreviewExpandedCache.get(item.id);
          selectedImagePreviewExpandedCache.set(
            item.id,
            typeof expandedBefore === "boolean" ? expandedBefore : false,
          );
          selectedImagePreviewActiveIndexCache.set(
            item.id,
            nextImages.length - 1,
          );
          deps.updateImagePreviewPreservingScroll();
          setStatus(`Page captured (${nextImages.length})`, "ready");
        } else {
          setStatus(
            t("No PDF page found — open a PDF in the reader first"),
            "error",
          );
          deps.updateImagePreviewPreservingScroll();
        }
      } catch (error) {
        deps.log("PDF page capture error:", error);
        setStatus(t("PDF page capture failed"), "error");
        deps.updateImagePreviewPreservingScroll();
      }
    });
  }

  if (slashPdfMultiplePagesOption) {
    slashPdfMultiplePagesOption.addEventListener(
      "click",
      async (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        const item = deps.getItem();
        if (!item) return;
        deps.consumeActiveActionToken();
        deps.closeSlashMenu();
        const { currentModel } = deps.getSelectedModelInfo();
        if (isScreenshotUnsupportedModel(currentModel)) {
          setStatus(getScreenshotDisabledHint(currentModel), "error");
          return;
        }
        const currentImages = selectedImageCache.get(item.id) || [];
        const remaining = MAX_SELECTED_IMAGES - currentImages.length;
        if (remaining <= 0) {
          setStatus(`Maximum ${MAX_SELECTED_IMAGES} images allowed`, "error");
          return;
        }
        const { getPdfPageCount, parsePageRanges, capturePdfPages } =
          await import("../../pdfPageCapture");
        const totalPages = getPdfPageCount();
        if (totalPages <= 0) {
          setStatus(
            t("No PDF page found — open a PDF in the reader first"),
            "error",
          );
          return;
        }
        const win =
          body.ownerDocument?.defaultView ||
          (Zotero.getMainWindow?.() as Window | null);
        if (!win) return;
        const dialogData: Record<string, unknown> = {
          pageRangeValue: `1-${Math.min(totalPages, remaining)}`,
          loadCallback: () => {
            return;
          },
          unloadCallback: () => {
            return;
          },
        };
        const pageDialog = new ztoolkit.Dialog(2, 1)
          .addCell(0, 0, {
            tag: "label",
            namespace: "html",
            properties: {
              innerHTML: `${t("Enter page numbers or ranges (e.g. 1-5, 8, 12):")} (1-${totalPages})`,
            },
            styles: { display: "block", marginBottom: "8px" },
          })
          .addCell(
            1,
            0,
            {
              tag: "input",
              namespace: "html",
              id: "llm-pdf-page-range-input",
              attributes: {
                "data-bind": "pageRangeValue",
                "data-prop": "value",
                type: "text",
              },
              styles: { width: "300px" },
            },
            false,
          )
          .addButton("OK", "ok")
          .addButton("Cancel", "cancel")
          .setDialogData(dialogData)
          .open(t("Select PDF pages"));
        addon.data.dialog = pageDialog;
        await (dialogData as { unloadLock: { promise: Promise<void> } })
          .unloadLock.promise;
        addon.data.dialog = undefined;
        if ((dialogData as { _lastButtonId?: string })._lastButtonId !== "ok")
          return;
        const rawInput = String(
          (dialogData as { pageRangeValue?: string }).pageRangeValue || "",
        ).trim();
        if (!rawInput) return;
        const pageNumbers = parsePageRanges(rawInput, totalPages).slice(
          0,
          remaining,
        );
        if (!pageNumbers.length) {
          setStatus("No valid pages selected", "error");
          return;
        }
        setStatus(t("Capturing PDF pages..."), "sending");
        try {
          const dataUrls = await capturePdfPages(pageNumbers, {
            onProgress: (current, total) => {
              setStatus(
                `${t("Capturing PDF pages...")} ${current}/${total}`,
                "sending",
              );
            },
          });
          if (dataUrls.length > 0) {
            const optimized: string[] = [];
            for (const dataUrl of dataUrls) {
              optimized.push(
                win ? await optimizeImageDataUrl(win, dataUrl) : dataUrl,
              );
            }
            const existingImages = selectedImageCache.get(item.id) || [];
            const nextImages = [...existingImages, ...optimized].slice(
              0,
              MAX_SELECTED_IMAGES,
            );
            selectedImageCache.set(item.id, nextImages);
            const expandedBefore = selectedImagePreviewExpandedCache.get(
              item.id,
            );
            selectedImagePreviewExpandedCache.set(
              item.id,
              typeof expandedBefore === "boolean" ? expandedBefore : true,
            );
            selectedImagePreviewActiveIndexCache.set(
              item.id,
              nextImages.length - 1,
            );
            deps.updateImagePreviewPreservingScroll();
            setStatus(`${dataUrls.length} pages captured`, "ready");
          } else {
            setStatus(t("PDF page capture failed"), "error");
            deps.updateImagePreviewPreservingScroll();
          }
        } catch (error) {
          deps.log("PDF multiple pages capture error:", error);
          setStatus(t("PDF page capture failed"), "error");
          deps.updateImagePreviewPreservingScroll();
        }
      },
    );
  }
}
