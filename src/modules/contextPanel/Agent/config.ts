/**
 * Central configuration for the Zotero agent retrieval loop.
 * Adjust these constants to tune agent behavior without modifying logic.
 */

/** Default maximum number of ReAct loop iterations (tool calls) per question. */
export const DEFAULT_MAX_AGENT_ITERATIONS = 4;

/** Fraction of the total context budget reserved for the library metadata prefix. */
export const AGENT_METADATA_PREFIX_RATIO = 0.25;

/** Maximum number of public trace lines emitted by a single planning step. */
export const MAX_AGENT_TRACE_LINES = 1;

/** Maximum character length of a single trace line. */
export const MAX_AGENT_TRACE_LINE_LENGTH = 80;

/**
 * When true, find_claim_evidence verifies each retrieved evidence snippet with
 * a second model call before returning it.  Disabled by default for latency reasons.
 */
export const ENABLE_FIND_CLAIM_EVIDENCE_VERIFIER = false;
