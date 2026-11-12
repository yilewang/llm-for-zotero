import type { ChatRuntimeMode, PaperContextRef } from "./types";

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

/**
 * The built-in runtime is always Agent while the Agent feature is on and
 * WebChat is off. Nothing chosen earlier (a cached per-conversation mode or a
 * saved last-used mode) changes that. Codex stays chat; Claude Code is agent.
 */
export function resolveRuntimeModeForConversation(
  input: RuntimeModeResolutionInput,
): ChatRuntimeMode {
  if (input.runtimeConversationSystem === "codex") return "chat";
  if (
    input.isRuntimeConversationSystem ||
    input.runtimeConversationSystem === "claude_code"
  ) {
    return "agent";
  }
  if (input.isWebChat) return "chat";
  if (!input.agentModeEnabled) return "chat";
  return "agent";
}
