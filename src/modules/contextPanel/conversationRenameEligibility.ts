import type { ConversationSystem } from "../../shared/types";

export type ConversationRenameIdentity = {
  system: ConversationSystem;
  kind: "paper" | "global";
  conversationKey: number;
};

export function isConversationRenameEligible(params: {
  identity: ConversationRenameIdentity | null;
  pendingDelete?: boolean;
  orphan?: boolean;
  requestPending?: boolean;
}): boolean {
  return Boolean(
    params.identity &&
    Number.isFinite(params.identity.conversationKey) &&
    params.identity.conversationKey > 0 &&
    !params.pendingDelete &&
    !params.orphan &&
    !params.requestPending,
  );
}

export function canCommitConversationRename(params: {
  target: ConversationRenameIdentity;
  current: ConversationRenameIdentity | null;
  pendingDelete?: boolean;
  orphan?: boolean;
  requestPending?: boolean;
}): boolean {
  if (
    !isConversationRenameEligible({
      identity: params.current,
      pendingDelete: params.pendingDelete,
      orphan: params.orphan,
      requestPending: params.requestPending,
    })
  ) {
    return false;
  }
  return (
    params.current?.system === params.target.system &&
    params.current.kind === params.target.kind &&
    params.current.conversationKey === params.target.conversationKey
  );
}
