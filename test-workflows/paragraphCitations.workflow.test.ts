import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { preparePaperPromptContext } from "../src/agent/context/paperPromptContext";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { renderAssistantRichText } from "../src/modules/contextPanel/assistantRichText";
import { collectReaderSelectionDocuments } from "../src/services/pdf/readerSelection";
import { waitForAssistantQuoteValidationForTests } from "../src/modules/contextPanel/quoteValidation/scheduling";
import { createSourcePopover } from "../src/modules/contextPanel/sourcePopover";

describe("workflow: paragraph source footers", function () {
  this.timeout(120000);

  it("reads full native PDFs, groups sources, reopens stored evidence and jumps to its passage", async function () {
    assert.isTrue(Zotero.DataDirectory.dir.endsWith("/.scaffold/test/data"));
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    await api.reset();
    const methods =
      "The methods measured neural activity across twelve recording sessions in five animals.";
    const results =
      "The results show stable population decoding despite changes in individual neural responses.";
    const fixture = await api.createPaperWithPdfFixture({
      title: "Paragraph evidence fixture",
      pages: [methods, results],
    });
    const second = await api.createPaperWithPdfFixture({
      title: "Replication fixture",
      pages: [
        "The replication found the same population effect in a second independent cohort of animals.",
      ],
    });
    let reader: any;
    try {
      const item = Zotero.Items.get(fixture.parentItemId);
      const refs = [fixture, second].map((entry, index) => ({
        libraryID: item.libraryID,
        itemId: entry.parentItemId,
        contextItemId: entry.pdfAttachmentId,
        title: index ? "Replication" : item.getField("title"),
        firstCreator: index ? "Lee" : "Kim",
        year: "2026",
      }));
      const request = resolveAgentRuntimeRequest({
        conversationKey: item.id,
        mode: "agent",
        userText: "Explain these papers",
        libraryID: item.libraryID,
        activePaperContext: refs[0],
        selectedPaperContexts: [refs[1]],
        conversationKind: "paper",
      });
      const context = await preparePaperPromptContext(request, {
        tokenBudget: 10000,
      });
      assert.lengthOf(context.blocks, 2);
      assert.include(context.blocks[0], methods);
      assert.include(context.blocks[0], results);
      const firstCitation = context.quoteCitations.find(
        (citation) => citation.contextItemId === fixture.pdfAttachmentId,
      )!;
      const secondCitation = context.quoteCitations.find(
        (citation) => citation.contextItemId === second.pdfAttachmentId,
      )!;
      assert.isOk(firstCitation);
      assert.isOk(secondCitation);
      const text = `The longitudinal study measured neural activity over repeated sessions [[cite:${firstCitation.id}]], and an independent replication supports the population result. [[cite:${secondCitation.id},${firstCitation.id}]]\n\nFor the recording protocol, read this passage:\n\n[[quote:${firstCitation.id}]]`;
      await api.openStandaloneForItem(item.id);
      const seeded = await api.seedStandaloneConversation([
        { role: "user", text: "Explain the experimental evidence" },
        { role: "assistant", text },
      ]);
      await Zotero.DB.queryAsync(
        "UPDATE llm_for_zotero_chat_messages SET quote_citations_json = ? WHERE conversation_key = ? AND role = 'assistant'",
        [JSON.stringify(context.quoteCitations), seeded.conversationKey!],
      );
      await api.reset();
      await api.openStandaloneForItem(item.id);
      const win = (Zotero as any).LLMForZotero.data.standaloneWindow as Window;
      const doc = win.document;
      let chip: HTMLElement | null = null;
      const deadline = Date.now() + 15000;
      while (!chip && Date.now() < deadline) {
        chip = doc.querySelector<HTMLElement>(
          ".llm-paper-source-indicator .llm-web-source-chip",
        );
        if (!chip) await Zotero.Promise.delay(50);
      }
      assert.isOk(
        chip,
        "stored paragraph citation reopens as a compact footer",
      );
      await waitForAssistantQuoteValidationForTests(seeded.conversationKey!);
      // Quote validation schedules a separate conversation repaint.
      await Zotero.Promise.delay(250);
      chip = doc.querySelector<HTMLElement>(
        ".llm-paper-source-indicator .llm-web-source-chip",
      );
      assert.isOk(chip, "the footer survives background quote validation");
      const indicator = chip!.closest(".llm-paper-source-indicator")!;
      indicator.dispatchEvent(new (win as any).MouseEvent("mouseenter"));
      assert.equal(
        chip!.getAttribute("aria-expanded"),
        "false",
        "hover alone must not open the quote container",
      );
      chip!.focus();
      assert.equal(
        chip!.getAttribute("aria-expanded"),
        "false",
        "keyboard focus alone must not open the quote container",
      );
      const footerIcon = chip!.querySelector<HTMLElement>(
        ".llm-paper-source-icon",
      )!;
      const iconStyle = win.getComputedStyle(footerIcon)!;
      const chipStyle = win.getComputedStyle(chip!)!;
      assert.include(iconStyle.maskImage, "action-text-context.svg");
      assert.notEqual(iconStyle.backgroundColor, "rgba(0, 0, 0, 0)");
      assert.isAbove(Number.parseFloat(chipStyle.borderTopWidth), 0);
      assert.equal(
        chip!.querySelector(".llm-paper-source-count")?.textContent,
        "2 Quotes",
      );
      const paragraph = chip!.closest("p") as HTMLElement;
      const originalFontSize = paragraph.style.fontSize;
      for (const fontSize of ["11px", "16px", "22px"]) {
        paragraph.style.fontSize = fontSize;
        assert.isAtMost(
          chip!.getBoundingClientRect().height,
          Number.parseFloat(win.getComputedStyle(paragraph)!.fontSize),
          "the whole chip including its border fits within the paragraph text size",
        );
        assert.isBelow(
          Number.parseFloat(
            win.getComputedStyle(
              chip!.querySelector(".llm-paper-source-count")!,
            )!.fontSize,
          ),
          Number.parseFloat(fontSize),
          "the label leaves room for the wrapping inside the text-sized chip",
        );
      }
      paragraph.style.fontSize = originalFontSize;
      assert.lengthOf(
        doc.querySelectorAll(".llm-paper-source-indicator"),
        1,
        "citations throughout one paragraph coalesce into a single footer",
      );
      assert.equal(
        chip!.closest(".llm-paper-source-indicator"),
        chip!.closest("p")?.lastElementChild,
        "the footer follows the entire paragraph",
      );
      assert.lengthOf(
        doc.querySelectorAll(".llm-quote-card"),
        1,
        "only the reading recommendation is a visible quote card",
      );
      await new Promise<void>((resolve) =>
        win.requestAnimationFrame(() =>
          win.requestAnimationFrame(() => resolve()),
        ),
      );
      await api.captureStandaloneScreenshot(
        `${Zotero.DataDirectory.dir}/paragraph-source-footer-collapsed.png`,
      );
      chip!.click();
      assert.equal(chip!.getAttribute("aria-expanded"), "true");
      indicator.dispatchEvent(new (win as any).MouseEvent("mouseleave"));
      await Zotero.Promise.delay(150);
      assert.equal(chip!.getAttribute("aria-expanded"), "true");
      chip!.click();
      assert.isNull(doc.querySelector(".llm-paper-source-popover"));
      chip!.click();
      chip!.dispatchEvent(
        new (win as any).KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
      assert.equal(chip!.getAttribute("aria-expanded"), "false");
      assert.equal(doc.activeElement, chip);
      chip!.click();
      doc.documentElement.dispatchEvent(
        new (win as any).MouseEvent("mousedown", { bubbles: true }),
      );
      assert.equal(chip!.getAttribute("aria-expanded"), "false");
      chip!.dispatchEvent(
        new (win as any).KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      );
      assert.equal(chip!.getAttribute("aria-expanded"), "true");
      assert.isTrue(
        doc
          .querySelector(".llm-paper-source-popover")!
          .contains(doc.activeElement),
        "explicit keyboard activation moves focus into the quote container",
      );
      chip!.click();
      assert.equal(chip!.getAttribute("aria-expanded"), "false");
      chip!.click();
      const popover = doc.querySelector<HTMLElement>(
        ".llm-paper-source-popover",
      )!;
      assert.isOk(popover);
      assert.equal(
        popover.querySelector(".llm-paper-source-title")?.textContent,
        "Supporting passages",
      );
      assert.lengthOf(popover.querySelectorAll(".llm-paper-source-passage"), 2);
      assert.include(popover.textContent || "", methods);
      assert.isAbove(
        Number.parseFloat(
          win.getComputedStyle(popover.querySelector(".llm-quote-card-body")!)!
            .borderLeftWidth,
        ),
        0,
        "the passage rule remains visible in the standalone popover",
      );
      await new Promise<void>((resolve) =>
        win.requestAnimationFrame(() =>
          win.requestAnimationFrame(() => resolve()),
        ),
      );
      await api.captureStandaloneScreenshot(
        `${Zotero.DataDirectory.dir}/paragraph-source-footer.png`,
      );
      assert.isTrue(chip!.isConnected);
      assert.isTrue(popover.isConnected, "the open footer survives repaint");
      const navigationButton =
        popover.querySelector<HTMLElement>(".llm-citation-icon")!;
      assert.isOk(navigationButton);
      reader = await Zotero.Reader.open(fixture.pdfAttachmentId);
      await reader._initPromise;
      await reader._waitForReader();
      const navigation =
        await api.observeCitationNavigationFocus(navigationButton);
      assert.isTrue(navigation.started);
      assert.isTrue(navigation.finished, JSON.stringify(navigation));
      assert.isTrue(
        collectReaderSelectionDocuments(reader).some((pageDoc) =>
          pageDoc.querySelector(".highlight.selected, .highlight"),
        ),
        "the existing quote pipeline highlights the PDF passage",
      );
      // A render replacement must release the portal and its document listeners.
      chip!.closest(".llm-paper-source-indicator")!.remove();
      await Zotero.Promise.delay(30);
      assert.isNull(doc.querySelector(".llm-paper-source-popover"));

      const bubble = doc.createElement("div");
      const host = doc.body || doc.documentElement;
      host.appendChild(bubble);
      renderAssistantRichText({
        body: host,
        bubble,
        panelItem: item,
        assistantMessage: {
          role: "assistant",
          text: `One supporting passage. [[cite:${firstCitation.id}]]`,
          quoteCitations: [firstCitation],
          timestamp: Date.now(),
        },
      });
      assert.equal(
        bubble.querySelector(".llm-paper-source-count")?.textContent,
        "1 Quote",
      );
      renderAssistantRichText({
        body: host,
        bubble,
        panelItem: item,
        assistantMessage: {
          role: "assistant",
          text: "Example `[[cite:unknown]]` and unknown evidence. [[cite:unknown]]",
          timestamp: Date.now(),
        },
      });
      assert.include(
        bubble.querySelector("code")?.textContent || "",
        "[[cite:unknown]]",
      );
      assert.isNull(bubble.querySelector(".llm-paper-source-indicator"));
      bubble.remove();

      const webSource = createSourcePopover(doc, {
        label: "Web sources",
        icon: doc.createElement("span"),
        populate: () => {},
      });
      host.appendChild(webSource);
      webSource.dispatchEvent(new (win as any).MouseEvent("mouseenter"));
      assert.equal(
        webSource.querySelector("button")!.getAttribute("aria-expanded"),
        "true",
        "web sources retain their existing hover behavior",
      );
      webSource.remove();
      await Zotero.Promise.delay(30);
      assert.isNull(doc.querySelector(".llm-web-source-popover"));
    } finally {
      reader?.close?.();
      await api.reset();
      await api.cleanupFixture(second);
      await api.cleanupFixture(fixture);
    }
  });
});
