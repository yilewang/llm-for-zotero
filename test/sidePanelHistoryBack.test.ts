import { assert } from "chai";
import {
  CLOSED_SIDE_PANEL_TABS,
  openHistorySidePanelTab,
  openReadOnlySidePanelTab,
  openSidePanel,
  returnReadOnlyTabToHistory,
  showSidePanelNewTabPage,
} from "../src/modules/contextPanel/standaloneSidePanelState";

describe("side panel Back to History", function () {
  const pickFromHistory = () => {
    const history = openHistorySidePanelTab(
      showSidePanelNewTabPage(openSidePanel(CLOSED_SIDE_PANEL_TABS)),
      "history-1",
    );
    return openReadOnlySidePanelTab(history.state, {
      id: "readonly-1",
      conversationKey: 42,
      replaceId: "history-1",
    });
  };

  it("turns a chat picked in History back into the History tab, in place", function () {
    const picked = pickFromHistory();
    const back = returnReadOnlyTabToHistory(
      picked.state,
      "readonly-1",
      "history-2",
    );
    assert.isTrue(back.opened);
    assert.equal(back.tabId, "history-2");
    assert.deepEqual(
      back.state.tabs.map((tab) => [tab.id, tab.kind]),
      [["history-2", "history"]],
    );
    assert.equal(back.state.activeId, "history-2");
  });

  it("focuses a History tab that is already open and closes the chat tab", function () {
    const picked = pickFromHistory();
    const other = openHistorySidePanelTab(
      showSidePanelNewTabPage(picked.state),
      "history-3",
    );
    const back = returnReadOnlyTabToHistory(
      other.state,
      "readonly-1",
      "history-4",
    );
    assert.isFalse(back.opened);
    assert.equal(back.tabId, "history-3");
    assert.deepEqual(
      back.state.tabs.map((tab) => tab.id),
      ["history-3"],
    );
  });

  it("changes nothing for a tab that is not a read-only chat", function () {
    const picked = pickFromHistory();
    const none = returnReadOnlyTabToHistory(picked.state, "nope", "history-9");
    assert.isNull(none.tabId);
    assert.strictEqual(none.state, picked.state);
  });
});
