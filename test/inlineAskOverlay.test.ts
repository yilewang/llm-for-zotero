import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
  openInlineAskOverlay,
  type InlineAskOverlayInput,
} from "../src/modules/contextPanel/selectionPrompt/inlineAskOverlay";
import type { InlineAskTurnRunner } from "../src/modules/contextPanel/selectionPrompt/inlineAskSession";
import {
  closeAllReaderOverlays,
  closeReaderOverlayForNewSelection,
  countOpenReaderOverlays,
} from "../src/modules/contextPanel/selectionPrompt/readerOverlayShared";
import { openReaderSelectionPromptOverlay } from "../src/modules/contextPanel/selectionPrompt/readerSelectionPromptOverlay";
import { isFakeShown, makeFakeReaderDoc } from "./helpers/fakeReaderOverlayDom";

const labels: InlineAskOverlayInput["labels"] = {
  selectedText: "Selected text",
  placeholder: "Ask about this selection…",
  followUpPlaceholder: "Ask a follow-up…",
  hint: "Enter to send · Shift+Enter for a new line · Esc to close",
  send: "Send",
  reading: "Reading the selection…",
  discard: "Discard",
  continueInSidebar: "Continue in sidebar",
  saveAsAnnotation: "Save as annotation",
  reasoningEffort: "Reasoning effort",
  modelUnavailable: "Inline Ask needs an API model.",
};
const prompts = [
  { id: "explain", label: "Explain", prompt: "Explain this passage fully." },
  { id: "define", label: "Define terms", prompt: "Define the terms." },
  { id: "translate", label: "Translate", prompt: "Translate it." },
];
const anchor = { left: 100, top: 200, right: 300, bottom: 230 };
const selectedText = "A familiar stimulus drifts at a smaller rate.";

type Call = {
  prompt: string;
  history: Array<{ role: string; content: string }>;
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
  resolve: (value: { text: string; errorMessage?: string }) => void;
};

function heldRunner() {
  const calls: Call[] = [];
  const runTurn: InlineAskTurnRunner = (input) =>
    new Promise((resolve) => calls.push({ ...input, resolve }));
  return { calls, runTurn };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const q = (doc: any, attr: string, value = "true") =>
  doc.body.querySelector(`[${attr}="${value}"]`);
const editorOf = (doc: any) => q(doc, "data-llm-inline-ask-editor");
const sendOf = (doc: any) => q(doc, "data-llm-inline-ask-send");
const action = (doc: any, name: string) =>
  q(doc, "data-llm-inline-ask-action", name);
const key = (k: string, extra: Record<string, unknown> = {}) => ({
  key: k,
  shiftKey: false,
  isComposing: false,
  keyCode: k === "Enter" ? 13 : 0,
  ...extra,
});

function open(overrides: Partial<InlineAskOverlayInput> = {}) {
  const doc = makeFakeReaderDoc();
  const runner = heldRunner();
  let closed = 0;
  const aborted: boolean[] = [];
  const handle = openInlineAskOverlay({
    doc,
    anchor,
    selectedText,
    prompts,
    model: { label: "Model X", effort: "high", title: "Provider · model-x" },
    labels,
    runTurn: runner.runTurn,
    createAbortController: () => {
      const index = aborted.push(false) - 1;
      return {
        signal: { index } as unknown as AbortSignal,
        abort: () => {
          aborted[index] = true;
        },
      };
    },
    onClose: () => {
      closed += 1;
    },
    ...overrides,
  });
  return {
    doc,
    handle,
    calls: runner.calls,
    aborted,
    closedCount: () => closed,
  };
}

function type(doc: any, text: string) {
  const editor = editorOf(doc);
  editor.textContent = text;
  editor.dispatch("input");
}

describe("openInlineAskOverlay", function () {
  afterEach(() => closeAllReaderOverlays());

  it("opens in compose: quote, field with model pair and send, pills, hint", function () {
    const { doc, handle } = open();
    const root = handle.root as any;
    assert.strictEqual(root.parentNode, doc.body);
    assert.equal(root.style.position, "fixed");
    assert.equal(root.style.width, "360px");
    assert.equal(root.style.borderRadius, "10px");
    assert.equal(root.style.fontSize, "12px");
    assert.equal(root.style.left, "100px");
    assert.equal(root.style.top, "236px");
    assert.equal(root.attributes["data-phase"], "compose");
    assert.equal(
      q(doc, "data-llm-inline-ask-quote-label").textContent,
      "Selected text",
    );
    const quote = q(doc, "data-llm-inline-ask-quote");
    assert.equal(quote.textContent, selectedText);
    assert.equal(quote.style.WebkitLineClamp, "3");
    const editor = editorOf(doc);
    // Zotero's reader KeyboardManager skips only contenteditable="true" and
    // <input type=text>; anything else loses keys to reader shortcuts.
    assert.equal(editor.attributes.contenteditable, "true");
    assert.isTrue(editor.focused);
    assert.equal(
      q(doc, "data-llm-inline-ask-placeholder").textContent,
      "Ask about this selection…",
    );
    const field = q(doc, "data-llm-inline-ask-field");
    assert.equal(field.style.borderRadius, "6px");
    assert.equal(q(doc, "data-llm-inline-ask-model").textContent, "Model X");
    assert.equal(
      q(doc, "data-llm-inline-ask-model").attributes.title,
      "Provider · model-x",
    );
    assert.equal(q(doc, "data-llm-inline-ask-effort").textContent, "high");
    assert.isTrue(field.contains(sendOf(doc)));
    assert.isTrue(sendOf(doc).disabled);
    assert.equal(sendOf(doc).attributes["aria-label"], "Send");
    const pills = doc.body.querySelectorAll("[data-llm-inline-ask-pill]");
    assert.deepEqual(
      pills.map((pill: any) => pill.textContent),
      ["Explain", "Define terms", "Translate"],
    );
    assert.equal(pills[0].attributes.title, "Explain this passage fully.");
    assert.equal(q(doc, "data-llm-inline-ask-hint").textContent, labels.hint);
    assert.isFalse(isFakeShown(q(doc, "data-llm-inline-ask-thread")));
    assert.isFalse(isFakeShown(q(doc, "data-llm-inline-ask-footer")));
    assert.isFalse(handle.hasConversation());
  });

  it("enables send once there is text and sends the typed question on Enter", function () {
    const { doc, calls } = open();
    type(doc, "  What does drift mean?  ");
    assert.isFalse(sendOf(doc).disabled);
    const ev = editorOf(doc).dispatch("keydown", key("Enter"));
    assert.isTrue(ev.defaultPrevented);
    assert.isTrue(ev.propagationStopped);
    assert.lengthOf(calls, 1);
    assert.equal(calls[0].prompt, "What does drift mean?");
    const question = q(doc, "data-llm-inline-ask-question");
    assert.equal(question.textContent, "What does drift mean?");
    assert.isTrue(isFakeShown(q(doc, "data-llm-inline-ask-reading")));
    assert.isFalse(isFakeShown(q(doc, "data-llm-inline-ask-field")));
    assert.isFalse(isFakeShown(q(doc, "data-llm-inline-ask-pills")));
    assert.isFalse(isFakeShown(q(doc, "data-llm-inline-ask-hint")));
    assert.isTrue(isFakeShown(q(doc, "data-llm-inline-ask-footer")));
    assert.isFalse(action(doc, "discard").disabled);
    assert.isTrue(action(doc, "sidebar").disabled);
    assert.isTrue(action(doc, "save").disabled);
    assert.equal(action(doc, "save").textContent, "Save as annotation");
    assert.equal(
      action(doc, "sidebar").attributes.title,
      "Continue in sidebar",
    );
  });

  it("the send button sends too", function () {
    const { doc, calls } = open();
    type(doc, "Why?");
    sendOf(doc).click();
    assert.lengthOf(calls, 1);
    assert.equal(calls[0].prompt, "Why?");
  });

  it("streams the answer, then offers a follow-up that carries the history", async function () {
    const { doc, handle, calls } = open();
    type(doc, "Q1");
    editorOf(doc).dispatch("keydown", key("Enter"));
    calls[0].onDelta("Drift is **slow** [[cite:X]]");
    const answer = q(doc, "data-llm-inline-ask-answer", "streaming");
    assert.equal(answer.textContent, "Drift is slow");
    assert.isOk(answer.querySelector("strong"));
    assert.isFalse(isFakeShown(q(doc, "data-llm-inline-ask-reading")));
    calls[0].resolve({ text: "Drift is **slow** [[cite:X]]" });
    await flush();
    assert.equal((handle.root as any).attributes["data-phase"], "answered");
    assert.isOk(q(doc, "data-llm-inline-ask-answer", "done"));
    assert.isTrue(isFakeShown(q(doc, "data-llm-inline-ask-field")));
    assert.isFalse(isFakeShown(q(doc, "data-llm-inline-ask-pills")));
    assert.equal(
      q(doc, "data-llm-inline-ask-placeholder").textContent,
      "Ask a follow-up…",
    );
    assert.equal(editorOf(doc).textContent, "");
    assert.isTrue(editorOf(doc).focused);
    type(doc, "Q2");
    editorOf(doc).dispatch("keydown", key("Enter"));
    assert.lengthOf(calls, 2);
    assert.deepEqual(calls[1].history, [
      { role: "user", content: "Q1" },
      { role: "assistant", content: "Drift is **slow** [[cite:X]]" },
    ]);
    const questions = doc.body.querySelectorAll(
      '[data-llm-inline-ask-question="true"]',
    );
    assert.deepEqual(
      questions.map((node: any) => node.textContent),
      ["Q1", "Q2"],
    );
  });

  it("a pill sends its prompt and the thread shows its label", function () {
    const { doc, calls } = open();
    q(doc, "data-llm-inline-ask-pill", "define").click();
    assert.lengthOf(calls, 1);
    assert.equal(calls[0].prompt, "Define the terms.");
    assert.equal(
      q(doc, "data-llm-inline-ask-question").textContent,
      "Define terms",
    );
  });

  it("Enter on a focused button is left to the button", function () {
    const { doc, calls } = open();
    const pill = q(doc, "data-llm-inline-ask-pill", "explain");
    const ev = pill.dispatch("keydown", key("Enter"));
    assert.isFalse(ev.defaultPrevented);
    assert.isTrue(ev.propagationStopped);
    assert.lengthOf(calls, 0);
  });

  it("Shift+Enter, IME Enter, empty Enter and typing keys do not send", function () {
    const { doc, calls, closedCount } = open();
    type(doc, "draft");
    const editor = editorOf(doc);
    const shift = editor.dispatch("keydown", key("Enter", { shiftKey: true }));
    const ime = editor.dispatch(
      "keydown",
      key("Enter", { isComposing: true, keyCode: 229 }),
    );
    assert.isFalse(shift.defaultPrevented);
    assert.isTrue(shift.propagationStopped);
    assert.isFalse(ime.defaultPrevented);
    for (const kind of ["keydown", "keyup", "keypress"]) {
      const ev = editor.dispatch(kind, key("h", { keyCode: 72 }));
      assert.isTrue(ev.propagationStopped, kind);
      assert.isFalse(ev.defaultPrevented, kind);
    }
    type(doc, "   ");
    editor.dispatch("keydown", key("Enter"));
    assert.lengthOf(calls, 0);
    assert.equal(closedCount(), 0);
  });

  it("Escape closes and aborts the running answer", function () {
    const { doc, handle, calls, aborted, closedCount } = open();
    type(doc, "Q1");
    editorOf(doc).dispatch("keydown", key("Enter"));
    calls[0].onDelta("partial");
    const ev = q(doc, "data-llm-inline-ask-action", "discard").dispatch(
      "keydown",
      key("Escape"),
    );
    assert.isTrue(ev.defaultPrevented);
    assert.isFalse((handle.root as any).isConnected);
    assert.deepEqual(aborted, [true]);
    assert.equal(closedCount(), 1);
    handle.close();
    assert.equal(closedCount(), 1);
  });

  it("Discard closes, and a late delta after it changes nothing", async function () {
    const { doc, handle, calls, aborted } = open();
    type(doc, "Q1");
    editorOf(doc).dispatch("keydown", key("Enter"));
    calls[0].onDelta("first");
    const answer = q(doc, "data-llm-inline-ask-answer", "streaming");
    action(doc, "discard").click();
    assert.isFalse((handle.root as any).isConnected);
    assert.deepEqual(aborted, [true]);
    calls[0].onDelta(" late");
    calls[0].resolve({ text: "first late" });
    await flush();
    assert.equal(answer.textContent, "first");
    assert.equal(countOpenReaderOverlays(), 0);
  });

  it("outside pointerdown closes before the first question only", function () {
    const first = open();
    first.doc.dispatch("pointerdown", { target: editorOf(first.doc) });
    assert.equal(first.closedCount(), 0);
    first.doc.dispatch("pointerdown", { target: first.doc.body });
    assert.equal(first.closedCount(), 1);
    assert.equal(first.doc.listenerCount("pointerdown"), 0);

    const second = open();
    type(second.doc, "Q1");
    editorOf(second.doc).dispatch("keydown", key("Enter"));
    second.doc.dispatch("pointerdown", { target: second.doc.body });
    assert.equal(second.closedCount(), 0);
    assert.isTrue((second.handle.root as any).isConnected);
  });

  it("listens for outside pointerdown in nested view documents", function () {
    const doc = makeFakeReaderDoc();
    const viewDoc = makeFakeReaderDoc();
    doc.iframes.push({ contentDocument: viewDoc });
    const runner = heldRunner();
    let closed = 0;
    openInlineAskOverlay({
      doc,
      anchor,
      selectedText,
      prompts,
      model: { label: "M" },
      labels,
      runTurn: runner.runTurn,
      onClose: () => {
        closed += 1;
      },
    });
    viewDoc.dispatch("pointerdown", { target: viewDoc.body });
    assert.equal(closed, 1);
    assert.equal(viewDoc.listenerCount("pointerdown"), 0);
  });

  it("a new selection closes a card without a conversation and keeps one with it", function () {
    const fresh = open();
    closeReaderOverlayForNewSelection(fresh.doc);
    assert.isFalse((fresh.handle.root as any).isConnected);

    const busy = open();
    q(busy.doc, "data-llm-inline-ask-pill", "explain").click();
    closeReaderOverlayForNewSelection(busy.doc);
    assert.isTrue((busy.handle.root as any).isConnected);
    assert.isTrue(busy.handle.hasConversation());
  });

  it("shares the one-overlay slot with the Add Text prompt", function () {
    const { doc, handle, closedCount } = open();
    q(doc, "data-llm-inline-ask-pill", "explain").click();
    const prompt = openReaderSelectionPromptOverlay({
      doc,
      anchor,
      selectedText,
      labels: {
        placeholder: "Ask…",
        hint: "Enter to add",
        submit: "Add",
        selectedTextLabel: "Selected text",
      },
      onSubmit: () => true,
      onClose: () => {},
    });
    assert.isFalse((handle.root as any).isConnected);
    assert.equal(closedCount(), 1);
    assert.equal(doc.body.children.length, 1);
    const card = openInlineAskOverlay({
      doc,
      anchor,
      selectedText,
      prompts,
      model: { label: "M" },
      labels,
      runTurn: heldRunner().runTurn,
    });
    assert.isFalse((prompt.root as any).isConnected);
    assert.isTrue((card.root as any).isConnected);
    assert.equal(countOpenReaderOverlays(), 1);
  });

  it("without a usable model it says so and cannot send", function () {
    const { doc, calls } = open({ model: null });
    const notice = q(doc, "data-llm-inline-ask-notice");
    assert.equal(notice.textContent, "Inline Ask needs an API model.");
    assert.isTrue(isFakeShown(notice));
    assert.isNull(q(doc, "data-llm-inline-ask-model"));
    type(doc, "Q");
    assert.isTrue(sendOf(doc).disabled);
    editorOf(doc).dispatch("keydown", key("Enter"));
    q(doc, "data-llm-inline-ask-pill", "explain").click();
    assert.lengthOf(calls, 0);
    assert.isTrue(q(doc, "data-llm-inline-ask-pill", "explain").disabled);
  });

  it("shows a failed answer and lets the user ask again", async function () {
    const { doc, calls } = open();
    type(doc, "Q1");
    editorOf(doc).dispatch("keydown", key("Enter"));
    calls[0].resolve({
      text: "",
      errorMessage: "The model refused this request.",
    });
    await flush();
    const failed = q(doc, "data-llm-inline-ask-answer", "error");
    assert.equal(failed.textContent, "The model refused this request.");
    assert.isTrue(isFakeShown(q(doc, "data-llm-inline-ask-field")));
  });

  it("close removes the listeners it added", function () {
    const { doc, handle } = open();
    handle.close();
    assert.equal(doc.listenerCount("pointerdown"), 0);
    for (const kind of ["keydown", "keyup", "keypress"]) {
      assert.equal((handle.root as any).listenerCount(kind), 0, kind);
    }
    assert.equal(editorOf({ body: handle.root }).listenerCount("input"), 0);
  });

  it("uses the dark palette in a dark reader", function () {
    const doc = makeFakeReaderDoc(undefined, { dark: true });
    const handle = openInlineAskOverlay({
      doc,
      anchor,
      selectedText,
      prompts,
      model: { label: "M" },
      labels,
      runTurn: heldRunner().runTurn,
    });
    assert.equal((handle.root as any).style.background, "#2b2b2b");
    assert.equal(q(doc, "data-llm-inline-ask-quote").style.color, "#b3b3b3");
  });
});
