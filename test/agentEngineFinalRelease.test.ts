import { assert } from "chai";

import type { AgentRuntime } from "../src/agent/runtime";
import { AgentRuntime as RealAgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type { AgentStepParams } from "../src/agent/model/adapter";
import { clearAgentReadLedger } from "../src/agent/context/resourceContextPlan";
import { clearAgentCoverageLedger } from "../src/agent/context/coverageLedger";
import { clearAgentTranscriptStore } from "../src/agent/store/transcriptStore";
import { clearAgentToolResultHandleStore } from "../src/agent/store/toolResultHandles";
import {
  installMockDb,
  type InstalledMockDb,
} from "./helpers/agentRuntimeMockDb";
import type { AgentEngineDeps } from "../src/modules/contextPanel/agentMode/agentEngine";
import {
  applyFinalQuoteCitations,
  retryAgentTurn,
  sendAgentTurn,
} from "../src/modules/contextPanel/agentMode/agentEngine";
import type {
  AgentEvent,
  AgentModelStep,
  AgentRuntimeOutcome,
  AgentRuntimeRequest,
} from "../src/agent/types";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";
import { executionCheckpointEvent } from "../src/agent/execution/checkpointEvents";
import {
  clearAllTaskProgress,
  displayedTaskRunState,
  getTaskProgress,
} from "../src/modules/contextPanel/taskProgress/store";
import {
  ledgerDelta,
  outcomeCheckpoint,
  outcomeTask,
} from "./helpers/taskProgressFixtures";

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
      for (const text of [
        "Continuing agent (2/24)",
        "Checkpointed agent segment 1; continuing",
        "Continuing agent (segment 2, 6/32)",
        "Continuing agent (round 7)",
        "Continuing agent (page 2 · 7 of 30)",
      ]) {
        await params.onEvent?.({ type: "status", text });
      }
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
      // Mirrors chat.ts: a cancelled turn is not an interrupted one, so the
      // flag the interrupted path sets is cleared here.
      message.text = message.text || fallbackText || "[Cancelled]";
      message.streaming = false;
      message.interrupted = undefined;
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

  it("keeps the request owned until final outcome persistence settles", async function () {
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

    assert.notDeepInclude(pendingWrites, [conversationKey, 0]);
    assert.isEmpty(idleRestores);
    assert.notInclude(statuses, "Ready");
    assert.include(statuses, "Working");
    assert.isFalse(
      statuses.some((text) =>
        /Continuing agent \((?!page)|Checkpointed agent/.test(text),
      ),
      "round and segment bookkeeping reads as Working",
    );
    // A long job's page progress is the status itself.
    assert.include(statuses, "Continuing agent (page 2 · 7 of 30)");
  });

  it("preserves and persists the final answer when completion fails after the final event", async function () {
    const statuses: string[] = [];
    const stored: any[] = [];
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async (params: any) => {
        await params.onStart?.("run-delivery-failure");
        await params.onEvent?.({
          type: "final",
          text: "The complete final answer.",
        });
        throw new Error("Final delivery failed");
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses,
    });
    deps.persistConversationMessage = async (_key, message) => {
      stored.push({ ...message });
    };
    deps.chatHistory.set(123, []);
    await sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(123),
        question: "Summarize and save.",
      },
      deps,
    );
    const assistant = stored.find((message) => message.role === "assistant");
    assert.equal(assistant?.text, "The complete final answer.");
    assert.isTrue(
      statuses.some((text) => text.includes("Final delivery failed")),
    );
    assert.isFalse(deps.chatHistory.get(123)?.at(-1)?.streaming);
  });

  for (const failFinalRefresh of [false, true]) {
    it(`waits for chat persistence before releasing Send${failFinalRefresh ? " and preserves the saved answer if the final refresh fails" : ""}`, async function () {
      const statuses: string[] = [];
      const idleRestores: Array<[number, number]> = [];
      let startPersist!: () => void;
      const persistenceStarted = new Promise<void>((resolve) => {
        startPersist = resolve;
      });
      let finishPersist!: () => void;
      const persistence = new Promise<void>((resolve) => {
        finishPersist = resolve;
      });
      const stored: any[] = [];
      const runtime = {
        getCapabilities: () => ({
          streaming: true,
          toolCalls: true,
          multimodal: false,
        }),
        runTurn: async (params: any) => {
          await params.onStart?.("run-persistence-gate");
          await params.onEvent?.({
            type: "final",
            text: "The saved final answer.",
          });
          return {
            kind: "completed",
            runId: "run-persistence-gate",
            text: "The saved final answer.",
            usedFallback: false,
          };
        },
      } as unknown as AgentRuntime;
      const deps = createDeps({
        runtime,
        pendingWrites: [],
        idleRestores,
        statuses,
      });
      deps.chatHistory.set(123, []);
      deps.persistConversationMessage = async (_key, message) => {
        if (message.role === "assistant") {
          startPersist();
          await persistence;
          stored.push({ ...message });
        }
      };
      const createHelpers = deps.createPanelUpdateHelpers;
      let refreshFailed = false;
      deps.createPanelUpdateHelpers = (...args) => ({
        ...createHelpers(...args),
        refreshChatSafely: () => {
          if (failFinalRefresh && stored.length && !refreshFailed) {
            refreshFailed = true;
            throw new Error("Final chat refresh failed");
          }
        },
      });
      const sent = sendAgentTurn(
        {
          body: {} as Element,
          item: fakeItem(123),
          question: "Summarize and save.",
        },
        deps,
      );
      await persistenceStarted;
      assert.isEmpty(idleRestores);
      assert.notInclude(statuses, "Ready");
      finishPersist();
      await sent;
      assert.lengthOf(stored, 1);
      assert.equal(stored[0].text, "The saved final answer.");
      assert.equal(deps.chatHistory.get(123)?.at(-1)?.text, stored[0].text);
      assert.isFalse(deps.chatHistory.get(123)?.at(-1)?.streaming);
      assert.lengthOf(idleRestores, 1);
      assert.equal(refreshFailed, failFinalRefresh);
      assert.include(
        statuses,
        failFinalRefresh ? "Error: Final chat refresh failed" : "Ready",
      );
    });
  }

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

  it("publishes answer chunks during generation, separately from reasoning, before final completion", async function () {
    const conversationKey = 554;
    const history: any[] = [];
    let beforeFinal:
      | { text: string; streaming: boolean; documentId: unknown }
      | undefined;
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
          type: "reasoning",
          round: 1,
          details: "Reasoning stays separate.",
        });
        await params.onEvent?.({
          type: "message_delta",
          text: "The methods use three complementary analyses. ",
        });
        await new Promise((resolve) => setTimeout(resolve, 550));
        const message = history[history.length - 1];
        beforeFinal = {
          text: message.text,
          streaming: message.streaming,
          documentId: message.documentId,
        };
        await params.onEvent?.({
          type: "message_delta",
          text: "The second part follows.",
        });
        await params.onEvent?.({
          type: "final",
          text: "The methods use three complementary analyses. The second part follows.",
        });
        return {
          kind: "completed",
          runId: "stream-before-final",
          text: "The methods use three complementary analyses. The second part follows.",
          usedFallback: false,
        };
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    deps.chatHistory.set(conversationKey, history);
    await sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(conversationKey),
        question: "Explain this paper's methods.",
      },
      deps,
    );
    assert.deepEqual(beforeFinal, {
      text: "The methods use three complementary analyses. ",
      streaming: true,
      documentId: undefined,
    });
    assert.notInclude(
      history[history.length - 1].text,
      "Reasoning stays separate.",
    );
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

  it("persists only the quote anchors the final answer used", async function () {
    const conversationKey = 601;
    const usedAnchor = buildQuoteCitation({
      quoteText:
        "Elastic weight consolidation slows learning on important weights.",
      citationLabel: "(Kirkpatrick et al., 2017)",
      contextItemId: 22,
      itemId: 11,
    });
    const unusedAnchor = buildQuoteCitation({
      quoteText: "The network was trained for two hundred epochs on each task.",
      citationLabel: "(Kirkpatrick et al., 2017)",
      contextItemId: 22,
      itemId: 11,
    });
    assert.isDefined(usedAnchor);
    assert.isDefined(unusedAnchor);
    const finalText = `The method protects prior tasks [[quote:${usedAnchor!.id}]].`;
    const stored: any[] = [];
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async (params: any) => {
        await params.onStart?.("run-quote-binding");
        await params.onEvent?.({
          type: "tool_result",
          ok: true,
          toolCallId: "call-1",
          name: "paper_read",
          content: {
            mode: "targeted",
            quoteCitations: [usedAnchor, unusedAnchor],
          },
        });
        await params.onEvent?.({ type: "final", text: finalText });
        return {
          kind: "completed",
          runId: "run-quote-binding",
          text: finalText,
          usedFallback: false,
        };
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    deps.chatHistory.set(conversationKey, []);
    deps.persistConversationMessage = async (_key, message) => {
      stored.push({ ...message });
    };

    await sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(conversationKey),
        question: "Why does the method avoid forgetting?",
      },
      deps,
    );

    const assistant = stored.find((message) => message.role === "assistant");
    assert.deepEqual(
      (assistant?.quoteCitations || []).map(
        (citation: { id: string }) => citation.id,
      ),
      [usedAnchor!.id],
    );
    assert.deepEqual(
      (deps.chatHistory.get(conversationKey)?.at(-1)?.quoteCitations || []).map(
        (citation: { id: string }) => citation.id,
      ),
      [usedAnchor!.id],
    );
  });

  it("keeps every anchor an interrupted answer had gathered", async function () {
    const conversationKey = 602;
    const firstAnchor = buildQuoteCitation({
      quoteText:
        "Elastic weight consolidation slows learning on important weights.",
      citationLabel: "(Kirkpatrick et al., 2017)",
      contextItemId: 22,
      itemId: 11,
    });
    const secondAnchor = buildQuoteCitation({
      quoteText: "The network was trained for two hundred epochs on each task.",
      citationLabel: "(Kirkpatrick et al., 2017)",
      contextItemId: 22,
      itemId: 11,
    });
    assert.isDefined(firstAnchor);
    assert.isDefined(secondAnchor);
    const stored: any[] = [];
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async (params: any) => {
        await params.onStart?.("run-quote-interrupt");
        await params.onEvent?.({
          type: "tool_result",
          ok: true,
          toolCallId: "call-1",
          name: "paper_read",
          content: {
            mode: "targeted",
            quoteCitations: [firstAnchor, secondAnchor],
          },
        });
        await params.onEvent?.({
          type: "message_delta",
          text: "The method protects prior tasks by",
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
    deps.chatHistory.set(conversationKey, []);
    deps.persistConversationMessage = async (_key, message) => {
      stored.push({ ...message });
    };

    await sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(conversationKey),
        question: "Why does the method avoid forgetting?",
      },
      deps,
    );

    const assistant = stored.find((message) => message.role === "assistant");
    assert.isTrue(assistant?.interrupted);
    assert.deepEqual(
      (assistant?.quoteCitations || []).map(
        (citation: { id: string }) => citation.id,
      ),
      [firstAnchor!.id, secondAnchor!.id],
    );
  });
  it("keeps every anchor a cancelled answer had gathered", async function () {
    const conversationKey = 603;
    const firstAnchor = buildQuoteCitation({
      quoteText:
        "Elastic weight consolidation slows learning on important weights.",
      citationLabel: "(Kirkpatrick et al., 2017)",
      contextItemId: 22,
      itemId: 11,
    });
    const secondAnchor = buildQuoteCitation({
      quoteText: "The network was trained for two hundred epochs on each task.",
      citationLabel: "(Kirkpatrick et al., 2017)",
      contextItemId: 22,
      itemId: 11,
    });
    assert.isDefined(firstAnchor);
    assert.isDefined(secondAnchor);
    const stored: any[] = [];
    let cancelled = false;
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async (params: any) => {
        await params.onStart?.("run-quote-cancel");
        await params.onEvent?.({
          type: "tool_result",
          ok: true,
          toolCallId: "call-1",
          name: "paper_read",
          content: {
            mode: "targeted",
            quoteCitations: [firstAnchor, secondAnchor],
          },
        });
        await params.onEvent?.({
          type: "message_delta",
          text: "The method protects prior tasks by",
        });
        // The user pressed stop while the answer was still streaming.
        cancelled = true;
        return {
          kind: "completed",
          runId: "run-quote-cancel",
          text: "The method protects prior tasks by",
          usedFallback: false,
        };
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    deps.cancelledRequestId = () => (cancelled ? 77 : 0);
    deps.chatHistory.set(conversationKey, []);
    deps.persistConversationMessage = async (_key, message) => {
      stored.push({ ...message });
    };

    await sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(conversationKey),
        question: "Why does the method avoid forgetting?",
      },
      deps,
    );

    const assistant = stored.find((message) => message.role === "assistant");
    assert.isDefined(assistant, "the cancelled turn is persisted");
    assert.isNotTrue(assistant?.interrupted);
    assert.deepEqual(
      (assistant?.quoteCitations || []).map(
        (citation: { id: string }) => citation.id,
      ),
      [firstAnchor!.id, secondAnchor!.id],
    );
  });

  it("replaces a tool anchor by id with the run's claim-anchored one", function () {
    const selectedText = buildQuoteCitation({
      quoteText: "The reader highlighted this passage in the PDF.",
      citationLabel: "(Orion et al., 2025)",
      contextItemId: 22,
      itemId: 11,
      sourceMatchKind: "selected-text",
      sourceMatchSource: "pdf-page-text",
    });
    const toolAnchor = buildQuoteCitation({
      id: "Q_decoder",
      quoteText: "Median animal accuracy was 84% on day 1 and 85% on day 10.",
      citationLabel: "(Orion et al., 2025)",
      contextItemId: 22,
      itemId: 11,
    });
    const claimAnchor = buildQuoteCitation({
      id: "Q_decoder",
      quoteText:
        "The fixed day-1 decoder declined from 80% to 62% accuracy by day 10.",
      citationLabel: "(Orion et al., 2025)",
      contextItemId: 22,
      itemId: 11,
      anchorMatch: "claim",
    });
    assert.isDefined(selectedText);
    assert.isDefined(toolAnchor);
    assert.isDefined(claimAnchor);
    const message = { quoteCitations: [selectedText!, toolAnchor!] };

    applyFinalQuoteCitations(message, [claimAnchor!]);

    assert.deepEqual(message.quoteCitations, [selectedText!, claimAnchor!]);
  });

  it("persists the claim-anchored quote the final event published", async function () {
    const conversationKey = 604;
    const toolAnchor = buildQuoteCitation({
      id: "Q_decoder",
      quoteText: "Median animal accuracy was 84% on day 1 and 85% on day 10.",
      citationLabel: "(Orion et al., 2025)",
      contextItemId: 22,
      itemId: 11,
    });
    const claimAnchor = buildQuoteCitation({
      id: "Q_decoder",
      quoteText:
        "The fixed day-1 decoder declined from 80% to 62% accuracy by day 10.",
      citationLabel: "(Orion et al., 2025)",
      contextItemId: 22,
      itemId: 11,
      anchorMatch: "claim",
    });
    assert.isDefined(toolAnchor);
    assert.isDefined(claimAnchor);
    const finalText = `The decoder lost accuracy by day 10 [[quote:${claimAnchor!.id}]].`;
    const stored: any[] = [];
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async (params: any) => {
        await params.onStart?.("run-claim-anchor");
        await params.onEvent?.({
          type: "tool_result",
          ok: true,
          toolCallId: "call-1",
          name: "paper_read",
          content: { mode: "targeted", quoteCitations: [toolAnchor] },
        });
        await params.onEvent?.({
          type: "final",
          text: finalText,
          quoteCitations: [claimAnchor],
        });
        return {
          kind: "completed",
          runId: "run-claim-anchor",
          text: finalText,
          quoteCitations: [claimAnchor],
          usedFallback: false,
        };
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    deps.chatHistory.set(conversationKey, []);
    deps.persistConversationMessage = async (_key, message) => {
      stored.push({ ...message });
    };

    await sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(conversationKey),
        question: "How much accuracy did the fixed decoder lose?",
      },
      deps,
    );

    const assistant = stored.find((message) => message.role === "assistant");
    assert.deepEqual(assistant?.quoteCitations, [claimAnchor!]);
  });

  describe("Task progress wiring", function () {
    afterEach(function () {
      clearAllTaskProgress();
    });

    function runtimeWith(
      body: (params: any) => Promise<AgentRuntimeOutcome>,
    ): AgentRuntime {
      return {
        getCapabilities: () => ({
          streaming: true,
          toolCalls: true,
          multimodal: false,
        }),
        runTurn: body,
      } as unknown as AgentRuntime;
    }

    it("starts the run at onStart, records reads, answers, and completes with citations", async function () {
      const conversationKey = 701;
      const anchor = buildQuoteCitation({
        quoteText: "Drift scales with experience rather than elapsed time.",
        citationLabel: "(Geva, 2023)",
        itemId: 3,
        contextItemId: 30,
      })!;
      const seen: Array<{ state?: string; runId?: string; turn?: number }> = [];
      const snap = () => {
        const record = getTaskProgress(conversationKey);
        seen.push({
          state: record?.runState,
          runId: record?.runId,
          turn: record?.turnIndex,
        });
      };
      const finalText = `Drift tracks experience [[quote:${anchor.id}]].`;
      const deps = createDeps({
        runtime: runtimeWith(async (params) => {
          await params.onStart?.("run-tp");
          snap();
          await params.onEvent?.({
            type: "paper_ledger_update",
            callId: "c1",
            delta: ledgerDelta("c1", [[3, "read", "Drift scales."]], "run-tp"),
          });
          await params.onEvent?.({ type: "message_delta", text: "Drift " });
          snap();
          await params.onEvent?.({
            type: "final",
            text: finalText,
            quoteCitations: [anchor],
          });
          return {
            kind: "completed",
            runId: "run-tp",
            text: finalText,
            usedFallback: false,
          };
        }),
        pendingWrites: [],
        idleRestores: [],
        statuses: [],
      });
      deps.chatHistory.set(conversationKey, [
        { role: "user", text: "Earlier", timestamp: 1 },
        { role: "assistant", text: "Earlier answer", timestamp: 2 },
      ]);

      await sendAgentTurn(
        {
          body: {} as Element,
          item: fakeItem(conversationKey),
          question: "What drives drift?",
        },
        deps,
      );

      assert.deepEqual(seen, [
        { state: "working", runId: "run-tp", turn: 2 },
        { state: "answering", runId: "run-tp", turn: 2 },
      ]);
      const record = getTaskProgress(conversationKey)!;
      assert.equal(record.runState, "completed");
      assert.equal(record.ledger.papers["1:3"].turns[2].state, "cited");
      assert.lengthOf(record.ledger.papers["1:3"].turns[2].citations, 1);
    });

    it("marks the run failed when the runtime throws after onStart", async function () {
      const conversationKey = 702;
      const deps = createDeps({
        runtime: runtimeWith(async (params) => {
          await params.onStart?.("run-fail");
          await params.onEvent?.({
            type: "paper_ledger_update",
            callId: "c1",
            delta: ledgerDelta("c1", [[5, "read"]], "run-fail"),
          });
          throw new Error("provider down");
        }),
        pendingWrites: [],
        idleRestores: [],
        statuses: [],
      });
      deps.chatHistory.set(conversationKey, []);
      await sendAgentTurn(
        {
          body: {} as Element,
          item: fakeItem(conversationKey),
          question: "q",
        },
        deps,
      );
      const record = getTaskProgress(conversationKey)!;
      assert.equal(record.runState, "failed");
      assert.equal(
        record.ledger.papers["1:5"].state,
        "read",
        "the partial ledger stays",
      );
    });

    it("ends the run interrupted when its answer broke off mid-stream, as a reopen shows it", async function () {
      const conversationKey = 707;
      const deps = createDeps({
        runtime: runtimeWith(async (params) => {
          await params.onStart?.("run-drop");
          await params.onEvent?.({
            type: "message_delta",
            text: "Drift tracks experience",
          });
          throw new Error("Error in input stream");
        }),
        pendingWrites: [],
        idleRestores: [],
        statuses: [],
      });
      const history: any[] = [];
      deps.chatHistory.set(conversationKey, history);
      await sendAgentTurn(
        {
          body: {} as Element,
          item: fakeItem(conversationKey),
          question: "What drives drift?",
        },
        deps,
      );
      assert.isTrue(history[history.length - 1].interrupted);
      assert.equal(getTaskProgress(conversationKey)!.runState, "interrupted");
    });

    it("marks the run cancelled when the user stopped it", async function () {
      const conversationKey = 703;
      let cancelled = false;
      const deps = createDeps({
        runtime: runtimeWith(async (params) => {
          await params.onStart?.("run-cancel");
          await params.onEvent?.({ type: "message_delta", text: "Partial" });
          cancelled = true;
          return {
            kind: "completed",
            runId: "run-cancel",
            text: "Partial",
            usedFallback: false,
          };
        }),
        pendingWrites: [],
        idleRestores: [],
        statuses: [],
      });
      deps.cancelledRequestId = () => (cancelled ? 77 : 0);
      deps.chatHistory.set(conversationKey, []);
      await sendAgentTurn(
        {
          body: {} as Element,
          item: fakeItem(conversationKey),
          question: "q",
        },
        deps,
      );
      assert.equal(getTaskProgress(conversationKey)!.runState, "cancelled");
    });

    it("numbers a retried run by the question it retries", async function () {
      const conversationKey = 704;
      const userMessage = {
        role: "user" as const,
        text: "second question",
        timestamp: 3,
        runMode: "agent" as const,
      };
      const assistantMessage: any = {
        role: "assistant" as const,
        text: "previous",
        timestamp: 4,
        runMode: "agent" as const,
      };
      let turnAtStart = 0;
      const deps = createDeps({
        runtime: runtimeWith(async (params) => {
          await params.onStart?.("run-retry");
          turnAtStart = getTaskProgress(conversationKey)!.turnIndex;
          throw new Error("stop");
        }),
        pendingWrites: [],
        idleRestores: [],
        statuses: [],
      });
      deps.chatHistory.set(conversationKey, [
        { role: "user", text: "first", timestamp: 1 },
        { role: "assistant", text: "one", timestamp: 2 },
        userMessage,
        assistantMessage,
      ]);
      deps.findLatestRetryPair = () => ({
        userIndex: 2,
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
      assert.equal(turnAtStart, 2);
      assert.equal(getTaskProgress(conversationKey)!.runState, "failed");
    });

    it("shows the run's outcomes as they move and keeps how its ledger ended after the answer", async function () {
      const conversationKey = 705;
      const seen: Array<{ state: string; steps: string[] }> = [];
      const snap = () => {
        const record = getTaskProgress(conversationKey);
        seen.push({
          state: displayedTaskRunState(record),
          steps: (record?.checklist?.steps || []).map(
            (step) => `${step.label}:${step.status}`,
          ),
        });
      };
      const save = outcomeTask("save", {
        description: "Save the summary as a note",
      });
      const tags = outcomeTask("host:1", {
        description: "Added tags",
        origin: "host",
        status: "completed",
        targets: ["item:3", "item:4"],
        doneTargets: ["item:3"],
        exceptions: [{ targets: ["item:4"], reason: "Not applied" }],
      });
      const deps = createDeps({
        runtime: runtimeWith(async (params) => {
          await params.onStart?.("run-outcomes");
          const first = outcomeCheckpoint([save]);
          await params.onEvent?.(executionCheckpointEvent(undefined, first));
          snap();
          // The runtime publishes each later change as a delta.
          const delta = executionCheckpointEvent(
            first,
            outcomeCheckpoint(
              [{ ...save, status: "completed" }, tags],
              "completed_with_exceptions",
              3,
            ),
          );
          assert.equal(delta.type, "execution_checkpoint_delta");
          await params.onEvent?.(delta);
          snap();
          await params.onEvent?.({ type: "final", text: "Saved." });
          return {
            kind: "completed",
            runId: "run-outcomes",
            text: "Saved.",
            usedFallback: false,
          };
        }),
        pendingWrites: [],
        idleRestores: [],
        statuses: [],
      });
      deps.chatHistory.set(conversationKey, []);
      await sendAgentTurn(
        {
          body: {} as Element,
          item: fakeItem(conversationKey),
          question: "Save a summary and tag both papers",
        },
        deps,
      );
      assert.deepEqual(seen, [
        { state: "working", steps: ["Save the summary as a note:pending"] },
        {
          state: "completed_with_exceptions",
          steps: [
            "Save the summary as a note:completed",
            "Added tags:completed",
          ],
        },
      ]);
      const record = getTaskProgress(conversationKey)!;
      assert.equal(record.runState, "completed");
      assert.equal(displayedTaskRunState(record), "completed_with_exceptions");
      assert.isTrue(record.planSeen);
    });

    it("cites a submitted document's sources live and skips a document that cites none", async function () {
      const conversationKey = 708;
      const citations: unknown[] = [];
      const finalized = (
        documentId: string,
        citedSources: Array<Record<string, unknown>>,
      ) =>
        ({
          type: "material_finalized",
          materialRef: { documentId, documentVersion: 1, contentHash: "h" },
          materialKind: "document",
          citedSources,
        }) as AgentEvent;
      const deps = createDeps({
        runtime: runtimeWith(async (params) => {
          await params.onStart?.("run-doc");
          await params.onEvent?.({
            type: "paper_ledger_update",
            callId: "c1",
            delta: ledgerDelta("c1", [[3, "read", "Methods."]], "run-doc"),
          });
          await params.onEvent?.(finalized("empty", []));
          citations.push(
            getTaskProgress(conversationKey)!.ledger.papers["1:3"].turns[1]
              .citations.length,
          );
          await params.onEvent?.(
            finalized("review", [
              {
                citationId: "c1",
                libraryID: 1,
                itemKey: "PAPER003",
                itemId: 3,
                sectionLabel: "Discussion",
              },
            ]),
          );
          citations.push(
            ...getTaskProgress(conversationKey)!.ledger.papers["1:3"].turns[1]
              .citations,
          );
          await params.onEvent?.({ type: "final", text: "Reviewed." });
          return {
            kind: "completed",
            runId: "run-doc",
            text: "Reviewed.",
            usedFallback: false,
          };
        }),
        pendingWrites: [],
        idleRestores: [],
        statuses: [],
      });
      deps.chatHistory.set(conversationKey, []);
      await sendAgentTurn(
        {
          body: {} as Element,
          item: fakeItem(conversationKey),
          question: "Review the methods",
        },
        deps,
      );
      assert.deepEqual(citations, [
        0,
        {
          citationId: "c1",
          turnIndex: 1,
          source: "document",
          sectionLabel: "Discussion",
        },
      ]);
      const record = getTaskProgress(conversationKey)!;
      assert.equal(record.ledger.papers["1:3"].state, "cited");
      assert.equal(record.runState, "completed");
    });

    it("waits on the user while a decision card is open, then works on", async function () {
      const conversationKey = 706;
      const states: string[] = [];
      const deps = createDeps({
        runtime: runtimeWith(async (params) => {
          await params.onStart?.("run-wait");
          await params.onEvent?.({
            type: "confirmation_required",
            requestId: "req-1",
            action: {
              toolName: "edit_current_note",
              title: "Save the note?",
              confirmLabel: "Save",
              cancelLabel: "Cancel",
              fields: [],
            },
          });
          states.push(getTaskProgress(conversationKey)!.runState);
          await params.onEvent?.({
            type: "confirmation_resolved",
            requestId: "req-1",
            approved: true,
          });
          states.push(getTaskProgress(conversationKey)!.runState);
          await params.onEvent?.({ type: "final", text: "Saved." });
          return {
            kind: "completed",
            runId: "run-wait",
            text: "Saved.",
            usedFallback: false,
          };
        }),
        pendingWrites: [],
        idleRestores: [],
        statuses: [],
      });
      deps.chatHistory.set(conversationKey, []);
      await sendAgentTurn(
        {
          body: {} as Element,
          item: fakeItem(conversationKey),
          question: "Save a note",
        },
        deps,
      );
      assert.deepEqual(states, ["waiting", "working"]);
      assert.equal(getTaskProgress(conversationKey)!.runState, "completed");
    });
  });
});

describe("agent engine reasoning repaints at run end", function () {
  const scenarios: Array<{
    name: string;
    end: "throw" | "complete" | "cancel";
  }> = [
    { name: "a runtime error", end: "throw" },
    { name: "a run that completes without a final event", end: "complete" },
    { name: "a cancelled run", end: "cancel" },
  ];
  for (const scenario of scenarios) {
    it(`never repaints waiting thinking after ${scenario.name} has ended the turn`, async function () {
      const conversationKey = 9100 + scenarios.indexOf(scenario);
      let cancelled = 0;
      const runtime = {
        getCapabilities: () => ({
          streaming: true,
          toolCalls: true,
          multimodal: false,
        }),
        runTurn: async (params: any) => {
          await params.onStart?.(`run-reasoning-${scenario.end}`);
          // A few short deltas: far below the size flush, so only the
          // coalescer's timer would ever paint them.
          for (const summary of ["Weighing ", "the ", "evidence"])
            await params.onEvent?.({ type: "reasoning", round: 1, summary });
          if (scenario.end === "cancel") {
            cancelled = 77;
            throw Object.assign(new Error("aborted"), { name: "AbortError" });
          }
          if (scenario.end === "throw") throw new Error("Provider failed");
          return {
            kind: "completed",
            runId: `run-reasoning-${scenario.end}`,
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
      deps.cancelledRequestId = () => cancelled;
      let refreshes = 0;
      deps.createPanelUpdateHelpers = () => ({
        refreshChatSafely: () => undefined,
        refreshAssistantMessageSafely: () => {
          refreshes += 1;
        },
        setStatusSafely: () => undefined,
      });
      deps.chatHistory.set(conversationKey, []);
      await sendAgentTurn(
        {
          body: {} as Element,
          item: fakeItem(conversationKey),
          question: "Weigh the evidence.",
        },
        deps,
      );
      const atEnd = refreshes;
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(
        refreshes,
        atEnd,
        "no repaint arrives after the turn has ended",
      );
    });
  }
});

/**
 * How a turn the real runtime stopped or failed ends in the panel: the status
 * row, the stored assistant row, Task progress, and the run row. A Stop and a
 * provider error reach the panel the same way for a send and for a retry.
 */
describe("agent turn endings from the real runtime", function () {
  const WAITING = "Waiting for the stopped run to finish";
  let installed: InstalledMockDb;

  beforeEach(function () {
    clearAgentReadLedger();
    clearAgentCoverageLedger();
    clearAgentTranscriptStore();
    clearAgentToolResultHandleStore();
    installed = installMockDb();
  });

  afterEach(function () {
    installed();
    clearAllTaskProgress();
  });

  type Seen = {
    statuses: Array<{ text: string; kind: string }>;
    persisted: any[];
    assistantWrites: any[];
  };

  function readNotesTool(
    registry: AgentToolRegistry,
    execute: () => Promise<unknown>,
  ): AgentToolRegistry {
    registry.register({
      spec: {
        name: "read_notes",
        description: "Read notes",
        inputSchema: { type: "object" },
        executionClass: "read",
        requiresConfirmation: false,
      },
      validate: () => ({ ok: true, value: {} }),
      execute: execute as never,
    });
    return registry;
  }

  const readStep = (id: string): AgentModelStep => ({
    kind: "tool_calls",
    calls: [{ id, name: "read_notes", arguments: {} }],
    assistantMessage: {
      role: "assistant",
      content: "",
      tool_calls: [{ id, name: "read_notes", arguments: {} }],
    },
  });

  const answerStep = (text: string): AgentModelStep => ({
    kind: "final",
    text,
    assistantMessage: { role: "assistant", content: text },
  });

  function realRuntime(params: {
    runStep: (params: AgentStepParams) => Promise<AgentModelStep>;
    registry?: AgentToolRegistry;
    stoppedRunWaitMs?: number;
  }): AgentRuntime {
    return new RealAgentRuntime({
      registry: params.registry || new AgentToolRegistry(),
      ...(params.stoppedRunWaitMs !== undefined
        ? { stoppedRunWaitMs: params.stoppedRunWaitMs }
        : {}),
      adapterFactory: () => ({
        getCapabilities: () => ({
          streaming: true,
          toolCalls: true,
          multimodal: false,
        }),
        supportsTools: () => true,
        runStep: params.runStep,
      }),
    });
  }

  function panelDeps(runtime: AgentRuntime, seen: Seen): AgentEngineDeps {
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    deps.createPanelUpdateHelpers = () => ({
      refreshChatSafely: () => undefined,
      refreshAssistantMessageSafely: () => undefined,
      setStatusSafely: (text, kind) => {
        seen.statuses.push({ text, kind });
      },
    });
    deps.persistConversationMessage = async (_key, message) => {
      seen.persisted.push(message);
    };
    deps.updateStoredLatestAssistantMessage = async (_key, update) => {
      seen.assistantWrites.push(update);
    };
    const config = deps.resolveEffectiveRequestConfig;
    deps.resolveEffectiveRequestConfig = (...args) => ({
      ...config(...args),
      apiBase: "",
    });
    return deps;
  }

  const newSeen = (): Seen => ({
    statuses: [],
    persisted: [],
    assistantWrites: [],
  });

  const storedAssistant = (seen: Seen) =>
    seen.persisted.filter((message) => message.role === "assistant").pop();

  const onlyRun = (conversationKey: number) => {
    const runs = [...installed.runs.values()].filter(
      (run) => Number(run.conversationKey) === conversationKey,
    );
    assert.lengthOf(runs, 1, "the turn wrote one run row");
    return runs[0];
  };

  async function send(
    deps: AgentEngineDeps,
    conversationKey: number,
    question = "Read the notes",
  ): Promise<any[]> {
    const history: any[] = [];
    deps.chatHistory.set(conversationKey, history);
    await sendAgentTurn(
      { body: {} as Element, item: fakeItem(conversationKey), question },
      deps,
    );
    return history;
  }

  /** A stored turn to retry: the question and the answer it got. */
  function retryable(deps: AgentEngineDeps, conversationKey: number) {
    const userMessage = {
      role: "user" as const,
      text: "Read the notes",
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
    return assistantMessage;
  }

  async function retry(deps: AgentEngineDeps, conversationKey: number) {
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
  }

  it("send: a Stop before the next step shows Cancelled and stores the cancelled answer", async function () {
    const conversationKey = 9301;
    const seen = newSeen();
    const runtime = realRuntime({
      registry: readNotesTool(new AgentToolRegistry(), async () => {
        deps.currentAbortController(conversationKey)!.abort();
        return { notes: [] };
      }),
      runStep: async () => readStep("c1"),
    });
    const deps = panelDeps(runtime, seen);
    const history = await send(deps, conversationKey);

    const run = onlyRun(conversationKey);
    assert.equal(run.status, "cancelled");
    assert.deepEqual(seen.statuses.at(-1), {
      text: "Cancelled",
      kind: "ready",
    });
    const stored = storedAssistant(seen);
    assert.equal(stored.text, "[Cancelled]");
    assert.equal(stored.agentRunId, run.runId);
    assert.isUndefined(stored.interrupted);
    assert.isFalse(Boolean(history.at(-1).streaming));
    assert.equal(getTaskProgress(conversationKey)!.runState, "cancelled");
  });

  it("send: a Stop while the model step is in flight shows Cancelled", async function () {
    const conversationKey = 9302;
    const seen = newSeen();
    const runtime = realRuntime({
      runStep: async () => {
        deps.currentAbortController(conversationKey)!.abort();
        throw new Error("The request was aborted.");
      },
    });
    const deps = panelDeps(runtime, seen);
    await send(deps, conversationKey);

    assert.equal(onlyRun(conversationKey).status, "cancelled");
    assert.deepEqual(seen.statuses.at(-1), {
      text: "Cancelled",
      kind: "ready",
    });
    assert.equal(storedAssistant(seen).text, "[Cancelled]");
    assert.equal(getTaskProgress(conversationKey)!.runState, "cancelled");
  });

  it("send: a provider error with nothing streamed stores the error text and shows it", async function () {
    const conversationKey = 9303;
    const seen = newSeen();
    const deps = panelDeps(
      realRuntime({
        runStep: async () => {
          throw new Error("provider down");
        },
      }),
      seen,
    );
    await send(deps, conversationKey);

    const run = onlyRun(conversationKey);
    assert.equal(run.status, "failed");
    assert.deepEqual(seen.statuses.at(-1), {
      text: "Error: provider down",
      kind: "error",
    });
    const stored = storedAssistant(seen);
    assert.equal(stored.text, "Error: provider down");
    assert.isFalse(Boolean(stored.interrupted));
    assert.equal(stored.agentRunId, run.runId);
    assert.equal(getTaskProgress(conversationKey)!.runState, "failed");
  });

  it("send: a provider error after streamed text keeps the text as an interrupted answer", async function () {
    const conversationKey = 9304;
    const seen = newSeen();
    const deps = panelDeps(
      realRuntime({
        runStep: async (params) => {
          await params.onTextDelta?.("Partial answer that streamed. ");
          throw new Error("Error in input stream");
        },
      }),
      seen,
    );
    await send(deps, conversationKey);

    assert.equal(onlyRun(conversationKey).status, "failed");
    assert.deepEqual(seen.statuses.at(-1), {
      text: "Error: Error in input stream",
      kind: "error",
    });
    const stored = storedAssistant(seen);
    assert.equal(stored.text, "Partial answer that streamed. ");
    assert.isTrue(stored.interrupted);
    assert.equal(getTaskProgress(conversationKey)!.runState, "interrupted");
  });

  it("retry: a provider error with nothing streamed restores the previous answer", async function () {
    const conversationKey = 9305;
    const seen = newSeen();
    const deps = panelDeps(
      realRuntime({
        runStep: async () => {
          throw new Error("NetworkError when attempting to fetch resource.");
        },
      }),
      seen,
    );
    const assistantMessage = retryable(deps, conversationKey);
    await retry(deps, conversationKey);

    assert.equal(onlyRun(conversationKey).status, "failed");
    assert.equal(assistantMessage.text, "Preserved partial answer.");
    assert.isTrue(assistantMessage.interrupted);
    assert.isFalse(Boolean(assistantMessage.streaming));
    assert.lengthOf(seen.assistantWrites, 0, "the stored answer is kept");
    assert.deepEqual(seen.statuses.at(-1), {
      text: "Error: NetworkError when attempting to fetch re",
      kind: "error",
    });
  });

  it("retry: a Stop before the next step shows Cancelled and stores the cancelled answer", async function () {
    const conversationKey = 9306;
    const seen = newSeen();
    const runtime = realRuntime({
      registry: readNotesTool(new AgentToolRegistry(), async () => {
        deps.currentAbortController(conversationKey)!.abort();
        return { notes: [] };
      }),
      runStep: async () => readStep("c1"),
    });
    const deps = panelDeps(runtime, seen);
    const assistantMessage = retryable(deps, conversationKey);
    await retry(deps, conversationKey);

    const run = onlyRun(conversationKey);
    assert.equal(run.status, "cancelled");
    assert.equal(assistantMessage.text, "[Cancelled]");
    assert.equal(assistantMessage.agentRunId, run.runId);
    assert.lengthOf(seen.assistantWrites, 1);
    assert.equal(seen.assistantWrites[0].text, "[Cancelled]");
    assert.deepEqual(seen.statuses.at(-1), {
      text: "Cancelled",
      kind: "ready",
    });
    assert.equal(getTaskProgress(conversationKey)!.runState, "cancelled");
  });

  it("ends a failed run once, whether the runtime threw or returned the failure, even when storing the ending fails", async function () {
    const thrown = new Error("provider down");
    const seenBy: Record<string, unknown> = {};
    for (const end of ["throws", "returns failed"] as const) {
      const conversationKey = end === "throws" ? 9310 : 9311;
      const statuses: string[] = [];
      let persists = 0;
      const deps = createDeps({
        runtime: {
          getCapabilities: () => ({
            streaming: true,
            toolCalls: true,
            multimodal: false,
          }),
          runTurn: async (params: any) => {
            await params.onStart?.(`run-${end}`);
            if (end === "throws") throw thrown;
            return {
              kind: "failed",
              runId: `run-${end}`,
              message: "provider down",
              interrupted: true,
              cause: thrown,
            };
          },
        } as unknown as AgentRuntime,
        pendingWrites: [],
        idleRestores: [],
        statuses,
      });
      deps.persistConversationMessage = async (_key, message) => {
        if (message.role !== "assistant") return;
        persists += 1;
        throw new Error("db down");
      };
      deps.chatHistory.set(conversationKey, []);
      let rejection: unknown;
      try {
        await sendAgentTurn(
          {
            body: {} as Element,
            item: fakeItem(conversationKey),
            question: "q",
          },
          deps,
        );
      } catch (error) {
        rejection = error;
      }
      seenBy[end] = {
        rejection: (rejection as Error | undefined)?.message,
        persists,
        lastStatus: statuses.at(-1),
        runState: getTaskProgress(conversationKey)?.runState,
      };
    }
    assert.deepEqual(seenBy["returns failed"], seenBy.throws);
    assert.deepEqual(seenBy.throws, {
      rejection: "db down",
      persists: 1,
      lastStatus: "Error: provider down",
      runState: "failed",
    });
  });

  it("leaves the send with the probe's error when a model without tools could not run the probe", async function () {
    const thrown = new Error("probe failed");
    for (const end of ["throws", "returns failed"] as const) {
      const conversationKey = end === "throws" ? 9308 : 9309;
      let fallbacks = 0;
      const deps = createDeps({
        runtime: {
          getCapabilities: () => ({
            streaming: false,
            toolCalls: false,
            multimodal: false,
          }),
          runTurn: async () => {
            if (end === "throws") throw thrown;
            return {
              kind: "failed",
              runId: "probe-run",
              message: "probe failed",
              interrupted: true,
              cause: thrown,
            };
          },
        } as unknown as AgentRuntime,
        pendingWrites: [],
        idleRestores: [],
        statuses: [],
      });
      deps.sendChatFallback = async () => {
        fallbacks += 1;
      };
      deps.chatHistory.set(conversationKey, []);
      let rejection: unknown;
      try {
        await sendAgentTurn(
          {
            body: {} as Element,
            item: fakeItem(conversationKey),
            question: "q",
          },
          deps,
        );
      } catch (error) {
        rejection = error;
      }
      assert.strictEqual(rejection, thrown, end);
      assert.equal(fallbacks, 0, end);
    }
  });

  it("says it waits for the stopped run before its own run starts, outside the run's trace", async function () {
    const conversationKey = 9307;
    const seen = newSeen();
    let releasePrior!: () => void;
    const priorHolds = new Promise<void>((resolve) => {
      releasePrior = resolve;
    });
    let priorReading!: () => void;
    const priorReads = new Promise<void>((resolve) => {
      priorReading = resolve;
    });
    const runtime = realRuntime({
      stoppedRunWaitMs: 20,
      registry: readNotesTool(new AgentToolRegistry(), async () => {
        priorReading();
        await priorHolds;
        return { notes: [] };
      }),
      runStep: async (params) =>
        params.request.userText === "prior"
          ? params.messages.some((message) => message.role === "tool")
            ? answerStep("Prior done.")
            : readStep("p1")
          : answerStep("Done."),
    });
    const prior = runtime.runTurn({
      request: {
        conversationKey,
        mode: "agent",
        userText: "prior",
        model: "deepseek-v4-pro",
        apiBase: "",
        apiKey: "test",
      },
    });
    await priorReads;

    const deps = panelDeps(runtime, seen);
    const atWaiting: Array<string | undefined> = [];
    const history: any[] = [];
    const setStatus = deps.createPanelUpdateHelpers;
    deps.createPanelUpdateHelpers = (...args) => {
      const helpers = setStatus(...args);
      return {
        ...helpers,
        setStatusSafely: (text, kind) => {
          if (text === WAITING) atWaiting.push(history.at(-1)?.agentRunId);
          helpers.setStatusSafely(text, kind);
        },
      };
    };
    deps.chatHistory.set(conversationKey, history);
    await sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(conversationKey),
        question: "continue",
      },
      deps,
    );
    releasePrior();
    await prior;

    assert.deepEqual(
      atWaiting,
      [undefined],
      "the wait is shown once, before the turn's run has started",
    );
    assert.deepInclude(seen.statuses, { text: WAITING, kind: "sending" });
    const assistant = history.at(-1);
    assert.equal(assistant.text, "Done.");
    const trace = deps.agentRunTraceCache.get(assistant.agentRunId) || [];
    assert.isAbove(trace.length, 0);
    assert.isFalse(
      trace.some(
        (entry: any) =>
          entry.payload?.type === "status" && entry.payload.text === WAITING,
      ),
      "the wait is not one of the run's events",
    );
    assert.isFalse(
      installed.events.some((row) => String(row.payloadJson).includes(WAITING)),
      "the wait is not stored with any run",
    );
  });
});

// Golden records of the exact parameter object each agent request site hands
// deps.buildAgentRuntimeRequest. They pin today's per-site differences (the
// retry omits forcedSkillIds, reuses the stored citation papers and uses the
// stored selected-passage note contexts); unifying any of them is a product
// decision, not a refactor.
describe("agent request sites (golden)", function () {
  const paperA = {
    libraryID: 1,
    itemId: 11,
    contextItemId: 111,
    title: "Paper A",
  };
  const paperB = {
    libraryID: 1,
    itemId: 12,
    contextItemId: 121,
    title: "Paper B",
  };
  const pdfPaper = {
    libraryID: 1,
    itemId: 13,
    contextItemId: 131,
    title: "Paper C",
  };
  const activePaper = {
    libraryID: 1,
    itemId: 14,
    contextItemId: 141,
    title: "Active paper",
  };
  const normalized = (paper: typeof paperA) => ({
    ...paper,
    attachmentTitle: undefined,
    citationKey: undefined,
    firstCreator: undefined,
    year: undefined,
  });
  const completedRuntime = () =>
    ({
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async () =>
        ({
          kind: "completed",
          runId: "run-golden",
          text: "Done.",
          usedFallback: false,
        }) as AgentRuntimeOutcome,
    }) as unknown as AgentRuntime;
  const effectiveRequestConfig = {
    model: "deepseek-v4-pro",
    apiBase: "https://example.invalid/v1",
    apiKey: "test",
    authMode: "api_key",
    providerProtocol: "openai_chat_compat",
    modelEntryId: "deepseek-v4-pro",
    modelProviderLabel: "DeepSeek",
  };

  it("send passes the composed turn context to the request builder", async function () {
    const deps = createDeps({
      runtime: completedRuntime(),
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    deps.includeAutoLoadedPaperContext = (
      _item,
      paperContexts,
      fullTextPaperContexts,
    ) => ({
      paperContexts: paperContexts || [],
      fullTextPaperContexts: fullTextPaperContexts || [],
      activePaperContext: activePaper,
    });
    const captured: any[] = [];
    const buildRequest = deps.buildAgentRuntimeRequest;
    deps.buildAgentRuntimeRequest = async (params) => {
      captured.push(params);
      return await buildRequest(params);
    };
    const item = fakeItem(130);
    deps.chatHistory.set(130, []);
    const anchors = [{ contextIndex: 0, golden: "anchor" }] as any[];
    const collections = [
      { collectionId: 5, name: "Col", libraryID: 1 },
    ] as any[];
    const tags = [{ name: "tag-a", libraryID: 1 }] as any[];
    const attachments = [
      { id: "a1", name: "shot.png", mimeType: "image/png", category: "image" },
    ] as any[];
    const modelAttachments = [
      { id: "m1", name: "doc.txt", mimeType: "text/plain", category: "text" },
    ] as any[];
    const localDocuments = [
      { kind: "pdf", itemId: 13, contextItemId: 131, path: "/tmp/c.pdf" },
    ] as any[];
    const images = ["data:image/png;base64,AAA"];
    const forcedSkillIds = ["skill-x"];

    await sendAgentTurn(
      {
        body: {} as Element,
        item,
        question: "Compare these papers",
        images,
        selectedTextContexts: [
          {
            text: "Passage one.",
            source: "pdf",
            paperContext: paperA,
            contextItemId: 111,
          },
        ],
        resolvedSelectedTextAnchors: anchors,
        paperContexts: [paperA],
        pdfPaperContexts: [pdfPaper],
        fullTextPaperContexts: [paperB],
        selectedCollectionContexts: collections,
        selectedTagContexts: tags,
        attachments,
        modelAttachments,
        localDocuments,
        forcedSkillIds,
      },
      deps,
    );

    assert.lengthOf(captured, 1);
    const params = captured[0];
    const storedUser = deps.chatHistory.get(130)![0];
    assert.deepStrictEqual(params, {
      conversationKey: 130,
      conversationGeneration: undefined,
      sourceMessageTimestamp: storedUser.timestamp,
      item,
      activePaperContext: activePaper,
      userText: "Compare these papers",
      selectedTextContexts: [
        {
          text: "Passage one.",
          source: "pdf",
          paperContext: normalized(paperA),
          noteContext: undefined,
          contextItemId: 111,
          pageIndex: undefined,
          pageLabel: undefined,
        },
      ],
      resolvedSelectedTextAnchors: anchors,
      selectedTexts: ["Passage one."],
      selectedTextSources: ["pdf"],
      selectedTextPaperContexts: [normalized(paperA)],
      selectedTextNoteContexts: [undefined],
      paperContexts: [paperA],
      pdfPaperContexts: [{ ...pdfPaper, contentSourceMode: "pdf" }],
      fullTextPaperContexts: [paperB],
      citationPaperContexts: [normalized(paperA), normalized(paperB)],
      selectedCollectionContexts: collections,
      selectedTagContexts: tags,
      attachments: modelAttachments,
      localDocuments,
      screenshots: images,
      forcedSkillIds,
      effectiveRequestConfig,
      history: [],
    });
    // The site passes these through by reference.
    assert.strictEqual(
      params.selectedTextContexts,
      storedUser.selectedTextContexts,
    );
    assert.strictEqual(
      params.citationPaperContexts,
      storedUser.citationPaperContexts,
    );
    assert.strictEqual(params.resolvedSelectedTextAnchors, anchors);
    assert.strictEqual(params.attachments, modelAttachments);
    assert.strictEqual(params.screenshots, images);
    assert.strictEqual(params.forcedSkillIds, forcedSkillIds);
    assert.strictEqual(params.localDocuments, localDocuments);
  });

  it("send falls back to the visible attachments only when no model attachments are given", async function () {
    const deps = createDeps({
      runtime: completedRuntime(),
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    const captured: any[] = [];
    deps.buildAgentRuntimeRequest = (params) => {
      captured.push(params);
      return { conversationKey: params.conversationKey } as any;
    };
    deps.chatHistory.set(131, []);
    const attachments = [{ id: "a1", category: "text" }] as any[];
    const emptyModelAttachments: any[] = [];
    await sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(131),
        question: "q",
        attachments,
      },
      deps,
    ).catch(() => undefined);
    deps.chatHistory.set(132, []);
    await sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(132),
        question: "q",
        attachments,
        modelAttachments: emptyModelAttachments,
      },
      deps,
    ).catch(() => undefined);
    assert.strictEqual(captured[0].attachments, attachments);
    // `??`: an empty model list is kept, not replaced by the visible list.
    assert.strictEqual(captured[1].attachments, emptyModelAttachments);
  });

  it("retry passes the stored turn context to the request builder", async function () {
    const conversationKey = 133;
    const storedNoteContexts = [undefined];
    const storedCitationPapers = [paperA];
    const userMessage: any = {
      role: "user",
      text: "summarize",
      timestamp: 100,
      runMode: "agent",
      selectedTexts: ["Stored passage."],
      selectedTextSources: ["note"],
      selectedTextNoteContexts: storedNoteContexts,
      citationPaperContexts: storedCitationPapers,
      forcedSkillIds: ["skill-stored"],
      modelAttachments: [{ id: "m-stored", category: "text" }],
      attachments: [{ id: "a-stored", category: "image" }],
    };
    const assistantMessage: any = {
      role: "assistant",
      text: "previous",
      timestamp: 200,
      runMode: "agent",
    };
    const deps = createDeps({
      runtime: completedRuntime(),
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
    const screenshotImages = ["data:image/png;base64,BBB"];
    const collections = [
      { collectionId: 6, name: "Col", libraryID: 1 },
    ] as any[];
    const tags = [{ name: "tag-b", libraryID: 1 }] as any[];
    deps.reconstructRetryPayload = () => ({
      question: "summarize",
      screenshotImages,
      paperContexts: [paperA],
      pdfPaperContexts: [],
      fullTextPaperContexts: [paperB],
      selectedCollectionContexts: collections,
      selectedTagContexts: tags,
    });
    const autoPapers = [paperA, pdfPaper];
    const autoFullText = [paperB];
    deps.includeAutoLoadedPaperContext = () => ({
      paperContexts: autoPapers,
      fullTextPaperContexts: autoFullText,
      activePaperContext: activePaper,
    });
    const captured: any[] = [];
    const buildRequest = deps.buildAgentRuntimeRequest;
    deps.buildAgentRuntimeRequest = async (params) => {
      captured.push(params);
      return await buildRequest(params);
    };
    const item = fakeItem(conversationKey);

    await retryAgentTurn(
      {} as Element,
      item,
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

    assert.lengthOf(captured, 1);
    const params = captured[0];
    assert.deepStrictEqual(params, {
      conversationKey,
      conversationGeneration: undefined,
      sourceMessageTimestamp: 100,
      item,
      activePaperContext: activePaper,
      userText: "summarize",
      selectedTextContexts: [
        {
          text: "Stored passage.",
          source: "note",
          paperContext: undefined,
          noteContext: undefined,
          contextItemId: undefined,
        },
      ],
      // A note passage with no paper resolves no anchor.
      resolvedSelectedTextAnchors: [],
      selectedTexts: ["Stored passage."],
      selectedTextSources: ["note"],
      selectedTextPaperContexts: [undefined],
      selectedTextNoteContexts: storedNoteContexts,
      paperContexts: autoPapers,
      pdfPaperContexts: [],
      fullTextPaperContexts: autoFullText,
      citationPaperContexts: storedCitationPapers,
      selectedCollectionContexts: collections,
      selectedTagContexts: tags,
      attachments: userMessage.modelAttachments,
      localDocuments: undefined,
      screenshots: screenshotImages,
      effectiveRequestConfig,
      history: [],
    });
    // The retry hands over no forced skills at all (not even an undefined key).
    assert.notProperty(params, "forcedSkillIds");
    assert.strictEqual(params.selectedTextNoteContexts, storedNoteContexts);
    assert.strictEqual(params.citationPaperContexts, storedCitationPapers);
    assert.strictEqual(
      params.selectedTextContexts,
      userMessage.selectedTextContexts,
    );
    assert.strictEqual(params.screenshots, screenshotImages);
  });
});
