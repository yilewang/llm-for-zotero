import { assert } from "chai";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, it } from "mocha";
import {
  endInlineEdit,
  getInlineEditBorrowedInputSection,
  getInlineEditCleanup,
  getInlineEditSavedDraft,
  getInlineEditTarget,
  releaseInlineEditsForConversation,
  setInlineEditBorrowedInputSection,
  setInlineEditCleanup,
  setInlineEditSavedDraft,
  setInlineEditTarget,
} from "../src/modules/contextPanel/inlineEditState";

/** Stand-ins for two panel bodies (the sidebar's and the window's). */
const panelBody = () => ({}) as unknown as Element;

const target = (conversationKey: number, userTimestamp: number) => ({
  conversationKey,
  userTimestamp,
  assistantTimestamp: userTimestamp + 1,
  currentText: `edit ${userTimestamp}`,
});

describe("inlineEditState: each chat panel keeps its own message edit", function () {
  it("an edit opened in one panel is not seen by another", function () {
    const sidebar = panelBody();
    const windowPanel = panelBody();
    setInlineEditTarget(windowPanel, target(7, 100));

    assert.equal(getInlineEditTarget(windowPanel)?.userTimestamp, 100);
    assert.isNull(getInlineEditTarget(sidebar));
  });

  it("two panels can each edit, even the same conversation, without sharing the borrowed composer", function () {
    const sidebar = panelBody();
    const windowPanel = panelBody();
    const sidebarSection = { id: "sidebar-section" } as unknown as HTMLElement;
    const windowSection = { id: "window-section" } as unknown as HTMLElement;
    const sidebarParent = {} as unknown as Element;
    const windowParent = {} as unknown as Element;

    setInlineEditTarget(sidebar, target(7, 100));
    setInlineEditTarget(windowPanel, target(7, 200));
    setInlineEditBorrowedInputSection(
      sidebar,
      sidebarSection,
      sidebarParent,
      null,
    );
    setInlineEditBorrowedInputSection(
      windowPanel,
      windowSection,
      windowParent,
      null,
    );
    setInlineEditSavedDraft(sidebar, "sidebar draft");
    setInlineEditSavedDraft(windowPanel, "window draft");

    assert.strictEqual(
      getInlineEditBorrowedInputSection(sidebar).el,
      sidebarSection,
    );
    assert.strictEqual(
      getInlineEditBorrowedInputSection(windowPanel).el,
      windowSection,
    );
    assert.strictEqual(
      getInlineEditBorrowedInputSection(windowPanel).parent,
      windowParent,
    );
    assert.equal(getInlineEditSavedDraft(sidebar), "sidebar draft");
    assert.equal(getInlineEditSavedDraft(windowPanel), "window draft");
    assert.equal(getInlineEditTarget(sidebar)?.userTimestamp, 100);
    assert.equal(getInlineEditTarget(windowPanel)?.userTimestamp, 200);
  });

  it("ending one panel's edit runs only its own cleanup and leaves the other panel's edit open", function () {
    const sidebar = panelBody();
    const windowPanel = panelBody();
    const calls: string[] = [];
    setInlineEditTarget(sidebar, target(3, 10));
    setInlineEditTarget(windowPanel, target(4, 20));
    setInlineEditCleanup(sidebar, () => calls.push("sidebar"));
    setInlineEditCleanup(windowPanel, () => calls.push("window"));
    setInlineEditSavedDraft(sidebar, "draft");
    setInlineEditBorrowedInputSection(
      sidebar,
      {} as unknown as HTMLElement,
      {} as unknown as Element,
      null,
    );

    endInlineEdit(sidebar);

    assert.deepEqual(calls, ["sidebar"]);
    assert.isNull(getInlineEditTarget(sidebar));
    assert.isNull(getInlineEditCleanup(sidebar));
    assert.isNull(getInlineEditBorrowedInputSection(sidebar).el);
    assert.equal(getInlineEditSavedDraft(sidebar), "");
    assert.equal(getInlineEditTarget(windowPanel)?.userTimestamp, 20);
    assert.isFunction(getInlineEditCleanup(windowPanel));

    // Ending an edit that is not open does nothing.
    endInlineEdit(sidebar);
    assert.deepEqual(calls, ["sidebar"]);
  });

  it("deleting a conversation forgets every panel's edit of it without running their cleanup", function () {
    const sidebar = panelBody();
    const windowPanel = panelBody();
    const other = panelBody();
    const calls: string[] = [];
    setInlineEditTarget(sidebar, target(9, 1));
    setInlineEditTarget(windowPanel, target(9, 2));
    setInlineEditTarget(other, target(10, 3));
    setInlineEditCleanup(sidebar, () => calls.push("sidebar"));
    setInlineEditCleanup(windowPanel, () => calls.push("window"));

    releaseInlineEditsForConversation(9);

    assert.deepEqual(calls, []);
    assert.isNull(getInlineEditTarget(sidebar));
    assert.isNull(getInlineEditTarget(windowPanel));
    assert.isNull(getInlineEditCleanup(windowPanel));
    assert.equal(getInlineEditTarget(other)?.conversationKey, 10);
    endInlineEdit(other);
  });

  it("a panel that never edited reads as not editing", function () {
    const body = panelBody();
    assert.isNull(getInlineEditTarget(body));
    assert.isNull(getInlineEditCleanup(body));
    assert.deepEqual(getInlineEditBorrowedInputSection(body), {
      el: null,
      parent: null,
      nextSib: null,
    });
    assert.equal(getInlineEditSavedDraft(body), "");
  });

  it("no chat code reads a process-wide inline edit any more", function () {
    const root = join(__dirname, "../src/modules/contextPanel");
    const files = [
      "state.ts",
      "chat.ts",
      "setupHandlers.ts",
      "chatRenderingReplay.ts",
      "setupHandlers/controllers/historyLifecycleController.ts",
      "setupHandlers/controllers/floatingMenuInteractionController.ts",
    ];
    for (const file of files) {
      const source = readFileSync(join(root, file), "utf8");
      for (const singleton of [
        /\binlineEditTarget\b/,
        /\binlineEditCleanup\b/,
        /\binlineEditInputSection(El|Parent|NextSib)\b/,
        /\binlineEditSavedDraft\b/,
      ]) {
        assert.notMatch(
          source,
          singleton,
          `${file} must read the inline edit of its own panel body`,
        );
      }
    }
  });
});
