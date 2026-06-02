import { assert } from "chai";
import { describe, it } from "mocha";
import {
  createPaperPickerController,
  filterPaperPickerGroupsForTagView,
  positionPaperPickerForAnchor,
} from "../src/modules/contextPanel/setupHandlers/controllers/paperPickerController";
import { MAX_SELECTED_PAPER_CONTEXTS } from "../src/modules/contextPanel/constants";
import {
  getPaperSearchItemTagNames,
  invalidatePaperSearchCache,
  type PaperSearchGroupCandidate,
} from "../src/modules/contextPanel/paperSearch";
import {
  selectedCollectionContextCache,
  paperContextModeOverrides,
  selectedPaperContextCache,
  selectedPaperPreviewExpandedCache,
  selectedTagContextCache,
} from "../src/modules/contextPanel/state";
import type {
  CollectionContextRef,
  PaperContextRef,
  TagContextRef,
} from "../src/modules/contextPanel/types";

function makeRegularItem(index: number): Zotero.Item {
  const itemId = 1_000 + index;
  const attachmentId = 2_000 + index;
  return {
    id: itemId,
    key: `ITEM-${itemId}`,
    libraryID: 1,
    dateAdded: "2026-01-01T00:00:00Z",
    dateModified: "2026-01-01T00:00:00Z",
    firstCreator: "Tester",
    isAttachment: () => false,
    isRegularItem: () => true,
    getAttachments: () => [attachmentId],
    getCollections: () => [],
    getCreators: () => [],
    getNotes: () => [],
    getField: (field: string) => {
      switch (field) {
        case "title":
          return `Picker Paper ${index}`;
        case "firstCreator":
          return "Tester";
        case "year":
          return "2026";
        default:
          return "";
      }
    },
  } as unknown as Zotero.Item;
}

function makeAttachment(index: number): Zotero.Item {
  return {
    id: 2_000 + index,
    key: `ATTACH-${2_000 + index}`,
    libraryID: 1,
    dateAdded: "2026-01-01T00:00:00Z",
    dateModified: "2026-01-01T00:00:00Z",
    parentID: 1_000 + index,
    attachmentContentType: "application/pdf",
    isAttachment: () => true,
    isRegularItem: () => false,
    getAttachments: () => [],
    getCollections: () => [],
    getCreators: () => [],
    getField: (field: string) =>
      field === "title" ? `Picker Paper ${index} PDF` : "",
  } as unknown as Zotero.Item;
}

class FakeClassList {
  private tokens = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) this.tokens.add(token);
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) this.tokens.delete(token);
  }

  contains(token: string): boolean {
    return this.tokens.has(token);
  }

  toggle(token: string, force?: boolean): boolean {
    const shouldAdd = force === undefined ? !this.tokens.has(token) : force;
    if (shouldAdd) this.tokens.add(token);
    else this.tokens.delete(token);
    return shouldAdd;
  }
}

class FakeStyle {
  display = "";
  height = "";
  private properties = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.properties.set(name, value);
  }

  getPropertyValue(name: string): string {
    return this.properties.get(name) || "";
  }

  removeProperty(name: string): string {
    const previous = this.getPropertyValue(name);
    this.properties.delete(name);
    return previous;
  }
}

class FakeElement {
  className = "";
  textContent = "";
  title = "";
  tabIndex = 0;
  scrollTop = 0;
  scrollHeight = 0;
  readonly classList = new FakeClassList();
  readonly style = new FakeStyle();
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  private rect: DOMRect = makeRect();
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

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
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

  scrollIntoView(): void {
    // No layout in unit tests.
  }

  setBoundingClientRect(rect: Partial<DOMRect>): void {
    this.rect = makeRect(rect);
  }

  getBoundingClientRect(): DOMRect {
    return this.rect;
  }
}

class FakeDocument {
  defaultView = {
    innerHeight: 800,
    setTimeout: (handler: TimerHandler, timeout?: number) =>
      setTimeout(handler, timeout),
    clearTimeout: (handle?: number) => clearTimeout(handle),
  };
  documentElement = { clientHeight: 800 };

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }
}

function makeRect(rect: Partial<DOMRect> = {}): DOMRect {
  const left = rect.left ?? rect.x ?? 0;
  const top = rect.top ?? rect.y ?? 0;
  const width =
    rect.width ?? (rect.right !== undefined ? rect.right - left : 0);
  const height =
    rect.height ?? (rect.bottom !== undefined ? rect.bottom - top : 0);
  const right = rect.right ?? left + width;
  const bottom = rect.bottom ?? top + height;
  return {
    x: rect.x ?? left,
    y: rect.y ?? top,
    top,
    right,
    bottom,
    left,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function makeFakeInput(value: string): HTMLTextAreaElement {
  return {
    value,
    selectionStart: value.length,
    setSelectionRange(start: number, end: number) {
      this.selectionStart = start;
      (this as { selectionEnd?: number }).selectionEnd = end;
    },
    focus: () => undefined,
  } as unknown as HTMLTextAreaElement;
}

function waitForPickerSearch(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 160));
}

function fireFakeMouseDown(target: FakeElement): void {
  target.dispatchEvent({
    type: "mousedown",
    button: 0,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  } as unknown as Event);
}

describe("paper picker placement", function () {
  function makePlacementFixture(viewportHeight: number) {
    const fakeDocument = new FakeDocument();
    fakeDocument.defaultView.innerHeight = viewportHeight;
    fakeDocument.documentElement.clientHeight = viewportHeight;
    const body = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    );
    const panelRoot = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    );
    const inputSection = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    );
    const paperPicker = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    );
    inputSection.appendChild(paperPicker);
    panelRoot.setBoundingClientRect({
      top: 0,
      bottom: viewportHeight,
      height: viewportHeight,
    });
    return { body, panelRoot, inputSection, paperPicker };
  }

  it("prefers opening above the full input section when room exists", function () {
    const { body, panelRoot, inputSection, paperPicker } =
      makePlacementFixture(800);
    inputSection.setBoundingClientRect({ top: 500, bottom: 660, height: 160 });

    positionPaperPickerForAnchor({
      body: body as unknown as Element,
      panelRoot: panelRoot as unknown as HTMLElement,
      paperPicker: paperPicker as unknown as HTMLDivElement,
      anchor: inputSection as unknown as HTMLElement,
    });

    assert.isFalse(paperPicker.classList.contains("llm-paper-picker-below"));
    assert.equal(
      paperPicker.style.getPropertyValue("--llm-paper-picker-max-height"),
      "480px",
    );
  });

  it("keeps the picker above and scrollable when above space is constrained", function () {
    const { body, panelRoot, inputSection, paperPicker } =
      makePlacementFixture(600);
    inputSection.setBoundingClientRect({ top: 180, bottom: 340, height: 160 });

    positionPaperPickerForAnchor({
      body: body as unknown as Element,
      panelRoot: panelRoot as unknown as HTMLElement,
      paperPicker: paperPicker as unknown as HTMLDivElement,
      anchor: inputSection as unknown as HTMLElement,
    });

    assert.isFalse(paperPicker.classList.contains("llm-paper-picker-below"));
    assert.equal(
      paperPicker.style.getPropertyValue("--llm-paper-picker-max-height"),
      "160px",
    );
  });

  it("falls back below only when above space is not useful", function () {
    const { body, panelRoot, inputSection, paperPicker } =
      makePlacementFixture(600);
    inputSection.setBoundingClientRect({ top: 80, bottom: 300, height: 220 });

    positionPaperPickerForAnchor({
      body: body as unknown as Element,
      panelRoot: panelRoot as unknown as HTMLElement,
      paperPicker: paperPicker as unknown as HTMLDivElement,
      anchor: inputSection as unknown as HTMLElement,
    });

    assert.isTrue(paperPicker.classList.contains("llm-paper-picker-below"));
    assert.equal(
      paperPicker.style.getPropertyValue("--llm-paper-picker-max-height"),
      "280px",
    );
  });
});

describe("paper picker controller", function () {
  it("extracts manual and automatic Zotero tags for picker metadata", function () {
    const tagNames = getPaperSearchItemTagNames({
      getTags: () => [
        { tag: "ACC" },
        { name: "Algorithm" },
        { tag: "AutoOnly", type: 1 },
        "Data",
        { tag: "  " },
        { tag: "ACC" },
      ],
    } as unknown as Zotero.Item);

    assert.deepEqual(tagNames.manual, ["ACC", "Algorithm", "Data"]);
    assert.deepEqual(tagNames.automatic, ["AutoOnly"]);
  });

  it("filters reference candidates with the MinerU tag semantics", function () {
    const makeGroup = (
      itemId: number,
      tags: string[],
      tagsAuto: string[] = [],
    ): PaperSearchGroupCandidate => ({
      itemId,
      title: `Paper ${itemId}`,
      attachments: [],
      score: 0,
      modifiedAt: 0,
      addedAt: 0,
      collectionIds: [],
      tags,
      tagsAuto,
    });
    const groups = [
      makeGroup(1, ["ACC", "Data"]),
      makeGroup(2, ["ACC"], ["AutoOnly"]),
      makeGroup(3, []),
    ];

    assert.deepEqual(
      filterPaperPickerGroupsForTagView(groups, {
        selectedTags: ["ACC", "Data"],
      }).map((group) => group.itemId),
      [1],
    );
    assert.deepEqual(
      filterPaperPickerGroupsForTagView(groups, {
        tagScope: "untagged",
      }).map((group) => group.itemId),
      [3],
    );
    assert.deepEqual(
      filterPaperPickerGroupsForTagView(groups, {
        selectedTags: ["AutoOnly"],
        includeAutomatic: true,
      }).map((group) => group.itemId),
      [2],
    );
  });

  it("allows 30 manually selected paper contexts and rejects the 31st", function () {
    const originalZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    const itemId = 42;
    const items = Array.from(
      { length: MAX_SELECTED_PAPER_CONTEXTS + 1 },
      (_, index) => makeRegularItem(index + 1),
    );
    const attachments = new Map<number, Zotero.Item>();
    for (let index = 1; index <= MAX_SELECTED_PAPER_CONTEXTS + 1; index += 1) {
      attachments.set(2_000 + index, makeAttachment(index));
    }
    const statuses: Array<{ message: string; level: string }> = [];

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Items: {
        get(id: number) {
          return attachments.get(id) || null;
        },
      },
    };
    selectedPaperContextCache.delete(itemId);
    selectedPaperPreviewExpandedCache.delete(itemId);

    try {
      const controller = createPaperPickerController({
        body: {} as Element,
        panelRoot: {} as HTMLElement,
        inputBox: {} as HTMLTextAreaElement,
        paperPicker: null,
        paperPickerList: null,
        getItem: () => ({ id: itemId }) as Zotero.Item,
        getCurrentLibraryID: () => 1,
        isWebChatMode: () => false,
        resolveAutoLoadedPaperContext: () => null,
        getManualPaperContextsForItem: () =>
          selectedPaperContextCache.get(itemId) || [],
        isPaperContextMineru: () => false,
        getTextContextConversationKey: () => null,
        persistDraftInputForCurrentConversation: () => undefined,
        updatePaperPreviewPreservingScroll: () => undefined,
        updateSelectedTextPreviewPreservingScroll: () => undefined,
        setStatusMessage: (message, level) => statuses.push({ message, level }),
        log: () => undefined,
      });

      controller.addZoteroItemsAsPaperContext(
        items.slice(0, MAX_SELECTED_PAPER_CONTEXTS),
      );
      assert.lengthOf(
        selectedPaperContextCache.get(itemId) as PaperContextRef[],
        MAX_SELECTED_PAPER_CONTEXTS,
      );

      controller.addZoteroItemsAsPaperContext([
        items[MAX_SELECTED_PAPER_CONTEXTS],
      ]);
      assert.lengthOf(
        selectedPaperContextCache.get(itemId) as PaperContextRef[],
        MAX_SELECTED_PAPER_CONTEXTS,
      );
      assert.deepInclude(statuses, {
        message: `Paper Context up to ${MAX_SELECTED_PAPER_CONTEXTS}`,
        level: "error",
      });
    } finally {
      selectedPaperContextCache.delete(itemId);
      selectedPaperPreviewExpandedCache.delete(itemId);
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
    }
  });

  it("toggles a selected paper row off when selected again", async function () {
    const originalZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    const originalToolkit = (
      globalThis as typeof globalThis & { ztoolkit?: any }
    ).ztoolkit;
    const itemId = 43;
    const paper = makeRegularItem(1);
    const attachment = makeAttachment(1);
    const items = new Map<number, Zotero.Item>([
      [paper.id, paper],
      [attachment.id, attachment],
    ]);
    const statuses: Array<{ message: string; level: string }> = [];
    const fakeDocument = new FakeDocument();
    const paperPicker = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as HTMLDivElement;
    const paperPickerList = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as HTMLDivElement;
    const body = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as Element;
    const inputBox = makeFakeInput("@Picker");

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Items: {
        getAll: async () => [paper],
        get: (id: number) => items.get(id) || null,
      },
      Collections: {
        getByLibrary: () => [],
      },
      Libraries: {
        getName: () => "My Library",
      },
    };
    (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    invalidatePaperSearchCache(1);
    selectedPaperContextCache.delete(itemId);
    selectedPaperPreviewExpandedCache.delete(itemId);
    paperContextModeOverrides.delete(`${itemId}:${paper.id}:${attachment.id}`);

    try {
      const controller = createPaperPickerController({
        body,
        panelRoot: body as HTMLElement,
        inputBox,
        paperPicker,
        paperPickerList,
        getItem: () => ({ id: itemId }) as Zotero.Item,
        getCurrentLibraryID: () => 1,
        isWebChatMode: () => false,
        resolveAutoLoadedPaperContext: () => null,
        getManualPaperContextsForItem: () =>
          selectedPaperContextCache.get(itemId) || [],
        isPaperContextMineru: () => false,
        getTextContextConversationKey: () => null,
        persistDraftInputForCurrentConversation: () => undefined,
        updatePaperPreviewPreservingScroll: () => undefined,
        updateSelectedTextPreviewPreservingScroll: () => undefined,
        setStatusMessage: (message, level) => statuses.push({ message, level }),
        log: () => undefined,
      });

      controller.schedulePaperPickerSearch();
      await waitForPickerSearch();

      controller.selectActiveRow();
      assert.lengthOf(
        selectedPaperContextCache.get(itemId) as PaperContextRef[],
        1,
      );

      controller.selectActiveRow();
      assert.isUndefined(selectedPaperContextCache.get(itemId));
      assert.deepInclude(statuses, {
        message: "Reference context removed.",
        level: "ready",
      });
    } finally {
      selectedPaperContextCache.delete(itemId);
      selectedPaperPreviewExpandedCache.delete(itemId);
      paperContextModeOverrides.delete(
        `${itemId}:${paper.id}:${attachment.id}`,
      );
      invalidatePaperSearchCache(1);
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
        originalToolkit;
    }
  });

  it("adds a folder action as collection context, not individual paper chips", async function () {
    const originalZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    const originalToolkit = (
      globalThis as typeof globalThis & { ztoolkit?: any }
    ).ztoolkit;
    const itemId = 44;
    const collectionId = 501;
    const paper = makeRegularItem(1) as Zotero.Item & {
      getCollections: () => number[];
    };
    paper.getCollections = () => [collectionId];
    const attachment = makeAttachment(1);
    const items = new Map<number, Zotero.Item>([
      [paper.id, paper],
      [attachment.id, attachment],
    ]);
    const collection = {
      id: collectionId,
      name: "Systems",
      parentID: 0,
      getChildCollections: () => [],
      getChildItems: () => [paper.id],
    } as unknown as Zotero.Collection;
    const statuses: Array<{ message: string; level: string }> = [];
    const fakeDocument = new FakeDocument();
    const paperPicker = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as HTMLDivElement;
    const paperPickerList = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as HTMLDivElement;
    const body = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as Element;
    const inputBox = makeFakeInput("@");

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Items: {
        getAll: async () => [paper],
        get: (id: number) => items.get(id) || null,
      },
      Collections: {
        getByLibrary: () => [collection],
      },
      Libraries: {
        getName: () => "My Library",
      },
    };
    (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    invalidatePaperSearchCache(1);
    selectedCollectionContextCache.delete(itemId);
    selectedPaperContextCache.delete(itemId);
    selectedPaperPreviewExpandedCache.delete(itemId);

    try {
      const controller = createPaperPickerController({
        body,
        panelRoot: body as HTMLElement,
        inputBox,
        paperPicker,
        paperPickerList,
        getItem: () => ({ id: itemId }) as Zotero.Item,
        getCurrentLibraryID: () => 1,
        isWebChatMode: () => false,
        resolveAutoLoadedPaperContext: () => null,
        getManualPaperContextsForItem: () =>
          selectedPaperContextCache.get(itemId) || [],
        isPaperContextMineru: () => false,
        getTextContextConversationKey: () => null,
        persistDraftInputForCurrentConversation: () => undefined,
        updatePaperPreviewPreservingScroll: () => undefined,
        updateSelectedTextPreviewPreservingScroll: () => undefined,
        setStatusMessage: (message, level) => statuses.push({ message, level }),
        log: () => undefined,
      });

      controller.schedulePaperPickerSearch();
      await waitForPickerSearch();

      const root = paperPickerList as unknown as FakeElement;
      const shell = root.children[0];
      const folderPanel = shell.children[0];
      const folderPane = folderPanel.children[2];
      const libraryRow = folderPane.children[0];
      const collectionRow = folderPane.children[1];
      const collectionAction = collectionRow.children[4];

      assert.lengthOf(libraryRow.children, 4);
      assert.equal(collectionAction.textContent, "+");
      fireFakeMouseDown(collectionAction);

      assert.deepInclude(
        selectedCollectionContextCache.get(itemId) as CollectionContextRef[],
        {
          collectionId,
          name: "Systems",
          libraryID: 1,
        },
      );
      assert.isUndefined(selectedPaperContextCache.get(itemId));
      assert.deepInclude(statuses, {
        message: "Collection context added.",
        level: "ready",
      });
    } finally {
      selectedCollectionContextCache.delete(itemId);
      selectedPaperContextCache.delete(itemId);
      selectedPaperPreviewExpandedCache.delete(itemId);
      invalidatePaperSearchCache(1);
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
        originalToolkit;
    }
  });

  it("adds a tag action as tag context, not individual paper chips", async function () {
    const originalZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    const originalToolkit = (
      globalThis as typeof globalThis & { ztoolkit?: any }
    ).ztoolkit;
    const itemId = 44;
    const paper = makeRegularItem(1) as Zotero.Item & {
      getTags: () => Array<{ tag: string; type?: number }>;
    };
    paper.getTags = () => [{ tag: "Stable" }];
    const attachment = makeAttachment(1);
    const items = new Map<number, Zotero.Item>([
      [paper.id, paper],
      [attachment.id, attachment],
    ]);
    const fakeDocument = new FakeDocument();
    const paperPicker = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as HTMLDivElement;
    const paperPickerList = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as HTMLDivElement;
    const body = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as Element;
    const inputBox = makeFakeInput("@");

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Items: {
        getAll: async () => [paper],
        get: (id: number) => items.get(id) || null,
      },
      Collections: {
        getByLibrary: () => [],
      },
      Libraries: {
        getName: () => "My Library",
      },
    };
    (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    invalidatePaperSearchCache(1);
    selectedPaperContextCache.delete(itemId);
    selectedPaperPreviewExpandedCache.delete(itemId);
    selectedTagContextCache.delete(itemId);

    try {
      const controller = createPaperPickerController({
        body,
        panelRoot: body as HTMLElement,
        inputBox,
        paperPicker,
        paperPickerList,
        getItem: () => ({ id: itemId }) as Zotero.Item,
        getCurrentLibraryID: () => 1,
        isWebChatMode: () => false,
        resolveAutoLoadedPaperContext: () => null,
        getManualPaperContextsForItem: () =>
          selectedPaperContextCache.get(itemId) || [],
        isPaperContextMineru: () => false,
        getTextContextConversationKey: () => null,
        persistDraftInputForCurrentConversation: () => undefined,
        updatePaperPreviewPreservingScroll: () => undefined,
        updateSelectedTextPreviewPreservingScroll: () => undefined,
        setStatusMessage: () => undefined,
        log: () => undefined,
      });

      controller.schedulePaperPickerSearch();
      await waitForPickerSearch();

      let shell = (paperPickerList as unknown as FakeElement).children[0];
      let tagPanel = shell.children[2];
      fireFakeMouseDown(tagPanel.children[0].children[0]);
      shell = (paperPickerList as unknown as FakeElement).children[0];
      tagPanel = shell.children[2];
      const tagCloud = tagPanel.children[3];
      const stableTagWrap = tagCloud.children[0];
      const stableTagAction = stableTagWrap.children[1];
      assert.equal(stableTagAction.textContent, "+");

      fireFakeMouseDown(stableTagAction);

      const selectedTags = selectedTagContextCache.get(
        itemId,
      ) as TagContextRef[];
      assert.lengthOf(selectedTags, 1);
      assert.equal(selectedTags[0].name, "Stable");
      assert.equal(selectedTags[0].normalizedName, "stable");
      assert.equal(selectedTags[0].libraryID, 1);
      assert.equal(selectedTags[0].includeAutomatic, false);
      assert.isUndefined(selectedPaperContextCache.get(itemId));

      shell = (paperPickerList as unknown as FakeElement).children[0];
      tagPanel = shell.children[2];
      const selectedStableTagAction = tagPanel.children[3].children[0].children[1];
      assert.equal(selectedStableTagAction.textContent, "✓");
      fireFakeMouseDown(selectedStableTagAction);

      assert.isUndefined(selectedTagContextCache.get(itemId));

      shell = (paperPickerList as unknown as FakeElement).children[0];
      let referencePanel = shell.children[1];
      let rowHost = referencePanel.children[2];
      assert.equal(rowHost.children[0].children[1].textContent, "+");

      fireFakeMouseDown(rowHost.children[0].children[1]);

      shell = (paperPickerList as unknown as FakeElement).children[0];
      referencePanel = shell.children[1];
      rowHost = referencePanel.children[2];
      assert.equal(rowHost.children[0].children[1].textContent, "✓");
    } finally {
      selectedPaperContextCache.delete(itemId);
      selectedPaperPreviewExpandedCache.delete(itemId);
      selectedTagContextCache.delete(itemId);
      invalidatePaperSearchCache(1);
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
        originalToolkit;
    }
  });

  it("adds a searched tag name as tag context", async function () {
    const originalZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    const originalToolkit = (
      globalThis as typeof globalThis & { ztoolkit?: any }
    ).ztoolkit;
    const itemId = 145;
    const paper = makeRegularItem(3) as Zotero.Item & {
      getTags: () => Array<{ tag: string; type?: number }>;
    };
    paper.getTags = () => [{ tag: "Stable Dynamics" }];
    const attachment = makeAttachment(3);
    const items = new Map<number, Zotero.Item>([
      [paper.id, paper],
      [attachment.id, attachment],
    ]);
    const fakeDocument = new FakeDocument();
    const paperPicker = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as HTMLDivElement;
    const paperPickerList = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as HTMLDivElement;
    const body = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as Element;
    const inputBox = makeFakeInput("@Stable");

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Items: {
        getAll: async () => [paper],
        get: (id: number) => items.get(id) || null,
      },
      Collections: {
        getByLibrary: () => [],
      },
      Libraries: {
        getName: () => "My Library",
      },
    };
    (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    invalidatePaperSearchCache(1);
    selectedPaperContextCache.delete(itemId);
    selectedPaperPreviewExpandedCache.delete(itemId);
    selectedTagContextCache.delete(itemId);

    try {
      const controller = createPaperPickerController({
        body,
        panelRoot: body as HTMLElement,
        inputBox,
        paperPicker,
        paperPickerList,
        getItem: () => ({ id: itemId }) as Zotero.Item,
        getCurrentLibraryID: () => 1,
        isWebChatMode: () => false,
        resolveAutoLoadedPaperContext: () => null,
        getManualPaperContextsForItem: () =>
          selectedPaperContextCache.get(itemId) || [],
        isPaperContextMineru: () => false,
        getTextContextConversationKey: () => null,
        persistDraftInputForCurrentConversation: () => undefined,
        updatePaperPreviewPreservingScroll: () => undefined,
        updateSelectedTextPreviewPreservingScroll: () => undefined,
        setStatusMessage: () => undefined,
        log: () => undefined,
      });

      controller.schedulePaperPickerSearch();
      await waitForPickerSearch();

      const root = paperPickerList as unknown as FakeElement;
      const main = root.children[0];
      const rowHost = main.children[0];
      assert.lengthOf(rowHost.children, 1);
      const tagRow = rowHost.children[0];
      assert.include(tagRow.className, "llm-paper-picker-tag-row");
      assert.equal(
        tagRow.children[0].children[0].children[1].textContent,
        "Stable Dynamics",
      );
      assert.include(tagRow.children[0].children[1].textContent, "Tag");
      assert.equal(tagRow.children[1].textContent, "+");

      fireFakeMouseDown(tagRow.children[1]);

      const selectedTags = selectedTagContextCache.get(
        itemId,
      ) as TagContextRef[];
      assert.lengthOf(selectedTags, 1);
      assert.equal(selectedTags[0].name, "Stable Dynamics");
      assert.equal(selectedTags[0].normalizedName, "stable dynamics");
      assert.equal(selectedTags[0].libraryID, 1);
      assert.equal(selectedTags[0].includeAutomatic, false);
      assert.isUndefined(selectedPaperContextCache.get(itemId));
    } finally {
      selectedPaperContextCache.delete(itemId);
      selectedPaperPreviewExpandedCache.delete(itemId);
      selectedTagContextCache.delete(itemId);
      invalidatePaperSearchCache(1);
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
        originalToolkit;
    }
  });

  it("includes automatic tags when searched tag count includes them", async function () {
    const originalZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    const originalToolkit = (
      globalThis as typeof globalThis & { ztoolkit?: any }
    ).ztoolkit;
    const itemId = 146;
    const manualPaper = makeRegularItem(4) as Zotero.Item & {
      getTags: () => Array<{ tag: string; type?: number }>;
    };
    const automaticPaper = makeRegularItem(5) as Zotero.Item & {
      getTags: () => Array<{ tag: string; type?: number }>;
    };
    manualPaper.getTags = () => [{ tag: "Stable Mixed" }];
    automaticPaper.getTags = () => [{ tag: "Stable Mixed", type: 1 }];
    const manualAttachment = makeAttachment(4);
    const automaticAttachment = makeAttachment(5);
    const items = new Map<number, Zotero.Item>([
      [manualPaper.id, manualPaper],
      [automaticPaper.id, automaticPaper],
      [manualAttachment.id, manualAttachment],
      [automaticAttachment.id, automaticAttachment],
    ]);
    const fakeDocument = new FakeDocument();
    const paperPicker = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as HTMLDivElement;
    const paperPickerList = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as HTMLDivElement;
    const body = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as Element;
    const inputBox = makeFakeInput("@Stable");

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Items: {
        getAll: async () => [manualPaper, automaticPaper],
        get: (id: number) => items.get(id) || null,
      },
      Collections: {
        getByLibrary: () => [],
      },
      Libraries: {
        getName: () => "My Library",
      },
    };
    (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    invalidatePaperSearchCache(1);
    selectedPaperContextCache.delete(itemId);
    selectedPaperPreviewExpandedCache.delete(itemId);
    selectedTagContextCache.delete(itemId);

    try {
      const controller = createPaperPickerController({
        body,
        panelRoot: body as HTMLElement,
        inputBox,
        paperPicker,
        paperPickerList,
        getItem: () => ({ id: itemId }) as Zotero.Item,
        getCurrentLibraryID: () => 1,
        isWebChatMode: () => false,
        resolveAutoLoadedPaperContext: () => null,
        getManualPaperContextsForItem: () =>
          selectedPaperContextCache.get(itemId) || [],
        isPaperContextMineru: () => false,
        getTextContextConversationKey: () => null,
        persistDraftInputForCurrentConversation: () => undefined,
        updatePaperPreviewPreservingScroll: () => undefined,
        updateSelectedTextPreviewPreservingScroll: () => undefined,
        setStatusMessage: () => undefined,
        log: () => undefined,
      });

      controller.schedulePaperPickerSearch();
      await waitForPickerSearch();

      const root = paperPickerList as unknown as FakeElement;
      const main = root.children[0];
      const rowHost = main.children[0];
      assert.lengthOf(rowHost.children, 1);
      const tagRow = rowHost.children[0];
      assert.include(tagRow.className, "llm-paper-picker-tag-row");
      assert.equal(
        tagRow.children[0].children[0].children[1].textContent,
        "Stable Mixed",
      );
      assert.include(tagRow.children[0].children[1].textContent, "Tag");

      fireFakeMouseDown(tagRow.children[1]);

      const selectedTags = selectedTagContextCache.get(
        itemId,
      ) as TagContextRef[];
      assert.lengthOf(selectedTags, 1);
      assert.equal(selectedTags[0].name, "Stable Mixed");
      assert.equal(selectedTags[0].normalizedName, "stable mixed");
      assert.equal(selectedTags[0].libraryID, 1);
      assert.equal(selectedTags[0].includeAutomatic, true);
      assert.isUndefined(selectedPaperContextCache.get(itemId));
    } finally {
      selectedPaperContextCache.delete(itemId);
      selectedPaperPreviewExpandedCache.delete(itemId);
      selectedTagContextCache.delete(itemId);
      invalidatePaperSearchCache(1);
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
        originalToolkit;
    }
  });

  it("keeps folder clicks open while tag starts collapsed and panels toggle independently", async function () {
    const originalZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    const originalToolkit = (
      globalThis as typeof globalThis & { ztoolkit?: any }
    ).ztoolkit;
    const itemId = 45;
    const collectionId = 502;
    const paper = makeRegularItem(1) as Zotero.Item & {
      getCollections: () => number[];
    };
    paper.getCollections = () => [collectionId];
    const attachment = makeAttachment(1);
    const items = new Map<number, Zotero.Item>([
      [paper.id, paper],
      [attachment.id, attachment],
    ]);
    const collection = {
      id: collectionId,
      name: "Geometry",
      parentID: 0,
      getChildCollections: () => [],
      getChildItems: () => [paper.id],
    } as unknown as Zotero.Collection;
    const fakeDocument = new FakeDocument();
    const paperPicker = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as HTMLDivElement;
    const paperPickerList = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as HTMLDivElement;
    const body = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as Element;
    const inputBox = makeFakeInput("@");

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Items: {
        getAll: async () => [paper],
        get: (id: number) => items.get(id) || null,
      },
      Collections: {
        getByLibrary: () => [collection],
      },
      Libraries: {
        getName: () => "My Library",
      },
    };
    (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    invalidatePaperSearchCache(1);

    try {
      const controller = createPaperPickerController({
        body,
        panelRoot: body as HTMLElement,
        inputBox,
        paperPicker,
        paperPickerList,
        getItem: () => ({ id: itemId }) as Zotero.Item,
        getCurrentLibraryID: () => 1,
        isWebChatMode: () => false,
        resolveAutoLoadedPaperContext: () => null,
        getManualPaperContextsForItem: () =>
          selectedPaperContextCache.get(itemId) || [],
        isPaperContextMineru: () => false,
        getTextContextConversationKey: () => null,
        persistDraftInputForCurrentConversation: () => undefined,
        updatePaperPreviewPreservingScroll: () => undefined,
        updateSelectedTextPreviewPreservingScroll: () => undefined,
        setStatusMessage: () => undefined,
        log: () => undefined,
      });

      controller.schedulePaperPickerSearch();
      await waitForPickerSearch();

      const getPanels = () => {
        const shell = (paperPickerList as unknown as FakeElement).children[0];
        return {
          folderPanel: shell.children[0],
          referencePanel: shell.children[1],
          tagPanel: shell.children[2],
        };
      };

      let { folderPanel, tagPanel, referencePanel } = getPanels();
      assert.lengthOf(folderPanel.children, 4);
      assert.include(tagPanel.className, "llm-paper-picker-panel-collapsed");
      assert.lengthOf(tagPanel.children, 1);
      assert.lengthOf(referencePanel.children, 3);
      assert.equal(folderPanel.children[1].children[1].textContent, "Folders");
      assert.equal(tagPanel.children[0].children[1].textContent, "Tags");
      assert.equal(referencePanel.children[1].children[1].textContent, "Items");
      assert.include(
        referencePanel.children[2].children[0].children[1].className,
        "llm-paper-picker-scope-action",
      );

      fireFakeMouseDown(folderPanel.children[2].children[1]);
      ({ folderPanel, tagPanel, referencePanel } = getPanels());
      assert.notInclude(
        folderPanel.className,
        "llm-paper-picker-panel-collapsed",
      );
      assert.lengthOf(folderPanel.children, 4);
      assert.lengthOf(tagPanel.children, 1);
      assert.lengthOf(referencePanel.children, 3);

      fireFakeMouseDown(folderPanel.children[1]);
      ({ folderPanel, tagPanel, referencePanel } = getPanels());
      assert.include(folderPanel.className, "llm-paper-picker-panel-collapsed");
      assert.lengthOf(folderPanel.children, 1);
      assert.lengthOf(tagPanel.children, 1);
      assert.lengthOf(referencePanel.children, 3);

      fireFakeMouseDown(tagPanel.children[0]);
      ({ folderPanel, tagPanel, referencePanel } = getPanels());
      assert.notInclude(tagPanel.className, "llm-paper-picker-panel-collapsed");
      assert.lengthOf(folderPanel.children, 1);
      assert.lengthOf(tagPanel.children, 5);
      assert.lengthOf(referencePanel.children, 3);

      const referenceHeader = referencePanel.children[1];
      fireFakeMouseDown(referenceHeader);
      ({ folderPanel, tagPanel, referencePanel } = getPanels());
      assert.include(
        referencePanel.className,
        "llm-paper-picker-panel-collapsed",
      );
      assert.lengthOf(folderPanel.children, 1);
      assert.lengthOf(tagPanel.children, 5);
      assert.lengthOf(referencePanel.children, 1);
    } finally {
      selectedCollectionContextCache.delete(itemId);
      selectedPaperContextCache.delete(itemId);
      selectedPaperPreviewExpandedCache.delete(itemId);
      invalidatePaperSearchCache(1);
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
        originalToolkit;
    }
  });

  it("uses the current anchor height before the first browse render", async function () {
    const originalZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    const originalToolkit = (
      globalThis as typeof globalThis & { ztoolkit?: any }
    ).ztoolkit;
    const itemId = 146;
    const paper = makeRegularItem(1);
    const attachment = makeAttachment(1);
    const items = new Map<number, Zotero.Item>([
      [paper.id, paper],
      [attachment.id, attachment],
    ]);
    const fakeDocument = new FakeDocument();
    const body = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as Element;
    const panelRoot = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as FakeElement;
    const inputSection = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as FakeElement;
    const paperPicker = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as FakeElement;
    const paperPickerList = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as FakeElement;
    const inputBox = makeFakeInput("@");

    panelRoot.setBoundingClientRect({ top: 0, bottom: 800, height: 800 });
    inputSection.setBoundingClientRect({ top: 520, bottom: 650, height: 130 });
    paperPicker.style.display = "none";
    paperPicker.appendChild(paperPickerList);
    inputSection.appendChild(paperPicker);

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Items: {
        getAll: async () => [paper],
        get: (id: number) => items.get(id) || null,
      },
      Collections: {
        getByLibrary: () => [],
      },
      Libraries: {
        getName: () => "My Library",
      },
    };
    (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    invalidatePaperSearchCache(1);

    try {
      const controller = createPaperPickerController({
        body,
        panelRoot: panelRoot as unknown as HTMLElement,
        inputBox,
        paperPicker: paperPicker as unknown as HTMLDivElement,
        paperPickerList: paperPickerList as unknown as HTMLDivElement,
        getItem: () => ({ id: itemId }) as Zotero.Item,
        getCurrentLibraryID: () => 1,
        isWebChatMode: () => false,
        resolveAutoLoadedPaperContext: () => null,
        getManualPaperContextsForItem: () => [],
        isPaperContextMineru: () => false,
        getTextContextConversationKey: () => null,
        persistDraftInputForCurrentConversation: () => undefined,
        updatePaperPreviewPreservingScroll: () => undefined,
        updateSelectedTextPreviewPreservingScroll: () => undefined,
        setStatusMessage: () => undefined,
        log: () => undefined,
      });

      controller.schedulePaperPickerSearch();
      await waitForPickerSearch();

      assert.equal(paperPicker.style.display, "block");
      assert.equal(
        paperPicker.style.getPropertyValue("--llm-paper-picker-max-height"),
        "500px",
      );
      const shell = paperPickerList.children[0];
      const referencePanel = shell.children[1];
      assert.equal(referencePanel.style.height, "270px");
    } finally {
      selectedCollectionContextCache.delete(itemId);
      selectedPaperContextCache.delete(itemId);
      selectedPaperPreviewExpandedCache.delete(itemId);
      invalidatePaperSearchCache(1);
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
        originalToolkit;
    }
  });

  it("adds the default attachment from a multi-file item action without expanding", async function () {
    const originalZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    const originalToolkit = (
      globalThis as typeof globalThis & { ztoolkit?: any }
    ).ztoolkit;
    const itemId = 46;
    const paper = makeRegularItem(1) as Zotero.Item & {
      getAttachments: () => number[];
    };
    const firstAttachment = makeAttachment(1);
    const secondAttachment = {
      ...makeAttachment(2),
      key: "ATTACH-2001B",
      parentID: paper.id,
      getField: (field: string) => (field === "title" ? "Second PDF" : ""),
    } as unknown as Zotero.Item;
    paper.getAttachments = () => [firstAttachment.id, secondAttachment.id];
    const items = new Map<number, Zotero.Item>([
      [paper.id, paper],
      [firstAttachment.id, firstAttachment],
      [secondAttachment.id, secondAttachment],
    ]);
    const fakeDocument = new FakeDocument();
    const paperPicker = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as HTMLDivElement;
    const paperPickerList = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as HTMLDivElement;
    const body = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as Element;
    const inputBox = makeFakeInput("@");

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Items: {
        getAll: async () => [paper],
        get: (id: number) => items.get(id) || null,
      },
      Collections: {
        getByLibrary: () => [],
      },
      Libraries: {
        getName: () => "My Library",
      },
    };
    (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    invalidatePaperSearchCache(1);
    selectedPaperContextCache.delete(itemId);
    selectedPaperPreviewExpandedCache.delete(itemId);

    try {
      const controller = createPaperPickerController({
        body,
        panelRoot: body as HTMLElement,
        inputBox,
        paperPicker,
        paperPickerList,
        getItem: () => ({ id: itemId }) as Zotero.Item,
        getCurrentLibraryID: () => 1,
        isWebChatMode: () => false,
        resolveAutoLoadedPaperContext: () => null,
        getManualPaperContextsForItem: () =>
          selectedPaperContextCache.get(itemId) || [],
        isPaperContextMineru: () => false,
        getTextContextConversationKey: () => null,
        persistDraftInputForCurrentConversation: () => undefined,
        updatePaperPreviewPreservingScroll: () => undefined,
        updateSelectedTextPreviewPreservingScroll: () => undefined,
        setStatusMessage: () => undefined,
        log: () => undefined,
      });

      controller.schedulePaperPickerSearch();
      await waitForPickerSearch();

      const root = paperPickerList as unknown as FakeElement;
      let shell = root.children[0];
      let referencePanel = shell.children[1];
      let rowHost = referencePanel.children[2];
      assert.lengthOf(rowHost.children, 1);
      const firstRowAction = rowHost.children[0].children[1];

      fireFakeMouseDown(firstRowAction);

      const selected = selectedPaperContextCache.get(
        itemId,
      ) as PaperContextRef[];
      assert.lengthOf(selected, 1);
      assert.equal(selected[0].contextItemId, firstAttachment.id);

      shell = root.children[0];
      referencePanel = shell.children[1];
      rowHost = referencePanel.children[2];
      assert.lengthOf(rowHost.children, 1);
      const selectedRowAction = rowHost.children[0].children[1];
      assert.equal(selectedRowAction.textContent, "✓");
      fireFakeMouseDown(selectedRowAction);

      assert.isUndefined(selectedPaperContextCache.get(itemId));

      shell = root.children[0];
      referencePanel = shell.children[1];
      rowHost = referencePanel.children[2];
      assert.lengthOf(rowHost.children, 1);
      assert.equal(rowHost.children[0].children[1].textContent, "+");
    } finally {
      selectedPaperContextCache.delete(itemId);
      selectedPaperPreviewExpandedCache.delete(itemId);
      invalidatePaperSearchCache(1);
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
        originalToolkit;
    }
  });

  it("expands a multi-file parent row without moving the item view", async function () {
    const originalZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    const originalToolkit = (
      globalThis as typeof globalThis & { ztoolkit?: any }
    ).ztoolkit;
    const itemId = 47;
    const firstPaper = makeRegularItem(1);
    const firstPaperAttachment = makeAttachment(1);
    const multiPaper = makeRegularItem(2) as Zotero.Item & {
      getAttachments: () => number[];
    };
    const firstMultiAttachment = makeAttachment(2);
    const secondMultiAttachment = {
      ...makeAttachment(3),
      key: "ATTACH-2002B",
      id: 3_002,
      parentID: multiPaper.id,
      getField: (field: string) => (field === "title" ? "Second PDF" : ""),
    } as unknown as Zotero.Item;
    multiPaper.getAttachments = () => [
      firstMultiAttachment.id,
      secondMultiAttachment.id,
    ];
    const items = new Map<number, Zotero.Item>([
      [firstPaper.id, firstPaper],
      [firstPaperAttachment.id, firstPaperAttachment],
      [multiPaper.id, multiPaper],
      [firstMultiAttachment.id, firstMultiAttachment],
      [secondMultiAttachment.id, secondMultiAttachment],
    ]);
    const fakeDocument = new FakeDocument();
    const paperPicker = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as HTMLDivElement;
    const paperPickerList = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as HTMLDivElement;
    const body = fakeDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as Element;
    const inputBox = makeFakeInput("@");

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Items: {
        getAll: async () => [firstPaper, multiPaper],
        get: (id: number) => items.get(id) || null,
      },
      Collections: {
        getByLibrary: () => [],
      },
      Libraries: {
        getName: () => "My Library",
      },
    };
    (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };
    invalidatePaperSearchCache(1);
    selectedPaperContextCache.delete(itemId);
    selectedPaperPreviewExpandedCache.delete(itemId);

    try {
      const controller = createPaperPickerController({
        body,
        panelRoot: body as HTMLElement,
        inputBox,
        paperPicker,
        paperPickerList,
        getItem: () => ({ id: itemId }) as Zotero.Item,
        getCurrentLibraryID: () => 1,
        isWebChatMode: () => false,
        resolveAutoLoadedPaperContext: () => null,
        getManualPaperContextsForItem: () =>
          selectedPaperContextCache.get(itemId) || [],
        isPaperContextMineru: () => false,
        getTextContextConversationKey: () => null,
        persistDraftInputForCurrentConversation: () => undefined,
        updatePaperPreviewPreservingScroll: () => undefined,
        updateSelectedTextPreviewPreservingScroll: () => undefined,
        setStatusMessage: () => undefined,
        log: () => undefined,
      });

      controller.schedulePaperPickerSearch();
      await waitForPickerSearch();

      const root = paperPickerList as unknown as FakeElement;
      let shell = root.children[0];
      let referencePanel = shell.children[1];
      let rowHost = referencePanel.children[2];
      assert.lengthOf(rowHost.children, 2);
      rowHost.scrollTop = 73;

      fireFakeMouseDown(rowHost.children[1]);

      shell = root.children[0];
      referencePanel = shell.children[1];
      rowHost = referencePanel.children[2];
      assert.equal(rowHost.scrollTop, 73);
      assert.lengthOf(rowHost.children, 4);
      assert.equal(rowHost.children[1].attributes.get("aria-selected"), "true");
      assert.equal(rowHost.children[2].attributes.get("aria-selected"), "false");

      rowHost.scrollTop = 91;
      fireFakeMouseDown(rowHost.children[1]);

      shell = root.children[0];
      referencePanel = shell.children[1];
      rowHost = referencePanel.children[2];
      assert.equal(rowHost.scrollTop, 91);
      assert.lengthOf(rowHost.children, 2);
      assert.equal(rowHost.children[1].attributes.get("aria-selected"), "true");

      rowHost.scrollTop = 127;
      fireFakeMouseDown(rowHost.children[1]);

      shell = root.children[0];
      referencePanel = shell.children[1];
      rowHost = referencePanel.children[2];
      assert.equal(rowHost.scrollTop, 127);
      assert.lengthOf(rowHost.children, 4);

      rowHost.scrollTop = 143;
      fireFakeMouseDown(rowHost.children[2].children[1]);

      shell = root.children[0];
      referencePanel = shell.children[1];
      rowHost = referencePanel.children[2];
      assert.equal(rowHost.scrollTop, 143);
      assert.equal(rowHost.children[2].children[1].textContent, "✓");
    } finally {
      selectedPaperContextCache.delete(itemId);
      selectedPaperPreviewExpandedCache.delete(itemId);
      invalidatePaperSearchCache(1);
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
        originalToolkit;
    }
  });
});
