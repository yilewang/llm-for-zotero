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
  PaperContentSourceMode,
} from "./types";
import { TTLMap } from "./contexts/ttlMap";
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

// 30-minute TTL, max 20 entries — PDF text can be re-extracted on demand.
export const pdfTextCache = new TTLMap<number, PdfContext>(30 * 60 * 1000, 20);
export const pdfTextLoadingTasks = new Map<number, Promise<void>>();
export const shortcutTextCache = new Map<string, string>();
export const shortcutMoveModeState = new WeakMap<Element, boolean>();
export const shortcutRenderItemState = new WeakMap<
  Element,
  Zotero.Item | null | undefined
>();
export const activeContextPanels = new Map<Element, () => Zotero.Item | null>();
/** Raw Zotero item (from onRender) per body — used to recover the original
 *  paper item when clearing a global lock. */
export const activeContextPanelRawItems = new Map<Element, Zotero.Item | null>();
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
  paperContexts?: PaperContextRef[];
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

// Screenshot selection state (per item) — capped to prevent memory growth
// from accumulated base64 image data (24-hour TTL, max 30 items).
export const selectedImageCache = new TTLMap<number, string[]>(24 * 60 * 60 * 1000, 30);
export const selectedFileAttachmentCache = new Map<number, ChatAttachment[]>();
export const selectedFilePreviewExpandedCache = new Map<number, boolean>();
export const selectedPaperContextCache = new Map<number, PaperContextRef[]>();
export const selectedOtherRefContextCache = new Map<number, OtherContextRef[]>();
// Flat override maps: key = "ownerItemId:paperItemId:contextItemId"
export const paperContextModeOverrides = new Map<string, PaperContextSendMode>();
export const paperContentSourceOverrides = new Map<string, PaperContentSourceMode>();
// Stores the contextItemId of the currently expanded (sticky) paper chip, or false/undefined if none
export const selectedPaperPreviewExpandedCache = new Map<number, number | false>();
export const activeGlobalConversationByLibrary = new Map<number, number>();
export const activeConversationModeByLibrary = new Map<
  number,
  "paper" | "global"
>();
// Draft text per conversation — capped to prevent unbounded growth (24h TTL, max 100).
export const draftInputCache = new TTLMap<number, string>(24 * 60 * 60 * 1000, 100);
export const selectedTextCache = new Map<number, SelectedTextContext[]>();
export const selectedTextPreviewExpandedCache = new Map<number, number>();
export const selectedNotePreviewExpandedCache = new Map<number, boolean>();
export const selectedImagePreviewExpandedCache = new Map<number, boolean>();
export const selectedImagePreviewActiveIndexCache = new Map<number, number>();
export const pinnedSelectedTextKeys = new Map<number, Set<string>>();
export const pinnedImageKeys = new Map<number, Set<string>>();
export const pinnedFileKeys = new Map<number, Set<string>>();
export const pinnedPaperKeys = new Map<number, Set<string>>();
// Recent reader text selections — capped (5-min TTL, max 50).
export const recentReaderSelectionCache = new TTLMap<number, string>(5 * 60 * 1000, 50);

export const activePaperConversationByPaper = new Map<string, number>();

// ── Auto-lock state (open chat locks during generation) ─────────────────────
export let autoLockedGlobalConversationKey: number | null = null;
export function setAutoLockedGlobalConversationKey(value: number | null): void {
  autoLockedGlobalConversationKey = value;
}

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

/**
 * Release all module-level state.  Called on plugin shutdown to prevent
 * memory leaks across hot-reloads.
 */
export function clearAllState(): void {
  // Disconnect any ResizeObservers stored on panel bodies before clearing.
  for (const [panelBody] of activeContextPanels) {
    const obs = (panelBody as any).__llmResizeObservers as ResizeObserver[] | undefined;
    if (obs) {
      for (const o of obs) o.disconnect();
      delete (panelBody as any).__llmResizeObservers;
    }
  }

  chatHistory.clear();
  loadedConversationKeys.clear();
  loadingConversationTasks.clear();
  selectedModelCache.clear();
  selectedReasoningCache.clear();
  selectedRuntimeModeCache.clear();
  pdfTextCache.clear();
  pdfTextLoadingTasks.clear();
  shortcutTextCache.clear();
  activeContextPanels.clear();
  activeContextPanelRawItems.clear();
  activeContextPanelStateSync.clear();
  selectedImageCache.clear();
  selectedFileAttachmentCache.clear();
  selectedFilePreviewExpandedCache.clear();
  selectedPaperContextCache.clear();
  selectedOtherRefContextCache.clear();
  paperContextModeOverrides.clear();
  paperContentSourceOverrides.clear();
  selectedPaperPreviewExpandedCache.clear();
  activeGlobalConversationByLibrary.clear();
  activeConversationModeByLibrary.clear();
  draftInputCache.clear();
  selectedTextCache.clear();
  selectedTextPreviewExpandedCache.clear();
  selectedNotePreviewExpandedCache.clear();
  selectedImagePreviewExpandedCache.clear();
  selectedImagePreviewActiveIndexCache.clear();
  pinnedSelectedTextKeys.clear();
  pinnedImageKeys.clear();
  pinnedFileKeys.clear();
  pinnedPaperKeys.clear();
  recentReaderSelectionCache.clear();
  activePaperConversationByPaper.clear();
}
