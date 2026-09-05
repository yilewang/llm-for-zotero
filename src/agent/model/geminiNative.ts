import {
  getGeminiReasoningProfile,
  resolveUserExtraBody,
} from "../../utils/llmClient";
import {
  compileReasoningControls,
  isRecord,
  normalizeProfileOverride,
  getModelCapabilities,
} from "../../modelCapabilities";
import { resolveGeminiTemperature } from "../../utils/normalization";
import { normalizeMaxTokensForRequest } from "../../utils/llmClient";
import { withGeminiThoughtSummaries } from "../../utils/reasoningProfiles";
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
import { buildAgentModelCapabilities } from "./contentCapabilities";
import {
  resolveRequestContentInputs,
  stringifyMessageContent,
} from "./messageBuilder";
import {
  createFallbackToolCallId,
  getFetch,
  groupToolContinuationMessages,
} from "./shared";
import { resolveContentParts } from "./adapterUtils";

type GeminiPart = Record<string, unknown>;

type GeminiMessage = {
  role: "user" | "model";
  parts: GeminiPart[];
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
  }>;
};

function chooseGeminiSchemaType(typeValue: unknown): string | null {
  const normalize = (value: string): string | null => {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "object" ||
      normalized === "array" ||
      normalized === "string" ||
      normalized === "number" ||
      normalized === "integer" ||
      normalized === "boolean"
    ) {
      return normalized;
    }
    return null;
  };
  if (typeof typeValue === "string") {
    return normalize(typeValue);
  }
  if (!Array.isArray(typeValue)) {
    return null;
  }
  const candidates = typeValue
    .map((entry) => (typeof entry === "string" ? normalize(entry) : null))
    .filter((entry): entry is string => Boolean(entry) && entry !== "null");
  const priority = [
    "array",
    "object",
    "string",
    "integer",
    "number",
    "boolean",
  ];
  for (const preferred of priority) {
    if (candidates.includes(preferred)) {
      return preferred;
    }
  }
  return candidates[0] || null;
}

function chooseGeminiSchemaTypeFromSchemas(
  schemas: Array<Record<string, unknown>>,
): string | null {
  const candidates = schemas
    .map((entry) => chooseGeminiSchemaType(entry.type))
    .filter((entry): entry is string => Boolean(entry));
  const priority = [
    "array",
    "object",
    "string",
    "integer",
    "number",
    "boolean",
  ];
  for (const preferred of priority) {
    if (candidates.includes(preferred)) {
      return preferred;
    }
  }
  return candidates[0] || null;
}

function collectGeminiUnionVariants(
  schema: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return ["anyOf", "oneOf", "allOf"]
    .flatMap((key) => {
      const value = schema[key];
      return Array.isArray(value) ? value : [];
    })
    .filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
    );
}

function sanitizeGeminiSchema(
  schema: unknown,
  options?: { topLevel?: boolean },
): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "string" };
  }
  const rawSchema = schema as Record<string, unknown>;
  const unionVariants = collectGeminiUnionVariants(rawSchema);
  const resolvedType =
    chooseGeminiSchemaType(rawSchema.type) ||
    chooseGeminiSchemaTypeFromSchemas(unionVariants) ||
    (rawSchema.enum ? "string" : null) ||
    "string";
  const sanitized: Record<string, unknown> = {
    type: resolvedType,
  };
  if (
    typeof rawSchema.description === "string" &&
    rawSchema.description.trim()
  ) {
    sanitized.description = rawSchema.description.trim();
  }
  if (Array.isArray(rawSchema.enum)) {
    const values = rawSchema.enum.filter(
      (entry): entry is string | number =>
        typeof entry === "string" || typeof entry === "number",
    );
    if (values.length) {
      sanitized.enum = values;
    }
  }
  if (resolvedType === "array") {
    const rawItems =
      rawSchema.items && !Array.isArray(rawSchema.items)
        ? rawSchema.items
        : unionVariants
            .map((entry) =>
              entry.items && !Array.isArray(entry.items) ? entry.items : null,
            )
            .find(Boolean);
    sanitized.items = sanitizeGeminiSchema(rawItems || { type: "string" });
    return sanitized;
  }
  if (resolvedType === "object") {
    const rawProperties =
      rawSchema.properties &&
      typeof rawSchema.properties === "object" &&
      !Array.isArray(rawSchema.properties)
        ? (rawSchema.properties as Record<string, unknown>)
        : unionVariants
            .map((entry) =>
              entry.properties &&
              typeof entry.properties === "object" &&
              !Array.isArray(entry.properties)
                ? (entry.properties as Record<string, unknown>)
                : null,
            )
            .find(Boolean) || null;
    const propertyEntries = Object.entries(rawProperties || {}).map(
      ([key, value]) => [key, sanitizeGeminiSchema(value)],
    );
    if (!propertyEntries.length && !options?.topLevel) {
      return {
        type: "string",
        ...(sanitized.description
          ? { description: sanitized.description }
          : {}),
      };
    }
    sanitized.properties = Object.fromEntries(propertyEntries);
    const rawRequired = Array.isArray(rawSchema.required)
      ? rawSchema.required
      : unionVariants.flatMap((entry) =>
          Array.isArray(entry.required) ? entry.required : [],
        );
    const required = rawRequired.filter(
      (entry): entry is string =>
        typeof entry === "string" &&
        propertyEntries.some(([key]) => key === entry),
    );
    if (required.length) {
      sanitized.required = Array.from(new Set(required));
    }
    return sanitized;
  }
  return sanitized;
}

function buildGeminiTools(tools: ToolSpec[]) {
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: sanitizeGeminiSchema(tool.inputSchema, {
          topLevel: true,
        }),
      })),
    },
  ];
}

function resolveGeminiReasoningConfig(request: AgentRuntimeRequest) {
  if (!request.reasoning || request.reasoning.provider !== "gemini") {
    return undefined;
  }
  const declarative = compileReasoningControls(
    getModelCapabilities({
      provider: "gemini",
      model: request.model || "",
      apiBase: request.apiBase,
      protocol: "gemini_native",
      profileOverride: request.advanced?.profileOverride,
    }),
    request.reasoning,
  );
  const declarativeConfig =
    declarative?.extra.thinkingConfig || declarative?.extra.thinking_config;
  if (isRecord(declarativeConfig)) {
    return withGeminiThoughtSummaries(declarativeConfig);
  }
  const profile = getGeminiReasoningProfile(request.model);
  const value =
    profile.levelToValue[request.reasoning.level] ??
    profile.levelToValue[profile.defaultLevel] ??
    profile.defaultValue;
  if (profile.param === "thinking_budget") {
    return {
      includeThoughts: true,
      thinkingBudget: typeof value === "number" ? value : 8192,
    };
  }
  return {
    includeThoughts: true,
    thinkingLevel:
      value === "minimal" ||
      value === "low" ||
      value === "medium" ||
      value === "high"
        ? value
        : "medium",
  };
}

async function buildGeminiParts(
  message: AgentModelMessage,
): Promise<GeminiPart[]> {
  const resolved = await resolveContentParts(message);
  return resolved.map((part): GeminiPart => {
    switch (part.type) {
      case "text":
        return { text: part.text };
      case "image":
        return { inlineData: { mimeType: part.mimeType, data: part.base64 } };
      case "pdf":
        return {
          inlineData: { mimeType: "application/pdf", data: part.base64 },
        };
      case "file_placeholder":
        return { text: `[Prepared file: ${part.name}]` };
    }
  });
}

function extractGeminiResponseParts(data: GeminiResponse): GeminiPart[] {
  const parts = data.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return [];
  return parts
    .filter(
      (part): part is GeminiPart =>
        Boolean(part) && typeof part === "object" && !Array.isArray(part),
    )
    .map((part) => ({ ...part }));
}

function isGeminiFunctionCallPart(part: GeminiPart): boolean {
  return Boolean(part.functionCall && typeof part.functionCall === "object");
}

function getGeminiFunctionCallName(part: GeminiPart): string {
  if (!isGeminiFunctionCallPart(part)) return "";
  const functionCall = part.functionCall as { name?: unknown };
  return typeof functionCall.name === "string" && functionCall.name.trim()
    ? functionCall.name.trim()
    : "";
}

function buildGeminiFunctionCallParts(
  toolCalls: readonly AgentToolCall[],
): GeminiPart[] {
  return toolCalls.map((call) => ({
    functionCall: {
      name: call.name,
      args: call.arguments ?? {},
    },
    ...(call.thoughtSignature
      ? { thoughtSignature: call.thoughtSignature }
      : {}),
  }));
}

function parseGeminiToolResponseContent(
  message: Extract<AgentModelMessage, { role: "tool" }>,
): unknown {
  try {
    return JSON.parse(message.content);
  } catch (_error) {
    return { content: message.content };
  }
}

function buildGeminiFunctionResponseParts(
  toolMessages: readonly Extract<AgentModelMessage, { role: "tool" }>[],
): GeminiPart[] {
  return toolMessages.map((message) => ({
    functionResponse: {
      name: message.name,
      response: parseGeminiToolResponseContent(message),
    },
  }));
}

function collectConsecutiveToolMessages(
  messages: AgentModelMessage[],
  startIndex: number,
): Extract<AgentModelMessage, { role: "tool" }>[] {
  const toolMessages: Extract<AgentModelMessage, { role: "tool" }>[] = [];
  for (let index = startIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "tool") break;
    toolMessages.push(message);
  }
  return toolMessages;
}

function buildLooseToolResultSummaryMessage(
  toolMessages: readonly Extract<AgentModelMessage, { role: "tool" }>[],
): GeminiMessage | null {
  if (!toolMessages.length) return null;
  return {
    role: "user",
    parts: [
      {
        text: toolMessages
          .map(
            (message) =>
              `Tool result (${message.name}, id=${message.tool_call_id}):\n${message.content}`,
          )
          .join("\n\n"),
      },
    ],
  };
}

function getFunctionCallNamesFromMessage(
  message: GeminiMessage | undefined,
): string[] {
  if (!message || message.role !== "model") return [];
  return message.parts.map(getGeminiFunctionCallName).filter(Boolean);
}

function splitToolMessagesByPreviousFunctionCalls(
  toolMessages: readonly Extract<AgentModelMessage, { role: "tool" }>[],
  previousMessage: GeminiMessage | undefined,
): {
  matched: Extract<AgentModelMessage, { role: "tool" }>[];
  unmatched: Extract<AgentModelMessage, { role: "tool" }>[];
} {
  const expectedNames = getFunctionCallNamesFromMessage(previousMessage);
  const matched: Extract<AgentModelMessage, { role: "tool" }>[] = [];
  const unmatched: Extract<AgentModelMessage, { role: "tool" }>[] = [];
  let expectedIndex = 0;
  for (const message of toolMessages) {
    if (
      expectedIndex < expectedNames.length &&
      message.name === expectedNames[expectedIndex]
    ) {
      matched.push(message);
      expectedIndex += 1;
      continue;
    }
    unmatched.push(message);
  }
  return { matched, unmatched };
}

async function buildInitialGeminiMessages(
  messages: AgentModelMessage[],
): Promise<{
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: GeminiMessage[];
}> {
  const systemParts: string[] = [];
  const contents: GeminiMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "tool") {
      const toolMessages = collectConsecutiveToolMessages(messages, index);
      index += toolMessages.length - 1;
      const { matched, unmatched } = splitToolMessagesByPreviousFunctionCalls(
        toolMessages,
        contents[contents.length - 1],
      );
      if (matched.length) {
        contents.push({
          role: "user",
          parts: buildGeminiFunctionResponseParts(matched),
        });
      }
      const summary = buildLooseToolResultSummaryMessage(unmatched);
      if (summary) contents.push(summary);
      continue;
    }
    if (message.role === "system") {
      const text = stringifyMessageContent(message.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (message.role === "assistant") {
      const followingToolMessages = collectConsecutiveToolMessages(
        messages,
        index + 1,
      );
      const followingToolResultIds = new Set(
        followingToolMessages.map((toolMessage) => toolMessage.tool_call_id),
      );
      const toolCalls =
        Array.isArray(message.tool_calls) && followingToolResultIds.size
          ? message.tool_calls.filter((call) =>
              followingToolResultIds.has(call.id),
            )
          : [];
      const parts = [
        ...(await buildGeminiParts(message)),
        ...buildGeminiFunctionCallParts(toolCalls),
      ].filter(
        (part) =>
          !(
            typeof part.text === "string" &&
            !part.text.trim() &&
            !isGeminiFunctionCallPart(part)
          ),
      );
      if (!parts.length) continue;
      contents.push({
        role: "model",
        parts,
      });
      continue;
    }
    contents.push({
      role: "user",
      parts: await buildGeminiParts(message),
    });
  }
  return {
    systemInstruction: systemParts.length
      ? { parts: [{ text: systemParts.join("\n\n") }] }
      : undefined,
    contents,
  };
}

async function buildGeminiContinuationMessages(
  messages: AgentModelMessage[],
): Promise<GeminiMessage[]> {
  const { toolMessages, followupUserMessages } =
    groupToolContinuationMessages(messages);
  const contents: GeminiMessage[] = [];
  if (toolMessages.length) {
    contents.push({
      role: "user",
      parts: buildGeminiFunctionResponseParts(toolMessages),
    });
  }
  for (const message of followupUserMessages) {
    contents.push({
      role: "user",
      parts: await buildGeminiParts(message),
    });
  }
  return contents;
}

/**
 * Only `thought: true` marks a thought-summary part.  A `thoughtSignature`
 * must NOT be treated as a thought marker: Gemini 3 attaches signatures to
 * regular answer text and functionCall parts that stay in the answer channel.
 */
function isGeminiThoughtPart(part: GeminiPart): boolean {
  return part.thought === true;
}

function normalizeGeminiResponse(data: GeminiResponse): {
  text: string;
  reasoningText: string;
  toolCalls: AgentToolCall[];
  responseParts: GeminiPart[];
} {
  const parts = extractGeminiResponseParts(data);
  const toolCalls: AgentToolCall[] = [];
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string" && part.text) {
      if (isGeminiThoughtPart(part)) {
        reasoningParts.push(part.text);
      } else {
        textParts.push(part.text);
      }
    }
    if (part.functionCall && typeof part.functionCall === "object") {
      const functionCall = part.functionCall as {
        name?: unknown;
        args?: unknown;
        thoughtSignature?: unknown;
      };
      const name =
        typeof functionCall.name === "string" ? functionCall.name.trim() : "";
      if (!name) continue;
      const thoughtSignature =
        typeof part.thoughtSignature === "string" && part.thoughtSignature
          ? part.thoughtSignature
          : typeof functionCall.thoughtSignature === "string" &&
              functionCall.thoughtSignature
            ? functionCall.thoughtSignature
            : undefined;
      toolCalls.push({
        id: createFallbackToolCallId("gemini-call", index),
        name,
        arguments:
          functionCall.args && typeof functionCall.args === "object"
            ? functionCall.args
            : {},
        ...(thoughtSignature ? { thoughtSignature } : {}),
      });
    }
  }
  return {
    text: textParts.join(""),
    reasoningText: reasoningParts.join(""),
    toolCalls,
    responseParts: parts,
  };
}

async function parseGeminiStepStream(
  stream: ReadableStream<Uint8Array>,
  onTextDelta?: (delta: string) => void | Promise<void>,
  onReasoning?: (event: {
    summary?: string;
    details?: string;
  }) => void | Promise<void>,
): Promise<{
  text: string;
  toolCalls: AgentToolCall[];
  responseParts: GeminiPart[];
}> {
  const reader = stream.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoningText = "";
  // Streaming chunks each carry only the new parts; accumulate them all so
  // the cached model turn keeps every functionCall and thoughtSignature
  // (parallel calls and trailing signature-only parts can arrive in separate
  // chunks, and Gemini 3 rejects continuations that drop a required
  // signature).
  const allParts: GeminiPart[] = [];

  const handlePayload = async (payload: string) => {
    if (!payload || payload === "[DONE]") return;
    const parsed = JSON.parse(payload) as GeminiResponse;
    const normalized = normalizeGeminiResponse(parsed);
    allParts.push(...normalized.responseParts);
    if (normalized.reasoningText) {
      let reasoningDelta = normalized.reasoningText;
      if (normalized.reasoningText.startsWith(reasoningText)) {
        reasoningDelta = normalized.reasoningText.slice(reasoningText.length);
        reasoningText = normalized.reasoningText;
      } else {
        reasoningText += reasoningDelta;
      }
      if (reasoningDelta && onReasoning) {
        await onReasoning({ details: reasoningDelta });
      }
    }
    if (!normalized.text) return;
    let delta = normalized.text;
    if (normalized.text.startsWith(text)) {
      delta = normalized.text.slice(text.length);
      text = normalized.text;
    } else {
      text += delta;
    }
    if (delta && onTextDelta) {
      await onTextDelta(delta);
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
        await handlePayload(dataLines.join("\n"));
      }
    }
  } finally {
    reader.releaseLock();
  }
  const aggregate = normalizeGeminiResponse({
    candidates: [{ content: { parts: allParts } }],
  });
  return { text, toolCalls: aggregate.toolCalls, responseParts: allParts };
}

function buildAssistantConversationMessage(step: {
  text: string;
  toolCalls: AgentToolCall[];
  responseParts?: GeminiPart[];
}): GeminiMessage {
  if (Array.isArray(step.responseParts) && step.responseParts.length) {
    return {
      role: "model",
      parts: step.responseParts.map((part) => ({ ...part })),
    };
  }
  return {
    role: "model",
    parts: [
      ...(step.text ? [{ text: step.text }] : []),
      ...buildGeminiFunctionCallParts(step.toolCalls),
    ],
  };
}

export class GeminiNativeAgentAdapter implements AgentModelAdapter {
  private conversationMessages: GeminiMessage[] | null = null;
  private systemInstruction: { parts: Array<{ text: string }> } | undefined;

  getCapabilities(request: AgentRuntimeRequest): AgentModelCapabilities {
    return buildAgentModelCapabilities({
      streaming: true,
      toolCalls: true,
      contentInputs: resolveRequestContentInputs(request),
      fileInputs: false,
      reasoning: true,
    });
  }

  supportsTools(_request: AgentRuntimeRequest): boolean {
    return true;
  }

  resetState(): void {
    this.conversationMessages = null;
    this.systemInstruction = undefined;
  }

  async runStep(params: AgentStepParams): Promise<AgentModelStep> {
    const request = params.request;
    const initial = await buildInitialGeminiMessages(params.messages);
    const cachedConversationMessages = this.conversationMessages;
    if (!cachedConversationMessages) {
      this.conversationMessages = initial.contents;
      this.systemInstruction = initial.systemInstruction;
    }
    const continuationSource = cachedConversationMessages
      ? params.continuationMessages || []
      : [];
    const continuation =
      await buildGeminiContinuationMessages(continuationSource);
    const conversationBase = cachedConversationMessages || initial.contents;
    const contents = continuation.length
      ? [...conversationBase, ...continuation]
      : conversationBase;

    // User extra parameters ride along like on every other protocol; a user
    // generationConfig merges under the envelope so the dedicated
    // temperature/max-token fields keep the last word on a collision.
    const extraBody = resolveUserExtraBody(
      normalizeProfileOverride(request.advanced?.profileOverride),
      request.model,
    );
    const { generationConfig: extraGenerationConfig, ...extraTop } =
      (extraBody || {}) as { generationConfig?: unknown } & Record<
        string,
        unknown
      >;
    const payload = {
      ...extraTop,
      ...(this.systemInstruction
        ? { systemInstruction: this.systemInstruction }
        : {}),
      contents,
      tools: buildGeminiTools(params.tools),
      toolConfig: {
        functionCallingConfig: {
          mode: "AUTO",
        },
      },
      generationConfig: {
        ...(isRecord(extraGenerationConfig) ? extraGenerationConfig : {}),
        ...(() => {
          const temperature = resolveGeminiTemperature(
            request.model,
            request.advanced?.temperature,
          );
          return temperature !== undefined ? { temperature } : {};
        })(),
        maxOutputTokens: normalizeMaxTokensForRequest({
          value: request.advanced?.maxTokens,
          maxTokensExplicit: request.advanced?.maxTokensExplicit,
          model: request.model || "",
          apiBase: request.apiBase,
          protocol: "gemini_native",
          authMode: request.authMode,
          profileOverride: request.advanced?.profileOverride,
        }),
        ...(resolveGeminiReasoningConfig(request)
          ? { thinkingConfig: resolveGeminiReasoningConfig(request) }
          : {}),
      },
    };
    const fetchGemini = async (stream: boolean) => {
      const url = resolveProviderTransportEndpoint({
        protocol: "gemini_native",
        apiBase: request.apiBase || "",
        model: request.model || "",
        stream,
      });
      const response = await getFetch()(url, {
        method: "POST",
        headers: buildProviderTransportHeaders({
          protocol: "gemini_native",
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
      return response;
    };
    const response = await fetchGemini(true);
    let normalized = response.body
      ? await parseGeminiStepStream(
          response.body,
          params.onTextDelta,
          params.onReasoning,
        )
      : normalizeGeminiResponse((await response.json()) as GeminiResponse);
    if (!normalized.text && !normalized.toolCalls.length) {
      const fallbackResponse = await fetchGemini(false);
      normalized = normalizeGeminiResponse(
        (await fallbackResponse.json()) as GeminiResponse,
      );
    }
    this.conversationMessages = [
      ...contents,
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
