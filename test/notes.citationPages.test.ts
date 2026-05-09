import { assert } from "chai";
import {
  clearCachedCitationPagesForTests,
  rememberCachedCitationPage,
} from "../src/modules/contextPanel/assistantCitationLinks";
import { buildChatHistoryNotePayload } from "../src/modules/contextPanel/notes";
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
});
