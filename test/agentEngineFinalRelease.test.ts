import { assert } from "chai";

import type { AgentRuntime } from "../src/agent/runtime";
import type { AgentEngineDeps } from "../src/modules/contextPanel/agentMode/agentEngine";
import {
  retryAgentTurn,
  sendAgentTurn,
} from "../src/modules/contextPanel/agentMode/agentEngine";
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
  const pendingRequests = new Map<number, number>();
  const contextSnapshots = new Map<number, { contextTokens: number }>();
  return {
    chatHistory,
    agentRunTraceCache: new Map(),
    cancelledRequestId: () => 0,
    currentAbortController: (conversationKey) =>
      abortControllers.get(conversationKey) || null,
    getAbortControllerCtor: () => AbortController,
    nextRequestId: () => 77,
    tryBeginRequest: (conversationKey, requestId, abortController) => {
      if (pendingRequests.has(conversationKey)) return false;
      pendingRequests.set(conversationKey, requestId);
      abortControllers.set(conversationKey, abortController);
      params.pendingWrites.push([conversationKey, requestId]);
      return true;
    },
    isRequestOwner: (conversationKey, requestId) =>
      pendingRequests.get(conversationKey) === requestId,
    finishRequest: (conversationKey, requestId) => {
      if (pendingRequests.get(conversationKey) !== requestId) return false;
      pendingRequests.delete(conversationKey);
      abortControllers.delete(conversationKey);
      params.pendingWrites.push([conversationKey, 0]);
      return true;
    },
    transferRequest: (fromConversationKey, toConversationKey, requestId) => {
      if (
        pendingRequests.get(fromConversationKey) !== requestId ||
        pendingRequests.has(toConversationKey)
      ) {
        return false;
      }
      pendingRequests.delete(fromConversationKey);
      pendingRequests.set(toConversationKey, requestId);
      const controller = abortControllers.get(fromConversationKey) || null;
      abortControllers.delete(fromConversationKey);
      abortControllers.set(toConversationKey, controller);
      return true;
    },
    getPanelRequestUI: () => ({}),
    setRequestUIBusy: () => undefined,
    restoreRequestUIIdle: (_body, conversationKey, requestId) => {
      params.idleRestores.push([conversationKey, requestId]);
    },
    scheduleQueuedInputDrain: () => undefined,
    createPanelUpdateHelpers: () => ({
      refreshChatSafely: () => undefined,
      refreshAssistantMessageSafely: () => undefined,
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
      selectedTexts: requestParams.selectedTexts,
      selectedTextSources: requestParams.selectedTextSources,
      selectedTextNoteContexts: requestParams.selectedTextNoteContexts,
      selectedPaperContexts: requestParams.paperContexts,
      pdfPaperContexts: requestParams.pdfPaperContexts,
      fullTextPaperContexts: requestParams.fullTextPaperContexts,
      localDocuments: requestParams.localDocuments,
      attachments: requestParams.attachments,
      history: requestParams.history,
    }),
    resolveLocalPdfResources: async () => [],
    preflightLocalPdfCapability: async () => undefined,
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
      pdfPaperContexts: [],
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
  it("preserves exact active paper identity for retries and edited-message overrides", async function () {
    const retry = async (
      conversationKey: number,
      activePaperContextOverride?: {
        libraryID: number;
        itemId: number;
        contextItemId: number;
        title: string;
      },
    ) => {
      const userMessage = {
        role: "user" as const,
        text: "summarize",
        timestamp: 100,
        runMode: "agent" as const,
      };
      const assistantMessage: any = {
        role: "assistant" as const,
        text: "previous",
        timestamp: 200,
        runMode: "agent" as const,
      };
      const runtime = {
        getCapabilities: () => ({
          streaming: true,
          toolCalls: true,
          multimodal: false,
        }),
        runTurn: async () =>
          ({
            kind: "completed",
            runId: `run-${conversationKey}`,
            text: "Done.",
            usedFallback: false,
          }) as AgentRuntimeOutcome,
      } as unknown as AgentRuntime;
      const deps = createDeps({
        runtime,
        pendingWrites: [],
        idleRestores: [],
        statuses: [],
      });
      deps.chatHistory.set(conversationKey, [userMessage, assistantMessage]);
      deps.findLatestRetryPair = () => ({
        userIndex: 0,
        userMessage,
        assistantMessage,
      });
      deps.reconstructRetryPayload = () => ({
        question: userMessage.text,
        screenshotImages: [],
        paperContexts: [],
        pdfPaperContexts: [],
        fullTextPaperContexts: [],
        selectedCollectionContexts: [],
        selectedTagContexts: [],
      });
      deps.includeAutoLoadedPaperContext = (
        _item,
        paperContexts,
        fullTextPaperContexts,
      ) => ({
        paperContexts: paperContexts || [],
        fullTextPaperContexts: fullTextPaperContexts || [],
        activePaperContext: {
          libraryID: 1,
          itemId: 42,
          contextItemId: 100,
          title: "Default attachment",
        },
      });
      let capturedActivePaperContext: unknown;
      const buildRequest = deps.buildAgentRuntimeRequest;
      deps.buildAgentRuntimeRequest = async (params) => {
        capturedActivePaperContext = params.activePaperContext;
        return await buildRequest(params);
      };

      await retryAgentTurn(
        {} as Element,
        fakeItem(conversationKey),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        deps,
        undefined,
        undefined,
        activePaperContextOverride,
      );
      return capturedActivePaperContext;
    };

    assert.deepInclude((await retry(120)) as Record<string, unknown>, {
      libraryID: 1,
      itemId: 42,
      contextItemId: 100,
    });
    assert.deepInclude(
      (await retry(121, {
        libraryID: 1,
        itemId: 42,
        contextItemId: 101,
        title: "Edited active attachment",
      })) as Record<string, unknown>,
      { libraryID: 1, itemId: 42, contextItemId: 101 },
    );
  });

  it("admits only one rapid retry while conversation loading is deferred", async function () {
    const conversationKey = 122;
    const userMessage = {
      role: "user" as const,
      text: "retry this",
      timestamp: 100,
      runMode: "agent" as const,
    };
    const assistantMessage: any = {
      role: "assistant" as const,
      text: "previous answer",
      timestamp: 200,
      runMode: "agent" as const,
    };
    let runtimeCalls = 0;
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async () => {
        runtimeCalls += 1;
        throw new Error("stop after admission");
      },
    } as unknown as AgentRuntime;
    const pendingWrites: Array<[number, number]> = [];
    const deps = createDeps({
      runtime,
      pendingWrites,
      idleRestores: [],
      statuses: [],
    });
    deps.chatHistory.set(conversationKey, [userMessage, assistantMessage]);
    deps.findLatestRetryPair = () => ({
      userIndex: 0,
      userMessage,
      assistantMessage,
    });
    deps.reconstructRetryPayload = () => ({
      question: userMessage.text,
      screenshotImages: [],
      paperContexts: [],
      pdfPaperContexts: [],
      fullTextPaperContexts: [],
      selectedCollectionContexts: [],
      selectedTagContexts: [],
    });
    let resolveLoaded: () => void = () => undefined;
    const loaded = new Promise<void>((resolve) => {
      resolveLoaded = resolve;
    });
    deps.ensureConversationLoaded = () => loaded;
    const retry = () =>
      retryAgentTurn(
        {} as Element,
        fakeItem(conversationKey),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        deps,
      );

    const first = retry();
    const second = retry();
    resolveLoaded();
    await Promise.all([first, second]);

    assert.equal(runtimeCalls, 1);
    assert.deepEqual(pendingWrites, [
      [conversationKey, 77],
      [conversationKey, 0],
    ]);
  });

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

  it("forwards note-edit selected text contexts into the runtime request", async function () {
    const conversationKey = 3703;
    const noteContext = {
      libraryID: 1,
      noteItemKey: "NOTEKEY",
      noteItemId: 3703,
      parentItemId: 3612,
      noteKind: "item" as const,
      title: "Ajemian et al., 2013 - MD",
    };
    let capturedRequest: AgentRuntimeRequest | null = null;
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async (params: { request: AgentRuntimeRequest }) => {
        capturedRequest = params.request;
        return {
          kind: "completed",
          runId: "run-note-edit",
          text: "Done.",
          usedFallback: false,
        } as AgentRuntimeOutcome;
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    deps.normalizeSelectedTextNoteContextsByIndex = () => [noteContext];

    await sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(conversationKey),
        question: "help me rewrite this sentence",
        selectedTexts: ["Panel A illustrates the stability problem."],
        selectedTextSources: ["note-edit"],
        selectedTextNoteContexts: [noteContext],
      },
      deps,
    );

    assert.deepEqual(capturedRequest?.selectedTextSources, ["note-edit"]);
    assert.deepEqual(capturedRequest?.selectedTextNoteContexts, [noteContext]);
  });

  it("preserves raw PDF identity in every initial full-row lifecycle update", async function () {
    const conversationKey = 4701;
    const pdfContext = {
      itemId: 10,
      contextItemId: 12,
      title: "Selected raw PDF",
      contentSourceMode: "pdf" as const,
    };
    const storedUpdates: Array<Record<string, unknown>> = [];
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async (params: {
        onStart?: (runId: string) => Promise<void> | void;
        onEvent?: (event: any) => Promise<void> | void;
      }) => {
        await params.onStart?.("run-pdf-initial");
        await params.onEvent?.({
          type: "tool_result",
          callId: "paper-read",
          name: "paper_read",
          ok: true,
          content: {
            paperContext: {
              itemId: 99,
              contextItemId: 100,
              title: "Tool citation",
              contentSourceMode: "text",
            },
          },
        });
        return {
          kind: "completed",
          runId: "run-pdf-initial",
          text: "Done.",
          usedFallback: false,
        } as AgentRuntimeOutcome;
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    deps.updateStoredLatestUserMessage = async (_key, update) => {
      storedUpdates.push(update as unknown as Record<string, unknown>);
    };

    await sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(conversationKey),
        question: "Analyze the selected PDF.",
        pdfPaperContexts: [pdfContext],
        localDocuments: [
          {
            kind: "local_pdf",
            sourceKey: "zotero-pdf:10:12",
            itemId: 10,
            contextItemId: 12,
            title: "Selected raw PDF",
            name: "selected.pdf",
            mimeType: "application/pdf",
            absolutePath: "/papers/selected.pdf",
          },
        ],
      },
      deps,
    );

    assert.isAtLeast(storedUpdates.length, 3);
    for (const update of storedUpdates) {
      assert.deepEqual(update.pdfPaperContexts, [pdfContext]);
    }
  });

  it("preserves raw PDF identity in retry start and tool-result full-row updates", async function () {
    const conversationKey = 4702;
    const pdfContext = {
      itemId: 20,
      contextItemId: 22,
      title: "Retry raw PDF",
      contentSourceMode: "pdf" as const,
    };
    const userMessage = {
      role: "user" as const,
      text: "Analyze the selected PDF.",
      timestamp: 100,
      runMode: "agent" as const,
      pdfPaperContexts: [pdfContext],
    };
    const assistantMessage = {
      role: "assistant" as const,
      text: "Old answer.",
      timestamp: 200,
      runMode: "agent" as const,
    };
    const storedUpdates: Array<Record<string, unknown>> = [];
    let capturedRuntimeRequest: Record<string, unknown> | undefined;
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async (params: {
        request?: Record<string, unknown>;
        onStart?: (runId: string) => Promise<void> | void;
        onEvent?: (event: any) => Promise<void> | void;
      }) => {
        capturedRuntimeRequest = params.request;
        await params.onStart?.("run-pdf-retry");
        await params.onEvent?.({
          type: "tool_result",
          callId: "paper-read",
          name: "paper_read",
          ok: true,
          content: {
            paperContext: {
              itemId: 199,
              contextItemId: 200,
              title: "Retry tool citation",
              contentSourceMode: "text",
            },
          },
        });
        return {
          kind: "completed",
          runId: "run-pdf-retry",
          text: "New answer.",
          usedFallback: false,
        } as AgentRuntimeOutcome;
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    deps.chatHistory.set(conversationKey, [userMessage, assistantMessage]);
    deps.findLatestRetryPair = () => ({
      userIndex: 0,
      userMessage,
      assistantMessage,
    });
    deps.reconstructRetryPayload = () => ({
      question: userMessage.text,
      screenshotImages: [],
      paperContexts: [],
      pdfPaperContexts: userMessage.pdfPaperContexts || [],
      fullTextPaperContexts: [],
      selectedCollectionContexts: [],
      selectedTagContexts: [],
    });
    deps.resolveLocalPdfResources = async () => [
      {
        kind: "local_pdf",
        sourceKey: "zotero-pdf:20:22",
        itemId: 20,
        contextItemId: 22,
        title: "Retry raw PDF",
        name: "retry.pdf",
        mimeType: "application/pdf",
        absolutePath: "/papers/retry.pdf",
      },
    ];
    deps.getConversationSystem = () => "claude_code";
    deps.updateStoredLatestUserMessage = async (_key, update) => {
      storedUpdates.push(update as unknown as Record<string, unknown>);
    };

    // finalizeAgentTurnOutcome resolves the Claude scope from the global
    // Zotero profile; without this stub the completed turn would fall into
    // the failure path and this test would assert against the wrong flow.
    const zoteroBefore = (globalThis as any).Zotero;
    (globalThis as any).Zotero = {
      Profile: { dir: "/tmp/zotero-profile" },
      Prefs: { get: () => undefined },
    };
    try {
      await retryAgentTurn(
        {} as Element,
        fakeItem(conversationKey),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        deps,
      );
    } finally {
      if (zoteroBefore === undefined) delete (globalThis as any).Zotero;
      else (globalThis as any).Zotero = zoteroBefore;
    }

    assert.lengthOf(storedUpdates, 2);
    for (const update of storedUpdates) {
      assert.deepEqual(update.pdfPaperContexts, [pdfContext]);
    }
    assert.deepEqual(capturedRuntimeRequest?.paperContexts || [], []);
    assert.deepEqual(capturedRuntimeRequest?.pdfPaperContexts, [pdfContext]);
    assert.lengthOf(
      (capturedRuntimeRequest?.localDocuments as unknown[]) || [],
      1,
    );
  });

  it("keeps native-provider PDF retries on their stored model attachments", async function () {
    const conversationKey = 4703;
    const pdfContext = {
      itemId: 30,
      contextItemId: 32,
      title: "Native retry PDF",
      contentSourceMode: "pdf" as const,
    };
    const pdfAttachment = {
      id: "pdf-paper-32-1",
      name: "native-retry.pdf",
      mimeType: "application/pdf",
      sizeBytes: 128,
      category: "pdf" as const,
      storedPath: "/tmp/native-retry.pdf",
    };
    const userMessage = {
      role: "user" as const,
      text: "Analyze the selected PDF.",
      timestamp: 100,
      runMode: "agent" as const,
      pdfPaperContexts: [pdfContext],
      modelAttachments: [pdfAttachment],
    };
    const assistantMessage = {
      role: "assistant" as const,
      text: "Old answer.",
      timestamp: 200,
      runMode: "agent" as const,
    };
    let localResolutionCount = 0;
    let capturedRuntimeRequest: AgentRuntimeRequest | undefined;
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: true,
      }),
      runTurn: async (params: { request: AgentRuntimeRequest }) => {
        capturedRuntimeRequest = params.request;
        return {
          kind: "completed",
          runId: "run-native-pdf-retry",
          text: "New answer.",
          usedFallback: false,
        } as AgentRuntimeOutcome;
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    deps.chatHistory.set(conversationKey, [userMessage, assistantMessage]);
    deps.findLatestRetryPair = () => ({
      userIndex: 0,
      userMessage,
      assistantMessage,
    });
    deps.reconstructRetryPayload = () => ({
      question: userMessage.text,
      screenshotImages: [],
      paperContexts: [],
      pdfPaperContexts: userMessage.pdfPaperContexts,
      fullTextPaperContexts: [],
      selectedCollectionContexts: [],
      selectedTagContexts: [],
    });
    deps.resolveLocalPdfResources = async () => {
      localResolutionCount += 1;
      throw new Error("Native attachment retries must not resolve raw paths.");
    };

    await retryAgentTurn(
      {} as Element,
      fakeItem(conversationKey),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      deps,
    );

    assert.equal(localResolutionCount, 0);
    assert.isUndefined(capturedRuntimeRequest?.localDocuments);
    assert.deepEqual(capturedRuntimeRequest?.attachments, [pdfAttachment]);
  });

  it("preserves the previous assistant response when raw PDF retry preflight fails", async function () {
    const conversationKey = 4812;
    const pendingWrites: Array<[number, number]> = [];
    const assistantMessage = {
      role: "assistant" as const,
      text: "Previous grounded answer.",
      timestamp: 200,
      runMode: "agent" as const,
    };
    const userMessage = {
      role: "user" as const,
      text: "Analyze this PDF.",
      timestamp: 100,
      runMode: "agent" as const,
      pdfPaperContexts: [
        {
          itemId: 10,
          contextItemId: 11,
          title: "Exact PDF",
          contentSourceMode: "pdf" as const,
        },
      ],
    };
    const deps = createDeps({
      runtime: createFinalThenHangingRuntime(() => undefined),
      pendingWrites,
      idleRestores: [],
      statuses: [],
    });
    deps.chatHistory.set(conversationKey, [userMessage, assistantMessage]);
    deps.findLatestRetryPair = () => ({
      userIndex: 0,
      userMessage,
      assistantMessage,
    });
    deps.reconstructRetryPayload = () => ({
      question: userMessage.text,
      screenshotImages: [],
      paperContexts: [],
      pdfPaperContexts: userMessage.pdfPaperContexts,
      fullTextPaperContexts: [],
      selectedCollectionContexts: [],
      selectedTagContexts: [],
    });
    deps.getConversationSystem = () => "claude_code";
    deps.resolveLocalPdfResources = async () => {
      throw new Error("Selected PDF file is missing or unreadable.");
    };

    await retryAgentTurn(
      {} as Element,
      fakeItem(conversationKey),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      deps,
    );

    assert.equal(assistantMessage.text, "Previous grounded answer.");
    assert.deepEqual(pendingWrites, [
      [conversationKey, 77],
      [conversationKey, 0],
    ]);
  });

  it("preserves partial text and flags interruption when the runtime drops mid-stream", async function () {
    const conversationKey = 555;
    const statuses: string[] = [];
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async (params: {
        onEvent?: (event: any) => Promise<void> | void;
      }) => {
        await params.onEvent?.({
          type: "message_delta",
          text: "Partial answer that ",
        });
        await params.onEvent?.({
          type: "message_delta",
          text: "streamed before the drop.",
        });
        throw new Error("Error in input stream");
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses,
    });
    // Production seeds the conversation history before a turn starts.
    const history: any[] = [];
    (deps as any).chatHistory.set(conversationKey, history);

    await sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(conversationKey),
        question: "summarize the methods",
      },
      deps,
    );

    const assistantMessage = history[history.length - 1];
    assert.strictEqual(
      assistantMessage.text,
      "Partial answer that streamed before the drop.",
    );
    assert.isTrue(assistantMessage.interrupted);
    assert.isUndefined(assistantMessage.pendingFinalText);
    assert.isFalse(Boolean(assistantMessage.streaming));
    assert.include(statuses.join("\n"), "Error: Error in input stream");
  });

  it("keeps the bare error text when nothing streamed before the failure", async function () {
    const conversationKey = 556;
    const statuses: string[] = [];
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async () => {
        throw new Error("boom");
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses,
    });
    // Production seeds the conversation history before a turn starts.
    const history: any[] = [];
    (deps as any).chatHistory.set(conversationKey, history);

    await sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(conversationKey),
        question: "summarize the methods",
      },
      deps,
    );

    const assistantMessage = history[history.length - 1];
    assert.strictEqual(assistantMessage.text, "Error: boom");
    assert.isFalse(Boolean(assistantMessage.interrupted));
  });

  it("does not resurrect rolled-back text in the preserved partial", async function () {
    const conversationKey = 557;
    const retracted = "Thinking about which tool to use. ";
    // The rollback handler consults a Zotero pref (block-streaming toggle).
    const zoteroBefore = (globalThis as any).Zotero;
    (globalThis as any).Zotero = { Prefs: { get: () => true } };
    try {
      const runtime = {
        getCapabilities: () => ({
          streaming: true,
          toolCalls: true,
          multimodal: false,
        }),
        runTurn: async (params: {
          onEvent?: (event: any) => Promise<void> | void;
        }) => {
          // Round 1 streams intermediate text the runtime then retracts
          // (message_rollback), exactly like a tool-call round does.
          await params.onEvent?.({ type: "message_delta", text: retracted });
          await params.onEvent?.({
            type: "message_rollback",
            length: retracted.length,
          });
          // Round 2 streams part of the real answer, then the stream drops.
          await params.onEvent?.({
            type: "message_delta",
            text: "Real partial answer",
          });
          throw new Error("Error in input stream");
        },
      } as unknown as AgentRuntime;
      const deps = createDeps({
        runtime,
        pendingWrites: [],
        idleRestores: [],
        statuses: [],
      });
      const history: any[] = [];
      (deps as any).chatHistory.set(conversationKey, history);

      await sendAgentTurn(
        {
          body: {} as Element,
          item: fakeItem(conversationKey),
          question: "summarize the methods",
        },
        deps,
      );

      const assistantMessage = history[history.length - 1];
      assert.strictEqual(assistantMessage.text, "Real partial answer");
      assert.isTrue(assistantMessage.interrupted);
    } finally {
      if (zoteroBefore === undefined) delete (globalThis as any).Zotero;
      else (globalThis as any).Zotero = zoteroBefore;
    }
  });

  it("honors the sticky reasoning-expanded preference on a fresh agent send", async function () {
    const conversationKey = 559;
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async () =>
        ({
          kind: "completed",
          runId: "run-reasoning-open",
          text: "Done.",
          usedFallback: false,
        }) as AgentRuntimeOutcome,
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    deps.isReasoningExpandedByDefault = () => true;
    const history: any[] = [];
    deps.chatHistory.set(conversationKey, history);

    await sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(conversationKey),
        question: "summarize the methods",
      },
      deps,
    );

    const assistantMessage = history[history.length - 1];
    assert.isTrue(assistantMessage.reasoningOpen);
  });

  it("restores the previous assistant message when a retry fails before streaming", async function () {
    const conversationKey = 558;
    const userMessage = {
      role: "user" as const,
      text: "summarize",
      timestamp: 100,
      runMode: "agent" as const,
    };
    const assistantMessage: any = {
      role: "assistant" as const,
      text: "Preserved partial answer.",
      timestamp: 200,
      runMode: "agent" as const,
      interrupted: true,
    };
    const assistantStoreWrites: unknown[] = [];
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async () => {
        throw new Error("NetworkError when attempting to fetch resource.");
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    deps.chatHistory.set(conversationKey, [userMessage, assistantMessage]);
    deps.findLatestRetryPair = () => ({
      userIndex: 0,
      userMessage,
      assistantMessage,
    });
    deps.reconstructRetryPayload = () => ({
      question: userMessage.text,
      screenshotImages: [],
      paperContexts: [],
      pdfPaperContexts: [],
      fullTextPaperContexts: [],
      selectedCollectionContexts: [],
      selectedTagContexts: [],
    });
    deps.updateStoredLatestAssistantMessage = async (_key, update) => {
      assistantStoreWrites.push(update);
    };

    await retryAgentTurn(
      {} as Element,
      fakeItem(conversationKey),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      deps,
    );

    assert.strictEqual(assistantMessage.text, "Preserved partial answer.");
    assert.isTrue(assistantMessage.interrupted);
    assert.isFalse(Boolean(assistantMessage.streaming));
    // The stored row must keep the partial — no error-text write.
    assert.lengthOf(assistantStoreWrites, 0);
  });

  it("restores the paired user row when a zero-output retry fails after persisting", async function () {
    const conversationKey = 560;
    const oldPaperContexts = [{ itemId: 1, title: "Old paper" }];
    const userMessage: any = {
      role: "user" as const,
      text: "summarize",
      timestamp: 100,
      runMode: "agent" as const,
      agentRunId: "run-old",
      paperContexts: oldPaperContexts,
      modelName: "model-a",
      modelEntryId: "entry-a",
      modelProviderLabel: "Provider A",
    };
    const assistantMessage: any = {
      role: "assistant" as const,
      text: "Old answer.",
      timestamp: 200,
      runMode: "agent" as const,
      modelName: "model-a",
    };
    const userStoreWrites: Array<Record<string, unknown>> = [];
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async (params: {
        onStart?: (runId: string) => Promise<void> | void;
      }) => {
        // The run registers (persisting the user row with retry metadata)
        // and then dies without streaming anything.
        await params.onStart?.("run-new");
        throw new Error("NetworkError when attempting to fetch resource.");
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    deps.chatHistory.set(conversationKey, [userMessage, assistantMessage]);
    deps.findLatestRetryPair = () => ({
      userIndex: 0,
      userMessage,
      assistantMessage,
    });
    deps.reconstructRetryPayload = () => ({
      question: userMessage.text,
      screenshotImages: [],
      paperContexts: [{ itemId: 77, title: "Rebuilt during retry" }],
      pdfPaperContexts: [],
      fullTextPaperContexts: [],
      selectedCollectionContexts: [],
      selectedTagContexts: [],
    });
    deps.updateStoredLatestUserMessage = async (_key, update) => {
      userStoreWrites.push(update as unknown as Record<string, unknown>);
    };

    await retryAgentTurn(
      {} as Element,
      fakeItem(conversationKey),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      deps,
    );

    // In-memory user message is back to its pre-retry identity.
    assert.strictEqual(userMessage.modelName, "model-a");
    assert.strictEqual(userMessage.modelEntryId, "entry-a");
    assert.strictEqual(userMessage.modelProviderLabel, "Provider A");
    assert.strictEqual(userMessage.agentRunId, "run-old");
    assert.deepEqual(userMessage.paperContexts, oldPaperContexts);
    // The stored row was rewritten with the restored values after the
    // onStart persistence stamped the failed retry's metadata onto it.
    assert.isAtLeast(userStoreWrites.length, 2);
    const lastWrite = userStoreWrites[userStoreWrites.length - 1];
    assert.strictEqual(lastWrite.modelName, "model-a");
    assert.strictEqual(lastWrite.agentRunId, "run-old");
    assert.deepEqual(lastWrite.paperContexts, oldPaperContexts);
  });

  it("restores the turn when a retry has nothing to send", async function () {
    const conversationKey = 561;
    const userMessage: any = {
      role: "user" as const,
      text: "",
      timestamp: 100,
      runMode: "agent" as const,
      modelName: "model-a",
      paperContexts: [{ itemId: 1, title: "Old paper" }],
    };
    const assistantMessage: any = {
      role: "assistant" as const,
      text: "Old answer.",
      timestamp: 200,
      runMode: "agent" as const,
    };
    const deps = createDeps({
      runtime: createFinalThenHangingRuntime(() => undefined),
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    deps.chatHistory.set(conversationKey, [userMessage, assistantMessage]);
    deps.findLatestRetryPair = () => ({
      userIndex: 0,
      userMessage,
      assistantMessage,
    });
    deps.reconstructRetryPayload = () => ({
      question: "",
      screenshotImages: [],
      paperContexts: [],
      pdfPaperContexts: [],
      fullTextPaperContexts: [],
      selectedCollectionContexts: [],
      selectedTagContexts: [],
    });

    await retryAgentTurn(
      {} as Element,
      fakeItem(conversationKey),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      deps,
    );

    // The bail-out must not leave the turn half-reset: the previous answer
    // stays visible and the message is not stuck in streaming mode.
    assert.strictEqual(assistantMessage.text, "Old answer.");
    assert.isFalse(Boolean(assistantMessage.streaming));
    assert.strictEqual(userMessage.modelName, "model-a");
    assert.deepEqual(userMessage.paperContexts, [
      { itemId: 1, title: "Old paper" },
    ]);
  });
});
