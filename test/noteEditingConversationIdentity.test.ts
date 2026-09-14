import { assert } from "chai";
import { getConversationKey } from "../src/modules/contextPanel/conversationIdentity";
import {
  resolveInitialPanelItemState,
  resolveActiveNoteSession,
  resolveDisplayConversationKind,
} from "../src/modules/contextPanel/portalScope";
import {
  activeGlobalConversationByLibrary,
  clearAllState,
} from "../src/modules/contextPanel/state";
import { buildDefaultConversationKey } from "../src/shared/conversationKeySpace";

describe("note editing conversation identity", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  let originalZotero: Record<string, unknown> | undefined;

  before(function () {
    originalZotero = globalScope.Zotero;
  });

  afterEach(function () {
    clearAllState();
    globalScope.Zotero = originalZotero;
  });

  it("routes item notes through their own conversation identity", function () {
    const parentItem = {
      id: 3612,
      libraryID: 1,
      isRegularItem: () => true,
      isAttachment: () => false,
      getField: (field: string) => (field === "title" ? "Parent paper" : ""),
    } as unknown as Zotero.Item;
    const noteItem = {
      id: 3703,
      libraryID: 1,
      parentID: 3612,
      key: "NOTE3703",
      isAttachment: () => false,
      isRegularItem: () => false,
      isNote: () => true,
      getNoteTitle: () => "Figure-by-Figure Analysis",
    } as unknown as Zotero.Item;
    globalScope.Zotero = {
      Items: {
        get: (itemID: number) =>
          itemID === 3612 ? parentItem : itemID === 3703 ? noteItem : null,
      },
      Prefs: {
        get: (key: string) =>
          String(key).endsWith("conversationSystem") ? "upstream" : "",
      },
    };

    const session = resolveActiveNoteSession(noteItem);

    assert.equal(resolveDisplayConversationKind(noteItem), "paper");
    assert.equal(session?.conversationKind, "paper");
    assert.equal(getConversationKey(noteItem), 3703);
  });

  it("routes standalone notes through their own conversation identity", function () {
    const noteItem = {
      id: 3704,
      libraryID: 1,
      parentID: undefined,
      key: "NOTE3704",
      isAttachment: () => false,
      isRegularItem: () => false,
      isNote: () => true,
      getNoteTitle: () => "Standalone Analysis",
    } as unknown as Zotero.Item;
    globalScope.Zotero = {
      Items: {
        get: (itemID: number) => (itemID === 3704 ? noteItem : null),
      },
      Prefs: {
        get: (key: string) =>
          String(key).endsWith("conversationSystem") ? "upstream" : "",
      },
    };

    const session = resolveActiveNoteSession(noteItem);

    assert.equal(resolveDisplayConversationKind(noteItem), "paper");
    assert.equal(session?.conversationKind, "paper");
    assert.equal(
      getConversationKey(noteItem),
      buildDefaultConversationKey("upstream", "paper", 3704),
    );
  });
  it("keeps each mounted note conversation stable when another surface navigates", function () {
    const note = {
      id: 3975,
      libraryID: 1,
      isNote: () => true,
      isAttachment: () => false,
      getNoteTitle: () => "Note",
    } as unknown as Zotero.Item;
    globalScope.Zotero = {
      Prefs: { get: () => undefined },
      Items: { get: () => note },
    };
    activeGlobalConversationByLibrary.set(1, 2500000111);
    const first = resolveInitialPanelItemState(note).item!;
    activeGlobalConversationByLibrary.set(1, 2500000112);
    const second = resolveInitialPanelItemState(note).item!;
    assert.equal(getConversationKey(first), 3975);
    assert.equal(getConversationKey(second), 3975);
    assert.notStrictEqual(first, second);
    assert.equal(resolveActiveNoteSession(first)?.noteId, 3975);
  });
});
