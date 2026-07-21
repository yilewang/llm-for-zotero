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

export type GeneratedChatImage = {
  id: string;
  label?: string;
  path?: string;
  src?: string;
  revisedPrompt?: string;
};

export type PaperContentSourceMode =
  | "text"
  | "mineru"
  | "pdf"
  | "markdown"
  | "html"
  | "txt"
  | "docx";

export type ModelInputMode = "text_only" | "vision_allowed";

export type AdvancedModelParams = {
  temperature: number;
  maxTokens: number;
  inputTokenCap?: number;
  inputMode?: ModelInputMode;
};

export type PaperContextRef = {
  itemId: number;
  contextItemId: number;
  contentSourceMode?: PaperContentSourceMode;
  citationKey?: string;
  title: string;
  attachmentTitle?: string;
  firstCreator?: string;
  year?: string;
  /** Full path to durable MinerU text metadata plus PDF figure crop cache. */
  mineruCacheDir?: string;
};

export type LocalDocumentResource = Readonly<{
  kind: "local_pdf";
  sourceKey: `zotero-pdf:${number}:${number}`;
  itemId: number;
  contextItemId: number;
  title: string;
  name: string;
  mimeType: "application/pdf";
  absolutePath: string;
}>;

export type QuoteCitation = {
  id: string;
  quoteText: string;
  displayQuoteText?: string;
  citationLabel: string;
  sourceMatchText?: string;
  sourceMatchKind?:
    | "trusted"
    | "exact"
    | "ellipsis-segment"
    | "raw-prefix"
    | "raw-suffix"
    | "raw-middle"
    | "progressive"
    | "selected-text"
    | "normalized-span";
  sourceMatchSource?: "context-text" | "pdf-page-text";
  sourceSectionLabel?: string;
  sourceChunkKind?: string;
  contextItemId?: number;
  itemId?: number;
  /** Fingerprint of the extracted source used to ground the quote. */
  sourceFingerprint?: string;
  /** Zero-based occurrence of the full quote on the hinted PDF page. */
  sourceMatchPageOccurrence?: number;
  /** Best-effort zero-based PDF page hint for fast initial quote navigation. */
  pageHintIndex?: number;
  /** Best-effort printed page label from Zotero/PDF metadata. */
  pageHintLabel?: string;
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

/** Stable user-selected text state persisted with a conversation turn. */
export type SelectedTextContext = {
  text: string;
  source: SelectedTextSource;
  paperContext?: PaperContextRef;
  noteContext?: NoteContextRef;
  /** Zotero attachment or note item that owns the selected text. */
  contextItemId?: number;
  /** Zero-based PDF page index used for machine operations. */
  pageIndex?: number;
  /** User-facing PDF page label, which may be non-numeric. */
  pageLabel?: string;
};

export type SelectedTextAnchorResolution = "chunks" | "page" | "locator-only";

/**
 * Ephemeral model-facing context resolved from a stable selected-text context.
 * Chunk indexes and expanded text are intentionally recomputed for every send.
 */
export type ResolvedSelectedTextAnchor = {
  contextIndex: number;
  contextItemId: number;
  pageIndex?: number;
  pageLabel?: string;
  paperContext?: PaperContextRef;
  resolution: SelectedTextAnchorResolution;
  primaryChunkIndex?: number;
  preferredChunkIndexes: number[];
  contextText?: string;
  sourceType?: string;
  injectedChars: number;
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

/** A Zotero tag or tag scope selected as context scope. */
export type TagContextRef = {
  name: string;
  libraryID: number;
  normalizedName?: string;
  scope?: "allTagged" | "untagged";
  includeAutomatic?: boolean;
};

export type ActiveNoteSession = {
  noteKind: "item" | "standalone";
  noteId: number;
  libraryID: number;
  title: string;
  parentItemId?: number;
  conversationKind: "paper" | "global";
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
  conversationID: string;
  conversationKey: number;
  libraryID: number;
  createdAt: number;
  title?: string;
  lastActivityAt: number;
  userTurnCount: number;
};

export type PaperConversationSummary = {
  conversationID: string;
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
  conversationID: string;
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
  conversationID: string;
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
