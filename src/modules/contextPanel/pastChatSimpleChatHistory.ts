/**
 * Puts attached past chats into the history simple chat sends.
 *
 * Simple chat keeps no transcript: its history is rebuilt from the chat
 * messages every turn. So every turn, the history gets one past-chat user
 * message (never a system message) right before each user message that
 * attached chats, and the current turn's chats go last, right before the
 * prompt. Simple chat has no tools, so each chat is cut to its newest part
 * (trimmed mode) within min(24,000 characters, about 15% of the model's
 * context window), shared by the chats of one message. All attaching
 * messages together get twice that; older ones that do not fit become one
 * short line each.
 *
 * The text is memoized per conversation and user message, so a later turn
 * sends the same bytes at the same place and the provider's prompt cache
 * keeps working.
 *
 * Codex uses the same history for a thread it seeds from chat history (a new,
 * replaced, raw-PDF or failed-resume thread): the chats of earlier messages
 * go before the messages that attached them, while the current turn's chats
 * go into the turn input only (renderCodexCurrentTurnPastChatText), so a new
 * thread never gets them twice. With Codex's Zotero MCP tools on, the chats
 * render as the built-in agent's do (full or an outline opened with
 * past_chat_read); with the tools off, trimmed as in simple chat.
 *
 * Claude Code (agentMode/pastChatHistory.ts) and WebChat (blocked) receive
 * nothing here.
 */
import {
  buildPastChatMessageText,
  buildPastChatMessageTextMemoized,
  insertPastChatMessagesBeforeAttachingTurns,
  type PastChatRenderMode,
  type PastConversationSource,
} from "../../services/pastConversations/pastConversationLoader";
import {
  formatPastChatPointerLine,
  pastConversationId,
  resolvePastChatFullTextBudget,
  resolvePastChatSimpleChatBudgetChars,
  withoutAgentAttachedConversationRefs,
} from "../../services/pastConversations/pastConversationText";
import type {
  AdvancedModelParams,
  AttachedConversationRef,
} from "../../shared/types";
import type { ChatMessage } from "../../utils/llmClient";
import { resolveModelInputTokenLimit } from "../../utils/modelInputCap";
import { detectProviderPreset } from "../../utils/providerPresets";
import type { EffectiveRequestConfig } from "./requestContext";

export type SimpleChatPastChatSourceMessage = {
  role?: unknown;
  timestamp?: number;
  attachedConversations?: AttachedConversationRef[];
};

/** Memo key of simple chat's past-chat message for one user message. */
export function simpleChatPastChatMemoKey(
  conversationKey: number,
  userMessageTimestamp: number,
): string {
  return `chat:${conversationKey}:${userMessageTimestamp}`;
}

/** Memo key of Codex's past-chat message for one user message. */
export function codexPastChatMemoKey(
  conversationKey: number,
  userMessageTimestamp: number,
): string {
  return `codex:${conversationKey}:${userMessageTimestamp}`;
}

function attachesPastChats(
  message: SimpleChatPastChatSourceMessage | undefined,
): boolean {
  return Boolean(
    message?.role === "user" && message.attachedConversations?.length,
  );
}

/**
 * The model's input limit, resolved as the request's own input cap does
 * (finalPrepared.inputCap.limitTokens); undefined when it cannot be read.
 */
function resolveInputLimitTokens(
  config: SimpleChatPastChatConfig,
): number | undefined {
  try {
    return resolveModelInputTokenLimit(
      config.model || "",
      config.advanced?.inputTokenCap,
      {
        provider: detectProviderPreset(config.apiBase || "").toString(),
        apiBase: config.apiBase,
        protocol: config.providerProtocol,
        authMode: config.authMode,
        profileOverride: config.advanced?.profileOverride,
      },
    ).limitTokens;
  } catch {
    return undefined;
  }
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The one line that stands in for an attaching message's chats once they no
 * longer fit. It depends only on the message's own chat titles, so its bytes
 * stay the same from turn to turn.
 */
function formatLeftOutLine(
  message: SimpleChatPastChatSourceMessage | undefined,
): string {
  const titles = (message?.attachedConversations || [])
    .map((ref) => singleLine(ref.title || ""))
    .filter(Boolean)
    .join(", ");
  return `Past chats attached earlier in this conversation (${titles}) were left out to save space.`;
}

/**
 * The pointer lines that stand in for an attaching message's chats once they
 * no longer fit, when past_chat_read can open them again.
 */
function formatLeftOutPointerLines(
  message: SimpleChatPastChatSourceMessage | undefined,
): string {
  return (message?.attachedConversations || [])
    .map((ref) =>
      formatPastChatPointerLine({
        id: pastConversationId(ref),
        title:
          singleLine(ref.title || "") || `Conversation ${ref.conversationKey}`,
      }),
    )
    .join("\n");
}

/**
 * How one conversation's past chats render: the mode, the memo key of a
 * user message, the budget for all attaching messages together, and the
 * line that replaces a message that no longer fits. The history and Codex's
 * current-turn block use the same one, so a message renders to the same
 * bytes in both places.
 */
type PastChatHistoryRender = {
  mode: PastChatRenderMode;
  memoKey: (userMessageTimestamp: number) => string;
  conversationMaxChars: number;
  leftOutLine: (message: SimpleChatPastChatSourceMessage | undefined) => string;
};

function resolveHistoryRender(params: {
  conversationKey: number;
  conversationSystem: string;
  pastChatReadAvailable?: boolean;
  config: SimpleChatPastChatConfig;
}): PastChatHistoryRender {
  const limitTokens = resolveInputLimitTokens(params.config);
  const isCodex = params.conversationSystem === "codex";
  const memoKey = (timestamp: number) =>
    isCodex
      ? codexPastChatMemoKey(params.conversationKey, timestamp)
      : simpleChatPastChatMemoKey(params.conversationKey, timestamp);
  if (isCodex && params.pastChatReadAvailable) {
    const fullTextBudgetTokens = resolvePastChatFullTextBudget(limitTokens);
    return {
      mode: { kind: "agent", fullTextBudgetTokens },
      memoKey,
      // Twice one turn's budget, at about four characters a token.
      conversationMaxChars: fullTextBudgetTokens * 4 * 2,
      leftOutLine: formatLeftOutPointerLines,
    };
  }
  const totalMaxChars = resolvePastChatSimpleChatBudgetChars(limitTokens);
  return {
    mode: { kind: "trimmed", totalMaxChars },
    memoKey,
    conversationMaxChars: totalMaxChars * 2,
    leftOutLine: formatLeftOutLine,
  };
}

async function renderHistoryMessage(
  message: SimpleChatPastChatSourceMessage,
  render: PastChatHistoryRender,
  params: { libraryID: number | undefined; source?: PastConversationSource },
): Promise<string | null> {
  if (!attachesPastChats(message)) return null;
  const renderParams = {
    refs: message.attachedConversations,
    libraryID: params.libraryID,
    mode: render.mode,
    source: params.source,
  };
  const timestamp = Number(message.timestamp);
  return Number.isFinite(timestamp) && timestamp > 0
    ? buildPastChatMessageTextMemoized(render.memoKey(timestamp), renderParams)
    : buildPastChatMessageText(renderParams);
}

/**
 * Caps the past-chat text of the whole conversation at `maxChars`. Walks the
 * attaching messages newest first and keeps whole messages while they fit;
 * the first one that does not fit, and every older one, becomes a short
 * stable line. A kept message is never cut again, and the current turn's
 * message is always kept, so the bytes of a kept message do not change.
 */
function applyConversationBudget(
  texts: ReadonlyArray<string | null>,
  sources: ReadonlyArray<SimpleChatPastChatSourceMessage>,
  maxChars: number,
  lastIsCurrent: boolean,
  leftOutLine: PastChatHistoryRender["leftOutLine"],
): Array<string | null> {
  const out: Array<string | null> = new Array(texts.length).fill(null);
  let used = 0;
  let omitting = false;
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const text = texts[index];
    if (!text) continue;
    const isCurrent = lastIsCurrent && index === texts.length - 1;
    if (isCurrent || (!omitting && used + text.length <= maxChars)) {
      used += text.length;
      out[index] = text;
      continue;
    }
    omitting = true;
    out[index] = leftOutLine(sources[index]);
  }
  return out;
}

type SimpleChatPastChatConfig = Pick<
  EffectiveRequestConfig,
  "model" | "apiBase" | "providerProtocol" | "authMode"
> & {
  advanced?: Pick<AdvancedModelParams, "inputTokenCap" | "profileOverride">;
};

/**
 * The history to send, with past-chat messages added; `history` itself when
 * nothing is attached or the turn is not a plain upstream chat. Never
 * throws: a past chat that cannot be rendered leaves the history as it was.
 */
/**
 * The current user message to pass to the history injection: a native Codex
 * turn never passes it (its chats go into the turn input), so a new thread
 * never gets them twice.
 */
export function pastChatHistoryCurrentMessage<
  T extends SimpleChatPastChatSourceMessage,
>(isCodexNativeTurn: boolean, message: T | undefined): T | undefined {
  return isCodexNativeTurn ? undefined : message;
}

export async function addAttachedPastChatsToSimpleChatHistory(params: {
  conversationKey: number;
  /**
   * The turn's conversation system; "upstream" (simple chat) and "codex" get
   * past chats.
   */
  conversationSystem: string;
  /**
   * Codex gets past chats only on a native app-server turn; a Codex
   * conversation outside the app-server gets none.
   */
  includeCodex?: boolean;
  /**
   * Codex only: past_chat_read is reachable (the Zotero MCP tools are on),
   * so chats render in full or as an outline instead of trimmed.
   */
  pastChatReadAvailable?: boolean;
  libraryID: number | undefined;
  /** The chat messages `rawHistory` was built from, one to one. */
  messages: readonly SimpleChatPastChatSourceMessage[];
  /** The model messages built from `messages`. */
  rawHistory: ChatMessage[];
  /**
   * The history the request sends: `rawHistory`, or its compressed form (a
   * summary, then the newest messages of `rawHistory` as the same objects).
   * Defaults to `rawHistory`.
   */
  history?: ChatMessage[];
  /**
   * The user message whose question is the request's prompt. Codex leaves it
   * out: its current turn's chats go into the turn input.
   */
  currentMessage?: SimpleChatPastChatSourceMessage;
  effectiveRequestConfig: SimpleChatPastChatConfig;
  source?: PastConversationSource;
}): Promise<ChatMessage[]> {
  const history = params.history || params.rawHistory;
  const config = params.effectiveRequestConfig;
  if (
    params.conversationSystem !== "upstream" &&
    !(params.conversationSystem === "codex" && params.includeCodex)
  ) {
    return history;
  }
  if (config.authMode === "webchat" || config.providerProtocol === "web_sync")
    return history;
  const mapsOneToOne = params.messages.length === params.rawHistory.length;
  const historySources = mapsOneToOne ? params.messages : [];
  if (
    !historySources.some(attachesPastChats) &&
    !attachesPastChats(params.currentMessage)
  ) {
    return history;
  }
  const historyRender = resolveHistoryRender({
    conversationKey: params.conversationKey,
    conversationSystem: params.conversationSystem,
    pastChatReadAvailable: params.pastChatReadAvailable,
    config,
  });
  try {
    const sources = params.currentMessage
      ? [...historySources, params.currentMessage]
      : [...historySources];
    const rendered = await Promise.all(
      sources.map((message) =>
        renderHistoryMessage(message, historyRender, params),
      ),
    );
    // The budget runs first. A copy is then dropped only when an older KEPT
    // copy has the same text, so earlier history keeps its bytes and a chat
    // attached again after its first copy was left out still reaches the model.
    const budgeted = applyConversationBudget(
      rendered,
      sources,
      historyRender.conversationMaxChars,
      Boolean(params.currentMessage),
      historyRender.leftOutLine,
    );
    const keptFull = new Set<string>();
    const texts = budgeted.map((text, index) => {
      if (!text) return null;
      if (text !== rendered[index]) return text;
      if (keptFull.has(text)) return null;
      keptFull.add(text);
      return text;
    });
    const toMessage = (text: string | null): ChatMessage | null =>
      text ? { role: "user", content: text } : null;

    // The newest messages of a compressed history are the same objects as
    // the end of rawHistory; the rest was summarized.
    let kept = 0;
    while (
      kept < history.length &&
      kept < params.rawHistory.length &&
      history[history.length - 1 - kept] ===
        params.rawHistory[params.rawHistory.length - 1 - kept]
    ) {
      kept += 1;
    }
    const summarizedCount = mapsOneToOne ? params.rawHistory.length - kept : 0;
    const out: ChatMessage[] = history.slice(0, history.length - kept);
    // A summarized turn's past chat stays, right after the summary: the
    // summary keeps only the questions, and simple chat cannot reopen it.
    for (let index = 0; index < summarizedCount; index += 1) {
      const message = toMessage(texts[index]);
      if (message) out.push(message);
    }
    out.push(
      ...(mapsOneToOne
        ? await insertPastChatMessagesBeforeAttachingTurns<ChatMessage>(
            historySources.slice(summarizedCount),
            history.slice(history.length - kept),
            async (_message, index) =>
              toMessage(texts[summarizedCount + index]),
          )
        : history.slice(history.length - kept)),
    );
    if (params.currentMessage) {
      const current = toMessage(texts[texts.length - 1]);
      if (current) out.push(current);
    }
    return out;
  } catch {
    // A past chat that cannot be loaded never blocks the turn.
    return history;
  }
}

/**
 * The past-chat block of the Codex turn whose user message is `message`, or
 * null when it attached none or the chats cannot be rendered. It goes into
 * the turn input (nativeClient.ts), never into the seeded history, so a new
 * thread gets it once. Rendered with the history's mode and memo key, so a
 * thread seeded on a later turn carries the same bytes before this message.
 *
 * Only the chats the user picked: a chat the agent attached with
 * past_chat_attach (via "agent") is in that tool result in the Codex thread.
 * A seeded history keeps it (tool results are not replayed there), and a
 * retry on a new thread has it in scope only, for past_chat_read.
 */
export async function renderCodexCurrentTurnPastChatText(params: {
  conversationKey: number;
  libraryID: number | undefined;
  message: SimpleChatPastChatSourceMessage | undefined;
  pastChatReadAvailable: boolean;
  effectiveRequestConfig: SimpleChatPastChatConfig;
  source?: PastConversationSource;
}): Promise<string | null> {
  const message = params.message && {
    ...params.message,
    attachedConversations: withoutAgentAttachedConversationRefs(
      params.message.attachedConversations,
    ),
  };
  if (!message || !attachesPastChats(message)) return null;
  try {
    return await renderHistoryMessage(
      message,
      resolveHistoryRender({
        conversationKey: params.conversationKey,
        conversationSystem: "codex",
        pastChatReadAvailable: params.pastChatReadAvailable,
        config: params.effectiveRequestConfig,
      }),
      params,
    );
  } catch {
    // A past chat that cannot be loaded never blocks the turn.
    return null;
  }
}
