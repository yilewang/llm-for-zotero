import { assert } from "chai";
import { createSearchLiteratureReviewAction } from "../src/agent/reviewCards";
import type { AgentToolContext } from "../src/agent/types";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";

describe("workflow: literature review action visibility", function () {
  this.timeout(60000);

  it("shows a paper-only shortlist, live import count and exact selection in the actual Zotero stylesheet", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Literature selection visibility fixture",
      pages: ["Disposable paper selection fixture."],
    });
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const doc = Zotero.getMainWindow().document;
      const context: AgentToolContext = {
        request: resolvedAgentRequest({
          conversationKey: fixture.parentItemId,
          activeItemId: fixture.parentItemId,
          libraryID: 1,
          mode: "agent",
          userText: "Find related papers",
        }),
        item: Zotero.Items.get(fixture.parentItemId),
        currentAnswerText: "",
        modelName: "workflow",
      };
      const action = createSearchLiteratureReviewAction(
        {
          callId: "visibility-search",
          name: "literature_search",
          ok: true,
          content: {
            mode: "search",
            source: "OpenAlex",
            query: "population coding",
            results: Array.from({ length: 5 }, (_, i) => ({
              title: `Ranked paper ${i + 1}`,
              doi: `10.1000/fixture-${i}`,
              year: 2024,
              relevanceReason: "Shares the measured decoding method.",
            })),
          },
        },
        context,
        { destinationLabel: "My Library › Research", targetCollectionId: 79 },
      )!;
      const pending = api.renderPendingActionForPanel(panel.panelId, {
        requestId: "literature-visibility",
        action,
      });
      const card = doc.querySelector<HTMLElement>(
        '[data-request-id="literature-visibility"]',
      )!;
      assert.isTrue(card.classList.contains("llm-plan-container"));
      assert.equal(
        card.querySelector(".llm-plan-title")?.textContent,
        action.title,
        "paper selection uses the same header as plans and saved notes",
      );
      const reference = doc.createElement("div");
      reference.className = "llm-plan-container";
      card.parentElement!.appendChild(reference);
      const cardStyle = doc.defaultView!.getComputedStyle(card);
      const referenceStyle = doc.defaultView!.getComputedStyle(reference);
      for (const property of [
        "border-radius",
        "background-color",
        "padding",
        "box-shadow",
      ])
        assert.equal(
          cardStyle.getPropertyValue(property),
          referenceStyle.getPropertyValue(property),
          property,
        );
      reference.remove();
      const fields = Array.from(
        card.querySelectorAll<HTMLElement>(".llm-agent-hitl-field"),
      );
      const visibleLabels = () =>
        fields
          .filter(
            (field) =>
              doc.defaultView!.getComputedStyle(field).display !== "none",
          )
          .map(
            (field) =>
              field.querySelector(".llm-agent-hitl-label")?.textContent,
          );
      assert.deepEqual(
        visibleLabels(),
        ["Papers"],
        "import must not expose note drafts or search configuration",
      );
      assert.notExists(card.querySelector("textarea"));
      assert.include(card.textContent, "My Library › Research");
      const button = card.querySelector<HTMLButtonElement>(
        '[data-action-id="import"]',
      )!;
      assert.isTrue(button.classList.contains("llm-plan-action"));
      assert.isTrue(button.classList.contains("llm-plan-approve"));
      assert.equal(
        doc.defaultView!.getComputedStyle(
          card.querySelector(".llm-agent-hitl-actions")!,
        ).justifyContent,
        "flex-end",
      );
      assert.equal(button.textContent, "Import 5 papers");
      const checkboxes = Array.from(
        card.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      );
      assert.lengthOf(checkboxes, 6);
      checkboxes[1].click();
      assert.equal(button.textContent, "Import 4 papers");
      checkboxes[0].click();
      checkboxes[0].click();
      assert.equal(button.textContent, "Import 0 papers");
      assert.isTrue(button.disabled);
      card.querySelector<HTMLButtonElement>('[data-kind="cancel"]')!.click();
      assert.isFalse((await pending).approved);
      assert.isEmpty(Zotero.Items.get(fixture.parentItemId).getNotes());
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
