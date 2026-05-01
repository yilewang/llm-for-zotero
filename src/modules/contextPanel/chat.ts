import { renderMarkdown, renderMarkdownForNote } from "../../utils/markdown";
import { getWelcomeHtml, getWebChatWelcomeHtml, getStandaloneLibraryChatStartPageHtml, getPaperChatStartPageHtml, getNoteEditingStartPageHtml } from "../../utils/i18n";
import {
  appendMessage as appendStoredMessage,
  clearConversation as clearStoredConversation,
  loadConversation,
  pruneConversation,
  updateLatestUserMessage as updateStoredLatestUserMessage,
  updateLatestAssistantMessage as updateStoredLatestAssistantMessage,
  deleteTurnMessages as deleteStoredTurnMessages,
  StoredChatMessage,
} from "../../utils/chatStore";
import { loadClaudeConversation } from "../../claudeCode/store";
import {
  appendCodexMessage,
  deleteCodexTurnMessages,
  loadCodexConversation,
  pruneCodexConversation,
  updateLatestCodexAssistantMessage,
  updateLatestCodexUserMessage,
} from "../../codexAppServer/store";
import {
  getClaudeAutoCompactThresholdPercent,
  isClaudeAutoCompactEnabled,
} from "../../claudeCode/prefs";
import {
  appendClaudeConversationMessage,
  buildClaudeScope,
  captureClaudeSessionInfo,
  deleteClaudeConversationTurnMessages,
  getClaudeBridgeRuntime,
  isClaudeConversationSystemActive,
  updateLatestClaudeConversationAssistantMessage,
  updateLatestClaudeConversationUserMessage,
} from "../../claudeCode/runtime";
import { isClaudeConversationKey } from "../../claudeCode/constants";
import { isCodexConversationKey } from "../../codexAppServer/constants";
import {
  getCodexReasoningModePref,
  getCodexRuntimeModelPref,
  isCodexAppServerModeEnabled,
} from "../../codexAppServer/prefs";
import {
  callLLMStream,
  ChatFileAttachment,
  ChatMessage,
  getRuntimeReasoningOptions,
  prepareChatRequest,
  ReasoningConfig as LLMReasoningConfig,
  ReasoningEvent,
  ReasoningLevel as LLMReasoningLevel,
  UsageStats,
  checkEmbeddingAvailability,
} from "../../utils/llmClient";
import {
  estimateConversationTokens,
  getModelInputTokenLimit,
} from "../../utils/modelInputCap";
import { formatDisplayModelName } from "../../utils/modelDisplayLabel";
import type { ProviderProtocol } from "../../utils/providerProtocol";
import {
  PERSISTED_HISTORY_LIMIT,
  AUTO_SCROLL_BOTTOM_THRESHOLD,
  MAX_SELECTED_IMAGES,
  formatFigureCountLabel,
  formatPaperCountLabel,
} from "./constants";
import type { ConversationSystem } from "../../shared/types";
import { hasCachedMineruMd, getMineruItemDir } from "./mineruCache";
import type {
  Message,
  ChatRuntimeMode,
  ReasoningProviderKind,
  ReasoningOption,
  ReasoningLevelSelection,
  AdvancedModelParams,
  ChatAttachment,
  CollectionContextRef,
  NoteContextRef,
  SelectedTextContext,
  SelectedTextSource,
  PaperContextRef,
  PaperContextSendMode,
  ContextAssemblyStrategy,
} from "./types";
import {
  chatHistory,
  loadedConversationKeys,
  loadingConversationTasks,
  selectedModelCache,
  selectedReasoningCache,
  selectedImageCache,
  selectedFileAttachmentCache,
  selectedPaperContextCache,
  selectedCollectionContextCache,
  paperContextModeOverrides,
  activeContextPanels,
  activeContextPanelStateSync,
  getCancelledRequestId,
  getAbortController,
  setAbortController,
  nextRequestId,
  isRequestPending,
  setPendingRequestId,
  setResponseMenuTarget,
  setPromptMenuTarget,
  inlineEditTarget,
  setInlineEditTarget,
  inlineEditCleanup,
  setInlineEditCleanup,
  inlineEditInputSectionEl,
  inlineEditInputSectionParent,
  inlineEditInputSectionNextSib,
  inlineEditSavedDraft,
  setInlineEditInputSection,
  setInlineEditSavedDraft,
  selectedRuntimeModeCache,
  pdfTextCache,
} from "./state";
import {
  agentRunTraceCache,
  agentRunTraceLoadingTasks,
} from "./agentState";
import {
  sanitizeText,
  formatTime,
  setStatus,
  setTokenUsage,
  getSelectedTextWithinBubble,
  getAttachmentTypeLabel,
  buildQuestionWithSelectedTextContexts,
  buildModelPromptWithFileContext,
  getSelectedTextSourceIcon,
  resolvePromptText,
} from "./textUtils";
import {
  buildCodexAppServerAttachmentBlockMessage,
  getBlockedCodexAppServerChatAttachments,
  shouldApplyCodexAppServerChatAttachmentPolicy,
} from "./codexAppServerAttachmentPolicy";
import {
  normalizeSelectedTextNoteContexts,
  normalizeSelectedTextPaperContexts as normalizeSelectedTextPaperContextEntries,
  normalizeSelectedTextSources,
  normalizePaperContextRefs,
  normalizeCollectionContextRefs,
  normalizeAttachmentContentHash,
} from "./normalizers";
import { positionMenuAtPointer } from "./menuPositioning";
import {
  getAvailableModelEntries,
  getAdvancedModelParamsForEntry,
  getLastReasoningExpanded,
  getLastUsedReasoningLevel,
  getSelectedModelEntryForItem,
  getBoolPref,
  getStringPref,
  setLastReasoningExpanded,
} from "./prefHelpers";
import { resolveMultiContextPlan } from "./multiContextPlanner";
import { resolveContextImages, buildImageResolver } from "./mineruImages";
import {
  formatPaperCitationLabel,
  resolvePaperContextRefFromAttachment,
  resolvePaperContextRefFromItem,
} from "./paperAttribution";
import { buildPaperKey } from "./pdfContext";
import { isTextOnlyModel } from "../../providers/modelChecks";
import {
  getActiveContextAttachmentFromTabs,
  resolveContextSourceItem,
  setSelectedTextContextEntries,
} from "./contextResolution";
import {
  isGlobalPortalItem,
  resolveActiveNoteSession,
  resolveConversationBaseItem,
  resolveConversationSystemForItem,
  resolveDisplayConversationKind,
} from "./portalScope";
import { buildChatHistoryNotePayload } from "./notes";
import { readNoteSnapshot } from "./noteSnapshot";
import { extractManagedBlobHash } from "./attachmentStorage";
import { buildContextPlanSystemMessages } from "./requestSystemMessages";
import { canEditUserPromptTurn } from "./editability";
import { renderAgentTrace } from "./agentTrace/render";
import { toFileUrl } from "../../utils/pathFileUrl";
import { replaceOwnerAttachmentRefs } from "../../utils/attachmentRefStore";
import { decorateAssistantCitationLinks } from "./assistantCitationLinks";
import {
  getMessageCitationPaperContexts,
  mergeCitationPaperContexts,
} from "./citationContexts";
import { getCoreAgentRuntime } from "../../agent/index";
import { getClaudeReasoningModePref } from "../../claudeCode/prefs";
import { getAgentRunTrace } from "../../agent/store/traceStore";
import {
  applyHistoryCompression,
  scheduleLLMSummary,
  clearConversationSummary,
} from "./conversationSummaryCache";
import type {
  AgentRunEventRecord,
  AgentRuntimeRequest,
} from "../../agent/types";
import {
  sendAgentTurn,
  retryAgentTurn,
  type AgentEngineDeps,
} from "./agentMode/agentEngine";
import {
  buildQueuedFollowUpThreadKey,
  scheduleQueuedFollowUpDrainForThread,
  SCHEDULE_QUEUED_FOLLOW_UP_DRAIN_PROPERTY,
  SCHEDULE_QUEUED_FOLLOW_UP_THREAD_DRAIN_PROPERTY,
} from "./queuedFollowUps";
import { getConversationKey } from "./conversationIdentity";

export { getConversationKey } from "./conversationIdentity";

/** Get AbortController constructor from global scope */
function getAbortControllerCtor(): new () => AbortController {
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
  if (!base) return chunk;
  const startsWithTightPunctuation = /^[,.;:!?%)}\]"'’”]/.test(chunk);
  const needsSpacer =
    !startsWithTightPunctuation &&
    !(/[\s\n]$/.test(base) || /^[\s\n]/.test(chunk));
  return needsSpacer ? `${base} ${chunk}` : `${base}${chunk}`;
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
  if (looksLikeSizeOrTokenIssue) {
    if (imageCount >= 8) {
      return " Try fewer screenshots (for example 4-6) or tighter crops.";
    }
    return " Try fewer screenshots or tighter crops.";
  }
  const looksLikeVisionRejection =
    normalized.includes("model_not_supported") ||
    normalized.includes("does not support") ||
    normalized.includes("not support image") ||
    normalized.includes("not support vision") ||
    normalized.includes("unsupported_media_type") ||
    normalized.includes("invalid_type") ||
    (normalized.includes("invalid_request") && normalized.includes("image")) ||
    (normalized.includes("400") && normalized.includes("not supported"));
  if (looksLikeVisionRejection) {
    return " This model may not support image/file input. Try removing attachments or switching to text mode.";
  }
  return "";
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
  return normalizeSelectedTextPaperContextEntries(
    selectedTextPaperContexts,
    count,
    {
      sanitizeText,
    },
  );
}

function normalizeSelectedTextNoteContextsByIndex(
  selectedTextNoteContexts: unknown,
  count: number,
): (NoteContextRef | undefined)[] {
  return normalizeSelectedTextNoteContexts(selectedTextNoteContexts, count, {
    sanitizeText,
  });
}

function normalizePaperContexts(paperContexts: unknown): PaperContextRef[] {
  return normalizePaperContextRefs(paperContexts, { sanitizeText });
}

function normalizeCollectionContexts(
  collectionContexts: unknown,
): CollectionContextRef[] {
  return normalizeCollectionContextRefs(collectionContexts, { sanitizeText });
}

function resolveAutoLoadedPaperContextForItem(
  item: Zotero.Item,
): PaperContextRef | null {
  const activeNoteSession = resolveActiveNoteSession(item);
  if (activeNoteSession?.noteKind === "standalone") {
    return null;
  }
  if (activeNoteSession?.noteKind === "item" && activeNoteSession.parentItemId) {
    const parentItem = Zotero.Items.get(activeNoteSession.parentItemId) || null;
    if (!parentItem?.isRegularItem?.()) return null;
    const activeContextItem = getActiveContextAttachmentFromTabs();
    if (activeContextItem?.parentID === activeNoteSession.parentItemId) {
      return resolvePaperContextRefFromAttachment(activeContextItem);
    }
    return resolvePaperContextRefFromItem(parentItem);
  }
  if (resolveDisplayConversationKind(item) === "global") {
    return null;
  }
  const contextSource = resolveContextSourceItem(item);
  return resolvePaperContextRefFromAttachment(contextSource.contextItem);
}

function buildActiveNoteContextBlock(
  item: Zotero.Item | null | undefined,
): string {
  // Inject whenever a note session is active — regardless of whether the user
  // has selected any text in the editor. The note-edit selection entries are
  // still shown as individual "Editing" snippets; this block always provides
  // the full note content as base context.
  if (!resolveActiveNoteSession(item)) {
    return "";
  }
  const snapshot = readNoteSnapshot(item);
  if (!snapshot || !snapshot.text.trim()) {
    return snapshot
      ? [
          "Current active Zotero note:",
          `Title: ${snapshot.title}`,
          "Note content is currently empty.",
        ].join("\n")
      : "";
  }
  const parentLine = snapshot.parentItemId
    ? `Parent item ID: ${snapshot.parentItemId}`
    : "Standalone note";
  return [
    "Current active Zotero note:",
    `Title: ${snapshot.title}`,
    parentLine,
    "Note content:",
    `"""\n${snapshot.text}\n"""`,
  ].join("\n");
}

function collectRecentPaperContexts(history: Message[]): PaperContextRef[] {
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (!message || message.role !== "user") continue;
    const contexts = getMessageCitationPaperContexts(message);
    for (const context of contexts) {
      const key = `${context.itemId}:${context.contextItemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(context);
    }
  }
  return out;
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

/**
 * Renders user bubble content, detecting `/command` prefixes and showing them
 * as inline badges for visual consistency with the input compose area.
 */
function renderUserBubbleContent(
  bubble: HTMLElement,
  text: string,
  doc: Document,
): void {
  const match = text.match(/^\/(\S+)(\s[\s\S]*)?$/);
  if (match) {
    const badge = doc.createElement("span");
    badge.className = "llm-command-badge";
    badge.textContent = `/${match[1]}`;
    bubble.appendChild(badge);
    const rest = (match[2] || "").trim();
    if (rest) {
      bubble.appendChild(doc.createTextNode(` ${rest}`));
    }
  } else {
    bubble.textContent = text;
  }
}

function looksLikeStreamingMarkdownTable(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index];
    const next = lines[index + 1];
    if (!line.startsWith("|")) continue;
    if (!next?.startsWith("|")) continue;
    if (next === "|" || /^\|?[\s:-]+(?:\|[\s:-]+)*\|?$/.test(next)) {
      return true;
    }
    if (line.includes("|") && next.includes("|")) {
      return true;
    }
  }
  return false;
}

function attachRenderedCopyButtons(root: ParentNode, doc: Document): void {
  const copyables = Array.from(
    root.querySelectorAll(".llm-copyable[data-llm-copy-source]"),
  ) as HTMLElement[];
  for (const copyable of copyables) {
    if (copyable.classList.contains("llm-copyable-inline")) continue;
    if (!copyable.dataset.copyFeedbackBound) {
      copyable.dataset.copyFeedbackBound = "true";
      const clearCopyFeedback = () => {
        delete copyable.dataset.copyFeedback;
      };
      copyable.addEventListener("mouseleave", clearCopyFeedback);
      copyable.addEventListener("focusout", (event: FocusEvent) => {
        const next = event.relatedTarget as Node | null;
        if (!next || !copyable.contains(next)) {
          clearCopyFeedback();
        }
      });
    }
    const existing = copyable.querySelector(
      ":scope > .llm-render-copy-btn",
    ) as HTMLButtonElement | null;
    if (existing) continue;
    const button = doc.createElement("button") as HTMLButtonElement;
    button.type = "button";
    button.className = "llm-render-copy-btn";
    button.textContent = "⧉";
    button.title = "Copy original markdown";
    button.setAttribute("aria-label", "Copy original markdown");
    copyable.insertBefore(button, copyable.firstChild);
  }
}

const ASSISTANT_RESPONSE_CONTEXT_MENU_SUPPRESS_SELECTOR = [
  ".llm-action-inline-card",
  ".llm-agent-hitl-card",
  "button",
  "input",
  "textarea",
  "select",
  "option",
  "summary",
  "[role='button']",
  "[contenteditable='true']",
].join(",");

export function shouldSuppressAssistantResponseContextMenu(
  target: EventTarget | null,
): boolean {
  const maybeElement = target as Element | null;
  if (!maybeElement || typeof maybeElement.closest !== "function") {
    return false;
  }
  return Boolean(
    maybeElement.closest(ASSISTANT_RESPONSE_CONTEXT_MENU_SUPPRESS_SELECTOR),
  );
}

export function shouldAttachAssistantResponseContextMenu(
  message: Pick<Message, "text">,
): boolean {
  return Boolean(sanitizeText(message.text || "").trim());
}

export function shouldDecorateInterleavedAgentTraceCitations(params: {
  agentTraceEl: Element | null;
  agentUsesInterleavedText: boolean;
  streaming?: boolean;
}): boolean {
  return Boolean(
    params.agentTraceEl &&
      params.agentUsesInterleavedText &&
      !params.streaming,
  );
}

function attachAssistantResponseContextMenu(params: {
  body: Element;
  doc: Document;
  bubble: HTMLElement;
  item: Zotero.Item;
  message: Message;
  pairedUserMessage: Message | null;
  conversationKey: number;
}): void {
  const {
    body,
    doc,
    bubble,
    item,
    message,
    pairedUserMessage,
    conversationKey,
  } = params;
  if (!shouldAttachAssistantResponseContextMenu(message)) return;

  bubble.addEventListener("contextmenu", (e: Event) => {
    if (shouldSuppressAssistantResponseContextMenu(e.target)) return;
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
    const responseMenuDeleteBtn = responseMenu?.querySelector(
      "#llm-response-menu-delete",
    ) as HTMLButtonElement | null;
    const canDeleteResponseTurn = Boolean(
      pairedUserMessage?.role === "user" && !message.streaming,
    );
    if (!responseMenu) return;
    if (responseMenuDeleteBtn) {
      responseMenuDeleteBtn.disabled = !canDeleteResponseTurn;
    }
    if (exportMenu) exportMenu.style.display = "none";
    if (promptMenu) promptMenu.style.display = "none";
    if (retryModelMenu) {
      retryModelMenu.classList.remove("llm-model-menu-open");
      retryModelMenu.style.display = "none";
    }
    setPromptMenuTarget(null);
    // If the user has text selected within this bubble, extract just that
    // portion. Otherwise fall back to the full raw markdown source.
    const selectedText = getSelectedTextWithinBubble(doc, bubble);
    const fullMarkdown = sanitizeText(message.text || "").trim();
    const contentText = selectedText || fullMarkdown;
    if (!contentText) return;
    setResponseMenuTarget({
      item,
      contentText,
      modelName: message.modelName?.trim() || "unknown",
      conversationKey,
      userTimestamp:
        pairedUserMessage?.role === "user"
          ? Math.floor(pairedUserMessage.timestamp)
          : 0,
      assistantTimestamp: Math.floor(message.timestamp),
      paperContexts:
        pairedUserMessage?.role === "user"
          ? getMessageCitationPaperContexts(pairedUserMessage)
          : undefined,
    });
    positionMenuAtPointer(body, responseMenu, me.clientX, me.clientY);
  });
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

/** Cumulative API token usage per conversation key for the current session. */
const sessionTokenTotals = new Map<number, number>();
const contextUsageSnapshots = new Map<number, { contextTokens: number; contextWindow?: number }>();
function getContextInputWindow(effectiveRequestConfig: EffectiveRequestConfig): number | undefined {
  const advancedCap = effectiveRequestConfig.advanced?.inputTokenCap;
  if (typeof advancedCap === "number" && Number.isFinite(advancedCap) && advancedCap > 0) {
    return advancedCap;
  }
  return getModelInputTokenLimit(effectiveRequestConfig.model || "");
}

function accumulateSessionTokens(
  conversationKey: number,
  delta: number,
): number {
  const prev = sessionTokenTotals.get(conversationKey) ?? 0;
  const next = prev + delta;
  sessionTokenTotals.set(conversationKey, next);
  return next;
}

/**
 * Seed the session token total from the existing chat history if it hasn't
 * been set yet in this Zotero session. Returns the seeded (or existing) total.
 */
function getOrSeedSessionTokens(
  conversationKey: number,
  history: Message[],
): number {
  if (sessionTokenTotals.has(conversationKey)) {
    return sessionTokenTotals.get(conversationKey)!;
  }
  if (history.length === 0) {
    sessionTokenTotals.set(conversationKey, 0);
    return 0;
  }
  const estimated = estimateConversationTokens(
    history.map((m) => ({ role: m.role, content: m.text || "" })),
  );
  sessionTokenTotals.set(conversationKey, estimated);
  return estimated;
}

export function getSessionTokenTotal(conversationKey: number): number {
  return sessionTokenTotals.get(conversationKey) ?? 0;
}

export function resetSessionTokens(conversationKey: number): void {
  sessionTokenTotals.delete(conversationKey);
}

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

async function loadStoredConversationByKey(
  conversationKey: number,
  limit: number,
): Promise<StoredChatMessage[]> {
  return isClaudeConversationKey(conversationKey)
    ? loadClaudeConversation(conversationKey, limit)
    : isCodexConversationKey(conversationKey)
      ? loadCodexConversation(conversationKey, limit)
    : loadConversation(conversationKey, limit);
}

async function updateStoredLatestUserMessageByConversation(
  conversationKey: number,
  message: Parameters<typeof updateStoredLatestUserMessage>[1],
): Promise<void> {
  if (isClaudeConversationKey(conversationKey)) {
    await updateLatestClaudeConversationUserMessage(conversationKey, message);
    return;
  }
  if (isCodexConversationKey(conversationKey)) {
    await updateLatestCodexUserMessage(conversationKey, message);
    return;
  }
  await updateStoredLatestUserMessage(conversationKey, message);
}

async function updateStoredLatestAssistantMessageByConversation(
  conversationKey: number,
  message: Parameters<typeof updateStoredLatestAssistantMessage>[1],
): Promise<void> {
  if (isClaudeConversationKey(conversationKey)) {
    const latestContextSnapshot = contextUsageSnapshots.get(conversationKey);
    await updateLatestClaudeConversationAssistantMessage(conversationKey, {
      ...message,
      contextTokens:
        Number.isFinite(Number(message.contextTokens)) && Number(message.contextTokens) > 0
          ? Math.floor(Number(message.contextTokens))
          : latestContextSnapshot?.contextTokens,
      contextWindow:
        Number.isFinite(Number(message.contextWindow)) && Number(message.contextWindow) > 0
          ? Math.floor(Number(message.contextWindow))
          : latestContextSnapshot?.contextWindow,
    });
    return;
  }
  if (isCodexConversationKey(conversationKey)) {
    const latestContextSnapshot = contextUsageSnapshots.get(conversationKey);
    await updateLatestCodexAssistantMessage(conversationKey, {
      ...message,
      contextTokens:
        Number.isFinite(Number(message.contextTokens)) && Number(message.contextTokens) > 0
          ? Math.floor(Number(message.contextTokens))
          : latestContextSnapshot?.contextTokens,
      contextWindow:
        Number.isFinite(Number(message.contextWindow)) && Number(message.contextWindow) > 0
          ? Math.floor(Number(message.contextWindow))
          : latestContextSnapshot?.contextWindow,
    });
    return;
  }
  await updateStoredLatestAssistantMessage(conversationKey, message);
}

async function persistConversationMessage(
  conversationKey: number,
  message: StoredChatMessage,
): Promise<void> {
  try {
    if (isClaudeConversationKey(conversationKey)) {
      await appendClaudeConversationMessage(conversationKey, message);
    } else if (isCodexConversationKey(conversationKey)) {
      await appendCodexMessage(conversationKey, message);
      await pruneCodexConversation(conversationKey, PERSISTED_HISTORY_LIMIT);
    } else {
      await appendStoredMessage(conversationKey, message);
      await pruneConversation(conversationKey, PERSISTED_HISTORY_LIMIT);
    }
    const storedMessages = await loadStoredConversationByKey(
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
  const selectedTextNoteContexts = normalizeSelectedTextNoteContextsByIndex(
    (message as Message).selectedTextNoteContexts,
    selectedTexts.length,
  );
  const paperContexts = normalizePaperContexts(message.paperContexts);
  const fullTextPaperContexts = normalizePaperContexts(
    message.fullTextPaperContexts,
  );
  const selectedCollectionContexts = normalizeCollectionContexts(
    message.selectedCollectionContexts,
  );
  return {
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
    runMode: message.runMode,
    agentRunId: message.agentRunId,
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
    selectedTextNoteContexts: selectedTextNoteContexts.some((entry) =>
      Boolean(entry),
    )
      ? selectedTextNoteContexts
      : undefined,
    selectedTextExpandedIndex: -1,
    paperContexts: paperContexts.length ? paperContexts : undefined,
    fullTextPaperContexts: fullTextPaperContexts.length
      ? fullTextPaperContexts
      : undefined,
    selectedCollectionContexts: selectedCollectionContexts.length
      ? selectedCollectionContexts
      : undefined,
    paperContextsExpanded: false,
    screenshotImages,
    attachments,
    attachmentsExpanded: false,
    screenshotExpanded: false,
    screenshotActiveIndex: screenshotImages?.length ? 0 : undefined,
    modelName: message.modelName,
    modelEntryId: message.modelEntryId,
    modelProviderLabel: message.modelProviderLabel,
    reasoningSummary: message.reasoningSummary,
    reasoningDetails: message.reasoningDetails,
    reasoningOpen: isReasoningExpandedByDefault(),
    compactMarker: Boolean((message as StoredChatMessage).compactMarker),
    webchatRunState: message.webchatRunState,
    webchatCompletionReason: message.webchatCompletionReason,
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
      const storedMessages = await loadStoredConversationByKey(
        conversationKey,
        PERSISTED_HISTORY_LIMIT,
      );
      const panelMessages = storedMessages.map((message) => toPanelMessage(message));
      const latestAssistantWithContext = [...storedMessages]
        .reverse()
        .find((message) => message.role === "assistant" && typeof message.contextTokens === "number");
      if (latestAssistantWithContext?.contextTokens) {
        contextUsageSnapshots.set(conversationKey, {
          contextTokens: latestAssistantWithContext.contextTokens,
          contextWindow: latestAssistantWithContext.contextWindow,
        });
      }
      chatHistory.set(conversationKey, panelMessages);
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

async function ensureAgentRunTraceLoaded(
  runId: string | undefined,
  body?: Element,
  item?: Zotero.Item | null,
): Promise<void> {
  const normalizedRunId = (runId || "").trim();
  if (!normalizedRunId || agentRunTraceCache.has(normalizedRunId)) return;
  const existing = agentRunTraceLoadingTasks.get(normalizedRunId);
  if (existing) {
    await existing;
    return;
  }
  const task = (async () => {
    try {
      const trace = await getAgentRunTrace(normalizedRunId);
      agentRunTraceCache.set(normalizedRunId, trace.events);
    } catch (err) {
      ztoolkit.log("LLM: Failed to load agent run trace", err);
    } finally {
      agentRunTraceLoadingTasks.delete(normalizedRunId);
      if (body && item) {
        refreshChat(body, item);
      }
    }
  })();
  agentRunTraceLoadingTasks.set(normalizedRunId, task);
  await task;
}

function getCachedAgentRunEvents(runId: string | undefined): AgentRunEventRecord[] {
  const normalizedRunId = (runId || "").trim();
  if (!normalizedRunId) return [];
  return agentRunTraceCache.get(normalizedRunId) || [];
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

export type PanelRequestUI = {
  inputBox: HTMLTextAreaElement | null;
  chatBox: HTMLDivElement | null;
  sendBtn: HTMLButtonElement | null;
  cancelBtn: HTMLButtonElement | null;
  status: HTMLElement | null;
  tokenUsageEl: HTMLElement | null;
};

function getPanelRequestUI(body: Element): PanelRequestUI {
  return {
    inputBox: body.querySelector("#llm-input") as HTMLTextAreaElement | null,
    chatBox: body.querySelector("#llm-chat-box") as HTMLDivElement | null,
    sendBtn: body.querySelector("#llm-send") as HTMLButtonElement | null,
    cancelBtn: body.querySelector("#llm-cancel") as HTMLButtonElement | null,
    status: body.querySelector("#llm-status") as HTMLElement | null,
    tokenUsageEl: body.querySelector("#llm-token-usage") as HTMLElement | null,
  };
}

function isPanelWebChatMode(body: Element): boolean {
  return (
    (body.querySelector("#llm-main") as HTMLElement | null)?.dataset
      ?.webchatMode === "true"
  );
}

type QueuedInputDrainScope = {
  conversationSystem?: ConversationSystem | string | null;
  conversationKey?: number | null;
  webChatActive?: boolean;
};

function normalizeQueuedInputConversationSystem(
  value: ConversationSystem | string | null | undefined,
): ConversationSystem {
  return value === "claude_code" || value === "codex" ? value : "upstream";
}

function scheduleQueuedInputDrain(
  body: Element,
  scope?: QueuedInputDrainScope,
): void {
  if (scope) {
    const threadKey = buildQueuedFollowUpThreadKey({
      conversationSystem: normalizeQueuedInputConversationSystem(
        scope.conversationSystem,
      ),
      conversationKey: scope.conversationKey ?? null,
      webChatActive: scope.webChatActive === true,
    });
    if (threadKey) {
      scheduleQueuedFollowUpDrainForThread(threadKey);
      return;
    }
    if (scope.webChatActive) return;
  }
  const threadSchedule = (body as unknown as Record<string, unknown>)[
    SCHEDULE_QUEUED_FOLLOW_UP_THREAD_DRAIN_PROPERTY
  ];
  const schedule = (body as unknown as Record<string, unknown>)[
    SCHEDULE_QUEUED_FOLLOW_UP_DRAIN_PROPERTY
  ];
  if (typeof threadSchedule === "function") {
    (threadSchedule as () => void)();
    return;
  }
  if (typeof schedule === "function") {
    (schedule as () => void)();
  }
}

function setRequestUIBusy(
  body: Element,
  ui: PanelRequestUI,
  conversationKey: number,
  statusText: string,
): void {
  withScrollGuard(ui.chatBox, conversationKey, () => {
    if (ui.sendBtn) {
      ui.sendBtn.style.display = "none";
      ui.sendBtn.disabled = false;
    }
    if (ui.cancelBtn) ui.cancelBtn.style.display = "";
    if (ui.inputBox) {
      ui.inputBox.disabled = isPanelWebChatMode(body);
    }
    if (ui.status) setStatus(ui.status, statusText, "sending");
  });
  // History controls are intentionally left enabled so the user can
  // switch conversations or create new ones while a request is in flight.
}

function restoreRequestUIIdle(
  body: Element,
  conversationKey: number,
  requestId: number,
): void {
  if (getCancelledRequestId(conversationKey) >= requestId) return;
  // Guard: only restore UI if the panel is still showing this conversation.
  // If the user switched away, the panel rebuild (onAsyncRender) will handle
  // the correct idle/busy state for the new conversation.
  const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
  if (panelRoot) {
    const displayedKey = Number(panelRoot.dataset.itemId || 0);
    if (displayedKey > 0 && displayedKey !== conversationKey) return;
  }
  // Re-query the DOM at restore time: buildUI() wipes body.textContent when the
  // user navigates to a new item while streaming, making any previously-captured
  // ui references point to detached (removed) elements.  Querying from the
  // stable `body` container always returns the current live elements.
  const freshUi = getPanelRequestUI(body);
  withScrollGuard(freshUi.chatBox, conversationKey, () => {
    if (freshUi.inputBox) {
      freshUi.inputBox.disabled = false;
      freshUi.inputBox.focus({ preventScroll: true });
    }
    if (freshUi.sendBtn) {
      freshUi.sendBtn.style.display = "";
      freshUi.sendBtn.disabled = false;
    }
    if (freshUi.cancelBtn) freshUi.cancelBtn.style.display = "none";
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
    // Guard: only refresh if the panel is still showing this conversation.
    // When the user switches conversations mid-stream, the panel's dataset
    // changes but the streaming closure still references the old body/item.
    // Without this check the streamed content would overwrite the new
    // conversation's display.
    const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
    if (panelRoot) {
      const displayedKey = Number(panelRoot.dataset.itemId || 0);
      if (displayedKey > 0 && displayedKey !== conversationKey) return;
    }
    refreshConversationPanels(body, item);
  };
  const setStatusSafely = (
    text: string,
    kind: Parameters<typeof setStatus>[2],
  ) => {
    if (!ui.status) return;
    // Same guard for status updates.
    const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
    if (panelRoot) {
      const displayedKey = Number(panelRoot.dataset.itemId || 0);
      if (displayedKey > 0 && displayedKey !== conversationKey) return;
    }
    withScrollGuard(ui.chatBox, conversationKey, () => {
      setStatus(ui.status as HTMLElement, text, kind);
    });
  };
  return {
    refreshChatSafely,
    setStatusSafely,
  };
}

export type EffectiveRequestConfig = {
  model: string;
  apiBase: string;
  apiKey: string;
  authMode:
    | "api_key"
    | "codex_auth"
    | "codex_app_server"
    | "copilot_auth"
    | "webchat";
  providerProtocol?: ProviderProtocol;
  modelEntryId?: string;
  modelProviderLabel?: string;
  reasoning: LLMReasoningConfig | undefined;
  advanced: AdvancedModelParams | undefined;
};

function isCodexAppServerConversationRequest(params: {
  item: Zotero.Item;
  authMode?: "api_key" | "codex_auth" | "codex_app_server" | "copilot_auth" | "webchat";
  providerProtocol?: ProviderProtocol;
  modelProviderLabel?: string;
}): boolean {
  if (!isCodexAppServerModeEnabled()) return false;
  if (resolveConversationSystemForItem(params.item) === "codex") return true;
  return (
    params.authMode === "codex_app_server" ||
    (params.modelProviderLabel === "Codex" &&
      params.providerProtocol === "codex_responses")
  );
}

function resolveEffectiveConversationSystem(params: {
  item: Zotero.Item;
  authMode?: "api_key" | "codex_auth" | "codex_app_server" | "copilot_auth" | "webchat";
  providerProtocol?: ProviderProtocol;
  modelProviderLabel?: string;
}): ConversationSystem {
  const itemSystem = resolveConversationSystemForItem(params.item);
  if (itemSystem) return itemSystem;
  if (isCodexAppServerConversationRequest(params)) return "codex";
  if (
    params.modelProviderLabel === "Claude Code" &&
    !resolveActiveNoteSession(params.item)
  ) {
    return "claude_code";
  }
  return "upstream";
}

function resolveEffectiveRequestConfig(params: {
  item: Zotero.Item;
  model?: string;
  apiBase?: string;
  apiKey?: string;
  authMode?: "api_key" | "codex_auth" | "codex_app_server" | "copilot_auth" | "webchat";
  providerProtocol?: ProviderProtocol;
  modelEntryId?: string;
  modelProviderLabel?: string;
  reasoning?: LLMReasoningConfig;
  advanced?: AdvancedModelParams;
}): EffectiveRequestConfig {
  if (
    isCodexAppServerConversationRequest(params)
  ) {
    const model = (params.model || getCodexRuntimeModelPref()).trim() || "gpt-5.4";
    const reasoningMode = getCodexReasoningModePref();
    const reasoning = params.reasoning ||
      (reasoningMode === "auto"
        ? undefined
        : {
            provider: "openai" as const,
            level: reasoningMode,
          });
    return {
      model,
      apiBase: (params.apiBase ?? "").trim(),
      apiKey: "",
      authMode: "codex_app_server",
      providerProtocol: "codex_responses",
      modelEntryId: params.modelEntryId || `codex_app_server::${model}`,
      modelProviderLabel: "Codex",
      reasoning,
      advanced: params.advanced,
    };
  }

  const hasExplicitProviderMetadata = Boolean(
    params.modelProviderLabel ||
      params.providerProtocol ||
      params.authMode ||
      params.modelEntryId,
  );
  const fallbackEntry = hasExplicitProviderMetadata
    ? null
    : getSelectedModelEntryForItem(params.item.id);
  const explicitEntry =
    hasExplicitProviderMetadata && params.modelProviderLabel === "Claude Code"
      ? {
          entryId:
            params.modelEntryId ||
            `claude_runtime::${(params.model || "sonnet").trim() || "sonnet"}`,
          model: (params.model || "sonnet").trim() || "sonnet",
          apiBase: params.apiBase ?? "",
          apiKey: params.apiKey ?? "",
          authMode: params.authMode || "api_key",
          providerProtocol:
            params.providerProtocol || "anthropic_messages",
          providerLabel: params.modelProviderLabel,
          advanced: params.advanced,
        }
      : params.model || params.apiBase || params.apiKey
        ? getAvailableModelEntries().find(
            (entry) =>
              entry.model === (params.model || "").trim() &&
              entry.apiBase === (params.apiBase || "").trim() &&
              entry.apiKey === (params.apiKey || "").trim(),
          ) || null
        : null;
  const model = (
    params.model ||
    explicitEntry?.model ||
    fallbackEntry?.model ||
    getStringPref("modelPrimary") ||
    getStringPref("model") ||
    "gpt-4o-mini"
  ).trim();
  const apiBase = (
    params.apiBase !== undefined
      ? params.apiBase
      : explicitEntry?.apiBase || fallbackEntry?.apiBase || ""
  ).trim();
  const apiKey = (
    params.apiKey !== undefined
      ? params.apiKey
      : explicitEntry?.apiKey || fallbackEntry?.apiKey || ""
  ).trim();
  const authMode =
    params.authMode ||
    explicitEntry?.authMode ||
    (fallbackEntry?.authMode === "webchat"
      ? "webchat"
      : fallbackEntry?.authMode === "codex_auth"
        ? "codex_auth"
        : fallbackEntry?.authMode === "codex_app_server"
          ? "codex_app_server"
          : fallbackEntry?.authMode === "copilot_auth"
            ? "copilot_auth"
            : "api_key");
  const reasoning =
    params.reasoning ||
    getSelectedReasoningForItem(params.item.id, model, apiBase);
  const advanced =
    params.advanced || explicitEntry?.advanced || fallbackEntry?.advanced;
  return {
    model,
    apiBase,
    apiKey,
    authMode,
    providerProtocol:
      params.providerProtocol ||
      explicitEntry?.providerProtocol ||
      fallbackEntry?.providerProtocol,
    modelEntryId:
      params.modelEntryId || explicitEntry?.entryId || fallbackEntry?.entryId,
    modelProviderLabel:
      params.modelProviderLabel ||
      explicitEntry?.providerLabel ||
      fallbackEntry?.providerLabel,
    reasoning,
    advanced,
  };
}

async function buildContextPlanForRequest(params: {
  item: Zotero.Item;
  question: string;
  images?: string[];
  selectedTextSources?: SelectedTextSource[];
  paperContexts: PaperContextRef[];
  fullTextPaperContexts: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
  recentPaperContexts: PaperContextRef[];
  history: ChatMessage[];
  effectiveRequestConfig: EffectiveRequestConfig;
  pdfModePaperKeys?: Set<string>;
  pdfUploadSystemMessages?: string[];
  signal?: AbortSignal;
  setStatusSafely: (
    text: string,
    kind: Parameters<typeof setStatus>[2],
  ) => void;
}): Promise<{
  combinedContext: string;
  strategy: ContextAssemblyStrategy;
  assistantInstruction?: string;
  paperContexts: PaperContextRef[];
  fullTextPaperContexts: PaperContextRef[];
  citationPaperContexts: PaperContextRef[];
  recentPaperContexts: PaperContextRef[];
  mineruImages: string[];
}> {
  const contextSource = resolveContextSourceItem(params.item);
  params.setStatusSafely(contextSource.statusText, "sending");
  const rawActiveContextItem = contextSource.contextItem;
  // If the active paper is in PDF mode (sent as file attachment),
  // exclude it from the text retrieval pipeline entirely.
  const activeContextItemInPdfMode = (() => {
    if (!rawActiveContextItem || !params.pdfModePaperKeys?.size) return false;
    const autoLoaded = resolveAutoLoadedPaperContextForItem(params.item);
    if (!autoLoaded) return false;
    return params.pdfModePaperKeys.has(`${autoLoaded.itemId}:${autoLoaded.contextItemId}`);
  })();
  const activeContextItem = activeContextItemInPdfMode ? null : rawActiveContextItem;
  const conversationMode: "open" | "paper" =
    resolveDisplayConversationKind(params.item) === "global"
      ? "open"
      : "paper";
  const systemPrompt = getStringPref("systemPrompt") || undefined;

  const plan = await resolveMultiContextPlan({
    activeContextItem,
    conversationMode,
    question: params.question,
    contextPrefix: "",
    // Exclude PDF-mode papers from the text retrieval pipeline
    paperContexts: params.pdfModePaperKeys?.size
      ? params.paperContexts.filter((p) => !params.pdfModePaperKeys!.has(`${p.itemId}:${p.contextItemId}`))
      : params.paperContexts,
    fullTextPaperContexts: params.fullTextPaperContexts,
    collectionContexts: params.selectedCollectionContexts,
    historyPaperContexts: params.recentPaperContexts,
    history: params.history,
    images: params.images,
    model: params.effectiveRequestConfig.model,
    reasoning: params.effectiveRequestConfig.reasoning,
    advanced: params.effectiveRequestConfig.advanced,
    apiBase: params.effectiveRequestConfig.apiBase,
    apiKey: params.effectiveRequestConfig.apiKey,
    providerProtocol: params.effectiveRequestConfig.providerProtocol,
    systemPrompt,
    signal: params.signal,
  });

  if (plan.selectedPaperCount > 0) {
    const semanticEnabled = getBoolPref("enableSemanticSearch", false);
    const semanticTag =
      plan.mode === "retrieval" &&
      semanticEnabled &&
      checkEmbeddingAvailability()
        ? " + semantic search"
        : "";
    const modeStatus =
      plan.strategy === "paper-first-full"
        ? "Using full paper text (first turn)"
        : plan.strategy === "paper-followup-retrieval"
          ? `Retrieval${semanticTag} (${plan.selectedChunkCount} chunks)`
          : plan.mode === "full"
            ? `Using full context (${plan.selectedPaperCount} papers)`
            : `Retrieval${semanticTag} (${plan.selectedPaperCount} papers, ${plan.selectedChunkCount} chunks)`;
    params.setStatusSafely(modeStatus, "sending");
  }
  ztoolkit.log("LLM: Multi-context plan", {
    mode: plan.mode,
    strategy: plan.strategy,
    selectedPaperCount: plan.selectedPaperCount,
    selectedChunkCount: plan.selectedChunkCount,
    contextBudgetTokens: plan.contextBudget.contextBudgetTokens,
    usedContextTokens: plan.usedContextTokens,
  });
  const noteContext = buildActiveNoteContextBlock(
    params.item,
  ).trim();
  const planContext = sanitizeText(plan.contextText || "").trim();
  // Include provider-uploaded PDF content (Qwen fileid://, Kimi extracted text)
  const uploadedPdfContext = (params.pdfUploadSystemMessages || [])
    .map((msg) => sanitizeText(msg).trim())
    .filter(Boolean)
    .join("\n\n");
  const combinedContext = [noteContext, planContext, uploadedPdfContext].filter(Boolean).join("\n\n");

  // Extract MinerU figure images from the context (if applicable).
  // Skip for text-only models (e.g. DeepSeek) that reject image_url content.
  const effectiveModel = params.effectiveRequestConfig.model || "";
  let mineruImages: string[] = [];
  if (planContext && !isTextOnlyModel(effectiveModel)) {
    // Collect all MinerU-cached attachment IDs from context papers
    const mineruAttachmentIds: number[] = [];
    if (activeContextItem) {
      const activePdfCtx = pdfTextCache.get(activeContextItem.id);
      if (activePdfCtx?.sourceType === "mineru") {
        mineruAttachmentIds.push(activeContextItem.id);
      }
    }
    // Also include @-referenced papers with MinerU cache
    for (const paper of [...params.paperContexts, ...params.fullTextPaperContexts]) {
      if (paper.contextItemId && !mineruAttachmentIds.includes(paper.contextItemId)) {
        const pdfCtx = pdfTextCache.get(paper.contextItemId);
        if (pdfCtx?.sourceType === "mineru") {
          mineruAttachmentIds.push(paper.contextItemId);
        }
      }
    }
    // Resolve images from all MinerU papers (cap total at 5)
    for (const attachmentId of mineruAttachmentIds) {
      if (mineruImages.length >= 5) break;
      try {
        const images = await resolveContextImages({
          contextText: planContext,
          attachmentId,
          maxImages: 5 - mineruImages.length,
        });
        mineruImages.push(...images);
      } catch (err) {
        ztoolkit.log("LLM: MinerU figure resolution failed (best-effort)", err);
      }
    }
  }

  return {
    combinedContext,
    strategy: plan.strategy,
    assistantInstruction: plan.assistantInstruction,
    paperContexts: params.paperContexts,
    fullTextPaperContexts: params.fullTextPaperContexts,
    citationPaperContexts: mergeCitationPaperContexts(
      params.paperContexts,
      params.fullTextPaperContexts,
      plan.citationPaperContexts,
    ),
    recentPaperContexts: params.recentPaperContexts,
    mineruImages,
  };
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

function waitForUiStep(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const ROSE_LOADER_SVG_NS = "http://www.w3.org/2000/svg";

function mountClaudeRoseThreeLoader(host: HTMLElement, startedAt: number): void {
  const doc = host.ownerDocument;
  if (!doc) return;
  const win = doc.defaultView;
  if (!win) return;

  const svg = doc.createElementNS(ROSE_LOADER_SVG_NS, "svg") as unknown as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("llm-rose-loader-svg");

  const group = doc.createElementNS(ROSE_LOADER_SVG_NS, "g") as unknown as SVGGElement;
  const path = doc.createElementNS(ROSE_LOADER_SVG_NS, "path") as unknown as SVGPathElement;
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("stroke-width", "4.4");
  path.setAttribute("opacity", "0.1");
  group.appendChild(path);

  const particleCount = 85;
  const trailSpan = 0.34;
  const durationMs = 4600;
  const rotationDurationMs = 28000;
  const pulseDurationMs = 4200;
  const spiralR = 5.0;
  const spiralr = 1.0;
  const spiralScale = 2.2;
  const spiralBreath = 0.45;
  const spirald = 3.0;
  const particles = Array.from({ length: particleCount }, () => {
    const circle = doc.createElementNS(ROSE_LOADER_SVG_NS, "circle") as unknown as SVGCircleElement;
    circle.setAttribute("fill", "currentColor");
    group.appendChild(circle);
    return circle;
  });

  svg.appendChild(group);
  host.replaceChildren(svg);

  const normalizeProgress = (progress: number) => ((progress % 1) + 1) % 1;
  const getDetailScale = (elapsedMs: number) => {
    const pulseProgress = (elapsedMs % pulseDurationMs) / pulseDurationMs;
    const pulseAngle = pulseProgress * Math.PI * 2;
    return 0.52 + ((Math.sin(pulseAngle + 0.55) + 1) / 2) * 0.48;
  };
  const getRotation = (elapsedMs: number) =>
    -((elapsedMs % rotationDurationMs) / rotationDurationMs) * 360;
  const getPoint = (progress: number, detailScale: number) => {
    const t = progress * Math.PI * 2;
    const d = spirald + detailScale * 0.25;
    const baseX =
      (spiralR - spiralr) * Math.cos(t) +
      d * Math.cos(((spiralR - spiralr) / spiralr) * t);
    const baseY =
      (spiralR - spiralr) * Math.sin(t) -
      d * Math.sin(((spiralR - spiralr) / spiralr) * t);
    const scale = spiralScale + detailScale * spiralBreath;
    return {
      x: 50 + baseX * scale,
      y: 50 + baseY * scale,
    };
  };
  const buildPath = (detailScale: number, steps = 480) => {
    let d = "";
    for (let index = 0; index <= steps; index += 1) {
      const point = getPoint(index / steps, detailScale);
      d += `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)} `;
    }
    return d.trim();
  };

  let rafId = 0;
  const render = () => {
    if (!host.isConnected) {
      if (rafId) win.cancelAnimationFrame(rafId);
      return;
    }
    const elapsedMs = Date.now() - startedAt;
    const progress = (elapsedMs % durationMs) / durationMs;
    const detailScale = getDetailScale(elapsedMs);
    group.setAttribute("transform", `rotate(${getRotation(elapsedMs).toFixed(3)} 50 50)`);
    path.setAttribute("d", buildPath(detailScale));
    for (let index = 0; index < particles.length; index += 1) {
      const tailOffset = index / Math.max(1, particleCount - 1);
      const point = getPoint(
        normalizeProgress(progress - tailOffset * trailSpan),
        detailScale,
      );
      const fade = Math.pow(1 - tailOffset, 0.56);
      const particle = particles[index]!;
      particle.setAttribute("cx", point.x.toFixed(2));
      particle.setAttribute("cy", point.y.toFixed(2));
      particle.setAttribute("r", (0.9 + fade * 2.7).toFixed(2));
      particle.setAttribute("opacity", (0.04 + fade * 0.96).toFixed(3));
    }
    rafId = win.requestAnimationFrame(render);
  };

  rafId = win.requestAnimationFrame(render);
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
  | "modelEntryId"
  | "modelProviderLabel"
  | "pendingAgentTraceEvents"
  | "reasoningSummary"
  | "reasoningDetails"
  | "reasoningOpen"
  | "webchatRunState"
  | "webchatCompletionReason"
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
    modelEntryId: message.modelEntryId,
    modelProviderLabel: message.modelProviderLabel,
    pendingAgentTraceEvents: message.pendingAgentTraceEvents
      ? message.pendingAgentTraceEvents.map((entry) => ({ ...entry, payload: { ...entry.payload } }))
      : undefined,
    reasoningSummary: message.reasoningSummary,
    reasoningDetails: message.reasoningDetails,
    reasoningOpen: message.reasoningOpen,
    webchatRunState: message.webchatRunState,
    webchatCompletionReason: message.webchatCompletionReason,
  };
}

function restoreAssistantSnapshot(
  message: Message,
  snapshot: AssistantMessageSnapshot,
): void {
  message.text = snapshot.text;
  message.timestamp = snapshot.timestamp;
  message.modelName = snapshot.modelName;
  message.modelEntryId = snapshot.modelEntryId;
  message.modelProviderLabel = snapshot.modelProviderLabel;
  message.pendingAgentTraceEvents = snapshot.pendingAgentTraceEvents
    ? snapshot.pendingAgentTraceEvents.map((entry) => ({ ...entry, payload: { ...entry.payload } }))
    : undefined;
  message.reasoningSummary = snapshot.reasoningSummary;
  message.reasoningDetails = snapshot.reasoningDetails;
  message.reasoningOpen = snapshot.reasoningOpen;
  message.webchatRunState = snapshot.webchatRunState;
  message.webchatCompletionReason = snapshot.webchatCompletionReason;
  message.streaming = false;
}

function finalizeCancelledAssistantMessage(
  message: Message,
  fallbackText = "[Cancelled]",
): void {
  const text = sanitizeText(message.text || "");
  const reasoningSummary = sanitizeText(message.reasoningSummary || "");
  const reasoningDetails = sanitizeText(message.reasoningDetails || "");
  const hasReasoning = Boolean(reasoningSummary || reasoningDetails);

  message.text = text || fallbackText;
  message.timestamp = Date.now();
  message.reasoningSummary = reasoningSummary || undefined;
  message.reasoningDetails = reasoningDetails || undefined;
  message.reasoningOpen = hasReasoning
    ? message.reasoningOpen !== false
    : false;
  message.pendingAgentTraceEvents = undefined;
  message.streaming = false;
  message.webchatRunState = undefined;
  message.webchatCompletionReason = null;
}

function applyWebChatAnswerSnapshot(
  message: Message,
  text: string,
  snapshot: {
    runState?: "submitted" | "active" | "settling" | "done" | "incomplete" | "error" | null;
    completionReason?: "settled" | "forced_cancel" | "timeout" | "error" | null;
    remoteChatUrl?: string | null;
    remoteChatId?: string | null;
  },
): void {
  message.text = sanitizeText(text || "");
  message.timestamp = Date.now();
  // [webchat] Capture chat URL from streaming snapshots so it's available for refresh
  if (snapshot.remoteChatUrl) message.webchatChatUrl = snapshot.remoteChatUrl;
  if (snapshot.remoteChatId) message.webchatChatId = snapshot.remoteChatId;
  if (
    snapshot.runState === "done" ||
    snapshot.runState === "incomplete" ||
    snapshot.runState === "error"
  ) {
    message.webchatRunState = snapshot.runState;
    message.webchatCompletionReason = snapshot.completionReason || null;
  } else {
    message.webchatRunState = undefined;
    message.webchatCompletionReason = null;
  }
}

function applyWebChatThinkingSnapshot(
  message: Message,
  text: string,
  snapshot: {
    runState?: "submitted" | "active" | "settling" | "done" | "incomplete" | "error" | null;
    completionReason?: "settled" | "forced_cancel" | "timeout" | "error" | null;
  },
): void {
  const sanitized = sanitizeText(text || "");
  message.reasoningDetails = sanitized || undefined;
  message.reasoningOpen = sanitized ? isReasoningExpandedByDefault() : false;
  if (
    snapshot.runState === "done" ||
    snapshot.runState === "incomplete" ||
    snapshot.runState === "error"
  ) {
    message.webchatRunState = snapshot.runState;
    message.webchatCompletionReason = snapshot.completionReason || null;
  }
}

function getWebChatRunStateLabel(message: Message): string | null {
  if (message.webchatRunState === "incomplete") {
    switch (message.webchatCompletionReason) {
      case "forced_cancel":
        return "Partial only — chat stayed busy and needed a forced stop";
      case "timeout":
        return "Partial only — final answer was not verified before timeout";
      case "error":
      default:
        return "Partial only — final answer not verified";
    }
  }
  if (message.webchatRunState === "error") {
    return "Web sync ended with an error";
  }
  return null;
}

function reconstructRetryPayload(userMessage: Message): {
  question: string;
  screenshotImages: string[];
  attachments: ChatAttachment[];
  paperContexts: PaperContextRef[];
  fullTextPaperContexts: PaperContextRef[];
  selectedCollectionContexts: CollectionContextRef[];
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
  const fileAttachments = normalizeEditableAttachments(userMessage.attachments);
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
  const fullTextPaperContexts = normalizePaperContexts(
    userMessage.fullTextPaperContexts || userMessage.pinnedPaperContexts,
  );
  const selectedCollectionContexts = normalizeCollectionContexts(
    userMessage.selectedCollectionContexts,
  );
  return {
    question,
    screenshotImages,
    attachments: fileAttachments,
    paperContexts,
    fullTextPaperContexts,
    selectedCollectionContexts,
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
  options?: {
    authMode?: string;
    runtimeMode?: ChatRuntimeMode;
  },
): ChatFileAttachment[] {
  if (
    shouldApplyCodexAppServerChatAttachmentPolicy({
      authMode: options?.authMode,
      runtimeMode: options?.runtimeMode,
    })
  ) {
    return [];
  }
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

/**
 * Derive paper keys that are being sent as PDF file attachments (native or page images).
 * These papers should be excluded from the text retrieval pipeline to avoid double-processing.
 */
function derivePdfModePaperKeys(
  attachments: ChatAttachment[] | undefined,
  item: Zotero.Item,
): Set<string> {
  const keys = new Set<string>();
  if (!Array.isArray(attachments)) return keys;
  for (const a of attachments) {
    if (typeof a?.id !== "string") continue;
    const m = a.id.match(/^pdf-(?:paper|page)-(\d+)-/);
    if (!m) continue;
    const contextItemId = Number(m[1]);
    if (!Number.isFinite(contextItemId) || contextItemId <= 0) continue;
    const autoLoaded = resolveAutoLoadedPaperContextForItem(item);
    if (autoLoaded && autoLoaded.contextItemId === contextItemId) {
      keys.add(`${autoLoaded.itemId}:${autoLoaded.contextItemId}`);
    }
  }
  return keys;
}

function normalizeEditableFullTextPaperContexts(
  fullTextPaperContexts?: PaperContextRef[],
): PaperContextRef[] {
  return normalizePaperContexts(fullTextPaperContexts);
}

function includeAutoLoadedPaperContext(
  item: Zotero.Item,
  paperContexts?: PaperContextRef[],
  fullTextPaperContexts?: PaperContextRef[],
  excludePaperKeys?: Set<string>,
): {
  paperContexts: PaperContextRef[];
  fullTextPaperContexts: PaperContextRef[];
} {
  const normalizedPaperContexts = normalizePaperContexts(paperContexts);
  const normalizedFullTextPaperContexts = normalizePaperContexts(
    fullTextPaperContexts,
  );
  if (resolveDisplayConversationKind(item) === "global") {
    return {
      paperContexts: normalizedPaperContexts,
      fullTextPaperContexts:
        fullTextPaperContexts === undefined
          ? normalizedPaperContexts
          : normalizedFullTextPaperContexts,
    };
  }
  const autoLoadedPaperContext = resolveAutoLoadedPaperContextForItem(item);
  if (!autoLoadedPaperContext) {
    return {
      paperContexts: normalizedPaperContexts,
      fullTextPaperContexts: normalizedFullTextPaperContexts,
    };
  }
  // Always include auto-loaded paper in paperContexts (for display in chat history).
  // Only add to fullTextPaperContexts if NOT in PDF mode.
  const autoKey = `${autoLoadedPaperContext.itemId}:${autoLoadedPaperContext.contextItemId}`;
  const isExcludedFromTextPipeline = excludePaperKeys?.has(autoKey) === true;
  return {
    paperContexts: normalizePaperContexts([
      autoLoadedPaperContext,
      ...normalizedPaperContexts,
    ]),
    fullTextPaperContexts:
      isExcludedFromTextPipeline
        ? normalizedFullTextPaperContexts
        : fullTextPaperContexts === undefined
          ? normalizePaperContexts([
              autoLoadedPaperContext,
              ...normalizedFullTextPaperContexts,
            ])
          : normalizedFullTextPaperContexts,
  };
}

function syncComposeContextForInlineEdit(
  body: Element,
  item: Zotero.Item,
  userMessage: Message,
): void {
  const conversationKey = getConversationKey(item);
  const selectedTexts = getMessageSelectedTexts(userMessage);
  const selectedTextSources = normalizeSelectedTextSources(
    userMessage.selectedTextSources,
    selectedTexts.length,
  );
  const selectedTextPaperContexts = normalizeSelectedTextPaperContextsByIndex(
    userMessage.selectedTextPaperContexts,
    selectedTexts.length,
  );
  const selectedTextNoteContexts = normalizeSelectedTextNoteContextsByIndex(
    userMessage.selectedTextNoteContexts,
    selectedTexts.length,
  );
  const selectedTextEntries: SelectedTextContext[] = selectedTexts.map(
    (text, index) => ({
      text,
      source: selectedTextSources[index] || "pdf",
      paperContext: selectedTextPaperContexts[index],
      noteContext: selectedTextNoteContexts[index],
    }),
  );
  setSelectedTextContextEntries(conversationKey, selectedTextEntries);

  const screenshotImages = Array.isArray(userMessage.screenshotImages)
    ? userMessage.screenshotImages
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, MAX_SELECTED_IMAGES)
    : [];
  if (screenshotImages.length) {
    selectedImageCache.set(item.id, screenshotImages);
  } else {
    selectedImageCache.delete(item.id);
  }

  const fileAttachments = normalizeEditableAttachments(userMessage.attachments);
  if (fileAttachments.length) {
    selectedFileAttachmentCache.set(item.id, fileAttachments);
  } else {
    selectedFileAttachmentCache.delete(item.id);
  }

  const paperContexts = normalizePaperContexts(userMessage.paperContexts);
  const fullTextPaperContexts = normalizePaperContexts(
    userMessage.fullTextPaperContexts || userMessage.pinnedPaperContexts,
  );
  const autoLoadedPaperContext = resolveAutoLoadedPaperContextForItem(item);
  const selectedPaperContexts = autoLoadedPaperContext
    ? paperContexts.filter(
        (paperContext) =>
          !(
            paperContext.itemId === autoLoadedPaperContext.itemId &&
            paperContext.contextItemId === autoLoadedPaperContext.contextItemId
          ),
      )
    : paperContexts;
  if (selectedPaperContexts.length) {
    selectedPaperContextCache.set(item.id, selectedPaperContexts);
  } else {
    selectedPaperContextCache.delete(item.id);
  }
  const selectedCollectionContexts = normalizeCollectionContexts(
    userMessage.selectedCollectionContexts,
  );
  if (selectedCollectionContexts.length) {
    selectedCollectionContextCache.set(item.id, selectedCollectionContexts);
  } else {
    selectedCollectionContextCache.delete(item.id);
  }
  // Clear existing mode overrides for this item, then set full-next for each full-text paper
  const modePrefix = `${item.id}:`;
  for (const key of Array.from(paperContextModeOverrides.keys())) {
    if (key.startsWith(modePrefix)) paperContextModeOverrides.delete(key);
  }
  for (const paperContext of fullTextPaperContexts) {
    paperContextModeOverrides.set(`${item.id}:${buildPaperKey(paperContext)}`, "full-next");
  }

  activeContextPanelStateSync.get(body)?.();
}

export async function editLatestUserMessageAndRetry(
  opts: import("./types").EditRetryOptions,
): Promise<EditLatestTurnResult> {
  const {
    body, item, displayQuestion, selectedTexts, selectedTextSources,
    selectedTextPaperContexts, selectedTextNoteContexts, screenshotImages,
    paperContexts, fullTextPaperContexts, selectedCollectionContexts, attachments,
    pdfUploadSystemMessages,
    targetRuntimeMode,
    expected, model, apiBase, apiKey, authMode, providerProtocol,
    modelEntryId, modelProviderLabel, reasoning, advanced,
  } = opts;
  await ensureConversationLoaded(item);
  const conversationKey = getConversationKey(item);
  const history = chatHistory.get(conversationKey) || [];
  const retryPair = findLatestRetryPair(history);
  if (!retryPair) return "missing";
  if (retryPair.assistantMessage.streaming) return "stale";
  const retryRuntimeMode: ChatRuntimeMode =
    targetRuntimeMode ||
    (retryPair.assistantMessage.runMode === "agent" ? "agent" : "chat");
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
  const selectedTextNoteContextsForMessage =
    normalizeSelectedTextNoteContextsByIndex(
      selectedTextNoteContexts,
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
  const normalizedPaperContexts = normalizeEditablePaperContexts(paperContexts);
  const normalizedFullTextPaperContexts =
    normalizeEditableFullTextPaperContexts(fullTextPaperContexts);
  const selectedCollectionContextsForMessage =
    normalizeCollectionContexts(selectedCollectionContexts);
  const pdfExcludeKeys = derivePdfModePaperKeys(attachments, item);
  const {
    paperContexts: paperContextsForMessage,
    fullTextPaperContexts: fullTextPaperContextsForMessage,
  } = includeAutoLoadedPaperContext(
    item,
    normalizedPaperContexts,
    normalizedFullTextPaperContexts,
    pdfExcludeKeys.size > 0 ? pdfExcludeKeys : undefined,
  );
  const attachmentsForMessage = normalizeEditableAttachments(attachments);
  const updatedTimestamp = Date.now();
  const nextDisplayQuestion = sanitizeText(displayQuestion || "");

  retryPair.userMessage.text = nextDisplayQuestion;
  retryPair.userMessage.timestamp = updatedTimestamp;
  retryPair.userMessage.runMode = retryRuntimeMode;
  retryPair.userMessage.agentRunId = undefined;
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
  retryPair.userMessage.selectedTextNoteContexts =
    selectedTextNoteContextsForMessage.some((entry) => Boolean(entry))
      ? selectedTextNoteContextsForMessage
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
  retryPair.userMessage.fullTextPaperContexts =
    fullTextPaperContextsForMessage.length
      ? fullTextPaperContextsForMessage
      : undefined;
  retryPair.userMessage.citationPaperContexts = mergeCitationPaperContexts(
    retryPair.userMessage.selectedTextPaperContexts,
    paperContextsForMessage,
    fullTextPaperContextsForMessage,
  );
  retryPair.userMessage.selectedCollectionContexts =
    selectedCollectionContextsForMessage.length
      ? selectedCollectionContextsForMessage
      : undefined;
  retryPair.userMessage.paperContextsExpanded = false;
  retryPair.userMessage.attachments = attachmentsForMessage.length
    ? attachmentsForMessage
    : undefined;
  retryPair.userMessage.attachmentsExpanded = false;
  retryPair.userMessage.attachmentActiveIndex = undefined;

  try {
    await updateStoredLatestUserMessageByConversation(conversationKey, {
      text: retryPair.userMessage.text,
      timestamp: retryPair.userMessage.timestamp,
      runMode: retryPair.userMessage.runMode,
      agentRunId: retryPair.userMessage.agentRunId,
      selectedText: retryPair.userMessage.selectedText,
      selectedTexts: retryPair.userMessage.selectedTexts,
      selectedTextSources: retryPair.userMessage.selectedTextSources,
      selectedTextPaperContexts:
        retryPair.userMessage.selectedTextPaperContexts,
      screenshotImages: retryPair.userMessage.screenshotImages,
      paperContexts: retryPair.userMessage.paperContexts,
      fullTextPaperContexts: retryPair.userMessage.fullTextPaperContexts,
      citationPaperContexts: retryPair.userMessage.citationPaperContexts,
      selectedCollectionContexts:
        retryPair.userMessage.selectedCollectionContexts,
      attachments: retryPair.userMessage.attachments,
    });

    const storedMessages = await loadStoredConversationByKey(
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

  if (retryRuntimeMode === "agent") {
    await retryLatestAgentResponse(
      body,
      item,
      model,
      apiBase,
      apiKey,
      authMode,
      providerProtocol,
      modelEntryId,
      modelProviderLabel,
      reasoning,
      advanced,
    );
  } else {
    await retryLatestAssistantResponse(
      body,
      item,
      model,
      apiBase,
      apiKey,
      authMode,
      providerProtocol,
      modelEntryId,
      modelProviderLabel,
      reasoning,
      advanced,
      pdfUploadSystemMessages,
    );
  }
  return "ok";
}

export async function retryLatestAssistantResponse(
  body: Element,
  item: Zotero.Item,
  model?: string,
  apiBase?: string,
  apiKey?: string,
  authMode?: "api_key" | "codex_auth" | "codex_app_server" | "copilot_auth" | "webchat",
  providerProtocol?: ProviderProtocol,
  modelEntryId?: string,
  modelProviderLabel?: string,
  reasoning?: LLMReasoningConfig,
  advanced?: AdvancedModelParams,
  pdfUploadSystemMessages?: string[],
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
  setPendingRequestId(conversationKey, thisRequestId);
  setRequestUIBusy(body, ui, conversationKey, "Preparing retry...");
  const assistantMessage = retryPair.assistantMessage;
  const assistantSnapshot = takeAssistantSnapshot(assistantMessage);
  assistantMessage.text = "";
  assistantMessage.reasoningSummary = undefined;
  assistantMessage.reasoningDetails = undefined;
  assistantMessage.reasoningOpen = isReasoningExpandedByDefault();
  assistantMessage.runMode = "chat";
  assistantMessage.agentRunId = undefined;
  assistantMessage.streaming = true;
  const effectiveRequestConfig = resolveEffectiveRequestConfig({
    item,
    model,
    apiBase,
    apiKey,
    authMode,
    providerProtocol,
    modelEntryId,
    modelProviderLabel,
    reasoning,
    advanced,
  });
  assistantMessage.modelName = effectiveRequestConfig.model;
  assistantMessage.modelEntryId = effectiveRequestConfig.modelEntryId;
  assistantMessage.modelProviderLabel =
    effectiveRequestConfig.modelProviderLabel;
  assistantMessage.waitingAnimationStartedAt =
    assistantMessage.modelProviderLabel === "Claude Code" ||
    assistantMessage.modelProviderLabel === "Codex"
      ? Date.now()
      : undefined;
  const { refreshChatSafely, setStatusSafely } = createPanelUpdateHelpers(
    body,
    item,
    conversationKey,
    ui,
  );

  const historyForLLM = history.slice(0, retryPair.userIndex);
  const {
    question,
    screenshotImages,
    attachments,
    paperContexts,
    fullTextPaperContexts,
    selectedCollectionContexts,
  } = reconstructRetryPayload(retryPair.userMessage);
  if (!question.trim()) {
    setStatusSafely("Nothing to retry for latest turn", "error");
    restoreRequestUIIdle(body, conversationKey, thisRequestId);
    return;
  }

  refreshChatSafely();
  let streamedAnswer = "";
  let streamedReasoningSummary: string | undefined;
  let streamedReasoningDetails: string | undefined;

  const restoreOriginalAssistant = () => {
    restoreAssistantSnapshot(assistantMessage, assistantSnapshot);
    refreshChatSafely();
  };
  const finalizeCancelledAssistant = async () => {
    finalizeCancelledAssistantMessage(assistantMessage);
    refreshChatSafely();
    const latestContextSnapshot = contextUsageSnapshots.get(conversationKey);
    await updateStoredLatestAssistantMessageByConversation(conversationKey, {
      text: assistantMessage.text,
      timestamp: assistantMessage.timestamp,
      runMode: assistantMessage.runMode,
      agentRunId: assistantMessage.agentRunId,
      modelName: assistantMessage.modelName,
      modelEntryId: assistantMessage.modelEntryId,
      modelProviderLabel: assistantMessage.modelProviderLabel,
      reasoningSummary: assistantMessage.reasoningSummary,
      reasoningDetails: assistantMessage.reasoningDetails,
      compactMarker: assistantMessage.compactMarker,
      contextTokens: latestContextSnapshot?.contextTokens,
      contextWindow: latestContextSnapshot?.contextWindow,
    });
    setStatusSafely("Cancelled", "ready");
  };
  if (
    shouldApplyCodexAppServerChatAttachmentPolicy({
      authMode: effectiveRequestConfig.authMode,
      runtimeMode: "chat",
    })
  ) {
    const blockedAttachments =
      getBlockedCodexAppServerChatAttachments(attachments);
    if (blockedAttachments.length) {
      restoreOriginalAssistant();
      restoreRequestUIIdle(body, conversationKey, thisRequestId);
      setStatusSafely(
        buildCodexAppServerAttachmentBlockMessage(blockedAttachments),
        "error",
      );
      return;
    }
  }
  const requestFileAttachments = normalizeModelFileAttachments(attachments, {
    authMode: effectiveRequestConfig.authMode,
    runtimeMode: "chat",
  });

  try {
    const llmHistory = buildLLMHistoryMessages(historyForLLM);
    const recentPaperContexts = collectRecentPaperContexts(historyForLLM);
    const retryPdfKeys = derivePdfModePaperKeys(retryPair.userMessage.attachments, item);

    // Create AbortController early so the signal is available during context
    // planning.
    const AbortControllerCtor = getAbortControllerCtor();
    setAbortController(
      conversationKey,
      AbortControllerCtor ? new AbortControllerCtor() : null,
    );

    const contextPlan = await buildContextPlanForRequest({
      item,
      question,
      images: screenshotImages,
      selectedTextSources: retryPair.userMessage.selectedTextSources,
      paperContexts,
      fullTextPaperContexts,
      selectedCollectionContexts,
      recentPaperContexts,
      history: llmHistory,
      effectiveRequestConfig,
      pdfModePaperKeys: retryPdfKeys.size > 0 ? retryPdfKeys : undefined,
      pdfUploadSystemMessages,
      signal: getAbortController(conversationKey)?.signal,
      setStatusSafely,
    });
    let combinedContext = contextPlan.combinedContext;
    retryPair.userMessage.paperContexts = contextPlan.paperContexts.length
      ? contextPlan.paperContexts
      : undefined;
    retryPair.userMessage.fullTextPaperContexts =
      contextPlan.fullTextPaperContexts.length
        ? contextPlan.fullTextPaperContexts
      : undefined;
    retryPair.userMessage.citationPaperContexts = mergeCitationPaperContexts(
      retryPair.userMessage.selectedTextPaperContexts,
      contextPlan.citationPaperContexts,
    );
    retryPair.userMessage.selectedCollectionContexts =
      selectedCollectionContexts.length ? selectedCollectionContexts : undefined;
    await updateStoredLatestUserMessageByConversation(conversationKey, {
      text: retryPair.userMessage.text,
      timestamp: retryPair.userMessage.timestamp,
      runMode: retryPair.userMessage.runMode,
      agentRunId: retryPair.userMessage.agentRunId,
      selectedText: retryPair.userMessage.selectedText,
      selectedTexts: retryPair.userMessage.selectedTexts,
      selectedTextSources: retryPair.userMessage.selectedTextSources,
      selectedTextPaperContexts:
        retryPair.userMessage.selectedTextPaperContexts,
      screenshotImages: retryPair.userMessage.screenshotImages,
      paperContexts: retryPair.userMessage.paperContexts,
      fullTextPaperContexts: retryPair.userMessage.fullTextPaperContexts,
      citationPaperContexts: retryPair.userMessage.citationPaperContexts,
      selectedCollectionContexts:
        retryPair.userMessage.selectedCollectionContexts,
      attachments: retryPair.userMessage.attachments,
    });
    if (getCancelledRequestId(conversationKey) >= thisRequestId) {
      getAbortController(conversationKey)?.abort();
      await finalizeCancelledAssistant();
      return;
    }

    const queueRefresh = createQueuedRefresh(refreshChatSafely);
    if (getCancelledRequestId(conversationKey) >= thisRequestId) {
      getAbortController(conversationKey)?.abort();
      await finalizeCancelledAssistant();
      return;
    }

    // Text-only models (e.g. DeepSeek) reject image_url content — drop all images.
    const allImages = isTextOnlyModel(effectiveRequestConfig.model || "")
      ? []
      : [...(screenshotImages || []), ...(contextPlan.mineruImages || [])];
    const requestParams = {
      prompt: question,
      context: combinedContext,
      history: llmHistory,
      signal: getAbortController(conversationKey)?.signal,
      images: allImages.length ? allImages : undefined,
      attachments: requestFileAttachments,
      model: effectiveRequestConfig.model,
      apiBase: effectiveRequestConfig.apiBase,
      apiKey: effectiveRequestConfig.apiKey,
      authMode: effectiveRequestConfig.authMode,
      providerProtocol: effectiveRequestConfig.providerProtocol,
      reasoning: effectiveRequestConfig.reasoning,
      temperature: effectiveRequestConfig.advanced?.temperature,
      maxTokens: effectiveRequestConfig.advanced?.maxTokens,
      inputTokenCap: effectiveRequestConfig.advanced?.inputTokenCap,
    };
    const previewSystemMessages = buildContextPlanSystemMessages({
      strategy: contextPlan.strategy,
      assistantInstruction: contextPlan.assistantInstruction,
    });
    const preview = prepareChatRequest({
      ...requestParams,
      systemMessages: previewSystemMessages,
    });
    const systemMessages = buildContextPlanSystemMessages({
      strategy: contextPlan.strategy,
      assistantInstruction: contextPlan.assistantInstruction,
      inputCapEffects: preview.inputCap.effects,
    });

    const answer = await callLLMStream(
      {
        ...requestParams,
        systemMessages,
      },
      (delta) => {
        const chunk = sanitizeText(delta);
        if (!chunk) return;
        streamedAnswer += chunk;
        assistantMessage.text += chunk;
        queueRefresh();
      },
      (reasoningEvent: ReasoningEvent) => {
        if (reasoningEvent.summary) {
          assistantMessage.reasoningSummary = appendReasoningPart(
            assistantMessage.reasoningSummary,
            reasoningEvent.summary,
          );
          streamedReasoningSummary = assistantMessage.reasoningSummary;
        }
        if (reasoningEvent.details) {
          assistantMessage.reasoningDetails = appendReasoningPart(
            assistantMessage.reasoningDetails,
            reasoningEvent.details,
          );
          streamedReasoningDetails = assistantMessage.reasoningDetails;
        }
        queueRefresh();
      },
      (usage: UsageStats) => {
        const total = accumulateSessionTokens(
          conversationKey,
          usage.totalTokens,
        );
        const contextWindow =
          resolveConversationSystemForItem(item) === "claude_code"
            ? getContextInputWindow(effectiveRequestConfig)
            : undefined;
        contextUsageSnapshots.set(conversationKey, {
          contextTokens: total,
          contextWindow,
        });
        if (ui.tokenUsageEl) {
          setTokenUsage(
            ui.tokenUsageEl,
            total,
            contextWindow,
            body.querySelector("#llm-claude-context-gauge") as HTMLElement | null,
          );
        }
      },
    );

    if (
      getCancelledRequestId(conversationKey) >= thisRequestId ||
      Boolean(getAbortController(conversationKey)?.signal.aborted)
    ) {
      await finalizeCancelledAssistant();
      return;
    }

    assistantMessage.text =
      sanitizeText(answer) || streamedAnswer || "No response.";
    assistantMessage.timestamp = Date.now();
    assistantMessage.modelName = effectiveRequestConfig.model;
    assistantMessage.modelEntryId = effectiveRequestConfig.modelEntryId;
    assistantMessage.modelProviderLabel =
      effectiveRequestConfig.modelProviderLabel;
    assistantMessage.reasoningSummary = streamedReasoningSummary;
    assistantMessage.reasoningDetails = streamedReasoningDetails;
    assistantMessage.reasoningOpen = isReasoningExpandedByDefault();
    assistantMessage.compactMarker = /^\/compact(?:\s|$)/i.test(question.trim());
    if (assistantMessage.compactMarker && !assistantMessage.text.trim()) {
      assistantMessage.text = "Conversation compacted";
    }
    assistantMessage.streaming = false;
    refreshChatSafely();

    const latestContextSnapshot = contextUsageSnapshots.get(conversationKey);
    await updateStoredLatestAssistantMessageByConversation(conversationKey, {
      text: assistantMessage.text,
      timestamp: assistantMessage.timestamp,
      runMode: assistantMessage.runMode,
      agentRunId: assistantMessage.agentRunId,
      modelName: assistantMessage.modelName,
      modelEntryId: assistantMessage.modelEntryId,
      modelProviderLabel: assistantMessage.modelProviderLabel,
      reasoningSummary: assistantMessage.reasoningSummary,
      reasoningDetails: assistantMessage.reasoningDetails,
      compactMarker: assistantMessage.compactMarker,
      contextTokens: latestContextSnapshot?.contextTokens,
      contextWindow: latestContextSnapshot?.contextWindow,
    });

    setStatusSafely("Ready", "ready");
  } catch (err) {
    const isCancelled =
      getCancelledRequestId(conversationKey) >= thisRequestId ||
      Boolean(getAbortController(conversationKey)?.signal.aborted) ||
      (err as { name?: string }).name === "AbortError";
    if (isCancelled) {
      await finalizeCancelledAssistant();
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
    restoreRequestUIIdle(body, conversationKey, thisRequestId);
    setAbortController(conversationKey, null);
    setPendingRequestId(conversationKey, 0);
    if (effectiveRequestConfig.providerProtocol !== "web_sync") {
      scheduleQueuedInputDrain(body, {
        conversationSystem: resolveConversationSystemForItem(item) || "upstream",
        conversationKey,
      });
    }
  }
}

/**
 * Edit the user message in any turn (not just the latest) and retry.
 * Truncates all subsequent turns from memory and storage, updates the
 * user message text, then retries using the currently selected model.
 */
export async function editUserTurnAndRetry(opts: {
  body: Element;
  item: Zotero.Item;
  userTimestamp: number;
  assistantTimestamp: number;
  newText: string;
  selectedTexts?: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  selectedTextNoteContexts?: (NoteContextRef | undefined)[];
  screenshotImages?: string[];
  paperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
  attachments?: ChatAttachment[];
  pdfUploadSystemMessages?: string[];
  targetRuntimeMode?: ChatRuntimeMode;
  model?: string;
  apiBase?: string;
  apiKey?: string;
  authMode?: "api_key" | "codex_auth" | "codex_app_server" | "copilot_auth" | "webchat";
  providerProtocol?: ProviderProtocol;
  modelEntryId?: string;
  modelProviderLabel?: string;
  reasoning?: LLMReasoningConfig;
  advanced?: AdvancedModelParams;
}): Promise<void> {
  const {
    body, item, userTimestamp, assistantTimestamp, newText,
    selectedTexts, selectedTextSources, selectedTextPaperContexts,
    selectedTextNoteContexts, screenshotImages, paperContexts,
    fullTextPaperContexts, selectedCollectionContexts, attachments,
    pdfUploadSystemMessages,
    targetRuntimeMode,
    model, apiBase, apiKey, authMode, providerProtocol,
    modelEntryId, modelProviderLabel, reasoning, advanced,
  } = opts;
  await ensureConversationLoaded(item);
  const conversationKey = getConversationKey(item);
  const history = chatHistory.get(conversationKey) || [];

  const userIndex = history.findIndex(
    (m) => m.role === "user" && m.timestamp === userTimestamp,
  );
  if (userIndex < 0) {
    ztoolkit.log("LLM: editUserTurnAndRetry — user message not found");
    return;
  }
  const assistantIndex = userIndex + 1;
  if (
    assistantIndex >= history.length ||
    history[assistantIndex]?.role !== "assistant"
  ) {
    ztoolkit.log("LLM: editUserTurnAndRetry — assistant message not found");
    return;
  }
  if (history[assistantIndex]!.streaming) {
    ztoolkit.log("LLM: editUserTurnAndRetry — assistant is still streaming");
    return;
  }
  const retryRuntimeMode: ChatRuntimeMode =
    targetRuntimeMode ||
    (history[assistantIndex]?.runMode === "agent" ? "agent" : "chat");

  // Collect subsequent pairs for persistence deletion
  const subsequentPairs: Array<{ userTs: number; assistantTs: number }> = [];
  for (let i = assistantIndex + 1; i + 1 < history.length; i += 2) {
    const u = history[i];
    const a = history[i + 1];
    if (u?.role === "user" && a?.role === "assistant") {
      subsequentPairs.push({
        userTs: Math.floor(u.timestamp),
        assistantTs: Math.floor(a.timestamp),
      });
    }
  }

  // Truncate in-memory history to this pair
  history.splice(assistantIndex + 1);

  // Delete persisted subsequent turns
  for (const p of subsequentPairs) {
    try {
      if (isClaudeConversationKey(conversationKey)) {
        await deleteClaudeConversationTurnMessages(
          conversationKey,
          p.userTs,
          p.assistantTs,
        );
      } else if (isCodexConversationKey(conversationKey)) {
        await deleteCodexTurnMessages(
          conversationKey,
          p.userTs,
          p.assistantTs,
        );
      } else {
        await deleteStoredTurnMessages(conversationKey, p.userTs, p.assistantTs);
      }
    } catch (err) {
      ztoolkit.log("LLM: Failed to delete subsequent stored turn", err);
    }
  }

  // Update user message text + timestamp
  const userMsg = history[userIndex]!;
  userMsg.text = sanitizeText(newText) || newText;
  userMsg.timestamp = Date.now();
  userMsg.runMode = retryRuntimeMode;
  userMsg.agentRunId = undefined;
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
  const selectedTextNoteContextsForMessage =
    normalizeSelectedTextNoteContextsByIndex(
      selectedTextNoteContexts,
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
  const normalizedPaperContexts = normalizeEditablePaperContexts(paperContexts);
  const normalizedFullTextPaperContexts =
    normalizeEditableFullTextPaperContexts(fullTextPaperContexts);
  const selectedCollectionContextsForMessage =
    normalizeCollectionContexts(selectedCollectionContexts);
  const pdfExcludeKeysEdit = derivePdfModePaperKeys(attachments, item);
  const {
    paperContexts: paperContextsForMessage,
    fullTextPaperContexts: fullTextPaperContextsForMessage,
  } = includeAutoLoadedPaperContext(
    item,
    normalizedPaperContexts,
    normalizedFullTextPaperContexts,
    pdfExcludeKeysEdit.size > 0 ? pdfExcludeKeysEdit : undefined,
  );
  const attachmentsForMessage = normalizeEditableAttachments(attachments);
  userMsg.selectedText = selectedTextForMessage || undefined;
  userMsg.selectedTextExpanded = false;
  userMsg.selectedTexts = selectedTextsForMessage.length
    ? selectedTextsForMessage
    : undefined;
  userMsg.selectedTextSources = selectedTextSourcesForMessage.length
    ? selectedTextSourcesForMessage
    : undefined;
  userMsg.selectedTextPaperContexts = selectedTextPaperContextsForMessage.some(
    (entry) => Boolean(entry),
  )
    ? selectedTextPaperContextsForMessage
    : undefined;
  userMsg.selectedTextNoteContexts = selectedTextNoteContextsForMessage.some(
    (entry) => Boolean(entry),
  )
    ? selectedTextNoteContextsForMessage
    : undefined;
  userMsg.selectedTextExpandedIndex = -1;
  userMsg.screenshotImages = screenshotImagesForMessage.length
    ? screenshotImagesForMessage
    : undefined;
  userMsg.screenshotExpanded = false;
  userMsg.screenshotActiveIndex = screenshotImagesForMessage.length
    ? 0
    : undefined;
  userMsg.paperContexts = paperContextsForMessage.length
    ? paperContextsForMessage
    : undefined;
  userMsg.fullTextPaperContexts = fullTextPaperContextsForMessage.length
    ? fullTextPaperContextsForMessage
    : undefined;
  userMsg.selectedCollectionContexts = selectedCollectionContextsForMessage.length
    ? selectedCollectionContextsForMessage
    : undefined;
  userMsg.paperContextsExpanded = false;
  userMsg.attachments = attachmentsForMessage.length
    ? attachmentsForMessage
    : undefined;
  userMsg.attachmentsExpanded = false;
  userMsg.attachmentActiveIndex = undefined;

  // Persist the updated user message
  try {
    await updateStoredLatestUserMessageByConversation(conversationKey, {
      text: userMsg.text,
      timestamp: userMsg.timestamp,
      runMode: userMsg.runMode,
      agentRunId: userMsg.agentRunId,
      selectedText: userMsg.selectedText,
      selectedTexts: userMsg.selectedTexts,
      selectedTextSources: userMsg.selectedTextSources,
      selectedTextPaperContexts: userMsg.selectedTextPaperContexts,
      screenshotImages: userMsg.screenshotImages,
      paperContexts: userMsg.paperContexts,
      fullTextPaperContexts: userMsg.fullTextPaperContexts,
      citationPaperContexts: getMessageCitationPaperContexts(userMsg),
      selectedCollectionContexts: userMsg.selectedCollectionContexts,
      attachments: userMsg.attachments,
    });
  } catch (err) {
    ztoolkit.log("LLM: Failed to persist edited user message", err);
  }

  // Resolve current model settings and retry
  const profile = getSelectedModelEntryForItem(item.id);
  const resolvedModel = model || profile?.model;
  const resolvedApiBase = apiBase ?? profile?.apiBase;
  const resolvedApiKey = apiKey ?? profile?.apiKey;
  const resolvedAuthMode = opts.authMode ?? profile?.authMode;
  const resolvedProviderProtocol = opts.providerProtocol ?? profile?.providerProtocol;
  const resolvedModelEntryId = opts.modelEntryId ?? profile?.entryId;
  const resolvedModelProviderLabel = opts.modelProviderLabel ?? profile?.providerLabel;
  const resolvedReasoning =
    reasoning ||
    getSelectedReasoningForItem(item.id, resolvedModel || "", resolvedApiBase);
  const resolvedAdvanced =
    advanced || getAdvancedModelParamsForEntry(profile?.entryId);

  // Route agent-mode retries through the agent runtime so tools are available
  // and the old trace is properly cleared before the new run starts.
  const isAgentRetry = retryRuntimeMode === "agent";
  if (isAgentRetry) {
    await retryLatestAgentResponse(
      body,
      item,
      resolvedModel,
      resolvedApiBase,
      resolvedApiKey,
      resolvedAuthMode,
      resolvedProviderProtocol,
      resolvedModelEntryId,
      resolvedModelProviderLabel,
      resolvedReasoning,
      resolvedAdvanced,
    );
  } else {
    await retryLatestAssistantResponse(
      body,
      item,
      resolvedModel,
      resolvedApiBase,
      resolvedApiKey,
      resolvedAuthMode,
      resolvedProviderProtocol,
      resolvedModelEntryId,
      resolvedModelProviderLabel,
      resolvedReasoning,
      resolvedAdvanced,
      pdfUploadSystemMessages,
    );
  }
}

export type BuildAgentRuntimeRequestParams = {
  conversationKey: number;
  item: Zotero.Item;
  userText: string;
  selectedTexts: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  paperContexts: PaperContextRef[];
  fullTextPaperContexts: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
  attachments: ChatAttachment[] | undefined;
  screenshots: string[] | undefined;
  forcedSkillIds?: string[];
  effectiveRequestConfig: EffectiveRequestConfig;
  history: ChatMessage[];
};

function buildActiveNoteRuntimeContext(
  item: Zotero.Item,
): AgentRuntimeRequest["activeNoteContext"] {
  const noteSession = resolveActiveNoteSession(item);
  if (!noteSession) return undefined;
  const snapshot = readNoteSnapshot(item);
  if (!snapshot) return undefined;
  // Only send raw HTML when the note is a styled template (has inline
  // style= attributes).  Plain notes don't need it — noteText suffices.
  // Cap at 10 000 chars to avoid inflating the LLM prompt with heavy CSS.
  const MAX_NOTE_HTML_LEN = 10_000;
  const isStyledNote =
    snapshot.html && /<[^>]+\bstyle\s*=/i.test(snapshot.html);
  const noteHtml = isStyledNote
    ? snapshot.html.length > MAX_NOTE_HTML_LEN
      ? snapshot.html.slice(0, MAX_NOTE_HTML_LEN) + "\n[...truncated]"
      : snapshot.html
    : undefined;

  return {
    noteId: noteSession.noteId,
    title: noteSession.title,
    noteKind: noteSession.noteKind,
    parentItemId: noteSession.parentItemId,
    noteText: snapshot.text,
    noteHtml,
  };
}

async function enrichPaperContextsWithMineruCache(
  papers: PaperContextRef[] | undefined,
): Promise<PaperContextRef[] | undefined> {
  if (!papers?.length) return papers;
  const enriched: PaperContextRef[] = [];
  for (const paper of papers) {
    let mineruCacheDir: string | undefined;
    try {
      if (await hasCachedMineruMd(paper.contextItemId)) {
        mineruCacheDir = getMineruItemDir(paper.contextItemId);
      }
    } catch { /* ignore */ }
    enriched.push(mineruCacheDir ? { ...paper, mineruCacheDir } : paper);
  }
  return enriched;
}

async function buildAgentRuntimeRequest(
  params: BuildAgentRuntimeRequestParams,
): Promise<AgentRuntimeRequest> {
  const [enrichedPaperContexts, enrichedFullTextPapers] = await Promise.all([
    enrichPaperContextsWithMineruCache(params.paperContexts),
    enrichPaperContextsWithMineruCache(params.fullTextPaperContexts),
  ]);
  return {
    conversationKey: params.conversationKey,
    mode: "agent",
    userText: params.userText,
    activeItemId: params.item.id,
    selectedTexts: params.selectedTexts,
    selectedTextSources: params.selectedTextSources,
    selectedTextPaperContexts: params.selectedTextPaperContexts,
    selectedPaperContexts: enrichedPaperContexts,
    fullTextPaperContexts: enrichedFullTextPapers,
    selectedCollectionContexts: normalizeCollectionContexts(
      params.selectedCollectionContexts,
    ),
    attachments: params.attachments,
    screenshots: params.screenshots,
    forcedSkillIds: params.forcedSkillIds,
    model: params.effectiveRequestConfig.model,
    apiBase: params.effectiveRequestConfig.apiBase,
    apiKey: params.effectiveRequestConfig.apiKey,
    authMode: params.effectiveRequestConfig.authMode,
    providerProtocol: params.effectiveRequestConfig.providerProtocol,
    reasoning: params.effectiveRequestConfig.reasoning,
    claudeEffortLevel:
      typeof params.effectiveRequestConfig.reasoning?.level === "string"
        ? ((params.effectiveRequestConfig.reasoning.level === "xhigh"
            ? (getClaudeReasoningModePref() === "max" ? "max" : "xhigh")
            : params.effectiveRequestConfig.reasoning.level) as
            | "low"
            | "medium"
            | "high"
            | "xhigh"
            | "max")
        : undefined,
    advanced: params.effectiveRequestConfig.advanced,
    history: params.history,
    item: params.item,
    systemPrompt: getStringPref("systemPrompt") || undefined,
    modelProviderLabel: params.effectiveRequestConfig.modelProviderLabel,
    libraryID: params.item.libraryID,
    activeNoteContext: buildActiveNoteRuntimeContext(params.item),
    metadata: {
      claudeAutoCompactEligible:
        params.effectiveRequestConfig.modelProviderLabel === "Claude Code" &&
        isClaudeAutoCompactEnabled() &&
        !/^\/compact(?:\s|$)/i.test(params.userText.trim()),
      claudeAutoCompactThresholdPercent:
        params.effectiveRequestConfig.modelProviderLabel === "Claude Code"
          ? getClaudeAutoCompactThresholdPercent()
          : undefined,
      claudeHistoryLength: params.history.length,
    },
  };
}

function buildAgentEngineDeps(
  currentItem?: Zotero.Item,
  conversationSystem?: ConversationSystem,
): AgentEngineDeps {
  const getEffectiveConversationSystem = (): ConversationSystem =>
    conversationSystem ||
    (currentItem
      ? resolveEffectiveConversationSystem({ item: currentItem })
      : "upstream");
  return {
    chatHistory,
    agentRunTraceCache,
    cancelledRequestId: (ck: number) => getCancelledRequestId(ck),
    currentAbortController: (ck: number) => getAbortController(ck),
    setCurrentAbortController: (ck: number, ctrl: AbortController | null) => setAbortController(ck, ctrl),
    getAbortControllerCtor,
    nextRequestId,
    setPendingRequestId,
    getPanelRequestUI,
    setRequestUIBusy,
    restoreRequestUIIdle,
    scheduleQueuedInputDrain,
    createPanelUpdateHelpers,
    ensureConversationLoaded,
    getConversationKey,
    buildLLMHistoryMessages,
    buildAgentRuntimeRequest,
    resolveEffectiveRequestConfig,
    getConversationSystem: () => getEffectiveConversationSystem(),
    accumulateSessionTokens,
    getContextUsageSnapshot: (conversationKey: number) =>
      contextUsageSnapshots.get(conversationKey),
    setContextUsageSnapshot: (
      conversationKey: number,
      snapshot: { contextTokens: number; contextWindow?: number },
    ) => {
      contextUsageSnapshots.set(conversationKey, snapshot);
    },
    setTokenUsage,
    normalizeSelectedTexts,
    normalizeSelectedTextSources,
    normalizeSelectedTextPaperContextsByIndex,
    normalizeSelectedTextNoteContextsByIndex,
    normalizePaperContexts,
    includeAutoLoadedPaperContext,
    findLatestRetryPair,
    reconstructRetryPayload,
    isReasoningExpandedByDefault,
    createQueuedRefresh,
    waitForUiStep,
    finalizeCancelledAssistantMessage,
    sanitizeText,
    appendReasoningPart,
    persistConversationMessage,
    updateStoredLatestUserMessage:
      updateStoredLatestUserMessageByConversation as AgentEngineDeps["updateStoredLatestUserMessage"],
    updateStoredLatestAssistantMessage:
      updateStoredLatestAssistantMessageByConversation as AgentEngineDeps["updateStoredLatestAssistantMessage"],
    sendChatFallback: sendQuestion,
    getAgentRuntime: () =>
      getEffectiveConversationSystem() === "claude_code"
        ? (getClaudeBridgeRuntime(
            getCoreAgentRuntime(),
          ) as unknown as ReturnType<typeof getCoreAgentRuntime>)
        : getCoreAgentRuntime(),
    maxSelectedImages: MAX_SELECTED_IMAGES,
  };
}

/**
 * Re-runs the latest user→assistant pair in agent mode.
 * Unlike `retryLatestAssistantResponse` (chat mode only), this function calls
 * `runTurn` so the agent can use tools for the retry.
 * It reuses the existing message objects rather than pushing new ones, so the
 * conversation history stays clean.
 */
async function retryLatestAgentResponse(
  body: Element,
  item: Zotero.Item,
  model?: string,
  apiBase?: string,
  apiKey?: string,
  authMode?: "api_key" | "codex_auth" | "codex_app_server" | "copilot_auth" | "webchat",
  providerProtocol?: ProviderProtocol,
  modelEntryId?: string,
  modelProviderLabel?: string,
  reasoning?: LLMReasoningConfig,
  advanced?: AdvancedModelParams,
): Promise<void> {
  const conversationSystem = resolveEffectiveConversationSystem({
    item,
    authMode,
    providerProtocol,
    modelProviderLabel,
  });
  await retryAgentTurn(
    body,
    item,
    model,
    apiBase,
    apiKey,
    authMode,
    providerProtocol,
    modelEntryId,
    modelProviderLabel,
    reasoning,
    advanced,
    buildAgentEngineDeps(item, conversationSystem),
  );
}

async function sendAgentQuestion(opts: {
  body: Element;
  item: Zotero.Item;
  question: string;
  images?: string[];
  model?: string;
  apiBase?: string;
  apiKey?: string;
  authMode?: "api_key" | "codex_auth" | "codex_app_server" | "copilot_auth" | "webchat";
  providerProtocol?: ProviderProtocol;
  modelEntryId?: string;
  modelProviderLabel?: string;
  reasoning?: LLMReasoningConfig;
  advanced?: AdvancedModelParams;
  displayQuestion?: string;
  selectedTexts?: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  selectedTextNoteContexts?: (NoteContextRef | undefined)[];
  paperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
  attachments?: ChatAttachment[];
  pdfModePaperKeys?: Set<string>;
  forcedSkillIds?: string[];
  pdfUploadSystemMessages?: string[];
  conversationSystem?: ConversationSystem;
}): Promise<void> {
  await sendAgentTurn(
    opts,
    buildAgentEngineDeps(opts.item, opts.conversationSystem),
  );
}

export async function sendQuestion(opts: import("./types").SendQuestionOptions) {
  const {
    body, item, question, images, model, apiBase, apiKey, reasoning, advanced,
    displayQuestion, selectedTexts, selectedTextSources, selectedTextPaperContexts,
    selectedTextNoteContexts, paperContexts, fullTextPaperContexts,
    selectedCollectionContexts, attachments,
    runtimeMode = "chat", agentRunId, skipAgentDispatch = false, pdfModePaperKeys,
  } = opts;
  const effectiveConversationSystem = resolveEffectiveConversationSystem({
    item,
    authMode: opts.authMode,
    providerProtocol: opts.providerProtocol,
    modelProviderLabel: opts.modelProviderLabel,
  });
  const effectiveRuntimeMode: ChatRuntimeMode =
    effectiveConversationSystem === "codex" ? "agent" : runtimeMode;
  if (effectiveRuntimeMode === "agent" && !skipAgentDispatch) {
    await sendAgentQuestion({
      body,
      item,
      question,
      images,
      model,
      apiBase,
      apiKey,
      authMode: opts.authMode,
      providerProtocol: opts.providerProtocol,
      modelEntryId: opts.modelEntryId,
      modelProviderLabel: opts.modelProviderLabel,
      reasoning,
      advanced,
      displayQuestion,
      selectedTexts,
      selectedTextSources,
      selectedTextPaperContexts,
      selectedTextNoteContexts,
      paperContexts,
      fullTextPaperContexts,
      selectedCollectionContexts,
      attachments,
      pdfModePaperKeys,
      forcedSkillIds: opts.forcedSkillIds,
      pdfUploadSystemMessages: opts.pdfUploadSystemMessages,
      conversationSystem: effectiveConversationSystem,
    });
    return;
  }
  const ui = getPanelRequestUI(body);
  const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
  if (
    panelRoot &&
    (opts.providerProtocol === "web_sync" || opts.authMode === "webchat")
  ) {
    panelRoot.dataset.webchatMode = "true";
  }

  // Track this request
  const thisRequestId = nextRequestId();
  const initialConversationKey = getConversationKey(item);
  setPendingRequestId(initialConversationKey, thisRequestId);

  // Show cancel, hide send
  setRequestUIBusy(body, ui, initialConversationKey, "Preparing request...");

  const shownQuestion = displayQuestion || question;
  await ensureConversationLoaded(item);
  const provisionalConversationKey = getConversationKey(item);
  if (!chatHistory.has(provisionalConversationKey)) {
    chatHistory.set(provisionalConversationKey, []);
  }
  const provisionalHistory = chatHistory.get(provisionalConversationKey)!;
  const reuseAgentFallbackPlaceholder = effectiveRuntimeMode === "agent" && skipAgentDispatch;
  const existingFallbackUser =
    reuseAgentFallbackPlaceholder && provisionalHistory.length >= 2
      ? provisionalHistory[provisionalHistory.length - 2]
      : null;
  const existingFallbackAssistant =
    reuseAgentFallbackPlaceholder && provisionalHistory.length >= 1
      ? provisionalHistory[provisionalHistory.length - 1]
      : null;
  const optimisticUserMessage: Message = existingFallbackUser || {
    role: "user",
    text: shownQuestion,
    timestamp: Date.now(),
    runMode: effectiveRuntimeMode,
    agentRunId: agentRunId || undefined,
  };
  const optimisticAssistantMessage: Message = existingFallbackAssistant || {
    role: "assistant",
    text: "",
    timestamp: Date.now(),
    runMode: effectiveRuntimeMode,
    agentRunId: agentRunId || undefined,
    modelName: model,
    streaming: true,
    waitingAnimationStartedAt: Date.now(),
    reasoningOpen: isReasoningExpandedByDefault(),
  };
  if (!reuseAgentFallbackPlaceholder) {
    provisionalHistory.push(optimisticUserMessage, optimisticAssistantMessage);
  }
  const optimisticHelpers = createPanelUpdateHelpers(
    body,
    item,
    provisionalConversationKey,
    ui,
  );
  optimisticHelpers.setStatusSafely("Checking the request against the attached context.", "sending");
  optimisticHelpers.refreshChatSafely();

  const conversationKey = getConversationKey(item);

  // Add user message with attached selected text / screenshots metadata
  if (!chatHistory.has(conversationKey)) {
    chatHistory.set(conversationKey, []);
  }
  const history = chatHistory.get(conversationKey)!;
  const reuseOptimisticPair =
    !reuseAgentFallbackPlaceholder &&
    conversationKey === provisionalConversationKey &&
    history === provisionalHistory &&
    history.length >= 2 &&
    history[history.length - 2] === optimisticUserMessage &&
    history[history.length - 1] === optimisticAssistantMessage;
  const historyForLLM = reuseOptimisticPair
    ? history.slice(0, -2)
    : history.slice();
  const effectiveRequestConfig = resolveEffectiveRequestConfig({
    item,
    model,
    apiBase,
    apiKey,
    reasoning,
    advanced,
  });
  const requestFileAttachments = normalizeModelFileAttachments(attachments, {
    authMode: effectiveRequestConfig.authMode,
    runtimeMode: effectiveRuntimeMode,
  });
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
  const selectedTextNoteContextsForMessage =
    normalizeSelectedTextNoteContextsByIndex(
      selectedTextNoteContexts,
      selectedTextsForMessage.length,
    );
  const selectedTextForMessage = selectedTextsForMessage[0] || "";
  const normalizedPaperContexts = normalizePaperContexts(paperContexts);
  const normalizedFullTextPaperContexts = normalizePaperContexts(
    fullTextPaperContexts,
  );
  const selectedCollectionContextsForMessage = normalizeCollectionContexts(
    selectedCollectionContexts,
  );
  const {
    paperContexts: paperContextsForMessage,
    fullTextPaperContexts: fullTextPaperContextsForMessage,
  } = includeAutoLoadedPaperContext(
    item,
    normalizedPaperContexts,
    normalizedFullTextPaperContexts,
    pdfModePaperKeys && pdfModePaperKeys.size > 0 ? pdfModePaperKeys : undefined,
  );
  const citationPaperContextsForMessage = mergeCitationPaperContexts(
    selectedTextPaperContextsForMessage,
    paperContextsForMessage,
    fullTextPaperContextsForMessage,
  );
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
    timestamp: optimisticUserMessage.timestamp,
    runMode: effectiveRuntimeMode,
    agentRunId: agentRunId || undefined,
    selectedText: selectedTextForMessage || undefined,
    selectedTextExpanded: false,
    selectedTexts: selectedTextsForMessage.length
      ? selectedTextsForMessage
      : undefined,
    selectedTextSources: selectedTextSourcesForMessage.length
      ? selectedTextSourcesForMessage
      : undefined,
    selectedTextPaperContexts: selectedTextPaperContextsForMessage.some(
      (entry) => Boolean(entry),
    )
      ? selectedTextPaperContextsForMessage
      : undefined,
    selectedTextNoteContexts: selectedTextNoteContextsForMessage.some(
      (entry) => Boolean(entry),
    )
      ? selectedTextNoteContextsForMessage
      : undefined,
    selectedTextExpandedIndex: -1,
    paperContexts: paperContextsForMessage.length
      ? paperContextsForMessage
      : undefined,
    fullTextPaperContexts: fullTextPaperContextsForMessage.length
      ? fullTextPaperContextsForMessage
      : undefined,
    citationPaperContexts: citationPaperContextsForMessage.length
      ? citationPaperContextsForMessage
      : undefined,
    selectedCollectionContexts: selectedCollectionContextsForMessage.length
      ? selectedCollectionContextsForMessage
      : undefined,
    paperContextsExpanded: false,
    screenshotImages: screenshotImagesForMessage.length
      ? screenshotImagesForMessage
      : undefined,
    screenshotExpanded: false,
    screenshotActiveIndex: 0,
    attachments: attachments?.length ? attachments : undefined,
  };
  if (reuseOptimisticPair) {
    history[history.length - 2] = userMessage;
  } else {
    history.push(userMessage);
  }
  void persistConversationMessage(conversationKey, {
    role: "user",
    text: userMessage.text,
    timestamp: userMessage.timestamp,
    runMode: userMessage.runMode,
    agentRunId: userMessage.agentRunId,
    selectedText: userMessage.selectedText,
    selectedTexts: userMessage.selectedTexts,
    selectedTextSources: userMessage.selectedTextSources,
    selectedTextPaperContexts: userMessage.selectedTextPaperContexts,
    paperContexts: userMessage.paperContexts,
    fullTextPaperContexts: userMessage.fullTextPaperContexts,
    citationPaperContexts: userMessage.citationPaperContexts,
    selectedCollectionContexts: userMessage.selectedCollectionContexts,
    screenshotImages: userMessage.screenshotImages,
    attachments: userMessage.attachments,
  });

  const assistantMessage: Message = {
    ...optimisticAssistantMessage,
    timestamp: optimisticAssistantMessage.timestamp,
    runMode: effectiveRuntimeMode,
    agentRunId: agentRunId || undefined,
    modelName: effectiveRequestConfig.model,
    modelEntryId: effectiveRequestConfig.modelEntryId,
    modelProviderLabel: effectiveRequestConfig.modelProviderLabel,
    waitingAnimationStartedAt:
      effectiveRequestConfig.modelProviderLabel === "Claude Code" ||
      effectiveRequestConfig.modelProviderLabel === "Codex"
        ? optimisticAssistantMessage.waitingAnimationStartedAt || Date.now()
        : undefined,
    reasoningOpen: isReasoningExpandedByDefault(),
  };
  if (reuseOptimisticPair) {
    history[history.length - 1] = assistantMessage;
  } else {
    history.push(assistantMessage);
  }
  if (history.length > PERSISTED_HISTORY_LIMIT) {
    history.splice(0, history.length - PERSISTED_HISTORY_LIMIT);
  }
  const { refreshChatSafely, setStatusSafely } = createPanelUpdateHelpers(
    body,
    item,
    conversationKey,
    ui,
  );
  refreshChatSafely();

  let assistantPersisted = false;
  const persistAssistantOnce = async () => {
    if (assistantPersisted) return;
    assistantPersisted = true;
    await persistConversationMessage(conversationKey, {
      role: "assistant",
      text: assistantMessage.text,
      timestamp: assistantMessage.timestamp,
      runMode: assistantMessage.runMode,
      agentRunId: assistantMessage.agentRunId,
      modelName: assistantMessage.modelName,
      modelEntryId: assistantMessage.modelEntryId,
      modelProviderLabel: assistantMessage.modelProviderLabel,
      reasoningSummary: assistantMessage.reasoningSummary,
      reasoningDetails: assistantMessage.reasoningDetails,
      webchatRunState: assistantMessage.webchatRunState,
      webchatCompletionReason: assistantMessage.webchatCompletionReason,
      webchatChatUrl: assistantMessage.webchatChatUrl,
      webchatChatId: assistantMessage.webchatChatId,
    });
  };
  const markCancelled = async () => {
    finalizeCancelledAssistantMessage(assistantMessage);
    refreshChatSafely();
    await persistAssistantOnce();
    setStatusSafely("Cancelled", "ready");
  };

  // [webchat] Dedicated pipeline — bypass context assembly, send raw PDF + question
  if (effectiveRequestConfig.providerProtocol === "web_sync") {
    const webChatQueueRefresh = createQueuedRefresh(refreshChatSafely);
    try {
      // Determine webchat target from the model name (e.g., "chatgpt.com" → "chatgpt", "chat.deepseek.com" → "deepseek")
      const { getWebChatTargetByModelName } = await import("../../webchat/types");
      const webchatTargetEntry = getWebChatTargetByModelName(effectiveRequestConfig.model || "");
      const webchatTarget = webchatTargetEntry?.id || "chatgpt";
      const webchatLabel = webchatTargetEntry?.label || "ChatGPT";
      setStatusSafely(`Sending to ${webchatLabel}…`, "sending");
      const { sendWebChatQuestion } = await import("../../webchat/pipeline");

      // Note: `question` already includes selected text context via
      // buildQuestionWithSelectedTextContexts() — no need to prepend again.

      // [webchat] Mode switching disabled — users control thinking mode on chatgpt.com
      const chatgptMode: string | undefined = undefined;

      // [webchat] Send PDF only when the caller explicitly requests it via chip state.
      // Always use dynamic port for the embedded relay server
      const { getRelayBaseUrl } = await import("../../webchat/relayServer");
      const answer = await sendWebChatQuestion({
        item,
        question,
        host: getRelayBaseUrl(),
        sendPdf: opts.webchatSendPdf === true,
        forceNewChat: opts.webchatForceNewChat === true,
        images: screenshotImagesForMessage.length > 0 ? screenshotImagesForMessage : undefined,
        chatgptMode,
        target: webchatTarget,
        signal: getAbortController(conversationKey)?.signal,
        onAnswerSnapshot: (text, snapshot) => {
          applyWebChatAnswerSnapshot(assistantMessage, text, snapshot);
          webChatQueueRefresh();
        },
        onThinkingSnapshot: (text, snapshot) => {
          applyWebChatThinkingSnapshot(assistantMessage, text, snapshot);
          webChatQueueRefresh();
        },
      });

      if (getCancelledRequestId(conversationKey) >= thisRequestId || Boolean(getAbortController(conversationKey)?.signal.aborted)) {
        await markCancelled();
        return;
      }

      assistantMessage.text = sanitizeText(answer.text) || assistantMessage.text || "No response.";
      assistantMessage.reasoningDetails = sanitizeText(answer.thinking || "") || assistantMessage.reasoningDetails;
      assistantMessage.reasoningOpen = assistantMessage.reasoningDetails
        ? isReasoningExpandedByDefault()
        : false;
      assistantMessage.webchatRunState =
        answer.runState === "incomplete" || answer.runState === "error"
          ? answer.runState
          : "done";
      assistantMessage.webchatCompletionReason =
        answer.completionReason ||
        (answer.runState === "done" ? "settled" : null);
      // [webchat] Persist the ChatGPT conversation URL so refresh can navigate back
      if (answer.remoteChatUrl) assistantMessage.webchatChatUrl = answer.remoteChatUrl;
      if (answer.remoteChatId) assistantMessage.webchatChatId = answer.remoteChatId;
      assistantMessage.streaming = false;

      refreshChatSafely();
      await persistAssistantOnce();
      restoreRequestUIIdle(body, conversationKey, thisRequestId);
      setStatusSafely(
        answer.runState === "incomplete"
          ? "Captured partial response — final answer not verified"
          : "Ready",
        answer.runState === "incomplete" ? "error" : "ready",
      );
    } catch (err) {
      const isCancelled =
        getCancelledRequestId(conversationKey) >= thisRequestId ||
        Boolean(getAbortController(conversationKey)?.signal.aborted) ||
        (err as { name?: string }).name === "AbortError";
      if (isCancelled) {
        await markCancelled();
        restoreRequestUIIdle(body, conversationKey, thisRequestId);
        return;
      }
      const errMsg = (err as Error).message || "Error";
      const hasSnapshot = Boolean(
        sanitizeText(assistantMessage.text || "") ||
          sanitizeText(assistantMessage.reasoningDetails || ""),
      );
      if (hasSnapshot) {
        assistantMessage.webchatRunState = "incomplete";
        assistantMessage.webchatCompletionReason = "error";
      } else {
        assistantMessage.text = `Error: ${errMsg}`;
        assistantMessage.webchatRunState = "error";
        assistantMessage.webchatCompletionReason = "error";
      }
      assistantMessage.streaming = false;
      refreshChatSafely();
      await persistAssistantOnce();
      restoreRequestUIIdle(body, conversationKey, thisRequestId);
      setStatusSafely(errMsg, "error");
    } finally {
      setAbortController(conversationKey, null);
      setPendingRequestId(conversationKey, 0);
    }
    return;
  }

  try {
    const rawLLMHistory = buildLLMHistoryMessages(historyForLLM);
    // Apply auto-summary compression when the history grows long.
    const llmHistory = applyHistoryCompression(conversationKey, rawLLMHistory) ?? rawLLMHistory;
    const recentPaperContexts = collectRecentPaperContexts(historyForLLM);

    // Create AbortController early so the signal is available during context
    // planning.
    const AbortControllerCtor = getAbortControllerCtor();
    setAbortController(
      conversationKey,
      AbortControllerCtor ? new AbortControllerCtor() : null,
    );

    const contextPlan = await buildContextPlanForRequest({
      item,
      question,
      images,
      selectedTextSources: selectedTextSourcesForMessage,
      paperContexts: paperContextsForMessage,
      fullTextPaperContexts: fullTextPaperContextsForMessage,
      selectedCollectionContexts: selectedCollectionContextsForMessage,
      recentPaperContexts,
      history: llmHistory,
      effectiveRequestConfig,
      pdfModePaperKeys,
      pdfUploadSystemMessages: opts.pdfUploadSystemMessages,
      signal: getAbortController(conversationKey)?.signal,
      setStatusSafely,
    });
    let combinedContext = contextPlan.combinedContext;
    userMessage.paperContexts = contextPlan.paperContexts.length
      ? contextPlan.paperContexts
      : undefined;
    userMessage.fullTextPaperContexts =
      contextPlan.fullTextPaperContexts.length
        ? contextPlan.fullTextPaperContexts
      : undefined;
    userMessage.citationPaperContexts = mergeCitationPaperContexts(
      userMessage.selectedTextPaperContexts,
      contextPlan.citationPaperContexts,
    );
    await updateStoredLatestUserMessageByConversation(conversationKey, {
      text: userMessage.text,
      timestamp: userMessage.timestamp,
      runMode: userMessage.runMode,
      agentRunId: userMessage.agentRunId,
      selectedText: userMessage.selectedText,
      selectedTexts: userMessage.selectedTexts,
      selectedTextSources: userMessage.selectedTextSources,
      selectedTextPaperContexts: userMessage.selectedTextPaperContexts,
      screenshotImages: userMessage.screenshotImages,
      paperContexts: userMessage.paperContexts,
      fullTextPaperContexts: userMessage.fullTextPaperContexts,
      citationPaperContexts: userMessage.citationPaperContexts,
      selectedCollectionContexts: userMessage.selectedCollectionContexts,
      attachments: userMessage.attachments,
    });

    if (getCancelledRequestId(conversationKey) >= thisRequestId) {
      getAbortController(conversationKey)?.abort();
      await markCancelled();
      return;
    }

    const queueRefresh = createQueuedRefresh(refreshChatSafely);

    if (getCancelledRequestId(conversationKey) >= thisRequestId) {
      getAbortController(conversationKey)?.abort();
      await markCancelled();
      return;
    }

    // Text-only models (e.g. DeepSeek) reject image_url content — drop all images.
    const allSendImages = isTextOnlyModel(effectiveRequestConfig.model || "")
      ? []
      : [...(images || []), ...(contextPlan.mineruImages || [])];
    const requestParams = {
      prompt: question,
      context: combinedContext,
      history: llmHistory,
      signal: getAbortController(conversationKey)?.signal,
      images: allSendImages.length ? allSendImages : undefined,
      attachments: requestFileAttachments,
      model: effectiveRequestConfig.model,
      apiBase: effectiveRequestConfig.apiBase,
      apiKey: effectiveRequestConfig.apiKey,
      authMode: effectiveRequestConfig.authMode,
      providerProtocol: effectiveRequestConfig.providerProtocol,
      reasoning: effectiveRequestConfig.reasoning,
      temperature: effectiveRequestConfig.advanced?.temperature,
      maxTokens: effectiveRequestConfig.advanced?.maxTokens,
      inputTokenCap: effectiveRequestConfig.advanced?.inputTokenCap,
    };
    const previewSystemMessages = buildContextPlanSystemMessages({
      strategy: contextPlan.strategy,
      assistantInstruction: contextPlan.assistantInstruction,
    });
    const preview = prepareChatRequest({
      ...requestParams,
      systemMessages: previewSystemMessages,
    });
    const systemMessages = buildContextPlanSystemMessages({
      strategy: contextPlan.strategy,
      assistantInstruction: contextPlan.assistantInstruction,
      inputCapEffects: preview.inputCap.effects,
    });

    const answer = await callLLMStream(
      {
        ...requestParams,
        systemMessages,
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
      (usage: UsageStats) => {
        const total = accumulateSessionTokens(
          conversationKey,
          usage.totalTokens,
        );
        const contextWindow =
          resolveConversationSystemForItem(item) === "claude_code"
            ? getContextInputWindow(effectiveRequestConfig)
            : undefined;
        contextUsageSnapshots.set(conversationKey, {
          contextTokens: total,
          contextWindow,
        });
        if (ui.tokenUsageEl) {
          setTokenUsage(
            ui.tokenUsageEl,
            total,
            contextWindow,
            body.querySelector("#llm-claude-context-gauge") as HTMLElement | null,
          );
        }
      },
    );

    if (
      getCancelledRequestId(conversationKey) >= thisRequestId ||
      Boolean(getAbortController(conversationKey)?.signal.aborted)
    ) {
      await markCancelled();
      return;
    }

    assistantMessage.text =
      sanitizeText(answer) || assistantMessage.text || "No response.";
    assistantMessage.runMode = effectiveRuntimeMode;
    assistantMessage.agentRunId = agentRunId || assistantMessage.agentRunId;
    assistantMessage.compactMarker = /^\/compact(?:\s|$)/i.test(question.trim());
    if (assistantMessage.compactMarker && !assistantMessage.text.trim()) {
      assistantMessage.text = "Conversation compacted";
    }
    assistantMessage.streaming = false;
    refreshChatSafely();
    await persistAssistantOnce();
    if (resolveConversationSystemForItem(item) === "claude_code") {
      const conversationKind = resolveDisplayConversationKind(item);
      const baseItem = resolveConversationBaseItem(item);
      await captureClaudeSessionInfo(
        conversationKey,
        buildClaudeScope({
          libraryID: Number(item.libraryID || baseItem?.libraryID || 0),
          kind: conversationKind === "global" ? "global" : "paper",
          paperItemID:
            conversationKind === "paper"
              ? Number(baseItem?.id || 0) || undefined
              : undefined,
          paperTitle:
            conversationKind === "paper"
              ? String(baseItem?.getField?.("title") || "").trim() || undefined
              : undefined,
        }),
      ).catch(() => null);
    }

    // After the response is saved, kick off a background LLM summary of the
    // older history so it is ready for the next request.
    scheduleLLMSummary(conversationKey, rawLLMHistory, {
      model: effectiveRequestConfig.model,
      apiBase: effectiveRequestConfig.apiBase,
      apiKey: effectiveRequestConfig.apiKey,
      authMode: effectiveRequestConfig.authMode,
    });

    setStatusSafely("Ready", "ready");
  } catch (err) {
    const isCancelled =
      getCancelledRequestId(conversationKey) >= thisRequestId ||
      Boolean(getAbortController(conversationKey)?.signal.aborted) ||
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
    restoreRequestUIIdle(body, conversationKey, thisRequestId);
    setAbortController(conversationKey, null);
    setPendingRequestId(conversationKey, 0);
    scheduleQueuedInputDrain(body, {
      conversationSystem: resolveConversationSystemForItem(item) || "upstream",
      conversationKey,
    });
  }
}

/** Build the inline edit textarea + action bar that replaces a user bubble. */
function buildInlineEditWidget(
  doc: Document,
  body: Element,
  item: Zotero.Item,
  _userMsg: Message,
  _assistantMsg: Message,
  _conversationKey: number,
): HTMLDivElement {
  const widgetRoot = doc.createElement("div") as HTMLDivElement;
  widgetRoot.className = "llm-inline-edit-wrapper";

  // On first entry, grab the real input section and the inputBox from the panel.
  // Subsequent refreshes (e.g. streaming) reuse the saved reference so the
  // already-detached element can be re-attached into the new widget root.
  const isFirstEntry = !inlineEditInputSectionEl;
  let inputSectionEl = inlineEditInputSectionEl;
  if (isFirstEntry) {
    inputSectionEl = body.querySelector(
      ".llm-input-section",
    ) as HTMLElement | null;
    if (inputSectionEl) {
      setInlineEditInputSection(
        inputSectionEl,
        inputSectionEl.parentElement,
        inputSectionEl.nextSibling,
      );
    }
  }

  // The real input <textarea>
  const inputBoxEl =
    (body.querySelector("#llm-input") as HTMLTextAreaElement | null) ??
    (inputSectionEl?.querySelector("#llm-input") as HTMLTextAreaElement | null);

  // On first entry: save draft and pre-fill with the user message
  if (isFirstEntry) {
    setInlineEditSavedDraft(inputBoxEl?.value ?? "");
    if (inputBoxEl && inlineEditTarget) {
      inputBoxEl.value = inlineEditTarget.currentText;
    }
  }

  // Keep inlineEditTarget.currentText in sync with what the user types
  // (so text is preserved if chatBox rebuilds while still in edit mode).
  // Use a one-time marker to avoid stacking duplicate listeners.
  if (inputBoxEl && !inputBoxEl.dataset.inlineEditListening) {
    inputBoxEl.dataset.inlineEditListening = "1";
    inputBoxEl.addEventListener("input", () => {
      if (inlineEditTarget) inlineEditTarget.currentText = inputBoxEl.value;
    });
  }

  // Register cleanup (idempotent — only set once per edit session).
  if (!inlineEditCleanup) {
    setInlineEditCleanup(() => {
      // Restore input section to its original position in the panel.
      const el = inlineEditInputSectionEl;
      const parent = inlineEditInputSectionParent;
      const next = inlineEditInputSectionNextSib;
      if (el && parent) {
        parent.insertBefore(el, next);
      }
      // Restore the draft text.
      if (inputBoxEl) {
        inputBoxEl.value = inlineEditSavedDraft;
        inputBoxEl.style.height = "auto";
        if (inputBoxEl.scrollHeight) {
          inputBoxEl.style.height = `${inputBoxEl.scrollHeight}px`;
        }
        delete inputBoxEl.dataset.inlineEditListening;
        delete inputBoxEl.dataset.inlineEditFocused;
      }
      setInlineEditInputSection(null, null, null);
      setInlineEditSavedDraft("");
    });
  }

  const doCancel = () => {
    inlineEditCleanup?.();
    setInlineEditCleanup(null);
    setInlineEditTarget(null);
    const win = body.ownerDocument?.defaultView;
    if (win) win.setTimeout(() => refreshChat(body, item), 0);
  };

  // Header: "Editing" label + Cancel button
  const header = doc.createElement("div") as HTMLDivElement;
  header.className = "llm-inline-edit-header";
  const headerLabel = doc.createElement("span") as HTMLSpanElement;
  headerLabel.className = "llm-inline-edit-header-label";
  headerLabel.textContent = "Editing";
  const cancelBtn = doc.createElement("button") as HTMLButtonElement;
  cancelBtn.type = "button";
  cancelBtn.className = "llm-inline-edit-header-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("mousedown", (e: Event) => {
    (e as MouseEvent).preventDefault();
    (e as MouseEvent).stopPropagation();
    doCancel();
  });
  cancelBtn.addEventListener("click", (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  });
  header.append(headerLabel, cancelBtn);
  widgetRoot.appendChild(header);

  // Move the real input section into the widget
  if (inputSectionEl) widgetRoot.appendChild(inputSectionEl);

  // Focus on first entry only (don't steal focus on streaming refreshes)
  const win = body.ownerDocument?.defaultView;
  if (
    win &&
    inputBoxEl &&
    isFirstEntry &&
    !inputBoxEl.dataset.inlineEditFocused
  ) {
    inputBoxEl.dataset.inlineEditFocused = "1";
    win.setTimeout(() => {
      inputBoxEl.focus({ preventScroll: true });
      inputBoxEl.setSelectionRange(
        inputBoxEl.value.length,
        inputBoxEl.value.length,
      );
    }, 0);
  }

  return widgetRoot;
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
    const tokenUsageEl = body.querySelector(
      "#llm-token-usage",
    ) as HTMLElement | null;
    if (tokenUsageEl) tokenUsageEl.style.display = "none";
    return;
  }

  const conversationKey = getConversationKey(item);
  // Sync token counter for this conversation
  const tokenUsageEl = body.querySelector(
    "#llm-token-usage",
  ) as HTMLElement | null;
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
  if (tokenUsageEl) {
    const snapshot = contextUsageSnapshots.get(conversationKey);
    if (isClaudeConversationSystemActive()) {
      const contextTokens =
        typeof snapshot?.contextTokens === "number" && snapshot.contextTokens > 0
          ? snapshot.contextTokens
          : 0;
      const contextWindow =
        typeof snapshot?.contextWindow === "number" && snapshot.contextWindow > 0
          ? snapshot.contextWindow
          : undefined;
      setTokenUsage(
        tokenUsageEl,
        contextTokens,
        contextWindow,
        body.querySelector("#llm-claude-context-gauge") as HTMLElement | null,
      );
    } else {
      const contextWindow = getContextInputWindow(resolveEffectiveRequestConfig({ item }));
      const seededTokens = getOrSeedSessionTokens(conversationKey, history);
      setTokenUsage(
        tokenUsageEl,
        seededTokens,
        contextWindow,
        body.querySelector("#llm-claude-context-gauge") as HTMLElement | null,
      );
    }
  }

  if (history.length === 0) {
    // [webchat] Show webchat-specific welcome instead of generic instructions
    const effectiveRequestConfig = resolveEffectiveRequestConfig({ item });
    if (effectiveRequestConfig.providerProtocol === "web_sync") {
      const { getWebChatTargetByModelName } = require("../../webchat/types") as typeof import("../../webchat/types");
      const targetEntry = getWebChatTargetByModelName(effectiveRequestConfig.model || "");
      chatBox.innerHTML = getWebChatWelcomeHtml(targetEntry?.label, targetEntry?.modelName);
    } else {
      const isStandalone = panelRoot?.dataset?.standalone === "true" || (body as HTMLElement).dataset?.standalone === "true";
      const isNoteEditing = !!resolveActiveNoteSession(item);
      if (isNoteEditing) {
        chatBox.innerHTML = getNoteEditingStartPageHtml();
        if (panelRoot) panelRoot.dataset.startPageActive = "true";
      } else if (isStandalone && isGlobalConversation) {
        chatBox.innerHTML = getStandaloneLibraryChatStartPageHtml();
        if (panelRoot) panelRoot.dataset.startPageActive = "true";
      } else {
        chatBox.innerHTML = getPaperChatStartPageHtml();
        if (panelRoot) panelRoot.dataset.startPageActive = "true";
      }
    }
    return;
  }

  // Animate transition from start page to chat mode
  const wasStartPage = panelRoot?.dataset.startPageActive === "true";
  if (wasStartPage && panelRoot) {
    panelRoot.classList.add("llm-start-page-transitioning");
    delete panelRoot.dataset.startPageActive;
    const win = body.ownerDocument?.defaultView;
    if (win) {
      win.setTimeout(() => {
        panelRoot.classList.remove("llm-start-page-transitioning");
      }, 450);
    }
  }
  chatBox.innerHTML = "";

  const latestRetryPair = findLatestRetryPair(history);
  const latestAssistantIndex = latestRetryPair
    ? latestRetryPair.userIndex + 1
    : -1;
  // [webchat] Resolve provider protocol once for editability checks
  const renderProviderProtocol = resolveEffectiveRequestConfig({ item }).providerProtocol;
  const conversationIsIdle = !history.some((m) => m.streaming);
  for (const [index, msg] of history.entries()) {
    const isUser = msg.role === "user";
    const assistantPairMsg = history[index + 1];
    const hasAssistantPair = isUser && assistantPairMsg?.role === "assistant";
    const canEditUserPrompt = canEditUserPromptTurn({
      isUser,
      hasItem: Boolean(item),
      conversationIsIdle,
      assistantPair: assistantPairMsg,
      providerProtocol: renderProviderProtocol,
    });
    const isInlineEditBubble = Boolean(
      canEditUserPrompt &&
      inlineEditTarget?.conversationKey === conversationKey &&
      inlineEditTarget.userTimestamp === msg.timestamp,
    );
    let hasUserContext = false;
    const wrapper = doc.createElement("div") as HTMLDivElement;
    wrapper.className = `llm-message-wrapper ${isUser ? "user" : "assistant"}`;

    const bubble = doc.createElement("div") as HTMLDivElement;
    bubble.className = `llm-bubble ${isUser ? "user" : "assistant"}`;
    let inlineEditEl: HTMLElement | null = null;

    if (isUser) {
      const contextBadgesRow = doc.createElement("div") as HTMLDivElement;
      contextBadgesRow.className = "llm-user-context-badges";
      let hasContextBadge = false;

      const screenshotImages = Array.isArray(msg.screenshotImages)
        ? msg.screenshotImages.filter(
            (entry) => Boolean(entry) && !entry.startsWith("data:application/pdf"),
          )
        : [];
      let screenshotExpanded: HTMLDivElement | null = null;
      let papersExpanded: HTMLDivElement | null = null;
      let collectionsExpanded: HTMLDivElement | null = null;
      let filesExpanded: HTMLDivElement | null = null;
      const selectedTexts = getMessageSelectedTexts(msg);
      const selectedTextSources = normalizeSelectedTextSources(
        msg.selectedTextSources,
        selectedTexts.length,
      );
      const selectedTextPaperContexts =
        normalizeSelectedTextPaperContextsByIndex(
          msg.selectedTextPaperContexts,
          selectedTexts.length,
        );
      const hasScreenshotContext = screenshotImages.length > 0;
      const hasSelectedTextContext = selectedTexts.length > 0;
      const selectedCollectionContexts = normalizeCollectionContexts(
        msg.selectedCollectionContexts,
      );
      hasUserContext =
        hasScreenshotContext ||
        hasSelectedTextContext ||
        selectedCollectionContexts.length > 0;
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

      if (selectedCollectionContexts.length) {
        const collectionsBar = doc.createElement("button") as HTMLButtonElement;
        collectionsBar.type = "button";
        collectionsBar.className = "llm-user-papers-bar llm-user-collections-bar";

        const collectionsIcon = doc.createElement("span") as HTMLSpanElement;
        collectionsIcon.className = "llm-user-papers-icon";
        collectionsIcon.textContent = "🗂️";

        const collectionsLabel = doc.createElement("span") as HTMLSpanElement;
        collectionsLabel.className = "llm-user-papers-label";
        collectionsLabel.textContent =
          selectedCollectionContexts.length === 1 ? "Collection" : "Collections";
        collectionsLabel.title = selectedCollectionContexts
          .map((entry) => entry.name)
          .join("\n");
        collectionsBar.append(collectionsIcon, collectionsLabel);

        const collectionsExpandedEl = doc.createElement("div") as HTMLDivElement;
        collectionsExpandedEl.className =
          "llm-user-papers-expanded llm-user-collections-expanded";
        collectionsExpanded = collectionsExpandedEl;
        const collectionsList = doc.createElement("div") as HTMLDivElement;
        collectionsList.className =
          "llm-user-papers-list llm-user-collections-list";
        for (const collectionContext of selectedCollectionContexts) {
          const collectionItem = doc.createElement("div") as HTMLDivElement;
          collectionItem.className =
            "llm-user-papers-item llm-user-collections-item";

          const collectionTitle = doc.createElement("span") as HTMLSpanElement;
          collectionTitle.className = "llm-user-papers-item-title";
          collectionTitle.textContent = collectionContext.name;
          collectionTitle.title = collectionContext.name;

          const collectionMeta = doc.createElement("span") as HTMLSpanElement;
          collectionMeta.className = "llm-user-papers-item-meta";
          collectionMeta.textContent = `collectionId=${collectionContext.collectionId}`;
          collectionMeta.title = collectionMeta.textContent;

          collectionItem.append(collectionTitle, collectionMeta);
          collectionsList.appendChild(collectionItem);
        }
        collectionsExpandedEl.appendChild(collectionsList);

        const applyCollectionsState = () => {
          const expanded = Boolean(msg.collectionContextsExpanded);
          collectionsBar.classList.toggle("expanded", expanded);
          collectionsBar.setAttribute("aria-expanded", expanded ? "true" : "false");
          collectionsExpandedEl.hidden = !expanded;
          collectionsExpandedEl.style.display = expanded ? "block" : "none";
          collectionsBar.title = expanded ? "Collapse collections" : "Expand collections";
        };
        const toggleCollectionsExpanded = () => {
          msg.collectionContextsExpanded = !msg.collectionContextsExpanded;
          applyCollectionsState();
        };
        applyCollectionsState();
        collectionsBar.addEventListener("mousedown", (e: Event) => {
          const mouse = e as MouseEvent;
          if (mouse.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          toggleCollectionsExpanded();
        });
        collectionsBar.addEventListener("click", (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
        });
        collectionsBar.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          toggleCollectionsExpanded();
        });

        contextBadgesRow.appendChild(collectionsBar);
        hasContextBadge = true;
      }

      const paperContexts = normalizePaperContexts(msg.paperContexts);
      // Determine which papers were sent in PDF mode (have pdf-paper-* attachments)
      const pdfPaperContextItemIds = new Set(
        (Array.isArray(msg.attachments) ? msg.attachments : [])
          .filter((a) => typeof a?.id === "string" && a.id.startsWith("pdf-paper-"))
          .map((a) => {
            const m = a.id.match(/^pdf-paper-(\d+)-/);
            return m ? Number(m[1]) : 0;
          })
          .filter((id) => id > 0),
      );
      const fullTextPaperKeys = new Set(
        normalizePaperContexts(msg.fullTextPaperContexts).map(
          (p) => `${p.itemId}:${p.contextItemId}`,
        ),
      );
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

          // Content source mode badge
          const isPdf = pdfPaperContextItemIds.has(paperContext.contextItemId);
          const isFullText = fullTextPaperKeys.has(`${paperContext.itemId}:${paperContext.contextItemId}`);
          if (isPdf || isFullText) {
            const badge = doc.createElement("span") as HTMLSpanElement;
            badge.className = `llm-user-papers-item-badge llm-user-papers-item-badge-${isPdf ? "pdf" : "text"}`;
            badge.textContent = isPdf ? "PDF" : "Text";
            paperItem.append(paperTitle, paperMeta, badge);
          } else {
            paperItem.append(paperTitle, paperMeta);
          }
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
              typeof entry.name === "string" &&
              // Exclude PDF-paper attachments (shown under paper context instead)
              !(typeof entry.id === "string" && entry.id.startsWith("pdf-paper-")),
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
      if (collectionsExpanded) {
        wrapper.appendChild(collectionsExpanded);
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
          const selectedTextPaperContext =
            selectedTextPaperContexts[contextIndex];
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
      const hasPromptTurnPair = Boolean(assistantPairMsg?.role === "assistant");
      const canDeletePromptTurn = Boolean(
        hasPromptTurnPair && !assistantPairMsg?.streaming,
      );
      if (isInlineEditBubble) {
        inlineEditEl = buildInlineEditWidget(
          doc,
          body,
          item,
          msg,
          assistantPairMsg!,
          conversationKey,
        );
      } else {
        renderUserBubbleContent(bubble, sanitizeText(msg.text || ""), doc);
        if (canEditUserPrompt) {
          bubble.classList.add("llm-bubble-editable");
          bubble.addEventListener("click", (e: Event) => {
            if ((e.target as Element | null)?.closest("a, button")) return;
            e.preventDefault();
            e.stopPropagation();
            const win = body.ownerDocument?.defaultView;
            if (!win) return;
            try {
              syncComposeContextForInlineEdit(body, item, msg);
            } catch (syncErr) {
              ztoolkit.log(
                "LLM: Failed to sync compose context for inline edit",
                syncErr,
              );
            }
            setInlineEditTarget({
              conversationKey,
              userTimestamp: msg.timestamp,
              assistantTimestamp: Math.floor(assistantPairMsg!.timestamp),
              currentText: msg.text || "",
            });
            win.setTimeout(() => refreshChat(body, item), 0);
          });
        }
      }
      if (hasPromptTurnPair) {
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
          const promptMenuDeleteBtn = promptMenu?.querySelector(
            "#llm-prompt-menu-delete",
          ) as HTMLButtonElement | null;
          if (!promptMenu) return;
          if (promptMenuDeleteBtn) {
            promptMenuDeleteBtn.disabled = !canDeletePromptTurn;
          }
          if (!canDeletePromptTurn) return;
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
            userTimestamp: Math.floor(msg.timestamp),
            assistantTimestamp: hasPromptTurnPair
              ? Math.floor(assistantPairMsg?.timestamp || 0)
              : 0,
            editable: false,
          });
          positionMenuAtPointer(body, promptMenu, me.clientX, me.clientY);
        });
      }
    } else {
      const hasModelName = Boolean(msg.modelName?.trim());
      const hasAnswerText = Boolean(msg.text);
      const previousUserMessage =
        index > 0 && history[index - 1]?.role === "user"
          ? history[index - 1]
          : null;
      const isClaudeStreamingConversation = resolveConversationSystemForItem(item) === "claude_code";
      const agentRunId = msg.agentRunId?.trim();
      const hasCachedTrace = agentRunId
        ? agentRunTraceCache.has(agentRunId)
        : false;
      const cachedTraceEvents = agentRunId ? getCachedAgentRunEvents(agentRunId) : [];
      const traceEvents = cachedTraceEvents.length
        ? cachedTraceEvents
        : msg.pendingAgentTraceEvents || [];
      let agentUsesInterleavedText = false;
      const agentTraceEl =
        msg.runMode === "agent"
          ? renderAgentTrace({
              doc,
              message: msg,
              userMessage: previousUserMessage,
              events: traceEvents,
              onTraceMissing: agentRunId
                && !hasCachedTrace
                ? () => {
                    void ensureAgentRunTraceLoaded(agentRunId, body, item);
                  }
                : undefined,
              onInterleavedText: () => { agentUsesInterleavedText = true; },
            })
          : null;
      if (hasAnswerText && !agentUsesInterleavedText) {
        const safeText = sanitizeText(msg.text);
        if (msg.streaming) bubble.classList.add("streaming");
        if (msg.compactMarker) {
          bubble.textContent = safeText || "Conversation compacted";
          bubble.classList.add("llm-compact-marker");
        } else if (msg.streaming && looksLikeStreamingMarkdownTable(safeText)) {
          bubble.textContent = safeText;
        } else try {
          // Build image resolver for MinerU figures (if applicable)
          const contextSource = resolveContextSourceItem(item);
          const ctxItem = contextSource.contextItem;
          const pdfCtx = ctxItem ? pdfTextCache.get(ctxItem.id) : null;
          const resolveImage = pdfCtx?.sourceType === "mineru" && ctxItem
            ? buildImageResolver(ctxItem.id)
            : undefined;
          bubble.innerHTML = renderMarkdown(safeText, { resolveImage });
          attachRenderedCopyButtons(bubble, doc);
        } catch (err) {
          ztoolkit.log("LLM render error:", err);
          bubble.textContent = safeText;
        }
        if (!msg.streaming) {
          try {
            const pairedUserMessage =
              history[index - 1]?.role === "user" ? history[index - 1] : null;
            ztoolkit.log(
              "LLM: calling decorateAssistantCitationLinks",
              "msgLen =",
              msg.text.length,
              "bubbleHTML =",
              String(bubble.innerHTML || "").length,
              "hasPairedUser =",
              Boolean(pairedUserMessage),
              "pairedPaperContexts =",
              pairedUserMessage?.paperContexts?.length ?? "none",
            );
            decorateAssistantCitationLinks({
              body,
              panelItem: item,
              bubble,
              assistantMessage: msg,
              pairedUserMessage,
            });
          } catch (decorateErr) {
            ztoolkit.log("LLM citation decoration error:", decorateErr);
          }
        }
      }

      const bubbleHeaderNodes: HTMLElement[] = [];

      if (hasModelName) {
        const modelHeader = doc.createElement("div") as HTMLDivElement;
        modelHeader.className = "llm-model-header";

        const modelName = doc.createElement("div") as HTMLDivElement;
        modelName.className = "llm-model-name";
        modelName.textContent = formatDisplayModelName(
          msg.modelName,
          msg.modelProviderLabel,
          { suppressProviderPrefix: resolveConversationSystemForItem(item) === "claude_code" },
        );
        modelHeader.appendChild(modelName);

        if (
          !hasAnswerText &&
          msg.streaming &&
          isClaudeStreamingConversation
        ) {
          const roseLoader = doc.createElement("span") as HTMLSpanElement;
          roseLoader.className = "llm-rose-loader llm-rose-loader-inline";
          mountClaudeRoseThreeLoader(
            roseLoader,
            msg.waitingAnimationStartedAt || msg.timestamp || Date.now(),
          );
          modelHeader.appendChild(roseLoader);
        }

        bubbleHeaderNodes.push(modelHeader);
      }

      const hasReasoningSummary = Boolean(msg.reasoningSummary?.trim());
      const hasReasoningDetails = Boolean(msg.reasoningDetails?.trim());
      const showTopReasoningPanel =
        (hasReasoningSummary || hasReasoningDetails) &&
        msg.runMode !== "agent";
      if (showTopReasoningPanel) {
        const details = doc.createElement("details") as HTMLDetailsElement;
        details.className = "llm-agent-reasoning";
        details.open = Boolean(msg.reasoningOpen);

        const summary = doc.createElement("summary") as HTMLElement;
        summary.className = "llm-agent-reasoning-summary";
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
        bodyWrap.className = "llm-agent-reasoning-body";

        if (hasReasoningSummary) {
          const summaryBlock = doc.createElement("div") as HTMLDivElement;
          summaryBlock.className = "llm-agent-reasoning-block";
          const label = doc.createElement("div") as HTMLDivElement;
          label.className = "llm-agent-reasoning-label";
          label.textContent = "Summary";
          const text = doc.createElement("div") as HTMLDivElement;
          text.className = "llm-agent-reasoning-text";
          try {
            text.innerHTML = renderMarkdown(msg.reasoningSummary || "");
            attachRenderedCopyButtons(text, doc);
          } catch (err) {
            ztoolkit.log("LLM reasoning render error:", err);
            text.textContent = msg.reasoningSummary || "";
          }
          summaryBlock.append(label, text);
          bodyWrap.appendChild(summaryBlock);
        }

        if (hasReasoningDetails) {
          const detailsBlock = doc.createElement("div") as HTMLDivElement;
          detailsBlock.className = "llm-agent-reasoning-block";
          const label = doc.createElement("div") as HTMLDivElement;
          label.className = "llm-agent-reasoning-label";
          label.textContent = "Details";
          const text = doc.createElement("div") as HTMLDivElement;
          text.className = "llm-agent-reasoning-text";
          try {
            text.innerHTML = renderMarkdown(msg.reasoningDetails || "");
            attachRenderedCopyButtons(text, doc);
          } catch (err) {
            ztoolkit.log("LLM reasoning render error:", err);
            text.textContent = msg.reasoningDetails || "";
          }
          detailsBlock.append(label, text);
          bodyWrap.appendChild(detailsBlock);
        }

        details.appendChild(bodyWrap);
        bubbleHeaderNodes.push(details);
      }

      if (agentTraceEl) {
        bubbleHeaderNodes.push(agentTraceEl);
      }

      for (let i = bubbleHeaderNodes.length - 1; i >= 0; i -= 1) {
        bubble.insertBefore(bubbleHeaderNodes[i], bubble.firstChild);
      }

      if (
        shouldDecorateInterleavedAgentTraceCitations({
          agentTraceEl,
          agentUsesInterleavedText,
          streaming: msg.streaming,
        })
      ) {
        try {
          ztoolkit.log(
            "LLM: calling decorateAssistantCitationLinks for interleaved agent trace",
            "msgLen =",
            msg.text.length,
            "bubbleHTML =",
            String(bubble.innerHTML || "").length,
            "hasPairedUser =",
            Boolean(previousUserMessage),
            "pairedPaperContexts =",
            previousUserMessage?.paperContexts?.length ?? "none",
          );
          decorateAssistantCitationLinks({
            body,
            panelItem: item,
            bubble,
            assistantMessage: msg,
            pairedUserMessage: previousUserMessage,
          });
        } catch (decorateErr) {
          ztoolkit.log(
            "LLM interleaved citation decoration error:",
            decorateErr,
          );
        }
      }

      if (!hasAnswerText && !(msg.streaming && isClaudeStreamingConversation)) {
        const typing = doc.createElement("div") as HTMLDivElement;
        typing.className = "llm-typing";
        typing.innerHTML =
          '<span class="llm-typing-dot"></span><span class="llm-typing-dot"></span><span class="llm-typing-dot"></span>';
        bubble.appendChild(typing);
      }

      attachAssistantResponseContextMenu({
        body,
        doc,
        bubble,
        item,
        message: msg,
        pairedUserMessage: previousUserMessage,
        conversationKey,
      });
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
      msg.text.trim() &&
      msg.runMode !== "agent" &&
      renderProviderProtocol !== "web_sync" // [webchat] no retry in webchat mode
    ) {
      const retryBtn = doc.createElement("button") as HTMLButtonElement;
      retryBtn.type = "button";
      retryBtn.className = "llm-retry-latest";
      retryBtn.textContent = "↻";
      retryBtn.title = "Retry response with another model";
      retryBtn.setAttribute("aria-label", "Retry latest response");
      meta.appendChild(retryBtn);
    }

    // [webchat] Collect status row data — rendered after meta, below the timestamp
    let webchatStatusRow: HTMLDivElement | null = null;
    if (!isUser) {
      const webchatStateLabel = getWebChatRunStateLabel(msg);
      if (webchatStateLabel) {
        webchatStatusRow = doc.createElement("div") as HTMLDivElement;
        webchatStatusRow.className = "llm-message-webchat-status-row";

        const status = doc.createElement("span") as HTMLSpanElement;
        status.className = "llm-message-webchat-status";
        status.textContent = webchatStateLabel;
        webchatStatusRow.appendChild(status);

        // [webchat] Refresh icon — re-scrape current ChatGPT conversation
        const refreshBtn = doc.createElement("button") as HTMLButtonElement;
        refreshBtn.className = "llm-message-webchat-refresh";
        refreshBtn.textContent = "\u21BB";
        refreshBtn.title = "Re-fetch this conversation from webchat";
        refreshBtn.addEventListener("click", async () => {
          refreshBtn.disabled = true;
          try {
            const { refreshCurrentConversation } = await import("../../webchat/client");
            const { getRelayBaseUrl } = await import("../../webchat/relayServer");
            const scraped = await refreshCurrentConversation(
              getRelayBaseUrl(),
              msg.webchatChatUrl || null,
              msg.webchatChatId || null,
            );
            if (scraped.length > 0) {
              const refreshed: Message[] = scraped.map((m) => ({
                role: (m.kind === "user" ? "user" : "assistant") as "user" | "assistant",
                text: m.text || "",
                timestamp: Date.now(),
                modelName: m.kind === "bot" ? (msg.modelName || "chatgpt.com") : undefined,
                modelProviderLabel: m.kind === "bot" ? "WebChat" : undefined,
                reasoningDetails: m.thinking || undefined,
              }));
              chatHistory.set(conversationKey, refreshed);
              refreshChat(body, item);
            } else {
              refreshBtn.title = "No messages found — chat site may be on a different page";
              setTimeout(() => { refreshBtn.title = "Re-fetch this conversation from webchat"; refreshBtn.disabled = false; }, 2000);
            }
          } catch {
            refreshBtn.title = "Refresh failed";
            setTimeout(() => { refreshBtn.title = "Re-fetch this conversation from webchat"; refreshBtn.disabled = false; }, 2000);
          }
        });
        webchatStatusRow.appendChild(refreshBtn);
      }
    }

    if (isUser && inlineEditEl) {
      wrapper.appendChild(inlineEditEl);
    } else {
      wrapper.appendChild(bubble);
    }
    wrapper.appendChild(meta);
    if (webchatStatusRow) wrapper.appendChild(webchatStatusRow);
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

export function refreshConversationPanels(
  primaryBody: Element,
  primaryItem?: Zotero.Item | null,
  options: {
    includeChat?: boolean;
    includePanelState?: boolean;
  } = {},
): void {
  const { includeChat = true, includePanelState = false } = options;
  if (!primaryItem) {
    if (includeChat) {
      refreshChat(primaryBody, primaryItem);
    }
    if (includePanelState) {
      activeContextPanelStateSync.get(primaryBody)?.();
    }
    return;
  }

  const conversationKey = getConversationKey(primaryItem);
  const refreshedPanels = new Set<Element>();
  const refreshOne = (body: Element, item: Zotero.Item) => {
    const chatBox = body.querySelector(
      "#llm-chat-box",
    ) as HTMLDivElement | null;
    if (includeChat && !chatBox) return;
    const syncPanelState = activeContextPanelStateSync.get(body);
    const updatePanel = () => {
      if (includeChat) {
        refreshChat(body, item);
      }
      if (includePanelState) {
        syncPanelState?.();
      }
    };
    if (chatBox) {
      withScrollGuard(chatBox, conversationKey, updatePanel);
    } else {
      updatePanel();
    }
    refreshedPanels.add(body);
  };

  refreshOne(primaryBody, primaryItem);

  for (const [body, getItem] of activeContextPanels.entries()) {
    if (!(body as Element).isConnected) {
      activeContextPanels.delete(body);
      activeContextPanelStateSync.delete(body);
      continue;
    }
    if (refreshedPanels.has(body)) continue;
    const item = getItem();
    if (!item) continue;
    if (getConversationKey(item) !== conversationKey) continue;
    refreshOne(body, item);
  }
}
