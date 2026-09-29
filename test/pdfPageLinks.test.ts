import { assert } from "chai";
import { buildAssistantDisplayMarkdownForRender } from "../src/modules/contextPanel/assistantRichText";
import {
  parseZoteroOpenPdfUri,
  resolvePdfPageJump,
  rewritePdfPageLinksForDisplay,
  type PdfPageLinkLookups,
} from "../src/modules/contextPanel/pdfPageLinks";

type FakeElement = {
  tagName: string;
  attributes: Record<string, string>;
  parent?: FakeElement;
  getAttribute(name: string): string | null;
  closest(selector: string): FakeElement | null;
};

function element(
  tagName: string,
  attributes: Record<string, string> = {},
  parent?: FakeElement,
): FakeElement {
  const self: FakeElement = {
    tagName,
    attributes,
    parent,
    getAttribute: (name) => attributes[name] ?? null,
    closest(selector) {
      const attributeMatch = /^\[([a-z-]+)\]$/.exec(selector);
      const matches = attributeMatch
        ? attributeMatch[1] in attributes
        : selector === "a[href]"
          ? tagName === "a" && "href" in attributes
          : false;
      return matches ? self : (parent?.closest(selector) ?? null);
    },
  };
  return self;
}

const lookups: PdfPageLinkLookups = {
  userLibraryID: () => 1,
  libraryIDForGroup: (groupID) => (groupID === 42 ? 7 : null),
  itemIdForKey: (libraryID, itemKey) =>
    libraryID === 1 && itemKey === "ABCD1234"
      ? 344
      : libraryID === 7 && itemKey === "GRP00001"
        ? 900
        : null,
};

function jump(target: FakeElement) {
  return resolvePdfPageJump(target as unknown as Element, lookups);
}

describe("pdf page links", function () {
  it("parses user-library and group open-pdf links", function () {
    assert.deepEqual(
      parseZoteroOpenPdfUri("zotero://open-pdf/library/items/ABCD1234?page=44"),
      { itemKey: "ABCD1234", pageNumber: 44 },
    );
    assert.deepEqual(
      parseZoteroOpenPdfUri("zotero://open-pdf/groups/42/items/GRP00001"),
      { groupID: 42, itemKey: "GRP00001" },
    );
    assert.isNull(
      parseZoteroOpenPdfUri("zotero://select/library/items/ABCD1234"),
    );
    assert.isNull(parseZoteroOpenPdfUri("https://example.org"));
  });

  it("carries open-pdf link targets as inert fragments for display", function () {
    const markdown =
      "See [p. 44](zotero://open-pdf/library/items/ABCD1234?page=44) and [the web](https://example.org).";
    const rewritten = rewritePdfPageLinksForDisplay(markdown);
    assert.include(
      rewritten,
      `[p. 44](#llm-pdf-page:${encodeURIComponent("zotero://open-pdf/library/items/ABCD1234?page=44")})`,
    );
    assert.include(rewritten, "[the web](https://example.org)");
    assert.notInclude(rewritten, "](zotero://");
  });

  it("keeps a link title while rewriting the target", function () {
    const rewritten = rewritePdfPageLinksForDisplay(
      '[p. 2](zotero://open-pdf/library/items/ABCD1234?page=2 "Figure 1")',
    );
    assert.match(rewritten, /\]\(#llm-pdf-page:[^\s)]+ "Figure 1"\)$/);
  });

  it("resolves a clicked page link to the attachment and 0-based page", function () {
    const href = `#llm-pdf-page:${encodeURIComponent("zotero://open-pdf/library/items/ABCD1234?page=44")}`;
    const link = element("a", { href });
    const inner = element("strong", {}, link);
    assert.deepEqual(jump(inner), { contextItemId: 344, pageIndex: 43 });
  });

  it("resolves group-library links through the group's library", function () {
    const href = `#llm-pdf-page:${encodeURIComponent("zotero://open-pdf/groups/42/items/GRP00001?page=3")}`;
    assert.deepEqual(jump(element("a", { href })), {
      contextItemId: 900,
      pageIndex: 2,
    });
  });

  it("opens the start of the PDF when the link has no page", function () {
    const href = `#llm-pdf-page:${encodeURIComponent("zotero://open-pdf/library/items/ABCD1234")}`;
    assert.deepEqual(jump(element("a", { href })), { contextItemId: 344 });
  });

  it("resolves an element carrying a PDF location", function () {
    const caption = element("figcaption", {
      "data-llm-pdf-context-item-id": "344",
      "data-llm-pdf-page-index": "48",
    });
    assert.deepEqual(jump(caption), { contextItemId: 344, pageIndex: 48 });
  });

  it("displays an answer's page links as fragments while streaming and when done", function () {
    const text =
      "The formula is on [p. 44](zotero://open-pdf/library/items/ABCD1234?page=44).";
    for (const streaming of [true, false]) {
      const rendered = buildAssistantDisplayMarkdownForRender({
        text,
        streaming,
      });
      assert.include(rendered, "[p. 44](#llm-pdf-page:");
      assert.notInclude(rendered, "](zotero://");
    }
  });

  it("ignores ordinary links and unknown items", function () {
    assert.isNull(jump(element("a", { href: "https://example.org" })));
    const unknown = `#llm-pdf-page:${encodeURIComponent("zotero://open-pdf/library/items/ZZZZ9999?page=1")}`;
    assert.isNull(jump(element("a", { href: unknown })));
    assert.isNull(jump(element("span")));
  });
});
