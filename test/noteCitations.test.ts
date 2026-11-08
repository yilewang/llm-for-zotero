import { assert } from "chai";
import { expandNewCitationTokens } from "../src/services/notes/noteCitations";
import {
  buildCitationChipHtml,
  hasNewCitationTokens,
  formatCitationItemPreview,
  mergeNoteCitationItems,
  parseNewCitationToken,
} from "../src/utils/noteCitations";
import { collectNoteEmbeds } from "../src/utils/noteEmbeds";

describe("new citation requests", function () {
  it("reads one or several works, with or without a page", function () {
    assert.deepEqual(parseNewCitationToken("item=12 page=42"), [
      { itemRef: "12", locator: "42" },
    ]);
    assert.deepEqual(parseNewCitationToken("item=ABCD2345"), [
      { itemRef: "ABCD2345", locator: undefined },
    ]);
    assert.deepEqual(
      parseNewCitationToken("item=12 pages=4-9; item=7 page=iv"),
      [
        { itemRef: "12", locator: "4-9" },
        { itemRef: "7", locator: "iv" },
      ],
    );
  });

  it("leaves other templates such as {{cite web|…}} as text", function () {
    const text = "Wikipedia uses {{cite web |url=https://a.test |title=A}}.";
    assert.isFalse(hasNewCitationTokens(text));
    assert.equal(expandNewCitationTokens(text, () => null).text, text);
  });

  it("refuses a misspelled request rather than saving it as text", function () {
    assert.throws(
      () => expandNewCitationTokens("See {{cite:item=12 p. 4}}.", () => null),
      /\{\{cite:item=12 p\. 4\}\} is not a citation request/,
    );
  });

  it("rejects anything that is not item=… [page=…]", function () {
    for (const body of [
      "",
      "12",
      "item=",
      "page=4",
      "item=1;",
      "item=1 chapter=2",
    ])
      assert.isNull(parseNewCitationToken(body), body);
  });
});

describe("citation labels, as Zotero's note editor writes them", function () {
  const year = { issued: { "date-parts": [[2020]] } };
  for (const [authors, expected] of [
    [[{ family: "Smith" }], "Smith, 2020, p. 42"],
    [[{ family: "Smith" }, { family: "Lee" }], "Smith and Lee, 2020, p. 42"],
    [
      [{ family: "Smith" }, { family: "Lee" }, { family: "Ng" }],
      "Smith et al., 2020, p. 42",
    ],
    [[{ literal: "WHO" }], "WHO, 2020, p. 42"],
  ] as const)
    it(expected, function () {
      assert.equal(
        formatCitationItemPreview({
          itemData: { author: authors, ...year },
          locator: "42",
        }),
        expected,
      );
    });

  it("falls back to the quoted title, and uses pp. for a range", function () {
    assert.equal(
      formatCitationItemPreview({
        itemData: { title: "A report", ...year },
        locator: "4-9",
      }),
      "“A report”, 2020, pp. 4-9",
    );
  });

  it("builds a chip that carries only the item URI and page", function () {
    const html = buildCitationChipHtml([
      {
        uri: "http://zotero.org/users/1/items/AB12CD34",
        locator: "42",
        itemData: {
          author: [{ family: "Smith" }],
          issued: { "date-parts": [[2020]] },
        },
      },
    ]);
    const data = /data-citation="([^"]*)"/.exec(html)![1];
    assert.deepEqual(JSON.parse(decodeURIComponent(data)), {
      citationItems: [
        { uris: ["http://zotero.org/users/1/items/AB12CD34"], locator: "42" },
      ],
      properties: {},
    });
    assert.include(
      html,
      '>(<span class="citation-item">Smith, 2020, p. 42</span>)</span>',
    );
    assert.equal(collectNoteEmbeds(html)[0].kind, "citation");
  });
});

describe("the note's citation registry", function () {
  const a = {
    uris: ["http://zotero.org/users/1/items/A"],
    itemData: { title: "A" },
  };
  const b = {
    uris: ["http://zotero.org/users/1/items/B"],
    itemData: { title: "B" },
  };
  const registry = (html: string) =>
    JSON.parse(
      decodeURIComponent(/data-citation-items="([^"]*)"/.exec(html)![1]),
    );

  it("adds a Zotero root container to a note without one", function () {
    const html = mergeNoteCitationItems("<p>Text</p>", [a]);
    assert.match(
      html,
      /^<div data-citation-items="[^"]+" data-schema-version="9"><p>Text<\/p><\/div>$/,
    );
    assert.deepEqual(registry(html), [a]);
  });

  it("adds to an existing registry without repeating a work", function () {
    const first = mergeNoteCitationItems("<p>Text</p>", [a]);
    const second = mergeNoteCitationItems(first, [a, b]);
    assert.deepEqual(registry(second), [a, b]);
    assert.equal(mergeNoteCitationItems(second, [b]), second);
  });

  it("adds the registry attribute to a root that has none", function () {
    const html = mergeNoteCitationItems(
      '<div data-schema-version="10"><p>Text</p></div>',
      [b],
    );
    assert.match(
      html,
      /^<div data-citation-items="[^"]+" data-schema-version="10">/,
    );
    assert.deepEqual(registry(html), [b]);
  });

  it("leaves a note alone when nothing is cited", function () {
    assert.equal(mergeNoteCitationItems("<p>Text</p>", []), "<p>Text</p>");
  });
});
