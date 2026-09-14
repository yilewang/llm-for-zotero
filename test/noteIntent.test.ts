import { assert } from "chai";
import { requestsNoteAction } from "../src/agent/skills/noteIntent";
import { resolveSkillRouting } from "../src/agent/skills/routing";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import { actionFixture, classifiedFixture } from "./helpers/semanticIntent";

describe("semantic note intent and skill routing", function () {
  it("has no note action when semantic interpretation is unavailable", function () {
    assert.isFalse(requestsNoteAction({}));
  });
  for (const userText of [
    "write a reading note for this paper",
    "为这篇论文写阅读笔记",
    "この論文のノートを作成してください",
    "Décris cette figure",
  ]) {
    it(`consumes the typed note action independently of wording: ${userText}`, function () {
      assert.isTrue(
        requestsNoteAction({ classifiedIntent: actionFixture("note_create") }),
      );
      const request = resolvedAgentRequest({
        conversationKey: 1,
        mode: "agent",
        libraryID: 1,
        userText,
        classifiedIntent: classifiedFixture(),
      });
      assert.isFalse(requestsNoteAction(request));
      const routing = resolveSkillRouting(request, [
        {
          id: "write-note",
          description: "Create notes",
          version: 1,

          contexts: ["any"],
          activation: "auto",
          instruction: "Write",
          source: "system",
        },
      ]);
      assert.notInclude(routing.matchedSkillIds, "write-note");
    });
  }
});
