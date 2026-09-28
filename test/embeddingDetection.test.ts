import { assert } from "chai";
import {
  classifyImageProbeFailure,
  extractModelDeclaration,
  runEmbeddingCapabilityTest,
  type EmbeddingCapabilityTestDeps,
} from "../src/utils/embedding/detection";
import { buildDetectionIdentity } from "../src/utils/embedding/detectionRecord";
import {
  EmbeddingRequestError,
  type EmbeddingRequestFormat,
  type MultimodalItem,
} from "../src/utils/embedding/types";
import type { DiscoveredModel } from "../src/modelCapabilities/types";

const API_BASE = "https://api.siliconflow.cn/v1";
const MODEL = "Qwen/Qwen3-VL-Embedding-8B";
const IDENTITY = buildDetectionIdentity(API_BASE, MODEL);

function requestError(status: number) {
  return new EmbeddingRequestError({
    format: "openai_compat",
    status,
    statusText: "x",
    body: "x",
  });
}

type EmbedCall = { kinds: string[]; format: EmbeddingRequestFormat };

/** `plan` answers each embed call in order: a vector list or an error. */
function makeDeps(
  plan: Array<number[][] | Error>,
  overrides: Partial<EmbeddingCapabilityTestDeps> = {},
): { deps: EmbeddingCapabilityTestDeps; calls: EmbedCall[] } {
  const calls: EmbedCall[] = [];
  const deps: EmbeddingCapabilityTestDeps = {
    apiBase: API_BASE,
    model: MODEL,
    previousRecord: null,
    imagesPref: "",
    fetchModels: async () => [],
    resolveFormat: (ownedBy) =>
      ownedBy === "vllm" ? "vllm_messages" : "openai_compat",
    embed: async (items: MultimodalItem[], format: EmbeddingRequestFormat) => {
      calls.push({ kinds: items.map((item) => item.kind), format });
      const next = plan.shift();
      if (!next) throw new Error("unexpected embed call");
      if (next instanceof Error) throw next;
      return next;
    },
    testImageDataUrl: "data:image/png;base64,AAAA",
    now: () => 42,
    ...overrides,
  };
  return { deps, calls };
}

describe("embedding capability detection", function () {
  describe("extractModelDeclaration", function () {
    it("reads owned_by and image support of the configured model", function () {
      const models: DiscoveredModel[] = [
        { id: "other", ownedBy: "x" },
        { id: MODEL, ownedBy: "vllm", inputs: { image: true } },
      ];
      assert.deepEqual(extractModelDeclaration(models, MODEL), {
        ownedBy: "vllm",
        declaredImage: true,
      });
    });

    it("falls back to any owned_by when the model is not listed", function () {
      assert.deepEqual(
        extractModelDeclaration(
          [{ id: "served-name", ownedBy: "vllm" }],
          MODEL,
        ),
        { ownedBy: "vllm" },
      );
    });

    it("declares nothing for an empty catalog", function () {
      assert.deepEqual(extractModelDeclaration([], MODEL), {});
    });
  });

  describe("classifyImageProbeFailure", function () {
    it("treats 400, 415 and 422 as unsupported", function () {
      for (const status of [400, 415, 422]) {
        assert.equal(
          classifyImageProbeFailure(requestError(status)),
          "unsupported",
        );
      }
    });

    it("treats auth, rate limits, server and network errors as unknown", function () {
      for (const status of [401, 403, 404, 429, 500, 503]) {
        assert.equal(
          classifyImageProbeFailure(requestError(status)),
          "unknown",
        );
      }
      assert.equal(
        classifyImageProbeFailure(new TypeError("network")),
        "unknown",
      );
    });
  });

  describe("runEmbeddingCapabilityTest", function () {
    it("records support when text and image embed together", async function () {
      const { deps, calls } = makeDeps(
        [
          [
            [1, 2],
            [3, 4],
          ],
        ],
        {
          fetchModels: async () => [{ id: MODEL, ownedBy: "siliconflow" }],
        },
      );
      const result = await runEmbeddingCapabilityTest(deps);
      assert.deepEqual(result.outcome, { kind: "both_ok", dimension: 2 });
      assert.deepEqual(result.record, {
        identity: IDENTITY,
        ownedBy: "siliconflow",
        probe: { format: "openai_compat", image: "supported", checkedAt: 42 },
      });
      assert.deepEqual(calls, [
        { kinds: ["text", "image"], format: "openai_compat" },
      ]);
    });

    it("records no support when only the image is rejected with 400", async function () {
      const { deps } = makeDeps([
        requestError(400),
        [[1, 2]],
        requestError(400),
      ]);
      const result = await runEmbeddingCapabilityTest(deps);
      assert.equal(result.outcome.kind, "image_unsupported");
      assert.deepEqual(result.record.probe, {
        format: "openai_compat",
        image: "unsupported",
        checkedAt: 42,
      });
    });

    it("keeps the previous probe when the image failure is not conclusive", async function () {
      const previousProbe = {
        format: "openai_compat" as const,
        image: "supported" as const,
        checkedAt: 1,
      };
      const { deps } = makeDeps(
        [requestError(429), [[1, 2]], requestError(429)],
        {
          previousRecord: { identity: IDENTITY, probe: previousProbe },
        },
      );
      const result = await runEmbeddingCapabilityTest(deps);
      assert.equal(result.outcome.kind, "image_unknown");
      assert.deepEqual(result.record.probe, previousProbe);
    });

    it("reports a text failure without writing a probe", async function () {
      const { deps } = makeDeps([requestError(401), requestError(401)]);
      const result = await runEmbeddingCapabilityTest(deps);
      assert.equal(result.outcome.kind, "text_failed");
      assert.isUndefined(result.record.probe);
    });

    it("reports differing dimensions without writing a probe", async function () {
      const { deps } = makeDeps([
        new Error("dimensions differ"),
        [[1, 2]],
        [[1]],
      ]);
      const result = await runEmbeddingCapabilityTest(deps);
      assert.deepEqual(result.outcome, {
        kind: "dimension_mismatch",
        textDimension: 2,
        imageDimension: 1,
      });
      assert.isUndefined(result.record.probe);
    });

    it("tests text only when the API declares no image support", async function () {
      const { deps, calls } = makeDeps([[[1, 2, 3]]], {
        fetchModels: async () => [{ id: MODEL, inputs: { image: false } }],
      });
      const result = await runEmbeddingCapabilityTest(deps);
      assert.deepEqual(result.outcome, { kind: "text_only_ok", dimension: 3 });
      assert.isFalse(result.record.declaredImage);
      assert.deepEqual(calls, [{ kinds: ["text"], format: "openai_compat" }]);
    });

    it("still probes images under a manual on despite a negative declaration", async function () {
      const { deps, calls } = makeDeps([[[1], [2]]], {
        imagesPref: "on",
        fetchModels: async () => [{ id: MODEL, inputs: { image: false } }],
      });
      const result = await runEmbeddingCapabilityTest(deps);
      assert.equal(result.outcome.kind, "both_ok");
      assert.deepEqual(calls[0].kinds, ["text", "image"]);
    });

    it("probes with the vLLM format when owned_by says vllm", async function () {
      const { deps, calls } = makeDeps([[[1], [2]]], {
        fetchModels: async () => [{ id: MODEL, ownedBy: "vllm" }],
      });
      await runEmbeddingCapabilityTest(deps);
      assert.equal(calls[0].format, "vllm_messages");
    });

    it("probes anyway when the catalog request fails", async function () {
      const { deps, calls } = makeDeps([[[1], [2]]], {
        fetchModels: async () => {
          throw new Error("404");
        },
      });
      const result = await runEmbeddingCapabilityTest(deps);
      assert.equal(result.outcome.kind, "both_ok");
      assert.equal(calls[0].format, "openai_compat");
    });

    it("drops a previous record for another identity", async function () {
      const { deps } = makeDeps([requestError(401), requestError(401)], {
        previousRecord: {
          identity: "https://old/v1|old-model",
          probe: { format: "openai_compat", image: "supported", checkedAt: 1 },
        },
      });
      const result = await runEmbeddingCapabilityTest(deps);
      assert.equal(result.record.identity, IDENTITY);
      assert.isUndefined(result.record.probe);
    });
  });
});
