import { assert } from "chai";
import {
  tokenizeRetrievalDiversity,
  tokenizeRetrievalQuery,
  tokenizeRetrievalText,
} from "../src/modules/contextPanel/retrievalTokenizer";

describe("retrievalTokenizer", function () {
  it("preserves academic compounds and indexes their split parts", function () {
    const tokens = tokenizeRetrievalText(
      "Self-supervised p-value β-amyloid IL-6 GPT-4 analysis",
    );

    assert.include(tokens, "self-supervised");
    assert.include(tokens, "self");
    assert.include(tokens, "supervised");
    assert.include(tokens, "p-value");
    assert.include(tokens, "value");
    assert.include(tokens, "β-amyloid");
    assert.include(tokens, "β");
    assert.include(tokens, "amyloid");
    assert.include(tokens, "il-6");
    assert.include(tokens, "il");
    assert.include(tokens, "gpt-4");
    assert.include(tokens, "gpt");
  });

  it("keeps CJK and kana bigrams for languages without whitespace", function () {
    const tokens = tokenizeRetrievalText("神经网络モデル");

    assert.include(tokens, "神经");
    assert.include(tokens, "经网");
    assert.include(tokens, "网络");
    assert.include(tokens, "モデ");
    assert.include(tokens, "デル");
  });

  it("adds Hangul bigrams for Korean text", function () {
    const tokens = tokenizeRetrievalText("표현학습방법");

    assert.include(tokens, "표현");
    assert.include(tokens, "현학");
    assert.include(tokens, "학습");
    assert.include(tokens, "습방");
    assert.include(tokens, "방법");
  });

  it("retains non-English Unicode words", function () {
    const tokens = tokenizeRetrievalText("résumé naïve модель aprendizaje");

    assert.include(tokens, "résumé");
    assert.include(tokens, "naïve");
    assert.include(tokens, "модель");
    assert.include(tokens, "aprendizaje");
  });

  it("filters English stopwords without dropping protected identifiers", function () {
    const tokens = tokenizeRetrievalText("the and with GPT-4 use-case");

    assert.notInclude(tokens, "the");
    assert.notInclude(tokens, "and");
    assert.notInclude(tokens, "with");
    assert.include(tokens, "gpt-4");
    assert.include(tokens, "use-case");
  });

  it("falls query tokenization back to unfiltered tokens when needed", function () {
    assert.deepEqual(tokenizeRetrievalQuery("the"), ["the"]);
  });

  it("uses multilingual tokens for diversity overlap", function () {
    const first = tokenizeRetrievalDiversity("이 논문은 표현학습 방법을 제안한다");
    const second = tokenizeRetrievalDiversity("표현학습 접근법을 비교한다");

    assert.isTrue(first.has("표현"));
    assert.isTrue(first.has("학습"));
    assert.isTrue(second.has("표현"));
    assert.isTrue(second.has("학습"));
  });
});
