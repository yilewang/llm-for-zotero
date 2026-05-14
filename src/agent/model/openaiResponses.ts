import {
  buildReasoningPayload,
  buildPromptCachePayloadHints,
  postWithReasoningFallback,
  resolveRequestAuthState,
  uploadFilesForResponses,
  type ChatFileAttachment,
} from "../../utils/llmClient";
import {
  normalizeMaxTokensForModel,
  normalizeTemperature,
} from "../../utils/normalization";
import { resolveProviderTransportEndpoint } from "../../utils/providerTransport";
import type {
  AgentModelCapabilities,
  AgentModelContentPart,
  AgentModelStep,
  AgentRuntimeRequest,
} from "../types";
import type { AgentModelAdapter, AgentStepParams } from "./adapter";
import {
  buildResponsesContinuationInput,
  buildResponsesInitialInput,
  limitNormalizedResponsesStep,
  type ResponsesPayload,
  normalizeResponsesStepFromPayload,
  parseResponsesStepStream,
} from "./responsesShared";
import { buildResponsesFunctionTools, getToolContinuationMessages } from "./shared";

async function uploadFilePart(
  part: Extract<AgentModelContentPart, { type: "file_ref" }>,
  request: AgentRuntimeRequest,
  signal?: AbortSignal,
) {
  const fileIds = await uploadFilesForResponses({
    apiBase: request.apiBase || "",
    apiKey: request.apiKey || "",
    attachments: [
      {
        name: part.file_ref.name,
        mimeType: part.file_ref.mimeType,
        storedPath: part.file_ref.storedPath,
        contentHash: part.file_ref.contentHash,
      } satisfies ChatFileAttachment,
    ],
    signal,
  });
  return fileIds.map((fileId) => ({
    type: "input_file" as const,
    file_id: fileId,
  }));
}

export class OpenAIResponsesAgentAdapter implements AgentModelAdapter {
  private conversationItems: unknown[] | null = null;

  getCapabilities(_request: AgentRuntimeRequest): AgentModelCapabilities {
    return {
      streaming: true,
      toolCalls: true,
      multimodal: true,
      fileInputs: true,
      reasoning: true,
    };
  }

  supportsTools(_request: AgentRuntimeRequest): boolean {
    return true;
  }

  async runStep(params: AgentStepParams): Promise<AgentModelStep> {
    const request = params.request;
    const auth = await resolveRequestAuthState({
      authMode: request.authMode || "api_key",
      apiKey: request.apiKey || "",
      signal: params.signal,
    });
    const initialInput = await buildResponsesInitialInput(params.messages, {
      resolveFilePart: async (part, signal) =>
        uploadFilePart(part, request, signal),
      signal: params.signal,
    });
    const instructions =
      initialInput.instructions?.trim() ||
      "You are the agent runtime inside a Zotero plugin.";
    const followupInput = this.conversationItems
      ? await buildResponsesContinuationInput(
          getToolContinuationMessages(params.messages),
          {
            resolveFilePart: async (part, signal) =>
              uploadFilePart(part, request, signal),
            signal: params.signal,
          },
        )
      : [];
    const inputItems = this.conversationItems
      ? [...this.conversationItems, ...followupInput]
      : initialInput.input;
    const url = resolveProviderTransportEndpoint({
      protocol: "responses_api",
      apiBase: request.apiBase || "",
      authMode: request.authMode,
    });
    const response = await postWithReasoningFallback({
      url,
      auth,
      modelName: request.model,
      initialReasoning: request.reasoning,
      buildPayload: (reasoningOverride) => {
        const reasoningPayload = buildReasoningPayload(
          reasoningOverride,
          true,
          request.model,
          request.apiBase,
          "responses_api",
        );
        return {
          model: request.model,
          instructions,
          input: inputItems,
          ...buildPromptCachePayloadHints(request.contextCache),
          include: ["reasoning.encrypted_content"],
          tools: buildResponsesFunctionTools(params.tools),
          tool_choice: "auto",
          store: false,
          stream: true,
          max_output_tokens: normalizeMaxTokensForModel(
            request.advanced?.maxTokens,
            request.model,
          ),
          ...reasoningPayload.extra,
          ...(reasoningPayload.omitTemperature
            ? {}
            : {
                temperature: normalizeTemperature(request.advanced?.temperature),
              }),
        };
      },
      signal: params.signal,
    });
    const normalized = limitNormalizedResponsesStep(
      response.body
        ? await parseResponsesStepStream(
            response.body,
            params.onTextDelta,
            params.onReasoning,
          )
        : normalizeResponsesStepFromPayload(
            (await response.json()) as ResponsesPayload,
          ),
    );
    this.conversationItems = [...inputItems, ...normalized.outputItems];
    if (normalized.toolCalls.length) {
      return {
        kind: "tool_calls",
        calls: normalized.toolCalls,
        assistantMessage: {
          role: "assistant",
          content: normalized.text,
          tool_calls: normalized.toolCalls,
        },
      };
    }
    return {
      kind: "final",
      text: normalized.text,
      assistantMessage: {
        role: "assistant",
        content: normalized.text,
      },
    };
  }
}
