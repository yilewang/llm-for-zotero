import { buildUI } from "./buildUI";
import { disposeSetupHandlers, setupHandlers } from "./setupHandlers";
import {
  activeContextPanels,
  activeContextPanelRawItems,
  chatHistory,
  loadedConversationKeys,
} from "./state";
import type { ResolvedContextSource, SendQuestionOptions } from "./types";
import type {
  WorkflowTestApi,
  WorkflowTestAssistantRenderResult,
  WorkflowTestAttachmentFixture,
  WorkflowTestDiagnostics,
  WorkflowTestFixture,
  WorkflowTestHighlightAwareRetrievalDiagnostics,
  WorkflowTestNoteFixture,
  WorkflowTestPanel,
  WorkflowTestReaderPopupRoutingDiagnostics,
  WorkflowTestReaderPopupStandaloneRoutingDiagnostics,
  WorkflowTestReaderSelectionTrackingDiagnostics,
  WorkflowTestStandaloneNoteFixture,
  WorkflowTestStandaloneDiagnostics,
} from "./workflowTestTypes";
import type { Message } from "./types";
import {
  buildAssistantDisplayMarkdownForRender,
  ensureConversationLoaded,
  getConversationKey,
  refreshChat,
} from "./chat";
import {
  applySelectedTextPreview,
  getSelectedTextContextEntries,
  resolveContextSourceItemAsync,
} from "./contextResolution";
import { syncNoteEditingSelectedText } from "./noteEditing/selectionController";
import {
  decorateAssistantCitationLinks,
  renderQuoteCitationPlaceholders,
} from "./assistantCitationLinks";
import { renderRenderedMarkdownInto } from "./renderedMarkdown";
import {
  notifyStandaloneItemChanged as notifyStandaloneItemChangedRuntime,
  openStandaloneChat,
} from "./standaloneWindow";
import {
  setWorkflowTestFinalRequestInterceptor,
  setWorkflowTestSendInterceptor,
  type WorkflowTestFinalRequestSnapshot,
} from "./workflowTestHooks";
import { dispatchZoteroItemsAsContext } from "./zoteroItemContextMenu";
import { appendMessage } from "../../utils/chatStore";
import { FreshStartupConversationSession } from "./freshStartupConversation";
import {
  ensureMarkedReaderSelectionTrackingListener,
  READER_TEXT_SELECTION_POPUP_EVENT,
  type ReaderSelectionTrackingReader,
} from "./readerSelectionTracking";
import { config } from "./constants";
import { collectReaderSelectionDocuments } from "./readerSelection";
import { getReaderContextPanelForTab } from "./readerPopupPanelRouting";

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
const workflowFreshStartupConversation = new FreshStartupConversationSession();

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
  return renderPanelForItemInternal(itemId, {
    startWithFreshConversation: false,
  });
}

async function renderStartupPanelForItem(
  itemId: number,
): Promise<WorkflowTestPanel> {
  return renderPanelForItemInternal(itemId, {
    startWithFreshConversation: workflowFreshStartupConversation.consume(),
  });
}

async function waitForStartupFreshConversation(
  body: HTMLElement,
): Promise<void> {
  const startedAt = Date.now();
  while ((body as any).__llmFreshStartupConversationInFlight) {
    if (Date.now() - startedAt > 5000) {
      throw new Error("Timed out waiting for startup fresh conversation");
    }
    await Zotero.Promise.delay(25);
  }
}

async function renderPanelForItemInternal(
  itemId: number,
  options: { startWithFreshConversation: boolean },
): Promise<WorkflowTestPanel> {
  assertWorkflowTestEnabled();
  const item = Zotero.Items.get(itemId);
  if (!item) throw new Error(`Unable to find Zotero item ${itemId}`);
  const doc = getWorkflowDocument();
  const body = appendHost(doc);
  const panelId = `workflow-panel-${++panelCounter}`;
  body.dataset.workflowPanelId = panelId;
  buildUI(body, item);
  activeContextPanels.set(body, () => item);
  activeContextPanelRawItems.set(body, item);
  if (!options.startWithFreshConversation) {
    loadedConversationKeys.add(getConversationKey(item));
  }
  setupHandlers(
    body,
    item,
    options.startWithFreshConversation
      ? { startWithFreshConversation: true }
      : undefined,
  );
  if (options.startWithFreshConversation) {
    await waitForStartupFreshConversation(body);
  }
  const mountedItem = activeContextPanels.get(body)?.() || item;
  await ensureConversationLoaded(mountedItem).catch(() => undefined);
  refreshChat(body, mountedItem);
  await Zotero.Promise.delay(50);
  const contextSnapshot = await resolveContextSourceItemAsync(mountedItem);
  const panel = { id: panelId, body, item: mountedItem, contextSnapshot };
  panels.set(panelId, panel);
  return { panelId, itemId, contextSnapshot };
}

async function seedPanelStoredUserMessage(
  panelId: string,
  text: string,
): Promise<WorkflowTestDiagnostics> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const item = activeContextPanels.get(panel.body)?.() || panel.item;
  const conversationKey = getConversationKey(item);
  if (!conversationKey) {
    throw new Error("Workflow panel has no active conversation key");
  }
  const message = {
    role: "user" as const,
    text,
    timestamp: Date.now(),
  };
  await appendMessage(conversationKey, message);
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
    noteItem: panel.item,
    text,
  });
  if (!synced) throw new Error("Workflow panel item is not a note");
  applySelectedTextPreview(panel.body, synced.conversationKey);
}

async function clickPanelSystemToggle(
  panelId: string,
): Promise<WorkflowTestDiagnostics> {
  assertWorkflowTestEnabled();
  const panel = getPanel(panelId);
  const button = panel.body.querySelector(
    "#llm-claude-system-toggle",
  ) as HTMLButtonElement | null;
  if (!button) throw new Error("System toggle button was not rendered");
  const eventCtor = panel.body.ownerDocument.defaultView?.MouseEvent;
  if (eventCtor) {
    button.dispatchEvent(
      new eventCtor("click", { bubbles: true, cancelable: true }),
    );
  } else {
    button.click();
  }
  await Zotero.Promise.delay(350);
  return getDiagnostics(panelId);
}

async function ask(
  panelId: string,
  text: string,
): Promise<SendQuestionOptions> {
  assertWorkflowTestEnabled();
  lastSend = null;
  const panel = getPanel(panelId);
  const input = panel.body.querySelector(
    "#llm-input",
  ) as HTMLTextAreaElement | null;
  if (!input) throw new Error("Workflow test input box was not rendered");
  input.value = text;
  const eventCtor = panel.body.ownerDocument.defaultView?.Event ?? Event;
  input.dispatchEvent(new eventCtor("input", { bubbles: true }));
  const sendBtn = panel.body.querySelector(
    "#llm-send",
  ) as HTMLButtonElement | null;
  if (!sendBtn) throw new Error("Workflow test send button was not rendered");
  sendBtn.click();
  return waitForLastSend();
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

  return {
    renderedText: bubble.textContent || "",
    quoteCardBodies: Array.from(
      bubble.querySelectorAll(".llm-quote-card-body"),
    ).map((node) => ((node as Element).textContent || "").trim()),
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
  return {
    activeTab: activeTabName,
    conversationKey: mountedItem ? getConversationKey(mountedItem) : undefined,
    activeItemId: parsePositiveInt(mountedItem?.id),
    rawContextItemId:
      parsePositiveInt(rawItem?.id) ||
      parsePositiveInt(panelRoot?.dataset.rawContextItemId),
    basePaperItemId: parsePositiveInt(panelRoot?.dataset.basePaperItemId),
    contextItemId: parsePositiveInt(panelRoot?.dataset.contextItemId),
    conversationKind: panelRoot?.dataset.conversationKind || undefined,
    conversationSystem: panelRoot?.dataset.conversationSystem || undefined,
    titleText: titleEl?.textContent?.trim() || undefined,
    chipText: Array.from(
      contentArea?.querySelectorAll(".llm-paper-context-chip-text") || [],
    ).map((node) => ((node as Element).textContent || "").trim()),
    selectedContextLabels: Array.from(
      contentArea?.querySelectorAll(".llm-selected-context-meta") || [],
    ).map((node) => ((node as Element).textContent || "").trim()),
    messageText: chatBox?.textContent?.trim() || undefined,
    paperTabText: paperTab?.textContent?.trim() || undefined,
    openTabText: openTab?.textContent?.trim() || undefined,
    statusText: statusEl?.textContent?.trim() || undefined,
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

async function openStandaloneForItem(
  itemId: number,
): Promise<WorkflowTestStandaloneDiagnostics> {
  assertWorkflowTestEnabled();
  const item = Zotero.Items.get(itemId);
  if (!item) throw new Error(`Unable to find Zotero item ${itemId}`);
  await closeStandalone();
  await selectZoteroItemForWorkflow(itemId).catch(() => undefined);
  openStandaloneChat({ initialItem: item });
  await waitForStandaloneReady();
  await Zotero.Promise.delay(150);
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
  await Zotero.Promise.delay(250);
  return readStandaloneDiagnostics();
}

async function clickStandaloneSystemToggle(): Promise<WorkflowTestStandaloneDiagnostics> {
  assertWorkflowTestEnabled();
  const doc = await waitForStandaloneReady();
  const button = doc.querySelector(
    ".llm-standalone-claude-toggle",
  ) as HTMLButtonElement | null;
  if (!button) throw new Error("Standalone system toggle was not rendered");
  button.click();
  await Zotero.Promise.delay(250);
  return readStandaloneDiagnostics();
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

async function seedStandaloneUserMessage(
  text: string,
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
  const message = {
    role: "user" as const,
    text,
    timestamp: Date.now(),
  };
  await appendMessage(conversationKey, message);
  chatHistory.set(conversationKey, [message]);
  loadedConversationKeys.add(conversationKey);
  refreshChat(contentArea, item);
  await Zotero.Promise.delay(150);
  return readStandaloneDiagnostics();
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
  return {
    panelId,
    activeItemId: parsePositiveInt(mountedItem?.id),
    conversationKey: mountedItem ? getConversationKey(mountedItem) : undefined,
    panelConversationKey: parsePositiveInt(panelRoot?.dataset.itemId),
    conversationKind: panelRoot?.dataset.conversationKind || undefined,
    conversationSystem: panelRoot?.dataset.conversationSystem || undefined,
    noteId: parsePositiveInt(panelRoot?.dataset.noteId),
    noteKind: panelRoot?.dataset.noteKind || undefined,
    noteParentItemId: parsePositiveInt(panelRoot?.dataset.noteParentItemId),
    contextSnapshot: panel?.contextSnapshot,
    chipText: Array.from(
      body?.querySelectorAll(".llm-paper-context-chip-text") || [],
    ).map((node) => ((node as Element).textContent || "").trim()),
    selectedContextLabels: Array.from(
      body?.querySelectorAll(".llm-selected-context-meta") || [],
    ).map((node) => ((node as Element).textContent || "").trim()),
    historyNewVisible: historyNewBtn
      ? historyNewBtn.style.display !== "none"
      : false,
    historyToggleVisible: historyToggleBtn
      ? historyToggleBtn.style.display !== "none"
      : false,
    inputValue: (
      body?.querySelector("#llm-input") as HTMLTextAreaElement | null
    )?.value,
    statusText:
      (body?.querySelector("#llm-status") as HTMLElement | null)?.textContent ||
      undefined,
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
    const clickedAt = Date.now();
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
  workflowFreshStartupConversation.begin();
  await closeStandalone();
  lastSend = null;
  lastFinalRequest = null;
  for (const panel of panels.values()) {
    disposeSetupHandlers(panel.body);
    activeContextPanels.delete(panel.body);
    activeContextPanelRawItems.delete(panel.body);
    panel.body.remove();
  }
  panels.clear();
  setWorkflowTestSendInterceptor((opts) => {
    lastSend = opts;
  });
  setWorkflowTestFinalRequestInterceptor((snapshot) => {
    lastFinalRequest = snapshot;
  });
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
    createPaperWithPdfFixture,
    createStandaloneAttachmentFixture,
    createItemNoteFixture,
    createStandaloneNoteFixture,
    renderPanelForItem,
    renderStartupPanelForItem,
    seedPanelStoredUserMessage,
    clickPanelSystemToggle,
    selectNoteEditorText,
    ask,
    renderAssistantForPanel,
    openStandaloneForItem,
    clickStandaloneTab,
    clickStandaloneSystemToggle,
    askStandalone,
    seedStandaloneUserMessage,
    notifyStandaloneItemChanged,
    notifyStandaloneItemChanges,
    addItemsAsStandaloneContext,
    getLastFinalRequest: () => lastFinalRequest,
    getStandaloneDiagnostics,
    closeStandalone,
    getLastSend: () => lastSend,
    getDiagnostics,
    exerciseReaderSelectionTrackingRecovery,
    exerciseReaderPopupActiveTabRouting,
    exerciseReaderPopupStandaloneRouting,
    exerciseHighlightAwareContextRetrieval,
    cleanupFixture,
  };
}
