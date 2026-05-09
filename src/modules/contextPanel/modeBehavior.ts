import type { ChatRuntimeMode, PaperContextRef } from "./types";

export type RuntimeModeResolutionInput = {
  cachedMode?: ChatRuntimeMode | null;
  isRuntimeConversationSystem?: boolean;
  runtimeConversationSystem?: "upstream" | "claude_code" | "codex" | string | null;
  isWebChat?: boolean;
  agentModeEnabled?: boolean;
  displayConversationKind?: "global" | "paper" | null;
  noteKind?: "standalone" | "item" | string | null;
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
  if (input.cachedMode === "agent" || input.cachedMode === "chat") {
    return input.cachedMode;
  }
  if (input.noteKind === "standalone" || input.noteKind === "item") {
    return "agent";
  }
  if (input.displayConversationKind === "global") return "agent";
  return "chat";
}
