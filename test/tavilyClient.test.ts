import { assert } from "chai";
import {
  TavilyApiError,
  TavilyClient,
  normalizePublicWebUrl,
  type TavilyTransport,
} from "../src/webAccess/tavilyClient";

describe("Tavily web access client", function () {
  it("sends a bounded search request and normalizes sources and usage", async function () {
    const calls: Parameters<TavilyTransport>[0][] = [];
    const transport: TavilyTransport = async (request) => {
      calls.push(request);
      return {
        status: 200,
        body: {
          query: "current topic",
          request_id: "req-1",
          results: [
            {
              url: "https://www.example.com/report#section",
              site_name: "Example Organization",
              title: "Current report",
              content: "Relevant result passage",
              favicon: "https://www.example.com/favicon.ico#cached",
              score: 0.91,
            },
          ],
          usage: { credits: 2 },
        },
      };
    };
    const result = await new TavilyClient("tvly-secret", transport).search({
      query: "current topic",
      depth: "advanced",
      topic: "news",
      maxResults: 7,
      timeRange: "week",
      includeDomains: ["example.com"],
      excludeDomains: ["ads.example"],
    });

    assert.lengthOf(calls, 1);
    assert.equal(calls[0].url, "https://api.tavily.com/search");
    assert.equal(calls[0].headers.Authorization, "Bearer tvly-secret");
    assert.deepInclude(JSON.parse(calls[0].body || "{}"), {
      query: "current topic",
      search_depth: "advanced",
      topic: "news",
      max_results: 7,
      time_range: "week",
      auto_parameters: false,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_favicon: true,
      include_usage: true,
    });
    assert.deepEqual(result.usage, { credits: 2 });
    assert.equal(result.results[0].url, "https://www.example.com/report");
    assert.equal(result.results[0].hostname, "example.com");
    assert.equal(result.results[0].organization, "Example Organization");
    assert.equal(result.results[0].title, "Current report");
    assert.equal(
      result.results[0].faviconUrl,
      "https://www.example.com/favicon.ico",
    );
    assert.equal(result.results[0].snippet, "Relevant result passage");
  });

  it("extracts focused passages and keeps partial failures", async function () {
    let requestBody: Record<string, unknown> = {};
    const client = new TavilyClient("secret", async (request) => {
      requestBody = JSON.parse(request.body || "{}");
      return {
        status: 200,
        body: {
          results: [
            {
              url: "https://example.org/a",
              title: "Page A",
              raw_content: "Task-relevant extracted passage",
              favicon: "https://example.org/favicon.ico",
            },
          ],
          failed_results: [
            { url: "https://example.org/b", error: "Extraction unavailable" },
          ],
          usage: { credits: 1 },
        },
      };
    });
    const result = await client.read({
      urls: ["https://example.org/a", "https://example.org/b"],
      query: "specific question",
      depth: "basic",
      chunksPerSource: 3,
    });

    assert.deepInclude(requestBody, {
      query: "specific question",
      extract_depth: "basic",
      chunks_per_source: 3,
      include_images: false,
      include_favicon: true,
      include_usage: true,
      format: "text",
    });
    assert.lengthOf(result.pages, 1);
    assert.equal(result.pages[0].faviconUrl, "https://example.org/favicon.ico");
    assert.equal(result.pages[0].content, "Task-relevant extracted passage");
    assert.deepEqual(result.failedResults, [
      {
        url: "https://example.org/b",
        error: "Extraction unavailable",
      },
    ]);
  });

  it("keeps a result while discarding an unsafe favicon URL", async function () {
    const client = new TavilyClient("secret", async () => ({
      status: 200,
      body: {
        query: "topic",
        results: [
          {
            url: "https://example.org/page",
            title: "Safe page",
            content: "Passage",
            favicon: "http://127.0.0.1/favicon.ico",
          },
        ],
        usage: { credits: 1 },
      },
    }));
    const result = await client.search({
      query: "topic",
      depth: "basic",
      topic: "general",
      maxResults: 5,
    });

    assert.lengthOf(result.results, 1);
    assert.notProperty(result.results[0], "faviconUrl");
  });

  it("loads plan and credit usage from the usage endpoint", async function () {
    const client = new TavilyClient("secret", async (request) => {
      assert.equal(request.method, "GET");
      assert.equal(request.url, "https://api.tavily.com/usage");
      return {
        status: 200,
        body: {
          key: {
            usage: 18,
            limit: 1000,
            search_usage: 12,
            extract_usage: 6,
          },
          account: {
            current_plan: "Researcher",
            plan_usage: 18,
            plan_limit: 1000,
            paygo_usage: 0,
            paygo_limit: 0,
          },
        },
      };
    });

    assert.deepEqual(await client.getUsage(), {
      provider: "tavily",
      plan: "Researcher",
      credential: { usage: 18, limit: 1000 },
      monthly: { usage: 18, limit: 1000 },
      breakdown: { searchCredits: 12, readCredits: 6 },
      payAsYouGo: { usage: 0, limit: 0 },
    });
  });

  it("maps service failures without exposing the API key", async function () {
    const key = "tvly-never-log-this";
    for (const [status, expected, code] of [
      [422, "rejected the request", "validation"],
      [401, "rejected the API key", "authentication"],
      [429, "rate-limited", "rate_limit"],
      [432, "credit limit", "quota"],
      [433, "pay-as-you-go limit", "plan_limit"],
      [503, "temporarily unavailable", "service"],
    ] as const) {
      const client = new TavilyClient(key, async () => ({ status, body: {} }));
      try {
        await client.getUsage();
        assert.fail(`Expected HTTP ${status} to fail`);
      } catch (error) {
        assert.instanceOf(error, TavilyApiError);
        assert.equal((error as TavilyApiError).code, code);
        const message = error instanceof Error ? error.message : String(error);
        assert.include(message, expected);
        assert.notInclude(message, key);
      }
    }
  });

  it("converts transport failures to a key-safe concise error", async function () {
    const key = "tvly-secret-network-key";
    const client = new TavilyClient(key, async () => {
      throw new Error(`failed with ${key}`);
    });
    try {
      await client.getUsage();
      assert.fail("Expected a network error");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.equal(
        message,
        "Could not reach Tavily. Check the network connection.",
      );
      assert.notInclude(message, key);
    }
  });

  it("redacts the key if a validation response echoes it", async function () {
    const key = "tvly-echoed-secret";
    const client = new TavilyClient(key, async () => ({
      status: 400,
      body: { detail: `Invalid request containing ${key}` },
    }));
    try {
      await client.getUsage();
      assert.fail("Expected a validation error");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.include(message, "[redacted]");
      assert.notInclude(message, key);
    }
  });

  it("rejects credentials, non-web protocols, and local targets", function () {
    for (const url of [
      "file:///tmp/a",
      "https://user:secret@example.com/",
      "http://localhost/",
      "http://127.0.0.1/",
      "http://10.0.0.2/",
      "http://169.254.1.1/",
      "http://192.168.1.10/",
      "http://[::1]/",
      "http://[fd00::1]/",
      "http://router.lan/",
    ]) {
      assert.throws(
        () => normalizePublicWebUrl(url),
        undefined,
        undefined,
        url,
      );
    }
    assert.equal(
      normalizePublicWebUrl("https://example.com/path#fragment"),
      "https://example.com/path",
    );
  });
});
