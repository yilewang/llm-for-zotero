import { createElement } from "../../utils/domHelpers";
import {
  SELECT_TEXT_EXPANDED_LABEL,
  SCREENSHOT_EXPANDED_LABEL,
  UPLOAD_FILE_EXPANDED_LABEL,
  formatFigureCountLabel,
  formatFileCountLabel,
} from "./constants";
import type { ActionDropdownSpec } from "./types";
import { isGlobalPortalItem } from "./portalScope";

function createActionDropdown(doc: Document, spec: ActionDropdownSpec) {
  const slot = createElement(
    doc,
    "div",
    `llm-action-slot ${spec.slotClassName}`.trim(),
    { id: spec.slotId },
  );
  const button = createElement(doc, "button", spec.buttonClassName, {
    id: spec.buttonId,
    textContent: spec.buttonText,
    disabled: spec.disabled,
  });
  const menu = createElement(doc, "div", spec.menuClassName, {
    id: spec.menuId,
  });
  menu.style.display = "none";
  slot.append(button, menu);
  return { slot, button, menu };
}

function buildUI(body: Element, item?: Zotero.Item | null) {
  body.textContent = "";
  const doc = body.ownerDocument!;
  const hasItem = Boolean(item);
  const isGlobalMode = Boolean(item && isGlobalPortalItem(item));
  const conversationItemId =
    hasItem && item
      ? item.isAttachment() && item.parentID
        ? item.parentID
        : item.id
      : 0;

  // Disable CSS scroll anchoring on the Zotero-provided panel body so that
  // Gecko doesn't fight with our programmatic scroll management.
  if (body instanceof (doc.defaultView?.HTMLElement || HTMLElement)) {
    const hostBody = body as HTMLElement;
    hostBody.style.overflowAnchor = "none";
    // Keep panel host width-bound: descendants (e.g., long KaTeX blocks)
    // must never raise the side panel's minimum width.
    hostBody.style.minWidth = "0";
    hostBody.style.width = "100%";
    hostBody.style.maxWidth = "100%";
    hostBody.style.overflowX = "hidden";
    hostBody.style.boxSizing = "border-box";
  }

  // Main container
  const container = createElement(doc, "div", "llm-panel", { id: "llm-main" });
  container.dataset.itemId = conversationItemId > 0 ? `${conversationItemId}` : "";
  container.dataset.libraryId = hasItem && item ? `${item.libraryID}` : "";

  // Header section
  const header = createElement(doc, "div", "llm-header");
  const headerTop = createElement(doc, "div", "llm-header-top");
  const headerInfo = createElement(doc, "div", "llm-header-info");
  // const headerIcon = createElement(doc, "img", "llm-header-icon", {
  //   alt: "LLM",
  //   src: iconUrl,
  // });
  // const title = createElement(doc, "div", "llm-title", {
  //   textContent: "LLM Assistant",
  // });
  const title = createElement(doc, "div", "llm-title", {
    id: "llm-title-static",
    textContent: "LLM Assistant",
  });
  if (hasItem) {
    title.style.display = "none";
  }
  const historyBar = createElement(doc, "div", "llm-history-bar", {
    id: "llm-history-bar",
  });
  historyBar.style.display = hasItem ? "inline-flex" : "none";
  const historyNewBtn = createElement(doc, "button", "llm-history-new", {
    id: "llm-history-new",
    type: "button",
    textContent: "",
    title: "Start a new conversation",
  });
  historyNewBtn.setAttribute("aria-label", "Start a new conversation");
  const historyToggleBtn = createElement(doc, "button", "llm-history-toggle", {
    id: "llm-history-toggle",
    type: "button",
    textContent: "History",
    title: "Conversation history",
  });
  historyToggleBtn.setAttribute("aria-haspopup", "menu");
  historyToggleBtn.setAttribute("aria-expanded", "false");
  const historyModeIndicator = createElement(
    doc,
    "span",
    "llm-history-mode-indicator",
    {
      id: "llm-history-mode-indicator",
      textContent: hasItem ? (isGlobalMode ? "Open chat" : "Paper chat") : "",
    },
  );
  historyModeIndicator.setAttribute("aria-live", "polite");
  historyBar.append(historyNewBtn, historyToggleBtn, historyModeIndicator);

  headerInfo.append(title, historyBar);
  headerTop.appendChild(headerInfo);

  const headerActions = createElement(doc, "div", "llm-header-actions");
  const exportBtn = createElement(doc, "button", "llm-btn-icon", {
    id: "llm-export",
    type: "button",
    textContent: "⤓",
    title: "Export",
    disabled: !hasItem,
  });
  const clearBtn = createElement(doc, "button", "llm-btn-icon", {
    id: "llm-clear",
    type: "button",
    textContent: "Clear",
  });
  headerActions.append(exportBtn, clearBtn);
  headerTop.appendChild(headerActions);
  header.appendChild(headerTop);
  const historyMenu = createElement(doc, "div", "llm-history-menu", {
    id: "llm-history-menu",
  });
  historyMenu.style.display = "none";
  header.appendChild(historyMenu);

  const historyUndo = createElement(doc, "div", "llm-history-undo", {
    id: "llm-history-undo",
  });
  historyUndo.style.display = "none";
  const historyUndoText = createElement(doc, "span", "llm-history-undo-text", {
    id: "llm-history-undo-text",
    textContent: "",
  });
  const historyUndoBtn = createElement(doc, "button", "llm-history-undo-btn", {
    id: "llm-history-undo-btn",
    type: "button",
    textContent: "Undo",
    title: "Restore deleted conversation",
  });
  historyUndo.append(historyUndoText, historyUndoBtn);
  header.appendChild(historyUndo);

  container.appendChild(header);

  // Chat display area
  const chatShell = createElement(doc, "div", "llm-chat-shell", {
    id: "llm-chat-shell",
  });
  const chatBox = createElement(doc, "div", "llm-messages", {
    id: "llm-chat-box",
  });
  chatShell.append(chatBox);
  container.appendChild(chatShell);

  // Shortcuts row
  const shortcutsRow = createElement(doc, "div", "llm-shortcuts", {
    id: "llm-shortcuts",
  });
  container.appendChild(shortcutsRow);

  // Shortcut context menu
  const shortcutMenu = createElement(doc, "div", "llm-shortcut-menu", {
    id: "llm-shortcut-menu",
  });
  shortcutMenu.style.display = "none";
  const menuEditBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-edit",
    type: "button",
    textContent: "Edit",
  });
  const menuDeleteBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-delete",
    type: "button",
    textContent: "Delete",
  });
  const menuAddBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-add",
    type: "button",
    textContent: "Add",
  });
  const menuMoveBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-move",
    type: "button",
    textContent: "Move",
  });
  const menuResetBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-reset",
    type: "button",
    textContent: "Reset",
  });
  shortcutMenu.append(
    menuEditBtn,
    menuDeleteBtn,
    menuAddBtn,
    menuMoveBtn,
    menuResetBtn,
  );
  container.appendChild(shortcutMenu);

  // Response context menu
  const responseMenu = createElement(doc, "div", "llm-response-menu", {
    id: "llm-response-menu",
  });
  responseMenu.style.display = "none";
  const responseMenuCopyBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-response-menu-copy",
      type: "button",
      textContent: "Copy",
    },
  );
  const responseMenuNoteBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-response-menu-note",
      type: "button",
      textContent: "Save as note",
    },
  );
  responseMenu.append(responseMenuCopyBtn, responseMenuNoteBtn);
  container.appendChild(responseMenu);

  // Prompt context menu
  const promptMenu = createElement(doc, "div", "llm-response-menu", {
    id: "llm-prompt-menu",
  });
  promptMenu.style.display = "none";
  const promptMenuEditBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-prompt-menu-edit",
      type: "button",
      textContent: "Edit",
    },
  );
  promptMenu.append(promptMenuEditBtn);
  container.appendChild(promptMenu);

  // Export menu
  const exportMenu = createElement(doc, "div", "llm-response-menu", {
    id: "llm-export-menu",
  });
  exportMenu.style.display = "none";
  const exportMenuCopyBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-export-copy",
      type: "button",
      textContent: "Copy chat as md",
    },
  );
  const exportMenuNoteBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-export-note",
      type: "button",
      textContent: "Save chat as note",
    },
  );
  exportMenu.append(exportMenuCopyBtn, exportMenuNoteBtn);
  container.appendChild(exportMenu);

  const slashMenu = createElement(doc, "div", "llm-response-menu llm-slash-menu", {
    id: "llm-slash-menu",
  });
  slashMenu.style.display = "none";
  const slashUploadBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-slash-upload-option",
      type: "button",
      textContent: "Upload files",
    },
  );
  const slashReferenceBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-slash-reference-option",
      type: "button",
      textContent: "Select references",
    },
  );
  slashMenu.append(slashUploadBtn, slashReferenceBtn);
  container.appendChild(slashMenu);

  // Retry model menu (opened from latest assistant retry action)
  const retryModelMenu = createElement(doc, "div", "llm-model-menu", {
    id: "llm-retry-model-menu",
  });
  retryModelMenu.style.display = "none";
  container.appendChild(retryModelMenu);

  // Input section
  const inputSection = createElement(doc, "div", "llm-input-section");
  const contextPreviews = createElement(doc, "div", "llm-context-previews", {
    id: "llm-context-previews",
  });
  const selectedContextList = createElement(
    doc,
    "div",
    "llm-selected-context-list",
    {
      id: "llm-selected-context-list",
    },
  );
  selectedContextList.style.display = "none";
  contextPreviews.appendChild(selectedContextList);

  const paperPreview = createElement(doc, "div", "llm-paper-context-inline", {
    id: "llm-paper-context-preview",
  });
  paperPreview.style.display = "none";
  const paperPreviewList = createElement(
    doc,
    "div",
    "llm-paper-context-inline-list",
    {
      id: "llm-paper-context-list",
    },
  );
  paperPreview.append(paperPreviewList);
  contextPreviews.appendChild(paperPreview);

  // Image preview area (shows selected screenshot)
  const imagePreview = createElement(doc, "div", "llm-image-preview", {
    id: "llm-image-preview",
  });
  imagePreview.style.display = "none";

  const imagePreviewMeta = createElement(
    doc,
    "button",
    "llm-image-preview-meta",
    {
      id: "llm-image-preview-meta",
      type: "button",
      textContent: formatFigureCountLabel(0),
      title: "Expand figures",
    },
  );
  const imagePreviewHeader = createElement(
    doc,
    "div",
    "llm-image-preview-header",
    {
      id: "llm-image-preview-header",
    },
  );
  const removeImgBtn = createElement(doc, "button", "llm-remove-img-btn", {
    id: "llm-remove-img",
    type: "button",
    textContent: "×",
    title: "Clear selected screenshots",
  });
  removeImgBtn.setAttribute("aria-label", "Clear selected screenshots");
  imagePreviewHeader.append(imagePreviewMeta, removeImgBtn);

  const imagePreviewExpanded = createElement(
    doc,
    "div",
    "llm-image-preview-expanded",
    {
      id: "llm-image-preview-expanded",
    },
  );
  const previewStrip = createElement(doc, "div", "llm-image-preview-strip", {
    id: "llm-image-preview-strip",
  });
  const previewLargeWrap = createElement(
    doc,
    "div",
    "llm-image-preview-selected",
    {
      id: "llm-image-preview-selected",
    },
  );
  const previewLargeImg = createElement(
    doc,
    "img",
    "llm-image-preview-selected-img",
    {
      id: "llm-image-preview-selected-img",
      alt: "Selected screenshot preview",
    },
  ) as HTMLImageElement;
  previewLargeWrap.appendChild(previewLargeImg);

  imagePreviewExpanded.append(previewStrip, previewLargeWrap);
  imagePreview.append(imagePreviewHeader, imagePreviewExpanded);
  contextPreviews.appendChild(imagePreview);

  const filePreview = createElement(doc, "div", "llm-image-preview", {
    id: "llm-file-context-preview",
  });
  filePreview.style.display = "none";
  const filePreviewMeta = createElement(
    doc,
    "button",
    "llm-image-preview-meta llm-file-context-meta",
    {
      id: "llm-file-context-meta",
      type: "button",
      textContent: formatFileCountLabel(0),
      title: "Expand files",
    },
  );
  const filePreviewHeader = createElement(
    doc,
    "div",
    "llm-image-preview-header",
    {
      id: "llm-file-context-header",
    },
  );
  const filePreviewClear = createElement(doc, "button", "llm-remove-img-btn", {
    id: "llm-file-context-clear",
    type: "button",
    textContent: "×",
    title: "Clear uploaded files",
  });
  filePreviewHeader.append(filePreviewMeta, filePreviewClear);
  const filePreviewExpanded = createElement(
    doc,
    "div",
    "llm-image-preview-expanded llm-file-context-expanded",
    {
      id: "llm-file-context-expanded",
    },
  );
  const filePreviewList = createElement(doc, "div", "llm-file-context-list", {
    id: "llm-file-context-list",
  });
  filePreviewExpanded.append(filePreviewList);
  filePreview.append(filePreviewHeader, filePreviewExpanded);
  contextPreviews.appendChild(filePreview);
  inputSection.appendChild(contextPreviews);

  const paperPicker = createElement(doc, "div", "llm-paper-picker", {
    id: "llm-paper-picker",
  });
  paperPicker.style.display = "none";
  const paperPickerList = createElement(doc, "div", "llm-paper-picker-list", {
    id: "llm-paper-picker-list",
  });
  paperPickerList.setAttribute("role", "listbox");
  paperPicker.appendChild(paperPickerList);
  inputSection.appendChild(paperPicker);

  const inputBox = createElement(doc, "textarea", "llm-input", {
    id: "llm-input",
    placeholder: hasItem
      ? isGlobalMode
        ? "Ask anything... Type / to add papers"
        : "Ask about this paper... Type / for adding other papers as context"
      : "Open a PDF first",
    disabled: !hasItem,
  });
  inputSection.appendChild(inputBox);

  // Actions row
  const actionsRow = createElement(doc, "div", "llm-actions");
  const actionsLeft = createElement(doc, "div", "llm-actions-left");
  const actionsRight = createElement(doc, "div", "llm-actions-right");

  const selectTextBtn = createElement(
    doc,
    "button",
    "llm-shortcut-btn llm-action-btn llm-action-btn-secondary llm-select-text-btn",
    {
      id: "llm-select-text",
      textContent: SELECT_TEXT_EXPANDED_LABEL,
      title: "Include selected reader text",
      disabled: !hasItem,
    },
  );
  const selectTextSlot = createElement(doc, "div", "llm-action-slot");
  selectTextSlot.appendChild(selectTextBtn);

  // Screenshot button
  const screenshotBtn = createElement(
    doc,
    "button",
    "llm-shortcut-btn llm-action-btn llm-action-btn-secondary llm-screenshot-btn",
    {
      id: "llm-screenshot",
      textContent: SCREENSHOT_EXPANDED_LABEL,
      title: "Select figure screenshot",
      disabled: !hasItem,
    },
  );
  const screenshotSlot = createElement(doc, "div", "llm-action-slot");
  screenshotSlot.appendChild(screenshotBtn);

  const uploadBtn = createElement(
    doc,
    "button",
    "llm-shortcut-btn llm-action-btn llm-action-btn-secondary llm-upload-file-btn llm-slash-menu-btn",
    {
      id: "llm-upload-file",
      type: "button",
      textContent: UPLOAD_FILE_EXPANDED_LABEL,
      title: "Context actions",
      disabled: !hasItem,
    },
  );
  uploadBtn.setAttribute("aria-haspopup", "menu");
  uploadBtn.setAttribute("aria-expanded", "false");
  uploadBtn.setAttribute("aria-label", "Context actions");
  const uploadInput = createElement(doc, "input", "", {
    id: "llm-upload-input",
    type: "file",
  }) as HTMLInputElement;
  uploadInput.multiple = true;
  uploadInput.style.display = "none";
  const uploadSlot = createElement(doc, "div", "llm-action-slot");
  uploadSlot.append(uploadBtn, uploadInput);

  const {
    slot: modelDropdown,
    button: modelBtn,
    menu: modelMenu,
  } = createActionDropdown(doc, {
    slotId: "llm-model-dropdown",
    slotClassName: "llm-model-dropdown",
    buttonId: "llm-model-toggle",
    buttonClassName:
      "llm-shortcut-btn llm-action-btn llm-action-btn-secondary llm-model-btn",
    buttonText: "Model: ...",
    menuId: "llm-model-menu",
    menuClassName: "llm-model-menu",
    disabled: !hasItem,
  });

  const {
    slot: reasoningDropdown,
    button: reasoningBtn,
    menu: reasoningMenu,
  } = createActionDropdown(doc, {
    slotId: "llm-reasoning-dropdown",
    slotClassName: "llm-reasoning-dropdown",
    buttonId: "llm-reasoning-toggle",
    buttonClassName:
      "llm-shortcut-btn llm-action-btn llm-action-btn-secondary llm-reasoning-btn",
    buttonText: "Reasoning",
    menuId: "llm-reasoning-menu",
    menuClassName: "llm-reasoning-menu",
    disabled: !hasItem,
  });

  const sendBtn = createElement(
    doc,
    "button",
    "llm-shortcut-btn llm-action-btn llm-action-btn-primary llm-send-btn",
    {
      id: "llm-send",
      textContent: "Send",
      title: "Send",
      disabled: !hasItem,
    },
  );
  const cancelBtn = createElement(
    doc,
    "button",
    "llm-shortcut-btn llm-action-btn llm-action-btn-danger llm-send-btn llm-cancel-btn",
    {
      id: "llm-cancel",
      textContent: "Cancel",
    },
  );
  cancelBtn.style.display = "none";
  const sendSlot = createElement(doc, "div", "llm-action-slot");
  sendSlot.append(sendBtn, cancelBtn);

  const statusLine = createElement(doc, "div", "llm-status", {
    id: "llm-status",
    textContent: hasItem
      ? isGlobalMode
        ? "No active paper context. Type / to add papers."
        : "Ready"
      : "Select an item or open a PDF",
  });

  actionsLeft.append(
    uploadSlot,
    selectTextSlot,
    screenshotSlot,
    modelDropdown,
    reasoningDropdown,
  );
  actionsRight.append(sendSlot);
  actionsRow.append(actionsLeft, actionsRight);
  inputSection.appendChild(actionsRow);
  container.appendChild(inputSection);
  container.appendChild(statusLine);
  body.appendChild(container);
}

export { buildUI };
