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

describe("Inline Ask save view", function () {
  afterEach(() => closeAllReaderOverlays());

  const colors = [
    { hex: "#ffd400", label: "Yellow" },
    { hex: "#ff6666", label: "Red" },
    { hex: "#5fb236", label: "Green" },
    { hex: "#2ea8e5", label: "Blue" },
    { hex: "#a28ae5", label: "Purple" },
    { hex: "#e56eee", label: "Magenta" },
    { hex: "#f19837", label: "Orange" },
    { hex: "#aaaaaa", label: "Gray" },
  ];
  const saveLabels = {
    color: "Color",
    back: "Back",
    cancel: "Cancel",
    save: "Save",
    addComment: "Add comment",
  };
  const mod = { metaKey: true };

  function heldSave() {
    const calls: Array<{
      payload: { color: string; comment: string };
      resolve: (value: { ok: true } | { ok: false; error: string }) => void;
    }> = [];
    const save = (payload: { color: string; comment: string }) =>
      new Promise<{ ok: true } | { ok: false; error: string }>((resolve) =>
        calls.push({ payload, resolve }),
      );
    return { calls, save };
  }

  async function answered(
    options: { blocked?: () => string | null } = {},
    answer = "Drift is **slow**.\n\n- first\n- second",
  ) {
    const held = heldSave();
    const opened = open({
      save: {
        colors,
        pageText: "Page 17",
        labels: saveLabels,
        blockedReason: options.blocked ?? (() => null),
        save: held.save,
      },
    });
    type(opened.doc, "Q1");
    editorOf(opened.doc).dispatch("keydown", key("Enter"));
    opened.calls[0].onDelta("partial");
    assert.isTrue(
      action(opened.doc, "save").disabled,
      "Save stays disabled while the answer streams",
    );
    opened.calls[0].resolve({ text: answer });
    await flush();
    return { ...opened, saves: held.calls };
  }

  const view = (doc: any) =>
    (q(doc, "data-llm-inline-ask", "true") || doc.body.children[0]).attributes[
      "data-view"
    ];
  const saveView = (doc: any) => q(doc, "data-llm-inline-ask-save-view");
  const commentOf = (doc: any) => q(doc, "data-llm-inline-ask-comment");

  it("keeps Save disabled without a save setup", async function () {
    const { doc, calls } = open();
    type(doc, "Q1");
    editorOf(doc).dispatch("keydown", key("Enter"));
    calls[0].resolve({ text: "Answer" });
    await flush();
    assert.isTrue(action(doc, "save").disabled);
  });

  it("disables Save with the reason as its tooltip", async function () {
    const { doc } = await answered({
      blocked: () => "This selection spans two pages.",
    });
    assert.isTrue(action(doc, "save").disabled);
    assert.equal(
      action(doc, "save").attributes.title,
      "This selection spans two pages.",
    );
  });

  it("opens the annotation card: color, page, highlighted text and the answer as comment", async function () {
    const { doc, handle } = await answered();
    assert.isFalse(action(doc, "save").disabled);
    action(doc, "save").click();
    const root = handle.root as any;
    assert.equal(root.attributes["data-view"], "save");
    assert.isTrue(isFakeShown(saveView(doc)));
    for (const part of [
      "data-llm-inline-ask-thread",
      "data-llm-inline-ask-field",
      "data-llm-inline-ask-footer",
    ])
      assert.isFalse(isFakeShown(q(doc, part)), part);
    assert.isFalse(isFakeShown(q(doc, "data-llm-inline-ask-quote")));
    const square = q(doc, "data-llm-inline-ask-color", "toggle");
    assert.equal(square.style.background, "#ffd400");
    assert.equal(square.attributes.title, "Color");
    assert.equal(q(doc, "data-llm-inline-ask-page").textContent, "Page 17");
    assert.equal(
      q(doc, "data-llm-inline-ask-save-action", "back").attributes.title,
      "Back",
    );
    const mark = q(doc, "data-llm-inline-ask-mark");
    assert.equal(mark.textContent, selectedText);
    assert.equal(mark.style.background, "#ffd40066");
    const clamp = mark.parentNode;
    assert.equal(clamp.style.WebkitLineClamp, "3");
    assert.match(clamp.style.fontFamily, /serif/);
    const comment = commentOf(doc);
    assert.equal(comment.attributes.contenteditable, "true");
    assert.equal(
      comment.textContent,
      "Drift is slow.\n\n• first\n• second",
      "the comment holds the answer as plain text",
    );
    assert.isTrue(comment.focused);
    assert.equal(
      q(doc, "data-llm-inline-ask-save-action", "cancel").textContent,
      "Cancel",
    );
    assert.equal(
      q(doc, "data-llm-inline-ask-save-action", "save").textContent,
      "Save",
    );
    assert.isFalse(isFakeShown(q(doc, "data-llm-inline-ask-colors")));
  });

  it("the color square shows Zotero's eight colors and a pick recolors the card", async function () {
    const { doc } = await answered();
    action(doc, "save").click();
    q(doc, "data-llm-inline-ask-color", "toggle").click();
    const row = q(doc, "data-llm-inline-ask-colors");
    assert.isTrue(isFakeShown(row));
    const dots = doc.body.querySelectorAll("[data-llm-inline-ask-color-dot]");
    assert.deepEqual(
      dots.map((dot: any) => dot.attributes.title),
      colors.map((color) => color.label),
    );
    q(doc, "data-llm-inline-ask-color-dot", "#ff6666").click();
    assert.equal(
      q(doc, "data-llm-inline-ask-color", "toggle").style.background,
      "#ff6666",
    );
    assert.equal(
      q(doc, "data-llm-inline-ask-mark").style.background,
      "#ff666666",
    );
    assert.equal(
      q(doc, "data-llm-inline-ask-color-dot", "#ff6666").attributes[
        "aria-pressed"
      ],
      "true",
    );
    assert.equal(
      q(doc, "data-llm-inline-ask-color-dot", "#ffd400").attributes[
        "aria-pressed"
      ],
      "false",
    );
    q(doc, "data-llm-inline-ask-color", "toggle").click();
    assert.isFalse(isFakeShown(row));
  });

  it("Escape, Back and Cancel go back to the answer and keep the card", async function () {
    for (const how of ["escape", "back", "cancel"]) {
      const { doc, handle, closedCount } = await answered();
      action(doc, "save").click();
      if (how === "escape") {
        const ev = commentOf(doc).dispatch("keydown", key("Escape"));
        assert.isTrue(ev.defaultPrevented, how);
      } else {
        q(doc, "data-llm-inline-ask-save-action", how).click();
      }
      assert.equal((handle.root as any).attributes["data-view"], "thread", how);
      assert.isTrue((handle.root as any).isConnected, how);
      assert.equal(closedCount(), 0, how);
      assert.isTrue(isFakeShown(q(doc, "data-llm-inline-ask-footer")), how);
      assert.isFalse(isFakeShown(saveView(doc)), how);
      closeAllReaderOverlays();
    }
  });

  it("Enter in the comment is a new line; Mod+Enter saves the shown payload and closes on success", async function () {
    const { doc, handle, saves, closedCount } = await answered();
    action(doc, "save").click();
    q(doc, "data-llm-inline-ask-color", "toggle").click();
    q(doc, "data-llm-inline-ask-color-dot", "#5fb236").click();
    const comment = commentOf(doc);
    comment.textContent = "My own note";
    comment.dispatch("input");
    const enter = comment.dispatch("keydown", key("Enter"));
    assert.isFalse(enter.defaultPrevented, "plain Enter edits the comment");
    assert.lengthOf(saves, 0);
    const ev = comment.dispatch("keydown", key("Enter", mod));
    assert.isTrue(ev.defaultPrevented);
    assert.lengthOf(saves, 1);
    assert.deepEqual(saves[0].payload, {
      color: "#5fb236",
      comment: "My own note",
    });
    assert.isTrue(
      q(doc, "data-llm-inline-ask-save-action", "save").disabled,
      "Save waits for the running save",
    );
    comment.dispatch("keydown", key("Escape"));
    assert.equal(
      (handle.root as any).attributes["data-view"],
      "save",
      "Escape does not leave a running save",
    );
    saves[0].resolve({ ok: true });
    await flush();
    assert.isFalse((handle.root as any).isConnected);
    assert.equal(closedCount(), 1);
  });

  it("a failed save keeps the payload, shows the error, and Save retries the same payload", async function () {
    const { doc, handle, saves } = await answered();
    action(doc, "save").click();
    q(doc, "data-llm-inline-ask-color", "toggle").click();
    q(doc, "data-llm-inline-ask-color-dot", "#2ea8e5").click();
    commentOf(doc).textContent = "Keep me";
    commentOf(doc).dispatch("input");
    q(doc, "data-llm-inline-ask-save-action", "save").click();
    saves[0].resolve({ ok: false, error: "Zotero refused the write." });
    await flush();
    const root = handle.root as any;
    assert.isTrue(root.isConnected);
    assert.equal(root.attributes["data-view"], "save");
    const error = q(doc, "data-llm-inline-ask-save-error");
    assert.isTrue(isFakeShown(error));
    assert.equal(error.textContent, "Zotero refused the write.");
    assert.equal(commentOf(doc).textContent, "Keep me");
    assert.equal(
      q(doc, "data-llm-inline-ask-color", "toggle").style.background,
      "#2ea8e5",
    );
    assert.isFalse(q(doc, "data-llm-inline-ask-save-action", "save").disabled);
    q(doc, "data-llm-inline-ask-save-action", "save").click();
    assert.lengthOf(saves, 2);
    assert.deepEqual(saves[1].payload, saves[0].payload);
    assert.isFalse(
      isFakeShown(q(doc, "data-llm-inline-ask-save-error")),
      "the old error clears while the retry runs",
    );
    // Back and in again restores the frozen payload, not a fresh draft.
    saves[1].resolve({ ok: false, error: "Still refused." });
    await flush();
    q(doc, "data-llm-inline-ask-save-action", "back").click();
    action(doc, "save").click();
    assert.equal(commentOf(doc).textContent, "Keep me");
    assert.equal(
      q(doc, "data-llm-inline-ask-color", "toggle").style.background,
      "#2ea8e5",
    );
  });

  it("a save that throws shows its message", async function () {
    const opened = open({
      save: {
        colors,
        pageText: "",
        labels: saveLabels,
        blockedReason: () => null,
        save: async () => {
          throw new Error("Agent subsystem is not initialized");
        },
      },
    });
    type(opened.doc, "Q1");
    editorOf(opened.doc).dispatch("keydown", key("Enter"));
    opened.calls[0].resolve({ text: "Answer" });
    await flush();
    action(opened.doc, "save").click();
    assert.isFalse(isFakeShown(q(opened.doc, "data-llm-inline-ask-page")));
    q(opened.doc, "data-llm-inline-ask-save-action", "save").click();
    await flush();
    assert.equal(
      q(opened.doc, "data-llm-inline-ask-save-error").textContent,
      "Agent subsystem is not initialized",
    );
  });

  it("Mod+Enter on the answer opens the save view, unless Save is unavailable", async function () {
    const ready = await answered();
    const ev = editorOf(ready.doc).dispatch("keydown", key("Enter", mod));
    assert.isTrue(ev.defaultPrevented);
    assert.lengthOf(ready.calls, 1, "Mod+Enter does not send a follow-up");
    assert.equal(view(ready.doc), "save");
    closeAllReaderOverlays();

    const blocked = await answered({ blocked: () => "No conversation." });
    editorOf(blocked.doc).dispatch("keydown", key("Enter", { ctrlKey: true }));
    assert.equal(view(blocked.doc), "thread");
    assert.lengthOf(blocked.calls, 1);
  });

  it("close removes the save view's listeners too", async function () {
    const { doc, handle } = await answered();
    action(doc, "save").click();
    const comment = commentOf(doc);
    const confirm = q(doc, "data-llm-inline-ask-save-action", "save");
    const dot = q(doc, "data-llm-inline-ask-color-dot", "#ff6666");
    handle.close();
    assert.equal(comment.listenerCount("input"), 0);
    assert.equal(comment.listenerCount("paste"), 0);
    assert.equal(confirm.listenerCount("click"), 0);
    assert.equal(dot.listenerCount("click"), 0);
    assert.equal(
      action({ body: handle.root }, "save").listenerCount("click"),
      0,
    );
  });

  it("a blocked reason that appears before the click stops the save", async function () {
    let reason: string | null = null;
    const { doc, saves } = await answered({ blocked: () => reason });
    action(doc, "save").click();
    reason = "The PDF is in the trash.";
    q(doc, "data-llm-inline-ask-save-action", "save").click();
    assert.lengthOf(saves, 0);
    assert.equal(
      q(doc, "data-llm-inline-ask-save-error").textContent,
      "The PDF is in the trash.",
    );
  });
});

describe("Inline Ask continue in sidebar", function () {
  afterEach(() => closeAllReaderOverlays());

  type ContinueResult = { ok: true } | { ok: false; error: string };

  function heldContinue() {
    const calls: Array<{
      turns: Array<{ role: string; text: string }>;
      resolve: (value: ContinueResult) => void;
      reject: (error: unknown) => void;
    }> = [];
    const continueInSidebar = (turns: Array<{ role: string; text: string }>) =>
      new Promise<ContinueResult>((resolve, reject) =>
        calls.push({ turns, resolve, reject }),
      );
    return { calls, continueInSidebar };
  }

  const sidebarError = (doc: any) =>
    q(doc, "data-llm-inline-ask-sidebar-error");

  async function answeredPill() {
    const held = heldContinue();
    const opened = open({ continueInSidebar: held.continueInSidebar });
    assert.isTrue(
      action(opened.doc, "sidebar").disabled,
      "nothing to continue before a question",
    );
    q(opened.doc, "data-llm-inline-ask-pill", "explain").click();
    opened.calls[0].onDelta("Drift");
    assert.isTrue(
      action(opened.doc, "sidebar").disabled,
      "disabled while the answer streams",
    );
    opened.calls[0].resolve({ text: "Drift is slow." });
    await flush();
    return { ...opened, continues: held.calls };
  }

  it("enables the button once an answer exists and sends the turns as the model got them", async function () {
    const { doc, handle, calls, continues, closedCount } = await answeredPill();
    const button = action(doc, "sidebar");
    assert.isFalse(button.disabled);
    assert.equal(button.attributes.title, "Continue in sidebar");
    button.click();
    assert.lengthOf(continues, 1);
    // The pill's full prompt, not its label.
    assert.deepEqual(continues[0].turns, [
      { role: "user", text: "Explain this passage fully." },
      { role: "assistant", text: "Drift is slow." },
    ]);
    assert.isTrue(button.disabled, "one move at a time");
    button.click();
    assert.lengthOf(continues, 1);
    // A follow-up waits until the move ends: the moved turns stay complete.
    type(doc, "Late follow-up");
    assert.isTrue(sendOf(doc).disabled);
    editorOf(doc).dispatch("keydown", key("Enter"));
    assert.lengthOf(calls, 1);
    continues[0].resolve({ ok: true });
    await flush();
    assert.isFalse((handle.root as any).isConnected);
    assert.equal(closedCount(), 1);
  });

  it("a refused move shows the reason in the card and keeps the conversation", async function () {
    const { doc, handle, continues, closedCount } = await answeredPill();
    assert.isFalse(isFakeShown(sidebarError(doc)));
    action(doc, "sidebar").click();
    continues[0].resolve({
      ok: false,
      error: "The sidebar is answering. Try again when it finishes.",
    });
    await flush();
    type(doc, "Next");
    assert.isFalse(sendOf(doc).disabled, "a refused move frees the field");
    assert.isTrue((handle.root as any).isConnected);
    assert.equal(closedCount(), 0);
    assert.isTrue(isFakeShown(sidebarError(doc)));
    assert.equal(
      sidebarError(doc).textContent,
      "The sidebar is answering. Try again when it finishes.",
    );
    assert.deepEqual(
      doc.body
        .querySelectorAll('[data-llm-inline-ask-question="true"]')
        .map((node: any) => node.textContent),
      ["Explain"],
    );
    assert.isOk(q(doc, "data-llm-inline-ask-answer", "done"));
    assert.equal((handle.root as any).attributes["data-phase"], "answered");
    // The user can try again.
    assert.isFalse(action(doc, "sidebar").disabled);
    action(doc, "sidebar").click();
    assert.lengthOf(continues, 2);
    assert.isFalse(isFakeShown(sidebarError(doc)), "a retry clears the reason");
    continues[1].reject(new Error("Panel gone"));
    await flush();
    assert.equal(sidebarError(doc).textContent, "Panel gone");
    assert.isTrue((handle.root as any).isConnected);
  });

  it("a follow-up hides an earlier reason and keeps the button off while it runs", async function () {
    const { doc, calls, continues } = await answeredPill();
    action(doc, "sidebar").click();
    continues[0].resolve({ ok: false, error: "Not now." });
    await flush();
    type(doc, "Why?");
    editorOf(doc).dispatch("keydown", key("Enter"));
    assert.isFalse(isFakeShown(sidebarError(doc)));
    assert.isTrue(action(doc, "sidebar").disabled);
    calls[1].resolve({ text: "Familiarity." });
    await flush();
    action(doc, "sidebar").click();
    assert.deepEqual(continues[1].turns, [
      { role: "user", text: "Explain this passage fully." },
      { role: "assistant", text: "Drift is slow." },
      { role: "user", text: "Why?" },
      { role: "assistant", text: "Familiarity." },
    ]);
  });

  it("stays disabled without a handler or with only a failed answer", async function () {
    const plain = open();
    type(plain.doc, "Q1");
    editorOf(plain.doc).dispatch("keydown", key("Enter"));
    plain.calls[0].resolve({ text: "Answer" });
    await flush();
    assert.isTrue(action(plain.doc, "sidebar").disabled);
    closeAllReaderOverlays();

    const held = heldContinue();
    const failed = open({ continueInSidebar: held.continueInSidebar });
    type(failed.doc, "Q1");
    editorOf(failed.doc).dispatch("keydown", key("Enter"));
    failed.calls[0].resolve({ text: "", errorMessage: "Refused." });
    await flush();
    assert.isTrue(action(failed.doc, "sidebar").disabled);
    action(failed.doc, "sidebar").click();
    assert.lengthOf(held.calls, 0);
  });

  it("close removes the button's listener", async function () {
    const { doc, handle } = await answeredPill();
    const button = action(doc, "sidebar");
    handle.close();
    assert.equal(button.listenerCount("click"), 0);
  });
});
