/**
 * Agent adapter for Ollama's native `/api/chat` endpoint.
 *
 * The wire handling lives in `llmClient.ts` and is shared with chat mode —
 * `buildOllamaChatPayload` assembles the envelope (options merge, num_ctx,
 * num_predict) and `parseOllamaChatStream` walks the NDJSON stream — so a
 * fix to either applies to both modes at once. This adapter contributes only
 * what is agent-specific:
 *
 *  - Message conversion carrying tool results (correlated by `tool_name`
 *    rather than a server-issued `tool_call_id`) and `thinking` echoes.
 *  - Tool-call collection: `tool_calls[].function.arguments` is already a
 *    JSON object rather than a JSON string, and each call arrives complete in
 *    one chunk.
 *  - Tool support gating from the live catalog: `/api/show` states plainly
 *    whether the loaded weights support tool calling, and sending tools to a
 *    model without it is a hard 400 — the graceful no-tools fallback needs
 *    the truth up front.
 */

import {
  buildOllamaChatPayload,
  buildReasoningPayload,
  parseOllamaChatStream,
  normalizeMaxTokensForRequest,
  postWithReasoningFallback,
  resolveOllamaNumCtx,
  resolveOllamaNumPredict,
  resolveRequestAuthState,
} from "../../utils/llmClient";
import { normalizeTemperature } from "../../utils/normalization";
import { resolveContextWindowTokens } from "../../utils/modelInputCap";
import { resolveProviderTransportEndpoint } from "../../utils/providerTransport";
import { getModelCapabilities } from "../../modelCapabilities";
import type {
  AgentModelCapabilities,
  AgentModelMessage,
  AgentModelStep,
  AgentRuntimeRequest,
  AgentToolCall,
} from "../types";
import type { AgentModelAdapter, AgentStepParams } from "./adapter";
import { buildAgentModelCapabilities } from "./contentCapabilities";
import { resolveRequestContentInputs } from "./messageBuilder";
import {
  buildOpenAIFunctionTools,
  createFallbackToolCallId,
  parseToolCallArguments,
} from "./shared";
import { resolveContentParts } from "./adapterUtils";

type OllamaRequestMessage = {
  role: string;
  content: string;
  images?: string[];
  thinking?: string;
  tool_name?: string;
  tool_calls?: Array<{
    function: { name: string; arguments: unknown };
  }>;
};

async function buildMessagesPayload(
  messages: AgentModelMessage[],
): Promise<OllamaRequestMessage[]> {
  const result: OllamaRequestMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      // Ollama correlates tool results by name, not by a call id.
      result.push({
        role: "tool",
        content: message.content,
        tool_name: message.name,
      });
      continue;
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      result.push({
        role: "assistant",
        content:
          typeof message.content === "string"
            ? message.content
            : await flattenToText(message),
        tool_calls: message.tool_calls.map((call) => ({
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      continue;
    }
    if (typeof message.content === "string") {
      result.push({ role: message.role, content: message.content });
      continue;
    }
    const resolved = await resolveContentParts(message);
    const textParts: string[] = [];
    const images: string[] = [];
    for (const part of resolved) {
      if (part.type === "text") {
        textParts.push(part.text);
        continue;
      }
      if (part.type === "image") {
        if (part.mimeType.trim().toLowerCase() === "application/pdf") {
          throw new Error(
            "Ollama chat cannot send PDF content as an image. Render the PDF to page images first.",
          );
        }
        // Ollama takes bare base64, not a data: URL and not a content part.
        images.push(part.base64);
        continue;
      }
      throw new Error(
        "Ollama chat cannot send unresolved file_ref attachments. Render them to page images first.",
      );
    }
    result.push({
      role: message.role,
      content: textParts.join("\n"),
      ...(images.length ? { images } : {}),
    });
  }
  return result;
}

async function flattenToText(message: AgentModelMessage): Promise<string> {
  const resolved = await resolveContentParts(message);
  return resolved
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Thin agent-facing wrapper over the shared NDJSON parser: collects the raw
 * tool calls into `AgentToolCall`s and accumulates the reasoning text the
 * assistant echo needs.
 */
export async function parseOllamaChatCompletionStream(
  body: ReadableStream<Uint8Array>,
  onTextDelta?: (delta: string) => void | Promise<void>,
  onReasoning?: (event: {
    summary?: string;
    details?: string;
  }) => void | Promise<void>,
  onUsage?: AgentStepParams["onUsage"],
): Promise<{
  text: string;
  toolCalls: AgentToolCall[];
  reasoningText: string;
}> {
  const toolCalls: AgentToolCall[] = [];
  let reasoningText = "";
  const text = await parseOllamaChatStream(
    body,
    async (delta) => {
      if (onTextDelta) await onTextDelta(delta);
    },
    async (event) => {
      if (event.details) reasoningText += event.details;
      if (onReasoning) await onReasoning(event);
    },
    onUsage,
    (call) => {
      toolCalls.push({
        id: createFallbackToolCallId("ollama-tool", toolCalls.length),
        name: call.name,
        arguments: parseToolCallArguments(call.arguments),
      });
    },
  );
  return { text, toolCalls, reasoningText };
}

/**
 * Whether the loaded weights support tool calling, from the live catalog.
 * Unknown (no catalog data) stays optimistic — the runtime's no-tools
 * fallback is for models the server has *stated* cannot take tools.
 */
function resolveOllamaToolSupport(request: AgentRuntimeRequest): boolean {
  return (
    getModelCapabilities({
      model: request.model || "",
      apiBase: request.apiBase,
      protocol: "ollama_native",
      authMode: request.authMode,
      profileOverride: request.advanced?.profileOverride,
    }).features.tools !== false
  );
}

export class OllamaNativeAgentAdapter implements AgentModelAdapter {
  private conversationMessages: OllamaRequestMessage[] | null = null;

  getCapabilities(request: AgentRuntimeRequest): AgentModelCapabilities {
    return buildAgentModelCapabilities({
      streaming: true,
      toolCalls: resolveOllamaToolSupport(request),
      contentInputs: resolveRequestContentInputs(request),
      fileInputs: false,
      reasoning: true,
    });
  }

  supportsTools(request: AgentRuntimeRequest): boolean {
    return this.getCapabilities(request).toolCalls;
  }

  resetState(): void {
    this.conversationMessages = null;
  }

  async runStep(params: AgentStepParams): Promise<AgentModelStep> {
    const request = params.request;
    const auth = await resolveRequestAuthState({
      authMode: request.authMode || "api_key",
      apiKey: request.apiKey || "",
      signal: params.signal,
    });
    const url = resolveProviderTransportEndpoint({
      protocol: "ollama_native",
      apiBase: request.apiBase || "",
      authMode: request.authMode,
    });
    const resolvedMessages = this.conversationMessages
      ? [
          ...this.conversationMessages,
          ...(await buildMessagesPayload(params.continuationMessages || [])),
        ]
      : await buildMessagesPayload(params.messages);
    const tools = buildOpenAIFunctionTools(params.tools);
    // Same sizing as chat mode: allocate the context window the prompt was
    // trimmed against (Ollama's own default is far below the trained maximum
    // and truncates silently), and honour an explicit output cap while
    // leaving the untouched plugin default unlimited so a thinking model
    // cannot burn the whole budget on thought.
    const effectiveMaxTokens = normalizeMaxTokensForRequest({
      value: request.advanced?.maxTokens,
      maxTokensExplicit: request.advanced?.maxTokensExplicit,
      model: request.model || "",
      apiBase: request.apiBase,
      protocol: "ollama_native",
      authMode: request.authMode,
      profileOverride: request.advanced?.profileOverride,
    });
    const numCtx = resolveOllamaNumCtx(
      "ollama_native",
      resolveContextWindowTokens(
        request.model || "",
        request.advanced?.inputTokenCap,
        {
          apiBase: request.apiBase,
          protocol: "ollama_native",
          authMode: request.authMode,
          profileOverride: request.advanced?.profileOverride,
        },
      ),
    );
    const response = await postWithReasoningFallback({
      url,
      auth,
      modelName: request.model,
      initialReasoning: request.reasoning,
      buildPayload: (reasoningOverride) => {
        const reasoningPayload = buildReasoningPayload(
          reasoningOverride,
          false,
          request.model,
          request.apiBase,
          "ollama_native",
          { profileOverride: request.advanced?.profileOverride },
        );
        return buildOllamaChatPayload({
          model: request.model || "",
          messages: resolvedMessages,
          messagesAreConverted: true,
          stream: true,
          ...(reasoningPayload.omitTemperature
            ? {}
            : {
                temperature: normalizeTemperature(
                  request.advanced?.temperature,
                ),
              }),
          numPredict: resolveOllamaNumPredict(
            effectiveMaxTokens,
            request.advanced?.maxTokensExplicit === true,
          ),
          numCtx,
          tools,
          reasoningExtra: reasoningPayload.extra,
        });
      },
      signal: params.signal,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `${response.status} ${response.statusText} - ${errorText}`,
      );
    }
    if (!response.body) {
      throw new Error("Ollama returned an empty response body.");
    }

    const result = await parseOllamaChatCompletionStream(
      response.body,
      params.onTextDelta,
      params.onReasoning,
      params.onUsage,
    );

    this.conversationMessages = [
      ...resolvedMessages,
      {
        role: "assistant",
        content: result.text,
        ...(result.reasoningText.trim()
          ? { thinking: result.reasoningText.trim() }
          : {}),
        ...(result.toolCalls.length
          ? {
              tool_calls: result.toolCalls.map((call) => ({
                function: {
                  name: call.name,
                  arguments: call.arguments,
                },
              })),
            }
          : {}),
      },
    ];

    if (result.toolCalls.length) {
      return {
        kind: "tool_calls",
        calls: result.toolCalls,
        assistantMessage: {
          role: "assistant",
          content: result.text,
          tool_calls: result.toolCalls,
        },
      };
    }
    return {
      kind: "final",
      text: result.text,
      assistantMessage: {
        role: "assistant",
        content: result.text,
      },
    };
  }
}
