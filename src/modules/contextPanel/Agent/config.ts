/**
 * Central configuration for the Zotero agent retrieval loop.
 * Adjust these constants to tune agent behavior without modifying logic.
 */

/** Default maximum number of ReAct loop iterations (tool calls) per question. */
export const DEFAULT_MAX_AGENT_ITERATIONS = 10;

/** Number of consecutive non-progressing steps before stopping retrieval. */
export const MAX_NO_PROGRESS_STEPS = 2;

/** Fraction of the total context budget reserved for the library metadata prefix. */
export const AGENT_METADATA_PREFIX_RATIO = 0.25;

/** Maximum number of public trace lines emitted by a single planning step. */
export const MAX_AGENT_TRACE_LINES = 1;

/** Maximum character length of a single trace line. */
export const MAX_AGENT_TRACE_LINE_LENGTH = 80;

/** Router summary context shaping limits. */
export const MAX_ROUTER_HISTORY_LINES = 8;
export const MAX_ROUTER_TOOL_LOG_LINES = 8;
export const MAX_ROUTER_CONTEXT_DESCRIPTORS = 12;
export const MAX_ROUTER_HISTORY_LINE_CHARS = 160;
export const MAX_ROUTER_TOOL_LOG_RECENT_LINES = 2;
export const ROUTER_CONTEXT_BUDGET_SOFT_RATIO = 0.9;

/** Router model-call shaping defaults. */
export const ROUTER_TRACE_MAX_CHARS = 500;
export const ROUTER_MODEL_TEMPERATURE = 0;
export const ROUTER_MODEL_MAX_TOKENS = 500;

/** Responder context shaping defaults. */
export const MAX_RESPONDER_TOOL_LOG_LINES = 8;

/** Library context rendering defaults. */
export const ABSTRACT_SNIPPET_MAX_CHARS = 360;
export const MAX_SELECTED_PAPER_TRACE_LABELS = 4;
export const SEARCH_CANDIDATE_WIDEN_FACTOR = 4;

/** search_internet defaults and guardrails. */
export const SEARCH_INTERNET_DEFAULT_LIMIT = 6;
export const SEARCH_INTERNET_MAX_LIMIT = 10;
export const SEARCH_INTERNET_ABSTRACT_PREVIEW_CHARS = 300;
export const SEARCH_INTERNET_FETCH_TIMEOUT_MS = 10_000;

/** search_paper_content defaults. */
export const SEARCH_PAPER_CONTENT_MAX_SNIPPETS = 20;
export const SEARCH_PAPER_CONTENT_MIN_TOKEN_BUDGET = 1000;
export const SEARCH_PAPER_CONTENT_DEFAULT_TOKEN_BUDGET = 36000;

/** read_references fallback cap when no token budget is provided. */
export const READ_REFERENCES_FALLBACK_TOP_K = 12;

/** find_claim_evidence selection defaults. */
export const RAW_EVIDENCE_TOP_K = 20;
export const DEFAULT_EVIDENCE_TOP_K = 10;
export const MAX_EVIDENCE_TOP_K = 15;

/**
 * When true, find_claim_evidence verifies each retrieved evidence snippet with
 * a second model call before returning it.  Disabled by default for latency reasons.
 */
export const ENABLE_FIND_CLAIM_EVIDENCE_VERIFIER = false;

/** write_note defaults. */
export const NOTE_PAPER_CONTEXT_TOKENS = 6000;
export const NOTE_MAX_OUTPUT_TOKENS = 8192;

/** fix_metadata defaults. */
export const FIX_METADATA_PAPER_CONTEXT_TOKENS = 6000;
export const FIX_METADATA_MAX_OUTPUT_TOKENS = 800;
