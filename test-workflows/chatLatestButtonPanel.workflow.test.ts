import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: latest message button in a Codex panel", function () {
  this.timeout(60000);
  const prefix = "extensions.zotero.llmforzotero.";
  const preferences = {
    enableCodexAppServerMode: true,
    enableClaudeCodeMode: false,
    conversationSystem: "upstream",
    codexAppServerModel: "gpt-5.4",
    codexAppServerReasoning: "auto",
  };
  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | undefined;
  let previous = new Map<string, unknown>();
  let body: HTMLElement;
  let box: HTMLDivElement;
  let win: Window;
  const settle = () => Zotero.Promise.delay(300);

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    previous = new Map(
      Object.keys(preferences).map((name) => [
        name,
        Zotero.Prefs.get(prefix + name, true),
      ]),
    );
    for (const [name, value] of Object.entries(preferences)) {
      Zotero.Prefs.set(prefix + name, value, true);
    }
    api.configurePermissionCatalogs();
    fixture = await api.createPaperWithPdfFixture({
      title: "Latest message button",
      pdfTitle: "Latest message button PDF",
      pages: ["Disposable paper for a local Codex conversation."],
    });
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const diagnostics = await api.clickPanelSystemToggle(
      panel.panelId,
      "codex",
    );
    assert.equal(diagnostics.conversationSystem, "codex");
    const doc = Zotero.getMainWindow().document;
    win = doc.defaultView!;
    body = doc.querySelector<HTMLElement>(
      `[data-workflow-panel-id="${panel.panelId}"]`,
    )!;
    assert.isOk(body, "the production panel is mounted in the main document");
    body.style.width = "340px";
    body.style.height = "640px";
    const shell = body.querySelector<HTMLElement>(".llm-chat-shell")!;
    shell.style.flex = "1 1 0";
    shell.style.height = "auto";
    shell.style.minHeight = "80px";
    shell.style.maxHeight = "none";
    box = body.querySelector<HTMLDivElement>("#llm-chat-box")!;
    await api.seedPanelStoredTurn(
      panel.panelId,
      "Explain the paper in detail.",
      Array.from(
        { length: 35 },
        (_, index) =>
          `Paragraph ${index + 1}. The reader reviews an earlier part of this discussion and can use the floating control to return to the latest message. Showing this control must leave the conversation's size unchanged.`,
      ).join("\n\n"),
    );
    await settle();
    assert.isAbove(box.scrollHeight - box.clientHeight, 1000);
  });

  afterEach(async function () {
    try {
      await api.reset();
      if (fixture) await api.cleanupFixture(fixture);
    } finally {
      fixture = undefined;
      for (const [name, value] of previous) {
        if (value === undefined) Zotero.Prefs.clear(prefix + name, true);
        else Zotero.Prefs.set(prefix + name, value, true);
      }
      previous.clear();
    }
  });

  it("returns to the latest message only when the reader clicks the floating button", async function () {
    const button = body.querySelector<HTMLButtonElement>("#llm-chat-latest")!;
    assert.isOk(
      button,
      "the mounted production panel has a latest-message button",
    );
    box.scrollTop = box.scrollHeight - box.clientHeight;
    box.dispatchEvent(new win.Event("scroll"));
    await settle();
    assert.isTrue(button.hidden);
    const geometry = {
      clientHeight: box.clientHeight,
      scrollHeight: box.scrollHeight,
    };

    box.dispatchEvent(new win.WheelEvent("wheel", { deltaY: -30 }));
    box.scrollTop = (box.scrollHeight - box.clientHeight) / 2;
    box.dispatchEvent(new win.Event("scroll"));
    await settle();
    const readingTop = box.scrollTop;
    assert.isAbove(readingTop, 100);
    assert.isBelow(readingTop, box.scrollHeight - box.clientHeight - 100);
    assert.isFalse(button.hidden);
    assert.equal(button.dataset.pending, "false");
    assert.equal(box.clientHeight, geometry.clientHeight);
    assert.equal(box.scrollHeight, geometry.scrollHeight);
    await settle();
    assert.closeTo(box.scrollTop, readingTop, 1);

    button.click();
    await settle();

    assert.closeTo(box.scrollHeight - box.clientHeight - box.scrollTop, 0, 1);
    assert.isTrue(button.hidden);
    assert.equal(
      box.clientHeight,
      geometry.clientHeight,
      "the floating control does not resize the conversation",
    );
    assert.equal(box.scrollHeight, geometry.scrollHeight);
  });
});
