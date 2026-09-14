import { planExecutionCoordinator } from "../src/agent/plans/coordinator";
import { assert } from "chai";
import {
  decodeActionContract,
  decodeActionReceipt,
} from "../src/agent/plans/contracts";
import { actionIsComplete } from "../src/agent/contracts/workflowDependencies";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { detectTurnIntent } from "../src/agent/model/semanticIntentService";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import {
  semanticResponseFixture,
  classifiedFixture,
  semanticFixture,
} from "./helpers/semanticIntent";

const material = {
  id: "summary",
  description: "Summarize methods, result and limitations",
  afterActions: [0],
  sourceActionIndexes: [0],
  requiredEvidence: "body",
};
const actions = [
  {
    operation: "move_to_collection",
    capability: "zotero.collections",
    proofDomain: "zotero_state",
    coverage: "one",
    targetKind: "papers",
    parameters: { destinationCollectionId: 10 },
  },
  {
    operation: "note_create",
    capability: "zotero.notes",
    proofDomain: "zotero_state",
    coverage: "one",
    targetKind: "papers",
    parameters: { targetItemId: 42, noteMode: "create" },
    dependsOn: [0],
    contentFrom: "summary",
  },
];
const request = () =>
  resolvedAgentRequest({
    conversationKey: 42,
    mode: "agent",
    libraryID: 1,
    activeItemId: 42,
    userText:
      "Move item 42 to collection 10, then summarize it and save the summary as a child note.",
    model: "gpt-5.4",
    apiBase: "https://api.openai.com/v1",
    apiKey: "fixture",
    selectedPaperContexts: [
      { itemId: 42, contextItemId: 42, libraryID: 1, title: "Paper" },
    ],
    classifiedIntent: classifiedFixture({
      writeDisposition: "required",
      actionIntents: actions as any,
      semantic: semanticFixture({ materialOutputs: [material] } as any),
    }),
  });
const service = () =>
  new ActionContractService({
    getItem: (id: number) => ({
      id,
      libraryID: 1,
      deleted: false,
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
    }),
    getCollectionSummary: () => ({
      collectionId: 10,
      libraryID: 1,
      name: "Destination",
      path: "Destination",
    }),
    listCollectionSummaries: () => [
      {
        collectionId: 10,
        libraryID: 1,
        name: "Destination",
        path: "Destination",
      },
    ],
    listCurrentCollectionTargetIds: () => [],
  } as any);
const preparedNote = {
  executionClass: "external_effect",
  hasExplicitAdapter: true,
  operations: [],
  requestedTargets: ["item:42"],
  destinationCollectionIds: [],
  alreadySatisfiedTargets: [],
  verifiedFacts: [],
  proposals: [
    {
      id: "save",
      operation: "note_create",
      capability: "zotero.notes",
      proofDomain: "zotero_state",
      source: "zotero_native",
      parameters: { targetItemId: 42, noteMode: "create" },
      requestedTargets: ["item:42"],
      destinationCollectionIds: [],
    },
  ],
};

describe("semantic compound workflow dependencies", function () {
  it("constructs an approvable move-read-generate-save plan with separate material evidence", async function () {
    const original = globalThis.Zotero;
    globalThis.Zotero = {
      DB: {
        queryAsync: async () => [],
        executeTransaction: async (fn: any) => fn(),
      },
    } as any;
    try {
      const contract = await service().createContract(request());
      const steps = [
        {
          planStepId: "move",
          content: "Move paper",
          expectedEffect: "mutation",
          actionIndexes: [0],
          acceptanceCriteria: [
            {
              criterionId: "moved",
              description: "Native membership verified",
              verifier: "mutation_receipts",
            },
          ],
        },
        {
          planStepId: "read",
          content: "Read paper",
          expectedEffect: "read",
          acceptanceCriteria: [
            {
              criterionId: "read",
              description: "Paper body read",
              verifier: "verified_read",
            },
          ],
        },
        {
          planStepId: "summary",
          content: "Generate summary",
          expectedEffect: "artifact",
          materialOutputId: "summary",
          acceptanceCriteria: [
            {
              criterionId: "material",
              description: "Exact summary stored",
              verifier: "material_integrity",
            },
          ],
        },
        {
          planStepId: "save",
          content: "Save summary note",
          expectedEffect: "mutation",
          actionIndexes: [1],
          acceptanceCriteria: [
            {
              criterionId: "saved",
              description: "Exact note content and parent verified",
              verifier: "mutation_receipts",
            },
          ],
        },
      ];
      const artifact = await planExecutionCoordinator.updateDraft({
        planId: "material-plan",
        revision: 1,
        conversationKey: 42,
        provider: "original",
        ready: true,
        steps: steps as any,
        contract: {
          deliverable: { kind: "completion_report" },
          effects: { libraryMutation: { approval: "initial", contract } },
        },
        actionContract: contract,
      });
      assert.equal(artifact.status, "awaiting_approval");
      assert.equal((artifact.steps[2] as any).materialOutputId, "summary");
      assert.deepEqual((artifact.steps[3] as any).actionIndexes, [1]);
      let rejected = false;
      try {
        await planExecutionCoordinator.updateDraft({
          planId: "reversed-material-plan",
          revision: 1,
          conversationKey: 42,
          provider: "original",
          ready: true,
          steps: [steps[3], steps[1], steps[2], steps[0]] as any,
          actionContract: contract,
          contract: {
            deliverable: { kind: "completion_report" },
            effects: { libraryMutation: { approval: "initial", contract } },
          },
        });
      } catch (error) {
        rejected = String(error).includes("dependency");
      }
      assert.isTrue(
        rejected,
        "Plan ordering must preserve frozen workflow dependencies",
      );
    } finally {
      globalThis.Zotero = original;
    }
  });
  it("preserves dependency and material bindings across Plan storage", async function () {
    const contract = await service().createContract(request());
    const restored = decodeActionContract(JSON.parse(JSON.stringify(contract)));
    assert.deepEqual(restored.obligations[1].dependsOn, [0]);
    assert.equal(restored.obligations[1].contentFrom, "summary");
    assert.equal(restored.obligations[1].sourceActionIndex, 1);
    const receipt = {
      version: 2,
      id: "saved",
      proposalId: "note",
      proofDomain: "zotero_state",
      capability: "zotero.notes",
      operation: "note_create",
      verification: "verified",
      status: "applied",
      requestedTargets: ["item:42"],
      appliedTargets: ["item:42"],
      alreadySatisfiedTargets: [],
      rejectedTargets: [],
      reasons: [],
      verifiedFacts: [],
      normalizedParameters: { documentId: "summary-doc", contentHash: "hash" },
    };
    assert.equal(
      decodeActionReceipt(receipt).normalizedParameters?.documentId,
      "summary-doc",
    );
  });
  it("waits for every native obligation when one semantic action expands across collections", function () {
    const contract = {
      id: "expanded",
      obligations: [
        { id: "first-collection", sourceActionIndex: 0 },
        { id: "second-collection", sourceActionIndex: 0 },
        { id: "note", sourceActionIndex: 1 },
      ],
    } as any;
    const progress = {
      contractId: "expanded",
      obligations: [
        { obligationId: "first-collection", status: "fulfilled" },
        { obligationId: "second-collection", status: "open" },
        { obligationId: "note", status: "open" },
      ],
    } as any;
    assert.isFalse(actionIsComplete(contract, progress, 0));
    progress.obligations[1].status = "fulfilled";
    assert.isTrue(actionIsComplete(contract, progress, 0));
    assert.isFalse(actionIsComplete(contract, progress, 1));
  });
  it("preserves ordering and the generated-content reference from one semantic response", async function () {
    const r = request();
    const result = await detectTurnIntent(r, [], {
      llmCall: async () => ({
        text: JSON.stringify(
          semanticResponseFixture({
            writeDisposition: "required",
            actionIntents: actions,
            decisions: r.classifiedIntent!.semantic,
          }),
        ),
        completion: { status: "complete" },
      }),
    });
    assert.isFalse(result.degraded);
    assert.deepEqual(
      (result.classifiedIntent!.actionIntents[1] as any).dependsOn,
      [0],
    );
    assert.equal(
      (result.classifiedIntent!.actionIntents[1] as any).contentFrom,
      "summary",
    );
  });
  it("rejects dependency cycles instead of executing a guessed ordering", async function () {
    const r = request();
    const cyclic = [{ ...actions[0], dependsOn: [1] }, actions[1]];
    const result = await detectTurnIntent(r, [], {
      llmCall: async () => ({
        text: JSON.stringify(
          semanticResponseFixture({
            writeDisposition: "required",
            actionIntents: cyclic,
            decisions: r.classifiedIntent!.semantic,
          }),
        ),
        completion: { status: "complete" },
      }),
    });
    assert.isTrue(result.degraded);
    assert.isNull(result.classifiedIntent);
  });
  it("blocks the save until both the earlier move and exact generated material are verified", async function () {
    const host = service();
    const contract = await host.createContract(request());
    const progress = host.createProgress(contract);
    const early = await host.validateScope(contract, preparedNote as any, {
      progress,
      concreteWrite: true,
    });
    assert.equal(early?.code, "workflow_dependency");
    progress.obligations[0].status = "fulfilled";
    const withoutMaterial = await host.validateScope(
      contract,
      preparedNote as any,
      { progress, concreteWrite: true },
    );
    assert.equal(withoutMaterial?.code, "workflow_dependency");
  });
});
