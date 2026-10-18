import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { resolveEmbeddedPanelItemStateForTests } from "../src/modules/contextPanel";
import {
  bindEmbeddedPanelHost,
  clearPanelHostBinding,
} from "../src/modules/contextPanel/panelHostOwnership";
import {
  activeContextPanels,
  activeConversationModeByLibrary,
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
} from "../src/modules/contextPanel/state";
import {
  createGlobalPortalItem,
  resolveDisplayConversationKind,
} from "../src/modules/contextPanel/portalScope";

describe("paper reader entry", function () {
  const previous = globalThis.Zotero;
  const preferences = new Map<string, unknown>();
  const paper = (id: number) =>
    ({
      id,
      libraryID: 1,
      isAttachment: () => false,
      isRegularItem: () => true,
      getField: () => "Test paper",
      getAttachments: () => [],
    }) as unknown as Zotero.Item;
  const a = paper(42);
  const b = paper(84);
  const body = { closest: () => null } as unknown as Element;
  beforeEach(function () {
    preferences.clear();
    activeContextPanels.delete(body);
    activeConversationModeByLibrary.clear();
    activeGlobalConversationByLibrary.clear();
    activePaperConversationByPaper.clear();
    globalThis.Zotero = {
      Prefs: { get: (key: string) => preferences.get(key) },
      Items: { get: (id: number) => (id === 42 ? a : id === 84 ? b : null) },
      Libraries: { userLibraryID: 1 },
      Profile: { dir: "/tmp/reader-entry-test" },
      Tabs: { selectedID: "reader-a" },
    } as typeof Zotero;
    activeConversationModeByLibrary.set(1, "global");
    bindEmbeddedPanelHost(body, a, "reader");
  });
  afterEach(function () {
    clearPanelHostBinding(body);
    activeContextPanels.delete(body);
    activeConversationModeByLibrary.clear();
    activeGlobalConversationByLibrary.clear();
    activePaperConversationByPaper.clear();
    globalThis.Zotero = previous;
  });
  it("opens the reader paper despite a remembered library conversation", function () {
    const state = resolveEmbeddedPanelItemStateForTests(body, a);
    assert.equal(resolveDisplayConversationKind(state.item), "paper");
    assert.equal(state.basePaperItem?.id, 42);
  });
  it("keeps an explicit library conversation in an existing reader panel", function () {
    activeContextPanels.set(body, () => createGlobalPortalItem(1, 2000000001));
    assert.equal(
      resolveDisplayConversationKind(
        resolveEmbeddedPanelItemStateForTests(body, a).item,
      ),
      "global",
    );
  });
  it("moves a paper conversation to the newly bound reader paper", function () {
    activeContextPanels.set(body, () => a);
    bindEmbeddedPanelHost(body, b, "reader");
    const state = resolveEmbeddedPanelItemStateForTests(body, b);
    assert.equal(state.basePaperItem?.id, 84);
    assert.equal(resolveDisplayConversationKind(state.item), "paper");
  });
  it("keeps the explicit library conversation lock", function () {
    preferences.set(
      "extensions.zotero.llmforzotero.lockedGlobalConversation.1",
      2000000001,
    );
    assert.equal(
      resolveDisplayConversationKind(
        resolveEmbeddedPanelItemStateForTests(body, a).item,
      ),
      "global",
    );
  });
  it("keeps the remembered library mode outside a reader", function () {
    bindEmbeddedPanelHost(body, a, "library");
    assert.equal(
      resolveDisplayConversationKind(
        resolveEmbeddedPanelItemStateForTests(body, a).item,
      ),
      "global",
    );
  });
});
