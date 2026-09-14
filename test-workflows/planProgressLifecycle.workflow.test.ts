import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: plan progress lifecycle", function () {
  this.timeout(120000);
  it("removes completed progress and never recreates it on history refresh", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Plan progress lifecycle",
      pages: ["Synthetic lifecycle evidence."],
    });
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const result = await api.exerciseStreamingReplay({
        panelId: panel.panelId,
        historyTurns: 2,
        chunks: 2,
      });
      Zotero.debug(`PLAN_LIFECYCLE ${JSON.stringify(result)}`, 1);
      assert.deepEqual(result.pausedProgressNodes, [0, 0, 0]);
      assert.isTrue(result.resumeStartsProgress);
      assert.equal(result.inactiveProgressReads, 0);
      assert.equal(
        result.completedProgressNodes,
        0,
        "completion unmounts progress",
      );
      assert.equal(
        result.reopenedProgressNodes,
        0,
        "history cannot recreate progress",
      );
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
