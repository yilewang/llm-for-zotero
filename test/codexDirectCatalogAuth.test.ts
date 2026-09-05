import { assert } from "chai";
import {
  CODEX_DIRECT_MODELS_URL,
  CODEX_DIRECT_RESPONSES_URL,
  fetchWithCodexAuth,
  refreshCodexAuthSession,
  resetCodexAuthRefreshStateForTests,
} from "../src/codexAuth/auth";
import {
  assertCodexDirectModelAvailable,
  getCodexDirectReasoningChoices,
  loadCodexDirectCatalog,
  normalizeCodexDirectCatalog,
  resetCodexDirectCatalogForTests,
} from "../src/codexAuth/modelCatalog";
import { runCodexDirectConnectionTest } from "../src/utils/providerConnectionTest";

const AUTH_JSON = JSON.stringify({
  preserved: { keep: true },
  tokens: {
    access_token: "access-old",
    refresh_token: "refresh-old",
    account_id: "account-123",
  },
});
const TEST_AUTH_PATH = "/test/codex/auth.json";

function catalogResponse(model = "gpt-codex"): Response {
  return new Response(
    JSON.stringify({
      models: [
        {
          slug: model,
          display_name: "GPT Codex",
          description: "Coding model",
          visibility: "list",
          priority: 10,
          context_window: 200000,
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low", description: "Faster" },
            { effort: "medium", description: "Balanced" },
            { effort: "ultra", description: "Hidden in direct mode" },
          ],
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("Codex Direct auth and catalog", function () {
  beforeEach(function () {
    resetCodexDirectCatalogForTests();
    resetCodexAuthRefreshStateForTests();
  });

  afterEach(function () {
    resetCodexDirectCatalogForTests();
    resetCodexAuthRefreshStateForTests();
  });

  it("normalizes visible ChatGPT models, priority, metadata, and stable ties", function () {
    const models = normalizeCodexDirectCatalog({
      models: [
        {
          slug: "tie-first",
          display_name: "Tie First",
          visibility: "list",
          priority: 10,
          supported_in_api: false,
          context_window: 128000,
          default_reasoning_level: "high",
          supported_reasoning_levels: [
            { effort: "high", description: "Thorough" },
          ],
        },
        {
          slug: "TIE-FIRST",
          display_name: "Duplicate",
          visibility: "list",
          priority: 100,
        },
        {
          slug: "tie-second",
          display_name: "Tie Second",
          visibility: "list",
          priority: 10,
          supported_reasoning_levels: ["low"],
        },
        {
          slug: "highest",
          display_name: "Highest",
          visibility: "list",
          priority: 20,
          supported_reasoning_levels: [],
        },
        {
          slug: "hidden",
          display_name: "Hidden",
          visibility: "hide",
          priority: 99,
        },
      ],
    });

    assert.deepEqual(
      models.map((model) => model.model),
      ["highest", "tie-first", "tie-second"],
    );
    assert.equal(models[1].displayName, "Tie First");
    assert.equal(models[1].contextWindow, 128000);
    assert.equal(
      models[1].supportedReasoningEfforts[0].description,
      "Thorough",
    );
    assert.equal(models[2].supportedReasoningEfforts[0].value, "low");
  });

  it("uses the fixed catalog endpoint and filters Ultra from direct choices", async function () {
    let requestedUrl = "";
    const snapshot = await loadCodexDirectCatalog({
      authPath: TEST_AUTH_PATH,
      readText: async () => AUTH_JSON,
      fetchFn: (async (url: string | URL | Request) => {
        requestedUrl = String(url);
        return catalogResponse();
      }) as typeof fetch,
    });

    assert.equal(requestedUrl, CODEX_DIRECT_MODELS_URL);
    assert.equal(snapshot.models[0].contextWindow, 200000);
    assert.deepEqual(getCodexDirectReasoningChoices("GPT-CODEX"), [
      { value: "auto", label: "Auto (Medium)" },
      { value: "low", label: "Low", description: "Faster" },
      { value: "medium", label: "Medium", description: "Balanced" },
    ]);
    assert.throws(
      () => assertCodexDirectModelAvailable("saved-missing"),
      "not available in the current catalog",
    );
  });

  it("sends account auth, refreshes once on 401, and preserves auth fields", async function () {
    const writes: string[] = [];
    const backendHeaders: Headers[] = [];
    let backendCalls = 0;
    const response = await fetchWithCodexAuth(
      CODEX_DIRECT_RESPONSES_URL,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      {
        authPath: TEST_AUTH_PATH,
        readText: async () => AUTH_JSON,
        writeText: async (_path, content) => writes.push(content),
        fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
          if (String(url) === "https://auth.openai.com/oauth/token") {
            return new Response(
              JSON.stringify({
                access_token: "access-new",
                refresh_token: "refresh-new",
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          backendCalls += 1;
          backendHeaders.push(new Headers(init?.headers));
          return new Response(backendCalls === 1 ? "unauthorized" : "ok", {
            status: backendCalls === 1 ? 401 : 200,
          });
        }) as typeof fetch,
      },
    );

    assert.equal(response.status, 200);
    assert.equal(backendCalls, 2);
    assert.equal(backendHeaders[0].get("Authorization"), "Bearer access-old");
    assert.equal(backendHeaders[1].get("Authorization"), "Bearer access-new");
    assert.equal(backendHeaders[1].get("ChatGPT-Account-ID"), "account-123");
    assert.lengthOf(writes, 1);
    const persisted = JSON.parse(writes[0]) as Record<string, unknown>;
    assert.deepEqual(persisted.preserved, { keep: true });
    assert.include(writes[0], "refresh-new");
  });

  it("coalesces concurrent 401 refreshes per auth file", async function () {
    let authFile = AUTH_JSON;
    let oauthCalls = 0;
    let writes = 0;
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchFn = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(url) === "https://auth.openai.com/oauth/token") {
        oauthCalls += 1;
        await refreshGate;
        return new Response(
          JSON.stringify({
            access_token: "access-shared",
            refresh_token: "refresh-shared",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      const token = new Headers(init?.headers).get("Authorization");
      return new Response(token === "Bearer access-old" ? "old" : "ok", {
        status: token === "Bearer access-old" ? 401 : 200,
      });
    }) as typeof fetch;
    const options = {
      authPath: TEST_AUTH_PATH,
      readText: async () => authFile,
      writeText: async (_path: string, content: string) => {
        writes += 1;
        authFile = content;
      },
      fetchFn,
    };

    const first = fetchWithCodexAuth(CODEX_DIRECT_RESPONSES_URL, {}, options);
    const second = fetchWithCodexAuth(CODEX_DIRECT_RESPONSES_URL, {}, options);
    await Promise.resolve();
    releaseRefresh?.();
    const responses = await Promise.all([first, second]);

    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200],
    );
    assert.equal(oauthCalls, 1);
    assert.equal(writes, 1);
    assert.include(authFile, "access-shared");
  });

  it("does not let one caller cancel a shared authentication refresh", async function () {
    const controller = new AbortController();
    let oauthSignal: AbortSignal | null | undefined;
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const options = {
      authPath: TEST_AUTH_PATH,
      readText: async () => AUTH_JSON,
      writeText: async () => undefined,
      fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
        oauthSignal = init?.signal;
        await refreshGate;
        return new Response(
          JSON.stringify({ access_token: "access-after-cancel" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch,
    };
    const session = {
      token: "access-old",
      refreshToken: "refresh-old",
      authPath: TEST_AUTH_PATH,
    };

    const cancelledCaller = refreshCodexAuthSession(session, {
      ...options,
      signal: controller.signal,
    });
    const otherCaller = refreshCodexAuthSession(session, options);
    controller.abort();
    releaseRefresh?.();

    const [first, second] = await Promise.all([cancelledCaller, otherCaller]);
    assert.equal(first.token, "access-after-cancel");
    assert.equal(second.token, "access-after-cancel");
    assert.isUndefined(oauthSignal);
  });

  it("reuses a completed refresh when a second stale 401 arrives late", async function () {
    let authFile = AUTH_JSON;
    let oauthCalls = 0;
    let oldBackendCalls = 0;
    let releaseLate401: (() => void) | undefined;
    const refreshWritten = new Promise<void>((resolve) => {
      releaseLate401 = resolve;
    });
    const fetchFn = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(url) === "https://auth.openai.com/oauth/token") {
        oauthCalls += 1;
        return new Response(
          JSON.stringify({ access_token: "access-new-late" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      const token = new Headers(init?.headers).get("Authorization");
      if (token === "Bearer access-old") {
        oldBackendCalls += 1;
        if (oldBackendCalls === 2) await refreshWritten;
        return new Response("old", { status: 401 });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const options = {
      authPath: TEST_AUTH_PATH,
      readText: async () => authFile,
      writeText: async (_path: string, content: string) => {
        authFile = content;
        releaseLate401?.();
      },
      fetchFn,
    };

    const responses = await Promise.all([
      fetchWithCodexAuth(CODEX_DIRECT_RESPONSES_URL, {}, options),
      fetchWithCodexAuth(CODEX_DIRECT_RESPONSES_URL, {}, options),
    ]);

    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200],
    );
    assert.equal(oauthCalls, 1);
  });

  it("uses an atomic temporary path for production auth writes", async function () {
    const globalWithIO = globalThis as typeof globalThis & {
      IOUtils?: unknown;
    };
    const previousIO = globalWithIO.IOUtils;
    let writeOptions: { tmpPath?: string } | undefined;
    globalWithIO.IOUtils = {
      read: async () => new Uint8Array(),
      makeDirectory: async () => undefined,
      write: async (
        _path: string,
        _data: Uint8Array,
        options?: { tmpPath?: string },
      ) => {
        writeOptions = options;
      },
    };
    try {
      await refreshCodexAuthSession(
        {
          token: "access-old",
          refreshToken: "refresh-old",
          authPath: TEST_AUTH_PATH,
        },
        {
          readText: async () => AUTH_JSON,
          fetchFn: (async () =>
            new Response(JSON.stringify({ access_token: "atomic-new" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })) as typeof fetch,
        },
      );
      assert.equal(
        writeOptions?.tmpPath,
        `${TEST_AUTH_PATH}.llm-for-zotero.tmp`,
      );
    } finally {
      if (previousIO === undefined) delete globalWithIO.IOUtils;
      else globalWithIO.IOUtils = previousIO;
    }
  });

  it("keeps different auth files independent and clears failed refreshes", async function () {
    let oauthCalls = 0;
    const makeSession = (authPath: string) => ({
      token: "access-old",
      refreshToken: "refresh-old",
      authPath,
    });
    const successOptions = {
      readText: async () => AUTH_JSON,
      writeText: async () => undefined,
      fetchFn: (async () => {
        oauthCalls += 1;
        return new Response(
          JSON.stringify({ access_token: `access-${oauthCalls}` }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch,
    };

    await Promise.all([
      refreshCodexAuthSession(makeSession("/test/a/auth.json"), successOptions),
      refreshCodexAuthSession(makeSession("/test/b/auth.json"), successOptions),
    ]);
    assert.equal(oauthCalls, 2);

    let attempts = 0;
    const retryOptions = {
      readText: async () => AUTH_JSON,
      writeText: async () => undefined,
      fetchFn: (async () => {
        attempts += 1;
        return attempts === 1
          ? new Response("failed", { status: 500 })
          : new Response(JSON.stringify({ access_token: "retry-ok" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
      }) as typeof fetch,
    };
    try {
      await refreshCodexAuthSession(
        makeSession("/test/retry/auth.json"),
        retryOptions,
      );
      assert.fail("expected the first refresh to fail");
    } catch (error) {
      assert.include(String(error), "Codex token refresh failed");
    }
    const retried = await refreshCodexAuthSession(
      makeSession("/test/retry/auth.json"),
      retryOptions,
    );
    assert.equal(retried.token, "retry-ok");
    assert.equal(attempts, 2);
  });

  it("refuses to send Codex credentials to configurable origins", async function () {
    try {
      await fetchWithCodexAuth(
        "https://example.com/v1/responses",
        {},
        {
          readText: async () => AUTH_JSON,
          fetchFn: (async () => new Response("never")) as typeof fetch,
        },
      );
      assert.fail("expected untrusted URL rejection");
    } catch (error) {
      assert.include(String(error), "untrusted URL");
    }
  });

  it("caches successful results, coalesces requests, and force refreshes", async function () {
    let fetchCalls = 0;
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchFn = (async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) await firstGate;
      return catalogResponse(`model-${fetchCalls}`);
    }) as typeof fetch;
    const options = {
      authPath: TEST_AUTH_PATH,
      readText: async () => AUTH_JSON,
      fetchFn,
      now: () => 1000,
    };

    const first = loadCodexDirectCatalog(options);
    const concurrent = loadCodexDirectCatalog(options);
    releaseFirst?.();
    const [firstResult, concurrentResult] = await Promise.all([
      first,
      concurrent,
    ]);
    assert.equal(fetchCalls, 1);
    assert.equal(firstResult.models[0].model, concurrentResult.models[0].model);

    await loadCodexDirectCatalog({ ...options, now: () => 2000 });
    assert.equal(fetchCalls, 1);
    const forced = await loadCodexDirectCatalog({ ...options, force: true });
    assert.equal(fetchCalls, 2);
    assert.equal(forced.models[0].model, "model-2");
  });

  it("reports timeouts and preserves a successful empty-catalog state", async function () {
    try {
      await loadCodexDirectCatalog({
        authPath: TEST_AUTH_PATH,
        readText: async () => AUTH_JSON,
        fetchFn: (async () =>
          new Promise<Response>(() => undefined)) as typeof fetch,
        timeoutMs: 1,
      });
      assert.fail("expected timeout");
    } catch (error) {
      assert.include(String(error), "timed out");
    }

    resetCodexDirectCatalogForTests();
    const empty = await loadCodexDirectCatalog({
      authPath: TEST_AUTH_PATH,
      readText: async () => AUTH_JSON,
      fetchFn: (async () =>
        new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch,
    });
    assert.equal(empty.status, "ready");
    assert.deepEqual(empty.models, []);
  });

  it("tests the catalog and a minimal Auto-reasoning inference separately", async function () {
    let inferenceBody: Record<string, unknown> | undefined;
    const result = await runCodexDirectConnectionTest({
      authPath: TEST_AUTH_PATH,
      readText: async () => AUTH_JSON,
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === CODEX_DIRECT_MODELS_URL) return catalogResponse();
        inferenceBody = JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
        return new Response('data: {"delta":"OK"}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as typeof fetch,
    });

    assert.deepEqual(result, {
      catalogCount: 1,
      modelName: "gpt-codex",
      reply: "OK",
    });
    assert.equal(inferenceBody?.model, "gpt-codex");
    for (const key of [
      "reasoning",
      "temperature",
      "max_output_tokens",
      "tools",
    ]) {
      assert.notProperty(inferenceBody || {}, key);
    }
  });

  it("tests the model belonging to the selected Direct row", async function () {
    let inferenceModel = "";
    const result = await runCodexDirectConnectionTest({
      authPath: TEST_AUTH_PATH,
      modelName: "second-model",
      readText: async () => AUTH_JSON,
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === CODEX_DIRECT_MODELS_URL) {
          return new Response(
            JSON.stringify({
              models: [
                {
                  slug: "first-model",
                  display_name: "First",
                  visibility: "list",
                  priority: 10,
                },
                {
                  slug: "second-model",
                  display_name: "Second",
                  visibility: "list",
                  priority: 1,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        inferenceModel = String(
          (JSON.parse(String(init?.body || "{}")) as { model?: unknown })
            .model || "",
        );
        return new Response('data: {"delta":"SECOND"}\n\n', {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as typeof fetch,
    });

    assert.deepEqual(result, {
      catalogCount: 2,
      modelName: "second-model",
      reply: "SECOND",
    });
    assert.equal(inferenceModel, "second-model");
  });

  it("reports catalog success without testing an unavailable saved row", async function () {
    let inferenceCalls = 0;
    const result = await runCodexDirectConnectionTest({
      authPath: TEST_AUTH_PATH,
      modelName: "saved-missing",
      readText: async () => AUTH_JSON,
      fetchFn: (async (url: string | URL | Request) => {
        if (String(url) === CODEX_DIRECT_MODELS_URL) return catalogResponse();
        inferenceCalls += 1;
        return new Response("never", { status: 200 });
      }) as typeof fetch,
    });

    assert.deepEqual(result, {
      catalogCount: 1,
      modelName: "saved-missing",
      inferenceError:
        "The selected Codex Direct model is not available in the current catalog.",
    });
    assert.equal(inferenceCalls, 0);
  });

  it("reports successful HTTP responses with no parsed model text as inference failures", async function () {
    for (const raw of [
      "",
      "   \n",
      "data: [DONE]\n\n",
      'data: {"response":{"output":[]}}\n\ndata: [DONE]\n\n',
      '{"status":"completed","output":[]}',
    ]) {
      resetCodexDirectCatalogForTests();
      const result = await runCodexDirectConnectionTest({
        authPath: TEST_AUTH_PATH,
        readText: async () => AUTH_JSON,
        fetchFn: (async (url: string | URL | Request) =>
          String(url) === CODEX_DIRECT_MODELS_URL
            ? catalogResponse()
            : new Response(raw, { status: 200 })) as typeof fetch,
      });
      assert.deepEqual(result, {
        catalogCount: 1,
        modelName: "gpt-codex",
        inferenceError: "The server returned no model output.",
      });
    }
  });
});
