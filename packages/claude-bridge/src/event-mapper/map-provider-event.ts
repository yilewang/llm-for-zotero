import type { ProviderEvent } from "../runtime.js";
import type { AgentEvent } from "../types.js";

const SUPPORTED_TYPES = new Set([
  "provider_event",
  "status",
  "reasoning",
  "tool_call",
  "tool_result",
  "tool_error",
  "confirmation_required",
  "confirmation_resolved",
  "message_delta",
  "message_rollback",
  "usage",
  "context_compacted",
  "codex_progress",
  "final",
]);

export function mapProviderEvent(
  event: ProviderEvent,
  ts = Date.now(),
): AgentEvent {
  if (SUPPORTED_TYPES.has(event.type)) {
    return {
      type: event.type,
      ts,
      payload: event.payload,
    } as AgentEvent;
  }

  return {
    type: "provider_event",
    ts,
    payload: {
      providerType: event.type,
      payload:
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : { value: event.payload },
    },
  };
}
