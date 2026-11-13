import type {
  CollectionContextRef,
  PaperContextRef,
  SelectedTextContext,
  SelectedTextSource,
  NoteContextRef,
  TagContextRef,
  AttachedConversationRef,
} from "../../types";
import { resolvePromptText } from "../../textUtils";

export type InlineEditRetryContextSnapshot = {
  selectedTexts: string[];
  selectedTextSources: SelectedTextSource[];
  selectedTextPaperContexts: (PaperContextRef | undefined)[];
  selectedTextNoteContexts: (NoteContextRef | undefined)[];
  selectedCollectionContexts: CollectionContextRef[];
  selectedTagContexts: TagContextRef[];
  /** Always an array: an empty list tells the edit to drop earlier chips. */
  attachedConversations: AttachedConversationRef[];
};

export function buildInlineEditRetryContextSnapshot(params: {
  selectedContexts?: SelectedTextContext[];
  selectedCollectionContexts?: CollectionContextRef[];
  selectedTagContexts?: TagContextRef[];
  attachedConversations?: AttachedConversationRef[];
}): InlineEditRetryContextSnapshot {
  const selectedContexts = Array.isArray(params.selectedContexts)
    ? params.selectedContexts
    : [];

  return {
    selectedTexts: selectedContexts.map((entry) => entry.text),
    selectedTextSources: selectedContexts.map((entry) => entry.source),
    selectedTextPaperContexts: selectedContexts.map(
      (entry) => entry.paperContext,
    ),
    selectedTextNoteContexts: selectedContexts.map(
      (entry) => entry.noteContext,
    ),
    selectedCollectionContexts: Array.isArray(params.selectedCollectionContexts)
      ? params.selectedCollectionContexts.slice()
      : [],
    selectedTagContexts: Array.isArray(params.selectedTagContexts)
      ? params.selectedTagContexts.slice()
      : [],
    attachedConversations: Array.isArray(params.attachedConversations)
      ? params.attachedConversations.slice()
      : [],
  };
}

/**
 * The text an inline edit submits; "" means there is nothing to submit.
 * Typed composer text wins. With an empty composer, the questions on the
 * current chips make a valid edit, as in an empty-composer send
 * (resolvePromptText); chips without questions do not.
 */
export function resolveInlineEditSubmitText(
  composerText: string,
  selectedContexts?: readonly SelectedTextContext[],
): string {
  const typed = composerText.trim();
  if (typed) return typed;
  return resolvePromptText("", "", false, selectedContexts);
}
