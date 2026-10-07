/**
 * The quote gate's two caches and the counters that describe them.
 *
 * Validating a quote twice against the same evidence must give the same
 * answer, so a decision is keyed by a signature of the evidence that produced
 * it and the policy version that read it. Both caches are bounded by entries
 * and by estimated bytes, and both live at module scope: the plugin bundles
 * into one module instance, so one conversation's warm cache is every
 * panel's warm cache.
 */
import { fnv1a32Raw } from "../../../utils/fnv1a";
import {
  buildQuoteSourceIndex,
  finalizeAssistantQuoteCitations,
  type QuoteSourceText,
} from "../../../services/quotes/quoteCitations";
import { sanitizeText } from "../../../utils/textSanitization";
import type { QuoteSourceEvidence } from "./sourceEvidence";

const MAX_QUOTE_VALIDATION_DECISION_ENTRIES = 1000;
const MAX_QUOTE_VALIDATION_DECISION_BYTES = 4 * 1024 * 1024;
const MAX_QUOTE_SOURCE_INDEX_ENTRIES = 64;
const MAX_QUOTE_SOURCE_INDEX_BYTES = 2 * 1024 * 1024;
export const QUOTE_VALIDATION_POLICY_VERSION = 13;
type QuoteValidationDecision = ReturnType<
  typeof finalizeAssistantQuoteCitations
>;
type CachedQuoteValidationDecision = {
  decision: QuoteValidationDecision;
  validationSignature: string;
  estimatedBytes: number;
};
const quoteValidationDecisionCache = new Map<
  string,
  CachedQuoteValidationDecision
>();
let quoteValidationDecisionCacheBytes = 0;
let quoteValidationDecisionCacheHits = 0;
let quoteValidationDecisionComputations = 0;

/** One decision was computed rather than served from the cache. */
export function noteQuoteValidationDecisionComputed(): void {
  quoteValidationDecisionComputations += 1;
}
type CachedQuoteSourceIndex = {
  evidenceSignature: string;
  sourceIndex: ReturnType<typeof buildQuoteSourceIndex>;
  estimatedBytes: number;
};
const quoteSourceIndexCache = new Map<string, CachedQuoteSourceIndex>();
let quoteSourceIndexCacheBytes = 0;
let quoteSourceIndexCacheHits = 0;
let quoteSourceIndexBuilds = 0;

function hashQuoteValidationText(value: string): string {
  return fnv1a32Raw(value).toString(36);
}

export function quoteValidationCacheKey(signature: string): string {
  return `${signature.length}:${hashQuoteValidationText(signature)}`;
}

export function buildQuoteValidationEvidenceSignature(
  evidence: QuoteSourceEvidence,
): string | null {
  if (!evidence.sourceTexts.length) return evidence.complete ? "empty:1" : null;
  const parts: string[] = [];
  for (const source of evidence.sourceTexts) {
    const fingerprint = sanitizeText(
      String(source.sourceFingerprint || ""),
    ).trim();
    if (!fingerprint) return null;
    parts.push(
      [
        Math.floor(Number(source.contextItemId || 0)),
        Math.floor(Number(source.itemId || 0)),
        fingerprint,
        Math.floor(Number(source.pageHintIndex ?? -1)),
        String(source.sourceText || source.text || "").length,
      ].join(":"),
    );
  }
  return `${evidence.complete ? 1 : 0}\u241f${parts.sort().join("\u241e")}`;
}

export function getOrBuildCachedQuoteSourceIndex(
  evidenceSignature: string,
  sourceTexts: QuoteSourceText[],
): ReturnType<typeof buildQuoteSourceIndex> {
  const key = quoteValidationCacheKey(evidenceSignature);
  const cached = quoteSourceIndexCache.get(key);
  if (cached?.evidenceSignature === evidenceSignature) {
    quoteSourceIndexCache.delete(key);
    quoteSourceIndexCache.set(key, cached);
    quoteSourceIndexCacheHits += 1;
    return cached.sourceIndex;
  }

  const sourceIndex = buildQuoteSourceIndex({ sourceTexts });
  quoteSourceIndexBuilds += 1;
  // Source strings and normalized indexes are shared with the page-text cache.
  // Count this cache's keys, labels, entry shells, and reference overhead only.
  const estimatedBytes =
    evidenceSignature.length * 2 +
    sourceIndex.sources.reduce(
      (total, source) =>
        total +
        256 +
        source.citationLabel.length * 2 +
        (source.sectionLabel?.length || 0) * 2,
      0,
    );
  if (estimatedBytes <= MAX_QUOTE_SOURCE_INDEX_BYTES) {
    const existing = quoteSourceIndexCache.get(key);
    if (existing) quoteSourceIndexCacheBytes -= existing.estimatedBytes;
    quoteSourceIndexCache.delete(key);
    quoteSourceIndexCache.set(key, {
      evidenceSignature,
      sourceIndex,
      estimatedBytes,
    });
    quoteSourceIndexCacheBytes += estimatedBytes;
    while (
      quoteSourceIndexCache.size > MAX_QUOTE_SOURCE_INDEX_ENTRIES ||
      quoteSourceIndexCacheBytes > MAX_QUOTE_SOURCE_INDEX_BYTES
    ) {
      const oldestKey = quoteSourceIndexCache.keys().next().value as
        | string
        | undefined;
      if (!oldestKey) break;
      const oldest = quoteSourceIndexCache.get(oldestKey);
      quoteSourceIndexCache.delete(oldestKey);
      quoteSourceIndexCacheBytes -= oldest?.estimatedBytes || 0;
    }
  }
  return sourceIndex;
}

export function getCachedQuoteValidationDecision(
  key: string,
  validationSignature: string,
): QuoteValidationDecision | null {
  const cached = quoteValidationDecisionCache.get(key);
  if (!cached || cached.validationSignature !== validationSignature)
    return null;
  quoteValidationDecisionCache.delete(key);
  quoteValidationDecisionCache.set(key, cached);
  quoteValidationDecisionCacheHits += 1;
  return {
    markdown: cached.decision.markdown,
    quoteCitations: cached.decision.quoteCitations.map((citation) => ({
      ...citation,
    })),
  };
}

export function cacheQuoteValidationDecision(
  key: string,
  validationSignature: string,
  decision: QuoteValidationDecision,
): void {
  const serialized = JSON.stringify(decision);
  const estimatedBytes =
    serialized.length * 2 + key.length * 2 + validationSignature.length * 2;
  if (estimatedBytes > MAX_QUOTE_VALIDATION_DECISION_BYTES) return;
  const existing = quoteValidationDecisionCache.get(key);
  if (existing) {
    quoteValidationDecisionCacheBytes -= existing.estimatedBytes;
    quoteValidationDecisionCache.delete(key);
  }
  quoteValidationDecisionCache.set(key, {
    decision: {
      markdown: decision.markdown,
      quoteCitations: decision.quoteCitations.map((citation) => ({
        ...citation,
      })),
    },
    validationSignature,
    estimatedBytes,
  });
  quoteValidationDecisionCacheBytes += estimatedBytes;
  while (
    quoteValidationDecisionCache.size > MAX_QUOTE_VALIDATION_DECISION_ENTRIES ||
    quoteValidationDecisionCacheBytes > MAX_QUOTE_VALIDATION_DECISION_BYTES
  ) {
    const oldestKey = quoteValidationDecisionCache.keys().next().value as
      | string
      | undefined;
    if (!oldestKey) break;
    const oldest = quoteValidationDecisionCache.get(oldestKey);
    quoteValidationDecisionCache.delete(oldestKey);
    quoteValidationDecisionCacheBytes -= oldest?.estimatedBytes || 0;
  }
}

export function resetQuoteValidationDecisionCacheForTests(): void {
  quoteValidationDecisionCache.clear();
  quoteValidationDecisionCacheBytes = 0;
  quoteValidationDecisionCacheHits = 0;
  quoteValidationDecisionComputations = 0;
  quoteSourceIndexCache.clear();
  quoteSourceIndexCacheBytes = 0;
  quoteSourceIndexCacheHits = 0;
  quoteSourceIndexBuilds = 0;
}

export function getQuoteValidationDecisionCacheStatsForTests(): {
  entries: number;
  bytes: number;
  hits: number;
  computations: number;
  sourceIndexEntries: number;
  sourceIndexBytes: number;
  sourceIndexHits: number;
  sourceIndexBuilds: number;
} {
  return {
    entries: quoteValidationDecisionCache.size,
    bytes: quoteValidationDecisionCacheBytes,
    hits: quoteValidationDecisionCacheHits,
    computations: quoteValidationDecisionComputations,
    sourceIndexEntries: quoteSourceIndexCache.size,
    sourceIndexBytes: quoteSourceIndexCacheBytes,
    sourceIndexHits: quoteSourceIndexCacheHits,
    sourceIndexBuilds: quoteSourceIndexBuilds,
  };
}

export function primeQuoteValidationDecisionCacheForTests(
  validationSignature: string,
  payloadChars = 1,
): void {
  cacheQuoteValidationDecision(
    quoteValidationCacheKey(validationSignature),
    validationSignature,
    {
      markdown: "x".repeat(Math.max(1, payloadChars)),
      quoteCitations: [],
    },
  );
}

export function hasQuoteValidationDecisionForTests(
  validationSignature: string,
): boolean {
  const cached = quoteValidationDecisionCache.get(
    quoteValidationCacheKey(validationSignature),
  );
  return cached?.validationSignature === validationSignature;
}

export function primeQuoteSourceIndexCacheForTests(
  evidenceSignature: string,
  sourceTexts: QuoteSourceText[],
): void {
  getOrBuildCachedQuoteSourceIndex(evidenceSignature, sourceTexts);
}

export function hasQuoteSourceIndexForTests(
  evidenceSignature: string,
): boolean {
  const cached = quoteSourceIndexCache.get(
    quoteValidationCacheKey(evidenceSignature),
  );
  return cached?.evidenceSignature === evidenceSignature;
}
