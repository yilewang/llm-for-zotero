import { assert } from "chai";
import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, it } from "mocha";
import {
  endInlineEdit,
  getInlineEditBorrowedInputSection,
  hasNewerUserTurnThanInlineEdit,
  isInlineEditSuperseded,
  getInlineEditCleanup,
  getInlineEditSavedDraft,
  getInlineEditTarget,
  releaseInlineEditsForConversation,
  setInlineEditBorrowedInputSection,
  setInlineEditCleanup,
  setInlineEditSavedDraft,
  setInlineEditTarget,
} from "../src/modules/contextPanel/inlineEditState";
import {
  clearAllState,
  tryBeginRequest,
} from "../src/modules/contextPanel/state";

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

  it("deleting a conversation gives a mounted panel its composer back and drops a detached panel's edit without cleanup", function () {
    const mounted = { isConnected: true } as unknown as Element;
    const detached = panelBody();
    const other = { isConnected: true } as unknown as Element;
    const calls: string[] = [];
    setInlineEditTarget(mounted, target(9, 1));
    setInlineEditTarget(detached, target(9, 2));
    setInlineEditTarget(other, target(10, 3));
    setInlineEditCleanup(mounted, () => calls.push("mounted"));
    setInlineEditCleanup(detached, () => calls.push("detached"));
    setInlineEditCleanup(other, () => calls.push("other"));

    releaseInlineEditsForConversation(9);

    assert.deepEqual(calls, ["mounted"]);
    assert.isNull(getInlineEditTarget(mounted));
    assert.isNull(getInlineEditCleanup(mounted));
    assert.isNull(getInlineEditTarget(detached));
    assert.isNull(getInlineEditCleanup(detached));
    assert.equal(getInlineEditTarget(other)?.conversationKey, 10);
    endInlineEdit(other);
    assert.deepEqual(calls, ["mounted", "other"]);
  });

  describe("a turn started in the edited conversation from elsewhere", function () {
    afterEach(() => {
      clearAllState();
    });

    it("ends another panel's edit and puts its edited text in that panel's composer", function () {
      const editing = { isConnected: true } as unknown as Element;
      const starter = { isConnected: true } as unknown as Element;
      const detached = panelBody();
      const other = { isConnected: true } as unknown as Element;
      const calls: string[] = [];
      let restoredDraft = "";
      let restoredAsSuperseded = false;
      setInlineEditTarget(editing, {
        ...target(11, 1),
        currentText: "half-typed edit",
      });
      setInlineEditSavedDraft(editing, "pre-edit draft");
      setInlineEditCleanup(editing, () => {
        calls.push("editing");
        restoredDraft = getInlineEditSavedDraft(editing);
        restoredAsSuperseded = isInlineEditSuperseded(editing);
      });
      // The starting panel is sending its own edit of the conversation.
      setInlineEditTarget(starter, target(11, 5));
      setInlineEditCleanup(starter, () => calls.push("starter"));
      setInlineEditTarget(detached, target(11, 2));
      setInlineEditCleanup(detached, () => calls.push("detached"));
      setInlineEditTarget(other, target(12, 3));
      setInlineEditCleanup(other, () => calls.push("other"));

      assert.isTrue(tryBeginRequest(11, 1, null, starter));

      assert.deepEqual(calls, ["editing"], "only the other mounted edit ends");
      assert.isNull(getInlineEditTarget(editing));
      assert.equal(
        restoredDraft,
        "half-typed edit",
        "the composer gets the edited text, not the pre-edit draft",
      );
      assert.isTrue(restoredAsSuperseded);
      assert.isFalse(isInlineEditSuperseded(editing));
      assert.equal(
        getInlineEditTarget(starter)?.userTimestamp,
        5,
        "the starting panel's own edit is untouched",
      );
      assert.isNull(getInlineEditTarget(detached));
      assert.equal(getInlineEditTarget(other)?.conversationKey, 12);
    });

    it("a turn started with no panel ends every edit of the conversation", function () {
      const first = { isConnected: true } as unknown as Element;
      const second = { isConnected: true } as unknown as Element;
      setInlineEditTarget(first, target(13, 1));
      setInlineEditTarget(second, target(13, 2));
      assert.isTrue(tryBeginRequest(13, 1, null));
      assert.isNull(getInlineEditTarget(first));
      assert.isNull(getInlineEditTarget(second));
    });

    it("a refused start (the conversation is already busy) ends nothing", function () {
      const editing = { isConnected: true } as unknown as Element;
      assert.isTrue(tryBeginRequest(14, 1, null));
      setInlineEditTarget(editing, target(14, 1));
      assert.isFalse(tryBeginRequest(14, 2, null));
      assert.equal(getInlineEditTarget(editing)?.conversationKey, 14);
      endInlineEdit(editing);
    });

    it("a prompt newer than any the conversation had when the edit opened supersedes it", function () {
      const edit = { ...target(15, 100), latestUserTimestamp: 300 };
      const history = [
        { role: "user", timestamp: 100 },
        { role: "assistant", timestamp: 101 },
        { role: "user", timestamp: 300 },
        { role: "assistant", timestamp: 301 },
      ];
      assert.isFalse(hasNewerUserTurnThanInlineEdit(edit, history));
      assert.isTrue(
        hasNewerUserTurnThanInlineEdit(edit, [
          ...history,
          { role: "user", timestamp: 400 },
        ]),
      );
      assert.isFalse(
        hasNewerUserTurnThanInlineEdit(target(15, 100), [
          ...history,
          { role: "user", timestamp: 400 },
        ]),
        "an edit without a recorded latest prompt is never superseded",
      );
    });
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
