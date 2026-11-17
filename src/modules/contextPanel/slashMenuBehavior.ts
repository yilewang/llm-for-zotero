import type { ConversationSystem } from "../../shared/types";
import {
  isRuntimeConversationSystem,
  type RuntimeConversationSystem,
} from "../../core/conversations/conversationSystems";
import type { ChatRuntimeMode } from "./types";

export type SlashActionChatMode = "paper" | "library";
export type SlashBaseMenuItem =
  | "upload"
  | "reference"
  | "pastConversation"
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
    ? ["upload", "reference", "pastConversation"]
    : [
        "upload",
        "reference",
        "pastConversation",
        "pdfPage",
        "pdfMultiplePages",
      ];
}

export function shouldRenderDynamicSlashMenu(params: {
  itemPresent?: boolean;
  isWebChat?: boolean;
  runtimeMode?: ChatRuntimeMode | string | null;
  conversationSystem?: ConversationSystem | string | null;
}): boolean {
  if (params.itemPresent === false || params.isWebChat) return false;
  if (params.runtimeMode === "agent") return true;
  return isRuntimeConversationSystem(params.conversationSystem);
}

/** Whether each external runtime shows the skill slash menu, in any mode. */
const RUNTIME_SKILL_SLASH_MENU: Record<RuntimeConversationSystem, boolean> = {
  claude_code: false,
  codex: true,
};

export function shouldRenderSkillSlashMenu(params: {
  itemPresent?: boolean;
  isWebChat?: boolean;
  runtimeMode?: ChatRuntimeMode | string | null;
  conversationSystem?: ConversationSystem | string | null;
}): boolean {
  if (params.itemPresent === false || params.isWebChat) return false;
  if (isRuntimeConversationSystem(params.conversationSystem)) {
    return RUNTIME_SKILL_SLASH_MENU[params.conversationSystem];
  }
  return params.runtimeMode === "agent";
}
