import { assert } from "chai";
import { describe, it } from "mocha";
import { buildAgentInitialMessages } from "../src/agent/model/messageBuilder";
import { SIDECHAT_SELECTED_TEXT_MAX_LENGTH } from "../src/modules/contextPanel/constants";
import { SIDE_CHAT_OMITTED_MARKER } from "../src/modules/contextPanel/sideChatContext";
import type { StoredChatMessage } from "../src/utils/chatStore";
import { getSelectedTextSourceIconName } from "../src/modules/contextPanel/contextIcons";
import {
  buildQuestionWithSelectedTextContexts,
  normalizeSelectedText,
} from "../src/modules/contextPanel/textUtils";
import { normalizeSelectedTextSource } from "../src/services/context/normalizers";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import {
  buildSeededConversationHandover,
  INLINE_ASK_OMITTED_MARKER,
  SEEDED_CONVERSATION_HANDOVER_SOURCE,
  storeSeededConversation,
  type SeededConversationStore,
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

  it("hands the turns over only where a new provider session gets no stored history", function () {
    // Claude Code starts a fresh session with the typed message only.
    assert.isTrue(seededConversationNeedsHandover("claude_code"));
    // Codex app-server injects the stored messages into a new thread, and a
    // plain API chat sends them as history: a chip would repeat them.
    assert.isFalse(seededConversationNeedsHandover("codex"));
    assert.isFalse(seededConversationNeedsHandover("upstream"));
  });

  it("starts the handover with the paper, page and passage, then the turns", function () {
    assert.equal(
      buildSeededConversationHandover({
        selectedTextContext: selection,
        turns: [
          { role: "user", text: "Q1" },
          { role: "assistant", text: "A1" },
          { role: "user", text: "Q2" },
        ],
      }),
      [
        "Paper: Drift paper",
        "Page: 4",
        "Selected passage:",
        "A familiar stimulus drifts at a smaller rate.",
        "",
        "Q: Q1",
        "",
        "A: A1",
      ].join("\n"),
    );
  });

  it("names the page by its index when Zotero gave no label, and skips an unknown paper", function () {
    const text = buildSeededConversationHandover({
      selectedTextContext: {
        text: "Passage",
        source: "pdf",
        contextItemId: 41,
        pageIndex: 6,
      },
      turns: [
        { role: "user", text: "Q1" },
        { role: "assistant", text: "A1" },
      ],
    });
    assert.equal(
      text,
      [
        "Page: 7",
        "Selected passage:",
        "Passage",
        "",
        "Q: Q1",
        "",
        "A: A1",
      ].join("\n"),
    );
  });

  it("keeps the passage and the newest turns under the cap, with an Inline Ask marker", function () {
    const turns = Array.from({ length: 40 }, (_, index) => [
      { role: "user" as const, text: `Q${index} ${"q".repeat(400)}` },
      { role: "assistant" as const, text: `A${index} ${"a".repeat(800)}` },
    ]).flat();
    const text = buildSeededConversationHandover({
      selectedTextContext: selection,
      turns,
    });
    assert.isAtMost(text.length, SIDECHAT_SELECTED_TEXT_MAX_LENGTH);
    assert.isTrue(text.startsWith("Paper: Drift paper\nPage: 4\n"));
    assert.include(text, selection.text);
    assert.include(text, INLINE_ASK_OMITTED_MARKER);
    assert.notInclude(text, SIDE_CHAT_OMITTED_MARKER);
    assert.include(text, "A39 ");
    assert.notInclude(text, "Q0 ");
    assert.equal(
      normalizeSelectedText(text, "inlineask"),
      text,
      "the chip keeps the whole handover",
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

describe("Inline Ask handover chip source", function () {
  const transcript = "Q: one\n\nA: two\r\nthree";

  it("is its own source, not the side chat's", function () {
    assert.equal(SEEDED_CONVERSATION_HANDOVER_SOURCE, "inlineask");
    assert.equal(normalizeSelectedTextSource("inlineask"), "inlineask");
    assert.equal(getSelectedTextSourceIconName("inlineask"), "model");
  });

  it("keeps line breaks and the transcript cap", function () {
    assert.equal(
      normalizeSelectedText(transcript, "inlineask"),
      "Q: one\n\nA: two\nthree",
    );
    const long = "z".repeat(SIDECHAT_SELECTED_TEXT_MAX_LENGTH + 50);
    assert.lengthOf(
      normalizeSelectedText(long, "inlineask"),
      SIDECHAT_SELECTED_TEXT_MAX_LENGTH,
    );
  });

  it("is named an Inline Ask transcript for the model", async function () {
    const prompt = buildQuestionWithSelectedTextContexts(
      ["Q: one\n\nA: two"],
      ["inlineask"],
      "Go on.",
    );
    assert.include(prompt, "inline_ask_transcript");
    assert.notInclude(prompt, "side_chat_transcript");

    const messages = await buildAgentInitialMessages(
      resolvedAgentRequest({
        conversationKey: 30401,
        mode: "agent",
        userText: "Go on.",
        libraryID: 1,
        selectedTexts: ["Q: one\n\nA: two"],
        selectedTextSources: ["inlineask"],
      }),
      [],
      [],
    );
    const text = JSON.stringify(messages);
    assert.include(text, "Inline Ask transcript");
    assert.notInclude(text, "side chat transcript");
  });
});

describe("storeSeededConversation", function () {
  const messages: StoredChatMessage[] = [
    { role: "user", text: "Q1", timestamp: 101 },
    { role: "assistant", text: "A1", timestamp: 102 },
    { role: "user", text: "Q2", timestamp: 103 },
    { role: "assistant", text: "A2", timestamp: 104 },
  ];

  /** An in-memory draft that starts empty. */
  function fakeStore(
    options: {
      failWriteAt?: number;
      dropWriteAt?: number;
      failTitle?: boolean;
    } = {},
  ) {
    const rows: StoredChatMessage[] = [];
    const titles: string[] = [];
    const deletions: Array<[number, number]> = [];
    let writes = 0;
    const store: SeededConversationStore = {
      writeMessage: async (message) => {
        const index = writes++;
        if (index === options.failWriteAt) throw new Error("disk full");
        // A frozen conversation drops a write without an error.
        if (index === options.dropWriteAt) return;
        rows.push(message);
      },
      countMessages: async () => rows.length,
      deleteTurn: async (userTimestamp, assistantTimestamp) => {
        deletions.push([userTimestamp, assistantTimestamp]);
        for (const [role, timestamp] of [
          ["user", userTimestamp],
          ["assistant", assistantTimestamp],
        ] as const) {
          const index = rows.findIndex(
            (row) => row.role === role && row.timestamp === timestamp,
          );
          if (index >= 0) rows.splice(index, 1);
        }
      },
      setTitle: async (title) => {
        if (options.failTitle) throw new Error("title write failed");
        titles.push(title);
      },
    };
    return { store, rows, titles, deletions };
  }

  it("stores the messages, then the title", async function () {
    const fake = fakeStore();
    const result = await storeSeededConversation(fake.store, messages, "Q1");
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(
      fake.rows.map((row) => row.text),
      ["Q1", "A1", "Q2", "A2"],
    );
    assert.deepEqual(fake.titles, ["Q1"]);
    assert.isEmpty(fake.deletions);
  });

  it("removes the rows it wrote when a later write fails, leaving the draft empty", async function () {
    const fake = fakeStore({ failWriteAt: 2 });
    const result = await storeSeededConversation(fake.store, messages, "Q1");
    assert.deepEqual(result, { ok: false });
    assert.isEmpty(fake.rows, "no orphan rows stay in the draft");
    assert.isEmpty(fake.titles, "a failed seed gets no title");
    // Only the pairs this call wrote (or tried to write) are deleted.
    assert.deepEqual(fake.deletions, [
      [101, 102],
      [103, 104],
    ]);
  });

  it("removes the rows it wrote when the stored count is wrong", async function () {
    const fake = fakeStore({ dropWriteAt: 1 });
    const result = await storeSeededConversation(fake.store, messages, "Q1");
    assert.deepEqual(result, { ok: false });
    assert.isEmpty(fake.rows);
    assert.isEmpty(fake.titles);
  });

  it("succeeds when only the title fails, so a retry cannot store a second copy", async function () {
    const fake = fakeStore({ failTitle: true });
    const result = await storeSeededConversation(fake.store, messages, "Q1");
    assert.deepEqual(result, { ok: true });
    assert.lengthOf(fake.rows, 4);
    assert.isEmpty(fake.deletions);
  });

  it("reports failure, not an exception, when the clean-up also fails", async function () {
    const fake = fakeStore({ failWriteAt: 1 });
    fake.store.deleteTurn = async () => {
      throw new Error("delete failed");
    };
    const result = await storeSeededConversation(fake.store, messages, "Q1");
    assert.deepEqual(result, { ok: false });
  });
});
