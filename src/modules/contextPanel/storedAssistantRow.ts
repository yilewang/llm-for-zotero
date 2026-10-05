import type { Message } from "./types";

/**
 * The assistant-row fields that every plain-chat write sends to the store:
 * the send flow and the retry flow's completion, cancel, and interrupted paths.
 * Each site spreads this and adds its own keys.
 *
 * Every key is always present, even when its value is undefined. The store
 * UPDATE overwrites every column it names (the Claude and Codex stores keep
 * the context counts when they are NULL), so an omitted key and an undefined
 * key both write NULL; a site that must not carry a field omits it from its
 * extension.
 */
export type StoredAssistantRowBase = Pick<
  Message,
  | "text"
  | "timestamp"
  | "runMode"
  | "agentRunId"
  | "interrupted"
  | "modelName"
  | "modelEntryId"
  | "modelProviderLabel"
  | "reasoningSummary"
  | "reasoningDetails"
  | "compactMarker"
  | "quoteCitations"
  | "generatedImages"
> & { conversationGeneration: number };

export function toStoredAssistantRow(
  message: Message,
  conversationGeneration: number,
): StoredAssistantRowBase {
  return {
    conversationGeneration,
    text: message.text,
    timestamp: message.timestamp,
    runMode: message.runMode,
    agentRunId: message.agentRunId,
    interrupted: message.interrupted,
    modelName: message.modelName,
    modelEntryId: message.modelEntryId,
    modelProviderLabel: message.modelProviderLabel,
    reasoningSummary: message.reasoningSummary,
    reasoningDetails: message.reasoningDetails,
    compactMarker: message.compactMarker,
    quoteCitations: message.quoteCitations,
    generatedImages: message.generatedImages,
  };
}
