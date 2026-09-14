import { assert } from "chai";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import { actionFixture, classifiedFixture } from "./helpers/semanticIntent";

describe("semantic note editing contracts", function () {
  const service = new ActionContractService({
    getItem: (id: number) => ({ id, libraryID: 1, isNote: () => id === 3975 }),
  } as never);
  for (const userText of [
    "help me rewrite this sentence",
    "Please shorten this paragraph",
    "请帮我润色这句话",
  ]) {
    it(`binds the semantic target before an edit: ${userText}`, async function () {
      const request = resolvedAgentRequest({
        conversationKey: 1,
        mode: "agent",
        libraryID: 1,
        userText,
        activeNoteContext: {
          noteId: 3975,
          title: "Note",
          noteKind: "standalone",
          noteText: "Selected sentence.",
        },
        classifiedIntent: actionFixture("note_edit", { targetNoteId: 3975 }),
      });
      const contract = await service.createContract(request);
      assert.equal(contract.obligations[0].parameters?.targetNoteId, 3975);
      assert.equal(contract.obligations[0].operation, "note_edit");
    });
  }
  it("does not turn explanation into an edit because a note is open", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 1,
      mode: "agent",
      libraryID: 1,
      userText: "Do not edit this note. Explain the sentence.",
      activeNoteContext: {
        noteId: 3975,
        title: "Note",
        noteKind: "standalone",
        noteText: "Selected sentence.",
      },
      classifiedIntent: classifiedFixture(),
    });
    const contract = await service.createContract(request);
    assert.isEmpty(contract.obligations);
  });
});
