import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: plan history loading", function () {
  this.timeout(120000);
  for (const historyTurns of [2, 20]) {
    it(`retains loaded documents while hydrating ${historyTurns} historical plans`, async function () {
      const api = (Zotero as any).LLMForZotero.api
        .workflowTest as WorkflowTestApi;
      const fixture = await api.createPaperWithPdfFixture({
        title: "Plan history performance",
        pages: ["Synthetic evidence."],
      });
      try {
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        const result = await api.exercisePlanHistoryReplay({
          panelId: panel.panelId,
          historyTurns,
        });
        Zotero.debug(`PLAN_HISTORY ${JSON.stringify(result)}`, 1);
        await Zotero.File.putContentsAsync(
          `/tmp/plan-history-${historyTurns}.json`,
          JSON.stringify(result),
        );
        assert.isTrue(
          result.documentRetained,
          "trace hydration retains the final document",
        );
        assert.isTrue(
          result.userRetained,
          "trace hydration retains unrelated messages",
        );
        assert.isTrue(result.inputPreserved);
        assert.isTrue(result.retainedOnOwnRefresh);
        assert.isTrue(result.staleDocumentLoadIgnored);
        assert.equal(result.documentReads, result.initialDocumentReads);
        assert.equal(result.documentMounts, 1);
        assert.equal(result.documentPaints, 1);
        assert.equal(result.planPaints, historyTurns);
        assert.equal(result.planReads, historyTurns * result.mountedPanels);
        assert.equal(result.ledgerReads, 0);
        assert.equal(result.progressNodes, 0);
      } finally {
        await api.reset();
        await api.cleanupFixture(fixture);
      }
    });
  }
});
