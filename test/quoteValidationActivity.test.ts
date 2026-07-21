import { assert } from "chai";
import {
  beginQuoteNavigationActivity,
  isQuoteValidationPreempted,
  noteQuoteValidationUserActivity,
  resetQuoteValidationActivityForTests,
} from "../src/modules/contextPanel/quoteValidationActivity";

describe("quoteValidationActivity", function () {
  beforeEach(function () {
    resetQuoteValidationActivityForTests();
  });

  afterEach(function () {
    resetQuoteValidationActivityForTests();
  });

  it("preempts validation for the full citation-navigation lifetime", function () {
    const endFirst = beginQuoteNavigationActivity();
    const endSecond = beginQuoteNavigationActivity();

    assert.isTrue(isQuoteValidationPreempted(Number.MAX_SAFE_INTEGER));
    endFirst();
    assert.isTrue(isQuoteValidationPreempted(Number.MAX_SAFE_INTEGER));
    endSecond();
    assert.isFalse(isQuoteValidationPreempted(Number.MAX_SAFE_INTEGER));
  });

  it("makes navigation cleanup idempotent", function () {
    const end = beginQuoteNavigationActivity();
    end();
    end();

    assert.isFalse(isQuoteValidationPreempted(Number.MAX_SAFE_INTEGER));
  });

  it("honors the requested user-interaction grace period", function () {
    const originalNow = Date.now;
    Date.now = () => 1_000;
    try {
      noteQuoteValidationUserActivity(500);
      assert.isTrue(isQuoteValidationPreempted(1_499));
      assert.isFalse(isQuoteValidationPreempted(1_500));
    } finally {
      Date.now = originalNow;
    }
  });
});
