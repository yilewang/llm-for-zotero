import { assert } from "chai";
import { canonicalNoteHtml, noteHtmlMatches } from "../src/utils/noteHtml";

describe("native note content equivalence", function () {
  it("recognizes only representation differences", function () {
    assert.isTrue(
      noteHtmlMatches(
        '<div class="zotero-note znv1"><div data-schema-version="9"><p>A "quote".</p>\n<hr>\n<ul><li>\nResult\n</li></ul></div></div>',
        "<p>A &quot;quote&quot;.</p><hr/><ul><li>Result</li></ul>",
      ),
    );
  });
  for (const [before, after] of [
    ["<p>A B</p>", "<p>AB</p>"],
    ["<p>A</p><p>B</p>", "<p>A B</p>"],
    ["<p><strong>A</strong></p>", "<p>A</p>"],
    ['<ol start="2"><li>A</li></ol>', "<ul><li>A</li></ul>"],
    ['<a href="https://a.test">A</a>', '<a href="https://b.test">A</a>'],
    ['<img data-attachment-key="ONE">', '<img data-attachment-key="TWO">'],
    ["<pre>A  B\n</pre>", "<pre>A B\n</pre>"],
    ['<span class="math">x  y</span>', '<span class="math">x y</span>'],
    [
      '<div data-schema-version="9" data-citation-items="original"><p>A</p></div>',
      '<div data-schema-version="9"><p>A</p></div>',
    ],
  ])
    it(`rejects lost or changed content: ${before}`, function () {
      return assert.isFalse(noteHtmlMatches(before, after));
    });
});

describe("note content with the root registry counted by its works", function () {
  const uri = (key: string) => `http://zotero.org/users/local/abc/items/${key}`;
  const registry = (...works: Array<[string, string]>) =>
    encodeURIComponent(
      JSON.stringify(
        works.map(([key, title]) => ({
          uris: [uri(key)],
          itemData: { title, author: [{ family: "Smith" }] },
        })),
      ),
    );
  const chip = (key: string) =>
    `<span class="citation" data-citation="${encodeURIComponent(
      JSON.stringify({
        citationItems: [{ uris: [uri(key)], locator: "4" }],
        properties: {},
      }),
    )}">(<span class="citation-item">Smith, 2020, p. 4</span>)</span>`;
  const note = (root: string, body = `<p>Claim ${chip("A")}.</p>`) =>
    `<div data-citation-items="${root}" data-schema-version="9"><h1>T</h1>${body}</div>`;
  const works = (html: string) =>
    canonicalNoteHtml(html, { registryWorksOnly: true });
  const saved = note(registry(["A", "Paper"]));

  it("matches the note after Zotero's editor refreshed a retitled work", function () {
    // The editor rewrites the cached CSL data and adds newlines after blocks.
    const refreshed = note(
      registry(["A", "Paper, retitled"]),
      `\n<p>Claim ${chip("A")}.</p>\n`,
    ).replace("</h1>", "</h1>\n");
    assert.notEqual(canonicalNoteHtml(refreshed), canonicalNoteHtml(saved));
    assert.equal(works(refreshed), works(saved));
  });

  for (const [label, changed] of [
    [
      "changed text",
      note(registry(["A", "Paper"]), `<p>Claim edited ${chip("A")}.</p>`),
    ],
    [
      "a chip for another work",
      note(registry(["A", "Paper"]), `<p>Claim ${chip("B")}.</p>`),
    ],
    ["a removed chip", note(registry(["A", "Paper"]), "<p>Claim.</p>")],
    ["another registered work", note(registry(["B", "Paper"]))],
    [
      "an added registered work",
      note(registry(["A", "Paper"], ["B", "Other"])),
    ],
    ["no registry", saved.replace(/ data-citation-items="[^"]*"/, "")],
  ])
    it(`still differs on ${label}`, function () {
      assert.notEqual(works(changed), works(saved));
    });
});
