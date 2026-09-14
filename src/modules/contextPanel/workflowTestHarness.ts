import { getChatScrollSnapshot } from "./chatScrollSnapshots";
import {
  exerciseNativePlanReview,
  exerciseNativeQuestionReview,
} from "./nativePlanReviewReplay";
import { exercisePlanHistoryReplay } from "./planHistoryReplay";
import { exerciseStreamingReplay } from "./streamingReplay";
import { buildUI } from "./buildUI";
import { getAgentRuntime } from "../../agent";
import { renderPendingActionCard, renderAgentTrace } from "./agentTrace/render";
import { disposeSetupHandlers, setupHandlers } from "./setupHandlers";
import { PLAN_APPROVED_EVENT } from "./planModeState";
import {
  buildQueuedFollowUpThreadKey,
  getQueuedFollowUps,
  setQueuedFollowUps,
} from "./queuedFollowUps";
import {
  activeConversationModeByLibrary,
  activeContextPanels,
  activeContextPanelRawItems,
  activeContextPanelStateSync,
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
  chatHistory,
  selectedRuntimeModeCache,
  loadedConversationKeys,
  webChatIsolatedConversationKeys,
  paperContextModeOverrides,
  paperContentSourceOverrides,
  selectedPaperContextCache,
  selectedCollectionContextCache,
  selectedTagContextCache,
  initializedConversationComposeContextKeys,
  isRequestPending,
} from "./state";
import type { ResolvedContextSource, SendQuestionOptions } from "./types";
import type {
  WorkflowTestApi,
  WorkflowTestAssistantRenderResult,
  WorkflowTestAttachmentFixture,
  WorkflowTestDiagnostics,
  WorkflowTestDraftRefreshDiagnostics,
  WorkflowTestDuplicatePanelSetupDiagnostics,
  WorkflowTestFixture,
  WorkflowTestFooterLayout,
  WorkflowTestHighlightAwareRetrievalDiagnostics,
  WorkflowTestNoteFixture,
  WorkflowTestPanel,
  WorkflowTestReaderPopupRoutingDiagnostics,
  WorkflowTestReaderPopupStandaloneRoutingDiagnostics,
  WorkflowTestReaderSelectionTrackingDiagnostics,
  WorkflowTestRuntimeGeometry,
  WorkflowTestRuntimeSystemToggle,
  WorkflowTestStandaloneComposerResizeDiagnostics,
  WorkflowTestStandaloneDiagnostics,
  WorkflowTestStandaloneNoteFixture,
  WorkflowTestTargetedQuoteRefreshResult,
  WorkflowTestLiveWebChatTurn,
  WorkflowTestWebChatPdfChipState,
  WorkflowTestWebChatPdfToggleDiagnostics,
  WorkflowTestWebChatPdfTurn,
  WorkflowTestPendingDeletionState,
  WorkflowTestPendingSendDeleteResult,
  WorkflowTestPermissionSurfaceDiagnostics,
  WorkflowTestConfirmationDialogDiagnostics,
  WorkflowTestHistoryRow,
  WorkflowTestHistorySearchResult,
  WorkflowTestSeededTurn,
  WorkflowTestConversationPersistenceSnapshot,
  WorkflowTestCrossPaperHistoryIsolationResult,
  WorkflowTestStaleAgentTraceIsolationResult,
} from "./workflowTestTypes";
import { setFooterPermissionCatalogLoadersForTests } from "./footerPermissionControl";
import { buildClaudePermissionOption } from "../../shared/permissionOptions";
import {
  buildCodexPermissionOptionCatalog,
  type CodexPermissionCapabilities,
} from "../../codexAppServer/permissionProfiles";
import { readCodexPermissionStatePref } from "../../codexAppServer/prefs";
import { forcePendingTurnFinalizeFailuresForTests } from "./pendingDeletionWiring";
import {
  pendingDeletionStore,
  PENDING_DELETIONS_TABLE,
} from "../../core/conversations/pendingDeletionStore";
import type { Message } from "./types";
import {
  buildAssistantDisplayMarkdownForRender,
  buildAgentEngineDepsForTests,
  ensureConversationLoaded,
  getConversationKey,
  hasAgentRunTraceForTests,
  refreshChat,
  setAgentRunTraceLoaderForTests,
  updateContextUsageSnapshotFromProvider,
} from "./chat";
import {
  applySelectedTextPreview,
  getSelectedTextContextEntries,
  resolveContextSourceItemAsync,
} from "./contextResolution";
import { resolveInitialPanelItemState } from "./portalScope";
import { syncNoteEditingSelectedText } from "./noteEditing/selectionController";
import {
  decorateAssistantCitationLinks,
  renderQuoteCitationPlaceholders,
} from "./assistantCitationLinks";
import { renderRenderedMarkdownInto } from "./renderedMarkdown";
import { openStandalonePlanDocumentWindow } from "./standalonePlanDocumentWindow";
import { renderPlanDocumentContent } from "./planDocumentPresentation";
import {
  notifyStandaloneItemChanged as notifyStandaloneItemChangedRuntime,
  openStandaloneChat,
} from "./standaloneWindow";
import {
  getWorkflowTestSendSettledSequence,
  setWorkflowTestFinalRequestInterceptor,
  setWorkflowTestSendInterceptor,
  type WorkflowTestFinalRequestSnapshot,
} from "./workflowTestHooks";
import { dispatchZoteroItemsAsContext } from "./zoteroItemContextMenu";
import { appendMessage } from "../../utils/chatStore";
import { appendCodexMessage } from "../../codexAppServer/store";
import { appendClaudeMessage } from "../../claudeCode/store";
import {
  ensureMarkedReaderSelectionTrackingListener,
  READER_TEXT_SELECTION_POPUP_EVENT,
  type ReaderSelectionTrackingReader,
} from "./readerSelectionTracking";
import { config } from "./constants";
import {
  getModelProviderGroups,
  setModelProviderGroups,
  getModelEntryById,
} from "../../utils/modelProviders";
import type { RuntimeConversationSystem } from "./runtimeSystemControls";
import { collectReaderSelectionDocuments } from "./readerSelection";
import { getReaderContextPanelForTab } from "./readerPopupPanelRouting";
import type { ConversationSystem } from "../../shared/types";
import { clearPaperRestoreTargetsForWorkflowTests } from "../../shared/paperConversationRestore";
import { relayGetStateSnapshot } from "../../webchat/relayServer";
import {
  bindEmbeddedPanelHost,
  bindTestPanelHost,
  capturePanelOperationLease,
} from "./panelHostOwnership";
import {
  getConversationWriteGeneration,
  bumpConversationWriteGeneration,
} from "../../shared/conversationWriteFence";
import {
  loadLatestPlanDocumentForExecution,
  loadPlanDocumentOutbox,
} from "../../agent/documents/store";
import { planExecutionCoordinator } from "../../agent/plans/coordinator";
import {
  loadPlanArtifact,
  loadPlanExecutionLedger,
} from "../../agent/plans/store";
import {
  buildResearchFlightReport,
  renderResearchFlightReport,
  type FlightRun,
} from "../../agent/research/flightReport";
import {
  listPaperFindings,
  listResearchCorpusItems,
  listResearchEdges,
  listResearchOpenQuestions,
  listThemeFindings,
  loadResearchJobForExecution,
} from "../../agent/research/store";
import {
  getAgentRunTrace,
  listAgentRunsForConversation,
} from "../../agent/store/traceStore";
import {
  activeClaudeConversationModeByLibrary,
  activeClaudeGlobalConversationByLibrary,
  activeClaudePaperConversationByPaper,
} from "../../claudeCode/state";
import {
  activeCodexConversationModeByLibrary,
  activeCodexGlobalConversationByLibrary,
  activeCodexPaperConversationByPaper,
} from "../../codexAppServer/state";

let resolveDelayedCodexPermissionCatalog: (() => void) | null = null;

function configurePermissionCatalogs(input?: {
  delayFirstCodex?: boolean;
}): void {
  assertWorkflowTestEnabled();
  let codexRequestCount = 0;
  const claudeOptions = [
    "plan",
    "dontAsk",
    "default",
    "acceptEdits",
    "auto",
    "bypassPermissions",
  ].map((id) =>
    buildClaudePermissionOption({
      id: id as Parameters<typeof buildClaudePermissionOption>[0]["id"],
    }),
  );
  const currentCodexProfiles = [
    { id: ":read-only", description: "Read files only.", allowed: true },
    { id: ":workspace", description: "Write in the workspace.", allowed: true },
    {
      id: ":danger-full-access",
      description: "Use the full local environment.",
      allowed: true,
    },
    {
      id: ":team_custom_profile",
      description: "A custom managed team profile.",
      allowed: true,
    },
  ];
  const staleCodexProfiles = [
    {
      id: ":stale-profile",
      description: "A deliberately stale workflow response.",
      allowed: true,
    },
  ];
  const buildCatalog = (profiles: typeof currentCodexProfiles) => {
    const capabilities: CodexPermissionCapabilities = {
      protocol: "profiles",
      profiles,
      allowedApprovalPolicies: null,
      allowedApprovalsReviewers: null,
      guardianApprovalEnabled: true,
      supportsThreadSettingsUpdate: true,
    };
    return buildCodexPermissionOptionCatalog({
      capabilities,
      preference: readCodexPermissionStatePref(),
    });
  };
  resolveDelayedCodexPermissionCatalog = null;
  setFooterPermissionCatalogLoadersForTests({
    loadClaudeOptions: async () => claudeOptions,
    loadCodexCatalog: () => {
      codexRequestCount += 1;
      if (input?.delayFirstCodex && codexRequestCount === 1) {
        return new Promise((resolve) => {
          resolveDelayedCodexPermissionCatalog = () => {
            resolve(buildCatalog(staleCodexProfiles));
            resolveDelayedCodexPermissionCatalog = null;
          };
        });
      }
      return Promise.resolve(buildCatalog(currentCodexProfiles));
    },
  });
}

async function resolveDelayedCodexCatalog(): Promise<void> {
  assertWorkflowTestEnabled();
  resolveDelayedCodexPermissionCatalog?.();
  await Zotero.Promise.delay(100);
}

function readPermissionSurface(
  root: ParentNode | null | undefined,
): WorkflowTestPermissionSurfaceDiagnostics {
  const main = root?.querySelector("#llm-main") as HTMLElement | null;
  const control = root?.querySelector(
    "#llm-permission-control",
  ) as HTMLElement | null;
  const button = root?.querySelector(
    "#llm-permission-toggle",
  ) as HTMLButtonElement | null;
  const menu = root?.querySelector(
    "#llm-permission-menu",
  ) as HTMLDivElement | null;
  const rows = Array.from(
    root?.querySelectorAll("#llm-permission-menu .llm-permission-option") || [],
  ) as HTMLButtonElement[];
  return {
    provider:
      (main?.dataset.conversationSystem as ConversationSystem | undefined) ??
      null,
    visible: Boolean(control && control.style.display !== "none"),
    compactLabel: button?.textContent?.trim() || "",
    accessibleName: button?.getAttribute("aria-label") || "",
    disabled: button?.disabled ?? true,
    expanded: button?.getAttribute("aria-expanded") === "true",
    menuVisible: Boolean(menu && menu.style.display !== "none"),
    rows: rows.map((row) => ({
      id: row.dataset.permissionId || "",
      label: row.textContent?.trim() || "",
      level: "",
      risk: "",
      disabled: row.disabled,
      accessibleName: row.getAttribute("aria-label") || "",
    })),
  };
}

function getConfirmationDocument(root: ParentNode): Document {
  if ((root as Document).documentElement) return root as Document;
  const doc = (root as Element).ownerDocument;
  if (!doc) throw new Error("Permission surface has no owner document");
  return doc;
}

function readConfirmationDialog(
  root: ParentNode,
): WorkflowTestConfirmationDialogDiagnostics {
  const doc = getConfirmationDocument(root);
  const overlay = doc.querySelector(
    ".llm-standalone-confirm-overlay",
  ) as HTMLElement | null;
  return {
    visible: Boolean(overlay),
    title:
      overlay?.querySelector(".llm-standalone-confirm-title")?.textContent ||
      "",
    message:
      overlay?.querySelector(".llm-standalone-confirm-message")?.textContent ||
      "",
    confirmLabel:
      overlay?.querySelector(".llm-standalone-confirm-primary")?.textContent ||
      "",
    cancelLabel:
      overlay?.querySelector(".llm-standalone-confirm-cancel")?.textContent ||
      "",
    destructive: Boolean(
      overlay?.querySelector(".llm-standalone-confirm-destructive"),
    ),
  };
}

async function respondToConfirmationDialog(
  root: ParentNode,
  confirmed: boolean,
): Promise<WorkflowTestPermissionSurfaceDiagnostics> {
  const doc = getConfirmationDocument(root);
  const button = doc.querySelector(
    confirmed
      ? ".llm-standalone-confirm-primary"
      : ".llm-standalone-confirm-cancel",
  ) as HTMLButtonElement | null;
  if (!button)
    throw new Error("Permission confirmation dialog was not rendered");
  button.click();
  await Zotero.Promise.delay(100);
  return readPermissionSurface(root);
}

async function clickPermissionToggle(
  root: ParentNode,
): Promise<WorkflowTestPermissionSurfaceDiagnostics> {
  const button = root.querySelector(
    "#llm-permission-toggle",
  ) as HTMLButtonElement | null;
  if (!button) throw new Error("Permission toggle was not rendered");
  button.click();
  await Zotero.Promise.delay(50);
  return readPermissionSurface(root);
}

async function clickPermissionOption(
  root: ParentNode,
  permissionId: string,
): Promise<WorkflowTestPermissionSurfaceDiagnostics> {
  const deadline = Date.now() + 3000;
  let row: HTMLButtonElement | undefined;
  while (!row && Date.now() < deadline) {
    row = (
      Array.from(
        root.querySelectorAll("#llm-permission-menu .llm-permission-option"),
      ) as HTMLButtonElement[]
    ).find((candidate) => candidate.dataset.permissionId === permissionId);
    if (!row) await Zotero.Promise.delay(25);
  }
  if (!row)
    throw new Error(`Permission option ${permissionId} was not rendered`);
  row.click();
  await Zotero.Promise.delay(100);
  return readPermissionSurface(root);
}

function getPanelPermissionSurface(
  panelId: string,
): WorkflowTestPermissionSurfaceDiagnostics {
  assertWorkflowTestEnabled();
  return readPermissionSurface(getPanel(panelId).body);
}

async function clickPanelPermissionToggle(
  panelId: string,
): Promise<WorkflowTestPermissionSurfaceDiagnostics> {
  assertWorkflowTestEnabled();
  return clickPermissionToggle(getPanel(panelId).body);
}

async function clickPanelPermissionOption(
  panelId: string,
  permissionId: string,
): Promise<WorkflowTestPermissionSurfaceDiagnostics> {
  assertWorkflowTestEnabled();
  return clickPermissionOption(getPanel(panelId).body, permissionId);
}

function getPanelConfirmationDialog(
  panelId: string,
): WorkflowTestConfirmationDialogDiagnostics {
  assertWorkflowTestEnabled();
  return readConfirmationDialog(getPanel(panelId).body);
}

async function respondToPanelConfirmationDialog(
  panelId: string,
  confirmed: boolean,
): Promise<WorkflowTestPermissionSurfaceDiagnostics> {
  assertWorkflowTestEnabled();
  return respondToConfirmationDialog(getPanel(panelId).body, confirmed);
}

function getStandalonePermissionSurface(): WorkflowTestPermissionSurfaceDiagnostics {
  assertWorkflowTestEnabled();
  return readPermissionSurface(getStandaloneWindowForTest()?.document);
}

async function clickStandalonePermissionToggle(): Promise<WorkflowTestPermissionSurfaceDiagnostics> {
  assertWorkflowTestEnabled();
  const doc = await waitForStandaloneReady();
  return clickPermissionToggle(doc);
}

async function clickStandalonePermissionOption(
  permissionId: string,
): Promise<WorkflowTestPermissionSurfaceDiagnostics> {
  assertWorkflowTestEnabled();
  const doc = await waitForStandaloneReady();
  return clickPermissionOption(doc, permissionId);
}
import {
  removeLastUsedUpstreamConversationMode,
  removeLastUsedUpstreamGlobalConversationKey,
} from "./prefHelpers";

async function appendWorkflowStoredMessage(
  system: ConversationSystem,
  conversationKey: number,
  message: Parameters<typeof appendMessage>[1],
): Promise<void> {
  if (system === "codex") {
    await appendCodexMessage(conversationKey, message);
    return;
  }
  if (system === "claude_code") {
    await appendClaudeMessage(conversationKey, message);
    return;
  }
  await appendMessage(conversationKey, message);
}

function readRuntimeSystemToggles(
  root: ParentNode | null | undefined,
  groupSelector: string,
): WorkflowTestRuntimeSystemToggle[] {
  const group = root?.querySelector(groupSelector) as HTMLElement | null;
  if (!group) return [];
  const groupVisible = group.style.display !== "none";
  return (
    Array.from(
      group.querySelectorAll(
        ".llm-runtime-system-toggle[data-conversation-system]",
      ),
    ) as HTMLButtonElement[]
  )
    .map((button) => {
      const system = button.dataset.conversationSystem;
      if (system !== "codex" && system !== "claude_code") return null;
      return {
        system,
        visible: groupVisible && button.style.display !== "none",
        active: button.dataset.active === "true",
        disabled: button.disabled,
        ariaPressed: button.getAttribute("aria-pressed") === "true",
      };
    })
    .filter(
      (state): state is WorkflowTestRuntimeSystemToggle => state !== null,
    );
}

type GeometryRect = Pick<
  DOMRect,
  "left" | "right" | "top" | "bottom" | "width" | "height"
>;

function rectsIntersect(
  first: GeometryRect | null,
  second: GeometryRect | null,
): boolean {
  if (
    !first ||
    !second ||
    first.width <= 0 ||
    first.height <= 0 ||
    second.width <= 0 ||
    second.height <= 0
  ) {
    return false;
  }
  return (
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top
  );
}

function rectWithinContainer(
  rect: GeometryRect,
  container: GeometryRect,
): boolean {
  const tolerance = 0.5;
  return (
    rect.left >= container.left - tolerance &&
    rect.right <= container.right + tolerance &&
    rect.top >= container.top - tolerance &&
    rect.bottom <= container.bottom + tolerance
  );
}

function getVisibleRuntimeControlsRect(group: HTMLElement): GeometryRect {
  const buttonRects = getVisibleRuntimeButtonRects(group);
  if (!buttonRects.length) return group.getBoundingClientRect();
  const left = Math.min(...buttonRects.map((rect) => rect.left));
  const right = Math.max(...buttonRects.map((rect) => rect.right));
  const top = Math.min(...buttonRects.map((rect) => rect.top));
  const bottom = Math.max(...buttonRects.map((rect) => rect.bottom));
  return {
    left,
    right,
    top,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function getVisibleRuntimeButtonRects(group: HTMLElement): DOMRect[] {
  return (
    Array.from(
      group.querySelectorAll(
        ".llm-runtime-system-toggle[data-conversation-system]",
      ),
    ) as HTMLElement[]
  )
    .map((button) => button.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
}

type PanelRecord = {
  id: string;
  body: HTMLElement;
  item: Zotero.Item;
  contextSnapshot: ResolvedContextSource | null;
};

const panels = new Map<string, PanelRecord>();
let panelCounter = 0;
let lastSend: SendQuestionOptions | null = null;
let lastFinalRequest: WorkflowTestFinalRequestSnapshot | null = null;

function assertWorkflowTestEnabled(): void {
  if (__env__ !== "test" && __env__ !== "development") {
    throw new Error("Workflow test harness is not available in production");
  }
}

function getWorkflowDocument(): Document {
  const directDoc = (globalThis as { document?: Document }).document;
  if (directDoc) return directDoc;
  const mainDoc = Zotero.getMainWindow?.()?.document;
  if (mainDoc) return mainDoc;
  throw new Error("No document available for workflow test panel rendering");
}

function appendHost(doc: Document): HTMLElement {
  const host = doc.createElement("div");
  host.className = "llm-workflow-test-host";
  host.setAttribute("data-llm-workflow-test", "true");
  host.style.position = "fixed";
  host.style.left = "-10000px";
  host.style.top = "0";
  host.style.width = "720px";
  host.style.height = "960px";
  const parent = doc.body || doc.documentElement;
  parent.appendChild(host);
  return host;
}

function getTempPath(filename: string): string {
  const tempDir = Zotero.getTempDirectory?.()?.path?.trim();
  if (!tempDir) throw new Error("Zotero temp directory is unavailable");
  const pathUtils = (
    globalThis as { PathUtils?: { join?: (...parts: string[]) => string } }
  ).PathUtils;
  return pathUtils?.join
    ? pathUtils.join(tempDir, filename)
    : `${tempDir.replace(/[\\/]+$/u, "")}/${filename}`;
}

function sanitizeTempFilename(filename: string): string {
  const sanitized = filename.replace(/[^A-Za-z0-9._-]+/gu, "_");
  return sanitized || "attachment.dat";
}

function escapePdfText(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/\(/gu, "\\(")
    .replace(/\)/gu, "\\)");
}

function wrapPdfPageText(value: string): string[] {
  const words = value
    .replace(/[^\x20-\x7E\n]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= 82) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines;
}

function buildPdfBytes(pageTexts: string[]): Uint8Array {
  const pages = pageTexts.length ? pageTexts : ["Workflow PDF fixture"];
  const fontObjectId = 3 + pages.length * 2;
  const pageObjectIds = pages.map((_, index) => 3 + index * 2);
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjectIds
      .map((id) => `${id} 0 R`)
      .join(" ")}] /Count ${pages.length} >>`,
  ];
  for (const [index, pageText] of pages.entries()) {
    const pageObjectId = pageObjectIds[index];
    const contentObjectId = pageObjectId + 1;
    const lines = wrapPdfPageText(pageText).slice(0, 58);
    const stream = [
      "BT",
      "/F1 10 Tf",
      "40 760 Td",
      "12 TL",
      ...lines.flatMap((line) => [`(${escapePdfText(line)}) Tj`, "T*"]),
      "ET",
    ].join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

function minimalPdfBytes(title: string): Uint8Array {
  return buildPdfBytes([title]);
}

async function writeTempFile(
  filename: string,
  data: Uint8Array,
): Promise<string> {
  const path = getTempPath(
    `llm-for-zotero-workflow-${Date.now()}-${sanitizeTempFilename(filename)}`,
  );
  const ioUtils = (
    globalThis as unknown as {
      IOUtils?: {
        write?: (path: string, data: Uint8Array) => Promise<unknown>;
      };
    }
  ).IOUtils;
  if (!ioUtils?.write) throw new Error("IOUtils.write is unavailable");
  await ioUtils.write(path, data);
  return path;
}

async function writeTempPdf(title: string, pages?: string[]): Promise<string> {
  return writeTempFile("paper.pdf", buildPdfBytes(pages || [title]));
}

async function removePathIfPossible(path: string): Promise<void> {
  if (!path) return;
  try {
    await (
      globalThis as { IOUtils?: { remove?: (path: string) => Promise<void> } }
    ).IOUtils?.remove?.(path);
  } catch (_error) {
    void _error;
  }
}

async function trashItemIfPossible(itemId: number): Promise<void> {
  const item = Zotero.Items.get(itemId);
  if (!item) return;
  try {
    item.deleted = true;
    await item.saveTx();
  } catch (_error) {
    void _error;
  }
}

const WORKFLOW_CONVERSATION_PERSISTENCE_TABLES = {
  upstream: {
    catalogs: [
      "llm_for_zotero_global_conversations",
      "llm_for_zotero_paper_conversations",
    ],
    messages: "llm_for_zotero_chat_messages",
  },
  claude_code: {
    catalogs: ["llm_for_zotero_claude_conversations"],
    messages: "llm_for_zotero_claude_messages",
  },
  codex: {
    catalogs: ["llm_for_zotero_codex_conversations"],
    messages: "llm_for_zotero_codex_messages",
  },
} as const;

async function countWorkflowRows(
  tableName: string,
  whereSql: string,
  params: unknown[],
): Promise<number> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT COUNT(*) AS n FROM ${tableName} WHERE ${whereSql}`,
    params,
  )) as Array<{ n?: unknown }>;
  return Math.max(0, Math.floor(Number(rows?.[0]?.n || 0)));
}

async function setWorkflowProviderSession(
  system: ConversationSystem,
  conversationKey: number,
  providerSessionId: string,
): Promise<void> {
  assertWorkflowTestEnabled();
  if (system !== "codex" && system !== "claude_code") {
    throw new Error(`Provider sessions are not supported for ${system}`);
  }
  const table =
    system === "codex"
      ? "llm_for_zotero_codex_conversations"
      : "llm_for_zotero_claude_conversations";
  const normalizedSessionID = String(providerSessionId || "").trim();
  if (!normalizedSessionID) throw new Error("Provider session ID is required");
  await Zotero.DB.queryAsync(
    `UPDATE ${table}
     SET provider_session_id = ?
     WHERE conversation_key = ?`,
    [normalizedSessionID, conversationKey],
  );
}

async function getWorkflowConversationPersistenceSnapshot(
  system: ConversationSystem,
  conversationKey: number,
): Promise<WorkflowTestConversationPersistenceSnapshot> {
  assertWorkflowTestEnabled();
  const tables = WORKFLOW_CONVERSATION_PERSISTENCE_TABLES[system];
  const catalogRows = (
    await Promise.all(
      tables.catalogs.map((table) =>
        countWorkflowRows(table, "conversation_key = ?", [conversationKey]),
      ),
    )
  ).reduce((total, count) => total + count, 0);
  const messageRows = await countWorkflowRows(
    tables.messages,
    "conversation_key = ?",
    [conversationKey],
  );
  const searchIndexRows = await countWorkflowRows(
    "llm_for_zotero_conversation_search_index",
    "system = ? AND legacy_conversation_key = ?",
    [system, conversationKey],
  );
  const registryRows = await countWorkflowRows(
    "llm_for_zotero_conversation_registry",
    "system = ? AND legacy_conversation_key = ?",
    [system, conversationKey],
  );
  const forkSourceRows = await countWorkflowRows(
    "llm_for_zotero_conversation_fork_links",
    "source_system = ? AND source_conversation_key = ?",
    [system, conversationKey],
  );
  const forkTargetRows = await countWorkflowRows(
    "llm_for_zotero_conversation_fork_links",
    "target_system = ? AND target_conversation_key = ?",
    [system, conversationKey],
  );
  const cleanupJobRows = await countWorkflowRows(
    "llm_for_zotero_conversation_cleanup_jobs",
    "system = ? AND conversation_key = ?",
    [system, conversationKey],
  );
  const pendingDeletionRows = await countWorkflowRows(
    PENDING_DELETIONS_TABLE,
    "kind = 'conversation' AND conversation_key = ?",
    [conversationKey],
  );
  return {
    system,
    conversationKey,
    catalogRows,
    messageRows,
    searchIndexRows,
    registryRows,
    forkSourceRows,
    forkTargetRows,
    cleanupJobRows,
    pendingDeletionRows,
  };
}

async function waitForLastSend(): Promise<SendQuestionOptions> {
  const startedAt = Date.now();
  while (!lastSend) {
    if (Date.now() - startedAt > 5000) {
      throw new Error("Timed out waiting for workflow send capture");
    }
    await Zotero.Promise.delay(25);
  }
  return lastSend;
}

function getPanel(panelId: string): PanelRecord {
  const panel = panels.get(panelId);
  if (!panel) throw new Error(`Unknown workflow test panel: ${panelId}`);
  return panel;
}

async function createPaperWithPdfFixture(input: {
  title: string;
  pdfTitle: string;
  pages?: string[];
}): Promise<WorkflowTestFixture> {
  assertWorkflowTestEnabled();
  const libraryID = Zotero.Libraries.userLibraryID;
  const parentItem = new Zotero.Item("journalArticle");
  parentItem.libraryID = libraryID;
  parentItem.setField("title", input.title);
  const savedParentItemId = await parentItem.saveTx();
  const parentItemId = Math.floor(Number(savedParentItemId));
  if (!Number.isFinite(parentItemId) || parentItemId <= 0) {
    throw new Error("Failed to save workflow test parent item");
  }
  const tempPdfPath = await writeTempPdf(input.pdfTitle, input.pages);
  const attachment = await Zotero.Attachments.importFromFile({
    file: tempPdfPath,
    parentItemID: parentItemId,
    title: input.pdfTitle,
    contentType: "application/pdf",
  });
  const pdfAttachmentId = Math.floor(Number(attachment.id));
  if (!Number.isFinite(pdfAttachmentId) || pdfAttachmentId <= 0) {
    throw new Error("Failed to import workflow test PDF attachment");
  }
  return {
    parentItemId,
    pdfAttachmentId,
    tempPdfPath,
  };
}

async function createStandaloneAttachmentFixture(input: {
  title: string;
  filename: string;
  contentType: string;
  text?: string;
}): Promise<WorkflowTestAttachmentFixture> {
  assertWorkflowTestEnabled();
  const filename = sanitizeTempFilename(input.filename);
  const lowerFilename = filename.toLowerCase();
  const lowerContentType = input.contentType.toLowerCase();
  const bytes =
    lowerContentType === "application/pdf" || lowerFilename.endsWith(".pdf")
      ? minimalPdfBytes(input.title)
      : new TextEncoder().encode(input.text || input.title || filename);
  const tempPath = await writeTempFile(filename, bytes);
  const attachment = await Zotero.Attachments.importFromFile({
    file: tempPath,
    title: input.title,
    contentType: input.contentType,
  });
  const attachmentItemId = Math.floor(Number(attachment.id));
  if (!Number.isFinite(attachmentItemId) || attachmentItemId <= 0) {
    throw new Error("Failed to import workflow test standalone attachment");
  }
  return {
    attachmentItemId,
    tempPath,
    title: input.title,
    filename,
    contentType: input.contentType,
  };
}

async function createItemNoteFixture(input: {
  title: string;
  pdfTitle: string;
  noteHtml: string;
}): Promise<WorkflowTestNoteFixture> {
  assertWorkflowTestEnabled();
  const fixture = await createPaperWithPdfFixture({
    title: input.title,
    pdfTitle: input.pdfTitle,
  });
  const note = new Zotero.Item("note");
  note.libraryID = Zotero.Libraries.userLibraryID;
  note.parentID = fixture.parentItemId;
  note.setNote(input.noteHtml);
  const savedNoteItemId = await note.saveTx();
  const noteItemId = Math.floor(Number(savedNoteItemId));
  if (!Number.isFinite(noteItemId) || noteItemId <= 0) {
    throw new Error("Failed to save workflow test note");
  }
  return {
    ...fixture,
    noteItemId,
    noteText: input.noteHtml,
  };
}

async function createStandaloneNoteFixture(input: {
  noteHtml: string;
}): Promise<WorkflowTestStandaloneNoteFixture> {
  assertWorkflowTestEnabled();
  const note = new Zotero.Item("note");
  note.libraryID = Zotero.Libraries.userLibraryID;
  note.setNote(input.noteHtml);
  const savedNoteItemId = await note.saveTx();
  const noteItemId = Math.floor(Number(savedNoteItemId));
  if (!Number.isFinite(noteItemId) || noteItemId <= 0) {
    throw new Error("Failed to save workflow test standalone note");
  }
  return {
    noteItemId,
    noteText: input.noteHtml,
  };
}

async function renderPanelForItem(itemId: number): Promise<WorkflowTestPanel> {
  return renderPanelForItemInternal(itemId);
}

async function exerciseBackgroundAgentPublication(input: {
  panelId: string;
  paperBItemId: number;
  invalidateConversation?: boolean;
}) {
  assertWorkflowTestEnabled();
  const panel = getPanel(input.panelId);
  const paperA = activeContextPanels.get(panel.body)?.() || panel.item;
  const conversationKey = getConversationKey(paperA);
  const generation = getConversationWriteGeneration(conversationKey);
  const deps = buildAgentEngineDepsForTests(
    paperA,
    "upstream",
    generation,
    panel.body,
    capturePanelOperationLease(panel.body),
  );
  const timestamp = Date.now();
  await deps.persistConversationMessage(conversationKey, {
    role: "user",
    text: "Publish a background document.",
    timestamp,
  });
  const tool = getAgentRuntime().getToolDefinition("submit_document")!;
  const prepared = (await tool.execute(
    {
      title: "Background publication fixture",
      markdown:
        "# Background publication fixture\n\nThis exact document must survive switching papers.",
      citations: [],
      quotes: [],
      assets: [],
      groundingReviewed: "passed",
      groundingIssues: [],
    },
    {
      request: {
        conversationKey,
        mode: "agent",
        libraryID: paperA.libraryID,
        userText: "Publish a background document.",
        documentOutcomePolicy: {
          required: true,
          documentKind: "custom",
          integrityPolicy: "authored",
          trigger: "document_intent",
        },
      },
      runId: `background-publication-${paperA.key}-${timestamp}`,
      item: paperA,
      modelName: "workflow",
      currentAnswerText: "",
    } as never,
  )) as { documentId: string; visibleMarkdown: string };
  const paperB = Zotero.Items.get(input.paperBItemId);
  disposeSetupHandlers(panel.body);
  bindTestPanelHost(panel.body, paperB);
  buildUI(panel.body, paperB);
  activeContextPanels.set(panel.body, () => paperB);
  activeContextPanelRawItems.set(panel.body, paperB);
  setupHandlers(panel.body, paperB);
  await ensureConversationLoaded(paperB);
  panel.item = paperB;
  refreshChat(panel.body, paperB);
  const paperBKey = getConversationKey(paperB);
  if (input.invalidateConversation)
    bumpConversationWriteGeneration(conversationKey);
  await deps.persistConversationMessage(conversationKey, {
    role: "assistant",
    text: prepared.visibleMarkdown,
    timestamp: timestamp + 1,
    documentId: prepared.documentId,
  });
  const rows = (await Zotero.DB.queryAsync(
    "SELECT conversation_key AS conversationKey, text FROM llm_for_zotero_chat_messages WHERE document_id = ?",
    [prepared.documentId],
  )) as Array<{ conversationKey: number; text: string }>;
  const outbox = await loadPlanDocumentOutbox(prepared.documentId);
  return {
    sourceConversationKey: conversationKey,
    otherConversationKey: paperBKey,
    persistedConversationKeys: rows.map((row) => Number(row.conversationKey)),
    exactMarkdown: rows.every((row) => row.text === prepared.visibleMarkdown),
    outboxStatus: outbox?.status,
    otherPanelContainsDocument: Boolean(
      panel.body
        .querySelector("#llm-chat-box")
        ?.textContent?.includes("This exact document must survive"),
    ),
  };
}

async function renderStartupPanelForItem(
  itemId: number,
): Promise<WorkflowTestPanel> {
  disposeWorkflowPanels();
  clearWorkflowConversationRuntimeState();
  return renderPanelForItemInternal(itemId, { resolveRememberedState: true });
}

function clearWorkflowConversationRuntimeState(): void {
  chatHistory.clear();
  selectedRuntimeModeCache.clear();
  loadedConversationKeys.clear();
  activeConversationModeByLibrary.clear();
  activeGlobalConversationByLibrary.clear();
  activePaperConversationByPaper.clear();
  activeClaudeConversationModeByLibrary.clear();
  activeClaudeGlobalConversationByLibrary.clear();
  activeClaudePaperConversationByPaper.clear();
  activeCodexConversationModeByLibrary.clear();
  activeCodexGlobalConversationByLibrary.clear();
  activeCodexPaperConversationByPaper.clear();
  selectedPaperContextCache.clear();
  selectedCollectionContextCache.clear();
  selectedTagContextCache.clear();
  initializedConversationComposeContextKeys.clear();
  paperContextModeOverrides.clear();
  paperContentSourceOverrides.clear();
}

async function renderPanelForItemInternal(
  itemId: number,
  options?: { resolveRememberedState?: boolean },
): Promise<WorkflowTestPanel> {
  assertWorkflowTestEnabled();
  const item = Zotero.Items.get(itemId);
  if (!item) throw new Error(`Unable to find Zotero item ${itemId}`);
  const doc = getWorkflowDocument();
  const body = appendHost(doc);
  const panelId = `workflow-panel-${++panelCounter}`;
  body.dataset.workflowPanelId = panelId;
  const initialPanelItem = options?.resolveRememberedState
    ? resolveInitialPanelItemState(item).item
    : item;
  buildUI(body, initialPanelItem);
  activeContextPanels.set(body, () => initialPanelItem);
  activeContextPanelRawItems.set(body, item);
  setupHandlers(body, item);
  const mountedItem = activeContextPanels.get(body)?.() || item;
  await ensureConversationLoaded(mountedItem).catch(() => undefined);
  refreshChat(body, mountedItem);
  await Zotero.Promise.delay(50);
  const contextSnapshot = await resolveContextSourceItemAsync(mountedItem);
  activeContextPanelStateSync.get(body)?.();
  const panel = { id: panelId, body, item: mountedItem, contextSnapshot };
  panels.set(panelId, panel);
  return { panelId, itemId, contextSnapshot };
}

async function exerciseStaleAgentTracePanelIsolation(input: {
  panelId: string;
  paperBItemId: number;
  paperAMarker: string;
  paperBMarker: string;
  paperBAppendMarker: string;
  runId: string;
}): Promise<WorkflowTestStaleAgentTraceIsolationResult> {
  assertWorkflowTestEnabled();
  const panel = getPanel(input.panelId);
  const body = panel.body;
  const paperAItem = activeContextPanels.get(body)?.() || panel.item;
  const paperAConversationKey = getConversationKey(paperAItem);
  const paperBItem = Zotero.Items.get(input.paperBItemId);
  if (!paperAConversationKey || !paperBItem) {
    throw new Error("Workflow trace isolation requires two mounted papers");
  }

  const runId = input.runId.trim();
  if (!runId) throw new Error("Workflow trace isolation requires a run ID");
  let traceLoadStarted = false;
  let traceResolved = false;
  let resolveTrace: (value: { run: null; events: [] }) => void = () => {};
  const traceResult = new Promise<{ run: null; events: [] }>((resolve) => {
    resolveTrace = resolve;
  });
  setAgentRunTraceLoaderForTests(async (requestedRunId) => {
    if (requestedRunId !== runId) {
      throw new Error(`Unexpected workflow trace request: ${requestedRunId}`);
    }
    traceLoadStarted = true;
    return traceResult;
  });

  try {
    const paperATimestamp = Date.now() - 10;
    const paperAUserMessage: Message = {
      role: "user",
      text: `${input.paperAMarker} request`,
      timestamp: paperATimestamp,
    };
    const paperAAssistantMessage: Message = {
      role: "assistant",
      text: input.paperAMarker,
      timestamp: paperATimestamp + 1,
      runMode: "agent",
      agentRunId: runId,
    };
    await appendWorkflowStoredMessage(
      "upstream",
      paperAConversationKey,
      paperAUserMessage,
    );
    await appendWorkflowStoredMessage(
      "upstream",
      paperAConversationKey,
      paperAAssistantMessage,
    );
    chatHistory.set(paperAConversationKey, [
      ...(chatHistory.get(paperAConversationKey) || []),
      paperAUserMessage,
      paperAAssistantMessage,
    ]);
    loadedConversationKeys.add(paperAConversationKey);
    refreshChat(body, paperAItem);

    const traceStartDeadline = Date.now() + 5000;
    while (!traceLoadStarted && Date.now() < traceStartDeadline) {
      await Zotero.Promise.delay(25);
    }
    if (!traceLoadStarted) {
      throw new Error("Timed out waiting for the paper A trace request");
    }

    disposeSetupHandlers(body);
    bindTestPanelHost(body, paperBItem);
    buildUI(body, paperBItem);
    activeContextPanels.set(body, () => paperBItem);
    activeContextPanelRawItems.set(body, paperBItem);
    setupHandlers(body, paperBItem);
    await ensureConversationLoaded(paperBItem);
    const paperBConversationKey = getConversationKey(paperBItem);
    if (!paperBConversationKey) {
      throw new Error("Workflow paper B has no conversation key");
    }
    const paperBMessage: Message = {
      role: "user",
      text: input.paperBMarker,
      timestamp: Date.now(),
    };
    await appendWorkflowStoredMessage(
      "upstream",
      paperBConversationKey,
      paperBMessage,
    );
    chatHistory.set(paperBConversationKey, [
      ...(chatHistory.get(paperBConversationKey) || []),
      paperBMessage,
    ]);
    loadedConversationKeys.add(paperBConversationKey);
    panel.item = paperBItem;
    panel.contextSnapshot = await resolveContextSourceItemAsync(paperBItem);
    refreshChat(body, paperBItem);
    activeContextPanelStateSync.get(body)?.();
    await Zotero.Promise.delay(100);
    const beforeTraceResolution = await getDiagnostics(input.panelId);

    resolveTrace({ run: null, events: [] });
    traceResolved = true;
    const traceCacheDeadline = Date.now() + 5000;
    while (
      !hasAgentRunTraceForTests(runId) &&
      Date.now() < traceCacheDeadline
    ) {
      await Zotero.Promise.delay(25);
    }
    const traceCached = hasAgentRunTraceForTests(runId);
    if (!traceCached) {
      throw new Error("Timed out waiting for the paper A trace cache");
    }
    await Zotero.Promise.delay(100);
    const afterTraceResolution = await getDiagnostics(input.panelId);

    const paperABefore = await getWorkflowConversationPersistenceSnapshot(
      "upstream",
      paperAConversationKey,
    );
    const paperBBefore = await getWorkflowConversationPersistenceSnapshot(
      "upstream",
      paperBConversationKey,
    );
    const afterPaperBAppend = await seedPanelStoredUserMessage(
      input.panelId,
      input.paperBAppendMarker,
    );
    const paperAAfter = await getWorkflowConversationPersistenceSnapshot(
      "upstream",
      paperAConversationKey,
    );
    const paperBAfter = await getWorkflowConversationPersistenceSnapshot(
      "upstream",
      paperBConversationKey,
    );

    return {
      paperAConversationKey,
      paperBConversationKey,
      beforeTraceResolution,
      afterTraceResolution,
      afterPaperBAppend,
      traceCached,
      paperAMessageRowsBeforePaperBAppend: paperABefore.messageRows,
      paperAMessageRowsAfterPaperBAppend: paperAAfter.messageRows,
      paperBMessageRowsBeforePaperBAppend: paperBBefore.messageRows,
      paperBMessageRowsAfterPaperBAppend: paperBAfter.messageRows,
    };
  } finally {
    if (!traceResolved) {
      resolveTrace({ run: null, events: [] });
      await Zotero.Promise.delay(0);
    }
    setAgentRunTraceLoaderForTests();
  }
}

async function exerciseCrossPaperHistoryReturnIsolation(input: {
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
}): Promise<WorkflowTestCrossPaperHistoryIsolationResult> {
  assertWorkflowTestEnabled();
  const panelA = getPanel(input.panelAId);
  const panelB = getPanel(input.panelBId);
  await seedPanelStoredUserMessage(input.panelAId, input.paperAMarker);
  await seedPanelStoredUserMessage(input.panelBId, input.paperBMarker);

  const paperAItem = activeContextPanels.get(panelA.body)?.() || panelA.item;
  const paperBItem = activeContextPanels.get(panelB.body)?.() || panelB.item;
  const paperAConversationKey = getConversationKey(paperAItem);
  const paperBConversationKey = getConversationKey(paperBItem);
  const paperBRowsBefore = await getWorkflowConversationPersistenceSnapshot(
    "upstream",
    paperBConversationKey,
  );

  const reader = await openWorkflowPdfReader(input.paperAAttachmentItemId, 0);
  let popupHost: HTMLElement | null = null;
  let selectionDoc: Document | null = null;
  let restoreSelectItems: (() => void) | null = null;
  let foreignContentObserver: MutationObserver | null = null;
  try {
    const mainDocument = Zotero.getMainWindow?.()?.document || null;
    const readerPanel = mainDocument
      ? getReaderContextPanelForTab(mainDocument, reader.tabID)
      : null;
    const rawReaderItem = Zotero.Items.get(input.paperAAttachmentItemId);
    if (!readerPanel || !rawReaderItem) {
      throw new Error("Workflow paper A reader context is unavailable");
    }
    readerPanel.appendChild(panelA.body);
    bindEmbeddedPanelHost(panelA.body, rawReaderItem, "reader");

    const chatBox = panelA.body.querySelector(
      "#llm-chat-box",
    ) as HTMLElement | null;
    if (!chatBox) throw new Error("Workflow paper A chat surface is missing");
    let foreignMutationObserved = false;
    const MutationObserverCtor =
      panelA.body.ownerDocument.defaultView?.MutationObserver;
    foreignContentObserver = MutationObserverCtor
      ? new MutationObserverCtor((records) => {
          for (const record of records) {
            for (const node of Array.from(record.addedNodes)) {
              if ((node?.textContent || "").includes(input.paperBMarker)) {
                foreignMutationObserved = true;
              }
            }
          }
          if ((chatBox.textContent || "").includes(input.paperBMarker)) {
            foreignMutationObserved = true;
          }
        })
      : null;
    foreignContentObserver?.observe(chatBox, {
      childList: true,
      subtree: true,
    });

    const pane = Zotero.getActiveZoteroPane?.() as
      | {
          getSelectedItems?: () => Zotero.Item[];
          selectItems?: (
            ids: number[],
            options?: { selectInLibrary?: boolean },
          ) => Promise<unknown> | unknown;
        }
      | undefined;
    let releaseDelayedSelection: (() => void) | null = null;
    let delayedSelectionStarted = false;
    if (input.delaySelection && typeof pane?.selectItems === "function") {
      const originalSelectItems = pane.selectItems;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      releaseDelayedSelection = release;
      pane.selectItems = async (ids, options) => {
        delayedSelectionStarted = true;
        await gate;
        return await originalSelectItems.call(pane, ids, options);
      };
      restoreSelectItems = () => {
        pane.selectItems = originalSelectItems;
      };
    }

    await openPanelHistoryMenu(input.panelAId);
    const targetConversationKey =
      input.activation === "history-row"
        ? paperAConversationKey
        : paperBConversationKey;
    const resultSelector =
      input.activation === "history-row"
        ? `.llm-history-item[data-conversation-key="${targetConversationKey}"]`
        : `.llm-standalone-search-item[data-conversation-key="${targetConversationKey}"]`;
    if (input.activation !== "history-row") {
      dispatchWorkflowClick(
        panelA.body,
        ".llm-history-menu-search-trigger",
        "History search trigger",
      );
      const searchInput = panelA.body.querySelector(
        ".llm-standalone-search-input",
      ) as HTMLInputElement | null;
      if (!searchInput) {
        throw new Error("History search input was not rendered");
      }
      searchInput.value = input.paperBMarker;
      const InputEventCtor =
        panelA.body.ownerDocument.defaultView?.Event || Event;
      searchInput.dispatchEvent(new InputEventCtor("input", { bubbles: true }));
    }

    const searchDeadline = Date.now() + 8000;
    let resultRow = panelA.body.querySelector(
      resultSelector,
    ) as HTMLElement | null;
    while (!resultRow && Date.now() < searchDeadline) {
      await Zotero.Promise.delay(50);
      resultRow = panelA.body.querySelector(
        resultSelector,
      ) as HTMLElement | null;
    }
    if (!resultRow) {
      throw new Error("Paper B was not rendered in conversation history");
    }
    if (input.activation === "keyboard") {
      const KeyboardEventCtor =
        panelA.body.ownerDocument.defaultView?.KeyboardEvent || KeyboardEvent;
      resultRow.dispatchEvent(
        new KeyboardEventCtor("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        }),
      );
    } else {
      resultRow.click();
    }

    if (input.delaySelection) {
      const delayedDeadline = Date.now() + 3000;
      while (!delayedSelectionStarted && Date.now() < delayedDeadline) {
        await Zotero.Promise.delay(20);
      }
      const tabs = (
        Zotero as unknown as {
          Tabs?: { select?: (tabID: string) => Promise<unknown> | unknown };
        }
      ).Tabs;
      if (reader.tabID && typeof tabs?.select === "function") {
        await tabs.select(reader.tabID);
      }
      releaseDelayedSelection?.();
    }

    const shouldNavigateToPaperB = input.activation !== "history-row";
    const selectedDeadline = Date.now() + 8000;
    let selectedLibraryItemID = Number(pane?.getSelectedItems?.()[0]?.id || 0);
    while (
      shouldNavigateToPaperB &&
      selectedLibraryItemID !== input.paperBItemId &&
      Date.now() < selectedDeadline
    ) {
      await Zotero.Promise.delay(50);
      selectedLibraryItemID = Number(pane?.getSelectedItems?.()[0]?.id || 0);
    }
    if (
      shouldNavigateToPaperB &&
      selectedLibraryItemID !== input.paperBItemId
    ) {
      throw new Error("History navigation did not select paper B in Zotero");
    }

    const tabs = (
      Zotero as unknown as {
        Tabs?: { select?: (tabID: string) => Promise<unknown> | unknown };
      }
    ).Tabs;
    if (reader.tabID && typeof tabs?.select === "function") {
      await tabs.select(reader.tabID);
    }
    await Zotero.Promise.delay(150);
    foreignContentObserver?.disconnect();

    const diagnostics = await getDiagnostics(input.panelAId);
    const request = await ask(input.panelAId, input.promptMarker);
    const popupAction = await dispatchWorkflowReaderAddTextPopup({
      reader,
      pageIndex: 0,
      selectedText: input.selectedText,
    });
    popupHost = popupAction.popupHost;
    selectionDoc = popupAction.selectionDoc;
    await waitForSelectedContext({
      conversationKey: paperAConversationKey,
      selectedText: input.selectedText,
      pageIndex: 0,
    });

    const paperBRowsAfter = await getWorkflowConversationPersistenceSnapshot(
      "upstream",
      paperBConversationKey,
    );
    return {
      paperAConversationKey,
      paperBConversationKey,
      selectedLibraryItemID,
      foreignMutationObserved,
      panelAConversationKey: Number(diagnostics.panelConversationKey || 0),
      panelABasePaperItemID: Number(
        (panelA.body.querySelector("#llm-main") as HTMLElement | null)?.dataset
          .basePaperItemId || 0,
      ),
      panelARawContextItemID: Number(
        (panelA.body.querySelector("#llm-main") as HTMLElement | null)?.dataset
          .rawContextItemId || 0,
      ),
      panelAMessageText: diagnostics.messageText || "",
      requestConversationKey: getConversationKey(request.item),
      requestItemID: Number(request.item.id || 0),
      addTextStoredForA: getSelectedTextContextEntries(
        paperAConversationKey,
      ).some((context) => context.text === input.selectedText),
      addTextStoredForB: getSelectedTextContextEntries(
        paperBConversationKey,
      ).some((context) => context.text === input.selectedText),
      paperBMessageRowsBefore: paperBRowsBefore.messageRows,
      paperBMessageRowsAfter: paperBRowsAfter.messageRows,
    };
  } finally {
    foreignContentObserver?.disconnect();
    restoreSelectItems?.();
    selectionDoc?.defaultView?.getSelection?.()?.removeAllRanges();
    popupHost?.remove();
    await closeWorkflowReader(reader);
  }
}

function dispatchWorkflowClick(
  body: HTMLElement,
  selector: string,
  label: string,
): void {
  const button = body.querySelector(selector) as HTMLButtonElement | null;
  if (!button) throw new Error(`${label} was not rendered`);
  const eventCtor = body.ownerDocument.defaultView?.MouseEvent;
  if (eventCtor) {
    button.dispatchEvent(
      new eventCtor("click", { bubbles: true, cancelable: true }),
    );
    return;
  }
  button.click();
}

async function waitForPanelConversationChange(params: {
  panelId: string;
  previousConversationKey?: number;
  previousConversationKind?: string;
  allowReusedDraft?: boolean;
  previousStatusText?: string;
  completed?: () => boolean;
}): Promise<WorkflowTestDiagnostics> {
  const startedAt = Date.now();
  // Generous deadline: the switch path does several DB round-trips, and a
  // loaded machine has pushed the old 5s budget over the edge (observed as a
  // flaky deletion-lifecycle failure). Polling exits the moment the key
  // changes, so a large ceiling costs nothing on the happy path.
  while (Date.now() - startedAt < 15000) {
    const diagnostics = await getDiagnostics(params.panelId);
    const keyChanged =
      params.previousConversationKey === undefined ||
      diagnostics.conversationKey !== params.previousConversationKey;
    const kindChanged =
      params.previousConversationKind === undefined ||
      diagnostics.conversationKind !== params.previousConversationKind;
    if (keyChanged && kindChanged && (!params.completed || params.completed()))
      return diagnostics;
    if (
      params.allowReusedDraft &&
      (!params.completed || params.completed()) &&
      (params.completed ||
        diagnostics.statusText !== params.previousStatusText) &&
      /^(Reused existing new|Started new)/.test(diagnostics.statusText || "")
    ) {
      return diagnostics;
    }
    await Zotero.Promise.delay(25);
  }
  throw new Error(`Timed out waiting for panel ${params.panelId} to switch`);
}

async function startNewPanelConversation(
  panelId: string,
  options?: { allowReusedDraft?: boolean },
): Promise<WorkflowTestDiagnostics> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const before = await getDiagnostics(panelId);
  // Identity changes before asynchronous hydration clears the old composer.
  // Observe a fresh completion announcement, including repeated "Started new"
  // labels, rather than treating the new key as a completed UI transition.
  const status = panel.body.querySelector("#llm-status");
  const Observer = panel.body.ownerDocument.defaultView?.MutationObserver;
  if (!status || !Observer)
    throw new Error("New-chat completion observer is unavailable");
  let completed = false;
  const observer = new Observer(() => {
    if (/^(Reused existing new|Started new)/.test(status.textContent || ""))
      completed = true;
  });
  observer.observe(status, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  try {
    dispatchWorkflowClick(panel.body, "#llm-history-new", "New chat button");
    return await waitForPanelConversationChange({
      panelId,
      previousConversationKey: before.conversationKey,
      allowReusedDraft: options?.allowReusedDraft,
      previousStatusText: before.statusText,
      completed: () => completed,
    });
  } finally {
    observer.disconnect();
  }
}

async function togglePanelConversationMode(
  panelId: string,
): Promise<WorkflowTestDiagnostics> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const before = await getDiagnostics(panelId);
  dispatchWorkflowClick(panel.body, "#llm-mode-chip", "Chat mode button");
  return waitForPanelConversationChange({
    panelId,
    previousConversationKind: before.conversationKind,
  });
}

async function exerciseDuplicatePanelSetup(
  panelId: string,
): Promise<WorkflowTestDuplicatePanelSetupDiagnostics> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const panelRootBefore = panel.body.querySelector(
    "#llm-main",
  ) as HTMLElement | null;
  if (!panelRootBefore) {
    throw new Error(`Panel ${panelId} has no mounted root`);
  }
  const mountedItem = activeContextPanels.get(panel.body)?.() || panel.item;
  const initializationGenerationBefore =
    panelRootBefore.dataset.handlersInitialized || "";
  const panelStateSyncBefore = activeContextPanelStateSync.has(panel.body);
  const turnNavigatorCountBefore = panel.body.querySelectorAll(
    ".llm-turn-navigator",
  ).length;

  setupHandlers(panel.body, mountedItem);

  const panelRootAfter = panel.body.querySelector(
    "#llm-main",
  ) as HTMLElement | null;
  return {
    samePanelRoot: panelRootAfter === panelRootBefore,
    initializationGenerationBefore,
    initializationGenerationAfter:
      panelRootAfter?.dataset.handlersInitialized || "",
    panelStateSyncBefore,
    panelStateSyncAfter: activeContextPanelStateSync.has(panel.body),
    turnNavigatorCountBefore,
    turnNavigatorCountAfter: panel.body.querySelectorAll(".llm-turn-navigator")
      .length,
  };
}

async function approvePlanForExecution(input: {
  planId: string;
  revision: number;
  expectedDigest?: string;
}) {
  assertWorkflowTestEnabled();
  const artifact = await loadPlanArtifact(input.planId, input.revision);
  if (!artifact) throw new Error("Plan revision not found");
  const ledger = await planExecutionCoordinator.approve({
    planId: input.planId,
    revision: input.revision,
    expectedDigest: input.expectedDigest || artifact.digest,
    conversationGeneration: getConversationWriteGeneration(
      artifact.conversationKey,
    ),
    actionContract: artifact.actionContract,
  });
  return {
    executionId: ledger.executionId,
    planDigest: ledger.planDigest,
    activeTaskId: ledger.activeTaskId,
    provider: ledger.provider,
  };
}

async function researchFlightReport(input: { executionId: string }) {
  assertWorkflowTestEnabled();
  const job = await loadResearchJobForExecution(input.executionId);
  if (!job) throw new Error("No research job for this execution");
  const ledger = await loadPlanExecutionLedger(input.executionId);
  const artifact = ledger
    ? await loadPlanArtifact(ledger.planId, ledger.revision)
    : null;
  const [corpus, findings, edges, questions, themes, document] =
    await Promise.all([
      listResearchCorpusItems({ researchJobId: job.researchJobId }),
      listPaperFindings(job.researchJobId),
      listResearchEdges(job.researchJobId),
      listResearchOpenQuestions(job.researchJobId),
      listThemeFindings(job.researchJobId, job.scopeLineageDigest),
      loadLatestPlanDocumentForExecution(input.executionId),
    ]);
  const runs: FlightRun[] = [];
  if (ledger) {
    for (const run of await listAgentRunsForConversation(
      ledger.conversationKey,
    )) {
      if (run.createdAt < job.createdAt - 5 * 60_000) continue;
      const trace = await getAgentRunTrace(run.runId);
      const events = trace.events.map((event) => ({
        type: event.eventType,
        createdAt: event.createdAt,
        payload: event.payload as unknown as Record<string, unknown>,
      }));
      if (
        !events.some(
          (event) =>
            event.type === "tool_call" &&
            String(event.payload.executionId || "") === input.executionId,
        )
      )
        continue;
      runs.push({
        runId: run.runId,
        status: run.status,
        createdAt: run.createdAt,
        completedAt: run.completedAt ?? undefined,
        events,
      });
    }
  }
  const report = buildResearchFlightReport({
    job,
    corpus,
    findings,
    edges,
    questions,
    themes,
    subquestions: artifact?.contract?.investigation?.subquestions || [],
    ...(document
      ? {
          document: {
            visibleMarkdown: document.visibleMarkdown,
            clusters: document.citationBundle.clusters.map((cluster) => ({
              citationId: cluster.citationId,
              sources: cluster.sources,
            })),
          },
        }
      : {}),
    ...(runs.length ? { runs } : {}),
  });
  return { report, rendered: renderResearchFlightReport(report) };
}

async function exerciseRebuiltPanelPlanApproval(panelId: string) {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const item = activeContextPanels.get(panel.body)?.() || panel.item;
  const conversationKey = getConversationKey(item);
  const threadKey = buildQueuedFollowUpThreadKey({
    conversationKey,
    conversationSystem: "upstream",
  });
  for (let index = 0; index < 2; index++) {
    disposeSetupHandlers(panel.body);
    buildUI(panel.body, item);
    setupHandlers(panel.body, item);
  }
  let sends = 0;
  let release!: () => void;
  const heldSend = new Promise<void>((resolve) => {
    release = resolve;
  });
  const settledBefore = getWorkflowTestSendSettledSequence();
  setWorkflowTestSendInterceptor(async (opts) => {
    lastSend = opts;
    sends++;
    await heldSend;
    return false;
  });
  const dispatch = () => {
    const EventCtor = panel.body.ownerDocument.defaultView!.CustomEvent;
    panel.body.querySelector("#llm-main")!.dispatchEvent(
      new EventCtor(PLAN_APPROVED_EVENT, {
        bubbles: true,
        detail: { planId: "workflow-single-approval" },
      }),
    );
  };
  try {
    dispatch();
    const deadline = Date.now() + 10000;
    while (!sends && Date.now() < deadline) await Zotero.Promise.delay(25);
    if (!sends)
      throw new Error("Plan approval never reached the send boundary");
    const queuedAfterApproval = getQueuedFollowUps(threadKey).length;
    const sendsAfterApproval = sends;
    setQueuedFollowUps(threadKey, []);
    release();
    while (
      getWorkflowTestSendSettledSequence() <= settledBefore &&
      Date.now() < deadline
    )
      await Zotero.Promise.delay(25);
    if (getWorkflowTestSendSettledSequence() <= settledBefore)
      throw new Error("The intercepted approval send did not settle");
    disposeSetupHandlers(panel.body);
    dispatch();
    await Zotero.Promise.delay(100);
    return {
      sendsAfterApproval,
      queuedAfterApproval,
      sendsAfterDispose: sends,
    };
  } finally {
    setQueuedFollowUps(threadKey, []);
    release();
    setWorkflowTestSendInterceptor((opts) => {
      lastSend = opts;
    });
  }
}

async function exercisePanelDraftStateRefresh(
  panelId: string,
  text: string,
): Promise<WorkflowTestDraftRefreshDiagnostics> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const panelRoot = panel.body.querySelector("#llm-main") as HTMLElement | null;
  const input = panel.body.querySelector(
    "#llm-input",
  ) as HTMLTextAreaElement | null;
  if (!panelRoot || !input) {
    throw new Error(`Panel ${panelId} has no mounted composer`);
  }
  const syncPanelState = activeContextPanelStateSync.get(panel.body);
  if (!syncPanelState) {
    throw new Error(`Panel ${panelId} has no state-sync callback`);
  }

  input.value = text;
  const eventCtor = panel.body.ownerDocument.defaultView?.Event ?? Event;
  input.dispatchEvent(new eventCtor("input", { bubbles: true }));
  const inputBeforeRefresh = input.value;
  syncPanelState();

  return {
    webChatMode: panelRoot.dataset.webchatMode === "true",
    inputBeforeRefresh,
    inputAfterRefresh: input.value,
  };
}

/**
 * Pick a model entry from the panel's model menu the way a user does: open
 * the menu, click the entry's option, then wait until the panel has finished
 * entering or leaving WebChat for that entry (the WebChat session anchoring
 * and the return to the remembered paper conversation are both async).
 */
async function selectPanelModelEntry(
  panelId: string,
  entryId: string,
): Promise<WorkflowTestDiagnostics> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const toggle = panel.body.querySelector(
    "#llm-model-toggle",
  ) as HTMLButtonElement | null;
  if (!toggle) throw new Error(`Panel ${panelId} has no model toggle`);
  if (toggle.disabled) {
    throw new Error(`Panel ${panelId} model toggle is disabled`);
  }
  toggle.click();
  const option = panel.body.querySelector(
    `#llm-model-menu .llm-model-option[data-entry-id="${entryId}"]`,
  ) as HTMLButtonElement | null;
  if (!option) {
    throw new Error(`Panel ${panelId} model menu has no entry ${entryId}`);
  }
  const expectWebChat = getModelEntryById(entryId)?.authMode === "webchat";
  option.click();
  const deadline = Date.now() + 15000;
  let diagnostics = await getDiagnostics(panelId);
  while (Date.now() < deadline) {
    const key = diagnostics.conversationKey || 0;
    const settled = expectWebChat
      ? diagnostics.webChatMode === true &&
        webChatIsolatedConversationKeys.has(key)
      : diagnostics.webChatMode === false &&
        !webChatIsolatedConversationKeys.has(key) &&
        loadedConversationKeys.has(key);
    if (settled) return diagnostics;
    await Zotero.Promise.delay(25);
    diagnostics = await getDiagnostics(panelId);
  }
  throw new Error(
    `Timed out waiting for panel model entry ${entryId} to settle: ${JSON.stringify(
      {
        webChatMode: diagnostics.webChatMode,
        conversationKey: diagnostics.conversationKey,
      },
    )}`,
  );
}

async function seedPanelStoredUserMessage(
  panelId: string,
  text: string,
  contexts: Pick<
    Message,
    | "paperContexts"
    | "pdfPaperContexts"
    | "fullTextPaperContexts"
    | "selectedCollectionContexts"
    | "selectedTagContexts"
  > = {},
): Promise<WorkflowTestDiagnostics> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  let item = activeContextPanels.get(panel.body)?.() || panel.item;
  // The visible history switch is asynchronous.  Re-run the same provisioning
  // gate that a real send uses before seeding so a panel that just moved away
  // from a retired historical key cannot append through its stale WeakMap
  // binding.  Re-read the active item afterward because provisioning may have
  // allocated a fresh permanent key for the scope.
  await ensureConversationLoaded(item);
  item = activeContextPanels.get(panel.body)?.() || item;
  const conversationKey = getConversationKey(item);
  if (!conversationKey) {
    throw new Error("Workflow panel has no active conversation key");
  }
  const message = {
    ...contexts,
    role: "user" as const,
    text,
    timestamp: Date.now(),
  };
  const conversationSystem =
    (panel.body.querySelector("#llm-main") as HTMLElement | null)?.dataset
      .conversationSystem || "upstream";
  try {
    await appendWorkflowStoredMessage(
      conversationSystem === "codex" || conversationSystem === "claude_code"
        ? conversationSystem
        : "upstream",
      conversationKey,
      message,
    );
  } catch (error) {
    throw new Error(
      `Workflow seed failed (${text}) for key ${conversationKey}: ${String(
        (error as Error)?.message || error,
      )}`,
    );
  }
  const existing = chatHistory.get(conversationKey) || [];
  chatHistory.set(conversationKey, [...existing, message]);
  loadedConversationKeys.add(conversationKey);
  panel.item = item;
  refreshChat(panel.body, item);
  await Zotero.Promise.delay(100);
  return getDiagnostics(panelId);
}

async function selectNoteEditorText(
  panelId: string,
  text: string,
): Promise<void> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const synced = syncNoteEditingSelectedText({
    noteItem: activeContextPanels.get(panel.body)?.() || panel.item,
    text,
  });
  if (!synced) throw new Error("Workflow panel item is not a note");
  applySelectedTextPreview(panel.body, synced.conversationKey);
}

async function clickPanelSystemToggle(
  panelId: string,
  system: RuntimeConversationSystem,
): Promise<WorkflowTestDiagnostics> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const button = panel.body.querySelector(
    `.llm-panel-runtime-system-toggle[data-conversation-system='${system}']`,
  ) as HTMLButtonElement | null;
  if (!button) {
    throw new Error(`Panel ${system} system toggle was not rendered`);
  }
  const before = await getDiagnostics(panelId);
  const expectedSystem =
    before.conversationSystem === system ? "upstream" : system;
  button.click();
  const deadline = Date.now() + 15000;
  let diagnostics = await getDiagnostics(panelId);
  while (Date.now() < deadline) {
    if (
      diagnostics.conversationSystem === expectedSystem &&
      diagnostics.runtimeSystemToggles
        .filter((toggle) => toggle.visible)
        .every((toggle) => !toggle.disabled)
    )
      return diagnostics;
    await Zotero.Promise.delay(25);
    diagnostics = await getDiagnostics(panelId);
  }
  throw new Error(
    `Timed out waiting for panel runtime ${expectedSystem} to finish switching: ${JSON.stringify(diagnostics)}`,
  );
}

async function clickPanelSystemTogglesRapidly(
  panelId: string,
  systems: RuntimeConversationSystem[],
): Promise<WorkflowTestDiagnostics> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const eventCtor = panel.body.ownerDocument.defaultView?.MouseEvent;
  for (const system of systems) {
    const button = panel.body.querySelector(
      `.llm-panel-runtime-system-toggle[data-conversation-system='${system}']`,
    ) as HTMLButtonElement | null;
    if (!button) {
      throw new Error(`Panel ${system} system toggle was not rendered`);
    }
    if (eventCtor) {
      button.dispatchEvent(
        new eventCtor("click", { bubbles: true, cancelable: true }),
      );
    } else {
      button.click();
    }
  }
  await Zotero.Promise.delay(500);
  return getDiagnostics(panelId);
}

async function clickPanelRuntimeModeToggle(
  panelId: string,
): Promise<WorkflowTestDiagnostics> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const button = panel.body.querySelector(
    "#llm-runtime-mode-toggle",
  ) as HTMLButtonElement | null;
  if (!button) {
    throw new Error("Panel runtime mode toggle was not rendered");
  }
  if (button.style.display === "none") {
    throw new Error("Panel runtime mode toggle is hidden");
  }
  const eventCtor = panel.body.ownerDocument.defaultView?.MouseEvent;
  if (eventCtor) {
    button.dispatchEvent(
      new eventCtor("click", { bubbles: true, cancelable: true }),
    );
  } else {
    button.click();
  }
  await Zotero.Promise.delay(150);
  return getDiagnostics(panelId);
}

async function measurePanelRuntimeGeometry(
  panelId: string,
  input: { width: number; fontScale: number },
): Promise<WorkflowTestRuntimeGeometry> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const panelRoot = panel.body.querySelector("#llm-main") as HTMLElement | null;
  const header = panel.body.querySelector(
    ".llm-header-top",
  ) as HTMLElement | null;
  const runtimeControls = panel.body.querySelector(
    ".llm-panel-runtime-system-controls",
  ) as HTMLElement | null;
  const modeChip = panel.body.querySelector(
    ".llm-mode-chip",
  ) as HTMLElement | null;
  const headerActions = panel.body.querySelector(
    ".llm-header-actions",
  ) as HTMLElement | null;
  const clearButton = panel.body.querySelector(
    ".llm-clear-btn",
  ) as HTMLButtonElement | null;
  if (
    !panelRoot ||
    !header ||
    !runtimeControls ||
    !modeChip ||
    !headerActions ||
    !clearButton
  ) {
    throw new Error("Panel runtime geometry targets were not rendered");
  }

  const previousWidth = panel.body.style.width;
  const previousScale = panelRoot.style.getPropertyValue("--llm-font-scale");
  panel.body.style.width = `${input.width}px`;
  panelRoot.style.setProperty("--llm-font-scale", String(input.fontScale));
  await Zotero.Promise.delay(50);
  try {
    const containerRect = header.getBoundingClientRect();
    const runtimeRect = getVisibleRuntimeControlsRect(runtimeControls);
    const runtimeButtonWidths = getVisibleRuntimeButtonRects(
      runtimeControls,
    ).map((rect) => rect.width);
    const modeChipRect = modeChip.getBoundingClientRect();
    const actionsRect = headerActions.getBoundingClientRect();
    const clearButtonRect = clearButton.getBoundingClientRect();
    const clearButtonStyle =
      clearButton.ownerDocument.defaultView?.getComputedStyle(clearButton);
    return {
      containerWidth: containerRect.width,
      fontScale: input.fontScale,
      runtimeWidth: runtimeRect.width,
      runtimeButtonWidths,
      runtimeIntersectsLeadingContent: rectsIntersect(
        runtimeRect,
        modeChipRect,
      ),
      runtimeIntersectsTrailingContent: rectsIntersect(
        runtimeRect,
        actionsRect,
      ),
      runtimeTrailingOverlapPx: Math.max(
        0,
        runtimeRect.right - actionsRect.left,
      ),
      runtimeWithinContainer: rectWithinContainer(runtimeRect, containerRect),
      trailingContentWithinContainer: rectWithinContainer(
        actionsRect,
        containerRect,
      ),
      deleteButtonIconOnly:
        clearButtonRect.width <= 28.5 &&
        Number.parseFloat(clearButtonStyle?.fontSize || "") === 0,
      centeredContentOffset: 0,
    };
  } finally {
    panel.body.style.width = previousWidth;
    if (previousScale) {
      panelRoot.style.setProperty("--llm-font-scale", previousScale);
    } else {
      panelRoot.style.removeProperty("--llm-font-scale");
    }
  }
}

async function measurePanelFooterLayout(
  panelId: string,
  input: { width: number; statusText: string },
): Promise<WorkflowTestFooterLayout> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const status = panel.body.querySelector("#llm-status") as HTMLElement | null;
  const controls = panel.body.querySelector(
    ".llm-footer-controls",
  ) as HTMLElement | null;
  const permissionButton = panel.body.querySelector(
    "#llm-permission-toggle",
  ) as HTMLElement | null;
  if (!status || !controls || !permissionButton) {
    throw new Error("Panel footer layout targets were not rendered");
  }

  const getFirstTextRect = (element: HTMLElement): DOMRect => {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const rects = range.getClientRects();
    const rect = rects
      ? Array.from(rects).find(
          (candidate) => candidate.width > 0 && candidate.height > 0,
        )
      : undefined;
    range.detach();
    if (!rect) {
      throw new Error("Panel footer text did not produce a rendered rectangle");
    }
    return rect;
  };

  const previousWidth = panel.body.style.width;
  const previousStatusText = status.textContent;
  panel.body.style.width = `${input.width}px`;
  status.textContent = input.statusText;
  await Zotero.Promise.delay(50);
  try {
    const statusRect = status.getBoundingClientRect();
    const controlsRect = controls.getBoundingClientRect();
    const statusTextRect = getFirstTextRect(status);
    const permissionTextRect = getFirstTextRect(permissionButton);
    const statusStyle =
      status.ownerDocument.defaultView?.getComputedStyle(status);
    const statusLineHeight = Number.parseFloat(statusStyle?.lineHeight || "0");
    const textGlyphsAligned =
      Math.abs(permissionTextRect.top - statusTextRect.top) <= 0.5 &&
      Math.abs(permissionTextRect.bottom - statusTextRect.bottom) <= 0.5;
    return {
      statusHeight: statusRect.height,
      statusLineHeight,
      statusTop: statusRect.top,
      controlsTop: controlsRect.top,
      statusTextTop: statusTextRect.top,
      permissionTextTop: permissionTextRect.top,
      statusTextBottom: statusTextRect.bottom,
      permissionTextBottom: permissionTextRect.bottom,
      statusWrapped: statusRect.height > statusLineHeight + 0.5,
      controlsPinnedToFirstLine:
        textGlyphsAligned &&
        permissionTextRect.top < statusRect.top + statusLineHeight,
      textGlyphsAligned,
    };
  } finally {
    panel.body.style.width = previousWidth;
    status.textContent = previousStatusText;
  }
}

async function ask(
  panelId: string,
  text: string,
  settleTimeoutMs = 5000,
): Promise<SendQuestionOptions> {
  assertWorkflowTestEnabled();
  lastSend = null;
  const panel = getPanel(panelId);
  const input = panel.body.querySelector(
    "#llm-input",
  ) as HTMLTextAreaElement | null;
  if (!input) throw new Error("Workflow test input box was not rendered");
  const sendSettledSequenceBefore = getWorkflowTestSendSettledSequence();
  input.value = text;
  const eventCtor = panel.body.ownerDocument.defaultView?.Event ?? Event;
  input.dispatchEvent(new eventCtor("input", { bubbles: true }));
  const sendBtn = panel.body.querySelector(
    "#llm-send",
  ) as HTMLButtonElement | null;
  if (!sendBtn) throw new Error("Workflow test send button was not rendered");
  sendBtn.click();
  const send = await waitForLastSend();
  const startedAt = Date.now();
  while (
    getWorkflowTestSendSettledSequence() <= sendSettledSequenceBefore &&
    Date.now() - startedAt <= settleTimeoutMs
  ) {
    await Zotero.Promise.delay(10);
  }
  if (getWorkflowTestSendSettledSequence() <= sendSettledSequenceBefore) {
    throw new Error(
      `Timed out after ${settleTimeoutMs}ms waiting for workflow send controller to settle`,
    );
  }
  return send;
}

function readWebChatPdfChipState(
  panel: PanelRecord,
): WorkflowTestWebChatPdfChipState {
  const chip = panel.body.querySelector(
    "#llm-paper-context-preview .llm-paper-context-chip[data-content-source='pdf']",
  ) as HTMLElement | null;
  if (!chip) {
    throw new Error(`Panel ${panel.id} has no WebChat PDF chip`);
  }
  return {
    fullText: chip.dataset.fullText === "true",
    inactive: chip.classList.contains(
      "llm-paper-context-chip-webchat-inactive",
    ),
    contentSource: chip.dataset.contentSource || "",
    paperItemId: Math.floor(Number(chip.dataset.paperItemId) || 0),
    contextItemId: Math.floor(Number(chip.dataset.paperContextItemId) || 0),
    modeOverride:
      paperContextModeOverrides.get(
        `${panel.item.id}:${chip.dataset.paperItemId}:${chip.dataset.paperContextItemId}`,
      ) || "",
  };
}

/*
 * The PDF chip is re-rendered as a fresh element rather than mutated in place,
 * so reading it a fixed number of milliseconds after an action is a race: on an
 * idle machine the new node is always there in time, and on a loaded CI runner
 * it sometimes is not, which silently yields the previous chip's state. Wait for
 * the state itself instead of for the clock.
 */
async function waitForChipState(
  panel: PanelRecord,
  predicate: (state: WorkflowTestWebChatPdfChipState) => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<WorkflowTestWebChatPdfChipState> {
  const startedAt = Date.now();
  let state = readWebChatPdfChipState(panel);
  while (!predicate(state)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${label}; last chip state was ${JSON.stringify(state)}`,
      );
    }
    await Zotero.Promise.delay(10);
    state = readWebChatPdfChipState(panel);
  }
  return state;
}

/*
 * A second panel mounted on the same item mirrors the first, and the test's
 * whole point is that the two never disagree. The mirror syncs after the panel
 * that was acted on, so read it once it has converged rather than immediately.
 * If it never converges that is a real defect, and this reports it as an
 * explicit timeout naming both states instead of quietly returning stale data.
 */
async function readMirrorChipStateInSyncWith(
  mirrorPanel: PanelRecord | null,
  primary: WorkflowTestWebChatPdfChipState,
  label: string,
): Promise<WorkflowTestWebChatPdfChipState | null> {
  if (!mirrorPanel) return null;
  return waitForChipState(
    mirrorPanel,
    (state) => state.fullText === primary.fullText,
    `the mirror panel's PDF chip to match the acted-on panel ${label} (expected fullText=${primary.fullText})`,
  );
}

async function toggleWebChatPdfChip(
  panel: PanelRecord,
): Promise<{ defaultPrevented: boolean; statusText: string }> {
  const chip = panel.body.querySelector(
    "#llm-paper-context-preview .llm-paper-context-chip[data-content-source='pdf']",
  ) as HTMLElement | null;
  if (!chip) {
    throw new Error(`Panel ${panel.id} has no WebChat PDF chip`);
  }
  const MouseEventCtor =
    panel.body.ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
  const event = new MouseEventCtor("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
  });
  // The toggle always flips the chip between full-text and retrieval, so the
  // flip is an exact condition to wait on rather than a stability guess.
  const fullTextBefore = readWebChatPdfChipState(panel).fullText;
  chip.dispatchEvent(event);
  await waitForChipState(
    panel,
    (state) => state.fullText !== fullTextBefore,
    "the WebChat PDF chip to flip after the toggle",
  );
  return {
    defaultPrevented: event.defaultPrevented,
    statusText:
      (
        panel.body.querySelector("#llm-status") as HTMLElement | null
      )?.textContent?.trim() || "",
  };
}

async function captureWebChatPdfTurn(
  panel: PanelRecord,
  question: string,
  outcome: "success" | "failed",
): Promise<WorkflowTestWebChatPdfTurn> {
  let modeBeforeOutcome = "";
  let modeAfterOutcome = "";
  // A successful send that carried the PDF spends it, greying the chip out.
  // Anything else -- a prompt-only send, or a send that failed and so delivered
  // nothing -- must leave the chip exactly as it was. That makes the final
  // state an exact value to wait for rather than something to sample and hope.
  const fullTextBeforeTurn = readWebChatPdfChipState(panel).fullText;
  setWorkflowTestSendInterceptor((opts) => {
    lastSend = opts;
    modeBeforeOutcome = readWebChatPdfChipState(panel).modeOverride;
    const mountedItem = activeContextPanels.get(panel.body)?.() || panel.item;
    const conversationKey = getConversationKey(mountedItem);
    const history = chatHistory.get(conversationKey) || [];
    chatHistory.set(conversationKey, [
      ...history,
      {
        role: "user",
        text: opts.question,
        timestamp: Date.now(),
        paperContexts: opts.paperContexts,
        pdfPaperContexts: opts.pdfPaperContexts,
        fullTextPaperContexts: opts.fullTextPaperContexts,
      },
    ]);
    opts.onWebChatSendOutcome?.(outcome);
    modeAfterOutcome = readWebChatPdfChipState(panel).modeOverride;
  });
  const send = await ask(panel.id, question);
  const expectedFullText =
    send.webchatSendPdf === true && outcome === "success"
      ? false
      : fullTextBeforeTurn;
  const chipAfterTurn = await waitForChipState(
    panel,
    (state) => state.fullText === expectedFullText,
    `the WebChat PDF chip to settle at fullText=${expectedFullText} after the ${outcome} turn`,
  );
  return {
    question: send.question,
    outcome,
    webchatSendPdf: send.webchatSendPdf === true,
    pdfContextItemIds: (send.webchatPdfPaperContexts || []).map(
      (context) => context.contextItemId,
    ),
    modeBeforeOutcome,
    modeAfterOutcome,
    chipAfterTurn,
  };
}

async function exerciseWebChatPdfToggleWorkflow(
  panelId: string,
  mirrorPanelId?: string,
): Promise<WorkflowTestWebChatPdfToggleDiagnostics> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const mirrorPanel = mirrorPanelId ? getPanel(mirrorPanelId) : null;
  const panelRoot = panel.body.querySelector("#llm-main") as HTMLElement | null;
  if (panelRoot?.dataset.webchatMode !== "true") {
    throw new Error(`Panel ${panelId} is not in WebChat mode`);
  }

  const initialChip = readWebChatPdfChipState(panel);
  const mirrorInitialChip = await readMirrorChipStateInSyncWith(
    mirrorPanel,
    initialChip,
    "initially",
  );
  try {
    const initialPdfTurn = await captureWebChatPdfTurn(
      panel,
      "workflow pdf initial turn",
      "success",
    );
    const mirrorAfterInitialPdfTurn = await readMirrorChipStateInSyncWith(
      mirrorPanel,
      initialPdfTurn.chipAfterTurn,
      "after the initial PDF turn",
    );
    const automaticPromptOnlyTurn = await captureWebChatPdfTurn(
      panel,
      "workflow automatic prompt-only turn",
      "success",
    );
    const mirrorAfterAutomaticPromptOnlyTurn =
      await readMirrorChipStateInSyncWith(
        mirrorPanel,
        automaticPromptOnlyTurn.chipAfterTurn,
        "after the automatic prompt-only turn",
      );
    const toggleOn = await toggleWebChatPdfChip(panel);
    const chipAfterToggleOn = readWebChatPdfChipState(panel);
    const mirrorAfterToggleOn = await readMirrorChipStateInSyncWith(
      mirrorPanel,
      chipAfterToggleOn,
      "after toggling the PDF back on",
    );
    const failedPdfTurn = await captureWebChatPdfTurn(
      panel,
      "workflow failed pdf turn",
      "failed",
    );
    const mirrorAfterFailedPdfTurn = await readMirrorChipStateInSyncWith(
      mirrorPanel,
      failedPdfTurn.chipAfterTurn,
      "after the failed PDF turn",
    );
    const toggleOff = await toggleWebChatPdfChip(panel);
    const chipAfterToggleOff = readWebChatPdfChipState(panel);
    const mirrorAfterToggleOff = await readMirrorChipStateInSyncWith(
      mirrorPanel,
      chipAfterToggleOff,
      "after toggling the PDF off",
    );
    const explicitPromptOnlyTurn = await captureWebChatPdfTurn(
      panel,
      "workflow explicit prompt-only turn",
      "success",
    );
    const mirrorAfterExplicitPromptOnlyTurn =
      await readMirrorChipStateInSyncWith(
        mirrorPanel,
        explicitPromptOnlyTurn.chipAfterTurn,
        "after the explicit prompt-only turn",
      );

    return {
      webChatMode: true,
      initialChip,
      initialPdfTurn,
      automaticPromptOnlyTurn,
      chipAfterToggleOn,
      toggleOnDefaultPrevented: toggleOn.defaultPrevented,
      toggleOnStatusText: toggleOn.statusText,
      failedPdfTurn,
      chipAfterToggleOff,
      toggleOffDefaultPrevented: toggleOff.defaultPrevented,
      toggleOffStatusText: toggleOff.statusText,
      explicitPromptOnlyTurn,
      mirrorPanel:
        mirrorPanel &&
        mirrorInitialChip &&
        mirrorAfterInitialPdfTurn &&
        mirrorAfterAutomaticPromptOnlyTurn &&
        mirrorAfterToggleOn &&
        mirrorAfterFailedPdfTurn &&
        mirrorAfterToggleOff &&
        mirrorAfterExplicitPromptOnlyTurn
          ? {
              initialChip: mirrorInitialChip,
              afterInitialPdfTurn: mirrorAfterInitialPdfTurn,
              afterAutomaticPromptOnlyTurn: mirrorAfterAutomaticPromptOnlyTurn,
              afterToggleOn: mirrorAfterToggleOn,
              afterFailedPdfTurn: mirrorAfterFailedPdfTurn,
              afterToggleOff: mirrorAfterToggleOff,
              afterExplicitPromptOnlyTurn: mirrorAfterExplicitPromptOnlyTurn,
            }
          : null,
    };
  } finally {
    setWorkflowTestSendInterceptor((opts) => {
      lastSend = opts;
    });
  }
}

async function toggleWebChatPdfChipForWorkflow(
  panelId: string,
): Promise<WorkflowTestWebChatPdfChipState> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  // toggleWebChatPdfChip now returns only once the flip has actually landed, so
  // there is nothing left to sleep for.
  await toggleWebChatPdfChip(panel);
  return readWebChatPdfChipState(panel);
}

async function sendLiveWebChatTurn(
  panelId: string,
  question: string,
  timeoutMs = 330_000,
): Promise<WorkflowTestLiveWebChatTurn> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const panelRoot = panel.body.querySelector("#llm-main") as HTMLElement | null;
  if (panelRoot?.dataset.webchatMode !== "true") {
    throw new Error(`Panel ${panelId} is not in WebChat mode`);
  }

  let outcome: WorkflowTestLiveWebChatTurn["outcome"] = null;
  setWorkflowTestSendInterceptor((opts) => {
    lastSend = opts;
    const reportOutcome = opts.onWebChatSendOutcome;
    opts.onWebChatSendOutcome = (nextOutcome) => {
      outcome = nextOutcome;
      reportOutcome?.(nextOutcome);
    };
    return true;
  });
  try {
    const send = await ask(panelId, question, timeoutMs);
    await Zotero.Promise.delay(100);
    const relayState = relayGetStateSnapshot();
    const terminal = [...relayState.responses]
      .reverse()
      .find((entry) => entry.seq === relayState.query.seq);
    return {
      question: send.question,
      outcome,
      webchatSendPdf: send.webchatSendPdf === true,
      pdfContextItemIds: (send.webchatPdfPaperContexts || []).map(
        (context) => context.contextItemId,
      ),
      chipAfterTurn: readWebChatPdfChipState(panel),
      statusText:
        (
          panel.body.querySelector("#llm-status") as HTMLElement | null
        )?.textContent?.trim() || "",
      relayStatus: relayState.status,
      runState: terminal?.run_state || relayState.run_state,
      completionReason:
        terminal?.completion_reason || relayState.completion_reason,
      responseText: terminal?.text || "",
      diagnostic:
        (terminal?.diagnostic as Record<string, unknown> | null | undefined) ||
        (relayState.last_diagnostic as Record<string, unknown> | null) ||
        null,
    };
  } finally {
    setWorkflowTestSendInterceptor((opts) => {
      lastSend = opts;
    });
  }
}

async function renderAssistantForPanel(
  panelId: string,
  input: {
    text: string;
    quoteCitations?: Message["quoteCitations"];
  },
): Promise<WorkflowTestAssistantRenderResult> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const doc = panel.body.ownerDocument;
  const bubble = doc.createElement("div") as HTMLDivElement;
  bubble.className = "llm-message-content";
  panel.body.appendChild(bubble);

  const assistantMessage: Message = {
    role: "assistant",
    text: input.text,
    timestamp: Date.now(),
    quoteCitations: input.quoteCitations,
  };
  const paperContext = panel.contextSnapshot?.paperContext;
  const pairedUserMessage: Message = {
    role: "user",
    text: "中文问题：请解释这篇论文。",
    timestamp: assistantMessage.timestamp - 1,
    paperContexts: paperContext ? [paperContext] : undefined,
    fullTextPaperContexts: paperContext ? [paperContext] : undefined,
    citationPaperContexts: paperContext ? [paperContext] : undefined,
  };

  renderRenderedMarkdownInto(
    bubble,
    buildAssistantDisplayMarkdownForRender(assistantMessage),
    doc,
  );
  renderQuoteCitationPlaceholders({
    body: panel.body,
    panelItem: panel.item,
    bubble,
    assistantMessage,
    pairedUserMessage,
  });
  decorateAssistantCitationLinks({
    body: panel.body,
    panelItem: panel.item,
    bubble,
    assistantMessage,
    pairedUserMessage,
  });

  const quoteCards = Array.from(
    bubble.querySelectorAll(".llm-quote-card"),
  ) as HTMLElement[];
  const quoteCardBodiesBeforeExpansion = Array.from(
    bubble.querySelectorAll(".llm-quote-card-body"),
  ).map((node) => ((node as Element).textContent || "").trim());
  for (const quoteCard of quoteCards) {
    if (quoteCard.dataset.quoteStatus === "verified") quoteCard.click();
  }
  return {
    renderedText: bubble.textContent || "",
    quoteCardBodiesBeforeExpansion,
    quoteCardBodies: Array.from(
      bubble.querySelectorAll(".llm-quote-card-body"),
    ).map((node) => ((node as Element).textContent || "").trim()),
    quoteCardPreviewTexts: Array.from(
      bubble.querySelectorAll(".llm-quote-card-preview"),
    ).map((node) => ((node as Element).textContent || "").trim()),
    quoteCardStatuses: quoteCards.map((node) => node.dataset.quoteStatus || ""),
    quoteCardCitationTexts: Array.from(
      bubble.querySelectorAll(".llm-quote-card-citation"),
    ).map((node) => ((node as Element).textContent || "").trim()),
    quoteCardVerticalMargins: quoteCards.map((node) => {
      const style = doc.defaultView?.getComputedStyle(node);
      return {
        top: Number.parseFloat(style?.marginTop || "0") || 0,
        bottom: Number.parseFloat(style?.marginBottom || "0") || 0,
      };
    }),
  };
}

async function exerciseTargetedQuoteRefresh(
  panelId: string,
): Promise<WorkflowTestTargetedQuoteRefreshResult> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const item = activeContextPanels.get(panel.body)?.() || panel.item;
  const conversationKey = getConversationKey(item);
  if (!conversationKey) {
    throw new Error("Workflow panel has no active conversation key");
  }
  const paperContext = panel.contextSnapshot?.paperContext;
  const baseTimestamp = Date.now() - 100_000;
  const messages: Message[] = [];
  const assistantMessages: Message[] = [];
  for (let turn = 0; turn < 8; turn += 1) {
    const userMessage: Message = {
      role: "user",
      text: `Explain the evidence for figure ${turn + 1}.`,
      timestamp: baseTimestamp + turn * 2,
      paperContexts: paperContext ? [paperContext] : undefined,
    };
    const quoteCitations = Array.from({ length: 8 }, (_value, quoteIndex) => {
      const id = `Q_perf_${turn}_${quoteIndex}`;
      return {
        id,
        quoteText: `Source quotation ${quoteIndex + 1} for response ${turn + 1} contains enough text to exercise a long quote-card conversation.`,
        citationLabel: "(Workflow, 2026)",
        itemId: paperContext?.itemId,
        contextItemId: paperContext?.contextItemId,
      };
    });
    // Turn 6 cites its first source quote a second time at the end, the way
    // a review re-quotes a key passage: two cards share one citation id.
    const repeatedCitation = turn === 5 ? quoteCitations[0] : null;
    const assistantMessage: Message = {
      role: "assistant",
      text: [
        ...quoteCitations.map(
          (citation, quoteIndex) =>
            `Evidence ${quoteIndex + 1}:\n\n[[quote:${citation.id}]]`,
        ),
        ...(repeatedCitation
          ? [`Again, the key passage:\n\n[[quote:${repeatedCitation.id}]]`]
          : []),
      ].join("\n\n"),
      timestamp: baseTimestamp + turn * 2 + 1,
      modelName: "workflow-performance",
      quoteCitations,
    };
    messages.push(userMessage, assistantMessage);
    assistantMessages.push(assistantMessage);
  }

  chatHistory.set(conversationKey, messages);
  loadedConversationKeys.add(conversationKey);
  refreshChat(panel.body, item);

  const chatBox = panel.body.querySelector(
    "#llm-chat-box",
  ) as HTMLElement | null;
  if (!chatBox) throw new Error("Workflow panel chat box was not rendered");
  const wrappersBefore = new Map(
    (
      Array.from(
        chatBox.querySelectorAll(
          ".llm-message-wrapper[data-message-timestamp]",
        ),
      ) as HTMLElement[]
    ).map((wrapper) => [wrapper.dataset.messageTimestamp || "", wrapper]),
  );

  const target = assistantMessages[Math.floor(assistantMessages.length / 2)];
  target.quoteDisplayOverride = {
    markdown: Array.from(
      { length: 8 },
      (_value, quoteIndex) =>
        `> **Rejected interpretation ${quoteIndex + 1}** remains visible for manual review.\n>\n> Not a source quote`,
    ).join("\n\n"),
    quoteCitations: [],
  };
  refreshChat(panel.body, item, {
    rerenderAssistantMessages: new Set([target]),
  });

  const wrappersAfter = Array.from(
    chatBox.querySelectorAll(".llm-message-wrapper[data-message-timestamp]"),
  ) as HTMLElement[];
  let unchangedWrapperCount = 0;
  let replacedWrapperCount = 0;
  for (const wrapper of wrappersAfter) {
    const before = wrappersBefore.get(wrapper.dataset.messageTimestamp || "");
    if (before === wrapper) unchangedWrapperCount += 1;
    else replacedWrapperCount += 1;
  }
  const targetTimestamp = `${Math.floor(Number(target.timestamp) || 0)}`;
  const targetWrapper = wrappersAfter.find(
    (wrapper) => wrapper.dataset.messageTimestamp === targetTimestamp,
  );
  const scrollStability = await probeTargetedRerenderScrollStability({
    panel,
    item,
    chatBox,
    wrappers: wrappersAfter,
    expandedMessage: assistantMessages[5],
    earlierMessage: assistantMessages[2],
  });
  return {
    scrollStability,
    messageCount: messages.length,
    assistantMessageCount: assistantMessages.length,
    quoteCardCount: chatBox.querySelectorAll(".llm-quote-card").length,
    unchangedWrapperCount,
    replacedWrapperCount,
    targetWasReplaced:
      Boolean(targetWrapper) &&
      wrappersBefore.get(targetTimestamp) !== targetWrapper,
    targetNotSourceCardCount:
      targetWrapper?.querySelectorAll(
        '.llm-quote-card[data-quote-status="not-source"]',
      ).length || 0,
    targetStrongBodyCount:
      targetWrapper?.querySelectorAll(".llm-quote-card-body strong").length ||
      0,
  };
}

function wrapperForMessage(
  wrappers: HTMLElement[],
  message: Message,
): HTMLElement {
  const timestamp = `${Math.floor(Number(message.timestamp) || 0)}`;
  const wrapper = wrappers.find(
    (candidate) => candidate.dataset.messageTimestamp === timestamp,
  );
  if (!wrapper) {
    throw new Error(`Workflow chat has no wrapper for message ${timestamp}`);
  }
  return wrapper;
}

async function probeTargetedRerenderScrollStability(params: {
  panel: PanelRecord;
  item: Zotero.Item;
  chatBox: HTMLElement;
  wrappers: HTMLElement[];
  expandedMessage: Message;
  earlierMessage: Message;
}): Promise<WorkflowTestTargetedQuoteRefreshResult["scrollStability"]> {
  const { chatBox } = params;
  const win = params.panel.body.ownerDocument.defaultView;
  if (!win) throw new Error("Workflow panel has no window");
  const nextFrame = () =>
    new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()));

  const expandedWrapper = wrapperForMessage(
    params.wrappers,
    params.expandedMessage,
  );
  const earlierWrapper = wrapperForMessage(
    params.wrappers,
    params.earlierMessage,
  );
  const conversationKey = getConversationKey(params.item);
  const timeline: Array<Record<string, unknown>> = [];
  const record = (label: string) => {
    const snapshot = getChatScrollSnapshot(conversationKey);
    timeline.push({
      label,
      scrollTop: chatBox.scrollTop,
      scrollHeight: chatBox.scrollHeight,
      wrapperTop:
        expandedWrapper.getBoundingClientRect().top -
        chatBox.getBoundingClientRect().top,
      snapshot: snapshot
        ? `${snapshot.mode}@${snapshot.scrollTop}${snapshot.anchor ? `/${snapshot.anchor.kind}:${snapshot.anchor.quoteCitationId || snapshot.anchor.messageAnchorKey}` : ""}`
        : null,
    });
  };
  record("start");
  // The reader is on the last card of the later message: the repeated quote,
  // whose citation id also belongs to an earlier card in the same message.
  const verifiedCards = Array.from(
    expandedWrapper.querySelectorAll(
      '.llm-quote-card[data-quote-status="verified"]',
    ),
  ) as HTMLElement[];
  const card = verifiedCards[verifiedCards.length - 1];
  if (!card) throw new Error("Expanded message rendered no verified card");
  // The card straddles the top edge, as a card the reader has just scrolled
  // past does; the anchor search prefers exactly that card.
  chatBox.scrollTop +=
    card.getBoundingClientRect().top - chatBox.getBoundingClientRect().top + 12;
  record("after-scroll-write");
  const cardTopAfterScrollWrite = card.getBoundingClientRect().top;
  await nextFrame();
  record("after-frame-1");
  await nextFrame();
  record("after-frame-2");
  // Nothing has been clicked yet: the view must still be where the reader
  // put it once the panel's deferred scroll work has run.
  const settleDrift =
    card.getBoundingClientRect().top - cardTopAfterScrollWrite;

  card.click();
  record("after-click");
  await nextFrame();
  record("after-click-frame");
  const citationId = card.dataset.quoteCitationId || "";
  const sameCitationCards = expandedWrapper.querySelectorAll(
    `.llm-quote-card[data-quote-citation-id="${citationId}"]`,
  ).length;
  const expandedBeforeRerender = card.dataset.expanded === "true";
  const scrollTopBefore = chatBox.scrollTop;
  const cardTopBefore = card.getBoundingClientRect().top;
  const earlierHeightBefore = earlierWrapper.getBoundingClientRect().height;

  // An earlier message changes height above the viewport while the expanded
  // message is re-rendered with identical content under new citation identity.
  params.earlierMessage.quoteDisplayOverride = {
    markdown: Array.from(
      { length: 8 },
      (_value, quoteIndex) =>
        `> **Rejected interpretation ${quoteIndex + 1}** remains visible for manual review.\n>\n> It stays in the transcript so the reader can see what the model claimed.\n>\n> It also stays long enough to move everything below it.\n>\n> Not a source quote`,
    ).join("\n\n"),
    quoteCitations: [],
  };
  params.expandedMessage.quoteCitations =
    params.expandedMessage.quoteCitations?.map((citation) => ({
      ...citation,
    }));
  refreshChat(params.panel.body, params.item, {
    rerenderAssistantMessages: new Set([
      params.earlierMessage,
      params.expandedMessage,
    ]),
  });
  await nextFrame();

  record("after-rerender-frame");
  const snapshotBefore = getChatScrollSnapshot(conversationKey);
  const expandedWrapperAfter = wrapperForMessage(
    Array.from(
      chatBox.querySelectorAll(".llm-message-wrapper[data-message-timestamp]"),
    ) as HTMLElement[],
    params.expandedMessage,
  );
  const cardsAfter = Array.from(
    expandedWrapperAfter.querySelectorAll(
      `.llm-quote-card[data-quote-citation-id="${citationId}"]`,
    ),
  ) as HTMLElement[];
  const cardAfter = cardsAfter[cardsAfter.length - 1] || null;
  const diagnostics: Record<string, unknown> = {
    timeline,
    sameCitationCards,
    snapshotBefore: snapshotBefore
      ? {
          mode: snapshotBefore.mode,
          scrollTop: snapshotBefore.scrollTop,
          anchor: snapshotBefore.anchor,
        }
      : null,
    expandedWrapperReplaced: expandedWrapperAfter !== expandedWrapper,
    expandedWrapperStillConnected: expandedWrapper.isConnected,
    cardAfterIsSameNode: cardAfter === card,
    cardTopBefore,
    cardTopAfter: cardAfter?.getBoundingClientRect().top ?? null,
    chatBoxTop: chatBox.getBoundingClientRect().top,
    scrollTopBefore,
    scrollTopAfter: chatBox.scrollTop,
    scrollHeightAfter: chatBox.scrollHeight,
    clientHeight: chatBox.clientHeight,
  };
  return {
    diagnostics,
    chatBoxScrollable: chatBox.scrollHeight > chatBox.clientHeight + 1,
    earlierWrapperHeightDelta:
      earlierWrapper.getBoundingClientRect().height - earlierHeightBefore,
    expandedBeforeRerender,
    expandedAfterRerender: cardAfter?.dataset.expanded === "true",
    expandedBodyTextAfterRerender: (
      cardAfter?.querySelector(".llm-quote-card-body")?.textContent || ""
    ).trim(),
    sameCitationCards,
    settleDrift,
    cardTopDelta: cardAfter
      ? cardAfter.getBoundingClientRect().top - cardTopBefore
      : Number.NaN,
    scrollTopDelta: chatBox.scrollTop - scrollTopBefore,
  };
}

function parsePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function getStandaloneWindowReferenceForTest(): Window | null {
  return (
    (addon as unknown as { data?: { standaloneWindow?: Window } }).data
      ?.standaloneWindow || null
  );
}

function getStandaloneWindowForTest(): Window | null {
  const win = getStandaloneWindowReferenceForTest();
  return win && !win.closed ? win : null;
}

async function selectZoteroItemForWorkflow(itemId: number): Promise<void> {
  const panes: unknown[] = [];
  try {
    panes.push(Zotero.getActiveZoteroPane?.());
  } catch (_error) {
    void _error;
  }
  try {
    panes.push(Zotero.getMainWindow?.()?.ZoteroPane);
  } catch (_error) {
    void _error;
  }
  for (const pane of panes) {
    const typed = pane as
      | {
          selectItems?: (
            ids: number[],
            options?: { selectInLibrary?: boolean },
          ) => Promise<unknown> | unknown;
          selectItem?: (
            id: number,
            selectInLibrary?: boolean,
          ) => Promise<unknown> | unknown;
        }
      | null
      | undefined;
    if (typeof typed?.selectItems === "function") {
      await typed.selectItems([itemId], { selectInLibrary: true });
      return;
    }
    if (typeof typed?.selectItem === "function") {
      await typed.selectItem(itemId, true);
      return;
    }
  }
}

async function waitForStandaloneReady(): Promise<Document> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 7000) {
    const win = getStandaloneWindowForTest();
    const doc = win?.document;
    const root = doc?.getElementById("llmforzotero-standalone-chat-root");
    const paperTab = doc?.querySelector(
      ".llm-standalone-tab[data-tab='paper']",
    );
    const panelRoot = doc?.querySelector(".llm-standalone-content #llm-main");
    if (doc && root && paperTab && panelRoot) {
      return doc;
    }
    await Zotero.Promise.delay(25);
  }
  throw new Error("Timed out waiting for standalone workflow window");
}

function readStandaloneDiagnostics(): WorkflowTestStandaloneDiagnostics {
  const win = getStandaloneWindowForTest();
  const doc = win?.document || null;
  const activeTab = doc?.querySelector(
    ".llm-standalone-tab.active",
  ) as HTMLElement | null;
  const paperTab = doc?.querySelector(
    ".llm-standalone-tab[data-tab='paper']",
  ) as HTMLElement | null;
  const openTab = doc?.querySelector(
    ".llm-standalone-tab[data-tab='open']",
  ) as HTMLElement | null;
  const contentArea = doc?.querySelector(
    ".llm-standalone-content",
  ) as HTMLElement | null;
  const panelRoot = contentArea?.querySelector(
    "#llm-main",
  ) as HTMLElement | null;
  const statusEl = contentArea?.querySelector(
    "#llm-status",
  ) as HTMLElement | null;
  const titleEl = doc?.querySelector(
    ".llm-standalone-content-title-text",
  ) as HTMLElement | null;
  const sidebar = doc?.querySelector(
    ".llm-standalone-sidebar",
  ) as HTMLElement | null;
  const sidebarHeader = doc?.querySelector(
    ".llm-standalone-sidebar-header",
  ) as HTMLElement | null;
  const sidebarPanel = doc?.querySelector(
    ".llm-standalone-sidebar-panel",
  ) as HTMLElement | null;
  const windowButtons = doc?.querySelector(
    ".llm-standalone-sidebar-header .llm-window-buttons",
  ) as HTMLElement | null;
  const collapseToggle = doc?.querySelector(
    ".llm-standalone-nav-toggle",
  ) as HTMLElement | null;
  const tabRow = doc?.querySelector(
    ".llm-standalone-tab-row",
  ) as HTMLElement | null;
  const newChatAction = doc?.querySelector(
    '[data-sidebar-action="new-chat"]',
  ) as HTMLElement | null;
  const newChatLabel = newChatAction?.querySelector(
    ".llm-standalone-nav-label",
  ) as HTMLElement | null;
  const contentTitleRow = doc?.querySelector(
    ".llm-standalone-content-title",
  ) as HTMLElement | null;
  const chatBox = contentArea?.querySelector(
    "#llm-chat-box",
  ) as HTMLElement | null;
  const mountedItem = contentArea
    ? activeContextPanels.get(contentArea)?.() || null
    : null;
  const rawItem = contentArea
    ? activeContextPanelRawItems.get(contentArea) || null
    : null;
  const activeTabName =
    activeTab?.dataset.tab === "paper"
      ? "paper"
      : activeTab?.dataset.tab === "open"
        ? "open"
        : null;
  const centerY = (element: HTMLElement | null): number | null => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return rect.top + rect.height / 2;
  };
  const textCenterY = (element: HTMLElement | null): number | null => {
    if (!element) return null;
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return rect.height > 0 ? rect.top + rect.height / 2 : centerY(element);
  };
  const toolbarCenters = [centerY(sidebarHeader), centerY(tabRow)];
  const titleCenters = [centerY(newChatAction), centerY(contentTitleRow)];
  // The header carries no text of its own any more, so the collapse toggle is
  // what has to share a centreline with the tabs beside it.
  const toolbarControlCenters = [centerY(collapseToggle), centerY(activeTab)];
  const titleTextCenters = [textCenterY(newChatLabel), textCenterY(titleEl)];
  const centerDelta = (centers: Array<number | null>): number | undefined => {
    if (centers.some((value) => value === null)) return undefined;
    return Math.abs((centers[0] as number) - (centers[1] as number));
  };
  const toolbarCenterDeltaPx = centerDelta(toolbarCenters);
  const titleCenterDeltaPx = centerDelta(titleCenters);
  const toolbarControlCenterDeltaPx = centerDelta(toolbarControlCenters);
  const titleTextCenterDeltaPx = centerDelta(titleTextCenters);
  return {
    activeTab: activeTabName,
    sidebarState:
      sidebar?.dataset.sidebarState === "collapsed"
        ? "collapsed"
        : sidebar?.dataset.sidebarState === "expanded"
          ? "expanded"
          : undefined,
    customTitlebar: Boolean(
      doc?.documentElement?.hasAttribute("customtitlebar"),
    ),
    collapseToggleHost: collapseToggle
      ? collapseToggle.closest(".llm-standalone-tab-row")
        ? "tab-row"
        : "sidebar-header"
      : undefined,
    sidebarWidthPx: sidebar ? sidebar.getBoundingClientRect().width : undefined,
    sidebarFlyout:
      sidebar?.dataset.sidebarFlyout === "open" ? "open" : "closed",
    sidebarPanelWidthPx: sidebarPanel
      ? sidebarPanel.getBoundingClientRect().width
      : undefined,
    sidebarPanelOpacity: sidebarPanel
      ? Number(win?.getComputedStyle(sidebarPanel)?.opacity ?? Number.NaN)
      : undefined,
    sidebarContent: sidebarPanel
      ? {
          labels: Array.from(
            sidebarPanel.querySelectorAll(".llm-standalone-nav-label"),
          ).map((node) => {
            const label = node as HTMLElement;
            return {
              text: label.textContent || "",
              width: label.getBoundingClientRect().width,
              opacity: Number(win?.getComputedStyle(label)?.opacity),
            };
          }),
          historyHeight:
            sidebarPanel
              .querySelector(".llm-standalone-history-region")
              ?.getBoundingClientRect().height || 0,
          historyText:
            sidebarPanel.querySelector(".llm-standalone-sidebar-list")
              ?.textContent || "",
          actionWidths: Array.from(
            sidebarPanel.querySelectorAll("[data-sidebar-action]"),
          ).map(
            (action) => (action as HTMLElement).getBoundingClientRect().width,
          ),
        }
      : undefined,
    windowButtonsWidthPx: windowButtons
      ? windowButtons.getBoundingClientRect().width
      : undefined,
    sidebarActionOrder: Array.from(
      sidebar?.querySelectorAll("[data-sidebar-action]") || [],
    ).map((node) => (node as HTMLElement).dataset.sidebarAction || ""),
    sidebarPrimaryActionOrder: Array.from(
      sidebar?.querySelectorAll(
        ".llm-standalone-primary-nav [data-sidebar-action]",
      ) || [],
    ).map((node) => (node as HTMLElement).dataset.sidebarAction || ""),
    titleActionLabels: Array.from(
      doc?.querySelectorAll(".llm-standalone-content-title-actions button") ||
        [],
    ).map((node) =>
      ((node as HTMLElement).getAttribute("aria-label") || "").trim(),
    ),
    alignment:
      toolbarCenterDeltaPx === undefined ||
      titleCenterDeltaPx === undefined ||
      toolbarControlCenterDeltaPx === undefined ||
      titleTextCenterDeltaPx === undefined
        ? undefined
        : {
            toolbarCenterDeltaPx,
            titleCenterDeltaPx,
            toolbarControlCenterDeltaPx,
            titleTextCenterDeltaPx,
          },
    conversationKey: mountedItem ? getConversationKey(mountedItem) : undefined,
    activeItemId: parsePositiveInt(mountedItem?.id),
    rawContextItemId:
      parsePositiveInt(rawItem?.id) ||
      parsePositiveInt(panelRoot?.dataset.rawContextItemId),
    basePaperItemId: parsePositiveInt(panelRoot?.dataset.basePaperItemId),
    contextItemId: parsePositiveInt(panelRoot?.dataset.contextItemId),
    conversationKind: panelRoot?.dataset.conversationKind || undefined,
    runtimeMode: panelRoot?.dataset.runtimeMode || undefined,
    conversationSystem: panelRoot?.dataset.conversationSystem || undefined,
    titleText: titleEl?.textContent?.trim() || undefined,
    chipText: Array.from(
      contentArea?.querySelectorAll(
        "#llm-paper-context-preview .llm-paper-context-chip > .llm-paper-context-chip-header .llm-paper-context-chip-text",
      ) || [],
    ).map((node) => ((node as Element).textContent || "").trim()),
    composerPaperContextKeys: Array.from(
      contentArea?.querySelectorAll(
        "#llm-paper-context-preview .llm-paper-context-chip",
      ) || [],
    ).map((node) => {
      const chip = node as HTMLElement;
      return `${chip.dataset.paperItemId}:${chip.dataset.paperContextItemId}`;
    }),
    selectedContextLabels: Array.from(
      contentArea?.querySelectorAll(".llm-selected-context-meta") || [],
    ).map((node) => ((node as Element).textContent || "").trim()),
    composerCollectionLabels: Array.from(
      contentArea?.querySelectorAll(
        "#llm-paper-context-preview .llm-collection-chip-title",
      ) || [],
    ).map((node) => ((node as Element).textContent || "").trim()),
    composerTagLabels: Array.from(
      contentArea?.querySelectorAll(
        "#llm-paper-context-preview .llm-tag-chip-title",
      ) || [],
    ).map((node) => ((node as Element).textContent || "").trim()),
    messageText: chatBox?.textContent?.trim() || undefined,
    paperTabText: paperTab?.textContent?.trim() || undefined,
    openTabText: openTab?.textContent?.trim() || undefined,
    statusText: statusEl?.textContent?.trim() || undefined,
    runtimeSystemToggles: readRuntimeSystemToggles(
      doc,
      ".llm-standalone-runtime-system-controls",
    ),
    lastSend,
    lastFinalRequest,
  };
}

async function getStandaloneDiagnostics(): Promise<WorkflowTestStandaloneDiagnostics> {
  if (getStandaloneWindowForTest()) {
    await waitForStandaloneReady().catch(() => undefined);
  }
  return readStandaloneDiagnostics();
}

async function ensureStandaloneWorkflowPanelReady(): Promise<{
  contentArea: HTMLElement;
  item: Zotero.Item;
}> {
  const doc = await waitForStandaloneReady();
  const contentArea = doc.querySelector(
    ".llm-standalone-content",
  ) as HTMLElement | null;
  let item = contentArea
    ? activeContextPanels.get(contentArea)?.() || null
    : null;
  if (!contentArea || !item) {
    throw new Error("Standalone workflow chat panel is not mounted");
  }

  // Standalone mounting provisions and hydrates the conversation in a detached
  // async task. Await the same gate a real send uses instead of assuming that a
  // fixed paint delay is long enough under database or migration load.
  await ensureConversationLoaded(item);
  item = activeContextPanels.get(contentArea)?.() || item;
  refreshChat(contentArea, item);
  return { contentArea, item };
}

async function openStandaloneForItem(
  itemId: number,
): Promise<WorkflowTestStandaloneDiagnostics> {
  assertWorkflowTestEnabled();
  const item = Zotero.Items.get(itemId);
  if (!item) throw new Error(`Unable to find Zotero item ${itemId}`);
  await closeStandalone();
  await selectZoteroItemForWorkflow(itemId).catch(() => undefined);
  openStandaloneChat({ initialItem: item });
  await ensureStandaloneWorkflowPanelReady();
  return readStandaloneDiagnostics();
}

async function openStandaloneForLibraryAfterRestart(): Promise<WorkflowTestStandaloneDiagnostics> {
  assertWorkflowTestEnabled();
  await closeStandalone();
  disposeWorkflowPanels();
  clearWorkflowConversationRuntimeState();
  openStandaloneChat();
  await waitForStandaloneReady();
  await Zotero.Promise.delay(250);
  return readStandaloneDiagnostics();
}

async function clickStandaloneTab(
  tab: "paper" | "open",
): Promise<WorkflowTestStandaloneDiagnostics> {
  assertWorkflowTestEnabled();
  const doc = await waitForStandaloneReady();
  const button = doc.querySelector(
    `.llm-standalone-tab[data-tab='${tab}']`,
  ) as HTMLButtonElement | null;
  if (!button) throw new Error(`Standalone ${tab} tab was not rendered`);
  button.click();
  await ensureStandaloneWorkflowPanelReady();
  return readStandaloneDiagnostics();
}

/**
 * The rail animates its width over 280ms. Reading geometry before that settles
 * reports a mid-transition width, so wait until two consecutive measurements
 * agree before any caller inspects the layout.
 */
async function waitForStandaloneSidebarWidthSettled(
  doc: Document,
): Promise<void> {
  const sidebar = doc.querySelector(
    ".llm-standalone-sidebar",
  ) as HTMLElement | null;
  if (!sidebar) return;
  let previous = Number.NaN;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const width = sidebar.getBoundingClientRect().width;
    if (width === previous) return;
    previous = width;
    await Zotero.Promise.delay(25);
  }
}

/**
 * Reveals the collapsed sidebar the way a pointer does. The panel slides in
 * over 280ms, so wait for it to settle before any caller measures it.
 */
async function hoverStandaloneSidebarToggle(): Promise<WorkflowTestStandaloneDiagnostics> {
  assertWorkflowTestEnabled();
  const doc = await waitForStandaloneReady();
  const toggle = doc.querySelector(
    ".llm-standalone-nav-toggle",
  ) as HTMLElement | null;
  if (!toggle) throw new Error("Standalone sidebar toggle was not rendered");
  const view = doc.defaultView;
  const event = new (
    view as unknown as { MouseEvent: typeof MouseEvent }
  ).MouseEvent("mouseenter", { bubbles: false, cancelable: false });
  toggle.dispatchEvent(event);
  await Zotero.Promise.delay(25);
  await waitForStandaloneSidebarPanelSettled(doc);
  return readStandaloneDiagnostics();
}

/** Waits until the flyout's slide-in transition stops moving the panel. */
async function waitForStandaloneSidebarPanelSettled(
  doc: Document,
): Promise<void> {
  const panel = doc.querySelector(
    ".llm-standalone-sidebar-panel",
  ) as HTMLElement | null;
  if (!panel) return;
  let previous = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rect = panel.getBoundingClientRect();
    const opacity = doc.defaultView?.getComputedStyle(panel)?.opacity || "";
    const sample = `${rect.left}:${rect.width}:${opacity}`;
    if (sample === previous) return;
    previous = sample;
    await Zotero.Promise.delay(25);
  }
}

async function toggleStandaloneSidebar(): Promise<WorkflowTestStandaloneDiagnostics> {
  assertWorkflowTestEnabled();
  const doc = await waitForStandaloneReady();
  const button = doc.querySelector(
    ".llm-standalone-nav-toggle",
  ) as HTMLButtonElement | null;
  if (!button) throw new Error("Standalone sidebar toggle was not rendered");
  button.click();
  await Zotero.Promise.delay(25);
  await waitForStandaloneSidebarWidthSettled(doc);
  return readStandaloneDiagnostics();
}

async function clickStandaloneSystemToggle(
  system: RuntimeConversationSystem,
): Promise<WorkflowTestStandaloneDiagnostics> {
  assertWorkflowTestEnabled();
  const doc = await waitForStandaloneReady();
  const currentSystem = (readStandaloneDiagnostics().conversationSystem ||
    "upstream") as ConversationSystem;
  const expectedSystem: ConversationSystem =
    currentSystem === system ? "upstream" : system;
  const button = doc.querySelector(
    `.llm-standalone-runtime-system-toggle[data-conversation-system='${system}']`,
  ) as HTMLButtonElement | null;
  if (!button) {
    throw new Error(`Standalone ${system} system toggle was not rendered`);
  }
  button.click();
  return waitForStandaloneConversationSystem(expectedSystem);
}

async function waitForStandaloneConversationSystem(
  expectedSystem: ConversationSystem,
  timeoutMs = 5000,
): Promise<WorkflowTestStandaloneDiagnostics> {
  const startedAt = Date.now();
  let diagnostics = readStandaloneDiagnostics();
  while (
    diagnostics.conversationSystem !== expectedSystem &&
    Date.now() - startedAt < timeoutMs
  ) {
    await Zotero.Promise.delay(25);
    diagnostics = readStandaloneDiagnostics();
  }
  if (diagnostics.conversationSystem !== expectedSystem) {
    throw new Error(
      `Timed out waiting for standalone runtime ${expectedSystem}: ${JSON.stringify(diagnostics)}`,
    );
  }
  return diagnostics;
}

async function clickStandaloneSystemTogglesRapidly(
  systems: RuntimeConversationSystem[],
): Promise<WorkflowTestStandaloneDiagnostics> {
  assertWorkflowTestEnabled();
  const doc = await waitForStandaloneReady();
  let expectedSystem = (readStandaloneDiagnostics().conversationSystem ||
    "upstream") as ConversationSystem;
  for (const system of systems) {
    const button = doc.querySelector(
      `.llm-standalone-runtime-system-toggle[data-conversation-system='${system}']`,
    ) as HTMLButtonElement | null;
    if (!button) {
      throw new Error(`Standalone ${system} system toggle was not rendered`);
    }
    button.click();
    expectedSystem = expectedSystem === system ? "upstream" : system;
  }
  return waitForStandaloneConversationSystem(expectedSystem);
}

async function measureStandaloneRuntimeGeometry(input: {
  width: number;
  fontScale: number;
}): Promise<WorkflowTestRuntimeGeometry> {
  assertWorkflowTestEnabled();
  const doc = await waitForStandaloneReady();
  const root = doc.getElementById(
    "llmforzotero-standalone-chat-root",
  ) as HTMLElement | null;
  const tabRow = doc.querySelector(
    ".llm-standalone-tab-row",
  ) as HTMLElement | null;
  const runtimeControls = doc.querySelector(
    ".llm-standalone-runtime-system-controls",
  ) as HTMLElement | null;
  const tabGroup = doc.querySelector(
    ".llm-standalone-tab-group",
  ) as HTMLElement | null;
  if (!root || !tabRow || !runtimeControls || !tabGroup) {
    throw new Error("Standalone runtime geometry targets were not rendered");
  }

  const previousWidth = tabRow.style.width;
  const previousBoxSizing = tabRow.style.boxSizing;
  const previousScale = root.style.getPropertyValue("--llm-font-scale");
  tabRow.style.width = `${input.width}px`;
  tabRow.style.boxSizing = "border-box";
  root.style.setProperty("--llm-font-scale", String(input.fontScale));
  await Zotero.Promise.delay(50);
  try {
    const containerRect = tabRow.getBoundingClientRect();
    const runtimeRect = getVisibleRuntimeControlsRect(runtimeControls);
    const runtimeButtonWidths = getVisibleRuntimeButtonRects(
      runtimeControls,
    ).map((rect) => rect.width);
    const tabsRect = tabGroup.getBoundingClientRect();
    const containerCenter = containerRect.left + containerRect.width / 2;
    const tabsCenter = tabsRect.left + tabsRect.width / 2;
    return {
      containerWidth: containerRect.width,
      fontScale: input.fontScale,
      runtimeWidth: runtimeRect.width,
      runtimeButtonWidths,
      runtimeIntersectsLeadingContent: rectsIntersect(runtimeRect, tabsRect),
      runtimeIntersectsTrailingContent: false,
      runtimeTrailingOverlapPx: 0,
      runtimeWithinContainer: rectWithinContainer(runtimeRect, containerRect),
      trailingContentWithinContainer: true,
      deleteButtonIconOnly: false,
      centeredContentOffset: Math.abs(tabsCenter - containerCenter),
    };
  } finally {
    tabRow.style.width = previousWidth;
    tabRow.style.boxSizing = previousBoxSizing;
    if (previousScale) {
      root.style.setProperty("--llm-font-scale", previousScale);
    } else {
      root.style.removeProperty("--llm-font-scale");
    }
  }
}

async function exerciseStandaloneComposerManualResize(): Promise<WorkflowTestStandaloneComposerResizeDiagnostics> {
  assertWorkflowTestEnabled();
  const doc = await waitForStandaloneReady();
  const win = getStandaloneWindowForTest();
  const input = doc.querySelector(
    ".llm-standalone-content #llm-input",
  ) as HTMLTextAreaElement | null;
  const handle = doc.querySelector(
    '.llm-standalone-resize-handle[data-resize-target="input"]',
  ) as HTMLElement | null;
  if (!win || !input || !handle) {
    throw new Error("Standalone composer resize controls were not rendered");
  }

  const heightBeforeDrag = input.getBoundingClientRect().height;
  const startScreenY = 500;
  handle.dispatchEvent(
    new win.MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      screenY: startScreenY,
    }),
  );
  win.dispatchEvent(
    new win.MouseEvent("mousemove", {
      bubbles: true,
      screenY: startScreenY + 60,
    }),
  );
  win.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true }));
  const heightAfterDrag = Number.parseFloat(input.style.height || "0") || 0;

  input.value = "Manual standalone composer height survives typed input.";
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  const heightAfterInput = Number.parseFloat(input.style.height || "0") || 0;

  return {
    heightBeforeDrag,
    heightAfterDrag,
    heightAfterInput,
    manualHeightMarked: input.dataset.llmManualHeight === "true",
  };
}

async function askStandalone(text: string): Promise<SendQuestionOptions> {
  assertWorkflowTestEnabled();
  lastSend = null;
  const doc = await waitForStandaloneReady();
  const input = doc.querySelector(
    ".llm-standalone-content #llm-input",
  ) as HTMLTextAreaElement | null;
  if (!input) throw new Error("Standalone workflow input box was not rendered");
  input.value = text;
  const eventCtor = doc.defaultView?.Event ?? Event;
  input.dispatchEvent(new eventCtor("input", { bubbles: true }));
  const sendBtn = doc.querySelector(
    ".llm-standalone-content #llm-send",
  ) as HTMLButtonElement | null;
  if (!sendBtn)
    throw new Error("Standalone workflow send button was not rendered");
  const startedAt = Date.now();
  while (sendBtn.disabled && Date.now() - startedAt < 5000) {
    await Zotero.Promise.delay(25);
  }
  sendBtn.click();
  return waitForLastSend();
}

async function startNewStandaloneConversation(): Promise<WorkflowTestStandaloneDiagnostics> {
  assertWorkflowTestEnabled();
  const { contentArea } = await ensureStandaloneWorkflowPanelReady();
  const before = readStandaloneDiagnostics();
  dispatchWorkflowClick(contentArea, "#llm-history-new", "New chat button");
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const current = readStandaloneDiagnostics();
    if (
      current.conversationKey &&
      current.conversationKey !== before.conversationKey
    )
      return current;
    await Zotero.Promise.delay(50);
  }
  throw new Error("New standalone conversation did not become ready");
}

async function seedStandaloneUserMessage(
  text: string,
): Promise<WorkflowTestStandaloneDiagnostics> {
  assertWorkflowTestEnabled();
  const { contentArea, item } = await ensureStandaloneWorkflowPanelReady();
  const conversationKey = getConversationKey(item);
  if (!conversationKey) {
    throw new Error("Standalone workflow panel has no active conversation key");
  }
  const message = {
    role: "user" as const,
    text,
    timestamp: Date.now(),
  };
  const conversationSystem =
    (contentArea.querySelector("#llm-main") as HTMLElement | null)?.dataset
      .conversationSystem || "upstream";
  try {
    await appendWorkflowStoredMessage(
      conversationSystem === "codex" || conversationSystem === "claude_code"
        ? conversationSystem
        : "upstream",
      conversationKey,
      message,
    );
  } catch (error) {
    throw new Error(
      `Standalone workflow seed failed (${text}) for key ${conversationKey}: ${String(
        (error as Error)?.message || error,
      )}`,
    );
  }
  chatHistory.set(conversationKey, [message]);
  loadedConversationKeys.add(conversationKey);
  refreshChat(contentArea, item);
  await Zotero.Promise.delay(150);
  return readStandaloneDiagnostics();
}

async function seedStandaloneConversation(
  turns: Array<{ role: "user" | "assistant"; text: string } & Partial<Message>>,
): Promise<WorkflowTestStandaloneDiagnostics> {
  assertWorkflowTestEnabled();
  const doc = await waitForStandaloneReady();
  const contentArea = doc.querySelector(
    ".llm-standalone-content",
  ) as HTMLElement | null;
  const item = contentArea
    ? activeContextPanels.get(contentArea)?.() || null
    : null;
  if (!contentArea || !item) {
    throw new Error("Standalone workflow chat panel is not mounted");
  }
  const conversationKey = getConversationKey(item);
  const baseTimestamp = Date.now() - turns.length;
  const messages: Message[] = turns.map((turn, index) => ({
    ...turn,
    timestamp: turn.timestamp ?? baseTimestamp + index,
  }));
  const conversationSystem =
    (contentArea.querySelector("#llm-main") as HTMLElement | null)?.dataset
      .conversationSystem || "upstream";
  const storedSystem =
    conversationSystem === "codex" || conversationSystem === "claude_code"
      ? conversationSystem
      : "upstream";
  for (const message of messages) {
    // Persist only the plain turn shape; volatile streaming/trace fields are
    // session-only presentation state and stay in chatHistory.
    await appendWorkflowStoredMessage(storedSystem, conversationKey, {
      role: message.role,
      text: message.text,
      timestamp: message.timestamp,
    });
  }
  chatHistory.set(conversationKey, messages);
  loadedConversationKeys.add(conversationKey);
  refreshChat(contentArea, item);
  await Zotero.Promise.delay(200);
  return readStandaloneDiagnostics();
}

async function resizeStandaloneWindow(
  width: number,
  height: number,
): Promise<{ innerWidth: number; innerHeight: number }> {
  assertWorkflowTestEnabled();
  await waitForStandaloneReady();
  const win = getStandaloneWindowForTest();
  if (!win) throw new Error("Standalone window is not open");
  win.resizeBy(width - win.innerWidth, height - win.innerHeight);
  await Zotero.Promise.delay(400);
  return { innerWidth: win.innerWidth, innerHeight: win.innerHeight };
}

async function captureStandaloneScreenshot(filePath: string): Promise<string> {
  assertWorkflowTestEnabled();
  await waitForStandaloneReady();
  const win = getStandaloneWindowForTest();
  if (!win) throw new Error("Standalone window is not open");
  const doc = win.document;
  const width = Math.ceil(win.innerWidth);
  const height = Math.ceil(win.innerHeight);
  const scale = Number(win.devicePixelRatio) || 1;
  const canvas = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "canvas",
  ) as HTMLCanvasElement;
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext("2d") as
    | (CanvasRenderingContext2D & {
        drawWindow?: (
          win: Window,
          x: number,
          y: number,
          w: number,
          h: number,
          bg: string,
        ) => void;
      })
    | null;
  if (!ctx || typeof ctx.drawWindow !== "function") {
    throw new Error("drawWindow is unavailable in this build");
  }
  ctx.scale(scale, scale);
  ctx.drawWindow(win, 0, 0, width, height, "#1e1e1e");
  const dataUrl = canvas.toDataURL("image/png");
  const base64 = dataUrl.split(",")[1] || "";
  const binary = win.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  const ioUtils = (
    globalThis as unknown as {
      IOUtils?: {
        write?: (path: string, data: Uint8Array) => Promise<unknown>;
      };
    }
  ).IOUtils;
  if (!ioUtils?.write) throw new Error("IOUtils.write is unavailable");
  await ioUtils.write(filePath, bytes);
  return filePath;
}

async function notifyStandaloneItemChanged(
  itemId: number | null,
): Promise<WorkflowTestStandaloneDiagnostics> {
  assertWorkflowTestEnabled();
  const item = itemId ? Zotero.Items.get(itemId) || null : null;
  if (itemId && !item) throw new Error(`Unable to find Zotero item ${itemId}`);
  if (itemId) {
    await selectZoteroItemForWorkflow(itemId).catch(() => undefined);
  }
  notifyStandaloneItemChangedRuntime(item);
  await Zotero.Promise.delay(250);
  return readStandaloneDiagnostics();
}

async function notifyStandaloneItemChanges(
  itemIds: number[],
): Promise<WorkflowTestStandaloneDiagnostics> {
  assertWorkflowTestEnabled();
  const items = itemIds.map((itemId) => Zotero.Items.get(itemId) || null);
  const missingIndex = items.findIndex((item) => !item);
  if (missingIndex >= 0) {
    throw new Error(`Unable to find Zotero item ${itemIds[missingIndex]}`);
  }
  for (const item of items) {
    notifyStandaloneItemChangedRuntime(item);
  }
  await Zotero.Promise.delay(500);
  return readStandaloneDiagnostics();
}

async function addItemsAsStandaloneContext(
  itemIds: number[],
): Promise<WorkflowTestStandaloneDiagnostics> {
  assertWorkflowTestEnabled();
  const items = itemIds.map((itemId) => Zotero.Items.get(itemId) || null);
  const missingIndex = items.findIndex((item) => !item);
  if (missingIndex >= 0) {
    throw new Error(`Unable to find Zotero item ${itemIds[missingIndex]}`);
  }
  await dispatchZoteroItemsAsContext(items as Zotero.Item[], {
    openStandaloneChat,
  });
  await waitForStandaloneReady();
  await Zotero.Promise.delay(300);
  return readStandaloneDiagnostics();
}

async function closeStandalone(): Promise<void> {
  assertWorkflowTestEnabled();
  const win = getStandaloneWindowReferenceForTest();
  if (win && !win.closed) {
    win.close();
  }
  const startedAt = Date.now();
  while (
    getStandaloneWindowReferenceForTest() &&
    Date.now() - startedAt < 3000
  ) {
    await Zotero.Promise.delay(25);
  }
}

async function getDiagnostics(
  panelId?: string,
): Promise<WorkflowTestDiagnostics> {
  const panel = panelId ? panels.get(panelId) : undefined;
  const body = panel?.body;
  const panelRoot = body?.querySelector("#llm-main") as HTMLElement | null;
  const mountedItem = body
    ? activeContextPanels.get(body)?.() || panel?.item
    : panel?.item;
  const historyNewBtn = body?.querySelector(
    "#llm-history-new",
  ) as HTMLElement | null;
  const historyToggleBtn = body?.querySelector(
    "#llm-history-toggle",
  ) as HTMLElement | null;
  const chatBox = body?.querySelector("#llm-chat-box") as HTMLElement | null;
  const statusBar = body?.querySelector(
    ".llm-status-bar",
  ) as HTMLElement | null;
  const permissionControl = body?.querySelector(
    "#llm-permission-control",
  ) as HTMLElement | null;
  const permissionButton = body?.querySelector(
    "#llm-permission-toggle",
  ) as HTMLElement | null;
  const statusLine = body?.querySelector("#llm-status") as HTMLElement | null;
  const contextGauge = body?.querySelector(
    "#llm-context-gauge",
  ) as HTMLElement | null;
  const panelWin = body?.ownerDocument.defaultView;
  const statusBarStyle =
    panelWin && statusBar ? panelWin.getComputedStyle(statusBar) : null;
  const permissionControlStyle =
    panelWin && permissionControl
      ? panelWin.getComputedStyle(permissionControl)
      : null;
  const permissionButtonStyle =
    panelWin && permissionButton
      ? panelWin.getComputedStyle(permissionButton)
      : null;
  const statusLineStyle =
    panelWin && statusLine ? panelWin.getComputedStyle(statusLine) : null;
  const panelRootStyle =
    panelWin && panelRoot ? panelWin.getComputedStyle(panelRoot) : null;
  const contextGaugeStyle =
    panelWin && contextGauge ? panelWin.getComputedStyle(contextGauge) : null;
  const contextGaugeInnerStyle =
    panelWin && contextGauge
      ? panelWin.getComputedStyle(contextGauge, "::after")
      : null;
  return {
    panelId,
    activeItemId: parsePositiveInt(mountedItem?.id),
    conversationKey: mountedItem ? getConversationKey(mountedItem) : undefined,
    panelConversationKey: parsePositiveInt(panelRoot?.dataset.itemId),
    conversationKind: panelRoot?.dataset.conversationKind || undefined,
    runtimeMode: panelRoot?.dataset.runtimeMode || undefined,
    conversationSystem: panelRoot?.dataset.conversationSystem || undefined,
    noteId: parsePositiveInt(panelRoot?.dataset.noteId),
    noteKind: panelRoot?.dataset.noteKind || undefined,
    noteParentItemId: parsePositiveInt(panelRoot?.dataset.noteParentItemId),
    contextSnapshot: panel?.contextSnapshot,
    chipText: Array.from(
      body?.querySelectorAll(
        "#llm-paper-context-preview .llm-paper-context-chip > .llm-paper-context-chip-header .llm-paper-context-chip-text",
      ) || [],
    ).map((node) => ((node as Element).textContent || "").trim()),
    composerPaperContextKeys: Array.from(
      body?.querySelectorAll(
        "#llm-paper-context-preview .llm-paper-context-chip",
      ) || [],
    ).map((node) => {
      const chip = node as HTMLElement;
      return `${chip.dataset.paperItemId}:${chip.dataset.paperContextItemId}`;
    }),
    selectedContextLabels: Array.from(
      body?.querySelectorAll(".llm-selected-context-meta") || [],
    ).map((node) => ((node as Element).textContent || "").trim()),
    composerCollectionLabels: Array.from(
      body?.querySelectorAll(
        "#llm-paper-context-preview .llm-collection-chip-title",
      ) || [],
    ).map((node) => ((node as Element).textContent || "").trim()),
    composerTagLabels: Array.from(
      body?.querySelectorAll(
        "#llm-paper-context-preview .llm-tag-chip-title",
      ) || [],
    ).map((node) => ((node as Element).textContent || "").trim()),
    sentContextBadgeLabels: Array.from(
      body?.querySelectorAll("#llm-chat-box .llm-user-context-badges button") ||
        [],
    ).map((node) => ((node as Element).textContent || "").trim()),
    sentContextItemLabels: Array.from(
      body?.querySelectorAll("#llm-chat-box .llm-user-papers-item-title") || [],
    ).map((node) => ((node as Element).textContent || "").trim()),
    historyNewVisible: historyNewBtn
      ? historyNewBtn.style.display !== "none"
      : false,
    historyToggleVisible: historyToggleBtn
      ? historyToggleBtn.style.display !== "none"
      : false,
    runtimeSystemToggles: readRuntimeSystemToggles(
      body,
      ".llm-panel-runtime-system-controls",
    ),
    webChatMode: panelRoot?.dataset.webchatMode === "true",
    modelButtonDisabled: (
      body?.querySelector("#llm-model-toggle") as HTMLButtonElement | null
    )?.disabled,
    inputValue: (
      body?.querySelector("#llm-input") as HTMLTextAreaElement | null
    )?.value,
    statusText:
      (body?.querySelector("#llm-status") as HTMLElement | null)?.textContent ||
      undefined,
    startPageActive: panelRoot?.dataset.startPageActive === "true",
    statusBarVisible: Boolean(
      statusBarStyle &&
      statusBarStyle.display !== "none" &&
      statusBarStyle.visibility !== "hidden",
    ),
    permissionControlVisible: Boolean(
      permissionControlStyle &&
      permissionControlStyle.display !== "none" &&
      permissionControlStyle.visibility !== "hidden",
    ),
    permissionModeText: permissionButton?.textContent?.trim() || undefined,
    permissionModeFontSize: permissionButtonStyle?.fontSize,
    statusFontSize: statusLineStyle?.fontSize,
    contextGaugeWidth: contextGaugeStyle
      ? Number.parseFloat(contextGaugeStyle.width)
      : undefined,
    contextGaugeHeight: contextGaugeStyle
      ? Number.parseFloat(contextGaugeStyle.height)
      : undefined,
    contextGaugeInnerWidth: contextGaugeInnerStyle
      ? Number.parseFloat(contextGaugeInnerStyle.width)
      : undefined,
    contextGaugeInnerBackground: contextGaugeInnerStyle?.backgroundColor,
    panelBackground: panelRootStyle?.backgroundColor,
    tokenUsageText:
      (
        body?.querySelector("#llm-token-usage") as HTMLElement | null
      )?.textContent?.trim() || undefined,
    messageText: chatBox?.textContent?.trim() || undefined,
    lastSend,
    lastFinalRequest,
  };
}

function countWorkflowReaderSelectionListeners(
  readerAPI: ReaderSelectionTrackingReader<unknown>,
): number {
  return (readerAPI._registeredListeners || []).filter(
    (listener) =>
      listener.pluginID === config.addonID &&
      listener.type === READER_TEXT_SELECTION_POPUP_EVENT,
  ).length;
}

async function exerciseReaderSelectionTrackingRecovery(): Promise<WorkflowTestReaderSelectionTrackingDiagnostics> {
  assertWorkflowTestEnabled();
  const readerAPI = Zotero.Reader as ReaderSelectionTrackingReader<unknown>;
  if (!Array.isArray(readerAPI._registeredListeners)) {
    throw new Error("Zotero reader listener registry is unavailable");
  }

  const before = countWorkflowReaderSelectionListeners(readerAPI);
  readerAPI._registeredListeners = readerAPI._registeredListeners.filter(
    (listener) =>
      listener.pluginID !== config.addonID ||
      listener.type !== READER_TEXT_SELECTION_POPUP_EVENT,
  );
  const afterDrop = countWorkflowReaderSelectionListeners(readerAPI);
  const startedAt = Date.now();
  while (
    countWorkflowReaderSelectionListeners(readerAPI) === 0 &&
    Date.now() - startedAt < 2000
  ) {
    await Zotero.Promise.delay(25);
  }
  const afterHealthCheck = countWorkflowReaderSelectionListeners(readerAPI);
  const markerPresent = Boolean(readerAPI.__llmSelectionTracking);
  const markerLive = Boolean(
    readerAPI.__llmSelectionTracking &&
    (readerAPI._registeredListeners || []).some(
      (listener) =>
        listener.handler === readerAPI.__llmSelectionTracking?.handler,
    ),
  );
  const elapsedMs = Date.now() - startedAt;

  if (!afterHealthCheck) {
    ensureMarkedReaderSelectionTrackingListener(readerAPI);
  }
  return {
    before,
    afterDrop,
    afterHealthCheck,
    markerPresent,
    markerLive,
    elapsedMs,
  };
}

function findReaderForAttachment(
  readerApi: { _readers?: _ZoteroTypes.ReaderInstance[] },
  attachmentItemId: number,
): _ZoteroTypes.ReaderInstance | null {
  return (
    (readerApi._readers || []).find(
      (reader) =>
        Number(reader?._item?.id || reader?.itemID || 0) === attachmentItemId,
    ) || null
  );
}

async function openWorkflowPdfReader(
  attachmentItemId: number,
  pageIndex: number,
): Promise<_ZoteroTypes.ReaderInstance> {
  const readerApi = Zotero.Reader as unknown as {
    _readers?: _ZoteroTypes.ReaderInstance[];
    open?: (
      itemId: number,
      location?: _ZoteroTypes.Reader.Location,
    ) => Promise<void | _ZoteroTypes.ReaderInstance>;
  };
  if (typeof readerApi.open !== "function") {
    throw new Error("Zotero.Reader.open is unavailable");
  }
  const opened = await readerApi.open(attachmentItemId, { pageIndex });
  const startedAt = Date.now();
  let reader =
    opened &&
    Number(opened?._item?.id || opened?.itemID || 0) === attachmentItemId
      ? opened
      : findReaderForAttachment(readerApi, attachmentItemId);
  while (!reader && Date.now() - startedAt < 10_000) {
    await Zotero.Promise.delay(25);
    reader = findReaderForAttachment(readerApi, attachmentItemId);
  }
  if (!reader) {
    throw new Error(
      `Timed out opening workflow PDF reader ${attachmentItemId}`,
    );
  }
  await reader._initPromise;
  if (typeof reader.navigate === "function") {
    await reader.navigate({ pageIndex });
  }
  return reader;
}

function findSelectionRangeOnPage(params: {
  reader: _ZoteroTypes.ReaderInstance;
  pageIndex: number;
  selectedText: string;
}): { doc: Document; range: Range } | null {
  const pageNumber = params.pageIndex + 1;
  for (const doc of collectReaderSelectionDocuments(params.reader)) {
    const pages = Array.from(
      doc.querySelectorAll(
        `.page[data-page-number="${pageNumber}"], .page[data-page-index="${params.pageIndex}"], [data-page-number="${pageNumber}"], [data-page-index="${params.pageIndex}"]`,
      ),
    ) as Element[];
    for (const page of pages) {
      if (!page.textContent?.includes(params.selectedText)) continue;
      const walker = doc.createTreeWalker(page, 4);
      let node = walker.nextNode();
      while (node) {
        const value = node.nodeValue || "";
        const start = value.indexOf(params.selectedText);
        if (start >= 0) {
          const range = doc.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + params.selectedText.length);
          return { doc, range };
        }
        node = walker.nextNode();
      }
    }
  }
  return null;
}

async function selectWorkflowPdfText(params: {
  reader: _ZoteroTypes.ReaderInstance;
  pageIndex: number;
  selectedText: string;
}): Promise<{ doc: Document; range: Range }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const match = findSelectionRangeOnPage(params);
    if (match) {
      const selection = match.doc.defaultView?.getSelection?.();
      selection?.removeAllRanges();
      selection?.addRange(match.range);
      if (selection?.toString().includes(params.selectedText)) return match;
    }
    await Zotero.Promise.delay(50);
  }
  const documents = collectReaderSelectionDocuments(params.reader).map(
    (doc) => ({
      url: doc.URL,
      textLength: doc.body?.textContent?.length || 0,
      containsSelection: Boolean(
        doc.body?.textContent?.includes(params.selectedText),
      ),
      pageNumbers: (
        Array.from(doc.querySelectorAll("[data-page-number]")) as Element[]
      )
        .slice(0, 10)
        .map((node) => node.getAttribute("data-page-number")),
      pageIndexes: (
        Array.from(doc.querySelectorAll("[data-page-index]")) as Element[]
      )
        .slice(0, 10)
        .map((node) => node.getAttribute("data-page-index")),
    }),
  );
  throw new Error(
    `Timed out selecting workflow PDF text on page ${params.pageIndex + 1}: ${JSON.stringify(
      documents,
    )}`,
  );
}

async function waitForSelectedContext(params: {
  conversationKey: number;
  selectedText: string;
  pageIndex: number;
}): Promise<ReturnType<typeof getSelectedTextContextEntries>[number]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const match = getSelectedTextContextEntries(params.conversationKey).find(
      (context) =>
        context.text === params.selectedText &&
        context.pageIndex === params.pageIndex,
    );
    if (match) return match;
    await Zotero.Promise.delay(25);
  }
  throw new Error(
    "Timed out waiting for Add Text to preserve the page locator",
  );
}

async function waitForFinalRequest(
  body: HTMLElement,
): Promise<WorkflowTestFinalRequestSnapshot> {
  const startedAt = Date.now();
  while (!lastFinalRequest) {
    if (Date.now() - startedAt > 15_000) {
      const status = body.querySelector("#llm-status")?.textContent?.trim();
      throw new Error(
        `Timed out waiting for final workflow model request; status=${status || "<empty>"}`,
      );
    }
    await Zotero.Promise.delay(25);
  }
  return lastFinalRequest;
}

async function closeWorkflowReader(
  reader: _ZoteroTypes.ReaderInstance,
): Promise<void> {
  try {
    const tabs = (
      Zotero as unknown as {
        Tabs?: { close?: (tabId: string) => Promise<unknown> | unknown };
      }
    ).Tabs;
    if (reader.tabID && typeof tabs?.close === "function") {
      await tabs.close(reader.tabID);
    }
  } catch (_error) {
    void _error;
  }
}

async function dispatchWorkflowReaderAddTextPopup(input: {
  reader: _ZoteroTypes.ReaderInstance;
  pageIndex: number;
  selectedText: string;
}): Promise<{
  addTextButtonLabel: string;
  popupHost: HTMLElement;
  selectionDoc: Document;
}> {
  const selected = await selectWorkflowPdfText(input);
  const popupHost = selected.doc.createElement("div");
  popupHost.dataset.workflowAddTextPopup = "true";
  (selected.doc.body || selected.doc.documentElement).appendChild(popupHost);

  const readerApi = Zotero.Reader as unknown as ReaderSelectionTrackingReader<
    _ZoteroTypes.Reader.EventHandler<"renderTextSelectionPopup">
  >;
  const handler = readerApi.__llmSelectionTracking?.handler;
  if (!handler) {
    popupHost.remove();
    throw new Error("Add Text reader selection handler is unavailable");
  }
  await handler({
    reader: input.reader,
    doc: selected.doc,
    params: {
      annotation: {
        text: input.selectedText,
        position: { pageIndex: input.pageIndex },
      } as any,
    },
    append: (node: Node | string) => popupHost.append(node),
    type: READER_TEXT_SELECTION_POPUP_EVENT,
  });
  const addTextButton = (
    Array.from(popupHost.querySelectorAll("button")) as HTMLButtonElement[]
  ).find((button) => button.textContent?.trim() === "Add Text");
  if (!addTextButton) {
    popupHost.remove();
    throw new Error("Add Text button was not rendered in the reader popup");
  }
  const PointerEventCtor = selected.doc.defaultView?.MouseEvent;
  if (!PointerEventCtor) {
    popupHost.remove();
    throw new Error("Workflow reader window does not expose MouseEvent");
  }
  addTextButton.dispatchEvent(
    new PointerEventCtor("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    }),
  );
  return {
    addTextButtonLabel: addTextButton.textContent?.trim() || "",
    popupHost,
    selectionDoc: selected.doc,
  };
}

async function exerciseReaderPopupActiveTabRouting(input: {
  firstPanelId: string;
  firstAttachmentItemId: number;
  secondPanelId: string;
  secondAttachmentItemId: number;
  pageIndex: number;
  selectedText: string;
}): Promise<WorkflowTestReaderPopupRoutingDiagnostics> {
  assertWorkflowTestEnabled();
  const firstPanel = getPanel(input.firstPanelId);
  const secondPanel = getPanel(input.secondPanelId);
  const firstReader = await openWorkflowPdfReader(
    input.firstAttachmentItemId,
    0,
  );
  let secondReader: _ZoteroTypes.ReaderInstance | null = null;
  let popupHost: HTMLElement | null = null;
  let selectionDoc: Document | null = null;
  try {
    secondReader = await openWorkflowPdfReader(
      input.secondAttachmentItemId,
      input.pageIndex,
    );
    const mainDocument = Zotero.getMainWindow?.()?.document || null;
    const firstReaderPanel = mainDocument
      ? getReaderContextPanelForTab(mainDocument, firstReader.tabID)
      : null;
    const secondReaderPanel = mainDocument
      ? getReaderContextPanelForTab(mainDocument, secondReader.tabID)
      : null;
    if (!firstReaderPanel || !secondReaderPanel) {
      throw new Error("Workflow reader tabs do not expose distinct panels");
    }
    firstReaderPanel.appendChild(firstPanel.body);
    secondReaderPanel.appendChild(secondPanel.body);

    const popupAction = await dispatchWorkflowReaderAddTextPopup({
      reader: secondReader,
      pageIndex: input.pageIndex,
      selectedText: input.selectedText,
    });
    selectionDoc = popupAction.selectionDoc;
    popupHost = popupAction.popupHost;

    const secondItem =
      activeContextPanels.get(secondPanel.body)?.() || secondPanel.item;
    await waitForSelectedContext({
      conversationKey: getConversationKey(secondItem),
      selectedText: input.selectedText,
      pageIndex: input.pageIndex,
    });
    const firstItem =
      activeContextPanels.get(firstPanel.body)?.() || firstPanel.item;
    return {
      firstReaderTabId: `${firstReader.tabID || ""}`,
      secondReaderTabId: `${secondReader.tabID || ""}`,
      addTextButtonLabel: popupAction.addTextButtonLabel,
      firstConversationHasText: getSelectedTextContextEntries(
        getConversationKey(firstItem),
      ).some((context) => context.text === input.selectedText),
      secondConversationHasText: getSelectedTextContextEntries(
        getConversationKey(secondItem),
      ).some((context) => context.text === input.selectedText),
    };
  } finally {
    selectionDoc?.defaultView?.getSelection?.()?.removeAllRanges();
    popupHost?.remove();
    if (secondReader) await closeWorkflowReader(secondReader);
    await closeWorkflowReader(firstReader);
  }
}

async function exerciseReaderPopupStandaloneRouting(input: {
  attachmentItemId: number;
  pageIndex: number;
  selectedText: string;
}): Promise<WorkflowTestReaderPopupStandaloneRoutingDiagnostics> {
  assertWorkflowTestEnabled();
  const standaloneDoc = await waitForStandaloneReady();
  const standaloneBody = standaloneDoc.querySelector(
    ".llm-standalone-content",
  ) as HTMLElement | null;
  const standaloneItem = standaloneBody
    ? activeContextPanels.get(standaloneBody)?.() || null
    : null;
  if (!standaloneBody || !standaloneItem) {
    throw new Error("Standalone workflow chat panel is not mounted");
  }
  const standaloneConversationKey = getConversationKey(standaloneItem);
  const reader = await openWorkflowPdfReader(
    input.attachmentItemId,
    input.pageIndex,
  );
  let popupHost: HTMLElement | null = null;
  let selectionDoc: Document | null = null;
  try {
    const popupAction = await dispatchWorkflowReaderAddTextPopup({
      reader,
      pageIndex: input.pageIndex,
      selectedText: input.selectedText,
    });
    popupHost = popupAction.popupHost;
    selectionDoc = popupAction.selectionDoc;
    await waitForSelectedContext({
      conversationKey: standaloneConversationKey,
      selectedText: input.selectedText,
      pageIndex: input.pageIndex,
    });
    await Zotero.Promise.delay(25);

    return {
      readerTabId: `${reader.tabID || ""}`,
      addTextButtonLabel: popupAction.addTextButtonLabel,
      standaloneConversationKey,
      standaloneConversationHasText: getSelectedTextContextEntries(
        standaloneConversationKey,
      ).some((context) => context.text === input.selectedText),
      standalonePreviewHasText: Array.from(
        standaloneBody.querySelectorAll(".llm-selected-context-text"),
      ).some((node) => node?.textContent?.trim() === input.selectedText),
    };
  } finally {
    selectionDoc?.defaultView?.getSelection?.()?.removeAllRanges();
    popupHost?.remove();
    await closeWorkflowReader(reader);
  }
}

async function exerciseHighlightAwareContextRetrieval(input: {
  panelId: string;
  attachmentItemId: number;
  pageIndex: number;
  selectedText: string;
  question: string;
  trigger: "popup" | "action-bar";
}): Promise<WorkflowTestHighlightAwareRetrievalDiagnostics> {
  assertWorkflowTestEnabled();
  const panel = getPanel(input.panelId);
  const reader = await openWorkflowPdfReader(
    input.attachmentItemId,
    input.pageIndex,
  );
  let popupHost: HTMLElement | null = null;
  let selectionDoc: Document | null = null;
  try {
    const mainDocument = Zotero.getMainWindow?.()?.document || null;
    const readerPanel = mainDocument
      ? getReaderContextPanelForTab(mainDocument, reader.tabID)
      : null;
    if (!readerPanel) {
      throw new Error("Workflow reader tab does not expose a context panel");
    }
    readerPanel.appendChild(panel.body);
    const selected = await selectWorkflowPdfText({
      reader,
      pageIndex: input.pageIndex,
      selectedText: input.selectedText,
    });
    selectionDoc = selected.doc;
    let clickedAt = 0;
    let addTextButtonLabel = "";
    if (input.trigger === "popup") {
      popupHost = selected.doc.createElement("div");
      popupHost.dataset.workflowAddTextPopup = "true";
      (selected.doc.body || selected.doc.documentElement).appendChild(
        popupHost,
      );

      const readerApi =
        Zotero.Reader as unknown as ReaderSelectionTrackingReader<
          _ZoteroTypes.Reader.EventHandler<"renderTextSelectionPopup">
        >;
      const handler = readerApi.__llmSelectionTracking?.handler;
      if (!handler) {
        throw new Error("Add Text reader selection handler is unavailable");
      }
      await handler({
        reader,
        doc: selected.doc,
        params: {
          annotation: { text: input.selectedText } as any,
        },
        append: (node: Node | string) => popupHost?.append(node),
        type: READER_TEXT_SELECTION_POPUP_EVENT,
      });
      const addTextButton = (
        Array.from(popupHost.querySelectorAll("button")) as HTMLButtonElement[]
      ).find((button) => button.textContent?.trim() === "Add Text");
      if (!addTextButton) {
        throw new Error("Add Text button was not rendered in the reader popup");
      }
      addTextButtonLabel = addTextButton.textContent?.trim() || "";
      const PointerEventCtor = selected.doc.defaultView?.MouseEvent;
      if (!PointerEventCtor) {
        throw new Error("Workflow reader window does not expose MouseEvent");
      }
      clickedAt = Date.now();
      addTextButton.dispatchEvent(
        new PointerEventCtor("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    } else {
      const addTextButton = panel.body.querySelector(
        "#llm-select-text",
      ) as HTMLButtonElement | null;
      if (!addTextButton) {
        throw new Error("Include selected text action was not rendered");
      }
      addTextButtonLabel = addTextButton.getAttribute("aria-label") || "";
      const MouseEventCtor =
        addTextButton.ownerDocument.defaultView?.MouseEvent;
      if (!MouseEventCtor) {
        throw new Error("Workflow panel window does not expose MouseEvent");
      }
      clickedAt = Date.now();
      addTextButton.dispatchEvent(
        new MouseEventCtor("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
      addTextButton.dispatchEvent(
        new MouseEventCtor("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    }
    const immediatePreviewText =
      panel.body
        .querySelector(".llm-selected-context-text")
        ?.textContent?.trim() || "";

    const mountedItem = activeContextPanels.get(panel.body)?.() || panel.item;
    const selectedContext = await waitForSelectedContext({
      conversationKey: getConversationKey(mountedItem),
      selectedText: input.selectedText,
      pageIndex: input.pageIndex,
    });
    const clickToSelectedContextMs = Date.now() - clickedAt;

    lastSend = null;
    lastFinalRequest = null;
    setWorkflowTestSendInterceptor((opts) => {
      opts.apiBase = "http://127.0.0.1:9/v1";
      opts.apiKey = "workflow-test-key";
      opts.authMode = "api_key";
      lastSend = opts;
      return true;
    });
    setWorkflowTestFinalRequestInterceptor((snapshot) => {
      lastFinalRequest = snapshot;
      return true;
    });
    const capturedSend = await ask(input.panelId, input.question);
    const finalRequest = await waitForFinalRequest(panel.body);
    const resolvedAnchor = capturedSend.resolvedSelectedTextAnchors?.find(
      (anchor) => anchor.contextItemId === input.attachmentItemId,
    );
    if (!resolvedAnchor) {
      throw new Error("Final send did not include a resolved highlight anchor");
    }
    return {
      trigger: input.trigger,
      readerItemId: Number(reader._item?.id || reader.itemID || 0),
      addTextButtonLabel,
      immediatePreviewText,
      clickToSelectedContextMs,
      selectedContext,
      resolvedAnchor,
      lastSend: capturedSend,
      lastFinalRequest: finalRequest,
    };
  } finally {
    setWorkflowTestSendInterceptor((opts) => {
      lastSend = opts;
    });
    setWorkflowTestFinalRequestInterceptor((snapshot) => {
      lastFinalRequest = snapshot;
    });
    selectionDoc?.defaultView?.getSelection?.()?.removeAllRanges();
    popupHost?.remove();
    await closeWorkflowReader(reader);
  }
}

async function reset(): Promise<void> {
  assertWorkflowTestEnabled();
  resolveDelayedCodexPermissionCatalog?.();
  resolveDelayedCodexPermissionCatalog = null;
  setFooterPermissionCatalogLoadersForTests();
  setAgentRunTraceLoaderForTests();
  await closeStandalone();
  lastSend = null;
  lastFinalRequest = null;
  disposeWorkflowPanels();
  clearWorkflowConversationRuntimeState();
  await clearPaperRestoreTargetsForWorkflowTests();
  const userLibraryID = Math.floor(
    Number(Zotero.Libraries?.userLibraryID || 0),
  );
  if (userLibraryID > 0) {
    removeLastUsedUpstreamConversationMode(userLibraryID);
    removeLastUsedUpstreamGlobalConversationKey(userLibraryID);
  }
  // Workflow cases use fresh Zotero items but the isolated runner can retain
  // the same numeric item IDs across process launches.  Clear persisted
  // paper-selection maps at the test boundary so a stale preference from an
  // earlier run cannot steer a new fixture into an unrelated conversation.
  for (const prefKey of [
    "lastUsedPaperConversationMap",
    "claudeCodePaperConversationMap",
    "codexAppServerPaperConversationMap",
  ]) {
    Zotero.Prefs.clear?.(`${config.prefsPrefix}.${prefKey}`, true);
  }
  setWorkflowTestSendInterceptor((opts) => {
    lastSend = opts;
  });
  setWorkflowTestFinalRequestInterceptor((snapshot) => {
    lastFinalRequest = snapshot;
  });
  forcePendingTurnFinalizeFailuresForTests(0);
}

function disposeWorkflowPanels(): void {
  for (const panel of panels.values()) {
    disposeSetupHandlers(panel.body);
    activeContextPanels.delete(panel.body);
    activeContextPanelRawItems.delete(panel.body);
    panel.body.remove();
  }
  panels.clear();
}

function isHistoryMenuPopulated(body: HTMLElement | Element): boolean {
  const menu = body.querySelector("#llm-history-menu") as HTMLElement | null;
  if (!menu || menu.style.display === "none") return false;
  return Boolean(
    menu.querySelector(".llm-history-item[data-conversation-key]") ||
    menu.querySelector(".llm-history-menu-empty"),
  );
}

async function openPanelHistoryMenu(panelId: string): Promise<HTMLElement> {
  const panel = getPanel(panelId);
  const menu = panel.body.querySelector(
    "#llm-history-menu",
  ) as HTMLElement | null;
  if (!(menu && menu.style.display !== "none")) {
    dispatchWorkflowClick(panel.body, "#llm-history-toggle", "History toggle");
  }
  // The menu renders after several async DB loads; a fixed 200ms delay was
  // flaky under load. Wait for rows (or the explicit empty marker) instead.
  const deadline = Date.now() + 8000;
  while (!isHistoryMenuPopulated(panel.body) && Date.now() < deadline) {
    await Zotero.Promise.delay(50);
  }
  return panel.body;
}

async function listPanelHistory(
  panelId: string,
): Promise<WorkflowTestHistoryRow[]> {
  assertWorkflowTestEnabled();
  const body = await openPanelHistoryMenu(panelId);
  const rows = Array.from(
    body.querySelectorAll(".llm-history-item[data-conversation-key]"),
  ) as HTMLElement[];
  const seen = new Map<number, WorkflowTestHistoryRow>();
  for (const row of rows) {
    const conversationKey = Number(row.dataset.conversationKey || 0);
    if (!conversationKey) continue;
    seen.set(conversationKey, {
      conversationKey,
      title: (row.textContent || "").trim(),
    });
  }
  return Array.from(seen.values());
}

async function deletePanelHistoryConversation(
  panelId: string,
  conversationKey: number,
): Promise<void> {
  assertWorkflowTestEnabled();
  const body = await openPanelHistoryMenu(panelId);
  const rowSelector = `.llm-history-item[data-conversation-key="${conversationKey}"]`;
  // The menu may still be re-rendering after recent conversation changes;
  // poll for the specific row instead of failing on the first paint.
  const deadline = Date.now() + 8000;
  let row = body.querySelector(rowSelector) as HTMLElement | null;
  while (!row && Date.now() < deadline) {
    await Zotero.Promise.delay(50);
    row = body.querySelector(rowSelector) as HTMLElement | null;
  }
  if (!row) {
    const menu = body.querySelector("#llm-history-menu") as HTMLElement | null;
    const renderedKeys = Array.from(
      body.querySelectorAll(".llm-history-item[data-conversation-key]"),
    ).map((el) => (el as HTMLElement).dataset.conversationKey);
    throw new Error(
      `History row ${conversationKey} not rendered; menuDisplay=${menu?.style.display}, renderedKeys=[${renderedKeys.join(",")}], menuTextSample=${(menu?.textContent || "").slice(0, 160)}`,
    );
  }
  const deleteBtn = row.querySelector(
    ".llm-history-item-delete",
  ) as HTMLElement | null;
  if (!deleteBtn) throw new Error(`Row ${conversationKey} is not deletable`);
  const eventCtor = body.ownerDocument.defaultView?.MouseEvent || MouseEvent;
  deleteBtn.dispatchEvent(
    new eventCtor("click", { bubbles: true, cancelable: true }),
  );
  await Zotero.Promise.delay(300);
}

async function clickPanelDelete(panelId: string): Promise<void> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const itemBefore = activeContextPanels.get(panel.body)?.() || panel.item;
  const conversationKeyBefore = getConversationKey(itemBefore);
  dispatchWorkflowClick(
    panel.body,
    ".llm-clear-btn",
    "Delete conversation button",
  );

  // The header trash action queues the same deletion used by history.
  // Wait for this mounted surface to leave the doomed key and render the fresh
  // empty conversation selected by the shared deletion subscriber.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const currentItem = activeContextPanels.get(panel.body)?.() || panel.item;
    const currentKey = getConversationKey(currentItem);
    if (
      currentKey !== conversationKeyBefore &&
      pendingDeletionStore.isConversationPendingDeletion(
        conversationKeyBefore,
      ) &&
      panel.body.querySelectorAll(".llm-message-wrapper").length === 0
    ) {
      return;
    }
    await Zotero.Promise.delay(50);
  }
  const currentItem = activeContextPanels.get(panel.body)?.() || panel.item;
  throw new Error(
    `Delete did not render the empty replacement for conversation ${conversationKeyBefore}; current=${getConversationKey(currentItem)}, visibleMessages=${panel.body.querySelectorAll(".llm-message-wrapper").length}`,
  );
}

async function exercisePanelDeleteDuringPendingSend(
  panelId: string,
  text: string,
): Promise<WorkflowTestPendingSendDeleteResult> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const mountedItem = activeContextPanels.get(panel.body)?.() || panel.item;
  const conversationKeyBefore = getConversationKey(mountedItem);
  if (!conversationKeyBefore) {
    throw new Error("Workflow panel has no active conversation key");
  }

  const input = panel.body.querySelector(
    "#llm-input",
  ) as HTMLTextAreaElement | null;
  const sendBtn = panel.body.querySelector(
    "#llm-send",
  ) as HTMLButtonElement | null;
  if (!input || !sendBtn) {
    throw new Error("Workflow panel composer was not rendered");
  }

  lastSend = null;
  lastFinalRequest = null;
  const sendSettledSequenceBefore = getWorkflowTestSendSettledSequence();
  let finalRequestReached = false;
  let releaseFinalRequest: () => void = () => {};
  const finalRequestGate = new Promise<void>((resolve) => {
    releaseFinalRequest = resolve;
  });
  setWorkflowTestSendInterceptor((opts) => {
    opts.apiBase = "http://127.0.0.1:9/v1";
    opts.apiKey = "workflow-test-key";
    opts.authMode = "api_key";
    lastSend = opts;
    return true;
  });
  setWorkflowTestFinalRequestInterceptor(async (snapshot) => {
    lastFinalRequest = snapshot;
    finalRequestReached = true;
    await finalRequestGate;
    return true;
  });

  try {
    input.value = text;
    const eventCtor = panel.body.ownerDocument.defaultView?.Event ?? Event;
    input.dispatchEvent(new eventCtor("input", { bubbles: true }));
    sendBtn.click();

    const pendingDeadline = Date.now() + 10_000;
    while (
      (!finalRequestReached || !isRequestPending(conversationKeyBefore)) &&
      Date.now() < pendingDeadline
    ) {
      await Zotero.Promise.delay(25);
    }
    const requestPendingBeforeClick = isRequestPending(conversationKeyBefore);
    if (!finalRequestReached || !requestPendingBeforeClick) {
      throw new Error(
        `Workflow send did not reach a pending provider boundary: ${JSON.stringify(
          {
            finalRequestReached,
            requestPendingBeforeClick,
            diagnostics: await getDiagnostics(panelId),
          },
        )}`,
      );
    }

    dispatchWorkflowClick(
      panel.body,
      ".llm-clear-btn",
      "Delete conversation button",
    );

    const decisionDeadline = Date.now() + 3_000;
    let diagnostics = await getDiagnostics(panelId);
    let pendingDeletionQueued =
      pendingDeletionStore.isConversationPendingDeletion(conversationKeyBefore);
    while (
      diagnostics.conversationKey === conversationKeyBefore &&
      !pendingDeletionQueued &&
      !String(diagnostics.statusText || "").includes(
        "Cannot delete while generating",
      ) &&
      Date.now() < decisionDeadline
    ) {
      await Zotero.Promise.delay(25);
      diagnostics = await getDiagnostics(panelId);
      pendingDeletionQueued =
        pendingDeletionStore.isConversationPendingDeletion(
          conversationKeyBefore,
        );
    }

    return {
      conversationKeyBefore,
      conversationKeyAfter: diagnostics.conversationKey,
      requestPendingBeforeClick,
      requestPendingAfterClick: isRequestPending(conversationKeyBefore),
      pendingDeletionQueued,
      statusText: diagnostics.statusText || "",
    };
  } finally {
    releaseFinalRequest();
    const settledDeadline = Date.now() + 10_000;
    while (
      getWorkflowTestSendSettledSequence() <= sendSettledSequenceBefore &&
      Date.now() < settledDeadline
    ) {
      await Zotero.Promise.delay(25);
    }
    setWorkflowTestSendInterceptor((opts) => {
      lastSend = opts;
    });
    setWorkflowTestFinalRequestInterceptor((snapshot) => {
      lastFinalRequest = snapshot;
    });
  }
}

async function seedPanelStoredTurn(
  panelId: string,
  userText: string,
  assistantText: string,
  assistant: Partial<Message> = {},
): Promise<WorkflowTestSeededTurn> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const item = activeContextPanels.get(panel.body)?.() || panel.item;
  const conversationKey = getConversationKey(item);
  if (!conversationKey) {
    throw new Error("Workflow panel has no active conversation key");
  }
  const userTimestamp = Date.now();
  const assistantTimestamp = userTimestamp + 1;
  const userMessage = {
    role: "user" as const,
    text: userText,
    timestamp: userTimestamp,
  };
  const assistantMessage = {
    ...assistant,
    role: "assistant" as const,
    text: assistantText,
    timestamp: assistantTimestamp,
  };
  const conversationSystem =
    (panel.body.querySelector("#llm-main") as HTMLElement | null)?.dataset
      .conversationSystem || "upstream";
  const system =
    conversationSystem === "codex" || conversationSystem === "claude_code"
      ? conversationSystem
      : "upstream";
  await appendWorkflowStoredMessage(system, conversationKey, userMessage);
  await appendWorkflowStoredMessage(system, conversationKey, assistantMessage);
  const existing = chatHistory.get(conversationKey) || [];
  chatHistory.set(conversationKey, [
    ...existing,
    userMessage,
    assistantMessage,
  ]);
  loadedConversationKeys.add(conversationKey);
  panel.item = item;
  refreshChat(panel.body, item);
  await Zotero.Promise.delay(100);
  return { conversationKey, userTimestamp, assistantTimestamp };
}

async function deletePanelTurn(
  panelId: string,
  userTimestamp: number,
  assistantTimestamp: number,
): Promise<void> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const queueTurnDeletion = (
    panel.body as HTMLElement & {
      __llmQueueTurnDeletion?: (target: {
        conversationKey: number;
        userTimestamp: number;
        assistantTimestamp: number;
      }) => Promise<void>;
    }
  ).__llmQueueTurnDeletion;
  if (!queueTurnDeletion) {
    throw new Error("Turn deletion hook not installed on panel body");
  }
  const item = activeContextPanels.get(panel.body)?.() || panel.item;
  const conversationKey = getConversationKey(item);
  await queueTurnDeletion({
    conversationKey,
    userTimestamp,
    assistantTimestamp,
  });
  await Zotero.Promise.delay(200);
}

async function clickPanelUndo(panelId: string): Promise<void> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  dispatchWorkflowClick(panel.body, "#llm-history-undo-btn", "Undo button");
  await Zotero.Promise.delay(300);
}

async function isPanelUndoToastVisible(panelId: string): Promise<boolean> {
  const panel = getPanel(panelId);
  const toast = panel.body.querySelector(
    "#llm-history-undo",
  ) as HTMLElement | null;
  return Boolean(toast && toast.style.display !== "none");
}

async function getPanelVisibleMessageCount(panelId: string): Promise<number> {
  const panel = getPanel(panelId);
  return panel.body.querySelectorAll(".llm-message-wrapper").length;
}

async function remountPanel(panelId: string): Promise<WorkflowTestPanel> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  // The mounted item may be a synthetic portal item (global conversations);
  // remount from the original raw Zotero item backing the panel.
  const rawItem = activeContextPanelRawItems.get(panel.body);
  const itemId = Math.floor(Number(rawItem?.id || panel.item.id));
  disposeSetupHandlers(panel.body);
  activeContextPanels.delete(panel.body);
  activeContextPanelRawItems.delete(panel.body);
  panel.body.remove();
  panels.delete(panelId);
  return renderPanelForItemInternal(itemId);
}

async function getPendingDeletionState(): Promise<WorkflowTestPendingDeletionState> {
  const keys = Array.from(
    pendingDeletionStore.getPendingConversationKeys().values(),
  );
  const rows = (await Zotero.DB.queryAsync(
    `SELECT COUNT(*) AS n FROM ${PENDING_DELETIONS_TABLE}`,
  )) as Array<{ n: number }>;
  return {
    pendingCount: pendingDeletionStore.getLatestPending() ? 1 : 0,
    pendingConversationKeys: keys,
    persistedRowCount: Math.floor(Number(rows?.[0]?.n || 0)),
  };
}

async function sweepPendingDeletionsAsRestart(): Promise<void> {
  // These existing workflow cases intentionally model the post-expiry
  // checkpoint (the six-second window is not slept through in the harness).
  // Production startup uses the default and preserves an unexpired Undo row.
  await pendingDeletionStore.sweepAllPersisted("workflow-test-restart", {
    forceExpired: true,
  });
}

async function searchPanelHistory(
  panelId: string,
  query: string,
): Promise<WorkflowTestHistorySearchResult> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const search = (
    panel.body as HTMLElement & {
      __llmSearchPanelHistory?: (
        query: string,
      ) => Promise<WorkflowTestHistorySearchResult>;
    }
  ).__llmSearchPanelHistory;
  if (!search) {
    throw new Error("History search hook not installed on panel body");
  }
  return search(query);
}

async function failNextPendingTurnFinalizes(count: number): Promise<void> {
  assertWorkflowTestEnabled();
  forcePendingTurnFinalizeFailuresForTests(count);
}

// Drive a real send through the full request pipeline with intercepting
// hooks (no network), and return the captured final provider request.
async function askCapturingFinalRequest(
  panelId: string,
  text: string,
): Promise<WorkflowTestFinalRequestSnapshot> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  lastFinalRequest = null;
  setWorkflowTestSendInterceptor((opts) => {
    opts.apiBase = "http://127.0.0.1:9/v1";
    opts.apiKey = "workflow-test-key";
    opts.authMode = "api_key";
    lastSend = opts;
    return true;
  });
  setWorkflowTestFinalRequestInterceptor((snapshot) => {
    lastFinalRequest = snapshot;
    return true;
  });
  try {
    await ask(panelId, text);
    return await waitForFinalRequest(panel.body);
  } finally {
    setWorkflowTestSendInterceptor((opts) => {
      lastSend = opts;
    });
    setWorkflowTestFinalRequestInterceptor((snapshot) => {
      lastFinalRequest = snapshot;
    });
  }
}

async function simulateProviderContextUsage(
  panelId: string,
  usage: {
    contextTokens: number;
    contextWindow?: number;
    contextWindowIsAuthoritative?: boolean;
  },
): Promise<WorkflowTestDiagnostics> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const inputCap = lastFinalRequest?.inputCap;
  if (!inputCap) {
    throw new Error("No captured final request input cap is available");
  }
  const item = activeContextPanels.get(panel.body)?.() || panel.item;
  updateContextUsageSnapshotFromProvider({
    conversationKey: getConversationKey(item),
    usage: {
      promptTokens: usage.contextTokens,
      completionTokens: 0,
      totalTokens: usage.contextTokens,
      ...usage,
    },
    fallbackContextWindow: inputCap.limitTokens,
    fallbackInputLimitSource: inputCap.limitSource,
  });
  refreshChat(panel.body, item);
  return getDiagnostics(panelId);
}

async function setWorkflowModelInputCap(
  panelId: string,
  entryId: string,
  inputTokenCap: number,
): Promise<WorkflowTestDiagnostics> {
  assertWorkflowTestEnabled();
  getPanel(panelId);
  const groups = getModelProviderGroups();
  const model = groups
    .filter(
      (group) =>
        group.authMode !== "codex_auth" && group.authMode !== "webchat",
    )
    .flatMap((group) => group.models)
    .find((entry) => entry.id === entryId);
  if (!model) throw new Error(`Unknown workflow model entry ${entryId}`);
  model.inputTokenCap = inputTokenCap;
  setModelProviderGroups(groups);
  await Zotero.Promise.delay(25);
  return getDiagnostics(panelId);
}

async function cleanupFixture(
  fixture:
    | WorkflowTestFixture
    | WorkflowTestAttachmentFixture
    | WorkflowTestNoteFixture
    | WorkflowTestStandaloneNoteFixture,
): Promise<void> {
  assertWorkflowTestEnabled();
  if ("attachmentItemId" in fixture) {
    await trashItemIfPossible(fixture.attachmentItemId);
    await removePathIfPossible(fixture.tempPath);
    return;
  }
  if ("noteItemId" in fixture) {
    await trashItemIfPossible(fixture.noteItemId);
  }
  if ("pdfAttachmentId" in fixture) {
    await trashItemIfPossible(fixture.pdfAttachmentId);
  }
  if ("parentItemId" in fixture) {
    await trashItemIfPossible(fixture.parentItemId);
  }
  if ("tempPdfPath" in fixture) {
    await removePathIfPossible(fixture.tempPdfPath);
  }
}

export function installWorkflowTestHarness(targetAddon: {
  api: { workflowTest?: WorkflowTestApi };
}): void {
  if (__env__ !== "test" && __env__ !== "development") return;
  targetAddon.api.workflowTest = {
    reset,
    enableLiveAgentSending: () => {
      assertWorkflowTestEnabled();
      setWorkflowTestSendInterceptor((opts) => {
        lastSend = opts;
        return true;
      });
      setWorkflowTestFinalRequestInterceptor((snapshot) => {
        lastFinalRequest = snapshot;
      });
    },
    createPaperWithPdfFixture,
    trashWorkflowItem: async (itemId: number) => {
      assertWorkflowTestEnabled();
      await trashItemIfPossible(itemId);
    },
    setWorkflowProviderSession,
    getWorkflowConversationPersistenceSnapshot,
    exerciseStaleAgentTracePanelIsolation,
    exerciseCrossPaperHistoryReturnIsolation,
    createStandaloneAttachmentFixture,
    createItemNoteFixture,
    createStandaloneNoteFixture,
    renderPanelForItem,
    exerciseBackgroundAgentPublication,
    exerciseNativePlanReview: () => {
      assertWorkflowTestEnabled();
      return exerciseNativePlanReview();
    },
    exerciseNativeQuestionReview: (panelId: string) => {
      assertWorkflowTestEnabled();
      const panel = getPanel(panelId);
      return exerciseNativeQuestionReview(panel.body, panel.item);
    },
    exercisePlanHistoryReplay: (input) =>
      exercisePlanHistoryReplay(getPanel(input.panelId), input),
    exerciseStreamingReplay: (input) =>
      exerciseStreamingReplay(getPanel(input.panelId), input),
    renderStartupPanelForItem,
    startNewPanelConversation,
    togglePanelConversationMode,
    exerciseDuplicatePanelSetup,
    exerciseRebuiltPanelPlanApproval,
    approvePlanForExecution,
    researchFlightReport,
    exercisePanelDraftStateRefresh,
    selectPanelModelEntry,
    exerciseWebChatPdfToggleWorkflow,
    toggleWebChatPdfChip: toggleWebChatPdfChipForWorkflow,
    sendLiveWebChatTurn,
    seedPanelStoredUserMessage,
    clickPanelSystemToggle,
    clickPanelSystemTogglesRapidly,
    clickPanelRuntimeModeToggle,
    measurePanelRuntimeGeometry,
    measurePanelFooterLayout,
    selectNoteEditorText,
    ask,
    renderAssistantForPanel,
    clickStandaloneReasoningOption: async (label) => {
      assertWorkflowTestEnabled();
      const doc = await waitForStandaloneReady();
      doc.querySelector<HTMLButtonElement>("#llm-reasoning-toggle")?.click();
      const options = Array.from(
        doc.querySelectorAll<HTMLButtonElement>(
          "#llm-reasoning-menu .llm-reasoning-option",
        ),
      ) as HTMLButtonElement[];
      const matches = options.filter(
        (option) =>
          !option.disabled &&
          option.textContent?.replace(/^\s*✓\s*/, "").trim() === label,
      );
      if (matches.length !== 1)
        throw new Error(
          `Expected one visible reasoning option for ${label}, found ${matches.length}`,
        );
      matches[0].click();
    },
    renderToolResultForPanel: (panelId, result, options) => {
      assertWorkflowTestEnabled();
      const panel = getPanel(panelId);
      const trace = renderAgentTrace({
        doc: panel.body.ownerDocument,
        panelItem: panel.item,
        message: {
          role: "assistant",
          text: "Saved.",
          timestamp: Date.now(),
          documentId: options?.documentId,
        },
        userMessage: {
          role: "user",
          text: options?.userText || "Create a note on this paper",
          timestamp: Date.now() - 1,
        },
        events: [
          ...(options?.actionContract
            ? [
                {
                  runId: "workflow-tool-result",
                  seq: 0,
                  eventType: "provider_event" as const,
                  createdAt: Date.now(),
                  payload: {
                    type: "provider_event" as const,
                    providerType: "agent_action_contract",
                    payload: { contract: options.actionContract },
                  },
                },
              ]
            : []),
          ...[...(options?.priorResults || []), result].map((entry, index) => ({
            runId: "workflow-tool-result",
            seq: index + 1,
            eventType: "tool_result" as const,
            createdAt: Date.now(),
            payload: {
              type: "tool_result" as const,
              ...entry,
              actionReceipts: entry.actionReceipts || [],
            },
          })),
        ],
      });
      if (trace) panel.body.appendChild(trace);
      return trace;
    },
    renderPendingActionForPanel: (panelId, pending) => {
      assertWorkflowTestEnabled();
      const panel = getPanel(panelId);
      return new Promise((resolve) => {
        getAgentRuntime().registerPendingConfirmation(
          pending.requestId,
          resolve,
        );
        panel.body.appendChild(
          renderPendingActionCard(panel.body.ownerDocument, pending),
        );
      });
    },
    renderDocumentForPanel: (panelId, document, openLargerView) => {
      assertWorkflowTestEnabled();
      const panel = getPanel(panelId);
      const paperContext = panel.contextSnapshot?.paperContext;
      const citationContext = {
        panelItem: panel.item,
        assistantMessage: {
          role: "assistant" as const,
          text: document.visibleMarkdown,
          timestamp: document.createdAt,
        },
        pairedUserMessage: {
          role: "user" as const,
          text: "Document citation parity",
          timestamp: document.createdAt - 1,
          paperContexts: paperContext ? [paperContext] : undefined,
        },
      };
      if (openLargerView)
        return openStandalonePlanDocumentWindow(
          panel.body.ownerDocument,
          document,
          citationContext,
        );
      const root = panel.body.ownerDocument.createElement("article");
      root.className = "llm-plan-markdown llm-plan-document-content";
      panel.body.appendChild(root);
      renderPlanDocumentContent({
        doc: root.ownerDocument,
        root,
        document,
        citationContext,
      });
      return true;
    },
    exerciseTargetedQuoteRefresh,
    openStandaloneForItem,
    openStandaloneForLibraryAfterRestart,
    clickStandaloneTab,
    toggleStandaloneSidebar,
    hoverStandaloneSidebarToggle,
    clickStandaloneSystemToggle,
    clickStandaloneSystemTogglesRapidly,
    measureStandaloneRuntimeGeometry,
    exerciseStandaloneComposerManualResize,
    askStandalone,
    startNewStandaloneConversation,
    seedStandaloneUserMessage,
    seedStandaloneConversation,
    resizeStandaloneWindow,
    captureStandaloneScreenshot,
    observeCitationNavigationFocus: async (button, options) => {
      assertWorkflowTestEnabled();
      const getMainWindow = Zotero.getMainWindow;
      const mainWindow = getMainWindow();
      const originalLog = ztoolkit.log;
      const diagnostics: string[] = [];
      const getFullText = Zotero.PDFWorker.getFullText;
      if (options?.forceViewerFallbackForItemId) {
        Zotero.PDFWorker.getFullText = async (...args: unknown[]) => {
          const result = await getFullText.apply(Zotero.PDFWorker, args);
          return args[0] === options.forceViewerFallbackForItemId
            ? { ...result, pageChars: undefined }
            : result;
        };
      }
      ztoolkit.log = (...args) => {
        if (/citation|quote-locator/i.test(String(args[0])))
          diagnostics.push(
            args
              .map((value) =>
                typeof value === "string" ? value : JSON.stringify(value),
              )
              .join(" "),
          );
        return originalLog.apply(ztoolkit, args);
      };
      let focusRequests = 0;
      const observedWindow = new Proxy(mainWindow, {
        get(target, key) {
          if (key === "focus")
            return () => {
              focusRequests++;
              target.focus();
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      Zotero.getMainWindow = () => observedWindow;
      try {
        if (options?.linkTargetItemId) {
          const selected = () =>
            Zotero.getActiveZoteroPane()
              .getSelectedItems()
              .some((item) => item.id === options.linkTargetItemId);
          const started = button.isConnected;
          button.click();
          const deadline = Date.now() + 5000;
          while (!selected() && Date.now() < deadline)
            await Zotero.Promise.delay(25);
          return { started, finished: selected(), focusRequests, diagnostics };
        }
        const win = button.ownerDocument.defaultView!;
        button.dispatchEvent(
          new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
        const started = button.dataset.loading === "true";
        // The native FindController can use 30s plus selection settling.
        const deadline = Date.now() + 45000;
        while (button.dataset.loading === "true" && Date.now() < deadline)
          await Zotero.Promise.delay(25);
        return {
          started,
          finished: button.dataset.loading === "false",
          focusRequests,
          diagnostics,
        };
      } finally {
        Zotero.getMainWindow = getMainWindow;
        ztoolkit.log = originalLog;
        Zotero.PDFWorker.getFullText = getFullText;
      }
    },
    notifyStandaloneItemChanged,
    notifyStandaloneItemChanges,
    addItemsAsStandaloneContext,
    getLastFinalRequest: () => lastFinalRequest,
    getStandaloneDiagnostics,
    closeStandalone,
    getLastSend: () => lastSend,
    getDiagnostics,
    configurePermissionCatalogs,
    resolveDelayedCodexPermissionCatalog: resolveDelayedCodexCatalog,
    getPanelPermissionSurface,
    clickPanelPermissionToggle,
    clickPanelPermissionOption,
    getPanelConfirmationDialog,
    respondToPanelConfirmationDialog,
    getStandalonePermissionSurface,
    clickStandalonePermissionToggle,
    clickStandalonePermissionOption,
    exerciseReaderSelectionTrackingRecovery,
    exerciseReaderPopupActiveTabRouting,
    exerciseReaderPopupStandaloneRouting,
    exerciseHighlightAwareContextRetrieval,
    cleanupFixture,
    listPanelHistory,
    deletePanelHistoryConversation,
    clickPanelDelete,
    exercisePanelDeleteDuringPendingSend,
    seedPanelStoredTurn,
    deletePanelTurn,
    clickPanelUndo,
    isPanelUndoToastVisible,
    getPanelVisibleMessageCount,
    remountPanel,
    getPendingDeletionState,
    sweepPendingDeletionsAsRestart,
    searchPanelHistory,
    failNextPendingTurnFinalizes,
    askCapturingFinalRequest,
    simulateProviderContextUsage,
    setWorkflowModelInputCap,
  };
}
