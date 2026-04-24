import { assert } from "chai";
import { createBuiltInActionRegistry } from "../src/agent/actions";
import {
  resolvePaperScopedCommandInput,
  type PaperScopedActionProfile,
} from "../src/agent/actions/paperScope";

describe("paper-scoped command resolution", function () {
  const profile: PaperScopedActionProfile = {
    targetMode: "single_or_multi",
    allowedScopes: ["current", "selection", "collection", "all"],
    defaultEmptyInput: "selection_or_prompt",
    paperRequirement: "bibliographic",
    supportsLimit: true,
  };

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
    const result = resolvePaperScopedCommandInput(
      "",
      {
        mode: "paper",
        activeItemId: 101,
        selectedPaperContexts: [
          { itemId: 101, contextItemId: 9001, title: "Current Paper" },
        ],
      },
      profile,
      collectionCandidates,
    );

    assert.deepEqual(result, {
      kind: "input",
      input: { itemIds: [101] },
    });
  });

  it("defaults to the selected chat-context papers in library chat", function () {
    const result = resolvePaperScopedCommandInput(
      "",
      {
        mode: "library",
        selectedPaperContexts: [
          { itemId: 201, contextItemId: 9201, title: "Paper One" },
          { itemId: 202, contextItemId: 9202, title: "Paper Two" },
        ],
      },
      profile,
      collectionCandidates,
    );

    assert.deepEqual(result, {
      kind: "input",
      input: { itemIds: [201, 202] },
    });
  });

  it("requires an explicit scope when library chat has no selection", function () {
    const result = resolvePaperScopedCommandInput(
      "",
      {
        mode: "library",
      },
      profile,
      collectionCandidates,
    );

    assert.deepEqual(result, {
      kind: "scope_required",
    });
  });

  it("resolves selection to both selected papers and collections", function () {
    const result = resolvePaperScopedCommandInput(
      "selection",
      {
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
      },
      profile,
      collectionCandidates,
    );

    assert.deepEqual(result, {
      kind: "input",
      input: {
        itemIds: [401, 402],
        collectionIds: [13],
      },
    });
  });

  it("resolves first-N, all-library, and collection phrases", function () {
    assert.deepEqual(
      resolvePaperScopedCommandInput(
        "first 20 papers",
        { mode: "library" },
        profile,
        collectionCandidates,
      ),
      {
        kind: "input",
        input: {
          scope: "all",
          limit: 20,
        },
      },
    );

    assert.deepEqual(
      resolvePaperScopedCommandInput(
        "all library",
        { mode: "library" },
        profile,
        collectionCandidates,
      ),
      {
        kind: "input",
        input: { scope: "all" },
      },
    );

    assert.deepEqual(
      resolvePaperScopedCommandInput(
        "collection methods",
        { mode: "library" },
        profile,
        collectionCandidates,
      ),
      {
        kind: "input",
        input: { collectionIds: [13] },
      },
    );
  });

  it("returns collection errors for missing or ambiguous names", function () {
    assert.deepEqual(
      resolvePaperScopedCommandInput(
        "collection reading",
        { mode: "library" },
        profile,
        collectionCandidates,
      ),
      {
        kind: "error",
        error: 'Collection "reading" is ambiguous: Projects / Reading, Archive / Reading.',
      },
    );

    assert.deepEqual(
      resolvePaperScopedCommandInput(
        "collection unknown",
        { mode: "library" },
        profile,
        collectionCandidates,
      ),
      {
        kind: "error",
        error: 'No collection matches "unknown".',
      },
    );
  });

  it("exposes paper-scoped action profiles through the action registry", function () {
    const registry = createBuiltInActionRegistry();

    assert.exists(registry.getPaperScopedActionProfile("auto_tag"));
    assert.exists(registry.getPaperScopedActionProfile("complete_metadata"));
    assert.isUndefined(registry.getPaperScopedActionProfile("organize_unfiled"));
  });
});
