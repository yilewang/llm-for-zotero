import type { Message } from "./types";

type EditabilityAssistantTurn =
  | Pick<Message, "role" | "runMode">
  | null
  | undefined;

export function canEditUserPromptTurn(params: {
  isUser: boolean;
  hasItem: boolean;
  conversationIsIdle: boolean;
  assistantPair: EditabilityAssistantTurn;
  /** [webchat] Provider protocol — editing is disabled for web_sync. */
  providerProtocol?: string;
}): boolean {
  return Boolean(
    params.isUser &&
    params.hasItem &&
    params.conversationIsIdle &&
    params.assistantPair?.role === "assistant" &&
    params.providerProtocol !== "web_sync",
  );
}
