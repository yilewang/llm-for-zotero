import type { ConversationSystem } from "../../shared/types";

/** One entry of the runtime badge menu. */
export type RuntimeBadgeItem = {
  system: ConversationSystem;
  label: string;
};

export type RuntimeBadgeStateInput = {
  system: ConversationSystem;
  agentEnabled: boolean;
  codexEnabled: boolean;
  claudeEnabled: boolean;
  isWebChat: boolean;
  /** The window's temporary side chat: the built-in runtime only. */
  isSideChat: boolean;
  /**
   * A torn-off (follower) window: it keeps the runtime of the chat it holds,
   * so the badge names it and switches nothing.
   */
  isTornWindow?: boolean;
};

export type RuntimeBadgeState = {
  /** False hides the badge (WebChat, or no runtime is on). */
  visible: boolean;
  /** Text shown on the badge itself. */
  label: string;
  /** True when a click opens the runtime menu. */
  clickable: boolean;
  /** Menu entries, in display order; the built-in runtime comes first. */
  items: RuntimeBadgeItem[];
};

/** The badge reads "Claude", not "Claude Code". */
export function getRuntimeBadgeLabel(
  system: ConversationSystem,
  agentEnabled: boolean,
): string {
  if (system === "codex") return "Codex";
  if (system === "claude_code") return "Claude";
  return agentEnabled ? "Agent" : "Chat";
}

export function resolveRuntimeBadgeState(
  input: RuntimeBadgeStateInput,
): RuntimeBadgeState {
  const label = getRuntimeBadgeLabel(input.system, input.agentEnabled);
  const items: RuntimeBadgeItem[] = input.isTornWindow
    ? [{ system: input.system, label }]
    : [
        {
          system: "upstream",
          label: getRuntimeBadgeLabel("upstream", input.agentEnabled),
        },
      ];
  if (!input.isSideChat && !input.isTornWindow) {
    if (input.codexEnabled) items.push({ system: "codex", label: "Codex" });
    if (input.claudeEnabled) {
      items.push({ system: "claude_code", label: "Claude" });
    }
  }
  // A panel already running Codex or Claude keeps its label even if that
  // runtime was just turned off in Preferences, as the static badge did.
  const anyRuntimeOn =
    input.agentEnabled ||
    input.codexEnabled ||
    input.claudeEnabled ||
    input.system !== "upstream";
  const visible = !input.isWebChat && anyRuntimeOn;
  return {
    visible,
    label,
    clickable: visible && items.length >= 2,
    items,
  };
}
