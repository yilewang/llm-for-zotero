import { createElement } from "../../utils/domHelpers";
import { t } from "../../utils/i18n";
import {
  PREFERENCES_PANE_ID,
  getSelectTextExpandedLabel,
  getScreenshotExpandedLabel,
  UPLOAD_FILE_EXPANDED_LABEL,
  formatFigureCountLabel,
  formatFileCountLabel,
} from "./constants";
import type { ActionDropdownSpec } from "./types";
import {
  getPaperPortalBaseItemID,
  isGlobalPortalItem,
  isPaperPortalItem,
  resolveActiveNoteSession,
  resolveDisplayConversationKind,
} from "./portalScope";

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

const globalRegistryKey = "__llm_mode_lock_registry";

/**
 * Keeps the active panel lock button display unblocked and prunes stale
 * registry entries from disposed panel bodies.
 */
export function syncGlobalLockVisibility(currentBody: Element) {
  const myZotero = (globalThis as any).Zotero || globalThis;
  if (!myZotero[globalRegistryKey]) {
    myZotero[globalRegistryKey] = new Set<Element>();
  }
  const allLocks: Set<Element> = myZotero[globalRegistryKey];

  try {
    for (const el of Array.from(allLocks)) {
      if (!el.isConnected) {
        allLocks.delete(el);
        continue;
      }
      const htmlEl = el as HTMLElement;
      // Only normalize the currently active panel lock button.
      // Writing sticky inline `display:none` to other panels can persist when
      // users switch back to a previously visited tab, causing the lock icon
      // to disappear even though lock state is still active.
      if (currentBody.contains(el)) {
        htmlEl.style.removeProperty("display");
      }
    }
  } catch (err) {
    ztoolkit.log(`LLM DEBUG: Error syncing lock visibility: ${err}`);
  }
}

function buildUI(body: Element, item?: Zotero.Item | null) {
  // Clear this section body before rebuilding.
  if (typeof (body as any).replaceChildren === "function") {
    (body as any).replaceChildren();
  } else {
    body.textContent = "";
  }
  const doc = body.ownerDocument!;
  const hasItem = Boolean(item);
  const activeNoteSession = resolveActiveNoteSession(item);
  const displayConversationKind = resolveDisplayConversationKind(item);
  const isGlobalMode = displayConversationKind === "global";
  const isPaperMode = displayConversationKind === "paper";
  const conversationItemId =
    hasItem && item
      ? item.isAttachment() && item.parentID
        ? item.parentID
        : item.id
      : 0;
  const basePaperItemId =
    hasItem && item
      ? activeNoteSession?.parentItemId ||
      (isPaperPortalItem(item)
        ? getPaperPortalBaseItemID(item) || 0
        : item.isAttachment() && item.parentID
          ? item.parentID
          : isPaperMode
            ? item.id
            : 0)
      : 0;
  const hasPaperContext = basePaperItemId > 0;

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
  container.dataset.itemId =
    conversationItemId > 0 ? `${conversationItemId}` : "";
  container.dataset.libraryId = hasItem && item ? `${item.libraryID}` : "";
  container.dataset.conversationKind = hasItem
    ? isGlobalMode
      ? "global"
      : "paper"
    : "";
  container.dataset.basePaperItemId =
    basePaperItemId > 0 ? `${basePaperItemId}` : "";
  container.dataset.noteKind = activeNoteSession?.noteKind || "";
  container.dataset.noteId = activeNoteSession?.noteId
    ? `${activeNoteSession.noteId}`
    : "";
  container.dataset.noteTitle = activeNoteSession?.title || "";
  container.dataset.noteParentItemId = activeNoteSession?.parentItemId
    ? `${activeNoteSession.parentItemId}`
    : "";

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
    textContent: t("LLM Assistant"),
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
    title: t("Start a new chat"),
  });
  historyNewBtn.setAttribute("aria-label", t("Start a new chat"));
  historyNewBtn.style.display = activeNoteSession ? "none" : "";

  // History toggle button (clock icon)
  const historyToggle = createElement(doc, "button", "llm-history-toggle", {
    id: "llm-history-toggle",
    type: "button",
    title: t("Conversation history"),
  });
  historyToggle.setAttribute("aria-label", t("Conversation history"));
  historyToggle.setAttribute("aria-haspopup", "menu");
  historyToggle.setAttribute("aria-expanded", "false");
  historyToggle.style.display = activeNoteSession ? "none" : "";

  // Mode chip: single pill showing current mode + lock
  const modeSwitchWrap = createElement(doc, "div", "llm-mode-switch", {
    id: "llm-mode-capsule",
  });
  modeSwitchWrap.dataset.mode = hasItem && isGlobalMode ? "global" : "paper";

  const modeChipBtn = createElement(doc, "button", "llm-mode-chip", {
    id: "llm-mode-chip",
    type: "button",
    textContent: hasItem && isGlobalMode
      ? (activeNoteSession ? t("Open note") : t("Open chat"))
      : (activeNoteSession ? t("Paper note") : t("Paper chat")),
    title:
      activeNoteSession
        ? hasItem && isGlobalMode
          ? t("Open note")
          : t("Paper note")
        : hasItem && isGlobalMode
          ? t("Switch to paper chat")
          : t("Switch to open chat"),
  });
  modeChipBtn.setAttribute(
    "aria-label",
    activeNoteSession
      ? hasItem && isGlobalMode
        ? t("Open note")
        : t("Paper note")
      : hasItem && isGlobalMode
        ? t("Switch to paper chat")
        : t("Switch to open chat"),
  );

  // Lock button, right of chip (only visible in open-chat mode)
  const modeLockBtn = createElement(doc, "div", "llm-mode-lock", {
    id: "llm-mode-lock",
    title: t("Lock open chat as default"),
  });
  modeLockBtn.dataset.locked = "false";
  modeLockBtn.setAttribute("aria-label", t("Lock open chat as default"));
  modeLockBtn.setAttribute("role", "button");
  modeLockBtn.setAttribute("tabindex", "0");
  modeLockBtn.style.display =
    hasItem && isGlobalMode && !activeNoteSession ? "flex" : "none";

  modeSwitchWrap.append(modeChipBtn, modeLockBtn);

  historyBar.append(historyNewBtn, historyToggle, modeSwitchWrap);

  headerInfo.append(title, historyBar);
  headerTop.appendChild(headerInfo);

  const headerActions = createElement(doc, "div", "llm-header-actions");

  const popoutBtn = createElement(doc, "button", "llm-btn-icon llm-popout-btn", {
    id: "llm-popout",
    type: "button",
    title: "Toggle floating window",
  });
  popoutBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 0 24 24" width="16" fill="currentColor"><path d="M0 0h24v24H0z" fill="none"/><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>`;
  popoutBtn.setAttribute("aria-label", "Toggle floating window");

  const lockBtn = createElement(doc, "button", "llm-btn-icon llm-lock-btn", {
    id: "llm-lock",
    type: "button",
    title: "Lock session to this floating window",
  });
  lockBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 0 24 24" width="16" fill="currentColor"><path d="M0 0h24v24H0z" fill="none"/><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>`;
  lockBtn.setAttribute("aria-label", "Lock session");
  lockBtn.style.display = "none"; // hidden by default until popped out

  const settingsBtn = createElement(doc, "button", "llm-btn-icon llm-settings-btn", {
    id: "llm-settings",
    type: "button",
    title: t("Settings"),
  });
  settingsBtn.setAttribute("aria-label", t("Open plugin settings"));
  settingsBtn.dataset.preferencesPaneId = PREFERENCES_PANE_ID;
  const exportBtn = createElement(doc, "button", "llm-btn-icon", {
    id: "llm-export",
    type: "button",
    textContent: "⤓",
    title: t("Export"),
    disabled: !hasItem,
  });
  const clearBtn = createElement(doc, "button", "llm-btn-icon", {
    id: "llm-clear",
    type: "button",
    textContent: t("Clear"),
  });
  const closeBtn = createElement(doc, "button", "llm-btn-icon llm-close-btn", {
    id: "llm-close",
    type: "button",
    title: "Close window",
  });
  closeBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 0 24 24" width="16" fill="currentColor"><path d="M0 0h24v24H0z" fill="none"/><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
  closeBtn.setAttribute("aria-label", "Close window");
  closeBtn.style.display = "none"; // hidden by default until popped out
  headerActions.append(popoutBtn, lockBtn, settingsBtn, exportBtn, clearBtn, closeBtn);
  headerTop.appendChild(headerActions);
  header.appendChild(headerTop);
  const historyMenu = createElement(doc, "div", "llm-history-menu", {
    id: "llm-history-menu",
  });
  historyMenu.style.display = "none";
  header.appendChild(historyMenu);

  const historyRowMenu = createElement(doc, "div", "llm-history-row-menu", {
    id: "llm-history-row-menu",
  });
  historyRowMenu.style.display = "none";
  const historyRowRenameBtn = createElement(
    doc,
    "button",
    "llm-history-row-menu-item",
    {
      id: "llm-history-row-rename",
      type: "button",
      textContent: t("Rename"),
      title: t("Rename chat"),
    },
  );
  historyRowMenu.append(historyRowRenameBtn);
  header.appendChild(historyRowMenu);

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
    textContent: t("Undo"),
    title: t("Restore deleted conversation"),
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
    textContent: t("Edit"),
  });
  const menuDeleteBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-delete",
    type: "button",
    textContent: t("Delete"),
  });
  const menuAddBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-add",
    type: "button",
    textContent: t("Add"),
  });
  const menuMoveBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-move",
    type: "button",
    textContent: t("Move"),
  });
  const menuResetBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-reset",
    type: "button",
    textContent: t("Reset"),
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
      textContent: t("Copy"),
    },
  );
  const responseMenuNoteBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-response-menu-note",
      type: "button",
      textContent: t("Save as note"),
    },
  );
  const responseMenuDeleteBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-response-menu-delete",
      type: "button",
      textContent: t("Delete this turn"),
      title: t("Delete this prompt and response"),
    },
  );
  responseMenu.append(
    responseMenuCopyBtn,
    responseMenuNoteBtn,
    responseMenuDeleteBtn,
  );
  container.appendChild(responseMenu);

  // Prompt context menu
  const promptMenu = createElement(doc, "div", "llm-response-menu", {
    id: "llm-prompt-menu",
  });
  promptMenu.style.display = "none";
  const promptMenuDeleteBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-prompt-menu-delete",
      type: "button",
      textContent: t("Delete this turn"),
      title: t("Delete this prompt and response"),
    },
  );
  promptMenu.append(promptMenuDeleteBtn);
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
      textContent: t("Copy chat as md"),
    },
  );
  const exportMenuNoteBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-export-note",
      type: "button",
      textContent: t("Save chat as note"),
    },
  );
  exportMenu.append(exportMenuCopyBtn, exportMenuNoteBtn);
  container.appendChild(exportMenu);

  const slashMenu = createElement(
    doc,
    "div",
    "llm-response-menu llm-slash-menu",
    {
      id: "llm-slash-menu",
    },
  );
  slashMenu.style.display = "none";
  const slashList = createElement(doc, "div", "llm-action-picker-list", {});
  const makeSlashItem = (id: string, title: string, desc: string) => {
    const btn = createElement(doc, "button", "llm-action-picker-item", {
      id,
      type: "button",
    });
    const titleEl = createElement(doc, "span", "llm-action-picker-title", {
      textContent: title,
    });
    const descEl = createElement(doc, "span", "llm-action-picker-description", {
      textContent: desc,
    });
    btn.append(titleEl, descEl);
    return btn;
  };
  const slashUploadBtn = makeSlashItem(
    "llm-slash-upload-option",
    t("Upload files"),
    t("Add documents or images"),
  );
  const slashReferenceBtn = makeSlashItem(
    "llm-slash-reference-option",
    t("Select references"),
    t("Add papers from your library"),
  );
  const slashPdfPageBtn = makeSlashItem(
    "llm-slash-pdf-page-option",
    t("Send current PDF page"),
    t("Capture the visible page as an image"),
  );
  slashList.append(slashUploadBtn, slashReferenceBtn, slashPdfPageBtn);
  slashMenu.append(slashList);
  // slashMenu is appended to composeArea below (after composeArea is created)

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
  const runtimeModeBtn = createElement(
    doc,
    "button",
    "llm-context-agent-toggle llm-agent-process-summary",
    {
      id: "llm-runtime-mode-toggle",
      type: "button",
      title: t("Switch to Agent mode"),
      disabled: !hasItem,
    },
  );
  runtimeModeBtn.setAttribute("aria-label", t("Switch to Agent mode"));
  runtimeModeBtn.setAttribute("aria-pressed", "false");
  const runtimeModeIndicator = createElement(
    doc,
    "span",
    "llm-agent-toggle-indicator",
  );
  runtimeModeIndicator.setAttribute("aria-hidden", "true");
  const runtimeModeLabel = createElement(
    doc,
    "span",
    "llm-agent-toggle-label llm-agent-process-summary-label",
    {
      textContent: t("Agent mode"),
    },
  );
  runtimeModeBtn.append(runtimeModeIndicator, runtimeModeLabel);
  contextPreviews.appendChild(runtimeModeBtn);
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
      title: t("Expand figures"),
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
    title: t("Clear selected screenshots"),
  });
  removeImgBtn.setAttribute("aria-label", t("Clear selected screenshots"));
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
      alt: t("Selected screenshot preview"),
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
      title: t("Expand files"),
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
    title: t("Clear uploaded files"),
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

  const composeArea = createElement(doc, "div", "llm-compose-area", {
    id: "llm-compose-area",
  });
  inputSection.appendChild(composeArea);

  const paperPicker = createElement(doc, "div", "llm-paper-picker", {
    id: "llm-paper-picker",
  });
  paperPicker.style.display = "none";
  const paperPickerList = createElement(doc, "div", "llm-paper-picker-list", {
    id: "llm-paper-picker-list",
  });
  paperPickerList.setAttribute("role", "listbox");
  paperPicker.appendChild(paperPickerList);
  composeArea.appendChild(paperPicker);

  const actionPicker = createElement(doc, "div", "llm-action-picker", {
    id: "llm-action-picker",
  });
  actionPicker.style.display = "none";
  const actionPickerList = createElement(doc, "div", "llm-action-picker-list", {
    id: "llm-action-picker-list",
  });
  actionPickerList.setAttribute("role", "listbox");
  actionPicker.appendChild(actionPickerList);
  composeArea.appendChild(actionPicker);
  composeArea.appendChild(slashMenu);

  const actionHitlPanel = createElement(doc, "div", "llm-action-hitl-panel", {
    id: "llm-action-hitl-panel",
  });
  actionHitlPanel.style.display = "none";
  composeArea.appendChild(actionHitlPanel);

  const inputBox = createElement(doc, "textarea", "llm-input", {
    id: "llm-input",
    placeholder: hasItem
      ? isGlobalMode
        ? t("Ask anything... Type / for actions, @ to add papers")
        : t("Ask about this paper... Type / for actions, @ to add papers")
      : t("Open a PDF first"),
    disabled: !hasItem,
  });
  composeArea.appendChild(inputBox);

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
      textContent: getSelectTextExpandedLabel(),
      title: t("Include selected reader text"),
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
      textContent: getScreenshotExpandedLabel(),
      title: t("Select figure screenshot"),
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
      title: t("Context actions"),
      disabled: !hasItem,
    },
  );
  uploadBtn.setAttribute("aria-haspopup", "menu");
  uploadBtn.setAttribute("aria-expanded", "false");
  uploadBtn.setAttribute("aria-label", t("Context actions"));
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
    buttonText: t("Reasoning"),
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
      textContent: t("Send"),
      title: t("Send"),
      disabled: !hasItem,
    },
  );
  const cancelBtn = createElement(
    doc,
    "button",
    "llm-shortcut-btn llm-action-btn llm-action-btn-danger llm-send-btn llm-cancel-btn",
    {
      id: "llm-cancel",
      textContent: t("Cancel"),
    },
  );
  cancelBtn.style.display = "none";
  const sendSlot = createElement(doc, "div", "llm-action-slot");
  sendSlot.append(sendBtn, cancelBtn);

  const statusBar = createElement(doc, "div", "llm-status-bar");
  const statusLine = createElement(doc, "div", "llm-status", {
    id: "llm-status",
    textContent: hasItem
      ? isGlobalMode
        ? t("No active paper context. Type / to add papers.")
        : t("Ready")
      : t("Select an item or open a PDF"),
  });
  const tokenUsage = createElement(doc, "span", "llm-token-usage", {
    id: "llm-token-usage",
  });
  statusBar.append(statusLine, tokenUsage);

  actionsLeft.append(
    uploadSlot,
    selectTextSlot,
    screenshotSlot,
    modelDropdown,
    reasoningDropdown,
  );
  actionsRight.append(sendSlot);
  actionsRow.append(actionsLeft, actionsRight);
  composeArea.appendChild(actionsRow);
  container.appendChild(inputSection);
  container.appendChild(statusBar);
  body.appendChild(container);

  // ---------- Sync visibility ----------
  const myZotero = (globalThis as any).Zotero || globalThis;
  if (!myZotero[globalRegistryKey]) {
    myZotero[globalRegistryKey] = new Set<Element>();
  }
  const allLocks: Set<Element> = myZotero[globalRegistryKey];
  allLocks.add(modeLockBtn);

  syncGlobalLockVisibility(body);
}

export { buildUI };
