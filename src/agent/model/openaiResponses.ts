import {
  buildReasoningPayload,
  postWithReasoningFallback,
  resolveRequestAuthState,
  uploadFilesForResponses,
  type ChatFileAttachment,
} from "../../utils/llmClient";
import { normalizeMaxTokens, normalizeTemperature } from "../../utils/normalization";
import { resolveProviderTransportEndpoint } from "../../utils/providerTransport";
import { resolveProviderCapabilities } from "../../providers";
import {
  buildPdfPartForResponses,
  shouldUploadPdfBeforeRequest,
} from "../../providers/pdfTransport";
import type {
  AgentModelCapabilities,
  AgentModelContentPart,
  AgentModelStep,
  AgentRuntimeRequest,
} from "../types";
import type { AgentModelAdapter, AgentStepParams } from "./adapter";
import { readFileRefAsBase64 } from "./shared";
import {
  buildResponsesContinuationInput,
  buildResponsesInitialInput,
  limitNormalizedResponsesStep,
  type ResponsesPayload,
  normalizeResponsesStepFromPayload,
  parseResponsesStepStream,
} from "./responsesShared";
import { buildResponsesFunctionTools, getToolContinuationMessages } from "./shared";

function isPdfFilePart(
  part: Extract<AgentModelContentPart, { type: "file_ref" }>,
): boolean {
  const mimeType = (part.file_ref.mimeType || "").trim().toLowerCase();
  const name = (part.file_ref.name || "").trim().toLowerCase();
  return mimeType === "application/pdf" || name.endsWith(".pdf");
}

async function resolveFilePart(
  part: Extract<AgentModelContentPart, { type: "file_ref" }>,
  request: AgentRuntimeRequest,
  signal?: AbortSignal,
) {
  const requestLike = {
    model: request.model || "",
    protocol: "responses_api" as const,
    authMode: request.authMode,
    apiBase: request.apiBase,
  };
  if (shouldUploadPdfBeforeRequest(requestLike)) {
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
    return buildPdfPartForResponses({
      request: requestLike,
      filename: part.file_ref.name,
      fileIds,
    });
  }
  if (!isPdfFilePart(part)) {
    return [
      {
        type: "input_text" as const,
        text: `[Attached file: ${part.file_ref.name}]`,
      },
    ];
  }
  const base64 = await readFileRefAsBase64(part.file_ref.storedPath);
  return buildPdfPartForResponses({
    request: requestLike,
    filename: part.file_ref.name,
    dataUrl: `data:${part.file_ref.mimeType || "application/pdf"};base64,${base64}`,
  });
}

export class OpenAIResponsesAgentAdapter implements AgentModelAdapter {
  private conversationItems: unknown[] | null = null;

  getCapabilities(request: AgentRuntimeRequest): AgentModelCapabilities {
    const capabilities = resolveProviderCapabilities({
      model: request.model || "",
      protocol: "responses_api",
      authMode: request.authMode,
      apiBase: request.apiBase,
    });
    return {
      streaming: true,
      toolCalls: true,
      multimodal: capabilities.multimodal,
      fileInputs: capabilities.fileInputs,
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
        resolveFilePart(part, request, signal),
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
              resolveFilePart(part, request, signal),
            signal: params.signal,
          },
        )
      : [];
    if (this.conversationItems && followupInput.length) {
      this.conversationItems.push(...followupInput);
    }
    const inputItems = this.conversationItems || initialInput.input;
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
        );
        return {
          model: request.model,
          instructions,
          input: inputItems,
          include: ["reasoning.encrypted_content"],
          tools: buildResponsesFunctionTools(params.tools),
          tool_choice: "auto",
          store: false,
          stream: true,
          max_output_tokens: normalizeMaxTokens(request.advanced?.maxTokens),
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
    inputItems.push(...normalized.outputItems);
    this.conversationItems = inputItems;
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
