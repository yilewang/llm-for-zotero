import { assert } from "chai";
import {
  DEFAULT_MINERU_LOCAL_API_BASE,
  normalizeMineruLocalApiBase,
  normalizeMineruLocalBackend,
  normalizeMineruMode,
  toMineruApiBackend,
} from "../src/utils/mineruConfig";

describe("mineruConfig", function () {
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
});
