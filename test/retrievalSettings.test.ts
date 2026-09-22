import { assert } from "chai";
import {
  RETRIEVAL_DEFAULTS,
  resolveRetrievalSettings,
} from "../src/utils/embedding/settings";

const empty = { textTopK: "", imageTopK: "", imageOutstandingPercent: "" };

describe("retrieval settings", function () {
  it("uses the defaults for empty fields", function () {
    assert.deepEqual(resolveRetrievalSettings(empty), RETRIEVAL_DEFAULTS);
    assert.deepEqual(RETRIEVAL_DEFAULTS, {
      textTopK: 4,
      imageTopK: 2,
      imageOutstandingPercent: 80,
    });
  });

  it("uses explicit values", function () {
    assert.deepEqual(
      resolveRetrievalSettings({
        textTopK: "8",
        imageTopK: "3",
        imageOutstandingPercent: "95",
      }),
      { textTopK: 8, imageTopK: 3, imageOutstandingPercent: 95 },
    );
  });

  it("accepts 0 for the image count and the percentage but not for text", function () {
    assert.deepEqual(
      resolveRetrievalSettings({
        textTopK: "0",
        imageTopK: "0",
        imageOutstandingPercent: "0",
      }),
      { textTopK: 4, imageTopK: 0, imageOutstandingPercent: 0 },
    );
  });

  it("falls back on invalid values and clamps to the ranges", function () {
    assert.deepEqual(
      resolveRetrievalSettings({
        textTopK: "99",
        imageTopK: "abc",
        imageOutstandingPercent: "500",
      }),
      { textTopK: 24, imageTopK: 2, imageOutstandingPercent: 200 },
    );
    assert.equal(
      resolveRetrievalSettings({ ...empty, imageTopK: "9" }).imageTopK,
      6,
    );
  });
});
