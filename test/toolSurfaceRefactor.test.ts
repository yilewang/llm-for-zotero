import { assert } from "chai";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import {
  BUILTIN_SKILL_FILES,
  getMatchedSkillIds,
  parseSkill,
  setUserSkills,
} from "../src/agent/skills";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import { createWebSearchTool } from "../src/agent/tools/read/webSearch";
import type { AgentToolContext } from "../src/agent/types";

describe("semantic tool surface", function () {
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
      registry.listToolsForRequest(baseContext.request).map((tool) => tool.name),
      ["library_search"],
    );
    assert.exists(registry.getTool("query_library"));
  });

  it("exposes the semantic built-in surface and hides legacy primitive names", function () {
    const registry = createBuiltInToolRegistry({
      zoteroGateway: {} as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
    const tools = registry.listTools();
    const names = tools.map((tool) => tool.name).sort();

    assert.deepEqual(names, [
      "attachment_update",
      "collection_update",
      "file_io",
      "library_delete",
      "library_import",
      "library_read",
      "library_search",
      "library_update",
      "literature_search",
      "note_write",
      "paper_read",
      "run_command",
      "undo_last_action",
      "web_search",
      "zotero_script",
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
      assert.exists(registry.getTool(legacyName), `${legacyName} remains internally callable`);
    }
    for (const name of ["file_io", "run_command", "zotero_script"]) {
      assert.equal(
        tools.find((tool) => tool.name === name)?.tier,
        "advanced",
        `${name} should be advanced`,
      );
    }
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
          throw new Error("No PDF attachment is available for this Zotero item");
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
      targets: [{ itemId: 11, contextItemId: 22 }, { itemId: 33, contextItemId: 44 }],
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, baseContext)) as {
      results?: unknown[];
      papers?: Array<{
        status?: string;
        sourceLabel?: string;
        passages?: Array<{ text?: string; sectionLabel?: string }>;
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
    assert.equal(output.papers?.[1]?.passages?.[0]?.text, "Second method passage.");
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
          results: Array.from({ length: 8 }, (_, index) => ({ chunkIndex: index })),
          papers: [{ sourceLabel: "(Chandra et al., 2025)", passages: [] }],
        },
      }),
      "Read 8 passages from 1 paper",
    );
  });

  it("matches simple-paper-qa for understand-this-paper typo requests", function () {
    setUserSkills([parseSkill(BUILTIN_SKILL_FILES["simple-paper-qa.md"])]);
    assert.include(
      getMatchedSkillIds({
        userText: "can you help me understand this ppaer",
      }),
      "simple-paper-qa",
    );
  });

  it("compare-papers guidance prefers one targeted batched read for method comparisons", function () {
    const raw = BUILTIN_SKILL_FILES["compare-papers.md"];
    assert.include(raw, "targeted first when the dimension is known");
    assert.include(
      raw,
      "paper_read({ mode:'targeted', query:'methods methodology method section', targets:[...] })",
    );
    assert.include(raw, "For method-section requests, do not call overview first");
    assert.include(raw, "include short blockquotes");
    assert.include(raw, "Do not call visual/page tools, `file_io`, or `run_command`");
  });

  it("web_search returns cited URL results without fetching result pages", async function () {
    const globalScope = globalThis as typeof globalThis & {
      Zotero?: { HTTP?: { request?: unknown } };
    };
    const originalZotero = globalScope.Zotero;
    let requestedUrl = "";
    globalScope.Zotero = {
      HTTP: {
        request: async (_method: string, url: string) => {
          requestedUrl = url;
          return {
            responseText: `
              <html><body>
                <div class="result">
                  <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example Docs</a>
                  <a class="result__snippet">Current documentation snippet.</a>
                </div>
              </body></html>
            `,
          };
        },
      },
    };
    try {
      const tool = createWebSearchTool();
      const validated = tool.validate({
        query: "example docs",
        mode: "docs",
        limit: 3,
      });
      assert.equal(validated.ok, true);
      if (!validated.ok) return;
      const output = await tool.execute(validated.value, baseContext);
      const content = output as {
        query?: string;
        mode?: string;
        results?: Array<{ title?: string; url?: string; source?: string }>;
      };
      assert.include(requestedUrl, "html.duckduckgo.com");
      assert.equal(content.query, "example docs");
      assert.equal(content.mode, "docs");
      assert.deepEqual(content.results, [
        {
          title: "Example Docs",
          url: "https://example.com/docs",
          snippet: "Current documentation snippet.",
          source: "example.com",
        },
      ]);
    } finally {
      globalScope.Zotero = originalZotero;
    }
  });
});
