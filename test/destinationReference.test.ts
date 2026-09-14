import { assert } from "chai";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { detectTurnIntent } from "../src/agent/model/semanticIntentService";
import {
  classifiedFixture,
  semanticResponseFixture,
} from "./helpers/semanticIntent";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
const actions: any[] = [
  {
    operation: "create_collection",
    capability: "zotero.collections",
    proofDomain: "zotero_state",
    coverage: "one",
    targetKind: "items",
    scopeRole: "source",
    parameters: { collectionName: "New destination", parentCollectionId: 6 },
  },
  {
    operation: "move_to_collection",
    capability: "zotero.collections",
    proofDomain: "zotero_state",
    coverage: "one",
    targetKind: "papers",
    scopeRole: "source",
    scope: { kind: "collection", path: "Source", includeDescendants: false },
    destinationFrom: 0,
    dependsOn: [0],
    constraints: { collectionMode: "move" },
  },
];
const collections = [
  { collectionId: 1, libraryID: 1, name: "Source", path: "Source" },
  { collectionId: 6, libraryID: 1, name: "Parent", path: "Parent" },
];
const request = () =>
  resolvedAgentRequest({
    conversationKey: 42,
    mode: "agent",
    libraryID: 1,
    activeItemId: 42,
    userText:
      "Create New destination under collection 6, then move this paper from Source into that new collection",
    model: "test",
    apiBase: "https://example.invalid",
    apiKey: "test",
    classifiedIntent: classifiedFixture({
      writeDisposition: "required",
      actionIntents: actions,
    }),
  });
describe("created destination references", function () {
  it("accepts a structured reference to the creation rather than inventing an ID", async function () {
    const result = await detectTurnIntent(request(), [], {
      llmCall: async () => ({
        text: JSON.stringify(
          semanticResponseFixture({
            actionIntents: actions,
            writeDisposition: "required",
            taskKind: "write",
          }),
        ),
        completion: { status: "complete" },
      }),
    });
    assert.isOk(result.classifiedIntent, JSON.stringify(result));
    assert.equal(
      (result.classifiedIntent!.actionIntents[1] as any).destinationFrom,
      0,
    );
  });
  it("binds the created destination while independently preserving the named source", async function () {
    const service = new ActionContractService({
      getItem: (id: number) => ({
        id,
        libraryID: 1,
        isRegularItem: () => true,
        isAttachment: () => false,
        isNote: () => false,
        getCollections: () => [1, 8],
      }),
      getCollectionSummary: (id: number) =>
        collections.find((c) => c.collectionId === id) || null,
      listCollectionSummaries: () => collections,
      listCurrentCollectionTargetIds: () => [42],
    } as any);
    const contract = await service.createContract(request());
    assert.equal(
      contract.obligations[1].destinationCreation?.obligationId,
      contract.obligations[0].id,
    );
    assert.equal(contract.obligations[1].parameters?.sourceCollectionId, 1);
  });
});
