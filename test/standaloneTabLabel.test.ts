import { assert } from "chai";
import { readFileSync } from "node:fs";
import { resolveStandalonePaperTabLabel } from "../src/modules/contextPanel/standaloneTabLabel";
import { resolveActiveNoteSession } from "../src/modules/contextPanel/portalScope";
import { createNoteConversationItem } from "../src/modules/contextPanel/noteEditing/conversationItem";
import { t } from "../src/utils/i18n";

describe("standaloneTabLabel", function () {
  it("translates the rendered paper tab on creation and mode refresh", function () {
    const source = readFileSync(
      new URL(
        "../src/modules/contextPanel/standaloneWindow.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const assignments = Array.from(
      source.matchAll(/paperTab\.textContent = ([\s\S]*?);/g),
      (match) => match[1],
    );
    assert.lengthOf(assignments, 2, "creation and mode refresh assignments");
    const originalZotero = (globalThis as any).Zotero;
    try {
      for (const [locale, expected] of [
        ["zh-CN", "论文对话"],
        ["en-US", "Paper chat"],
      ]) {
        (globalThis as any).Zotero = {
          locale,
          Items: { get: (id: number) => ({ id, isRegularItem: () => true }) },
        };
        for (const assignment of assignments) {
          const render = new Function(
            "resolveStandalonePaperTabLabel",
            "t",
            "isInWebChatMode",
            "resolveActiveNoteSession",
            "activeItem",
            `return ${assignment};`,
          );
          assert.equal(
            render(
              resolveStandalonePaperTabLabel,
              t,
              false,
              resolveActiveNoteSession,
              null,
            ),
            expected,
          );
        }
      }
    } finally {
      (globalThis as any).Zotero = originalZotero;
    }
  });

  it("renders Note chat on creation and refresh for note conversations", function () {
    const source = readFileSync(
      new URL(
        "../src/modules/contextPanel/standaloneWindow.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const assignments = Array.from(
      source.matchAll(/paperTab\.textContent = ([\s\S]*?);/g),
      (match) => match[1],
    );
    assert.lengthOf(assignments, 2);
    const originalZotero = (globalThis as any).Zotero;
    try {
      for (const parentID of [undefined, 42]) {
        const note = {
          id: 4070,
          libraryID: 1,
          parentID,
          isNote: () => true,
          getNote: () => "<p>Editing a note</p>",
        } as unknown as Zotero.Item;
        const activeItem = createNoteConversationItem(
          note,
          "upstream",
          1_000_004_070,
        );
        for (const [locale, expected] of [
          ["en-US", "Note chat"],
          ["zh-CN", "笔记对话"],
        ]) {
          (globalThis as any).Zotero = {
            locale,
            Items: { get: (id: number) => ({ id, isRegularItem: () => true }) },
          };
          for (const assignment of assignments) {
            const render = new Function(
              "resolveStandalonePaperTabLabel",
              "t",
              "isInWebChatMode",
              "resolveActiveNoteSession",
              "activeItem",
              `return ${assignment};`,
            );
            assert.equal(
              render(
                resolveStandalonePaperTabLabel,
                t,
                false,
                resolveActiveNoteSession,
                activeItem,
              ),
              expected,
            );
          }
        }
      }
    } finally {
      (globalThis as any).Zotero = originalZotero;
    }
  });

  it("labels the paper tab as Paper chat by default", function () {
    assert.equal(resolveStandalonePaperTabLabel(), "Paper chat");
  });

  it("overrides the paper slot label with Web chat while webchat is active", function () {
    assert.equal(
      resolveStandalonePaperTabLabel({ isWebChat: true, isNoteSession: true }),
      "Web chat",
    );
  });
});
