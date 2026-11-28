import { assert } from "chai";
import {
  hasRuntimeHistory,
  renderRuntimeHistoryTranscript,
  selectRuntimeHistory,
} from "../src/agent/context/runtimeHistory";
import type { AgentRuntimeRequest } from "../src/agent/types";

/**
 * The history a fresh runtime session gets (agent/context/runtimeHistory.ts).
 * When even the newest earlier message is larger than the history budget,
 * no message is sent, but the note on the omitted ones still is, so the
 * session can read them with past_chat_read.
 */
describe("workflow: fresh-session runtime history", function () {
  it("keeps the note and its past_chat_read pointer when no message fits", function () {
    const history = {
      entries: [],
      omitted: 3,
      chatId: "antigravity:7000000000000001",
    };
    assert.isTrue(hasRuntimeHistory(history));
    const transcript = renderRuntimeHistoryTranscript(history, "a test");
    assert.include(
      transcript,
      "Local Zotero conversation history for continuity because a test:",
    );
    assert.include(
      transcript,
      '(3 earlier messages did not fit and are not shown. Read them with past_chat_read({ chat: "antigravity:7000000000000001" })',
    );
  });

  it("renders nothing for a chat with no earlier messages", function () {
    const history = { entries: [], omitted: 0 };
    assert.isFalse(hasRuntimeHistory(history));
    assert.equal(renderRuntimeHistoryTranscript(history, "a test"), "");
  });

  it("points to past_chat_read only when the turn has the Zotero tools", function () {
    // An earlier message far larger than any model's history budget.
    const request = {
      conversationKey: 4427700500000001,
      model: "claude-sonnet-4-5",
      history: [
        { role: "user", content: "pasted ".repeat(400_000) },
        { role: "assistant", content: "Noted." },
      ],
    } as unknown as AgentRuntimeRequest;
    const withTools = selectRuntimeHistory(request, {
      pastChatReadAvailable: true,
    });
    assert.equal(withTools.omitted, 1, JSON.stringify(withTools).slice(0, 200));
    assert.include(
      renderRuntimeHistoryTranscript(withTools, "a test"),
      "past_chat_read",
    );
    const withoutTools = selectRuntimeHistory(request, {
      pastChatReadAvailable: false,
    });
    assert.equal(withoutTools.omitted, 1);
    const note = renderRuntimeHistoryTranscript(withoutTools, "a test");
    assert.include(note, "(1 earlier message did not fit and are not shown.)");
    assert.notInclude(note, "past_chat_read");
  });
});
