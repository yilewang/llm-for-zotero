import { assert } from "chai";
import type {
  ChatAttachment,
  PaperContextRef,
  SelectedTextContext,
} from "../src/modules/contextPanel/types";
import {
  isPinnedFile,
  isPinnedImage,
  isPinnedPaper,
  isPinnedSelectedText,
  prunePinnedFileKeys,
  prunePinnedImageKeys,
  prunePinnedSelectedTextKeys,
  prunePinnedPaperKeys,
  removePinnedFile,
  removePinnedImage,
  removePinnedPaper,
  removePinnedSelectedText,
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

  it("treats identical selected text on different pages as distinct keys", function () {
    const pinned = new Map<number, Set<string>>();
    const ownerId = 12;
    const pageOne: SelectedTextContext = {
      text: "same snippet",
      source: "pdf",
      contextItemId: 200,
      pageIndex: 0,
      pageLabel: "1",
    };
    const pageTwo: SelectedTextContext = {
      text: "same snippet",
      source: "pdf",
      contextItemId: 200,
      pageIndex: 1,
      pageLabel: "2",
    };

    assert.isTrue(togglePinnedSelectedText(pinned, ownerId, pageOne));
    assert.isTrue(togglePinnedSelectedText(pinned, ownerId, pageTwo));
    assert.isTrue(isPinnedSelectedText(pinned, ownerId, pageOne));
    assert.isTrue(isPinnedSelectedText(pinned, ownerId, pageTwo));

    const retained = retainPinnedSelectedTextContexts(pinned, ownerId, [
      pageOne,
      pageTwo,
    ]);
    assert.deepEqual(retained, [pageOne, pageTwo]);
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

  it("prunes stale paper pins without dropping remaining paper contexts", function () {
    const pinned = new Map<number, Set<string>>();
    const ownerId = 23;
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
    const removedPaper: PaperContextRef = {
      itemId: 5,
      contextItemId: 6,
      title: "Paper C",
    };

    assert.isTrue(togglePinnedPaper(pinned, ownerId, paperA));
    assert.isTrue(togglePinnedPaper(pinned, ownerId, removedPaper));

    prunePinnedPaperKeys(pinned, ownerId, [paperA, paperB]);

    assert.isTrue(isPinnedPaper(pinned, ownerId, paperA));
    assert.isFalse(isPinnedPaper(pinned, ownerId, removedPaper));
    assert.isFalse(isPinnedPaper(pinned, ownerId, paperB));
  });

  describe("characterization of each pinned kind", function () {
    const textA: SelectedTextContext = { text: "alpha", source: "pdf" };
    const textB: SelectedTextContext = { text: "beta", source: "model" };
    const fileA: ChatAttachment = {
      id: "file-a",
      name: "a.txt",
      mimeType: "text/plain",
      sizeBytes: 10,
      category: "text",
    };
    const fileB: ChatAttachment = {
      id: "file-b",
      name: "b.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      category: "text",
    };
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

    type KindCase<T> = {
      name: string;
      a: T;
      b: T;
      isPinned: (m: Map<number, Set<string>>, o: number, v: T) => boolean;
      toggle: (m: Map<number, Set<string>>, o: number, v: T) => boolean;
      remove: (m: Map<number, Set<string>>, o: number, v: T) => void;
      retain: (m: Map<number, Set<string>>, o: number, v: T[]) => T[];
      prune: (m: Map<number, Set<string>>, o: number, v: T[]) => void;
    };

    const cases: KindCase<any>[] = [
      {
        name: "selected text",
        a: textA,
        b: textB,
        isPinned: isPinnedSelectedText,
        toggle: togglePinnedSelectedText,
        remove: removePinnedSelectedText,
        retain: retainPinnedSelectedTextContexts,
        prune: prunePinnedSelectedTextKeys,
      } as KindCase<SelectedTextContext>,
      {
        name: "image",
        a: "data:image/png;base64,AAA",
        b: "data:image/png;base64,BBB",
        isPinned: isPinnedImage,
        toggle: togglePinnedImage,
        remove: removePinnedImage,
        retain: retainPinnedImages,
        prune: prunePinnedImageKeys,
      } as KindCase<string>,
      {
        name: "file",
        a: fileA,
        b: fileB,
        isPinned: isPinnedFile,
        toggle: togglePinnedFile,
        remove: removePinnedFile,
        retain: retainPinnedFiles,
        prune: prunePinnedFileKeys,
      } as KindCase<ChatAttachment>,
      {
        name: "paper",
        a: paperA,
        b: paperB,
        isPinned: isPinnedPaper,
        toggle: togglePinnedPaper,
        remove: removePinnedPaper,
        retain: retainPinnedPapers,
        prune: prunePinnedPaperKeys,
      } as KindCase<PaperContextRef>,
    ];

    for (const kind of cases) {
      describe(kind.name, function () {
        it("toggle returns the new pinned state and drops an empty owner", function () {
          const pinned = new Map<number, Set<string>>();
          assert.isTrue(kind.toggle(pinned, 5, kind.a));
          assert.isTrue(kind.isPinned(pinned, 5, kind.a));
          assert.isFalse(kind.isPinned(pinned, 5, kind.b));
          assert.isFalse(kind.toggle(pinned, 5, kind.a));
          assert.isFalse(kind.isPinned(pinned, 5, kind.a));
          assert.isFalse(pinned.has(5));
        });

        it("remove deletes one key and drops the owner when it empties", function () {
          const pinned = new Map<number, Set<string>>();
          kind.toggle(pinned, 7, kind.a);
          kind.toggle(pinned, 7, kind.b);
          kind.remove(pinned, 7, kind.a);
          assert.isFalse(kind.isPinned(pinned, 7, kind.a));
          assert.isTrue(kind.isPinned(pinned, 7, kind.b));
          assert.equal(pinned.get(7)?.size, 1);
          kind.remove(pinned, 7, kind.b);
          assert.isFalse(pinned.has(7));
          // Removing from an absent owner is a no-op and creates nothing.
          kind.remove(pinned, 8, kind.a);
          assert.isFalse(pinned.has(8));
        });

        it("normalizes fractional owners and floors them", function () {
          const pinned = new Map<number, Set<string>>();
          assert.isTrue(kind.toggle(pinned, 9.7, kind.a));
          assert.isTrue(pinned.has(9));
          assert.isTrue(kind.isPinned(pinned, 9, kind.a));
        });

        it("owner 0: toggle writes under 0, reads and removes ignore it", function () {
          for (const owner of [0, -3, Number.NaN]) {
            const pinned = new Map<number, Set<string>>();
            assert.isTrue(kind.toggle(pinned, owner, kind.a));
            assert.deepEqual(Array.from(pinned.keys()), [0]);
            assert.equal(pinned.get(0)?.size, 1);
            // Read-only getter yields null for owner 0.
            assert.isFalse(kind.isPinned(pinned, owner, kind.a));
            kind.remove(pinned, owner, kind.a);
            assert.equal(pinned.get(0)?.size, 1);
            kind.prune(pinned, owner, []);
            assert.equal(pinned.get(0)?.size, 1);
            // A second toggle still sees the key (creating getter), deletes
            // it, and leaves an empty set because cleanup skips owner 0.
            assert.isFalse(kind.toggle(pinned, owner, kind.a));
            assert.isTrue(pinned.has(0));
            assert.equal(pinned.get(0)?.size, 0);
          }
        });

        it("owner 0: retain deletes the owner-0 entry and returns []", function () {
          const pinned = new Map<number, Set<string>>();
          kind.toggle(pinned, 0, kind.a);
          assert.deepEqual(kind.retain(pinned, 0, [kind.a]), []);
          assert.isFalse(pinned.has(0));
        });

        it("retain keeps original identities and prunes stale keys", function () {
          const pinned = new Map<number, Set<string>>();
          kind.toggle(pinned, 4, kind.a);
          const retained = kind.retain(pinned, 4, [kind.b, kind.a]);
          assert.lengthOf(retained, 1);
          assert.strictEqual(retained[0], kind.a);
          assert.isTrue(kind.isPinned(pinned, 4, kind.a));
        });

        it("retain prunes keys whose values are absent from the input", function () {
          const pinned = new Map<number, Set<string>>();
          kind.toggle(pinned, 4, kind.a);
          kind.toggle(pinned, 4, kind.b);
          const retained = kind.retain(pinned, 4, [kind.b]);
          assert.lengthOf(retained, 1);
          assert.strictEqual(retained[0], kind.b);
          assert.isFalse(kind.isPinned(pinned, 4, kind.a));
          assert.equal(pinned.get(4)?.size, 1);
        });

        it("retain with no matching values drops the owner entry", function () {
          const pinned = new Map<number, Set<string>>();
          kind.toggle(pinned, 4, kind.a);
          assert.deepEqual(kind.retain(pinned, 4, [kind.b]), []);
          assert.isFalse(pinned.has(4));
        });

        it("retain with an empty list deletes the owner entry", function () {
          const pinned = new Map<number, Set<string>>();
          kind.toggle(pinned, 4, kind.a);
          assert.deepEqual(kind.retain(pinned, 4, []), []);
          assert.isFalse(pinned.has(4));
        });

        it("retain on an empty owner set deletes the entry and returns []", function () {
          const pinned = new Map<number, Set<string>>([[4, new Set()]]);
          assert.deepEqual(kind.retain(pinned, 4, [kind.a]), []);
          assert.isFalse(pinned.has(4));
        });

        it("prune keeps only valid keys and drops an owner that empties", function () {
          const pinned = new Map<number, Set<string>>();
          kind.toggle(pinned, 6, kind.a);
          kind.toggle(pinned, 6, kind.b);
          kind.prune(pinned, 6, [kind.b]);
          assert.isFalse(kind.isPinned(pinned, 6, kind.a));
          assert.isTrue(kind.isPinned(pinned, 6, kind.b));
          kind.prune(pinned, 6, []);
          assert.isFalse(pinned.has(6));
        });
      });
    }

    it("ignores an empty or blank image URL on toggle and remove", function () {
      const pinned = new Map<number, Set<string>>();
      assert.isFalse(togglePinnedImage(pinned, 3, ""));
      assert.isFalse(togglePinnedImage(pinned, 3, "   "));
      assert.equal(pinned.size, 0);
      togglePinnedImage(pinned, 3, "data:image/png;base64,AAA");
      removePinnedImage(pinned, 3, "  ");
      assert.equal(pinned.get(3)?.size, 1);
      assert.isFalse(isPinnedImage(pinned, 3, ""));
    });

    it("trims image URLs into the same key", function () {
      const pinned = new Map<number, Set<string>>();
      assert.isTrue(togglePinnedImage(pinned, 3, "  img://x  "));
      assert.isTrue(isPinnedImage(pinned, 3, "img://x"));
    });

    it("keys an id-less file by name, MIME type, and size", function () {
      const pinned = new Map<number, Set<string>>();
      const noId: ChatAttachment = {
        id: "  ",
        name: "n.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        category: "text",
      };
      assert.isTrue(togglePinnedFile(pinned, 3, noId));
      assert.isTrue(isPinnedFile(pinned, 3, { ...noId, id: "" }));
      assert.isFalse(isPinnedFile(pinned, 3, { ...noId, sizeBytes: 4 }));
    });
  });
});
