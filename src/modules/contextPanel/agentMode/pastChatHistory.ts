/**
 * Puts attached past chats back into the history handed to the built-in
 * agent and to Claude Code.
 *
 * On the turn a user message attaches past chats, the agent runtime renders
 * them once into the transcript, right before that turn's request. When the
 * transcript is rebuilt from chat history (first turn after an edit, a retry,
 * a fork, or a temporary side chat), that message would be lost. So the
 * history gets one past-chat user message before each user message that
 * delivered chats, and the rebuilt transcript keeps it at the same place.
 *
 * Claude Code receives the chats as a prefix of the delivering turn's text
 * (externalBackendBridge.ts); this history reaches the bridge only when the
 * Claude session cannot be resumed. A slash message delivers nothing there,
 * and the next non-slash message carries its chats, so the history uses the
 * same rule (resolveDeliveredPastChatRefs) and the same render memo: the
 * fallback replay puts each block before the message that delivered it.
 *
 * Codex receives past chats through chat.ts, not through this history.
 *
 * A chat the agent attached with past_chat_attach (via "agent") is kept in a
 * rebuilt history, before the message that holds it, like a picked chip: the
 * tool result that held its text is not replayed there. The current turn
 * leaves it out (resolveCurrentTurnDeliveredPastChats): that turn's session
 * holds the tool result.
 */
import { LocalDocumentPathStreamRedactor } from "../../../agent/privacy/localDocumentPathRedaction";
import { resolveAgentPromptBudgetLimits } from "../../../agent/context/promptBudget";
import {
  insertPastChatMessagesBeforeAttachingTurns,
  renderAgentPastChatMessageText,
  type PastConversationSource,
} from "../../../services/pastConversations/pastConversationLoader";
import { resolveDeliveredPastChatRefs } from "../../../services/pastConversations/pastConversationText";
import type { AttachedConversationRef } from "../../../shared/types";
import type { ChatMessage } from "../../../utils/llmClient";
import type { EffectiveRequestConfig } from "../requestContext";

type HistorySourceMessage = {
  role?: unknown;
  /** The stored text: displayQuestion || question for a user message. */
  text?: unknown;
  timestamp?: number;
  attachedConversations?: AttachedConversationRef[];
};

type PastChatBudgetConfig = Pick<
  EffectiveRequestConfig,
  "model" | "apiBase" | "providerProtocol" | "authMode" | "advanced"
>;

/**
 * The context window the agent-mode past-chat budget is computed from; the
 * same inputs give the same window wherever a turn's chats are rendered.
 */
function resolveAgentPastChatContextWindow(
  config: PastChatBudgetConfig,
): number | undefined {
  try {
    return resolveAgentPromptBudgetLimits({
      model: config.model,
      inputTokenCap: config.advanced?.inputTokenCap,
      apiBase: config.apiBase,
      providerProtocol: config.providerProtocol,
      authMode: config.authMode,
      profileOverride: config.advanced?.profileOverride,
      outputTokenLimit: config.advanced?.outputTokenLimit,
    }).contextWindow;
  } catch {
    return undefined;
  }
}

export async function injectAttachedPastChatsIntoAgentHistory(params: {
  conversationKey: number;
  /**
   * The turn's conversation system; "upstream" and "claude_code" get past
   * chats.
   */
  conversationSystem: string;
  libraryID: number | undefined;
  /** The chat messages `history` was built from, one to one. */
  messages: readonly HistorySourceMessage[];
  history: ChatMessage[];
  effectiveRequestConfig: PastChatBudgetConfig;
  source?: PastConversationSource;
}): Promise<ChatMessage[]> {
  const system = params.conversationSystem;
  if (system !== "upstream" && system !== "claude_code") return params.history;
  const delivered = params.messages.map((_message, index) =>
    resolveDeliveredPastChatRefs(params.messages, index, system),
  );
  if (!delivered.some((refs) => refs.length)) return params.history;
  const contextWindowTokens = resolveAgentPastChatContextWindow(
    params.effectiveRequestConfig,
  );
  // The attach turn stores the redacted text; a rebuild applies the same
  // redaction so both hold the same bytes.
  const redactor = new LocalDocumentPathStreamRedactor(params.conversationKey);
  try {
    return await insertPastChatMessagesBeforeAttachingTurns<ChatMessage>(
      params.messages.map((message, index) => ({
        role: message.role,
        attachedConversations: delivered[index],
      })),
      params.history,
      async (_message, index) => {
        const text = await renderAgentPastChatMessageText({
          conversationKey: params.conversationKey,
          userMessageTimestamp: params.messages[index].timestamp,
          refs: delivered[index],
          libraryID: params.libraryID,
          contextWindowTokens,
          source: params.source,
        });
        return text
          ? { role: "user", content: redactor.redactTerminalText(text) }
          : null;
      },
    );
  } catch {
    // A past chat that cannot be loaded never blocks the turn.
    return params.history;
  }
}

/**
 * The past chats a Claude Code turn puts in front of its text, or undefined
 * for another system or when there are none. `history` is the turn's own
 * history source (the messages before this turn); `current.text` is the
 * runtime userText (question), which is what reaches the bridge's slash
 * check, while stored history rows hold displayQuestion || question.
 */
export function resolveCurrentTurnDeliveredPastChats(params: {
  conversationSystem: string;
  history: readonly HistorySourceMessage[];
  current: { text: string; attachedConversations?: AttachedConversationRef[] };
}): AttachedConversationRef[] | undefined {
  if (params.conversationSystem !== "claude_code") return undefined;
  const refs = resolveDeliveredPastChatRefs(
    [...params.history, { role: "user", ...params.current }],
    params.history.length,
    "claude_code",
    { excludeAgentAttached: true },
  );
  return refs.length ? refs : undefined;
}
