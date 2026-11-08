import { buildAgentStageEvent } from "./stageEvents";
import type { AgentEvent, AgentWorkCategory } from "./types";
import { resolveClaudeCodeNativeWorkCategory } from "./workCategory";

/**
 * Bracket a Claude Code turn's work with the stages the trace groups by.
 *
 * The plugin's own runtime and the Codex bridge emit a stage around every
 * call, so their rows sit under "Read evidence", "External action" and the
 * rest. A Claude Code turn reports its built-in tools as bare calls and
 * results, and the Zotero tools it calls over MCP as relayed activity, so
 * this puts the same stage immediately before each: a call opens its stage,
 * its result closes it, and a relayed activity row carries the category the
 * Zotero tool declared. The returned events replace the one passed in, in
 * order.
 */
export function createClaudeTurnStageTracker(): (
  event: AgentEvent,
) => AgentEvent[] {
  const callCategories = new Map<string, AgentWorkCategory>();
  return (event) => {
    switch (event.type) {
      case "tool_call": {
        const stage =
          event.workCategory || resolveClaudeCodeNativeWorkCategory(event.name);
        if (!stage) return [event];
        callCategories.set(event.callId, stage);
        return [
          buildAgentStageEvent({
            stage,
            status: "started",
            callId: event.callId,
            toolName: event.name,
            toolLabel: event.toolLabel,
          }),
          { ...event, workCategory: stage },
        ];
      }
      case "tool_result": {
        const stage = callCategories.get(event.callId);
        if (!stage) return [event];
        callCategories.delete(event.callId);
        return [
          buildAgentStageEvent({
            stage,
            status: event.ok ? "completed" : "failed",
            callId: event.callId,
            toolName: event.name || undefined,
            toolLabel: event.toolLabel,
            receiptIds: event.actionReceipts?.length
              ? event.actionReceipts.map((receipt) => receipt.id)
              : undefined,
          }),
          { ...event, workCategory: stage },
        ];
      }
      case "codex_tool_activity": {
        if (!event.workCategory) return [event];
        return [
          buildAgentStageEvent({
            stage: event.workCategory,
            status:
              event.phase === "started"
                ? "started"
                : event.ok === false
                  ? "failed"
                  : "completed",
            toolName: event.toolName,
            toolLabel: event.toolLabel,
            receiptIds: event.actionReceipts?.length
              ? event.actionReceipts.map((receipt) => receipt.id)
              : undefined,
          }),
          event,
        ];
      }
      default:
        return [event];
    }
  };
}
