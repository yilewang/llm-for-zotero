import { mineruLegacyHealth } from "../test/helpers/mineruLegacyHealth";
import { mineruResultFixture } from "../test/helpers/mineruResultFixture";
import { assert } from "chai";
import {
  interruptRecoveryScenario,
  verifyRecoveryScenario,
  cleanupRecoveryScenario,
  disposeRecoveryScenarioResources,
} from "./helpers/mineruRecoveryScenario";

async function waitFor(test: () => boolean) {
  const end = Date.now() + 15000;
  while (!test() && Date.now() < end) await Zotero.Promise.delay(50);
  assert.isTrue(test(), "MinerU manager renders the expected state");
}
async function preferences(id: number, status: string): Promise<Window> {
  const win = (Zotero.Utilities.Internal as any).openPreferences(
    "llmforzotero-preferences",
  ) as Window;
  await waitFor(() =>
    Boolean(win.document.querySelector('[data-pref-tab="mineru"]')),
  );
  (
    win.document.querySelector('[data-pref-tab="mineru"]') as HTMLElement
  ).click();
  await waitFor(() =>
    Boolean(
      win.document.querySelector(
        `[data-parent-id="${id}"] [data-status="${status}"]`,
      ),
    ),
  );
  (
    win.document.querySelector('[data-pref-tab="mineru"]') as HTMLElement
  ).click();
  await waitFor(
    () =>
      (
        win.document.querySelector(
          `[data-parent-id="${id}"] [data-status="${status}"]`,
        ) as HTMLElement
      ).getBoundingClientRect().height > 0,
  );
  return win;
}
async function close(win: Window) {
  win.close();
  await waitFor(() => win.closed);
  await Zotero.Promise.delay(100);
}

describe("workflow: MinerU Partial status", function () {
  this.timeout(60000);
  after(disposeRecoveryScenarioResources);
  it("renders a purple Partial dot with saved pages, then a green completed dot after reopening", async function () {
    const prefix = "extensions.zotero.llmforzotero.";
    const settings: Record<string, string | number | boolean> = {
      mineruEnabled: true,
      mineruMode: "local",
      mineruSyncEnabled: false,
      mineruForceOcr: false,
      mineruMaxAutoPages: 0,
    };
    const old = new Map(
      Object.keys(settings).map((k) => [k, Zotero.Prefs.get(prefix + k, true)]),
    );
    const toolkit = (Zotero as any).LLMForZotero.data.ztoolkit;
    const getGlobal = toolkit.getGlobal;
    const record = await interruptRecoveryScenario("cancel");
    let win: Window | undefined;
    try {
      for (const [k, v] of Object.entries(settings))
        Zotero.Prefs.set(prefix + k, v, true);
      win = await preferences(record.id, "partial");
      const dot = win.document.querySelector(
        `[data-parent-id="${record.id}"] [data-status="partial"]`,
      ) as HTMLElement;
      const legend = win.document.getElementById(
        "llmforzotero-mineru-partial-legend-dot",
      )!;
      assert.isOk(legend, "Partial is included in the existing status legend");
      assert.equal(
        win.getComputedStyle(legend)!.backgroundColor,
        "rgb(139, 92, 246)",
      );
      const style = win.getComputedStyle(dot)!;
      assert.equal(style.backgroundColor, "rgb(139, 92, 246)");
      assert.equal(style.borderRadius, "50%");
      assert.equal(dot.getBoundingClientRect().height, 8);
      assert.equal(dot.getAttribute("aria-label"), "Partial");
      assert.include(dot.title, "200/401");
      assert.include(dot.title, "Resume");
      let nextPart = 2;
      toolkit.getGlobal = function (name: string) {
        if (name !== "fetch") return getGlobal.call(this, name);
        return async (url: string) => {
          const health = mineruLegacyHealth(String(url));
          if (health) return health;
          assert.isTrue(String(url).endsWith("/file_parse"));
          const part = nextPart++;
          record.uploads.push(part);
          const data = mineruResultFixture(part);
          return {
            ok: true,
            status: 200,
            headers: { get: () => "application/zip" },
            arrayBuffer: async () => data.buffer,
          };
        };
      };
      (
        win.document.querySelector(
          `[data-parent-id="${record.id}"]`,
        ) as HTMLElement
      ).click();
      const start = win.document.querySelector(
        "#llmforzotero-mineru-mgr-start-btn",
      ) as HTMLButtonElement;
      assert.include(start.textContent, "1");
      start.click();
      await waitFor(() =>
        Boolean(
          win!.document.querySelector(
            `[data-parent-id="${record.id}"] [data-status="cached"]`,
          ),
        ),
      );
      await verifyRecoveryScenario(record);
      await close(win);
      win = undefined;
      win = await preferences(record.id, "cached");
      const complete = win.document.querySelector(
        `[data-parent-id="${record.id}"] [data-status="cached"]`,
      ) as HTMLElement;
      assert.equal(
        win.getComputedStyle(complete)!.backgroundColor,
        "rgb(16, 185, 129)",
      );
    } finally {
      if (win) await close(win);
      await cleanupRecoveryScenario(record);
      toolkit.getGlobal = getGlobal;
      for (const [k, v] of old) {
        if (v === undefined) Zotero.Prefs.clear(prefix + k, true);
        else Zotero.Prefs.set(prefix + k, v, true);
      }
    }
  });
});
