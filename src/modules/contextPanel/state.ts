import type {
  Message,
  PdfContext,
  ReasoningLevelSelection,
  CustomShortcut,
  ChatAttachment,
  SelectedTextContext,
  PaperContextRef,
  OtherContextRef,
  ChatRuntimeMode,
  PaperContextSendMode,
} from "./types";
// =============================================================================
// Module State
// =============================================================================

export const chatHistory = new Map<number, Message[]>();
export const loadedConversationKeys = new Set<number>();
export const loadingConversationTasks = new Map<number, Promise<void>>();
export const selectedModelCache = new Map<number, string>();
export const selectedReasoningCache = new Map<
  number,
  ReasoningLevelSelection
>();
export const selectedRuntimeModeCache = new Map<number, ChatRuntimeMode>();

export const pdfTextCache = new Map<number, PdfContext>();
export const pdfTextLoadingTasks = new Map<number, Promise<void>>();
export const shortcutTextCache = new Map<string, string>();
export const shortcutMoveModeState = new WeakMap<Element, boolean>();
export const shortcutRenderItemState = new WeakMap<
  Element,
  Zotero.Item | null | undefined
>();
export const activeContextPanels = new Map<Element, () => Zotero.Item | null>();
export const activeContextPanelStateSync = new Map<Element, () => void>();
export const shortcutEscapeListenerAttached = new WeakSet<Document>();
export let readerContextPanelRegistered = false;
export function setReaderContextPanelRegistered(value: boolean) {
  readerContextPanelRegistered = value;
}

export let currentRequestId = 0;
export function nextRequestId(): number {
  return ++currentRequestId;
}
/**
 * Set to the current request ID when a request starts and cleared back to 0
 * in the finally block. Unlike currentAbortController, this stays non-null for
 * the entire lifecycle of a request, including pre-stream work.
 */
export let pendingRequestId = 0;
export function setPendingRequestId(id: number): void {
  pendingRequestId = id;
}
export let cancelledRequestId = -1;
export function setCancelledRequestId(value: number) {
  cancelledRequestId = value;
}
export let currentAbortController: AbortController | null = null;
export function setCurrentAbortController(value: AbortController | null) {
  currentAbortController = value;
}
export let panelFontScalePercent = 120; // FONT_SCALE_DEFAULT_PERCENT
export function setPanelFontScalePercent(value: number) {
  panelFontScalePercent = value;
}

export let responseMenuTarget: {
  item: Zotero.Item;
  contentText: string;
  modelName: string;
  conversationKey?: number;
  userTimestamp?: number;
  assistantTimestamp?: number;
} | null = null;
export function setResponseMenuTarget(value: typeof responseMenuTarget) {
  responseMenuTarget = value;
}

export let promptMenuTarget: {
  item: Zotero.Item;
  conversationKey: number;
  userTimestamp: number;
  assistantTimestamp: number;
  editable?: boolean;
} | null = null;
export function setPromptMenuTarget(value: typeof promptMenuTarget) {
  promptMenuTarget = value;
}

// Screenshot selection state (per item)
export const selectedImageCache = new Map<number, string[]>();
export const selectedFileAttachmentCache = new Map<number, ChatAttachment[]>();
export const selectedFilePreviewExpandedCache = new Map<number, boolean>();
export const selectedPaperContextCache = new Map<number, PaperContextRef[]>();
export const selectedOtherRefContextCache = new Map<number, OtherContextRef[]>();
export const paperContextModeOverrides = new Map<
  number,
  Map<string, PaperContextSendMode>
>();
// Stores the contextItemId of the currently expanded (sticky) paper chip, or false/undefined if none
export const selectedPaperPreviewExpandedCache = new Map<number, number | false>();
export const activeGlobalConversationByLibrary = new Map<number, number>();
export const activeConversationModeByLibrary = new Map<
  number,
  "paper" | "global"
>();
export const draftInputCache = new Map<number, string>();
export const selectedTextCache = new Map<number, SelectedTextContext[]>();
export const selectedTextPreviewExpandedCache = new Map<number, number>();
export const selectedNotePreviewExpandedCache = new Map<number, boolean>();
export const selectedImagePreviewExpandedCache = new Map<number, boolean>();
export const selectedImagePreviewActiveIndexCache = new Map<number, number>();
export const pinnedSelectedTextKeys = new Map<number, Set<string>>();
export const pinnedImageKeys = new Map<number, Set<string>>();
export const pinnedFileKeys = new Map<number, Set<string>>();
export const pinnedPaperKeys = new Map<number, Set<string>>();
export const recentReaderSelectionCache = new Map<number, string>();

export const activePaperConversationByPaper = new Map<string, number>();

// ── Inline edit state ───────────────────────────────────────────────────────

export type InlineEditTarget = {
  conversationKey: number;
  userTimestamp: number;
  assistantTimestamp: number;
  /** Text currently typed in the inline textarea (preserved across refreshes). */
  currentText: string;
};

export let inlineEditTarget: InlineEditTarget | null = null;
export function setInlineEditTarget(value: InlineEditTarget | null): void {
  inlineEditTarget = value;
}

/** Cleanup callback to restore borrowed DOM elements when the inline edit widget is dismissed. */
export let inlineEditCleanup: (() => void) | null = null;
export function setInlineEditCleanup(fn: (() => void) | null): void {
  inlineEditCleanup = fn;
}

/** The .llm-input-section element borrowed into the chat widget during inline edit. */
export let inlineEditInputSectionEl: HTMLElement | null = null;
/** Original parent of the borrowed input section (for restoring). */
export let inlineEditInputSectionParent: Element | null = null;
/** Original next-sibling of the borrowed input section (for restoring). */
export let inlineEditInputSectionNextSib: Node | null = null;
/** Draft text that was in the inputBox when edit mode was entered. */
export let inlineEditSavedDraft: string = "";

export function setInlineEditInputSection(
  el: HTMLElement | null,
  parent: Element | null,
  nextSib: Node | null,
): void {
  inlineEditInputSectionEl = el;
  inlineEditInputSectionParent = parent;
  inlineEditInputSectionNextSib = nextSib;
}
export function setInlineEditSavedDraft(text: string): void {
  inlineEditSavedDraft = text;
}
