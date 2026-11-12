import { assert } from "chai";
import type { WorkflowTestApi } from "../../src/modules/contextPanel/workflowTestTypes";

// Run in a separate process: other workflow suites capture the plugin API at
// definition time, and those references necessarily expire across a reload.
// LLM_FOR_ZOTERO_TEST_ENTRIES=test-isolated/action-layout-shutdown npm run test:workflow
describe("workflow: action layout shutdown", function () {
  this.timeout(60000);

  it("releases layout observers on shutdown and initializes them after reload", async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    let api = (Zotero as any).LLMForZotero.api.workflowTest as WorkflowTestApi;
    await api.reset();
    const win = Zotero.getMainWindow();
    const NativeResizeObserver = win.ResizeObserver;
    const observers: Set<Element>[] = [];
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
      disconnect() {
        this.targets.clear();
        super.disconnect();
      }
    };
    const fixture = await api.createPaperWithPdfFixture({
      title: "Shutdown layout lifetime",
      pdfTitle: "Synthetic shutdown fixture",
    });
    const { AddonManager } = ChromeUtils.importESModule(
      "resource://gre/modules/AddonManager.sys.mjs",
    );
    const plugin = await AddonManager.getAddonByID(
      "zotero-llm@github.com.yilewang",
    );
    assert.isOk(plugin);
    const until = async (check: () => boolean, message: string) => {
      const deadline = Date.now() + 10000;
      while (!check() && Date.now() < deadline) await Zotero.Promise.delay(50);
      assert.isTrue(check(), message);
    };
    let host: Element | null = null;
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      host = win.document.querySelector(
        `[data-workflow-panel-id="${panel.panelId}"]`,
      );
      const root = host!.querySelector("#llm-main")!;
      assert.isTrue(observers.some((targets) => targets.has(root)));
      try {
        await plugin!.disable();
        await until(
          () => observers.every((targets) => !targets.has(root)),
          "shutdown releases the old panel's observer even when its host survives",
        );
      } finally {
        await plugin!.enable();
        await until(
          () =>
            Boolean((Zotero as any).LLMForZotero?.data?.initialized) &&
            Boolean((Zotero as any).LLMForZotero?.api?.agent),
          "plugin reload and deferred agent startup complete",
        );
        api = (Zotero as any).LLMForZotero.api.workflowTest;
      }
      host?.remove();
      host = null;
      const restored = await api.renderPanelForItem(fixture.parentItemId);
      const newRoot = win.document.querySelector(
        `[data-workflow-panel-id="${restored.panelId}"] #llm-main`,
      );
      assert.isTrue(observers.some((targets) => targets.has(newRoot!)));
    } finally {
      host?.remove();
      win.ResizeObserver = NativeResizeObserver;
      await api.cleanupFixture(fixture);
      await api.reset();
    }
  });
});
