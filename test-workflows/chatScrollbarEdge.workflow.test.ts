import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

declare const Zotero: any;
declare const Services: any;

// #582: the chat's scrollbar runs at the right edge of the sidebar pane or
// the chat window, and the floating chips and composer never cover it, so a
// pointer at that edge beside the composer reaches the chat's scrollbar.

function api(): WorkflowTestApi {
  return Zotero.LLMForZotero.api.workflowTest as WorkflowTestApi;
}

function longTurns(count = 6) {
  const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (let i = 0; i < count; i++) {
    turns.push({ role: "user", text: `Question ${i + 1}` });
    turns.push({
      role: "assistant",
      text: Array.from(
        { length: 5 },
        (_, k) =>
          `Paragraph ${k + 1} of answer ${i + 1}. ` +
          "This sentence makes the paragraph wrap over several lines. ".repeat(
            3,
          ),
      ).join("\n\n"),
    });
  }
  return turns;
}

function standaloneWindow(): Window {
  const windows = Services.wm.getEnumerator(null);
  while (windows.hasMoreElements()) {
    const win = windows.getNext();
    if (win.document?.querySelector?.(".llm-standalone-content")) return win;
  }
  throw new Error("no chat window");
}

/** What a pointer at the right edge, beside the composer, lands on. */
function edgeHit(win: Window, root: ParentNode, edge: number): Element | null {
  const composer = root.querySelector(".llm-input-section") as HTMLElement;
  const rect = composer.getBoundingClientRect();
  return win.document.elementFromPoint(edge - 3, rect.top + rect.height / 2);
}

describe("workflow: the chat scrollbar runs at the right edge, clear of the composer (#582)", function () {
  this.timeout(120000);

  before(async function () {
    await api().reset();
  });

  after(async function () {
    await api().closeStandalone();
    await api().reset();
  });

  it("in the sidebar", async function () {
    const fixture = await api().createPaperWithPdfFixture({
      title: "Scrollbar sidebar paper",
      pdfTitle: "s.pdf",
    });
    const first = await api().renderPanelForItem(fixture.parentItemId);
    const key = api().getPanelConversationKey({ panelId: first.panelId });
    let t = Date.now() - 100000;
    await api().seedStoredConversationTurns(
      key,
      longTurns().map((turn) => ({ ...turn, timestamp: (t += 1000) })),
    );
    const panel = await api().remountPanel(first.panelId);
    const win = Zotero.getMainWindow() as Window;
    const root = win.document.querySelector(
      `[data-workflow-panel-id="${panel.panelId}"]`,
    ) as HTMLElement;
    // The test host sits off screen; bring it on screen for hit testing.
    const host = (root.closest(".llm-workflow-test-host") ||
      root) as HTMLElement;
    const saved = host.getAttribute("style") || "";
    host.style.left = "0px";
    host.style.zIndex = "99999";
    host.style.width = "420px";
    host.style.height = "800px";
    try {
      await Zotero.Promise.delay(500);
      const panelEl = root.querySelector(".llm-panel") as HTMLElement;
      const messages = root.querySelector(".llm-messages") as HTMLElement;
      assert.isAbove(
        messages.scrollHeight,
        messages.clientHeight,
        "it scrolls",
      );
      assert.equal(
        win.getComputedStyle(messages)?.scrollbarWidth,
        "thin",
        "the chat's scrollbar is thin, so it fits the clear strip",
      );
      const edge = panelEl.getBoundingClientRect().right;
      assert.equal(
        Math.round(messages.getBoundingClientRect().right),
        Math.round(edge),
        "the chat box reaches the pane's right edge",
      );
      for (const selector of [".llm-input-section", ".llm-shortcuts"]) {
        const rect = (
          root.querySelector(selector) as HTMLElement
        ).getBoundingClientRect();
        assert.isAtMost(
          rect.right,
          edge - 12 + 0.5,
          `${selector} leaves the scrollbar strip clear`,
        );
        assert.approximately(
          rect.left - panelEl.getBoundingClientRect().left,
          edge - rect.right,
          0.5,
          `${selector} is inset the same on both sides`,
        );
      }
      const hit = edgeHit(win, root, edge);
      assert.isOk(
        hit && messages.contains(hit),
        `the edge beside the composer is the chat, not ${hit?.className}`,
      );
    } finally {
      host.setAttribute("style", saved);
    }
  });

  for (const width of [1000, 1700]) {
    it(`in the chat window ${width}px wide`, async function () {
      const fixture = await api().createPaperWithPdfFixture({
        title: `Scrollbar window paper ${width}`,
        pdfTitle: "w.pdf",
      });
      await api().openStandaloneForItem(fixture.parentItemId);
      await api().resizeStandaloneWindow(width, 700);
      await api().seedStandaloneConversation(longTurns());
      await Zotero.Promise.delay(800);
      const win = standaloneWindow();
      const doc = win.document;
      const messages = doc.querySelector(".llm-messages") as HTMLElement;
      const composer = doc.querySelector(".llm-input-section") as HTMLElement;
      assert.isAbove(
        messages.scrollHeight,
        messages.clientHeight,
        "it scrolls",
      );
      assert.equal(
        Math.round(messages.getBoundingClientRect().right),
        win.innerWidth,
        "the chat box reaches the window's right edge",
      );
      // The text keeps the composer's column.
      const text = doc.querySelector(
        ".llm-message-wrapper.assistant p",
      ) as HTMLElement;
      const composerRect = composer.getBoundingClientRect();
      assert.isAtMost(text.getBoundingClientRect().right, composerRect.right);
      assert.isAtLeast(text.getBoundingClientRect().left, composerRect.left);
      const hit = edgeHit(win, doc, win.innerWidth);
      assert.isOk(
        hit && messages.contains(hit),
        `the edge beside the composer is the chat, not ${hit?.className}`,
      );
      await api().closeStandalone();
    });
  }
});
