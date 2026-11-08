/**
 * A paper conversation that starts with turns held elsewhere (Inline Ask's
 * "Continue in sidebar"): the turns become real stored messages, the first
 * question carries the selection it was about, and the chat is titled by its
 * first question. Pure: no DOM, no store.
 *
 * Claude Code and Codex app-server chats keep their history in the
 * provider's own session, which never saw these turns; the panel attaches
 * them to the first sidebar message instead, as an "Inline Ask" transcript
 * chip in the side chat's transcript format.
 */
import type { StoredChatMessage } from "../../utils/chatStore";
import type {
  ConversationSystem,
  SelectedTextContext,
} from "../../shared/types";
import { normalizeConversationTitleSeed } from "./setupHandlers/controllers/conversationHistoryController";
import { buildSideChatTranscriptContext } from "./sideChatContext";

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

/** Claude Code and Codex app-server sessions never saw the turns. */
export function seededConversationNeedsHandover(
  system: ConversationSystem,
): boolean {
  return system === "claude_code" || system === "codex";
}

/** The turns as the side chat's transcript text. */
export function buildSeededConversationHandover(
  turns: readonly SeededConversationTurn[],
): string {
  return buildSideChatTranscriptContext(normalizeSeededTurns(turns));
}
