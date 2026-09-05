import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { createCiteExportTool } from "../src/agent/tools/read/citeExport";
import { createLibrarySettingsTool } from "../src/agent/tools/write/librarySettings";

/**
 * The most dangerous everyday gap in the census: asked for "the APA reference
 * for this paper", the agent had no tool at all — so it wrote a
 * plausible-looking citation from memory. A fabricated reference is worse
 * than a refusal in a reference manager. Export and preferences were equally
 * unreachable: both domains scored zero covered operations.
 */
describe("citations, export and settings", function () {
  let prefs: Record<string, unknown>;
  let freed: number;

  function install(overrides: Record<string, unknown> = {}) {
    prefs = { "export.quickCopy.setting": "bibliography=apa-style-id" };
    freed = 0;
    (globalThis as Record<string, unknown>).Zotero = {
      Items: { get: () => null },
      Prefs: {
        get: (key: string) => prefs[key],
        set: (key: string, value: unknown) => {
          prefs[key] = value;
        },
      },
      Styles: {
        get: (id: string) =>
          id === "apa-style-id"
            ? {
                title: "American Psychological Association 7th edition",
                getCiteProc: () => ({
                  free: () => {
                    freed += 1;
                  },
                  updateItems: () => undefined,
                  previewCitationCluster: () => "(Smith, 2024)",
                }),
              }
            : null,
        getVisible: () => [
          { styleID: "apa-style-id", title: "APA 7th edition" },
        ],
      },
      Cite: {
        makeFormattedBibliographyOrCitationList: () =>
          "Smith, J. (2024). A paper. Journal, 1(1), 1–10.",
      },
      debug: () => undefined,
      ...overrides,
    };
  }

  afterEach(function () {
    delete (globalThis as Record<string, unknown>).Zotero;
  });

  function gateway(items: Record<number, unknown> = {}) {
    install();
    const g = new ZoteroGateway();
    (g as unknown as { getItem: (id: number) => unknown }).getItem = (
      id: number,
    ) => items[id] || null;
    return g;
  }

  const citable = (id: number) => ({ id, isNote: () => false });

  describe("citations", function () {
    it("formats through Zotero's CSL engine, not from memory", function () {
      const g = gateway({ 1: citable(1) });
      const result = g.formatBibliography({ itemIds: [1] });
      assert.include(result.output, "Smith, J. (2024)");
      assert.equal(
        result.styleTitle,
        "American Psychological Association 7th edition",
      );
    });

    it("defaults to the user's own Quick Copy style", function () {
      const g = gateway({ 1: citable(1) });
      const result = g.formatBibliography({ itemIds: [1] });
      assert.equal(result.styleId, "apa-style-id");
    });

    it("produces an in-text citation when asked", function () {
      const g = gateway({ 1: citable(1) });
      const result = g.formatBibliography({ itemIds: [1], mode: "citation" });
      assert.equal(result.output, "(Smith, 2024)");
    });

    it("releases the CSL engine", function () {
      const g = gateway({ 1: citable(1) });
      g.formatBibliography({ itemIds: [1] });
      assert.equal(freed, 1);
    });

    it("refuses rather than approximating an uninstalled style", function () {
      const g = gateway({ 1: citable(1) });
      assert.throws(
        () => g.formatBibliography({ itemIds: [1], styleId: "not-installed" }),
        /not installed/,
      );
    });

    it("refuses to guess when the engine is unavailable", function () {
      install({ Cite: undefined, Styles: undefined });
      const g = new ZoteroGateway();
      (g as unknown as { getItem: () => unknown }).getItem = () => citable(1);
      assert.throws(
        () => g.formatBibliography({ itemIds: [1] }),
        /Do not write one from memory/,
      );
    });

    it("tells the model never to compose a citation itself", function () {
      const tool = createCiteExportTool(gateway());
      assert.match(tool.spec.description, /never write one from memory/i);
      assert.match(
        tool.guidance?.instruction || "",
        /do not compose one yourself/i,
      );
    });

    it("requires items before it will format anything", function () {
      const tool = createCiteExportTool(gateway());
      assert.isFalse(tool.validate({ action: "bibliography" }).ok);
      assert.isTrue(tool.validate({ action: "bibliography", itemIds: [1] }).ok);
    });
  });

  describe("settings", function () {
    it("lists what may be changed, with current values", function () {
      const g = gateway();
      const settings = g.listSettings();
      assert.isAbove(settings.length, 0);
      const quickCopy = settings.find(
        (entry) => entry.key === "export.quickCopy.setting",
      );
      assert.equal(quickCopy?.value, "bibliography=apa-style-id");
      assert.isString(quickCopy?.description);
    });

    it("refuses anything outside the allowlist", async function () {
      const g = gateway();
      // Zotero.Prefs also holds sync credentials and the data directory; an
      // agent that can rewrite those can lock the user out of their library.
      const result = await g.updateSetting({
        key: "sync.storage.password",
        value: "hunter2",
      });
      assert.equal(result.status, "refused");
      assert.isUndefined(prefs["sync.storage.password"]);
    });

    it("coerces to the declared type and refuses nonsense", async function () {
      const g = gateway();
      const good = await g.updateSetting({
        key: "trashAutoEmptyDays",
        value: "45",
      });
      assert.equal(good.status, "updated");
      assert.strictEqual(prefs.trashAutoEmptyDays, 45);

      const bad = await g.updateSetting({
        key: "trashAutoEmptyDays",
        value: "soon",
      });
      assert.equal(bad.status, "refused");
    });

    it("reports the previous value so a change can be described", async function () {
      const g = gateway();
      prefs.automaticTags = true;
      const result = await g.updateSetting({
        key: "automaticTags",
        value: false,
      });
      assert.equal(result.previousValue, true);
      assert.equal(result.value, false);
    });

    it("only asks for confirmation when writing", function () {
      const tool = createLibrarySettingsTool(gateway());
      const list = tool.validate({ action: "list" });
      const set = tool.validate({
        action: "set",
        key: "automaticTags",
        value: false,
      });
      assert.isTrue(list.ok && set.ok);
      if (!list.ok || !set.ok) return;
      assert.isFalse(
        tool.shouldRequireConfirmation?.(list.value, {} as never) as boolean,
      );
      assert.isTrue(
        tool.shouldRequireConfirmation?.(set.value, {} as never) as boolean,
      );
    });
  });
});
