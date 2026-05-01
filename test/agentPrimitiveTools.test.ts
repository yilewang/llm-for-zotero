import { assert } from "chai";
import { buildAgentInitialMessages } from "../src/agent/model/messageBuilder";
import { EDITABLE_ARTICLE_METADATA_FIELDS } from "../src/agent/services/zoteroGateway";
import { clearUndoStack, peekUndoEntry } from "../src/agent/store/undoStore";
import { PdfService } from "../src/agent/services/pdfService";
import { RetrievalService } from "../src/agent/services/retrievalService";
import { createQueryLibraryTool } from "../src/agent/tools/read/queryLibrary";
import { createReadLibraryTool } from "../src/agent/tools/read/readLibrary";
import { createReadPaperTool } from "../src/agent/tools/read/readPaper";
import { createSearchPaperTool } from "../src/agent/tools/read/searchPaper";
import { createFileIOTool } from "../src/agent/tools/write/fileIO";
import { createEditCurrentNoteTool } from "../src/agent/tools/write/editCurrentNote";
import { createApplyTagsTool } from "../src/agent/tools/write/applyTags";
import type { AgentToolContext } from "../src/agent/types";
import type { PaperContextRef } from "../src/shared/types";
import type { PdfContext } from "../src/modules/contextPanel/types";

function makeMetadataSnapshot(itemId: number, title: string) {
  return {
    itemId,
    itemType: "journalArticle",
    title,
    fields: Object.fromEntries(
      EDITABLE_ARTICLE_METADATA_FIELDS.map((field) => [field, ""]),
    ) as Record<(typeof EDITABLE_ARTICLE_METADATA_FIELDS)[number], string>,
    creators: [],
  };
}

function makePdfContext(chunks: string[]): PdfContext {
  return {
    title: "Citation Paper",
    chunks,
    chunkMeta: chunks.map((text, index) => ({
      chunkIndex: index,
      text,
      normalizedText: text.toLowerCase(),
      chunkKind: "body",
    })),
    chunkStats: chunks.map((chunk, index) => ({
      index,
      length: chunk.split(/\s+/).filter(Boolean).length,
      tf: {},
      uniqueTerms: [],
    })),
    docFreq: {},
    avgChunkLength: chunks.length ? chunks.join(" ").split(/\s+/).length / chunks.length : 0,
    fullLength: chunks.join("\n\n").length,
  };
}

class FakePdfService extends PdfService {
  constructor(private readonly context: PdfContext) {
    super();
  }

  async ensurePaperContext(_paperContext: PaperContextRef): Promise<PdfContext> {
    return this.context;
  }
}

describe("primitive agent tools", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;
  const baseContext: AgentToolContext = {
    request: {
      conversationKey: 42,
      mode: "agent",
      userText: "organize the library",
      activeItemId: 9,
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.4",
  };

  before(function () {
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Prefs: {
        get: () => "",
        set: () => undefined,
      },
    };
  });

  after(function () {
    globalScope.Zotero = originalZotero;
  });

  afterEach(function () {
    clearUndoStack(baseContext.request.conversationKey);
  });

  it("query_library searches items and enriches requested fields", async function () {
    const tool = createQueryLibraryTool({
      resolveLibraryID: () => 1,
      searchAllLibraryItems: async () =>
        [
          {
            itemId: 99,
            itemType: "journalArticle",
            title: "Example Paper",
            firstCreator: "Alice Example",
            year: "2021",
            attachments: [{ contextItemId: 501, title: "PDF" }],
            tags: ["review"],
            collectionIds: [11],
          },
        ] as any,
      getPaperTargetsByItemIds: () => [
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
      getEditableArticleMetadata: () => makeMetadataSnapshot(99, "Example Paper"),
      getItem: () => ({ id: 99 }) as any,
      getActiveContextItem: () => null,
      listCollectionSummaries: () => [],
      listLibraryPaperTargets: async () => ({ papers: [], totalCount: 0 }),
      listUnfiledPaperTargets: async () => ({ papers: [], totalCount: 0 }),
      listUntaggedPaperTargets: async () => ({ papers: [], totalCount: 0 }),
      listCollectionPaperTargets: async () => ({
        collection: { collectionId: 11, name: "Biology", libraryID: 1 },
        papers: [],
        totalCount: 0,
      }),
      findRelatedPapersInLibrary: async () => ({
        referenceTitle: "Ref",
        relatedPapers: [],
      }),
      detectDuplicatesInLibrary: async () => ({
        totalGroups: 0,
        groups: [],
      }),
      getCollectionSummary: (collectionId: number) =>
        collectionId === 11
          ? {
              collectionId: 11,
              name: "Biology",
              libraryID: 1,
              path: "Biology",
            }
          : null,
    } as never);

    const validated = tool.validate({
      entity: "items",
      mode: "search",
      text: "example",
      include: ["metadata", "attachments", "tags", "collections"],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, baseContext);
    assert.deepEqual((result as { warnings: unknown[] }).warnings, []);
    const first = (result as { results: Array<Record<string, unknown>> }).results[0];
    assert.equal(first.itemId, 99);
    assert.equal((first.metadata as { title?: string }).title, "Example Paper");
    assert.deepEqual(first.attachments, [{ contextItemId: 501, title: "PDF" }]);
    assert.deepEqual(first.tags, ["review"]);
    assert.deepEqual(first.collections, [
      { collectionId: 11, name: "Biology", libraryID: 1, path: "Biology" },
    ]);
  });

  it("query_library related mode resolves the active paper from reader context", async function () {
    let receivedReferenceItemId = 0;
    const tool = createQueryLibraryTool({
      resolveLibraryID: () => 1,
      listPaperContexts: () => [
        {
          itemId: 77,
          contextItemId: 2000000001,
          title: "Reader Context Paper",
        },
      ],
      getActivePaperContext: () => ({
        itemId: 77,
        contextItemId: 2000000001,
        title: "Reader Context Paper",
      }),
      getItem: () => null,
      findRelatedPapersInLibrary: async ({ referenceItemId }: { referenceItemId: number }) => {
        receivedReferenceItemId = referenceItemId;
        return {
          referenceTitle: "Reader Context Paper",
          relatedPapers: [
            {
              itemId: 88,
              title: "Nearby Paper",
              firstCreator: "Dana Example",
              year: "2022",
              attachments: [],
              tags: [],
              collectionIds: [],
              matchScore: 0.72,
              matchReasons: ["title_overlap"],
            },
          ],
        };
      },
      getEditableArticleMetadata: () => null,
      listCollectionSummaries: () => [],
      listLibraryPaperTargets: async () => ({ papers: [], totalCount: 0 }),
      listUnfiledPaperTargets: async () => ({ papers: [], totalCount: 0 }),
      listUntaggedPaperTargets: async () => ({ papers: [], totalCount: 0 }),
      listCollectionPaperTargets: async () => ({
        collection: { collectionId: 11, name: "Biology", libraryID: 1 },
        papers: [],
        totalCount: 0,
      }),
      searchLibraryItems: async () => [],
      detectDuplicatesInLibrary: async () => ({
        totalGroups: 0,
        groups: [],
      }),
      getCollectionSummary: () => null,
      getPaperTargetsByItemIds: () => [],
    } as never);

    const validated = tool.validate({
      entity: "items",
      mode: "related",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        activeItemId: 2000000001,
      },
    });
    assert.equal(receivedReferenceItemId, 77);
    assert.equal((result as { referenceItemId: number }).referenceItemId, 77);
    assert.lengthOf((result as { results: unknown[] }).results, 1);
  });

  it("read_library returns item state keyed by itemId", async function () {
    const fakeItem = {
      id: 7,
      getDisplayTitle: () => "Paper Seven",
    } as any;
    const tool = createReadLibraryTool({
      listPaperContexts: () => [],
      getPaperTargetsByItemIds: () => [
        {
          itemId: 7,
          title: "Paper Seven",
          firstCreator: "Dana Example",
          year: "2020",
          attachments: [{ contextItemId: 701, title: "Main PDF", contentType: "application/pdf" }],
          tags: ["alpha"],
          collectionIds: [12],
        },
      ],
      getItem: () => fakeItem,
      resolveMetadataItem: () => fakeItem,
      getEditableArticleMetadata: () => makeMetadataSnapshot(7, "Paper Seven"),
      getPaperNotes: () => [
        {
          noteId: 801,
          title: "Summary",
          noteText: "Important note",
          wordCount: 2,
        },
      ],
      getPaperAnnotations: () => [
        {
          annotationId: 901,
          type: "highlight",
          text: "Key line",
        },
      ],
      getAllChildAttachmentInfos: async () => [
        { contextItemId: 701, title: "Main PDF", contentType: "application/pdf" },
      ],
      getCollectionSummary: () => ({
        collectionId: 12,
        name: "Reading",
        libraryID: 1,
        path: "Reading",
      }),
    } as never);

    const validated = tool.validate({
      itemIds: [7],
      sections: ["metadata", "notes", "annotations", "attachments", "collections"],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, baseContext);
    const entry = (result as { results: Record<string, any> }).results["7"];
    assert.equal(entry.title, "Paper Seven");
    assert.lengthOf(entry.notes, 1);
    assert.lengthOf(entry.annotations, 1);
    assert.deepEqual(entry.attachments, [{ contextItemId: 701, title: "Main PDF", contentType: "application/pdf" }]);
    assert.deepEqual(entry.collections, [
      { collectionId: 12, name: "Reading", libraryID: 1, path: "Reading" },
    ]);
  });

  it("builds system instructions around the primitive tool names", async function () {
    const messages = await buildAgentInitialMessages(
      {
        conversationKey: 1,
        mode: "agent",
        userText: "Summarize this paper",
        selectedPaperContexts: [
          { itemId: 1, contextItemId: 101, title: "Paper One" },
        ],
      },
      [],
      [],
    );
    const systemText =
      typeof messages[0]?.content === "string" ? messages[0].content : "";
    assert.include(systemText, "search_literature_online");
    assert.include(systemText, "query_library");
    assert.include(systemText, "read_library");
    assert.include(systemText, "read_paper");
    assert.include(systemText, "apply_tags");
    assert.include(
      systemText,
      "the search_literature_online review card is the deliverable",
    );
    assert.notInclude(systemText, "search_related_papers_online");
    assert.notInclude(systemText, "read_paper_front_matter");
  });

  it("adds selected collection scopes to the agent user context summary", async function () {
    const messages = await buildAgentInitialMessages(
      {
        conversationKey: 3,
        mode: "agent",
        userText: "Compare the papers in this collection",
        selectedCollectionContexts: [
          {
            collectionId: 55,
            name: "Methods",
            libraryID: 1,
          },
        ],
      },
      [],
      [],
    );
    const userMessage = messages[messages.length - 1];
    const userText =
      typeof userMessage?.content === "string" ? userMessage.content : "";

    assert.include(userText, "Selected Zotero collection scopes:");
    assert.include(userText, "Methods [collectionId=55, libraryID=1]");
    assert.include(userText, "query_library with filters.collectionId");
    assert.include(userText, "Do not assume all full text has already been read.");
    assert.include(userText, "plan a batch workflow");
  });

  it("adds exact source labels to agent selected-text and paper refs", async function () {
    const selectedPaper: PaperContextRef = {
      itemId: 10,
      contextItemId: 11,
      title: "Selected Paper",
      firstCreator: "Smith",
      year: "2021",
    };
    const fullTextPaper: PaperContextRef = {
      itemId: 20,
      contextItemId: 21,
      title: "Full Text Paper",
      firstCreator: "Lee",
      year: "2022",
    };
    const messages = await buildAgentInitialMessages(
      {
        conversationKey: 4,
        mode: "agent",
        userText: "Explain this quote and compare it to the full paper.",
        selectedTexts: ["important quoted passage"],
        selectedTextSources: ["pdf"],
        selectedTextPaperContexts: [selectedPaper],
        selectedPaperContexts: [selectedPaper],
        fullTextPaperContexts: [fullTextPaper],
      },
      [],
      [],
    );
    const userMessage = messages[messages.length - 1];
    const userText =
      typeof userMessage?.content === "string" ? userMessage.content : "";

    assert.include(userText, "source_label=(Smith, 2021)");
    assert.include(userText, "citationLabel=Smith, 2021");
    assert.include(userText, "sourceLabel=(Lee, 2022)");
    assert.include(userText, "for direct quotes and substantive paper-grounded claims");
  });

  it("file_io adds source metadata only for Codex app-server MinerU paper reads", async function () {
    const scope = globalThis as typeof globalThis & {
      IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
    };
    const originalIOUtils = scope.IOUtils;
    scope.IOUtils = {
      read: async () => new TextEncoder().encode("Paper section text."),
    };
    try {
      const paperContext: PaperContextRef = {
        itemId: 50,
        contextItemId: 51,
        title: "MinerU Paper",
        firstCreator: "Chandra et al.",
        year: "2025",
        mineruCacheDir: "/tmp/llm-for-zotero-mineru/51",
      };
      const tool = createFileIOTool();
      const validated = tool.validate({
        action: "read",
        filePath: "/tmp/llm-for-zotero-mineru/51/full.md",
      });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;

      const codexResult = await tool.execute(validated.value, {
        ...baseContext,
        request: {
          ...baseContext.request,
          authMode: "codex_app_server",
          fullTextPaperContexts: [paperContext],
        },
      });
      const codexContent = (codexResult as { content: Record<string, unknown> }).content;
      assert.equal(codexContent.citationLabel, "Chandra et al., 2025");
      assert.equal(codexContent.sourceLabel, "(Chandra et al., 2025)");
      assert.deepInclude(codexContent.paperContext as Record<string, unknown>, {
        itemId: 50,
        contextItemId: 51,
      });
      assert.include(
        String(codexContent.citationInstruction || ""),
        "short verbatim blockquote",
      );

      const normalResult = await tool.execute(validated.value, {
        ...baseContext,
        request: {
          ...baseContext.request,
          authMode: "api_key",
          fullTextPaperContexts: [paperContext],
        },
      });
      const normalContent = (normalResult as { content: Record<string, unknown> }).content;
      assert.notProperty(normalContent, "citationInstruction");
      assert.notProperty(normalContent, "sourceLabel");
    } finally {
      scope.IOUtils = originalIOUtils;
    }
  });

  it("read_paper returns citation and source labels", async function () {
    const paperContext: PaperContextRef = {
      itemId: 30,
      contextItemId: 31,
      title: "Citation Paper",
      firstCreator: "Nguyen",
      year: "2023",
    };
    const tool = createReadPaperTool(
      new FakePdfService(makePdfContext(["Abstract text.", "Introduction text."])),
      {} as never,
    );
    const validated = tool.validate({
      target: { paperContext },
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, baseContext);
    const first = (result as { results: Array<Record<string, unknown>> }).results[0];
    assert.equal(first.citationLabel, "Nguyen, 2023");
    assert.equal(first.sourceLabel, "(Nguyen, 2023)");
  });

  it("search_paper returns citation and source labels", async function () {
    const paperContext: PaperContextRef = {
      itemId: 40,
      contextItemId: 41,
      title: "Retrieval Paper",
      firstCreator: "Rivera",
      year: "2024",
    };
    const pdfService = new FakePdfService(makePdfContext(["Evidence text."]));
    const retrievalService = new RetrievalService(
      pdfService,
      async () =>
        [
          {
            paperKey: "40:41",
            itemId: 40,
            contextItemId: 41,
            title: "Retrieval Paper",
            firstCreator: "Rivera",
            year: "2024",
            chunkIndex: 0,
            chunkText: "Evidence text.",
            estimatedTokens: 4,
            bm25Score: 1,
            embeddingScore: 0,
            hybridScore: 1,
            evidenceScore: 1,
          },
        ] as never,
    );
    const tool = createSearchPaperTool(
      retrievalService,
      pdfService,
      {} as never,
    );
    const validated = tool.validate({
      target: { paperContext },
      question: "evidence",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, baseContext);
    const first = (result as { results: Array<Record<string, unknown>> }).results[0];
    assert.equal(first.citationLabel, "Rivera, 2024");
    assert.equal(first.sourceLabel, "(Rivera, 2024)");
  });

  it("adds direct-card guidance for write tool requests", async function () {
    const messages = await buildAgentInitialMessages(
      {
        conversationKey: 2,
        mode: "agent",
        userText: "can you help me tag these papers?",
      },
      [
        createQueryLibraryTool({} as never),
        createApplyTagsTool({} as never),
      ],
      [],
    );
    const systemText =
      typeof messages[0]?.content === "string" ? messages[0].content : "";
    // The persona instructions now reference the new tool names
    assert.include(systemText, "apply_tags");
    assert.include(systemText, "move_to_collection");
    assert.include(systemText, "confirmation card is the deliverable");
  });

  it("edit_current_note confirms, updates the active note, and records undo", async function () {
    let restoredHtml: { noteId: number; html: string } | null = null;
    const tool = createEditCurrentNoteTool({
      getActiveNoteSnapshot: () => ({
        noteId: 55,
        title: "Draft Note",
        html: "<p>Original body</p>",
        text: "Original body",
        libraryID: 1,
        noteKind: "standalone",
      }),
      replaceCurrentNote: async ({
        content,
        expectedOriginalHtml,
      }: {
        content: string;
        expectedOriginalHtml?: string;
      }) => {
        assert.equal(expectedOriginalHtml, "<p>Original body</p>");
        return {
          noteId: 55,
          title: "Draft Note",
          previousHtml: "<p>Original body</p>",
          previousText: "Original body",
          nextText: content,
        };
      },
      restoreNoteHtml: async (params: { noteId: number; html: string }) => {
        restoredHtml = params;
      },
    } as never);
    const noteRequest = {
      ...baseContext.request,
      activeNoteContext: {
        noteId: 55,
        title: "Draft Note",
        noteKind: "standalone" as const,
        noteText: "Original body",
      },
    };

    // edit_current_note is always available (supports both edit and create modes)
    assert.isTrue(tool.isAvailable?.(baseContext.request) !== false);
    assert.isTrue(tool.isAvailable?.(noteRequest) !== false);

    const validated = tool.validate({
      content: "Rewritten body",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const pending = tool.createPendingAction?.(validated.value, {
      ...baseContext,
      request: noteRequest,
    });
    assert.exists(pending);
    assert.deepEqual(
      pending?.fields.map((field) => field.type),
      ["diff_preview"],
    );
    assert.equal(pending?.mode, "review");
    const reviewField = pending?.fields[0] as Extract<
      NonNullable<typeof pending>["fields"][number],
      { type: "diff_preview" }
    >;
    assert.equal(reviewField.before, "Original body");
    assert.equal(reviewField.after, "Rewritten body");
    assert.isUndefined(reviewField.sourceFieldId);

    const confirmed = tool.applyConfirmation?.(
      validated.value,
      {},
      {
        ...baseContext,
        request: noteRequest,
      },
    );
    assert.isTrue(confirmed?.ok);
    if (!confirmed?.ok) return;

    const result = await tool.execute(confirmed.value, {
      ...baseContext,
      request: noteRequest,
    });
    assert.deepEqual(result, {
      status: "updated",
      noteId: 55,
      title: "Draft Note",
      noteText: "Rewritten body",
    });

    const undoEntry = peekUndoEntry(baseContext.request.conversationKey);
    assert.exists(undoEntry);
    await undoEntry?.revert();
    assert.deepEqual(restoredHtml, {
      noteId: 55,
      html: "<p>Original body</p>",
    });
  });

  it("edit_current_note normalizes HTML note content before review and save", async function () {
    const tool = createEditCurrentNoteTool({
      getActiveNoteSnapshot: () => ({
        noteId: 55,
        title: "",
        html: "<div><p></p></div>",
        text: "",
        libraryID: 1,
        noteKind: "standalone",
      }),
      replaceCurrentNote: async ({
        content,
      }: {
        content: string;
      }) => {
        assert.equal(content, "Approved *note*");
        return {
          noteId: 55,
          title: "",
          previousHtml: "<div><p></p></div>",
          previousText: "",
          nextText: content,
        };
      },
      restoreNoteHtml: async () => {},
    } as never);
    const noteRequest = {
      ...baseContext.request,
      activeNoteContext: {
        noteId: 55,
        title: "",
        noteKind: "standalone" as const,
        noteText: "",
      },
    };

    const validated = tool.validate({
      content: "<h1>Summary</h1><p><strong>Key point</strong></p>",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    assert.equal(validated.value.content, "# Summary\n\n**Key point**");

    const pending = tool.createPendingAction?.(validated.value, {
      ...baseContext,
      request: noteRequest,
    });
    assert.exists(pending);
    assert.include(pending?.description || "", '"Untitled note"');
    const diffField = pending?.fields[0] as Extract<
      NonNullable<typeof pending>["fields"][number],
      { type: "diff_preview" }
    >;
    assert.equal(diffField.before, "");
    assert.equal(diffField.after, "# Summary\n\n**Key point**");
    assert.equal(diffField.emptyMessage, "No note changes yet.");
    assert.lengthOf(pending?.fields || [], 1);

    const confirmed = tool.applyConfirmation?.(
      validated.value,
      { content: "<p>Approved <em>note</em></p>" },
      {
        ...baseContext,
        request: noteRequest,
      },
    );
    assert.isTrue(confirmed?.ok);
    if (!confirmed?.ok) return;
    assert.equal(confirmed.value.content, "Approved *note*");

    const result = await tool.execute(confirmed.value, {
      ...baseContext,
      request: noteRequest,
    });
    assert.equal((result as { noteText: string }).noteText, "Approved *note*");
  });

  it("includes the active note content in agent prompts", async function () {
    const messages = await buildAgentInitialMessages(
      {
        conversationKey: 7,
        mode: "agent",
        userText: "Revise the note",
        activeItemId: 55,
        selectedTexts: ["This sentence needs work."],
        selectedTextSources: ["note-edit"],
        activeNoteContext: {
          noteId: 55,
          title: "Draft Note",
          noteKind: "item",
          parentItemId: 9,
          noteText: "Current note body",
        },
      },
      [],
      [],
    );
    const userMessage = messages[messages.length - 1];
    const userText =
      typeof userMessage?.content === "string" ? userMessage.content : "";
    assert.include(userText, "Active note: Draft Note");
    assert.include(userText, "Active note parent item ID: 9");
    assert.include(userText, "Current note content for this turn");
    assert.include(userText, "Current note body");
    assert.include(
      userText,
      "Selected text 1 [source=active note editing focus]:",
    );
    assert.include(userText, "This sentence needs work.");
  });

  it("includes active note content in agent prompts without selected note text", async function () {
    const messages = await buildAgentInitialMessages(
      {
        conversationKey: 7,
        mode: "agent",
        userText: "Edit this note",
        activeItemId: 55,
        activeNoteContext: {
          noteId: 55,
          title: "Draft Note",
          noteKind: "item",
          parentItemId: 9,
          noteText: "Current note body",
        },
      },
      [],
      [],
    );
    const userMessage = messages[messages.length - 1];
    const userText =
      typeof userMessage?.content === "string" ? userMessage.content : "";
    assert.include(userText, "Active note: Draft Note");
    assert.include(userText, "Current note content for this turn");
    assert.include(userText, "Current note body");
    assert.notInclude(userText, "Selected text 1");
  });
});
