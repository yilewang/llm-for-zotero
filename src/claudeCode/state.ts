import { getClaudeProfileSignature } from "./projectSkills";

export const activeClaudeGlobalConversationByLibrary = new Map<string, number>();
export const activeClaudeConversationModeByLibrary = new Map<
  string,
  "paper" | "global"
>();
export const activeClaudePaperConversationByPaper = new Map<string, number>();

export function buildClaudeLibraryStateKey(libraryID: number): string {
  return `${getClaudeProfileSignature()}:${Math.floor(libraryID)}`;
}

export function buildClaudePaperStateKey(
  libraryID: number,
  paperItemID: number,
): string {
  return `${getClaudeProfileSignature()}:${Math.floor(libraryID)}:${Math.floor(paperItemID)}`;
}
