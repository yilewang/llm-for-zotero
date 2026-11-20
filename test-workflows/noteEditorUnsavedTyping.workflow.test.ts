import "./hostSurfaceBootstrap";
import { assert } from "chai";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import { revertActions } from "../src/agent/services/changeReverter";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { createNoteFromAssistantText } from "../src/modules/contextPanel/notes";

/**
 * Zotero's note editor saves what the user types about a second later. A
 * write that reads the note in that window must see the typing, so it never
 * replaces text the user can still see in the editor.
 */
describe("workflow: note writes keep typing the open editor has not saved", function () {
  this.timeout(60000);

  const TYPED = " typed just now";
  const SOURCE = "A decoder fitted on session one.";
  const REPLACEMENT = "A decoder trained on session one only.";
  const NOTE_HTML =
    "<h2>Methodology</h2><p>Simulated recordings across twelve sessions.</p>" +
    `<p>${SOURCE}</p><h2>Limitations</h2><p>Keep this paragraph.</p>`;

  const delay = (ms: number) => Zotero.Promise.delay(ms);
  async function until<T>(read: () => T, label: string): Promise<T> {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const value = read();
      if (value) return value;
      await delay(25);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  /** Open the note in the item pane's real note editor. */
  async function openEditor(note: Zotero.Item) {
    const win = Zotero.getMainWindow() as any;
    win.Zotero_Tabs?.select?.("zotero-pane");
    await win.ZoteroPane.selectItem(note.id);
    const editor = await until(
      () =>
        Array.from(win.document.querySelectorAll("note-editor")).find(
          (el: any) => el.item?.id === note.id && el.getClientRects().length,
        ) as any,
      "the note editor",
    );
    const iframe = editor.querySelector("iframe") as HTMLIFrameElement;
    await until(
      () =>
        iframe.contentDocument
          ?.querySelector(".ProseMirror")
          ?.textContent?.includes("Keep this paragraph."),
      "the note editor content",
    );
    // Let the editor finish its own first save of the loaded note.
    await delay(1500);
    const doc = iframe.contentDocument!;
    const body = () => doc.querySelector(".ProseMirror") as HTMLElement;
    return {
      text: () => body().textContent || "",
      /** Type at the end of the paragraph holding `anchor`, as a user would. */
      typeAfter(anchor: string, text: string) {
        const walker = doc.createTreeWalker(body(), 4);
        let node: Node | null;
        while ((node = walker.nextNode()))
          if (node.textContent?.includes(anchor)) break;
        if (!node) throw new Error(`No editor text contains ${anchor}`);
        body().focus();
        const range = doc.createRange();
        range.setStart(node, node.textContent!.length);
        range.collapse(true);
        const selection = doc.defaultView!.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        doc.execCommand("insertText", false, text);
      },
    };
  }

  async function storedNote(note: Zotero.Item): Promise<string> {
    await note.reload(["note"], true);
    return note.getNote();
  }

  function noteWriteContext(note: Zotero.Item, runId: string) {
    return {
      runId,
      request: {
        conversationKey: note.id,
        mode: "agent",
        libraryID: note.libraryID,
        userText: "Rewrite the decoder sentence.",
        activeItemId: note.id,
      },
      item: note,
      modelName: "workflow",
      currentAnswerText: "",
    };
  }

  async function rewriteSource(note: Zotero.Item, runId: string) {
    const api = (Zotero as any).LLMForZotero.api;
    const tool = api.agent.getToolDefinition("note_write");
    const validated = tool.validate({
      mode: "edit",
      targetNoteId: note.id,
      patches: [{ find: SOURCE, replace: REPLACEMENT }],
    });
    assert.isTrue(validated.ok, JSON.stringify(validated));
    const context = noteWriteContext(note, runId);
    await tool.planInvocation(validated.value, context);
    await tool.execute(validated.value, context);
    return context;
  }

  let fixture: any = null;
  let note: Zotero.Item;

  beforeEach(async function () {
    const api = (Zotero as any).LLMForZotero.api;
    await api.workflowTest.reset();
    await initAgentChangeJournal();
    fixture = await api.workflowTest.createItemNoteFixture({
      title: `Unsaved typing ${this.currentTest?.title}`,
      pdfTitle: "Unsaved typing context",
      noteHtml: NOTE_HTML,
    });
    note = Zotero.Items.get(fixture.noteItemId);
  });

  afterEach(async function () {
    const api = (Zotero as any).LLMForZotero.api;
    await api.workflowTest.reset();
    if (fixture) await api.workflowTest.cleanupFixture(fixture);
    fixture = null;
  });

  it("an agent edit keeps typing the editor has not saved yet", async function () {
    const editor = await openEditor(note);
    editor.typeAfter("Keep this paragraph.", TYPED);
    assert.notInclude(
      await storedNote(note),
      TYPED.trim(),
      "the typing must still be unsaved when the edit starts",
    );

    await rewriteSource(note, `unsaved-edit-${note.key}`);

    const saved = await storedNote(note);
    assert.include(saved, REPLACEMENT);
    assert.include(saved, TYPED.trim(), "the saved note lost the typing");
    await delay(500);
    assert.include(editor.text(), REPLACEMENT);
    assert.include(editor.text(), TYPED.trim(), "the editor lost the typing");
  });

  it("appending a saved answer keeps typing the editor has not saved yet", async function () {
    const parent = Zotero.Items.get(fixture.parentItemId);
    const options = { appendToTrackedNote: true, rememberCreatedNote: true };
    const first = await createNoteFromAssistantText(
      parent,
      "First answer.",
      "workflow-model",
      undefined,
      { ...options, queryText: "First question?" },
    );
    const tracked = Zotero.Items.get(first.noteId!);
    try {
      const editor = await openEditor(tracked);
      editor.typeAfter("First answer.", TYPED);
      assert.notInclude(await storedNote(tracked), TYPED.trim());

      const second = await createNoteFromAssistantText(
        parent,
        "Second answer.",
        "workflow-model",
        undefined,
        { ...options, queryText: "Second question?" },
      );

      assert.equal(second.status, "appended");
      const saved = await storedNote(tracked);
      assert.include(saved, "Second answer.");
      assert.include(saved, TYPED.trim(), "the saved note lost the typing");
    } finally {
      await tracked.eraseTx();
    }
  });

  it("an edit and its undo still work while the editor is open and idle", async function () {
    const editor = await openEditor(note);
    const before = await storedNote(note);
    const context = await rewriteSource(note, `idle-editor-${note.key}`);
    assert.include(await storedNote(note), REPLACEMENT);
    await delay(1500);

    const actions = await listJournalActions({ runId: context.runId });
    const outcome = await revertActions({
      actions,
      zoteroGateway: new ZoteroGateway(),
      context: context as never,
    });

    assert.equal(outcome.reverted, 1, JSON.stringify(outcome));
    const saved = await storedNote(note);
    assert.include(saved, SOURCE);
    assert.notInclude(saved, REPLACEMENT);
    assert.equal(saved, before);
    await delay(500);
    assert.include(editor.text(), SOURCE);
  });

  it("undo never replaces typing the editor has not saved yet", async function () {
    const editor = await openEditor(note);
    const context = await rewriteSource(note, `unsaved-undo-${note.key}`);
    await delay(1500);
    editor.typeAfter("Keep this paragraph.", TYPED);
    assert.notInclude(await storedNote(note), TYPED.trim());

    const actions = await listJournalActions({ runId: context.runId });
    assert.lengthOf(actions, 1);
    const outcome = await revertActions({
      actions,
      zoteroGateway: new ZoteroGateway(),
      context: context as never,
    });

    const saved = await storedNote(note);
    assert.include(saved, TYPED.trim(), "undo replaced the typing");
    assert.equal(
      outcome.reverted,
      0,
      "undo must not claim it restored the note",
    );
    await delay(500);
    assert.include(editor.text(), TYPED.trim(), "the editor lost the typing");
  });
});
