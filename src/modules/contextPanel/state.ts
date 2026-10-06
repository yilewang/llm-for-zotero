import type {
  Message,
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
import {
  endInlineEditsForTurnStartedElsewhere,
  releaseInlineEditsForConversation,
} from "./inlineEditState";
import { paperTextStore } from "../../services/paperContent/paperTextStore";
import { TTLMap } from "../../utils/ttlMap";
import { clearMermaidSvgCache } from "./mermaidSvgCache";
import { clearAllTaskProgress, clearTaskProgress } from "./taskProgress/store";
import type { ConversationForkLink } from "../../shared/conversationForkLinks";
import type { WebSourceAnchor } from "../../webAccess/types";
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
/**
 * Paper WebChat session rows (webchat_session = 1) a panel has switched to.
 * webChatIsolatedConversationKeys also holds ordinary chats a panel emptied
 * for WebChat in place, so it cannot tell a paper's WebChat session apart.
 */
export const webChatSessionConversationKeys = new Set<number>();
const webChatForceNewChatConversationKeys = new Set<number>();
/**
 * Per-surface reasoning choice for a conversation, keyed by
 * reasoningCacheKey(): the window and a sidebar panel can show the same
 * conversation (the same item id) and each keeps its own level.
 */
export const selectedReasoningCache = new Map<
  string,
  ReasoningLevelSelection
>();
export const selectedReasoningProviderCache = new Map<
  string,
  ReasoningProviderKind
>();

// The same two values as conversationSelection's SelectionSurface, spelled out
// here because that module imports this one.
type ReasoningSurface = "embedded" | "standalone";

export function reasoningCacheKey(
  surface: ReasoningSurface | undefined,
  itemId: number,
): string {
  return `${surface || "embedded"}:${itemId}`;
}

/** Forget one surface's reasoning choices; the other surface keeps its own. */
export function clearSelectedReasoningForSurface(
  surface: ReasoningSurface | undefined,
): void {
  const prefix = `${surface || "embedded"}:`;
  for (const cache of [
    selectedReasoningCache,
    selectedReasoningProviderCache,
  ]) {
    for (const key of Array.from(cache.keys())) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
  }
}
export const selectedRuntimeModeCache = new Map<number, ChatRuntimeMode>();

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

/** Release all strong registrations owned by a retired panel, never its conversation. */
export function unregisterContextPanel(body: Element): void {
  activeContextPanels.delete(body);
  activeContextPanelRawItems.delete(body);
  activeContextPanelStateSync.delete(body);
}
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
const requestActivityListeners = new Set<(conversationKey: number) => void>();

export function subscribeRequestActivity(
  listener: (conversationKey: number) => void,
): () => void {
  requestActivityListeners.add(listener);
  return () => requestActivityListeners.delete(listener);
}

function notifyRequestActivityChanged(
  conversationKey: number,
  wasPending: boolean,
): void {
  if (wasPending === isRequestPending(conversationKey)) return;
  for (const listener of requestActivityListeners) listener(conversationKey);
}

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

/**
 * Claims the conversation for a request. A turn starting here ends every
 * other panel's open message edit of the conversation (see
 * inlineEditState.ts); startingBody is the panel that starts it, if any.
 */
export function tryBeginRequest(
  conversationKey: number,
  requestId: number,
  abortController: AbortController | null,
  startingBody?: Element | null,
): boolean {
  const key = normalizeConversationKey(conversationKey);
  if (!key || requestId <= 0 || pendingRequestIds.has(key)) return false;
  pendingRequestIds.set(key, requestId);
  if (abortController) abortControllers.set(key, abortController);
  endInlineEditsForTurnStartedElsewhere(key, startingBody);
  notifyRequestActivityChanged(key, false);
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

/**
 * The request's own cancel token: it still owns its conversation, the user has
 * not cancelled it, and its abort signal has not fired. Which conversation a
 * panel currently shows is deliberately not part of this — switching away
 * only changes where content renders, never whether the request continues.
 */
export function isRequestActive(
  conversationKey: number,
  requestId: number,
): boolean {
  return (
    isRequestOwner(conversationKey, requestId) &&
    getCancelledRequestId(conversationKey) < requestId &&
    !getAbortController(conversationKey)?.signal.aborted
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
  notifyRequestActivityChanged(key, true);
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
  // The request's turn now runs in the target conversation. Its own panel's
  // edit, if any, ended before the request moved.
  endInlineEditsForTurnStartedElsewhere(toKey);
  notifyRequestActivityChanged(fromKey, true);
  notifyRequestActivityChanged(toKey, false);
  return true;
}

export function setPendingRequestId(
  conversationKey: number,
  id: number,
  expectedCurrentId?: number,
): void {
  const wasPending = isRequestPending(conversationKey);
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
  notifyRequestActivityChanged(conversationKey, wasPending);
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
  // The Task progress record goes with the conversation; a conversation
  // shown again rebuilds it from what it persisted.
  clearTaskProgress(key);
  conversationForkLinks.delete(key);
  loadedConversationKeys.delete(key);
  loadingConversationTasks.delete(key);
  webChatIsolatedConversationKeys.delete(key);
  webChatSessionConversationKeys.delete(key);
  webChatForceNewChatConversationKeys.delete(key);
  selectedRuntimeModeCache.delete(key);
  draftInputCache.delete(key);
  webChatDraftInputCache.delete(key);
  setPendingRequestId(key, 0);
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
  for (const [stateKey, activeKey] of standaloneGlobalConversationByLibrary) {
    if (normalizeConversationKey(activeKey) === key) {
      standaloneGlobalConversationByLibrary.delete(stateKey);
    }
  }
  for (const [stateKey, activeKey] of standalonePaperConversationByPaper) {
    if (normalizeConversationKey(activeKey) === key) {
      standalonePaperConversationByPaper.delete(stateKey);
    }
  }

  clearMenuTargetsForConversation(key);
  // The finalizer may run without a mounted panel, so the panels' DOM cleanup
  // is not run; releasing the references is enough.
  releaseInlineEditsForConversation(key);
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
  webSourceAnchors?: WebSourceAnchor[];
  agentRunId?: string;
};

export type ResponseActionKind = "copy" | "note" | "fork" | "delete" | "expand";
export type ResponseActionRunner = (
  action: ResponseActionKind,
  target: ResponseActionTarget | null,
) => Promise<void>;

/**
 * The turn each panel's open response / prompt menu acts on, keyed by the
 * panel body: the window's menu can stay open while a right-click in a sidebar
 * panel opens its own, and each menu's buttons must act on their own turn.
 */
export type PromptMenuTarget = {
  item: Zotero.Item;
  conversationKey: number;
  userTimestamp: number;
  assistantTimestamp: number;
  editable?: boolean;
};
const responseMenuTargets = new WeakMap<Element, ResponseActionTarget>();
const promptMenuTargets = new WeakMap<Element, PromptMenuTarget>();
/** Bodies holding a menu target, so a deleted conversation can clear them. */
const bodiesWithMenuTarget = new Set<Element>();

function trackMenuTargetBody(body: Element): void {
  if (responseMenuTargets.has(body) || promptMenuTargets.has(body)) {
    bodiesWithMenuTarget.add(body);
  } else {
    bodiesWithMenuTarget.delete(body);
  }
}

export function getResponseMenuTarget(
  body: Element,
): ResponseActionTarget | null {
  return responseMenuTargets.get(body) || null;
}
export function setResponseMenuTarget(
  body: Element,
  value: ResponseActionTarget | null,
): void {
  if (value) responseMenuTargets.set(body, value);
  else responseMenuTargets.delete(body);
  trackMenuTargetBody(body);
}
export function getPromptMenuTarget(body: Element): PromptMenuTarget | null {
  return promptMenuTargets.get(body) || null;
}
export function setPromptMenuTarget(
  body: Element,
  value: PromptMenuTarget | null,
): void {
  if (value) promptMenuTargets.set(body, value);
  else promptMenuTargets.delete(body);
  trackMenuTargetBody(body);
}
/** The panel bodies that hold this menu, from the menu up through its ancestors. */
function bodiesHoldingMenu(menu: Element): Element[] {
  const holders: Element[] = [];
  for (let node: Element | null = menu; node; node = node.parentElement) {
    if (bodiesWithMenuTarget.has(node)) holders.push(node);
  }
  return holders;
}
/** Forget the response-menu target of the panel whose DOM holds this menu. */
export function clearResponseMenuTargetsContaining(menu: Element): void {
  for (const body of bodiesHoldingMenu(menu)) setResponseMenuTarget(body, null);
}
/** Forget the prompt-menu target of the panel whose DOM holds this menu. */
export function clearPromptMenuTargetsContaining(menu: Element): void {
  for (const body of bodiesHoldingMenu(menu)) setPromptMenuTarget(body, null);
}
/** Forget a panel's menu targets (its teardown, or its menu closing). */
export function releaseMenuTargets(body: Element): void {
  responseMenuTargets.delete(body);
  promptMenuTargets.delete(body);
  bodiesWithMenuTarget.delete(body);
}
function clearMenuTargetsForConversation(conversationKey: number): void {
  for (const body of [...bodiesWithMenuTarget]) {
    if (responseMenuTargets.get(body)?.conversationKey === conversationKey) {
      responseMenuTargets.delete(body);
    }
    if (promptMenuTargets.get(body)?.conversationKey === conversationKey) {
      promptMenuTargets.delete(body);
    }
    trackMenuTargetBody(body);
  }
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

// The standalone window's own selection, kept apart from the maps above (which
// every sidebar panel shares) so the two surfaces choose independently. Keys
// are "<system>|<runtime state key>"; nothing here is ever persisted. Read and
// written only through conversationSelection.ts.
export const standaloneConversationModeByLibrary = new Map<
  string,
  "paper" | "global"
>();
export const standaloneGlobalConversationByLibrary = new Map<string, number>();
export const standalonePaperConversationByPaper = new Map<string, number>();

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

// The message edit open in each panel lives per panel body in
// inlineEditState.ts.

/**
 * Release all module-level state.  Called on plugin shutdown to prevent
 * memory leaks across hot-reloads.
 */
export function clearAllState(): void {
  chatHistory.clear();
  clearAllTaskProgress();
  conversationForkLinks.clear();
  loadedConversationKeys.clear();
  loadingConversationTasks.clear();
  webChatForceNewChatConversationKeys.clear();
  selectedReasoningCache.clear();
  selectedReasoningProviderCache.clear();
  selectedRuntimeModeCache.clear();
  paperTextStore.clear();
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
  standaloneConversationModeByLibrary.clear();
  standaloneGlobalConversationByLibrary.clear();
  standalonePaperConversationByPaper.clear();
  const pendingKeys = [...pendingRequestIds.keys()];
  pendingRequestIds.clear();
  for (const key of pendingKeys) notifyRequestActivityChanged(key, true);
  requestActivityListeners.clear();
  cancelledRequestIds.clear();
  abortControllers.clear();
  autoLockedGlobalConversationKeys.clear();
  selectedTagContextCache.clear();
  webChatIsolatedConversationKeys.clear();
  webChatSessionConversationKeys.clear();
  clearMermaidSvgCache();
}
