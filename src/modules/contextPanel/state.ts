import type { ModelProfileKey } from "./constants";
import type {
  Message,
  PdfContext,
  ReasoningLevelSelection,
  CustomShortcut,
  ChatAttachment,
  SelectedTextContext,
  PaperContextRef,
} from "./types";

// =============================================================================
// Module State
// =============================================================================

export const chatHistory = new Map<number, Message[]>();
export const loadedConversationKeys = new Set<number>();
export const loadingConversationTasks = new Map<number, Promise<void>>();
export const selectedModelCache = new Map<number, ModelProfileKey>();
export const selectedReasoningCache = new Map<
  number,
  ReasoningLevelSelection
>();

export const pdfTextCache = new Map<number, PdfContext>();
export const pdfTextLoadingTasks = new Map<number, Promise<void>>();
export const shortcutTextCache = new Map<string, string>();
export const shortcutMoveModeState = new WeakMap<Element, boolean>();
export const shortcutRenderItemState = new WeakMap<
  Element,
  Zotero.Item | null | undefined
>();
export const shortcutEscapeListenerAttached = new WeakSet<Document>();
export let readerContextPanelRegistered = false;
export function setReaderContextPanelRegistered(value: boolean) {
  readerContextPanelRegistered = value;
}

export let currentRequestId = 0;
export function nextRequestId(): number {
  return ++currentRequestId;
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
} | null = null;
export function setResponseMenuTarget(value: typeof responseMenuTarget) {
  responseMenuTarget = value;
}

export let promptMenuTarget: {
  item: Zotero.Item;
  conversationKey: number;
  userTimestamp: number;
  assistantTimestamp: number;
} | null = null;
export function setPromptMenuTarget(value: typeof promptMenuTarget) {
  promptMenuTarget = value;
}

// Screenshot selection state (per item)
export const selectedImageCache = new Map<number, string[]>();
export const selectedFileAttachmentCache = new Map<number, ChatAttachment[]>();
export const selectedFilePreviewExpandedCache = new Map<number, boolean>();
export const selectedPaperContextCache = new Map<number, PaperContextRef[]>();
export const selectedPaperPreviewExpandedCache = new Map<number, boolean>();
export const activeGlobalConversationByLibrary = new Map<number, number>();
export const activeConversationModeByLibrary = new Map<number, "paper" | "global">();
export const selectedTextCache = new Map<number, SelectedTextContext[]>();
export const selectedTextPreviewExpandedCache = new Map<number, number>();
export const selectedImagePreviewExpandedCache = new Map<number, boolean>();
export const selectedImagePreviewActiveIndexCache = new Map<number, number>();
export const recentReaderSelectionCache = new Map<number, string>();
