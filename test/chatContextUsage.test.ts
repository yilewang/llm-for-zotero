import { assert } from "chai";
import {
  resolveUsageContextWindow,
  shouldPreserveContextUsageWindow,
  updateContextUsageSnapshotFromProvider,
} from "../src/modules/contextPanel/chat";

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

describe("Codex context gauge snapshots", function () {
  it("uses runtime input tokens and window instead of the 256k model fallback", function () {
    const snapshot = updateContextUsageSnapshotFromProvider({
      conversationKey: 900001,
      usage: {
        promptTokens: 900000,
        completionTokens: 5000,
        totalTokens: 905000,
        contextTokens: 56799,
        contextWindow: 828400,
        contextWindowIsAuthoritative: true,
      },
      fallbackContextWindow: 256000,
      fallbackInputLimitSource: "default",
    });
    assert.equal(snapshot?.contextTokens, 56799);
    assert.equal(snapshot?.contextWindow, 828400);
    assert.equal(snapshot?.source, "provider");
    assert.isFalse(snapshot?.estimated);
    assert.isTrue(shouldPreserveContextUsageWindow(snapshot, true, false));
  });

  it("keeps a saved Codex denominator on reopen without changing explicit caps", function () {
    const persisted = {
      contextTokens: 56799,
      contextWindow: 828400,
      source: "persisted" as const,
      estimated: true,
    };
    assert.isTrue(shouldPreserveContextUsageWindow(persisted, true, false));
    assert.isFalse(shouldPreserveContextUsageWindow(persisted, true, true));
    assert.isFalse(shouldPreserveContextUsageWindow(persisted, false, false));
    assert.isFalse(
      shouldPreserveContextUsageWindow(
        { ...persisted, contextWindow: undefined },
        true,
        false,
      ),
    );
    assert.isFalse(
      shouldPreserveContextUsageWindow(
        { ...persisted, contextWindow: NaN },
        true,
        false,
      ),
    );
  });
});
