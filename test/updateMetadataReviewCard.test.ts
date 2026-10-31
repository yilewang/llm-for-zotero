import { assert } from "chai";
import { createSearchLiteratureReviewAction } from "../src/agent/reviewCards";
import { buildUpdateMetadataReviewField } from "../src/agent/tools/write/mutateLibraryShared";
import { createUpdateMetadataTool } from "../src/agent/tools/write/updateMetadata";
import type {
  AgentPendingField,
  AgentToolContext,
  AgentToolResult,
} from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

/**
 * The Safe-mode metadata card is the user's only view of what an edit will
 * write. It used to walk a fixed list of 18 article fields, so a book's
 * `edition` or `series` change produced a card with no rows at all, and the
 * user approved a write they could not see.
 */
describe("metadata review card rows", function () {
  const context: AgentToolContext = {
    request: resolvedAgentRequest({
      conversationKey: 42,
      mode: "agent",
      userText: "set the edition and series",
      activeItemId: 10,
      libraryID: 1,
    }),
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.4",
  };

  const book = { id: 10, libraryID: 1 };
  const bookSnapshot = {
    itemId: 10,
    itemType: "book",
    title: "A Book",
    fields: {
      title: "A Book",
      edition: "1",
      series: "Old Series",
    } as Record<string, string>,
    creators: [],
  };

  function gateway() {
    return {
      resolveMetadataWriteTarget: () => ({ item: book }),
      getEditableArticleMetadata: () => bookSnapshot,
    } as never;
  }

  type ReviewTable = Extract<AgentPendingField, { type: "review_table" }>;

  it("shows every field a book edit changes, with before values", function () {
    const tool = createUpdateMetadataTool(gateway());
    const action = tool.createPendingAction!(
      {
        operations: [
          {
            id: "op-1",
            type: "update_metadata",
            itemId: 10,
            metadata: { edition: "2", series: "New Series" } as never,
          },
        ],
      },
      context,
    ) as { fields: AgentPendingField[] };

    const tables = action.fields.filter(
      (field): field is ReviewTable => field.type === "review_table",
    );
    assert.lengthOf(tables, 1, "the card has a table for the change");
    assert.deepEqual(
      tables[0].rows.map((row) => [row.key, row.label, row.before, row.after]),
      [
        ["edition", "Edition", "1", "2"],
        ["series", "Series", "Old Series", "New Series"],
      ],
    );
  });

  it("refuses to build a card with no rows for an operation", function () {
    assert.throws(
      () =>
        buildUpdateMetadataReviewField(
          {
            id: "op-1",
            type: "update_metadata",
            itemId: 10,
            metadata: {},
          },
          gateway(),
          context,
          "A Book",
          false,
        ),
      /no rows/i,
    );
  });

  it("shows a translator patch's book fields on the literature review card", function () {
    const bookItem = {
      getDisplayTitle: () => "A Book",
      getField: (name: string) =>
        ({ title: "A Book", edition: "1", series: "Old Series" })[name] ?? "",
      getCreatorsJSON: () => [],
    };
    const result: AgentToolResult = {
      callId: "call-1",
      name: "literature_search",
      ok: true,
      content: {
        mode: "metadata",
        results: [
          {
            source: "Zotero translator",
            title: "A Book",
            patch: { edition: "2", series: "New Series" },
          },
        ],
      },
    };

    const action = createSearchLiteratureReviewAction(
      result,
      { ...context, item: bookItem as never },
      { itemId: 10 },
    );

    const diff = action?.fields.find(
      (field): field is ReviewTable =>
        field.type === "review_table" && field.id === "metadataDiff",
    );
    assert.exists(diff, "the high-confidence card shows a diff table");
    assert.deepEqual(
      diff!.rows.map((row) => [row.key, row.label, row.before, row.after]),
      [
        ["edition", "Edition", "1", "2"],
        ["series", "Series", "Old Series", "New Series"],
      ],
    );
  });
});
