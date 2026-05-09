type StatusLevel = "ready" | "warning" | "error";

type ClearConversationControllerDeps = {
  getConversationKey: () => number | null;
  getCurrentItemID: () => number | null;
  clearPendingTurnDeletion?: (conversationKey: number) => void;
  clearTransientComposeStateForItem: (itemId: number) => void;
  resetComposePreviewUI: () => void;
  resetConversationHistory: (conversationKey: number) => void;
  markConversationLoaded: (conversationKey: number) => void;
  clearStoredConversation: (conversationKey: number) => Promise<void>;
  resetConversationTitle: (conversationKey: number) => Promise<void>;
  clearOwnerAttachmentRefs: (
    ownerType: "conversation",
    ownerKey: number,
  ) => Promise<void>;
  removeConversationAttachmentFiles: (conversationKey: number) => Promise<void>;
  refreshChatPreservingScroll: () => void;
  refreshGlobalHistoryHeader: () => void | Promise<void>;
  scheduleAttachmentGc: () => void;
  clearAgentToolCaches?: (conversationKey: number) => void;
  setStatusMessage?: (message: string, level: StatusLevel) => void;
  logError?: (message: string, error: unknown) => void;
  isWebChatActive?: () => boolean; // [webchat]
  getWebChatHost?: () => string; // [webchat]
  markNextWebChatSendAsNewChat?: () => void; // [webchat]
};

export function createClearConversationController(
  deps: ClearConversationControllerDeps,
): {
  clearCurrentConversation: () => Promise<void>;
} {
  const clearCurrentConversation = async () => {
    const conversationKey = deps.getConversationKey();
    const currentItemID = deps.getCurrentItemID();
    if (
      !Number.isFinite(conversationKey) ||
      (conversationKey as number) <= 0 ||
      !Number.isFinite(currentItemID) ||
      (currentItemID as number) <= 0
    ) {
      return;
    }

    const normalizedConversationKey = Math.floor(conversationKey as number);
    const normalizedItemID = Math.floor(currentItemID as number);

    deps.clearPendingTurnDeletion?.(normalizedConversationKey);
    deps.clearTransientComposeStateForItem(normalizedItemID);
    deps.resetConversationHistory(normalizedConversationKey);
    deps.markConversationLoaded(normalizedConversationKey);
    deps.clearAgentToolCaches?.(normalizedConversationKey);
    deps.resetComposePreviewUI();

    try {
      await deps.clearStoredConversation(normalizedConversationKey);
    } catch (err) {
      deps.logError?.("LLM: Failed to clear persisted chat history", err);
    }
    try {
      await deps.resetConversationTitle(normalizedConversationKey);
    } catch (err) {
      deps.logError?.("LLM: Failed to reset conversation title", err);
    }
    try {
      await deps.clearOwnerAttachmentRefs(
        "conversation",
        normalizedConversationKey,
      );
    } catch (err) {
      deps.logError?.("LLM: Failed to clear conversation attachment refs", err);
    }
    try {
      await deps.removeConversationAttachmentFiles(normalizedConversationKey);
    } catch (err) {
      deps.logError?.("LLM: Failed to clear chat attachment files", err);
    }

    deps.refreshChatPreservingScroll();
    await deps.refreshGlobalHistoryHeader();
    deps.scheduleAttachmentGc();
    deps.setStatusMessage?.("Cleared", "ready");
  };

  return { clearCurrentConversation };
}
