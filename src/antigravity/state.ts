import { getAntigravityProfileSignature } from "./constants";

export const activeAntigravityGlobalConversationByLibrary = new Map<
  string,
  number
>();
export const activeAntigravityConversationModeByLibrary = new Map<
  string,
  "paper" | "global"
>();
export const activeAntigravityPaperConversationByPaper = new Map<
  string,
  number
>();

export function buildAntigravityLibraryStateKey(libraryID: number): string {
  return `${getAntigravityProfileSignature()}:${Math.floor(libraryID)}`;
}

export function buildAntigravityPaperStateKey(
  libraryID: number,
  paperItemID: number,
): string {
  return `${getAntigravityProfileSignature()}:${Math.floor(libraryID)}:${Math.floor(paperItemID)}`;
}
