import type {
  CollectionContextRef,
  PaperContextRef,
  SelectedTextContext,
  SelectedTextSource,
  NoteContextRef,
  TagContextRef,
} from "../../types";

export type InlineEditRetryContextSnapshot = {
  selectedTexts: string[];
  selectedTextSources: SelectedTextSource[];
  selectedTextPaperContexts: (PaperContextRef | undefined)[];
  selectedTextNoteContexts: (NoteContextRef | undefined)[];
  selectedCollectionContexts: CollectionContextRef[];
  selectedTagContexts: TagContextRef[];
};

export function buildInlineEditRetryContextSnapshot(params: {
  selectedContexts?: SelectedTextContext[];
  selectedCollectionContexts?: CollectionContextRef[];
  selectedTagContexts?: TagContextRef[];
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
  };
}
