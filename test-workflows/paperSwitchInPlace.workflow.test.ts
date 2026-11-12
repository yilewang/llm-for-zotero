import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: switching papers keeps the mounted library panel", function () {
  this.timeout(60000);
  let api: WorkflowTestApi;
  let win: any;
  const fixtures: WorkflowTestFixture[] = [];
  const layoutPref = "extensions.zotero.llmforzotero.sidebarLayout";
  let originalLayout: unknown;

  async function until(check: () => boolean, message: string) {
    const deadline = Date.now() + 10000;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(25);
    const root = panel();
    assert.isTrue(
      check(),
      `${message}; panel=${JSON.stringify({
        itemId: root?.dataset.itemId,
        basePaperItemId: root?.dataset.basePaperItemId,
        ownershipBlocked: root?.dataset.ownershipBlocked,
        messages: messageTexts(),
      })}`,
    );
  }
  const details = () => win.document.getElementById("zotero-item-details");
  const section = () =>
    details()?.querySelector(".llm-dedicated-chat-pane") as Element | null;
  const panel = () =>
    section()?.querySelector("#llm-main") as HTMLElement | null;
  const input = () =>
    panel()?.querySelector("#llm-input") as HTMLTextAreaElement | null;
  const messageTexts = () =>
    Array.from(
      panel()?.querySelectorAll("#llm-chat-box .llm-message-wrapper") || [],
    ).map((node: any) => node.textContent || "");
  const showsPaper = (index: number) =>
    panel()?.dataset.basePaperItemId === `${fixtures[index].parentItemId}` &&
    !panel()?.dataset.ownershipBlocked &&
    !panel()?.querySelector("#llm-chat-box")?.hasAttribute("inert") &&
    messageTexts().length === 2 &&
    messageTexts()[1].includes(`Answer for paper ${index}`);

  async function openChatPane() {
    const d = details();
    if (
      win.document.documentElement.getAttribute("data-llm-pane-view") !==
        "chat" ||
      d.sidenav._collapsed
    ) {
      const paneID = (section() as HTMLElement | null)?.dataset.pane;
      const button = Array.from(d.sidenav.querySelectorAll("[data-pane]")).find(
        (node: any) => node.getAttribute("data-pane") === paneID,
      ) as Element | undefined;
      assert.isOk(button, "chat rail icon exists");
      button!.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, detail: 1, button: 0 }),
      );
    }
    await until(
      () =>
        !d.sidenav._collapsed &&
        (panel()?.getBoundingClientRect().height || 0) > 0 &&
        Boolean(panel()?.dataset.handlersInitialized),
      "chat pane is open",
    );
  }

  const chipTexts = () =>
    Array.from(
      panel()?.querySelectorAll(".llm-selected-context-text") || [],
    ).map((node: any) => node.textContent || "");

  // Open each paper's chat once and seed it under the key the panel uses.
  let seeded = false;
  async function seedPaperChats() {
    if (seeded) return;
    for (const [index, fixture] of fixtures.entries()) {
      await win.ZoteroPane.selectItem(fixture.parentItemId);
      await openChatPane();
      await until(
        () =>
          panel()?.dataset.basePaperItemId === `${fixture.parentItemId}` &&
          Number(panel()?.dataset.itemId) > 0,
        `panel is on paper ${index}`,
      );
      const timestamp = Date.now() - 10000 + index * 10;
      await api.seedStoredConversationTurns(Number(panel()!.dataset.itemId), [
        { role: "user", text: `Question for paper ${index}`, timestamp },
        {
          role: "assistant",
          text: `Answer for paper ${index}`,
          timestamp: timestamp + 1,
        },
      ]);
    }
    seeded = true;
  }

  async function showPaper(index: number) {
    await win.ZoteroPane.selectItem(fixtures[index].parentItemId);
    await openChatPane();
    await until(() => showsPaper(index), `paper ${index}'s chat is shown`);
  }

  function typeDraft(text: string) {
    const box = input()!;
    box.value = text;
    box.dispatchEvent(new win.Event("input", { bubbles: true }));
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    originalLayout = Zotero.Prefs.get(layoutPref, true);
    Zotero.Prefs.set(layoutPref, "independent", true);
    win = Zotero.getMainWindow();
    for (const index of [0, 1]) {
      const fixture = await api.createPaperWithPdfFixture({
        title: `In-place switch ${index}`,
      });
      fixtures.push(fixture);
    }
  });

  after(async function () {
    for (const fixture of fixtures) await api.cleanupFixture(fixture);
    await api.reset();
    if (originalLayout === undefined) Zotero.Prefs.clear(layoutPref, true);
    else Zotero.Prefs.set(layoutPref, originalLayout as string, true);
  });

  it("moves the same panel between papers and keeps each paper's draft", async function () {
    await seedPaperChats();
    await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
    await openChatPane();
    await until(() => showsPaper(0), "first paper's chat is shown");
    const mountedRoot = panel();
    const handlersGeneration = mountedRoot?.dataset.handlersInitialized;
    typeDraft("Draft for paper 0");

    await win.ZoteroPane.selectItem(fixtures[1].parentItemId);
    await until(() => showsPaper(1), "second paper's chat is shown");
    assert.strictEqual(panel(), mountedRoot, "the panel was not rebuilt");
    assert.equal(
      panel()?.dataset.handlersInitialized,
      handlersGeneration,
      "handlers were not wired again",
    );
    assert.equal(
      panel()?.dataset.itemId,
      `${fixtures[1].parentItemId}`,
      "the panel is on the second paper's conversation",
    );
    assert.equal(input()?.value, "", "the first paper's draft did not follow");
    assert.isFalse(input()?.disabled, "the composer is usable");
    typeDraft("Draft for paper 1");

    await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
    await until(() => showsPaper(0), "first paper's chat is shown again");
    assert.strictEqual(panel(), mountedRoot, "the panel was not rebuilt");
    assert.equal(input()?.value, "Draft for paper 0");

    await win.ZoteroPane.selectItem(fixtures[1].parentItemId);
    await until(() => showsPaper(1), "second paper's chat is shown again");
    assert.equal(input()?.value, "Draft for paper 1");

    // Rapid clicks settle on the last paper.
    void win.ZoteroPane.selectItem(fixtures[0].parentItemId);
    await win.ZoteroPane.selectItem(fixtures[1].parentItemId);
    await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
    await until(() => showsPaper(0), "rapid switching ends on the last paper");
    await Zotero.Promise.delay(500);
    assert.isTrue(showsPaper(0), "a slower earlier switch did not win");
    assert.equal(input()?.value, "Draft for paper 0");
  });

  it("shows only the next paper's chips from the moment it switches", async function () {
    await seedPaperChats();
    await showPaper(0);
    const chip = "Chip text for paper 0";
    await api.setMountedPanelSelectedText(panel()!.parentElement!, chip);
    await until(
      () => chipTexts().some((text) => text.includes(chip)),
      "the first paper shows its chip",
    );
    // Record the composer in the same task that moves the panel to the
    // second paper, before any frame or the second paper's chat draw.
    const root = panel()!;
    let atSwitch: { chips: string[] } | null = null;
    const observer = new win.MutationObserver(() => {
      if (
        !atSwitch &&
        root.dataset.basePaperItemId === `${fixtures[1].parentItemId}`
      ) {
        atSwitch = { chips: chipTexts() };
      }
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-base-paper-item-id"],
    });
    try {
      await win.ZoteroPane.selectItem(fixtures[1].parentItemId);
      await until(() => atSwitch !== null, "the panel moved to paper 1");
    } finally {
      observer.disconnect();
    }
    assert.strictEqual(panel(), root, "the panel moved in place");
    assert.deepEqual(
      atSwitch!.chips,
      [],
      "the first paper's chip did not follow the switch",
    );
    await until(() => showsPaper(1), "second paper's chat is shown");
    assert.deepEqual(chipTexts(), [], "the second paper shows no chip");

    await showPaper(0);
    await until(
      () => chipTexts().some((text) => text.includes(chip)),
      "the first paper's chip is back",
    );
    await api.setMountedPanelSelectedText(panel()!.parentElement!, null);
  });

  it("a failed switch never shows the last paper's messages under the next paper", async function () {
    await seedPaperChats();
    await showPaper(0);
    const paper1 = `${fixtures[1].parentItemId}`;
    // Watch the whole pane: the recovery rebuild replaces the panel root.
    // Until paper 1's chat draws, paper 0's messages stay on screen but
    // inert; a leak is paper 0's chat taking input under paper 1.
    const leaks: string[] = [];
    const check = () => {
      const root = panel();
      if (root?.dataset.basePaperItemId !== paper1) return;
      const chatBox = root.querySelector("#llm-chat-box");
      if (!chatBox || chatBox.hasAttribute("inert")) return;
      if (root.hasAttribute("inert")) return;
      const text = chatBox.textContent || "";
      if (text.includes("for paper 0")) leaks.push(text);
    };
    const observer = new win.MutationObserver(check);
    observer.observe(section()!, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    try {
      await api.failNextInPlacePaperSwitches(1);
      await win.ZoteroPane.selectItem(fixtures[1].parentItemId);
      await until(() => showsPaper(1), "the second paper's chat is drawn");
      await Zotero.Promise.delay(300);
      check();
    } finally {
      observer.disconnect();
    }
    assert.equal(
      await api.getPendingInPlacePaperSwitchFailures(),
      0,
      "the in-place switch used the forced failure",
    );
    assert.deepEqual(
      leaks,
      [],
      "paper 0's chat never took input under paper 1",
    );
    assert.isTrue(showsPaper(1), "the panel ends on the second paper");
  });
});
