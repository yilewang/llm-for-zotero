import "./hostSurfaceBootstrap";
import { assert } from "chai";
import {
  createNoteFromAssistantText,
  createNoteFromChatHistory,
} from "../src/modules/contextPanel/notes";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";
import type { Message } from "../src/modules/contextPanel/types";

describe("workflow: saved chat notes are titled with the question", function () {
  this.timeout(60000);

  let parent: Zotero.Item | null = null;
  const created: number[] = [];

  beforeEach(async function () {
    parent = new Zotero.Item("journalArticle");
    parent.libraryID = Zotero.Libraries.userLibraryID;
    parent.setField("title", "Question title destination");
    await parent.saveTx();
  });

  afterEach(async function () {
    // Deleting the parent trashes its child notes; erase each explicitly.
    for (const id of created.splice(0)) {
      const note = Zotero.Items.get(id);
      if (note) await note.eraseTx();
    }
    if (parent) {
      await parent.eraseTx();
      parent = null;
    }
  });

  async function readNote(noteId: number | undefined): Promise<Zotero.Item> {
    assert.isOk(noteId, "note id");
    created.push(noteId!);
    const note = Zotero.Items.get(noteId!);
    assert.isOk(note, "note should exist");
    return note as Zotero.Item;
  }

  it("titles a reply note with a one-line question", async function () {
    const result = await createNoteFromAssistantText(
      parent!,
      "The answer is forty-two.",
      "workflow-model",
      undefined,
      { queryText: "What is the meaning of life?" },
    );
    const note = await readNote(result.noteId);
    assert.equal(note.getNoteTitle(), "What is the meaning of life?");
    const html = note.getNote();
    assert.notInclude(html, "User query:");
    assert.notInclude(html, "<blockquote>");
    assert.include(html, "The answer is forty-two.");
    assert.include(html, "Model response:");
  });

  it("cuts a long multi-line question to its first line and keeps the rest in a blockquote", async function () {
    const longLine = "L".repeat(150);
    const question = `${longLine}\nSecond line of the question.`;
    const result = await createNoteFromAssistantText(
      parent!,
      "Long question answer.",
      "workflow-model",
      undefined,
      { queryText: question },
    );
    const note = await readNote(result.noteId);
    const title = note.getNoteTitle();
    assert.equal(title.length, 120);
    assert.isTrue(title.endsWith("…"));
    assert.equal(title, `${"L".repeat(119)}…`);
    const html = note.getNote();
    assert.match(
      html,
      /<blockquote>[\s\S]*Second line of the question\.[\s\S]*<\/blockquote>/,
    );
    assert.include(html, "Long question answer.");
    assert.notInclude(html, "User query:");
  });

  it("titles a reply note with the typed question when it starts with a quote citation", async function () {
    const passage = "Stable readout coexists with representational drift.";
    const citation = buildQuoteCitation({
      quoteText: passage,
      citationLabel: "(Fixture, 2024)",
      itemId: parent!.id,
      sourceMatchKind: "exact",
      sourceMatchSource: "context-text",
    })!;
    assert.isOk(citation, "quote citation");
    const result = await createNoteFromAssistantText(
      parent!,
      "It means the code is stable.",
      "workflow-model",
      [],
      {
        queryText: `[[quote:${citation.id}]]\nWhat does this mean?`,
        quoteCitations: [citation],
      },
    );
    const note = await readNote(result.noteId);
    assert.equal(note.getNoteTitle(), "What does this mean?");
    assert.match(
      note.getNote(),
      /<blockquote>[\s\S]*Stable readout coexists with representational drift\.[\s\S]*<\/blockquote>/,
    );
  });

  it("keeps the answer title when the question is empty", async function () {
    const result = await createNoteFromAssistantText(
      parent!,
      "Answer first line.\n\nMore answer.",
      "workflow-model",
      undefined,
      { queryText: "" },
    );
    const note = await readNote(result.noteId);
    assert.equal(note.getNoteTitle(), "Answer first line.");
    assert.notInclude(note.getNote(), "User query:");
  });

  it("appends a later reply under an h2 and keeps the first title", async function () {
    const options = {
      appendToTrackedNote: true,
      rememberCreatedNote: true,
    };
    const first = await createNoteFromAssistantText(
      parent!,
      "First answer.",
      "workflow-model",
      undefined,
      { ...options, queryText: "First question?" },
    );
    const note = await readNote(first.noteId);
    const second = await createNoteFromAssistantText(
      parent!,
      "Second answer.",
      "workflow-model",
      undefined,
      { ...options, queryText: "Second question?" },
    );
    assert.equal(second.status, "appended");
    assert.equal(second.noteId, first.noteId);
    await note.reload(["note"], true);
    assert.equal(note.getNoteTitle(), "First question?");
    const html = note.getNote();
    assert.match(html, /<h2>Second question\?<\/h2>/);
    assert.include(html, "First answer.");
    assert.include(html, "Second answer.");
  });

  it("titles a whole-chat export with the first user question", async function () {
    const history = [
      { role: "user", text: "Summarize this paper.", timestamp: Date.now() },
      {
        role: "assistant",
        text: "It studies memory.",
        timestamp: Date.now(),
        modelName: "workflow-model",
      },
    ] as unknown as Message[];
    const result = await createNoteFromChatHistory(parent!, history);
    const note = await readNote(result.noteId);
    assert.equal(note.getNoteTitle(), "Summarize this paper.");
    const html = note.getNote();
    assert.include(html, "Chat history saved at");
    assert.include(html, "It studies memory.");
  });
});
