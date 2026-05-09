import type {
  AgentModelContentPart,
  AgentModelMessage,
  AgentToolCall,
  ToolSpec,
} from "../types";

export function getFetch(): typeof fetch {
  return ztoolkit.getGlobal("fetch") as typeof fetch;
}

export function parseToolCallArguments(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return { raw };
  }
}

export function createFallbackToolCallId(
  prefix: string,
  index: number,
): string {
  return `${prefix}-${Date.now()}-${index}`;
}

export function buildOpenAIFunctionTools(tools: ToolSpec[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

export function buildResponsesFunctionTools(tools: ToolSpec[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  }));
}

export function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => stringifyUnknown(entry)).join("");
  }
  if (value && typeof value === "object") {
    const row = value as { text?: unknown; content?: unknown };
    return stringifyUnknown(row.text) || stringifyUnknown(row.content);
  }
  return "";
}

export function findLastAssistantToolCallIndex(
  messages: AgentModelMessage[],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length
    ) {
      return index;
    }
  }
  return -1;
}

export function getToolContinuationMessages(
  messages: AgentModelMessage[],
): AgentModelMessage[] {
  const index = findLastAssistantToolCallIndex(messages);
  if (index < 0 || index >= messages.length - 1) return [];
  return messages.slice(index + 1);
}

export function groupToolContinuationMessages(messages: AgentModelMessage[]): {
  toolMessages: Extract<AgentModelMessage, { role: "tool" }>[];
  followupUserMessages: Extract<AgentModelMessage, { role: "user" }>[];
} {
  const toolMessages: Extract<AgentModelMessage, { role: "tool" }>[] = [];
  const followupUserMessages: Extract<AgentModelMessage, { role: "user" }>[] =
    [];
  for (const message of messages) {
    if (message.role === "tool") {
      toolMessages.push(message);
      continue;
    }
    if (message.role === "user") {
      followupUserMessages.push(message);
    }
  }
  return {
    toolMessages,
    followupUserMessages,
  };
}

export function parseDataUrl(
  url: string,
): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(url.trim());
  if (!match) return null;
  return {
    mimeType: match[1],
    data: match[2],
  };
}

export function stringifyMessageContentParts(
  parts: AgentModelContentPart[],
): string {
  return parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image_url") return "[image]";
      return `[Prepared file: ${part.file_ref.name}]`;
    })
    .join("\n");
}

export function isAssistantToolCallMessage(
  message: AgentModelMessage,
): message is Extract<AgentModelMessage, { role: "assistant" }> {
  return (
    message.role === "assistant" &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0
  );
}

export function normalizeAssistantToolCalls(
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>,
): AgentToolCall[] {
  return toolCalls.map((call) => ({
    id: call.id,
    name: call.name,
    arguments: call.arguments,
  }));
}

export function encodeBytesBase64(bytes: Uint8Array): string {
  let out = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(
      index,
      Math.min(bytes.length, index + chunkSize),
    );
    out += String.fromCharCode(...chunk);
  }
  const btoaFn = (
    globalThis as typeof globalThis & { btoa?: (v: string) => string }
  ).btoa;
  if (typeof btoaFn !== "function") throw new Error("btoa is unavailable");
  return btoaFn(out);
}

export async function readFileRefAsBase64(storedPath: string): Promise<string> {
  const { readAttachmentBytes } =
    await import("../../modules/contextPanel/attachmentStorage");
  const bytes = await readAttachmentBytes(storedPath);
  return encodeBytesBase64(bytes);
}
