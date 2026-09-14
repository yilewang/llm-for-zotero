import { assert } from "chai";
import { normalizeNoteSourceText } from "../src/modules/contextPanel/notes";
import { stripNoteHtml } from "../src/modules/contextPanel/noteSnapshot";
import { renderMarkdownForNote } from "../src/utils/markdown";
import { noteContentMatches } from "../src/agent/services/libraryMutation/handlerUtilities";

describe("native note text round trip", function () {
  it("verifies a saved Markdown note using the same decoded text as native note reads", function () {
    const source =
      "# Paper's result\n\n**Variable** variable_name, literal &amp;lt;tag&amp;gt;.";
    const html = renderMarkdownForNote(source);
    assert.isTrue(noteContentMatches(html, source));
    assert.isFalse(
      noteContentMatches(html, source.replace("variable_name", "variablename")),
    );
    assert.isFalse(
      noteContentMatches(html, source.replace("&amp;lt;tag&amp;gt;", "tag")),
    );
  });
  it("preserves paragraph and quote boundaries after native HTML serialization", function () {
    const markdown =
      "# Research note\n\nFirst **paragraph**.\n\nSecond paragraph.\n\n> Exact source text.\n>\n> (Fixture, 2024)\n\n## References\n\nCitation.\n\n**Model response:** deepseek\n\n**Timestamp**";
    const html = renderMarkdownForNote(markdown);
    for (const serialized of [html, html.replace(/>\s+</g, "><")]) {
      assert.equal(normalizeNoteSourceText(serialized), markdown);
      assert.equal(
        (normalizeNoteSourceText(serialized).match(/^> /gm) || []).length,
        2,
      );
    }
  });

  it("reads the renderer's apostrophes and quoted text without entity leakage", function () {
    const html = renderMarkdownForNote(
      "# Paper's result\n\nThe paper's \"cobalt-control\" method.",
    );
    assert.include(html, "&#039;");
    assert.equal(
      stripNoteHtml(html),
      "Paper's result\nThe paper's \"cobalt-control\" method.",
    );
    assert.equal(
      normalizeNoteSourceText(html),
      "# Paper's result\n\nThe paper's \"cobalt-control\" method.",
    );
  });

  it("decodes numeric entities once and preserves deliberately escaped source text", function () {
    const html =
      "<h2>Paper&#x27;s &#00039;result&#39;</h2><p>Literal &amp;quot; and &amp;lt;tag&amp;gt;.</p>";
    assert.equal(
      stripNoteHtml(html),
      "Paper's 'result'\nLiteral &quot; and &lt;tag&gt;.",
    );
    assert.equal(
      normalizeNoteSourceText(html),
      "## Paper's 'result'\n\nLiteral &quot; and &lt;tag&gt;.",
    );
    assert.equal(
      normalizeNoteSourceText(
        "<p><strong>Literal &amp;lt;tag&amp;gt;</strong></p>",
      ),
      "**Literal &lt;tag&gt;**",
    );
  });
});
