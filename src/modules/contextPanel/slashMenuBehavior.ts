import type { ConversationSystem } from "../../shared/types";
import type { ChatRuntimeMode } from "./types";

export type SlashActionChatMode = "paper" | "library";
export type SlashBaseMenuItem =
  | "upload"
  | "reference"
  | "pdfPage"
  | "pdfMultiplePages";

export function resolveSlashActionChatMode(
  displayConversationKind: "global" | "paper" | null | undefined,
): SlashActionChatMode {
  return displayConversationKind === "global" ? "library" : "paper";
}

export function getBaseSlashMenuItems(
  mode: SlashActionChatMode,
): SlashBaseMenuItem[] {
  return mode === "library"
    ? ["upload", "reference"]
    : ["upload", "reference", "pdfPage", "pdfMultiplePages"];
}

export function shouldRenderDynamicSlashMenu(params: {
  itemPresent?: boolean;
  isWebChat?: boolean;
  runtimeMode?: ChatRuntimeMode | string | null;
  conversationSystem?: ConversationSystem | string | null;
}): boolean {
  if (params.itemPresent === false || params.isWebChat) return false;
  if (params.runtimeMode === "agent") return true;
  return (
    params.conversationSystem === "codex" ||
    params.conversationSystem === "claude_code"
  );
}

export function shouldRenderSkillSlashMenu(params: {
  itemPresent?: boolean;
  isWebChat?: boolean;
  runtimeMode?: ChatRuntimeMode | string | null;
  conversationSystem?: ConversationSystem | string | null;
}): boolean {
  if (params.itemPresent === false || params.isWebChat) return false;
  if (params.conversationSystem === "claude_code") return false;
  if (params.runtimeMode === "agent") return true;
  return params.conversationSystem === "codex";
}
