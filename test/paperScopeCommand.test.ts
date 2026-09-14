import { assert } from "chai";
import { createBuiltInActionRegistry } from "../src/agent/actions";
import {
  resolvePaperScopedDefaultInput,
  type PaperScopedActionProfile,
} from "../src/agent/actions/paperScope";

describe("paper-scoped command resolution", function () {
  const profile: PaperScopedActionProfile = {
    targetMode: "single_or_multi",
    allowedScopes: ["current", "selection", "collection", "tag", "all"],
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
  const tagCandidates = [
    { name: "Stable", type: 0 },
    { name: "new", type: 0 },
    { name: "Data", type: 0 },
    { name: "Automatic", type: 1 },
  ];

  it("defaults to the current paper in paper chat", function () {
    const result = resolvePaperScopedDefaultInput(
      {
        mode: "paper",
        activeItemId: 101,
        selectedPaperContexts: [
          { itemId: 101, contextItemId: 9001, title: "Current Paper" },
        ],
      },
      profile,
    );

    assert.deepEqual(result, {
      kind: "input",
      input: { itemIds: [101] },
    });
  });

  it("defaults to the selected chat-context papers in library chat", function () {
    const result = resolvePaperScopedDefaultInput(
      {
        mode: "library",
        selectedPaperContexts: [
          { itemId: 201, contextItemId: 9201, title: "Paper One" },
          { itemId: 202, contextItemId: 9202, title: "Paper Two" },
        ],
      },
      profile,
    );

    assert.deepEqual(result, {
      kind: "input",
      input: { itemIds: [201, 202] },
    });
  });

  it("requires an explicit scope when library chat has no selection", function () {
    const result = resolvePaperScopedDefaultInput(
      {
        mode: "library",
      },
      profile,
    );

    assert.deepEqual(result, {
      kind: "scope_required",
    });
  });

  it("exposes paper-scoped action profiles through the action registry", function () {
    const registry = createBuiltInActionRegistry();

    assert.exists(registry.getPaperScopedActionProfile("auto_tag"));
    assert.exists(registry.getPaperScopedActionProfile("complete_metadata"));
    assert.exists(registry.getPaperScopedActionProfile("discover_related"));
    assert.isUndefined(
      registry.getPaperScopedActionProfile("organize_unfiled"),
    );
  });
});
