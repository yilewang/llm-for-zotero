import { assert } from "chai";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import {
  createWebSearchTool,
  validateWebSearchInput,
} from "../src/agent/tools/read/webSearch";
import {
  createWebReadTool,
  validateWebReadInput,
} from "../src/agent/tools/read/webRead";
import { clearWebSourcesForRun } from "../src/webAccess/runSources";
import {
  getTavilyApiKey,
  hasTavilyApiKey,
  setTavilyApiKey,
} from "../src/webAccess/prefs";
import type { WebAccessProvider } from "../src/webAccess/types";
import type { AgentToolContext } from "../src/agent/types";

describe("web access agent tools", function () {
  const originalZotero = globalThis.Zotero;

  afterEach(function () {
    clearWebSourcesForRun("run-web-tools");
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  function context(
    authMode: AgentToolContext["request"]["authMode"] = "api_key",
  ) {
    return {
      request: {
        conversationKey: 1,
        mode: "agent" as const,
        userText: "Find current information",
        authMode,
      },
      runId: "run-web-tools",
      item: null,
      currentAnswerText: "",
      modelName: "test-model",
    } satisfies AgentToolContext;
  }

  function provider(): WebAccessProvider {
    return {
      search: async (request) => ({
        provider: "tavily",
        query: request.query,
        depth: request.depth,
        topic: request.topic,
        results: [
          {
            sourceId: "provider-id",
            url: "https://example.com/report",
            hostname: "example.com",
            organization: "Example",
            title: "Report",
            faviconUrl: "https://example.com/favicon.ico",
            snippet: "Search passage",
          },
        ],
        usage: { credits: request.depth === "advanced" ? 2 : 1 },
      }),
      read: async (request) => ({
        provider: "tavily",
        query: request.query,
        depth: request.depth,
        pages: [
          {
            sourceId: "provider-read-id",
            url: request.urls[0],
            hostname: "example.com",
            organization: "Example",
            title: "Report",
            faviconUrl: "https://example.com/favicon.ico",
            content: "Focused passage",
          },
        ],
        failedResults: [],
        usage: { credits: 1 },
      }),
      getUsage: async () => ({
        provider: "tavily",
        plan: "Free",
        credential: { usage: 0, limit: 1000 },
        monthly: { usage: 0, limit: 1000 },
        breakdown: { searchCredits: 0, readCredits: 0 },
        payAsYouGo: { usage: 0, limit: 0 },
      }),
    };
  }

  it("requires explicit depth and documents selection at the tool boundary", function () {
    const search = createWebSearchTool(() => provider());
    const read = createWebReadTool(() => provider());
    const searchSchema = search.spec.inputSchema as {
      required?: string[];
      properties?: { depth?: { description?: string } };
    };
    const readSchema = read.spec.inputSchema as {
      required?: string[];
      properties?: { depth?: { description?: string } };
    };

    assert.includeMembers(searchSchema.required || [], ["query", "depth"]);
    assert.includeMembers(readSchema.required || [], [
      "urls",
      "query",
      "depth",
    ]);
    assert.include(
      searchSchema.properties?.depth?.description || "",
      "Follow an explicit user depth request",
    );
    assert.include(
      searchSchema.properties?.depth?.description || "",
      "use basic for a focused lookup",
    );
    assert.include(
      searchSchema.properties?.depth?.description || "",
      "use advanced for exploratory or ambiguous discovery",
    );
    assert.include(
      readSchema.properties?.depth?.description || "",
      "use basic for a few direct facts or passages",
    );
    assert.include(
      readSchema.properties?.depth?.description || "",
      "use advanced for long or technical pages",
    );
    assert.include(
      search.guidance?.instruction || "",
      "explicitly choose basic or advanced from the current retrieval need",
    );
    assert.notInclude(search.guidance?.instruction || "", "focused lookup");
  });

  it("validates search depth, filters, limits, and dates", function () {
    const valid = validateWebSearchInput({
      query: "  current topic  ",
      depth: "advanced",
      topic: "finance",
      maxResults: 10,
      startDate: "2026-01-01",
      endDate: "2026-08-01",
      includeDomains: ["example.com", "example.com"],
    });
    assert.isTrue(valid.ok);
    if (valid.ok) {
      assert.equal(valid.value.query, "current topic");
      assert.equal(valid.value.depth, "advanced");
      assert.deepEqual(valid.value.includeDomains, ["example.com"]);
    }
    const missingDepth = validateWebSearchInput({ query: "x" });
    assert.isFalse(missingDepth.ok);
    if (!missingDepth.ok) {
      assert.include(missingDepth.error, "depth must be one of");
    }
    assert.isFalse(validateWebSearchInput({ query: "x", depth: "deep" }).ok);
    assert.isFalse(
      validateWebSearchInput({
        query: "x",
        depth: "basic",
        topic: "social",
      }).ok,
    );
    assert.isFalse(
      validateWebSearchInput({
        query: "x",
        depth: "basic",
        includeDomains: ["127.0.0.1"],
      }).ok,
    );
    assert.isFalse(
      validateWebSearchInput({
        query: "x",
        depth: "basic",
        maxResults: 11,
      }).ok,
    );
    assert.isFalse(
      validateWebSearchInput({
        query: "x",
        depth: "basic",
        timeRange: "week",
        startDate: "2026-01-01",
      }).ok,
    );
    assert.isFalse(
      validateWebSearchInput({
        query: "x",
        depth: "basic",
        startDate: "2026-09-01",
        endDate: "2026-01-01",
      }).ok,
    );
  });

  it("validates read limits and public URLs", function () {
    assert.isTrue(
      validateWebReadInput({
        urls: ["https://example.com/a"],
        query: "specific detail",
        depth: "basic",
      }).ok,
    );
    const missingDepth = validateWebReadInput({
      urls: ["https://example.com/a"],
      query: "specific detail",
    });
    assert.isFalse(missingDepth.ok);
    if (!missingDepth.ok) {
      assert.include(missingDepth.error, "depth must be one of");
    }
    assert.isFalse(
      validateWebReadInput({
        urls: ["http://127.0.0.1/private"],
        query: "specific detail",
        depth: "basic",
      }).ok,
    );
    assert.isFalse(
      validateWebReadInput({
        urls: ["https://example.com/a"],
        query: "specific detail",
        depth: "deep",
      }).ok,
    );
    assert.isFalse(
      validateWebReadInput({
        urls: Array.from(
          { length: 6 },
          (_, index) => `https://example.com/${index}`,
        ),
        query: "specific detail",
        depth: "basic",
      }).ok,
    );
  });

  it("keeps source IDs stable within a run and restricts reads to search results", async function () {
    const fakeProvider = provider();
    const search = createWebSearchTool(() => fakeProvider);
    const read = createWebReadTool(() => fakeProvider);
    const searchResult = await search.execute(
      {
        query: "current topic",
        depth: "basic",
        topic: "general",
        maxResults: 5,
      },
      context(),
    );
    const sourceId = searchResult.results[0].sourceId;
    assert.match(sourceId, /^web_[a-z0-9]+$/);
    assert.deepEqual(searchResult.citation.availableSourceIds, [sourceId]);

    const readResult = await read.execute(
      {
        urls: ["https://example.com/report"],
        query: "specific detail",
        depth: "basic",
        chunksPerSource: 3,
      },
      context(),
    );
    assert.equal(readResult.pages[0].sourceId, sourceId);

    try {
      await read.execute(
        {
          urls: ["https://other.example/report"],
          query: "specific detail",
          depth: "basic",
          chunksPerSource: 3,
        },
        context(),
      );
      assert.fail("Expected an unsearched URL to be rejected");
    } catch (error) {
      assert.include(
        error instanceof Error ? error.message : String(error),
        "returned by web_search",
      );
    }
  });

  it("advertises tools only with a key and only to intended local runtimes", function () {
    let storedKey = "";
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: () => storedKey,
        set: (_name: string, value: unknown) => {
          storedKey = String(value || "");
        },
      },
    } as typeof Zotero;

    const registry = new AgentToolRegistry();
    registry.register(createWebSearchTool(() => provider()));
    registry.register(createWebReadTool(() => provider()));
    assert.deepEqual(registry.listTools(), []);
    assert.deepEqual(registry.listToolsForRequest(context().request), []);

    storedKey = "tvly-configured";
    assert.deepEqual(
      registry
        .listToolsForRequest(context("api_key").request)
        .map((tool) => tool.name),
      ["web_search", "web_read"],
    );
    assert.deepEqual(
      registry
        .listToolsForRequest(context("codex_auth").request)
        .map((tool) => tool.name),
      ["web_search", "web_read"],
    );
    assert.deepEqual(
      registry.listToolsForRequest(context("codex_app_server").request),
      [],
    );
    assert.deepEqual(
      registry.listToolsForRequest(context("webchat").request),
      [],
    );
  });

  it("persists a trimmed local key and treats an empty value as disabled", function () {
    let storedKey = "";
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: () => storedKey,
        set: (_name: string, value: unknown) => {
          storedKey = String(value || "");
        },
      },
    } as typeof Zotero;

    setTavilyApiKey("  tvly-local-key  ");
    assert.equal(getTavilyApiKey(), "tvly-local-key");
    assert.isTrue(hasTavilyApiKey());
    setTavilyApiKey("   ");
    assert.equal(getTavilyApiKey(), "");
    assert.isFalse(hasTavilyApiKey());
  });

  it("builds collapsed summaries and expandable details", async function () {
    const search = createWebSearchTool(() => provider());
    const args = {
      query: "current topic",
      depth: "advanced" as const,
      topic: "news" as const,
      maxResults: 5,
    };
    const result = await search.execute(args, context());
    assert.equal(search.presentation?.traceIcon, "web");
    assert.isTrue(search.presentation?.mergeResultIntoCallTrace);
    assert.equal(
      search.presentation?.buildTraceSummary?.({ args, content: result }),
      "Searched web · Depth: advanced",
    );
    const details =
      search.presentation?.buildTraceDetails?.({ args, content: result }) || [];
    assert.deepEqual(details, [
      { label: "Query", value: "current topic" },
      {
        label: "URL",
        value: "https://example.com/report",
        kind: "url",
        timeline: {
          icon: "website",
          href: "https://example.com/report",
          faviconUrl: "https://example.com/favicon.ico",
        },
      },
    ]);
    assert.equal(
      search.presentation?.buildTraceSummary?.({
        args: { ...args, depth: "basic" },
        content: result,
      }),
      "Searched web · Depth: basic",
    );
    assert.notDeepInclude(details, {
      label: "Snippet",
      value: "Search passage",
    });
    assert.notDeepInclude(details, {
      label: "Credits used",
      value: "2",
    });
  });

  it("builds the same connected query, depth, and URL list for web reads", async function () {
    const fakeProvider = provider();
    const search = createWebSearchTool(() => fakeProvider);
    const read = createWebReadTool(() => fakeProvider);
    await search.execute(
      {
        query: "current topic",
        depth: "basic",
        topic: "general",
        maxResults: 5,
      },
      context(),
    );
    const args = {
      urls: ["https://example.com/report"],
      query: "specific detail",
      depth: "basic" as const,
      chunksPerSource: 3,
    };
    const result = await read.execute(args, context());
    assert.equal(read.presentation?.traceIcon, "web");
    assert.equal(
      read.presentation?.buildTraceSummary?.({ args, content: result }),
      "Read web pages · Depth: basic",
    );
    const advancedArgs = { ...args, depth: "advanced" as const };
    const advancedResult = await read.execute(advancedArgs, context());
    assert.equal(advancedResult.depth, "advanced");
    assert.equal(
      read.presentation?.buildTraceSummary?.({
        args: advancedArgs,
        content: advancedResult,
      }),
      "Read web pages · Depth: advanced",
    );
    assert.deepEqual(
      read.presentation?.buildTraceDetails?.({ args, content: result }),
      [
        { label: "Query", value: "specific detail" },
        {
          label: "URL",
          value: "https://example.com/report",
          kind: "url",
          timeline: {
            icon: "website",
            href: "https://example.com/report",
            faviconUrl: "https://example.com/favicon.ico",
          },
        },
      ],
    );
  });
});
