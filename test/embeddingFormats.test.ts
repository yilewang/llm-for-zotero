import { assert } from "chai";
import { getEmbeddingFormatAdapter } from "../src/utils/embedding/formats";
import { resolveDashscopeEmbeddingUrl } from "../src/utils/embedding/formats/dashscope";
import { VLLM_EMBEDDING_INSTRUCTION } from "../src/utils/embedding/formats/vllmMessages";
import type { MultimodalItem } from "../src/utils/embedding/types";

const PNG = "data:image/png;base64,AAAA";
const text = (value: string): MultimodalItem => ({ kind: "text", text: value });
const image = (dataUrl = PNG): MultimodalItem => ({ kind: "image", dataUrl });

describe("embedding format adapters", function () {
  describe("openai_compat", function () {
    const adapter = getEmbeddingFormatAdapter("openai_compat");

    it("posts to {apiBase}/embeddings", function () {
      assert.equal(
        adapter.resolveUrl("https://api.siliconflow.cn/v1"),
        "https://api.siliconflow.cn/v1/embeddings",
      );
    });

    it("serializes text-only input exactly like the legacy request", function () {
      assert.equal(
        JSON.stringify(adapter.buildBody("m", [text("a"), text("b")])),
        JSON.stringify({ model: "m", input: ["a", "b"] }),
      );
    });

    it("sends images as {image} objects mixed with strings", function () {
      assert.deepEqual(adapter.buildBody("m", [text("a"), image()]), {
        model: "m",
        input: ["a", { image: PNG }],
      });
    });

    it("orders vectors by index when every row has one", function () {
      assert.deepEqual(
        adapter.parseResponse({
          data: [
            { index: 1, embedding: [2] },
            { index: 0, embedding: [1] },
          ],
        }),
        [[1], [2]],
      );
    });

    it("keeps response order when indexes are missing", function () {
      assert.deepEqual(
        adapter.parseResponse({
          data: [{ embedding: [2] }, { embedding: [1] }],
        }),
        [[2], [1]],
      );
    });

    it("returns no vectors for a response without data", function () {
      assert.deepEqual(adapter.parseResponse({}), []);
    });

    it("defaults to the legacy batch size and sequential requests", function () {
      assert.deepEqual(adapter.defaults, {
        maxItems: 16,
        maxImages: 4,
        concurrency: 1,
      });
    });
  });

  describe("dashscope", function () {
    const adapter = getEmbeddingFormatAdapter("dashscope");
    const path =
      "/services/embeddings/multimodal-embedding/multimodal-embedding";

    it("appends the multimodal path to an /api/v1 base", function () {
      assert.equal(
        resolveDashscopeEmbeddingUrl("https://dashscope.aliyuncs.com/api/v1/"),
        `https://dashscope.aliyuncs.com/api/v1${path}`,
      );
    });

    it("adds /api/v1 to a bare host", function () {
      assert.equal(
        resolveDashscopeEmbeddingUrl("https://dashscope.aliyuncs.com"),
        `https://dashscope.aliyuncs.com/api/v1${path}`,
      );
    });

    it("keeps a full endpoint URL unchanged", function () {
      const full = `https://dashscope.aliyuncs.com/api/v1${path}`;
      assert.equal(resolveDashscopeEmbeddingUrl(full), full);
    });

    it("wraps inputs in input.contents without fusion", function () {
      assert.deepEqual(
        adapter.buildBody("qwen3-vl-embedding", [text("a"), image()]),
        {
          model: "qwen3-vl-embedding",
          input: { contents: [{ text: "a" }, { image: PNG }] },
        },
      );
    });

    it("reads output.embeddings in index order", function () {
      assert.deepEqual(
        adapter.parseResponse({
          output: {
            embeddings: [
              { index: 1, embedding: [2], type: "image" },
              { index: 0, embedding: [1], type: "text" },
            ],
          },
        }),
        [[1], [2]],
      );
    });

    it("uses the documented 20-input / 5-image limits", function () {
      assert.deepEqual(adapter.hardLimits, { maxItems: 20, maxImages: 5 });
    });
  });

  describe("vllm_messages", function () {
    const adapter = getEmbeddingFormatAdapter("vllm_messages");

    it("posts to {apiBase}/embeddings", function () {
      assert.equal(
        adapter.resolveUrl("http://localhost:8000/v1"),
        "http://localhost:8000/v1/embeddings",
      );
    });

    it("wraps text in the chat template with the Qwen instruction", function () {
      assert.deepEqual(adapter.buildBody("m", [text("hello")]), {
        model: "m",
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: VLLM_EMBEDDING_INSTRUCTION }],
          },
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
        add_generation_prompt: true,
      });
    });

    it("sends an image as an image_url part", function () {
      const body = adapter.buildBody("m", [image()]) as {
        messages: Array<{ content: unknown[] }>;
      };
      assert.deepEqual(body.messages[1].content, [
        { type: "image_url", image_url: { url: PNG } },
      ]);
    });

    it("rejects more than one input per request", function () {
      assert.throws(
        () => adapter.buildBody("m", [text("a"), text("b")]),
        /exactly one input/,
      );
    });

    it("sends one input per request, four at a time", function () {
      assert.deepEqual(adapter.defaults, {
        maxItems: 1,
        maxImages: 1,
        concurrency: 4,
      });
    });
  });
});
