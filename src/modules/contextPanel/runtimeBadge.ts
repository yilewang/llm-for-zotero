import type { ConversationSystem } from "../../shared/types";
import {
  getRuntimeConversationSystemDescriptor,
  isRuntimeConversationSystem,
  type RuntimeConversationSystem,
} from "../../core/conversations/conversationSystems";
import { RUNTIME_SYSTEM_DISPLAY_ORDER } from "./runtimeSystemControls";

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
  return isRuntimeConversationSystem(system)
    ? getRuntimeConversationSystemDescriptor(system).shortLabel
    : agentEnabled
      ? "Agent"
      : "Chat";
}

export function resolveRuntimeBadgeState(
  input: RuntimeBadgeStateInput,
): RuntimeBadgeState {
  const label = getRuntimeBadgeLabel(input.system, input.agentEnabled);
  const runtimeEnabled: Record<RuntimeConversationSystem, boolean> = {
    codex: input.codexEnabled,
    claude_code: input.claudeEnabled,
  };
  const items: RuntimeBadgeItem[] = input.isTornWindow
    ? [{ system: input.system, label }]
    : [
        {
          system: "upstream",
          label: getRuntimeBadgeLabel("upstream", input.agentEnabled),
        },
      ];
  if (!input.isSideChat && !input.isTornWindow) {
    for (const system of RUNTIME_SYSTEM_DISPLAY_ORDER) {
      if (runtimeEnabled[system]) {
        items.push({
          system,
          label: getRuntimeBadgeLabel(system, input.agentEnabled),
        });
      }
    }
  }
  // A panel already running Codex or Claude keeps its label even if that
  // runtime was just turned off in Preferences, as the static badge did.
  const anyRuntimeOn =
    input.agentEnabled ||
    RUNTIME_SYSTEM_DISPLAY_ORDER.some((system) => runtimeEnabled[system]) ||
    input.system !== "upstream";
  const visible = !input.isWebChat && anyRuntimeOn;
  return {
    visible,
    label,
    clickable: visible && items.length >= 2,
    items,
  };
}
