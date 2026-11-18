import type { ConversationSystem } from "../../shared/types";
import {
  getRuntimeConversationSystemDescriptor,
  isRuntimeConversationSystem,
  type RuntimeConversationSystem,
} from "../../core/conversations/conversationSystems";

/** Order of the runtimes in the runtime menu (not the registry order). */
export const RUNTIME_SYSTEM_DISPLAY_ORDER = [
  "codex",
  "claude_code",
  "antigravity",
] as const satisfies readonly RuntimeConversationSystem[];

// Fails to compile when a runtime is missing from the display order above.
const RUNTIME_DISPLAY_ORDER_IS_COMPLETE: Exclude<
  RuntimeConversationSystem,
  (typeof RUNTIME_SYSTEM_DISPLAY_ORDER)[number]
> extends never
  ? true
  : never = true;
void RUNTIME_DISPLAY_ORDER_IS_COMPLETE;

/** One entry of the runtime badge menu. */
export type RuntimeBadgeItem = {
  system: ConversationSystem;
  label: string;
};

export type RuntimeBadgeStateInput = {
  system: ConversationSystem;
  agentEnabled: boolean;
  /** Which runtimes are on (in Preferences, and available on this surface). */
  runtimeEnabled: Record<RuntimeConversationSystem, boolean>;
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
  /** False hides the badge (Agent and every runtime are off). */
  visible: boolean;
  /** Text shown on the badge itself. */
  label: string;
  /** True when a click opens the runtime menu. */
  clickable: boolean;
  /** Menu entries, in display order; the built-in runtime comes first. */
  items: RuntimeBadgeItem[];
  /**
   * The menu ends with "Add runtime…", which opens Settings; a side chat or
   * torn-off window, which cannot change runtime, has none.
   */
  showAddRuntime: boolean;
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
  // In WebChat the badge names WebChat and offers the runtimes to leave it
  // for; going back to an API model stays the model menu's job.
  const label = input.isWebChat
    ? "WebChat"
    : getRuntimeBadgeLabel(input.system, input.agentEnabled);
  const runtimeEnabled = input.runtimeEnabled;
  const items: RuntimeBadgeItem[] = input.isTornWindow
    ? [{ system: input.system, label }]
    : input.isWebChat
      ? []
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
  // The runtime menu is the only way between runtimes, WebChat included.
  const visible = anyRuntimeOn;
  const showAddRuntime = !input.isSideChat && !input.isTornWindow;
  return {
    visible,
    label,
    clickable: visible && (items.length >= 2 || showAddRuntime),
    items,
    showAddRuntime,
  };
}
