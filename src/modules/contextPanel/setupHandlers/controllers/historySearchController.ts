import { createElement } from "../../../../utils/domHelpers";
import { sanitizeText } from "../../textUtils";
import type { ConversationHistoryEntry } from "./conversationHistoryController";
import { formatHistoryRowDisplayTitle } from "./conversationHistoryController";

export type HistorySearchTextCandidate = {
  kind: "title" | "message";
  text: string;
  normalizedText: string;
};

export type HistorySearchDocument = {
  conversationKey: number;
  candidates: HistorySearchTextCandidate[];
};

export type HistorySearchRange = {
  start: number;
  end: number;
};

export type HistorySearchResult = {
  entry: ConversationHistoryEntry;
  matchCount: number;
  titleRanges: HistorySearchRange[];
  previewText: string;
  previewRanges: HistorySearchRange[];
};

type HistorySearchMessage = {
  text?: unknown;
};

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
    normalizeHistorySearchText(entry.title),
    lastActivityAt,
  ]);
}

export function normalizeHistorySearchQuery(value: string): string {
  return sanitizeText(value || "")
    .trim()
    .toLocaleLowerCase();
}

export function normalizeHistorySearchText(value: unknown): string {
  return sanitizeText(typeof value === "string" ? value : String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeHistorySearchQuery(normalizedQuery: string): string[] {
  return Array.from(
    new Set(
      normalizedQuery
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean),
    ),
  );
}

function countHistorySearchTokenOccurrences(
  normalizedText: string,
  token: string,
): { count: number; firstIndex: number } {
  if (!normalizedText || !token) {
    return { count: 0, firstIndex: -1 };
  }
  let count = 0;
  let firstIndex = -1;
  let cursor = 0;
  while (cursor < normalizedText.length) {
    const index = normalizedText.indexOf(token, cursor);
    if (index < 0) break;
    count += 1;
    if (firstIndex < 0) {
      firstIndex = index;
    }
    cursor = index + token.length;
  }
  return { count, firstIndex };
}

export function collectHistorySearchRanges(
  text: string,
  searchTokens: string[],
): HistorySearchRange[] {
  if (!text || !searchTokens.length) return [];
  const normalizedText = text.toLocaleLowerCase();
  const ranges: HistorySearchRange[] = [];
  for (const token of searchTokens) {
    let cursor = 0;
    while (cursor < normalizedText.length) {
      const index = normalizedText.indexOf(token, cursor);
      if (index < 0) break;
      ranges.push({
        start: index,
        end: index + token.length,
      });
      cursor = index + token.length;
    }
  }
  if (!ranges.length) return [];
  ranges.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return a.end - b.end;
  });
  const merged: HistorySearchRange[] = [ranges[0]];
  for (const range of ranges.slice(1)) {
    const previous = merged[merged.length - 1];
    if (range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
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

function scoreHistorySearchCandidate(
  candidate: HistorySearchTextCandidate,
  searchTokens: string[],
): { matchCount: number; firstIndex: number } {
  let matchCount = 0;
  let firstIndex = -1;
  for (const token of searchTokens) {
    const occurrence = countHistorySearchTokenOccurrences(
      candidate.normalizedText,
      token,
    );
    matchCount += occurrence.count;
    if (
      occurrence.firstIndex >= 0 &&
      (firstIndex < 0 || occurrence.firstIndex < firstIndex)
    ) {
      firstIndex = occurrence.firstIndex;
    }
  }
  return { matchCount, firstIndex };
}

export function buildHistorySearchPreview(
  text: string,
  searchTokens: string[],
): { previewText: string; previewRanges: HistorySearchRange[] } {
  const normalizedText = normalizeHistorySearchText(text);
  if (!normalizedText) {
    return { previewText: "", previewRanges: [] };
  }
  const ranges = collectHistorySearchRanges(normalizedText, searchTokens);
  if (!ranges.length) {
    return { previewText: "", previewRanges: [] };
  }
  const firstRange = ranges[0];
  const beforeContext = 14;
  const afterContext = 52;
  const minimumSnippetLength = 72;
  let start = Math.max(0, firstRange.start - beforeContext);
  let end = Math.min(normalizedText.length, firstRange.end + afterContext);
  if (end - start < minimumSnippetLength) {
    const deficit = minimumSnippetLength - (end - start);
    const shiftLeft = Math.min(start, Math.ceil(deficit / 2));
    start -= shiftLeft;
    end = Math.min(normalizedText.length, end + (deficit - shiftLeft));
  }
  const prefix = start > 0 ? "... " : "";
  const suffix = end < normalizedText.length ? " ..." : "";
  const snippet = normalizedText.slice(start, end);
  const snippetRanges = ranges
    .filter((range) => range.end > start && range.start < end)
    .map((range) => ({
      start: prefix.length + Math.max(0, range.start - start),
      end: prefix.length + Math.min(end, range.end) - start,
    }));
  return {
    previewText: `${prefix}${snippet}${suffix}`,
    previewRanges: snippetRanges,
  };
}

export function createHistorySearchDocument(
  entry: ConversationHistoryEntry,
  messages: ReadonlyArray<HistorySearchMessage>,
): HistorySearchDocument {
  const titleText = normalizeHistorySearchText(entry.title);
  const candidates: HistorySearchTextCandidate[] = [];
  if (titleText) {
    candidates.push({
      kind: "title",
      text: titleText,
      normalizedText: titleText.toLocaleLowerCase(),
    });
  }
  for (const message of messages) {
    const text = normalizeHistorySearchText(message.text);
    if (!text) continue;
    candidates.push({
      kind: "message",
      text,
      normalizedText: text.toLocaleLowerCase(),
    });
  }
  return {
    conversationKey: entry.conversationKey,
    candidates,
  };
}

export function buildHistorySearchResults(
  entries: ConversationHistoryEntry[],
  normalizedQuery: string,
  documentCache: ReadonlyMap<number, HistorySearchDocument>,
): HistorySearchResult[] {
  const searchTokens = tokenizeHistorySearchQuery(normalizedQuery);
  if (!searchTokens.length) return [];
  const results: HistorySearchResult[] = [];
  for (const entry of entries) {
    const document = documentCache.get(entry.conversationKey);
    if (!document) continue;
    let matchCount = 0;
    let bestPreviewCandidate: HistorySearchTextCandidate | null = null;
    let bestPreviewScore = 0;
    let bestPreviewIndex = Number.POSITIVE_INFINITY;
    for (const candidate of document.candidates) {
      const score = scoreHistorySearchCandidate(candidate, searchTokens);
      if (score.matchCount <= 0) continue;
      matchCount += score.matchCount;
      if (
        candidate.kind === "message" &&
        (score.matchCount > bestPreviewScore ||
          (score.matchCount === bestPreviewScore &&
            score.firstIndex >= 0 &&
            score.firstIndex < bestPreviewIndex))
      ) {
        bestPreviewCandidate = candidate;
        bestPreviewScore = score.matchCount;
        bestPreviewIndex =
          score.firstIndex >= 0 ? score.firstIndex : bestPreviewIndex;
      }
    }
    if (matchCount <= 0) continue;
    const displayTitle = formatHistoryRowDisplayTitle(entry.title);
    const titleRanges = collectHistorySearchRanges(displayTitle, searchTokens);
    const preview = bestPreviewCandidate
      ? buildHistorySearchPreview(bestPreviewCandidate.text, searchTokens)
      : { previewText: "", previewRanges: [] };
    results.push({
      entry,
      matchCount,
      titleRanges,
      previewText: preview.previewText,
      previewRanges: preview.previewRanges,
    });
  }
  results.sort((a, b) => {
    if (b.matchCount !== a.matchCount) {
      return b.matchCount - a.matchCount;
    }
    if (b.entry.lastActivityAt !== a.entry.lastActivityAt) {
      return b.entry.lastActivityAt - a.entry.lastActivityAt;
    }
    return b.entry.conversationKey - a.entry.conversationKey;
  });
  return results;
}
