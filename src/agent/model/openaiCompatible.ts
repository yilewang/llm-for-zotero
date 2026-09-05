import { usesMaxCompletionTokens } from "../../utils/apiHelpers";
import {
  buildReasoningPayload,
  buildPromptCachePayloadHints,
  normalizeMaxTokensForRequest,
  postWithReasoningFallback,
  resolveRequestAuthState,
} from "../../utils/llmClient";
import { normalizeTemperature } from "../../utils/normalization";
import { resolveProviderTransportEndpoint } from "../../utils/providerTransport";
import { extractContextCacheUsage } from "../../contextCache/manager";
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

type ChatCompletionChoice = {
  message?: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    thinking?: string | null;
    tool_calls?: Array<{
      id?: string;
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  };
};

type OpenAIChatRequestMessage = {
  role: AgentModelMessage["role"];
  content: string | unknown[];
  reasoning_content?: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

function isDeepseekChatModel(modelName?: string): boolean {
  const normalized = (modelName || "").trim().toLowerCase();
  if (!normalized) return false;
  const tail = normalized.split("/").pop() || "";
  const candidates =
    tail && tail !== normalized ? [normalized, tail] : [normalized];
  return candidates.some((candidate) => /^deepseek(?:$|[-.])/.test(candidate));
}

function buildReasoningContentForContinuation(
  modelName: string | undefined,
  reasoningText: string,
  reasoningContentText = reasoningText,
): { reasoning_content?: string } {
  const textToEcho = isDeepseekChatModel(modelName)
    ? reasoningText
    : reasoningContentText;
  const trimmed = textToEcho.trim();
  return trimmed ? { reasoning_content: trimmed } : {};
}

function isToolCapableApiBase(request: AgentRuntimeRequest): boolean {
  const apiBase = (request.apiBase || "").trim();
  if (!apiBase) return false;
  if (request.authMode === "codex_auth") return false;
  return true;
}

function hasPdfFileRef(message: AgentModelMessage): boolean {
  if (typeof message.content === "string") return false;
  return message.content.some(
    (part) =>
      part.type === "file_ref" &&
      part.file_ref.mimeType.trim().toLowerCase() === "application/pdf",
  );
}

async function buildMessagesPayload(
  messages: AgentModelMessage[],
): Promise<OpenAIChatRequestMessage[]> {
  const result: OpenAIChatRequestMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      result.push({
        role: "tool",
        content: message.content,
        tool_call_id: message.tool_call_id,
        name: message.name,
      });
      continue;
    }
    let content: string | unknown[];
    if (typeof message.content === "string") {
      content = message.content;
    } else {
      if (hasPdfFileRef(message)) {
        throw new Error(
          "OpenAI-compatible chat cannot send unresolved PDF file_ref attachments. Render the PDF to page images or use a native PDF provider.",
        );
      }
      const resolved = await resolveContentParts(message);
      const parts: unknown[] = [];
      for (const rp of resolved) {
        switch (rp.type) {
          case "text":
            parts.push({ type: "text", text: rp.text });
            break;
          case "image":
            if (rp.mimeType.trim().toLowerCase() === "application/pdf") {
              throw new Error(
                "OpenAI-compatible chat cannot send PDF content as image_url.",
              );
            }
            parts.push({
              type: "image_url",
              image_url: {
                url: `data:${rp.mimeType};base64,${rp.base64}`,
                ...(rp.detail ? { detail: rp.detail } : {}),
              },
            });
            break;
          case "pdf":
            throw new Error(
              "OpenAI-compatible chat cannot send PDF content as image_url.",
            );
          // file_placeholder: silently dropped (no provider support)
        }
      }
      content = parts;
    }
    result.push({
      role: message.role,
      content,
      ...(message.role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length
        ? {
            tool_calls: message.tool_calls.map((call: AgentToolCall) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments ?? {}),
              },
            })),
          }
        : {}),
    });
  }
  return result;
}

function buildNativeAssistantMessage(params: {
  modelName?: string;
  text: string;
  reasoningText: string;
  reasoningContentText: string;
  toolCalls: AgentToolCall[];
}): OpenAIChatRequestMessage {
  return {
    role: "assistant",
    content: params.text,
    ...buildReasoningContentForContinuation(
      params.modelName,
      params.reasoningText,
      params.reasoningContentText,
    ),
    ...(params.toolCalls.length
      ? {
          tool_calls: params.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments ?? {}),
            },
          })),
        }
      : {}),
  };
}

function normalizeToolCalls(
  toolCalls:
    | Array<{
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>
    | undefined,
): AgentToolCall[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .map((call, index) => {
      const name = call?.function?.name?.trim();
      if (!name) return null;
      return {
        id: call?.id?.trim() || createFallbackToolCallId("tool", index),
        name,
        arguments: parseToolCallArguments(call?.function?.arguments),
      };
    })
    .filter((call): call is AgentToolCall => Boolean(call));
}

type StreamedToolCallAccumulator = {
  id: string;
  name: string;
  argumentChunks: string[];
};

async function parseOpenAIChatCompletionStream(
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
  reasoningContentText: string;
}> {
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  let reasoningText = "";
  let reasoningContentText = "";
  const toolCallMap = new Map<number, StreamedToolCallAccumulator>();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          if (parsed?.usage && onUsage) {
            const promptTokens =
              typeof parsed.usage.prompt_tokens === "number"
                ? parsed.usage.prompt_tokens
                : 0;
            const completionTokens =
              typeof parsed.usage.completion_tokens === "number"
                ? parsed.usage.completion_tokens
                : 0;
            const totalTokens =
              typeof parsed.usage.total_tokens === "number"
                ? parsed.usage.total_tokens
                : promptTokens + completionTokens;
            if (totalTokens > 0) {
              await onUsage({
                promptTokens,
                completionTokens,
                totalTokens,
                ...extractContextCacheUsage(parsed.usage),
                contextTokens: promptTokens,
                contextWindowIsAuthoritative: promptTokens > 0,
              });
            }
          }
          const choice = parsed?.choices?.[0];
          const delta = choice?.delta;
          if (!delta) continue;

          // Text content
          const textDelta =
            typeof delta.content === "string" ? delta.content : "";
          if (textDelta) {
            fullText += textDelta;
            if (onTextDelta) await onTextDelta(textDelta);
          }

          // Reasoning (various provider field names)
          const reasoningContentDelta =
            typeof delta.reasoning_content === "string"
              ? delta.reasoning_content
              : "";
          const rDelta =
            reasoningContentDelta ||
            delta.reasoning ||
            delta.thinking ||
            delta.thought ||
            "";
          if (reasoningContentDelta) {
            reasoningContentText += reasoningContentDelta;
          }
          if (typeof rDelta === "string" && rDelta) {
            reasoningText += rDelta;
            if (onReasoning) await onReasoning({ details: rDelta });
          }

          // Streamed tool calls
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx =
                typeof tc.index === "number" ? tc.index : toolCallMap.size;
              if (!toolCallMap.has(idx)) {
                toolCallMap.set(idx, {
                  id: tc.id?.trim() || createFallbackToolCallId("tool", idx),
                  name: tc.function?.name?.trim() || "",
                  argumentChunks: [],
                });
              }
              const entry = toolCallMap.get(idx)!;
              if (tc.id?.trim()) entry.id = tc.id.trim();
              if (tc.function?.name?.trim())
                entry.name = tc.function.name.trim();
              if (typeof tc.function?.arguments === "string") {
                entry.argumentChunks.push(tc.function.arguments);
              }
            }
          }
        } catch (err) {
          ztoolkit.log("LLM: Malformed SSE line in OpenAI stream", err);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const toolCalls: AgentToolCall[] = [];
  for (const [, entry] of toolCallMap) {
    if (!entry.name) continue;
    toolCalls.push({
      id: entry.id,
      name: entry.name,
      arguments: parseToolCallArguments(entry.argumentChunks.join("")),
    });
  }

  return { text: fullText, toolCalls, reasoningText, reasoningContentText };
}

function isStreamingResponse(response: Response): boolean {
  const ct = (response.headers.get("content-type") || "").toLowerCase();
  return ct.includes("text/event-stream") || ct.includes("octet-stream");
}

export class OpenAIChatCompatAgentAdapter implements AgentModelAdapter {
  private conversationMessages: OpenAIChatRequestMessage[] | null = null;

  getCapabilities(request: AgentRuntimeRequest): AgentModelCapabilities {
    return buildAgentModelCapabilities({
      streaming: true,
      toolCalls: isToolCapableApiBase(request),
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
      protocol: "openai_chat_compat",
      apiBase: request.apiBase || "",
      authMode: request.authMode,
    });
    const resolvedMessages = this.conversationMessages
      ? [
          ...this.conversationMessages,
          ...(await buildMessagesPayload(params.continuationMessages || [])),
        ]
      : await buildMessagesPayload(params.messages);
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
          "openai_chat_compat",
          { profileOverride: request.advanced?.profileOverride },
        );
        return {
          model: request.model,
          messages: resolvedMessages,
          ...buildPromptCachePayloadHints(request.contextCache),
          tools: buildOpenAIFunctionTools(params.tools),
          tool_choice: "auto",
          stream: true,
          stream_options: { include_usage: true },
          ...(usesMaxCompletionTokens(request.model || "")
            ? {
                max_completion_tokens: normalizeMaxTokensForRequest({
                  value: request.advanced?.maxTokens,
                  maxTokensExplicit: request.advanced?.maxTokensExplicit,
                  model: request.model || "",
                  apiBase: request.apiBase,
                  protocol: "openai_chat_compat",
                  authMode: request.authMode,
                  profileOverride: request.advanced?.profileOverride,
                }),
              }
            : {
                max_tokens: normalizeMaxTokensForRequest({
                  value: request.advanced?.maxTokens,
                  maxTokensExplicit: request.advanced?.maxTokensExplicit,
                  model: request.model || "",
                  apiBase: request.apiBase,
                  protocol: "openai_chat_compat",
                  authMode: request.authMode,
                  profileOverride: request.advanced?.profileOverride,
                }),
              }),
          ...reasoningPayload.extra,
          ...(reasoningPayload.omitTemperature
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
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    // Stream path: parse SSE and deliver text deltas progressively
    if (response.body && isStreamingResponse(response)) {
      const result = await parseOpenAIChatCompletionStream(
        response.body,
        params.onTextDelta,
        params.onReasoning,
        params.onUsage,
      );
      this.conversationMessages = [
        ...resolvedMessages,
        buildNativeAssistantMessage({
          modelName: request.model,
          text: result.text,
          reasoningText: result.reasoningText,
          reasoningContentText: result.reasoningContentText,
          toolCalls: result.toolCalls,
        }),
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

    // Fallback: non-streaming JSON response
    const data = (await response.json()) as {
      choices?: ChatCompletionChoice[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
        cached_tokens?: number;
      };
    };
    if (data.usage && params.onUsage) {
      const promptTokens = data.usage.prompt_tokens ?? 0;
      const completionTokens = data.usage.completion_tokens ?? 0;
      const totalTokens =
        data.usage.total_tokens ?? promptTokens + completionTokens;
      if (totalTokens > 0) {
        await params.onUsage({
          promptTokens,
          completionTokens,
          totalTokens,
          ...extractContextCacheUsage(data.usage),
          contextTokens: promptTokens,
          contextWindowIsAuthoritative: promptTokens > 0,
        });
      }
    }
    const message = data.choices?.[0]?.message;
    const reasoningContentText =
      typeof message?.reasoning_content === "string"
        ? message.reasoning_content
        : "";
    const reasoningText =
      reasoningContentText || message?.reasoning || message?.thinking || "";
    if (reasoningText && params.onReasoning) {
      await params.onReasoning({ details: reasoningText });
    }
    const toolCalls = normalizeToolCalls(message?.tool_calls);
    const text = typeof message?.content === "string" ? message.content : "";
    this.conversationMessages = [
      ...resolvedMessages,
      buildNativeAssistantMessage({
        modelName: request.model,
        text,
        reasoningText,
        reasoningContentText,
        toolCalls,
      }),
    ];
    if (toolCalls.length) {
      return {
        kind: "tool_calls",
        calls: toolCalls,
        assistantMessage: {
          role: "assistant",
          content: text,
          tool_calls: toolCalls,
        },
      };
    }
    return {
      kind: "final",
      text,
      assistantMessage: {
        role: "assistant",
        content: text,
      },
    };
  }
}

export { OpenAIChatCompatAgentAdapter as OpenAICompatibleAgentAdapter };
