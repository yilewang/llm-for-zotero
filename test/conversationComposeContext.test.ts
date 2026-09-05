import { assert } from "chai";
import { restoreConversationComposeContext } from "../src/modules/contextPanel/chat";
import { createGlobalPortalItem } from "../src/modules/contextPanel/portalScope";
import {
  chatHistory,
  initializedConversationComposeContextKeys,
  loadedConversationKeys,
  paperContentSourceOverrides,
  paperContextModeOverrides,
  selectedCollectionContextCache,
  selectedPaperContextCache,
  selectedTagContextCache,
} from "../src/modules/contextPanel/state";

describe("conversation compose context restoration", function () {
  const conversationKey = 2_000_000_123;
  const item = createGlobalPortalItem(1, conversationKey);
  const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };
  const originalZotero = globalScope.Zotero;

  before(function () {
    globalScope.Zotero = {
      Prefs: { get: () => false },
      Libraries: { userLibraryID: 1 },
    };
  });

  after(function () {
    if (originalZotero === undefined) delete globalScope.Zotero;
    else globalScope.Zotero = originalZotero;
  });

  afterEach(function () {
    chatHistory.delete(conversationKey);
    loadedConversationKeys.delete(conversationKey);
    initializedConversationComposeContextKeys.delete(conversationKey);
    selectedPaperContextCache.delete(conversationKey);
    selectedCollectionContextCache.delete(conversationKey);
    selectedTagContextCache.delete(conversationKey);
    paperContextModeOverrides.delete(`${conversationKey}:7:8`);
    paperContentSourceOverrides.delete(`${conversationKey}:7:8`);
  });

  it("hydrates the latest sent paper, collection, and tag context once", function () {
    chatHistory.set(conversationKey, [
      {
        role: "user",
        text: "Continue here",
        timestamp: 100,
        pdfPaperContexts: [
          {
            itemId: 7,
            contextItemId: 8,
            title: "Restored paper",
            contentSourceMode: "pdf",
          },
        ],
        selectedCollectionContexts: [
          { collectionId: 55, libraryID: 1, name: "Methods" },
        ],
        selectedTagContexts: [
          {
            libraryID: 1,
            name: "Stability",
            normalizedName: "stability",
          },
        ],
      },
    ]);
    loadedConversationKeys.add(conversationKey);
    paperContextModeOverrides.set(`${conversationKey}:7:8`, "full-next");
    paperContentSourceOverrides.set(`${conversationKey}:7:8`, "pdf");

    assert.isTrue(restoreConversationComposeContext(item));
    const restoredPapers = selectedPaperContextCache.get(conversationKey) || [];
    assert.lengthOf(restoredPapers, 1);
    assert.deepInclude(restoredPapers[0], {
      itemId: 7,
      contextItemId: 8,
      title: "Restored paper",
    });
    assert.isUndefined(restoredPapers[0]?.contentSourceMode);
    assert.deepEqual(selectedCollectionContextCache.get(conversationKey), [
      { collectionId: 55, name: "Methods", libraryID: 1 },
    ]);
    assert.deepEqual(selectedTagContextCache.get(conversationKey), [
      {
        name: "Stability",
        libraryID: 1,
        normalizedName: "stability",
        scope: undefined,
        includeAutomatic: false,
      },
    ]);
    assert.isFalse(paperContextModeOverrides.has(`${conversationKey}:7:8`));
    assert.isFalse(paperContentSourceOverrides.has(`${conversationKey}:7:8`));

    selectedPaperContextCache.delete(conversationKey);
    selectedCollectionContextCache.delete(conversationKey);
    selectedTagContextCache.delete(conversationKey);
    assert.isFalse(restoreConversationComposeContext(item));
    assert.isUndefined(selectedPaperContextCache.get(conversationKey));
    assert.isUndefined(selectedCollectionContextCache.get(conversationKey));
    assert.isUndefined(selectedTagContextCache.get(conversationKey));
  });

  it("initializes a conversation with no user turns as an empty snapshot", function () {
    chatHistory.set(conversationKey, []);
    loadedConversationKeys.add(conversationKey);

    assert.isTrue(restoreConversationComposeContext(item));
    assert.isTrue(
      initializedConversationComposeContextKeys.has(conversationKey),
    );
    assert.isUndefined(selectedPaperContextCache.get(conversationKey));
    assert.isUndefined(selectedCollectionContextCache.get(conversationKey));
    assert.isUndefined(selectedTagContextCache.get(conversationKey));
  });
});
