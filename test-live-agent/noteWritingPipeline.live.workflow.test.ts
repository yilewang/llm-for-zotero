import { assert } from "chai";
import { resolveLiveAgentCredentials } from "./liveAgentCredentials";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import { noteHtmlMatches } from "../src/utils/noteHtml";

declare const Zotero: any;

describe("live: note writing from typed workspace context", function () {
  this.timeout(720000);
  it("reads the source paper, replaces the bound note, appends, edits, and clarifies ambiguous writing", async function () {
    const creds = await resolveLiveAgentCredentials({
      requestedModel: "deepseek-v4-flash",
    });
    assert.isNotNull(
      creds,
      "DeepSeek credentials are required; this acceptance must not silently skip",
    );
    const api = Zotero.LLMForZotero.api;
    const workflow = api.workflowTest;
    const fixture = await workflow.createPaperWithPdfFixture({
      title: "Note pipeline synthetic source",
      pdfTitle: "Synthetic note pipeline paper",
      pages: [
        "This is a synthetic experiment, not a published biological result. A stable population readout coexists with representational drift. Simulated recordings cover twelve sessions. A linear decoder trained on session one achieves accuracy 0.83; after shuffling neuron identities accuracy is 0.51. Only simulated data and linear decoders were studied.",
      ],
    });
    const note = new Zotero.Item("note");
    note.libraryID = Zotero.Libraries.userLibraryID;
    note.parentID = fixture.parentItemId;
    note.setNote("<p>Original destination text.</p>");
    await note.saveTx();
    const folder = new Zotero.Collection();
    folder.libraryID = note.libraryID;
    folder.name = `Note pipeline context ${note.id}`;
    await folder.saveTx();
    const paper = Zotero.Items.get(fixture.parentItemId);
    paper.addTag("note-pipeline-source");
    paper.addToCollection(folder.id);
    await paper.saveTx();
    const mode = getOriginalAgentPermissionMode();
    setOriginalAgentPermissionMode("auto");
    const runs: Array<{
      calls: string[];
      writes: any[];
      questions: number;
      result: any;
    }> = [];
    async function turn(userText: string, ambiguous = false) {
      await note.reload(["note"], true);
      const calls: string[] = [],
        writes: any[] = [];
      let questions = 0;
      const result = await api.agent.runTurn(
        {
          conversationKey: note.id,
          mode: "agent",
          userText,
          libraryID: note.libraryID,
          activeItemId: note.id,
          activeNoteContext: {
            noteId: note.id,
            title: note.getNoteTitle(),
            noteKind: "item",
            parentItemId: paper.id,
            noteText: note.getNote(),
          },
          selectedPaperContexts: [
            {
              libraryID: note.libraryID,
              itemId: paper.id,
              contextItemId: fixture.pdfAttachmentId,
              title: paper.getDisplayTitle(),
            },
          ],
          selectedCollectionContexts: [
            {
              libraryID: note.libraryID,
              collectionId: folder.id,
              name: folder.name,
            },
          ],
          selectedTagContexts: [
            {
              libraryID: note.libraryID,
              name: "note-pipeline-source",
            },
          ],
          ...creds,
        },
        (event: any) => {
          if (event.type === "tool_call") calls.push(event.name);
          if (event.type === "tool_result" && event.name === "note_write")
            writes.push(event);
          if (event.type === "confirmation_required") {
            if (event.action.toolName === "request_user_input") questions++;
            void api.agent.resolveConfirmation(
              event.requestId,
              ambiguous ? false : true,
            );
          }
        },
      );
      runs.push({ calls, writes, questions, result });
      await note.reload(["note"], true);
      if (!ambiguous) {
        assert.equal(
          result.kind,
          "completed",
          JSON.stringify({ calls, kind: result.kind }),
        );
        assert.isAtLeast(writes.length, 1, "the requested write must execute");
        assert.isTrue(
          writes.every((w) => w.ok),
          "all reported note writes must be verified",
        );
        assert.isTrue(
          writes.some((w) =>
            w.actionReceipts?.some((r: any) => r.verification === "verified"),
          ),
          "native receipt required",
        );
      }
      return { calls, writes, questions };
    }
    try {
      const first = await turn(
        `Read the supplied synthetic paper and replace all content of existing note ${note.id} with a short reading note. Include both accuracy values and the synthetic-data limitation. The collection and tag are context only.`,
      );
      assert.include(first.calls, "paper_read");
      assert.include(note.getNote(), "0.83");
      assert.include(note.getNote(), "0.51");
      assert.match(note.getNote(), /synthetic|simulat/i);
      assert.notInclude(note.getNote(), "Original destination text");
      const generated = note.getNote();
      await turn(
        `Append exactly this paragraph to existing note ${note.id}, preserving all its existing content: Pipeline append marker.`,
      );
      assert.equal(
        (note.getNote().match(/Pipeline append marker/g) || []).length,
        1,
      );
      const appended = note.getNote();
      await turn(
        `In existing note ${note.id}, change only "Pipeline append marker." to "Pipeline revised marker." Preserve everything else.`,
      );
      assert.isTrue(
        noteHtmlMatches(
          note.getNote(),
          appended.replace(
            "Pipeline append marker.",
            "Pipeline revised marker.",
          ),
        ),
      );
      assert.include(note.getNote(), "0.83");
      assert.isNotEmpty(generated);
      const beforeQuestion = note.getNote();
      const unclear = await turn(
        "Write this into my note: Another observation.",
        true,
      );
      assert.isAtLeast(
        unclear.questions,
        1,
        "ambiguous append versus replacement must be clarified",
      );
      assert.lengthOf(unclear.writes, 0);
      assert.isTrue(noteHtmlMatches(note.getNote(), beforeQuestion));
      await paper.reload(
        ["primaryData", "tags", "collections", "childItems"],
        true,
      );
      assert.deepEqual(paper.getNotes(), [note.id]);
      assert.include(paper.getCollections(), folder.id);
      assert.isTrue(paper.hasTag("note-pipeline-source"));
    } finally {
      Zotero.debug(
        `[note-pipeline-acceptance] ${JSON.stringify(runs.map((r) => ({ calls: r.calls, writes: r.writes.map((w) => ({ ok: w.ok, receipts: w.actionReceipts })), questions: r.questions, kind: r.result?.kind })))}`,
      );
      setOriginalAgentPermissionMode(mode);
      await note.eraseTx();
      await workflow.cleanupFixture(fixture);
      await folder.eraseTx();
    }
  });
});
