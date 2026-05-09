import { getCodexProfileSignature } from "./constants";

export const activeCodexGlobalConversationByLibrary = new Map<string, number>();
export const activeCodexConversationModeByLibrary = new Map<
  string,
  "paper" | "global"
>();
export const activeCodexPaperConversationByPaper = new Map<string, number>();

export function buildCodexLibraryStateKey(libraryID: number): string {
  return `${getCodexProfileSignature()}:${Math.floor(libraryID)}`;
}

export function buildCodexPaperStateKey(
  libraryID: number,
  paperItemID: number,
): string {
  return `${getCodexProfileSignature()}:${Math.floor(libraryID)}:${Math.floor(paperItemID)}`;
}
