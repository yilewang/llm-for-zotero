import { semanticResponseFixture } from "./helpers/semanticIntent";
import { assert } from "chai";
import { detectTurnIntent } from "../src/agent/model/semanticIntentService";
import { ActionContractService } from "../src/agent/contracts/actionContract";

const collection = {
  collectionId: 10,
  libraryID: 1,
  name: "Bayesian",
  path: "Bayesian",
};
const nativeItem = (id: number) => ({
  id,
  libraryID: 1,
  deleted: false,
  isRegularItem: () => true,
  isAttachment: () => false,
  isNote: () => false,
  isAnnotation: () => false,
  getField: () => `Paper ${id}`,
});
const gateway = {
  getCollectionSummary: (id: number) => (id === 10 ? collection : null),
  listCollectionSummaries: () => [collection],
  listCurrentCollectionTargetIds: () => [99],
  getItem: (id: number) => ([42, 99].includes(id) ? nativeItem(id) : null),
};
const skills = [
  {
    id: "qa",
    description: "Answer paper questions",
    version: 1,
    patterns: [],
    contexts: ["any"],
    activation: "auto",
    instruction: "",
    source: "system",
  },
];
const filing = {
  operation: "move_to_collection",
  coverage: "one",
  targetKind: "papers",
  scopeRole: "destination",
  scope: { kind: "collection", path: "Bayesian", includeDescendants: false },
};

async function interpret(userText: string, installedSkills = skills) {
  const request: any = {
    conversationKey: 1,
    mode: "agent",
    libraryID: 1,
    userText,
    activeItemId: 42,
    turnPaperScope: {
      libraryID: 1,
      conversationKind: "paper",
      papers: [
        {
          paper: {
            itemId: 42,
            contextItemId: 42,
            libraryID: 1,
            title: "Paper 42",
          },
          roles: ["active"],
        },
      ],
      collections: [],
      tags: [],
      selectedPassagePaperRefs: [],
    },
    model: "gpt-5.4",
    apiBase: "https://api.openai.com/v1",
    apiKey: "test-only",
    providerProtocol: "openai_chat_compat",
  };
  const actions = [
    filing,
    ...(userText.includes("summarize")
      ? [
          {
            operation: "note_create",
            coverage: "one",
            targetKind: "items",
            parameters: { noteMode: "create" },
          },
        ]
      : []),
  ];
  const result = await detectTurnIntent(request, installedSkills as any, {
    llmCall: async () => ({
      text: JSON.stringify(
        semanticResponseFixture({
          taskKind: "mixed",
          paperTargetIntent: "active",
          requestedScopes: ["single-paper"],
          writeDisposition: "required",
          actionIntents: actions,
        }),
      ),
      completion: { status: "complete" as const },
    }),
  });
  request.classifiedIntent = result.classifiedIntent;
  return {
    request,
    result,
    service: new ActionContractService(gateway as any),
  };
}

describe("Semantic request to frozen native action scope", function () {
  for (const [targetIntent, expected] of [
    ["added", [99]],
    ["all_visible", [42, 99]],
  ] as const) {
    it(`respects the ${targetIntent} paper set without expanding to the whole library`, async function () {
      const { request } = await interpret(
        "File the referenced papers in Bayesian",
      );
      request.classifiedIntent.paperTargetIntent = targetIntent;
      request.classifiedIntent.actionIntents[0].coverage = "all";
      request.turnPaperScope.papers.push({
        paper: { itemId: 99, contextItemId: 99, libraryID: 1 },
        roles: ["selected"],
      });
      const service = new ActionContractService({
        ...gateway,
        listCurrentLibraryTargetIds: () => [42, 99, 150],
      } as any);
      const contract = await service.createContract(request);
      assert.deepEqual(
        contract.obligations[0].targetBoundary?.frozenTargetIds,
        [...expected],
      );
    });
  }

  it("moves only the referenced current paper out of a named source containing other papers", async function () {
    const { request } = await interpret(
      "move this paper from Bayesian to Reading",
    );
    request.classifiedIntent.actionIntents = [
      {
        ...request.classifiedIntent.actionIntents[0],
        scopeRole: "source",
        parameters: { collectionName: "Reading" },
        constraints: { collectionMode: "move" },
      },
    ];
    const destination = {
      ...collection,
      collectionId: 11,
      name: "Reading",
      path: "Reading",
    };
    const host = new ActionContractService({
      ...gateway,
      listCollectionSummaries: () => [collection, destination],
      getCollectionSummary: (id: number) =>
        id === 10 ? collection : destination,
      listCurrentCollectionTargetIds: () => [42, 99],
    } as any);
    const contract = await host.createContract(request);
    assert.deepEqual(
      contract.obligations[0].targetBoundary?.frozenTargetIds,
      [42],
    );
    assert.equal(contract.obligations[0].parameters?.sourceCollectionId, 10);
    assert.equal(
      contract.obligations[0].parameters?.destinationCollectionId,
      11,
    );
  });
  for (const noun of ["folder", "collection"]) {
    it(`retains a correct model interpretation of moving the current paper to a ${noun}`, async function () {
      const { request, result, service } = await interpret(
        `move this paper to Bayesian ${noun}`,
      );
      assert.deepEqual(
        result.classifiedIntent?.actionIntents.map((a) => a.operation),
        ["move_to_collection"],
      );
      const contract = await service.createContract(request);
      assert.deepEqual(
        contract.obligations[0].targetBoundary?.frozenTargetIds,
        [42],
      );
    });
  }
  it("binds the subject independently of destination members in a compound request", async function () {
    const { request, service } = await interpret(
      "help me move this paper into Bayesian folder, then summarize this paper and save the summary as an attached note",
    );
    const contract = await service.createContract(request);
    assert.deepEqual(
      contract.obligations[0].targetBoundary?.frozenTargetIds,
      [42],
    );
    assert.deepEqual(
      contract.obligations[1].targetBoundary?.frozenTargetIds,
      [42],
    );
    const validation = await service.validateScope(
      contract,
      {
        executionClass: "external_effect",
        hasExplicitAdapter: true,
        operations: [],
        requestedTargets: ["item:99"],
        destinationCollectionIds: [10],
        alreadySatisfiedTargets: [],
        verifiedFacts: [],
        proposals: [
          {
            id: "wrong-paper",
            operation: "move_to_collection",
            capability: "zotero.collections",
            proofDomain: "zotero_state",
            source: "library_mutation",
            parameters: { destinationCollectionId: 10 },
            requestedTargets: ["item:99"],
            destinationCollectionIds: [10],
          },
        ],
      },
      { progress: service.createProgress(contract), concreteWrite: true },
    );
    assert.equal(validation?.code, "fixed_selection");
  });
  it("interprets requested actions without requiring an installed skill", async function () {
    const { result } = await interpret(
      "move this paper to Bayesian folder",
      [],
    );
    assert.deepEqual(
      result.classifiedIntent?.actionIntents.map((a) => a.operation),
      ["move_to_collection"],
    );
  });
});
