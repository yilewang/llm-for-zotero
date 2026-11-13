import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

const DECLINE = { action: "decline", content: null, _meta: null };

async function journalActionCount(): Promise<number> {
  const rows = (await Zotero.DB.queryAsync(
    "SELECT COUNT(*) AS n FROM llm_for_zotero_agent_journal_actions_v2",
  )) as Array<{ n: number }>;
  return Number(rows[0].n);
}

describe("workflow: Codex approval bridge fails closed", function () {
  this.timeout(60000);
  it("declines a Zotero write when the card is unavailable or the panel owner is stale", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const tag = `codex-approval-${Date.now()}`;
    const paperA = await api.createPaperWithPdfFixture({
      title: "Codex approval fixture A",
      pages: ["Disposable approval fixture A."],
    });
    const paperB = await api.createPaperWithPdfFixture({
      title: "Codex approval fixture B",
      pages: ["Disposable approval fixture B."],
    });
    try {
      await api.reset();
      const panel = await api.renderPanelForItem(paperA.parentItemId);
      const journalBefore = await journalActionCount();
      const result = await api.exerciseCodexApprovalFailClosed({
        panelId: panel.panelId,
        itemId: paperA.parentItemId,
        tag,
        otherItemId: paperB.parentItemId,
      });

      // (a) The chat box is gone: no card, a decline, a plain status.
      assert.deepEqual(result.unavailable.response, DECLINE);
      assert.include(
        result.unavailable.statuses.at(-1)?.text,
        "approval UI was unavailable",
      );
      assert.equal(result.unavailable.statuses.at(-1)?.kind, "error");
      assert.equal(result.unavailable.cardsAfter, 0);

      // (c) The card was open, the panel switched, the user approved.
      assert.isAtLeast(
        result.staleWhileOpen.cardsWhilePending,
        1,
        "the real inline card was shown while the panel was current",
      );
      assert.isTrue(
        result.staleWhileOpen.cardWasRendered,
        "the old card still offered Approve after the switch",
      );
      // The switch detaches the old card, so the Approve click here is the
      // late answer of a user who pressed Approve as the panel changed owner.
      assert.deepEqual(result.staleWhileOpen.response, DECLINE);
      assert.equal(result.staleWhileOpen.cardsAfter, 0);
      // Observed: after the switch the pending call does not settle until the
      // user answers or the turn aborts; it never approves on its own.
      assert.isFalse(result.staleWhileOpen.settledOnItsOwn);

      // (b) The panel already belongs to paper B: no card, a decline.
      assert.deepEqual(result.alreadyStale.response, DECLINE);
      assert.equal(result.alreadyStale.cardsAfter, 0);
      assert.deepEqual(result.alreadyStale.statuses, []);

      // Native state: nothing was written.
      const item = Zotero.Items.get(paperA.parentItemId);
      assert.isFalse(item.hasTag(tag));
      assert.equal(await journalActionCount(), journalBefore);
    } finally {
      await api.reset();
      await api.cleanupFixture(paperA);
      await api.cleanupFixture(paperB);
    }
  });
});
