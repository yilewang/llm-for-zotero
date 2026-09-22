import { assert } from "chai";
import {
  MAX_EMBEDDING_IMAGE_BYTES,
  embedItemsWithConfig,
  type EmbeddingClientDeps,
  type EmbeddingRequestConfig,
} from "../src/utils/embedding/client";
import {
  EmbeddingImageError,
  EmbeddingRequestError,
  type MultimodalItem,
} from "../src/utils/embedding/types";

type Call = {
  url: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
};

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function httpError(status: number, statusText: string, text: string): Response {
  return {
    ok: false,
    status,
    statusText,
    json: async () => ({}),
    text: async () => text,
  } as unknown as Response;
}

/** Echo fetch: every text "N" embeds to [N]; every image embeds to [99]. */
function echoFetch(calls: Call[]) {
  return async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: unknown[] };
    calls.push({ url, body, signal: init?.signal ?? undefined });
    return okJson({
      data: body.input.map((entry, index) => ({
        index,
        embedding: typeof entry === "string" ? [Number(entry)] : [99],
      })),
    });
  };
}

const text = (value: string): MultimodalItem => ({ kind: "text", text: value });
const image = (dataUrl = "data:image/png;base64,AAAA"): MultimodalItem => ({
  kind: "image",
  dataUrl,
});

function config(
  overrides: Partial<EmbeddingRequestConfig> = {},
): EmbeddingRequestConfig {
  return {
    apiBase: "https://api.example/v1",
    apiKey: "sk-test",
    model: "m",
    format: "openai_compat",
    limits: { maxItems: 16, maxImages: 4, concurrency: 1 },
    allowImages: true,
    ...overrides,
  };
}

function deps(
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
  overrides: Partial<EmbeddingClientDeps> = {},
): EmbeddingClientDeps {
  return {
    fetchFn: fetchFn as unknown as typeof fetch,
    buildHeaders: (apiKey) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    }),
    normalizeImage: async (dataUrl) => dataUrl,
    createAbortController: () => new AbortController(),
    ...overrides,
  };
}

describe("embedding client", function () {
  it("returns no vectors and sends nothing for no input", async function () {
    const calls: Call[] = [];
    assert.deepEqual(
      await embedItemsWithConfig([], config(), deps(echoFetch(calls))),
      [],
    );
    assert.lengthOf(calls, 0);
  });

  it("rejects image inputs when images are not allowed", async function () {
    const calls: Call[] = [];
    try {
      await embedItemsWithConfig(
        [text("1"), image()],
        config({ allowImages: false }),
        deps(echoFetch(calls)),
      );
      assert.fail("expected rejection");
    } catch (error) {
      assert.match((error as Error).message, /Image input is not enabled/);
    }
    assert.lengthOf(calls, 0);
  });

  it("batches requests and returns vectors in input order", async function () {
    const calls: Call[] = [];
    const vectors = await embedItemsWithConfig(
      [text("1"), text("2"), text("3")],
      config({ limits: { maxItems: 2, maxImages: 1, concurrency: 1 } }),
      deps(echoFetch(calls)),
    );
    assert.deepEqual(vectors, [[1], [2], [3]]);
    assert.lengthOf(calls, 2);
    assert.equal(calls[0].url, "https://api.example/v1/embeddings");
  });

  it("keeps input order when concurrent responses arrive out of order", async function () {
    const fetchFn = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      const value = Number(body.input[0]);
      await new Promise((resolve) => setTimeout(resolve, (4 - value) * 5));
      return okJson({ data: [{ index: 0, embedding: [value] }] });
    };
    const vectors = await embedItemsWithConfig(
      [text("1"), text("2"), text("3")],
      config({ limits: { maxItems: 1, maxImages: 1, concurrency: 3 } }),
      deps(fetchFn),
    );
    assert.deepEqual(vectors, [[1], [2], [3]]);
  });

  it("raises EmbeddingRequestError with a truncated body on HTTP errors", async function () {
    const longBody = "x".repeat(600);
    try {
      await embedItemsWithConfig(
        [text("1")],
        config(),
        deps(async () => httpError(400, "Bad Request", longBody)),
      );
      assert.fail("expected rejection");
    } catch (error) {
      assert.instanceOf(error, EmbeddingRequestError);
      const requestError = error as EmbeddingRequestError;
      assert.equal(requestError.status, 400);
      assert.lengthOf(requestError.body, 500);
      assert.isTrue(requestError.message.startsWith("400 Bad Request - "));
    }
  });

  it("stops scheduling batches after the first failure", async function () {
    let count = 0;
    const fetchFn = async () => {
      count += 1;
      return httpError(500, "Server Error", "boom");
    };
    try {
      await embedItemsWithConfig(
        [text("1"), text("2"), text("3")],
        config({ limits: { maxItems: 1, maxImages: 1, concurrency: 1 } }),
        deps(fetchFn),
      );
      assert.fail("expected rejection");
    } catch (error) {
      assert.instanceOf(error, EmbeddingRequestError);
    }
    assert.equal(count, 1);
  });

  it("aborts in-flight requests when another batch fails", async function () {
    const signals: AbortSignal[] = [];
    const fetchFn = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      if (init?.signal) signals.push(init.signal);
      if (body.input[0] === "1") return httpError(500, "Server Error", "boom");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return okJson({ data: [{ index: 0, embedding: [2] }] });
    };
    try {
      await embedItemsWithConfig(
        [text("1"), text("2")],
        config({ limits: { maxItems: 1, maxImages: 1, concurrency: 2 } }),
        deps(fetchFn),
      );
      assert.fail("expected rejection");
    } catch (error) {
      assert.instanceOf(error, EmbeddingRequestError);
    }
    assert.lengthOf(signals, 2);
    assert.isTrue(signals.every((signal) => signal.aborted));
  });

  it("rejects a response whose vector count does not match the batch", async function () {
    const fetchFn = async () =>
      okJson({ data: [{ index: 0, embedding: [1] }] });
    try {
      await embedItemsWithConfig(
        [text("1"), text("2")],
        config(),
        deps(fetchFn),
      );
      assert.fail("expected rejection");
    } catch (error) {
      assert.match((error as Error).message, /returned 1 vectors for 2 inputs/);
    }
  });

  it("rejects an empty vector", async function () {
    const fetchFn = async () => okJson({ data: [{ index: 0, embedding: [] }] });
    try {
      await embedItemsWithConfig([text("1")], config(), deps(fetchFn));
      assert.fail("expected rejection");
    } catch (error) {
      assert.match((error as Error).message, /empty vector/);
    }
  });

  it("rejects vectors of different dimensions", async function () {
    const fetchFn = async () =>
      okJson({
        data: [
          { index: 0, embedding: [1, 2] },
          { index: 1, embedding: [3] },
        ],
      });
    try {
      await embedItemsWithConfig(
        [text("1"), text("2")],
        config(),
        deps(fetchFn),
      );
      assert.fail("expected rejection");
    } catch (error) {
      assert.match((error as Error).message, /dimensions differ/);
    }
  });

  it("sends the normalized image instead of the original", async function () {
    const calls: Call[] = [];
    await embedItemsWithConfig(
      [image("data:image/png;base64,ORIGINAL")],
      config(),
      deps(echoFetch(calls), {
        normalizeImage: async () => "data:image/jpeg;base64,SMALL",
      }),
    );
    assert.deepEqual(calls[0].body.input, [
      { image: "data:image/jpeg;base64,SMALL" },
    ]);
  });

  it("raises EmbeddingImageError when normalization yields no image data URL", async function () {
    try {
      await embedItemsWithConfig(
        [text("1"), image()],
        config(),
        deps(echoFetch([]), { normalizeImage: async () => "not-an-image" }),
      );
      assert.fail("expected rejection");
    } catch (error) {
      assert.instanceOf(error, EmbeddingImageError);
      assert.equal((error as EmbeddingImageError).itemIndex, 1);
    }
  });

  it("raises EmbeddingImageError when the image stays above 4 MB", async function () {
    const huge = `data:image/png;base64,${"A".repeat(
      Math.ceil((MAX_EMBEDDING_IMAGE_BYTES * 4) / 3) + 8,
    )}`;
    try {
      await embedItemsWithConfig([image(huge)], config(), deps(echoFetch([])));
      assert.fail("expected rejection");
    } catch (error) {
      assert.instanceOf(error, EmbeddingImageError);
      assert.equal((error as EmbeddingImageError).itemIndex, 0);
    }
  });
});
