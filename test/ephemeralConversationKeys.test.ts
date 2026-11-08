import { assert } from "chai";
import {
  EPHEMERAL_GLOBAL_CONVERSATION_KEY_BASE,
  EPHEMERAL_PAPER_CONVERSATION_KEY_BASE,
  UPSTREAM_GLOBAL_ALLOCATED_CONVERSATION_KEY_BASE,
  UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
  UPSTREAM_PAPER_CONVERSATION_KEY_BASE,
  UPSTREAM_RUNTIME_CONVERSATION_KEY_END,
  allocateEphemeralGlobalConversationKey,
  allocateEphemeralPaperConversationKey,
  capAllocationRangeEndBelowEphemeralBand,
  classifyConversationKey,
  isEphemeralConversationKey,
} from "../src/shared/conversationKeySpace";

describe("ephemeral conversation key band", function () {
  it("sits at the top of the upstream paper and global ranges", function () {
    assert.isAbove(
      EPHEMERAL_PAPER_CONVERSATION_KEY_BASE,
      UPSTREAM_PAPER_CONVERSATION_KEY_BASE,
    );
    assert.isBelow(
      EPHEMERAL_PAPER_CONVERSATION_KEY_BASE,
      UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
    );
    assert.isAbove(
      EPHEMERAL_GLOBAL_CONVERSATION_KEY_BASE,
      UPSTREAM_GLOBAL_ALLOCATED_CONVERSATION_KEY_BASE,
    );
    assert.isBelow(
      EPHEMERAL_GLOBAL_CONVERSATION_KEY_BASE,
      UPSTREAM_RUNTIME_CONVERSATION_KEY_END,
    );
  });

  it("keeps the upstream classification of band keys", function () {
    assert.deepEqual(
      classifyConversationKey(EPHEMERAL_PAPER_CONVERSATION_KEY_BASE),
      { system: "upstream", kind: "paper" },
    );
    assert.deepEqual(
      classifyConversationKey(UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE - 1),
      { system: "upstream", kind: "paper" },
    );
    assert.deepEqual(
      classifyConversationKey(EPHEMERAL_GLOBAL_CONVERSATION_KEY_BASE),
      { system: "upstream", kind: "global" },
    );
    assert.deepEqual(
      classifyConversationKey(UPSTREAM_RUNTIME_CONVERSATION_KEY_END - 1),
      { system: "upstream", kind: "global" },
    );
  });

  it("recognizes exactly the band keys", function () {
    assert.isTrue(
      isEphemeralConversationKey(EPHEMERAL_PAPER_CONVERSATION_KEY_BASE),
    );
    assert.isTrue(
      isEphemeralConversationKey(UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE - 1),
    );
    assert.isTrue(
      isEphemeralConversationKey(EPHEMERAL_GLOBAL_CONVERSATION_KEY_BASE),
    );
    assert.isTrue(
      isEphemeralConversationKey(UPSTREAM_RUNTIME_CONVERSATION_KEY_END - 1),
    );
    for (const key of [
      0,
      -1,
      Number.NaN,
      1,
      123456,
      UPSTREAM_PAPER_CONVERSATION_KEY_BASE,
      EPHEMERAL_PAPER_CONVERSATION_KEY_BASE - 1,
      UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
      UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 1,
      UPSTREAM_GLOBAL_ALLOCATED_CONVERSATION_KEY_BASE,
      EPHEMERAL_GLOBAL_CONVERSATION_KEY_BASE - 1,
      UPSTREAM_RUNTIME_CONVERSATION_KEY_END,
      UPSTREAM_RUNTIME_CONVERSATION_KEY_END + 1,
    ]) {
      assert.isFalse(isEphemeralConversationKey(key), String(key));
    }
  });

  it("allocates distinct in-band keys of the requested kind", function () {
    const paperA = allocateEphemeralPaperConversationKey();
    const paperB = allocateEphemeralPaperConversationKey();
    const globalA = allocateEphemeralGlobalConversationKey();
    const globalB = allocateEphemeralGlobalConversationKey();
    assert.notEqual(paperA, paperB);
    assert.notEqual(globalA, globalB);
    for (const key of [paperA, paperB]) {
      assert.isTrue(isEphemeralConversationKey(key));
      assert.deepEqual(classifyConversationKey(key), {
        system: "upstream",
        kind: "paper",
      });
    }
    for (const key of [globalA, globalB]) {
      assert.isTrue(isEphemeralConversationKey(key));
      assert.deepEqual(classifyConversationKey(key), {
        system: "upstream",
        kind: "global",
      });
    }
  });

  it("starts the in-memory counters inside the band, away from its base", function () {
    // The counters start at a random offset below 50_000_000 each session.
    const paper = allocateEphemeralPaperConversationKey();
    const global = allocateEphemeralGlobalConversationKey();
    assert.isAtLeast(paper, EPHEMERAL_PAPER_CONVERSATION_KEY_BASE);
    assert.isBelow(
      paper,
      EPHEMERAL_PAPER_CONVERSATION_KEY_BASE + 50_000_000 + 1_000_000,
    );
    assert.isAtLeast(global, EPHEMERAL_GLOBAL_CONVERSATION_KEY_BASE);
    assert.isBelow(
      global,
      EPHEMERAL_GLOBAL_CONVERSATION_KEY_BASE + 50_000_000 + 1_000_000,
    );
  });

  it("caps real upstream allocation ranges below the band", function () {
    assert.equal(
      capAllocationRangeEndBelowEphemeralBand(
        UPSTREAM_PAPER_CONVERSATION_KEY_BASE,
        UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
      ),
      EPHEMERAL_PAPER_CONVERSATION_KEY_BASE,
    );
    assert.equal(
      capAllocationRangeEndBelowEphemeralBand(
        UPSTREAM_GLOBAL_ALLOCATED_CONVERSATION_KEY_BASE,
        UPSTREAM_RUNTIME_CONVERSATION_KEY_END,
      ),
      EPHEMERAL_GLOBAL_CONVERSATION_KEY_BASE,
    );
    // Ranges that do not reach the band are unchanged.
    assert.equal(capAllocationRangeEndBelowEphemeralBand(1, 1000), 1000);
    const codexStart = 6_000_000_000_000_000;
    assert.equal(
      capAllocationRangeEndBelowEphemeralBand(codexStart, codexStart + 10),
      codexStart + 10,
    );
  });
});
