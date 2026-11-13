/**
 * The one way a past chat the agent found reaches the user's message.
 *
 * past_chat_attach (agent tier) never writes a store: the conversation panel
 * (modules tier) owns the user message, and every later whole-row write of
 * that row is made from the in-memory message. So the tool reports the attach
 * here and awaits the answer; the panel registers the one handler at startup,
 * adds the reference to the in-memory message, saves the row, and refreshes
 * the chip. MCP tool calls run in this process, so the same handler serves
 * the built-in agent, Claude Code and Codex.
 *
 * Without a handler (no panel loaded) the attach is refused: a reference
 * written to the database alone would be overwritten by the next whole-row
 * write and would not reach the next turn's scope.
 */
import type {
  AttachedConversationRef,
  ConversationSystem,
} from "../../shared/types";

export type PastChatAttachRequest = {
  /** The conversation the agent is answering in. */
  conversationKey: number;
  /** The system of that conversation, for the store routing. */
  conversationSystem: ConversationSystem;
  /** Timestamp of the user message the chat is added to. */
  userMessageTimestamp: number;
  ref: AttachedConversationRef;
};

export type PastChatAttachOutcome =
  | { ok: true }
  | {
      ok: false;
      /**
       * no_handler: no panel is loaded; not_found: the user message is not
       * in memory; temporary: the conversation is never saved; full: the
       * message already holds the most chats one message may attach; error:
       * the handler failed.
       */
      reason: "no_handler" | "not_found" | "temporary" | "full" | "error";
    };

export type PastChatAttachHandler = (
  request: PastChatAttachRequest,
) => Promise<PastChatAttachOutcome>;

let handler: PastChatAttachHandler | null = null;

/** Registers the panel's handler (once, at startup); null removes it. */
export function setPastChatAttachHandler(
  next: PastChatAttachHandler | null,
): void {
  handler = next;
}

/**
 * Adds an agent-found chat to the user message and resolves once the
 * in-memory message holds it and the row write has finished. Never throws.
 */
export async function notifyPastChatAttached(
  request: PastChatAttachRequest,
): Promise<PastChatAttachOutcome> {
  const current = handler;
  if (!current) return { ok: false, reason: "no_handler" };
  try {
    return await current(request);
  } catch {
    return { ok: false, reason: "error" };
  }
}
