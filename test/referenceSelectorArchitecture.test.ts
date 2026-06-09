import { assert } from "chai";
import { describe, it } from "mocha";
import {
  removeReferenceAttachmentContext,
  toggleCollectionContext,
  toggleTagContext,
  upsertPaperContext,
  upsertReferenceAttachmentContext,
} from "../src/modules/contextPanel/contextSelectionActions";
import { MAX_SELECTED_PAPER_CONTEXTS } from "../src/modules/contextPanel/constants";
import {
  buildReferenceSelectorTagContextKey,
  createReferenceSelectorState,
  buildReferenceSelectorViewModel,
  resolveReferenceSelectorAttachmentSelectionState,
  setReferenceSelectorCollections,
  setReferenceSelectorFolderScope,
  setReferenceSelectorSearchResults,
  toggleReferenceSelectorGroupExpanded,
} from "../src/modules/contextPanel/referenceSelector/model";
import { createReferenceSelectorPanelLayout } from "../src/modules/contextPanel/referenceSelector/panelLayout";
import {
  selectedCollectionContextCache,
  selectedOtherRefContextCache,
  selectedPaperContextCache,
  selectedPaperPreviewExpandedCache,
  selectedTagContextCache,
} from "../src/modules/contextPanel/state";
import type {
  PaperBrowseCollectionCandidate,
  PaperSearchAttachmentCandidate,
  PaperSearchGroupCandidate,
  PaperSearchTagCandidate,
} from "../src/modules/contextPanel/paperSearch";
import type { PaperContextRef } from "../src/modules/contextPanel/types";

function makeAttachment(
  id: number,
  options: Partial<PaperSearchAttachmentCandidate> = {},
): PaperSearchAttachmentCandidate {
  return {
    contextItemId: id,
    title: `Attachment ${id}`,
    score: 1,
    contentType: "application/pdf",
    ...options,
  };
}

function makeGroup(
  itemId: number,
  options: Partial<PaperSearchGroupCandidate> = {},
): PaperSearchGroupCandidate {
  return {
    itemId,
    title: `Paper ${itemId}`,
    attachments: [makeAttachment(itemId + 100)],
    score: 1,
    modifiedAt: itemId,
    addedAt: itemId,
    collectionIds: [],
    tags: [],
    tagsAuto: [],
    ...options,
  };
}

function makeCollection(
  collectionId: number,
  papers: PaperSearchGroupCandidate[],
  childCollections: PaperBrowseCollectionCandidate[] = [],
): PaperBrowseCollectionCandidate {
  return {
    collectionId,
    name: `Collection ${collectionId}`,
    papers,
    childCollections,
  };
}

function makeTag(name: string): PaperSearchTagCandidate {
  return {
    name,
    normalizedName: name,
    count: 1,
    includeAutomatic: false,
    isAutomatic: false,
    score: 1,
  };
}

class FakeClassList {
  private readonly tokens = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) this.tokens.add(token);
  }

  contains(token: string): boolean {
    return this.tokens.has(token);
  }
}

class FakeStyle {
  height = "";
  private readonly properties = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.properties.set(name, value);
  }

  getPropertyValue(name: string): string {
    if (name === "height") return this.height;
    return this.properties.get(name) || "";
  }
}

class FakeElement {
  readonly classList = new FakeClassList();
  readonly style = new FakeStyle();
  readonly children: FakeElement[] = [];
  rectHeight = 0;

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  getBoundingClientRect(): DOMRect {
    return { height: this.rectHeight } as DOMRect;
  }
}

describe("reference selector model", function () {
  it("builds browse and search rows from the same model state", function () {
    const first = makeGroup(1);
    const second = makeGroup(2);
    const state = createReferenceSelectorState();

    setReferenceSelectorCollections(state, [makeCollection(10, [first, second])]);
    let viewModel = buildReferenceSelectorViewModel(state);
    assert.deepEqual(
      viewModel.rows.map((row) => row.kind === "paper" ? row.itemId : row.kind),
      [2, 1],
    );

    setReferenceSelectorSearchResults(state, [first], [makeCollection(20, [])], [
      makeTag("Stable"),
    ]);
    viewModel = buildReferenceSelectorViewModel(state);
    assert.deepEqual(
      viewModel.rows.map((row) => row.kind),
      ["collection", "tag", "paper"],
    );
  });

  it("applies folder, tag, expansion, and active row rules in the model", function () {
    const first = makeGroup(1, {
      collectionIds: [10],
      tags: ["A", "B"],
      attachments: [makeAttachment(101), makeAttachment(102)],
    });
    const second = makeGroup(2, { collectionIds: [20], tags: ["A"] });
    const state = createReferenceSelectorState();
    setReferenceSelectorCollections(state, [
      makeCollection(10, [first]),
      makeCollection(20, [second]),
    ]);

    setReferenceSelectorFolderScope(state, 10);
    state.selectedTags = new Set(["A", "B"]);
    state.tagMatchMode = "and";
    state.activeRowIndex = 99;
    toggleReferenceSelectorGroupExpanded(state, first.itemId, true);

    let viewModel = buildReferenceSelectorViewModel(state);
    assert.deepEqual(
      viewModel.rows.map((row) =>
        row.kind === "attachment" ? `${row.kind}:${row.attachmentIndex}` : row.kind,
      ),
      ["paper", "attachment:0", "attachment:1"],
    );
    assert.equal(state.activeRowIndex, 2);

    state.tagMatchMode = "or";
    setReferenceSelectorFolderScope(state, "all");
    viewModel = buildReferenceSelectorViewModel(state);
    assert.deepEqual(
      viewModel.visibleGroups.map((group) => group.itemId),
      [2, 1],
    );
  });

  it("distinguishes explicit selection from selected collection/tag coverage", function () {
    const group = makeGroup(1, { collectionIds: [10], tags: ["Stable"] });
    const attachment = group.attachments[0];
    const state = createReferenceSelectorState();
    setReferenceSelectorCollections(state, [makeCollection(10, [group])]);

    assert.equal(
      resolveReferenceSelectorAttachmentSelectionState({
        state,
        group,
        attachment,
        selectedPapers: [{ itemId: 1, contextItemId: attachment.contextItemId }],
      }),
      "explicit",
    );
    assert.equal(
      resolveReferenceSelectorAttachmentSelectionState({
        state,
        group,
        attachment,
        selectedCollections: [{ collectionId: 10, name: "Collection 10", libraryID: 1 }],
      }),
      "coveredByCollection",
    );
    assert.equal(
      resolveReferenceSelectorAttachmentSelectionState({
        state,
        group,
        attachment,
        selectedTags: [
          {
            name: "Stable",
            normalizedName: "Stable",
            libraryID: 1,
            includeAutomatic: false,
          },
        ],
      }),
      "coveredByTag",
    );
    assert.equal(
      resolveReferenceSelectorAttachmentSelectionState({
        state,
        group,
        attachment,
        selectedTags: [
          {
            name: "Stable",
            normalizedName: "stable",
            libraryID: 1,
            includeAutomatic: false,
          },
        ],
      }),
      "coveredByTag",
    );
    assert.equal(
      buildReferenceSelectorTagContextKey({
        name: "Stable",
        normalizedName: "Stable",
        libraryID: 1,
      }),
      buildReferenceSelectorTagContextKey({
        name: "stable",
        normalizedName: "stable",
        libraryID: 1,
      }),
    );
  });
});

describe("reference selector panel layout", function () {
  it("clamps panel heights and tracks collapsed panels", function () {
    const paperPicker = new FakeElement();
    const paperPickerList = new FakeElement();
    const layout = createReferenceSelectorPanelLayout({
      paperPicker: paperPicker as unknown as HTMLDivElement,
      paperPickerList: paperPickerList as unknown as HTMLDivElement,
      getMode: () => "browse",
      render: () => undefined,
    });
    const panel = new FakeElement();

    layout.applyPanelHeight(panel as unknown as HTMLElement, "folders");
    assert.equal(panel.style.height, "190px");

    paperPicker.style.setProperty("--llm-paper-picker-max-height", "360px");
    layout.applyPanelHeight(panel as unknown as HTMLElement, "folders");
    assert.equal(panel.style.height, "165px");

    assert.isFalse(layout.isCollapsed("folders"));
    layout.toggleCollapsed("folders");
    assert.isTrue(layout.isCollapsed("folders"));
  });

  it("captures collapsed rendered heights from the panel stack", function () {
    const paperPicker = new FakeElement();
    const paperPickerList = new FakeElement();
    const shell = new FakeElement();
    const folders = new FakeElement();
    const references = new FakeElement();
    const tags = new FakeElement();
    tags.classList.add("llm-paper-picker-panel-collapsed");
    folders.rectHeight = 200;
    references.rectHeight = 300;
    paperPickerList.appendChild(shell);
    shell.appendChild(folders);
    shell.appendChild(references);
    shell.appendChild(tags);

    const layout = createReferenceSelectorPanelLayout({
      paperPicker: paperPicker as unknown as HTMLDivElement,
      paperPickerList: paperPickerList as unknown as HTMLDivElement,
      getMode: () => "browse",
      render: () => undefined,
    });

    const heights = layout.captureRenderedPanelHeights();
    assert.equal(heights.get("folders"), 200);
    assert.equal(heights.get("references"), 300);
    assert.equal(heights.get("tags"), 28);
  });
});

describe("context selection actions", function () {
  const ownerItemId = 9_001;

  function makeDeps() {
    return {
      item: { id: ownerItemId } as Zotero.Item,
      resolveAutoLoadedPaperContext: () => null,
      getManualPaperContextsForItem: () =>
        selectedPaperContextCache.get(ownerItemId) || [],
      isPaperContextMineru: () => false,
      getTextContextConversationKey: () => null,
      updatePaperPreviewPreservingScroll: () => undefined,
      updateSelectedTextPreviewPreservingScroll: () => undefined,
    };
  }

  it("adds and removes explicit paper context through centralized actions", function () {
    selectedPaperContextCache.delete(ownerItemId);
    selectedOtherRefContextCache.delete(ownerItemId);
    selectedPaperPreviewExpandedCache.delete(ownerItemId);
    const paper: PaperContextRef = {
      itemId: 1,
      contextItemId: 101,
      title: "Paper 1",
    };

    let result = upsertPaperContext(makeDeps(), paper);
    assert.isTrue(result.changed);
    assert.lengthOf(selectedPaperContextCache.get(ownerItemId) || [], 1);

    result = removeReferenceAttachmentContext({
      deps: makeDeps(),
      selectedGroup: makeGroup(1, { attachments: [makeAttachment(101)] }),
      selectedAttachment: makeAttachment(101),
      kind: "pdf",
    });
    assert.isTrue(result.changed);
    assert.isUndefined(selectedPaperContextCache.get(ownerItemId));
  });

  it("routes stale-kind text attachments into paper context state", function () {
    const cases: Array<{
      title: string;
      contentType: string;
      mode: PaperContextRef["contentSourceMode"];
    }> = [
      { title: "test.md", contentType: "text/markdown", mode: "markdown" },
      { title: "page.html", contentType: "text/html", mode: "html" },
      { title: "notes.txt", contentType: "text/plain", mode: "txt" },
      {
        title: "summary.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        mode: "docx",
      },
    ];

    for (const [index, entry] of cases.entries()) {
      selectedPaperContextCache.delete(ownerItemId);
      selectedOtherRefContextCache.delete(ownerItemId);
      selectedPaperPreviewExpandedCache.delete(ownerItemId);
      const attachment = makeAttachment(2_000 + index, {
        title: entry.title,
        contentType: entry.contentType,
      });
      const group = makeGroup(1_000 + index, {
        attachments: [attachment],
        title: `Paper ${index}`,
      });

      const result = upsertReferenceAttachmentContext({
        deps: makeDeps(),
        selectedGroup: group,
        selectedAttachment: attachment,
        kind: "other",
      });

      assert.isTrue(result.changed);
      const selectedPapers = selectedPaperContextCache.get(ownerItemId) || [];
      assert.lengthOf(selectedPapers, 1);
      assert.equal(selectedPapers[0].itemId, group.itemId);
      assert.equal(selectedPapers[0].contextItemId, attachment.contextItemId);
      assert.equal(selectedPapers[0].attachmentTitle, entry.title);
      assert.equal(selectedPapers[0].contentSourceMode, entry.mode);
      assert.isUndefined(selectedOtherRefContextCache.get(ownerItemId));

      const removed = removeReferenceAttachmentContext({
        deps: makeDeps(),
        selectedGroup: group,
        selectedAttachment: attachment,
        kind: "other",
      });

      assert.isTrue(removed.changed);
      assert.isUndefined(selectedPaperContextCache.get(ownerItemId));
      assert.isUndefined(selectedOtherRefContextCache.get(ownerItemId));
    }
  });

  it("toggles collection and tag contexts without creating paper chips", function () {
    selectedCollectionContextCache.delete(ownerItemId);
    selectedTagContextCache.delete(ownerItemId);
    selectedPaperContextCache.delete(ownerItemId);

    assert.isTrue(
      toggleCollectionContext({
        deps: makeDeps(),
        ref: { collectionId: 10, name: "Collection 10", libraryID: 1 },
      }).changed,
    );
    assert.lengthOf(selectedCollectionContextCache.get(ownerItemId) || [], 1);
    assert.isUndefined(selectedPaperContextCache.get(ownerItemId));

    assert.isTrue(
      toggleTagContext({
        deps: makeDeps(),
        ref: {
          name: "Stable",
          normalizedName: "Stable",
          libraryID: 1,
          includeAutomatic: false,
        },
        libraryID: 1,
      }).changed,
    );
    assert.lengthOf(selectedTagContextCache.get(ownerItemId) || [], 1);
    assert.isUndefined(selectedPaperContextCache.get(ownerItemId));

    toggleCollectionContext({
      deps: makeDeps(),
      ref: { collectionId: 10, name: "Collection 10", libraryID: 1 },
    });
    toggleTagContext({
      deps: makeDeps(),
      ref: {
        name: "Stable",
        normalizedName: "Stable",
        libraryID: 1,
        includeAutomatic: false,
      },
      libraryID: 1,
    });
    assert.isUndefined(selectedCollectionContextCache.get(ownerItemId));
    assert.isUndefined(selectedTagContextCache.get(ownerItemId));
  });

  it("toggles persisted lowercase tag contexts from picker-cased tags", function () {
    selectedTagContextCache.set(ownerItemId, [
      {
        name: "Stable",
        normalizedName: "stable",
        libraryID: 1,
        includeAutomatic: false,
      },
    ]);
    selectedPaperContextCache.delete(ownerItemId);

    const result = toggleTagContext({
      deps: makeDeps(),
      ref: {
        name: "Stable",
        normalizedName: "Stable",
        libraryID: 1,
        includeAutomatic: false,
      },
      libraryID: 1,
    });

    assert.isTrue(result.changed);
    assert.isUndefined(selectedTagContextCache.get(ownerItemId));
    assert.isUndefined(selectedPaperContextCache.get(ownerItemId));
  });

  it("preserves the selected paper capacity status", function () {
    selectedPaperContextCache.set(
      ownerItemId,
      Array.from({ length: MAX_SELECTED_PAPER_CONTEXTS }, (_, index) => ({
        itemId: index + 1,
        contextItemId: 1_000 + index,
        title: `Paper ${index + 1}`,
      })),
    );

    const result = upsertPaperContext(makeDeps(), {
      itemId: 999,
      contextItemId: 1_999,
      title: "Overflow",
    });
    assert.isFalse(result.changed);
    assert.equal(result.statusMessage, `Paper Context up to ${MAX_SELECTED_PAPER_CONTEXTS}`);
    assert.equal(result.statusLevel, "error");
  });
});
