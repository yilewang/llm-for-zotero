import { MAX_SELECTED_IMAGES } from "../../constants";
import type { ProviderProtocol } from "../../../../utils/providerProtocol";
import type {
  AdvancedModelParams,
  ChatAttachment,
  ChatRuntimeMode,
  PaperContextRef,
  SelectedTextContext,
} from "../../types";
import type { SelectedTextSource } from "../../types";
import type { EditLatestTurnMarker, EditLatestTurnResult } from "../../chat";
import type { ReasoningConfig as LLMReasoningConfig } from "../../../../utils/llmClient";
import {
  buildCodexAppServerAttachmentBlockMessage,
  getBlockedCodexAppServerChatAttachments,
  shouldApplyCodexAppServerChatAttachmentPolicy,
} from "../../codexAppServerAttachmentPolicy";

type StatusLevel = "ready" | "warning" | "error";

type SelectedProfile = {
  entryId: string;
  model: string;
  apiBase: string;
  apiKey: string;
  providerLabel: string;
  authMode?: "api_key" | "codex_auth" | "codex_app_server" | "copilot_auth" | "webchat";
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
  getModelPdfSupport: (modelName: string, providerProtocol?: string, authMode?: string, apiBase?: string) => "native" | "upload" | "image_url" | "vision" | "none";
  uploadPdfForProvider: (params: {
    apiBase: string;
    apiKey: string;
    pdfBytes: Uint8Array<ArrayBufferLike>;
    fileName: string;
  }) => Promise<{ systemMessageContent: string; label: string } | null>;
  resolvePdfBytes: (paperContext: PaperContextRef) => Promise<Uint8Array<ArrayBufferLike>>;
  encodeBytesBase64: (bytes: Uint8Array<ArrayBufferLike>) => string;
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
  isClaudeConversationSystem: () => boolean;
  normalizeConversationTitleSeed: (raw: unknown) => string;
  getConversationKey: (item: Zotero.Item) => number;
  touchClaudeConversationTitle: (
    conversationKey: number,
    title: string,
  ) => Promise<void>;
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
  retainClaudeRuntime?: (body: Element, item: Zotero.Item) => Promise<void>;
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
  /** Consume forced skill IDs from slash menu selection. Returns the IDs and clears state. */
  consumeForcedSkillIds?: () => string[] | undefined;
  // [webchat]
  hasActivePdfFullTextPapers?: (item: Zotero.Item, paperContexts?: any[]) => boolean;
  hasUploadedPdfInCurrentWebChatConversation?: () => boolean;
  markWebChatPdfUploadedForCurrentConversation?: () => void;
  consumeWebChatForceNewChatIntent?: () => boolean;
};

export function createSendFlowController(deps: SendFlowControllerDeps): {
  doSend: (options?: { overrideText?: string; preserveInputDraft?: boolean }) => Promise<void>;
} {
  const doSend = async (options?: {
    overrideText?: string;
    preserveInputDraft?: boolean;
  }) => {
    const item = deps.getItem();
    if (!item) return;

    deps.closeSlashMenu();
    deps.closePaperPicker();
    deps.autoLockGlobalChat();

    try {
    const textContextConversationKey = deps.getConversationKey(item);
    const draftText = deps.inputBox.value.trim();
    const text = (options?.overrideText ?? draftText).trim();
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
    // Agent mode uses text/MinerU pipeline by default, but if the user
    // explicitly forced PDF mode on a paper, honour that choice.
    const pdfModePaperContexts = deps.getPdfModePaperContexts(item, allSelectedPaperContexts);
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
    const isWebChat = earlyProfile?.authMode === "webchat";
    const earlyModelName = (
      earlyProfile?.model || deps.getCurrentModelName() || ""
    ).trim();
    const pdfSupport = deps.getModelPdfSupport(
      earlyModelName, earlyProfile?.providerProtocol, earlyProfile?.authMode, earlyProfile?.apiBase,
    );
    let pdfFileAttachments: ChatAttachment[] = [];
    let pdfPageImageDataUrls: string[] = [];
    let pdfUploadSystemMessages: string[] = [];
    // [webchat] Skip provider-capability PDF processing — webchat handles PDF
    // through its own pipeline (sendPdf → relay → extension → attachPDF).
    if (pdfModePaperContexts.length && !isWebChat) {
      if (pdfSupport === "none") {
        deps.setStatusMessage?.(
          "This model does not support PDF or image input. PDF papers were skipped.",
          "error",
        );
      } else if (pdfSupport === "upload" && earlyProfile?.apiBase && earlyProfile?.apiKey) {
        // Qwen/Kimi: upload PDF to provider, inject file reference as system message.
        // For Qwen (DashScope), only qwen-long supports PDF upload.
        const isQwen = (earlyProfile.apiBase || "").toLowerCase().includes("dashscope");
        const isQwenLong = /^qwen-long(?:[.-]|$)/i.test(earlyModelName);
        if (isQwen && !isQwenLong) {
          deps.setStatusMessage?.(
            `Only qwen-long supports PDF upload on DashScope. Current model: ${earlyModelName}. PDF papers were skipped.`,
            "error",
          );
        } else {
          deps.inputBox.disabled = true;
          deps.setStatusMessage?.(`Uploading PDF to ${earlyModelName}...`, "ready");
          for (const pc of pdfModePaperContexts) {
            try {
              const result = await deps.uploadPdfForProvider({
                apiBase: earlyProfile.apiBase,
                apiKey: earlyProfile.apiKey,
                pdfBytes: await deps.resolvePdfBytes(pc),
                fileName: (() => {
                  const raw = pc.attachmentTitle || pc.title || "document";
                  return /\.pdf$/i.test(raw) ? raw : `${raw}.pdf`;
                })(),
              });
              if (result) {
                pdfUploadSystemMessages.push(result.systemMessageContent);
                deps.setStatusMessage?.(`${result.label}`, "ready");
              }
            } catch (err) {
              ztoolkit.log("LLM: PDF upload failed for", pc.contextItemId, err);
              deps.setStatusMessage?.("PDF upload failed. Falling back to text mode.", "error");
            }
          }
        }
      } else if (pdfSupport === "image_url") {
        // Tier 3 (third-party): encode full PDF as base64 data URI and send
        // as image_url — relay services pass this through.
        deps.inputBox.disabled = true;
        deps.setStatusMessage?.(
          `PDF upload via third-party provider may not work. Attempting base64 encoding...`,
          "warning",
        );
        for (const pc of pdfModePaperContexts) {
          try {
            const pdfBytes = await deps.resolvePdfBytes(pc);
            const base64 = deps.encodeBytesBase64(pdfBytes);
            pdfPageImageDataUrls.push(`data:application/pdf;base64,${base64}`);
          } catch (err) {
            ztoolkit.log("LLM: PDF base64 encoding failed for", pc.contextItemId, err);
            // Fall back to vision (render pages as images) for this paper
            const fallback = await deps.renderPdfPagesAsImages([pc]);
            pdfPageImageDataUrls.push(...fallback);
          }
        }
        deps.setStatusMessage?.(`Sending ${pdfPageImageDataUrls.length} PDF(s)...`, "ready");
      } else if (pdfSupport === "vision") {
        if (deps.isScreenshotUnsupportedModel(earlyModelName)) {
          deps.setStatusMessage?.(
            "This model does not support image input. PDF pages will be sent as text.",
            "warning",
          );
        } else {
          deps.inputBox.disabled = true;
          deps.setStatusMessage?.(`PDF will be sent as page images (vision mode) for ${earlyModelName}...`, "ready");
          pdfPageImageDataUrls = await deps.renderPdfPagesAsImages(pdfModePaperContexts);
          deps.setStatusMessage?.(`Sending ${pdfPageImageDataUrls.length} page image(s)...`, "ready");
        }
      } else {
        deps.setStatusMessage?.(`Sending native PDF to ${earlyModelName}...`, "ready");
        pdfFileAttachments = await deps.resolvePdfPaperAttachments(pdfModePaperContexts);
      }
      deps.inputBox.disabled = false;
    }
    const selectedFiles = [
      ...deps.getSelectedFiles(item.id),
      ...pdfFileAttachments,
    ];
    const runtimeMode: ChatRuntimeMode = deps.isAgentMode() ? "agent" : "chat";
    if (
      shouldApplyCodexAppServerChatAttachmentPolicy({
        authMode: earlyProfile?.authMode,
        runtimeMode,
      })
    ) {
      const blockedAttachments =
        getBlockedCodexAppServerChatAttachments(selectedFiles);
      if (blockedAttachments.length) {
        deps.setStatusMessage?.(
          buildCodexAppServerAttachmentBlockMessage(blockedAttachments),
          "error",
        );
        return;
      }
    }
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

    // Check for command action metadata (set by handleInlineCommand for /command display)
    const dataset = deps.inputBox.dataset;
    const commandAction = dataset?.commandAction;
    const commandParams = dataset?.commandParams ?? "";
    if (commandAction && dataset) {
      delete dataset.commandAction;
      delete dataset.commandParams;
    }
    const displayQuestion = commandAction
      ? (commandParams ? `/${commandAction} ${commandParams}` : `/${commandAction}`)
      : (primarySelectedText ? resolvedPromptText : text || resolvedPromptText);

    const titleSeed =
      deps.normalizeConversationTitleSeed(text) ||
      deps.normalizeConversationTitleSeed(resolvedPromptText);
    if (titleSeed) {
      const touchTitle = deps.isClaudeConversationSystem()
        ? deps.touchClaudeConversationTitle
        : deps.isGlobalMode()
          ? deps.touchGlobalConversationTitle
          : deps.touchPaperConversationTitle;
      void touchTitle(deps.getConversationKey(item), titleSeed).catch((err) => {
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
        authMode: selectedProfile?.authMode,
        providerProtocol: selectedProfile?.providerProtocol,
        modelEntryId: selectedProfile?.entryId,
        modelProviderLabel: selectedProfile?.providerLabel,
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

      if (!options?.preserveInputDraft) {
        deps.inputBox.value = "";
        deps.persistDraftInput();
      }
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

    if (!options?.preserveInputDraft) {
      deps.inputBox.value = "";
      deps.persistDraftInput();
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
      ? (
        (deps.hasActivePdfFullTextPapers?.(item, allSelectedPaperContexts) ?? false) &&
        (webchatForceNewChat || !(deps.hasUploadedPdfInCurrentWebChatConversation?.() ?? false))
      )
      : false;

    const forcedSkillIds = deps.consumeForcedSkillIds?.();
    if (shouldRetainClaudeRuntime) {
      await deps.retainClaudeRuntime?.(deps.body, item);
    }
    const sendTask = deps.sendQuestion({
      body: deps.body,
      item,
      question: composedQuestion,
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
      selectedTexts: selectedTexts.length ? selectedTexts : undefined,
      selectedTextSources: selectedTexts.length ? selectedTextSources : undefined,
      selectedTextPaperContexts: selectedTexts.length ? selectedTextPaperContexts : undefined,
      selectedTextNoteContexts: selectedTexts.length ? selectedTextNoteContexts : undefined,
      paperContexts: selectedPaperContexts,
      fullTextPaperContexts,
      attachments: selectedFiles.length ? selectedFiles : undefined,
      runtimeMode,
      pdfModePaperKeys: pdfModeKeySet.size > 0 ? pdfModeKeySet : undefined,
      forcedSkillIds,
      pdfUploadSystemMessages: pdfUploadSystemMessages.length ? pdfUploadSystemMessages : undefined,
      webchatSendPdf,
      webchatForceNewChat,
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
    if (isWebChat && webchatSendPdf) {
      deps.markWebChatPdfUploadedForCurrentConversation?.();
    }
    deps.refreshGlobalHistoryHeader();
    } finally {
      deps.autoUnlockGlobalChat();
    }
  };

  return { doSend };
}
