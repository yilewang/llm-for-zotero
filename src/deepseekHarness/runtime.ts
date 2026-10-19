import type { AgentRuntime } from "../agent/runtime";
import type { AgentToolRegistry } from "../agent/tools/registry";
import type {
  AgentConfirmationResolution,
  AgentEvent,
  AgentRuntimeOutcome,
  AgentToolContext,
} from "../agent/types";
import type { AgentActionReceipt } from "../agent/contracts/types";
import {
  buildAgentInitialMessages,
  normalizeHistoryMessages,
} from "../agent/model/messageBuilder";
import { getConversationKeyLedgerEntry } from "../shared/conversationKeyLedger";
import { resolveRequestProviderProtocol } from "../agent/model/factory";
import { resolveAgentOutputRequestPolicy } from "../agent/model/limits";
import { buildAgentModelCapabilities } from "../agent/model/contentCapabilities";
import { settleExternalTurn } from "../agent/execution/externalTurnSettlement";
import {
  createAgentRun,
  appendAgentRunEvent,
  finishAgentRun,
} from "../agent/store/traceStore";
import { recordAgentTurn } from "../agent/store/conversationMemory";
import { loadLatestDocumentForRun } from "../agent/documents/store";
import {
  AgentEventLocalDocumentStreamRedactor,
  acquireLocalDocumentPathLease,
  LocalDocumentPathStreamRedactor,
} from "../agent/privacy/localDocumentPathRedaction";
import {
  getAllSkills,
  getBuiltinSkillInstructionById,
  getMatchedSkillIds,
  loadSkill,
} from "../agent/skills";
import {
  areConversationWritesFrozen,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../shared/conversationWriteFence";
import { createAbortController } from "../utils/apiHelpers";
import { createTurnUsageRecorder } from "../utils/usageTurnRecorder";
import { resolveModelInputTokenLimit } from "../utils/modelInputCap";
import { runHarnessProcess } from "./process";

const activeTurns = new Map<number, () => void>();

export function stopDeepSeekHarness(): void {
  for (const stop of activeTurns.values()) stop();
}

export function getDeepSeekHarnessRuntime(
  core: AgentRuntime,
  registry: AgentToolRegistry,
): AgentRuntime {
  return new Proxy(core, {
    get(target, key) {
      if (key === "getCapabilities")
        return () =>
          buildAgentModelCapabilities({
            streaming: true,
            toolCalls: true,
            contentInputs: null,
            fileInputs: false,
            reasoning: true,
          });
      if (key === "runTurn")
        return (params: Parameters<AgentRuntime["runTurn"]>[0]) =>
          runTurn(core, registry, params);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function runTurn(
  core: AgentRuntime,
  registry: AgentToolRegistry,
  params: Parameters<AgentRuntime["runTurn"]>[0],
): Promise<AgentRuntimeOutcome> {
  const key = params.request.conversationKey;
  if (activeTurns.has(key))
    throw new Error("This conversation already has a Harness turn running");
  const controller = createAbortController();
  let externallyStopped = false;
  const forwardAbort = () => {
    externallyStopped = true;
    controller.abort();
  };
  activeTurns.set(key, forwardAbort);
  params.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (params.signal?.aborted) forwardAbort();
  const runId = `harness-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let sequence = 0;
  let confirmationSequence = 0;
  let answer = "";
  let created = false;
  let succeeded = false;
  let releasePaths: () => void = () => undefined;
  let flushUsage: (() => Promise<unknown>) | undefined;
  const receipts: AgentActionReceipt[] = [];
  const toolsUsed: string[] = [];
  const eventsRedactor = new AgentEventLocalDocumentStreamRedactor(key);
  const textRedactor = new LocalDocumentPathStreamRedactor(key);
  let live = () => !controller.signal.aborted;
  let generationCurrent = () => !areConversationWritesFrozen(key);
  const persist = async (task: () => Promise<unknown>) => {
    if (!live()) return;
    await withConversationWriteLock(key, async () => {
      if (live()) await task();
    });
  };
  let eventQueue = Promise.resolve();
  const emit = (event: AgentEvent) => {
    eventQueue = eventQueue.then(async () => {
      if (!live()) return;
      for (const safeEvent of eventsRedactor.process(event)) {
        await persist(() => appendAgentRunEvent(runId, ++sequence, safeEvent));
        if (live()) await params.onEvent?.(safeEvent);
      }
    });
    return eventQueue;
  };
  try {
    const request = await core.prepareExecutionRequest(params.request, {
      signal: controller.signal,
      permissionOwner: "original_agent",
    });
    generationCurrent = () =>
      !areConversationWritesFrozen(key) &&
      isConversationWriteGenerationCurrent(
        key,
        request.conversationGeneration || 0,
      );
    live = () => !controller.signal.aborted && generationCurrent();
    if (
      resolveRequestProviderProtocol(request) !== "openai_chat_compat" ||
      (request.authMode && request.authMode !== "api_key")
    )
      throw new Error(
        "DeepSeek Harness requires an API-key OpenAI-compatible provider",
      );
    if (!request.model || !request.apiBase || !request.apiKey)
      throw new Error(
        "Select a provider endpoint, API key, and model for DeepSeek Harness",
      );
    if (request.screenshots?.length || request.attachments?.length)
      throw new Error(
        "DeepSeek Harness accepts text and Zotero paper tools. Remove inline images and attachments from this turn.",
      );
    releasePaths = acquireLocalDocumentPathLease(
      key,
      request.localDocuments?.map((entry) => entry.resource),
    ).release;
    await persist(() =>
      createAgentRun({
        runId,
        conversationKey: key,
        mode: "agent",
        model: request.model,
        status: "running",
        createdAt: Date.now(),
      }),
    );
    created = live();
    if (!live()) throw new Error("Cancelled");
    await params.onStart?.(runId);
    const usage = createTurnUsageRecorder({
      conversationKey: key,
      conversationGeneration: request.conversationGeneration,
      runtime: "agent",
      model: request.model,
      provider: request.modelProviderLabel,
      countsAsQuestion: params.usageCountsAsQuestion !== false,
    });
    flushUsage = () =>
      usage.flush(
        succeeded ? "complete" : params.signal?.aborted ? "abort" : "error",
      );
    const ask = (action: import("../agent/types").AgentPendingAction) =>
      new Promise<AgentConfirmationResolution>((resolve, reject) => {
        const requestId = `harness-confirm-${runId}-${++confirmationSequence}`;
        const onAbort = () => core.resolveConfirmation(requestId, false);
        core.registerPendingConfirmation(requestId, (resolution) => {
          controller.signal.removeEventListener("abort", onAbort);
          void emit({
            type: "confirmation_resolved",
            requestId,
            approved: resolution.approved,
            actionId: resolution.actionId,
          }).then(() => resolve(resolution), reject);
        });
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) {
          onAbort();
          return;
        }
        void emit({ type: "confirmation_required", requestId, action }).catch(
          (error) => {
            core.resolveConfirmation(requestId, false);
            reject(error);
          },
        );
      });
    const context: AgentToolContext = {
      request,
      runId,
      item:
        request.item ||
        (request.activeItemId
          ? Zotero.Items.get(request.activeItemId) || null
          : null),
      currentAnswerText: "",
      modelName: request.model,
      modelProviderLabel: request.modelProviderLabel,
      signal: controller.signal,
      requestActionReview: ask,
    };
    const matched = getMatchedSkillIds(request, []);
    request.loadedSkillRecords = await Promise.all(
      getAllSkills()
        .filter((skill) => matched.includes(skill.id))
        .map(async (skill) => ({
          ...(await loadSkill(skill, getBuiltinSkillInstructionById(skill.id)))
            .loadedSkill,
          source: request.forcedSkillIds?.includes(skill.id)
            ? ("forced" as const)
            : ("loaded" as const),
        })),
    );
    const definitions = registry.listToolDefinitionsForRequest(request);
    const messages = await buildAgentInitialMessages(
      request,
      definitions,
      matched,
      undefined,
      {
        contentInputs: {
          images: false,
          pdfDocuments: false,
          nativeFiles: false,
        },
      },
    );
    const text = (content: (typeof messages)[number]["content"]) => {
      if (typeof content === "string") return content;
      if (content.some((part) => part.type !== "text"))
        throw new Error("DeepSeek Harness currently accepts text context only");
      return content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n");
    };
    const conversation = messages.filter(
      (message) => message.role === "user" || message.role === "assistant",
    );
    const current = conversation.pop();
    if (!current || current.role !== "user")
      throw new Error("Harness requires a user prompt");
    await emit({ type: "status", text: "DeepSeek Harness" });
    const outputPolicy = resolveAgentOutputRequestPolicy(
      request,
      "openai_chat_compat",
    );
    const identity = await getConversationKeyLedgerEntry(key);
    if (!identity || identity.retiredAt)
      throw new Error("Harness requires an active conversation identity");
    const profileDirectory = String(
      (Zotero as typeof Zotero & { Profile?: { dir?: string } }).Profile?.dir ||
        "",
    );
    if (!profileDirectory)
      throw new Error("Zotero profile directory is unavailable");
    const result = await runHarnessProcess(
      {
        model: request.model,
        session: {
          root: `${profileDirectory}/llm-for-zotero/harness`,
          key: `${identity.instanceID}:${identity.conversationID}:${request.conversationGeneration || 0}`,
          userText: request.userText,
          history: normalizeHistoryMessages(request).map((message) => ({
            role: message.role as "user" | "assistant",
            content: text(message.content),
          })),
        },
        contextWindow: resolveModelInputTokenLimit(
          request.model,
          request.advanced?.inputTokenCap,
          {
            apiBase: request.apiBase,
            protocol: "openai_chat_compat",
            authMode: request.authMode,
            profileOverride: request.advanced?.profileOverride,
          },
        ).limitTokens,
        apiBase: request.apiBase,
        apiKey: request.apiKey,
        ...(outputPolicy.mode === "numeric"
          ? { maxTokens: outputPolicy.tokens }
          : {}),
        ...(request.advanced
          ? { temperature: request.advanced.temperature }
          : {}),
        systemPrompt: messages
          .filter((message) => message.role === "system")
          .map((message) => text(message.content))
          .join("\n\n"),
        history: conversation.map((message) => ({
          role: message.role as "user" | "assistant",
          content: text(message.content),
        })),
        tools: registry.listToolsForRequest(request),
      },
      text(current.content),
      {
        signal: controller.signal,
        onStop: () => controller.abort(),
        onEvent: async (value) => {
          if (!live()) throw new Error("Conversation was cleared or cancelled");
          const event = value as AgentEvent;
          if (
            event.type === "message_delta" &&
            typeof event.text === "string"
          ) {
            answer += event.text;
            context.currentAnswerText = answer;
            await emit(event);
          } else if (
            event.type === "reasoning" ||
            event.type === "status" ||
            event.type === "context_compacted"
          )
            await emit(event);
          else if (event.type === "usage" && "round" in event) {
            usage.markDispatched();
            usage.record(event, { segment: event.round });
            await emit(event);
          }
        },
        onToolCall: async (call) => {
          if (
            !live() ||
            !call ||
            typeof call.name !== "string" ||
            typeof call.callId !== "string"
          )
            throw new Error("Invalid or expired Harness tool call");
          const spec = definitions.find(
            (tool) => tool.spec.name === call.name,
          )?.spec;
          if (!spec) throw new Error("Tool is outside this turn's catalog");
          toolsUsed.push(call.name);
          await emit({
            type: "tool_call",
            callId: call.callId,
            name: call.name,
            args: call.args,
            workCategory: spec.workCategory,
          });
          let prepared = await registry.prepareExecution(
            { id: call.callId, name: call.name, arguments: call.args },
            context,
            {
              callerKind: "model",
              isExecutionAllowed: live,
              executeWithLock: (task) => withConversationWriteLock(key, task),
            },
          );
          while (prepared.kind === "confirmation") {
            const resolution = await ask(prepared.action);
            prepared = resolution.approved
              ? await prepared.execute(resolution)
              : {
                  kind: "result",
                  execution: await prepared.deny(resolution.data),
                };
          }
          const toolResult = prepared.execution.result;
          receipts.push(...toolResult.actionReceipts);
          await emit({
            type: "tool_result",
            ...toolResult,
            workCategory: spec.workCategory,
          });
          return toolResult;
        },
      },
    );
    // Process teardown aborts only the tool lifetime; final writes still use the captured generation.
    live = () => !externallyStopped && generationCurrent();
    if (!live()) throw new Error("Cancelled");
    const settlement = settleExternalTurn({
      answerText: result.text,
      answered: true,
      document: await loadLatestDocumentForRun(runId),
      hostReceipts: receipts,
    });
    answer = textRedactor.redactTerminalText(settlement.text);
    await emit({
      type: "final",
      text: answer,
      ...(settlement.documentId ? { documentId: settlement.documentId } : {}),
    });
    await persist(() => finishAgentRun(runId, settlement.status, answer));
    await persist(() =>
      recordAgentTurn(key, request.userText, toolsUsed, answer),
    );
    succeeded = true;
    return {
      kind: "completed",
      runId,
      text: answer,
      usedFallback: false,
      runStatus: settlement.status,
      ...(settlement.documentId ? { documentId: settlement.documentId } : {}),
    };
  } catch (error) {
    const cancelled = externallyStopped || !generationCurrent();
    const message = textRedactor.redactTerminalText(
      error instanceof Error ? error.message : String(error),
    );
    if (created && generationCurrent())
      await withConversationWriteLock(key, async () => {
        if (generationCurrent())
          await finishAgentRun(
            runId,
            cancelled ? "cancelled" : "failed",
            message,
          );
      });
    return cancelled
      ? { kind: "cancelled", runId, text: answer, cause: error }
      : {
          kind: "failed",
          runId,
          message,
          interrupted: false,
          cause: error,
        };
  } finally {
    controller.abort();
    activeTurns.delete(key);
    params.signal?.removeEventListener("abort", forwardAbort);
    releasePaths();
    await flushUsage?.();
  }
}
