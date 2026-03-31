/**
 * Agent mode execution engine.
 *
 * This module houses the send and retry flows for agent mode and is the single
 * place that calls agentRuntime.runTurn(). It has zero imports from chat.ts —
 * all chat.ts-owned utilities are injected via AgentEngineDeps so that agent
 * mode can be read and edited without opening chat.ts.
 */
import type { AgentRuntime } from "../../../agent/runtime";
import type {
  AgentEvent,
  AgentRunEventRecord,
  AgentRuntimeRequest,
} from "../../../agent/types";
import type {
  AdvancedModelParams,
  ChatAttachment,
  NoteContextRef,
  PaperContextRef,
  SelectedTextSource,
} from "../../../shared/types";
import type { ReasoningConfig as LLMReasoningConfig } from "../../../utils/llmClient";
import type { ChatMessage } from "../../../utils/llmClient";
import type { StoredChatMessage } from "../../../utils/chatStore";
import type { Message } from "../types";

// ---------------------------------------------------------------------------
// Types for panel helpers (defined inline to avoid importing from chat.ts)
// ---------------------------------------------------------------------------

type PanelRequestUIShape = {
  inputBox: HTMLTextAreaElement | null;
  chatBox: HTMLDivElement | null;
  sendBtn: HTMLButtonElement | null;
  cancelBtn: HTMLButtonElement | null;
  status: HTMLElement | null;
  tokenUsageEl: HTMLElement | null;
};

type StatusKind = "ready" | "sending" | "error" | "warning";

type PanelUpdateHelpers = {
  refreshChatSafely: () => void;
  setStatusSafely: (text: string, kind: StatusKind) => void;
};

type EffectiveRequestConfigShape = {
  model: string;
  apiBase: string;
  apiKey: string;
  authMode: "api_key" | "codex_auth";
  providerProtocol?:
    | "codex_responses"
    | "responses_api"
    | "openai_chat_compat"
    | "anthropic_messages"
    | "gemini_native";
  modelEntryId?: string;
  modelProviderLabel?: string;
  reasoning: LLMReasoningConfig | undefined;
  advanced: AdvancedModelParams | undefined;
};

type BuildAgentRuntimeRequestParamsShape = {
  conversationKey: number;
  item: Zotero.Item;
  userText: string;
  selectedTexts: string[];
  selectedTextSources?: SelectedTextSource[];
  paperContexts: PaperContextRef[];
  fullTextPaperContexts: PaperContextRef[];
  attachments: ChatAttachment[] | undefined;
  screenshots: string[] | undefined;
  effectiveRequestConfig: EffectiveRequestConfigShape;
  history: ChatMessage[];
};

type LatestRetryPairShape = {
  userIndex: number;
  userMessage: Message;
  assistantMessage: Message;
};

type ReconstructedRetryPayload = {
  question: string;
  screenshotImages: string[];
  paperContexts: PaperContextRef[];
  fullTextPaperContexts: PaperContextRef[];
};

// ---------------------------------------------------------------------------
// AgentEngineDeps — all external dependencies injected by chat.ts
// ---------------------------------------------------------------------------

export type AgentEngineDeps = {
  // Chat history (mutable Map reference; push() on the retrieved array mutates state)
  chatHistory: Map<number, Message[]>;

  // Agent trace cache
  agentRunTraceCache: Map<string, AgentRunEventRecord[]>;

  // Request lifecycle
  cancelledRequestId: () => number;
  currentAbortController: () => AbortController | null;
  setCurrentAbortController: (ctrl: AbortController | null) => void;
  getAbortController: () => new () => AbortController;
  nextRequestId: () => number;
  setPendingRequestId: (id: number) => void;

  // UI helpers
  getPanelRequestUI: (body: Element) => PanelRequestUIShape;
  setRequestUIBusy: (
    body: Element,
    ui: PanelRequestUIShape,
    conversationKey: number,
    text: string,
  ) => void;
  restoreRequestUIIdle: (
    body: Element,
    conversationKey: number,
    requestId: number,
  ) => void;
  setHistoryControlsDisabled: (body: Element, disabled: boolean) => void;
  createPanelUpdateHelpers: (
    body: Element,
    item: Zotero.Item,
    conversationKey: number,
    ui: PanelRequestUIShape,
  ) => PanelUpdateHelpers;

  // Data helpers
  ensureConversationLoaded: (item: Zotero.Item) => Promise<void>;
  getConversationKey: (item: Zotero.Item) => number;
  buildLLMHistoryMessages: (history: Message[]) => ChatMessage[];
  buildAgentRuntimeRequest: (
    params: BuildAgentRuntimeRequestParamsShape,
  ) => AgentRuntimeRequest | Promise<AgentRuntimeRequest>;
  resolveEffectiveRequestConfig: (params: {
    item: Zotero.Item;
    model?: string;
    apiBase?: string;
    apiKey?: string;
    reasoning?: LLMReasoningConfig;
    advanced?: AdvancedModelParams;
  }) => EffectiveRequestConfigShape;
  normalizeSelectedTexts: (
    selectedTexts: unknown,
    legacySelectedText?: unknown,
  ) => string[];
  normalizeSelectedTextSources: (
    sources: SelectedTextSource[] | undefined,
    count: number,
  ) => SelectedTextSource[];
  normalizeSelectedTextPaperContextsByIndex: (
    contexts: unknown,
    count: number,
  ) => (PaperContextRef | undefined)[];
  normalizeSelectedTextNoteContextsByIndex: (
    contexts: unknown,
    count: number,
  ) => (NoteContextRef | undefined)[];
  normalizePaperContexts: (paperContexts: unknown) => PaperContextRef[];
  includeAutoLoadedPaperContext: (
    item: Zotero.Item,
    paperContexts?: PaperContextRef[],
    fullTextPaperContexts?: PaperContextRef[],
  ) => { paperContexts: PaperContextRef[]; fullTextPaperContexts: PaperContextRef[] };
  findLatestRetryPair: (history: Message[]) => LatestRetryPairShape | null;
  reconstructRetryPayload: (userMessage: Message) => ReconstructedRetryPayload;
  isReasoningExpandedByDefault: () => boolean;
  createQueuedRefresh: (refresh: () => void) => () => void;
  waitForUiStep: () => Promise<void>;
  finalizeCancelledAssistantMessage: (
    message: Message,
    fallbackText?: string,
  ) => void;
  sanitizeText: (text: string) => string;

  // Persistence
  persistConversationMessage: (
    conversationKey: number,
    message: StoredChatMessage,
  ) => Promise<void>;
  updateStoredLatestUserMessage: (
    conversationKey: number,
    data: Partial<StoredChatMessage>,
  ) => Promise<void>;
  updateStoredLatestAssistantMessage: (
    conversationKey: number,
    data: Partial<StoredChatMessage>,
  ) => Promise<void>;

  // Chat fallback (when model does not support tool calls)
  sendChatFallback: (opts: import("../types").SendQuestionOptions) => Promise<void>;

  // Agent runtime
  getAgentRuntime: () => AgentRuntime;

  // Constant
  maxSelectedImages: number;
};

// ---------------------------------------------------------------------------
// sendAgentTurn — extracted from sendAgentQuestion in chat.ts
// ---------------------------------------------------------------------------

export async function sendAgentTurn(
  opts: {
    body: Element;
    item: Zotero.Item;
    question: string;
    images?: string[];
    model?: string;
    apiBase?: string;
    apiKey?: string;
    reasoning?: LLMReasoningConfig;
    advanced?: AdvancedModelParams;
    displayQuestion?: string;
    selectedTexts?: string[];
    selectedTextSources?: SelectedTextSource[];
    selectedTextPaperContexts?: (PaperContextRef | undefined)[];
    selectedTextNoteContexts?: (NoteContextRef | undefined)[];
    paperContexts?: PaperContextRef[];
    fullTextPaperContexts?: PaperContextRef[];
    attachments?: ChatAttachment[];
  },
  deps: AgentEngineDeps,
): Promise<void> {
  const {
    body, item, question, images, model, apiBase, apiKey, reasoning, advanced,
    displayQuestion, selectedTexts, selectedTextSources, selectedTextPaperContexts,
    selectedTextNoteContexts, paperContexts, fullTextPaperContexts, attachments,
  } = opts;
  await deps.ensureConversationLoaded(item);
  const conversationKey = deps.getConversationKey(item);
  const history = deps.chatHistory.get(conversationKey) || [];
  const llmHistory = deps.buildLLMHistoryMessages(history.slice());
  const effectiveRequestConfig = deps.resolveEffectiveRequestConfig({
    item,
    model,
    apiBase,
    apiKey,
    reasoning,
    advanced,
  });
  const selectedTextsForMessage = deps.normalizeSelectedTexts(selectedTexts);
  const selectedTextSourcesForMessage = deps.normalizeSelectedTextSources(
    selectedTextSources,
    selectedTextsForMessage.length,
  );
  const normalizedPaperContexts = deps.normalizePaperContexts(paperContexts);
  const normalizedFullTextPaperContexts =
    deps.normalizePaperContexts(fullTextPaperContexts);
  const {
    paperContexts: paperContextsForMessage,
    fullTextPaperContexts: fullTextPaperContextsForMessage,
  } = deps.includeAutoLoadedPaperContext(
    item,
    normalizedPaperContexts,
    normalizedFullTextPaperContexts,
  );
  const runtimeRequest = await deps.buildAgentRuntimeRequest({
    conversationKey,
    item,
    userText: question,
    selectedTexts: selectedTextsForMessage,
    selectedTextSources: selectedTextSourcesForMessage,
    paperContexts: paperContextsForMessage,
    fullTextPaperContexts: fullTextPaperContextsForMessage,
    attachments,
    screenshots: images,
    effectiveRequestConfig,
    history: llmHistory,
  });
  const agentRuntime = deps.getAgentRuntime();
  const capabilities = agentRuntime.getCapabilities(runtimeRequest);
  if (!capabilities.toolCalls) {
    const fallback = await agentRuntime.runTurn({
      request: runtimeRequest,
    });
    if (fallback.kind === "fallback") {
      await deps.sendChatFallback({
        body, item, question, images, model, apiBase, apiKey, reasoning, advanced,
        displayQuestion, selectedTexts, selectedTextSources, selectedTextPaperContexts,
        selectedTextNoteContexts, paperContexts, fullTextPaperContexts, attachments,
        runtimeMode: "agent",
        agentRunId: fallback.runId,
        skipAgentDispatch: true,
      });
      return;
    }
  }

  const ui = deps.getPanelRequestUI(body);
  const thisRequestId = deps.nextRequestId();
  deps.setPendingRequestId(thisRequestId);
  const initialConversationKey = deps.getConversationKey(item);
  deps.setRequestUIBusy(body, ui, initialConversationKey, "Preparing agent...");

  const historyForRun = deps.chatHistory.get(conversationKey) || [];
  const shownQuestion = displayQuestion || question;
  const selectedTextPaperContextsForMessage =
    deps.normalizeSelectedTextPaperContextsByIndex(
      selectedTextPaperContexts,
      selectedTextsForMessage.length,
    );
  const selectedTextNoteContextsForMessage =
    deps.normalizeSelectedTextNoteContextsByIndex(
      selectedTextNoteContexts,
      selectedTextsForMessage.length,
    );
  const screenshotImagesForMessage = Array.isArray(images)
    ? images
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, deps.maxSelectedImages)
    : [];
  const userMessage: Message = {
    role: "user",
    text: shownQuestion,
    timestamp: Date.now(),
    runMode: "agent",
    selectedText: selectedTextsForMessage[0] || undefined,
    selectedTextExpanded: false,
    selectedTexts: selectedTextsForMessage.length
      ? selectedTextsForMessage
      : undefined,
    selectedTextSources: selectedTextSourcesForMessage.length
      ? selectedTextSourcesForMessage
      : undefined,
    selectedTextPaperContexts: selectedTextPaperContextsForMessage.some(
      (entry) => Boolean(entry),
    )
      ? selectedTextPaperContextsForMessage
      : undefined,
    selectedTextNoteContexts: selectedTextNoteContextsForMessage.some(
      (entry) => Boolean(entry),
    )
      ? selectedTextNoteContextsForMessage
      : undefined,
    selectedTextExpandedIndex: -1,
    paperContexts: paperContextsForMessage.length
      ? paperContextsForMessage
      : undefined,
    fullTextPaperContexts: fullTextPaperContextsForMessage.length
      ? fullTextPaperContextsForMessage
      : undefined,
    paperContextsExpanded: false,
    screenshotImages: screenshotImagesForMessage.length
      ? screenshotImagesForMessage
      : undefined,
    screenshotExpanded: false,
    screenshotActiveIndex: 0,
    attachments: attachments?.length ? attachments : undefined,
  };
  historyForRun.push(userMessage);
  await deps.persistConversationMessage(conversationKey, {
    role: "user",
    text: userMessage.text,
    timestamp: userMessage.timestamp,
    runMode: "agent",
    selectedText: userMessage.selectedText,
    selectedTexts: userMessage.selectedTexts,
    selectedTextSources: userMessage.selectedTextSources,
    selectedTextPaperContexts: userMessage.selectedTextPaperContexts,
    paperContexts: userMessage.paperContexts,
    fullTextPaperContexts: userMessage.fullTextPaperContexts,
    screenshotImages: userMessage.screenshotImages,
    attachments: userMessage.attachments,
  });

  const assistantMessage: Message = {
    role: "assistant",
    text: "",
    timestamp: Date.now(),
    runMode: "agent",
    modelName: effectiveRequestConfig.model,
    modelEntryId: effectiveRequestConfig.modelEntryId,
    modelProviderLabel: effectiveRequestConfig.modelProviderLabel,
    streaming: true,
    reasoningOpen: false,
  };
  historyForRun.push(assistantMessage);
  const { refreshChatSafely, setStatusSafely } =
    deps.createPanelUpdateHelpers(body, item, conversationKey, ui);
  refreshChatSafely();

  let assistantPersisted = false;
  const persistAssistantOnce = async () => {
    if (assistantPersisted) return;
    assistantPersisted = true;
    await deps.persistConversationMessage(conversationKey, {
      role: "assistant",
      text: assistantMessage.text,
      timestamp: assistantMessage.timestamp,
      runMode: "agent",
      agentRunId: assistantMessage.agentRunId,
      modelName: assistantMessage.modelName,
      modelEntryId: assistantMessage.modelEntryId,
      modelProviderLabel: assistantMessage.modelProviderLabel,
    });
  };
  const markCancelled = async () => {
    deps.finalizeCancelledAssistantMessage(assistantMessage);
    refreshChatSafely();
    await persistAssistantOnce();
    setStatusSafely("Cancelled", "ready");
  };

  try {
    const AbortControllerCtor = deps.getAbortController();
    deps.setCurrentAbortController(
      AbortControllerCtor ? new AbortControllerCtor() : null,
    );
    const queueRefresh = deps.createQueuedRefresh(refreshChatSafely);

    const pushTraceEvent = (runId: string, event: AgentEvent) => {
      const list = deps.agentRunTraceCache.get(runId) || [];
      list.push({
        runId,
        seq: list.length + 1,
        eventType: event.type,
        payload: event,
        createdAt: Date.now(),
      });
      deps.agentRunTraceCache.set(runId, list);
    };

    const outcome = await agentRuntime.runTurn({
      request: runtimeRequest,
      signal: deps.currentAbortController()?.signal,
      onStart: async (runId) => {
        assistantMessage.agentRunId = runId;
        userMessage.agentRunId = runId;
        deps.agentRunTraceCache.set(runId, []);
        refreshChatSafely();
        await deps.updateStoredLatestUserMessage(conversationKey, {
          text: userMessage.text,
          timestamp: userMessage.timestamp,
          runMode: "agent",
          agentRunId: runId,
          selectedText: userMessage.selectedText,
          selectedTexts: userMessage.selectedTexts,
          selectedTextSources: userMessage.selectedTextSources,
          selectedTextPaperContexts: userMessage.selectedTextPaperContexts,
          screenshotImages: userMessage.screenshotImages,
          paperContexts: userMessage.paperContexts,
          fullTextPaperContexts: userMessage.fullTextPaperContexts,
          attachments: userMessage.attachments,
        });
      },
      onEvent: async (event) => {
        if (assistantMessage.agentRunId) {
          pushTraceEvent(assistantMessage.agentRunId, event);
        }
        switch (event.type) {
          case "status":
            setStatusSafely(event.text, "sending");
            break;
          case "fallback":
            setStatusSafely(event.reason, "sending");
            break;
          case "message_delta":
            assistantMessage.text += deps.sanitizeText(event.text);
            break;
          case "message_rollback":
            if (typeof event.length === "number" && event.length > 0) {
              assistantMessage.text = assistantMessage.text.slice(
                0,
                Math.max(0, assistantMessage.text.length - event.length),
              );
            }
            break;
          case "final":
            if (!assistantMessage.text.trim()) {
              assistantMessage.text = deps.sanitizeText(event.text);
            }
            assistantMessage.streaming = false;
            break;
          default:
            break;
        }
        if (event.type === "message_delta" || event.type === "message_rollback") {
          queueRefresh();
          return;
        }
        refreshChatSafely();
        await deps.waitForUiStep();
      },
    });

    if (
      deps.cancelledRequestId() >= thisRequestId ||
      Boolean(deps.currentAbortController()?.signal.aborted)
    ) {
      await markCancelled();
      return;
    }

    assistantMessage.agentRunId = outcome.runId;
    assistantMessage.runMode = "agent";
    const finalOutcomeText =
      outcome.kind === "completed" ? outcome.text : assistantMessage.text;
    assistantMessage.text =
      deps.sanitizeText(finalOutcomeText) ||
      assistantMessage.text ||
      "No response.";
    assistantMessage.streaming = false;
    refreshChatSafely();
    await persistAssistantOnce();
    setStatusSafely("Ready", "ready");
  } catch (err) {
    const isCancelled =
      deps.cancelledRequestId() >= thisRequestId ||
      Boolean(deps.currentAbortController()?.signal.aborted) ||
      (err as { name?: string }).name === "AbortError";
    if (isCancelled) {
      await markCancelled();
      return;
    }
    const errMsg = (err as Error).message || "Error";
    assistantMessage.text = `Error: ${errMsg}`;
    assistantMessage.streaming = false;
    refreshChatSafely();
    await persistAssistantOnce();
    setStatusSafely(`Error: ${errMsg.slice(0, 40)}`, "error");
  } finally {
    deps.setHistoryControlsDisabled(body, false);
    deps.restoreRequestUIIdle(body, conversationKey, thisRequestId);
    deps.setCurrentAbortController(null);
    deps.setPendingRequestId(0);
  }
}

// ---------------------------------------------------------------------------
// retryAgentTurn — extracted from retryLatestAgentResponse in chat.ts
// ---------------------------------------------------------------------------

export async function retryAgentTurn(
  body: Element,
  item: Zotero.Item,
  model: string | undefined,
  apiBase: string | undefined,
  apiKey: string | undefined,
  reasoning: LLMReasoningConfig | undefined,
  advanced: AdvancedModelParams | undefined,
  deps: AgentEngineDeps,
): Promise<void> {
  const ui = deps.getPanelRequestUI(body);
  await deps.ensureConversationLoaded(item);
  const conversationKey = deps.getConversationKey(item);
  const history = deps.chatHistory.get(conversationKey) || [];
  const retryPair = deps.findLatestRetryPair(history);
  if (!retryPair) {
    if (ui.status) {
      // Best-effort status update without full createPanelUpdateHelpers
      ui.status.textContent = "No retryable response found";
    }
    return;
  }

  const thisRequestId = deps.nextRequestId();
  deps.setPendingRequestId(thisRequestId);
  deps.setRequestUIBusy(body, ui, conversationKey, "Preparing agent retry...");

  const assistantMessage = retryPair.assistantMessage;

  // Clear the previous agent run so the trace and text reset immediately.
  assistantMessage.text = "";
  assistantMessage.agentRunId = undefined;
  assistantMessage.runMode = "agent";
  assistantMessage.streaming = true;
  assistantMessage.reasoningSummary = undefined;
  assistantMessage.reasoningDetails = undefined;
  assistantMessage.reasoningOpen = deps.isReasoningExpandedByDefault();

  const effectiveRequestConfig = deps.resolveEffectiveRequestConfig({
    item,
    model,
    apiBase,
    apiKey,
    reasoning,
    advanced,
  });
  assistantMessage.modelName = effectiveRequestConfig.model;
  assistantMessage.modelEntryId = effectiveRequestConfig.modelEntryId;
  assistantMessage.modelProviderLabel = effectiveRequestConfig.modelProviderLabel;

  const { refreshChatSafely, setStatusSafely } = deps.createPanelUpdateHelpers(
    body,
    item,
    conversationKey,
    ui,
  );
  refreshChatSafely(); // Immediately clear the old trace from view

  const { question, screenshotImages, paperContexts, fullTextPaperContexts } =
    deps.reconstructRetryPayload(retryPair.userMessage);
  if (!question.trim()) {
    setStatusSafely("Nothing to retry for latest turn", "error");
    deps.restoreRequestUIIdle(body, conversationKey, thisRequestId);
    deps.setHistoryControlsDisabled(body, false);
    return;
  }

  const selectedTextsRaw = Array.isArray(retryPair.userMessage.selectedTexts)
    ? (retryPair.userMessage.selectedTexts.filter(Boolean) as string[])
    : retryPair.userMessage.selectedText
      ? [retryPair.userMessage.selectedText]
      : [];
  const selectedTextSourcesRaw = deps.normalizeSelectedTextSources(
    retryPair.userMessage.selectedTextSources,
    selectedTextsRaw.length,
  );

  const historyForLLM = deps.buildLLMHistoryMessages(
    history.slice(0, retryPair.userIndex),
  );

  const runtimeRequest = await deps.buildAgentRuntimeRequest({
    conversationKey,
    item,
    userText: question,
    selectedTexts: selectedTextsRaw,
    selectedTextSources: selectedTextSourcesRaw,
    paperContexts,
    fullTextPaperContexts,
    attachments: retryPair.userMessage.attachments?.filter(
      (a) => a.category !== "image",
    ),
    screenshots: screenshotImages,
    effectiveRequestConfig,
    history: historyForLLM,
  });

  let assistantPersisted = false;
  const persistAssistantOnce = async () => {
    if (assistantPersisted) return;
    assistantPersisted = true;
    await deps.updateStoredLatestAssistantMessage(conversationKey, {
      text: assistantMessage.text,
      timestamp: assistantMessage.timestamp,
      runMode: "agent",
      agentRunId: assistantMessage.agentRunId,
      modelName: assistantMessage.modelName,
      modelEntryId: assistantMessage.modelEntryId,
      modelProviderLabel: assistantMessage.modelProviderLabel,
    });
  };
  const markCancelled = async () => {
    deps.finalizeCancelledAssistantMessage(assistantMessage);
    refreshChatSafely();
    await persistAssistantOnce();
    setStatusSafely("Cancelled", "ready");
  };

  const agentRuntime = deps.getAgentRuntime();
  try {
    const AbortControllerCtor = deps.getAbortController();
    deps.setCurrentAbortController(
      AbortControllerCtor ? new AbortControllerCtor() : null,
    );
    const queueRefresh = deps.createQueuedRefresh(refreshChatSafely);

    const pushTraceEvent = (runId: string, event: AgentEvent) => {
      const list = deps.agentRunTraceCache.get(runId) || [];
      list.push({
        runId,
        seq: list.length + 1,
        eventType: event.type,
        payload: event,
        createdAt: Date.now(),
      });
      deps.agentRunTraceCache.set(runId, list);
    };

    const outcome = await agentRuntime.runTurn({
      request: runtimeRequest,
      signal: deps.currentAbortController()?.signal,
      onStart: async (runId) => {
        assistantMessage.agentRunId = runId;
        retryPair.userMessage.agentRunId = runId;
        deps.agentRunTraceCache.set(runId, []);
        refreshChatSafely();
        await deps.updateStoredLatestUserMessage(conversationKey, {
          text: retryPair.userMessage.text,
          timestamp: retryPair.userMessage.timestamp,
          runMode: "agent",
          agentRunId: runId,
          selectedText: retryPair.userMessage.selectedText,
          selectedTexts: retryPair.userMessage.selectedTexts,
          selectedTextSources: retryPair.userMessage.selectedTextSources,
          selectedTextPaperContexts:
            retryPair.userMessage.selectedTextPaperContexts,
          screenshotImages: retryPair.userMessage.screenshotImages,
          paperContexts: retryPair.userMessage.paperContexts,
          attachments: retryPair.userMessage.attachments,
        });
      },
      onEvent: async (event) => {
        if (assistantMessage.agentRunId) {
          pushTraceEvent(assistantMessage.agentRunId, event);
        }
        switch (event.type) {
          case "status":
            setStatusSafely(event.text, "sending");
            break;
          case "fallback":
            setStatusSafely(event.reason, "sending");
            break;
          case "message_delta":
            assistantMessage.text += deps.sanitizeText(event.text);
            break;
          case "message_rollback":
            if (typeof event.length === "number" && event.length > 0) {
              assistantMessage.text = assistantMessage.text.slice(
                0,
                Math.max(0, assistantMessage.text.length - event.length),
              );
            }
            break;
          case "final":
            if (!assistantMessage.text.trim()) {
              assistantMessage.text = deps.sanitizeText(event.text);
            }
            assistantMessage.streaming = false;
            break;
          default:
            break;
        }
        if (event.type === "message_delta" || event.type === "message_rollback") {
          queueRefresh();
          return;
        }
        refreshChatSafely();
        await deps.waitForUiStep();
      },
    });

    if (
      deps.cancelledRequestId() >= thisRequestId ||
      Boolean(deps.currentAbortController()?.signal.aborted)
    ) {
      await markCancelled();
      return;
    }

    assistantMessage.agentRunId = outcome.runId;
    assistantMessage.runMode = "agent";
    const finalOutcomeText =
      outcome.kind === "completed" ? outcome.text : assistantMessage.text;
    assistantMessage.text =
      deps.sanitizeText(finalOutcomeText) ||
      assistantMessage.text ||
      "No response.";
    assistantMessage.streaming = false;
    refreshChatSafely();
    await persistAssistantOnce();
    setStatusSafely("Ready", "ready");
  } catch (err) {
    const isCancelled =
      deps.cancelledRequestId() >= thisRequestId ||
      Boolean(deps.currentAbortController()?.signal.aborted) ||
      (err as { name?: string }).name === "AbortError";
    if (isCancelled) {
      await markCancelled();
      return;
    }
    const errMsg = (err as Error).message || "Error";
    assistantMessage.text = `Error: ${errMsg}`;
    assistantMessage.streaming = false;
    refreshChatSafely();
    await persistAssistantOnce();
    setStatusSafely(`Error: ${errMsg.slice(0, 40)}`, "error");
  } finally {
    deps.setHistoryControlsDisabled(body, false);
    deps.restoreRequestUIIdle(body, conversationKey, thisRequestId);
    deps.setCurrentAbortController(null);
    deps.setPendingRequestId(0);
  }
}
