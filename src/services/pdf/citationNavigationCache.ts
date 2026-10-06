import { quoteKeyHash } from "../quotes/quoteKey";
import { sanitizeText } from "../../utils/textSanitization";

export type CitationPageCacheEntry = {
  contextItemId: number;
  quoteHash: string;
  pageIndex: number;
  pageLabel: string;
  createdAt: number;
  lastAccessedAt: number;
};

const MAX_CITATION_PAGE_CACHE_ENTRIES = 1000;
const CITATION_PAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let nowForTests: (() => number) | null = null;
const citationPageCache = new Map<string, CitationPageCacheEntry>();

function now(): number {
  return nowForTests ? nowForTests() : Date.now();
}

export function buildCitationQuoteHash(quoteText: string): string {
  return quoteKeyHash(quoteText);
}

function buildCitationPageCacheKey(
  contextItemId: number,
  quoteHash: string,
): string {
  return `${Math.floor(contextItemId)}\u241f${quoteHash}`;
}

function normalizeContextItemId(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function normalizePageIndex(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function evictExpiredEntries(currentTime: number): void {
  for (const [key, entry] of citationPageCache) {
    if (currentTime - entry.createdAt > CITATION_PAGE_CACHE_TTL_MS) {
      citationPageCache.delete(key);
    }
  }
}

function enforceEntryLimit(): void {
  while (citationPageCache.size > MAX_CITATION_PAGE_CACHE_ENTRIES) {
    let oldestKey = "";
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [key, entry] of citationPageCache) {
      if (entry.lastAccessedAt < oldestAccess) {
        oldestAccess = entry.lastAccessedAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) return;
    citationPageCache.delete(oldestKey);
  }
}

export function rememberCitationPage(input: {
  contextItemId: number;
  quoteText: string;
  pageIndex: number;
  pageLabel?: string;
}): string | null {
  const contextItemId = normalizeContextItemId(input.contextItemId);
  if (contextItemId === null) return null;
  const pageIndex = normalizePageIndex(input.pageIndex);
  if (pageIndex === null) return null;
  const pageLabel = sanitizeText(input.pageLabel || "").trim();
  if (!pageLabel) return null;
  const quoteHash = buildCitationQuoteHash(input.quoteText);
  if (!quoteHash) return null;

  const currentTime = now();
  evictExpiredEntries(currentTime);
  const key = buildCitationPageCacheKey(contextItemId, quoteHash);
  citationPageCache.set(key, {
    contextItemId,
    quoteHash,
    pageIndex,
    pageLabel,
    createdAt: currentTime,
    lastAccessedAt: currentTime,
  });
  enforceEntryLimit();
  return pageLabel;
}

export function lookupCitationPage(input: {
  contextItemId: number;
  quoteText: string;
}): CitationPageCacheEntry | null {
  const contextItemId = normalizeContextItemId(input.contextItemId);
  if (contextItemId === null) return null;
  const quoteHash = buildCitationQuoteHash(input.quoteText);
  if (!quoteHash) return null;
  const currentTime = now();
  evictExpiredEntries(currentTime);
  const key = buildCitationPageCacheKey(contextItemId, quoteHash);
  const entry = citationPageCache.get(key);
  if (!entry) return null;
  const nextEntry = {
    ...entry,
    lastAccessedAt: currentTime,
  };
  citationPageCache.delete(key);
  citationPageCache.set(key, nextEntry);
  return nextEntry;
}

export function clearCitationPageCache(): void {
  citationPageCache.clear();
}

export function clearCitationNavigationCaches(): void {
  clearCitationPageCache();
}

export function setCitationNavigationCacheNowForTests(
  getNow: (() => number) | null,
): void {
  nowForTests = getNow;
}
