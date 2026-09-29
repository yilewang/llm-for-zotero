import { assert } from "chai";
import {
  callEmbeddings,
  embedItems,
  embedItemsForCapabilityTest,
  fetchEmbeddingModelCatalog,
  getResolvedEmbeddingConfig,
  isImageEmbeddingEnabled,
} from "../src/utils/llmClient";

const PREFIX = "extensions.zotero.llmforzotero";
const API_BASE = "https://api.siliconflow.cn/v1";
const PNG = "data:image/png;base64,AAAA";

type Call = { url: string; init?: RequestInit };

describe("llmClient multimodal embeddings", function () {
  const originalZotero = globalThis.Zotero;
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;
  let prefStore: Map<string, unknown>;
  let calls: Call[];

  function setPref(key: string, value: unknown) {
    prefStore.set(`${PREFIX}.${key}`, value);
  }

  function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) =>
        name === "fetch"
          ? async (url: string, init?: RequestInit) => {
              calls.push({ url, init });
              return handler(url, init);
            }
          : undefined,
      log: () => undefined,
    };
  }

  function echoEmbeddings() {
    mockFetch((_url, init) => {
      const body = JSON.parse(String(init?.body)) as { input?: unknown[] };
      const input = body.input || [null];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: input.map((_, index) => ({ index, embedding: [index + 1, 0] })),
        }),
        text: async () => "",
      };
    });
  }

  beforeEach(function () {
    prefStore = new Map<string, unknown>();
    calls = [];
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
    setPref("embeddingProvider", "custom");
    setPref("embeddingApiBase", API_BASE);
    setPref("embeddingApiKey", "sk-test");
    setPref("embeddingModel", "Qwen/Qwen3-VL-Embedding-8B");
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
      originalToolkit;
  });

  it("sends a text request byte-identical to the legacy client", async function () {
    echoEmbeddings();
    await callEmbeddings(["a", "b"]);
    assert.lengthOf(calls, 1);
    assert.equal(calls[0].url, `${API_BASE}/embeddings`);
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(
      calls[0].init?.body,
      JSON.stringify({
        model: "Qwen/Qwen3-VL-Embedding-8B",
        input: ["a", "b"],
      }),
    );
    assert.deepEqual(calls[0].init?.headers, {
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test",
    });
  });

  it("splits 20 texts into sequential requests of 16 and 4", async function () {
    echoEmbeddings();
    const vectors = await callEmbeddings(
      Array.from({ length: 20 }, (_, i) => `t${i}`),
    );
    assert.lengthOf(vectors, 20);
    assert.deepEqual(
      calls.map(
        (call) =>
          (JSON.parse(String(call.init?.body)) as { input: unknown[] }).input
            .length,
      ),
      [16, 4],
    );
  });

  it("rejects images while image support is off", async function () {
    echoEmbeddings();
    try {
      await embedItems([{ kind: "image", dataUrl: PNG }]);
      assert.fail("expected rejection");
    } catch (error) {
      assert.match((error as Error).message, /Image input is not enabled/);
    }
    assert.lengthOf(calls, 0);
    assert.isFalse(isImageEmbeddingEnabled());
  });

  it("sends images once image support is on", async function () {
    setPref("embeddingSupportsImages", "on");
    echoEmbeddings();
    await embedItems([
      { kind: "text", text: "a" },
      { kind: "image", dataUrl: PNG },
    ]);
    assert.deepEqual(
      (JSON.parse(String(calls[0].init?.body)) as { input: unknown[] }).input,
      ["a", { image: PNG }],
    );
    assert.isTrue(isImageEmbeddingEnabled());
  });

  it("keeps the provider key unless a non-OpenAI format is in use", function () {
    const before = getResolvedEmbeddingConfig().providerKey;
    setPref("embeddingSupportsImages", "on");
    assert.equal(getResolvedEmbeddingConfig().providerKey, before);
    setPref("embeddingRequestFormat", "dashscope");
    assert.equal(
      getResolvedEmbeddingConfig().providerKey,
      `${before}:fmt=dashscope`,
    );
  });

  it("lets the capability test force a format and send images", async function () {
    mockFetch(() => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ data: [{ index: 0, embedding: [1, 2] }] }),
      text: async () => "",
    }));
    await embedItemsForCapabilityTest(
      [{ kind: "image", dataUrl: PNG }],
      "vllm_messages",
    );
    const body = JSON.parse(String(calls[0].init?.body)) as {
      messages: Array<{ content: unknown[] }>;
    };
    assert.deepEqual(body.messages[1].content, [
      { type: "image_url", image_url: { url: PNG } },
    ]);
  });

  it("reads the model catalog from {apiBase}/models", async function () {
    mockFetch(() => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        data: [{ id: "Qwen/Qwen3-VL-Embedding-8B", owned_by: "vllm" }],
      }),
      text: async () => "",
    }));
    const models = await fetchEmbeddingModelCatalog();
    assert.equal(calls[0].url, `${API_BASE}/models`);
    assert.equal(calls[0].init?.method, "GET");
    assert.equal(models[0].ownedBy, "vllm");
  });
});
