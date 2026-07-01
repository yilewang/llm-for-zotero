import { assert } from "chai";
import {
  buildQuoteTextIndex,
  findCanonicalQuoteSourceSpan,
  normalizeQuoteTextCanonical,
} from "../src/modules/contextPanel/quoteTextNormalization";

describe("quoteTextNormalization", function () {
  it("normalizes MinerU math and PDF punctuation without content-word repairs", function () {
    assert.equal(
      normalizeQuoteTextCanonical(
        "crossvalidated goodnessof $\\textstyle \\mathbf { R } ^ { 2 }$ (cvR²)",
      ),
      "crossvalidated goodnessof r2 cvr2",
    );
  });

  it("normalizes Unicode hyphens, soft hyphens, curly quotes, and line-break hyphenation", function () {
    assert.equal(
      normalizeQuoteTextCanonical(
        "“Al\u00ad-\nthough” cross\u2011validated R ^ { 2 }",
      ),
      "although cross validated r2",
    );
  });

  it("removes standalone soft hyphens without splitting words", function () {
    assert.equal(
      normalizeQuoteTextCanonical("Al\u00adthough cross\u00advalidated"),
      "although crossvalidated",
    );
  });

  it("maps canonical full-span matches back to original source text", function () {
    const source =
      "But we found that the model\u2019s goodness-of-fit, measured by crossvalidated $\\textstyle \\mathbf { R } ^ { 2 }$ (cvR2 ), dropped sharply.";
    const index = buildQuoteTextIndex(source);
    const span = findCanonicalQuoteSourceSpan(
      index,
      "the model's goodness-of-fit, measured by crossvalidated R² (cvR2 ), dropped",
    );

    assert.isNotNull(span);
    assert.include(span?.text, "the model\u2019s goodness-of-fit");
    assert.include(span?.text, "$\\textstyle \\mathbf { R } ^ { 2 }$");
    assert.include(span?.text, "dropped");
  });

  it("preserves adjacent source punctuation when mapping canonical spans", function () {
    const source = "The model\u2019s accuracy dropped sharply!";
    const span = findCanonicalQuoteSourceSpan(
      buildQuoteTextIndex(source),
      "The model's accuracy dropped sharply.",
    );

    assert.equal(span?.text, "The model\u2019s accuracy dropped sharply!");
  });
});
