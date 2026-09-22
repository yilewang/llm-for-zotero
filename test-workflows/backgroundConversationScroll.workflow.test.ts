import { assert } from "chai";
import { createCoalescedFrameScheduler } from "../src/modules/contextPanel/setupHandlers/controllers/uiSchedulingController";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: conversation scroll isolation", function () {
  this.timeout(60000);
  let api: WorkflowTestApi;
  let paper: Awaited<ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>>;
  let source: typeof paper;
  let sourcePanel: Awaited<ReturnType<WorkflowTestApi["renderPanelForItem"]>>;
  let win: Window;
  let box: HTMLDivElement;

  const panelBody = (panelId: string) =>
    Zotero.getMainWindow().document.querySelector<HTMLElement>(
      `[data-workflow-panel-id="${panelId}"]`,
    )!;
  const nextFrame = () =>
    new Promise<void>((resolve) => {
      // A background Zotero window can suspend native frames indefinitely.
      // Use the same bounded frame fallback as the panel work being verified.
      const scheduler = createCoalescedFrameScheduler({
        getWindow: () => win,
        run: () => {
          scheduler.dispose();
          resolve();
        },
      });
      scheduler.schedule();
    });
  async function scrollTo(target: HTMLDivElement, top: number) {
    const owner = target.ownerDocument.defaultView!;
    target.dispatchEvent(new owner.WheelEvent("wheel", { deltaY: -100 }));
    target.scrollTop = top;
    target.dispatchEvent(new owner.Event("scroll"));
    await nextFrame();
    await nextFrame();
  }

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    paper = await api.createPaperWithPdfFixture({
      title: "Reading paper B",
      pages: ["Paper B evidence for scroll validation."],
    });
    source = await api.createPaperWithPdfFixture({
      title: "Library source A",
      pages: ["Paper A evidence for background publication."],
    });
    await api.openStandaloneForItem(paper.parentItemId);
    await api.clickStandaloneTab("paper");
    await api.resizeStandaloneWindow(1050, 730);
    await api.seedStandaloneConversation([
      { role: "user", text: "Earlier paper discussion for scroll validation" },
      {
        role: "assistant",
        text: Array.from(
          { length: 35 },
          (_, i) =>
            `Paragraph ${i + 1}. A neural population can represent a stimulus through the pattern of activity across many neurons. Stable reading should preserve this paragraph when another conversation is working.`,
        ).join("\n\n"),
      },
    ]);
    win = (Zotero as any).LLMForZotero.data.standaloneWindow;
    box = win.document.querySelector<HTMLDivElement>("#llm-chat-box")!;
    assert.isAbove(box.scrollHeight - box.clientHeight, 1000);
    sourcePanel = await api.renderPanelForItem(source.parentItemId);
    await api.togglePanelConversationMode(sourcePanel.panelId);
    await api.seedPanelStoredTurn(
      sourcePanel.panelId,
      "Prepare a background library document",
      "Ready to publish.",
    );
  });

  afterEach(async function () {
    await api.closeStandalone();
    await api.reset();
    if (paper) await api.cleanupFixture(paper);
    if (source) await api.cleanupFixture(source);
  });

  it("keeps Paper Chat in place while a Library Chat publishes after switching its source panel", async function () {
    // Keep another view of the publishing conversation mounted after its
    // original panel switches to the paper being read in the standalone view.
    const libraryMirror = await api.renderPanelForItem(source.parentItemId);
    await api.togglePanelConversationMode(libraryMirror.panelId);
    assert.equal(
      panelBody(libraryMirror.panelId).querySelector<HTMLElement>("#llm-main")!
        .dataset.itemId,
      panelBody(sourcePanel.panelId).querySelector<HTMLElement>("#llm-main")!
        .dataset.itemId,
      "the two Library Chat views share the publishing conversation",
    );
    await scrollTo(box, 700);
    const scrollTopBefore = box.scrollTop;
    const mirrorBox = panelBody(libraryMirror.panelId).querySelector(
      "#llm-chat-box",
    )!;
    const mirrorMessage = mirrorBox.firstElementChild;
    const result = await api.exerciseBackgroundAgentPublication({
      panelId: sourcePanel.panelId,
      paperBItemId: paper.parentItemId,
    });
    await nextFrame();
    await nextFrame();
    assert.equal(result.outboxStatus, "delivered");
    assert.deepEqual(result.persistedConversationKeys, [
      result.sourceConversationKey,
    ]);
    assert.isTrue(result.exactMarkdown);
    assert.isFalse(result.otherPanelContainsDocument);
    assert.notStrictEqual(
      mirrorBox.firstElementChild,
      mirrorMessage,
      "the publishing conversation still refreshes",
    );
    assert.closeTo(
      box.scrollTop,
      scrollTopBefore,
      1,
      "Paper Chat keeps its reading position",
    );
  });

  it("refreshes only the requested conversation without rebuilding another chat", async function () {
    const sourceRoot = panelBody(sourcePanel.panelId);
    const sourceKey = Number(
      sourceRoot.querySelector<HTMLElement>("#llm-main")!.dataset.itemId,
    );
    const sourceBox = sourceRoot.querySelector("#llm-chat-box")!;
    await scrollTo(box, 700);
    const before = {
      node: box.firstElementChild,
      top: box.scrollTop,
      sourceNode: sourceBox.firstElementChild,
    };
    api.refreshActiveConversationPanels(sourceKey);
    await nextFrame();
    await nextFrame();
    assert.notStrictEqual(sourceBox.firstElementChild, before.sourceNode);
    assert.strictEqual(
      box.firstElementChild,
      before.node,
      "Paper Chat is not rebuilt",
    );
    assert.closeTo(box.scrollTop, before.top, 1);
  });

  for (const otherView of ["manual", "followBottom"] as const) {
    it(`preserves two views of the same paper when the other view is ${otherView}`, async function () {
      const mirror = await api.renderPanelForItem(paper.parentItemId);
      const mirrorRoot = panelBody(mirror.panelId);
      const otherBox =
        mirrorRoot.querySelector<HTMLDivElement>("#llm-chat-box")!;
      assert.equal(
        mirrorRoot.querySelector<HTMLElement>("#llm-main")!.dataset.itemId,
        win.document.querySelector<HTMLElement>("#llm-main")!.dataset.itemId,
      );
      assert.isAbove(otherBox.scrollHeight - otherBox.clientHeight, 500);
      await scrollTo(box, 700);
      await scrollTo(
        otherBox,
        otherView === "manual" ? 250 : otherBox.scrollHeight,
      );
      const before = { primary: box.scrollTop, other: otherBox.scrollTop };
      const previousNode = box.firstElementChild;
      api.refreshActiveConversationPanels();
      await nextFrame();
      await nextFrame();
      assert.notStrictEqual(
        box.firstElementChild,
        previousNode,
        "a real full redraw ran",
      );
      assert.closeTo(
        box.scrollTop,
        before.primary,
        1,
        "the first view keeps its position",
      );
      assert.closeTo(
        otherBox.scrollTop,
        before.other,
        1,
        "the other view keeps its position",
      );
    });
  }
});
