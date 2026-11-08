import { createElement } from "../../../../utils/domHelpers";
import type { ConversationHistoryEntry } from "./conversationHistoryController";
import { formatHistoryRowDisplayTitle } from "./conversationHistoryController";
import {
  buildHistorySearchResults as buildHistorySearchResultsCore,
  normalizeHistorySearchText,
  type HistorySearchDocument,
  type HistorySearchRange,
  type HistorySearchResult as HistorySearchResultCore,
} from "../../../../services/pastConversations/historySearchCore";

// The pure search rules live in services, where the agent's past_chat_search
// uses them too; the popup keeps its imports from here.
export {
  buildHistorySearchPreview,
  collectHistorySearchRanges,
  createHistorySearchDocument,
  normalizeHistorySearchQuery,
  normalizeHistorySearchText,
  tokenizeHistorySearchQuery,
  type HistorySearchDocument,
  type HistorySearchRange,
  type HistorySearchTextCandidate,
} from "../../../../services/pastConversations/historySearchCore";

export type HistorySearchResult =
  HistorySearchResultCore<ConversationHistoryEntry>;

export function createHistorySearchDocumentFingerprint(
  entry: ConversationHistoryEntry,
): string {
  const conversationKey = Number.isFinite(entry.conversationKey)
    ? Math.floor(entry.conversationKey)
    : 0;
  const lastActivityAt = Number.isFinite(entry.lastActivityAt)
    ? Math.floor(entry.lastActivityAt)
    : 0;
  return JSON.stringify([
    conversationKey,
    entry.kind === "paper" ? "paper" : "global",
    entry.sourceState,
    normalizeHistorySearchText(entry.title),
    normalizeHistorySearchText(entry.sectionTitle),
    lastActivityAt,
  ]);
}

export function appendHistorySearchHighlightedText(
  container: HTMLElement,
  text: string,
  ranges: HistorySearchRange[],
): void {
  container.textContent = "";
  if (!ranges.length) {
    container.textContent = text;
    return;
  }
  const ownerDoc = container.ownerDocument;
  if (!ownerDoc) {
    container.textContent = text;
    return;
  }
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(0, Math.min(text.length, range.start));
    const end = Math.max(start, Math.min(text.length, range.end));
    if (start > cursor) {
      container.appendChild(ownerDoc.createTextNode(text.slice(cursor, start)));
    }
    const mark = createElement(
      ownerDoc,
      "mark",
      "llm-history-search-highlight",
      {
        textContent: text.slice(start, end),
      },
    );
    container.appendChild(mark);
    cursor = end;
  }
  if (cursor < text.length) {
    container.appendChild(ownerDoc.createTextNode(text.slice(cursor)));
  }
}

export function buildHistorySearchResults(
  entries: ConversationHistoryEntry[],
  normalizedQuery: string,
  documentCache: ReadonlyMap<number, HistorySearchDocument>,
): HistorySearchResult[] {
  return buildHistorySearchResultsCore(
    entries,
    normalizedQuery,
    documentCache,
    formatHistoryRowDisplayTitle,
  );
}
