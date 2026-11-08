import { assert } from "chai";
import {
  CLOSED_SIDE_PANEL_TABS,
  SIDE_PANEL_MAX_TABS,
  appendSideChatContextNote,
  buildSidePanelExcludedKeys,
  closeSidePanelNewTab,
  closeSidePanelTab,
  findLastFinishedAnswerText,
  focusSidePanelTab,
  hasFinishedAnswer,
  isSameSideChatContext,
  moveSidePanelTab,
  openHistorySidePanelTab,
  openReadOnlySidePanelTab,
  openSideChatSidePanelTab,
  openSidePanel,
  openTaskProgressSidePanelTab,
  hasTaskProgressSidePanelTab,
  resolveAskInSideChatTab,
  resolveSideChatContext,
  resolveSideChatContextNoteAnchors,
  resolveSideChatTabTitle,
  resolveSidePanelCloseDecision,
  resolveSlashSideChatTab,
  showSidePanelNewTabPage,
} from "../src/modules/contextPanel/standaloneSidePanelState";

describe("standalone side panel state", function () {
  describe("tabs", function () {
    const opened = () => openSidePanel(CLOSED_SIDE_PANEL_TABS);

    it("opens on the new-tab page with no tabs", function () {
      const state = opened();
      assert.isTrue(state.open);
      assert.deepEqual(state.tabs, []);
      assert.isNull(state.activeId);
      assert.isTrue(state.newTabOpen, "the New tab tab is the shown tab");
    });

    it("opens one Task progress tab, from the New tab tab or the →| button", function () {
      const fromNewTab = openTaskProgressSidePanelTab(opened(), "progress-1");
      assert.isTrue(fromNewTab.opened);
      assert.isFalse(
        fromNewTab.state.newTabOpen,
        "it takes the New tab tab's place",
      );
      assert.equal(fromNewTab.state.activeId, "progress-1");
      assert.isTrue(hasTaskProgressSidePanelTab(fromNewTab.state));
      const history = openHistorySidePanelTab(
        showSidePanelNewTabPage(fromNewTab.state),
        "history-2",
      );
      const again = openTaskProgressSidePanelTab(history.state, "progress-3");
      assert.isFalse(again.opened, "the open one is focused");
      assert.equal(again.tabId, "progress-1");
      assert.equal(again.state.activeId, "progress-1");
      assert.lengthOf(
        again.state.tabs.filter((tab) => tab.kind === "progress"),
        1,
      );
      assert.isFalse(
        hasTaskProgressSidePanelTab(
          closeSidePanelTab(again.state, "progress-1"),
        ),
      );
      assert.isFalse(hasTaskProgressSidePanelTab(CLOSED_SIDE_PANEL_TABS));
    });

    it("opens a past chat once and focuses it the second time", function () {
      let result = openReadOnlySidePanelTab(opened(), {
        id: "r1",
        conversationKey: 41,
      });
      assert.isTrue(result.opened);
      assert.equal(result.tabId, "r1");
      assert.equal(result.state.activeId, "r1");
      result = openSideChatSidePanelTab(result.state, "s1");
      assert.equal(result.state.activeId, "s1");
      result = openReadOnlySidePanelTab(result.state, {
        id: "r2",
        conversationKey: 41,
      });
      assert.isFalse(result.opened, "the same chat is not opened twice");
      assert.equal(result.tabId, "r1");
      assert.equal(result.state.activeId, "r1");
      assert.deepEqual(
        result.state.tabs.map((tab) => tab.id),
        ["r1", "s1"],
      );
    });

    it("holds at most eight tabs", function () {
      let state = opened();
      for (let index = 0; index < SIDE_PANEL_MAX_TABS; index++) {
        state = openSideChatSidePanelTab(state, `s${index}`).state;
      }
      assert.lengthOf(state.tabs, 8);
      const refused = openSideChatSidePanelTab(state, "s9");
      assert.isTrue(refused.refused);
      assert.strictEqual(refused.state, state, "nothing changes");
      const readOnly = openReadOnlySidePanelTab(state, {
        id: "r9",
        conversationKey: 7,
      });
      assert.isTrue(readOnly.refused);
      assert.isNull(readOnly.tabId);
    });

    it("closing the active tab activates its right neighbour, then the left, then the new-tab page", function () {
      let state = opened();
      for (const id of ["a", "b", "c"]) {
        state = openSideChatSidePanelTab(state, id).state;
      }
      state = focusSidePanelTab(state, "b");
      state = closeSidePanelTab(state, "b");
      assert.equal(state.activeId, "c");
      state = closeSidePanelTab(state, "c");
      assert.equal(state.activeId, "a");
      state = closeSidePanelTab(state, "a");
      assert.isNull(state.activeId, "the new-tab page");
      assert.deepEqual(state.tabs, []);
      assert.isTrue(state.open, "the panel stays open");
      assert.isTrue(state.newTabOpen, "the strip keeps a shown tab");
    });

    it("a tab opened from the New tab tab replaces it", function () {
      let result = openSideChatSidePanelTab(opened(), "s1");
      assert.isFalse(result.state.newTabOpen);
      assert.equal(result.state.activeId, "s1");
      result = openReadOnlySidePanelTab(result.state, {
        id: "r1",
        conversationKey: 9,
      });
      assert.isFalse(result.state.newTabOpen);
      let state = showSidePanelNewTabPage(result.state);
      assert.isTrue(state.newTabOpen);
      const again = openReadOnlySidePanelTab(state, {
        id: "r2",
        conversationKey: 9,
      });
      assert.isFalse(again.opened, "the same chat is focused");
      assert.equal(again.state.activeId, "r1");
      assert.isFalse(again.state.newTabOpen, "focusing it replaces New tab");
      state = showSidePanelNewTabPage(again.state);
      state = focusSidePanelTab(state, "s1");
      assert.isTrue(state.newTabOpen, "focusing a tab keeps New tab open");
      const added = openSideChatSidePanelTab(state, "s2");
      assert.isTrue(
        added.state.newTabOpen,
        "only the shown New tab is replaced",
      );
      assert.equal(added.state.activeId, "s2");
    });

    it("History turns the New tab tab into a History tab", function () {
      let state = openSideChatSidePanelTab(opened(), "s1").state;
      state = showSidePanelNewTabPage(state);
      const result = openHistorySidePanelTab(state, "h1");
      assert.isTrue(result.opened);
      assert.equal(result.state.activeId, "h1");
      assert.isFalse(result.state.newTabOpen, "it replaces the New tab");
      assert.deepEqual(
        result.state.tabs.map((tab) => [tab.id, tab.kind]),
        [
          ["s1", "sidechat"],
          ["h1", "history"],
        ],
      );
      assert.deepEqual(result.state.sideChatMru, ["s1"]);
    });

    it("History focuses an open History tab instead of adding one", function () {
      let state = openHistorySidePanelTab(opened(), "h1").state;
      state = openSideChatSidePanelTab(state, "s1").state;
      state = showSidePanelNewTabPage(state);
      const result = openHistorySidePanelTab(state, "h2");
      assert.isFalse(result.opened);
      assert.equal(result.tabId, "h1");
      assert.equal(result.state.activeId, "h1");
      assert.isFalse(result.state.newTabOpen);
      assert.lengthOf(result.state.tabs, 2);
    });

    it("History counts toward the tab limit", function () {
      let state = opened();
      for (let index = 0; index < SIDE_PANEL_MAX_TABS; index++) {
        state = openSideChatSidePanelTab(state, `s${index}`).state;
      }
      state = showSidePanelNewTabPage(state);
      const refused = openHistorySidePanelTab(state, "h1");
      assert.isTrue(refused.refused);
      assert.strictEqual(refused.state, state);
    });

    it("a chat picked in the History tab replaces it in place", function () {
      let state = openSideChatSidePanelTab(opened(), "s1").state;
      state = showSidePanelNewTabPage(state);
      state = openHistorySidePanelTab(state, "h1").state;
      state = openSideChatSidePanelTab(state, "s2").state;
      state = focusSidePanelTab(state, "h1");
      const result = openReadOnlySidePanelTab(state, {
        id: "r1",
        conversationKey: 12,
        replaceId: "h1",
      });
      assert.isTrue(result.opened);
      assert.equal(result.state.activeId, "r1");
      assert.deepEqual(
        result.state.tabs.map((tab) => tab.id),
        ["s1", "r1", "s2"],
        "the read-only tab takes the History tab's place",
      );
    });

    it("a picked chat that is already open focuses its tab and drops the History tab", function () {
      let state = openReadOnlySidePanelTab(opened(), {
        id: "r1",
        conversationKey: 12,
      }).state;
      state = showSidePanelNewTabPage(state);
      state = openHistorySidePanelTab(state, "h1").state;
      const result = openReadOnlySidePanelTab(state, {
        id: "r2",
        conversationKey: 12,
        replaceId: "h1",
      });
      assert.isFalse(result.opened);
      assert.equal(result.tabId, "r1");
      assert.equal(result.state.activeId, "r1");
      assert.deepEqual(
        result.state.tabs.map((tab) => tab.id),
        ["r1"],
      );
    });

    it("a History tab replaced at the tab limit is not refused", function () {
      let state = opened();
      for (let index = 0; index < SIDE_PANEL_MAX_TABS - 1; index++) {
        state = openSideChatSidePanelTab(state, `s${index}`).state;
      }
      state = showSidePanelNewTabPage(state);
      state = openHistorySidePanelTab(state, "h1").state;
      assert.lengthOf(state.tabs, SIDE_PANEL_MAX_TABS);
      const result = openReadOnlySidePanelTab(state, {
        id: "r1",
        conversationKey: 3,
        replaceId: "h1",
      });
      assert.isFalse(result.refused);
      assert.equal(result.state.activeId, "r1");
      assert.lengthOf(result.state.tabs, SIDE_PANEL_MAX_TABS);
    });

    it("the + button focuses an existing New tab instead of adding one", function () {
      let state = openSideChatSidePanelTab(opened(), "a").state;
      state = showSidePanelNewTabPage(state);
      state = focusSidePanelTab(state, "a");
      state = showSidePanelNewTabPage(state);
      assert.isNull(state.activeId);
      assert.isTrue(state.newTabOpen);
      assert.deepEqual(
        state.tabs.map((tab) => tab.id),
        ["a"],
      );
    });

    it("the New tab tab counts as the last tab when one closes", function () {
      let state = openSideChatSidePanelTab(opened(), "a").state;
      state = openSideChatSidePanelTab(state, "b").state;
      state = showSidePanelNewTabPage(state);
      state = focusSidePanelTab(state, "b");
      state = closeSidePanelTab(state, "b");
      assert.isNull(state.activeId, "the New tab tab is b's right neighbour");
      assert.isTrue(state.newTabOpen);
    });

    it("closing the New tab tab shows its left neighbour, or closes the panel", function () {
      let state = openSideChatSidePanelTab(opened(), "a").state;
      state = openSideChatSidePanelTab(state, "b").state;
      state = showSidePanelNewTabPage(state);
      state = closeSidePanelNewTab(state);
      assert.isFalse(state.newTabOpen);
      assert.equal(state.activeId, "b");
      assert.strictEqual(closeSidePanelNewTab(state), state, "no-op");
      const alone = closeSidePanelNewTab(opened());
      assert.isFalse(alone.open, "the only tab closes the panel");
      assert.deepEqual(alone.tabs, []);
    });

    it("closing an inactive tab keeps the active one", function () {
      let state = opened();
      state = openSideChatSidePanelTab(state, "a").state;
      state = openSideChatSidePanelTab(state, "b").state;
      state = closeSidePanelTab(state, "a");
      assert.equal(state.activeId, "b");
    });

    it("the + page keeps the tabs", function () {
      let state = openSideChatSidePanelTab(opened(), "a").state;
      state = showSidePanelNewTabPage(state);
      assert.isNull(state.activeId);
      assert.isTrue(state.newTabOpen);
      assert.lengthOf(state.tabs, 1);
    });

    it("Ask in side chat goes to the active side chat, else the most recent one, else none", function () {
      let state = opened();
      assert.isNull(resolveAskInSideChatTab(state));
      state = openSideChatSidePanelTab(state, "s1").state;
      state = openSideChatSidePanelTab(state, "s2").state;
      state = focusSidePanelTab(state, "s1");
      assert.equal(resolveAskInSideChatTab(state), "s1");
      state = openReadOnlySidePanelTab(state, {
        id: "r1",
        conversationKey: 5,
      }).state;
      assert.equal(
        resolveAskInSideChatTab(state),
        "s1",
        "the most recently used side chat",
      );
      state = showSidePanelNewTabPage(state);
      assert.equal(resolveAskInSideChatTab(state), "s1");
      state = closeSidePanelTab(state, "s1");
      assert.equal(resolveAskInSideChatTab(state), "s2");
    });

    it("Add side chat takes the active or most recent side chat with an answer", function () {
      let state = opened();
      state = openSideChatSidePanelTab(state, "s1").state;
      state = openSideChatSidePanelTab(state, "s2").state;
      const answered = new Set(["s1"]);
      const has = (id: string) => answered.has(id);
      assert.equal(resolveSlashSideChatTab(state, has), "s1");
      answered.add("s2");
      assert.equal(resolveSlashSideChatTab(state, has), "s2", "the active one");
      answered.clear();
      assert.isNull(resolveSlashSideChatTab(state, has));
    });

    it("moves a tab to a place in the strip and keeps the shown tab", function () {
      let state = openReadOnlySidePanelTab(opened(), {
        id: "r1",
        conversationKey: 41,
      }).state;
      state = openSideChatSidePanelTab(state, "s1").state;
      state = openReadOnlySidePanelTab(state, {
        id: "r2",
        conversationKey: 42,
      }).state;
      const ids = (next: typeof state) => next.tabs.map((tab) => tab.id);
      const moved = moveSidePanelTab(state, "r2", 0);
      assert.deepEqual(ids(moved), ["r2", "r1", "s1"]);
      assert.equal(moved.activeId, "r2");
      assert.deepEqual(ids(moveSidePanelTab(state, "r1", 99)), [
        "s1",
        "r2",
        "r1",
      ]);
      assert.strictEqual(moveSidePanelTab(state, "r2", 2), state);
      assert.strictEqual(moveSidePanelTab(state, "missing", 0), state);
    });

    it("titles a side chat tab by its first question", function () {
      assert.equal(resolveSideChatTabTitle([], "Side chat"), "Side chat");
      assert.equal(
        resolveSideChatTabTitle(
          [
            { role: "user", text: "  What does\n figure 2 show? " },
            { role: "assistant", text: "It shows..." },
            { role: "user", text: "Later question" },
          ],
          "Side chat",
        ),
        "What does figure 2 show?",
      );
    });
  });

  describe("closing", function () {
    it("asks first only when a side chat has messages", function () {
      assert.equal(resolveSidePanelCloseDecision({ messageCount: 0 }), "close");
      assert.equal(
        resolveSidePanelCloseDecision({ messageCount: 1 }),
        "confirm",
      );
    });

    it("finds the last finished answer", function () {
      const messages = [
        { role: "user" as const, text: "q1" },
        { role: "assistant" as const, text: "first answer" },
        { role: "user" as const, text: "q2" },
        { role: "assistant" as const, text: "", streaming: true },
      ];
      assert.equal(findLastFinishedAnswerText(messages), "first answer");
      assert.isTrue(hasFinishedAnswer(messages));
      assert.isNull(findLastFinishedAnswerText(messages.slice(0, 1)));
      assert.isFalse(hasFinishedAnswer([]));
      assert.isFalse(
        hasFinishedAnswer([
          { role: "assistant", text: "  ", streaming: false },
        ]),
      );
    });
  });

  describe("context following", function () {
    it("resolves Paper chat to the paper and Library chat to the library", function () {
      assert.deepEqual(
        resolveSideChatContext({
          mode: "paper",
          basePaperItemID: 12,
          libraryID: 1,
        }),
        { kind: "paper", paperItemID: 12, libraryID: 1 },
      );
      assert.deepEqual(
        resolveSideChatContext({
          mode: "open",
          basePaperItemID: 12,
          libraryID: 3,
        }),
        { kind: "global", paperItemID: 0, libraryID: 3 },
      );
      // A paper mode without a paper falls back to the library.
      assert.equal(
        resolveSideChatContext({
          mode: "paper",
          basePaperItemID: 0,
          libraryID: 1,
        }).kind,
        "global",
      );
    });

    it("compares contexts by kind, paper, and library", function () {
      const paper = { kind: "paper" as const, paperItemID: 4, libraryID: 1 };
      assert.isTrue(isSameSideChatContext(paper, { ...paper }));
      assert.isFalse(
        isSameSideChatContext(paper, { ...paper, paperItemID: 5 }),
      );
      assert.isFalse(
        isSameSideChatContext(paper, {
          kind: "global",
          paperItemID: 0,
          libraryID: 1,
        }),
      );
      assert.isFalse(isSameSideChatContext(null, paper));
    });
  });

  describe("context notes", function () {
    it("adds a note only after messages, replacing one at the same place", function () {
      assert.deepEqual(appendSideChatContextNote([], 0, "x"), []);
      const one = appendSideChatContextNote([], 2, "to library");
      assert.deepEqual(one, [{ afterMessageCount: 2, text: "to library" }]);
      assert.deepEqual(appendSideChatContextNote(one, 2, "to paper"), [
        { afterMessageCount: 2, text: "to paper" },
      ]);
      assert.deepEqual(appendSideChatContextNote(one, 4, "to paper"), [
        { afterMessageCount: 2, text: "to library" },
        { afterMessageCount: 4, text: "to paper" },
      ]);
    });

    it("places each note after the last rendered message before it", function () {
      const notes = [
        { afterMessageCount: 2, text: "a" },
        { afterMessageCount: 4, text: "b" },
        { afterMessageCount: 9, text: "c" },
      ];
      assert.deepEqual(
        resolveSideChatContextNoteAnchors(notes, [0, 1, 2, 3, 4, 5]),
        [
          { text: "a", afterMessageIndex: 1 },
          { text: "b", afterMessageIndex: 3 },
          { text: "c", afterMessageIndex: 5 },
        ],
      );
      // A deleted turn moves the note to the nearest earlier message, and
      // with nothing before it the note goes first.
      assert.deepEqual(resolveSideChatContextNoteAnchors(notes, [2, 3]), [
        { text: "a", afterMessageIndex: null },
        { text: "b", afterMessageIndex: 3 },
        { text: "c", afterMessageIndex: 3 },
      ]);
    });
  });

  it("hides the main chat's conversation from the panel's lists", function () {
    assert.deepEqual([...buildSidePanelExcludedKeys(42)], [42]);
    assert.deepEqual([...buildSidePanelExcludedKeys(0)], []);
  });
});
