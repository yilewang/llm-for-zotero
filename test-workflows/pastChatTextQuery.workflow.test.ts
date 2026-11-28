import { assert } from "chai";
import {
  buildStoredMessageTextsQuery,
  readStoredMessageTexts,
} from "../src/shared/conversationMessageSql";

/**
 * A past chat is read as text (pastConversationLoader): the query names
 * only the columns a reader needs, and the current turn's cut-off is in the
 * query, so a read never carries the chat's screenshots, attachments or
 * context data.
 */
describe("workflow: past chat text query", function () {
  it("selects only text columns, with the cut-off in SQL", function () {
    const sql = buildStoredMessageTextsQuery({
      tableName: "messages",
      whereSql: "conversation_key = ?",
      compactMarkerColumn: "compact_marker",
      before: true,
    });
    assert.match(
      sql,
      /^SELECT role, text, timestamp, compact_marker AS compactMarker\s+FROM messages/,
    );
    assert.include(sql, "WHERE conversation_key = ? AND timestamp < ?");
    assert.notMatch(sql, /screenshot|attachments|json|LIMIT/i);
  });

  it("gives every row the marker column, so a store without one can be read", function () {
    const sql = buildStoredMessageTextsQuery({
      tableName: "messages",
      whereSql: "conversation_key = ?",
      before: false,
    });
    assert.include(sql, "0 AS compactMarker");
    assert.notInclude(sql, "timestamp <");
    assert.deepEqual(
      readStoredMessageTexts([
        { role: "user", text: "Hi", timestamp: 5, compactMarker: 0 },
        { role: "assistant", text: "", timestamp: 6, compactMarker: 1 },
      ]),
      [
        { role: "user", text: "Hi", timestamp: 5 },
        { role: "assistant", text: "", timestamp: 6, compactMarker: true },
      ],
    );
  });
});
