import { assert } from "chai";
import { rejects } from "node:assert/strict";
import { executeNoteCreation } from "../src/agent/services/noteCreation";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import { installNativeNoteStore } from "./helpers/nativeNoteStore";

describe("recoverable note creation", function () {
  const original = globalThis.Zotero;
  let native: ReturnType<typeof installNativeNoteStore>;
  beforeEach(async function () {
    globalThis.Zotero = { DB: new ChangeJournalTestDb() } as never;
    native = installNativeNoteStore();
    await initAgentChangeJournal();
  });
  afterEach(function () {
    globalThis.Zotero = original;
  });
  const params = () => ({
    context: {
      runId: "create-run",
      request: { conversationKey: 41, libraryID: 1 },
    } as never,
    libraryID: 1,
    html: "<p>Requested text</p>",
  });
  it("does not recreate an erased completed note when the same action resumes", async function () {
    const result = await executeNoteCreation(params());
    native.notes.delete(result.content.noteId);
    await rejects(executeNoteCreation(params()), /removed|unavailable/);
    assert.equal(native.notes.size, 0);
  });
  it("preserves an incomplete note and never repeats failed asset imports automatically", async function () {
    let imports = 0;
    const request = {
      ...params(),
      finalize: async () => {
        imports++;
        throw new Error("Asset import failed");
      },
    };
    await rejects(executeNoteCreation(request), /Asset import failed/);
    await rejects(executeNoteCreation(request), /incomplete assets/);
    assert.equal(native.notes.size, 1);
    assert.equal(imports, 1);
    assert.equal([...native.notes.values()][0].stored, "<p>Requested text</p>");
  });
});
