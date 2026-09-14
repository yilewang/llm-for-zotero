import { assert } from "chai";
import { createDocumentPlan } from "../test/helpers/documentPlan";
import { PlanExecutionCoordinator } from "../src/agent/plans/coordinator";
import {
  clearPlanConversationRowsInTransaction,
  listTaskEvidence,
  loadPlanExecutionLedger,
} from "../src/agent/plans/store";
import type { TaskEvidence } from "../src/agent/plans/types";

describe("workflow: atomic Plan evidence", function () {
  it("rolls back a failed native progress update and retries without duplicating evidence", async function () {
    const parent = new Zotero.Item("journalArticle");
    parent.setField("title", "Atomic Plan evidence fixture");
    await parent.saveTx();
    const originalQuery = Zotero.DB.queryAsync;
    try {
      const ledger = await createDocumentPlan(parent.id);
      const task = ledger.tasks.find(
        (entry) => entry.taskId === ledger.activeTaskId,
      )!;
      const requirement = task.completionRequirements!.find(
        (entry) => entry.kind === "document_integrity",
      )!;
      const evidence: TaskEvidence = {
        version: 3,
        evidenceId: `${ledger.executionId}:integrity`,
        executionId: ledger.executionId,
        taskId: task.taskId,
        kind: "document_integrity",
        verified: true,
        requirementId: requirement.requirementId,
        criterionIds: requirement.criterionIds,
        contractDigest: requirement.contractDigest,
        payload: {
          type: "document_integrity",
          documentId: "fixture",
          contentHash: "sha256:fixture",
          integrityValidated: true,
        },
        summary: "Verified test document",
        createdAt: 4,
      };
      const before = await loadPlanExecutionLedger(ledger.executionId);
      Zotero.DB.queryAsync = async function (sql: string, ...args: unknown[]) {
        if (
          sql.includes(
            "INSERT OR REPLACE INTO llm_for_zotero_plan_execution_tasks",
          )
        )
          throw new Error("injected native task write failure");
        return Reflect.apply(originalQuery, Zotero.DB, [sql, ...args]);
      } as typeof Zotero.DB.queryAsync;
      const coordinator = new PlanExecutionCoordinator();
      let failure = "";
      try {
        await coordinator.attachEvidence(evidence);
      } catch (error) {
        failure = String(error);
      } finally {
        Zotero.DB.queryAsync = originalQuery;
      }
      assert.include(failure, "injected native task write failure");
      assert.deepEqual(
        await loadPlanExecutionLedger(ledger.executionId),
        before,
      );
      assert.lengthOf(
        await listTaskEvidence(ledger.executionId, task.taskId),
        0,
      );
      await coordinator.attachEvidence(evidence);
      await coordinator.attachEvidence(evidence);
      assert.lengthOf(
        await listTaskEvidence(ledger.executionId, task.taskId),
        1,
      );
      assert.deepEqual(
        (await loadPlanExecutionLedger(ledger.executionId))!.tasks[0]
          .evidenceIds,
        [evidence.evidenceId],
      );
    } finally {
      Zotero.DB.queryAsync = originalQuery;
      await Zotero.DB.executeTransaction(() =>
        clearPlanConversationRowsInTransaction(parent.id),
      );
      await parent.eraseTx();
    }
  });
});
