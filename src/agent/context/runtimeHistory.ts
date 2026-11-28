/**
 * The chat history an external runtime is given when its own session does
 * not hold it: Claude Code when its session cannot be resumed (the bridge's
 * fallback history), and Antigravity when a turn opens a new agy session (a
 * chat edited, a session agy no longer has, a forced fresh session).
 *
 * The budget is the model's: the newest messages are kept whole while they
 * fit in half of the model's input budget (resolveAgentPromptBudgetLimits),
 * so the turn's own prompt keeps the other half. Older messages that do not
 * fit are left out and counted, and the rendering names this chat's id,
 * which past_chat_read opens to read them. No message is cut in the middle.
 */

import type { AgentRuntimeRequest } from "../types";
import { resolveAgentPromptBudgetLimits } from "./promptBudget";
import { estimateTextTokens } from "../../utils/modelInputCap";
import { classifyConversationKey } from "../../shared/conversationKeySpace";
import { pastConversationId } from "../../services/pastConversations/pastConversationText";

export type RuntimeHistoryEntry = {
  role: "user" | "assistant";
  content: string;
};

export type RuntimeHistory = {
  entries: RuntimeHistoryEntry[];
  /** Earlier messages left out because they did not fit the budget. */
  omitted: number;
  /** With `omitted`: this chat's id, which past_chat_read opens. */
  chatId?: string;
};

function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = part as { type?: unknown; text?: unknown };
      if (record?.type === "text" && typeof record.text === "string")
        return record.text;
      return record?.type === "image_url" ? "[image]" : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function historyBudgetTokens(request: AgentRuntimeRequest): number | undefined {
  try {
    const limits = resolveAgentPromptBudgetLimits({
      model: request.model,
      inputTokenCap: request.advanced?.inputTokenCap,
      apiBase: request.apiBase,
      providerProtocol: request.providerProtocol,
      authMode: request.authMode,
      profileOverride: request.advanced?.profileOverride,
      outputTokenLimit: request.advanced?.outputTokenLimit,
    });
    return Math.floor(limits.softLimitTokens / 2);
  } catch {
    return undefined;
  }
}

/** The turn's history that fits the model's budget, newest kept first. */
export function selectRuntimeHistory(
  request: AgentRuntimeRequest,
): RuntimeHistory {
  const all = (Array.isArray(request.history) ? request.history : [])
    .map((message) => ({
      role: message.role,
      content: messageText(message.content),
    }))
    .filter(
      (entry): entry is RuntimeHistoryEntry =>
        (entry.role === "user" || entry.role === "assistant") &&
        Boolean(entry.content),
    );
  const budget = historyBudgetTokens(request);
  if (budget === undefined) return { entries: all, omitted: 0 };
  let used = 0;
  let start = all.length;
  while (start > 0) {
    const cost = estimateTextTokens(all[start - 1].content);
    if (used + cost > budget) break;
    used += cost;
    start -= 1;
  }
  const classified = start
    ? classifyConversationKey(request.conversationKey)
    : null;
  return {
    entries: all.slice(start),
    omitted: start,
    ...(classified
      ? {
          chatId: pastConversationId({
            system: classified.system,
            conversationKey: request.conversationKey,
          }),
        }
      : {}),
  };
}

/** The note on the messages a history left out, and how to read them. */
export function renderOmittedHistoryNote(
  omitted: number,
  chatId: string | undefined,
): string {
  const count = `${omitted} earlier message${omitted === 1 ? "" : "s"}`;
  return chatId
    ? `(${count} did not fit and are not shown. Read them with past_chat_read({ chat: "${chatId}" }), which lists this conversation's questions, then with message: <number>.)`
    : `(${count} did not fit and are not shown.)`;
}

/**
 * The history as a transcript for a runtime's first prompt, worded as the
 * Claude Code bridge words its fallback history; "" when there is none.
 */
export function renderRuntimeHistoryTranscript(
  history: RuntimeHistory,
  reason: string,
): string {
  if (!history.entries.length) return "";
  return [
    `Local Zotero conversation history for continuity because ${reason}:`,
    ...(history.omitted
      ? [renderOmittedHistoryNote(history.omitted, history.chatId)]
      : []),
    ...history.entries.map(
      (entry, index) => `${index + 1}. ${entry.role}: ${entry.content}`,
    ),
    "Use this transcript only to restore conversation context for the current answer.",
  ].join("\n");
}
