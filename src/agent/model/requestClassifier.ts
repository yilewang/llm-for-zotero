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
  requiresFullPaperRead: boolean;
};

export function classifyRequest(
  request: Pick<
    AgentRuntimeRequest,
    "classifiedIntent" | "metadata" | "screenshots"
  >,
): RequestIntent {
  return {
    isBulkOperation: request.classifiedIntent?.semantic?.bulk === true,
    isDemoToolQuery: request.metadata?.testDemoTool === true,
    hasScreenshots: Boolean(request.screenshots?.some(Boolean)),
    requiresFullPaperRead:
      request.classifiedIntent?.semantic?.reading.coverage === "exhaustive",
  };
}
