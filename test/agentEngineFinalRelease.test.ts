import { assert } from "chai";

import type { AgentRuntime } from "../src/agent/runtime";
import type { AgentEngineDeps } from "../src/modules/contextPanel/agentMode/agentEngine";
import { sendAgentTurn } from "../src/modules/contextPanel/agentMode/agentEngine";
import type {
  AgentRuntimeOutcome,
  AgentRuntimeRequest,
} from "../src/agent/types";

function fakeItem(id: number): Zotero.Item {
  return {
    id,
    libraryID: 1,
    isAttachment: () => false,
  } as unknown as Zotero.Item;
}

function createFinalThenHangingRuntime(
  onFinalHandled: () => void,
): AgentRuntime {
  return {
    getCapabilities: () => ({
      streaming: true,
      toolCalls: true,
      multimodal: false,
    }),
    runTurn: async (params: {
      request: AgentRuntimeRequest;
      onStart?: (runId: string) => Promise<void> | void;
      onEvent?: (event: {
        type: "status" | "final";
        text: string;
      }) => Promise<void> | void;
    }): Promise<AgentRuntimeOutcome> => {
      await params.onStart?.("run-final-release");
      await params.onEvent?.({
        type: "status",
        text: "Continuing agent (2/24)",
      });
      await params.onEvent?.({
        type: "final",
        text: "Final answer.",
      });
      onFinalHandled();
      return new Promise<AgentRuntimeOutcome>(() => undefined);
    },
  } as unknown as AgentRuntime;
}

function createDeps(params: {
  runtime: AgentRuntime;
  pendingWrites: Array<[number, number]>;
  idleRestores: Array<[number, number]>;
  statuses: string[];
}): AgentEngineDeps {
  const chatHistory = new Map<number, any[]>();
  const abortControllers = new Map<number, AbortController | null>();
  const contextSnapshots = new Map<number, { contextTokens: number }>();
  return {
    chatHistory,
    agentRunTraceCache: new Map(),
    cancelledRequestId: () => 0,
    currentAbortController: (conversationKey) =>
      abortControllers.get(conversationKey) || null,
    setCurrentAbortController: (conversationKey, ctrl) => {
      abortControllers.set(conversationKey, ctrl);
    },
    getAbortControllerCtor: () => AbortController,
    nextRequestId: () => 77,
    setPendingRequestId: (conversationKey, id) => {
      params.pendingWrites.push([conversationKey, id]);
    },
    getPanelRequestUI: () => ({}),
    setRequestUIBusy: () => undefined,
    restoreRequestUIIdle: (_body, conversationKey, requestId) => {
      params.idleRestores.push([conversationKey, requestId]);
    },
    scheduleQueuedInputDrain: () => undefined,
    createPanelUpdateHelpers: () => ({
      refreshChatSafely: () => undefined,
      setStatusSafely: (text) => {
        params.statuses.push(text);
      },
    }),
    ensureConversationLoaded: async () => undefined,
    getConversationSystem: () => "upstream",
    accumulateSessionTokens: () => 0,
    getContextUsageSnapshot: (conversationKey) =>
      contextSnapshots.get(conversationKey),
    setContextUsageSnapshot: (conversationKey, snapshot) => {
      contextSnapshots.set(conversationKey, snapshot);
    },
    setTokenUsage: () => undefined,
    getConversationKey: (item) => Number(item.id || 0),
    buildLLMHistoryMessages: () => [],
    buildAgentRuntimeRequest: (requestParams) => ({
      conversationKey: requestParams.conversationKey,
      mode: "agent",
      userText: requestParams.userText,
      model: requestParams.effectiveRequestConfig.model,
      apiBase: requestParams.effectiveRequestConfig.apiBase,
      apiKey: requestParams.effectiveRequestConfig.apiKey,
      authMode: requestParams.effectiveRequestConfig.authMode,
      providerProtocol: requestParams.effectiveRequestConfig.providerProtocol,
      history: requestParams.history,
    }),
    resolveEffectiveRequestConfig: () => ({
      model: "deepseek-v4-pro",
      apiBase: "https://example.invalid/v1",
      apiKey: "test",
      authMode: "api_key",
      providerProtocol: "openai_chat_compat",
      modelEntryId: "deepseek-v4-pro",
      modelProviderLabel: "DeepSeek",
    }),
    normalizeSelectedTexts: (selectedTexts) =>
      Array.isArray(selectedTexts) ? selectedTexts : [],
    normalizeSelectedTextSources: (sources) => sources || [],
    normalizeSelectedTextPaperContextsByIndex: () => [],
    normalizeSelectedTextNoteContextsByIndex: () => [],
    normalizePaperContexts: (paperContexts) =>
      Array.isArray(paperContexts) ? paperContexts : [],
    includeAutoLoadedPaperContext: (
      _item,
      paperContexts,
      fullTextPaperContexts,
    ) => ({
      paperContexts: paperContexts || [],
      fullTextPaperContexts: fullTextPaperContexts || [],
    }),
    findLatestRetryPair: () => null,
    reconstructRetryPayload: () => ({
      question: "",
      screenshotImages: [],
      paperContexts: [],
      fullTextPaperContexts: [],
      selectedCollectionContexts: [],
      selectedTagContexts: [],
    }),
    isReasoningExpandedByDefault: () => false,
    createQueuedRefresh: (refresh) => refresh,
    waitForUiStep: async () => undefined,
    finalizeCancelledAssistantMessage: (message, fallbackText) => {
      message.text = fallbackText || "[Cancelled]";
    },
    sanitizeText: (text) => text,
    finalizeAssistantQuoteCitations: async () => undefined,
    appendReasoningPart: (base, next) => `${base || ""}${next || ""}`,
    persistConversationMessage: async () => undefined,
    updateStoredLatestUserMessage: async () => undefined,
    updateStoredLatestAssistantMessage: async () => undefined,
    sendChatFallback: async () => undefined,
    getAgentRuntime: () => params.runtime,
    maxSelectedImages: 4,
  } as AgentEngineDeps;
}

describe("agent engine final UI release", function () {
  it("releases the request UI when a final event arrives before runtime bookkeeping settles", async function () {
    const conversationKey = 123;
    const pendingWrites: Array<[number, number]> = [];
    const idleRestores: Array<[number, number]> = [];
    const statuses: string[] = [];
    let resolveFinalHandled: () => void = () => undefined;
    const finalHandled = new Promise<void>((resolve) => {
      resolveFinalHandled = resolve;
    });
    const runtime = createFinalThenHangingRuntime(resolveFinalHandled);
    const deps = createDeps({
      runtime,
      pendingWrites,
      idleRestores,
      statuses,
    });

    void sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(conversationKey),
        question: "write a review",
      },
      deps,
    );

    await finalHandled;

    assert.deepInclude(pendingWrites, [conversationKey, 0]);
    assert.deepInclude(idleRestores, [conversationKey, 77]);
    assert.include(statuses, "Ready");
  });
});
