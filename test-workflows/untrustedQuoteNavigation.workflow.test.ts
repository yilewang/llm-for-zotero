import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";
import { collectReaderSelectionDocuments } from "../src/services/pdf/readerSelection";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";

/**
 * Library chat discovers its sources at runtime, so an answer's quotes there
 * are usually not bound to a paper: they render as fallback ("untrusted")
 * quote cards, and a click has to find the paper by its citation label and
 * verify the quote in its text before moving the reader. Inline citations
 * open the paper they name without a quote to search.
 *
 * Characterization gate for the citation-navigator refactor (step 8): these
 * pin what a user sees today on both paths. Since U1, a quote card the
 * answer bound to its paper ("trusted") is also verified before any reader
 * opens or moves; the last two cases pin that.
 */

const SOURCE_QUOTE =
  "Hippocampal place fields drifted steadily across weeks while the decoded position of the animal stayed accurate";
const SOURCE_PAGES = [
  "Introduction. We recorded hippocampal populations in freely moving mice over many weeks.",
  `Results. ${SOURCE_QUOTE}. The drift was orthogonal to the coding axis.`,
];
const DECOY_PAGES = [
  "A second paper by the same author about cortical oscillations during sleep.",
];
/** A quote the answer attributes to the source paper, which never says it. */
const ABSENT_QUOTE =
  "Grid cell modules realigned to the new enclosure geometry within minutes of the first exposure session";

function getApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

async function until(
  condition: () => boolean,
  message: string,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await Zotero.Promise.delay(50);
  assert.isTrue(condition(), message);
}

async function setCitationMetadata(
  fixture: WorkflowTestFixture,
): Promise<void> {
  const item = Zotero.Items.get(fixture.parentItemId);
  item.setCreators([
    { creatorType: "author", firstName: "Test", lastName: "Fixture" },
  ]);
  item.setField("date", "2024");
  await item.saveTx();
}

function readersFor(attachmentId: number): any[] {
  return (Zotero.Reader._readers as any[]).filter(
    (reader) => reader?.itemID === attachmentId,
  );
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

describe("workflow: library chat citation navigation", function () {
  this.timeout(120000);

  let api: WorkflowTestApi;
  const fixtures: WorkflowTestFixture[] = [];

  beforeEach(async function () {
    assert.isTrue(
      Zotero.DataDirectory.dir.endsWith("/zotero-dev") ||
        Zotero.DataDirectory.dir.endsWith("/.scaffold/test/data"),
    );
    api = getApi();
    await api.reset();
  });

  afterEach(async function () {
    for (const fixture of fixtures) {
      for (const reader of readersFor(fixture.pdfAttachmentId)) {
        await reader.close?.();
      }
    }
    await api.closeStandalone();
    while (fixtures.length) {
      const fixture = fixtures.pop();
      if (fixture) await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  async function openLibraryChat(itemId: number): Promise<Window> {
    await api.openStandaloneForItem(itemId);
    await api.clickStandaloneTab("open");
    const win = (Zotero as any).LLMForZotero.data.standaloneWindow as Window;
    await until(
      () =>
        (
          win.document.querySelector(
            ".llm-standalone-content #llm-main",
          ) as HTMLElement | null
        )?.dataset.conversationKind === "global",
      "the standalone window shows library chat",
    );
    return win;
  }

  function statusText(win: Window): string {
    return (
      win.document.querySelector(".llm-standalone-content #llm-status")
        ?.textContent || ""
    );
  }

  it("verifies a fallback quote card's paper by its label and opens only that paper", async function () {
    // Created first, so the label search reads it first: same author and
    // year, but it does not hold the quote.
    const decoy = await api.createPaperWithPdfFixture({
      title: "Fixture decoy paper",
      pages: DECOY_PAGES,
    });
    fixtures.push(decoy);
    const source = await api.createPaperWithPdfFixture({
      title: "Fixture source paper",
      pages: SOURCE_PAGES,
    });
    fixtures.push(source);
    await setCitationMetadata(decoy);
    await setCitationMetadata(source);
    assert.lengthOf(readersFor(source.pdfAttachmentId), 0);
    assert.lengthOf(readersFor(decoy.pdfAttachmentId), 0);

    const win = await openLibraryChat(source.parentItemId);
    // No paper is attached to the turn: the answer names its source only by
    // its citation label, as a library-chat answer does.
    await api.seedStandaloneConversation([
      { role: "user", text: "What happens to place fields over weeks?" },
      {
        role: "assistant",
        text: `The source reports:\n\n> ${SOURCE_QUOTE}\n\n(Fixture, 2024)`,
      },
    ]);

    const findButton = () =>
      win.document.querySelector<HTMLElement>(
        ".llm-quote-card .llm-citation-icon",
      );
    await until(
      () => Boolean(findButton()),
      "the quote renders as a quote card with a source control",
    );
    const card = findButton()!.closest<HTMLElement>(".llm-quote-card")!;
    assert.equal(card.dataset.quoteStatus, "unresolved");
    assert.equal(
      findButton()!.dataset.citationNavigationMode,
      "untrusted-quote",
      "an unbound quote takes the untrusted path",
    );

    const navigation = await api.observeCitationNavigationFocus(findButton()!);

    assert.isTrue(navigation.started);
    assert.isTrue(navigation.finished, JSON.stringify(navigation));
    assert.lengthOf(
      readersFor(decoy.pdfAttachmentId),
      0,
      "a candidate that fails verification is never opened",
    );
    const readers = readersFor(source.pdfAttachmentId);
    assert.lengthOf(readers, 1, "the verified paper opens");
    assert.equal(
      statusText(win),
      "Jumped to cited source (page 2, paragraph matched)",
      JSON.stringify(navigation.diagnostics),
    );
    const highlighted = () =>
      collectReaderSelectionDocuments(readers[0])
        .flatMap((doc) =>
          Array.from(
            doc.querySelectorAll('.page[data-page-number="2"] .highlight'),
            (node) => node!.textContent || "",
          ),
        )
        .join("")
        .replace(/\s+/g, "");
    await until(
      () => highlighted().includes(SOURCE_QUOTE.replace(/\s+/g, "")),
      "the quote is highlighted on its own page",
      10000,
    );
  });

  it("opens the paper an inline citation names", async function () {
    const source = await api.createPaperWithPdfFixture({
      title: "Fixture source paper",
      pages: SOURCE_PAGES,
    });
    fixtures.push(source);
    await setCitationMetadata(source);
    assert.lengthOf(readersFor(source.pdfAttachmentId), 0);

    const win = await openLibraryChat(source.parentItemId);
    const context = {
      itemId: source.parentItemId,
      contextItemId: source.pdfAttachmentId,
      title: "Fixture source paper",
      firstCreator: "Fixture",
      year: "2024",
    };
    // An inline citation becomes a control only when the turn carries the
    // paper it names, e.g. a paper the user added to the library chat.
    await api.seedStandaloneConversation([
      {
        role: "user",
        text: "Summarize this paper.",
        paperContexts: [context],
      },
      {
        role: "assistant",
        text: "Place fields drift over weeks while decoding stays accurate (Fixture, 2024), which constrains readout models.",
      },
    ]);

    const findButton = () =>
      win.document.querySelector<HTMLElement>(".llm-citation-icon-inline");
    await until(
      () => Boolean(findButton()),
      "the inline citation renders a source control",
    );
    assert.equal(
      findButton()!.dataset.citationNavigationMode,
      "inline-citation",
    );

    const navigation = await api.observeCitationNavigationFocus(findButton()!);

    assert.isTrue(navigation.started);
    assert.isTrue(navigation.finished, JSON.stringify(navigation));
    assert.lengthOf(readersFor(source.pdfAttachmentId), 1, "the paper opens");
    assert.equal(
      statusText(win),
      "Opened cited paper. Paragraph jump skipped: no quote text was available.",
    );
    assert.isAtLeast(navigation.focusRequests, 1, "Zotero is raised");
  });

  /**
   * A quote card the answer bound to the source paper, for a quote that paper
   * does not hold, with a stored page hint pointing at page 2.
   */
  async function renderTrustedAbsentQuoteCard(
    source: WorkflowTestFixture,
  ): Promise<{ win: Window; button: HTMLElement }> {
    const win = await openLibraryChat(source.parentItemId);
    const citation = buildQuoteCitation({
      quoteText: ABSENT_QUOTE,
      citationLabel: "(Fixture, 2024)",
      sourceMatchText: ABSENT_QUOTE,
      sourceMatchKind: "exact",
      sourceMatchSource: "context-text",
      itemId: source.parentItemId,
      contextItemId: source.pdfAttachmentId,
      pageHintIndex: 1,
      pageHintLabel: "2",
    });
    assert.isOk(citation, "the quote citation is well formed");
    await api.seedStandaloneConversation([
      { role: "user", text: "What happens to grid cells in a new room?" },
      {
        role: "assistant",
        text: `The source reports:\n\n> ${ABSENT_QUOTE}\n\n(Fixture, 2024)`,
        quoteCitations: [citation!],
      },
    ]);
    const findButton = () =>
      win.document.querySelector<HTMLElement>(
        ".llm-quote-card .llm-citation-icon",
      );
    await until(
      () => Boolean(findButton()),
      "the bound quote renders as a quote card with a source control",
    );
    assert.equal(
      findButton()!.dataset.citationNavigationMode,
      "trusted-quote",
      "a quote bound to its paper takes the trusted path",
    );
    return { win, button: findButton()! };
  }

  it("opens no reader for a trusted quote card whose paper does not hold the quote", async function () {
    const source = await api.createPaperWithPdfFixture({
      title: "Fixture source paper",
      pages: SOURCE_PAGES,
    });
    fixtures.push(source);
    await setCitationMetadata(source);
    assert.lengthOf(readersFor(source.pdfAttachmentId), 0);
    const { win, button } = await renderTrustedAbsentQuoteCard(source);

    const readerApi = Zotero.Reader as any;
    const open = readerApi.open;
    const opens: unknown[][] = [];
    readerApi.open = (...args: unknown[]) => {
      opens.push(args);
      return open.apply(readerApi, args);
    };
    let navigation: Awaited<
      ReturnType<WorkflowTestApi["observeCitationNavigationFocus"]>
    >;
    try {
      navigation = await api.observeCitationNavigationFocus(button);
    } finally {
      readerApi.open = open;
    }

    assert.isTrue(navigation.started);
    assert.isTrue(navigation.finished, JSON.stringify(navigation));
    assert.deepEqual(
      opens,
      [],
      "neither the page hint nor a search opens the paper before the quote is verified",
    );
    assert.lengthOf(readersFor(source.pdfAttachmentId), 0);
    assert.equal(
      statusText(win),
      "The complete quote was not found in the live PDF text.",
      JSON.stringify(navigation.diagnostics),
    );
  });

  it("does not move an open reader to a trusted quote card's page hint before verifying it", async function () {
    const source = await api.createPaperWithPdfFixture({
      title: "Fixture source paper",
      pages: SOURCE_PAGES,
    });
    fixtures.push(source);
    await setCitationMetadata(source);
    const reader = await Zotero.Reader.open(source.pdfAttachmentId);
    await (reader as any)._initPromise;
    await (reader as any)._waitForReader();
    await until(
      () => readerPageIndex(reader) === 0,
      "the open reader shows page 1",
    );
    const { win, button } = await renderTrustedAbsentQuoteCard(source);

    const target = reader as any;
    const navigate = target.navigate;
    const navigations: unknown[] = [];
    target.navigate = (...args: unknown[]) => {
      navigations.push(args[0]);
      return navigate.apply(target, args);
    };
    let navigation: Awaited<
      ReturnType<WorkflowTestApi["observeCitationNavigationFocus"]>
    >;
    try {
      navigation = await api.observeCitationNavigationFocus(button);
    } finally {
      delete target.navigate;
      if (target.navigate !== navigate) target.navigate = navigate;
    }

    assert.isTrue(navigation.started);
    assert.isTrue(navigation.finished, JSON.stringify(navigation));
    assert.deepEqual(
      navigations,
      [],
      "the reader is not sent to the hinted page before the quote is verified",
    );
    assert.equal(readerPageIndex(reader), 0, "the reader stays on page 1");
    assert.lengthOf(readersFor(source.pdfAttachmentId), 1);
    assert.equal(
      statusText(win),
      "The complete quote was not found in the live PDF text.",
      JSON.stringify(navigation.diagnostics),
    );
  });
});
