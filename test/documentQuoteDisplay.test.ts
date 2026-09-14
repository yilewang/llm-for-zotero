import { assert } from "chai";
import { bindDocumentQuotesForDisplay } from "../src/modules/contextPanel/documentQuoteDisplay";

describe("immutable document quote display", function () {
  it("binds exact certified blocks, preserves repeated occurrences and leaves ambiguous or ordinary quotes alone", function () {
    const quote = {
      id: "q1",
      quoteText: "Exact source text.\nSecond source line.",
    };
    const block = "> Exact source text.\n> Second source line.";
    assert.equal(
      bindDocumentQuotesForDisplay(`${block}\n\n${block}`, [quote]),
      "[[quote:q1]]\n\n[[quote:q1]]",
    );
    assert.equal(
      bindDocumentQuotesForDisplay(block, [
        quote,
        { ...quote, id: "other-paper" },
      ]),
      block,
    );
    assert.equal(
      bindDocumentQuotesForDisplay("> Model interpretation.", [quote]),
      "> Model interpretation.",
    );
    assert.equal(
      bindDocumentQuotesForDisplay(`\`\`\`md\n${block}\n\`\`\``, [quote]),
      `\`\`\`md\n${block}\n\`\`\``,
    );
  });
});
