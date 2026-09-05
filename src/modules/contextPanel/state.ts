import type {
  Message,
  PdfContext,
  ReasoningProviderKind,
  ReasoningLevelSelection,
  CustomShortcut,
  ChatAttachment,
  SelectedTextContext,
  PaperContextRef,
  QuoteCitation,
  OtherContextRef,
  CollectionContextRef,
  TagContextRef,
  ChatRuntimeMode,
  PaperContextSendMode,
  PaperContentSourceMode,
  GeneratedChatImage,
} from "./types";
import { TTLMap } from "./contexts/ttlMap";
import { clearMermaidSvgCache } from "./mermaidSvgCache";
import type { ConversationForkLink } from "../../shared/conversationForkLinks";
export {
  areConversationWritesFrozen,
  bumpConversationWriteGeneration,
  freezeConversationWrites,
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
  unfreezeConversationWrites,
} from "../../shared/conversationWriteFence";
import {
  areConversationWritesFrozen,
  bumpConversationWriteGeneration,
  freezeConversationWrites,
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
  unfreezeConversationWrites,
} from "../../shared/conversationWriteFence";
// =============================================================================
// Module State
// =============================================================================

export const chatHistory = new Map<number, Message[]>();
export const conversationForkLinks = new Map<number, ConversationForkLink>();
export const loadedConversationKeys = new Set<number>();
export const loadingConversationTasks = new Map<number, Promise<void>>();
export const webChatIsolatedConversationKeys = new Set<number>();
const webChatForceNewChatConversationKeys = new Set<number>();
export const selectedReasoningCache = new Map<
  number,
  ReasoningLevelSelection
>();
export const selectedReasoningProviderCache = new Map<
  number,
  ReasoningProviderKind
>();
export const selectedRuntimeModeCache = new Map<number, ChatRuntimeMode>();

// 30-minute TTL, sized above multi-paper retrieval caps to avoid evicting
// body text while a folder/tag synthesis pass is still assembling evidence.
export const pdfTextCache = new TTLMap<number, PdfContext>(30 * 60 * 1000, 100);
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
export const activeContextPanelRawItems = new Map<
  Element,
  Zotero.Item | null
>();
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

function normalizeConversationKey(value: unknown): number {
  const key = Math.floor(Number(value || 0));
  return Number.isFinite(key) && key > 0 ? key : 0;
}

export function markWebChatConversationForceNewChat(
  conversationKey: number,
): void {
  const key = normalizeConversationKey(conversationKey);
  if (!key) return;
  webChatForceNewChatConversationKeys.add(key);
}

export function clearWebChatConversationForceNewChat(
  conversationKey: number,
): void {
  const key = normalizeConversationKey(conversationKey);
  if (!key) return;
  webChatForceNewChatConversationKeys.delete(key);
}

export function consumeWebChatConversationForceNewChat(
  conversationKey: number,
): boolean {
  const key = normalizeConversationKey(conversationKey);
  if (!key) return false;
  const shouldForce = webChatForceNewChatConversationKeys.has(key);
  webChatForceNewChatConversationKeys.delete(key);
  return shouldForce;
}

export function resetWebChatConversationSessionState(
  conversationKey: number,
): void {
  const key = normalizeConversationKey(conversationKey);
  if (!key) return;
  webChatForceNewChatConversationKeys.delete(key);
}

export function getPendingRequestId(conversationKey: number): number {
  return pendingRequestIds.get(conversationKey) || 0;
}

export function tryBeginRequest(
  conversationKey: number,
  requestId: number,
  abortController: AbortController | null,
): boolean {
  const key = normalizeConversationKey(conversationKey);
  if (!key || requestId <= 0 || pendingRequestIds.has(key)) return false;
  pendingRequestIds.set(key, requestId);
  if (abortController) abortControllers.set(key, abortController);
  return true;
}

export function isRequestOwner(
  conversationKey: number,
  requestId: number,
): boolean {
  const key = normalizeConversationKey(conversationKey);
  return Boolean(
    key && requestId > 0 && pendingRequestIds.get(key) === requestId,
  );
}

export function finishRequest(
  conversationKey: number,
  requestId: number,
): boolean {
  const key = normalizeConversationKey(conversationKey);
  if (!key || pendingRequestIds.get(key) !== requestId) return false;
  pendingRequestIds.delete(key);
  abortControllers.delete(key);
  return true;
}

export function transferRequest(
  fromConversationKey: number,
  toConversationKey: number,
  requestId: number,
): boolean {
  const fromKey = normalizeConversationKey(fromConversationKey);
  const toKey = normalizeConversationKey(toConversationKey);
  if (!fromKey || !toKey || pendingRequestIds.get(fromKey) !== requestId) {
    return false;
  }
  if (fromKey === toKey) return true;
  if (pendingRequestIds.has(toKey)) return false;
  const abortController = abortControllers.get(fromKey) || null;
  pendingRequestIds.delete(fromKey);
  abortControllers.delete(fromKey);
  pendingRequestIds.set(toKey, requestId);
  if (abortController) abortControllers.set(toKey, abortController);
  return true;
}

export function setPendingRequestId(
  conversationKey: number,
  id: number,
  expectedCurrentId?: number,
): void {
  if (
    id <= 0 &&
    expectedCurrentId !== undefined &&
    (pendingRequestIds.get(conversationKey) || 0) !== expectedCurrentId
  ) {
    return;
  }
  if (id <= 0) {
    pendingRequestIds.delete(conversationKey);
  } else {
    pendingRequestIds.set(conversationKey, id);
  }
}

export function getCancelledRequestId(conversationKey: number): number {
  return cancelledRequestIds.get(conversationKey) ?? -1;
}
export function setCancelledRequestId(
  conversationKey: number,
  value: number,
): void {
  cancelledRequestIds.set(conversationKey, value);
}

export function getAbortController(
  conversationKey: number,
): AbortController | null {
  return abortControllers.get(conversationKey) ?? null;
}
export function setAbortController(
  conversationKey: number,
  value: AbortController | null,
  expectedRequestId?: number,
): void {
  if (
    value === null &&
    expectedRequestId !== undefined &&
    (pendingRequestIds.get(conversationKey) || 0) !== expectedRequestId
  ) {
    return;
  }
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

/**
 * Drop only state owned by one immutable conversation instance.
 *
 * Paper context selections, attachment previews, and model/reasoning
 * preferences are keyed by Zotero item and intentionally remain intact when a
 * conversation for that item is deleted.  The maps below are keyed by the
 * conversation itself, so they can be removed without disturbing a sibling
 * conversation or a newer instance that reuses the numeric key.
 */
export function clearConversationOwnedRuntimeState(
  conversationKey: number,
): void {
  const key = normalizeConversationKey(conversationKey);
  if (!key) return;

  bumpConversationWriteGeneration(key);

  chatHistory.delete(key);
  conversationForkLinks.delete(key);
  loadedConversationKeys.delete(key);
  loadingConversationTasks.delete(key);
  webChatIsolatedConversationKeys.delete(key);
  webChatForceNewChatConversationKeys.delete(key);
  selectedRuntimeModeCache.delete(key);
  draftInputCache.delete(key);
  webChatDraftInputCache.delete(key);
  pendingRequestIds.delete(key);
  abortControllers.delete(key);
  autoLockedGlobalConversationKeys.delete(key);

  for (const [libraryID, activeKey] of activeGlobalConversationByLibrary) {
    if (normalizeConversationKey(activeKey) === key) {
      activeGlobalConversationByLibrary.delete(libraryID);
    }
  }
  for (const [stateKey, activeKey] of activePaperConversationByPaper) {
    if (normalizeConversationKey(activeKey) === key) {
      activePaperConversationByPaper.delete(stateKey);
    }
  }

  if (promptMenuTarget?.conversationKey === key) promptMenuTarget = null;
  if (responseMenuTarget?.conversationKey === key) responseMenuTarget = null;
  if (inlineEditTarget?.conversationKey === key) {
    // The finalizer may run without a mounted panel, so do not invoke the DOM
    // cleanup callback here.  Releasing the references is enough to prevent a
    // stale callback from writing the deleted conversation back into the UI.
    inlineEditCleanup = null;
    inlineEditTarget = null;
    inlineEditInputSectionEl = null;
    inlineEditInputSectionParent = null;
    inlineEditInputSectionNextSib = null;
    inlineEditSavedDraft = "";
  }
}
export let panelFontScalePercent = 120; // FONT_SCALE_DEFAULT_PERCENT — overwritten by initFontScale()
export function setPanelFontScalePercent(value: number) {
  panelFontScalePercent = value;
  // Lazy-import to avoid circular dependency (prefHelpers imports from state).
  import("./prefHelpers")
    .then((m) => m.setFontScalePref(value))
    .catch(() => {});
}
export let messageLineSpacingPercent = 150; // MESSAGE_LINE_SPACING_DEFAULT_PERCENT
export function setMessageLineSpacingPercent(value: number) {
  messageLineSpacingPercent = value;
  import("./prefHelpers")
    .then((m) => m.setMessageLineSpacingPref(value))
    .catch(() => {});
}
export let messageParagraphSpacingPx = 8; // MESSAGE_PARAGRAPH_SPACING_DEFAULT_PX
export function setMessageParagraphSpacingPx(value: number) {
  messageParagraphSpacingPx = value;
  import("./prefHelpers")
    .then((m) => m.setMessageParagraphSpacingPref(value))
    .catch(() => {});
}
export let messageWordSpacingPx = 0; // MESSAGE_WORD_SPACING_DEFAULT_PX
export function setMessageWordSpacingPx(value: number) {
  messageWordSpacingPx = value;
  import("./prefHelpers")
    .then((m) => m.setMessageWordSpacingPref(value))
    .catch(() => {});
}
export let messageFontFamily = "";
export function setMessageFontFamily(value: string) {
  messageFontFamily = value;
  import("./prefHelpers")
    .then((m) => m.setMessageFontFamilyPref(value))
    .catch(() => {});
}
/** Call once at plugin startup to restore the persisted font scale. */
export function initFontScale(): void {
  // Lazy-import to avoid circular dependency.
  import("./prefHelpers")
    .then((m) => {
      panelFontScalePercent = m.getFontScalePref();
      messageLineSpacingPercent = m.getMessageLineSpacingPref();
      messageParagraphSpacingPx = m.getMessageParagraphSpacingPref();
      messageWordSpacingPx = m.getMessageWordSpacingPref();
      messageFontFamily = m.getMessageFontFamilyPref();
    })
    .catch(() => {});
}

export type ResponseActionTarget = {
  item: Zotero.Item;
  contentText: string;
  queryText?: string;
  modelName: string;
  conversationKey?: number;
  userTimestamp?: number;
  assistantTimestamp?: number;
  paperContexts?: PaperContextRef[];
  quoteCitations?: QuoteCitation[];
  generatedImages?: GeneratedChatImage[];
};

export type ResponseActionKind = "copy" | "note" | "fork" | "delete";
export type ResponseActionRunner = (
  action: ResponseActionKind,
  target: ResponseActionTarget | null,
) => Promise<void>;

export let responseMenuTarget: ResponseActionTarget | null = null;
export function setResponseMenuTarget(value: typeof responseMenuTarget) {
  responseMenuTarget = value;
}

const responseActionRunners = new WeakMap<Element, ResponseActionRunner>();
export function setResponseActionRunner(
  body: Element,
  value: ResponseActionRunner | null,
): void {
  if (value) {
    responseActionRunners.set(body, value);
  } else {
    responseActionRunners.delete(body);
  }
}
export function getResponseActionRunner(
  body: Element,
): ResponseActionRunner | null {
  return responseActionRunners.get(body) || null;
}

export type ForkSourceNavigationRunner = (
  link: ConversationForkLink,
) => Promise<void>;

const forkSourceNavigationRunners = new WeakMap<
  Element,
  ForkSourceNavigationRunner
>();
export function setForkSourceNavigationRunner(
  body: Element,
  value: ForkSourceNavigationRunner | null,
): void {
  if (value) {
    forkSourceNavigationRunners.set(body, value);
  } else {
    forkSourceNavigationRunners.delete(body);
  }
}
export function getForkSourceNavigationRunner(
  body: Element,
): ForkSourceNavigationRunner | null {
  return forkSourceNavigationRunners.get(body) || null;
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
export const selectedImageCache = new TTLMap<number, string[]>(
  24 * 60 * 60 * 1000,
  30,
);
export const selectedFileAttachmentCache = new Map<number, ChatAttachment[]>();
export const selectedFilePreviewExpandedCache = new Map<number, boolean>();
export const selectedPaperContextCache = new Map<number, PaperContextRef[]>();
export const selectedOtherRefContextCache = new Map<
  number,
  OtherContextRef[]
>();
export const selectedCollectionContextCache = new Map<
  number,
  CollectionContextRef[]
>();
export const selectedTagContextCache = new Map<number, TagContextRef[]>();
// Conversations whose paper/collection/tag composer state has been initialized.
// Membership is significant even when every corresponding context cache is empty.
export const initializedConversationComposeContextKeys = new Set<number>();
// Flat override maps: key = "ownerItemId:paperItemId:contextItemId"
export const paperContextModeOverrides = new Map<
  string,
  PaperContextSendMode
>();
export const paperContentSourceOverrides = new Map<
  string,
  PaperContentSourceMode
>();
// Stores the contextItemId of the currently expanded (sticky) paper chip, or false/undefined if none
export const selectedPaperPreviewExpandedCache = new Map<
  number,
  number | false
>();
export const selectedPaperContextListExpandedCache = new Map<number, boolean>();
export const activeGlobalConversationByLibrary = new Map<number, number>();
export const activeConversationModeByLibrary = new Map<
  number,
  "paper" | "global"
>();
// Draft text per conversation — capped to prevent unbounded growth (24h TTL, max 100).
export const draftInputCache = new TTLMap<number, string>(
  24 * 60 * 60 * 1000,
  100,
);
// WebChat drafts stay local and isolated from the normal paper-chat composer.
// They use the same bounded lifetime as other unsent drafts.
export const webChatDraftInputCache = new TTLMap<number, string>(
  24 * 60 * 60 * 1000,
  100,
);
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
export const recentReaderSelectionCache = new TTLMap<number, string>(
  5 * 60 * 1000,
  50,
);

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
    const obs = (panelBody as any).__llmResizeObservers as
      | ResizeObserver[]
      | undefined;
    if (obs) {
      for (const o of obs) o.disconnect();
      delete (panelBody as any).__llmResizeObservers;
    }
  }

  chatHistory.clear();
  conversationForkLinks.clear();
  loadedConversationKeys.clear();
  loadingConversationTasks.clear();
  webChatForceNewChatConversationKeys.clear();
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
  initializedConversationComposeContextKeys.clear();
  paperContextModeOverrides.clear();
  paperContentSourceOverrides.clear();
  selectedPaperPreviewExpandedCache.clear();
  selectedPaperContextListExpandedCache.clear();
  activeGlobalConversationByLibrary.clear();
  activeConversationModeByLibrary.clear();
  draftInputCache.clear();
  webChatDraftInputCache.clear();
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
  selectedTagContextCache.clear();
  webChatIsolatedConversationKeys.clear();
  clearMermaidSvgCache();
}
