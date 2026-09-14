import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { createCiteExportTool } from "../src/agent/tools/read/citeExport";
import { createLibrarySettingsTool } from "../src/agent/tools/write/librarySettings";
import {
  PLAN_AUTHOR_DATE_STYLE_ID,
  resolvePlanDocumentCitationPreference,
} from "../src/agent/documents/citationPreference";
import { navigatePlanDocumentCitationSource } from "../src/modules/contextPanel/planDocumentPresentation";

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

    it("formats multiple structured clusters without referencing unregistered previews", function () {
      install({
        Styles: {
          get: () => ({
            title: "APA 7th edition",
            getCiteProc: (_locale: string, format: string) => ({
              free: () => {
                freed += 1;
              },
              updateItems: () => undefined,
              previewCitationCluster: (
                citation: { citationItems: Array<{ id: number }> },
                citationsPre: Array<[string, number]>,
              ) => {
                // Zotero/citeproc cannot resolve IDs for citations that were
                // merely previewed. This reproduces the live Plan finalizer
                // crash if the gateway invents a prior-citation chain.
                assert.deepEqual(citationsPre, []);
                const id = citation.citationItems[0].id;
                return format === "html"
                  ? `<span>(Author ${id}, 2024)</span>`
                  : `(Author ${id}, 2024)`;
              },
              makeBibliography: () => [
                { entry_ids: [[1], [2]] },
                format === "html"
                  ? ["<div>Reference 1</div>", "<div>Reference 2</div>"]
                  : ["Reference 1", "Reference 2"],
              ],
            }),
          }),
        },
      });
      const g = new ZoteroGateway();
      const result = g.formatStructuredCitations({
        clusters: [
          { citationId: "C1", items: [{ itemId: 1 }] },
          { citationId: "C2", items: [{ itemId: 2 }] },
        ],
        styleId: "apa-style-id",
        locale: "en-US",
      });

      assert.deepEqual(
        result.clusters.map((cluster) => cluster.text),
        ["(Author 1, 2024)", "(Author 2, 2024)"],
      );
      assert.deepEqual(
        result.bibliographyEntries.map((entry) => entry.itemId),
        [1, 2],
      );
      assert.equal(freed, 2);
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

    it("falls back from a note-style Quick Copy preference to concise author-date citations", function () {
      install({
        Styles: {
          get: (id: string) =>
            id === "chicago-note"
              ? { class: "note", categories: "note" }
              : id === PLAN_AUTHOR_DATE_STYLE_ID
                ? { class: "in-text", categories: "author-date" }
                : null,
          getVisible: () => [
            { styleID: PLAN_AUTHOR_DATE_STYLE_ID, title: "APA 7th edition" },
          ],
        },
        Prefs: {
          get: (key: string) =>
            key === "export.quickCopy.setting"
              ? "bibliography=chicago-note"
              : key === "export.quickCopy.locale"
                ? "en-US"
                : undefined,
        },
      });
      const result = resolvePlanDocumentCitationPreference(new ZoteroGateway());
      assert.equal(result.styleId, PLAN_AUTHOR_DATE_STYLE_ID);
      assert.equal(result.styleTitle, "APA 7th edition");
    });

    it("keeps an author-date Quick Copy preference for Plan documents", function () {
      install({
        Styles: {
          get: (id: string) =>
            id === "custom-author-date"
              ? { class: "in-text", categories: "author-date" }
              : null,
          getVisible: () => [
            { styleID: "custom-author-date", title: "Custom author-date" },
          ],
        },
        Prefs: {
          get: (key: string) =>
            key === "export.quickCopy.setting"
              ? "bibliography=custom-author-date"
              : undefined,
        },
      });
      const result = resolvePlanDocumentCitationPreference(new ZoteroGateway());
      assert.equal(result.styleId, "custom-author-date");
    });

    it("navigates an inline Plan citation through Zotero's library pane", async function () {
      let selected: number[] = [];
      let selectedTab = "";
      let focused = 0;
      install({
        getMainWindow: () => ({
          focus: () => {
            focused++;
          },
        }),
        Items: {
          getByLibraryAndKey: (libraryID: number, itemKey: string) =>
            libraryID === 1 && itemKey === "ITEMKEY" ? { id: 42 } : null,
        },
        Libraries: { userLibraryID: 1, get: () => undefined },
        Tabs: {
          select: (tabID: string) => {
            selectedTab = tabID;
          },
        },
        getActiveZoteroPane: () => ({
          selectItems: async (itemIDs: number[]) => {
            selected = itemIDs;
            return true;
          },
        }),
      });
      const opened = await navigatePlanDocumentCitationSource({
        libraryID: 1,
        itemKey: "ITEMKEY",
        evidenceRefs: ["EV1"],
      });
      assert.isTrue(opened);
      assert.equal(selectedTab, "zotero-pane");
      assert.deepEqual(selected, [42]);
      assert.equal(focused, 1);
      assert.isFalse(
        await navigatePlanDocumentCitationSource({
          libraryID: 1,
          itemKey: "MISSING",
          evidenceRefs: [],
        }),
      );
      assert.equal(focused, 1, "failed navigation does not move focus");
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

    it("plans reads and writes from the concrete setting operation", async function () {
      const tool = createLibrarySettingsTool(gateway());
      const list = tool.validate({ action: "list" });
      const set = tool.validate({
        action: "set",
        key: "automaticTags",
        value: false,
      });
      assert.isTrue(list.ok && set.ok);
      if (!list.ok || !set.ok) return;
      assert.equal(
        (await tool.planInvocation?.(list.value, {} as never))?.impact,
        "read_only",
      );
      assert.equal(
        (await tool.planInvocation?.(set.value, {} as never))?.impact,
        "state_change",
      );
    });
  });
});
