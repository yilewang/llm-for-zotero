import { assert } from "chai";
import { createDocumentPlan } from "../test/helpers/documentPlan";
import { PlanDocumentFinalizer } from "../src/agent/documents/planFinalization";
import { deliverPendingPlanDocumentMessage } from "../src/agent/documents/publication";
import {
  clearPlanConversationRowsInTransaction,
  listTaskEvidence,
  loadPlanExecutionLedger,
} from "../src/agent/plans/store";
import {
  clearPlanDocumentConversationRowsInTransaction,
  loadPlanDocument,
  loadPlanDocumentOutbox,
} from "../src/agent/documents/store";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";

describe("workflow: Plan document finalization", function () {
  it("persists and retries one finalized document and publishes its native evidence atomically", async function () {
    const parent = new Zotero.Item("journalArticle");
    parent.setField("title", "Plan finalization fixture");
    await parent.saveTx();
    try {
      const ledger = await createDocumentPlan(parent.id);
      const finalizer = new PlanDocumentFinalizer({} as ZoteroGateway);
      const params = {
        executionId: ledger.executionId,
        activeTaskId: ledger.activeTaskId!,
        now: 4,
        input: {
          title: "Guide",
          markdown: "# Guide\n\nA durable guide.",
          citations: [],
          quotes: [],
          assets: [],
          groundingReviewed: "passed" as const,
          groundingIssues: [],
        },
      };
      const first = await finalizer.finalize(params);
      const again = await finalizer.finalize(params);
      assert.equal(again.document.documentId, first.document.documentId);
      assert.equal(again.document.contentHash, first.document.contentHash);
      assert.equal(
        (await loadPlanDocument(first.document.documentId))!.visibleMarkdown,
        params.input.markdown,
      );
      assert.lengthOf(
        await listTaskEvidence(ledger.executionId, ledger.activeTaskId!),
        1,
      );
      await deliverPendingPlanDocumentMessage({
        conversationKey: parent.id,
        documentId: first.document.documentId,
        visibleMarkdown: params.input.markdown,
        messageTimestamp: 5,
      });
      assert.equal(
        (await loadPlanDocumentOutbox(first.document.documentId))!.status,
        "delivered",
      );
      assert.equal(
        (await loadPlanExecutionLedger(ledger.executionId))!.status,
        "completed",
      );
      assert.lengthOf(
        await listTaskEvidence(ledger.executionId, ledger.activeTaskId!),
        2,
      );
    } finally {
      await Zotero.DB.executeTransaction(async () => {
        await clearPlanDocumentConversationRowsInTransaction(parent.id);
        await clearPlanConversationRowsInTransaction(parent.id);
      });
      await parent.eraseTx();
    }
  });
});
