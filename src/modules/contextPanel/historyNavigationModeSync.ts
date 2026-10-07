import {
  prime,
  type ConversationSelectionMode,
  type SelectionPrimeParams,
  type SelectionPrimeSnapshot,
} from "./conversationSelection";

export type HistoryNavigationMode = ConversationSelectionMode;

export type HistoryNavigationModeSnapshot = SelectionPrimeSnapshot;

/**
 * Pre-select the library mode and the target conversation before a history
 * navigation. `restore()` undoes the priming, in reverse order, only if no
 * newer navigation has changed any primed entry.
 */
export function primeHistoryNavigationMode(
  params: SelectionPrimeParams,
): HistoryNavigationModeSnapshot {
  return prime(params);
}
