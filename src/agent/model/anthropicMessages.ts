import { buildReasoningPayload } from "../../utils/llmClient";
import { normalizeMaxTokens, normalizeTemperature } from "../../utils/normalization";
import {
  buildProviderTransportHeaders,
  resolveProviderTransportEndpoint,
} from "../../utils/providerTransport";
import type {
  AgentModelCapabilities,
  AgentModelMessage,
  AgentModelStep,
  AgentRuntimeRequest,
  AgentToolCall,
  ToolSpec,
} from "../types";
import type { AgentModelAdapter, AgentStepParams } from "./adapter";
import { isMultimodalRequestSupported, stringifyMessageContent } from "./messageBuilder";
import {
  createFallbackToolCallId,
  getFetch,
  getToolContinuationMessages,
  groupToolContinuationMessages,
  parseDataUrl,
} from "./shared";

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
};

type AnthropicResponse = {
  id?: unknown;
  content?: Array<{
    type?: unknown;
    text?: unknown;
    id?: unknown;
    name?: unknown;
    input?: unknown;
  }>;
};

function buildAnthropicTools(tools: ToolSpec[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

function buildAnthropicParts(message: AgentModelMessage): AnthropicContentBlock[] {
  if (typeof message.content === "string") {
    return [{ type: "text", text: message.content }];
  }
  const blocks: AnthropicContentBlock[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url") {
      const parsed = parseDataUrl(part.image_url.url);
      if (parsed) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: parsed.mimeType,
            data: parsed.data,
          },
        });
      } else {
        blocks.push({ type: "text", text: "[image]" });
      }
      continue;
    }
    blocks.push({
      type: "text",
      text: `[Prepared file: ${part.file_ref.name}]`,
    });
  }
  return blocks.length ? blocks : [{ type: "text", text: "" }];
}

function buildInitialAnthropicMessages(
  messages: AgentModelMessage[],
): { system?: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const anthropicMessages: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") continue;
    if (message.role === "system") {
      const text = stringifyMessageContent(message.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (message.role === "assistant") {
      anthropicMessages.push({
        role: "assistant",
        content: [
          ...buildAnthropicParts(message),
          ...(Array.isArray(message.tool_calls)
            ? message.tool_calls.map((call) => ({
                type: "tool_use" as const,
                id: call.id,
                name: call.name,
                input: call.arguments ?? {},
              }))
            : []),
        ],
      });
      continue;
    }
    anthropicMessages.push({
      role: "user",
      content: buildAnthropicParts(message),
    });
  }
  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: anthropicMessages,
  };
}

function buildAnthropicContinuationMessages(
  messages: AgentModelMessage[],
): AnthropicMessage[] {
  const { toolMessages, followupUserMessages } = groupToolContinuationMessages(
    messages,
  );
  const anthropicMessages: AnthropicMessage[] = [];
  if (toolMessages.length) {
    anthropicMessages.push({
      role: "user",
      content: toolMessages.map((message) => ({
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: message.content,
      })),
    });
  }
  for (const message of followupUserMessages) {
    anthropicMessages.push({
      role: "user",
      content: buildAnthropicParts(message),
    });
  }
  return anthropicMessages;
}

function normalizeAnthropicResponse(data: AnthropicResponse): {
  text: string;
  toolCalls: AgentToolCall[];
} {
  const toolCalls: AgentToolCall[] = [];
  const textParts: string[] = [];
  const content = Array.isArray(data.content) ? data.content : [];
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    if (!block || typeof block !== "object") continue;
    const typeValue =
      typeof block.type === "string" ? block.type.toLowerCase() : "";
    if (typeValue === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }
    if (typeValue !== "tool_use") continue;
    const name =
      typeof block.name === "string" && block.name.trim() ? block.name.trim() : "";
    if (!name) continue;
    toolCalls.push({
      id:
        typeof block.id === "string" && block.id.trim()
          ? block.id.trim()
          : createFallbackToolCallId("anthropic-call", index),
      name,
      arguments: block.input && typeof block.input === "object" ? block.input : {},
    });
  }
  return {
    text: textParts.join(""),
    toolCalls,
  };
}

async function parseAnthropicStepStream(
  stream: ReadableStream<Uint8Array>,
  onTextDelta?: (delta: string) => void | Promise<void>,
): Promise<{ text: string; toolCalls: AgentToolCall[] }> {
  const reader = stream.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const toolBlocks = new Map<
    number,
    {
      id: string;
      name: string;
      partialJson: string;
      input?: unknown;
    }
  >();

  const handleFrame = async (payload: string) => {
    if (!payload || payload === "[DONE]") return;
    const parsed = JSON.parse(payload) as {
      type?: unknown;
      index?: unknown;
      content_block?: {
        type?: unknown;
        id?: unknown;
        name?: unknown;
        input?: unknown;
      };
      delta?: {
        type?: unknown;
        text?: unknown;
        partial_json?: unknown;
      };
    };
    const eventType =
      typeof parsed.type === "string" ? parsed.type.toLowerCase() : "";
    const index =
      typeof parsed.index === "number" && Number.isFinite(parsed.index)
        ? parsed.index
        : -1;
    if (eventType === "content_block_start" && index >= 0) {
      const contentBlock = parsed.content_block;
      const blockType =
        typeof contentBlock?.type === "string"
          ? contentBlock.type.toLowerCase()
          : "";
      if (blockType === "tool_use") {
        toolBlocks.set(index, {
          id:
            typeof contentBlock?.id === "string" && contentBlock.id.trim()
              ? contentBlock.id.trim()
              : createFallbackToolCallId("anthropic-call", index),
          name:
            typeof contentBlock?.name === "string" ? contentBlock.name.trim() : "",
          partialJson:
            contentBlock?.input && typeof contentBlock.input === "object"
              ? JSON.stringify(contentBlock.input)
              : "",
          input: contentBlock?.input,
        });
      }
      return;
    }
    if (eventType !== "content_block_delta") return;
    const deltaType =
      typeof parsed.delta?.type === "string" ? parsed.delta.type.toLowerCase() : "";
    if (deltaType === "text_delta" && typeof parsed.delta?.text === "string") {
      text += parsed.delta.text;
      if (onTextDelta) {
        await onTextDelta(parsed.delta.text);
      }
      return;
    }
    if (
      deltaType === "input_json_delta" &&
      index >= 0 &&
      typeof parsed.delta?.partial_json === "string"
    ) {
      const existing = toolBlocks.get(index);
      if (existing) {
        existing.partialJson += parsed.delta.partial_json;
      }
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const marker = buffer.indexOf("\n\n");
        if (marker < 0) break;
        const frame = buffer.slice(0, marker);
        buffer = buffer.slice(marker + 2);
        const lines = frame.split(/\r?\n/);
        const dataLines = lines
          .map((line) => line.trim())
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (!dataLines.length) continue;
        await handleFrame(dataLines.join("\n"));
      }
    }
  } finally {
    reader.releaseLock();
  }

  const toolCalls: AgentToolCall[] = Array.from(toolBlocks.values())
    .filter((block) => block.name)
    .map((block, index) => ({
      id: block.id || createFallbackToolCallId("anthropic-call", index),
      name: block.name,
      arguments: block.partialJson
        ? (() => {
            try {
              return JSON.parse(block.partialJson);
            } catch (_error) {
              return block.input && typeof block.input === "object"
                ? block.input
                : {};
            }
          })()
        : block.input && typeof block.input === "object"
          ? block.input
          : {},
    }));
  return { text, toolCalls };
}

function buildAssistantConversationMessage(step: {
  text: string;
  toolCalls: AgentToolCall[];
}): AnthropicMessage {
  return {
    role: "assistant",
    content: [
      ...(step.text ? [{ type: "text" as const, text: step.text }] : []),
      ...step.toolCalls.map((call) => ({
        type: "tool_use" as const,
        id: call.id,
        name: call.name,
        input: call.arguments ?? {},
      })),
    ],
  };
}

export class AnthropicMessagesAgentAdapter implements AgentModelAdapter {
  private conversationMessages: AnthropicMessage[] | null = null;
  private systemPrompt: string | undefined;

  getCapabilities(request: AgentRuntimeRequest): AgentModelCapabilities {
    return {
      streaming: true,
      toolCalls: true,
      multimodal: isMultimodalRequestSupported(request),
      fileInputs: false,
      reasoning: true,
    };
  }

  supportsTools(_request: AgentRuntimeRequest): boolean {
    return true;
  }

  async runStep(params: AgentStepParams): Promise<AgentModelStep> {
    const request = params.request;
    const initial = buildInitialAnthropicMessages(params.messages);
    if (!this.conversationMessages) {
      this.conversationMessages = initial.messages;
      this.systemPrompt = initial.system;
    }
    const continuation = buildAnthropicContinuationMessages(
      getToolContinuationMessages(params.messages),
    );
    const messages =
      continuation.length && this.conversationMessages
        ? [...this.conversationMessages, ...continuation]
        : this.conversationMessages || initial.messages;
    const reasoningPayload = buildReasoningPayload(
      request.reasoning,
      false,
      request.model,
      request.apiBase,
    );
    // Anthropic requires temperature === 1 when extended thinking is enabled.
    // Any other value causes a 400 "temperature may only be set to 1" error.
    const thinkingEnabled =
      reasoningPayload.extra.thinking != null &&
      typeof reasoningPayload.extra.thinking === "object" &&
      (reasoningPayload.extra.thinking as { type?: string }).type === "enabled";
    const effectiveTemperature = thinkingEnabled
      ? 1
      : normalizeTemperature(request.advanced?.temperature);
    const payload = {
      model: request.model,
      max_tokens: normalizeMaxTokens(request.advanced?.maxTokens),
      messages,
      system: this.systemPrompt,
      tools: buildAnthropicTools(params.tools),
      tool_choice: { type: "auto" },
      stream: true,
      ...reasoningPayload.extra,
      ...(reasoningPayload.omitTemperature
        ? {}
        : { temperature: effectiveTemperature }),
    };
    const url = resolveProviderTransportEndpoint({
      protocol: "anthropic_messages",
      apiBase: request.apiBase || "",
    });
    const response = await getFetch()(url, {
      method: "POST",
      headers: buildProviderTransportHeaders({
        protocol: "anthropic_messages",
        apiKey: request.apiKey || "",
      }),
      body: JSON.stringify(payload),
      signal: params.signal,
    });
    if (!response.ok) {
      throw new Error(
        `${response.status} ${response.statusText} - ${await response.text()}`,
      );
    }
    const normalized = response.body
      ? await parseAnthropicStepStream(response.body, params.onTextDelta)
      : normalizeAnthropicResponse((await response.json()) as AnthropicResponse);
    this.conversationMessages = [
      ...messages,
      buildAssistantConversationMessage(normalized),
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
