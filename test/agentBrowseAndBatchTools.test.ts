import { assert } from "chai";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createBrowseCollectionsTool } from "../src/agent/tools/read/browseCollections";
import { createListCollectionPapersTool } from "../src/agent/tools/read/listCollectionPapers";
import { createListUnfiledPapersTool } from "../src/agent/tools/read/listUnfiledPapers";
import { createListUntaggedPapersTool } from "../src/agent/tools/read/listUntaggedPapers";
import { createApplyTagsTool } from "../src/agent/tools/write/applyTags";
import { createMoveUnfiledPapersToCollectionTool } from "../src/agent/tools/write/moveUnfiledPapersToCollection";
import type { AgentToolContext } from "../src/agent/types";

describe("browse and batch agent tools", function () {
  const baseContext: AgentToolContext = {
    request: {
      conversationKey: 1,
      mode: "agent",
      userText: "organize these papers",
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.4",
  };

  it("browse and list tools use the gateway helpers", async function () {
    const fakeGateway = {
      resolveLibraryID: () => 1,
      browseCollections: async () => ({
        libraryID: 1,
        libraryName: "My Library",
        collections: [
          {
            collectionId: 11,
            name: "Biology",
            paperCount: 2,
            descendantPaperCount: 3,
            childCollections: [],
          },
        ],
        unfiled: {
          name: "Unfiled",
          paperCount: 4,
        },
      }),
      listCollectionPaperTargets: async () => ({
        collection: {
          collectionId: 11,
          name: "Biology",
          libraryID: 1,
        },
        totalCount: 1,
        papers: [
          {
            itemId: 99,
            title: "Example Paper",
            firstCreator: "Alice Example",
            year: "2021",
            attachments: [{ contextItemId: 501, title: "PDF" }],
            tags: ["review"],
            collectionIds: [11],
          },
        ],
      }),
      listUnfiledPaperTargets: async () => ({
        totalCount: 1,
        papers: [
          {
            itemId: 88,
            title: "Unfiled Paper",
            firstCreator: "Bob Example",
            year: "2020",
            attachments: [{ contextItemId: 401, title: "PDF" }],
            tags: [],
            collectionIds: [],
          },
        ],
      }),
      listUntaggedPaperTargets: async () => ({
        totalCount: 1,
        papers: [
          {
            itemId: 77,
            title: "Untagged Paper",
            firstCreator: "Casey Example",
            year: "2019",
            attachments: [{ contextItemId: 301, title: "PDF" }],
            tags: [],
            collectionIds: [11],
          },
        ],
      }),
    };

    const browseTool = createBrowseCollectionsTool(fakeGateway as never);
    const listCollectionTool = createListCollectionPapersTool(fakeGateway as never);
    const listUnfiledTool = createListUnfiledPapersTool(fakeGateway as never);
    const listUntaggedTool = createListUntaggedPapersTool(fakeGateway as never);

    const browseResult = await browseTool.execute({}, baseContext);
    assert.equal(
      (browseResult as { collections: unknown[] }).collections.length,
      1,
    );
    assert.equal(
      (browseResult as { unfiled: { paperCount: number } }).unfiled.paperCount,
      4,
    );

    const collectionResult = await listCollectionTool.execute(
      { collectionId: 11 },
      baseContext,
    );
    assert.equal(
      (collectionResult as { papers: unknown[] }).papers.length,
      1,
    );
    assert.equal(
      (collectionResult as { collection: { name: string } }).collection.name,
      "Biology",
    );

    const unfiledResult = await listUnfiledTool.execute({}, baseContext);
    assert.equal((unfiledResult as { totalCount: number }).totalCount, 1);

    const untaggedResult = await listUntaggedTool.execute({}, baseContext);
    assert.equal((untaggedResult as { totalCount: number }).totalCount, 1);
  });

  it("apply_tags can open a guided confirmation for untagged papers", async function () {
    const registry = new AgentToolRegistry();
    const fakeGateway = {
      resolveLibraryID: () => 1,
      listUntaggedPaperTargets: async () => ({
        totalCount: 2,
        papers: [
          {
            itemId: 10,
            title: "Paper One",
            firstCreator: "Alice Example",
            year: "2021",
            attachments: [{ contextItemId: 1001, title: "PDF" }],
            tags: [],
            collectionIds: [],
          },
          {
            itemId: 11,
            title: "Paper Two",
            firstCreator: "Bob Example",
            year: "2022",
            attachments: [{ contextItemId: 1002, title: "PDF" }],
            tags: [],
            collectionIds: [],
          },
        ],
      }),
      getPaperTargetsByItemIds: (itemIds: number[]) =>
        itemIds.map((itemId) => ({
          itemId,
          title: `Paper ${itemId}`,
          firstCreator: "Author",
          year: "2024",
          attachments: [{ contextItemId: itemId + 1000, title: "PDF" }],
          tags: [],
          collectionIds: [],
        })),
      applyTagAssignments: async () => ({
        selectedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        items: [],
      }),
      applyTagsToItems: async () => ({
        selectedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        items: [],
      }),
    };
    registry.register(createApplyTagsTool(fakeGateway as never));

    const actionable = await registry.prepareExecution(
      {
        id: "call-0",
        name: "apply_tags",
        arguments: {},
      },
      baseContext,
    );
    assert.equal(actionable.kind, "confirmation");
    if (actionable.kind !== "confirmation") return;
    const field = actionable.action.fields.find((entry) => entry.id === "assignments");
    assert.equal(field?.type, "tag_assignment_table");
    assert.lengthOf(
      field && field.type === "tag_assignment_table" ? field.rows : [],
      2,
    );
  });

  it("apply_tags builds per-paper tag recommendations and respects edited payloads", async function () {
    const calls: Array<Record<string, unknown>> = [];
    const fakeGateway = {
      resolveLibraryID: () => 1,
      getPaperTargetsByItemIds: () => [
        {
          itemId: 10,
          title: "Paper One",
          firstCreator: "Alice Example",
          year: "2021",
          attachments: [{ contextItemId: 1001, title: "PDF" }],
          tags: ["alpha"],
          collectionIds: [],
        },
        {
          itemId: 11,
          title: "Paper Two",
          firstCreator: "Bob Example",
          year: "2022",
          attachments: [{ contextItemId: 1002, title: "PDF" }],
          tags: [],
          collectionIds: [],
        },
      ],
      applyTagAssignments: async (params: Record<string, unknown>) => {
        calls.push(params);
        return {
          selectedCount: 2,
          updatedCount: 2,
          skippedCount: 0,
          items: [],
        };
      },
      applyTagsToItems: async () => ({
        selectedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        items: [],
      }),
    };
    const tool = createApplyTagsTool(fakeGateway as never);
    const validated = tool.validate({
      assignments: [
        {
          itemId: 10,
          tags: ["alpha", "beta"],
          reason: "The title suggests these tags.",
        },
      ],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const pending = await tool.createPendingAction?.(validated.value, baseContext);
    assert.exists(pending);
    assert.deepEqual(
      pending?.fields.map((field) => field.type),
      ["tag_assignment_table"],
    );
    const tableField = pending?.fields.find(
      (field) => field.id === "assignments",
    );
    assert.equal(tableField?.type, "tag_assignment_table");
    assert.deepEqual(
      tableField && tableField.type === "tag_assignment_table"
        ? tableField.rows.map((row) => ({
            id: row.id,
            value: row.value,
          }))
        : [],
      [
        { id: "10", value: "alpha, beta" },
        { id: "11", value: "" },
      ],
    );

    const confirmed = tool.applyConfirmation?.(validated.value, {
      assignments: [
        { id: "10", value: ["beta", "gamma"] },
        { id: "11", value: ["reading-list"] },
      ],
    });
    assert.isTrue(Boolean(confirmed?.ok));
    if (!confirmed?.ok) return;
    assert.deepEqual(confirmed.value, {
      assignments: [
        {
          itemId: 10,
          tags: ["beta", "gamma"],
        },
        {
          itemId: 11,
          tags: ["reading-list"],
        },
      ],
    });

    const result = await tool.execute(confirmed.value, baseContext);
    assert.equal((result as { updatedCount: number }).updatedCount, 2);
    assert.deepEqual(calls[0], {
      assignments: [
        {
          itemId: 10,
          tags: ["beta", "gamma"],
        },
        {
          itemId: 11,
          tags: ["reading-list"],
        },
      ],
    });
  });

  it("move_unfiled_papers_to_collection builds per-paper assignment suggestions and respects edited payloads", async function () {
    const registry = new AgentToolRegistry();
    const moveCalls: Array<Record<string, unknown>> = [];
    const fakeGateway = {
      resolveLibraryID: () => 1,
      listCollectionSummaries: () => [
        {
          collectionId: 55,
          name: "Reviewed",
          libraryID: 1,
          path: "Reviewed",
        },
        {
          collectionId: 56,
          name: "Inbox",
          libraryID: 1,
          path: "Inbox",
        },
      ],
      listUnfiledPaperTargets: async () => ({
        totalCount: 2,
        papers: [
          {
            itemId: 10,
            title: "Paper 10",
            firstCreator: "Author",
            year: "2024",
            attachments: [{ contextItemId: 1010, title: "PDF" }],
            tags: [],
            collectionIds: [],
          },
          {
            itemId: 11,
            title: "Paper 11",
            firstCreator: "Author",
            year: "2023",
            attachments: [{ contextItemId: 1011, title: "PDF" }],
            tags: [],
            collectionIds: [],
          },
        ],
      }),
      getPaperTargetsByItemIds: (itemIds: number[]) =>
        itemIds.map((itemId) => ({
          itemId,
          title: `Paper ${itemId}`,
          firstCreator: "Author",
          year: "2024",
          attachments: [{ contextItemId: itemId + 1000, title: "PDF" }],
          tags: [],
          collectionIds: [],
        })),
      getCollectionSummary: (collectionId?: number) => ({
        collectionId: collectionId || 55,
        name: collectionId === 56 ? "Inbox" : "Reviewed",
        libraryID: 1,
        path: collectionId === 56 ? "Inbox" : "Reviewed",
      }),
      moveUnfiledItemsToCollections: async (params: Record<string, unknown>) => {
        moveCalls.push(params);
        return {
          selectedCount: Array.isArray(params.assignments)
            ? params.assignments.length
            : 0,
          movedCount: 2,
          skippedCount: 0,
          collections: [
            {
              collectionId: 55,
              name: "Reviewed",
              libraryID: 1,
            },
            {
              collectionId: 56,
              name: "Inbox",
              libraryID: 1,
            },
          ],
          items: [],
        };
      },
      moveUnfiledItemsToCollection: async (params: Record<string, unknown>) => ({
        selectedCount: Array.isArray(params.itemIds) ? params.itemIds.length : 0,
        movedCount: 0,
        skippedCount: 0,
        collection: {
          collectionId: 55,
          name: "Reviewed",
          libraryID: 1,
        },
        items: [],
      }),
    };
    registry.register(
      createMoveUnfiledPapersToCollectionTool(fakeGateway as never),
    );

    const actionable = await registry.prepareExecution(
      {
        id: "call-1",
        name: "move_unfiled_papers_to_collection",
        arguments: {
          assignments: [
            {
              itemId: 10,
              targetCollectionId: 56,
              reason: "Fits the Inbox collection based on the title.",
            },
          ],
        },
      },
      baseContext,
    );
    assert.equal(actionable.kind, "confirmation");
    if (actionable.kind !== "confirmation") return;
    const assignmentField = actionable.action.fields.find(
      (field) => field.id === "assignments",
    );
    assert.equal(assignmentField?.type, "assignment_table");
    assert.deepEqual(
      assignmentField && assignmentField.type === "assignment_table"
        ? assignmentField.options.map((option) => option.id)
        : [],
      ["__skip__", "55", "56"],
    );
    assert.lengthOf(
      assignmentField && assignmentField.type === "assignment_table"
        ? assignmentField.rows
        : [],
      1,
    );
    assert.deepEqual(
      assignmentField && assignmentField.type === "assignment_table"
        ? assignmentField.rows.map((row) => ({
            id: row.id,
            value: row.value,
          }))
        : [],
      [{ id: "10", value: "56" }],
    );
    const approved = await actionable.execute({
      assignments: [
        { id: "10", value: "55", checked: true },
        { id: "11", value: "56", checked: true },
      ],
    });
    assert.equal(approved.ok, true);
    assert.deepEqual(moveCalls[0], {
      assignments: [
        {
          itemId: 10,
          targetCollectionId: 55,
        },
        {
          itemId: 11,
          targetCollectionId: 56,
        },
      ],
    });
  });
});
