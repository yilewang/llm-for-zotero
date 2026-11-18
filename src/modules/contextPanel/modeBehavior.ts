import type { ChatRuntimeMode, PaperContextRef } from "./types";
import {
  isRuntimeConversationSystem,
  type RuntimeConversationSystem,
} from "../../core/conversations/conversationSystems";

export type RuntimeModeResolutionInput = {
  isRuntimeConversationSystem?: boolean;
  runtimeConversationSystem?:
    | "upstream"
    | "claude_code"
    | "codex"
    | string
    | null;
  isWebChat?: boolean;
  agentModeEnabled?: boolean;
};

export function isSamePaperContextRef(
  left: PaperContextRef | null | undefined,
  right: PaperContextRef | null | undefined,
): boolean {
  if (!left || !right) return false;
  return (
    Math.floor(Number(left.itemId)) === Math.floor(Number(right.itemId)) &&
    Math.floor(Number(left.contextItemId)) ===
      Math.floor(Number(right.contextItemId))
  );
}

export function filterManualPaperContextsAgainstAutoLoaded(
  paperContexts: PaperContextRef[],
  autoLoadedPaperContext: PaperContextRef | null | undefined,
): PaperContextRef[] {
  if (!autoLoadedPaperContext) return paperContexts.slice();
  return paperContexts.filter(
    (paperContext) =>
      !isSamePaperContextRef(paperContext, autoLoadedPaperContext),
  );
}

/** The mode each external runtime always runs in. */
const RUNTIME_CONVERSATION_MODE: Record<
  RuntimeConversationSystem,
  ChatRuntimeMode
> = {
  codex: "chat",
  claude_code: "agent",
  // Antigravity runs through the shared agent engine like Claude Code (D4).
  antigravity: "agent",
};

/**
 * The built-in runtime is always Agent while the Agent feature is on and
 * WebChat is off. Nothing chosen earlier (a cached per-conversation mode or a
 * saved last-used mode) changes that. Codex stays chat; Claude Code is agent.
 */
export function resolveRuntimeModeForConversation(
  input: RuntimeModeResolutionInput,
): ChatRuntimeMode {
  const runtimeSystem = input.runtimeConversationSystem;
  if (isRuntimeConversationSystem(runtimeSystem)) {
    return RUNTIME_CONVERSATION_MODE[runtimeSystem];
  }
  if (input.isRuntimeConversationSystem) return "agent";
  if (input.isWebChat) return "chat";
  if (!input.agentModeEnabled) return "chat";
  return "agent";
}
