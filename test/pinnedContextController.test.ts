import { assert } from "chai";
import type {
  ChatAttachment,
  PaperContextRef,
  SelectedTextContext,
} from "../src/modules/contextPanel/types";
import {
  isPinnedSelectedText,
  prunePinnedSelectedTextKeys,
  retainPinnedFiles,
  retainPinnedImages,
  retainPinnedPapers,
  retainPinnedSelectedTextContexts,
  togglePinnedFile,
  togglePinnedImage,
  togglePinnedPaper,
  togglePinnedSelectedText,
} from "../src/modules/contextPanel/setupHandlers/controllers/pinnedContextController";

describe("pinnedContextController", function () {
  it("retains pinned selected text contexts and prunes stale keys", function () {
    const pinned = new Map<number, Set<string>>();
    const ownerId = 11;
    const contextA: SelectedTextContext = {
      text: "alpha",
      source: "pdf",
    };
    const contextB: SelectedTextContext = {
      text: "beta",
      source: "model",
    };
    const contextC: SelectedTextContext = {
      text: "gamma",
      source: "pdf",
      paperContext: {
        itemId: 99,
        contextItemId: 100,
        title: "Paper",
      },
    };

    assert.isTrue(togglePinnedSelectedText(pinned, ownerId, contextA));
    assert.isTrue(togglePinnedSelectedText(pinned, ownerId, contextC));
    assert.isTrue(isPinnedSelectedText(pinned, ownerId, contextA));
    assert.isFalse(isPinnedSelectedText(pinned, ownerId, contextB));

    const retained = retainPinnedSelectedTextContexts(pinned, ownerId, [
      contextA,
      contextB,
      contextC,
    ]);
    assert.deepEqual(retained, [contextA, contextC]);

    prunePinnedSelectedTextKeys(pinned, ownerId, [contextC]);
    assert.isFalse(isPinnedSelectedText(pinned, ownerId, contextA));
    assert.isTrue(isPinnedSelectedText(pinned, ownerId, contextC));
  });

  it("retains pinned images by deterministic key", function () {
    const pinned = new Map<number, Set<string>>();
    const ownerId = 13;
    const imgA = "data:image/png;base64,AAA";
    const imgB = "data:image/png;base64,BBB";
    assert.isTrue(togglePinnedImage(pinned, ownerId, imgA));
    const retained = retainPinnedImages(pinned, ownerId, [imgA, imgB]);
    assert.deepEqual(retained, [imgA]);
  });

  it("keeps file pinning stable across replacement by the same attachment id", function () {
    const pinned = new Map<number, Set<string>>();
    const ownerId = 17;
    const fileA: ChatAttachment = {
      id: "file-a",
      name: "a.txt",
      mimeType: "text/plain",
      sizeBytes: 10,
      category: "text",
    };
    const fileAReplaced: ChatAttachment = {
      ...fileA,
      name: "a-updated.txt",
      sizeBytes: 14,
    };
    const fileB: ChatAttachment = {
      id: "file-b",
      name: "b.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      category: "text",
    };

    assert.isTrue(togglePinnedFile(pinned, ownerId, fileA));
    const retained = retainPinnedFiles(pinned, ownerId, [fileAReplaced, fileB]);
    assert.deepEqual(retained, [fileAReplaced]);
  });

  it("retains pinned paper contexts", function () {
    const pinned = new Map<number, Set<string>>();
    const ownerId = 19;
    const paperA: PaperContextRef = {
      itemId: 1,
      contextItemId: 2,
      title: "Paper A",
    };
    const paperB: PaperContextRef = {
      itemId: 3,
      contextItemId: 4,
      title: "Paper B",
    };
    assert.isTrue(togglePinnedPaper(pinned, ownerId, paperA));
    const retained = retainPinnedPapers(pinned, ownerId, [paperA, paperB]);
    assert.deepEqual(retained, [paperA]);
  });
});
