import { renderMarkdownForNote } from "../../utils/markdown";
import { HTML_NS } from "../../utils/domHelpers";
import {
  t,
  getWelcomeHtml,
  getWebChatWelcomeHtml,
  getStandaloneLibraryChatStartPageHtml,
  getPaperChatStartPageHtml,
  getNoteEditingStartPageHtml,
} from "../../utils/i18n";
import {
  appendMessage as appendStoredMessage,
  clearConversation as clearStoredConversation,
  pruneConversation,
  updateLatestUserMessage as updateStoredLatestUserMessage,
  updateLatestAssistantMessage as updateStoredLatestAssistantMessage,
  StoredChatMessage,
} from "../../utils/chatStore";
import { conversationRepository } from "../../core/conversations/repository";
import {
  appendCodexMessage,
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
  getClaudeBridgeRuntime,
  isClaudeConversationSystemActive,
  updateLatestClaudeConversationAssistantMessage,
  updateLatestClaudeConversationUserMessage,
} from "../../claudeCode/runtime";
import { getCodexProfileSignature } from "../../codexAppServer/constants";
import { resolveConversationStorageSystem } from "../../shared/conversationStorageRouting";
import { normalizeForcedSkillIds } from "../../shared/skillIds";
import {
  getCodexReasoningModePref,
  getCodexRuntimeModelPref,
  isCodexAppServerNativeApprovalsEnabled,
  isCodexAppServerModeEnabled,
  isCodexZoteroMcpToolsEnabled,
} from "../../codexAppServer/prefs";
import { getEffectiveCodexAppServerBinaryPath } from "../../codexAppServer/binaryPath";
import { buildCodexAppServerReasoningConfig } from "../../codexAppServer/reasoning";
import {
  buildCodexNativeApprovalPendingAction,
  buildCodexNativeApprovalResponseFromResolution,
  compactCodexAppServerConversation,
  isCodexNativeBuiltInApprovalRequest,
  NO_CODEX_APP_SERVER_THREAD_TO_COMPACT_MESSAGE,
  resolveCodexNativeApprovalRequest,
  runCodexAppServerNativeTurn,
  type CodexNativeApprovalRequest,
  type CodexNativeConversationScope,
  type CodexNativeDiagnostics,
} from "../../codexAppServer/nativeClient";
import type { CodexNativeSkillContext } from "../../codexAppServer/nativeSkills";
import { preflightClaudeBridgeLocalPdfCapability } from "../../agent/externalBackendBridge";
import { validateLocalPdfDocumentBatch } from "../../agent/context/localDocumentBatch";
import {
  callLLMStream,
  type ChatParams,
  ChatFileAttachment,
  ChatMessage,
  getRuntimeReasoningOptions,
  prepareChatRequest,
  type PreparedChatRequest,
  ReasoningConfig as LLMReasoningConfig,
  ReasoningEvent,
  ReasoningLevel as LLMReasoningLevel,
  UsageStats,
  checkEmbeddingAvailability,
} from "../../utils/llmClient";
import { applyModelInputTokenCap } from "../../utils/modelInputCap";
import { formatDisplayModelName } from "../../utils/modelDisplayLabel";
import type { ProviderProtocol } from "../../utils/providerProtocol";
import { inferLegacyProviderProtocol } from "../../utils/providerProtocol";
import {
  PERSISTED_HISTORY_LIMIT,
  MAX_FULL_TEXT_PAPER_CONTEXTS,
  MAX_SELECTED_IMAGES,
  formatFigureCountLabel,
  formatPaperCountLabel,
} from "./constants";
import {
  applyChatScrollSnapshot,
  buildChatScrollSnapshot,
  buildFollowBottomScrollSnapshot,
  cancelFollowBottomCatchup,
  consumePendingChatScrollRestore,
  getChatScrollSnapshot,
  hasActiveFollowBottomCatchupRequest,
  persistChatScrollSnapshotForConversationKey,
  requestFollowBottomCatchup,
  setFollowBottomChatScrollSnapshot,
  withScrollGuard,
} from "./chatScrollSnapshots";
import { resizeTextareaToContent } from "./textareaSizing";
import { getActiveReaderForSelectedTab } from "./contextResolution";
export {
  isScrollUpdateSuspended,
  withScrollGuard,
} from "./chatScrollSnapshots";
import {
  createBlockStreamCoalescer,
  type BlockStreamCoalescer,
  type BlockStreamFlushReason,
} from "./blockStreamCoalescer";
import type {
  ConversationSystem,
  GeneratedChatImage,
  QuoteCitation,
} from "../../shared/types";
import type { FullReadCoverageReceipt } from "../../shared/exhaustiveDocumentReader";
import type {
  LibraryChatCoverageReceipt,
  LibraryChatReadStrategyDiagnostics,
} from "../../shared/libraryChatReadStrategy";
import {
  getConversationForkLink,
  type ConversationForkLink,
} from "../../shared/conversationForkLinks";
import {
  isRenderableGeneratedImageSrc,
  normalizeGeneratedChatImages,
} from "../../shared/generatedImages";
import { isEmbeddableGeneratedImage } from "./generatedImageAssets";
import { copyTextToClipboard } from "./clipboard";
import { renderAssistantGeneratedImagesInto } from "./generatedImageRender";
export { copyTextToClipboard } from "./clipboard";
export {
  copyGeneratedImageToClipboard,
  renderAssistantGeneratedImagesInto,
} from "./generatedImageRender";
import { ensureMineruCacheDirForAttachment } from "./mineruSync";
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
  TagContextRef,
  SelectedTextContext,
  ResolvedSelectedTextAnchor,
  SelectedTextSource,
  PaperContextRef,
  PaperContextSendMode,
  ContextAssemblyStrategy,
  ResolvedContextSource,
} from "./types";
import {
  chatHistory,
  conversationForkLinks,
  loadedConversationKeys,
  loadingConversationTasks,
  webChatIsolatedConversationKeys,
  selectedModelCache,
  selectedReasoningCache,
  selectedReasoningProviderCache,
  selectedImageCache,
  selectedFileAttachmentCache,
  selectedPaperContextCache,
  selectedCollectionContextCache,
  selectedTagContextCache,
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
  getResponseActionRunner,
  getForkSourceNavigationRunner,
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
  type ResponseActionKind,
  type ResponseActionTarget,
} from "./state";
import { agentRunTraceCache, agentRunTraceLoadingTasks } from "./agentState";
import {
  sanitizeText,
  formatTime,
  setStatus,
  setTokenUsage,
  getSelectedTextWithinBubble,
  getAttachmentTypeLabel,
  buildQuestionWithSelectedTextContexts,
  buildModelPromptWithFileContext,
  resolvePromptText,
} from "./textUtils";
import {
  createContextIcon,
  createSelectedTextSourceIcon,
} from "./contextIcons";
import {
  buildCodexAppServerNativeAttachmentBlockMessage,
  getBlockedCodexAppServerNativeAttachments,
  shouldApplyCodexAppServerNativeAttachmentPolicy,
} from "./codexAppServerAttachmentPolicy";
import {
  normalizeSelectedTextNoteContexts,
  normalizeSelectedTextPaperContexts as normalizeSelectedTextPaperContextEntries,
  normalizeSelectedTextSources,
  synthesizeSelectedTextContexts,
  normalizePaperContextRefs,
  normalizeCollectionContextRefs,
  normalizeTagContextRefs,
  normalizeAttachmentContentHash,
} from "./normalizers";
import { positionMenuAtPointer } from "./menuPositioning";
import { FULL_PDF_UNSUPPORTED_MESSAGE } from "./pdfSupportMessages";
import {
  getAvailableModelEntries,
  getLastReasoningExpanded,
  getLastUsedReasoningLevel,
  getLastUsedReasoningLevelForProvider,
  getSelectedModelEntryForItem,
  getBoolPref,
  getStringPref,
  setLastReasoningExpanded,
  setLastUsedReasoningLevelForProvider,
} from "./prefHelpers";
import { resolveMultiContextPlan } from "./multiContextPlanner";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
  resolvePaperContextDisplayRef,
  resolvePaperContextRefFromAttachment,
  resolvePaperContextRefFromItem,
  type PaperContextDisplayCache,
} from "./paperAttribution";
import {
  buildPaperKey,
  ensureNoteTextCached,
  ensurePDFTextCached,
} from "./pdfContext";
import { resolveProviderCapabilities } from "../../providers";
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
import { shouldShowForkActionForAssistantTurn } from "./forkActionVisibility";
import { buildChatHistoryNotePayload } from "./notes";
import { readNoteSnapshot } from "./noteSnapshot";
import { extractManagedBlobHash } from "./attachmentStorage";
import { buildContextPlanSystemMessages } from "./requestSystemMessages";
import { getWorkflowTestFinalRequestInterceptor } from "./workflowTestHooks";
import { resolveSelectedTextAnchors } from "./selectedTextAnchors";
import { canEditUserPromptTurn } from "./editability";
import { renderAgentTrace, renderPendingActionCard } from "./agentTrace/render";
import {
  TOOL_ACTIVITY_VISIBLE_DEDUPE_WINDOW_MS,
  hasSameToolActivityVisibleIdentity,
  mergeToolActivityPayload,
} from "./agentTrace/toolActivityDedupe";
import { renderRenderedMarkdownInto } from "./renderedMarkdown";
import { toFileUrl } from "../../utils/pathFileUrl";
import { replaceOwnerAttachmentRefs } from "../../utils/attachmentRefStore";
import { getNotesDirectoryConfig } from "../../utils/notesDirectoryConfig";
import { getWebChatTargetByModelName } from "../../webchat/types";
import {
  decorateAssistantCitationLinks,
  renderQuoteCitationPlaceholders,
} from "./assistantCitationLinks";
import {
  getCachedPageTextForAttachment,
  hasCompleteSearchablePageTextForAttachment,
  warmPageTextCacheForAttachment,
} from "./livePdfSelectionLocator";
import {
  getMessageCitationPaperContexts,
  mergeCitationPaperContexts,
} from "./citationContexts";
import {
  buildQuoteSourceIndex,
  buildSelectedTextQuoteCitations,
  extractQuoteCitationsFromToolContent,
  finalizeAssistantQuoteCitations,
  finalizeAssistantQuoteCitationsCooperatively,
  mergeQuoteCitations,
  type QuoteSourceText,
} from "./quoteCitations";
import {
  buildQuoteDisplayMarkdown,
  buildQuoteExpandedMarkdown,
  getMessageQuoteDisplay,
  QUOTE_RENDER_OCCURRENCE_PATTERN,
} from "./quoteRenderPlan";
import { isQuoteValidationPreempted } from "./quoteValidationActivity";
import {
  getAgentApi,
  getCoreAgentRuntime,
  initAgentSubsystem,
} from "../../agent/index";
import { getClaudeReasoningModePref } from "../../claudeCode/prefs";
import { getAgentRunTrace } from "../../agent/store/traceStore";
import {
  applyHistoryCompression,
  scheduleLLMSummary,
  clearConversationSummary,
} from "./conversationSummaryCache";
import type {
  AgentAttachmentResource,
  AgentAttachmentResourceSummary,
  AgentConfirmationResolution,
  AgentEvent,
  AgentPendingAction,
  AgentRunEventRecord,
  AgentRuntimeRequest,
  AgentToolArtifact,
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
import { recordContextCacheTelemetry } from "../../contextCache/manager";
import { resolveContextAttachmentSupportFromMetadata } from "./contextAttachmentSupport";
import { createLocalPdfResourceResolver } from "./setupHandlers/controllers/localPdfResourceResolver";
import {
  clearPaperContentSourceOverride,
  setPaperContentSourceOverride,
} from "./contexts/paperContextState";
import {
  getConversationScopeValidationDetails,
  type ConversationRegistryScope,
} from "../../shared/conversationRegistry";
import {
  provisionConversationScopeForItem,
  resolveConversationStorageSystemForItem,
} from "./conversationProvisioning";

export { getConversationKey } from "./conversationIdentity";
export { renderAssistantMarkdownHtmlForChat } from "./renderedMarkdown";

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

const blockedConversationLoadKeys = new Set<number>();

function isEffectiveWebChatRequest(item: Zotero.Item): boolean {
  try {
    const requestConfig = resolveEffectiveRequestConfig({ item });
    return (
      requestConfig.authMode === "webchat" ||
      requestConfig.providerProtocol === "web_sync"
    );
  } catch {
    return false;
  }
}

function isolateWebChatConversationKey(
  conversationKey: number,
  resetHistory: boolean,
): void {
  const key = Math.floor(Number(conversationKey || 0));
  if (!Number.isFinite(key) || key <= 0) return;
  webChatIsolatedConversationKeys.add(key);
  if (resetHistory || !chatHistory.has(key)) {
    chatHistory.set(key, []);
  }
  blockedConversationLoadKeys.delete(key);
  loadedConversationKeys.add(key);
}

function normalizeConversationScopeInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function buildConversationRegistryScopeForItem(
  item: Zotero.Item,
  conversationKey: number,
  conversationSystem?: ConversationSystem | null,
): ConversationRegistryScope | null {
  const normalizedConversationKey =
    normalizeConversationScopeInt(conversationKey);
  if (!normalizedConversationKey) return null;
  const storageSystem = resolveConversationStorageSystemForItem({
    item,
    conversationSystem,
  });
  if (!storageSystem) return null;
  const kind = resolveDisplayConversationKind(item);
  const libraryID = normalizeConversationScopeInt(item?.libraryID);
  if (!kind || !libraryID) return null;
  if (kind === "global") {
    return {
      conversationKey: normalizedConversationKey,
      system: storageSystem,
      kind: "global",
      libraryID,
    };
  }
  const baseItem = resolveConversationBaseItem(item);
  const paperItemID = normalizeConversationScopeInt(baseItem?.id);
  const paperLibraryID =
    normalizeConversationScopeInt(baseItem?.libraryID) || libraryID;
  if (!paperItemID || !paperLibraryID) return null;
  return {
    conversationKey: normalizedConversationKey,
    system: storageSystem,
    kind: "paper",
    libraryID: paperLibraryID,
    paperItemID,
  };
}

async function validateConversationScopeForItem(params: {
  item: Zotero.Item;
  conversationKey: number;
  conversationSystem?: ConversationSystem | null;
}): Promise<boolean> {
  await provisionConversationScopeForItem({
    item: params.item,
    conversationSystem: params.conversationSystem,
  });
  const scope = buildConversationRegistryScopeForItem(
    params.item,
    params.conversationKey,
    params.conversationSystem,
  );
  if (!scope) return !resolveActiveNoteSession(params.item);
  const validation = await getConversationScopeValidationDetails(scope);
  if (!validation.valid) {
    const targetLabel =
      scope.kind === "global" ? "library" : `paper ${scope.paperItemID || ""}`;
    const registeredLabel = validation.registered
      ? validation.registered.kind === "global"
        ? "library"
        : `paper ${validation.registered.paperItemID || ""}`
      : "";
    const registered = validation.registered
      ? `; registered as ${validation.registered.system}/${validation.registered.kind} library ${validation.registered.libraryID} ${registeredLabel} id ${validation.registered.conversationID}`
      : "";
    ztoolkit.log(
      `LLM: Refused to use mismatched ${scope.system}/${scope.kind} conversation ${scope.conversationKey} for library ${scope.libraryID} ${targetLabel} (${validation.reason})${registered}`,
    );
  }
  return validation.valid;
}

function collectMessagePaperContextIds(
  refs: (PaperContextRef | undefined)[] | undefined,
  out: Set<number>,
): void {
  if (!Array.isArray(refs)) return;
  for (const ref of refs) {
    const itemID = normalizeConversationScopeInt(ref?.itemId);
    if (itemID) out.add(itemID);
  }
}

function storedMessagesMatchActivePaper(
  item: Zotero.Item,
  storedMessages: StoredChatMessage[],
): boolean {
  if (resolveDisplayConversationKind(item) !== "paper") return true;
  const baseItem = resolveConversationBaseItem(item);
  const activePaperItemID = normalizeConversationScopeInt(baseItem?.id);
  if (!activePaperItemID) return true;
  const ids = new Set<number>();
  for (const message of storedMessages) {
    collectMessagePaperContextIds(message.paperContexts, ids);
    collectMessagePaperContextIds(message.pdfPaperContexts, ids);
    collectMessagePaperContextIds(message.fullTextPaperContexts, ids);
    collectMessagePaperContextIds(message.citationPaperContexts, ids);
    collectMessagePaperContextIds(message.selectedTextPaperContexts, ids);
  }
  if (ids.size === 0) return true;
  return ids.has(activePaperItemID);
}

function isCompactCommandText(text: string): boolean {
  return /^\/compact(?:\s|$)/i.test((text || "").trim());
}

function removeMessageReference(history: Message[], message: Message): void {
  const index = history.indexOf(message);
  if (index >= 0) history.splice(index, 1);
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
  return openFileUrl(fileUrl);
}

function openFileUrl(fileUrl: string): boolean {
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

function normalizeTagContexts(tagContexts: unknown): TagContextRef[] {
  return normalizeTagContextRefs(tagContexts, { sanitizeText });
}

function resolveAutoLoadedPaperContextForItem(
  item: Zotero.Item,
  contextSource?: ResolvedContextSource | null,
): PaperContextRef | null {
  const activeNoteSession = resolveActiveNoteSession(item);
  if (activeNoteSession?.noteKind === "standalone") {
    return null;
  }
  if (
    activeNoteSession?.noteKind === "item" &&
    activeNoteSession.parentItemId
  ) {
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
  const explicitPaperContext = normalizePaperContexts(
    contextSource?.paperContext ? [contextSource.paperContext] : [],
  )[0];
  if (explicitPaperContext) return explicitPaperContext;
  const sourceItem = contextSource?.contextItem || null;
  if (sourceItem?.isAttachment?.()) {
    const explicitSourceContext =
      resolvePaperContextRefFromAttachment(sourceItem);
    if (explicitSourceContext) return explicitSourceContext;
  }
  const resolvedContextSource = resolveContextSourceItem(sourceItem || item);
  return (
    resolvedContextSource.paperContext ||
    resolvePaperContextRefFromAttachment(resolvedContextSource.contextItem)
  );
}

function resolveLibraryDisplayName(libraryID: number): string | undefined {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return undefined;
  const libraries = (
    Zotero as unknown as {
      Libraries?: {
        getName?: (libraryID: number) => string;
        get?: (libraryID: number) => { name?: string } | null | undefined;
        userLibraryID?: number;
      };
    }
  ).Libraries;
  try {
    const directName = libraries?.getName?.(libraryID);
    if (typeof directName === "string" && directName.trim()) {
      return sanitizeText(directName);
    }
  } catch (_error) {
    void _error;
  }
  try {
    const library = libraries?.get?.(libraryID);
    if (typeof library?.name === "string" && library.name.trim()) {
      return sanitizeText(library.name);
    }
  } catch (_error) {
    void _error;
  }
  return libraries?.userLibraryID === libraryID ? "My Library" : undefined;
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
  message: Pick<Message, "text" | "generatedImages">,
): boolean {
  if (sanitizeText(message.text || "").trim()) return true;
  return normalizeGeneratedChatImages(message.generatedImages).some(
    isEmbeddableGeneratedImage,
  );
}

export function resolveAssistantResponseMenuContent(
  message: Pick<Message, "text" | "generatedImages">,
  selectedText = "",
): { contentText: string; generatedImages?: GeneratedChatImage[] } | null {
  const selected = sanitizeText(selectedText || "").trim();
  if (selected) return { contentText: selected };
  const contentText = sanitizeText(message.text || "").trim();
  const generatedImages = normalizeGeneratedChatImages(
    message.generatedImages,
  ).filter(isEmbeddableGeneratedImage);
  if (!contentText && !generatedImages.length) return null;
  return {
    contentText,
    generatedImages: generatedImages.length ? generatedImages : undefined,
  };
}

export function buildAssistantResponseActionTarget(params: {
  item: Zotero.Item;
  message: Message;
  pairedUserMessage: Message | null;
  conversationKey: number;
  selectedText?: string;
}): ResponseActionTarget | null {
  const { item, message, pairedUserMessage, conversationKey, selectedText } =
    params;
  const quoteDisplay = getMessageQuoteDisplay(message);
  const menuContent = resolveAssistantResponseMenuContent(
    {
      text: selectedText ? message.text : quoteDisplay.markdown,
      generatedImages: message.generatedImages,
    },
    selectedText || "",
  );
  if (!menuContent) return null;
  const pairedUser =
    pairedUserMessage?.role === "user" ? pairedUserMessage : null;
  return {
    item,
    contentText: menuContent.contentText,
    queryText: pairedUser ? pairedUser.text || "" : "",
    modelName: message.modelName?.trim() || "unknown",
    conversationKey,
    userTimestamp: pairedUser ? Math.floor(pairedUser.timestamp) : 0,
    assistantTimestamp: Math.floor(message.timestamp),
    paperContexts: pairedUser
      ? getMessageCitationPaperContexts(pairedUser)
      : undefined,
    quoteCitations: quoteDisplay.quoteCitations || undefined,
    generatedImages: menuContent.generatedImages,
  };
}

function buildAssistantResponseDeleteTarget(params: {
  item: Zotero.Item;
  message: Message;
  pairedUserMessage: Message | null;
  conversationKey: number;
  contentTarget: ResponseActionTarget | null;
}): ResponseActionTarget | null {
  const pairedUser =
    params.pairedUserMessage?.role === "user" ? params.pairedUserMessage : null;
  if (!pairedUser) return null;
  return (
    params.contentTarget || {
      item: params.item,
      contentText: "",
      queryText: pairedUser.text || "",
      modelName: params.message.modelName?.trim() || "unknown",
      conversationKey: params.conversationKey,
      userTimestamp: Math.floor(pairedUser.timestamp),
      assistantTimestamp: Math.floor(params.message.timestamp),
      paperContexts: getMessageCitationPaperContexts(pairedUser),
      quoteCitations: params.message.quoteCitations,
      generatedImages: undefined,
    }
  );
}

export function invokeResponseMenuActionButton(params: {
  body: Element;
  action: ResponseActionKind;
  target: ResponseActionTarget | null;
}): boolean {
  const { action, body, target } = params;
  if (!target) return false;
  const runner = getResponseActionRunner(body);
  if (!runner) return false;
  setResponseMenuTarget(target);
  void runner(action, target);
  return true;
}

export function shouldDecorateInterleavedAgentTraceCitations(params: {
  agentTraceEl: Element | null;
  agentUsesInterleavedText: boolean;
  streaming?: boolean;
}): boolean {
  return Boolean(
    params.agentTraceEl && params.agentUsesInterleavedText && !params.streaming,
  );
}

function decorateCompletedAssistantCitationLinks(params: {
  body: Element;
  panelItem: Zotero.Item;
  bubble: HTMLDivElement;
  assistantMessage: Message;
  pairedUserMessage: Message | null;
}): void {
  const { body, panelItem, bubble, assistantMessage, pairedUserMessage } =
    params;
  if (assistantMessage.streaming || assistantMessage.compactMarker) return;
  if (!sanitizeText(bubble.textContent || assistantMessage.text || "").trim()) {
    return;
  }
  try {
    ztoolkit.log(
      "LLM: calling decorateAssistantCitationLinks",
      "msgLen =",
      assistantMessage.text.length,
      "bubbleHTML =",
      String(bubble.innerHTML || "").length,
      "hasPairedUser =",
      Boolean(pairedUserMessage),
      "pairedPaperContexts =",
      pairedUserMessage?.paperContexts?.length ?? "none",
    );
    renderQuoteCitationPlaceholders({
      body,
      panelItem,
      bubble,
      assistantMessage,
      pairedUserMessage,
    });
    decorateAssistantCitationLinks({
      body,
      panelItem,
      bubble,
      assistantMessage,
      pairedUserMessage,
    });
  } catch (decorateErr) {
    ztoolkit.log("LLM citation decoration error:", decorateErr);
  }
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
    const responseMenuForkBtn = responseMenu?.querySelector(
      "#llm-response-menu-fork",
    ) as HTMLButtonElement | null;
    const canDeleteResponseTurn = Boolean(
      pairedUserMessage?.role === "user" && !message.streaming,
    );
    const canForkResponseTurn =
      canDeleteResponseTurn &&
      canShowForkActionForAssistantTurn(
        body,
        item,
        conversationKey,
        message.timestamp,
        message,
      );
    if (!responseMenu) return;
    if (responseMenuDeleteBtn) {
      responseMenuDeleteBtn.disabled = !canDeleteResponseTurn;
    }
    if (responseMenuForkBtn) {
      responseMenuForkBtn.disabled = !canForkResponseTurn;
      responseMenuForkBtn.style.display = canForkResponseTurn ? "" : "none";
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
    const menuTarget = buildAssistantResponseActionTarget({
      item,
      message,
      pairedUserMessage,
      conversationKey,
      selectedText,
    });
    if (!menuTarget) return;
    setResponseMenuTarget(menuTarget);
    positionMenuAtPointer(body, responseMenu, me.clientX, me.clientY);
  });
}

function canShowForkActionForAssistantTurn(
  body: Element,
  item: Zotero.Item,
  conversationKey: number,
  assistantTimestamp: unknown,
  assistantMessage?: Message | null,
): boolean {
  return shouldShowForkActionForAssistantTurn({
    body,
    item,
    assistantTimestamp,
    assistantMessage,
    history: chatHistory.get(conversationKey) || [],
  });
}

export function shouldShowAssistantFooterActions(
  msg: Pick<Message, "streaming" | "compactMarker">,
): boolean {
  return !msg.streaming && !msg.compactMarker;
}

export function shouldShowUserFooterCopyAction(
  msg: Pick<Message, "text">,
): boolean {
  return Boolean(sanitizeText(msg.text || "").trim());
}

function appendMessageMetaActionButton(params: {
  body?: Element;
  doc: Document;
  actions: HTMLElement;
  className: string;
  title: string;
  responseAction?: ResponseActionKind;
  responseTarget?: ResponseActionTarget | null;
  conversationKey?: number;
  userTimestamp?: number;
  assistantTimestamp?: number;
}): HTMLButtonElement {
  const button = params.doc.createElementNS(
    HTML_NS,
    "button",
  ) as HTMLButtonElement;
  button.type = "button";
  button.className = `llm-message-action ${params.className}`;
  button.title = params.title;
  button.setAttribute("aria-label", params.title);
  if (params.responseAction) {
    button.dataset.responseAction = params.responseAction;
  }
  if (params.body && params.responseAction && params.responseTarget) {
    button.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      const invoked = invokeResponseMenuActionButton({
        body: params.body!,
        action: params.responseAction!,
        target: params.responseTarget || null,
      });
      if (!invoked) {
        const status = params.body!.querySelector(
          "#llm-status",
        ) as HTMLElement | null;
        if (status) setStatus(status, "Response action unavailable", "error");
      }
    });
  }
  if (Number.isFinite(params.conversationKey)) {
    button.dataset.conversationKey = String(
      Math.floor(params.conversationKey!),
    );
  }
  if (Number.isFinite(params.userTimestamp)) {
    button.dataset.userTimestamp = String(Math.floor(params.userTimestamp!));
  }
  if (Number.isFinite(params.assistantTimestamp)) {
    button.dataset.assistantTimestamp = String(
      Math.floor(params.assistantTimestamp!),
    );
  }
  params.actions.appendChild(button);
  return button;
}

export function appendUserMessageCopyAction(params: {
  body: Element;
  doc: Document;
  actions: HTMLElement;
  message: Pick<Message, "text">;
}): HTMLButtonElement | null {
  if (!shouldShowUserFooterCopyAction(params.message)) return null;
  const button = appendMessageMetaActionButton({
    doc: params.doc,
    actions: params.actions,
    className: "llm-message-action-copy",
    title: "Copy query",
  });
  button.dataset.userAction = "copy";
  button.addEventListener("click", async (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
    await copyTextToClipboard(params.body, params.message.text || "");
    const status = params.body.querySelector(
      "#llm-status",
    ) as HTMLElement | null;
    if (status) setStatus(status, t("Copied query"), "ready");
  });
  return button;
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

const followBottomStabilizers = new Map<
  number,
  { rafId: number | null; timeoutId: number | null }
>();

/** Legacy cumulative API token usage per conversation key for this UI session. */
const sessionTokenTotals = new Map<number, number>();
type ContextUsageSnapshot = {
  contextTokens: number;
  contextWindow?: number;
  contextWindowIsAuthoritative?: boolean;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheMissTokens?: number;
  cacheHitRatio?: number;
  cacheProvider?: string;
  estimated?: boolean;
  source?: "estimated" | "provider" | "persisted";
};
const contextUsageSnapshots = new Map<number, ContextUsageSnapshot>();
function setContextUsageSnapshot(
  conversationKey: number,
  snapshot: ContextUsageSnapshot,
): ContextUsageSnapshot {
  const normalized: ContextUsageSnapshot = {
    contextTokens: Math.max(0, Math.floor(Number(snapshot.contextTokens) || 0)),
    contextWindow:
      Number.isFinite(Number(snapshot.contextWindow)) &&
      Number(snapshot.contextWindow) > 0
        ? Math.floor(Number(snapshot.contextWindow))
        : undefined,
    contextWindowIsAuthoritative:
      snapshot.contextWindowIsAuthoritative === true,
    cacheReadTokens:
      Number.isFinite(Number(snapshot.cacheReadTokens)) &&
      Number(snapshot.cacheReadTokens) > 0
        ? Math.floor(Number(snapshot.cacheReadTokens))
        : undefined,
    cacheWriteTokens:
      Number.isFinite(Number(snapshot.cacheWriteTokens)) &&
      Number(snapshot.cacheWriteTokens) > 0
        ? Math.floor(Number(snapshot.cacheWriteTokens))
        : undefined,
    cacheMissTokens:
      Number.isFinite(Number(snapshot.cacheMissTokens)) &&
      Number(snapshot.cacheMissTokens) > 0
        ? Math.floor(Number(snapshot.cacheMissTokens))
        : undefined,
    cacheHitRatio:
      Number.isFinite(Number(snapshot.cacheHitRatio)) &&
      Number(snapshot.cacheHitRatio) >= 0
        ? Math.max(0, Math.min(1, Number(snapshot.cacheHitRatio)))
        : undefined,
    cacheProvider:
      typeof snapshot.cacheProvider === "string" &&
      snapshot.cacheProvider.trim()
        ? snapshot.cacheProvider.trim()
        : undefined,
    estimated: snapshot.estimated !== false,
    source: snapshot.source || "estimated",
  };
  contextUsageSnapshots.set(conversationKey, normalized);
  return normalized;
}

function renderContextUsageSnapshot(
  body: Element,
  tokenUsageEl: HTMLElement | null,
  snapshot?: ContextUsageSnapshot,
): void {
  if (!tokenUsageEl) return;
  setTokenUsage(
    tokenUsageEl,
    snapshot?.contextTokens || 0,
    snapshot?.contextWindow,
    body.querySelector("#llm-claude-context-gauge") as HTMLElement | null,
    {
      estimated: snapshot?.estimated !== false,
      cacheReadTokens: snapshot?.cacheReadTokens,
      cacheWriteTokens: snapshot?.cacheWriteTokens,
      cacheMissTokens: snapshot?.cacheMissTokens,
      cacheHitRatio: snapshot?.cacheHitRatio,
      cacheProvider: snapshot?.cacheProvider,
    },
  );
}

function estimateHistoryContextUsageSnapshot(
  item: Zotero.Item,
  history: Message[],
): ContextUsageSnapshot | undefined {
  if (!history.length) return undefined;
  const effectiveRequestConfig = resolveEffectiveRequestConfig({ item });
  const messages = buildLLMHistoryMessages(history);
  const inputCap = applyModelInputTokenCap(
    messages,
    effectiveRequestConfig.model || "",
    effectiveRequestConfig.advanced?.inputTokenCap,
  );
  if (inputCap.estimatedAfterTokens <= 0) return undefined;
  return {
    contextTokens: inputCap.estimatedAfterTokens,
    contextWindow: inputCap.limitTokens,
    estimated: true,
    source: "estimated",
  };
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

export function getSessionTokenTotal(conversationKey: number): number {
  return sessionTokenTotals.get(conversationKey) ?? 0;
}

export function resetSessionTokens(conversationKey: number): void {
  sessionTokenTotals.delete(conversationKey);
  contextUsageSnapshots.delete(conversationKey);
}

export function persistChatScrollSnapshot(
  item: Zotero.Item,
  chatBox: HTMLDivElement,
): void {
  persistChatScrollSnapshotForConversationKey(
    getConversationKey(item),
    chatBox,
  );
}

function stickChatBoxToBottomIfFollowing(
  conversationKey: number,
  chatBox: HTMLDivElement,
): boolean {
  const snapshot = getChatScrollSnapshot(conversationKey);
  if (
    (!snapshot || snapshot.mode !== "followBottom") &&
    !hasActiveFollowBottomCatchupRequest(conversationKey)
  ) {
    return false;
  }
  if (!chatBox.isConnected) return false;
  chatBox.scrollTop = chatBox.scrollHeight;
  persistChatScrollSnapshotForConversationKey(conversationKey, chatBox);
  return true;
}

export function requestChatScrollFollowBottom(
  body: Element,
  item: Zotero.Item,
  chatBox: HTMLDivElement,
): void {
  const conversationKey = getConversationKey(item);
  requestFollowBottomCatchup(conversationKey);
  setFollowBottomChatScrollSnapshot(conversationKey, chatBox);
  stabilizeFollowBottomAfterAsyncChatContent(body, conversationKey, chatBox);
}

export function cancelChatScrollFollowBottomRequest(item: Zotero.Item): void {
  cancelFollowBottomCatchup(getConversationKey(item));
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
    stickChatBoxToBottomIfFollowing(conversationKey, chatBox);
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

function stabilizeFollowBottomAfterAsyncChatContent(
  body: Element,
  conversationKey: number,
  chatBox: HTMLDivElement,
): void {
  if (!stickChatBoxToBottomIfFollowing(conversationKey, chatBox)) return;
  scheduleFollowBottomStabilization(body, conversationKey, chatBox);
}

function applyChatScrollPolicy(
  item: Zotero.Item,
  chatBox: HTMLDivElement,
): void {
  const conversationKey = getConversationKey(item);
  const snapshot =
    getChatScrollSnapshot(conversationKey) || buildChatScrollSnapshot(chatBox);
  applyChatScrollSnapshot(chatBox, snapshot);
  persistChatScrollSnapshotForConversationKey(conversationKey, chatBox);
}

async function loadStoredConversationByKey(
  conversationKey: number,
  limit: number,
  conversationSystem?: ConversationSystem | null,
): Promise<StoredChatMessage[]> {
  const storageSystem = resolveConversationStorageSystem({
    conversationKey,
    conversationSystem,
  });
  if (!storageSystem) return [];
  return conversationRepository.loadMessages({
    system: storageSystem,
    conversationKey,
    limit,
  });
}

async function loadConversationForkLinkCache(
  conversationKey: number,
): Promise<void> {
  try {
    const link = await getConversationForkLink(conversationKey);
    if (link) {
      conversationForkLinks.set(conversationKey, link);
    } else {
      conversationForkLinks.delete(conversationKey);
    }
  } catch (err) {
    conversationForkLinks.delete(conversationKey);
    ztoolkit.log("LLM: Failed to load conversation fork link", err);
  }
}

async function updateStoredLatestUserMessageByConversation(
  conversationKey: number,
  message: Parameters<typeof updateStoredLatestUserMessage>[1],
  conversationSystem?: ConversationSystem | null,
): Promise<void> {
  const storageSystem = resolveConversationStorageSystem({
    conversationKey,
    conversationSystem,
  });
  if (!storageSystem) return;
  if (storageSystem === "claude_code") {
    await updateLatestClaudeConversationUserMessage(conversationKey, message);
    return;
  }
  if (storageSystem === "codex") {
    await updateLatestCodexUserMessage(conversationKey, message);
    return;
  }
  await updateStoredLatestUserMessage(conversationKey, message);
}

async function updateStoredLatestAssistantMessageByConversation(
  conversationKey: number,
  message: Parameters<typeof updateStoredLatestAssistantMessage>[1],
  conversationSystem?: ConversationSystem | null,
): Promise<void> {
  const storageSystem = resolveConversationStorageSystem({
    conversationKey,
    conversationSystem,
  });
  if (!storageSystem) return;
  if (storageSystem === "claude_code") {
    const latestContextSnapshot = contextUsageSnapshots.get(conversationKey);
    await updateLatestClaudeConversationAssistantMessage(conversationKey, {
      ...message,
      contextTokens:
        Number.isFinite(Number(message.contextTokens)) &&
        Number(message.contextTokens) > 0
          ? Math.floor(Number(message.contextTokens))
          : latestContextSnapshot?.contextTokens,
      contextWindow:
        Number.isFinite(Number(message.contextWindow)) &&
        Number(message.contextWindow) > 0
          ? Math.floor(Number(message.contextWindow))
          : latestContextSnapshot?.contextWindow,
    });
    return;
  }
  if (storageSystem === "codex") {
    const latestContextSnapshot = contextUsageSnapshots.get(conversationKey);
    await updateLatestCodexAssistantMessage(conversationKey, {
      ...message,
      contextTokens:
        Number.isFinite(Number(message.contextTokens)) &&
        Number(message.contextTokens) > 0
          ? Math.floor(Number(message.contextTokens))
          : latestContextSnapshot?.contextTokens,
      contextWindow:
        Number.isFinite(Number(message.contextWindow)) &&
        Number(message.contextWindow) > 0
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
  conversationSystem?: ConversationSystem | null,
): Promise<void> {
  try {
    const storageSystem = resolveConversationStorageSystem({
      conversationKey,
      conversationSystem,
    });
    if (!storageSystem) return;
    if (storageSystem === "claude_code") {
      await appendClaudeConversationMessage(conversationKey, message);
    } else if (storageSystem === "codex") {
      await appendCodexMessage(conversationKey, message);
      await pruneCodexConversation(conversationKey, PERSISTED_HISTORY_LIMIT);
    } else {
      await appendStoredMessage(conversationKey, message);
      await pruneConversation(conversationKey, PERSISTED_HISTORY_LIMIT);
    }
    const storedMessages = await loadStoredConversationByKey(
      conversationKey,
      PERSISTED_HISTORY_LIMIT,
      storageSystem,
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

function normalizeStoredPaperContextRoutes(params: {
  paperContexts?: PaperContextRef[];
  pdfPaperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
}): {
  paperContexts: PaperContextRef[];
  pdfPaperContexts: PaperContextRef[];
  fullTextPaperContexts: PaperContextRef[];
} {
  const allPaperContexts = normalizePaperContexts(params.paperContexts);
  const allFullTextPaperContexts = normalizePaperContexts(
    params.fullTextPaperContexts,
  );
  const pdfPaperContexts = normalizePaperContexts([
    ...(params.pdfPaperContexts || []),
    ...allPaperContexts.filter((paper) => paper.contentSourceMode === "pdf"),
    ...allFullTextPaperContexts.filter(
      (paper) => paper.contentSourceMode === "pdf",
    ),
  ]).map((paper) => ({ ...paper, contentSourceMode: "pdf" as const }));
  const pdfKeys = new Set(
    pdfPaperContexts.map((paper) => `${paper.itemId}:${paper.contextItemId}`),
  );
  const fullTextPaperContexts = allFullTextPaperContexts.filter(
    (paper) => !pdfKeys.has(`${paper.itemId}:${paper.contextItemId}`),
  );
  const fullTextKeys = new Set(
    fullTextPaperContexts.map(
      (paper) => `${paper.itemId}:${paper.contextItemId}`,
    ),
  );
  return {
    paperContexts: allPaperContexts.filter((paper) => {
      const key = `${paper.itemId}:${paper.contextItemId}`;
      return !pdfKeys.has(key) && !fullTextKeys.has(key);
    }),
    pdfPaperContexts,
    fullTextPaperContexts,
  };
}

export const normalizeStoredPaperContextRoutesForTests =
  normalizeStoredPaperContextRoutes;

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
  const modelAttachments = Array.isArray(message.modelAttachments)
    ? message.modelAttachments.filter(
        (entry) =>
          Boolean(entry) &&
          typeof entry === "object" &&
          typeof entry.id === "string" &&
          Boolean(entry.id.trim()) &&
          typeof entry.name === "string" &&
          Boolean(entry.name.trim()),
      )
    : undefined;
  const generatedImages = normalizeGeneratedChatImages(message.generatedImages);
  const selectedTextContexts = synthesizeSelectedTextContexts({
    selectedTextContexts: message.selectedTextContexts,
    selectedTexts: message.selectedTexts,
    legacySelectedText: message.selectedText,
    selectedTextSources: message.selectedTextSources,
    selectedTextPaperContexts: message.selectedTextPaperContexts,
    selectedTextNoteContexts: message.selectedTextNoteContexts,
    sanitizeText,
  });
  const selectedTexts = selectedTextContexts.map((context) => context.text);
  const selectedTextSources = selectedTextContexts.map(
    (context) => context.source,
  );
  const selectedTextPaperContexts = selectedTextContexts.map(
    (context) => context.paperContext,
  );
  const selectedTextNoteContexts = selectedTextContexts.map(
    (context) => context.noteContext,
  );
  const forcedSkillIds = normalizeForcedSkillIds(message.forcedSkillIds);
  const { paperContexts, pdfPaperContexts, fullTextPaperContexts } =
    normalizeStoredPaperContextRoutes(message);
  const selectedCollectionContexts = normalizeCollectionContexts(
    message.selectedCollectionContexts,
  );
  const selectedTagContexts = normalizeTagContexts(message.selectedTagContexts);
  return {
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
    runMode: message.runMode,
    agentRunId: message.agentRunId,
    selectedText: selectedTexts[0] || message.selectedText,
    selectedTextExpanded: false,
    selectedTextContexts: selectedTextContexts.length
      ? selectedTextContexts
      : undefined,
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
    forcedSkillIds: forcedSkillIds.length ? forcedSkillIds : undefined,
    selectedTextExpandedIndex: -1,
    paperContexts: paperContexts.length ? paperContexts : undefined,
    pdfPaperContexts: pdfPaperContexts.length ? pdfPaperContexts : undefined,
    fullTextPaperContexts: fullTextPaperContexts.length
      ? fullTextPaperContexts
      : undefined,
    selectedCollectionContexts: selectedCollectionContexts.length
      ? selectedCollectionContexts
      : undefined,
    selectedTagContexts: selectedTagContexts.length
      ? selectedTagContexts
      : undefined,
    paperContextsExpanded: false,
    screenshotImages,
    attachments,
    modelAttachments,
    generatedImages: generatedImages.length ? generatedImages : undefined,
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
    quoteCitations: message.quoteCitations,
  };
}

export async function ensureConversationLoaded(
  item: Zotero.Item,
): Promise<void> {
  const conversationKey = getConversationKey(item);
  const conversationSystem = resolveConversationSystemForItem(item);
  if (isEffectiveWebChatRequest(item)) {
    isolateWebChatConversationKey(
      conversationKey,
      !webChatIsolatedConversationKeys.has(conversationKey),
    );
    conversationForkLinks.delete(conversationKey);
    return;
  }
  if (webChatIsolatedConversationKeys.delete(conversationKey)) {
    chatHistory.delete(conversationKey);
    loadedConversationKeys.delete(conversationKey);
    conversationForkLinks.delete(conversationKey);
  }

  if (loadedConversationKeys.has(conversationKey)) {
    await loadConversationForkLinkCache(conversationKey);
    return;
  }
  if (
    chatHistory.has(conversationKey) &&
    !blockedConversationLoadKeys.has(conversationKey)
  ) {
    await loadConversationForkLinkCache(conversationKey);
    loadedConversationKeys.add(conversationKey);
    return;
  }
  if (blockedConversationLoadKeys.has(conversationKey)) {
    chatHistory.delete(conversationKey);
    conversationForkLinks.delete(conversationKey);
    blockedConversationLoadKeys.delete(conversationKey);
  }

  const existingTask = loadingConversationTasks.get(conversationKey);
  if (existingTask) {
    await existingTask;
    return;
  }

  const task = (async () => {
    let shouldMarkLoaded = false;
    try {
      const validScope = await validateConversationScopeForItem({
        item,
        conversationKey,
        conversationSystem,
      });
      if (!validScope) {
        blockedConversationLoadKeys.add(conversationKey);
        chatHistory.set(conversationKey, []);
        conversationForkLinks.delete(conversationKey);
        return;
      }
      const storedMessages = await loadStoredConversationByKey(
        conversationKey,
        PERSISTED_HISTORY_LIMIT,
        conversationSystem,
      );
      if (
        webChatIsolatedConversationKeys.has(conversationKey) ||
        isEffectiveWebChatRequest(item)
      ) {
        isolateWebChatConversationKey(conversationKey, false);
        shouldMarkLoaded = true;
        return;
      }
      if (!storedMessagesMatchActivePaper(item, storedMessages)) {
        ztoolkit.log(
          `LLM: Refused to render conversation ${conversationKey} because stored paper contexts do not include the active paper.`,
        );
        blockedConversationLoadKeys.add(conversationKey);
        chatHistory.set(conversationKey, []);
        conversationForkLinks.delete(conversationKey);
        return;
      }
      const panelMessages = storedMessages.map((message) =>
        toPanelMessage(message),
      );
      const latestAssistantWithContext = [...storedMessages]
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" &&
            typeof message.contextTokens === "number",
        );
      if (latestAssistantWithContext?.contextTokens) {
        setContextUsageSnapshot(conversationKey, {
          contextTokens: latestAssistantWithContext.contextTokens,
          contextWindow: latestAssistantWithContext.contextWindow,
          estimated: true,
          source: "persisted",
        });
      }
      blockedConversationLoadKeys.delete(conversationKey);
      chatHistory.set(conversationKey, panelMessages);
      validateLoadedConversationQuoteMessages(panelMessages, conversationKey);
      await loadConversationForkLinkCache(conversationKey);
      shouldMarkLoaded = true;
    } catch (err) {
      ztoolkit.log("LLM: Failed to load chat history", err);
      if (!chatHistory.has(conversationKey)) {
        chatHistory.set(conversationKey, []);
      }
      conversationForkLinks.delete(conversationKey);
      shouldMarkLoaded = true;
    } finally {
      if (shouldMarkLoaded) {
        loadedConversationKeys.add(conversationKey);
      } else {
        loadedConversationKeys.delete(conversationKey);
      }
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

function getCachedAgentRunEvents(
  runId: string | undefined,
): AgentRunEventRecord[] {
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
  if (/(^|[/:])mimo-v2(?:\.5)?(?:-(?:pro|omni|flash))?(?:\b|[.-])/.test(name)) {
    return "mimo";
  }
  if (/(^|[/:])(?:qwen(?:\d+)?|qwq|qvq)(?:\b|[.-])/.test(name)) {
    return "qwen";
  }
  if (/(^|[/:])grok(?:\b|[.-])/.test(name)) {
    return "grok";
  }
  if (/(^|[/:.])claude(?:\b|[.-])/.test(name)) {
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
  providerProtocol?: ProviderProtocol,
): ReasoningOption[] {
  if (provider === "unsupported") return [];
  if (provider === "anthropic") {
    const resolvedProtocol =
      providerProtocol ||
      inferLegacyProviderProtocol({
        authMode: "api_key",
        apiBase: apiBase || "",
      });
    if (resolvedProtocol !== "anthropic_messages") return [];
  }
  return getRuntimeReasoningOptions(provider, modelName).map((option) => ({
    level: option.level as LLMReasoningLevel,
    enabled: option.enabled,
    label: option.label,
  }));
}

export function buildAssistantDisplayMarkdownForRender(
  message: Pick<Message, "text" | "quoteCitations" | "quoteDisplayOverride">,
): string {
  const display = getMessageQuoteDisplay(message);
  return buildQuoteDisplayMarkdown({
    markdown: sanitizeText(display.markdown),
    quoteCitations: display.quoteCitations,
  });
}

export { QUOTE_RENDER_OCCURRENCE_PATTERN };

export function buildPlainMarkdownClipboardText(
  markdownText: string,
  quoteCitations?: QuoteCitation[],
): string | null {
  const safeText = buildQuoteExpandedMarkdown({
    markdown: sanitizeText(markdownText).trim(),
    quoteCitations,
  });
  return safeText || null;
}

/**
 * Prepare both clipboard forms from markdown. Quote anchors are expanded before
 * rendering so structural citation tokens never leak into copied responses.
 */
export function buildRenderedMarkdownClipboardPayload(
  markdownText: string,
  quoteCitations?: QuoteCitation[],
): { plainText: string; renderedHtml: string } | null {
  const safeText = buildPlainMarkdownClipboardText(
    markdownText,
    quoteCitations,
  );
  if (!safeText) return null;

  let renderedHtml = "";
  try {
    renderedHtml = renderMarkdownForNote(safeText);
  } catch (err) {
    ztoolkit.log("LLM: Copy markdown render error:", err);
  }
  return { plainText: safeText, renderedHtml };
}

/**
 * Render markdown text through renderMarkdownForNote and copy the result
 * to the clipboard as both text/html and text/plain.  When pasted into a
 * Zotero note, the HTML version is used — producing the same rendering as
 * "Save as note".  When pasted into a plain-text editor, the expanded markdown
 * is used — matching "Copy chat as md" without internal quote anchors.
 */
export async function copyRenderedMarkdownToClipboard(
  body: Element,
  markdownText: string,
  quoteCitations?: QuoteCitation[],
): Promise<void> {
  const payload = buildRenderedMarkdownClipboardPayload(
    markdownText,
    quoteCitations,
  );
  if (!payload) return;
  const { plainText: safeText, renderedHtml } = payload;

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
  providerProtocol?: ProviderProtocol,
): LLMReasoningConfig | undefined {
  const provider = detectReasoningProvider(modelName);
  if (provider === "unsupported") return undefined;
  const enabledLevels = getReasoningOptions(
    provider,
    modelName,
    apiBase,
    providerProtocol,
  )
    .filter((option) => option.enabled)
    .map((option) => option.level);
  if (!enabledLevels.length) return undefined;

  const cachedProvider = selectedReasoningProviderCache.get(itemId);
  const cachedLevel =
    cachedProvider === provider ? selectedReasoningCache.get(itemId) : null;
  let selectedLevel =
    cachedLevel ||
    getLastUsedReasoningLevelForProvider(provider) ||
    (provider === "anthropic" ? "none" : getLastUsedReasoningLevel() || "none");
  if (provider === "anthropic") {
    if (!enabledLevels.includes(selectedLevel as LLMReasoningLevel)) {
      selectedLevel = "none";
    }
  } else if (
    selectedLevel === "none" ||
    !enabledLevels.includes(selectedLevel as LLMReasoningLevel)
  ) {
    selectedLevel = enabledLevels[0];
  }
  selectedReasoningCache.set(itemId, selectedLevel);
  selectedReasoningProviderCache.set(itemId, provider);
  setLastUsedReasoningLevelForProvider(provider, selectedLevel);
  if (selectedLevel === "none") return undefined;

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

function syncInlineActionCardAttr(body: Element): void {
  const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
  if (!panelRoot) return;
  const hasCard = Boolean(
    body.querySelector(".llm-action-inline-card, .llm-action-progress-card"),
  );
  if (hasCard) {
    panelRoot.dataset.hasActionCard = "true";
  } else {
    delete panelRoot.dataset.hasActionCard;
  }
}

function findNativeMcpActionCard(
  chatBox: HTMLElement,
  requestId: string,
): HTMLElement | null {
  const cards = Array.from(
    chatBox.querySelectorAll(
      ".llm-agent-hitl-card[data-request-id], .llm-action-inline-card[data-request-id]",
    ),
  ) as HTMLElement[];
  return cards.find((card) => card.dataset.requestId === requestId) || null;
}

function scrollNativeMcpActionCardIntoView(
  chatBox: HTMLElement,
  card: HTMLElement,
): void {
  const scroll = () => {
    try {
      card.scrollIntoView({ block: "end" });
    } catch {
      // Older Zotero runtimes can be picky about scrollIntoView options.
    }
    chatBox.scrollTop = chatBox.scrollHeight;
  };
  scroll();
  const view = chatBox.ownerDocument?.defaultView;
  view?.requestAnimationFrame?.(scroll);
  view?.setTimeout(scroll, 80);
}

let codexNativeApprovalRequestCounter = 0;

function closeNativeMcpActionCard(body: Element, requestId?: string): void {
  const ui = getPanelRequestUI(body);
  const chatBox = ui.chatBox;
  if (!chatBox) return;
  let card: Element | null = null;
  if (requestId) {
    card =
      findNativeMcpActionCard(chatBox, requestId) ||
      (
        Array.from(
          chatBox.querySelectorAll(".llm-action-inline-card"),
        ) as HTMLElement[]
      ).find((entry) => entry.dataset.requestId === requestId) ||
      null;
  } else {
    card = chatBox.querySelector(".llm-action-inline-card");
  }
  card?.remove();
  syncInlineActionCardAttr(body);
}

function showNativeMcpActionCard(
  body: Element,
  requestId: string,
  action: AgentPendingAction,
): Promise<AgentConfirmationResolution> {
  return new Promise((resolve) => {
    ztoolkit.log("Codex app-server native confirmation requested", {
      requestId,
      toolName: action.toolName,
      mode: action.mode || "approval",
      title: action.title,
    });
    const ui = getPanelRequestUI(body);
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc || !ui.chatBox) {
      ztoolkit.log("Codex app-server native confirmation unavailable", {
        requestId,
        reason: "missing_panel_review_card_ui",
      });
      throw new Error(
        "Zotero review card UI is unavailable for native confirmation.",
      );
    }

    try {
      getAgentApi().registerPendingConfirmation(requestId, (resolution) => {
        ztoolkit.log("Codex app-server native confirmation resolved", {
          requestId,
          approved: resolution.approved,
          actionId: resolution.actionId,
        });
        closeNativeMcpActionCard(body, requestId);
        resolve(resolution);
      });
    } catch (error) {
      ztoolkit.log("Codex app-server native confirmation unavailable", {
        requestId,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw new Error(
        `Zotero review card UI could not register native confirmation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const renderedCard = findNativeMcpActionCard(ui.chatBox, requestId);
    if (renderedCard) {
      scrollNativeMcpActionCardIntoView(ui.chatBox, renderedCard);
      syncInlineActionCardAttr(body);
      ztoolkit.log("Codex app-server native confirmation rendered", {
        requestId,
        toolName: action.toolName,
        mode: action.mode || "approval",
        source: "trace",
      });
      return;
    }
    ui.chatBox.querySelector(".llm-action-inline-card")?.remove();
    const wrapper = ownerDoc.createElement("div");
    wrapper.className = "llm-action-inline-card llm-action-inline-card-review";
    wrapper.dataset.requestId = requestId;
    wrapper.appendChild(
      renderPendingActionCard(ownerDoc, { requestId, action }),
    );
    ui.chatBox.appendChild(wrapper);
    scrollNativeMcpActionCardIntoView(ui.chatBox, wrapper);
    syncInlineActionCardAttr(body);
    ztoolkit.log("Codex app-server native confirmation rendered", {
      requestId,
      toolName: action.toolName,
      mode: action.mode || "approval",
      source: "inline",
    });
  });
}

type CodexNativeApprovalTrace = {
  noteMcpConfirmationRequired?: (
    requestId: string,
    action: AgentPendingAction,
  ) => void;
  noteMcpConfirmationResolved?: (
    requestId: string,
    resolution: AgentConfirmationResolution,
  ) => void;
};

export async function resolveCodexNativeApprovalWithOptionalReviewCard(params: {
  body: Element;
  request: CodexNativeApprovalRequest;
  trace?: CodexNativeApprovalTrace | null;
  setStatusSafely: (
    text: string,
    kind: Parameters<typeof setStatus>[2],
  ) => void;
  isNativeApprovalsEnabled?: () => boolean;
  showActionCard?: (
    body: Element,
    requestId: string,
    action: AgentPendingAction,
  ) => Promise<AgentConfirmationResolution>;
  nextRequestId?: () => string;
}): Promise<unknown> {
  const defaultDecision = resolveCodexNativeApprovalRequest(params.request);
  if (defaultDecision.approved) {
    params.setStatusSafely("Codex approved Zotero MCP access", "sending");
    return defaultDecision.response;
  }
  if (defaultDecision.reason === "unsupported_mcp_elicitation") {
    params.setStatusSafely(
      "Codex declined unsupported MCP elicitation",
      "sending",
    );
    return defaultDecision.response;
  }
  if (
    !(
      params.isNativeApprovalsEnabled?.() ??
      isCodexAppServerNativeApprovalsEnabled()
    ) ||
    !isCodexNativeBuiltInApprovalRequest(params.request)
  ) {
    params.setStatusSafely(
      "Codex denied a built-in or untrusted approval request",
      "error",
    );
    return defaultDecision.response;
  }

  const requestId =
    params.nextRequestId?.() ||
    `codex-native-approval-${Date.now()}-${++codexNativeApprovalRequestCounter}`;
  const action = buildCodexNativeApprovalPendingAction(params.request);
  const showActionCard = params.showActionCard || showNativeMcpActionCard;
  try {
    params.setStatusSafely("Codex is waiting for your approval", "sending");
    params.trace?.noteMcpConfirmationRequired?.(requestId, action);
    const resolution = await showActionCard(params.body, requestId, action);
    params.trace?.noteMcpConfirmationResolved?.(requestId, resolution);
    return buildCodexNativeApprovalResponseFromResolution(
      params.request,
      resolution,
    );
  } catch (error) {
    if (typeof ztoolkit !== "undefined") {
      ztoolkit.log(
        "Codex app-server native approval UI unavailable; denying request",
        {
          method: params.request.method,
          reason: error instanceof Error ? error.message : String(error),
        },
      );
    }
    params.setStatusSafely(
      "Codex denied a built-in approval request because the approval UI was unavailable",
      "error",
    );
    return defaultDecision.response;
  }
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

function getPanelBodyConversationKey(
  body: Element,
  fallbackItem?: Zotero.Item | null,
): number | null {
  const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
  const displayedKey = Number(panelRoot?.dataset.itemId || 0);
  if (Number.isFinite(displayedKey) && displayedKey > 0) {
    return displayedKey;
  }
  if (fallbackItem) {
    return getConversationKey(fallbackItem);
  }
  const getItem = activeContextPanels.get(body);
  const item = getItem?.() || null;
  if (item) {
    return getConversationKey(item);
  }
  return null;
}

function cleanupDisconnectedPanelBody(body: Element): void {
  activeContextPanels.delete(body);
  activeContextPanelStateSync.delete(body);
}

function visitConversationPanelBodies(
  conversationKey: number,
  primaryBody: Element | null | undefined,
  primaryItem: Zotero.Item | null | undefined,
  visit: (body: Element) => void,
): void {
  const visited = new Set<Element>();
  const visitIfMatching = (
    body: Element,
    fallbackItem?: Zotero.Item | null,
  ) => {
    if (visited.has(body)) return;
    visited.add(body);
    if (!body.isConnected) {
      cleanupDisconnectedPanelBody(body);
      return;
    }
    if (getPanelBodyConversationKey(body, fallbackItem) !== conversationKey) {
      return;
    }
    visit(body);
  };

  if (primaryBody) {
    visitIfMatching(primaryBody, primaryItem);
  }
  for (const [body, getItem] of activeContextPanels.entries()) {
    visitIfMatching(body, getItem?.() || null);
  }
  for (const body of activeContextPanelStateSync.keys()) {
    visitIfMatching(body);
  }
}

function syncRequestUIForConversation(
  conversationKey: number,
  primaryBody?: Element | null,
  primaryItem?: Zotero.Item | null,
): void {
  visitConversationPanelBodies(
    conversationKey,
    primaryBody,
    primaryItem,
    (body) => activeContextPanelStateSync.get(body)?.(),
  );
}

function setPendingRequestIdAndSync(
  conversationKey: number,
  requestId: number,
  primaryBody?: Element | null,
  primaryItem?: Zotero.Item | null,
): void {
  setPendingRequestId(conversationKey, requestId);
  syncRequestUIForConversation(conversationKey, primaryBody, primaryItem);
}

export function clearPendingRequestIdAndSync(
  conversationKey: number,
  primaryBody?: Element | null,
  primaryItem?: Zotero.Item | null,
): void {
  setPendingRequestIdAndSync(conversationKey, 0, primaryBody, primaryItem);
}

function setStatusForConversationPanels(
  conversationKey: number,
  primaryBody: Element,
  primaryItem: Zotero.Item,
  primaryUi: PanelRequestUI,
  text: string,
  kind: Parameters<typeof setStatus>[2],
): void {
  visitConversationPanelBodies(
    conversationKey,
    primaryBody,
    primaryItem,
    (panelBody) => {
      const liveStatus = panelBody.querySelector(
        "#llm-status",
      ) as HTMLElement | null;
      const status =
        liveStatus ||
        (panelBody === primaryBody && primaryUi.status?.isConnected
          ? primaryUi.status
          : null);
      if (!status) return;
      const liveChatBox = panelBody.querySelector(
        "#llm-chat-box",
      ) as HTMLDivElement | null;
      const chatBox =
        liveChatBox ||
        (panelBody === primaryBody && primaryUi.chatBox?.isConnected
          ? primaryUi.chatBox
          : null);
      withScrollGuard(chatBox, conversationKey, () => {
        setStatus(status, text, kind);
      });
    },
  );
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
    refreshConversationPanels(body, item);
  };
  const setStatusSafely = (
    text: string,
    kind: Parameters<typeof setStatus>[2],
  ) => {
    setStatusForConversationPanels(conversationKey, body, item, ui, text, kind);
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

function resolveEffectiveProviderCapabilities(config: EffectiveRequestConfig) {
  return resolveProviderCapabilities({
    model: config.model || "",
    protocol: config.providerProtocol,
    authMode: config.authMode,
    apiBase: config.apiBase,
    inputMode: config.advanced?.inputMode,
  });
}

function supportsImageInputs(config: EffectiveRequestConfig): boolean {
  return resolveEffectiveProviderCapabilities(config).images;
}

function isCodexAppServerConversationRequest(params: {
  item: Zotero.Item;
  authMode?:
    | "api_key"
    | "codex_auth"
    | "codex_app_server"
    | "copilot_auth"
    | "webchat";
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
  authMode?:
    | "api_key"
    | "codex_auth"
    | "codex_app_server"
    | "copilot_auth"
    | "webchat";
  providerProtocol?: ProviderProtocol;
  modelProviderLabel?: string;
}): ConversationSystem {
  const itemSystem = resolveConversationSystemForItem(params.item);
  if (itemSystem) return itemSystem;
  if (isCodexAppServerConversationRequest(params)) return "codex";
  if (params.modelProviderLabel === "Claude Code") {
    return "claude_code";
  }
  return "upstream";
}

function resolveEffectiveRequestConfig(params: {
  item: Zotero.Item;
  model?: string;
  apiBase?: string;
  apiKey?: string;
  authMode?:
    | "api_key"
    | "codex_auth"
    | "codex_app_server"
    | "copilot_auth"
    | "webchat";
  providerProtocol?: ProviderProtocol;
  modelEntryId?: string;
  modelProviderLabel?: string;
  reasoning?: LLMReasoningConfig;
  advanced?: AdvancedModelParams;
}): EffectiveRequestConfig {
  if (isCodexAppServerConversationRequest(params)) {
    const model =
      (params.model || getCodexRuntimeModelPref()).trim() || "gpt-5.4";
    const reasoningMode = getCodexReasoningModePref();
    const reasoning =
      params.reasoning || buildCodexAppServerReasoningConfig(reasoningMode);
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
          providerProtocol: params.providerProtocol || "anthropic_messages",
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
  const providerProtocol =
    params.providerProtocol ||
    explicitEntry?.providerProtocol ||
    fallbackEntry?.providerProtocol;
  const reasoning =
    params.reasoning ||
    getSelectedReasoningForItem(
      params.item.id,
      model,
      apiBase,
      providerProtocol,
    );
  const advanced =
    params.advanced || explicitEntry?.advanced || fallbackEntry?.advanced;
  return {
    model,
    apiBase,
    apiKey,
    authMode,
    providerProtocol,
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

function resolveCodexNativeConversationScope(params: {
  item: Zotero.Item;
  contextSource?: ResolvedContextSource | null;
  conversationKey: number;
  title?: string;
}): CodexNativeConversationScope {
  const baseItem = resolveConversationBaseItem(params.item);
  const displayKind = resolveDisplayConversationKind(params.item);
  const activeNoteSession = resolveActiveNoteSession(params.item);
  const libraryID = Math.max(
    1,
    Math.floor(
      Number(
        params.item.libraryID ||
          baseItem?.libraryID ||
          (Zotero as unknown as { Libraries?: { userLibraryID?: unknown } })
            .Libraries?.userLibraryID ||
          1,
      ) || 1,
    ),
  );
  const kind = displayKind === "paper" ? "paper" : "global";
  const paperItemID =
    displayKind === "paper"
      ? Math.floor(Number(baseItem?.id || params.item.id || 0)) || undefined
      : undefined;
  const paperContext =
    displayKind === "paper"
      ? resolveAutoLoadedPaperContextForItem(
          params.item,
          params.contextSource,
        ) || resolvePaperContextRefFromItem(baseItem || params.item)
      : null;
  const paperTitle =
    sanitizeText(
      paperContext?.title ||
        String(
          baseItem?.getField?.("title") ||
            params.item.getField?.("title") ||
            "",
        ),
    ) || undefined;
  return {
    profileSignature: getCodexProfileSignature(),
    conversationKey: params.conversationKey,
    libraryID,
    kind,
    paperItemID,
    activeItemId: activeNoteSession?.noteId || paperItemID,
    activeContextItemId: paperContext?.contextItemId,
    activeNoteId: activeNoteSession?.noteId,
    activeNoteKind: activeNoteSession?.noteKind,
    activeNoteTitle: activeNoteSession?.title,
    activeNoteParentItemId: activeNoteSession?.parentItemId,
    libraryName: resolveLibraryDisplayName(libraryID),
    paperTitle,
    paperContext: paperContext || undefined,
    title: sanitizeText(params.title || "").slice(0, 64) || undefined,
  };
}

function formatCodexNativeDiagnosticsStatus(
  diagnostics: CodexNativeDiagnostics,
): string {
  const threadId = sanitizeText(diagnostics.threadId || "");
  const threadShort = threadId ? threadId.slice(0, 10) : "unknown";
  const source = sanitizeText(diagnostics.threadSource || "appServer");
  const libraryName = sanitizeText(diagnostics.libraryName || "");
  const libraryLabel = libraryName
    ? `${diagnostics.libraryID} ${libraryName}`
    : `${diagnostics.libraryID}`;
  const mcpLabel = diagnostics.mcpServerName
    ? `${sanitizeText(diagnostics.mcpServerName)} ${
        diagnostics.mcpReady ? "ready" : "not ready"
      }`
    : "MCP disabled";
  const historyLabel =
    diagnostics.historyVerified === undefined
      ? ""
      : `, history ${diagnostics.historyVerified ? "verified" : "unverified"}`;
  return `Codex app-server ${threadShort} (${source}), library ${libraryLabel}, ${mcpLabel}${historyLabel}`;
}

function buildCodexNativeSkillContext(params: {
  forcedSkillIds?: string[];
  selectedTextContexts?: SelectedTextContext[];
  resolvedSelectedTextAnchors?: ResolvedSelectedTextAnchor[];
  selectedTexts?: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  selectedTextNoteContexts?: (NoteContextRef | undefined)[];
  paperContexts?: PaperContextRef[];
  pdfPaperContexts?: PaperContextRef[];
  localDocuments?: readonly import("../../shared/types").LocalDocumentResource[];
  fullTextPaperContexts?: PaperContextRef[];
  pinnedPaperContexts?: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
  selectedTagContexts?: TagContextRef[];
  screenshots?: string[];
  attachments?: ChatAttachment[];
}): CodexNativeSkillContext {
  return {
    forcedSkillIds: params.forcedSkillIds?.length
      ? params.forcedSkillIds
      : undefined,
    selectedTextContexts: params.selectedTextContexts?.length
      ? params.selectedTextContexts
      : undefined,
    resolvedSelectedTextAnchors: params.resolvedSelectedTextAnchors?.length
      ? params.resolvedSelectedTextAnchors
      : undefined,
    selectedTexts: params.selectedTexts?.length
      ? params.selectedTexts
      : undefined,
    selectedTextSources: params.selectedTextSources?.length
      ? params.selectedTextSources
      : undefined,
    selectedTextPaperContexts: params.selectedTextPaperContexts?.some(Boolean)
      ? params.selectedTextPaperContexts
      : undefined,
    selectedTextNoteContexts: params.selectedTextNoteContexts?.some(Boolean)
      ? params.selectedTextNoteContexts
      : undefined,
    selectedPaperContexts: params.paperContexts?.length
      ? params.paperContexts
      : undefined,
    pdfPaperContexts: params.pdfPaperContexts?.length
      ? params.pdfPaperContexts
      : undefined,
    localDocuments: params.localDocuments?.length
      ? params.localDocuments
      : undefined,
    fullTextPaperContexts: params.fullTextPaperContexts?.length
      ? params.fullTextPaperContexts
      : undefined,
    pinnedPaperContexts: params.pinnedPaperContexts?.length
      ? params.pinnedPaperContexts
      : undefined,
    selectedCollectionContexts: params.selectedCollectionContexts?.length
      ? params.selectedCollectionContexts
      : undefined,
    selectedTagContexts: params.selectedTagContexts?.length
      ? params.selectedTagContexts
      : undefined,
    screenshots: params.screenshots?.length ? params.screenshots : undefined,
    attachments: params.attachments?.length ? params.attachments : undefined,
  };
}

type ContextPlanForRequest = {
  combinedContext: string;
  strategy: ContextAssemblyStrategy;
  assistantInstruction?: string;
  contextCache?: import("../../contextCache/manager").ContextCachePlan;
  paperContexts: PaperContextRef[];
  fullTextPaperContexts: PaperContextRef[];
  citationPaperContexts: PaperContextRef[];
  quoteCitations: QuoteCitation[];
  recentPaperContexts: PaperContextRef[];
  readStrategy?: LibraryChatReadStrategyDiagnostics;
  coverageReceipt?: LibraryChatCoverageReceipt;
  fullReadReceipt?: FullReadCoverageReceipt;
  modelImages?: string[];
};

type PreparedContextPlanChatRequest = {
  finalPrepared: PreparedChatRequest;
  systemMessages: string[];
  inputCapEffects: PreparedChatRequest["inputCap"]["effects"];
  workflowTestIntercepted: boolean;
};

async function prepareFinalContextPlanChatRequest(params: {
  requestParams: ChatParams;
  contextPlan: ContextPlanForRequest;
  combinedContext: string;
}): Promise<PreparedContextPlanChatRequest> {
  const previewSystemMessages = buildContextPlanSystemMessages({
    strategy: params.contextPlan.strategy,
    assistantInstruction: params.contextPlan.assistantInstruction,
    coverageReceiptText:
      params.contextPlan.fullReadReceipt?.text ||
      params.contextPlan.coverageReceipt?.text,
  });
  const preview = prepareChatRequest({
    ...params.requestParams,
    systemMessages: previewSystemMessages,
  });
  const systemMessages = buildContextPlanSystemMessages({
    strategy: params.contextPlan.strategy,
    assistantInstruction: params.contextPlan.assistantInstruction,
    coverageReceiptText:
      params.contextPlan.fullReadReceipt?.text ||
      params.contextPlan.coverageReceipt?.text,
    inputCapEffects: preview.inputCap.effects,
  });
  const finalPrepared = prepareChatRequest({
    ...params.requestParams,
    systemMessages,
  });
  const workflowTestFinalRequestInterceptor =
    getWorkflowTestFinalRequestInterceptor();
  let workflowTestIntercepted = false;
  if (workflowTestFinalRequestInterceptor) {
    workflowTestIntercepted =
      (await workflowTestFinalRequestInterceptor({
        prompt: params.requestParams.prompt,
        combinedContext: params.combinedContext,
        strategy: params.contextPlan.strategy,
        systemMessages,
        inputCapEffects: preview.inputCap.effects,
        readStrategy: params.contextPlan.readStrategy,
        coverageReceipt: params.contextPlan.coverageReceipt,
        fullReadReceipt: params.contextPlan.fullReadReceipt,
      })) === true;
  }
  return {
    finalPrepared,
    systemMessages,
    inputCapEffects: preview.inputCap.effects,
    workflowTestIntercepted,
  };
}

function shouldUseCodexNativeLightContext(params: {
  isCodexNativeTurn: boolean;
}): boolean {
  return params.isCodexNativeTurn && isCodexZoteroMcpToolsEnabled();
}

function buildLightCodexNativeMcpContextPlan(params: {
  paperContexts: PaperContextRef[];
  fullTextPaperContexts: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
  selectedTagContexts?: TagContextRef[];
  recentPaperContexts: PaperContextRef[];
  setStatusSafely: (
    text: string,
    kind: Parameters<typeof setStatus>[2],
  ) => void;
}): ContextPlanForRequest {
  params.setStatusSafely("Using Codex native Zotero tools", "sending");
  return {
    combinedContext: "",
    strategy: "general-retrieval",
    assistantInstruction: "",
    paperContexts: params.paperContexts,
    fullTextPaperContexts: params.fullTextPaperContexts,
    citationPaperContexts: mergeCitationPaperContexts(
      params.paperContexts,
      params.fullTextPaperContexts,
    ),
    quoteCitations: [],
    recentPaperContexts: params.recentPaperContexts,
  };
}

async function buildContextPlanForRequest(params: {
  item: Zotero.Item;
  contextSource?: ResolvedContextSource | null;
  question: string;
  images?: string[];
  selectedTextSources?: SelectedTextSource[];
  resolvedSelectedTextAnchors?: ResolvedSelectedTextAnchor[];
  paperContexts: PaperContextRef[];
  fullTextPaperContexts: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
  selectedTagContexts?: TagContextRef[];
  recentPaperContexts: PaperContextRef[];
  history: ChatMessage[];
  effectiveRequestConfig: EffectiveRequestConfig;
  pdfPaperContexts?: PaperContextRef[];
  pdfUploadSystemMessages?: string[];
  signal?: AbortSignal;
  setStatusSafely: (
    text: string,
    kind: Parameters<typeof setStatus>[2],
  ) => void;
}): Promise<ContextPlanForRequest> {
  const pdfModePaperKeys = new Set(
    (params.pdfPaperContexts || []).map(
      (paper) => `${paper.itemId}:${paper.contextItemId}`,
    ),
  );
  const explicitPaperContext = normalizePaperContexts(
    params.contextSource?.paperContext
      ? [params.contextSource.paperContext]
      : [],
  )[0];
  const explicitContextItem =
    params.contextSource?.contextItem ||
    (explicitPaperContext
      ? Zotero.Items.get(explicitPaperContext.contextItemId) || null
      : null);
  const contextSource =
    params.contextSource ||
    (explicitPaperContext
      ? {
          contextItem: explicitContextItem,
          paperContext: explicitPaperContext,
          statusText: explicitPaperContext.attachmentTitle
            ? `using the selected ${explicitPaperContext.attachmentTitle} as context`
            : "using the selected attachment as context",
        }
      : resolveContextSourceItem(params.item));
  params.setStatusSafely(contextSource.statusText, "sending");
  const rawActiveContextItem = contextSource.contextItem;
  // If the active paper is in PDF mode (sent as file attachment),
  // exclude it from the text retrieval pipeline entirely.
  const activeContextItemInPdfMode = (() => {
    if (!rawActiveContextItem || !pdfModePaperKeys.size) return false;
    const autoLoaded = resolveAutoLoadedPaperContextForItem(
      params.item,
      contextSource,
    );
    if (!autoLoaded) return false;
    return pdfModePaperKeys.has(
      `${autoLoaded.itemId}:${autoLoaded.contextItemId}`,
    );
  })();
  const activeContextItem = activeContextItemInPdfMode
    ? null
    : rawActiveContextItem;
  const conversationMode: "open" | "paper" =
    resolveDisplayConversationKind(params.item) === "global" ? "open" : "paper";
  const systemPrompt = getStringPref("systemPrompt") || undefined;

  const plan = await resolveMultiContextPlan({
    activeContextItem,
    conversationMode,
    question: params.question,
    contextPrefix: "",
    // Exclude PDF-mode papers from the text retrieval pipeline
    paperContexts: pdfModePaperKeys.size
      ? params.paperContexts.filter(
          (p) => !pdfModePaperKeys.has(`${p.itemId}:${p.contextItemId}`),
        )
      : params.paperContexts,
    fullTextPaperContexts: params.fullTextPaperContexts,
    collectionContexts: params.selectedCollectionContexts,
    tagContexts: params.selectedTagContexts,
    historyPaperContexts: params.recentPaperContexts,
    history: params.history,
    images: params.images,
    model: params.effectiveRequestConfig.model,
    reasoning: params.effectiveRequestConfig.reasoning,
    advanced: params.effectiveRequestConfig.advanced,
    apiBase: params.effectiveRequestConfig.apiBase,
    apiKey: params.effectiveRequestConfig.apiKey,
    authMode: params.effectiveRequestConfig.authMode,
    providerProtocol: params.effectiveRequestConfig.providerProtocol,
    resolvedSelectedTextAnchors: params.resolvedSelectedTextAnchors,
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
      plan.contextCache?.enabled && plan.contextCache.statusLabel
        ? plan.strategy === "paper-cache-full"
          ? `${plan.contextCache.statusLabel} (${plan.selectedPaperCount} papers)`
          : plan.contextCache.statusLabel
        : plan.strategy === "paper-first-full"
          ? "Using full paper text (first turn)"
          : plan.strategy === "paper-exhaustive-full"
            ? plan.fullReadReceipt?.complete
              ? `Read full text (${plan.fullReadReceipt.processedChunks} chunks)`
              : `Full-text read partial (${plan.fullReadReceipt?.processedChunks || 0}/${
                  plan.fullReadReceipt?.totalChunks || 0
                } chunks)`
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
    contextCache: plan.contextCache
      ? {
          enabled: plan.contextCache.enabled,
          mode: plan.contextCache.mode,
          provider: plan.contextCache.provider,
          reason: plan.contextCache.reason,
          contextTokens: plan.contextCache.contextTokens,
        }
      : undefined,
  });
  const noteContext = buildActiveNoteContextBlock(params.item).trim();
  const planContext = sanitizeText(plan.contextText || "").trim();
  // Include provider-uploaded PDF content (Qwen fileid://, Kimi extracted text)
  const uploadedPdfContext = (params.pdfUploadSystemMessages || [])
    .map((msg) => sanitizeText(msg).trim())
    .filter(Boolean)
    .join("\n\n");

  const combinedContext = [noteContext, planContext, uploadedPdfContext]
    .filter(Boolean)
    .join("\n\n");

  return {
    combinedContext,
    strategy: plan.strategy,
    assistantInstruction: plan.assistantInstruction,
    contextCache: plan.contextCache,
    paperContexts: params.paperContexts,
    fullTextPaperContexts: params.fullTextPaperContexts,
    citationPaperContexts: mergeCitationPaperContexts(
      params.paperContexts,
      params.fullTextPaperContexts,
      plan.citationPaperContexts,
    ),
    quoteCitations: plan.quoteCitations || [],
    recentPaperContexts: params.recentPaperContexts,
    readStrategy: plan.readStrategy,
    coverageReceipt: plan.coverageReceipt,
    fullReadReceipt: plan.fullReadReceipt,
    modelImages: plan.modelImages,
  };
}

function quoteSourcePaperKey(paper: PaperContextRef): string {
  return `${Math.floor(Number(paper.itemId || 0))}:${Math.floor(
    Number(paper.contextItemId || 0),
  )}:${paper.contentSourceMode || ""}`;
}

function cachedQuoteSourceText(contextItemId: number): string {
  const cached = pdfTextCache.get(contextItemId);
  return Array.isArray(cached?.chunks) ? cached.chunks.join("\n\n") : "";
}

function cachedQuoteSourceChunks(contextItemId: number): QuoteSourceText[] {
  const cached = pdfTextCache.get(contextItemId);
  if (!Array.isArray(cached?.chunks) || !cached.chunks.length) return [];
  const chunkMeta = Array.isArray(cached.chunkMeta) ? cached.chunkMeta : [];
  const out: QuoteSourceText[] = [];
  for (let index = 0; index < cached.chunks.length; index += 1) {
    const sourceText = sanitizeText(cached.chunks[index] || "").trim();
    if (!sourceText) continue;
    const meta = chunkMeta[index];
    out.push({
      sourceText,
      sectionLabel: meta?.sectionLabel,
      chunkKind: meta?.chunkKind,
      sourceFingerprint: meta?.sourceFingerprint,
      ...(meta?.pageStart !== undefined && meta?.pageStart === meta?.pageEnd
        ? { pageHintIndex: meta.pageStart }
        : {}),
    });
  }
  return out;
}

function hasCachedQuoteSourceText(contextItemId: number): boolean {
  return Boolean(cachedQuoteSourceText(contextItemId).trim());
}

function canUsePdfPageTextQuoteSource(
  paper: PaperContextRef,
  contextItem: Zotero.Item | null,
): boolean {
  if (!contextItem?.isAttachment?.()) return false;
  return !["markdown", "html", "txt", "docx"].includes(
    paper.contentSourceMode || "",
  );
}

function resolveQuoteSourceContextItem(
  paper: PaperContextRef,
): Zotero.Item | null {
  const contextItemId = Math.floor(Number(paper.contextItemId || 0));
  if (!Number.isFinite(contextItemId) || contextItemId <= 0) return null;
  try {
    const item = Zotero.Items.get(contextItemId);
    return item || null;
  } catch (error) {
    ztoolkit.log("LLM: unable to resolve quote source context item", {
      contextItemId,
      error,
    });
    return null;
  }
}

async function ensureQuoteSourceTextCachedForPaper(
  paper: PaperContextRef,
): Promise<void> {
  const contextItemId = Math.floor(Number(paper.contextItemId || 0));
  if (!Number.isFinite(contextItemId) || contextItemId <= 0) return;

  const contextItem = resolveQuoteSourceContextItem(paper);
  if (!contextItem) return;

  // An empty cache entry means an earlier extraction attempt did not provide
  // searchable text. Retry here before the provenance finalizer gives up.
  if (
    !hasCachedQuoteSourceText(contextItemId) &&
    pdfTextCache.has(contextItemId)
  ) {
    pdfTextCache.delete(contextItemId);
  }

  try {
    if ((contextItem as any).isNote?.()) {
      if (hasCachedQuoteSourceText(contextItemId)) return;
      await ensureNoteTextCached(contextItem);
    } else {
      await ensurePDFTextCached(contextItem, {
        sourceMode: paper.contentSourceMode,
      });
    }
  } catch (error) {
    ztoolkit.log("LLM: quote source text cache warm failed", {
      contextItemId,
      sourceMode: paper.contentSourceMode,
      error,
    });
  }
}

function cachedPdfPageQuoteSourcesForPaper(
  paper: PaperContextRef,
): QuoteSourceText[] {
  const contextItemId = Math.floor(Number(paper.contextItemId || 0));
  if (!Number.isFinite(contextItemId) || contextItemId <= 0) return [];
  const contextItem = resolveQuoteSourceContextItem(paper);
  if (!canUsePdfPageTextQuoteSource(paper, contextItem)) return [];
  const cached = getCachedPageTextForAttachment(contextItemId);
  const normalizedByPageIndex = new Map(
    (cached?.normalised || []).map((page) => [page.pageIndex, page]),
  );
  return (cached?.pages || []).flatMap((page) => {
    const sourceText = sanitizeText(page.text || "").trim();
    const normalizedPage = normalizedByPageIndex.get(page.pageIndex);
    return sourceText
      ? [
          {
            sourceText,
            textIndex: normalizedPage?.textIndex,
            pageHintIndex: page.pageIndex,
            pageHintLabel: page.pageLabel,
            sourceFingerprint: cached?.sourceFingerprint,
            requiresPageHint: true,
          },
        ]
      : [];
  });
}

function collectQuoteSourcePapers(
  ...groups: Array<PaperContextRef[] | undefined | null>
): PaperContextRef[] {
  const papers = normalizePaperContexts(groups.flatMap((group) => group || []));
  const seen = new Set<string>();
  const uniquePapers: PaperContextRef[] = [];
  for (const paper of papers) {
    const contextItemId = Number(paper.contextItemId || 0);
    if (!Number.isFinite(contextItemId) || contextItemId <= 0) continue;
    const key = quoteSourcePaperKey(paper);
    if (seen.has(key)) continue;
    seen.add(key);
    uniquePapers.push(paper);
  }
  return uniquePapers;
}

type QuoteSourceEvidence = {
  sourceTexts: QuoteSourceText[];
  complete: boolean;
};

function hasUnresolvedQuoteSourceScope(
  ...groups: Array<PaperContextRef[] | undefined | null>
): boolean {
  return groups.some((group) =>
    (group || []).some(
      (paper) =>
        !Number.isFinite(Number(paper?.itemId)) ||
        Number(paper?.itemId) <= 0 ||
        !Number.isFinite(Number(paper?.contextItemId)) ||
        Number(paper?.contextItemId) <= 0 ||
        !sanitizeText(paper?.title || "").trim(),
    ),
  );
}

function buildCachedQuoteSourceEvidenceForPaperContexts(
  ...groups: Array<PaperContextRef[] | undefined | null>
): QuoteSourceEvidence {
  const uniquePapers = collectQuoteSourcePapers(...groups);
  const out: QuoteSourceText[] = [];
  let complete =
    uniquePapers.length > 0 && !hasUnresolvedQuoteSourceScope(...groups);
  for (const paper of uniquePapers) {
    const contextItemId = Math.floor(Number(paper.contextItemId || 0));
    if (!Number.isFinite(contextItemId) || contextItemId <= 0) {
      complete = false;
      continue;
    }
    const contextItem = resolveQuoteSourceContextItem(paper);
    if (!contextItem) complete = false;
    const usesPdfPageText = canUsePdfPageTextQuoteSource(paper, contextItem);
    const pdfPageSources = cachedPdfPageQuoteSourcesForPaper(paper);
    for (const pageSource of pdfPageSources) {
      out.push({
        ...pageSource,
        sourceLabel: formatPaperSourceLabel(paper),
        metadataTexts: [paper.title, paper.attachmentTitle],
        sourceMatchSource: "pdf-page-text",
        contextItemId: paper.contextItemId,
        itemId: paper.itemId,
      });
    }
    const cachedChunks = cachedQuoteSourceChunks(contextItemId);
    const paperComplete = usesPdfPageText
      ? hasCompleteSearchablePageTextForAttachment(contextItemId)
      : cachedChunks.length > 0;
    if (!paperComplete) complete = false;
    if (!cachedChunks.length) continue;
    for (const chunk of cachedChunks) {
      out.push({
        ...chunk,
        requiresPageHint: usesPdfPageText,
        sourceLabel: formatPaperSourceLabel(paper),
        metadataTexts: [paper.title, paper.attachmentTitle],
        sourceMatchSource: "context-text",
        contextItemId: paper.contextItemId,
        itemId: paper.itemId,
      });
    }
  }
  return { sourceTexts: out, complete };
}

async function warmQuoteSourceCachesForPaperContexts(
  groups: Array<PaperContextRef[] | undefined | null>,
  options?: {
    yieldToMain?: () => Promise<void>;
    shouldContinue?: () => boolean;
  },
): Promise<void> {
  const uniquePapers = collectQuoteSourcePapers(...groups);
  for (const paper of uniquePapers) {
    if (options?.shouldContinue?.() === false) return;
    if (options?.yieldToMain) await options.yieldToMain();
    const contextItemId = Math.floor(Number(paper.contextItemId || 0));
    const contextItem = resolveQuoteSourceContextItem(paper);
    const usesPdfPageText =
      Number.isFinite(contextItemId) &&
      contextItemId > 0 &&
      canUsePdfPageTextQuoteSource(paper, contextItem);
    if (usesPdfPageText) {
      try {
        const activeReader = getActiveReaderForSelectedTab();
        const activeReaderItemId = Math.floor(
          Number(activeReader?._item?.id || activeReader?.itemID || 0),
        );
        await warmPageTextCacheForAttachment(contextItemId, {
          yieldToMain: options?.yieldToMain,
          shouldContinue: options?.shouldContinue,
          reader:
            activeReaderItemId === contextItemId ? activeReader : undefined,
        });
      } catch (error) {
        ztoolkit.log("LLM: PDF page quote source text cache warm failed", {
          contextItemId,
          error,
        });
      }
    } else {
      await ensureQuoteSourceTextCachedForPaper(paper);
    }
  }
}

function assistantMarkdownNeedsQuoteSourceSearch(markdown: string): boolean {
  return (
    /^[ \t]*>/.test(markdown || "") ||
    /\n[ \t]*>/.test(markdown || "") ||
    /\[\[quote:[A-Za-z0-9_-]+\]\]/.test(markdown || "")
  );
}

function assistantMarkdownNeedsBackgroundQuoteSearch(
  markdown: string,
  quoteCitations: QuoteCitation[] | undefined,
): boolean {
  const knownIds = new Set(
    (quoteCitations || []).map((citation) => citation.id),
  );
  let hasUnresolvedAnchor = false;
  const withoutResolvedAnchors = (markdown || "").replace(
    /\[\[quote:([A-Za-z0-9_-]+)\]\]/g,
    (token, id: string) => {
      if (knownIds.has(id)) return "";
      hasUnresolvedAnchor = true;
      return token;
    },
  );
  if (hasUnresolvedAnchor) return true;
  const withoutEmptyBlockquotes = withoutResolvedAnchors.replace(
    /^[ \t]*>[ \t]*$/gm,
    "",
  );
  return (
    /^[ \t]*>/.test(withoutEmptyBlockquotes) ||
    /\n[ \t]*>/.test(withoutEmptyBlockquotes)
  );
}

function countQuoteScopedPapers(
  pairedUserMessage?: Message | null,
  runtimeRequest?: AgentRuntimeRequest | null,
): number {
  const papers = [
    ...(pairedUserMessage?.paperContexts || []),
    ...(pairedUserMessage?.fullTextPaperContexts || []),
    ...(pairedUserMessage?.citationPaperContexts || []),
    ...(runtimeRequest?.selectedPaperContexts || []),
    ...(runtimeRequest?.fullTextPaperContexts || []),
    ...(runtimeRequest?.citationPaperContexts || []),
  ];
  const keys = new Set<string>();
  for (const paper of papers) {
    keys.add(quoteSourcePaperKey(paper));
  }
  return keys.size;
}

function shouldRequireBodyEvidenceQuoteSearch(params: {
  assistantMarkdown: string;
  pairedUserMessage?: Message | null;
  runtimeRequest?: AgentRuntimeRequest | null;
}): boolean {
  if (!assistantMarkdownNeedsQuoteSourceSearch(params.assistantMarkdown)) {
    return false;
  }
  const hasScopedPool = Boolean(
    params.pairedUserMessage?.selectedCollectionContexts?.length ||
    params.pairedUserMessage?.selectedTagContexts?.length ||
    params.runtimeRequest?.selectedCollectionContexts?.length ||
    params.runtimeRequest?.selectedTagContexts?.length ||
    countQuoteScopedPapers(params.pairedUserMessage, params.runtimeRequest) > 1,
  );
  if (!hasScopedPool) return false;
  const userText = [
    params.pairedUserMessage?.text,
    params.runtimeRequest?.userText,
  ]
    .filter(Boolean)
    .join("\n");
  if (/\b(?:abstract|title|front\s+matter)\b/i.test(userText)) {
    return false;
  }
  return true;
}

type AssistantQuoteFinalizationOptions = {
  pairedUserMessage?: Message | null;
  runtimeRequest?: AgentRuntimeRequest | null;
  paperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  citationPaperContexts?: PaperContextRef[];
  conversationKey?: number;
};

function hasOpenEndedQuoteSourceScope(
  options: AssistantQuoteFinalizationOptions,
): boolean {
  return Boolean(
    options.pairedUserMessage?.selectedCollectionContexts?.length ||
    options.pairedUserMessage?.selectedTagContexts?.length ||
    options.runtimeRequest?.selectedCollectionContexts?.length ||
    options.runtimeRequest?.selectedTagContexts?.length,
  );
}

function quoteSourcePaperContextGroups(
  options: AssistantQuoteFinalizationOptions,
): Array<PaperContextRef[] | undefined | null> {
  return [
    options.paperContexts,
    options.fullTextPaperContexts,
    options.citationPaperContexts,
    options.runtimeRequest?.selectedPaperContexts,
    options.runtimeRequest?.fullTextPaperContexts,
    options.runtimeRequest?.citationPaperContexts,
    options.pairedUserMessage?.paperContexts,
    options.pairedUserMessage?.fullTextPaperContexts,
    options.pairedUserMessage?.citationPaperContexts,
    options.pairedUserMessage?.selectedTextPaperContexts?.filter(
      (entry): entry is PaperContextRef => Boolean(entry),
    ),
  ];
}

function registeredQuoteCitationsForReview(
  markdown: string,
  quoteCitations: QuoteCitation[] | undefined,
): QuoteCitation[] {
  const anchoredIds = new Set(
    Array.from(
      (markdown || "").matchAll(/\[\[quote:([A-Za-z0-9_-]+)\]\]/g),
      (match) => match[1],
    ),
  );
  return (quoteCitations || []).filter(
    (citation) =>
      anchoredIds.has(citation.id) ||
      citation.sourceMatchKind === "selected-text" ||
      citation.sourceMatchKind === "trusted",
  );
}

const MAX_QUOTE_VALIDATION_DECISION_ENTRIES = 1000;
const MAX_QUOTE_VALIDATION_DECISION_BYTES = 4 * 1024 * 1024;
const MAX_QUOTE_SOURCE_INDEX_ENTRIES = 64;
const MAX_QUOTE_SOURCE_INDEX_BYTES = 2 * 1024 * 1024;
const QUOTE_VALIDATION_POLICY_VERSION = 5;
type QuoteValidationDecision = ReturnType<
  typeof finalizeAssistantQuoteCitations
>;
type CachedQuoteValidationDecision = {
  decision: QuoteValidationDecision;
  validationSignature: string;
  estimatedBytes: number;
};
const quoteValidationDecisionCache = new Map<
  string,
  CachedQuoteValidationDecision
>();
let quoteValidationDecisionCacheBytes = 0;
let quoteValidationDecisionCacheHits = 0;
let quoteValidationDecisionComputations = 0;
type CachedQuoteSourceIndex = {
  evidenceSignature: string;
  sourceIndex: ReturnType<typeof buildQuoteSourceIndex>;
  estimatedBytes: number;
};
const quoteSourceIndexCache = new Map<string, CachedQuoteSourceIndex>();
let quoteSourceIndexCacheBytes = 0;
let quoteSourceIndexCacheHits = 0;
let quoteSourceIndexBuilds = 0;

function hashQuoteValidationText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function quoteValidationCacheKey(signature: string): string {
  return `${signature.length}:${hashQuoteValidationText(signature)}`;
}

function buildQuoteValidationEvidenceSignature(
  evidence: QuoteSourceEvidence,
): string | null {
  if (!evidence.sourceTexts.length) return evidence.complete ? "empty:1" : null;
  const parts: string[] = [];
  for (const source of evidence.sourceTexts) {
    const fingerprint = sanitizeText(
      String(source.sourceFingerprint || ""),
    ).trim();
    if (!fingerprint) return null;
    parts.push(
      [
        Math.floor(Number(source.contextItemId || 0)),
        Math.floor(Number(source.itemId || 0)),
        fingerprint,
        Math.floor(Number(source.pageHintIndex ?? -1)),
        String(source.sourceText || source.text || "").length,
      ].join(":"),
    );
  }
  return `${evidence.complete ? 1 : 0}\u241f${parts.sort().join("\u241e")}`;
}

function getOrBuildCachedQuoteSourceIndex(
  evidenceSignature: string,
  sourceTexts: QuoteSourceText[],
): ReturnType<typeof buildQuoteSourceIndex> {
  const key = quoteValidationCacheKey(evidenceSignature);
  const cached = quoteSourceIndexCache.get(key);
  if (cached?.evidenceSignature === evidenceSignature) {
    quoteSourceIndexCache.delete(key);
    quoteSourceIndexCache.set(key, cached);
    quoteSourceIndexCacheHits += 1;
    return cached.sourceIndex;
  }

  const sourceIndex = buildQuoteSourceIndex({ sourceTexts });
  quoteSourceIndexBuilds += 1;
  // Source strings and normalized indexes are shared with the page-text cache.
  // Count this cache's keys, labels, entry shells, and reference overhead only.
  const estimatedBytes =
    evidenceSignature.length * 2 +
    sourceIndex.sources.reduce(
      (total, source) =>
        total +
        256 +
        source.citationLabel.length * 2 +
        (source.sectionLabel?.length || 0) * 2,
      0,
    );
  if (estimatedBytes <= MAX_QUOTE_SOURCE_INDEX_BYTES) {
    const existing = quoteSourceIndexCache.get(key);
    if (existing) quoteSourceIndexCacheBytes -= existing.estimatedBytes;
    quoteSourceIndexCache.delete(key);
    quoteSourceIndexCache.set(key, {
      evidenceSignature,
      sourceIndex,
      estimatedBytes,
    });
    quoteSourceIndexCacheBytes += estimatedBytes;
    while (
      quoteSourceIndexCache.size > MAX_QUOTE_SOURCE_INDEX_ENTRIES ||
      quoteSourceIndexCacheBytes > MAX_QUOTE_SOURCE_INDEX_BYTES
    ) {
      const oldestKey = quoteSourceIndexCache.keys().next().value as
        | string
        | undefined;
      if (!oldestKey) break;
      const oldest = quoteSourceIndexCache.get(oldestKey);
      quoteSourceIndexCache.delete(oldestKey);
      quoteSourceIndexCacheBytes -= oldest?.estimatedBytes || 0;
    }
  }
  return sourceIndex;
}

function getCachedQuoteValidationDecision(
  key: string,
  validationSignature: string,
): QuoteValidationDecision | null {
  const cached = quoteValidationDecisionCache.get(key);
  if (!cached || cached.validationSignature !== validationSignature)
    return null;
  quoteValidationDecisionCache.delete(key);
  quoteValidationDecisionCache.set(key, cached);
  quoteValidationDecisionCacheHits += 1;
  return {
    markdown: cached.decision.markdown,
    quoteCitations: cached.decision.quoteCitations.map((citation) => ({
      ...citation,
    })),
  };
}

function cacheQuoteValidationDecision(
  key: string,
  validationSignature: string,
  decision: QuoteValidationDecision,
): void {
  const serialized = JSON.stringify(decision);
  const estimatedBytes =
    serialized.length * 2 + key.length * 2 + validationSignature.length * 2;
  if (estimatedBytes > MAX_QUOTE_VALIDATION_DECISION_BYTES) return;
  const existing = quoteValidationDecisionCache.get(key);
  if (existing) {
    quoteValidationDecisionCacheBytes -= existing.estimatedBytes;
    quoteValidationDecisionCache.delete(key);
  }
  quoteValidationDecisionCache.set(key, {
    decision: {
      markdown: decision.markdown,
      quoteCitations: decision.quoteCitations.map((citation) => ({
        ...citation,
      })),
    },
    validationSignature,
    estimatedBytes,
  });
  quoteValidationDecisionCacheBytes += estimatedBytes;
  while (
    quoteValidationDecisionCache.size > MAX_QUOTE_VALIDATION_DECISION_ENTRIES ||
    quoteValidationDecisionCacheBytes > MAX_QUOTE_VALIDATION_DECISION_BYTES
  ) {
    const oldestKey = quoteValidationDecisionCache.keys().next().value as
      | string
      | undefined;
    if (!oldestKey) break;
    const oldest = quoteValidationDecisionCache.get(oldestKey);
    quoteValidationDecisionCache.delete(oldestKey);
    quoteValidationDecisionCacheBytes -= oldest?.estimatedBytes || 0;
  }
}

export function resetQuoteValidationDecisionCacheForTests(): void {
  quoteValidationDecisionCache.clear();
  quoteValidationDecisionCacheBytes = 0;
  quoteValidationDecisionCacheHits = 0;
  quoteValidationDecisionComputations = 0;
  quoteSourceIndexCache.clear();
  quoteSourceIndexCacheBytes = 0;
  quoteSourceIndexCacheHits = 0;
  quoteSourceIndexBuilds = 0;
}

export function getQuoteValidationDecisionCacheStatsForTests(): {
  entries: number;
  bytes: number;
  hits: number;
  computations: number;
  sourceIndexEntries: number;
  sourceIndexBytes: number;
  sourceIndexHits: number;
  sourceIndexBuilds: number;
} {
  return {
    entries: quoteValidationDecisionCache.size,
    bytes: quoteValidationDecisionCacheBytes,
    hits: quoteValidationDecisionCacheHits,
    computations: quoteValidationDecisionComputations,
    sourceIndexEntries: quoteSourceIndexCache.size,
    sourceIndexBytes: quoteSourceIndexCacheBytes,
    sourceIndexHits: quoteSourceIndexCacheHits,
    sourceIndexBuilds: quoteSourceIndexBuilds,
  };
}

export function primeQuoteValidationDecisionCacheForTests(
  validationSignature: string,
  payloadChars = 1,
): void {
  cacheQuoteValidationDecision(
    quoteValidationCacheKey(validationSignature),
    validationSignature,
    {
      markdown: "x".repeat(Math.max(1, payloadChars)),
      quoteCitations: [],
    },
  );
}

export function hasQuoteValidationDecisionForTests(
  validationSignature: string,
): boolean {
  const cached = quoteValidationDecisionCache.get(
    quoteValidationCacheKey(validationSignature),
  );
  return cached?.validationSignature === validationSignature;
}

export function primeQuoteSourceIndexCacheForTests(
  evidenceSignature: string,
  sourceTexts: QuoteSourceText[],
): void {
  getOrBuildCachedQuoteSourceIndex(evidenceSignature, sourceTexts);
}

export function hasQuoteSourceIndexForTests(
  evidenceSignature: string,
): boolean {
  const cached = quoteSourceIndexCache.get(
    quoteValidationCacheKey(evidenceSignature),
  );
  return cached?.evidenceSignature === evidenceSignature;
}

function quoteDisplayOverridesEqual(
  left: Message["quoteDisplayOverride"],
  right: Message["quoteDisplayOverride"],
): boolean {
  if (left === right) return true;
  if (!left || !right || left.markdown !== right.markdown) return false;
  const leftCitations = left.quoteCitations || [];
  const rightCitations = right.quoteCitations || [];
  return (
    leftCitations.length === rightCitations.length &&
    leftCitations.every(
      (citation, index) =>
        JSON.stringify(citation) === JSON.stringify(rightCitations[index]),
    )
  );
}

async function applyAssistantMessageQuoteGate(
  assistantMessage: Message,
  markdown: string,
  quoteCitations: QuoteCitation[] | undefined,
  evidence: QuoteSourceEvidence,
  options: AssistantQuoteFinalizationOptions,
  preparedSourceIndex?: ReturnType<typeof buildQuoteSourceIndex>,
  cooperativeOptions?: {
    yieldToMain: () => Promise<void>;
    shouldContinue?: () => boolean;
  },
): Promise<boolean> {
  const requireBodyEvidenceQuotes = shouldRequireBodyEvidenceQuoteSearch({
    assistantMarkdown: markdown,
    pairedUserMessage: options.pairedUserMessage,
    runtimeRequest: options.runtimeRequest,
  });
  const sourceEvidenceComplete =
    evidence.complete && !hasOpenEndedQuoteSourceScope(options);
  const evidenceSignature = buildQuoteValidationEvidenceSignature(evidence);
  const reviewCitations = registeredQuoteCitationsForReview(
    markdown,
    quoteCitations,
  );
  const validationSignature = evidenceSignature
    ? [
        `policy:${QUOTE_VALIDATION_POLICY_VERSION}`,
        evidenceSignature,
        sourceEvidenceComplete ? "complete" : "defer",
        requireBodyEvidenceQuotes ? "body" : "all",
        markdown,
        ...reviewCitations.map((citation) =>
          [
            citation.id,
            citation.contextItemId || "",
            citation.sourceFingerprint || "",
            citation.quoteText,
          ].join("\u241f"),
        ),
      ].join("\u241e")
    : null;
  const cacheKey = validationSignature
    ? quoteValidationCacheKey(validationSignature)
    : null;
  let finalized = cacheKey
    ? getCachedQuoteValidationDecision(cacheKey, validationSignature!)
    : null;
  if (!finalized) {
    quoteValidationDecisionComputations += 1;
    const sourceIndex = reviewCitations.length
      ? buildQuoteSourceIndex({
          quoteCitations: reviewCitations,
          sourceTexts: evidence.sourceTexts,
        })
      : preparedSourceIndex
        ? preparedSourceIndex
        : evidenceSignature
          ? getOrBuildCachedQuoteSourceIndex(
              evidenceSignature,
              evidence.sourceTexts,
            )
          : buildQuoteSourceIndex({ sourceTexts: evidence.sourceTexts });
    finalized = cooperativeOptions
      ? await finalizeAssistantQuoteCitationsCooperatively(
          {
            markdown,
            quoteCitations,
            sourceIndex,
            requireBodyEvidenceQuotes,
            quoteSourceReview: {
              sourceEvidenceComplete,
            },
          },
          cooperativeOptions,
        )
      : finalizeAssistantQuoteCitations({
          markdown,
          quoteCitations,
          sourceIndex,
          requireBodyEvidenceQuotes,
          quoteSourceReview: {
            sourceEvidenceComplete,
          },
        });
    if (!finalized) return false;
    if (cacheKey && validationSignature) {
      cacheQuoteValidationDecision(cacheKey, validationSignature, finalized);
    }
  }
  const finalizedQuoteCitations = finalized.quoteCitations.length
    ? finalized.quoteCitations
    : undefined;
  const displayChanged = finalized.markdown !== markdown;
  const nextOverride = displayChanged
    ? {
        markdown: finalized.markdown,
        quoteCitations: finalizedQuoteCitations,
      }
    : undefined;
  const changed = !quoteDisplayOverridesEqual(
    assistantMessage.quoteDisplayOverride,
    nextOverride,
  );
  assistantMessage.quoteDisplayOverride = nextOverride;
  return changed;
}

const quoteValidationSignatures = new WeakMap<Message, string>();
type PendingQuoteValidation = {
  assistantMessage: Message;
  rawMarkdown: string;
  rawQuoteCitations: QuoteCitation[] | undefined;
  options: AssistantQuoteFinalizationOptions;
  signature: string;
};
const pendingQuoteValidations = new Map<
  number,
  Map<Message, PendingQuoteValidation>
>();
const quoteValidationTasks = new Map<number, Promise<void>>();

function refreshConversationAfterQuoteValidation(
  conversationKey: number,
  changedMessages: ReadonlySet<Message>,
): void {
  for (const [body, getItem] of activeContextPanels.entries()) {
    if (!body.isConnected) continue;
    const item = getItem?.() || null;
    if (!item || getConversationKey(item) !== conversationKey) continue;
    refreshChat(body, item, {
      rerenderAssistantMessages: changedMessages,
    });
  }
}

type QuoteValidationIdleDeadline = {
  didTimeout: boolean;
  timeRemaining: () => number;
};

type QuoteValidationWindow = Window & {
  requestIdleCallback?: (
    callback: (deadline: QuoteValidationIdleDeadline) => void,
    options?: { timeout?: number },
  ) => number;
};

function getQuoteValidationWindow(
  conversationKey: number,
): QuoteValidationWindow | null {
  for (const [body, getItem] of activeContextPanels.entries()) {
    if (!body.isConnected) continue;
    const item = getItem?.() || null;
    if (!item || getConversationKey(item) !== conversationKey) continue;
    return (body.ownerDocument?.defaultView as QuoteValidationWindow) || null;
  }
  return null;
}

function conversationHasStreamingMessage(conversationKey: number): boolean {
  return Boolean(
    chatHistory.get(conversationKey)?.some((message) => message.streaming),
  );
}

// The first idle wait of a validation pass gates how soon the first quote block
// can flip to its verified/unverified state. Keep it short so the on-screen
// message classifies within a frame or two; the long tail stays cooperative.
const QUOTE_VALIDATION_PROMPT_IDLE_MS = 32;

/**
 * Order a validation batch so the messages nearest the bottom of the
 * conversation — the ones actually on screen when a chat is opened (it scrolls
 * to the latest message) — are classified first. Messages no longer present in
 * history are stale and sort last. Pure and non-mutating for testability.
 */
export function orderQuoteValidationBatchByViewportPriority<
  T extends { assistantMessage: Message },
>(batch: readonly T[], history: readonly Message[]): T[] {
  return batch
    .map((request, originalIndex) => ({
      request,
      originalIndex,
      historyIndex: history.indexOf(request.assistantMessage),
    }))
    .sort((a, b) => {
      if (a.historyIndex !== b.historyIndex) {
        return b.historyIndex - a.historyIndex;
      }
      return a.originalIndex - b.originalIndex;
    })
    .map((entry) => entry.request);
}

/**
 * Resolve the idle-callback timeout and setTimeout-fallback delay for a
 * validation wait. A `promptTimeoutMs` collapses both to a short, prompt budget;
 * otherwise the cooperative defaults apply (longer while panels are open to stay
 * responsive during heavy work).
 */
export function resolveQuoteValidationIdleTimeouts(
  hasActivePanels: boolean,
  promptTimeoutMs?: number,
): { idleTimeout: number; fallbackDelayMs: number } {
  if (typeof promptTimeoutMs === "number" && Number.isFinite(promptTimeoutMs)) {
    const clamped = Math.max(0, promptTimeoutMs);
    return { idleTimeout: clamped, fallbackDelayMs: clamped };
  }
  return { idleTimeout: 1200, fallbackDelayMs: hasActivePanels ? 250 : 16 };
}

async function waitForQuoteValidationIdle(
  conversationKey: number,
  shouldContinue: () => boolean = () => true,
  options?: { promptTimeoutMs?: number },
): Promise<boolean> {
  while (true) {
    if (!shouldContinue()) return false;
    const win = getQuoteValidationWindow(conversationKey);
    const { idleTimeout, fallbackDelayMs } = resolveQuoteValidationIdleTimeouts(
      activeContextPanels.size > 0,
      options?.promptTimeoutMs,
    );
    const deadline = await new Promise<QuoteValidationIdleDeadline>(
      (resolve) => {
        if (typeof win?.requestIdleCallback === "function") {
          win.requestIdleCallback(resolve, { timeout: idleTimeout });
          return;
        }
        const schedule = win?.setTimeout?.bind(win) || setTimeout;
        schedule(
          () =>
            resolve({
              didTimeout: false,
              timeRemaining: () => 8,
            }),
          fallbackDelayMs,
        );
      },
    );
    if (!shouldContinue()) return false;
    const currentWindow = getQuoteValidationWindow(conversationKey);
    const visibilityState = currentWindow?.document?.visibilityState;
    if (
      (activeContextPanels.size > 0 && !currentWindow) ||
      isQuoteValidationPreempted() ||
      conversationHasStreamingMessage(conversationKey) ||
      visibilityState === "hidden"
    ) {
      continue;
    }
    if (deadline.didTimeout || deadline.timeRemaining() >= 4) return true;
  }
}

function isPendingQuoteValidationCurrent(
  conversationKey: number,
  request: PendingQuoteValidation,
): boolean {
  return (
    quoteValidationSignatures.get(request.assistantMessage) ===
      request.signature &&
    Boolean(
      chatHistory.get(conversationKey)?.includes(request.assistantMessage),
    )
  );
}

function startConversationQuoteValidation(conversationKey: number): void {
  if (quoteValidationTasks.has(conversationKey)) return;
  const task = (async () => {
    const hasPendingRequest = () =>
      Boolean(pendingQuoteValidations.get(conversationKey)?.size);
    if (
      !(await waitForQuoteValidationIdle(conversationKey, hasPendingRequest, {
        promptTimeoutMs: QUOTE_VALIDATION_PROMPT_IDLE_MS,
      }))
    ) {
      return;
    }
    while (true) {
      const pending = pendingQuoteValidations.get(conversationKey);
      if (!pending?.size) break;
      pendingQuoteValidations.delete(conversationKey);
      // Classify the messages nearest the bottom (the ones on screen when the
      // chat opens) first, so their quotes flip without waiting on scrolled-off
      // history.
      const batch = orderQuoteValidationBatchByViewportPriority(
        Array.from(pending.values()),
        chatHistory.get(conversationKey) || [],
      );
      try {
        const batchHasCurrentRequest = () =>
          batch.some((request) =>
            isPendingQuoteValidationCurrent(conversationKey, request),
          );
        await warmQuoteSourceCachesForPaperContexts(
          batch.flatMap((request) =>
            quoteSourcePaperContextGroups(request.options),
          ),
          {
            yieldToMain: async () => {
              await waitForQuoteValidationIdle(
                conversationKey,
                batchHasCurrentRequest,
              );
            },
            shouldContinue: batchHasCurrentRequest,
          },
        );
        const preparedEvidence = new Map<
          PendingQuoteValidation,
          {
            evidence: QuoteSourceEvidence;
            sourceIndex?: ReturnType<typeof buildQuoteSourceIndex>;
          }
        >();
        for (const request of batch) {
          const hasIdleTime = await waitForQuoteValidationIdle(
            conversationKey,
            () => isPendingQuoteValidationCurrent(conversationKey, request),
          );
          if (!hasIdleTime) continue;
          const evidence = buildCachedQuoteSourceEvidenceForPaperContexts(
            ...quoteSourcePaperContextGroups(request.options),
          );
          const evidenceSignature =
            buildQuoteValidationEvidenceSignature(evidence);
          preparedEvidence.set(request, {
            evidence,
            sourceIndex: evidenceSignature
              ? getOrBuildCachedQuoteSourceIndex(
                  evidenceSignature,
                  evidence.sourceTexts,
                )
              : undefined,
          });
        }
        for (const request of batch) {
          const { assistantMessage, rawMarkdown, rawQuoteCitations, options } =
            request;
          const hasIdleTime = await waitForQuoteValidationIdle(
            conversationKey,
            () => isPendingQuoteValidationCurrent(conversationKey, request),
          );
          if (!hasIdleTime) continue;
          const isCurrent = isPendingQuoteValidationCurrent(
            conversationKey,
            request,
          );
          if (!isCurrent) continue;
          const prepared = preparedEvidence.get(request);
          if (!prepared) continue;
          const changed = await applyAssistantMessageQuoteGate(
            assistantMessage,
            rawMarkdown,
            rawQuoteCitations,
            prepared.evidence,
            options,
            prepared.sourceIndex,
            {
              yieldToMain: async () => {
                await waitForQuoteValidationIdle(conversationKey, () =>
                  isPendingQuoteValidationCurrent(conversationKey, request),
                );
              },
              shouldContinue: () =>
                isPendingQuoteValidationCurrent(conversationKey, request),
            },
          );
          if (changed) {
            // Flip this message the moment it is classified so quotes appear
            // progressively, rather than holding every result until the whole
            // batch finishes. The targeted re-render only rebuilds this one
            // message, and cached syntax highlighting keeps it cheap.
            refreshConversationAfterQuoteValidation(
              conversationKey,
              new Set([assistantMessage]),
            );
          }
        }
      } finally {
        for (const { assistantMessage, signature } of batch) {
          if (quoteValidationSignatures.get(assistantMessage) === signature) {
            quoteValidationSignatures.delete(assistantMessage);
          }
        }
      }
    }
  })().catch((error) => {
    ztoolkit.log("LLM: background quote validation failed", error);
  });
  quoteValidationTasks.set(conversationKey, task);
  void task.finally(() => {
    if (quoteValidationTasks.get(conversationKey) === task) {
      quoteValidationTasks.delete(conversationKey);
    }
    if (pendingQuoteValidations.get(conversationKey)?.size) {
      startConversationQuoteValidation(conversationKey);
    }
  });
}

function scheduleAssistantMessageQuoteValidation(
  assistantMessage: Message,
  rawMarkdown: string,
  rawQuoteCitations: QuoteCitation[] | undefined,
  options: AssistantQuoteFinalizationOptions,
): void {
  const conversationKey = Math.floor(Number(options.conversationKey || 0));
  if (
    !conversationKey ||
    !assistantMarkdownNeedsBackgroundQuoteSearch(rawMarkdown, rawQuoteCitations)
  ) {
    return;
  }
  const signature = `${assistantMessage.timestamp}\u241f${rawMarkdown}`;
  if (quoteValidationSignatures.get(assistantMessage) === signature) return;
  quoteValidationSignatures.set(assistantMessage, signature);
  let pending = pendingQuoteValidations.get(conversationKey);
  if (!pending) {
    pending = new Map();
    pendingQuoteValidations.set(conversationKey, pending);
  }
  pending.set(assistantMessage, {
    assistantMessage,
    rawMarkdown,
    rawQuoteCitations,
    options,
    signature,
  });
  startConversationQuoteValidation(conversationKey);
}

async function waitForConversationQuoteValidation(
  conversationKey: number,
): Promise<void> {
  while (
    quoteValidationTasks.has(conversationKey) ||
    pendingQuoteValidations.get(conversationKey)?.size
  ) {
    const task = quoteValidationTasks.get(conversationKey);
    if (task) {
      await task;
    } else {
      startConversationQuoteValidation(conversationKey);
      await quoteValidationTasks.get(conversationKey);
    }
  }
}

export async function waitForAssistantQuoteValidationForTests(
  conversationKey: number,
): Promise<void> {
  await waitForConversationQuoteValidation(conversationKey);
}

function clearPendingQuoteValidation(message: Message): void {
  quoteValidationSignatures.delete(message);
  for (const [conversationKey, pending] of pendingQuoteValidations.entries()) {
    pending.delete(message);
    if (!pending.size) {
      pendingQuoteValidations.delete(conversationKey);
    }
  }
}

function resetAssistantQuoteDisplay(message: Message): void {
  clearPendingQuoteValidation(message);
  message.quoteDisplayOverride = undefined;
}

function finalizeAssistantMessageQuoteCitations(
  assistantMessage: Message,
  options: AssistantQuoteFinalizationOptions = {},
): void {
  const rawMarkdown = assistantMessage.text || "";
  if (!assistantMarkdownNeedsQuoteSourceSearch(rawMarkdown)) {
    resetAssistantQuoteDisplay(assistantMessage);
    return;
  }
  const rawQuoteCitations = assistantMessage.quoteCitations?.map(
    (citation) => ({
      ...citation,
    }),
  );
  scheduleAssistantMessageQuoteValidation(
    assistantMessage,
    rawMarkdown,
    rawQuoteCitations,
    options,
  );
}

export const finalizeAssistantMessageQuoteCitationsForTests =
  finalizeAssistantMessageQuoteCitations;

function validateLoadedConversationQuoteMessages(
  messages: Message[],
  conversationKey: number,
): void {
  let pairedUserMessage: Message | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      pairedUserMessage = message;
      continue;
    }
    if (
      message.compactMarker ||
      !assistantMarkdownNeedsQuoteSourceSearch(message.text || "")
    ) {
      continue;
    }
    finalizeAssistantMessageQuoteCitations(message, {
      pairedUserMessage,
      conversationKey,
    });
  }
}

/**
 * Re-run the authoritative provenance gate after citation navigation has
 * populated fresher page-text evidence. This schedules the same background
 * validator used on load; navigation itself cannot change quote provenance.
 */
export function scheduleConversationQuoteRevalidation(
  conversationKey: number,
): void {
  const normalizedKey = Math.floor(Number(conversationKey || 0));
  if (!normalizedKey) return;
  const messages = chatHistory.get(normalizedKey);
  if (!messages?.length) return;
  validateLoadedConversationQuoteMessages(messages, normalizedKey);
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

function mountClaudeRoseThreeLoader(
  host: HTMLElement,
  startedAt: number,
): void {
  const doc = host.ownerDocument;
  if (!doc) return;
  const win = doc.defaultView;
  if (!win) return;

  const svg = doc.createElementNS(
    ROSE_LOADER_SVG_NS,
    "svg",
  ) as unknown as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("llm-rose-loader-svg");

  const group = doc.createElementNS(
    ROSE_LOADER_SVG_NS,
    "g",
  ) as unknown as SVGGElement;
  const path = doc.createElementNS(
    ROSE_LOADER_SVG_NS,
    "path",
  ) as unknown as SVGPathElement;
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
    const circle = doc.createElementNS(
      ROSE_LOADER_SVG_NS,
      "circle",
    ) as unknown as SVGCircleElement;
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
    group.setAttribute(
      "transform",
      `rotate(${getRotation(elapsedMs).toFixed(3)} 50 50)`,
    );
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
  | "generatedImages"
  | "reasoningSummary"
  | "reasoningDetails"
  | "reasoningOpen"
  | "webchatRunState"
  | "webchatCompletionReason"
  | "quoteCitations"
  | "quoteDisplayOverride"
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
      ? message.pendingAgentTraceEvents.map((entry) => ({
          ...entry,
          payload: { ...entry.payload },
        }))
      : undefined,
    generatedImages: message.generatedImages
      ? message.generatedImages.map((entry) => ({ ...entry }))
      : undefined,
    reasoningSummary: message.reasoningSummary,
    reasoningDetails: message.reasoningDetails,
    reasoningOpen: message.reasoningOpen,
    webchatRunState: message.webchatRunState,
    webchatCompletionReason: message.webchatCompletionReason,
    quoteCitations: message.quoteCitations
      ? message.quoteCitations.map((entry) => ({ ...entry }))
      : undefined,
    quoteDisplayOverride: message.quoteDisplayOverride
      ? {
          markdown: message.quoteDisplayOverride.markdown,
          quoteCitations: message.quoteDisplayOverride.quoteCitations?.map(
            (entry) => ({ ...entry }),
          ),
        }
      : undefined,
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
    ? snapshot.pendingAgentTraceEvents.map((entry) => ({
        ...entry,
        payload: { ...entry.payload },
      }))
    : undefined;
  message.generatedImages = snapshot.generatedImages
    ? snapshot.generatedImages.map((entry) => ({ ...entry }))
    : undefined;
  message.reasoningSummary = snapshot.reasoningSummary;
  message.reasoningDetails = snapshot.reasoningDetails;
  message.reasoningOpen = snapshot.reasoningOpen;
  message.webchatRunState = snapshot.webchatRunState;
  message.webchatCompletionReason = snapshot.webchatCompletionReason;
  message.quoteCitations = snapshot.quoteCitations
    ? snapshot.quoteCitations.map((entry) => ({ ...entry }))
    : undefined;
  message.quoteDisplayOverride = snapshot.quoteDisplayOverride
    ? {
        markdown: snapshot.quoteDisplayOverride.markdown,
        quoteCitations: snapshot.quoteDisplayOverride.quoteCitations?.map(
          (entry) => ({ ...entry }),
        ),
      }
    : undefined;
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

type CodexNativeTraceItemEvent = {
  id?: string;
  type?: string;
  role?: string;
  status?: string;
  summary?: string;
  details?: string;
  error?: string;
  name?: string;
  toolName?: string;
  title?: string;
  serverName?: string;
  arguments?: unknown;
  query?: string;
  action?: unknown;
  command?: string;
  cwd?: string;
  path?: string;
  result?: unknown;
  savedPath?: string;
  revisedPrompt?: string;
  exitCode?: number;
  durationMs?: number;
  changes?: unknown;
  success?: boolean;
  namespace?: string;
  model?: string;
  receiverThreadIds?: unknown;
  raw?: Record<string, unknown>;
};

type CodexNativeTraceDeltaEvent = {
  itemId?: string;
  delta: string;
};

type CodexNativeMcpToolActivityEvent = {
  requestId: string;
  phase: "started" | "completed";
  toolName: string;
  toolLabel?: string;
  serverName?: string;
  arguments?: unknown;
  ok?: boolean;
  error?: string;
  quoteCitations?: QuoteCitation[];
  artifacts?: AgentToolArtifact[];
};

type CodexToolActivityEventPayload = Extract<
  AgentEvent,
  { type: "codex_tool_activity" }
>;

function isCodexNativeAgentMessageItem(
  event: CodexNativeTraceItemEvent,
): boolean {
  const itemType = (event.type || "").replace(/[-_\s]+/g, "").toLowerCase();
  const role = (event.role || "").replace(/[-_\s]+/g, "").toLowerCase();
  return (
    itemType === "agentmessage" ||
    itemType === "assistantmessage" ||
    (itemType === "message" && (role === "assistant" || role === "agent"))
  );
}

function isCodexNativeToolItem(event: CodexNativeTraceItemEvent): boolean {
  const itemType = (event.type || "").replace(/[-_\s]+/g, "").toLowerCase();
  return (
    itemType.includes("toolcall") ||
    itemType.includes("tooluse") ||
    itemType.includes("mcptool")
  );
}

function readCodexNativeRawName(value: unknown): string {
  if (typeof value === "string") return sanitizeText(value).trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  for (const key of ["name", "toolName", "tool_name", "title", "id"]) {
    const text = sanitizeText(String(record[key] || "")).trim();
    if (text) return text;
  }
  return "";
}

function readCodexNativeRawField(
  event: CodexNativeTraceItemEvent,
  keys: string[],
): unknown {
  const raw = event.raw || {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) return raw[key];
  }
  return undefined;
}

function looksLikeCodexNativeToolName(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_./:-]*$/.test(value.trim());
}

function resolveCodexNativeToolName(
  event: CodexNativeTraceItemEvent,
): string | undefined {
  const candidates = [
    event.toolName,
    readCodexNativeRawName(
      readCodexNativeRawField(event, ["toolName", "tool_name", "tool"]),
    ),
    event.name && looksLikeCodexNativeToolName(event.name) ? event.name : "",
    readCodexNativeRawName(readCodexNativeRawField(event, ["name"])),
  ];
  for (const candidate of candidates) {
    const text = sanitizeText(candidate || "").trim();
    if (text && looksLikeCodexNativeToolName(text)) return text;
  }
  return undefined;
}

function resolveCodexNativeToolLabel(
  event: CodexNativeTraceItemEvent,
): string | undefined {
  const name = sanitizeText(event.name || "").trim();
  const title = sanitizeText(event.title || "").trim();
  const rawTitle = sanitizeText(
    String(readCodexNativeRawField(event, ["title"]) || ""),
  ).trim();
  for (const candidate of [title, rawTitle, name]) {
    if (candidate && !looksLikeCodexNativeToolName(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveCodexNativeToolServerName(
  event: CodexNativeTraceItemEvent,
): string | undefined {
  return (
    sanitizeText(event.serverName || "").trim() ||
    readCodexNativeRawName(
      readCodexNativeRawField(event, [
        "serverName",
        "server_name",
        "mcpServerName",
        "server",
      ]),
    ) ||
    undefined
  );
}

function resolveCodexNativeToolArguments(
  event: CodexNativeTraceItemEvent,
): unknown {
  return (
    event.arguments ??
    readCodexNativeRawField(event, ["arguments", "args", "input"])
  );
}

function humanizeCodexNativeItemType(type: string | undefined): string {
  return sanitizeText(type || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function compactCodexNativeTraceLine(
  text: string,
  maxLength = Number.MAX_SAFE_INTEGER,
): string {
  const clean = sanitizeText(text).replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function normalizeCodexNativeItemTypeKey(type: string | undefined): string {
  return sanitizeText(type || "")
    .replace(/[-_\s]+/g, "")
    .toLowerCase();
}

function getCodexNativeRawString(
  event: CodexNativeTraceItemEvent,
  keys: string[],
  maxLength = 4000,
): string {
  for (const key of keys) {
    const value =
      (event as unknown as Record<string, unknown>)[key] ??
      readCodexNativeRawField(event, [key]);
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text) return text.slice(0, maxLength);
  }
  return "";
}

function getCodexNativeStatus(event: CodexNativeTraceItemEvent): string {
  return (
    sanitizeText(event.status || "").trim() ||
    getCodexNativeRawString(event, ["status"], 120)
  );
}

function isCodexNativeItemType(
  event: CodexNativeTraceItemEvent,
  keys: string[],
): boolean {
  const itemType = normalizeCodexNativeItemTypeKey(event.type);
  return keys.some((key) => itemType.includes(key));
}

function compactCodexNativePathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function getCodexNativeGeneratedImage(
  event: CodexNativeTraceItemEvent,
): GeneratedChatImage | null {
  const itemId = sanitizeText(event.id || "").trim();
  if (!itemId) return null;
  const savedPath =
    sanitizeText(event.savedPath || "").trim() ||
    getCodexNativeRawString(event, ["savedPath", "saved_path"], 4000);
  const result =
    typeof event.result === "string"
      ? event.result.trim()
      : getCodexNativeRawString(event, ["result"], Number.MAX_SAFE_INTEGER);
  const revisedPrompt =
    sanitizeText(event.revisedPrompt || "").trim() ||
    getCodexNativeRawString(event, ["revisedPrompt", "revised_prompt"], 8000);
  if (savedPath) {
    return {
      id: itemId,
      label: compactCodexNativePathBasename(savedPath),
      path: savedPath,
      ...(revisedPrompt ? { revisedPrompt } : {}),
    };
  }
  if (isRenderableGeneratedImageSrc(result)) {
    return {
      id: itemId,
      label: "Generated image",
      src: result,
      ...(revisedPrompt ? { revisedPrompt } : {}),
    };
  }
  return null;
}

function createCodexNativeActivityTraceController(
  assistantMessage: Message,
  queueRefresh: () => void,
) {
  const runId =
    assistantMessage.agentRunId?.trim() ||
    `codex-native-${Math.floor(assistantMessage.timestamp || Date.now())}`;
  const events: AgentRunEventRecord[] = [];
  const progressEventIndexes = new Map<string, number>();
  const toolEventIndexes = new Map<string, number>();
  const mcpRequestToolItemIds = new Map<string, string>();
  const activatedSkillIds = new Set<string>();
  const progressCoalescers = new Map<string, BlockStreamCoalescer>();
  let seq = 0;

  const createEvent = (payload: AgentEvent): AgentRunEventRecord => ({
    runId,
    seq: ++seq,
    eventType: payload.type,
    payload,
    createdAt: Date.now(),
  });

  const sync = () => {
    assistantMessage.pendingAgentTraceEvents = events.length
      ? events.map((entry, index) => ({
          ...entry,
          seq: index + 1,
          payload: { ...entry.payload } as AgentEvent,
        }))
      : undefined;
    queueRefresh();
  };

  const upsertProgressText = (
    itemId: string,
    text: string,
    mode: "replace" | "append",
    status: "running" | "completed",
  ): boolean => {
    const cleanItemId = sanitizeText(itemId).trim();
    const cleanText = sanitizeText(text);
    if (!cleanItemId || !cleanText) return false;
    const existingIndex = progressEventIndexes.get(cleanItemId);
    if (existingIndex !== undefined) {
      const existing = events[existingIndex];
      if (existing?.payload.type !== "codex_progress") return false;
      const nextText =
        mode === "append"
          ? `${existing.payload.text || ""}${cleanText}`
          : cleanText;
      events[existingIndex] = {
        ...existing,
        payload: {
          type: "codex_progress",
          itemId: cleanItemId,
          text: nextText,
          status,
        },
      };
      return true;
    }
    progressEventIndexes.set(cleanItemId, events.length);
    events.push(
      createEvent({
        type: "codex_progress",
        itemId: cleanItemId,
        text: cleanText,
        status,
      }),
    );
    return true;
  };

  const getProgressCoalescer = (itemId: string): BlockStreamCoalescer => {
    let coalescer = progressCoalescers.get(itemId);
    if (coalescer) return coalescer;
    coalescer = createBlockStreamCoalescer({
      onBlock: (block) => {
        const changed = upsertProgressText(itemId, block, "append", "running");
        if (changed) sync();
      },
    });
    progressCoalescers.set(itemId, coalescer);
    return coalescer;
  };

  const flushProgressCoalescer = (
    itemId: string,
    reason: "event" | "final" | "cancel" | "error",
  ): void => {
    progressCoalescers.get(itemId)?.flushNow(reason);
  };

  const flushAllProgressCoalescers = (
    reason: "event" | "final" | "cancel" | "error",
  ): void => {
    for (const coalescer of progressCoalescers.values()) {
      coalescer.flushNow(reason);
    }
  };

  const findRecentCompatibleToolActivity = (
    phase: "started" | "completed",
    serverName?: string,
    toolName?: string,
    toolLabel?: string,
  ): string | null => {
    const now = Date.now();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const entry = events[index];
      if (now - entry.createdAt > 8000) break;
      if (entry?.payload.type !== "codex_tool_activity") continue;
      if (entry.payload.phase !== phase) continue;
      if (
        serverName &&
        entry.payload.serverName &&
        entry.payload.serverName !== serverName
      ) {
        continue;
      }
      if (!entry.payload.toolName && !entry.payload.toolLabel) {
        return entry.payload.itemId;
      }
      if (toolName && entry.payload.toolName === toolName) {
        return entry.payload.itemId;
      }
      if (toolLabel && entry.payload.toolLabel === toolLabel) {
        return entry.payload.itemId;
      }
      if (!toolName && !toolLabel) {
        return entry.payload.itemId;
      }
    }
    return null;
  };

  const findRecentVisibleDuplicateToolActivity = (
    payload: CodexToolActivityEventPayload,
  ): string | null => {
    const now = Date.now();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const entry = events[index];
      if (now - entry.createdAt > TOOL_ACTIVITY_VISIBLE_DEDUPE_WINDOW_MS) {
        break;
      }
      if (entry?.payload.type !== "codex_tool_activity") continue;
      if (hasSameToolActivityVisibleIdentity(entry.payload, payload)) {
        return entry.payload.itemId;
      }
    }
    return null;
  };

  const upsertToolActivity = (
    activity: {
      itemId: string;
      phase: "started" | "completed";
      toolName?: string;
      toolLabel?: string;
      serverName?: string;
      args?: unknown;
      ok?: boolean;
      text?: string;
      codeBlock?: string;
      artifacts?: AgentToolArtifact[];
    },
    options: { matchRecentUnknown?: boolean } = {},
  ): string | null => {
    const cleanItemId = sanitizeText(activity.itemId || "").trim();
    if (!cleanItemId) return null;
    const cleanToolName = sanitizeText(activity.toolName || "").trim();
    const cleanToolLabel = sanitizeText(activity.toolLabel || "").trim();
    const cleanServerName = sanitizeText(activity.serverName || "").trim();
    const buildPayload = (itemId: string): CodexToolActivityEventPayload => ({
      type: "codex_tool_activity",
      itemId,
      phase: activity.phase,
      ...(cleanToolName ? { toolName: cleanToolName } : {}),
      ...(cleanToolLabel ? { toolLabel: cleanToolLabel } : {}),
      ...(cleanServerName ? { serverName: cleanServerName } : {}),
      ...(activity.args !== undefined ? { args: activity.args } : {}),
      ...(typeof activity.ok === "boolean" ? { ok: activity.ok } : {}),
      ...(activity.text ? { text: activity.text } : {}),
      ...(activity.codeBlock ? { codeBlock: activity.codeBlock } : {}),
      ...(activity.artifacts?.length ? { artifacts: activity.artifacts } : {}),
    });
    const matchedUnknown =
      options.matchRecentUnknown && (cleanToolName || cleanToolLabel)
        ? findRecentCompatibleToolActivity(
            activity.phase,
            cleanServerName,
            cleanToolName,
            cleanToolLabel,
          )
        : null;
    let itemId = matchedUnknown || cleanItemId;
    let payload = buildPayload(itemId);
    if (!matchedUnknown) {
      const visibleDuplicate = findRecentVisibleDuplicateToolActivity(payload);
      if (visibleDuplicate) {
        itemId = visibleDuplicate;
        payload = buildPayload(itemId);
      }
    }
    const existingIndex = toolEventIndexes.get(itemId);
    if (existingIndex !== undefined) {
      const existing = events[existingIndex];
      if (existing?.payload.type !== "codex_tool_activity") return null;
      events[existingIndex] = {
        ...existing,
        payload: mergeToolActivityPayload(existing.payload, payload),
        createdAt: Date.now(),
      };
      return itemId;
    }
    toolEventIndexes.set(itemId, events.length);
    events.push(createEvent(payload));
    return itemId;
  };

  const appendStatus = (text: string): boolean => {
    const clean = compactCodexNativeTraceLine(text);
    if (!clean) return false;
    const previous = events[events.length - 1];
    if (
      previous?.payload.type === "status" &&
      previous.payload.text === clean
    ) {
      return false;
    }
    events.push(createEvent({ type: "status", text: clean }));
    return true;
  };

  const addGeneratedImage = (image: GeneratedChatImage | null): boolean => {
    const normalized = normalizeGeneratedChatImages(image ? [image] : []);
    const next = normalized[0];
    if (!next) return false;
    const existing = normalizeGeneratedChatImages(
      assistantMessage.generatedImages,
    );
    const index = existing.findIndex((entry) => entry.id === next.id);
    if (index >= 0) {
      existing[index] = { ...existing[index], ...next };
    } else {
      existing.push(next);
    }
    assistantMessage.generatedImages = existing.length ? existing : undefined;
    return true;
  };

  const appendStructuredOperationStatus = (
    event: CodexNativeTraceItemEvent,
    phase: "started" | "completed",
  ): boolean => {
    const itemType = normalizeCodexNativeItemTypeKey(event.type);
    const itemId =
      sanitizeText(event.id || "").trim() ||
      `codex-${itemType || "item"}-${phase}-${seq + 1}`;
    const status = getCodexNativeStatus(event);
    const failed =
      Boolean(event.error) ||
      /failed|error|cancelled|denied|rejected/i.test(
        sanitizeText(status || event.summary || event.details || ""),
      ) ||
      event.success === false;

    const readWebSearchArgs = (): {
      args?: Record<string, string>;
      actionType: string;
    } | null => {
      const action = event.action || readCodexNativeRawField(event, ["action"]);
      const record =
        action && typeof action === "object" && !Array.isArray(action)
          ? (action as Record<string, unknown>)
          : null;
      const actionType = sanitizeText(String(record?.type || "")).trim();
      const query =
        sanitizeText(event.query || "").trim() ||
        getCodexNativeRawString(event, ["query"], 1000) ||
        sanitizeText(String(record?.query || "")).trim() ||
        (Array.isArray(record?.queries)
          ? record.queries
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => sanitizeText(entry).trim())
              .filter(Boolean)
              .join("; ")
          : "");
      const url = sanitizeText(String(record?.url || "")).trim();
      const pattern = sanitizeText(String(record?.pattern || "")).trim();
      const args: Record<string, string> = {};
      if (query) args.query = query;
      if (url) args.url = url;
      if (pattern) args.pattern = pattern;
      return Object.keys(args).length || actionType
        ? { args: Object.keys(args).length ? args : undefined, actionType }
        : null;
    };

    if (isCodexNativeItemType(event, ["websearch", "websearchcall"])) {
      const webSearch = readWebSearchArgs();
      const actionType = normalizeCodexNativeItemTypeKey(webSearch?.actionType);
      const verb =
        actionType === "openpage"
          ? phase === "completed"
            ? "Opened web page"
            : "Opening web page"
          : actionType === "findinpage"
            ? phase === "completed"
              ? "Searched within page"
              : "Searching within page"
            : phase === "completed"
              ? "Searched web"
              : "Searching web";
      const query =
        sanitizeText(event.query || "").trim() ||
        getCodexNativeRawString(event, ["query"], 1000);
      const updated = upsertToolActivity({
        itemId,
        phase,
        toolName: "codex_web_search",
        toolLabel: "Web search",
        args: webSearch?.args || (query ? { query } : undefined),
        ok: phase === "completed" ? !failed : undefined,
        text: failed && phase === "completed" ? "Web search failed" : verb,
      });
      return Boolean(updated);
    }

    if (isCodexNativeItemType(event, ["imagegeneration"])) {
      const generatedImage =
        phase === "completed" ? getCodexNativeGeneratedImage(event) : null;
      const changedImage = addGeneratedImage(generatedImage);
      const savedPath =
        generatedImage?.path ||
        sanitizeText(event.savedPath || "").trim() ||
        getCodexNativeRawString(event, ["savedPath", "saved_path"], 4000);
      const updated = upsertToolActivity({
        itemId,
        phase,
        toolName: "image_generation",
        toolLabel: "Generated image",
        args: {
          ...(status ? { status } : {}),
          ...(savedPath
            ? { saved: compactCodexNativePathBasename(savedPath) }
            : {}),
        },
        ok: phase === "completed" ? !failed : undefined,
        text:
          phase === "completed"
            ? failed
              ? `Generated image: ${status || "failed"}`
              : "Generated image"
            : "Generating image",
      });
      return Boolean(updated) || changedImage;
    }

    if (isCodexNativeItemType(event, ["imageview"])) {
      const path =
        sanitizeText(event.path || "").trim() ||
        getCodexNativeRawString(event, ["path"], 4000);
      const updated = upsertToolActivity({
        itemId,
        phase,
        toolName: "image_view",
        toolLabel: "Viewed image",
        args: path ? { path } : undefined,
        ok: phase === "completed" ? !failed : undefined,
        text: phase === "completed" ? "Viewed image" : "Viewing image",
      });
      return Boolean(updated);
    }

    const command =
      sanitizeText(event.command || "").trim() ||
      getCodexNativeRawString(event, ["command"], 8000);
    if (command || isCodexNativeItemType(event, ["command", "exec"])) {
      const cwd =
        sanitizeText(event.cwd || "").trim() ||
        getCodexNativeRawString(event, ["cwd"], 4000);
      const exitCode =
        typeof event.exitCode === "number" && Number.isFinite(event.exitCode)
          ? event.exitCode
          : undefined;
      const updated = upsertToolActivity({
        itemId,
        phase,
        toolName: "command",
        toolLabel: "Command",
        args: {
          ...(cwd ? { cwd } : {}),
          ...(typeof exitCode === "number"
            ? { status: `exit ${exitCode}` }
            : {}),
        },
        ok: phase === "completed" ? !failed : undefined,
        text:
          phase === "completed"
            ? failed || (typeof exitCode === "number" && exitCode !== 0)
              ? "Command failed"
              : "Ran command"
            : "Running command",
        codeBlock: command || undefined,
      });
      return Boolean(updated);
    }

    if (
      event.changes !== undefined ||
      isCodexNativeItemType(event, ["filechange", "filechanges", "patch"])
    ) {
      const updated = upsertToolActivity({
        itemId,
        phase,
        toolName: "file_changes",
        toolLabel: "File changes",
        args: event.changes,
        ok: phase === "completed" ? !failed : undefined,
        text:
          phase === "completed"
            ? failed
              ? "File changes failed"
              : "Updated files"
            : "Updating files",
      });
      return Boolean(updated);
    }

    return false;
  };

  const noteSkillActivated = (
    skillId: string,
    options: { source?: "codex-native-slash" } = {},
  ): void => {
    const cleanSkillId = sanitizeText(skillId || "").trim();
    if (!cleanSkillId || activatedSkillIds.has(cleanSkillId)) return;
    flushAllProgressCoalescers("event");
    activatedSkillIds.add(cleanSkillId);
    events.push(
      createEvent({
        type: "tool_call",
        callId: `skill:${cleanSkillId}`,
        name: "Skill",
        args: {
          skill: cleanSkillId,
          ...(options.source ? { source: options.source } : {}),
        },
      }),
    );
    sync();
  };

  const appendItemStatus = (
    event: CodexNativeTraceItemEvent,
    phase: "started" | "completed",
  ): void => {
    if (isCodexNativeAgentMessageItem(event)) return;
    flushAllProgressCoalescers("event");
    if (appendStructuredOperationStatus(event, phase)) {
      sync();
      return;
    }
    if (isCodexNativeToolItem(event)) {
      const itemId =
        sanitizeText(event.id || "").trim() || `codex-tool-${phase}-${seq + 1}`;
      const failureText = compactCodexNativeTraceLine(
        event.error || event.summary || event.details || "",
      );
      const failed =
        Boolean(event.error) ||
        /failed|error|cancelled|denied|rejected/i.test(
          sanitizeText(event.summary || event.details || ""),
        );
      const updatedItemId = upsertToolActivity({
        itemId,
        phase,
        toolName: resolveCodexNativeToolName(event),
        toolLabel: resolveCodexNativeToolLabel(event),
        serverName: resolveCodexNativeToolServerName(event),
        args: resolveCodexNativeToolArguments(event),
        ok: phase === "completed" ? !failed : undefined,
        text: phase === "completed" && failed ? failureText : undefined,
        artifacts:
          phase === "completed"
            ? ((event.raw as { artifacts?: AgentToolArtifact[] } | undefined)
                ?.artifacts ?? undefined)
            : undefined,
      });
      if (updatedItemId) sync();
      return;
    }
    const itemType = humanizeCodexNativeItemType(event.type);
    if (!itemType || itemType === "reasoning") return;
    const summary =
      phase === "completed"
        ? compactCodexNativeTraceLine(event.summary || event.details || "")
        : "";
    const text = summary || `Codex ${itemType} ${phase}`;
    if (appendStatus(text)) sync();
  };

  const appendAgentMessageDelta = (
    event: CodexNativeTraceDeltaEvent,
  ): boolean => {
    const itemId = sanitizeText(event.itemId || "").trim();
    if (!itemId) return false;
    getProgressCoalescer(itemId).pushText(event.delta);
    return true;
  };

  const noteMcpToolActivity = (
    event: CodexNativeMcpToolActivityEvent,
  ): void => {
    flushAllProgressCoalescers("event");
    const requestId = sanitizeText(event.requestId || "").trim();
    const existingItemId = requestId
      ? mcpRequestToolItemIds.get(requestId)
      : undefined;
    const fallbackItemId =
      existingItemId ||
      (requestId ? `mcp:${requestId}` : `mcp-tool-${event.phase}-${seq + 1}`);
    const updatedItemId = upsertToolActivity(
      {
        itemId: fallbackItemId,
        phase: event.phase,
        toolName: event.toolName,
        toolLabel: event.toolLabel,
        serverName: event.serverName,
        args: event.arguments,
        ok: event.ok,
        text: event.error,
        artifacts: event.artifacts,
      },
      { matchRecentUnknown: !existingItemId },
    );
    if (requestId && updatedItemId) {
      mcpRequestToolItemIds.set(requestId, updatedItemId);
    }
    if (updatedItemId) sync();
  };

  const noteMcpConfirmationRequired = (
    requestId: string,
    action: AgentPendingAction,
  ): void => {
    const cleanRequestId = sanitizeText(requestId || "").trim();
    if (!cleanRequestId) return;
    flushAllProgressCoalescers("event");
    events.push(
      createEvent({
        type: "confirmation_required",
        requestId: cleanRequestId,
        action,
      }),
    );
    sync();
  };

  const noteMcpConfirmationResolved = (
    requestId: string,
    resolution: AgentConfirmationResolution,
  ): void => {
    const cleanRequestId = sanitizeText(requestId || "").trim();
    if (!cleanRequestId) return;
    flushAllProgressCoalescers("event");
    events.push(
      createEvent({
        type: "confirmation_resolved",
        requestId: cleanRequestId,
        approved: Boolean(resolution.approved),
        actionId: resolution.actionId,
        data: resolution.data,
      }),
    );
    sync();
  };

  const noteAgentMessageCompleted = (
    event: CodexNativeTraceItemEvent,
  ): void => {
    if (!isCodexNativeAgentMessageItem(event)) return;
    const itemId = sanitizeText(event.id || "").trim();
    if (!itemId) return;
    flushProgressCoalescer(itemId, "event");
    const completedText = event.details || event.summary || "";
    if (completedText && !progressEventIndexes.has(itemId)) {
      if (upsertProgressText(itemId, completedText, "replace", "completed")) {
        sync();
      }
    }
  };

  const finish = (finalText: string): void => {
    flushAllProgressCoalescers("final");
    const alreadyFinal = events.some((entry) => entry.payload.type === "final");
    if (!alreadyFinal) {
      // The terminal marker closes the activity lifecycle. Do not prune any
      // preceding agent-message or tool events from the interleaved trace.
      events.push(createEvent({ type: "final", text: finalText }));
      sync();
    }
  };

  return {
    appendAgentMessageDelta,
    appendItemStatus,
    finish,
    noteSkillActivated,
    noteMcpConfirmationRequired,
    noteMcpConfirmationResolved,
    noteMcpToolActivity,
    noteAgentMessageCompleted,
  };
}

type CodexNativeActivityTraceController = ReturnType<
  typeof createCodexNativeActivityTraceController
>;

export const createCodexNativeActivityTraceControllerForTests =
  createCodexNativeActivityTraceController;

function noteExplicitCodexNativeSkillInvocations(
  trace: CodexNativeActivityTraceController | null,
  skillIds?: string[],
): void {
  if (!trace?.noteSkillActivated || !skillIds?.length) return;
  for (const skillId of skillIds) {
    trace.noteSkillActivated(skillId, { source: "codex-native-slash" });
  }
}

function applyWebChatAnswerSnapshot(
  message: Message,
  text: string,
  snapshot: {
    runState?:
      | "submitted"
      | "active"
      | "settling"
      | "done"
      | "incomplete"
      | "error"
      | null;
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
    runState?:
      | "submitted"
      | "active"
      | "settling"
      | "done"
      | "incomplete"
      | "error"
      | null;
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

function reconstructRetryPayload(
  userMessage: Message,
  options?: {
    resolvedSelectedTextAnchors?: ResolvedSelectedTextAnchor[];
    includeAnchorContext?: boolean;
  },
): {
  question: string;
  screenshotImages: string[];
  attachments: ChatAttachment[];
  paperContexts: PaperContextRef[];
  pdfPaperContexts: PaperContextRef[];
  fullTextPaperContexts: PaperContextRef[];
  selectedCollectionContexts: CollectionContextRef[];
  selectedTagContexts: TagContextRef[];
} {
  const selectedTextContexts = synthesizeSelectedTextContexts({
    selectedTextContexts: userMessage.selectedTextContexts,
    selectedTexts: userMessage.selectedTexts,
    legacySelectedText: userMessage.selectedText,
    selectedTextSources: userMessage.selectedTextSources,
    selectedTextPaperContexts: userMessage.selectedTextPaperContexts,
    selectedTextNoteContexts: userMessage.selectedTextNoteContexts,
    sanitizeText,
  });
  const selectedTexts = selectedTextContexts.map((context) => context.text);
  const selectedTextSources = selectedTextContexts.map(
    (context) => context.source,
  );
  const selectedTextPaperContexts = selectedTextContexts.map(
    (context) => context.paperContext,
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
          selectedTextContexts,
          selectedTextPaperContexts,
          resolvedSelectedTextAnchors: options?.resolvedSelectedTextAnchors,
          includeAnchorContext: options?.includeAnchorContext,
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
  const { paperContexts, pdfPaperContexts, fullTextPaperContexts } =
    normalizeStoredPaperContextRoutes({
      paperContexts: userMessage.paperContexts,
      pdfPaperContexts: userMessage.pdfPaperContexts,
      fullTextPaperContexts:
        userMessage.fullTextPaperContexts || userMessage.pinnedPaperContexts,
    });
  const selectedCollectionContexts = normalizeCollectionContexts(
    userMessage.selectedCollectionContexts,
  );
  const selectedTagContexts = normalizeTagContexts(
    userMessage.selectedTagContexts,
  );
  return {
    question,
    screenshotImages,
    attachments: fileAttachments,
    paperContexts,
    pdfPaperContexts,
    fullTextPaperContexts,
    selectedCollectionContexts,
    selectedTagContexts,
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
    shouldApplyCodexAppServerNativeAttachmentPolicy({
      authMode: options?.authMode,
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
  | "persist-failed"
  | "retry-failed";

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

function getPdfPaperAttachmentContextItemId(
  attachment: ChatAttachment,
): number | null {
  if (typeof attachment.id !== "string") return null;
  const match = attachment.id.match(/^pdf-(?:paper|page)-(\d+)-/);
  if (!match) return null;
  const contextItemId = Number(match[1]);
  return Number.isFinite(contextItemId) && contextItemId > 0
    ? Math.floor(contextItemId)
    : null;
}

function isPdfChatAttachment(attachment: ChatAttachment): boolean {
  const name = typeof attachment.name === "string" ? attachment.name : "";
  const mime =
    typeof attachment.mimeType === "string"
      ? attachment.mimeType.trim().toLowerCase()
      : "";
  return (
    attachment.category === "pdf" ||
    mime === "application/pdf" ||
    /\.pdf$/i.test(name)
  );
}

function isSameRetryModelTarget(params: {
  userMessage: Message;
  previousAssistant?: Pick<
    Message,
    "modelName" | "modelEntryId" | "modelProviderLabel"
  >;
  effectiveRequestConfig: EffectiveRequestConfig;
}): boolean {
  const storedEntryId =
    params.userMessage.modelEntryId || params.previousAssistant?.modelEntryId;
  if (storedEntryId && params.effectiveRequestConfig.modelEntryId) {
    return storedEntryId === params.effectiveRequestConfig.modelEntryId;
  }
  const storedModel = (
    params.userMessage.modelName ||
    params.previousAssistant?.modelName ||
    ""
  ).trim();
  const targetModel = (params.effectiveRequestConfig.model || "").trim();
  if (storedModel && targetModel && storedModel !== targetModel) return false;
  const storedProvider = (
    params.userMessage.modelProviderLabel ||
    params.previousAssistant?.modelProviderLabel ||
    ""
  ).trim();
  const targetProvider = (
    params.effectiveRequestConfig.modelProviderLabel || ""
  ).trim();
  if (storedProvider && targetProvider && storedProvider !== targetProvider) {
    return false;
  }
  return Boolean(storedEntryId || storedModel || storedProvider);
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)),
    );
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

async function renderRetryPdfPaperImages(params: {
  attachments: ChatAttachment[];
  existingImages: string[];
  maxImages: number;
}): Promise<string[]> {
  const contextItemIds = Array.from(
    new Set(
      params.attachments
        .map(getPdfPaperAttachmentContextItemId)
        .filter((id): id is number => id !== null),
    ),
  );
  if (!contextItemIds.length) return [];
  const remaining = Math.max(
    0,
    Math.floor(params.maxImages) - params.existingImages.length,
  );
  if (remaining <= 0) return [];
  const [{ renderAllPdfPages }, { readAttachmentBytes }] = await Promise.all([
    import("../../agent/services/pdfPageService"),
    import("./attachmentStorage"),
  ]);
  const images: string[] = [];
  for (const contextItemId of contextItemIds) {
    if (images.length >= remaining) break;
    const pages = await renderAllPdfPages(contextItemId, {
      maxPages: remaining - images.length,
    });
    for (const page of pages) {
      if (images.length >= remaining) break;
      const bytes = await readAttachmentBytes(page.storedPath);
      if (bytes.byteLength > 0) {
        images.push(bytesToDataUrl(bytes, "image/png"));
      }
    }
  }
  return images;
}

async function resolveRetryModelInputs(params: {
  userMessage: Message;
  previousAssistant?: Pick<
    Message,
    "modelName" | "modelEntryId" | "modelProviderLabel"
  >;
  visibleAttachments: ChatAttachment[];
  screenshotImages: string[];
  modelAttachmentsOverride?: ChatAttachment[];
  effectiveRequestConfig: EffectiveRequestConfig;
}): Promise<{
  modelAttachments?: ChatAttachment[];
  screenshotImages: string[];
  pdfUploadSystemMessages?: string[];
}> {
  const visibleAttachments = normalizeEditableAttachments(
    params.visibleAttachments,
  );
  const modelAttachmentsOverride =
    params.modelAttachmentsOverride !== undefined
      ? normalizeEditableAttachments(params.modelAttachmentsOverride)
      : undefined;
  const pdfSupport = resolveProviderCapabilities({
    model: params.effectiveRequestConfig.model,
    protocol: params.effectiveRequestConfig.providerProtocol,
    authMode: params.effectiveRequestConfig.authMode,
    apiBase: params.effectiveRequestConfig.apiBase,
    inputMode: params.effectiveRequestConfig.advanced?.inputMode,
  }).pdf;
  if (
    params.effectiveRequestConfig.providerProtocol !== "web_sync" &&
    pdfSupport !== "native" &&
    (visibleAttachments.some(isPdfChatAttachment) ||
      (modelAttachmentsOverride || []).some(isPdfChatAttachment))
  ) {
    throw new Error(FULL_PDF_UNSUPPORTED_MESSAGE);
  }
  if (modelAttachmentsOverride !== undefined) {
    return {
      modelAttachments: modelAttachmentsOverride,
      screenshotImages: params.screenshotImages,
    };
  }
  const pdfPaperAttachments = visibleAttachments.filter(
    (attachment) => getPdfPaperAttachmentContextItemId(attachment) !== null,
  );
  if (
    pdfSupport !== "upload" &&
    Array.isArray(params.userMessage.modelAttachments) &&
    isSameRetryModelTarget({
      userMessage: params.userMessage,
      previousAssistant: params.previousAssistant,
      effectiveRequestConfig: params.effectiveRequestConfig,
    })
  ) {
    return {
      modelAttachments: params.userMessage.modelAttachments,
      screenshotImages: params.screenshotImages,
    };
  }

  if (!visibleAttachments.length) {
    return { screenshotImages: params.screenshotImages };
  }

  const modelAttachments =
    pdfSupport === "none"
      ? visibleAttachments.filter((attachment) => attachment.category !== "pdf")
      : pdfSupport === "vision" || pdfSupport === "upload"
        ? visibleAttachments.filter(
            (attachment) =>
              getPdfPaperAttachmentContextItemId(attachment) === null,
          )
        : visibleAttachments;
  const pdfUploadSystemMessages: string[] = [];
  if (pdfSupport === "upload" && pdfPaperAttachments.length) {
    const missingStoredPath = pdfPaperAttachments.find(
      (attachment) => !(attachment.storedPath || "").trim(),
    );
    if (missingStoredPath) {
      const name =
        typeof missingStoredPath.name === "string" &&
        missingStoredPath.name.trim()
          ? missingStoredPath.name.trim()
          : "the PDF";
      throw new Error(
        `Cannot retry PDF upload because ${name} is missing its locally persisted PDF. Re-send the paper or switch models.`,
      );
    }
    const apiBase = (params.effectiveRequestConfig.apiBase || "").trim();
    const apiKey = (params.effectiveRequestConfig.apiKey || "").trim();
    if (!apiBase || !apiKey) {
      throw new Error("PDF upload requires a configured provider API key.");
    }
    const [
      { detectPdfUploadProvider, uploadPdfForProvider },
      { readAttachmentBytes },
    ] = await Promise.all([
      import("../../utils/pdfUploadPreprocessor"),
      import("./attachmentStorage"),
    ]);
    const provider = detectPdfUploadProvider(apiBase);
    for (const attachment of pdfPaperAttachments) {
      const storedPath = (attachment.storedPath || "").trim();
      const result = await uploadPdfForProvider({
        provider,
        apiBase,
        apiKey,
        pdfBytes: await readAttachmentBytes(storedPath),
        fileName:
          typeof attachment.name === "string" && attachment.name.trim()
            ? attachment.name.trim()
            : "document.pdf",
      });
      if (!result) {
        throw new Error("PDF upload failed.");
      }
      pdfUploadSystemMessages.push(result.systemMessageContent);
    }
  }
  let screenshotImages = params.screenshotImages;
  if (
    pdfSupport === "vision" &&
    modelAttachments.length !== visibleAttachments.length
  ) {
    const rendered = await renderRetryPdfPaperImages({
      attachments: visibleAttachments,
      existingImages: screenshotImages,
      maxImages: MAX_SELECTED_IMAGES,
    });
    if (rendered.length) {
      screenshotImages = [...screenshotImages, ...rendered].slice(
        0,
        MAX_SELECTED_IMAGES,
      );
    }
  }

  return {
    modelAttachments,
    screenshotImages,
    pdfUploadSystemMessages: pdfUploadSystemMessages.length
      ? pdfUploadSystemMessages
      : undefined,
  };
}

export const resolveRetryModelInputsForTests = resolveRetryModelInputs;

function normalizeEditablePaperContexts(
  paperContexts?: PaperContextRef[],
): PaperContextRef[] {
  return normalizePaperContexts(paperContexts);
}

function normalizeEditableFullTextPaperContexts(
  fullTextPaperContexts?: PaperContextRef[],
): PaperContextRef[] {
  return limitFullTextPaperContexts(
    normalizePaperContexts(fullTextPaperContexts),
  );
}

function limitFullTextPaperContexts(
  paperContexts: PaperContextRef[],
): PaperContextRef[] {
  return paperContexts.slice(0, MAX_FULL_TEXT_PAPER_CONTEXTS);
}

function includeAutoLoadedPaperContext(
  item: Zotero.Item,
  paperContexts?: PaperContextRef[],
  fullTextPaperContexts?: PaperContextRef[],
  excludePaperKeys?: Set<string>,
  contextSource?: ResolvedContextSource | null,
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
          ? limitFullTextPaperContexts(normalizedPaperContexts)
          : limitFullTextPaperContexts(normalizedFullTextPaperContexts),
    };
  }
  const autoLoadedPaperContext = resolveAutoLoadedPaperContextForItem(
    item,
    contextSource,
  );
  if (!autoLoadedPaperContext) {
    return {
      paperContexts: normalizedPaperContexts,
      fullTextPaperContexts: limitFullTextPaperContexts(
        normalizedFullTextPaperContexts,
      ),
    };
  }
  // Always include auto-loaded paper in paperContexts (for display in chat history).
  // Only add to fullTextPaperContexts if NOT in PDF mode.
  const autoKey = `${autoLoadedPaperContext.itemId}:${autoLoadedPaperContext.contextItemId}`;
  const isExcludedFromTextPipeline = excludePaperKeys?.has(autoKey) === true;
  return {
    paperContexts: isExcludedFromTextPipeline
      ? normalizedPaperContexts
      : normalizePaperContexts([
          autoLoadedPaperContext,
          ...normalizedPaperContexts,
        ]),
    fullTextPaperContexts: isExcludedFromTextPipeline
      ? limitFullTextPaperContexts(normalizedFullTextPaperContexts)
      : fullTextPaperContexts === undefined
        ? limitFullTextPaperContexts(
            normalizePaperContexts([
              autoLoadedPaperContext,
              ...normalizedFullTextPaperContexts,
            ]),
          )
        : limitFullTextPaperContexts(normalizedFullTextPaperContexts),
  };
}

export const includeAutoLoadedPaperContextForTests =
  includeAutoLoadedPaperContext;

function syncComposeContextForInlineEdit(
  body: Element,
  item: Zotero.Item,
  userMessage: Message,
): void {
  const conversationKey = getConversationKey(item);
  const selectedTextEntries = synthesizeSelectedTextContexts({
    selectedTextContexts: userMessage.selectedTextContexts,
    selectedTexts: userMessage.selectedTexts,
    legacySelectedText: userMessage.selectedText,
    selectedTextSources: userMessage.selectedTextSources,
    selectedTextPaperContexts: userMessage.selectedTextPaperContexts,
    selectedTextNoteContexts: userMessage.selectedTextNoteContexts,
    sanitizeText,
  });
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

  const { paperContexts, pdfPaperContexts, fullTextPaperContexts } =
    normalizeStoredPaperContextRoutes({
      paperContexts: userMessage.paperContexts,
      pdfPaperContexts: userMessage.pdfPaperContexts,
      fullTextPaperContexts:
        userMessage.fullTextPaperContexts || userMessage.pinnedPaperContexts,
    });
  const composePaperContexts = normalizePaperContexts([
    ...paperContexts,
    ...fullTextPaperContexts,
    ...pdfPaperContexts,
  ]);
  const autoLoadedPaperContext = resolveAutoLoadedPaperContextForItem(item);
  const selectedPaperContexts = autoLoadedPaperContext
    ? composePaperContexts.filter(
        (paperContext) =>
          !(
            paperContext.itemId === autoLoadedPaperContext.itemId &&
            paperContext.contextItemId === autoLoadedPaperContext.contextItemId
          ),
      )
    : composePaperContexts;
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
  const selectedTagContexts = normalizeTagContexts(
    userMessage.selectedTagContexts,
  );
  if (selectedTagContexts.length) {
    selectedTagContextCache.set(item.id, selectedTagContexts);
  } else {
    selectedTagContextCache.delete(item.id);
  }
  // Clear existing mode overrides for this item, then set full-next for each full-text paper
  const modePrefix = `${item.id}:`;
  for (const key of Array.from(paperContextModeOverrides.keys())) {
    if (key.startsWith(modePrefix)) paperContextModeOverrides.delete(key);
  }
  for (const paperContext of fullTextPaperContexts) {
    paperContextModeOverrides.set(
      `${item.id}:${buildPaperKey(paperContext)}`,
      "full-next",
    );
  }
  for (const paperContext of composePaperContexts) {
    clearPaperContentSourceOverride(item.id, paperContext);
    setPaperContentSourceOverride(
      item.id,
      paperContext,
      paperContext.contentSourceMode || "text",
    );
  }

  activeContextPanelStateSync.get(body)?.();
}

export async function editLatestUserMessageAndRetry(
  opts: import("./types").EditRetryOptions,
): Promise<EditLatestTurnResult> {
  const {
    body,
    item,
    contextSource,
    displayQuestion,
    selectedTextContexts,
    selectedTexts,
    selectedTextSources,
    selectedTextPaperContexts,
    selectedTextNoteContexts,
    screenshotImages,
    paperContexts,
    pdfPaperContexts,
    fullTextPaperContexts,
    selectedCollectionContexts,
    selectedTagContexts,
    attachments,
    modelAttachments,
    localDocuments: _localDocuments,
    pdfUploadSystemMessages,
    targetRuntimeMode,
    expected,
    model,
    apiBase,
    apiKey,
    authMode,
    providerProtocol,
    modelEntryId,
    modelProviderLabel,
    reasoning,
    advanced,
  } = opts;
  await ensureConversationLoaded(item);
  const conversationKey = getConversationKey(item);
  const history = chatHistory.get(conversationKey) || [];
  const retryPair = findLatestRetryPair(history);
  if (!retryPair) return "missing";
  if (retryPair.assistantMessage.streaming) return "stale";
  const retryRequestConfig = resolveEffectiveRequestConfig({
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
  const retryConversationSystem = resolveEffectiveConversationSystem({
    item,
    authMode: retryRequestConfig.authMode,
    providerProtocol: retryRequestConfig.providerProtocol,
    modelProviderLabel: retryRequestConfig.modelProviderLabel,
  });
  const retryStorageSystem =
    resolveConversationStorageSystemForItem({
      item,
      conversationSystem: retryConversationSystem,
    }) || retryConversationSystem;
  const retryRuntimeMode: ChatRuntimeMode =
    retryConversationSystem === "codex"
      ? "chat"
      : targetRuntimeMode ||
        (retryPair.assistantMessage.runMode === "agent" ? "agent" : "chat");
  if (
    expected &&
    (expected.conversationKey !== conversationKey ||
      retryPair.userMessage.timestamp !== expected.userTimestamp ||
      retryPair.assistantMessage.timestamp !== expected.assistantTimestamp)
  ) {
    return "stale";
  }

  const selectedTextContextsForMessage = synthesizeSelectedTextContexts({
    selectedTextContexts,
    selectedTexts,
    selectedTextSources,
    selectedTextPaperContexts,
    selectedTextNoteContexts,
    sanitizeText,
  });
  const selectedTextsForMessage = selectedTextContextsForMessage.map(
    (context) => context.text,
  );
  const selectedTextSourcesForMessage = selectedTextContextsForMessage.map(
    (context) => context.source,
  );
  const selectedTextPaperContextsForMessage =
    selectedTextContextsForMessage.map((context) => context.paperContext);
  const selectedTextQuoteCitationsForMessage = buildSelectedTextQuoteCitations(
    selectedTextsForMessage,
    selectedTextSourcesForMessage,
    selectedTextPaperContextsForMessage,
  );
  const selectedTextNoteContextsForMessage = selectedTextContextsForMessage.map(
    (context) => context.noteContext,
  );
  const selectedTextForMessage = selectedTextsForMessage[0] || "";
  const screenshotImagesForMessage = Array.isArray(screenshotImages)
    ? screenshotImages
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, MAX_SELECTED_IMAGES)
    : [];
  const normalizedPaperContextsInput = normalizeEditablePaperContexts([
    ...(paperContexts || []),
    ...selectedTextPaperContextsForMessage.filter(
      (paper): paper is PaperContextRef => Boolean(paper),
    ),
  ]);
  const {
    paperContexts: normalizedPaperContexts,
    pdfPaperContexts: normalizedPdfPaperContexts,
    fullTextPaperContexts: normalizedFullTextPaperContexts,
  } = normalizeStoredPaperContextRoutes({
    paperContexts: normalizedPaperContextsInput,
    pdfPaperContexts: normalizePaperContexts(pdfPaperContexts),
    fullTextPaperContexts: normalizeEditableFullTextPaperContexts(
      fullTextPaperContexts,
    ),
  });
  const selectedCollectionContextsForMessage = normalizeCollectionContexts(
    selectedCollectionContexts,
  );
  const selectedTagContextsForMessage =
    normalizeTagContexts(selectedTagContexts);
  const pdfExcludeKeys = new Set(
    normalizedPdfPaperContexts.map(
      (paper) => `${paper.itemId}:${paper.contextItemId}`,
    ),
  );
  let {
    paperContexts: paperContextsForMessage,
    fullTextPaperContexts: fullTextPaperContextsForMessage,
  } = includeAutoLoadedPaperContext(
    item,
    normalizedPaperContexts,
    normalizedFullTextPaperContexts,
    pdfExcludeKeys.size > 0 ? pdfExcludeKeys : undefined,
    contextSource,
  );
  const editRetryCodexNativeMcpLightContext = shouldUseCodexNativeLightContext({
    isCodexNativeTurn:
      retryConversationSystem === "codex" &&
      retryRequestConfig.authMode === "codex_app_server",
  });
  if (editRetryCodexNativeMcpLightContext) {
    const [enrichedPaperContexts, enrichedFullTextPaperContexts] =
      await Promise.all([
        enrichPaperContextsWithMineruCache(paperContextsForMessage),
        enrichPaperContextsWithMineruCache(fullTextPaperContextsForMessage),
      ]);
    paperContextsForMessage = enrichedPaperContexts || paperContextsForMessage;
    fullTextPaperContextsForMessage =
      enrichedFullTextPaperContexts || fullTextPaperContextsForMessage;
  }
  const attachmentsForMessage = normalizeEditableAttachments(attachments);
  const updatedTimestamp = Date.now();
  const nextDisplayQuestion = sanitizeText(displayQuestion || "");

  retryPair.userMessage.text = nextDisplayQuestion;
  retryPair.userMessage.timestamp = updatedTimestamp;
  retryPair.userMessage.runMode = retryRuntimeMode;
  retryPair.userMessage.agentRunId = undefined;
  retryPair.userMessage.selectedText = selectedTextForMessage || undefined;
  retryPair.userMessage.selectedTextExpanded = false;
  retryPair.userMessage.selectedTextContexts =
    selectedTextContextsForMessage.length
      ? selectedTextContextsForMessage
      : undefined;
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
  retryPair.userMessage.pdfPaperContexts = normalizedPdfPaperContexts.length
    ? normalizedPdfPaperContexts
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
  retryPair.userMessage.selectedTagContexts =
    selectedTagContextsForMessage.length
      ? selectedTagContextsForMessage
      : undefined;
  retryPair.userMessage.paperContextsExpanded = false;
  retryPair.userMessage.attachments = attachmentsForMessage.length
    ? attachmentsForMessage
    : undefined;
  if (modelAttachments !== undefined) {
    retryPair.userMessage.modelAttachments =
      normalizeEditableAttachments(modelAttachments);
  } else {
    retryPair.userMessage.modelAttachments = undefined;
  }
  retryPair.userMessage.modelName = retryRequestConfig.model;
  retryPair.userMessage.modelEntryId = retryRequestConfig.modelEntryId;
  retryPair.userMessage.modelProviderLabel =
    retryRequestConfig.modelProviderLabel;
  retryPair.userMessage.attachmentsExpanded = false;
  retryPair.userMessage.attachmentActiveIndex = undefined;

  try {
    await updateStoredLatestUserMessageByConversation(
      conversationKey,
      {
        text: retryPair.userMessage.text,
        timestamp: retryPair.userMessage.timestamp,
        runMode: retryPair.userMessage.runMode,
        agentRunId: retryPair.userMessage.agentRunId,
        selectedText: retryPair.userMessage.selectedText,
        selectedTextContexts: retryPair.userMessage.selectedTextContexts,
        selectedTexts: retryPair.userMessage.selectedTexts,
        selectedTextSources: retryPair.userMessage.selectedTextSources,
        selectedTextPaperContexts:
          retryPair.userMessage.selectedTextPaperContexts,
        selectedTextNoteContexts:
          retryPair.userMessage.selectedTextNoteContexts,
        forcedSkillIds: retryPair.userMessage.forcedSkillIds,
        screenshotImages: retryPair.userMessage.screenshotImages,
        paperContexts: retryPair.userMessage.paperContexts,
        pdfPaperContexts: retryPair.userMessage.pdfPaperContexts,
        fullTextPaperContexts: retryPair.userMessage.fullTextPaperContexts,
        citationPaperContexts: retryPair.userMessage.citationPaperContexts,
        selectedCollectionContexts:
          retryPair.userMessage.selectedCollectionContexts,
        selectedTagContexts: retryPair.userMessage.selectedTagContexts,
        attachments: retryPair.userMessage.attachments,
        modelAttachments: retryPair.userMessage.modelAttachments,
        modelName: retryPair.userMessage.modelName,
        modelEntryId: retryPair.userMessage.modelEntryId,
        modelProviderLabel: retryPair.userMessage.modelProviderLabel,
      },
      retryStorageSystem,
    );

    const storedMessages = await loadStoredConversationByKey(
      conversationKey,
      PERSISTED_HISTORY_LIMIT,
      retryStorageSystem,
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

  const retrySucceeded =
    retryRuntimeMode === "agent"
      ? await retryLatestAgentResponse(
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
          modelAttachments,
        )
      : await retryLatestAssistantResponse(
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
          modelAttachments,
        );
  if (!retrySucceeded) return "retry-failed";
  return "ok";
}

export async function retryLatestAssistantResponse(
  body: Element,
  item: Zotero.Item,
  model?: string,
  apiBase?: string,
  apiKey?: string,
  authMode?:
    | "api_key"
    | "codex_auth"
    | "codex_app_server"
    | "copilot_auth"
    | "webchat",
  providerProtocol?: ProviderProtocol,
  modelEntryId?: string,
  modelProviderLabel?: string,
  reasoning?: LLMReasoningConfig,
  advanced?: AdvancedModelParams,
  pdfUploadSystemMessages?: string[],
  modelAttachmentsOverride?: ChatAttachment[],
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
  setPendingRequestIdAndSync(conversationKey, thisRequestId, body, item);
  setRequestUIBusy(body, ui, conversationKey, "Preparing retry...");
  const assistantMessage = retryPair.assistantMessage;
  const assistantSnapshot = takeAssistantSnapshot(assistantMessage);
  assistantMessage.text = "";
  assistantMessage.reasoningSummary = undefined;
  assistantMessage.reasoningDetails = undefined;
  assistantMessage.reasoningOpen = isReasoningExpandedByDefault();
  assistantMessage.agentRunId = undefined;
  assistantMessage.pendingAgentTraceEvents = undefined;
  assistantMessage.generatedImages = undefined;
  assistantMessage.streaming = true;
  assistantMessage.quoteCitations = buildSelectedTextQuoteCitations(
    retryPair.userMessage.selectedTexts,
    retryPair.userMessage.selectedTextSources,
    retryPair.userMessage.selectedTextPaperContexts,
  );
  resetAssistantQuoteDisplay(assistantMessage);
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
  const effectiveConversationSystem = resolveEffectiveConversationSystem({
    item,
    authMode: effectiveRequestConfig.authMode,
    providerProtocol: effectiveRequestConfig.providerProtocol,
    modelProviderLabel: effectiveRequestConfig.modelProviderLabel,
  });
  const effectiveStorageSystem =
    resolveConversationStorageSystemForItem({
      item,
      conversationSystem: effectiveConversationSystem,
    }) || effectiveConversationSystem;
  const isCodexNativeTurn =
    effectiveConversationSystem === "codex" &&
    effectiveRequestConfig.authMode === "codex_app_server";
  assistantMessage.runMode = isCodexNativeTurn ? "agent" : "chat";
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
  const retrySelectedTextContexts = synthesizeSelectedTextContexts({
    selectedTextContexts: retryPair.userMessage.selectedTextContexts,
    selectedTexts: retryPair.userMessage.selectedTexts,
    legacySelectedText: retryPair.userMessage.selectedText,
    selectedTextSources: retryPair.userMessage.selectedTextSources,
    selectedTextPaperContexts: retryPair.userMessage.selectedTextPaperContexts,
    selectedTextNoteContexts: retryPair.userMessage.selectedTextNoteContexts,
    sanitizeText,
  });
  const retryResolvedSelectedTextAnchors = await resolveSelectedTextAnchors({
    selectedTextContexts: retrySelectedTextContexts,
    paperContexts: normalizePaperContexts([
      ...(retryPair.userMessage.paperContexts || []),
      ...(retryPair.userMessage.fullTextPaperContexts || []),
      ...retrySelectedTextContexts
        .map((context) => context.paperContext)
        .filter((paper): paper is PaperContextRef => Boolean(paper)),
    ]),
  });
  const {
    question,
    screenshotImages,
    attachments,
    paperContexts,
    pdfPaperContexts,
    fullTextPaperContexts,
    selectedCollectionContexts,
    selectedTagContexts,
  } = reconstructRetryPayload(retryPair.userMessage, {
    resolvedSelectedTextAnchors: retryResolvedSelectedTextAnchors,
    includeAnchorContext:
      effectiveRequestConfig.authMode === "webchat" ||
      effectiveRequestConfig.providerProtocol === "web_sync",
  });
  retryPair.userMessage.paperContexts = paperContexts.length
    ? paperContexts
    : undefined;
  retryPair.userMessage.pdfPaperContexts = pdfPaperContexts.length
    ? pdfPaperContexts
    : undefined;
  retryPair.userMessage.fullTextPaperContexts = fullTextPaperContexts.length
    ? fullTextPaperContexts
    : undefined;
  let retryPaperContexts = paperContexts;
  let retryFullTextPaperContexts = fullTextPaperContexts;
  if (shouldUseCodexNativeLightContext({ isCodexNativeTurn })) {
    const [enrichedPaperContexts, enrichedFullTextPaperContexts] =
      await Promise.all([
        enrichPaperContextsWithMineruCache(retryPaperContexts),
        enrichPaperContextsWithMineruCache(retryFullTextPaperContexts),
      ]);
    retryPaperContexts = enrichedPaperContexts || retryPaperContexts;
    retryFullTextPaperContexts =
      enrichedFullTextPaperContexts || retryFullTextPaperContexts;
  }
  if (!question.trim()) {
    setStatusSafely("Nothing to retry for latest turn", "error");
    restoreRequestUIIdle(body, conversationKey, thisRequestId);
    clearPendingRequestIdAndSync(conversationKey, body, item);
    return;
  }

  refreshChatSafely();
  let responseStreamCoalescer: BlockStreamCoalescer | null = null;
  const flushResponseStream = (reason: BlockStreamFlushReason) => {
    responseStreamCoalescer?.flushNow(reason);
  };
  let streamedReasoningSummary: string | undefined;
  let streamedReasoningDetails: string | undefined;

  const restoreOriginalAssistant = () => {
    responseStreamCoalescer?.cancel();
    restoreAssistantSnapshot(assistantMessage, assistantSnapshot);
    refreshChatSafely();
  };
  const finalizeCancelledAssistant = async () => {
    flushResponseStream("cancel");
    finalizeCancelledAssistantMessage(assistantMessage);
    refreshChatSafely();
    const latestContextSnapshot = contextUsageSnapshots.get(conversationKey);
    await updateStoredLatestAssistantMessageByConversation(
      conversationKey,
      {
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
        quoteCitations: assistantMessage.quoteCitations,
        generatedImages: assistantMessage.generatedImages,
      },
      effectiveStorageSystem,
    );
    setStatusSafely("Cancelled", "ready");
  };
  if (
    shouldApplyCodexAppServerNativeAttachmentPolicy({
      authMode: effectiveRequestConfig.authMode,
    })
  ) {
    const blockedAttachments =
      getBlockedCodexAppServerNativeAttachments(attachments);
    if (blockedAttachments.length) {
      restoreOriginalAssistant();
      restoreRequestUIIdle(body, conversationKey, thisRequestId);
      clearPendingRequestIdAndSync(conversationKey, body, item);
      setStatusSafely(
        buildCodexAppServerNativeAttachmentBlockMessage(blockedAttachments),
        "error",
      );
      return;
    }
  }
  let retryScreenshotImages = screenshotImages;
  let requestFileAttachments: ChatFileAttachment[] = [];
  let retryPdfUploadSystemMessages: string[] = [];
  try {
    const retryModelInputs = await resolveRetryModelInputs({
      userMessage: retryPair.userMessage,
      previousAssistant: assistantSnapshot,
      visibleAttachments: attachments,
      screenshotImages,
      modelAttachmentsOverride,
      effectiveRequestConfig,
    });
    retryScreenshotImages = retryModelInputs.screenshotImages;
    retryPair.userMessage.screenshotImages = retryScreenshotImages.length
      ? retryScreenshotImages
      : undefined;
    if (retryModelInputs.modelAttachments !== undefined) {
      retryPair.userMessage.modelAttachments =
        retryModelInputs.modelAttachments;
    }
    retryPair.userMessage.modelName = effectiveRequestConfig.model;
    retryPair.userMessage.modelEntryId = effectiveRequestConfig.modelEntryId;
    retryPair.userMessage.modelProviderLabel =
      effectiveRequestConfig.modelProviderLabel;
    requestFileAttachments = normalizeModelFileAttachments(
      retryModelInputs.modelAttachments ?? attachments,
      {
        authMode: effectiveRequestConfig.authMode,
        runtimeMode: "chat",
      },
    );
    retryPdfUploadSystemMessages = [
      ...(pdfUploadSystemMessages || []),
      ...(retryModelInputs.pdfUploadSystemMessages || []),
    ];
  } catch (err) {
    restoreOriginalAssistant();
    restoreRequestUIIdle(body, conversationKey, thisRequestId);
    clearPendingRequestIdAndSync(conversationKey, body, item);
    const message =
      err instanceof Error && err.message.trim()
        ? err.message
        : "Could not prepare retry attachments.";
    setStatusSafely(message, "error");
    return;
  }

  try {
    const usesLocalPdfTransport =
      effectiveConversationSystem === "claude_code" || isCodexNativeTurn;
    const retryLocalDocuments =
      usesLocalPdfTransport && pdfPaperContexts.length
        ? await createLocalPdfResourceResolver().resolve(pdfPaperContexts)
        : undefined;
    if (
      retryLocalDocuments?.length &&
      effectiveConversationSystem === "claude_code"
    ) {
      await preflightClaudeBridgeLocalPdfCapability();
    }
    const llmHistory = buildLLMHistoryMessages(historyForLLM);
    const recentPaperContexts = collectRecentPaperContexts(historyForLLM);
    // Create AbortController early so the signal is available during context
    // planning.
    const AbortControllerCtor = getAbortControllerCtor();
    setAbortController(
      conversationKey,
      AbortControllerCtor ? new AbortControllerCtor() : null,
    );

    const contextPlan = shouldUseCodexNativeLightContext({ isCodexNativeTurn })
      ? buildLightCodexNativeMcpContextPlan({
          paperContexts: retryPaperContexts,
          fullTextPaperContexts: retryFullTextPaperContexts,
          selectedCollectionContexts,
          selectedTagContexts,
          recentPaperContexts,
          setStatusSafely,
        })
      : await buildContextPlanForRequest({
          item,
          question,
          images: retryScreenshotImages,
          selectedTextSources: retryPair.userMessage.selectedTextSources,
          resolvedSelectedTextAnchors: retryResolvedSelectedTextAnchors,
          paperContexts: retryPaperContexts,
          fullTextPaperContexts: retryFullTextPaperContexts,
          selectedCollectionContexts,
          recentPaperContexts,
          history: llmHistory,
          effectiveRequestConfig,
          pdfPaperContexts,
          pdfUploadSystemMessages: retryPdfUploadSystemMessages.length
            ? retryPdfUploadSystemMessages
            : undefined,
          signal: getAbortController(conversationKey)?.signal,
          setStatusSafely,
        });
    const combinedContext = contextPlan.combinedContext;
    assistantMessage.quoteCitations = mergeQuoteCitations(
      assistantMessage.quoteCitations,
      contextPlan.quoteCitations,
    );
    retryPair.userMessage.paperContexts = contextPlan.paperContexts.length
      ? contextPlan.paperContexts
      : undefined;
    retryPair.userMessage.fullTextPaperContexts = contextPlan
      .fullTextPaperContexts.length
      ? contextPlan.fullTextPaperContexts
      : undefined;
    retryPair.userMessage.citationPaperContexts = mergeCitationPaperContexts(
      retryPair.userMessage.selectedTextPaperContexts,
      contextPlan.citationPaperContexts,
    );
    retryPair.userMessage.selectedCollectionContexts =
      selectedCollectionContexts.length
        ? selectedCollectionContexts
        : undefined;
    await updateStoredLatestUserMessageByConversation(
      conversationKey,
      {
        text: retryPair.userMessage.text,
        timestamp: retryPair.userMessage.timestamp,
        runMode: retryPair.userMessage.runMode,
        agentRunId: retryPair.userMessage.agentRunId,
        selectedText: retryPair.userMessage.selectedText,
        selectedTextContexts: retryPair.userMessage.selectedTextContexts,
        selectedTexts: retryPair.userMessage.selectedTexts,
        selectedTextSources: retryPair.userMessage.selectedTextSources,
        selectedTextPaperContexts:
          retryPair.userMessage.selectedTextPaperContexts,
        screenshotImages: retryPair.userMessage.screenshotImages,
        paperContexts: retryPair.userMessage.paperContexts,
        pdfPaperContexts: retryPair.userMessage.pdfPaperContexts,
        fullTextPaperContexts: retryPair.userMessage.fullTextPaperContexts,
        citationPaperContexts: retryPair.userMessage.citationPaperContexts,
        selectedCollectionContexts:
          retryPair.userMessage.selectedCollectionContexts,
        attachments: retryPair.userMessage.attachments,
        modelAttachments: retryPair.userMessage.modelAttachments,
        modelName: retryPair.userMessage.modelName,
        modelEntryId: retryPair.userMessage.modelEntryId,
        modelProviderLabel: retryPair.userMessage.modelProviderLabel,
      },
      effectiveStorageSystem,
    );
    if (getCancelledRequestId(conversationKey) >= thisRequestId) {
      getAbortController(conversationKey)?.abort();
      await finalizeCancelledAssistant();
      return;
    }

    const queueRefresh = createQueuedRefresh(refreshChatSafely);
    const codexActivityTrace = isCodexNativeTurn
      ? createCodexNativeActivityTraceController(assistantMessage, queueRefresh)
      : null;
    noteExplicitCodexNativeSkillInvocations(
      codexActivityTrace,
      retryPair.userMessage.forcedSkillIds,
    );
    if (getCancelledRequestId(conversationKey) >= thisRequestId) {
      getAbortController(conversationKey)?.abort();
      await finalizeCancelledAssistant();
      return;
    }

    // Models resolved as image-disabled reject image_url content, so drop all images.
    const allImages = supportsImageInputs(effectiveRequestConfig)
      ? [...(retryScreenshotImages || []), ...(contextPlan.modelImages || [])]
      : [];
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
      inputMode: effectiveRequestConfig.advanced?.inputMode,
      contextCache: contextPlan.contextCache,
    };
    const { finalPrepared, systemMessages, workflowTestIntercepted } =
      await prepareFinalContextPlanChatRequest({
        requestParams,
        contextPlan,
        combinedContext,
      });
    if (workflowTestIntercepted) {
      assistantMessage.text = "Workflow request intercepted before dispatch.";
      assistantMessage.streaming = false;
      refreshChatSafely();
      setStatusSafely("Workflow request captured", "ready");
      return;
    }
    const estimatedContextSnapshot = setContextUsageSnapshot(conversationKey, {
      contextTokens: finalPrepared.inputCap.estimatedAfterTokens,
      contextWindow: finalPrepared.inputCap.limitTokens,
      estimated: true,
      source: "estimated",
    });
    renderContextUsageSnapshot(body, ui.tokenUsageEl, estimatedContextSnapshot);

    responseStreamCoalescer = createBlockStreamCoalescer({
      onBlock: (chunk) => {
        assistantMessage.text += chunk;
        queueRefresh();
      },
    });
    const handleDelta = (delta: string) => {
      const chunk = sanitizeText(delta);
      if (!chunk) return;
      responseStreamCoalescer?.pushText(chunk);
    };
    const handleReasoning = (reasoningEvent: ReasoningEvent) => {
      flushResponseStream("event");
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
    };
    const handleUsage = (usage: UsageStats) => {
      recordContextCacheTelemetry(contextPlan.contextCache, usage);
      const contextTokens =
        typeof usage.contextTokens === "number" && usage.contextTokens > 0
          ? usage.contextTokens
          : 0;
      if (contextTokens <= 0) return;
      const snapshot = setContextUsageSnapshot(conversationKey, {
        contextTokens,
        contextWindow:
          usage.contextWindow || finalPrepared.inputCap.limitTokens,
        estimated: usage.contextWindowIsAuthoritative !== true,
        source:
          usage.contextWindowIsAuthoritative === true
            ? "provider"
            : "estimated",
        contextWindowIsAuthoritative: usage.contextWindowIsAuthoritative,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        cacheMissTokens: usage.cacheMissTokens,
        cacheHitRatio: usage.cacheHitRatio,
        cacheProvider: usage.cacheProvider,
      });
      renderContextUsageSnapshot(body, ui.tokenUsageEl, snapshot);
    };
    const answer = isCodexNativeTurn
      ? (
          await runCodexAppServerNativeTurn({
            scope: await enrichCodexNativeConversationScopeWithMineruCache(
              resolveCodexNativeConversationScope({
                item,
                conversationKey,
                title: question,
              }),
            ),
            model: effectiveRequestConfig.model,
            messages: finalPrepared.messages,
            reasoning: effectiveRequestConfig.reasoning,
            signal: getAbortController(conversationKey)?.signal,
            codexPath: getEffectiveCodexAppServerBinaryPath(
              effectiveRequestConfig.apiBase,
            ),
            skillContext: buildCodexNativeSkillContext({
              forcedSkillIds: retryPair.userMessage.forcedSkillIds,
              selectedTextContexts: retrySelectedTextContexts,
              resolvedSelectedTextAnchors: retryResolvedSelectedTextAnchors,
              selectedTexts: retryPair.userMessage.selectedTexts,
              selectedTextSources: retryPair.userMessage.selectedTextSources,
              selectedTextPaperContexts:
                retryPair.userMessage.selectedTextPaperContexts,
              selectedTextNoteContexts:
                retryPair.userMessage.selectedTextNoteContexts,
              paperContexts: contextPlan.paperContexts,
              pdfPaperContexts: retryPair.userMessage.pdfPaperContexts,
              localDocuments: retryLocalDocuments,
              fullTextPaperContexts: contextPlan.fullTextPaperContexts,
              pinnedPaperContexts: retryPair.userMessage.pinnedPaperContexts,
              selectedCollectionContexts,
              selectedTagContexts,
              screenshots: allImages,
              attachments,
            }),
            onSkillActivated: (skillId) => {
              flushResponseStream("event");
              codexActivityTrace?.noteSkillActivated(skillId);
              setStatusSafely(`Codex skill activated: ${skillId}`, "sending");
            },
            onDelta: handleDelta,
            onAgentMessageDelta: (event) => {
              if (!codexActivityTrace?.appendAgentMessageDelta(event)) {
                handleDelta(event.delta);
              }
            },
            onReasoning: handleReasoning,
            onUsage: handleUsage,
            onItemStarted: (event) => {
              flushResponseStream("event");
              codexActivityTrace?.appendItemStatus(event, "started");
              const itemType = sanitizeText(event.type || "");
              if (itemType && !isCodexNativeAgentMessageItem(event)) {
                setStatusSafely(`Codex: ${itemType} started`, "sending");
              }
            },
            onItemCompleted: (event) => {
              flushResponseStream("event");
              codexActivityTrace?.noteAgentMessageCompleted(event);
              codexActivityTrace?.appendItemStatus(event, "completed");
              const itemType = sanitizeText(event.type || "");
              if (itemType && !isCodexNativeAgentMessageItem(event)) {
                setStatusSafely(`Codex: ${itemType} completed`, "sending");
              }
            },
            onMcpToolActivity: (event) => {
              flushResponseStream("event");
              codexActivityTrace?.noteMcpToolActivity(event);
              assistantMessage.quoteCitations = mergeQuoteCitations(
                assistantMessage.quoteCitations,
                event.quoteCitations,
              );
              const label =
                sanitizeText(event.toolLabel || "").trim() ||
                sanitizeText(event.toolName || "")
                  .replace(/_/g, " ")
                  .trim();
              if (label) {
                setStatusSafely(
                  event.phase === "completed"
                    ? `Codex: used ${label}`
                    : `Codex: using ${label}`,
                  "sending",
                );
              }
            },
            onMcpConfirmationRequest: async ({ requestId, action }) => {
              flushResponseStream("event");
              setStatusSafely(
                action.mode === "review"
                  ? "Codex is waiting for your Zotero review"
                  : "Codex is waiting for your Zotero approval",
                "sending",
              );
              codexActivityTrace?.noteMcpConfirmationRequired(
                requestId,
                action,
              );
              const resolution = await showNativeMcpActionCard(
                body,
                requestId,
                action,
              );
              codexActivityTrace?.noteMcpConfirmationResolved(
                requestId,
                resolution,
              );
              return resolution;
            },
            onMcpSetupWarning: (message) => {
              flushResponseStream("event");
              setStatusSafely(message, "error");
            },
            onDiagnostics: (diagnostics) => {
              flushResponseStream("event");
              setStatusSafely(
                formatCodexNativeDiagnosticsStatus(diagnostics),
                "sending",
              );
            },
            onApprovalRequest: async (request) => {
              flushResponseStream("event");
              return resolveCodexNativeApprovalWithOptionalReviewCard({
                body,
                request,
                trace: codexActivityTrace,
                setStatusSafely,
              });
            },
          })
        ).text
      : await callLLMStream(
          {
            ...requestParams,
            systemMessages,
          },
          handleDelta,
          handleReasoning,
          handleUsage,
        );

    if (
      getCancelledRequestId(conversationKey) >= thisRequestId ||
      Boolean(getAbortController(conversationKey)?.signal.aborted)
    ) {
      await finalizeCancelledAssistant();
      return;
    }

    flushResponseStream("final");
    const hasGeneratedOutput = normalizeGeneratedChatImages(
      assistantMessage.generatedImages,
    ).length;
    assistantMessage.text =
      sanitizeText(answer) ||
      responseStreamCoalescer?.getFullText() ||
      (hasGeneratedOutput ? "" : "No response.");
    await finalizeAssistantMessageQuoteCitations(assistantMessage, {
      pairedUserMessage: retryPair.userMessage,
      paperContexts: contextPlan.paperContexts,
      fullTextPaperContexts: contextPlan.fullTextPaperContexts,
      citationPaperContexts: contextPlan.citationPaperContexts,
      conversationKey,
    });
    codexActivityTrace?.finish(assistantMessage.text);
    assistantMessage.timestamp = Date.now();
    assistantMessage.modelName = effectiveRequestConfig.model;
    assistantMessage.modelEntryId = effectiveRequestConfig.modelEntryId;
    assistantMessage.modelProviderLabel =
      effectiveRequestConfig.modelProviderLabel;
    assistantMessage.reasoningSummary = streamedReasoningSummary;
    assistantMessage.reasoningDetails = streamedReasoningDetails;
    assistantMessage.reasoningOpen = isReasoningExpandedByDefault();
    assistantMessage.compactMarker = isCompactCommandText(question);
    if (assistantMessage.compactMarker && !assistantMessage.text.trim()) {
      assistantMessage.text = "Conversation compacted";
    }
    assistantMessage.streaming = false;
    refreshChatSafely();

    const latestContextSnapshot = contextUsageSnapshots.get(conversationKey);
    await updateStoredLatestAssistantMessageByConversation(
      conversationKey,
      {
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
        quoteCitations: assistantMessage.quoteCitations,
        generatedImages: assistantMessage.generatedImages,
      },
      effectiveStorageSystem,
    );

    setStatusSafely("Ready", "ready");
    return true;
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
    clearPendingRequestIdAndSync(conversationKey, body, item);
    if (effectiveRequestConfig.providerProtocol !== "web_sync") {
      scheduleQueuedInputDrain(body, {
        conversationSystem:
          resolveConversationSystemForItem(item) || "upstream",
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
  contextSource?: ResolvedContextSource | null;
  userTimestamp: number;
  assistantTimestamp: number;
  newText: string;
  selectedTextContexts?: SelectedTextContext[];
  selectedTexts?: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  selectedTextNoteContexts?: (NoteContextRef | undefined)[];
  screenshotImages?: string[];
  paperContexts?: PaperContextRef[];
  pdfPaperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
  selectedTagContexts?: TagContextRef[];
  attachments?: ChatAttachment[];
  modelAttachments?: ChatAttachment[];
  localDocuments?: readonly import("../../shared/types").LocalDocumentResource[];
  pdfUploadSystemMessages?: string[];
  targetRuntimeMode?: ChatRuntimeMode;
  model?: string;
  apiBase?: string;
  apiKey?: string;
  authMode?:
    | "api_key"
    | "codex_auth"
    | "codex_app_server"
    | "copilot_auth"
    | "webchat";
  providerProtocol?: ProviderProtocol;
  modelEntryId?: string;
  modelProviderLabel?: string;
  reasoning?: LLMReasoningConfig;
  advanced?: AdvancedModelParams;
}): Promise<boolean> {
  const {
    body,
    item,
    contextSource,
    userTimestamp,
    assistantTimestamp,
    newText,
    selectedTextContexts,
    selectedTexts,
    selectedTextSources,
    selectedTextPaperContexts,
    selectedTextNoteContexts,
    screenshotImages,
    paperContexts,
    pdfPaperContexts,
    fullTextPaperContexts,
    selectedCollectionContexts,
    selectedTagContexts,
    attachments,
    modelAttachments,
    localDocuments: _localDocuments,
    pdfUploadSystemMessages,
    targetRuntimeMode,
    model,
    apiBase,
    apiKey,
    authMode,
    providerProtocol,
    modelEntryId,
    modelProviderLabel,
    reasoning,
    advanced,
  } = opts;
  await ensureConversationLoaded(item);
  const conversationKey = getConversationKey(item);
  const history = chatHistory.get(conversationKey) || [];

  const userIndex = history.findIndex(
    (m) => m.role === "user" && m.timestamp === userTimestamp,
  );
  if (userIndex < 0) {
    ztoolkit.log("LLM: editUserTurnAndRetry — user message not found");
    return false;
  }
  const assistantIndex = userIndex + 1;
  if (
    assistantIndex >= history.length ||
    history[assistantIndex]?.role !== "assistant"
  ) {
    ztoolkit.log("LLM: editUserTurnAndRetry — assistant message not found");
    return false;
  }
  if (history[assistantIndex]!.streaming) {
    ztoolkit.log("LLM: editUserTurnAndRetry — assistant is still streaming");
    return false;
  }
  const retryRequestConfig = resolveEffectiveRequestConfig({
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
  const retryConversationSystem = resolveEffectiveConversationSystem({
    item,
    authMode: retryRequestConfig.authMode,
    providerProtocol: retryRequestConfig.providerProtocol,
    modelProviderLabel: retryRequestConfig.modelProviderLabel,
  });
  const retryStorageSystem =
    resolveConversationStorageSystemForItem({
      item,
      conversationSystem: retryConversationSystem,
    }) || retryConversationSystem;
  const retryRuntimeMode: ChatRuntimeMode =
    retryConversationSystem === "codex"
      ? "chat"
      : targetRuntimeMode ||
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
      const storageSystem = resolveConversationStorageSystem({
        conversationKey,
        conversationSystem: retryStorageSystem,
      });
      if (!storageSystem) {
        continue;
      }
      await conversationRepository.deleteTurnMessages({
        system: storageSystem,
        conversationKey,
        userTimestamp: p.userTs,
        assistantTimestamp: p.assistantTs,
      });
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
  const selectedTextContextsForMessage = synthesizeSelectedTextContexts({
    selectedTextContexts,
    selectedTexts,
    selectedTextSources,
    selectedTextPaperContexts,
    selectedTextNoteContexts,
    sanitizeText,
  });
  const selectedTextsForMessage = selectedTextContextsForMessage.map(
    (context) => context.text,
  );
  const selectedTextSourcesForMessage = selectedTextContextsForMessage.map(
    (context) => context.source,
  );
  const selectedTextPaperContextsForMessage =
    selectedTextContextsForMessage.map((context) => context.paperContext);
  const selectedTextNoteContextsForMessage = selectedTextContextsForMessage.map(
    (context) => context.noteContext,
  );
  const selectedTextForMessage = selectedTextsForMessage[0] || "";
  const screenshotImagesForMessage = Array.isArray(screenshotImages)
    ? screenshotImages
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, MAX_SELECTED_IMAGES)
    : [];
  const normalizedPaperContexts = normalizeEditablePaperContexts([
    ...(paperContexts || []),
    ...selectedTextPaperContextsForMessage.filter(
      (paper): paper is PaperContextRef => Boolean(paper),
    ),
  ]);
  const normalizedPdfPaperContexts = normalizePaperContexts(
    pdfPaperContexts,
  ).map((paper) => ({ ...paper, contentSourceMode: "pdf" as const }));
  const normalizedFullTextPaperContexts =
    normalizeEditableFullTextPaperContexts(fullTextPaperContexts);
  const selectedCollectionContextsForMessage = normalizeCollectionContexts(
    selectedCollectionContexts,
  );
  const selectedTagContextsForMessage =
    normalizeTagContexts(selectedTagContexts);
  const pdfExcludeKeysEdit = new Set(
    normalizedPdfPaperContexts.map(
      (paper) => `${paper.itemId}:${paper.contextItemId}`,
    ),
  );
  const {
    paperContexts: paperContextsForMessage,
    fullTextPaperContexts: fullTextPaperContextsForMessage,
  } = includeAutoLoadedPaperContext(
    item,
    normalizedPaperContexts,
    normalizedFullTextPaperContexts,
    pdfExcludeKeysEdit.size > 0 ? pdfExcludeKeysEdit : undefined,
    contextSource,
  );
  const attachmentsForMessage = normalizeEditableAttachments(attachments);
  userMsg.selectedText = selectedTextForMessage || undefined;
  userMsg.selectedTextExpanded = false;
  userMsg.selectedTextContexts = selectedTextContextsForMessage.length
    ? selectedTextContextsForMessage
    : undefined;
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
  userMsg.pdfPaperContexts = normalizedPdfPaperContexts.length
    ? normalizedPdfPaperContexts
    : undefined;
  userMsg.fullTextPaperContexts = fullTextPaperContextsForMessage.length
    ? fullTextPaperContextsForMessage
    : undefined;
  userMsg.selectedCollectionContexts =
    selectedCollectionContextsForMessage.length
      ? selectedCollectionContextsForMessage
      : undefined;
  userMsg.selectedTagContexts = selectedTagContextsForMessage.length
    ? selectedTagContextsForMessage
    : undefined;
  userMsg.paperContextsExpanded = false;
  userMsg.attachments = attachmentsForMessage.length
    ? attachmentsForMessage
    : undefined;
  if (modelAttachments !== undefined) {
    userMsg.modelAttachments = normalizeEditableAttachments(modelAttachments);
  } else {
    userMsg.modelAttachments = undefined;
  }
  userMsg.modelName = retryRequestConfig.model;
  userMsg.modelEntryId = retryRequestConfig.modelEntryId;
  userMsg.modelProviderLabel = retryRequestConfig.modelProviderLabel;
  userMsg.attachmentsExpanded = false;
  userMsg.attachmentActiveIndex = undefined;

  // Persist the updated user message
  try {
    await updateStoredLatestUserMessageByConversation(
      conversationKey,
      {
        text: userMsg.text,
        timestamp: userMsg.timestamp,
        runMode: userMsg.runMode,
        agentRunId: userMsg.agentRunId,
        selectedText: userMsg.selectedText,
        selectedTextContexts: userMsg.selectedTextContexts,
        selectedTexts: userMsg.selectedTexts,
        selectedTextSources: userMsg.selectedTextSources,
        selectedTextPaperContexts: userMsg.selectedTextPaperContexts,
        selectedTextNoteContexts: userMsg.selectedTextNoteContexts,
        forcedSkillIds: userMsg.forcedSkillIds,
        screenshotImages: userMsg.screenshotImages,
        paperContexts: userMsg.paperContexts,
        pdfPaperContexts: userMsg.pdfPaperContexts,
        fullTextPaperContexts: userMsg.fullTextPaperContexts,
        citationPaperContexts: getMessageCitationPaperContexts(userMsg),
        selectedCollectionContexts: userMsg.selectedCollectionContexts,
        selectedTagContexts: userMsg.selectedTagContexts,
        attachments: userMsg.attachments,
        modelAttachments: userMsg.modelAttachments,
        modelName: userMsg.modelName,
        modelEntryId: userMsg.modelEntryId,
        modelProviderLabel: userMsg.modelProviderLabel,
      },
      retryStorageSystem,
    );
  } catch (err) {
    ztoolkit.log("LLM: Failed to persist edited user message", err);
  }

  // Route agent-mode retries through the agent runtime so tools are available
  // and the old trace is properly cleared before the new run starts.
  const isAgentRetry = retryRuntimeMode === "agent";
  const retrySucceeded = isAgentRetry
    ? await retryLatestAgentResponse(
        body,
        item,
        retryRequestConfig.model,
        retryRequestConfig.apiBase,
        retryRequestConfig.apiKey,
        retryRequestConfig.authMode,
        retryRequestConfig.providerProtocol,
        retryRequestConfig.modelEntryId,
        retryRequestConfig.modelProviderLabel,
        retryRequestConfig.reasoning,
        retryRequestConfig.advanced,
        modelAttachments,
      )
    : await retryLatestAssistantResponse(
        body,
        item,
        retryRequestConfig.model,
        retryRequestConfig.apiBase,
        retryRequestConfig.apiKey,
        retryRequestConfig.authMode,
        retryRequestConfig.providerProtocol,
        retryRequestConfig.modelEntryId,
        retryRequestConfig.modelProviderLabel,
        retryRequestConfig.reasoning,
        retryRequestConfig.advanced,
        pdfUploadSystemMessages,
        modelAttachments,
      );
  return retrySucceeded === true;
}

export type BuildAgentRuntimeRequestParams = {
  conversationKey: number;
  item: Zotero.Item;
  userText: string;
  selectedTextContexts?: SelectedTextContext[];
  resolvedSelectedTextAnchors?: ResolvedSelectedTextAnchor[];
  selectedTexts: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  selectedTextNoteContexts?: (NoteContextRef | undefined)[];
  paperContexts: PaperContextRef[];
  pdfPaperContexts?: PaperContextRef[];
  fullTextPaperContexts: PaperContextRef[];
  citationPaperContexts?: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
  selectedTagContexts?: TagContextRef[];
  attachments: ChatAttachment[] | undefined;
  localDocuments?: readonly import("../../shared/types").LocalDocumentResource[];
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
      mineruCacheDir = await ensureMineruCacheDirForAttachment(
        Zotero.Items.get(paper.contextItemId),
      );
    } catch {
      /* ignore */
    }
    enriched.push(mineruCacheDir ? { ...paper, mineruCacheDir } : paper);
  }
  return enriched;
}

async function enrichCodexNativeConversationScopeWithMineruCache(
  scope: CodexNativeConversationScope,
): Promise<CodexNativeConversationScope> {
  if (!scope.paperContext) return scope;
  const enriched = await enrichPaperContextsWithMineruCache([
    scope.paperContext,
  ]);
  const paperContext = enriched?.[0];
  if (!paperContext || paperContext === scope.paperContext) return scope;
  return { ...scope, paperContext };
}

function normalizeAttachmentResourceText(value: unknown): string {
  return typeof value === "string" ? sanitizeText(value).trim() : "";
}

function getAttachmentFilename(item: Zotero.Item | null | undefined): string {
  return normalizeAttachmentResourceText(
    (item as unknown as { attachmentFilename?: unknown })?.attachmentFilename,
  );
}

function getAttachmentContentType(
  item: Zotero.Item | null | undefined,
): string {
  return normalizeAttachmentResourceText(
    (item as unknown as { attachmentContentType?: unknown })
      ?.attachmentContentType,
  ).toLowerCase();
}

function getAttachmentDisplayTitle(item: Zotero.Item): string {
  return (
    normalizeAttachmentResourceText(item.getField?.("title")) ||
    getAttachmentFilename(item) ||
    `Attachment ${item.id}`
  );
}

function getAttachmentResourceType(input: {
  contentType: string;
  filename: string;
}): AgentAttachmentResource["attachmentType"] {
  return (
    resolveContextAttachmentSupportFromMetadata(input)?.attachmentType ||
    "unsupported"
  );
}

function getAttachmentReadableVia(
  attachmentType: AgentAttachmentResource["attachmentType"],
): AgentAttachmentResource["readableVia"] {
  if (attachmentType === "pdf") return "paper_read";
  if (
    attachmentType === "markdown" ||
    attachmentType === "html" ||
    attachmentType === "txt" ||
    attachmentType === "docx"
  ) {
    return "read_attachment";
  }
  return "unsupported";
}

function getParentTitle(item: Zotero.Item): string {
  return (
    normalizeAttachmentResourceText(item.getField?.("title")) ||
    normalizeAttachmentResourceText(item.getDisplayTitle?.()) ||
    `Item ${item.id}`
  );
}

function buildAttachmentResourceForChild(params: {
  parentItem: Zotero.Item;
  attachmentItem: Zotero.Item;
  primaryContextItemIds: Set<number>;
}): AgentAttachmentResource | null {
  if (!params.parentItem.isRegularItem?.()) return null;
  if (!params.attachmentItem.isAttachment?.()) return null;
  const contextItemId = Number(params.attachmentItem.id);
  const parentItemId = Number(params.parentItem.id);
  if (!Number.isFinite(contextItemId) || !Number.isFinite(parentItemId)) {
    return null;
  }
  const filename = getAttachmentFilename(params.attachmentItem);
  const contentType =
    getAttachmentContentType(params.attachmentItem) ||
    "application/octet-stream";
  const attachmentType = getAttachmentResourceType({ contentType, filename });
  const readableVia = getAttachmentReadableVia(attachmentType);
  const contentSourceMode =
    attachmentType === "pdf" ||
    attachmentType === "markdown" ||
    attachmentType === "html" ||
    attachmentType === "txt" ||
    attachmentType === "docx"
      ? attachmentType
      : undefined;
  return {
    lifecycleState: "available",
    parentItemId: Math.floor(parentItemId),
    parentTitle: getParentTitle(params.parentItem),
    contextItemId: Math.floor(contextItemId),
    title: getAttachmentDisplayTitle(params.attachmentItem),
    contentType,
    attachmentType,
    readableVia,
    contentSourceMode,
    isPrimary: params.primaryContextItemIds.has(Math.floor(contextItemId)),
  };
}

function collectAttachmentResourcesForParent(params: {
  parentItem: Zotero.Item | null | undefined;
  primaryContextItemIds: Set<number>;
}): AgentAttachmentResource[] {
  const parentItem = params.parentItem;
  if (!parentItem?.isRegularItem?.()) return [];
  const attachmentIds = parentItem.getAttachments?.() || [];
  const resources: AgentAttachmentResource[] = [];
  for (const attachmentId of attachmentIds) {
    const attachmentItem = Zotero.Items.get(attachmentId) || null;
    const resource = attachmentItem
      ? buildAttachmentResourceForChild({
          parentItem,
          attachmentItem,
          primaryContextItemIds: params.primaryContextItemIds,
        })
      : null;
    if (resource) resources.push(resource);
  }
  return resources;
}

function collectUniqueParentItemsForPapers(
  papers: PaperContextRef[],
): Zotero.Item[] {
  const out: Zotero.Item[] = [];
  const seen = new Set<number>();
  for (const paper of papers) {
    const itemId = Number(paper.itemId);
    if (!Number.isFinite(itemId) || itemId <= 0) continue;
    const normalized = Math.floor(itemId);
    if (seen.has(normalized)) continue;
    const item = Zotero.Items.get(normalized) || null;
    if (!item?.isRegularItem?.()) continue;
    seen.add(normalized);
    out.push(item);
  }
  return out;
}

function incrementAttachmentCount(
  counts: AgentAttachmentResourceSummary["attachmentCounts"],
  attachmentType: AgentAttachmentResource["attachmentType"],
): void {
  counts[attachmentType] = (counts[attachmentType] || 0) + 1;
}

function buildCollectionAttachmentResourceSummary(
  collectionContext: CollectionContextRef,
): AgentAttachmentResourceSummary | null {
  const collection = Zotero.Collections.get(collectionContext.collectionId);
  if (!collection) return null;
  const parentItemIds = new Set<number>();
  const rawChildIds = collection.getChildItems?.(true, false) || [];
  for (const rawId of rawChildIds) {
    const itemId = Number(rawId);
    if (!Number.isFinite(itemId) || itemId <= 0) continue;
    const item = Zotero.Items.get(Math.floor(itemId)) || null;
    if (!item?.isRegularItem?.()) continue;
    parentItemIds.add(Math.floor(itemId));
  }
  const attachmentCounts: AgentAttachmentResourceSummary["attachmentCounts"] =
    {};
  for (const parentItemId of parentItemIds) {
    const parentItem = Zotero.Items.get(parentItemId) || null;
    if (!parentItem?.isRegularItem?.()) continue;
    for (const attachmentId of parentItem.getAttachments?.() || []) {
      const attachmentItem = Zotero.Items.get(attachmentId) || null;
      if (!attachmentItem?.isAttachment?.()) continue;
      const contentType =
        getAttachmentContentType(attachmentItem) || "application/octet-stream";
      const filename = getAttachmentFilename(attachmentItem);
      incrementAttachmentCount(
        attachmentCounts,
        getAttachmentResourceType({ contentType, filename }),
      );
    }
  }
  return {
    scope: "selected-collection",
    collectionId: collectionContext.collectionId,
    libraryID: collectionContext.libraryID,
    collectionName:
      normalizeAttachmentResourceText(collectionContext.name) ||
      normalizeAttachmentResourceText(collection.name) ||
      `Collection ${collectionContext.collectionId}`,
    parentItemCount: parentItemIds.size,
    attachmentCounts,
  };
}

function buildAgentAttachmentResourcePool(params: {
  paperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
}): {
  resources?: AgentAttachmentResource[];
  summaries?: AgentAttachmentResourceSummary[];
} {
  const papers = normalizePaperContexts([
    ...(params.paperContexts || []),
    ...(params.fullTextPaperContexts || []),
  ]);
  const primaryContextItemIds = new Set(
    papers
      .map((paper) => Number(paper.contextItemId))
      .filter((id) => Number.isFinite(id) && id > 0)
      .map((id) => Math.floor(id)),
  );
  const resources = collectUniqueParentItemsForPapers(papers).flatMap(
    (parentItem) =>
      collectAttachmentResourcesForParent({
        parentItem,
        primaryContextItemIds,
      }),
  );
  const summaries = normalizeCollectionContexts(
    params.selectedCollectionContexts,
  )
    .map(buildCollectionAttachmentResourceSummary)
    .filter((summary): summary is AgentAttachmentResourceSummary =>
      Boolean(summary),
    );
  return {
    resources: resources.length ? resources : undefined,
    summaries: summaries.length ? summaries : undefined,
  };
}

async function buildAgentRuntimeRequest(
  params: BuildAgentRuntimeRequestParams,
): Promise<AgentRuntimeRequest> {
  const normalizedPdfPaperContexts = normalizePaperContexts(
    params.pdfPaperContexts,
  );
  const localDocuments = params.localDocuments?.length
    ? params.localDocuments
    : undefined;
  const rawPdfPaperContexts = localDocuments ? normalizedPdfPaperContexts : [];
  if (localDocuments) {
    validateLocalPdfDocumentBatch({
      pdfPaperContexts: rawPdfPaperContexts,
      localDocuments,
    });
  }
  const [enrichedPaperContexts, enrichedFullTextPapers] = await Promise.all([
    enrichPaperContextsWithMineruCache(params.paperContexts),
    enrichPaperContextsWithMineruCache(params.fullTextPaperContexts),
  ]);
  const attachmentResourcePool = buildAgentAttachmentResourcePool({
    paperContexts: enrichedPaperContexts,
    fullTextPaperContexts: enrichedFullTextPapers,
    selectedCollectionContexts: params.selectedCollectionContexts,
  });
  const activeNoteSession = resolveActiveNoteSession(params.item);
  const conversationKind =
    activeNoteSession?.conversationKind ||
    resolveDisplayConversationKind(params.item) ||
    undefined;
  return {
    conversationKey: params.conversationKey,
    mode: "agent",
    userText: params.userText,
    conversationKind,
    activeItemId: activeNoteSession?.noteId || params.item.id,
    selectedTextContexts: params.selectedTextContexts,
    resolvedSelectedTextAnchors: params.resolvedSelectedTextAnchors,
    selectedTexts: params.selectedTexts,
    selectedTextSources: params.selectedTextSources,
    selectedTextPaperContexts: params.selectedTextPaperContexts,
    selectedTextNoteContexts: params.selectedTextNoteContexts,
    selectedPaperContexts: enrichedPaperContexts,
    pdfPaperContexts: rawPdfPaperContexts.length
      ? rawPdfPaperContexts.map((paper) => ({
          ...paper,
          contentSourceMode: "pdf" as const,
        }))
      : undefined,
    localDocuments,
    fullTextPaperContexts: enrichedFullTextPapers,
    citationPaperContexts: normalizePaperContexts(params.citationPaperContexts),
    selectedCollectionContexts: normalizeCollectionContexts(
      params.selectedCollectionContexts,
    ),
    selectedTagContexts: normalizeTagContexts(params.selectedTagContexts),
    availableAttachmentResources: attachmentResourcePool.resources,
    attachmentResourceSummaries: attachmentResourcePool.summaries,
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
            ? getClaudeReasoningModePref() === "max"
              ? "max"
              : "xhigh"
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
        !isCompactCommandText(params.userText),
      claudeAutoCompactThresholdPercent:
        params.effectiveRequestConfig.modelProviderLabel === "Claude Code"
          ? getClaudeAutoCompactThresholdPercent()
          : undefined,
      claudeHistoryLength: params.history.length,
      notesDirectoryConfig: getNotesDirectoryConfig() || undefined,
    },
  };
}

export const buildAgentRuntimeRequestForTests = buildAgentRuntimeRequest;

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
    setCurrentAbortController: (ck: number, ctrl: AbortController | null) =>
      setAbortController(ck, ctrl),
    getAbortControllerCtor,
    nextRequestId,
    setPendingRequestId: (ck: number, id: number) =>
      setPendingRequestIdAndSync(ck, id),
    getPanelRequestUI,
    setRequestUIBusy,
    restoreRequestUIIdle,
    scheduleQueuedInputDrain,
    createPanelUpdateHelpers,
    ensureConversationLoaded,
    getConversationKey,
    buildLLMHistoryMessages,
    buildAgentRuntimeRequest,
    resolveLocalPdfResources: (paperContexts) =>
      createLocalPdfResourceResolver().resolve(paperContexts),
    preflightLocalPdfCapability: async () => {
      if (getEffectiveConversationSystem() === "claude_code") {
        await preflightClaudeBridgeLocalPdfCapability();
      }
    },
    resolveEffectiveRequestConfig,
    getConversationSystem: () => getEffectiveConversationSystem(),
    accumulateSessionTokens,
    getContextUsageSnapshot: (conversationKey: number) =>
      contextUsageSnapshots.get(conversationKey),
    setContextUsageSnapshot: (
      conversationKey: number,
      snapshot: ContextUsageSnapshot,
    ) => {
      setContextUsageSnapshot(conversationKey, snapshot);
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
    resetAssistantQuoteDisplay,
    finalizeAssistantQuoteCitations: async (
      assistantMessage,
      pairedUserMessage,
      runtimeRequest,
    ) => {
      await finalizeAssistantMessageQuoteCitations(assistantMessage, {
        pairedUserMessage,
        runtimeRequest,
        paperContexts: runtimeRequest?.selectedPaperContexts,
        fullTextPaperContexts: runtimeRequest?.fullTextPaperContexts,
        citationPaperContexts: runtimeRequest?.citationPaperContexts,
        conversationKey: currentItem
          ? getConversationKey(currentItem)
          : undefined,
      });
    },
    appendReasoningPart,
    persistConversationMessage: async (conversationKey, message) => {
      const system = getEffectiveConversationSystem();
      const storageSystem = currentItem
        ? resolveConversationStorageSystemForItem({
            item: currentItem,
            conversationSystem: system,
          })
        : system;
      if (
        currentItem &&
        !(await validateConversationScopeForItem({
          item: currentItem,
          conversationKey,
          conversationSystem: system,
        }))
      ) {
        return;
      }
      await persistConversationMessage(conversationKey, message, storageSystem);
    },
    updateStoredLatestUserMessage: async (conversationKey, data) => {
      const system = getEffectiveConversationSystem();
      const storageSystem = currentItem
        ? resolveConversationStorageSystemForItem({
            item: currentItem,
            conversationSystem: system,
          })
        : system;
      if (
        currentItem &&
        !(await validateConversationScopeForItem({
          item: currentItem,
          conversationKey,
          conversationSystem: system,
        }))
      ) {
        return;
      }
      await updateStoredLatestUserMessageByConversation(
        conversationKey,
        data as Parameters<
          typeof updateStoredLatestUserMessageByConversation
        >[1],
        storageSystem,
      );
    },
    updateStoredLatestAssistantMessage: async (conversationKey, data) => {
      const system = getEffectiveConversationSystem();
      const storageSystem = currentItem
        ? resolveConversationStorageSystemForItem({
            item: currentItem,
            conversationSystem: system,
          })
        : system;
      if (
        currentItem &&
        !(await validateConversationScopeForItem({
          item: currentItem,
          conversationKey,
          conversationSystem: system,
        }))
      ) {
        return;
      }
      await updateStoredLatestAssistantMessageByConversation(
        conversationKey,
        data as Parameters<
          typeof updateStoredLatestAssistantMessageByConversation
        >[1],
        storageSystem,
      );
    },
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
  authMode?:
    | "api_key"
    | "codex_auth"
    | "codex_app_server"
    | "copilot_auth"
    | "webchat",
  providerProtocol?: ProviderProtocol,
  modelEntryId?: string,
  modelProviderLabel?: string,
  reasoning?: LLMReasoningConfig,
  advanced?: AdvancedModelParams,
  modelAttachmentsOverride?: ChatAttachment[],
): Promise<true> {
  const conversationSystem = resolveEffectiveConversationSystem({
    item,
    authMode,
    providerProtocol,
    modelProviderLabel,
  });
  await initAgentSubsystem();
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
    modelAttachmentsOverride,
    buildAgentEngineDeps(item, conversationSystem),
  );
  return true;
}

async function sendAgentQuestion(opts: {
  body: Element;
  item: Zotero.Item;
  contextSource?: ResolvedContextSource | null;
  question: string;
  images?: string[];
  model?: string;
  apiBase?: string;
  apiKey?: string;
  authMode?:
    | "api_key"
    | "codex_auth"
    | "codex_app_server"
    | "copilot_auth"
    | "webchat";
  providerProtocol?: ProviderProtocol;
  modelEntryId?: string;
  modelProviderLabel?: string;
  reasoning?: LLMReasoningConfig;
  advanced?: AdvancedModelParams;
  displayQuestion?: string;
  selectedTextContexts?: SelectedTextContext[];
  resolvedSelectedTextAnchors?: ResolvedSelectedTextAnchor[];
  selectedTexts?: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  selectedTextNoteContexts?: (NoteContextRef | undefined)[];
  paperContexts?: PaperContextRef[];
  pdfPaperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
  selectedTagContexts?: TagContextRef[];
  attachments?: ChatAttachment[];
  modelAttachments?: ChatAttachment[];
  localDocuments?: readonly import("../../shared/types").LocalDocumentResource[];
  forcedSkillIds?: string[];
  pdfUploadSystemMessages?: string[];
  conversationSystem?: ConversationSystem;
}): Promise<void> {
  const conversationKey = getConversationKey(opts.item);
  const safeConversationScope = await validateConversationScopeForItem({
    item: opts.item,
    conversationKey,
    conversationSystem: opts.conversationSystem,
  });
  if (!safeConversationScope) {
    const ui = getPanelRequestUI(opts.body);
    const helpers = createPanelUpdateHelpers(
      opts.body,
      opts.item,
      conversationKey,
      ui,
    );
    helpers.setStatusSafely(
      "Conversation identity mismatch; open a new chat.",
      "error",
    );
    return;
  }
  await initAgentSubsystem();
  await sendAgentTurn(
    opts,
    buildAgentEngineDeps(opts.item, opts.conversationSystem),
  );
}

export async function sendQuestion(
  opts: import("./types").SendQuestionOptions,
) {
  const {
    body,
    item,
    contextSource,
    question,
    images,
    model,
    apiBase,
    apiKey,
    reasoning,
    advanced,
    displayQuestion,
    selectedTextContexts,
    resolvedSelectedTextAnchors,
    selectedTexts,
    selectedTextSources,
    selectedTextPaperContexts,
    selectedTextNoteContexts,
    paperContexts,
    pdfPaperContexts,
    fullTextPaperContexts,
    selectedCollectionContexts,
    selectedTagContexts,
    attachments,
    modelAttachments,
    localDocuments,
    runtimeMode = "chat",
    agentRunId,
    skipAgentDispatch = false,
  } = opts;
  const effectiveConversationSystem = resolveEffectiveConversationSystem({
    item,
    authMode: opts.authMode,
    providerProtocol: opts.providerProtocol,
    modelProviderLabel: opts.modelProviderLabel,
  });
  const effectiveStorageSystem =
    resolveConversationStorageSystemForItem({
      item,
      conversationSystem: effectiveConversationSystem,
    }) || effectiveConversationSystem;
  const effectiveRuntimeMode: ChatRuntimeMode =
    effectiveConversationSystem === "claude_code"
      ? "agent"
      : effectiveConversationSystem === "codex"
        ? "chat"
        : runtimeMode;
  if (effectiveRuntimeMode === "agent" && !skipAgentDispatch) {
    await sendAgentQuestion({
      body,
      item,
      contextSource: opts.contextSource,
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
      selectedTextContexts,
      resolvedSelectedTextAnchors,
      selectedTexts,
      selectedTextSources,
      selectedTextPaperContexts,
      selectedTextNoteContexts,
      paperContexts,
      pdfPaperContexts,
      fullTextPaperContexts,
      selectedCollectionContexts,
      selectedTagContexts,
      attachments,
      modelAttachments,
      localDocuments,
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
  setPendingRequestIdAndSync(initialConversationKey, thisRequestId, body, item);

  // Show cancel, hide send
  setRequestUIBusy(body, ui, initialConversationKey, "Preparing request...");

  const shownQuestion = displayQuestion || question;
  await ensureConversationLoaded(item);
  const provisionalConversationKey = getConversationKey(item);
  if (!chatHistory.has(provisionalConversationKey)) {
    chatHistory.set(provisionalConversationKey, []);
  }
  const provisionalHistory = chatHistory.get(provisionalConversationKey)!;
  const reuseAgentFallbackPlaceholder =
    effectiveRuntimeMode === "agent" && skipAgentDispatch;
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
  optimisticHelpers.setStatusSafely(
    "Checking the request against the attached context.",
    "sending",
  );
  optimisticHelpers.refreshChatSafely();

  const conversationKey = getConversationKey(item);
  if (conversationKey !== initialConversationKey) {
    clearPendingRequestIdAndSync(initialConversationKey, body, item);
    setPendingRequestIdAndSync(conversationKey, thisRequestId, body, item);
  }
  const safeConversationScope = await validateConversationScopeForItem({
    item,
    conversationKey,
    conversationSystem: effectiveConversationSystem,
  });
  if (!safeConversationScope) {
    removeMessageReference(provisionalHistory, optimisticUserMessage);
    removeMessageReference(provisionalHistory, optimisticAssistantMessage);
    optimisticHelpers.refreshChatSafely();
    optimisticHelpers.setStatusSafely(
      "Conversation identity mismatch; open a new chat.",
      "error",
    );
    restoreRequestUIIdle(body, conversationKey, thisRequestId);
    clearPendingRequestIdAndSync(conversationKey, body, item);
    return;
  }

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
    authMode: opts.authMode,
    providerProtocol: opts.providerProtocol,
    modelEntryId: opts.modelEntryId,
    modelProviderLabel: opts.modelProviderLabel,
    reasoning,
    advanced,
  });
  const shouldPersistTurn =
    effectiveRequestConfig.providerProtocol !== "web_sync";
  const isCodexNativeTurn =
    effectiveConversationSystem === "codex" &&
    effectiveRequestConfig.authMode === "codex_app_server";
  const isCodexNativeCompactCommand =
    isCodexNativeTurn && isCompactCommandText(question);
  if (isCodexNativeCompactCommand) {
    removeMessageReference(provisionalHistory, optimisticUserMessage);
    removeMessageReference(provisionalHistory, optimisticAssistantMessage);
    if (history !== provisionalHistory) {
      removeMessageReference(history, optimisticUserMessage);
      removeMessageReference(history, optimisticAssistantMessage);
    }

    const compactMessage = optimisticAssistantMessage;
    compactMessage.role = "assistant";
    compactMessage.text = "Compacting context...";
    compactMessage.timestamp = Date.now();
    compactMessage.runMode = "agent";
    compactMessage.agentRunId = agentRunId || undefined;
    compactMessage.modelName = effectiveRequestConfig.model;
    compactMessage.modelEntryId = effectiveRequestConfig.modelEntryId;
    compactMessage.modelProviderLabel =
      effectiveRequestConfig.modelProviderLabel;
    compactMessage.streaming = true;
    compactMessage.compactMarker = true;
    compactMessage.waitingAnimationStartedAt = Date.now();
    compactMessage.reasoningSummary = undefined;
    compactMessage.reasoningDetails = undefined;
    compactMessage.reasoningOpen = false;
    compactMessage.quoteCitations = undefined;
    history.push(compactMessage);
    if (history.length > PERSISTED_HISTORY_LIMIT) {
      history.splice(0, history.length - PERSISTED_HISTORY_LIMIT);
    }

    const { refreshChatSafely, setStatusSafely } = createPanelUpdateHelpers(
      body,
      item,
      conversationKey,
      ui,
    );
    setStatusSafely("Compacting Codex context...", "sending");
    refreshChatSafely();

    const removeCompactMessage = () => {
      removeMessageReference(history, compactMessage);
      refreshChatSafely();
    };
    const persistCompactError = async (errMsg: string) => {
      compactMessage.text = `Error: ${errMsg}`;
      compactMessage.streaming = false;
      compactMessage.compactMarker = false;
      compactMessage.timestamp = Date.now();
      refreshChatSafely();
      await persistConversationMessage(
        conversationKey,
        {
          role: "assistant",
          text: compactMessage.text,
          timestamp: compactMessage.timestamp,
          runMode: compactMessage.runMode,
          agentRunId: compactMessage.agentRunId,
          modelName: compactMessage.modelName,
          modelEntryId: compactMessage.modelEntryId,
          modelProviderLabel: compactMessage.modelProviderLabel,
        },
        effectiveStorageSystem,
      );
    };

    const AbortControllerCtor = getAbortControllerCtor();
    setAbortController(
      conversationKey,
      AbortControllerCtor ? new AbortControllerCtor() : null,
    );
    try {
      await compactCodexAppServerConversation({
        conversationKey,
        codexPath: getEffectiveCodexAppServerBinaryPath(
          effectiveRequestConfig.apiBase,
        ),
        signal: getAbortController(conversationKey)?.signal,
      });
      if (
        getCancelledRequestId(conversationKey) >= thisRequestId ||
        Boolean(getAbortController(conversationKey)?.signal.aborted)
      ) {
        removeCompactMessage();
        setStatusSafely("Cancelled", "ready");
        return;
      }

      compactMessage.text = "Context compacted";
      compactMessage.streaming = false;
      compactMessage.timestamp = Date.now();
      refreshChatSafely();
      await persistConversationMessage(
        conversationKey,
        {
          role: "assistant",
          text: compactMessage.text,
          timestamp: compactMessage.timestamp,
          runMode: compactMessage.runMode,
          agentRunId: compactMessage.agentRunId,
          modelName: compactMessage.modelName,
          modelEntryId: compactMessage.modelEntryId,
          modelProviderLabel: compactMessage.modelProviderLabel,
          compactMarker: true,
        },
        effectiveStorageSystem,
      );
      setStatusSafely("Ready", "ready");
    } catch (err) {
      const isCancelled =
        getCancelledRequestId(conversationKey) >= thisRequestId ||
        Boolean(getAbortController(conversationKey)?.signal.aborted) ||
        (err as { name?: string }).name === "AbortError";
      if (isCancelled) {
        removeCompactMessage();
        setStatusSafely("Cancelled", "ready");
        return;
      }
      const errMsg = (err as Error).message || "Error";
      if (errMsg === NO_CODEX_APP_SERVER_THREAD_TO_COMPACT_MESSAGE) {
        removeCompactMessage();
        setStatusSafely(errMsg, "error");
        return;
      }
      await persistCompactError(errMsg);
      setStatusSafely(`Error: ${errMsg.slice(0, 40)}`, "error");
    } finally {
      restoreRequestUIIdle(body, conversationKey, thisRequestId);
      setAbortController(conversationKey, null);
      clearPendingRequestIdAndSync(conversationKey, body, item);
      scheduleQueuedInputDrain(body, {
        conversationSystem:
          resolveConversationSystemForItem(item) || "upstream",
        conversationKey,
      });
    }
    return;
  }
  const requestFileAttachments = normalizeModelFileAttachments(
    modelAttachments ?? attachments,
    {
      authMode: effectiveRequestConfig.authMode,
      runtimeMode: effectiveRuntimeMode,
    },
  );
  const selectedTextContextsForMessage = synthesizeSelectedTextContexts({
    selectedTextContexts,
    selectedTexts,
    selectedTextSources,
    selectedTextPaperContexts,
    selectedTextNoteContexts,
    sanitizeText,
  });
  const selectedTextsForMessage = selectedTextContextsForMessage.map(
    (context) => context.text,
  );
  const selectedTextSourcesForMessage = selectedTextContextsForMessage.map(
    (context) => context.source,
  );
  const selectedTextPaperContextsForMessage =
    selectedTextContextsForMessage.map((context) => context.paperContext);
  const selectedTextNoteContextsForMessage = selectedTextContextsForMessage.map(
    (context) => context.noteContext,
  );
  const selectedTextForMessage = selectedTextsForMessage[0] || "";
  const normalizedPaperContexts = normalizePaperContexts([
    ...(paperContexts || []),
    ...selectedTextPaperContextsForMessage.filter(
      (paper): paper is PaperContextRef => Boolean(paper),
    ),
  ]);
  const normalizedPdfPaperContexts = normalizePaperContexts(
    pdfPaperContexts,
  ).map((paper) => ({ ...paper, contentSourceMode: "pdf" as const }));
  const normalizedWebChatPdfPaperContexts = normalizePaperContexts(
    opts.webchatPdfPaperContexts ?? normalizedPdfPaperContexts,
  ).map((paper) => ({ ...paper, contentSourceMode: "pdf" as const }));
  const pdfModePaperKeys = new Set(
    normalizedPdfPaperContexts.map(
      (paper) => `${paper.itemId}:${paper.contextItemId}`,
    ),
  );
  const normalizedFullTextPaperContexts = normalizePaperContexts(
    fullTextPaperContexts,
  );
  const selectedCollectionContextsForMessage = normalizeCollectionContexts(
    selectedCollectionContexts,
  );
  const selectedTagContextsForMessage =
    normalizeTagContexts(selectedTagContexts);
  let {
    paperContexts: paperContextsForMessage,
    fullTextPaperContexts: fullTextPaperContextsForMessage,
  } = includeAutoLoadedPaperContext(
    item,
    normalizedPaperContexts,
    normalizedFullTextPaperContexts,
    pdfModePaperKeys.size > 0 ? pdfModePaperKeys : undefined,
    contextSource,
  );
  if (shouldUseCodexNativeLightContext({ isCodexNativeTurn })) {
    const [enrichedPaperContexts, enrichedFullTextPaperContexts] =
      await Promise.all([
        enrichPaperContextsWithMineruCache(paperContextsForMessage),
        enrichPaperContextsWithMineruCache(fullTextPaperContextsForMessage),
      ]);
    paperContextsForMessage = enrichedPaperContexts || paperContextsForMessage;
    fullTextPaperContextsForMessage =
      enrichedFullTextPaperContexts || fullTextPaperContextsForMessage;
  }
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
    selectedTextContexts: selectedTextContextsForMessage.length
      ? selectedTextContextsForMessage
      : undefined,
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
    selectedTextNoteContexts: selectedTextNoteContextsForMessage.some((entry) =>
      Boolean(entry),
    )
      ? selectedTextNoteContextsForMessage
      : undefined,
    selectedTextExpandedIndex: -1,
    paperContexts: paperContextsForMessage.length
      ? paperContextsForMessage
      : undefined,
    pdfPaperContexts: normalizedPdfPaperContexts.length
      ? normalizedPdfPaperContexts
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
    selectedTagContexts: selectedTagContextsForMessage.length
      ? selectedTagContextsForMessage
      : undefined,
    forcedSkillIds: opts.forcedSkillIds?.length
      ? opts.forcedSkillIds.slice()
      : undefined,
    paperContextsExpanded: false,
    screenshotImages: screenshotImagesForMessage.length
      ? screenshotImagesForMessage
      : undefined,
    screenshotExpanded: false,
    screenshotActiveIndex: 0,
    attachments: attachments?.length ? attachments : undefined,
    modelName: effectiveRequestConfig.model,
    modelEntryId: effectiveRequestConfig.modelEntryId,
    modelProviderLabel: effectiveRequestConfig.modelProviderLabel,
  };
  if (modelAttachments !== undefined) {
    userMessage.modelAttachments = modelAttachments;
  }
  if (reuseOptimisticPair) {
    history[history.length - 2] = userMessage;
  } else {
    history.push(userMessage);
  }
  if (shouldPersistTurn) {
    void persistConversationMessage(
      conversationKey,
      {
        role: "user",
        text: userMessage.text,
        timestamp: userMessage.timestamp,
        runMode: userMessage.runMode,
        agentRunId: userMessage.agentRunId,
        selectedText: userMessage.selectedText,
        selectedTextContexts: userMessage.selectedTextContexts,
        selectedTexts: userMessage.selectedTexts,
        selectedTextSources: userMessage.selectedTextSources,
        selectedTextPaperContexts: userMessage.selectedTextPaperContexts,
        selectedTextNoteContexts: userMessage.selectedTextNoteContexts,
        forcedSkillIds: userMessage.forcedSkillIds,
        paperContexts: userMessage.paperContexts,
        pdfPaperContexts: userMessage.pdfPaperContexts,
        fullTextPaperContexts: userMessage.fullTextPaperContexts,
        citationPaperContexts: userMessage.citationPaperContexts,
        selectedCollectionContexts: userMessage.selectedCollectionContexts,
        selectedTagContexts: userMessage.selectedTagContexts,
        screenshotImages: userMessage.screenshotImages,
        attachments: userMessage.attachments,
        modelAttachments: userMessage.modelAttachments,
        modelName: userMessage.modelName,
        modelEntryId: userMessage.modelEntryId,
        modelProviderLabel: userMessage.modelProviderLabel,
      },
      effectiveStorageSystem,
    );
  }

  const assistantMessage: Message = {
    ...optimisticAssistantMessage,
    timestamp: optimisticAssistantMessage.timestamp,
    runMode: isCodexNativeTurn ? "agent" : effectiveRuntimeMode,
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
    if (!shouldPersistTurn) return;
    await persistConversationMessage(
      conversationKey,
      {
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
        quoteCitations: assistantMessage.quoteCitations,
        generatedImages: assistantMessage.generatedImages,
        compactMarker: assistantMessage.compactMarker,
      },
      effectiveStorageSystem,
    );
  };
  let responseStreamCoalescer: BlockStreamCoalescer | null = null;
  const flushResponseStream = (reason: BlockStreamFlushReason) => {
    responseStreamCoalescer?.flushNow(reason);
  };
  const markCancelled = async () => {
    flushResponseStream("cancel");
    finalizeCancelledAssistantMessage(assistantMessage);
    refreshChatSafely();
    await persistAssistantOnce();
    setStatusSafely("Cancelled", "ready");
  };

  // [webchat] Dedicated pipeline — bypass context assembly, send raw PDF + question
  if (effectiveRequestConfig.providerProtocol === "web_sync") {
    const webChatQueueRefresh = createQueuedRefresh(refreshChatSafely);
    const reportWebChatSendOutcome = (
      outcome: "success" | "failed" | "cancelled",
    ) => {
      opts.onWebChatSendOutcome?.(outcome);
    };
    try {
      // Determine webchat target from the model name (e.g., "chatgpt.com" → "chatgpt", "chat.deepseek.com" → "deepseek")
      const { getWebChatTargetByModelName } =
        await import("../../webchat/types");
      const webchatTargetEntry = getWebChatTargetByModelName(
        effectiveRequestConfig.model || "",
      );
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
        pdfPaperContexts: normalizedWebChatPdfPaperContexts,
        forceNewChat: opts.webchatForceNewChat === true,
        images:
          screenshotImagesForMessage.length > 0
            ? screenshotImagesForMessage
            : undefined,
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

      if (
        getCancelledRequestId(conversationKey) >= thisRequestId ||
        Boolean(getAbortController(conversationKey)?.signal.aborted)
      ) {
        await markCancelled();
        reportWebChatSendOutcome("cancelled");
        return;
      }

      assistantMessage.text =
        sanitizeText(answer.text) || assistantMessage.text || "No response.";
      assistantMessage.reasoningDetails =
        sanitizeText(answer.thinking || "") ||
        assistantMessage.reasoningDetails;
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
      if (answer.remoteChatUrl)
        assistantMessage.webchatChatUrl = answer.remoteChatUrl;
      if (answer.remoteChatId)
        assistantMessage.webchatChatId = answer.remoteChatId;
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
      reportWebChatSendOutcome("success");
    } catch (err) {
      const isCancelled =
        getCancelledRequestId(conversationKey) >= thisRequestId ||
        Boolean(getAbortController(conversationKey)?.signal.aborted) ||
        (err as { name?: string }).name === "AbortError";
      if (isCancelled) {
        await markCancelled();
        restoreRequestUIIdle(body, conversationKey, thisRequestId);
        reportWebChatSendOutcome("cancelled");
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
      reportWebChatSendOutcome("failed");
    } finally {
      setAbortController(conversationKey, null);
      clearPendingRequestIdAndSync(conversationKey, body, item);
    }
    return;
  }

  try {
    const rawLLMHistory = buildLLMHistoryMessages(historyForLLM);
    // Apply auto-summary compression when the history grows long.
    const llmHistory =
      applyHistoryCompression(conversationKey, rawLLMHistory) ?? rawLLMHistory;
    const recentPaperContexts = collectRecentPaperContexts(historyForLLM);

    // Create AbortController early so the signal is available during context
    // planning.
    const AbortControllerCtor = getAbortControllerCtor();
    setAbortController(
      conversationKey,
      AbortControllerCtor ? new AbortControllerCtor() : null,
    );

    const contextPlan = shouldUseCodexNativeLightContext({ isCodexNativeTurn })
      ? buildLightCodexNativeMcpContextPlan({
          paperContexts: paperContextsForMessage,
          fullTextPaperContexts: fullTextPaperContextsForMessage,
          selectedCollectionContexts: selectedCollectionContextsForMessage,
          selectedTagContexts: selectedTagContextsForMessage,
          recentPaperContexts,
          setStatusSafely,
        })
      : await buildContextPlanForRequest({
          item,
          contextSource,
          question,
          images,
          selectedTextSources: selectedTextSourcesForMessage,
          resolvedSelectedTextAnchors,
          paperContexts: paperContextsForMessage,
          fullTextPaperContexts: fullTextPaperContextsForMessage,
          selectedCollectionContexts: selectedCollectionContextsForMessage,
          recentPaperContexts,
          history: llmHistory,
          effectiveRequestConfig,
          pdfPaperContexts: normalizedPdfPaperContexts,
          pdfUploadSystemMessages: opts.pdfUploadSystemMessages,
          signal: getAbortController(conversationKey)?.signal,
          setStatusSafely,
        });
    const combinedContext = contextPlan.combinedContext;
    assistantMessage.quoteCitations = mergeQuoteCitations(
      assistantMessage.quoteCitations,
      contextPlan.quoteCitations,
    );
    userMessage.paperContexts = contextPlan.paperContexts.length
      ? contextPlan.paperContexts
      : undefined;
    userMessage.fullTextPaperContexts = contextPlan.fullTextPaperContexts.length
      ? contextPlan.fullTextPaperContexts
      : undefined;
    userMessage.citationPaperContexts = mergeCitationPaperContexts(
      userMessage.selectedTextPaperContexts,
      contextPlan.citationPaperContexts,
    );
    await updateStoredLatestUserMessageByConversation(
      conversationKey,
      {
        text: userMessage.text,
        timestamp: userMessage.timestamp,
        runMode: userMessage.runMode,
        agentRunId: userMessage.agentRunId,
        selectedText: userMessage.selectedText,
        selectedTextContexts: userMessage.selectedTextContexts,
        selectedTexts: userMessage.selectedTexts,
        selectedTextSources: userMessage.selectedTextSources,
        selectedTextPaperContexts: userMessage.selectedTextPaperContexts,
        screenshotImages: userMessage.screenshotImages,
        paperContexts: userMessage.paperContexts,
        pdfPaperContexts: userMessage.pdfPaperContexts,
        fullTextPaperContexts: userMessage.fullTextPaperContexts,
        citationPaperContexts: userMessage.citationPaperContexts,
        selectedCollectionContexts: userMessage.selectedCollectionContexts,
        selectedTagContexts: userMessage.selectedTagContexts,
        attachments: userMessage.attachments,
        modelAttachments: userMessage.modelAttachments,
        modelName: userMessage.modelName,
        modelEntryId: userMessage.modelEntryId,
        modelProviderLabel: userMessage.modelProviderLabel,
      },
      effectiveStorageSystem,
    );

    if (getCancelledRequestId(conversationKey) >= thisRequestId) {
      getAbortController(conversationKey)?.abort();
      await markCancelled();
      return;
    }

    const queueRefresh = createQueuedRefresh(refreshChatSafely);
    const codexActivityTrace = isCodexNativeTurn
      ? createCodexNativeActivityTraceController(assistantMessage, queueRefresh)
      : null;
    noteExplicitCodexNativeSkillInvocations(
      codexActivityTrace,
      opts.forcedSkillIds,
    );
    responseStreamCoalescer = createBlockStreamCoalescer({
      onBlock: (chunk) => {
        assistantMessage.text += chunk;
        queueRefresh();
      },
    });

    if (getCancelledRequestId(conversationKey) >= thisRequestId) {
      getAbortController(conversationKey)?.abort();
      await markCancelled();
      return;
    }

    // Models resolved as image-disabled reject image_url content, so drop all images.
    const allSendImages = supportsImageInputs(effectiveRequestConfig)
      ? [...(images || []), ...(contextPlan.modelImages || [])]
      : [];
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
      inputMode: effectiveRequestConfig.advanced?.inputMode,
      contextCache: contextPlan.contextCache,
    };
    const { finalPrepared, systemMessages, workflowTestIntercepted } =
      await prepareFinalContextPlanChatRequest({
        requestParams,
        contextPlan,
        combinedContext,
      });
    if (workflowTestIntercepted) {
      assistantMessage.text = "Workflow request intercepted before dispatch.";
      assistantMessage.streaming = false;
      refreshChatSafely();
      setStatusSafely("Workflow request captured", "ready");
      return;
    }
    const estimatedContextSnapshot = setContextUsageSnapshot(conversationKey, {
      contextTokens: finalPrepared.inputCap.estimatedAfterTokens,
      contextWindow: finalPrepared.inputCap.limitTokens,
      estimated: true,
      source: "estimated",
    });
    renderContextUsageSnapshot(body, ui.tokenUsageEl, estimatedContextSnapshot);

    const handleDelta = (delta: string) => {
      const chunk = sanitizeText(delta);
      if (!chunk) return;
      responseStreamCoalescer?.pushText(chunk);
    };
    const handleReasoning = (reasoning: ReasoningEvent) => {
      flushResponseStream("event");
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
    };
    const handleUsage = (usage: UsageStats) => {
      recordContextCacheTelemetry(contextPlan.contextCache, usage);
      const contextTokens =
        typeof usage.contextTokens === "number" && usage.contextTokens > 0
          ? usage.contextTokens
          : 0;
      if (contextTokens <= 0) return;
      const snapshot = setContextUsageSnapshot(conversationKey, {
        contextTokens,
        contextWindow:
          usage.contextWindow || finalPrepared.inputCap.limitTokens,
        estimated: usage.contextWindowIsAuthoritative !== true,
        source:
          usage.contextWindowIsAuthoritative === true
            ? "provider"
            : "estimated",
        contextWindowIsAuthoritative: usage.contextWindowIsAuthoritative,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        cacheMissTokens: usage.cacheMissTokens,
        cacheHitRatio: usage.cacheHitRatio,
        cacheProvider: usage.cacheProvider,
      });
      renderContextUsageSnapshot(body, ui.tokenUsageEl, snapshot);
    };
    const answer = isCodexNativeTurn
      ? (
          await runCodexAppServerNativeTurn({
            scope: await enrichCodexNativeConversationScopeWithMineruCache(
              resolveCodexNativeConversationScope({
                item,
                contextSource,
                conversationKey,
                title: shownQuestion,
              }),
            ),
            model: effectiveRequestConfig.model,
            messages: finalPrepared.messages,
            reasoning: effectiveRequestConfig.reasoning,
            signal: getAbortController(conversationKey)?.signal,
            codexPath: getEffectiveCodexAppServerBinaryPath(
              effectiveRequestConfig.apiBase,
            ),
            skillContext: buildCodexNativeSkillContext({
              forcedSkillIds: opts.forcedSkillIds,
              selectedTextContexts: selectedTextContextsForMessage,
              resolvedSelectedTextAnchors,
              selectedTexts: selectedTextsForMessage,
              selectedTextSources: selectedTextSourcesForMessage,
              selectedTextPaperContexts: selectedTextPaperContextsForMessage,
              selectedTextNoteContexts: selectedTextNoteContextsForMessage,
              paperContexts: contextPlan.paperContexts,
              pdfPaperContexts: normalizedPdfPaperContexts,
              localDocuments,
              fullTextPaperContexts: contextPlan.fullTextPaperContexts,
              pinnedPaperContexts: userMessage.pinnedPaperContexts,
              selectedCollectionContexts: selectedCollectionContextsForMessage,
              selectedTagContexts: selectedTagContextsForMessage,
              screenshots: allSendImages,
              attachments,
            }),
            onSkillActivated: (skillId) => {
              flushResponseStream("event");
              codexActivityTrace?.noteSkillActivated(skillId);
              setStatusSafely(`Codex skill activated: ${skillId}`, "sending");
            },
            onDelta: handleDelta,
            onAgentMessageDelta: (event) => {
              if (!codexActivityTrace?.appendAgentMessageDelta(event)) {
                handleDelta(event.delta);
              }
            },
            onReasoning: handleReasoning,
            onUsage: handleUsage,
            onItemStarted: (event) => {
              flushResponseStream("event");
              codexActivityTrace?.appendItemStatus(event, "started");
              const itemType = sanitizeText(event.type || "");
              if (itemType && !isCodexNativeAgentMessageItem(event)) {
                setStatusSafely(`Codex: ${itemType} started`, "sending");
              }
            },
            onItemCompleted: (event) => {
              flushResponseStream("event");
              codexActivityTrace?.noteAgentMessageCompleted(event);
              codexActivityTrace?.appendItemStatus(event, "completed");
              const itemType = sanitizeText(event.type || "");
              if (itemType && !isCodexNativeAgentMessageItem(event)) {
                setStatusSafely(`Codex: ${itemType} completed`, "sending");
              }
            },
            onMcpToolActivity: (event) => {
              flushResponseStream("event");
              codexActivityTrace?.noteMcpToolActivity(event);
              assistantMessage.quoteCitations = mergeQuoteCitations(
                assistantMessage.quoteCitations,
                event.quoteCitations,
              );
              const label =
                sanitizeText(event.toolLabel || "").trim() ||
                sanitizeText(event.toolName || "")
                  .replace(/_/g, " ")
                  .trim();
              if (label) {
                setStatusSafely(
                  event.phase === "completed"
                    ? `Codex: used ${label}`
                    : `Codex: using ${label}`,
                  "sending",
                );
              }
            },
            onMcpConfirmationRequest: async ({ requestId, action }) => {
              flushResponseStream("event");
              setStatusSafely(
                action.mode === "review"
                  ? "Codex is waiting for your Zotero review"
                  : "Codex is waiting for your Zotero approval",
                "sending",
              );
              codexActivityTrace?.noteMcpConfirmationRequired(
                requestId,
                action,
              );
              const resolution = await showNativeMcpActionCard(
                body,
                requestId,
                action,
              );
              codexActivityTrace?.noteMcpConfirmationResolved(
                requestId,
                resolution,
              );
              return resolution;
            },
            onMcpSetupWarning: (message) => {
              flushResponseStream("event");
              setStatusSafely(message, "error");
            },
            onDiagnostics: (diagnostics) => {
              flushResponseStream("event");
              setStatusSafely(
                formatCodexNativeDiagnosticsStatus(diagnostics),
                "sending",
              );
            },
            onApprovalRequest: async (request) => {
              flushResponseStream("event");
              return resolveCodexNativeApprovalWithOptionalReviewCard({
                body,
                request,
                trace: codexActivityTrace,
                setStatusSafely,
              });
            },
          })
        ).text
      : await callLLMStream(
          {
            ...requestParams,
            systemMessages,
          },
          handleDelta,
          handleReasoning,
          handleUsage,
        );

    if (
      getCancelledRequestId(conversationKey) >= thisRequestId ||
      Boolean(getAbortController(conversationKey)?.signal.aborted)
    ) {
      await markCancelled();
      return;
    }

    flushResponseStream("final");
    const hasGeneratedOutput = normalizeGeneratedChatImages(
      assistantMessage.generatedImages,
    ).length;
    assistantMessage.text =
      sanitizeText(answer) ||
      assistantMessage.text ||
      (hasGeneratedOutput ? "" : "No response.");
    await finalizeAssistantMessageQuoteCitations(assistantMessage, {
      pairedUserMessage: userMessage,
      paperContexts: contextPlan.paperContexts,
      fullTextPaperContexts: contextPlan.fullTextPaperContexts,
      citationPaperContexts: contextPlan.citationPaperContexts,
      conversationKey,
    });
    codexActivityTrace?.finish(assistantMessage.text);
    assistantMessage.runMode = isCodexNativeTurn
      ? "agent"
      : effectiveRuntimeMode;
    assistantMessage.agentRunId = agentRunId || assistantMessage.agentRunId;
    assistantMessage.compactMarker = isCompactCommandText(question);
    if (assistantMessage.compactMarker && !assistantMessage.text.trim()) {
      assistantMessage.text = "Conversation compacted";
    }
    assistantMessage.streaming = false;
    refreshChatSafely();
    await persistAssistantOnce();
    if (resolveConversationSystemForItem(item) === "claude_code") {
      const activeNoteSession = resolveActiveNoteSession(item);
      const conversationKind =
        activeNoteSession?.conversationKind ||
        resolveDisplayConversationKind(item);
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

    // Codex app-server owns model-visible history in native mode, so avoid a
    // background summarizer that would spin up a second app-server request.
    if (!isCodexNativeTurn) {
      scheduleLLMSummary(conversationKey, rawLLMHistory, {
        model: effectiveRequestConfig.model,
        apiBase: effectiveRequestConfig.apiBase,
        apiKey: effectiveRequestConfig.apiKey,
        authMode: effectiveRequestConfig.authMode,
      });
    }

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
    responseStreamCoalescer?.cancel();
    assistantMessage.text = `Error: ${errMsg}${retryHint}`;
    assistantMessage.streaming = false;
    refreshChatSafely();
    await persistAssistantOnce();

    setStatusSafely(`Error: ${`${errMsg}${retryHint}`.slice(0, 40)}`, "error");
  } finally {
    restoreRequestUIIdle(body, conversationKey, thisRequestId);
    setAbortController(conversationKey, null);
    clearPendingRequestIdAndSync(conversationKey, body, item);
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
        resizeTextareaToContent(inputBoxEl);
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
  const cancelBtn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
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

  // Measure after the widget has been attached so scrollHeight reflects the
  // inline editor's actual width and rendered wrapping.
  const win = body.ownerDocument?.defaultView;
  if (win && inputBoxEl) {
    const shouldFocus = isFirstEntry && !inputBoxEl.dataset.inlineEditFocused;
    if (shouldFocus) inputBoxEl.dataset.inlineEditFocused = "1";
    win.setTimeout(() => {
      resizeTextareaToContent(inputBoxEl);
      if (shouldFocus) {
        inputBoxEl.focus({ preventScroll: true });
        inputBoxEl.setSelectionRange(
          inputBoxEl.value.length,
          inputBoxEl.value.length,
        );
      }
    }, 0);
  }

  return widgetRoot;
}

export function renderCompactMarkerInto(
  bubble: HTMLElement,
  text: string,
  doc: Document,
  pending: boolean,
): void {
  bubble.textContent = "";
  bubble.classList.add("llm-compact-marker");
  bubble.classList.toggle("llm-compact-marker-pending", pending);

  const leftRule = doc.createElement("span") as HTMLSpanElement;
  leftRule.className = "llm-compact-marker-rule";
  const icon = doc.createElement("span") as HTMLSpanElement;
  icon.className = "llm-compact-marker-icon";
  icon.setAttribute("aria-hidden", "true");
  const label = doc.createElement("span") as HTMLSpanElement;
  label.className = "llm-compact-marker-label";
  label.textContent =
    text || (pending ? "Compacting context..." : "Context compacted");
  const rightRule = doc.createElement("span") as HTMLSpanElement;
  rightRule.className = "llm-compact-marker-rule";

  bubble.append(leftRule, icon, label, rightRule);
}

export function renderForkSourceMarkerInto(
  bubble: HTMLElement,
  body: Element,
  doc: Document,
  link: ConversationForkLink,
): void {
  bubble.textContent = "";
  bubble.classList.add("llm-fork-source-marker");

  const leftRule = doc.createElement("span") as HTMLSpanElement;
  leftRule.className = "llm-fork-source-marker-rule";
  const button = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  button.type = "button";
  button.className = "llm-fork-source-marker-button";
  button.title = t("Open original conversation");
  const icon = doc.createElement("span") as HTMLSpanElement;
  icon.className = "llm-fork-source-marker-icon";
  icon.setAttribute("aria-hidden", "true");
  const label = doc.createElement("span") as HTMLSpanElement;
  label.className = "llm-fork-source-marker-label";
  label.textContent = t("Forked from conversation");
  const rightRule = doc.createElement("span") as HTMLSpanElement;
  rightRule.className = "llm-fork-source-marker-rule";

  button.append(icon, label);
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const runner = getForkSourceNavigationRunner(body);
    if (!runner) return;
    button.disabled = true;
    try {
      await runner(link);
    } finally {
      button.disabled = false;
    }
  });

  bubble.append(leftRule, button, rightRule);
}

export type RefreshChatOptions = {
  rerenderAssistantMessages?: ReadonlySet<Message>;
};

export function refreshChat(
  body: Element,
  item?: Zotero.Item | null,
  options: RefreshChatOptions = {},
) {
  const chatBox = body.querySelector("#llm-chat-box") as HTMLDivElement | null;
  if (!chatBox) return;
  const doc = body.ownerDocument!;
  setPromptMenuTarget(null);
  const paperContextDisplayCache: PaperContextDisplayCache = new Map();
  const resolvePaperContextForCardDisplay = (
    paperContext: PaperContextRef,
  ): PaperContextRef =>
    resolvePaperContextDisplayRef(paperContext, paperContextDisplayCache);

  if (!item) {
    chatBox.innerHTML = `
      <div class="llm-welcome">
        <div class="llm-welcome-icon llm-context-svg-icon llm-context-icon-paper" aria-hidden="true"></div>
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
  const pendingRestoreSnapshot = consumePendingChatScrollRestore(
    conversationKey,
    body,
  );
  const cachedSnapshot = getChatScrollSnapshot(conversationKey);
  const baselineSnapshot = hasActiveFollowBottomCatchupRequest(conversationKey)
    ? buildFollowBottomScrollSnapshot(chatBox)
    : pendingRestoreSnapshot
      ? pendingRestoreSnapshot
      : cachedSnapshot
        ? cachedSnapshot
        : buildChatScrollSnapshot(chatBox);
  const history = chatHistory.get(conversationKey) || [];
  const requestedRerenders = options.rerenderAssistantMessages;
  const targetedMessageWrappers = new Map<Message, HTMLElement>();
  let useTargetedRerender = Boolean(requestedRerenders?.size);
  if (useTargetedRerender) {
    const renderedWrappers = Array.from(chatBox.children) as HTMLElement[];
    for (const message of requestedRerenders || []) {
      const messageIndex = history.indexOf(message);
      if (message.role !== "assistant" || messageIndex < 0) {
        useTargetedRerender = false;
        break;
      }
      const wrapper = renderedWrappers.find(
        (candidate) =>
          candidate.dataset.messageRole === "assistant" &&
          candidate.dataset.messageIndex === `${messageIndex}`,
      );
      if (!wrapper) {
        useTargetedRerender = false;
        break;
      }
      targetedMessageWrappers.set(message, wrapper);
    }
  }
  const forkLink = conversationForkLinks.get(conversationKey) || null;
  if (tokenUsageEl) {
    const snapshot = contextUsageSnapshots.get(conversationKey);
    const liveSnapshot =
      snapshot && snapshot.source !== "persisted" ? snapshot : undefined;
    const recomputedSnapshot = liveSnapshot
      ? undefined
      : estimateHistoryContextUsageSnapshot(item, history);
    renderContextUsageSnapshot(
      body,
      tokenUsageEl,
      liveSnapshot || recomputedSnapshot || snapshot,
    );
  }

  if (history.length === 0) {
    // [webchat] Show webchat-specific welcome instead of generic instructions
    const effectiveRequestConfig = resolveEffectiveRequestConfig({ item });
    if (effectiveRequestConfig.providerProtocol === "web_sync") {
      const targetEntry = getWebChatTargetByModelName(
        effectiveRequestConfig.model || "",
      );
      chatBox.innerHTML = getWebChatWelcomeHtml(
        targetEntry?.label,
        targetEntry?.modelName,
      );
      if (panelRoot) panelRoot.dataset.startPageActive = "true";
    } else {
      const isStandalone =
        panelRoot?.dataset?.standalone === "true" ||
        (body as HTMLElement).dataset?.standalone === "true";
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
  if (!useTargetedRerender) {
    chatBox.innerHTML = "";
  }

  const latestRetryPair = findLatestRetryPair(history);
  const latestAssistantIndex = latestRetryPair
    ? latestRetryPair.userIndex + 1
    : -1;
  // [webchat] Resolve provider protocol once for editability checks
  const renderProviderProtocol = resolveEffectiveRequestConfig({
    item,
  }).providerProtocol;
  const conversationIsIdle = !history.some((m) => m.streaming);
  for (const [index, msg] of history.entries()) {
    if (useTargetedRerender && !targetedMessageWrappers.has(msg)) {
      continue;
    }
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
    wrapper.dataset.messageRole = msg.role;
    wrapper.dataset.messageIndex = `${index}`;
    wrapper.dataset.messageTimestamp = `${Math.floor(
      Number(msg.timestamp) || 0,
    )}`;
    if (!isUser && msg.compactMarker) {
      wrapper.classList.add("llm-compact-marker-wrapper");
    }

    const bubble = doc.createElement("div") as HTMLDivElement;
    bubble.className = `llm-bubble ${isUser ? "user" : "assistant"}`;
    let inlineEditEl: HTMLElement | null = null;

    if (isUser) {
      const contextBadgesRow = doc.createElement("div") as HTMLDivElement;
      contextBadgesRow.className = "llm-user-context-badges";
      let hasContextBadge = false;

      const screenshotImages = Array.isArray(msg.screenshotImages)
        ? msg.screenshotImages.filter(
            (entry) =>
              Boolean(entry) && !entry.startsWith("data:application/pdf"),
          )
        : [];
      let screenshotExpanded: HTMLDivElement | null = null;
      let papersExpanded: HTMLDivElement | null = null;
      let collectionsExpanded: HTMLDivElement | null = null;
      let tagsExpanded: HTMLDivElement | null = null;
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
      const selectedTagContexts = normalizeTagContexts(msg.selectedTagContexts);
      hasUserContext =
        hasScreenshotContext ||
        hasSelectedTextContext ||
        selectedCollectionContexts.length > 0 ||
        selectedTagContexts.length > 0;
      if (hasScreenshotContext) {
        const screenshotBar = doc.createElementNS(
          HTML_NS,
          "button",
        ) as HTMLButtonElement;
        screenshotBar.type = "button";
        screenshotBar.className = "llm-user-screenshots-bar";

        const screenshotIcon = createContextIcon(
          doc,
          "image",
          "llm-user-screenshots-icon",
        );

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
          const thumbBtn = doc.createElementNS(
            HTML_NS,
            "button",
          ) as HTMLButtonElement;
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
        const collectionsBar = doc.createElementNS(
          HTML_NS,
          "button",
        ) as HTMLButtonElement;
        collectionsBar.type = "button";
        collectionsBar.className =
          "llm-user-papers-bar llm-user-collections-bar";

        const collectionsIcon = createContextIcon(
          doc,
          "collection",
          "llm-user-papers-icon",
        );

        const collectionsLabel = doc.createElement("span") as HTMLSpanElement;
        collectionsLabel.className = "llm-user-papers-label";
        collectionsLabel.textContent =
          selectedCollectionContexts.length === 1
            ? "Collection"
            : "Collections";
        collectionsLabel.title = selectedCollectionContexts
          .map((entry) => entry.name)
          .join("\n");
        collectionsBar.append(collectionsIcon, collectionsLabel);

        const collectionsExpandedEl = doc.createElement(
          "div",
        ) as HTMLDivElement;
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
          collectionsBar.setAttribute(
            "aria-expanded",
            expanded ? "true" : "false",
          );
          collectionsExpandedEl.hidden = !expanded;
          collectionsExpandedEl.style.display = expanded ? "block" : "none";
          collectionsBar.title = expanded
            ? "Collapse collections"
            : "Expand collections";
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

      if (selectedTagContexts.length) {
        const tagsBar = doc.createElementNS(
          HTML_NS,
          "button",
        ) as HTMLButtonElement;
        tagsBar.type = "button";
        tagsBar.className = "llm-user-papers-bar llm-user-tags-bar";

        const tagsIcon = createContextIcon(doc, "tag", "llm-user-papers-icon");
        const tagsLabel = doc.createElement("span") as HTMLSpanElement;
        tagsLabel.className = "llm-user-papers-label";
        tagsLabel.textContent =
          selectedTagContexts.length === 1 ? "Tag" : "Tags";
        tagsLabel.title = selectedTagContexts
          .map((entry) => entry.name)
          .join("\n");
        tagsBar.append(tagsIcon, tagsLabel);

        const tagsExpandedEl = doc.createElement("div") as HTMLDivElement;
        tagsExpandedEl.className =
          "llm-user-papers-expanded llm-user-tags-expanded";
        tagsExpanded = tagsExpandedEl;
        const tagsList = doc.createElement("div") as HTMLDivElement;
        tagsList.className = "llm-user-papers-list llm-user-tags-list";
        for (const tagContext of selectedTagContexts) {
          const tagItem = doc.createElement("div") as HTMLDivElement;
          tagItem.className = "llm-user-papers-item llm-user-tags-item";

          const tagTitle = doc.createElement("span") as HTMLSpanElement;
          tagTitle.className = "llm-user-papers-item-title";
          tagTitle.textContent = tagContext.name;
          tagTitle.title = tagContext.name;

          const tagMeta = doc.createElement("span") as HTMLSpanElement;
          tagMeta.className = "llm-user-papers-item-meta";
          tagMeta.textContent = tagContext.scope
            ? `tagScope=${tagContext.scope}`
            : "tag";
          tagMeta.title = tagMeta.textContent;

          tagItem.append(tagTitle, tagMeta);
          tagsList.appendChild(tagItem);
        }
        tagsExpandedEl.appendChild(tagsList);

        const applyTagsState = () => {
          const expanded = Boolean(msg.tagContextsExpanded);
          tagsBar.classList.toggle("expanded", expanded);
          tagsBar.setAttribute("aria-expanded", expanded ? "true" : "false");
          tagsExpandedEl.hidden = !expanded;
          tagsExpandedEl.style.display = expanded ? "block" : "none";
          tagsBar.title = expanded ? "Collapse tags" : "Expand tags";
        };
        const toggleTagsExpanded = () => {
          msg.tagContextsExpanded = !msg.tagContextsExpanded;
          applyTagsState();
        };
        applyTagsState();
        tagsBar.addEventListener("mousedown", (e: Event) => {
          const mouse = e as MouseEvent;
          if (mouse.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          toggleTagsExpanded();
        });
        tagsBar.addEventListener("click", (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
        });
        tagsBar.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          toggleTagsExpanded();
        });

        contextBadgesRow.appendChild(tagsBar);
        hasContextBadge = true;
      }

      const paperContexts = normalizePaperContexts([
        ...(msg.paperContexts || []),
        ...(msg.pdfPaperContexts || []),
      ]);
      hasUserContext = hasUserContext || paperContexts.length > 0;
      if (paperContexts.length) {
        const displayPaperContexts = paperContexts.map(
          resolvePaperContextForCardDisplay,
        );
        const papersBar = doc.createElementNS(
          HTML_NS,
          "button",
        ) as HTMLButtonElement;
        papersBar.type = "button";
        papersBar.className = "llm-user-papers-bar";

        const papersIcon = createContextIcon(
          doc,
          "paper",
          "llm-user-papers-icon",
        );

        const papersLabel = doc.createElement("span") as HTMLSpanElement;
        papersLabel.className = "llm-user-papers-label";
        papersLabel.textContent = formatPaperCountLabel(paperContexts.length);
        papersLabel.title = displayPaperContexts
          .map((entry) => entry.title)
          .join("\n");
        papersBar.append(papersIcon, papersLabel);

        const papersExpandedEl = doc.createElement("div") as HTMLDivElement;
        papersExpandedEl.className = "llm-user-papers-expanded";
        papersExpanded = papersExpandedEl;
        const papersList = doc.createElement("div") as HTMLDivElement;
        papersList.className = "llm-user-papers-list";
        for (const paperContext of displayPaperContexts) {
          const paperItem = doc.createElement("div") as HTMLDivElement;
          paperItem.className = "llm-user-papers-item";
          paperItem.classList.toggle(
            "llm-user-papers-item-pdf",
            paperContext.contentSourceMode === "pdf",
          );

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

          const attachmentTitle =
            paperContext.attachmentTitle ||
            (paperContext.contentSourceMode === "pdf" ? "PDF file" : "");
          const paperAttachment = doc.createElement("span") as HTMLSpanElement;
          paperAttachment.className = "llm-user-papers-item-attachment";
          paperAttachment.textContent = attachmentTitle;
          paperAttachment.title = attachmentTitle;

          paperItem.append(paperTitle, paperMeta);
          if (attachmentTitle) {
            paperItem.appendChild(paperAttachment);
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
              !(
                typeof entry.id === "string" &&
                entry.id.startsWith("pdf-paper-")
              ),
          )
        : [];
      hasUserContext = hasUserContext || fileAttachments.length > 0;
      if (fileAttachments.length) {
        const filesBar = doc.createElementNS(
          HTML_NS,
          "button",
        ) as HTMLButtonElement;
        filesBar.type = "button";
        filesBar.className = "llm-user-files-bar";

        const filesIcon = createContextIcon(doc, "file", "llm-user-files-icon");

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
          const fileItem = (
            canOpen
              ? doc.createElementNS(HTML_NS, "button")
              : doc.createElement("div")
          ) as HTMLButtonElement | HTMLDivElement;
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
            fileItem.addEventListener("keydown", (event: Event) => {
              const keyEvent = event as KeyboardEvent;
              if (keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
              keyEvent.preventDefault();
              keyEvent.stopPropagation();
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
      if (tagsExpanded) {
        wrapper.appendChild(tagsExpanded);
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
          const selectedBar = doc.createElementNS(
            HTML_NS,
            "button",
          ) as HTMLButtonElement;
          selectedBar.type = "button";
          selectedBar.className = "llm-user-selected-text";
          selectedBar.dataset.contextSource = selectedSource;

          const selectedIcon = createSelectedTextSourceIcon(
            doc,
            selectedSource,
            "llm-user-selected-text-icon",
          );

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
          const promptMenuForkBtn = promptMenu?.querySelector(
            "#llm-prompt-menu-fork",
          ) as HTMLButtonElement | null;
          if (!promptMenu) return;
          const canForkPromptTurn =
            canDeletePromptTurn &&
            canShowForkActionForAssistantTurn(
              body,
              item,
              conversationKey,
              assistantPairMsg?.timestamp,
              assistantPairMsg,
            );
          if (promptMenuDeleteBtn) {
            promptMenuDeleteBtn.disabled = !canDeletePromptTurn;
          }
          if (promptMenuForkBtn) {
            promptMenuForkBtn.disabled = !canForkPromptTurn;
            promptMenuForkBtn.style.display = canForkPromptTurn ? "" : "none";
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
      const generatedImages = normalizeGeneratedChatImages(msg.generatedImages);
      const hasGeneratedImages = generatedImages.length > 0;
      const hasAnswerText = Boolean(msg.text) || Boolean(msg.compactMarker);
      const previousUserMessage =
        index > 0 && history[index - 1]?.role === "user"
          ? history[index - 1]
          : null;
      const isClaudeStreamingConversation =
        resolveConversationSystemForItem(item) === "claude_code";
      const agentRunId = msg.agentRunId?.trim();
      const hasCachedTrace = agentRunId
        ? agentRunTraceCache.has(agentRunId)
        : false;
      const cachedTraceEvents = agentRunId
        ? getCachedAgentRunEvents(agentRunId)
        : [];
      const traceEvents = cachedTraceEvents.length
        ? cachedTraceEvents
        : msg.pendingAgentTraceEvents || [];
      let agentUsesInterleavedText = false;
      const agentTraceEl =
        msg.runMode === "agent" && !msg.compactMarker
          ? renderAgentTrace({
              doc,
              message: msg,
              userMessage: previousUserMessage,
              events: traceEvents,
              onTraceMissing:
                agentRunId && !hasCachedTrace
                  ? () => {
                      void ensureAgentRunTraceLoaded(agentRunId, body, item);
                    }
                  : undefined,
              onInterleavedText: () => {
                agentUsesInterleavedText = true;
              },
            })
          : null;
      if (hasAnswerText && !agentUsesInterleavedText) {
        const safeText = buildAssistantDisplayMarkdownForRender(msg);
        if (msg.streaming) bubble.classList.add("streaming");
        if (msg.compactMarker) {
          renderCompactMarkerInto(
            bubble,
            safeText ||
              (msg.streaming ? "Compacting context..." : "Context compacted"),
            doc,
            Boolean(msg.streaming),
          );
        } else
          try {
            renderRenderedMarkdownInto(bubble, safeText, doc, {
              onAsyncContentRendered: () => {
                stabilizeFollowBottomAfterAsyncChatContent(
                  body,
                  conversationKey,
                  chatBox,
                );
              },
            });
          } catch (err) {
            ztoolkit.log("LLM render error:", err);
            bubble.textContent = safeText;
          }
      }

      const bubbleHeaderNodes: HTMLElement[] = [];

      if (hasModelName && !msg.compactMarker) {
        const modelHeader = doc.createElement("div") as HTMLDivElement;
        modelHeader.className = "llm-model-header";

        const modelName = doc.createElement("div") as HTMLDivElement;
        modelName.className = "llm-model-name";
        modelName.textContent = formatDisplayModelName(
          msg.modelName,
          msg.modelProviderLabel,
          {
            suppressProviderPrefix:
              resolveConversationSystemForItem(item) === "claude_code",
          },
        );
        modelHeader.appendChild(modelName);

        if (!hasAnswerText && msg.streaming && isClaudeStreamingConversation) {
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
        (hasReasoningSummary || hasReasoningDetails) && msg.runMode !== "agent";
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
          const reasoningSummaryText = buildAssistantDisplayMarkdownForRender({
            text: msg.reasoningSummary || "",
            quoteCitations: msg.quoteCitations,
          });
          try {
            renderRenderedMarkdownInto(text, reasoningSummaryText, doc);
          } catch (err) {
            ztoolkit.log("LLM reasoning render error:", err);
            text.textContent = reasoningSummaryText;
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
          const reasoningDetailsText = buildAssistantDisplayMarkdownForRender({
            text: msg.reasoningDetails || "",
            quoteCitations: msg.quoteCitations,
          });
          try {
            renderRenderedMarkdownInto(text, reasoningDetailsText, doc);
          } catch (err) {
            ztoolkit.log("LLM reasoning render error:", err);
            text.textContent = reasoningDetailsText;
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

      if (hasGeneratedImages) {
        renderAssistantGeneratedImagesInto(bubble, generatedImages, doc, {
          onImageLoaded: () => {
            stabilizeFollowBottomAfterAsyncChatContent(
              body,
              conversationKey,
              chatBox,
            );
          },
          onImageActionStatus: (message, level) => {
            const status = body.querySelector(
              "#llm-status",
            ) as HTMLElement | null;
            if (status) setStatus(status, message, level);
          },
        });
      }

      decorateCompletedAssistantCitationLinks({
        body,
        panelItem: item,
        bubble,
        assistantMessage: msg,
        pairedUserMessage: previousUserMessage,
      });

      if (
        !hasAnswerText &&
        !hasGeneratedImages &&
        !(msg.streaming && isClaudeStreamingConversation)
      ) {
        const typing = doc.createElement("div") as HTMLDivElement;
        typing.className = "llm-typing";
        typing.innerHTML =
          '<span class="llm-typing-dot"></span><span class="llm-typing-dot"></span><span class="llm-typing-dot"></span>';
        bubble.appendChild(typing);
      }

      if (!msg.compactMarker) {
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
    }

    const meta = doc.createElement("div") as HTMLDivElement;
    meta.className = "llm-message-meta";

    const time = doc.createElement("span") as HTMLSpanElement;
    time.className = "llm-message-time";
    time.textContent = formatTime(msg.timestamp);
    meta.appendChild(time);
    if (isUser && shouldShowUserFooterCopyAction(msg)) {
      const actions = doc.createElement("div") as HTMLDivElement;
      actions.className = "llm-message-actions";
      appendUserMessageCopyAction({
        body,
        doc,
        actions,
        message: msg,
      });
      if (actions.childElementCount > 0) {
        meta.appendChild(actions);
      }
    }
    if (!isUser && shouldShowAssistantFooterActions(msg)) {
      const pairedUserForActions =
        index > 0 && history[index - 1]?.role === "user"
          ? history[index - 1]
          : null;
      const actionContent = resolveAssistantResponseMenuContent(msg);
      const actionConversationKey = conversationKey;
      const actionUserTimestamp =
        pairedUserForActions?.role === "user"
          ? Math.floor(pairedUserForActions.timestamp)
          : 0;
      const actionAssistantTimestamp = Math.floor(msg.timestamp);
      const actionResponseTarget = buildAssistantResponseActionTarget({
        item,
        message: msg,
        pairedUserMessage: pairedUserForActions,
        conversationKey: actionConversationKey,
      });
      const actionDeleteTarget = buildAssistantResponseDeleteTarget({
        item,
        message: msg,
        pairedUserMessage: pairedUserForActions,
        conversationKey: actionConversationKey,
        contentTarget: actionResponseTarget,
      });
      const actions = doc.createElement("div") as HTMLDivElement;
      actions.className = "llm-message-actions";

      if (
        index === latestAssistantIndex &&
        msg.text.trim() &&
        msg.runMode !== "agent" &&
        renderProviderProtocol !== "web_sync" // [webchat] no retry in webchat mode
      ) {
        appendMessageMetaActionButton({
          body,
          doc,
          actions,
          className: "llm-message-action-retry llm-retry-latest",
          title: "Retry response with another model",
        });
      }

      if (actionContent && actionUserTimestamp > 0) {
        appendMessageMetaActionButton({
          body,
          doc,
          actions,
          className: "llm-message-action-copy",
          title: "Copy response",
          responseAction: "copy",
          responseTarget: actionResponseTarget,
          conversationKey: actionConversationKey,
          userTimestamp: actionUserTimestamp,
          assistantTimestamp: actionAssistantTimestamp,
        });
        appendMessageMetaActionButton({
          body,
          doc,
          actions,
          className: "llm-message-action-note",
          title: "Save as note",
          responseAction: "note",
          responseTarget: actionResponseTarget,
          conversationKey: actionConversationKey,
          userTimestamp: actionUserTimestamp,
          assistantTimestamp: actionAssistantTimestamp,
        });
      }

      const canShowForkAction =
        actionUserTimestamp > 0 &&
        canShowForkActionForAssistantTurn(
          body,
          item,
          conversationKey,
          actionAssistantTimestamp,
          msg,
        );
      if (canShowForkAction) {
        appendMessageMetaActionButton({
          body,
          doc,
          actions,
          className: "llm-message-action-fork",
          title: "Fork this turn",
          responseAction: "fork",
          responseTarget: actionDeleteTarget,
          conversationKey: actionConversationKey,
          userTimestamp: actionUserTimestamp,
          assistantTimestamp: actionAssistantTimestamp,
        });
      }
      if (actionUserTimestamp > 0) {
        appendMessageMetaActionButton({
          body,
          doc,
          actions,
          className: "llm-message-action-delete",
          title: "Delete this turn",
          responseAction: "delete",
          responseTarget: actionDeleteTarget,
          conversationKey: actionConversationKey,
          userTimestamp: actionUserTimestamp,
          assistantTimestamp: actionAssistantTimestamp,
        });
      }

      if (actions.childElementCount > 0) {
        meta.appendChild(actions);
      }
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
        const refreshBtn = doc.createElementNS(
          HTML_NS,
          "button",
        ) as HTMLButtonElement;
        refreshBtn.className = "llm-message-webchat-refresh";
        refreshBtn.textContent = "\u21BB";
        refreshBtn.title = "Re-fetch this conversation from webchat";
        refreshBtn.addEventListener("click", async () => {
          refreshBtn.disabled = true;
          try {
            const { refreshCurrentConversation } =
              await import("../../webchat/client");
            const { getRelayBaseUrl } =
              await import("../../webchat/relayServer");
            const scraped = await refreshCurrentConversation(
              getRelayBaseUrl(),
              msg.webchatChatUrl || null,
              msg.webchatChatId || null,
            );
            if (scraped.length > 0) {
              const refreshed: Message[] = scraped.map((m) => ({
                role: (m.kind === "user" ? "user" : "assistant") as
                  | "user"
                  | "assistant",
                text: m.text || "",
                timestamp: Date.now(),
                modelName:
                  m.kind === "bot" ? msg.modelName || "chatgpt.com" : undefined,
                modelProviderLabel: m.kind === "bot" ? "WebChat" : undefined,
                reasoningDetails: m.thinking || undefined,
              }));
              chatHistory.set(conversationKey, refreshed);
              refreshChat(body, item);
            } else {
              refreshBtn.title =
                "No messages found — chat site may be on a different page";
              setTimeout(() => {
                refreshBtn.title = "Re-fetch this conversation from webchat";
                refreshBtn.disabled = false;
              }, 2000);
            }
          } catch {
            refreshBtn.title = "Refresh failed";
            setTimeout(() => {
              refreshBtn.title = "Re-fetch this conversation from webchat";
              refreshBtn.disabled = false;
            }, 2000);
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
    const existingTargetedWrapper = targetedMessageWrappers.get(msg);
    if (useTargetedRerender && existingTargetedWrapper) {
      existingTargetedWrapper.replaceWith(wrapper);
    } else {
      chatBox.appendChild(wrapper);
    }
    if (
      !useTargetedRerender &&
      forkLink &&
      !isUser &&
      Number(msg.timestamp) === forkLink.targetAnchorAssistantTimestamp
    ) {
      const markerWrapper = doc.createElement("div") as HTMLDivElement;
      markerWrapper.className =
        "llm-message-wrapper llm-fork-source-marker-wrapper";
      const markerBubble = doc.createElement("div") as HTMLDivElement;
      markerBubble.className = "llm-bubble";
      renderForkSourceMarkerInto(markerBubble, body, doc, forkLink);
      markerWrapper.appendChild(markerBubble);
      chatBox.appendChild(markerWrapper);
    }
    if (isUser && hasUserContext) {
      wrapper.classList.add("llm-user-context-aligned");
    }
  }

  syncUserContextAlignmentWidths(body);

  applyChatScrollSnapshot(chatBox, baselineSnapshot);
  persistChatScrollSnapshotForConversationKey(conversationKey, chatBox);
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
    const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
    const displayedKey = Number(panelRoot?.dataset.itemId || 0);
    if (
      Number.isFinite(displayedKey) &&
      displayedKey > 0 &&
      displayedKey !== conversationKey
    ) {
      return;
    }
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
