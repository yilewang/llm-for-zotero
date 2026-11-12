import {
  buildReasoningPayload,
  buildPromptCachePayloadHints,
  postWithReasoningFallback,
  resolveRequestAuthState,
} from "../../utils/llmClient";
import { normalizeTemperature } from "../../utils/normalization";
import { resolveProviderTransportEndpoint } from "../../utils/providerTransport";
import type {
  AgentModelCapabilities,
  AgentRuntimeRequest,
  AgentModelStep,
} from "../types";
import type { AgentModelAdapter, AgentStepParams } from "./adapter";
import { buildAgentModelCapabilities } from "./contentCapabilities";
import {
  buildAgentRecoveryInstruction,
  resolveAgentRecoverableCompletion,
  type AgentRecoverableCompletionReason,
} from "./completion";
import { resolveRequestContentInputs } from "./messageBuilder";
import {
  buildResponsesContinuationInput,
  buildResponsesInitialInput,
  type ResponsesPayload,
  normalizeResponsesStepFromPayload,
  parseResponsesStepStream,
  replayableResponsesOutputItems,
  withoutTrailingReasoningItems,
} from "./responsesShared";
import { buildResponsesFunctionTools } from "./shared";
import { CODEX_DIRECT_RESPONSES_URL } from "../../codexAuth/auth";
import {
  assertCodexDirectModelAvailable,
  sanitizeCodexDirectReasoningConfig,
} from "../../codexAuth/modelCatalog";

function isCodexAuthRequest(request: AgentRuntimeRequest): boolean {
  return (
    request.authMode === "codex_auth" ||
    /chatgpt\.com\/backend-api\/codex\/responses/i.test(
      (request.apiBase || "").trim(),
    )
  );
}

export {
  normalizeResponsesStepFromPayload as normalizeStepFromPayload,
  parseResponsesStepStream,
} from "./responsesShared";

export class CodexResponsesAgentAdapter implements AgentModelAdapter {
  private conversationItems: unknown[] | null = null;

  getCapabilities(request: AgentRuntimeRequest): AgentModelCapabilities {
    return buildAgentModelCapabilities({
      streaming: true,
      toolCalls: isCodexAuthRequest(request),
      contentInputs: resolveRequestContentInputs(request),
      fileInputs: false,
      reasoning: true,
    });
  }

  supportsTools(request: AgentRuntimeRequest): boolean {
    return this.getCapabilities(request).toolCalls;
  }

  resetState(): void {
    this.conversationItems = null;
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
          params.continuationMessages || [],
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
    const inputItems = this.conversationItems
      ? [...this.conversationItems, ...followupInput]
      : initialInput.input;
    const isCodexDirect = request.authMode === "codex_auth";
    if (isCodexDirect) {
      assertCodexDirectModelAvailable(request.model || "");
    }
    const url = isCodexDirect
      ? CODEX_DIRECT_RESPONSES_URL
      : resolveProviderTransportEndpoint({
          protocol: "codex_responses",
          apiBase: request.apiBase || "",
        });
    const initialReasoning = isCodexDirect
      ? sanitizeCodexDirectReasoningConfig(
          request.model || "",
          request.reasoning,
        )
      : request.reasoning;
    const response = await postWithReasoningFallback({
      url,
      scope: { conversationKey: request.conversationKey },
      auth,
      modelName: request.model,
      initialReasoning,
      buildPayload: (reasoningOverride) => {
        const reasoningPayload = buildReasoningPayload(
          isCodexDirect
            ? sanitizeCodexDirectReasoningConfig(
                request.model || "",
                reasoningOverride,
              )
            : reasoningOverride,
          true,
          request.model,
          request.apiBase,
          "codex_responses",
          isCodexDirect
            ? undefined
            : { profileOverride: request.advanced?.profileOverride },
        );
        return {
          model: request.model,
          instructions,
          input: inputItems,
          ...buildPromptCachePayloadHints(request.contextCache),
          include: ["reasoning.encrypted_content"],
          tools: buildResponsesFunctionTools(params.tools),
          tool_choice: params.toolChoice === "none" ? "none" : "auto",
          store: false,
          stream: true,
          ...reasoningPayload.extra,
          ...(isCodexDirect || reasoningPayload.omitTemperature
            ? {}
            : {
                temperature: normalizeTemperature(
                  request.advanced?.temperature,
                ),
              }),
        };
      },
      signal: params.signal,
    });
    const normalized = response.body
      ? await parseResponsesStepStream(
          response.body,
          params.onTextDelta,
          params.onReasoning,
          params.onUsage,
        )
      : normalizeResponsesStepFromPayload(
          (await response.json()) as ResponsesPayload,
        );

    // The provider reports a reply it cut off mid-stream as incomplete with
    // reason "interrupted": a broken stream to ask again, not a block.
    const interrupted =
      normalized.completion.status === "blocked" &&
      normalized.completion.providerReason?.trim().toLowerCase() ===
        "interrupted";
    const recoveryReason: AgentRecoverableCompletionReason | null = interrupted
      ? "stream_interrupted"
      : resolveAgentRecoverableCompletion(normalized.completion);
    if (recoveryReason === "stream_interrupted") {
      // The broken step is discarded whole, as the recovery instruction says.
      this.conversationItems = [...inputItems];
      return {
        kind: "incomplete",
        reason: recoveryReason,
        providerReason: normalized.completion.providerReason,
        text: "",
        recoveryInstruction: buildAgentRecoveryInstruction(
          recoveryReason,
          "tool call",
        ),
        assistantMessage: { role: "assistant", content: "" },
      };
    }
    if (recoveryReason) {
      // A reasoning item must not end the replayed items: the recovery
      // message would follow it, and the provider rejects that request.
      this.conversationItems = [
        ...inputItems,
        ...withoutTrailingReasoningItems(
          normalized.outputItems.filter((item) => {
            if (!item || typeof item !== "object") return true;
            const type = String(
              (item as { type?: unknown }).type ?? "",
            ).toLowerCase();
            return type !== "function_call" && type !== "tool_call";
          }),
        ),
      ];
      return {
        kind: "incomplete",
        reason: recoveryReason,
        providerReason: normalized.completion.providerReason,
        text: normalized.text,
        recoveryInstruction: buildAgentRecoveryInstruction(
          recoveryReason,
          "tool call",
        ),
        assistantMessage: {
          role: "assistant",
          content: normalized.text,
        },
      };
    }
    this.conversationItems = [
      ...inputItems,
      ...replayableResponsesOutputItems(normalized),
    ];

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
