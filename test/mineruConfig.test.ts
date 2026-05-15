import { assert } from "chai";
import {
  buildMineruFilenameMatcher,
  DEFAULT_MINERU_MAX_AUTO_PAGES,
  DEFAULT_MINERU_LOCAL_API_BASE,
  MAX_MINERU_FILENAME_PATTERN_LENGTH,
  normalizeMineruMaxAutoPages,
  normalizeMineruLocalApiBase,
  normalizeMineruLocalBackend,
  normalizeMineruMode,
  toMineruApiBackend,
} from "../src/utils/mineruConfig";

describe("mineruConfig", function () {
  it("uses 100 as the default automatic page limit", function () {
    assert.equal(DEFAULT_MINERU_MAX_AUTO_PAGES, 100);
  });

  describe("normalizeMineruMode", function () {
    it("accepts local and otherwise falls back to cloud", function () {
      assert.equal(normalizeMineruMode("local"), "local");
      assert.equal(normalizeMineruMode("cloud"), "cloud");
      assert.equal(normalizeMineruMode("community"), "cloud");
      assert.equal(normalizeMineruMode(undefined), "cloud");
    });
  });

  describe("normalizeMineruLocalApiBase", function () {
    it("trims and removes trailing slashes", function () {
      assert.equal(
        normalizeMineruLocalApiBase(" http://127.0.0.1:8000/ "),
        "http://127.0.0.1:8000",
      );
      assert.equal(
        normalizeMineruLocalApiBase("https://mineru.local/api///"),
        "https://mineru.local/api",
      );
      assert.equal(
        normalizeMineruLocalApiBase("https://mineru.local/api/?debug=1#top"),
        "https://mineru.local/api",
      );
    });

    it("falls back to the default for empty or unsupported URLs", function () {
      assert.equal(
        normalizeMineruLocalApiBase(""),
        DEFAULT_MINERU_LOCAL_API_BASE,
      );
      assert.equal(
        normalizeMineruLocalApiBase("file:///tmp/mineru"),
        DEFAULT_MINERU_LOCAL_API_BASE,
      );
      assert.equal(
        normalizeMineruLocalApiBase("http://"),
        DEFAULT_MINERU_LOCAL_API_BASE,
      );
    });
  });

  describe("normalizeMineruLocalBackend", function () {
    it("accepts the three valid backend codes", function () {
      assert.equal(normalizeMineruLocalBackend("pipeline"), "pipeline");
      assert.equal(normalizeMineruLocalBackend("vlm"), "vlm");
      assert.equal(normalizeMineruLocalBackend("hybrid"), "hybrid");
    });

    it("falls back to pipeline for unknown or empty values", function () {
      assert.equal(normalizeMineruLocalBackend(""), "pipeline");
      assert.equal(normalizeMineruLocalBackend(undefined), "pipeline");
      assert.equal(normalizeMineruLocalBackend("vlm-auto-engine"), "pipeline");
    });
  });

  describe("toMineruApiBackend", function () {
    it("maps short codes to MinerU API backend values", function () {
      assert.equal(toMineruApiBackend("pipeline"), "pipeline");
      assert.equal(toMineruApiBackend("vlm"), "vlm-auto-engine");
      assert.equal(toMineruApiBackend("hybrid"), "hybrid-auto-engine");
    });
  });

  describe("normalizeMineruMaxAutoPages", function () {
    it("accepts positive page limits and floors decimals", function () {
      assert.equal(normalizeMineruMaxAutoPages("100"), 100);
      assert.equal(normalizeMineruMaxAutoPages(100.9), 100);
    });

    it("falls back to the default for empty, zero, or invalid values", function () {
      assert.equal(
        normalizeMineruMaxAutoPages(""),
        DEFAULT_MINERU_MAX_AUTO_PAGES,
      );
      assert.equal(
        normalizeMineruMaxAutoPages("0"),
        DEFAULT_MINERU_MAX_AUTO_PAGES,
      );
      assert.equal(
        normalizeMineruMaxAutoPages(0),
        DEFAULT_MINERU_MAX_AUTO_PAGES,
      );
      assert.equal(
        normalizeMineruMaxAutoPages(undefined),
        DEFAULT_MINERU_MAX_AUTO_PAGES,
      );
      assert.equal(
        normalizeMineruMaxAutoPages(false),
        DEFAULT_MINERU_MAX_AUTO_PAGES,
      );
      assert.equal(
        normalizeMineruMaxAutoPages("not a number"),
        DEFAULT_MINERU_MAX_AUTO_PAGES,
      );
    });
  });

  describe("buildMineruFilenameMatcher", function () {
    it("matches plain substring patterns case-insensitively", function () {
      const matcher = buildMineruFilenameMatcher(["_translated"]);
      assert.isTrue(matcher.matches("Paper_TRANSLATED.pdf"));
      assert.isFalse(matcher.matches("paper-original.pdf"));
    });

    it("matches regex patterns case-insensitively", function () {
      const matcher = buildMineruFilenameMatcher(["/\\btranslat(ed|ion)\\b/"]);
      assert.isTrue(matcher.matches("Machine Translation.pdf"));
      assert.isTrue(matcher.matches("paper translated.pdf"));
      assert.isFalse(matcher.matches("paper transform.pdf"));
    });

    it("ignores invalid regex patterns", function () {
      const matcher = buildMineruFilenameMatcher(["/[invalid/"]);
      assert.isFalse(matcher.matches("invalid.pdf"));
    });

    it("ignores overly long patterns", function () {
      const matcher = buildMineruFilenameMatcher([
        "x".repeat(MAX_MINERU_FILENAME_PATTERN_LENGTH + 1),
      ]);
      assert.isFalse(matcher.matches("x".repeat(20)));
    });
  });
});
