import { assert } from "chai";
import {
  attachMenuActionController,
  buildResponseActionTargetFromHistory,
} from "../src/modules/contextPanel/setupHandlers/controllers/menuActionController";
import { invokeResponseMenuActionButton } from "../src/modules/contextPanel/chat";
import {
  responseMenuTarget,
  type ResponseActionTarget,
  setResponseActionRunner,
  setResponseMenuTarget,
} from "../src/modules/contextPanel/state";

class FakeElement {
  public dataset: Record<string, string | undefined> = {};
  public readonly children: FakeElement[] = [];
  public id = "";
  public textContent = "";
  public className = "";
  public disabled = false;
  public ownerDocument?: any;
  private readonly listeners = new Map<
    string,
    Array<(event: any) => unknown>
  >();

  addEventListener(type: string, listener: (event: any) => unknown): void {
    const existing = this.listeners.get(type) || [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    child.ownerDocument = child.ownerDocument || this.ownerDocument;
    return child;
  }

  querySelector(selector: string): FakeElement | null {
    if (!selector.startsWith("#")) return null;
    const id = selector.slice(1);
    const stack = [...this.children];
    while (stack.length) {
      const child = stack.shift()!;
      if (child.id === id) return child;
      stack.push(...child.children);
    }
    return null;
  }

  closest(selector: string): FakeElement | null {
    const classNames = new Set(this.className.split(/\s+/).filter(Boolean));
    const selectors = selector.split(",").map((part) => part.trim());
    for (const part of selectors) {
      if (!part.startsWith(".")) continue;
      if (classNames.has(part.slice(1))) return this;
    }
    return null;
  }

  dispatchEvent(event: any): boolean {
    try {
      event.target = event.target || this;
    } catch (_err) {
      void _err;
    }
    for (const listener of this.listeners.get(event.type) || []) {
      void listener(event);
      if (event.immediatePropagationStopped) break;
    }
    return !event.defaultPrevented;
  }

  async dispatch(type: string, target: FakeElement = this): Promise<void> {
    const event = {
      type,
      target,
      immediatePropagationStopped: false,
      defaultPrevented: false,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {
        this.immediatePropagationStopped = true;
      },
    };
    for (const listener of this.listeners.get(type) || []) {
      await listener(event);
      if (event.immediatePropagationStopped) break;
    }
  }
}

describe("menu action controller note routing", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: {
      Item?: new (itemType: string) => Zotero.Item;
    };
    ztoolkit?: {
      log?: (...args: unknown[]) => void;
    };
  };
  const originalZotero = globalScope.Zotero;
  const originalZtoolkit = globalScope.ztoolkit;
  const savedNotes: MockNoteItem[] = [];

  class MockNoteItem {
    id = 0;
    libraryID = 0;
    parentID?: number;
    private noteHtml = "";

    constructor(itemType: string) {
      assert.equal(itemType, "note");
    }

    isNote() {
      return true;
    }

    setNote(html: string) {
      this.noteHtml = html;
    }

    getNote() {
      return this.noteHtml;
    }

    async saveTx() {
      if (!this.id) {
        this.id = 100 + savedNotes.length;
        savedNotes.push(this);
      }
      return this.id;
    }
  }

  beforeEach(function () {
    savedNotes.splice(0);
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Item: MockNoteItem as unknown as new (itemType: string) => Zotero.Item,
    };
    globalScope.ztoolkit = {
      ...(originalZtoolkit || {}),
      log: () => {},
    };
  });

  afterEach(function () {
    setResponseActionRunner(null);
    setResponseMenuTarget(null);
    if (originalZotero) {
      globalScope.Zotero = originalZotero;
    } else {
      delete globalScope.Zotero;
    }
    if (originalZtoolkit) {
      globalScope.ztoolkit = originalZtoolkit;
    } else {
      delete globalScope.ztoolkit;
    }
  });

  const flushAsyncEvents = () =>
    new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("saves response-menu notes as standalone notes in library chat mode", async function () {
    const responseMenu = new FakeElement();
    const responseMenuNoteBtn = new FakeElement();
    const status = new FakeElement();
    const logErrors: unknown[] = [];
    const currentItem = {
      id: 42,
      libraryID: 1,
    } as unknown as Zotero.Item;

    attachMenuActionController({
      body: new FakeElement() as unknown as Element,
      status: status as unknown as HTMLElement,
      responseMenu: responseMenu as unknown as HTMLDivElement,
      responseMenuCopyBtn: new FakeElement() as unknown as HTMLButtonElement,
      responseMenuNoteBtn: responseMenuNoteBtn as unknown as HTMLButtonElement,
      responseMenuDeleteBtn: null,
      promptMenu: null,
      promptMenuDeleteBtn: null,
      exportMenu: null,
      exportMenuCopyBtn: null,
      exportMenuNoteBtn: null,
      exportBtn: null,
      popoutBtn: null,
      settingsBtn: null,
      preferencesPaneId: "llm-for-zotero-test",
      getItem: () => currentItem,
      getResponseMenuTarget: () => ({
        item: currentItem,
        contentText: "Generated a figure.",
        queryText: "What did the model generate?",
        modelName: "Codex",
      }),
      getPromptMenuTarget: () => null,
      getCurrentLibraryID: () => 1,
      getConversationSystem: () => "codex",
      getCurrentRuntimeModeForItem: () => "agent",
      isGlobalMode: () => true,
      ensureConversationLoaded: async () => {},
      getConversationKey: () => 1,
      getHistory: () => [],
      resolveActiveNoteSession: () => null,
      closeResponseMenu: () => {},
      closePromptMenu: () => {},
      closeExportMenu: () => {},
      closeRetryModelMenu: () => {},
      closeSlashMenu: () => {},
      closeHistoryNewMenu: () => {},
      closeHistoryMenu: () => {},
      queueTurnDeletion: async () => {},
      logError: (...args: unknown[]) => {
        logErrors.push(args);
      },
    });

    await responseMenuNoteBtn.dispatch("click");

    assert.lengthOf(savedNotes, 1);
    assert.equal(savedNotes[0].libraryID, 1);
    assert.isUndefined(savedNotes[0].parentID);
    assert.include(savedNotes[0].getNote(), "What did the model generate?");
    assert.include(savedNotes[0].getNote(), "Generated a figure.");
    assert.equal(status.textContent, "Created a new note");
    assert.isEmpty(logErrors);
  });

  it("reconstructs response targets from turn timestamps", function () {
    const currentItem = {
      id: 42,
      libraryID: 1,
    } as unknown as Zotero.Item;
    const paperContext = {
      itemId: 42,
      contextItemId: 77,
      title: "Paper title",
      citationKey: "paper2026",
    };
    const quoteCitation = {
      id: "Q_1",
      quoteText: "quoted text",
      citationLabel: "Paper, 2026",
      itemId: 42,
      contextItemId: 77,
    };
    const generatedImage = {
      id: "img-1",
      label: "result.png",
      src: "file:///tmp/result.png",
    };

    const target = buildResponseActionTargetFromHistory({
      item: currentItem,
      conversationKey: 9,
      userTimestamp: 100,
      assistantTimestamp: 200,
      history: [
        {
          role: "user",
          text: "Question about this paper",
          timestamp: 100,
          selectedTextPaperContexts: [paperContext],
        },
        {
          role: "assistant",
          text: "  Answer with citation.  ",
          timestamp: 200,
          modelName: " codex ",
          quoteCitations: [quoteCitation],
          generatedImages: [generatedImage],
        },
      ],
    });

    assert.isNotNull(target);
    assert.equal(target?.contentText, "Answer with citation.");
    assert.equal(target?.queryText, "Question about this paper");
    assert.equal(target?.modelName, "codex");
    assert.equal(target?.paperContexts?.[0]?.itemId, paperContext.itemId);
    assert.equal(
      target?.paperContexts?.[0]?.contextItemId,
      paperContext.contextItemId,
    );
    assert.equal(target?.paperContexts?.[0]?.title, paperContext.title);
    assert.equal(
      target?.paperContexts?.[0]?.citationKey,
      paperContext.citationKey,
    );
    assert.deepEqual(target?.quoteCitations, [quoteCitation]);
    assert.deepEqual(target?.generatedImages, [generatedImage]);
  });

  it("saves response notes as child item notes in paper chat mode", async function () {
    const responseMenu = new FakeElement();
    const responseMenuNoteBtn = new FakeElement();
    const status = new FakeElement();
    const logErrors: unknown[] = [];
    const currentItem = {
      id: 42,
      libraryID: 1,
      isAttachment: () => false,
      isNote: () => false,
    } as unknown as Zotero.Item;

    attachMenuActionController({
      body: new FakeElement() as unknown as Element,
      status: status as unknown as HTMLElement,
      responseMenu: responseMenu as unknown as HTMLDivElement,
      responseMenuCopyBtn: new FakeElement() as unknown as HTMLButtonElement,
      responseMenuNoteBtn: responseMenuNoteBtn as unknown as HTMLButtonElement,
      responseMenuDeleteBtn: null,
      promptMenu: null,
      promptMenuDeleteBtn: null,
      exportMenu: null,
      exportMenuCopyBtn: null,
      exportMenuNoteBtn: null,
      exportBtn: null,
      popoutBtn: null,
      settingsBtn: null,
      preferencesPaneId: "llm-for-zotero-test",
      getItem: () => currentItem,
      getResponseMenuTarget: () => ({
        item: currentItem,
        contentText: "Paper-specific answer.",
        queryText: "Summarize this paper.",
        modelName: "Codex",
      }),
      getPromptMenuTarget: () => null,
      getCurrentLibraryID: () => 1,
      getConversationSystem: () => "codex",
      getCurrentRuntimeModeForItem: () => "agent",
      isGlobalMode: () => false,
      ensureConversationLoaded: async () => {},
      getConversationKey: () => 1,
      getHistory: () => [],
      resolveActiveNoteSession: () => null,
      closeResponseMenu: () => {},
      closePromptMenu: () => {},
      closeExportMenu: () => {},
      closeRetryModelMenu: () => {},
      closeSlashMenu: () => {},
      closeHistoryNewMenu: () => {},
      closeHistoryMenu: () => {},
      queueTurnDeletion: async () => {},
      logError: (...args: unknown[]) => {
        logErrors.push(args);
      },
    });

    await responseMenuNoteBtn.dispatch("click");

    assert.lengthOf(savedNotes, 1);
    assert.equal(savedNotes[0].libraryID, 1);
    assert.equal(savedNotes[0].parentID, 42);
    assert.include(savedNotes[0].getNote(), "Summarize this paper.");
    assert.include(savedNotes[0].getNote(), "Paper-specific answer.");
    assert.equal(status.textContent, "Created a new note");
    assert.isEmpty(logErrors);
  });

  it("maps footer copy to the response-menu action and preserves rich response copy", async function () {
    const body = new FakeElement();
    const responseMenu = new FakeElement();
    const responseMenuCopyBtn = new FakeElement();
    const responseMenuNoteBtn = new FakeElement();
    const status = new FakeElement();
    let richClipboardItems: Record<string, Blob> | null = null;
    let plainFallbackText = "";
    class FakeClipboardItem {
      constructor(public readonly items: Record<string, Blob>) {}
    }
    body.ownerDocument = {
      defaultView: {
        ClipboardItem: FakeClipboardItem,
        navigator: {
          clipboard: {
            write: async (items: FakeClipboardItem[]) => {
              richClipboardItems = items[0]?.items || null;
            },
            writeText: async (value: string) => {
              plainFallbackText = value;
            },
          },
        },
      },
    };
    responseMenuCopyBtn.id = "llm-response-menu-copy";
    responseMenuNoteBtn.id = "llm-response-menu-note";
    body.appendChild(responseMenuCopyBtn);
    const currentItem = {
      id: 42,
      libraryID: 1,
    } as unknown as Zotero.Item;
    const markdown = [
      "Here is the source.",
      "",
      "```svg",
      '<svg width="10" height="10"></svg>',
      "```",
    ].join("\n");
    const target: ResponseActionTarget = {
      item: currentItem,
      contentText: markdown,
      queryText: "show figure",
      modelName: "Codex",
      conversationKey: 9,
      userTimestamp: 100,
      assistantTimestamp: 200,
    };

    attachMenuActionController({
      body: body as unknown as Element,
      status: status as unknown as HTMLElement,
      responseMenu: responseMenu as unknown as HTMLDivElement,
      responseMenuCopyBtn:
        responseMenuCopyBtn as unknown as HTMLButtonElement,
      responseMenuNoteBtn:
        responseMenuNoteBtn as unknown as HTMLButtonElement,
      responseMenuDeleteBtn: null,
      promptMenu: null,
      promptMenuDeleteBtn: null,
      exportMenu: null,
      exportMenuCopyBtn: null,
      exportMenuNoteBtn: null,
      exportBtn: null,
      popoutBtn: null,
      settingsBtn: null,
      preferencesPaneId: "llm-for-zotero-test",
      getItem: () => currentItem,
      getResponseMenuTarget: () => responseMenuTarget,
      getPromptMenuTarget: () => null,
      getCurrentLibraryID: () => 1,
      getConversationSystem: () => "codex",
      getCurrentRuntimeModeForItem: () => "agent",
      isGlobalMode: () => true,
      ensureConversationLoaded: async () => {},
      getConversationKey: () => 9,
      getHistory: () => [],
      resolveActiveNoteSession: () => null,
      closeResponseMenu: () => {},
      closePromptMenu: () => {},
      closeExportMenu: () => {},
      closeRetryModelMenu: () => {},
      closeSlashMenu: () => {},
      closeHistoryNewMenu: () => {},
      closeHistoryMenu: () => {},
      queueTurnDeletion: async () => {},
      logError: () => {},
    });

    const invoked = invokeResponseMenuActionButton({
      body: body as unknown as Element,
      action: "copy",
      target,
    });
    await flushAsyncEvents();

    assert.isTrue(invoked);
    assert.isNotNull(richClipboardItems);
    assert.deepEqual(Object.keys(richClipboardItems || {}).sort(), [
      "text/html",
      "text/plain",
    ]);
    const plainText = await richClipboardItems!["text/plain"].text();
    const htmlText = await richClipboardItems!["text/html"].text();
    assert.equal(plainText, markdown);
    assert.include(plainText, "```svg");
    assert.include(htmlText, "<pre");
    assert.include(htmlText, "Here is the source.");
    assert.notEqual(htmlText, plainText);
    assert.equal(plainFallbackText, "");
    assert.equal(status.textContent, "Copied response");
  });

  it("maps footer note to the response-menu action without prior right-click state or history reconstruction", async function () {
    const body = new FakeElement();
    const responseMenu = new FakeElement();
    const responseMenuCopyBtn = new FakeElement();
    const responseMenuNoteBtn = new FakeElement();
    const status = new FakeElement();
    const currentItem = {
      id: 42,
      libraryID: 1,
      isAttachment: () => false,
      isNote: () => false,
    } as unknown as Zotero.Item;
    body.ownerDocument = { defaultView: {} };
    responseMenuCopyBtn.id = "llm-response-menu-copy";
    responseMenuNoteBtn.id = "llm-response-menu-note";
    body.appendChild(responseMenuNoteBtn);
    const target: ResponseActionTarget = {
      item: currentItem,
      contentText: "Footer mapped answer.",
      queryText: "Footer mapped question",
      modelName: "Codex",
      conversationKey: 9,
      userTimestamp: 100,
      assistantTimestamp: 200,
    };

    attachMenuActionController({
      body: body as unknown as Element,
      status: status as unknown as HTMLElement,
      responseMenu: responseMenu as unknown as HTMLDivElement,
      responseMenuCopyBtn:
        responseMenuCopyBtn as unknown as HTMLButtonElement,
      responseMenuNoteBtn:
        responseMenuNoteBtn as unknown as HTMLButtonElement,
      responseMenuDeleteBtn: null,
      promptMenu: null,
      promptMenuDeleteBtn: null,
      exportMenu: null,
      exportMenuCopyBtn: null,
      exportMenuNoteBtn: null,
      exportBtn: null,
      popoutBtn: null,
      settingsBtn: null,
      preferencesPaneId: "llm-for-zotero-test",
      getItem: () => currentItem,
      getResponseMenuTarget: () => responseMenuTarget,
      getPromptMenuTarget: () => null,
      getCurrentLibraryID: () => 1,
      getConversationSystem: () => "codex",
      getCurrentRuntimeModeForItem: () => "agent",
      isGlobalMode: () => false,
      ensureConversationLoaded: async () => {},
      getConversationKey: () => 9,
      getHistory: () => [],
      resolveActiveNoteSession: () => null,
      closeResponseMenu: () => {},
      closePromptMenu: () => {},
      closeExportMenu: () => {},
      closeRetryModelMenu: () => {},
      closeSlashMenu: () => {},
      closeHistoryNewMenu: () => {},
      closeHistoryMenu: () => {},
      queueTurnDeletion: async () => {},
      logError: () => {},
    });

    const invoked = invokeResponseMenuActionButton({
      body: body as unknown as Element,
      action: "note",
      target,
    });
    await flushAsyncEvents();

    assert.isTrue(invoked);
    assert.lengthOf(savedNotes, 1);
    assert.equal(savedNotes[0].parentID, 42);
    assert.include(savedNotes[0].getNote(), "Footer mapped question");
    assert.include(savedNotes[0].getNote(), "Footer mapped answer.");
    assert.equal(status.textContent, "Created a new note");
  });

  it("maps footer delete to the response-menu action", async function () {
    const body = new FakeElement();
    const responseMenu = new FakeElement();
    const responseMenuCopyBtn = new FakeElement();
    const responseMenuNoteBtn = new FakeElement();
    const responseMenuDeleteBtn = new FakeElement();
    const currentItem = {
      id: 42,
      libraryID: 1,
    } as unknown as Zotero.Item;
    const deletions: unknown[] = [];
    body.ownerDocument = { defaultView: {} };
    responseMenuCopyBtn.id = "llm-response-menu-copy";
    responseMenuNoteBtn.id = "llm-response-menu-note";
    responseMenuDeleteBtn.id = "llm-response-menu-delete";
    body.appendChild(responseMenuDeleteBtn);
    const target: ResponseActionTarget = {
      item: currentItem,
      contentText: "",
      queryText: "Question",
      modelName: "Codex",
      conversationKey: 9,
      userTimestamp: 100,
      assistantTimestamp: 200,
    };

    attachMenuActionController({
      body: body as unknown as Element,
      status: new FakeElement() as unknown as HTMLElement,
      responseMenu: responseMenu as unknown as HTMLDivElement,
      responseMenuCopyBtn:
        responseMenuCopyBtn as unknown as HTMLButtonElement,
      responseMenuNoteBtn:
        responseMenuNoteBtn as unknown as HTMLButtonElement,
      responseMenuDeleteBtn:
        responseMenuDeleteBtn as unknown as HTMLButtonElement,
      promptMenu: null,
      promptMenuDeleteBtn: null,
      exportMenu: null,
      exportMenuCopyBtn: null,
      exportMenuNoteBtn: null,
      exportBtn: null,
      popoutBtn: null,
      settingsBtn: null,
      preferencesPaneId: "llm-for-zotero-test",
      getItem: () => currentItem,
      getResponseMenuTarget: () => responseMenuTarget,
      getPromptMenuTarget: () => null,
      getCurrentLibraryID: () => 1,
      getConversationSystem: () => "codex",
      getCurrentRuntimeModeForItem: () => "agent",
      isGlobalMode: () => true,
      ensureConversationLoaded: async () => {},
      getConversationKey: () => 9,
      getHistory: () => [
        { role: "user", text: "Question", timestamp: 100 },
        { role: "assistant", text: "Answer", timestamp: 200 },
      ],
      resolveActiveNoteSession: () => null,
      closeResponseMenu: () => {},
      closePromptMenu: () => {},
      closeExportMenu: () => {},
      closeRetryModelMenu: () => {},
      closeSlashMenu: () => {},
      closeHistoryNewMenu: () => {},
      closeHistoryMenu: () => {},
      queueTurnDeletion: async (queuedTarget) => {
        deletions.push(queuedTarget);
      },
      logError: () => {},
    });

    const invoked = invokeResponseMenuActionButton({
      body: body as unknown as Element,
      action: "delete",
      target,
    });
    await flushAsyncEvents();

    assert.isTrue(invoked);
    assert.deepEqual(deletions, [
      {
        conversationKey: 9,
        userTimestamp: 100,
        assistantTimestamp: 200,
      },
    ]);
  });

  it("maps footer delete through the registered action runner without menu buttons", async function () {
    const body = new FakeElement();
    const currentItem = {
      id: 42,
      libraryID: 1,
    } as unknown as Zotero.Item;
    const deletions: unknown[] = [];
    const target: ResponseActionTarget = {
      item: currentItem,
      contentText: "",
      queryText: "Question",
      modelName: "Codex",
      conversationKey: 9,
      userTimestamp: 100,
      assistantTimestamp: 200,
    };

    attachMenuActionController({
      body: body as unknown as Element,
      status: new FakeElement() as unknown as HTMLElement,
      responseMenu: null,
      responseMenuCopyBtn: null,
      responseMenuNoteBtn: null,
      responseMenuDeleteBtn: null,
      promptMenu: null,
      promptMenuDeleteBtn: null,
      exportMenu: null,
      exportMenuCopyBtn: null,
      exportMenuNoteBtn: null,
      exportBtn: null,
      popoutBtn: null,
      settingsBtn: null,
      preferencesPaneId: "llm-for-zotero-test",
      getItem: () => currentItem,
      getResponseMenuTarget: () => responseMenuTarget,
      getPromptMenuTarget: () => null,
      getCurrentLibraryID: () => 1,
      getConversationSystem: () => "codex",
      getCurrentRuntimeModeForItem: () => "agent",
      isGlobalMode: () => true,
      ensureConversationLoaded: async () => {},
      getConversationKey: () => 9,
      getHistory: () => [
        { role: "user", text: "Question", timestamp: 100 },
        { role: "assistant", text: "Answer", timestamp: 200 },
      ],
      resolveActiveNoteSession: () => null,
      closeResponseMenu: () => {},
      closePromptMenu: () => {},
      closeExportMenu: () => {},
      closeRetryModelMenu: () => {},
      closeSlashMenu: () => {},
      closeHistoryNewMenu: () => {},
      closeHistoryMenu: () => {},
      queueTurnDeletion: async (queuedTarget) => {
        deletions.push(queuedTarget);
      },
      logError: () => {},
    });

    const invoked = invokeResponseMenuActionButton({
      body: body as unknown as Element,
      action: "delete",
      target,
    });
    await flushAsyncEvents();

    assert.isTrue(invoked);
    assert.deepEqual(deletions, [
      {
        conversationKey: 9,
        userTimestamp: 100,
        assistantTimestamp: 200,
      },
    ]);
  });

  it("does not queue response-menu delete when the target is stale", async function () {
    const body = new FakeElement();
    const responseMenu = new FakeElement();
    const responseMenuCopyBtn = new FakeElement();
    const responseMenuNoteBtn = new FakeElement();
    const responseMenuDeleteBtn = new FakeElement();
    const currentItem = {
      id: 42,
      libraryID: 1,
    } as unknown as Zotero.Item;
    let deletionCount = 0;
    body.ownerDocument = { defaultView: {} };
    responseMenuCopyBtn.id = "llm-response-menu-copy";
    responseMenuNoteBtn.id = "llm-response-menu-note";
    responseMenuDeleteBtn.id = "llm-response-menu-delete";
    body.appendChild(responseMenuDeleteBtn);
    const target: ResponseActionTarget = {
      item: currentItem,
      contentText: "",
      queryText: "Question",
      modelName: "Codex",
      conversationKey: 9,
      userTimestamp: 100,
      assistantTimestamp: 200,
    };

    attachMenuActionController({
      body: body as unknown as Element,
      status: new FakeElement() as unknown as HTMLElement,
      responseMenu: responseMenu as unknown as HTMLDivElement,
      responseMenuCopyBtn:
        responseMenuCopyBtn as unknown as HTMLButtonElement,
      responseMenuNoteBtn:
        responseMenuNoteBtn as unknown as HTMLButtonElement,
      responseMenuDeleteBtn:
        responseMenuDeleteBtn as unknown as HTMLButtonElement,
      promptMenu: null,
      promptMenuDeleteBtn: null,
      exportMenu: null,
      exportMenuCopyBtn: null,
      exportMenuNoteBtn: null,
      exportBtn: null,
      popoutBtn: null,
      settingsBtn: null,
      preferencesPaneId: "llm-for-zotero-test",
      getItem: () => currentItem,
      getResponseMenuTarget: () => responseMenuTarget,
      getPromptMenuTarget: () => null,
      getCurrentLibraryID: () => 1,
      getConversationSystem: () => "codex",
      getCurrentRuntimeModeForItem: () => "agent",
      isGlobalMode: () => true,
      ensureConversationLoaded: async () => {},
      getConversationKey: () => 10,
      getHistory: () => [
        { role: "user", text: "Question", timestamp: 100 },
        { role: "assistant", text: "Answer", timestamp: 200 },
      ],
      resolveActiveNoteSession: () => null,
      closeResponseMenu: () => {},
      closePromptMenu: () => {},
      closeExportMenu: () => {},
      closeRetryModelMenu: () => {},
      closeSlashMenu: () => {},
      closeHistoryNewMenu: () => {},
      closeHistoryMenu: () => {},
      queueTurnDeletion: async () => {
        deletionCount += 1;
      },
      logError: () => {},
    });

    const invoked = invokeResponseMenuActionButton({
      body: body as unknown as Element,
      action: "delete",
      target,
    });
    await flushAsyncEvents();

    assert.isTrue(invoked);
    assert.equal(deletionCount, 0);
  });
});
