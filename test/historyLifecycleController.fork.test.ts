import { assert } from "chai";
import {
  createHistoryLifecycleController,
  type HistoryLifecycleControllerDeps,
} from "../src/modules/contextPanel/setupHandlers/controllers/historyLifecycleController";
import { createGlobalPortalItem } from "../src/modules/contextPanel/portalScope";
import { createClaudePaperPortalItem } from "../src/claudeCode/portal";
import {
  chatHistory,
  conversationForkLinks,
  loadedConversationKeys,
  setPendingRequestId,
} from "../src/modules/contextPanel/state";
import type { Message } from "../src/modules/contextPanel/types";
import {
  conversationRepository,
  type ConversationCatalogEntry,
} from "../src/core/conversations/repository";
import {
  configurePendingDeletionStoreEnv,
  pendingDeletionStore,
  resetPendingDeletionStoreForTests,
} from "../src/core/conversations/pendingDeletionStore";
import {
  configurePendingDeletionSubsystem,
  resetPendingDeletionSubsystemForTests,
} from "../src/modules/contextPanel/pendingDeletionWiring";
import { t } from "../src/utils/i18n";

const LIBRARY_ID = 7;
const SOURCE_CONVERSATION_KEY = 2_000_000_021;
const TARGET_CONVERSATION_KEY = 2_000_000_099;
const PAPER_ITEM_ID = 4_201;

class FakeClassList {
  private readonly tokens = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) this.tokens.add(token);
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) this.tokens.delete(token);
  }

  contains(token: string): boolean {
    return this.tokens.has(token);
  }
}

class FakeStyle {
  display = "";
  height = "";
  maxHeight = "";

  private readonly properties = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.properties.set(name, value);
  }

  getPropertyValue(name: string): string {
    return this.properties.get(name) || "";
  }
}

class FakeElement {
  className = "";
  textContent = "";
  title = "";
  value = "";
  type = "";
  placeholder = "";
  disabled = false;
  readonly classList = new FakeClassList();
  readonly style = new FakeStyle();
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  private readonly eventListeners = new Map<
    string,
    Array<(event: Event) => void>
  >();

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
  ) {}

  set innerHTML(value: string) {
    this.textContent = value;
    this.children.length = 0;
  }

  get innerHTML(): string {
    return this.textContent;
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      if (typeof node === "string") {
        this.textContent += node;
      } else {
        this.appendChild(node);
      }
    }
  }

  appendChild<T extends FakeElement>(child: T): T {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentElement = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) || null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    const listeners = this.eventListeners.get(type) || [];
    listeners.push((event: Event) => {
      if (typeof listener === "function") {
        listener.call(this, event);
      } else {
        listener.handleEvent(event);
      }
    });
    this.eventListeners.set(type, listeners);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.eventListeners.get(event.type) || []) {
      listener(event);
    }
    return !(event as { defaultPrevented?: boolean }).defaultPrevented;
  }

  querySelector(): FakeElement | null {
    return null;
  }

  closest(): FakeElement | null {
    return null;
  }

  focus(): void {
    // No layout in unit tests.
  }

  setSelectionRange(): void {
    // No text selection in unit tests.
  }
}

class FakeDocument {
  readonly defaultView = {
    innerHeight: 800,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    getComputedStyle: () => ({
      backgroundColor: "rgb(255, 255, 255)",
      getPropertyValue: () => "",
    }),
  };
  readonly documentElement: FakeElement;
  readonly body: FakeElement;

  constructor() {
    this.documentElement = new FakeElement(this, "html");
    this.body = new FakeElement(this, "body");
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }
}

function makeMessage(role: Message["role"], text: string, timestamp: number) {
  return { role, text, timestamp } satisfies Message;
}

function makeCatalogEntry(params: {
  conversationKey: number;
  kind?: "global" | "paper";
  title?: string;
  libraryID?: number;
  paperItemID?: number;
  system?: "upstream" | "claude_code" | "codex";
  providerSessionId?: string;
  instanceID?: string;
  userTurnCount?: number;
}): ConversationCatalogEntry {
  return {
    instanceID: params.instanceID,
    conversationID: `test:${params.conversationKey}`,
    conversationKey: params.conversationKey,
    system: params.system || "upstream",
    kind: params.kind || "global",
    libraryID: params.libraryID || LIBRARY_ID,
    paperItemID: params.paperItemID,
    createdAt: 1,
    lastActivityAt: 1,
    title: params.title || "Forked conversation",
    userTurnCount: params.userTurnCount ?? 0,
    providerSessionId: params.providerSessionId,
  };
}

function createControllerHarness(
  options: {
    system?: "upstream" | "claude_code" | "codex";
    item?: Zotero.Item;
    basePaperItem?: Zotero.Item;
    mode?: "global" | "paper";
  } = {},
) {
  const doc = new FakeDocument();
  const body = new FakeElement(doc, "div") as unknown as HTMLElement;
  const panelRoot = new FakeElement(doc, "div") as unknown as HTMLElement;
  const inputBox = new FakeElement(
    doc,
    "textarea",
  ) as unknown as HTMLTextAreaElement;
  const status = new FakeElement(doc, "div") as unknown as HTMLElement;
  const historyUndo = new FakeElement(doc, "div") as unknown as HTMLElement;
  const historyUndoText = new FakeElement(
    doc,
    "span",
  ) as unknown as HTMLElement;
  const topToast = new FakeElement(doc, "div") as unknown as HTMLElement;
  let currentItem: Zotero.Item | null =
    options.item || createGlobalPortalItem(LIBRARY_ID, SOURCE_CONVERSATION_KEY);
  let currentBasePaperItem = options.basePaperItem || null;
  const system = options.system || "upstream";
  const mode = options.mode || "global";

  const deps: HistoryLifecycleControllerDeps = {
    body,
    inputBox,
    panelRoot,
    status,
    historyBar: null,
    titleStatic: null,
    historyNewBtn: null,
    historyNewMenu: null,
    historyNewOpenBtn: null,
    historyNewPaperBtn: null,
    historyToggleBtn: null,
    historyMenu: null,
    historyRowMenu: null,
    historyRowRenameBtn: null,
    historyUndo,
    historyUndoText,
    historyUndoBtn: null,
    topToast,
    modeChipBtn: null,
    getItem: () => currentItem,
    setItem: (item) => {
      currentItem = item;
    },
    getBasePaperItem: () => currentBasePaperItem,
    setBasePaperItem: (item) => {
      currentBasePaperItem = item;
    },
    getConversationSystem: () => system,
    isClaudeConversationSystem: () => system === "claude_code",
    isCodexConversationSystem: () => system === "codex",
    isRuntimeConversationSystem: () => system !== "upstream",
    isNoteSession: () => false,
    isGlobalMode: () => mode === "global",
    isPaperMode: () => mode === "paper",
    isWebChatMode: () => false,
    getCurrentLibraryID: () => LIBRARY_ID,
    resolveCurrentPaperBaseItem: () => currentBasePaperItem,
    getManualPaperContextsForItem: () => [],
    resolveAutoLoadedPaperContext: () => null,
    refreshAutoLoadedPaperContextForCurrentItem: () => undefined,
    persistDraftInputForCurrentConversation: () => undefined,
    restoreDraftInputForCurrentConversation: () => undefined,
    syncConversationIdentity: () => undefined,
    syncQueuedFollowUpRegistration: () => undefined,
    updateRuntimeModeButton: () => undefined,
    refreshChatPreservingScroll: () => undefined,
    resetComposePreviewUI: () => undefined,
    updateModelButton: () => undefined,
    updateReasoningButton: () => undefined,
    updatePaperPreviewPreservingScroll: () => undefined,
    clearForcedSkill: () => undefined,
    closePaperPicker: () => undefined,
    closePromptMenu: () => undefined,
    closeResponseMenu: () => undefined,
    closeRetryModelMenu: () => undefined,
    closeExportMenu: () => undefined,
    closeHistoryRowMenu: () => undefined,
    closeHistoryNewMenu: () => undefined,
    closeHistoryMenu: () => undefined,
    isHistoryMenuOpen: () => false,
    isHistoryNewMenuOpen: () => false,
    runWithChatScrollGuard: (fn) => fn(),
    clearSelectedImageState: () => undefined,
    clearSelectedFileState: () => undefined,
    clearSelectedTextState: () => undefined,
    clearDraftInputState: () => undefined,
    clearTransientComposeStateForItem: () => undefined,
    scheduleAttachmentGc: () => undefined,
    notifyConversationHistoryChanged: () => undefined,
    renderWebChatHistoryMenu: async () => undefined,
    closeModelMenu: () => undefined,
    closeReasoningMenu: () => undefined,
    closeSlashMenu: () => undefined,
    getSelectedModelInfo: () => ({
      selectedEntryId: "",
      selectedEntry: null,
      currentModel: "",
    }),
    markNextWebChatSendAsNewChat: () => undefined,
    primeFreshWebChatPaperChipState: () => undefined,
    updateImagePreviewPreservingScroll: () => undefined,
    switchConversationSystem: async () => undefined,
    setActiveEditSession: () => undefined,
    getCoreAgentRuntime: async () => ({}) as any,
    log: () => undefined,
  };

  return {
    controller: createHistoryLifecycleController(deps),
    item: currentItem,
    historyUndo: historyUndo as unknown as FakeElement,
    historyUndoText: historyUndoText as unknown as FakeElement,
    topToast: topToast as unknown as FakeElement,
    status: status as unknown as FakeElement,
  };
}

describe("historyLifecycleController fork behavior", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, any>;
    ztoolkit?: { log?: (...args: unknown[]) => void };
  };
  let originalZotero: Record<string, any> | undefined;
  let originalZtoolkit: { log?: (...args: unknown[]) => void } | undefined;
  let originalDeleteTurnMessages: typeof conversationRepository.deleteTurnMessages;
  let originalEnsureCatalogEntry: typeof conversationRepository.ensureCatalogEntry;
  let originalForkConversation: typeof conversationRepository.forkConversation;
  let originalGetCatalogEntry: typeof conversationRepository.getCatalogEntry;
  let originalGetCatalogIdentityWitness: typeof conversationRepository.getCatalogIdentityWitness;
  let originalLoadMessages: typeof conversationRepository.loadMessages;

  beforeEach(function () {
    originalZotero = globalScope.Zotero;
    originalZtoolkit = globalScope.ztoolkit;
    originalDeleteTurnMessages = conversationRepository.deleteTurnMessages;
    originalEnsureCatalogEntry = conversationRepository.ensureCatalogEntry;
    originalForkConversation = conversationRepository.forkConversation;
    originalGetCatalogEntry = conversationRepository.getCatalogEntry;
    originalGetCatalogIdentityWitness =
      conversationRepository.getCatalogIdentityWitness;
    originalLoadMessages = conversationRepository.loadMessages;
    globalScope.Zotero = {
      ...(originalZotero || {}),
      locale: "zh-CN",
      Profile: { dir: "/tmp/zotero-profile" },
      Libraries: { userLibraryID: LIBRARY_ID },
      Items: { get: () => null },
      DB: {
        queryAsync: async () => [],
        executeTransaction: async (fn: () => Promise<unknown>) => await fn(),
      },
      debug: () => undefined,
    };
    globalScope.ztoolkit = { log: () => undefined };
    chatHistory.delete(SOURCE_CONVERSATION_KEY);
    chatHistory.delete(TARGET_CONVERSATION_KEY);
    conversationForkLinks.delete(TARGET_CONVERSATION_KEY);
    loadedConversationKeys.delete(SOURCE_CONVERSATION_KEY);
    loadedConversationKeys.delete(TARGET_CONVERSATION_KEY);
    setPendingRequestId(SOURCE_CONVERSATION_KEY, 0);
    resetPendingDeletionStoreForTests();
    configurePendingDeletionStoreEnv({
      setTimer: () => null,
      clearTimer: () => {},
      log: () => {},
    });
    resetPendingDeletionSubsystemForTests();
    configurePendingDeletionSubsystem();
  });

  afterEach(function () {
    resetPendingDeletionStoreForTests();
    resetPendingDeletionSubsystemForTests();
    conversationRepository.deleteTurnMessages = originalDeleteTurnMessages;
    conversationRepository.ensureCatalogEntry = originalEnsureCatalogEntry;
    conversationRepository.forkConversation = originalForkConversation;
    conversationRepository.getCatalogEntry = originalGetCatalogEntry;
    conversationRepository.getCatalogIdentityWitness =
      originalGetCatalogIdentityWitness;
    conversationRepository.loadMessages = originalLoadMessages;
    chatHistory.delete(SOURCE_CONVERSATION_KEY);
    chatHistory.delete(TARGET_CONVERSATION_KEY);
    conversationForkLinks.delete(TARGET_CONVERSATION_KEY);
    loadedConversationKeys.delete(SOURCE_CONVERSATION_KEY);
    loadedConversationKeys.delete(TARGET_CONVERSATION_KEY);
    setPendingRequestId(SOURCE_CONVERSATION_KEY, 0);
    globalScope.Zotero = originalZotero;
    if (originalZtoolkit) {
      globalScope.ztoolkit = originalZtoolkit;
    } else {
      delete globalScope.ztoolkit;
    }
  });

  it("finalizes a pending deleted turn before forking through a later turn and shows the top toast", async function () {
    const events: string[] = [];
    const deleteCalls: Array<
      Parameters<typeof conversationRepository.deleteTurnMessages>[0]
    > = [];
    const forkCalls: Array<
      Parameters<typeof conversationRepository.forkConversation>[0]
    > = [];
    conversationRepository.deleteTurnMessages = async (params) => {
      events.push("deleteTurnMessages");
      deleteCalls.push(params);
    };
    conversationRepository.ensureCatalogEntry = async (params) =>
      makeCatalogEntry({
        conversationKey: params.conversationKey || TARGET_CONVERSATION_KEY,
        kind: params.kind,
        libraryID: params.libraryID,
        paperItemID: params.paperItemID,
      });
    conversationRepository.forkConversation = async (params) => {
      events.push("forkConversation");
      forkCalls.push(params);
      return {
        entry: makeCatalogEntry({
          conversationKey: TARGET_CONVERSATION_KEY,
          kind: params.kind,
          libraryID: params.libraryID,
          paperItemID: params.paperItemID,
        }),
        copiedMessageCount: 4,
        targetAnchorAssistantTimestamp: 1_700,
        forkLink: {
          targetConversationKey: TARGET_CONVERSATION_KEY,
          targetSystem: params.system,
          targetKind: params.kind,
          sourceConversationKey: params.sourceConversationKey,
          sourceSystem: params.system,
          sourceKind: params.kind,
          sourceLibraryID: params.libraryID,
          sourcePaperItemID: params.paperItemID,
          sourceAssistantTimestamp: params.throughAssistantTimestamp,
          targetAnchorAssistantTimestamp: 1_700,
          createdAt: 1_800,
        },
      };
    };
    const targetMessages = [
      makeMessage("user", "Fork target", 1_699),
      makeMessage("assistant", "Fork target answer", 1_700),
    ];
    conversationRepository.loadMessages = async (params) =>
      params.conversationKey === TARGET_CONVERSATION_KEY ? targetMessages : [];
    const originalQueryAsync = globalScope.Zotero?.DB?.queryAsync;
    if (globalScope.Zotero?.DB && originalQueryAsync) {
      globalScope.Zotero.DB.queryAsync = async (
        sql: string,
        params?: unknown[],
      ) => {
        if (
          sql.includes("SELECT target_conversation_key") &&
          Number(params?.[0] || 0) === TARGET_CONVERSATION_KEY
        ) {
          return [
            {
              targetConversationKey: TARGET_CONVERSATION_KEY,
              targetSystem: "upstream",
              targetKind: "global",
              sourceConversationKey: SOURCE_CONVERSATION_KEY,
              sourceSystem: "upstream",
              sourceKind: "global",
              sourceLibraryID: LIBRARY_ID,
              sourceAssistantTimestamp: 600,
              targetAnchorAssistantTimestamp: 1_700,
              createdAt: 1_800,
            },
          ];
        }
        return originalQueryAsync(sql, params);
      };
    }

    const { controller, item, historyUndo, historyUndoText, topToast, status } =
      createControllerHarness();
    chatHistory.set(SOURCE_CONVERSATION_KEY, [
      makeMessage("user", "First", 100),
      makeMessage("assistant", "First answer", 200),
      makeMessage("user", "Deleted", 300),
      makeMessage("assistant", "Deleted answer", 400),
      makeMessage("user", "Fork target", 500),
      makeMessage("assistant", "Fork target answer", 600),
    ]);
    loadedConversationKeys.add(SOURCE_CONVERSATION_KEY);

    await controller.queueTurnDeletion({
      conversationKey: SOURCE_CONVERSATION_KEY,
      userTimestamp: 300,
      assistantTimestamp: 400,
    });

    assert.isTrue(
      controller.hasPendingTurnDeletionForConversation(SOURCE_CONVERSATION_KEY),
    );
    assert.equal(historyUndo.style.display, "flex");
    assert.equal(
      historyUndoText.textContent,
      "\u5df2\u5220\u9664\u4e00\u8f6e\u5bf9\u8bdd",
    );
    // Hide-don't-splice: the queued turn stays in memory until finalize.
    assert.deepEqual(
      (chatHistory.get(SOURCE_CONVERSATION_KEY) || []).map(
        (message) => message.timestamp,
      ),
      [100, 200, 300, 400, 500, 600],
    );

    await controller.forkConversationFromTurn({
      item,
      conversationKey: SOURCE_CONVERSATION_KEY,
      userTimestamp: 500,
      assistantTimestamp: 600,
    });

    // Finalizing the overlapped pending turn (fork pre-step) splices it.
    assert.deepEqual(
      (chatHistory.get(SOURCE_CONVERSATION_KEY) || []).map(
        (message) => message.timestamp,
      ),
      [100, 200, 500, 600],
    );

    assert.deepEqual(events, ["deleteTurnMessages", "forkConversation"]);
    assert.lengthOf(deleteCalls, 1);
    assert.deepInclude(deleteCalls[0], {
      system: "upstream",
      conversationKey: SOURCE_CONVERSATION_KEY,
      userTimestamp: 300,
      assistantTimestamp: 400,
    });
    assert.deepEqual(forkCalls, [
      {
        system: "upstream",
        kind: "global",
        libraryID: LIBRARY_ID,
        paperItemID: undefined,
        sourceConversationKey: SOURCE_CONVERSATION_KEY,
        throughAssistantTimestamp: 600,
      },
    ]);
    assert.isFalse(
      controller.hasPendingTurnDeletionForConversation(SOURCE_CONVERSATION_KEY),
    );
    assert.equal(topToast.style.display, "flex");
    assert.equal(topToast.getAttribute("aria-hidden"), "false");
    assert.isTrue(topToast.classList.contains("llm-top-toast-visible"));
    assert.equal(topToast.textContent, "\u5bf9\u8bdd\u5df2 fork");
    assert.equal(status.textContent, "\u5bf9\u8bdd\u5df2 fork");
    assert.equal(
      conversationForkLinks.get(TARGET_CONVERSATION_KEY)
        ?.targetAnchorAssistantTimestamp,
      1_700,
    );
    assert.deepEqual(
      (chatHistory.get(TARGET_CONVERSATION_KEY) || []).map(
        (message) => message.text,
      ),
      ["Fork target", "Fork target answer"],
    );
    assert.isFalse(
      (chatHistory.get(TARGET_CONVERSATION_KEY) || []).some((message) =>
        String(message.text || "").includes("Forked from conversation"),
      ),
    );
  });

  it("does not finalize a later pending deletion before forking an earlier turn", async function () {
    const events: string[] = [];
    const deleteCalls: Array<
      Parameters<typeof conversationRepository.deleteTurnMessages>[0]
    > = [];
    conversationRepository.deleteTurnMessages = async (params) => {
      events.push("deleteTurnMessages");
      deleteCalls.push(params);
    };
    conversationRepository.ensureCatalogEntry = async (params) =>
      makeCatalogEntry({
        conversationKey: params.conversationKey || TARGET_CONVERSATION_KEY,
        kind: params.kind,
        libraryID: params.libraryID,
        paperItemID: params.paperItemID,
      });
    conversationRepository.forkConversation = async (params) => {
      events.push("forkConversation");
      return {
        entry: makeCatalogEntry({
          conversationKey: TARGET_CONVERSATION_KEY,
          kind: params.kind,
          libraryID: params.libraryID,
          paperItemID: params.paperItemID,
        }),
        copiedMessageCount: 2,
        targetAnchorAssistantTimestamp: 1_700,
        forkLink: {
          targetConversationKey: TARGET_CONVERSATION_KEY,
          targetSystem: params.system,
          targetKind: params.kind,
          sourceConversationKey: params.sourceConversationKey,
          sourceSystem: params.system,
          sourceKind: params.kind,
          sourceLibraryID: params.libraryID,
          sourcePaperItemID: params.paperItemID,
          sourceAssistantTimestamp: params.throughAssistantTimestamp,
          targetAnchorAssistantTimestamp: 1_700,
          createdAt: 1_800,
        },
      };
    };
    conversationRepository.loadMessages = async () => [];

    const { controller, item } = createControllerHarness();
    chatHistory.set(SOURCE_CONVERSATION_KEY, [
      makeMessage("user", "Fork target", 100),
      makeMessage("assistant", "Fork target answer", 200),
      makeMessage("user", "Deleted later", 300),
      makeMessage("assistant", "Deleted later answer", 400),
    ]);
    loadedConversationKeys.add(SOURCE_CONVERSATION_KEY);

    await controller.queueTurnDeletion({
      conversationKey: SOURCE_CONVERSATION_KEY,
      userTimestamp: 300,
      assistantTimestamp: 400,
    });
    await controller.forkConversationFromTurn({
      item,
      conversationKey: SOURCE_CONVERSATION_KEY,
      userTimestamp: 100,
      assistantTimestamp: 200,
    });

    assert.deepEqual(events, ["forkConversation"]);
    assert.deepEqual(deleteCalls, []);
    assert.isTrue(
      controller.hasPendingTurnDeletionForConversation(SOURCE_CONVERSATION_KEY),
    );
  });

  it("allows upstream agent-mode turns to fork", async function () {
    const forkCalls: Array<
      Parameters<typeof conversationRepository.forkConversation>[0]
    > = [];
    conversationRepository.ensureCatalogEntry = async (params) =>
      makeCatalogEntry({
        conversationKey: params.conversationKey || TARGET_CONVERSATION_KEY,
        kind: params.kind,
        libraryID: params.libraryID,
        paperItemID: params.paperItemID,
      });
    conversationRepository.forkConversation = async (params) => {
      forkCalls.push(params);
      return {
        entry: makeCatalogEntry({
          conversationKey: TARGET_CONVERSATION_KEY,
          kind: params.kind,
          libraryID: params.libraryID,
          paperItemID: params.paperItemID,
          system: params.system,
        }),
        copiedMessageCount: 2,
        targetAnchorAssistantTimestamp: 1_700,
        forkLink: {
          targetConversationKey: TARGET_CONVERSATION_KEY,
          targetSystem: params.system,
          targetKind: params.kind,
          sourceConversationKey: params.sourceConversationKey,
          sourceSystem: params.system,
          sourceKind: params.kind,
          sourceLibraryID: params.libraryID,
          sourcePaperItemID: params.paperItemID,
          sourceAssistantTimestamp: params.throughAssistantTimestamp,
          targetAnchorAssistantTimestamp: 1_700,
          createdAt: 1_800,
        },
      };
    };
    conversationRepository.loadMessages = async () => [];

    const { controller, item, status } = createControllerHarness();
    chatHistory.set(SOURCE_CONVERSATION_KEY, [
      {
        ...makeMessage("user", "Agent prompt", 100),
        runMode: "agent",
        agentRunId: "run-source",
      },
      {
        ...makeMessage("assistant", "Agent answer", 200),
        runMode: "agent",
        agentRunId: "run-source",
      },
    ]);
    loadedConversationKeys.add(SOURCE_CONVERSATION_KEY);

    await controller.forkConversationFromTurn({
      item,
      conversationKey: SOURCE_CONVERSATION_KEY,
      userTimestamp: 100,
      assistantTimestamp: 200,
    });

    assert.deepEqual(forkCalls, [
      {
        system: "upstream",
        kind: "global",
        libraryID: LIBRARY_ID,
        paperItemID: undefined,
        sourceConversationKey: SOURCE_CONVERSATION_KEY,
        throughAssistantTimestamp: 200,
      },
    ]);
    assert.equal(status.textContent, "\u5bf9\u8bdd\u5df2 fork");
  });

  for (const system of ["upstream", "claude_code", "codex"] as const) {
    it(`routes the header trash action through durable ${system} conversation deletion`, async function () {
      const instanceID = `instance-${system}`;
      conversationRepository.getCatalogEntry = async (params) =>
        makeCatalogEntry({
          conversationKey: params.conversationKey,
          kind: params.kind,
          libraryID: LIBRARY_ID,
          system,
          providerSessionId:
            system === "upstream" ? undefined : `provider-${system}`,
          instanceID,
          userTurnCount: 1,
        });
      conversationRepository.getCatalogIdentityWitness = async () => ({
        instanceID,
        catalogCreatedAt: 1,
        conversationID: `test:${SOURCE_CONVERSATION_KEY}`,
      });

      const { controller, status } = createControllerHarness({ system });

      const queued = await controller.queueCurrentConversationDeletion();
      const pending = pendingDeletionStore.getLatestPending();

      assert.isTrue(queued);
      assert.equal(pending?.kind, "conversation");
      if (pending?.kind !== "conversation") {
        assert.fail("expected a pending conversation deletion");
      }
      assert.equal(pending.system, system);
      assert.equal(pending.conversationKind, "global");
      assert.equal(pending.conversationKey, SOURCE_CONVERSATION_KEY);
      assert.equal(pending.instanceID, instanceID);
      assert.equal(
        status.textContent,
        t("Conversation deleted. Undo available."),
      );
    });
  }

  it("rejects header deletion while its conversation is generating", async function () {
    let catalogRead = false;
    conversationRepository.getCatalogEntry = async (params) => {
      catalogRead = true;
      return makeCatalogEntry({
        conversationKey: params.conversationKey,
        kind: params.kind,
        libraryID: LIBRARY_ID,
        userTurnCount: 1,
      });
    };
    setPendingRequestId(SOURCE_CONVERSATION_KEY, 77);
    const { controller, status } = createControllerHarness();

    const queued = await controller.queueCurrentConversationDeletion();

    assert.isFalse(queued);
    assert.isFalse(catalogRead, "the guard should reject before DB hydration");
    assert.equal(status.textContent, t("Cannot delete while generating"));
    assert.isNull(pendingDeletionStore.getLatestPending());
  });

  it("routes the Claude Code paper trash action through the same conversation deletion", async function () {
    const paperItem = {
      id: PAPER_ITEM_ID,
      libraryID: LIBRARY_ID,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => true,
      getField: (field: string) => (field === "title" ? "Test paper" : ""),
    } as unknown as Zotero.Item;
    const portalItem = createClaudePaperPortalItem(
      paperItem,
      SOURCE_CONVERSATION_KEY,
    ) as Zotero.Item;
    const instanceID = "instance-claude-paper";
    conversationRepository.getCatalogEntry = async (params) =>
      makeCatalogEntry({
        conversationKey: params.conversationKey,
        kind: "paper",
        libraryID: LIBRARY_ID,
        paperItemID: PAPER_ITEM_ID,
        system: "claude_code",
        providerSessionId: "provider-claude-paper",
        instanceID,
        userTurnCount: 1,
      });
    conversationRepository.getCatalogIdentityWitness = async () => ({
      instanceID,
      catalogCreatedAt: 1,
      conversationID: `test:${SOURCE_CONVERSATION_KEY}`,
    });

    const { controller } = createControllerHarness({
      system: "claude_code",
      mode: "paper",
      item: portalItem,
      basePaperItem: paperItem,
    });

    assert.isTrue(await controller.queueCurrentConversationDeletion());
    const pending = pendingDeletionStore.getLatestPending();
    assert.equal(pending?.kind, "conversation");
    if (pending?.kind !== "conversation") {
      assert.fail("expected a pending conversation deletion");
    }
    assert.equal(pending.system, "claude_code");
    assert.equal(pending.conversationKind, "paper");
    assert.equal(pending.paperItemID, PAPER_ITEM_ID);
    assert.equal(pending.conversationKey, SOURCE_CONVERSATION_KEY);
  });

  it("rejects Claude Code fork attempts before the repository", async function () {
    let forkCalled = false;
    conversationRepository.forkConversation = async () => {
      forkCalled = true;
      return null;
    };

    const { controller, item, status } = createControllerHarness({
      system: "claude_code",
    });
    chatHistory.set(SOURCE_CONVERSATION_KEY, [
      makeMessage("user", "Prompt", 100),
      makeMessage("assistant", "Answer", 200),
    ]);
    loadedConversationKeys.add(SOURCE_CONVERSATION_KEY);

    await controller.forkConversationFromTurn({
      item,
      conversationKey: SOURCE_CONVERSATION_KEY,
      userTimestamp: 100,
      assistantTimestamp: 200,
    });

    assert.isFalse(forkCalled);
    assert.include(status.textContent, "Claude Code");
  });

  it("rejects Codex older-turn fork attempts when native fork has no anchor support", async function () {
    let forkCalled = false;
    conversationRepository.forkConversation = async () => {
      forkCalled = true;
      return null;
    };

    const { controller, item, status } = createControllerHarness({
      system: "codex",
    });
    chatHistory.set(SOURCE_CONVERSATION_KEY, [
      makeMessage("user", "First", 100),
      makeMessage("assistant", "First answer", 200),
      makeMessage("user", "Latest", 300),
      makeMessage("assistant", "Latest answer", 400),
    ]);
    loadedConversationKeys.add(SOURCE_CONVERSATION_KEY);

    await controller.forkConversationFromTurn({
      item,
      conversationKey: SOURCE_CONVERSATION_KEY,
      userTimestamp: 100,
      assistantTimestamp: 200,
    });

    assert.isFalse(forkCalled);
    assert.equal(
      status.textContent,
      t("Codex fork is only supported for the latest response"),
    );
  });

  it("allows Codex latest local-only raw-PDF turns to fork without a provider session", async function () {
    const forkCalls: Array<
      Parameters<typeof conversationRepository.forkConversation>[0]
    > = [];
    conversationRepository.ensureCatalogEntry = async (params) =>
      makeCatalogEntry({
        conversationKey: params.conversationKey || TARGET_CONVERSATION_KEY,
        kind: params.kind,
        libraryID: params.libraryID,
        paperItemID: params.paperItemID,
        system: params.system,
      });
    conversationRepository.getCatalogEntry = async (params) =>
      makeCatalogEntry({
        conversationKey: params.conversationKey,
        kind: params.kind,
        libraryID: LIBRARY_ID,
        system: "codex",
        providerSessionId: undefined,
      });
    conversationRepository.forkConversation = async (params) => {
      forkCalls.push(params);
      return {
        entry: makeCatalogEntry({
          conversationKey: TARGET_CONVERSATION_KEY,
          kind: params.kind,
          libraryID: params.libraryID,
          paperItemID: params.paperItemID,
          system: params.system,
        }),
        copiedMessageCount: 2,
        targetAnchorAssistantTimestamp: 1_700,
        forkLink: {
          targetConversationKey: TARGET_CONVERSATION_KEY,
          targetSystem: params.system,
          targetKind: params.kind,
          sourceConversationKey: params.sourceConversationKey,
          sourceSystem: params.system,
          sourceKind: params.kind,
          sourceLibraryID: params.libraryID,
          sourcePaperItemID: params.paperItemID,
          sourceAssistantTimestamp: params.throughAssistantTimestamp,
          targetAnchorAssistantTimestamp: 1_700,
          createdAt: 1_800,
        },
      };
    };
    conversationRepository.loadMessages = async () => [];

    const { controller, item, status } = createControllerHarness({
      system: "codex",
    });
    chatHistory.set(SOURCE_CONVERSATION_KEY, [
      { ...makeMessage("user", "Prompt", 100), runMode: "agent" },
      { ...makeMessage("assistant", "Answer", 200), runMode: "agent" },
    ]);
    loadedConversationKeys.add(SOURCE_CONVERSATION_KEY);

    await controller.forkConversationFromTurn({
      item,
      conversationKey: SOURCE_CONVERSATION_KEY,
      userTimestamp: 100,
      assistantTimestamp: 200,
    });

    assert.deepEqual(forkCalls, [
      {
        system: "codex",
        kind: "global",
        libraryID: LIBRARY_ID,
        paperItemID: undefined,
        sourceConversationKey: SOURCE_CONVERSATION_KEY,
        throughAssistantTimestamp: 200,
      },
    ]);
    assert.equal(status.textContent, "\u5bf9\u8bdd\u5df2 fork");
  });
});
