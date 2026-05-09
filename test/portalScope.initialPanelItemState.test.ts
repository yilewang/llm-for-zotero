import { assert } from "chai";
import {
  isPaperPortalItem,
  resolveActiveNoteSession,
  resolveInitialPanelItemState,
} from "../src/modules/contextPanel/portalScope";
import {
  activeConversationModeByLibrary,
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
} from "../src/modules/contextPanel/state";

describe("portalScope resolveInitialPanelItemState", function () {
  const originalZotero = globalThis.Zotero;
  const itemsById = new Map<number, Zotero.Item>();

  before(function () {
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Items: {
        get: (itemId: number) => itemsById.get(itemId) || null,
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
    itemsById.clear();
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

  it("keeps item notes on their own conversation while exposing the parent paper", function () {
    const parentItem = {
      id: 42,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;
    const noteItem = {
      id: 99,
      libraryID: 7,
      parentID: 42,
      isAttachment: () => false,
      isRegularItem: () => false,
      isNote: () => true,
      getNoteTitle: () => "Item Note",
    } as unknown as Zotero.Item;
    itemsById.set(42, parentItem);

    const resolved = resolveInitialPanelItemState(noteItem);
    const session = resolveActiveNoteSession(noteItem);

    assert.equal(resolved.item, noteItem);
    assert.equal(resolved.basePaperItem, parentItem);
    assert.deepEqual(session, {
      noteKind: "item",
      noteId: 99,
      title: "Item Note",
      parentItemId: 42,
      displayConversationKind: "paper",
      capabilities: {
        showModeSwitch: false,
        showNewConversation: false,
        showHistory: false,
        showOpenLock: false,
      },
    });
  });

  it("keeps standalone notes in open-chat semantics without remapping them", function () {
    const noteItem = {
      id: 108,
      libraryID: 7,
      parentID: undefined,
      isAttachment: () => false,
      isRegularItem: () => false,
      isNote: () => true,
      getNoteTitle: () => "Standalone Note",
    } as unknown as Zotero.Item;

    const resolved = resolveInitialPanelItemState(noteItem);
    const session = resolveActiveNoteSession(noteItem);

    assert.equal(resolved.item, noteItem);
    assert.isNull(resolved.basePaperItem);
    assert.isFalse(isPaperPortalItem(resolved.item));
    assert.deepEqual(session, {
      noteKind: "standalone",
      noteId: 108,
      title: "Standalone Note",
      parentItemId: undefined,
      displayConversationKind: "global",
      capabilities: {
        showModeSwitch: false,
        showNewConversation: false,
        showHistory: false,
        showOpenLock: false,
      },
    });
  });
});
