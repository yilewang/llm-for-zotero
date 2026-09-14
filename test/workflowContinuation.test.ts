import { detectTurnIntent } from "../src/agent/model/semanticIntentService";
import { semanticResponseFixture } from "./helpers/semanticIntent";
import { assert } from "chai";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { carryWorkflowProgress } from "../src/agent/contracts/workflowContinuation";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import {
  actionFixture,
  classifiedFixture,
  semanticFixture,
} from "./helpers/semanticIntent";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

const output = {
  id: "summary",
  description: "Summarize the paper",
  afterActions: [0],
  sourceActionIndexes: [0],
  requiredEvidence: "body" as const,
};
const move = {
  ...actionFixture("move_to_collection", {
    sourceCollectionId: 1,
    destinationCollectionId: 7,
  }).actionIntents[0],
  scopeRole: "source" as const,
  constraints: { collectionMode: "move" as const },
};
const note = {
  ...actionFixture("note_create", { noteMode: "create", targetItemId: 42 })
    .actionIntents[0],
  scopeRole: "source" as const,
  dependsOn: [0],
  contentFrom: "summary",
};
const file = {
  ...actionFixture("file_write", { filePath: "/tmp/retained-summary.md" })
    .actionIntents[0],
  scopeRole: "source" as const,
  dependsOn: [0],
  contentFrom: "summary",
};
function fixture() {
  const gateway = {
    getItem: (id: number) => ({
      id,
      libraryID: 1,
      deleted: false,
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
      getField: () => `Paper ${id}`,
      getCollections: () => [1],
    }),
    getCollectionSummary: (id: number) => ({
      collectionId: id,
      libraryID: 1,
      name: id === 1 ? "Source" : "Destination",
    }),
    listCollectionSummaries: () => [],
    listCurrentCollectionTargetIds: () => [],
  };
  const service = new ActionContractService(gateway as never);
  const request = resolvedAgentRequest({
    conversationKey: 42,
    mode: "agent",
    libraryID: 1,
    activeItemId: 42,
    userText: "Move this paper, summarize it and attach a note",
    classifiedIntent: classifiedFixture({
      writeDisposition: "required",
      actionIntents: [move, note],
      semantic: semanticFixture({ materialOutputs: [output] }),
    }),
  });
  const registry = createBuiltInToolRegistry({
    zoteroGateway: gateway as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
  return { request, service, registry };
}

describe("explicit workflow continuation", function () {
  let original: any;
  let document: any;
  beforeEach(function () {
    original = globalThis.Zotero;
    document = {
      version: 2,
      documentId: "retained-summary",
      documentVersion: 1,
      conversationKey: 42,
      documentKind: "custom",
      integrityPolicy: "authored",
      origin: { kind: "direct", runId: "prior", sourceMessageTimestamp: 1 },
      title: "Summary",
      visibleMarkdown: "# Summary\n\nExact retained summary.",
      visibleHtml: "<h1>Summary</h1><p>Exact retained summary.</p>",
      citationBundle: {
        clusters: [],
        bibliographyEntries: [],
        style: { id: "apa", title: "APA" },
        locale: "en-US",
      },
      assets: [],
      verifiedQuotes: [],
      coverageItems: [],
      validation: {
        integrityValidated: true,
        groundingReviewed: "not_run",
        quoteVerified: "not_applicable",
        issues: [],
      },
      contentHash: "sha256:retained",
      createdAt: 1,
    };
    globalThis.Zotero = {
      DB: {
        queryAsync: async (sql: string) =>
          sql.includes(
            "payload_json AS payloadJson FROM llm_for_zotero_plan_documents",
          )
            ? [{ payloadJson: JSON.stringify(document) }]
            : [],
      },
    } as any;
  });
  afterEach(function () {
    globalThis.Zotero = original;
  });
  async function revised() {
    const f = fixture();
    const prior = await f.service.createContract(f.request);
    const progress = f.service.createProgress(prior);
    progress.obligations[0].status = "fulfilled";
    progress.obligations[0].verifiedTargetIds = ["item:42"];
    progress.materialOutputs = [
      {
        outputId: "summary",
        documentId: document.documentId,
        documentVersion: 1,
        contentHash: document.contentHash,
      },
    ];
    progress.authorizationGrants = [{ id: "old-consent" } as any];
    const current = resolvedAgentRequest({
      ...f.request,
      activeItemId: 99,
      userText: "Continue, but save the summary as a file instead",
      workflowCheckpoint: { contract: prior, progress },
      classifiedIntent: classifiedFixture({
        writeDisposition: "required",
        actionIntents: [move, file],
        semantic: semanticFixture({
          id: "revised",
          continuation: "revise",
          noteDestination: "file",
          materialOutputs: [output],
          workflowReuse: {
            contractId: prior.id,
            actions: [{ actionIndex: 0, previousActionIndex: 0 }],
            outputs: [{ outputId: "summary", previousOutputId: "summary" }],
          },
        }),
      }),
    });
    return { ...f, current };
  }
  it("repairs dangling continuation references before preparing a workflow", async function () {
    const { current } = await revised();
    current.userText =
      "Continue the unfinished workflow without repeating completed work";
    current.apiBase = "https://example.invalid";
    current.apiKey = "test";
    current.model = "test";
    const prior = current.workflowCheckpoint!.contract.intent!;
    let calls = 0;
    const malformed = semanticResponseFixture({
      actionIntents: [],
      writeDisposition: "none",
      decisions: semanticFixture({
        continuation: "resume",
        workflowReuse: {
          contractId: current.workflowCheckpoint!.contract.id,
          actions: [],
          outputs: [{ outputId: "summary", previousOutputId: "summary" }],
        },
      }),
    });
    const correct = semanticResponseFixture({
      ...prior,
      decisions: semanticFixture({
        ...prior.semantic,
        continuation: "resume",
        workflowReuse: {
          contractId: current.workflowCheckpoint!.contract.id,
          actions: [
            { actionIndex: 0, previousActionIndex: 0 },
            { actionIndex: 1, previousActionIndex: 1 },
          ],
          outputs: [{ outputId: "summary", previousOutputId: "summary" }],
        },
      }),
    });
    const result = await detectTurnIntent(current, [], {
      llmCall: async () => ({
        text: JSON.stringify(++calls === 1 ? malformed : correct),
        completion: { status: "complete" },
      }),
    });
    assert.equal(
      calls,
      2,
      "A dangling output reference must reach schema correction",
    );
    assert.equal(
      result.classifiedIntent?.actionIntents.length,
      2,
      JSON.stringify(result),
    );
  });
  it("interprets explicit saved-action references without requiring the model to restate names, identities, or material", async function () {
    const { current } = await revised();
    current.userText = "Continue the unfinished workflow";
    current.model = "test";
    current.apiBase = "https://example.invalid";
    current.apiKey = "test";
    const response = semanticResponseFixture({
      writeDisposition: "required",
      actionIntents: [{ reuseAction: 0 }, { reuseAction: 1 }],
      decisions: semanticFixture({
        continuation: "resume",
        workflowReuse: {
          contractId: current.workflowCheckpoint!.contract.id,
          actions: [0, 1] as never,
          outputs: ["summary"] as never,
        },
        materialOutputs: [{ reuseOutput: "summary" }] as never,
      }),
    });
    const result = await detectTurnIntent(current, [], {
      llmCall: async () => ({
        text: JSON.stringify(response),
        completion: { status: "complete" },
      }),
    });
    assert.deepEqual(
      result.classifiedIntent?.actionIntents,
      current.workflowCheckpoint!.contract.intent!.actionIntents,
      JSON.stringify(result),
    );
    assert.deepEqual(result.classifiedIntent?.semantic?.materialOutputs, [
      output,
    ]);
  });
  it("retains completed move and exact summary while replacing only the unfinished save", async function () {
    const { service, registry, current } = await revised();
    current.actionContract = await service.createContract(current);
    current.actionProgress = service.createProgress(current.actionContract);
    current.actionPreparation = { state: "ready", issues: [] };
    await carryWorkflowProgress(
      current,
      current.actionContract,
      current.actionProgress,
    );
    assert.deepEqual(
      current.actionContract.obligations[0].targetBoundary?.frozenTargetIds,
      [42],
      "changed current selection cannot replace the prior paper",
    );
    assert.equal(current.actionProgress.obligations[0].status, "fulfilled");
    assert.isEmpty(current.actionProgress.authorizationGrants!);
    assert.isFalse(
      current.actionContract.obligations.some(
        (o) => o.operation === "note_create",
      ),
    );
    const next = await registry.getNextWorkflowStep(current);
    assert.equal(next.kind, "action");
    if (next.kind !== "action") return;
    assert.deepEqual(next.prepared.call.arguments, {
      action: "write",
      filePath: "/tmp/retained-summary.md",
      content: document.visibleMarkdown,
    });
    assert.equal(
      current.actionProgress.materialOutputs![0].documentId,
      "retained-summary",
    );
  });
  it("rejects a changed action falsely linked to old authority", async function () {
    const { service, current } = await revised();
    current.classifiedIntent!.actionIntents[0] = {
      ...move,
      parameters: { ...move.parameters, destinationCollectionId: 8 },
    };
    let failure = "";
    try {
      await service.createContract(current);
    } catch (error) {
      failure = String(error);
    }
    assert.include(failure, "superseded action authority");
  });
  it("rejects changed durable material instead of regenerating or substituting it", async function () {
    const { service, current } = await revised();
    current.actionContract = await service.createContract(current);
    current.actionProgress = service.createProgress(current.actionContract);
    document.contentHash = "sha256:changed";
    let failure = "";
    try {
      await carryWorkflowProgress(
        current,
        current.actionContract,
        current.actionProgress,
      );
    } catch (error) {
      failure = String(error);
    }
    assert.include(failure, "unavailable or changed");
    assert.isUndefined(current.actionProgress.materialOutputs);
  });
});
