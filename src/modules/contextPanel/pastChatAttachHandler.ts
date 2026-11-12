/**
 * The panel's side of past_chat_attach: the one writer of an agent-found
 * chat into the user's message (services/pastConversations/attachSink.ts).
 *
 * The handler finds the user message in chatHistory by conversation and
 * timestamp and adds the reference to that same Message object. Every later
 * whole-row write of the row (the agent engine's tool-result and finish
 * updates, Codex and Claude Code turns, a retry's restore) is made from this
 * object, so none of them can drop the chip; the next turn's scope comes
 * from it too. Then the row is saved through the conversation's store with
 * the message's timestamp, and the panels showing the conversation redraw
 * the chip.
 *
 * Refused when the message is not in memory (no write to the database
 * alone), for a temporary conversation, and when the message already holds
 * the most chats one message may attach. Adding a chat the message already
 * holds is a success that changes nothing.
 */
import { MAX_ATTACHED_CONVERSATIONS } from "../../services/context/normalizers";
import { pastConversationId } from "../../services/pastConversations/pastConversationText";
import type {
  PastChatAttachHandler,
  PastChatAttachRequest,
} from "../../services/pastConversations/attachSink";
import type { Message } from "./types";

export type PastChatAttachHandlerDeps = {
  /** The in-memory messages of a conversation (chatHistory). */
  getHistory: (conversationKey: number) => readonly Message[] | undefined;
  /** True for a conversation that is never saved (side chat, web chat). */
  isTemporaryConversation: (conversationKey: number) => boolean;
  /** Saves the user row from `message`, targeting that timestamp only. */
  persistUserMessage: (
    request: PastChatAttachRequest,
    message: Message,
  ) => Promise<void>;
  /** Redraws the panels that show the conversation. */
  refreshConversation: (conversationKey: number) => void;
};

export function createPastChatAttachHandler(
  deps: PastChatAttachHandlerDeps,
): PastChatAttachHandler {
  return async (request) => {
    if (deps.isTemporaryConversation(request.conversationKey)) {
      return { ok: false, reason: "temporary" };
    }
    const message = (deps.getHistory(request.conversationKey) || []).find(
      (entry) =>
        entry.role === "user" &&
        entry.timestamp === request.userMessageTimestamp,
    );
    if (!message) return { ok: false, reason: "not_found" };
    const id = pastConversationId(request.ref);
    const current = message.attachedConversations || [];
    if (current.some((ref) => pastConversationId(ref) === id)) {
      return { ok: true };
    }
    if (current.length >= MAX_ATTACHED_CONVERSATIONS) {
      return { ok: false, reason: "full" };
    }
    // Changed before the write starts, so a parallel attach sees it.
    message.attachedConversations = [...current, request.ref];
    try {
      await deps.persistUserMessage(request, message);
    } catch {
      // Not saved: take the chip back, so the message and the tool's
      // refusal agree.
      message.attachedConversations = (
        message.attachedConversations || []
      ).filter((ref) => pastConversationId(ref) !== id);
      if (!message.attachedConversations.length) {
        message.attachedConversations = undefined;
      }
      return { ok: false, reason: "error" };
    }
    deps.refreshConversation(request.conversationKey);
    return { ok: true };
  };
}
