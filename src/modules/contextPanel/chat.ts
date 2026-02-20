import { renderMarkdown, renderMarkdownForNote } from "../../utils/markdown";
import {
  appendMessage as appendStoredMessage,
  clearConversation as clearStoredConversation,
  loadConversation,
  pruneConversation,
  updateLatestAssistantMessage as updateStoredLatestAssistantMessage,
  StoredChatMessage,
} from "../../utils/chatStore";
import {
  callLLMStream,
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
} from "./constants";
import type {
  Message,
  ReasoningProviderKind,
  ReasoningOption,
  ReasoningLevelSelection,
  AdvancedModelParams,
  ChatAttachment,
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
  pdfTextCache,
} from "./state";
import {
  sanitizeText,
  formatTime,
  setStatus,
  getSelectedTextWithinBubble,
  getAttachmentTypeLabel,
  buildQuestionWithSelectedText,
  buildModelPromptWithFileContext,
  resolvePromptText,
} from "./textUtils";
import { positionMenuAtPointer } from "./menuPositioning";
import {
  getSelectedProfileForItem,
  getAdvancedModelParamsForProfile,
  getStringPref,
} from "./prefHelpers";
import { buildContext, ensurePDFTextCached } from "./pdfContext";
import {
  getActiveContextAttachmentFromTabs,
  resolveContextSourceItem,
} from "./contextResolution";
import { buildChatHistoryNotePayload } from "./notes";

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
): void {
  if (!chatBox || conversationKey === null) {
    fn();
    return;
  }
  // Capture current state before mutations.
  const wasNearBottom = isNearBottom(chatBox);
  const savedScrollTop = chatBox.scrollTop;

  _scrollUpdatesSuspended = true;
  try {
    fn();
  } finally {
    // Restore: if the user was at the bottom, stick there;
    // otherwise restore the exact pixel offset.
    if (wasNearBottom) {
      chatBox.scrollTop = chatBox.scrollHeight;
    } else {
      chatBox.scrollTop = savedScrollTop;
    }
    // Persist the (restored) position.
    persistChatScrollSnapshotByKey(conversationKey, chatBox);
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

/**
 * Persist scroll for the chat currently rendered in `body`, if available.
 * Used before panel re-render to avoid scroll jumps when the chat box node
 * gets recreated.
 */
export function persistChatScrollSnapshotFromBody(body: Element): void {
  const panel = body.querySelector("#llm-main") as HTMLDivElement | null;
  const chatBox = body.querySelector("#llm-chat-box") as HTMLDivElement | null;
  if (!panel || !chatBox) return;
  if (!chatBox.childElementCount) return;

  const panelItemId = Number(panel.dataset.itemId || 0);
  if (!Number.isFinite(panelItemId) || panelItemId <= 0) return;
  const panelItem = Zotero.Items.get(panelItemId) || null;
  if (!panelItem) return;

  persistChatScrollSnapshot(panelItem, chatBox);
}

async function persistConversationMessage(
  conversationKey: number,
  message: StoredChatMessage,
): Promise<void> {
  try {
    await appendStoredMessage(conversationKey, message);
    await pruneConversation(conversationKey, PERSISTED_HISTORY_LIMIT);
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
  return {
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
    selectedText: message.selectedText,
    selectedTextExpanded: false,
    screenshotImages,
    attachments,
    attachmentsExpanded: false,
    screenshotExpanded: false,
    screenshotActiveIndex: screenshotImages?.length ? 0 : undefined,
    modelName: message.modelName,
    reasoningSummary: message.reasoningSummary,
    reasoningDetails: message.reasoningDetails,
    reasoningOpen: false,
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

  let selectedLevel = selectedReasoningCache.get(itemId) || "none";
  if (
    selectedLevel === "none" ||
    !enabledLevels.includes(selectedLevel as LLMReasoningLevel)
  ) {
    selectedLevel = enabledLevels[0];
    selectedReasoningCache.set(itemId, selectedLevel);
  }

  return { provider, level: selectedLevel as LLMReasoningLevel };
}

type LatestRetryPair = {
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

function findLatestRetryPair(history: Message[]): LatestRetryPair | null {
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
} {
  const selectedText = sanitizeText(userMessage.selectedText || "").trim();
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
    selectedText,
    fileAttachments.length > 0,
  );
  const composedQuestionBase = selectedText
    ? buildQuestionWithSelectedText(selectedText, promptText)
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
  return { question, screenshotImages };
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
  const inputBox = body.querySelector(
    "#llm-input",
  ) as HTMLTextAreaElement | null;
  const chatBox = body.querySelector("#llm-chat-box") as HTMLDivElement | null;
  const sendBtn = body.querySelector("#llm-send") as HTMLButtonElement | null;
  const cancelBtn = body.querySelector(
    "#llm-cancel",
  ) as HTMLButtonElement | null;
  const status = body.querySelector("#llm-status") as HTMLElement | null;

  await ensureConversationLoaded(item);
  const conversationKey = getConversationKey(item);
  const history = chatHistory.get(conversationKey) || [];
  const retryPair = findLatestRetryPair(history);
  if (!retryPair) {
    if (status) setStatus(status, "No retryable response found", "error");
    return;
  }

  const thisRequestId = nextRequestId();
  withScrollGuard(chatBox, conversationKey, () => {
    if (sendBtn) sendBtn.style.display = "none";
    if (cancelBtn) cancelBtn.style.display = "";
    if (inputBox) inputBox.disabled = true;
    if (status) setStatus(status, "Preparing retry...", "sending");
  });

  const refreshChatSafely = () => {
    withScrollGuard(chatBox, conversationKey, () => {
      refreshChat(body, item);
    });
  };
  const setStatusSafely = (
    text: string,
    kind: Parameters<typeof setStatus>[2],
  ) => {
    if (!status) return;
    withScrollGuard(chatBox, conversationKey, () => {
      setStatus(status, text, kind);
    });
  };

  const historyForLLM = history
    .slice(0, retryPair.userIndex)
    .slice(-MAX_HISTORY_MESSAGES);
  const { question, screenshotImages } = reconstructRetryPayload(
    retryPair.userMessage,
  );
  if (!question.trim()) {
    setStatusSafely("Nothing to retry for latest turn", "error");
    withScrollGuard(chatBox, conversationKey, () => {
      if (inputBox) {
        inputBox.disabled = false;
        inputBox.focus({ preventScroll: true });
      }
      if (sendBtn) sendBtn.style.display = "";
      if (cancelBtn) cancelBtn.style.display = "none";
    });
    return;
  }

  const fallbackProfile = getSelectedProfileForItem(item.id);
  const effectiveModel = (
    model ||
    fallbackProfile.model ||
    getStringPref("modelPrimary") ||
    getStringPref("model") ||
    "gpt-4o-mini"
  ).trim();
  const effectiveApiBase = (apiBase || fallbackProfile.apiBase).trim();
  const effectiveApiKey = (apiKey || fallbackProfile.apiKey).trim();
  const effectiveReasoning =
    reasoning ||
    getSelectedReasoningForItem(item.id, effectiveModel, effectiveApiBase);
  const effectiveAdvanced =
    advanced || getAdvancedModelParamsForProfile(fallbackProfile.key);

  const assistantMessage = retryPair.assistantMessage;
  const assistantSnapshot = takeAssistantSnapshot(assistantMessage);
  assistantMessage.text = "";
  assistantMessage.timestamp = Date.now();
  assistantMessage.modelName = effectiveModel;
  assistantMessage.streaming = true;
  assistantMessage.reasoningSummary = undefined;
  assistantMessage.reasoningDetails = undefined;
  assistantMessage.reasoningOpen = false;
  refreshChatSafely();

  const restoreOriginalAssistant = () => {
    restoreAssistantSnapshot(assistantMessage, assistantSnapshot);
    refreshChatSafely();
  };

  try {
    const contextSource = resolveContextSourceItem(item);
    setStatusSafely(contextSource.statusText, "sending");

    let pdfContext = "";
    if (contextSource.contextItem) {
      await ensurePDFTextCached(contextSource.contextItem);
      pdfContext = await buildContext(
        pdfTextCache.get(contextSource.contextItem.id),
        question,
        screenshotImages.length > 0,
        { apiBase: effectiveApiBase, apiKey: effectiveApiKey },
      );
    }

    const llmHistory: ChatMessage[] = historyForLLM.map((msg) => ({
      role: msg.role,
      content: msg.text,
    }));

    const AbortControllerCtor = getAbortController();
    setCurrentAbortController(
      AbortControllerCtor ? new AbortControllerCtor() : null,
    );

    let refreshQueued = false;
    const queueRefresh = () => {
      if (refreshQueued) return;
      refreshQueued = true;
      setTimeout(() => {
        refreshQueued = false;
        refreshChatSafely();
      }, 50);
    };

    const answer = await callLLMStream(
      {
        prompt: question,
        context: pdfContext,
        history: llmHistory,
        signal: currentAbortController?.signal,
        images: screenshotImages,
        model: effectiveModel,
        apiBase: effectiveApiBase,
        apiKey: effectiveApiKey,
        reasoning: effectiveReasoning,
        temperature: effectiveAdvanced?.temperature,
        maxTokens: effectiveAdvanced?.maxTokens,
      },
      (delta) => {
        assistantMessage.text += sanitizeText(delta);
        queueRefresh();
      },
      (reasoningEvent: ReasoningEvent) => {
        if (reasoningEvent.summary) {
          assistantMessage.reasoningSummary = appendReasoningPart(
            assistantMessage.reasoningSummary,
            reasoningEvent.summary,
          );
        }
        if (reasoningEvent.details) {
          assistantMessage.reasoningDetails = appendReasoningPart(
            assistantMessage.reasoningDetails,
            reasoningEvent.details,
          );
        }
        queueRefresh();
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
      sanitizeText(answer) || assistantMessage.text || "No response.";
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
    setStatusSafely(`Retry failed: ${errMsg.slice(0, 48)}`, "error");
  } finally {
    if (cancelledRequestId < thisRequestId) {
      withScrollGuard(chatBox, conversationKey, () => {
        if (inputBox) {
          inputBox.disabled = false;
          inputBox.focus({ preventScroll: true });
        }
        if (sendBtn) {
          sendBtn.style.display = "";
          sendBtn.disabled = false;
        }
        if (cancelBtn) cancelBtn.style.display = "none";
      });
    }
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
  selectedText?: string,
  attachments?: ChatAttachment[],
) {
  const inputBox = body.querySelector(
    "#llm-input",
  ) as HTMLTextAreaElement | null;
  const chatBox = body.querySelector("#llm-chat-box") as HTMLDivElement | null;
  const sendBtn = body.querySelector("#llm-send") as HTMLButtonElement | null;
  const cancelBtn = body.querySelector(
    "#llm-cancel",
  ) as HTMLButtonElement | null;
  const status = body.querySelector("#llm-status") as HTMLElement | null;

  // Track this request
  const thisRequestId = nextRequestId();
  const initialConversationKey = getConversationKey(item);

  // Show cancel, hide send
  withScrollGuard(chatBox, initialConversationKey, () => {
    if (sendBtn) sendBtn.style.display = "none";
    if (cancelBtn) cancelBtn.style.display = "";
    if (inputBox) inputBox.disabled = true;
    if (status) setStatus(status, "Preparing request...", "sending");
  });

  await ensureConversationLoaded(item);
  const conversationKey = getConversationKey(item);
  const refreshChatSafely = () => {
    withScrollGuard(chatBox, conversationKey, () => {
      refreshChat(body, item);
    });
  };
  const setStatusSafely = (
    text: string,
    kind: Parameters<typeof setStatus>[2],
  ) => {
    if (!status) return;
    withScrollGuard(chatBox, conversationKey, () => {
      setStatus(status, text, kind);
    });
  };

  // Add user message with attached selected text / screenshots metadata
  if (!chatHistory.has(conversationKey)) {
    chatHistory.set(conversationKey, []);
  }
  const history = chatHistory.get(conversationKey)!;
  const historyForLLM = history.slice(-MAX_HISTORY_MESSAGES);
  const fallbackProfile = getSelectedProfileForItem(item.id);
  const effectiveModel = (
    model ||
    fallbackProfile.model ||
    getStringPref("modelPrimary") ||
    getStringPref("model") ||
    "gpt-4o-mini"
  ).trim();
  const effectiveApiBase = (apiBase || fallbackProfile.apiBase).trim();
  const effectiveApiKey = (apiKey || fallbackProfile.apiKey).trim();
  const effectiveReasoning =
    reasoning ||
    getSelectedReasoningForItem(item.id, effectiveModel, effectiveApiBase);
  const effectiveAdvanced =
    advanced || getAdvancedModelParamsForProfile(fallbackProfile.key);
  const shownQuestion = displayQuestion || question;
  const selectedTextForMessage = sanitizeText(selectedText || "").trim();
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
    screenshotImages: userMessage.screenshotImages,
    attachments: userMessage.attachments,
  });

  const assistantMessage: Message = {
    role: "assistant",
    text: "",
    timestamp: Date.now(),
    modelName: effectiveModel,
    streaming: true,
    reasoningOpen: false,
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
    const contextSource = resolveContextSourceItem(item);
    setStatusSafely(contextSource.statusText, "sending");

    let pdfContext = "";
    if (contextSource.contextItem) {
      await ensurePDFTextCached(contextSource.contextItem);
      pdfContext = await buildContext(
        pdfTextCache.get(contextSource.contextItem.id),
        question,
        imageCount > 0,
        { apiBase: effectiveApiBase, apiKey: effectiveApiKey },
      );
    }

    const llmHistory: ChatMessage[] = historyForLLM.map((msg) => ({
      role: msg.role,
      content: msg.text,
    }));

    const AbortControllerCtor = getAbortController();
    setCurrentAbortController(
      AbortControllerCtor ? new AbortControllerCtor() : null,
    );
    let refreshQueued = false;
    const queueRefresh = () => {
      if (refreshQueued) return;
      refreshQueued = true;
      setTimeout(() => {
        refreshQueued = false;
        refreshChatSafely();
      }, 50);
    };

    const answer = await callLLMStream(
      {
        prompt: question,
        context: pdfContext,
        history: llmHistory,
        signal: currentAbortController?.signal,
        images: images,
        model: effectiveModel,
        apiBase: effectiveApiBase,
        apiKey: effectiveApiKey,
        reasoning: effectiveReasoning,
        temperature: effectiveAdvanced?.temperature,
        maxTokens: effectiveAdvanced?.maxTokens,
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
    assistantMessage.text = `Error: ${errMsg}`;
    assistantMessage.streaming = false;
    refreshChatSafely();
    await persistAssistantOnce();

    setStatusSafely(`Error: ${errMsg.slice(0, 40)}`, "error");
  } finally {
    // Only restore UI if this is still the current request
    if (cancelledRequestId < thisRequestId) {
      withScrollGuard(chatBox, conversationKey, () => {
        if (inputBox) {
          inputBox.disabled = false;
          inputBox.focus({ preventScroll: true });
        }
        if (sendBtn) {
          sendBtn.style.display = "";
          sendBtn.disabled = false;
        }
        if (cancelBtn) cancelBtn.style.display = "none";
      });
    }
    setCurrentAbortController(null);
  }
}

export function refreshChat(body: Element, item?: Zotero.Item | null) {
  const chatBox = body.querySelector("#llm-chat-box") as HTMLDivElement | null;
  if (!chatBox) return;
  const doc = body.ownerDocument!;

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

  let latestAssistantIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === "assistant") {
      latestAssistantIndex = i;
      break;
    }
  }

  for (const [index, msg] of history.entries()) {
    const isUser = msg.role === "user";
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
      let filesExpanded: HTMLDivElement | null = null;
      const selectedText = sanitizeText(msg.selectedText || "").trim();
      const hasScreenshotContext = screenshotImages.length > 0;
      const hasSelectedTextContext = Boolean(selectedText);
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

      const fileAttachments = Array.isArray(msg.attachments)
        ? msg.attachments.filter(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              entry.category !== "image" &&
              typeof entry.name === "string",
          )
        : [];
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
          const fileItem = doc.createElement("div") as HTMLDivElement;
          fileItem.className = "llm-user-files-item";

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
      if (filesExpanded) {
        wrapper.appendChild(filesExpanded);
      }

      if (hasSelectedTextContext) {
        const selectedBar = doc.createElement("button") as HTMLButtonElement;
        selectedBar.type = "button";
        selectedBar.className = "llm-user-selected-text";

        const selectedIcon = doc.createElement("span") as HTMLSpanElement;
        selectedIcon.className = "llm-user-selected-text-icon";
        selectedIcon.textContent = "↳";

        const selectedContent = doc.createElement("span") as HTMLSpanElement;
        selectedContent.className = "llm-user-selected-text-content";
        selectedContent.textContent = selectedText;

        const selectedExpanded = doc.createElement("div") as HTMLDivElement;
        selectedExpanded.className = "llm-user-selected-text-expanded";
        selectedExpanded.textContent = selectedText;

        selectedBar.append(selectedIcon, selectedContent);
        const applySelectedTextState = () => {
          const expanded = Boolean(msg.selectedTextExpanded);
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
            msg.selectedTextExpanded = !msg.selectedTextExpanded;
            applySelectedTextState();
          });
        };
        applySelectedTextState();
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
      }
      bubble.textContent = sanitizeText(msg.text || "");
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
          if (!responseMenu || !item) return;
          if (exportMenu) exportMenu.style.display = "none";
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
      const bubbleWidth = Math.round(bubble.getBoundingClientRect().width);
      if (bubbleWidth > 0) {
        wrapper.classList.add("llm-user-context-aligned");
        wrapper.style.setProperty(
          "--llm-user-bubble-width",
          `${bubbleWidth}px`,
        );
      }
    }
  }

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
