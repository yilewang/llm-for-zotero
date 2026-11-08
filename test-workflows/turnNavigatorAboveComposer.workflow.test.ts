/**
 * The turn navigator (the dashes at the chat's left edge) stays on the chat
 * above the floating shortcut chips and composer: its box and its lowest
 * marker end above them, in the standalone window and in the side panel,
 * in the light and the dark theme.
 */
import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const THEME_PREF = "browser.theme.toolbar-theme";
const PARAGRAPH =
  "Place fields drift over days while the population code stays readable. ".repeat(
    12,
  );

describe("workflow: turn navigator above the composer", function () {
  this.timeout(120000);
  let api: WorkflowTestApi;
  const fixtures: WorkflowTestFixture[] = [];

  async function until(check: () => boolean, message: string, ms = 10000) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(40);
    assert.isTrue(check(), message);
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
  });

  after(async function () {
    Zotero.Prefs.clear(THEME_PREF, true);
    await api.closeStandalone();
    for (const fixture of fixtures) await api.cleanupFixture(fixture);
    await api.reset();
  });

  /** Where the navigator and its lowest marker end, and where the floor starts. */
  function measure(main: HTMLElement) {
    const nav = main.querySelector(".llm-turn-navigator") as HTMLElement;
    const markers = Array.from(
      main.querySelectorAll(".llm-turn-navigator-marker"),
    ) as HTMLElement[];
    const shortcuts = main.querySelector("#llm-shortcuts") as HTMLElement;
    const composer = main.querySelector(
      ":scope > .llm-input-section",
    ) as HTMLElement;
    const tops = [shortcuts, composer]
      .map((node) => node?.getBoundingClientRect())
      .filter((rect) => rect && rect.height > 0)
      .map((rect) => rect!.top);
    const viewport = nav
      .querySelector(".llm-turn-navigator-viewport")
      ?.getBoundingClientRect();
    // A marker shows only where the navigator's viewport shows it.
    const shown = markers
      .map((marker) => marker.getBoundingClientRect())
      .filter(
        (rect) =>
          rect.height > 0 &&
          (!viewport ||
            (rect.bottom > viewport.top && rect.top < viewport.bottom)),
      );
    return {
      hidden: nav.hidden,
      markers: markers.length,
      navBottom: Math.round(nav.getBoundingClientRect().bottom),
      lowestMarker: shown.length
        ? Math.round(Math.max(...shown.map((rect) => rect.bottom)))
        : null,
      floorTop: Math.round(Math.min(...tops)),
    };
  }

  function check(label: string, place: ReturnType<typeof measure>) {
    assert.isFalse(place.hidden, `${label}: the navigator shows`);
    assert.isAtMost(
      place.navBottom,
      place.floorTop,
      `${label}: the navigator ends above the chips and composer ${JSON.stringify(place)}`,
    );
    assert.isNotNull(place.lowestMarker, `${label}: a marker shows`);
    assert.isAtMost(
      place.lowestMarker!,
      place.floorTop,
      `${label}: its lowest marker is above the chips and composer ${JSON.stringify(place)}`,
    );
  }

  async function bothThemes(label: string, main: () => HTMLElement) {
    for (const [theme, value] of [
      ["light", 1],
      ["dark", 0],
    ] as const) {
      Zotero.Prefs.set(THEME_PREF, value, true);
      await Zotero.Promise.delay(400);
      check(`${label}, ${theme}`, measure(main()));
    }
  }

  it("ends above the chips and composer in the standalone window", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Navigator floor paper",
      pdfTitle: "Navigator floor paper",
    });
    fixtures.push(fixture);
    await api.openStandaloneForItem(fixture.parentItemId);
    await api.resizeStandaloneWindow(1200, 760);
    const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
    for (let index = 0; index < 12; index++) {
      turns.push({ role: "user", text: `Question ${index + 1}` });
      turns.push({ role: "assistant", text: PARAGRAPH });
    }
    await api.seedStandaloneConversation(turns);
    const win = (Zotero as any).LLMForZotero.data.standaloneWindow as any;
    const main = () =>
      win.document.querySelector(
        ".llm-standalone-content #llm-main",
      ) as HTMLElement;
    await until(
      () =>
        main()?.querySelectorAll(".llm-turn-navigator-marker").length >= 12 &&
        !(main().querySelector(".llm-turn-navigator") as HTMLElement).hidden,
      "the standalone navigator lists the questions",
    );
    await bothThemes("standalone", main);
  });

  it("ends above the chips and composer with Task progress shown", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Navigator floor task paper",
      pdfTitle: "Navigator floor task paper",
    });
    fixtures.push(fixture);
    const libraryID = Zotero.Libraries.userLibraryID;
    const collection = new Zotero.Collection();
    (collection as { libraryID: number }).libraryID = libraryID;
    collection.name = `Navigator floor ${Date.now()}`;
    await collection.saveTx();
    try {
      await api.openStandaloneForItem(fixture.parentItemId);
      await api.resizeStandaloneWindow(1200, 760);
      await api.clickStandaloneTab("open");
      const win = (Zotero as any).LLMForZotero.data.standaloneWindow as any;
      const main = () =>
        win.document.querySelector(
          ".llm-standalone-content #llm-main",
        ) as HTMLElement;
      await until(() => Boolean(main()), "the standalone window shows a chat");
      await api.seedTaskProgressConversation({
        surface: "standalone",
        turns: Array.from({ length: 6 }, (_, turn) => ({
          runId: `nav-floor-${Date.now()}-${turn}`,
          user: {
            text: `Question ${turn + 1}`,
            selectedCollectionContexts: [
              { collectionId: collection.id, name: collection.name, libraryID },
            ],
          },
          answer: PARAGRAPH,
          events: [{ type: "final", text: PARAGRAPH }] as never,
        })),
      });
      await api.reopenTaskProgressConversation({ surface: "standalone" });
      await until(() => {
        api.flushTaskProgress();
        const row = main().querySelector("#llm-task-progress") as HTMLElement;
        return (
          Boolean(row) &&
          !row.hidden &&
          main().querySelectorAll(".llm-turn-navigator-marker").length >= 6 &&
          !(main().querySelector(".llm-turn-navigator") as HTMLElement).hidden
        );
      }, "the Task progress row and the navigator show");
      await bothThemes("standalone with Task progress", main);
    } finally {
      await collection.eraseTx().catch(() => undefined);
    }
  });

  it("ends above the chips and composer in the side panel", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Navigator floor side paper",
      pdfTitle: "Navigator floor side paper",
    });
    fixtures.push(fixture);
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    for (let index = 0; index < 6; index++)
      await api.seedPanelStoredTurn(
        panel.panelId,
        `Question ${index + 1}`,
        PARAGRAPH,
      );
    const host = () =>
      Zotero.getMainWindow().document.querySelector(
        `[data-workflow-panel-id="${panel.panelId}"]`,
      ) as HTMLElement;
    const main = () => host().querySelector("#llm-main") as HTMLElement;
    await until(
      () =>
        Boolean(main()) &&
        main().querySelectorAll(".llm-turn-navigator-marker").length >= 2,
      "the side panel navigator lists the questions",
    );
    const nav = () =>
      main().querySelector(".llm-turn-navigator") as HTMLElement;
    if (nav().hidden) {
      // Too narrow for the navigator here: nothing to overlap.
      this.skip();
    }
    await bothThemes("side panel", main);
  });
});
