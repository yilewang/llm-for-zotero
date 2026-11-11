/**
 * A paper conversation that starts with turns held elsewhere (Inline Ask's
 * "Continue in sidebar"): the turns become real stored messages, the first
 * question carries the selection it was about, and the chat is titled by its
 * first question. Pure: no DOM, no store.
 *
 * A Claude Code chat starts a fresh provider session that gets only the
 * typed message, never the stored history; the panel attaches the paper,
 * page, passage and turns to the first sidebar message instead, as an
 * "Inline Ask" transcript chip. A Codex app-server chat needs no chip: its
 * new thread receives the stored messages as injected history. A plain API
 * chat sends them as history on every turn.
 */
import type { StoredChatMessage } from "../../utils/chatStore";
import type {
  ConversationSystem,
  SelectedTextContext,
} from "../../shared/types";
import { normalizeConversationTitleSeed } from "./setupHandlers/controllers/conversationHistoryController";
import { SIDECHAT_SELECTED_TEXT_MAX_LENGTH } from "./constants";
import { buildTranscriptContext } from "./sideChatContext";

export type SeededConversationTurn = {
  role: "user" | "assistant";
  /** For a question, the text the model got (a quick prompt's full prompt). */
  text: string;
};

/** The model that wrote the answers, stored on each answer. */
export type SeededConversationModel = {
  name: string;
  entryId?: string;
  providerLabel?: string;
};

export type SeedPaperConversationInput = {
  /** The paper the turns are about; a panel on another paper refuses. */
  paperItemId?: number;
  /** The selection the first question was about. */
  selectedTextContext: SelectedTextContext;
  turns: SeededConversationTurn[];
  model?: SeededConversationModel;
};

/**
 * Why the panel did not take the turns:
 * - busy: the panel's conversation is answering.
 * - webchat: WebChat chats live on the provider's site.
 * - unavailable: the panel cannot open a paper chat for this paper now.
 * - failed: the messages could not be stored.
 */
export type SeedPaperConversationFailure =
  | "busy"
  | "webchat"
  | "unavailable"
  | "failed";

export type SeedPaperConversationResult =
  | {
      ok: true;
      conversationKey: number;
      /** The turns were attached to the composer for the provider session. */
      handover: boolean;
    }
  | { ok: false; reason: SeedPaperConversationFailure };

/** Why a panel in this state cannot take the turns now, or null. */
export function seedPaperConversationRefusal(state: {
  /** Mounted, not cleaned up, and showing a conversation. */
  panelAlive: boolean;
  noteSession: boolean;
  runtimeSwitchInFlight: boolean;
  webChat: boolean;
  /** The panel's conversation has a request in flight. */
  answering: boolean;
}): SeedPaperConversationFailure | null {
  if (!state.panelAlive || state.noteSession || state.runtimeSwitchInFlight)
    return "unavailable";
  if (state.webChat) return "webchat";
  if (state.answering) return "busy";
  return null;
}

/** Question-and-answer pairs with text on both sides, in order. */
export function normalizeSeededTurns(
  turns: readonly SeededConversationTurn[],
): SeededConversationTurn[] {
  const pairs: SeededConversationTurn[] = [];
  for (let index = 0; index < turns.length - 1; index++) {
    const question = turns[index];
    const answer = turns[index + 1];
    if (question?.role !== "user" || answer?.role !== "assistant") continue;
    const questionText = String(question.text || "").trim();
    const answerText = String(answer.text || "").trim();
    if (!questionText || !answerText) continue;
    pairs.push(
      { role: "user", text: questionText },
      { role: "assistant", text: answerText },
    );
    index += 1;
  }
  return pairs;
}

/**
 * The stored messages for `input.turns`. Timestamps count up to `now`, one
 * millisecond apart, so the next sidebar message sorts after them.
 */
export function buildSeededConversationMessages(
  input: Pick<
    SeedPaperConversationInput,
    "selectedTextContext" | "turns" | "model"
  >,
  now: number,
): StoredChatMessage[] {
  const turns = normalizeSeededTurns(input.turns);
  const model = input.model?.name?.trim() ? input.model : undefined;
  return turns.map((turn, index): StoredChatMessage => {
    const message: StoredChatMessage = {
      role: turn.role,
      text: turn.text,
      timestamp: Math.floor(now) - (turns.length - 1 - index),
      runMode: "chat",
    };
    if (index === 0) {
      message.selectedTextContexts = [{ ...input.selectedTextContext }];
    }
    if (turn.role === "assistant" && model) {
      message.modelName = model.name.trim();
      if (model.entryId) message.modelEntryId = model.entryId;
      if (model.providerLabel) message.modelProviderLabel = model.providerLabel;
    }
    return message;
  });
}

/** The catalog title: the first question, as a typed first message gives. */
export function buildSeededConversationTitleSeed(
  turns: readonly SeededConversationTurn[],
): string {
  const first = normalizeSeededTurns(turns)[0];
  return first ? normalizeConversationTitleSeed(first.text) : "";
}

/** The selected-text source of the handover chip ("Inline Ask"). */
export const SEEDED_CONVERSATION_HANDOVER_SOURCE = "inlineask" as const;

/**
 * Only a Claude Code chat needs the handover chip: its fresh provider
 * session gets the typed message alone (the bridge replays stored history
 * only after a failed resume). A Codex app-server chat's new thread gets the
 * stored messages injected (nativeClient buildNativeMessages with
 * includeVisibleHistory), so a chip would send the turns twice.
 */
export function seededConversationNeedsHandover(
  system: ConversationSystem,
): boolean {
  return system === "claude_code";
}

/** Leads the handover when its oldest turns were cut for length. */
export const INLINE_ASK_OMITTED_MARKER = "[Earlier Inline Ask turns omitted]";

/** The passage keeps at most this many characters in the handover. */
const HANDOVER_PASSAGE_MAX_LENGTH = 6000;

function handoverHeader(context: SelectedTextContext): string {
  const lines: string[] = [];
  const paper = context.paperContext;
  const title = paper?.title?.trim();
  if (title) {
    const byline = [paper?.firstCreator?.trim(), paper?.year?.trim()]
      .filter(Boolean)
      .join(", ");
    lines.push(`Paper: ${title}${byline ? ` (${byline})` : ""}`);
  }
  const pageLabel = context.pageLabel?.trim();
  if (pageLabel) lines.push(`Page: ${pageLabel}`);
  else if (
    typeof context.pageIndex === "number" &&
    Number.isInteger(context.pageIndex) &&
    context.pageIndex >= 0
  )
    lines.push(`Page: ${context.pageIndex + 1}`);
  let passage = String(context.text || "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (passage.length > HANDOVER_PASSAGE_MAX_LENGTH) {
    passage = `${passage.slice(0, HANDOVER_PASSAGE_MAX_LENGTH - 1).trimEnd()}…`;
  }
  if (passage) lines.push("Selected passage:", passage);
  return lines.join("\n");
}

/**
 * The handover chip's text: the paper, page and selected passage, then the
 * turns as "Q: ..." / "A: ..." blocks. It fits the chip's cap; when it would
 * not, the oldest turns go first, behind an Inline Ask omission marker.
 */
export function buildSeededConversationHandover(input: {
  selectedTextContext: SelectedTextContext;
  turns: readonly SeededConversationTurn[];
}): string {
  const header = handoverHeader(input.selectedTextContext);
  const separator = header ? "\n\n" : "";
  const room =
    SIDECHAT_SELECTED_TEXT_MAX_LENGTH - header.length - separator.length;
  const transcript = buildTranscriptContext(
    normalizeSeededTurns(input.turns),
    Math.max(0, room),
    INLINE_ASK_OMITTED_MARKER,
  );
  if (!transcript) return header;
  return `${header}${separator}${transcript}`;
}

/** The store operations a seed needs, for one draft conversation. */
export type SeededConversationStore = {
  writeMessage(message: StoredChatMessage): Promise<void>;
  /** How many messages the draft holds (read at most `limit`). */
  countMessages(limit: number): Promise<number>;
  /** Deletes the user and assistant rows at these timestamps, if present. */
  deleteTurn(userTimestamp: number, assistantTimestamp: number): Promise<void>;
  setTitle(title: string): Promise<void>;
};

/**
 * Writes the seeded messages into an empty draft and titles it.
 *
 * All or nothing for the messages: when a write fails, or the stored count
 * is not the count written (a frozen conversation drops writes silently),
 * the pairs this call wrote are deleted again, so the draft stays empty and
 * a retry cannot leave two copies. The title is not part of that: once the
 * messages are stored, a failed title write is logged and the seed counts
 * as stored (the chat then has the default title).
 */
export async function storeSeededConversation(
  store: SeededConversationStore,
  messages: readonly StoredChatMessage[],
  titleSeed: string,
  log: (message: string, detail?: unknown) => void = () => undefined,
): Promise<{ ok: boolean }> {
  let attempted = 0;
  try {
    for (const message of messages) {
      // Counted before the write: a write that throws may still have landed.
      attempted += 1;
      await store.writeMessage(message);
    }
    const stored = await store.countMessages(messages.length + 1);
    if (stored !== messages.length) {
      throw new Error(`stored ${stored} of ${messages.length} seeded messages`);
    }
  } catch (error) {
    log("LLM: Failed to store the seeded paper chat", error);
    // The messages are question-answer pairs, so each attempted message
    // belongs to a pair whose timestamps are known.
    for (let index = 0; index < attempted; index += 2) {
      const user = messages[index];
      const assistant = messages[index + 1];
      if (!user || !assistant) continue;
      try {
        await store.deleteTurn(user.timestamp, assistant.timestamp);
      } catch (cleanupError) {
        log("LLM: Failed to remove a partly stored seeded turn", cleanupError);
      }
    }
    return { ok: false };
  }
  if (titleSeed) {
    try {
      await store.setTitle(titleSeed);
    } catch (error) {
      log("LLM: Failed to title the seeded paper chat", error);
    }
  }
  return { ok: true };
}
