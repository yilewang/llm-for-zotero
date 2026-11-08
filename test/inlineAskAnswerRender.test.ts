import { assert } from "chai";
import { describe, it } from "mocha";
import {
  parseInlineAskAnswer,
  renderInlineAskAnswer,
  stripInlineAskCitationTokens,
} from "../src/modules/contextPanel/selectionPrompt/inlineAskAnswerRender";
import { readerOverlayPalette } from "../src/modules/contextPanel/selectionPrompt/readerOverlayShared";
import { makeFakeReaderDoc } from "./helpers/fakeReaderOverlayDom";

describe("stripInlineAskCitationTokens", function () {
  it("removes cite and quote tokens and the space they leave", function () {
    assert.equal(
      stripInlineAskCitationTokens(
        "Drift is slow [[cite:ABC123]] and stable [[quote:q-1]].\nNext [[QUOTE:x]] line.",
      ),
      "Drift is slow and stable.\nNext line.",
    );
  });

  it("keeps an unfinished token while it streams in, and other brackets", function () {
    assert.equal(stripInlineAskCitationTokens("See [[quo"), "See [[quo");
    assert.equal(
      stripInlineAskCitationTokens("A [[link]] and [x]"),
      "A [[link]] and [x]",
    );
  });
});

describe("parseInlineAskAnswer", function () {
  it("splits paragraphs on blank lines and keeps soft line breaks", function () {
    const blocks = parseInlineAskAnswer("First line\nsecond line\n\nNext para");
    assert.deepEqual(
      blocks.map((block) => block.kind),
      ["paragraph", "paragraph"],
    );
    const first = blocks[0];
    assert.equal(first.kind === "paragraph" && first.lines.length, 2);
  });

  it("reads bullet and numbered lists", function () {
    const blocks = parseInlineAskAnswer("- one\n- two\n\n1. first\n2) second");
    assert.deepEqual(
      blocks.map((block) =>
        block.kind === "list" ? [block.ordered, block.items.length] : null,
      ),
      [
        [false, 2],
        [true, 2],
      ],
    );
  });

  it("reads bold, italic and inline code, and leaves snake_case alone", function () {
    const [block] = parseInlineAskAnswer(
      "A **bold** and *italic* and `code` and snake_case_name and _em_.",
    );
    assert.equal(block.kind, "paragraph");
    const inlines = block.kind === "paragraph" ? block.lines[0] : [];
    assert.deepEqual(
      inlines.map((inline) => [inline.kind, inline.text]),
      [
        ["text", "A "],
        ["strong", "bold"],
        ["text", " and "],
        ["em", "italic"],
        ["text", " and "],
        ["code", "code"],
        ["text", " and snake_case_name and "],
        ["em", "em"],
        ["text", "."],
      ],
    );
  });

  it("shows an unclosed marker as text while the answer streams", function () {
    const [block] = parseInlineAskAnswer("This is **not closed");
    const inlines = block.kind === "paragraph" ? block.lines[0] : [];
    assert.deepEqual(
      inlines.map((inline) => [inline.kind, inline.text]),
      [["text", "This is **not closed"]],
    );
  });

  it("keeps math as text", function () {
    const [block] = parseInlineAskAnswer("Energy $E = mc^2$ and $a*b + c*d$.");
    const inlines = block.kind === "paragraph" ? block.lines[0] : [];
    assert.deepEqual(
      inlines.map((inline) => [inline.kind, inline.text]),
      [["text", "Energy $E = mc^2$ and $a*b + c*d$."]],
    );
  });

  it("shows a heading as a bold paragraph and a fenced block as code", function () {
    const blocks = parseInlineAskAnswer("## Summary\n\n```\nx = 1\n```");
    assert.equal(blocks[0].kind, "paragraph");
    const heading = blocks[0].kind === "paragraph" ? blocks[0].lines[0] : [];
    assert.deepEqual(
      heading.map((inline) => [inline.kind, inline.text]),
      [["strong", "Summary"]],
    );
    assert.deepEqual(blocks[1], { kind: "code", text: "x = 1" });
  });
});

describe("renderInlineAskAnswer", function () {
  it("builds styled elements without markup injection", function () {
    const doc = makeFakeReaderDoc();
    const container = doc.createElementNS("", "div");
    container.textContent = "old";
    renderInlineAskAnswer(
      doc,
      container,
      "Hi **there** <b>x</b> [[cite:1]]\n\n- a `b`",
      readerOverlayPalette(false),
    );
    const [p, ul] = container.children;
    assert.equal(p.tagName, "P");
    assert.equal(p.textContent, "Hi there <b>x</b>");
    assert.equal(p.querySelector("strong").textContent, "there");
    assert.equal(ul.tagName, "UL");
    assert.equal(ul.children[0].tagName, "LI");
    const code = ul.querySelector("code");
    assert.equal(code.textContent, "b");
    assert.equal(code.style.borderRadius, "4px");
    assert.equal(container.children.length, 2);
    // The last block has no bottom margin.
    assert.equal(ul.style.margin, "0");
  });
});
