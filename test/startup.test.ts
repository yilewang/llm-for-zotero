import { assert } from "chai";
import { config } from "../package.json";

describe("startup", function () {
  it("should have plugin instance defined", function () {
    const Zotero = (globalThis as typeof globalThis & { Zotero?: Record<string, unknown> }).Zotero;
    if (!Zotero) this.skip();
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });
});
