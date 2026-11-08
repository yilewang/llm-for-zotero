import { assert } from "chai";
import {
  MAX_ATTACHED_CONVERSATIONS,
  normalizeAttachedConversationRefs,
} from "../src/services/context/normalizers";

describe("normalizeAttachedConversationRefs", function () {
  const valid = (key: number, extra: Record<string, unknown> = {}) => ({
    system: "upstream",
    conversationKey: key,
    title: `Chat ${key}`,
    libraryID: 1,
    ...extra,
  });

  it("returns an empty list for non-arrays", function () {
    assert.deepEqual(normalizeAttachedConversationRefs(undefined), []);
    assert.deepEqual(normalizeAttachedConversationRefs("x"), []);
  });

  it("drops invalid entries", function () {
    const out = normalizeAttachedConversationRefs([
      null,
      valid(1, { system: "bogus" }),
      valid(0),
      valid(-3),
      valid(2, { libraryID: 0 }),
      valid(3),
    ]);
    assert.deepEqual(
      out.map((ref) => ref.conversationKey),
      [3],
    );
  });

  it("keeps optional fields, trims and caps the title, and falls back when the title is empty", function () {
    const out = normalizeAttachedConversationRefs([
      valid(1, {
        title: `  ${"a".repeat(600)}  `,
        conversationID: "conv-1",
        kind: "paper",
        paperItemID: 8,
      }),
      valid(2, { title: "   ", kind: "other" }),
    ]);
    assert.lengthOf(out[0].title, 512);
    assert.equal(out[0].conversationID, "conv-1");
    assert.equal(out[0].kind, "paper");
    assert.equal(out[0].paperItemID, 8);
    assert.equal(out[1].title, "Conversation 2");
    assert.notProperty(out[1], "kind");
  });

  it("dedupes on system and key, and caps the list", function () {
    const deduped = normalizeAttachedConversationRefs([
      valid(1),
      valid(1),
      valid(1, { system: "codex" }),
    ]);
    assert.lengthOf(deduped, 2);
    const capped = normalizeAttachedConversationRefs(
      [1, 2, 3, 4, 5].map((key) => valid(key)),
    );
    assert.lengthOf(capped, MAX_ATTACHED_CONVERSATIONS);
    assert.equal(MAX_ATTACHED_CONVERSATIONS, 3);
  });
});
