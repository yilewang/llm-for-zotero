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
  AgentPendingAction,
  AgentRunEventRecord,
  AgentRuntimeRequest,
} from "../../../agent/types";
import { consumePendingRetentionEvents } from "../../../claudeCode/runtimeRetention";
import {
  captureClaudeSessionInfo,
  buildClaudeScope,
} from "../../../claudeCode/runtime";
import {
  resolveConversationBaseItem,
  resolveDisplayConversationKind,
} from "../portalScope";
import { mergeCitationPaperContexts } from "../citationContexts";
import { renderPendingActionCard } from "../agentTrace/render";

function buildPendingAgentTraceEvents(body?: Element): AgentRunEventRecord[] {
  const now = Date.now();
  const events: AgentRunEventRecord[] = [
    {
      runId: "pending",
      seq: 1,
      eventType: "status",
      payload: {
        type: "status",
        text: "Checking the request against the attached context.",
      },
      createdAt: now,
    },
    {
      runId: "pending",
      seq: 2,
      eventType: "status",
      payload: {
        type: "status",
        text: "Request and attached context received",
      },
      createdAt: now + 1,
    },
  ];
  if (!body) return events;
  const retentionEvents = consumePendingRetentionEvents(body);
  for (const event of retentionEvents) {
    events.push({
      runId: "pending",
      seq: events.length + 1,
      eventType: event.type,
      payload: event,
      createdAt: Date.now(),
    });
  }
  return events;
}

function applyResolvedClaudeEffortDisplay(
  body: Element,
  event: AgentEvent,
): void {
  if (event.type !== "provider_event") return;
  if (event.providerType !== "runtime_config") return;
  const applyResolvedEffort = (body as any).__llmApplyResolvedClaudeEffort as
    | ((effort: unknown) => void)
    | undefined;
  if (typeof applyResolvedEffort !== "function") return;
  applyResolvedEffort(event.payload?.resolvedEffort);
}
import type {
  AdvancedModelParams,
  ChatAttachment,
  CollectionContextRef,
  NoteContextRef,
  PaperContextRef,
  SelectedTextSource,
} from "../../../shared/types";
import type { ReasoningConfig as LLMReasoningConfig } from "../../../utils/llmClient";
import type { ChatMessage } from "../../../utils/llmClient";
import type { StoredChatMessage } from "../../../utils/chatStore";
import type { Message } from "../types";
import { isClaudeBlockStreamingEnabled } from "../../../claudeCode/prefs";

function shouldSyncVisibleRollbackText(message: Message): boolean {
  return (
    isClaudeBlockStreamingEnabled() || message.modelProviderLabel === "Codex"
  );
}

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

function syncInlineActionCardState(
  body: Element,
  ui: PanelRequestUIShape,
): void {
  const hasCard = Boolean(ui.chatBox?.querySelector(".llm-action-inline-card"));
  const panelRoot = body as HTMLElement;
  if (hasCard) {
    panelRoot.dataset.hasActionCard = "true";
  } else {
    delete panelRoot.dataset.hasActionCard;
  }
}

function scrollActionCardIntoView(
  chatBox: HTMLElement,
  card: HTMLElement,
): void {
  const scroll = () => {
    try {
      card.scrollIntoView({ block: "end" });
    } catch {
      // Older Zotero runtimes can be picky about scrollIntoView options.
    }
    chatBox.scrollTop = chatBox.scrollHeight;
  };
  scroll();
  const view = chatBox.ownerDocument?.defaultView;
  view?.requestAnimationFrame?.(scroll);
  view?.setTimeout(scroll, 80);
}

function findRenderedPendingActionCard(
  chatBox: HTMLElement,
  requestId: string,
): HTMLElement | null {
  const cards = Array.from(
    chatBox.querySelectorAll(".llm-agent-hitl-card[data-request-id]"),
  ) as HTMLElement[];
  return cards.find((card) => card.dataset.requestId === requestId) || null;
}

function showInlineConfirmationCard(
  body: Element,
  ui: PanelRequestUIShape,
  requestId: string,
  action: AgentPendingAction,
): void {
  const chatBox = ui.chatBox;
  const ownerDoc = body.ownerDocument;
  if (!chatBox || !ownerDoc) return;
  chatBox.querySelector(".llm-action-inline-card")?.remove();
  const renderedCard = findRenderedPendingActionCard(chatBox, requestId);
  if (renderedCard) {
    scrollActionCardIntoView(chatBox, renderedCard);
    syncInlineActionCardState(body, ui);
    return;
  }
  const wrapper = ownerDoc.createElement("div");
  wrapper.className = "llm-action-inline-card";
  wrapper.dataset.requestId = requestId;
  wrapper.appendChild(renderPendingActionCard(ownerDoc, { requestId, action }));
  chatBox.appendChild(wrapper);
  scrollActionCardIntoView(chatBox, wrapper);
  syncInlineActionCardState(body, ui);
}

function closeInlineConfirmationCard(
  body: Element,
  ui: PanelRequestUIShape,
  requestId?: string,
): void {
  const chatBox = ui.chatBox;
  if (!chatBox) return;
  let card: Element | null = null;
  if (requestId) {
    card =
      (
        Array.from(
          chatBox.querySelectorAll(".llm-action-inline-card"),
        ) as HTMLElement[]
      ).find((entry) => entry.dataset.requestId === requestId) ||
      chatBox.querySelector(".llm-action-inline-card");
  } else {
    card = chatBox.querySelector(".llm-action-inline-card");
  }
  card?.remove();
  syncInlineActionCardState(body, ui);
}

function extractPaperContextCandidatesFromToolContent(
  content: unknown,
): unknown[] {
  const out: unknown[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      Number.isFinite(Number(record.itemId)) &&
      Number.isFinite(Number(record.contextItemId)) &&
      typeof record.title === "string"
    ) {
      out.push(record);
    }
    if (record.paperContext) {
      visit(record.paperContext, depth + 1);
    }
    for (const key of ["results", "papers", "items", "artifacts"]) {
      if (record[key]) visit(record[key], depth + 1);
    }
  };
  visit(content, 0);
  return out;
}

type EffectiveRequestConfigShape = {
  model: string;
  apiBase: string;
  apiKey: string;
  authMode:
    | "api_key"
    | "codex_auth"
    | "codex_app_server"
    | "copilot_auth"
    | "webchat";
  providerProtocol?:
    | "codex_responses"
    | "responses_api"
    | "openai_chat_compat"
    | "anthropic_messages"
    | "gemini_native"
    | "web_sync";
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
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  paperContexts: PaperContextRef[];
  fullTextPaperContexts: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
  attachments: ChatAttachment[] | undefined;
  screenshots: string[] | undefined;
  forcedSkillIds?: string[];
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
  citationPaperContexts?: PaperContextRef[];
  selectedCollectionContexts: CollectionContextRef[];
};

// ---------------------------------------------------------------------------
// AgentEngineDeps — all external dependencies injected by chat.ts
// ---------------------------------------------------------------------------

export type AgentEngineDeps = {
  // Chat history (mutable Map reference; push() on the retrieved array mutates state)
  chatHistory: Map<number, Message[]>;

  // Agent trace cache
  agentRunTraceCache: Map<string, AgentRunEventRecord[]>;

  // Request lifecycle (per-conversation)
  cancelledRequestId: (conversationKey: number) => number;
  currentAbortController: (conversationKey: number) => AbortController | null;
  setCurrentAbortController: (
    conversationKey: number,
    ctrl: AbortController | null,
  ) => void;
  getAbortControllerCtor: () => new () => AbortController;
  nextRequestId: () => number;
  setPendingRequestId: (conversationKey: number, id: number) => void;

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
  scheduleQueuedInputDrain: (
    body: Element,
    scope?: {
      conversationSystem?: string | null;
      conversationKey?: number | null;
      webChatActive?: boolean;
    },
  ) => void;
  createPanelUpdateHelpers: (
    body: Element,
    item: Zotero.Item,
    conversationKey: number,
    ui: PanelRequestUIShape,
  ) => PanelUpdateHelpers;

  // Data helpers
  ensureConversationLoaded: (item: Zotero.Item) => Promise<void>;
  getConversationSystem: () => string;
  accumulateSessionTokens: (conversationKey: number, delta: number) => number;
  getContextUsageSnapshot: (conversationKey: number) =>
    | {
        contextTokens: number;
        contextWindow?: number;
        contextWindowIsAuthoritative?: boolean;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        cacheMissTokens?: number;
        cacheHitRatio?: number;
        cacheProvider?: string;
        estimated?: boolean;
        source?: "estimated" | "provider" | "persisted";
      }
    | undefined;
  setContextUsageSnapshot: (
    conversationKey: number,
    snapshot: {
      contextTokens: number;
      contextWindow?: number;
      contextWindowIsAuthoritative?: boolean;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      cacheMissTokens?: number;
      cacheHitRatio?: number;
      cacheProvider?: string;
      estimated?: boolean;
      source?: "estimated" | "provider" | "persisted";
    },
  ) => void;
  setTokenUsage: (
    el: HTMLElement,
    sessionTokens: number,
    contextWindow?: number,
    gaugeEl?: HTMLElement | null,
    options?: {
      estimated?: boolean;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      cacheMissTokens?: number;
      cacheHitRatio?: number;
      cacheProvider?: string;
    },
  ) => void;
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
    authMode?:
      | "api_key"
      | "codex_auth"
      | "codex_app_server"
      | "copilot_auth"
      | "webchat";
    providerProtocol?:
      | "codex_responses"
      | "responses_api"
      | "openai_chat_compat"
      | "anthropic_messages"
      | "gemini_native"
      | "web_sync";
    modelEntryId?: string;
    modelProviderLabel?: string;
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
  ) => {
    paperContexts: PaperContextRef[];
    fullTextPaperContexts: PaperContextRef[];
  };
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
  appendReasoningPart: (base: string | undefined, next?: string) => string;

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
  sendChatFallback: (
    opts: import("../types").SendQuestionOptions,
  ) => Promise<void>;

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
    authMode?:
      | "api_key"
      | "codex_auth"
      | "codex_app_server"
      | "copilot_auth"
      | "webchat";
    providerProtocol?:
      | "codex_responses"
      | "responses_api"
      | "openai_chat_compat"
      | "anthropic_messages"
      | "gemini_native"
      | "web_sync";
    modelEntryId?: string;
    modelProviderLabel?: string;
    reasoning?: LLMReasoningConfig;
    advanced?: AdvancedModelParams;
    displayQuestion?: string;
    selectedTexts?: string[];
    selectedTextSources?: SelectedTextSource[];
    selectedTextPaperContexts?: (PaperContextRef | undefined)[];
    selectedTextNoteContexts?: (NoteContextRef | undefined)[];
    paperContexts?: PaperContextRef[];
    fullTextPaperContexts?: PaperContextRef[];
    selectedCollectionContexts?: CollectionContextRef[];
    attachments?: ChatAttachment[];
    modelAttachments?: ChatAttachment[];
    forcedSkillIds?: string[];
  },
  deps: AgentEngineDeps,
): Promise<void> {
  const {
    body,
    item,
    question,
    images,
    model,
    apiBase,
    apiKey,
    authMode,
    providerProtocol,
    modelEntryId,
    modelProviderLabel,
    reasoning,
    advanced,
    displayQuestion,
    selectedTexts,
    selectedTextSources,
    selectedTextPaperContexts,
    selectedTextNoteContexts,
    paperContexts,
    fullTextPaperContexts,
    selectedCollectionContexts,
    attachments,
    modelAttachments,
    forcedSkillIds,
  } = opts;
  const conversationKey = deps.getConversationKey(item);
  const ui = deps.getPanelRequestUI(body);
  const thisRequestId = deps.nextRequestId();
  deps.setPendingRequestId(conversationKey, thisRequestId);
  deps.setRequestUIBusy(body, ui, conversationKey, "Preparing agent...");

  const selectedTextsForMessage = deps.normalizeSelectedTexts(selectedTexts);
  const selectedTextSourcesForMessage = deps.normalizeSelectedTextSources(
    selectedTextSources,
    selectedTextsForMessage.length,
  );
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
  const shownQuestion = displayQuestion || question;
  const screenshotImagesForMessage = Array.isArray(images)
    ? images
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, deps.maxSelectedImages)
    : [];

  const historyForRun = deps.chatHistory.get(conversationKey) || [];
  const isCompactCommand = /^\/compact(?:\s|$)/i.test(question.trim());
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
    selectedTextNoteContexts: selectedTextNoteContextsForMessage.some((entry) =>
      Boolean(entry),
    )
      ? selectedTextNoteContextsForMessage
      : undefined,
    citationPaperContexts: mergeCitationPaperContexts(
      selectedTextPaperContextsForMessage,
    ),
    selectedTextExpandedIndex: -1,
    paperContextsExpanded: false,
    screenshotImages: screenshotImagesForMessage.length
      ? screenshotImagesForMessage
      : undefined,
    screenshotExpanded: false,
    screenshotActiveIndex: 0,
    attachments: attachments?.length ? attachments : undefined,
    selectedCollectionContexts: selectedCollectionContexts?.length
      ? selectedCollectionContexts
      : undefined,
  };
  if (modelAttachments !== undefined) {
    userMessage.modelAttachments = modelAttachments;
  }
  if (!isCompactCommand) {
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
      selectedTextNoteContexts: userMessage.selectedTextNoteContexts,
      citationPaperContexts: userMessage.citationPaperContexts,
      selectedCollectionContexts: userMessage.selectedCollectionContexts,
      screenshotImages: userMessage.screenshotImages,
      attachments: userMessage.attachments,
      modelAttachments: userMessage.modelAttachments,
    });
  }

  const effectiveRequestConfig = deps.resolveEffectiveRequestConfig({
    item,
    model,
    apiBase,
    apiKey,
    authMode,
    providerProtocol,
    modelEntryId,
    modelProviderLabel,
    reasoning,
    advanced,
  });
  userMessage.modelName = effectiveRequestConfig.model;
  userMessage.modelEntryId = effectiveRequestConfig.modelEntryId;
  userMessage.modelProviderLabel = effectiveRequestConfig.modelProviderLabel;
  const assistantMessage: Message = {
    role: "assistant",
    text: "",
    timestamp: Date.now(),
    runMode: "agent",
    modelName: effectiveRequestConfig.model,
    modelEntryId: effectiveRequestConfig.modelEntryId,
    modelProviderLabel: effectiveRequestConfig.modelProviderLabel,
    streaming: true,
    waitingAnimationStartedAt:
      effectiveRequestConfig.modelProviderLabel === "Claude Code" ||
      effectiveRequestConfig.modelProviderLabel === "Codex"
        ? Date.now()
        : undefined,
    pendingAgentTraceEvents:
      effectiveRequestConfig.modelProviderLabel === "Claude Code" ||
      effectiveRequestConfig.modelProviderLabel === "Codex"
        ? buildPendingAgentTraceEvents(body)
        : undefined,
    reasoningOpen: false,
  };
  historyForRun.push(assistantMessage);
  const { refreshChatSafely, setStatusSafely } = deps.createPanelUpdateHelpers(
    body,
    item,
    conversationKey,
    ui,
  );
  const queueRefresh = deps.createQueuedRefresh(refreshChatSafely);
  const scheduleQueueDrain = () =>
    deps.scheduleQueuedInputDrain(body, {
      conversationSystem: deps.getConversationSystem(),
      conversationKey,
      webChatActive: effectiveRequestConfig.providerProtocol === "web_sync",
    });
  setStatusSafely(
    "Checking the request against the attached context.",
    "sending",
  );
  refreshChatSafely();

  await deps.ensureConversationLoaded(item);
  const history = deps.chatHistory.get(conversationKey) || [];
  const llmHistory = deps.buildLLMHistoryMessages(history.slice(0, -2));
  const normalizedPaperContexts = deps.normalizePaperContexts(paperContexts);
  const normalizedFullTextPaperContexts = deps.normalizePaperContexts(
    fullTextPaperContexts,
  );
  const {
    paperContexts: paperContextsForMessage,
    fullTextPaperContexts: fullTextPaperContextsForMessage,
  } = deps.includeAutoLoadedPaperContext(
    item,
    normalizedPaperContexts,
    normalizedFullTextPaperContexts,
  );
  userMessage.paperContexts = paperContextsForMessage.length
    ? paperContextsForMessage
    : undefined;
  userMessage.fullTextPaperContexts = fullTextPaperContextsForMessage.length
    ? fullTextPaperContextsForMessage
    : undefined;
  userMessage.citationPaperContexts = mergeCitationPaperContexts(
    userMessage.selectedTextPaperContexts,
    paperContextsForMessage,
    fullTextPaperContextsForMessage,
  );
  if (!isCompactCommand) {
    await deps.updateStoredLatestUserMessage(conversationKey, {
      text: userMessage.text,
      timestamp: userMessage.timestamp,
      runMode: "agent",
      selectedText: userMessage.selectedText,
      selectedTexts: userMessage.selectedTexts,
      selectedTextSources: userMessage.selectedTextSources,
      selectedTextPaperContexts: userMessage.selectedTextPaperContexts,
      selectedTextNoteContexts: userMessage.selectedTextNoteContexts,
      paperContexts: userMessage.paperContexts,
      fullTextPaperContexts: userMessage.fullTextPaperContexts,
      citationPaperContexts: userMessage.citationPaperContexts,
      selectedCollectionContexts: userMessage.selectedCollectionContexts,
      screenshotImages: userMessage.screenshotImages,
      attachments: userMessage.attachments,
      modelAttachments: userMessage.modelAttachments,
      modelName: userMessage.modelName,
      modelEntryId: userMessage.modelEntryId,
      modelProviderLabel: userMessage.modelProviderLabel,
    });
  }
  const runtimeRequest = await deps.buildAgentRuntimeRequest({
    conversationKey,
    item,
    userText: question,
    selectedTexts: selectedTextsForMessage,
    selectedTextSources: selectedTextSourcesForMessage,
    selectedTextPaperContexts: selectedTextPaperContextsForMessage,
    paperContexts: paperContextsForMessage,
    fullTextPaperContexts: fullTextPaperContextsForMessage,
    selectedCollectionContexts,
    attachments: modelAttachments ?? attachments,
    screenshots: images,
    forcedSkillIds,
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
      historyForRun.pop();
      await deps.sendChatFallback({
        body,
        item,
        question,
        images,
        model,
        apiBase,
        apiKey,
        authMode,
        providerProtocol,
        modelEntryId,
        modelProviderLabel,
        reasoning,
        advanced,
        displayQuestion,
        selectedTexts,
        selectedTextSources,
        selectedTextPaperContexts,
        selectedTextNoteContexts,
        paperContexts,
        fullTextPaperContexts,
        selectedCollectionContexts,
        attachments,
        modelAttachments,
        runtimeMode: "agent",
        agentRunId: fallback.runId,
        skipAgentDispatch: true,
      });
      return;
    }
  }

  let assistantPersisted = false;
  const persistAssistantOnce = async () => {
    if (assistantPersisted) return;
    assistantPersisted = true;
    const snapshot = deps.getContextUsageSnapshot?.(conversationKey);
    await deps.persistConversationMessage(conversationKey, {
      role: "assistant",
      text: assistantMessage.text,
      timestamp: assistantMessage.timestamp,
      runMode: "agent",
      agentRunId: assistantMessage.agentRunId,
      modelName: assistantMessage.modelName,
      modelEntryId: assistantMessage.modelEntryId,
      modelProviderLabel: assistantMessage.modelProviderLabel,
      contextTokens: snapshot?.contextTokens,
      contextWindow: snapshot?.contextWindow,
    });
  };
  const markCancelled = async () => {
    deps.finalizeCancelledAssistantMessage(assistantMessage);
    refreshChatSafely();
    await persistAssistantOnce();
    setStatusSafely("Cancelled", "ready");
  };

  try {
    const AbortControllerCtor = deps.getAbortControllerCtor();
    deps.setCurrentAbortController(
      conversationKey,
      AbortControllerCtor ? new AbortControllerCtor() : null,
    );

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
      signal: deps.currentAbortController(conversationKey)?.signal,
      onStart: async (runId) => {
        assistantMessage.agentRunId = runId;
        userMessage.agentRunId = runId;
        deps.agentRunTraceCache.set(runId, []);
        refreshChatSafely();
        if (!isCompactCommand) {
          await deps.updateStoredLatestUserMessage(conversationKey, {
            text: userMessage.text,
            timestamp: userMessage.timestamp,
            runMode: "agent",
            agentRunId: runId,
            selectedText: userMessage.selectedText,
            selectedTexts: userMessage.selectedTexts,
            selectedTextSources: userMessage.selectedTextSources,
            selectedTextPaperContexts: userMessage.selectedTextPaperContexts,
            selectedTextNoteContexts: userMessage.selectedTextNoteContexts,
            screenshotImages: userMessage.screenshotImages,
            paperContexts: userMessage.paperContexts,
            fullTextPaperContexts: userMessage.fullTextPaperContexts,
            citationPaperContexts: userMessage.citationPaperContexts,
            selectedCollectionContexts: userMessage.selectedCollectionContexts,
            attachments: userMessage.attachments,
            modelAttachments: userMessage.modelAttachments,
            modelName: userMessage.modelName,
            modelEntryId: userMessage.modelEntryId,
            modelProviderLabel: userMessage.modelProviderLabel,
          });
        }
      },
      onEvent: async (event) => {
        if (assistantMessage.agentRunId) {
          pushTraceEvent(assistantMessage.agentRunId, event);
        }
        switch (event.type) {
          case "provider_event":
            applyResolvedClaudeEffortDisplay(body, event);
            break;
          case "usage": {
            if (ui.tokenUsageEl) {
              const previous = deps.getContextUsageSnapshot?.(conversationKey);
              const usageEvent = event as Extract<
                AgentEvent,
                { type: "usage" }
              >;
              const usageRecord = usageEvent as unknown as Record<
                string,
                unknown
              >;
              const hasContextPayload = "contextTokens" in usageRecord;
              if (hasContextPayload) {
                const nextTokens = Math.max(
                  0,
                  Number(usageRecord.contextTokens) || 0,
                );
                const rawContextWindow = usageRecord.contextWindow;
                const nextWindow =
                  typeof rawContextWindow === "number" &&
                  Number.isFinite(rawContextWindow)
                    ? rawContextWindow
                    : previous?.contextWindow;
                const effectiveTokens =
                  nextTokens > 0
                    ? nextTokens
                    : usageRecord.contextWindowIsAuthoritative === true
                      ? (previous?.contextTokens ?? 0)
                      : 0;
                deps.setContextUsageSnapshot?.(conversationKey, {
                  contextTokens: effectiveTokens,
                  contextWindow: nextWindow,
                  contextWindowIsAuthoritative:
                    usageRecord.contextWindowIsAuthoritative === true,
                  cacheReadTokens:
                    typeof usageRecord.cacheReadTokens === "number"
                      ? usageRecord.cacheReadTokens
                      : undefined,
                  cacheWriteTokens:
                    typeof usageRecord.cacheWriteTokens === "number"
                      ? usageRecord.cacheWriteTokens
                      : undefined,
                  cacheMissTokens:
                    typeof usageRecord.cacheMissTokens === "number"
                      ? usageRecord.cacheMissTokens
                      : undefined,
                  cacheHitRatio:
                    typeof usageRecord.cacheHitRatio === "number"
                      ? usageRecord.cacheHitRatio
                      : undefined,
                  cacheProvider:
                    typeof usageRecord.cacheProvider === "string"
                      ? usageRecord.cacheProvider
                      : undefined,
                  estimated: usageRecord.contextWindowIsAuthoritative !== true,
                  source:
                    usageRecord.contextWindowIsAuthoritative === true
                      ? "provider"
                      : "estimated",
                });
                deps.setTokenUsage(
                  ui.tokenUsageEl,
                  effectiveTokens,
                  nextWindow,
                  body.querySelector(
                    "#llm-claude-context-gauge",
                  ) as HTMLElement | null,
                  {
                    estimated:
                      usageRecord.contextWindowIsAuthoritative !== true,
                    cacheReadTokens:
                      typeof usageRecord.cacheReadTokens === "number"
                        ? usageRecord.cacheReadTokens
                        : undefined,
                    cacheWriteTokens:
                      typeof usageRecord.cacheWriteTokens === "number"
                        ? usageRecord.cacheWriteTokens
                        : undefined,
                    cacheMissTokens:
                      typeof usageRecord.cacheMissTokens === "number"
                        ? usageRecord.cacheMissTokens
                        : undefined,
                    cacheHitRatio:
                      typeof usageRecord.cacheHitRatio === "number"
                        ? usageRecord.cacheHitRatio
                        : undefined,
                    cacheProvider:
                      typeof usageRecord.cacheProvider === "string"
                        ? usageRecord.cacheProvider
                        : undefined,
                  },
                );
              } else if (
                typeof usageRecord.totalTokens === "number" &&
                usageRecord.totalTokens > 0
              ) {
                deps.accumulateSessionTokens(
                  conversationKey,
                  usageRecord.totalTokens,
                );
              }
            }
            break;
          }
          case "tool_result": {
            if (!event.ok) break;
            const toolPaperContexts = deps.normalizePaperContexts([
              ...extractPaperContextCandidatesFromToolContent(event.content),
              ...extractPaperContextCandidatesFromToolContent(event.artifacts),
            ]);
            if (!toolPaperContexts.length) break;
            const before = userMessage.citationPaperContexts?.length || 0;
            userMessage.citationPaperContexts = mergeCitationPaperContexts(
              userMessage.citationPaperContexts,
              toolPaperContexts,
            );
            if ((userMessage.citationPaperContexts?.length || 0) === before)
              break;
            if (!isCompactCommand) {
              await deps.updateStoredLatestUserMessage(conversationKey, {
                text: userMessage.text,
                timestamp: userMessage.timestamp,
                runMode: "agent",
                agentRunId: userMessage.agentRunId,
                selectedText: userMessage.selectedText,
                selectedTexts: userMessage.selectedTexts,
                selectedTextSources: userMessage.selectedTextSources,
                selectedTextPaperContexts:
                  userMessage.selectedTextPaperContexts,
                selectedTextNoteContexts: userMessage.selectedTextNoteContexts,
                paperContexts: userMessage.paperContexts,
                fullTextPaperContexts: userMessage.fullTextPaperContexts,
                citationPaperContexts: userMessage.citationPaperContexts,
                selectedCollectionContexts:
                  userMessage.selectedCollectionContexts,
                screenshotImages: userMessage.screenshotImages,
                attachments: userMessage.attachments,
                modelAttachments: userMessage.modelAttachments,
                modelName: userMessage.modelName,
                modelEntryId: userMessage.modelEntryId,
                modelProviderLabel: userMessage.modelProviderLabel,
              });
            }
            break;
          }
          case "status": {
            const isCompactingStatus = /compacting context/i.test(event.text);
            if (
              !isCompactingStatus &&
              !assistantMessage.agentRunId &&
              assistantMessage.pendingAgentTraceEvents
            ) {
              assistantMessage.pendingAgentTraceEvents.push({
                runId: "pending",
                seq: assistantMessage.pendingAgentTraceEvents.length + 1,
                eventType: event.type,
                payload: event,
                createdAt: Date.now(),
              });
            }
            setStatusSafely(event.text, "sending");
            if (isCompactingStatus) {
              assistantMessage.pendingAgentTraceEvents = undefined;
              queueRefresh();
            }
            break;
          }
          case "reasoning": {
            if (event.summary) {
              assistantMessage.reasoningSummary = deps.appendReasoningPart(
                assistantMessage.reasoningSummary,
                event.summary,
              );
            }
            if (event.details) {
              assistantMessage.reasoningDetails = deps.appendReasoningPart(
                assistantMessage.reasoningDetails,
                event.details,
              );
            }
            queueRefresh();
            return;
          }
          case "fallback":
            if (assistantMessage.text === "Compacting context…") {
              assistantMessage.text = "";
            }
            setStatusSafely(event.reason, "sending");
            break;
          case "confirmation_required":
            showInlineConfirmationCard(body, ui, event.requestId, event.action);
            queueRefresh();
            body.ownerDocument?.defaultView?.setTimeout(() => {
              showInlineConfirmationCard(
                body,
                ui,
                event.requestId,
                event.action,
              );
            }, 90);
            setStatusSafely("Approval required", "sending");
            return;
          case "confirmation_resolved":
            closeInlineConfirmationCard(body, ui, event.requestId);
            queueRefresh();
            setStatusSafely(
              event.approved ? "Approval sent" : "Action denied",
              "sending",
            );
            return;
          case "message_delta": {
            assistantMessage.pendingFinalText = `${assistantMessage.pendingFinalText || ""}${deps.sanitizeText(event.text)}`;
            assistantMessage.text =
              assistantMessage.pendingFinalText || assistantMessage.text;
            queueRefresh();
            return;
          }
          case "message_rollback":
            if (typeof event.length === "number" && event.length > 0) {
              assistantMessage.pendingFinalText = (
                assistantMessage.pendingFinalText || ""
              ).slice(
                0,
                Math.max(
                  0,
                  (assistantMessage.pendingFinalText || "").length -
                    event.length,
                ),
              );
              if (shouldSyncVisibleRollbackText(assistantMessage)) {
                assistantMessage.text = assistantMessage.pendingFinalText || "";
                queueRefresh();
              }
            }
            return;
          case "context_compacted": {
            const compactMarker: Message = {
              role: "assistant",
              text: event.automatic
                ? "Context compacted automatically"
                : "Conversation compacted",
              timestamp: Date.now(),
              runMode: "agent",
              compactMarker: true,
              modelName: assistantMessage.modelName,
              modelEntryId: assistantMessage.modelEntryId,
              modelProviderLabel: assistantMessage.modelProviderLabel,
            };
            const insertIndex = Math.max(
              0,
              historyForRun.indexOf(assistantMessage),
            );
            historyForRun.splice(insertIndex, 0, compactMarker);
            await deps.persistConversationMessage(conversationKey, {
              role: "assistant",
              text: compactMarker.text,
              timestamp: compactMarker.timestamp,
              runMode: "agent",
              modelName: compactMarker.modelName,
              modelEntryId: compactMarker.modelEntryId,
              modelProviderLabel: compactMarker.modelProviderLabel,
              compactMarker: true,
            });
            assistantMessage.text = "";
            assistantMessage.pendingAgentTraceEvents = undefined;
            refreshChatSafely();
            scheduleQueueDrain?.();
            await deps.waitForUiStep();
            return;
          }
          case "final":
            assistantMessage.text =
              deps.sanitizeText(event.text) ||
              assistantMessage.pendingFinalText ||
              assistantMessage.text;
            assistantMessage.pendingFinalText = undefined;
            assistantMessage.streaming = false;
            scheduleQueueDrain?.();
            break;
          default:
            break;
        }
        refreshChatSafely();
        await deps.waitForUiStep();
      },
    });

    if (
      deps.cancelledRequestId(conversationKey) >= thisRequestId ||
      Boolean(deps.currentAbortController(conversationKey)?.signal.aborted)
    ) {
      await markCancelled();
      return;
    }

    assistantMessage.agentRunId = outcome.runId;
    assistantMessage.runMode = "agent";
    const finalOutcomeText =
      outcome.kind === "completed"
        ? outcome.text
        : assistantMessage.pendingFinalText || assistantMessage.text;
    assistantMessage.text =
      deps.sanitizeText(finalOutcomeText) ||
      assistantMessage.pendingFinalText ||
      assistantMessage.text ||
      "No response.";
    assistantMessage.pendingFinalText = undefined;
    assistantMessage.waitingAnimationStartedAt = undefined;
    assistantMessage.streaming = false;
    refreshChatSafely();
    await persistAssistantOnce();
    if (deps.getConversationSystem?.() === "claude_code") {
      const conversationKind = resolveDisplayConversationKind(item);
      const baseItem = resolveConversationBaseItem(item);
      await captureClaudeSessionInfo(
        conversationKey,
        buildClaudeScope({
          libraryID: Number(item.libraryID || baseItem?.libraryID || 0),
          kind: conversationKind === "global" ? "global" : "paper",
          paperItemID:
            conversationKind === "paper"
              ? Number(baseItem?.id || 0) || undefined
              : undefined,
          paperTitle:
            conversationKind === "paper"
              ? String(baseItem?.getField?.("title") || "").trim() || undefined
              : undefined,
        }),
      ).catch(() => null);
    }
    setStatusSafely("Ready", "ready");
  } catch (err) {
    const isCancelled =
      deps.cancelledRequestId(conversationKey) >= thisRequestId ||
      Boolean(deps.currentAbortController(conversationKey)?.signal.aborted) ||
      (err as { name?: string }).name === "AbortError";
    if (isCancelled) {
      await markCancelled();
      return;
    }
    const errMsg = (err as Error).message || "Error";
    const userFacingError =
      errMsg.includes("[ede_diagnostic]") &&
      errMsg.includes("last_content_type=none")
        ? "The model returned an empty reply. Please retry."
        : errMsg;
    assistantMessage.text = `Error: ${userFacingError}`;
    assistantMessage.streaming = false;
    refreshChatSafely();
    await persistAssistantOnce();
    setStatusSafely(`Error: ${userFacingError.slice(0, 40)}`, "error");
  } finally {
    deps.setPendingRequestId(conversationKey, 0);
    deps.restoreRequestUIIdle(body, conversationKey, thisRequestId);
    deps.setCurrentAbortController(conversationKey, null);
    scheduleQueueDrain?.();
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
  authMode:
    | "api_key"
    | "codex_auth"
    | "codex_app_server"
    | "copilot_auth"
    | "webchat"
    | undefined,
  providerProtocol:
    | "codex_responses"
    | "responses_api"
    | "openai_chat_compat"
    | "anthropic_messages"
    | "gemini_native"
    | "web_sync"
    | undefined,
  modelEntryId: string | undefined,
  modelProviderLabel: string | undefined,
  reasoning: LLMReasoningConfig | undefined,
  advanced: AdvancedModelParams | undefined,
  modelAttachmentsOverride: ChatAttachment[] | undefined,
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
  deps.setPendingRequestId(conversationKey, thisRequestId);
  deps.setRequestUIBusy(body, ui, conversationKey, "Preparing agent retry...");

  const assistantMessage = retryPair.assistantMessage;

  const effectiveRequestConfig = deps.resolveEffectiveRequestConfig({
    item,
    model,
    apiBase,
    apiKey,
    authMode,
    providerProtocol,
    modelEntryId,
    modelProviderLabel,
    reasoning,
    advanced,
  });

  // Clear the previous agent run so the trace and text reset immediately.
  assistantMessage.text = "";
  assistantMessage.agentRunId = undefined;
  assistantMessage.runMode = "agent";
  assistantMessage.streaming = true;
  assistantMessage.modelName = effectiveRequestConfig.model;
  assistantMessage.modelEntryId = effectiveRequestConfig.modelEntryId;
  assistantMessage.modelProviderLabel =
    effectiveRequestConfig.modelProviderLabel;
  assistantMessage.waitingAnimationStartedAt =
    assistantMessage.modelProviderLabel === "Claude Code" ||
    assistantMessage.modelProviderLabel === "Codex"
      ? Date.now()
      : undefined;
  assistantMessage.reasoningSummary = undefined;
  assistantMessage.reasoningDetails = undefined;
  assistantMessage.reasoningOpen = deps.isReasoningExpandedByDefault();
  assistantMessage.pendingAgentTraceEvents =
    assistantMessage.modelProviderLabel === "Claude Code" ||
    assistantMessage.modelProviderLabel === "Codex"
      ? buildPendingAgentTraceEvents(body)
      : undefined;

  const { refreshChatSafely, setStatusSafely } = deps.createPanelUpdateHelpers(
    body,
    item,
    conversationKey,
    ui,
  );
  const queueRefresh = deps.createQueuedRefresh(refreshChatSafely);
  const scheduleQueueDrain = () =>
    deps.scheduleQueuedInputDrain(body, {
      conversationSystem: deps.getConversationSystem(),
      conversationKey,
      webChatActive: effectiveRequestConfig.providerProtocol === "web_sync",
    });
  refreshChatSafely(); // Immediately clear the old trace from view

  const {
    question,
    screenshotImages,
    paperContexts,
    fullTextPaperContexts,
    selectedCollectionContexts,
  } = deps.reconstructRetryPayload(retryPair.userMessage);
  if (!question.trim()) {
    setStatusSafely("Nothing to retry for latest turn", "error");
    deps.restoreRequestUIIdle(body, conversationKey, thisRequestId);
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
  const selectedTextPaperContextsRaw =
    deps.normalizeSelectedTextPaperContextsByIndex(
      retryPair.userMessage.selectedTextPaperContexts,
      selectedTextsRaw.length,
    );

  const historyForLLM = deps.buildLLMHistoryMessages(
    history.slice(0, retryPair.userIndex),
  );
  if (modelAttachmentsOverride !== undefined) {
    retryPair.userMessage.modelAttachments = modelAttachmentsOverride;
  }
  retryPair.userMessage.modelName = effectiveRequestConfig.model;
  retryPair.userMessage.modelEntryId = effectiveRequestConfig.modelEntryId;
  retryPair.userMessage.modelProviderLabel =
    effectiveRequestConfig.modelProviderLabel;
  const retryModelAttachments =
    modelAttachmentsOverride ??
    retryPair.userMessage.modelAttachments ??
    retryPair.userMessage.attachments?.filter((a) => a.category !== "image");

  const runtimeRequest = await deps.buildAgentRuntimeRequest({
    conversationKey,
    item,
    userText: question,
    selectedTexts: selectedTextsRaw,
    selectedTextSources: selectedTextSourcesRaw,
    selectedTextPaperContexts: selectedTextPaperContextsRaw,
    paperContexts,
    fullTextPaperContexts,
    selectedCollectionContexts,
    attachments: retryModelAttachments,
    screenshots: screenshotImages,
    effectiveRequestConfig,
    history: historyForLLM,
  });

  let assistantPersisted = false;
  const persistAssistantOnce = async () => {
    if (assistantPersisted) return;
    assistantPersisted = true;
    const snapshot = deps.getContextUsageSnapshot?.(conversationKey);
    await deps.updateStoredLatestAssistantMessage(conversationKey, {
      text: assistantMessage.text,
      timestamp: assistantMessage.timestamp,
      runMode: "agent",
      agentRunId: assistantMessage.agentRunId,
      modelName: assistantMessage.modelName,
      modelEntryId: assistantMessage.modelEntryId,
      modelProviderLabel: assistantMessage.modelProviderLabel,
      contextTokens: snapshot?.contextTokens,
      contextWindow: snapshot?.contextWindow,
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
    const AbortControllerCtor = deps.getAbortControllerCtor();
    deps.setCurrentAbortController(
      conversationKey,
      AbortControllerCtor ? new AbortControllerCtor() : null,
    );

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
      signal: deps.currentAbortController(conversationKey)?.signal,
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
          selectedTextNoteContexts:
            retryPair.userMessage.selectedTextNoteContexts,
          screenshotImages: retryPair.userMessage.screenshotImages,
          paperContexts: retryPair.userMessage.paperContexts,
          fullTextPaperContexts: retryPair.userMessage.fullTextPaperContexts,
          citationPaperContexts: retryPair.userMessage.citationPaperContexts,
          selectedCollectionContexts:
            retryPair.userMessage.selectedCollectionContexts,
          attachments: retryPair.userMessage.attachments,
          modelAttachments: retryPair.userMessage.modelAttachments,
          modelName: retryPair.userMessage.modelName,
          modelEntryId: retryPair.userMessage.modelEntryId,
          modelProviderLabel: retryPair.userMessage.modelProviderLabel,
        });
      },
      onEvent: async (event) => {
        if (assistantMessage.agentRunId) {
          pushTraceEvent(assistantMessage.agentRunId, event);
        }
        switch (event.type) {
          case "provider_event":
            applyResolvedClaudeEffortDisplay(body, event);
            break;
          case "usage": {
            if (ui.tokenUsageEl) {
              const previous = deps.getContextUsageSnapshot?.(conversationKey);
              const usageEvent = event as Extract<
                AgentEvent,
                { type: "usage" }
              >;
              const usageRecord = usageEvent as unknown as Record<
                string,
                unknown
              >;
              const hasContextPayload = "contextTokens" in usageRecord;
              if (hasContextPayload) {
                const nextTokens = Math.max(
                  0,
                  Number(usageRecord.contextTokens) || 0,
                );
                const rawContextWindow = usageRecord.contextWindow;
                const nextWindow =
                  typeof rawContextWindow === "number" &&
                  Number.isFinite(rawContextWindow)
                    ? rawContextWindow
                    : previous?.contextWindow;
                const effectiveTokens =
                  nextTokens > 0
                    ? nextTokens
                    : usageRecord.contextWindowIsAuthoritative === true
                      ? (previous?.contextTokens ?? 0)
                      : 0;
                deps.setContextUsageSnapshot?.(conversationKey, {
                  contextTokens: effectiveTokens,
                  contextWindow: nextWindow,
                  contextWindowIsAuthoritative:
                    usageRecord.contextWindowIsAuthoritative === true,
                  cacheReadTokens:
                    typeof usageRecord.cacheReadTokens === "number"
                      ? usageRecord.cacheReadTokens
                      : undefined,
                  cacheWriteTokens:
                    typeof usageRecord.cacheWriteTokens === "number"
                      ? usageRecord.cacheWriteTokens
                      : undefined,
                  cacheMissTokens:
                    typeof usageRecord.cacheMissTokens === "number"
                      ? usageRecord.cacheMissTokens
                      : undefined,
                  cacheHitRatio:
                    typeof usageRecord.cacheHitRatio === "number"
                      ? usageRecord.cacheHitRatio
                      : undefined,
                  cacheProvider:
                    typeof usageRecord.cacheProvider === "string"
                      ? usageRecord.cacheProvider
                      : undefined,
                  estimated: usageRecord.contextWindowIsAuthoritative !== true,
                  source:
                    usageRecord.contextWindowIsAuthoritative === true
                      ? "provider"
                      : "estimated",
                });
                deps.setTokenUsage(
                  ui.tokenUsageEl,
                  effectiveTokens,
                  nextWindow,
                  body.querySelector(
                    "#llm-claude-context-gauge",
                  ) as HTMLElement | null,
                  {
                    estimated:
                      usageRecord.contextWindowIsAuthoritative !== true,
                    cacheReadTokens:
                      typeof usageRecord.cacheReadTokens === "number"
                        ? usageRecord.cacheReadTokens
                        : undefined,
                    cacheWriteTokens:
                      typeof usageRecord.cacheWriteTokens === "number"
                        ? usageRecord.cacheWriteTokens
                        : undefined,
                    cacheMissTokens:
                      typeof usageRecord.cacheMissTokens === "number"
                        ? usageRecord.cacheMissTokens
                        : undefined,
                    cacheHitRatio:
                      typeof usageRecord.cacheHitRatio === "number"
                        ? usageRecord.cacheHitRatio
                        : undefined,
                    cacheProvider:
                      typeof usageRecord.cacheProvider === "string"
                        ? usageRecord.cacheProvider
                        : undefined,
                  },
                );
              } else if (
                typeof usageRecord.totalTokens === "number" &&
                usageRecord.totalTokens > 0
              ) {
                deps.accumulateSessionTokens(
                  conversationKey,
                  usageRecord.totalTokens,
                );
              }
            }
            break;
          }
          case "tool_result": {
            if (!event.ok) break;
            const toolPaperContexts = deps.normalizePaperContexts([
              ...extractPaperContextCandidatesFromToolContent(event.content),
              ...extractPaperContextCandidatesFromToolContent(event.artifacts),
            ]);
            if (!toolPaperContexts.length) break;
            const before =
              retryPair.userMessage.citationPaperContexts?.length || 0;
            retryPair.userMessage.citationPaperContexts =
              mergeCitationPaperContexts(
                retryPair.userMessage.citationPaperContexts,
                toolPaperContexts,
              );
            if (
              (retryPair.userMessage.citationPaperContexts?.length || 0) ===
              before
            )
              break;
            await deps.updateStoredLatestUserMessage(conversationKey, {
              text: retryPair.userMessage.text,
              timestamp: retryPair.userMessage.timestamp,
              runMode: "agent",
              agentRunId: retryPair.userMessage.agentRunId,
              selectedText: retryPair.userMessage.selectedText,
              selectedTexts: retryPair.userMessage.selectedTexts,
              selectedTextSources: retryPair.userMessage.selectedTextSources,
              selectedTextPaperContexts:
                retryPair.userMessage.selectedTextPaperContexts,
              selectedTextNoteContexts:
                retryPair.userMessage.selectedTextNoteContexts,
              paperContexts: retryPair.userMessage.paperContexts,
              fullTextPaperContexts:
                retryPair.userMessage.fullTextPaperContexts,
              citationPaperContexts:
                retryPair.userMessage.citationPaperContexts,
              selectedCollectionContexts:
                retryPair.userMessage.selectedCollectionContexts,
              screenshotImages: retryPair.userMessage.screenshotImages,
              attachments: retryPair.userMessage.attachments,
              modelAttachments: retryPair.userMessage.modelAttachments,
              modelName: retryPair.userMessage.modelName,
              modelEntryId: retryPair.userMessage.modelEntryId,
              modelProviderLabel: retryPair.userMessage.modelProviderLabel,
            });
            break;
          }
          case "status": {
            const isCompactingStatus = /compacting context/i.test(event.text);
            if (
              !isCompactingStatus &&
              !assistantMessage.agentRunId &&
              assistantMessage.pendingAgentTraceEvents
            ) {
              assistantMessage.pendingAgentTraceEvents.push({
                runId: "pending",
                seq: assistantMessage.pendingAgentTraceEvents.length + 1,
                eventType: event.type,
                payload: event,
                createdAt: Date.now(),
              });
            }
            setStatusSafely(event.text, "sending");
            if (isCompactingStatus) {
              assistantMessage.pendingAgentTraceEvents = undefined;
              queueRefresh();
            }
            break;
          }
          case "reasoning": {
            if (event.summary) {
              assistantMessage.reasoningSummary = deps.appendReasoningPart(
                assistantMessage.reasoningSummary,
                event.summary,
              );
            }
            if (event.details) {
              assistantMessage.reasoningDetails = deps.appendReasoningPart(
                assistantMessage.reasoningDetails,
                event.details,
              );
            }
            queueRefresh();
            return;
          }
          case "fallback":
            if (assistantMessage.text === "Compacting context…") {
              assistantMessage.text = "";
            }
            setStatusSafely(event.reason, "sending");
            break;
          case "confirmation_required":
            showInlineConfirmationCard(body, ui, event.requestId, event.action);
            queueRefresh();
            body.ownerDocument?.defaultView?.setTimeout(() => {
              showInlineConfirmationCard(
                body,
                ui,
                event.requestId,
                event.action,
              );
            }, 90);
            setStatusSafely("Approval required", "sending");
            return;
          case "confirmation_resolved":
            closeInlineConfirmationCard(body, ui, event.requestId);
            queueRefresh();
            setStatusSafely(
              event.approved ? "Approval sent" : "Action denied",
              "sending",
            );
            return;
          case "message_delta": {
            assistantMessage.pendingFinalText = `${assistantMessage.pendingFinalText || ""}${deps.sanitizeText(event.text)}`;
            assistantMessage.text =
              assistantMessage.pendingFinalText || assistantMessage.text;
            queueRefresh();
            return;
          }
          case "message_rollback":
            if (typeof event.length === "number" && event.length > 0) {
              assistantMessage.pendingFinalText = (
                assistantMessage.pendingFinalText || ""
              ).slice(
                0,
                Math.max(
                  0,
                  (assistantMessage.pendingFinalText || "").length -
                    event.length,
                ),
              );
              if (shouldSyncVisibleRollbackText(assistantMessage)) {
                assistantMessage.text = assistantMessage.pendingFinalText || "";
                queueRefresh();
              }
            }
            return;
          case "context_compacted": {
            const compactMarker: Message = {
              role: "assistant",
              text: event.automatic
                ? "Context compacted automatically"
                : "Conversation compacted",
              timestamp: Date.now(),
              runMode: "agent",
              compactMarker: true,
              modelName: assistantMessage.modelName,
              modelEntryId: assistantMessage.modelEntryId,
              modelProviderLabel: assistantMessage.modelProviderLabel,
            };
            const insertIndex = Math.max(0, history.indexOf(assistantMessage));
            history.splice(insertIndex, 0, compactMarker);
            await deps.persistConversationMessage(conversationKey, {
              role: "assistant",
              text: compactMarker.text,
              timestamp: compactMarker.timestamp,
              runMode: "agent",
              modelName: compactMarker.modelName,
              modelEntryId: compactMarker.modelEntryId,
              modelProviderLabel: compactMarker.modelProviderLabel,
              compactMarker: true,
            });
            refreshChatSafely();
            scheduleQueueDrain?.();
            await deps.waitForUiStep();
            return;
          }
          case "final":
            assistantMessage.text =
              deps.sanitizeText(event.text) ||
              assistantMessage.pendingFinalText ||
              assistantMessage.text;
            assistantMessage.pendingFinalText = undefined;
            assistantMessage.streaming = false;
            scheduleQueueDrain?.();
            break;
          default:
            break;
        }
        refreshChatSafely();
        await deps.waitForUiStep();
      },
    });

    if (
      deps.cancelledRequestId(conversationKey) >= thisRequestId ||
      Boolean(deps.currentAbortController(conversationKey)?.signal.aborted)
    ) {
      await markCancelled();
      return;
    }

    assistantMessage.agentRunId = outcome.runId;
    assistantMessage.runMode = "agent";
    const finalOutcomeText =
      outcome.kind === "completed"
        ? outcome.text
        : assistantMessage.pendingFinalText || assistantMessage.text;
    assistantMessage.text =
      deps.sanitizeText(finalOutcomeText) ||
      assistantMessage.pendingFinalText ||
      assistantMessage.text ||
      "No response.";
    assistantMessage.pendingFinalText = undefined;
    assistantMessage.waitingAnimationStartedAt = undefined;
    assistantMessage.streaming = false;
    refreshChatSafely();
    await persistAssistantOnce();
    if (deps.getConversationSystem?.() === "claude_code") {
      const conversationKind = resolveDisplayConversationKind(item);
      const baseItem = resolveConversationBaseItem(item);
      await captureClaudeSessionInfo(
        conversationKey,
        buildClaudeScope({
          libraryID: Number(item.libraryID || baseItem?.libraryID || 0),
          kind: conversationKind === "global" ? "global" : "paper",
          paperItemID:
            conversationKind === "paper"
              ? Number(baseItem?.id || 0) || undefined
              : undefined,
          paperTitle:
            conversationKind === "paper"
              ? String(baseItem?.getField?.("title") || "").trim() || undefined
              : undefined,
        }),
      ).catch(() => null);
    }
    setStatusSafely("Ready", "ready");
  } catch (err) {
    const isCancelled =
      deps.cancelledRequestId(conversationKey) >= thisRequestId ||
      Boolean(deps.currentAbortController(conversationKey)?.signal.aborted) ||
      (err as { name?: string }).name === "AbortError";
    if (isCancelled) {
      await markCancelled();
      return;
    }
    const errMsg = (err as Error).message || "Error";
    const userFacingError =
      errMsg.includes("[ede_diagnostic]") &&
      errMsg.includes("last_content_type=none")
        ? "The model returned an empty reply. Please retry."
        : errMsg;
    assistantMessage.text = `Error: ${userFacingError}`;
    assistantMessage.streaming = false;
    refreshChatSafely();
    await persistAssistantOnce();
    setStatusSafely(`Error: ${userFacingError.slice(0, 40)}`, "error");
  } finally {
    deps.setPendingRequestId(conversationKey, 0);
    deps.restoreRequestUIIdle(body, conversationKey, thisRequestId);
    deps.setCurrentAbortController(conversationKey, null);
    scheduleQueueDrain?.();
  }
}
