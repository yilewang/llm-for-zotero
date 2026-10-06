import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";
import { collectReaderSelectionDocuments } from "../src/services/pdf/readerSelection";

/**
 * Library chat discovers its sources at runtime, so an answer's quotes there
 * are usually not bound to a paper: they render as fallback ("untrusted")
 * quote cards, and a click has to find the paper by its citation label and
 * verify the quote in its text before moving the reader. Inline citations
 * open the paper they name without a quote to search.
 *
 * Characterization gate for the citation-navigator refactor (step 8): these
 * pin what a user sees today on both paths.
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
});
