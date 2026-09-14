import { decodeActionContract } from "../src/agent/plans/contracts";
import { assert } from "chai";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { assertMaterialReady } from "../src/agent/documents/workflowMaterial";
import { actionFixture } from "./helpers/semanticIntent";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

function setup(
  resolve: (input: any) => Promise<any>,
  overrides: Record<string, unknown> = {},
) {
  const items = [17, 18, 99].map((id) => ({
    id,
    libraryID: 1,
    key: `KEY${id}`,
    isRegularItem: () => true,
    getField: (field: string) =>
      field === "title" ? `Paper ${id}` : "Evidence",
  }));
  const gateway = {
    listCollectionSummaries: () => [
      { libraryID: 1, collectionId: 7, name: "Source", path: "Source" },
    ],
    listCurrentCollectionTargetIds: () => [17, 18],
    listCurrentLibraryTargetIds: () => [17, 18, 99],
    getItem: (id: number) => items.find((item) => item.id === id),
  };
  const intent = actionFixture("apply_tags", { tags: ["reviewed"] });
  intent.actionIntents[0] = {
    ...intent.actionIntents[0],
    coverage: "all",
    discovery: {
      description: "papers studying drift",
      source: "collection",
      collectionPath: "Source",
    },
  };
  const request = resolvedAgentRequest({
    conversationKey: 1,
    mode: "agent",
    libraryID: 1,
    userText: "Tag drift papers in Source",
    classifiedIntent: intent,
    ...overrides,
  });
  return {
    request,
    gateway,
    service: new ActionContractService(gateway as never, { resolve }),
  };
}

describe("semantic reference discovery", function () {
  it("does not send native metadata to semantic discovery when egress is prohibited", async function () {
    let calls = 0;
    const { request, service } = setup(async () => {
      calls++;
      return { state: "resolved", ids: [17], reason: "metadata" };
    });
    request.classifiedIntent!.semantic!.constraints = [
      {
        kind: "deny_effects",
        domains: ["network"],
        effects: ["egress"],
        description: "Keep library evidence local",
      },
    ];
    try {
      await service.createContract(request);
      assert.fail("must keep evidence local");
    } catch (error) {
      assert.include(String(error), "Keep library evidence local");
    }
    assert.equal(calls, 0);
  });
  it("yolo still refuses a discovery read the user's own prohibition blocks", async function () {
    let calls = 0;
    const { request, service } = setup(async () => {
      calls++;
      return { state: "resolved", ids: [17], reason: "metadata" };
    });
    request.classifiedIntent!.semantic!.constraints = [
      {
        kind: "deny_effects",
        domains: ["network"],
        effects: ["egress"],
        description: "Keep library evidence local",
      },
    ];
    let contract: unknown;
    try {
      contract = await service.createContract(request, { mode: "yolo" });
    } catch (error) {
      assert.include(String(error), "Keep library evidence local");
      assert.equal(calls, 0);
      return;
    }
    assert.fail(
      `a hard constraint is not ambiguity the agent may assume away: ${JSON.stringify(
        (contract as { assumptions?: string[] }).assumptions || [],
      )}`,
    );
  });
  it("freezes the source boundary before selecting descriptive targets", async function () {
    let candidates: number[] = [];
    const { request, service } = setup(async (input) => {
      candidates = input.candidates.map((entry: any) => entry.id);
      return { state: "resolved", ids: [17], reason: "native metadata" };
    });
    const contract = await service.createContract(request);
    assert.deepEqual(candidates, [17, 18]);
    assert.deepEqual(
      contract.obligations[0].targetBoundary?.frozenTargetIds,
      [17],
    );
    assert.equal(
      contract.intent?.actionIntents[0].discovery?.description,
      "papers studying drift",
    );
    const restored = decodeActionContract(JSON.parse(JSON.stringify(contract)));
    assert.deepEqual(
      restored.obligations[0].targetSelectors,
      contract.obligations[0].targetSelectors,
    );
    assert.deepEqual(
      restored.obligations[0].discovery,
      contract.obligations[0].discovery,
    );
  });
  it("rejects a semantic target outside the frozen source", async function () {
    const { request, service } = setup(async () => ({
      state: "resolved",
      ids: [99],
      reason: "provider guessed",
    }));
    try {
      await service.createContract(request);
      assert.fail("must reject an out-of-source target");
    } catch (error) {
      assert.include(String(error), "outside the frozen source");
    }
  });
  it("preserves missing-reference questions without manufacturing a target", async function () {
    const { request, service } = setup(async () => ({
      state: "needs_input",
      question: "Does drift mean neural or behavioral drift?",
    }));
    try {
      await service.createContract(request);
      assert.fail("must remain unresolved");
    } catch (error) {
      assert.include(String(error), "neural or behavioral");
    }
  });
  it("yolo records an unresolved reference as an assumption instead of asking", async function () {
    const { request, service } = setup(async () => ({
      state: "needs_input",
      question: "Does drift mean neural or behavioral drift?",
    }));
    const contract = await service.createContract(request, { mode: "yolo" });
    assert.lengthOf(contract.obligations, 0);
    assert.isArray(contract.assumptions);
    assert.match(contract.assumptions![0], /neural or behavioral/);
    assert.match(contract.assumptions![0], /agent will choose/i);
    // A dropped action must stay visible to end-of-turn evaluation, or an
    // empty contract reports bare success for work that never happened.
    assert.deepEqual(contract.skippedActions, [
      { actionIndex: 0, operation: "apply_tags" },
    ]);
    // It also has to survive the checkpoint round trip, or a resumed turn
    // forgets that the action was never performed.
    assert.deepEqual(
      decodeActionContract(JSON.parse(JSON.stringify(contract))).skippedActions,
      contract.skippedActions,
    );
  });
  it("yolo detaches a skipped action from the frozen material outputs", async function () {
    const { request, gateway, service } = setup(
      async () => ({
        state: "needs_input",
        question: "Does drift mean neural or behavioral drift?",
      }),
      {
        activeItemId: 17,
        activePaperContext: {
          itemId: 17,
          contextItemId: 17,
          title: "Paper 17",
          libraryID: 1,
        },
      },
    );
    request.classifiedIntent!.semantic!.materialOutputs = [
      {
        id: "summary",
        description: "Summarize",
        afterActions: [0],
        sourceActionIndexes: [0],
        requiredEvidence: "body",
      },
    ];
    request.documentReadObservations = [
      {
        issuer: "zotero_host",
        libraryID: 1,
        itemKey: "KEY17",
        capabilities: ["body"],
      },
    ] as never;
    const contract = await service.createContract(request, { mode: "yolo" });
    assert.lengthOf(contract.obligations, 0);
    assert.deepEqual(contract.skippedActions, [
      { actionIndex: 0, operation: "apply_tags" },
    ]);
    const frozen = contract.intent!.semantic!.materialOutputs![0];
    assert.deepEqual(frozen.sourceActionIndexes, []);
    assert.deepEqual(frozen.afterActions, []);
    assert.isTrue(
      contract.assumptions!.some((line) => line.includes("summary")),
      `assumptions must name the detached output: ${JSON.stringify(contract.assumptions)}`,
    );
    // The request's own interpretation must not be rewritten by contract building.
    assert.deepEqual(
      request.classifiedIntent!.semantic!.materialOutputs![0]
        .sourceActionIndexes,
      [0],
    );
    assert.deepEqual(
      request.classifiedIntent!.semantic!.materialOutputs![0].afterActions,
      [0],
    );
    request.actionContract = contract;
    assert.doesNotThrow(() =>
      assertMaterialReady(request, frozen, gateway as never),
    );
  });
  it("yolo keeps obligation indexes aligned when an earlier action is skipped", async function () {
    const { request, service } = setup(async () => ({
      state: "needs_input",
      question: "Does drift mean neural or behavioral drift?",
    }));
    const first = request.classifiedIntent!.actionIntents[0];
    request.classifiedIntent!.actionIntents.push({
      ...first,
      discovery: undefined,
      dependsOn: [0],
      scope: {
        kind: "collection",
        referenceKind: "literal",
        path: "Source",
        includeDescendants: false,
      },
    });
    const contract = await service.createContract(request, { mode: "yolo" });
    assert.isNotEmpty(contract.obligations);
    assert.deepEqual(contract.skippedActions, [
      { actionIndex: 0, operation: "apply_tags" },
    ]);
    for (const obligation of contract.obligations) {
      assert.equal(obligation.sourceActionIndex, 1);
      assert.isUndefined(obligation.dependsOn);
    }
    assert.isTrue(
      contract.assumptions!.some((line) =>
        line.includes("neural or behavioral"),
      ),
      `assumptions must record the unresolved action: ${JSON.stringify(contract.assumptions)}`,
    );
    for (const mode of ["safe", "auto"] as const) {
      try {
        await service.createContract(request, { mode });
        assert.fail("must still ask outside yolo");
      } catch (error) {
        assert.include(String(error), "neural or behavioral");
      }
    }
  });
  it("yolo carries interpreter questions as assumptions", async function () {
    const { request, service } = setup(async () => ({
      state: "resolved",
      ids: [17],
      reason: "metadata",
    }));
    request.classifiedIntent!.semantic!.questions = ["Append or replace?"];
    request.classifiedIntent!.semantic!.assumptions = ["Assumed append."];
    const contract = await service.createContract(request, { mode: "yolo" });
    assert.lengthOf(contract.obligations, 1);
    assert.isUndefined(contract.skippedActions);
    assert.deepEqual(contract.assumptions, [
      "Assumed append.",
      "Unresolved: Append or replace? The agent decides.",
    ]);
    for (const mode of ["safe", "auto"] as const) {
      try {
        await service.createContract(request, { mode });
        assert.fail("must still ask outside yolo");
      } catch (error) {
        assert.include(String(error), "Append or replace?");
      }
    }
  });
});

describe("semantic integration", function () {
  it("does not turn an unresolved literal collection name into a fuzzy destination", async function () {
    let called = false;
    const intent = actionFixture("move_to_collection");
    intent.actionIntents[0].scope = {
      kind: "collection",
      path: "shared-token",
      includeDescendants: false,
    };
    intent.actionIntents[0].scopeRole = "destination";
    const request = resolvedAgentRequest({
      conversationKey: 1,
      mode: "agent",
      libraryID: 1,
      activeItemId: 17,
      userText: "File this paper in destination shared-token",
      classifiedIntent: intent,
    });
    const service = new ActionContractService(
      {
        getItem: () => ({
          id: 17,
          libraryID: 1,
          isRegularItem: () => true,
          getField: () => "Paper",
        }),
        listCollectionSummaries: () => [
          {
            collectionId: 7,
            libraryID: 1,
            name: "Parent shared-token",
            path: "Parent shared-token",
          },
          {
            collectionId: 8,
            libraryID: 1,
            name: "destination shared-token",
            path: "Parent shared-token / destination shared-token",
          },
        ],
      } as never,
      {
        resolve: async () => {
          called = true;
          return { state: "resolved", ids: [7], reason: "guessed parent" };
        },
      },
    );
    try {
      await service.createContract(request);
      assert.fail("Literal reference must remain unresolved");
    } catch (error) {
      assert.include(String(error), "was not found");
    }
    assert.isTrue(called);
  });

  it("recovers a truncated literal reference only with an exact native name quoted from the request", async function () {
    let called = false;
    const intent = actionFixture("move_to_collection");
    intent.actionIntents[0].scope = {
      kind: "collection",
      path: "shared-token",
      includeDescendants: false,
    };
    intent.actionIntents[0].scopeRole = "destination";
    const request = resolvedAgentRequest({
      conversationKey: 1,
      mode: "agent",
      libraryID: 1,
      activeItemId: 17,
      userText: "File this paper in destination shared-token",
      classifiedIntent: intent,
    });
    const service = new ActionContractService(
      {
        getItem: () => ({
          id: 17,
          libraryID: 1,
          isRegularItem: () => true,
          getField: () => "Paper",
        }),
        listCollectionSummaries: () => [
          {
            collectionId: 7,
            libraryID: 1,
            name: "Parent shared-token",
            path: "Parent shared-token",
          },
          {
            collectionId: 8,
            libraryID: 1,
            name: "destination shared-token",
            path: "Parent shared-token / destination shared-token",
          },
        ],
      } as never,
      {
        resolve: async () => {
          called = true;
          return {
            state: "resolved",
            ids: [8],
            reason: "native name occurs in the user request",
            literalEvidence: [{ id: 8, quote: "destination shared-token" }],
          };
        },
      },
    );
    const contract = await service.createContract(request);
    assert.equal(
      contract.obligations[0].parameters?.destinationCollectionId,
      8,
    );
    assert.isUndefined(contract.obligations[0].parameters?.sourceCollectionId);
    assert.isTrue(called);
  });

  it("resolves a descriptive destination only within the applicable library catalog", async function () {
    const collections = [
      { collectionId: 5, libraryID: 1, name: "Bayesian", path: "Bayesian" },
    ];
    const paper = {
      id: 3977,
      libraryID: 1,
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
      getField: () => "Paper",
    };
    const gateway = {
      listCollectionSummaries: () => collections,
      getCollectionSummary: (id: number) =>
        collections.find((c) => c.collectionId === id),
      getItem: () => paper,
    };
    const service = new ActionContractService(
      gateway as never,
      {
        resolve: async (input) => {
          assert.equal(input.entity, "collection");
          assert.equal(input.description, "the folder for Bayesian methods");
          assert.deepEqual(
            input.candidates.map((c) => c.id),
            [5],
          );
          return {
            state: "resolved",
            ids: [5],
            reason: "Folder refers to the existing collection",
          };
        },
      } as any,
    );
    const request = resolvedAgentRequest({
      conversationKey: 1,
      mode: "agent",
      libraryID: 1,
      conversationKind: "paper",
      activeItemId: 3977,
      activePaperContext: {
        itemId: 3977,
        contextItemId: 3977,
        title: "Paper",
        libraryID: 1,
      },
      userText: "move this paper to Bayesian folder",
      classifiedIntent: actionFixture("move_to_collection", {}),
    });
    request.classifiedIntent!.actionIntents[0].scope = {
      kind: "collection",
      referenceKind: "descriptive",
      path: "the folder for Bayesian methods",
      includeDescendants: false,
    };
    request.classifiedIntent!.actionIntents[0].scopeRole = "destination";
    const contract = await service.createContract(request);
    assert.equal(
      contract.obligations[0].parameters?.destinationCollectionId,
      5,
    );
    assert.isUndefined(contract.obligations[0].parameters?.sourceCollectionId);
  });
});
