import { createReaderCallLimiter } from "../../shared/readerCompletion";

/**
 * Reader calls in flight at once in this Zotero process, over every
 * paper_digest call, every plugin-Agent digest part and every native (Codex
 * or Claude) paper_read full read. Each Claude call is a CLI query in the
 * bridge process and each Codex call a Responses request on the user's
 * login, beside the live turn. A call that names no timeout is bounded by
 * `LIMITED_READER_CALL_TIMEOUT_MS` once it holds a slot.
 */
export const HOST_READER_CALL_LIMIT = 4;

/** The one limit those reader calls wait on. */
export const hostReaderCallLimiter = createReaderCallLimiter(
  HOST_READER_CALL_LIMIT,
);
