import { assert } from "chai";
import { resolveAutoTagCommandInput } from "../src/modules/contextPanel/autoTagCommand";

describe("autoTag command resolution", function () {
  const collectionCandidates = [
    {
      collectionId: 11,
      name: "Reading",
      path: "Projects / Reading",
    },
    {
      collectionId: 12,
      name: "Reading",
      path: "Archive / Reading",
    },
    {
      collectionId: 13,
      name: "Methods",
      path: "Projects / Methods",
    },
  ];

  it("defaults to the current paper in paper chat", function () {
    const result = resolveAutoTagCommandInput("", {
      mode: "paper",
      activeItemId: 101,
      selectedPaperContexts: [
        { itemId: 101, contextItemId: 9001, title: "Current Paper" },
      ],
    }, collectionCandidates);

    assert.deepEqual(result, {
      kind: "input",
      input: { itemIds: [101] },
    });
  });

  it("defaults to the selected chat-context papers in library chat", function () {
    const result = resolveAutoTagCommandInput("", {
      mode: "library",
      selectedPaperContexts: [
        { itemId: 201, contextItemId: 9201, title: "Paper One" },
        { itemId: 202, contextItemId: 9202, title: "Paper Two" },
      ],
    }, collectionCandidates);

    assert.deepEqual(result, {
      kind: "input",
      input: { itemIds: [201, 202] },
    });
  });

  it("requires an explicit scope when library chat has no selection", function () {
    const result = resolveAutoTagCommandInput("", {
      mode: "library",
    }, collectionCandidates);

    assert.deepEqual(result, {
      kind: "scope_required",
    });
  });

  it("resolves the explicit current-paper phrase", function () {
    const result = resolveAutoTagCommandInput("this paper", {
      mode: "paper",
      activeItemId: 301,
    }, collectionCandidates);

    assert.deepEqual(result, {
      kind: "input",
      input: { itemIds: [301] },
    });
  });

  it("resolves selection to both selected papers and collections", function () {
    const result = resolveAutoTagCommandInput("selection", {
      mode: "library",
      selectedPaperContexts: [
        { itemId: 401, contextItemId: 9401, title: "Paper One" },
      ],
      fullTextPaperContexts: [
        { itemId: 402, contextItemId: 9402, title: "Paper Two" },
      ],
      selectedCollectionContexts: [
        { collectionId: 13, name: "Methods", libraryID: 1 },
      ],
    }, collectionCandidates);

    assert.deepEqual(result, {
      kind: "input",
      input: {
        itemIds: [401, 402],
        collectionIds: [13],
      },
    });
  });

  it("resolves the first-N papers phrase", function () {
    const result = resolveAutoTagCommandInput("first 20 papers", {
      mode: "library",
    }, collectionCandidates);

    assert.deepEqual(result, {
      kind: "input",
      input: {
        scope: "all",
        limit: 20,
      },
    });
  });

  it("resolves the whole-library phrase", function () {
    const result = resolveAutoTagCommandInput("all library", {
      mode: "library",
    }, collectionCandidates);

    assert.deepEqual(result, {
      kind: "input",
      input: { scope: "all" },
    });
  });

  it("returns an ambiguity error for ambiguous collection names", function () {
    const result = resolveAutoTagCommandInput("collection reading", {
      mode: "library",
    }, collectionCandidates);

    assert.deepEqual(result, {
      kind: "error",
      error: 'Collection "reading" is ambiguous: Projects / Reading, Archive / Reading.',
    });
  });
});
