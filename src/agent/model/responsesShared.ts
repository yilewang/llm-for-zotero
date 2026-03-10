import {
  createFallbackToolCallId,
  groupToolContinuationMessages,
  parseToolCallArguments,
  stringifyUnknown,
} from "./shared";
import {
  stringifyMessageContent,
} from "./messageBuilder";
import type { ReasoningEvent } from "../../utils/llmClient";
import type {
  AgentModelContentPart,
  AgentModelMessage,
  AgentToolCall,
} from "../types";
import { MAX_AGENT_TOOL_CALLS_PER_ROUND } from "./limits";

export type ResponsesInputContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "low" | "high" | "auto" }
  | { type: "input_file"; file_id: string };

export type ResponsesInputItem =
  | {
      type: "message";
      role: "system" | "user" | "assistant";
      content: string | ResponsesInputContentPart[];
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string;
    };

type ResponsesOutputContent = {
  type?: unknown;
  text?: unknown;
};

type ResponsesOutputItem = {
  id?: unknown;
  type?: unknown;
  call_id?: unknown;
  name?: unknown;
  arguments?: unknown;
  text?: unknown;
  content?: unknown;
};

export type ResponsesPayload = {
  id?: unknown;
  output_text?: unknown;
  output?: unknown;
};

function logEmptyResponse(message: string, payload: Record<string, unknown>): void {
  const toolkit =
    (globalThis as typeof globalThis & {
      ztoolkit?: { log?: (...args: unknown[]) => void };
    }).ztoolkit;
  if (typeof toolkit?.log !== "function") return;
  toolkit.log(message, payload);
}

function normalizeResponsesText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeResponsesText(entry))
      .filter(Boolean)
      .join("");
  }
  if (value && typeof value === "object") {
    const row = value as {
      text?: unknown;
      content?: unknown;
      reasoning?: unknown;
      summary?: unknown;
      delta?: unknown;
      thinking?: unknown;
      thought?: unknown;
      value?: unknown;
      output_text?: unknown;
      message?: unknown;
    };
    return (
      normalizeResponsesText(row.text) ||
      normalizeResponsesText(row.content) ||
      normalizeResponsesText(row.reasoning) ||
      normalizeResponsesText(row.summary) ||
      normalizeResponsesText(row.delta) ||
      normalizeResponsesText(row.thinking) ||
      normalizeResponsesText(row.thought) ||
      normalizeResponsesText(row.value) ||
      normalizeResponsesText(row.output_text) ||
      normalizeResponsesText(row.message)
    );
  }
  return "";
}

function normalizeReasoningText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object") {
          const row = entry as { text?: unknown; summary?: unknown };
          return (
            normalizeResponsesText(row.text) ||
            normalizeResponsesText(row.summary)
          );
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object") {
    const row = value as { text?: unknown; summary?: unknown };
    return (
      normalizeResponsesText(row.text) || normalizeResponsesText(row.summary)
    );
  }
  return "";
}

function extractReasoningSummary(value: unknown): string {
  return normalizeReasoningText(value);
}

export type NormalizedResponsesStep = {
  responseId?: string;
  text: string;
  toolCalls: AgentToolCall[];
  outputItems: unknown[];
};

export type ResponsesFilePartResolver = (
  part: Extract<AgentModelContentPart, { type: "file_ref" }>,
  signal?: AbortSignal,
) => Promise<ResponsesInputContentPart[]>;

async function buildResponsesContentParts(
  parts: AgentModelContentPart[],
  options: {
    resolveFilePart: ResponsesFilePartResolver;
    signal?: AbortSignal;
  },
): Promise<ResponsesInputContentPart[]> {
  const contentParts: ResponsesInputContentPart[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      contentParts.push({ type: "input_text", text: part.text });
      continue;
    }
    if (part.type === "image_url") {
      contentParts.push({
        type: "input_image",
        image_url: part.image_url.url,
        detail: part.image_url.detail,
      });
      continue;
    }
    const resolved = await options.resolveFilePart(part, options.signal);
    contentParts.push(...resolved);
  }
  return contentParts;
}

export async function buildResponsesInitialInput(
  messages: AgentModelMessage[],
  options: {
    resolveFilePart: ResponsesFilePartResolver;
    signal?: AbortSignal;
  },
): Promise<{ instructions?: string; input: ResponsesInputItem[] }> {
  const instructionsParts: string[] = [];
  const input: ResponsesInputItem[] = [];

  for (const message of messages) {
    if (message.role === "tool") continue;
    if (message.role === "system") {
      const text = stringifyMessageContent(message.content);
      if (text) instructionsParts.push(text);
      continue;
    }
    if (typeof message.content === "string") {
      input.push({
        type: "message",
        role: message.role,
        content: message.content,
      });
      continue;
    }
    input.push({
      type: "message",
      role: message.role,
      content: await buildResponsesContentParts(message.content, options),
    });
  }

  return {
    instructions: instructionsParts.length
      ? instructionsParts.join("\n\n")
      : undefined,
    input,
  };
}

export async function buildResponsesContinuationInput(
  messages: AgentModelMessage[],
  options: {
    resolveFilePart: ResponsesFilePartResolver;
    signal?: AbortSignal;
  },
): Promise<ResponsesInputItem[]> {
  const { toolMessages, followupUserMessages } = groupToolContinuationMessages(
    messages,
  );
  const outputs: ResponsesInputItem[] = toolMessages.map((message) => ({
    type: "function_call_output",
    call_id: message.tool_call_id,
    output: message.content,
  }));
  for (const message of followupUserMessages) {
    if (typeof message.content === "string") {
      outputs.push({
        type: "message",
        role: "user",
        content: message.content,
      });
      continue;
    }
    outputs.push({
      type: "message",
      role: "user",
      content: await buildResponsesContentParts(message.content, options),
    });
  }
  return outputs;
}

function extractOutputTextFromContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => extractOutputTextFromContent(entry))
      .filter(Boolean)
      .join("");
  }
  if (!content || typeof content !== "object") return "";
  const row = content as ResponsesOutputContent & {
    delta?: unknown;
    content?: unknown;
  };
  const typeValue =
    typeof row.type === "string" ? row.type.toLowerCase() : "";
  if (typeValue === "reasoning" || typeValue === "reasoning_summary") {
    return "";
  }
  if (
    typeValue === "output_text" ||
    typeValue === "text" ||
    typeValue === "message" ||
    typeValue === ""
  ) {
    return (
      normalizeResponsesText(row.text) ||
      normalizeResponsesText(row.delta) ||
      extractOutputTextFromContent(row.content)
    );
  }
  return "";
}

function extractToolCallsFromOutputs(outputs: unknown): AgentToolCall[] {
  if (!Array.isArray(outputs)) return [];
  const calls: AgentToolCall[] = [];
  for (let index = 0; index < outputs.length; index += 1) {
    const output = outputs[index];
    if (!output || typeof output !== "object") continue;
    const row = output as ResponsesOutputItem;
    const typeValue =
      typeof row.type === "string" ? row.type.toLowerCase() : "";
    if (typeValue !== "function_call") continue;
    const name =
      typeof row.name === "string" && row.name.trim() ? row.name.trim() : "";
    if (!name) continue;
    const callId =
      typeof row.call_id === "string" && row.call_id.trim()
        ? row.call_id.trim()
        : typeof row.id === "string" && row.id.trim()
          ? row.id.trim()
          : createFallbackToolCallId("tool", index);
    calls.push({
      id: callId,
      name,
      arguments: parseToolCallArguments(row.arguments),
    });
  }
  return calls;
}

function extractOutputText(outputs: unknown): string {
  if (!Array.isArray(outputs)) return "";
  return outputs
    .map((output) => {
      if (!output || typeof output !== "object") return "";
      const row = output as ResponsesOutputItem;
      const typeValue =
        typeof row.type === "string" ? row.type.toLowerCase() : "";
      if (typeValue === "function_call") return "";
      return (
        extractOutputTextFromContent(row.content) ||
        normalizeResponsesText(row.text)
      );
    })
    .filter(Boolean)
    .join("");
}

function getFunctionCallOutputId(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const row = item as ResponsesOutputItem;
  const typeValue =
    typeof row.type === "string" ? row.type.toLowerCase() : "";
  if (typeValue !== "function_call") return null;
  if (typeof row.call_id === "string" && row.call_id.trim()) {
    return row.call_id.trim();
  }
  if (typeof row.id === "string" && row.id.trim()) {
    return row.id.trim();
  }
  return null;
}

function getResponseOutputItemKey(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const row = item as ResponsesOutputItem;
  if (typeof row.id === "string" && row.id.trim()) {
    return `id:${row.id.trim()}`;
  }
  if (typeof row.call_id === "string" && row.call_id.trim()) {
    return `call:${row.call_id.trim()}`;
  }
  return null;
}

function mergeResponseOutputItems(
  payloadItems: unknown[],
  streamedItems: ResponsesOutputItem[],
): unknown[] {
  if (!streamedItems.length) return payloadItems;
  const merged = [...payloadItems];
  const indexByKey = new Map<string, number>();
  for (let index = 0; index < merged.length; index += 1) {
    const key = getResponseOutputItemKey(merged[index]);
    if (key) {
      indexByKey.set(key, index);
    }
  }
  for (const item of streamedItems) {
    const key = getResponseOutputItemKey(item);
    if (!key) {
      merged.push(item);
      continue;
    }
    const existingIndex = indexByKey.get(key);
    if (typeof existingIndex === "number") {
      merged[existingIndex] = item;
      continue;
    }
    indexByKey.set(key, merged.length);
    merged.push(item);
  }
  return merged;
}

export function normalizeResponsesStepFromPayload(
  data: ResponsesPayload,
): NormalizedResponsesStep {
  const outputs = Array.isArray(data.output) ? data.output : [];
  const responseId =
    typeof data.id === "string" && data.id.trim() ? data.id.trim() : undefined;
  const toolCalls = extractToolCallsFromOutputs(outputs);
  const text =
    stringifyUnknown(data.output_text).trim() || extractOutputText(outputs).trim();
  return {
    responseId,
    text,
    toolCalls,
    outputItems: outputs,
  };
}

export function limitNormalizedResponsesStep(
  step: NormalizedResponsesStep,
  maxToolCalls = MAX_AGENT_TOOL_CALLS_PER_ROUND,
): NormalizedResponsesStep {
  if (step.toolCalls.length <= maxToolCalls) {
    return step;
  }
  const toolCalls = step.toolCalls.slice(0, maxToolCalls);
  const keptCallIds = new Set(toolCalls.map((call) => call.id));
  return {
    ...step,
    toolCalls,
    outputItems: step.outputItems.filter((item) => {
      const callId = getFunctionCallOutputId(item);
      return !callId || keptCallIds.has(callId);
    }),
  };
}

export async function parseResponsesStepStream(
  stream: ReadableStream<Uint8Array>,
  onTextDelta?: (delta: string) => void | Promise<void>,
  onReasoning?: (event: ReasoningEvent) => void | Promise<void>,
): Promise<NormalizedResponsesStep> {
  const reader = stream.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let buffer = "";
  let responseId: string | undefined;
  let latestPayload: ResponsesPayload | null = null;
  let streamedText = "";
  const streamedOutputs: ResponsesOutputItem[] = [];
  const eventTypesSeen = new Set<string>();
  let sawAnswerDelta = false;
  let sawAnswerFinal = false;
  let sawSummaryDelta = false;
  let sawSummaryFinal = false;
  let sawDetailsDelta = false;
  let sawDetailsFinal = false;

  const mergeOutputItem = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    const normalizedItem = item as ResponsesOutputItem;
    const key = getResponseOutputItemKey(normalizedItem);
    if (!key) {
      streamedOutputs.push(normalizedItem);
      return;
    }
    const existingIndex = streamedOutputs.findIndex(
      (entry) => getResponseOutputItemKey(entry) === key,
    );
    if (existingIndex >= 0) {
      streamedOutputs[existingIndex] = normalizedItem;
      return;
    }
    streamedOutputs.push(normalizedItem);
  };

  const emitReasoning = async (event: ReasoningEvent) => {
    if (!onReasoning) return;
    const summary =
      typeof event.summary === "string" && event.summary.length > 0
        ? event.summary
        : undefined;
    const details =
      typeof event.details === "string" && event.details.length > 0
        ? event.details
        : undefined;
    if (!summary && !details) return;
    await onReasoning({ summary, details });
  };

  const emitAnswer = async (
    value: unknown,
    mode: "delta" | "final",
  ): Promise<void> => {
    const text = extractOutputTextFromContent(value) || normalizeResponsesText(value);
    if (!text) return;
    if (mode === "delta" && sawAnswerFinal) return;
    if (mode === "final" && (sawAnswerDelta || sawAnswerFinal)) return;
    if (mode === "delta") {
      sawAnswerDelta = true;
    } else {
      sawAnswerFinal = true;
    }
    streamedText += text;
    if (onTextDelta) {
      await onTextDelta(text);
    }
  };

  const emitReasoningFromOutputItem = async (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const row = value as {
      type?: unknown;
      summary?: unknown;
      content?: unknown;
      text?: unknown;
      reasoning?: unknown;
    };
    const typeValue =
      typeof row.type === "string" ? row.type.toLowerCase() : "";
    if (typeValue !== "reasoning") return;
    if (!sawSummaryDelta && !sawSummaryFinal) {
      await emitReasoning({ summary: extractReasoningSummary(row.summary) });
    }
    if (!sawDetailsDelta && !sawDetailsFinal) {
      await emitReasoning({
        details:
          normalizeReasoningText(row.content) ||
          normalizeReasoningText(row.reasoning) ||
          normalizeReasoningText(row.text),
      });
    }
  };

  let rawDebugLines: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (rawDebugLines.length < 30) rawDebugLines.push(trimmed.slice(0, 200));
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as {
            type?: unknown;
            delta?: unknown;
            text?: unknown;
            summary?: unknown;
            reasoning?: unknown;
            item?: unknown;
            message?: { content?: unknown };
            part?: {
              type?: unknown;
              summary?: unknown;
              content?: unknown;
              text?: unknown;
            };
            response?: ResponsesPayload;
          };
          const eventType =
            typeof parsed.type === "string" ? parsed.type.toLowerCase() : "";
          if (eventType) eventTypesSeen.add(eventType);
          if (eventType === "response.output_text.delta") {
            await emitAnswer(parsed.delta, "delta");
            continue;
          }
          if (eventType === "response.output_text.done") {
            await emitAnswer(parsed.text ?? parsed.delta, "final");
            continue;
          }
          if (
            eventType === "response.content_part.added" ||
            eventType === "response.content_part.delta"
          ) {
            const partType =
              typeof parsed.part?.type === "string"
                ? parsed.part.type.toLowerCase()
                : "";
            if (!partType || partType === "output_text" || partType === "text") {
              await emitAnswer(
                parsed.delta ??
                  parsed.text ??
                  parsed.part?.text ??
                  parsed.part?.content,
                "delta",
              );
            }
            continue;
          }
          if (eventType === "response.content_part.done") {
            const partType =
              typeof parsed.part?.type === "string"
                ? parsed.part.type.toLowerCase()
                : "";
            if (!partType || partType === "output_text" || partType === "text") {
              await emitAnswer(
                parsed.text ??
                  parsed.delta ??
                  parsed.part?.text ??
                  parsed.part?.content,
                "final",
              );
            }
            continue;
          }
          if (
            eventType === "response.message.delta" ||
            eventType === "response.message.added"
          ) {
            await emitAnswer(parsed.message?.content, "delta");
            continue;
          }
          if (eventType === "response.message.done") {
            await emitAnswer(parsed.message?.content, "final");
            continue;
          }
          if (
            (eventType === "response.reasoning_summary.delta" ||
              eventType === "response.reasoning_summary_text.delta") &&
            parsed.delta
          ) {
            sawSummaryDelta = true;
            await emitReasoning({
              summary: normalizeResponsesText(parsed.delta),
            });
            continue;
          }
          if (
            (eventType === "response.reasoning_summary.done" ||
              eventType === "response.reasoning_summary_text.done") &&
            (parsed.text || parsed.delta)
          ) {
            sawSummaryFinal = true;
            if (!sawSummaryDelta) {
              await emitReasoning({
                summary: normalizeResponsesText(parsed.text ?? parsed.delta),
              });
            }
            continue;
          }
          if (
            (eventType === "response.reasoning_summary_part.added" ||
              eventType === "response.reasoning_summary_part.done") &&
            parsed.part
          ) {
            const partType =
              typeof parsed.part.type === "string"
                ? parsed.part.type.toLowerCase()
                : "";
            if (
              !partType ||
              partType === "summary_text" ||
              partType === "reasoning_summary"
            ) {
              const partSummary = normalizeResponsesText(
                parsed.part.text ??
                  parsed.part.content ??
                  parsed.part.summary,
              );
              if (partSummary) {
                sawSummaryFinal = true;
                await emitReasoning({ summary: partSummary });
              }
            }
            continue;
          }
          if (
            (eventType === "response.reasoning.delta" ||
              eventType === "response.reasoning_text.delta") &&
            parsed.delta
          ) {
            sawDetailsDelta = true;
            await emitReasoning({
              details: normalizeResponsesText(parsed.delta),
            });
            continue;
          }
          if (
            (eventType === "response.reasoning.done" ||
              eventType === "response.reasoning_text.done") &&
            (parsed.text || parsed.delta)
          ) {
            sawDetailsFinal = true;
            if (!sawDetailsDelta) {
              await emitReasoning({
                details: normalizeResponsesText(parsed.text ?? parsed.delta),
              });
            }
            continue;
          }
          if (eventType === "response.reasoning" && parsed.reasoning) {
            sawDetailsFinal = true;
            if (!sawDetailsDelta) {
              await emitReasoning({
                details: normalizeReasoningText(parsed.reasoning),
              });
            }
            continue;
          }
          if (
            eventType === "response.output_item.added" ||
            eventType === "response.output_item.delta" ||
            eventType === "response.output_item.done"
          ) {
            mergeOutputItem(parsed.item);
            await emitReasoningFromOutputItem(parsed.item);
            // Skip emitAnswer for reasoning items — their summary text would be
            // incorrectly treated as an answer, setting sawAnswerFinal and
            // blocking the real answer from being captured.
            const itemType =
              parsed.item && typeof parsed.item === "object"
                ? String(
                    (parsed.item as { type?: unknown }).type ?? "",
                  ).toLowerCase()
                : "";
            if (itemType !== "reasoning" && itemType !== "reasoning_summary") {
              if (eventType === "response.output_item.done") {
                await emitAnswer(parsed.item, "final");
              } else {
                await emitAnswer(parsed.item, "delta");
              }
            }
            continue;
          }
          if (eventType === "response.completed" && parsed.response) {
            latestPayload = parsed.response;
            if (
              typeof parsed.response.id === "string" &&
              parsed.response.id.trim()
            ) {
              responseId = parsed.response.id.trim();
            }
            const outputs = Array.isArray(parsed.response.output)
              ? parsed.response.output
              : [];
            for (const output of outputs) {
              await emitReasoningFromOutputItem(output);
            }
            await emitAnswer(
              parsed.response.output_text || extractOutputText(outputs),
              "final",
            );
          }
        } catch (_error) {
          continue;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (latestPayload) {
    const normalized = normalizeResponsesStepFromPayload(latestPayload);
    const outputItems = mergeResponseOutputItems(
      normalized.outputItems,
      streamedOutputs,
    );
    const finalText =
      normalized.text ||
      streamedText.trim() ||
      extractOutputText(outputItems).trim();
    if (!finalText && (outputItems.length || eventTypesSeen.size > 0)) {
      logEmptyResponse("LLM Agent: Empty responses step after completed payload", {
        responseId: normalized.responseId || responseId,
        eventTypes: Array.from(eventTypesSeen),
        outputItemTypes: outputItems
          .map((item) =>
            item && typeof item === "object"
              ? (item as { type?: unknown }).type
              : undefined,
          )
          .filter(Boolean),
        hasOutputText:
          Boolean(
            latestPayload.output_text &&
              normalizeResponsesText(latestPayload.output_text),
          ) || false,
        rawDebugSample: rawDebugLines,
      });
    }
    return {
      responseId: normalized.responseId || responseId,
      text: finalText,
      toolCalls: extractToolCallsFromOutputs(outputItems),
      outputItems,
    };
  }

  const toolCalls = extractToolCallsFromOutputs(streamedOutputs);
  const finalText = streamedText.trim() || extractOutputText(streamedOutputs).trim();
  if (!finalText && (streamedOutputs.length || eventTypesSeen.size > 0)) {
    logEmptyResponse("LLM Agent: Empty responses step without completed payload", {
      responseId,
      eventTypes: Array.from(eventTypesSeen),
      outputItemTypes: streamedOutputs
        .map((item) => item.type)
        .filter(Boolean),
      rawDebugSample: rawDebugLines,
    });
  }
  return {
    responseId,
    text: finalText,
    toolCalls,
    outputItems: streamedOutputs,
  };
}
