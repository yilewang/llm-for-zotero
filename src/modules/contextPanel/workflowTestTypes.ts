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

export type WorkflowTestDuplicatePanelSetupDiagnostics = {
  samePanelRoot: boolean;
  initializationGenerationBefore: string;
  initializationGenerationAfter: string;
  panelStateSyncBefore: boolean;
  panelStateSyncAfter: boolean;
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
  inputValue?: string;
  statusText?: string;
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
};

export type WorkflowTestStandaloneDiagnostics = {
  activeTab?: "paper" | "open" | null;
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

export type WorkflowTestApi = {
  reset: () => Promise<void>;
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
  selectNoteEditorText: (panelId: string, text: string) => Promise<void>;
  ask: (panelId: string, text: string) => Promise<SendQuestionOptions>;
  renderAssistantForPanel: (
    panelId: string,
    input: {
      text: string;
      quoteCitations?: QuoteCitation[];
    },
  ) => Promise<WorkflowTestAssistantRenderResult>;
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
