import { assert } from "chai";
import {
  isPaperPortalItem,
  resolveInitialPanelItemState,
} from "../src/modules/contextPanel/portalScope";
import {
  activeConversationModeByLibrary,
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
} from "../src/modules/contextPanel/state";

describe("portalScope resolveInitialPanelItemState", function () {
  const originalZotero = globalThis.Zotero;

  before(function () {
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Items: {
        get: () => null,
      },
    } as typeof Zotero;
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  beforeEach(function () {
    activeConversationModeByLibrary.clear();
    activeGlobalConversationByLibrary.clear();
    activePaperConversationByPaper.clear();
  });

  it("keeps paper chat as the default when opening a paper", function () {
    const paperItem = {
      id: 42,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;

    activeConversationModeByLibrary.set(7, "global");
    activeGlobalConversationByLibrary.set(7, 9001);

    const resolved = resolveInitialPanelItemState(paperItem);

    assert.equal(resolved.basePaperItem, paperItem);
    assert.equal(resolved.item, paperItem);
    assert.equal(resolved.item?.libraryID, 7);
  });

  it("restores the remembered paper chat session for the selected paper", function () {
    const paperItem = {
      id: 42,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;

    activePaperConversationByPaper.set("7:42", 4207);

    const resolved = resolveInitialPanelItemState(paperItem);

    assert.equal(resolved.basePaperItem, paperItem);
    assert.isTrue(isPaperPortalItem(resolved.item));
    assert.equal(resolved.item?.id, 4207);
    assert.equal(resolved.item?.libraryID, 7);
  });
});
