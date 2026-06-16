import type { AgentRunEventRecord } from "../../../agent/types";
import { sanitizeText } from "../textUtils";

type AgentReasoningPayload = Extract<
  AgentRunEventRecord["payload"],
  { type: "reasoning" }
>;

export function appendAgentTraceText(
  base: string | undefined,
  next: unknown,
): string | undefined {
  const chunk = typeof next === "string" ? sanitizeText(next) : null;
  if (!chunk || !chunk.trim()) return base;
  return `${base || ""}${chunk}`;
}

export function getReasoningTraceKey(payload: AgentReasoningPayload): string {
  const stepId =
    typeof payload.stepId === "string" && payload.stepId.trim()
      ? payload.stepId.trim()
      : "";
  return stepId ? `step:${stepId}` : `round:${payload.round}`;
}

export function compactAgentTraceEvents(
  events: AgentRunEventRecord[],
): AgentRunEventRecord[] {
  const compact: AgentRunEventRecord[] = [];
  for (const entry of events) {
    const previous = compact[compact.length - 1];
    if (
      entry.payload.type === "message_delta" &&
      previous?.payload.type === "message_delta"
    ) {
      compact[compact.length - 1] = {
        ...entry,
        payload: {
          type: "message_delta",
          text: (previous.payload.text || "") + (entry.payload.text || ""),
        },
      };
      continue;
    }
    if (
      entry.payload.type === "reasoning" &&
      previous?.payload.type === "reasoning" &&
      getReasoningTraceKey(previous.payload) ===
        getReasoningTraceKey(entry.payload)
    ) {
      compact[compact.length - 1] = {
        ...entry,
        payload: {
          type: "reasoning",
          round: entry.payload.round,
          stepId: entry.payload.stepId || previous.payload.stepId,
          stepLabel: entry.payload.stepLabel || previous.payload.stepLabel,
          summary: appendAgentTraceText(
            previous.payload.summary,
            entry.payload.summary,
          ),
          details: appendAgentTraceText(
            previous.payload.details,
            entry.payload.details,
          ),
        },
      };
      continue;
    }
    if (
      entry.payload.type === "codex_tool_activity" &&
      previous?.payload.type === "codex_tool_activity" &&
      entry.payload.itemId === previous.payload.itemId
    ) {
      compact[compact.length - 1] = {
        ...entry,
        payload: {
          ...previous.payload,
          ...entry.payload,
          toolName: entry.payload.toolName || previous.payload.toolName,
          toolLabel: entry.payload.toolLabel || previous.payload.toolLabel,
          serverName: entry.payload.serverName || previous.payload.serverName,
          args:
            entry.payload.args !== undefined
              ? entry.payload.args
              : previous.payload.args,
          codeBlock: entry.payload.codeBlock || previous.payload.codeBlock,
        },
      };
      continue;
    }
    compact.push(entry);
  }
  return compact;
}

export function normalizeInlineTextForDedupe(text: string): string {
  return sanitizeText(text).replace(/\s+/g, " ").trim();
}
