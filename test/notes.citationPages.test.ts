import { assert } from "chai";
import {
  clearCachedCitationPagesForTests,
  rememberCachedCitationPage,
} from "../src/modules/contextPanel/assistantCitationLinks";
import { buildChatHistoryNotePayload } from "../src/modules/contextPanel/notes";
import { buildQuoteCitation } from "../src/modules/contextPanel/quoteCitations";
import type {
  Message,
  PaperContextRef,
} from "../src/modules/contextPanel/types";

describe("notes citation page export", function () {
  const originalZotero = globalThis.Zotero;

  beforeEach(function () {
    clearCachedCitationPagesForTests();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Items: {
        get: (id: number) =>
          id === 23
            ? ({
                id,
                key: "ATTACH23",
                libraryID: 1,
              } as Zotero.Item)
            : null,
      },
      Libraries: {
        userLibraryID: 1,
        get: () => null,
      },
    } as typeof Zotero;
  });

  afterEach(function () {
    clearCachedCitationPagesForTests();
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("writes the corrected cached page into saved chat-history notes", function () {
    const quote =
      "We choose Hebbian learning, not only for its biological plausibility, but to also allow rapid learning when entering a new environment.";
    const paperContexts: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 23,
        title: "Whittington 2020",
        firstCreator: "Whittington et al.",
        year: "2020",
      },
    ];
    const messages: Message[] = [
      {
        role: "user",
        text: "Summarize the paper.",
        timestamp: 1,
        paperContexts,
      },
      {
        role: "assistant",
        text: `> ${quote}\n\n(Whittington et al., 2020, page 1)`,
        timestamp: 2,
        modelName: "Claude",
      },
    ];

    rememberCachedCitationPage(23, quote, 22, "23");

    const result = buildChatHistoryNotePayload(messages);

    assert.include(
      result.noteHtml,
      'href="zotero://open-pdf/library/items/ATTACH23?page=23"',
    );
    assert.include(result.noteHtml, "(Whittington et al., 2020, page 23)");
    assert.notInclude(result.noteHtml, "(Whittington et al., 2020, page 1)");
  });

  it("renders stored quote anchors before note citation injection", function () {
    const quote = "Structured quote anchors should survive note export.";
    const paperContexts: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 23,
        title: "Whittington 2020",
        firstCreator: "Whittington et al.",
        year: "2020",
      },
    ];
    const quoteCitation = buildQuoteCitation({
      quoteText: quote,
      citationLabel: "(Whittington et al., 2020)",
      contextItemId: 23,
      itemId: 1,
    });
    assert.isDefined(quoteCitation);
    const messages: Message[] = [
      {
        role: "user",
        text: "Use the anchor.",
        timestamp: 1,
        paperContexts,
      },
      {
        role: "assistant",
        text: `[[quote:${quoteCitation!.id}]]`,
        timestamp: 2,
        modelName: "Claude",
        quoteCitations: [quoteCitation!],
      },
    ];

    rememberCachedCitationPage(23, quote, 22, "23");

    const result = buildChatHistoryNotePayload(messages);

    assert.include(result.noteHtml, "<blockquote>");
    assert.include(result.noteHtml, "Structured quote anchors");
    assert.include(
      result.noteHtml,
      'href="zotero://open-pdf/library/items/ATTACH23?page=23"',
    );
    assert.notInclude(result.noteHtml, "[[quote:");
  });

  it("does not export model-written blockquote pages without a verified cache", function () {
    const quote =
      "We choose Hebbian learning, not only for its biological plausibility, but to also allow rapid learning when entering a new environment.";
    const paperContexts: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 23,
        title: "Whittington 2020",
        firstCreator: "Whittington et al.",
        year: "2020",
      },
    ];
    const messages: Message[] = [
      {
        role: "user",
        text: "Summarize the paper.",
        timestamp: 1,
        paperContexts,
      },
      {
        role: "assistant",
        text: `> ${quote}\n\n(Whittington et al., 2020, page 1)`,
        timestamp: 2,
        modelName: "Claude",
      },
    ];

    const result = buildChatHistoryNotePayload(messages);

    assert.include(
      result.noteHtml,
      'href="zotero://open-pdf/library/items/ATTACH23"',
    );
    assert.notInclude(result.noteHtml, "?page=1");
    assert.include(result.noteHtml, "(Whittington et al., 2020)");
    assert.notInclude(result.noteHtml, "(Whittington et al., 2020, page 1)");
  });

  it("does not attach a cached quote page to a citation separated by commentary", function () {
    const quote =
      "We choose Hebbian learning, not only for its biological plausibility, but to also allow rapid learning when entering a new environment.";
    const paperContexts: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 23,
        title: "Whittington 2020",
        firstCreator: "Whittington et al.",
        year: "2020",
      },
    ];
    const messages: Message[] = [
      {
        role: "user",
        text: "Summarize the paper.",
        timestamp: 1,
        paperContexts,
      },
      {
        role: "assistant",
        text: `> ${quote}\n\nEmphasis: the paper frames rapid learning as biologically constrained.\n\n(Whittington et al., 2020, page 1)`,
        timestamp: 2,
        modelName: "Claude",
      },
    ];

    rememberCachedCitationPage(23, quote, 22, "23");

    const result = buildChatHistoryNotePayload(messages);

    assert.include(result.noteHtml, "Emphasis:");
    assert.notInclude(
      result.noteHtml,
      'href="zotero://open-pdf/library/items/ATTACH23?page=23"',
    );
    assert.notInclude(result.noteHtml, "(Whittington et al., 2020, page 23)");
    assert.notInclude(result.noteHtml, "(Whittington et al., 2020, page 1)");
  });

  it("uses cached pages when the rendered blockquote escapes HTML entities", function () {
    const quote = "A & B < C can still appear in a quoted passage.";
    const paperContexts: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 23,
        title: "Whittington 2020",
        firstCreator: "Whittington et al.",
        year: "2020",
      },
    ];
    const messages: Message[] = [
      {
        role: "user",
        text: "Summarize the paper.",
        timestamp: 1,
        paperContexts,
      },
      {
        role: "assistant",
        text: `> ${quote}\n\n(Whittington et al., 2020, page 1)`,
        timestamp: 2,
        modelName: "Claude",
      },
    ];

    rememberCachedCitationPage(23, quote, 7, "8");

    const result = buildChatHistoryNotePayload(messages);

    assert.include(
      result.noteHtml,
      'href="zotero://open-pdf/library/items/ATTACH23?page=8"',
    );
    assert.include(result.noteHtml, "(Whittington et al., 2020, page 8)");
    assert.notInclude(result.noteHtml, "(Whittington et al., 2020, page 1)");
  });

  it("links citations when the paper exists only in hidden citation contexts", function () {
    const citationPaperContexts: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 23,
        title: "Whittington 2020",
        firstCreator: "Whittington et al.",
        year: "2020",
      },
    ];
    const messages: Message[] = [
      {
        role: "user",
        text: "Summarize the retrieved folder paper.",
        timestamp: 1,
        citationPaperContexts,
      },
      {
        role: "assistant",
        text: "The paper emphasizes fast environment-specific learning (Whittington et al., 2020).",
        timestamp: 2,
        modelName: "Claude",
      },
    ];

    const result = buildChatHistoryNotePayload(messages);

    assert.include(
      result.noteHtml,
      'href="zotero://open-pdf/library/items/ATTACH23"',
    );
  });

  it("does not export model-written inline citation pages", function () {
    const paperContexts: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 23,
        title: "Whittington 2020",
        firstCreator: "Whittington et al.",
        year: "2020",
      },
    ];
    const messages: Message[] = [
      {
        role: "user",
        text: "Summarize the paper.",
        timestamp: 1,
        paperContexts,
      },
      {
        role: "assistant",
        text: "The paper emphasizes fast environment-specific learning (Whittington et al., 2020, page 11).",
        timestamp: 2,
        modelName: "Claude",
      },
    ];

    const result = buildChatHistoryNotePayload(messages);

    assert.include(
      result.noteHtml,
      'href="zotero://open-pdf/library/items/ATTACH23"',
    );
    assert.notInclude(result.noteHtml, "?page=11");
    assert.include(result.noteHtml, "(Whittington et al., 2020)");
    assert.notInclude(result.noteHtml, "(Whittington et al., 2020, page 11)");
  });
});
