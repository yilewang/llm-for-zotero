import { MAX_SELECTED_IMAGES } from "../../constants";
import type {
  LocalDocumentResource,
  ModelInputMode,
} from "../../../../shared/types";
import type { ProviderProtocol } from "../../../../utils/providerProtocol";
import type { PdfSupport } from "../../../../providers";
import type {
  AdvancedModelParams,
  ChatAttachment,
  ChatRuntimeMode,
  CollectionContextRef,
  PaperContextRef,
  PaperContextSendMode,
  ResolvedSelectedTextAnchor,
  ResolvedContextSource,
  SelectedTextContext,
  TagContextRef,
} from "../../types";
import type { SelectedTextSource } from "../../types";
import type { EditLatestTurnMarker, EditLatestTurnResult } from "../../chat";
import type { ReasoningConfig as LLMReasoningConfig } from "../../../../utils/llmClient";
import {
  buildCodexAppServerNativeAttachmentBlockMessage,
  getBlockedCodexAppServerNativeAttachments,
  shouldApplyCodexAppServerNativeAttachmentPolicy,
} from "../../codexAppServerAttachmentPolicy";
import { resolvePdfModeModelInputs } from "./pdfPaperModelInputController";
import {
  getAllSkills,
  prependNativeSkillMention,
  resolveSkillDirectiveText,
} from "../../../../agent/skills";
import {
  buildNoteEditingTurnContext,
  resolveNoteEditingScope,
} from "../../noteEditing";
import { readNoteSnapshot } from "../../noteSnapshot";

type StatusLevel = "ready" | "warning" | "error";

type SelectedProfile = {
  entryId: string;
  model: string;
  apiBase: string;
  apiKey: string;
  providerLabel: string;
  authMode?:
    | "api_key"
    | "codex_auth"
    | "codex_app_server"
    | "copilot_auth"
    | "webchat";
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

export type SendFlowOptions =
  | {
      overrideText?: string;
      preserveInputDraft?: false;
      restoreQueuedInput?: never;
    }
  | {
      overrideText: string;
      preserveInputDraft: true;
      restoreQueuedInput: () => void;
    };

type SendFlowControllerDeps = {
  body: Element;
  inputBox: HTMLTextAreaElement;
  getItem: () => Zotero.Item | null;
  beginRequest: (
    body: Element,
    item: Zotero.Item,
    statusText?: string,
  ) => {
    conversationKey: number;
    requestId: number;
    signal: AbortSignal;
  } | null;
  isRequestOwner: (conversationKey: number, requestId: number) => boolean;
  finishRequest: (
    body: Element,
    item: Zotero.Item,
    conversationKey: number,
    requestId: number,
  ) => boolean;
  queueFollowUpInput: (text: string) => void;
  resolveContextSource: () => Promise<ResolvedContextSource | null>;
  closeSlashMenu: () => void;
  closePaperPicker: () => void;
  getSelectedTextContextEntries: (itemId: number) => SelectedTextContext[];
  resolveSelectedTextAnchors?: (params: {
    selectedTextContexts: SelectedTextContext[];
    paperContexts?: PaperContextRef[];
  }) => Promise<ResolvedSelectedTextAnchor[]>;
  getSelectedPaperContexts: (itemId: number) => PaperContextRef[];
  getSelectedCollectionContexts: (itemId: number) => CollectionContextRef[];
  getSelectedTagContexts: (itemId: number) => TagContextRef[];
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
  resolveLocalPdfResources: (
    paperContexts: PaperContextRef[],
  ) => Promise<readonly LocalDocumentResource[]>;
  preflightLocalPdfCapability?: () => Promise<void>;
  renderPdfPagesAsImages: (
    paperContexts: PaperContextRef[],
    maxImages?: number,
  ) => Promise<string[]>;
  getModelPdfSupport: (
    modelName: string,
    providerProtocol?: string,
    authMode?: string,
    apiBase?: string,
    inputMode?: ModelInputMode,
  ) => PdfSupport;
  uploadPdfForProvider: (params: {
    apiBase: string;
    apiKey: string;
    pdfBytes: Uint8Array<ArrayBufferLike>;
    fileName: string;
  }) => Promise<{ systemMessageContent: string; label: string } | null>;
  resolvePdfBytes: (
    paperContext: PaperContextRef,
  ) => Promise<Uint8Array<ArrayBufferLike>>;
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
      selectedTextContexts?: SelectedTextContext[];
      resolvedSelectedTextAnchors?: ResolvedSelectedTextAnchor[];
      includeAnchorContext?: boolean;
      includePaperAttribution?: boolean;
    },
  ) => string;
  buildModelPromptWithFileContext: (
    question: string,
    attachments: ChatAttachment[],
  ) => string;
  isAgentMode: () => boolean;
  isGlobalMode: () => boolean;
  isClaudeConversationSystem: () => boolean;
  isCodexConversationSystem: () => boolean;
  normalizeConversationTitleSeed: (raw: unknown) => string;
  getConversationKey: (item: Zotero.Item) => number;
  getConversationWriteGeneration?: (conversationKey: number) => number;
  touchClaudeConversationTitle: (
    conversationKey: number,
    title: string,
    generation?: number,
  ) => Promise<void>;
  touchCodexConversationTitle: (
    conversationKey: number,
    title: string,
    generation?: number,
  ) => Promise<void>;
  touchGlobalConversationTitle: (
    conversationKey: number,
    title: string,
    generation?: number,
  ) => Promise<void>;
  touchPaperConversationTitle: (
    conversationKey: number,
    title: string,
    generation?: number,
  ) => Promise<void>;
  getSelectedProfile: () => SelectedProfile | null;
  getCurrentModelName: () => string;
  isScreenshotUnsupportedModel: (
    modelName: string,
    providerProtocol?: string,
    authMode?: string,
    apiBase?: string,
    inputMode?: ModelInputMode,
  ) => boolean;
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
  retainClaudeRuntime?: (body: Element, item: Zotero.Item) => Promise<void>;
  retainPinnedImageState: (itemId: number) => void;
  retainPaperState: (itemId: number) => void;
  consumePaperModeState: (
    itemId: number,
    options?: { webchatGreyOut?: boolean },
  ) => void;
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
  onSendSettled?: () => void;
  setStatusMessage?: (message: string, level: StatusLevel) => void;
  editStaleStatusText: string;
  onComposerDraftCleared?: () => void;
  onComposerDraftRestored?: () => void;
  /** Consume forced skill IDs from slash menu selection. Returns the IDs and clears state. */
  consumeForcedSkillIds?: () => string[] | undefined;
  // [webchat]
  hasActivePdfFullTextPapers?: (
    item: Zotero.Item,
    paperContexts?: any[],
  ) => boolean;
  getActiveWebChatPdfPaperContexts?: (
    item: Zotero.Item,
    paperContexts?: PaperContextRef[],
  ) => PaperContextRef[];
  resolvePaperContextNextSendMode: (
    itemId: number,
    paperContext: PaperContextRef,
  ) => PaperContextSendMode;
  setPaperModeOverride: (
    itemId: number,
    paperContext: PaperContextRef,
    mode: PaperContextSendMode,
  ) => void;
  consumeWebChatForceNewChatIntent?: () => boolean;
  markWebChatForceNewChatIntent?: () => void;
};

export function createSendFlowController(deps: SendFlowControllerDeps): {
  doSend: (options?: SendFlowOptions) => Promise<void>;
} {
  const doSend = async (options?: SendFlowOptions) => {
    const item = deps.getItem();
    if (!item) return;

    const textContextConversationKey = deps.getConversationKey(item);
    const capturedDraft = deps.inputBox.value;
    const draftText = capturedDraft.trim();
    const rawSubmittedText = (options?.overrideText ?? draftText).trim();
    const request = deps.beginRequest(
      deps.body,
      item,
      "Preparing attached context…",
    );
    if (!request) {
      if (rawSubmittedText) deps.queueFollowUpInput(rawSubmittedText);
      return;
    }
    const requestIsActive = () =>
      deps.isRequestOwner(request.conversationKey, request.requestId) &&
      !request.signal.aborted;
    const shouldClearDraft = !options?.preserveInputDraft;
    let submittedInputRestored = false;
    let providerDispatchStarted = false;
    const restoreSubmittedInput = () => {
      if (providerDispatchStarted || submittedInputRestored) return;
      submittedInputRestored = true;
      if (options?.preserveInputDraft) {
        options.restoreQueuedInput();
        return;
      }
      deps.inputBox.value = capturedDraft;
      deps.persistDraftInput();
      deps.onComposerDraftRestored?.();
    };
    try {
      if (shouldClearDraft) {
        deps.inputBox.value = "";
        deps.onComposerDraftCleared?.();
        deps.persistDraftInput();
      }
      deps.closeSlashMenu();
      deps.closePaperPicker();
      deps.autoLockGlobalChat();

      const earlyProfile = deps.getSelectedProfile();
      const codexNativeSkillText =
        earlyProfile?.authMode === "codex_app_server"
          ? resolveSkillDirectiveText(rawSubmittedText, getAllSkills())
          : { text: rawSubmittedText };
      const text = codexNativeSkillText.text;
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
      const contextSource = await deps.resolveContextSource();
      if (!requestIsActive()) return;
      const allSelectedPaperContexts = deps.getSelectedPaperContexts(item.id);
      const selectedCollectionContexts = deps.getSelectedCollectionContexts(
        item.id,
      );
      const selectedTagContexts = deps.getSelectedTagContexts(item.id);
      const usesPluginAgentMode =
        (deps.isAgentMode() || deps.isClaudeConversationSystem()) &&
        !deps.isCodexConversationSystem();
      // Plugin Agent mode uses text/MinerU pipeline by default, but if the user
      // explicitly forced PDF mode on a paper, honour that choice.
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
      const resolvedSelectedTextAnchors = deps.resolveSelectedTextAnchors
        ? await deps.resolveSelectedTextAnchors({
            selectedTextContexts: selectedContexts,
            paperContexts: allSelectedPaperContexts,
          })
        : [];
      if (!requestIsActive()) return;
      // Resolve PDFs based on model capability. The visible chip/attachment state
      // stays unchanged; these variables are the provider-specific model inputs.
      const isWebChat = earlyProfile?.authMode === "webchat";
      const activeWebChatPdfPaperContexts = isWebChat
        ? (deps.getActiveWebChatPdfPaperContexts?.(
            item,
            allSelectedPaperContexts,
          ) ??
          (deps.hasActivePdfFullTextPapers?.(item, allSelectedPaperContexts)
            ? pdfModePaperContexts
            : []))
        : [];
      const webChatPdfModeSnapshot = activeWebChatPdfPaperContexts.map(
        (paperContext) => ({
          paperContext,
          mode: deps.resolvePaperContextNextSendMode(item.id, paperContext),
        }),
      );
      let webChatPdfModeRestored = false;
      const restoreWebChatPdfModeAfterUnverifiedSend = () => {
        if (webChatPdfModeRestored || !webChatPdfModeSnapshot.length) return;
        webChatPdfModeRestored = true;
        for (const { paperContext, mode } of webChatPdfModeSnapshot) {
          deps.setPaperModeOverride(item.id, paperContext, mode);
        }
        deps.updatePaperPreviewPreservingScroll();
      };
      if (isWebChat && activeWebChatPdfPaperContexts.length > 1) {
        deps.setStatusMessage?.(
          "Web chat supports one PDF attachment at a time. Keep one PDF active or start separate chats.",
          "error",
        );
        return;
      }
      const runtimeMode: ChatRuntimeMode = usesPluginAgentMode
        ? "agent"
        : "chat";
      const useCodexAttachmentPolicy =
        shouldApplyCodexAppServerNativeAttachmentPolicy({
          authMode: earlyProfile?.authMode,
        });
      const earlyModelName = (
        earlyProfile?.model ||
        deps.getCurrentModelName() ||
        ""
      ).trim();
      const earlyAdvancedParams = deps.getAdvancedModelParams(
        earlyProfile?.entryId,
      );
      const selectedBaseFiles = deps.getSelectedFiles(item.id);
      if (useCodexAttachmentPolicy) {
        const blockedAttachments =
          getBlockedCodexAppServerNativeAttachments(selectedBaseFiles);
        if (blockedAttachments.length) {
          deps.setStatusMessage?.(
            buildCodexAppServerNativeAttachmentBlockMessage(blockedAttachments),
            "error",
          );
          return;
        }
      }
      const selectedImages = deps
        .getSelectedImages(item.id)
        .slice(0, MAX_SELECTED_IMAGES);
      const selectedImageCountForBudget = deps.isScreenshotUnsupportedModel(
        earlyModelName,
        earlyProfile?.providerProtocol,
        earlyProfile?.authMode,
        earlyProfile?.apiBase,
        earlyAdvancedParams?.inputMode,
      )
        ? 0
        : selectedImages.length;
      const pdfInputs = await resolvePdfModeModelInputs({
        deps: {
          setInputDisabled: (disabled) => {
            deps.inputBox.disabled = disabled;
          },
          setStatusMessage: deps.setStatusMessage,
          logError: (message, ...args) => {
            ztoolkit.log(message, ...args);
          },
          isScreenshotUnsupportedModel: deps.isScreenshotUnsupportedModel,
          getModelPdfSupport: deps.getModelPdfSupport,
          resolvePdfPaperAttachments: deps.resolvePdfPaperAttachments,
          resolveLocalPdfResources: deps.resolveLocalPdfResources,
          renderPdfPagesAsImages: deps.renderPdfPagesAsImages,
          uploadPdfForProvider: deps.uploadPdfForProvider,
          resolvePdfBytes: deps.resolvePdfBytes,
        },
        paperContexts: pdfModePaperContexts,
        selectedBaseFiles,
        selectedImageCountForBudget,
        profile: earlyProfile
          ? { ...earlyProfile, inputMode: earlyAdvancedParams?.inputMode }
          : null,
        currentModelName: earlyModelName,
        isWebChat,
        useCodexAttachmentPolicy,
      });
      if (!requestIsActive()) return;
      if (!pdfInputs.ok) return;
      const {
        selectedFiles,
        modelFiles,
        pdfPageImageDataUrls,
        pdfUploadSystemMessages,
        localDocuments,
      } = pdfInputs;
      if (localDocuments.length && deps.isClaudeConversationSystem()) {
        try {
          await deps.preflightLocalPdfCapability?.();
          if (!requestIsActive()) return;
        } catch (error) {
          deps.setStatusMessage?.(
            error instanceof Error && error.message.trim()
              ? error.message
              : "Claude bridge does not support raw local PDF paths.",
            "error",
          );
          return;
        }
      }
      const hasImageInputs =
        selectedImages.length > 0 || pdfPageImageDataUrls.length > 0;
      if (
        isWebChat &&
        (selectedCollectionContexts.length || selectedTagContexts.length)
      ) {
        deps.setStatusMessage?.(
          "Web chat does not support Zotero collection or tag context. Remove the scope chip and try again.",
          "error",
        );
        return;
      }
      const hasPaperComposeState =
        allSelectedPaperContexts.length > 0 ||
        selectedCollectionContexts.length > 0 ||
        selectedTagContexts.length > 0 ||
        !deps.isGlobalMode();

      if (
        !text &&
        !primarySelectedText &&
        !selectedPaperContexts.length &&
        !selectedCollectionContexts.length &&
        !selectedTagContexts.length &&
        !selectedFiles.length &&
        !localDocuments.length &&
        !hasImageInputs
      ) {
        return;
      }

      const hasNonImageAttachments =
        selectedFiles.length > 0 ||
        localDocuments.length > 0 ||
        selectedPaperContexts.length > 0 ||
        selectedCollectionContexts.length > 0 ||
        selectedTagContexts.length > 0;

      let resolvedPromptText =
        !text && !primarySelectedText && localDocuments.length
          ? localDocuments.length === 1
            ? "Please analyze the selected raw PDF."
            : "Please analyze the selected raw PDFs."
          : deps.resolvePromptText(
              text,
              primarySelectedText,
              hasNonImageAttachments,
            );
      if (!resolvedPromptText && hasImageInputs) {
        resolvedPromptText = "Please analyze the attached images.";
      }
      if (!resolvedPromptText) return;

      const selectedScopeContextCount =
        selectedPaperContexts.length +
        selectedCollectionContexts.length +
        selectedTagContexts.length;
      if (
        !text &&
        !primarySelectedText &&
        selectedScopeContextCount > 0 &&
        !selectedFiles.length &&
        !localDocuments.length &&
        !hasImageInputs
      ) {
        resolvedPromptText = selectedPaperContexts.length
          ? "Please analyze selected papers."
          : selectedCollectionContexts.length
            ? "Please analyze selected collection."
            : "Please analyze selected tag.";
      }

      const composedQuestionBase = primarySelectedText
        ? deps.buildQuestionWithSelectedTextContexts(
            selectedTexts,
            selectedTextSources,
            resolvedPromptText,
            {
              selectedTextContexts: selectedContexts,
              selectedTextPaperContexts,
              resolvedSelectedTextAnchors,
              includeAnchorContext: isWebChat,
              includePaperAttribution: deps.isGlobalMode(),
            },
          )
        : resolvedPromptText;

      const composedQuestion = usesPluginAgentMode
        ? resolvedPromptText
        : deps.buildModelPromptWithFileContext(
            composedQuestionBase,
            selectedFiles,
          );

      // Check for command action metadata (set by handleInlineCommand for /command display)
      const dataset = deps.inputBox.dataset;
      const commandAction = dataset?.commandAction;
      const commandParams = dataset?.commandParams ?? "";
      if (commandAction && dataset) {
        delete dataset.commandAction;
        delete dataset.commandParams;
      }
      const displayQuestion = commandAction
        ? commandParams
          ? `/${commandAction} ${commandParams}`
          : `/${commandAction}`
        : primarySelectedText
          ? resolvedPromptText
          : rawSubmittedText || resolvedPromptText;

      const titleSeed =
        deps.normalizeConversationTitleSeed(rawSubmittedText) ||
        deps.normalizeConversationTitleSeed(resolvedPromptText);
      // [webchat] Webchat sessions are ephemeral and hidden from history;
      // stamping their first message onto the local catalog row would leak
      // webchat content into the normal history list.
      if (titleSeed && !isWebChat) {
        const titleGeneration = deps.getConversationWriteGeneration?.(
          deps.getConversationKey(item),
        );
        const touchTitle = deps.isClaudeConversationSystem()
          ? deps.touchClaudeConversationTitle
          : deps.isCodexConversationSystem()
            ? deps.touchCodexConversationTitle
            : deps.isGlobalMode()
              ? deps.touchGlobalConversationTitle
              : deps.touchPaperConversationTitle;
        void touchTitle(
          deps.getConversationKey(item),
          titleSeed,
          titleGeneration,
        ).catch((err) => {
          ztoolkit.log("LLM: Failed to touch conversation title", err);
        });
      }

      const selectedProfile = deps.getSelectedProfile();
      const shouldRetainClaudeRuntime =
        deps.isClaudeConversationSystem() ||
        selectedProfile?.providerLabel === "Claude Code";
      const activeModelName = (
        selectedProfile?.model ||
        deps.getCurrentModelName() ||
        ""
      ).trim();
      const selectedReasoning = deps.getSelectedReasoning();
      const advancedParams = deps.getAdvancedModelParams(
        selectedProfile?.entryId,
      );
      const images = [
        ...(deps.isScreenshotUnsupportedModel(
          activeModelName,
          selectedProfile?.providerProtocol,
          selectedProfile?.authMode,
          selectedProfile?.apiBase,
          advancedParams?.inputMode,
        )
          ? []
          : selectedImages),
        ...pdfPageImageDataUrls,
      ];

      const activeEditSession = deps.getActiveEditSession();
      if (activeEditSession) {
        const latest = await deps.getLatestEditablePair();
        if (!requestIsActive()) return;
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
          activeEditSession.assistantTimestamp !==
            pair.assistantMessage.timestamp
        ) {
          deps.setActiveEditSession(null);
          deps.setStatusMessage?.(deps.editStaleStatusText, "error");
          return;
        }

        const editResult = await deps.editLatestUserMessageAndRetry({
          body: deps.body,
          item,
          requestId: request.requestId,
          onProviderDispatch: () => {
            providerDispatchStarted = true;
          },
          contextSource,
          displayQuestion,
          selectedTextContexts: selectedContexts.length
            ? selectedContexts
            : undefined,
          resolvedSelectedTextAnchors: resolvedSelectedTextAnchors.length
            ? resolvedSelectedTextAnchors
            : undefined,
          selectedTexts: selectedTexts.length ? selectedTexts : undefined,
          selectedTextSources: selectedTexts.length
            ? selectedTextSources
            : undefined,
          selectedTextPaperContexts: selectedTexts.length
            ? selectedTextPaperContexts
            : undefined,
          selectedTextNoteContexts: selectedTexts.length
            ? selectedTextNoteContexts
            : undefined,
          screenshotImages: images,
          paperContexts: selectedPaperContexts,
          pdfPaperContexts: pdfModePaperContexts,
          fullTextPaperContexts,
          selectedCollectionContexts,
          selectedTagContexts,
          attachments: selectedFiles.length ? selectedFiles : undefined,
          modelAttachments: selectedFiles.length ? modelFiles : undefined,
          localDocuments: localDocuments.length ? localDocuments : undefined,
          pdfUploadSystemMessages: pdfUploadSystemMessages.length
            ? pdfUploadSystemMessages
            : undefined,
          targetRuntimeMode: runtimeMode,
          expected: activeEditSession,
          model: selectedProfile?.model,
          apiBase: selectedProfile?.apiBase,
          apiKey: selectedProfile?.apiKey,
          authMode: selectedProfile?.authMode,
          providerProtocol: selectedProfile?.providerProtocol,
          modelEntryId: selectedProfile?.entryId,
          modelProviderLabel: selectedProfile?.providerLabel,
          reasoning: selectedReasoning,
          advanced: advancedParams,
        });
        if (editResult !== "ok") {
          restoreSubmittedInput();
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
          if (editResult === "cancelled") {
            // The user stopped the retry; the cancel handler already showed
            // "Cancelled". The saved edit is not a failure.
            return;
          }
          deps.setStatusMessage?.("Failed to save edited prompt", "error");
          return;
        }
        if (!providerDispatchStarted) restoreSubmittedInput();

        deps.retainPinnedImageState(item.id);
        if (hasPaperComposeState) {
          deps.consumePaperModeState(item.id, {
            webchatGreyOut: isWebChat,
          });
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

      // [webchat] Determine whether to send PDF and/or force a new chat
      // (isWebChat already computed early from earlyProfile)
      const webchatForceNewChat = isWebChat
        ? (deps.consumeWebChatForceNewChatIntent?.() ?? false)
        : false;
      const webchatSendPdf = isWebChat
        ? activeWebChatPdfPaperContexts.length > 0
        : false;

      const consumedForcedSkillIds = deps.consumeForcedSkillIds?.() || [];
      const forcedSkillIds = Array.from(
        new Set([
          ...consumedForcedSkillIds,
          ...(codexNativeSkillText.forcedSkillId
            ? [codexNativeSkillText.forcedSkillId]
            : []),
        ]),
      );
      const questionForSend =
        selectedProfile?.authMode === "codex_app_server" && forcedSkillIds[0]
          ? prependNativeSkillMention(composedQuestion, forcedSkillIds[0])
          : composedQuestion;
      if (shouldRetainClaudeRuntime) {
        await deps.retainClaudeRuntime?.(deps.body, item);
        if (!requestIsActive()) return;
      }
      const activeNoteScope = resolveNoteEditingScope(item);
      const activeNoteContext = buildNoteEditingTurnContext({
        scope: activeNoteScope,
        snapshot: readNoteSnapshot(item),
      }).activeNoteContext;
      let webchatSendOutcome: "success" | "failed" | "cancelled" | null = null;
      const sendTask = deps.sendQuestion({
        body: deps.body,
        item,
        requestId: request.requestId,
        onProviderDispatch: () => {
          providerDispatchStarted = true;
        },
        contextSource,
        question: questionForSend,
        images,
        model: selectedProfile?.model,
        apiBase: selectedProfile?.apiBase,
        apiKey: selectedProfile?.apiKey,
        authMode: selectedProfile?.authMode,
        providerProtocol: selectedProfile?.providerProtocol,
        modelEntryId: selectedProfile?.entryId,
        modelProviderLabel: selectedProfile?.providerLabel,
        reasoning: selectedReasoning,
        advanced: advancedParams,
        displayQuestion,
        selectedTextContexts: selectedContexts.length
          ? selectedContexts
          : undefined,
        resolvedSelectedTextAnchors: resolvedSelectedTextAnchors.length
          ? resolvedSelectedTextAnchors
          : undefined,
        selectedTexts: selectedTexts.length ? selectedTexts : undefined,
        selectedTextSources: selectedTexts.length
          ? selectedTextSources
          : undefined,
        selectedTextPaperContexts: selectedTexts.length
          ? selectedTextPaperContexts
          : undefined,
        selectedTextNoteContexts: selectedTexts.length
          ? selectedTextNoteContexts
          : undefined,
        activeNoteContext,
        conversationKey: textContextConversationKey,
        conversationKind: activeNoteScope?.conversationKind,
        paperContexts: selectedPaperContexts,
        pdfPaperContexts: pdfModePaperContexts,
        fullTextPaperContexts,
        selectedCollectionContexts,
        selectedTagContexts,
        attachments: selectedFiles.length ? selectedFiles : undefined,
        modelAttachments: selectedFiles.length ? modelFiles : undefined,
        localDocuments: localDocuments.length ? localDocuments : undefined,
        runtimeMode,
        forcedSkillIds: forcedSkillIds.length ? forcedSkillIds : undefined,
        pdfUploadSystemMessages: pdfUploadSystemMessages.length
          ? pdfUploadSystemMessages
          : undefined,
        webchatSendPdf,
        webchatPdfPaperContexts: activeWebChatPdfPaperContexts,
        webchatForceNewChat,
        onWebChatSendOutcome: (outcome) => {
          webchatSendOutcome = outcome;
        },
      });
      if (hasPaperComposeState && !isWebChat) {
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
      try {
        await sendTask;
        if (!providerDispatchStarted && !requestIsActive()) {
          restoreSubmittedInput();
        }
      } catch (err) {
        if (!providerDispatchStarted) restoreSubmittedInput();
        restoreWebChatPdfModeAfterUnverifiedSend();
        if (isWebChat && webchatForceNewChat) {
          deps.markWebChatForceNewChatIntent?.();
        }
        throw err;
      }
      if (isWebChat) {
        const webchatSendSucceeded = webchatSendOutcome === "success";
        if (webchatSendSucceeded && hasPaperComposeState) {
          deps.consumePaperModeState(item.id, { webchatGreyOut: true });
          deps.retainPaperState(item.id);
          deps.updatePaperPreviewPreservingScroll();
        }
        if (!webchatSendSucceeded) {
          restoreWebChatPdfModeAfterUnverifiedSend();
        }
        if (!webchatSendSucceeded && webchatForceNewChat) {
          deps.markWebChatForceNewChatIntent?.();
        }
      }
      deps.refreshGlobalHistoryHeader();
    } finally {
      if (request.signal.aborted && !providerDispatchStarted) {
        restoreSubmittedInput();
      }
      const currentConversationKey = deps.getConversationKey(item);
      let finished = deps.finishRequest(
        deps.body,
        item,
        currentConversationKey,
        request.requestId,
      );
      if (!finished && currentConversationKey !== request.conversationKey) {
        finished = deps.finishRequest(
          deps.body,
          item,
          request.conversationKey,
          request.requestId,
        );
      }
      if (finished && !providerDispatchStarted) {
        restoreSubmittedInput();
      }
      deps.autoUnlockGlobalChat();
      deps.onSendSettled?.();
    }
  };

  return { doSend };
}
