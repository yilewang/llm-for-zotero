import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { collectReaderSelectionDocuments } from "../src/services/pdf/readerSelection";
import {
  SUMMERFIELD_QUOTE,
  SUMMERFIELD_SOURCE_PREFIX,
  SUMMERFIELD_SIMILARITY_QUOTE,
} from "../test/fixtures/quoteAcceptance";
import { buildFragmentedQuotePdf } from "../test/fixtures/fragmentedQuotePdf";

describe("workflow: quote acceptance from unique passage evidence", function () {
  this.timeout(120000);

  for (const scenario of [
    {
      name: "statistical quote",
      prose:
        "Reward-related pattern similarity increased reliably across the adolescent participants",
      quote:
        "Reward-related pattern similarity increased reliably across the adolescent participants (F₂,₆₈ = 4.72; p = 0.012; N = 89)",
      source:
        "Reward-related pattern similarity increased reliably across the adolescent participants (F(268) = 4.72; p = 0.012; N = 89).",
    },
    {
      name: "quote with fragmented words and closing delimiters",
      prose: "Neurons that signal",
      quote: SUMMERFIELD_SIMILARITY_QUOTE.replaceAll("→", "->"),
      source: SUMMERFIELD_SIMILARITY_QUOTE.replaceAll("→", "->"),
      highlightTail: "{x ->z}.",
      fragmented: true,
      followingQuote:
        "A second complete quotation should navigate to its own page after the first search.",
    },
    {
      name: "quote containing a mid-sentence citation marker",
      prose: "the gradual rotation",
      quote: SUMMERFIELD_QUOTE,
      highlightTail: "positional code.",
      source:
        SUMMERFIELD_SOURCE_PREFIX +
        SUMMERFIELD_QUOTE.replace("computation and", "computation137 and"),
    },
  ]) {
    it(`revalidates a stored ${scenario.name} and navigates its native PDF anchor`, async function () {
      assert.isTrue(
        Zotero.DataDirectory.dir.endsWith("/zotero-dev") ||
          Zotero.DataDirectory.dir.endsWith("/.scaffold/test/data"),
      );
      const api = (Zotero as any).LLMForZotero.api
        .workflowTest as WorkflowTestApi;
      await api.reset();
      const { prose, quote, source } = scenario;
      const markdown = [quote, scenario.followingQuote]
        .filter(Boolean)
        .map((text) => `> ${text}\n\n(Fixture, 2024)`)
        .join("\n\n");
      const fixture = await api.createPaperWithPdfFixture({
        title: "Quote acceptance fixture",
        pdfTitle: "Statistical source",
        pages: [source],
      });
      if (scenario.fragmented) {
        const attachment = Zotero.Items.get(fixture.pdfAttachmentId);
        const path = await attachment.getFilePathAsync();
        assert.isString(path);
        await IOUtils.write(
          path as string,
          await buildFragmentedQuotePdf([source, scenario.followingQuote!]),
        );
      }
      const diagnosticLog: string[] = [];
      const onDebug = (message: string) => {
        if (/quote-locator|quote validation|quote source/i.test(message))
          diagnosticLog.push(message);
      };
      Zotero.Debug.addListener(onDebug);
      let reader: any;
      try {
        const item = Zotero.Items.get(fixture.parentItemId);
        item.setCreators([
          { creatorType: "author", firstName: "Test", lastName: "Fixture" },
        ]);
        item.setField("date", "2024");
        await item.saveTx();
        reader = await Zotero.Reader.open(fixture.pdfAttachmentId);
        await reader._initPromise;
        await reader._waitForReader();
        const pageReady = () =>
          collectReaderSelectionDocuments(reader).some((doc) =>
            doc
              .querySelector('.page[data-page-number="1"] .textLayer')
              ?.textContent?.includes(prose.slice(0, 10)),
          );
        const pageDeadline = Date.now() + 15000;
        while (!pageReady() && Date.now() < pageDeadline)
          await Zotero.Promise.delay(25);
        assert.isTrue(
          pageReady(),
          "native PDF page is loaded before reopening chat",
        );
        if (scenario.fragmented) {
          const items = collectReaderSelectionDocuments(reader).flatMap((doc) =>
            Array.from(
              doc.querySelectorAll(".textLayer span"),
              (node) => node!.textContent,
            ),
          );
          assert.include(
            items,
            "}",
            "the native fixture splits the closing brace into its own text item",
          );
          assert.include(
            items,
            ".",
            "the period is a separate native text item",
          );
        }
        await api.openStandaloneForItem(item.id);
        const context = {
          itemId: item.id,
          contextItemId: fixture.pdfAttachmentId,
          title: "Quote acceptance fixture",
          firstCreator: "Fixture",
          year: "2024",
        };
        await api.seedStandaloneConversation([
          { role: "user", text: "Explain the reported interaction." },
          { role: "assistant", text: markdown },
        ]);
        const conversationKey = (await api.getStandaloneDiagnostics())
          .conversationKey!;
        // The seed helper stores plain turns. Restore the durable paper context
        // of a historical user turn directly in the native fixture database.
        await Zotero.DB.queryAsync(
          "UPDATE llm_for_zotero_chat_messages SET paper_contexts_json = ?, full_text_paper_contexts_json = ? WHERE conversation_key = ? AND role = 'user'",
          [
            JSON.stringify([context]),
            JSON.stringify([context]),
            conversationKey,
          ],
        );
        const readStoredText = async () =>
          Zotero.DB.columnQueryAsync<string>(
            "SELECT text FROM llm_for_zotero_chat_messages WHERE conversation_key = ? AND role = 'assistant' ORDER BY id",
            [conversationKey],
          );
        assert.deepEqual(await readStoredText(), [markdown]);

        // Clear the runtime history and reload the actual persisted answer.
        await api.reset();
        await api.openStandaloneForItem(item.id);
        const win = (Zotero as any).LLMForZotero.data
          .standaloneWindow as Window;
        let card: HTMLElement | null = null;
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const cards = Array.from(
            win.document.querySelectorAll<HTMLElement>(".llm-quote-card"),
          ) as HTMLElement[];
          if (
            cards.length === (scenario.followingQuote ? 2 : 1) &&
            cards.every((node) => node.dataset.quoteStatus === "verified")
          ) {
            card = cards[0];
            break;
          }
          await Zotero.Promise.delay(50);
        }
        assert.isOk(
          card,
          `stored quote should become verified; visibility=${win.document.visibilityState}; readers=${Zotero.Reader._readers.map((reader: any) => reader.itemID)}; ${diagnosticLog.join("\n")}; ${Array.from(win.document.querySelectorAll(".llm-quote-card"), (node) => (node as Element).outerHTML).join("\n")}`,
        );
        assert.lengthOf(
          win.document.querySelectorAll(".llm-quote-card"),
          scenario.followingQuote ? 2 : 1,
        );
        assert.include(card!.textContent || "", prose);
        const button = card!.querySelector<HTMLElement>(".llm-citation-icon")!;
        assert.isOk(button, "verified quote has a source-navigation control");
        const navigation = await api.observeCitationNavigationFocus(button);
        assert.isTrue(navigation.started);
        assert.isTrue(navigation.finished, JSON.stringify(navigation));
        assert.equal(reader.itemID, fixture.pdfAttachmentId);
        const documents = collectReaderSelectionDocuments(reader);
        assert.isTrue(
          documents.some((doc) =>
            doc
              .querySelector('.page[data-page-number="1"] .textLayer')
              ?.textContent?.includes(prose.slice(0, 10)),
          ),
          "the opened native PDF contains the expected passage",
        );
        assert.isTrue(
          documents.some(
            (doc) =>
              doc.querySelector(".highlight.selected, .highlight") !== null,
          ),
          "native PDF search independently highlights the located source",
        );
        if (scenario.highlightTail) {
          const highlighted = documents
            .flatMap((doc) =>
              Array.from(
                doc.querySelectorAll(".highlight"),
                (node) => node!.textContent || "",
              ),
            )
            .join("")
            .replace(/\s+/g, "");
          assert.include(highlighted, prose.replace(/\s+/g, ""));
          assert.include(
            highlighted,
            scenario.highlightTail.replace(/\s+/g, ""),
            "the highlight covers the complete quote beyond the reference marker",
          );
        }
        if (scenario.followingQuote) {
          win.focus();
          const followingCard =
            win.document.querySelectorAll<HTMLElement>(".llm-quote-card")[1];
          followingCard.scrollIntoView();
          const followingNavigation = await api.observeCitationNavigationFocus(
            followingCard.querySelector<HTMLElement>(".llm-citation-icon")!,
          );
          assert.isTrue(followingNavigation.started);
          assert.isTrue(
            followingNavigation.finished,
            JSON.stringify(followingNavigation),
          );
          const matchLog = followingNavigation.diagnostics.find((message) =>
            message.startsWith("LLM citation FindController exact match {"),
          );
          assert.isString(matchLog, JSON.stringify(followingNavigation));
          assert.equal(
            JSON.parse(matchLog!.slice(matchLog!.indexOf("{"))).pageIndex,
            1,
            "completion belongs to the new quote, not the previous page's search",
          );
          const highlightedFollowingQuote = () =>
            collectReaderSelectionDocuments(reader)
              .flatMap((doc) =>
                Array.from(
                  doc.querySelectorAll(
                    '.page[data-page-number="2"] .highlight',
                  ),
                  (node) => node!.textContent || "",
                ),
              )
              .join("")
              .replace(/\s+/g, "");
          const expected = scenario.followingQuote.replace(/\s+/g, "");
          const highlightDeadline = Date.now() + 5000;
          while (
            !highlightedFollowingQuote().includes(expected) &&
            Date.now() < highlightDeadline
          )
            await Zotero.Promise.delay(25);
          assert.include(
            highlightedFollowingQuote(),
            expected,
            "the next quote highlights its complete wording on its own page",
          );
        }
        assert.deepEqual(
          await readStoredText(),
          [markdown],
          "display revalidation preserves the stored answer",
        );
      } finally {
        Zotero.Debug.removeListener(onDebug);
        await reader?.close();
        await api.reset();
        await api.cleanupFixture(fixture);
      }
    });
  }
});
