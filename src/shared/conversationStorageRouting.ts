import type { ConversationSystem } from "./types";
import { classifyConversationKey } from "./conversationKeySpace";
import { isConversationSystem } from "./conversationSystems";

export function resolveConversationStorageSystem(params: {
  conversationKey: number;
  conversationSystem?: ConversationSystem | null;
}): ConversationSystem | null {
  if (isConversationSystem(params.conversationSystem)) {
    return params.conversationSystem;
  }
  return classifyConversationKey(params.conversationKey)?.system || null;
}
