import { assert } from "chai";
import {
  YoucomApiError,
  YoucomClient,
  type YoucomTransport,
} from "../src/webAccess/youcomClient";

describe("You.com web access client", function () {
  it("sends a bounded search request and normalizes sources", async function () {
    const calls: Parameters<YoucomTransport>[0][] = [];
    const transport: YoucomTransport = async (request) => {
      calls.push(request);
      return {
        status: 200,
        body: {
          results: {
            web: [
              {
                url: "https://www.example.com/report#section",
                title: "Current report",
                description: "Relevant result passage",
                snippets: ["First snippet", "Second snippet"],
                page_age: "2026-08-30T00:00:00",
                favicon_url: "https://you.com/favicon?domain=example.com",
              },
            ],
            news: [
              {
                url: "https://news.example.org/story",
                title: "News story",
                description: "News passage",
                page_age: "2026-09-01T00:00:00",
              },
            ],
          },
          metadata: {
            search_uuid: "uuid-1",
            query: "current topic",
            latency: 0.42,
          },
        },
      };
    };
    const result = await new YoucomClient("ydc-secret", transport).search({
      query: "current topic",
      depth: "advanced",
      topic: "news",
      maxResults: 7,
      timeRange: "week",
      includeDomains: ["example.com"],
      excludeDomains: ["ads.example"],
    });

    assert.lengthOf(calls, 1);
    assert.equal(calls[0].url, "https://api.ydc-index.io/v1/search");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["X-API-Key"], "ydc-secret");
    assert.deepInclude(JSON.parse(calls[0].body || "{}"), {
      query: "current topic",
      count: 7,
      freshness: "week",
      include_domains: ["example.com"],
      exclude_domains: ["ads.example"],
    });
    assert.equal(result.provider, "youcom");
    assert.equal(result.requestId, "uuid-1");
    assert.equal(result.results[0].url, "https://www.example.com/report");
    assert.equal(result.results[0].hostname, "example.com");
    assert.equal(result.results[0].title, "Current report");
    assert.equal(result.results[0].snippet, "First snippet Second snippet");
    assert.equal(
      result.results[0].faviconUrl,
      "https://you.com/favicon?domain=example.com",
    );
    assert.equal(result.results[0].publishedDate, "2026-08-30T00:00:00");
    assert.equal(result.results[1].url, "https://news.example.org/story");
    assert.deepEqual(result.usage, { credits: 0 });
  });

  it("caps count at the provider request shape", async function () {
    let requestBody: Record<string, unknown> = {};
    const client = new YoucomClient("secret", async (request) => {
      requestBody = JSON.parse(request.body || "{}");
      return { status: 200, body: { results: { web: [] }, metadata: {} } };
    });
    const result = await client.search({
      query: "topic",
      depth: "basic",
      topic: "general",
      maxResults: 10,
    });
    assert.equal(requestBody.count, 10);
    assert.lengthOf(result.results, 0);
  });

  it("maps a date range onto the freshness parameter", async function () {
    let requestBody: Record<string, unknown> = {};
    const client = new YoucomClient("secret", async (request) => {
      requestBody = JSON.parse(request.body || "{}");
      return { status: 200, body: { results: { web: [] }, metadata: {} } };
    });
    await client.search({
      query: "topic",
      depth: "basic",
      topic: "general",
      maxResults: 5,
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    assert.equal(requestBody.freshness, "2026-01-01to2026-01-31");
  });

  it("reads page markdown and keeps partial failures", async function () {
    const calls: Parameters<YoucomTransport>[0][] = [];
    const transport: YoucomTransport = async (request) => {
      calls.push(request);
      return {
        status: 200,
        body: [
          {
            url: "https://example.org/a",
            title: "Page A",
            markdown: "# Page A\n\nExtracted passage",
            metadata: {
              site_name: "Example Org",
              favicon_url: "https://ydc-index.io/favicon?domain=example.org",
            },
          },
          { url: "https://example.org/b", title: "Page B", markdown: null },
        ],
      };
    };
    const result = await new YoucomClient("ydc-secret", transport).read({
      urls: ["https://example.org/a", "https://example.org/b"],
      query: "specific question",
      depth: "basic",
      chunksPerSource: 3,
    });

    assert.lengthOf(calls, 1);
    assert.equal(calls[0].url, "https://api.ydc-index.io/v1/contents");
    assert.deepEqual(JSON.parse(calls[0].body || "{}"), {
      urls: ["https://example.org/a", "https://example.org/b"],
      formats: ["markdown"],
    });
    assert.equal(result.provider, "youcom");
    assert.lengthOf(result.pages, 1);
    assert.equal(result.pages[0].url, "https://example.org/a");
    assert.equal(result.pages[0].organization, "Example Org");
    assert.include(result.pages[0].content || "", "Extracted passage");
    assert.lengthOf(result.failedResults, 1);
    assert.equal(result.failedResults[0].url, "https://example.org/b");
    assert.equal(
      result.failedResults[0].error,
      "You.com could not extract this page.",
    );
  });

  it("reports requested URLs the provider never returned", async function () {
    const client = new YoucomClient("secret", async () => ({
      status: 200,
      body: [
        {
          url: "https://example.org/a",
          title: "Page A",
          markdown: "content",
        },
      ],
    }));
    const result = await client.read({
      urls: ["https://example.org/a", "https://example.org/c"],
      query: "q",
      depth: "basic",
      chunksPerSource: 3,
    });
    assert.lengthOf(result.pages, 1);
    assert.deepEqual(
      result.failedResults.map((failure) => failure.url),
      ["https://example.org/c"],
    );
  });

  it("reads the account balance as the usage snapshot", async function () {
    const calls: Parameters<YoucomTransport>[0][] = [];
    const transport: YoucomTransport = async (request) => {
      calls.push(request);
      return {
        status: 200,
        body: {
          data: {
            type: "account",
            id: "hashed",
            attributes: { balance: 744300.0 },
          },
        },
      };
    };
    const usage = await new YoucomClient("ydc-secret", transport).getUsage();

    assert.lengthOf(calls, 1);
    assert.equal(calls[0].method, "GET");
    assert.equal(
      calls[0].url,
      "https://api.you.com/v1/billing/account_balance",
    );
    assert.equal(usage.provider, "youcom");
    assert.equal(usage.plan, "You.com credits");
    assert.equal(usage.credential.limit, 7443);
    assert.equal(usage.payAsYouGo.limit, 7443);
  });

  it("requires an API key", function () {
    assert.throw(() => new YoucomClient("  "), /You.com API key/);
  });

  it("maps provider error statuses onto web access error codes", async function () {
    const cases: Array<{
      status: number;
      body: unknown;
      code: string;
      message: string;
    }> = [
      {
        status: 400,
        body: { detail: "Bad request" },
        code: "validation",
        message: "You.com rejected the request: Bad request",
      },
      {
        status: 401,
        body: {},
        code: "authentication",
        message:
          "You.com rejected the API key. Check it in Preferences → Agent.",
      },
      {
        status: 429,
        body: {},
        code: "rate_limit",
        message: "You.com rate-limited the request. Try again later.",
      },
      {
        status: 402,
        body: {},
        code: "quota",
        message:
          "The You.com account credit balance could not cover the request.",
      },
      {
        status: 503,
        body: {},
        code: "service",
        message: "You.com is temporarily unavailable. Try again later.",
      },
    ];
    for (const { status, body, code, message } of cases) {
      const client = new YoucomClient("secret", async () => ({
        status,
        body,
      }));
      const error = await client
        .search({
          query: "topic",
          depth: "basic",
          topic: "general",
          maxResults: 5,
        })
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );
      assert.instanceOf(error, YoucomApiError);
      if (error instanceof YoucomApiError) {
        assert.equal(error.code, code, `status ${status}`);
        assert.equal(error.message, message, `status ${status}`);
        assert.equal(error.status, status, `status ${status}`);
      }
    }
  });

  it("redacts the API key from provider error details", async function () {
    const client = new YoucomClient("ydc-secret", async () => ({
      status: 400,
      body: { detail: "invalid key ydc-secret" },
    }));
    const error = await client
      .search({
        query: "topic",
        depth: "basic",
        topic: "general",
        maxResults: 5,
      })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    assert.instanceOf(error, YoucomApiError);
    if (error instanceof YoucomApiError) {
      assert.notInclude(error.message, "ydc-secret");
      assert.include(error.message, "[redacted]");
    }
  });

  it("maps transport failures to network errors", async function () {
    const client = new YoucomClient("secret", async () => {
      throw new Error("boom");
    });
    const error = await client
      .search({
        query: "topic",
        depth: "basic",
        topic: "general",
        maxResults: 5,
      })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    assert.instanceOf(error, Error);
    if (error instanceof Error) {
      assert.equal(
        error.message,
        "Could not reach You.com. Check the network connection.",
      );
    }
  });
});
