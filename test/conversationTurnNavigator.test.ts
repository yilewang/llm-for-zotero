import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { describe, it } from "mocha";

import {
  buildConversationTurnProjection,
  findActiveConversationTurnIndex,
  getConversationMessageAnchorKey,
  getConversationTurnDashWidth,
  isConversationTurnNavigatorEligible,
  SIDEBAR_TURN_NAVIGATOR_MIN_WIDTH_PX,
  STANDALONE_TURN_NAVIGATOR_MIN_WIDTH_PX,
} from "../src/modules/contextPanel/conversationTurnNavigator";
import type { Message } from "../src/modules/contextPanel/types";

const here = dirname(fileURLToPath(import.meta.url));

function message(
  role: "user" | "assistant",
  text: string,
  timestamp: number,
  overrides: Partial<Message> = {},
): Message {
  return { role, text, timestamp, ...overrides };
}

describe("conversation turn navigator", function () {
  it("pairs a query with the first display answer before the next query", function () {
    const messages: Message[] = [
      message("user", "First question", 10),
      message("assistant", "Compacted", 11, { compactMarker: true }),
      message("assistant", "Runtime changed", 12, {
        runtimeMarkerText: "Runtime changed",
      }),
      message("assistant", "First answer", 13),
      message("user", "Second question", 20),
      message("assistant", "Model changed", 21, {
        modelSwitchMarkerText: "Model changed",
      }),
    ];

    const turns = buildConversationTurnProjection(messages);

    assert.lengthOf(turns, 2);
    assert.equal(turns[0].assistantMessageIndex, 3);
    assert.equal(turns[0].answerText, "First answer");
    assert.equal(turns[1].answerText, "No answer yet");
  });

  it("uses display overrides and never projects hidden continuation fields", function () {
    const turns = buildConversationTurnProjection([
      message("user", "Question", 10),
      message("assistant", "Raw answer", 11, {
        quoteDisplayOverride: { markdown: "Visible **validated** answer" },
      }),
      message("user", "Streaming question", 20),
      message("assistant", "", 21, {
        streaming: true,
        pendingFinalText: "hidden pending answer",
        reasoningSummary: "hidden summary",
        reasoningDetails: "hidden reasoning",
      }),
    ]);

    assert.equal(turns[0].answerText, "Visible validated answer");
    assert.equal(turns[1].answerText, "Answer in progress");
    assert.notInclude(JSON.stringify(turns), "hidden pending answer");
    assert.notInclude(JSON.stringify(turns), "hidden reasoning");
  });

  it("labels textless attachment queries and generated-image answers", function () {
    const turns = buildConversationTurnProjection([
      message("user", "", 10, {
        attachments: [{ id: "file-1", name: "paper.pdf" } as never],
      }),
      message("assistant", "", 11, {
        generatedImages: [{ src: "file:///image.png" } as never],
      }),
    ]);

    assert.equal(turns[0].queryText, "Query with attached content");
    assert.equal(turns[0].answerText, "Generated image response");
  });

  it("marks interrupted visible answers without replacing their text", function () {
    const turns = buildConversationTurnProjection([
      message("user", "Question", 10),
      message("assistant", "Partial answer", 11, { interrupted: true }),
    ]);

    assert.equal(turns[0].answerText, "Partial answer");
    assert.equal(turns[0].answerStatus, "Interrupted response");
  });

  it("keeps duplicate timestamps distinct with the rendered-index fallback", function () {
    const first = message("user", "First", 10);
    const second = message("user", "Second", 10);

    assert.equal(getConversationMessageAnchorKey(first, 0), "user:10:0");
    assert.equal(getConversationMessageAnchorKey(second, 2), "user:10:2");
    assert.equal(
      getConversationMessageAnchorKey(
        message("user", "Stored", 10, { id: 7 }),
        4,
      ),
      "id:7",
    );
  });

  it("uses deterministic length buckets for inactive dash widths", function () {
    assert.equal(getConversationTurnDashWidth("short"), 7);
    assert.equal(getConversationTurnDashWidth("x".repeat(41)), 9);
    assert.equal(getConversationTurnDashWidth("x".repeat(121)), 11);
    assert.equal(getConversationTurnDashWidth("x".repeat(241)), 13);
  });

  it("selects the viewport-center turn with binary-search boundaries", function () {
    const starts = [12, 180, 460, 900];

    assert.equal(findActiveConversationTurnIndex(starts, 0), 0);
    assert.equal(findActiveConversationTurnIndex(starts, 179), 0);
    assert.equal(findActiveConversationTurnIndex(starts, 180), 1);
    assert.equal(findActiveConversationTurnIndex(starts, 800), 2);
    assert.equal(findActiveConversationTurnIndex(starts, 1200), 3);
  });

  it("uses separate inclusive sidebar and standalone width thresholds", function () {
    const eligible = (
      overrides: Partial<{
        shellWidth: number;
        scrollHeight: number;
        clientHeight: number;
        turnCount: number;
        minimumWidthPx: number;
      }> = {},
    ) =>
      isConversationTurnNavigatorEligible({
        shellWidth: SIDEBAR_TURN_NAVIGATOR_MIN_WIDTH_PX,
        scrollHeight: 501,
        clientHeight: 499,
        turnCount: 2,
        minimumWidthPx: SIDEBAR_TURN_NAVIGATOR_MIN_WIDTH_PX,
        ...overrides,
      });

    assert.isTrue(eligible());
    assert.isFalse(
      eligible({ shellWidth: SIDEBAR_TURN_NAVIGATOR_MIN_WIDTH_PX - 1 }),
    );
    assert.isTrue(
      eligible({
        shellWidth: STANDALONE_TURN_NAVIGATOR_MIN_WIDTH_PX,
        minimumWidthPx: STANDALONE_TURN_NAVIGATOR_MIN_WIDTH_PX,
      }),
    );
    assert.isFalse(
      eligible({
        shellWidth: STANDALONE_TURN_NAVIGATOR_MIN_WIDTH_PX - 1,
        minimumWidthPx: STANDALONE_TURN_NAVIGATOR_MIN_WIDTH_PX,
      }),
    );
    assert.isFalse(eligible({ turnCount: 1 }));
    assert.isFalse(eligible({ scrollHeight: 500 }));
    assert.isFalse(eligible({ scrollHeight: 501, clientHeight: 500 }));
  });

  it("is wired once through the shared shell with no standalone fork", function () {
    const chatSource = readFileSync(
      resolve(here, "../src/modules/contextPanel/chat.ts"),
      "utf8",
    );
    const setupSource = readFileSync(
      resolve(here, "../src/modules/contextPanel/setupHandlers.ts"),
      "utf8",
    );
    const standaloneSource = readFileSync(
      resolve(here, "../src/modules/contextPanel/standaloneWindow.ts"),
      "utf8",
    );

    assert.include(setupSource, "createConversationTurnNavigator({");
    assert.include(setupSource, "disposeConversationTurnNavigator(body)");
    assert.include(setupSource, "STANDALONE_TURN_NAVIGATOR_MIN_WIDTH_PX");
    assert.include(setupSource, "SIDEBAR_TURN_NAVIGATOR_MIN_WIDTH_PX");
    assert.include(chatSource, "syncConversationTurnNavigator(body, history");
    assert.include(chatSource, "conversationKey,");
    assert.notInclude(standaloneSource, "conversationTurnNavigator");
  });
});
