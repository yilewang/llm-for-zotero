import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

// The shortcut row floats over the chat and lets the pointer through its
// empty space, so a right-click there reaches the chat, not the row (#556).
// The menu on a shortcut button must therefore also offer the row's own
// actions: Add, Move and Reset.
describe("workflow: shortcut button menu offers the row actions", function () {
  this.timeout(60000);
  let api: WorkflowTestApi;
  let paper: Awaited<ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>>;

  async function waitFor<T>(read: () => T | null | undefined, label: string) {
    const deadline = Date.now() + 5000;
    for (;;) {
      const value = read();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await Zotero.Promise.delay(50);
    }
  }

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    paper = await api.createPaperWithPdfFixture({
      title: "Shortcut menu paper",
      pages: ["Disposable paper for the shortcut button menu."],
    });
  });

  afterEach(async function () {
    await api.reset();
    if (paper) await api.cleanupFixture(paper);
  });

  it("shows Edit, Delete, Add, Move and Reset, and Move works from it", async function () {
    const panel = await api.renderPanelForItem(paper.parentItemId);
    const doc = Zotero.getMainWindow().document;
    const win = doc.defaultView!;
    const body = doc.querySelector<HTMLElement>(
      `[data-workflow-panel-id="${panel.panelId}"]`,
    )!;
    const chip = await waitFor(
      () => body.querySelector<HTMLButtonElement>(".llm-shortcut-btn"),
      "a shortcut button",
    );
    const box = chip.getBoundingClientRect();
    chip.dispatchEvent(
      new (win as any).MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: box.left + 4,
        clientY: box.top + 4,
      }),
    );

    const menu = body.querySelector<HTMLDivElement>("#llm-shortcut-menu")!;
    assert.equal(menu.style.display, "grid", "the button menu opens");
    const item = (name: string) =>
      body.querySelector<HTMLButtonElement>(`#llm-shortcut-menu-${name}`)!;
    for (const name of ["edit", "delete", "add", "move", "reset"]) {
      assert.equal(item(name).style.display, "flex", `${name} is shown`);
    }
    assert.isFalse(item("move").disabled, "move is enabled");

    item("move").click();
    await waitFor(
      () => body.querySelector(".llm-shortcut-btn.llm-shortcut-move-mode"),
      "move mode on the shortcut buttons",
    );
    assert.equal(menu.style.display, "none", "the menu closes");
  });
});
