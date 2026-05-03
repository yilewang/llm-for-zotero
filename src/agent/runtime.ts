import { AgentToolRegistry } from "./tools/registry";
import { readAttachmentBytes } from "../modules/contextPanel/attachmentStorage";
import { encodeBytesBase64 } from "./model/shared";
import { recordAgentTurn } from "./store/conversationMemory";
import type {
  AgentInheritedApproval,
  AgentModelCapabilities,
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
import type {
  AgentAdapterToolCallResult,
  AgentAdapterToolContentItem,
} from "./model/adapter";
import { resolveAgentLimits } from "./model/limits";
import { classifyRequest } from "./model/requestClassifier";
import { buildAgentInitialMessages } from "./model/messageBuilder";
import { detectSkillIntent } from "./model/skillClassifier";
import { getAllSkills, getMatchedSkillIds } from "./skills";
import {
  getNotesDirectoryNickname,
  isNotesDirectoryConfigured,
} from "../utils/notesDirectoryConfig";
import {
  estimateContextMessagesTokens,
  resolveContextWindowTokens,
} from "../utils/modelInputCap";
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

async function toDataUrl(
  storedPath: string,
  mimeType: string,
): Promise<string> {
  const bytes = await readAttachmentBytes(storedPath);
  return `data:${mimeType};base64,${encodeBytesBase64(bytes)}`;
}

function summarizeArtifacts(artifacts: AgentToolArtifact[]): string {
  const imagePages = artifacts
    .filter(
      (artifact): artifact is Extract<AgentToolArtifact, { kind: "image" }> => {
        return artifact.kind === "image";
      },
    )
    .map(
      (artifact) =>
        artifact.pageLabel ||
        (Number.isFinite(artifact.pageIndex)
          ? `${artifact.pageIndex! + 1}`
          : ""),
    );
  const fileTitles = artifacts
    .filter(
      (
        artifact,
      ): artifact is Extract<AgentToolArtifact, { kind: "file_ref" }> => {
        return artifact.kind === "file_ref";
      },
    )
    .map((artifact) => artifact.title || artifact.name);
  const parts: string[] = [];
  if (imagePages.length) {
    parts.push(
      `Prepared PDF page image${imagePages.length === 1 ? "" : "s"} (${
        imagePages
          .filter(Boolean)
          .map((entry) => `p${entry}`)
          .join(", ") ||
        `${imagePages.length} page${imagePages.length === 1 ? "" : "s"}`
      }) for visual inspection.`,
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

function summarizeTextOnlyArtifacts(
  artifacts: AgentToolArtifact[],
  modelName?: string,
): string {
  const imageCount = artifacts.filter(
    (artifact) => artifact.kind === "image",
  ).length;
  const fileCount = artifacts.filter(
    (artifact) => artifact.kind === "file_ref",
  ).length;
  return summarizeTextOnlyOmittedParts(imageCount, fileCount, modelName);
}

function summarizeTextOnlyOmittedParts(
  imageCount: number,
  fileCount: number,
  modelName?: string,
): string {
  const omitted: string[] = [];
  if (imageCount) {
    omitted.push(`${imageCount} image${imageCount === 1 ? "" : "s"}`);
  }
  if (fileCount) {
    omitted.push(`${fileCount} file${fileCount === 1 ? "" : "s"}`);
  }
  const target = (modelName || "The selected model").trim();
  const omittedLabel = omitted.length ? omitted.join(" and ") : "artifacts";
  return (
    `${omittedLabel} prepared by the tool were not attached because ${target} does not support image or file input. ` +
    "Use the tool result text, MinerU manifest/full.md content, captions, and surrounding extracted text instead. " +
    "If direct visual inspection is required, say that a vision-capable model is needed."
  );
}

async function buildArtifactFollowupMessage(
  result: AgentToolResult,
  options: { multimodal?: boolean; modelName?: string } = {},
): Promise<AgentModelMessage | null> {
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  if (!artifacts.length || !result.ok) return null;
  if (options.multimodal === false) {
    return {
      role: "user",
      content: summarizeTextOnlyArtifacts(artifacts, options.modelName),
    };
  }
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
        ztoolkit.log(
          "LLM Agent: Failed to load image artifact",
          artifact,
          error,
        );
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

function filterFollowupMessageForCapabilities(
  message: AgentModelMessage | null,
  capabilities: AgentModelCapabilities,
  modelName?: string,
): AgentModelMessage | null {
  if (!message || capabilities.multimodal) return message;
  if (typeof message.content === "string") return message;

  const textParts: string[] = [];
  let omittedImages = 0;
  let omittedFiles = 0;
  for (const part of message.content) {
    if (part.type === "text") {
      if (part.text.trim()) textParts.push(part.text);
      continue;
    }
    if (part.type === "image_url") {
      omittedImages += 1;
      continue;
    }
    omittedFiles += 1;
  }

  if (omittedImages || omittedFiles) {
    textParts.push(
      summarizeTextOnlyOmittedParts(omittedImages, omittedFiles, modelName),
    );
  }
  return {
    ...message,
    content: textParts.filter(Boolean).join("\n\n"),
  };
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

function stringifyToolDeliveryContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === null || content === undefined) {
    return "";
  }
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function pushAdapterTextItem(
  target: AgentAdapterToolContentItem[],
  text: string,
): void {
  if (!text) return;
  target.push({ type: "inputText", text });
}

function pushAdapterMessageItems(
  target: AgentAdapterToolContentItem[],
  message: AgentModelMessage,
): void {
  if (typeof message.content === "string") {
    pushAdapterTextItem(target, message.content);
    return;
  }
  for (const part of message.content) {
    if (part.type === "text") {
      pushAdapterTextItem(target, part.text);
      continue;
    }
    if (part.type === "image_url") {
      target.push({
        type: "inputImage",
        imageUrl: part.image_url.url,
      });
      continue;
    }
    pushAdapterTextItem(target, `[Prepared file: ${part.file_ref.name}]`);
  }
}

function buildAdapterToolCallResult(
  outcome: ToolWorkflowOutcome,
): AgentAdapterToolCallResult {
  const contentItems: AgentAdapterToolContentItem[] = [];
  if (outcome.delivery) {
    pushAdapterTextItem(
      contentItems,
      stringifyToolDeliveryContent(outcome.delivery.content),
    );
    for (const followupMessage of outcome.delivery.followupMessages) {
      pushAdapterMessageItems(contentItems, followupMessage);
    }
  } else if (outcome.finalText) {
    pushAdapterTextItem(contentItems, outcome.finalText);
  } else {
    pushAdapterTextItem(
      contentItems,
      stringifyToolDeliveryContent(outcome.toolResult.content),
    );
  }
  if (!contentItems.length) {
    pushAdapterTextItem(
      contentItems,
      outcome.toolResult.ok ? "Tool completed successfully." : "Tool failed.",
    );
  }
  return {
    contentItems,
    success: outcome.toolResult.ok,
  };
}

type ExecutedToolCall = {
  toolResult: AgentToolResult;
  toolDefinition?: import("./types").AgentToolDefinition<any, any>;
  input?: unknown;
};

function buildSyntheticToolCall(name: string, args: unknown): AgentToolCall {
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

function isWriteNoteFileRequest(
  request: AgentRuntimeRequest,
  matchedSkills: ReadonlyArray<string>,
): boolean {
  const activeSkillIds = new Set([
    ...matchedSkills,
    ...(request.forcedSkillIds || []),
  ]);
  if (!activeSkillIds.has("write-note")) return false;
  const text = request.userText || "";
  if (/\b(zotero\s+note|current\s+zotero\s+note|active\s+note)\b/i.test(text)) {
    return false;
  }
  return /\b(obsidian|vault|markdown\s+file|md\s+file|file|folder|directory|disk|export|save|write\s+(?:it|this|that)?\s*(?:to|into))\b/i.test(
    text,
  );
}

function isSuccessfulFileIoWrite(record: {
  name: string;
  ok: boolean;
  input?: unknown;
}): boolean {
  if (record.name !== "file_io" || !record.ok) return false;
  if (!record.input || typeof record.input !== "object") return false;
  return (record.input as { action?: unknown }).action === "write";
}

export class AgentRuntime {
  private readonly registry: AgentToolRegistry;
  private readonly adapterFactory: AgentRuntimeDeps["adapterFactory"];
  private readonly now: () => number;
  private readonly pendingConfirmations = new Map<
    string,
    PendingConfirmation
  >();

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
    const adapterCapabilities = adapter.getCapabilities(request);
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
      const reason =
        "Agent tools unavailable for this model; used direct response instead.";
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
    const toolExecutionRecords: Array<{
      name: string;
      ok: boolean;
      input?: unknown;
    }> = [];
    // Intent/skill selection runs ONCE per user turn, before the system
    // prompt is built. The flow:
    //   1. detectSkillIntent — one LLM call against the primary model,
    //      returns which skills the user's message is asking for. Falls
    //      back to regex `match:` patterns on any error.
    //   2. getMatchedSkillIds — unions classifier output with explicit
    //      forcedSkillIds (slash menu) and runtime-context forces
    //      (e.g. notes-directory nickname mention).
    //   3. matchedSkills is threaded into buildAgentInitialMessages so
    //      only those skills' instructions ship in the system prompt,
    //      and emitted as trace events for UI visibility.
    // The resulting system prompt is reused across every model inference
    // inside the agent loop — no per-step classification cost.
    const classifiedSkillIds = await detectSkillIntent(request, getAllSkills());
    const matchedSkills = getMatchedSkillIds(request, classifiedSkillIds);
    const messages = (await buildAgentInitialMessages(
      request,
      this.registry.listToolDefinitionsForRequest(request),
      matchedSkills,
    )) as AgentModelMessage[];

    for (const skillId of matchedSkills) {
      await emit({ type: "status", text: `Skill activated: ${skillId}` });
    }

    let consecutiveToolErrors = 0;
    const intent = classifyRequest(request);
    const { maxRounds, maxToolCallsPerRound } = resolveAgentLimits(
      intent.isBulkOperation,
    );
    const requiresFileNoteWrite = isWriteNoteFileRequest(
      request,
      matchedSkills,
    );
    let noteWriteCorrectionUsed = false;
    const hasSuccessfulFileWrite = () =>
      toolExecutionRecords.some((record) => isSuccessfulFileIoWrite(record));
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
      const returnedText = step.text || "";
      const streamedTextOffset = stepStreamedText
        ? returnedText.indexOf(stepStreamedText)
        : -1;
      const finalText = stepStreamedText
        ? streamedTextOffset >= 0
          ? returnedText.slice(streamedTextOffset)
          : stepStreamedText
        : returnedText || currentAnswerText || "No response.";
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
      const rollbackStepStreamedText = async () => {
        await flushStepDelta();
        if (!stepStreamedText) return;
        currentAnswerText = currentAnswerText.slice(
          0,
          Math.max(0, currentAnswerText.length - stepStreamedText.length),
        );
        await emit({
          type: "message_rollback",
          length: stepStreamedText.length,
          text: stepStreamedText,
        });
        stepStreamedText = "";
        stepPendingDelta = "";
      };
      const stepContextWindow = resolveContextWindowTokens(
        request.model || "",
        request.advanced?.inputTokenCap,
      );
      const stepContextTokens = estimateContextMessagesTokens(messages);
      if (stepContextTokens > 0 && stepContextWindow > 0) {
        await emit({
          type: "usage",
          round,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          contextTokens: stepContextTokens,
          contextWindow: stepContextWindow,
        });
      }
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
            stepId: reasoning.stepId,
            stepLabel: reasoning.stepLabel,
            summary: reasoning.summary,
            details: reasoning.details,
          });
        },
        onUsage: async (usage) => {
          const usageRecord = usage as unknown as Record<string, unknown>;
          const totalTokens = Math.max(0, usage.totalTokens || 0);
          const promptTokens = Math.max(0, usage.promptTokens || 0);
          const completionTokens = Math.max(0, usage.completionTokens || 0);
          const contextTokens =
            typeof usageRecord.contextTokens === "number" &&
            Number.isFinite(usageRecord.contextTokens)
              ? Math.max(0, usageRecord.contextTokens)
              : undefined;
          const contextWindow =
            typeof usageRecord.contextWindow === "number" &&
            Number.isFinite(usageRecord.contextWindow)
              ? Math.max(0, usageRecord.contextWindow)
              : typeof contextTokens === "number" && contextTokens > 0
                ? stepContextWindow
                : undefined;
          const contextWindowIsAuthoritative =
            usageRecord.contextWindowIsAuthoritative === true;
          const percentage =
            typeof usageRecord.percentage === "number" &&
            Number.isFinite(usageRecord.percentage)
              ? Math.max(0, Math.min(100, usageRecord.percentage))
              : undefined;
          const sessionId =
            typeof usageRecord.sessionId === "string" &&
            usageRecord.sessionId.trim()
              ? usageRecord.sessionId.trim()
              : undefined;
          const model =
            typeof usageRecord.model === "string" && usageRecord.model.trim()
              ? usageRecord.model.trim()
              : undefined;
          if (
            totalTokens <= 0 &&
            promptTokens <= 0 &&
            completionTokens <= 0 &&
            !(typeof contextTokens === "number" && contextTokens > 0) &&
            !(typeof contextWindow === "number" && contextWindow > 0)
          ) {
            return;
          }
          await emit({
            type: "usage",
            round,
            promptTokens,
            completionTokens,
            totalTokens,
            ...(typeof contextTokens === "number" ? { contextTokens } : {}),
            ...(typeof contextWindow === "number" ? { contextWindow } : {}),
            ...(contextWindowIsAuthoritative
              ? { contextWindowIsAuthoritative: true }
              : {}),
            ...(typeof percentage === "number" ? { percentage } : {}),
            ...(sessionId ? { sessionId } : {}),
            ...(model ? { model } : {}),
          });
        },
        onToolCall: async (call) => {
          await rollbackStepStreamedText();
          const outcome = await executeToolWorkflow(call, round, {
            modelCallId: call.id,
          });
          return buildAdapterToolCallResult(outcome);
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
    ): Promise<{
      requestId: string;
      resolution: AgentConfirmationResolution;
    }> => {
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
      const execution = await this.registry.prepareExecution(
        call,
        {
          ...context,
          currentAnswerText,
        },
        {
          inheritedApproval: options.inheritedApproval,
        },
      );
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
      toolExecutionRecords.push({
        name: toolResult.name,
        ok: toolResult.ok,
        input: executedCall.input,
      });
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
        : await buildArtifactFollowupMessage(toolResult, {
            multimodal: adapterCapabilities.multimodal,
            modelName: request.model,
          });
      const filteredFollowupMessage = filterFollowupMessageForCapabilities(
        followupMessage,
        adapterCapabilities,
        request.model,
      );
      const followupMessages = extraFollowupMessages
        .map((message) =>
          filterFollowupMessageForCapabilities(
            message,
            adapterCapabilities,
            request.model,
          ),
        )
        .filter((message): message is AgentModelMessage => Boolean(message));
      if (filteredFollowupMessage) {
        followupMessages.push(filteredFollowupMessage);
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
    const rollbackCommittedStreamedText = async (
      stepStreamedText: string,
    ): Promise<void> => {
      if (!stepStreamedText) return;
      currentAnswerText = currentAnswerText.slice(
        0,
        Math.max(0, currentAnswerText.length - stepStreamedText.length),
      );
      await emit({
        type: "message_rollback",
        length: stepStreamedText.length,
        text: stepStreamedText,
      });
    };
    for (let round = 1; round <= maxRounds; round += 1) {
      const { step, stepStreamedText } = await runModelStep(
        round,
        round === 1
          ? "Running agent"
          : `Continuing agent (${round}/${maxRounds})`,
      );
      if (step.kind === "final") {
        if (
          requiresFileNoteWrite &&
          !hasSuccessfulFileWrite() &&
          isNotesDirectoryConfigured()
        ) {
          await rollbackCommittedStreamedText(stepStreamedText);
          if (!noteWriteCorrectionUsed) {
            noteWriteCorrectionUsed = true;
            messages.push(
              step.assistantMessage ?? {
                role: "assistant",
                content: stepStreamedText,
              },
            );
            messages.push({
              role: "user",
              content:
                'Correction for this turn: the user\'s request requires writing a Markdown note to the configured notes directory. Call `file_io` with `action: "write"` now, using the configured notes directory/default target path and a clear `.md` filename. Do not put the note body in chat. If a write is impossible, explain the setup problem briefly.',
            });
            continue;
          }
          const nickname = getNotesDirectoryNickname().trim();
          const targetLabel = nickname ? `${nickname} note` : "note";
          return completeRun(
            `I could not complete the ${targetLabel} write because the model did not call \`file_io(write, ...)\` after being corrected.`,
            "failed",
          );
        }
        return emitFinalStep(step, stepStreamedText);
      }

      // The step returned tool_calls, not a final answer.  Any text the
      // model streamed during this step is intermediate "thinking" text
      // (e.g. "Let me read more of the paper...") that should appear in
      // the agent trace but NOT in the final chat answer.  Roll it back.
      await rollbackCommittedStreamedText(stepStreamedText);

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
          return completeRun(
            outcome.finalText || currentAnswerText,
            "completed",
          );
        }
        if (consecutiveToolErrors >= 3) {
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
