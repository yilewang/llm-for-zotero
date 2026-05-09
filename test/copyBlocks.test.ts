import { assert } from "chai";
import {
  buildMarkdownTableFromRows,
  formatDisplayLatex,
} from "../src/modules/contextPanel/copyBlocks";

describe("copyBlocks helpers", function () {
  it("formats formula blocks as reusable display latex", function () {
    assert.equal(
      formatDisplayLatex(" x^2 + y^2 = z^2 "),
      "$$x^2 + y^2 = z^2$$",
    );
  });

  it("builds markdown tables without duplicated cell content", function () {
    const markdown = buildMarkdownTableFromRows([
      ["算法", "时间复杂度", "空间复杂度", "稳定性"],
      ["冒泡排序", "O(n^2)", "O(1)", "稳定"],
      ["快速排序", "O(n log n)", "O(log n)", "不稳定"],
    ]);
    assert.equal(
      markdown,
      [
        "| 算法 | 时间复杂度 | 空间复杂度 | 稳定性 |",
        "| --- | --- | --- | --- |",
        "| 冒泡排序 | O(n^2) | O(1) | 稳定 |",
        "| 快速排序 | O(n log n) | O(log n) | 不稳定 |",
      ].join("\n"),
    );
    assert.notInclude(markdown, "O(n^2)O(n^2)");
  });

  it("escapes markdown separators in table cells", function () {
    const markdown = buildMarkdownTableFromRows([["col"], ["a|b"]]);
    assert.include(markdown, "a\\|b");
  });
});
