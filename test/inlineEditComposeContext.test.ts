import { assert } from "chai";
import { syncComposeContextForInlineEditForTests } from "../src/modules/contextPanel/chat";
import { bindProvisionedConversationKey } from "../src/modules/contextPanel/conversationIdentity";
import { createGlobalPortalItem } from "../src/modules/contextPanel/portalScope";
import {
  activeContextPanelStateSync,
  initializedConversationComposeContextKeys,
  paperContentSourceOverrides,
  paperContextModeOverrides,
  selectedCollectionContextCache,
  selectedFileAttachmentCache,
  selectedImageCache,
  selectedPaperContextCache,
  selectedTagContextCache,
  selectedTextCache,
} from "../src/modules/contextPanel/state";

describe("inline edit compose context sync", function () {
  // The panel item id and the conversation key differ, so the test shows
  // which compose-context caches each one keys.
  const itemId = 2_000_000_301;
  const conversationKey = 2_000_000_302;
  const item = createGlobalPortalItem(1, itemId);
  bindProvisionedConversationKey(item, conversationKey);
  const body = {} as Element;
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
    for (const key of [itemId, conversationKey]) {
      selectedTextCache.delete(key);
      selectedImageCache.delete(key);
      selectedFileAttachmentCache.delete(key);
      selectedPaperContextCache.delete(key);
      selectedCollectionContextCache.delete(key);
      selectedTagContextCache.delete(key);
      initializedConversationComposeContextKeys.delete(key);
    }
    paperContextModeOverrides.clear();
    paperContentSourceOverrides.clear();
    activeContextPanelStateSync.delete(body);
  });

  it("loads the edited turn's context under the item id and marks the conversation key", function () {
    paperContextModeOverrides.set(`${itemId}:1:1`, "full-sticky");
    paperContextModeOverrides.set(`9:1:1`, "full-sticky");
    let synced = 0;
    activeContextPanelStateSync.set(body, () => {
      synced += 1;
    });

    syncComposeContextForInlineEditForTests(body, item, {
      role: "user",
      text: "edit me",
      timestamp: 1,
      selectedTextContexts: [{ text: "a passage", source: "pdf" }],
      screenshotImages: [" data:image/png;base64,AA== ", ""],
      attachments: [
        {
          id: " att-1 ",
          name: " notes.md ",
          mimeType: "text/markdown",
          sizeBytes: 3,
          category: "markdown",
        },
      ],
      paperContexts: [{ itemId: 7, contextItemId: 8, title: "Retrieval" }],
      fullTextPaperContexts: [
        {
          itemId: 9,
          contextItemId: 10,
          title: "Full text",
          contentSourceMode: "mineru",
        },
      ],
      selectedCollectionContexts: [
        { collectionId: 55, libraryID: 1, name: "Methods" },
      ],
      selectedTagContexts: [
        { libraryID: 1, name: "Stability", normalizedName: "stability" },
      ],
    });

    assert.deepEqual(
      (selectedTextCache.get(conversationKey) || []).map((entry) => entry.text),
      ["a passage"],
    );
    assert.isFalse(selectedTextCache.has(itemId));
    assert.deepEqual(selectedImageCache.get(itemId), [
      "data:image/png;base64,AA==",
    ]);
    assert.deepEqual(
      (selectedFileAttachmentCache.get(itemId) || []).map((file) => file.id),
      ["att-1"],
    );
    assert.deepEqual(
      (selectedPaperContextCache.get(itemId) || []).map(
        (paper) => `${paper.itemId}:${paper.contextItemId}`,
      ),
      ["7:8", "9:10"],
    );
    assert.lengthOf(selectedCollectionContextCache.get(itemId) || [], 1);
    assert.lengthOf(selectedTagContextCache.get(itemId) || [], 1);
    for (const cache of [
      selectedImageCache,
      selectedFileAttachmentCache,
      selectedPaperContextCache,
      selectedCollectionContextCache,
      selectedTagContextCache,
    ]) {
      assert.isFalse(cache.has(conversationKey));
    }

    assert.deepEqual(Array.from(paperContextModeOverrides.entries()).sort(), [
      [`${itemId}:9:10`, "full-next"],
      ["9:1:1", "full-sticky"],
    ]);
    assert.deepEqual(Array.from(paperContentSourceOverrides.entries()).sort(), [
      [`${itemId}:7:8`, "text"],
      [`${itemId}:9:10`, "mineru"],
    ]);
    assert.isTrue(
      initializedConversationComposeContextKeys.has(conversationKey),
    );
    assert.isFalse(initializedConversationComposeContextKeys.has(itemId));
    assert.strictEqual(synced, 1);
  });

  it("deletes the item's lists when the edited turn carried none", function () {
    selectedImageCache.set(itemId, ["data:image/png;base64,AA=="]);
    selectedFileAttachmentCache.set(itemId, [
      {
        id: "att-1",
        name: "a.md",
        mimeType: "text/markdown",
        sizeBytes: 1,
        category: "markdown",
      },
    ]);
    selectedPaperContextCache.set(itemId, [
      { itemId: 7, contextItemId: 8, title: "Old" },
    ]);
    selectedCollectionContextCache.set(itemId, [
      { collectionId: 1, libraryID: 1, name: "Old" },
    ]);
    selectedTagContextCache.set(itemId, [{ libraryID: 1, name: "old" }]);

    syncComposeContextForInlineEditForTests(body, item, {
      role: "user",
      text: "edit me",
      timestamp: 1,
    });

    for (const cache of [
      selectedImageCache,
      selectedFileAttachmentCache,
      selectedPaperContextCache,
      selectedCollectionContextCache,
      selectedTagContextCache,
    ]) {
      assert.isFalse(cache.has(itemId));
    }
    assert.isTrue(
      initializedConversationComposeContextKeys.has(conversationKey),
    );
  });
});
