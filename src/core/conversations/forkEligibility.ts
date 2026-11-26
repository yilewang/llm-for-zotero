import type { ConversationSystem } from "../../shared/types";
import { positiveIntOrZero } from "../values";

export type ConversationForkEligibilityReason =
  | "invalid_turn"
  | "pending_response"
  | "claude_code"
  | "unsupported_system"
  | "webchat"
  | "compact_marker"
  | "codex_older_turn"
  | "missing_provider_session";

export type ConversationForkEligibility = {
  allowed: boolean;
  visible: boolean;
  reason?: ConversationForkEligibilityReason;
  latestForkableAssistantTimestamp: number;
};

export type ConversationForkEligibilityMessage = {
  role?: unknown;
  timestamp?: unknown;
  streaming?: unknown;
  compactMarker?: unknown;
  webchatRunState?: unknown;
  webchatCompletionReason?: unknown;
};

function hasProviderSessionId(value: unknown): boolean {
  return typeof value === "string" && Boolean(value.trim());
}

export function getLatestCompletedForkableAssistantTimestamp(
  history: readonly ConversationForkEligibilityMessage[] | null | undefined,
): number {
  const latest = [...(history || [])]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        !message.streaming &&
        !message.compactMarker &&
        !message.webchatRunState &&
        !message.webchatCompletionReason,
    );
  return positiveIntOrZero(latest?.timestamp);
}

export function evaluateConversationForkEligibility(params: {
  system: ConversationSystem | null | undefined;
  assistantTimestamp: unknown;
  assistantMessage?: ConversationForkEligibilityMessage | null;
  history?: readonly ConversationForkEligibilityMessage[] | null;
  pendingResponse?: boolean;
  webchatMode?: boolean;
  requireProviderSession?: boolean;
  sourceProviderSessionId?: string | null;
}): ConversationForkEligibility {
  const hasHistory = params.history !== undefined && params.history !== null;
  const latestForkableAssistantTimestamp = hasHistory
    ? getLatestCompletedForkableAssistantTimestamp(params.history)
    : 0;
  const blocked = (
    reason: ConversationForkEligibilityReason,
  ): ConversationForkEligibility => ({
    allowed: false,
    visible: false,
    reason,
    latestForkableAssistantTimestamp,
  });

  if (params.pendingResponse) return blocked("pending_response");
  if (params.webchatMode) return blocked("webchat");
  if (params.system === "claude_code") return blocked("claude_code");
  if (params.system !== "upstream" && params.system !== "codex") {
    return blocked("unsupported_system");
  }

  const assistantTimestamp = positiveIntOrZero(params.assistantTimestamp);
  if (
    !assistantTimestamp ||
    params.assistantMessage === null ||
    (params.assistantMessage !== undefined &&
      params.assistantMessage.role !== "assistant")
  ) {
    return blocked("invalid_turn");
  }

  const assistantMessage = params.assistantMessage || null;
  if (
    assistantMessage?.webchatRunState ||
    assistantMessage?.webchatCompletionReason
  ) {
    return blocked("webchat");
  }
  if (assistantMessage?.compactMarker) return blocked("compact_marker");

  if (
    params.system === "codex" &&
    hasHistory &&
    latestForkableAssistantTimestamp !== assistantTimestamp
  ) {
    return blocked("codex_older_turn");
  }
  if (
    params.system === "codex" &&
    params.requireProviderSession &&
    !hasProviderSessionId(params.sourceProviderSessionId)
  ) {
    return blocked("missing_provider_session");
  }

  return {
    allowed: true,
    visible: true,
    latestForkableAssistantTimestamp,
  };
}
