import type { AgentRuntimeRequest } from "../types";

/**
 * Intent flags derived from a single request.
 * Used to adjust agent runtime behaviour (e.g. round limits).
 */
export type RequestIntent = {
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
};

export function classifyRequest(request: AgentRuntimeRequest): RequestIntent {
  const text = (request.userText || "").trim().toLowerCase();

  const hasScreenshots =
    Array.isArray(request.screenshots) && request.screenshots.some(Boolean);

  const isBulkOperation =
    (/\ball\b|\beverything\b|\bentire\b|\bevery\b/.test(text) ||
      /\bmy library\b|\bwhole library\b/.test(text) ||
      /\bthousands?\b|\bhundreds?\b|\bmany papers?\b/.test(text)) &&
    /\b(tag|organize|organise|move|file|audit|clean|fix|update|apply|assign|categorize|categorise|review|rename)\b/.test(
      text,
    );

  const isDemoToolQuery = /\bself[- ]?contained\b|\bdemo tool\b/i.test(
    request.userText || "",
  );

  return {
    isBulkOperation,
    isDemoToolQuery,
    hasScreenshots,
  };
}
