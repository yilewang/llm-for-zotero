/**
 * Writing a display-gate verdict back into a stored assistant message.
 *
 * The gate locates a quote on a PDF page each time a chat is shown. Saving
 * that location into the message row lets a reloaded chat show the card as
 * located at once. A location is only as good as the file it was found in, so
 * the attachment's file state (size and modification time) is saved with it;
 * a later load trusts the location only while the file state still matches.
 *
 * Nothing here touches the database or Zotero. This module decides which
 * gate results qualify; the stored form and the JSON merge the stores apply
 * live in `src/shared/quoteLocationStorage.ts`, so the stored JSON and the
 * in-memory records change in exactly the same way.
 */
import type { QuoteCitation } from "../../shared/types";
import {
  mergeQuoteLocationWrite,
  normalizeQuoteSourceFileState,
  quoteSourceFileStatesEqual,
  recordMatchesWrite,
  QUOTE_LOCATION_FIELDS,
  type QuoteCitationWithFileState,
  type QuoteLocationFields,
  type QuoteLocationWrite,
  type QuoteSourceFileState,
} from "../../shared/quoteLocationStorage";
import {
  hasVerifiedQuoteLocation,
  isPageTextSourceFingerprint,
} from "./quoteCitations";

export {
  mergeQuoteLocationWritesIntoStoredJson,
  normalizeQuoteSourceFileState,
  quoteSourceFileStatesEqual,
  restoreQuoteSourceFileStates,
  QUOTE_LOCATION_FIELDS,
  type QuoteCitationWithFileState,
  type QuoteLocationFields,
  type QuoteLocationWrite,
  type QuoteSourceFileState,
} from "../../shared/quoteLocationStorage";

/**
 * A verified location found in real PDF page text: the page-text cache
 * (`page-text:`) or the live pdf.js document (`pdfjs:`). Paper text such as
 * MinerU output (`fnv1a32-*`) never names a PDF page, so it is never saved
 * as a location.
 */
export function hasPersistableQuoteLocation(citation: QuoteCitation): boolean {
  return (
    hasVerifiedQuoteLocation(citation) &&
    isPageTextSourceFingerprint(citation.sourceFingerprint)
  );
}

function pickQuoteLocationFields(citation: QuoteCitation): QuoteLocationFields {
  const location: QuoteLocationFields = {};
  for (const field of QUOTE_LOCATION_FIELDS) {
    if (citation[field] !== undefined) {
      (location as Record<string, unknown>)[field] = citation[field];
    }
  }
  return location;
}

/**
 * The location writes one gate pass justifies. A finalized record qualifies
 * when it was located on real PDF page text, the stored message already holds
 * a record with its id in the same attachment, the stored record with the new
 * location still passes the location check, the attachment's file state is
 * known, and the stored record does not already hold this exact location and
 * file state.
 */
export function collectQuoteLocationWrites(params: {
  storedQuoteCitations: readonly QuoteCitation[] | undefined;
  finalizedQuoteCitations: readonly QuoteCitation[] | undefined;
  fileStates: ReadonlyMap<number, QuoteSourceFileState | null>;
}): QuoteLocationWrite[] {
  const storedById = new Map<string, QuoteCitationWithFileState>();
  for (const record of params.storedQuoteCitations || []) {
    if (!storedById.has(record.id)) storedById.set(record.id, record);
  }
  const writes: QuoteLocationWrite[] = [];
  const seen = new Set<string>();
  for (const finalized of params.finalizedQuoteCitations || []) {
    if (seen.has(finalized.id) || !hasPersistableQuoteLocation(finalized)) {
      continue;
    }
    const record = storedById.get(finalized.id);
    const contextItemId = Math.floor(Number(finalized.contextItemId));
    if (!record || Math.floor(Number(record.contextItemId)) !== contextItemId) {
      continue;
    }
    const sourceFileState = normalizeQuoteSourceFileState(
      params.fileStates.get(contextItemId),
    );
    if (!sourceFileState) continue;
    const write: QuoteLocationWrite = {
      id: finalized.id,
      contextItemId,
      location: pickQuoteLocationFields(finalized),
      sourceFileState,
    };
    const merged = mergeQuoteLocationWrite(
      record as QuoteCitationWithFileState & Record<string, unknown>,
      write,
    );
    if (!hasPersistableQuoteLocation(merged)) continue;
    const unchanged =
      quoteSourceFileStatesEqual(record.sourceFileState, sourceFileState) &&
      QUOTE_LOCATION_FIELDS.every((field) => record[field] === merged[field]);
    if (unchanged) continue;
    seen.add(finalized.id);
    writes.push(write);
  }
  return writes;
}

/** The in-memory form of `mergeQuoteLocationWritesIntoStoredJson`. */
export function applyQuoteLocationWrites(
  citations: QuoteCitation[] | undefined,
  writes: readonly QuoteLocationWrite[],
): QuoteCitation[] | undefined {
  if (!citations?.length || !writes.length) return citations;
  return citations.map((citation) => {
    const write = writes.find((candidate) =>
      recordMatchesWrite(citation, candidate),
    );
    return write
      ? mergeQuoteLocationWrite(
          citation as QuoteCitation & Record<string, unknown>,
          write,
        )
      : citation;
  });
}

/**
 * The record without its saved page occurrence and file state, so the gate
 * locates it again. The match provenance stays: it is what keeps a minted
 * record through `normalizeQuoteCitations`, and records saved before the
 * write-back look exactly like this.
 */
export function withoutPersistedQuoteLocation(
  citation: QuoteCitationWithFileState,
): QuoteCitation {
  const {
    sourceFileState: _fileState,
    sourceMatchPageOccurrence: _occurrence,
    ...rest
  } = citation;
  void _fileState;
  void _occurrence;
  return rest;
}
