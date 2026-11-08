import { assert } from "chai";
import { EPHEMERAL_PAPER_CONVERSATION_KEY_BASE } from "../src/shared/conversationKeySpace";
import { isToolWithheldForEphemeralRequest } from "../src/agent/tools/registry";
import { canShowLiteratureReview } from "../src/agent/tools/read/reviewLiterature";

describe("isToolWithheldForEphemeralRequest", function () {
  const write = { spec: { executionClass: "external_effect" } } as never;
  const read = { spec: { executionClass: "read" } } as never;
  const ephemeral = { conversationKey: EPHEMERAL_PAPER_CONVERSATION_KEY_BASE };
  const durable = { conversationKey: 1_000_000_001 };

  it("withholds external-effect tools from an ephemeral key only", function () {
    assert.isTrue(isToolWithheldForEphemeralRequest(write, ephemeral));
    assert.isFalse(isToolWithheldForEphemeralRequest(write, durable));
    assert.isFalse(isToolWithheldForEphemeralRequest(read, ephemeral));
  });

  it("withholds the paper selection card from an ephemeral key only", function () {
    // The card reads, but its Import button writes to the library.
    const card = {
      spec: { name: "literature_review", executionClass: "read" },
    } as never;
    assert.isTrue(isToolWithheldForEphemeralRequest(card, ephemeral));
    assert.isFalse(isToolWithheldForEphemeralRequest(card, durable));
  });
});

describe("canShowLiteratureReview", function () {
  it("is false in a temporary side chat, so no paper-finding session opens", function () {
    const context = (conversationKey: number) =>
      ({ request: { conversationKey } }) as never;
    assert.isFalse(
      canShowLiteratureReview(context(EPHEMERAL_PAPER_CONVERSATION_KEY_BASE)),
    );
    assert.isTrue(canShowLiteratureReview(context(1_000_000_001)));
  });
});
