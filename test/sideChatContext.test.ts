import { assert } from "chai";
import {
  MAIN_CHAT_BACKGROUND_CONTEXT_MAX_LENGTH,
  SIDECHAT_SELECTED_TEXT_MAX_LENGTH,
  SELECTED_TEXT_MAX_LENGTH,
} from "../src/modules/contextPanel/constants";
import {
  buildMainChatBackgroundContext,
  buildSideChatTranscriptContext,
  MAIN_CHAT_OMITTED_MARKER,
  SIDE_CHAT_OMITTED_MARKER,
} from "../src/modules/contextPanel/sideChatContext";
import { normalizeSelectedText } from "../src/modules/contextPanel/textUtils";
import { normalizeSelectedTextSource } from "../src/services/context/normalizers";

type Turn = {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  compactMarker?: boolean;
};

const turns: Turn[] = [
  { role: "user", text: "What is the main claim?" },
  { role: "assistant", text: "The paper claims X.\nIt shows Y." },
  { role: "user", text: "   " },
  { role: "assistant", text: "" },
  { role: "user", text: "And the method?" },
  { role: "assistant", text: "partial answer", streaming: true },
];

describe("side chat context builders", function () {
  it("writes Q:/A: lines and skips empty and streaming messages", function () {
    assert.equal(
      buildSideChatTranscriptContext(turns),
      [
        "Q: What is the main claim?",
        "A: The paper claims X.\nIt shows Y.",
        "Q: And the method?",
      ].join("\n\n"),
    );
    assert.equal(
      buildMainChatBackgroundContext(turns),
      buildSideChatTranscriptContext(turns),
    );
  });

  it("skips compaction markers", function () {
    assert.equal(
      buildSideChatTranscriptContext([
        {
          role: "assistant",
          text: "Conversation compacted",
          compactMarker: true,
        },
        { role: "user", text: "Hi" },
      ]),
      "Q: Hi",
    );
  });

  it("returns an empty string when nothing is left", function () {
    assert.equal(buildSideChatTranscriptContext([]), "");
    assert.equal(
      buildMainChatBackgroundContext([{ role: "user", text: " " }]),
      "",
    );
  });

  it("keeps the newest turns when truncating, behind a leading marker", function () {
    const many: Turn[] = [];
    for (let index = 0; index < 40; index += 1) {
      many.push({ role: "user", text: `question ${index} ${"x".repeat(40)}` });
      many.push({
        role: "assistant",
        text: `answer ${index} ${"y".repeat(40)}`,
      });
    }
    const cap = 400;
    const side = buildSideChatTranscriptContext(many, cap);
    assert.isAtMost(side.length, cap);
    assert.isTrue(side.startsWith(SIDE_CHAT_OMITTED_MARKER));
    assert.include(side, "answer 39");
    assert.notInclude(side, "question 0 ");
    // The kept text starts at a whole line.
    const afterMarker = side.slice(SIDE_CHAT_OMITTED_MARKER.length).trimStart();
    assert.match(afterMarker, /^(Q|A): /);

    const main = buildMainChatBackgroundContext(many, cap);
    assert.isAtMost(main.length, cap);
    assert.isTrue(main.startsWith(MAIN_CHAT_OMITTED_MARKER));
    assert.include(main, "answer 39");
  });

  it("uses a cap larger than the ordinary selected-text cap", function () {
    assert.isAbove(SIDECHAT_SELECTED_TEXT_MAX_LENGTH, SELECTED_TEXT_MAX_LENGTH);
    assert.isAbove(
      MAIN_CHAT_BACKGROUND_CONTEXT_MAX_LENGTH,
      SELECTED_TEXT_MAX_LENGTH,
    );
    const long: Turn[] = [
      { role: "user", text: "q".repeat(SIDECHAT_SELECTED_TEXT_MAX_LENGTH) },
    ];
    assert.isAtMost(
      buildSideChatTranscriptContext(long).length,
      SIDECHAT_SELECTED_TEXT_MAX_LENGTH,
    );
  });
});

describe("side chat selected-text source", function () {
  it("keeps line breaks and its own larger cap", function () {
    const text = "Q: one\n\nA: two\r\nthree";
    assert.equal(
      normalizeSelectedText(text, "sidechat"),
      "Q: one\n\nA: two\nthree",
    );
    const long = "z".repeat(SIDECHAT_SELECTED_TEXT_MAX_LENGTH + 50);
    assert.equal(
      normalizeSelectedText(long, "sidechat").length,
      SIDECHAT_SELECTED_TEXT_MAX_LENGTH,
    );
    assert.equal(
      normalizeSelectedText(long, "model").length,
      SELECTED_TEXT_MAX_LENGTH,
    );
  });

  it("survives source normalization", function () {
    assert.equal(normalizeSelectedTextSource("sidechat"), "sidechat");
  });
});
