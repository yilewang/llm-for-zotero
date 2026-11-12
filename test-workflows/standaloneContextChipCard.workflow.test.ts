import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: context chip hover card", function () {
  this.timeout(60000);
  let api: WorkflowTestApi;
  let fixture: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  >;

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    fixture = await api.createPaperWithPdfFixture({
      title: "Chip card",
      pdfTitle: "Chip card PDF",
    });
  });

  afterEach(async function () {
    await api.closeStandalone();
    if (fixture) await api.cleanupFixture(fixture);
    await api.reset();
  });

  type Card = Awaited<
    ReturnType<WorkflowTestApi["exerciseContextChipCardVisibility"]>
  >;

  function assertVisible(card: Card, surface: string) {
    assert.isAbove(card.cardWidth, 50, `${surface}: card has width`);
    assert.isAbove(card.cardHeight, 10, `${surface}: card has height`);
    assert.isTrue(
      card.hitIsCard,
      `${surface}: card is not clipped (hit ${card.hitDescription}, ${JSON.stringify(card)})`,
    );
    assert.isAtMost(
      card.cardBottom,
      card.rowTop + 1,
      `${surface}: card sits above the chip row`,
    );
    assert.isAtLeast(card.cardTop, 0, `${surface}: card is inside the window`);
  }

  it("shows the selected-text card in the sidebar and the standalone window alike", async function () {
    const selectedText = "A highlighted sentence that the chip card previews.";
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const sidebar = await api.exerciseContextChipCardVisibility({
      panelId: panel.panelId,
      standalone: false,
      selectedText,
    });
    await api.openStandaloneForItem(fixture.parentItemId);
    const standalone = await api.exerciseContextChipCardVisibility({
      standalone: true,
      selectedText,
    });
    assertVisible(sidebar, "sidebar");
    assertVisible(standalone, "standalone");
    assert.closeTo(standalone.leftInset, sidebar.leftInset, 2, "left inset");
    assert.closeTo(standalone.rightInset, sidebar.rightInset, 2, "right inset");
    assert.closeTo(
      standalone.rowTop - standalone.cardBottom,
      sidebar.rowTop - sidebar.cardBottom,
      2,
      "gap above the chip row",
    );
  });
});
