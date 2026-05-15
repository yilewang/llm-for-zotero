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

export type QuoteCitation = {
  id: string;
  quoteText: string;
  citationLabel: string;
  contextItemId?: number;
  itemId?: number;
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

/** A Zotero collection selected as context scope. */
export type CollectionContextRef = {
  collectionId: number;
  name: string;
  libraryID: number;
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
  };
};

export type ActiveNoteContext = {
  noteId: number;
  title: string;
  noteKind: "item" | "standalone";
  parentItemId?: number;
  noteText: string;
  /** Raw HTML of the note, provided so the agent can see the original
   *  structure and inline styles when editing styled/template notes. */
  noteHtml?: string;
};

export type ConversationSystem = "upstream" | "claude_code" | "codex";

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

export type ClaudeConversationKind = "global" | "paper";

export type ClaudeConversationSummary = {
  conversationKey: number;
  libraryID: number;
  kind: ClaudeConversationKind;
  paperItemID?: number;
  createdAt: number;
  updatedAt: number;
  title?: string;
  providerSessionId?: string;
  scopedConversationKey?: string;
  scopeType?: string;
  scopeId?: string;
  scopeLabel?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  userTurnCount: number;
};

export type CodexConversationKind = "global" | "paper";

export type CodexConversationSummary = {
  conversationKey: number;
  libraryID: number;
  kind: CodexConversationKind;
  paperItemID?: number;
  createdAt: number;
  updatedAt: number;
  title?: string;
  providerSessionId?: string;
  scopedConversationKey?: string;
  scopeType?: string;
  scopeId?: string;
  scopeLabel?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  userTurnCount: number;
};
