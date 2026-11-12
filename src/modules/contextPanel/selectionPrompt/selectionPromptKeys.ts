export type SelectionPromptKeyAction = "submit" | "newline" | "close" | "other";

/** Keyboard contract shared by the reader overlay and the assistant popup (D2). */
export function classifySelectionPromptKey(
  event: Pick<
    KeyboardEvent,
    "key" | "shiftKey" | "isComposing" | "keyCode" | "repeat"
  >,
): SelectionPromptKeyAction {
  // A held key must not submit or close; only a fresh press acts.
  if (event.repeat) return "other";
  // During IME composition Enter and Escape belong to the candidate window.
  if (event.isComposing || event.keyCode === 229) return "other";
  if (event.key === "Escape") return "close";
  if (event.key !== "Enter") return "other";
  return event.shiftKey ? "newline" : "submit";
}
