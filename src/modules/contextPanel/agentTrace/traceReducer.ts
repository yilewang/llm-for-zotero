import type { AgentRunEventRecord } from "../../../agent/types";
import { sanitizeText } from "../textUtils";
import {
  getToolActivityVisibleDedupeKey,
  isWithinToolActivityDedupeWindow,
  mergeToolActivityPayload,
} from "./toolActivityDedupe";

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
  const codexActivityIndexByVisibleKey = new Map<string, number>();
  const codexActivityIndexByItemId = new Map<string, number>();
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
      codexActivityIndexByItemId.has(entry.payload.itemId)
    ) {
      const existingIndex = codexActivityIndexByItemId.get(
        entry.payload.itemId,
      );
      if (existingIndex === undefined) {
        codexActivityIndexByItemId.delete(entry.payload.itemId);
      } else {
        const previousEntry = compact[existingIndex];
        const previousPayload = previousEntry?.payload;
        if (previousPayload?.type !== "codex_tool_activity") {
          codexActivityIndexByItemId.delete(entry.payload.itemId);
        } else {
          const previousKey = getToolActivityVisibleDedupeKey(previousPayload);
          if (
            codexActivityIndexByVisibleKey.get(previousKey) === existingIndex
          ) {
            codexActivityIndexByVisibleKey.delete(previousKey);
          }
          const payload = mergeToolActivityPayload(
            previousPayload,
            entry.payload,
          );
          compact[existingIndex] = {
            ...entry,
            payload,
          };
          codexActivityIndexByVisibleKey.set(
            getToolActivityVisibleDedupeKey(payload),
            existingIndex,
          );
          continue;
        }
      }
    }
    if (entry.payload.type === "codex_tool_activity") {
      const visibleKey = getToolActivityVisibleDedupeKey(entry.payload);
      const previousVisibleIndex =
        codexActivityIndexByVisibleKey.get(visibleKey);
      if (previousVisibleIndex !== undefined) {
        const previousVisibleEntry = compact[previousVisibleIndex];
        if (
          previousVisibleEntry?.payload.type === "codex_tool_activity" &&
          isWithinToolActivityDedupeWindow(
            entry.createdAt,
            previousVisibleEntry.createdAt,
          )
        ) {
          continue;
        }
      }
      codexActivityIndexByVisibleKey.set(visibleKey, compact.length);
      codexActivityIndexByItemId.set(entry.payload.itemId, compact.length);
    }
    compact.push(entry);
  }
  return compact;
}

export function normalizeInlineTextForDedupe(text: string): string {
  return sanitizeText(text).replace(/\s+/g, " ").trim();
}
