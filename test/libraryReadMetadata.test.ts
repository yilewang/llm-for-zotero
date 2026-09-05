import { assert } from "chai";
import { createReadLibraryTool } from "../src/agent/tools/read/readLibrary";

function makeItem(params: {
  id: number;
  kind: "regular" | "attachment" | "note";
  title: string;
  parentID?: number;
}) {
  return {
    id: params.id,
    libraryID: 1,
    key: `KEY${params.id}`,
    itemTypeID:
      params.kind === "regular" ? 1 : params.kind === "attachment" ? 14 : 2,
    itemType:
      params.kind === "regular"
        ? "journalArticle"
        : params.kind === "attachment"
          ? "attachment"
          : "note",
    parentID: params.parentID,
    attachmentFilename:
      params.kind === "attachment" ? "supplement.pdf" : undefined,
    attachmentContentType:
      params.kind === "attachment" ? "application/pdf" : undefined,
    version: 3,
    isRegularItem: () => params.kind === "regular",
    isAttachment: () => params.kind === "attachment",
    isNote: () => params.kind === "note",
    getField: (fieldName: string) => {
      if (fieldName === "title") return params.title;
      if (fieldName === "dateAdded") return "2026-08-28 10:00:00";
      if (fieldName === "dateModified") return "2026-08-28 10:05:00";
      return "";
    },
    getDisplayTitle: () => params.title,
    getNoteTitle: () => params.title,
    getCreatorsJSON: () =>
      params.kind === "regular"
        ? [
            {
              creatorType: "author",
              firstName: "Test",
              lastName: "Author",
              fieldMode: 0,
            },
          ]
        : [],
    toJSON: () => ({
      itemType:
        params.kind === "regular"
          ? "journalArticle"
          : params.kind === "attachment"
            ? "attachment"
            : "note",
      title: params.title,
      DOI: params.kind === "regular" ? "10.1000/read" : "",
    }),
  } as unknown as Zotero.Item;
}

describe("library_read unified metadata", function () {
  const originalZotero = globalThis.Zotero;

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  function makeTool() {
    const items = new Map<number, Zotero.Item>([
      [7, makeItem({ id: 7, kind: "regular", title: "Exact Paper" })],
      [
        701,
        makeItem({
          id: 701,
          kind: "attachment",
          title: "Supplement",
          parentID: 7,
        }),
      ],
      [
        801,
        makeItem({
          id: 801,
          kind: "note",
          title: "Child Note",
          parentID: 7,
        }),
      ],
    ]);
    const requestedItemIds: number[] = [];
    const gateway = {
      listPaperContexts: () => [],
      getItem: (itemId: number) => {
        requestedItemIds.push(itemId);
        return items.get(itemId) || null;
      },
      getPaperTargetsByItemIds: () => [],
      resolveMetadataItem: ({ itemId }: { itemId?: number }) =>
        itemId ? items.get(itemId) || null : null,
      getItemCollectionIds: () => [],
      getPaperNotes: () => [],
      getPaperAnnotations: () => [],
      getAllChildAttachmentInfos: async () => [],
      getCollectionSummary: () => null,
      getStandaloneNoteContent: ({ noteId }: { noteId: number }) => ({
        noteId,
        title: "Child Note",
        noteText: "Note body",
        wordCount: 2,
      }),
    };
    return {
      tool: createReadLibraryTool(gateway as never),
      requestedItemIds,
    };
  }

  const context = {
    request: {
      conversationKey: 1,
      mode: "agent",
      userText: "read",
      conversationKind: "paper",
      activeItemId: 7,
      turnPaperScope: {
        libraryID: 1,
        conversationKind: "paper",
        papers: [],
        collections: [],
        tags: [],
        selectedPassagePaperRefs: [],
      },
      zoteroMetadataContext: { papers: [] },
    },
    item: null,
    modelName: "test",
    currentAnswerText: "",
  } as never;

  it("rejects explicitly supplied empty or malformed selectors", function () {
    const { tool } = makeTool();
    assert.isFalse(tool.validate({ itemIds: [], sections: ["metadata"] }).ok);
    assert.isFalse(
      tool.validate({ itemIds: [7, -1], sections: ["metadata"] }).ok,
    );
    assert.isFalse(
      tool.validate({ paperContexts: [{}], sections: ["metadata"] }).ok,
    );
  });

  it("does not replace a missing explicit item with the active item", async function () {
    const { tool, requestedItemIds } = makeTool();
    const validated = tool.validate({
      itemIds: [999],
      sections: ["metadata"],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = (await tool.execute(validated.value, context)) as {
      results: Record<string, unknown>;
      warnings: string[];
    };
    assert.deepEqual(result.results, {});
    assert.include(result.warnings[0], "999");
    assert.notInclude(requestedItemIds, 7);
  });

  it("returns partial explicit results and warnings without changing identity", async function () {
    const { tool } = makeTool();
    const validated = tool.validate({
      itemIds: [7, 999],
      sections: ["metadata"],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = (await tool.execute(validated.value, context)) as any;
    assert.deepEqual(Object.keys(result.results), ["7"]);
    assert.equal(result.results["7"].metadata.schemaVersion, 1);
    assert.equal(result.results["7"].metadata.kind, "regular");
    assert.equal(result.results["7"].metadata.itemId, 7);
    assert.deepEqual(result.results["7"].metadata.creators, [
      {
        creatorType: "author",
        firstName: "Test",
        lastName: "Author",
        fieldMode: 0,
      },
    ]);
    assert.equal(
      result.results["7"].metadata.system.dateAdded,
      "2026-08-28 10:00:00",
    );
    assert.equal(result.results["7"].metadata.system.version, 3);
    assert.include(result.warnings[0], "999");
  });

  it("preserves attachments and notes as their exact item kinds", async function () {
    const { tool } = makeTool();
    const attachmentInput = tool.validate({
      itemIds: [701],
      sections: ["metadata", "notes"],
    });
    assert.isTrue(attachmentInput.ok);
    if (!attachmentInput.ok) return;
    const attachmentResult = (await tool.execute(
      attachmentInput.value,
      context,
    )) as any;
    assert.equal(attachmentResult.results["701"].metadata.kind, "attachment");
    assert.equal(attachmentResult.results["701"].metadata.itemId, 701);
    assert.equal(attachmentResult.results["701"].metadata.parentItemId, 7);
    assert.match(attachmentResult.warnings[0], /does not apply/);

    const noteInput = tool.validate({
      itemIds: [801],
      sections: ["metadata", "content"],
    });
    assert.isTrue(noteInput.ok);
    if (!noteInput.ok) return;
    const noteResult = (await tool.execute(noteInput.value, context)) as any;
    assert.equal(noteResult.results["801"].metadata.kind, "note");
    assert.equal(noteResult.results["801"].metadata.itemId, 801);
    assert.equal(noteResult.results["801"].metadata.noteKind, "item");
    assert.equal(noteResult.results["801"].notes[0].noteText, "Note body");
  });
});
