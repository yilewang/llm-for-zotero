import { usesMaxCompletionTokens } from "../../utils/apiHelpers";
import {
  buildReasoningPayload,
  postWithReasoningFallback,
  resolveRequestAuthState,
} from "../../utils/llmClient";
import { normalizeMaxTokens, normalizeTemperature } from "../../utils/normalization";
import { resolveProviderTransportEndpoint } from "../../utils/providerTransport";
import type {
  AgentModelCapabilities,
  AgentModelMessage,
  AgentModelStep,
  AgentRuntimeRequest,
  AgentToolCall,
} from "../types";
import type { AgentModelAdapter, AgentStepParams } from "./adapter";
import { isMultimodalRequestSupported } from "./messageBuilder";
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

function isToolCapableApiBase(request: AgentRuntimeRequest): boolean {
  const apiBase = (request.apiBase || "").trim();
  if (!apiBase) return false;
  if (request.authMode === "codex_auth") return false;
  return true;
}

async function buildMessagesPayload(messages: AgentModelMessage[]) {
  const result = [];
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
      const resolved = await resolveContentParts(message);
      const parts: unknown[] = [];
      for (const rp of resolved) {
        switch (rp.type) {
          case "text": parts.push({ type: "text", text: rp.text }); break;
          case "image": parts.push({ type: "image_url", image_url: { url: `data:${rp.mimeType};base64,${rp.base64}` } }); break;
          case "pdf": parts.push({ type: "image_url", image_url: { url: `data:application/pdf;base64,${rp.base64}` } }); break;
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
  onReasoning?: (event: { summary?: string; details?: string }) => void | Promise<void>,
): Promise<{ text: string; toolCalls: AgentToolCall[]; reasoningText: string }> {
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  let reasoningText = "";
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
          const rDelta =
            delta.reasoning_content ??
            delta.reasoning ??
            delta.thinking ??
            delta.thought ??
            "";
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
                  id:
                    tc.id?.trim() || createFallbackToolCallId("tool", idx),
                  name: tc.function?.name?.trim() || "",
                  argumentChunks: [],
                });
              }
              const entry = toolCallMap.get(idx)!;
              if (tc.id?.trim()) entry.id = tc.id.trim();
              if (tc.function?.name?.trim()) entry.name = tc.function.name.trim();
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

  return { text: fullText, toolCalls, reasoningText };
}

function isStreamingResponse(response: Response): boolean {
  const ct = (response.headers.get("content-type") || "").toLowerCase();
  return ct.includes("text/event-stream") || ct.includes("octet-stream");
}

export class OpenAIChatCompatAgentAdapter implements AgentModelAdapter {
  getCapabilities(request: AgentRuntimeRequest): AgentModelCapabilities {
    return {
      streaming: true,
      toolCalls: isToolCapableApiBase(request),
      multimodal: isMultimodalRequestSupported(request),
      fileInputs: false,
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
    const url = resolveProviderTransportEndpoint({
      protocol: "openai_chat_compat",
      apiBase: request.apiBase || "",
      authMode: request.authMode,
    });
    const resolvedMessages = await buildMessagesPayload(params.messages);
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
        );
        return {
          model: request.model,
          messages: resolvedMessages,
          tools: buildOpenAIFunctionTools(params.tools),
          tool_choice: "auto",
          stream: true,
          ...(usesMaxCompletionTokens(request.model || "")
            ? {
                max_completion_tokens: normalizeMaxTokens(
                  request.advanced?.maxTokens,
                ),
              }
            : {
                max_tokens: normalizeMaxTokens(request.advanced?.maxTokens),
              }),
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
      );
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
    const data = (await response.json()) as { choices?: ChatCompletionChoice[] };
    const message = data.choices?.[0]?.message;
    const reasoningText =
      message?.reasoning_content ||
      message?.reasoning ||
      message?.thinking ||
      "";
    if (reasoningText && params.onReasoning) {
      await params.onReasoning({ details: reasoningText });
    }
    const toolCalls = normalizeToolCalls(message?.tool_calls);
    if (toolCalls.length) {
      return {
        kind: "tool_calls",
        calls: toolCalls,
        assistantMessage: {
          role: "assistant",
          content: typeof message?.content === "string" ? message.content : "",
          tool_calls: toolCalls,
        },
      };
    }
    return {
      kind: "final",
      text: typeof message?.content === "string" ? message.content : "",
      assistantMessage: {
        role: "assistant",
        content: typeof message?.content === "string" ? message.content : "",
      },
    };
  }
}

export { OpenAIChatCompatAgentAdapter as OpenAICompatibleAgentAdapter };
