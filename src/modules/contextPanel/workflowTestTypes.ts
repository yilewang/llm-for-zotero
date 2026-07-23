import type { ResolvedContextSource, SendQuestionOptions } from "./types";
import type { QuoteCitation } from "../../shared/types";
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
  clearButtonCompact: boolean;
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
  conversationSystem?: string;
  noteId?: number;
  noteKind?: string;
  noteParentItemId?: number;
  contextSnapshot?: ResolvedContextSource | null;
  chipText: string[];
  selectedContextLabels: string[];
  historyNewVisible?: boolean;
  historyToggleVisible?: boolean;
  runtimeSystemToggles: WorkflowTestRuntimeSystemToggle[];
  inputValue?: string;
  statusText?: string;
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
  conversationSystem?: string;
  titleText?: string;
  chipText: string[];
  selectedContextLabels: string[];
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

export type WorkflowTestApi = {
  reset: () => Promise<void>;
  createPaperWithPdfFixture: (input: {
    title: string;
    pdfTitle: string;
    pages?: string[];
  }) => Promise<WorkflowTestFixture>;
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
  ) => Promise<WorkflowTestDiagnostics>;
  togglePanelConversationMode: (
    panelId: string,
  ) => Promise<WorkflowTestDiagnostics>;
  exerciseDuplicatePanelSetup: (
    panelId: string,
  ) => Promise<WorkflowTestDuplicatePanelSetupDiagnostics>;
  seedPanelStoredUserMessage: (
    panelId: string,
    text: string,
  ) => Promise<WorkflowTestDiagnostics>;
  clickPanelSystemToggle: (
    panelId: string,
    system: RuntimeConversationSystem,
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
};
