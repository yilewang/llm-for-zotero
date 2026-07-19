import { assert } from "chai";
import { describe, it } from "mocha";
import { shouldCompactHeaderClearButton } from "../src/modules/contextPanel/headerClearPresentation";

describe("responsive header Clear button", function () {
  it("keeps the full label when both header groups fit", function () {
    assert.isFalse(
      shouldCompactHeaderClearButton({
        headerRight: 700,
        leftContentRight: 360,
        actionsLeft: 390,
        actionsRight: 690,
      }),
    );
  });

  it("uses the icon when the full label intersects the runtime group", function () {
    assert.isTrue(
      shouldCompactHeaderClearButton({
        headerRight: 320,
        leftContentRight: 220,
        actionsLeft: 218,
        actionsRight: 316,
      }),
    );
  });

  it("uses the icon when the full action group overflows the header", function () {
    assert.isTrue(
      shouldCompactHeaderClearButton({
        headerRight: 320,
        leftContentRight: 180,
        actionsLeft: 200,
        actionsRight: 326,
      }),
    );
  });
});
