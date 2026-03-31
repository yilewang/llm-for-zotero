/**
 * Shared domain types used by both the agent layer and the contextPanel layer.
 * This file has zero imports — all types are pure data shapes.
 */

export type SelectedTextSource = "pdf" | "model" | "note" | "note-edit";

export type ChatAttachmentCategory =
  | "image"
  | "pdf"
  | "markdown"
  | "code"
  | "text"
  | "file";

export type ChatAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  category: ChatAttachmentCategory;
  imageDataUrl?: string;
  textContent?: string;
  storedPath?: string;
  contentHash?: string;
};

export type AdvancedModelParams = {
  temperature: number;
  maxTokens: number;
  inputTokenCap?: number;
};

export type PaperContextRef = {
  itemId: number;
  contextItemId: number;
  citationKey?: string;
  title: string;
  attachmentTitle?: string;
  firstCreator?: string;
  year?: string;
  /** Full path to MinerU parsed cache directory (contains full.md + images/). */
  mineruCacheDir?: string;
};

/** A Zotero note (item note or standalone) selected as a reference context. */
export type NoteContextRef = {
  libraryID: number;
  noteItemKey: string;
  noteItemId?: number;
  parentItemId?: number;
  parentItemKey?: string;
  noteKind: "item" | "standalone";
  title: string;
};

/** A non-PDF, non-note file attachment (image/figure or other file) selected as reference context. */
export type OtherContextRef = {
  contextItemId: number;
  parentItemId?: number;
  title: string;
  contentType: string;
  refKind: "figure" | "other";
};

export type ActiveNoteSession = {
  noteKind: "item" | "standalone";
  noteId: number;
  title: string;
  parentItemId?: number;
  displayConversationKind: "paper" | "global";
  capabilities: {
    showModeSwitch: boolean;
    showNewConversation: boolean;
    showHistory: boolean;
    showOpenLock: boolean;
  };
};

export type ActiveNoteContext = {
  noteId: number;
  title: string;
  noteKind: "item" | "standalone";
  parentItemId?: number;
  noteText: string;
};

export type GlobalConversationSummary = {
  conversationKey: number;
  libraryID: number;
  createdAt: number;
  title?: string;
  lastActivityAt: number;
  userTurnCount: number;
};

export type PaperConversationSummary = {
  conversationKey: number;
  libraryID: number;
  paperItemID: number;
  sessionVersion: number;
  createdAt: number;
  title?: string;
  lastActivityAt: number;
  userTurnCount: number;
};
