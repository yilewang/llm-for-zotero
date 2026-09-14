import { semanticContractFixture } from "./helpers/semanticIntent";
import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { decodePlanContract } from "../src/agent/plans/contracts";
import { createApproveResearchExpansionTool } from "../src/agent/tools/plan/approveResearchExpansion";
import {
  classifyPlanAmendmentAuthority,
  classifyPlanAmendmentAuthorityForProvider,
  PlanAmendmentService,
  type PlanAmendmentDecision,
} from "../src/agent/plans/amendments";
import { buildAgentTraceDisplayItems } from "../src/modules/contextPanel/agentTrace/render";
import type { AgentRunEventRecord } from "../src/agent/store/traceStore";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import { stateChangeInvocationPlan } from "../src/agent/authorization/invocationPlan";
import type { AgentActionContract } from "../src/agent/contracts/types";
import { createAmendPlanTool } from "../src/agent/tools/plan/amendPlan";
import { createUpdatePlanTool } from "../src/agent/tools/plan/updatePlan";
import {
  ZOTERO_MCP_PLAN_TOOL_NAMES,
  ZOTERO_MCP_WRITE_TOOL_NAMES,
} from "../src/agent/mcp/server";
import { buildResearchScopeSuccessorSnapshot } from "../src/agent/research/scopeSnapshot";
import { decodeResearchJob } from "../src/agent/research/decoders";
import { resolveResearchPolicy } from "../src/agent/research/policy";
import { decodePlanAmendmentGrant } from "../src/agent/plans/planAmendmentTypes";
import {
  initAgentPlanStore,
  listPlanAmendmentGrants,
  loadPlanArtifact,
  loadPlanExecutionLedger,
  PLAN_AMENDMENT_PROPOSALS_TABLE,
  savePlanExecutionLedger,
  saveTaskEvidence,
} from "../src/agent/plans/store";
import {
  initResearchStore,
  listResearchCorpusItems,
  listResearchEvidence,
  listScopeSnapshotItems,
  listThemeFindings,
  loadScopeSnapshotRef,
  loadResearchJobForExecution,
  savePaperFinding,
  saveResearchCorpusItem,
  saveResearchEvidence,
  saveResearchJob,
  saveScopeSnapshot,
  saveThemeFinding,
} from "../src/agent/research/store";
import { PlanExecutionCoordinator } from "../src/agent/plans/coordinator";
import { resolvePlanContract } from "../src/agent/tools/plan/updatePlan";

function installSqliteZotero() {
  const db = new DatabaseSync(":memory:");
  let failSqlIncludes = "";
  const writes: string[] = [];
  const bindable = (params: unknown[] | undefined) =>
    (params || []).map((value) => (value === undefined ? null : value));
  globalThis.Zotero = {
    DB: {
      queryAsync: async (sql: string, params?: unknown[]) => {
        if (failSqlIncludes && sql.includes(failSqlIncludes)) {
          throw new Error("injected amendment persistence failure");
        }
        const statement = db.prepare(sql);
        const normalized = sql.trimStart().toUpperCase();
        if (
          normalized.startsWith("SELECT") ||
          normalized.startsWith("PRAGMA") ||
          normalized.startsWith("WITH")
        ) {
          return statement.all(...(bindable(params) as never[]));
        }
        writes.push(normalized.replace(/\s+/g, " "));
        statement.run(...(bindable(params) as never[]));
        return [];
      },
      executeTransaction: async (task: () => Promise<unknown>) => {
        db.exec("BEGIN");
        try {
          const result = await task();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
  } as never;
  return {
    db,
    writes,
    clearWrites() {
      writes.length = 0;
    },
    failNext(sql: string) {
      failSqlIncludes = sql;
    },
    clearFailure() {
      failSqlIncludes = "";
    },
  };
}

function researchContract(scope: Record<string, unknown>) {
  return {
    version: 1,
    deliverable: { kind: "answer" },
    investigation: {
      question: "Which papers report the effect?",
      subquestions: [{ id: "q1", question: "What was reported?" }],
      criteria: [],
      reviewMode: "narrative",
      readingStrategy: "adaptive",
      scope,
      requiredEvidenceDepth: "body",
      estimatedDeepReadPapers: 0,
      approvedLargeCorpus: false,
    },
  };
}

describe("autonomous Plan scope amendments", function () {
  const originalZotero = globalThis.Zotero;

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  it("decodes item scopes conservatively and source scopes as expandable", function () {
    const itemContract = decodePlanContract(
      researchContract({
        libraryID: 1,
        kind: "items",
        itemKeys: ["AAAA1111"],
      }),
      { requireSnapshot: false },
    );
    const sourceContract = decodePlanContract(
      researchContract({
        libraryID: 1,
        kind: "collections",
        collectionIds: [2],
      }),
      { requireSnapshot: false },
    );

    assert.equal(itemContract.investigation?.scopeAmendmentPolicy, "fixed");
    assert.equal(
      sourceContract.investigation?.scopeAmendmentPolicy,
      "within_source",
    );
  });

  it("uses the explicit scope-amendment policy when it is valid", function () {
    const raw = researchContract({
      libraryID: 1,
      kind: "mixed",
      collectionIds: [2],
      itemKeys: ["AAAA1111"],
    });
    (raw.investigation as Record<string, unknown>).scopeAmendmentPolicy =
      "fixed";
    const decoded = decodePlanContract(raw, { requireSnapshot: false });
    assert.equal(decoded.investigation?.scopeAmendmentPolicy, "fixed");
    assert.throws(
      () =>
        decodePlanContract(
          {
            ...raw,
            investigation: {
              ...raw.investigation,
              scopeAmendmentPolicy: "model_decides",
            },
          },
          { requireSnapshot: false },
        ),
      /scopeAmendmentPolicy/,
    );
  });

  it("deeply validates persisted amendment variants", function () {
    assert.throws(
      () =>
        decodePlanAmendmentGrant({
          version: 1,
          grantId: "grant-1",
          authority: "auto_policy",
          status: "authorized",
          authorizedAt: 1,
          proposal: {
            version: 1,
            amendmentId: "amendment-1",
            proposalDigest: "sha256:proposal",
            kind: "research_scope",
            goalImpact: "within_goal",
            planId: "plan-1",
            planRevision: 1,
            planDigest: "sha256:plan",
            executionId: "execution-1",
            executionDigest: "sha256:execution",
            conversationKey: 1,
            previousScopeDigest: "sha256:old",
            resultingScopeDigest: "sha256:new",
            targetSetDigest: "sha256:targets",
            proposalPayloadDigest: "sha256:payload",
            addedTargets: ["not-a-target"],
            rationale: "Expand inside the approved collection.",
            createdAt: 1,
          },
        }),
      /addedTargets/,
    );
  });

  it("commits a proposal and its authorization grant atomically", async function () {
    const harness = installSqliteZotero();
    try {
      await initAgentPlanStore();
      const service = new PlanAmendmentService();
      const proposal = await service.buildProposal({
        kind: "research_ceiling",
        goalImpact: "deep_read",
        planId: "plan-1",
        planRevision: 1,
        planDigest: "sha256:plan",
        executionId: "execution-1",
        executionDigest: "sha256:execution",
        conversationKey: 1,
        previousScopeDigest: "sha256:scope",
        resultingScopeDigest: "sha256:scope",
        targetSetDigest: "sha256:targets",
        proposalPayloadDigest: "sha256:payload",
        proposedDeepReadCeiling: 12,
        rationale: "Twelve papers qualify.",
        now: 1,
      });
      harness.failNext("INSERT OR IGNORE INTO llm_for_zotero_plan_amendments");
      let failure: unknown;
      try {
        await service.authorize(proposal, "auto_policy", 2);
      } catch (error) {
        failure = error;
      }
      assert.match(String(failure), /injected amendment persistence failure/);
      assert.equal(
        Number(
          harness.db
            .prepare(
              `SELECT COUNT(*) AS count FROM ${PLAN_AMENDMENT_PROPOSALS_TABLE}`,
            )
            .get()?.count,
        ),
        0,
      );
    } finally {
      harness.db.close();
    }
  });

  it("never overwrites an immutable child scope snapshot", async function () {
    const harness = installSqliteZotero();
    try {
      await initResearchStore();
      const ref = {
        snapshotId: "plan-1:r1:scope:child",
        digest: "sha256:child",
        itemCount: 1,
        createdAt: 2,
        policyVersion: 1,
        parentSnapshotId: "plan-1:r1:scope",
        scopeLineageDigest: "sha256:lineage",
      };
      const item = {
        snapshotId: ref.snapshotId,
        libraryID: 1,
        itemKey: "AAAA1111",
        ordinal: 0,
      };
      await saveScopeSnapshot({
        planId: "plan-1",
        revision: 1,
        conversationKey: 1,
        ref,
        items: [item],
      });
      let failure: unknown;
      try {
        await saveScopeSnapshot({
          planId: "plan-1",
          revision: 1,
          conversationKey: 1,
          ref: { ...ref, digest: "sha256:changed" },
          items: [{ ...item, itemKey: "BBBB2222" }],
        });
      } catch (error) {
        failure = error;
      }
      assert.match(String(failure), /immutable/i);
      assert.equal(
        (await loadScopeSnapshotRef(ref.snapshotId))?.digest,
        ref.digest,
      );
      assert.deepEqual(
        (await listScopeSnapshotItems(ref.snapshotId)).map(
          (entry) => entry.itemKey,
        ),
        ["AAAA1111"],
      );
    } finally {
      harness.db.close();
    }
  });

  it("applies an in-source corpus amendment without discarding valid paper evidence", async function () {
    const harness = installSqliteZotero();
    try {
      await initAgentPlanStore();
      await initResearchStore();
      let sourceIds = [1];
      const items = new Map([
        [
          1,
          {
            id: 1,
            key: "AAAA1111",
            libraryID: 1,
            version: 1,
            getField: () => "",
            getCreators: () => [],
          },
        ],
        [
          2,
          {
            id: 2,
            key: "BBBB2222",
            libraryID: 1,
            version: 1,
            getField: () => "",
            getCreators: () => [],
          },
        ],
      ]);
      globalThis.Zotero = {
        ...(globalThis.Zotero as object),
        Items: {
          getByLibraryAndKey: (libraryID: number, itemKey: string) =>
            [...items.values()].find(
              (item) => item.libraryID === libraryID && item.key === itemKey,
            ) || false,
        },
      } as never;
      const gateway = {
        resolveLibraryScopeItemIds: async () => ({ itemIds: [...sourceIds] }),
        getBibliographicItemTargetsByItemIds: (ids: number[]) =>
          ids.map((id) => ({
            itemId: id,
            title: `Paper ${id}`,
            firstCreator: "Author",
            year: "2026",
            tags: [],
            attachments: [],
          })),
        getItem: (id: number) => items.get(id) || null,
      } as never;
      const steps = [
        {
          planStepId: "research-plan:r1:read",
          content: "Read the research corpus",
          activeForm: "Reading the research corpus",
          acceptanceCriteria: [
            {
              criterionId: "read",
              description: "Every paper has verified evidence",
              verifier: "verified_read" as const,
            },
          ],
          expectedEffect: "read" as const,
        },
        {
          planStepId: "research-plan:r1:synthesize",
          content: "Synthesize the research corpus",
          activeForm: "Synthesizing the research corpus",
          acceptanceCriteria: [
            {
              criterionId: "coverage",
              description: "Research coverage is terminal",
              verifier: "research_coverage" as const,
            },
          ],
          expectedEffect: "reasoning" as const,
        },
        {
          planStepId: "research-plan:r1:answer",
          content: "Write the answer",
          activeForm: "Writing the answer",
          acceptanceCriteria: [
            {
              criterionId: "answer",
              description: "The answer is complete",
              verifier: "bounded_reasoning" as const,
            },
          ],
          expectedEffect: "reasoning" as const,
        },
      ];
      const contract = await resolvePlanContract({
        raw: researchContract({
          libraryID: 1,
          kind: "collections",
          collectionIds: [11],
        }),
        steps,
        ready: true,
        gateway,
        planId: "research-plan",
        revision: 1,
        conversationKey: 5,
      });
      const coordinator = new PlanExecutionCoordinator();
      const artifact = await coordinator.updateDraft({
        planId: "research-plan",
        conversationKey: 5,
        provider: "original",
        revision: 1,
        steps,
        contract,
        ready: true,
        now: 1,
      });
      const ledger = await coordinator.approve({
        planId: "research-plan",
        revision: 1,
        conversationGeneration: 1,
        now: 2,
      });
      const job = await loadResearchJobForExecution(ledger.executionId);
      assert.exists(job);
      const priorCorpus = (
        await listResearchCorpusItems({ researchJobId: job!.researchJobId })
      )[0];
      await saveResearchCorpusItem({
        ...priorCorpus,
        screeningStatus: "included",
        inventoryRecorded: true,
        sourceFingerprint: "sha256:paper-1",
        updatedAt: 3,
      });
      await saveResearchEvidence({
        version: 1,
        evidenceRef: "evidence-paper-1",
        researchJobId: job!.researchJobId,
        executionId: ledger.executionId,
        parentTaskId: job!.parentTaskId,
        libraryID: 1,
        itemKey: "AAAA1111",
        sourceFingerprint: "sha256:paper-1",
        sourceKind: "body",
        createdAt: 3,
      });
      await savePaperFinding({
        version: 1,
        findingId: "finding-paper-1",
        researchJobId: job!.researchJobId,
        executionId: ledger.executionId,
        parentTaskId: job!.parentTaskId,
        libraryID: 1,
        itemKey: "AAAA1111",
        subquestionIds: ["q1"],
        criterionIds: [],
        findings: ["Paper 1 reports the effect."],
        contradictions: [],
        negativeEvidence: [],
        limitations: [],
        evidenceRefs: ["evidence-paper-1"],
        sourceFingerprint: "sha256:paper-1",
        inclusionDecision: "include",
        confidence: "high",
        unresolvedQuestions: [],
        createdAt: 3,
      });
      await saveThemeFinding({
        version: 2,
        themeFindingId: "theme-old-scope",
        researchJobId: job!.researchJobId,
        executionId: ledger.executionId,
        parentTaskId: job!.parentTaskId,
        title: "Old aggregate",
        synthesis: "Only the old scope was synthesized.",
        paperFindingIds: ["finding-paper-1"],
        evidenceRefs: ["evidence-paper-1"],
        limitations: [],
        scopeLineageDigest: job!.scopeLineageDigest,
        status: "valid",
        createdAt: 3,
      });
      await saveResearchJob(
        {
          ...job!,
          status: "completed",
          activeStage: "hierarchical_synthesis",
          coverageStatus: "complete",
          screenedItems: 1,
          candidateItems: 1,
          deepReadCompleted: 1,
          completedAt: 3,
          updatedAt: 3,
        },
        5,
      );
      sourceIds = [1, 2];

      const result = await new PlanAmendmentService(
        gateway,
      ).applyResearchScopeAmendment({
        plan: {
          phase: "executing",
          planId: artifact.planId,
          revision: artifact.revision,
          executionId: ledger.executionId,
          approvedDigest: artifact.digest,
          provider: "original",
        },
        conversationKey: 5,
        addedTargets: [{ libraryID: 1, itemKey: "BBBB2222" }],
        rationale: "Paper 2 was added to the approved collection.",
        authority: "auto_policy",
        now: 4,
      });

      assert.equal(result.previousItemCount, 1);
      assert.equal(result.newItemCount, 2);
      assert.equal(result.grant.status, "applied");
      assert.notEqual(result.job.snapshotId, job!.snapshotId);
      assert.equal(
        (await loadScopeSnapshotRef(result.job.snapshotId))?.parentSnapshotId,
        job!.snapshotId,
      );
      assert.equal(
        artifact.contract?.investigation?.scopeSnapshot?.snapshotId,
        job!.snapshotId,
      );
      const corpus = await listResearchCorpusItems({
        researchJobId: job!.researchJobId,
      });
      assert.equal(corpus[0].screeningStatus, "included");
      assert.equal(corpus[1].screeningStatus, "pending");
      assert.lengthOf(await listResearchEvidence(job!.researchJobId), 1);
      assert.lengthOf(await listThemeFindings(job!.researchJobId), 0);
      const amendedLedger = await loadPlanExecutionLedger(ledger.executionId);
      assert.equal(amendedLedger?.tasks[0].status, "in_progress");
      const coverageRequirement = amendedLedger?.tasks
        .flatMap((task) => task.completionRequirements || [])
        .find((requirement) => requirement.kind === "research_coverage");
      assert.equal(
        coverageRequirement?.targetBoundary?.scopeDigest,
        result.job.scopeLineageDigest,
      );
      const readingRequirement = amendedLedger?.tasks
        .flatMap((task) => task.completionRequirements || [])
        .find((requirement) => requirement.kind === "verified_read");
      assert.equal(
        readingRequirement?.targetBoundary?.scopeDigest,
        result.job.scopeLineageDigest,
      );
    } finally {
      harness.db.close();
    }
  });

  it("persists a contract-revision grant before creating its successor execution", async function () {
    const harness = installSqliteZotero();
    try {
      await initAgentPlanStore();
      await initResearchStore();
      const coordinator = new PlanExecutionCoordinator();
      const baseContract = { deliverable: { kind: "answer" as const } };
      const baseStep = {
        planStepId: "plan-1:r1:s1",
        content: "Answer the approved question",
        activeForm: "Answering the approved question",
        acceptanceCriteria: [
          {
            criterionId: "answer-1",
            description: "The answer is complete",
            verifier: "bounded_reasoning" as const,
          },
        ],
        expectedEffect: "reasoning" as const,
      };
      const baseArtifact = await coordinator.updateDraft({
        planId: "plan-1",
        conversationKey: 1,
        provider: "original",
        revision: 1,
        steps: [baseStep],
        contract: baseContract,
        ready: true,
        now: 1,
      });
      const predecessor = await coordinator.approve({
        planId: "plan-1",
        revision: 1,
        conversationGeneration: 1,
        now: 2,
      });
      const replacementContract = {
        deliverable: { kind: "completion_report" as const },
      };
      const replacementStep = {
        ...baseStep,
        planStepId: "plan-1:r2:s1",
        content: "Publish the revised completion report",
        activeForm: "Publishing the revised completion report",
      };
      const successorArtifact = await coordinator.updateDraft({
        planId: "plan-1",
        conversationKey: 1,
        provider: "original",
        revision: 2,
        steps: [replacementStep],
        contract: replacementContract,
        ready: true,
        now: 3,
      });
      const service = new PlanAmendmentService();
      const proposal = await service.buildProposal({
        kind: "contract_revision",
        goalImpact: "contract_revision",
        planId: "plan-1",
        planRevision: 1,
        planDigest: baseArtifact.digest,
        executionId: predecessor.executionId,
        executionDigest: await service.executionIdentityDigest(predecessor),
        conversationKey: 1,
        previousScopeDigest: baseArtifact.contractDigest || baseArtifact.digest,
        resultingScopeDigest:
          successorArtifact.contractDigest || successorArtifact.digest,
        targetSetDigest: await service.digest(replacementContract.deliverable),
        proposalPayloadDigest: await service.digest({
          contract: successorArtifact.contract,
          steps: successorArtifact.steps,
        }),
        replacementContract: successorArtifact.contract,
        replacementSteps: successorArtifact.steps,
        rationale: "The requested deliverable changed.",
        now: 3,
      });
      await service.stageProposal(proposal, "awaiting_approval", 3);
      harness.clearWrites();

      const successor = await coordinator.approve({
        planId: "plan-1",
        revision: 2,
        conversationGeneration: 1,
        now: 4,
      });

      const amendmentWrite = harness.writes.findIndex((sql) =>
        sql.includes("LLM_FOR_ZOTERO_PLAN_AMENDMENTS"),
      );
      const executionWrite = harness.writes.findIndex(
        (sql) =>
          sql.includes("LLM_FOR_ZOTERO_PLAN_EXECUTIONS") &&
          sql.includes("INSERT"),
      );
      assert.isAtLeast(amendmentWrite, 0);
      assert.isAtLeast(executionWrite, 0);
      assert.isBelow(amendmentWrite, executionWrite);
      assert.equal(
        (await loadPlanExecutionLedger(predecessor.executionId))?.status,
        "superseded",
      );
      assert.equal(successor.predecessorExecutionId, predecessor.executionId);
      assert.equal((await loadPlanArtifact("plan-1", 1))?.status, "superseded");
      assert.equal(
        (await listPlanAmendmentGrants(predecessor.executionId))[0]?.status,
        "applied",
      );
      let lateEvidenceError: unknown;
      try {
        await coordinator.attachEvidence({
          version: 1,
          evidenceId: "late-evidence",
          executionId: predecessor.executionId,
          taskId: predecessor.tasks[0].taskId,
          kind: "reasoning_assertion",
          verified: true,
          summary: "This must not attach after supersession.",
          createdAt: 5,
        });
      } catch (error) {
        lateEvidenceError = error;
      }
      assert.match(String(lateEvidenceError), /superseded/);
    } finally {
      harness.db.close();
    }
  });

  it("rolls back successor creation and can retry the same exact grant after migration fails", async function () {
    const harness = installSqliteZotero();
    try {
      await initAgentPlanStore();
      await initResearchStore();
      const coordinator = new PlanExecutionCoordinator();
      const baseContract = { deliverable: { kind: "answer" as const } };
      const step = {
        planStepId: "plan-retry:r1:s1",
        content: "Answer the approved question",
        activeForm: "Answering the approved question",
        acceptanceCriteria: [
          {
            criterionId: "answer-1",
            description: "The answer is complete",
            verifier: "bounded_reasoning" as const,
          },
        ],
        expectedEffect: "reasoning" as const,
      };
      const baseArtifact = await coordinator.updateDraft({
        planId: "plan-retry",
        conversationKey: 2,
        provider: "original",
        revision: 1,
        steps: [step],
        contract: baseContract,
        ready: true,
        now: 1,
      });
      const predecessor = await coordinator.approve({
        planId: "plan-retry",
        revision: 1,
        conversationGeneration: 1,
        now: 2,
      });
      const successorArtifact = await coordinator.updateDraft({
        planId: "plan-retry",
        conversationKey: 2,
        provider: "original",
        revision: 2,
        steps: [
          {
            ...step,
            planStepId: "plan-retry:r2:s1",
            content: "Publish the revised report",
            activeForm: "Publishing the revised report",
          },
        ],
        contract: { deliverable: { kind: "completion_report" } },
        ready: true,
        now: 3,
      });
      const service = new PlanAmendmentService();
      const proposal = await service.buildProposal({
        kind: "contract_revision",
        goalImpact: "contract_revision",
        planId: "plan-retry",
        planRevision: 1,
        planDigest: baseArtifact.digest,
        executionId: predecessor.executionId,
        executionDigest: await service.executionIdentityDigest(predecessor),
        conversationKey: 2,
        previousScopeDigest: baseArtifact.contractDigest || baseArtifact.digest,
        resultingScopeDigest:
          successorArtifact.contractDigest || successorArtifact.digest,
        targetSetDigest: await service.digest(
          successorArtifact.contract?.deliverable,
        ),
        proposalPayloadDigest: await service.digest({
          contract: successorArtifact.contract,
          steps: successorArtifact.steps,
        }),
        replacementContract: successorArtifact.contract,
        replacementSteps: successorArtifact.steps,
        rationale: "The requested deliverable changed.",
        now: 3,
      });
      await service.stageProposal(proposal, "awaiting_approval", 3);
      harness.failNext("FROM llm_for_zotero_research_jobs");

      let failure: unknown;
      try {
        await coordinator.approve({
          planId: "plan-retry",
          revision: 2,
          conversationGeneration: 1,
          now: 4,
        });
      } catch (error) {
        failure = error;
      }
      assert.match(String(failure), /injected amendment persistence failure/);
      assert.equal(
        (await loadPlanArtifact("plan-retry", 2))?.status,
        "awaiting_approval",
      );
      assert.equal(
        Number(
          harness.db
            .prepare(
              "SELECT COUNT(*) AS count FROM llm_for_zotero_plan_executions WHERE plan_id = ? AND revision = 2",
            )
            .get("plan-retry")?.count,
        ),
        0,
      );
      assert.notEqual(
        (await loadPlanExecutionLedger(predecessor.executionId))?.status,
        "superseded",
      );
      assert.equal(
        (await listPlanAmendmentGrants(predecessor.executionId))[0]?.status,
        "failed",
      );

      harness.clearFailure();
      const retried = await coordinator.approve({
        planId: "plan-retry",
        revision: 2,
        conversationGeneration: 1,
        now: 5,
      });
      assert.equal(retried.predecessorExecutionId, predecessor.executionId);
      assert.equal(
        (await loadPlanExecutionLedger(predecessor.executionId))?.status,
        "superseded",
      );
      assert.equal(
        (await listPlanAmendmentGrants(predecessor.executionId))[0]?.status,
        "applied",
      );
    } finally {
      harness.db.close();
    }
  });

  it("keeps the amendment lineage when the user revises the reviewable successor", async function () {
    const harness = installSqliteZotero();
    try {
      await initAgentPlanStore();
      await initResearchStore();
      const coordinator = new PlanExecutionCoordinator();
      const step = (revision: number, content: string) => ({
        planStepId: `plan-reviewed:r${revision}:s1`,
        content,
        activeForm: content,
        acceptanceCriteria: [
          {
            criterionId: `answer-${revision}`,
            description: content,
            verifier: "bounded_reasoning" as const,
          },
        ],
        expectedEffect: "reasoning" as const,
      });
      const baseArtifact = await coordinator.updateDraft({
        planId: "plan-reviewed",
        conversationKey: 4,
        provider: "original",
        revision: 1,
        steps: [step(1, "Answer the original question")],
        contract: { deliverable: { kind: "answer" } },
        ready: true,
        now: 1,
      });
      const predecessor = await coordinator.approve({
        planId: "plan-reviewed",
        revision: 1,
        conversationGeneration: 1,
        now: 2,
      });
      const firstSuccessor = await coordinator.updateDraft({
        planId: "plan-reviewed",
        conversationKey: 4,
        provider: "original",
        revision: 2,
        steps: [step(2, "Draft a completion report")],
        contract: { deliverable: { kind: "completion_report" } },
        ready: true,
        now: 3,
      });
      const service = new PlanAmendmentService();
      const proposal = await service.buildProposal({
        kind: "contract_revision",
        goalImpact: "contract_revision",
        planId: "plan-reviewed",
        planRevision: 1,
        planDigest: baseArtifact.digest,
        executionId: predecessor.executionId,
        executionDigest: await service.executionIdentityDigest(predecessor),
        conversationKey: 4,
        previousScopeDigest: baseArtifact.contractDigest || baseArtifact.digest,
        resultingScopeDigest:
          firstSuccessor.contractDigest || firstSuccessor.digest,
        targetSetDigest: await service.digest(
          firstSuccessor.contract?.deliverable,
        ),
        proposalPayloadDigest: await service.digest({
          contract: firstSuccessor.contract,
          steps: firstSuccessor.steps,
        }),
        replacementContract: firstSuccessor.contract,
        replacementSteps: firstSuccessor.steps,
        rationale: "The requested deliverable changed.",
        now: 3,
      });
      await service.stageProposal(proposal, "awaiting_approval", 3);

      await coordinator.updateDraft({
        planId: "plan-reviewed",
        conversationKey: 4,
        provider: "original",
        revision: 3,
        steps: [step(3, "Publish the user-revised completion report")],
        contract: { deliverable: { kind: "completion_report" } },
        ready: true,
        now: 4,
      });
      const successor = await coordinator.approve({
        planId: "plan-reviewed",
        revision: 3,
        conversationGeneration: 1,
        now: 5,
      });

      assert.equal(successor.predecessorExecutionId, predecessor.executionId);
      assert.equal(
        (await loadPlanExecutionLedger(predecessor.executionId))?.status,
        "superseded",
      );
      assert.equal(
        (await listPlanAmendmentGrants(predecessor.executionId))[0]?.proposal
          .replacementSteps?.[0]?.content,
        "Publish the user-revised completion report",
      );
    } finally {
      harness.db.close();
    }
  });

  it("marks a successor mutation task complete when verified receipts carry forward", async function () {
    const harness = installSqliteZotero();
    try {
      await initAgentPlanStore();
      await initResearchStore();
      const makeTask = (
        executionId: string,
        taskId: string,
        status: "completed" | "pending",
      ) => ({
        version: 2 as const,
        taskId,
        executionId,
        planStepId: `${taskId}:step`,
        kind: "required_step" as const,
        content: "Apply the approved tag",
        activeForm: "Applying the approved tag",
        acceptanceCriteria: [
          {
            criterionId: "mutation-complete",
            description: "The tag is verified",
            verifier: "mutation_receipts" as const,
          },
        ],
        expectedEffect: "mutation" as const,
        expectedCapability: "zotero.tags",
        completionRequirements: [
          {
            requirementId: `${taskId}:receipt`,
            kind: "mutation_receipts" as const,
            criterionIds: ["mutation-complete"],
            contractDigest: "sha256:contract",
          },
        ],
        obligationIds: ["tag-obligation"],
        status,
        attemptCount: status === "completed" ? 1 : 0,
        evidenceIds: status === "completed" ? ["receipt-evidence"] : [],
        failureReasons: [],
        createdAt: 1,
        updatedAt: 1,
        completedAt: status === "completed" ? 1 : undefined,
      });
      const oldTask = makeTask("execution-old", "task-old", "completed");
      const newTask = makeTask("execution-new", "task-new", "pending");
      await savePlanExecutionLedger({
        version: 2,
        executionId: "execution-old",
        planId: "plan-effects",
        revision: 1,
        planDigest: "sha256:old-plan",
        conversationKey: 3,
        attempt: 1,
        provider: "original",
        actionContractId: "action-contract-1",
        grant: {
          version: 1,
          planId: "plan-effects",
          revision: 1,
          planDigest: "sha256:old-plan",
          conversationKey: 3,
          conversationGeneration: 1,
          actionContractId: "action-contract-1",
          authority: "user",
          approvedAt: 1,
        },
        status: "completed",
        tasks: [oldTask],
        createdAt: 1,
        updatedAt: 1,
        completedAt: 1,
      });
      await savePlanExecutionLedger({
        version: 2,
        executionId: "execution-new",
        planId: "plan-effects",
        revision: 2,
        planDigest: "sha256:new-plan",
        conversationKey: 3,
        attempt: 1,
        provider: "original",
        actionContractId: "action-contract-1",
        grant: {
          version: 1,
          planId: "plan-effects",
          revision: 2,
          planDigest: "sha256:new-plan",
          conversationKey: 3,
          conversationGeneration: 1,
          actionContractId: "action-contract-1",
          authority: "user",
          approvedAt: 2,
        },
        status: "pending",
        tasks: [newTask],
        createdAt: 2,
        updatedAt: 2,
      });
      await saveTaskEvidence({
        version: 3,
        evidenceId: "receipt-evidence",
        executionId: "execution-old",
        taskId: "task-old",
        kind: "mutation_receipt",
        verified: true,
        requirementId: "task-old:receipt",
        criterionIds: ["mutation-complete"],
        contractDigest: "sha256:contract",
        receipt: {
          version: 2,
          id: "receipt-1",
          obligationId: "tag-obligation",
          proposalId: "proposal-1",
          proofDomain: "zotero_state",
          capability: "zotero.tags",
          operation: "apply_tags",
          verification: "verified",
          status: "applied",
          requestedTargets: ["item:1"],
          appliedTargets: ["item:1"],
          alreadySatisfiedTargets: [],
          rejectedTargets: [],
          reasons: [],
          verifiedFacts: ["Tag verified on item 1"],
        },
        payload: {
          type: "mutation_receipts",
          receiptIds: ["receipt-1"],
        },
        createdAt: 1,
      });

      await new PlanAmendmentService().migrateSuccessorExecutionState({
        predecessorExecutionId: "execution-old",
        successorExecutionId: "execution-new",
        now: 3,
      });

      const migrated = await loadPlanExecutionLedger("execution-new");
      assert.equal(migrated?.tasks[0].status, "completed");
      assert.deepEqual(migrated?.tasks[0].evidenceIds, [
        "execution-new:migrated:receipt-evidence",
      ]);
    } finally {
      harness.db.close();
    }
  });

  it("maps eligible amendments to the selected Original Agent mode", function () {
    const fixture = (mode: "safe" | "auto" | "yolo"): PlanAmendmentDecision =>
      classifyPlanAmendmentAuthority({
        mode,
        goalImpact: "within_goal",
        hardBlocked: false,
      });

    assert.deepEqual(fixture("safe"), {
      kind: "confirm",
      authority: "user",
    });
    assert.deepEqual(fixture("auto"), {
      kind: "execute",
      authority: "auto_policy",
    });
    assert.deepEqual(fixture("yolo"), {
      kind: "execute",
      authority: "yolo",
    });
    assert.equal(
      classifyPlanAmendmentAuthority({
        mode: "yolo",
        goalImpact: "within_goal",
        hardBlocked: true,
      }).kind,
      "block",
    );
  });

  it("keeps action-scope eligibility and mode authority in the amendment service", function () {
    const service = new PlanAmendmentService();
    const failure = {
      code: "added_target" as const,
      message: "A source-scoped target was added.",
      expectedCount: 1,
      proposedCount: 2,
      rejectedTargets: [],
      missingTargets: [],
      amendableObligation: {
        obligationId: "tag-obligation",
        libraryID: 1,
        boundaryKind: "collection" as const,
        previousTargetIds: [1],
        currentTargetIds: [1, 2],
        addedTargetIds: [2],
      },
    };
    const base = {
      planContext: {
        phase: "executing" as const,
        planId: "plan-1",
        revision: 1,
        executionId: "execution-1",
        approvedDigest: "sha256:plan",
        provider: "original" as const,
      },
      failure,
      actionImpact: "state_change" as const,
      riskSignals: [] as string[],
      hasHardConstraints: false,
    };

    assert.deepEqual(
      service.decideActionScopeAmendment({
        ...base,
        originalMode: "auto",
      }),
      { kind: "execute", authority: "auto_policy" },
    );
    assert.equal(
      service.decideActionScopeAmendment({
        ...base,
        originalMode: "yolo",
        riskSignals: ["protected_target"],
      }).kind,
      "block",
    );
    assert.equal(
      service.decideActionScopeAmendment({
        ...base,
        originalMode: "auto",
        failure: { ...failure, code: "fixed_selection" },
      }).kind,
      "block",
    );
  });

  it("grants yolo judgment for unmatched conversation writes and keeps the rails", function () {
    const service = new PlanAmendmentService();
    const failure = {
      code: "different_operation" as const,
      message: "Action apply_tags does not match any authorized obligation.",
      expectedCount: 1,
      proposedCount: 1,
      rejectedTargets: [],
      missingTargets: [],
    };
    const base = {
      planContext: undefined,
      failure,
      actionImpact: "state_change" as const,
      riskSignals: [] as string[],
      hasHardConstraints: false,
    };
    for (const code of [
      "different_operation",
      "different_parameters",
      "scope_mismatch",
      "fixed_selection",
      "added_target",
      "incomplete_batch",
    ] as const) {
      assert.deepEqual(
        service.decideActionScopeAmendment({
          ...base,
          originalMode: "yolo",
          failure: { ...failure, code },
        }),
        { kind: "execute", authority: "yolo_judgment" },
        code,
      );
    }
    for (const code of [
      "hard_constraint",
      "protected_target",
      "closed_obligation",
      "stale_scope",
      "workflow_dependency",
      "missing_typed_proposal",
    ] as const) {
      assert.equal(
        service.decideActionScopeAmendment({
          ...base,
          originalMode: "yolo",
          failure: { ...failure, code },
        }).kind,
        "block",
        code,
      );
    }
    assert.equal(
      service.decideActionScopeAmendment({
        ...base,
        originalMode: "yolo",
        riskSignals: ["protected_target"],
      }).kind,
      "block",
    );
    assert.equal(
      service.decideActionScopeAmendment({
        ...base,
        originalMode: "yolo",
        actionImpact: "prohibited",
      }).kind,
      "block",
    );
    // A present-but-unviolated hard constraint does not block judgment; the
    // policy blocks violating proposals before this decision is consulted.
    assert.equal(
      service.decideActionScopeAmendment({
        ...base,
        originalMode: "yolo",
        hasHardConstraints: true,
      }).kind,
      "execute",
    );
    for (const mode of ["safe", "auto"] as const) {
      assert.equal(
        service.decideActionScopeAmendment({ ...base, originalMode: mode })
          .kind,
        "block",
        mode,
      );
    }
  });

  it("requires review for semantic revision in Safe and Auto but not YOLO", function () {
    for (const mode of ["safe", "auto"] as const) {
      assert.deepEqual(
        classifyPlanAmendmentAuthority({
          mode,
          goalImpact: "contract_revision",
          hardBlocked: false,
        }),
        { kind: "review", authority: "user" },
      );
    }
    assert.deepEqual(
      classifyPlanAmendmentAuthority({
        mode: "yolo",
        goalImpact: "contract_revision",
        hardBlocked: false,
      }),
      { kind: "execute", authority: "yolo" },
    );
  });

  it("keeps native provider permission independent from the Original Agent preference", function () {
    assert.deepEqual(
      classifyPlanAmendmentAuthorityForProvider({
        provider: "codex",
        originalMode: "safe",
        goalImpact: "within_goal",
        hardBlocked: false,
      }),
      { kind: "execute", authority: "user" },
    );
    assert.deepEqual(
      classifyPlanAmendmentAuthorityForProvider({
        provider: "claude",
        originalMode: "yolo",
        goalImpact: "contract_revision",
        hardBlocked: false,
      }),
      { kind: "review", authority: "user" },
    );
  });

  it("never lets a successor revision remove an explicit hard prohibition", function () {
    const service = new PlanAmendmentService();
    const priorActionContract: AgentActionContract = {
      version: 3,
      id: "no-write-contract",
      writeDisposition: "none",
      interpretationSource: "classifier",
      hardConstraints: [
        {
          kind: "no_write",
          description: "Do not change the Zotero library.",
        },
      ],
      obligations: [],
    };
    assert.throws(
      () =>
        service.assertContractRevisionHardBoundaries({
          priorActionContract,
          replacementHasEffects: true,
        }),
      /explicit no-write prohibition/,
    );
    assert.doesNotThrow(() =>
      service.assertContractRevisionHardBoundaries({
        priorActionContract,
        replacementHasEffects: false,
      }),
    );
  });

  it("shows the accurate Safe card and bypasses it in Auto and YOLO", async function () {
    const tool = createApproveResearchExpansionTool();
    const context = {
      request: resolvedAgentRequest({
        conversationKey: 1,
        mode: "agent",
        userText: "Review this collection",
        planContext: {
          phase: "executing",
          planId: "plan-1",
          revision: 1,
          executionId: "execution-1",
          approvedDigest: "sha256:plan",
          provider: "original",
        },
      }),
      item: null,
      currentAnswerText: "",
      modelName: "gpt-5",
    };
    const input = { proposedDeepReadCeiling: 24, reason: "24 papers qualify" };
    const prefs = new Map<string, unknown>();
    globalThis.Zotero = {
      ...originalZotero,
      Prefs: { get: (key: string) => prefs.get(key) },
    } as typeof Zotero;

    const card = await tool.createPendingAction?.(input, context);
    assert.equal(card?.title, "More scoped papers qualify for deep reading.");

    for (const [mode, expected] of [
      ["safe", true],
      ["auto", false],
      ["yolo", false],
    ] as const) {
      prefs.set(
        "extensions.zotero.llmforzotero.originalAgentPermissionMode",
        mode,
      );
      assert.equal(
        await tool.shouldRequireConfirmation?.(input, context),
        expected,
      );
    }
  });

  it("renders an autonomous amendment as a nonblocking trace row", function () {
    const events = [
      {
        id: 1,
        runId: "run-1",
        sequence: 1,
        createdAt: 1,
        payload: {
          type: "plan_scope_amended",
          amendmentId: "amendment-1",
          executionId: "execution-1",
          mode: "auto",
          rationale:
            "A newly eligible paper remains in the approved collection.",
          previousItemCount: 4,
          newItemCount: 5,
          authority: "auto_policy",
        },
      },
    ] as AgentRunEventRecord[];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const row = items.find(
      (item) =>
        item.type === "action" && item.row.text.includes("Scope amended"),
    );
    assert.exists(row);
    assert.notInclude(JSON.stringify(items), "confirmation");
    assert.include(JSON.stringify(row), "4 to 5");
    assert.include(JSON.stringify(row), "auto_policy");
  });

  it("does not describe a user-authorized Safe amendment as automatic", function () {
    const events = [
      {
        id: 1,
        runId: "run-1",
        sequence: 1,
        createdAt: 1,
        payload: {
          type: "plan_scope_amended",
          amendmentId: "amendment-safe",
          executionId: "execution-1",
          mode: "safe",
          rationale: "The user approved the added paper.",
          previousItemCount: 4,
          newItemCount: 5,
          authority: "user",
        },
      },
    ] as AgentRunEventRecord[];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const row = items.find(
      (item) =>
        item.type === "action" && item.row.text.includes("Scope amended"),
    );
    assert.exists(row);
    assert.notInclude(JSON.stringify(row), "amended automatically");
  });

  it("exposes one validated amend_plan control over the Plan MCP write surface", function () {
    const tool = createAmendPlanTool({} as never, new PlanAmendmentService());
    assert.include(ZOTERO_MCP_PLAN_TOOL_NAMES, "amend_plan");
    assert.include(ZOTERO_MCP_WRITE_TOOL_NAMES, "amend_plan");
    assert.equal(tool.spec.executionClass, "control");
    assert.isTrue(
      tool.validate({
        kind: "research_scope",
        rationale: "A new paper is now in the approved collection.",
        addedTargets: [{ libraryID: 1, itemKey: "BBBB2222" }],
      }).ok,
    );
    assert.isFalse(
      tool.validate({
        kind: "research_scope",
        rationale: "Missing exact identity.",
        addedTargets: [{ libraryID: 1 }],
      }).ok,
    );
  });

  it("lets Auto and YOLO authorize an exact in-source action addition while Safe pauses", async function () {
    class FakeAmendments extends PlanAmendmentService {
      authorities: string[] = [];
      override async authorizeActionScopeAmendment(params: any): Promise<any> {
        this.authorities.push(params.authority);
        return {
          version: 1,
          grantId: "grant-1",
          authority: params.authority,
          status: "authorized",
          authorizedAt: 1,
          proposal: {
            version: 1,
            amendmentId: "amendment-1",
            proposalDigest: "sha256:proposal",
            kind: "action_scope",
            goalImpact: "within_goal",
            planId: "plan-1",
            planRevision: 1,
            planDigest: "sha256:plan",
            executionId: "execution-1",
            executionDigest: "sha256:execution",
            conversationKey: 1,
            previousScopeDigest: "sha256:old",
            resultingScopeDigest: "sha256:new",
            targetSetDigest: "sha256:targets",
            proposalPayloadDigest: params.actionProposal.payloadDigest,
            addedActionTargets: ["item:3"],
            rationale: "Item 3 remains inside collection 11.",
            createdAt: 1,
          },
        };
      }
      override async markApplied(grant: any): Promise<any> {
        return { ...grant, status: "applied", appliedAt: 2 };
      }
      override async markFailed(grant: any): Promise<any> {
        return { ...grant, status: "failed", failedAt: 2 };
      }
      override async actionScopeGrantMatches(): Promise<boolean> {
        return true;
      }
    }

    const gateway = {
      listCurrentCollectionSummaries: () => [
        {
          collectionId: 11,
          libraryID: 1,
          name: "Review",
          path: "Review",
        },
      ],
      listCollectionSummaries: () => [],
      listCurrentCollectionTargetIds: () => [1, 2, 3],
      getItem: (id: number) => ({
        id,
        libraryID: 1,
        isRegularItem: () => true,
      }),
    };
    const contract: AgentActionContract = semanticContractFixture({
      version: 3,
      id: "contract-1",
      writeDisposition: "required",
      interpretationSource: "classifier",
      obligations: [
        {
          id: "tag-review",
          reviewPreference: "default",
          capability: "zotero.tags",
          operation: "apply_tags",
          proofDomain: "zotero_state",
          coverage: "all",
          targetKind: "papers",
          parameters: { tags: ["reviewed"] },
          scope: {
            kind: "collection",
            libraryID: 1,
            collectionId: 11,
            collectionPath: "Review",
            includeDescendants: false,
          },
          targetBoundary: {
            kind: "collection",
            libraryID: 1,
            frozenTargetIds: [1, 2],
            scopeDigest: "v1:collection:1:1:2",
          },
        },
      ],
    });
    for (const mode of ["safe", "auto", "yolo"] as const) {
      const amendments = new FakeAmendments();
      globalThis.Zotero = {
        DB: new ChangeJournalTestDb(),
        Prefs: { get: () => mode },
        debug: () => undefined,
      } as never;
      await initAgentChangeJournal();
      const contracts = new ActionContractService(gateway as never);
      const registry = new AgentToolRegistry(contracts, amendments);
      registry.register({
        spec: {
          name: "tag_scope",
          description: "Tag the approved source",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        planInvocation: () =>
          stateChangeInvocationPlan({
            domains: ["zotero_library"],
            effects: ["modify"],
            targets: ["item:1", "item:2", "item:3"],
            reason: "Apply the approved tag.",
          }),
        describeAction: () => [
          {
            id: "apply-tags",
            proofDomain: "zotero_state",
            capability: "zotero.tags",
            operation: "apply_tags",
            source: "zotero_native",
            parameters: { tags: ["reviewed"] },
            requestedTargets: ["item:1", "item:2", "item:3"],
            destinationCollectionIds: [],
          },
        ],
        execute: async () => ({ content: { applied: 3 }, effect: "applied" }),
      });
      const progress = contracts.createProgress(contract);
      const prepared = await registry.prepareExecution(
        { id: `call-${mode}`, name: "tag_scope", arguments: {} },
        {
          request: resolvedAgentRequest({
            conversationKey: 1,
            mode: "agent",
            userText: "Tag every paper in Review",
            actionContract: contract,
            actionProgress: progress,
            planContext: {
              phase: "executing",
              planId: "plan-1",
              revision: 1,
              executionId: "execution-1",
              approvedDigest: "sha256:plan",
              provider: "original",
            },
          }),
          item: null,
          currentAnswerText: "",
          modelName: "gpt-5",
          runId: `run-${mode}`,
          checkpointActionProgress: async () => undefined,
        },
      );
      if (mode === "safe") {
        assert.equal(prepared.kind, "confirmation");
        assert.deepEqual(amendments.authorities, []);
        if (prepared.kind === "confirmation") {
          const executed = await prepared.execute({ approved: true });
          assert.equal(executed.kind, "result");
          if (executed.kind === "result") {
            assert.include(
              executed.execution.result.actionReceipts?.[0].requestedTargets ||
                [],
              "item:3",
            );
          }
        }
        assert.deepEqual(amendments.authorities, ["user"]);
      } else {
        assert.equal(prepared.kind, "result");
        if (prepared.kind === "result") {
          assert.include(
            prepared.execution.result.actionReceipts?.[0].requestedTargets ||
              [],
            "item:3",
          );
        }
        assert.deepEqual(amendments.authorities, [
          mode === "auto" ? "auto_policy" : "yolo",
        ]);
      }
    }
  });

  it("builds an immutable child snapshot only for bibliographic additions inside the approved source", async function () {
    const items = new Map([
      [1, { id: 1, key: "AAAA1111", libraryID: 1 }],
      [2, { id: 2, key: "BBBB2222", libraryID: 1 }],
      [3, { id: 3, key: "CCCC3333", libraryID: 2 }],
    ]);
    const byKey = new Map([...items.values()].map((item) => [item.key, item]));
    globalThis.Zotero = {
      Items: {
        getByLibraryAndKey: (libraryID: number, itemKey: string) => {
          const item = byKey.get(itemKey);
          return item?.libraryID === libraryID ? item : false;
        },
      },
    } as never;
    const gateway = {
      resolveLibraryScopeItemIds: async () => ({ itemIds: [1, 2] }),
      getBibliographicItemTargetsByItemIds: (ids: number[]) =>
        ids
          .filter((id) => id !== 3)
          .map((id) => ({
            itemId: id,
            title: `Paper ${id}`,
            firstCreator: "Author",
            year: "2026",
            tags: [],
            attachments: [],
          })),
      getItem: (id: number) => {
        const item = items.get(id);
        return item
          ? {
              ...item,
              version: 1,
              getField: () => "",
              getCreators: () => [],
            }
          : null;
      },
    } as never;
    const priorRef = {
      snapshotId: "plan-1:r1:scope",
      digest: "sha256:old",
      itemCount: 1,
      createdAt: 1,
      policyVersion: 1,
    };
    const priorItems = [
      {
        snapshotId: priorRef.snapshotId,
        libraryID: 1,
        itemKey: "AAAA1111",
        localItemId: 1,
        ordinal: 0,
        metadataFingerprint: "sha256:old-paper",
      },
    ];
    const successor = await buildResearchScopeSuccessorSnapshot({
      gateway,
      planId: "plan-1",
      revision: 1,
      priorRef,
      priorItems,
      scope: { libraryID: 1, kind: "collections", collectionIds: [11] },
      addedTargets: [{ libraryID: 1, itemKey: "BBBB2222" }],
      priorLineageDigest: "sha256:lineage-old",
      now: 2,
    });

    assert.equal(successor.ref.parentSnapshotId, priorRef.snapshotId);
    assert.equal(successor.ref.itemCount, 2);
    assert.notEqual(successor.ref.snapshotId, priorRef.snapshotId);
    assert.match(successor.ref.scopeLineageDigest || "", /^sha256:/);
    assert.deepEqual(
      successor.items.map((item) => item.itemKey),
      ["AAAA1111", "BBBB2222"],
    );
    assert.equal(successor.addedItems[0].ordinal, 1);

    let rejected: unknown;
    try {
      await buildResearchScopeSuccessorSnapshot({
        gateway,
        planId: "plan-1",
        revision: 1,
        priorRef,
        priorItems,
        scope: { libraryID: 1, kind: "collections", collectionIds: [11] },
        addedTargets: [{ libraryID: 2, itemKey: "CCCC3333" }],
        priorLineageDigest: "sha256:lineage-old",
      });
    } catch (error) {
      rejected = error;
    }
    assert.match(String(rejected), /crosses the approved Zotero library/);
  });

  it("decodes legacy research jobs as a conservative one-snapshot lineage", function () {
    const job = decodeResearchJob({
      version: 1,
      researchJobId: "research-1",
      executionId: "execution-1",
      parentTaskId: "task-1",
      contractDigest: "sha256:contract",
      snapshotId: "snapshot-1",
      policy: resolveResearchPolicy("plan_research"),
      status: "running",
      activeStage: "inventory",
      totalItems: 1,
      screenedItems: 0,
      candidateItems: 0,
      deepReadCompleted: 0,
      deepReadPlanned: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    assert.equal(job.baseSnapshotId, "snapshot-1");
    assert.equal(job.scopeLineageDigest, "legacy:snapshot-1");
  });

  it("lets a plan declare reviewPreference on a mutation intent", function () {
    const tool = createUpdatePlanTool();
    const schema = JSON.stringify(tool.spec.inputSchema);
    assert.include(
      schema,
      '"reviewPreference":{"type":"string","enum":["default","review","direct"]',
    );
  });
});
