import {
  listPlanDocumentOutboxForConversation,
  loadPlanDocument,
  markPlanDocumentDelivered,
} from "./store";
import type { PlanDocument } from "./types";
import { notifyDocumentPublication } from "./publicationEvents";

/**
 * The text a chat message carries before the document it ends with, trimmed:
 * "" when the message is the document alone, undefined when it does not end
 * with the document. A message that leads with text the model wrote before
 * calling the tool shows that text above the document card; Copy, Export
 * and Save Note deliver the document alone.
 */
export function documentMessageLead(
  messageText: string,
  documentMarkdown: string,
): string | undefined {
  if (!documentMarkdown || !messageText.endsWith(documentMarkdown))
    return undefined;
  return messageText.slice(0, -documentMarkdown.length).trim();
}

/**
 * Completes the durable outbox only after the ordinary conversation store has
 * persisted the visible assistant text. Repeated calls are idempotent.
 *
 * The persisted text is the document's exact markdown, or -- when the model
 * wrote deliverable text before calling the tool -- that text followed by the
 * document. The second form is accepted only for the named document id.
 */
export async function deliverPendingPlanDocumentMessage(params: {
  conversationKey: number;
  visibleMarkdown: string;
  messageTimestamp: number;
  documentId?: string;
  /**
   * Runs after the pending document is validated and before it is marked
   * delivered. A failure here leaves the entry pending, so the next load
   * retries it. Must be idempotent.
   */
  beforeDelivered?: (document: PlanDocument) => Promise<void>;
}): Promise<PlanDocument | null> {
  const candidates = (
    await listPlanDocumentOutboxForConversation(params.conversationKey)
  ).sort((left, right) => {
    if (params.documentId) return 0;
    const leftTimestamp = Math.abs(
      left.messageTimestamp - params.messageTimestamp,
    );
    const rightTimestamp = Math.abs(
      right.messageTimestamp - params.messageTimestamp,
    );
    return leftTimestamp - rightTimestamp;
  });
  const carries = (visibleMarkdown: string) =>
    params.documentId
      ? documentMessageLead(params.visibleMarkdown, visibleMarkdown) !==
        undefined
      : visibleMarkdown === params.visibleMarkdown;
  const outbox = candidates.find(
    (entry) =>
      carries(entry.visibleMarkdown) &&
      (!params.documentId || entry.documentId === params.documentId),
  );
  if (!outbox) return null;
  const document = await loadPlanDocument(outbox.documentId);
  if (
    !document ||
    !carries(document.visibleMarkdown) ||
    document.visibleMarkdown !== outbox.visibleMarkdown
  ) {
    throw new Error(
      "Pending document does not match the persisted assistant message",
    );
  }
  if (outbox.status !== "pending" && outbox.status !== "delivered") return null;
  await params.beforeDelivered?.(document);
  await Zotero.DB.executeTransaction(async () => {
    await markPlanDocumentDelivered({
      documentId: document.documentId,
      deliveredAt: Date.now(),
      messageTimestamp: params.messageTimestamp,
    });
  });
  notifyDocumentPublication(document.documentId);
  return document;
}
