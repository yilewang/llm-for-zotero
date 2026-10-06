import type { Message } from "./types";

/**
 * The user-row patch that the plain-chat and agent flows write when they
 * update the latest user message: the send's context-plan update, the
 * retry's rewrite and restore, and the agent's onStart, tool-result and
 * retry-restore updates.
 *
 * The store UPDATE overwrites every column it names, so a field a site
 * leaves out is written as NULL. Hand-copied patches lost the forced skills,
 * the tag contexts and the note contexts that way. Every field is always
 * present here, even when its value is undefined; a site changes a field
 * through `overrides`, not by leaving it out.
 */
export type StoredUserRowPatch = Pick<
  Message,
  | "text"
  | "timestamp"
  | "runMode"
  | "agentRunId"
  | "selectedText"
  | "selectedTextContexts"
  | "selectedTexts"
  | "selectedTextSources"
  | "selectedTextPaperContexts"
  | "selectedTextNoteContexts"
  | "forcedSkillIds"
  | "screenshotImages"
  | "paperContexts"
  | "pdfPaperContexts"
  | "fullTextPaperContexts"
  | "citationPaperContexts"
  | "selectedCollectionContexts"
  | "selectedTagContexts"
  | "attachments"
  | "modelAttachments"
  | "modelName"
  | "modelEntryId"
  | "modelProviderLabel"
> & { conversationGeneration?: number };

export function toStoredUserRowPatch(
  message: Message,
  overrides: Partial<StoredUserRowPatch> = {},
): StoredUserRowPatch {
  return {
    text: message.text,
    timestamp: message.timestamp,
    runMode: message.runMode,
    agentRunId: message.agentRunId,
    selectedText: message.selectedText,
    selectedTextContexts: message.selectedTextContexts,
    selectedTexts: message.selectedTexts,
    selectedTextSources: message.selectedTextSources,
    selectedTextPaperContexts: message.selectedTextPaperContexts,
    selectedTextNoteContexts: message.selectedTextNoteContexts,
    forcedSkillIds: message.forcedSkillIds,
    screenshotImages: message.screenshotImages,
    paperContexts: message.paperContexts,
    pdfPaperContexts: message.pdfPaperContexts,
    fullTextPaperContexts: message.fullTextPaperContexts,
    citationPaperContexts: message.citationPaperContexts,
    selectedCollectionContexts: message.selectedCollectionContexts,
    selectedTagContexts: message.selectedTagContexts,
    attachments: message.attachments,
    modelAttachments: message.modelAttachments,
    modelName: message.modelName,
    modelEntryId: message.modelEntryId,
    modelProviderLabel: message.modelProviderLabel,
    ...overrides,
  };
}
