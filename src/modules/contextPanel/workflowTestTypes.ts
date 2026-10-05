import type { ResolvedContextSource, SendQuestionOptions } from "./types";
import type { ConversationSystem, QuoteCitation } from "../../shared/types";
import type { WorkflowTestFinalRequestSnapshot } from "./workflowTestHooks";
import type { RuntimeConversationSystem } from "./runtimeSystemControls";
import type { resolveRetrievalQueryPlan } from "../../services/retrieval/retrievalQueryPlan";
import type { RetrievalTimingReport } from "../../services/retrieval/retrievalTiming";
import type { LibraryTextIndexStatus } from "../../services/libraryTextIndex/scheduler";
import type { LibraryRetrieveResult } from "../../agent/services/libraryRetrieveService";

export type WorkflowTestFixture = {
  parentItemId: number;
  pdfAttachmentId: number;
  tempPdfPath: string;
};

export type WorkflowTestAttachmentFixture = {
  attachmentItemId: number;
  tempPath: string;
  title: string;
  filename: string;
  contentType: string;
};

export type WorkflowTestNoteFixture = WorkflowTestFixture & {
  noteItemId: number;
  noteText: string;
};

export type WorkflowTestStandaloneNoteFixture = {
  noteItemId: number;
  noteText: string;
};

export type WorkflowTestPanel = {
  panelId: string;
  itemId: number;
  contextSnapshot: ResolvedContextSource | null;
};

export type WorkflowTestRuntimeSystemToggle = {
  system: RuntimeConversationSystem;
  visible: boolean;
  active: boolean;
  disabled: boolean;
  ariaPressed: boolean;
};

export type WorkflowTestPermissionSurfaceDiagnostics = {
  provider: ConversationSystem | null;
  visible: boolean;
  compactLabel: string;
  accessibleName: string;
  disabled: boolean;
  expanded: boolean;
  menuVisible: boolean;
  rows: Array<{
    id: string;
    label: string;
    level: string;
    risk: string;
    disabled: boolean;
    accessibleName: string;
  }>;
};

export type WorkflowTestConfirmationDialogDiagnostics = {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive: boolean;
};

export type WorkflowTestDuplicatePanelSetupDiagnostics = {
  samePanelRoot: boolean;
  initializationGenerationBefore: string;
  initializationGenerationAfter: string;
  panelStateSyncBefore: boolean;
  panelStateSyncAfter: boolean;
  turnNavigatorCountBefore: number;
  turnNavigatorCountAfter: number;
};

export type WorkflowTestDraftRefreshDiagnostics = {
  webChatMode: boolean;
  inputBeforeRefresh: string;
  inputAfterRefresh: string;
};

export type WorkflowTestWebChatPdfChipState = {
  fullText: boolean;
  inactive: boolean;
  contentSource: string;
  paperItemId: number;
  contextItemId: number;
  modeOverride: string;
};

export type WorkflowTestWebChatPdfTurn = {
  question: string;
  outcome: "success" | "failed";
  webchatSendPdf: boolean;
  pdfContextItemIds: number[];
  modeBeforeOutcome: string;
  modeAfterOutcome: string;
  chipAfterTurn: WorkflowTestWebChatPdfChipState;
};

export type WorkflowTestLiveWebChatTurn = {
  question: string;
  outcome: "success" | "failed" | "cancelled" | null;
  webchatSendPdf: boolean;
  pdfContextItemIds: number[];
  chipAfterTurn: WorkflowTestWebChatPdfChipState;
  statusText: string;
  relayStatus: string;
  runState: string | null;
  completionReason: string | null;
  responseText: string;
  diagnostic: Record<string, unknown> | null;
};

/** One ordinary chat turn sent through the panel against a live provider. */
export type WorkflowTestLiveChatTurn = {
  answerText: string;
  /**
   * Every wrapper that was on screen while the turn streamed, other than the
   * turn's own prompt and answer, is still the same live node afterwards.
   */
  earlierWrappersPreserved: boolean;
  assistantFinalized: boolean;
  copyActionPresent: boolean;
  promptDeletable: boolean;
  promptEditable: boolean;
};

/**
 * Test-only read of one upstream conversation's turn state: the in-memory
 * messages, the stored message rows exactly as their columns hold them, and
 * the usage ledger rows.
 */
export type WorkflowTestChatTurnLifecycleState = {
  /** In-memory messages, JSON-cloned (undefined fields are absent). */
  memory: Array<Record<string, unknown>>;
  /** Stored message rows, one object per row, keyed by column name. */
  storedRows: Array<Record<string, unknown>>;
  usageRows: import("../../utils/usageStore").StoredUsageEvent[];
  requestPending: boolean;
  /** Increments each time a panel send flow settles. */
  sendSettledSequence: number;
};

export type WorkflowTestWebChatPdfToggleDiagnostics = {
  webChatMode: boolean;
  initialChip: WorkflowTestWebChatPdfChipState;
  initialPdfTurn: WorkflowTestWebChatPdfTurn;
  automaticPromptOnlyTurn: WorkflowTestWebChatPdfTurn;
  chipAfterToggleOn: WorkflowTestWebChatPdfChipState;
  toggleOnDefaultPrevented: boolean;
  toggleOnStatusText: string;
  failedPdfTurn: WorkflowTestWebChatPdfTurn;
  chipAfterToggleOff: WorkflowTestWebChatPdfChipState;
  toggleOffDefaultPrevented: boolean;
  toggleOffStatusText: string;
  explicitPromptOnlyTurn: WorkflowTestWebChatPdfTurn;
  mirrorPanel: {
    initialChip: WorkflowTestWebChatPdfChipState;
    afterInitialPdfTurn: WorkflowTestWebChatPdfChipState;
    afterAutomaticPromptOnlyTurn: WorkflowTestWebChatPdfChipState;
    afterToggleOn: WorkflowTestWebChatPdfChipState;
    afterFailedPdfTurn: WorkflowTestWebChatPdfChipState;
    afterToggleOff: WorkflowTestWebChatPdfChipState;
    afterExplicitPromptOnlyTurn: WorkflowTestWebChatPdfChipState;
  } | null;
};

export type WorkflowTestRuntimeGeometry = {
  containerWidth: number;
  fontScale: number;
  runtimeWidth: number;
  runtimeButtonWidths: number[];
  runtimeIntersectsLeadingContent: boolean;
  runtimeIntersectsTrailingContent: boolean;
  runtimeTrailingOverlapPx: number;
  runtimeWithinContainer: boolean;
  trailingContentWithinContainer: boolean;
  deleteButtonIconOnly: boolean;
  centeredContentOffset: number;
};

export type WorkflowTestFooterLayout = {
  statusHeight: number;
  statusLineHeight: number;
  statusTop: number;
  controlsTop: number;
  statusTextTop: number;
  permissionTextTop: number;
  statusTextBottom: number;
  permissionTextBottom: number;
  statusWrapped: boolean;
  controlsPinnedToFirstLine: boolean;
  textGlyphsAligned: boolean;
};

export type WorkflowTestStandaloneComposerResizeDiagnostics = {
  heightBeforeDrag: number;
  heightAfterDrag: number;
  heightAfterInput: number;
  manualHeightMarked: boolean;
};

export type WorkflowTestDiagnostics = {
  panelId?: string;
  activeItemId?: number;
  conversationKey?: number;
  panelConversationKey?: number;
  conversationKind?: string;
  runtimeMode?: string;
  conversationSystem?: string;
  noteId?: number;
  noteKind?: string;
  noteParentItemId?: number;
  contextSnapshot?: ResolvedContextSource | null;
  chipText: string[];
  composerPaperContextKeys: string[];
  selectedContextLabels: string[];
  composerCollectionLabels: string[];
  composerTagLabels: string[];
  sentContextBadgeLabels: string[];
  sentContextItemLabels: string[];
  historyNewVisible?: boolean;
  historyToggleVisible?: boolean;
  runtimeSystemToggles: WorkflowTestRuntimeSystemToggle[];
  webChatMode?: boolean;
  modelButtonDisabled?: boolean;
  inputValue?: string;
  statusText?: string;
  startPageActive?: boolean;
  statusBarVisible?: boolean;
  permissionControlVisible?: boolean;
  permissionModeText?: string;
  permissionModeFontSize?: string;
  statusFontSize?: string;
  contextGaugeWidth?: number;
  contextGaugeHeight?: number;
  contextGaugeInnerWidth?: number;
  contextGaugeInnerBackground?: string;
  panelBackground?: string;
  tokenUsageText?: string;
  messageText?: string;
  lastSend: SendQuestionOptions | null;
  lastFinalRequest: WorkflowTestFinalRequestSnapshot | null;
};

export type WorkflowTestAssistantRenderResult = {
  renderedText: string;
  quoteCardBodiesBeforeExpansion: string[];
  quoteCardBodies: string[];
  quoteCardPreviewTexts: string[];
  quoteCardStatuses: string[];
  quoteCardCitationTexts: string[];
  quoteCardVerticalMargins: Array<{ top: number; bottom: number }>;
};

export type WorkflowTestTargetedQuoteRefreshResult = {
  messageCount: number;
  assistantMessageCount: number;
  quoteCardCount: number;
  unchangedWrapperCount: number;
  replacedWrapperCount: number;
  targetWasReplaced: boolean;
  targetNotSourceCardCount: number;
  targetStrongBodyCount: number;
  /**
   * Probe for the reader's view: a quote card expanded in a later message must
   * survive a targeted re-render that also changes the height of an earlier
   * message, and it must stay where the reader left it in the viewport.
   */
  scrollStability: {
    chatBoxScrollable: boolean;
    earlierWrapperHeightDelta: number;
    expandedBeforeRerender: boolean;
    expandedAfterRerender: boolean;
    expandedBodyTextAfterRerender: string;
    /** Cards in the expanded message that share the clicked card's citation id. */
    sameCitationCards: number;
    /** How far the card moved between the reader's scroll and the next frames, before any click. */
    settleDrift: number;
    cardTopDelta: number;
    scrollTopDelta: number;
    diagnostics: Record<string, unknown>;
  };
};

export type WorkflowTestStandaloneDiagnostics = {
  activeTab?: "paper" | "open" | null;
  sidebarState?: "expanded" | "collapsed";
  customTitlebar: boolean;
  collapseToggleHost?: "sidebar-header" | "tab-row";
  sidebarWidthPx?: number;
  sidebarFlyout?: "open" | "closed";
  sidebarPanelWidthPx?: number;
  sidebarPanelOpacity?: number;
  sidebarContent?: {
    labels: Array<{ text: string; width: number; opacity: number }>;
    historyHeight: number;
    historyText: string;
    actionWidths: number[];
  };
  windowButtonsWidthPx?: number;
  sidebarActionOrder: string[];
  sidebarPrimaryActionOrder: string[];
  titleActionLabels: string[];
  alignment?: {
    toolbarCenterDeltaPx: number;
    titleCenterDeltaPx: number;
    toolbarControlCenterDeltaPx: number;
    titleTextCenterDeltaPx: number;
  };
  conversationKey?: number;
  activeItemId?: number;
  rawContextItemId?: number;
  basePaperItemId?: number;
  contextItemId?: number;
  conversationKind?: string;
  runtimeMode?: string;
  conversationSystem?: string;
  titleText?: string;
  chipText: string[];
  composerPaperContextKeys: string[];
  selectedContextLabels: string[];
  composerCollectionLabels: string[];
  composerTagLabels: string[];
  messageText?: string;
  paperTabText?: string;
  openTabText?: string;
  statusText?: string;
  runtimeSystemToggles: WorkflowTestRuntimeSystemToggle[];
  lastSend: SendQuestionOptions | null;
  lastFinalRequest: WorkflowTestFinalRequestSnapshot | null;
};

export type WorkflowTestReaderSelectionTrackingDiagnostics = {
  before: number;
  afterDrop: number;
  afterHealthCheck: number;
  markerPresent: boolean;
  markerLive: boolean;
  elapsedMs: number;
};

export type WorkflowTestReaderPopupRoutingDiagnostics = {
  firstReaderTabId: string;
  secondReaderTabId: string;
  addTextButtonLabel: string;
  firstConversationHasText: boolean;
  secondConversationHasText: boolean;
};

export type WorkflowTestReaderPopupStandaloneRoutingDiagnostics = {
  readerTabId: string;
  addTextButtonLabel: string;
  standaloneConversationKey: number;
  standaloneConversationHasText: boolean;
  standalonePreviewHasText: boolean;
};

export type WorkflowTestHighlightAwareRetrievalDiagnostics = {
  trigger: "popup" | "action-bar";
  readerItemId: number;
  addTextButtonLabel: string;
  immediatePreviewText: string;
  clickToSelectedContextMs: number;
  selectedContext: NonNullable<
    SendQuestionOptions["selectedTextContexts"]
  >[number];
  resolvedAnchor: NonNullable<
    SendQuestionOptions["resolvedSelectedTextAnchors"]
  >[number];
  lastSend: SendQuestionOptions;
  lastFinalRequest: WorkflowTestFinalRequestSnapshot;
};

export type WorkflowTestPendingDeletionState = {
  pendingCount: number;
  pendingConversationKeys: number[];
  persistedRowCount: number;
};

export type WorkflowTestPendingSendDeleteResult = {
  conversationKeyBefore: number;
  conversationKeyAfter?: number;
  requestPendingBeforeClick: boolean;
  requestPendingAfterClick: boolean;
  pendingDeletionQueued: boolean;
  statusText: string;
};

export type WorkflowTestHistoryRow = {
  conversationKey: number;
  title: string;
};

export type WorkflowTestSeededTurn = {
  conversationKey: number;
  userTimestamp: number;
  assistantTimestamp: number;
};

export type WorkflowTestHistorySearchResult = {
  entries: WorkflowTestHistoryRow[];
  previews: string[];
};

export type WorkflowTestConversationPersistenceSnapshot = {
  system: ConversationSystem;
  conversationKey: number;
  catalogRows: number;
  messageRows: number;
  searchIndexRows: number;
  registryRows: number;
  forkSourceRows: number;
  forkTargetRows: number;
  cleanupJobRows: number;
  pendingDeletionRows: number;
};

export type WorkflowTestStaleAgentTraceIsolationResult = {
  paperAConversationKey: number;
  paperBConversationKey: number;
  beforeTraceResolution: WorkflowTestDiagnostics;
  afterTraceResolution: WorkflowTestDiagnostics;
  afterPaperBAppend: WorkflowTestDiagnostics;
  traceCached: boolean;
  paperAMessageRowsBeforePaperBAppend: number;
  paperAMessageRowsAfterPaperBAppend: number;
  paperBMessageRowsBeforePaperBAppend: number;
  paperBMessageRowsAfterPaperBAppend: number;
};

export type WorkflowTestCrossPaperHistoryIsolationResult = {
  paperAConversationKey: number;
  paperBConversationKey: number;
  selectedLibraryItemID: number;
  foreignMutationObserved: boolean;
  panelAConversationKey: number;
  panelABasePaperItemID: number;
  panelARawContextItemID: number;
  panelAMessageText: string;
  requestConversationKey: number;
  requestItemID: number;
  addTextStoredForA: boolean;
  addTextStoredForB: boolean;
  paperBMessageRowsBefore: number;
  paperBMessageRowsAfter: number;
};

export type WorkflowTestConversationHistoryTexts = {
  memory: Array<{ role: string; text: string }>;
  stored: Array<{ role: string; text: string }>;
};

/**
 * One library retrieval run by the workflow bench: wall-clock time, the
 * phase report the service recorded, and what came back.
 */
export type LibraryRetrieveBenchResult = {
  elapsedMs: number;
  timing: RetrievalTimingReport | null;
  paperItemIds: number[];
  snippetItemIds: number[];
  snippetTexts: string[];
  snippetCount: number;
  warnings: string[];
  queryCoverage: LibraryRetrieveResult["resourcePool"]["queryCoverage"];
};

export type WorkflowTestApi = {
  planRetrievalQuery: typeof resolveRetrievalQueryPlan;
  libraryRetrieveBench: (input: {
    query: string;
    collectionIds?: number[];
    depth?: "evidence" | "verify";
    intent?: "enumerate" | "verify" | "summarize";
  }) => Promise<LibraryRetrieveBenchResult>;
  getRecentRetrievalTimings: (limit?: number) => RetrievalTimingReport[];
  // Library text index status for the user library.
  libraryTextIndexStatus: () => Promise<LibraryTextIndexStatus>;
  // Overrides the user-idle signal that gates the prefetch lane (null = real).
  setLibraryTextIndexUserIdle: (idle: boolean | null) => Promise<void>;
  // Forces user idle so prefetch drains, then waits until nothing is runnable.
  waitForLibraryTextIndexIdle: (timeoutMs: number) => Promise<boolean>;
  // The plugin's own index instances (a test bundle's imports are separate
  // module copies with their own scheduler and connection).
  libraryTextIndexCoverage: (
    attachmentIds: number[],
  ) => Promise<{ indexed: number[]; missing: number[]; failed: number[] }>;
  forgetLibraryTextIndexDocuments: (attachmentIds: number[]) => Promise<void>;
  reconcileLibraryTextIndex: () => Promise<{
    enqueued: number;
    removed: number;
    stale: number;
    skippedForBudget: number;
  }>;
  // Loads one attachment's text through the question path (fires write-through).
  loadPaperContextForTest: (attachmentId: number) => Promise<void>;
  // Drops every loaded paper text and retrieval candidate so the next
  // retrieval starts as if no paper had been read this session.
  clearPaperTextCacheForBench: () => Promise<void>;
  checkProviderConversationTransport: (params: {
    conversationKey: number;
    model: string;
    apiBase: string;
    apiKey: string;
    providerProtocol:
      | "openai_chat_compat"
      | "anthropic_messages"
      | "responses_api";
  }) => Promise<{
    chat: string;
    stream: string;
    agent: string;
    continuation: string;
  }>;
  mountPublicationTrace(
    documentId: string,
    text: string,
  ): {
    root: HTMLElement;
    deliver(conversationKey: number): Promise<void>;
    dispose(): void;
  };
  mountAgentActivityTrace(message: import("./types").Message): {
    root: HTMLElement;
    render(
      events: import("../../agent/types").AgentRunEventRecord[],
      options?: { rebuild?: boolean; streaming?: boolean },
    ): void;
    dispose(): void;
  };
  reset: () => Promise<void>;
  enableLiveAgentSending: () => void;
  createPaperWithPdfFixture: (input: {
    title: string;
    pdfTitle?: string;
    pages?: string[];
  }) => Promise<WorkflowTestFixture>;
  trashWorkflowItem: (itemId: number) => Promise<void>;
  setWorkflowProviderSession: (
    system: ConversationSystem,
    conversationKey: number,
    providerSessionId: string,
  ) => Promise<void>;
  getWorkflowConversationPersistenceSnapshot: (
    system: ConversationSystem,
    conversationKey: number,
  ) => Promise<WorkflowTestConversationPersistenceSnapshot>;
  exerciseStaleAgentTracePanelIsolation: (input: {
    panelId: string;
    paperBItemId: number;
    paperAMarker: string;
    paperBMarker: string;
    paperBAppendMarker: string;
    runId: string;
  }) => Promise<WorkflowTestStaleAgentTraceIsolationResult>;
  exerciseCrossPaperHistoryReturnIsolation: (input: {
    panelAId: string;
    panelBId: string;
    paperAItemId: number;
    paperAAttachmentItemId: number;
    paperBItemId: number;
    paperAMarker: string;
    paperBMarker: string;
    promptMarker: string;
    selectedText: string;
    activation?: "pointer" | "keyboard" | "history-row";
    delaySelection?: boolean;
  }) => Promise<WorkflowTestCrossPaperHistoryIsolationResult>;
  createStandaloneAttachmentFixture: (input: {
    title: string;
    filename: string;
    contentType: string;
    text?: string;
  }) => Promise<WorkflowTestAttachmentFixture>;
  createItemNoteFixture: (input: {
    title: string;
    pdfTitle: string;
    noteHtml: string;
  }) => Promise<WorkflowTestNoteFixture>;
  createStandaloneNoteFixture: (input: {
    noteHtml: string;
  }) => Promise<WorkflowTestStandaloneNoteFixture>;
  renderPanelForItem: (itemId: number) => Promise<WorkflowTestPanel>;
  refreshActiveConversationPanels: (conversationKey?: number) => void;
  exerciseNativeQuestionReview: (
    panelId: string,
  ) => ReturnType<
    typeof import("./nativePlanReviewReplay").exerciseNativeQuestionReview
  >;
  exercisePlanHistoryReplay: (input: {
    panelId: string;
    historyTurns: number;
  }) => Promise<
    Awaited<
      ReturnType<typeof import("./planHistoryReplay").exercisePlanHistoryReplay>
    >
  >;
  exerciseAgentDeliveryReplay: (input: {
    panelId: string;
    failFinalRefresh?: boolean;
  }) => ReturnType<
    typeof import("./agentDeliveryReplay").exerciseAgentDeliveryReplay
  >;
  /** A long job over a folder's papers; only the model is scripted. */
  exerciseLongJobReplay: (input: {
    panelId: string;
    collection: import("../../shared/types").CollectionContextRef;
    papers: Array<{ itemId: number; title: string }>;
    inputTokenCap: number;
  }) => ReturnType<typeof import("./longJobReplay").exerciseLongJobReplay>;
  /**
   * A note job over a folder's papers, stopped midway, the agent's state
   * reloaded as at startup, then "continue"; only the model is scripted.
   */
  exerciseLongJobNoteResume: (input: {
    panelId: string;
    collection: import("../../shared/types").CollectionContextRef;
    papers: Array<{ itemId: number; title: string }>;
    inputTokenCap: number;
    stopAfterNotes: number;
  }) => ReturnType<typeof import("./longJobReplay").exerciseLongJobNoteResume>;
  /**
   * A note job whose one note_write_batch is stopped while it writes, the
   * agent's state reloaded as at startup, then "continue"; only the model is
   * scripted.
   */
  exerciseLongJobBatchStop: (input: {
    panelId: string;
    collection: import("../../shared/types").CollectionContextRef;
    papers: Array<{ itemId: number; title: string }>;
    inputTokenCap: number;
    stopAfterNotes: number;
  }) => ReturnType<typeof import("./longJobReplay").exerciseLongJobBatchStop>;
  exerciseStreamingReplay: (input: {
    panelId: string;
    historyTurns: number;
    chunks: number;
    runMode?: "agent" | "chat";
  }) => Promise<import("./streamingReplay").StreamingReplayResult>;
  createCodexStreamingScrollReplay: (
    panelId: string,
    options?: { tightList?: boolean },
  ) => ReturnType<
    typeof import("./codexStreamingScrollReplay").createCodexStreamingScrollReplay
  >;
  exerciseChatRenderingLifecycle: (
    panelId: string,
  ) => ReturnType<
    typeof import("./chatRenderingReplay").exerciseChatRenderingLifecycle
  >;
  exerciseCompletedChatTurnRefresh: (
    panelId: string,
  ) => ReturnType<
    typeof import("./chatRenderingReplay").exerciseCompletedChatTurnRefresh
  >;
  memoryProbeInspect: (input: {
    label: string;
    gc?: boolean;
  }) => Promise<import("./chatMemoryReplay").MemoryProbeSample>;
  exerciseChatModeStreamingTurn: (input: {
    panelId?: string;
    turnIndex: number;
    chunks: number;
  }) => Promise<import("./chatMemoryReplay").ChatModeTurnResult>;
  startTaskProgressReplay: (
    input: {
      /** A synthetic panel; otherwise the visible native panel of `surface`. */
      panelId?: string;
      surface?: "embedded" | "standalone";
    } & import("./streamingReplay").TaskProgressReplayInput,
  ) => Promise<import("./streamingReplay").TaskProgressReplayHandle>;
  /** A built-in action through the production runner, scripted. */
  startTaskProgressAction: (input: {
    panelId?: string;
    surface?: "embedded" | "standalone";
    actionName: string;
  }) => Promise<import("./taskProgressReplay").TaskProgressActionHandle>;
  /** A native Codex turn through the production callbacks. */
  startCodexTaskProgressReplay: (input: {
    panelId?: string;
    surface?: "embedded" | "standalone";
    user: Partial<import("./types").Message>;
  }) => Promise<import("./taskProgressReplay").CodexTaskProgressReplayHandle>;
  /** Store turns (messages and run traces) in the panel's conversation. */
  seedTaskProgressConversation: (input: {
    panelId?: string;
    surface?: "embedded" | "standalone";
    turns: import("./taskProgressReplay").TaskProgressStoredTurn[];
  }) => Promise<{ conversationKey: number; runIds: string[] }>;
  /** Drop the record and loaded messages, then show the conversation again. */
  reopenTaskProgressConversation: (input: {
    panelId?: string;
    surface?: "embedded" | "standalone";
  }) => Promise<void>;
  /** Fill a panel's context bar (papers, folders, tags) and redraw it. */
  setTaskProgressComposerContexts: (input: {
    panelId?: string;
    surface?: "embedded" | "standalone";
    paperContexts?: import("../../shared/types").PaperContextRef[];
    collectionContexts?: import("../../shared/types").CollectionContextRef[];
    tagContexts?: import("../../shared/types").TagContextRef[];
  }) => Promise<void>;
  /** A panel's context bar: its papers, folder exclusions and chip labels. */
  readTaskProgressComposerContexts: (input: {
    panelId?: string;
    surface?: "embedded" | "standalone";
  }) => Promise<{
    paperItemIds: number[];
    collections: Array<{ collectionId: number; excludedItemIds: number[] }>;
    chipLabels: string[];
  }>;
  /** Repaint every mounted Task progress view now. */
  flushTaskProgress: () => void;
  /** Every mounted Task progress panel, and whether its window or element is gone. */
  listTaskProgressPanels: () => Array<{
    conversationKey: number | null;
    gone: boolean;
    documentURI: string;
  }>;
  getTaskProgressSnapshot: (conversationKey: number) => {
    runState: string;
    turnIndex: number;
    label: string;
    scopeKeys: string[];
    listingLoaded: boolean;
    planSeen: boolean;
    hydrated: boolean;
    checklist: {
      source: "action" | "codex" | "outcomes";
      title: string;
      steps: Array<{
        label: string;
        status: string;
        detail?: string;
        /** Set on a step that is a run's outcome (a declared part). */
        outcome?: import("./taskProgress/store").TaskProgressOutcomeStep;
      }>;
      outcome?: string;
      detail?: string;
      /** How the run that owns an outcomes checklist ended. */
      end?: string;
    } | null;
    paperStates: Record<string, string>;
    /** The questions and actions the drawer's history keeps, oldest first. */
    questions: Array<{
      turn: number;
      runId?: string;
      text?: string;
      title?: string;
      checklistSource?: "action" | "codex" | "outcomes";
    }>;
    /** Each paper row's reads over every turn, by `libraryID:itemId`. */
    paperRows: Record<
      string,
      {
        state: string;
        title?: string;
        reads: Array<{
          turnIndex?: number;
          toolName: string;
          granularity: string;
          method?: string;
          label?: string;
          snippet?: string;
          whyMatched?: string;
        }>;
      }
    >;
  } | null;
  exerciseNativeStreamingReplay: (input: {
    surface: "embedded" | "standalone";
    historyTurns: number;
    chunks: number;
    runMode?: "agent" | "chat";
  }) => Promise<import("./streamingReplay").StreamingReplayResult>;
  exerciseBackgroundAgentPublication: (input: {
    panelId: string;
    paperBItemId: number;
    invalidateConversation?: boolean;
  }) => Promise<{
    sourceConversationKey: number;
    otherConversationKey: number;
    persistedConversationKeys: number[];
    exactMarkdown: boolean;
    outboxStatus?: string;
    otherPanelContainsDocument: boolean;
  }>;
  renderStartupPanelForItem: (itemId: number) => Promise<WorkflowTestPanel>;
  startNewPanelConversation: (
    panelId: string,
    options?: { allowReusedDraft?: boolean },
  ) => Promise<WorkflowTestDiagnostics>;
  togglePanelConversationMode: (
    panelId: string,
  ) => Promise<WorkflowTestDiagnostics>;
  exerciseDuplicatePanelSetup: (
    panelId: string,
  ) => Promise<WorkflowTestDuplicatePanelSetupDiagnostics>;
  exercisePanelDraftStateRefresh: (
    panelId: string,
    text: string,
  ) => Promise<WorkflowTestDraftRefreshDiagnostics>;
  selectPanelModelEntry: (
    panelId: string,
    entryId: string,
    options?: { expectWebChat?: boolean },
  ) => Promise<WorkflowTestDiagnostics>;
  exerciseWebChatPdfToggleWorkflow: (
    panelId: string,
    mirrorPanelId?: string,
  ) => Promise<WorkflowTestWebChatPdfToggleDiagnostics>;
  toggleWebChatPdfChip: (
    panelId: string,
  ) => Promise<WorkflowTestWebChatPdfChipState>;
  sendLiveWebChatTurn: (
    panelId: string,
    question: string,
    timeoutMs?: number,
  ) => Promise<WorkflowTestLiveWebChatTurn>;
  sendLiveChatTurn: (
    panelId: string,
    text: string,
    timeoutMs?: number,
  ) => Promise<WorkflowTestLiveChatTurn>;
  /**
   * Starts the panel's own send for `text` and resolves once the send flow
   * has handed the request to the real `sendQuestion` (not when the turn
   * ends). `overrides` are copied onto the captured send options first.
   */
  startPanelChatSend: (
    panelId: string,
    text: string,
    overrides?: Pick<
      SendQuestionOptions,
      "forcedSkillIds" | "selectedTagContexts"
    >,
  ) => Promise<{ conversationKey: number; sendSettledSequenceBefore: number }>;
  /**
   * Runs the real `retryLatestAssistantResponse` for the panel with
   * `entryId` (default: the selected model entry), as the retry model menu
   * does, and resolves with its return value when the retry ends.
   */
  retryLatestPanelResponse: (
    panelId: string,
    entryId?: string,
  ) => Promise<unknown>;
  readChatTurnLifecycle: (
    conversationKey: number,
  ) => Promise<WorkflowTestChatTurnLifecycleState>;
  seedPanelStoredUserMessage: (
    panelId: string,
    text: string,
    contexts?: Pick<
      import("./types").Message,
      | "paperContexts"
      | "pdfPaperContexts"
      | "fullTextPaperContexts"
      | "selectedCollectionContexts"
      | "selectedTagContexts"
    >,
  ) => Promise<WorkflowTestDiagnostics>;
  clickPanelSystemToggle: (
    panelId: string,
    system: RuntimeConversationSystem,
  ) => Promise<WorkflowTestDiagnostics>;
  clickPanelRuntimeModeToggle: (
    panelId: string,
  ) => Promise<WorkflowTestDiagnostics>;
  clickPanelSystemTogglesRapidly: (
    panelId: string,
    systems: RuntimeConversationSystem[],
  ) => Promise<WorkflowTestDiagnostics>;
  measurePanelRuntimeGeometry: (
    panelId: string,
    input: { width: number; fontScale: number },
  ) => Promise<WorkflowTestRuntimeGeometry>;
  measurePanelFooterLayout: (
    panelId: string,
    input: { width: number; statusText: string },
  ) => Promise<WorkflowTestFooterLayout>;
  selectNoteEditorText: (panelId: string, text: string) => Promise<void>;
  ask: (panelId: string, text: string) => Promise<SendQuestionOptions>;
  renderAssistantForPanel: (
    panelId: string,
    input: {
      text: string;
      quoteCitations?: QuoteCitation[];
    },
  ) => Promise<WorkflowTestAssistantRenderResult>;
  renderDocumentForPanel: (
    panelId: string,
    document: import("../../agent/documents/types").PlanDocument,
    openLargerView: boolean,
  ) => boolean;
  renderToolResultForPanel: (
    panelId: string,
    result: import("../../agent/types").AgentToolResult,
    options?: {
      priorResults?: import("../../agent/types").AgentToolResult[];
      documentId?: string;
      userText?: string;
    },
  ) => HTMLElement | null;
  renderPendingActionForPanel: (
    panelId: string,
    pending: {
      requestId: string;
      action: import("../../agent/types").AgentPendingAction;
    },
  ) => Promise<import("../../agent/types").AgentConfirmationResolution>;
  exerciseTargetedQuoteRefresh: (
    panelId: string,
  ) => Promise<WorkflowTestTargetedQuoteRefreshResult>;
  openStandaloneForItem: (
    itemId: number,
  ) => Promise<WorkflowTestStandaloneDiagnostics>;
  openStandaloneForLibraryAfterRestart: () => Promise<WorkflowTestStandaloneDiagnostics>;
  clickStandaloneTab: (
    tab: "paper" | "open",
  ) => Promise<WorkflowTestStandaloneDiagnostics>;
  toggleStandaloneSidebar: () => Promise<WorkflowTestStandaloneDiagnostics>;
  hoverStandaloneSidebarToggle: () => Promise<WorkflowTestStandaloneDiagnostics>;
  clickStandaloneSystemToggle: (
    system: RuntimeConversationSystem,
  ) => Promise<WorkflowTestStandaloneDiagnostics>;
  clickStandaloneSystemTogglesRapidly: (
    systems: RuntimeConversationSystem[],
  ) => Promise<WorkflowTestStandaloneDiagnostics>;
  measureStandaloneRuntimeGeometry: (input: {
    width: number;
    fontScale: number;
  }) => Promise<WorkflowTestRuntimeGeometry>;
  exerciseStandaloneComposerManualResize: () => Promise<WorkflowTestStandaloneComposerResizeDiagnostics>;
  askStandalone: (text: string) => Promise<SendQuestionOptions>;
  withPendingStandaloneSend: (
    text: string,
    inspect: () => Promise<void>,
  ) => Promise<void>;
  startNewStandaloneConversation: () => Promise<WorkflowTestStandaloneDiagnostics>;
  clickStandaloneReasoningOption: (label: string) => Promise<void>;
  getLastFinalRequest: () => WorkflowTestFinalRequestSnapshot | null;
  /** Test-only read of a conversation's turns, in memory and as stored. */
  getConversationHistoryTexts: (
    conversationKey: number,
  ) => Promise<WorkflowTestConversationHistoryTexts>;
  seedStandaloneUserMessage: (
    text: string,
  ) => Promise<WorkflowTestStandaloneDiagnostics>;
  seedStandaloneConversation: (
    turns: Array<
      { role: "user" | "assistant"; text: string } & Partial<
        import("./types").Message
      >
    >,
  ) => Promise<WorkflowTestStandaloneDiagnostics>;
  resizeStandaloneWindow: (
    width: number,
    height: number,
  ) => Promise<{ innerWidth: number; innerHeight: number }>;
  captureStandaloneScreenshot: (filePath: string) => Promise<string>;
  observeCitationNavigationFocus: (
    button: HTMLElement,
    options?: {
      forceViewerFallbackForItemId?: number;
      linkTargetItemId?: number;
    },
  ) => Promise<{
    started: boolean;
    finished: boolean;
    focusRequests: number;
    diagnostics: string[];
  }>;
  notifyStandaloneItemChanged: (
    itemId: number | null,
  ) => Promise<WorkflowTestStandaloneDiagnostics>;
  notifyStandaloneItemChanges: (
    itemIds: number[],
  ) => Promise<WorkflowTestStandaloneDiagnostics>;
  addItemsAsStandaloneContext: (
    itemIds: number[],
  ) => Promise<WorkflowTestStandaloneDiagnostics>;
  getStandaloneDiagnostics: () => Promise<WorkflowTestStandaloneDiagnostics>;
  closeStandalone: () => Promise<void>;
  getLastSend: () => SendQuestionOptions | null;
  getDiagnostics: (panelId?: string) => Promise<WorkflowTestDiagnostics>;
  configurePermissionCatalogs: (input?: { delayFirstCodex?: boolean }) => void;
  resolveDelayedCodexPermissionCatalog: () => Promise<void>;
  getPanelPermissionSurface: (
    panelId: string,
  ) => WorkflowTestPermissionSurfaceDiagnostics;
  clickPanelPermissionToggle: (
    panelId: string,
  ) => Promise<WorkflowTestPermissionSurfaceDiagnostics>;
  clickPanelPermissionOption: (
    panelId: string,
    permissionId: string,
  ) => Promise<WorkflowTestPermissionSurfaceDiagnostics>;
  getPanelConfirmationDialog: (
    panelId: string,
  ) => WorkflowTestConfirmationDialogDiagnostics;
  respondToPanelConfirmationDialog: (
    panelId: string,
    confirmed: boolean,
  ) => Promise<WorkflowTestPermissionSurfaceDiagnostics>;
  getStandalonePermissionSurface: () => WorkflowTestPermissionSurfaceDiagnostics;
  clickStandalonePermissionToggle: () => Promise<WorkflowTestPermissionSurfaceDiagnostics>;
  clickStandalonePermissionOption: (
    permissionId: string,
  ) => Promise<WorkflowTestPermissionSurfaceDiagnostics>;
  exerciseReaderSelectionTrackingRecovery: () => Promise<WorkflowTestReaderSelectionTrackingDiagnostics>;
  exerciseReaderPopupActiveTabRouting: (input: {
    firstPanelId: string;
    firstAttachmentItemId: number;
    secondPanelId: string;
    secondAttachmentItemId: number;
    pageIndex: number;
    selectedText: string;
  }) => Promise<WorkflowTestReaderPopupRoutingDiagnostics>;
  exerciseReaderPopupStandaloneRouting: (input: {
    attachmentItemId: number;
    pageIndex: number;
    selectedText: string;
  }) => Promise<WorkflowTestReaderPopupStandaloneRoutingDiagnostics>;
  exerciseHighlightAwareContextRetrieval: (input: {
    panelId: string;
    attachmentItemId: number;
    pageIndex: number;
    selectedText: string;
    question: string;
    trigger: "popup" | "action-bar";
  }) => Promise<WorkflowTestHighlightAwareRetrievalDiagnostics>;
  cleanupFixture: (
    fixture:
      | WorkflowTestFixture
      | WorkflowTestAttachmentFixture
      | WorkflowTestNoteFixture
      | WorkflowTestStandaloneNoteFixture,
  ) => Promise<void>;
  listPanelHistory: (panelId: string) => Promise<WorkflowTestHistoryRow[]>;
  deletePanelHistoryConversation: (
    panelId: string,
    conversationKey: number,
  ) => Promise<void>;
  clickPanelDelete: (panelId: string) => Promise<void>;
  exercisePanelDeleteDuringPendingSend: (
    panelId: string,
    text: string,
  ) => Promise<WorkflowTestPendingSendDeleteResult>;
  seedPanelStoredTurn: (
    panelId: string,
    userText: string,
    assistantText: string,
    assistant?: Partial<import("./types").Message>,
  ) => Promise<WorkflowTestSeededTurn>;
  deletePanelTurn: (
    panelId: string,
    userTimestamp: number,
    assistantTimestamp: number,
  ) => Promise<void>;
  clickPanelUndo: (panelId: string) => Promise<void>;
  isPanelUndoToastVisible: (panelId: string) => Promise<boolean>;
  getPanelVisibleMessageCount: (panelId: string) => Promise<number>;
  remountPanel: (panelId: string) => Promise<WorkflowTestPanel>;
  getPendingDeletionState: () => Promise<WorkflowTestPendingDeletionState>;
  sweepPendingDeletionsAsRestart: () => Promise<void>;
  searchPanelHistory: (
    panelId: string,
    query: string,
  ) => Promise<WorkflowTestHistorySearchResult>;
  failNextPendingTurnFinalizes: (count: number) => Promise<void>;
  forceWebChatSessionAnchorFailures: (count: number) => Promise<void>;
  askCapturingFinalRequest: (
    panelId: string,
    text: string,
  ) => Promise<WorkflowTestFinalRequestSnapshot>;
  simulateProviderContextUsage: (
    panelId: string,
    usage: {
      contextTokens: number;
      contextWindow?: number;
      contextWindowIsAuthoritative?: boolean;
    },
  ) => Promise<WorkflowTestDiagnostics>;
  setWorkflowModelInputCap: (
    panelId: string,
    entryId: string,
    inputTokenCap: number,
  ) => Promise<WorkflowTestDiagnostics>;
};
