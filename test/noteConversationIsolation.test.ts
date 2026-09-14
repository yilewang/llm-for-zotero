import { createClaudePaperPortalItem } from "../src/claudeCode/portal";
import { createCodexPaperPortalItem } from "../src/codexAppServer/portal";
import { assert } from "chai";
import { getConversationKey } from "../src/modules/contextPanel/conversationIdentity";
import {
  resolveInitialPanelItemState,
  resolveActiveNoteSession,
  resolveConversationBaseItem,
  createPaperPortalItem,
  resolvePaperChatSourceItem,
} from "../src/modules/contextPanel/portalScope";
import { createNoteConversationItem } from "../src/modules/contextPanel/noteEditing/conversationItem";
import {
  restoreConversationComposeContext,
  storedMessagesMatchActivePaper,
} from "../src/modules/contextPanel/chat";
import { readNoteSnapshot } from "../src/modules/contextPanel/noteSnapshot";
import { clearAllRefContextState } from "../src/modules/contextPanel/contexts/paperContextState";
import {
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
  chatHistory,
  loadedConversationKeys,
  selectedPaperContextCache,
  selectedCollectionContextCache,
  selectedTagContextCache,
  clearAllState,
} from "../src/modules/contextPanel/state";

describe("note conversation isolation", function () {
  const originalZotero = (globalThis as any).Zotero;
  const note = (id: number, parentID?: number) =>
    ({
      id,
      parentID,
      libraryID: 1,
      key: `NOTE${id}`,
      isNote: () => true,
      isRegularItem: () => false,
      isAttachment: () => false,
      getNoteTitle: () => `Note ${id}`,
      getField: () => "",
      getNote: () => "<p>Native note</p>",
    }) as unknown as Zotero.Item;
  let standalone: Zotero.Item;
  let child: Zotero.Item;
  beforeEach(function () {
    clearAllState();
    standalone = note(4070);
    child = note(4071, 100);
    const parent = {
      id: 100,
      libraryID: 1,
      isRegularItem: () => true,
      isAttachment: () => false,
      getField: () => "Parent",
    };
    (globalThis as any).Zotero = {
      Prefs: { get: () => undefined },
      Libraries: { userLibraryID: 1 },
      Items: {
        get: (id: number) =>
          new Map([
            [4070, standalone],
            [4071, child],
            [100, parent],
          ]).get(id) || null,
      },
    };
    activeGlobalConversationByLibrary.set(1, 2500000111);
    activePaperConversationByPaper.set("1:100", 1500000111);
  });
  afterEach(function () {
    clearAllState();
    (globalThis as any).Zotero = originalZotero;
  });

  it("opens standalone and child notes in their own item-scoped conversations", function () {
    for (const native of [standalone, child]) {
      const mounted = resolveInitialPanelItemState(native).item!;
      assert.equal(getConversationKey(mounted), native.id);
      assert.equal(resolveConversationBaseItem(mounted)?.id, native.id);
      assert.equal(resolveActiveNoteSession(mounted)?.noteId, native.id);
    }
  });

  it("remounts the note's remembered conversation without consulting library or parent selection", function () {
    activePaperConversationByPaper.set("1:4070", 1500000300);
    activePaperConversationByPaper.set("1:4071", 1500000301);
    assert.equal(
      getConversationKey(resolveInitialPanelItemState(standalone).item!),
      1500000300,
    );
    assert.equal(
      getConversationKey(resolveInitialPanelItemState(child).item!),
      1500000301,
    );
    assert.equal(activeGlobalConversationByLibrary.get(1), 2500000111);
    assert.equal(activePaperConversationByPaper.get("1:100"), 1500000111);
  });

  it("accepts the note's stored references without treating its note ID as a required paper citation", function () {
    const mounted = resolveInitialPanelItemState(standalone).item!;
    assert.isTrue(
      storedMessagesMatchActivePaper(mounted, [
        {
          role: "user",
          text: "Compare this reference",
          timestamp: 1,
          paperContexts: [
            { itemId: 100, contextItemId: 200, title: "Reference" },
          ],
        },
      ] as any),
    );
  });

  it("preserves native note focus when history or standalone navigation constructs an item conversation", function () {
    for (const create of [
      (item: Zotero.Item) => createPaperPortalItem(item, 1500000600, 2),
      (item: Zotero.Item) =>
        createClaudePaperPortalItem(item, 4000000100000600),
      (item: Zotero.Item) => createCodexPaperPortalItem(item, 6000000100000600),
    ]) {
      const mounted = create(child);
      assert.equal(resolveActiveNoteSession(mounted)?.noteId, child.id);
      assert.strictEqual(resolveConversationBaseItem(mounted), child);
      assert.strictEqual(resolvePaperChatSourceItem(mounted), child);
    }
  });

  it("keeps note identity and content independent of the selected conversation", function () {
    const mounted = createNoteConversationItem(
      standalone,
      "upstream",
      1500000200,
    );
    assert.equal(
      mounted.id,
      1500000200,
      "composer identity must be the conversation",
    );
    assert.equal(resolveActiveNoteSession(mounted)?.noteId, 4070);
    assert.equal(readNoteSnapshot(mounted)?.noteId, 4070);
    assert.equal(readNoteSnapshot(mounted)?.text, "Native note");
    assert.equal(standalone.id, 4070, "native item must never be mutated");
  });

  it("new conversation has no old paper, collection or tag context and returning restores only its own", function () {
    const previousKey = 1500000200;
    const nextKey = 1500000201;
    const previous = createNoteConversationItem(
      standalone,
      "upstream",
      previousKey,
    );
    const papers = Array.from({ length: 20 }, (_, i) => ({
      itemId: 100 + i,
      contextItemId: 200 + i,
      title: `Fixture ${i}`,
    }));
    chatHistory.set(previousKey, [
      {
        role: "user",
        text: "Earlier request",
        timestamp: 1,
        paperContexts: papers,
        selectedCollectionContexts: [
          { libraryID: 1, collectionId: 9, name: "Collection" },
        ],
        selectedTagContexts: [
          { libraryID: 1, name: "Tag", normalizedName: "tag" },
        ],
      },
    ]);
    loadedConversationKeys.add(previousKey);
    restoreConversationComposeContext(previous);
    assert.lengthOf(selectedPaperContextCache.get(previous.id) || [], 20);
    // The actual + lifecycle clears the destination, rebinds, then hydrates it.
    clearAllRefContextState(nextKey);
    const next = createNoteConversationItem(previous, "upstream", nextKey);
    chatHistory.set(nextKey, []);
    loadedConversationKeys.add(nextKey);
    restoreConversationComposeContext(next);
    assert.isUndefined(selectedPaperContextCache.get(next.id));
    assert.isUndefined(selectedCollectionContextCache.get(next.id));
    assert.isUndefined(selectedTagContextCache.get(next.id));
    const returned = createNoteConversationItem(next, "upstream", previousKey);
    assert.lengthOf(selectedPaperContextCache.get(returned.id) || [], 20);
    assert.equal(resolveActiveNoteSession(returned)?.noteId, 4070);
  });
});
