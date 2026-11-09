import { assert } from "chai";
import { createPdfPageRenderer } from "../src/agent/tools/read/pdfPageRenderer";

describe("paper_read page renderer input", function () {
  const renderer = createPdfPageRenderer({} as never);

  it("has no whole-document scope: a bare scope selects nothing to render", function () {
    const result = renderer.validate({ scope: "whole_document" });
    assert.isFalse(result.ok);
    if (!result.ok) assert.notInclude(result.error, "whole_document");
  });

  it("accepts pages, a question, or capture as the only page selectors", function () {
    const pages = renderer.validate({ pages: [2, 3] });
    assert.isTrue(pages.ok);
    if (pages.ok) {
      assert.deepEqual(pages.value.pages, [1, 2]);
      assert.notProperty(pages.value, "scope");
    }
    assert.isTrue(renderer.validate({ question: "Figure 2 axes" }).ok);
    assert.isTrue(renderer.validate({ capture: true }).ok);
  });
});
