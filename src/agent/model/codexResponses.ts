import {
  buildReasoningPayload,
  postWithReasoningFallback,
  resolveRequestAuthState,
} from "../../utils/llmClient";
import { normalizeTemperature } from "../../utils/normalization";
import { resolveProviderTransportEndpoint } from "../../utils/providerTransport";
import { resolveProviderCapabilities } from "../../providers";
import type {
  AgentModelCapabilities,
  AgentRuntimeRequest,
  AgentModelStep,
} from "../types";
import type { AgentModelAdapter, AgentStepParams } from "./adapter";
import { isMultimodalRequestSupported } from "./messageBuilder";
import {
  buildResponsesContinuationInput,
  buildResponsesInitialInput,
  limitNormalizedResponsesStep,
  type ResponsesPayload,
  normalizeResponsesStepFromPayload,
  parseResponsesStepStream,
} from "./responsesShared";
import { buildResponsesFunctionTools, getToolContinuationMessages } from "./shared";

function isCodexAuthRequest(request: AgentRuntimeRequest): boolean {
  return (
    request.authMode === "codex_auth" ||
    /chatgpt\.com\/backend-api\/codex\/responses/i.test(
      (request.apiBase || "").trim(),
    )
  );
}

export {
  limitNormalizedResponsesStep,
  normalizeResponsesStepFromPayload as normalizeStepFromPayload,
  parseResponsesStepStream,
} from "./responsesShared";

export class CodexResponsesAgentAdapter implements AgentModelAdapter {
  private conversationItems: unknown[] | null = null;

  getCapabilities(request: AgentRuntimeRequest): AgentModelCapabilities {
    const capabilities = resolveProviderCapabilities({
      model: request.model || "",
      protocol: "codex_responses",
      authMode: request.authMode,
      apiBase: request.apiBase,
    });
    return {
      streaming: true,
      toolCalls: isCodexAuthRequest(request),
      multimodal: capabilities.multimodal,
      fileInputs: capabilities.fileInputs,
      reasoning: true,
    };
  }

  supportsTools(request: AgentRuntimeRequest): boolean {
    return this.getCapabilities(request).toolCalls;
  }

  async runStep(params: AgentStepParams): Promise<AgentModelStep> {
    const request = params.request;
    const auth = await resolveRequestAuthState({
      authMode: request.authMode || "api_key",
      apiKey: request.apiKey || "",
      signal: params.signal,
    });
    const initialInput = await buildResponsesInitialInput(params.messages, {
      resolveFilePart: async (part) => [
        {
          type: "input_text" as const,
          text: `[Prepared file: ${part.file_ref.name}]`,
        },
      ],
      signal: params.signal,
    });
    const instructions =
      initialInput.instructions?.trim() ||
      "You are the agent runtime inside a Zotero plugin.";
    const followupInput = this.conversationItems
      ? await buildResponsesContinuationInput(
          getToolContinuationMessages(params.messages),
          {
            resolveFilePart: async (part) => [
              {
                type: "input_text" as const,
                text: `[Prepared file: ${part.file_ref.name}]`,
              },
            ],
            signal: params.signal,
          },
        )
      : [];
    if (this.conversationItems && followupInput.length) {
      this.conversationItems.push(...followupInput);
    }
    const inputItems = this.conversationItems || initialInput.input;
    const url = resolveProviderTransportEndpoint({
      protocol: "codex_responses",
      apiBase: request.apiBase || "",
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
