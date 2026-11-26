import { assert } from "chai";
import { replaceNoteSelectionHtml } from "../src/utils/noteEdit";
import {
  getModelEntryById,
  setModelProviderGroups,
} from "../src/utils/modelProviders";
import {
  installHeldChatProvider,
  type HeldChatProvider,
} from "./helpers/heldChatProvider";

/**
 * The note editor's inline writing popup, in Zotero's real note editor:
 * selecting text opens it under the selection without taking the keyboard;
 * its composer takes an instruction without losing the selection; Rewrite
 * streams a replacement that Replace writes into the note (keeping typing
 * elsewhere), Insert below adds it after the paragraph, and Ask in sidebar
 * hands the selection and the composer's text to the paper's chat.
 * Right-clicking a shortcut edits, deletes, adds or resets the shortcuts,
 * kept in the popup's own prefs.
 *
 * Only the network is scripted (a held fake provider).
 */

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero.";
const API_BASE = "https://workflow-note-inline.invalid/v1";
const ENTRY_ID = "workflow-note-inline-model";
const SAVED_PREF_KEYS = [
  "modelProviderGroups",
  "modelProviderGroupsMigrationVersion",
  "lastUsedModelEntryId",
  "conversationSystem",
  "enableCodexAppServerMode",
  "enableClaudeCodeMode",
  "inlineAskModelEntryId",
  "inlineAskPrompts",
  "noteInlinePrompts",
  "noteInlineDeletedPrompts",
];
/** The shortcut prefs each case starts without. */
const PROMPT_PREF_KEYS = [
  "inlineAskPrompts",
  "noteInlinePrompts",
  "noteInlineDeletedPrompts",
];

const SOURCE = "The decoder was fitted on session one.";
const NOTE_HTML =
  "<h2>Methods</h2>" +
  `<p>${SOURCE}</p>` +
  // As Zotero's editor stores items: each one's text in a paragraph.
  "<ul><li><p>First item text.</p></li><li><p>Second item text.</p></li><li><p>Third item stays.</p></li></ul>" +
  "<p>Keep this paragraph.</p>";

describe("workflow: inline writing popup in the note editor", function () {
  this.timeout(120_000);

  const api = () => (Zotero as any).LLMForZotero.api.workflowTest;
  const delay = (ms: number) => Zotero.Promise.delay(ms);
  let provider: HeldChatProvider;
  const previousPrefs = new Map<string, unknown>();
  let fixture: any = null;

  async function until<T>(read: () => T, label: string): Promise<T> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const value = read();
      if (value) return value;
      await delay(25);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  /** The note's editor in the library pane. */
  async function openEditor(noteId: number) {
    const win = Zotero.getMainWindow();
    win.Zotero_Tabs?.select?.("zotero-pane");
    await win.ZoteroPane.selectItem(noteId);
    return editorControls(
      () =>
        Array.from(win.document.querySelectorAll("note-editor")).find(
          (el: any) => el.item?.id === noteId && el.getClientRects().length,
        ) as any,
    );
  }

  /** The note's editor in a tab of its own. */
  async function openEditorTab(noteId: number) {
    const win = Zotero.getMainWindow();
    await (Zotero as any).Notes.open(noteId, undefined, {
      openInWindow: false,
    });
    return editorControls(
      () =>
        Array.from(win.document.querySelectorAll("note-editor.note-tab")).find(
          (el: any) => el.item?.id === noteId,
        ) as any,
    );
  }

  /** Ways to select and type in the editor `find` returns, once it shows the note. */
  async function editorControls(find: () => any) {
    const editor = await until(find, "the note editor");
    const iframe = editor.querySelector("iframe") as HTMLIFrameElement;
    await until(
      () =>
        iframe.contentDocument
          ?.querySelector(".ProseMirror")
          ?.textContent?.includes("Keep this paragraph."),
      "the note editor content",
    );
    await delay(1500);
    const doc = iframe.contentDocument!;
    const body = () => doc.querySelector(".ProseMirror") as HTMLElement;
    const textNode = (needle: string) => {
      const walker = doc.createTreeWalker(body(), 4);
      let node: Node | null;
      while ((node = walker.nextNode()))
        if (node.textContent?.includes(needle)) return node;
      throw new Error(`No editor text contains ${needle}`);
    };
    const setRange = (node: Node, start: number, end: number) => {
      body().focus();
      const range = doc.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const selection = doc.defaultView!.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    };
    return {
      doc,
      text: () => body().textContent || "",
      card: () =>
        Zotero.getMainWindow().document.querySelector(
          "[data-llm-note-inline-popup]",
        ) as HTMLElement | null,
      /** Selects `needle` as a mouse drag would, ending with a release. */
      select(needle: string) {
        const node = textNode(needle);
        const start = node.textContent!.indexOf(needle);
        setRange(node, start, start + needle.length);
        doc.dispatchEvent(new doc.defaultView!.MouseEvent("mouseup"));
      },
      /** Selects `needle` inside the text that holds `anchor`. */
      selectIn(anchor: string, needle: string) {
        const node = textNode(anchor);
        const start = node.textContent!.indexOf(needle);
        setRange(node, start, start + needle.length);
        doc.dispatchEvent(new doc.defaultView!.MouseEvent("mouseup"));
      },
      /** Selects from the start of `first` to the end of `last`. */
      selectAcross(first: string, last: string) {
        const startNode = textNode(first);
        const endNode = textNode(last);
        body().focus();
        const range = doc.createRange();
        range.setStart(startNode, startNode.textContent!.indexOf(first));
        range.setEnd(endNode, endNode.textContent!.indexOf(last) + last.length);
        const selection = doc.defaultView!.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        doc.dispatchEvent(new doc.defaultView!.MouseEvent("mouseup"));
      },
      collapse() {
        const node = textNode("Keep this paragraph.");
        setRange(node, 0, 0);
        doc.dispatchEvent(new doc.defaultView!.MouseEvent("mouseup"));
      },
      typeAfter(anchor: string, text: string) {
        const node = textNode(anchor);
        setRange(node, node.textContent!.length, node.textContent!.length);
        doc.execCommand("insertText", false, text);
      },
    };
  }

  function readJsonPref(key: string): unknown {
    const raw = Zotero.Prefs.get(PREF_PREFIX + key, true);
    return typeof raw === "string" && raw ? JSON.parse(raw) : null;
  }

  /** The shortcut ids the popup shows, in order. */
  function shortcutIds(card: HTMLElement): string[] {
    return (
      Array.from(
        card.querySelectorAll("[data-llm-note-inline-prompt]"),
      ) as Element[]
    ).map((node) => node.getAttribute("data-llm-note-inline-prompt") || "");
  }

  /** Right-clicks `target` in the popup; returns the menu's actions. */
  function openShortcutMenu(card: HTMLElement, target: Element) {
    const win = Zotero.getMainWindow();
    const rect = target.getBoundingClientRect();
    // A real right-click: Zotero's window takes a button-0 contextmenu as
    // the keyboard's menu key, before the popup sees it.
    const event = new win.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      buttons: 2,
      clientX: rect.left + 4,
      clientY: rect.top + 4,
    });
    target.dispatchEvent(event);
    assert.isTrue(event.defaultPrevented, "the popup takes the right-click");
    return (
      Array.from(
        card.querySelectorAll("[data-llm-inline-ask-prompt-menu-item]"),
      ) as HTMLButtonElement[]
    ).map((item) => ({
      action: item.getAttribute("data-llm-inline-ask-prompt-menu-item"),
      disabled: item.disabled,
      item,
    }));
  }

  /** Fills the open shortcut editor and saves it. */
  function fillShortcutEditor(
    card: HTMLElement,
    value: { label: string; prompt: string },
    via: "enter-in-label" | "save-button",
  ) {
    const win = Zotero.getMainWindow();
    const label = card.querySelector(
      "[data-llm-inline-ask-prompt-label]",
    ) as HTMLInputElement;
    const prompt = card.querySelector(
      "[data-llm-inline-ask-prompt-text]",
    ) as HTMLElement;
    label.value = value.label;
    prompt.textContent = value.prompt;
    prompt.dispatchEvent(new win.Event("input", { bubbles: true }));
    if (via === "enter-in-label") {
      label.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    } else {
      (
        card.querySelector(
          "[data-llm-inline-ask-prompt-action='save']",
        ) as HTMLElement
      ).click();
    }
  }

  async function storedNote(): Promise<string> {
    const note = Zotero.Items.get(fixture.noteItemId);
    await note.reload(["note"], true);
    return note.getNote();
  }

  async function rewriteTo(
    editor: Awaited<ReturnType<typeof openEditor>>,
    answer: string,
  ) {
    const card = (await until(() => editor.card(), "the popup"))!;
    const rewrite = card.querySelector(
      "[data-llm-note-inline-action='rewrite']",
    ) as HTMLElement;
    assert.ok(rewrite, "the popup offers Rewrite");
    rewrite.click();
    const stream = await provider.waitForStream("Rewrite the selected text");
    assert.include(stream.requestBody, SOURCE, "the model sees the selection");
    stream.push(answer);
    stream.finish();
    await until(
      () => editor.card()?.getAttribute("data-phase") === "answered",
      "the answer",
    );
    // The answer shows as the plugin's diff of the selection.
    const change = editor
      .card()!
      .querySelector("[data-llm-note-inline-change] .llm-agent-hitl-diff");
    assert.ok(change, "the answer shows as a diff");
    assert.ok(
      change!.querySelector(".llm-agent-hitl-diff-line-add"),
      "the diff shows the new text",
    );
    return editor.card()!;
  }

  before(async function () {
    for (const key of SAVED_PREF_KEYS)
      previousPrefs.set(key, Zotero.Prefs.get(PREF_PREFIX + key, true));
    provider = installHeldChatProvider(API_BASE);
    Zotero.Prefs.set(PREF_PREFIX + "conversationSystem", "upstream", true);
    Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "enableClaudeCodeMode", false, true);
    setModelProviderGroups([
      {
        id: "workflow-note-inline-group",
        authMode: "api_key",
        apiBase: API_BASE,
        apiKey: "workflow-dummy-key",
        providerProtocol: "openai_chat_compat",
        models: [
          {
            id: ENTRY_ID,
            model: "note-inline-model",
            temperature: 0.3,
            outputTokenLimit: { mode: "auto" },
          },
        ],
      },
    ] as any);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedModelEntryId", ENTRY_ID, true);
    Zotero.Prefs.set(PREF_PREFIX + "inlineAskModelEntryId", ENTRY_ID, true);
    assert.isOk(getModelEntryById(ENTRY_ID));
  });

  after(async function () {
    provider?.restore();
    await api().reset();
    for (const [key, value] of previousPrefs) {
      if (value === undefined) Zotero.Prefs.clear(PREF_PREFIX + key, true);
      else Zotero.Prefs.set(PREF_PREFIX + key, value, true);
    }
  });

  beforeEach(async function () {
    await api().reset();
    for (const key of PROMPT_PREF_KEYS)
      Zotero.Prefs.clear(PREF_PREFIX + key, true);
    fixture = await api().createItemNoteFixture({
      title: "Inline writing parent",
      pdfTitle: "Inline writing PDF",
      noteHtml: NOTE_HTML,
    });
  });

  afterEach(async function () {
    provider.failOpenStreams("workflow case ended");
    await api().reset();
    if (fixture) await api().cleanupFixture(fixture);
    fixture = null;
  });

  it("opens under a selection with only the actions and a composer, without taking the keyboard", async function () {
    const editor = await openEditor(fixture.noteItemId);
    editor.select(SOURCE);
    const card = (await until(() => editor.card(), "the popup"))!;
    assert.deepEqual(
      (
        Array.from(
          card.querySelectorAll("[data-llm-note-inline-action]"),
        ) as Element[]
      )
        .filter((node) => (node as HTMLElement).offsetParent !== null)
        .map((node) => node.getAttribute("data-llm-note-inline-action")),
      ["rewrite", "expand", "proofread", "ask-in-sidebar", "send"],
    );
    assert.ok(card.querySelector("[data-llm-note-inline-composer]"));
    assert.equal(
      (
        card.querySelector("[data-llm-inline-ask-model]")?.textContent || ""
      ).trim() !== "",
      true,
      "the field shows the model it answers with",
    );
    (card.querySelector("[data-llm-inline-ask-model]") as HTMLElement).click();
    assert.ok(
      card.querySelector("[data-llm-inline-ask-model-menu='model']"),
      "the model opens its menu",
    );
    assert.notInclude(
      card.textContent || "",
      SOURCE,
      "the popup does not repeat the selection",
    );
    assert.isFalse(
      card.contains(Zotero.getMainWindow().document.activeElement),
      "the popup does not take the keyboard",
    );
    const frame = (
      Array.from(
        Zotero.getMainWindow().document.querySelectorAll("note-editor iframe"),
      ) as HTMLIFrameElement[]
    )
      .find((iframe) => iframe.contentDocument === editor.doc)!
      .getBoundingClientRect();
    const popupRect = card.getBoundingClientRect();
    assert.isAbove(popupRect.top, frame.top, "the popup sits on the note");

    editor.collapse();
    await until(() => !editor.card(), "the popup to close");
  });

  it("opens again on the same text after the selection went away, but not after Escape", async function () {
    const editor = await openEditor(fixture.noteItemId);
    editor.select(SOURCE);
    await until(() => editor.card(), "the popup");
    // Clicking elsewhere in the note closes the popup without dismissing
    // the text: selecting it again opens the popup again.
    editor.collapse();
    await until(() => !editor.card(), "the popup to close");
    editor.select(SOURCE);
    await until(() => editor.card(), "the popup on the same text again");

    // Escape is the user's own dismissal: the same selection stays closed.
    editor.doc.dispatchEvent(
      new editor.doc.defaultView!.KeyboardEvent("keydown", { key: "Escape" }),
    );
    await until(() => !editor.card(), "the popup to close on Escape");
    editor.select(SOURCE);
    await delay(400);
    assert.isNull(editor.card(), "Escape dismisses the same selection");
  });

  it("keeps the popup and the selection while the user types an instruction", async function () {
    const editor = await openEditor(fixture.noteItemId);
    editor.select(SOURCE);
    const card = (await until(() => editor.card(), "the popup"))!;
    const composer = card.querySelector(
      "[data-llm-note-inline-composer]",
    ) as HTMLTextAreaElement;
    const win = Zotero.getMainWindow();
    composer.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
    composer.focus();
    win.document.dispatchEvent(
      new win.MouseEvent("mouseup", { bubbles: true }),
    );
    composer.value = "Make it sound more formal";
    await delay(800);
    assert.ok(editor.card(), "the popup stays open while typing");
    assert.equal(
      editor.doc.defaultView!.getSelection()!.toString(),
      SOURCE,
      "the note keeps its selection",
    );
    composer.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    const stream = await provider.waitForStream("Make it sound more formal");
    stream.push("The decoder was formally fitted on session one.");
    stream.finish();
    await until(
      () => editor.card()?.getAttribute("data-phase") === "answered",
      "the answer",
    );
    assert.include(
      editor.card()!.querySelector("[data-llm-note-inline-answer]")!
        .textContent || "",
      "formally fitted",
    );
  });

  it("Rewrite then Replace writes the answer and keeps typing elsewhere", async function () {
    const editor = await openEditor(fixture.noteItemId);
    editor.select(SOURCE);
    const card = await rewriteTo(
      editor,
      "The decoder was trained on session one only.",
    );
    editor.typeAfter("Keep this paragraph.", " typed meanwhile");
    (
      card.querySelector(
        "[data-llm-note-inline-action='replace']",
      ) as HTMLElement
    ).click();
    await until(() => !editor.card(), "the card to close after Replace");

    const saved = await storedNote();
    assert.include(saved, "The decoder was trained on session one only.");
    assert.notInclude(saved, SOURCE);
    assert.include(saved, "typed meanwhile", "Replace kept the typing");
    await until(
      () =>
        editor.doc.defaultView!.getSelection()!.toString() ===
        "The decoder was trained on session one only.",
      "the replacement selected in the note",
    );
    assert.include(editor.text(), "trained on session one only.");
    await delay(400);
    assert.isNull(editor.card(), "selecting the change opens no popup");
  });

  it("Insert below adds the answer after the selected paragraph", async function () {
    const editor = await openEditor(fixture.noteItemId);
    editor.select(SOURCE);
    const card = await rewriteTo(editor, "An added follow-up sentence.");
    (
      card.querySelector(
        "[data-llm-note-inline-action='insert-below']",
      ) as HTMLElement
    ).click();
    await until(() => !editor.card(), "the card to close after Insert");
    await until(
      () => editor.text().includes("An added follow-up sentence."),
      "the inserted paragraph",
    );
    const text = editor.text();
    assert.include(text, SOURCE, "the selection stays");
    assert.isBelow(
      text.indexOf(SOURCE),
      text.indexOf("An added follow-up sentence."),
    );
  });

  /** Selects SOURCE in the open note and hands it to the paper's chat. */
  async function handSelectionToSidebar() {
    // The paper's chat, mounted in the main window as the side pane holds it.
    const panel = await api().renderPanelForItem(fixture.parentItemId);
    const editor = await openEditor(fixture.noteItemId);
    editor.select(SOURCE);
    const card = (await until(() => editor.card(), "the card"))!;
    (
      card.querySelector(
        "[data-llm-note-inline-action='ask-in-sidebar']",
      ) as HTMLElement
    ).click();
    await until(
      () => !editor.card(),
      "the popup to close after Ask in sidebar",
    );
    const deadline = Date.now() + 10_000;
    let diagnostics = await api().getDiagnostics(panel.panelId);
    while (
      !(diagnostics.selectedContextLabels || []).includes("Editing") &&
      Date.now() < deadline
    ) {
      await delay(50);
      diagnostics = await api().getDiagnostics(panel.panelId);
    }
    return { panel, diagnostics };
  }

  it("Ask in sidebar hands the selection to the paper's chat", async function () {
    const { diagnostics } = await handSelectionToSidebar();
    // The note selection is a note-editing chip in the paper's composer.
    assert.include(diagnostics.selectedContextLabels, "Editing");
    assert.equal(diagnostics.conversationKind, "paper");
  });

  it("sends a selection handed to the sidebar once", async function () {
    const { panel, diagnostics } = await handSelectionToSidebar();
    assert.include(diagnostics.selectedContextLabels, "Editing");

    const first = await api().ask(panel.panelId, "Explain this sentence");
    assert.include(first.selectedTexts, SOURCE);
    assert.include(first.selectedTextSources, "note-edit");
    assert.notInclude(
      (await api().getDiagnostics(panel.panelId)).selectedContextLabels,
      "Editing",
      "the handed selection leaves the composer with its message",
    );

    const second = await api().ask(panel.panelId, "And in simpler words?");
    assert.notInclude(second.selectedTextSources || [], "note-edit");
  });

  it("Ask in sidebar from a standalone note goes to the note's own chat, not a library chat", async function () {
    const standalone = await api().createStandaloneNoteFixture({
      noteHtml: NOTE_HTML,
    });
    try {
      // A library chat mounted first: it is not this note's chat.
      const libraryPanel = await api().renderPanelForItem(fixture.parentItemId);
      const library = await api().togglePanelConversationMode(
        libraryPanel.panelId,
      );
      assert.equal(library.conversationKind, "global");
      const notePanel = await api().renderPanelForItem(standalone.noteItemId);

      const editor = await openEditor(standalone.noteItemId);
      editor.select(SOURCE);
      const card = (await until(() => editor.card(), "the card"))!;
      (
        card.querySelector(
          "[data-llm-note-inline-action='ask-in-sidebar']",
        ) as HTMLElement
      ).click();
      await until(
        () => !editor.card(),
        "the popup to close after Ask in sidebar",
      );
      const labels = async (panelId: string): Promise<string[]> =>
        (await api().getDiagnostics(panelId)).selectedContextLabels || [];
      const deadline = Date.now() + 10_000;
      while (
        !(await labels(notePanel.panelId)).includes("Editing") &&
        Date.now() < deadline
      )
        await delay(50);
      assert.include(
        await labels(notePanel.panelId),
        "Editing",
        "the selection is in the note's own chat",
      );
      assert.notInclude(
        await labels(libraryPanel.panelId),
        "Editing",
        "the library chat is not the note's chat",
      );
    } finally {
      await api().cleanupFixture(standalone);
    }
  });
  it("edits a shortcut from its right-click menu, and the shortcut sends its new prompt", async function () {
    const editor = await openEditor(fixture.noteItemId);
    editor.select(SOURCE);
    const card = (await until(() => editor.card(), "the popup"))!;
    const rewrite = card.querySelector(
      "[data-llm-note-inline-prompt='rewrite']",
    )!;
    const menu = openShortcutMenu(card, rewrite);
    assert.deepEqual(
      menu.map((entry) => [entry.action, entry.disabled]),

      [
        ["edit", false],
        ["delete", false],
        ["add", false],
        ["reset", false],
      ],
    );
    menu[0].item.click();
    const panel = card.querySelector(
      "[data-llm-inline-ask-prompt-editor]",
    ) as HTMLElement;
    assert.equal(panel.style.display, "flex", "Edit opens the editor");
    const label = card.querySelector(
      "[data-llm-inline-ask-prompt-label]",
    ) as HTMLInputElement;
    assert.equal(label.value, "Rewrite");
    assert.include(
      card.querySelector("[data-llm-inline-ask-prompt-text]")!.textContent ||
        "",
      "Rewrite the selected text",
    );

    const PROMPT = "WF_NOTE_EDITED_PROMPT Make the selected text formal.";
    fillShortcutEditor(
      card,
      { label: "Formalize", prompt: PROMPT },
      "enter-in-label",
    );
    assert.equal(panel.style.display, "none", "saving closes the editor");
    assert.isFalse(
      card.contains(Zotero.getMainWindow().document.activeElement),
      "saving gives the keyboard back, so the popup follows the selection again",
    );
    assert.deepEqual(readJsonPref("noteInlinePrompts"), [
      { id: "rewrite", label: "Formalize", prompt: PROMPT },
    ]);
    assert.isNull(
      readJsonPref("inlineAskPrompts"),
      "the reader's Inline Ask prompts stay as they were",
    );
    const edited = card.querySelector(
      "[data-llm-note-inline-prompt='rewrite']",
    ) as HTMLElement;
    assert.equal(edited.textContent, "Formalize");
    assert.equal(
      editor.doc.defaultView!.getSelection()!.toString(),
      SOURCE,
      "the note keeps its selection while the shortcut is edited",
    );

    edited.click();
    const stream = await provider.waitForStream("WF_NOTE_EDITED_PROMPT");
    assert.include(stream.requestBody, SOURCE, "the model sees the selection");
    stream.push("The decoder was formally fitted on session one.");
    stream.finish();
    await until(
      () => editor.card()?.getAttribute("data-phase") === "answered",
      "the answer",
    );
    assert.ok(
      editor.card()!.querySelector("[data-llm-note-inline-change]"),
      "an edited shortcut's answer shows as a change to the selection",
    );
  });

  it("adds a shortcut from the row, deletes a built-in, and Reset restores the three", async function () {
    const editor = await openEditor(fixture.noteItemId);
    editor.select(SOURCE);
    const card = (await until(() => editor.card(), "the popup"))!;
    const rowMenu = openShortcutMenu(
      card,
      card.querySelector("[data-llm-note-inline-action='ask-in-sidebar']")!,
    );
    assert.deepEqual(
      rowMenu.map((entry) => entry.action),
      ["add", "reset"],
    );
    rowMenu[0].item.click();
    fillShortcutEditor(
      card,
      {
        label: "WF Simplify",
        prompt: "WF_NOTE_ADDED_PROMPT Simplify the selected text.",
      },
      "save-button",
    );
    const ids = shortcutIds(card);
    assert.deepEqual(ids.slice(0, 3), ["rewrite", "expand", "proofread"]);
    assert.lengthOf(ids, 4);
    const customId = ids[3];
    assert.match(customId, /^note-inline-custom-/);
    assert.deepEqual(readJsonPref("noteInlinePrompts"), [
      {
        id: customId,
        label: "WF Simplify",
        prompt: "WF_NOTE_ADDED_PROMPT Simplify the selected text.",
      },
    ]);

    const deleteMenu = openShortcutMenu(
      card,
      card.querySelector("[data-llm-note-inline-prompt='proofread']")!,
    );
    deleteMenu.find((entry) => entry.action === "delete")!.item.click();
    assert.deepEqual(shortcutIds(card), ["rewrite", "expand", customId]);
    assert.deepEqual(readJsonPref("noteInlineDeletedPrompts"), ["proofread"]);

    // The popup follows the selection again after the edits: it closes with
    // it, and a new popup shows the changes; Reset there restores the
    // built-ins.
    editor.collapse();
    await until(() => !editor.card(), "the popup to close");
    editor.select("Keep this paragraph.");
    const reopened = (await until(() => editor.card(), "the popup again"))!;
    assert.deepEqual(shortcutIds(reopened), ["rewrite", "expand", customId]);
    const resetMenu = openShortcutMenu(
      reopened,
      reopened.querySelector(`[data-llm-note-inline-prompt='${customId}']`)!,
    );
    resetMenu.find((entry) => entry.action === "reset")!.item.click();
    assert.deepEqual(shortcutIds(reopened), ["rewrite", "expand", "proofread"]);
    assert.isNull(readJsonPref("noteInlinePrompts"), "Reset clears the list");
    assert.isNull(
      readJsonPref("noteInlineDeletedPrompts"),
      "and the deletions",
    );
    assert.ok(editor.card(), "the popup stays open through the edits");
  });

  it("keeps list items when two items of a list are rewritten and replaced", async function () {
    const editor = await openEditor(fixture.noteItemId);
    editor.selectAcross("First item text.", "Second item text.");
    const card = (await until(() => editor.card(), "the popup"))!;
    (
      card.querySelector(
        "[data-llm-note-inline-action='rewrite']",
      ) as HTMLElement
    ).click();
    const stream = await provider.waitForStream("Rewrite the selected text");
    assert.match(
      stream.requestBody,
      /- First item text\.\\n- Second item text\./,
      "the model sees the selection as list items",
    );
    stream.push("- First item, rewritten.\n- Second item, rewritten.");
    stream.finish();
    await until(
      () => editor.card()?.getAttribute("data-phase") === "answered",
      "the answer",
    );
    (
      editor
        .card()!
        .querySelector("[data-llm-note-inline-action='replace']") as HTMLElement
    ).click();
    await until(() => !editor.card(), "the popup to close after Replace");

    const saved = await storedNote();
    assert.match(
      saved,
      /<ul>\s*<li>\s*(<p>)?First item, rewritten\.(<\/p>)?\s*<\/li>\s*<li>\s*(<p>)?Second item, rewritten\.(<\/p>)?\s*<\/li>\s*<li>\s*(<p>)?Third item stays\./,
      saved,
    );
    assert.notMatch(saved, /<p>- /, "no list marker is written as text");
  });

  it("Replace changes the occurrence the user selected when the text repeats in the note", async function () {
    const editor = await openEditor(fixture.noteItemId);
    // "item text." also ends the first list item.
    editor.selectIn("Second item text.", "item text.");
    const card = (await until(() => editor.card(), "the popup"))!;
    (
      card.querySelector(
        "[data-llm-note-inline-action='rewrite']",
      ) as HTMLElement
    ).click();
    const stream = await provider.waitForStream("Rewrite the selected text");
    stream.push("entry, rewritten.");
    stream.finish();
    await until(
      () => editor.card()?.getAttribute("data-phase") === "answered",
      "the answer",
    );
    (
      editor
        .card()!
        .querySelector("[data-llm-note-inline-action='replace']") as HTMLElement
    ).click();
    const outcome = await until(
      () =>
        editor.card()
          ? editor
              .card()!
              .querySelector("[data-llm-note-inline-error]")
              ?.textContent?.trim()
          : "replaced",
      "Replace to finish",
    );
    assert.equal(outcome, "replaced");

    const saved = await storedNote();
    assert.include(saved, "First item text.", "the first one is untouched");
    assert.include(saved, "Second entry, rewritten.");
    assert.notInclude(saved, "Second item text.");
  });

  it("refuses an occurrence the note does not have, rather than change another one", function () {
    const html = "<p>a one b</p><p>c one d</p>";
    const second = replaceNoteSelectionHtml(html, "one", "1", {
      index: 2,
      count: 2,
    });
    assert.include(second || "", "<p>a one b</p>", "the first one stays");
    assert.notInclude(second || "", "c one");
    // The editor counted three; the note holds two.
    assert.isNull(
      replaceNoteSelectionHtml(html, "one", "1", { index: 2, count: 3 }),
    );
  });

  it("opens in the note's own tab while the library pane's editor still holds a selection", async function () {
    const win = Zotero.getMainWindow() as any;
    const pane = await openEditor(fixture.noteItemId);
    pane.select(SOURCE);
    await until(() => pane.card(), "the popup in the library pane");
    pane.doc.dispatchEvent(
      new pane.doc.defaultView!.KeyboardEvent("keydown", { key: "Escape" }),
    );
    await until(() => !pane.card(), "the popup to close on Escape");

    const tab = await openEditorTab(fixture.noteItemId);
    try {
      tab.select("Keep this paragraph.");
      await until(() => tab.card(), "the popup in the note's own tab");
    } finally {
      win.Zotero_Tabs.close(win.Zotero_Tabs.selectedID);
      win.Zotero_Tabs.select("zotero-pane");
    }
  });

  it("opens no second popup on the text Replace just wrote", async function () {
    const editor = await openEditor(fixture.noteItemId);
    editor.selectAcross("First item text.", "Second item text.");
    const card = (await until(() => editor.card(), "the popup"))!;
    (
      card.querySelector(
        "[data-llm-note-inline-action='rewrite']",
      ) as HTMLElement
    ).click();
    const stream = await provider.waitForStream("Rewrite the selected text");
    stream.push("- First item, rewritten.\n- Second item, rewritten.");
    stream.finish();
    await until(
      () => editor.card()?.getAttribute("data-phase") === "answered",
      "the answer",
    );
    (
      editor
        .card()!
        .querySelector("[data-llm-note-inline-action='replace']") as HTMLElement
    ).click();
    // The editor holds a selection of its own between the write and the
    // plugin selecting what was written. The selection tracker checks on a
    // timer and at every mouse or key release; here a check lands in between.
    const released = Date.now() + 400;
    while (Date.now() < released) {
      editor.doc.dispatchEvent(
        new editor.doc.defaultView!.MouseEvent("mouseup"),
      );
      await delay(5);
    }
    await delay(600);
    assert.isNull(editor.card(), "the written text opens no popup");
    assert.include(
      String(editor.doc.defaultView!.getSelection()),
      "Second item, rewritten.",
      "the whole written text ends up selected",
    );
  });
});
