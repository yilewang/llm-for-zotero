import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";
import {
  UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
  UPSTREAM_PAPER_CONVERSATION_KEY_BASE,
} from "../src/shared/conversationKeySpace";
import {
  clearAllUsageEvents,
  deleteUsageEventsForConversation,
  initUsageStore,
  recordUsageEvent,
} from "../src/utils/usageStore";
import { formatUsageFullDateLabel } from "../src/utils/usageView";

/**
 * The Usage preferences tab, driven through the real preferences window.
 *
 * A unit test can prove the heatmap's geometry; only this can prove that the
 * tab is reachable, that the SVG the panel builds actually lands in a Gecko
 * chrome document, and that switching a sub-tab does not leave the pane blank.
 * The panel has no server and no CDN behind it, so everything asserted here is
 * built by the plugin itself.
 */

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

const PAPER_KEY = UPSTREAM_PAPER_CONVERSATION_KEY_BASE + 90210;
const LIBRARY_KEY = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 90211;
const SEEDED_KEYS = [PAPER_KEY, LIBRARY_KEY];

function openPreferences(): Window {
  const win = (
    Zotero.Utilities.Internal as unknown as {
      openPreferences: (pane: string) => Window;
    }
  ).openPreferences("llmforzotero-preferences");
  assert.isOk(win, "preferences window should open");
  return win;
}

async function closePreferences(win: Window): Promise<void> {
  win.close();
  const deadline = Date.now() + 10000;
  while (!win.closed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.isTrue(
    win.closed,
    "preferences window should close before the next suite runs",
  );
}

/** Wait until the preferences pane has built its dynamic settings UI. */
async function waitForPaneReady(win: Window): Promise<Element> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const pane = win.document.querySelector("#llmforzotero-prefs");
    const modelSections = pane?.querySelector("#llmforzotero-model-sections");
    const rect = (pane as HTMLElement | null)?.getBoundingClientRect?.();
    if (pane && rect && rect.height > 0 && modelSections?.childElementCount) {
      return pane;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("preferences pane never finished rendering");
}

/** Click the Usage tab and wait for the panel to finish its first load. */
async function openUsageTab(win: Window): Promise<HTMLElement> {
  const doc = win.document;
  const tab = doc.querySelector(
    '[data-pref-tab="usage"]',
  ) as HTMLElement | null;
  assert.isOk(tab, "the tab bar should carry a Usage tab");
  tab!.click();
  const root = doc.querySelector("#llmforzotero-usage-root") as HTMLElement;
  assert.isOk(root, "the Usage panel root should exist");
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const settled =
      root.querySelector("[data-usage-card]") ||
      root.querySelector("[data-usage-empty]");
    if (settled && root.getBoundingClientRect().height > 0) return root;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `the Usage panel never rendered (html: ${root.innerHTML.slice(0, 400)})`,
  );
}

/** Click a control and let the panel's re-render (and any query) land. */
async function pick(
  root: HTMLElement,
  selector: string,
  settled: () => boolean,
): Promise<void> {
  const button = root.querySelector(selector) as HTMLElement | null;
  assert.isOk(button, `the panel should offer ${selector}`);
  button!.click();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (settled()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`clicking ${selector} never settled`);
}

/**
 * A real mouse event on a real SVG cell.
 *
 * The panel listens for plain DOM mouse events, so the test has to send plain
 * DOM mouse events; a synthetic object would prove nothing about Gecko.
 */
function sendMouse(
  win: Window,
  target: Element,
  type: string,
  point: { clientX: number; clientY: number },
): void {
  const MouseEventCtor = (win as unknown as { MouseEvent?: typeof MouseEvent })
    .MouseEvent;
  assert.isFunction(
    MouseEventCtor,
    "the preferences window should expose MouseEvent",
  );
  target.dispatchEvent(
    new MouseEventCtor!(type, {
      bubbles: type === "mousemove",
      cancelable: true,
      view: win as unknown as globalThis.Window,
      clientX: point.clientX,
      clientY: point.clientY,
    }),
  );
}

/** The centre of an element, in client coordinates. */
function centerOf(element: Element): { clientX: number; clientY: number } {
  const rect = element.getBoundingClientRect();
  return {
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
}

function sectionTitles(root: HTMLElement): string[] {
  return (
    Array.from(root.querySelectorAll("[data-usage-section]")) as Element[]
  ).map((node) => node.getAttribute("data-usage-section") || "");
}

describe("workflow: usage statistics preferences tab", function () {
  this.timeout(180000);
  let api: WorkflowTestApi;
  const fixtures: WorkflowTestFixture[] = [];

  before(async function () {
    // Resolved at run time: an earlier suite may have restarted the plugin.
    api = getWorkflowTestApi();
    // Earlier suites answer real turns, and a recorded turn is exactly what
    // this ledger is for, so the never-used state has to be established rather
    // than assumed. No other workflow suite reads the usage ledger.
    await initUsageStore();
    assert.isTrue(await clearAllUsageEvents());
  });

  after(async function () {
    for (const key of SEEDED_KEYS) {
      await deleteUsageEventsForConversation(key);
    }
    for (const fixture of fixtures) {
      await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  it("explains itself instead of drawing empty charts before anything is recorded", async function () {
    const win = openPreferences();
    try {
      await waitForPaneReady(win);
      const root = await openUsageTab(win);
      const empty = root.querySelector('[data-usage-empty="none"]');
      assert.isOk(
        empty,
        `an empty ledger should explain itself (html: ${root.innerHTML.slice(0, 300)})`,
      );
      assert.isNull(
        root.querySelector("[data-usage-heatmap]"),
        "no heatmap may be drawn when there is nothing to draw",
      );
      assert.isNull(
        root.querySelector("[data-usage-chart]"),
        "no token chart may be drawn when there is nothing to draw",
      );
    } finally {
      await closePreferences(win);
    }
  });

  it("renders the heatmap, the chart, the cards and both detail lists", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Usage Panel Fixture Paper",
      pdfTitle: "Usage Panel Fixture Paper PDF",
    });
    fixtures.push(fixture);

    await initUsageStore();
    const now = Date.now();
    // Forty days of history so the heatmap has several columns and the chart
    // has bars in both colours.
    for (let offset = 0; offset < 40; offset += 1) {
      const day = new Date(now);
      day.setDate(day.getDate() - offset);
      day.setHours(12, 0, 0, 0);
      if (offset % 3 === 0) {
        assert.isTrue(
          await recordUsageEvent({
            mode: "paper",
            conversationKey: PAPER_KEY,
            paperItemID: fixture.parentItemId,
            timestamp: day.getTime(),
            model: "gpt-4o",
            provider: "openai",
            runtime: "chat",
            promptTokens: 1200 + offset * 40,
            completionTokens: 400 + offset * 10,
            totalTokens: 1600 + offset * 50,
          }),
          "the paper-chat fixture row must be written",
        );
      }
      if (offset % 2 === 0) {
        assert.isTrue(
          await recordUsageEvent({
            mode: "library",
            conversationKey: LIBRARY_KEY,
            timestamp: day.getTime(),
            model: "gpt-4o",
            provider: "openai",
            runtime: "chat",
            promptTokens: 800 + offset * 20,
            completionTokens: 250,
            totalTokens: 1050 + offset * 20,
          }),
          "the library-chat fixture row must be written",
        );
      }
    }

    const win = openPreferences();
    try {
      await waitForPaneReady(win);
      const root = await openUsageTab(win);
      assert.isNull(
        root.querySelector("[data-usage-empty]"),
        "a seeded ledger must not render an empty state",
      );

      // ── Overview ────────────────────────────────────────────────
      assert.lengthOf(
        root.querySelectorAll("[data-usage-card]"),
        3,
        "Overview shows exactly three metric cards",
      );
      const cells = root.querySelectorAll("[data-usage-heatmap-cell]");
      assert.isAtLeast(
        cells.length,
        30,
        "the heatmap must paint one cell per day in its window",
      );
      const firstCell = cells[0] as SVGElement;
      assert.equal(
        firstCell.namespaceURI,
        "http://www.w3.org/2000/svg",
        "heatmap cells are real SVG nodes",
      );
      assert.lengthOf(
        root.querySelectorAll("[data-usage-heatmap] title"),
        0,
        "the native SVG tooltip is gone; the hover card replaced it",
      );
      const heatmapSvg = root.querySelector(
        "[data-usage-heatmap]",
      ) as SVGGraphicsElement | null;
      assert.isOk(heatmapSvg, "the heatmap should be in the layout");
      assert.isAbove(
        heatmapSvg!.getBoundingClientRect().height,
        0,
        "the heatmap must actually be laid out, not a zero-size node",
      );
      assert.isAtLeast(
        root.querySelectorAll("[data-usage-chart-bar]").length,
        10,
        "the token chart must paint a bar segment per active day",
      );
      assert.isAbove(
        (
          root.querySelector("[data-usage-chart]") as SVGGraphicsElement
        ).getBoundingClientRect().height,
        0,
        "the token chart must be laid out",
      );
      assert.isAtLeast(
        root.querySelectorAll('[data-usage-row="model"]').length,
        1,
        "the model table must list the model that answered",
      );
      assert.includeMembers(
        sectionTitles(root),
        ["Activity", "Tokens per day", "Models"],
        "Overview carries the heatmap, the chart and the model table",
      );
      // The Usage tab reports tokens, never money: no cost card, and no
      // currency anywhere on the pane.
      assert.deepEqual(
        (
          Array.from(root.querySelectorAll("[data-usage-card]")) as Element[]
        ).map((card) => card.getAttribute("data-usage-card")),
        ["Paper chat", "Library chat", "Tokens"],
        "Overview shows Paper chat, Library chat and Tokens",
      );
      assert.notMatch(
        root.textContent || "",
        /[$€£]|\bUSD\b|Estimated cost/,
        "no price or currency may appear anywhere on the Usage tab",
      );

      // ── Heatmap metric toggle ───────────────────────────────────
      const summary = () =>
        root.querySelector("[data-usage-heatmap-summary]")?.textContent || "";
      // The nouns are pluralised, so a one-paper fixture reads "1 distinct
      // paper"; the assertion matches the shape, not one arity of it.
      assert.match(summary(), /\d+ questions? across \d+ active days?/);
      await pick(root, '[data-usage-metric="papers"]', () =>
        /\d+ distinct papers? across \d+ active days?/.test(summary()),
      );
      // ── Hover card ──────────────────────────────────────────────
      const grid = root.querySelector(
        "[data-usage-heatmap]",
      ) as SVGGraphicsElement;
      const popover = root.querySelector(
        "[data-usage-popover]",
      ) as HTMLElement | null;
      assert.isOk(popover, "the Overview builds one hover card for the grid");
      const today = (
        Array.from(
          root.querySelectorAll("[data-usage-heatmap-cell]"),
        ) as Element[]
      ).at(-1) as SVGElement;
      const todayKey = today.getAttribute("data-usage-heatmap-cell") || "";
      sendMouse(win, today, "mouseenter", centerOf(today));
      assert.equal(
        popover!.style.display,
        "block",
        "hovering a cell shows the card",
      );
      assert.isAbove(
        popover!.getBoundingClientRect().height,
        0,
        "and the card is really laid out, not a zero-size node",
      );
      // Today is the right-most column, so this is the flip: the card has to
      // land inside the pane rather than hanging off its edge.
      const cardBox = popover!.getBoundingClientRect();
      const rootBox = root.getBoundingClientRect();
      assert.isAtMost(
        Math.round(cardBox.right),
        Math.round(rootBox.right),
        "the hover card must not clip past the pane's right edge",
      );
      assert.isAtLeast(
        Math.round(cardBox.left),
        Math.round(rootBox.left),
        "nor past its left edge",
      );
      // In Papers mode the card counts papers, and it names the day it is over.
      assert.include(
        popover!.textContent || "",
        formatUsageFullDateLabel(
          todayKey,
          (win as unknown as { navigator?: { language?: string } }).navigator
            ?.language,
        ),
        "the card's first line is the day under the pointer",
      );
      assert.match(
        (popover!.textContent || "").toLowerCase(),
        /papers?/,
        "switching the metric must rewrite the card's wording too",
      );
      sendMouse(win, grid, "mouseleave", { clientX: 0, clientY: 0 });
      assert.equal(
        popover!.style.display,
        "none",
        "leaving the grid hides the card again",
      );
      await pick(root, '[data-usage-metric="questions"]', () =>
        /\d+ questions? across \d+ active days?/.test(summary()),
      );

      // ── Sub-tabs ────────────────────────────────────────────────
      await pick(root, '[data-usage-subtab="paper"]', () =>
        sectionTitles(root).includes("Papers you asked about most"),
      );
      assert.isNull(
        root.querySelector("[data-usage-heatmap]"),
        "only one sub-tab's content is in the layout at a time",
      );
      assert.deepEqual(
        (
          Array.from(root.querySelectorAll("[data-usage-card]")) as Element[]
        ).map((card) => card.getAttribute("data-usage-card")),
        ["Questions", "Tokens", "Papers"],
        "the paper tab shows Questions, Tokens and Papers",
      );
      const paperRows = Array.from(
        root.querySelectorAll('[data-usage-row="detail"]'),
      ) as Element[];
      assert.isAtLeast(
        paperRows.length,
        1,
        "the paper tab lists the papers that were asked about",
      );
      // The row's primary text is the paper's own title, not the citation
      // label the shared display helper produces.
      assert.equal(
        paperRows[0]!.firstElementChild?.firstElementChild?.textContent,
        "Usage Panel Fixture Paper",
        "the list shows the title the user knows the paper by",
      );

      await pick(root, '[data-usage-subtab="library"]', () =>
        sectionTitles(root).includes("Heaviest conversations"),
      );
      assert.notInclude(
        sectionTitles(root),
        "Papers you asked about most",
        "the library tab never lists paper titles",
      );
      assert.deepEqual(
        (
          Array.from(root.querySelectorAll("[data-usage-card]")) as Element[]
        ).map((card) => card.getAttribute("data-usage-card")),
        ["Questions", "Tokens", "Conversations"],
        "the library tab shows Questions, Tokens and Conversations",
      );

      // ── Range control ───────────────────────────────────────────
      await pick(root, '[data-usage-range="last7"]', () =>
        Boolean(
          root
            .querySelector('[data-usage-range="last7"]')
            ?.getAttribute("aria-selected") === "true" &&
          root.querySelector("[data-usage-card]"),
        ),
      );
      assert.lengthOf(
        root.querySelectorAll("[data-usage-card]"),
        3,
        "narrowing the range keeps the tab rendered",
      );

      await pick(root, '[data-usage-subtab="overview"]', () =>
        sectionTitles(root).includes("Activity"),
      );
      // The heatmap is an activity calendar over the history that exists, so
      // narrowing the range must not shrink it to two columns; the token chart
      // is the part the range control filters.
      assert.isAtLeast(
        root.querySelectorAll("[data-usage-heatmap-cell]").length,
        30,
        "the heatmap keeps its own window when the range narrows",
      );
      const narrowedBars = new Set(
        (
          Array.from(
            root.querySelectorAll("[data-usage-chart-bar]"),
          ) as Element[]
        ).map((node) => node.getAttribute("data-usage-chart-bar")),
      );
      assert.isAtMost(
        narrowedBars.size,
        7,
        "the token chart covers only the seven days the range asked for",
      );

      // ── Footer ──────────────────────────────────────────────────
      assert.isOk(
        root.querySelector('[data-usage-action="export"]'),
        "the footer offers Export CSV",
      );
      assert.isOk(
        root.querySelector('[data-usage-action="reset"]'),
        "the footer offers Reset statistics",
      );

      // Every seeded row above was measured by a provider, so the panel must
      // not claim any of these tokens is an estimate.
      assert.isNull(
        root.querySelector("[data-usage-estimate-note]"),
        "a fully measured range must carry no estimate caveat",
      );
    } finally {
      await closePreferences(win);
    }
  });

  it("says plainly that pre-cutover tokens are estimates", async function () {
    await initUsageStore();
    // One turn rebuilt from chat history by the backfill: both numbers are
    // estimates -- input from the recorded context size, output from the
    // stored answer text -- and the row is flagged as reconstructed.
    assert.isTrue(
      await recordUsageEvent({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: Date.now(),
        model: "deepseek-chat",
        provider: "DeepSeek",
        runtime: "chat",
        promptTokens: 4200,
        completionTokens: 380,
        totalTokens: 4580,
        tokenSource: "history-estimate",
      }),
      "the backfilled fixture row must be written",
    );

    const win = openPreferences();
    try {
      await waitForPaneReady(win);
      const root = await openUsageTab(win);
      const note = root.querySelector("[data-usage-estimate-note]");
      assert.isOk(
        note,
        "a range that reaches back before the ledger must say so once",
      );
      assert.match(
        note!.textContent || "",
        /tokens are estimated from the stored text/,
        "the caveat says both numbers are estimated, and from what",
      );
      assert.lengthOf(
        root.querySelectorAll("[data-usage-estimate-note]"),
        1,
        "the caveat is one sub-line, not a new panel element",
      );
      // The heatmap needs no caveat: questions and papers come from real
      // messages and are exact.
      assert.isOk(
        root.querySelector("[data-usage-heatmap]"),
        "the activity calendar still renders beside the caveat",
      );
    } finally {
      await closePreferences(win);
    }
  });
});
