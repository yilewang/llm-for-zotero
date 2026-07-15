import { assert } from "chai";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import {
  BUILTIN_SKILL_FILES,
  getSkillContextEligibility,
  getMatchedSkillIds,
  parseSkill,
  setUserSkills,
} from "../src/agent/skills";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import type { AgentToolContext } from "../src/agent/types";
import {
  PDF_FIGURE_CROP_ALGORITHM_VERSION,
  PDF_FIGURE_CROP_CACHE_VERSION,
  buildPdfFigureCropManifestHash,
  buildPdfFigureCropPdfFingerprint,
} from "../src/modules/contextPanel/pdfFigureCropCache";
import { CodexAppServerProcess } from "../src/utils/codexAppServerProcess";

describe("semantic tool surface", function () {
  const encoder = new TextEncoder();
  const globalScope = globalThis as typeof globalThis & {
    IOUtils?: unknown;
  };

  afterEach(function () {
    setUserSkills([]);
  });

  const baseContext: AgentToolContext = {
    request: {
      conversationKey: 77,
      mode: "agent",
      userText: "summarize this paper",
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.5",
  };

  function createTestBuiltInRegistry() {
    return createBuiltInToolRegistry({
      zoteroGateway: {} as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
  }

  function schemaProperties(toolName: string): Record<string, unknown> {
    const registry = createTestBuiltInRegistry();
    const tool = registry.getTool(toolName);
    assert.exists(tool, `${toolName} should be registered`);
    const schema = tool!.spec.inputSchema as {
      properties?: Record<string, unknown>;
    };
    return schema.properties || {};
  }

  it("keeps internal delegate tools out of model-visible listings", function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "library_search",
        description: "Public search facade",
        inputSchema: { type: "object" },
        mutability: "read",
        requiresConfirmation: false,
        exposure: "model",
      },
      validate: () => ({ ok: true, value: {} }),
      execute: async () => ({}),
    });
    registry.register({
      spec: {
        name: "query_library",
        description: "Internal legacy delegate",
        inputSchema: { type: "object" },
        mutability: "read",
        requiresConfirmation: false,
        exposure: "internal",
      },
      validate: () => ({ ok: true, value: {} }),
      execute: async () => ({}),
    });

    assert.deepEqual(
      registry.listTools().map((tool) => tool.name),
      ["library_search"],
    );
    assert.deepEqual(
      registry
        .listToolsForRequest(baseContext.request)
        .map((tool) => tool.name),
      ["library_search"],
    );
    assert.exists(registry.getTool("query_library"));
  });

  it("exposes the semantic built-in surface and hides legacy primitive names", function () {
    const registry = createTestBuiltInRegistry();
    const tools = registry.listToolsForRequest(baseContext.request);
    const names = tools.map((tool) => tool.name).sort();

    assert.deepEqual(names, [
      "attachment_update",
      "collection_update",
      "file_io",
      "library_delete",
      "library_import",
      "library_read",
      "library_retrieve",
      "library_search",
      "library_update",
      "literature_search",
      "note_write",
      "paper_read",
      "run_command",
      "undo_last_action",
      "zotero_script",
    ]);
    const literatureSearch = tools.find(
      (tool) => tool.name === "literature_search",
    );
    const literatureProperties = (
      literatureSearch?.inputSchema as {
        properties?: Record<string, { enum?: string[] }>;
      }
    )?.properties;
    assert.deepEqual(literatureProperties?.workflow?.enum, [
      "answer",
      "review",
    ]);
    for (const legacyName of [
      "query_library",
      "read_paper",
      "search_paper",
      "view_pdf_pages",
      "search_literature_online",
      "edit_current_note",
      "import_identifiers",
      "update_metadata",
    ]) {
      assert.notInclude(names, legacyName);
      assert.exists(
        registry.getTool(legacyName),
        `${legacyName} remains internally callable`,
      );
    }
    assert.isUndefined(registry.getTool("web_search"));
    for (const name of ["file_io", "run_command", "zotero_script"]) {
      assert.equal(
        tools.find((tool) => tool.name === name)?.tier,
        "advanced",
        `${name} should be advanced`,
      );
    }
  });

  it("does not expose loose top-level schemas for model-visible built-ins", function () {
    const registry = createTestBuiltInRegistry();
    const looseTools = registry
      .listToolsForRequest(baseContext.request)
      .flatMap((tool) => {
        const schema = tool.inputSchema as { additionalProperties?: unknown };
        return schema.additionalProperties === true ? [tool.name] : [];
      });
    assert.deepEqual(looseTools, []);
  });

  it("advertises delegate fields on semantic facade schemas", function () {
    assert.containsAllKeys(schemaProperties("library_import"), [
      "kind",
      "identifiers",
      "filePaths",
      "targetCollectionId",
      "collectionId",
      "libraryID",
    ]);
    assert.containsAllKeys(schemaProperties("library_update"), [
      "kind",
      "action",
      "itemIds",
      "tags",
      "assignments",
      "targetCollectionId",
      "targetCollectionName",
      "collectionId",
      "metadata",
      "operations",
      "itemId",
      "paperContext",
    ]);
    assert.containsAllKeys(schemaProperties("library_delete"), [
      "mode",
      "itemIds",
      "masterItemId",
      "otherItemIds",
    ]);
  });

  it("exposes batch metadata operations in the update_metadata schema", function () {
    assert.containsAllKeys(schemaProperties("update_metadata"), [
      "metadata",
      "operations",
      "paperContext",
    ]);
  });

  it("normalizes bracketed array strings for identifier imports", function () {
    const registry = createTestBuiltInRegistry();
    const tool = registry.getTool("library_import");
    assert.exists(tool);
    const validation = tool!.validate({
      kind: "identifiers",
      identifiers: '["doi1","doi2",]',
    });
    assert.equal(validation.ok, true);
    if (!validation.ok) return;
    assert.equal(validation.value.delegateName, "import_identifiers");
    assert.deepEqual(validation.value.delegateInput.operation.identifiers, [
      "doi1",
      "doi2",
    ]);
  });

  it("keeps real array identifier imports valid", function () {
    const registry = createTestBuiltInRegistry();
    const tool = registry.getTool("library_import");
    assert.exists(tool);
    const validation = tool!.validate({
      kind: "identifiers",
      identifiers: ["doi1", "doi2"],
    });
    assert.equal(validation.ok, true);
    if (!validation.ok) return;
    assert.deepEqual(validation.value.delegateInput.operation.identifiers, [
      "doi1",
      "doi2",
    ]);
  });

  it("rejects non-bracketed string arrays for identifier imports", function () {
    const registry = createTestBuiltInRegistry();
    const tool = registry.getTool("library_import");
    assert.exists(tool);
    for (const identifiers of ["doi1", "doi1,doi2"]) {
      const validation = tool!.validate({
        kind: "identifiers",
        identifiers,
      });
      assert.equal(validation.ok, false, identifiers);
    }
  });

  it("normalizes bracketed array strings for library delete and update", function () {
    const registry = createTestBuiltInRegistry();
    const deleteTool = registry.getTool("library_delete");
    const updateTool = registry.getTool("library_update");
    assert.exists(deleteTool);
    assert.exists(updateTool);

    const deleteValidation = deleteTool!.validate({
      mode: "trash",
      itemIds: "[101,102,]",
    });
    assert.equal(deleteValidation.ok, true);
    if (!deleteValidation.ok) return;
    assert.deepEqual(
      deleteValidation.value.delegateInput.operation.itemIds,
      [101, 102],
    );

    const updateValidation = updateTool!.validate({
      kind: "tags",
      action: "add",
      itemIds: "[101,102,]",
      tags: '["ml","vision",]',
    });
    assert.equal(updateValidation.ok, true);
    if (!updateValidation.ok) return;
    assert.deepEqual(
      updateValidation.value.delegateInput.operation.itemIds,
      [101, 102],
    );
    assert.deepEqual(updateValidation.value.delegateInput.operation.tags, [
      "ml",
      "vision",
    ]);
  });

  it("rejects non-bracketed string arrays for library delete and update", function () {
    const registry = createTestBuiltInRegistry();
    const deleteTool = registry.getTool("library_delete");
    const updateTool = registry.getTool("library_update");
    assert.exists(deleteTool);
    assert.exists(updateTool);

    assert.equal(
      deleteTool!.validate({
        mode: "trash",
        itemIds: "101,102",
      }).ok,
      false,
    );
    assert.equal(
      updateTool!.validate({
        kind: "tags",
        action: "add",
        itemIds: [101],
        tags: "ml,vision",
      }).ok,
      false,
    );
  });

  it("paper_read fails loudly for invalid explicit targets", async function () {
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {
        resolvePaperContextTarget: () => null,
        listPaperContexts: () => [
          {
            itemId: 1,
            contextItemId: 2,
            title: "Ambient paper",
          },
        ],
      } as never,
    );
    const validated = tool.validate({
      mode: "overview",
      target: { itemId: 999, contextItemId: 1000 },
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    try {
      await tool.execute(validated.value, baseContext);
      assert.fail("paper_read should reject invalid explicit targets");
    } catch (error) {
      assert.match(
        error instanceof Error ? error.message : String(error),
        /Could not resolve paper target itemId=999, contextItemId=1000/,
      );
    }
  });

  it("paper_read refuses active-reader fallback in collection-scoped library chat", async function () {
    const activeReaderPaper = {
      itemId: 99,
      contextItemId: 199,
      title: "Chandra Paper",
    };
    const tool = createPaperReadTool(
      {
        getOverviewExcerpt: async () => ({
          text: "should not be read",
          paperContext: activeReaderPaper,
        }),
      } as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: (request: AgentToolContext["request"]) =>
          request.conversationKind === "global" ||
          request.selectedCollectionContexts?.length
            ? []
            : [activeReaderPaper],
        resolvePaperContextTarget: () => activeReaderPaper,
      } as never,
    );
    const validated = tool.validate({ mode: "overview" });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    try {
      await tool.execute(validated.value, {
        ...baseContext,
        request: {
          ...baseContext.request,
          conversationKind: "global",
          activeItemId: activeReaderPaper.itemId,
          selectedCollectionContexts: [
            { collectionId: 4, name: "Computational_Psychiatry", libraryID: 1 },
          ],
        },
      });
      assert.fail("Expected library chat to require explicit paper targets");
    } catch (error) {
      assert.include(
        error instanceof Error ? error.message : String(error),
        "No paper target in library chat",
      );
    }
  });

  it("paper_read keeps active-paper fallback in paper chat", async function () {
    const activeReaderPaper = {
      itemId: 99,
      contextItemId: 199,
      title: "Active Paper",
    };
    const tool = createPaperReadTool(
      {
        getOverviewExcerpt: async ({
          paperContext,
        }: {
          paperContext: unknown;
        }) => ({
          backend: "pdf",
          text: "active paper overview",
          paperContext,
        }),
      } as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [activeReaderPaper],
        resolvePaperContextTarget: () => activeReaderPaper,
      } as never,
    );
    const validated = tool.validate({ mode: "overview" });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const output = await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        conversationKind: "paper",
        activeItemId: activeReaderPaper.itemId,
      },
    });
    const first = (output as { results: Array<Record<string, unknown>> })
      .results[0];
    assert.deepEqual(first.paperContext, activeReaderPaper);
  });

  it("paper_read still accepts explicit collection-enumerated targets in library chat", async function () {
    const collectionPaper = {
      itemId: 11,
      contextItemId: 22,
      title: "Collection Paper",
    };
    const tool = createPaperReadTool(
      {
        getOverviewExcerpt: async ({
          paperContext,
        }: {
          paperContext: unknown;
        }) => ({
          backend: "pdf",
          text: "collection paper overview",
          paperContext,
        }),
      } as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [],
        resolvePaperContextTarget: () => collectionPaper,
      } as never,
    );
    const validated = tool.validate({
      mode: "overview",
      targets: [{ itemId: 11, contextItemId: 22 }],
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const output = await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        conversationKind: "global",
        selectedCollectionContexts: [
          { collectionId: 4, name: "Computational_Psychiatry", libraryID: 1 },
        ],
      },
    });
    const first = (output as { results: Array<Record<string, unknown>> })
      .results[0];
    assert.deepEqual(first.paperContext, collectionPaper);
  });

  it("paper_read overview falls back to Zotero metadata when PDF text is unavailable", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "Metadata Only Paper",
      firstCreator: "Charest",
      year: "2014",
    };
    const tool = createPaperReadTool(
      {
        getOverviewExcerpt: async () => {
          throw new Error("No extractable PDF text available for this paper");
        },
      } as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [paperContext],
        resolvePaperContextTarget: () => paperContext,
        resolveMetadataItem: () => ({ id: 11 }),
        getEditableArticleMetadata: () => ({
          itemId: 11,
          itemType: "journalArticle",
          title: "Metadata Only Paper",
          fields: {
            title: "Metadata Only Paper",
            shortTitle: "",
            abstractNote: "This abstract is enough for a high-level overview.",
            publicationTitle: "Journal of Tests",
            journalAbbreviation: "",
            proceedingsTitle: "",
            date: "2014",
            volume: "",
            issue: "",
            pages: "",
            DOI: "10.1000/meta",
            url: "",
            language: "",
            extra: "",
            ISSN: "",
            ISBN: "",
            publisher: "",
            place: "",
          },
          creators: [
            {
              creatorType: "author",
              firstName: "Iva",
              lastName: "Charest",
            },
          ],
        }),
      } as never,
    );
    const validated = tool.validate({ mode: "overview" });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = await tool.execute(validated.value, baseContext);
    const result = (output as { results?: Array<Record<string, unknown>> })
      .results?.[0];
    assert.equal(result?.backend, "zotero_metadata");
    assert.equal(result?.sourceKind, "zotero_metadata");
    assert.equal(result?.contentStatus, "no_extractable_pdf_text");
    assert.include(String(result?.text || ""), "This abstract is enough");
    assert.equal(result?.sourceLabel, "(Charest, 2014)");
    assert.lengthOf(
      (output as { quoteCitations?: unknown[] }).quoteCitations || [],
      0,
    );
  });

  it("paper_read overview keeps MinerU failure warning while using Zotero metadata fallback", async function () {
    const globalScope = globalThis as typeof globalThis & {
      IOUtils?: { read?: unknown };
    };
    const originalIOUtils = globalScope.IOUtils;
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "Metadata After MinerU Failure",
      firstCreator: "Charest",
      year: "2014",
      mineruCacheDir: "/tmp/missing-mineru-paper",
    };
    globalScope.IOUtils = {
      read: async () => {
        throw new Error("full.md disappeared");
      },
    };
    try {
      const tool = createPaperReadTool(
        {
          getOverviewExcerpt: async () => {
            throw new Error("PDF text extraction failed");
          },
        } as never,
        {} as never,
        {} as never,
        {
          listPaperContexts: () => [paperContext],
          resolvePaperContextTarget: () => paperContext,
          resolveMetadataItem: () => ({ id: 11 }),
          getEditableArticleMetadata: () => ({
            itemId: 11,
            itemType: "journalArticle",
            title: "Metadata After MinerU Failure",
            fields: {
              title: "Metadata After MinerU Failure",
              abstractNote: "Abstract fallback should still be available.",
            },
            creators: [
              {
                creatorType: "author",
                firstName: "Iva",
                lastName: "Charest",
              },
            ],
          }),
        } as never,
      );
      const validated = tool.validate({ mode: "overview" });
      assert.equal(validated.ok, true);
      if (!validated.ok) return;
      const output = await tool.execute(validated.value, baseContext);
      const result = (output as { results?: Array<Record<string, unknown>> })
        .results?.[0];
      assert.equal(result?.backend, "zotero_metadata");
      assert.include(String(result?.text || ""), "Abstract fallback");
      assert.include(String(result?.warning || ""), "full.md disappeared");
      assert.include(
        String(result?.warning || ""),
        "PDF text extraction failed",
      );
    } finally {
      if (originalIOUtils === undefined) {
        delete globalScope.IOUtils;
      } else {
        globalScope.IOUtils = originalIOUtils;
      }
    }
  });

  it("paper_read overview labels metadata fallback when no PDF is attached", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 11,
      title: "Metadata Only Paper",
      firstCreator: "Charest",
      year: "2014",
    };
    const tool = createPaperReadTool(
      {
        getOverviewExcerpt: async () => {
          throw new Error(
            "No PDF attachment is available for this Zotero item",
          );
        },
      } as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [paperContext],
        resolvePaperContextTarget: () => paperContext,
        resolveMetadataItem: () => ({ id: 11 }),
        getEditableArticleMetadata: () => ({
          itemId: 11,
          itemType: "journalArticle",
          title: "Metadata Only Paper",
          fields: {
            title: "Metadata Only Paper",
            abstractNote: "This abstract is all that exists locally.",
          },
          creators: [
            {
              creatorType: "author",
              firstName: "Iva",
              lastName: "Charest",
            },
          ],
        }),
      } as never,
    );
    const validated = tool.validate({ mode: "overview" });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = await tool.execute(validated.value, baseContext);
    const result = (output as { results?: Array<Record<string, unknown>> })
      .results?.[0];
    assert.equal(result?.backend, "zotero_metadata");
    assert.equal(result?.contentStatus, "no_pdf_attachment");
    assert.include(String(result?.warning || ""), "No PDF attachment");
    assert.equal(result?.sourceLabel, "(Charest, 2014)");
  });

  it("paper_read MinerU overview uses citation-compatible source labels", async function () {
    const globalScope = globalThis as typeof globalThis & {
      IOUtils?: { read?: unknown };
    };
    const originalIOUtils = globalScope.IOUtils;
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "MinerU Paper",
      firstCreator: "Miller",
      year: "2025",
      mineruCacheDir: "/tmp/mineru-paper",
    };
    globalScope.IOUtils = {
      read: async () =>
        new TextEncoder().encode(
          "# MinerU Paper\n\nAbstract text.\n\n# Discussion\n\nDiscussion text.",
        ),
    };
    try {
      const tool = createPaperReadTool(
        {} as never,
        {} as never,
        {} as never,
        {
          listPaperContexts: () => [paperContext],
          resolvePaperContextTarget: () => paperContext,
        } as never,
      );
      const validated = tool.validate({ mode: "overview" });
      assert.equal(validated.ok, true);
      if (!validated.ok) return;
      const output = await tool.execute(validated.value, baseContext);
      const result = (output as { results?: Array<Record<string, unknown>> })
        .results?.[0];
      assert.equal(result?.backend, "mineru");
      assert.equal(result?.citationLabel, "Miller, 2025");
      assert.equal(result?.sourceLabel, "(Miller, 2025)");
    } finally {
      if (originalIOUtils === undefined) {
        delete globalScope.IOUtils;
      } else {
        globalScope.IOUtils = originalIOUtils;
      }
    }
  });

  it("paper_read MinerU overview strips legacy source image embeds", async function () {
    const originalIOUtils = globalScope.IOUtils;
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "MinerU Paper",
      firstCreator: "Miller",
      year: "2025",
      mineruCacheDir: "/tmp/mineru-paper",
    };
    globalScope.IOUtils = {
      read: async () =>
        encoder.encode(
          [
            "# MinerU Paper",
            "",
            "Abstract text.",
            "",
            "![](images/raw-abstract.jpg)",
            "",
            "# Discussion",
            "",
            "Discussion text.",
            "",
            "![panel](images/raw-discussion.png)",
          ].join("\n"),
        ),
    };
    try {
      const tool = createPaperReadTool(
        {} as never,
        {} as never,
        {} as never,
        {
          listPaperContexts: () => [paperContext],
          resolvePaperContextTarget: () => paperContext,
        } as never,
      );
      const validated = tool.validate({ mode: "overview" });
      assert.equal(validated.ok, true);
      if (!validated.ok) return;
      const output = await tool.execute(validated.value, baseContext);
      const result = (output as { results?: Array<Record<string, unknown>> })
        .results?.[0];
      const text = String(result?.text || "");
      assert.equal(result?.backend, "mineru");
      assert.include(text, "Abstract text.");
      assert.include(text, "Discussion text.");
      assert.notInclude(text, "images/raw-abstract.jpg");
      assert.notInclude(text, "images/raw-discussion.png");
      assert.notInclude(text, "![](");
    } finally {
      if (originalIOUtils === undefined) {
        delete globalScope.IOUtils;
      } else {
        globalScope.IOUtils = originalIOUtils;
      }
    }
  });

  it("paper_read visual redirects generic MinerU figure requests to cache inspection", async function () {
    const originalIOUtils = globalScope.IOUtils;
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "MinerU Figure Paper",
      firstCreator: "Miller",
      year: "2025",
      mineruCacheDir: "/tmp/mineru-paper",
    };
    const fullMd = [
      "## Results",
      "",
      "![](images/fig2a.png)",
      "",
      "![](images/fig2b.png)",
      "",
      "![](images/fig2c.png)",
      "",
      "Figure 2. Attractor network for probabilistic decision-making.",
    ].join("\n");
    const contentListPath = "/tmp/mineru-paper/paper_content_list.json";
    globalScope.IOUtils = {
      read: async (path: string) => {
        if (path === "/tmp/mineru-paper/full.md") {
          return encoder.encode(fullMd);
        }
        if (path === contentListPath) {
          return encoder.encode(
            JSON.stringify([
              {
                type: "image",
                img_path: "images/fig2a.png",
                image_caption: ["Figure 2. Attractor network."],
              },
              { type: "image", img_path: "images/fig2b.png" },
              { type: "image", img_path: "images/fig2c.png" },
            ]),
          );
        }
        throw new Error(`Unexpected read: ${path}`);
      },
      getChildren: async (path: string) =>
        path === "/tmp/mineru-paper" ? [contentListPath] : [],
    };
    let prepareCalls = 0;
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {
        preparePagesForModel: async () => {
          prepareCalls += 1;
          return {
            target: { source: "library", title: "Should Not Render" },
            pages: [],
            artifacts: [],
            pageTexts: {},
          };
        },
      } as never,
      {
        listPaperContexts: () => [paperContext],
        resolvePaperContextTarget: () => paperContext,
      } as never,
    );
    const validated = tool.validate({
      mode: "visual",
      query: "Explain Figure 2c",
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    try {
      const output = (await tool.execute(validated.value, {
        ...baseContext,
        request: {
          ...baseContext.request,
          userText: "Explain Figure 2c",
          selectedPaperContexts: [paperContext],
        },
      })) as Record<string, unknown>;

      assert.equal(prepareCalls, 0);
      assert.equal(output.status, "use_figures_mode");
      assert.equal(output.backend, "pdf_figure_extraction");
      assert.equal(output.mineruCacheDir, "/tmp/mineru-paper");
      assert.include(String(output.guidance || ""), "mode:'figures'");
      assert.include(
        String(output.guidance || ""),
        "Do not read MinerU image paths",
      );
      assert.notProperty(output, "panelHint");
      assert.notProperty(output, "figureBlocks");
      assert.notProperty(output, "artifacts");
    } finally {
      if (originalIOUtils === undefined) {
        delete globalScope.IOUtils;
      } else {
        globalScope.IOUtils = originalIOUtils;
      }
    }
  });

  it("paper_read visual redirects generic MinerU table requests to text inspection", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "MinerU Table Paper",
      firstCreator: "Miller",
      year: "2025",
      mineruCacheDir: "/tmp/mineru-paper",
    };
    let prepareCalls = 0;
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {
        preparePagesForModel: async () => {
          prepareCalls += 1;
          return {
            target: { source: "library", title: "Should Not Render" },
            pages: [],
            artifacts: [],
            pageTexts: {},
          };
        },
      } as never,
      {
        listPaperContexts: () => [paperContext],
        resolvePaperContextTarget: () => paperContext,
      } as never,
    );
    const validated = tool.validate({
      mode: "visual",
      query: "Explain Table 1",
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const output = (await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        userText: "Explain Table 1",
        selectedPaperContexts: [paperContext],
      },
    })) as Record<string, unknown>;

    assert.equal(prepareCalls, 0);
    assert.equal(output.status, "use_text_mode");
    assert.equal(output.backend, "mineru");
    assert.include(String(output.guidance || ""), "mode:'targeted'");
    assert.notInclude(String(output.guidance || ""), "mode:'figures'");
    assert.notProperty(output, "artifacts");
  });

  it("paper_read visual still renders explicit PDF pages for MinerU papers", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "MinerU Figure Paper",
      firstCreator: "Miller",
      year: "2025",
      mineruCacheDir: "/tmp/mineru-paper",
    };
    let requestedPages: number[] = [];
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {
        preparePagesForModel: async ({ pages }: { pages: number[] }) => {
          requestedPages = pages;
          return {
            target: {
              source: "library",
              title: "MinerU Figure Paper",
              paperContext,
              contextItemId: 22,
              itemId: 11,
            },
            pages: [
              {
                pageIndex: 3,
                pageLabel: "4",
                imagePath: "/tmp/page-4.png",
                contentHash: "hash-page-4",
              },
            ],
            artifacts: [
              {
                kind: "image" as const,
                mimeType: "image/png",
                storedPath: "/tmp/page-4.png",
                pageIndex: 3,
                pageLabel: "4",
              },
            ],
            pageTexts: { 3: "Rendered page text" },
          };
        },
      } as never,
      {
        listPaperContexts: () => [paperContext],
        resolvePaperContextTarget: () => paperContext,
      } as never,
    );
    const validated = tool.validate({
      mode: "visual",
      target: { paperContext },
      pages: [4],
      query: "Render page 4 from the raw PDF",
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        userText: "Render page 4 from the raw PDF",
        selectedPaperContexts: [paperContext],
      },
    })) as {
      content?: { pageCount?: number };
      artifacts?: unknown[];
    };

    assert.deepEqual(requestedPages, [3]);
    assert.equal(output.content?.pageCount, 1);
    assert.lengthOf(output.artifacts || [], 1);
  });

  it("paper_read exposes a dedicated figures mode", function () {
    const registry = createTestBuiltInRegistry();
    const tool = registry.getTool("paper_read");
    assert.exists(tool);
    const modeSchema = (
      tool!.spec.inputSchema as {
        properties?: { mode?: { enum?: string[] } };
      }
    ).properties?.mode;

    assert.include(modeSchema?.enum || [], "figures");
  });

  it("paper_read figures accepts library PDFs without MinerU cache", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "PDF Figure Paper",
      firstCreator: "Miller",
      year: "2025",
    };
    const extractionContexts: unknown[] = [];
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [paperContext],
        resolvePaperContextTarget: () => paperContext,
      } as never,
      {
        extractFigures: async ({ paperContexts }) => {
          extractionContexts.push(...paperContexts);
          return {
            mode: "figures",
            status: "ok",
            query: "Explain Figure 1",
            figures: [
              {
                id: "figure-1",
                label: "Figure 1",
                cropPath:
                  "/tmp/zotero/llm-for-zotero-pdf-figure-crops/22/figure_crops/crops/figure-1.png",
              },
            ],
          };
        },
      },
    );
    const validated = tool.validate({
      mode: "figures",
      query: "Explain Figure 1",
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const output = (await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        userText: "Explain Figure 1",
        selectedPaperContexts: [paperContext],
      },
    })) as Record<string, unknown>;

    assert.equal(output.mode, "figures");
    assert.equal(output.status, "ok");
    assert.deepEqual(extractionContexts, [paperContext]);
  });

  it("paper_read figures hydrates MinerU cache metadata from the Zotero attachment", async function () {
    const scopedPaperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "Scoped Figure Paper",
      firstCreator: "Miller",
      year: "2025",
    };
    const extractionContexts: unknown[] = [];
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [scopedPaperContext],
        resolvePaperContextTarget: () => scopedPaperContext,
        getAllChildAttachmentInfos: async () => [
          {
            contextItemId: 22,
            title: "Scoped Figure Paper.pdf",
            contentType: "application/pdf",
            indexingState: "indexed",
            mineruCacheDir: "/tmp/mineru-paper",
          },
        ],
      } as never,
      {
        extractFigures: async ({ paperContexts }) => {
          extractionContexts.push(...paperContexts);
          return {
            mode: "figures",
            status: "ok",
            query: "Explain Figure 1",
            figures: [
              {
                id: "figure-1",
                label: "Figure 1",
                cropPath: "/tmp/mineru-paper/figure_crops/crops/figure-1.png",
              },
            ],
          };
        },
      },
    );
    const validated = tool.validate({
      mode: "figures",
      query: "Explain Figure 1",
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const output = (await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        userText: "Explain Figure 1",
        selectedPaperContexts: [scopedPaperContext],
      },
    })) as Record<string, unknown>;

    assert.equal(output.status, "ok");
    assert.deepInclude(extractionContexts, {
      ...scopedPaperContext,
      mineruCacheDir: "/tmp/mineru-paper",
      contentSourceMode: "mineru",
    });
  });

  it("paper_read figures returns extracted PDF crops and never MinerU image artifacts", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "MinerU Figure Paper",
      firstCreator: "Miller",
      year: "2025",
      mineruCacheDir: "/tmp/mineru-paper",
    };
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [paperContext],
        resolvePaperContextTarget: () => paperContext,
      } as never,
      {
        extractFigures: async () => ({
          mode: "figures",
          status: "ok",
          query: "Explain Figure 1",
          figures: [
            {
              id: "figure-1",
              label: "Figure 1",
              baseLabel: "Figure 1",
              pageNumber: 2,
              cropPath: "/tmp/mineru-paper/figure_crops/crops/figure-1.png",
              captionText: "Figure 1. A precise crop.",
              rect: { left: 10, top: 20, width: 300, height: 200 },
              confidence: 0.96,
              source: "caption-bounded-region",
              warnings: [],
              mineruBlockId: "block-1",
              mineruImagePaths: ["/tmp/mineru-paper/images/fig1-panel.png"],
            },
          ],
          expectedFigures: [
            {
              label: "Figure 1",
              baseLabel: "Figure 1",
              pageNumber: 2,
              captionPageNumber: 2,
              status: "ok",
            },
            {
              label: "Figure 2",
              baseLabel: "Figure 2",
              pageNumber: 4,
              captionPageNumber: 5,
              status: "no_confident_candidate",
            },
          ],
          missingFigures: [
            {
              label: "Figure 2",
              baseLabel: "Figure 2",
              pageNumber: 4,
              captionPageNumber: 5,
              status: "no_confident_candidate",
            },
          ],
          artifacts: [
            {
              kind: "image" as const,
              mimeType: "image/png",
              storedPath: "/tmp/mineru-paper/figure_crops/crops/figure-1.png",
              title: "Figure 1",
              pageIndex: 1,
              pageLabel: "2",
              paperContext,
            },
          ],
        }),
      },
    );
    const validated = tool.validate({
      mode: "figures",
      query: "Explain Figure 1",
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const output = (await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        userText: "Explain Figure 1",
        selectedPaperContexts: [paperContext],
      },
    })) as {
      content?: {
        mode?: string;
        status?: string;
        expectedFigures?: Array<{ label?: string }>;
        missingFigures?: Array<{ label?: string }>;
        figures?: Array<{ cropPath?: string; mineruImagePaths?: string[] }>;
      };
      artifacts?: Array<{ storedPath?: string }>;
    };

    assert.equal(output.content?.mode, "figures");
    assert.equal(output.content?.status, "ok");
    assert.equal(
      output.content?.figures?.[0]?.cropPath,
      "/tmp/mineru-paper/figure_crops/crops/figure-1.png",
    );
    assert.deepEqual(
      output.content?.missingFigures?.map((figure) => figure.label),
      ["Figure 2"],
    );
    assert.deepEqual(output.content?.figures?.[0]?.mineruImagePaths, [
      "/tmp/mineru-paper/images/fig1-panel.png",
    ]);
    assert.deepEqual(
      (output.artifacts || []).map((artifact) => artifact.storedPath),
      ["/tmp/mineru-paper/figure_crops/crops/figure-1.png"],
    );
  });

  it("paper_read figures returns cached PDF crops before source-PDF extraction", async function () {
    const originalIOUtils = globalScope.IOUtils;
    const cropPath = "/tmp/mineru-paper/figure_crops/crops/figure-1.png";
    const manifest = {
      sections: [],
      allFigures: [
        {
          label: "Figure 1",
          baseLabel: "Figure 1",
          page: 2,
          caption: "Figure 1. A cached crop.",
        },
      ],
      allTables: [],
    };
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "MinerU Figure Paper",
      firstCreator: "Miller",
      year: "2025",
      mineruCacheDir: "/tmp/mineru-paper",
    };
    const files = new Map<string, Uint8Array>([
      [
        "/tmp/mineru-paper/manifest.json",
        encoder.encode(JSON.stringify(manifest)),
      ],
      [cropPath, encoder.encode("png")],
      [
        "/tmp/mineru-paper/figure_crops/figure_geometry.json",
        encoder.encode(
          JSON.stringify({
            version: PDF_FIGURE_CROP_CACHE_VERSION,
            attachmentId: 22,
            manifestHash: buildPdfFigureCropManifestHash(manifest),
            pdfFingerprint: buildPdfFigureCropPdfFingerprint(paperContext),
            renderScale: 1.8,
            algorithmVersion: PDF_FIGURE_CROP_ALGORITHM_VERSION,
            generatedAt: 1,
            expectedFigures: [
              {
                label: "Figure 1",
                baseLabel: "Figure 1",
                pageNumber: 2,
                status: "ok",
                cropPath: "/var/folders/tmp/old-crop.png",
              },
            ],
            missingFigures: [],
            entries: [
              {
                id: "figure-1",
                label: "Figure 1",
                baseLabel: "Figure 1",
                pageNumber: 2,
                cropPath,
                captionText: "Figure 1. A cached crop.",
                rect: { left: 10, top: 20, width: 300, height: 200 },
                confidence: 0.96,
                source: "pdf-image-object",
                warnings: [],
                mineruImagePaths: [],
              },
            ],
          }),
        ),
      ],
    ]);
    globalScope.IOUtils = {
      read: async (path: string) => {
        const bytes = files.get(path);
        if (!bytes) throw new Error(`missing ${path}`);
        return bytes;
      },
      write: async (path: string, bytes: Uint8Array) => {
        files.set(path, bytes);
      },
      makeDirectory: async () => undefined,
    };
    let rawCalled = false;
    try {
      const registry = createBuiltInToolRegistry({
        zoteroGateway: {
          listPaperContexts: () => [paperContext],
          resolvePaperContextTarget: () => paperContext,
        } as never,
        pdfService: {} as never,
        pdfPageService: {
          extractFiguresFromSourcePdf: async () => {
            rawCalled = true;
            throw new Error("source extraction should not run");
          },
        } as never,
        retrievalService: {} as never,
      });
      const tool = registry.getTool("paper_read");
      assert.exists(tool);
      const validated = tool!.validate({
        mode: "figures",
        query: "Explain Figure 1",
      });
      assert.equal(validated.ok, true);
      if (!validated.ok) return;

      const output = (await tool!.execute(validated.value, {
        ...baseContext,
        request: {
          ...baseContext.request,
          userText: "Explain Figure 1",
          selectedPaperContexts: [paperContext],
        },
      })) as {
        content?: { status?: string; figures?: Array<{ cropPath?: string }> };
        artifacts?: Array<{ storedPath?: string }>;
      };

      assert.isFalse(rawCalled);
      assert.equal(output.content?.status, "ok");
      assert.deepEqual(
        output.content?.figures?.map((figure) => figure.cropPath),
        [cropPath],
      );
      assert.deepEqual(
        output.artifacts?.map((artifact) => artifact.storedPath),
        [cropPath],
      );
    } finally {
      if (originalIOUtils === undefined) {
        delete globalScope.IOUtils;
      } else {
        globalScope.IOUtils = originalIOUtils;
      }
    }
  });

  it("paper_read visual renders PDF pages when MinerU cache is absent", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "PDF Figure Paper",
      firstCreator: "Miller",
      year: "2025",
    };
    let requestedPages: number[] = [];
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {
        preparePagesForModel: async ({ pages }: { pages: number[] }) => {
          requestedPages = pages;
          return {
            target: {
              source: "library",
              title: "PDF Figure Paper",
              paperContext,
              contextItemId: 22,
              itemId: 11,
            },
            pages: [
              {
                pageIndex: 1,
                pageLabel: "2",
                imagePath: "/tmp/page-2.png",
                contentHash: "hash-page-2",
              },
            ],
            artifacts: [
              {
                kind: "image" as const,
                mimeType: "image/png",
                storedPath: "/tmp/page-2.png",
                pageIndex: 1,
                pageLabel: "2",
              },
            ],
            pageTexts: { 1: "Rendered page text" },
          };
        },
      } as never,
      {
        listPaperContexts: () => [paperContext],
        resolvePaperContextTarget: () => paperContext,
      } as never,
    );
    const validated = tool.validate({
      mode: "visual",
      target: { paperContext },
      pages: [2],
      query: "Explain Figure 1",
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        userText: "Explain Figure 1",
        selectedPaperContexts: [paperContext],
      },
    })) as {
      content?: { pageCount?: number };
      artifacts?: unknown[];
    };

    assert.deepEqual(requestedPages, [1]);
    assert.equal(output.content?.pageCount, 1);
    assert.lengthOf(output.artifacts || [], 1);
  });

  it("paper_read overview dedupes default paper contexts and traces the source label", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "Memory Palace Paper",
      firstCreator: "Chandra et al.",
      year: "2025",
    };
    let overviewCalls = 0;
    const tool = createPaperReadTool(
      {
        getOverviewExcerpt: async () => {
          overviewCalls += 1;
          return {
            backend: "pdf",
            text: "Overview text.",
            citationLabel: "Chandra et al., 2025",
            sourceLabel: "(Chandra et al., 2025)",
            paperContext,
          };
        },
      } as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [paperContext, { ...paperContext }],
        resolvePaperContextTarget: () => paperContext,
      } as never,
    );
    const validated = tool.validate({ mode: "overview" });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = await tool.execute(validated.value, baseContext);
    assert.equal(overviewCalls, 1);
    assert.lengthOf((output as { results?: unknown[] }).results || [], 1);
    const onSuccess = tool.presentation?.summaries?.onSuccess;
    assert.isFunction(onSuccess);
    if (typeof onSuccess !== "function") return;
    assert.equal(
      onSuccess({ label: "Read Paper", content: output }),
      "Read paper overview from (Chandra et al., 2025)",
    );
    assert.equal(
      onSuccess({
        label: "Read Paper",
        content: {
          mode: "overview",
          results: [
            { sourceLabel: "(Chandra et al., 2025)" },
            { sourceLabel: "(Miller, 2024)" },
          ],
        },
      }),
      "Read paper overviews from 2 sources",
    );
  });

  it("paper_read overview returns quote anchors for extractable paper text", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "Recurrent Attention Paper",
      firstCreator: "Mnih et al.",
      year: "2014",
    };
    const tool = createPaperReadTool(
      {
        getOverviewExcerpt: async () => ({
          backend: "raw_pdf_text",
          text:
            "[chunk 0]\nRecurrent models reduce computation by selecting only a sequence of image locations.\n\n" +
            "[chunk 4]\nThe agent learns where to attend using reinforcement learning from task reward.",
          citationLabel: "Mnih et al., 2014",
          sourceLabel: "(Mnih et al., 2014)",
          pageIndex: 3,
          pageLabel: "4",
          paperContext,
        }),
      } as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [paperContext],
        resolvePaperContextTarget: () => paperContext,
      } as never,
    );
    const validated = tool.validate({ mode: "overview" });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, baseContext)) as {
      results?: Array<{
        quoteCitationIds?: string[];
        quoteAnchors?: string[];
      }>;
      quoteCitations?: Array<{
        id: string;
        quoteText: string;
        citationLabel: string;
        pageHintIndex?: number;
        pageHintLabel?: string;
      }>;
    };

    assert.lengthOf(output.quoteCitations || [], 2);
    assert.equal(
      output.quoteCitations?.[0]?.quoteText,
      "Recurrent models reduce computation by selecting only a sequence of image locations.",
    );
    assert.equal(
      output.quoteCitations?.[0]?.citationLabel,
      "(Mnih et al., 2014)",
    );
    assert.equal(output.quoteCitations?.[0]?.pageHintIndex, 3);
    assert.equal(output.quoteCitations?.[0]?.pageHintLabel, "4");
    assert.deepEqual(
      output.results?.[0]?.quoteCitationIds,
      output.quoteCitations?.map((citation) => citation.id),
    );
    assert.deepEqual(
      output.results?.[0]?.quoteAnchors,
      output.quoteCitations?.map((citation) => `[[quote:${citation.id}]]`),
    );
  });

  it("paper_read overview does not anchor publisher DOI boilerplate", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "Visual Cortex Paper",
      firstCreator: "Liu et al.",
      year: "2026",
    };
    const substantiveSentence =
      "Task learning increased information redundancy in macaque visual cortex without reducing population-level information.";
    const boilerplate =
      "Full article and list of author affiliations: https://doi.org/10.1126/science.adw7707";
    const tool = createPaperReadTool(
      {
        getOverviewExcerpt: async () => ({
          backend: "raw_pdf_text",
          text:
            `[chunk 0]\n${boilerplate}\n\n` +
            `[chunk 4]\n${substantiveSentence}`,
          citationLabel: "Liu et al., 2026",
          sourceLabel: "(Liu et al., 2026)",
          paperContext,
        }),
      } as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [paperContext],
        resolvePaperContextTarget: () => paperContext,
      } as never,
    );
    const validated = tool.validate({ mode: "overview" });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, baseContext)) as {
      results?: Array<{ quoteAnchors?: string[] }>;
      quoteCitations?: Array<{ quoteText: string }>;
    };

    assert.lengthOf(output.quoteCitations || [], 1);
    assert.equal(output.quoteCitations?.[0]?.quoteText, substantiveSentence);
    assert.notInclude(
      output.quoteCitations?.map((citation) => citation.quoteText).join("\n"),
      boilerplate,
    );
    assert.lengthOf(output.results?.[0]?.quoteAnchors || [], 1);
  });

  it("paper_read targeted returns grouped per-paper evidence while preserving flat results", async function () {
    const firstPaper = {
      itemId: 11,
      contextItemId: 22,
      title: "First Paper",
      firstCreator: "Huys",
      year: "2016",
    };
    const secondPaper = {
      itemId: 33,
      contextItemId: 44,
      title: "Second Paper",
      firstCreator: "Montague",
      year: "2012",
    };
    const tool = createPaperReadTool(
      {
        ensurePaperContext: async () => ({ chunks: ["methods"] }),
      } as never,
      {
        retrieveEvidence: async () => [
          {
            paperContext: firstPaper,
            chunkIndex: 1,
            sectionLabel: "Methods",
            text: "First method passage.",
            score: 4.5,
            citationLabel: "Huys, 2016",
            sourceLabel: "(Huys, 2016)",
            pageIndex: 4,
            pageLabel: "5",
          },
          {
            paperContext: secondPaper,
            chunkIndex: 2,
            sectionLabel: "Methods",
            text: "Second method passage.",
            score: 3.5,
            citationLabel: "Montague, 2012",
            sourceLabel: "(Montague, 2012)",
          },
        ],
      } as never,
      {} as never,
      {
        resolvePaperContextTarget: ({ itemId }: { itemId?: number }) =>
          itemId === firstPaper.itemId ? firstPaper : secondPaper,
        listPaperContexts: () => [firstPaper, secondPaper],
      } as never,
    );
    const validated = tool.validate({
      mode: "targeted",
      query: "methods methodology method section",
      targets: [
        { itemId: 11, contextItemId: 22 },
        { itemId: 33, contextItemId: 44 },
      ],
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, baseContext)) as {
      results?: unknown[];
      quoteCitations?: Array<{
        id: string;
        quoteText: string;
        citationLabel: string;
        pageHintIndex?: number;
        pageHintLabel?: string;
      }>;
      papers?: Array<{
        status?: string;
        sourceLabel?: string;
        passages?: Array<{
          text?: string;
          sectionLabel?: string;
          pageLabel?: string;
          quoteCitationId?: string;
        }>;
      }>;
    };
    assert.lengthOf(output.results || [], 2);
    assert.lengthOf(output.papers || [], 2);
    assert.deepEqual(
      output.papers?.map((paper) => paper.status),
      ["matched", "matched"],
    );
    assert.equal(output.papers?.[0]?.sourceLabel, "(Huys, 2016)");
    assert.equal(output.papers?.[0]?.passages?.[0]?.sectionLabel, "Methods");
    assert.equal(
      output.papers?.[1]?.passages?.[0]?.text,
      "Second method passage.",
    );
    assert.lengthOf(output.quoteCitations || [], 2);
    assert.equal(
      output.quoteCitations?.[0]?.quoteText,
      "First method passage.",
    );
    assert.equal(output.quoteCitations?.[0]?.citationLabel, "(Huys, 2016)");
    assert.equal(output.quoteCitations?.[0]?.pageHintIndex, 4);
    assert.equal(output.quoteCitations?.[0]?.pageHintLabel, "5");
    assert.equal(output.papers?.[0]?.passages?.[0]?.pageLabel, "5");
    assert.equal(
      output.papers?.[0]?.passages?.[0]?.quoteCitationId,
      output.quoteCitations?.[0]?.id,
    );
    const onSuccess = tool.presentation?.summaries?.onSuccess;
    assert.isFunction(onSuccess);
    if (typeof onSuccess !== "function") return;
    assert.equal(
      onSuccess({ label: "Read Paper", content: output }),
      "Read 2 passages from 2 sources",
    );
  });

  it("paper_read full processes every extractable chunk and returns coverage", async function () {
    const paperContext = {
      itemId: 51,
      contextItemId: 52,
      title: "Agent Full Read Paper",
    };
    const chunks = Array.from(
      { length: 6 },
      (_, index) => `Section ${index + 1}\nAgent evidence ${index}.`,
    );
    const seen = new Set<number>();
    const tool = createPaperReadTool(
      {
        ensurePaperContext: async () => ({
          title: paperContext.title,
          chunks,
          chunkMeta: chunks.map((text, chunkIndex) => ({
            chunkIndex,
            text,
            normalizedText: text,
            chunkKind: "body",
          })),
          chunkStats: [],
          docFreq: {},
          avgChunkLength: 0,
          fullLength: chunks.join("\n\n").length,
        }),
      } as never,
      {} as never,
      {} as never,
      {
        resolvePaperContextTarget: () => paperContext,
        listPaperContexts: () => [paperContext],
      } as never,
      undefined,
      async (batch) => {
        for (const chunk of batch.chunks) seen.add(chunk.chunkIndex);
        return {
          digest: `Read ${batch.chunks.map((chunk) => chunk.chunkIndex).join(",")}`,
          relevantChunkIds: batch.chunks.map((chunk) => chunk.chunkIndex),
        };
      },
    );
    const validated = tool.validate({
      mode: "full",
      target: { itemId: 51, contextItemId: 52 },
      query: "Read the complete text.",
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, baseContext)) as {
      mode: string;
      status: string;
      coverageReceipt: {
        complete: boolean;
        processedChunks: number;
        totalChunks: number;
      };
    };

    assert.equal(output.mode, "full");
    assert.equal(output.status, "complete");
    assert.isTrue(output.coverageReceipt.complete);
    assert.equal(output.coverageReceipt.processedChunks, 6);
    assert.equal(output.coverageReceipt.totalChunks, 6);
    assert.deepEqual(
      [...seen].sort((a, b) => a - b),
      [0, 1, 2, 3, 4, 5],
    );
  });

  it("paper_read full uses an isolated native Codex worker in the production registry", async function () {
    const originalSpawn = CodexAppServerProcess.spawn;
    const paperContext = {
      itemId: 53,
      contextItemId: 54,
      title: "Native Full Read Paper",
    };
    const chunks = ["Native evidence zero.", "Native evidence one."];
    let threadStartParams: Record<string, unknown> | undefined;
    let turnStartParams: Record<string, unknown> | undefined;
    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          const request = JSON.parse(chunk) as {
            id: number;
            method: string;
            params?: Record<string, unknown>;
          };
          const handleMessage = (
            proc as unknown as {
              handleMessage: (message: Record<string, unknown>) => void;
            }
          ).handleMessage.bind(proc);
          if (request.method === "thread/start") {
            threadStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { thread: { id: "thread-full-reader" } },
                }),
              0,
            );
            return;
          }
          if (request.method === "turn/start") {
            turnStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { turn: { id: "turn-full-reader" } },
                }),
              0,
            );
            setTimeout(
              () =>
                handleMessage({
                  method: "item/agentMessage/delta",
                  params: {
                    turnId: "turn-full-reader",
                    itemId: "message-full-reader",
                    delta:
                      '{"digest":"Read every native chunk","relevantChunkIds":[0,1]}',
                  },
                }),
              5,
            );
            setTimeout(
              () =>
                handleMessage({
                  method: "turn/completed",
                  params: {
                    turn: { id: "turn-full-reader", status: "completed" },
                  },
                }),
              10,
            );
          }
        },
      },
      kill: () => undefined,
    });
    CodexAppServerProcess.spawn = async () => proc;

    try {
      const registry = createBuiltInToolRegistry({
        zoteroGateway: {
          resolvePaperContextTarget: () => paperContext,
          listPaperContexts: () => [paperContext],
        } as never,
        pdfService: {
          ensurePaperContext: async () => ({
            title: paperContext.title,
            chunks,
            chunkMeta: chunks.map((text, chunkIndex) => ({
              chunkIndex,
              text,
              normalizedText: text,
              chunkKind: "body",
            })),
            chunkStats: [],
            docFreq: {},
            avgChunkLength: 0,
            fullLength: chunks.join("\n\n").length,
          }),
        } as never,
        pdfPageService: {} as never,
        retrievalService: {} as never,
      });
      const tool = registry.getTool("paper_read");
      assert.exists(tool);
      const validated = tool!.validate({
        mode: "full",
        target: paperContext,
        query: "Read the complete text.",
      });
      assert.equal(validated.ok, true);
      if (!validated.ok) return;

      const output = (await tool!.execute(validated.value, {
        ...baseContext,
        request: {
          ...baseContext.request,
          authMode: "codex_app_server",
          model: "gpt-5.5",
          apiBase: "/tmp/codex",
        },
      })) as {
        status: string;
        coverageReceipt: {
          complete: boolean;
          processedChunks: number;
          totalChunks: number;
        };
      };

      assert.equal(output.status, "complete");
      assert.isTrue(output.coverageReceipt.complete);
      assert.equal(output.coverageReceipt.processedChunks, 2);
      assert.equal(output.coverageReceipt.totalChunks, 2);
      assert.equal(threadStartParams?.model, "gpt-5.5");
      assert.equal(threadStartParams?.ephemeral, true);
      assert.equal(threadStartParams?.approvalPolicy, "never");
      assert.include(JSON.stringify(turnStartParams?.input), chunks[0]);
      assert.include(JSON.stringify(turnStartParams?.input), chunks[1]);
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
    }
  });

  it("paper_read full targets the active paper unless all selected papers are explicit", async function () {
    const firstPaper = {
      itemId: 61,
      contextItemId: 62,
      title: "First Selected Paper",
    };
    const activePaper = {
      itemId: 71,
      contextItemId: 72,
      title: "Active Selected Paper",
    };
    const prepared: string[] = [];
    const tool = createPaperReadTool(
      {
        ensurePaperContext: async (paperContext: typeof firstPaper) => {
          prepared.push(paperContext.title);
          const text = `Complete text for ${paperContext.title}`;
          return {
            title: paperContext.title,
            chunks: [text],
            chunkMeta: [
              {
                chunkIndex: 0,
                text,
                normalizedText: text,
                chunkKind: "body",
              },
            ],
            chunkStats: [],
            docFreq: {},
            avgChunkLength: 0,
            fullLength: text.length,
          };
        },
      } as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [firstPaper, activePaper],
      } as never,
      undefined,
      async (batch) => ({
        digest: `Read ${batch.paperTitle}`,
        relevantChunkIds: [0],
      }),
    );
    const validated = tool.validate({ mode: "full" });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        conversationKind: "paper",
        activeItemId: activePaper.itemId,
        selectedPaperContexts: [firstPaper, activePaper],
        userText: "Read the complete paper before answering.",
      },
    });
    assert.deepEqual(prepared, [activePaper.title]);

    prepared.length = 0;
    const allSelectedOutput = (await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        conversationKind: "paper",
        activeItemId: activePaper.itemId,
        selectedPaperContexts: [firstPaper, activePaper],
        userText: "Read the full text of all selected papers.",
      },
    })) as { coverageReceipt: { paperCount: number } };
    assert.deepEqual(prepared, [firstPaper.title, activePaper.title]);
    assert.equal(allSelectedOutput.coverageReceipt.paperCount, 2);
  });

  it("paper_read targeted honors explicit pages even when a query is present", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "Page Scoped Paper",
      firstCreator: "Huys",
      year: "2016",
    };
    let retrievalCalls = 0;
    let requestedPages: number[] = [];
    const tool = createPaperReadTool(
      {
        ensurePaperContext: async () => {
          throw new Error(
            "semantic retrieval should not prepare paper context",
          );
        },
      } as never,
      {
        retrieveEvidence: async () => {
          retrievalCalls += 1;
          return [];
        },
      } as never,
      {
        readPageTexts: async ({ pages }: { pages: number[] }) => {
          requestedPages = pages;
          return {
            target: {
              source: "library",
              title: "Page Scoped Paper",
              mimeType: "application/pdf",
              storedPath: "/tmp/page-scoped.pdf",
              paperContext,
              contextItemId: 22,
              itemId: 11,
            },
            pages: [
              {
                pageIndex: 1,
                pageLabel: "2",
                text: "Only page two text should be returned.",
              },
            ],
          };
        },
      } as never,
      {
        listPaperContexts: () => [paperContext],
        resolvePaperContextTarget: () => paperContext,
      } as never,
    );
    const validated = tool.validate({
      mode: "targeted",
      query: "hippocampal evidence",
      pages: [2],
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, baseContext)) as {
      results?: Array<Record<string, unknown>>;
      quoteCitations?: Array<{
        quoteText: string;
        citationLabel: string;
        pageHintIndex?: number;
        pageHintLabel?: string;
      }>;
      papers?: Array<{
        passages?: Array<{ pageLabel?: string; text?: string }>;
      }>;
    };
    assert.equal(retrievalCalls, 0);
    assert.deepEqual(requestedPages, [1]);
    assert.lengthOf(output.results || [], 1);
    assert.equal(output.results?.[0]?.pageLabel, "2");
    assert.equal(
      output.papers?.[0]?.passages?.[0]?.text,
      "Only page two text should be returned.",
    );
    assert.equal(output.papers?.[0]?.passages?.[0]?.pageLabel, "2");
    assert.lengthOf(output.quoteCitations || [], 1);
    assert.equal(
      output.quoteCitations?.[0]?.quoteText,
      "Only page two text should be returned.",
    );
    assert.equal(output.quoteCitations?.[0]?.citationLabel, "(Huys, 2016)");
    assert.equal(output.quoteCitations?.[0]?.pageHintIndex, 1);
    assert.equal(output.quoteCitations?.[0]?.pageHintLabel, "2");
  });

  it("paper_read targeted groups explicit page reads across multiple targets", async function () {
    const firstPaper = {
      itemId: 11,
      contextItemId: 22,
      title: "First Page Paper",
      firstCreator: "Huys",
      year: "2016",
    };
    const secondPaper = {
      itemId: 33,
      contextItemId: 44,
      title: "Second Page Paper",
      firstCreator: "Montague",
      year: "2012",
    };
    const pageReadItemIds: number[] = [];
    const tool = createPaperReadTool(
      {} as never,
      {
        retrieveEvidence: async () => {
          throw new Error(
            "semantic retrieval should not run for explicit pages",
          );
        },
      } as never,
      {
        readPageTexts: async ({
          paperContext,
        }: {
          paperContext: typeof firstPaper;
          pages: number[];
        }) => {
          pageReadItemIds.push(paperContext.itemId);
          return {
            target: {
              source: "library",
              title: paperContext.title,
              mimeType: "application/pdf",
              storedPath: `/tmp/${paperContext.itemId}.pdf`,
              paperContext,
              contextItemId: paperContext.contextItemId,
              itemId: paperContext.itemId,
            },
            pages: [
              {
                pageIndex: 2,
                pageLabel: "3",
                text:
                  paperContext.itemId === firstPaper.itemId
                    ? "First page-scoped passage."
                    : "Second page-scoped passage.",
              },
            ],
          };
        },
      } as never,
      {
        listPaperContexts: () => [firstPaper, secondPaper],
        resolvePaperContextTarget: ({ itemId }: { itemId?: number }) =>
          itemId === firstPaper.itemId ? firstPaper : secondPaper,
      } as never,
    );
    const validated = tool.validate({
      mode: "targeted",
      pages: [3],
      targets: [
        { itemId: 11, contextItemId: 22 },
        { itemId: 33, contextItemId: 44 },
      ],
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, baseContext)) as {
      results?: unknown[];
      papers?: Array<{
        sourceLabel?: string;
        passages?: Array<{ text?: string; pageLabel?: string }>;
      }>;
    };
    assert.deepEqual(pageReadItemIds, [11, 33]);
    assert.lengthOf(output.results || [], 2);
    assert.lengthOf(output.papers || [], 2);
    assert.equal(output.papers?.[0]?.sourceLabel, "(Huys, 2016)");
    assert.equal(
      output.papers?.[0]?.passages?.[0]?.text,
      "First page-scoped passage.",
    );
    assert.equal(
      output.papers?.[1]?.passages?.[0]?.text,
      "Second page-scoped passage.",
    );
    assert.equal(output.papers?.[1]?.passages?.[0]?.pageLabel, "3");
  });

  it("paper_read targeted dedupes duplicate default paper contexts", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "Memory Palace Paper",
      firstCreator: "Chandra et al.",
      year: "2025",
    };
    let retrievedPapers: unknown[] = [];
    const tool = createPaperReadTool(
      {
        ensurePaperContext: async () => ({ chunks: ["memory"] }),
      } as never,
      {
        retrieveEvidence: async ({
          papers,
        }: {
          papers: (typeof paperContext)[];
        }) => {
          retrievedPapers = papers;
          return [
            {
              paperContext,
              chunkIndex: 1,
              sectionLabel: "Results",
              text: "First memory palace passage.",
              score: 4.5,
              citationLabel: "Chandra et al., 2025",
              sourceLabel: "(Chandra et al., 2025)",
            },
            {
              paperContext,
              chunkIndex: 2,
              sectionLabel: "Discussion",
              text: "Second memory palace passage.",
              score: 3.5,
              citationLabel: "Chandra et al., 2025",
              sourceLabel: "(Chandra et al., 2025)",
            },
          ];
        },
      } as never,
      {} as never,
      {
        listPaperContexts: () => [paperContext, { ...paperContext }],
        resolvePaperContextTarget: () => paperContext,
      } as never,
    );
    const validated = tool.validate({
      mode: "targeted",
      query: "memory palace",
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, baseContext)) as {
      results?: unknown[];
      papers?: unknown[];
    };
    assert.lengthOf(retrievedPapers, 1);
    assert.lengthOf(output.results || [], 2);
    assert.lengthOf(output.papers || [], 1);
    const onSuccess = tool.presentation?.summaries?.onSuccess;
    assert.isFunction(onSuccess);
    if (typeof onSuccess !== "function") return;
    assert.equal(
      onSuccess({ label: "Read Paper", content: output }),
      "Read 2 passages from (Chandra et al., 2025)",
    );
  });

  it("paper_read targeted dedupes duplicate explicit targets", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "Memory Palace Paper",
      firstCreator: "Chandra et al.",
      year: "2025",
    };
    let retrievedPapers: unknown[] = [];
    const tool = createPaperReadTool(
      {
        ensurePaperContext: async () => ({ chunks: ["memory"] }),
      } as never,
      {
        retrieveEvidence: async ({
          papers,
        }: {
          papers: (typeof paperContext)[];
        }) => {
          retrievedPapers = papers;
          return [
            {
              paperContext,
              chunkIndex: 1,
              sectionLabel: "Results",
              text: "Memory palace passage.",
              score: 4.5,
              citationLabel: "Chandra et al., 2025",
              sourceLabel: "(Chandra et al., 2025)",
            },
          ];
        },
      } as never,
      {} as never,
      {
        listPaperContexts: () => [],
        resolvePaperContextTarget: () => paperContext,
      } as never,
    );
    const validated = tool.validate({
      mode: "targeted",
      query: "memory palace",
      targets: [
        { itemId: 11, contextItemId: 22 },
        { itemId: 11, contextItemId: 22 },
      ],
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, baseContext)) as {
      results?: unknown[];
      papers?: unknown[];
    };
    assert.lengthOf(retrievedPapers, 1);
    assert.lengthOf(output.results || [], 1);
    assert.lengthOf(output.papers || [], 1);
  });

  it("paper_read targeted success text counts passages separately from papers", function () {
    const tool = createPaperReadTool({} as never, {} as never, {} as never);
    const onSuccess = tool.presentation?.summaries?.onSuccess;
    assert.isFunction(onSuccess);
    if (typeof onSuccess !== "function") return;
    assert.equal(
      onSuccess({
        label: "Read Paper",
        content: {
          mode: "targeted",
          results: Array.from({ length: 8 }, (_, index) => ({
            chunkIndex: index,
          })),
          papers: [{ sourceLabel: "(Chandra et al., 2025)", passages: [] }],
        },
      }),
      "Read 8 passages from (Chandra et al., 2025)",
    );
    assert.equal(
      onSuccess({
        label: "Read Paper",
        content: {
          mode: "targeted",
          results: Array.from({ length: 4 }, (_, index) => ({
            chunkIndex: index,
          })),
          papers: [
            { sourceLabel: "(Chandra et al., 2025)", passages: [] },
            { sourceLabel: "(Miller, 2024)", passages: [] },
          ],
        },
      }),
      "Read 4 passages from 2 sources",
    );
    assert.equal(
      onSuccess({
        label: "Read Paper",
        content: {
          mode: "targeted",
          papers: [
            {
              sourceLabel: "(Chandra et al., 2025)",
              passages: [{ text: "one" }, { text: "two" }],
            },
          ],
        },
      }),
      "Read 2 passages from (Chandra et al., 2025)",
    );
  });

  it("matches simple-paper-qa for understand-this-paper typo requests", function () {
    setUserSkills([parseSkill(BUILTIN_SKILL_FILES["simple-paper-qa.md"])]);
    assert.include(
      getMatchedSkillIds({
        userText: "can you help me understand this ppaer",
        selectedPaperContexts: [
          { itemId: 1, contextItemId: 2, title: "Paper" },
        ],
      }),
      "simple-paper-qa",
    );
  });

  it("compare-papers guidance prefers one targeted batched read for method comparisons", function () {
    const raw = BUILTIN_SKILL_FILES["compare-papers.md"];
    assert.include(raw, "contexts: paper-set,library-corpus");
    assert.include(raw, "targeted first when the dimension is known");
    assert.include(
      raw,
      "A selected Zotero collection/folder is also a valid comparison corpus",
    );
    assert.include(
      raw,
      "library_retrieve({ query:'methods methodology method section'",
    );
    assert.include(
      raw,
      "paper_read({ mode:'targeted', query:'methods methodology method section', targets:[...] })",
    );
    assert.include(
      raw,
      "For method-section requests, do not call overview first",
    );
    assert.include(raw, "include short direct-source blockquotes");
    assert.include(
      raw,
      "Do not call visual/page tools, `file_io`, or `run_command`",
    );
  });

  it("matches compare-papers for collection-scoped comparison requests", function () {
    setUserSkills([parseSkill(BUILTIN_SKILL_FILES["compare-papers.md"])]);

    assert.include(
      getMatchedSkillIds({
        userText: "compare the methods of all papers in this folder",
        selectedCollectionContexts: [
          { collectionId: 4, name: "Computational_Psychiatry", libraryID: 1 },
        ],
      }),
      "compare-papers",
    );
  });

  it("allows compare-papers slash selection for selected collections", function () {
    const skill = parseSkill(BUILTIN_SKILL_FILES["compare-papers.md"]);

    assert.deepEqual(
      getSkillContextEligibility(skill, {
        userText: "",
        selectedCollectionContexts: [
          { collectionId: 4, name: "Computational_Psychiatry", libraryID: 1 },
        ],
      }),
      { eligible: true },
    );
  });

  it("matches evidence-based-qa for collection-scoped evidence requests", function () {
    setUserSkills([parseSkill(BUILTIN_SKILL_FILES["evidence-based-qa.md"])]);

    assert.include(
      getMatchedSkillIds({
        userText: "find evidence in these papers for this claim",
        selectedCollectionContexts: [
          { collectionId: 4, name: "Computational_Psychiatry", libraryID: 1 },
        ],
      }),
      "evidence-based-qa",
    );
  });

  it("allows evidence-based-qa slash selection for selected collections", function () {
    const skill = parseSkill(BUILTIN_SKILL_FILES["evidence-based-qa.md"]);

    assert.deepEqual(
      getSkillContextEligibility(skill, {
        userText: "",
        selectedCollectionContexts: [
          { collectionId: 4, name: "Computational_Psychiatry", libraryID: 1 },
        ],
      }),
      { eligible: true },
    );
  });

  it("keeps multi-context skills selectable without attached context", function () {
    const evidenceSkill = parseSkill(
      BUILTIN_SKILL_FILES["evidence-based-qa.md"],
    );
    const compareSkill = parseSkill(BUILTIN_SKILL_FILES["compare-papers.md"]);

    assert.deepEqual(
      getSkillContextEligibility(evidenceSkill, { userText: "" }),
      { eligible: true },
    );
    assert.deepEqual(
      getSkillContextEligibility(compareSkill, { userText: "" }),
      { eligible: true },
    );
  });
});
