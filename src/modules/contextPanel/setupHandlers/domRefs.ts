export type PanelDomRefs = {
  inputBox: HTMLTextAreaElement | null;
  inputSection: HTMLDivElement | null;
  sendBtn: HTMLButtonElement | null;
  cancelBtn: HTMLButtonElement | null;
  modelBtn: HTMLButtonElement | null;
  modelSlot: HTMLDivElement | null;
  modelMenu: HTMLDivElement | null;
  reasoningBtn: HTMLButtonElement | null;
  runtimeModeBtn: HTMLButtonElement | null;
  reasoningSlot: HTMLDivElement | null;
  reasoningMenu: HTMLDivElement | null;
  actionsRow: HTMLDivElement | null;
  actionsLeft: HTMLDivElement | null;
  actionsRight: HTMLDivElement | null;
  popoutBtn: HTMLButtonElement | null;
  lockBtn: HTMLButtonElement | null;
  settingsBtn: HTMLButtonElement | null;
  exportBtn: HTMLButtonElement | null;
  clearBtn: HTMLButtonElement | null;
  minBtn: HTMLButtonElement | null;
  maxBtn: HTMLButtonElement | null;
  closeBtn: HTMLButtonElement | null;
  titleStatic: HTMLDivElement | null;
  historyBar: HTMLDivElement | null;
  historyNewBtn: HTMLButtonElement | null;
  historyNewMenu: HTMLDivElement | null;
  historyNewOpenBtn: HTMLButtonElement | null;
  historyNewPaperBtn: HTMLButtonElement | null;
  historyToggleBtn: HTMLButtonElement | null;
  historyModeIndicator: HTMLButtonElement | null;
  historyMenu: HTMLDivElement | null;
  modeCapsule: HTMLElement | null;
  modeChipBtn: HTMLButtonElement | null;
  modeLockBtn: HTMLElement | null;
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
  slashPdfPageOption: HTMLButtonElement | null;
  slashPdfMultiplePagesOption: HTMLButtonElement | null;
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
  actionPicker: HTMLDivElement | null;
  actionPickerList: HTMLDivElement | null;
  actionHitlPanel: HTMLDivElement | null;
  responseMenu: HTMLDivElement | null;
  responseMenuCopyBtn: HTMLButtonElement | null;
  responseMenuNoteBtn: HTMLButtonElement | null;
  responseMenuDeleteBtn: HTMLButtonElement | null;
  promptMenu: HTMLDivElement | null;
  promptMenuDeleteBtn: HTMLButtonElement | null;
  exportMenu: HTMLDivElement | null;
  exportMenuCopyBtn: HTMLButtonElement | null;
  exportMenuNoteBtn: HTMLButtonElement | null;
  retryModelMenu: HTMLDivElement | null;
  status: HTMLElement | null;
  tokenUsageEl: HTMLElement | null;
  chatBox: HTMLDivElement | null;
  panelRoot: HTMLDivElement | null;
};

export function getPanelDomRefs(body: Element): PanelDomRefs {
  return {
    inputBox: ((body as any).__llmFloatedPanel || body).querySelector("#llm-input") as HTMLTextAreaElement | null,
    inputSection: ((body as any).__llmFloatedPanel || body).querySelector(
      ".llm-input-section",
    ) as HTMLDivElement | null,
    sendBtn: ((body as any).__llmFloatedPanel || body).querySelector("#llm-send") as HTMLButtonElement | null,
    cancelBtn: ((body as any).__llmFloatedPanel || body).querySelector("#llm-cancel") as HTMLButtonElement | null,
    modelBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-model-toggle",
    ) as HTMLButtonElement | null,
    modelSlot: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-model-dropdown",
    ) as HTMLDivElement | null,
    modelMenu: ((body as any).__llmFloatedPanel || body).querySelector("#llm-model-menu") as HTMLDivElement | null,
    reasoningBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-reasoning-toggle",
    ) as HTMLButtonElement | null,
    runtimeModeBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-runtime-mode-toggle",
    ) as HTMLButtonElement | null,
    reasoningSlot: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-reasoning-dropdown",
    ) as HTMLDivElement | null,
    reasoningMenu: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-reasoning-menu",
    ) as HTMLDivElement | null,
    actionsRow: ((body as any).__llmFloatedPanel || body).querySelector(".llm-actions") as HTMLDivElement | null,
    actionsLeft: ((body as any).__llmFloatedPanel || body).querySelector(
      ".llm-actions-left",
    ) as HTMLDivElement | null,
    actionsRight: ((body as any).__llmFloatedPanel || body).querySelector(
      ".llm-actions-right",
    ) as HTMLDivElement | null,
    popoutBtn: ((body as any).__llmFloatedPanel || body).querySelector("#llm-popout") as HTMLButtonElement | null,
    lockBtn: ((body as any).__llmFloatedPanel || body).querySelector("#llm-lock") as HTMLButtonElement | null,
    settingsBtn: ((body as any).__llmFloatedPanel || body).querySelector("#llm-settings") as HTMLButtonElement | null,
    exportBtn: ((body as any).__llmFloatedPanel || body).querySelector("#llm-export") as HTMLButtonElement | null,
    clearBtn: ((body as any).__llmFloatedPanel || body).querySelector("#llm-clear") as HTMLButtonElement | null,
    minBtn: ((body as any).__llmFloatedPanel || body).querySelector("#llm-minimize") as HTMLButtonElement | null,
    maxBtn: ((body as any).__llmFloatedPanel || body).querySelector("#llm-maximize") as HTMLButtonElement | null,
    closeBtn: ((body as any).__llmFloatedPanel || body).querySelector("#llm-close") as HTMLButtonElement | null,
    titleStatic: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-title-static",
    ) as HTMLDivElement | null,
    historyBar: ((body as any).__llmFloatedPanel || body).querySelector("#llm-history-bar") as HTMLDivElement | null,
    historyNewBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-history-new",
    ) as HTMLButtonElement | null,
    historyNewMenu: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-history-new-menu",
    ) as HTMLDivElement | null,
    historyNewOpenBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-history-new-open",
    ) as HTMLButtonElement | null,
    historyNewPaperBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-history-new-paper",
    ) as HTMLButtonElement | null,
    historyToggleBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-history-toggle",
    ) as HTMLButtonElement | null,
    historyModeIndicator: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-history-toggle",
    ) as HTMLButtonElement | null,
    modeCapsule: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-mode-capsule",
    ) as HTMLElement | null,
    modeChipBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-mode-chip",
    ) as HTMLButtonElement | null,
    modeLockBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-mode-lock",
    ) as HTMLElement | null,
    historyMenu: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-history-menu",
    ) as HTMLDivElement | null,
    historyRowMenu: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-history-row-menu",
    ) as HTMLDivElement | null,
    historyRowRenameBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-history-row-rename",
    ) as HTMLButtonElement | null,
    historyUndo: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-history-undo",
    ) as HTMLDivElement | null,
    historyUndoText: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-history-undo-text",
    ) as HTMLSpanElement | null,
    historyUndoBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-history-undo-btn",
    ) as HTMLButtonElement | null,
    selectTextBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-select-text",
    ) as HTMLButtonElement | null,
    screenshotBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-screenshot",
    ) as HTMLButtonElement | null,
    uploadBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-upload-file",
    ) as HTMLButtonElement | null,
    uploadInput: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-upload-input",
    ) as HTMLInputElement | null,
    slashMenu: ((body as any).__llmFloatedPanel || body).querySelector("#llm-slash-menu") as HTMLDivElement | null,
    slashUploadOption: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-slash-upload-option",
    ) as HTMLButtonElement | null,
    slashReferenceOption: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-slash-reference-option",
    ) as HTMLButtonElement | null,
    slashPdfPageOption: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-slash-pdf-page-option",
    ) as HTMLButtonElement | null,
    slashPdfMultiplePagesOption: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-slash-pdf-multiple-pages-option",
    ) as HTMLButtonElement | null,
    imagePreview: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-image-preview",
    ) as HTMLDivElement | null,
    selectedContextList: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-selected-context-list",
    ) as HTMLDivElement | null,
    previewStrip: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-image-preview-strip",
    ) as HTMLDivElement | null,
    previewExpanded: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-image-preview-expanded",
    ) as HTMLDivElement | null,
    previewSelected: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-image-preview-selected",
    ) as HTMLDivElement | null,
    previewSelectedImg: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-image-preview-selected-img",
    ) as HTMLImageElement | null,
    previewMeta: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-image-preview-meta",
    ) as HTMLButtonElement | null,
    removeImgBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-remove-img",
    ) as HTMLButtonElement | null,
    filePreview: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-file-context-preview",
    ) as HTMLDivElement | null,
    filePreviewMeta: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-file-context-meta",
    ) as HTMLButtonElement | null,
    filePreviewExpanded: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-file-context-expanded",
    ) as HTMLDivElement | null,
    filePreviewList: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-file-context-list",
    ) as HTMLDivElement | null,
    filePreviewClear: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-file-context-clear",
    ) as HTMLButtonElement | null,
    paperPreview: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-paper-context-preview",
    ) as HTMLDivElement | null,
    paperPreviewList: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-paper-context-list",
    ) as HTMLDivElement | null,
    paperPicker: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-paper-picker",
    ) as HTMLDivElement | null,
    paperPickerList: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-paper-picker-list",
    ) as HTMLDivElement | null,
    actionPicker: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-action-picker",
    ) as HTMLDivElement | null,
    actionPickerList: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-action-picker-list",
    ) as HTMLDivElement | null,
    actionHitlPanel: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-action-hitl-panel",
    ) as HTMLDivElement | null,
    responseMenu: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-response-menu",
    ) as HTMLDivElement | null,
    responseMenuCopyBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-response-menu-copy",
    ) as HTMLButtonElement | null,
    responseMenuNoteBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-response-menu-note",
    ) as HTMLButtonElement | null,
    responseMenuDeleteBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-response-menu-delete",
    ) as HTMLButtonElement | null,
    promptMenu: ((body as any).__llmFloatedPanel || body).querySelector("#llm-prompt-menu") as HTMLDivElement | null,
    promptMenuDeleteBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-prompt-menu-delete",
    ) as HTMLButtonElement | null,
    exportMenu: ((body as any).__llmFloatedPanel || body).querySelector("#llm-export-menu") as HTMLDivElement | null,
    exportMenuCopyBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-export-copy",
    ) as HTMLButtonElement | null,
    exportMenuNoteBtn: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-export-note",
    ) as HTMLButtonElement | null,
    retryModelMenu: ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-retry-model-menu",
    ) as HTMLDivElement | null,
    status: ((body as any).__llmFloatedPanel || body).querySelector("#llm-status") as HTMLElement | null,
    tokenUsageEl: ((body as any).__llmFloatedPanel || body).querySelector("#llm-token-usage") as HTMLElement | null,
    chatBox: ((body as any).__llmFloatedPanel || body).querySelector("#llm-chat-box") as HTMLDivElement | null,
    panelRoot: ((body as any).__llmFloatedPanel || body).querySelector("#llm-main") as HTMLDivElement | null,
  };
}
