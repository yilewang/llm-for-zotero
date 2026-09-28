import { assert } from "chai";
import {
  AnysearchClient,
  type AnysearchTransport,
} from "../src/webAccess/anysearchClient";
import { WebAccessError } from "../src/webAccess/errors";

const search = { query: "public documentation", maxResults: 3 };
const page = {
  url: "https://example.org/a",
  title: "Example",
  content: "Public text",
};
const success = (data: unknown) => ({
  status: 200,
  body: { code: 0, request_id: "req-test-1", data },
});

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

describe("AnySearch client (offline)", function () {
  const originalFetch = globalThis.fetch;
  const originalZotero = globalThis.Zotero;
  const originalAbortController = globalThis.AbortController;
  const nativeGlobals = globalThis as unknown as { Components?: unknown };
  const originalComponents = nativeGlobals.Components;
  beforeEach(function () {
    globalThis.fetch = async () => {
      throw new Error("Unexpected network call in offline test");
    };
    globalThis.Zotero = undefined as unknown as typeof Zotero;
    nativeGlobals.Components = {
      interfaces: { nsIRequest: { LOAD_ANONYMOUS: 1 << 14 } },
    };
  });
  afterEach(function () {
    globalThis.fetch = originalFetch;
    globalThis.Zotero = originalZotero;
    globalThis.AbortController = originalAbortController;
    nativeGlobals.Components = originalComponents;
  });

  it("maps query/count, omits anonymous auth and never invents usage/depth", async function () {
    const calls: Parameters<AnysearchTransport>[0][] = [];
    const client = new AnysearchClient("  ", async (request) => {
      calls.push(request);
      return success({
        results: [{ ...page, content: undefined, snippet: "Snippet" }],
      });
    });
    const result = await client.search(search);
    assert.lengthOf(calls, 1);
    assert.equal(calls[0].url, "https://api.anysearch.com/v1/search");
    assert.equal(calls[0].method, "POST");
    assert.notProperty(calls[0].headers, "Authorization");
    assert.match(calls[0].headers["X-Anysearch-Client"], /^llm-for-zotero\//);
    assert.deepEqual(JSON.parse(calls[0].body), {
      query: search.query,
      max_results: 3,
    });
    assert.equal(result.results[0].snippet, "Snippet");
    assert.equal(result.results[0].title, "Example");
    assert.equal(result.requestId, "req-test-1");
    assert.notProperty(result, "usage");
    assert.notProperty(result, "depth");
    assert.notProperty(result, "topic");
  });

  it("constructs Bearer headers with a synthetic key (not a live key check)", async function () {
    await new AnysearchClient(" synthetic-test-key ", async (request) => {
      assert.equal(request.headers.Authorization, "Bearer synthetic-test-key");
      return success({ results: [] });
    }).search(search);
  });

  it("uses the native main-window AbortController when the plugin global lacks it", async function () {
    globalThis.AbortController = undefined as unknown as typeof AbortController;
    globalThis.Zotero = {
      getMainWindow: () => ({ AbortController: originalAbortController }),
    } as unknown as typeof Zotero;
    let calls = 0;
    await new AnysearchClient("", async (request) => {
      calls++;
      assert.isFalse(request.signal.aborted);
      return success({ results: [] });
    }).search(search);
    assert.equal(calls, 1);
  });

  it("distinguishes empty success from malformed, unsafe and failed responses", async function () {
    assert.deepEqual(
      (
        await new AnysearchClient("", async () =>
          success({ results: [] }),
        ).search(search)
      ).results,
      [],
    );
    for (const body of [
      null,
      "invalid",
      {},
      { code: 0 },
      { code: 0, data: {} },
      { code: 0, data: { results: [null] } },
      { code: 0, data: { results: [{ url: page.url }] } },
      { code: 123, message: "do not expose this", data: { results: [] } },
    ]) {
      await failure(
        new AnysearchClient("", async () => ({ status: 200, body })).search(
          search,
        ),
        "service",
      );
    }
    for (const url of [
      "http://127.0.0.1/",
      "file:///a",
      "https://user:password@example.org/",
    ]) {
      await failure(
        new AnysearchClient("", async () =>
          success({ results: [{ ...page, url }] }),
        ).search(search),
        "unsafe_url",
      );
    }
  });

  it("rejects unsupported parameters before dispatch, including explicit empty filters", async function () {
    let calls = 0;
    const client = new AnysearchClient("", async () => {
      calls++;
      return success({ results: [] });
    });
    for (const extra of [
      { depth: "advanced" as const },
      { topic: "general" as const },
      { includeDomains: [] },
      { excludeDomains: ["example.org"] },
      { startDate: "2026-09-24" },
      { timeRange: "day" as const },
      { maxResults: 0 },
      { maxResults: 11 },
      { query: " " },
    ])
      await failure(client.search({ ...search, ...extra }), "validation");
    for (const extra of [
      { query: "focus" },
      { depth: "basic" as const },
      { chunksPerSource: 3 },
    ]) {
      await failure(client.read({ urls: [page.url], ...extra }), "validation");
    }
    await failure(client.getUsage(), "validation");
    assert.equal(calls, 0);
  });

  it("sanitizes HTTP and business errors, never retries or adopts credentials", async function () {
    const secret = "synthetic-generated-password";
    for (const [status, code] of [
      [400, "validation"],
      [401, "authentication"],
      [402, "quota"],
      [403, "authentication"],
      [429, "rate_limit"],
      [503, "service"],
    ] as const) {
      for (const business of [false, true]) {
        let count = 0;
        const client = new AnysearchClient("", async (request) => {
          count++;
          assert.notProperty(request.headers, "Authorization");
          return {
            status: business ? 200 : status,
            body: {
              code: status,
              message: secret,
              username: secret,
              password: secret,
              api_key: secret,
            },
          };
        });
        const error = await failure(client.search(search), code);
        assert.notInclude(JSON.stringify(error), secret);
        assert.notInclude(error!.message, secret);
        assert.notProperty(error, "cause");
        assert.equal(error!.status, business ? 200 : status);
        assert.equal(count, 1);
      }
    }
    const error = await failure(
      new AnysearchClient("", async () => {
        throw new Error(secret);
      }).search(search),
      "network",
    );
    assert.notInclude(error!.message, secret);
  });

  it("rejects cancellation without a request and cancels a pending transport", async function () {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const client = new AnysearchClient("", async () => {
      called = true;
      return success({ results: [] });
    });
    await failure(
      client.search({ ...search, signal: controller.signal }),
      "cancelled",
    );
    assert.isFalse(called);
    const pendingController = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const pending = new AnysearchClient("", async (request) => {
      transportSignal = request.signal;
      return new Promise(() => undefined);
    }).search({ ...search, signal: pendingController.signal });
    pendingController.abort();
    await failure(pending, "cancelled");
    assert.isTrue(transportSignal?.aborted);
  });

  it("has a bounded timeout even when the injected transport never resolves", async function () {
    const original = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void) =>
      original(callback, 0)) as typeof setTimeout;
    try {
      await failure(
        new AnysearchClient(
          "",
          async () => new Promise(() => undefined),
        ).search(search),
        "timeout",
      );
    } finally {
      globalThis.setTimeout = original;
    }
  });

  it("extracts at concurrency two, retains order/partial failures and local truncation", async function () {
    let active = 0;
    let peak = 0;
    const calls: string[] = [];
    const urls = ["a", "b", "c", "d", "e"].map(
      (part) => `https://example.org/${part}`,
    );
    const client = new AnysearchClient("", async (request) => {
      assert.equal(request.url, "https://api.anysearch.com/v1/extract");
      const body = JSON.parse(request.body);
      assert.deepEqual(Object.keys(body), ["url"]);
      calls.push(body.url);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      if (body.url.endsWith("/b"))
        return { status: 503, body: { message: "private" } };
      return success({ ...page, url: body.url, content: "x".repeat(12001) });
    });
    const result = await client.read({ urls });
    assert.equal(peak, 2);
    assert.lengthOf(calls, 5);
    assert.deepEqual(
      result.pages.map((entry) => entry.url),
      urls.filter((url) => !url.endsWith("/b")),
    );
    assert.equal(result.failedResults[0].url, urls[1]);
    assert.notInclude(result.failedResults[0].error, "private");
    assert.isTrue(result.pages[0].truncated);
    assert.lengthOf(result.pages[0].content!, 12000);
    assert.notProperty(result, "usage");
    assert.lengthOf(result.requestIds!, 4);
  });

  it("bounds URL inputs, preserves failures and does not accept redirected source identity", async function () {
    let calls = 0;
    const client = new AnysearchClient("", async () => {
      calls++;
      return success({ ...page, url: "https://different.example/" });
    });
    await failure(client.read({ urls: [] }), "validation");
    await failure(client.read({ urls: Array(6).fill(page.url) }), "validation");
    await failure(client.read({ urls: ["http://localhost/"] }), "unsafe_url");
    const binary = await client.read({
      urls: ["https://example.org/paper.pdf"],
    });
    assert.lengthOf(binary.failedResults, 1);
    assert.equal(calls, 0);
    const mismatched = await client.read({ urls: [page.url] });
    assert.isEmpty(mismatched.pages);
    assert.include(
      mismatched.failedResults[0].error,
      "different extraction URL",
    );
  });

  it("stops queued extraction after quota exhaustion without using response credentials", async function () {
    let calls = 0;
    const client = new AnysearchClient("", async (request) => {
      calls++;
      assert.notProperty(request.headers, "Authorization");
      return { status: 402, body: { message: "synthetic-new-credentials" } };
    });
    const result = await client.read({
      urls: ["a", "b", "c", "d", "e"].map((s) => `https://example.org/${s}`),
    });
    assert.isAtMost(calls, 2); // only the already-running workers
    assert.lengthOf(result.failedResults, 5);
    assert.notInclude(JSON.stringify(result), "synthetic-new-credentials");
  });

  it("uses native no-body-log/no-retry transport and never reads a 402 body", async function () {
    let options: Record<string, unknown> = {};
    globalThis.Zotero = {
      CookieSandbox: class {
        constructor(_browser: unknown, uri: string, cookies: string) {
          assert.equal(uri, "https://api.anysearch.com");
          assert.equal(cookies, "");
        }
      },
      HTTP: {
        request: async (
          _method: string,
          _url: string,
          value: Record<string, unknown>,
        ) => {
          options = value;
          const xhr = {
            channel: { loadFlags: 0 },
            addEventListener() {},
            removeEventListener() {},
          };
          (value.requestObserver as (xhr: unknown) => void)(xhr);
          assert.equal(xhr.channel.loadFlags & (1 << 14), 1 << 14);
          return {
            status: 402,
            get responseText() {
              throw new Error("Error body must not be accessed");
            },
          };
        },
      },
    } as unknown as typeof Zotero;
    await failure(new AnysearchClient().search(search), "quota");
    assert.equal(options.logBodyLength, 0);
    assert.equal(options.errorDelayMax, 0);
    assert.equal(options.followRedirects, false);
    assert.equal(options.timeout, 60000);
    assert.equal(options.debug, false);
    assert.equal(options.anon, true);
    assert.isObject(options.cookieSandbox);
    assert.notProperty(options, "userContextId");
    assert.lengthOf(Object.keys(options), 14);
    assert.notProperty(options.headers as object, "Authorization");
  });

  it("uses mocked fetch with no cookies/redirects and handles malformed JSON", async function () {
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      return new Response("not JSON", { status: 200 });
    }) as typeof fetch;
    await failure(new AnysearchClient().search(search), "service");
  });

  it("uses fresh modern cookie contexts without a legacy constructor and disposes each exact context", async function () {
    const disposed: number[] = [];
    const contexts: { id: number; dispose: () => void }[] = [];
    const listeners = new Set<unknown>();
    let calls = 0;
    const http = {
      newCookieContext() {
        assert.strictEqual(this, http);
        const context = {
          id: 100000 + contexts.length,
          dispose() {
            assert.strictEqual(this, context);
            disposed.push(this.id);
          },
        };
        contexts.push(context);
        return context;
      },
      async request(
        _method: string,
        _url: string,
        options: Record<string, unknown>,
      ) {
        calls++;
        assert.equal(options.userContextId, contexts[calls - 1].id);
        assert.notProperty(options, "cookieSandbox");
        assert.lengthOf(Object.keys(options), 14);
        assert.notProperty(options.headers as object, "Authorization");
        assert.equal(options.anon, true);
        assert.equal(options.foreground, false);
        assert.equal(options.followRedirects, false);
        assert.equal(options.debug, false);
        assert.equal(options.logBodyLength, 0);
        assert.equal(options.errorDelayMax, 0);
        assert.equal(options.successCodes, false);
        assert.equal(options.timeout, 60000);
        const xhr = {
          channel: { loadFlags: 2 },
          addEventListener: (_name: string, listener: unknown) =>
            listeners.add(listener),
          removeEventListener: (_name: string, listener: unknown) =>
            listeners.delete(listener),
          status: 200,
          responseText: JSON.stringify(success({ results: [] }).body),
        };
        (options.requestObserver as (xhr: unknown) => void)(xhr);
        assert.equal(xhr.channel.loadFlags, 2 | (1 << 14));
        assert.notInclude(disposed, options.userContextId);
        return xhr;
      },
    };
    globalThis.Zotero = { HTTP: http } as unknown as typeof Zotero;
    const client = new AnysearchClient();
    const results = await Promise.all([
      client.search(search),
      client.search(search),
    ]);
    assert.isTrue(results.every((result) => result.results.length === 0));
    assert.equal(calls, 2);
    assert.deepEqual(disposed.sort(), [100000, 100001]);
    assert.equal(listeners.size, 0);
  });

  it("disposes modern contexts on native failures without reading error bodies or using legacy isolation", async function () {
    for (const mode of ["http", "throw", "observer", "parse"]) {
      let disposed = 0;
      let calls = 0;
      globalThis.Zotero = {
        get CookieSandbox() {
          throw new Error("Modern requests must not access the legacy API");
        },
        HTTP: {
          newCookieContext: () => ({
            id: 100010,
            dispose: () => disposed++,
          }),
          request: async (
            _method: string,
            _url: string,
            options: Record<string, unknown>,
          ) => {
            calls++;
            if (mode === "throw") throw new Error("synthetic-private-error");
            if (mode === "observer")
              (options.requestObserver as (xhr: unknown) => void)({});
            return {
              status: mode === "http" ? 402 : 200,
              get responseText() {
                if (mode === "http")
                  throw new Error("Error bodies must not be read");
                return "not JSON";
              },
            };
          },
        },
      } as unknown as typeof Zotero;
      const error = await failure(
        new AnysearchClient().search(search),
        mode === "http" ? "quota" : mode === "parse" ? "service" : "network",
      );
      assert.notInclude(error!.message, "synthetic-private-error");
      assert.notProperty(error, "cause");
      assert.equal(calls, 1);
      assert.equal(disposed, 1);
    }
  });

  it("cancels a modern native request and disposes its context once", async function () {
    const controller = new AbortController();
    let disposed = 0;
    let cancelled = 0;
    globalThis.Zotero = {
      HTTP: {
        newCookieContext: () => ({
          id: 100020,
          dispose: () => disposed++,
        }),
        request: (
          _method: string,
          _url: string,
          options: Record<string, unknown>,
        ) =>
          new Promise((_resolve, reject) => {
            (options.cancellerReceiver as (fn: () => void) => void)(() => {
              cancelled++;
              reject(new Error("synthetic-private-cancellation"));
            });
          }),
      },
    } as unknown as typeof Zotero;
    const pending = new AnysearchClient().search({
      ...search,
      signal: controller.signal,
    });
    controller.abort();
    await failure(pending, "cancelled");
    assert.equal(cancelled, 1);
    assert.equal(disposed, 1);
  });

  it("disposes a modern context on early setup failure without dispatch or fetch fallback", async function () {
    let disposed = 0;
    let calls = 0;
    nativeGlobals.Components = undefined;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("Must not fall back");
    };
    globalThis.Zotero = {
      HTTP: {
        newCookieContext: () => ({
          id: 100030,
          dispose: () => disposed++,
        }),
        request: async () => {
          calls++;
          throw new Error("Must not dispatch");
        },
      },
    } as unknown as typeof Zotero;
    await failure(new AnysearchClient().search(search), "network");
    assert.equal(calls, 0);
    assert.equal(disposed, 1);
  });

  it("fails closed for missing or invalid isolation APIs and does not downgrade a failing modern factory", async function () {
    let calls = 0;
    let disposed = 0;
    let legacyCalls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("Must not fall back");
    };
    for (const factory of [
      undefined,
      () => undefined,
      () => ({ id: 100040 }),
      ...[0, -1, 1.5, NaN, Infinity].map((id) => () => ({
        id,
        dispose: () => disposed++,
      })),
      () => {
        throw new Error("synthetic-private-setup");
      },
    ]) {
      globalThis.Zotero = {
        ...(factory
          ? {
              CookieSandbox: class {
                constructor() {
                  legacyCalls++;
                }
              },
            }
          : {}),
        HTTP: {
          newCookieContext: factory,
          request: async () => {
            calls++;
            throw new Error("Must not dispatch");
          },
        },
      } as unknown as typeof Zotero;
      const error = await failure(
        new AnysearchClient().search(search),
        "network",
      );
      assert.notInclude(error!.message, "synthetic-private-setup");
    }
    assert.equal(calls, 0);
    assert.equal(legacyCalls, 0);
    assert.equal(disposed, 5);
  });

  it("still disposes the modern context if observer removal fails", async function () {
    let disposed = 0;
    globalThis.Zotero = {
      HTTP: {
        newCookieContext: () => ({
          id: 100050,
          dispose: () => disposed++,
        }),
        request: async (
          _method: string,
          _url: string,
          options: Record<string, unknown>,
        ) => {
          const xhr = {
            channel: { loadFlags: 0 },
            addEventListener() {},
            removeEventListener() {
              throw new Error("synthetic-private-cleanup");
            },
            status: 200,
            responseText: JSON.stringify(success({ results: [] }).body),
          };
          (options.requestObserver as (xhr: unknown) => void)(xhr);
          return xhr;
        },
      },
    } as unknown as typeof Zotero;
    await failure(new AnysearchClient().search(search), "network");
    assert.equal(disposed, 1);
  });

  it("aborts native oversized responses before reading their body", async function () {
    for (const mode of ["header", "progress"]) {
      let aborted = false;
      const listeners = new Map<string, (event?: unknown) => void>();
      globalThis.Zotero = {
        CookieSandbox: class {},
        HTTP: {
          request: async (
            _method: string,
            _url: string,
            options: Record<string, unknown>,
          ) => {
            const xhr = {
              channel: { loadFlags: 0 },
              status: 200,
              readyState: 2,
              getResponseHeader: () => (mode === "header" ? "1048577" : null),
              addEventListener: (
                name: string,
                listener: (event?: unknown) => void,
              ) => listeners.set(name, listener),
              removeEventListener: (name: string) => listeners.delete(name),
              abort: () => {
                aborted = true;
              },
              get responseText() {
                throw new Error("Oversized body must not be read");
              },
            };
            (options.requestObserver as (xhr: unknown) => void)(xhr);
            if (mode === "header") listeners.get("readystatechange")?.();
            else listeners.get("progress")?.({ loaded: 1048577 });
            throw new Error("Native request aborted");
          },
        },
      } as unknown as typeof Zotero;
      await failure(new AnysearchClient().search(search), "service");
      assert.isTrue(aborted);
      assert.equal(listeners.size, 0);
    }
  });

  it("fails closed when native anonymous-channel isolation is unavailable", async function () {
    let calls = 0;
    nativeGlobals.Components = undefined;
    globalThis.Zotero = {
      CookieSandbox: class {},
      HTTP: {
        request: async () => {
          calls++;
          throw new Error("Must not dispatch");
        },
      },
    } as unknown as typeof Zotero;
    await failure(new AnysearchClient().search(search), "network");
    assert.equal(calls, 0);
  });

  it("cancels an oversized fetch stream instead of buffering the whole response", async function () {
    let cancelled = false;
    let chunks = 0;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            chunks++;
            controller.enqueue(new Uint8Array(600000));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    await failure(new AnysearchClient().search(search), "network");
    assert.isTrue(cancelled);
    assert.isAtMost(chunks, 3);
  });

  it("rejects an oversized declared fetch response before reading it", async function () {
    let cancelled = false;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { "content-length": "1048577" } },
      )) as typeof fetch;
    await failure(new AnysearchClient().search(search), "network");
    assert.isTrue(cancelled);
  });
});
