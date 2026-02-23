import { MAX_SELECTED_IMAGES } from "../../constants";
import type { ModelProfileKey } from "../../constants";
import type {
  AdvancedModelParams,
  ChatAttachment,
  PaperContextRef,
  SelectedTextContext,
} from "../../types";
import type { SelectedTextSource } from "../../types";
import type {
  EditLatestTurnMarker,
  EditLatestTurnResult,
} from "../../chat";
import type { ReasoningConfig as LLMReasoningConfig } from "../../../../utils/llmClient";

type StatusLevel = "ready" | "warning" | "error";

type SelectedProfile = {
  key: ModelProfileKey;
  model: string;
  apiBase: string;
  apiKey: string;
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
  ) => string;
  buildModelPromptWithFileContext: (
    question: string,
    attachments: ChatAttachment[],
  ) => string;
  isGlobalMode: () => boolean;
  normalizeConversationTitleSeed: (raw: unknown) => string;
  getConversationKey: (item: Zotero.Item) => number;
  touchGlobalConversationTitle: (
    conversationKey: number,
    title: string,
  ) => Promise<void>;
  getSelectedProfile: () => SelectedProfile | null;
  getCurrentModelName: () => string;
  isScreenshotUnsupportedModel: (modelName: string) => boolean;
  getSelectedReasoning: () => LLMReasoningConfig | undefined;
  getAdvancedModelParams: (
    profileKey: ModelProfileKey | undefined,
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
    screenshotImages?: string[],
    paperContexts?: PaperContextRef[],
    attachments?: ChatAttachment[],
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
    paperContexts?: PaperContextRef[],
    attachments?: ChatAttachment[],
  ) => Promise<void>;
  clearSelectedImageState: (itemId: number) => void;
  clearSelectedPaperState: (itemId: number) => void;
  clearSelectedFileState: (itemId: number) => void;
  clearSelectedTextState: (itemId: number) => void;
  updatePaperPreviewPreservingScroll: () => void;
  updateFilePreviewPreservingScroll: () => void;
  updateImagePreviewPreservingScroll: () => void;
  updateSelectedTextPreviewPreservingScroll: () => void;
  scheduleAttachmentGc: () => void;
  refreshGlobalHistoryHeader: () => void;
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

    const text = deps.inputBox.value.trim();
    const selectedContexts = deps.getSelectedTextContextEntries(item.id);
    const selectedTexts = selectedContexts.map((entry) => entry.text);
    const selectedTextSources = selectedContexts.map((entry) => entry.source);
    const primarySelectedText = selectedTexts[0] || "";
    const selectedPaperContexts = deps.getSelectedPaperContexts(item.id);
    const selectedFiles = deps.getSelectedFiles(item.id);

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
        )
      : resolvedPromptText;

    const composedQuestion = deps.buildModelPromptWithFileContext(
      composedQuestionBase,
      selectedFiles,
    );
    const displayQuestion = primarySelectedText
      ? resolvedPromptText
      : text || resolvedPromptText;

    if (deps.isGlobalMode()) {
      const titleSeed =
        deps.normalizeConversationTitleSeed(text) ||
        deps.normalizeConversationTitleSeed(resolvedPromptText);
      void deps
        .touchGlobalConversationTitle(deps.getConversationKey(item), titleSeed)
        .catch((err) => {
          ztoolkit.log("LLM: Failed to touch global conversation title", err);
        });
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
    const advancedParams = deps.getAdvancedModelParams(selectedProfile?.key);

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
        images,
        selectedPaperContexts.length ? selectedPaperContexts : undefined,
        selectedFiles.length ? selectedFiles : undefined,
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
      deps.clearSelectedImageState(item.id);
      if (selectedPaperContexts.length) {
        deps.clearSelectedPaperState(item.id);
        deps.updatePaperPreviewPreservingScroll();
      }
      if (selectedFiles.length) {
        deps.clearSelectedFileState(item.id);
        deps.updateFilePreviewPreservingScroll();
      }
      deps.updateImagePreviewPreservingScroll();
      if (primarySelectedText) {
        deps.clearSelectedTextState(item.id);
        deps.updateSelectedTextPreviewPreservingScroll();
      }
      deps.setActiveEditSession(null);
      deps.scheduleAttachmentGc();
      deps.refreshGlobalHistoryHeader();
      return;
    }

    deps.inputBox.value = "";
    deps.clearSelectedImageState(item.id);
    if (selectedPaperContexts.length) {
      deps.clearSelectedPaperState(item.id);
      deps.updatePaperPreviewPreservingScroll();
    }
    if (selectedFiles.length) {
      deps.clearSelectedFileState(item.id);
      deps.updateFilePreviewPreservingScroll();
    }
    deps.updateImagePreviewPreservingScroll();
    if (primarySelectedText) {
      deps.clearSelectedTextState(item.id);
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
      selectedPaperContexts.length ? selectedPaperContexts : undefined,
      selectedFiles.length ? selectedFiles : undefined,
    );
    const win = deps.body.ownerDocument?.defaultView;
    if (win) {
      win.setTimeout(() => {
        deps.refreshGlobalHistoryHeader();
      }, 120);
    }
    await sendTask;
    deps.refreshGlobalHistoryHeader();
  };

  return { doSend };
}
