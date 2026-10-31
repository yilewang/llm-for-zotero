import { assert } from "chai";
import {
  createSearchLiteratureReviewAction,
  resolveSearchLiteratureReview,
} from "../src/agent/reviewCards";
import { buildUpdateMetadataReviewField } from "../src/agent/tools/write/mutateLibraryShared";
import { createUpdateMetadataTool } from "../src/agent/tools/write/updateMetadata";
import type {
  AgentPendingField,
  AgentToolContext,
  AgentToolResult,
} from "../src/agent/types";
import { ItemCapability } from "../src/agent/services/zotero/itemCapability";
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
      metadataPatchRefusal: () => null,
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
      gateway(),
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

  /**
   * The literature-search card read its "before" values from the open paper
   * even when the call named another item, so the user approved a diff of
   * the wrong paper, and a row equal to the open paper's value was hidden.
   */
  describe("literature-search card for a named item other than the open paper", function () {
    const paperA = {
      id: 1,
      libraryID: 1,
      getDisplayTitle: () => "Paper A",
      getField: (name: string) =>
        ({ title: "Paper A", date: "2020", DOI: "10.1/a" })[name] ?? "",
      getCreatorsJSON: () => [{ firstName: "Ann", lastName: "Open" }],
    };
    const paperB = { id: 2, libraryID: 1 };
    const snapshots: Record<number, unknown> = {
      1: {
        itemId: 1,
        itemType: "journalArticle",
        title: "Paper A",
        fields: { title: "Paper A", date: "2020", DOI: "10.1/a" },
        creators: [
          { creatorType: "author", firstName: "Ann", lastName: "Open" },
        ],
      },
      2: {
        itemId: 2,
        itemType: "journalArticle",
        title: "Paper B old",
        fields: { title: "Paper B old", date: "2020", DOI: "" },
        creators: [
          { creatorType: "author", firstName: "Bo", lastName: "Named" },
        ],
      },
    };
    const writeTargetCalls: unknown[] = [];
    const targetGateway = {
      resolveMetadataWriteTarget: (params: {
        itemId?: number;
        paperContext?: { itemId?: number } | null;
      }) => {
        writeTargetCalls.push(params);
        const id = params.itemId || params.paperContext?.itemId || 1;
        return { item: id === 2 ? paperB : paperA };
      },
      getEditableArticleMetadata: (item: { id: number }) =>
        snapshots[item.id] || null,
      metadataPatchRefusal: () => null,
    } as never;
    const result: AgentToolResult = {
      callId: "call-b",
      name: "literature_search",
      ok: true,
      content: {
        mode: "metadata",
        results: [
          {
            source: "Zotero translator",
            title: "Paper B",
            patch: {
              title: "Paper B",
              date: "2020",
              DOI: "10.1/b",
              creators: [
                { creatorType: "author", firstName: "Bo", lastName: "Named" },
              ],
            },
          },
        ],
      },
    };
    const openA: AgentToolContext = {
      ...context,
      request: resolvedAgentRequest({
        conversationKey: 42,
        mode: "agent",
        userText: "fix item 2's metadata",
        activeItemId: 1,
        libraryID: 1,
        selectedPaperContexts: [
          { itemId: 1, contextItemId: 101, title: "Paper A" },
        ],
      }),
      item: paperA as never,
    };

    it("shows before values from the named item, not the open paper", function () {
      const action = createSearchLiteratureReviewAction(
        result,
        openA,
        { workflow: "review", mode: "metadata", itemId: 2 },
        targetGateway,
      );
      const diff = action?.fields.find(
        (field): field is ReviewTable =>
          field.type === "review_table" && field.id === "metadataDiff",
      );
      assert.exists(diff);
      // date is the same on B, so no row; title and DOI differ on B. Against
      // paper A the DOI row would read "10.1/a" and the authors row would
      // appear, both wrongly.
      assert.deepEqual(
        diff!.rows.map((row) => [row.key, row.before, row.after]),
        [
          ["title", "Paper B old", "Paper B"],
          ["DOI", "", "10.1/b"],
        ],
      );
    });

    it("applies the change to the same named item the card showed", function () {
      const resolution = resolveSearchLiteratureReview(
        { workflow: "review", mode: "metadata", itemId: 2 } as never,
        result,
        { approved: true, actionId: "apply_direct" },
        openA,
        targetGateway,
      );
      assert.equal(resolution.kind, "invoke_tool");
      if (resolution.kind !== "invoke_tool") return;
      const args = resolution.call.arguments as Record<string, unknown>;
      assert.equal(args.itemId, 2, "the write names item B exactly");
      assert.notProperty(
        args,
        "paperContext",
        "the open paper's context never redirects the write",
      );
    });
  });

  /**
   * A model often names a PDF's id. A patch of DOI and publicationTitle on an
   * attachment rendered rows, the user approved, and the write then threw
   * "Unsupported metadata fields for attachment".
   */
  describe("a patch the target's item type cannot take", function () {
    const pdf = { id: 20, libraryID: 1 };
    const unsupported =
      "Unsupported metadata fields for attachment: DOI, publicationTitle. Fields this item type accepts: title, url.";
    const refusals: Array<[unknown, unknown]> = [];
    function pdfGateway() {
      return {
        resolveMetadataWriteTarget: () => ({ item: pdf }),
        getEditableArticleMetadata: () => ({
          itemId: 20,
          itemType: "attachment",
          title: "PDF",
          fields: { title: "PDF" },
          creators: [],
        }),
        metadataPatchRefusal: (item: unknown, patch: unknown) => {
          refusals.push([item, patch]);
          return unsupported;
        },
      } as never;
    }
    const patch = { DOI: "10.1/x", publicationTitle: "Journal" };

    beforeEach(function () {
      refusals.length = 0;
    });

    it("builds no update card, and says which fields the type cannot take", function () {
      assert.throws(
        () =>
          buildUpdateMetadataReviewField(
            {
              id: "op-1",
              type: "update_metadata",
              itemId: 20,
              metadata: patch as never,
            },
            pdfGateway(),
            context,
            "PDF",
            false,
          ),
        /Unsupported metadata fields for attachment: DOI, publicationTitle/,
      );
      assert.deepEqual(refusals, [[pdf, patch]], "asked of the resolved item");
    });

    it("offers no literature-search card for the write", function () {
      const result: AgentToolResult = {
        callId: "call-pdf",
        name: "literature_search",
        ok: true,
        content: {
          mode: "metadata",
          results: [{ source: "Zotero translator", title: "Paper", patch }],
        },
      };
      const action = createSearchLiteratureReviewAction(
        result,
        context,
        { itemId: 20 },
        pdfGateway(),
      );
      assert.isNull(action);
      assert.deepEqual(refusals, [[pdf, patch]]);
    });

    describe("creators on an attachment, through the capability's own check", function () {
      const scope = globalThis as { Zotero?: unknown };
      const originalZotero = scope.Zotero;
      const attachment = { id: 20, libraryID: 1, itemTypeID: 3 };
      const capability = new ItemCapability({
        getItem: () => null,
        getCollectionSummary: () => null,
        resolveBibliographicItem: (item) => item ?? null,
      });
      const creators = [
        { firstName: "A", lastName: "B", creatorType: "author" },
      ];

      beforeEach(function () {
        scope.Zotero = {
          ItemTypes: { getName: () => "attachment" },
          CreatorTypes: { itemTypeHasCreators: () => false },
        };
      });
      afterEach(function () {
        scope.Zotero = originalZotero;
      });

      function attachmentGateway() {
        return {
          resolveMetadataWriteTarget: () => ({ item: attachment }),
          getEditableArticleMetadata: () => ({
            itemId: 20,
            itemType: "attachment",
            title: "PDF",
            fields: { title: "PDF" },
            creators: [],
          }),
          metadataPatchRefusal: (item: never, patch: never) =>
            capability.metadataPatchRefusal(item, patch),
        } as never;
      }

      it("builds no update card for a creators-only patch", function () {
        assert.throws(
          () =>
            buildUpdateMetadataReviewField(
              {
                id: "op-1",
                type: "update_metadata",
                itemId: 20,
                metadata: { creators } as never,
              },
              attachmentGateway(),
              context,
              "PDF",
              false,
            ),
          /Creators are not supported for attachment/,
        );
      });

      it("offers no literature-search card for a creators-only patch", function () {
        const result: AgentToolResult = {
          callId: "call-creators",
          name: "literature_search",
          ok: true,
          content: {
            mode: "metadata",
            results: [
              {
                source: "Zotero translator",
                title: "Paper",
                patch: { creators },
              },
            ],
          },
        };
        assert.isNull(
          createSearchLiteratureReviewAction(
            result,
            context,
            { itemId: 20 },
            attachmentGateway(),
          ),
        );
      });
    });
  });
});
