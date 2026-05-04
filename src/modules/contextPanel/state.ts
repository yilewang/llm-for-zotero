import type {
  Message,
  PdfContext,
  ReasoningProviderKind,
  ReasoningLevelSelection,
  CustomShortcut,
  ChatAttachment,
  SelectedTextContext,
  PaperContextRef,
  OtherContextRef,
  CollectionContextRef,
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
export const selectedReasoningProviderCache = new Map<
  number,
  ReasoningProviderKind
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
// ── Per-conversation request lifecycle state ──────────────────────────────
// Each conversation can independently generate a response. State is keyed by
// conversationKey so concurrent generations don't block each other.

const pendingRequestIds = new Map<number, number>();
const cancelledRequestIds = new Map<number, number>();
const abortControllers = new Map<number, AbortController | null>();

export function getPendingRequestId(conversationKey: number): number {
  return pendingRequestIds.get(conversationKey) || 0;
}
export function setPendingRequestId(conversationKey: number, id: number): void {
  if (id <= 0) {
    pendingRequestIds.delete(conversationKey);
  } else {
    pendingRequestIds.set(conversationKey, id);
  }
}

export function getCancelledRequestId(conversationKey: number): number {
  return cancelledRequestIds.get(conversationKey) ?? -1;
}
export function setCancelledRequestId(conversationKey: number, value: number): void {
  cancelledRequestIds.set(conversationKey, value);
}

export function getAbortController(conversationKey: number): AbortController | null {
  return abortControllers.get(conversationKey) ?? null;
}
export function setAbortController(conversationKey: number, value: AbortController | null): void {
  if (value === null) {
    abortControllers.delete(conversationKey);
  } else {
    abortControllers.set(conversationKey, value);
  }
}

/** Returns true if the given conversation has an in-flight request. */
export function isRequestPending(conversationKey: number): boolean {
  return (pendingRequestIds.get(conversationKey) || 0) > 0;
}

/** Returns true if ANY conversation has an in-flight request. */
export function isAnyRequestPending(): boolean {
  for (const id of pendingRequestIds.values()) {
    if (id > 0) return true;
  }
  return false;
}
export let panelFontScalePercent = 120; // FONT_SCALE_DEFAULT_PERCENT — overwritten by initFontScale()
export function setPanelFontScalePercent(value: number) {
  panelFontScalePercent = value;
  // Lazy-import to avoid circular dependency (prefHelpers imports from state).
  import("./prefHelpers").then((m) => m.setFontScalePref(value)).catch(() => {});
}
/** Call once at plugin startup to restore the persisted font scale. */
export function initFontScale(): void {
  // Lazy-import to avoid circular dependency.
  import("./prefHelpers").then((m) => {
    panelFontScalePercent = m.getFontScalePref();
  }).catch(() => {});
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
export const selectedCollectionContextCache = new Map<number, CollectionContextRef[]>();
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
// Multiple conversations can be auto-locked simultaneously.
const autoLockedGlobalConversationKeys = new Set<number>();
export function addAutoLockedGlobalConversationKey(key: number): void {
  autoLockedGlobalConversationKeys.add(key);
}
export function removeAutoLockedGlobalConversationKey(key: number): void {
  autoLockedGlobalConversationKeys.delete(key);
}
export function isAutoLockedGlobalConversation(key: number): boolean {
  return autoLockedGlobalConversationKeys.has(key);
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
  selectedReasoningProviderCache.clear();
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
  selectedCollectionContextCache.clear();
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
  pendingRequestIds.clear();
  cancelledRequestIds.clear();
  abortControllers.clear();
  autoLockedGlobalConversationKeys.clear();
}
