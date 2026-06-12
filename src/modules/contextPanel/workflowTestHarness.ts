import { buildUI } from "./buildUI";
import { setupHandlers } from "./setupHandlers";
import {
  activeContextPanels,
  activeContextPanelRawItems,
  loadedConversationKeys,
} from "./state";
import type { ResolvedContextSource, SendQuestionOptions } from "./types";
import type {
  WorkflowTestApi,
  WorkflowTestAssistantRenderResult,
  WorkflowTestAttachmentFixture,
  WorkflowTestDiagnostics,
  WorkflowTestFixture,
  WorkflowTestPanel,
  WorkflowTestStandaloneDiagnostics,
} from "./workflowTestTypes";
import type { Message } from "./types";
import {
  buildAssistantDisplayMarkdownForRender,
  ensureConversationLoaded,
  getConversationKey,
} from "./chat";
import { resolveContextSourceItemAsync } from "./contextResolution";
import {
  decorateAssistantCitationLinks,
  renderQuoteCitationPlaceholders,
} from "./assistantCitationLinks";
import { renderRenderedMarkdownInto } from "./renderedMarkdown";
import {
  notifyStandaloneItemChanged as notifyStandaloneItemChangedRuntime,
  openStandaloneChat,
} from "./standaloneWindow";
import { setWorkflowTestSendInterceptor } from "./workflowTestHooks";

type PanelRecord = {
  id: string;
  body: HTMLElement;
  item: Zotero.Item;
  contextSnapshot: ResolvedContextSource | null;
};

const panels = new Map<string, PanelRecord>();
let panelCounter = 0;
let lastSend: SendQuestionOptions | null = null;

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

function minimalPdfBytes(title: string): Uint8Array {
  const safeTitle = title.replace(/[()\\]/gu, " ").slice(0, 80);
  const pdf = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R >> endobj",
    `4 0 obj << /Length ${safeTitle.length + 64} >> stream`,
    "BT /F1 12 Tf 32 96 Td",
    `(${safeTitle}) Tj`,
    "ET",
    "endstream endobj",
    "xref",
    "0 5",
    "0000000000 65535 f ",
    "trailer << /Root 1 0 R /Size 5 >>",
    "startxref",
    "0",
    "%%EOF",
    "",
  ].join("\n");
  return new TextEncoder().encode(pdf);
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

async function writeTempPdf(title: string): Promise<string> {
  return writeTempFile("paper.pdf", minimalPdfBytes(title));
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
  const tempPdfPath = await writeTempPdf(input.pdfTitle);
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

async function renderPanelForItem(itemId: number): Promise<WorkflowTestPanel> {
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
  loadedConversationKeys.add(getConversationKey(item));
  setupHandlers(body, item);
  await ensureConversationLoaded(item).catch(() => undefined);
  const contextSnapshot = await resolveContextSourceItemAsync(item);
  const panel = { id: panelId, body, item, contextSnapshot };
  panels.set(panelId, panel);
  return { panelId, itemId, contextSnapshot };
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

function getStandaloneWindowForTest(): Window | null {
  const win =
    (addon as unknown as { data?: { standaloneWindow?: Window } }).data
      ?.standaloneWindow || null;
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
    conversationKey: parsePositiveInt(panelRoot?.dataset.itemId),
    activeItemId: parsePositiveInt(mountedItem?.id),
    rawContextItemId:
      parsePositiveInt(rawItem?.id) ||
      parsePositiveInt(panelRoot?.dataset.rawContextItemId),
    basePaperItemId: parsePositiveInt(panelRoot?.dataset.basePaperItemId),
    contextItemId: parsePositiveInt(panelRoot?.dataset.contextItemId),
    conversationKind: panelRoot?.dataset.conversationKind || undefined,
    titleText: titleEl?.textContent?.trim() || undefined,
    paperTabText: paperTab?.textContent?.trim() || undefined,
    openTabText: openTab?.textContent?.trim() || undefined,
    statusText: statusEl?.textContent?.trim() || undefined,
    lastSend,
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

async function closeStandalone(): Promise<void> {
  assertWorkflowTestEnabled();
  const win = getStandaloneWindowForTest();
  if (win) {
    win.close();
  }
  const startedAt = Date.now();
  while (getStandaloneWindowForTest() && Date.now() - startedAt < 3000) {
    await Zotero.Promise.delay(25);
  }
}

async function getDiagnostics(
  panelId?: string,
): Promise<WorkflowTestDiagnostics> {
  const panel = panelId ? panels.get(panelId) : undefined;
  const body = panel?.body;
  return {
    panelId,
    activeItemId: panel?.item.id,
    contextSnapshot: panel?.contextSnapshot,
    chipText: Array.from(
      body?.querySelectorAll(".llm-paper-context-chip-text") || [],
    ).map((node) => ((node as Element).textContent || "").trim()),
    inputValue: (
      body?.querySelector("#llm-input") as HTMLTextAreaElement | null
    )?.value,
    statusText:
      (body?.querySelector("#llm-status") as HTMLElement | null)?.textContent ||
      undefined,
    lastSend,
  };
}

async function reset(): Promise<void> {
  assertWorkflowTestEnabled();
  await closeStandalone();
  lastSend = null;
  for (const panel of panels.values()) {
    activeContextPanels.delete(panel.body);
    activeContextPanelRawItems.delete(panel.body);
    panel.body.remove();
  }
  panels.clear();
  setWorkflowTestSendInterceptor((opts) => {
    lastSend = opts;
  });
}

async function cleanupFixture(
  fixture: WorkflowTestFixture | WorkflowTestAttachmentFixture,
): Promise<void> {
  assertWorkflowTestEnabled();
  if ("attachmentItemId" in fixture) {
    await trashItemIfPossible(fixture.attachmentItemId);
    await removePathIfPossible(fixture.tempPath);
    return;
  }
  await trashItemIfPossible(fixture.pdfAttachmentId);
  await trashItemIfPossible(fixture.parentItemId);
  await removePathIfPossible(fixture.tempPdfPath);
}

export function installWorkflowTestHarness(targetAddon: {
  api: { workflowTest?: WorkflowTestApi };
}): void {
  if (__env__ !== "test" && __env__ !== "development") return;
  targetAddon.api.workflowTest = {
    reset,
    createPaperWithPdfFixture,
    createStandaloneAttachmentFixture,
    renderPanelForItem,
    ask,
    renderAssistantForPanel,
    openStandaloneForItem,
    clickStandaloneTab,
    askStandalone,
    notifyStandaloneItemChanged,
    getStandaloneDiagnostics,
    closeStandalone,
    getLastSend: () => lastSend,
    getDiagnostics,
    cleanupFixture,
  };
}
