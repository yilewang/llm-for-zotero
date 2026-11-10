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

  const SHORTCUT_PREFS = ["shortcutDeleted", "customShortcuts"].map(
    (key) => `extensions.zotero.llmforzotero.${key}`,
  );
  let savedShortcutPrefs: unknown[] = [];

  afterEach(async function () {
    SHORTCUT_PREFS.forEach((name, index) => {
      const saved = savedShortcutPrefs[index];
      if (saved === undefined) Zotero.Prefs.clear(name, true);
      else Zotero.Prefs.set(name, saved as string, true);
    });
    savedShortcutPrefs = [];
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

  it("keeps Add and Reset reachable after every shortcut is deleted", async function () {
    savedShortcutPrefs = SHORTCUT_PREFS.map((name) =>
      Zotero.Prefs.get(name, true),
    );
    Zotero.Prefs.set(
      SHORTCUT_PREFS[0],
      JSON.stringify([
        "summarize",
        "key-points",
        "methodology",
        "limitations",
        "mermaid-diagram",
      ]),
      true,
    );
    Zotero.Prefs.set(SHORTCUT_PREFS[1], "[]", true);

    const panel = await api.renderPanelForItem(paper.parentItemId);
    const doc = Zotero.getMainWindow().document;
    const body = doc.querySelector<HTMLElement>(
      `[data-workflow-panel-id="${panel.panelId}"]`,
    )!;
    const chip = await waitFor(
      () => body.querySelector<HTMLButtonElement>(".llm-shortcut-empty-menu"),
      "the empty row's menu button",
    );
    assert.equal(
      body.querySelectorAll("#llm-shortcuts .llm-shortcut-btn").length,
      1,
      "the menu button is the row's only button",
    );
    assert.isFalse(chip.disabled, "the menu button is enabled");

    chip.click();

    const menu = body.querySelector<HTMLDivElement>("#llm-shortcut-menu")!;
    assert.equal(menu.style.display, "grid", "a click opens the row menu");
    assert.equal(menu.dataset.menuKind, "panel");
    const item = (name: string) =>
      body.querySelector<HTMLButtonElement>(`#llm-shortcut-menu-${name}`)!;
    for (const name of ["add", "reset"]) {
      assert.equal(item(name).style.display, "flex", `${name} is shown`);
      assert.isFalse(item(name).disabled, `${name} is enabled`);
    }
    for (const name of ["edit", "delete"]) {
      assert.equal(item(name).style.display, "none", `${name} is hidden`);
    }
  });
});
