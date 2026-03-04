import { assert } from "chai";
import { executeWriteNoteCall } from "../src/modules/contextPanel/Agent/Tools/writeNote";
import { pendingNoteProposals } from "../src/modules/contextPanel/state";
import type { PaperContextRef } from "../src/modules/contextPanel/types";

describe("writeNote", function () {
  const paperContext: PaperContextRef = {
    itemId: 11,
    contextItemId: 111,
    title: "Test Paper",
  };

  beforeEach(function () {
    pendingNoteProposals.clear();
  });

  it("uses previous assistant answer when user asks to write previous answer into note", async function () {
    const result = await executeWriteNoteCall(
      {
        question: "please write the previous answer into my note",
        previousAssistantAnswerText: "This is the prior assistant answer.",
        libraryID: 1,
        panelItemId: 99,
        conversationMode: "paper",
        activePaperContext: null,
        selectedPaperContexts: [],
        pinnedPaperContexts: [],
        recentPaperContexts: [],
        retrievedPaperContexts: [],
      },
      {
        name: "write_note",
        target: { scope: "active-paper" },
        query: "write the previous answer",
      },
      {
        paperContext,
        contextItem: null,
        targetLabel: "active-paper",
      },
    );

    assert.isTrue(result.ok);
    const proposal = pendingNoteProposals.get(99);
    assert.isOk(proposal);
    assert.equal(
      proposal?.content,
      "This is the prior assistant answer.",
    );
  });

  it("returns an error when previous-answer request has no assistant answer", async function () {
    const result = await executeWriteNoteCall(
      {
        question: "write the previous answer into note",
        previousAssistantAnswerText: "",
        libraryID: 1,
        panelItemId: 99,
        conversationMode: "paper",
        activePaperContext: null,
        selectedPaperContexts: [],
        pinnedPaperContexts: [],
        recentPaperContexts: [],
        retrievedPaperContexts: [],
      },
      {
        name: "write_note",
        target: { scope: "active-paper" },
        query: "write the previous answer",
      },
      {
        paperContext,
        contextItem: null,
        targetLabel: "active-paper",
      },
    );

    assert.isFalse(result.ok);
    assert.include(result.traceLines[0] || "", "No previous assistant answer");
  });
});
