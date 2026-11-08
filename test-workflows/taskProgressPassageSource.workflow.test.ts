/**
 * "Source" on a passage the Task progress card lists: a click opens the
 * paper's PDF in the reader and highlights the passage through the same
 * pipeline a quote card's jump uses; a passage not in the PDF's text falls
 * back to the page its label names; a paper with no PDF says so; a
 * whole-paper read opens the paper at its first page without a search. A
 * quote the answer cites lists under "Cited" and opens in its paper the
 * same way from the answer's quote cards, one after another on one page.
 * The paper chat's own paper is a row until the answer cites it; then it
 * lists in its "Cited" card, its reads the answer did not cite folded. The
 * card stays as it was (the paper expanded, the drawer open).
 */
import { assert } from "chai";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";
import { getReaderContextPanelForTab } from "../src/modules/contextPanel/readerPopupPanelRouting";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

/** As the PDF's text layer has it: the symbol set in plain text. */
const SENTENCE =
  "Turnover of dendritic spines s(t) predicts the rate at which place fields reorganize over two weeks of recording in the same animals.";
/** Also on page 2, after SENTENCE: a second quote with one match there. */
const SAME_PAGE_SENTENCE = "These changes were stable across sessions.";
/**
 * As MinerU's Markdown has it: a heading, the symbol in TeX, and the ledger's
 * clip mid-word. Neither the shown nor the stored text is in the PDF as is.
 */
const MINERU_SNIPPET =
  "## Results\nTurnover of dendritic spines $s_t$ predicts the rate at which place fields reorganize over two weeks of rec…";
const TITLES = [
  "Spine turnover and place field drift",
  "Figures of drifting assemblies",
  "Drift without a PDF",
];

describe("workflow: task progress passage source", function () {
  this.timeout(120000);
  const prefs: Array<[string, unknown]> = [
    ["extensions.zotero.llmforzotero.enableAgentMode", true],
    ["extensions.zotero.llmforzotero.lastUsedRuntimeMode", "agent"],
    ["extensions.zotero.llmforzotero.sidebarLayout", "independent"],
  ];
  const saved = new Map<string, unknown>();
  const layoutPref = "extensions.zotero.llmforzotero.sidebarLayout";
  let api: WorkflowTestApi;
  let win: any;
  let libraryID: number;
  let collection: Zotero.Collection;
  const fixtures: WorkflowTestFixture[] = [];
  let noPdfItem: Zotero.Item;

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

  function showOnScreen(panelId: string): () => void {
    const host = rootOf(panelId).closest(
      "[data-llm-workflow-test]",
    ) as HTMLElement;
    const previous = host.getAttribute("style");
    host.style.left = "0";
    host.style.width = "420px";
    host.style.height = "760px";
    host.style.zIndex = "99999";
    return () => {
      if (previous === null) host.removeAttribute("style");
      else host.setAttribute("style", previous);
    };
  }

  function activeReader(): any {
    const tabId = win.Zotero_Tabs.selectedID;
    return (Zotero as any).Reader.getByTabID?.(tabId) || null;
  }

  /** The reader's current 0-based page, from the PDF.js viewer. */
  function readerPageIndex(reader: any): number | null {
    for (const view of [
      reader?._internalReader?._lastView,
      reader?._internalReader?._primaryView,
    ]) {
      const frame = view?._iframeWindow;
      const app = (frame?.wrappedJSObject || frame)?.PDFViewerApplication;
      const page = Number(app?.pdfViewer?.currentPageNumber);
      if (Number.isFinite(page) && page > 0) return page - 1;
    }
    return null;
  }

  async function closeReaders() {
    const ids = new Set(fixtures.map((fixture) => fixture.pdfAttachmentId));
    for (const reader of [...((Zotero as any).Reader._readers || [])]) {
      if (ids.has(reader.itemID)) await reader.close?.();
    }
  }

  function activeDetails(): any {
    const readerPane = getReaderContextPanelForTab(
      win.document,
      win.Zotero_Tabs.selectedID,
    );
    if (readerPane) return readerPane;
    return Array.from(win.document.querySelectorAll("item-details")).find(
      (node: any) =>
        node.tabType === "library" && node.getBoundingClientRect().width > 0,
    );
  }

  /** The chat in the library tab's item pane, opened in the independent layout. */
  async function openLibrarySidebarChat(): Promise<() => HTMLElement> {
    Zotero.Prefs.set(layoutPref, "independent", true);
    win.Zotero_Tabs.select("zotero-pane");
    await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
    const details = activeDetails();
    assert.isOk(details, "native item details is visible");
    const section = () =>
      details.querySelector(".llm-dedicated-chat-pane") as HTMLElement;
    const rootOf = () => section()?.querySelector("#llm-main") as HTMLElement;
    const mainVisible = () =>
      (rootOf()?.getBoundingClientRect().height || 0) > 0;
    if (
      win.document.documentElement.getAttribute("data-llm-pane-view") !==
        "chat" ||
      details.sidenav._collapsed ||
      !mainVisible()
    ) {
      const paneID = section()?.dataset.pane;
      const button: any = Array.from(
        details.sidenav.querySelectorAll("[data-pane]"),
      ).find((node: any) => node.getAttribute("data-pane") === paneID);
      assert.isOk(button, "the plugin's rail icon exists");
      button.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, detail: 1, button: 0 }),
      );
    }
    await until(
      () =>
        win.document.documentElement.getAttribute("data-llm-pane-view") ===
          "chat" &&
        !details.sidenav._collapsed &&
        mainVisible(),
      "the sidebar chat is open",
    );
    // The pane may still be rebuilding for the selected item: a click on a
    // panel about to be replaced is lost, so it is repeated until it takes.
    const deadline = Date.now() + 20000;
    while (
      rootOf()?.dataset.conversationKind !== "global" &&
      Date.now() < deadline
    ) {
      (
        rootOf().querySelector("#llm-library-chat-tab") as HTMLElement
      ).dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      const settleBy = Date.now() + 2000;
      while (
        rootOf()?.dataset.conversationKind !== "global" &&
        Date.now() < settleBy
      )
        await Zotero.Promise.delay(40);
    }
    assert.equal(
      rootOf()?.dataset.conversationKind,
      "global",
      "Library chat opens",
    );
    return rootOf;
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
    collection.name = `Passage source ${Date.now()}`;
    await collection.saveTx();
    const pages = [
      [
        "Introduction. Representational drift has been reported in many areas.",
        `Results. ${SENTENCE} ${SAME_PAGE_SENTENCE}`,
      ],
      [
        "Overview of the figures in this paper.",
        "Figure 2. Assemblies drift while the readout stays stable.",
      ],
    ];
    for (const [index, pageTexts] of pages.entries()) {
      const fixture = await api.createPaperWithPdfFixture({
        title: TITLES[index],
        pdfTitle: TITLES[index],
        pages: pageTexts,
      });
      fixtures.push(fixture);
      const item = Zotero.Items.get(fixture.parentItemId);
      item.setCollections([collection.id]);
      await item.saveTx();
    }
    noPdfItem = new Zotero.Item("journalArticle");
    noPdfItem.libraryID = libraryID;
    noPdfItem.setField("title", TITLES[2]);
    noPdfItem.setCollections([collection.id]);
    await noPdfItem.saveTx();
  });

  after(async function () {
    await closeReaders();
    await api.reset();
    for (const fixture of fixtures) await api.cleanupFixture(fixture);
    await noPdfItem?.eraseTx().catch(() => undefined);
    await collection?.eraseTx().catch(() => undefined);
    for (const [name, value] of saved) {
      if (value === undefined) Zotero.Prefs.clear(name, true);
      else Zotero.Prefs.set(name, value as never, true);
    }
  });

  it("opens the paper at the passage, falls back to its page, and says when there is no PDF", async function () {
    const panel = await api.renderPanelForItem(fixtures[0].parentItemId);
    const restore = showOnScreen(panel.panelId);
    const root = rootOf(panel.panelId);
    const status = () =>
      root.querySelector("#llm-status")?.textContent?.trim() || "";
    const handle = await api.startTaskProgressReplay({
      panelId: panel.panelId,
      historyTurns: 0,
      user: {
        selectedCollectionContexts: [
          { collectionId: collection.id, name: collection.name, libraryID },
        ],
      },
    });
    try {
      const key = (itemId: number) => `${libraryID}:${itemId}`;
      await handle.emit({
        type: "paper_ledger_update",
        callId: "retrieve-1",
        delta: {
          version: 1,
          callId: "retrieve-1",
          toolName: "library_retrieve",
          papers: [
            {
              key: key(fixtures[0].parentItemId),
              libraryID,
              itemId: fixtures[0].parentItemId,
              contextItemId: fixtures[0].pdfAttachmentId,
              title: TITLES[0],
              text: "pdf_text",
              state: "read",
            },
            {
              key: key(fixtures[1].parentItemId),
              libraryID,
              itemId: fixtures[1].parentItemId,
              contextItemId: fixtures[1].pdfAttachmentId,
              title: TITLES[1],
              text: "mineru",
              state: "read",
            },
            {
              key: key(noPdfItem.id),
              libraryID,
              itemId: noPdfItem.id,
              title: TITLES[2],
              text: "none",
              state: "read",
            },
          ],
          reads: [
            {
              key: key(fixtures[0].parentItemId),
              callId: "retrieve-1",
              toolName: "library_retrieve",
              granularity: "section",
              method: "bm25",
              label: "Results",
              snippet: MINERU_SNIPPET,
            },
            {
              key: key(fixtures[1].parentItemId),
              callId: "retrieve-1",
              toolName: "paper_read",
              granularity: "page",
              method: "view_pages",
              label: "p. 2",
              // MinerU-style text the PDF's text layer does not carry.
              snippet: "$$ \\Delta r = \\alpha t $$ drift coefficient table",
            },
            {
              key: key(noPdfItem.id),
              callId: "retrieve-1",
              toolName: "library_retrieve",
              granularity: "passage",
              method: "bm25",
              label: "Abstract",
              snippet: "Drift was measured without any attached file.",
            },
          ],
        },
      } as never);
      const row = root.querySelector("#llm-task-progress") as HTMLElement;
      await until(() => {
        api.flushTaskProgress();
        return !row.hidden;
      }, "the card shows for a folder turn");
      row.click();
      const own = fixtures[0].parentItemId;
      const paper = (itemId: number) =>
        root.querySelector(
          `.llm-task-paper[data-item-id="${itemId}"]`,
        ) as HTMLElement | null;
      // The paper chat's own paper, once the answer cites it.
      const citedCard = () =>
        root.querySelector(
          '.llm-task-card[data-card="cited"]',
        ) as HTMLElement | null;
      await until(() => {
        api.flushTaskProgress();
        return Boolean(paper(own)) && Boolean(paper(fixtures[1].parentItemId));
      }, "the papers list");
      assert.isTrue(
        !citedCard() || citedCard()!.hidden,
        "nothing is cited yet: no Cited card",
      );
      const expand = (itemId: number) => {
        const summary = paper(itemId)!.querySelector(
          ".llm-task-paper-summary",
        ) as HTMLElement;
        if (summary.getAttribute("aria-expanded") !== "true") summary.click();
        // Nothing is cited yet: every read is under "Read, not cited".
        const fold = paper(itemId)!.querySelector(
          ".llm-task-cited-fold .llm-task-fold",
        ) as HTMLElement | null;
        assert.isOk(fold, `the reads of ${itemId} fold`);
        if (fold!.getAttribute("aria-expanded") !== "true") fold!.click();
        const source = paper(itemId)!.querySelector(
          ".llm-task-cited-fold-body .llm-task-paper-open",
        ) as HTMLButtonElement | null;
        assert.isOk(source, `the passage of ${itemId} offers Source`);
        return {
          summary: () =>
            paper(itemId)!.querySelector(
              ".llm-task-paper-summary",
            ) as HTMLElement,
          source: source!,
        };
      };

      // 1. A MinerU-style snippet (heading, TeX, clipped): the reader opens
      // on the attachment and highlights the passage on its page.
      const first = expand(fixtures[0].parentItemId);
      assert.equal(first.source.textContent, "Source");
      first.source.click();
      await until(
        () => /^Jumped to the passage/.test(status()),
        () => `the passage is highlighted: status "${status()}"`,
        30000,
      );
      const reader = activeReader();
      assert.equal(
        reader?.itemID,
        fixtures[0].pdfAttachmentId,
        "the reader tab of that attachment is selected",
      );
      assert.equal(status(), "Jumped to the passage (page 2)");
      await until(
        () => readerPageIndex(reader) === 1,
        () => `the reader shows page 2 (${readerPageIndex(reader)})`,
      );
      assert.equal(
        first.summary().getAttribute("aria-expanded"),
        "true",
        "the paper stays expanded",
      );
      assert.equal(
        (root.querySelector("#llm-task-progress-drawer") as HTMLElement).dataset
          .state === "closed",
        false,
        "the drawer stays open",
      );
      await until(
        () =>
          !(
            paper(fixtures[0].parentItemId)!.querySelector(
              ".llm-task-paper-open",
            ) as HTMLButtonElement
          ).disabled,
        "the button is free again",
      );

      // 2. Text not in the PDF, page known: the reader opens on that page.
      const second = expand(fixtures[1].parentItemId);
      second.source.click();
      await until(
        () =>
          status() === "Couldn't find this passage in the PDF; opened page 2",
        () => `the page fallback reports: status "${status()}"`,
        30000,
      );
      const pageReader = activeReader();
      assert.equal(pageReader?.itemID, fixtures[1].pdfAttachmentId);
      await until(
        () => readerPageIndex(pageReader) === 1,
        () => `the fallback shows page 2 (${readerPageIndex(pageReader)})`,
      );

      // 3. No PDF: nothing opens, and the status line says why.
      const third = expand(noPdfItem.id);
      third.source.click();
      await until(
        () => status() === "No PDF for this paper",
        () => `a paper without a PDF says so: status "${status()}"`,
      );
      assert.equal(activeReader()?.itemID, fixtures[1].pdfAttachmentId);

      // 4. A whole-paper read: a heading line says "Full" over the paper's
      // reads, not among "Read, not cited", and Source opens the paper at its
      // first page without searching for the snippet.
      await handle.emit({
        type: "paper_ledger_update",
        callId: "overview-1",
        delta: {
          version: 1,
          callId: "overview-1",
          toolName: "paper_read",
          papers: [
            {
              key: key(fixtures[0].parentItemId),
              libraryID,
              itemId: fixtures[0].parentItemId,
              contextItemId: fixtures[0].pdfAttachmentId,
              title: TITLES[0],
              text: "pdf_text",
              state: "read",
            },
          ],
          reads: [
            {
              key: key(fixtures[0].parentItemId),
              callId: "overview-1",
              toolName: "paper_read",
              granularity: "full",
              method: "overview",
              // Not in the PDF's text: a search would fail, an open does not.
              snippet: "A body paragraph the PDF text layer does not hold.",
            },
          ],
        },
      } as never);
      const fullRead = (): HTMLElement | null =>
        paper(fixtures[0].parentItemId)?.querySelector(
          ".llm-task-reach",
        ) as HTMLElement | null;
      await until(() => {
        api.flushTaskProgress();
        return Boolean(fullRead());
      }, "the whole-paper read heads its paper");
      assert.equal(
        fullRead()!.querySelector(".llm-task-paper-how")?.textContent,
        "Full",
        "no chunk tally was recorded: Full alone",
      );
      assert.notInclude(
        paper(fixtures[0].parentItemId)!.textContent || "",
        "Full text",
      );
      assert.isNull(
        fullRead()!.closest(".llm-task-cited-fold"),
        "not under Read, not cited",
      );
      const foldOfPaper = paper(fixtures[0].parentItemId)!.querySelector(
        ".llm-task-cited-fold",
      );
      if (foldOfPaper)
        assert.isTrue(
          Boolean(
            fullRead()!.compareDocumentPosition(foldOfPaper) &
            win.Node.DOCUMENT_POSITION_FOLLOWING,
          ),
          "the heading comes before the folded reads",
        );
      assert.equal(
        fullRead()!.parentElement!.firstElementChild,
        fullRead(),
        "the first line of the paper's details",
      );
      const fullSource = fullRead()!.querySelector(
        ".llm-task-paper-open",
      ) as HTMLButtonElement;
      assert.isOk(fullSource, "the heading offers Source");
      fullSource.click();
      await until(
        () => status() === "Opened the paper",
        () => `the paper opens: status "${status()}"`,
        30000,
      );
      const fullReader = activeReader();
      assert.equal(fullReader?.itemID, fixtures[0].pdfAttachmentId);
      await until(
        () => readerPageIndex(fullReader) === 0,
        () => `the paper opens at page 1 (${readerPageIndex(fullReader)})`,
      );

      // 5. Quotes the answer cites: "Cited" lists each passage the answer
      // quotes as a card (without a number), with its own "Show in answer".
      // The quotes open from the answer's own cards (step 6).
      const cite = (quote: string) =>
        buildQuoteCitation({
          quoteText: quote,
          citationLabel: "(Spine, 2021)",
          sourceMatchText: quote,
          sourceMatchKind: "exact",
          sourceMatchSource: "context-text",
          itemId: fixtures[0].parentItemId,
          contextItemId: fixtures[0].pdfAttachmentId,
        })!;
      const quoteA = cite(SENTENCE);
      const quoteB = cite(SAME_PAGE_SENTENCE);
      await handle.emit({
        type: "final",
        text:
          `> ${SENTENCE}\n\n(Spine, 2021)\n\n[[quote:${quoteA.id}]] ` +
          `Drift follows turnover.\n\n> ${SAME_PAGE_SENTENCE}\n\n` +
          `(Spine, 2021)\n\n[[quote:${quoteB.id}]] It persists.`,
        quoteCitations: [quoteA, quoteB],
      } as never);
      const citedBlocks = () =>
        (
          Array.from(
            citedCard()?.querySelectorAll(
              ".llm-task-cited-item:not(.llm-task-cited-named)",
            ) || [],
          ) as HTMLElement[]
        ).filter((node) => !node.closest(".llm-task-cited-fold-body"));
      await until(() => {
        api.flushTaskProgress();
        return citedBlocks().length >= 2;
      }, "the answer's passages list under Cited");
      assert.isNull(paper(own), "cited: the paper leaves the list");
      assert.deepEqual(
        citedBlocks().map((block) => [
          block.querySelector(".llm-task-paper-snippet")?.textContent,
          Boolean(block.querySelector(".llm-task-cited-number")),
          Boolean(
            block.querySelector(".llm-task-cited-foot .llm-task-source-link"),
          ),
        ]),
        [
          [SENTENCE, false, true],
          [SAME_PAGE_SENTENCE, false, true],
        ],
        "each quoted passage, without a number, with Show in answer",
      );
      const statusLine = root.querySelector("#llm-status") as HTMLElement;
      assert.notEqual(
        (root.querySelector("#llm-task-progress-drawer") as HTMLElement).dataset
          .state,
        "closed",
        "the drawer stays open",
      );
      assert.equal(
        citedCard()!
          .querySelector(".llm-task-card-head")
          ?.getAttribute("aria-expanded"),
        "true",
        "the paper's card stays open",
      );

      // 6. The answer's own quote cards, one after the other on one page.
      const chip = (quote: string): HTMLElement | null =>
        (
          Array.from(
            root.querySelectorAll(".llm-citation-icon"),
          ) as HTMLElement[]
        ).find((node) => (node.title || "").startsWith(quote.slice(0, 30))) ||
        null;
      const openChip = async (quote: string, label: string) => {
        await until(() => Boolean(chip(quote)), `${label}: the card renders`);
        await until(
          () => chip(quote)!.dataset.loading !== "true",
          `${label}: the card is free`,
        );
        statusLine.textContent = "";
        const startedAt = Date.now();
        chip(quote)!.dispatchEvent(
          new win.MouseEvent("mousedown", { bubbles: true, button: 0 }),
        );
        await until(
          () => /^Jumped to cited source/.test(status()),
          () => `${label}: the quote is highlighted: status "${status()}"`,
          30000,
        );
        assert.match(status(), /paragraph matched/, label);
        assert.isBelow(Date.now() - startedAt, 5000, `${label}: no wait`);
      };
      await openChip(SENTENCE, "the first quote card");
      await openChip(
        SAME_PAGE_SENTENCE,
        "a second quote card on the same page",
      );
    } finally {
      handle.finish();
      restore();
      await closeReaders();
    }
  });

  // The library tab's sidebar panel is rebuilt when its tab is selected
  // again, and the reader tab's sidebar mounts its own panel on the same
  // Library chat: each new view takes the card up as the user left it.
  it("keeps the card open, with the paper expanded, across the reader tab and back", async function () {
    const rootOf = await openLibrarySidebarChat();
    const handle = await api.startTaskProgressReplay({
      surface: "embedded",
      historyTurns: 2,
      user: {
        selectedCollectionContexts: [
          { collectionId: collection.id, name: collection.name, libraryID },
        ],
      },
    });
    const conversation = String(handle.conversationKey);
    const key = (itemId: number) => `${libraryID}:${itemId}`;
    const paperOf = (root: HTMLElement | null) =>
      (root?.querySelector(
        `.llm-task-paper[data-item-id="${fixtures[0].parentItemId}"]`,
      ) || null) as HTMLElement | null;
    // The current question's fold of papers its answer did not use.
    const foldOf = (root: HTMLElement | null) =>
      (root?.querySelector(
        ".llm-task-progress-question-section .llm-task-fold-slot .llm-task-fold",
      ) || null) as HTMLElement | null;
    const stateOf = (root: HTMLElement | null) => {
      const drawer = root?.querySelector(
        "#llm-task-progress-drawer",
      ) as HTMLElement | null;
      const paper = paperOf(root);
      const details = paper?.querySelector(
        ".llm-task-paper-details",
      ) as HTMLElement | null;
      return {
        conversation: root?.dataset.itemId,
        kind: root?.dataset.conversationKind,
        drawer: drawer?.dataset.state,
        fold: foldOf(root)?.getAttribute("aria-expanded"),
        expanded: paper
          ?.querySelector(".llm-task-paper-summary")
          ?.getAttribute("aria-expanded"),
        details: Boolean(
          details &&
          !details.hidden &&
          details.querySelector(".llm-task-paper-open"),
        ),
      };
    };
    const asLeft = {
      conversation,
      kind: "global",
      drawer: "open",
      fold: "true",
      expanded: "true",
      details: true,
    };
    try {
      await handle.emit({
        type: "paper_ledger_update",
        callId: "retrieve-1",
        delta: {
          version: 1,
          callId: "retrieve-1",
          toolName: "library_retrieve",
          papers: fixtures.map((fixture, index) => ({
            key: key(fixture.parentItemId),
            libraryID,
            itemId: fixture.parentItemId,
            contextItemId: fixture.pdfAttachmentId,
            title: TITLES[index],
            text: "pdf_text" as const,
            state: "read" as const,
          })),
          reads: [
            {
              key: key(fixtures[0].parentItemId),
              callId: "retrieve-1",
              toolName: "library_retrieve",
              granularity: "section",
              method: "bm25",
              label: "Results",
              snippet: MINERU_SNIPPET,
            },
          ],
        },
      } as never);
    } finally {
      // The answer is done before the user opens the card.
      handle.finish();
    }
    try {
      const row = rootOf().querySelector("#llm-task-progress") as HTMLElement;
      await until(() => {
        api.flushTaskProgress();
        return !row.hidden;
      }, "the card shows in Library chat");
      row.click();
      // The paper was not used in the answer: it sits under a fold.
      await until(() => {
        api.flushTaskProgress();
        return Boolean(foldOf(rootOf()));
      }, "the unused papers sit under a fold");
      assert.isNull(paperOf(rootOf()), "the paper is folded");
      foldOf(rootOf())!.click();
      await until(() => Boolean(paperOf(rootOf())), "the paper lists");
      (
        paperOf(rootOf())!.querySelector(
          ".llm-task-paper-summary",
        ) as HTMLElement
      ).click();
      await until(
        () => JSON.stringify(stateOf(rootOf())) === JSON.stringify(asLeft),
        () => `the drawer opens: ${JSON.stringify(stateOf(rootOf()))}`,
      );

      // The answer cited none of its reads: they sit under "Read, not cited".
      (
        paperOf(rootOf())!.querySelector(
          ".llm-task-cited-fold .llm-task-fold",
        ) as HTMLElement
      ).click();
      (
        paperOf(rootOf())!.querySelector(
          ".llm-task-cited-fold-body .llm-task-paper-open",
        ) as HTMLElement
      ).click();
      await until(
        () => activeReader()?.itemID === fixtures[0].pdfAttachmentId,
        "the reader tab opens",
        30000,
      );
      const readerRoot = () =>
        activeDetails()?.querySelector("#llm-main") as HTMLElement | null;
      await until(
        () => JSON.stringify(stateOf(readerRoot())) === JSON.stringify(asLeft),
        () =>
          `the reader's sidebar shows the card as left: ${JSON.stringify(stateOf(readerRoot()))}`,
      );

      win.Zotero_Tabs.select("zotero-pane");
      await until(
        () =>
          win.Zotero_Tabs.selectedID === "zotero-pane" &&
          JSON.stringify(stateOf(rootOf())) === JSON.stringify(asLeft),
        () =>
          `back in the library tab, the card is as left: ${JSON.stringify(stateOf(rootOf()))}`,
      );
      // It stays so: nothing closes it a moment later.
      await Zotero.Promise.delay(600);
      assert.deepEqual(stateOf(rootOf()), asLeft);
    } finally {
      await closeReaders();
    }
  });
});
