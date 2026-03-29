import { buildReasoningPayload } from "../../utils/llmClient";
import {
  normalizeMaxTokens,
  normalizeTemperature,
} from "../../utils/normalization";
import {
  buildProviderTransportHeaders,
  resolveProviderTransportEndpoint,
} from "../../utils/providerTransport";
import { resolveProviderCapabilities } from "../../providers";
import type {
  AgentModelCapabilities,
  AgentModelMessage,
  AgentModelStep,
  AgentRuntimeRequest,
  AgentToolCall,
  ToolSpec,
} from "../types";
import type { AgentModelAdapter, AgentStepParams } from "./adapter";
import {
  isMultimodalRequestSupported,
  stringifyMessageContent,
} from "./messageBuilder";
import {
  createFallbackToolCallId,
  getFetch,
  getToolContinuationMessages,
  groupToolContinuationMessages,
} from "./shared";
import { resolveContentParts } from "./adapterUtils";

type AnthropicContentBlock = {
  type: string;
  [key: string]: unknown;
};

type AnthropicMessage = {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
};

type AnthropicResponse = {
  id?: unknown;
  content?: unknown[];
};

type AnthropicNormalizedResponse = {
  text: string;
  toolCalls: AgentToolCall[];
  responseBlocks: AnthropicContentBlock[];
};

type AnthropicStreamBlockState = {
  block: AnthropicContentBlock;
  partialJson?: string;
};

function buildAnthropicTools(tools: ToolSpec[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

function cloneAnthropicContentBlock(
  block: AnthropicContentBlock,
): AnthropicContentBlock {
  return { ...block };
}

function normalizeAnthropicContentBlock(
  value: unknown,
): AnthropicContentBlock | null {
  if (!value || typeof value !== "object") return null;
  const type =
    typeof (value as { type?: unknown }).type === "string"
      ? (value as { type: string }).type.trim()
      : "";
  if (!type) return null;
  return {
    ...(value as Record<string, unknown>),
    type,
  };
}

async function buildAnthropicParts(
  message: AgentModelMessage,
): Promise<AnthropicContentBlock[]> {
  const resolved = await resolveContentParts(message);
  return resolved.map((part): AnthropicContentBlock => {
    switch (part.type) {
      case "text": return { type: "text", text: part.text };
      case "image": return { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.base64 } };
      case "pdf": return { type: "document", source: { type: "base64", media_type: "application/pdf", data: part.base64 } };
      case "file_placeholder": return { type: "text", text: `[Prepared file: ${part.name}]` };
    }
  });
}

async function buildInitialAnthropicMessages(messages: AgentModelMessage[]): Promise<{
  system?: string;
  messages: AnthropicMessage[];
}> {
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
          ...(await buildAnthropicParts(message)),
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
      content: await buildAnthropicParts(message),
    });
  }
  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: anthropicMessages,
  };
}

async function buildAnthropicContinuationMessages(
  messages: AgentModelMessage[],
): Promise<AnthropicMessage[]> {
  const { toolMessages, followupUserMessages } =
    groupToolContinuationMessages(messages);
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
      content: await buildAnthropicParts(message),
    });
  }
  return anthropicMessages;
}

function normalizeAnthropicResponseBlocks(
  blocks: AnthropicContentBlock[],
): AnthropicNormalizedResponse {
  const textParts: string[] = [];
  const toolCalls: AgentToolCall[] = [];
  const responseBlocks = blocks.map((block) =>
    cloneAnthropicContentBlock(block),
  );
  for (let index = 0; index < responseBlocks.length; index += 1) {
    const block = responseBlocks[index];
    const typeValue = block.type.toLowerCase();
    if (typeValue === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }
    if (typeValue !== "tool_use") continue;
    const name =
      typeof block.name === "string" && block.name.trim()
        ? block.name.trim()
        : "";
    if (!name) continue;
    toolCalls.push({
      id:
        typeof block.id === "string" && block.id.trim()
          ? block.id.trim()
          : createFallbackToolCallId("anthropic-call", index),
      name,
      arguments:
        block.input && typeof block.input === "object" ? block.input : {},
    });
  }
  return {
    text: textParts.join(""),
    toolCalls,
    responseBlocks,
  };
}

function normalizeAnthropicResponse(
  data: AnthropicResponse,
): AnthropicNormalizedResponse {
  const responseBlocks = (Array.isArray(data.content) ? data.content : [])
    .map((block) => normalizeAnthropicContentBlock(block))
    .filter((block): block is AnthropicContentBlock => Boolean(block));
  return normalizeAnthropicResponseBlocks(responseBlocks);
}

async function parseAnthropicStepStream(
  stream: ReadableStream<Uint8Array>,
  onTextDelta?: (delta: string) => void | Promise<void>,
  onReasoning?: (event: {
    summary?: string;
    details?: string;
  }) => void | Promise<void>,
): Promise<AnthropicNormalizedResponse> {
  const reader = stream.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const contentBlocks = new Map<number, AnthropicStreamBlockState>();

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
      const contentBlock = normalizeAnthropicContentBlock(parsed.content_block);
      if (contentBlock) {
        const state: AnthropicStreamBlockState = { block: contentBlock };
        if (
          contentBlock.type.toLowerCase() === "tool_use" &&
          contentBlock.input &&
          typeof contentBlock.input === "object" &&
          Object.keys(contentBlock.input as Record<string, unknown>).length > 0
        ) {
          state.partialJson = JSON.stringify(contentBlock.input);
        }
        contentBlocks.set(index, state);
      }
      return;
    }
    if (eventType !== "content_block_delta") return;
    const deltaType =
      typeof parsed.delta?.type === "string"
        ? parsed.delta.type.toLowerCase()
        : "";
    if (deltaType === "text_delta" && typeof parsed.delta?.text === "string") {
      const existing = contentBlocks.get(index);
      const nextText =
        typeof existing?.block.text === "string" ? existing.block.text : "";
      contentBlocks.set(index, {
        block: {
          ...(existing?.block || { type: "text" }),
          type: existing?.block.type || "text",
          text: `${nextText}${parsed.delta.text}`,
        },
        partialJson: existing?.partialJson,
      });
      text += parsed.delta.text;
      if (onTextDelta) {
        await onTextDelta(parsed.delta.text);
      }
      return;
    }
    if (
      deltaType === "thinking_delta" &&
      index >= 0 &&
      typeof (parsed.delta as { thinking?: unknown }).thinking === "string"
    ) {
      const deltaThinking = (parsed.delta as { thinking: string }).thinking;
      const existing = contentBlocks.get(index);
      const nextThinking =
        typeof existing?.block.thinking === "string"
          ? existing.block.thinking
          : "";
      contentBlocks.set(index, {
        block: {
          ...(existing?.block || { type: "thinking" }),
          type: existing?.block.type || "thinking",
          thinking: `${nextThinking}${deltaThinking}`,
        },
        partialJson: existing?.partialJson,
      });
      if (deltaThinking && onReasoning) {
        await onReasoning({ details: deltaThinking });
      }
      return;
    }
    if (
      deltaType === "signature_delta" &&
      index >= 0 &&
      typeof (parsed.delta as { signature?: unknown }).signature === "string"
    ) {
      const deltaSignature = (parsed.delta as { signature: string }).signature;
      const existing = contentBlocks.get(index);
      const nextSignature =
        typeof existing?.block.signature === "string"
          ? existing.block.signature
          : "";
      contentBlocks.set(index, {
        block: {
          ...(existing?.block || { type: "thinking" }),
          type: existing?.block.type || "thinking",
          signature: `${nextSignature}${deltaSignature}`,
        },
        partialJson: existing?.partialJson,
      });
      return;
    }
    if (
      deltaType === "input_json_delta" &&
      index >= 0 &&
      typeof parsed.delta?.partial_json === "string"
    ) {
      const existing = contentBlocks.get(index);
      if (!existing) return;
      existing.partialJson = `${existing.partialJson || ""}${parsed.delta.partial_json}`;
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

  const responseBlocks = Array.from(contentBlocks.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([, state]) => {
      const block = cloneAnthropicContentBlock(state.block);
      if (block.type.toLowerCase() === "tool_use" && state.partialJson) {
        try {
          block.input = JSON.parse(state.partialJson);
        } catch (_error) {
          if (!(block.input && typeof block.input === "object")) {
            block.input = {};
          }
        }
      }
      return block;
    });
  const normalized = normalizeAnthropicResponseBlocks(responseBlocks);
  return {
    ...normalized,
    text: normalized.text || text,
  };
}

function buildAssistantConversationMessage(step: {
  text: string;
  toolCalls: AgentToolCall[];
  responseBlocks?: AnthropicContentBlock[];
}): AnthropicMessage {
  if (Array.isArray(step.responseBlocks) && step.responseBlocks.length) {
    return {
      role: "assistant",
      content: step.responseBlocks.map((block) =>
        cloneAnthropicContentBlock(block),
      ),
    };
  }
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
    const capabilities = resolveProviderCapabilities({
      model: request.model || "",
      protocol: "anthropic_messages",
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
    const initial = await buildInitialAnthropicMessages(params.messages);
    if (!this.conversationMessages) {
      this.conversationMessages = initial.messages;
      this.systemPrompt = initial.system;
    }
    const continuation = await buildAnthropicContinuationMessages(
      getToolContinuationMessages(params.messages),
    );
    if (continuation.length && this.conversationMessages) {
      this.conversationMessages.push(...continuation);
    }
    const messages = this.conversationMessages || initial.messages;
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
      ? await parseAnthropicStepStream(
          response.body,
          params.onTextDelta,
          params.onReasoning,
        )
      : normalizeAnthropicResponse(
          (await response.json()) as AnthropicResponse,
        );
    messages.push(buildAssistantConversationMessage(normalized));
    this.conversationMessages = messages;
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
