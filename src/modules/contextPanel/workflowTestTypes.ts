import type { ResolvedContextSource, SendQuestionOptions } from "./types";
import type { ConversationSystem, QuoteCitation } from "../../shared/types";
import type { WorkflowTestFinalRequestSnapshot } from "./workflowTestHooks";
import type { RuntimeConversationSystem } from "./runtimeSystemControls";
import type { resolveRetrievalQueryPlan } from "../../services/retrieval/retrievalQueryPlan";
import type { RetrievalTimingReport } from "../../services/retrieval/retrievalTiming";
import type { LibraryTextIndexStatus } from "../../services/libraryTextIndex/scheduler";
import type { LibraryRetrieveResult } from "../../agent/services/libraryRetrieveService";
import type { CodexAppServerModelCatalogEntry } from "../../codexAppServer/modelCatalog";
import type { TornChatIdentity } from "./tornChatWindows";

export type WorkflowTestCodexModelCatalogResponse = {
  models?: CodexAppServerModelCatalogEntry[];
  error?: string;
  delayed?: boolean;
};

/** One open chat window document: the standalone window or a torn-off one. */
export type WorkflowTestChatWindowEntry = {
  /** The window's openDialog name. */
  name: string;
  /** Declares windowtype "llmforzotero:chat" (a torn-off window). */
  torn: boolean;
};

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

export type WorkflowTestSidePanel = WorkflowTestPanel & {
  /** The ephemeral key the side chat was mounted on. */
  conversationKey: number;
  /** The selection surface the side body resolves to. */
  surface: string;
  /** The key the mounted panel root shows. */
  mountedConversationKey: number;
  conversationSystem: string;
};

export type WorkflowTestStandaloneSidePanelControl =
  | "toggle"
  | "close"
  /** The "+" button after the last tab. */
  | "new-tab"
  /** The strip's New tab tab, and its close button. */
  | "newtab-tab"
  | "newtab-tab-close"
  /** The new-tab page's "Side chat" and "History" rows. */
  | "new-sidechat"
  | "new-history"
  /** The shown side chat's clear button. */
  | "clear"
  /** The shown side chat's "close this side chat?" card. */
  | "confirm-keep"
  | "confirm-send-last"
  | "confirm-discard"
  /** The panel's "close the side panel?" card. */
  | "panel-confirm-keep"
  | "panel-confirm-discard"
  | "readonly-add-paper"
  | "readonly-open-main";

export type WorkflowTestTextMetrics = {
  fontSize: string;
  fontWeight: string;
  topPx: number;
  heightPx: number;
};

export type WorkflowTestSegmentedTabMetrics = {
  groupPadding: string;
  groupGap: string;
  groupRadius: string;
  groupHeightPx: number;
  tabs: {
    paddingLeft: string;
    paddingRight: string;
    paddingTop: string;
    minWidth: string;
    heightPx: number;
    widthPx: number;
    fontSize: string;
    radius: string;
    active: boolean;
    fontWeight: string;
    background: string;
    color: string;
  }[];
};

/** A history row's scope chip colours, with the row's text colours. */
export type WorkflowTestHistoryChipColors = {
  type: string;
  color: string;
  background: string;
  metaColor: string;
  titleColor: string;
};

/** A chat body's composer box, rows, and footer status line. */
export type WorkflowTestComposerMetrics = {
  boxHeightPx: number;
  contextRowHeightPx: number;
  inputHeightPx: number;
  toolRowHeightPx: number;
  /** Font style of the input's placeholder ("normal", "italic"). */
  placeholderFontStyle: string;
  /** Visible chip labels in the context row. */
  contextChips: string[];
  /** The visible tool-row buttons' text, left to right. */
  toolButtons: string[];
  /** Height of each visible tool-row button. */
  toolButtonHeightsPx: number[];
  statusText: string;
  statusClass: string;
  statusColor: string;
  /** The model button shows its name (not the icon-only fallback). */
  modelNameShown: boolean | null;
};

/** One animation frame sampled while the side panel opens or closes. */
export type WorkflowTestStandaloneSidePanelSlideFrame = {
  timeMs: number;
  outerWidth: number;
  innerWidth: number;
  screenX: number;
  screenY: number;
  mainWidthPx: number;
  mainLeftPx: number;
  /** The columns row's scroll offset; the row never scrolls. */
  columnsScrollLeft: number;
  panelWidthPx: number;
  panelLeftPx: number;
  panelShown: boolean;
  /** Strip tabs (the New tab tab included) while the panel shows. */
  panelTabCount: number;
};

export type WorkflowTestStandaloneSidePanelDiagnostics = {
  open: boolean;
  toggleExpanded: string | null;
  toggleLabel: string;
  toggleControls: string | null;
  /**
   * "closed", "newtab", "history", "readonly", or "sidechat" (the shown
   * tab's kind).
   */
  view: string;
  /** The shown tab's id; null on the new-tab page. */
  activeTab: string | null;
  /** The bar's tabs, left to right. */
  tabs: {
    id: string;
    kind: string;
    title: string;
    active: boolean;
    /** The tab's close button is visible. */
    closeVisible: boolean;
  }[];
  /** The "+" button after the last tab. */
  newTabButton: { visible: boolean; pressed: boolean };
  /** Every tab in the strip, the New tab tab included. */
  stripTabCount: number;
  /** The New tab tab; `tabs` lists only the other tabs. */
  newTabTab: {
    present: boolean;
    active: boolean;
    title: string;
    closeVisible: boolean;
    index: number;
  };
  /** The panel's "close the side panel?" card. */
  panelConfirm: { visible: boolean; text: string };
  /** The visible view's title row text. */
  titleText: string;
  /**
   * Computed type and box metrics of the panel's parts and their main-window
   * counterparts, for the "same design language" checks.
   */
  design: {
    mainTitle: WorkflowTestTextMetrics | null;
    sideTitle: WorkflowTestTextMetrics | null;
    tabRowHeightPx: number;
    barHeightPx: number;
    navRow: WorkflowTestTextMetrics | null;
    launchRow: WorkflowTestTextMetrics | null;
    /** The visible chat start page title (New tab, or an empty chat). */
    startTitle: WorkflowTestTextMetrics | null;
    /** The New tab page: the chat start page with two nav rows. */
    newTabPage: {
      title: string;
      subtitle: string;
      subtitleFontStyle: string;
      centreDxPx: number;
      centreDyPx: number;
      rowLefts: number[];
      titleTopPx: number;
      subtitleTopPx: number | null;
      /** The main chat's start-page title and tagline; null without one. */
      mainTitleTopPx: number | null;
      mainSubtitleTopPx: number | null;
    } | null;
    dayLabel: WorkflowTestTextMetrics | null;
    sectionLabel: WorkflowTestTextMetrics | null;
    /** --llm-font-scale on the main chat and on each panel chat. */
    mainFontScale: string;
    sideFontScales: string[];
    /** Paper chat | Library chat. */
    mainTabs: WorkflowTestSegmentedTabMetrics | null;
    /** The panel's browser-style tab strip, and the main row's →| toggle. */
    browserTabs: {
      toggleTopPx: number;
      toggleBottomPx: number;
      /** Bottom of the 32px ⇤ sidebar toggle; null when it is hidden. */
      navToggleBottomPx: number | null;
      /** Top of Paper chat | Library chat; the tabs start on this line. */
      mainSwitchTopPx: number;
      /** Middle lines (y of the box's centre) of the strip and its parts. */
      centres: {
        /** The main tab row, the →| toggle and Paper chat | Library chat. */
        tabRow: number;
        toggle: number;
        mainSwitch: number;
        strip: number;
        /** The "+" button and the panel's close button. */
        newTabButton: number;
        closeButton: number;
        /** Each strip tab's icon, title and (when shown) close button. */
        tabs: { icon: number; title: number; close: number | null }[];
      };
      panelLeftPx: number;
      stripTopPx: number;
      stripBottomPx: number;
      /** The main column's tab row (→| toggle, Paper chat | Library chat). */
      tabRowTopPx: number;
      tabRowBottomPx: number;
      stripBackground: string;
      /** Top of the panel content under the strip. */
      contentTopPx: number;
      tabs: {
        leftPx: number;
        rightPx: number;
        topPx: number;
        bottomPx: number;
        active: boolean;
        background: string;
        color: string;
        radius: string;
        /** The bottom flares' size and paint (active tab only). */
        flareBefore: { widthPx: number; image: string };
        flareAfter: { widthPx: number; image: string };
      }[];
    } | null;
    /** Chips in the panel's visible history lists, one per label type. */
    sideChips: WorkflowTestHistoryChipColors[];
    /** The History view's search field, when it shows. */
    searchField: {
      topPx: number;
      heightPx: number;
      hasLens: boolean;
      background: string;
      placeholder: string;
    } | null;
  };
  panelWidthPx: number;
  mainContentWidthPx: number;
  /** The standalone window's outer box and its screen. */
  window: {
    outerWidth: number;
    screenX: number;
    screenY: number;
    availLeft: number;
    availWidth: number;
  };
  /** The History pane: "expanded" or "collapsed". */
  sidebarState: string;
  /** The divider between the main chat and the panel. */
  splitter: {
    visible: boolean;
    widthPx: number;
    lineColor: string;
    cursor: string;
  };
  panelBackground: string;
  mainBackground: string;
  /** The new-tab page's launch rows ("sidechat", "history"). */
  launchRows: string[];
  /** The History tab's Search history rows, while it shows. */
  historyKeys: number[];
  /** Every side chat tab, shown or not. */
  sideChats: {
    tabId: string;
    conversationKey: number;
    messageTexts: string[];
    shown: boolean;
  }[];
  readOnly: {
    title: string;
    pill: string;
    conversationKey: number;
    messageTexts: string[];
    inputDisabled: boolean;
    placeholder: string;
    actionButtons: string[];
    statusText: string;
    editableBubbles: number;
    retryButtons: number;
    deleteButtons: number;
    forkButtons: number;
    quoteButtons: number;
    copyButtons: number;
    composer: WorkflowTestComposerMetrics | null;
  } | null;
  sideChat: {
    conversationKey: number;
    conversationKind: string;
    messageTexts: string[];
    pill: string;
    placeholder: string;
    statusText: string;
    inputHeightPx: number;
    sendMainButtons: number;
    retryButtons: number;
    editableBubbles: number;
    forkButtons: number;
    deleteButtons: number;
    contextNotes: string[];
    selectedContextTexts: string[];
    confirmVisible: boolean;
    confirmText: string;
    clearDisabled: boolean;
    composer: WorkflowTestComposerMetrics | null;
  } | null;
  main: {
    conversationKey: number;
    inputHeightPx: number;
    statusText: string;
    selectedContextSources: string[];
    selectedContextTexts: string[];
    askSideButtons: number;
    composer: WorkflowTestComposerMetrics | null;
  };
};

export type WorkflowTestBox = {
  left: number;
  right: number;
  width: number;
};

export type WorkflowTestNativePopupGeometry = {
  /** Set when Zotero's own popup never showed the plugin row. */
  error?: string;
  /** What the reader document held when the popup was missing. */
  diagnostic?: string;
  colors?: WorkflowTestBox & { top: number; bottom: number };
  toggle?: WorkflowTestBox & { top: number; bottom: number };
  highlight?: WorkflowTestBox;
  underline?: WorkflowTestBox;
  row?: WorkflowTestBox;
  buttons?: Array<WorkflowTestBox & { label: string }>;
  rowTop?: number;
  toggleBottom?: number;
};

export type WorkflowTestRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type WorkflowTestNativeInlineAskOpen = {
  /** Set when Zotero's own popup never showed the Inline Ask button. */
  error?: string;
  diagnostic?: string;
  /** Zotero's popup just before the press (outer box, reader UI pixels). */
  popup?: WorkflowTestRect;
  /** Zotero's placement class on the popup, such as page-popup-bottom-center. */
  popupSide?: string;
  /** Milliseconds from the popup showing the row to the press. */
  pressedAfterMs?: number;
  /** `.selection-popup` is in the document this long after the press. */
  popupOpenAfterPress?: { ms: number; open: boolean };
  /** The card's outer box after it opened. */
  card?: WorkflowTestRect;
  cardMounted?: boolean;
  /** The PDF text selection still exists after the card opened. */
  selectionKept?: boolean;
  /** `.selection-popup` is in the document 400 ms after the card opened. */
  popupOpenLater?: boolean;
  /** The card closed on Escape. */
  cardClosed?: boolean;
  /** `.selection-popup` is in the document 400 ms after the card closed. */
  popupOpenAfterCardClose?: boolean;
  /** Add Text only: the panel's selected-text chips after the box opened. */
  chipTexts?: string[];
};

export type WorkflowTestReaderPopupActionRow = {
  /** Calls the handler made to the popup's append. */
  appendCalls: number;
  /** Button labels in the plugin's popup row, in order. */
  buttonLabels: string[];
  /** All buttons share one row element. */
  sharedRow: boolean;
  /** The row lays its buttons out side by side. */
  rowDisplay: string;
};

export type WorkflowTestReaderInlineAskCard = {
  mounted: boolean;
  phase: string;
  questions: string[];
  answers: Array<{ status: string; text: string }>;
  fieldShown: boolean;
  pillsShown: boolean;
  footerShown: boolean;
  placeholder: string;
  sidebarDisabled: boolean;
  saveDisabled: boolean;
  /** The quick-prompt pills: id, label, and tooltip (the prompt). */
  pills: Array<{ id: string; label: string; title: string }>;
  promptEditorShown: boolean;
  /** The prompt editor floats (absolute) over the card, not inside its flow. */
  promptEditorFloating: boolean;
  /** The composer box holds the field, the model button, and the send arrow. */
  composerHoldsControls: boolean;
  /** Each resize corner: controls its hit area overlaps, and its arc opacity. */
  resizeCorners: Array<{
    corner: string;
    coveredControls: number;
    arcOpacity: number;
  }>;
  /** The message actions under the latest answer, in order. */
  messageActions: string[];
  modelLabel: string;
  effortLabel: string;
  /** The card's box in the reader window, in whole pixels. */
  rect: { left: number; top: number; width: number; height: number };
  /** The answer area's max height in pixels (0 when it has none). */
  threadMaxHeight: number;
  /** The card's text size in percent. */
  textSize: number;
  /** Computed px of the passage text, and of the latest answer's first block. */
  quoteFontSize: number;
  answerFontSize: number;
  /** The grey quote line beside the passage exists. */
  quoteHasBar: boolean;
  /** Curly quote marks remain around the passage. */
  quoteHasQuoteMarks: boolean;
  /** Alpha of the passage text color (1 when opaque). */
  quoteColorAlpha: number;
  /** The answer area has its top fade (it is scrolled). */
  threadFaded: boolean;
  /** The pinned passage line (paper label and selected text) is visible. */
  passageShown: boolean;
  /** The passage text, and whether the passage line is expanded. */
  passageText: string;
  passageExpanded: boolean;
  /** The answer area (the thread) is visible. */
  threadShown: boolean;
  /** The question bubbles' quote lines, one list per question. */
  questionQuotes: string[][];
  /** The quotes waiting above the follow-up field, in order. */
  composerQuotes: string[];
  /** The follow-up field's typed text. */
  editorText: string;
  /** The follow-up field has the keyboard focus. */
  editorFocused: boolean;
  /** The send arrow is disabled. */
  sendDisabled: boolean;
  /** Boxes in the card's window: the quote list, send arrow and model line. */
  composerQuotesRect: WorkflowTestRect | null;
  sendRect: WorkflowTestRect | null;
  modelRect: WorkflowTestRect | null;
  /** The Copy and Quote bar: shown, its buttons, and its box. */
  selectionBarShown: boolean;
  selectionBarActions: string[];
  selectionBarRect: WorkflowTestRect | null;
  /** The reader document's current text selection. */
  selectionText: string;
};

/** What a native drag over an answer selected, and the card afterwards. */
export type WorkflowTestReaderInlineAskAnswerSelection = {
  /** The text the browser selected (`getSelection().toString()`). */
  selectedText: string;
  /** The answer text the drag aimed at. */
  expectedText: string;
  card: WorkflowTestReaderInlineAskCard;
};

/** How an answer's math renders in the reader document. */
export type WorkflowTestReaderInlineAskMath = {
  katexCount: number;
  inlineCount: number;
  displayBlocks: Array<{
    textAlign: string;
    overflowX: string;
    /** Distance of the formula's center from its block's center, in px. */
    centerOffset: number;
  }>;
  /** True when a `$` shows in the answer text outside code. */
  literalDollarOutsideCode: boolean;
  codeTexts: string[];
  katexLinkCount: number;
  mathStyleCount: number;
  /** Rules in the KaTeX stylesheet; 0 means it did not load. */
  cssRules: number;
  katexFontFamily: string;
  katexColor: string;
  answerColor: string;
  katexFontSize: number;
  answerFontSize: number;
  answerWidth: number;
  fontLoaded: boolean;
  /** KaTeX font faces in the document, as "family:status". */
  fontFaces: string[];
};

/** The card after a click on the More button or a text-size menu control. */
export type WorkflowTestReaderInlineAskTextSize = {
  card: WorkflowTestReaderInlineAskCard;
  moreMenuShown: boolean;
  /** The percentage shown in the menu ("" when it is closed). */
  menuPercent: string;
  /** Each A glyph's center minus its button's center, in pixels. */
  glyphOffsets: Array<{ step: "smaller" | "larger"; dx: number; dy: number }>;
};

/** The card's right-click menu on a pill or the empty pill row. */
export type WorkflowTestReaderInlineAskPromptMenu = {
  /** The contextmenu event was cancelled (no native menu). */
  defaultPrevented: boolean;
  items: Array<{ action: string; text: string; disabled: boolean }>;
};

/** The card's prompt editor after typing into it and finishing. */
export type WorkflowTestReaderInlineAskPromptEdit = {
  /** What the editor showed when it opened. */
  labelBefore: string;
  promptBefore: string;
  labelType: string;
  promptContentEditable: string;
  /** Typing keys in Label and Prompt; none may be prevented. */
  keys: Array<{ field: string; key: string; defaultPrevented: boolean }>;
  readerKeyStateBefore: string;
  readerKeyStateAfter: string;
  card: WorkflowTestReaderInlineAskCard;
};

/** The card's model or effort menu. */
export type WorkflowTestReaderInlineAskModelMenu = {
  kind: string;
  note: string;
  sections: string[];
  options: Array<{ value: string; label: string; selected: boolean }>;
};

/** Zotero's annotation draft for a real selection, and where it came from. */
export type WorkflowTestReaderSelectionDraft = {
  source: string;
  annotation: Record<string, unknown> | null;
};

/** The Inline Ask card's Save state: footer button and annotation card. */
export type WorkflowTestReaderInlineAskSave = {
  mounted: boolean;
  /** "thread" or "save". */
  view: string;
  footerSaveDisabled: boolean;
  footerSaveTitle: string;
  saveViewShown: boolean;
  color: string;
  colorsShown: boolean;
  colorLabels: string[];
  pageText: string;
  markText: string;
  markBackground: string;
  comment: string;
  commentContentEditable: string;
  error: string;
  confirmDisabled: boolean;
};

/** The card after a click on Continue in sidebar. */
export type WorkflowTestReaderInlineAskContinue = {
  /** The button was disabled when clicked. */
  disabledBefore: boolean;
  cardOpen: boolean;
  /** The reason the card shows when it stayed open. */
  error: string;
};

/** The chat a workflow panel shows, as rendered and as stored. */
export type WorkflowTestPanelChatMessages = {
  conversationKey: number;
  conversationKind: string;
  conversationSystem: string;
  rendered: Array<{
    role: string;
    text: string;
    /** The answer's model header ("" for a question). */
    model: string;
    selectedText: string;
  }>;
  stored: Array<{
    role: string;
    text: string;
    selectedTextContexts?: import("../../shared/types").SelectedTextContext[];
  }>;
  /** The paper catalog row (null for a library chat). */
  catalog: {
    title: string;
    userTurnCount: number;
    paperItemID: number;
  } | null;
  /** The selected-text chips waiting in the composer, in order. */
  composerSelectedTexts: Array<{ text: string; source: string }>;
};

export type WorkflowTestReaderInlineAskOpen = {
  /** The popup's annotation draft the card got (null for a synthetic one). */
  draft: WorkflowTestReaderSelectionDraft | null;
  /** The reader panel's conversation key (0 when no panel was mounted). */
  panelConversationKey: number;
  popupButtonLabels: string[];
  mounted: boolean;
  /** The card mounts in reader.html, where the popup lives. */
  overlayDocumentUrl: string;
  quoteLabel: string;
  quoteText: string;
  modelLabel: string;
  pillLabels: string[];
  hint: string;
  editorContentEditable: string;
  editorKeys: Array<{ key: string; defaultPrevented: boolean }>;
  readerKeyStateBefore: string;
  readerKeyStateAfter: string;
  card: WorkflowTestReaderInlineAskCard;
};

export type WorkflowTestConversationStoreRowTotals = {
  catalogs: number;
  messages: number;
  registry: number;
  usageEvents: number;
};

export type WorkflowTestEphemeralConversationRowCounts = {
  globalCatalog: number;
  paperCatalog: number;
  messages: number;
  registry: number;
  searchIndex: number;
  ledger: number;
  forkLinks: number;
  pendingDeletions: number;
  agentRuns: number;
  agentRunEvents: number;
  agentTranscript: number;
  agentToolResultHandles: number;
  agentMemory: number;
  agentEvidence: number;
  agentCoverage: number;
  planDocuments: number;
  planDocumentOwners: number;
  attachmentRefs: number;
  usageEvents: number;
};

export type WorkflowTestRuntimeSystemToggle = {
  system: RuntimeConversationSystem;
  visible: boolean;
  active: boolean;
  disabled: boolean;
  ariaPressed: boolean;
};

/** The composer's runtime badge and its menu, as a reader sees them. */
export type WorkflowTestRuntimeBadge = {
  visible: boolean;
  /** Text on the badge itself ("Agent", "Chat", "Codex" or "Claude"). */
  label: string;
  /** False when the badge is disabled (a static label). */
  clickable: boolean;
  menuOpen: boolean;
  /** Menu entries in display order; empty while the menu is closed. */
  menuItems: Array<{ system: string; label: string; selected: boolean }>;
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
  statusBarHeight: number;
  spaceAboveStatus: number;
};

export type WorkflowTestStandaloneComposerResizeDiagnostics = {
  oneLineHeight: number;
  resizeHandleTargets: string[];
  textOffsetFromModeLabel: number | null;
  nativeResize: string;
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
  composerAttachedConversationLabels: string[];
  sentContextBadgeLabels: string[];
  sentContextItemLabels: string[];
  historyNewVisible?: boolean;
  historyToggleVisible?: boolean;
  runtimeSystemToggles: WorkflowTestRuntimeSystemToggle[];
  runtimeBadge?: WorkflowTestRuntimeBadge;
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
  runtimeBadge?: WorkflowTestRuntimeBadge;
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
  readerConversationKey: number;
  readerConversationHasText: boolean;
  readerPreviewHasText: boolean;
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

/** The window's pin button and its "Pinned papers" rows. */
export type WorkflowTestStandalonePinnedPapers = {
  pinButton: { visible: boolean; pressed: boolean; label: string };
  regionVisible: boolean;
  /**
   * The "Clear" button on the section's label row: present once a paper is
   * pinned (on screen only while the pointer is over the section).
   */
  clearVisible: boolean;
  /**
   * Left edges (px) of the section's label and first row, and of the first
   * history day label and row, so the two can be checked to line up.
   */
  edges: {
    pinnedLabel: number | null;
    pinnedRow: number | null;
    historyLabel: number | null;
    historyRow: number | null;
  };
  rows: Array<{
    paperItemId: number;
    label: string;
    active: boolean;
    /** "writing" while its chat answers, "ready" for an unseen answer. */
    dot: "writing" | "ready" | null;
  }>;
};

export type WorkflowTestHistoryRow = {
  conversationKey: number;
  title: string;
  /** The runtime the row belongs to ("upstream", "codex", "claude_code"). */
  system?: string;
  /** The small runtime name on the row ("Codex", "Claude"; "" for Agent). */
  runtimeLabel?: string;
  /** The row's time text ("Draft" for an empty draft). */
  isDraft?: boolean;
};

/** A chat written straight into one runtime's catalog and message store. */
export type WorkflowTestSeededHistoryConversation = {
  system: ConversationSystem;
  kind: "global" | "paper";
  conversationKey: number;
  libraryID: number;
};

/** Two history rows clicked in one task, before either switch ends. */
export type WorkflowTestRapidHistoryClicks = {
  diagnostics: WorkflowTestDiagnostics;
  /** Uncaught errors and rejected promises seen while the clicks settled. */
  errors: string[];
};

/** A history search typed into the panel's search popup, then a row opened. */
export type WorkflowTestHistorySearchOpen = {
  /** Conversation keys the popup listed for the query. */
  resultKeys: number[];
  /** The listed rows' runtimes, in the same order. */
  resultSystems: string[];
  /** The listed rows' runtime names, in the same order. */
  resultRuntimeLabels: string[];
  opened: boolean;
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
  // Stops the index, rewrites it into the shape a pre-stemming build left
  // (surface-token postings for these documents, no document_tokenizer
  // table, no tokenizer_version row), then starts it as Zotero startup does.
  restartLibraryTextIndexFromPreStemmingShape: (
    attachmentIds: number[],
  ) => Promise<void>;
  // The recorded tokenizer version (null = none) and how many documents
  // still wait for the re-posting pass.
  libraryTextIndexTokenizerState: () => Promise<{
    recordedVersion: string | null;
    documentsNeedingRepost: number;
  }>;
  // One document's posting terms, sorted.
  libraryTextIndexPostingTerms: (attachmentId: number) => Promise<string[]>;
  // A library text index search through the plugin's own store.
  searchLibraryTextIndexForTest: (input: {
    queries: string[];
    attachmentIds: number[];
  }) => Promise<{
    paperAttachmentIds: number[];
    matchedTerms: string[];
    snippets: string[];
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
    /** Author last names, in order. */
    creators?: string[];
    date?: string;
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
  /** Mounts a temporary side chat on a fresh ephemeral key. */
  renderSidePanelForItem: (input: {
    itemId: number;
    mode: "paper" | "global";
    backgroundContext?: string;
  }) => Promise<WorkflowTestSidePanel>;
  /** Drops a side chat's in-memory state. */
  discardSidePanelConversation: (conversationKey: number) => void;
  /** Rows every store holds for one conversation key. */
  getEphemeralConversationRowCounts: (
    conversationKey: number,
    runIds?: string[],
  ) => Promise<WorkflowTestEphemeralConversationRowCounts>;
  refreshActiveConversationPanels: (conversationKey?: number) => void;
  exerciseNativeQuestionReview: (
    panelId: string,
  ) => ReturnType<
    typeof import("./nativePlanReviewReplay").exerciseNativeQuestionReview
  >;
  /**
   * The real Codex approval bridge for a Zotero write, with the real card,
   * when the card UI is missing and when the panel's owner is stale.
   */
  /**
   * A run left running with a legacy agent_action_contract checkpoint, then
   * the next turn (Auto mode, scripted model) that tags the paper.
   */
  exerciseInterruptedLegacyContract: (input: {
    panelId: string;
    legacyRunId: string;
    legacyContractId: string;
    tag: string;
  }) => ReturnType<
    typeof import("./interruptedContractReplay").exerciseInterruptedLegacyContract
  >;
  exerciseCodexApprovalFailClosed: (input: {
    panelId: string;
    itemId: number;
    tag: string;
    otherItemId: number;
  }) => ReturnType<
    typeof import("./codexApprovalReplay").exerciseCodexApprovalFailClosed
  >;
  /** Runs the plugin's own `initUserSkills` against the real skills folder. */
  runUserSkillsInit: () => Promise<void>;
  /** The skill files shipped in this build, by filename. */
  readBuiltinSkillFiles: () => Record<string, string>;
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
   * One scenario of the agent stop rules (turnBoundary.ts) through the
   * panel's send flow; only the model is scripted.
   */
  /**
   * One Agent turn whose scripted model calls record_paper_decisions through
   * the panel's send flow and the real stores; only the model is scripted.
   */
  exercisePaperDecisionsTurn: (
    input: {
      panelId: string;
    } & import("./paperDecisionsReplay").PaperDecisionsTurnInput,
  ) => Promise<import("./paperDecisionsReplay").PaperDecisionsTurnResult>;
  /**
   * One tools/call through the plugin's MCP endpoint under a scope for the
   * panel's conversation, with the call's completed activity.
   */
  callScopedMcpToolForConversation: (input: {
    panelId: string;
    runId: string;
    name: string;
    arguments: unknown;
  }) => ReturnType<
    typeof import("./paperDecisionsReplay").callScopedMcpToolForConversation
  >;
  exerciseAgentStopRules: (input: {
    panelId: string;
    scenario: import("./stopRulesReplay").StopRuleScenario;
    collection?: import("../../shared/types").CollectionContextRef;
    papers?: Array<{ itemId: number; title: string }>;
  }) => ReturnType<typeof import("./stopRulesReplay").exerciseAgentStopRules>;
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
  /** The conversation key the panel's chat is stored under. */
  getPanelConversationKey: (input: { panelId: string }) => number;
  /**
   * Real-restart scenario, first process: a note batch whose writing ends
   * this Zotero process. Does not return when the process ends.
   */
  startNoteBatchUntilQuit: (input: {
    panelId: string;
    collection: import("../../shared/types").CollectionContextRef;
    papers: Array<{ itemId: number; title: string }>;
    inputTokenCap: number;
    killAfterNotes: number;
    variant: "crash" | "quit";
    target?: "item" | "standalone";
    /** 2: two child notes on each paper (rows `item:N` and `item:N#2`). */
    notesPerPaper?: 1 | 2;
  }) => ReturnType<
    typeof import("./noteBatchRestartReplay").startNoteBatchUntilQuit
  >;
  /**
   * Real-restart scenario, second process: "continue" the note batch, or
   * with `retryPapers` send a new note_write_batch over those papers.
   */
  resumeNoteBatchAfterRestart: (input: {
    panelId: string;
    collection: import("../../shared/types").CollectionContextRef;
    papers: Array<{ itemId: number; title: string }>;
    inputTokenCap: number;
    rewritePapers: number[];
    /** The batch to continue, instead of the one the host names first. */
    resumeBatchId?: string;
    retryPapers?: number[];
    /** Ends this process (SIGKILL) once this many new notes exist. */
    killAfterNotes?: number;
  }) => ReturnType<
    typeof import("./noteBatchRestartReplay").resumeNoteBatchAfterRestart
  >;
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
      source: "action" | "codex" | "claude" | "outcomes";
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
      checklistSource?: "action" | "codex" | "claude" | "outcomes";
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
        /** The paper's latest agent decision (`latestTaskPaperDecision`). */
        decision?: import("../../agent/context/taskPaperLedger").TaskPaperDecisionRecord;
        /** Each question's decision about the paper, by turn. */
        decisions: Array<
          import("../../agent/context/taskPaperLedger").TaskPaperDecisionRecord
        >;
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
      "forcedSkillIds" | "selectedTagContexts" | "attachedConversations"
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
      | "attachedConversations"
    >,
  ) => Promise<WorkflowTestDiagnostics>;
  /**
   * Types "/" in the composer, clicks "Add past conversation", reads the
   * picker rows, and clicks the row with `input.rowIndex`, or the first row
   * whose title contains `input.title`.
   */
  pickPastConversationInPanel: (
    panelId: string,
    input?: { title?: string; rowIndex?: number },
  ) => Promise<{
    slashItemVisible: boolean;
    rowTitles: string[];
    rowLabels: string[];
    rowMetas: string[];
    rowRuntimeLabels: string[];
    picked: boolean;
  }>;
  /**
   * Adds a past chat to the panel's latest user message the way the agent's
   * past_chat_attach does (through the panel's attach handler, via "agent"),
   * then reads the refs from the in-memory message and the stored row.
   */
  attachPastChatAsAgentInPanel: (
    panelId: string,
    input: {
      conversationKey: number;
      title: string;
      system?: ConversationSystem;
    },
  ) => Promise<{
    outcome: { ok: true } | { ok: false; reason: string };
    memoryRefs: import("../../shared/types").AttachedConversationRef[];
    storedRefs: import("../../shared/types").AttachedConversationRef[];
    diagnostics: WorkflowTestDiagnostics;
  }>;
  clickPanelSystemToggle: (
    panelId: string,
    system: RuntimeConversationSystem,
  ) => Promise<WorkflowTestDiagnostics>;
  /** Opens the runtime badge menu; resolves with the badge and its items. */
  openPanelRuntimeMenu: (panelId: string) => Promise<WorkflowTestRuntimeBadge>;
  /** Picks a runtime from the badge menu and waits for the switch to finish. */
  pickPanelRuntime: (
    panelId: string,
    system: ConversationSystem,
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
  openStandaloneRuntimeMenu: () => Promise<WorkflowTestRuntimeBadge>;
  pickStandaloneRuntime: (
    system: ConversationSystem,
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
  /**
   * Stores turns for an ordinary conversation, and adds them to its
   * in-memory chat when a panel already loaded it. Draws nothing.
   */
  seedStoredConversationTurns: (
    conversationKey: number,
    turns: Array<{
      role: "user" | "assistant";
      text: string;
      timestamp: number;
    }>,
  ) => Promise<void>;
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
  /** Starts opening (or focuses) the standalone window without waiting. */
  beginOpenStandaloneForTest: (itemId: number) => void;
  isStandaloneWindowActiveForTest: () => boolean;
  /**
   * Opens a torn-off window on the chat and waits for its panel; its panel
   * body is the window's `.llm-standalone-content`.
   */
  openTornChatWindowForTest: (
    identity: TornChatIdentity,
    placement?: { screenX: number; screenY: number },
  ) => Promise<{ surface: string }>;
  getTornChatWindowsForTest: () => Window[];
  closeTornChatWindowsForTest: () => Promise<void>;
  listChatWindowsForTest: () => WorkflowTestChatWindowEntry[];
  /** Replaces the update checker, installer and release-notes fetcher; null restores them. */
  setPluginUpdateDeps: (
    deps: import("../pluginUpdate").PluginUpdateDeps | null,
  ) => void;
  /** The window's side panel: open state, view, and each view's contents. */
  getStandaloneSidePanelDiagnostics: () => Promise<WorkflowTestStandaloneSidePanelDiagnostics>;
  /** Clicks one side panel control (toggle, tabs, launch rows, confirm). */
  clickStandaloneSidePanelControl: (
    control: WorkflowTestStandaloneSidePanelControl,
  ) => Promise<WorkflowTestStandaloneSidePanelDiagnostics>;
  /** Slows (ms) or restores (null) the side panel's open/close slide. */
  setStandaloneSidePanelSlideDuration: (durationMs: number | null) => void;
  /** Clicks a side panel control and samples each frame for `sampleMs`. */
  recordStandaloneSidePanelSlide: (
    control: WorkflowTestStandaloneSidePanelControl,
    sampleMs?: number,
  ) => Promise<WorkflowTestStandaloneSidePanelSlideFrame[]>;
  /** Drags the side panel's divider by `deltaX` screen pixels. */
  /** Opens the window's Search history popup, reads its chips, closes it. */
  readStandaloneSearchPopupChipColors: () => Promise<
    WorkflowTestHistoryChipColors[]
  >;
  dragStandaloneSidePanelSplitter: (
    deltaX: number,
  ) => Promise<WorkflowTestStandaloneSidePanelDiagnostics>;
  /** Clicks a row of the History tab's Search history list. */
  clickStandaloneSidePanelHistoryRow: (
    conversationKey: number,
  ) => Promise<WorkflowTestStandaloneSidePanelDiagnostics>;
  /** Clicks the bar's tab at `index` (0 = leftmost), or its close button. */
  clickStandaloneSidePanelTab: (
    index: number,
    part?: "tab" | "close",
  ) => Promise<WorkflowTestStandaloneSidePanelDiagnostics>;
  /** Clicks the newest assistant answer's footer action in one chat. */
  clickStandaloneChatMessageAction: (
    scope: "main" | "readonly" | "sidechat",
    actionClass: string,
  ) => Promise<WorkflowTestStandaloneSidePanelDiagnostics>;
  /** Forgets a non-active conversation's in-memory history (stored rows stay). */
  evictStandaloneConversationFromMemory: (
    conversationKey: number,
  ) => Promise<void>;
  /** Runs the real conversation load for the open read-only view's key. */
  probeStandaloneReadOnlyBorrowedLoad: (paperItemId: number) => Promise<{
    conversationKey: number;
    borrowedBefore: boolean;
    loadedBefore: boolean;
    borrowedAfter: boolean;
    loadedAfter: boolean;
  }>;
  /** Types into the shown side chat's composer and presses Send. */
  sendStandaloneSideChat: (text: string) => Promise<void>;
  /** Opens the main chat's "/" menu and reads its "Add side chat" item. */
  openStandaloneSlashSideChatItem: () => Promise<{
    visible: boolean;
    disabled: boolean;
    hint: string;
  }>;
  /** Clicks the main chat's "Add side chat" item (menu already open). */
  clickStandaloneSlashSideChatItem: () => Promise<WorkflowTestStandaloneSidePanelDiagnostics>;
  getLastSend: () => SendQuestionOptions | null;
  getDiagnostics: (panelId?: string) => Promise<WorkflowTestDiagnostics>;
  configurePermissionCatalogs: (input?: { delayFirstCodex?: boolean }) => void;
  configureCodexDirectCatalog: (input: {
    cachedClientVersion?: string;
    liveAuthPath?: string;
  }) => void;
  getCodexDirectCatalogRequests: () => string[];
  configureCodexModelCatalogs: (
    responses: WorkflowTestCodexModelCatalogResponse[],
  ) => void;
  getCodexModelCatalogRequests: () => string[];
  resolveDelayedCodexModelCatalog: () => Promise<void>;
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
    panelId: string;
    attachmentItemId: number;
    pageIndex: number;
    selectedText: string;
  }) => Promise<WorkflowTestReaderPopupStandaloneRoutingDiagnostics>;
  exerciseReaderPopupInlinePrompt: (input: {
    panelId: string;
    attachmentItemId: number;
    pageIndex: number;
    selectedText: string;
    prompt: string;
  }) => Promise<{
    chipAddedBeforeEnter: boolean;
    overlayMounted: boolean;
    /** URL of the document the overlay mounted in (the reader UI document). */
    overlayDocumentUrl: string;
    /** The selection quoted above the editor, and its label. */
    quoteText: string;
    quoteLabel: string;
    buttonLabel: string;
    /** Editing keys dispatched in the overlay editor, before the prompt. */
    editorKeys: Array<{ key: string; defaultPrevented: boolean }>;
    /** Reader tool and annotation selection, before and after those keys. */
    readerKeyStateBefore: string;
    readerKeyStateAfter: string;
    /** Whether Enter in the box sent anything within 1 s (it must not). */
    sentOnEnter: boolean;
    /** The chip's userQuery after Enter. */
    attachedQuestion: string;
    /** Chips holding the selected text after Enter. */
    chipCount: number;
    /** `.llm-selected-context-question` text in the panel preview, or null
     * when the preview renders no question element. */
    previewQuestionText: string | null;
    /** Section labels in the panel preview card, in order. */
    previewLabels: string[];
    overlayRemovedAfterEnter: boolean;
    composerAfterEnter: string;
    statusAfterEnter: string;
    /** The later main Send with an empty composer: the model-facing
     * question, the user turn as shown in the chat, and the chip texts. */
    sentQuestion: string;
    sentDisplayQuestion: string;
    sentSelectedTexts: string[];
    /** The sent user bubble once rendered: its visible body text ("" when
     * hidden or absent), the questions inside its shown chip cards, and the
     * number of bars drawn for chips that have a question (one card and no
     * bar each, so 0). */
    sentBubbleBodyText: string;
    sentBubbleChipQuestions: string[];
    sentBubbleBarCount: number;
  }>;
  exerciseReaderPopupModEnterSend: (input: {
    panelId: string;
    attachmentItemId: number;
    pageIndex: number;
    selectedText: string;
    prompt: string;
  }) => Promise<{
    overlayMounted: boolean;
    /** The box's hint line. */
    hint: string;
    /** Whether Cmd/Ctrl+Enter sent within 3 s (it must). */
    sent: boolean;
    overlayRemoved: boolean;
    sentQuestion: string;
    sentDisplayQuestion: string;
    sentSelectedTexts: string[];
  }>;
  exerciseReaderPopupDuplicateAttach: (input: {
    panelId: string;
    attachmentItemId: number;
    pageIndex: number;
    selectedText: string;
    firstPrompt: string;
    secondPrompt: string;
  }) => Promise<{
    firstMounted: boolean;
    /** The chip question after the first add and Enter. */
    firstQuestion: string;
    /** The second Add Text on the same selection reopened the box. */
    secondMounted: boolean;
    secondQuoteText: string;
    statusBeforeSecondEnter: string;
    secondOverlayRemovedAfterEnter: boolean;
    chipCount: number;
    finalQuestion: string;
    sent: boolean;
  }>;
  exerciseReaderPopupPromptDismissal: (input: {
    panelId: string;
    attachmentItemId: number;
    pageIndex: number;
    firstSelectedText: string;
    secondSelectedText: string;
  }) => Promise<{
    firstMounted: boolean;
    escapeClosed: boolean;
    firstChipsAfterEscape: number;
    secondMounted: boolean;
    /** The box lives in reader.html; the page click lands in viewer.html. */
    overlayAndPageInDifferentDocuments: boolean;
    pageClickClosed: boolean;
    secondChipsAfterPageClick: number;
    /** Chips that carry a question; dismissal attaches none. */
    chipsWithQuestion: number;
    sent: boolean;
  }>;
  /**
   * Shows the reader selection popup for `selectedText` and reads the
   * plugin's action row: how many times the handler appended, and the
   * buttons in the row.
   */
  readReaderPopupActionRow: (input: {
    attachmentItemId: number;
    pageIndex: number;
    selectedText: string;
  }) => Promise<WorkflowTestReaderPopupActionRow>;
  /**
   * Opens the reader, makes a real selection, waits for Zotero's own
   * selection popup, and measures the plugin row against the native
   * highlight/underline toggle (pixel boxes in the reader UI document).
   */
  readNativeReaderPopupGeometry: (input: {
    attachmentItemId: number;
    pageIndex: number;
    selectedText: string;
    /** Mounts this workflow panel as the reader tab's panel first. */
    panelId?: string;
  }) => Promise<WorkflowTestNativePopupGeometry>;
  /**
   * Opens the reader, makes a real selection, and presses Inline Ask inside
   * Zotero's own selection popup (a real pointer and click sequence on the
   * plugin's button). Measures the popup before the press and the card
   * after it, then closes the card with Escape and closes the reader.
   */
  openNativeReaderInlineAsk: (input: {
    attachmentItemId: number;
    pageIndex: number;
    selectedText: string;
    /** Mounts this workflow panel as the reader tab's panel first. */
    panelId?: string;
    /**
     * Which plugin button to press; default "Inline Ask". "Add Text" reads
     * its question box (not the card) and needs panelId.
     */
    button?: "Inline Ask" | "Add Text";
  }) => Promise<WorkflowTestNativeInlineAskOpen>;
  /**
   * Opens the reader, shows the selection popup, presses Inline Ask, and
   * reads the card. Editing keys typed into the card must leave the
   * reader's key state alone. The card stays open for the calls below.
   */
  openReaderInlineAsk: (input: {
    attachmentItemId: number;
    pageIndex: number;
    selectedText: string;
    /** Mounts this workflow panel as the reader tab's panel first. */
    panelId?: string;
    /**
     * The popup's annotation draft: "synthetic" (default, text and page
     * only), "native" (Zotero's draft for the real selection), or
     * "native_cross_page" (that draft with a next-page part).
     */
    draft?: "synthetic" | "native" | "native_cross_page";
  }) => Promise<WorkflowTestReaderInlineAskOpen>;
  /** Sends typed text (Enter in the editor) or clicks a quick-prompt pill. */
  sendReaderInlineAsk: (
    input: { text: string } | { pillId: string },
  ) => Promise<void>;
  readReaderInlineAsk: () => WorkflowTestReaderInlineAskCard;
  readReaderInlineAskSave: () => WorkflowTestReaderInlineAskSave;
  /** Opens the annotation card: a click on Save as annotation, or Mod+Enter. */
  openReaderInlineAskSave: (input: {
    via: "click" | "keyboard";
  }) => Promise<WorkflowTestReaderInlineAskSave>;
  /** Types a comment and picks a color dot in the annotation card. */
  editReaderInlineAskSave: (input: {
    comment?: string;
    color?: string;
  }) => Promise<WorkflowTestReaderInlineAskSave>;
  /** Presses Save in the annotation card (click, or Mod+Enter in the comment). */
  confirmReaderInlineAskSave: (input: {
    via: "click" | "keyboard";
  }) => Promise<void>;
  /** A pointerdown on the PDF page (the nested view document). */
  pointerDownOutsideReaderInlineAsk: () => Promise<{ cardOpen: boolean }>;
  /** A new text selection popup on the same reader. */
  showNewReaderSelectionPopup: (input: {
    selectedText: string;
    /** Then presses the new popup's Add Text button. */
    pressAddText?: boolean;
  }) => Promise<{
    cardOpen: boolean;
    /** Add Text's question box is open in the reader. */
    addTextPromptOpen: boolean;
  }>;
  /** Closes the card (Discard, Escape in the card, or Escape on the page) and the reader. */
  endReaderInlineAsk: (input: {
    via: "discard" | "escape" | "escape_page";
  }) => Promise<{ cardRemoved: boolean }>;
  /** Closes the reader tab under the card (the card goes with it). */
  closeReaderInlineAskReaderTab: () => Promise<{ readerClosed: boolean }>;
  /** Clicks Continue in sidebar; resolves when the card closed or says why not. */
  continueReaderInlineAskInSidebar: () => Promise<WorkflowTestReaderInlineAskContinue>;
  /** Right-clicks a pill (or the empty pill row) and reads the menu. */
  openReaderInlineAskPromptMenu: (input: {
    pillId?: string;
  }) => Promise<WorkflowTestReaderInlineAskPromptMenu>;
  /** Clicks an item of the open pill menu ("edit", "delete", ...). */
  clickReaderInlineAskPromptMenuItem: (
    action: string,
  ) => Promise<WorkflowTestReaderInlineAskCard>;
  /** Clicks the More button ("toggle") or a text-size step of its menu. */
  clickReaderInlineAskTextSize: (
    step: "toggle" | "smaller" | "larger" | "reset",
  ) => Promise<WorkflowTestReaderInlineAskTextSize>;
  /**
   * Drags over an answer with native mouse events (mousedown, mousemove,
   * mouseup through the window's widget path) from character `fromChar` to
   * `toChar` of the answer's text (default: the whole first paragraph).
   */
  selectReaderInlineAskAnswerText: (input: {
    answerIndex: number;
    fromChar?: number;
    toChar?: number;
  }) => Promise<WorkflowTestReaderInlineAskAnswerSelection>;
  /** Drags over the whole inline math at `mathIndex` of an answer. */
  selectReaderInlineAskAnswerMath: (input: {
    answerIndex: number;
    mathIndex: number;
  }) => Promise<WorkflowTestReaderInlineAskAnswerSelection>;
  /** Reads how the answer's math renders. */
  readReaderInlineAskMath: (
    answerIndex: number,
  ) => Promise<WorkflowTestReaderInlineAskMath>;
  /** Clicks the passage line (it expands or collapses). */
  clickReaderInlineAskPassage: () => Promise<WorkflowTestReaderInlineAskCard>;
  /** Leaves the annotation card with its Back or Cancel button. */
  leaveReaderInlineAskSave: (input: {
    via: "back" | "cancel";
  }) => Promise<WorkflowTestReaderInlineAskCard>;
  /** Clicks Copy or Quote on the selection bar with native mouse events. */
  clickReaderInlineAskSelectionAction: (
    action: "Copy" | "Quote",
  ) => Promise<WorkflowTestReaderInlineAskCard>;
  /** Clicks the remove button of the composer quote at `index`. */
  removeReaderInlineAskComposerQuote: (
    index: number,
  ) => Promise<WorkflowTestReaderInlineAskCard>;
  /** Runs the copy command on the reader document and reads the clipboard. */
  copyReaderInlineAskSelection: () => Promise<{
    commandRan: boolean;
    clipboardText: string;
  }>;
  /** The clipboard's plain text now. */
  readReaderInlineAskClipboard: () => string;
  /** Presses a key in the follow-up field ("editor") or on the page. */
  pressReaderInlineAskKey: (input: {
    key: string;
    target: "editor" | "page";
  }) => Promise<WorkflowTestReaderInlineAskCard>;
  /** Moves the pointer onto or off the passage. */
  hoverReaderInlineAskPassage: (
    on: boolean,
  ) => Promise<WorkflowTestReaderInlineAskCard>;
  /** Moves the pointer onto or off one corner's hit area. */
  hoverReaderInlineAskCorner: (
    corner: "top-left" | "top-right" | "bottom-left" | "bottom-right",
    on: boolean,
  ) => Promise<WorkflowTestReaderInlineAskCard>;
  /** Drags a blank point of the card ("card") or its corner grip ("resize"). */
  dragReaderInlineAsk: (input: {
    part: "card" | "resize";
    /** The corner to drag for a resize; the default is bottom-right. */
    corner?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    dx: number;
    dy: number;
  }) => Promise<WorkflowTestReaderInlineAskCard>;
  /**
   * In the open prompt editor: presses typing keys in both fields, fills
   * Label and Prompt, and finishes with Enter in Label, Mod+Enter in Prompt,
   * or the Save button.
   */
  editReaderInlineAskPrompt: (input: {
    label: string;
    prompt: string;
    via: "enter-in-label" | "mod-enter-in-prompt" | "save-button";
  }) => Promise<WorkflowTestReaderInlineAskPromptEdit>;
  /** Clicks the model or effort button and reads the menu it opened. */
  openReaderInlineAskModelMenu: (
    kind: "model" | "effort",
  ) => Promise<WorkflowTestReaderInlineAskModelMenu>;
  /** Clicks an option (entry id or effort level) of the open model menu. */
  pickReaderInlineAskMenuOption: (
    value: string,
  ) => Promise<WorkflowTestReaderInlineAskCard>;
  /** The messages a workflow panel renders and stores for its conversation. */
  readPanelChatMessages: (
    panelId: string,
  ) => Promise<WorkflowTestPanelChatMessages>;
  /** Total rows in the conversation catalogs, message, registry and usage tables. */
  getConversationStoreRowTotals: () => Promise<WorkflowTestConversationStoreRowTotals>;
  exerciseHighlightAwareContextRetrieval: (input: {
    panelId: string;
    attachmentItemId: number;
    pageIndex: number;
    selectedText: string;
    question: string;
    trigger: "popup" | "action-bar";
  }) => Promise<WorkflowTestHighlightAwareRetrievalDiagnostics>;
  exerciseContextChipCardVisibility: (input: {
    panelId?: string;
    standalone: boolean;
    selectedText: string;
  }) => Promise<{
    cardWidth: number;
    cardHeight: number;
    cardTop: number;
    cardBottom: number;
    /** Top edge of #llm-context-previews. */
    rowTop: number;
    /** Card edge distance from the .llm-input-section edge. */
    leftInset: number;
    rightInset: number;
    /** Whether elementFromPoint at the card center lands in the card. */
    hitIsCard: boolean;
    hitDescription: string;
  }>;
  exerciseAssistantSelectionInlinePrompt: (input: {
    panelId: string;
    assistantText: string;
    selectedText: string;
    prompt: string;
  }) => Promise<{
    popupVisible: boolean;
    promptExpandedAfterQuote: boolean;
    chipAddedBeforeAttach: boolean;
    /** The section label and the quoted selection shown above the input. */
    boxSelectedTextLabel: string;
    boxSelectedText: string;
    hintText: string;
    /** Whether the send interceptor fired within 1 s of Enter in the box. */
    sentWithinOneSecond: boolean;
    /** The chip's userQuery after Enter. */
    attachedQuestion: string;
    /** Chips holding the selected text after Enter. */
    chipCount: number;
    /** `.llm-selected-context-question` text in the panel's chip preview. */
    previewQuestionText: string;
    previewLabels: string[];
    popupHiddenAfterAttach: boolean;
    composerAfterAttach: string;
    statusAfterAttach: string;
    composerFocusedAfterAttach: boolean;
    /** The model-facing question of the main Send with an empty composer. */
    sentQuestion: string;
    /** The user turn as shown in the chat (displayQuestion). */
    sentDisplayQuestion: string;
    sentSelectedTexts: string[];
    /** The sent user bubble once rendered: its visible body text ("" when
     * hidden or absent), the questions inside its shown chip cards, and the
     * number of bars drawn for chips that have a question (one card and no
     * bar each, so 0). */
    sentBubbleBodyText: string;
    sentBubbleChipQuestions: string[];
    sentBubbleBarCount: number;
  }>;
  exerciseAssistantSelectionNoteSave: (input: {
    panelId: string;
    assistantText: string;
    /** "full" selects heading to end; "code" selects lines inside one code body. */
    selection: "full" | "code";
    /** For "code": the text inside the code body where the selection starts and ends. */
    codeStart?: string;
    codeEnd?: string;
  }) => Promise<{
    bubbleHasContentBar: boolean;
    /** Ranges Gecko produced for the selection. */
    nativeRangeCount: number;
    /** Ranges the extractor read (rebuilt like a mouse drag when Gecko kept one). */
    rangeCount: number;
    extracted: string;
    /** HTML of the child note that "Save as note" created, read from Zotero. */
    noteHtml: string;
  }>;
  exerciseAssistantSelectionPromptDismissal: (input: {
    panelId: string;
    assistantText: string;
    firstSelectedText: string;
    secondSelectedText: string;
    /** Typed into the box that a duplicate quote of the first text opens. */
    duplicatePrompt: string;
  }) => Promise<{
    firstExpanded: boolean;
    escapeClosed: boolean;
    firstChipsAfterEscape: number;
    firstQuestionAfterEscape: string;
    /** Quoting the same text again opens the box for the existing chip. */
    duplicateExpanded: boolean;
    duplicateStatus: string;
    firstChipsAfterDuplicate: number;
    duplicateAttachClosed: boolean;
    firstChipsAfterDuplicateAttach: number;
    firstQuestionAfterDuplicateAttach: string;
    secondExpanded: boolean;
    emptyEnterClosed: boolean;
    secondChipsAfterEmptyEnter: number;
    secondQuestionAfterEmptyEnter: string;
    sent: boolean;
  }>;
  cleanupFixture: (
    fixture:
      | WorkflowTestFixture
      | WorkflowTestAttachmentFixture
      | WorkflowTestNoteFixture
      | WorkflowTestStandaloneNoteFixture,
  ) => Promise<void>;
  listPanelHistory: (
    panelId: string,
    /** `reopen`: close an open menu first, so the list is read again. */
    options?: { reopen?: boolean },
  ) => Promise<WorkflowTestHistoryRow[]>;
  /**
   * Writes a chat (one user turn and one answer) into a runtime's catalog
   * and message store directly, as a finished chat of that runtime would be
   * stored; no Codex or Claude Code process takes part.
   */
  seedHistoryConversation: (input: {
    system: ConversationSystem;
    kind: "global" | "paper";
    /** The paper (or note) a paper chat belongs to. */
    paperItemId?: number;
    userText: string;
    assistantText?: string;
  }) => Promise<WorkflowTestSeededHistoryConversation>;
  /** Removes a seeded chat's local rows (catalog, messages, index). */
  deleteSeededHistoryConversation: (
    seeded: WorkflowTestSeededHistoryConversation,
  ) => Promise<void>;
  /** Clicks a row of the panel's history menu; waits for the open to end. */
  clickPanelHistoryRow: (
    panelId: string,
    conversationKey: number,
  ) => Promise<WorkflowTestDiagnostics>;
  /**
   * Clicks the visible row of `conversationKey` while a test-only hook forces
   * that open to fail, waits for the open to settle, and clears the hook.
   * `interceptorHit` records whether the hook was consulted for that key.
   */
  clickPanelHistoryRowWithForcedOpenFailure: (
    panelId: string,
    conversationKey: number,
    system: ConversationSystem,
  ) => Promise<{
    diagnostics: WorkflowTestDiagnostics;
    interceptorHit: boolean;
  }>;
  /** Clicks several history rows in one task, then waits for the panel. */
  clickPanelHistoryRowsRapidly: (
    panelId: string,
    conversationKeys: number[],
  ) => Promise<WorkflowTestRapidHistoryClicks>;
  /**
   * Opens the panel's Search history popup, searches `query`, and clicks the
   * row of `conversationKey` (when `conversationKey` is 0, only lists).
   */
  searchAndOpenPanelHistory: (
    panelId: string,
    query: string,
    conversationKey: number,
  ) => Promise<WorkflowTestHistorySearchOpen>;
  /**
   * Renames a history row through its rename button and dialog. Resolves
   * with the title each runtime's catalog holds for that key afterwards.
   */
  renamePanelHistoryConversation: (
    panelId: string,
    conversationKey: number,
    title: string,
  ) => Promise<Record<ConversationSystem, string | null>>;
  /** Rows of the standalone window's own history list (left sidebar). */
  listStandaloneSidebarHistory: () => Promise<WorkflowTestHistoryRow[]>;
  /** Clicks a row of the window's history list; waits for the mount. */
  clickStandaloneSidebarHistoryRow: (
    conversationKey: number,
  ) => Promise<WorkflowTestStandaloneDiagnostics>;
  /** The window's pin button and "Pinned papers" rows. */
  listStandalonePinnedPapers: () => Promise<WorkflowTestStandalonePinnedPapers>;
  /** Clicks the pin button next to the paper chat's title. */
  clickStandalonePinButton: () => Promise<WorkflowTestStandalonePinnedPapers>;
  /** Clicks "Clear" on the "Pinned papers" label row (unpins all). */
  clickStandalonePinnedClear: () => Promise<WorkflowTestStandalonePinnedPapers>;
  /** Clicks a "Pinned papers" row (open) or its × (unpin). */
  clickStandalonePinnedPaper: (
    paperItemId: number,
    action?: "open" | "unpin",
  ) => Promise<WorkflowTestStandaloneDiagnostics>;
  /**
   * Opens the window's Search history popup, searches `query`, and clicks
   * the row of `conversationKey`.
   */
  searchAndOpenStandaloneHistory: (
    query: string,
    conversationKey: number,
  ) => Promise<WorkflowTestHistorySearchOpen>;
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
  /** Holds a conversation's write lock until released. */
  holdConversationWriteLock: (conversationKey: number) => Promise<void>;
  /** Whether a write waits behind the held lock. */
  isConversationWriteLockQueued: (conversationKey: number) => Promise<boolean>;
  /** Treats the writes queued so far as seen. */
  markConversationWriteLockQueue: (conversationKey: number) => Promise<void>;
  releaseConversationWriteLock: (conversationKey: number) => Promise<void>;
  /**
   * Holds the next chat request after it wrote its user row, before
   * dispatch, until released. Later requests pass.
   */
  holdNextFinalRequest: () => Promise<void>;
  /** Whether the held request has reached the hold. */
  isFinalRequestHeld: () => Promise<boolean>;
  releaseFinalRequest: () => Promise<void>;
  forceWebChatSessionAnchorFailures: (count: number) => Promise<void>;
  /** Makes the next N in-place paper switches fail before they draw. */
  failNextInPlacePaperSwitches: (count: number) => Promise<void>;
  /** Forced in-place switch failures that no switch has used yet. */
  getPendingInPlacePaperSwitchFailures: () => Promise<number>;
  /**
   * Adds a selected-text chip to the conversation a mounted pane shows, or
   * clears its chips when text is null. Resolves to that conversation's key.
   */
  setMountedPanelSelectedText: (
    body: Element,
    text: string | null,
  ) => Promise<number>;
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
