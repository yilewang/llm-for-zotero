import { planStepObligationIds } from "../src/agent/plans/workflowBindings";
import { assert } from "chai";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import {
  actionFixture,
  classifiedFixture,
  semanticFixture,
} from "./helpers/semanticIntent";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import { ActionContractService } from "../src/agent/contracts/actionContract";

function workflow() {
  const collections = new Map([
    [1, { collectionId: 1, libraryID: 1, name: "Source", path: "Source" }],
    [7, { collectionId: 7, libraryID: 1, name: "Learning", path: "Learning" }],
  ]);
  const gateway = {
    getItem: (id: number) => ({
      id,
      libraryID: 1,
      deleted: false,
      isRegularItem: () => true,
      isNote: () => false,
      isAttachment: () => false,
      getField: () => `Paper ${id}`,
      getCollections: () => [1],
    }),
    getCollectionSummary: (id: number) => collections.get(id) || null,
    listCollectionSummaries: () => [...collections.values()],
    getCollectionNativeState: (id: number) => ({
      exists: collections.has(id),
      deleted: false,
      name: collections.get(id)?.name,
      parentCollectionId: null,
    }),
    listCurrentCollectionTargetIds: () => [],
  };
  const move = actionFixture("move_to_collection", {
    sourceCollectionId: 1,
    destinationCollectionId: 7,
  }).actionIntents[0];
  move.constraints = { collectionMode: "move" };
  const save = {
    ...actionFixture("note_create", { noteMode: "create", targetItemId: 42 })
      .actionIntents[0],
    dependsOn: [0],
    contentFrom: "summary",
  };
  const request = resolvedAgentRequest({
    conversationKey: 42,
    mode: "agent",
    libraryID: 1,
    activeItemId: 42,
    userText: "Move this paper, summarize and attach the summary",
    classifiedIntent: classifiedFixture({
      writeDisposition: "required",
      retrievalIntent: "summarize",
      actionIntents: [move, save],
      semantic: semanticFixture({
        materialOutputs: [
          {
            id: "summary",
            description: "Summarize the paper",
            afterActions: [0],
            sourceActionIndexes: [0],
            requiredEvidence: "body",
          },
        ],
      }),
    }),
  });
  const service = new ActionContractService(gateway as never);
  const registry = createBuiltInToolRegistry({
    zoteroGateway: gateway as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
  const ready = async () => {
    request.actionContract = await service.createContract(request);
    request.actionProgress = service.createProgress(request.actionContract);
    request.actionPreparation = { state: "ready", issues: [] };
  };
  return { request, service, registry, collections, ready };
}

describe("shared workflow step selection", function () {
  it("advances move, generation, and exact-document save from the same durable ledger", async function () {
    const { request, registry, ready } = workflow();
    await ready();
    const move = await registry.getNextWorkflowStep(request);
    assert.equal(move.kind, "action");
    if (move.kind !== "action") return;
    assert.equal(move.prepared.call.name, "library_update");
    request.actionProgress!.obligations[0].status = "fulfilled";
    assert.equal((await registry.getNextWorkflowStep(request)).kind, "model");
    request.actionProgress!.materialOutputs = [
      {
        outputId: "summary",
        documentId: "document:exact",
        documentVersion: 2,
        contentHash: "sha256:exact",
      },
    ];
    const save = await registry.getNextWorkflowStep(request);
    assert.equal(save.kind, "action");
    if (save.kind !== "action") return;
    assert.deepEqual(save.prepared.call.arguments, {
      mode: "create",
      targetItemId: 42,
      documentId: "document:exact",
    });
    request.actionProgress!.obligations[1].status = "fulfilled";
    assert.equal(
      (await registry.getNextWorkflowStep(request)).kind,
      "complete",
    );
  });
  it("honors active Plan task ownership and never dispatches during planning", async function () {
    const { request, registry, ready } = workflow();
    await ready();
    assert.equal(
      (await registry.getNextWorkflowStep(request, [])).kind,
      "model",
    );
    assert.equal(
      (
        await registry.getNextWorkflowStep(request, [
          request.actionContract!.obligations[1].id,
        ])
      ).kind,
      "model",
    );
    assert.equal(
      (
        await registry.getNextWorkflowStep(request, [
          request.actionContract!.obligations[0].id,
        ])
      ).kind,
      "action",
    );
  });
  it("binds the destination only from verified creation identity and current native state", async function () {
    const { request, service, registry, collections } = workflow();
    request.classifiedIntent!.semantic!.materialOutputs = [];
    request.classifiedIntent!.actionIntents = [
      {
        ...actionFixture("create_collection", {
          collectionName: "New destination",
        }).actionIntents[0],
        targetKind: "collections",
      },
      {
        ...actionFixture("move_to_collection", {
          sourceCollectionId: 1,
          collectionName: "New destination",
        }).actionIntents[0],
        constraints: { collectionMode: "move" },
        dependsOn: [0],
      },
    ];
    request.actionContract = await service.createContract(request);
    request.actionProgress = service.createProgress(request.actionContract);
    request.actionPreparation = { state: "ready", issues: [] };
    const first = await registry.getNextWorkflowStep(request);
    assert.equal(first.kind, "action");
    if (first.kind !== "action") return;
    assert.equal(first.prepared.call.name, "collection_update");
    const progress = request.actionProgress.obligations[0];
    progress.status = "fulfilled";
    progress.verifiedTargetIds = ["collection:91"];
    assert.equal(
      (await registry.getNextWorkflowStep(request)).kind,
      "model",
      "unavailable native identity is never guessed",
    );
    collections.set(91, {
      collectionId: 91,
      libraryID: 1,
      name: "New destination",
      path: "New destination",
    });
    const next = await registry.getNextWorkflowStep(request);
    assert.equal(next.kind, "action");
    if (next.kind !== "action") return;
    assert.equal((next.prepared.call.arguments as any).targetCollectionId, 91);
  });
  it("dispatches one native target at a time so each item can be checkpointed", async function () {
    const { request, registry, ready } = workflow();
    await ready();
    request.actionContract!.obligations[0].targetBoundary!.frozenTargetIds = [
      42, 43,
    ];
    const next = await registry.getNextWorkflowStep(request);
    assert.equal(next.kind, "action");
    if (next.kind !== "action") return;
    assert.deepEqual((next.prepared.call.arguments as any).itemIds, [42]);
    request.actionProgress!.obligations[0].verifiedTargetIds = ["item:42"];
    const following = await registry.getNextWorkflowStep(request);
    assert.equal(following.kind, "action");
    if (following.kind !== "action") return;
    assert.notEqual(
      following.prepared.call.id,
      next.prepared.call.id,
      "Each native item needs a distinct trace identity",
    );
  });
  it("resumes a partially completed batch with only its unfinished native targets", async function () {
    const { request, registry, ready } = workflow();
    await ready();
    const boundary = request.actionContract!.obligations[0].targetBoundary!;
    boundary.frozenTargetIds = [42, 43, 44];
    request.actionProgress!.obligations[0].status = "partially_fulfilled";
    request.actionProgress!.obligations[0].verifiedTargetIds = [
      "item:42",
      "item:43",
    ];
    const next = await registry.getNextWorkflowStep(request);
    assert.equal(next.kind, "action");
    if (next.kind !== "action") return;
    assert.deepEqual((next.prepared.call.arguments as any).itemIds, [44]);
  });
});

describe("Plan workflow step ownership", function () {
  it("keeps an unbound reading step from executing the later move or note save", async function () {
    const { request, registry, ready } = workflow();
    await ready();
    const read = { expectedEffect: "read" } as never;
    const summary = {
      expectedEffect: "artifact",
      materialOutputId: "summary",
    } as never;
    const move = { expectedEffect: "mutation", actionIndexes: [0] } as never;
    const save = { expectedEffect: "mutation", actionIndexes: [1] } as never;
    const readIds = planStepObligationIds(read, request.actionContract);
    assert.deepEqual(readIds, []);
    assert.deepEqual(
      planStepObligationIds(summary, request.actionContract),
      [],
    );
    assert.equal(
      (await registry.getNextWorkflowStep(request, readIds)).kind,
      "model",
    );
    assert.deepEqual(planStepObligationIds(move, request.actionContract), [
      request.actionContract!.obligations[0].id,
    ]);
    assert.deepEqual(planStepObligationIds(save, request.actionContract), [
      request.actionContract!.obligations[1].id,
    ]);
  });
});
