import { assert } from "chai";
import {
  buildDeepSeekQuery,
  countQueryCharacters,
  DeepSeekSearchClient,
  type DeepSeekSearchTransport,
} from "../src/webAccess/deepseekSearchClient";
import {
  isOfficialDeepSeekApiBase,
  maskApiKey,
  resolveDeepSeekSearchCredential,
} from "../src/webAccess/deepseekSearchKey";
import { WebAccessError } from "../src/webAccess/errors";
import {
  getWebAccessProvider,
  WEB_ACCESS_PROVIDER_PREF,
} from "../src/webAccess/prefs";
import {
  createWebSearchTool,
  validateWebSearchCall,
  validateWebSearchInput,
} from "../src/agent/tools/read/webSearch";
import { validateWebReadInput } from "../src/agent/tools/read/webRead";
import {
  OUTSIDE_SEARCH_GAP_MESSAGE,
  OUTSIDE_SEARCH_NEED_MESSAGE,
  OUTSIDE_SEARCH_NEED_SENTENCE,
  OUTSIDE_SEARCH_STOP_NOTE,
} from "../src/agent/tools/read/outsideSearchNeed";
import {
  clearOutsideSearchTurn,
  webSearchUnavailableMessage,
} from "../src/agent/tools/read/outsideSearchLedger";
import { clearWebSourcesForRun } from "../src/webAccess/runSources";
import type { AgentToolContext } from "../src/agent/types";

const KEY = "sk-synthetic-deepseek-key-1234";
const search = { query: "public documentation", maxResults: 3 };
const result = {
  rerank_score: 2.4,
  title: "Example result",
  url: "https://example.org/a#section",
  snippet: "Short UI snippet",
  summary: "Long  model\nsummary",
  content: "",
  site_name: "Example News",
  site_icon: "https://example.org/favicon.ico",
  date: "2026-06-01T00:00:00+00:00",
  authority: 3,
};

async function failure(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    assert.fail("Expected failure");
  } catch (error) {
    assert.instanceOf(error, WebAccessError);
    assert.equal((error as WebAccessError).code, code);
    return error as WebAccessError;
  }
}

describe("DeepSeek search key resolution", function () {
  it("accepts only the official https origin, never a relay or look-alike host", function () {
    for (const base of [
      "https://api.deepseek.com",
      "https://api.deepseek.com/",
      "https://api.deepseek.com/v1",
      "https://api.deepseek.com/anthropic",
      "https://API.DeepSeek.com/beta",
    ])
      assert.isTrue(isOfficialDeepSeekApiBase(base), base);
    for (const base of [
      "",
      "api.deepseek.com",
      "http://api.deepseek.com",
      "https://api.deepseek.com:8443",
      "https://user:pass@api.deepseek.com",
      "https://user@api.deepseek.com",
      "https://api.deepseek.com.evil.com",
      "https://evil.com/api.deepseek.com",
      "https://deepseek.com",
      "https://openrouter.ai/api/v1",
      "https://api.siliconflow.cn/v1",
      "http://localhost:11434/v1",
    ])
      assert.isFalse(isOfficialDeepSeekApiBase(base), base);
  });

  it("uses the first official API-key group with a key, in profile order", function () {
    const official = (id: string, apiKey = KEY) => ({
      id,
      authMode: "api_key",
      apiBase: "https://api.deepseek.com/v1",
      apiKey,
    });
    assert.deepEqual(
      resolveDeepSeekSearchCredential([
        { ...official("relay"), apiBase: "https://openrouter.ai/api/v1" },
        { ...official("codex"), authMode: "codex_app_server" },
        official("empty", "   "),
        { id: "webchat", authMode: "webchat" },
        {
          ...official("first", ` ${KEY} `),
          models: [{ model: " deepseek-chat " }],
        },
        official("second", "sk-other"),
      ]),
      { groupId: "first", apiKey: KEY, label: "deepseek-chat" },
    );
    assert.isNull(resolveDeepSeekSearchCredential([]));
    assert.isNull(
      resolveDeepSeekSearchCredential([
        { ...official("relay"), apiBase: "https://api.deepseek.com.evil.com" },
      ]),
    );
  });

  it("masks a key down to its prefix and last four characters", function () {
    assert.equal(maskApiKey(KEY), "sk-…1234");
    assert.equal(maskApiKey("short"), "…");
  });
});

describe("DeepSeek query operators", function () {
  it("turns domain and date filters into query operators", function () {
    assert.equal(buildDeepSeekQuery({ query: "  zotero  " }), "zotero");
    assert.equal(
      buildDeepSeekQuery({
        query: "zotero",
        includeDomains: ["github.com", "zotero.org"],
        excludeDomains: ["example.com", "spam.example"],
        startDate: "2025-01-01",
        endDate: "2026-06-01",
      }),
      "zotero site:github.com OR site:zotero.org -site:example.com -site:spam.example after:2025-01-01 before:2026-06-01",
    );
  });

  it("counts Unicode code points like JSON Schema maxLength", function () {
    assert.equal(countQueryCharacters("数据"), 2);
    assert.equal(countQueryCharacters("😀😀"), 2);
    assert.equal("😀😀".length, 4);
  });

  it("reads an unknown or old auto provider setting as tavily", function () {
    const originalZotero = globalThis.Zotero;
    try {
      const read = (value: unknown) => {
        globalThis.Zotero = {
          Prefs: { get: () => value },
        } as unknown as typeof Zotero;
        return getWebAccessProvider();
      };
      assert.equal(read("auto"), "tavily");
      assert.equal(read(undefined), "tavily");
      assert.equal(read("anysearch"), "anysearch");
      assert.equal(read("deepseek"), "deepseek");
    } finally {
      globalThis.Zotero = originalZotero;
    }
  });

  describe("web tool validation with DeepSeek selected", function () {
    const originalZotero = globalThis.Zotero;
    beforeEach(function () {
      const prefs = new Map<string, unknown>([
        [WEB_ACCESS_PROVIDER_PREF, "deepseek"],
      ]);
      globalThis.Zotero = {
        Prefs: { get: (name: string) => prefs.get(name), set() {} },
      } as unknown as typeof Zotero;
    });
    afterEach(function () {
      globalThis.Zotero = originalZotero;
    });

    it("applies the 128-character limit to the query with its filters", function () {
      const exact = validateWebSearchInput({ query: "数".repeat(128) });
      assert.isTrue(exact.ok);
      const tooLong = validateWebSearchInput({
        query: "x".repeat(110),
        includeDomains: ["example.org", "example.com"],
      });
      assert.isFalse(tooLong.ok);
      if (!tooLong.ok) {
        assert.include(tooLong.error, "uses 147 of 128 characters");
      }
      const valid = validateWebSearchInput({
        query: " zotero ",
        maxResults: 4,
        includeDomains: ["Zotero.org"],
        startDate: "2025-01-01",
      });
      assert.deepEqual(valid.ok && valid.value, {
        query: "zotero",
        maxResults: 4,
        includeDomains: ["zotero.org"],
        startDate: "2025-01-01",
      });
    });

    it("accepts need and gap outside the query, its limit and the provider input", function () {
      const call = {
        query: "数".repeat(128),
        need: "not_in_scope_or_library",
        gap: "The library holds no release notes for this version.",
      };
      const expected = { query: "数".repeat(128), maxResults: 5 };
      assert.deepEqual(validateWebSearchInput(call), {
        ok: true,
        value: expected,
      });
      assert.deepEqual(validateWebSearchCall(call), {
        ok: true,
        value: expected,
      });
      assert.deepEqual(
        createWebSearchTool().validate({
          query: "zotero",
          need: "current_or_public_facts",
        }),
        { ok: true, value: { query: "zotero", maxResults: 5 } },
      );
    });

    it("rejects a missing need or gap with the same messages as AnySearch", function () {
      const search = createWebSearchTool();
      assert.deepEqual(search.validate({ query: "zotero" }), {
        ok: false,
        error: OUTSIDE_SEARCH_NEED_MESSAGE,
      });
      assert.deepEqual(
        search.validate({ query: "zotero", need: "somewhere_else" }),
        { ok: false, error: OUTSIDE_SEARCH_NEED_MESSAGE },
      );
      assert.deepEqual(
        search.validate({ query: "zotero", need: "not_in_scope_or_library" }),
        { ok: false, error: OUTSIDE_SEARCH_GAP_MESSAGE },
      );
    });

    it("gives the DeepSeek schema need and gap, and the need sentence", function () {
      const search = createWebSearchTool();
      const schema = search.spec.inputSchema as {
        required: string[];
        properties: Record<string, { maxLength?: number; enum?: string[] }>;
      };
      assert.deepEqual(schema.required, ["query", "need"]);
      assert.deepEqual(Object.keys(schema.properties), [
        "query",
        "maxResults",
        "includeDomains",
        "excludeDomains",
        "startDate",
        "endDate",
        "need",
        "gap",
      ]);
      assert.equal(schema.properties.query.maxLength, 128);
      assert.include(schema.properties.need.enum!, "current_or_public_facts");
      assert.include(search.spec.description, OUTSIDE_SEARCH_NEED_SENTENCE);
      assert.include(search.spec.description, "DeepSeek Search");
      // Routing lives in the search routing contract (promptSingleOwner).
      const text = `${search.spec.description}\n${search.guidance!.instruction}`;
      for (const marker of [
        "Use external search",
        "both source families",
        "for scholarly discovery",
        "A mixed request may also use",
        "only when the user asks to find, recommend",
        "current or general public evidence",
      ])
        assert.notInclude(text, marker);
    });

    it("rejects Tavily-only fields and more than three domains per list", function () {
      for (const extra of [
        { depth: "basic" },
        { topic: "news" },
        { timeRange: "week" },
        { includeDomains: ["a.com", "b.com", "c.com", "d.com"] },
        { excludeDomains: ["127.0.0.1"] },
        { startDate: "2026-13-01" },
        { startDate: "2026-02-01", endDate: "2026-01-01" },
        { maxResults: 11 },
      ])
        assert.isFalse(
          validateWebSearchInput({ query: "zotero", ...extra }).ok,
          JSON.stringify(extra),
        );
      assert.isTrue(
        validateWebReadInput({ urls: ["https://example.org/a"] }).ok,
      );
      assert.isFalse(
        validateWebReadInput({
          urls: ["https://example.org/a"],
          query: "focus",
          depth: "basic",
        }).ok,
      );
    });
  });
});

describe("DeepSeek search client (offline)", function () {
  const originalFetch = globalThis.fetch;
  beforeEach(function () {
    globalThis.fetch = async () => {
      throw new Error("Unexpected network call in offline test");
    };
  });
  afterEach(function () {
    globalThis.fetch = originalFetch;
  });

  it("refuses to construct without a key", function () {
    assert.throws(() => new DeepSeekSearchClient("  "), WebAccessError);
  });

  it("posts the built query with bearer auth and no question or location", async function () {
    const calls: Parameters<DeepSeekSearchTransport>[0][] = [];
    const response = await new DeepSeekSearchClient(KEY, async (request) => {
      calls.push(request);
      return { status: 200, body: { results: [result] } };
    }).search({ ...search, includeDomains: ["example.org"] });
    assert.lengthOf(calls, 1);
    assert.equal(calls[0].url, "https://api.deepseek.com/v1/tools/search");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
    assert.equal(calls[0].headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(calls[0].body), {
      query: "public documentation site:example.org",
      count: 3,
      need_content: false,
    });
    assert.equal(response.provider, "deepseek");
    assert.equal(response.query, search.query);
    assert.notProperty(response, "usage");
    assert.notProperty(response, "depth");
  });

  it("maps results: summary for the model, site name, public icon, date and score", async function () {
    const response = await new DeepSeekSearchClient(KEY, async () => ({
      status: 200,
      body: {
        results: [
          result,
          {
            ...result,
            url: "https://example.org/b",
            title: "",
            summary: "",
            site_name: null,
            site_icon: "http://127.0.0.1/icon.png",
            date: null,
            rerank_score: "high",
          },
          { ...result, url: "http://localhost/private" },
          { ...result, url: null },
          null,
        ],
      },
    })).search({ ...search, maxResults: 5 });
    assert.lengthOf(response.results, 2, "unsafe and missing URLs are dropped");
    const [first, second] = response.results;
    assert.equal(first.url, "https://example.org/a");
    assert.match(first.sourceId, /^web_[a-z0-9]+$/);
    assert.equal(first.hostname, "example.org");
    assert.equal(first.organization, "Example News");
    assert.equal(first.title, "Example result");
    assert.equal(first.snippet, "Long model summary");
    assert.equal(first.faviconUrl, "https://example.org/favicon.ico");
    assert.equal(first.publishedDate, "2026-06-01T00:00:00+00:00");
    assert.equal(first.score, 2.4);
    assert.equal(second.title, "example.org");
    assert.equal(second.organization, "example.org");
    assert.equal(second.snippet, "Short UI snippet");
    for (const field of ["faviconUrl", "publishedDate", "score"])
      assert.notProperty(second, field);
  });

  it("treats an empty list as success and a malformed body as a service error", async function () {
    const empty = await new DeepSeekSearchClient(KEY, async () => ({
      status: 200,
      body: { results: [] },
    })).search(search);
    assert.deepEqual(empty.results, []);
    for (const body of [undefined, null, "text", [], {}, { results: {} }])
      await failure(
        new DeepSeekSearchClient(KEY, async () => ({
          status: 200,
          body,
        })).search(search),
        "service",
      );
  });

  it("rejects unsupported or oversized requests before any call", async function () {
    let calls = 0;
    const client = new DeepSeekSearchClient(KEY, async () => {
      calls++;
      return { status: 200, body: { results: [] } };
    });
    for (const extra of [
      { depth: "basic" as const },
      { topic: "news" as const },
      { timeRange: "day" as const },
      { query: " " },
      { query: "x".repeat(129) },
      { maxResults: 0 },
      { maxResults: 11 },
      { includeDomains: ["a.com", "b.com", "c.com", "d.com"] },
    ])
      await failure(client.search({ ...search, ...extra }), "validation");
    for (const extra of [
      { query: "focus" },
      { depth: "basic" as const },
      { chunksPerSource: 2 },
    ])
      await failure(
        client.read({ urls: ["https://example.org/a"], ...extra }),
        "validation",
      );
    await failure(client.read({ urls: [] }), "validation");
    await failure(client.read({ urls: ["http://localhost/"] }), "unsafe_url");
    await failure(client.getUsage(), "validation");
    assert.equal(calls, 0);
  });

  it("maps search HTTP errors to fixed messages without reading the body", async function () {
    const secret = "synthetic-error-body-secret";
    for (const [status, code] of [
      [400, "validation"],
      [401, "authentication"],
      [402, "quota"],
      [403, "service"],
      [408, "timeout"],
      [413, "validation"],
      [429, "rate_limit"],
      [500, "service"],
      [504, "service"],
    ] as const) {
      let count = 0;
      const error = await failure(
        new DeepSeekSearchClient(KEY, async () => {
          count++;
          return { status, body: { error: { message: secret } } };
        }).search(search),
        code,
      );
      assert.equal(error!.status, status);
      assert.notInclude(JSON.stringify(error), secret);
      assert.notInclude(error!.message, secret);
      assert.notInclude(error!.message, KEY);
      assert.equal(count, 1, "no retry");
      if (status === 402) {
        assert.equal(
          error!.message,
          "DeepSeek balance is insufficient. Top up at platform.deepseek.com.",
        );
      }
    }
    const network = await failure(
      new DeepSeekSearchClient(KEY, async () => {
        throw new Error(`${secret} ${KEY}`);
      }).search(search),
      "network",
    );
    assert.notInclude(network!.message, secret);
    assert.notInclude(network!.message, KEY);
  });

  it("fetches one URL per request at concurrency two, keeping per-page failures", async function () {
    let active = 0;
    let peak = 0;
    const urls = ["a", "b", "c", "d", "e"].map(
      (part) => `https://example.org/${part}`,
    );
    const statusFor: Record<string, number> = {
      "https://example.org/b": 403,
      "https://example.org/c": 404,
      "https://example.org/d": 429,
    };
    const client = new DeepSeekSearchClient(KEY, async (request) => {
      assert.equal(request.url, "https://api.deepseek.com/v1/tools/fetch");
      assert.equal(request.headers.Authorization, `Bearer ${KEY}`);
      const body = JSON.parse(request.body);
      assert.deepEqual(Object.keys(body), ["url"]);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      const status = statusFor[body.url];
      if (status) return { status, body: { error: { message: "private" } } };
      return {
        status: 200,
        body: body.url.endsWith("/a")
          ? { title: "", content: "x".repeat(12_001) }
          : { title: "Page E", content: "# Page E\n\nText." },
      };
    });
    const read = await client.read({ urls });
    assert.equal(peak, 2);
    assert.equal(read.provider, "deepseek");
    assert.deepEqual(
      read.pages.map((page) => page.url),
      ["https://example.org/a", "https://example.org/e"],
    );
    assert.equal(read.pages[0].title, "example.org", "empty title → hostname");
    assert.isTrue(read.pages[0].truncated);
    assert.lengthOf(read.pages[0].content!, 12_000);
    assert.equal(read.pages[1].content, "# Page E\n\nText.");
    assert.notProperty(read.pages[1], "truncated");
    assert.deepEqual(
      read.failedResults.map((entry) => entry.url),
      [
        "https://example.org/b",
        "https://example.org/c",
        "https://example.org/d",
      ],
    );
    assert.notInclude(JSON.stringify(read), "private");
  });

  it("stops queued fetches after a key or balance error", async function () {
    for (const status of [401, 402]) {
      let calls = 0;
      const read = await new DeepSeekSearchClient(KEY, async () => {
        calls++;
        return { status, body: undefined };
      }).read({
        urls: ["a", "b", "c", "d", "e"].map((s) => `https://example.org/${s}`),
      });
      assert.isAtMost(calls, 2, "only the already-running workers");
      assert.isEmpty(read.pages);
      assert.lengthOf(read.failedResults, 5);
    }
  });

  it("reports a page without content as a failure, not a page", async function () {
    const read = await new DeepSeekSearchClient(KEY, async () => ({
      status: 200,
      body: { title: "Empty", content: "  " },
    })).read({ urls: ["https://example.org/a"] });
    assert.isEmpty(read.pages);
    assert.deepEqual(read.failedResults, [
      {
        url: "https://example.org/a",
        error: "DeepSeek returned no page content.",
      },
    ]);
  });

  it("cancels without a request and has a bounded timeout", async function () {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await failure(
      new DeepSeekSearchClient(KEY, async () => {
        called = true;
        return { status: 200, body: { results: [] } };
      }).search({ ...search, signal: controller.signal }),
      "cancelled",
    );
    assert.isFalse(called);
    const original = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void) =>
      original(callback, 0)) as typeof setTimeout;
    try {
      await failure(
        new DeepSeekSearchClient(
          KEY,
          async () => new Promise(() => undefined),
        ).search(search),
        "timeout",
      );
    } finally {
      globalThis.setTimeout = original;
    }
  });
});

describe("DeepSeek web_search outside-search contract (offline)", function () {
  const originalZotero = globalThis.Zotero;
  const context: AgentToolContext = {
    request: {
      conversationKey: 1,
      mode: "agent",
      userText: "Public search",
      authMode: "api_key",
    },
    runId: "deepseek-outside-search",
    item: null,
    currentAnswerText: "",
    modelName: "offline",
  };
  beforeEach(function () {
    const prefs = new Map<string, unknown>([
      [WEB_ACCESS_PROVIDER_PREF, "deepseek"],
    ]);
    globalThis.Zotero = {
      Prefs: { get: (name: string) => prefs.get(name), set() {} },
    } as unknown as typeof Zotero;
  });
  afterEach(function () {
    globalThis.Zotero = originalZotero;
    clearWebSourcesForRun(context.runId!);
    clearOutsideSearchTurn(context.runId!);
  });

  function toolWith(transport: DeepSeekSearchTransport) {
    return createWebSearchTool(() => new DeepSeekSearchClient(KEY, transport));
  }

  it("sends only the query to DeepSeek and closes the result with nextStep", async function () {
    const bodies: unknown[] = [];
    const search = toolWith(async (request) => {
      bodies.push(JSON.parse(request.body));
      return { status: 200, body: { results: [result] } };
    });
    const validated = search.validate({
      query: "zotero release",
      need: "not_in_scope_or_library",
      gap: "No release notes in the library.",
    });
    if (!validated.ok) throw new Error(validated.error);
    const output = await search.execute(validated.value, context);
    assert.deepEqual(bodies, [
      { query: "zotero release", count: 5, need_content: false },
    ]);
    assert.equal(output.provider, "deepseek");
    assert.equal(
      output.nextStep,
      `Outside searches this turn: 1 web (queries: zotero release). ${OUTSIDE_SEARCH_STOP_NOTE}`,
    );
    assert.equal(Object.keys(output).at(-1), "nextStep");
  });

  for (const [status, reason] of [
    [401, "authentication rejected"],
    [402, "quota exhausted"],
  ] as const) {
    it(`latches web search for the turn after HTTP ${status}`, async function () {
      let calls = 0;
      const search = toolWith(async () => {
        calls++;
        return { status, body: undefined };
      });
      const message = webSearchUnavailableMessage("DeepSeek", reason);
      const first = await failure(
        search.execute({ query: "zotero", maxResults: 5 }, context),
        status === 401 ? "authentication" : "quota",
      );
      assert.equal(first!.message, message);
      assert.equal(first!.status, status);
      const second = await search.execute(
        { query: "zotero again", maxResults: 5 },
        context,
      );
      assert.equal(calls, 1, "a latched call never reaches DeepSeek");
      assert.equal(second.provider, "DeepSeek");
      assert.equal(second.unavailable, "latched");
      assert.equal(second.message, message);
      assert.deepEqual(second.results, []);
    });
  }

  it("does not latch on a rate limit", async function () {
    let calls = 0;
    const search = toolWith(async () => {
      calls++;
      return { status: 429, body: undefined };
    });
    for (const query of ["first", "second"])
      await failure(
        search.execute({ query, maxResults: 5 }, context),
        "rate_limit",
      );
    assert.equal(calls, 2);
  });
});
