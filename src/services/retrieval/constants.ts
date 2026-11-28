export const CHUNK_TARGET_LENGTH = 2000;
export const CHUNK_OVERLAP = 200;
export const EMBEDDING_BATCH_SIZE = 16;
export const RRF_K = 60;
export const RETRIEVAL_TOP_K_PER_PAPER = 24;
export const RETRIEVAL_MMR_LAMBDA = 0.7;
export const RETRIEVAL_MIN_ACTIVE_PAPER_CHUNKS = 2;
export const RETRIEVAL_MIN_OTHER_PAPER_CHUNKS = 1;
export const PAPER_FOLLOWUP_RETRIEVAL_MIN_CHUNKS = 2;
export const PAPER_FOLLOWUP_RETRIEVAL_MAX_CHUNKS = 5;
export const COLLECTION_RETRIEVAL_MIN_SCORE_FALLBACK_PAPERS = 10;
// Owned by the LLM client layer (utils may not import services); re-exported
// here so retrieval and index code read every retrieval constant from one place.
export { EMBEDDING_BATCH_TIMEOUT_MS } from "../../utils/llmDefaults";
