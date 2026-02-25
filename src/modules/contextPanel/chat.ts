import { renderMarkdown, renderMarkdownForNote } from "../../utils/markdown";
import {
  appendMessage as appendStoredMessage,
  clearConversation as clearStoredConversation,
  loadConversation,
  pruneConversation,
  updateLatestUserMessage as updateStoredLatestUserMessage,
  updateLatestAssistantMessage as updateStoredLatestAssistantMessage,
  StoredChatMessage,
} from "../../utils/chatStore";
import {
  callLLMStream,
  ChatFileAttachment,
  ChatMessage,
  getRuntimeReasoningOptions,
  ReasoningConfig as LLMReasoningConfig,
  ReasoningEvent,
  ReasoningLevel as LLMReasoningLevel,
} from "../../utils/llmClient";
import {
  PERSISTED_HISTORY_LIMIT,
  MAX_HISTORY_MESSAGES,
  AUTO_SCROLL_BOTTOM_THRESHOLD,
  MAX_SELECTED_IMAGES,
  formatFigureCountLabel,
  formatPaperCountLabel,
  ACTIVE_PAPER_MULTI_CONTEXT_MAX_CHUNKS,
  ACTIVE_PAPER_MULTI_CONTEXT_MAX_LENGTH,
} from "./constants";
import type {
  Message,
  ReasoningProviderKind,
  ReasoningOption,
  ReasoningLevelSelection,
  AdvancedModelParams,
  ChatAttachment,
  SelectedTextSource,
  PaperContextRef,
} from "./types";
import {
  chatHistory,
  loadedConversationKeys,
  loadingConversationTasks,
  selectedModelCache,
  selectedReasoningCache,
  cancelledRequestId,
  currentAbortController,
  setCurrentAbortController,
  nextRequestId,
  setResponseMenuTarget,
  setPromptMenuTarget,
  pdfTextCache,
} from "./state";
import {
  sanitizeText,
  formatTime,
  setStatus,
  getSelectedTextWithinBubble,
  getAttachmentTypeLabel,
  buildQuestionWithSelectedTextContexts,
  buildModelPromptWithFileContext,
  getSelectedTextSourceIcon,
  resolvePromptText,
} from "./textUtils";
import {
  normalizeSelectedTextPaperContexts as normalizeSelectedTextPaperContextEntries,
  normalizeSelectedTextSources,
  normalizePaperContextRefs,
  normalizeAttachmentContentHash,
} from "./normalizers";
import { positionMenuAtPointer } from "./menuPositioning";
import {
  getSelectedProfileForItem,
  getAdvancedModelParamsForProfile,
  getStringPref,
  getLastReasoningExpanded,
  getLastUsedReasoningLevel,
  setLastReasoningExpanded,
} from "./prefHelpers";
import { buildContext, ensurePDFTextCached } from "./pdfContext";
import { buildSupplementalPaperContext } from "./paperContext";
import { formatPaperCitationLabel } from "./paperAttribution";
import {
  getActiveContextAttachmentFromTabs,
  resolveContextSourceItem,
} from "./contextResolution";
import { isGlobalPortalItem } from "./portalScope";
import { buildChatHistoryNotePayload } from "./notes";
import { extractManagedBlobHash } from "./attachmentStorage";
import { toFileUrl } from "../../utils/pathFileUrl";
import { replaceOwnerAttachmentRefs } from "../../utils/attachmentRefStore";

/** Get AbortController constructor from global scope */
function getAbortController(): new () => AbortController {
  return (
    (ztoolkit.getGlobal("AbortController") as new () => AbortController) ||
    (
      globalThis as typeof globalThis & {
        AbortController: new () => AbortController;
      }
    ).AbortController
  );
}

function appendReasoningPart(base: string | undefined, next?: string): string {
  const chunk = sanitizeText(next || "");
  if (!chunk) return base || "";
  return `${base || ""}${chunk}`;
}

function isReasoningExpandedByDefault(): boolean {
  return getLastReasoningExpanded();
}

function setHistoryControlsDisabled(body: Element, disabled: boolean): void {
  const historyNewBtn = body.querySelector(
    "#llm-history-new",
  ) as HTMLButtonElement | null;
  if (historyNewBtn) {
    historyNewBtn.disabled = disabled;
    historyNewBtn.setAttribute("aria-disabled", disabled ? "true" : "false");
    if (disabled) {
      historyNewBtn.setAttribute("aria-expanded", "false");
    }
  }
  const historyToggleBtn = body.querySelector(
    "#llm-history-toggle",
  ) as HTMLButtonElement | null;
  if (historyToggleBtn) {
    historyToggleBtn.disabled = disabled;
    historyToggleBtn.setAttribute("aria-disabled", disabled ? "true" : "false");
    if (disabled) {
      historyToggleBtn.setAttribute("aria-expanded", "false");
    }
  }
  if (disabled) {
    const historyNewMenu = body.querySelector(
      "#llm-history-new-menu",
    ) as HTMLDivElement | null;
    if (historyNewMenu) {
      historyNewMenu.style.display = "none";
    }
    const historyMenu = body.querySelector(
      "#llm-history-menu",
    ) as HTMLDivElement | null;
    if (historyMenu) {
      historyMenu.style.display = "none";
    }
  }
}

function resolveMultimodalRetryHint(
  errorMessage: string,
  imageCount: number,
): string {
  if (imageCount <= 0) return "";
  const normalized = errorMessage.trim().toLowerCase();
  if (!normalized) return "";
  const looksLikeSizeOrTokenIssue =
    normalized.includes("413") ||
    normalized.includes("payload too large") ||
    normalized.includes("request too large") ||
    normalized.includes("context length") ||
    normalized.includes("maximum context") ||
    normalized.includes("too many tokens") ||
    normalized.includes("max_input_tokens") ||
    normalized.includes("input too long");
  if (!looksLikeSizeOrTokenIssue) return "";
  if (imageCount >= 8) {
    return " Try fewer screenshots (for example 4-6) or tighter crops.";
  }
  return " Try fewer screenshots or tighter crops.";
}

function openStoredAttachmentFromMessage(attachment: ChatAttachment): boolean {
  const fileUrl = toFileUrl(attachment.storedPath);
  if (!fileUrl) return false;
  try {
    const launch = (Zotero as any).launchURL as
      | ((url: string) => void)
      | undefined;
    if (typeof launch === "function") {
      launch(fileUrl);
      return true;
    }
  } catch (_err) {
    void _err;
  }
  try {
    const win = Zotero.getMainWindow?.() as
      | (Window & { open?: (url?: string, target?: string) => unknown })
      | null;
    if (win?.open) {
      win.open(fileUrl, "_blank");
      return true;
    }
  } catch (_err) {
    void _err;
  }
  return false;
}

function normalizeSelectedTexts(
  selectedTexts: unknown,
  legacySelectedText?: unknown,
): string[] {
  const normalize = (value: unknown): string => {
    if (typeof value !== "string") return "";
    return sanitizeText(value).trim();
  };
  if (Array.isArray(selectedTexts)) {
    return selectedTexts.map((value) => normalize(value)).filter(Boolean);
  }
  const legacy = normalize(legacySelectedText);
  return legacy ? [legacy] : [];
}

function normalizeSelectedTextPaperContextsByIndex(
  selectedTextPaperContexts: unknown,
  count: number,
): (PaperContextRef | undefined)[] {
  return normalizeSelectedTextPaperContextEntries(selectedTextPaperContexts, count, {
    sanitizeText,
  });
}

function normalizePaperContexts(paperContexts: unknown): PaperContextRef[] {
  return normalizePaperContextRefs(paperContexts, { sanitizeText });
}

function collectAttachmentHashesFromStoredMessages(
  messages: StoredChatMessage[],
): string[] {
  const hashes = new Set<string>();
  for (const message of messages) {
    const attachments = Array.isArray(message.attachments)
      ? message.attachments
      : [];
    for (const attachment of attachments) {
      if (!attachment || attachment.category === "image") continue;
      const contentHash =
        normalizeAttachmentContentHash(attachment.contentHash) ||
        extractManagedBlobHash(attachment.storedPath);
      if (!contentHash) continue;
      hashes.add(contentHash);
    }
  }
  return Array.from(hashes);
}

function getMessageSelectedTexts(message: Message): string[] {
  return normalizeSelectedTexts(message.selectedTexts, message.selectedText);
}

function getMessageSelectedTextExpandedIndex(
  message: Message,
  count: number,
): number {
  if (count <= 0) return -1;
  const rawIndex = message.selectedTextExpandedIndex;
  if (typeof rawIndex === "number" && Number.isFinite(rawIndex)) {
    const normalized = Math.floor(rawIndex);
    if (normalized >= 0 && normalized < count) return normalized;
  }
  if (message.selectedTextExpanded === true) return 0;
  return -1;
}

function getUserBubbleElement(wrapper: HTMLElement): HTMLDivElement | null {
  const children = Array.from(wrapper.children) as HTMLElement[];
  for (const child of children) {
    if (
      child.classList.contains("llm-bubble") &&
      child.classList.contains("user")
    ) {
      return child as HTMLDivElement;
    }
  }
  return null;
}

export function syncUserContextAlignmentWidths(body: Element): void {
  const chatBox = body.querySelector("#llm-chat-box") as HTMLDivElement | null;
  if (!chatBox) return;
  const wrappers = Array.from(
    chatBox.querySelectorAll(
      ".llm-message-wrapper.user.llm-user-context-aligned",
    ),
  ) as HTMLDivElement[];
  for (const wrapper of wrappers) {
    const bubble = getUserBubbleElement(wrapper);
    if (!bubble) {
      wrapper.style.removeProperty("--llm-user-bubble-width");
      continue;
    }
    const bubbleWidth = Math.round(bubble.getBoundingClientRect().width);
    if (bubbleWidth > 0) {
      wrapper.style.setProperty("--llm-user-bubble-width", `${bubbleWidth}px`);
    } else {
      wrapper.style.removeProperty("--llm-user-bubble-width");
    }
  }
}

export function getConversationKey(item: Zotero.Item): number {
  if (item.isAttachment() && item.parentID) {
    return item.parentID;
  }
  return item.id;
}

type ChatScrollMode = "followBottom" | "manual";

interface ChatScrollSnapshot {
  mode: ChatScrollMode;
  scrollTop: number;
  updatedAt: number;
}

const chatScrollSnapshots = new Map<number, ChatScrollSnapshot>();
const followBottomStabilizers = new Map<
  number,
  { rafId: number | null; timeoutId: number | null }
>();

/**
 * Guard flag: when `true` the scroll-event handler in setupHandlers must
 * skip snapshot persistence.  This prevents both our own programmatic
 * scrollTop writes AND layout-induced scroll changes (caused by DOM
 * mutations that resize the chat flex container) from corrupting the
 * saved scroll position.
 */
let _scrollUpdatesSuspended = false;
export function isScrollUpdateSuspended(): boolean {
  return _scrollUpdatesSuspended;
}

type ScrollGuardRestoreMode = "absolute" | "relative";

/**
 * Run `fn` (which may mutate the DOM / change layout) while protecting
 * the chatBox scroll position.  The current scroll state is saved before
 * `fn` runs, the scroll-event handler is suppressed during `fn`, and
 * the saved state is restored afterwards.
 *
 * This is the primary tool for preventing layout mutations (button label
 * changes, responsive relayout, etc.) from corrupting scroll position.
 */
export function withScrollGuard(
  chatBox: HTMLDivElement | null,
  conversationKey: number | null,
  fn: () => void,
  restoreMode: ScrollGuardRestoreMode = "absolute",
): void {
  if (!chatBox || conversationKey === null) {
    fn();
    return;
  }
  // Capture current state before mutations.
  const wasNearBottom = isNearBottom(chatBox);
  const savedScrollTop = chatBox.scrollTop;
  const savedMaxScrollTop = getMaxScrollTop(chatBox);

  _scrollUpdatesSuspended = true;
  try {
    fn();
  } finally {
    // Restore: if the user was at the bottom, stick there;
    // otherwise restore either exact pixel offset or relative position.
    if (wasNearBottom) {
      chatBox.scrollTop = chatBox.scrollHeight;
    } else if (restoreMode === "relative" && savedMaxScrollTop > 0) {
      const nextMaxScrollTop = getMaxScrollTop(chatBox);
      const progress = Math.min(
        1,
        Math.max(0, savedScrollTop / savedMaxScrollTop),
      );
      chatBox.scrollTop = Math.round(nextMaxScrollTop * progress);
    } else {
      chatBox.scrollTop = savedScrollTop;
    }
    // Persist only when the viewport is visible; hidden/collapsed layout
    // phases can report transient top positions and would corrupt snapshots.
    if (isChatViewportVisible(chatBox)) {
      persistChatScrollSnapshotByKey(conversationKey, chatBox);
    }
    // Keep the guard up through the microtask so that any synchronous
    // scroll events dispatched by the above writes are also suppressed.
    Promise.resolve().then(() => {
      _scrollUpdatesSuspended = false;
    });
  }
}

function getMaxScrollTop(chatBox: HTMLDivElement): number {
  return Math.max(0, chatBox.scrollHeight - chatBox.clientHeight);
}

function isChatViewportVisible(chatBox: HTMLDivElement): boolean {
  return chatBox.clientHeight > 0 && chatBox.getClientRects().length > 0;
}

function clampScrollTop(chatBox: HTMLDivElement, scrollTop: number): number {
  return Math.max(0, Math.min(getMaxScrollTop(chatBox), scrollTop));
}

function isNearBottom(chatBox: HTMLDivElement): boolean {
  const distanceFromBottom =
    chatBox.scrollHeight - chatBox.clientHeight - chatBox.scrollTop;
  return distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD;
}

function buildChatScrollSnapshot(chatBox: HTMLDivElement): ChatScrollSnapshot {
  const mode: ChatScrollMode = isNearBottom(chatBox)
    ? "followBottom"
    : "manual";
  return {
    mode,
    scrollTop: clampScrollTop(chatBox, chatBox.scrollTop),
    updatedAt: Date.now(),
  };
}

function persistChatScrollSnapshotByKey(
  conversationKey: number,
  chatBox: HTMLDivElement,
): void {
  if (!isChatViewportVisible(chatBox)) return;
  chatScrollSnapshots.set(conversationKey, buildChatScrollSnapshot(chatBox));
}

export function persistChatScrollSnapshot(
  item: Zotero.Item,
  chatBox: HTMLDivElement,
): void {
  persistChatScrollSnapshotByKey(getConversationKey(item), chatBox);
}

function applyChatScrollSnapshot(
  chatBox: HTMLDivElement,
  snapshot: ChatScrollSnapshot,
): void {
  _scrollUpdatesSuspended = true;
  if (snapshot.mode === "followBottom") {
    chatBox.scrollTop = chatBox.scrollHeight;
  } else {
    chatBox.scrollTop = clampScrollTop(chatBox, snapshot.scrollTop);
  }
  // Clear the guard asynchronously so any synchronously-dispatched scroll
  // events from the above write are suppressed, while future user-initiated
  // scroll events are still tracked.
  Promise.resolve().then(() => {
    _scrollUpdatesSuspended = false;
  });
}

function scheduleFollowBottomStabilization(
  body: Element,
  conversationKey: number,
  chatBox: HTMLDivElement,
): void {
  const win = body.ownerDocument?.defaultView;
  if (!win) return;

  const clearFollowBottomStabilization = () => {
    const active = followBottomStabilizers.get(conversationKey);
    if (!active) return;
    if (typeof active.rafId === "number") {
      win.cancelAnimationFrame(active.rafId);
    }
    if (typeof active.timeoutId === "number") {
      win.clearTimeout(active.timeoutId);
    }
    followBottomStabilizers.delete(conversationKey);
  };

  clearFollowBottomStabilization();

  const stickToBottomIfNeeded = () => {
    const snapshot = chatScrollSnapshots.get(conversationKey);
    if (!snapshot || snapshot.mode !== "followBottom") return;
    if (!chatBox.isConnected) return;
    _scrollUpdatesSuspended = true;
    chatBox.scrollTop = chatBox.scrollHeight;
    persistChatScrollSnapshotByKey(conversationKey, chatBox);
    Promise.resolve().then(() => {
      _scrollUpdatesSuspended = false;
    });
  };

  const handle = {
    rafId: null as number | null,
    timeoutId: null as number | null,
  };
  handle.rafId = win.requestAnimationFrame(() => {
    stickToBottomIfNeeded();
    handle.rafId = null;
  });
  handle.timeoutId = win.setTimeout(() => {
    stickToBottomIfNeeded();
    clearFollowBottomStabilization();
  }, 80);
  followBottomStabilizers.set(conversationKey, handle);
}

function applyChatScrollPolicy(
  item: Zotero.Item,
  chatBox: HTMLDivElement,
): void {
  const conversationKey = getConversationKey(item);
  const snapshot =
    chatScrollSnapshots.get(conversationKey) ||
    buildChatScrollSnapshot(chatBox);
  applyChatScrollSnapshot(chatBox, snapshot);
  persistChatScrollSnapshotByKey(conversationKey, chatBox);
}

async function persistConversationMessage(
  conversationKey: number,
  message: StoredChatMessage,
): Promise<void> {
  try {
    await appendStoredMessage(conversationKey, message);
    await pruneConversation(conversationKey, PERSISTED_HISTORY_LIMIT);
    const storedMessages = await loadConversation(
      conversationKey,
      PERSISTED_HISTORY_LIMIT,
    );
    const attachmentHashes =
      collectAttachmentHashesFromStoredMessages(storedMessages);
    await replaceOwnerAttachmentRefs(
      "conversation",
      conversationKey,
      attachmentHashes,
    );
  } catch (err) {
    ztoolkit.log("LLM: Failed to persist chat message", err);
  }
}

function toPanelMessage(message: StoredChatMessage): Message {
  const screenshotImages = Array.isArray(message.screenshotImages)
    ? message.screenshotImages.filter((entry) => Boolean(entry))
    : undefined;
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.filter(
        (entry) =>
          Boolean(entry) &&
          typeof entry === "object" &&
          typeof entry.id === "string" &&
          Boolean(entry.id.trim()) &&
          typeof entry.name === "string" &&
          Boolean(entry.name.trim()),
      )
    : undefined;
  const selectedTexts = normalizeSelectedTexts(
    message.selectedTexts,
    message.selectedText,
  );
  const selectedTextSources = normalizeSelectedTextSources(
    message.selectedTextSources,
    selectedTexts.length,
  );
  const selectedTextPaperContexts = normalizeSelectedTextPaperContextsByIndex(
    message.selectedTextPaperContexts,
    selectedTexts.length,
  );
  const paperContexts = normalizePaperContexts(message.paperContexts);
  return {
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
    selectedText: selectedTexts[0] || message.selectedText,
    selectedTextExpanded: false,
    selectedTexts: selectedTexts.length ? selectedTexts : undefined,
    selectedTextSources: selectedTextSources.length
      ? selectedTextSources
      : undefined,
    selectedTextPaperContexts: selectedTextPaperContexts.some((entry) =>
      Boolean(entry),
    )
      ? selectedTextPaperContexts
      : undefined,
    selectedTextExpandedIndex: -1,
    paperContexts: paperContexts.length ? paperContexts : undefined,
    paperContextsExpanded: false,
    screenshotImages,
    attachments,
    attachmentsExpanded: false,
    screenshotExpanded: false,
    screenshotActiveIndex: screenshotImages?.length ? 0 : undefined,
    modelName: message.modelName,
    reasoningSummary: message.reasoningSummary,
    reasoningDetails: message.reasoningDetails,
    reasoningOpen: isReasoningExpandedByDefault(),
  };
}

export async function ensureConversationLoaded(
  item: Zotero.Item,
): Promise<void> {
  const conversationKey = getConversationKey(item);

  if (loadedConversationKeys.has(conversationKey)) return;
  if (chatHistory.has(conversationKey)) {
    loadedConversationKeys.add(conversationKey);
    return;
  }

  const existingTask = loadingConversationTasks.get(conversationKey);
  if (existingTask) {
    await existingTask;
    return;
  }

  const task = (async () => {
    try {
      const storedMessages = await loadConversation(
        conversationKey,
        PERSISTED_HISTORY_LIMIT,
      );
      chatHistory.set(
        conversationKey,
        storedMessages.map((message) => toPanelMessage(message)),
      );
    } catch (err) {
      ztoolkit.log("LLM: Failed to load chat history", err);
      if (!chatHistory.has(conversationKey)) {
        chatHistory.set(conversationKey, []);
      }
    } finally {
      loadedConversationKeys.add(conversationKey);
      loadingConversationTasks.delete(conversationKey);
    }
  })();

  loadingConversationTasks.set(conversationKey, task);
  await task;
}

export function detectReasoningProvider(
  modelName: string,
): ReasoningProviderKind {
  const name = modelName.trim().toLowerCase();
  if (!name) return "unsupported";
  if (name.startsWith("deepseek")) {
    return "deepseek";
  }
  if (name.startsWith("kimi")) {
    return "kimi";
  }
  if (/(^|[/:])(?:qwen(?:\d+)?|qwq|qvq)(?:\b|[.-])/.test(name)) {
    return "qwen";
  }
  if (/(^|[/:])grok(?:\b|[.-])/.test(name)) {
    return "grok";
  }
  if (/(^|[/:])claude(?:\b|[.-])/.test(name)) {
    return "anthropic";
  }
  if (name.includes("gemini")) return "gemini";
  if (/^(gpt-5|o\d)(\b|[.-])/.test(name)) return "openai";
  return "unsupported";
}

export function getReasoningOptions(
  provider: ReasoningProviderKind,
  modelName: string,
  apiBase?: string,
): ReasoningOption[] {
  if (provider === "unsupported") return [];
  return getRuntimeReasoningOptions(provider, modelName).map((option) => ({
    level: option.level as LLMReasoningLevel,
    enabled: option.enabled,
    label: option.label,
  }));
}

export async function copyTextToClipboard(
  body: Element,
  text: string,
): Promise<void> {
  const safeText = sanitizeText(text).trim();
  if (!safeText) return;

  const win = body.ownerDocument?.defaultView as
    | (Window & { navigator?: Navigator })
    | undefined;
  if (win?.navigator?.clipboard?.writeText) {
    try {
      await win.navigator.clipboard.writeText(safeText);
      return;
    } catch (err) {
      ztoolkit.log("Clipboard API copy failed:", err);
    }
  }

  try {
    const helper = (
      globalThis as typeof globalThis & {
        Components?: {
          classes: Record<string, { getService: (iface: unknown) => unknown }>;
          interfaces: Record<string, unknown>;
        };
      }
    ).Components;
    const svc = helper?.classes?.[
      "@mozilla.org/widget/clipboardhelper;1"
    ]?.getService(helper.interfaces.nsIClipboardHelper) as
      | { copyString: (value: string) => void }
      | undefined;
    if (svc) svc.copyString(safeText);
  } catch (err) {
    ztoolkit.log("Clipboard fallback copy failed:", err);
  }
}

/**
 * Render markdown text through renderMarkdownForNote and copy the result
 * to the clipboard as both text/html and text/plain.  When pasted into a
 * Zotero note, the HTML version is used — producing the same rendering as
 * "Save as note".  When pasted into a plain-text editor, the raw markdown
 * is used — matching "Copy chat as md".
 */
export async function copyRenderedMarkdownToClipboard(
  body: Element,
  markdownText: string,
): Promise<void> {
  const safeText = sanitizeText(markdownText).trim();
  if (!safeText) return;

  let renderedHtml = "";
  try {
    renderedHtml = renderMarkdownForNote(safeText);
  } catch (err) {
    ztoolkit.log("LLM: Copy markdown render error:", err);
  }

  // Try rich clipboard (HTML + plain) first so that paste into Zotero
  // notes gives properly rendered content with math.
  if (renderedHtml) {
    const win = body.ownerDocument?.defaultView as
      | (Window & {
          navigator?: Navigator;
          ClipboardItem?: new (items: Record<string, Blob>) => ClipboardItem;
        })
      | undefined;
    if (win?.navigator?.clipboard?.write && win.ClipboardItem) {
      try {
        const item = new win.ClipboardItem({
          "text/html": new Blob([renderedHtml], { type: "text/html" }),
          "text/plain": new Blob([safeText], { type: "text/plain" }),
        });
        await win.navigator.clipboard.write([item]);
        return;
      } catch (err) {
        ztoolkit.log("LLM: Rich clipboard write failed, falling back:", err);
      }
    }
  }

  // Fallback: copy raw markdown as plain text.
  await copyTextToClipboard(body, safeText);
}

export function getSelectedReasoningForItem(
  itemId: number,
  modelName: string,
  apiBase?: string,
): LLMReasoningConfig | undefined {
  const provider = detectReasoningProvider(modelName);
  if (provider === "unsupported") return undefined;
  const enabledLevels = getReasoningOptions(provider, modelName, apiBase)
    .filter((option) => option.enabled)
    .map((option) => option.level);
  if (!enabledLevels.length) return undefined;

  let selectedLevel =
    selectedReasoningCache.get(itemId) || getLastUsedReasoningLevel() || "none";
  if (
    selectedLevel === "none" ||
    !enabledLevels.includes(selectedLevel as LLMReasoningLevel)
  ) {
    selectedLevel = enabledLevels[0];
    selectedReasoningCache.set(itemId, selectedLevel);
  }

  return { provider, level: selectedLevel as LLMReasoningLevel };
}

type PanelRequestUI = {
  inputBox: HTMLTextAreaElement | null;
  chatBox: HTMLDivElement | null;
  sendBtn: HTMLButtonElement | null;
  cancelBtn: HTMLButtonElement | null;
  status: HTMLElement | null;
};

function getPanelRequestUI(body: Element): PanelRequestUI {
  return {
    inputBox: body.querySelector("#llm-input") as HTMLTextAreaElement | null,
    chatBox: body.querySelector("#llm-chat-box") as HTMLDivElement | null,
    sendBtn: body.querySelector("#llm-send") as HTMLButtonElement | null,
    cancelBtn: body.querySelector("#llm-cancel") as HTMLButtonElement | null,
    status: body.querySelector("#llm-status") as HTMLElement | null,
  };
}

function setRequestUIBusy(
  body: Element,
  ui: PanelRequestUI,
  conversationKey: number,
  statusText: string,
): void {
  withScrollGuard(ui.chatBox, conversationKey, () => {
    if (ui.sendBtn) ui.sendBtn.style.display = "none";
    if (ui.cancelBtn) ui.cancelBtn.style.display = "";
    if (ui.inputBox) ui.inputBox.disabled = true;
    if (ui.status) setStatus(ui.status, statusText, "sending");
  });
  setHistoryControlsDisabled(body, true);
}

function restoreRequestUIIdle(
  ui: PanelRequestUI,
  conversationKey: number,
  requestId: number,
): void {
  if (cancelledRequestId >= requestId) return;
  withScrollGuard(ui.chatBox, conversationKey, () => {
    if (ui.inputBox) {
      ui.inputBox.disabled = false;
      ui.inputBox.focus({ preventScroll: true });
    }
    if (ui.sendBtn) {
      ui.sendBtn.style.display = "";
      ui.sendBtn.disabled = false;
    }
    if (ui.cancelBtn) ui.cancelBtn.style.display = "none";
  });
}

function createPanelUpdateHelpers(
  body: Element,
  item: Zotero.Item,
  conversationKey: number,
  ui: PanelRequestUI,
): {
  refreshChatSafely: () => void;
  setStatusSafely: (
    text: string,
    kind: Parameters<typeof setStatus>[2],
  ) => void;
} {
  const refreshChatSafely = () => {
    withScrollGuard(ui.chatBox, conversationKey, () => {
      refreshChat(body, item);
    });
  };
  const setStatusSafely = (
    text: string,
    kind: Parameters<typeof setStatus>[2],
  ) => {
    if (!ui.status) return;
    withScrollGuard(ui.chatBox, conversationKey, () => {
      setStatus(ui.status as HTMLElement, text, kind);
    });
  };
  return { refreshChatSafely, setStatusSafely };
}

type EffectiveRequestConfig = {
  model: string;
  apiBase: string;
  apiKey: string;
  reasoning: LLMReasoningConfig | undefined;
  advanced: AdvancedModelParams;
};

function resolveEffectiveRequestConfig(params: {
  item: Zotero.Item;
  model?: string;
  apiBase?: string;
  apiKey?: string;
  reasoning?: LLMReasoningConfig;
  advanced?: AdvancedModelParams;
}): EffectiveRequestConfig {
  const fallbackProfile = getSelectedProfileForItem(params.item.id);
  const model = (
    params.model ||
    fallbackProfile.model ||
    getStringPref("modelPrimary") ||
    getStringPref("model") ||
    "gpt-4o-mini"
  ).trim();
  const apiBase = (params.apiBase || fallbackProfile.apiBase).trim();
  const apiKey = (params.apiKey || fallbackProfile.apiKey).trim();
  const reasoning =
    params.reasoning ||
    getSelectedReasoningForItem(params.item.id, model, apiBase);
  const advanced =
    params.advanced || getAdvancedModelParamsForProfile(fallbackProfile.key);
  return { model, apiBase, apiKey, reasoning, advanced };
}

async function buildCombinedContextForRequest(params: {
  item: Zotero.Item;
  question: string;
  imageCount: number;
  paperContexts: PaperContextRef[];
  apiBase: string;
  apiKey: string;
  setStatusSafely: (
    text: string,
    kind: Parameters<typeof setStatus>[2],
  ) => void;
}): Promise<string> {
  const contextSource = resolveContextSourceItem(params.item);
  params.setStatusSafely(contextSource.statusText, "sending");

  const hasSupplementalPaperContexts = params.paperContexts.length > 0;
  let pdfContext = "";
  if (contextSource.contextItem) {
    await ensurePDFTextCached(contextSource.contextItem);
    pdfContext = await buildContext(
      pdfTextCache.get(contextSource.contextItem.id),
      params.question,
      params.imageCount > 0,
      { apiBase: params.apiBase, apiKey: params.apiKey },
      {
        forceRetrieval: hasSupplementalPaperContexts,
        maxChunks: hasSupplementalPaperContexts
          ? ACTIVE_PAPER_MULTI_CONTEXT_MAX_CHUNKS
          : undefined,
        maxLength: hasSupplementalPaperContexts
          ? ACTIVE_PAPER_MULTI_CONTEXT_MAX_LENGTH
          : undefined,
      },
    );
  }

  const supplementalPaperContext = hasSupplementalPaperContexts
    ? await buildSupplementalPaperContext(params.paperContexts, params.question, {
        apiBase: params.apiBase,
        apiKey: params.apiKey,
      })
    : "";
  if (hasSupplementalPaperContexts) {
    params.setStatusSafely(
      `Using ${params.paperContexts.length} supplemental paper context(s)`,
      "sending",
    );
  }
  return [pdfContext, supplementalPaperContext]
    .map((entry) => sanitizeText(entry || "").trim())
    .filter(Boolean)
    .join("\n\n====================\n\n");
}

function createQueuedRefresh(refresh: () => void): () => void {
  let refreshQueued = false;
  return () => {
    if (refreshQueued) return;
    refreshQueued = true;
    setTimeout(() => {
      refreshQueued = false;
      refresh();
    }, 50);
  };
}

export type LatestRetryPair = {
  userIndex: number;
  userMessage: Message;
  assistantMessage: Message;
};

type AssistantMessageSnapshot = Pick<
  Message,
  | "text"
  | "timestamp"
  | "modelName"
  | "reasoningSummary"
  | "reasoningDetails"
  | "reasoningOpen"
>;

export function findLatestRetryPair(
  history: Message[],
): LatestRetryPair | null {
  for (let i = history.length - 1; i >= 1; i--) {
    if (history[i]?.role !== "assistant") continue;
    if (history[i - 1]?.role !== "user") return null;
    return {
      userIndex: i - 1,
      userMessage: history[i - 1],
      assistantMessage: history[i],
    };
  }
  return null;
}

function takeAssistantSnapshot(message: Message): AssistantMessageSnapshot {
  return {
    text: message.text,
    timestamp: message.timestamp,
    modelName: message.modelName,
    reasoningSummary: message.reasoningSummary,
    reasoningDetails: message.reasoningDetails,
    reasoningOpen: message.reasoningOpen,
  };
}

function restoreAssistantSnapshot(
  message: Message,
  snapshot: AssistantMessageSnapshot,
): void {
  message.text = snapshot.text;
  message.timestamp = snapshot.timestamp;
  message.modelName = snapshot.modelName;
  message.reasoningSummary = snapshot.reasoningSummary;
  message.reasoningDetails = snapshot.reasoningDetails;
  message.reasoningOpen = snapshot.reasoningOpen;
  message.streaming = false;
}

function reconstructRetryPayload(userMessage: Message): {
  question: string;
  screenshotImages: string[];
  fileAttachments: ChatFileAttachment[];
  paperContexts: PaperContextRef[];
} {
  const selectedTexts = getMessageSelectedTexts(userMessage);
  const selectedTextSources = normalizeSelectedTextSources(
    userMessage.selectedTextSources,
    selectedTexts.length,
  );
  const selectedTextPaperContexts = normalizeSelectedTextPaperContextsByIndex(
    userMessage.selectedTextPaperContexts,
    selectedTexts.length,
  );
  const primarySelectedText = selectedTexts[0] || "";
  const fileAttachments = (
    Array.isArray(userMessage.attachments)
      ? userMessage.attachments.filter(
          (attachment) =>
            Boolean(attachment) &&
            typeof attachment === "object" &&
            typeof attachment.id === "string" &&
            attachment.id.trim() &&
            typeof attachment.name === "string" &&
            attachment.category !== "image",
        )
      : []
  ) as ChatAttachment[];
  const promptText = resolvePromptText(
    sanitizeText(userMessage.text || ""),
    primarySelectedText,
    fileAttachments.length > 0,
  );
  const composedQuestionBase = primarySelectedText
    ? buildQuestionWithSelectedTextContexts(
        selectedTexts,
        selectedTextSources,
        promptText,
        {
          selectedTextPaperContexts,
          includePaperAttribution: selectedTextPaperContexts.some((entry) =>
            Boolean(entry),
          ),
        },
      )
    : promptText;
  const question = buildModelPromptWithFileContext(
    composedQuestionBase,
    fileAttachments,
  );
  const screenshotImages = Array.isArray(userMessage.screenshotImages)
    ? userMessage.screenshotImages
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, MAX_SELECTED_IMAGES)
    : [];
  const paperContexts = normalizePaperContexts(userMessage.paperContexts);
  const fileAttachmentsForModel: ChatFileAttachment[] = [];
  for (const attachment of fileAttachments) {
    if (
      !attachment.name ||
      typeof attachment.storedPath !== "string" ||
      !attachment.storedPath.trim()
    ) {
      continue;
    }
    fileAttachmentsForModel.push({
      name: attachment.name,
      mimeType: attachment.mimeType,
      storedPath: attachment.storedPath.trim(),
      contentHash: attachment.contentHash,
    });
  }
  return {
    question,
    screenshotImages,
    fileAttachments: fileAttachmentsForModel,
    paperContexts,
  };
}

function buildHistoryMessageForLLM(message: Message): ChatMessage {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: sanitizeText(message.text || ""),
    };
  }
  const { question } = reconstructRetryPayload(message);
  return {
    role: "user",
    content: question.trim() ? question : sanitizeText(message.text || ""),
  };
}

function buildLLMHistoryMessages(history: Message[]): ChatMessage[] {
  return history.map((message) => buildHistoryMessageForLLM(message));
}

function normalizeModelFileAttachments(
  attachments?: ChatAttachment[],
): ChatFileAttachment[] {
  if (!Array.isArray(attachments) || !attachments.length) return [];
  return attachments
    .filter(
      (attachment) =>
        Boolean(attachment) &&
        typeof attachment === "object" &&
        attachment.category !== "image" &&
        typeof attachment.name === "string" &&
        attachment.name.trim() &&
        typeof attachment.storedPath === "string" &&
        attachment.storedPath.trim(),
    )
    .map((attachment) => ({
      name: attachment.name.trim(),
      mimeType:
        typeof attachment.mimeType === "string" && attachment.mimeType.trim()
          ? attachment.mimeType.trim()
          : "application/octet-stream",
      storedPath: attachment.storedPath?.trim(),
      contentHash:
        typeof attachment.contentHash === "string" &&
        /^[a-f0-9]{64}$/i.test(attachment.contentHash.trim())
          ? attachment.contentHash.trim().toLowerCase()
          : undefined,
    }));
}

export type EditLatestTurnMarker = {
  conversationKey: number;
  userTimestamp: number;
  assistantTimestamp: number;
};

export type EditLatestTurnResult =
  | "ok"
  | "missing"
  | "stale"
  | "persist-failed";

function normalizeEditableAttachments(
  attachments?: ChatAttachment[],
): ChatAttachment[] {
  const normalized = (
    Array.isArray(attachments)
      ? attachments.filter(
          (attachment) =>
            Boolean(attachment) &&
            typeof attachment === "object" &&
            typeof attachment.id === "string" &&
            attachment.id.trim() &&
            typeof attachment.name === "string" &&
            attachment.name.trim() &&
            attachment.category !== "image",
        )
      : []
  ) as ChatAttachment[];
  return normalized.map((attachment) => ({
    ...attachment,
    id: attachment.id.trim(),
    name: attachment.name.trim(),
    mimeType:
      typeof attachment.mimeType === "string" && attachment.mimeType.trim()
        ? attachment.mimeType.trim()
        : "application/octet-stream",
    sizeBytes: Number.isFinite(attachment.sizeBytes)
      ? Math.max(0, attachment.sizeBytes)
      : 0,
    textContent:
      typeof attachment.textContent === "string"
        ? attachment.textContent
        : undefined,
    storedPath:
      typeof attachment.storedPath === "string" && attachment.storedPath.trim()
        ? attachment.storedPath.trim()
        : undefined,
    contentHash:
      typeof attachment.contentHash === "string" &&
      /^[a-f0-9]{64}$/i.test(attachment.contentHash.trim())
        ? attachment.contentHash.trim().toLowerCase()
        : undefined,
  }));
}

function normalizeEditablePaperContexts(
  paperContexts?: PaperContextRef[],
): PaperContextRef[] {
  return normalizePaperContexts(paperContexts);
}

export async function editLatestUserMessageAndRetry(
  body: Element,
  item: Zotero.Item,
  displayQuestion: string,
  selectedTexts?: string[],
  selectedTextSources?: SelectedTextSource[],
  selectedTextPaperContexts?: (PaperContextRef | undefined)[],
  screenshotImages?: string[],
  paperContexts?: PaperContextRef[],
  attachments?: ChatAttachment[],
  expected?: EditLatestTurnMarker,
  model?: string,
  apiBase?: string,
  apiKey?: string,
  reasoning?: LLMReasoningConfig,
  advanced?: AdvancedModelParams,
): Promise<EditLatestTurnResult> {
  await ensureConversationLoaded(item);
  const conversationKey = getConversationKey(item);
  const history = chatHistory.get(conversationKey) || [];
  const retryPair = findLatestRetryPair(history);
  if (!retryPair) return "missing";
  if (retryPair.assistantMessage.streaming) return "stale";
  if (
    expected &&
    (expected.conversationKey !== conversationKey ||
      retryPair.userMessage.timestamp !== expected.userTimestamp ||
      retryPair.assistantMessage.timestamp !== expected.assistantTimestamp)
  ) {
    return "stale";
  }

  const selectedTextsForMessage = normalizeSelectedTexts(selectedTexts);
  const selectedTextSourcesForMessage = normalizeSelectedTextSources(
    selectedTextSources,
    selectedTextsForMessage.length,
  );
  const selectedTextPaperContextsForMessage =
    normalizeSelectedTextPaperContextsByIndex(
      selectedTextPaperContexts,
      selectedTextsForMessage.length,
    );
  const selectedTextForMessage = selectedTextsForMessage[0] || "";
  const screenshotImagesForMessage = Array.isArray(screenshotImages)
    ? screenshotImages
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, MAX_SELECTED_IMAGES)
    : [];
  const paperContextsForMessage = normalizeEditablePaperContexts(paperContexts);
  const attachmentsForMessage = normalizeEditableAttachments(attachments);
  const updatedTimestamp = Date.now();
  const nextDisplayQuestion = sanitizeText(displayQuestion || "");

  retryPair.userMessage.text = nextDisplayQuestion;
  retryPair.userMessage.timestamp = updatedTimestamp;
  retryPair.userMessage.selectedText = selectedTextForMessage || undefined;
  retryPair.userMessage.selectedTextExpanded = false;
  retryPair.userMessage.selectedTexts = selectedTextsForMessage.length
    ? selectedTextsForMessage
    : undefined;
  retryPair.userMessage.selectedTextSources =
    selectedTextSourcesForMessage.length
      ? selectedTextSourcesForMessage
      : undefined;
  retryPair.userMessage.selectedTextPaperContexts =
    selectedTextPaperContextsForMessage.some((entry) => Boolean(entry))
      ? selectedTextPaperContextsForMessage
      : undefined;
  retryPair.userMessage.selectedTextExpandedIndex = -1;
  retryPair.userMessage.screenshotImages = screenshotImagesForMessage.length
    ? screenshotImagesForMessage
    : undefined;
  retryPair.userMessage.screenshotExpanded = false;
  retryPair.userMessage.screenshotActiveIndex =
    screenshotImagesForMessage.length ? 0 : undefined;
  retryPair.userMessage.paperContexts = paperContextsForMessage.length
    ? paperContextsForMessage
    : undefined;
  retryPair.userMessage.paperContextsExpanded = false;
  retryPair.userMessage.attachments = attachmentsForMessage.length
    ? attachmentsForMessage
    : undefined;
  retryPair.userMessage.attachmentsExpanded = false;
  retryPair.userMessage.attachmentActiveIndex = undefined;

  try {
    await updateStoredLatestUserMessage(conversationKey, {
      text: retryPair.userMessage.text,
      timestamp: retryPair.userMessage.timestamp,
      selectedText: retryPair.userMessage.selectedText,
      selectedTexts: retryPair.userMessage.selectedTexts,
      selectedTextSources: retryPair.userMessage.selectedTextSources,
      selectedTextPaperContexts: retryPair.userMessage.selectedTextPaperContexts,
      screenshotImages: retryPair.userMessage.screenshotImages,
      paperContexts: retryPair.userMessage.paperContexts,
      attachments: retryPair.userMessage.attachments,
    });

    const storedMessages = await loadConversation(
      conversationKey,
      PERSISTED_HISTORY_LIMIT,
    );
    const attachmentHashes =
      collectAttachmentHashesFromStoredMessages(storedMessages);
    await replaceOwnerAttachmentRefs(
      "conversation",
      conversationKey,
      attachmentHashes,
    );
  } catch (err) {
    ztoolkit.log("LLM: Failed to persist edited latest user message", err);
    return "persist-failed";
  }

  await retryLatestAssistantResponse(
    body,
    item,
    model,
    apiBase,
    apiKey,
    reasoning,
    advanced,
  );
  return "ok";
}

export async function retryLatestAssistantResponse(
  body: Element,
  item: Zotero.Item,
  model?: string,
  apiBase?: string,
  apiKey?: string,
  reasoning?: LLMReasoningConfig,
  advanced?: AdvancedModelParams,
) {
  const ui = getPanelRequestUI(body);

  await ensureConversationLoaded(item);
  const conversationKey = getConversationKey(item);
  const history = chatHistory.get(conversationKey) || [];
  const retryPair = findLatestRetryPair(history);
  if (!retryPair) {
    if (ui.status) setStatus(ui.status, "No retryable response found", "error");
    return;
  }

  const thisRequestId = nextRequestId();
  setRequestUIBusy(body, ui, conversationKey, "Preparing retry...");
  const { refreshChatSafely, setStatusSafely } = createPanelUpdateHelpers(
    body,
    item,
    conversationKey,
    ui,
  );

  const historyForLLM = history
    .slice(0, retryPair.userIndex)
    .slice(-MAX_HISTORY_MESSAGES);
  const { question, screenshotImages, fileAttachments, paperContexts } =
    reconstructRetryPayload(retryPair.userMessage);
  if (!question.trim()) {
    setStatusSafely("Nothing to retry for latest turn", "error");
    restoreRequestUIIdle(ui, conversationKey, thisRequestId);
    setHistoryControlsDisabled(body, false);
    return;
  }

  const effectiveRequestConfig = resolveEffectiveRequestConfig({
    item,
    model,
    apiBase,
    apiKey,
    reasoning,
    advanced,
  });

  const assistantMessage = retryPair.assistantMessage;
  const assistantSnapshot = takeAssistantSnapshot(assistantMessage);
  assistantMessage.streaming = true;
  refreshChatSafely();
  let streamedAnswer = "";
  let streamedReasoningSummary: string | undefined;
  let streamedReasoningDetails: string | undefined;

  const restoreOriginalAssistant = () => {
    restoreAssistantSnapshot(assistantMessage, assistantSnapshot);
    refreshChatSafely();
  };

  try {
    const combinedContext = await buildCombinedContextForRequest({
      item,
      question,
      imageCount: screenshotImages.length,
      paperContexts,
      apiBase: effectiveRequestConfig.apiBase,
      apiKey: effectiveRequestConfig.apiKey,
      setStatusSafely,
    });
    if (cancelledRequestId >= thisRequestId) {
      restoreOriginalAssistant();
      setStatusSafely("Cancelled", "ready");
      return;
    }
    const llmHistory = buildLLMHistoryMessages(historyForLLM);

    const AbortControllerCtor = getAbortController();
    setCurrentAbortController(
      AbortControllerCtor ? new AbortControllerCtor() : null,
    );
    if (cancelledRequestId >= thisRequestId) {
      currentAbortController?.abort();
      restoreOriginalAssistant();
      setStatusSafely("Cancelled", "ready");
      return;
    }

    const answer = await callLLMStream(
      {
        prompt: question,
        context: combinedContext,
        history: llmHistory,
        signal: currentAbortController?.signal,
        images: screenshotImages,
        attachments: fileAttachments,
        model: effectiveRequestConfig.model,
        apiBase: effectiveRequestConfig.apiBase,
        apiKey: effectiveRequestConfig.apiKey,
        reasoning: effectiveRequestConfig.reasoning,
        temperature: effectiveRequestConfig.advanced?.temperature,
        maxTokens: effectiveRequestConfig.advanced?.maxTokens,
      },
      (delta) => {
        streamedAnswer += sanitizeText(delta);
      },
      (reasoningEvent: ReasoningEvent) => {
        if (reasoningEvent.summary) {
          streamedReasoningSummary = appendReasoningPart(
            streamedReasoningSummary,
            reasoningEvent.summary,
          );
        }
        if (reasoningEvent.details) {
          streamedReasoningDetails = appendReasoningPart(
            streamedReasoningDetails,
            reasoningEvent.details,
          );
        }
      },
    );

    if (
      cancelledRequestId >= thisRequestId ||
      Boolean(currentAbortController?.signal.aborted)
    ) {
      restoreOriginalAssistant();
      setStatusSafely("Cancelled", "ready");
      return;
    }

    assistantMessage.text =
      sanitizeText(answer) || streamedAnswer || "No response.";
    assistantMessage.timestamp = Date.now();
    assistantMessage.modelName = effectiveRequestConfig.model;
    assistantMessage.reasoningSummary = streamedReasoningSummary;
    assistantMessage.reasoningDetails = streamedReasoningDetails;
    assistantMessage.reasoningOpen = isReasoningExpandedByDefault();
    assistantMessage.streaming = false;
    refreshChatSafely();

    await updateStoredLatestAssistantMessage(conversationKey, {
      text: assistantMessage.text,
      timestamp: assistantMessage.timestamp,
      modelName: assistantMessage.modelName,
      reasoningSummary: assistantMessage.reasoningSummary,
      reasoningDetails: assistantMessage.reasoningDetails,
    });

    setStatusSafely("Ready", "ready");
  } catch (err) {
    const isCancelled =
      cancelledRequestId >= thisRequestId ||
      Boolean(currentAbortController?.signal.aborted) ||
      (err as { name?: string }).name === "AbortError";
    if (isCancelled) {
      restoreOriginalAssistant();
      setStatusSafely("Cancelled", "ready");
      return;
    }

    restoreOriginalAssistant();
    const errMsg = (err as Error).message || "Error";
    const retryHint = resolveMultimodalRetryHint(
      errMsg,
      screenshotImages.length,
    );
    setStatusSafely(
      `Retry failed: ${`${errMsg}${retryHint}`.slice(0, 48)}`,
      "error",
    );
  } finally {
    setHistoryControlsDisabled(body, false);
    restoreRequestUIIdle(ui, conversationKey, thisRequestId);
    setCurrentAbortController(null);
  }
}

export async function sendQuestion(
  body: Element,
  item: Zotero.Item,
  question: string,
  images?: string[],
  model?: string,
  apiBase?: string,
  apiKey?: string,
  reasoning?: LLMReasoningConfig,
  advanced?: AdvancedModelParams,
  displayQuestion?: string,
  selectedTexts?: string[],
  selectedTextSources?: SelectedTextSource[],
  selectedTextPaperContexts?: (PaperContextRef | undefined)[],
  paperContexts?: PaperContextRef[],
  attachments?: ChatAttachment[],
) {
  const ui = getPanelRequestUI(body);

  // Track this request
  const thisRequestId = nextRequestId();
  const initialConversationKey = getConversationKey(item);

  // Show cancel, hide send
  setRequestUIBusy(body, ui, initialConversationKey, "Preparing request...");

  await ensureConversationLoaded(item);
  const conversationKey = getConversationKey(item);
  const { refreshChatSafely, setStatusSafely } = createPanelUpdateHelpers(
    body,
    item,
    conversationKey,
    ui,
  );

  // Add user message with attached selected text / screenshots metadata
  if (!chatHistory.has(conversationKey)) {
    chatHistory.set(conversationKey, []);
  }
  const history = chatHistory.get(conversationKey)!;
  const historyForLLM = history.slice(-MAX_HISTORY_MESSAGES);
  const requestFileAttachments = normalizeModelFileAttachments(attachments);
  const effectiveRequestConfig = resolveEffectiveRequestConfig({
    item,
    model,
    apiBase,
    apiKey,
    reasoning,
    advanced,
  });
  const shownQuestion = displayQuestion || question;
  const selectedTextsForMessage = normalizeSelectedTexts(selectedTexts);
  const selectedTextSourcesForMessage = normalizeSelectedTextSources(
    selectedTextSources,
    selectedTextsForMessage.length,
  );
  const selectedTextPaperContextsForMessage =
    normalizeSelectedTextPaperContextsByIndex(
      selectedTextPaperContexts,
      selectedTextsForMessage.length,
    );
  const selectedTextForMessage = selectedTextsForMessage[0] || "";
  const paperContextsForMessage = normalizePaperContexts(paperContexts);
  const screenshotImagesForMessage = Array.isArray(images)
    ? images
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, MAX_SELECTED_IMAGES)
    : [];
  const imageCount = screenshotImagesForMessage.length;
  const userMessageText = shownQuestion;
  const userMessage: Message = {
    role: "user",
    text: userMessageText,
    timestamp: Date.now(),
    selectedText: selectedTextForMessage || undefined,
    selectedTextExpanded: false,
    selectedTexts: selectedTextsForMessage.length
      ? selectedTextsForMessage
      : undefined,
    selectedTextSources: selectedTextSourcesForMessage.length
      ? selectedTextSourcesForMessage
      : undefined,
    selectedTextPaperContexts: selectedTextPaperContextsForMessage.some((entry) =>
      Boolean(entry),
    )
      ? selectedTextPaperContextsForMessage
      : undefined,
    selectedTextExpandedIndex: -1,
    paperContexts: paperContextsForMessage.length
      ? paperContextsForMessage
      : undefined,
    paperContextsExpanded: false,
    screenshotImages: screenshotImagesForMessage.length
      ? screenshotImagesForMessage
      : undefined,
    screenshotExpanded: false,
    screenshotActiveIndex: 0,
    attachments: attachments?.length ? attachments : undefined,
  };
  history.push(userMessage);
  await persistConversationMessage(conversationKey, {
    role: "user",
    text: userMessage.text,
    timestamp: userMessage.timestamp,
    selectedText: userMessage.selectedText,
    selectedTexts: userMessage.selectedTexts,
    selectedTextSources: userMessage.selectedTextSources,
    selectedTextPaperContexts: userMessage.selectedTextPaperContexts,
    paperContexts: userMessage.paperContexts,
    screenshotImages: userMessage.screenshotImages,
    attachments: userMessage.attachments,
  });

  const assistantMessage: Message = {
    role: "assistant",
    text: "",
    timestamp: Date.now(),
    modelName: effectiveRequestConfig.model,
    streaming: true,
    reasoningOpen: isReasoningExpandedByDefault(),
  };
  history.push(assistantMessage);
  if (history.length > PERSISTED_HISTORY_LIMIT) {
    history.splice(0, history.length - PERSISTED_HISTORY_LIMIT);
  }
  refreshChatSafely();

  let assistantPersisted = false;
  const persistAssistantOnce = async () => {
    if (assistantPersisted) return;
    assistantPersisted = true;
    await persistConversationMessage(conversationKey, {
      role: "assistant",
      text: assistantMessage.text,
      timestamp: assistantMessage.timestamp,
      modelName: assistantMessage.modelName,
      reasoningSummary: assistantMessage.reasoningSummary,
      reasoningDetails: assistantMessage.reasoningDetails,
    });
  };
  const markCancelled = async () => {
    assistantMessage.text = "[Cancelled]";
    assistantMessage.streaming = false;
    assistantMessage.reasoningSummary = undefined;
    assistantMessage.reasoningDetails = undefined;
    assistantMessage.reasoningOpen = false;
    refreshChatSafely();
    await persistAssistantOnce();
    setStatusSafely("Cancelled", "ready");
  };

  try {
    const combinedContext = await buildCombinedContextForRequest({
      item,
      question,
      imageCount,
      paperContexts: paperContextsForMessage,
      apiBase: effectiveRequestConfig.apiBase,
      apiKey: effectiveRequestConfig.apiKey,
      setStatusSafely,
    });

    const llmHistory = buildLLMHistoryMessages(historyForLLM);

    const AbortControllerCtor = getAbortController();
    setCurrentAbortController(
      AbortControllerCtor ? new AbortControllerCtor() : null,
    );
    const queueRefresh = createQueuedRefresh(refreshChatSafely);

    const answer = await callLLMStream(
      {
        prompt: question,
        context: combinedContext,
        history: llmHistory,
        signal: currentAbortController?.signal,
        images: images,
        attachments: requestFileAttachments,
        model: effectiveRequestConfig.model,
        apiBase: effectiveRequestConfig.apiBase,
        apiKey: effectiveRequestConfig.apiKey,
        reasoning: effectiveRequestConfig.reasoning,
        temperature: effectiveRequestConfig.advanced?.temperature,
        maxTokens: effectiveRequestConfig.advanced?.maxTokens,
      },
      (delta) => {
        assistantMessage.text += sanitizeText(delta);
        queueRefresh();
      },
      (reasoning: ReasoningEvent) => {
        if (reasoning.summary) {
          assistantMessage.reasoningSummary = appendReasoningPart(
            assistantMessage.reasoningSummary,
            reasoning.summary,
          );
        }
        if (reasoning.details) {
          assistantMessage.reasoningDetails = appendReasoningPart(
            assistantMessage.reasoningDetails,
            reasoning.details,
          );
        }
        queueRefresh();
      },
    );

    if (
      cancelledRequestId >= thisRequestId ||
      Boolean(currentAbortController?.signal.aborted)
    ) {
      await markCancelled();
      return;
    }

    assistantMessage.text =
      sanitizeText(answer) || assistantMessage.text || "No response.";
    assistantMessage.streaming = false;
    refreshChatSafely();
    await persistAssistantOnce();

    setStatusSafely("Ready", "ready");
  } catch (err) {
    const isCancelled =
      cancelledRequestId >= thisRequestId ||
      Boolean(currentAbortController?.signal.aborted) ||
      (err as { name?: string }).name === "AbortError";
    if (isCancelled) {
      await markCancelled();
      return;
    }

    const errMsg = (err as Error).message || "Error";
    const retryHint = resolveMultimodalRetryHint(errMsg, imageCount);
    assistantMessage.text = `Error: ${errMsg}${retryHint}`;
    assistantMessage.streaming = false;
    refreshChatSafely();
    await persistAssistantOnce();

    setStatusSafely(`Error: ${`${errMsg}${retryHint}`.slice(0, 40)}`, "error");
  } finally {
    setHistoryControlsDisabled(body, false);
    restoreRequestUIIdle(ui, conversationKey, thisRequestId);
    setCurrentAbortController(null);
  }
}

export function refreshChat(body: Element, item?: Zotero.Item | null) {
  const chatBox = body.querySelector("#llm-chat-box") as HTMLDivElement | null;
  if (!chatBox) return;
  const doc = body.ownerDocument!;
  setPromptMenuTarget(null);

  if (!item) {
    chatBox.innerHTML = `
      <div class="llm-welcome">
        <div class="llm-welcome-icon">📄</div>
        <div class="llm-welcome-text">Select an item or open a PDF to start.</div>
      </div>
    `;
    return;
  }

  const conversationKey = getConversationKey(item);
  const panelRoot = body.querySelector("#llm-main") as HTMLDivElement | null;
  const isGlobalConversation =
    isGlobalPortalItem(item) ||
    panelRoot?.dataset.conversationKind === "global";
  const mutateChatWithScrollGuard = (fn: () => void) => {
    withScrollGuard(chatBox, conversationKey, fn);
  };
  const hasExistingRenderedContent = chatBox.childElementCount > 0;
  const cachedSnapshot = chatScrollSnapshots.get(conversationKey);
  const baselineSnapshot =
    !hasExistingRenderedContent && cachedSnapshot
      ? cachedSnapshot
      : buildChatScrollSnapshot(chatBox);
  const history = chatHistory.get(conversationKey) || [];

  if (history.length === 0) {
    chatBox.innerHTML = `
      <div class="llm-welcome">
        <div class="llm-welcome-icon">💬</div>
        <div class="llm-welcome-text">Start a conversation by asking a question or using one of the quick actions below.</div>
      </div>
    `;
    return;
  }

  chatBox.innerHTML = "";

  const latestRetryPair = findLatestRetryPair(history);
  const latestAssistantIndex = latestRetryPair
    ? latestRetryPair.userIndex + 1
    : -1;
  const latestEditableUserIndex = latestRetryPair?.userIndex ?? -1;
  const latestEditableUserTimestamp = latestRetryPair?.userMessage.timestamp;
  const latestEditableAssistantTimestamp =
    latestRetryPair?.assistantMessage.timestamp;
  const latestEditableIsIdle = Boolean(
    latestRetryPair && !latestRetryPair.assistantMessage.streaming,
  );

  for (const [index, msg] of history.entries()) {
    const isUser = msg.role === "user";
    const canEditLatestUserPrompt = Boolean(
      isUser &&
      item &&
      latestEditableIsIdle &&
      index === latestEditableUserIndex &&
      Number.isFinite(latestEditableUserTimestamp) &&
      Number.isFinite(latestEditableAssistantTimestamp),
    );
    let hasUserContext = false;
    const wrapper = doc.createElement("div") as HTMLDivElement;
    wrapper.className = `llm-message-wrapper ${isUser ? "user" : "assistant"}`;

    const bubble = doc.createElement("div") as HTMLDivElement;
    bubble.className = `llm-bubble ${isUser ? "user" : "assistant"}`;

    if (isUser) {
      const contextBadgesRow = doc.createElement("div") as HTMLDivElement;
      contextBadgesRow.className = "llm-user-context-badges";
      let hasContextBadge = false;

      const screenshotImages = Array.isArray(msg.screenshotImages)
        ? msg.screenshotImages.filter((entry) => Boolean(entry))
        : [];
      let screenshotExpanded: HTMLDivElement | null = null;
      let papersExpanded: HTMLDivElement | null = null;
      let filesExpanded: HTMLDivElement | null = null;
      const selectedTexts = getMessageSelectedTexts(msg);
      const selectedTextSources = normalizeSelectedTextSources(
        msg.selectedTextSources,
        selectedTexts.length,
      );
      const selectedTextPaperContexts = normalizeSelectedTextPaperContextsByIndex(
        msg.selectedTextPaperContexts,
        selectedTexts.length,
      );
      const hasScreenshotContext = screenshotImages.length > 0;
      const hasSelectedTextContext = selectedTexts.length > 0;
      hasUserContext = hasScreenshotContext || hasSelectedTextContext;
      if (hasScreenshotContext) {
        const screenshotBar = doc.createElement("button") as HTMLButtonElement;
        screenshotBar.type = "button";
        screenshotBar.className = "llm-user-screenshots-bar";

        const screenshotIcon = doc.createElement("span") as HTMLSpanElement;
        screenshotIcon.className = "llm-user-screenshots-icon";
        screenshotIcon.textContent = "🖼";

        const screenshotLabel = doc.createElement("span") as HTMLSpanElement;
        screenshotLabel.className = "llm-user-screenshots-label";
        screenshotLabel.textContent = formatFigureCountLabel(
          screenshotImages.length,
        );

        screenshotBar.append(screenshotIcon, screenshotLabel);

        const screenshotExpandedEl = doc.createElement("div") as HTMLDivElement;
        screenshotExpandedEl.className = "llm-user-screenshots-expanded";
        screenshotExpanded = screenshotExpandedEl;

        const thumbStrip = doc.createElement("div") as HTMLDivElement;
        thumbStrip.className = "llm-user-screenshots-thumbs";

        const previewWrap = doc.createElement("div") as HTMLDivElement;
        previewWrap.className = "llm-user-screenshots-preview";
        const previewImg = doc.createElement("img") as HTMLImageElement;
        previewImg.className = "llm-user-screenshots-preview-img";
        previewImg.alt = "Screenshot preview";
        previewWrap.appendChild(previewImg);

        const thumbButtons: HTMLButtonElement[] = [];
        screenshotImages.forEach((imageUrl, index) => {
          const thumbBtn = doc.createElement("button") as HTMLButtonElement;
          thumbBtn.type = "button";
          thumbBtn.className = "llm-user-screenshot-thumb";
          thumbBtn.title = `Screenshot ${index + 1}`;

          const thumbImg = doc.createElement("img") as HTMLImageElement;
          thumbImg.className = "llm-user-screenshot-thumb-img";
          thumbImg.src = imageUrl;
          thumbImg.alt = `Screenshot ${index + 1}`;
          thumbBtn.appendChild(thumbImg);

          const activateScreenshotThumb = (e: Event) => {
            const mouse = e as MouseEvent;
            if (typeof mouse.button === "number" && mouse.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            mutateChatWithScrollGuard(() => {
              msg.screenshotActiveIndex = index;
              if (!msg.screenshotExpanded) {
                msg.screenshotExpanded = true;
              }
              applyScreenshotState();
            });
          };
          thumbBtn.addEventListener("mousedown", activateScreenshotThumb);
          thumbBtn.addEventListener("click", (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
          });
          thumbBtn.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            activateScreenshotThumb(e);
          });
          thumbButtons.push(thumbBtn);
          thumbStrip.appendChild(thumbBtn);
        });

        screenshotExpandedEl.append(thumbStrip, previewWrap);

        const applyScreenshotState = () => {
          const expanded = Boolean(msg.screenshotExpanded);
          let activeIndex =
            typeof msg.screenshotActiveIndex === "number"
              ? Math.floor(msg.screenshotActiveIndex)
              : 0;
          if (activeIndex < 0 || activeIndex >= screenshotImages.length) {
            activeIndex = 0;
            msg.screenshotActiveIndex = 0;
          }
          screenshotBar.classList.toggle("expanded", expanded);
          screenshotBar.setAttribute(
            "aria-expanded",
            expanded ? "true" : "false",
          );
          screenshotExpandedEl.hidden = !expanded;
          screenshotExpandedEl.style.display = expanded ? "flex" : "none";
          previewImg.src = screenshotImages[activeIndex];
          thumbButtons.forEach((btn, index) => {
            btn.classList.toggle("active", index === activeIndex);
          });
          screenshotBar.title = expanded
            ? "Collapse figures"
            : "Expand figures";
        };

        const toggleScreenshotsExpanded = () => {
          mutateChatWithScrollGuard(() => {
            msg.screenshotExpanded = !msg.screenshotExpanded;
            applyScreenshotState();
          });
        };
        applyScreenshotState();
        screenshotBar.addEventListener("mousedown", (e: Event) => {
          const mouse = e as MouseEvent;
          if (mouse.button !== 0) return;
          mouse.preventDefault();
          mouse.stopPropagation();
          toggleScreenshotsExpanded();
        });
        screenshotBar.addEventListener("click", (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
        });
        screenshotBar.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          toggleScreenshotsExpanded();
        });

        contextBadgesRow.appendChild(screenshotBar);
        hasContextBadge = true;
      }

      const paperContexts = normalizePaperContexts(msg.paperContexts);
      hasUserContext = hasUserContext || paperContexts.length > 0;
      if (paperContexts.length) {
        const papersBar = doc.createElement("button") as HTMLButtonElement;
        papersBar.type = "button";
        papersBar.className = "llm-user-papers-bar";

        const papersIcon = doc.createElement("span") as HTMLSpanElement;
        papersIcon.className = "llm-user-papers-icon";
        papersIcon.textContent = "📚";

        const papersLabel = doc.createElement("span") as HTMLSpanElement;
        papersLabel.className = "llm-user-papers-label";
        papersLabel.textContent = formatPaperCountLabel(paperContexts.length);
        papersLabel.title = paperContexts
          .map((entry) => entry.title)
          .join("\n");
        papersBar.append(papersIcon, papersLabel);

        const papersExpandedEl = doc.createElement("div") as HTMLDivElement;
        papersExpandedEl.className = "llm-user-papers-expanded";
        papersExpanded = papersExpandedEl;
        const papersList = doc.createElement("div") as HTMLDivElement;
        papersList.className = "llm-user-papers-list";
        for (const paperContext of paperContexts) {
          const paperItem = doc.createElement("div") as HTMLDivElement;
          paperItem.className = "llm-user-papers-item";

          if (paperContext.citationKey) {
            const keyBadge = doc.createElement("span") as HTMLSpanElement;
            keyBadge.className = "llm-user-papers-item-key";
            keyBadge.textContent = paperContext.citationKey;
            keyBadge.title = paperContext.citationKey;
            paperItem.appendChild(keyBadge);
          }

          const paperTitle = doc.createElement("span") as HTMLSpanElement;
          paperTitle.className = "llm-user-papers-item-title";
          paperTitle.textContent = paperContext.title;
          paperTitle.title = paperContext.title;

          const paperMeta = doc.createElement("span") as HTMLSpanElement;
          paperMeta.className = "llm-user-papers-item-meta";
          const metaParts = [
            paperContext.firstCreator || "",
            paperContext.year || "",
          ].filter(Boolean);
          paperMeta.textContent = metaParts.join(" · ") || "Supplemental paper";
          paperMeta.title = paperMeta.textContent;
          paperItem.append(paperTitle, paperMeta);
          papersList.appendChild(paperItem);
        }
        papersExpandedEl.appendChild(papersList);

        const applyPapersState = () => {
          const expanded = Boolean(msg.paperContextsExpanded);
          papersBar.classList.toggle("expanded", expanded);
          papersBar.setAttribute("aria-expanded", expanded ? "true" : "false");
          papersExpandedEl.hidden = !expanded;
          papersExpandedEl.style.display = expanded ? "block" : "none";
          papersBar.title = expanded ? "Collapse papers" : "Expand papers";
        };
        const togglePapersExpanded = () => {
          msg.paperContextsExpanded = !msg.paperContextsExpanded;
          applyPapersState();
        };
        applyPapersState();
        papersBar.addEventListener("mousedown", (e: Event) => {
          const mouse = e as MouseEvent;
          if (mouse.button !== 0) return;
          mouse.preventDefault();
          mouse.stopPropagation();
          togglePapersExpanded();
        });
        papersBar.addEventListener("click", (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
        });
        papersBar.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          togglePapersExpanded();
        });

        contextBadgesRow.appendChild(papersBar);
        hasContextBadge = true;
      }

      const fileAttachments = Array.isArray(msg.attachments)
        ? msg.attachments.filter(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              entry.category !== "image" &&
              typeof entry.name === "string",
          )
        : [];
      hasUserContext = hasUserContext || fileAttachments.length > 0;
      if (fileAttachments.length) {
        const filesBar = doc.createElement("button") as HTMLButtonElement;
        filesBar.type = "button";
        filesBar.className = "llm-user-files-bar";

        const filesIcon = doc.createElement("span") as HTMLSpanElement;
        filesIcon.className = "llm-user-files-icon";
        filesIcon.textContent = "📎";

        const filesLabel = doc.createElement("span") as HTMLSpanElement;
        filesLabel.className = "llm-user-files-label";
        filesLabel.textContent = `Files (${fileAttachments.length})`;
        filesLabel.title = fileAttachments.map((f) => f.name).join("\n");

        filesBar.append(filesIcon, filesLabel);

        const filesExpandedEl = doc.createElement("div") as HTMLDivElement;
        filesExpandedEl.className = "llm-user-files-expanded";
        filesExpanded = filesExpandedEl;
        const filesList = doc.createElement("div") as HTMLDivElement;
        filesList.className = "llm-user-files-list";

        for (const attachment of fileAttachments) {
          const canOpen = Boolean(toFileUrl(attachment.storedPath));
          const fileItem = doc.createElement(canOpen ? "button" : "div") as
            | HTMLButtonElement
            | HTMLDivElement;
          fileItem.className = "llm-user-files-item";
          if (canOpen) {
            fileItem.classList.add("llm-user-files-item-openable");
            (fileItem as HTMLButtonElement).type = "button";
            (fileItem as HTMLButtonElement).title = `Open ${attachment.name}`;
            fileItem.addEventListener("mousedown", (e: Event) => {
              const mouse = e as MouseEvent;
              if (mouse.button !== 0) return;
              mouse.preventDefault();
              mouse.stopPropagation();
              openStoredAttachmentFromMessage(attachment);
            });
            fileItem.addEventListener("click", (e: Event) => {
              e.preventDefault();
              e.stopPropagation();
            });
            fileItem.addEventListener("keydown", (e: KeyboardEvent) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              e.stopPropagation();
              openStoredAttachmentFromMessage(attachment);
            });
          }

          const fileType = doc.createElement("span") as HTMLSpanElement;
          fileType.className = "llm-user-files-item-type";
          fileType.textContent = getAttachmentTypeLabel(attachment);
          fileType.title = attachment.mimeType || attachment.category || "file";

          const fileInfo = doc.createElement("div") as HTMLDivElement;
          fileInfo.className = "llm-user-files-item-text";

          const fileName = doc.createElement("span") as HTMLSpanElement;
          fileName.className = "llm-user-files-item-name";
          fileName.textContent = attachment.name;
          fileName.title = attachment.name;

          const fileMeta = doc.createElement("span") as HTMLSpanElement;
          fileMeta.className = "llm-user-files-item-meta";
          fileMeta.textContent = `${attachment.mimeType || "application/octet-stream"} · ${(attachment.sizeBytes / 1024 / 1024).toFixed(2)} MB`;

          fileInfo.append(fileName, fileMeta);
          fileItem.append(fileType, fileInfo);
          filesList.appendChild(fileItem);
        }
        filesExpandedEl.appendChild(filesList);

        const applyFilesState = () => {
          const expanded = Boolean(msg.attachmentsExpanded);
          filesBar.classList.toggle("expanded", expanded);
          filesBar.setAttribute("aria-expanded", expanded ? "true" : "false");
          filesExpandedEl.hidden = !expanded;
          filesExpandedEl.style.display = expanded ? "block" : "none";
          filesBar.title = expanded ? "Collapse files" : "Expand files";
        };
        const toggleFilesExpanded = () => {
          msg.attachmentsExpanded = !msg.attachmentsExpanded;
          applyFilesState();
        };
        applyFilesState();
        filesBar.addEventListener("mousedown", (e: Event) => {
          const mouse = e as MouseEvent;
          if (mouse.button !== 0) return;
          mouse.preventDefault();
          mouse.stopPropagation();
          toggleFilesExpanded();
        });
        filesBar.addEventListener("click", (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
        });
        filesBar.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          toggleFilesExpanded();
        });

        contextBadgesRow.appendChild(filesBar);
        hasContextBadge = true;
      }

      if (hasContextBadge) {
        wrapper.appendChild(contextBadgesRow);
      }
      if (screenshotExpanded) {
        wrapper.appendChild(screenshotExpanded);
      }
      if (papersExpanded) {
        wrapper.appendChild(papersExpanded);
      }
      if (filesExpanded) {
        wrapper.appendChild(filesExpanded);
      }

      if (hasSelectedTextContext) {
        let selectedTextExpandedIndex = getMessageSelectedTextExpandedIndex(
          msg,
          selectedTexts.length,
        );
        const syncSelectedTextExpandedState = () => {
          msg.selectedTextExpandedIndex = selectedTextExpandedIndex;
          msg.selectedTextExpanded = selectedTextExpandedIndex === 0;
        };
        syncSelectedTextExpandedState();
        const applySelectedTextStates: Array<() => void> = [];
        const renderSelectedTextStates = () => {
          for (const applyState of applySelectedTextStates) {
            applyState();
          }
        };

        selectedTexts.forEach((selectedText, contextIndex) => {
          const selectedSource = selectedTextSources[contextIndex] || "pdf";
          const selectedTextPaperContext = selectedTextPaperContexts[contextIndex];
          const selectedTextPaperLabel =
            isGlobalConversation &&
            selectedSource === "pdf" &&
            selectedTextPaperContext
              ? formatPaperCitationLabel(selectedTextPaperContext)
              : "";
          const selectedBar = doc.createElement("button") as HTMLButtonElement;
          selectedBar.type = "button";
          selectedBar.className = "llm-user-selected-text";
          selectedBar.dataset.contextSource = selectedSource;

          const selectedIcon = doc.createElement("span") as HTMLSpanElement;
          selectedIcon.className = "llm-user-selected-text-icon";
          selectedIcon.textContent = getSelectedTextSourceIcon(selectedSource);

          const selectedContent = doc.createElement("span") as HTMLSpanElement;
          selectedContent.className = "llm-user-selected-text-content";
          selectedContent.textContent = selectedTextPaperLabel
            ? `${selectedTextPaperLabel} - ${selectedText}`
            : selectedText;

          const selectedExpanded = doc.createElement("div") as HTMLDivElement;
          selectedExpanded.className = "llm-user-selected-text-expanded";
          selectedExpanded.textContent = selectedTextPaperLabel
            ? `${selectedTextPaperLabel}\n\n${selectedText}`
            : selectedText;

          selectedBar.append(selectedIcon, selectedContent);
          const applySelectedTextState = () => {
            const expanded = selectedTextExpandedIndex === contextIndex;
            selectedBar.classList.toggle("expanded", expanded);
            selectedBar.setAttribute(
              "aria-expanded",
              expanded ? "true" : "false",
            );
            selectedExpanded.hidden = !expanded;
            selectedExpanded.style.display = expanded ? "block" : "none";
            selectedBar.title = expanded
              ? "Collapse selected text"
              : "Expand selected text";
          };
          const toggleSelectedTextExpanded = () => {
            mutateChatWithScrollGuard(() => {
              selectedTextExpandedIndex =
                selectedTextExpandedIndex === contextIndex ? -1 : contextIndex;
              syncSelectedTextExpandedState();
              renderSelectedTextStates();
            });
          };
          applySelectedTextStates.push(applySelectedTextState);
          selectedBar.addEventListener("mousedown", (e: Event) => {
            const mouse = e as MouseEvent;
            if (mouse.button !== 0) return;
            mouse.preventDefault();
            mouse.stopPropagation();
            toggleSelectedTextExpanded();
          });
          selectedBar.addEventListener("click", (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
          });
          selectedBar.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            e.stopPropagation();
            toggleSelectedTextExpanded();
          });
          wrapper.appendChild(selectedBar);
          wrapper.appendChild(selectedExpanded);
        });
        renderSelectedTextStates();
      }
      bubble.textContent = sanitizeText(msg.text || "");
      if (canEditLatestUserPrompt) {
        bubble.addEventListener("contextmenu", (e: Event) => {
          const me = e as MouseEvent;
          me.preventDefault();
          me.stopPropagation();
          if (typeof me.stopImmediatePropagation === "function") {
            me.stopImmediatePropagation();
          }
          const promptMenu = body.querySelector(
            "#llm-prompt-menu",
          ) as HTMLDivElement | null;
          const responseMenu = body.querySelector(
            "#llm-response-menu",
          ) as HTMLDivElement | null;
          const exportMenu = body.querySelector(
            "#llm-export-menu",
          ) as HTMLDivElement | null;
          const retryModelMenu = body.querySelector(
            "#llm-retry-model-menu",
          ) as HTMLDivElement | null;
          if (!promptMenu) return;
          if (responseMenu) responseMenu.style.display = "none";
          if (exportMenu) exportMenu.style.display = "none";
          if (retryModelMenu) {
            retryModelMenu.classList.remove("llm-model-menu-open");
            retryModelMenu.style.display = "none";
          }
          setResponseMenuTarget(null);
          setPromptMenuTarget({
            item,
            conversationKey,
            userTimestamp: latestEditableUserTimestamp as number,
            assistantTimestamp: latestEditableAssistantTimestamp as number,
          });
          positionMenuAtPointer(body, promptMenu, me.clientX, me.clientY);
        });
      }
    } else {
      const hasModelName = Boolean(msg.modelName?.trim());
      const hasAnswerText = Boolean(msg.text);
      if (hasAnswerText) {
        const safeText = sanitizeText(msg.text);
        if (msg.streaming) bubble.classList.add("streaming");
        try {
          bubble.innerHTML = renderMarkdown(safeText);
        } catch (err) {
          ztoolkit.log("LLM render error:", err);
          bubble.textContent = safeText;
        }
        bubble.addEventListener("contextmenu", (e: Event) => {
          const me = e as MouseEvent;
          me.preventDefault();
          me.stopPropagation();
          if (typeof me.stopImmediatePropagation === "function") {
            me.stopImmediatePropagation();
          }
          const responseMenu = body.querySelector(
            "#llm-response-menu",
          ) as HTMLDivElement | null;
          const exportMenu = body.querySelector(
            "#llm-export-menu",
          ) as HTMLDivElement | null;
          const promptMenu = body.querySelector(
            "#llm-prompt-menu",
          ) as HTMLDivElement | null;
          const retryModelMenu = body.querySelector(
            "#llm-retry-model-menu",
          ) as HTMLDivElement | null;
          if (!responseMenu || !item) return;
          if (exportMenu) exportMenu.style.display = "none";
          if (promptMenu) promptMenu.style.display = "none";
          if (retryModelMenu) {
            retryModelMenu.classList.remove("llm-model-menu-open");
            retryModelMenu.style.display = "none";
          }
          setPromptMenuTarget(null);
          // If the user has text selected within this bubble, extract
          // just that portion (with KaTeX math properly handled).
          // Otherwise fall back to the full raw markdown source.
          const selectedText = getSelectedTextWithinBubble(doc, bubble);
          const fullMarkdown = sanitizeText(msg.text || "").trim();
          const contentText = selectedText || fullMarkdown;
          if (!contentText) return;
          setResponseMenuTarget({
            item,
            contentText,
            modelName: msg.modelName?.trim() || "unknown",
          });
          positionMenuAtPointer(body, responseMenu, me.clientX, me.clientY);
        });
      }

      const hasReasoningSummary = Boolean(msg.reasoningSummary?.trim());
      const hasReasoningDetails = Boolean(msg.reasoningDetails?.trim());
      if (hasReasoningSummary || hasReasoningDetails) {
        const details = doc.createElement("details") as HTMLDetailsElement;
        details.className = "llm-reasoning";
        details.open = Boolean(msg.reasoningOpen);

        const summary = doc.createElement("summary") as HTMLElement;
        summary.className = "llm-reasoning-summary";
        summary.textContent = "Thinking";
        const toggleReasoning = (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
          mutateChatWithScrollGuard(() => {
            const next = !msg.reasoningOpen;
            msg.reasoningOpen = next;
            details.open = next;
            setLastReasoningExpanded(next);
          });
        };
        summary.addEventListener("mousedown", toggleReasoning);
        summary.addEventListener("click", (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
        });
        summary.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            toggleReasoning(e);
          }
        });
        details.appendChild(summary);

        const bodyWrap = doc.createElement("div") as HTMLDivElement;
        bodyWrap.className = "llm-reasoning-body";

        if (hasReasoningSummary) {
          const summaryBlock = doc.createElement("div") as HTMLDivElement;
          summaryBlock.className = "llm-reasoning-block";
          const label = doc.createElement("div") as HTMLDivElement;
          label.className = "llm-reasoning-label";
          label.textContent = "Summary";
          const text = doc.createElement("div") as HTMLDivElement;
          text.className = "llm-reasoning-text";
          try {
            text.innerHTML = renderMarkdown(msg.reasoningSummary || "");
          } catch (err) {
            ztoolkit.log("LLM reasoning render error:", err);
            text.textContent = msg.reasoningSummary || "";
          }
          summaryBlock.append(label, text);
          bodyWrap.appendChild(summaryBlock);
        }

        if (hasReasoningDetails) {
          const detailsBlock = doc.createElement("div") as HTMLDivElement;
          detailsBlock.className = "llm-reasoning-block";
          const label = doc.createElement("div") as HTMLDivElement;
          label.className = "llm-reasoning-label";
          label.textContent = "Details";
          const text = doc.createElement("div") as HTMLDivElement;
          text.className = "llm-reasoning-text";
          try {
            text.innerHTML = renderMarkdown(msg.reasoningDetails || "");
          } catch (err) {
            ztoolkit.log("LLM reasoning render error:", err);
            text.textContent = msg.reasoningDetails || "";
          }
          detailsBlock.append(label, text);
          bodyWrap.appendChild(detailsBlock);
        }

        details.appendChild(bodyWrap);
        bubble.insertBefore(details, bubble.firstChild);
      }

      if (!hasAnswerText) {
        const typing = doc.createElement("div") as HTMLDivElement;
        typing.className = "llm-typing";
        typing.innerHTML =
          '<span class="llm-typing-dot"></span><span class="llm-typing-dot"></span><span class="llm-typing-dot"></span>';
        bubble.appendChild(typing);
      }

      if (hasModelName) {
        const modelName = doc.createElement("div") as HTMLDivElement;
        modelName.className = "llm-model-name";
        modelName.textContent = msg.modelName?.trim() || "";
        bubble.insertBefore(modelName, bubble.firstChild);
      }
    }

    const meta = doc.createElement("div") as HTMLDivElement;
    meta.className = "llm-message-meta";

    const time = doc.createElement("span") as HTMLSpanElement;
    time.className = "llm-message-time";
    time.textContent = formatTime(msg.timestamp);
    if (canEditLatestUserPrompt) {
      const editBtn = doc.createElement("button") as HTMLButtonElement;
      editBtn.type = "button";
      editBtn.className = "llm-edit-latest";
      editBtn.textContent = "✎";
      editBtn.title = "Edit latest prompt";
      editBtn.setAttribute("aria-label", "Edit latest prompt");
      editBtn.dataset.userTimestamp = String(
        latestEditableUserTimestamp as number,
      );
      editBtn.dataset.assistantTimestamp = String(
        latestEditableAssistantTimestamp as number,
      );
      meta.appendChild(editBtn);
    }
    meta.appendChild(time);
    if (
      !isUser &&
      index === latestAssistantIndex &&
      !msg.streaming &&
      msg.text.trim()
    ) {
      const retryBtn = doc.createElement("button") as HTMLButtonElement;
      retryBtn.type = "button";
      retryBtn.className = "llm-retry-latest";
      retryBtn.textContent = "↻";
      retryBtn.title = "Retry response with another model";
      retryBtn.setAttribute("aria-label", "Retry latest response");
      meta.appendChild(retryBtn);
    }

    wrapper.appendChild(bubble);
    wrapper.appendChild(meta);
    chatBox.appendChild(wrapper);
    if (isUser && hasUserContext) {
      wrapper.classList.add("llm-user-context-aligned");
    }
  }

  syncUserContextAlignmentWidths(body);

  applyChatScrollSnapshot(chatBox, baselineSnapshot);
  persistChatScrollSnapshotByKey(conversationKey, chatBox);
  if (baselineSnapshot.mode === "followBottom") {
    scheduleFollowBottomStabilization(body, conversationKey, chatBox);
  } else {
    const win = body.ownerDocument?.defaultView;
    const active = followBottomStabilizers.get(conversationKey);
    if (active && win) {
      if (typeof active.rafId === "number") {
        win.cancelAnimationFrame(active.rafId);
      }
      if (typeof active.timeoutId === "number") {
        win.clearTimeout(active.timeoutId);
      }
      followBottomStabilizers.delete(conversationKey);
    }
  }
}
