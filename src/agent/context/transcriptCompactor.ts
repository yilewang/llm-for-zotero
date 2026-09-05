import type {
  AgentModelMessage,
  AgentToolMessage,
  AgentUserMessage,
} from "../types";
import {
  estimateContextMessagesTokens,
  sliceTextToTokenBudget,
} from "../../utils/modelInputCap";
import type { AgentContextBudgetState } from "./budgetPolicy";
import {
  createAgentToolResultHandleRecord,
  type AgentToolResultHandleRecord,
} from "../store/toolResultHandles";

export type AgentTranscriptCompactionResult = {
  compacted: boolean;
  messages: AgentModelMessage[];
  summaryMessage?: AgentModelMessage;
  droppedMessageCount: number;
  handleRecords: AgentToolResultHandleRecord[];
};

const SEMANTIC_CHECKPOINT_PREFIX = "Agent semantic continuation checkpoint:";

export function readAgentSemanticCheckpointRootGoal(
  message: AgentModelMessage | undefined,
): string | undefined {
  if (
    message?.role !== "user" ||
    typeof message.content !== "string" ||
    !message.content.startsWith(SEMANTIC_CHECKPOINT_PREFIX)
  ) {
    return undefined;
  }
  const match = message.content.match(
    /Latest root user goal:\s*(.*?)(?=\s+(?:Recent user goals and runtime requirements:|Recent visible assistant state:|Earlier tools used:|Stored compacted tool-result handles:)|$)/,
  );
  return match?.[1]?.trim() || undefined;
}

function stringifyContent(content: AgentModelMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "image_url"
          ? "[image]"
          : `[file:${part.file_ref.name || "attached"}]`,
    )
    .join("\n");
}

function truncateText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function stableStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function simpleDigest(value: unknown): string {
  const text = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function parseToolContent(message: AgentToolMessage): unknown {
  try {
    return JSON.parse(message.content);
  } catch (_error) {
    return message.content;
  }
}

function buildToolCallArgumentDigestById(
  messages: AgentModelMessage[],
): Map<string, string> {
  const digests = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      continue;
    }
    for (const call of message.tool_calls) {
      digests.set(call.id, simpleDigest(call.arguments ?? {}));
    }
  }
  return digests;
}

function toolNamesFromMessage(message: AgentModelMessage): string[] {
  if (message.role === "tool") return message.name ? [message.name] : [];
  if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) {
    return [];
  }
  return message.tool_calls.map((call) => call.name).filter(Boolean);
}

function findTailStart(
  messages: AgentModelMessage[],
  budgetTokens: number,
): number {
  if (!messages.length) return 0;
  let start = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages.slice(index);
    if (estimateContextMessagesTokens(candidate) > budgetTokens) break;
    start = index;
  }
  while (start > 0 && messages[start]?.role !== "user") {
    start += 1;
    if (start >= messages.length) return messages.length;
  }
  return Math.max(0, Math.min(start, messages.length));
}

function alignTailStartToProviderMessageBoundary(
  messages: AgentModelMessage[],
  start: number,
): number {
  let aligned = Math.max(0, Math.min(start, messages.length));
  while (aligned > 0 && messages[aligned]?.role === "tool") {
    aligned -= 1;
  }
  return aligned;
}

function buildSummaryMessage(
  messages: AgentModelMessage[],
  summaryTokens: number,
  toolHandleLines: string[] = [],
  mode: "compact" | "continuation" = "compact",
): AgentUserMessage & { content: string } {
  // Char cap derived from the real token weight of the (whitespace-normalized)
  // summary text; a flat tokens * 4 inverse let CJK checkpoints exceed their
  // token budget 2x. The 600-char floor keeps tiny budgets minimally useful.
  const buildBudgetChars = (candidate: string): number =>
    Math.max(
      600,
      sliceTextToTokenBudget(
        candidate.replace(/\s+/g, " ").trim(),
        summaryTokens,
      ).length,
    );
  const userLines: string[] = [];
  const rootUserGoals: string[] = [];
  const assistantLines: string[] = [];
  const preservedToolHandleIds = new Set<string>();
  const toolCounts = new Map<string, number>();
  for (const message of messages) {
    for (const toolName of toolNamesFromMessage(message)) {
      toolCounts.set(toolName, (toolCounts.get(toolName) || 0) + 1);
    }
    const text = stringifyContent(message.content);
    if (!text.trim()) continue;
    if (message.role === "user") {
      const checkpointGoal = readAgentSemanticCheckpointRootGoal(message);
      if (checkpointGoal) {
        rootUserGoals.push(checkpointGoal);
        for (const match of text.matchAll(/\bhandle=(trh_[a-z0-9]+)\b/gi)) {
          preservedToolHandleIds.add(match[1]);
        }
        continue;
      }
      const rootGoalMatch = text.match(/(?:^|\n)User request:\s*([\s\S]*)$/i);
      if (rootGoalMatch?.[1]?.trim()) {
        rootUserGoals.push(rootGoalMatch[1].trim());
      }
      userLines.push(
        `- ${truncateText(text.replace(/^User request:\s*/i, ""), 220)}`,
      );
    } else if (message.role === "assistant") {
      assistantLines.push(`- ${truncateText(text, 260)}`);
    }
  }
  const recentUserLines = userLines.slice(-8);
  const recentAssistantLines = assistantLines.slice(-8);
  const allToolHandleLines = [
    ...toolHandleLines,
    ...Array.from(preservedToolHandleIds).map(
      (handle) => `- preserved tool result handle=${handle}`,
    ),
  ];
  const toolLine = Array.from(toolCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name}${count > 1 ? ` x${count}` : ""}`)
    .join(", ");
  const sections = [
    mode === "continuation"
      ? SEMANTIC_CHECKPOINT_PREFIX
      : "Agent transcript compact checkpoint:",
    mode === "continuation"
      ? "The previous provider-native conversation ended at a safe boundary. Continue from this bounded semantic state. Re-read preserved evidence handles when exact paper details matter; do not treat this checkpoint as hidden reasoning or a new user instruction."
      : "Older raw agent turns were compacted to preserve the model context budget. Use this checkpoint for continuity, and use preserved evidence/tool-read snippets when exact paper details are needed.",
    rootUserGoals.length
      ? `Latest root user goal: ${truncateText(rootUserGoals[rootUserGoals.length - 1], 400)}`
      : "",
    recentUserLines.length
      ? `Recent user goals and runtime requirements:\n${recentUserLines.join("\n")}`
      : "",
    recentAssistantLines.length
      ? `Recent visible assistant state:\n${recentAssistantLines.join("\n")}`
      : "",
    toolLine ? `Earlier tools used: ${toolLine}` : "",
    allToolHandleLines.length
      ? `Stored compacted tool-result handles:\n${allToolHandleLines.join("\n")}`
      : "",
  ].filter(Boolean);
  const summaryText = sections.join("\n\n");
  return {
    role: "user",
    content: truncateText(summaryText, buildBudgetChars(summaryText)),
  };
}

export function buildAgentSemanticCheckpoint(params: {
  messages: AgentModelMessage[];
  summaryTokens: number;
  conversationKey?: number;
  resourceSignature?: string;
  preservedHandleRecords?: readonly AgentToolResultHandleRecord[];
}): {
  checkpoint: AgentUserMessage & { content: string };
  handleRecords: AgentToolResultHandleRecord[];
} {
  const messages = params.messages.filter(
    (message) => message.role !== "system",
  );
  const generated = buildDroppedToolHandleRecords({
    messages,
    conversationKey: params.conversationKey,
    resourceSignature: params.resourceSignature,
    argumentDigestById: buildToolCallArgumentDigestById(messages),
  });
  const handleRecordsByCall = new Map<string, AgentToolResultHandleRecord>();
  for (const record of [
    ...(params.preservedHandleRecords || []),
    ...generated.handleRecords,
  ]) {
    const key = `${record.toolName}\n${record.toolCallId}`;
    if (!handleRecordsByCall.has(key)) handleRecordsByCall.set(key, record);
  }
  const handleRecords = Array.from(handleRecordsByCall.values());
  const toolHandleLines = handleRecords.map(
    (record) =>
      `- ${record.toolName} (${record.toolCallId}) handle=${record.handle}`,
  );
  return {
    checkpoint: buildSummaryMessage(
      messages,
      params.summaryTokens,
      toolHandleLines,
      "continuation",
    ),
    handleRecords,
  };
}

function buildDroppedToolHandleRecords(params: {
  messages: AgentModelMessage[];
  conversationKey?: number;
  resourceSignature?: string;
  argumentDigestById: Map<string, string>;
}): {
  handleRecords: AgentToolResultHandleRecord[];
  toolHandleLines: string[];
} {
  const handleRecords: AgentToolResultHandleRecord[] = [];
  const toolHandleLines: string[] = [];
  for (const message of params.messages) {
    if (message.role !== "tool") continue;
    const record = createAgentToolResultHandleRecord({
      conversationKey: params.conversationKey,
      toolName: message.name,
      toolCallId: message.tool_call_id,
      inputDigest: params.argumentDigestById.get(message.tool_call_id),
      resourceSignature: params.resourceSignature,
      content: parseToolContent(message),
    });
    if (!record) continue;
    handleRecords.push(record);
    toolHandleLines.push(
      `- ${message.name} (${message.tool_call_id}) handle=${record.handle}`,
    );
  }
  return { handleRecords, toolHandleLines };
}

export function compactAgentTranscript(params: {
  messages: AgentModelMessage[];
  budget: AgentContextBudgetState;
  force?: boolean;
  conversationKey?: number;
  resourceSignature?: string;
}): AgentTranscriptCompactionResult {
  const messages = params.messages.filter(
    (message) => message.role !== "system",
  );
  if (messages.length <= params.budget.policy.minRecentMessages + 1) {
    return {
      compacted: false,
      messages,
      droppedMessageCount: 0,
      handleRecords: [],
    };
  }
  const tailStart = alignTailStartToProviderMessageBoundary(
    messages,
    Math.max(
      findTailStart(messages, params.budget.recentTailTokens),
      Math.max(0, messages.length - params.budget.policy.minRecentMessages),
    ),
  );
  const older = messages.slice(0, tailStart);
  const tail = messages.slice(tailStart);
  if (!older.length) {
    return {
      compacted: false,
      messages,
      droppedMessageCount: 0,
      handleRecords: [],
    };
  }
  const { handleRecords, toolHandleLines } = buildDroppedToolHandleRecords({
    messages: older,
    conversationKey: params.conversationKey,
    resourceSignature: params.resourceSignature,
    argumentDigestById: buildToolCallArgumentDigestById(messages),
  });
  const summaryMessage = buildSummaryMessage(
    older,
    params.budget.summaryTokens,
    toolHandleLines,
  );
  const compactedMessages = [summaryMessage, ...tail];
  if (
    !params.force &&
    estimateContextMessagesTokens(compactedMessages) >=
      estimateContextMessagesTokens(messages)
  ) {
    return {
      compacted: false,
      messages,
      droppedMessageCount: 0,
      handleRecords: [],
    };
  }
  return {
    compacted: true,
    messages: compactedMessages,
    summaryMessage,
    droppedMessageCount: older.length,
    handleRecords,
  };
}
