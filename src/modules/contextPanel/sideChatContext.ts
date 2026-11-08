/**
 * Plain-text views of a chat's messages, for moving context between the
 * window's main chat and its temporary side chat. Pure: no DOM, no state.
 *
 * - buildSideChatTranscriptContext: the side chat's turns, attached to the
 *   main chat as a removable "sidechat" selected-text chip.
 * - buildMainChatBackgroundContext: the main chat's turns, given to the side
 *   chat's model as background (never shown as a chip or a user message).
 *
 * Both write one "Q: ..." or "A: ..." block per message, separated by a blank
 * line, skip empty, streaming, and compaction-marker messages, and keep the
 * newest turns when the text is longer than the cap: the oldest text is cut
 * at a line boundary and a leading marker says that turns were omitted.
 */
import {
  MAIN_CHAT_BACKGROUND_CONTEXT_MAX_LENGTH,
  SIDECHAT_SELECTED_TEXT_MAX_LENGTH,
} from "./constants";

/** The fields the builders read from a chat message. */
export type TranscriptMessage = {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  compactMarker?: boolean;
};

export const SIDE_CHAT_OMITTED_MARKER = "[Earlier side chat turns omitted]";
export const MAIN_CHAT_OMITTED_MARKER = "[Earlier main chat turns omitted]";

function formatTurns(messages: readonly TranscriptMessage[]): string {
  const blocks: string[] = [];
  for (const message of messages) {
    if (!message || message.streaming || message.compactMarker) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = (typeof message.text === "string" ? message.text : "")
      .replace(/\r\n?/g, "\n")
      .trim();
    if (!text) continue;
    blocks.push(`${message.role === "user" ? "Q" : "A"}: ${text}`);
  }
  return blocks.join("\n\n");
}

/** The newest part of `text` that fits in `maxChars` with the marker. */
function keepNewest(text: string, maxChars: number, marker: string): string {
  const cap = Math.max(0, Math.floor(maxChars));
  if (text.length <= cap) return text;
  const prefix = `${marker}\n\n`;
  const room = cap - prefix.length;
  if (room <= 0) return marker.slice(0, cap);
  let kept = text.slice(text.length - room);
  // Start at a whole line when one begins inside the kept text.
  const lineBreak = kept.indexOf("\n");
  if (lineBreak >= 0 && lineBreak < kept.length - 1) {
    kept = kept.slice(lineBreak + 1);
  }
  return `${prefix}${kept.replace(/^\n+/, "")}`;
}

/**
 * The side chat as text for the main chat's next message, at most
 * `maxChars` characters (default: the "sidechat" selected-text cap).
 */
export function buildSideChatTranscriptContext(
  messages: readonly TranscriptMessage[],
  maxChars: number = SIDECHAT_SELECTED_TEXT_MAX_LENGTH,
): string {
  return keepNewest(formatTurns(messages), maxChars, SIDE_CHAT_OMITTED_MARKER);
}

/**
 * The main chat as background text for the side chat's model, at most
 * `maxChars` characters.
 */
export function buildMainChatBackgroundContext(
  messages: readonly TranscriptMessage[],
  maxChars: number = MAIN_CHAT_BACKGROUND_CONTEXT_MAX_LENGTH,
): string {
  return keepNewest(formatTurns(messages), maxChars, MAIN_CHAT_OMITTED_MARKER);
}
