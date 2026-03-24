import { MAX_SELECTED_IMAGES } from "../../constants";
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
  ) => Promise<ChatAttachment[]>;
  getModelPdfSupport: (modelName: string, providerProtocol?: string) => "native" | "vision" | "none";
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
    body: Element,
    item: Zotero.Item,
    displayQuestion: string,
    selectedTexts?: string[],
    selectedTextSources?: SelectedTextSource[],
    selectedTextPaperContexts?: (PaperContextRef | undefined)[],
    selectedTextNoteContexts?: (NoteContextRef | undefined)[],
    screenshotImages?: string[],
    paperContexts?: PaperContextRef[],
    fullTextPaperContexts?: PaperContextRef[],
    attachments?: ChatAttachment[],
    targetRuntimeMode?: ChatRuntimeMode,
    expected?: EditLatestTurnMarker,
    model?: string,
    apiBase?: string,
    apiKey?: string,
    reasoning?: LLMReasoningConfig,
    advanced?: AdvancedModelParams,
  ) => Promise<EditLatestTurnResult>;
  sendQuestion: (
    body: Element,
    item: Zotero.Item,
    question: string,
    screenshotImages?: string[],
    model?: string,
    apiBase?: string,
    apiKey?: string,
    reasoning?: LLMReasoningConfig,
    advanced?: AdvancedModelParams,
    displayQuestion?: string,
    selectedTexts?: string[],
    selectedTextSources?: SelectedTextSource[],
    selectedTextPaperContexts?: (PaperContextRef | undefined)[],
    selectedTextNoteContexts?: (NoteContextRef | undefined)[],
    paperContexts?: PaperContextRef[],
    fullTextPaperContexts?: PaperContextRef[],
    attachments?: ChatAttachment[],
    runtimeMode?: "chat" | "agent",
    agentRunId?: string,
    skipAgentDispatch?: boolean,
    pdfModePaperKeys?: Set<string>,
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
    const pdfModePaperContexts = deps.getPdfModePaperContexts(
      item,
      allSelectedPaperContexts,
    );
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
    const pdfSupport = deps.getModelPdfSupport(earlyModelName, earlyProfile?.providerProtocol);
    let pdfAttachments: ChatAttachment[] = [];
    if (pdfModePaperContexts.length) {
      if (pdfSupport === "none") {
        deps.setStatusMessage?.(
          "This model does not support PDF or image input. PDF papers were skipped.",
          "error",
        );
      } else if (pdfSupport === "vision") {
        deps.setStatusMessage?.(`Rendering PDF pages as images for ${earlyModelName}...`, "ready");
        pdfAttachments = await deps.renderPdfPagesAsImages(pdfModePaperContexts);
        deps.setStatusMessage?.(`Sending ${pdfAttachments.length} page image(s)...`, "ready");
      } else {
        deps.setStatusMessage?.(`Sending native PDF to ${earlyModelName}...`, "ready");
        pdfAttachments = await deps.resolvePdfPaperAttachments(pdfModePaperContexts);
      }
    }
    const selectedFiles = [
      ...deps.getSelectedFiles(item.id),
      ...pdfAttachments,
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
    const images = deps.isScreenshotUnsupportedModel(activeModelName)
      ? []
      : selectedImages;
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

      const editResult = await deps.editLatestUserMessageAndRetry(
        deps.body,
        item,
        displayQuestion,
        selectedTexts.length ? selectedTexts : undefined,
        selectedTexts.length ? selectedTextSources : undefined,
        selectedTexts.length ? selectedTextPaperContexts : undefined,
        selectedTexts.length ? selectedTextNoteContexts : undefined,
        images,
        selectedPaperContexts,
        fullTextPaperContexts,
        selectedFiles.length ? selectedFiles : undefined,
        runtimeMode,
        activeEditSession,
        selectedProfile?.model,
        selectedProfile?.apiBase,
        selectedProfile?.apiKey,
        selectedReasoning,
        advancedParams,
      );
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
      deps.autoUnlockGlobalChat();
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

    const sendTask = deps.sendQuestion(
      deps.body,
      item,
      composedQuestion,
      images,
      selectedProfile?.model,
      selectedProfile?.apiBase,
      selectedProfile?.apiKey,
      selectedReasoning,
      advancedParams,
      displayQuestion,
      selectedTexts.length ? selectedTexts : undefined,
      selectedTexts.length ? selectedTextSources : undefined,
      selectedTexts.length ? selectedTextPaperContexts : undefined,
      selectedTexts.length ? selectedTextNoteContexts : undefined,
      selectedPaperContexts,
      fullTextPaperContexts,
      selectedFiles.length ? selectedFiles : undefined,
      runtimeMode,
      undefined, // agentRunId
      false, // skipAgentDispatch
      pdfModeKeySet.size > 0 ? pdfModeKeySet : undefined,
    );
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
    deps.autoUnlockGlobalChat();
    deps.refreshGlobalHistoryHeader();
  };

  return { doSend };
}
