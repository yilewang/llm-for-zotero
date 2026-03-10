import type { AgentRuntimeRequest } from "../types";

/**
 * Intent flags derived from a single request.
 * Tools declare which intents they respond to instead of each implementing
 * their own private keyword/regex detection.
 */
export type RequestIntent = {
  /** Equation, figure, table or formula referenced by number, or visible in the reader */
  isPdfVisualQuery: boolean;
  /** Request to compare or contrast two or more papers */
  isComparisonQuery: boolean;
  /** Request to add, apply, or suggest tags on papers */
  isTaggingQuery: boolean;
  /** Request to fix, clean, or complete bibliographic metadata */
  isMetadataAuditQuery: boolean;
  /** Request to move unfiled papers into a collection/folder */
  isMoveToCollectionQuery: boolean;
  /**
   * Request that targets many papers or the whole library at once —
   * e.g. "tag all papers", "reorganise my entire library".
   * Used to raise MAX_AGENT_ROUNDS so the loop can process large item sets.
   */
  isBulkOperation: boolean;
  /** Self-contained demo/test tool trigger (test-only) */
  isDemoToolQuery: boolean;
  /** At least one screenshot is attached */
  hasScreenshots: boolean;
  /** Two or more distinct papers are in the conversation context */
  hasMultiplePaperContexts: boolean;
};

export function classifyRequest(request: AgentRuntimeRequest): RequestIntent {
  const text = (request.userText || "").trim().toLowerCase();

  const hasScreenshots =
    Array.isArray(request.screenshots) &&
    request.screenshots.some(Boolean);

  const paperContexts = [
    ...(request.selectedPaperContexts || []),
    ...(request.pinnedPaperContexts || []),
  ];
  const hasMultiplePaperContexts =
    new Set(paperContexts.map((p) => p.itemId)).size >= 2;

  // ── PDF visual query ──────────────────────────────────────────────────────
  // Matches: explicit "currently looking at" language, numbered
  // equation/figure/table references, general visual terms, or screenshots.
  const isPdfVisualQuery =
    hasScreenshots ||
    /\b(currently|looking at|this page|right now|visible|open|reader)\b/.test(text) ||
    /\b(this equation|this figure|this table|this formula|this symbol|explain this|what is this|what does this show)\b/.test(
      text,
    ) ||
    /\b(equation|eq|figure|fig|table|formula|theorem|proof|diagram|chart|plot)\s*\.?\s*\d+\b/.test(
      text,
    ) ||
    /\b(pdf|page|layout|panel|equation|formula|figure|diagram|plot|table|chart|graph|theorem|proof|matrix|integral|summation|derivation|symbol)\b/.test(
      text,
    );

  // ── Comparison query ──────────────────────────────────────────────────────
  const isComparisonQuery =
    /\b(compare|contrast|difference|similarit|versus|vs\.?)\b/i.test(text);

  // ── Tagging query ─────────────────────────────────────────────────────────
  const isTaggingQuery =
    /\btag(?:s|ging)?\b/.test(text) &&
    /\b(add|apply|assign|put|give|suggest|recommend|help|organize|categorize)\b/.test(
      text,
    );

  // ── Metadata audit query ──────────────────────────────────────────────────
  const isMetadataAuditQuery =
    /\bmetadata\b/.test(text) ||
    (/\b(doi|title|abstract|journal|authors?|creator|date|pages|volume|issue|url|isbn|issn|publisher)\b/.test(
      text,
    ) &&
      /\b(fix|edit|correct|clean|standardi[sz]e|complete|update|fill|repair)\b/.test(
        text,
      ));

  // ── Move-to-collection query ──────────────────────────────────────────────
  const isMoveToCollectionQuery =
    /\b(unfiled|no collection|without collection)\b/.test(text) &&
    /\b(move|put|file|organize|assign|add)\b/.test(text) &&
    /\b(collections?|folders?)\b/.test(text);

  // ── Bulk operation ────────────────────────────────────────────────────────
  // User is asking to act on many papers / the entire library at once.
  const isBulkOperation =
    (/\ball\b|\beverything\b|\bentire\b|\bevery\b/.test(text) ||
      /\bmy library\b|\bwhole library\b/.test(text) ||
      /\bthousands?\b|\bhundreds?\b|\bmany papers?\b/.test(text)) &&
    /\b(tag|organize|organise|move|file|audit|clean|fix|update|apply|assign|categorize|categorise|review|rename)\b/.test(
      text,
    );

  // ── Demo tool (test-only) ─────────────────────────────────────────────────
  const isDemoToolQuery =
    /\bself[- ]?contained\b|\bdemo tool\b/i.test(request.userText || "");

  return {
    isPdfVisualQuery,
    isComparisonQuery,
    isTaggingQuery,
    isMetadataAuditQuery,
    isMoveToCollectionQuery,
    isBulkOperation,
    isDemoToolQuery,
    hasScreenshots,
    hasMultiplePaperContexts,
  };
}
