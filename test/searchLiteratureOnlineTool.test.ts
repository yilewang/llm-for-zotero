import { assert } from "chai";
import { createSearchLiteratureOnlineTool } from "../src/agent/tools/read/searchLiteratureOnline";
import type { AgentToolContext } from "../src/agent/types";

describe("search_literature_online tool", function () {
  const baseContext: AgentToolContext = {
    request: {
      conversationKey: 11,
      mode: "agent",
      userText: "Find related papers",
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.4",
  };

  const originalFetch = (
    globalThis as typeof globalThis & { fetch?: typeof fetch }
  ).fetch;

  afterEach(function () {
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      originalFetch;
  });

  it("supports metadata lookups through the unified online tool", async function () {
    const crossRefItem = {
      DOI: "10.1000/example",
      title: ["Example Title"],
      author: [{ given: "Alice", family: "Example" }],
      "container-title": ["Journal"],
      URL: "https://doi.org/10.1000/example",
    };
    const s2Item = {
      title: "Example Title",
      authors: [{ name: "Alice Example" }],
      year: 2024,
      abstract: "Abstract",
      venue: "Journal",
      citationCount: 12,
      externalIds: { DOI: "10.1000/example" },
    };
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      (async (url: string | URL | Request) => {
        const href = String(url);
        // Title search (used by resolveIdentifier)
        if (href.includes("api.crossref.org/works?query.bibliographic")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ message: { items: [crossRefItem] } }),
          } as Response;
        }
        // DOI lookup (used by supplement phase)
        if (href.includes("api.crossref.org/works/10.1000")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ message: crossRefItem }),
          } as Response;
        }
        // Semantic Scholar DOI or title search
        if (href.includes("api.semanticscholar.org")) {
          return {
            ok: true,
            status: 200,
            json: async () =>
              href.includes("/search") ? { data: [s2Item] } : s2Item,
          } as Response;
        }
        throw new Error(`Unexpected URL: ${href}`);
      }) as typeof fetch;

    const tool = createSearchLiteratureOnlineTool({
      resolveMetadataItem: () => null,
      getEditableArticleMetadata: () => null,
      fetchMetadataByIdentifier: async () => null,
    } as never);
    const validated = tool.validate({
      mode: "metadata",
      title: "Example Title",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, baseContext);
    assert.equal((result as { mode: string }).mode, "metadata");
    assert.lengthOf((result as { results: unknown[] }).results, 2);
  });

  it("resolves metadata lookups from the current Zotero item when only item context is provided", async function () {
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      (async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("api.crossref.org/works/10.1000%2Fexample")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              message: {
                DOI: "10.1000/example",
                title: ["Example Title"],
                author: [{ given: "Alice", family: "Example" }],
                "container-title": ["Journal"],
                URL: "https://doi.org/10.1000/example",
              },
            }),
          } as Response;
        }
        if (
          href.includes(
            "api.semanticscholar.org/graph/v1/paper/DOI:10.1000%2Fexample",
          )
        ) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              title: "Example Title",
              authors: [{ name: "Alice Example" }],
              year: 2024,
              abstract: "Abstract",
              venue: "Journal",
              citationCount: 12,
              externalIds: { DOI: "10.1000/example" },
            }),
          } as Response;
        }
        throw new Error(`Unexpected URL: ${href}`);
      }) as typeof fetch;

    const item = { id: 7 } as any;
    const tool = createSearchLiteratureOnlineTool({
      resolveMetadataItem: () => item,
      getEditableArticleMetadata: () =>
        ({
          title: "Existing Title",
          fields: { DOI: "10.1000/example" },
        }) as any,
      fetchMetadataByIdentifier: async () => null,
    } as never);
    const validated = tool.validate({
      mode: "metadata",
      itemId: 7,
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, baseContext);
    assert.equal((result as { mode: string }).mode, "metadata");
    assert.lengthOf((result as { results: unknown[] }).results, 2);
  });

  it("supports live search mode through the unified online tool", async function () {
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      (async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("api.openalex.org/works?search=")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              results: [
                {
                  id: "https://openalex.org/W123",
                  display_name: "Related Paper",
                  authorships: [{ author: { display_name: "Bob Example" } }],
                  publication_year: 2025,
                  cited_by_count: 4,
                  doi: "https://doi.org/10.1000/related",
                  open_access: { oa_url: "https://example.com/paper.pdf" },
                },
              ],
            }),
          } as Response;
        }
        throw new Error(`Unexpected URL: ${href}`);
      }) as typeof fetch;

    const tool = createSearchLiteratureOnlineTool({
      resolveMetadataItem: () => null,
      getEditableArticleMetadata: () => null,
    } as never);
    const validated = tool.validate({
      mode: "search",
      source: "openalex",
      query: "neural networks",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, baseContext);
    const results = (result as { results: Array<Record<string, unknown>> })
      .results;
    assert.lengthOf(results, 1);
    assert.equal(results[0].title, "Related Paper");
    assert.equal(results[0].doi, "10.1000/related");
  });

  it("adds guidance for live paper discovery requests", function () {
    const tool = createSearchLiteratureOnlineTool({
      resolveMetadataItem: () => null,
      getEditableArticleMetadata: () => null,
    } as never);
    assert.isTrue(
      tool.guidance?.matches({
        conversationKey: 11,
        mode: "agent",
        userText: "can you find related papers from internet to me",
      }) || false,
    );
    assert.include(
      tool.guidance?.instruction || "",
      "let the review card present the result",
    );
  });
});
