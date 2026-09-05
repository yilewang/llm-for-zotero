export type ConversationDeletionActivationKind = "global" | "paper";

export type ConversationDeletionActivationDeps = {
  createFreshGlobalConversation: () => Promise<boolean | void>;
  createFreshPaperConversation: () => Promise<boolean | void>;
  log?: (message: string, ...args: unknown[]) => void;
};

export async function clearActiveConversationForPendingDeletion(
  kind: ConversationDeletionActivationKind,
  deps: ConversationDeletionActivationDeps,
): Promise<boolean> {
  try {
    const result =
      kind === "paper"
        ? await deps.createFreshPaperConversation()
        : await deps.createFreshGlobalConversation();
    return result === true;
  } catch (err) {
    deps.log?.("LLM: Failed to clear active conversation for deletion", {
      kind,
      error: err,
    });
    return false;
  }
}
