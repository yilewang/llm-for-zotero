import { appLogger } from "../../core/logging";
import {
  readNativeQuestions,
  buildNativeQuestionAction,
  nativeQuestionAnswers,
} from "../../codexAppServer/nativeQuestions";
import { createCoalescedFrameScheduler } from "./setupHandlers/controllers/uiSchedulingController";
import {
  disposePlanProgress,
  renderPlanProgress,
} from "./agentTrace/planProgressView";
import { createProviderRequestScope } from "../../utils/providerTransport";
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
import { pendingDeletionStore } from "../../core/conversations/pendingDeletionStore";
import { isConversationKeyRetiredInMemory } from "../../shared/conversationKeyLedger";
import { filterMessagesInPendingTurns } from "./turnMessageUtils";
import {
  clearAgentConversationState,
  clearPersistedAgentConversationRowsInTransaction,
} from "./agentConversationCleanup";
import {
  appendCodexMessage,
  clearCodexConversationSessionMetadata,
  pruneCodexConversation,
  updateLatestCodexAssistantMessage,
  updateLatestCodexUserMessage,
} from "../../codexAppServer/store";
import { archiveCodexAppServerThread } from "../../codexAppServer/nativeClient";
import {
  enqueueConversationCleanupJob,
  performConversationCleanupJobAttempt,
} from "../../core/conversations/conversationCleanupJobs";
import {
  getClaudeAutoCompactThresholdPercent,
  isClaudeAutoCompactEnabled,
} from "../../claudeCode/prefs";
import {
  appendClaudeConversationMessageWithinWriteLock,
  buildClaudeScope,
  captureClaudeSessionInfo,
  getClaudeBridgeRuntime,
  invalidateClaudeConversationSessionWithinWriteLock,
  isClaudeConversationSystemActive,
  updateLatestClaudeConversationAssistantMessageWithinWriteLock,
  updateLatestClaudeConversationUserMessageWithinWriteLock,
} from "../../claudeCode/runtime";
import { getCodexProfileSignature } from "../../codexAppServer/constants";
import { clearCodexNativeReadLedgerForConversation } from "../../codexAppServer/nativeContextLedger";
import { resolveConversationStorageSystem } from "../../shared/conversationStorageRouting";
import { normalizeForcedSkillIds } from "../../shared/skillIds";
import {
  getCodexReasoningModePref,
  getCodexRuntimeModelPref,
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
import { formatCodexZoteroMcpError } from "../../codexAppServer/mcpErrors";
import { preflightClaudeBridgeLocalPdfCapability } from "../../agent/externalBackendBridge";
import { validateLocalPdfDocumentBatch } from "../../agent/context/localDocumentBatch";
import {
  type ChatParams,
  ChatFileAttachment,
  ChatMessage,
  prepareChatRequest,
  preflightRequestModelCapabilities,
  type PreparedChatRequest,
  ReasoningConfig as LLMReasoningConfig,
  ReasoningEvent,
  ReasoningLevel as LLMReasoningLevel,
  UsageStats,
  resolveSemanticSearchState,
  type ModelTurnOutcome,
} from "../../utils/llmClient";
import {
  appendContinuationText,
  callDirectChatTurnWithRecovery,
  EMPTY_OUTPUT_LIMIT_MESSAGE,
  resolveEmptyModelOutcomeMessage,
} from "./directChatCompletion";
import {
  getModelCapabilities,
  type ModelProfileOverride,
  getModelReasoningChoices,
  resolveModelReasoningSelection,
  inferProviderFromModelName,
} from "../../modelCapabilities";
import {
  applyModelInputTokenCap,
  type ModelInputTokenLimitSource,
} from "../../utils/modelInputCap";
import { subscribeModelProviderGroups } from "../../utils/modelProviders";
import { formatDisplayModelName } from "../../utils/modelDisplayLabel";
import type { ProviderProtocol } from "../../utils/providerProtocol";
import { inferLegacyProviderProtocol } from "../../utils/providerProtocol";
import { isLocalModelApiBase } from "../../utils/providerPresets";
import {
  PERSISTED_HISTORY_LIMIT,
  MAX_FULL_TEXT_PAPER_CONTEXTS,
  MAX_SELECTED_IMAGES,
  formatFigureCountLabel,
  formatPaperCountLabel,
} from "./constants";
import {
  initializeChatScrollViewport,
  captureChatScrollForRender,
  restoreChatScrollAfterRender,
  disposeChatScrollViewport,
  scheduleChatScrollReconciliation,
  scheduleChatContentScroll,
  writeChatScrollTop,
  persistChatScrollSnapshotForConversationKey,
  setFollowBottomChatScrollSnapshot,
  withScrollGuard,
} from "./chatScrollSnapshots";
import {
  collectExpandedQuoteCardKeys,
  restoreExpandedQuoteCards,
} from "./assistantCitationLinks";
import {
  syncConversationTurnNavigator,
  updateStreamingTurnNavigator,
} from "./conversationTurnNavigator";
import { resizeTextareaToContent } from "./textareaSizing";
export { withScrollGuard } from "./chatScrollSnapshots";

import { type BlockStreamFlushReason } from "./blockStreamCoalescer";
import { createStreamingResponse } from "./streamingResponse";
import {
  getStreamInterruptionLabel,
  resolveStreamInterruptionOutcome,
} from "./streamInterruption";
import {
  restoreRetryUserSnapshot,
  takeRetryUserSnapshot,
} from "./retryUserSnapshot";
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
import { isEmbeddableGeneratedImage } from "../../services/images/generatedImageAssets";
import { copyTextToClipboard } from "./clipboard";
import {
  capturePanelOperationLease,
  evaluatePanelOwnership,
  isPanelOperationLeaseCurrent,
  type PanelOperationLease,
  renderPanelOwnershipBlocked,
  requireCurrentPanelOwnership,
} from "./panelHostOwnership";
import { renderAssistantGeneratedImagesInto } from "./generatedImageRender";
export { copyTextToClipboard } from "./clipboard";
export {
  copyGeneratedImageToClipboard,
  renderAssistantGeneratedImagesInto,
} from "./generatedImageRender";
import { ensureMineruCacheDirForAttachment } from "../../services/mineru/sync";
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
import { resolveTargetedAssistantRerenders } from "./targetedRerender";
import { withConversationWriteLock } from "../../shared/conversationWriteFence";
import {
  createTurnUsageRecorder,
  type TurnUsageRecorder,
  type UsageTurnFlushReason,
} from "../../utils/usageTurnRecorder";
import {
  chatHistory,
  conversationForkLinks,
  loadedConversationKeys,
  loadingConversationTasks,
  webChatIsolatedConversationKeys,
  selectedReasoningCache,
  selectedReasoningProviderCache,
  selectedImageCache,
  selectedFileAttachmentCache,
  selectedPaperContextCache,
  selectedCollectionContextCache,
  selectedTagContextCache,
  initializedConversationComposeContextKeys,
  paperContextModeOverrides,
  paperContentSourceOverrides,
  activeContextPanels,
  unregisterContextPanel,
  activeContextPanelStateSync,
  getCancelledRequestId,
  getPendingRequestId,
  getLivePlanExecution,
  recordLivePlanExecution,
  getAbortController,
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
  areConversationWritesFrozen,
  finishRequest,
  isRequestOwner,
  nextRequestId,
  isRequestPending,
  setPendingRequestId,
  transferRequest,
  tryBeginRequest,
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
  type ResponseActionKind,
  type ResponseActionTarget,
} from "./state";
import { agentRunTraceCache, agentRunTraceLoadingTasks } from "./agentState";
import {
  formatTime,
  setStatus,
  setTokenUsage,
  getSelectedTextWithinBubble,
  getAttachmentTypeLabel,
  buildQuestionWithSelectedTextContexts,
  buildModelPromptWithFileContext,
  resolvePromptText,
} from "./textUtils";
import { sanitizeText } from "../../utils/textSanitization";
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
} from "../../services/context/normalizers";
import { positionMenuAtPointer } from "./menuPositioning";
import { FULL_PDF_UNSUPPORTED_MESSAGE } from "./pdfSupportMessages";
import {
  getAvailableModelEntries,
  getLastReasoningExpanded,
  getLastUsedReasoningLevel,
  getLastUsedReasoningLevelForProvider,
  getSelectedModelEntry,
  getStringPref,
  setLastReasoningExpanded,
  setLastUsedReasoningLevelForProvider,
} from "./prefHelpers";
import { resolveMultiContextPlan } from "./multiContextPlanner";
import {
  formatPaperCitationLabel,
  resolvePaperContextDisplayRef,
  resolvePaperContextRefFromAttachment,
  resolvePaperContextRefFromItem,
  type PaperContextDisplayCache,
} from "../../services/paperContent/paperAttribution";
import { buildPaperKey } from "../../services/paperContent/pdfContext";
import { resolveProviderCapabilities } from "../../providers";
import {
  getActiveContextAttachmentFromTabs,
  resolveContextSourceItem,
  setSelectedTextContextEntries,
} from "./contextResolution";
import {
  resolveActiveNoteSession,
  resolveConversationBaseItem,
  resolveConversationSystemForItem,
  resolveDisplayConversationKind,
} from "./portalScope";
import { isGlobalPortalItem } from "../../services/context/portalItems";
import { shouldShowForkActionForAssistantTurn } from "./forkActionVisibility";
import { buildChatHistoryNotePayload } from "./notes";
import { readNoteSnapshot } from "../../services/notes/noteSnapshot";
import { extractManagedBlobHash } from "../../services/attachmentStorage";
import { buildContextPlanSystemMessages } from "./requestSystemMessages";
import { getWorkflowTestFinalRequestInterceptor } from "./workflowTestHooks";
import { resolveSelectedTextAnchors } from "./selectedTextAnchors";
import { canEditUserPromptTurn } from "./editability";
import {
  renderAgentTrace,
  disposeAgentTrace,
  renderPendingActionCard,
} from "./agentTrace/render";
import {
  createCodexNativeActivityTraceController,
  isCodexNativeAgentMessageItem,
  noteExplicitCodexNativeSkillInvocations,
  type CodexNativeActivityTraceController,
} from "./codexNativeTrace/controller";
import {
  conversationHasStreamingMessage,
  finalizeAssistantMessageQuoteCitations,
  resetAssistantQuoteDisplay,
  validateLoadedConversationQuoteMessages,
} from "./quoteValidation/scheduling";
import { applyStableAnimationPhase } from "./stableAnimationPhase";
import type { AgentActionContract } from "../../agent/contracts/types";
import { stripReceiptStatusForDisplay } from "../../agent/contracts/actionEvaluation";
import { planExecutionCoordinator } from "../../agent/plans/coordinator";
import { renderRenderedMarkdownInto } from "./renderedMarkdown";
import { disposeStreamingMarkdown } from "./streamingMarkdown";
import { getWebSourceAnchorsFromTrace } from "../../webAccess/attribution";
import type { WebSourceAnchor } from "../../webAccess/types";
import { decorateWebSourceIndicators } from "./webSourceIndicators";
import { toFileUrl } from "../../utils/pathFileUrl";
import { replaceOwnerAttachmentRefs } from "../../utils/attachmentRefStore";
import { getNotesDirectoryConfig } from "../../utils/notesDirectoryConfig";
import { getWebChatTargetByModelName } from "../../webchat/types";
import {
  buildAssistantDisplayMarkdownForRender,
  decorateCompletedAssistantCitationLinks,
  renderAssistantRichText,
} from "./assistantRichText";
export { buildAssistantDisplayMarkdownForRender } from "./assistantRichText";
import {
  getMessageCitationPaperContexts,
  mergeCitationPaperContexts,
} from "./citationContexts";
import {
  buildSelectedTextQuoteCitations,
  extractQuoteCitationsFromToolContent,
  finalizeAssistantQuoteCitations,
  mergeQuoteCitations,
} from "../../services/quotes/quoteCitations";
import {
  buildQuoteExpandedMarkdown,
  getMessageQuoteDisplay,
  QUOTE_RENDER_OCCURRENCE_PATTERN,
} from "./quoteRenderPlan";
import {
  getAgentApi,
  getCoreAgentRuntime,
  initAgentSubsystem,
} from "../../agent/index";
import { getClaudeReasoningModePref } from "../../claudeCode/prefs";
import {
  appendAgentRunEventAfterLatest,
  createAgentRunEventJournal,
  getAgentRunTrace,
} from "../../agent/store/traceStore";
import { deliverPendingPlanDocumentMessage } from "../../agent/documents/publication";
import { materialRefFromDocument } from "../../agent/documents/workflowMaterial";
import { loadDocumentIdForMessageOwner } from "../../agent/documents/store";
import type { PlanDocument } from "../../agent/documents/types";
import {
  applyHistoryCompression,
  scheduleLLMSummary,
} from "./conversationSummaryCache";
import type {
  AgentAttachmentResource,
  AgentAttachmentResourceSummary,
  AgentConfirmationResolution,
  AgentPendingAction,
  AgentRunEventRecord,
  AgentRuntimeRequestInput as AgentRuntimeRequest,
} from "../../agent/types";
import { getCodexNativeRawString } from "../../codexAppServer/nativeActivityStages";
import { buildAgentStageEvent } from "../../agent/stageEvents";
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
  transferQueuedFollowUpThreadState,
} from "./queuedFollowUps";
import { getConversationKey } from "./conversationIdentity";
import { recordContextCacheTelemetry } from "../../contextCache/manager";
import { resolveContextAttachmentSupportFromMetadata } from "../../services/paperContent/contextAttachmentSupport";
import { createLocalPdfResourceResolver } from "./setupHandlers/controllers/localPdfResourceResolver";
import {
  clearPaperContentSourceOverride,
  setPaperContentSourceOverride,
} from "./contexts/paperContextState";
import {
  getConversationScopeValidationDetails,
  getRegisteredConversationScope,
  type ConversationRegistryScope,
} from "../../shared/conversationRegistry";
import { isConversationInstanceRecentlyDeleted } from "../../core/conversations/recentlyDeletedConversations";
import {
  provisionConversationScopeForItem,
  resolveConversationStorageSystemForItem,
} from "./conversationProvisioning";

export { getConversationKey } from "./conversationIdentity";
export { renderAssistantMarkdownHtmlForChat } from "./renderedMarkdown";

/** Get AbortController constructor from global scope */
function getAbortControllerCtor(): (new () => AbortController) | undefined {
  return (
    (ztoolkit.getGlobal("AbortController") as new () => AbortController) ||
    (
      globalThis as typeof globalThis & {
        AbortController?: new () => AbortController;
      }
    ).AbortController
  );
}

// AbortController is not guaranteed in Zotero's Gecko chrome context. When it
// is absent, requests run without cancellation support instead of failing at
// admission; this inert signal keeps beginPanelRequest's return shape.
const INERT_ABORT_SIGNAL = { aborted: false } as AbortSignal;

// Committing hidden turns is best effort: prompt, retry-target, render and
// history-search correctness all come from filterMessagesInPendingTurns, which
// reads the store's in-memory entries synchronously and does not depend on the
// finalize completing. The store serializes every op on one chain, so a slow
// finalize belonging to an UNRELATED conversation would otherwise hold this
// user action for as long as its provider call takes (a codex thread archive
// can run to its 60s request timeout). Bound the wait and move on; the entry
// stays queued and hidden, and its own retry timer finalizes it.
// AbortController is not reliably available under Gecko, so this uses the
// repo's Promise.race + setTimeout/clearTimeout idiom.
const PENDING_TURN_FINALIZE_WAIT_MS = 3_000;

async function awaitPendingTurnFinalize(
  finalize: Promise<boolean>,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      finalize.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(resolve, PENDING_TURN_FINALIZE_WAIT_MS);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

const blockedConversationLoadKeys = new Set<number>();
type AgentRunTraceLoader = typeof getAgentRunTrace;
let agentRunTraceLoader: AgentRunTraceLoader = getAgentRunTrace;

export function setAgentRunTraceLoaderForTests(
  loader?: AgentRunTraceLoader,
): void {
  agentRunTraceLoader = loader || getAgentRunTrace;
  if (!loader) {
    agentRunTraceCache.clear();
    agentRunTraceLoadingTasks.clear();
  }
}

export function hasAgentRunTraceForTests(runId: string): boolean {
  return agentRunTraceCache.has((runId || "").trim());
}

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
    appLogger.warn(
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

export function storedMessagesMatchActivePaper(
  item: Zotero.Item,
  storedMessages: StoredChatMessage[],
): boolean {
  // Note ownership is checked against the registered note item before loading.
  // A note's references need not contain its own ID as a paper citation.
  if (resolveActiveNoteSession(item)) return true;
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

function completePaperContextKey(
  paperContext: PaperContextRef,
  fallbackLibraryID = 0,
): string {
  return `${Math.floor(Number(paperContext.libraryID || fallbackLibraryID))}:${Math.floor(Number(paperContext.itemId))}:${Math.floor(Number(paperContext.contextItemId))}`;
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
      const key = completePaperContextKey(context);
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
  webSourceAnchors?: readonly WebSourceAnchor[];
}): ResponseActionTarget | null {
  const {
    item,
    message,
    pairedUserMessage,
    conversationKey,
    selectedText,
    webSourceAnchors = [],
  } = params;
  const quoteDisplay =
    webSourceAnchors.length && !selectedText
      ? {
          markdown: message.text || "",
          quoteCitations: message.quoteCitations,
        }
      : getMessageQuoteDisplay(message);
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
    webSourceAnchors: webSourceAnchors.length
      ? webSourceAnchors.map((anchor) => ({
          offset: anchor.offset,
          sources: anchor.sources.map((source) => ({ ...source })),
        }))
      : undefined,
    agentRunId: message.agentRunId,
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
    const currentItem = activeContextPanels.get(params.body)?.() || null;
    if (
      currentItem &&
      !requireCurrentPanelOwnership(
        params.body,
        currentItem,
        "copy-user-message",
      )
    ) {
      return;
    }
    await copyTextToClipboard(params.body, params.message.text || "");
    const status = params.body.querySelector(
      "#llm-status",
    ) as HTMLElement | null;
    if (status) setStatus(status, t("Copied query"), "ready");
  });
  return button;
}

export function appendAssistantResponseExpandAction(params: {
  body: Element;
  doc: Document;
  actions: HTMLElement;
  target: ResponseActionTarget | null;
}): HTMLButtonElement | null {
  if (!params.target) return null;
  return appendMessageMetaActionButton({
    body: params.body,
    doc: params.doc,
    actions: params.actions,
    className: "llm-message-action-expand",
    title: "Open response in larger view",
    responseAction: "expand",
    responseTarget: params.target,
    conversationKey: params.target.conversationKey,
    userTimestamp: params.target.userTimestamp,
    assistantTimestamp: params.target.assistantTimestamp,
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

/** Legacy cumulative API token usage per conversation key for this UI session. */
const sessionTokenTotals = new Map<number, number>();
export type ContextUsageSnapshot = {
  contextTokens: number;
  contextWindow?: number;
  inputLimitSource?: ModelInputTokenLimitSource;
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
    inputLimitSource: snapshot.inputLimitSource,
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
    body.querySelector("#llm-context-gauge") as HTMLElement | null,
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
    {
      apiBase: effectiveRequestConfig.apiBase,
      protocol: effectiveRequestConfig.providerProtocol,
      authMode: effectiveRequestConfig.authMode,
      profileOverride: effectiveRequestConfig.advanced?.profileOverride,
    },
  );
  if (inputCap.estimatedAfterTokens <= 0) return undefined;
  return {
    contextTokens: inputCap.estimatedAfterTokens,
    contextWindow: inputCap.limitTokens,
    inputLimitSource: inputCap.limitSource,
    estimated: true,
    source: "estimated",
  };
}

export function refreshActiveConversationPanels(
  conversationKey?: number,
): void {
  for (const [body, getItem] of activeContextPanels) {
    if (!(body as Element).isConnected) {
      unregisterContextPanel(body);
      continue;
    }
    const item = getItem();
    if (!item) continue;
    if (
      conversationKey !== undefined &&
      getConversationKey(item) !== conversationKey
    )
      continue;
    refreshChat(body, item);
  }
}

subscribeModelProviderGroups(refreshActiveConversationPanels);

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

export function requestChatScrollFollowBottom(
  body: Element,
  item: Zotero.Item,
  chatBox: HTMLDivElement,
): void {
  const conversationKey = getConversationKey(item);
  setFollowBottomChatScrollSnapshot(conversationKey, chatBox);
  scheduleChatScrollReconciliation(conversationKey, chatBox);
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
  expectedGeneration = getConversationWriteGeneration(conversationKey),
): Promise<void> {
  try {
    const link = await getConversationForkLink(conversationKey);
    if (
      pendingDeletionStore.isConversationPendingDeletion(conversationKey) ||
      isConversationKeyRetiredInMemory(conversationKey) ||
      areConversationWritesFrozen(conversationKey) ||
      !isConversationWriteGenerationCurrent(conversationKey, expectedGeneration)
    ) {
      conversationForkLinks.delete(conversationKey);
      return;
    }
    if (link) {
      conversationForkLinks.set(conversationKey, link);
    } else {
      conversationForkLinks.delete(conversationKey);
    }
  } catch (err) {
    conversationForkLinks.delete(conversationKey);
    appLogger.warn("LLM: Failed to load conversation fork link", err);
  }
}

async function updateStoredLatestUserMessageByConversationUnlocked(
  conversationKey: number,
  message: Parameters<typeof updateStoredLatestUserMessage>[1] & {
    conversationGeneration?: number;
  },
  conversationSystem?: ConversationSystem | null,
): Promise<void> {
  const expectedGeneration = Number(
    (message as StoredChatMessage).conversationGeneration,
  );
  if (
    Number.isFinite(expectedGeneration) &&
    !isConversationWriteGenerationCurrent(conversationKey, expectedGeneration)
  ) {
    return;
  }
  if (areConversationWritesFrozen(conversationKey)) return;
  const storageSystem = resolveConversationStorageSystem({
    conversationKey,
    conversationSystem,
  });
  if (!storageSystem) return;
  if (storageSystem === "claude_code") {
    await updateLatestClaudeConversationUserMessageWithinWriteLock(
      conversationKey,
      message,
    );
    return;
  }
  if (storageSystem === "codex") {
    await updateLatestCodexUserMessage(conversationKey, message);
    return;
  }
  await updateStoredLatestUserMessage(conversationKey, message);
}

async function publishPersistedPlanDocumentIfPresent(params: {
  conversationKey: number;
  text?: string;
  timestamp?: number;
  agentRunId?: string;
  documentId?: string;
  planDocumentId?: string;
}): Promise<void> {
  const visibleMarkdown = params.text || "";
  if (!visibleMarkdown) return;
  const document = await deliverPendingPlanDocumentMessage({
    conversationKey: params.conversationKey,
    visibleMarkdown,
    messageTimestamp: Number.isFinite(Number(params.timestamp))
      ? Math.floor(Number(params.timestamp))
      : Date.now(),
    documentId: params.documentId || params.planDocumentId,
  });
  if (!document) return;
  await announceFinalizedMaterialForRun(params.agentRunId, document);
  // Delivery may complete the final durable Plan task, and it is also what
  // announces the finalized material. Refresh this conversation's views once
  // both are durable, so progress cards reload the committed ledger and the
  // trace paints the material row, without rebuilding unrelated chats that
  // the user may be reading.
  refreshActiveConversationPanels(params.conversationKey);
}

/**
 * Record the material a delivered document finalized on its own run trace.
 *
 * External backends run their tools through the MCP surface, which journals
 * provider activity rather than runtime tool results, so this host-side
 * publication is the only `material_finalized` a Codex or Claude native run
 * ever gets. The original runtime emits its own, so the append is skipped
 * when the run already announced this document.
 */
async function announceFinalizedMaterialForRun(
  agentRunId: string | undefined,
  document: PlanDocument,
): Promise<void> {
  const runId = agentRunId?.trim();
  if (!runId) return;
  const persistedTrace = await getAgentRunTrace(runId);
  if (
    persistedTrace.events.some(
      (entry) =>
        entry.payload.type === "material_finalized" &&
        entry.payload.materialRef.documentId === document.documentId,
    )
  ) {
    return;
  }
  const materialRef = materialRefFromDocument(document);
  // The stage goes in first, immediately before the event it describes, as
  // every other producer emits it: a run that already carries stages is one
  // the compatibility projection leaves alone, so an unbracketed material
  // here would simply never show as generated work.
  const appended = [
    await appendAgentRunEventAfterLatest(
      runId,
      buildAgentStageEvent({
        stage: "generation",
        status: "completed",
        materialRef,
      }),
    ),
    await appendAgentRunEventAfterLatest(runId, {
      type: "material_finalized" as const,
      materialRef,
      materialKind: document.version === 2 ? document.documentKind : undefined,
      materialTitle: document.title,
    }),
  ];
  const cached = agentRunTraceCache.get(runId) || [];
  const added = appended.filter(
    (record) => !cached.some((entry) => entry.seq === record.seq),
  );
  if (added.length) agentRunTraceCache.set(runId, [...cached, ...added]);
}

export const announceFinalizedMaterialForRunForTests =
  announceFinalizedMaterialForRun;

async function updateStoredLatestAssistantMessageByConversationUnlocked(
  conversationKey: number,
  message: Parameters<typeof updateStoredLatestAssistantMessage>[1] &
    Pick<StoredChatMessage, "documentId" | "planDocumentId"> & {
      conversationGeneration?: number;
    },
  conversationSystem?: ConversationSystem | null,
): Promise<void> {
  const expectedGeneration = Number(
    (message as StoredChatMessage).conversationGeneration,
  );
  if (
    Number.isFinite(expectedGeneration) &&
    !isConversationWriteGenerationCurrent(conversationKey, expectedGeneration)
  ) {
    return;
  }
  if (areConversationWritesFrozen(conversationKey)) return;
  const storageSystem = resolveConversationStorageSystem({
    conversationKey,
    conversationSystem,
  });
  if (!storageSystem) return;
  if (storageSystem === "claude_code") {
    const latestContextSnapshot = contextUsageSnapshots.get(conversationKey);
    await updateLatestClaudeConversationAssistantMessageWithinWriteLock(
      conversationKey,
      {
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
      },
    );
    await publishPersistedPlanDocumentIfPresent({
      conversationKey,
      text: message.text,
      timestamp: message.timestamp,
      agentRunId: message.agentRunId,
      documentId: message.documentId,
      planDocumentId: message.planDocumentId,
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
    await publishPersistedPlanDocumentIfPresent({
      conversationKey,
      text: message.text,
      timestamp: message.timestamp,
      agentRunId: message.agentRunId,
      documentId: message.documentId,
      planDocumentId: message.planDocumentId,
    });
    return;
  }
  await updateStoredLatestAssistantMessage(conversationKey, message);
  await publishPersistedPlanDocumentIfPresent({
    conversationKey,
    text: message.text,
    timestamp: message.timestamp,
    agentRunId: message.agentRunId,
    documentId: message.documentId,
    planDocumentId: message.planDocumentId,
  });
}

async function updateStoredLatestUserMessageByConversation(
  conversationKey: number,
  message: Parameters<typeof updateStoredLatestUserMessage>[1] & {
    conversationGeneration?: number;
  },
  conversationSystem?: ConversationSystem | null,
): Promise<void> {
  await withConversationWriteLock(conversationKey, () =>
    updateStoredLatestUserMessageByConversationUnlocked(
      conversationKey,
      message,
      conversationSystem,
    ),
  );
}

async function updateStoredLatestAssistantMessageByConversation(
  conversationKey: number,
  message: Parameters<typeof updateStoredLatestAssistantMessage>[1] & {
    conversationGeneration?: number;
  },
  conversationSystem?: ConversationSystem | null,
): Promise<void> {
  await withConversationWriteLock(conversationKey, () =>
    updateStoredLatestAssistantMessageByConversationUnlocked(
      conversationKey,
      message,
      conversationSystem,
    ),
  );
}

async function persistConversationMessage(
  conversationKey: number,
  message: StoredChatMessage,
  conversationSystem?: ConversationSystem | null,
): Promise<void> {
  try {
    const expectedGeneration = Number(message.conversationGeneration);
    if (
      Number.isFinite(expectedGeneration) &&
      !isConversationWriteGenerationCurrent(conversationKey, expectedGeneration)
    ) {
      return;
    }
    if (areConversationWritesFrozen(conversationKey)) return;
    await withConversationWriteLock(conversationKey, async () => {
      if (
        (Number.isFinite(expectedGeneration) &&
          !isConversationWriteGenerationCurrent(
            conversationKey,
            expectedGeneration,
          )) ||
        areConversationWritesFrozen(conversationKey)
      ) {
        return;
      }
      const storageSystem = resolveConversationStorageSystem({
        conversationKey,
        conversationSystem,
      });
      if (!storageSystem) return;
      if (storageSystem === "claude_code") {
        await appendClaudeConversationMessageWithinWriteLock(
          conversationKey,
          message,
          undefined,
        );
      } else if (storageSystem === "codex") {
        await appendCodexMessage(conversationKey, message, undefined);
        await pruneCodexConversation(conversationKey, PERSISTED_HISTORY_LIMIT);
      } else {
        await appendStoredMessage(conversationKey, message, undefined);
        await pruneConversation(conversationKey, PERSISTED_HISTORY_LIMIT);
      }
      if (message.role === "assistant") {
        await publishPersistedPlanDocumentIfPresent({
          conversationKey,
          text: message.text,
          timestamp: message.timestamp,
          agentRunId: message.agentRunId,
          documentId: message.documentId,
          planDocumentId: message.planDocumentId,
        });
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
        expectedGeneration,
      );
    });
  } catch (err) {
    appLogger.warn("LLM: Failed to persist chat message", err);
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
    pdfPaperContexts.map((paper) => completePaperContextKey(paper)),
  );
  const fullTextPaperContexts = allFullTextPaperContexts.filter(
    (paper) => !pdfKeys.has(completePaperContextKey(paper)),
  );
  const fullTextKeys = new Set(
    fullTextPaperContexts.map((paper) => completePaperContextKey(paper)),
  );
  return {
    paperContexts: allPaperContexts.filter((paper) => {
      const key = completePaperContextKey(paper);
      return !pdfKeys.has(key) && !fullTextKeys.has(key);
    }),
    pdfPaperContexts,
    fullTextPaperContexts,
  };
}

export const normalizeStoredPaperContextRoutesForTests =
  normalizeStoredPaperContextRoutes;

function getMessageDisplayPaperContexts(
  message: Pick<
    Message,
    "paperContexts" | "pdfPaperContexts" | "fullTextPaperContexts"
  >,
): PaperContextRef[] {
  return normalizePaperContexts([
    ...(message.paperContexts || []),
    ...(message.fullTextPaperContexts || []),
    ...(message.pdfPaperContexts || []),
  ]);
}

export const getMessageDisplayPaperContextsForTests =
  getMessageDisplayPaperContexts;

type ConversationComposeContextSnapshot = {
  paperContexts: PaperContextRef[];
  collectionContexts: CollectionContextRef[];
  tagContexts: TagContextRef[];
};

function toContinuationPaperContext(
  paperContext: PaperContextRef,
): PaperContextRef {
  const { contentSourceMode: _consumedSourceMode, ...identity } = paperContext;
  return identity;
}

function deriveConversationComposeContextSnapshot(
  conversationKey: number,
  messages: Message[],
  autoLoadedPaperContext?: PaperContextRef | null,
): ConversationComposeContextSnapshot {
  const latestUserMessage = [
    ...filterMessagesInPendingTurns(conversationKey, messages),
  ]
    .reverse()
    .find((message) => message.role === "user");
  if (!latestUserMessage) {
    return { paperContexts: [], collectionContexts: [], tagContexts: [] };
  }
  const autoPaperKey = autoLoadedPaperContext
    ? completePaperContextKey(autoLoadedPaperContext)
    : "";
  const paperContexts = getMessageDisplayPaperContexts(latestUserMessage)
    .filter(
      (paperContext) => completePaperContextKey(paperContext) !== autoPaperKey,
    )
    .map(toContinuationPaperContext);
  return {
    paperContexts,
    collectionContexts: normalizeCollectionContexts(
      latestUserMessage.selectedCollectionContexts,
    ),
    tagContexts: normalizeTagContexts(latestUserMessage.selectedTagContexts),
  };
}

export const deriveConversationComposeContextSnapshotForTests =
  deriveConversationComposeContextSnapshot;

function clearPaperContinuationOverrides(itemId: number): void {
  const prefix = `${itemId}:`;
  for (const key of Array.from(paperContextModeOverrides.keys())) {
    if (key.startsWith(prefix)) paperContextModeOverrides.delete(key);
  }
  for (const key of Array.from(paperContentSourceOverrides.keys())) {
    if (key.startsWith(prefix)) paperContentSourceOverrides.delete(key);
  }
}

export function restoreConversationComposeContext(item: Zotero.Item): boolean {
  const conversationKey = getConversationKey(item);
  const itemId = Math.floor(Number(item.id || 0));
  if (
    conversationKey <= 0 ||
    itemId <= 0 ||
    !loadedConversationKeys.has(conversationKey) ||
    initializedConversationComposeContextKeys.has(conversationKey)
  ) {
    return false;
  }
  if (
    selectedPaperContextCache.has(itemId) ||
    selectedCollectionContextCache.has(itemId) ||
    selectedTagContextCache.has(itemId)
  ) {
    initializedConversationComposeContextKeys.add(conversationKey);
    return false;
  }

  const snapshot = deriveConversationComposeContextSnapshot(
    conversationKey,
    chatHistory.get(conversationKey) || [],
    resolveAutoLoadedPaperContextForItem(item),
  );
  if (snapshot.paperContexts.length) {
    selectedPaperContextCache.set(itemId, snapshot.paperContexts);
  } else {
    selectedPaperContextCache.delete(itemId);
  }
  if (snapshot.collectionContexts.length) {
    selectedCollectionContextCache.set(itemId, snapshot.collectionContexts);
  } else {
    selectedCollectionContextCache.delete(itemId);
  }
  if (snapshot.tagContexts.length) {
    selectedTagContextCache.set(itemId, snapshot.tagContexts);
  } else {
    selectedTagContextCache.delete(itemId);
  }
  clearPaperContinuationOverrides(itemId);
  initializedConversationComposeContextKeys.add(conversationKey);

  for (const [body, getItem] of activeContextPanels) {
    const activeItem = getItem();
    if (!activeItem || getConversationKey(activeItem) !== conversationKey) {
      continue;
    }
    activeContextPanelStateSync.get(body)?.();
  }
  return true;
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
    // Preserve the immutable database row identity through the runtime
    // history model. Turn-deletion intents use this ID as the primary fence;
    // dropping it here forces every consumer back onto recyclable timestamps.
    id: message.id,
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
    interrupted: message.interrupted || undefined,
    completionStatus: message.completionStatus,
    completionReason: message.completionReason,
    webchatRunState: message.webchatRunState,
    webchatCompletionReason: message.webchatCompletionReason,
    quoteCitations: message.quoteCitations,
  };
}

export async function ensureConversationLoaded(
  item: Zotero.Item,
): Promise<void> {
  // Provision first.  A paper's historical default key may have been
  // permanently retired; provisioning then allocates a fresh key and updates
  // the active scope before this function captures the key used by all load,
  // append, and identity-fence checks below.
  await provisionConversationScopeForItem({ item }).catch(() => false);
  const conversationKey = getConversationKey(item);
  // Provisioning can replace a retired default with a fresh key after the DOM
  // was initially built. Keep every mounted surface's identity dataset in
  // lock-step with the item object so reader actions (including Add Text) do
  // not target the retired key captured during the first render.
  for (const [body, getItem] of activeContextPanels) {
    if (getItem() !== item) continue;
    if (
      !requireCurrentPanelOwnership(
        body,
        item,
        "provision-conversation-identity",
      )
    ) {
      continue;
    }
    const root = body.querySelector("#llm-main") as HTMLElement | null;
    if (root) root.dataset.itemId = String(conversationKey);
  }
  const conversationSystem = resolveConversationSystemForItem(item);
  const loadGeneration = getConversationWriteGeneration(conversationKey);
  if (pendingDeletionStore.isConversationPendingDeletion(conversationKey)) {
    chatHistory.delete(conversationKey);
    loadedConversationKeys.delete(conversationKey);
    conversationForkLinks.delete(conversationKey);
    return;
  }
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
    restoreConversationComposeContext(item);
    return;
  }
  if (
    chatHistory.has(conversationKey) &&
    !blockedConversationLoadKeys.has(conversationKey)
  ) {
    await loadConversationForkLinkCache(conversationKey, loadGeneration);
    loadedConversationKeys.add(conversationKey);
    restoreConversationComposeContext(item);
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
    restoreConversationComposeContext(item);
    return;
  }

  const task = (async () => {
    let shouldMarkLoaded = false;
    let instanceID = "";
    try {
      try {
        instanceID =
          (await getRegisteredConversationScope(conversationKey))?.instanceID ||
          "";
      } catch {
        instanceID = "";
      }
      const isFrozen = () =>
        pendingDeletionStore.isConversationPendingDeletion(conversationKey) ||
        areConversationWritesFrozen(conversationKey) ||
        !isConversationWriteGenerationCurrent(
          conversationKey,
          loadGeneration,
        ) ||
        (Boolean(instanceID) &&
          isConversationInstanceRecentlyDeleted(conversationKey, instanceID));
      if (isFrozen()) {
        chatHistory.delete(conversationKey);
        conversationForkLinks.delete(conversationKey);
        return;
      }
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
      for (const storedMessage of storedMessages) {
        if (
          storedMessage.role !== "assistant" ||
          storedMessage.documentId ||
          !Number.isFinite(storedMessage.timestamp)
        ) {
          continue;
        }
        storedMessage.documentId =
          (await loadDocumentIdForMessageOwner({
            conversationKey,
            sourceMessageTimestamp: Math.floor(storedMessage.timestamp),
          })) || undefined;
      }
      // Recover the application-level document outbox after a crash between
      // durable message insertion and publication evidence/event delivery.
      for (const storedMessage of storedMessages) {
        if (storedMessage.role !== "assistant" || !storedMessage.text) continue;
        await publishPersistedPlanDocumentIfPresent({
          conversationKey,
          text: storedMessage.text,
          timestamp: storedMessage.timestamp,
          agentRunId: storedMessage.agentRunId,
          documentId: storedMessage.documentId,
          planDocumentId: storedMessage.planDocumentId,
        });
      }
      if (isFrozen()) {
        chatHistory.delete(conversationKey);
        conversationForkLinks.delete(conversationKey);
        return;
      }
      if (
        webChatIsolatedConversationKeys.has(conversationKey) ||
        isEffectiveWebChatRequest(item)
      ) {
        isolateWebChatConversationKey(conversationKey, false);
        shouldMarkLoaded = true;
        return;
      }
      if (!storedMessagesMatchActivePaper(item, storedMessages)) {
        appLogger.warn(
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
      await loadConversationForkLinkCache(conversationKey, loadGeneration);
      if (isFrozen()) {
        chatHistory.delete(conversationKey);
        conversationForkLinks.delete(conversationKey);
        return;
      }
      shouldMarkLoaded = true;
    } catch (err) {
      appLogger.warn("LLM: Failed to load chat history", err);
      if (
        pendingDeletionStore.isConversationPendingDeletion(conversationKey) ||
        (instanceID &&
          isConversationInstanceRecentlyDeleted(conversationKey, instanceID))
      ) {
        chatHistory.delete(conversationKey);
        conversationForkLinks.delete(conversationKey);
        shouldMarkLoaded = false;
        return;
      }
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
  restoreConversationComposeContext(item);
}

const pendingTraceRefreshes = new Map<
  number,
  {
    runIds: Set<string>;
    done: Promise<void>;
  }
>();

function refreshLoadedTraceMessages(
  runId: string,
  body: Element,
  item: Zotero.Item,
  isFrozen: () => boolean,
): Promise<void> {
  const key = getConversationKey(item);
  const pending = pendingTraceRefreshes.get(key);
  if (pending) {
    pending.runIds.add(runId);
    return pending.done;
  }
  const runIds = new Set([runId]);
  let resolve!: () => void;
  const done = new Promise<void>((finish) => {
    resolve = finish;
  });
  pendingTraceRefreshes.set(key, { runIds, done });
  createQueuedRefresh(() => {
    pendingTraceRefreshes.delete(key);
    try {
      if (isFrozen()) return;
      const messages = new Set(
        (chatHistory.get(key) || []).filter(
          (message) =>
            message.role === "assistant" &&
            runIds.has(message.agentRunId || ""),
        ),
      );
      if (messages.size)
        refreshConversationPanels(body, item, {
          chatOptions: { rerenderAssistantMessages: messages },
        });
    } finally {
      resolve();
    }
  })();
  return done;
}

async function ensureAgentRunTraceLoaded(
  runId: string | undefined,
  body?: Element,
  item?: Zotero.Item | null,
): Promise<void> {
  const normalizedRunId = (runId || "").trim();
  if (!normalizedRunId || agentRunTraceCache.has(normalizedRunId)) return;
  const conversationKey = item ? getConversationKey(item) : 0;
  const expectedGeneration =
    conversationKey > 0 ? getConversationWriteGeneration(conversationKey) : 0;
  let instanceID = "";
  if (conversationKey > 0) {
    try {
      instanceID =
        (await getRegisteredConversationScope(conversationKey))?.instanceID ||
        "";
    } catch {
      instanceID = "";
    }
  }
  const isFrozen = () =>
    conversationKey > 0 &&
    (pendingDeletionStore.isConversationPendingDeletion(conversationKey) ||
      areConversationWritesFrozen(conversationKey) ||
      !isConversationWriteGenerationCurrent(
        conversationKey,
        expectedGeneration,
      ) ||
      (Boolean(instanceID) &&
        isConversationInstanceRecentlyDeleted(conversationKey, instanceID)));
  const existing = agentRunTraceLoadingTasks.get(normalizedRunId);
  if (existing) {
    await existing;
    return;
  }
  const task = (async () => {
    try {
      const trace = await agentRunTraceLoader(normalizedRunId);
      if (!isFrozen()) {
        agentRunTraceCache.set(normalizedRunId, trace.events);
      }
    } catch (err) {
      appLogger.warn("LLM: Failed to load agent run trace", err);
    } finally {
      agentRunTraceLoadingTasks.delete(normalizedRunId);
      if (body && item && !isFrozen()) {
        await refreshLoadedTraceMessages(normalizedRunId, body, item, isFrozen);
      }
    }
  })();
  agentRunTraceLoadingTasks.set(normalizedRunId, task);
  await task;
}

export function ensureAgentRunTraceLoadedForTests(
  runId: string,
  body: Element,
  item: Zotero.Item,
): Promise<void> {
  return ensureAgentRunTraceLoaded(runId, body, item);
}

function getCachedAgentRunEvents(
  runId: string | undefined,
): AgentRunEventRecord[] {
  const normalizedRunId = (runId || "").trim();
  if (!normalizedRunId) return [];
  return agentRunTraceCache.get(normalizedRunId) || [];
}

const REASONING_PROVIDER_KINDS = new Set<ReasoningProviderKind>([
  "openai",
  "gemini",
  "deepseek",
  "kimi",
  "mimo",
  "qwen",
  "grok",
  "minimax",
  "glm",
  "anthropic",
  "local",
]);

export function detectReasoningProvider(
  modelName: string,
  apiBase?: string,
): ReasoningProviderKind {
  const inferred = inferProviderFromModelName(modelName);
  if (
    inferred &&
    REASONING_PROVIDER_KINDS.has(inferred as ReasoningProviderKind)
  ) {
    return inferred as ReasoningProviderKind;
  }
  // Only as a last resort: a recognized family keeps its own profile even when
  // served locally, because the level set belongs to the weights. This covers
  // the models whose names match nothing — gemma, llama, mistral, or a custom
  // Modelfile name — whose reasoning support the server reports directly.
  if (apiBase && isLocalModelApiBase(apiBase)) return "local";
  return "unsupported";
}

export function getReasoningOptions(
  provider: ReasoningProviderKind,
  modelName: string,
  apiBase?: string,
  providerProtocol?: ProviderProtocol,
  profileOverride?: ModelProfileOverride,
): ReasoningOption[] {
  if (provider === "anthropic") {
    const resolvedProtocol =
      providerProtocol ||
      inferLegacyProviderProtocol({
        authMode: "api_key",
        apiBase: apiBase || "",
      });
    if (resolvedProtocol !== "anthropic_messages") return [];
  }
  // The user's override is part of the identity: the menu must offer exactly
  // the levels the request builder will encode, custom ones included.
  return getModelReasoningChoices(
    getModelCapabilities({
      provider: provider === "unsupported" ? undefined : provider,
      model: modelName,
      apiBase,
      protocol: providerProtocol,
      profileOverride,
    }),
  ).map((option) => ({
    level: option.level as LLMReasoningLevel,
    enabled: option.enabled,
    label: option.label,
  }));
}

export { QUOTE_RENDER_OCCURRENCE_PATTERN };

/**
 * The copied form of a response, which is what the reader saw and no more.
 *
 * The clipboard is a display surface: what leaves it is the answer as rendered,
 * so the action-status block the runtime appends for the model is removed here
 * exactly as the bubble removes it. Saving a response as a note keeps the
 * stored text as it stands, because that writes durable content of the user's
 * own rather than presenting the turn.
 */
export function buildPlainMarkdownClipboardText(
  markdownText: string,
  quoteCitations?: QuoteCitation[],
): string | null {
  const safeText = buildQuoteExpandedMarkdown({
    markdown: stripReceiptStatusForDisplay(sanitizeText(markdownText)).trim(),
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
    appLogger.warn("LLM: Copy markdown render error:", err);
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
  const currentItem = activeContextPanels.get(body)?.() || null;
  if (
    currentItem &&
    !requireCurrentPanelOwnership(body, currentItem, "copy-response")
  ) {
    return;
  }
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
        appLogger.debug("LLM: Rich clipboard write failed, falling back:", err);
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
  profileOverride?: ModelProfileOverride,
): LLMReasoningConfig | undefined {
  const detectedProvider = detectReasoningProvider(modelName, apiBase);
  const capabilities = getModelCapabilities({
    provider: detectedProvider === "unsupported" ? undefined : detectedProvider,
    model: modelName,
    apiBase,
    protocol: providerProtocol,
    profileOverride,
  });
  const provider =
    detectedProvider === "unsupported" ? "customized" : detectedProvider;
  const cached =
    selectedReasoningProviderCache.get(itemId) === provider
      ? selectedReasoningCache.get(itemId)
      : undefined;
  const saved =
    cached ||
    getLastUsedReasoningLevelForProvider(provider) ||
    getLastUsedReasoningLevel();
  const selected = resolveModelReasoningSelection(capabilities, {
    level: saved || "auto",
  });
  const level = selected.kind === "option" ? selected.option.id : "auto";
  selectedReasoningCache.set(itemId, level);
  selectedReasoningProviderCache.set(itemId, provider);
  return { provider, level };
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

function latestAssistantMessage(conversationKey: number): Message | undefined {
  const history = chatHistory.get(conversationKey) || [];
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].role === "assistant") return history[index];
  }
  return undefined;
}

/** Progress belongs to the live request, never to a historical assistant trace. */
function syncFloatingPlanProgress(
  chatBox: HTMLElement,
  conversationKey: number,
): void {
  const binding = getLivePlanExecution(conversationKey);
  const latestMessage = binding && latestAssistantMessage(conversationKey);
  const message =
    latestMessage?.agentRunId === binding?.runId && latestMessage?.streaming
      ? latestMessage
      : undefined;
  const cards = Array.from(
    chatBox.querySelectorAll(".llm-plan-container-execution"),
  ).filter(Boolean) as HTMLElement[];
  const current =
    binding && message
      ? cards.find(
          (card) =>
            card.dataset.llmPlanExecutionId === binding.ledger.executionId &&
            card.dataset.llmPlanRequestId === `${binding.requestId}` &&
            card.dataset.llmPlanRunId === binding.runId,
        )
      : undefined;
  for (const card of cards) {
    if (card !== current) disposePlanProgress(card);
  }
  if (!binding || !message) return;
  const progress = renderPlanProgress(
    chatBox.ownerDocument,
    binding.ledger,
    message.pendingAgentTraceEvents || getCachedAgentRunEvents(binding.runId),
    current,
  );
  if (progress.dataset.llmPlanRequestId !== `${binding.requestId}`)
    progress.dataset.llmPlanRequestId = `${binding.requestId}`;
  if (progress.dataset.llmPlanRunId !== binding.runId)
    progress.dataset.llmPlanRunId = binding.runId;
  if (!progress.classList.contains("llm-plan-progress-floating"))
    progress.classList.add("llm-plan-progress-floating");
  if (progress.parentElement !== chatBox) chatBox.appendChild(progress);
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
  signal?: AbortSignal,
  traceOwnsCard = false,
): Promise<AgentConfirmationResolution> {
  return new Promise((resolve) => {
    const cancel = () => {
      getAgentApi().resolveConfirmation(requestId, false);
    };
    if (signal?.aborted) {
      resolve({ approved: false });
      return;
    }
    appLogger.debug("Codex app-server native confirmation requested", {
      requestId,
      toolName: action.toolName,
      mode: action.mode || "approval",
      title: action.title,
    });
    const ui = getPanelRequestUI(body);
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc || !ui.chatBox) {
      appLogger.warn("Codex app-server native confirmation unavailable", {
        requestId,
        reason: "missing_panel_review_card_ui",
      });
      throw new Error(
        "Zotero review card UI is unavailable for native confirmation.",
      );
    }

    try {
      getAgentApi().registerPendingConfirmation(requestId, (resolution) => {
        appLogger.debug("Codex app-server native confirmation resolved", {
          requestId,
          approved: resolution.approved,
          actionId: resolution.actionId,
        });
        signal?.removeEventListener("abort", cancel);
        closeNativeMcpActionCard(body, requestId);
        resolve(resolution);
      });
    } catch (error) {
      appLogger.warn("Codex app-server native confirmation unavailable", {
        requestId,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw new Error(
        `Zotero review card UI could not register native confirmation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      return;
    }
    // The queued assistant trace owns persistent review cards. Register the
    // response now, but do not race that render with a second inline card.
    if (traceOwnsCard) return;
    const renderedCard = findNativeMcpActionCard(ui.chatBox, requestId);
    if (renderedCard) {
      scheduleChatContentScroll(ui.chatBox);
      syncInlineActionCardAttr(body);
      appLogger.debug("Codex app-server native confirmation rendered", {
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
    scheduleChatContentScroll(ui.chatBox);
    syncInlineActionCardAttr(body);
    appLogger.debug("Codex app-server native confirmation rendered", {
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

export async function resolveCodexNativeHostInteractionWithTrace(params: {
  body: Element;
  action: AgentPendingAction;
  trace?: CodexNativeApprovalTrace | null;
  showActionCard?: typeof showNativeMcpActionCard;
  nextRequestId?: () => string;
  isCurrent?: () => boolean;
}): Promise<AgentConfirmationResolution> {
  if (params.isCurrent && !params.isCurrent()) return { approved: false };
  const requestId =
    params.nextRequestId?.() ||
    `host-review-${Date.now()}-${++codexNativeApprovalRequestCounter}`;
  params.trace?.noteMcpConfirmationRequired?.(requestId, params.action);
  let resolution: AgentConfirmationResolution;
  try {
    resolution = await (params.showActionCard || showNativeMcpActionCard)(
      params.body,
      requestId,
      params.action,
      undefined,
      Boolean(params.trace?.noteMcpConfirmationRequired),
    );
  } catch (error) {
    params.trace?.noteMcpConfirmationResolved?.(requestId, {
      approved: false,
    });
    throw error;
  }
  if (params.isCurrent && !params.isCurrent()) {
    resolution = { approved: false };
  }
  params.trace?.noteMcpConfirmationResolved?.(requestId, resolution);
  return resolution;
}

export async function resolveCodexNativeApprovalWithOptionalReviewCard(params: {
  body: Element;
  request: CodexNativeApprovalRequest;
  trace?: CodexNativeApprovalTrace | null;
  setStatusSafely: (
    text: string,
    kind: Parameters<typeof setStatus>[2],
  ) => void;
  showActionCard?: (
    body: Element,
    requestId: string,
    action: AgentPendingAction,
    signal?: AbortSignal,
    traceOwnsCard?: boolean,
  ) => Promise<AgentConfirmationResolution>;
  nextRequestId?: () => string;
  isCurrent?: () => boolean;
}): Promise<unknown> {
  const questions = readNativeQuestions(params.request);
  const defaultDecision = resolveCodexNativeApprovalRequest(params.request);
  if (
    params.request.signal?.aborted ||
    (params.isCurrent && !params.isCurrent())
  ) {
    return questions ? { answers: {} } : defaultDecision.response;
  }
  if (defaultDecision.approved) {
    params.setStatusSafely("Codex approved Zotero MCP access", "sending");
    return defaultDecision.response;
  }
  if (questions) {
    const requestId = `codex-question-${Date.now()}-${++codexNativeApprovalRequestCounter}`;
    const action = buildNativeQuestionAction(questions);
    params.setStatusSafely("Codex is waiting for your input", "sending");
    params.trace?.noteMcpConfirmationRequired?.(requestId, action);
    let resolution: AgentConfirmationResolution;
    try {
      resolution = await (params.showActionCard || showNativeMcpActionCard)(
        params.body,
        requestId,
        action,
        params.request.signal,
        Boolean(params.trace?.noteMcpConfirmationRequired),
      );
    } catch (error) {
      params.trace?.noteMcpConfirmationResolved?.(requestId, {
        approved: false,
      });
      throw error;
    }
    if (
      params.request.signal?.aborted ||
      (params.isCurrent && !params.isCurrent())
    )
      resolution = { approved: false };
    params.trace?.noteMcpConfirmationResolved?.(requestId, resolution);
    return nativeQuestionAnswers(questions, resolution);
  }
  if (defaultDecision.reason === "unsupported_mcp_elicitation") {
    params.setStatusSafely(
      "Codex declined unsupported MCP elicitation",
      "sending",
    );
    return defaultDecision.response;
  }
  if (!isCodexNativeBuiltInApprovalRequest(params.request)) {
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
    const resolution = await showActionCard(
      params.body,
      requestId,
      action,
      params.request.signal,
      Boolean(params.trace?.noteMcpConfirmationRequired),
    );
    if (params.isCurrent && !params.isCurrent()) {
      return defaultDecision.response;
    }
    params.trace?.noteMcpConfirmationResolved?.(requestId, resolution);
    return buildCodexNativeApprovalResponseFromResolution(
      params.request,
      resolution,
    );
  } catch (error) {
    if (typeof ztoolkit !== "undefined") {
      appLogger.warn(
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

function transferPanelRequest(
  conversationSystem: ConversationSystem | string | null | undefined,
  fromConversationKey: number,
  toConversationKey: number,
  requestId: number,
): boolean {
  if (!transferRequest(fromConversationKey, toConversationKey, requestId)) {
    return false;
  }
  const system = normalizeQueuedInputConversationSystem(conversationSystem);
  transferQueuedFollowUpThreadState(
    buildQueuedFollowUpThreadKey({
      conversationSystem: system,
      conversationKey: fromConversationKey,
    }),
    buildQueuedFollowUpThreadKey({
      conversationSystem: system,
      conversationKey: toConversationKey,
    }),
  );
  return true;
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
    if (ui.inputBox && isPanelWebChatMode(body)) ui.inputBox.disabled = true;
    if (ui.status) setStatus(ui.status, statusText, "sending");
  });
  // History controls are intentionally left enabled so the user can
  // switch conversations or create new ones while a request is in flight.
}

function notifyProviderDispatch(
  body: Element,
  ui: PanelRequestUI,
  item: Zotero.Item,
  ownershipLease?: PanelOperationLease | null,
  callback?: () => void,
): boolean {
  if (ownershipLease && !isPanelOperationLeaseCurrent(ownershipLease)) {
    return false;
  }
  if (!requireCurrentPanelOwnership(body, item, "provider-dispatch")) {
    return false;
  }
  if (ui.inputBox) ui.inputBox.disabled = isPanelWebChatMode(body);
  callback?.();
  return true;
}

function createOwnershipFencedProviderDispatch(params: {
  body: Element;
  item: Zotero.Item;
  lease: PanelOperationLease;
  callback?: () => void;
}): () => void {
  return () => {
    if (
      !isPanelOperationLeaseCurrent(params.lease) ||
      !requireCurrentPanelOwnership(
        params.body,
        params.item,
        "agent-provider-dispatch",
      )
    ) {
      getAbortController(getConversationKey(params.item))?.abort();
      const error = new Error("Panel ownership changed before dispatch");
      error.name = "AbortError";
      throw error;
    }
    params.callback?.();
  };
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

export function isPanelConversationCurrent(
  body: Element,
  item: Zotero.Item,
): boolean {
  const ownershipVerdict = evaluatePanelOwnership(body, item);
  const ownershipRoot = body.querySelector("#llm-main") as HTMLElement | null;
  if (ownershipVerdict !== "match") {
    if (
      ownershipVerdict === "host-mismatch" ||
      (ownershipVerdict === "unresolved" &&
        Boolean(ownershipRoot?.dataset.handlersInitialized))
    ) {
      renderPanelOwnershipBlocked(
        body,
        "render-conversation",
        ownershipVerdict,
      );
    }
    if (
      ownershipVerdict !== "unresolved" ||
      Boolean(ownershipRoot?.dataset.handlersInitialized)
    ) {
      return false;
    }
  }
  const conversationKey = getConversationKey(item);
  const displayedKey = Number(ownershipRoot?.dataset.itemId || 0);
  if (
    Number.isFinite(displayedKey) &&
    displayedKey > 0 &&
    displayedKey !== conversationKey
  ) {
    return false;
  }
  const activeItem = activeContextPanels.get(body)?.() || null;
  return !activeItem || getConversationKey(activeItem) === conversationKey;
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
      unregisterContextPanel(body);
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
    (body) => {
      const box = body.querySelector<HTMLElement>("#llm-chat-box");
      if (box) syncFloatingPlanProgress(box, conversationKey);
      activeContextPanelStateSync.get(body)?.();
    },
  );
}

function setPendingRequestIdAndSync(
  conversationKey: number,
  requestId: number,
  primaryBody?: Element | null,
  primaryItem?: Zotero.Item | null,
  expectedCurrentId?: number,
): void {
  setPendingRequestId(conversationKey, requestId, expectedCurrentId);
  syncRequestUIForConversation(conversationKey, primaryBody, primaryItem);
}

export function beginPanelRequest(
  body: Element,
  item: Zotero.Item,
  statusText = "Preparing attached context…",
): {
  conversationKey: number;
  requestId: number;
  signal: AbortSignal;
} | null {
  if (!requireCurrentPanelOwnership(body, item, "begin-request")) {
    return null;
  }
  const conversationKey = getConversationKey(item);
  const requestId = nextRequestId();
  const AbortControllerCtor = getAbortControllerCtor();
  const abortController = AbortControllerCtor
    ? new AbortControllerCtor()
    : null;
  if (!tryBeginRequest(conversationKey, requestId, abortController)) {
    return null;
  }
  syncRequestUIForConversation(conversationKey, body, item);
  const ui = getPanelRequestUI(body);
  setRequestUIBusy(body, ui, conversationKey, statusText);
  if (ui.inputBox) ui.inputBox.disabled = true;
  return {
    conversationKey,
    requestId,
    signal: abortController ? abortController.signal : INERT_ABORT_SIGNAL,
  };
}

export function finishPanelRequest(
  body: Element,
  item: Zotero.Item,
  conversationKey: number,
  requestId: number,
): boolean {
  if (!finishRequest(conversationKey, requestId)) return false;
  const panelIsCurrent = requireCurrentPanelOwnership(
    body,
    item,
    "finish-request",
  );
  syncRequestUIForConversation(
    conversationKey,
    panelIsCurrent ? body : null,
    panelIsCurrent ? item : null,
  );
  if (panelIsCurrent) {
    restoreRequestUIIdle(body, conversationKey, requestId);
  }
  return true;
}

export function clearPendingRequestIdAndSync(
  conversationKey: number,
  primaryBody?: Element | null,
  primaryItem?: Zotero.Item | null,
  expectedCurrentId?: number,
): boolean {
  if (expectedCurrentId !== undefined) {
    if (!finishRequest(conversationKey, expectedCurrentId)) return false;
    syncRequestUIForConversation(conversationKey, primaryBody, primaryItem);
    return true;
  }
  setPendingRequestIdAndSync(conversationKey, 0, primaryBody, primaryItem);
  return true;
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
  const currentRequestId = getPendingRequestId(conversationKey);
  if (currentRequestId > 0 && currentRequestId !== requestId) return;
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

/**
 * Shared per-turn stream handlers. The send and retry pipelines previously
 * carried hand-synchronized copies of these; they differ only in the small
 * hooks threaded through the params.
 */
function createStreamReasoningHandler(params: {
  assistantMessage: Message;
  flushResponseStream: (reason: BlockStreamFlushReason) => void;
  queueRefresh: () => void;
  /** Retry captures the streamed reasoning for its interruption fallback. */
  onReasoningCaptured?: () => void;
}): (reasoning: ReasoningEvent) => void {
  return (reasoning) => {
    params.flushResponseStream("event");
    if (reasoning.summary) {
      params.assistantMessage.reasoningSummary = appendReasoningPart(
        params.assistantMessage.reasoningSummary,
        reasoning.summary,
      );
    }
    if (reasoning.details) {
      params.assistantMessage.reasoningDetails = appendReasoningPart(
        params.assistantMessage.reasoningDetails,
        reasoning.details,
      );
    }
    params.onReasoningCaptured?.();
    params.queueRefresh();
  };
}

export function resolveUsageContextWindow(params: {
  providerContextWindow?: number;
  providerContextWindowIsAuthoritative?: boolean;
  fallbackContextWindow: number;
  fallbackInputLimitSource: ModelInputTokenLimitSource;
}): {
  contextWindow: number;
  inputLimitSource: ModelInputTokenLimitSource;
  contextWindowIsAuthoritative: boolean;
} {
  const fallbackIsUserAuthoritative =
    params.fallbackInputLimitSource === "advanced" ||
    params.fallbackInputLimitSource === "user";
  if (fallbackIsUserAuthoritative || !params.providerContextWindow) {
    return {
      contextWindow: params.fallbackContextWindow,
      inputLimitSource: params.fallbackInputLimitSource,
      contextWindowIsAuthoritative: false,
    };
  }
  return {
    contextWindow: params.providerContextWindow,
    inputLimitSource: "live",
    contextWindowIsAuthoritative:
      params.providerContextWindowIsAuthoritative === true,
  };
}

export function updateContextUsageSnapshotFromProvider(params: {
  conversationKey: number;
  usage: UsageStats;
  fallbackContextWindow: number;
  fallbackInputLimitSource: ModelInputTokenLimitSource;
}): ContextUsageSnapshot | undefined {
  const contextTokens =
    typeof params.usage.contextTokens === "number" &&
    params.usage.contextTokens > 0
      ? params.usage.contextTokens
      : 0;
  if (contextTokens <= 0) return undefined;
  const resolvedWindow = resolveUsageContextWindow({
    providerContextWindow: params.usage.contextWindow,
    providerContextWindowIsAuthoritative:
      params.usage.contextWindowIsAuthoritative,
    fallbackContextWindow: params.fallbackContextWindow,
    fallbackInputLimitSource: params.fallbackInputLimitSource,
  });
  return setContextUsageSnapshot(params.conversationKey, {
    contextTokens,
    contextWindow: resolvedWindow.contextWindow,
    inputLimitSource: resolvedWindow.inputLimitSource,
    estimated: !resolvedWindow.contextWindowIsAuthoritative,
    source: resolvedWindow.contextWindowIsAuthoritative
      ? "provider"
      : "estimated",
    contextWindowIsAuthoritative: resolvedWindow.contextWindowIsAuthoritative,
    cacheReadTokens: params.usage.cacheReadTokens,
    cacheWriteTokens: params.usage.cacheWriteTokens,
    cacheMissTokens: params.usage.cacheMissTokens,
    cacheHitRatio: params.usage.cacheHitRatio,
    cacheProvider: params.usage.cacheProvider,
  });
}

function createStreamUsageHandler(params: {
  body: Element;
  tokenUsageEl: HTMLElement | null;
  conversationKey: number;
  conversationGeneration?: number;
  contextCache: Parameters<typeof recordContextCacheTelemetry>[0];
  fallbackContextWindow: number;
  fallbackInputLimitSource: ModelInputTokenLimitSource;
  /**
   * Local usage ledger for this turn. Providers report cumulatively, so the
   * recorder folds every callback into one row that the pipeline flushes when
   * the turn settles.
   */
  usageRecorder?: TurnUsageRecorder;
}): (usage: UsageStats) => void {
  return (usage) => {
    if (
      areConversationWritesFrozen(params.conversationKey) ||
      (params.conversationGeneration !== undefined &&
        !isConversationWriteGenerationCurrent(
          params.conversationKey,
          params.conversationGeneration,
        ))
    ) {
      return;
    }
    params.usageRecorder?.record(usage);
    recordContextCacheTelemetry(params.contextCache, usage);
    const snapshot = updateContextUsageSnapshotFromProvider({
      conversationKey: params.conversationKey,
      usage,
      fallbackContextWindow: params.fallbackContextWindow,
      fallbackInputLimitSource: params.fallbackInputLimitSource,
    });
    if (!snapshot) return;
    renderContextUsageSnapshot(params.body, params.tokenUsageEl, snapshot);
  };
}

type CodexNativeTurnCallbacks = Pick<
  Parameters<typeof runCodexAppServerNativeTurn>[0],
  | "eventJournal"
  | "onSkillActivated"
  | "onDelta"
  | "onAgentMessageDelta"
  | "onReasoning"
  | "onUsage"
  | "onItemStarted"
  | "onItemCompleted"
  | "onPlanUpdated"
  | "onPlanDelta"
  | "onPlanArtifact"
  | "onPlanExecutionUpdated"
  | "onMcpToolActivity"
  | "onHostEvent"
  | "onMcpSetupWarning"
  | "onDiagnostics"
  | "onApprovalRequest"
  | "onHostInteraction"
>;

/**
 * The Codex app-server native-turn callback set, previously duplicated
 * verbatim between the send and retry pipelines.
 */
function buildCodexNativeTurnCallbacks(ctx: {
  body: Element;
  item: Zotero.Item;
  assistantMessage: Message;
  codexActivityTrace: ReturnType<
    typeof createCodexNativeActivityTraceController
  > | null;
  flushResponseStream: (reason: BlockStreamFlushReason) => void;
  setStatusSafely: (
    text: string,
    kind: Parameters<typeof setStatus>[2],
  ) => void;
  handleDelta: (delta: string) => void;
  handleReasoning: (reasoning: ReasoningEvent) => void;
  handleUsage: (usage: UsageStats) => void;
  conversationKey: number;
  conversationGeneration: number;
  planContext?: import("../../agent/plans/types").PlanRuntimeContext;
  actionContract?: AgentActionContract;
  classifiedIntent?: import("../../agent/types").ClassifiedTurnIntent;
  skillRoutingReceipt?: import("../../agent/types").AgentRuntimeRequest["skillRoutingReceipt"];
  actionPreparation?: import("../../agent/contracts/actionPreparation").ActionPreparation;
}): CodexNativeTurnCallbacks {
  const {
    body,
    assistantMessage,
    codexActivityTrace,
    flushResponseStream,
    setStatusSafely,
    handleDelta,
    handleReasoning,
    handleUsage,
  } = ctx;
  const executionRequestId = getPendingRequestId(ctx.conversationKey);
  const isLive = () =>
    !areConversationWritesFrozen(ctx.conversationKey) &&
    isConversationWriteGenerationCurrent(
      ctx.conversationKey,
      ctx.conversationGeneration,
    );
  if (ctx.planContext)
    codexActivityTrace?.appendPlanEvent({
      type: "provider_event",
      providerType: "codex_plan_context",
      payload: {
        planContext: ctx.planContext,
        actionContract: ctx.actionContract,
      },
    });
  return {
    eventJournal: createAgentRunEventJournal({
      conversationKey: ctx.conversationKey,
      conversationGeneration: ctx.conversationGeneration,
      model: assistantMessage.modelName,
    }),
    onSkillActivated: (skillId) => {
      if (!isLive()) return;
      flushResponseStream("event");
      codexActivityTrace?.noteSkillActivated(skillId);
      setStatusSafely(`Codex skill activated: ${skillId}`, "sending");
    },
    onDelta: (delta) => {
      if (isLive()) handleDelta(delta);
    },
    onAgentMessageDelta: (event) => {
      if (!isLive()) return;
      if (!codexActivityTrace?.appendAgentMessageDelta(event)) {
        handleDelta(event.delta);
      }
    },
    onReasoning: (reasoning) => {
      if (isLive()) handleReasoning(reasoning);
    },
    onUsage: (usage) => {
      if (isLive()) handleUsage(usage);
    },
    onItemStarted: (event) => {
      if (!isLive()) return;
      flushResponseStream("event");
      codexActivityTrace?.appendItemStatus(event, "started");
      const itemType = sanitizeText(event.type || "");
      if (itemType && !isCodexNativeAgentMessageItem(event)) {
        setStatusSafely(`Codex: ${itemType} started`, "sending");
      }
    },
    onItemCompleted: (event) => {
      if (!isLive()) return;
      flushResponseStream("event");
      codexActivityTrace?.noteAgentMessageCompleted(event);
      codexActivityTrace?.appendItemStatus(event, "completed");
      const itemType = sanitizeText(event.type || "");
      if (itemType && !isCodexNativeAgentMessageItem(event)) {
        setStatusSafely(`Codex: ${itemType} completed`, "sending");
      }
    },
    onPlanDelta: (event) => {
      if (isLive()) handleDelta(event.delta);
    },
    onPlanArtifact: (artifact) => {
      if (!isLive()) return;
      flushResponseStream("event");
      codexActivityTrace?.appendPlanEvent({
        type:
          artifact.status === "awaiting_approval"
            ? "plan_ready"
            : "plan_updated",
        artifact,
      });
    },
    onPlanUpdated: (event) => {
      if (!isLive()) return;
      codexActivityTrace?.appendNativePlanProgress(event.steps);
    },
    onPlanExecutionUpdated: (ledger) => {
      if (!isLive()) return;
      if (assistantMessage.agentRunId)
        recordLivePlanExecution(
          ctx.conversationKey,
          executionRequestId,
          assistantMessage.agentRunId,
          ledger,
        );
      flushResponseStream("event");
      codexActivityTrace?.appendPlanEvent({
        type: "plan_execution_updated",
        ledger,
      });
    },
    onHostEvent: (event) => {
      if (!isLive()) return;
      flushResponseStream("event");
      codexActivityTrace?.appendPlanEvent(event);
    },
    onMcpToolActivity: (event) => {
      if (!isLive()) return;
      flushResponseStream("event");
      codexActivityTrace?.noteMcpToolActivity(event);
      assistantMessage.quoteCitations = mergeQuoteCitations(
        assistantMessage.quoteCitations,
        event.quoteCitations,
      );
      if (event.phase === "completed" && event.ok) {
        void (async () => {
          // The row says which research job it advanced; the panel never asks
          // which tool ran.
          if (event.researchJobId && ctx.planContext?.phase === "executing") {
            const { loadResearchJobForExecution } =
              await import("../../agent/research/store");
            const job = await loadResearchJobForExecution(
              ctx.planContext.executionId,
            );
            if (job) {
              codexActivityTrace?.appendPlanEvent({
                type: "plan_research_progress",
                progress: {
                  researchJobId: job.researchJobId,
                  executionId: job.executionId,
                  parentTaskId: job.parentTaskId,
                  stage: job.activeStage,
                  totalItems: job.totalItems,
                  screenedItems: job.screenedItems,
                  candidateItems: job.candidateItems,
                  deepReadCompleted: job.deepReadCompleted,
                  deepReadPlanned: job.deepReadPlanned,
                  coverageStatus: job.coverageStatus,
                },
              });
            }
          }
        })().catch((error) =>
          appLogger.warn("LLM: Failed to synchronize MCP plan state", error),
        );
      }
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
    onMcpSetupWarning: (message) => {
      if (!isLive()) return;
      flushResponseStream("event");
      setStatusSafely(
        formatCodexZoteroMcpError(
          message,
          "Native conversation MCP setup warning",
        ),
        "error",
      );
    },
    onDiagnostics: (diagnostics) => {
      if (!isLive()) return;
      flushResponseStream("event");
      setStatusSafely(
        formatCodexNativeDiagnosticsStatus(diagnostics),
        "sending",
      );
    },
    onHostInteraction: async (action) => {
      return resolveCodexNativeHostInteractionWithTrace({
        body,
        action,
        trace: codexActivityTrace,
        isCurrent: isLive,
      });
    },
    onApprovalRequest: async (request) => {
      if (!isLive())
        return { approved: false, reason: "conversation_not_live" };
      flushResponseStream("event");
      return resolveCodexNativeApprovalWithOptionalReviewCard({
        body,
        request,
        trace: codexActivityTrace,
        setStatusSafely,
        isCurrent: () =>
          requireCurrentPanelOwnership(body, ctx.item, "agent-confirmation"),
      });
    },
  };
}

export const buildCodexNativeTurnCallbacksForTests =
  buildCodexNativeTurnCallbacks;

async function finalizeCodexPlanExecution(params: {
  planContext?: import("../../agent/plans/types").PlanRuntimeContext;
  answer: string;
  assistantMessage: Message;
  trace: ReturnType<typeof createCodexNativeActivityTraceController> | null;
}): Promise<void> {
  if (params.planContext?.phase !== "executing") return;
  const { loadLatestPlanDocumentForExecution } =
    await import("../../agent/documents/store");
  const document = await loadLatestPlanDocumentForExecution(
    params.planContext.executionId,
  );
  if (document) {
    params.assistantMessage.text = document.visibleMarkdown;
    params.assistantMessage.documentId = document.documentId;
    params.assistantMessage.planDocumentId = document.documentId;
    return;
  }
  const { loadPlanExecutionLedger } = await import("../../agent/plans/store");
  let ledger = await loadPlanExecutionLedger(params.planContext.executionId);
  const active = ledger?.tasks.find(
    (task) => task.taskId === ledger?.activeTaskId,
  );
  const otherRequiredComplete = ledger?.tasks
    .filter(
      (task) => task.kind === "required_step" && task.taskId !== active?.taskId,
    )
    .every((task) => task.status === "completed" || task.status === "skipped");
  if (active?.expectedEffect === "reasoning" && otherRequiredComplete) {
    ledger = await planExecutionCoordinator.attachEvidence({
      version: 1,
      evidenceId: `${ledger!.executionId}:${active.taskId}:reasoning:codex-final`,
      executionId: ledger!.executionId,
      taskId: active.taskId,
      kind: "reasoning_assertion",
      verified: true,
      summary: sanitizeText(params.answer).slice(0, 2000),
      reference: `codex:${params.assistantMessage.agentRunId || params.assistantMessage.timestamp}:final`,
      createdAt: Date.now(),
    });
    ledger = await planExecutionCoordinator.requestTransition({
      executionId: ledger.executionId,
      taskId: active.taskId,
      toStatus: "completed",
      requestedBy: "codex",
      reason: "Bounded final reasoning assertion",
    });
    params.trace?.appendPlanEvent({
      type: "plan_execution_updated",
      ledger,
    });
  }
  await planExecutionCoordinator.assertCanFinalize(
    params.planContext.executionId,
  );
}

function createPanelUpdateHelpers(
  body: Element,
  item: Zotero.Item,
  conversationKey: number,
  ui: PanelRequestUI,
): {
  refreshChatSafely: () => void;
  refreshAssistantMessageSafely: (message: Message) => void;
  refreshCompletedAssistantTurnSafely: (message: Message) => void;
  setStatusSafely: (
    text: string,
    kind: Parameters<typeof setStatus>[2],
  ) => void;
} {
  const refreshChatSafely = () => {
    refreshConversationPanels(body, item);
  };
  const refreshAssistantMessageSafely = (message: Message) => {
    refreshConversationPanels(body, item, {
      chatOptions: { rerenderAssistantMessages: new Set([message]) },
    });
  };
  /**
   * Turn completion rebuilds the finished answer and its prompt's controls.
   * refreshChat also updates earlier prompts' editability in place, preserving
   * historical answer DOM. Panels missing the pair fall back to a full rebuild.
   */
  const refreshCompletedAssistantTurnSafely = (message: Message) => {
    const history = chatHistory.get(conversationKey) || [];
    const messageIndex = history.indexOf(message);
    const turnMessages = new Set<Message>([message]);
    const pairedUserMessage =
      messageIndex > 0 ? history[messageIndex - 1] : undefined;
    if (pairedUserMessage?.role === "user") turnMessages.add(pairedUserMessage);
    refreshConversationPanels(body, item, {
      chatOptions: { rerenderAssistantMessages: turnMessages },
    });
  };
  const setStatusSafely = (
    text: string,
    kind: Parameters<typeof setStatus>[2],
  ) => {
    setStatusForConversationPanels(conversationKey, body, item, ui, text, kind);
  };
  return {
    refreshChatSafely,
    refreshAssistantMessageSafely,
    refreshCompletedAssistantTurnSafely,
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

export function resolveEffectiveRequestConfig(params: {
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
  if (params.authMode === "webchat" || params.providerProtocol === "web_sync") {
    return {
      model: (params.model || "chatgpt.com").trim() || "chatgpt.com",
      apiBase: "",
      apiKey: "",
      authMode: "webchat",
      providerProtocol: "web_sync",
      modelEntryId: params.modelEntryId,
      modelProviderLabel: params.modelProviderLabel,
      reasoning: undefined,
      advanced: undefined,
    };
  }

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
    : getSelectedModelEntry();
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
  const webChatRequest =
    authMode === "webchat" || providerProtocol === "web_sync";
  const advanced = webChatRequest
    ? undefined
    : params.advanced || explicitEntry?.advanced || fallbackEntry?.advanced;
  const reasoning = webChatRequest
    ? undefined
    : params.reasoning ||
      getSelectedReasoningForItem(
        params.item.id,
        model,
        apiBase,
        providerProtocol,
        advanced?.profileOverride,
      );
  return {
    model,
    apiBase: webChatRequest ? "" : apiBase,
    apiKey: webChatRequest ? "" : apiKey,
    authMode: webChatRequest ? "webchat" : authMode,
    providerProtocol: webChatRequest ? "web_sync" : providerProtocol,
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
        historyTexts: (params.requestParams.history || []).map((message) =>
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content ?? ""),
        ),
        combinedContext: params.combinedContext,
        strategy: params.contextPlan.strategy,
        systemMessages,
        inputCap: {
          limitTokens: finalPrepared.inputCap.limitTokens,
          limitSource: finalPrepared.inputCap.limitSource,
          estimatedAfterTokens: finalPrepared.inputCap.estimatedAfterTokens,
        },
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
    (params.pdfPaperContexts || []).map((paper) =>
      completePaperContextKey(paper, params.item.libraryID),
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
      completePaperContextKey(autoLoaded, params.item.libraryID),
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
          (p) =>
            !pdfModePaperKeys.has(
              completePaperContextKey(p, params.item.libraryID),
            ),
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
    const semanticEnabled = resolveSemanticSearchState().enabled;
    const semanticTag =
      plan.mode === "retrieval" && semanticEnabled ? " + semantic search" : "";
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
  appLogger.debug("LLM: Multi-context plan", {
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

const queuedPanelRefreshes = new WeakMap<
  Element,
  Set<ReturnType<typeof createCoalescedFrameScheduler>>
>();
type QueuedRefresh = (() => void) & { flush: () => void };

function createQueuedRefresh(
  refresh: () => void,
  body?: Element,
): QueuedRefresh {
  const scheduler = createCoalescedFrameScheduler({
    getWindow: () =>
      body?.ownerDocument?.defaultView || Zotero.getMainWindow?.(),
    run: () => {
      if (body) queuedPanelRefreshes.get(body)?.delete(scheduler);
      if (!body || body.isConnected) refresh();
    },
  });
  const schedule = () => {
    if (body) {
      let pending = queuedPanelRefreshes.get(body);
      if (!pending) {
        pending = new Set();
        queuedPanelRefreshes.set(body, pending);
      }
      pending.add(scheduler);
    }
    scheduler.schedule();
  };
  schedule.flush = () => scheduler.flush();
  return schedule;
}

export function disposeChatRendering(body: Element): void {
  for (const scheduler of queuedPanelRefreshes.get(body) || [])
    scheduler.cancel();
  queuedPanelRefreshes.delete(body);
  const box = body.querySelector<HTMLDivElement>("#llm-chat-box");
  if (!box) return;
  disposeChatScrollViewport(box);
  for (const view of mountedAssistantViews.get(box)?.values() || []) {
    if (view.trace) disposeAgentTrace(view.trace);
    if (view.answer) disposeStreamingMarkdown(view.answer);
  }
  mountedAssistantViews.delete(box);
  for (const root of Array.from(
    box.querySelectorAll<HTMLElement>(".llm-plan-container-execution"),
  )) {
    if (root) disposePlanProgress(root as HTMLElement);
  }
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
  | "interrupted"
  | "completionStatus"
  | "completionReason"
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
    interrupted: message.interrupted,
    completionStatus: message.completionStatus,
    completionReason: message.completionReason,
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
  message.interrupted = snapshot.interrupted;
  message.completionStatus = snapshot.completionStatus;
  message.completionReason = snapshot.completionReason;
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
  message.interrupted = undefined;
  message.completionStatus = undefined;
  message.completionReason = undefined;
  message.webchatRunState = undefined;
  message.webchatCompletionReason = null;
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
  | "cancelled"
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
    import("../../services/attachmentStorage"),
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
      import("../../services/attachmentStorage"),
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
  activePaperContext?: PaperContextRef;
} {
  const itemLibraryID = Math.floor(Number(item.libraryID)) || 0;
  const withRequestLibrary = (paper: PaperContextRef): PaperContextRef =>
    paper.libraryID || !itemLibraryID
      ? paper
      : { ...paper, libraryID: itemLibraryID };
  const normalizedPaperContexts =
    normalizePaperContexts(paperContexts).map(withRequestLibrary);
  const normalizedFullTextPaperContexts = normalizePaperContexts(
    fullTextPaperContexts,
  ).map(withRequestLibrary);
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
  const activePaperContext: PaperContextRef = {
    ...autoLoadedPaperContext,
    libraryID:
      Math.floor(Number(autoLoadedPaperContext.libraryID || item.libraryID)) ||
      undefined,
  };
  // Always include auto-loaded paper in paperContexts (for display in chat history).
  // Only add to fullTextPaperContexts if NOT in PDF mode.
  const autoKey = completePaperContextKey(activePaperContext, itemLibraryID);
  const isExcludedFromTextPipeline = excludePaperKeys?.has(autoKey) === true;
  return {
    paperContexts: isExcludedFromTextPipeline
      ? normalizedPaperContexts
      : normalizePaperContexts([
          activePaperContext,
          ...normalizedPaperContexts,
        ]),
    fullTextPaperContexts: isExcludedFromTextPipeline
      ? limitFullTextPaperContexts(normalizedFullTextPaperContexts)
      : fullTextPaperContexts === undefined
        ? limitFullTextPaperContexts(
            normalizePaperContexts([
              activePaperContext,
              ...normalizedFullTextPaperContexts,
            ]),
          )
        : limitFullTextPaperContexts(normalizedFullTextPaperContexts),
    activePaperContext,
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

  initializedConversationComposeContextKeys.add(conversationKey);
  activeContextPanelStateSync.get(body)?.();
}

export async function editLatestUserMessageAndRetry(
  opts: import("./types").EditRetryOptions,
): Promise<EditLatestTurnResult> {
  const {
    body,
    item,
    requestId,
    onProviderDispatch,
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
  const initialConversationKey = getConversationKey(item);
  if (requestId !== undefined) {
    if (!isRequestOwner(initialConversationKey, requestId)) return "stale";
  }
  await ensureConversationLoaded(item);
  const conversationKey = getConversationKey(item);
  if (requestId !== undefined) {
    if (
      conversationKey !== initialConversationKey &&
      !transferPanelRequest(
        resolveConversationSystemForItem(item),
        initialConversationKey,
        conversationKey,
        requestId,
      )
    ) {
      return "stale";
    }
  }
  const requestIsActive = () =>
    requestId === undefined ||
    (isRequestOwner(conversationKey, requestId) &&
      getCancelledRequestId(conversationKey) < requestId &&
      !getAbortController(conversationKey)?.signal.aborted);
  if (!requestIsActive()) return "stale";
  // Retry must act on the state the user SEES: complete any pending turn
  // deletion first so the hidden turn cannot be the retry target. finalize is
  // best-effort and time-boxed — on failure or timeout the turn stays queued,
  // so select the target from the filtered (user-visible) view.
  if (!(await pendingDeletionStore.ensurePersistedFenceLoaded()))
    return "stale";
  if (!requestIsActive()) return "stale";
  await awaitPendingTurnFinalize(
    pendingDeletionStore.finalizeTurnsForConversation(conversationKey, "retry"),
  );
  if (!requestIsActive()) return "stale";
  // A whole-conversation deletion is an identity fence. Editing/retrying may
  // not turn user activity into an implicit Undo; only the explicit Undo
  // action can withdraw the six-second intent.
  if (pendingDeletionStore.isConversationPendingDeletion(conversationKey)) {
    return "stale";
  }
  const history = filterMessagesInPendingTurns(
    conversationKey,
    chatHistory.get(conversationKey) || [],
  );
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
    normalizedPdfPaperContexts.map((paper) =>
      completePaperContextKey(paper, item.libraryID),
    ),
  );
  const autoLoadedPaperContext = includeAutoLoadedPaperContext(
    item,
    normalizedPaperContexts,
    normalizedFullTextPaperContexts,
    pdfExcludeKeys.size > 0 ? pdfExcludeKeys : undefined,
    contextSource,
  );
  let paperContextsForMessage = autoLoadedPaperContext.paperContexts;
  let fullTextPaperContextsForMessage =
    autoLoadedPaperContext.fullTextPaperContexts;
  const activePaperContext = autoLoadedPaperContext.activePaperContext;
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
    if (!requestIsActive()) return "stale";
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

  const conversationGeneration =
    getConversationWriteGeneration(conversationKey);
  try {
    await updateStoredLatestUserMessageByConversation(
      conversationKey,
      {
        conversationGeneration,
        text: retryPair.userMessage.text,
        timestamp: retryPair.userMessage.timestamp,
        runMode: retryPair.userMessage.runMode,
        agentRunId: retryPair.userMessage.agentRunId,
        selectedText: retryPair.userMessage.selectedText,
        selectedTextContexts: retryPair.userMessage.selectedTextContexts,
        selectedTexts: retryPair.userMessage.selectedTexts || [],
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
      conversationGeneration,
    );
  } catch (err) {
    appLogger.warn("LLM: Failed to persist edited latest user message", err);
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
          requestId,
          onProviderDispatch,
          activePaperContext,
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
          requestId,
          onProviderDispatch,
        );
  if (!retrySucceeded) {
    // A deliberate Stop during retry preparation bails with a falsy result;
    // report it as a cancel, not a failure — the prompt edit itself was saved.
    return requestId !== undefined &&
      getCancelledRequestId(conversationKey) >= requestId
      ? "cancelled"
      : "retry-failed";
  }
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
  requestId?: number,
  onProviderDispatch?: () => void,
  retryOptions?: { continueIncomplete?: boolean },
) {
  const ownershipLease = capturePanelOperationLease(body);
  if (
    !ownershipLease ||
    !requireCurrentPanelOwnership(body, item, "retry-response")
  ) {
    return;
  }
  const ui = getPanelRequestUI(body);
  const initialConversationKey = getConversationKey(item);
  let thisRequestId: number;
  if (requestId !== undefined) {
    thisRequestId = requestId;
    if (!isRequestOwner(initialConversationKey, thisRequestId)) return;
    setRequestUIBusy(body, ui, initialConversationKey, "Preparing retry...");
  } else {
    const claimed = beginPanelRequest(body, item, "Preparing retry...");
    if (!claimed) return;
    thisRequestId = claimed.requestId;
  }

  try {
    await ensureConversationLoaded(item);
  } catch (error) {
    finishPanelRequest(body, item, initialConversationKey, thisRequestId);
    throw error;
  }
  const conversationKey = getConversationKey(item);
  if (
    conversationKey !== initialConversationKey &&
    !transferPanelRequest(
      resolveConversationSystemForItem(item),
      initialConversationKey,
      conversationKey,
      thisRequestId,
    )
  ) {
    finishPanelRequest(body, item, initialConversationKey, thisRequestId);
    return;
  }
  const requestIsActive = () =>
    isRequestOwner(conversationKey, thisRequestId) &&
    getCancelledRequestId(conversationKey) < thisRequestId &&
    !getAbortController(conversationKey)?.signal.aborted &&
    isPanelOperationLeaseCurrent(ownershipLease) &&
    requireCurrentPanelOwnership(body, item, "retry-response-continuation");
  const releaseRequest = () => {
    if (!finishPanelRequest(body, item, conversationKey, thisRequestId)) {
      return false;
    }
    scheduleQueuedInputDrain(body, {
      conversationSystem: resolveConversationSystemForItem(item) || "upstream",
      conversationKey,
    });
    return true;
  };
  if (!requestIsActive()) {
    releaseRequest();
    return;
  }
  // Retry must act on the state the user SEES: complete any pending turn
  // deletion first so the hidden turn cannot be the retry target. finalize is
  // best-effort and time-boxed — on failure or timeout the turn stays queued,
  // so select the target and build the prompt from the filtered
  // (user-visible) view.
  if (!(await pendingDeletionStore.ensurePersistedFenceLoaded())) {
    releaseRequest();
    return "stale";
  }
  if (!requestIsActive()) {
    releaseRequest();
    return;
  }
  await awaitPendingTurnFinalize(
    pendingDeletionStore.finalizeTurnsForConversation(conversationKey, "retry"),
  );
  if (!requestIsActive()) {
    releaseRequest();
    return;
  }
  // Retry cannot cancel a whole-conversation deletion. Only explicit Undo can
  // withdraw that intent while its own window is still open.
  if (pendingDeletionStore.isConversationPendingDeletion(conversationKey)) {
    if (ui.status) {
      setStatus(ui.status, t("Deletion pending; retrying safely"), "warning");
    }
    releaseRequest();
    return;
  }
  const history = filterMessagesInPendingTurns(
    conversationKey,
    chatHistory.get(conversationKey) || [],
  );
  const retryPair = findLatestRetryPair(history);
  if (!retryPair) {
    if (ui.status) setStatus(ui.status, "No retryable response found", "error");
    releaseRequest();
    return;
  }
  const conversationGeneration = getConversationWriteGeneration(
    getConversationKey(item),
  );
  const retryTraceEvents =
    retryPair.assistantMessage.pendingAgentTraceEvents ||
    (retryPair.assistantMessage.agentRunId
      ? (await getAgentRunTrace(retryPair.assistantMessage.agentRunId)).events
      : []);
  const retryPlanEvent = retryTraceEvents
    .map((event) => event.payload)
    .find(
      (event) =>
        event.type === "provider_event" &&
        event.providerType === "codex_plan_context",
    );
  const retryPlanContext =
    retryPlanEvent?.type === "provider_event"
      ? (retryPlanEvent.payload?.planContext as
          | import("../../agent/plans/types").PlanRuntimeContext
          | undefined)
      : undefined;
  const retryActionContract =
    retryPlanEvent?.type === "provider_event"
      ? (retryPlanEvent.payload?.actionContract as
          | AgentActionContract
          | undefined)
      : undefined;

  const assistantMessage = retryPair.assistantMessage;
  let codexActivityTrace: CodexNativeActivityTraceController | null = null;
  const assistantSnapshot = takeAssistantSnapshot(assistantMessage);
  const continueIncomplete = Boolean(
    retryOptions?.continueIncomplete &&
    assistantSnapshot.completionStatus === "incomplete" &&
    assistantSnapshot.completionReason === "output_limit",
  );
  // The retry rewrites (and later persists) the paired user row's model
  // identity and rebuilt contexts before any output exists. A failed retry
  // that restores the previous answer must roll the user row back with it,
  // or the stored turn pairs the old answer with the failed retry's metadata.
  const userSnapshot = takeRetryUserSnapshot(retryPair.userMessage);
  assistantMessage.text = continueIncomplete ? assistantSnapshot.text : "";
  assistantMessage.interrupted = undefined;
  assistantMessage.completionStatus = undefined;
  assistantMessage.completionReason = undefined;
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
  const {
    refreshChatSafely,
    refreshAssistantMessageSafely,
    refreshCompletedAssistantTurnSafely,
    setStatusSafely,
  } = createPanelUpdateHelpers(body, item, conversationKey, ui);
  // [webchat] Retries never route through the browser-relay pipeline, so a
  // webchat model here — passed explicitly by the retry-model menu or picked
  // up from the selected profile when params were empty — would fire a
  // generic HTTP request with the rebuilt conversation and persist
  // webchat-attributed rows into a real, visible conversation. Gate on the
  // RESOLVED config so both routes are refused; the turn was already reset
  // for streaming above, so restore both snapshots before bailing.
  if (
    effectiveRequestConfig.authMode === "webchat" ||
    effectiveRequestConfig.providerProtocol === "web_sync"
  ) {
    restoreAssistantSnapshot(assistantMessage, assistantSnapshot);
    restoreRetryUserSnapshot(retryPair.userMessage, userSnapshot);
    refreshChatSafely();
    setStatusSafely(t("WebChat models can't retry local turns"), "error");
    releaseRequest();
    return;
  }

  const historyForLLM = history.slice(
    0,
    continueIncomplete ? retryPair.userIndex + 2 : retryPair.userIndex,
  );
  const retrySelectedTextContexts = synthesizeSelectedTextContexts({
    selectedTextContexts: retryPair.userMessage.selectedTextContexts,
    selectedTexts: retryPair.userMessage.selectedTexts || [],
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
  if (!requestIsActive()) {
    restoreAssistantSnapshot(assistantMessage, assistantSnapshot);
    restoreRetryUserSnapshot(retryPair.userMessage, userSnapshot);
    refreshChatSafely();
    releaseRequest();
    return;
  }
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
    // Webchat retries are refused by the gate above, and no other provider
    // wants inline anchor context in the rebuilt payload.
    includeAnchorContext: false,
  });
  const dispatchQuestion = continueIncomplete
    ? "Continue from the incomplete response. Resume exactly where it stopped, do not repeat prior text, and finish the answer."
    : question;
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
    if (!requestIsActive()) {
      restoreAssistantSnapshot(assistantMessage, assistantSnapshot);
      restoreRetryUserSnapshot(retryPair.userMessage, userSnapshot);
      refreshChatSafely();
      releaseRequest();
      return;
    }
    retryPaperContexts = enrichedPaperContexts || retryPaperContexts;
    retryFullTextPaperContexts =
      enrichedFullTextPaperContexts || retryFullTextPaperContexts;
  }
  if (!question.trim()) {
    // The assistant bubble was already reset for streaming and the user
    // contexts rewritten — put the turn back or it stays stuck as an empty
    // streaming message that blocks every later retry/edit.
    restoreAssistantSnapshot(assistantMessage, assistantSnapshot);
    restoreRetryUserSnapshot(retryPair.userMessage, userSnapshot);
    refreshChatSafely();
    setStatusSafely("Nothing to retry for latest turn", "error");
    releaseRequest();
    return;
  }

  refreshChatSafely();
  // Streaming flushes only mutate this assistant message, so re-render just
  // its bubble; refreshChat falls back to a full rebuild if the wrapper is
  // not in the DOM yet.
  const streamingResponse = createStreamingResponse({
    message: assistantMessage,
    refreshMessage: () => refreshAssistantMessageSafely(assistantMessage),
    createQueuedRefresh: (refresh) => createQueuedRefresh(refresh, body),
  });
  let streamedReasoningSummary: string | undefined;
  let streamedReasoningDetails: string | undefined;
  // Local usage ledger for this retry. A retry's tokens are real and are
  // recorded, but the question was already counted when it was first asked.
  let usageFlushReason: UsageTurnFlushReason = "complete";
  const usageRecorder = createTurnUsageRecorder({
    conversationKey,
    conversationGeneration,
    countsAsQuestion: false,
    runtime: isCodexNativeTurn ? "codex" : "chat",
    model: effectiveRequestConfig.model,
    provider: effectiveRequestConfig.modelProviderLabel,
  });

  const restoreOriginalTurn = () => {
    streamingResponse.rollback();
    restoreAssistantSnapshot(assistantMessage, assistantSnapshot);
    restoreRetryUserSnapshot(retryPair.userMessage, userSnapshot);
    refreshChatSafely();
  };
  const stopRetryPreparation = () => {
    if (requestIsActive()) return false;
    restoreOriginalTurn();
    releaseRequest();
    return true;
  };
  // Writes the user row as it currently stands in memory. Called once before
  // the request goes out, and again after restoreOriginalTurn on a
  // zero-output failure so the stored row rolls back with the answer.
  const persistRetryUserRow = async () => {
    await updateStoredLatestUserMessageByConversation(
      conversationKey,
      {
        conversationGeneration,
        text: retryPair.userMessage.text,
        timestamp: retryPair.userMessage.timestamp,
        runMode: retryPair.userMessage.runMode,
        agentRunId: retryPair.userMessage.agentRunId,
        selectedText: retryPair.userMessage.selectedText,
        selectedTextContexts: retryPair.userMessage.selectedTextContexts,
        selectedTexts: retryPair.userMessage.selectedTexts || [],
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
  };
  const finalizeCancelledAssistant = async () => {
    streamingResponse.flush("cancel");
    // The turn never reached finish(), so the trace's own buffers are still
    // holding commentary the model sent. Deliver it before the store write.
    codexActivityTrace?.flushBufferedProgress("cancel");
    finalizeCancelledAssistantMessage(assistantMessage);
    await codexActivityTrace?.persist(
      conversationKey,
      conversationGeneration,
      "cancelled",
    );
    refreshChatSafely();
    const latestContextSnapshot = contextUsageSnapshots.get(conversationKey);
    await updateStoredLatestAssistantMessageByConversation(
      conversationKey,
      {
        conversationGeneration,
        text: assistantMessage.text,
        timestamp: assistantMessage.timestamp,
        runMode: assistantMessage.runMode,
        agentRunId: assistantMessage.agentRunId,
        documentId: assistantMessage.documentId,
        planDocumentId: assistantMessage.planDocumentId,
        interrupted: assistantMessage.interrupted,
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
      restoreOriginalTurn();
      releaseRequest();
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
    if (stopRetryPreparation()) return;
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
    restoreOriginalTurn();
    releaseRequest();
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
    if (stopRetryPreparation()) return;
    if (
      retryLocalDocuments?.length &&
      effectiveConversationSystem === "claude_code"
    ) {
      await preflightClaudeBridgeLocalPdfCapability();
      if (stopRetryPreparation()) return;
    }
    const llmHistory = buildLLMHistoryMessages(historyForLLM);
    const recentPaperContexts = collectRecentPaperContexts(historyForLLM);
    if (effectiveConversationSystem === "upstream") {
      await preflightRequestModelCapabilities({
        prompt: question,
        model: effectiveRequestConfig.model,
        apiBase: effectiveRequestConfig.apiBase,
        apiKey: effectiveRequestConfig.apiKey,
        authMode: effectiveRequestConfig.authMode,
        providerProtocol: effectiveRequestConfig.providerProtocol,
        profileOverride: effectiveRequestConfig.advanced?.profileOverride,
      });
      if (stopRetryPreparation()) return;
    }

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
    if (stopRetryPreparation()) return;
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
    await persistRetryUserRow();
    if (getCancelledRequestId(conversationKey) >= thisRequestId) {
      getAbortController(conversationKey)?.abort();
      await finalizeCancelledAssistant();
      return;
    }

    const queueRefresh = streamingResponse.queueRefresh;
    codexActivityTrace = isCodexNativeTurn
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
      prompt: dispatchQuestion,
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
      outputTokenLimit: effectiveRequestConfig.advanced?.outputTokenLimit,
      inputTokenCap: effectiveRequestConfig.advanced?.inputTokenCap,
      profileOverride: effectiveRequestConfig.advanced?.profileOverride,
      inputMode: effectiveRequestConfig.advanced?.inputMode,
      contextCache: contextPlan.contextCache,
      requestScope: createProviderRequestScope(conversationKey),
    };
    const { finalPrepared, systemMessages, workflowTestIntercepted } =
      await prepareFinalContextPlanChatRequest({
        requestParams,
        contextPlan,
        combinedContext,
      });
    if (stopRetryPreparation()) return;
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
      inputLimitSource: finalPrepared.inputCap.limitSource,
      estimated: true,
      source: "estimated",
    });
    renderContextUsageSnapshot(body, ui.tokenUsageEl, estimatedContextSnapshot);

    streamingResponse.start();
    const handleReasoning = createStreamReasoningHandler({
      assistantMessage,
      flushResponseStream: streamingResponse.flush,
      queueRefresh,
      onReasoningCaptured: () => {
        streamedReasoningSummary = assistantMessage.reasoningSummary;
        streamedReasoningDetails = assistantMessage.reasoningDetails;
      },
    });
    const handleUsage = createStreamUsageHandler({
      body,
      tokenUsageEl: ui.tokenUsageEl,
      conversationKey,
      conversationGeneration,
      contextCache: contextPlan.contextCache,
      fallbackContextWindow: finalPrepared.inputCap.limitTokens,
      fallbackInputLimitSource: finalPrepared.inputCap.limitSource,
      usageRecorder,
    });
    const codexScope = isCodexNativeTurn
      ? await enrichCodexNativeConversationScopeWithMineruCache(
          resolveCodexNativeConversationScope({
            item,
            conversationKey,
            title: question,
          }),
        )
      : null;
    const codexExecutionRequest = isCodexNativeTurn
      ? await initAgentSubsystem().then(async (runtime) =>
          runtime.prepareExecutionRequest(
            await buildAgentRuntimeRequest({
              conversationKey,
              conversationGeneration,
              sourceMessageTimestamp: retryPair.userMessage.timestamp,
              item,
              userText: question,
              selectedTextContexts: retrySelectedTextContexts,
              resolvedSelectedTextAnchors: retryResolvedSelectedTextAnchors,
              selectedTexts: retryPair.userMessage.selectedTexts || [],
              selectedTextSources: retryPair.userMessage.selectedTextSources,
              selectedTextPaperContexts:
                retryPair.userMessage.selectedTextPaperContexts,
              selectedTextNoteContexts:
                retryPair.userMessage.selectedTextNoteContexts,
              paperContexts: contextPlan.paperContexts,
              pdfPaperContexts: retryPair.userMessage.pdfPaperContexts,
              fullTextPaperContexts: contextPlan.fullTextPaperContexts,
              citationPaperContexts:
                retryPair.userMessage.citationPaperContexts,
              selectedCollectionContexts,
              selectedTagContexts,
              attachments,
              localDocuments: retryLocalDocuments,
              screenshots: allImages,
              forcedSkillIds: retryPair.userMessage.forcedSkillIds,
              effectiveRequestConfig,
              history: llmHistory,
            }),
            {
              signal: getAbortController(conversationKey)?.signal,
              permissionOwner: "external_runtime",
            },
          ),
        )
      : undefined;
    if (stopRetryPreparation()) return;
    if (
      !notifyProviderDispatch(
        body,
        ui,
        item,
        ownershipLease,
        onProviderDispatch,
      )
    )
      return;
    // The request is going out: from here the provider bills whatever it
    // produces, including on abort, so the turn owes a usage row.
    usageRecorder.markDispatched();
    const modelOutcome: ModelTurnOutcome = isCodexNativeTurn
      ? await (async () => {
          const result = await runCodexAppServerNativeTurn({
            executionRequest: codexExecutionRequest!,
            scope: codexScope!,
            conversationGeneration,
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
              selectedTexts: retryPair.userMessage.selectedTexts || [],
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
            ...buildCodexNativeTurnCallbacks({
              body,
              item,
              assistantMessage,
              codexActivityTrace,
              flushResponseStream: streamingResponse.flush,
              setStatusSafely,
              handleDelta: streamingResponse.push,
              handleReasoning,
              handleUsage,
              conversationKey,
              conversationGeneration,
              planContext: retryPlanContext,
              actionContract: retryActionContract,
            }),
          });
          assistantMessage.agentRunId = result.agentRunId;
          if (result.documentId) {
            assistantMessage.documentId = result.documentId;
          }
          await finalizeCodexPlanExecution({
            planContext: retryPlanContext,
            answer: result.text,
            assistantMessage,
            trace: codexActivityTrace,
          });
          return {
            text:
              retryPlanContext?.phase === "planning"
                ? "The plan is ready for review."
                : result.text,
            completion: { status: "complete" as const },
          };
        })()
      : await callDirectChatTurnWithRecovery({
          request: {
            ...requestParams,
            systemMessages,
          },
          onDelta: streamingResponse.push,
          onReasoning: handleReasoning,
          onUsage: handleUsage,
        });

    if (
      getCancelledRequestId(conversationKey) >= thisRequestId ||
      Boolean(getAbortController(conversationKey)?.signal.aborted)
    ) {
      usageFlushReason = "abort";
      await finalizeCancelledAssistant();
      return;
    }

    streamingResponse.flush("final");
    const hasGeneratedOutput = normalizeGeneratedChatImages(
      assistantMessage.generatedImages,
    ).length;
    const outputLimited =
      modelOutcome.completion.status === "incomplete" &&
      modelOutcome.completion.reason === "output_limit";
    const responseText =
      sanitizeText(modelOutcome.text) ||
      streamingResponse.getStreamedText() ||
      "";
    const visibleResponseText = continueIncomplete
      ? appendContinuationText(assistantSnapshot.text, responseText)
      : responseText;
    assistantMessage.text =
      (assistantMessage.documentId || assistantMessage.planDocumentId
        ? assistantMessage.text
        : visibleResponseText) ||
      (hasGeneratedOutput
        ? ""
        : outputLimited
          ? EMPTY_OUTPUT_LIMIT_MESSAGE
          : resolveEmptyModelOutcomeMessage(modelOutcome.completion));
    assistantMessage.completionStatus = modelOutcome.completion.status;
    assistantMessage.completionReason =
      "reason" in modelOutcome.completion
        ? modelOutcome.completion.reason
        : undefined;
    await finalizeAssistantMessageQuoteCitations(assistantMessage, {
      pairedUserMessage: retryPair.userMessage,
      paperContexts: contextPlan.paperContexts,
      fullTextPaperContexts: contextPlan.fullTextPaperContexts,
      citationPaperContexts: contextPlan.citationPaperContexts,
      conversationKey,
    });
    codexActivityTrace?.finish(assistantMessage.text);
    await codexActivityTrace?.persist(conversationKey, conversationGeneration);
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
    assistantMessage.interrupted = undefined;
    assistantMessage.streaming = false;
    refreshCompletedAssistantTurnSafely(assistantMessage);

    const latestContextSnapshot = contextUsageSnapshots.get(conversationKey);
    await updateStoredLatestAssistantMessageByConversation(
      conversationKey,
      {
        conversationGeneration,
        text: assistantMessage.text,
        timestamp: assistantMessage.timestamp,
        runMode: assistantMessage.runMode,
        agentRunId: assistantMessage.agentRunId,
        documentId: assistantMessage.documentId,
        planDocumentId: assistantMessage.planDocumentId,
        interrupted: assistantMessage.interrupted,
        completionStatus: assistantMessage.completionStatus,
        completionReason: assistantMessage.completionReason,
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
    usageFlushReason = isCancelled ? "abort" : "error";
    if (isCancelled) {
      await finalizeCancelledAssistant();
      return;
    }

    const technicalErrMsg = (err as Error).message || "Error";
    const errMsg = isCodexNativeTurn
      ? formatCodexZoteroMcpError(err, "Native conversation retry failed")
      : technicalErrMsg;
    const retryHint = resolveMultimodalRetryHint(
      errMsg,
      screenshotImages.length,
    );
    // Preserve whatever streamed during the retry before the drop. Only fall
    // back to restoring the previous answer when nothing new streamed. The
    // message-text fallback covers content that was flushed out of a
    // stream torn down before the throw (same chain as the send path).
    const partialText = sanitizeText(
      streamingResponse.getStreamedText() || assistantMessage.text || "",
    );
    streamingResponse.dispose();
    const outcome = resolveStreamInterruptionOutcome({
      partialText,
      errorMessage: errMsg,
      retryHint,
    });
    if (outcome.interrupted) {
      assistantMessage.text = outcome.text;
      assistantMessage.interrupted = true;
      assistantMessage.timestamp = Date.now();
      assistantMessage.modelName = effectiveRequestConfig.model;
      assistantMessage.modelEntryId = effectiveRequestConfig.modelEntryId;
      assistantMessage.modelProviderLabel =
        effectiveRequestConfig.modelProviderLabel;
      assistantMessage.reasoningSummary = streamedReasoningSummary;
      assistantMessage.reasoningDetails = streamedReasoningDetails;
      assistantMessage.reasoningOpen = isReasoningExpandedByDefault();
      assistantMessage.streaming = false;
      codexActivityTrace?.flushBufferedProgress("cancel");
      await codexActivityTrace?.persist(
        conversationKey,
        conversationGeneration,
      );
      refreshChatSafely();
      const latestContextSnapshot = contextUsageSnapshots.get(conversationKey);
      await updateStoredLatestAssistantMessageByConversation(
        conversationKey,
        {
          conversationGeneration,
          text: assistantMessage.text,
          timestamp: assistantMessage.timestamp,
          runMode: assistantMessage.runMode,
          agentRunId: assistantMessage.agentRunId,
          interrupted: assistantMessage.interrupted,
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
    } else {
      restoreOriginalTurn();
      // The user row was already persisted with the failed retry's model and
      // contexts before the request went out — write the restored values back
      // so the stored turn stays a consistent pair.
      await persistRetryUserRow();
    }
    setStatusSafely(
      `Retry failed: ${`${errMsg}${retryHint}`.slice(0, 48)}`,
      "error",
    );
  } finally {
    // The turn is over on every path through this flow, including the
    // interrupted and failed ones: the trace controller must stop here or a
    // buffered flush lands on a message that was already persisted.
    codexActivityTrace?.dispose();
    // Every path through this flow -- completion, error, abort -- ends here,
    // so this is where the one usage row for the turn is written. It never
    // throws and is deliberately not awaited: usage must not delay the turn.
    void usageRecorder.flush(usageFlushReason);
    releaseRequest();
  }
}

/**
 * Detach provider history before an edit truncates local turns. Provider
 * threads/sessions contain the deleted trailing turns even after their local
 * rows are gone; retrying on the old session would silently reintroduce that
 * context. The cleanup obligation is persisted before the provider call so an
 * outage cannot turn the edit into an untracked provider leak.
 */
async function detachProviderForEdit(
  conversationKey: number,
  catalog: Awaited<ReturnType<typeof conversationRepository.getCatalogEntry>>,
): Promise<boolean> {
  if (!catalog) return false;
  const providerSessionId = String(catalog.providerSessionId || "").trim();
  if (catalog.system === "codex") {
    if (!providerSessionId) return true;
    const job = await enqueueConversationCleanupJob({
      operation: "codex_archive",
      system: "codex",
      conversationKey,
      instanceID: catalog.instanceID,
      conversationKind: catalog.kind,
      libraryID: catalog.libraryID,
      paperItemID: catalog.paperItemID,
      providerSessionId,
    });
    if (!job) return false;
    const attempt = await performConversationCleanupJobAttempt(
      job,
      async () => {
        try {
          await archiveCodexAppServerThread({ threadId: providerSessionId });
        } catch (error) {
          if (!/not found|unknown thread|does not exist/i.test(String(error))) {
            throw error;
          }
        }
      },
    );
    if (!attempt.ok) return false;
    await clearCodexConversationSessionMetadata(
      conversationKey,
      providerSessionId,
      catalog.instanceID,
    );
    return true;
  }
  if (catalog.system === "claude_code") {
    const scope = buildClaudeScope({
      libraryID: catalog.libraryID,
      kind: catalog.kind,
      paperItemID: catalog.paperItemID,
    });
    if (!catalog.instanceID || (!providerSessionId && !scope.scopeId)) {
      return !providerSessionId;
    }
    const job = await enqueueConversationCleanupJob({
      operation: "claude_invalidate",
      system: "claude_code",
      conversationKey,
      instanceID: catalog.instanceID,
      conversationKind: catalog.kind,
      libraryID: catalog.libraryID,
      paperItemID: catalog.paperItemID,
      providerScope: scope,
      providerSessionId,
    });
    if (!job) return false;
    const attempt = await performConversationCleanupJobAttempt(job, async () =>
      invalidateClaudeConversationSessionWithinWriteLock(
        await initAgentSubsystem(),
        {
          conversationKey,
          scope,
          metadata: {
            ...(providerSessionId ? { providerSessionId } : {}),
            instanceID: catalog.instanceID,
          },
        },
      ),
    );
    if (!attempt.ok) return false;
  }
  return true;
}

/**
 * Edit the user message in any turn (not just the latest) and retry.
 * Truncates all subsequent turns from memory and storage, updates the
 * user message text, then retries using the currently selected model.
 */
export async function editUserTurnAndRetry(opts: {
  body: Element;
  item: Zotero.Item;
  requestId?: number;
  onProviderDispatch?: () => void;
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
    requestId,
    onProviderDispatch,
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
  const initialConversationKey = getConversationKey(item);
  if (requestId !== undefined) {
    if (!isRequestOwner(initialConversationKey, requestId)) return false;
  }
  await ensureConversationLoaded(item);
  const conversationKey = getConversationKey(item);
  if (requestId !== undefined) {
    if (
      conversationKey !== initialConversationKey &&
      !transferPanelRequest(
        resolveConversationSystemForItem(item),
        initialConversationKey,
        conversationKey,
        requestId,
      )
    ) {
      return false;
    }
  }
  const requestIsActive = () =>
    requestId === undefined ||
    (isRequestOwner(conversationKey, requestId) &&
      getCancelledRequestId(conversationKey) < requestId &&
      !getAbortController(conversationKey)?.signal.aborted);
  if (!requestIsActive()) return false;
  // Edit acts on the state the user SEES: complete any pending turn deletion
  // first. history stays RAW below on purpose — truncation after the edited
  // pair must also purge hidden trailing pairs and their rows; a preceding
  // hidden pair is excluded from the prompt by the delegated retry path.
  if (!(await pendingDeletionStore.ensurePersistedFenceLoaded())) return false;
  if (!requestIsActive()) return false;
  await awaitPendingTurnFinalize(
    pendingDeletionStore.finalizeTurnsForConversation(conversationKey, "edit"),
  );
  if (!requestIsActive()) return false;
  // An edit cannot cancel a whole-conversation deletion. Only explicit Undo
  // can withdraw that intent during its own window.
  if (pendingDeletionStore.isConversationPendingDeletion(conversationKey)) {
    appLogger.debug(
      "LLM: editUserTurnAndRetry — conversation is frozen by pending deletion",
    );
    return false;
  }
  const history = chatHistory.get(conversationKey) || [];
  const conversationGeneration =
    getConversationWriteGeneration(conversationKey);

  const userIndex = history.findIndex(
    (m) => m.role === "user" && m.timestamp === userTimestamp,
  );
  if (userIndex < 0) {
    appLogger.debug("LLM: editUserTurnAndRetry — user message not found");
    return false;
  }
  const assistantIndex = userIndex + 1;
  if (
    assistantIndex >= history.length ||
    history[assistantIndex]?.role !== "assistant"
  ) {
    appLogger.debug("LLM: editUserTurnAndRetry — assistant message not found");
    return false;
  }
  if (history[assistantIndex]!.streaming) {
    appLogger.debug("LLM: editUserTurnAndRetry — assistant is still streaming");
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

  if (
    !isConversationWriteGenerationCurrent(
      conversationKey,
      conversationGeneration,
    ) ||
    areConversationWritesFrozen(conversationKey)
  ) {
    return false;
  }

  if (subsequentPairs.length) {
    const providerReset = await withConversationWriteLock(
      conversationKey,
      async () => {
        if (
          areConversationWritesFrozen(conversationKey) ||
          !isConversationWriteGenerationCurrent(
            conversationKey,
            conversationGeneration,
          )
        ) {
          return false;
        }
        const catalog = await conversationRepository.getCatalogEntry({
          system: retryStorageSystem,
          kind:
            resolveDisplayConversationKind(item) === "paper"
              ? "paper"
              : "global",
          conversationKey,
        });
        const detached = await detachProviderForEdit(conversationKey, catalog);
        if (!detached) return false;
        if (retryStorageSystem === "codex") {
          clearCodexNativeReadLedgerForConversation({
            conversationKey,
            instanceID: catalog?.instanceID,
          });
        }
        return isConversationWriteGenerationCurrent(
          conversationKey,
          conversationGeneration,
        );
      },
    );
    if (!providerReset) {
      appLogger.warn(
        "LLM: editUserTurnAndRetry — provider history could not be detached",
      );
      return false;
    }
  }

  // Truncate in-memory history to this pair
  history.splice(assistantIndex + 1);

  // Delete persisted subsequent turns
  let trailingDeleteFailed = false;
  for (const p of subsequentPairs) {
    try {
      const deleted = await withConversationWriteLock(
        conversationKey,
        async () => {
          if (
            !isConversationWriteGenerationCurrent(
              conversationKey,
              conversationGeneration,
            ) ||
            areConversationWritesFrozen(conversationKey)
          ) {
            return false;
          }
          const storageSystem = resolveConversationStorageSystem({
            conversationKey,
            conversationSystem: retryStorageSystem,
          });
          if (!storageSystem) return false;
          await conversationRepository.deleteTurnMessages({
            system: storageSystem,
            conversationKey,
            userTimestamp: p.userTs,
            assistantTimestamp: p.assistantTs,
            onBeforeCommit: () =>
              clearPersistedAgentConversationRowsInTransaction(conversationKey),
          });
          return true;
        },
      );
      if (!deleted) {
        trailingDeleteFailed = true;
        break;
      }
    } catch (err) {
      appLogger.warn("LLM: Failed to delete subsequent stored turn", err);
      trailingDeleteFailed = true;
      break;
    }
  }
  if (trailingDeleteFailed) {
    try {
      const restored = await loadStoredConversationByKey(
        conversationKey,
        PERSISTED_HISTORY_LIMIT,
        retryStorageSystem,
      );
      chatHistory.set(
        conversationKey,
        restored.map((message) => toPanelMessage(message)),
      );
    } catch (err) {
      appLogger.warn(
        "LLM: Failed to restore history after edit truncation",
        err,
      );
    }
    return false;
  }
  // The edit path deletes trailing message rows directly rather than through
  // the queued-turn coordinator.  Persistent agent state is conversation-key
  // scoped, so clear its in-memory/trace participants after the atomic row
  // purge before the edited retry can build a prompt.
  if (subsequentPairs.length) {
    try {
      await clearAgentConversationState(conversationKey);
    } catch (err) {
      appLogger.warn(
        "LLM: Failed to clear agent state after edit truncation",
        err,
      );
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
    normalizedPdfPaperContexts.map((paper) =>
      completePaperContextKey(paper, item.libraryID),
    ),
  );
  const {
    paperContexts: paperContextsForMessage,
    fullTextPaperContexts: fullTextPaperContextsForMessage,
    activePaperContext,
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
        conversationGeneration,
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
    appLogger.warn("LLM: Failed to persist edited user message", err);
    try {
      const restored = await loadStoredConversationByKey(
        conversationKey,
        PERSISTED_HISTORY_LIMIT,
        retryStorageSystem,
      );
      chatHistory.set(
        conversationKey,
        restored.map((message) => toPanelMessage(message)),
      );
    } catch (restoreError) {
      appLogger.warn(
        "LLM: Failed to restore history after edit persistence failure",
        restoreError,
      );
    }
    return false;
  }

  try {
    const storedAfterEdit = await loadStoredConversationByKey(
      conversationKey,
      PERSISTED_HISTORY_LIMIT,
      retryStorageSystem,
    );
    await replaceOwnerAttachmentRefs(
      "conversation",
      conversationKey,
      collectAttachmentHashesFromStoredMessages(storedAfterEdit),
      conversationGeneration,
    );
  } catch (err) {
    appLogger.warn("LLM: Failed to reconcile edit attachment refs", err);
    return false;
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
        requestId,
        onProviderDispatch,
        activePaperContext,
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
        requestId,
        onProviderDispatch,
      );
  return retrySucceeded === true;
}

export type BuildAgentRuntimeRequestParams = {
  conversationKey: number;
  conversationGeneration?: number;
  sourceMessageTimestamp?: number;
  item: Zotero.Item;
  activePaperContext?: PaperContextRef;
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
  planContext?: import("../../agent/plans/types").PlanRuntimeContext;
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
  const requestLibraryID = Math.floor(Number(params.item.libraryID)) || 0;
  const baseItem = resolveConversationBaseItem(params.item);
  const activeNoteSession = resolveActiveNoteSession(params.item);
  const conversationKind =
    activeNoteSession?.conversationKind ||
    resolveDisplayConversationKind(params.item) ||
    undefined;
  const completePaperKey = (paper: PaperContextRef) =>
    `${Math.floor(Number(paper.libraryID || requestLibraryID))}:${Math.floor(
      Number(paper.itemId),
    )}:${Math.floor(Number(paper.contextItemId))}`;
  const activePaperContext = params.activePaperContext
    ? [
        ...(enrichedPaperContexts || []),
        ...(enrichedFullTextPapers || []),
        ...rawPdfPaperContexts,
      ].find(
        (paper) =>
          completePaperKey(paper) ===
          completePaperKey(params.activePaperContext!),
      ) || params.activePaperContext
    : conversationKind === "paper"
      ? resolvePaperContextRefFromItem(baseItem) || undefined
      : undefined;
  const attachmentResourcePool = buildAgentAttachmentResourcePool({
    paperContexts: enrichedPaperContexts,
    fullTextPaperContexts: enrichedFullTextPapers,
    selectedCollectionContexts: params.selectedCollectionContexts,
  });
  let registeredConversation: Awaited<
    ReturnType<typeof getRegisteredConversationScope>
  > = null;
  try {
    registeredConversation = await getRegisteredConversationScope(
      params.conversationKey,
    );
  } catch {
    // The instance witness is an adapter-safety hint; a provider turn can
    // still proceed through the existing request identity when the registry
    // is temporarily unavailable.
  }
  const conversationInstanceID = registeredConversation?.instanceID;
  const executingPlan =
    params.planContext?.phase === "executing"
      ? await import("../../agent/plans/store").then(async (store) => {
          const ledger = await store.loadPlanExecutionLedger(
            params.planContext?.phase === "executing"
              ? params.planContext.executionId
              : "",
          );
          const artifact = ledger
            ? await store.loadPlanArtifact(ledger.planId, ledger.revision)
            : null;
          if (!ledger || !artifact || artifact.digest !== ledger.planDigest) {
            throw new Error("The approved plan grant could not be verified");
          }
          return { ledger, artifact };
        })
      : null;
  const priorPlanArtifact =
    params.planContext?.phase === "planning" && params.planContext.revision > 1
      ? await import("../../agent/plans/store").then((store) =>
          store.loadPlanArtifact(
            params.planContext!.planId,
            params.planContext!.revision - 1,
          ),
        )
      : null;
  return {
    conversationKey: params.conversationKey,
    conversationGeneration: params.conversationGeneration,
    mode: "agent",
    userText: params.userText,
    planContext: params.planContext,
    actionContract: executingPlan?.artifact.actionContract,
    conversationKind,
    activeItemId: activeNoteSession?.noteId || baseItem?.id,
    activePaperContext: activePaperContext
      ? {
          ...activePaperContext,
          libraryID:
            Math.floor(
              Number(activePaperContext.libraryID || requestLibraryID),
            ) || undefined,
        }
      : undefined,
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
      sourceMessageTimestamp: params.sourceMessageTimestamp,
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
      conversationInstanceID,
      planExecutionLedger: executingPlan?.ledger,
      approvedPlanContract: executingPlan?.artifact.contract,
      priorPlanArtifact,
    },
  };
}

export const buildAgentRuntimeRequestForTests = buildAgentRuntimeRequest;

function buildAgentEngineDeps(
  currentItem?: Zotero.Item,
  conversationSystem?: ConversationSystem,
  conversationGeneration?: number,
  panelBody?: Element,
  ownershipLease?: PanelOperationLease | null,
): AgentEngineDeps {
  const effectiveConversationSystem: ConversationSystem =
    conversationSystem ||
    (currentItem
      ? resolveEffectiveConversationSystem({ item: currentItem })
      : "upstream");
  const getEffectiveConversationSystem = () => effectiveConversationSystem;
  const canUpdateCapturedPanel = (operation: string): boolean =>
    !currentItem ||
    !panelBody ||
    (Boolean(ownershipLease) &&
      isPanelOperationLeaseCurrent(ownershipLease) &&
      requireCurrentPanelOwnership(panelBody, currentItem, operation));
  return {
    conversationGeneration,
    chatHistory,
    agentRunTraceCache,
    cancelledRequestId: (ck: number) => getCancelledRequestId(ck),
    currentAbortController: (ck: number) => getAbortController(ck),
    getAbortControllerCtor,
    nextRequestId,
    tryBeginRequest,
    isRequestOwner,
    finishRequest: (conversationKey, requestId) => {
      const finished = finishRequest(conversationKey, requestId);
      if (finished) syncRequestUIForConversation(conversationKey);
      return finished;
    },
    transferRequest: (fromConversationKey, toConversationKey, requestId) => {
      if (
        !transferPanelRequest(
          getEffectiveConversationSystem(),
          fromConversationKey,
          toConversationKey,
          requestId,
        )
      ) {
        return false;
      }
      syncRequestUIForConversation(fromConversationKey, null, null);
      syncRequestUIForConversation(toConversationKey, null, null);
      return true;
    },
    getPanelRequestUI,
    setRequestUIBusy,
    restoreRequestUIIdle: (body, conversationKey, requestId) => {
      if (!canUpdateCapturedPanel("agent-request-finish")) return;
      restoreRequestUIIdle(body, conversationKey, requestId);
    },
    scheduleQueuedInputDrain: (body, scope) => {
      if (!canUpdateCapturedPanel("agent-queue-drain")) return;
      scheduleQueuedInputDrain(body, scope);
    },
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
    createQueuedRefresh: (refresh) => createQueuedRefresh(refresh, panelBody),
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
      // A dispatched turn owns its captured conversation, not the panel that
      // happened to start it. Navigation may retire that panel while work
      // continues. Scope validation and the generation-fenced store below
      // prevent cross-conversation writes and resurrection after deletion.
      const guardedMessage = {
        ...message,
        conversationGeneration:
          message.conversationGeneration ?? conversationGeneration,
      };
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
      await persistConversationMessage(
        conversationKey,
        guardedMessage,
        storageSystem,
      );
    },
    updateStoredLatestUserMessage: async (conversationKey, data) => {
      const guardedData = {
        ...data,
        conversationGeneration:
          data.conversationGeneration ?? conversationGeneration,
      };
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
        guardedData as Parameters<
          typeof updateStoredLatestUserMessageByConversation
        >[1],
        storageSystem,
      );
    },
    updateStoredLatestAssistantMessage: async (conversationKey, data) => {
      const guardedData = {
        ...data,
        conversationGeneration:
          data.conversationGeneration ?? conversationGeneration,
      };
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
        guardedData as Parameters<
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

export const buildAgentEngineDepsForTests = buildAgentEngineDeps;

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
  requestId?: number,
  onProviderDispatch?: () => void,
  activePaperContextOverride?: PaperContextRef,
): Promise<true> {
  const ownershipLease = capturePanelOperationLease(body);
  const isOwnershipCurrent = (operation: string) =>
    Boolean(
      ownershipLease &&
      isPanelOperationLeaseCurrent(ownershipLease) &&
      requireCurrentPanelOwnership(body, item, operation),
    );
  if (!isOwnershipCurrent("retry-agent-response")) return true;
  const conversationSystem = resolveEffectiveConversationSystem({
    item,
    authMode,
    providerProtocol,
    modelProviderLabel,
  });
  // Retry must act on the state the user SEES (see retryLatestAssistantResponse);
  // callers that already finalized and restored make this a cheap no-op. Turn
  // entries only — a pending conversation deletion is the callers' concern.
  const agentRetryConversationKey = getConversationKey(item);
  if (agentRetryConversationKey) {
    await awaitPendingTurnFinalize(
      pendingDeletionStore.finalizeTurnsForConversation(
        agentRetryConversationKey,
        "retry",
      ),
    );
  }
  if (!isOwnershipCurrent("retry-agent-response-load")) return true;
  await initAgentSubsystem();
  if (!isOwnershipCurrent("retry-agent-response-runtime")) return true;
  const guardedProviderDispatch = createOwnershipFencedProviderDispatch({
    body,
    item,
    lease: ownershipLease!,
    callback: onProviderDispatch,
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
    modelAttachmentsOverride,
    buildAgentEngineDeps(
      item,
      conversationSystem,
      getConversationWriteGeneration(getConversationKey(item)),
      body,
      ownershipLease,
    ),
    requestId,
    guardedProviderDispatch,
    activePaperContextOverride,
  );
  return true;
}

async function sendAgentQuestion(opts: {
  body: Element;
  item: Zotero.Item;
  requestId?: number;
  onProviderDispatch?: () => void;
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
  planContext?: import("../../agent/plans/types").PlanRuntimeContext;
}): Promise<void> {
  const ownershipLease = capturePanelOperationLease(opts.body);
  const isOwnershipCurrent = (operation: string) =>
    Boolean(
      ownershipLease &&
      isPanelOperationLeaseCurrent(ownershipLease) &&
      requireCurrentPanelOwnership(opts.body, opts.item, operation),
    );
  if (!isOwnershipCurrent("send-agent-question")) return;
  const conversationKey = getConversationKey(opts.item);
  if (
    opts.requestId !== undefined &&
    (!isRequestOwner(conversationKey, opts.requestId) ||
      getCancelledRequestId(conversationKey) >= opts.requestId ||
      Boolean(getAbortController(conversationKey)?.signal.aborted))
  ) {
    return;
  }
  const safeConversationScope = await validateConversationScopeForItem({
    item: opts.item,
    conversationKey,
    conversationSystem: opts.conversationSystem,
  });
  if (!isOwnershipCurrent("send-agent-question-scope")) return;
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
  if (!isOwnershipCurrent("send-agent-question-runtime")) return;
  if (
    opts.requestId !== undefined &&
    (!isRequestOwner(conversationKey, opts.requestId) ||
      getCancelledRequestId(conversationKey) >= opts.requestId ||
      Boolean(getAbortController(conversationKey)?.signal.aborted))
  ) {
    return;
  }
  const guardedProviderDispatch = createOwnershipFencedProviderDispatch({
    body: opts.body,
    item: opts.item,
    lease: ownershipLease!,
    callback: opts.onProviderDispatch,
  });
  await sendAgentTurn(
    { ...opts, onProviderDispatch: guardedProviderDispatch },
    buildAgentEngineDeps(
      opts.item,
      opts.conversationSystem,
      getConversationWriteGeneration(getConversationKey(opts.item)),
      opts.body,
      ownershipLease,
    ),
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
  const ownershipLease = capturePanelOperationLease(body);
  if (
    !ownershipLease ||
    !requireCurrentPanelOwnership(body, item, "send-question")
  ) {
    return;
  }
  const initialConversationKey = getConversationKey(item);
  const claimedHere = opts.requestId === undefined;
  let thisRequestId: number;
  if (opts.requestId !== undefined) {
    thisRequestId = opts.requestId;
    if (!isRequestOwner(initialConversationKey, thisRequestId)) return;
  } else {
    const claimed = beginPanelRequest(body, item, "Preparing request...");
    if (!claimed) return;
    thisRequestId = claimed.requestId;
  }
  const requestIsActive = (conversationKey: number) =>
    isRequestOwner(conversationKey, thisRequestId) &&
    getCancelledRequestId(conversationKey) < thisRequestId &&
    !getAbortController(conversationKey)?.signal.aborted &&
    isPanelOperationLeaseCurrent(ownershipLease) &&
    requireCurrentPanelOwnership(body, item, "send-question-continuation");
  const finishBeforeDispatch = () => {
    if (!claimedHere) return false;
    const currentConversationKey = getConversationKey(item);
    if (finishPanelRequest(body, item, currentConversationKey, thisRequestId)) {
      return true;
    }
    if (currentConversationKey === initialConversationKey) return false;
    return finishPanelRequest(
      body,
      item,
      initialConversationKey,
      thisRequestId,
    );
  };
  {
    // The durable deletion intents must be loaded before any write. If startup
    // could not read them, retry now: a transient database error at launch
    // then self-heals instead of silently dropping the fence and writing into
    // a conversation the user already deleted in an earlier session.
    if (!(await pendingDeletionStore.ensurePersistedFenceLoaded())) {
      const ui = getPanelRequestUI(body);
      if (ui.status) {
        setStatus(
          ui.status,
          t("Chat storage is unavailable; check the log"),
          "error",
        );
      }
      finishBeforeDispatch();
      return;
    }
    if (!requestIsActive(initialConversationKey)) {
      finishBeforeDispatch();
      return;
    }
    // A new send is the user moving on: complete any pending turn deletion so
    // the hidden turn is neither included in the prompt nor resurrected later.
    const pendingKey = getConversationKey(item);
    if (pendingKey) {
      await awaitPendingTurnFinalize(
        pendingDeletionStore.finalizeTurnsForConversation(pendingKey, "send"),
      );
      // A send cannot become an implicit Undo. Freeze the exact instance until
      // the user explicitly withdraws the intent from the Undo control.
      if (pendingDeletionStore.isConversationPendingDeletion(pendingKey)) {
        const ui = getPanelRequestUI(body);
        if (ui.status) {
          setStatus(
            ui.status,
            t("Deletion pending; retrying safely"),
            "warning",
          );
        }
        finishBeforeDispatch();
        return;
      }
    }
    if (!requestIsActive(initialConversationKey)) {
      finishBeforeDispatch();
      return;
    }
  }
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
    try {
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
        planContext: opts.planContext,
        requestId: thisRequestId,
        onProviderDispatch: opts.onProviderDispatch,
      });
    } finally {
      if (claimedHere) {
        finishPanelRequest(body, item, getConversationKey(item), thisRequestId);
      }
    }
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

  // Show cancel, hide send
  setRequestUIBusy(body, ui, initialConversationKey, "Preparing request...");

  const shownQuestion = displayQuestion || question;
  try {
    await ensureConversationLoaded(item);
  } catch (error) {
    finishBeforeDispatch();
    throw error;
  }
  const provisionalConversationKey = getConversationKey(item);
  if (provisionalConversationKey !== initialConversationKey) {
    if (
      !transferPanelRequest(
        resolveConversationSystemForItem(item),
        initialConversationKey,
        provisionalConversationKey,
        thisRequestId,
      )
    ) {
      finishBeforeDispatch();
      return;
    }
    syncRequestUIForConversation(initialConversationKey, body, item);
    syncRequestUIForConversation(provisionalConversationKey, body, item);
  }
  if (!requestIsActive(provisionalConversationKey)) {
    finishBeforeDispatch();
    return;
  }
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
  const conversationGeneration =
    getConversationWriteGeneration(conversationKey);
  const safeConversationScope = await validateConversationScopeForItem({
    item,
    conversationKey,
    conversationSystem: effectiveConversationSystem,
  });
  if (!requestIsActive(conversationKey)) {
    removeMessageReference(provisionalHistory, optimisticUserMessage);
    removeMessageReference(provisionalHistory, optimisticAssistantMessage);
    optimisticHelpers.refreshChatSafely();
    finishBeforeDispatch();
    return;
  }
  if (!safeConversationScope) {
    removeMessageReference(provisionalHistory, optimisticUserMessage);
    removeMessageReference(provisionalHistory, optimisticAssistantMessage);
    optimisticHelpers.refreshChatSafely();
    optimisticHelpers.setStatusSafely(
      "Conversation identity mismatch; open a new chat.",
      "error",
    );
    if (claimedHere)
      finishPanelRequest(body, item, conversationKey, thisRequestId);
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
  // finalizeTurnsForConversation above is best-effort; when a finalizer fails
  // the turn is still queued (and hidden), so the prompt must exclude it here.
  const historyForLLM = filterMessagesInPendingTurns(
    conversationKey,
    reuseOptimisticPair ? history.slice(0, -2) : history.slice(),
  );
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

    try {
      if (
        !notifyProviderDispatch(
          body,
          ui,
          item,
          ownershipLease,
          opts.onProviderDispatch,
        )
      ) {
        return;
      }
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
      if (
        clearPendingRequestIdAndSync(conversationKey, body, item, thisRequestId)
      ) {
        restoreRequestUIIdle(body, conversationKey, thisRequestId);
        scheduleQueuedInputDrain(body, {
          conversationSystem:
            resolveConversationSystemForItem(item) || "upstream",
          conversationKey,
        });
      }
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
    normalizedPdfPaperContexts.map((paper) =>
      completePaperContextKey(paper, item.libraryID),
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
    if (!requestIsActive(conversationKey)) {
      removeMessageReference(provisionalHistory, optimisticUserMessage);
      removeMessageReference(provisionalHistory, optimisticAssistantMessage);
      optimisticHelpers.refreshChatSafely();
      finishBeforeDispatch();
      return;
    }
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
    conversationGeneration,
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
        conversationGeneration,
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
    conversationGeneration,
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
  const {
    refreshChatSafely,
    refreshAssistantMessageSafely,
    refreshCompletedAssistantTurnSafely,
    setStatusSafely,
  } = createPanelUpdateHelpers(body, item, conversationKey, ui);
  refreshChatSafely();

  let assistantPersisted = false;
  let codexActivityTrace: CodexNativeActivityTraceController | null = null;
  const persistAssistantOnce = async (
    status?: import("../../agent/types").AgentRunStatus,
  ) => {
    if (assistantPersisted) return;
    assistantPersisted = true;
    if (!shouldPersistTurn) return;
    await codexActivityTrace?.persist(
      conversationKey,
      conversationGeneration,
      status,
    );
    await persistConversationMessage(
      conversationKey,
      {
        conversationGeneration,
        role: "assistant",
        text: assistantMessage.text,
        timestamp: assistantMessage.timestamp,
        runMode: assistantMessage.runMode,
        agentRunId: assistantMessage.agentRunId,
        documentId: assistantMessage.documentId,
        planDocumentId: assistantMessage.planDocumentId,
        modelName: assistantMessage.modelName,
        modelEntryId: assistantMessage.modelEntryId,
        modelProviderLabel: assistantMessage.modelProviderLabel,
        interrupted: assistantMessage.interrupted,
        completionStatus: assistantMessage.completionStatus,
        completionReason: assistantMessage.completionReason,
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
  // Streaming flushes only mutate this assistant message, so re-render just
  // its bubble; refreshChat falls back to a full rebuild if the wrapper is
  // not in the DOM yet.
  const streamingResponse = createStreamingResponse({
    message: assistantMessage,
    refreshMessage: () => refreshAssistantMessageSafely(assistantMessage),
    createQueuedRefresh: (refresh) => createQueuedRefresh(refresh, body),
  });
  const markCancelled = async () => {
    streamingResponse.flush("cancel");
    // Same reason as the retry flow: finish() never ran, so flush the trace's
    // buffered commentary before persistAssistantOnce writes the turn.
    codexActivityTrace?.flushBufferedProgress("cancel");
    finalizeCancelledAssistantMessage(assistantMessage);
    refreshChatSafely();
    await persistAssistantOnce("cancelled");
    setStatusSafely("Cancelled", "ready");
  };
  const stopInactiveRequest = async () => {
    if (requestIsActive(conversationKey)) return false;
    if (isRequestOwner(conversationKey, thisRequestId)) {
      await markCancelled();
    }
    return true;
  };

  // [webchat] Dedicated pipeline — bypass context assembly, send raw PDF + question
  if (effectiveRequestConfig.providerProtocol === "web_sync") {
    const webChatQueueRefresh = createQueuedRefresh(
      () => refreshAssistantMessageSafely(assistantMessage),
      body,
    );
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
      const previousWebChatAssistant = historyForLLM
        .slice()
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" &&
            message.modelName === effectiveRequestConfig.model &&
            Boolean(message.webchatChatUrl || message.webchatChatId),
        );
      setStatusSafely(`Sending to ${webchatLabel}…`, "sending");
      const { selectWebChatExpectedConversation, sendWebChatQuestion } =
        await import("../../webchat/pipeline");
      if (await stopInactiveRequest()) {
        reportWebChatSendOutcome("cancelled");
        return;
      }

      // Note: `question` already includes selected text context via
      // buildQuestionWithSelectedTextContexts() — no need to prepend again.

      // [webchat] Mode switching disabled — users control thinking mode on chatgpt.com
      const chatgptMode: string | undefined = undefined;

      // [webchat] Send PDF only when the caller explicitly requests it via chip state.
      // Always use dynamic port for the embedded relay server
      const { getRelayBaseUrl } = await import("../../webchat/relayServer");
      const expectedConversation = selectWebChatExpectedConversation({
        explicitUrl: opts.webchatExpectedChatUrl,
        explicitId: opts.webchatExpectedChatId,
        historicalUrl: previousWebChatAssistant?.webchatChatUrl,
        historicalId: previousWebChatAssistant?.webchatChatId,
      });
      if (
        !notifyProviderDispatch(
          body,
          ui,
          item,
          ownershipLease,
          opts.onProviderDispatch,
        )
      ) {
        reportWebChatSendOutcome("cancelled");
        return;
      }
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
        ...expectedConversation,
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
      setStatusSafely(errMsg, "error");
      reportWebChatSendOutcome("failed");
    } finally {
      if (
        clearPendingRequestIdAndSync(conversationKey, body, item, thisRequestId)
      ) {
        restoreRequestUIIdle(body, conversationKey, thisRequestId);
      }
    }
    return;
  }

  // Local usage ledger for this turn: one question, one row.
  const usageRecorder = createTurnUsageRecorder({
    conversationKey,
    conversationGeneration,
    runtime: isCodexNativeTurn ? "codex" : "chat",
    model: effectiveRequestConfig.model,
    provider: effectiveRequestConfig.modelProviderLabel,
  });
  let usageFlushReason: UsageTurnFlushReason = "complete";

  try {
    const rawLLMHistory = buildLLMHistoryMessages(historyForLLM);
    // Apply auto-summary compression when the history grows long.
    const llmHistory =
      applyHistoryCompression(conversationKey, rawLLMHistory) ?? rawLLMHistory;
    const recentPaperContexts = collectRecentPaperContexts(historyForLLM);

    if (effectiveConversationSystem === "upstream") {
      await preflightRequestModelCapabilities({
        prompt: question,
        model: effectiveRequestConfig.model,
        apiBase: effectiveRequestConfig.apiBase,
        apiKey: effectiveRequestConfig.apiKey,
        authMode: effectiveRequestConfig.authMode,
        providerProtocol: effectiveRequestConfig.providerProtocol,
        profileOverride: effectiveRequestConfig.advanced?.profileOverride,
      });
      if (await stopInactiveRequest()) return;
    }

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
    if (await stopInactiveRequest()) return;
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
        conversationGeneration,
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

    if (await stopInactiveRequest()) return;

    const queueRefresh = streamingResponse.queueRefresh;
    codexActivityTrace = isCodexNativeTurn
      ? createCodexNativeActivityTraceController(assistantMessage, queueRefresh)
      : null;
    noteExplicitCodexNativeSkillInvocations(
      codexActivityTrace,
      opts.forcedSkillIds,
    );
    streamingResponse.start();

    if (await stopInactiveRequest()) return;

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
      outputTokenLimit: effectiveRequestConfig.advanced?.outputTokenLimit,
      inputTokenCap: effectiveRequestConfig.advanced?.inputTokenCap,
      profileOverride: effectiveRequestConfig.advanced?.profileOverride,
      inputMode: effectiveRequestConfig.advanced?.inputMode,
      contextCache: contextPlan.contextCache,
      requestScope: createProviderRequestScope(conversationKey),
    };
    const { finalPrepared, systemMessages, workflowTestIntercepted } =
      await prepareFinalContextPlanChatRequest({
        requestParams,
        contextPlan,
        combinedContext,
      });
    if (await stopInactiveRequest()) return;
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
      inputLimitSource: finalPrepared.inputCap.limitSource,
      estimated: true,
      source: "estimated",
    });
    renderContextUsageSnapshot(body, ui.tokenUsageEl, estimatedContextSnapshot);

    const handleReasoning = createStreamReasoningHandler({
      assistantMessage,
      flushResponseStream: streamingResponse.flush,
      queueRefresh,
    });
    const handleUsage = createStreamUsageHandler({
      body,
      tokenUsageEl: ui.tokenUsageEl,
      conversationKey,
      conversationGeneration,
      contextCache: contextPlan.contextCache,
      fallbackContextWindow: finalPrepared.inputCap.limitTokens,
      fallbackInputLimitSource: finalPrepared.inputCap.limitSource,
      usageRecorder,
    });
    const codexScope = isCodexNativeTurn
      ? await enrichCodexNativeConversationScopeWithMineruCache(
          resolveCodexNativeConversationScope({
            item,
            contextSource,
            conversationKey,
            title: shownQuestion,
          }),
        )
      : null;
    const codexExecutionRequest = isCodexNativeTurn
      ? await initAgentSubsystem().then(async (runtime) => {
          const planRequest = await buildAgentRuntimeRequest({
            conversationKey,
            conversationGeneration,
            sourceMessageTimestamp: userMessage.timestamp,
            item,
            userText: shownQuestion,
            selectedTextContexts: selectedTextContextsForMessage,
            resolvedSelectedTextAnchors,
            selectedTexts: selectedTextsForMessage,
            selectedTextSources: selectedTextSourcesForMessage,
            selectedTextPaperContexts: selectedTextPaperContextsForMessage,
            selectedTextNoteContexts: selectedTextNoteContextsForMessage,
            paperContexts: contextPlan.paperContexts,
            pdfPaperContexts: normalizedPdfPaperContexts,
            fullTextPaperContexts: contextPlan.fullTextPaperContexts,
            citationPaperContexts: userMessage.citationPaperContexts,
            selectedCollectionContexts: selectedCollectionContextsForMessage,
            selectedTagContexts: selectedTagContextsForMessage,
            attachments: modelAttachments || attachments,
            localDocuments,
            screenshots: allSendImages,
            forcedSkillIds: opts.forcedSkillIds,
            planContext: opts.planContext,
            effectiveRequestConfig,
            history: llmHistory,
          });
          return runtime.prepareExecutionRequest(planRequest, {
            signal: getAbortController(conversationKey)?.signal,
            permissionOwner: "external_runtime",
          });
        })
      : undefined;
    const codexPlanActionContract = codexExecutionRequest?.actionContract;
    if (await stopInactiveRequest()) return;
    if (
      !notifyProviderDispatch(
        body,
        ui,
        item,
        ownershipLease,
        opts.onProviderDispatch,
      )
    ) {
      return;
    }
    // The request is going out: from here the provider bills whatever it
    // produces, including on abort, so the turn owes a usage row.
    usageRecorder.markDispatched();
    const modelOutcome: ModelTurnOutcome = isCodexNativeTurn
      ? await (async () => {
          const result = await runCodexAppServerNativeTurn({
            executionRequest: codexExecutionRequest!,
            scope: codexScope!,
            conversationGeneration,
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
            ...buildCodexNativeTurnCallbacks({
              body,
              item,
              assistantMessage,
              codexActivityTrace,
              flushResponseStream: streamingResponse.flush,
              setStatusSafely,
              handleDelta: streamingResponse.push,
              handleReasoning,
              handleUsage,
              conversationKey,
              conversationGeneration,
              planContext: opts.planContext,
              actionContract: codexPlanActionContract,
              classifiedIntent: codexExecutionRequest?.classifiedIntent,
              skillRoutingReceipt: codexExecutionRequest?.skillRoutingReceipt,
              actionPreparation: codexExecutionRequest?.actionPreparation,
            }),
          });
          assistantMessage.agentRunId = result.agentRunId;
          if (result.documentId) {
            assistantMessage.documentId = result.documentId;
          }
          return {
            text:
              opts.planContext?.phase === "planning"
                ? "The plan is ready for review."
                : result.text,
            completion: { status: "complete" as const },
          };
        })()
      : await callDirectChatTurnWithRecovery({
          request: {
            ...requestParams,
            systemMessages,
          },
          onDelta: streamingResponse.push,
          onReasoning: handleReasoning,
          onUsage: handleUsage,
        });
    if (isCodexNativeTurn) {
      await finalizeCodexPlanExecution({
        planContext: opts.planContext,
        answer: modelOutcome.text,
        assistantMessage,
        trace: codexActivityTrace,
      });
    }

    if (
      getCancelledRequestId(conversationKey) >= thisRequestId ||
      Boolean(getAbortController(conversationKey)?.signal.aborted)
    ) {
      usageFlushReason = "abort";
      await markCancelled();
      return;
    }

    streamingResponse.flush("final");
    const hasGeneratedOutput = normalizeGeneratedChatImages(
      assistantMessage.generatedImages,
    ).length;
    const outputLimited =
      modelOutcome.completion.status === "incomplete" &&
      modelOutcome.completion.reason === "output_limit";
    assistantMessage.text =
      sanitizeText(modelOutcome.text) ||
      assistantMessage.text ||
      (hasGeneratedOutput
        ? ""
        : outputLimited
          ? EMPTY_OUTPUT_LIMIT_MESSAGE
          : resolveEmptyModelOutcomeMessage(modelOutcome.completion));
    assistantMessage.completionStatus = modelOutcome.completion.status;
    assistantMessage.completionReason =
      "reason" in modelOutcome.completion
        ? modelOutcome.completion.reason
        : undefined;
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
    assistantMessage.interrupted = undefined;
    assistantMessage.streaming = false;
    refreshCompletedAssistantTurnSafely(assistantMessage);
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
        conversationGeneration,
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
        providerProtocol: effectiveRequestConfig.providerProtocol,
        profileOverride: effectiveRequestConfig.advanced?.profileOverride,
      });
    }

    setStatusSafely("Ready", "ready");
  } catch (err) {
    const isCancelled =
      getCancelledRequestId(conversationKey) >= thisRequestId ||
      Boolean(getAbortController(conversationKey)?.signal.aborted) ||
      (err as { name?: string }).name === "AbortError";
    usageFlushReason = isCancelled ? "abort" : "error";
    if (isCancelled) {
      await markCancelled();
      return;
    }

    const technicalErrMsg = (err as Error).message || "Error";
    const errMsg = isCodexNativeTurn
      ? formatCodexZoteroMcpError(err, "Native conversation failed")
      : technicalErrMsg;
    const retryHint = resolveMultimodalRetryHint(errMsg, imageCount);
    // Preserve whatever streamed before the connection dropped instead of
    // discarding it. The streamed text includes the last, not-yet-flushed
    // chunk.
    const partialText = sanitizeText(
      streamingResponse.getStreamedText() || assistantMessage.text || "",
    );
    streamingResponse.dispose();
    const outcome = resolveStreamInterruptionOutcome({
      partialText,
      errorMessage: errMsg,
      retryHint,
    });
    assistantMessage.text = outcome.text;
    assistantMessage.interrupted = outcome.interrupted;
    assistantMessage.streaming = false;
    codexActivityTrace?.flushBufferedProgress("error");
    refreshChatSafely();
    await persistAssistantOnce();

    setStatusSafely(`Error: ${`${errMsg}${retryHint}`.slice(0, 40)}`, "error");
  } finally {
    // Same end of life as the retry flow: stop the trace controller before
    // the request UI goes idle, so nothing it buffered can arrive later.
    codexActivityTrace?.dispose();
    // Every path through this flow -- completion, error, abort -- ends here,
    // so this is where the one usage row for the turn is written. It never
    // throws and is deliberately not awaited: usage must not delay the turn.
    void usageRecorder.flush(usageFlushReason);
    if (
      clearPendingRequestIdAndSync(conversationKey, body, item, thisRequestId)
    ) {
      restoreRequestUIIdle(body, conversationKey, thisRequestId);
      scheduleQueuedInputDrain(body, {
        conversationSystem:
          resolveConversationSystemForItem(item) || "upstream",
        conversationKey,
      });
    }
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
    if (win) win.setTimeout(() => refreshConversationPanels(body, item), 0);
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

type MountedAssistantView = {
  wrapper: HTMLElement;
  bubble: HTMLElement;
  trace: HTMLElement | null;
  reasoningSummary?: string;
  reasoningDetails?: string;
  runMode?: Message["runMode"];
  modelName?: string;
  modelProviderLabel?: string;
  actionSummaryHost: HTMLElement;
  user: Message | null;
  runId?: string;
  text: string;
  quoteCitations?: Message["quoteCitations"];
  quoteOverride?: Message["quoteDisplayOverride"];
  answer?: HTMLElement;
  streaming?: boolean;
  documentId?: string;
};
const mountedAssistantViews = new WeakMap<
  HTMLElement,
  Map<Message, MountedAssistantView>
>();

/** Text/activity refreshes never rebuild the conversation or restore its scroll snapshot. */
function updateMountedAssistantViews(
  body: Element,
  item: Zotero.Item,
  box: HTMLDivElement,
  messages: ReadonlySet<Message>,
): boolean {
  const views = mountedAssistantViews.get(box);
  if (!views || !messages.size) return false;
  for (const message of messages) {
    const view = views.get(message);
    if (
      !view ||
      view.wrapper.parentElement !== box ||
      Boolean(message.streaming) !== Boolean(view.streaming) ||
      message.compactMarker ||
      (message.documentId || message.planDocumentId) !== view.documentId ||
      message.agentRunId !== view.runId ||
      message.generatedImages?.length ||
      // Ordinary Chat reuses answer DOM only. Changes to its surrounding
      // thinking/model presentation retain the established full renderer.
      (!view.trace &&
        (message.reasoningSummary !== view.reasoningSummary ||
          message.reasoningDetails !== view.reasoningDetails ||
          message.runMode !== view.runMode ||
          message.modelName !== view.modelName ||
          message.modelProviderLabel !== view.modelProviderLabel))
    )
      return false;
  }
  let hasAgentTrace = false;
  for (const message of messages) {
    const view = views.get(message)!;
    const events = message.agentRunId
      ? getCachedAgentRunEvents(message.agentRunId)
      : message.pendingAgentTraceEvents || [];
    let interleaved = false;
    if (view.trace) {
      hasAgentTrace = true;
      const trace = renderAgentTrace({
        doc: box.ownerDocument,
        panelItem: item,
        message,
        userMessage: view.user,
        events,
        previous: view.trace,
        actionSummaryHost: view.actionSummaryHost,
        allowPlanRecovery:
          message === latestAssistantMessage(getConversationKey(item)),
        onInterleavedText: () => {
          interleaved = true;
        },
      });
      if (trace && trace !== view.trace) {
        view.trace.replaceWith(trace);
        view.trace = trace;
      }
    }
    if (
      message.text !== view.text ||
      message.quoteCitations !== view.quoteCitations ||
      message.quoteDisplayOverride !== view.quoteOverride
    ) {
      const expandedQuoteCards = collectExpandedQuoteCardKeys(view.answer);
      if (!view.answer) {
        view.answer = box.ownerDocument.createElement("div");
        view.answer.className = "llm-assistant-answer";
        view.bubble.insertBefore(
          view.answer,
          view.actionSummaryHost.parentElement === view.bubble
            ? view.actionSummaryHost
            : null,
        );
      }
      renderAssistantRichText({
        body,
        panelItem: item,
        bubble: view.answer as HTMLDivElement,
        assistantMessage: message,
        pairedUserMessage: view.user,
        webSourceAnchors: getWebSourceAnchorsFromTrace(events),
        incremental: true,
        onContentRendered: () =>
          scheduleChatScrollReconciliation(getConversationKey(item), box),
      });
      restoreExpandedQuoteCards(view.answer, expandedQuoteCards);
      view.text = message.text;
      view.quoteCitations = message.quoteCitations;
      view.quoteOverride = message.quoteDisplayOverride;
      updateStreamingTurnNavigator(body, message);
      if (message.text) {
        view.bubble.classList.toggle("streaming", Boolean(message.streaming));
        view.bubble.querySelector(".llm-typing")?.remove();
      }
    }
    if (view.answer) view.answer.hidden = interleaved;
  }
  if (hasAgentTrace) syncFloatingPlanProgress(box, getConversationKey(item));
  scheduleChatScrollReconciliation(getConversationKey(item), box);
  return true;
}

export type RefreshChatOptions = {
  rerenderAssistantMessages?: ReadonlySet<Message>;
};

export function refreshChat(
  body: Element,
  item?: Zotero.Item | null,
  options: RefreshChatOptions = {},
) {
  if (item && !isPanelConversationCurrent(body, item)) return;
  const chatBox = body.querySelector("#llm-chat-box") as HTMLDivElement | null;
  if (!chatBox) return;
  if (item) initializeChatScrollViewport(getConversationKey(item), chatBox);
  if (item && options.rerenderAssistantMessages) {
    const rerenderConversationKey = getConversationKey(item);
    let updatedInPlace = false;
    // The reader's view is anchored across the in-place update: a message
    // changing height above the viewport must not move what they are reading.
    withScrollGuard(chatBox, rerenderConversationKey, () => {
      updatedInPlace = updateMountedAssistantViews(
        body,
        item,
        chatBox,
        options.rerenderAssistantMessages!,
      );
    });
    if (updatedInPlace) return;
  }
  const doc = body.ownerDocument!;
  setPromptMenuTarget(null);
  const paperContextDisplayCache: PaperContextDisplayCache = new Map();
  const resolvePaperContextForCardDisplay = (
    paperContext: PaperContextRef,
  ): PaperContextRef =>
    resolvePaperContextDisplayRef(paperContext, paperContextDisplayCache);

  if (!item) {
    chatBox.innerHTML = getPaperChatStartPageHtml();
    const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
    if (panelRoot) panelRoot.dataset.startPageActive = "true";
    writeChatScrollTop(chatBox, 0);
    const tokenUsageEl = body.querySelector(
      "#llm-token-usage",
    ) as HTMLElement | null;
    if (tokenUsageEl) tokenUsageEl.style.display = "none";
    syncConversationTurnNavigator(body, [], { conversationKey: null });
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
  const baselineSnapshot = captureChatScrollForRender(
    conversationKey,
    chatBox,
    body,
  );
  const rawHistory = chatHistory.get(conversationKey) || [];
  // Turns queued for deletion stay in memory and DB until the undo window
  // closes; they are only hidden from the render.
  const history = filterMessagesInPendingTurns(conversationKey, rawHistory);
  const requestedRerenders = options.rerenderAssistantMessages;
  const renderedWrappers = requestedRerenders?.size
    ? (Array.from(chatBox.children) as HTMLElement[])
    : [];
  const { useTargetedRerender, targetedMessageWrappers } =
    resolveTargetedAssistantRerenders(
      history,
      requestedRerenders,
      renderedWrappers,
    );
  const forkLink = conversationForkLinks.get(conversationKey) || null;
  if (tokenUsageEl && !useTargetedRerender) {
    const snapshot = contextUsageSnapshots.get(conversationKey);
    const recomputedSnapshot = estimateHistoryContextUsageSnapshot(
      item,
      history,
    );
    const configuredLimitIsUserAuthoritative =
      recomputedSnapshot?.inputLimitSource === "advanced" ||
      recomputedSnapshot?.inputLimitSource === "user";
    const providerWindowRemainsEligible =
      snapshot?.source === "provider" && !configuredLimitIsUserAuthoritative;
    const reconciledSnapshot =
      snapshot && recomputedSnapshot && !providerWindowRemainsEligible
        ? setContextUsageSnapshot(conversationKey, {
            ...snapshot,
            contextWindow: recomputedSnapshot.contextWindow,
            inputLimitSource: recomputedSnapshot.inputLimitSource,
            contextWindowIsAuthoritative: false,
            estimated: true,
            source: "estimated",
          })
        : snapshot;
    renderContextUsageSnapshot(
      body,
      tokenUsageEl,
      reconciledSnapshot || recomputedSnapshot,
    );
  } else if (tokenUsageEl) {
    // Targeted streaming refreshes reach every panel showing the conversation,
    // but mid-stream usage events render only into the initiating panel's
    // counter. Sync the others from the live snapshot when one exists — never
    // the O(history) estimate, which would defeat the targeted render.
    const snapshot = contextUsageSnapshots.get(conversationKey);
    if (snapshot && snapshot.source !== "persisted") {
      renderContextUsageSnapshot(body, tokenUsageEl, snapshot);
    }
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
    syncConversationTurnNavigator(body, [], { conversationKey });
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
    for (const root of Array.from(
      chatBox.querySelectorAll<HTMLElement>(".llm-plan-container-execution"),
    )) {
      if (root) disposePlanProgress(root as HTMLElement);
    }
    for (const view of mountedAssistantViews.get(chatBox)?.values() || []) {
      if (view.trace) disposeAgentTrace(view.trace);
      if (view.answer) disposeStreamingMarkdown(view.answer);
    }
    mountedAssistantViews.delete(chatBox);
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
  const canEditPromptAt = (index: number) =>
    canEditUserPromptTurn({
      isUser: history[index]?.role === "user",
      hasItem: Boolean(item),
      conversationIsIdle,
      assistantPair: history[index + 1],
      providerProtocol: renderProviderProtocol,
    });
  if (useTargetedRerender) {
    // Completion unlocks every paired prompt, including wrappers retained from
    // the busy render. Their click handlers read this current eligibility.
    for (const wrapper of renderedWrappers) {
      if (wrapper.dataset.messageRole !== "user") continue;
      wrapper
        .querySelector(".llm-bubble.user")
        ?.classList.toggle(
          "llm-bubble-editable",
          canEditPromptAt(Number(wrapper.dataset.messageIndex)),
        );
    }
  }
  for (const [index, msg] of history.entries()) {
    if (useTargetedRerender && !targetedMessageWrappers.has(msg)) {
      continue;
    }
    const isUser = msg.role === "user";
    const assistantPairMsg = history[index + 1];
    const hasAssistantPair = isUser && assistantPairMsg?.role === "assistant";
    const canEditUserPrompt = canEditPromptAt(index);
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
    if (!isUser) {
      applyStableAnimationPhase(
        bubble,
        msg.waitingAnimationStartedAt || msg.timestamp,
      );
    }
    let inlineEditEl: HTMLElement | null = null;
    let responseWebSourceAnchors: readonly WebSourceAnchor[] = [];

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

      const paperContexts = getMessageDisplayPaperContexts(msg);
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
        bubble.classList.toggle("llm-bubble-editable", canEditUserPrompt);
        if (hasAssistantPair) {
          bubble.addEventListener("click", (e: Event) => {
            if (
              !bubble.classList.contains("llm-bubble-editable") ||
              !item ||
              !isPanelConversationCurrent(body, item) ||
              chatHistory
                .get(conversationKey)
                ?.some((message) => message.streaming)
            )
              return;
            if ((e.target as Element | null)?.closest("a, button")) return;
            e.preventDefault();
            e.stopPropagation();
            const win = body.ownerDocument?.defaultView;
            if (!win) return;
            try {
              syncComposeContextForInlineEdit(body, item, msg);
            } catch (syncErr) {
              appLogger.warn(
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
            win.setTimeout(() => refreshConversationPanels(body, item), 0);
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
      const webSourceAnchors = getWebSourceAnchorsFromTrace(traceEvents);
      responseWebSourceAnchors = webSourceAnchors;
      let agentUsesInterleavedText = false;
      const actionSummaryHost = doc.createElement("div");
      actionSummaryHost.className = "llm-assistant-actions";
      const agentTraceEl =
        msg.runMode === "agent" && !msg.compactMarker
          ? renderAgentTrace({
              doc,
              panelItem: item,
              message: msg,
              userMessage: previousUserMessage,
              allowPlanRecovery: index === latestAssistantIndex,
              events: traceEvents,
              actionSummaryHost,
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
      const agentTraceReplacesAssistantTurn =
        agentTraceEl?.dataset.llmAssistantTurnReplacement === "true";
      let answerHost: HTMLElement | undefined;
      if (hasAnswerText && !agentUsesInterleavedText) {
        const safeText = buildAssistantDisplayMarkdownForRender(
          msg,
          webSourceAnchors,
        );
        answerHost = doc.createElement("div");
        answerHost.className = "llm-assistant-answer";
        bubble.appendChild(answerHost);
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
            renderAssistantRichText({
              body,
              panelItem: item,
              bubble: answerHost as HTMLDivElement,
              assistantMessage: msg,
              pairedUserMessage: previousUserMessage,
              webSourceAnchors,
              onContentRendered: () => {
                scheduleChatScrollReconciliation(conversationKey, chatBox);
              },
            });
          } catch (err) {
            appLogger.warn("LLM render error:", err);
            answerHost.textContent = safeText;
          }
        decorateWebSourceIndicators(answerHost, doc, webSourceAnchors);
      }

      const bubbleHeaderNodes: HTMLElement[] = [];

      if (
        hasModelName &&
        !msg.compactMarker &&
        !agentTraceReplacesAssistantTurn
      ) {
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
        !agentTraceReplacesAssistantTurn &&
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
          const reasoningSummaryText = buildAssistantDisplayMarkdownForRender({
            text: msg.reasoningSummary || "",
            quoteCitations: msg.quoteCitations,
          });
          try {
            renderRenderedMarkdownInto(text, reasoningSummaryText, doc);
          } catch (err) {
            appLogger.warn("LLM reasoning render error:", err);
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
            appLogger.warn("LLM reasoning render error:", err);
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
      if (
        agentTraceEl ||
        (msg.streaming &&
          msg.runMode !== "agent" &&
          !msg.compactMarker &&
          !hasGeneratedImages &&
          !isClaudeStreamingConversation &&
          renderProviderProtocol !== "web_sync")
      ) {
        let views = mountedAssistantViews.get(chatBox);
        if (!views) {
          views = new Map();
          mountedAssistantViews.set(chatBox, views);
        }
        views.set(msg, {
          wrapper,
          bubble,
          trace: agentTraceEl,
          reasoningSummary: msg.reasoningSummary,
          reasoningDetails: msg.reasoningDetails,
          runMode: msg.runMode,
          modelName: msg.modelName,
          modelProviderLabel: msg.modelProviderLabel,
          actionSummaryHost,
          user: previousUserMessage,
          runId: msg.agentRunId,
          text: msg.text,
          answer: answerHost,
          streaming: msg.streaming,
          documentId: msg.documentId || msg.planDocumentId,
          quoteCitations: msg.quoteCitations,
          quoteOverride: msg.quoteDisplayOverride,
        });
      }

      for (let i = bubbleHeaderNodes.length - 1; i >= 0; i -= 1) {
        bubble.insertBefore(bubbleHeaderNodes[i], bubble.firstChild);
      }

      if (hasGeneratedImages) {
        if (!agentTraceReplacesAssistantTurn) {
          renderAssistantGeneratedImagesInto(bubble, generatedImages, doc, {
            onImageLoaded: () => {
              scheduleChatScrollReconciliation(conversationKey, chatBox);
            },
            onImageActionStatus: (message, level) => {
              const status = body.querySelector(
                "#llm-status",
              ) as HTMLElement | null;
              if (status) setStatus(status, message, level);
            },
          });
        }
      }

      if (!agentTraceReplacesAssistantTurn) {
        decorateCompletedAssistantCitationLinks({
          body,
          panelItem: item,
          bubble,
          assistantMessage: msg,
          pairedUserMessage: previousUserMessage,
          webSourceAnchors,
        });
      }

      if (
        !hasAnswerText &&
        !hasGeneratedImages &&
        !agentTraceReplacesAssistantTurn &&
        !(msg.streaming && isClaudeStreamingConversation)
      ) {
        const typing = doc.createElement("div") as HTMLDivElement;
        typing.className = "llm-typing";
        typing.innerHTML =
          '<span class="llm-typing-dot"></span><span class="llm-typing-dot"></span><span class="llm-typing-dot"></span>';
        bubble.appendChild(typing);
      }

      if (!msg.compactMarker && !agentTraceReplacesAssistantTurn) {
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
      if (agentTraceEl) bubble.appendChild(actionSummaryHost);
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
        webSourceAnchors: responseWebSourceAnchors,
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
      if (actionResponseTarget) {
        appendAssistantResponseExpandAction({
          body,
          doc,
          actions,
          target: actionResponseTarget,
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
            if (
              scraped.length > 0 &&
              !pendingDeletionStore.isConversationPendingDeletion(
                conversationKey,
              ) &&
              !isConversationKeyRetiredInMemory(conversationKey)
            ) {
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
              refreshConversationPanels(body, item);
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

    // Interrupted footer — a streamed reply was cut off before completion (e.g.
    // a connectivity drop); the partial content above is preserved. Distinct
    // from the webchat status row above.
    let interruptedRow: HTMLDivElement | null = null;
    if (!isUser && msg.interrupted) {
      interruptedRow = doc.createElement("div") as HTMLDivElement;
      interruptedRow.className = "llm-message-interrupted-row";
      const note = doc.createElement("span") as HTMLSpanElement;
      note.className = "llm-message-interrupted-note";
      note.textContent = `⚠ ${getStreamInterruptionLabel()}`;
      interruptedRow.appendChild(note);
    }

    let outputLimitRow: HTMLDivElement | null = null;
    if (
      !isUser &&
      msg.completionStatus === "incomplete" &&
      msg.completionReason === "output_limit"
    ) {
      outputLimitRow = doc.createElement("div") as HTMLDivElement;
      outputLimitRow.className = "llm-message-interrupted-row";
      const note = doc.createElement("span") as HTMLSpanElement;
      note.className = "llm-message-interrupted-note";
      note.textContent = "⚠ Response reached the model’s output limit";
      outputLimitRow.appendChild(note);

      const originalEntry = getAvailableModelEntries().find(
        (entry) =>
          (msg.modelEntryId && entry.entryId === msg.modelEntryId) ||
          (!msg.modelEntryId &&
            entry.model === msg.modelName &&
            entry.providerLabel === msg.modelProviderLabel),
      );
      const continueButton = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      continueButton.type = "button";
      continueButton.className =
        "llm-message-action llm-message-output-limit-continue";
      continueButton.textContent = "Continue";
      const isLatestIncomplete = index === latestAssistantIndex;
      continueButton.disabled =
        !item || !originalEntry || !conversationIsIdle || !isLatestIncomplete;
      continueButton.title = !isLatestIncomplete
        ? "Only the latest response can be continued"
        : originalEntry
          ? "Continue with the original model profile"
          : "The original model profile is no longer available";
      continueButton.addEventListener("click", (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!item || !originalEntry || continueButton.disabled) return;
        const continueReasoning = getSelectedReasoningForItem(
          item.id,
          originalEntry.model,
          originalEntry.apiBase,
          originalEntry.providerProtocol,
          originalEntry.advanced?.profileOverride,
        );
        void retryLatestAssistantResponse(
          body,
          item,
          originalEntry.model,
          originalEntry.apiBase,
          originalEntry.apiKey,
          originalEntry.authMode,
          originalEntry.providerProtocol,
          originalEntry.entryId,
          originalEntry.providerLabel,
          continueReasoning,
          originalEntry.advanced,
          undefined,
          undefined,
          undefined,
          undefined,
          { continueIncomplete: true },
        );
      });
      outputLimitRow.appendChild(continueButton);
    }

    if (isUser && inlineEditEl) {
      wrapper.appendChild(inlineEditEl);
    } else {
      wrapper.appendChild(bubble);
    }
    wrapper.appendChild(meta);
    if (webchatStatusRow) wrapper.appendChild(webchatStatusRow);
    if (interruptedRow) wrapper.appendChild(interruptedRow);
    if (outputLimitRow) wrapper.appendChild(outputLimitRow);
    const existingTargetedWrapper = targetedMessageWrappers.get(msg);
    if (useTargetedRerender && existingTargetedWrapper) {
      const previousTrace = existingTargetedWrapper.querySelector<HTMLElement>(
        ".llm-agent-activity",
      );
      if (previousTrace) disposeAgentTrace(previousTrace);
      const previousAnswer = existingTargetedWrapper.querySelector<HTMLElement>(
        ".llm-assistant-answer",
      );
      if (previousAnswer) disposeStreamingMarkdown(previousAnswer);
      const expandedQuoteCards = collectExpandedQuoteCardKeys(
        existingTargetedWrapper,
      );
      // A completed ordinary Chat turn is no longer a streaming view.
      // Do not retain its retired wrapper when a targeted refresh finalizes it.
      const mounted = mountedAssistantViews.get(chatBox);
      if (mounted?.get(msg)?.wrapper === existingTargetedWrapper)
        mounted.delete(msg);
      existingTargetedWrapper.replaceWith(wrapper);
      restoreExpandedQuoteCards(wrapper, expandedQuoteCards);
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

  syncFloatingPlanProgress(chatBox, conversationKey);
  syncUserContextAlignmentWidths(body);
  syncConversationTurnNavigator(body, history, {
    conversationKey,
    targetedMessages: useTargetedRerender ? requestedRerenders : undefined,
  });

  restoreChatScrollAfterRender(conversationKey, chatBox, baselineSnapshot);
}

export function refreshConversationPanels(
  primaryBody: Element,
  primaryItem?: Zotero.Item | null,
  options: {
    includeChat?: boolean;
    includePanelState?: boolean;
    chatOptions?: RefreshChatOptions;
  } = {},
): void {
  const {
    includeChat = true,
    includePanelState = false,
    chatOptions,
  } = options;
  if (!primaryItem) {
    if (includeChat) {
      refreshChat(primaryBody, primaryItem, chatOptions);
    }
    if (includePanelState) {
      activeContextPanelStateSync.get(primaryBody)?.();
    }
    return;
  }

  const conversationKey = getConversationKey(primaryItem);
  const refreshedPanels = new Set<Element>();
  const refreshOne = (body: Element, item: Zotero.Item) => {
    if (!isPanelConversationCurrent(body, item)) return;
    const chatBox = body.querySelector(
      "#llm-chat-box",
    ) as HTMLDivElement | null;
    if (includeChat && !chatBox) return;
    const syncPanelState = activeContextPanelStateSync.get(body);
    const updatePanel = () => {
      if (includeChat) {
        refreshChat(body, item, chatOptions);
      }
      if (includePanelState && syncPanelState) {
        // Panel-state refreshes can run on a later frame, outside the event's
        // scroll guard. Resizing the composer and rebuilding previews must
        // preserve this viewport's reading position too, including mirrors.
        withScrollGuard(chatBox, conversationKey, syncPanelState);
      }
    };
    updatePanel();
    refreshedPanels.add(body);
  };

  refreshOne(primaryBody, primaryItem);

  for (const [body, getItem] of activeContextPanels.entries()) {
    if (!(body as Element).isConnected) {
      unregisterContextPanel(body);
      continue;
    }
    if (refreshedPanels.has(body)) continue;
    const item = getItem();
    if (!item) continue;
    if (getConversationKey(item) !== conversationKey) continue;
    refreshOne(body, item);
  }
}
