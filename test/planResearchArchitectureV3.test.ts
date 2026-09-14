import { assert } from "chai";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  OPERATION_CATALOG,
  operationAuthorityIsConsistent,
} from "../src/agent/contracts/operationCatalog";
import type { AgentActionContract } from "../src/agent/contracts/types";
import { decodePlanDocument } from "../src/agent/documents/decoders";
import { buildAgentInitialMessages } from "../src/agent/model/messageBuilder";
import {
  decodeActionContract,
  decodePlanContract,
} from "../src/agent/plans/contracts";
import {
  assertTaskCompletionEvidence,
  canonicalizePlanResearchEvidenceDepth,
  canonicalizePlanVerifierOwnership,
  resolvePreResearchActionContract,
} from "../src/agent/plans/coordinator";
import {
  decodePlanArtifact,
  decodeTaskEvidence,
} from "../src/agent/plans/decoders";
import { extractVerifiedReadSources } from "../src/agent/plans/readEvidence";
import {
  buildPlanFinalCorrection,
  shouldOfferPlanFinalCorrection,
} from "../src/agent/plans/runSession";
import { listExecutionTaskEvidence } from "../src/agent/plans/store";
import type {
  ExecutionTask,
  TaskEvidence,
  TrustedReadObservation,
} from "../src/agent/plans/types";
import {
  decodePaperFinding,
  decodeResearchCorpusItem,
  decodeResearchJob,
} from "../src/agent/research/decoders";
import {
  scoreResearchEvaluation,
  type ResearchEvaluationCase,
} from "../src/agent/research/evaluation";
import {
  resolveResearchPolicy,
  shouldCheckpointResearchExpansion,
} from "../src/agent/research/policy";
import {
  buildAdaptiveScreeningBatch,
  buildExcludedScreeningFinding,
  type ScreeningBatchPaper,
} from "../src/agent/research/screeningBatch";
import { interruptResearchExecution } from "../src/agent/research/store";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import {
  createResearchUpdateTool,
  getTerminalScreeningDecisionError,
  isCriterionCompleteScreeningDecision,
  resolveTrustedPdfLocator,
  selectPreferredReadingAttachment,
  selectPreferredVerifiedReads,
} from "../src/agent/tools/plan/researchUpdate";
import { createSubmitPlanDocumentTool } from "../src/agent/tools/plan/submitPlanDocument";
import { createTaskUpdateTool } from "../src/agent/tools/plan/taskUpdate";
import { createUpdatePlanTool } from "../src/agent/tools/plan/updatePlan";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

const policy = resolveResearchPolicy("plan_research");

function investigation() {
  return {
    question: "Which papers report the effect?",
    subquestions: [{ id: "q1", question: "What effect was reported?" }],
    criteria: [
      { id: "c1", kind: "include", description: "Reports the effect" },
    ],
    scope: { libraryID: 1, kind: "items", itemKeys: ["AAAA1111"] },
    scopeSnapshot: {
      snapshotId: "plan:r1:scope",
      digest: "sha256:scope",
      itemCount: 1,
      createdAt: 1,
      policyVersion: policy.version,
    },
    requiredEvidenceDepth: "body",
    estimatedDeepReadPapers: 10,
    approvedLargeCorpus: false,
  };
}

describe("Plan Mode research architecture v3", function () {
  it("rejects stage overrides on every record or read operation", function () {
    const tool = createResearchUpdateTool({} as ZoteroGateway);
    for (const operation of [
      "inventory_scope",
      "next_screen_batch",
      "list_verified_reads",
      "list_findings",
      "list_themes",
      "record_papers",
      "record_probes",
      "record_themes",
      "finalize",
    ]) {
      const result = tool.validate({
        operation,
        stage: "recall_expansion",
        papers: [{}],
        probes: [],
        themes: [],
        outcome: "partial",
      });
      assert.isFalse(
        result.ok,
        `${operation} must not accept a stage override`,
      );
    }
    assert.isFalse(tool.validate({ operation: "set_stage" }).ok);
    assert.isTrue(
      tool.validate({ operation: "set_stage", stage: "broad_screening" }).ok,
    );
  });

  it("explains terminal screening contradictions when papers are recorded", function () {
    const criteria = [
      {
        id: "include-scope",
        kind: "include" as const,
        description: "In scope",
      },
      {
        id: "exclude-outside",
        kind: "exclude" as const,
        description: "Outside the scope",
      },
    ];

    assert.include(
      getTerminalScreeningDecisionError({
        screeningStatus: "included",
        criterionResults: {
          "include-scope": "met",
          "exclude-outside": "met",
        },
        criteria,
        totalItems: 10,
        deepReadPlanned: 3,
      }) || "",
      'exclude criteria must be "not_met"',
    );
    assert.isUndefined(
      getTerminalScreeningDecisionError({
        screeningStatus: "excluded",
        criterionResults: {
          "include-scope": "met",
          "exclude-outside": "not_met",
        },
        decisionReason: "Relevant, but outside the strongest three papers.",
        criteria,
        totalItems: 10,
        deepReadPlanned: 3,
      }),
      "a reasoned relative exclusion remains valid",
    );
    assert.isUndefined(
      getTerminalScreeningDecisionError({
        screeningStatus: "candidate",
        criterionResults: {
          "include-scope": "met",
          "exclude-outside": "unknown",
        },
        criteria,
        totalItems: 10,
        deepReadPlanned: 3,
      }),
      "provisional candidates may retain unknown results",
    );
  });

  it("accepts reasoned relative exclusions when only a bounded subset is deep-read", function () {
    const criteria = [
      { id: "c1", kind: "include" as const, description: "Frozen scope" },
      { id: "c2", kind: "include" as const, description: "PDF-backed" },
      { id: "c3", kind: "exclude" as const, description: "Not a paper" },
    ];
    const excluded = decodeResearchCorpusItem({
      version: 1,
      researchJobId: "r",
      executionId: "e",
      parentTaskId: "t",
      libraryID: 1,
      itemKey: "AAAA1111",
      ordinal: 0,
      screeningStatus: "excluded",
      criterionResults: { c1: "met", c2: "met", c3: "not_met" },
      decisionReason:
        "Relevant at abstract level, but not among the three strongest papers selected for body reading.",
      inventoryRecorded: true,
      hasAbstract: true,
      attachmentItemKeys: ["PDF00001"],
      duplicateAttachmentKeys: [],
      readable: true,
      indexed: true,
      updatedAt: 1,
    });

    assert.isTrue(
      isCriterionCompleteScreeningDecision({
        entry: excluded,
        criteria,
        totalItems: 10,
        deepReadPlanned: 3,
      }),
    );
    assert.isFalse(
      isCriterionCompleteScreeningDecision({
        entry: { ...excluded, decisionReason: "" },
        criteria,
        totalItems: 10,
        deepReadPlanned: 3,
      }),
      "relative exclusion still requires an explicit paper-level rationale",
    );
    assert.isFalse(
      isCriterionCompleteScreeningDecision({
        entry: excluded,
        criteria,
        totalItems: 10,
        deepReadPlanned: 10,
      }),
      "a corpus-wide deep-read plan cannot use relative selection as an exclusion reason",
    );
  });

  it("makes a positive deep-read budget enforce body evidence", function () {
    const contract = canonicalizePlanResearchEvidenceDepth(
      decodePlanContract({
        investigation: {
          ...investigation(),
          requiredEvidenceDepth: "abstract",
          estimatedDeepReadPapers: 3,
        },
        deliverable: { kind: "answer" },
        researchPolicy: policy,
      }),
    );
    assert.equal(contract.investigation?.requiredEvidenceDepth, "body");
  });

  it("recovers trusted reads from every task in the approved execution", async function () {
    const previousZotero = (globalThis as { Zotero?: unknown }).Zotero;
    const evidence = [
      {
        version: 3 as const,
        evidenceId: "read-task-1",
        executionId: "execution-1",
        taskId: "deep-read-task",
        kind: "verified_read" as const,
        verified: true,
        criterionIds: [] as string[],
        reference: "read-call-1",
        payload: {
          type: "verified_read" as const,
          reference: "read-call-1",
          observations: [],
        },
        createdAt: 1,
      },
      {
        version: 3 as const,
        evidenceId: "read-task-2",
        executionId: "execution-1",
        taskId: "synthesis-task",
        kind: "verified_read" as const,
        verified: true,
        criterionIds: [] as string[],
        reference: "read-call-2",
        payload: {
          type: "verified_read" as const,
          reference: "read-call-2",
          observations: [],
        },
        createdAt: 2,
      },
    ];
    let queriedSql = "";
    (globalThis as { Zotero: unknown }).Zotero = {
      DB: {
        queryAsync: async (sql: string, args: unknown[]) => {
          queriedSql = sql;
          assert.deepEqual(args, ["execution-1"]);
          return evidence.map((entry) => ({
            payloadJson: JSON.stringify(entry),
          }));
        },
      },
    };
    try {
      const recovered = await listExecutionTaskEvidence("execution-1");
      assert.deepEqual(
        recovered.map((entry) => entry.reference),
        ["read-call-1", "read-call-2"],
      );
      assert.notInclude(queriedSql, "task_id = ?");
    } finally {
      (globalThis as { Zotero?: unknown }).Zotero = previousZotero;
    }
  });

  it("drops an unissued body locator while preserving the trusted body receipt", function () {
    const observation: TrustedReadObservation = {
      version: 1,
      observationId: "observation-1",
      issuer: "zotero_host",
      toolName: "paper_read",
      callDigest: "sha256:call",
      inputDigest: "sha256:input",
      resultDigest: "sha256:result",
      libraryID: 1,
      itemKey: "AAAA1111",
      attachmentItemKey: "PDFP2222",
      capabilities: ["body"],
      sourceFingerprint: "fnv1a32-body",
      certificateDigest: "sha256:certificate",
    };
    assert.isUndefined(
      resolveTrustedPdfLocator({
        evidenceKey: "body-claim",
        sourceKind: "body",
        requested: { attachmentItemKey: "PDFP2222", pageIndex: 7 },
        observations: [observation],
        fallbackFingerprint: "fnv1a32-body",
      }),
      "a page number omitted by the host receipt must not be persisted from model output",
    );
    assert.throws(
      () =>
        resolveTrustedPdfLocator({
          evidenceKey: "quote-claim",
          sourceKind: "quote",
          requested: { attachmentItemKey: "PDFP2222", pageIndex: 7 },
          observations: [observation],
          fallbackFingerprint: "fnv1a32-body",
        }),
      /locator was not emitted/,
    );
  });

  it("injects the persisted prior plan into a revision prompt", async function () {
    const priorPlan = {
      version: 4 as const,
      planId: "plan-1",
      conversationKey: 1,
      provider: "original" as const,
      revision: 1,
      digest: "sha256:plan",
      status: "superseded" as const,
      explanation: "Screen ten papers, then deep-read three.",
      contract: decodePlanContract({
        investigation: investigation(),
        deliverable: { kind: "answer" },
        researchPolicy: policy,
      }),
      contractDigest: "sha256:contract",
      steps: [
        {
          planStepId: "screen",
          content: "Screen the frozen corpus",
          activeForm: "Screening the frozen corpus",
          acceptanceCriteria: [
            {
              criterionId: "screened",
              description: "Every paper is screened",
              verifier: "research_coverage" as const,
            },
          ],
          completionRequirements: [],
          expectedEffect: "read" as const,
        },
      ],
      createdAt: 1,
      updatedAt: 2,
    };
    const messages = await buildAgentInitialMessages(
      resolvedAgentRequest({
        conversationKey: 1,
        mode: "agent",
        userText: "Revise only the evidence strategy.",
        planContext: {
          phase: "planning",
          planId: "plan-1",
          revision: 2,
          provider: "original",
        },
        metadata: { priorPlanArtifact: priorPlan },
      }),
      [],
      [],
    );
    const prompt = messages
      .map((message) =>
        typeof message.content === "string" ? message.content : "",
      )
      .join("\n");
    assert.include(prompt, "HOST-PERSISTED PLAN REVISION BASE");
    assert.include(prompt, "Screen ten papers, then deep-read three.");
    assert.include(prompt, '"planStepId":"screen"');
    assert.include(prompt, "Do not rediscover or reconstruct this plan");
  });

  it("directs an unfinished document plan to the terminal document tool", function () {
    const correction = buildPlanFinalCorrection(
      "The document task is incomplete",
      true,
    );
    assert.include(correction, "Call submit_document now");
    assert.include(correction, "do not try to complete");
    assert.include(correction, "host finalizer owns References");
    assert.notInclude(
      correction,
      "Continue the approved plan. Use task_update",
    );
  });

  it("keeps document submission behind unfinished prerequisite tasks", function () {
    const correction = buildPlanFinalCorrection(
      "The deep-reading task is incomplete",
      true,
      false,
    );
    assert.include(correction, "Complete the current approved task");
    assert.include(correction, "task_update");
    assert.include(correction, "Once the document task becomes active");
    assert.notInclude(correction, "Call submit_document now");
  });

  it("keeps host-advanced research corrections off task_update", function () {
    const correction = buildPlanFinalCorrection(
      "The deep-reading task is incomplete",
      true,
      false,
      false,
    );
    assert.include(correction, "host advances its task state");
    assert.include(correction, "continue with the active research tool");
    assert.notInclude(correction, "task_update");
    assert.notInclude(correction, "Call submit_document now");
  });

  it("renews the Plan final correction only after a successful tool step", function () {
    assert.isTrue(
      shouldOfferPlanFinalCorrection({
        canCorrect: true,
        successfulToolResultCount: 0,
        lastCorrectionSuccessfulToolCount: -1,
      }),
    );
    assert.isFalse(
      shouldOfferPlanFinalCorrection({
        canCorrect: true,
        successfulToolResultCount: 0,
        lastCorrectionSuccessfulToolCount: 0,
      }),
    );
    assert.isTrue(
      shouldOfferPlanFinalCorrection({
        canCorrect: true,
        successfulToolResultCount: 2,
        lastCorrectionSuccessfulToolCount: 0,
      }),
    );
  });

  it("canonicalizes host-owned research and document verifier placement", function () {
    const steps = canonicalizePlanVerifierOwnership({
      contract: decodePlanContract({
        investigation: investigation(),
        deliverable: {
          kind: "document",
          spec: {
            kind: "literature_review",
            title: "Review",
            requiredSections: ["Findings", "Limitations"],
            requiresReferences: true,
            requiresCoverageSection: true,
            allowFigures: false,
            citationStyle: {
              styleId: "http://www.zotero.org/styles/apa",
              styleTitle: "APA",
              locale: "en-US",
            },
          },
        },
        researchPolicy: policy,
      }),
      steps: [
        {
          planStepId: "screen",
          content: "Screen the corpus",
          activeForm: "Screening",
          expectedEffect: "read" as const,
          acceptanceCriteria: [
            {
              criterionId: "screened",
              description: "All papers screened",
              verifier: "research_coverage" as const,
            },
            {
              criterionId: "integrity-wrong-step",
              description: "Document is valid",
              verifier: "document_integrity" as const,
            },
          ],
        },
        {
          planStepId: "synthesize",
          content: "Synthesize findings",
          activeForm: "Synthesizing",
          expectedEffect: "reasoning" as const,
          acceptanceCriteria: [
            {
              criterionId: "deep-read",
              description: "Included papers have evidence",
              verifier: "research_coverage" as const,
            },
          ],
        },
        {
          planStepId: "document",
          content: "Publish the review",
          activeForm: "Publishing",
          expectedEffect: "artifact" as const,
          acceptanceCriteria: [
            {
              criterionId: "published",
              description: "Document is published",
              verifier: "document_published" as const,
            },
          ],
        },
      ],
    });

    assert.deepEqual(
      steps.flatMap((step, index) =>
        step.acceptanceCriteria
          .filter((criterion) => criterion.verifier === "research_coverage")
          .map(() => index),
      ),
      [1, 1],
    );
    assert.deepEqual(
      steps.flatMap((step, index) =>
        step.acceptanceCriteria
          .filter((criterion) =>
            ["document_integrity", "document_published"].includes(
              criterion.verifier,
            ),
          )
          .map(() => index),
      ),
      [2, 2],
    );
    assert.isTrue(
      steps.every((step) => step.acceptanceCriteria.length > 0),
      "canonicalization must not leave a user-visible step unverifiable",
    );
  });

  it("advertises an exact document contract and bounded host inventory updates", function () {
    const updatePlan = createUpdatePlanTool();
    const contractSchema = (updatePlan.spec.inputSchema as any).properties
      .contract;
    assert.isFalse(contractSchema.additionalProperties);
    assert.deepEqual(
      contractSchema.properties.deliverable.properties.kind.enum,
      ["answer", "document", "completion_report"],
    );
    assert.deepEqual(
      contractSchema.properties.deliverable.properties.spec.properties.kind
        .enum,
      [
        "research_brief",
        "literature_review",
        "comparison",
        "report",
        "guide",
        "custom",
      ],
    );
    assert.equal(
      contractSchema.properties.investigation.properties.criteria.minItems,
      0,
    );

    const researchUpdate = createResearchUpdateTool({} as ZoteroGateway);
    assert.isTrue(researchUpdate.validate({ operation: "inventory_scope" }).ok);
    assert.isTrue(
      researchUpdate.validate({ operation: "next_screen_batch" }).ok,
    );
    assert.isTrue(
      researchUpdate.validate({ operation: "list_verified_reads" }).ok,
    );
    assert.isTrue(
      researchUpdate.validate({ operation: "list_findings", limit: 20 }).ok,
    );
    assert.isTrue(researchUpdate.validate({ operation: "list_themes" }).ok);
    assert.isFalse(
      researchUpdate.validate({ operation: "list_findings", limit: 26 }).ok,
    );
    const identifiedPapers = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        libraryID: 1,
        itemKey: `KEY${index}`,
      }));
    assert.isTrue(
      researchUpdate.validate({
        operation: "record_papers",
        papers: identifiedPapers(2),
      }).ok,
    );
    assert.isTrue(
      researchUpdate.validate({
        operation: "record_papers",
        papers: identifiedPapers(26),
      }).ok,
    );
    const missingIdentity = researchUpdate.validate({
      operation: "record_papers",
      papers: [{ finding: {} }],
    });
    assert.isFalse(missingIdentity.ok);
    assert.match(
      (missingIdentity as { error: string }).error,
      /papers\[0\]\.libraryID[\s\S]*Example:/,
    );
    assert.isUndefined(
      (researchUpdate.spec.inputSchema as any).properties.papers.maxItems,
    );
    assert.include(
      researchUpdate.guidance?.instruction || "",
      "authoritative scope check",
    );
    assert.include(
      researchUpdate.guidance?.instruction || "",
      "read every accessible paper",
    );
    assert.include(
      researchUpdate.guidance?.instruction || "",
      "host binds internal evidence and finding IDs",
    );
    assert.include(researchUpdate.guidance?.instruction || "", "list_themes");
    assert.include(
      researchUpdate.guidance?.instruction || "",
      "do not recover old tool handles",
    );
    assert.include(
      researchUpdate.guidance?.instruction || "",
      "continuation checkpoint already supplies the authoritative remaining manifest",
    );
    assert.include(
      researchUpdate.guidance?.instruction || "",
      "next_screen_batch",
    );
    assert.include(
      researchUpdate.guidance?.instruction || "",
      "never re-enumerate or re-verify it with library_search",
    );
    assert.include(
      updatePlan.guidance?.instruction || "",
      "resolve it with one bounded metadata query",
    );
    assert.include(updatePlan.guidance?.instruction || "", "omit include");
    assert.include(
      updatePlan.guidance?.instruction || "",
      "never invent a paper quota",
    );
    const paperSchema = (researchUpdate.spec.inputSchema as any).properties
      .papers.items;
    assert.deepEqual(paperSchema.required, ["libraryID", "itemKey"]);
    const findingSchema = paperSchema.properties.finding;
    assert.deepEqual(findingSchema.required, [
      "mainMessage",
      "relevance",
      "confidence",
    ]);
    assert.property(findingSchema.properties, "claims");
    assert.property(findingSchema.properties, "candidateLinks");
    assert.notProperty(
      findingSchema.properties,
      "evidenceKeys",
      "finding-to-evidence linkage is owned by the host",
    );
    for (const hostOwnedField of [
      "hasAbstract",
      "attachmentItemKeys",
      "duplicateAttachmentKeys",
      "readable",
      "indexed",
      "evidence",
    ]) {
      assert.notProperty(
        paperSchema.properties,
        hostOwnedField,
        `${hostOwnedField} is frozen or verified by the host`,
      );
    }
    assert.deepEqual(
      paperSchema.properties.finding.properties.roles.items.enum,
      [
        "central_evidence",
        "supporting_evidence",
        "contradictory_evidence",
        "theoretical_foundation",
        "methodological_contribution",
        "historical_context",
        "tangential_context",
        "unresolved",
      ],
    );
    const themeSchema = (researchUpdate.spec.inputSchema as any).properties
      .themes.items;
    assert.property(themeSchema.properties, "paperIdentities");
    assert.notInclude(themeSchema.required, "paperFindingIds");
    assert.notInclude(themeSchema.required, "evidenceRefs");
    const taskUpdate = createTaskUpdateTool();
    assert.isFalse(
      taskUpdate.validate({
        tasks: [
          { taskId: "task-1", status: "completed" },
          { taskId: "task-2", status: "in_progress" },
        ],
      }).ok,
      "multi-task updates must be rejected before execution",
    );
    assert.include(
      taskUpdate.guidance?.instruction || "",
      "include reasoningAssertion",
    );
    const hostOwnedRequest = resolvedAgentRequest({
      conversationKey: 1,
      mode: "agent",
      userText: "Execute the approved review",
      model: "test-model",
      planContext: {
        phase: "executing",
        planId: "plan-1",
        revision: 1,
        executionId: "execution-1",
        approvedDigest: "sha256:plan",
        provider: "original",
      },
      metadata: {
        planExecutionLedger: {
          version: 1,
          executionId: "execution-1",
          planId: "plan-1",
          revision: 1,
          planDigest: "sha256:plan",
          conversationKey: 1,
          attempt: 1,
          provider: "original",
          grant: {
            version: 1,
            planId: "plan-1",
            revision: 1,
            planDigest: "sha256:plan",
            conversationKey: 1,
            conversationGeneration: 1,
            approvedAt: 1,
          },
          status: "running",
          activeTaskId: "task-1",
          tasks: [
            {
              version: 2,
              taskId: "task-1",
              executionId: "execution-1",
              planStepId: "s1",
              kind: "required_step",
              content: "Read every paper",
              activeForm: "Reading every paper",
              acceptanceCriteria: [],
              expectedEffect: "read",
              completionRequirements: [
                {
                  requirementId: "task-1:verified",
                  kind: "verified_read",
                  criterionIds: [],
                  contractDigest: "sha256:plan",
                },
              ],
              obligationIds: [],
              status: "in_progress",
              attemptCount: 1,
              evidenceIds: [],
              failureReasons: [],
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
      },
    });
    assert.isFalse(
      taskUpdate.isAvailable?.(hostOwnedRequest),
      "host-verifiable workflows must not advertise task_update",
    );
    const mutationLedger = hostOwnedRequest.metadata!
      .planExecutionLedger as any;
    mutationLedger.tasks[0].expectedEffect = "mutation";
    mutationLedger.tasks[0].completionRequirements[0].kind =
      "mutation_receipts";
    assert.isFalse(
      taskUpdate.isAvailable?.(hostOwnedRequest),
      "Receipt-verified mutations must also have one host task owner",
    );
    assert.match(
      (taskUpdate.spec.inputSchema as any).properties.task.properties
        .reasoningAssertion.description,
      /required when completing a reasoning task/i,
    );
    const probeSchema = (researchUpdate.spec.inputSchema as any).properties
      .probes.items;
    assert.deepEqual(probeSchema.required, [
      "probeId",
      "kind",
      "query",
      "addedTargets",
    ]);
    assert.deepEqual(probeSchema.properties.kind.enum, [
      "synonym",
      "abbreviation",
      "translation",
      "semantic",
      "reformulation",
    ]);
  });

  for (const corpusSize of [10, 30, 55]) {
    it(`issues an adaptive, lossless screening queue for ${corpusSize} papers`, function () {
      const pending: ScreeningBatchPaper[] = Array.from(
        { length: corpusSize },
        (_, index) => ({
          libraryID: 1,
          itemKey: `ITEM${String(index).padStart(4, "0")}`,
          ordinal: index,
          title: `Paper ${index}`,
          abstract: `Abstract ${index} ${"evidence ".repeat((index % 5) + 1)}`,
          year: String(2000 + (index % 25)),
          firstCreator: `Author ${index}`,
          hasAbstract: true,
          readable: true,
          indexed: true,
        }),
      );
      const issued = new Set<string>();
      while (issued.size < corpusSize) {
        const batch = buildAdaptiveScreeningBatch({
          papers: pending.filter(
            (paper) => !issued.has(`${paper.libraryID}:${paper.itemKey}`),
          ),
          criterionIds: ["include-topic", "exclude-editorial"],
          outputTokenBudget: 8192,
          maxPapersPerUpdate: 25,
        });
        assert.isNotEmpty(batch.papers);
        assert.isAtMost(batch.papers.length, 25);
        for (const paper of batch.papers) {
          const identity = `${paper.libraryID}:${paper.itemKey}`;
          assert.isFalse(issued.has(identity), `${identity} was issued twice`);
          issued.add(identity);
        }
      }
      assert.equal(issued.size, corpusSize);
    });
  }

  it("turns a broad-screen exclusion into a durable normalized finding", function () {
    const finding = buildExcludedScreeningFinding({
      researchJobId: "research-1",
      executionId: "execution-1",
      parentTaskId: "task-1",
      libraryID: 1,
      itemKey: "ITEM0001",
      criterionIds: ["include-topic", "exclude-editorial"],
      decisionReason: "The abstract concerns an unrelated clinical outcome.",
      sourceFingerprint: "sha256:metadata",
      createdAt: 123,
    });
    assert.equal(finding.inclusionDecision, "exclude");
    assert.deepEqual(finding.criterionIds, [
      "include-topic",
      "exclude-editorial",
    ]);
    assert.include(finding.limitations[0], "title/abstract screening");
    assert.deepEqual(finding.evidenceRefs, []);
  });

  it("terminalizes a research job and its issued work when Plan execution is interrupted", async function () {
    const previousZotero = (globalThis as { Zotero?: unknown }).Zotero;
    const job = {
      version: 1 as const,
      researchJobId: "execution-1:research",
      executionId: "execution-1",
      parentTaskId: "task-research",
      contractDigest: "sha256:contract",
      snapshotId: "snapshot-1",
      policy,
      status: "running" as const,
      activeStage: "broad_screening" as const,
      totalItems: 10,
      screenedItems: 0,
      candidateItems: 0,
      deepReadCompleted: 0,
      deepReadPlanned: 3,
      createdAt: 1,
      updatedAt: 2,
    };
    const work = {
      version: 1 as const,
      workItemId: "execution-1:research:work:broad_screening:1:ITEM0001",
      researchJobId: job.researchJobId,
      executionId: job.executionId,
      parentTaskId: job.parentTaskId,
      libraryID: 1,
      itemKey: "ITEM0001",
      stage: "broad_screening" as const,
      subquestionIds: [] as string[],
      status: "in_progress" as const,
      attemptCount: 1,
      leaseOwner: "run-1",
      leaseExpiresAt: 999999,
      evidenceRefs: [] as string[],
      createdAt: 1,
      updatedAt: 2,
    };
    const saved: unknown[] = [];
    (globalThis as { Zotero: unknown }).Zotero = {
      DB: {
        executeTransaction: async (fn: () => Promise<void>) => fn(),
        queryAsync: async (sql: string, args?: unknown[]) => {
          if (sql.includes("FROM llm_for_zotero_research_jobs")) {
            return [{ payloadJson: JSON.stringify(job) }];
          }
          if (
            sql.includes("FROM llm_for_zotero_research_work_items") &&
            sql.includes("SELECT")
          ) {
            return [{ payloadJson: JSON.stringify(work) }];
          }
          if (sql.includes("INSERT OR REPLACE")) saved.push({ sql, args });
          return [];
        },
      },
    };
    try {
      const interrupted = await interruptResearchExecution({
        executionId: "execution-1",
        conversationKey: 7,
        now: 100,
      });
      assert.equal(interrupted?.status, "interrupted");
      assert.equal(interrupted?.updatedAt, 100);
      assert.lengthOf(saved, 2);
      const savedJob = JSON.parse(
        String((saved[0] as { args: unknown[] }).args[5]),
      ) as Record<string, unknown>;
      assert.equal(savedJob.status, "interrupted");
      const savedWork = JSON.parse(
        String((saved[1] as { args: unknown[] }).args[6]),
      ) as Record<string, unknown>;
      assert.equal(savedWork.status, "interrupted");
      assert.notProperty(savedWork, "leaseOwner");
      assert.notProperty(savedWork, "leaseExpiresAt");
    } finally {
      (globalThis as { Zotero?: unknown }).Zotero = previousZotero;
    }
  });

  it("decodes a composable research-to-document contract with exact policy", function () {
    const contract = decodePlanContract(
      {
        investigation: investigation(),
        deliverable: {
          kind: "document",
          spec: {
            kind: "literature_review",
            title: "Effect review",
            requiredSections: ["Findings", "Scope and limitations"],
            requiresReferences: true,
            requiresCoverageSection: true,
            allowFigures: false,
            citationStyle: {
              styleId: "http://www.zotero.org/styles/apa",
              styleTitle: "APA",
              locale: "en-US",
            },
          },
        },
        researchPolicy: policy,
      },
      { requireSnapshot: true },
    );
    assert.equal(contract.deliverable.kind, "document");
    assert.equal(contract.investigation?.scopeSnapshot?.itemCount, 1);
    assert.deepEqual(contract.researchPolicy, policy);
  });

  it("rejects empty, mismatched, or silently widened research scopes", function () {
    const contract = (scope: unknown) => ({
      investigation: { ...investigation(), scope },
      deliverable: { kind: "answer" },
      researchPolicy: policy,
    });
    assert.throws(
      () =>
        decodePlanContract(
          contract({ libraryID: 1, kind: "items", itemKeys: [] }),
        ),
      /requires itemKeys/,
    );
    assert.throws(
      () =>
        decodePlanContract(
          contract({
            libraryID: 1,
            kind: "library",
            itemKeys: ["AAAA1111"],
          }),
        ),
      /does not accept filters/,
    );
    assert.throws(
      () => decodePlanContract(contract({ libraryID: 1, kind: "mixed" })),
      /requires at least one filter/,
    );
    assert.doesNotThrow(() =>
      decodePlanContract(contract({ libraryID: 1, kind: "library" })),
    );
  });

  it("deep-decodes action authority and rejects inconsistent capability pairs", function () {
    const valid = {
      version: 2,
      id: "contract-1",
      writeDisposition: "required",
      interpretationSource: "deterministic_fallback",
      obligations: [
        {
          id: "o1",
          capability: "zotero.tags",
          operation: "apply_tags",
          proofDomain: "zotero_state",
          coverage: "all",
          targetKind: "papers",
          parameters: { tags: ["reviewed"] },
          targetBoundary: {
            kind: "selection",
            libraryID: 1,
            frozenTargetIds: [10],
            scopeDigest: "sha256:targets",
          },
        },
      ],
    };
    assert.equal(decodeActionContract(valid).obligations[0].id, "o1");
    assert.throws(
      () =>
        decodeActionContract({
          ...valid,
          obligations: [
            { ...valid.obligations[0], capability: "zotero.notes" },
          ],
        }),
      /authority is inconsistent/,
    );
    assert.throws(
      () =>
        decodeActionContract({
          ...valid,
          obligations: [{ ...valid.obligations[0], proofDomain: "execution" }],
        }),
      /authority is inconsistent/,
    );
  });

  it("defines one exhaustive capability and proof domain for every operation", function () {
    for (const [operation, authority] of Object.entries(OPERATION_CATALOG)) {
      assert.isTrue(
        operationAuthorityIsConsistent({
          operation,
          capability: authority.capability,
          proofDomain: authority.proofDomain,
        }),
        operation,
      );
      assert.isFalse(
        operationAuthorityIsConsistent({
          operation,
          capability: authority.capability,
          proofDomain:
            authority.proofDomain === "execution"
              ? "zotero_state"
              : "execution",
        }),
        operation,
      );
    }
  });

  it("never lets an inferred contract pre-authorize research-selected targets", function () {
    const inferred: AgentActionContract = {
      version: 2,
      id: "inferred-before-research",
      writeDisposition: "required",
      interpretationSource: "classifier",
      obligations: [],
    };
    const contract = decodePlanContract(
      {
        investigation: investigation(),
        deliverable: { kind: "completion_report" },
        effects: {
          libraryMutation: {
            approval: "after_research",
            intent: {
              summary: "Tag the papers selected by the research criteria",
              targetSelectionDescription: "Included papers",
              intents: [
                {
                  capability: "zotero.tags",
                  operation: "apply_tags",
                  proofDomain: "zotero_state",
                  coverage: "all",
                  targetKind: "papers",
                  parameters: { tags: ["reviewed"] },
                },
              ],
            },
          },
        },
        researchPolicy: policy,
      },
      { requireSnapshot: true },
    );
    assert.isUndefined(resolvePreResearchActionContract(contract, inferred));
  });

  it("rejects malformed normalized research records", function () {
    assert.throws(
      () =>
        decodeResearchCorpusItem({
          version: 1,
          researchJobId: "r",
          executionId: "e",
          parentTaskId: "t",
          libraryID: 1,
          itemKey: "AAAA1111",
          ordinal: 0,
          screeningStatus: "included",
          criterionResults: { c1: "maybe" },
          inventoryRecorded: true,
          hasAbstract: true,
          attachmentItemKeys: [],
          duplicateAttachmentKeys: [],
          readable: true,
          indexed: true,
          updatedAt: 1,
        }),
      /criterion result/i,
    );
    assert.throws(
      () =>
        decodePaperFinding({
          version: 1,
          findingId: "f",
          researchJobId: "r",
          executionId: "e",
          parentTaskId: "t",
          libraryID: 1,
          itemKey: "AAAA1111",
          subquestionIds: [],
          criterionIds: [],
          findings: [],
          contradictions: [],
          negativeEvidence: [],
          limitations: [],
          evidenceRefs: [],
          sourceFingerprint: "sha256:x",
          inclusionDecision: "maybe",
          confidence: "absolute",
          unresolvedQuestions: [],
          createdAt: 1,
        }),
      /inclusion decision/,
    );
  });

  it("projects stable item and trusted PDF locator identity from read results", function () {
    const priorZotero = (globalThis as { Zotero?: unknown }).Zotero;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Items: {
        get: (itemId: number) =>
          itemId === 10
            ? { id: 10, libraryID: 1, key: "AAAA1111" }
            : itemId === 20
              ? {
                  id: 20,
                  libraryID: 1,
                  key: "PDFP2222",
                  parentID: 10,
                }
              : false,
      },
    };
    try {
      const sources = extractVerifiedReadSources({
        papers: [
          {
            paperContext: { itemId: 10, contextItemId: 20 },
            passages: [
              {
                pageIndex: 4,
                sourceFingerprint: "pdfjs:document-1",
              },
            ],
          },
        ],
      });
      assert.deepInclude(sources, {
        libraryID: 1,
        itemKey: "AAAA1111",
        attachmentItemKey: "PDFP2222",
        pageIndex: 4,
        sourceFingerprint: "pdfjs:document-1",
      });
      assert.throws(
        () =>
          decodeTaskEvidence({
            version: 2,
            evidenceId: "e",
            executionId: "x",
            taskId: "t",
            kind: "verified_read",
            verified: true,
            requirementId: "r",
            contractDigest: "d",
            payload: {
              type: "verified_read",
              reference: "read",
              sources: [{ libraryID: -1, itemKey: "AAAA1111" }],
            },
            createdAt: 1,
          }),
        /libraryID/,
      );
    } finally {
      (globalThis as { Zotero?: unknown }).Zotero = priorZotero;
    }
  });

  it("selects a readable PDF rather than a sibling cache package for a reading manifest", function () {
    const selected = selectPreferredReadingAttachment([
      {
        contextItemId: 3267,
        title: "MinerU cache.zip",
        contentType: "application/zip",
      },
      {
        contextItemId: 3268,
        title: "Paper.pdf",
        contentType: "application/pdf",
        indexingState: "indexed",
      },
    ]);

    assert.equal(selected?.contextItemId, 3268);
  });

  it("keeps an earlier body receipt visible when a later metadata read covers the same paper", function () {
    const evidence = (
      reference: string,
      createdAt: number,
      observations: TrustedReadObservation[],
    ): TaskEvidence => ({
      version: 3,
      evidenceId: reference,
      executionId: "execution",
      taskId: "task",
      kind: "verified_read",
      verified: true,
      reference,
      payload: { type: "verified_read", reference, observations },
      createdAt,
    });
    const observation = (
      observationId: string,
      capabilities: TrustedReadObservation["capabilities"],
      extra: Partial<TrustedReadObservation> = {},
    ): TrustedReadObservation => ({
      version: 1,
      observationId,
      issuer: "zotero_host",
      toolName: "paper_read",
      callDigest: `sha256:${observationId}:call`,
      inputDigest: `sha256:${observationId}:input`,
      resultDigest: `sha256:${observationId}:result`,
      libraryID: 1,
      itemKey: "AAAA1111",
      capabilities,
      certificateDigest: `sha256:${observationId}:certificate`,
      ...extra,
    });
    const selected = selectPreferredVerifiedReads(
      [
        evidence("body-read", 1, [
          observation("body-observation", ["body"], {
            attachmentItemKey: "PDFP2222",
            pageIndex: 4,
            sourceFingerprint: "pdfjs:document-1",
          }),
        ]),
        evidence("later-metadata-read", 2, [
          observation("metadata-observation", ["metadata"]),
        ]),
      ],
      new Set(["1:AAAA1111"]),
    );
    assert.equal(selected.get("1:AAAA1111")?.sourceReadRef, "body-read");
    assert.equal(selected.get("1:AAAA1111")?.evidenceDepth, "body");
    assert.equal(selected.get("1:AAAA1111")?.sources[0].pageIndex, 4);
  });

  it("requires the material research-expansion checkpoint at both policy boundaries", function () {
    assert.isTrue(
      shouldCheckpointResearchExpansion({
        approvedEstimate: 10,
        actualDeepReadCandidates: 31,
        approvedLargeCorpus: false,
        policy,
      }),
    );
    assert.isTrue(
      shouldCheckpointResearchExpansion({
        approvedEstimate: 80,
        actualDeepReadCandidates: 101,
        approvedLargeCorpus: false,
        policy,
      }),
    );
    assert.isFalse(
      shouldCheckpointResearchExpansion({
        approvedEstimate: 10,
        actualDeepReadCandidates: 29,
        approvedLargeCorpus: false,
        policy,
      }),
    );
  });

  it("requires every bound mutation obligation receipt", function () {
    const task: ExecutionTask = {
      version: 2,
      taskId: "t",
      executionId: "e",
      planStepId: "s",
      kind: "required_step",
      content: "Apply changes",
      activeForm: "Applying changes",
      acceptanceCriteria: [
        {
          criterionId: "c1",
          description: "Every target is verified",
          verifier: "mutation_receipts",
        },
      ],
      expectedEffect: "mutation",
      completionRequirements: [
        {
          requirementId: "r",
          kind: "mutation_receipts",
          criterionIds: ["c1"],
          contractDigest: "d",
        },
      ],
      obligationIds: ["o1", "o2"],
      status: "in_progress",
      attemptCount: 1,
      evidenceIds: [],
      failureReasons: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const evidence = (obligationId: string): TaskEvidence => ({
      version: 3,
      evidenceId: `e-${obligationId}`,
      executionId: "e",
      taskId: "t",
      kind: "mutation_receipt",
      verified: true,
      requirementId: "r",
      criterionIds: ["c1"],
      contractDigest: "d",
      receipt: {
        version: 2,
        id: `receipt-${obligationId}`,
        obligationId,
        proposalId: `p-${obligationId}`,
        proofDomain: "zotero_state",
        capability: "zotero.tags",
        operation: "apply_tags",
        verification: "verified",
        status: "applied",
        requestedTargets: ["1"],
        appliedTargets: ["1"],
        alreadySatisfiedTargets: [],
        rejectedTargets: [],
        reasons: [],
        verifiedFacts: ["verified"],
      },
      payload: {
        type: "mutation_receipts",
        receiptIds: [`receipt-${obligationId}`],
      },
      createdAt: 1,
    });
    assert.throws(() => assertTaskCompletionEvidence(task, [evidence("o1")]));
    assert.doesNotThrow(() =>
      assertTaskCompletionEvidence(task, [evidence("o1"), evidence("o2")]),
    );
    assert.throws(
      () =>
        decodeTaskEvidence({
          ...evidence("o1"),
          receipt: {
            ...evidence("o1").receipt,
            capability: "zotero.notes",
          },
        }),
      /authority is inconsistent/,
    );
  });

  it("requires terminal research coverage from the same task and contract", function () {
    const task: ExecutionTask = {
      version: 2,
      taskId: "research-task",
      executionId: "execution",
      planStepId: "research-step",
      kind: "required_step",
      content: "Research",
      activeForm: "Researching",
      acceptanceCriteria: [
        {
          criterionId: "coverage",
          description: "Cover the approved corpus",
          verifier: "research_coverage",
        },
      ],
      expectedEffect: "read",
      completionRequirements: [
        {
          requirementId: "coverage-requirement",
          kind: "research_coverage",
          criterionIds: ["coverage"],
          contractDigest: "sha256:contract",
        },
      ],
      obligationIds: [],
      status: "in_progress",
      attemptCount: 1,
      evidenceIds: [],
      failureReasons: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const evidence = (
      coverageStatus: "complete" | "complete_with_limitations" | "partial",
      overrides: Partial<TaskEvidence> = {},
    ): TaskEvidence => ({
      version: 3,
      evidenceId: `coverage-${coverageStatus}`,
      executionId: "execution",
      taskId: "research-task",
      kind: "research_coverage",
      verified: true,
      requirementId: "coverage-requirement",
      criterionIds: ["coverage"],
      contractDigest: "sha256:contract",
      payload: {
        type: "research_coverage",
        researchJobId: "research",
        coverageStatus,
        totalItems: 10,
        screenedItems: coverageStatus === "partial" ? 5 : 10,
        candidateItems: 4,
        deepReadCompleted: coverageStatus === "partial" ? 2 : 4,
      },
      createdAt: 1,
      ...overrides,
    });

    assert.throws(() =>
      assertTaskCompletionEvidence(task, [evidence("partial")]),
    );
    assert.throws(() =>
      assertTaskCompletionEvidence(task, [
        evidence("complete", { taskId: "another-task" }),
      ]),
    );
    assert.doesNotThrow(() =>
      assertTaskCompletionEvidence(task, [evidence("complete")]),
    );
    assert.doesNotThrow(() =>
      assertTaskCompletionEvidence(task, [
        evidence("complete_with_limitations"),
      ]),
    );
  });

  it("deep-decodes persisted skill routing receipts", function () {
    const artifact = {
      version: 1,
      planId: "plan-1",
      conversationKey: 1,
      provider: "original",
      revision: 1,
      digest: "sha256:plan",
      status: "drafting",
      skillRoutingReceipt: {
        routerSchemaVersion: 1,
        skillManifestHash: "sha256:manifest",
        skills: [
          {
            id: "literature-review",
            version: 1,
            instructionHash: "sha256:skill",
            source: "automatic",
          },
        ],
      },
      steps: [
        {
          planStepId: "step-1",
          content: "Review the evidence",
          activeForm: "Reviewing the evidence",
          acceptanceCriteria: ["Evidence reviewed"],
          expectedEffect: "read",
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    };
    assert.equal(
      decodePlanArtifact(artifact).skillRoutingReceipt?.skills[0].source,
      "automatic",
    );
    assert.throws(
      () =>
        decodePlanArtifact({
          ...artifact,
          skillRoutingReceipt: {
            ...artifact.skillRoutingReceipt,
            skills: [
              { ...artifact.skillRoutingReceipt.skills[0], source: "invented" },
            ],
          },
        }),
      /source is invalid/,
    );
  });

  it("rejects deeply invalid persisted documents and research jobs", function () {
    assert.throws(() => decodePlanDocument({ version: 1 }), /required|arrays/i);
    assert.throws(
      () =>
        decodeResearchJob({
          version: 1,
          researchJobId: "r",
          executionId: "e",
          parentTaskId: "t",
          contractDigest: "d",
          snapshotId: "s",
          policy,
          status: "running",
          activeStage: "made_up",
          totalItems: 1,
          screenedItems: 0,
          candidateItems: 0,
          deepReadCompleted: 0,
          deepReadPlanned: 1,
          createdAt: 1,
          updatedAt: 1,
        }),
      /research stage/,
    );
  });

  it("decodes direct DocumentArtifactV2 origins without inventing Plan IDs", function () {
    const decoded = decodePlanDocument({
      version: 2,
      documentId: "run-1:document:1",
      documentVersion: 1,
      documentKind: "report",
      integrityPolicy: "authored",
      origin: {
        kind: "direct",
        runId: "run-1",
        sourceMessageTimestamp: 10,
      },
      conversationKey: 1,
      title: "Report",
      visibleMarkdown: "# Report\n\nComplete.",
      visibleHtml: "<h1>Report</h1><p>Complete.</p>",
      citationBundle: {
        clusters: [],
        bibliographyEntries: [],
        style: { id: "apa", title: "APA" },
        locale: "en-US",
      },
      verifiedQuotes: [],
      assets: [],
      coverageItems: [],
      validation: {
        integrityValidated: true,
        groundingReviewed: "not_run",
        quoteVerified: "not_applicable",
        issues: [],
      },
      contentHash: "sha256:document",
      createdAt: 10,
    });
    assert.equal(decoded.version, 2);
    if (decoded.version === 2) {
      assert.equal(decoded.origin.kind, "direct");
      assert.notProperty(decoded.origin, "planId");
    }
  });

  it("keeps quote verification host-owned and deeply decodes certificates", function () {
    const tool = createSubmitPlanDocumentTool({} as ZoteroGateway);
    const required = tool.spec.inputSchema.required as string[];
    assert.include(required, "quotes");
    assert.notInclude(required, "quoteVerified");
    const document = {
      version: 1,
      documentId: "document-1",
      documentVersion: 1,
      planId: "plan-1",
      planRevision: 1,
      executionId: "execution-1",
      conversationKey: 1,
      parentTaskId: "task-1",
      contractDigest: "sha256:contract",
      title: "Review",
      visibleMarkdown: "> Verified wording",
      visibleHtml: "<blockquote>Verified wording</blockquote>",
      citationBundle: {
        clusters: [],
        bibliographyEntries: [],
        style: { id: "apa", title: "APA" },
        locale: "en-US",
      },
      verifiedQuotes: [
        {
          quoteId: "Q1",
          text: "Verified wording",
          libraryID: 1,
          itemKey: "AAAA1111",
          attachmentItemKey: "PDFP2222",
          evidenceRefs: ["evidence-1"],
          certificate: {
            contextItemId: 20,
            sourceFingerprint: "pdfjs:fingerprint",
            pageIndex: 4,
            sourceMatchText: "Verified wording",
            sourceMatchKind: "exact",
            sourceMatchPageOccurrence: 0,
          },
        },
      ],
      assets: [],
      coverageItems: [],
      validation: {
        integrityValidated: true,
        groundingReviewed: "passed",
        quoteVerified: "verified",
        issues: [],
      },
      contentHash: "sha256:document",
      createdAt: 1,
    };
    assert.equal(
      decodePlanDocument(document).verifiedQuotes[0].certificate.pageIndex,
      4,
    );
    assert.throws(
      () =>
        decodePlanDocument({
          ...document,
          verifiedQuotes: [
            {
              ...document.verifiedQuotes[0],
              certificate: {
                ...document.verifiedQuotes[0].certificate,
                pageIndex: -1,
              },
            },
          ],
        }),
      /pageIndex/,
    );
  });

  it("meets the fixed offline corpus release gates", function () {
    const fixturePath = fileURLToPath(
      new URL("./fixtures/planResearchEvaluationCorpus.json", import.meta.url),
    );
    const corpus = JSON.parse(
      readFileSync(fixturePath, "utf8"),
    ) as ResearchEvaluationCase[];
    const score = scoreResearchEvaluation(corpus);
    assert.equal(score.inventoryAccounting, 1);
    assert.isAtLeast(score.relevantPaperRecall, 0.95);
    assert.isAtMost(score.falseExclusionRate, 0.01);
    assert.equal(score.sourceRetention, 1);
    assert.equal(score.unauthorizedMutationCount, 0);
    assert.isTrue(score.passesInitialReleaseGate);
  });
});
