import { assert } from "chai";
import { noteHtmlMatches } from "../src/utils/noteHtml";

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
