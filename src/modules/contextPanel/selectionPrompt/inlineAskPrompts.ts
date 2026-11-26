/**
 * The Inline Ask card's quick prompts (pills). A pill sends its prompt; the
 * card shows its label as the question.
 *
 * The built-ins are Explain, Define terms and Translate. The user edits,
 * deletes, adds and resets prompts from the card's right-click menu; the
 * changes live in Inline Ask's own prefs (inlineAskPrompts and
 * inlineAskDeletedPrompts), apart from the sidebar's shortcut prefs. The
 * list's storage rules are quickPromptStore.ts's.
 */
import {
  createQuickPromptEditing,
  listQuickPrompts,
  type QuickPrompt,
  type QuickPromptEditing,
  type QuickPromptList,
} from "./quickPromptStore";

export const INLINE_ASK_PROMPT_LIST: QuickPromptList = {
  defaults: [
    {
      id: "explain",
      label: "Explain",
      prompt:
        "Explain this passage in plain language, using the context of the paper.",
    },
    {
      id: "define",
      label: "Define terms",
      prompt: "Define the technical terms in this passage.",
    },
    {
      id: "translate",
      label: "Translate",
      // Names the UI language: the zh-CN copy asks for Chinese.
      prompt: "Translate this passage into English.",
    },
  ],
  savedPref: "inlineAskPrompts",
  deletedPref: "inlineAskDeletedPrompts",
  customIdPrefix: "inline-ask-custom",
};

/** The pills as the card shows them now. */
export function getInlineAskQuickPrompts(): QuickPrompt[] {
  return listQuickPrompts(INLINE_ASK_PROMPT_LIST);
}

export function createInlineAskPromptEditing(): QuickPromptEditing {
  return createQuickPromptEditing(INLINE_ASK_PROMPT_LIST);
}
