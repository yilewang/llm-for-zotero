import { assert } from "chai";
import {
  buildToolResultPreview,
  PREVIEW_MAX_BYTES,
} from "../src/agent/store/truncatedToolResult";

describe("tool preview string measurement", function () {
  it("measures repeated field names once per preview rather than once per row", function () {
    const original = JSON.stringify;
    let fieldMeasurements = 0;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      if (args[0] === "repeated field") fieldMeasurements += 1;
      return original.apply(JSON, args);
    }) as typeof JSON.stringify;
    try {
      const content = {
        rows: Array.from({ length: 200 }, () => ({
          "repeated field": "x".repeat(250),
        })),
      };
      for (let call = 1; call <= 2; call += 1) {
        const preview = buildToolResultPreview(content);
        assert.exists(preview);
        assert.isAtMost(original(preview).length, PREVIEW_MAX_BYTES);
        assert.equal(fieldMeasurements, call);
      }
      assert.lengthOf(content.rows, 200, "the source is not shortened");
      assert.lengthOf(content.rows[0]["repeated field"], 250);
    } finally {
      JSON.stringify = original;
    }
  });

  it("preserves exact escaping and distinct shortened string lengths", function () {
    const content = {
      'quoted"key': 'a"b\\c\n\t\u0000',
      unicode: "\ud800\u2028🙂",
      values: ["short", "x".repeat(250)],
    };
    const preview = buildToolResultPreview(content);
    assert.deepEqual(preview, {
      ...content,
      values: ["short", `${"x".repeat(200)}…`],
    });
    assert.isAtMost(JSON.stringify(preview).length, PREVIEW_MAX_BYTES);
  });

  it("shortens repeated modest strings once per preview without retaining a global cache", function () {
    const original = String.prototype.slice;
    const text = "x".repeat(250);
    let shortenings = 0;
    String.prototype.slice = function (start, end) {
      if (String(this) === text && start === 0 && end === 200) {
        shortenings += 1;
      }
      return original.call(this, start, end);
    };
    try {
      const content = {
        rows: Array.from({ length: 200 }, () => ({ text })),
      };
      for (let call = 1; call <= 2; call += 1) {
        const preview = buildToolResultPreview(content);
        assert.exists(preview);
        assert.isAtMost(JSON.stringify(preview).length, PREVIEW_MAX_BYTES);
        assert.equal(shortenings, call);
      }
      assert.equal(content.rows[0].text, text);
    } finally {
      String.prototype.slice = original;
    }
  });
});
