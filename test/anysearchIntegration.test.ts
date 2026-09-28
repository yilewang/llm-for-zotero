import { assert } from "chai";
import { readFileSync } from "node:fs";
import { AnysearchClient } from "../src/webAccess/anysearchClient";
import { WebAccessError } from "../src/webAccess/errors";
import { buildWebSourceId, TavilyClient } from "../src/webAccess/tavilyClient";
import {
  ANYSEARCH_API_KEY_PREF,
  TAVILY_API_KEY_PREF,
  WEB_ACCESS_PROVIDER_PREF,
  getAnysearchApiKey,
  getWebAccessProvider,
  setAnysearchApiKey,
  setWebAccessProvider,
} from "../src/webAccess/prefs";
import {
  createConfiguredWebAccessProvider,
  isWebAccessToolAvailable,
} from "../src/agent/tools/read/webAccessShared";
import { createWebSearchTool } from "../src/agent/tools/read/webSearch";
import { createWebReadTool } from "../src/agent/tools/read/webRead";
import { registerWebAccessPreferences } from "../src/modules/preferences/webAccessPanel";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import {
  applyRunSourceIds,
  assertWebReadUrlsFromSearch,
  clearWebSourcesForRun,
} from "../src/webAccess/runSources";
import type { AgentToolContext } from "../src/agent/types";

class PreferencesElement {
  value = "";
  hidden = false;
  disabled = false;
  textContent = "";
  events = new Map<string, (() => void)[]>();
  addEventListener(name: string, fn: () => void) {
    this.events.set(name, [...(this.events.get(name) || []), fn]);
  }
  fire(name: string) {
    for (const fn of this.events.get(name) || []) fn();
  }
}

function makePreferencesDocument() {
  const elements = new Map(
    [
      "web-access-provider",
      "anysearch-api-key",
      "anysearch-settings",
      "tavily-settings",
      "anysearch-test",
      "anysearch-status",
    ].map((name) => [name, new PreferencesElement()]),
  );
  const doc = {
    querySelector: (selector: string) =>
      elements.get(selector.replace("#llmforzotero-", "")),
  } as unknown as Document;
  registerWebAccessPreferences(doc);
  return elements;
}

function observeNativeRequest(options: {
  anon?: boolean;
  requestObserver: (xhr: unknown) => void;
}) {
  const xhr = {
    channel: { loadFlags: 0 },
    addEventListener() {},
    removeEventListener() {},
  };
  options.requestObserver(xhr);
  assert.isTrue(options.anon);
  assert.equal(xhr.channel.loadFlags & (1 << 14), 1 << 14);
}

describe("AnySearch native integration (offline)", function () {
  const originalZotero = globalThis.Zotero;
  const originalFetch = globalThis.fetch;
  const originalAbortController = globalThis.AbortController;
  const nativeGlobals = globalThis as unknown as { Components?: unknown };
  const originalComponents = nativeGlobals.Components;
  let prefs: Map<string, unknown>;
  const context: AgentToolContext = {
    request: {
      conversationKey: 1,
      mode: "agent",
      userText: "Public search",
      authMode: "api_key",
    },
    runId: "anysearch-offline",
    item: null,
    currentAnswerText: "",
    modelName: "offline",
  };
  beforeEach(function () {
    nativeGlobals.Components = {
      interfaces: { nsIRequest: { LOAD_ANONYMOUS: 1 << 14 } },
    };
    prefs = new Map([[TAVILY_API_KEY_PREF, "synthetic-tavily-key"]]);
    globalThis.Zotero = {
      Prefs: {
        get: (name: string) => prefs.get(name),
        set: (name: string, value: unknown) => prefs.set(name, value),
      },
    } as unknown as typeof Zotero;
    globalThis.fetch = async () => {
      throw new Error("Unexpected network in offline test");
    };
  });
  afterEach(function () {
    nativeGlobals.Components = originalComponents;
    globalThis.Zotero = originalZotero;
    globalThis.fetch = originalFetch;
    globalThis.AbortController = originalAbortController;
    clearWebSourcesForRun(context.runId!);
  });

  it("keeps Tavily default and dispatches using persisted AnySearch selection, including blank key", function () {
    assert.equal(getWebAccessProvider(), "tavily");
    assert.instanceOf(createConfiguredWebAccessProvider(), TavilyClient);
    setWebAccessProvider("anysearch");
    setAnysearchApiKey("   ");
    assert.equal(prefs.get(WEB_ACCESS_PROVIDER_PREF), "anysearch");
    assert.equal(prefs.get(ANYSEARCH_API_KEY_PREF), "");
    assert.equal(getAnysearchApiKey(), "");
    assert.instanceOf(createConfiguredWebAccessProvider(), AnysearchClient);
    assert.isTrue(isWebAccessToolAvailable(context.request));
    prefs.delete(TAVILY_API_KEY_PREF);
    assert.isTrue(isWebAccessToolAvailable(context.request));
    setAnysearchApiKey(" synthetic-key ");
    assert.equal(getAnysearchApiKey(), "synthetic-key");
    setWebAccessProvider("tavily");
    assert.isFalse(isWebAccessToolAvailable(context.request));
  });

  it("preserves excluded runtimes for anonymous AnySearch", function () {
    setWebAccessProvider("anysearch");
    for (const authMode of ["webchat", "codex_app_server"] as const) {
      assert.isFalse(
        isWebAccessToolAvailable({ ...context.request, authMode }),
      );
    }
    assert.isFalse(
      isWebAccessToolAvailable({
        ...context.request,
        providerProtocol: "web_sync",
      }),
    );
    assert.isTrue(
      isWebAccessToolAvailable({ ...context.request, authMode: "codex_auth" }),
    );
  });

  it("the configured native factory uses only the saved AnySearch key and clearing it restores anonymous headers", async function () {
    const headers: Record<string, string>[] = [];
    Object.assign(globalThis.Zotero, {
      CookieSandbox: class {},
      HTTP: {
        request: async (
          _method: string,
          _url: string,
          options: {
            headers: Record<string, string>;
            requestObserver: (xhr: unknown) => void;
            anon?: boolean;
          },
        ) => {
          observeNativeRequest(options);
          headers.push(options.headers);
          return {
            status: 200,
            responseText: '{"code":0,"data":{"results":[]}}',
          };
        },
      },
    });
    setWebAccessProvider("anysearch");
    setAnysearchApiKey("synthetic-anysearch");
    await createConfiguredWebAccessProvider().search({
      query: "public",
      maxResults: 1,
    });
    setAnysearchApiKey("");
    await createConfiguredWebAccessProvider().search({
      query: "public",
      maxResults: 1,
    });
    assert.equal(headers[0].Authorization, "Bearer synthetic-anysearch");
    assert.notProperty(headers[1], "Authorization");
    assert.notInclude(JSON.stringify(headers), "synthetic-tavily-key");
  });

  for (const scenario of [
    {
      name: "two results",
      status: 200,
      code: 0,
      errorCode: undefined,
      errorMessage: undefined,
    },
    {
      name: "HTTP 402",
      status: 402,
      code: 402,
      errorCode: "quota",
      errorMessage:
        "AnySearch quota exhausted. No credentials were adopted and no retry was made.",
    },
    {
      name: "HTTP 200 / business 429",
      status: 200,
      code: 429,
      errorCode: "rate_limit",
      errorMessage: "AnySearch rate limit reached. Try again later.",
    },
  ] as const) {
    it(`joins saved anonymous AnySearch to Agent search via modern native HTTP: ${scenario.name}`, async function () {
      setWebAccessProvider("anysearch");
      setAnysearchApiKey("");
      assert.equal(prefs.get(ANYSEARCH_API_KEY_PREF), "");
      assert.equal(prefs.get(TAVILY_API_KEY_PREF), "synthetic-tavily-key");
      const query = "参考文献の管理";
      const pages = [
        {
          url: "https://example.org/a",
          title: "Content result",
          content: "Public content summary",
        },
        {
          url: "https://example.org/b",
          title: "Snippet result",
          snippet: "Public snippet summary",
        },
      ];
      const expectedSources = pages.map((page) => ({
        sourceId: buildWebSourceId(`${context.runId}:${page.url}`),
        url: page.url,
        hostname: "example.org",
        organization: "example.org",
        title: page.title,
        snippet: page.content ?? page.snippet,
      }));
      assert.isEmpty(applyRunSourceIds(context.runId!, expectedSources));
      const privateMarker = "synthetic-response-secret";
      type RequestOptions = {
        headers: Record<string, string>;
        body: string;
        userContextId: number;
        requestObserver: (xhr: unknown) => void;
        anon?: boolean;
      };
      const requests: {
        method: string;
        url: string;
        options: RequestOptions;
      }[] = [];
      let contextsCreated = 0;
      let contextsDisposed = 0;
      let fetchCalls = 0;
      globalThis.fetch = async () => {
        fetchCalls++;
        throw new Error("Unexpected fetch fallback in offline Agent search");
      };
      Object.assign(globalThis.Zotero, {
        HTTP: {
          newCookieContext: () => {
            contextsCreated++;
            return {
              id: 100040,
              dispose: () => contextsDisposed++,
            };
          },
          request: async (
            method: string,
            url: string,
            options: RequestOptions,
          ) => {
            requests.push({ method, url, options });
            observeNativeRequest(options);
            return {
              status: scenario.status,
              responseText: JSON.stringify({
                code: scenario.code,
                request_id: scenario.errorCode ? privateMarker : "agent-search",
                ...(scenario.errorCode
                  ? { message: `${privateMarker} synthetic-tavily-key` }
                  : {}),
                // Even valid-looking results in error envelopes must not register.
                data: { results: pages },
              }),
            };
          },
        },
      });
      const search = createWebSearchTool();
      const validated = search.validate({ query });
      assert.deepEqual(validated, {
        ok: true,
        value: { query, maxResults: 5 },
      });
      if (!validated.ok) throw new Error(validated.error);
      let result: Awaited<ReturnType<typeof search.execute>> | undefined;
      let failure: unknown;
      try {
        result = await search.execute(validated.value, context);
      } catch (error) {
        failure = error;
      }

      assert.lengthOf(requests, 1, "No retry or provider fallback");
      assert.equal(fetchCalls, 0);
      assert.equal(contextsCreated, 1);
      assert.equal(contextsDisposed, 1);
      const { method, url, options } = requests[0];
      assert.equal(method, "POST");
      assert.equal(url, "https://api.anysearch.com/v1/search");
      assert.deepEqual(JSON.parse(options.body), { query, max_results: 5 });
      assert.equal(options.userContextId, 100040);
      assert.notProperty(options, "cookieSandbox");
      assert.notInclude(
        Object.keys(options.headers).map((key) => key.toLowerCase()),
        "authorization",
      );
      assert.notInclude(JSON.stringify(requests), "synthetic-tavily-key");

      if (scenario.errorCode) {
        assert.isUndefined(result);
        assert.instanceOf(failure, WebAccessError);
        const error = failure as WebAccessError;
        assert.equal(error.code, scenario.errorCode);
        assert.equal(error.status, scenario.status);
        assert.equal(error.message, scenario.errorMessage);
        assert.isUndefined(error.requestId);
        assert.notProperty(error, "cause");
        const serialized = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
        assert.notInclude(serialized, privateMarker);
        assert.notInclude(serialized, "synthetic-tavily-key");
        assert.isEmpty(applyRunSourceIds(context.runId!, expectedSources));
        for (const page of pages) {
          assert.throws(
            () => assertWebReadUrlsFromSearch(context.runId!, [page.url]),
            "returned by web_search",
          );
        }
      } else {
        assert.isUndefined(failure);
        assert.isDefined(result);
        assert.equal(result!.provider, "anysearch");
        assert.equal(result!.query, query);
        assert.equal(result!.requestId, "agent-search");
        assert.deepEqual(result!.results, expectedSources);
        assert.deepEqual(
          result!.citation.availableSourceIds,
          expectedSources.map((source) => source.sourceId),
        );
        assert.deepEqual(
          applyRunSourceIds(context.runId!, expectedSources),
          expectedSources,
        );
        assert.doesNotThrow(() =>
          assertWebReadUrlsFromSearch(
            context.runId!,
            pages.map((page) => page.url),
          ),
        );
      }
    });
  }

  it("refreshes registered schemas with saved provider changes, without unsupported fields or costs", function () {
    const registry = new AgentToolRegistry();
    const search = createWebSearchTool();
    const read = createWebReadTool();
    registry.register(search);
    registry.register(read);
    setWebAccessProvider("anysearch");
    const specs = registry.listToolsForRequest(context.request);
    const schema = specs[0].inputSchema as {
      required: string[];
      properties: object;
    };
    assert.deepEqual(schema.required, ["query"]);
    assert.deepEqual(Object.keys(schema.properties), ["query", "maxResults"]);
    assert.notInclude(JSON.stringify(specs), "costs 1 credit");
    assert.notInclude(search.guidance!.instruction, "explicitly choose basic");
    assert.isTrue(search.validate({ query: "hello" }).ok);
    for (const key of [
      "depth",
      "topic",
      "startDate",
      "endDate",
      "timeRange",
      "includeDomains",
      "excludeDomains",
      "tag",
      "zone",
    ]) {
      assert.isFalse(
        search.validate({ query: "hello", [key]: "unsupported" }).ok,
        key,
      );
    }
    assert.isTrue(read.validate({ urls: ["https://example.org/a"] }).ok);
    for (const key of ["query", "depth", "chunksPerSource"]) {
      assert.isFalse(
        read.validate({ urls: ["https://example.org/a"], [key]: "unsupported" })
          .ok,
      );
    }
    setWebAccessProvider("tavily");
    assert.isFalse(search.validate({ query: "hello" }).ok);
    assert.include(JSON.stringify(search.spec.inputSchema), "advanced");
  });

  it("runs search then read with stable citations and blocks unsearched URLs (mock transport)", async function () {
    setWebAccessProvider("anysearch");
    let calls = 0;
    const client = new AnysearchClient("", async (request) => {
      calls++;
      assert.notProperty(request.headers, "Authorization");
      const page = {
        url: "https://example.org/a",
        title: "Public result",
        content: "Text",
      };
      return {
        status: 200,
        body: {
          code: 0,
          request_id: "mock-request",
          data: request.url.endsWith("/search") ? { results: [page] } : page,
        },
      };
    });
    const search = createWebSearchTool(() => client);
    const read = createWebReadTool(() => client);
    const result = await search.execute(
      { query: "public", maxResults: 3 },
      context,
    );
    const extracted = await read.execute(
      { urls: [result.results[0].url] },
      context,
    );
    assert.equal(result.results[0].sourceId, extracted.pages[0].sourceId);
    assert.deepEqual(extracted.citation.availableSourceIds, [
      result.results[0].sourceId,
    ]);
    assert.equal(
      search.presentation!.buildTraceSummary!({
        args: { query: "public" },
        content: result,
      }),
      "Searched web · AnySearch",
    );
    assert.equal(
      read.presentation!.buildTraceSummary!({
        args: { urls: [result.results[0].url] },
        content: extracted,
      }),
      "Read web pages · AnySearch",
    );
    try {
      await read.execute(
        { urls: ["https://example.org/not-searched"] },
        context,
      );
      assert.fail("Expected searched-URL restriction");
    } catch (error) {
      assert.include((error as Error).message, "returned by web_search");
    }
    assert.equal(calls, 2);
    const plan = await search.planInvocation!(
      { query: "public", maxResults: 3 },
      context,
    );
    assert.include(JSON.stringify(plan), "egress");
  });

  it("revalidates stale Tavily arguments instead of silently dropping them after a switch", async function () {
    const search = createWebSearchTool();
    setWebAccessProvider("anysearch");
    try {
      await search.execute(
        { query: "public", maxResults: 3, depth: "advanced", topic: "news" },
        context,
      );
      assert.fail("Expected stale arguments to fail");
    } catch (error) {
      assert.include((error as Error).message, "only query");
    }
  });

  it("wires settings save/reload and explicit mocked search without a global AbortController", async function () {
    let calls = 0;
    let quota = false;
    globalThis.AbortController = undefined as unknown as typeof AbortController;
    Object.assign(globalThis.Zotero, {
      getMainWindow: () => ({ AbortController: originalAbortController }),
      CookieSandbox: class {},
      HTTP: {
        request: async (
          _method: string,
          url: string,
          options: {
            headers: Record<string, string>;
            body: string;
            requestObserver: (xhr: unknown) => void;
            anon?: boolean;
          },
        ) => {
          observeNativeRequest(options);
          calls++;
          assert.equal(url, "https://api.anysearch.com/v1/search");
          assert.deepEqual(JSON.parse(options.body), {
            query: "Zotero reference management",
            max_results: 3,
          });
          assert.notProperty(options.headers, "Authorization");
          return quota
            ? {
                status: 402,
                responseText: '{"message":"synthetic-generated-secret"}',
              }
            : {
                status: 200,
                responseText:
                  '{"code":0,"request_id":"settings-test","data":{"results":[{"url":"https://example.org/a","title":"Example","content":"Public"}]}}',
              };
        },
      },
    });
    const elements = makePreferencesDocument();
    assert.equal(elements.get("web-access-provider")!.value, "tavily");
    elements.get("web-access-provider")!.value = "anysearch";
    elements.get("web-access-provider")!.fire("change");
    elements.get("anysearch-api-key")!.value = "   ";
    elements.get("anysearch-api-key")!.fire("blur");
    assert.equal(getAnysearchApiKey(), "");
    const reloaded = makePreferencesDocument();
    assert.equal(reloaded.get("web-access-provider")!.value, "anysearch");
    assert.isFalse(reloaded.get("anysearch-settings")!.hidden);
    assert.isTrue(reloaded.get("tavily-settings")!.hidden);
    assert.equal(calls, 0);
    reloaded.get("anysearch-test")!.fire("click");
    assert.isTrue(reloaded.get("anysearch-test")!.disabled);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 1);
    assert.include(
      reloaded.get("anysearch-status")!.textContent,
      "settings-test",
    );
    assert.include(
      reloaded.get("anysearch-status")!.textContent,
      "https://example.org/a",
    );
    assert.isFalse(reloaded.get("anysearch-test")!.disabled);
    quota = true;
    reloaded.get("anysearch-test")!.fire("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 2);
    assert.notInclude(
      reloaded.get("anysearch-status")!.textContent,
      "synthetic-generated-secret",
    );
    assert.equal(getAnysearchApiKey(), "");
    const xhtml = readFileSync("addon/content/preferences.xhtml", "utf8");
    assert.include(xhtml, 'id="__addonRef__-anysearch-api-key"');
    assert.include(xhtml, "AnySearch API key (optional)");
    assert.include(
      readFileSync("src/modules/preferenceScript.ts", "utf8"),
      "registerWebAccessPreferences(doc)",
    );
  });

  it("reports a fixed settings error if no cancellation controller exists", function () {
    globalThis.AbortController = undefined as unknown as typeof AbortController;
    setWebAccessProvider("anysearch");
    const elements = makePreferencesDocument();
    assert.doesNotThrow(() => elements.get("anysearch-test")!.fire("click"));
    assert.equal(
      elements.get("anysearch-status")!.textContent,
      "AnySearch test search failed.",
    );
    assert.isFalse(elements.get("anysearch-test")!.disabled);
  });

  for (const change of ["input", "blur", "provider"] as const) {
    for (const outcome of ["success", "error"] as const) {
      it(`invalidates a pending test on ${change} and ignores its late ${outcome}`, async function () {
        const originalSearch = AnysearchClient.prototype.search;
        type Response = Awaited<ReturnType<typeof originalSearch>>;
        const calls: {
          signal?: AbortSignal;
          resolve: (response: Response) => void;
          reject: (error: Error) => void;
        }[] = [];
        // Intentionally ignore abort: generation checks must also protect the UI
        // when an already-completing transport delivers a late result or error.
        AnysearchClient.prototype.search = function (request) {
          return new Promise<Response>((resolve, reject) => {
            calls.push({ signal: request.signal, resolve, reject });
          });
        };
        try {
          setWebAccessProvider("anysearch");
          setAnysearchApiKey("synthetic-old-key");
          const elements = makePreferencesDocument();
          const button = elements.get("anysearch-test")!;
          const status = elements.get("anysearch-status")!;
          const key = elements.get("anysearch-api-key")!;
          const provider = elements.get("web-access-provider")!;
          button.fire("click");
          assert.lengthOf(calls, 1);
          assert.isTrue(button.disabled);
          assert.isNotEmpty(status.textContent);

          if (change === "provider") {
            provider.value = "tavily";
            provider.fire("change");
            assert.equal(getWebAccessProvider(), "tavily");
            assert.isTrue(elements.get("anysearch-settings")!.hidden);
          } else {
            key.value = "";
            key.fire(change);
            assert.isEmpty(status.textContent);
            if (change === "input") key.fire("change");
            assert.equal(getAnysearchApiKey(), "");
          }
          assert.isTrue(calls[0].signal?.aborted);
          assert.isEmpty(status.textContent);
          assert.isFalse(button.disabled);

          if (outcome === "success") {
            calls[0].resolve({
              provider: "anysearch",
              query: "old settings",
              results: [],
              requestId: "stale-result",
            });
          } else {
            calls[0].reject(
              new WebAccessError("Synthetic stale failure.", "authentication"),
            );
          }
          await Promise.resolve();
          assert.isEmpty(status.textContent);
          assert.isFalse(button.disabled);
          assert.lengthOf(calls, 1);

          if (change === "provider") {
            provider.value = "anysearch";
            provider.fire("change");
            assert.isEmpty(status.textContent);
          }
        } finally {
          AnysearchClient.prototype.search = originalSearch;
        }
      });
    }
  }

  it("does not let an obsolete completion re-enable or overwrite a newer test", async function () {
    const originalSearch = AnysearchClient.prototype.search;
    type Response = Awaited<ReturnType<typeof originalSearch>>;
    const complete: ((response: Response) => void)[] = [];
    AnysearchClient.prototype.search = () =>
      new Promise<Response>((resolve) => complete.push(resolve));
    try {
      setWebAccessProvider("anysearch");
      const elements = makePreferencesDocument();
      const button = elements.get("anysearch-test")!;
      const status = elements.get("anysearch-status")!;
      const key = elements.get("anysearch-api-key")!;
      button.fire("click");
      key.value = "synthetic-new-key";
      key.fire("input");
      key.fire("change");
      button.fire("click");
      assert.lengthOf(complete, 2);
      const pendingStatus = status.textContent;
      complete[0]({
        provider: "anysearch",
        query: "old",
        results: [],
        requestId: "stale-result",
      });
      await Promise.resolve();
      assert.equal(status.textContent, pendingStatus);
      assert.isTrue(button.disabled);
      complete[1]({
        provider: "anysearch",
        query: "new",
        results: [],
        requestId: "current-result",
      });
      await Promise.resolve();
      assert.include(status.textContent, "current-result");
      assert.notInclude(status.textContent, "stale-result");
      assert.isFalse(button.disabled);
      key.fire("blur");
      assert.include(status.textContent, "current-result");
    } finally {
      AnysearchClient.prototype.search = originalSearch;
    }
  });
});
