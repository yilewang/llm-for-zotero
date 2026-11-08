import { isEphemeralConversationKey } from "../../shared/conversationKeySpace";

/**
 * Skills whose workflow exists to change the library (write a note, file
 * papers into folders or tags, import references). A temporary side chat
 * is read-only and its write tools are withheld, so these are not offered.
 */
export const SIDE_CHAT_WITHHELD_SKILL_IDS: ReadonlySet<string> = new Set([
  "write-note",
  "reorganize-library",
  "import-to-library",
]);

export function isSkillWithheldForEphemeralRequest(
  skillId: string,
  request: { conversationKey: number },
): boolean {
  return (
    SIDE_CHAT_WITHHELD_SKILL_IDS.has(skillId) &&
    isEphemeralConversationKey(request.conversationKey)
  );
}

/** The prompt line that tells a side chat's model what it cannot do. */
export const SIDE_CHAT_READ_ONLY_INSTRUCTION =
  "This is a temporary side chat, and it is read-only. It cannot create, append to, or edit notes, change tags, collections, or item data, import items, or run commands, and those tools are not available. Do not offer these actions. If the user asks for one, say that the main chat can do it.";
