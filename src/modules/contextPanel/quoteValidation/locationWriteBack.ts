/**
 * Saving the quote gate's PDF-page locations into the stored messages, and
 * deciding on load which saved locations can still be trusted.
 *
 * After a gate pass, each card the gate located on real PDF page text is
 * merged, by record id, into the message's stored record, together with the
 * attachment's file state. On load, a saved location is kept only while the
 * attachment's file state still matches; otherwise the page occurrence is
 * removed in memory, so the gate checks the quote again and saves the new
 * result.
 *
 * The write itself goes through the panel's conversation routing (write lock,
 * generation and freeze fences, the conversation's own store). The panel
 * installs it here at startup, because the panel imports the validator and the
 * validator cannot import the panel back.
 */
import { appLogger } from "../../../core/logging";
import { createSurfaceBridge } from "../../../services/surfaceBridge";
import {
  applyQuoteLocationWrites,
  collectQuoteLocationWrites,
  hasPersistableQuoteLocation,
  quoteSourceFileStatesEqual,
  withoutPersistedQuoteLocation,
  type QuoteCitationWithFileState,
  type QuoteLocationWrite,
  type QuoteSourceFileState,
} from "../../../services/quotes/quoteLocationPersistence";
import { hasVerifiedQuoteLocation } from "../../../services/quotes/quoteCitations";
import { getConversationWriteGeneration } from "../../../shared/conversationWriteFence";
import type { QuoteCitation } from "../../../shared/types";
import { readAttachmentFileState } from "../../../utils/attachmentFileState";
import { chatHistory } from "../state";
import type { Message } from "../types";

export type QuoteLocationWriteRequest = {
  conversationKey: number;
  /** The conversation write generation when the gate pass ended. */
  expectedGeneration: number;
  /** The stored assistant row's timestamp. */
  timestamp: number;
  /** The stored assistant row's id, when the message carries it. */
  messageId?: number;
  writes: QuoteLocationWrite[];
};

/** Writes one row's quote locations; resolves whether a row was written. */
export type QuoteLocationWriter = (
  request: QuoteLocationWriteRequest,
) => Promise<boolean>;

const writerBridge = createSurfaceBridge<QuoteLocationWriter>(
  "quote location write-back",
);

export function configureQuoteLocationWriter(
  writer: QuoteLocationWriter | null,
): () => void {
  return writerBridge.configure(writer);
}

type QuoteSourceFileStateReader = (
  contextItemId: number,
) => Promise<QuoteSourceFileState | null>;

async function readQuoteSourceFileState(
  contextItemId: number,
): Promise<QuoteSourceFileState | null> {
  let item: Zotero.Item | null = null;
  try {
    item = Zotero.Items.get(contextItemId) || null;
  } catch {
    return null;
  }
  const state = await readAttachmentFileState(item);
  if (!state || state.size === null || state.mtime === null) return null;
  return { size: state.size, mtime: state.mtime };
}

let fileStateReader: QuoteSourceFileStateReader = readQuoteSourceFileState;

/** Test-only: replace the attachment stat; null restores the real one. */
export function setQuoteSourceFileStateReaderForTests(
  reader: QuoteSourceFileStateReader | null,
): void {
  fileStateReader = reader || readQuoteSourceFileState;
}

async function readFileStates(
  contextItemIds: Iterable<number>,
): Promise<Map<number, QuoteSourceFileState | null>> {
  // Each attachment is stat'ed on its own; the reads do not depend on each
  // other, so they run together instead of one round trip after another.
  const uniqueIds = Array.from(new Set(contextItemIds));
  const results = await Promise.all(
    uniqueIds.map(async (contextItemId) => {
      try {
        return await fileStateReader(contextItemId);
      } catch {
        return null;
      }
    }),
  );
  const states = new Map<number, QuoteSourceFileState | null>();
  uniqueIds.forEach((contextItemId, index) => {
    states.set(contextItemId, results[index]);
  });
  return states;
}

function messageMessageId(message: Message): number | undefined {
  const id = Math.floor(Number((message as { id?: unknown }).id));
  return Number.isFinite(id) && id > 0 ? id : undefined;
}

/** Write-backs in flight, chained per message so they land in order. */
const pendingWriteBacks = new Map<Message, Promise<void>>();

async function writeBackQuoteLocations(params: {
  conversationKey: number;
  message: Message;
  rawMarkdown: string;
  finalizedQuoteCitations: readonly QuoteCitation[] | undefined;
  /** The conversation generation when the gate pass ended. */
  expectedGeneration: number;
}): Promise<void> {
  const { conversationKey, message, rawMarkdown, expectedGeneration } = params;
  const writer = writerBridge.current();
  if (!writer) return;
  const candidates = (params.finalizedQuoteCitations || []).filter(
    hasPersistableQuoteLocation,
  );
  if (!candidates.length) return;
  const storedIds = new Set(
    (message.quoteCitations || []).map((citation) => citation.id),
  );
  const contextItemIds = candidates
    .filter((citation) => storedIds.has(citation.id))
    .map((citation) => Math.floor(Number(citation.contextItemId)));
  if (!contextItemIds.length) return;
  const fileStates = await readFileStates(contextItemIds);
  // The message may have been edited, regenerated, or dropped while the
  // attachments were read; its saved row would then no longer be this one.
  if (
    message.text !== rawMarkdown ||
    !chatHistory.get(conversationKey)?.includes(message)
  ) {
    return;
  }
  const writes = collectQuoteLocationWrites({
    storedQuoteCitations: message.quoteCitations,
    finalizedQuoteCitations: candidates,
    fileStates,
  });
  if (!writes.length) return;
  const timestamp = message.timestamp;
  const written = await writer({
    conversationKey,
    expectedGeneration,
    timestamp,
    messageId: messageMessageId(message),
    writes,
  });
  if (!written || message.timestamp !== timestamp) return;
  message.quoteCitations = applyQuoteLocationWrites(
    message.quoteCitations,
    writes,
  );
}

/**
 * Save the locations one gate pass verified for `message`. Called once per
 * message per pass; the write runs in the background, after any earlier
 * write-back of the same message.
 */
export function scheduleQuoteLocationWriteBack(params: {
  conversationKey: number;
  message: Message;
  rawMarkdown: string;
  finalizedQuoteCitations: readonly QuoteCitation[] | undefined;
}): void {
  if (!writerBridge.current()) return;
  if (!params.finalizedQuoteCitations?.some(hasPersistableQuoteLocation)) {
    return;
  }
  const previous = pendingWriteBacks.get(params.message) || Promise.resolve();
  const expectedGeneration = getConversationWriteGeneration(
    params.conversationKey,
  );
  const task = previous
    .then(() => writeBackQuoteLocations({ ...params, expectedGeneration }))
    .catch((error) => {
      appLogger.warn("LLM: saving verified quote locations failed", error);
    });
  pendingWriteBacks.set(params.message, task);
  void task.finally(() => {
    if (pendingWriteBacks.get(params.message) === task) {
      pendingWriteBacks.delete(params.message);
    }
  });
}

/** Test-only: resolves when every scheduled write-back has finished. */
export async function waitForQuoteLocationWriteBacksForTests(): Promise<void> {
  while (pendingWriteBacks.size) {
    await Promise.all(Array.from(pendingWriteBacks.values()));
  }
}

/**
 * Before a loaded conversation is shown, drop every saved location whose
 * attachment file no longer matches the file state saved with it (or that
 * has no file state at all). Only the in-memory records change; the next gate
 * pass checks those quotes again and saves the new result.
 */
export async function reconcilePersistedQuoteLocations(
  messages: ReadonlyArray<{ role: string; quoteCitations?: QuoteCitation[] }>,
): Promise<void> {
  const contextItemIds = new Set<number>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const citation of message.quoteCitations || []) {
      const state = (citation as QuoteCitationWithFileState).sourceFileState;
      if (state && hasVerifiedQuoteLocation(citation)) {
        contextItemIds.add(Math.floor(Number(citation.contextItemId)));
      }
    }
  }
  const fileStates = await readFileStates(contextItemIds);
  for (const message of messages) {
    if (message.role !== "assistant" || !message.quoteCitations?.length) {
      continue;
    }
    let changed = false;
    const next = message.quoteCitations.map((citation) => {
      if (!hasVerifiedQuoteLocation(citation)) return citation;
      const saved = (citation as QuoteCitationWithFileState).sourceFileState;
      const current = fileStates.get(
        Math.floor(Number(citation.contextItemId)),
      );
      if (saved && quoteSourceFileStatesEqual(saved, current)) return citation;
      changed = true;
      return withoutPersistedQuoteLocation(citation);
    });
    if (changed) message.quoteCitations = next;
  }
}
