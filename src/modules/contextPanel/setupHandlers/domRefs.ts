export type PanelDomRefs = {
  inputBox: HTMLTextAreaElement | null;
  inputSection: HTMLDivElement | null;
  sendBtn: HTMLButtonElement | null;
  cancelBtn: HTMLButtonElement | null;
  modelBtn: HTMLButtonElement | null;
  modelSlot: HTMLDivElement | null;
  modelMenu: HTMLDivElement | null;
  reasoningBtn: HTMLButtonElement | null;
  reasoningSlot: HTMLDivElement | null;
  reasoningMenu: HTMLDivElement | null;
  actionsRow: HTMLDivElement | null;
  actionsLeft: HTMLDivElement | null;
  actionsRight: HTMLDivElement | null;
  exportBtn: HTMLButtonElement | null;
  clearBtn: HTMLButtonElement | null;
  titleStatic: HTMLDivElement | null;
  historyBar: HTMLDivElement | null;
  historyNewBtn: HTMLButtonElement | null;
  historyNewMenu: HTMLDivElement | null;
  historyNewOpenBtn: HTMLButtonElement | null;
  historyNewPaperBtn: HTMLButtonElement | null;
  historyToggleBtn: HTMLButtonElement | null;
  historyModeIndicator: HTMLSpanElement | null;
  historyMenu: HTMLDivElement | null;
  historyRowMenu: HTMLDivElement | null;
  historyRowRenameBtn: HTMLButtonElement | null;
  historyUndo: HTMLDivElement | null;
  historyUndoText: HTMLSpanElement | null;
  historyUndoBtn: HTMLButtonElement | null;
  selectTextBtn: HTMLButtonElement | null;
  screenshotBtn: HTMLButtonElement | null;
  uploadBtn: HTMLButtonElement | null;
  uploadInput: HTMLInputElement | null;
  slashMenu: HTMLDivElement | null;
  slashUploadOption: HTMLButtonElement | null;
  slashReferenceOption: HTMLButtonElement | null;
  imagePreview: HTMLDivElement | null;
  selectedContextList: HTMLDivElement | null;
  previewStrip: HTMLDivElement | null;
  previewExpanded: HTMLDivElement | null;
  previewSelected: HTMLDivElement | null;
  previewSelectedImg: HTMLImageElement | null;
  previewMeta: HTMLButtonElement | null;
  removeImgBtn: HTMLButtonElement | null;
  filePreview: HTMLDivElement | null;
  filePreviewMeta: HTMLButtonElement | null;
  filePreviewExpanded: HTMLDivElement | null;
  filePreviewList: HTMLDivElement | null;
  filePreviewClear: HTMLButtonElement | null;
  paperPreview: HTMLDivElement | null;
  paperPreviewList: HTMLDivElement | null;
  paperPicker: HTMLDivElement | null;
  paperPickerList: HTMLDivElement | null;
  responseMenu: HTMLDivElement | null;
  responseMenuCopyBtn: HTMLButtonElement | null;
  responseMenuNoteBtn: HTMLButtonElement | null;
  promptMenu: HTMLDivElement | null;
  promptMenuEditBtn: HTMLButtonElement | null;
  exportMenu: HTMLDivElement | null;
  exportMenuCopyBtn: HTMLButtonElement | null;
  exportMenuNoteBtn: HTMLButtonElement | null;
  retryModelMenu: HTMLDivElement | null;
  status: HTMLElement | null;
  chatBox: HTMLDivElement | null;
  panelRoot: HTMLDivElement | null;
};

export function getPanelDomRefs(body: Element): PanelDomRefs {
  return {
    inputBox: body.querySelector("#llm-input") as HTMLTextAreaElement | null,
    inputSection: body.querySelector(".llm-input-section") as HTMLDivElement | null,
    sendBtn: body.querySelector("#llm-send") as HTMLButtonElement | null,
    cancelBtn: body.querySelector("#llm-cancel") as HTMLButtonElement | null,
    modelBtn: body.querySelector("#llm-model-toggle") as HTMLButtonElement | null,
    modelSlot: body.querySelector("#llm-model-dropdown") as HTMLDivElement | null,
    modelMenu: body.querySelector("#llm-model-menu") as HTMLDivElement | null,
    reasoningBtn: body.querySelector(
      "#llm-reasoning-toggle",
    ) as HTMLButtonElement | null,
    reasoningSlot: body.querySelector(
      "#llm-reasoning-dropdown",
    ) as HTMLDivElement | null,
    reasoningMenu: body.querySelector("#llm-reasoning-menu") as HTMLDivElement | null,
    actionsRow: body.querySelector(".llm-actions") as HTMLDivElement | null,
    actionsLeft: body.querySelector(".llm-actions-left") as HTMLDivElement | null,
    actionsRight: body.querySelector(".llm-actions-right") as HTMLDivElement | null,
    exportBtn: body.querySelector("#llm-export") as HTMLButtonElement | null,
    clearBtn: body.querySelector("#llm-clear") as HTMLButtonElement | null,
    titleStatic: body.querySelector("#llm-title-static") as HTMLDivElement | null,
    historyBar: body.querySelector("#llm-history-bar") as HTMLDivElement | null,
    historyNewBtn: body.querySelector("#llm-history-new") as HTMLButtonElement | null,
    historyNewMenu: body.querySelector("#llm-history-new-menu") as HTMLDivElement | null,
    historyNewOpenBtn: body.querySelector(
      "#llm-history-new-open",
    ) as HTMLButtonElement | null,
    historyNewPaperBtn: body.querySelector(
      "#llm-history-new-paper",
    ) as HTMLButtonElement | null,
    historyToggleBtn: body.querySelector(
      "#llm-history-toggle",
    ) as HTMLButtonElement | null,
    historyModeIndicator: body.querySelector(
      "#llm-history-mode-indicator",
    ) as HTMLSpanElement | null,
    historyMenu: body.querySelector("#llm-history-menu") as HTMLDivElement | null,
    historyRowMenu: body.querySelector(
      "#llm-history-row-menu",
    ) as HTMLDivElement | null,
    historyRowRenameBtn: body.querySelector(
      "#llm-history-row-rename",
    ) as HTMLButtonElement | null,
    historyUndo: body.querySelector("#llm-history-undo") as HTMLDivElement | null,
    historyUndoText: body.querySelector("#llm-history-undo-text") as HTMLSpanElement | null,
    historyUndoBtn: body.querySelector(
      "#llm-history-undo-btn",
    ) as HTMLButtonElement | null,
    selectTextBtn: body.querySelector("#llm-select-text") as HTMLButtonElement | null,
    screenshotBtn: body.querySelector("#llm-screenshot") as HTMLButtonElement | null,
    uploadBtn: body.querySelector("#llm-upload-file") as HTMLButtonElement | null,
    uploadInput: body.querySelector("#llm-upload-input") as HTMLInputElement | null,
    slashMenu: body.querySelector("#llm-slash-menu") as HTMLDivElement | null,
    slashUploadOption: body.querySelector(
      "#llm-slash-upload-option",
    ) as HTMLButtonElement | null,
    slashReferenceOption: body.querySelector(
      "#llm-slash-reference-option",
    ) as HTMLButtonElement | null,
    imagePreview: body.querySelector("#llm-image-preview") as HTMLDivElement | null,
    selectedContextList: body.querySelector(
      "#llm-selected-context-list",
    ) as HTMLDivElement | null,
    previewStrip: body.querySelector("#llm-image-preview-strip") as HTMLDivElement | null,
    previewExpanded: body.querySelector(
      "#llm-image-preview-expanded",
    ) as HTMLDivElement | null,
    previewSelected: body.querySelector(
      "#llm-image-preview-selected",
    ) as HTMLDivElement | null,
    previewSelectedImg: body.querySelector(
      "#llm-image-preview-selected-img",
    ) as HTMLImageElement | null,
    previewMeta: body.querySelector("#llm-image-preview-meta") as HTMLButtonElement | null,
    removeImgBtn: body.querySelector("#llm-remove-img") as HTMLButtonElement | null,
    filePreview: body.querySelector("#llm-file-context-preview") as HTMLDivElement | null,
    filePreviewMeta: body.querySelector(
      "#llm-file-context-meta",
    ) as HTMLButtonElement | null,
    filePreviewExpanded: body.querySelector(
      "#llm-file-context-expanded",
    ) as HTMLDivElement | null,
    filePreviewList: body.querySelector("#llm-file-context-list") as HTMLDivElement | null,
    filePreviewClear: body.querySelector(
      "#llm-file-context-clear",
    ) as HTMLButtonElement | null,
    paperPreview: body.querySelector("#llm-paper-context-preview") as HTMLDivElement | null,
    paperPreviewList: body.querySelector("#llm-paper-context-list") as HTMLDivElement | null,
    paperPicker: body.querySelector("#llm-paper-picker") as HTMLDivElement | null,
    paperPickerList: body.querySelector("#llm-paper-picker-list") as HTMLDivElement | null,
    responseMenu: body.querySelector("#llm-response-menu") as HTMLDivElement | null,
    responseMenuCopyBtn: body.querySelector(
      "#llm-response-menu-copy",
    ) as HTMLButtonElement | null,
    responseMenuNoteBtn: body.querySelector(
      "#llm-response-menu-note",
    ) as HTMLButtonElement | null,
    promptMenu: body.querySelector("#llm-prompt-menu") as HTMLDivElement | null,
    promptMenuEditBtn: body.querySelector(
      "#llm-prompt-menu-edit",
    ) as HTMLButtonElement | null,
    exportMenu: body.querySelector("#llm-export-menu") as HTMLDivElement | null,
    exportMenuCopyBtn: body.querySelector("#llm-export-copy") as HTMLButtonElement | null,
    exportMenuNoteBtn: body.querySelector("#llm-export-note") as HTMLButtonElement | null,
    retryModelMenu: body.querySelector("#llm-retry-model-menu") as HTMLDivElement | null,
    status: body.querySelector("#llm-status") as HTMLElement | null,
    chatBox: body.querySelector("#llm-chat-box") as HTMLDivElement | null,
    panelRoot: body.querySelector("#llm-main") as HTMLDivElement | null,
  };
}
