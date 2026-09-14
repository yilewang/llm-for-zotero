import type { ResolvedContextSource, SendQuestionOptions } from "./types";
import type { ConversationSystem, QuoteCitation } from "../../shared/types";
import type { WorkflowTestFinalRequestSnapshot } from "./workflowTestHooks";
import type { RuntimeConversationSystem } from "./runtimeSystemControls";

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

export type WorkflowTestApi = {
  reset: () => Promise<void>;
  enableLiveAgentSending: () => void;
  createPaperWithPdfFixture: (input: {
    title: string;
    pdfTitle: string;
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
  exerciseNativePlanReview: typeof import("./nativePlanReviewReplay").exerciseNativePlanReview;
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
  exerciseStreamingReplay: (input: {
    panelId: string;
    historyTurns: number;
    chunks: number;
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
  exerciseRebuiltPanelPlanApproval: (panelId: string) => Promise<{
    sendsAfterApproval: number;
    queuedAfterApproval: number;
    sendsAfterDispose: number;
  }>;
  /** Approve a reviewable plan the way the review card does and start its execution. */
  approvePlanForExecution: (input: {
    planId: string;
    revision: number;
    expectedDigest?: string;
  }) => Promise<{
    executionId: string;
    planDigest: string;
    activeTaskId?: string;
    provider: "original" | "codex" | "claude";
  }>;
  /** Flight 0: the research quality report and run timings for one execution. */
  researchFlightReport: (input: { executionId: string }) => Promise<{
    report: import("../../agent/research/flightReport").ResearchFlightReport;
    rendered: string;
  }>;
  exercisePanelDraftStateRefresh: (
    panelId: string,
    text: string,
  ) => Promise<WorkflowTestDraftRefreshDiagnostics>;
  selectPanelModelEntry: (
    panelId: string,
    entryId: string,
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
      actionContract?: import("../../agent/types").AgentActionContract;
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
  startNewStandaloneConversation: () => Promise<WorkflowTestStandaloneDiagnostics>;
  clickStandaloneReasoningOption: (label: string) => Promise<void>;
  getLastFinalRequest: () => WorkflowTestFinalRequestSnapshot | null;
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
