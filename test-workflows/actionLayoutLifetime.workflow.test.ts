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

  it("releases old layout observers through repeated detach and reattach", async function () {
    for (let cycle = 0; cycle < 3; cycle++) {
      const root = await openPanel();
      await until(
        () => observers.some((targets) => targets.has(root)),
        "layout observer owns current root",
      );
      await api.openStandaloneForItem(fixture.parentItemId);
      await until(
        () => !root.isConnected,
        "embedded panel is replaced by the detached placeholder",
      );
      await until(
        () => observers.every((targets) => !targets.has(root)),
        "removed panel releases its layout observer",
      );
      await api.closeStandalone();
      const restored = await openPanel();
      assert.notStrictEqual(restored, root);
      assert.isAbove(
        restored.querySelector(".llm-actions")!.getBoundingClientRect().width,
        0,
      );
    }
  });

  it("restores the embedded panel's conversation and paper shortcuts when the standalone window closes", async function () {
    const root = await openPanel();
    const details = win.document.getElementById("zotero-item-details");
    const section = details.querySelector(".llm-dedicated-chat-pane");
    const shortcutCount = (panel: Element) =>
      panel.querySelectorAll("#llm-shortcuts .llm-shortcut-btn").length;
    await until(
      () => shortcutCount(root) > 0,
      "embedded paper panel renders its shortcuts",
    );
    const before = {
      conversationKey: root.dataset.itemId,
      paperItemId: root.dataset.basePaperItemId,
      conversationKind: root.dataset.conversationKind,
      conversationSystem: root.dataset.conversationSystem,
    };
    assert.isOk(before.conversationKey, "mounted panel has a conversation");
    assert.equal(before.paperItemId, String(fixture.parentItemId));
    assert.equal(before.conversationKind, "paper");

    await api.openStandaloneForItem(fixture.parentItemId);
    await until(
      () => !root.isConnected,
      "embedded panel is replaced by the detached placeholder",
    );
    await api.closeStandalone();

    // The close path rebuilds the embedded panel itself; no reselect or
    // sidenav click runs here, so this observes the standalone-close restore.
    const restoredRoot = () =>
      section.querySelector("#llm-main") as HTMLElement | null;
    await until(
      () => Boolean(restoredRoot()?.dataset.handlersInitialized),
      "standalone close restores an initialized embedded panel",
    );
    const restored = restoredRoot()!;
    assert.notStrictEqual(restored, root);
    assert.isUndefined(restored.dataset.standalone);
    assert.deepEqual(
      {
        conversationKey: restored.dataset.itemId,
        paperItemId: restored.dataset.basePaperItemId,
        conversationKind: restored.dataset.conversationKind,
        conversationSystem: restored.dataset.conversationSystem,
      },
      before,
    );
    await until(
      () => shortcutCount(restoredRoot()!) > 0,
      "restored embedded panel renders paper-mode shortcuts",
    );
  });
});
