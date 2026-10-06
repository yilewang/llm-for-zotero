import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";
import { collectReaderSelectionDocuments } from "../src/services/pdf/readerSelection";
import { isMineruEnabled, setMineruEnabled } from "../src/utils/mineruConfig";
import {
  getMineruItemDir,
  invalidateMineruMd,
} from "../src/services/mineru/mineruCache";

const ocrQuote =
  "Gradual changes in both cells' acitivty rates and tuning over minutes-days.";
const searchableQuote =
  "Population activity remained stable across recording days despite changes in individual neurons.";
const inventedQuote =
  "Every neuron was replaced overnight and visual perception immediately vanished.";

describe("workflow: independently verify saved quote anchors", function () {
  this.timeout(120000);

  it("reloads searchable, OCR-only, and unsupported registered quotes with independent statuses", async function () {
    assert.isTrue(
      Zotero.DataDirectory.dir.endsWith("/zotero-dev") ||
        Zotero.DataDirectory.dir.endsWith("/.scaffold/test/data"),
    );
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    await api.reset();
    const mineruEnabled = isMineruEnabled();
    setMineruEnabled(true);
    const fixture = await api.createPaperWithPdfFixture({
      title: "Independent quote evidence fixture",
      pdfTitle: "Searchable body with separate OCR evidence",
      pages: [searchableQuote],
    });
    let reader: any;
    const diagnosticLog: string[] = [];
    const onDebug = (message: string) => {
      if (
        /quote-locator|quote validation|quote source|page text/i.test(message)
      )
        diagnosticLog.push(message);
    };
    Zotero.Debug.addListener(onDebug);
    try {
      const item = Zotero.Items.get(fixture.parentItemId);
      item.setCreators([
        { creatorType: "author", firstName: "Test", lastName: "Fixture" },
      ]);
      item.setField("date", "2024");
      await item.saveTx();
      // Persist an independent OCR extraction in the supported legacy cache
      // shape. The PDF text layer deliberately has no OCR caption.
      const root = getMineruItemDir(fixture.pdfAttachmentId);
      await IOUtils.makeDirectory(root, {
        createAncestors: true,
        ignoreExisting: true,
      });
      await IOUtils.write(
        PathUtils.join(root, "full.md"),
        new TextEncoder().encode(
          `# Graphical abstract\n\n${ocrQuote}\n\n# Results\n\n${searchableQuote}`,
        ),
      );
      const citations = [searchableQuote, ocrQuote, inventedQuote].map(
        (quoteText) =>
          buildQuoteCitation({
            quoteText,
            citationLabel: "(Fixture, 2024)",
            contextItemId: fixture.pdfAttachmentId,
            itemId: fixture.parentItemId,
            sourceMatchText: quoteText,
            sourceMatchKind: "exact",
            sourceMatchSource: "context-text",
          })!,
      );
      const markdown = citations
        .map((citation) => `[[quote:${citation.id}]]`)
        .join("\n\n");
      const context = {
        itemId: fixture.parentItemId,
        contextItemId: fixture.pdfAttachmentId,
        title: "Independent quote evidence fixture",
        firstCreator: "Fixture",
        year: "2024",
        contentSourceMode: "mineru" as const,
      };
      reader = await Zotero.Reader.open(fixture.pdfAttachmentId);
      await reader._initPromise;
      await reader._waitForReader();
      const pageReady = () =>
        collectReaderSelectionDocuments(reader).some((doc) =>
          doc
            .querySelector('.page[data-page-number="1"] .textLayer')
            ?.textContent?.includes("Population activity"),
        );
      const pageDeadline = Date.now() + 15000;
      while (!pageReady() && Date.now() < pageDeadline)
        await Zotero.Promise.delay(25);
      assert.isTrue(
        pageReady(),
        "native source page is ready before restoring chat",
      );
      await api.openStandaloneForItem(item.id);
      await api.seedStandaloneConversation([
        {
          role: "user",
          text: "Explain the source evidence.",
          paperContexts: [context],
          fullTextPaperContexts: [context],
        },
        { role: "assistant", text: markdown, quoteCitations: citations },
      ]);
      const conversationKey = (await api.getStandaloneDiagnostics())
        .conversationKey!;
      // The harness seeds only plain turns. Restore the historical metadata
      // through the native store before testing a fresh reload.
      await Zotero.DB.queryAsync(
        "UPDATE llm_for_zotero_chat_messages SET paper_contexts_json = ?, full_text_paper_contexts_json = ? WHERE conversation_key = ? AND role = 'user'",
        [JSON.stringify([context]), JSON.stringify([context]), conversationKey],
      );
      await Zotero.DB.queryAsync(
        "UPDATE llm_for_zotero_chat_messages SET quote_citations_json = ? WHERE conversation_key = ? AND role = 'assistant'",
        [JSON.stringify(citations), conversationKey],
      );
      const readStored = async () =>
        (await Zotero.DB.queryAsync(
          "SELECT text, quote_citations_json FROM llm_for_zotero_chat_messages WHERE conversation_key = ? AND role = 'assistant' ORDER BY id",
          [conversationKey],
        ))!.map((row) => ({
          text: row.text,
          quoteCitations: row.quote_citations_json,
        }));
      const stored = JSON.stringify(await readStored());
      for (let reload = 0; reload < 2; reload += 1) {
        await api.reset();
        await api.openStandaloneForItem(item.id);
        const win = (Zotero as any).LLMForZotero.data
          .standaloneWindow as Window;
        const readCards = () =>
          Array.from(
            win.document.querySelectorAll<HTMLElement>(".llm-quote-card"),
          ) as HTMLElement[];
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const cards = readCards();
          if (
            cards.length === 3 &&
            cards[0].dataset.quoteStatus === "verified" &&
            cards[2].dataset.quoteStatus === "not-source"
          )
            break;
          await Zotero.Promise.delay(50);
        }
        const cards = readCards();
        assert.lengthOf(cards, 3, "all stored quote occurrences stay visible");
        assert.deepEqual(
          cards.map((card) => card.dataset.quoteStatus),
          ["verified", "unresolved", "not-source"],
          diagnosticLog.join("\n") +
            cards.map((card) => card.outerHTML).join("\n"),
        );
        assert.include(cards[1].textContent || "", ocrQuote);
        assert.equal(
          JSON.stringify(await readStored()),
          stored,
          "revalidation leaves historical text and citation metadata intact",
        );
        const navigation = await api.observeCitationNavigationFocus(
          cards[0].querySelector<HTMLElement>(".llm-citation-icon")!,
        );
        assert.isTrue(navigation.finished, JSON.stringify(navigation));
      }
    } finally {
      Zotero.Debug.removeListener(onDebug);
      await reader?.close();
      await api.reset();
      await invalidateMineruMd(fixture.pdfAttachmentId);
      await api.cleanupFixture(fixture);
      setMineruEnabled(mineruEnabled);
    }
  });
});
