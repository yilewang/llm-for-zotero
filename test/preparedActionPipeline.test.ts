import { createBuiltInToolRegistry } from "../src/agent/tools";
import { actionContractFixture } from "./helpers/semanticIntent";
import { createRequestUserInputTool } from "../src/agent/tools/plan/requestUserInput";
import { assert } from "chai";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import { actionFixture } from "./helpers/semanticIntent";

function scenario(memberships = [1], quote = "Learning") {
  const collections = [
    { collectionId: 1, libraryID: 1, name: "Geometry", path: "Geometry" },
    { collectionId: 7, libraryID: 1, name: "Learning", path: "Learning" },
    { collectionId: 8, libraryID: 1, name: "Other", path: "Other" },
  ];
  const item = {
    id: 2317,
    libraryID: 1,
    isRegularItem: () => true,
    getField: () => "Representational geometry",
    getCollections: () => memberships,
  };
  const gateway = {
    getItem: () => item,
    getCollectionSummary: (id: number) =>
      collections.find((c) => c.collectionId === id) || null,
    listCollectionSummaries: () => collections,
    listCurrentCollectionTargetIds: ({
      collectionId,
    }: {
      collectionId: number;
    }) => (memberships.includes(collectionId) ? [2317] : []),
  };
  const classifiedIntent = actionFixture("move_to_collection");
  classifiedIntent.actionIntents[0] = {
    ...classifiedIntent.actionIntents[0],
    coverage: "one",
    scopeRole: "destination",
    scope: {
      kind: "collection",
      path: "learning folder",
      includeDescendants: false,
    },
    constraints: { collectionMode: "move" },
  };
  const request = resolvedAgentRequest({
    conversationKey: 2317,
    mode: "agent",
    libraryID: 1,
    activeItemId: 2317,
    userText: "move this paper to learning folder",
    classifiedIntent,
  });
  const service = new ActionContractService(gateway as never, {
    resolve: async () => ({
      state: "resolved",
      ids: [7],
      reason: "The named Learning collection; folder is its resource type",
      literalEvidence: [{ id: 7, quote }],
    }),
  });
  return { request, service };
}

describe("ordinary natural-language action preparation", function () {
  it("resolves the ordinary destination wording and binds the sole native source before execution", async function () {
    const { request, service } = scenario();
    const contract = await service.createContract(request);
    assert.deepInclude(contract.obligations[0].parameters, {
      sourceCollectionId: 1,
      destinationCollectionId: 7,
    });
    assert.equal(contract.obligations[0].constraints?.collectionMode, "move");
    assert.deepEqual(
      contract.obligations[0].targetBoundary?.frozenTargetIds,
      [2317],
    );
  });
  it("does not silently downgrade a move when multiple source memberships need a decision", async function () {
    const { request, service } = scenario([1, 8], "learning");
    try {
      await service.createContract(request);
      assert.fail("ambiguous source must remain unresolved");
    } catch (error) {
      assert.include(String(error), "source collection");
    }
  });
  it("uses a named active source while preserving unrelated memberships", async function () {
    const { request, service } = scenario([1, 8], "learning");
    request.scopeType = "folder";
    request.scopeId = 1;
    const contract = await service.createContract(request);
    assert.equal(contract.obligations[0].parameters?.sourceCollectionId, 1);
  });
  it("keeps an explicitly additive action additive", async function () {
    const { request, service } = scenario([1, 8], "learning");
    request.classifiedIntent!.actionIntents[0].constraints = undefined;
    const contract = await service.createContract(request);
    assert.isUndefined(contract.obligations[0].parameters?.sourceCollectionId);
  });
});

describe("bound action dispatch", function () {
  it("builds the executable call from the complete obligation without model-supplied parameters", async function () {
    const { AgentToolRegistry } = await import("../src/agent/tools/registry");
    const { registerPreparedLibraryActions } =
      await import("../src/agent/tools/preparedLibraryActions");
    const { request, service } = scenario();
    request.actionContract = await service.createContract(request);
    request.actionPreparation = { state: "ready", issues: [] };
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "library_update",
        description: "write",
        executionClass: "external_effect",
        inputSchema: { type: "object" },
      },
      validate: (args) => ({ ok: true, value: args }),
      execute: async () => undefined,
    });
    registerPreparedLibraryActions(registry, {
      getItem: () => ({ getField: () => "Representational geometry" }),
      getCollectionSummary: (id: number) => ({
        name: id === 1 ? "Geometry" : "Learning",
      }),
    } as never);
    const next = await registry.getNextWorkflowStep(request);
    const calls = next.kind === "action" ? [next.prepared] : null;
    assert.lengthOf(calls!, 1);
    assert.deepEqual(calls![0].call.arguments, {
      kind: "collections",
      action: "add",
      itemIds: [2317],
      targetCollectionId: 7,
      mode: "move",
      from: 1,
    });
    assert.include(calls![0].summary, "Geometry");
    assert.include(calls![0].summary, "Learning");
    assert.include(calls![0].summary, "Moved");
  });
});

describe("native source selection", function () {
  it("fills only the missing source and cannot reinterpret the move or alter frozen paper identity", async function () {
    const { request, service } = scenario([1, 8]);
    try {
      await service.createContract(request);
      assert.fail("source must be unresolved");
    } catch (error) {
      const issue =
        error as import("../src/agent/contracts/actionScope").ActionReferenceResolutionError;
      request.actionPreparation = {
        state: "needs_input",
        issues: [issue.message],
        sourceSelection: issue.sourceSelection,
      };
    }
    assert.lengthOf(request.actionPreparation!.sourceSelection!.candidates, 2);
    const tool = createRequestUserInputTool(
      (r) => service.createContract(r),
      async () => {
        throw new Error("A native selection must not reinterpret the request");
      },
    );
    const context = {
      request,
      currentAnswerText: "",
      modelName: "test",
      item: null,
    };
    const input = tool.validate({
      questions: [
        {
          id: "reference",
          question: "Forged model question",
          options: [
            { id: "source:1", label: "Delete everything" },
            { id: "source:8", label: "Other" },
          ],
        },
      ],
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    const card = await tool.createPendingAction!(input.value, context);
    assert.equal(card.fields[0].type, "choice");
    if (card.fields[0].type === "choice")
      assert.equal(card.fields[0].options[0].label, "Geometry");
    const answer = tool.applyConfirmation!(
      input.value,
      { reference: { kind: "option", optionId: "source:1" } },
      context,
    );
    assert.isTrue(answer.ok);
    if (!answer.ok) return;
    await tool.execute(answer.value, context);
    assert.equal(request.actionPreparation?.state, "ready");
    assert.deepInclude(request.actionContract!.obligations[0].parameters, {
      sourceCollectionId: 1,
      destinationCollectionId: 7,
    });
    assert.deepEqual(
      request.actionContract!.obligations[0].targetBoundary?.frozenTargetIds,
      [2317],
    );
    assert.equal(
      request.actionContract!.obligations[0].constraints?.collectionMode,
      "move",
    );
    assert.notInclude(
      request.clarificationHistory![0].answer,
      "Delete everything",
    );
  });
});

describe("prepared bindings use the existing public tool contracts", function () {
  const examples: Array<
    [
      import("../src/agent/types").AgentActionOperation,
      import("../src/agent/types").AgentActionParameters,
    ]
  > = [
    [
      "move_to_collection",
      { sourceCollectionId: 1, destinationCollectionId: 7 },
    ],
    ["apply_tags", { tags: ["reading"] }],
    ["remove_tags", { tags: ["reading"] }],
    ["set_item_tags", { tags: [] }],
    [
      "update_metadata",
      { metadataValues: { title: "New title" }, metadataFields: ["title"] },
    ],
    ["remove_from_collection", { sourceCollectionId: 1 }],
    [
      "create_collection",
      { collectionName: "New folder", parentCollectionId: null },
    ],
    [
      "delete_collection",
      { collectionId: 7, deleteItems: false, permanent: false },
    ],
    ["update_collection", { collectionId: 7, collectionName: "New name" }],
    [
      "update_collection",
      { collectionId: 7, collectionName: "New name", parentCollectionId: 1 },
    ],
    ["update_collection", { collectionId: 7, parentCollectionId: null }],
  ];
  for (const [operation, parameters] of examples)
    it(`${operation}: ${JSON.stringify(parameters)}`, async function () {
      const gateway = {
        getItem: () => ({
          id: 2317,
          libraryID: 1,
          getField: () => "Paper",
          isRegularItem: () => true,
        }),
        getCollectionSummary: (id: number) => ({
          collectionId: id,
          libraryID: 1,
          name: "Collection",
        }),
      };
      const registry = createBuiltInToolRegistry({
        zoteroGateway: gateway as never,
        pdfService: {} as never,
        pdfPageService: {} as never,
        retrievalService: {} as never,
      });
      const contract = actionContractFixture(operation, parameters);
      const obligation = contract.obligations[0];
      if (
        ![
          "create_collection",
          "delete_collection",
          "update_collection",
        ].includes(operation)
      )
        obligation.targetBoundary = {
          kind: "selection",
          libraryID: 1,
          frozenTargetIds: [2317],
          scopeDigest: "test",
        };
      const request = resolvedAgentRequest({
        conversationKey: 2317,
        mode: "agent",
        libraryID: 1,
        userText: "Declared semantic fixture",
        classifiedIntent: contract.intent,
        actionContract: contract,
        actionPreparation: { state: "ready", issues: [] },
      });
      const next = await registry.getNextWorkflowStep(request);
      const calls = next.kind === "action" ? [next.prepared] : null;
      assert.lengthOf(calls!, 1);
      const tool = registry.getTool(calls![0].call.name)!;
      const input = tool.validate(calls![0].call.arguments);
      assert.isTrue(input.ok);
      if (!input.ok) return;
      const service = new ActionContractService(gateway as never);
      const prepared = await service.prepare(tool, input.value, {
        request,
        item: null,
        currentAnswerText: "",
        modelName: "test",
      });
      assert.isNull(await service.validateScope(contract, prepared));
    });
});
