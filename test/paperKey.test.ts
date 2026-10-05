import { assert } from "chai";
import { ownerScopedPaperKey, paperKey } from "../src/shared/paperKey";
import { buildPaperKey } from "../src/services/paperContent/pdfContext";
import { buildPinnedPaperKey } from "../src/modules/contextPanel/setupHandlers/controllers/pinnedContextController";

describe("paperKey", function () {
  it("joins the floored item and context item ids", function () {
    assert.equal(paperKey({ itemId: 3, contextItemId: 4 }), "3:4");
    assert.equal(paperKey({ itemId: 3.9, contextItemId: 4.2 }), "3:4");
    assert.equal(paperKey({ itemId: 0, contextItemId: -1.5 }), "0:-2");
  });

  it("prefixes the owner id without flooring it", function () {
    assert.equal(
      ownerScopedPaperKey(12, { itemId: 3, contextItemId: 4 }),
      "12:3:4",
    );
    assert.equal(
      ownerScopedPaperKey(12.5, { itemId: 3.9, contextItemId: 4 }),
      "12.5:3:4",
    );
  });

  it("is the key that pdfContext and the pinned-context controller build", function () {
    const ref = { itemId: 11.7, contextItemId: 12.2, title: "T" };
    assert.equal(buildPaperKey(ref), "11:12");
    assert.equal(buildPinnedPaperKey(ref), "11:12");
    assert.equal(paperKey(ref), "11:12");
  });
});
