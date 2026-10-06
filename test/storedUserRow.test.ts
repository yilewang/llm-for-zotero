import { assert } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Message } from "../src/modules/contextPanel/types";
import { toStoredUserRowPatch } from "../src/modules/contextPanel/storedUserRow";

/**
 * The store's user-row UPDATE overwrites every column it names, so a patch
 * that leaves a field out writes NULL. These tests pin the shared builder
 * and tie the chat.ts and agentEngine.ts call sites to it.
 */

const USER_ROW_FIELDS = [
  "agentRunId",
  "attachments",
  "citationPaperContexts",
  "forcedSkillIds",
  "fullTextPaperContexts",
  "modelAttachments",
  "modelEntryId",
  "modelName",
  "modelProviderLabel",
  "paperContexts",
  "pdfPaperContexts",
  "runMode",
  "screenshotImages",
  "selectedCollectionContexts",
  "selectedTagContexts",
  "selectedText",
  "selectedTextContexts",
  "selectedTextNoteContexts",
  "selectedTextPaperContexts",
  "selectedTextSources",
  "selectedTexts",
  "text",
  "timestamp",
];

describe("toStoredUserRowPatch", function () {
  it("writes every user-row field, even the absent ones", function () {
    const patch = toStoredUserRowPatch({
      role: "user",
      text: "Q",
      timestamp: 5,
    });
    assert.deepEqual(Object.keys(patch).sort(), USER_ROW_FIELDS);
    assert.isUndefined(patch.forcedSkillIds);
  });

  it("copies the fields that hand-copied patches used to drop", function () {
    const message = {
      role: "user",
      text: "Q",
      timestamp: 5,
      forcedSkillIds: ["skill-a"],
      selectedTagContexts: [{ name: "tag", libraryID: 1 }],
      selectedTextNoteContexts: [undefined],
      streaming: false,
    } as unknown as Message;
    const patch = toStoredUserRowPatch(message);
    assert.strictEqual(patch.forcedSkillIds, message.forcedSkillIds);
    assert.strictEqual(patch.selectedTagContexts, message.selectedTagContexts);
    assert.strictEqual(
      patch.selectedTextNoteContexts,
      message.selectedTextNoteContexts,
    );
    assert.notProperty(patch, "streaming");
  });

  it("applies overrides last", function () {
    const patch = toStoredUserRowPatch(
      { role: "user", text: "Q", timestamp: 5, runMode: "chat" },
      { runMode: "agent", conversationGeneration: 3 },
    );
    assert.equal(patch.runMode, "agent");
    assert.equal(patch.conversationGeneration, 3);
  });
});

describe("user-row update sites", function () {
  function read(path: string): string {
    return readFileSync(join(__dirname, "..", path), "utf8");
  }

  /** The argument text of each call that starts with `marker`. */
  function callArguments(source: string, marker: string): string[] {
    const calls: string[] = [];
    let from = 0;
    for (;;) {
      const at = source.indexOf(marker, from);
      if (at < 0) break;
      let depth = 1;
      let end = at + marker.length;
      for (; end < source.length && depth > 0; end += 1) {
        const ch = source[end];
        if (ch === "(" || ch === "{" || ch === "[") depth += 1;
        else if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
      }
      calls.push(source.slice(at + marker.length, end));
      from = end;
    }
    return calls;
  }

  const DROPPED_BEFORE = [
    "forcedSkillIds",
    "selectedTagContexts",
    "selectedTextNoteContexts",
  ];

  function assertEachSiteKeepsEveryField(calls: string[]): void {
    assert.isNotEmpty(calls);
    for (const call of calls) {
      if (call.includes("toStoredUserRowPatch(")) continue;
      // A hand-written literal must still name every field.
      if (!/\bselectedText:/.test(call)) continue;
      for (const field of DROPPED_BEFORE) {
        assert.match(call, new RegExp(`\\b${field}:`), `${field} in ${call}`);
      }
    }
  }

  it("chat.ts writes no user-row patch that leaves a field out", function () {
    const calls = callArguments(
      read("src/modules/contextPanel/chat.ts"),
      "await updateStoredLatestUserMessageByConversation(",
    );
    assert.isAtLeast(calls.length, 4);
    assertEachSiteKeepsEveryField(calls);
  });

  it("agentEngine.ts writes no user-row patch that leaves a field out", function () {
    const calls = callArguments(
      read("src/modules/contextPanel/agentMode/agentEngine.ts"),
      "deps.updateStoredLatestUserMessage(",
    );
    assert.isAtLeast(calls.length, 4);
    assertEachSiteKeepsEveryField(calls);
  });
});
