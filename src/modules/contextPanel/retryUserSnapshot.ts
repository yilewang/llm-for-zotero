import type { Message } from "./types";

/**
 * Snapshot/restore for the paired user message during a retry.
 *
 * Both retry paths (chat.ts retryLatestAssistantResponse and agentEngine.ts
 * retryAgentTurn) rewrite the user row's model identity, rebuilt contexts and
 * run linkage before the request is dispatched — and persist that row before
 * any output exists. A zero-output failure restores the previous assistant
 * answer, so the user row must travel back with it; otherwise the stored turn
 * pairs the old model-A answer with model-B retry metadata after a reload.
 *
 * The field list is the union of every user-message field either retry path
 * overwrites. Arrays are copied because streaming tool rounds may merge into
 * the live arrays in place rather than replacing them.
 */
export type RetryUserSnapshot = {
  agentRunId: Message["agentRunId"];
  selectedTextContexts: Message["selectedTextContexts"];
  screenshotImages: Message["screenshotImages"];
  paperContexts: Message["paperContexts"];
  pdfPaperContexts: Message["pdfPaperContexts"];
  fullTextPaperContexts: Message["fullTextPaperContexts"];
  citationPaperContexts: Message["citationPaperContexts"];
  selectedCollectionContexts: Message["selectedCollectionContexts"];
  modelAttachments: Message["modelAttachments"];
  modelName: Message["modelName"];
  modelEntryId: Message["modelEntryId"];
  modelProviderLabel: Message["modelProviderLabel"];
};

function copyArray<T>(value: T[] | undefined): T[] | undefined {
  return value ? [...value] : value;
}

export function takeRetryUserSnapshot(message: Message): RetryUserSnapshot {
  return {
    agentRunId: message.agentRunId,
    selectedTextContexts: copyArray(message.selectedTextContexts),
    screenshotImages: copyArray(message.screenshotImages),
    paperContexts: copyArray(message.paperContexts),
    pdfPaperContexts: copyArray(message.pdfPaperContexts),
    fullTextPaperContexts: copyArray(message.fullTextPaperContexts),
    citationPaperContexts: copyArray(message.citationPaperContexts),
    selectedCollectionContexts: copyArray(message.selectedCollectionContexts),
    modelAttachments: copyArray(message.modelAttachments),
    modelName: message.modelName,
    modelEntryId: message.modelEntryId,
    modelProviderLabel: message.modelProviderLabel,
  };
}

export function restoreRetryUserSnapshot(
  message: Message,
  snapshot: RetryUserSnapshot,
): void {
  message.agentRunId = snapshot.agentRunId;
  message.selectedTextContexts = copyArray(snapshot.selectedTextContexts);
  message.screenshotImages = copyArray(snapshot.screenshotImages);
  message.paperContexts = copyArray(snapshot.paperContexts);
  message.pdfPaperContexts = copyArray(snapshot.pdfPaperContexts);
  message.fullTextPaperContexts = copyArray(snapshot.fullTextPaperContexts);
  message.citationPaperContexts = copyArray(snapshot.citationPaperContexts);
  message.selectedCollectionContexts = copyArray(
    snapshot.selectedCollectionContexts,
  );
  message.modelAttachments = copyArray(snapshot.modelAttachments);
  message.modelName = snapshot.modelName;
  message.modelEntryId = snapshot.modelEntryId;
  message.modelProviderLabel = snapshot.modelProviderLabel;
}
