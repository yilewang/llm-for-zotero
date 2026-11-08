import { assert } from "chai";
import {
  describeJournalSteps,
  describeLibraryMutation,
  describeLibraryMutations,
  isLegacyActionDescription,
  withMoreChanges,
  type MutationLabels,
} from "../src/agent/services/libraryMutation/describe";

const PAPERS: Record<number, string> = {
  1: "(Krajeski et al., 2019)",
  2: "(Lee, 2021)",
};
const COLLECTIONS: Record<number, string> = { 7: "Bayesian" };
const labels: MutationLabels = {
  item: (id) => PAPERS[id] || `item ${id}`,
  collection: (id) => COLLECTIONS[id],
};

function describe_(operation: object): string {
  return describeLibraryMutation(
    operation as Parameters<typeof describeLibraryMutation>[0],
    labels,
  );
}

describe("library mutation describer", function () {
  it("writes present-tense text with item labels", function () {
    const cases: Array<[object, string]> = [
      [
        { type: "apply_tags", itemIds: [1], tags: ["live-check-1031"] },
        "Add tag live-check-1031 to (Krajeski et al., 2019)",
      ],
      [
        { type: "apply_tags", itemIds: [1, 2], tags: ["a", "b"] },
        "Add tags a, b to 2 items",
      ],
      [
        {
          type: "apply_tags",
          assignments: [
            { itemId: 1, tags: ["a"] },
            { itemId: 2, tags: ["b"] },
          ],
        },
        "Add tags to 2 items",
      ],
      [
        { type: "remove_tags", itemIds: [2], tags: ["X"] },
        "Remove tag X from (Lee, 2021)",
      ],
      [
        {
          type: "move_to_collection",
          itemIds: [1, 2, 3],
          targetCollectionId: 7,
          mode: "move",
          from: "all",
        },
        'Move 3 items to "Bayesian"',
      ],
      [
        { type: "move_to_collection", itemIds: [1], targetCollectionId: 7 },
        'Add (Krajeski et al., 2019) to "Bayesian"',
      ],
      [
        {
          type: "move_to_collection",
          itemIds: [1],
          targetCollectionName: "Named",
          targetCollectionId: 7,
        },
        'Add (Krajeski et al., 2019) to "Named"',
      ],
      [
        { type: "remove_from_collection", itemIds: [1, 2], collectionId: 7 },
        'Remove 2 items from "Bayesian"',
      ],
      [
        { type: "change_item_type", itemId: 1, itemType: "preprint" },
        "Change (Krajeski et al., 2019) to Preprint",
      ],
      [
        { type: "change_item_type", itemId: 1, itemType: "journalArticle" },
        "Change (Krajeski et al., 2019) to Journal article",
      ],
      [
        {
          type: "update_metadata",
          itemId: 1,
          metadata: { title: "T", date: "2020", publicationTitle: "J" },
        },
        "Edit title, date, publication title of (Krajeski et al., 2019)",
      ],
      [{ type: "create_collection", name: "New" }, 'Create collection "New"'],
      [
        { type: "update_collection", collectionId: 7, name: "Renamed" },
        'Rename collection "Bayesian" to "Renamed"',
      ],
      [
        { type: "update_library_tag", action: "rename", tag: "a", newTag: "b" },
        'Rename tag "a" to "b"',
      ],
      [
        { type: "trash_items", itemIds: [1] },
        "Move (Krajeski et al., 2019) to the trash",
      ],
      [
        { type: "merge_items", masterItemId: 1, otherItemIds: [2, 3] },
        "Merge 2 items into (Krajeski et al., 2019)",
      ],
      [
        { type: "create_items", items: [{ itemType: "book" }] },
        "Create 1 item",
      ],
      [
        { type: "import_identifiers", identifiers: ["a", "b"] },
        "Import 2 identifiers",
      ],
    ];
    for (const [operation, expected] of cases)
      assert.equal(describe_(operation), expected);
  });

  it("falls back to a present-tense catalog label and never shows a token", function () {
    assert.equal(
      describe_({ type: "apply_tags" }),
      "Add tags to the selected items",
    );
    assert.equal(
      describe_({ type: "not_a_real_operation" }),
      "Not a real operation",
    );
    assert.equal(describe_({ type: "find_pdf" }), "Search for a PDF");
    for (const type of [
      "update_metadata",
      "apply_tags",
      "set_item_collections",
      "relate_items",
      "save_note",
      "attach_url",
    ])
      assert.notMatch(describe_({ type }), /_/u, type);
  });

  it("names the first change and counts the rest", function () {
    assert.equal(
      withMoreChanges("Add tag a to 1 item", 1),
      "Add tag a to 1 item",
    );
    assert.equal(withMoreChanges("First", 2), "First and 1 more change");
    assert.equal(withMoreChanges("First", 5), "First and 4 more changes");
    assert.equal(
      describeLibraryMutations(
        [
          { type: "remove_tags", itemIds: [1], tags: ["x"] },
          { type: "trash_items", itemIds: [2] },
        ] as never,
        labels,
      ),
      "Remove tag x from (Krajeski et al., 2019) and 1 more change",
    );
  });

  it("recognizes the earlier token-like descriptions only", function () {
    for (const text of [
      "Apply apply_tags",
      "Apply update_metadata",
      "library_update: 3 planned changes",
      "library_update: 12 item changes",
    ])
      assert.isTrue(isLegacyActionDescription(text), text);
    for (const text of [
      "Add tag x to (Lee, 2021)",
      "Apply reviewed tags.",
      'Run the "auto tag" batch job',
    ])
      assert.isFalse(isLegacyActionDescription(text), text);
  });

  it("rebuilds a description from journal steps, tolerating a dropped payload", function () {
    assert.equal(
      describeJournalSteps(
        [
          {
            operation: "apply_tags",
            forwardJson: JSON.stringify({
              type: "apply_tags",
              itemIds: [1],
              tags: ["t"],
            }),
          },
          { operation: "apply_tags", forwardJson: "{}" },
        ],
        labels,
      ),
      "Add tag t to (Krajeski et al., 2019) and 1 more change",
    );
    assert.equal(
      describeJournalSteps(
        [{ operation: "apply_tags", forwardJson: "not json" }],
        labels,
      ),
      "Add tags to the selected items",
    );
    assert.isNull(describeJournalSteps([], labels));
  });
});
