import type { AgentModelMessage } from "../types";
import { estimateContextMessagesTokens } from "../../utils/modelInputCap";
import type { AgentContextBudgetState } from "./budgetPolicy";

export type AgentTranscriptCompactionResult = {
  compacted: boolean;
  messages: AgentModelMessage[];
  summaryMessage?: AgentModelMessage;
  droppedMessageCount: number;
};

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
): AgentModelMessage {
  const summaryChars = Math.max(600, summaryTokens * 4);
  const userLines: string[] = [];
  const assistantLines: string[] = [];
  const toolCounts = new Map<string, number>();
  for (const message of messages) {
    for (const toolName of toolNamesFromMessage(message)) {
      toolCounts.set(toolName, (toolCounts.get(toolName) || 0) + 1);
    }
    const text = stringifyContent(message.content);
    if (!text.trim()) continue;
    if (message.role === "user" && userLines.length < 8) {
      userLines.push(
        `- ${truncateText(text.replace(/^User request:\s*/i, ""), 220)}`,
      );
    } else if (message.role === "assistant" && assistantLines.length < 8) {
      assistantLines.push(`- ${truncateText(text, 260)}`);
    }
  }
  const toolLine = Array.from(toolCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name}${count > 1 ? ` x${count}` : ""}`)
    .join(", ");
  const sections = [
    "Agent transcript compact checkpoint:",
    "Older raw agent turns were compacted to preserve the model context budget. Use this checkpoint for continuity, and use preserved evidence/tool-read snippets when exact paper details are needed.",
    userLines.length ? `Earlier user requests:\n${userLines.join("\n")}` : "",
    assistantLines.length
      ? `Earlier assistant conclusions:\n${assistantLines.join("\n")}`
      : "",
    toolLine ? `Earlier tools used: ${toolLine}` : "",
  ].filter(Boolean);
  return {
    role: "user",
    content: truncateText(sections.join("\n\n"), summaryChars),
  };
}

export function compactAgentTranscript(params: {
  messages: AgentModelMessage[];
  budget: AgentContextBudgetState;
  force?: boolean;
}): AgentTranscriptCompactionResult {
  const messages = params.messages.filter(
    (message) => message.role !== "system",
  );
  if (messages.length <= params.budget.policy.minRecentMessages + 1) {
    return {
      compacted: false,
      messages,
      droppedMessageCount: 0,
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
    };
  }
  const summaryMessage = buildSummaryMessage(
    older,
    params.budget.summaryTokens,
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
    };
  }
  return {
    compacted: true,
    messages: compactedMessages,
    summaryMessage,
    droppedMessageCount: older.length,
  };
}
