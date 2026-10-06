import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: native action layout lifetime", function () {
  this.timeout(60000);
  let api: WorkflowTestApi;
  let win: any;
  let fixture: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  >;
  let originalLayout: unknown;
  let NativeResizeObserver: typeof ResizeObserver;
  const observers: Set<Element>[] = [];
  const layoutPref = "extensions.zotero.llmforzotero.sidebarLayout";

  async function until(check: () => boolean, message: string) {
    const deadline = Date.now() + 10000;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(50);
    assert.isTrue(check(), message);
  }

  async function openPanel(): Promise<HTMLElement> {
    await win.ZoteroPane.selectItem(fixture.parentItemId);
    const details = win.document.getElementById("zotero-item-details");
    await until(
      () => Boolean(details.querySelector(".llm-dedicated-chat-pane")),
      "native chat section is registered",
    );
    const section = details.querySelector(".llm-dedicated-chat-pane");
    if (
      win.document.documentElement.getAttribute("data-llm-pane-view") !==
        "chat" ||
      details.sidenav._collapsed
    ) {
      const button = Array.from(
        details.sidenav.querySelectorAll("[data-pane]"),
      ).find(
        (node: any) => node.getAttribute("data-pane") === section.dataset.pane,
      ) as Element;
      assert.isOk(button);
      button.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, button: 0 }),
      );
    }
    await until(
      () =>
        Boolean(
          section.querySelector("#llm-main")?.dataset.handlersInitialized,
        ) &&
        section.querySelector("#llm-main").getBoundingClientRect().width > 0,
      "real native sidebar panel is initialized and visible",
    );
    return section.querySelector("#llm-main");
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    win = Zotero.getMainWindow();
    originalLayout = Zotero.Prefs.get(layoutPref, true);
    Zotero.Prefs.set(layoutPref, "independent", true);
    NativeResizeObserver = win.ResizeObserver;
    win.ResizeObserver = class extends NativeResizeObserver {
      readonly targets = new Set<Element>();
      constructor(callback: ResizeObserverCallback) {
        super(callback);
        observers.push(this.targets);
      }
      observe(target: Element, options?: ResizeObserverOptions) {
        this.targets.add(target);
        super.observe(target, options);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
        super.unobserve(target);
      }
      disconnect() {
        this.targets.clear();
        super.disconnect();
      }
    };
    fixture = await api.createPaperWithPdfFixture({
      title: "Action layout lifetime",
      pdfTitle: "Action layout fixture",
    });
  });

  after(async function () {
    await api.closeStandalone();
    win.ResizeObserver = NativeResizeObserver;
    if (fixture) await api.cleanupFixture(fixture);
    await api.reset();
    if (originalLayout === undefined) Zotero.Prefs.clear(layoutPref, true);
    else Zotero.Prefs.set(layoutPref, originalLayout as string, true);
  });

  it("receives native resize notifications when the retained sidebar is revealed", async function () {
    const root = await openPanel();
    const sizes: number[] = [];
    const observer = new NativeResizeObserver((entries) => {
      sizes.push(entries[0].contentRect.width);
    });
    observer.observe(root);
    try {
      await until(
        () => sizes.some((width) => width > 0),
        "initial visible resize",
      );
      root.style.display = "none";
      await until(() => sizes.includes(0), "hidden resize");
      sizes.length = 0;
      root.style.removeProperty("display");
      await until(
        () => sizes.some((width) => width > 0),
        "reveal resize without polling",
      );
    } finally {
      root.style.removeProperty("display");
      observer.disconnect();
    }
  });

  it("stops geometry reads while hidden and lays controls out after reveal", async function () {
    const root = await openPanel();
    const row = root.querySelector<HTMLElement>(".llm-actions")!;
    const widthGetter = Object.getOwnPropertyDescriptor(
      win.Element.prototype,
      "clientWidth",
    )!.get!;
    let reads = 0;
    Object.defineProperty(row, "clientWidth", {
      configurable: true,
      get() {
        reads++;
        return widthGetter.call(this);
      },
    });
    try {
      root.style.display = "none";
      await Zotero.Promise.delay(250);
      reads = 0;
      await Zotero.Promise.delay(300);
      const hiddenReads = reads;
      root.style.removeProperty("display");
      await until(
        () => reads > hiddenReads && row.clientWidth > 0,
        "layout resumes after reveal",
      );
      assert.equal(
        hiddenReads,
        0,
        "idle hidden panel does not repeatedly measure controls",
      );
      assert.isAbove(
        root.querySelector(".llm-model-btn")!.getBoundingClientRect().width,
        0,
      );
      Zotero.debug(
        `ACTION_LAYOUT_HIDDEN ${JSON.stringify({ hiddenReads, sampleMs: 300 })}`,
        1,
      );
    } finally {
      root.style.removeProperty("display");
      delete (row as any).clientWidth;
    }
  });

  it("keeps the embedded panel and its one layout observer through repeated standalone open and close", async function () {
    const root = await openPanel();
    const details = win.document.getElementById("zotero-item-details");
    const section = details.querySelector(".llm-dedicated-chat-pane");
    await until(
      () => observers.some((targets) => targets.has(root)),
      "layout observer owns current root",
    );
    const observersOnRoot = () =>
      observers.filter((targets) => targets.has(root)).length;
    const baseline = observersOnRoot();
    for (let cycle = 0; cycle < 3; cycle++) {
      await api.openStandaloneForItem(fixture.parentItemId);
      await Zotero.Promise.delay(300);
      assert.isTrue(
        root.isConnected,
        `cycle ${cycle}: the embedded panel stays connected while the window is open`,
      );
      assert.strictEqual(
        section.querySelector("#llm-main"),
        root,
        `cycle ${cycle}: the embedded panel is not replaced while the window is open`,
      );
      assert.isOk(root.dataset.handlersInitialized);
      await api.closeStandalone();
      await Zotero.Promise.delay(300);
      assert.strictEqual(
        section.querySelector("#llm-main"),
        root,
        `cycle ${cycle}: closing the window does not rebuild the embedded panel`,
      );
      assert.equal(
        observersOnRoot(),
        baseline,
        `cycle ${cycle}: open and close add no layout observers to the panel`,
      );
      assert.isAbove(
        root.querySelector(".llm-actions")!.getBoundingClientRect().width,
        0,
      );
    }
  });

  it("keeps the embedded panel's conversation and paper shortcuts while the standalone window opens and closes", async function () {
    const root = await openPanel();
    const details = win.document.getElementById("zotero-item-details");
    const section = details.querySelector(".llm-dedicated-chat-pane");
    const shortcutCount = (panel: Element) =>
      panel.querySelectorAll("#llm-shortcuts .llm-shortcut-btn").length;
    await until(
      () => shortcutCount(root) > 0,
      "embedded paper panel renders its shortcuts",
    );
    const snapshot = (panel: HTMLElement) => ({
      conversationKey: panel.dataset.itemId,
      paperItemId: panel.dataset.basePaperItemId,
      conversationKind: panel.dataset.conversationKind,
      conversationSystem: panel.dataset.conversationSystem,
    });
    const before = snapshot(root);
    assert.isOk(before.conversationKey, "mounted panel has a conversation");
    assert.equal(before.paperItemId, String(fixture.parentItemId));
    assert.equal(before.conversationKind, "paper");

    const assertUnchanged = (context: string) => {
      const current = section.querySelector("#llm-main") as HTMLElement | null;
      assert.strictEqual(current, root, `${context}: same embedded panel`);
      assert.isTrue(root.isConnected, `${context}: panel stays connected`);
      assert.isOk(
        root.dataset.handlersInitialized,
        `${context}: panel stays initialized`,
      );
      assert.isUndefined(root.dataset.standalone);
      assert.deepEqual(snapshot(root), before, `${context}: same conversation`);
      assert.isAbove(
        shortcutCount(root),
        0,
        `${context}: paper-mode shortcuts stay rendered`,
      );
    };

    await api.openStandaloneForItem(fixture.parentItemId);
    await Zotero.Promise.delay(300);
    assertUnchanged("while the standalone window is open");
    await api.closeStandalone();
    await Zotero.Promise.delay(300);
    assertUnchanged("after the standalone window closes");
  });

  it("focuses an open standalone window from the sidebar's pop-out button without closing or retargeting it", async function () {
    const root = await openPanel();
    const sidebarConversation = root.dataset.itemId;
    await api.openStandaloneForItem(fixture.parentItemId);
    const library = await api.clickStandaloneTab("open");
    assert.equal(library.activeTab, "open", JSON.stringify(library));
    const standaloneWin = (Zotero as any).LLMForZotero.data
      .standaloneWindow as Window;
    assert.isOk(standaloneWin, "the standalone window is open");
    const windowConversation = () =>
      (
        standaloneWin.document.querySelector(
          ".llm-standalone-content #llm-main",
        ) as HTMLElement | null
      )?.dataset.itemId;
    const before = windowConversation();
    assert.isOk(before, "the window shows a conversation");
    assert.notEqual(before, sidebarConversation);
    let focusCalls = 0;
    const nativeFocus = standaloneWin.focus;
    (standaloneWin as any).focus = function (this: Window) {
      focusCalls++;
      return nativeFocus.call(this);
    };
    try {
      (root.parentElement!.querySelector("#llm-popout") as HTMLElement).click();
      await Zotero.Promise.delay(500);
      assert.isFalse(standaloneWin.closed, "the window stays open");
      assert.strictEqual(
        (Zotero as any).LLMForZotero.data.standaloneWindow,
        standaloneWin,
        "no second window is opened",
      );
      assert.isAbove(focusCalls, 0, "the open window is focused");
      assert.equal(
        windowConversation(),
        before,
        "the window keeps its own conversation",
      );
      assert.strictEqual(
        win.document
          .getElementById("zotero-item-details")
          .querySelector(".llm-dedicated-chat-pane #llm-main"),
        root,
        "the sidebar panel is untouched",
      );
      assert.equal(root.dataset.itemId, sidebarConversation);
    } finally {
      delete (standaloneWin as any).focus;
    }
  });
});
