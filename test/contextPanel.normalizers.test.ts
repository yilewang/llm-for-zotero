import { assert } from "chai";
import {
  normalizeAttachmentContentHash,
  normalizePaperContextRefs,
  normalizePositiveInt,
  normalizeSelectedTextSource,
  normalizeSelectedTextSources,
} from "../src/modules/contextPanel/normalizers";

describe("contextPanel normalizers", function () {
  it("normalizePositiveInt should return null for invalid values", function () {
    assert.isNull(normalizePositiveInt(undefined));
    assert.isNull(normalizePositiveInt("abc"));
    assert.isNull(normalizePositiveInt(0));
    assert.isNull(normalizePositiveInt(-1));
  });

  it("normalizePositiveInt should floor positive finite values", function () {
    assert.equal(normalizePositiveInt("12"), 12);
    assert.equal(normalizePositiveInt(9.9), 9);
  });

  it("normalizeSelectedTextSource(s) should normalize unknown entries to pdf", function () {
    assert.equal(normalizeSelectedTextSource("model"), "model");
    assert.equal(normalizeSelectedTextSource("pdf"), "pdf");
    assert.equal(normalizeSelectedTextSource("other"), "pdf");

    assert.deepEqual(
      normalizeSelectedTextSources(["model", "x", "pdf"], 3),
      ["model", "pdf", "pdf"],
    );
    assert.deepEqual(normalizeSelectedTextSources(undefined, 2), [
      "pdf",
      "pdf",
    ]);
  });

  it("normalizeAttachmentContentHash should normalize valid hashes only", function () {
    const hash = "a".repeat(64);
    assert.equal(normalizeAttachmentContentHash(hash), hash);
    assert.equal(normalizeAttachmentContentHash(hash.toUpperCase()), hash);
    assert.isUndefined(normalizeAttachmentContentHash("not-a-hash"));
  });

  it("normalizePaperContextRefs should filter invalid entries and dedupe", function () {
    const rows = normalizePaperContextRefs([
      {
        itemId: 1.9,
        contextItemId: "2",
        title: "  Paper A  ",
        citationKey: " KeyA ",
      },
      {
        itemId: 1,
        contextItemId: 2,
        title: "Paper A duplicate",
      },
      {
        itemId: -1,
        contextItemId: 3,
        title: "Invalid",
      },
      {
        itemId: 4,
        contextItemId: 5,
        title: "",
      },
    ]);

    assert.lengthOf(rows, 1);
    assert.deepEqual(rows[0], {
      itemId: 1,
      contextItemId: 2,
      title: "Paper A",
      citationKey: "KeyA",
      firstCreator: undefined,
      year: undefined,
    });
  });

  it("normalizePaperContextRefs should support custom sanitizer", function () {
    const rows = normalizePaperContextRefs(
      [{ itemId: 2, contextItemId: 3, title: "A\u0007B" }],
      { sanitizeText: (value) => value.replace(/\u0007/g, "") },
    );
    assert.lengthOf(rows, 1);
    assert.equal(rows[0].title, "AB");
  });
});
