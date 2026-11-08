import { assert } from "chai";
import { describe, it } from "mocha";
import { normalizeCodexHomePath } from "../src/utils/codexHomePref";

describe("normalizeCodexHomePath", function () {
  const macHome = () => "/Users/me";
  const winHome = () => "C:\\Users\\me";

  it("keeps a plain path and an empty value as typed", function () {
    assert.equal(
      normalizeCodexHomePath("  /Users/me/Codex Zotero ", macHome),
      "/Users/me/Codex Zotero",
    );
    assert.equal(normalizeCodexHomePath("   ", macHome), "");
  });

  it("drops one pair of surrounding quotes", function () {
    assert.equal(
      normalizeCodexHomePath('"C:\\Users\\me\\codex work"', winHome),
      "C:\\Users\\me\\codex work",
    );
    assert.equal(
      normalizeCodexHomePath("'/Users/me/codex work'", macHome),
      "/Users/me/codex work",
    );
    assert.equal(
      normalizeCodexHomePath("\"/Users/me/codex'", macHome),
      "\"/Users/me/codex'",
    );
  });

  it("expands a leading ~ to the home folder", function () {
    assert.equal(normalizeCodexHomePath("~", macHome), "/Users/me");
    assert.equal(
      normalizeCodexHomePath("~/codex zotero", macHome),
      "/Users/me/codex zotero",
    );
    assert.equal(
      normalizeCodexHomePath('"~\\codex"', winHome),
      "C:\\Users\\me\\codex",
    );
    assert.equal(
      normalizeCodexHomePath("~other/codex", macHome),
      "~other/codex",
    );
    assert.equal(
      normalizeCodexHomePath("~/codex", () => ""),
      "~/codex",
    );
  });

  it("gives a Windows drive path backslashes", function () {
    assert.equal(
      normalizeCodexHomePath("C:/Users/me/codex/", winHome),
      "C:\\Users\\me\\codex",
    );
  });
});
