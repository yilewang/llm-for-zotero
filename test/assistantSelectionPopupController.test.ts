import { assert } from "chai";
import {
  appendSelectedTextContextForItem,
  getSelectedTextContextEntries,
  setSelectedTextContextEntries,
  updateSelectedTextContextQueryForItem,
} from "../src/modules/contextPanel/contextResolution";
import { setChatPanelExtensions } from "../src/modules/contextPanel/chatPanelExtensions";
import { attachAssistantSelectionPopup } from "../src/modules/contextPanel/setupHandlers/controllers/assistantSelectionPopupController";

type Listener = (e: any) => void;

/** A minimal DOM: enough for the Quote button to open the inline box. */
function makeFakePanel(selectedText: string) {
  const doc: any = {};
  const makeEl = (tag: string): any => {
    const classes = new Set<string>();
    const listeners = new Map<string, Listener[]>();
    const el: any = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      style: {},
      dataset: {},
      textContent: "",
      value: "",
      scrollHeight: 24,
      children: [] as any[],
      parentNode: null as any,
      ownerDocument: doc,
      isConnected: true,
      focused: false,
      selectionStart: 0,
      selectionEnd: 0,
      classList: {
        add: (...names: string[]) => names.forEach((n) => classes.add(n)),
        remove: (...names: string[]) => names.forEach((n) => classes.delete(n)),
        contains: (name: string) => classes.has(name),
        toggle: (name: string, force?: boolean) => {
          const on = force ?? !classes.has(name);
          if (on) classes.add(name);
          else classes.delete(name);
          return on;
        },
      },
      get className() {
        return Array.from(classes).join(" ");
      },
      set className(value: string) {
        classes.clear();
        for (const name of value.split(/\s+/).filter(Boolean)) {
          classes.add(name);
        }
      },
      append(...nodes: any[]) {
        for (const node of nodes) {
          node.parentNode = el;
          el.children.push(node);
        }
      },
      appendChild(node: any) {
        if (node && node.fragmentText !== undefined) {
          el.textContent = node.fragmentText;
          return node;
        }
        el.append(node);
        return node;
      },
      remove() {
        if (!el.parentNode) return;
        el.parentNode.children = el.parentNode.children.filter(
          (child: any) => child !== el,
        );
        el.parentNode = null;
      },
      contains(node: any): boolean {
        if (node === el) return true;
        return el.children.some(
          (child: any) => child === node || child.contains?.(node),
        );
      },
      closest(selector: string) {
        const wanted = selector.split(".").slice(1);
        for (let node = el; node; node = node.parentNode) {
          if (wanted.every((name) => node.classList?.contains(name))) {
            return node;
          }
        }
        return null;
      },
      querySelectorAll: () => [],
      addEventListener(type: string, fn: Listener) {
        listeners.set(type, [...(listeners.get(type) || []), fn]);
      },
      removeEventListener(type: string, fn: Listener) {
        listeners.set(
          type,
          (listeners.get(type) || []).filter((entry) => entry !== fn),
        );
      },
      dispatch(type: string, init: any = {}) {
        const event = {
          type,
          target: el,
          button: 0,
          preventDefault() {},
          stopPropagation() {},
          ...init,
        };
        for (const fn of listeners.get(type) || []) fn(event);
        return event;
      },
      focus() {
        el.focused = true;
      },
      setSelectionRange(start: number, end: number) {
        el.selectionStart = start;
        el.selectionEnd = end;
      },
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        right: 200,
        bottom: 40,
        width: 200,
        height: 40,
      }),
      getClientRects: () => [{}],
    };
    return el;
  };

  const panelRoot = makeEl("div");
  const chatBox = makeEl("div");
  const bubble = makeEl("div");
  bubble.className = "llm-bubble assistant";
  const textNode: any = {
    nodeType: 3,
    parentElement: bubble,
    contains: () => false,
  };
  bubble.children.push(textNode);
  chatBox.append(bubble);
  panelRoot.append(chatBox);

  const range = {
    cloneContents: () => ({ fragmentText: selectedText }),
    getBoundingClientRect: () => ({
      left: 10,
      top: 10,
      right: 60,
      bottom: 20,
      width: 50,
      height: 10,
    }),
    getClientRects: () => [],
  };
  const panelWin: any = {
    getSelection: () => ({
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: textNode,
      focusNode: textNode,
      focusOffset: 0,
      getRangeAt: () => range,
      removeAllRanges: () => {
        panelWin.selectionCleared = true;
      },
    }),
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.assign(doc, {
    defaultView: panelWin,
    createElementNS: (_ns: string, tag: string) => makeEl(tag),
    createElement: (tag: string) => makeEl(tag),
    addEventListener() {},
    removeEventListener() {},
  });
  const inputBox = makeEl("textarea");
  return { doc, panelRoot, panelWin, chatBox, inputBox };
}

const findByClass = (root: any, name: string): any => {
  if (root.classList?.contains(name)) return root;
  for (const child of root.children || []) {
    const found = findByClass(child, name);
    if (found) return found;
  }
  return null;
};

describe("assistant reply Quote box", function () {
  const conversationKey = 818181;
  const quoted = "A sentence from the reply.";

  beforeEach(function () {
    setSelectedTextContextEntries(conversationKey, []);
  });
  afterEach(function () {
    setSelectedTextContextEntries(conversationKey, []);
  });

  function openQuoteBox() {
    const panel = makeFakePanel(quoted);
    attachAssistantSelectionPopup({
      body: { querySelector: () => null } as unknown as Element,
      panelRoot: panel.panelRoot,
      panelDoc: panel.doc,
      panelWin: panel.panelWin,
      chatBox: panel.chatBox,
      inputBox: panel.inputBox,
      status: null,
      getItem: () => ({}) as Zotero.Item,
      getTextContextConversationKey: () => conversationKey,
      runWithChatScrollGuard: (fn) => fn(),
      updateSelectedTextPreviewPreservingScroll: () => {},
      isElementNode: (value: unknown): value is Element =>
        Boolean(value) && (value as { nodeType?: number }).nodeType === 1,
    });
    findByClass(panel.panelRoot, "llm-assistant-selection-action").dispatch(
      "click",
    );
    const popup = findByClass(panel.panelRoot, "llm-assistant-selection-popup");
    const input = findByClass(
      panel.panelRoot,
      "llm-assistant-selection-prompt-input",
    );
    return { popup, input };
  }
  const pressEnter = (input: any, text: string) => {
    input.value = text;
    input.dispatch("keydown", {
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      keyCode: 13,
      repeat: false,
    });
  };
  const chipQuestion = () =>
    getSelectedTextContextEntries(conversationKey)[0]?.userQuery;

  it("opens empty for a new quote and attaches the typed question", function () {
    const { popup, input } = openQuoteBox();
    assert.isTrue(popup.classList.contains("is-expanded"));
    assert.equal(input.value, "");
    pressEnter(input, "What does it mean?");
    assert.equal(chipQuestion(), "What does it mean?");
  });

  it("reopens with the chip's question, caret at the end, and Enter replaces it", function () {
    appendSelectedTextContextForItem(conversationKey, quoted, "model");
    updateSelectedTextContextQueryForItem(
      conversationKey,
      quoted,
      "model",
      null,
      "Old question?",
    );
    const { popup, input } = openQuoteBox();
    assert.isTrue(popup.classList.contains("is-expanded"));
    assert.equal(input.value, "Old question?");
    assert.isTrue(input.focused);
    assert.equal(input.selectionStart, "Old question?".length);
    assert.equal(input.selectionEnd, "Old question?".length);
    assert.lengthOf(getSelectedTextContextEntries(conversationKey), 1);

    pressEnter(input, "New question?");
    assert.equal(chipQuestion(), "New question?");
    assert.isFalse(popup.classList.contains("is-expanded"));
  });

  it("empty Enter on a reopened box closes it and keeps the question", function () {
    appendSelectedTextContextForItem(conversationKey, quoted, "model");
    updateSelectedTextContextQueryForItem(
      conversationKey,
      quoted,
      "model",
      null,
      "Old question?",
    );
    const { popup, input } = openQuoteBox();
    pressEnter(input, "   ");
    assert.isFalse(popup.classList.contains("is-expanded"));
    assert.equal(chipQuestion(), "Old question?");
  });

  it("Escape during IME composition keeps the box open", function () {
    const { popup, input } = openQuoteBox();
    input.value = "draft";
    input.dispatch("keydown", {
      key: "Escape",
      isComposing: true,
      keyCode: 229,
      repeat: false,
    });
    assert.isTrue(popup.classList.contains("is-expanded"));
    assert.equal(input.value, "draft");
  });
});

describe("assistant reply Quote in side chat", function () {
  const conversationKey = 828282;
  const quoted = "Another sentence from the reply.";

  beforeEach(function () {
    setSelectedTextContextEntries(conversationKey, []);
  });
  afterEach(function () {
    setSelectedTextContextEntries(conversationKey, []);
  });

  function attach(body: Element) {
    const panel = makeFakePanel(quoted);
    attachAssistantSelectionPopup({
      body,
      panelRoot: panel.panelRoot,
      panelDoc: panel.doc,
      panelWin: panel.panelWin,
      chatBox: panel.chatBox,
      inputBox: panel.inputBox,
      status: null,
      getItem: () => ({}) as Zotero.Item,
      getTextContextConversationKey: () => conversationKey,
      runWithChatScrollGuard: (fn) => fn(),
      updateSelectedTextPreviewPreservingScroll: () => {},
      isElementNode: (value: unknown): value is Element =>
        Boolean(value) && (value as { nodeType?: number }).nodeType === 1,
    });
    return {
      panel,
      popup: findByClass(panel.panelRoot, "llm-assistant-selection-popup"),
      sideButton: findByClass(
        panel.panelRoot,
        "llm-assistant-selection-side-action",
      ),
    };
  }

  it("is hidden when the body has no side chat target", function () {
    const body = { querySelector: () => null } as unknown as Element;
    const { sideButton } = attach(body);
    sideButton.dispatch("click");
    assert.equal(sideButton.style.display, "none");
    assert.isFalse(sideButton.parentNode.classList.contains("is-split"));
    assert.lengthOf(getSelectedTextContextEntries(conversationKey), 0);
  });

  function sideChatBody() {
    const body = { querySelector: () => null } as unknown as Element;
    const sent: Array<{ text: string; question?: string }> = [];
    setChatPanelExtensions(body, {
      sideChatQuote: {
        quote: (text, question) => sent.push({ text, question }),
      },
    });
    return { body, sent };
  }
  const key = (input: any, k: string) =>
    input.dispatch("keydown", {
      key: k,
      shiftKey: false,
      isComposing: false,
      keyCode: k === "Enter" ? 13 : 27,
      repeat: false,
    });

  it("opens the question box and sends text and question on Enter", function () {
    const { body, sent } = sideChatBody();
    const { panel, popup, sideButton } = attach(body);
    assert.isTrue(sideButton.parentNode.classList.contains("is-split"));
    sideButton.dispatch("click");
    assert.isTrue(popup.classList.contains("is-expanded"));
    assert.deepEqual(sent, []);
    const input = findByClass(
      panel.panelRoot,
      "llm-assistant-selection-prompt-input",
    );
    input.value = "Why is that?";
    key(input, "Enter");
    assert.deepEqual(sent, [{ text: quoted, question: "Why is that?" }]);
    assert.isFalse(popup.classList.contains("is-expanded"));
    assert.isTrue(panel.panelWin.selectionCleared);
    // Nothing is quoted in the main chat.
    assert.lengthOf(getSelectedTextContextEntries(conversationKey), 0);
  });

  it("sends the text alone on an empty Enter", function () {
    const { body, sent } = sideChatBody();
    const { panel, sideButton } = attach(body);
    sideButton.dispatch("click");
    const input = findByClass(
      panel.panelRoot,
      "llm-assistant-selection-prompt-input",
    );
    key(input, "Enter");
    assert.deepEqual(sent, [{ text: quoted, question: undefined }]);
  });

  it("sends nothing when the box is closed with Escape", function () {
    const { body, sent } = sideChatBody();
    const { panel, popup, sideButton } = attach(body);
    sideButton.dispatch("click");
    const input = findByClass(
      panel.panelRoot,
      "llm-assistant-selection-prompt-input",
    );
    input.value = "draft";
    key(input, "Escape");
    assert.isFalse(popup.classList.contains("is-expanded"));
    assert.deepEqual(sent, []);
  });
});
