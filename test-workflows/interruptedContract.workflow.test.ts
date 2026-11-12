import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: an interrupted run's legacy action contract", function () {
  this.timeout(60000);
  it("does not reach the next turn, its tool, or its model", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const suffix = Date.now();
    const legacyRunId = `legacy-run-${suffix}`;
    const legacyContractId = `legacy-contract-${suffix}`;
    const tag = `interrupted-contract-${suffix}`;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Interrupted contract fixture",
      pages: ["Disposable interrupted contract fixture."],
    });
    try {
      await api.reset();
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const item = Zotero.Items.get(fixture.parentItemId);
      assert.isFalse(item.hasTag(tag));
      const result = await api.exerciseInterruptedLegacyContract({
        panelId: panel.panelId,
        legacyRunId,
        legacyContractId,
        tag,
      });

      assert.equal(result.legacyRun.status, "failed");
      assert.equal(
        result.legacyRun.finalText,
        "Agent run interrupted before completion.",
      );
      const allPrompts = result.prompts.join("\n");
      assert.include(
        allPrompts,
        `Recovery note for interrupted run ${legacyRunId}`,
        "positive control: the turn recovered from the interrupted run",
      );
      assert.notInclude(
        allPrompts,
        legacyContractId,
        "the model is never shown the old contract",
      );
      assert.equal(result.runStatus, "completed");
      assert.equal(
        result.contractEvents,
        0,
        "the turn records no contract of its own",
      );

      // Native post-state: one tag, one verified write receipt.
      await item.reload(["tags"], true);
      assert.lengthOf(
        item.getTags().filter((entry) => entry.tag === tag),
        1,
      );
      const rows = (await Zotero.DB.queryAsync(
        `SELECT COUNT(*) AS n FROM itemTags JOIN tags USING (tagID)
         WHERE tags.name = ? AND itemTags.itemID = ?`,
        [tag, item.id],
      )) as Array<{ n: number }>;
      assert.equal(Number(rows[0].n), 1);
      assert.lengthOf(result.toolResults, 1, "the write runs once");
      assert.isTrue(result.toolResults[0].ok);
      assert.deepEqual(
        result.toolResults[0].receipts.map((receipt) => receipt.verification),
        ["verified"],
      );
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
