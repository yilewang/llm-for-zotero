import { assert } from "chai";
import { describe, it, afterEach } from "mocha";
import {
  clearUserAddedContextForItem,
  hasUserAddedContextForItem,
} from "../src/modules/contextPanel/contextSelectionActions";
import {
  getPaperContentSourceOverride,
  getPaperModeOverride,
  setPaperContentSourceOverride,
  setPaperModeOverride,
} from "../src/modules/contextPanel/contexts/paperContextState";
import {
  getSelectedTextContextEntries,
  setSelectedTextContextEntries,
} from "../src/modules/contextPanel/contextResolution";
import {
  pinnedFileKeys,
  pinnedImageKeys,
  pinnedSelectedTextKeys,
  selectedCollectionContextCache,
  selectedFileAttachmentCache,
  selectedFilePreviewExpandedCache,
  selectedImageCache,
  selectedImagePreviewActiveIndexCache,
  selectedImagePreviewExpandedCache,
  selectedOtherRefContextCache,
  selectedPaperContextCache,
  selectedPaperPreviewExpandedCache,
  selectedTagContextCache,
} from "../src/modules/contextPanel/state";
import type { PaperContextRef } from "../src/modules/contextPanel/types";

function paper(itemId: number, contextItemId: number): PaperContextRef {
  return {
    itemId,
    contextItemId,
    title: `Paper ${itemId}`,
  };
}

function clearState(ownerItemId: number, textContextKey = ownerItemId): void {
  selectedPaperContextCache.delete(ownerItemId);
  selectedOtherRefContextCache.delete(ownerItemId);
  selectedCollectionContextCache.delete(ownerItemId);
  selectedTagContextCache.delete(ownerItemId);
  selectedPaperPreviewExpandedCache.delete(ownerItemId);
  selectedImageCache.delete(ownerItemId);
  selectedImagePreviewExpandedCache.delete(ownerItemId);
  selectedImagePreviewActiveIndexCache.delete(ownerItemId);
  selectedFileAttachmentCache.delete(ownerItemId);
  selectedFilePreviewExpandedCache.delete(ownerItemId);
  pinnedImageKeys.delete(ownerItemId);
  pinnedFileKeys.delete(ownerItemId);
  pinnedSelectedTextKeys.delete(textContextKey);
  setSelectedTextContextEntries(textContextKey, []);
}

describe("clear all compose context", function () {
  afterEach(function () {
    clearState(9001, 9101);
    clearState(9002, 9102);
  });

  it("clears user-added paper-chat context while retaining the auto-loaded paper overrides", function () {
    const ownerItemId = 9001;
    const textContextKey = 9101;
    const autoLoaded = paper(100, 101);
    const manual = paper(200, 201);

    selectedPaperContextCache.set(ownerItemId, [manual]);
    selectedOtherRefContextCache.set(ownerItemId, [
      { contextItemId: 301, title: "supplement.zip", refKind: "other" },
    ]);
    selectedCollectionContextCache.set(ownerItemId, [
      { collectionId: 401, name: "Collection", libraryID: 1 },
    ]);
    selectedTagContextCache.set(ownerItemId, [
      { name: "Tag", normalizedName: "tag", libraryID: 1 },
    ]);
    selectedImageCache.set(ownerItemId, ["data:image/png;base64,abc"]);
    selectedImagePreviewExpandedCache.set(ownerItemId, true);
    selectedImagePreviewActiveIndexCache.set(ownerItemId, 0);
    selectedFileAttachmentCache.set(ownerItemId, [
      { id: "file-1", name: "table.csv", mimeType: "text/csv" } as any,
    ]);
    selectedFilePreviewExpandedCache.set(ownerItemId, true);
    setSelectedTextContextEntries(textContextKey, [
      { text: "selected passage", source: "pdf" },
    ]);
    pinnedSelectedTextKeys.set(textContextKey, new Set(["selected-text"]));
    pinnedImageKeys.set(ownerItemId, new Set(["image"]));
    pinnedFileKeys.set(ownerItemId, new Set(["file"]));
    setPaperModeOverride(ownerItemId, autoLoaded, "full-sticky");
    setPaperContentSourceOverride(ownerItemId, autoLoaded, "pdf");
    setPaperModeOverride(ownerItemId, manual, "full-next");
    setPaperContentSourceOverride(ownerItemId, manual, "mineru");

    assert.isTrue(
      hasUserAddedContextForItem({
        itemId: ownerItemId,
        textContextKey,
      }),
    );

    const result = clearUserAddedContextForItem({
      itemId: ownerItemId,
      textContextKey,
    });

    assert.isTrue(result.changed);
    assert.isUndefined(selectedPaperContextCache.get(ownerItemId));
    assert.isUndefined(selectedOtherRefContextCache.get(ownerItemId));
    assert.isUndefined(selectedCollectionContextCache.get(ownerItemId));
    assert.isUndefined(selectedTagContextCache.get(ownerItemId));
    assert.isUndefined(selectedImageCache.get(ownerItemId));
    assert.isUndefined(selectedFileAttachmentCache.get(ownerItemId));
    assert.deepEqual(getSelectedTextContextEntries(textContextKey), []);
    assert.isUndefined(pinnedSelectedTextKeys.get(textContextKey));
    assert.isUndefined(pinnedImageKeys.get(ownerItemId));
    assert.isUndefined(pinnedFileKeys.get(ownerItemId));
    assert.equal(getPaperModeOverride(ownerItemId, autoLoaded), "full-sticky");
    assert.equal(getPaperContentSourceOverride(ownerItemId, autoLoaded), "pdf");
    assert.isNull(getPaperModeOverride(ownerItemId, manual));
    assert.isNull(getPaperContentSourceOverride(ownerItemId, manual));
    assert.isFalse(
      hasUserAddedContextForItem({
        itemId: ownerItemId,
        textContextKey,
      }),
    );
  });

  it("clears all selected context in library chat", function () {
    const ownerItemId = 9002;
    const textContextKey = 9102;
    const selectedPaper = paper(500, 501);

    selectedPaperContextCache.set(ownerItemId, [selectedPaper]);
    selectedOtherRefContextCache.set(ownerItemId, [
      { contextItemId: 601, title: "dataset.bin", refKind: "other" },
    ]);
    selectedCollectionContextCache.set(ownerItemId, [
      { collectionId: 701, name: "Collection", libraryID: 1 },
    ]);
    selectedTagContextCache.set(ownerItemId, [
      { name: "Drift", normalizedName: "drift", libraryID: 1 },
    ]);
    setSelectedTextContextEntries(textContextKey, [
      { text: "library note", source: "note", contextItemId: 801 },
    ]);
    selectedImageCache.set(ownerItemId, ["data:image/png;base64,def"]);
    selectedFileAttachmentCache.set(ownerItemId, [
      { id: "file-2", name: "notes.md", mimeType: "text/markdown" } as any,
    ]);

    const result = clearUserAddedContextForItem({
      itemId: ownerItemId,
      textContextKey,
    });

    assert.isTrue(result.changed);
    assert.isUndefined(selectedPaperContextCache.get(ownerItemId));
    assert.isUndefined(selectedOtherRefContextCache.get(ownerItemId));
    assert.isUndefined(selectedCollectionContextCache.get(ownerItemId));
    assert.isUndefined(selectedTagContextCache.get(ownerItemId));
    assert.deepEqual(getSelectedTextContextEntries(textContextKey), []);
    assert.isUndefined(selectedImageCache.get(ownerItemId));
    assert.isUndefined(selectedFileAttachmentCache.get(ownerItemId));
  });
});
