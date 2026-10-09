import { assert } from "chai";
import { buildNativeQuestionAction } from "../src/codexAppServer/nativeQuestions";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

async function waitForQuestionLayout(card: HTMLElement): Promise<void> {
  const deadline = Date.now() + 5000;
  let previous = "";
  let stableSamples = 0;
  let diagnostic = "";
  while (Date.now() < deadline) {
    const win = card.ownerDocument.defaultView as any;
    // Native visibility can change after setup. A normal Windows window can
    // still be occluded: windowState 3 means normal, not minimized. Geometry
    // checks need a visible test host so rAF/ResizeObserver can settle.
    if (win?.windowState === win?.STATE_MINIMIZED) win.restore();
    if (card.ownerDocument.visibilityState !== "visible") win?.focus();
    const viewport = card.querySelector<HTMLElement>(
      ".llm-planning-question-viewport",
    );
    const active = card.querySelector<HTMLElement>(
      '.llm-planning-question-panel[aria-hidden="false"]',
    );
    const elements = [
      card,
      viewport,
      active,
      ...(Array.from(
        card.querySelectorAll<HTMLElement>(".llm-planning-question-option"),
      ) as HTMLElement[]),
    ];
    const rects = elements.map((element) =>
      element?.getBoundingClientRect().toJSON(),
    );
    const activeHeight = active
      ? active.offsetHeight || active.scrollHeight
      : 0;
    const appliedHeight = Number.parseFloat(viewport?.style.height || "");
    diagnostic = JSON.stringify({
      connected: card.isConnected,
      ready: card.dataset.questionStackReady,
      activeHeight,
      appliedHeight,
      visibility: card.ownerDocument.visibilityState,
      resizeObserver: typeof card.ownerDocument.defaultView?.ResizeObserver,
      windowState: (card.ownerDocument.defaultView as any)?.windowState,
      rects,
    });
    const rendered =
      card.isConnected &&
      card.ownerDocument.visibilityState === "visible" &&
      card.dataset.questionStackReady === "true" &&
      elements.length > 3 &&
      activeHeight > 0 &&
      Math.abs(appliedHeight - activeHeight) <= 1 &&
      rects.every((rect) => rect && rect.width > 0 && rect.height > 0);
    // The renderer mounts panels in requestAnimationFrame and adjusts the
    // viewport through ResizeObserver. Elapsed time alone is not readiness.
    stableSamples = rendered && diagnostic === previous ? stableSamples + 1 : 0;
    if (stableSamples >= 2) return;
    previous = diagnostic;
    await Zotero.Promise.delay(50);
  }
  assert.fail(`Question layout did not become ready and stable: ${diagnostic}`);
}

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
      const win = Zotero.getMainWindow();
      // Restore a minimized disposable host; waitForQuestionLayout separately
      // checks actual visibility, including an otherwise normal occluded host.
      if (win.windowState === win.STATE_MINIMIZED) win.restore();
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const doc = win.document;
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
      // This is a manually rendered fixture, not a stored chat message.
      // Background conversation refreshes legitimately replace #llm-chat-box;
      // placing the fixture there can detach it while geometry is measured.
      // Keep the real message styling/font inheritance in an independent host.
      const contentHost = doc.createElement("div");
      contentHost.className = "llm-messages";
      contentHost.style.height = "auto";
      contentHost.style.minHeight = "0";
      contentHost.style.maxHeight = "none";
      contentHost.style.flex = "0 0 auto";
      root.appendChild(contentHost);
      contentHost.appendChild(card);
      api.refreshActiveConversationPanels();
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
          await waitForQuestionLayout(card);
          for (const option of Array.from(
            card.querySelectorAll<HTMLElement>(".llm-planning-question-option"),
          ) as HTMLElement[]) {
            const bounds = option.getBoundingClientRect();
            const copy = option
              .querySelector<HTMLElement>(".llm-planning-question-option-copy")!
              .getBoundingClientRect();
            assert.isAtLeast(
              copy.top,
              bounds.top + 4,
              `choice top padding at ${width}px: ${JSON.stringify({ bounds: bounds.toJSON(), copy: copy.toJSON(), height: doc.defaultView!.getComputedStyle(option)!.height })}`,
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
            )!;
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
            )!.textTransform,
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
        contentHost.remove();
        if (oldScale) root.style.setProperty("--llm-font-scale", oldScale);
        else root.style.removeProperty("--llm-font-scale");
      }
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
