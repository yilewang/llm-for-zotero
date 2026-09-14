import { assert } from "chai";
import { buildNativeQuestionAction } from "../src/codexAppServer/nativeQuestions";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: question card readability", function () {
  this.timeout(30000);

  it("contains long choice text and keeps the active question visible after resizing", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Question card readability fixture",
      pages: ["Disposable question layout fixture."],
    });
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const doc = Zotero.getMainWindow().document;
      const action = buildNativeQuestionAction([
        {
          id: "destination",
          question:
            'No collection named "Learning folder" exists. Which folder should "Representational Geometry" (currently in Geometry) be moved to?',
          options: [
            {
              label: "Learning (top-level)",
              description:
                "The top-level 'Learning' collection (15 papers, 31 incl. subfolders). Removes the paper from Geometry.",
            },
            {
              label: "Reinforcement_Learning",
              description:
                "The top-level 'Reinforcement_Learning' collection. Removes the paper from Geometry.",
            },
            {
              label: "Hebbian_Learning (child of Learning)",
              description:
                "The 'Hebbian_Learning' subfolder inside Learning. Removes the paper from Geometry.",
            },
          ],
        },
      ]);
      const pending = api.renderPendingActionForPanel(panel.panelId, {
        requestId: "question-readability",
        action,
      });
      const card = doc.querySelector<HTMLElement>(
        '[data-request-id="question-readability"]',
      )!;
      const root = doc.querySelector<HTMLElement>(
        `[data-workflow-panel-id="${panel.panelId}"] .llm-panel`,
      )!;
      root.querySelector(".llm-messages")!.appendChild(card);
      const oldScale = root.style.getPropertyValue("--llm-font-scale");
      try {
        for (const [width, scale] of [
          [390, 1],
          [280, 1.5],
          [520, 1],
        ]) {
          card.style.width = `${width}px`;
          card.style.maxWidth = "none";
          root.style.setProperty("--llm-font-scale", `${scale}`);
          await Zotero.Promise.delay(450);
          for (const option of card.querySelectorAll<HTMLElement>(
            ".llm-planning-question-option",
          )) {
            const bounds = option.getBoundingClientRect();
            const copy = option
              .querySelector<HTMLElement>(".llm-planning-question-option-copy")!
              .getBoundingClientRect();
            assert.isAtLeast(
              copy.top,
              bounds.top + 4,
              `choice top padding at ${width}px: ${JSON.stringify({ bounds: bounds.toJSON(), copy: copy.toJSON(), height: doc.defaultView!.getComputedStyle(option).height })}`,
            );
            assert.isAtMost(
              copy.bottom,
              bounds.bottom - 4,
              `choice bottom padding at ${width}px`,
            );
            assert.isAtMost(
              copy.right,
              bounds.right - 4,
              `choice horizontal containment at ${width}px`,
            );
            const markerStyle = doc.defaultView!.getComputedStyle(
              option.querySelector(".llm-planning-question-option-marker")!,
            );
            assert.isAbove(
              parseFloat(markerStyle.borderTopWidth),
              0,
              "choice indicator must remain visible",
            );
          }
          const viewport = card
            .querySelector<HTMLElement>(".llm-planning-question-viewport")!
            .getBoundingClientRect();
          const active = card
            .querySelector<HTMLElement>(
              '.llm-planning-question-panel[aria-hidden="false"]',
            )!
            .getBoundingClientRect();
          assert.closeTo(
            active.top,
            viewport.top,
            1,
            "question starts at the visible viewport",
          );
          assert.isAtMost(
            active.bottom,
            viewport.bottom + 1,
            `question is not clipped after resize to ${width}px`,
          );
          assert.equal(
            doc.defaultView!.getComputedStyle(
              card.querySelector(".llm-planning-question-prompt")!,
            ).textTransform,
            "none",
          );
        }
        const submit = card.querySelector<HTMLButtonElement>(
          ".llm-planning-question-continue",
        )!;
        assert.isTrue(submit.disabled);
        const choice = card.querySelector<HTMLButtonElement>(
          ".llm-planning-question-option",
        )!;
        choice.click();
        assert.equal(choice.getAttribute("aria-checked"), "true");
        assert.isFalse(submit.disabled);
        const input = card.querySelector<HTMLInputElement>(
          ".llm-planning-question-custom-input",
        )!;
        input.value = "Learning / Other";
        input.dispatchEvent(
          new (doc.defaultView as any).Event("input", { bubbles: true }),
        );
        assert.equal(choice.getAttribute("aria-checked"), "false");
        submit.click();
        const resolution = await pending;
        assert.isTrue(resolution.approved);
        assert.deepEqual(resolution.data, {
          destination: { kind: "custom", text: "Learning / Other" },
        });
      } finally {
        if (oldScale) root.style.setProperty("--llm-font-scale", oldScale);
        else root.style.removeProperty("--llm-font-scale");
      }
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
