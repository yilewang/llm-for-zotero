import { assert } from "chai";
import { describe, it } from "mocha";
import {
  buildSeededConversationHandover,
  buildSeededConversationMessages,
  buildSeededConversationTitleSeed,
  normalizeSeededTurns,
  seededConversationNeedsHandover,
  seedPaperConversationRefusal,
} from "../src/modules/contextPanel/seededConversation";
import type { SelectedTextContext } from "../src/shared/types";

const selection: SelectedTextContext = {
  text: "A familiar stimulus drifts at a smaller rate.",
  source: "pdf",
  contextItemId: 41,
  pageIndex: 3,
  pageLabel: "4",
  paperContext: {
    itemId: 40,
    contextItemId: 41,
    title: "Drift paper",
  },
};

describe("seededConversation", function () {
  it("keeps finished question-answer pairs only", function () {
    assert.deepEqual(
      normalizeSeededTurns([
        { role: "user", text: "  Q1  " },
        { role: "assistant", text: "A1" },
        // A question whose answer failed or never came is dropped.
        { role: "user", text: "Q2" },
        { role: "assistant", text: "   " },
        { role: "user", text: "Q3" },
        { role: "assistant", text: "A3" },
        { role: "user", text: "Q4" },
      ]),
      [
        { role: "user", text: "Q1" },
        { role: "assistant", text: "A1" },
        { role: "user", text: "Q3" },
        { role: "assistant", text: "A3" },
      ],
    );
    assert.deepEqual(normalizeSeededTurns([]), []);
    assert.deepEqual(
      normalizeSeededTurns([{ role: "assistant", text: "orphan" }]),
      [],
    );
  });

  it("maps turns to stored messages in order, with the selection on the first question only", function () {
    const messages = buildSeededConversationMessages(
      {
        selectedTextContext: selection,
        turns: [
          {
            role: "user",
            text: "Explain this passage in plain language, using the context of the paper.",
          },
          { role: "assistant", text: "It drifts **slowly**." },
          { role: "user", text: "Why slower?" },
          { role: "assistant", text: "Familiarity." },
        ],
        model: {
          name: "model-x",
          entryId: "entry-x",
          providerLabel: "Provider X",
        },
      },
      10_000,
    );
    assert.deepEqual(
      messages.map((message) => [message.role, message.text]),
      [
        [
          "user",
          "Explain this passage in plain language, using the context of the paper.",
        ],
        ["assistant", "It drifts **slowly**."],
        ["user", "Why slower?"],
        ["assistant", "Familiarity."],
      ],
    );
    // Distinct, increasing, and never after "now": a send right after the
    // seed must sort below them.
    assert.deepEqual(
      messages.map((message) => message.timestamp),
      [9_997, 9_998, 9_999, 10_000],
    );
    assert.deepEqual(messages[0].selectedTextContexts, [selection]);
    assert.notStrictEqual(
      messages[0].selectedTextContexts![0],
      selection,
      "the stored context is a copy",
    );
    for (const message of messages.slice(1)) {
      assert.isUndefined(message.selectedTextContexts);
    }
    for (const message of messages) {
      assert.equal(message.runMode, "chat");
      if (message.role === "assistant") {
        assert.equal(message.modelName, "model-x");
        assert.equal(message.modelEntryId, "entry-x");
        assert.equal(message.modelProviderLabel, "Provider X");
      } else {
        assert.isUndefined(message.modelName);
      }
    }
  });

  it("drops unfinished turns before mapping and leaves out an absent model", function () {
    const messages = buildSeededConversationMessages(
      {
        selectedTextContext: selection,
        turns: [
          { role: "user", text: "Q1" },
          { role: "assistant", text: "A1" },
          { role: "user", text: "Q2" },
        ],
      },
      500,
    );
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.isUndefined(messages[1].modelName);
    assert.isUndefined(messages[1].modelProviderLabel);
  });

  it("titles the chat by its first question, as a typed first message would", function () {
    assert.equal(
      buildSeededConversationTitleSeed([
        { role: "user", text: "  What\ndoes   drift mean?  " },
        { role: "assistant", text: "Slow change." },
      ]),
      "What does drift mean?",
    );
    assert.equal(buildSeededConversationTitleSeed([]), "");
  });

  it("hands the turns over only where the provider keeps its own session", function () {
    assert.isTrue(seededConversationNeedsHandover("claude_code"));
    assert.isTrue(seededConversationNeedsHandover("codex"));
    assert.isFalse(seededConversationNeedsHandover("upstream"));
  });

  it("writes the handover as the side chat transcript of the turns", function () {
    assert.equal(
      buildSeededConversationHandover([
        { role: "user", text: "Q1" },
        { role: "assistant", text: "A1" },
        { role: "user", text: "Q2" },
      ]),
      "Q: Q1\n\nA: A1",
    );
  });
});

describe("seedPaperConversationRefusal", function () {
  const ready = {
    panelAlive: true,
    noteSession: false,
    runtimeSwitchInFlight: false,
    webChat: false,
    answering: false,
  };

  it("lets a ready panel take the turns", function () {
    assert.isNull(seedPaperConversationRefusal(ready));
  });

  it("refuses while the panel's conversation is answering", function () {
    assert.equal(
      seedPaperConversationRefusal({ ...ready, answering: true }),
      "busy",
    );
  });

  it("refuses WebChat, and a panel that cannot open a paper chat now", function () {
    assert.equal(
      seedPaperConversationRefusal({ ...ready, webChat: true }),
      "webchat",
    );
    for (const state of [
      { panelAlive: false },
      { noteSession: true },
      { runtimeSwitchInFlight: true },
    ]) {
      assert.equal(
        seedPaperConversationRefusal({ ...ready, ...state, answering: true }),
        "unavailable",
        JSON.stringify(state),
      );
    }
  });
});
