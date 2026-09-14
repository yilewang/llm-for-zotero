import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  initAgentPlanStore,
  savePlanArtifact,
  savePlanExecutionLedger,
} from "../src/agent/plans/store";
import type {
  ExecutionTask,
  PlanExecutionLedger,
} from "../src/agent/plans/types";
import { resolveResearchPolicy } from "../src/agent/research/policy";
import {
  initResearchStore,
  loadResearchJobForExecution,
  saveResearchCorpusItem,
  saveResearchJob,
} from "../src/agent/research/store";
import {
  assertResearchCorpusUnchanged,
  commitResearchRecords,
} from "../src/agent/research/stages";
import { listResearchCorpusItems } from "../src/agent/research/store";
import { createResearchUpdateTool } from "../src/agent/tools/plan/researchUpdate";
function reasoningTask(): ExecutionTask {
  return {
    version: 2,
    taskId: "execution-1:task-1",
    executionId: "execution-1",
    planStepId: "step-1",
    kind: "required_step",
    content: "Synthesize the evidence",
    activeForm: "Synthesizing the evidence",
    acceptanceCriteria: [
      {
        criterionId: "criterion-1",
        description: "A bounded conclusion is recorded",
        verifier: "bounded_reasoning",
      },
    ],
    expectedEffect: "reasoning",
    completionRequirements: [
      {
        requirementId: "requirement-1",
        kind: "bounded_reasoning",
        criterionIds: ["criterion-1"],
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
    startedAt: 1,
  };
}

function execution(): PlanExecutionLedger {
  return {
    version: 2,
    executionId: "execution-1",
    planId: "plan-1",
    revision: 1,
    planDigest: "sha256:plan",
    conversationKey: 41,
    attempt: 1,
    provider: "original",
    grant: {
      version: 1,
      planId: "plan-1",
      revision: 1,
      planDigest: "sha256:plan",
      conversationKey: 41,
      conversationGeneration: 1,
      approvedAt: 1,
    },
    status: "running",
    activeTaskId: "execution-1:task-1",
    tasks: [reasoningTask()],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("research stage authority through durable stores", function () {
  it("does not let a record call skip inventory and screening", async function () {
    const db = new DatabaseSync(":memory:");
    const prior = globalThis.Zotero;
    (globalThis as any).Zotero = {
      DB: {
        queryAsync: async (sql: string, args: any[] = []) => {
          const stmt = db.prepare(sql),
            v = args.map((x) => (x === undefined ? null : x));
          if (/^(SELECT|PRAGMA|WITH)/i.test(sql.trim())) return stmt.all(...v);
          stmt.run(...v);
          return [];
        },
        executeTransaction: async (fn: any) => {
          db.exec("BEGIN");
          try {
            const v = await fn();
            db.exec("COMMIT");
            return v;
          } catch (e) {
            db.exec("ROLLBACK");
            throw e;
          }
        },
      },
    };
    try {
      await initAgentPlanStore();
      await initResearchStore();
      await savePlanExecutionLedger(execution());
      const policy = resolveResearchPolicy("plan_research");
      await savePlanArtifact({
        version: 3,
        planId: "plan-1",
        conversationKey: 41,
        provider: "original",
        revision: 1,
        digest: "sha256:plan",
        status: "approved",
        contractDigest: "sha256:contract",
        steps: [
          {
            planStepId: "step-1",
            content: "Review corpus",
            activeForm: "Reviewing corpus",
            expectedEffect: "read",
            acceptanceCriteria: ["Review corpus"],
          },
        ],
        createdAt: 1,
        updatedAt: 1,
        contract: {
          deliverable: { kind: "answer" },
          researchPolicy: policy,
          investigation: {
            question: "Review corpus",
            subquestions: [{ id: "q", question: "What do papers report?" }],
            criteria: [{ id: "c", kind: "include", description: "In scope" }],
            scope: { libraryID: 1, kind: "items", itemKeys: ["AAAA1111"] },
            scopeSnapshot: {
              snapshotId: "scope-1",
              digest: "sha256:scope",
              itemCount: 1,
              createdAt: 1,
              policyVersion: 1,
            },
            requiredEvidenceDepth: "body",
            estimatedDeepReadPapers: 1,
            approvedLargeCorpus: false,
            reviewMode: "systematic",
            readingStrategy: "selected",
          },
        },
      } as any);
      await saveResearchJob(
        {
          version: 2,
          researchJobId: "research-1",
          executionId: "execution-1",
          parentTaskId: "execution-1:task-1",
          contractDigest: "sha256:contract",
          baseSnapshotId: "scope-1",
          snapshotId: "scope-1",
          scopeLineageDigest: "sha256:scope",
          policy,
          status: "running",
          activeStage: "inventory",
          totalItems: 1,
          screenedItems: 0,
          candidateItems: 0,
          deepReadCompleted: 0,
          deepReadPlanned: 1,
          createdAt: 1,
          updatedAt: 1,
        } as any,
        41,
      );
      await saveResearchCorpusItem({
        version: 1,
        researchJobId: "research-1",
        executionId: "execution-1",
        parentTaskId: "execution-1:task-1",
        libraryID: 1,
        itemKey: "AAAA1111",
        ordinal: 0,
        screeningStatus: "pending",
        criterionResults: {},
        inventoryRecorded: false,
        hasAbstract: false,
        attachmentItemKeys: [],
        duplicateAttachmentKeys: [],
        readable: false,
        indexed: false,
        updatedAt: 1,
      } as any);
      const tool = createResearchUpdateTool({} as any),
        args = {
          operation: "record_probes",
          stage: "recall_expansion",
          probes: [
            {
              probeId: "probe-1",
              kind: "semantic",
              query: "effect synonyms",
              addedTargets: [],
            },
          ],
        };
      const before = await loadResearchJobForExecution("execution-1");
      assert.isFalse(
        tool.validate(args).ok,
        "record calls cannot supply a stage",
      );
      const context = {
        request: {
          conversationKey: 41,
          planContext: {
            phase: "executing",
            executionId: "execution-1",
            activeTaskId: "execution-1:task-1",
            planId: "plan-1",
            revision: 1,
            approvedDigest: "sha256:plan",
          },
        },
      } as any;
      let message = "";
      try {
        await tool.execute(
          { operation: "record_probes", probes: args.probes },
          context,
        );
      } catch (error) {
        message = String(error);
      }
      assert.include(message, "Recall probes may only");
      const advance = tool.validate({
        operation: "set_stage",
        stage: "broad_screening",
      });
      assert.isTrue(advance.ok);
      message = "";
      if (advance.ok)
        try {
          await tool.execute(advance.value, context);
        } catch (error) {
          message = String(error);
        }
      assert.include(message, "Inventory");
      assert.deepEqual(
        await loadResearchJobForExecution("execution-1"),
        before,
      );
      const originalCorpus = await listResearchCorpusItems({
        researchJobId: "research-1",
      });
      await saveResearchCorpusItem({
        ...originalCorpus[0],
        inventoryRecorded: true,
        updatedAt: 2,
      });
      let committed = false;
      try {
        await commitResearchRecords(before!, async () => {
          await assertResearchCorpusUnchanged(before!, originalCorpus);
          committed = true;
        });
      } catch (error) {
        assert.include(String(error), "records changed");
      }
      assert.isFalse(
        committed,
        "stale record updates must not overwrite newer durable work",
      );
    } finally {
      globalThis.Zotero = prior;
      db.close();
    }
  });
});
