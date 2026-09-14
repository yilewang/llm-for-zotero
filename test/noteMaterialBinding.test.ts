import { ActionContractService } from "../src/agent/contracts/actionContract";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import { classifiedFixture } from "./helpers/semanticIntent";
import { assert } from "chai";
import { validWorkflowDependencies } from "../src/agent/contracts/workflowDependencies";
import { createEditCurrentNoteTool } from "../src/agent/tools/write/editCurrentNote";

describe("finalized material for existing notes", function () {
  it("freezes an existing note independently of the source-paper set", async function () {
    for (const explicit of ["parameter", "active", "selector", "both"]) {
      const request = resolvedAgentRequest({
        conversationKey: 3,
        mode: "agent",
        libraryID: 1,
        activeItemId: 3,
        userText: "Read the supplied paper and replace my note",
        activeNoteContext: { noteId: 3, title: "Note", noteKind: "item" },
        selectedPaperContexts: [
          { itemId: 1, contextItemId: 2, libraryID: 1, title: "Source" },
        ],
        classifiedIntent: classifiedFixture({
          paperTargetIntent: "added",
          writeDisposition: "required",
          actionIntents: [
            {
              operation: "note_edit",
              coverage: "one",
              targetKind: "items",
              parameters:
                explicit === "parameter" || explicit === "both"
                  ? { targetNoteId: 3, noteMode: "edit" }
                  : { noteMode: "edit" },
              ...(explicit === "selector" || explicit === "both"
                ? { targetSelectors: [{ kind: "item_id" as const, value: 3 }] }
                : {}),
            },
          ],
        }),
      });
      const service = new ActionContractService({
        getItem: (id: number) => ({
          id,
          libraryID: 1,
          isNote: () => id === 3,
          isRegularItem: () => id === 1,
        }),
        listCollectionSummaries: () => [],
      } as never);
      const contract = await service.createContract(request);
      assert.deepEqual(
        contract.obligations[0].targetBoundary?.frozenTargetIds,
        [3],
      );
    }
  });
  for (const mode of ["edit", "append"] as const) {
    it(`allows source-based finalized material to ${mode} the exact note`, function () {
      const actions = [
        {
          operation: `note_${mode}`,
          coverage: "one",
          targetKind: "items",
          contentFrom: "reading-note",
          parameters: { targetNoteId: 3, noteMode: mode },
        },
      ] as never;
      assert.isTrue(
        validWorkflowDependencies(actions, [
          {
            id: "reading-note",
            description: "Source-based reading note",
            afterActions: [],
            sourceActionIndexes: [],
            requiredEvidence: "body",
          },
        ]),
      );
      const tool = createEditCurrentNoteTool({} as never);
      assert.isTrue(
        tool.validate({
          mode,
          targetNoteId: 3,
          documentId: "finalized-reading-note",
        }).ok,
      );
      assert.isFalse(
        tool.validate({
          mode,
          targetNoteId: 3,
          documentId: "finalized-reading-note",
          content: "Substituted",
        }).ok,
      );
    });
  }
  it("rejects an edit depending on itself", function () {
    assert.isFalse(
      validWorkflowDependencies([
        {
          operation: "note_edit",
          coverage: "one",
          targetKind: "items",
          dependsOn: [0],
        },
      ] as never),
    );
  });
});
