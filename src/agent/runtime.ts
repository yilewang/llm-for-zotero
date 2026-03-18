import { AgentToolRegistry } from "./tools/registry";
import { readAttachmentBytes } from "../modules/contextPanel/attachmentStorage";
import { recordAgentTurn } from "./store/conversationMemory";
import type {
  AgentInheritedApproval,
  AgentModelContentPart,
  AgentConfirmationResolution,
  AgentEvent,
  AgentModelMessage,
  AgentModelStep,
  AgentPendingAction,
  AgentRuntimeOutcome,
  AgentRuntimeRequest,
  AgentToolCall,
  AgentToolArtifact,
  AgentToolContext,
  AgentToolResult,
} from "./types";
import type { AgentModelAdapter } from "./model/adapter";
import { resolveAgentLimits } from "./model/limits";
import { classifyRequest } from "./model/requestClassifier";
import { buildAgentInitialMessages } from "./model/messageBuilder";
import {
  appendAgentRunEvent,
  createAgentRun,
  finishAgentRun,
  getAgentRunTrace,
} from "./store/traceStore";

type AgentRuntimeDeps = {
  registry: AgentToolRegistry;
  adapterFactory: (request: AgentRuntimeRequest) => AgentModelAdapter;
  now?: () => number;
};

type PendingConfirmation = {
  resolve: (resolution: AgentConfirmationResolution) => void;
};

function createRunId(): string {
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createConfirmationRequestId(): string {
  return `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function encodeBytesBase64(bytes: Uint8Array): string {
  let out = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(bytes.length, index + chunkSize));
    out += String.fromCharCode(...chunk);
  }
  const btoaFn =
    (globalThis as typeof globalThis & { btoa?: (value: string) => string }).btoa;
  if (typeof btoaFn !== "function") {
    throw new Error("btoa is unavailable");
  }
  return btoaFn(out);
}

async function toDataUrl(
  storedPath: string,
  mimeType: string,
): Promise<string> {
  const bytes = await readAttachmentBytes(storedPath);
  return `data:${mimeType};base64,${encodeBytesBase64(bytes)}`;
}

function summarizeArtifacts(artifacts: AgentToolArtifact[]): string {
  const imagePages = artifacts
    .filter((artifact): artifact is Extract<AgentToolArtifact, { kind: "image" }> => {
      return artifact.kind === "image";
    })
    .map((artifact) => artifact.pageLabel || (Number.isFinite(artifact.pageIndex) ? `${artifact.pageIndex! + 1}` : ""));
  const fileTitles = artifacts
    .filter((artifact): artifact is Extract<AgentToolArtifact, { kind: "file_ref" }> => {
      return artifact.kind === "file_ref";
    })
    .map((artifact) => artifact.title || artifact.name);
  const parts: string[] = [];
  if (imagePages.length) {
    parts.push(
      `Prepared PDF page image${imagePages.length === 1 ? "" : "s"} (${imagePages
        .filter(Boolean)
        .map((entry) => `p${entry}`)
        .join(", ") || `${imagePages.length} page${imagePages.length === 1 ? "" : "s"}`}) for visual inspection.`,
    );
  }
  if (fileTitles.length) {
    parts.push(
      `Prepared the PDF file${fileTitles.length === 1 ? "" : "s"} ${fileTitles
        .map((entry) => `"${entry}"`)
        .join(", ")} for direct reading.`,
    );
  }
  parts.push(
    "Use the attached pages or PDF directly when answering. Do not ask the user to re-upload them.",
  );
  return parts.join(" ");
}

async function buildArtifactFollowupMessage(
  result: AgentToolResult,
): Promise<AgentModelMessage | null> {
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  if (!artifacts.length || !result.ok) return null;
  const parts: AgentModelContentPart[] = [
    {
      type: "text",
      text: summarizeArtifacts(artifacts),
    },
  ];
  for (const artifact of artifacts) {
    if (artifact.kind === "image") {
      if (!artifact.storedPath || !artifact.mimeType) continue;
      try {
        const url = await toDataUrl(artifact.storedPath, artifact.mimeType);
        parts.push({
          type: "image_url",
          image_url: {
            url,
            detail: "high",
          },
        });
      } catch (error) {
        ztoolkit.log("LLM Agent: Failed to load image artifact", artifact, error);
      }
      continue;
    }
    parts.push({
      type: "file_ref",
      file_ref: {
        name: artifact.name,
        mimeType: artifact.mimeType,
        storedPath: artifact.storedPath,
        contentHash: artifact.contentHash,
      },
    });
  }
  return parts.length > 1
    ? {
        role: "user",
        content: parts,
      }
    : null;
}

type ToolWorkflowDelivery = {
  callId: string;
  name: string;
  content: unknown;
  followupMessages: AgentModelMessage[];
};

type ToolWorkflowOutcome = {
  toolResult: AgentToolResult;
  delivery?: ToolWorkflowDelivery;
  stopRun?: boolean;
  finalText?: string;
};

type ExecutedToolCall = {
  toolResult: AgentToolResult;
  toolDefinition?: import("./types").AgentToolDefinition<any, any>;
  input?: unknown;
};

function buildSyntheticToolCall(
  name: string,
  args: unknown,
): AgentToolCall {
  return {
    id: `synthetic-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    arguments: args,
  };
}

function readToolError(result: AgentToolResult): string {
  return result.content &&
    typeof result.content === "object" &&
    "error" in result.content
    ? String((result.content as { error: unknown }).error || "")
    : "";
}

function isUserDeniedToolResult(result: AgentToolResult): boolean {
  return readToolError(result).toLowerCase() === "user denied action";
}

export class AgentRuntime {
  private readonly registry: AgentToolRegistry;
  private readonly adapterFactory: AgentRuntimeDeps["adapterFactory"];
  private readonly now: () => number;
  private readonly pendingConfirmations = new Map<string, PendingConfirmation>();

  constructor(deps: AgentRuntimeDeps) {
    this.registry = deps.registry;
    this.adapterFactory = deps.adapterFactory;
    this.now = deps.now || (() => Date.now());
  }

  listTools() {
    return this.registry.listTools();
  }

  getToolDefinition(name: string) {
    return this.registry.getTool(name);
  }

  registerTool<TInput, TResult>(
    tool: import("./types").AgentToolDefinition<TInput, TResult>,
  ): void {
    this.registry.register(tool);
  }

  unregisterTool(name: string): boolean {
    return this.registry.unregister(name);
  }

  getCapabilities(request: AgentRuntimeRequest) {
    return this.adapterFactory(request).getCapabilities(request);
  }

  /**
   * Registers an external pending confirmation so that `resolveConfirmation`
   * can settle it.  Used by the action-picker UI to wire action HITL cards
   * into the same resolution path as agent-turn confirmations.
   */
  registerPendingConfirmation(
    requestId: string,
    resolve: (resolution: AgentConfirmationResolution) => void,
  ): void {
    this.pendingConfirmations.set(requestId, { resolve });
  }

  resolveConfirmation(
    requestId: string,
    approvedOrResolution: boolean | AgentConfirmationResolution,
    data?: unknown,
  ): boolean {
    const pending = this.pendingConfirmations.get(requestId);
    if (!pending) return false;
    this.pendingConfirmations.delete(requestId);
    const resolution =
      typeof approvedOrResolution === "boolean"
        ? {
            approved: approvedOrResolution,
            actionId: approvedOrResolution ? undefined : "cancel",
            data,
          }
        : {
            approved: Boolean(approvedOrResolution.approved),
            actionId: approvedOrResolution.actionId,
            data: approvedOrResolution.data,
          };
    pending.resolve(resolution);
    return true;
  }

  async getRunTrace(runId: string) {
    return getAgentRunTrace(runId);
  }

  async runTurn(params: {
    request: AgentRuntimeRequest;
    onEvent?: (event: AgentEvent) => void | Promise<void>;
    onStart?: (runId: string) => void | Promise<void>;
    signal?: AbortSignal;
  }): Promise<AgentRuntimeOutcome> {
    const request = params.request;
    const runId = createRunId();
    const adapter = this.adapterFactory(request);
    let eventSeq = 0;
    let currentAnswerText = "";
    const item = request.item || null;
    await createAgentRun({
      runId,
      conversationKey: request.conversationKey,
      mode: "agent",
      model: request.model,
      status: "running",
      createdAt: this.now(),
    });
    await params.onStart?.(runId);

    const emit = async (event: AgentEvent) => {
      eventSeq += 1;
      await appendAgentRunEvent(runId, eventSeq, event);
      await params.onEvent?.(event);
    };

    if (!adapter.supportsTools(request)) {
      const reason = "Agent tools unavailable for this model; used direct response instead.";
      await emit({
        type: "fallback",
        reason,
      });
      await finishAgentRun(runId, "completed");
      return {
        kind: "fallback",
        runId,
        reason,
        usedFallback: true,
      };
    }

    const context: AgentToolContext = {
      request,
      item,
      currentAnswerText,
      modelName: request.model || "unknown",
      modelProviderLabel: request.modelProviderLabel,
    };
    const toolsUsedThisTurn: string[] = [];
    const messages = (await buildAgentInitialMessages(
      request,
      this.registry.listToolDefinitionsForRequest(request),
    )) as AgentModelMessage[];

    let consecutiveToolErrors = 0;
    const intent = classifyRequest(request);
    const { maxRounds, maxToolCallsPerRound } = resolveAgentLimits(
      intent.isBulkOperation,
    );
    const shouldFlushStreamBuffer = (value: string): boolean => {
      if (!value) return false;
      if (value.length >= 8) return true;
      return /(?:\n|[.!?,:;]\s?)$/u.test(value);
    };
    const completeRun = async (
      finalText: string,
      status: "completed" | "failed" = "completed",
      options: { emitFinalEvent?: boolean } = {},
    ): Promise<AgentRuntimeOutcome> => {
      if (options.emitFinalEvent !== false) {
        await emit({
          type: "final",
          text: finalText,
        });
      }
      await finishAgentRun(runId, status, finalText);
      if (status === "completed" && finalText) {
        await recordAgentTurn(
          request.conversationKey,
          request.userText,
          toolsUsedThisTurn,
          finalText,
        );
      }
      return {
        kind: "completed",
        runId,
        text: finalText,
        usedFallback: false,
      };
    };
    const emitFinalStep = async (
      step: Extract<AgentModelStep, { kind: "final" }>,
      stepStreamedText: string,
    ): Promise<AgentRuntimeOutcome> => {
      const finalText = step.text || stepStreamedText || currentAnswerText || "No response.";
      if (finalText) {
        if (!stepStreamedText) {
          currentAnswerText = finalText;
          await emit({
            type: "message_delta",
            text: finalText,
          });
        } else if (finalText.startsWith(stepStreamedText)) {
          const remainder = finalText.slice(stepStreamedText.length);
          if (remainder) {
            currentAnswerText += remainder;
            await emit({
              type: "message_delta",
              text: remainder,
            });
          }
        } else {
          currentAnswerText = finalText;
        }
      }
      return completeRun(finalText, "completed");
    };
    const runModelStep = async (
      round: number,
      statusText: string,
    ): Promise<{ step: AgentModelStep; stepStreamedText: string }> => {
      if (params.signal?.aborted) {
        await finishAgentRun(runId, "cancelled", currentAnswerText);
        throw new Error("Aborted");
      }
      await emit({
        type: "status",
        text: statusText,
      });
      let stepStreamedText = "";
      let stepPendingDelta = "";
      const flushStepDelta = async () => {
        if (!stepPendingDelta) return;
        const text = stepPendingDelta;
        stepPendingDelta = "";
        currentAnswerText += text;
        await emit({
          type: "message_delta",
          text,
        });
      };
      const step = await adapter.runStep({
        request,
        messages,
        tools: this.registry.listToolsForRequest(request),
        signal: params.signal,
        onTextDelta: async (delta) => {
          if (!delta) return;
          stepStreamedText += delta;
          stepPendingDelta += delta;
          if (shouldFlushStreamBuffer(stepPendingDelta)) {
            await flushStepDelta();
          }
        },
        onReasoning: async (reasoning) => {
          if (!reasoning.summary && !reasoning.details) return;
          await emit({
            type: "reasoning",
            round,
            summary: reasoning.summary,
            details: reasoning.details,
          });
        },
      });
      await flushStepDelta();
      return {
        step,
        stepStreamedText,
      };
    };
    const requestActionResolution = async (
      action: AgentPendingAction,
    ): Promise<{ requestId: string; resolution: AgentConfirmationResolution }> => {
      const requestId = createConfirmationRequestId();
      const resolution = new Promise<AgentConfirmationResolution>((resolve) => {
        this.pendingConfirmations.set(requestId, { resolve });
      });
      await emit({
        type: "confirmation_required",
        requestId,
        action,
      });
      const settled = await resolution;
      await emit({
        type: "confirmation_resolved",
        requestId,
        approved: settled.approved,
        actionId: settled.actionId,
        data: settled.data,
      });
      return {
        requestId,
        resolution: settled,
      };
    };
    const executePreparedToolCall = async (
      call: AgentToolCall,
      round: number,
      options: {
        inheritedApproval?: AgentInheritedApproval;
      } = {},
    ): Promise<ExecutedToolCall> => {
      await emit({
        type: "tool_call",
        callId: call.id,
        name: call.name,
        args: call.arguments,
      });
      toolsUsedThisTurn.push(call.name);
      const execution = await this.registry.prepareExecution(call, {
        ...context,
        currentAnswerText,
      }, {
        inheritedApproval: options.inheritedApproval,
      });
      let executedCall: {
        toolResult: AgentToolResult;
        toolDefinition?: import("./types").AgentToolDefinition<any, any>;
        input?: unknown;
      };
      if (execution.kind === "confirmation") {
        const { resolution } = await requestActionResolution(execution.action);
        const confirmedExecution = resolution.approved
          ? await execution.execute(resolution.data)
          : execution.deny(resolution.data);
        executedCall = {
          toolResult: confirmedExecution.result,
          toolDefinition: confirmedExecution.tool,
          input: confirmedExecution.input,
        };
      } else {
        executedCall = {
          toolResult: execution.execution.result,
          toolDefinition: execution.execution.tool,
          input: execution.execution.input,
        };
      }
      const { toolResult } = executedCall;
      if (toolResult.ok) {
        consecutiveToolErrors = 0;
      } else {
        consecutiveToolErrors += 1;
        const rawError = readToolError(toolResult);
        if (rawError && rawError.toLowerCase() !== "user denied action") {
          await emit({
            type: "tool_error",
            callId: toolResult.callId,
            name: toolResult.name,
            error: rawError,
            round,
          });
        }
      }
      await emit({
        type: "tool_result",
        callId: toolResult.callId,
        name: toolResult.name,
        ok: toolResult.ok,
        content: toolResult.content,
        artifacts: toolResult.artifacts,
      });
      return executedCall;
    };
    const buildToolDelivery = async (
      toolResult: AgentToolResult,
      callId: string,
      toolDefinition?: import("./types").AgentToolDefinition<any, any>,
      contentOverride?: unknown,
      extraFollowupMessages: AgentModelMessage[] = [],
    ): Promise<ToolWorkflowDelivery> => {
      const followupMessage = toolDefinition?.buildFollowupMessage
        ? await toolDefinition.buildFollowupMessage(toolResult, {
            ...context,
            currentAnswerText,
          })
        : await buildArtifactFollowupMessage(toolResult);
      const followupMessages = [...extraFollowupMessages];
      if (followupMessage) {
        followupMessages.push(followupMessage);
      }
      return {
        callId,
        name: toolResult.name,
        content: contentOverride ?? toolResult.content,
        followupMessages,
      };
    };
    const executeToolWorkflow = async (
      call: AgentToolCall,
      round: number,
      options: {
        modelCallId?: string;
        suppressModelDelivery?: boolean;
        inheritedApproval?: AgentInheritedApproval;
      } = {},
    ): Promise<ToolWorkflowOutcome> => {
      const executedCall = await executePreparedToolCall(call, round, {
        inheritedApproval: options.inheritedApproval,
      });
      const { toolResult, toolDefinition, input } = executedCall;
      const deliveryCallId = options.modelCallId || call.id;

      if (
        toolResult.ok &&
        toolDefinition?.createResultReviewAction &&
        toolDefinition.resolveResultReview
      ) {
        let currentResult = toolResult;
        const currentInput = input;
        while (true) {
          const reviewAction = await toolDefinition.createResultReviewAction(
            currentInput as never,
            currentResult,
            {
              ...context,
              currentAnswerText,
            },
          );
          if (!reviewAction) {
            if (options.suppressModelDelivery) {
              return { toolResult: currentResult };
            }
            return {
              toolResult: currentResult,
              delivery: await buildToolDelivery(
                currentResult,
                deliveryCallId,
                toolDefinition,
              ),
            };
          }

          const { resolution } = await requestActionResolution(reviewAction);
          const reviewOutcome = await toolDefinition.resolveResultReview(
            currentInput as never,
            currentResult,
            resolution,
            {
              ...context,
              currentAnswerText,
            },
          );

          if (reviewOutcome.kind === "deliver") {
            return options.suppressModelDelivery
              ? { toolResult: currentResult }
              : {
                  toolResult: currentResult,
                  delivery: await buildToolDelivery(
                    currentResult,
                    deliveryCallId,
                    toolDefinition,
                    reviewOutcome.toolMessageContent,
                    reviewOutcome.followupMessages || [],
                  ),
                };
          }

          if (reviewOutcome.kind === "stop") {
            return {
              toolResult: currentResult,
              stopRun: true,
              finalText: reviewOutcome.finalText,
            };
          }

          const chainedCall = buildSyntheticToolCall(
            reviewOutcome.call.name,
            reviewOutcome.call.arguments,
          );
          const chainedOutcome = await executeToolWorkflow(chainedCall, round, {
            modelCallId: deliveryCallId,
            suppressModelDelivery: Boolean(reviewOutcome.terminalText),
            inheritedApproval: reviewOutcome.call.inheritedApproval,
          });
          if (reviewOutcome.terminalText) {
            const finalText = chainedOutcome.toolResult.ok
              ? reviewOutcome.terminalText.onSuccess
              : isUserDeniedToolResult(chainedOutcome.toolResult)
                ? reviewOutcome.terminalText.onDenied
                : reviewOutcome.terminalText.onError;
            return {
              toolResult: chainedOutcome.toolResult,
              stopRun: true,
              finalText,
            };
          }
          return chainedOutcome;
        }
      }

      if (options.suppressModelDelivery) {
        return { toolResult };
      }
      return {
        toolResult,
        delivery: await buildToolDelivery(
          toolResult,
          deliveryCallId,
          toolDefinition,
        ),
      };
    };
    for (let round = 1; round <= maxRounds; round += 1) {
      const { step, stepStreamedText } = await runModelStep(
        round,
        round === 1 ? "Running agent" : `Continuing agent (${round}/${maxRounds})`,
      );
      if (step.kind === "final") {
        return emitFinalStep(step, stepStreamedText);
      }

      // The step returned tool_calls, not a final answer.  Any text the
      // model streamed during this step is intermediate "thinking" text
      // (e.g. "Let me read more of the paper...") that should appear in
      // the agent trace but NOT in the final chat answer.  Roll it back.
      if (stepStreamedText) {
        currentAnswerText = currentAnswerText.slice(
          0,
          Math.max(0, currentAnswerText.length - stepStreamedText.length),
        );
        await emit({
          type: "message_rollback",
          length: stepStreamedText.length,
          text: stepStreamedText,
        });
      }

      const calls = step.calls.slice(0, maxToolCallsPerRound);
      messages.push({
        ...step.assistantMessage,
        tool_calls: Array.isArray(step.assistantMessage.tool_calls)
          ? step.assistantMessage.tool_calls.slice(0, maxToolCallsPerRound)
          : step.assistantMessage.tool_calls,
      });
      if (!calls.length) break;
      for (const call of calls) {
        const outcome = await executeToolWorkflow(call, round, {
          modelCallId: call.id,
        });
        if (outcome.delivery) {
          messages.push({
            role: "tool",
            tool_call_id: outcome.delivery.callId,
            name: outcome.delivery.name,
            content: JSON.stringify(outcome.delivery.content ?? {}, null, 2),
          });
          for (const followupMessage of outcome.delivery.followupMessages) {
            messages.push(followupMessage);
          }
        }
        if (outcome.stopRun) {
          return completeRun(outcome.finalText || currentAnswerText, "completed");
        }
        if (consecutiveToolErrors >= 2) {
          const finalText =
            currentAnswerText ||
            "Agent stopped after repeated tool errors. Please adjust the request and try again.";
          return completeRun(finalText, "failed");
        }
      }
    }

    const finalText =
      currentAnswerText ||
      "Agent stopped before reaching a final answer. Try narrowing the request.";
    return completeRun(finalText, "failed");
  }
}
