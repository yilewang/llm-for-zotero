import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import { composeContextStore } from "../src/modules/contextPanel/contexts/composeContextStore";
import {
  initializedConversationComposeContextKeys,
  paperContentSourceOverrides,
  paperContextModeOverrides,
  pinnedFileKeys,
  pinnedImageKeys,
  pinnedSelectedTextKeys,
  selectedCollectionContextCache,
  selectedFileAttachmentCache,
  selectedFilePreviewExpandedCache,
  selectedImageCache,
  selectedImagePreviewActiveIndexCache,
  selectedImagePreviewExpandedCache,
  selectedNotePreviewExpandedCache,
  selectedOtherRefContextCache,
  selectedPaperContextCache,
  selectedPaperContextListExpandedCache,
  selectedPaperPreviewExpandedCache,
  selectedTagContextCache,
  selectedTextCache,
  selectedTextPreviewExpandedCache,
} from "../src/modules/contextPanel/state";
import type {
  ChatAttachment,
  CollectionContextRef,
  OtherContextRef,
  PaperContextRef,
  SelectedTextContext,
  TagContextRef,
} from "../src/modules/contextPanel/types";

const OWNER = 7101;

const paper = (itemId: number, contextItemId: number): PaperContextRef => ({
  itemId,
  contextItemId,
  title: `Paper ${itemId}`,
});

type BackingMap<V> = {
  get(key: number): V | undefined;
  set(key: number, value: V): unknown;
  has(key: number): boolean;
  delete(key: number): boolean;
};

type SlotCase<V> = {
  name: string;
  map: BackingMap<V>;
  slot: {
    get(ownerId: number): V | undefined;
    has(ownerId: number): boolean;
    set(ownerId: number, value: V): void;
    delete(ownerId: number): boolean;
  };
  value: V;
};

function slotCase<V>(entry: SlotCase<V>): SlotCase<unknown> {
  return entry as unknown as SlotCase<unknown>;
}

const collection: CollectionContextRef = {
  collectionId: 11,
  libraryID: 1,
  name: "Folder",
};
const tag: TagContextRef = { libraryID: 1, name: "drift" };
const otherRef: OtherContextRef = {
  contextItemId: 12,
  title: "Figure",
  contentType: "image/png",
  refKind: "figure",
};
const file: ChatAttachment = {
  id: "att-1",
  name: "notes.md",
  mimeType: "text/markdown",
  sizeBytes: 3,
  category: "markdown",
};
const text: SelectedTextContext = { text: "a passage", source: "pdf" };

const slotCases: SlotCase<unknown>[] = [
  slotCase({
    name: "papers",
    map: selectedPaperContextCache,
    slot: composeContextStore.papers,
    value: [paper(1, 2)],
  }),
  slotCase({
    name: "otherRefs",
    map: selectedOtherRefContextCache,
    slot: composeContextStore.otherRefs,
    value: [otherRef],
  }),
  slotCase({
    name: "collections",
    map: selectedCollectionContextCache,
    slot: composeContextStore.collections,
    value: [collection],
  }),
  slotCase({
    name: "tags",
    map: selectedTagContextCache,
    slot: composeContextStore.tags,
    value: [tag],
  }),
  slotCase({
    name: "paperPreviewExpanded",
    map: selectedPaperPreviewExpandedCache,
    slot: composeContextStore.paperPreviewExpanded,
    value: 2 as number | false,
  }),
  slotCase({
    name: "paperListExpanded",
    map: selectedPaperContextListExpandedCache,
    slot: composeContextStore.paperListExpanded,
    value: true,
  }),
  slotCase({
    name: "images",
    map: selectedImageCache,
    slot: composeContextStore.images,
    value: ["data:image/png;base64,AA=="],
  }),
  slotCase({
    name: "imagePreviewExpanded",
    map: selectedImagePreviewExpandedCache,
    slot: composeContextStore.imagePreviewExpanded,
    value: true,
  }),
  slotCase({
    name: "imagePreviewActiveIndex",
    map: selectedImagePreviewActiveIndexCache,
    slot: composeContextStore.imagePreviewActiveIndex,
    value: 1,
  }),
  slotCase({
    name: "files",
    map: selectedFileAttachmentCache,
    slot: composeContextStore.files,
    value: [file],
  }),
  slotCase({
    name: "filePreviewExpanded",
    map: selectedFilePreviewExpandedCache,
    slot: composeContextStore.filePreviewExpanded,
    value: true,
  }),
  slotCase({
    name: "selectedTexts",
    map: selectedTextCache,
    slot: composeContextStore.selectedTexts,
    value: [text],
  }),
  slotCase({
    name: "selectedTextExpandedIndex",
    map: selectedTextPreviewExpandedCache,
    slot: composeContextStore.selectedTextExpandedIndex,
    value: 0,
  }),
  slotCase({
    name: "notePreviewExpanded",
    map: selectedNotePreviewExpandedCache,
    slot: composeContextStore.notePreviewExpanded,
    value: true,
  }),
];

describe("composeContextStore", function () {
  afterEach(function () {
    for (const entry of slotCases) entry.map.delete(OWNER);
    initializedConversationComposeContextKeys.delete(OWNER);
    paperContextModeOverrides.clear();
    paperContentSourceOverrides.clear();
  });

  for (const entry of slotCases) {
    describe(entry.name, function () {
      it("reads what the state map holds", function () {
        assert.isFalse(entry.slot.has(OWNER));
        assert.isUndefined(entry.slot.get(OWNER));
        entry.map.set(OWNER, entry.value);
        assert.isTrue(entry.slot.has(OWNER));
        assert.strictEqual(entry.slot.get(OWNER), entry.value);
      });

      it("writes into the state map", function () {
        entry.slot.set(OWNER, entry.value);
        assert.strictEqual(entry.map.get(OWNER), entry.value);
        assert.isTrue(entry.slot.delete(OWNER));
        assert.isFalse(entry.map.has(OWNER));
        assert.isFalse(entry.slot.delete(OWNER));
      });
    });
  }

  describe("list kinds", function () {
    const listCases = [
      { map: selectedPaperContextCache, slot: composeContextStore.papers },
      { map: selectedImageCache, slot: composeContextStore.images },
      { map: selectedFileAttachmentCache, slot: composeContextStore.files },
      { map: selectedTextCache, slot: composeContextStore.selectedTexts },
    ] as const;

    it("list returns the stored array itself, or a new empty array", function () {
      for (const { map, slot } of listCases) {
        const empty = (slot.list as (ownerId: number) => unknown[])(OWNER);
        assert.deepEqual(empty, []);
        const stored: unknown[] = [];
        (map as BackingMap<unknown[]>).set(OWNER, stored);
        assert.strictEqual(
          (slot.list as (ownerId: number) => unknown[])(OWNER),
          stored,
        );
        map.delete(OWNER);
      }
    });

    it("replace stores a non-empty list as given and deletes on empty", function () {
      const next = [paper(3, 4)];
      composeContextStore.papers.replace(OWNER, next);
      assert.strictEqual(selectedPaperContextCache.get(OWNER), next);
      composeContextStore.papers.replace(OWNER, []);
      assert.isFalse(selectedPaperContextCache.has(OWNER));
      selectedPaperContextCache.set(OWNER, next);
      composeContextStore.papers.replace(OWNER, undefined);
      assert.isFalse(selectedPaperContextCache.has(OWNER));
    });
  });

  describe("pinned keys", function () {
    it("names the state's pin maps", function () {
      assert.strictEqual(
        composeContextStore.pinnedKeys.selectedTexts,
        pinnedSelectedTextKeys,
      );
      assert.strictEqual(
        composeContextStore.pinnedKeys.images,
        pinnedImageKeys,
      );
      assert.strictEqual(composeContextStore.pinnedKeys.files, pinnedFileKeys);
    });
  });

  describe("initialized conversations", function () {
    it("shares membership with the state set", function () {
      const store = composeContextStore.initializedConversations;
      assert.isFalse(store.has(OWNER));
      initializedConversationComposeContextKeys.add(OWNER);
      assert.isTrue(store.has(OWNER));
      store.forget(OWNER);
      assert.isFalse(initializedConversationComposeContextKeys.has(OWNER));
      store.mark(OWNER);
      assert.isTrue(initializedConversationComposeContextKeys.has(OWNER));
    });
  });

  describe("per-paper overrides", function () {
    const overrideCases = [
      {
        name: "paperSendModes",
        map: paperContextModeOverrides as Map<string, string>,
        slot: composeContextStore.paperSendModes as unknown as OverrideSlot,
        value: "full-next",
      },
      {
        name: "paperSourceModes",
        map: paperContentSourceOverrides as Map<string, string>,
        slot: composeContextStore.paperSourceModes as unknown as OverrideSlot,
        value: "mineru",
      },
    ];
    type OverrideSlot = {
      get(ownerId: number, paper: PaperContextRef): string | null;
      set(ownerId: number, paper: PaperContextRef, mode: string): void;
      delete(ownerId: number, paper: PaperContextRef): boolean;
      clearOwner(ownerId: number): void;
    };

    for (const { name, map, slot, value } of overrideCases) {
      it(`${name} keys entries by ownerItemId:itemId:contextItemId`, function () {
        map.set(`${OWNER}:1:2`, value);
        assert.strictEqual(slot.get(OWNER, paper(1, 2)), value);
        assert.isNull(slot.get(OWNER, paper(1, 3)));
        slot.set(OWNER, paper(5.7, 6.2), value);
        assert.strictEqual(map.get(`${OWNER}:5:6`), value);
        assert.isTrue(slot.delete(OWNER, paper(1, 2)));
        assert.isFalse(map.has(`${OWNER}:1:2`));
      });

      it(`${name} clearOwner removes only that owner's entries`, function () {
        map.set(`${OWNER}:1:2`, value);
        map.set(`${OWNER}:3:4`, value);
        map.set(`${OWNER}1:1:2`, value);
        map.set(`9:1:2`, value);
        slot.clearOwner(OWNER);
        assert.deepEqual(Array.from(map.keys()).sort(), [
          `${OWNER}1:1:2`,
          "9:1:2",
        ]);
      });
    }
  });
});
