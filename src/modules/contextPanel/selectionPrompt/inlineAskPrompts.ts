/**
 * The Inline Ask card's quick prompts (pills). A pill sends its prompt; the
 * card shows its label as the question.
 *
 * M1 has the three built-in prompts only. getInlineAskQuickPrompts is the one
 * reader of the list, so a prefs-backed list (editable prompts) can replace
 * the constant there.
 */
import { t } from "../../../utils/i18n";

export type InlineAskQuickPrompt = {
  id: string;
  label: string;
  prompt: string;
};

/** English sources; t() gives the UI-language copy (zh-CN in i18n.ts). */
export const DEFAULT_INLINE_ASK_PROMPTS: readonly InlineAskQuickPrompt[] = [
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
];

export function getInlineAskQuickPrompts(): InlineAskQuickPrompt[] {
  return DEFAULT_INLINE_ASK_PROMPTS.map((entry) => ({
    id: entry.id,
    label: t(entry.label),
    prompt: t(entry.prompt),
  }));
}
