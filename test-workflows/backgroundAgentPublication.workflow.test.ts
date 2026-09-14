import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: background Agent document publication", function () {
  this.timeout(60000);
  for (const invalidateConversation of [false, true]) {
    it(
      invalidateConversation
        ? "does not resurrect the old answer after the source conversation generation changes"
        : "publishes the exact document to its original conversation after switching papers",
      async function () {
        const api = (Zotero as any).LLMForZotero.api
          .workflowTest as WorkflowTestApi;
        const a = await api.createPaperWithPdfFixture({
          title: "Background paper A",
          pages: ["Paper A evidence."],
        });
        const b = await api.createPaperWithPdfFixture({
          title: "Foreground paper B",
          pages: ["Paper B evidence."],
        });
        try {
          const panel = await api.renderPanelForItem(a.parentItemId);
          const result = await api.exerciseBackgroundAgentPublication({
            panelId: panel.panelId,
            paperBItemId: b.parentItemId,
            invalidateConversation,
          });
          assert.notEqual(
            result.sourceConversationKey,
            result.otherConversationKey,
          );
          assert.deepEqual(
            result.persistedConversationKeys,
            invalidateConversation ? [] : [result.sourceConversationKey],
          );
          assert.isTrue(result.exactMarkdown);
          assert.equal(
            result.outboxStatus,
            invalidateConversation ? "pending" : "delivered",
          );
          assert.isFalse(
            result.otherPanelContainsDocument,
            "background completion never repaints the newly selected paper",
          );
        } finally {
          await api.reset();
          await api.cleanupFixture(a);
          await api.cleanupFixture(b);
        }
      },
    );
  }
});
