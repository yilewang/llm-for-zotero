import { assert } from "chai";
import { readRecoveryText } from "../src/agent/store/journalRecoveryBlobStore";
import {
  buildNoteChangeResultCards,
  captureNoteChange,
  failedNoteChange,
} from "../src/agent/tools/write/noteChangePresentation";

describe("completed note changes", function () {
  it("retains actual before and after content independently of subsequent edits", async function () {
    const note = {
      id: 17,
      libraryID: 1,
      key: "NOTE0001",
      getNoteTitle: () => "Research",
      getNote: () => "<p>After</p>",
    };
    const noteChange = await captureNoteChange(
      note as never,
      "<p>Before</p>",
      42,
    );
    note.getNote = () => "<p>Unrelated later edit</p>";
    const cards = buildNoteChangeResultCards({
      status: "updated",
      actionId: "action-exact",
      noteChange,
    });
    assert.lengthOf(cards!, 1);
    const card = cards![0];
    assert.equal(card.actionId, "action-exact");
    assert.equal(await readRecoveryText(card.before), "<p>Before</p>");
    assert.equal(await readRecoveryText(card.after), "<p>After</p>");
  });
  it("does not invent an applied card without a durable journal identity", async function () {
    const noteChange = await captureNoteChange(
      { id: 17, libraryID: 1, key: "NOTE0001", getNote: () => "same" } as never,
      "same",
      42,
    );
    assert.isNull(
      buildNoteChangeResultCards({ status: "updated", noteChange }),
    );
    assert.equal(
      buildNoteChangeResultCards({
        status: "updated",
        actionId: "exact",
        noteChange,
      })![0].state,
      "no_op",
    );
  });
  it("reports failed writes with exact journal identity and observed native state", async function () {
    const note = {
      id: 17,
      libraryID: 1,
      key: "NOTE0001",
      getNote: () => "<p>Partial native content</p>",
      reload: async () => undefined,
    };
    const failure = Object.assign(new Error("Native verification failed"), {
      journalActionId: "failed-exact",
    });
    const result = await failedNoteChange(
      failure,
      note as never,
      "<p>Before</p>",
      42,
    );
    const [card] = buildNoteChangeResultCards(result)!;
    assert.equal(card.state, "mismatch");
    assert.equal(card.actionId, "failed-exact");
    assert.equal(
      await readRecoveryText(card.after),
      "<p>Partial native content</p>",
    );
    assert.include(card.description, "verification failed");
  });
});
