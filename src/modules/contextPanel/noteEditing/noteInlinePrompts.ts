/**
 * The note editor's inline writing shortcuts (Rewrite, Expand, Proofread):
 * each one asks the model with its prompt, and the answer replaces the
 * selection.
 *
 * The user edits, deletes, adds and resets them from the popup's right-click
 * menu, as with Inline Ask's pills in the reader; the changes live in the
 * popup's own prefs (noteInlinePrompts and noteInlineDeletedPrompts), apart
 * from Inline Ask's. The list's storage rules are quickPromptStore.ts's.
 */
import {
  createQuickPromptEditing,
  listQuickPrompts,
  type QuickPrompt,
  type QuickPromptEditing,
  type QuickPromptList,
} from "../selectionPrompt/quickPromptStore";

export const NOTE_INLINE_PROMPT_LIST: QuickPromptList = {
  defaults: [
    {
      id: "rewrite",
      label: "Rewrite",
      prompt:
        "Rewrite the selected text so it reads clearly and concisely. Reply with only the rewritten text.",
    },
    {
      id: "expand",
      label: "Expand",
      prompt:
        "Expand the selected text with more detail, using the paper where it helps. Reply with only the expanded text.",
    },
    {
      id: "proofread",
      label: "Proofread",
      prompt:
        "Proofread the selected text: fix spelling, grammar and punctuation without changing its meaning or style. Reply with only the corrected text.",
    },
  ],
  savedPref: "noteInlinePrompts",
  deletedPref: "noteInlineDeletedPrompts",
  customIdPrefix: "note-inline-custom",
};

/** The shortcuts as the popup shows them now. */
export function getNoteInlinePrompts(): QuickPrompt[] {
  return listQuickPrompts(NOTE_INLINE_PROMPT_LIST);
}

export function createNoteInlinePromptEditing(): QuickPromptEditing {
  return createQuickPromptEditing(NOTE_INLINE_PROMPT_LIST);
}
