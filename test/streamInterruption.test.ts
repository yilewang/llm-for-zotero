import { assert } from "chai";
import {
  getStreamInterruptionLabel,
  resolveStreamInterruptionOutcome,
} from "../src/modules/contextPanel/streamInterruption";
import { createBlockStreamCoalescer } from "../src/modules/contextPanel/blockStreamCoalescer";

describe("streamInterruption", function () {
  it("preserves partial text and marks the message interrupted when content streamed", function () {
    const outcome = resolveStreamInterruptionOutcome({
      partialText: "Here is the first half of the answer",
      errorMessage: "Error in input stream",
      retryHint: "",
    });

    assert.equal(outcome.text, "Here is the first half of the answer");
    assert.isTrue(outcome.interrupted);
  });

  it("does not mix the error text into the preserved partial content", function () {
    const outcome = resolveStreamInterruptionOutcome({
      partialText: "partial answer",
      errorMessage: "Error in input stream",
      retryHint: " (add credits)",
    });

    assert.equal(outcome.text, "partial answer");
    assert.notInclude(outcome.text, "Error in input stream");
    assert.notInclude(outcome.text, "add credits");
  });

  it("falls back to a bare error message when nothing streamed", function () {
    const outcome = resolveStreamInterruptionOutcome({
      partialText: "",
      errorMessage: "Error in input stream",
      retryHint: "",
    });

    assert.equal(outcome.text, "Error: Error in input stream");
    assert.isFalse(outcome.interrupted);
  });

  it("includes the retry hint in the bare error fallback", function () {
    const outcome = resolveStreamInterruptionOutcome({
      partialText: "",
      errorMessage: "boom",
      retryHint: " — add credits",
    });

    assert.equal(outcome.text, "Error: boom — add credits");
    assert.isFalse(outcome.interrupted);
  });

  it("treats whitespace-only partial text as empty", function () {
    const outcome = resolveStreamInterruptionOutcome({
      partialText: "   \n  ",
      errorMessage: "boom",
    });

    assert.equal(outcome.text, "Error: boom");
    assert.isFalse(outcome.interrupted);
  });

  it("provides a provider-neutral interruption label", function () {
    const label = getStreamInterruptionLabel();

    assert.isString(label);
    assert.isNotEmpty(label);
    assert.notInclude(label.toLowerCase(), "webchat");
  });
});

describe("blockStreamCoalescer interruption invariant", function () {
  it("still returns the full streamed text after cancel()", function () {
    // The mid-stream error recovery relies on getFullText() surviving cancel(),
    // so lock that invariant in: partial content must not be lost on cancel.
    const coalescer = createBlockStreamCoalescer({
      maxWaitMs: 0,
      onBlock: () => undefined,
    });

    coalescer.pushText("streamed ");
    coalescer.pushText("before the drop");
    coalescer.cancel();

    assert.equal(coalescer.getFullText(), "streamed before the drop");
  });
});
