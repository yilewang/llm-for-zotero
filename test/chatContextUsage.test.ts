import { assert } from "chai";
import { resolveUsageContextWindow } from "../src/modules/contextPanel/chat";

describe("direct chat context usage denominator", function () {
  it("keeps an explicit input cap after provider usage arrives", function () {
    assert.deepEqual(
      resolveUsageContextWindow({
        providerContextWindow: 128_000,
        providerContextWindowIsAuthoritative: true,
        fallbackContextWindow: 1_000_000,
        fallbackInputLimitSource: "advanced",
      }),
      {
        contextWindow: 1_000_000,
        inputLimitSource: "advanced",
        contextWindowIsAuthoritative: false,
      },
    );
  });

  it("keeps a profile override above provider usage", function () {
    assert.equal(
      resolveUsageContextWindow({
        providerContextWindow: 128_000,
        providerContextWindowIsAuthoritative: true,
        fallbackContextWindow: 750_000,
        fallbackInputLimitSource: "user",
      }).contextWindow,
      750_000,
    );
  });

  it("accepts a provider runtime window when no user limit is set", function () {
    assert.deepEqual(
      resolveUsageContextWindow({
        providerContextWindow: 512_000,
        providerContextWindowIsAuthoritative: true,
        fallbackContextWindow: 256_000,
        fallbackInputLimitSource: "default",
      }),
      {
        contextWindow: 512_000,
        inputLimitSource: "live",
        contextWindowIsAuthoritative: true,
      },
    );
  });
});
