export type StandalonePaperTabLabel = "Paper chat" | "Note chat" | "Web chat";

export function resolveStandalonePaperTabLabel(options?: {
  isWebChat?: boolean;
  isNoteSession?: boolean;
}): StandalonePaperTabLabel {
  if (options?.isWebChat) return "Web chat";
  if (options?.isNoteSession) return "Note chat";
  return "Paper chat";
}
