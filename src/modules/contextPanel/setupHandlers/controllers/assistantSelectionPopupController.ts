import { createElement } from "../../../../utils/domHelpers";
import { t } from "../../../../utils/i18n";
import { addSelectedTextContext } from "../../contextResolution";
import {
  clampNumber,
  getSelectedTextWithinBubble,
  sanitizeText,
  setStatus,
} from "../../textUtils";

type AssistantSelectionPopupDeps = {
  body: Element;
  panelRoot: HTMLDivElement;
  panelDoc: Document;
  panelWin: Window | null;
  chatBox: HTMLDivElement | null;
  inputBox: HTMLTextAreaElement;
  status: HTMLElement | null;
  getItem: () => Zotero.Item | null;
  getTextContextConversationKey: () => number | null;
  runWithChatScrollGuard: (fn: () => void) => void;
  updateSelectedTextPreviewPreservingScroll: () => void;
  isElementNode: (value: unknown) => value is Element;
};

export function attachAssistantSelectionPopup(
  deps: AssistantSelectionPopupDeps,
): void {
  const {
    body,
    panelRoot,
    panelDoc,
    panelWin,
    chatBox,
    inputBox,
    status,
    getItem,
    getTextContextConversationKey,
    runWithChatScrollGuard,
    updateSelectedTextPreviewPreservingScroll,
    isElementNode,
  } = deps;
  const popupHost = panelRoot as HTMLDivElement & {
    __llmSelectionPopupCleanup?: () => void;
  };
  panelRoot
    .querySelectorAll(".llm-assistant-selection-action")
    .forEach((node: Element) => node.remove());
  if (popupHost.__llmSelectionPopupCleanup) {
    popupHost.__llmSelectionPopupCleanup();
    delete popupHost.__llmSelectionPopupCleanup;
  }
  const selectionPopup = createElement(
    panelDoc,
    "button",
    "llm-shortcut-btn llm-assistant-selection-action",
    {
      type: "button",
      textContent: "❞ Quote",
      title: "Quote selected text",
    },
  ) as HTMLButtonElement;
  panelRoot.appendChild(selectionPopup);
  let selectionPopupText = "";
  let selectionDragStartBubble: HTMLElement | null = null;
  let disposeSelectionPopup: () => void = () => {};

  const showSelectionPopup = () => {
    if (!selectionPopup.classList.contains("is-visible")) {
      selectionPopup.classList.add("is-visible");
    }
  };
  const hideSelectionPopup = () => {
    selectionPopup.classList.remove("is-visible");
    selectionPopupText = "";
  };

  const findAssistantBubbleFromSelection = (): HTMLElement | null => {
    if (!chatBox || !panelWin) return null;
    const selection = panelWin.getSelection?.();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }
    const anchorEl = isElementNode(selection.anchorNode)
      ? selection.anchorNode
      : selection.anchorNode?.parentElement || null;
    const focusEl = isElementNode(selection.focusNode)
      ? selection.focusNode
      : selection.focusNode?.parentElement || null;
    if (!anchorEl || !focusEl) return null;
    const bubbleA = anchorEl.closest(".llm-bubble.assistant");
    const bubbleB = focusEl.closest(".llm-bubble.assistant");
    if (!bubbleA || !bubbleB || bubbleA !== bubbleB) return null;
    if (!chatBox.contains(bubbleA)) return null;
    return bubbleA as HTMLElement;
  };

  const updateSelectionPopup = (bubble?: HTMLElement | null) => {
    if (
      !panelWin ||
      !chatBox ||
      !panelRoot.isConnected ||
      panelRoot.getClientRects().length === 0
    ) {
      hideSelectionPopup();
      return;
    }
    const targetBubble = bubble || findAssistantBubbleFromSelection();
    if (targetBubble?.closest(".llm-agent-reasoning")) {
      hideSelectionPopup();
      return;
    }
    if (!targetBubble) {
      hideSelectionPopup();
      return;
    }
    const selected = sanitizeText(
      getSelectedTextWithinBubble(panelDoc, targetBubble),
    ).trim();
    if (!selected) {
      hideSelectionPopup();
      return;
    }
    selectionPopupText = selected;
    const selection = panelWin.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      hideSelectionPopup();
      return;
    }
    const range = selection.getRangeAt(0);
    let rect = range.getBoundingClientRect();
    const rects = range.getClientRects();
    const anchorRect =
      rects && rects.length > 0
        ? rects[rects.length - 1] || rects[0] || rect
        : rect;
    let focusRect: DOMRect | null = null;
    try {
      const focusNode = selection.focusNode;
      if (focusNode) {
        const focusRange = panelDoc.createRange();
        focusRange.setStart(focusNode, selection.focusOffset);
        focusRange.setEnd(focusNode, selection.focusOffset);
        let fr = focusRange.getBoundingClientRect();
        const frs = focusRange.getClientRects();
        if ((!fr.width || !fr.height) && frs && frs.length > 0) {
          const first = frs[0];
          if (first) fr = first;
        }
        if (fr.width || fr.height) {
          focusRect = fr;
        }
      }
    } catch (_err) {
      void _err;
    }
    const positionRect = focusRect || anchorRect || rect;
    if ((!rect.width || !rect.height) && anchorRect) {
      rect = anchorRect;
    }
    if (!rect.width && !rect.height) {
      hideSelectionPopup();
      return;
    }
    const panelRect = panelRoot.getBoundingClientRect();
    const chatRect = chatBox.getBoundingClientRect();
    const popupRect = selectionPopup.getBoundingClientRect();
    const margin = 8;
    const hostLeft = chatRect.left - panelRect.left;
    const hostTop = chatRect.top - panelRect.top;
    const hostRight = hostLeft + chatRect.width;
    const hostBottom = hostTop + chatRect.height;
    const focusX = positionRect.right - panelRect.left;
    const focusTop = positionRect.top - panelRect.top;
    const focusBottom = positionRect.bottom - panelRect.top;
    let left = focusX + 8;
    let top = focusTop - popupRect.height - 10;
    if (top < hostTop + margin) top = rect.bottom - panelRect.top + 10;
    if (top < hostTop + margin) top = focusBottom + 10;
    if (left > hostRight - popupRect.width - margin) {
      left = focusX - popupRect.width - 8;
    }
    left = clampNumber(
      left,
      hostLeft + margin,
      hostRight - popupRect.width - margin,
    );
    top = clampNumber(
      top,
      hostTop + margin,
      hostBottom - popupRect.height - margin,
    );
    selectionPopup.style.left = `${Math.round(left)}px`;
    selectionPopup.style.top = `${Math.round(top)}px`;
    showSelectionPopup();
  };

  const quoteSelectedAssistantText = () => {
    if (!getItem()) {
      hideSelectionPopup();
      return;
    }
    let selected = sanitizeText(selectionPopupText).trim();
    if (!selected) {
      const targetBubble = findAssistantBubbleFromSelection();
      if (targetBubble) {
        selected = sanitizeText(
          getSelectedTextWithinBubble(panelDoc, targetBubble),
        ).trim();
      }
    }
    if (!selected) {
      hideSelectionPopup();
      if (status) setStatus(status, t("No assistant text selected"), "error");
      return;
    }
    let added = false;
    const activeItemId = getTextContextConversationKey();
    if (!activeItemId) {
      hideSelectionPopup();
      return;
    }
    runWithChatScrollGuard(() => {
      added = addSelectedTextContext(body, activeItemId, selected, {
        successStatusText: "Selected response text included",
        focusInput: false,
        source: "model",
      });
    });
    if (added) {
      updateSelectedTextPreviewPreservingScroll();
    }
    hideSelectionPopup();
    if (added) {
      inputBox.focus({ preventScroll: true });
    }
  };

  const onPanelMouseUp = (e: Event) => {
    if (!panelWin) return;
    if (!panelRoot.isConnected) {
      disposeSelectionPopup();
      return;
    }
    const me = e as MouseEvent;
    if (typeof me.button === "number" && me.button !== 0) {
      selectionDragStartBubble = null;
      hideSelectionPopup();
      return;
    }
    const target = e.target as Element | null;
    const targetInsidePanel = Boolean(target && panelRoot.contains(target));
    if (!targetInsidePanel && !selectionDragStartBubble) {
      hideSelectionPopup();
      return;
    }
    if (target && target.closest("summary.llm-agent-reasoning-summary")) {
      hideSelectionPopup();
      return;
    }
    const bubble = target?.closest(
      ".llm-bubble.assistant",
    ) as HTMLElement | null;
    const fallbackBubble = bubble || selectionDragStartBubble;
    selectionDragStartBubble = null;
    panelWin.setTimeout(() => updateSelectionPopup(fallbackBubble), 0);
  };
  const onDocKeyUp = () => {
    if (!panelRoot.isConnected) {
      disposeSelectionPopup();
      return;
    }
    panelWin?.setTimeout(() => updateSelectionPopup(), 0);
  };
  const onPanelPointerDown = (e: Event) => {
    const target = e.target as Node | null;
    if (target && selectionPopup.contains(target)) return;
    const targetEl = target as Element | null;
    selectionDragStartBubble =
      (targetEl?.closest(".llm-bubble.assistant") as HTMLElement | null) ||
      null;
    hideSelectionPopup();
  };
  const onChatScrollHide = () => hideSelectionPopup();
  const onChatContextMenu = () => hideSelectionPopup();

  let selectionPopupHandled = false;
  const triggerSelectionPopupAction = (e: Event) => {
    if (selectionPopupHandled) return;
    selectionPopupHandled = true;
    e.preventDefault();
    e.stopPropagation();
    quoteSelectedAssistantText();
    panelWin?.setTimeout(() => {
      selectionPopupHandled = false;
    }, 0);
  };
  const isPrimarySelectionPopupEvent = (e: Event): boolean => {
    const maybeMouse = e as MouseEvent;
    return typeof maybeMouse.button !== "number" || maybeMouse.button === 0;
  };
  selectionPopup.addEventListener("pointerdown", (e: Event) => {
    if (!isPrimarySelectionPopupEvent(e)) return;
    triggerSelectionPopupAction(e);
  });
  selectionPopup.addEventListener("mousedown", (e: Event) => {
    if (!isPrimarySelectionPopupEvent(e)) return;
    triggerSelectionPopupAction(e);
  });
  selectionPopup.addEventListener("click", triggerSelectionPopupAction);
  selectionPopup.addEventListener("command", triggerSelectionPopupAction);
  selectionPopup.addEventListener("contextmenu", (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    hideSelectionPopup();
  });

  panelDoc.addEventListener("mouseup", onPanelMouseUp, true);
  panelDoc.addEventListener("keyup", onDocKeyUp, true);
  panelRoot.addEventListener("pointerdown", onPanelPointerDown, true);
  chatBox?.addEventListener("scroll", onChatScrollHide, { passive: true });
  chatBox?.addEventListener("contextmenu", onChatContextMenu, true);
  panelWin?.addEventListener("resize", onChatScrollHide, { passive: true });

  disposeSelectionPopup = () => {
    panelDoc.removeEventListener("mouseup", onPanelMouseUp, true);
    panelDoc.removeEventListener("keyup", onDocKeyUp, true);
    panelRoot.removeEventListener("pointerdown", onPanelPointerDown, true);
    chatBox?.removeEventListener("scroll", onChatScrollHide);
    chatBox?.removeEventListener("contextmenu", onChatContextMenu, true);
    panelWin?.removeEventListener("resize", onChatScrollHide);
    selectionPopup.remove();
    if (popupHost.__llmSelectionPopupCleanup === disposeSelectionPopup) {
      delete popupHost.__llmSelectionPopupCleanup;
    }
  };
  popupHost.__llmSelectionPopupCleanup = disposeSelectionPopup;
}
