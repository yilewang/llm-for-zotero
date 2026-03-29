import { MAX_SELECTED_IMAGES } from "../../constants";
import type { PdfSupport } from "../../../../providers";
import type { ProviderProtocol } from "../../../../utils/providerProtocol";
import type {
  AdvancedModelParams,
  ChatAttachment,
  ChatRuntimeMode,
  NoteContextRef,
  PaperContextRef,
  SelectedTextContext,
} from "../../types";
import type { SelectedTextSource } from "../../types";
import type { EditLatestTurnMarker, EditLatestTurnResult } from "../../chat";
import type { ReasoningConfig as LLMReasoningConfig } from "../../../../utils/llmClient";
import { preparePdfComposeInputs } from "./pdfComposePreparation";

type StatusLevel = "ready" | "warning" | "error";

type SelectedProfile = {
  entryId: string;
  model: string;
  apiBase: string;
  apiKey: string;
  providerLabel: string;
  authMode?: "api_key" | "codex_auth" | "copilot_auth";
  providerProtocol?: ProviderProtocol;
};

type LatestEditablePair = {
  conversationKey: number;
  pair: {
    userMessage: {
      timestamp: number;
    };
    assistantMessage: {
      timestamp: number;
      streaming?: boolean;
    };
  };
};

type SendFlowControllerDeps = {
  body: Element;
  inputBox: HTMLTextAreaElement;
  getItem: () => Zotero.Item | null;
  closeSlashMenu: () => void;
  closePaperPicker: () => void;
  getSelectedTextContextEntries: (itemId: number) => SelectedTextContext[];
  getSelectedPaperContexts: (itemId: number) => PaperContextRef[];
  getFullTextPaperContexts: (
    item: Zotero.Item,
    paperContexts: PaperContextRef[],
  ) => PaperContextRef[];
  getPdfModePaperContexts: (
    item: Zotero.Item,
    paperContexts: PaperContextRef[],
  ) => PaperContextRef[];
  resolvePdfPaperAttachments: (
    paperContexts: PaperContextRef[],
  ) => Promise<ChatAttachment[]>;
  renderPdfPagesAsImages: (
    paperContexts: PaperContextRef[],
  ) => Promise<string[]>;
  getModelPdfSupport: (
    modelName: string,
    providerProtocol?: string,
    authMode?: string,
    apiBase?: string,
  ) => PdfSupport;
  uploadPdfForProvider: (params: {
    apiBase: string;
    apiKey: string;
    pdfBytes: Uint8Array;
    fileName: string;
  }) => Promise<{ systemMessageContent: string; label: string } | null>;
  resolvePdfBytes: (paperContext: PaperContextRef) => Promise<Uint8Array>;
  getSelectedFiles: (itemId: number) => ChatAttachment[];
  getSelectedImages: (itemId: number) => string[];
  resolvePromptText: (
    text: string,
    selectedText: string,
    hasAttachmentContext: boolean,
  ) => string;
  buildQuestionWithSelectedTextContexts: (
    selectedTexts: string[],
    selectedTextSources: SelectedTextSource[],
    promptText: string,
    options?: {
      selectedTextPaperContexts?: (PaperContextRef | undefined)[];
      includePaperAttribution?: boolean;
    },
  ) => string;
  buildModelPromptWithFileContext: (
    question: string,
    attachments: ChatAttachment[],
  ) => string;
  isAgentMode: () => boolean;
  isGlobalMode: () => boolean;
  normalizeConversationTitleSeed: (raw: unknown) => string;
  getConversationKey: (item: Zotero.Item) => number;
  touchGlobalConversationTitle: (
    conversationKey: number,
    title: string,
  ) => Promise<void>;
  touchPaperConversationTitle: (
    conversationKey: number,
    title: string,
  ) => Promise<void>;
  getSelectedProfile: () => SelectedProfile | null;
  getCurrentModelName: () => string;
  isScreenshotUnsupportedModel: (modelName: string) => boolean;
  getSelectedReasoning: () => LLMReasoningConfig | undefined;
  getAdvancedModelParams: (
    entryId: string | undefined,
  ) => AdvancedModelParams | undefined;
  getActiveEditSession: () => EditLatestTurnMarker | null;
  setActiveEditSession: (value: EditLatestTurnMarker | null) => void;
  getLatestEditablePair: () => Promise<LatestEditablePair | null>;
  editLatestUserMessageAndRetry: (
    opts: import("../../types").EditRetryOptions,
  ) => Promise<EditLatestTurnResult>;
  sendQuestion: (
    opts: import("../../types").SendQuestionOptions,
  ) => Promise<void>;
  retainPinnedImageState: (itemId: number) => void;
  retainPaperState: (itemId: number) => void;
  consumePaperModeState: (itemId: number) => void;
  retainPinnedFileState: (itemId: number) => void;
  retainPinnedTextState: (conversationKey: number) => void;
  updatePaperPreviewPreservingScroll: () => void;
  updateFilePreviewPreservingScroll: () => void;
  updateImagePreviewPreservingScroll: () => void;
  updateSelectedTextPreviewPreservingScroll: () => void;
  scheduleAttachmentGc: () => void;
  refreshGlobalHistoryHeader: () => void;
  persistDraftInput: () => void;
  autoLockGlobalChat: () => void;
  autoUnlockGlobalChat: () => void;
  setStatusMessage?: (message: string, level: StatusLevel) => void;
  editStaleStatusText: string;
};

export function createSendFlowController(deps: SendFlowControllerDeps): {
  doSend: () => Promise<void>;
} {
  const doSend = async () => {
    const item = deps.getItem();
    if (!item) return;

    deps.closeSlashMenu();
    deps.closePaperPicker();
    deps.autoLockGlobalChat();

    try {
    const textContextConversationKey = deps.getConversationKey(item);
    const text = deps.inputBox.value.trim();
    const selectedContexts = deps.getSelectedTextContextEntries(
      textContextConversationKey,
    );
    const selectedTexts = selectedContexts.map((entry) => entry.text);
    const selectedTextSources = selectedContexts.map((entry) => entry.source);
    const selectedTextPaperContexts = selectedContexts.map(
      (entry) => entry.paperContext,
    );
    const selectedTextNoteContexts = selectedContexts.map(
      (entry) => entry.noteContext,
    );
    const primarySelectedText = selectedTexts[0] || "";
    const allSelectedPaperContexts = deps.getSelectedPaperContexts(item.id);
    // Agent mode always uses text/MinerU pipeline — it can fetch PDF pages on demand
    const isAgent = deps.isAgentMode();
    const pdfModePaperContexts = isAgent
      ? []
      : deps.getPdfModePaperContexts(item, allSelectedPaperContexts);
    // Papers in PDF mode are sent as file attachments, not through the text pipeline
    const pdfModeKeySet = new Set(
      pdfModePaperContexts.map((p) => `${p.itemId}:${p.contextItemId}`),
    );
    const selectedPaperContexts = allSelectedPaperContexts.filter(
      (p) => !pdfModeKeySet.has(`${p.itemId}:${p.contextItemId}`),
    );
    const fullTextPaperContexts = deps.getFullTextPaperContexts(
      item,
      selectedPaperContexts,
    );
    // Resolve PDF-mode papers based on model capability
    const earlyProfile = deps.getSelectedProfile();
    const earlyModelName = (
      earlyProfile?.model || deps.getCurrentModelName() || ""
    ).trim();
    const pdfSupport = deps.getModelPdfSupport(
      earlyModelName, earlyProfile?.providerProtocol, earlyProfile?.authMode, earlyProfile?.apiBase,
    );
    let pdfFileAttachments: ChatAttachment[] = [];
    let pdfPageImageDataUrls: string[] = [];
    let pdfUploadSystemMessages: string[] = [];
    if (pdfModePaperContexts.length) {
      deps.inputBox.disabled = true;
      const preparedPdfInputs = await preparePdfComposeInputs({
        paperContexts: pdfModePaperContexts,
        pdfSupport,
        modelName: earlyModelName,
        apiBase: earlyProfile?.apiBase,
        apiKey: earlyProfile?.apiKey,
        resolvePdfPaperAttachments: deps.resolvePdfPaperAttachments,
        renderPdfPagesAsImages: deps.renderPdfPagesAsImages,
        uploadPdfForProvider: deps.uploadPdfForProvider,
        resolvePdfBytes: deps.resolvePdfBytes,
        isScreenshotUnsupportedModel: deps.isScreenshotUnsupportedModel,
        onStatus: deps.setStatusMessage,
      });
      pdfFileAttachments = preparedPdfInputs.attachments;
      pdfPageImageDataUrls = preparedPdfInputs.images;
      pdfUploadSystemMessages = preparedPdfInputs.pdfUploadSystemMessages;
      deps.inputBox.disabled = false;
    }
    const selectedFiles = [
      ...deps.getSelectedFiles(item.id),
      ...pdfFileAttachments,
    ];
    const hasPaperComposeState = allSelectedPaperContexts.length > 0 || !deps.isGlobalMode();

    if (
      !text &&
      !primarySelectedText &&
      !selectedPaperContexts.length &&
      !selectedFiles.length
    ) {
      return;
    }

    const promptText = deps.resolvePromptText(
      text,
      primarySelectedText,
      selectedFiles.length > 0 || selectedPaperContexts.length > 0,
    );
    if (!promptText) return;

    const resolvedPromptText =
      !text &&
      !primarySelectedText &&
      selectedPaperContexts.length > 0 &&
      !selectedFiles.length
        ? "Please analyze selected papers."
        : promptText;

    const composedQuestionBase = primarySelectedText
      ? deps.buildQuestionWithSelectedTextContexts(
          selectedTexts,
          selectedTextSources,
          resolvedPromptText,
          {
            selectedTextPaperContexts,
            includePaperAttribution: deps.isGlobalMode(),
          },
        )
      : resolvedPromptText;

    const composedQuestion = deps.isAgentMode()
      ? resolvedPromptText
      : deps.buildModelPromptWithFileContext(
          composedQuestionBase,
          selectedFiles,
        );
    const runtimeMode: ChatRuntimeMode = deps.isAgentMode() ? "agent" : "chat";
    const displayQuestion = primarySelectedText
      ? resolvedPromptText
      : text || resolvedPromptText;

    const titleSeed =
      deps.normalizeConversationTitleSeed(text) ||
      deps.normalizeConversationTitleSeed(resolvedPromptText);
    if (titleSeed) {
      if (deps.isGlobalMode()) {
        void deps
          .touchGlobalConversationTitle(
            deps.getConversationKey(item),
            titleSeed,
          )
          .catch((err) => {
            ztoolkit.log("LLM: Failed to touch global conversation title", err);
          });
      } else {
        void deps
          .touchPaperConversationTitle(deps.getConversationKey(item), titleSeed)
          .catch((err) => {
            ztoolkit.log("LLM: Failed to touch paper conversation title", err);
          });
      }
    }

    const selectedProfile = deps.getSelectedProfile();
    const activeModelName = (
      selectedProfile?.model ||
      deps.getCurrentModelName() ||
      ""
    ).trim();
    const selectedImages = deps
      .getSelectedImages(item.id)
      .slice(0, MAX_SELECTED_IMAGES);
    const images = [
      ...(deps.isScreenshotUnsupportedModel(activeModelName) ? [] : selectedImages),
      ...pdfPageImageDataUrls,
    ];
    const selectedReasoning = deps.getSelectedReasoning();
    const advancedParams = deps.getAdvancedModelParams(selectedProfile?.entryId);

    const activeEditSession = deps.getActiveEditSession();
    if (activeEditSession) {
      const latest = await deps.getLatestEditablePair();
      if (!latest) {
        deps.setActiveEditSession(null);
        deps.setStatusMessage?.("No editable latest prompt", "error");
        return;
      }
      const { conversationKey: latestKey, pair } = latest;
      if (
        pair.assistantMessage.streaming ||
        activeEditSession.conversationKey !== latestKey ||
        activeEditSession.userTimestamp !== pair.userMessage.timestamp ||
        activeEditSession.assistantTimestamp !== pair.assistantMessage.timestamp
      ) {
        deps.setActiveEditSession(null);
        deps.setStatusMessage?.(deps.editStaleStatusText, "error");
        return;
      }

      const editResult = await deps.editLatestUserMessageAndRetry({
        body: deps.body,
        item,
        displayQuestion,
        selectedTexts: selectedTexts.length ? selectedTexts : undefined,
        selectedTextSources: selectedTexts.length ? selectedTextSources : undefined,
        selectedTextPaperContexts: selectedTexts.length ? selectedTextPaperContexts : undefined,
        selectedTextNoteContexts: selectedTexts.length ? selectedTextNoteContexts : undefined,
        screenshotImages: images,
        paperContexts: selectedPaperContexts,
        fullTextPaperContexts,
        attachments: selectedFiles.length ? selectedFiles : undefined,
        pdfUploadSystemMessages: pdfUploadSystemMessages.length
          ? pdfUploadSystemMessages
          : undefined,
        targetRuntimeMode: runtimeMode,
        expected: activeEditSession,
        model: selectedProfile?.model,
        apiBase: selectedProfile?.apiBase,
        apiKey: selectedProfile?.apiKey,
        reasoning: selectedReasoning,
        advanced: advancedParams,
      });
      if (editResult !== "ok") {
        if (editResult === "stale") {
          deps.setActiveEditSession(null);
          deps.setStatusMessage?.(deps.editStaleStatusText, "error");
          return;
        }
        if (editResult === "missing") {
          deps.setActiveEditSession(null);
          deps.setStatusMessage?.("No editable latest prompt", "error");
          return;
        }
        deps.setStatusMessage?.("Failed to save edited prompt", "error");
        return;
      }

      deps.inputBox.value = "";
      deps.persistDraftInput();
      deps.retainPinnedImageState(item.id);
      if (hasPaperComposeState) {
        deps.consumePaperModeState(item.id);
        deps.retainPaperState(item.id);
        deps.updatePaperPreviewPreservingScroll();
      }
      if (selectedFiles.length) {
        deps.retainPinnedFileState(item.id);
        deps.updateFilePreviewPreservingScroll();
      }
      deps.updateImagePreviewPreservingScroll();
      if (primarySelectedText) {
        deps.retainPinnedTextState(textContextConversationKey);
        deps.updateSelectedTextPreviewPreservingScroll();
      }
      deps.setActiveEditSession(null);
      deps.scheduleAttachmentGc();
      deps.refreshGlobalHistoryHeader();
      return;
    }

    deps.inputBox.value = "";
    deps.persistDraftInput();
    deps.retainPinnedImageState(item.id);
    if (selectedFiles.length) {
      deps.retainPinnedFileState(item.id);
      deps.updateFilePreviewPreservingScroll();
    }
    deps.updateImagePreviewPreservingScroll();
    if (primarySelectedText) {
      deps.retainPinnedTextState(textContextConversationKey);
      deps.updateSelectedTextPreviewPreservingScroll();
    }

    const sendTask = deps.sendQuestion({
      body: deps.body,
      item,
      question: composedQuestion,
      images,
      model: selectedProfile?.model,
      apiBase: selectedProfile?.apiBase,
      apiKey: selectedProfile?.apiKey,
      reasoning: selectedReasoning,
      advanced: advancedParams,
      displayQuestion,
      selectedTexts: selectedTexts.length ? selectedTexts : undefined,
      selectedTextSources: selectedTexts.length ? selectedTextSources : undefined,
      selectedTextPaperContexts: selectedTexts.length ? selectedTextPaperContexts : undefined,
      selectedTextNoteContexts: selectedTexts.length ? selectedTextNoteContexts : undefined,
      paperContexts: selectedPaperContexts,
      fullTextPaperContexts,
      attachments: selectedFiles.length ? selectedFiles : undefined,
      runtimeMode,
      pdfModePaperKeys: pdfModeKeySet.size > 0 ? pdfModeKeySet : undefined,
      pdfUploadSystemMessages: pdfUploadSystemMessages.length ? pdfUploadSystemMessages : undefined,
    });
    if (hasPaperComposeState) {
      deps.consumePaperModeState(item.id);
      deps.retainPaperState(item.id);
      deps.updatePaperPreviewPreservingScroll();
    }
    const win = deps.body.ownerDocument?.defaultView;
    if (win) {
      win.setTimeout(() => {
        deps.refreshGlobalHistoryHeader();
      }, 120);
    }
    await sendTask;
    deps.refreshGlobalHistoryHeader();
    } finally {
      deps.autoUnlockGlobalChat();
    }
  };

  return { doSend };
}
