/**
 * Maps ACP `session/update` traffic onto the plugin's `AgentEvent` stream.
 *
 * The panel renders agent turns from `AgentEvent`s regardless of which
 * runtime produced them, so an ACP turn only has to say the same things the
 * natively-run agent says. Variants ACP carries that the panel has no place
 * for yet (`plan`, `available_commands`, `current_mode`) map to nothing and
 * are dropped here rather than approximated.
 */

import type { AgentEvent } from "../agent/types";
import type { AcpSessionUpdate } from "./protocol";

export type AcpEventMappingContext = {
  /** Reasoning round the thought chunks belong to; the panel groups by it. */
  round?: number;
};

export function acpUpdateToAgentEvents(
  update: AcpSessionUpdate,
  context: AcpEventMappingContext = {},
): AgentEvent[] {
  const round = context.round ?? 1;
  switch (update.kind) {
    case "message_chunk":
      return update.text ? [{ type: "message_delta", text: update.text }] : [];
    case "thought_chunk":
      return update.text
        ? [{ type: "reasoning", round, details: update.text }]
        : [];
    case "tool_call":
      return [
        {
          type: "tool_call",
          callId: update.toolCallId,
          name: acpToolName(update),
          args: update.rawInput,
          ...(update.title ? { toolLabel: update.title } : {}),
        },
      ];
    case "tool_call_update": {
      // `pending`/`in_progress` are the open card the `tool_call` event made;
      // only a terminal status closes it.
      if (!isTerminalToolStatus(update.status)) return [];
      const ok = update.status === "completed";
      return [
        {
          type: "tool_result",
          callId: update.toolCallId,
          name: update.title ?? "tool",
          ok,
          ...(update.title ? { toolLabel: update.title } : {}),
          actionReceipts: [],
          content: update.rawOutput ?? update.content ?? null,
        },
      ];
    }
    case "usage":
      return [
        {
          type: "usage",
          inputTokens: 0,
          outputTokens: 0,
          contextTokens: update.used ?? 0,
          ...(update.size !== undefined ? { contextWindow: update.size } : {}),
        },
      ];
    case "user_chunk":
      // The panel already rendered the user's own turn.
      return [];
    case "plan":
    case "available_commands":
    case "current_mode":
    case "other":
      return [];
    default:
      return [];
  }
}

/** ACP calls its tool name `title` and its category `kind`. */
export function acpToolName(update: {
  title?: string;
  toolKind?: string;
}): string {
  return update.title?.trim() || update.toolKind?.trim() || "tool";
}

function isTerminalToolStatus(status: string | undefined): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

/** ACP `stopReason` this plugin treats as a clean end of turn. */
export function isAcpStopReasonComplete(
  stopReason: string | undefined,
): boolean {
  return (
    stopReason === undefined ||
    stopReason === "end_turn" ||
    stopReason === "max_tokens"
  );
}
