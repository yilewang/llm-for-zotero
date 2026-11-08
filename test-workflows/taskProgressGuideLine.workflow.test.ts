/**
 * An open Task progress row's guide line runs down from the middle of the
 * row's check, for every kind of row (library, scholarly, web, and a library
 * paper reused from an earlier question), in the item pane's chat, the
 * standalone window's chat and its side panel tab, in the light and the
 * dark theme. Long contents wrap inside the list and add no sideways scroll.
 * The item pane's chat is the paper's own chat: its answers name and quote
 * the paper, so the paper lists in its "Cited" card, not as a row.
 */
import { assert } from "chai";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const THEME_PREF = "browser.theme.toolbar-theme";
const TITLE = "Drift study for the guide line";
const DOI = "10.1000/guide.0001";
const ANCHOR_URL = "https://example.org/notes/guide-line-essay";
const QUOTE =
  "Place fields drift slowly over days while the population readout stays stable.";
const LONG_WORD = "unbroken".repeat(40);
const FIRST = [
  "## Mechanisms",
  "",
  `Gale et al. (2025) show that overwriting drives drift ([link](https://doi.org/${DOI})).`,
  "",
  "## Library",
  "",
  "Wren et al. (2021) report slow drift in place fields.",
].join("\n");
const SECOND_QUESTION = "Which of these keep a stable readout?";

describe("workflow: task progress guide line under the check", function () {
  this.timeout(240000);
  let api: WorkflowTestApi;
  let libraryID: number;
  let collection: Zotero.Collection;
  let fixture: WorkflowTestFixture;
  const prefs: Array<[string, unknown]> = [
    ["extensions.zotero.llmforzotero.enableAgentMode", true],
    ["extensions.zotero.llmforzotero.lastUsedRuntimeMode", "agent"],
  ];
  const saved = new Map<string, unknown>();

  async function until(check: () => boolean, message: string, ms = 20000) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(40);
    assert.isTrue(check(), message);
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    for (const [name, value] of prefs) {
      saved.set(name, Zotero.Prefs.get(name, true));
      Zotero.Prefs.set(name, value as never, true);
    }
    libraryID = Zotero.Libraries.userLibraryID;
    collection = new Zotero.Collection();
    (collection as { libraryID: number }).libraryID = libraryID;
    collection.name = `Guide line ${Date.now()}`;
    await collection.saveTx();
    fixture = await api.createPaperWithPdfFixture({
      title: TITLE,
      pdfTitle: TITLE,
      pages: [`${TITLE}. Abstract. ${QUOTE}`],
    });
    const item = Zotero.Items.get(fixture.parentItemId);
    item.setCreators([
      { firstName: "A.", lastName: "Wren", creatorType: "author" },
    ] as never);
    item.setField("date", "2021");
    item.setCollections([collection.id]);
    await item.saveTx();
  });

  after(async function () {
    Zotero.Prefs.clear(THEME_PREF, true);
    await api.reset();
    await api.closeStandalone();
    await api.cleanupFixture(fixture);
    await collection?.eraseTx().catch(() => undefined);
    for (const [name, value] of saved) {
      if (value === undefined) Zotero.Prefs.clear(name, true);
      else Zotero.Prefs.set(name, value as never, true);
    }
  });

  /** Two questions: the first reads the paper and searches outside, the
   * second quotes the paper again without reading it. */
  function turns() {
    const stamp = Date.now();
    const first = `tp-guide-1-${stamp}`;
    const second = `tp-guide-2-${stamp}`;
    const key = `${libraryID}:${fixture.parentItemId}`;
    const citation = buildQuoteCitation({
      quoteText: QUOTE,
      citationLabel: "(Wren, 2021)",
      sourceMatchText: QUOTE,
      sourceMatchKind: "exact",
      sourceMatchSource: "context-text",
      itemId: fixture.parentItemId,
      contextItemId: fixture.pdfAttachmentId,
    })!;
    const secondAnswer = `A stable readout follows from slow drift [[quote:${citation.id}]].`;
    const scope = {
      selectedCollectionContexts: [
        { collectionId: collection.id, name: collection.name, libraryID },
      ],
    };
    return [
      {
        runId: first,
        user: { text: "What causes drift?", ...scope },
        answer: FIRST,
        events: [
          {
            type: "tool_call",
            callId: "s1",
            name: "literature_search",
            args: { query: "drift" },
          },
          {
            type: "tool_result",
            callId: "s1",
            name: "literature_search",
            ok: true,
            content: {
              workflow: "answer",
              mode: "search",
              results: [
                {
                  title: "Overwriting drives drift",
                  authors: ["B. Gale"],
                  year: 2025,
                  doi: DOI,
                  openAccessUrl: `https://doi.org/${DOI}`,
                  sourceUrl: "https://openalex.org/W4300000099",
                  candidateIndex: 1,
                },
              ],
            },
          },
          {
            type: "paper_ledger_update",
            callId: "l1",
            delta: {
              version: 1,
              callId: "l1",
              runId: first,
              toolName: "library_retrieve",
              papers: [
                {
                  key,
                  libraryID,
                  itemId: fixture.parentItemId,
                  contextItemId: fixture.pdfAttachmentId,
                  title: TITLE,
                  creator: "Wren et al.",
                  year: "2021",
                  text: "pdf_text",
                  state: "read",
                },
              ],
              reads: [
                {
                  key,
                  callId: "l1",
                  toolName: "library_retrieve",
                  granularity: "passage",
                  method: "bm25",
                  label: "Abstract",
                  snippet: `Drift grows slowly. ${LONG_WORD}`,
                },
              ],
            },
          },
          {
            type: "final",
            text: FIRST,
            webSourceAnchors: [
              {
                offset: FIRST.indexOf("## Library"),
                sources: [
                  {
                    sourceId: "web_1",
                    url: ANCHOR_URL,
                    hostname: "example.org",
                    title: "A sample essay on drift",
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        runId: second,
        user: { text: SECOND_QUESTION, ...scope },
        answer: secondAnswer,
        quoteCitations: [citation],
        events: [
          { type: "final", text: secondAnswer, quoteCitations: [citation] },
        ],
      },
    ];
  }

  /** Open every question, fold and row of a list, then measure each row. */
  async function measure(win: any, list: () => HTMLElement, label: string) {
    for (const head of Array.from(
      list().querySelectorAll(".llm-task-progress-dock-question"),
    ) as HTMLElement[])
      if (head.getAttribute("aria-expanded") !== "true") head.click();
    await Zotero.Promise.delay(300);
    api.flushTaskProgress();
    for (const fold of Array.from(
      list().querySelectorAll(".llm-task-fold"),
    ) as HTMLElement[])
      if (fold.getAttribute("aria-expanded") !== "true") fold.click();
    await Zotero.Promise.delay(300);
    api.flushTaskProgress();
    const rows = () =>
      (
        Array.from(list().querySelectorAll("li[data-key]")) as HTMLElement[]
      ).filter((node) => node.getBoundingClientRect().height > 0);
    for (let index = 0; index < rows().length; index++) {
      const summary = rows()[index]?.querySelector(
        ".llm-task-paper-summary",
      ) as HTMLElement | null;
      if (summary?.getAttribute("aria-expanded") === "false") {
        summary.click();
        await Zotero.Promise.delay(120);
        api.flushTaskProgress();
      }
    }
    await Zotero.Promise.delay(500);
    const body = list().querySelector(
      ".llm-task-progress-drawer-body",
    ) as HTMLElement | null;
    const results = rows()
      .filter((row) => row.querySelector(".llm-task-paper-details"))
      .map((row) => {
        const dot = (
          row.querySelector(".llm-task-paper-dot") as HTMLElement
        ).getBoundingClientRect();
        const details = row.querySelector(
          ".llm-task-paper-details",
        ) as HTMLElement;
        const box = details.getBoundingClientRect();
        const first = details.firstElementChild as HTMLElement | null;
        return {
          label,
          kind: row.dataset.kind || "library",
          earlier: /Read while answering/.test(row.textContent || ""),
          guideOffset:
            Math.round((box.left + 0.5 - (dot.left + dot.width / 2)) * 10) / 10,
          textGap: first
            ? Math.round(first.getBoundingClientRect().left - box.left)
            : null,
          rowOverflow: details.scrollWidth - details.clientWidth,
        };
      });
    return {
      label,
      rows: results,
      listOverflow: body ? body.scrollWidth - body.clientWidth : 0,
    };
  }

  async function bothThemes(
    win: any,
    list: () => HTMLElement,
    label: string,
    out: unknown[],
  ) {
    for (const [theme, value] of [
      ["light", 1],
      ["dark", 0],
    ] as const) {
      Zotero.Prefs.set(THEME_PREF, value, true);
      await Zotero.Promise.delay(400);
      out.push(await measure(win, list, `${label}, ${theme}`));
    }
  }

  function check(
    places: any[],
    expected: readonly string[] = ["library", "paper", "web", "earlier"],
  ) {
    const kinds = new Set(
      places.flatMap((place) =>
        place.rows.map((row: any) => (row.earlier ? "earlier" : row.kind)),
      ),
    );
    const bad = places.filter(
      (place) =>
        place.listOverflow > 1 ||
        place.rows.some(
          (row: any) =>
            Math.abs(row.guideOffset) > 1 ||
            row.textGap === null ||
            Math.abs(row.textGap - 13) > 2 ||
            row.rowOverflow > 1,
        ),
    );
    assert.deepEqual(
      bad,
      [],
      `each open row's line runs down from its check, its text ~12px past the line, nothing scrolls sideways: ${JSON.stringify(places)}`,
    );
    for (const kind of expected)
      assert.isTrue(
        kinds.has(kind),
        `a ${kind} row was measured: ${[...kinds].join(", ")}`,
      );
  }

  async function openDrawer(root: () => HTMLElement) {
    const row = () =>
      root().querySelector("#llm-task-progress") as HTMLButtonElement;
    await until(() => {
      api.flushTaskProgress();
      return Boolean(row()) && !row().hidden;
    }, "the Task progress row shows");
    const drawer = () =>
      root().querySelector("#llm-task-progress-drawer") as HTMLElement;
    if (drawer().hidden) row().click();
    await until(() => {
      api.flushTaskProgress();
      return (
        drawer().querySelectorAll(".llm-task-progress-dock-question").length >=
        2
      );
    }, "both questions list");
    return drawer;
  }

  it("runs from the check in the item pane's chat", async function () {
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const win = Zotero.getMainWindow() as any;
    const root = () =>
      win.document.querySelector(
        `[data-workflow-panel-id="${panel.panelId}"]`,
      ) as HTMLElement;
    const host = root().closest("[data-llm-workflow-test]") as HTMLElement;
    const style = host.getAttribute("style");
    host.style.left = "0";
    host.style.width = "420px";
    host.style.height = "900px";
    host.style.zIndex = "99999";
    try {
      await api.seedTaskProgressConversation({
        panelId: panel.panelId,
        turns: turns() as never,
      });
      await api.reopenTaskProgressConversation({ panelId: panel.panelId });
      const drawer = await openDrawer(root);
      const places: unknown[] = [];
      await bothThemes(win, drawer, "item pane drawer", places);
      // The chat's own paper: in each question's "Cited" card, not a row.
      assert.lengthOf(
        Array.from(
          drawer().querySelectorAll('.llm-task-card[data-card="cited"]'),
        ).filter((card) => !(card as HTMLElement).hidden),
        2,
        "each question lists the paper in its Cited card",
      );
      // Question 2 quotes the paper without reading it again: its card
      // opens with where it was read, and question 1's reads it did not
      // cite, folded.
      const earlier = (
        Array.from(
          drawer().querySelectorAll(
            '.llm-task-card[data-card="cited"] .llm-task-cited-list',
          ),
        ) as HTMLElement[]
      )
        .map((list) => ({
          how: (list.firstElementChild as HTMLElement | null)?.querySelector(
            ".llm-task-paper-how",
          )?.textContent,
          go: (list.firstElementChild as HTMLElement | null)?.querySelector(
            "button",
          )?.textContent,
          fold: list.querySelector(".llm-task-cited-fold .llm-task-fold-text")
            ?.textContent,
        }))
        .filter((entry) => entry.how === "Read while answering Question 1");
      assert.deepEqual(
        earlier,
        [
          {
            how: "Read while answering Question 1",
            go: "Go to Question 1",
            fold: "Read, not cited (1)",
          },
        ],
        "question 2's card says where the paper was read",
      );
      assert.isNull(
        drawer().querySelector(
          `li.llm-task-paper[data-item-id="${fixture.parentItemId}"]`,
        ),
        "the paper is not a row of In your library",
      );
      check(places, ["paper", "web"]);
    } finally {
      if (style === null) host.removeAttribute("style");
      else host.setAttribute("style", style);
    }
  });

  it("runs from the check in the standalone window's chat and side panel tab", async function () {
    await api.openStandaloneForItem(fixture.parentItemId);
    await api.resizeStandaloneWindow(1300, 860);
    await api.clickStandaloneTab("open");
    const win = (Zotero as any).LLMForZotero.data.standaloneWindow as any;
    const root = () =>
      win.document.querySelector(
        ".llm-standalone-content #llm-main",
      ) as HTMLElement;
    await until(() => Boolean(root()), "the standalone window shows a chat");
    await api.seedTaskProgressConversation({
      surface: "standalone",
      turns: turns() as never,
    });
    await api.reopenTaskProgressConversation({ surface: "standalone" });
    const drawer = await openDrawer(root);
    const places: unknown[] = [];
    await bothThemes(win, drawer, "standalone drawer", places);
    win.focus();
    (root().querySelector(".llm-task-progress-move") as HTMLElement).click();
    const docked = () =>
      win.document.querySelector(
        ".llm-task-progress-docked",
      ) as HTMLElement | null;
    await until(() => {
      api.flushTaskProgress();
      return Boolean(docked()) && docked()!.getBoundingClientRect().width > 0;
    }, "Task progress shows in the side panel tab");
    await until(
      () => docked()!.getBoundingClientRect().right <= win.innerWidth + 1,
      "the window grows to hold the tab",
      15000,
    );
    await bothThemes(win, () => docked()!, "side panel tab", places);
    check(places);
  });
});
