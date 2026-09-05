import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "mocha";
import { createExternalBackendBridgeRuntime } from "../src/agent/externalBackendBridge";

function createRuntime() {
  return createExternalBackendBridgeRuntime({
    coreRuntime: {
      listTools: () => [],
      getToolDefinition: () => null,
      unregisterTool: () => undefined,
      registerTool: () => undefined,
      registerPendingConfirmation: () => undefined,
      resolveConfirmation: () => false,
      getRunTrace: () => [],
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: true,
        fileInputs: true,
        reasoning: true,
      }),
      runTurn: async () => ({
        kind: "fallback",
        runId: "unused",
        reason: "unused",
        usedFallback: true,
      }),
    } as any,
    getBridgeUrl: () => "http://127.0.0.1:19787",
  });
}

describe("external bridge model catalog", function () {
  const originalFetch = globalThis.fetch;
  const originalZotero = globalThis.Zotero;
  let configSource = "default";

  beforeEach(function () {
    configSource = "default";
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get(key: string) {
          if (key.endsWith("enableClaudeCodeMode")) return true;
          if (key.endsWith("conversationSystem")) return "claude_code";
          if (key.endsWith("agentClaudeConfigSource")) return configSource;
          return "";
        },
      },
      Profile: { dir: "/tmp/llm-for-zotero-model-catalog-test" },
    } as typeof Zotero;
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("caches the catalog and invalidates it for settings identity changes", async function () {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          models: ["default", "FutureModel-V7[2m]"],
          modelInfos: [
            { value: "default", displayName: "Default" },
            {
              value: "FutureModel-V7[2m]",
              displayName: "Future Model",
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;
    const runtime = createRuntime();

    const first = await runtime.listModels();
    const second = await runtime.listModels();
    await runtime.listModels(true);
    configSource = "user-only";
    await runtime.listModels();

    assert.deepEqual(
      first.models.map((model) => model.value),
      ["default", "FutureModel-V7[2m]"],
    );
    assert.deepEqual(second, first);
    assert.lengthOf(urls, 3);
    assert.include(urls[0], "settingSources=user%2Cproject%2Clocal");
    assert.include(urls[1], "refresh=1");
    assert.include(urls[2], "settingSources=user");
  });

  it("keys effort discovery by the exact opaque model value", async function () {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ efforts: ["high"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const runtime = createRuntime();

    await runtime.listEfforts("FutureModel");
    await runtime.listEfforts("futuremodel");
    await runtime.listEfforts("FutureModel");

    assert.lengthOf(urls, 2);
    assert.include(urls[0], "model=FutureModel");
    assert.include(urls[1], "model=futuremodel");
  });

  it("forwards conversation scope to effort discovery and caches it per scope", async function () {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ efforts: ["high"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const runtime = createRuntime();
    const firstContext = {
      conversationKey: 42,
      scopeType: "paper" as const,
      scopeId: "profile-test:1:42",
      scopeLabel: "Paper 42",
    };
    const secondContext = {
      conversationKey: 43,
      scopeType: "paper" as const,
      scopeId: "profile-test:1:43",
      scopeLabel: "Paper 43",
    };

    await runtime.listEfforts("ScopedFutureModel", firstContext);
    await runtime.listEfforts("ScopedFutureModel", secondContext);
    await runtime.listEfforts("ScopedFutureModel", firstContext);

    assert.lengthOf(urls, 2);
    assert.include(urls[0], "conversationKey=42");
    assert.include(urls[0], "scopeId=profile-test%3A1%3A42");
    assert.include(urls[0], "scopeLabel=Paper+42");
    assert.include(urls[1], "conversationKey=43");
    assert.include(urls[1], "scopeId=profile-test%3A1%3A43");
  });

  it("caches model catalogs separately for each conversation scope", async function () {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          models: ["default"],
          modelInfos: [{ value: "default", displayName: "Default" }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;
    const runtime = createRuntime();
    const firstContext = {
      conversationKey: 42,
      scopeType: "paper" as const,
      scopeId: "profile-test:1:42",
    };
    const secondContext = {
      conversationKey: 43,
      scopeType: "paper" as const,
      scopeId: "profile-test:1:43",
    };

    await runtime.listModels(false, firstContext);
    await runtime.listModels(false, firstContext);
    await runtime.listModels(false, secondContext);

    assert.lengthOf(urls, 2);
    assert.include(urls[0], "conversationKey=42");
    assert.include(urls[0], "scopeId=profile-test%3A1%3A42");
    assert.include(urls[1], "conversationKey=43");
    assert.include(urls[1], "scopeId=profile-test%3A1%3A43");
  });

  it("does not let an older catalog response overwrite a forced refresh", async function () {
    const urls: string[] = [];
    let resolveOlder!: (response: Response) => void;
    let resolveForced!: (response: Response) => void;
    const olderResponse = new Promise<Response>((resolve) => {
      resolveOlder = resolve;
    });
    const forcedResponse = new Promise<Response>((resolve) => {
      resolveForced = resolve;
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return urls.length === 1 ? olderResponse : forcedResponse;
    }) as typeof fetch;
    const runtime = createRuntime();

    const olderRequest = runtime.listModels();
    const forcedRequest = runtime.listModels(true);
    resolveForced(
      new Response(
        JSON.stringify({
          models: ["FreshModel"],
          modelInfos: [{ value: "FreshModel" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    assert.deepEqual(
      (await forcedRequest).models.map((model) => model.value),
      ["FreshModel"],
    );
    resolveOlder(
      new Response(
        JSON.stringify({
          models: ["StaleModel"],
          modelInfos: [{ value: "StaleModel" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await olderRequest;

    assert.deepEqual(
      (await runtime.listModels()).models.map((model) => model.value),
      ["FreshModel"],
    );
    assert.lengthOf(urls, 2);
    assert.include(urls[1], "refresh=1");
  });

  it("reuses an in-flight forced refresh for a concurrent forced request", async function () {
    const urls: string[] = [];
    let resolveFetch!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return pending.then((response) => response.clone());
    }) as typeof fetch;
    const runtime = createRuntime();

    const first = runtime.listModels(true);
    const second = runtime.listModels(true);
    resolveFetch(
      new Response(
        JSON.stringify({
          models: ["FreshModel"],
          modelInfos: [{ value: "FreshModel" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    assert.deepEqual(
      (await first).models.map((model) => model.value),
      ["FreshModel"],
    );
    assert.deepEqual(
      (await second).models.map((model) => model.value),
      ["FreshModel"],
    );
    assert.lengthOf(
      urls,
      1,
      "concurrent forced requests must share one bridge fetch",
    );
    assert.include(urls[0], "refresh=1");
  });

  it("does not satisfy a forced refresh with an in-flight unforced fetch", async function () {
    const urls: string[] = [];
    const resolvers: Array<(response: Response) => void> = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Promise<Response>((resolve) => {
        resolvers.push(resolve);
      });
    }) as typeof fetch;
    const runtime = createRuntime();

    const unforced = runtime.listModels();
    const forced = runtime.listModels(true);
    for (const [index, resolve] of resolvers.entries()) {
      resolve(
        new Response(
          JSON.stringify({
            models: [index === 0 ? "CachedModel" : "FreshModel"],
            modelInfos: [{ value: index === 0 ? "CachedModel" : "FreshModel" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    await unforced;

    assert.deepEqual(
      (await forced).models.map((model) => model.value),
      ["FreshModel"],
      "the forced caller must get bridge-cache-busting data",
    );
    assert.lengthOf(urls, 2);
    assert.notInclude(urls[0], "refresh=1");
    assert.include(urls[1], "refresh=1");
  });

  it("clears every capability cache through the single shared reset helper", function () {
    const source = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "src/agent/externalBackendBridge.ts",
      ),
      "utf8",
    );
    assert.include(source, "const resetCapabilityCaches = ");
    assert.lengthOf(source.match(/cachedModelCatalog = null;/g) ?? [], 1);
    assert.lengthOf(
      source.match(/lastCapabilityConfigKey = configKey;/g) ?? [],
      0,
    );
  });
});
