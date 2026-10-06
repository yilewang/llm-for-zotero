import { assert } from "chai";
import {
  getModelEntryById,
  setModelProviderGroups,
} from "../src/utils/modelProviders";
import { getReaderContextPanelForTab } from "../src/modules/contextPanel/readerPopupPanelRouting";
import { collectReaderSelectionDocuments } from "../src/services/pdf/readerSelection";
import { READER_TEXT_SELECTION_POPUP_EVENT } from "../src/modules/contextPanel/readerSelectionTracking";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";
import {
  installHeldChatProvider,
  type HeldChatProvider,
} from "./helpers/heldChatProvider";

/**
 * The standalone chat window is an additional surface: opening it must not
 * block the sidebar chat panel, and the two surfaces work independently.
 *
 * Everything here runs in the real Zotero host against the real native
 * sidebar panel (the item pane's dedicated chat section) and the real
 * standalone window. Sends go through each panel's own composer and the real
 * send flow; only the network is scripted (a held fake provider), so the test
 * decides when each answer streams and ends.
 *
 * Product decisions under test:
 * - D1: each surface keeps its own model entry; the saved pref is only the
 *   default for a newly mounted panel.
 * - D2: reader "Add Text" goes to the reader tab's own sidebar panel, not the
 *   standalone window.
 * - D4: one conversation may show in both surfaces; streaming mirrors to
 *   both, Stop works from either, a second send on a busy conversation does
 *   not start a second request.
 * - Each surface remembers its own mode and selected conversation, and
 *   closing the window leaves the sidebar panel untouched.
 */

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero.";
const API_BASE = "https://workflow-standalone-coexist.invalid/v1";
const GROUP_ID = "workflow-coexist-group";
const ENTRY_A = "workflow-coexist-model-a";
const MODEL_A = "coexist-model-a";
const ENTRY_B = "workflow-coexist-model-b";
const MODEL_B = "coexist-model-b";

const SAVED_PREF_KEYS = [
  "modelProviderGroups",
  "modelProviderGroupsMigrationVersion",
  "lastUsedModelEntryId",
  "lastUsedRuntimeMode",
  "conversationSystem",
  "enableCodexAppServerMode",
  "enableClaudeCodeMode",
  "outputTokenAutoMigrationNoticePending",
  "sidebarLayout",
];

type SidebarState = {
  placeholder: boolean;
  placeholderText: string;
  hasRoot: boolean;
  connected: boolean;
  conversationKey: number;
  conversationKind: string;
  conversationSystem: string;
  basePaperItemId: number;
  contextOwnerItemId: number;
  inputDisabled: boolean | null;
  inputValue: string | null;
  modelLabel: string;
  chatText: string;
  paneView: string | null;
};

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

function toKey(value: unknown): number {
  const parsed = Math.floor(Number(value || 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function textOf(node: Element | null | undefined): string {
  return (node?.textContent || "").replace(/\s+/gu, " ").trim();
}

function lastAssistantBubbleText(root: Element | null): string {
  const bubbles = Array.from(
    root?.querySelectorAll("#llm-chat-box .llm-bubble.assistant") || [],
  );
  return textOf(bubbles[bubbles.length - 1] as Element | undefined);
}

function bubbleContaining(root: Element | null, marker: string) {
  return (
    (
      Array.from(
        root?.querySelectorAll("#llm-chat-box .llm-bubble.assistant") || [],
      ) as HTMLElement[]
    ).find((bubble) => (bubble.textContent || "").includes(marker)) || null
  );
}

describe("workflow: standalone window coexists with the sidebar chat", function () {
  this.timeout(180_000);

  let api: WorkflowTestApi;
  let provider: HeldChatProvider;
  const previousPrefs = new Map<string, unknown>();
  const fixtures: WorkflowTestFixture[] = [];
  const readers: any[] = [];

  const mainWin = () => Zotero.getMainWindow();

  // ── Native sidebar (the library tab's item pane chat section) ───────────

  const librarySection = (): HTMLElement | null =>
    mainWin()
      .document.getElementById("zotero-item-details")
      ?.querySelector(".llm-dedicated-chat-pane") || null;

  const sidebarRoot = (): HTMLElement | null =>
    (librarySection()?.querySelector("#llm-main") as HTMLElement | null) ||
    null;

  const sidebarBody = (): HTMLElement | null =>
    sidebarRoot()?.parentElement || null;

  function readPanelState(
    section: Element | null,
    root: HTMLElement | null,
  ): SidebarState {
    const body = root?.parentElement || null;
    const input = body?.querySelector(
      "#llm-input",
    ) as HTMLTextAreaElement | null;
    const placeholder = section?.querySelector(
      ".llm-standalone-placeholder",
    ) as HTMLElement | null;
    return {
      placeholder: Boolean(placeholder),
      placeholderText: textOf(placeholder),
      hasRoot: Boolean(root),
      connected: Boolean(root?.isConnected),
      conversationKey: toKey(root?.dataset.itemId),
      conversationKind: root?.dataset.conversationKind || "",
      conversationSystem: root?.dataset.conversationSystem || "",
      basePaperItemId: toKey(root?.dataset.basePaperItemId),
      contextOwnerItemId: toKey(root?.dataset.contextOwnerItemId),
      inputDisabled: input ? input.disabled : null,
      inputValue: input ? input.value : null,
      modelLabel:
        (body?.querySelector("#llm-model-toggle") as HTMLElement | null)
          ?.dataset.modelLabel || "",
      chatText: textOf(body?.querySelector("#llm-chat-box")).slice(-400),
      paneView:
        mainWin().document.documentElement.getAttribute("data-llm-pane-view"),
    };
  }

  const sidebarState = () => readPanelState(librarySection(), sidebarRoot());

  async function until(
    check: () => boolean | Promise<boolean>,
    describe: () => string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await Zotero.Promise.delay(50);
    }
    if (await check()) return;
    assert.fail(describe());
  }

  /** Select a paper and open its native sidebar chat (before any window). */
  async function openSidebarChat(itemId: number): Promise<HTMLElement> {
    const win = mainWin();
    win.Zotero_Tabs?.select?.("zotero-pane");
    await win.ZoteroPane.selectItem(itemId);
    const details = win.document.getElementById("zotero-item-details");
    await until(
      () => Boolean(details?.querySelector(".llm-dedicated-chat-pane")),
      () => "native chat section is registered in the item pane",
    );
    const section = librarySection()!;
    if (
      win.document.documentElement.getAttribute("data-llm-pane-view") !==
        "chat" ||
      details.sidenav._collapsed
    ) {
      const button = Array.from(
        details.sidenav.querySelectorAll("[data-pane]"),
      ).find(
        (node: any) => node.getAttribute("data-pane") === section.dataset.pane,
      ) as Element | undefined;
      assert.isOk(button, "the chat rail icon exists");
      button!.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, button: 0 }),
      );
    }
    await until(
      () => {
        const root = sidebarRoot();
        return Boolean(
          root?.dataset.handlersInitialized &&
          root.getBoundingClientRect().width > 0 &&
          toKey(root.dataset.basePaperItemId) === itemId,
        );
      },
      () =>
        `the native sidebar chat for item ${itemId} is initialized and visible: ${JSON.stringify(sidebarState())}`,
    );
    return sidebarRoot()!;
  }

  async function ensureSidebarPaperChat(itemId: number): Promise<HTMLElement> {
    const root = sidebarRoot()!;
    if (root.dataset.conversationKind !== "paper") {
      (
        sidebarBody()!.querySelector("#llm-paper-chat-tab") as HTMLElement
      ).click();
    }
    await until(
      () =>
        sidebarRoot()?.dataset.conversationKind === "paper" &&
        toKey(sidebarRoot()?.dataset.basePaperItemId) === itemId &&
        toKey(sidebarRoot()?.dataset.itemId) > 0,
      () =>
        `the sidebar shows Paper chat for item ${itemId}: ${JSON.stringify(sidebarState())}`,
    );
    return sidebarRoot()!;
  }

  /** The sidebar must still be a live chat panel, not the "open elsewhere" placeholder. */
  function assertSidebarLive(context: string): HTMLElement {
    const state = sidebarState();
    assert.isFalse(
      state.placeholder,
      `${context}: the sidebar chat must stay live, but it was replaced by the standalone placeholder ("${state.placeholderText}"): ${JSON.stringify(state)}`,
    );
    assert.isTrue(
      state.hasRoot && state.connected,
      `${context}: the sidebar has a connected #llm-main: ${JSON.stringify(state)}`,
    );
    return sidebarRoot()!;
  }

  async function selectMainItem(itemId: number): Promise<void> {
    await mainWin().ZoteroPane.selectItem(itemId);
  }

  // ── Standalone window ────────────────────────────────────────────────────

  const standaloneWin = (): Window | null => {
    const win = (Zotero as any).LLMForZotero?.data?.standaloneWindow as
      | Window
      | undefined;
    return win && !win.closed ? win : null;
  };

  const windowBody = (): HTMLElement | null =>
    (standaloneWin()?.document.querySelector(
      ".llm-standalone-content",
    ) as HTMLElement | null) || null;

  const windowRoot = (): HTMLElement | null =>
    (windowBody()?.querySelector("#llm-main") as HTMLElement | null) || null;

  const windowState = () =>
    readPanelState(windowBody(), windowRoot()) as SidebarState;

  async function ensureWindowShowsConversation(key: number): Promise<void> {
    if (toKey(windowRoot()?.dataset.itemId) === key) return;
    const doc = standaloneWin()!.document;
    let row: HTMLElement | null = null;
    await until(
      () => {
        row = doc.querySelector<HTMLElement>(
          `.llm-standalone-conv-item[data-conversation-key="${key}"]`,
        );
        return Boolean(row);
      },
      () =>
        `the window's conversation list offers conversation ${key}: ${JSON.stringify(
          Array.from(doc.querySelectorAll(".llm-standalone-conv-item")).map(
            (node: any) => node.dataset.conversationKey,
          ),
        )}`,
    );
    row!.click();
    await until(
      () => toKey(windowRoot()?.dataset.itemId) === key,
      () =>
        `the window mounts conversation ${key}: ${JSON.stringify(windowState())}`,
    );
  }

  async function selectPanelModel(
    body: HTMLElement,
    entryId: string,
    model: string,
    name: string,
  ) {
    const toggle = body.querySelector(
      "#llm-model-toggle",
    ) as HTMLButtonElement | null;
    assert.isOk(toggle, `the ${name} has a model button`);
    toggle!.click();
    let option: HTMLElement | null = null;
    const selector = `#llm-model-menu .llm-model-option[data-entry-id="${entryId}"]`;
    await until(
      () => {
        option =
          body.querySelector<HTMLElement>(selector) ||
          body.ownerDocument.querySelector<HTMLElement>(selector);
        return Boolean(option);
      },
      () => `the ${name}'s model menu offers ${entryId}`,
    );
    option!.click();
    await until(
      () =>
        (
          (body.querySelector("#llm-model-toggle") as HTMLElement | null)
            ?.dataset.modelLabel || ""
        ).includes(model),
      () =>
        `the ${name}'s model button shows ${model}: ${JSON.stringify(
          readPanelState(null, body.querySelector("#llm-main")),
        )}`,
    );
  }

  const selectWindowModel = (entryId: string, model: string) =>
    selectPanelModel(windowBody()!, entryId, model, "window");

  // ── Sending through a panel's own composer ───────────────────────────────

  function typeAndSend(body: HTMLElement, text: string): void {
    const win = body.ownerDocument.defaultView as any;
    const input = body.querySelector("#llm-input") as HTMLTextAreaElement;
    const send = body.querySelector("#llm-send") as HTMLButtonElement;
    assert.isOk(input, "the composer has an input");
    assert.isOk(send, "the composer has a Send button");
    input.value = text;
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    send.click();
  }

  function pressEnter(body: HTMLElement, text: string): void {
    const win = body.ownerDocument.defaultView as any;
    const input = body.querySelector("#llm-input") as HTMLTextAreaElement;
    input.value = text;
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(
      new win.KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  async function history(key: number) {
    return api.getConversationHistoryTexts(key);
  }

  /** Wait until the conversation's newest answer is final and contains `text`. */
  async function waitForAnswer(key: number, text: string): Promise<void> {
    let last: unknown = null;
    await until(
      async () => {
        const state = await api.readChatTurnLifecycle(key);
        const assistant = [...state.memory]
          .reverse()
          .find((message) => message.role === "assistant");
        last = { requestPending: state.requestPending, assistant };
        return (
          !state.requestPending &&
          Boolean(assistant) &&
          assistant!.streaming !== true &&
          String(assistant!.text || "").includes(text)
        );
      },
      () =>
        `conversation ${key} finishes an answer containing "${text}": ${JSON.stringify(last)}`,
      30_000,
    );
  }

  /** One completed turn in the sidebar, so its conversation is stored. */
  async function completeSidebarTurn(question: string, answer: string) {
    typeAndSend(sidebarBody()!, question);
    const stream = await provider.waitForStream(question);
    stream.push(answer);
    stream.finish();
    const key = toKey(sidebarRoot()?.dataset.itemId);
    await waitForAnswer(key, answer);
    return key;
  }

  // ── Reader "Add Text" (the real popup handler) ───────────────────────────

  async function openReaderTab(attachmentId: number): Promise<any> {
    const reader = await Zotero.Reader.open(attachmentId, { pageIndex: 0 });
    assert.isOk(reader, "the PDF reader tab opens");
    readers.push(reader);
    await reader._initPromise;
    if (typeof reader._waitForReader === "function") {
      await reader._waitForReader();
    }
    return reader;
  }

  async function openReaderSidebarChat(reader: any): Promise<void> {
    const win = mainWin();
    win.Zotero_Tabs.select(reader.tabID);
    let details: any = null;
    await until(
      () => {
        details = getReaderContextPanelForTab(win.document, reader.tabID);
        return Boolean(details?.querySelector(".llm-dedicated-chat-pane"));
      },
      () => "the reader tab has its own chat section",
    );
    const section = details.querySelector(".llm-dedicated-chat-pane");
    if (
      win.document.documentElement.getAttribute("data-llm-pane-view") !==
        "chat" ||
      details.sidenav?._collapsed
    ) {
      const button = Array.from(
        details.sidenav?.querySelectorAll("[data-pane]") || [],
      ).find(
        (node: any) => node.getAttribute("data-pane") === section.dataset.pane,
      ) as Element | undefined;
      button?.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, button: 0 }),
      );
    }
    // Soft wait: today the reader sidebar is a placeholder while the window
    // is open; the Add Text assertions below report that state.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const root = section.querySelector("#llm-main") as HTMLElement | null;
      if (root?.dataset.handlersInitialized) return;
      await Zotero.Promise.delay(50);
    }
  }

  function findSelectionRange(reader: any, pageIndex: number, text: string) {
    for (const doc of collectReaderSelectionDocuments(reader)) {
      const pages = Array.from(
        doc.querySelectorAll(
          `.page[data-page-number="${pageIndex + 1}"], [data-page-index="${pageIndex}"]`,
        ),
      ) as Element[];
      for (const page of pages) {
        if (!page.textContent?.includes(text)) continue;
        const walker = doc.createTreeWalker(page, 4);
        let node = walker.nextNode();
        while (node) {
          const value = node.nodeValue || "";
          const start = value.indexOf(text);
          if (start >= 0) {
            const range = doc.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + text.length);
            return { doc, range };
          }
          node = walker.nextNode();
        }
      }
    }
    return null;
  }

  async function clickReaderAddText(
    reader: any,
    pageIndex: number,
    text: string,
  ): Promise<() => void> {
    let match: ReturnType<typeof findSelectionRange> = null;
    await until(
      () => {
        match = findSelectionRange(reader, pageIndex, text);
        if (!match) return false;
        const selection = match.doc.defaultView?.getSelection?.();
        selection?.removeAllRanges();
        selection?.addRange(match.range);
        return Boolean(selection?.toString().includes(text));
      },
      () => `the reader renders and selects "${text}" on page ${pageIndex + 1}`,
    );
    const { doc } = match!;
    const popupHost = doc.createElement("div");
    (doc.body || doc.documentElement).appendChild(popupHost);
    const handler = (Zotero.Reader as any).__llmSelectionTracking?.handler;
    assert.isOk(handler, "the plugin's Add Text popup handler is installed");
    await handler({
      reader,
      doc,
      params: { annotation: { text, position: { pageIndex } } },
      append: (node: Node | string) => popupHost.append(node),
      type: READER_TEXT_SELECTION_POPUP_EVENT,
    });
    const button = (
      Array.from(popupHost.querySelectorAll("button")) as HTMLButtonElement[]
    ).find((node) => node.textContent?.trim() === "Add Text");
    assert.isOk(button, "the reader popup shows Add Text");
    button!.dispatchEvent(
      new (doc.defaultView as any).MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
    return () => {
      doc.defaultView?.getSelection?.()?.removeAllRanges();
      popupHost.remove();
    };
  }

  const previewTexts = (body: Element | null) =>
    Array.from(body?.querySelectorAll(".llm-selected-context-text") || []).map(
      (node) => textOf(node as Element),
    );

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async function newFixture(title: string, pages?: string[]) {
    const fixture = await api.createPaperWithPdfFixture({
      title,
      pdfTitle: `${title} PDF`,
      pages: pages || [`${title}: a short page about coexisting chat panels.`],
    });
    fixtures.push(fixture);
    return fixture;
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = getWorkflowTestApi();
    for (const key of SAVED_PREF_KEYS) {
      previousPrefs.set(key, Zotero.Prefs.get(PREF_PREFIX + key, true));
    }
    provider = installHeldChatProvider(API_BASE);
    Zotero.Prefs.set(PREF_PREFIX + "sidebarLayout", "independent", true);
    Zotero.Prefs.set(PREF_PREFIX + "conversationSystem", "upstream", true);
    Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "enableClaudeCodeMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedRuntimeMode", "chat", true);
    setModelProviderGroups([
      {
        id: GROUP_ID,
        authMode: "api_key",
        apiBase: API_BASE,
        apiKey: "workflow-dummy-key",
        providerProtocol: "openai_chat_compat",
        models: [
          {
            id: ENTRY_A,
            model: MODEL_A,
            temperature: 0.3,
            outputTokenLimit: { mode: "auto" },
          },
          {
            id: ENTRY_B,
            model: MODEL_B,
            temperature: 0.3,
            outputTokenLimit: { mode: "auto" },
          },
        ],
      },
    ] as any);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedModelEntryId", ENTRY_A, true);
    assert.isOk(getModelEntryById(ENTRY_A), "fake model A is configured");
    assert.isOk(getModelEntryById(ENTRY_B), "fake model B is configured");
  });

  after(async function () {
    provider?.restore();
    await api.reset();
    for (const [key, value] of previousPrefs) {
      if (value === undefined) Zotero.Prefs.clear(PREF_PREFIX + key, true);
      else Zotero.Prefs.set(PREF_PREFIX + key, value, true);
    }
  });

  beforeEach(async function () {
    await api.reset();
    // Let each panel's send continue into the real request and provider.
    api.enableLiveAgentSending();
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedModelEntryId", ENTRY_A, true);
  });

  afterEach(async function () {
    provider.failOpenStreams("workflow case ended");
    await Zotero.Promise.delay(300);
    for (const reader of readers.splice(0)) {
      try {
        await Zotero.Tabs?.close?.(reader.tabID);
      } catch {
        // already closed
      }
    }
    mainWin().Zotero_Tabs?.select?.("zotero-pane");
    await api.closeStandalone();
    for (const fixture of fixtures.splice(0)) {
      await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  // ── T1 ───────────────────────────────────────────────────────────────────

  it("T1: keeps the sidebar Paper chat live and usable while the window shows Library chat", async function () {
    const paper = await newFixture("Coexist T1");
    await openSidebarChat(paper.parentItemId);
    const root = await ensureSidebarPaperChat(paper.parentItemId);
    const before = sidebarState();

    // The user's own entry point: the sidebar's pop-out button.
    (sidebarBody()!.querySelector("#llm-popout") as HTMLElement).click();
    await until(
      () => Boolean(windowRoot()?.dataset.handlersInitialized),
      () => "the standalone window opens and mounts its chat",
    );
    const library = await api.clickStandaloneTab("open");
    assert.equal(
      library.conversationKind,
      "global",
      `the window switched to Library chat: ${JSON.stringify(library)}`,
    );
    await Zotero.Promise.delay(300);

    const live = assertSidebarLive("after opening the window");
    const after = sidebarState();
    assert.strictEqual(
      live,
      root,
      `the sidebar keeps the same live panel: ${JSON.stringify({ before, after })}`,
    );
    assert.equal(
      after.conversationKind,
      "paper",
      `the sidebar is still Paper chat: ${JSON.stringify({ before, after })}`,
    );
    assert.equal(
      after.conversationKey,
      before.conversationKey,
      `the sidebar still shows the paper's conversation: ${JSON.stringify({ before, after })}`,
    );
    assert.isFalse(
      after.inputDisabled,
      `the sidebar composer is usable: ${JSON.stringify(after)}`,
    );
  });

  // ── T2 ───────────────────────────────────────────────────────────────────

  it("T2: sidebar Paper chat and window Library chat stream at the same time without leaking", async function () {
    const paper = await newFixture("Coexist T2 paper");
    const other = await newFixture("Coexist T2 other");
    await openSidebarChat(paper.parentItemId);
    await ensureSidebarPaperChat(paper.parentItemId);
    await api.openStandaloneForItem(paper.parentItemId);
    let library = await api.clickStandaloneTab("open");
    // An empty Library chat, so earlier files' turns in the library's default
    // conversation do not count against this test's stored questions. "+"
    // reuses a Library chat that is already empty (it does not start another
    // one), so it is pressed only when the current one has turns.
    const opened = await history(toKey(windowRoot()?.dataset.itemId));
    if (opened.memory.length > 0 || opened.stored.length > 0) {
      library = await api.startNewStandaloneConversation();
    }
    assert.equal(library.conversationKind, "global", JSON.stringify(library));
    const emptyLibrary = await history(toKey(windowRoot()?.dataset.itemId));
    assert.isEmpty(
      [...emptyLibrary.memory, ...emptyLibrary.stored],
      `the window's Library chat starts empty: ${JSON.stringify(emptyLibrary)}`,
    );
    await Zotero.Promise.delay(300);
    assertSidebarLive("before the sidebar send");

    const PAPER_Q = "T2 paper question COEXIST-PAPER-Q";
    const LIB_Q = "T2 library question COEXIST-LIB-Q";
    typeAndSend(sidebarBody()!, PAPER_Q);
    const paperStream = await provider.waitForStream(PAPER_Q);
    paperStream.push("PAPER-ANSWER-ONE ");
    const paperKey = toKey(sidebarRoot()?.dataset.itemId);
    assert.isAbove(paperKey, 0, JSON.stringify(sidebarState()));

    typeAndSend(windowBody()!, LIB_Q);
    const libStream = await provider.waitForStream(LIB_Q);
    libStream.push("LIBRARY-ANSWER-ONE ");
    const libKey = toKey(windowRoot()?.dataset.itemId);
    assert.isAbove(libKey, 0, JSON.stringify(windowState()));
    assert.notEqual(libKey, paperKey, "two different conversations");

    // The window's Library-chat send must not flip the sidebar into Library
    // chat, neither at once nor when the sidebar next resolves its paper.
    await Zotero.Promise.delay(600);
    let state = sidebarState();
    assert.equal(
      state.conversationKind,
      "paper",
      `sidebar stays Paper chat while the window's Library chat streams: ${JSON.stringify(state)}`,
    );
    await selectMainItem(other.parentItemId);
    await Zotero.Promise.delay(400);
    await selectMainItem(paper.parentItemId);
    await until(
      () =>
        sidebarState().conversationKind === "paper" &&
        sidebarState().conversationKey === paperKey,
      () =>
        `after reselecting the paper during the window's Library send, the sidebar shows Paper chat ${paperKey}: ${JSON.stringify(sidebarState())}`,
    );

    paperStream.push("PAPER-ANSWER-TWO");
    libStream.push("LIBRARY-ANSWER-TWO");
    paperStream.finish();
    libStream.finish();
    await waitForAnswer(paperKey, "PAPER-ANSWER-ONE PAPER-ANSWER-TWO");
    await waitForAnswer(libKey, "LIBRARY-ANSWER-ONE LIBRARY-ANSWER-TWO");

    const paperHistory = await history(paperKey);
    const libHistory = await history(libKey);
    const message = JSON.stringify({ paperHistory, libHistory });
    const texts = (h: typeof paperHistory) =>
      [...h.memory, ...h.stored].map((entry) => entry.text).join("\n");
    assert.include(texts(paperHistory), PAPER_Q, message);
    assert.notInclude(texts(paperHistory), LIB_Q, message);
    assert.notInclude(texts(paperHistory), "LIBRARY-ANSWER", message);
    assert.include(texts(libHistory), LIB_Q, message);
    assert.notInclude(texts(libHistory), PAPER_Q, message);
    assert.notInclude(texts(libHistory), "PAPER-ANSWER", message);
    assert.lengthOf(
      paperHistory.stored.filter((entry) => entry.role === "user"),
      1,
      `one stored question in the paper conversation: ${message}`,
    );
    assert.lengthOf(
      libHistory.stored.filter((entry) => entry.role === "user"),
      1,
      `one stored question in the library conversation: ${message}`,
    );

    await Zotero.Promise.delay(300);
    state = sidebarState();
    assert.equal(state.conversationKind, "paper", JSON.stringify(state));
    assert.equal(state.conversationKey, paperKey, JSON.stringify(state));
    const sidebarChat = textOf(sidebarBody()!.querySelector("#llm-chat-box"));
    const windowChat = textOf(windowBody()!.querySelector("#llm-chat-box"));
    assert.include(sidebarChat, "PAPER-ANSWER-TWO", "sidebar shows its answer");
    assert.notInclude(
      sidebarChat,
      "LIBRARY-ANSWER",
      "no window text in sidebar",
    );
    assert.include(windowChat, "LIBRARY-ANSWER-TWO", "window shows its answer");
    assert.notInclude(windowChat, "PAPER-ANSWER", "no sidebar text in window");
  });

  // ── T3 ───────────────────────────────────────────────────────────────────

  /**
   * Seeds the paper conversation from the sidebar, opens the window on the
   * same conversation, starts a held answer there, and returns once the
   * window shows the first chunk.
   */
  async function startSharedConversationStream(title: string) {
    const paper = await newFixture(title);
    await openSidebarChat(paper.parentItemId);
    await ensureSidebarPaperChat(paper.parentItemId);
    const key = await completeSidebarTurn(
      `${title} seed question`,
      "SEED-ANSWER",
    );
    await api.openStandaloneForItem(paper.parentItemId);
    await ensureWindowShowsConversation(key);
    const QUESTION = `${title} shared question MIRROR-Q`;
    typeAndSend(windowBody()!, QUESTION);
    const stream = await provider.waitForStream(QUESTION);
    stream.push("MIRROR-PART-ONE ");
    await until(
      () => lastAssistantBubbleText(windowRoot()).includes("MIRROR-PART-ONE"),
      () =>
        `the window shows the partial answer: ${JSON.stringify(windowState())}`,
    );
    return { paper, key, stream, question: QUESTION };
  }

  /** The sidebar shows the shared conversation (switching via its history if needed). */
  async function showConversationInSidebar(key: number): Promise<void> {
    assertSidebarLive("while the window streams the shared conversation");
    if (toKey(sidebarRoot()?.dataset.itemId) === key) return;
    const body = sidebarBody()!;
    (body.querySelector("#llm-history-toggle") as HTMLElement).click();
    let row: HTMLElement | null = null;
    await until(
      () => {
        row = body.querySelector<HTMLElement>(
          `#llm-history-menu .llm-history-item[data-conversation-key="${key}"]`,
        );
        return Boolean(row);
      },
      () => `the sidebar history lists conversation ${key}`,
    );
    row!.click();
    await until(
      () => toKey(sidebarRoot()?.dataset.itemId) === key,
      () =>
        `the sidebar shows conversation ${key}: ${JSON.stringify(sidebarState())}`,
    );
  }

  it("T3a: the same conversation in both surfaces mirrors a streaming answer to the end", async function () {
    const { key, stream } = await startSharedConversationStream("Coexist T3a");
    await showConversationInSidebar(key);
    await until(
      () => lastAssistantBubbleText(sidebarRoot()).includes("MIRROR-PART-ONE"),
      () =>
        `the sidebar shows the partial answer started in the window: ${JSON.stringify(sidebarState())}`,
    );
    stream.push("MIRROR-PART-TWO");
    await until(
      () => lastAssistantBubbleText(sidebarRoot()).includes("MIRROR-PART-TWO"),
      () =>
        `the sidebar keeps receiving streamed text: ${JSON.stringify(sidebarState())}`,
    );
    stream.finish();
    await waitForAnswer(key, "MIRROR-PART-ONE MIRROR-PART-TWO");
    await until(
      () =>
        !sidebarRoot()?.querySelector(".llm-bubble.assistant.streaming") &&
        !windowRoot()?.querySelector(".llm-bubble.assistant.streaming") &&
        lastAssistantBubbleText(sidebarRoot()) ===
          lastAssistantBubbleText(windowRoot()),
      () =>
        `both surfaces end with the same final answer: ${JSON.stringify({
          sidebar: lastAssistantBubbleText(sidebarRoot()),
          window: lastAssistantBubbleText(windowRoot()),
        })}`,
    );
    assert.include(
      lastAssistantBubbleText(sidebarRoot()),
      "MIRROR-PART-ONE MIRROR-PART-TWO",
    );
  });

  it("T3b: a busy shared conversation refuses a second send from the sidebar, and the sidebar's Stop stops it for both", async function () {
    const { key, stream } = await startSharedConversationStream("Coexist T3b");
    await showConversationInSidebar(key);
    await until(
      () => lastAssistantBubbleText(sidebarRoot()).includes("MIRROR-PART-ONE"),
      () =>
        `the sidebar shows the partial answer started in the window: ${JSON.stringify(sidebarState())}`,
    );

    const requestsBefore = provider.streams.length;
    const usersBefore = (await history(key)).memory.filter(
      (entry) => entry.role === "user",
    ).length;
    pressEnter(sidebarBody()!, "Coexist T3b second question BUSY-Q");
    await Zotero.Promise.delay(1200);
    const afterBusy = await history(key);
    assert.equal(
      provider.streams.length,
      requestsBefore,
      `no second provider request while the conversation is busy: ${JSON.stringify(
        provider.streams.map((s) => s.lastUserText.slice(0, 80)),
      )}`,
    );
    assert.equal(
      afterBusy.memory.filter((entry) => entry.role === "user").length,
      usersBefore,
      `no second question joins the busy conversation: ${JSON.stringify(afterBusy.memory)}`,
    );
    assert.isFalse(stream.ended, "the first answer is still streaming");

    const cancel = sidebarBody()!.querySelector(
      "#llm-cancel",
    ) as HTMLButtonElement | null;
    assert.isOk(cancel, "the sidebar has a Stop button");
    assert.notEqual(
      cancel!.style.display,
      "none",
      `the sidebar offers Stop for the shared busy conversation: ${JSON.stringify(sidebarState())}`,
    );
    cancel!.click();
    await until(
      () => stream.aborted,
      () => "Stop from the sidebar aborts the provider stream",
    );
    await until(
      () => {
        const sidebarBubble = bubbleContaining(
          sidebarRoot(),
          "MIRROR-PART-ONE",
        );
        const windowBubble = bubbleContaining(windowRoot(), "MIRROR-PART-ONE");
        return Boolean(
          sidebarBubble &&
          windowBubble &&
          !sidebarBubble.classList.contains("streaming") &&
          !windowBubble.classList.contains("streaming"),
        );
      },
      () =>
        `the stopped answer is final in both surfaces: ${JSON.stringify({
          sidebar: sidebarState(),
          window: windowState(),
        })}`,
    );
    const windowCancel = windowBody()!.querySelector(
      "#llm-cancel",
    ) as HTMLElement | null;
    await until(
      () => windowCancel?.style.display === "none",
      () =>
        "the window no longer offers Stop once the sidebar stopped the answer",
    );
  });

  // ── T4 ───────────────────────────────────────────────────────────────────

  it("T4: closing the window leaves the sidebar panel, its draft and its scroll untouched", async function () {
    const paper = await newFixture("Coexist T4");
    await openSidebarChat(paper.parentItemId);
    await ensureSidebarPaperChat(paper.parentItemId);
    const longAnswer = Array.from(
      { length: 60 },
      (_, index) =>
        `Paragraph ${index + 1} LONG-ANSWER: enough text to make the sidebar chat scroll.`,
    ).join("\n\n");
    await completeSidebarTurn("Coexist T4 long question", longAnswer);

    await api.openStandaloneForItem(paper.parentItemId);
    await api.clickStandaloneTab("open");
    await Zotero.Promise.delay(300);
    const root = assertSidebarLive("after opening the window");
    const body = root.parentElement!;
    const input = body.querySelector("#llm-input") as HTMLTextAreaElement;
    const DRAFT = "Coexist T4 draft that must survive the window closing";
    input.value = DRAFT;
    input.dispatchEvent(
      new (body.ownerDocument.defaultView as any).Event("input", {
        bubbles: true,
      }),
    );
    const chatBox = body.querySelector("#llm-chat-box") as HTMLElement;
    assert.isAbove(
      chatBox.scrollHeight,
      chatBox.clientHeight + 100,
      "the sidebar chat is scrollable",
    );
    chatBox.scrollTop = Math.floor(
      (chatBox.scrollHeight - chatBox.clientHeight) / 2,
    );
    chatBox.dispatchEvent(
      new (body.ownerDocument.defaultView as any).Event("scroll"),
    );
    await Zotero.Promise.delay(400);
    const scrollBefore = chatBox.scrollTop;

    await api.closeStandalone();
    await Zotero.Promise.delay(1000);

    const after = sidebarRoot();
    assert.strictEqual(
      after,
      root,
      `closing the window must not rebuild the sidebar panel: ${JSON.stringify(sidebarState())}`,
    );
    assert.isTrue(root.isConnected, "the sidebar panel stays connected");
    assert.strictEqual(
      root.parentElement!.querySelector("#llm-input"),
      input,
      "the sidebar composer is the same element",
    );
    assert.equal(input.value, DRAFT, "the sidebar draft is preserved");
    assert.strictEqual(
      root.parentElement!.querySelector("#llm-chat-box"),
      chatBox,
      "the sidebar chat box is the same element",
    );
    assert.closeTo(
      chatBox.scrollTop,
      scrollBefore,
      2,
      "the sidebar chat keeps its scroll position",
    );
  });

  // ── T5 ───────────────────────────────────────────────────────────────────

  it("T5: a model chosen in the window does not change the sidebar's model", async function () {
    const paper = await newFixture("Coexist T5");
    await openSidebarChat(paper.parentItemId);
    await ensureSidebarPaperChat(paper.parentItemId);
    const labelA = getModelEntryById(ENTRY_A)?.displayModelLabel || MODEL_A;
    await until(
      () => sidebarState().modelLabel.includes(MODEL_A),
      () =>
        `the sidebar starts on ${labelA}: ${JSON.stringify(sidebarState())}`,
    );

    await api.openStandaloneForItem(paper.parentItemId);
    await api.clickStandaloneTab("open");
    await Zotero.Promise.delay(300);
    assertSidebarLive("after opening the window");

    await selectWindowModel(ENTRY_B, MODEL_B);
    await Zotero.Promise.delay(400);
    const state = sidebarState();
    assert.include(
      state.modelLabel,
      MODEL_A,
      `the sidebar keeps its own model after the window chose ${MODEL_B}: ${JSON.stringify(state)}`,
    );
    assert.notInclude(state.modelLabel, MODEL_B, JSON.stringify(state));

    const QUESTION = "Coexist T5 sidebar question MODEL-Q";
    typeAndSend(sidebarBody()!, QUESTION);
    const stream = await provider.waitForStream(QUESTION);
    const requestedModel = stream.model;
    stream.push("MODEL-ANSWER");
    stream.finish();
    assert.equal(
      requestedModel,
      MODEL_A,
      "the sidebar's next send uses the sidebar's model, not the window's",
    );
    await waitForAnswer(toKey(sidebarRoot()?.dataset.itemId), "MODEL-ANSWER");
  });

  it("T5b: a model the sidebar chooses after the window opened does not change the window's model", async function () {
    const paper = await newFixture("Coexist T5b");
    await openSidebarChat(paper.parentItemId);
    await ensureSidebarPaperChat(paper.parentItemId);
    await until(
      () => sidebarState().modelLabel.includes(MODEL_A),
      () =>
        `the sidebar starts on ${MODEL_A}: ${JSON.stringify(sidebarState())}`,
    );

    await api.openStandaloneForItem(paper.parentItemId);
    await api.clickStandaloneTab("open");
    await until(
      () => windowState().modelLabel.includes(MODEL_A),
      () =>
        `the window opens on the sidebar's ${MODEL_A}: ${JSON.stringify(windowState())}`,
    );
    assertSidebarLive("after opening the window");

    // The window never chose a model; the sidebar now does.
    await selectPanelModel(sidebarBody()!, ENTRY_B, MODEL_B, "sidebar");
    assert.equal(
      Zotero.Prefs.get(PREF_PREFIX + "lastUsedModelEntryId", true),
      ENTRY_B,
      "the sidebar's choice is saved",
    );
    await Zotero.Promise.delay(400);
    const state = windowState();
    assert.include(
      state.modelLabel,
      MODEL_A,
      `the window keeps the model it opened with after the sidebar chose ${MODEL_B}: ${JSON.stringify(state)}`,
    );
    assert.notInclude(state.modelLabel, MODEL_B, JSON.stringify(state));

    const QUESTION = "Coexist T5b window question SNAPSHOT-Q";
    typeAndSend(windowBody()!, QUESTION);
    const stream = await provider.waitForStream(QUESTION);
    const requestedModel = stream.model;
    stream.push("SNAPSHOT-ANSWER");
    stream.finish();
    assert.equal(
      requestedModel,
      MODEL_A,
      "the window's next send uses the model it opened with, not the sidebar's later choice",
    );
    await waitForAnswer(toKey(windowRoot()?.dataset.itemId), "SNAPSHOT-ANSWER");
  });

  // ── T6 ───────────────────────────────────────────────────────────────────

  it("T6: each surface remembers its own conversation and its own Paper/Library mode", async function () {
    const paper = await newFixture("Coexist T6 paper");
    const other = await newFixture("Coexist T6 other");
    await openSidebarChat(paper.parentItemId);
    await ensureSidebarPaperChat(paper.parentItemId);
    const sidebarKey = await completeSidebarTurn(
      "Coexist T6 seed question",
      "T6-SEED-ANSWER",
    );

    await api.openStandaloneForItem(paper.parentItemId);
    const fresh = await api.startNewStandaloneConversation();
    assert.notEqual(
      fresh.conversationKey,
      sidebarKey,
      `the window started a new chat: ${JSON.stringify(fresh)}`,
    );

    await selectMainItem(other.parentItemId);
    await Zotero.Promise.delay(400);
    await selectMainItem(paper.parentItemId);
    await until(
      () => {
        const state = sidebarState();
        return (
          !state.placeholder &&
          state.conversationKind === "paper" &&
          state.basePaperItemId === paper.parentItemId &&
          state.conversationKey > 0
        );
      },
      () =>
        `the sidebar re-renders Paper chat for the paper: ${JSON.stringify(sidebarState())}`,
    );
    const back = sidebarState();
    assert.equal(
      back.conversationKey,
      sidebarKey,
      `the sidebar reopens its own conversation, not the window's new chat ${fresh.conversationKey}: ${JSON.stringify(back)}`,
    );

    const library = await api.clickStandaloneTab("open");
    assert.equal(library.conversationKind, "global", JSON.stringify(library));
    await selectMainItem(other.parentItemId);
    await until(
      () => {
        const state = sidebarState();
        return (
          !state.placeholder &&
          state.basePaperItemId === other.parentItemId &&
          state.conversationKey > 0
        );
      },
      () =>
        `the sidebar follows the newly selected paper: ${JSON.stringify(sidebarState())}`,
    );
    const next = sidebarState();
    assert.equal(
      next.conversationKind,
      "paper",
      `the window's switch to Library chat must not open the sidebar's next paper in Library chat: ${JSON.stringify(next)}`,
    );
  });

  // ── T7 ───────────────────────────────────────────────────────────────────

  it("T7: reader Add Text lands in the reader tab's own sidebar, not the window", async function () {
    const SELECTED = "COEXIST_READER_ADD_TEXT_SELECTION";
    const paper = await newFixture("Coexist T7", [
      `The reader page contains ${SELECTED} for routing.`,
    ]);
    await api.openStandaloneForItem(paper.parentItemId);
    const library = await api.clickStandaloneTab("open");
    assert.equal(library.conversationKind, "global", JSON.stringify(library));

    const reader = await openReaderTab(paper.pdfAttachmentId);
    await openReaderSidebarChat(reader);
    const cleanup = await clickReaderAddText(reader, 0, SELECTED);
    try {
      const readerDetails = getReaderContextPanelForTab(
        mainWin().document,
        reader.tabID,
      );
      const readerSection =
        readerDetails?.querySelector(".llm-dedicated-chat-pane") || null;
      const readerBody = () =>
        (readerSection?.querySelector("#llm-main") as HTMLElement | null)
          ?.parentElement || null;
      const describe = () =>
        JSON.stringify({
          readerSidebar: readPanelState(
            readerSection,
            (readerSection?.querySelector("#llm-main") as HTMLElement) || null,
          ),
          readerPreviews: previewTexts(readerBody()),
          windowPreviews: previewTexts(windowBody()),
          window: windowState(),
        });
      // Whichever surface receives it renders the preview within a moment.
      await until(
        () =>
          previewTexts(readerBody()).includes(SELECTED) ||
          previewTexts(windowBody()).includes(SELECTED),
        () => `Add Text reached a chat composer: ${describe()}`,
      );
      await Zotero.Promise.delay(300);
      assert.notInclude(
        previewTexts(windowBody()),
        SELECTED,
        `Add Text must not go to the standalone window: ${describe()}`,
      );
      assert.include(
        previewTexts(readerBody()),
        SELECTED,
        `Add Text goes to the reader tab's own sidebar composer: ${describe()}`,
      );
    } finally {
      cleanup();
    }
  });

  // ── T9 ───────────────────────────────────────────────────────────────────

  /** The panel's user bubble whose text contains `marker`. */
  function userBubble(root: Element | null, marker: string) {
    return (
      (
        Array.from(
          root?.querySelectorAll(
            "#llm-chat-box .llm-message-wrapper.user .llm-bubble.user",
          ) || [],
        ) as HTMLElement[]
      ).find((bubble) => (bubble.textContent || "").includes(marker)) || null
    );
  }

  const editWidgets = (root: Element | null) =>
    Array.from(root?.querySelectorAll(".llm-inline-edit-wrapper") || []);

  /** Where each panel's composer section is: in its own panel, and whether in its edit widget. */
  function composerPlacement(body: HTMLElement | null) {
    const sections = Array.from(
      body?.querySelectorAll(".llm-input-section") || [],
    ) as HTMLElement[];
    return {
      count: sections.length,
      inEditWidget: sections.some((section) =>
        Boolean(section.closest(".llm-inline-edit-wrapper")),
      ),
      sameDocument: sections.every(
        (section) => section.ownerDocument === body?.ownerDocument,
      ),
    };
  }

  async function openEditIn(root: () => HTMLElement | null, marker: string) {
    let bubble: HTMLElement | null = null;
    await until(
      () => {
        bubble = userBubble(root(), marker);
        return Boolean(bubble?.classList.contains("llm-bubble-editable"));
      },
      () => `the prompt "${marker}" is editable`,
    );
    bubble!.click();
    await until(
      () => editWidgets(root()).length === 1,
      () =>
        `the panel shows the edit widget for "${marker}": ${JSON.stringify(
          composerPlacement(root()?.parentElement || null),
        )}`,
    );
  }

  it("T9a: a message edit open in the window does not take over a send from the sidebar", async function () {
    const paper = await newFixture("Coexist T9a");
    await openSidebarChat(paper.parentItemId);
    await ensureSidebarPaperChat(paper.parentItemId);
    const sidebarKey = await completeSidebarTurn(
      "Coexist T9a sidebar seed EDIT-SIDEBAR-SEED",
      "T9A-SIDEBAR-SEED-ANSWER",
    );

    await api.openStandaloneForItem(paper.parentItemId);
    await api.clickStandaloneTab("open");
    const WINDOW_Q = "Coexist T9a window prompt EDIT-WINDOW-PROMPT";
    typeAndSend(windowBody()!, WINDOW_Q);
    const windowStream = await provider.waitForStream(WINDOW_Q);
    windowStream.push("T9A-WINDOW-ANSWER");
    windowStream.finish();
    const windowKey = toKey(windowRoot()?.dataset.itemId);
    assert.notEqual(windowKey, sidebarKey, "two different conversations");
    await waitForAnswer(windowKey, "T9A-WINDOW-ANSWER");

    await openEditIn(windowRoot, "EDIT-WINDOW-PROMPT");
    assert.lengthOf(
      editWidgets(sidebarRoot()),
      0,
      "the sidebar is not editing",
    );

    const SIDEBAR_Q = "Coexist T9a sidebar follow-up EDIT-SIDEBAR-Q";
    pressEnter(sidebarBody()!, SIDEBAR_Q);
    const sidebarStream = await provider.waitForStream(SIDEBAR_Q, 10_000);
    sidebarStream.push("T9A-SIDEBAR-ANSWER");
    sidebarStream.finish();
    await waitForAnswer(sidebarKey, "T9A-SIDEBAR-ANSWER");

    const sidebarHistory = await history(sidebarKey);
    const windowHistory = await history(windowKey);
    assert.include(
      sidebarHistory.memory.map((entry) => entry.text).join("\n"),
      SIDEBAR_Q,
      JSON.stringify(sidebarHistory.memory),
    );
    assert.notInclude(
      windowHistory.memory.map((entry) => entry.text).join("\n"),
      SIDEBAR_Q,
      "the sidebar's message is not taken as the window's edit",
    );
    assert.lengthOf(
      editWidgets(windowRoot()),
      1,
      "the window's edit stays open after the sidebar sent",
    );
    const windowComposer = composerPlacement(windowBody());
    assert.deepEqual(
      windowComposer,
      { count: 1, inEditWidget: true, sameDocument: true },
      "the window's composer stays in the window's edit widget",
    );
    assert.deepEqual(
      composerPlacement(sidebarBody()),
      { count: 1, inEditWidget: false, sameDocument: true },
      "the sidebar's composer stays in place",
    );
  });

  it("T9b: the same conversation in both surfaces shows the edit only where it was opened, and a send from the other surface ends it", async function () {
    const paper = await newFixture("Coexist T9b");
    await openSidebarChat(paper.parentItemId);
    await ensureSidebarPaperChat(paper.parentItemId);
    const SEED = "Coexist T9b shared prompt EDIT-SHARED-PROMPT";
    const key = await completeSidebarTurn(SEED, "T9B-SEED-ANSWER");
    await api.openStandaloneForItem(paper.parentItemId);
    await ensureWindowShowsConversation(key);
    await showConversationInSidebar(key);

    await openEditIn(windowRoot, "EDIT-SHARED-PROMPT");
    await Zotero.Promise.delay(400);
    assert.lengthOf(
      editWidgets(sidebarRoot()),
      0,
      "the sidebar shows the conversation without the window's edit widget",
    );
    assert.isOk(
      userBubble(sidebarRoot(), "EDIT-SHARED-PROMPT"),
      "the sidebar still shows the prompt as a normal message",
    );
    assert.deepEqual(
      composerPlacement(sidebarBody()),
      { count: 1, inEditWidget: false, sameDocument: true },
      "the sidebar keeps its own composer",
    );
    assert.deepEqual(
      composerPlacement(windowBody()),
      { count: 1, inEditWidget: true, sameDocument: true },
      "the window's own composer is in its edit widget",
    );

    // The window types into its edit; then the sidebar sends into the shared
    // conversation. Sending the edit later would cut the sidebar's turn off,
    // so the window's edit ends as that turn starts, and what the window
    // typed stays in its composer.
    const TYPED = "Coexist T9b typed edit EDIT-SHARED-TYPED";
    const windowInput = windowBody()!.querySelector(
      "#llm-input",
    ) as HTMLTextAreaElement;
    windowInput.value = TYPED;
    windowInput.dispatchEvent(
      new (windowInput.ownerDocument.defaultView as any).Event("input", {
        bubbles: true,
      }),
    );
    const SIDEBAR_Q = "Coexist T9b sidebar question EDIT-SHARED-SIDEBAR-Q";
    pressEnter(sidebarBody()!, SIDEBAR_Q);
    const sidebarStream = await provider.waitForStream(SIDEBAR_Q, 10_000);
    sidebarStream.push("T9B-SIDEBAR-PART ");
    await until(
      () =>
        lastAssistantBubbleText(windowRoot()).includes("T9B-SIDEBAR-PART") &&
        editWidgets(windowRoot()).length === 0,
      () =>
        `the window's edit ends and it mirrors the sidebar's streaming answer: ${JSON.stringify(
          {
            window: composerPlacement(windowBody()),
            widgets: editWidgets(windowRoot()).length,
          },
        )}`,
    );
    assert.deepEqual(
      composerPlacement(windowBody()),
      { count: 1, inEditWidget: false, sameDocument: true },
      "the window's composer is back in place",
    );
    assert.equal(
      (windowBody()!.querySelector("#llm-input") as HTMLTextAreaElement).value,
      TYPED,
      "what the window typed in its edit stays in its composer",
    );
    sidebarStream.push("T9B-SIDEBAR-END");
    sidebarStream.finish();
    await waitForAnswer(key, "T9B-SIDEBAR-END");
    await Zotero.Promise.delay(100);
    assert.equal(
      (windowBody()!.querySelector("#llm-input") as HTMLTextAreaElement).value,
      TYPED,
      "the window's typed text survives the end of the sidebar's turn",
    );

    // The window sends the kept text as a new message after the sidebar's
    // turn: one request, and the sidebar's turn is not cut off.
    const requestsBefore = provider.streams.length;
    pressEnter(windowBody()!, TYPED);
    const typedStream = await provider.waitForStream(TYPED, 10_000);
    typedStream.push("T9B-TYPED-ANSWER");
    typedStream.finish();
    await waitForAnswer(key, "T9B-TYPED-ANSWER");
    assert.equal(
      provider.streams.length,
      requestsBefore + 1,
      "the window's send is one request",
    );
    const finalHistory = await history(key);
    const texts = finalHistory.memory.map((entry) => entry.text);
    const order = [SEED, SIDEBAR_Q, TYPED].map((text) =>
      texts.findIndex((entry) => String(entry).includes(text)),
    );
    assert.isTrue(
      order.every(
        (index, i) => index >= 0 && (i === 0 || index > order[i - 1]),
      ),
      `the seed, the sidebar's question and the window's text are all kept, in order: ${JSON.stringify(texts)}`,
    );
    await until(
      () =>
        Boolean(userBubble(sidebarRoot(), "EDIT-SHARED-TYPED")) &&
        lastAssistantBubbleText(sidebarRoot()).includes("T9B-TYPED-ANSWER"),
      () =>
        `the window's message shows in the sidebar: ${JSON.stringify(
          sidebarState(),
        )}`,
    );
    assert.lengthOf(editWidgets(windowRoot()), 0, "no edit is open");
    assert.deepEqual(
      composerPlacement(sidebarBody()),
      { count: 1, inEditWidget: false, sameDocument: true },
      "the sidebar's composer never moved",
    );
  });

  // ── T10 ──────────────────────────────────────────────────────────────────

  /** The title the window's conversation list shows for `key`, or null. */
  function windowListTitle(key: number): string | null {
    const row = standaloneWin()?.document.querySelector(
      `.llm-standalone-conv-item[data-conversation-key="${key}"]`,
    );
    return row
      ? textOf(row.querySelector(".llm-standalone-conv-title") || row)
      : null;
  }

  /** The title the sidebar's history menu holds for `key` (menu closed), or null. */
  function sidebarHistoryTitle(key: number): string | null {
    const row = sidebarBody()?.querySelector(
      `#llm-history-menu .llm-history-item[data-conversation-key="${key}"]`,
    );
    return row
      ? textOf(row.querySelector(".llm-history-item-title") || row)
      : null;
  }

  async function confirmRenameDialog(doc: Document, title: string) {
    let input: HTMLInputElement | null = null;
    await until(
      () => {
        input = doc.querySelector<HTMLInputElement>(
          ".llm-conversation-rename-input",
        );
        return Boolean(input);
      },
      () => "the rename dialog opens",
    );
    input!.value = title;
    input!.dispatchEvent(
      new (doc.defaultView as any).Event("input", { bubbles: true }),
    );
    doc
      .querySelector<HTMLButtonElement>(
        ".llm-conversation-rename-dialog .llm-modal-primary",
      )!
      .click();
    await until(
      () => !doc.querySelector(".llm-conversation-rename-dialog"),
      () => "the rename dialog closes",
    );
  }

  it("T10a: a chat created and renamed in the sidebar shows up in the window's list without a refresh", async function () {
    const paper = await newFixture("Coexist T10a");
    await openSidebarChat(paper.parentItemId);
    await ensureSidebarPaperChat(paper.parentItemId);
    const seedKey = await completeSidebarTurn(
      "Coexist T10a seed LIST-SEED",
      "T10A-SEED-ANSWER",
    );
    await api.openStandaloneForItem(paper.parentItemId);
    await ensureWindowShowsConversation(seedKey);

    // A new chat in the sidebar, with one turn.
    (sidebarBody()!.querySelector("#llm-history-new") as HTMLElement).click();
    await until(
      () =>
        sidebarState().conversationKey > 0 &&
        sidebarState().conversationKey !== seedKey,
      () => `the sidebar starts a new chat: ${JSON.stringify(sidebarState())}`,
    );
    const newKey = await completeSidebarTurn(
      "Coexist T10a new chat LIST-NEW",
      "T10A-NEW-ANSWER",
    );
    assert.notEqual(newKey, seedKey);
    await until(
      () => windowListTitle(newKey) !== null,
      () =>
        `the window's list shows the sidebar's new chat ${newKey}: ${JSON.stringify(
          Array.from(
            standaloneWin()!.document.querySelectorAll(
              ".llm-standalone-conv-item",
            ),
          ).map((row: any) => [row.dataset.conversationKey, textOf(row)]),
        )}`,
    );

    // Rename it from the sidebar's history menu.
    const TITLE = "Renamed in the sidebar T10A";
    (
      sidebarBody()!.querySelector("#llm-history-toggle") as HTMLElement
    ).click();
    let renameButton: HTMLElement | null = null;
    await until(
      () => {
        renameButton =
          sidebarBody()!.querySelector<HTMLElement>(
            `#llm-history-menu .llm-history-item[data-conversation-key="${newKey}"] .llm-history-item-rename`,
          ) || null;
        return Boolean(renameButton);
      },
      () => "the sidebar's history row offers Rename",
    );
    renameButton!.click();
    await confirmRenameDialog(mainWin().document, TITLE);
    await until(
      () => (windowListTitle(newKey) || "").includes(TITLE),
      () => `the window's list shows the new title: ${windowListTitle(newKey)}`,
    );
  });

  it("T10b: a chat created and renamed in the window shows up in the sidebar's history without a refresh", async function () {
    const paper = await newFixture("Coexist T10b");
    await openSidebarChat(paper.parentItemId);
    await ensureSidebarPaperChat(paper.parentItemId);
    const seedKey = await completeSidebarTurn(
      "Coexist T10b seed LIST-SEED",
      "T10B-SEED-ANSWER",
    );
    await until(
      () => sidebarHistoryTitle(seedKey) !== null,
      () => "the sidebar's history holds its own chat",
    );

    await api.openStandaloneForItem(paper.parentItemId);
    const fresh = await api.startNewStandaloneConversation();
    assert.equal(fresh.conversationKind, "paper", JSON.stringify(fresh));
    const QUESTION = "Coexist T10b window chat LIST-WINDOW";
    typeAndSend(windowBody()!, QUESTION);
    const stream = await provider.waitForStream(QUESTION);
    stream.push("T10B-WINDOW-ANSWER");
    stream.finish();
    const windowKey = toKey(windowRoot()?.dataset.itemId);
    assert.notEqual(windowKey, seedKey);
    await waitForAnswer(windowKey, "T10B-WINDOW-ANSWER");
    await until(
      () => sidebarHistoryTitle(windowKey) !== null,
      () =>
        `the sidebar's history lists the window's new chat ${windowKey}: ${JSON.stringify(
          Array.from(
            sidebarBody()!.querySelectorAll(
              "#llm-history-menu .llm-history-item",
            ),
          ).map((row: any) => [row.dataset.conversationKey, textOf(row)]),
        )}`,
    );

    const TITLE = "Renamed in the window T10B";
    const doc = standaloneWin()!.document;
    doc
      .querySelector<HTMLElement>(
        `.llm-standalone-conv-item[data-conversation-key="${windowKey}"] .llm-standalone-conv-rename`,
      )!
      .click();
    await confirmRenameDialog(doc, TITLE);
    await until(
      () => (sidebarHistoryTitle(windowKey) || "").includes(TITLE),
      () =>
        `the sidebar's history shows the new title: ${sidebarHistoryTitle(windowKey)}`,
    );
    assert.equal(
      sidebarState().conversationKey,
      seedKey,
      "the sidebar stays on its own chat",
    );
  });

  // ── T11 / T12: the same chat in both surfaces ──────────────────────────

  /** A paper chat seeded in the sidebar, shown in the window and the sidebar. */
  async function openSharedConversation(
    title: string,
    seedAnswer = "SHARED-SEED-ANSWER",
  ) {
    const paper = await newFixture(title);
    await openSidebarChat(paper.parentItemId);
    await ensureSidebarPaperChat(paper.parentItemId);
    const key = await completeSidebarTurn(`${title} seed question`, seedAnswer);
    await api.openStandaloneForItem(paper.parentItemId);
    await ensureWindowShowsConversation(key);
    await showConversationInSidebar(key);
    return { paper, key };
  }

  function taskRow(body: HTMLElement | null) {
    const row = body?.querySelector("#llm-task-progress") as HTMLElement | null;
    return {
      shown: Boolean(row && !row.hidden && !row.closest("[hidden]")),
      state: row?.dataset.state || "",
    };
  }

  function hitlCard(body: HTMLElement | null, requestId: string) {
    return (
      (body?.querySelector(
        `#llm-chat-box .llm-agent-hitl-card[data-request-id="${requestId}"]`,
      ) as HTMLElement | null) || null
    );
  }

  it("T11: a run in a chat open in both surfaces shows its Task progress and its approval in both, and settles once", async function () {
    const { paper, key } = await openSharedConversation("Coexist T11");
    const folder = new Zotero.Collection();
    folder.libraryID = Zotero.Libraries.userLibraryID;
    folder.name = `Coexist T11 folder ${Date.now()}`;
    await folder.saveTx();
    const paperItem = Zotero.Items.get(paper.parentItemId);
    paperItem.setCollections([folder.id]);
    await paperItem.saveTx();
    const agentApi = (Zotero as any).LLMForZotero.api.agent;
    const handle = await api.startTaskProgressReplay({
      surface: "standalone",
      followUp: true,
      question: "Coexist T11 what does the folder say?",
      user: {
        selectedCollectionContexts: [
          {
            collectionId: folder.id,
            name: folder.name,
            libraryID: folder.libraryID,
          },
        ],
      },
    });
    try {
      assert.equal(
        handle.conversationKey,
        key,
        "the run is in the shared chat",
      );
      const describe = () =>
        JSON.stringify({
          window: taskRow(windowBody()),
          sidebar: taskRow(sidebarBody()),
          snapshot: api.getTaskProgressSnapshot(key)?.runState,
        });
      await until(
        () => {
          api.flushTaskProgress();
          return (
            taskRow(windowBody()).shown &&
            taskRow(sidebarBody()).shown &&
            taskRow(windowBody()).state === "working" &&
            taskRow(sidebarBody()).state === "working"
          );
        },
        () => `both surfaces show the working run: ${describe()}`,
      );

      // The run asks for approval; the sidebar approves it.
      const requestId = `coexist-t11-${Date.now()}`;
      const resolutions: unknown[] = [];
      agentApi.registerPendingConfirmation(requestId, (resolution: unknown) =>
        resolutions.push(resolution),
      );
      await handle.emit({
        type: "confirmation_required",
        requestId,
        action: {
          toolName: "workflow_probe",
          title: "Coexist probe action",
          mode: "approval",
          confirmLabel: "Apply",
          cancelLabel: "Cancel",
          fields: [],
        },
      } as any);
      await until(
        () =>
          Boolean(hitlCard(windowBody(), requestId)) &&
          Boolean(hitlCard(sidebarBody(), requestId)),
        () =>
          `the approval shows in both surfaces: ${JSON.stringify({
            window: Boolean(hitlCard(windowBody(), requestId)),
            sidebar: Boolean(hitlCard(sidebarBody(), requestId)),
          })}`,
      );
      const approve = hitlCard(sidebarBody(), requestId)!.querySelector(
        '[data-kind="save"]',
      ) as HTMLButtonElement;
      assert.isOk(approve, "the sidebar's card offers Apply");
      approve.click();
      await until(
        () => resolutions.length === 1,
        () => "the sidebar's Apply settles the approval",
      );
      assert.isTrue(
        (resolutions[0] as any).approved,
        JSON.stringify(resolutions),
      );
      // The window's copy cannot settle it a second time.
      (
        hitlCard(windowBody(), requestId)?.querySelector(
          '[data-kind="save"]',
        ) as HTMLButtonElement | null
      )?.click();
      await handle.emit({
        type: "confirmation_resolved",
        requestId,
        approved: true,
      } as any);
      await Zotero.Promise.delay(300);
      assert.lengthOf(resolutions, 1, "the approval settles once");
      await until(
        () =>
          !hitlCard(windowBody(), requestId)?.querySelector(
            '[data-kind="save"]:not([disabled])',
          ) &&
          !hitlCard(sidebarBody(), requestId)?.querySelector(
            '[data-kind="save"]:not([disabled])',
          ),
        () =>
          `neither surface still offers Apply once it is settled: ${JSON.stringify(
            [windowBody(), sidebarBody()].map((panel) => {
              const card = hitlCard(panel, requestId);
              return card
                ? {
                    inline: Boolean(card.closest(".llm-action-inline-card")),
                    className: card.className,
                    status: textOf(card).slice(0, 160),
                    applyDisabled: (
                      card.querySelector(
                        '[data-kind="save"]',
                      ) as HTMLButtonElement | null
                    )?.disabled,
                  }
                : null;
            }),
          )}`,
      );

      await handle.emit({ type: "final", text: "COEXIST-T11-FINAL" } as any);
      handle.refreshChat();
      handle.finish();
      await until(
        () => {
          api.flushTaskProgress();
          return (
            taskRow(windowBody()).state === "completed" &&
            taskRow(sidebarBody()).state === "completed"
          );
        },
        () => `both surfaces show the run finished: ${describe()}`,
      );
      await until(
        () =>
          lastAssistantBubbleText(sidebarRoot()).includes(
            "COEXIST-T11-FINAL",
          ) &&
          lastAssistantBubbleText(windowRoot()).includes("COEXIST-T11-FINAL"),
        () => "both surfaces show the final answer",
      );
    } finally {
      handle.finish();
      await folder.eraseTx().catch(() => undefined);
    }
  });

  it("T12: while the window streams into a chat the sidebar also shows, the sidebar keeps its scroll and focus", async function () {
    const longAnswer = Array.from(
      { length: 60 },
      (_, index) =>
        `Paragraph ${index + 1} SHARED-LONG: enough text to make both chats scroll.`,
    ).join("\n\n");
    const { key } = await openSharedConversation("Coexist T12", longAnswer);
    const body = sidebarBody()!;
    const chatBox = body.querySelector("#llm-chat-box") as HTMLElement;
    const input = body.querySelector("#llm-input") as HTMLTextAreaElement;
    assert.isAbove(
      chatBox.scrollHeight,
      chatBox.clientHeight + 100,
      "the sidebar chat is scrollable",
    );
    chatBox.scrollTop = Math.floor(
      (chatBox.scrollHeight - chatBox.clientHeight) / 2,
    );
    chatBox.dispatchEvent(
      new (body.ownerDocument.defaultView as any).Event("scroll"),
    );
    input.focus();
    await Zotero.Promise.delay(400);
    const scrollBefore = chatBox.scrollTop;
    const mainDoc = mainWin().document;
    assert.strictEqual(
      mainDoc.activeElement,
      input,
      "the sidebar composer has the focus",
    );

    const QUESTION = "Coexist T12 window question SCROLL-Q";
    typeAndSend(windowBody()!, QUESTION);
    const stream = await provider.waitForStream(QUESTION);
    for (let n = 0; n < 8; n++) {
      stream.push(`Streamed paragraph ${n} SCROLL-PART with more words.\n\n`);
      await Zotero.Promise.delay(120);
      assert.closeTo(
        chatBox.scrollTop,
        scrollBefore,
        2,
        `the sidebar does not move while the window streams (chunk ${n})`,
      );
    }
    await until(
      () => lastAssistantBubbleText(sidebarRoot()).includes("SCROLL-PART"),
      () => "the sidebar mirrors the streaming answer",
    );
    stream.finish();
    await waitForAnswer(key, "SCROLL-PART");
    await Zotero.Promise.delay(400);
    assert.closeTo(
      chatBox.scrollTop,
      scrollBefore,
      2,
      "the sidebar keeps its reading place after the answer ends",
    );
    assert.strictEqual(
      mainDoc.activeElement,
      input,
      "the sidebar composer keeps the focus",
    );
    assert.strictEqual(
      body.querySelector("#llm-chat-box"),
      chatBox,
      "the sidebar chat box is the same element",
    );
  });

  // ── T8 ───────────────────────────────────────────────────────────────────

  /**
   * D1 for the backend. Codex runs here without an account: switching only
   * changes the panel's conversation system and model menu, and no Codex turn
   * is sent. The Claude Code bridge gates are covered by unit tests
   * (externalBackendBridge.conversationSystemGate.test.ts), since the test
   * profile has no bridge to answer.
   */
  // ── T13 ──────────────────────────────────────────────────────────────────

  const WEBCHAT_GROUP_ID = "workflow-coexist-webchat-group";
  const WEBCHAT_ENTRY = "workflow-coexist-webchat-model";
  const apiModelGroup = () => ({
    id: GROUP_ID,
    authMode: "api_key",
    apiBase: API_BASE,
    apiKey: "workflow-dummy-key",
    providerProtocol: "openai_chat_compat",
    models: [
      {
        id: ENTRY_A,
        model: MODEL_A,
        temperature: 0.3,
        outputTokenLimit: { mode: "auto" },
      },
      {
        id: ENTRY_B,
        model: MODEL_B,
        temperature: 0.3,
        outputTokenLimit: { mode: "auto" },
      },
    ],
  });

  /** Offers a ChatGPT WebChat model (as webchatModeSwitching does; no account needed). */
  function offerWebChatModel(): void {
    setModelProviderGroups([
      apiModelGroup(),
      {
        id: WEBCHAT_GROUP_ID,
        apiBase: "",
        apiKey: "",
        authMode: "webchat",
        providerProtocol: "web_sync",
        models: [
          {
            id: WEBCHAT_ENTRY,
            model: "chatgpt.com",
            temperature: 0.7,
            maxTokens: 4096,
          },
        ],
      },
    ] as any);
  }

  async function pickSidebarWebChat(): Promise<void> {
    const body = sidebarBody()!;
    (body.querySelector("#llm-model-toggle") as HTMLButtonElement).click();
    const selector = `#llm-model-menu .llm-model-option[data-entry-id="${WEBCHAT_ENTRY}"]`;
    let option: HTMLElement | null = null;
    await until(
      () => {
        option =
          body.querySelector<HTMLElement>(selector) ||
          body.ownerDocument.querySelector<HTMLElement>(selector);
        return Boolean(option);
      },
      () => "the sidebar's model menu offers the WebChat model",
    );
    option!.click();
  }

  async function leaveSidebarWebChatAndForgetModel(): Promise<void> {
    const clear = sidebarBody()?.querySelector(
      "#llm-clear",
    ) as HTMLButtonElement | null;
    if (sidebarRoot()?.dataset.webchatMode === "true") clear?.click();
    await until(
      () => sidebarRoot()?.dataset.webchatMode !== "true",
      () => "the sidebar leaves WebChat",
    ).catch(() => undefined);
    setModelProviderGroups([apiModelGroup()] as any);
  }

  async function sessionRowFlag(conversationKey: number, query: any) {
    const rows = (await query.call(
      Zotero.DB,
      "SELECT webchat_session AS webchatSession FROM llm_for_zotero_paper_conversations WHERE conversation_key = ?",
      [conversationKey],
    )) as Array<{ webchatSession: number }>;
    return rows[0]?.webchatSession;
  }

  /** One API turn in the window, asserting the request carries `carried`. */
  async function windowTurnCarrying(
    question: string,
    answer: string,
    carried: string[],
    key: number,
  ): Promise<void> {
    typeAndSend(windowBody()!, question);
    const stream = await provider.waitForStream(question, 10_000);
    for (const text of carried) {
      assert.include(
        stream.requestBody,
        text,
        `the window's API request carries the chat's earlier "${text}"`,
      );
    }
    stream.push(answer);
    stream.finish();
    await waitForAnswer(key, answer);
  }

  it("T13a: WebChat picked in the sidebar leaves the window's API chat of the same paper intact", async function () {
    const paper = await newFixture("Coexist T13a");
    await openSidebarChat(paper.parentItemId);
    await ensureSidebarPaperChat(paper.parentItemId);
    const SEED = "Coexist T13a shared seed WEBCHAT-SHARED-SEED";
    const key = await completeSidebarTurn(SEED, "T13A-SEED-ANSWER");
    await api.openStandaloneForItem(paper.parentItemId);
    await ensureWindowShowsConversation(key);
    await until(
      () => Boolean(userBubble(windowRoot(), "WEBCHAT-SHARED-SEED")),
      () =>
        `the window shows the shared chat: ${JSON.stringify(windowState())}`,
    );
    offerWebChatModel();
    // Hold the sidebar's WebChat session lookup, so the window acts while
    // the sidebar is in WebChat but still on the shared chat.
    const originalQuery = Zotero.DB.queryAsync;
    let releaseSessionLookup!: () => void;
    const sessionLookupGate = new Promise<void>((resolve) => {
      releaseSessionLookup = resolve;
    });
    let lookupStarted = false;
    Zotero.DB.queryAsync = async function (sql: string, ...args: unknown[]) {
      if (
        sql.includes("FROM llm_for_zotero_paper_conversations") &&
        sql.includes("COALESCE(webchat_session, 0) = 1")
      ) {
        lookupStarted = true;
        await sessionLookupGate;
      }
      return Reflect.apply(originalQuery, Zotero.DB, [sql, ...args]);
    };
    try {
      await pickSidebarWebChat();
      await until(
        () => lookupStarted && sidebarRoot()?.dataset.webchatMode === "true",
        () =>
          `the sidebar is in WebChat, looking up its session: ${JSON.stringify({
            lookupStarted,
            sidebar: sidebarState(),
          })}`,
      );

      // The window, still on the API model, sends into the shared chat.
      assert.notEqual(windowRoot()?.dataset.webchatMode, "true");
      await windowTurnCarrying(
        "Coexist T13a window follow-up WEBCHAT-WINDOW-Q",
        "T13A-WINDOW-ANSWER",
        ["WEBCHAT-SHARED-SEED", "T13A-SEED-ANSWER"],
        key,
      );

      // The sidebar moves to its own WebChat session.
      releaseSessionLookup();
      await until(
        () =>
          sidebarRoot()?.dataset.webchatMode === "true" &&
          toKey(sidebarRoot()?.dataset.itemId) > 0 &&
          toKey(sidebarRoot()?.dataset.itemId) !== key,
        () =>
          `the sidebar is in WebChat on its own session: ${JSON.stringify(
            sidebarState(),
          )}`,
      );
      const sessionKey = toKey(sidebarRoot()?.dataset.itemId);
      assert.equal(
        await sessionRowFlag(sessionKey, originalQuery),
        1,
        "the sidebar's WebChat session is a WebChat session row",
      );
      await Zotero.Promise.delay(400);

      // The window keeps the chat and its whole history.
      assert.equal(toKey(windowRoot()?.dataset.itemId), key);
      for (const marker of ["WEBCHAT-SHARED-SEED", "WEBCHAT-WINDOW-Q"]) {
        assert.isOk(
          userBubble(windowRoot(), marker),
          `the window still shows "${marker}": ${JSON.stringify(windowState())}`,
        );
      }
      await windowTurnCarrying(
        "Coexist T13a window second WEBCHAT-WINDOW-Q2",
        "T13A-WINDOW-ANSWER-2",
        ["WEBCHAT-SHARED-SEED", "T13A-WINDOW-ANSWER"],
        key,
      );
      assert.equal(
        sidebarRoot()?.dataset.webchatMode,
        "true",
        "the sidebar stays in WebChat",
      );
      assert.equal(toKey(sidebarRoot()?.dataset.itemId), sessionKey);
    } finally {
      Zotero.DB.queryAsync = originalQuery;
      releaseSessionLookup();
      await leaveSidebarWebChatAndForgetModel();
    }
  });

  it("T13b: selecting a paper while the sidebar is in WebChat puts the sidebar on the paper's WebChat session and leaves the window's API chat intact", async function () {
    const paper = await newFixture("Coexist T13b");
    const other = await newFixture("Coexist T13b other paper");
    await openSidebarChat(paper.parentItemId);
    await ensureSidebarPaperChat(paper.parentItemId);
    const SEED = "Coexist T13b window chat seed WEBCHAT-MOUNT-SEED";
    const key = await completeSidebarTurn(SEED, "T13B-SEED-ANSWER");
    await api.openStandaloneForItem(paper.parentItemId);
    await ensureWindowShowsConversation(key);
    await until(
      () => Boolean(userBubble(windowRoot(), "WEBCHAT-MOUNT-SEED")),
      () => `the window shows the paper chat: ${JSON.stringify(windowState())}`,
    );
    offerWebChatModel();
    try {
      // The sidebar goes into WebChat on another paper ...
      await openSidebarChat(other.parentItemId);
      await ensureSidebarPaperChat(other.parentItemId);
      await pickSidebarWebChat();
      await until(
        () =>
          sidebarRoot()?.dataset.webchatMode === "true" &&
          toKey(sidebarRoot()?.dataset.itemId) !== other.parentItemId,
        () =>
          `the sidebar is in WebChat on the other paper's session: ${JSON.stringify(
            sidebarState(),
          )}`,
      );
      // ... then the user selects the paper again: the window (which follows
      // the selection in Paper chat) shows its API chat, and the sidebar
      // opens in WebChat on that paper without emptying the window's chat.
      await openSidebarChat(paper.parentItemId);
      await until(
        () => toKey(windowRoot()?.dataset.itemId) === key,
        () =>
          `the window shows the paper's chat again: ${JSON.stringify(windowState())}`,
      );
      await until(
        () =>
          sidebarRoot()?.dataset.webchatMode === "true" &&
          toKey(sidebarRoot()?.dataset.itemId) > 0 &&
          toKey(sidebarRoot()?.dataset.itemId) !== key,
        () =>
          `the sidebar is in WebChat on the paper's own WebChat session: ${JSON.stringify(
            sidebarState(),
          )}`,
      );
      assert.equal(
        await sessionRowFlag(
          toKey(sidebarRoot()?.dataset.itemId),
          Zotero.DB.queryAsync,
        ),
        1,
        "the sidebar's WebChat session is a WebChat session row",
      );
      await Zotero.Promise.delay(400);
      const memory = (await history(key)).memory.map((entry) => entry.text);
      assert.isTrue(
        memory.some((text) => String(text).includes("WEBCHAT-MOUNT-SEED")),
        `the window's chat keeps its history: ${JSON.stringify(memory)}`,
      );
      await windowTurnCarrying(
        "Coexist T13b window follow-up WEBCHAT-MOUNT-Q",
        "T13B-WINDOW-ANSWER",
        ["WEBCHAT-MOUNT-SEED", "T13B-SEED-ANSWER"],
        key,
      );
      assert.isOk(userBubble(windowRoot(), "WEBCHAT-MOUNT-SEED"));
    } finally {
      await leaveSidebarWebChatAndForgetModel();
    }
  });

  it("T8: the window keeps its own backend while the sidebar switches back to the API", async function () {
    const CODEX_TOGGLE =
      ".llm-panel-runtime-system-toggle[data-conversation-system='codex']";
    const savedSystem = () =>
      Zotero.Prefs.get(PREF_PREFIX + "conversationSystem", true);
    Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", true, true);
    try {
      const paper = await newFixture("Coexist T8");
      await openSidebarChat(paper.parentItemId);
      await ensureSidebarPaperChat(paper.parentItemId);
      await until(
        () => sidebarState().modelLabel.includes(MODEL_A),
        () =>
          `the sidebar starts on ${MODEL_A}: ${JSON.stringify(sidebarState())}`,
      );

      await api.openStandaloneForItem(paper.parentItemId);
      await api.clickStandaloneTab("open");
      const codex = await api.clickStandaloneSystemToggle("codex");
      assert.equal(codex.conversationSystem, "codex", JSON.stringify(codex));
      await until(
        () => windowState().conversationSystem === "codex",
        () =>
          `the window's panel is on Codex: ${JSON.stringify(windowState())}`,
      );
      assert.equal(
        savedSystem(),
        "upstream",
        "the window's backend is its own and is not saved as the sidebar's",
      );
      assert.equal(
        sidebarState().conversationSystem,
        "upstream",
        JSON.stringify(sidebarState()),
      );
      const windowModelLabel = windowState().modelLabel;
      assert.isOk(windowModelLabel, JSON.stringify(windowState()));
      assert.notInclude(
        windowModelLabel,
        MODEL_A,
        JSON.stringify(windowState()),
      );

      // The sidebar enters Codex and comes back to the API.
      const sidebarToggle = () =>
        sidebarBody()!.querySelector(CODEX_TOGGLE) as HTMLElement | null;
      assert.isOk(sidebarToggle(), "the sidebar shows the Codex toggle");
      // A toggle is disabled while its switch runs; a click then is dropped.
      const sidebarToggleIdle = () => {
        const toggle = sidebarToggle() as HTMLButtonElement | null;
        return Boolean(toggle && !toggle.disabled);
      };
      sidebarToggle()!.click();
      await until(
        () =>
          sidebarState().conversationSystem === "codex" &&
          sidebarState().conversationKey > 0 &&
          sidebarToggleIdle(),
        () => `the sidebar enters Codex: ${JSON.stringify(sidebarState())}`,
      );
      sidebarToggle()!.click();
      await until(
        () =>
          sidebarState().conversationSystem === "upstream" &&
          sidebarState().conversationKey > 0 &&
          sidebarState().modelLabel.includes(MODEL_A),
        () =>
          `the sidebar returns to the API on ${MODEL_A}: ${JSON.stringify(sidebarState())}`,
      );
      assert.equal(savedSystem(), "upstream");
      await Zotero.Promise.delay(300);

      const windowAfter = windowState();
      assert.equal(
        windowAfter.conversationSystem,
        "codex",
        `the window stays on Codex after the sidebar chose the API: ${JSON.stringify(windowAfter)}`,
      );
      assert.equal(
        windowAfter.modelLabel,
        windowModelLabel,
        `the window's Codex model menu keeps its model: ${JSON.stringify(windowAfter)}`,
      );

      const QUESTION = "Coexist T8 sidebar question BACKEND-Q";
      typeAndSend(sidebarBody()!, QUESTION);
      const stream = await provider.waitForStream(QUESTION);
      const requestedModel = stream.model;
      stream.push("BACKEND-ANSWER");
      stream.finish();
      assert.equal(
        requestedModel,
        MODEL_A,
        "the sidebar's next send goes to its API model",
      );
      await waitForAnswer(
        toKey(sidebarRoot()?.dataset.itemId),
        "BACKEND-ANSWER",
      );
      assert.equal(windowState().conversationSystem, "codex");
    } finally {
      Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", false, true);
    }
  });
});
