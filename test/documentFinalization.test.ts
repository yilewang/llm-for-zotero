import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { createDocumentPlan } from "./helpers/documentPlan";
import { PlanDocumentFinalizer } from "../src/agent/documents/planFinalization";
import { DirectDocumentFinalizer } from "../src/agent/documents/directFinalization";
import { deliverPendingPlanDocumentMessage } from "../src/agent/documents/publication";
import {
  initPlanDocumentStore,
  loadPlanDocument,
  loadPlanDocumentOutbox,
} from "../src/agent/documents/store";
import {
  initAgentPlanStore,
  listTaskEvidence,
  loadPlanExecutionLedger,
} from "../src/agent/plans/store";
import { initResearchStore } from "../src/agent/research/store";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type { AgentRuntimeRequest } from "../src/agent/types";
import { canonicalJson } from "../src/agent/services/libraryMutation/canonicalJson";
import { sha256Text } from "../src/agent/store/journalRecoveryBlobStore";

describe("document finalization persistence", function () {
  const globals = globalThis as typeof globalThis & { Zotero?: unknown };
  let original: unknown;
  let db: DatabaseSync;
  beforeEach(async function () {
    original = globals.Zotero;
    db = new DatabaseSync(":memory:");
    globals.Zotero = {
      DB: {
        queryAsync: async (sql: string, params: unknown[] = []) => {
          const statement = db.prepare(sql);
          const values = params.map((value) =>
            value === undefined ? null : value,
          ) as never[];
          if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql))
            return statement.all(...values);
          statement.run(...values);
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
    };
    await initAgentPlanStore();
    await initPlanDocumentStore();
    await initResearchStore();
  });
  afterEach(function () {
    globals.Zotero = original;
    db.close();
  });

  for (const origin of ["planned", "direct"] as const) {
    it(`preserves ${origin} document identity, hash, retry and publication`, async function () {
      const plan =
        origin === "planned" ? await createDocumentPlan() : undefined;
      const input = {
        title: "Guide",
        markdown: "# Guide\n\nAn exact saved guide.",
        citations: [],
        quotes: [],
        assets: [],
        groundingReviewed: "passed" as const,
        groundingIssues: [],
      };
      const gateway = {} as ZoteroGateway;
      const finalize = () =>
        plan
          ? new PlanDocumentFinalizer(gateway).finalize({
              executionId: plan.executionId,
              activeTaskId: plan.activeTaskId!,
              input,
              now: 4,
            })
          : new DirectDocumentFinalizer(gateway).finalize({
              request: {
                conversationKey: 41,
                documentOutcomePolicy: {
                  required: true,
                  documentKind: "guide",
                  integrityPolicy: "authored",
                  trigger: "document_intent",
                },
              } as AgentRuntimeRequest,
              runId: "guide-run",
              input,
              now: 4,
            });
      const originalQuery = Zotero.DB.queryAsync;
      const failedWrite = plan
        ? "INSERT OR REPLACE INTO llm_for_zotero_plan_execution_tasks"
        : "INSERT INTO llm_for_zotero_plan_document_outbox";
      Zotero.DB.queryAsync = (async (sql: string, params?: unknown[]) => {
        if (sql.includes(failedWrite))
          throw new Error("injected finalization write failure");
        return originalQuery(sql, params);
      }) as typeof Zotero.DB.queryAsync;
      let failure = "";
      try {
        await finalize();
      } catch (error) {
        failure = String(error);
      } finally {
        Zotero.DB.queryAsync = originalQuery;
      }
      assert.include(failure, "injected finalization write failure");
      for (const table of [
        "llm_for_zotero_plan_documents",
        "llm_for_zotero_plan_document_outbox",
        "llm_for_zotero_plan_task_evidence",
      ]) {
        assert.equal(
          Number(
            db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count,
          ),
          0,
          `${table} rolls back with the failed finalization`,
        );
      }
      if (plan)
        assert.deepEqual(
          (await loadPlanExecutionLedger(plan.executionId))!.tasks[0]
            .evidenceIds,
          [],
        );
      const first = await finalize();
      const retried = await finalize();
      assert.equal(retried.document.documentId, first.document.documentId);
      assert.equal(
        first.document.documentId,
        plan ? `${plan.planId}:r1:document:1` : "guide-run:document:1",
      );
      assert.equal(retried.document.contentHash, first.document.contentHash);
      assert.equal(first.document.visibleMarkdown, input.markdown);
      assert.equal(
        first.document.validation.groundingReviewed,
        plan ? "passed" : "not_run",
      );
      assert.equal(
        first.document.contentHash,
        `sha256:${await sha256Text(canonicalJson({ title: input.title, markdown: input.markdown, citations: first.document.citationBundle, verifiedQuotes: [], assets: [], coverageItems: [], validation: first.document.validation }))}`,
      );
      assert.equal(
        (await loadPlanDocument(first.document.documentId))?.visibleMarkdown,
        input.markdown,
      );
      if (plan)
        assert.lengthOf(
          await listTaskEvidence(plan.executionId, plan.activeTaskId!),
          1,
        );
      await deliverPendingPlanDocumentMessage({
        conversationKey: 41,
        documentId: first.document.documentId,
        visibleMarkdown: input.markdown,
        messageTimestamp: 5,
      });
      assert.equal(
        (await loadPlanDocumentOutbox(first.document.documentId))?.status,
        "delivered",
      );
      if (plan)
        assert.equal(
          (await loadPlanExecutionLedger(plan.executionId))?.status,
          "completed",
        );
    });
  }
});
