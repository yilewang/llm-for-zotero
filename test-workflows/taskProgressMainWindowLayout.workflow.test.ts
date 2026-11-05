/**
 * A paper chat in Zotero's main window, where every button is capped at
 * 25px: a question header whose words take two lines keeps its height, so
 * its meta line and the cards under it never draw over each other. A quote
 * the answer cites that is only the paper's title opens the paper at its
 * first page, with no "couldn't find this passage" warning.
 */
import { assert } from "chai";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const TITLE =
  "Signal and action coupling measures predict code change in a sample study";
const FIRST =
  "Give a concise narrative overview of the paper in 1-2 short paragraphs, covering the research question, approach, main findings, and significance.";
const SECOND = "Describe the methodology used in the paper.";
/** A cited passage with inline math, as MinerU writes it. */
const MATH_QUOTE =
  "Tuning drifted by $1 \\% - 3 \\%$ per day across all recorded sessions.";

describe("workflow: task progress in the main window", function () {
  this.timeout(120000);
  const prefs: Array<[string, unknown]> = [
    ["extensions.zotero.llmforzotero.enableAgentMode", true],
    ["extensions.zotero.llmforzotero.lastUsedRuntimeMode", "agent"],
  ];
  const saved = new Map<string, unknown>();
  let api: WorkflowTestApi;
  let win: any;
  let libraryID: number;
  let fixture: WorkflowTestFixture;
  const shots: string[] = [];
  let other: WorkflowTestFixture;
  let collection: Zotero.Collection;
  const report: Record<string, unknown> = {};

  async function until(
    check: () => boolean,
    message: string | (() => string),
    ms = 20000,
  ) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(40);
    assert.isTrue(check(), typeof message === "function" ? message() : message);
  }

  function rootOf(panelId: string): HTMLElement {
    return win.document.querySelector(
      `[data-workflow-panel-id="${panelId}"]`,
    ) as HTMLElement;
  }

  /** Bring the synthetic panel on screen, as wide as the item pane. */
  function showOnScreen(panelId: string): () => void {
    const host = rootOf(panelId).closest(
      "[data-llm-workflow-test]",
    ) as HTMLElement;
    const previous = host.getAttribute("style");
    host.style.left = "0";
    host.style.width = "420px";
    host.style.height = "900px";
    host.style.zIndex = "99999";
    host.style.background = "var(--material-background, #fff)";
    return () => {
      if (previous === null) host.removeAttribute("style");
      else host.setAttribute("style", previous);
    };
  }

  async function capture(panelId: string, filename: string) {
    const rect = rootOf(panelId).getBoundingClientRect();
    const canvas = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    );
    const scale = win.devicePixelRatio || 1;
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);
    canvas.width = width * scale;
    canvas.height = height * scale;
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    context.drawWindow(win, rect.left, rect.top, width, height, "#ffffff");
    const binary = win.atob(canvas.toDataURL("image/png").split(",")[1]);
    const path = `${Zotero.DataDirectory.dir}/${filename}`;
    await win.IOUtils.write(
      path,
      Uint8Array.from(binary, (char: any) => char.charCodeAt(0)),
    );
    shots.push(path);
  }

  async function closeReaders() {
    for (const reader of [...((Zotero as any).Reader._readers || [])]) {
      if (reader.itemID === fixture?.pdfAttachmentId) await reader.close?.();
    }
  }

  function delta(callId: string, runId: string) {
    const key = `${libraryID}:${fixture.parentItemId}`;
    return {
      version: 1 as const,
      callId,
      runId,
      toolName: "library_retrieve",
      papers: [
        {
          key,
          libraryID,
          itemId: fixture.parentItemId,
          contextItemId: fixture.pdfAttachmentId,
          title: TITLE,
          text: "pdf_text" as const,
          state: "read" as const,
        },
      ],
      reads: [
        {
          key,
          callId,
          toolName: "library_retrieve",
          granularity: "passage" as const,
          method: "bm25",
          label: "Results",
          snippet: "Tuning stability correlates with pairwise redundancy.",
        },
      ],
    };
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    win = Zotero.getMainWindow();
    for (const [name, value] of prefs) {
      saved.set(name, Zotero.Prefs.get(name, true));
      Zotero.Prefs.set(name, value as never, true);
    }
    libraryID = Zotero.Libraries.userLibraryID;
    collection = new Zotero.Collection();
    (collection as { libraryID: number }).libraryID = libraryID;
    collection.name = `Main window layout ${Date.now()}`;
    await collection.saveTx();
    fixture = await api.createPaperWithPdfFixture({
      title: TITLE,
      pdfTitle: TITLE,
      pages: [
        `${TITLE}. Abstract. Population tuning drifts over days.`,
        "Results. Tuning stability correlates with pairwise redundancy.",
        `Drift. ${MATH_QUOTE}`,
      ],
    });
    other = await api.createPaperWithPdfFixture({
      title: "Drift without landmarks",
      pdfTitle: "Drift without landmarks",
      pages: ["Path integration drifts without landmarks."],
    });
    for (const id of [fixture.parentItemId, other.parentItemId]) {
      const item = Zotero.Items.get(id);
      item.setCollections([collection.id]);
      await item.saveTx();
    }
  });

  after(async function () {
    await closeReaders();
    await api.reset();
    await api.cleanupFixture(fixture);
    await api.cleanupFixture(other);
    await collection?.eraseTx().catch(() => undefined);
    for (const [name, value] of saved) {
      if (value === undefined) Zotero.Prefs.clear(name, true);
      else Zotero.Prefs.set(name, value as never, true);
    }
    report.shots = shots;
    await win.IOUtils.writeUTF8(
      `${Zotero.DataDirectory.dir}/tp-main-window-report.json`,
      JSON.stringify(report, null, 2),
    );
  });

  it("keeps two-line question headers clear of the cards, and opens a title-only citation at page 1", async function () {
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const restore = showOnScreen(panel.panelId);
    const root = rootOf(panel.panelId);
    const status = () =>
      root.querySelector("#llm-status")?.textContent?.trim() || "";
    try {
      // The window's own cap on buttons, which the headers must undo.
      const probe = win.document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "button",
      );
      root.append(probe);
      const cap = win.getComputedStyle(probe).maxHeight;
      probe.remove();
      report.buttonCap = cap;

      const titleCite = buildQuoteCitation({
        quoteText: TITLE,
        citationLabel: "(Kendrick et al., 2026)",
        sourceMatchText: TITLE,
        sourceMatchKind: "exact",
        sourceMatchSource: "context-text",
        itemId: fixture.parentItemId,
        contextItemId: fixture.pdfAttachmentId,
      })!;
      const mathCite = buildQuoteCitation({
        quoteText: MATH_QUOTE,
        citationLabel: "(Kendrick et al., 2026)",
        sourceMatchText: MATH_QUOTE,
        sourceMatchKind: "exact",
        sourceMatchSource: "context-text",
        itemId: fixture.parentItemId,
        contextItemId: fixture.pdfAttachmentId,
      })!;
      const firstAnswer =
        `Kendrick et al. ask why drift varies [[quote:${titleCite.id}]].\n\n` +
        `Drift is slow [[quote:${mathCite.id}]].`;
      const scope = {
        selectedCollectionContexts: [
          { collectionId: collection.id, name: collection.name, libraryID },
        ],
      };
      const first = `tp-main-1-${Date.now()}`;
      const second = `tp-main-2-${Date.now()}`;
      await api.seedTaskProgressConversation({
        panelId: panel.panelId,
        turns: [
          {
            runId: first,
            user: { text: FIRST, ...scope },
            answer: firstAnswer,
            quoteCitations: [titleCite, mathCite],
            events: [
              {
                type: "paper_ledger_update",
                callId: "c1",
                delta: delta("c1", first),
              },
              {
                type: "final",
                text: firstAnswer,
              },
            ],
          },
          {
            runId: second,
            user: { text: SECOND, ...scope },
            answer: "A reanalysis of two calcium-imaging datasets.",
            events: [
              {
                type: "paper_ledger_update",
                callId: "c2",
                delta: delta("c2", second),
              },
            ],
          },
        ],
      });
      await api.reopenTaskProgressConversation({ panelId: panel.panelId });
      const row = () =>
        root.querySelector("#llm-task-progress") as HTMLButtonElement;
      await until(() => {
        api.flushTaskProgress();
        return Boolean(row()) && !row().hidden;
      }, "the Task progress row shows");
      const drawer = () =>
        root.querySelector("#llm-task-progress-drawer") as HTMLElement;
      if (drawer().hidden) row().click();
      const heads = () =>
        Array.from(
          root.querySelectorAll(".llm-task-progress-dock-question"),
        ) as HTMLButtonElement[];
      await until(
        () => {
          api.flushTaskProgress();
          return heads().length === 2;
        },
        () => `both questions list (${heads().length})`,
      );
      for (const head of heads())
        if (head.getAttribute("aria-expanded") !== "true") head.click();
      await until(() => {
        api.flushTaskProgress();
        return heads().every(
          (head) => head.getAttribute("aria-expanded") === "true",
        );
      }, "both questions unroll");
      await until(
        () => drawer().dataset.state === "open",
        "the drawer settles open",
      );

      report.headers = heads().map((head) => ({
        words:
          head.querySelector(".llm-task-progress-dock-question-words")
            ?.textContent || "",
        clientHeight: head.clientHeight,
        scrollHeight: head.scrollHeight,
      }));
      for (const head of heads()) {
        const words =
          head.querySelector(".llm-task-progress-dock-question-words")
            ?.textContent || "";
        assert.isAtMost(
          head.scrollHeight,
          head.clientHeight + 1,
          `"${words}": the header holds its words and meta (${head.clientHeight}/${head.scrollHeight}px, window cap ${cap})`,
        );
        const meta = head.querySelector(
          ".llm-task-progress-dock-question-meta",
        ) as HTMLElement;
        const body = head.nextElementSibling as HTMLElement | null;
        assert.isOk(body, `"${words}": its body follows the header`);
        assert.isAtMost(
          meta.getBoundingClientRect().bottom,
          body!.getBoundingClientRect().top + 1,
          `"${words}": the meta line ends above the cards`,
        );
      }
      const longHead = heads().find((head) =>
        (head.textContent || "").includes("concise narrative"),
      )!;
      assert.isAbove(
        longHead.getBoundingClientRect().height,
        40,
        "the two-line header is taller than one line",
      );
      await capture(panel.panelId, "tp-main-window-headers.png");

      // Question 1's answer quotes the chat's own paper as a card: the
      // paper leaves "In your library" for its own "Cited" card, which lists
      // the passage without a number (a card has none).
      const firstSection = longHead.closest(
        ".llm-task-progress-question-section",
      ) as HTMLElement;
      const citedCard = () =>
        firstSection.querySelector(
          '.llm-task-card[data-card="cited"]',
        ) as HTMLElement | null;
      const passage = () =>
        citedCard()?.querySelector(
          ".llm-task-cited-item .llm-task-paper-snippet",
        ) as HTMLElement | null;
      await until(() => {
        api.flushTaskProgress();
        return Boolean(passage());
      }, "the paper's Cited card lists the quoted passage");
      assert.equal(
        citedCard()!.querySelector(".llm-task-card-title")?.textContent,
        "Cited",
      );
      assert.include(passage()!.textContent!, TITLE);
      assert.isNull(
        citedCard()!.querySelector(".llm-task-cited-number"),
        "a passage quoted as a card has no number",
      );
      assert.isNull(
        firstSection.querySelector(
          `li.llm-task-paper[data-item-id="${fixture.parentItemId}"]`,
        ),
        "the chat's own paper is not a row of In your library",
      );
      // A cited passage with math renders it, as the answer's quote card
      // does: no TeX source shows as text outside the rendered formula.
      const mathPassage = (
        Array.from(
          citedCard()!.querySelectorAll(
            ".llm-task-cited-item .llm-task-paper-snippet",
          ),
        ) as HTMLElement[]
      ).find((node) => (node.textContent || "").includes("per day across"));
      assert.isOk(
        mathPassage,
        `the passage with math is listed: ${citedCard()!.textContent}`,
      );
      assert.isOk(
        mathPassage!.querySelector(".katex .katex-html"),
        "its math renders with KaTeX",
      );
      const proseText: string[] = [];
      const walker = win.document.createTreeWalker(mathPassage!, 4);
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (!(node.parentElement as HTMLElement | null)?.closest(".katex"))
          proseText.push(node.textContent || "");
      report.mathPassageProse = proseText.join("");
      assert.notInclude(proseText.join(""), "\\%", "no literal TeX shows");
      assert.notInclude(proseText.join(""), "$", "no math delimiter shows");
      assert.include(proseText.join(""), "Tuning drifted by");
      // The paper's reads fade in over 300ms (later lines 180ms after).
      await Zotero.Promise.delay(600);
      await capture(panel.panelId, "tp-main-window-cited.png");
    } finally {
      restore();
      await closeReaders();
      win.Zotero_Tabs?.select?.("zotero-pane");
    }
  });
});
