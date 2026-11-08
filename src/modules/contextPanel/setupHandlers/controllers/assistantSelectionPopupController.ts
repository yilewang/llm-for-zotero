import { createElement } from "../../../../utils/domHelpers";
import { t } from "../../../../utils/i18n";
import {
  addSelectedTextContext,
  type AppendSelectedTextOutcome,
  getSelectedTextContextQueryForItem,
  updateSelectedTextContextQueryForItem,
} from "../../contextResolution";
import {
  clampNumber,
  getSelectedTextWithinBubble,
  setStatus,
} from "../../textUtils";
import { sanitizeText } from "../../../../utils/textSanitization";
import { classifySelectionPromptKey } from "../../selectionPrompt/selectionPromptKeys";
import { resizeTextareaToContent } from "../../textareaSizing";
import { getChatPanelExtensions } from "../../chatPanelExtensions";

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
    .querySelectorAll(
      ".llm-assistant-selection-popup, .llm-assistant-selection-action",
    )
    .forEach((node: Element) => node.remove());
  if (popupHost.__llmSelectionPopupCleanup) {
    popupHost.__llmSelectionPopupCleanup();
    delete popupHost.__llmSelectionPopupCleanup;
  }
  // The wrapper is the positioned element; it holds the Quote buttons and the
  // inline box that opens after a quote. The box attaches a question to the
  // quoted chip; it never sends. "Quote in side chat" shows only in a body
  // that registers a side chat target (the standalone window's main chat).
  const selectionPopup = createElement(
    panelDoc,
    "div",
    "llm-assistant-selection-popup",
  );
  const quoteButton = createElement(
    panelDoc,
    "button",
    "llm-shortcut-btn llm-assistant-selection-action",
    {
      type: "button",
      textContent: "❞ " + t("Quote"),
      title: t("Quote selected text"),
    },
  );
  const sideChatQuoteButton = createElement(
    panelDoc,
    "button",
    "llm-shortcut-btn llm-assistant-selection-action llm-assistant-selection-side-action",
    {
      type: "button",
      textContent: "❞ " + t("Quote in side chat"),
      title: t("Quote selected text in a side chat"),
    },
  );
  const actionRow = createElement(
    panelDoc,
    "div",
    "llm-assistant-selection-actions",
  );
  actionRow.append(quoteButton, sideChatQuoteButton);
  const promptWrap = createElement(
    panelDoc,
    "div",
    "llm-assistant-selection-prompt",
  );
  const promptLabel = createElement(
    panelDoc,
    "div",
    "llm-selected-context-label",
    { textContent: t("Selected text") },
  );
  const promptQuote = createElement(
    panelDoc,
    "div",
    "llm-assistant-selection-quote",
  );
  const promptInput = createElement(
    panelDoc,
    "textarea",
    "llm-assistant-selection-prompt-input",
    { rows: 1, placeholder: t("Ask about this selection…") },
  );
  const promptHintText = t(
    "Enter to add · Shift+Enter for a new line · Esc to close",
  );
  const promptHint = createElement(
    panelDoc,
    "span",
    "llm-assistant-selection-prompt-hint",
    { textContent: promptHintText },
  );
  const promptQuoteSection = createElement(
    panelDoc,
    "div",
    "llm-selected-context-section",
  );
  promptQuoteSection.append(promptLabel, promptQuote);
  promptWrap.append(promptQuoteSection, promptInput, promptHint);
  selectionPopup.append(actionRow, promptWrap);
  panelRoot.appendChild(selectionPopup);
  let selectionPopupText = "";
  let selectionDragStartBubble: HTMLElement | null = null;
  let disposeSelectionPopup: () => void = () => {};
  let promptExpanded = false;
  // The conversation and the normalized text of the quoted chip; Enter
  // attaches the question to that chip.
  let promptConversationKey: number | null = null;
  let promptSelectedText = "";
  // Set when the box was opened by "Quote in side chat": nothing is quoted
  // here, and Enter sends the text and the question to the side chat.
  let promptForSideChat = false;
  // Set when the prompt closes from the keyboard, so the keyup of that same
  // key does not reopen the Quote button over the still-selected text.
  let ignoreNextKeyUp = false;

  const getSideChatQuote = () =>
    getChatPanelExtensions(body)?.sideChatQuote || null;
  const syncSideChatQuoteButton = () => {
    const shown = Boolean(getSideChatQuote());
    sideChatQuoteButton.style.display = shown ? "" : "none";
    actionRow.classList.toggle("is-split", shown);
  };
  syncSideChatQuoteButton();
  const showSelectionPopup = () => {
    if (!selectionPopup.classList.contains("is-visible")) {
      selectionPopup.classList.add("is-visible");
    }
  };
  const collapsePrompt = () => {
    promptExpanded = false;
    promptConversationKey = null;
    promptSelectedText = "";
    promptForSideChat = false;
    promptQuote.textContent = "";
    promptHint.textContent = promptHintText;
    selectionPopup.classList.remove("is-expanded");
    promptInput.value = "";
    promptInput.style.height = "";
    promptInput.style.overflowY = "";
  };
  const hideSelectionPopup = () => {
    // Every chat scroll calls this; a hidden, collapsed popup has nothing
    // to reset, and rewriting it is a mutation other observers react to.
    if (
      !promptExpanded &&
      !selectionPopup.classList.contains("is-visible") &&
      !selectionPopup.classList.contains("is-expanded")
    ) {
      selectionPopupText = "";
      return;
    }
    collapsePrompt();
    selectionPopup.classList.remove("is-visible");
    selectionPopupText = "";
  };
  // Keeps the expanded box inside the chat area; its position was computed
  // for the smaller Quote button.
  const fitExpandedPopupIntoChat = () => {
    if (!promptExpanded || !chatBox) return;
    const margin = 8;
    const panelRect = panelRoot.getBoundingClientRect();
    const chatRect = chatBox.getBoundingClientRect();
    const popupRect = selectionPopup.getBoundingClientRect();
    if (!popupRect.width && !popupRect.height) return;
    const hostLeft = chatRect.left - panelRect.left;
    const hostTop = chatRect.top - panelRect.top;
    const left = clampNumber(
      popupRect.left - panelRect.left,
      hostLeft + margin,
      hostLeft + chatRect.width - popupRect.width - margin,
    );
    const top = clampNumber(
      popupRect.top - panelRect.top,
      hostTop + margin,
      hostTop + chatRect.height - popupRect.height - margin,
    );
    selectionPopup.style.left = `${Math.round(left)}px`;
    selectionPopup.style.top = `${Math.round(top)}px`;
  };
  // existingQuestion prefills the box when the chip already has a question.
  const expandPrompt = (
    conversationKey: number | null,
    selectedText: string,
    existingQuestion = "",
    forSideChat = false,
  ) => {
    promptExpanded = true;
    promptConversationKey = conversationKey;
    promptForSideChat = forSideChat;
    promptSelectedText = selectedText;
    promptQuote.textContent = selectedText;
    promptHint.textContent = promptHintText;
    promptInput.value = existingQuestion;
    promptInput.style.height = "";
    promptInput.style.overflowY = "";
    if (chatBox) {
      const available = Math.round(chatBox.getBoundingClientRect().width) - 16;
      promptWrap.style.width =
        available > 0 ? `${Math.min(360, available)}px` : "";
    }
    selectionPopup.classList.add("is-expanded");
    if (existingQuestion) resizeTextareaToContent(promptInput);
    fitExpandedPopupIntoChat();
    panelWin?.setTimeout(() => {
      if (!promptExpanded) return;
      promptInput.focus({ preventScroll: true });
      const end = promptInput.value.length;
      promptInput.setSelectionRange(end, end);
    }, 0);
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
    if (promptExpanded) return;
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
    // Before the popup is measured, so its width counts the second button.
    syncSideChatQuoteButton();
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

  /** The selected reply text; reports and closes the popup when empty. */
  const readSelectedAssistantText = (): string => {
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
    }
    return selected;
  };

  // Opens the question box; Enter sends the text to the side chat.
  const quoteSelectedTextInSideChat = () => {
    if (!getSideChatQuote()) {
      hideSelectionPopup();
      return;
    }
    const selected = readSelectedAssistantText();
    if (!selected) return;
    expandPrompt(null, selected, "", true);
  };

  /** Sends the box's text and question to the side chat, then closes. */
  const sendPromptToSideChat = (question: string) => {
    const target = getSideChatQuote();
    const selected = promptSelectedText;
    hideSelectionPopup();
    if (!target || !selected) {
      inputBox.focus({ preventScroll: true });
      return;
    }
    // The text has moved to the side chat; a selection left behind would
    // reopen this popup on the next mouseup.
    panelWin?.getSelection?.()?.removeAllRanges?.();
    // The side chat focuses its own composer.
    target.quote(selected, question || undefined);
  };

  const quoteSelectedAssistantText = () => {
    if (!getItem()) {
      hideSelectionPopup();
      return;
    }
    const selected = readSelectedAssistantText();
    if (!selected) return;
    const activeItemId = getTextContextConversationKey();
    if (!activeItemId) {
      hideSelectionPopup();
      return;
    }
    let outcome = "empty" as AppendSelectedTextOutcome;
    runWithChatScrollGuard(() => {
      outcome = addSelectedTextContext(body, activeItemId, selected, {
        successStatusText: "Selected response text included",
        focusInput: false,
        source: "model",
      });
    });
    if (outcome === "added") {
      updateSelectedTextPreviewPreservingScroll();
    }
    // A duplicate opens the box against the chip that already holds the text.
    if (outcome !== "added" && outcome !== "duplicate") {
      hideSelectionPopup();
      return;
    }
    expandPrompt(
      activeItemId,
      selected,
      getSelectedTextContextQueryForItem(activeItemId, selected, "model", null),
    );
  };

  /**
   * Sets the box's text as the question of the quoted chip. Model-response
   * chips carry no paper context (see quoteSelectedAssistantText). Returns
   * false when no chip holds the quoted text any more.
   */
  const attachPromptQuestion = (
    conversationKey: number,
    selectedText: string,
    question: string,
  ): boolean => {
    const attached = updateSelectedTextContextQueryForItem(
      conversationKey,
      selectedText,
      "model",
      null,
      question,
    );
    if (!attached) return false;
    // The chip stays collapsed; its card shows the question on hover or click.
    updateSelectedTextPreviewPreservingScroll();
    if (status) {
      setStatus(status, t("Question attached to the selected text"), "ready");
    }
    return true;
  };

  const onPromptKeyDown = (e: Event) => {
    const ke = e as KeyboardEvent;
    const action = classifySelectionPromptKey(ke);
    if (action === "other" || action === "newline") {
      // Keep panel-level Escape/Enter handlers out of the box; let window
      // shortcuts (Cmd/Ctrl combinations) through.
      if (!ke.metaKey && !ke.ctrlKey) e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    ignoreNextKeyUp = true;
    if (action === "close") {
      hideSelectionPopup();
      inputBox.focus({ preventScroll: true });
      return;
    }
    const text = promptInput.value.trim();
    if (promptForSideChat) {
      sendPromptToSideChat(text);
      return;
    }
    const conversationKey = promptConversationKey;
    if (
      text &&
      conversationKey !== null &&
      !attachPromptQuestion(conversationKey, promptSelectedText, text)
    ) {
      // The chip is gone; keep the box and the typed question.
      promptHint.textContent = t("Selected text is no longer in the context");
      return;
    }
    hideSelectionPopup();
    // Move focus out of the hidden box so later typing lands in the composer.
    inputBox.focus({ preventScroll: true });
  };
  const stopPromptKeyPropagation = (e: Event) => {
    const ke = e as KeyboardEvent;
    if (!ke.metaKey && !ke.ctrlKey) e.stopPropagation();
  };
  // Grow with Shift+Enter lines between the CSS min-height and max-height.
  const onPromptInput = () => resizeTextareaToContent(promptInput);
  promptInput.addEventListener("keydown", onPromptKeyDown);
  promptInput.addEventListener("keyup", stopPromptKeyPropagation);
  promptInput.addEventListener("keypress", stopPromptKeyPropagation);
  promptInput.addEventListener("input", onPromptInput);

  const onPanelMouseUp = (e: Event) => {
    if (!panelWin) return;
    if (!panelRoot.isConnected) {
      disposeSelectionPopup();
      return;
    }
    const target = e.target as Element | null;
    // Clicks inside the expanded prompt box must not re-run selection logic.
    if (promptExpanded && target && selectionPopup.contains(target)) return;
    const me = e as MouseEvent;
    if (typeof me.button === "number" && me.button !== 0) {
      selectionDragStartBubble = null;
      hideSelectionPopup();
      return;
    }
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
    if (ignoreNextKeyUp) {
      ignoreNextKeyUp = false;
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
  const onChatScrollHide = () => {
    // The popup is absolutely positioned inside panelRoot, so an expanded
    // prompt stays in view while the chat scrolls under it.
    if (promptExpanded) return;
    hideSelectionPopup();
  };
  const onWindowResize = () => {
    if (promptExpanded) {
      fitExpandedPopupIntoChat();
      return;
    }
    hideSelectionPopup();
  };
  const onChatContextMenu = () => hideSelectionPopup();

  let selectionPopupHandled = false;
  const triggerSelectionPopupAction = (e: Event, action: () => void) => {
    if (selectionPopupHandled) return;
    selectionPopupHandled = true;
    e.preventDefault();
    e.stopPropagation();
    action();
    panelWin?.setTimeout(() => {
      selectionPopupHandled = false;
    }, 0);
  };
  const isPrimarySelectionPopupEvent = (e: Event): boolean => {
    const maybeMouse = e as MouseEvent;
    return typeof maybeMouse.button !== "number" || maybeMouse.button === 0;
  };
  const bindSelectionPopupAction = (
    button: HTMLButtonElement,
    action: () => void,
  ) => {
    const trigger = (e: Event) => triggerSelectionPopupAction(e, action);
    button.addEventListener("pointerdown", (e: Event) => {
      if (!isPrimarySelectionPopupEvent(e)) return;
      trigger(e);
    });
    button.addEventListener("mousedown", (e: Event) => {
      if (!isPrimarySelectionPopupEvent(e)) return;
      trigger(e);
    });
    button.addEventListener("click", trigger);
    button.addEventListener("command", trigger);
    button.addEventListener("contextmenu", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      hideSelectionPopup();
    });
  };
  bindSelectionPopupAction(quoteButton, quoteSelectedAssistantText);
  bindSelectionPopupAction(sideChatQuoteButton, quoteSelectedTextInSideChat);

  panelDoc.addEventListener("mouseup", onPanelMouseUp, true);
  panelDoc.addEventListener("keyup", onDocKeyUp, true);
  panelRoot.addEventListener("pointerdown", onPanelPointerDown, true);
  chatBox?.addEventListener("scroll", onChatScrollHide, { passive: true });
  chatBox?.addEventListener("contextmenu", onChatContextMenu, true);
  panelWin?.addEventListener("resize", onWindowResize, { passive: true });

  disposeSelectionPopup = () => {
    panelDoc.removeEventListener("mouseup", onPanelMouseUp, true);
    panelDoc.removeEventListener("keyup", onDocKeyUp, true);
    panelRoot.removeEventListener("pointerdown", onPanelPointerDown, true);
    chatBox?.removeEventListener("scroll", onChatScrollHide);
    chatBox?.removeEventListener("contextmenu", onChatContextMenu, true);
    panelWin?.removeEventListener("resize", onWindowResize);
    selectionPopup.remove();
    if (popupHost.__llmSelectionPopupCleanup === disposeSelectionPopup) {
      delete popupHost.__llmSelectionPopupCleanup;
    }
  };
  popupHost.__llmSelectionPopupCleanup = disposeSelectionPopup;
}
