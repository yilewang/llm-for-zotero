import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { preparePaperPromptContext } from "../src/agent/context/paperPromptContext";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { renderAssistantRichText } from "../src/modules/contextPanel/assistantRichText";
import { collectReaderSelectionDocuments } from "../src/services/pdf/readerSelection";
import { waitForAssistantQuoteValidationForTests } from "../src/modules/contextPanel/quoteValidation/scheduling";
import { createSourcePopover } from "../src/modules/contextPanel/sourcePopover";

describe("workflow: per-sentence citation marks", function () {
  this.timeout(120000);

  it("reads full native PDFs, marks each cited sentence in place, reopens stored evidence and jumps to its passage", async function () {
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
          ".llm-paper-cite-mark .llm-web-source-chip",
        );
        if (!chip) await Zotero.Promise.delay(50);
      }
      assert.isOk(chip, "stored paragraph citation reopens as a compact mark");
      await waitForAssistantQuoteValidationForTests(seeded.conversationKey!);
      // Quote validation schedules a separate conversation repaint.
      await Zotero.Promise.delay(250);
      const marks = Array.from(
        doc.querySelectorAll<HTMLElement>(".llm-paper-cite-mark"),
      ) as HTMLElement[];
      assert.lengthOf(
        marks,
        2,
        "each citation run keeps its own mark after background quote validation",
      );
      for (const mark of marks) {
        assert.isTrue(
          mark.classList.contains("llm-web-source-indicator") &&
            mark.classList.contains("llm-paper-source-indicator"),
        );
      }
      assert.equal(marks[0].dataset.citationIds, firstCitation.id);
      assert.equal(marks[0].dataset.citationNumbers, "1");
      assert.equal(
        marks[1].dataset.citationIds,
        `${firstCitation.id} ${secondCitation.id}`,
      );
      assert.equal(marks[1].dataset.citationNumbers, "1 2");
      assert.deepEqual(
        marks.map(
          (mark) => mark.querySelector(".llm-paper-source-count")?.textContent,
        ),
        ["1", "1, 2"],
        "each mark shows its passages' answer-wide numbers",
      );
      assert.match(
        marks[0].previousSibling?.textContent || "",
        /repeated sessions$/,
        "a mid-sentence mark stays where its token was, against its words",
      );
      assert.match(marks[0].nextSibling?.textContent || "", /^, and /);
      assert.match(
        marks[1].previousSibling?.textContent || "",
        /population result\.$/,
        "a token after the period marks the sentence it closes",
      );
      assert.equal(
        marks[0].closest("p"),
        marks[1].closest("p"),
        "both marks stay in their paragraph",
      );
      chip = marks[1].querySelector<HTMLElement>(".llm-web-source-chip");
      assert.isOk(chip, "the mark survives background quote validation");
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
      assert.isNull(
        chip!.querySelector(".llm-paper-source-icon"),
        "a mark shows numbers only, no icon",
      );
      const chipStyle = win.getComputedStyle(chip!)!;
      assert.isAbove(Number.parseFloat(chipStyle.borderTopWidth), 0);
      assert.equal(
        chip!.getAttribute("aria-label"),
        "Supporting passages 1, 2",
      );
      const singleChip = marks[0].querySelector<HTMLElement>(
        ".llm-web-source-chip",
      )!;
      assert.isAtLeast(
        singleChip.getBoundingClientRect().width + 0.5,
        singleChip.getBoundingClientRect().height,
        "a one-number mark is at least as wide as it is tall",
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
      assert.deepEqual(
        Array.from(popover.querySelectorAll(".llm-paper-source-heading")).map(
          (heading) => (heading?.textContent || "").split(" · ")[0],
        ),
        ["Quote 1", "Quote 2"],
        "passage headings use the answer-wide numbers",
      );
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
      // An old answer's paragraph-end token: one mark at the paragraph end.
      const oldMark = bubble.querySelector<HTMLElement>(".llm-paper-cite-mark");
      assert.equal(
        oldMark?.querySelector(".llm-paper-source-count")?.textContent,
        "1",
      );
      assert.equal(oldMark, oldMark?.closest("p")?.lastElementChild);
      assert.equal(
        oldMark?.previousSibling?.textContent,
        "One supporting passage.",
      );
      renderAssistantRichText({
        body: host,
        bubble,
        panelItem: item,
        assistantMessage: {
          role: "assistant",
          text: `Drift is slow at 0.46 [[cite:${secondCitation.id}]]. Activity is **stable [[cite:${firstCitation.id}]]**. Unknown [[cite:invented]].`,
          quoteCitations: [firstCitation, secondCitation],
          timestamp: Date.now(),
        },
      });
      const [moved, inBold] = Array.from(
        bubble.querySelectorAll<HTMLElement>(".llm-paper-cite-mark"),
      ) as HTMLElement[];
      assert.equal(
        moved.previousSibling?.textContent,
        "Drift is slow at 0.46.",
        "the mark follows the sentence's period, with no space before it",
      );
      assert.match(moved.nextSibling?.textContent || "", /^ Activity is /);
      assert.equal(moved.dataset.citationNumbers, "1");
      assert.equal(inBold.dataset.citationNumbers, "2");
      assert.equal(
        inBold.parentElement?.tagName.toLowerCase(),
        "strong",
        "a token inside inline formatting keeps its place",
      );
      assert.equal(inBold.previousSibling?.textContent, "stable");
      assert.match(
        bubble.querySelector("p")?.textContent || "",
        /Unknown\.$/,
        "an unknown citation leaves no space or mark behind",
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
