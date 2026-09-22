import { assert } from "chai";
import {
  buildDetectionIdentity,
  parseDetectionRecord,
  serializeDetectionRecord,
  type EmbeddingCapabilityRecord,
} from "../src/utils/embedding/detectionRecord";
import {
  isDashscopeNativeApiBase,
  resolveCandidateFormat,
  resolveEmbeddingBatchLimits,
  resolveMultimodalEmbeddingSettings,
  type MultimodalSettingsInput,
} from "../src/utils/embedding/settings";

const API_BASE = "https://api.siliconflow.cn/v1";
const MODEL = "Qwen/Qwen3-VL-Embedding-8B";
const EMPTY_BATCH = { maxItems: "", maxImages: "", concurrency: "" };

function input(
  overrides: Partial<MultimodalSettingsInput> = {},
): MultimodalSettingsInput {
  return {
    customProvider: true,
    apiBase: API_BASE,
    model: MODEL,
    imagesPref: "",
    formatPref: "",
    detectionRecord: "",
    batch: EMPTY_BATCH,
    ...overrides,
  };
}

function record(overrides: Partial<EmbeddingCapabilityRecord> = {}): string {
  return serializeDetectionRecord({
    identity: buildDetectionIdentity(API_BASE, MODEL),
    ...overrides,
  });
}

describe("embedding detection record", function () {
  it("normalizes the API URL in the identity", function () {
    assert.equal(
      buildDetectionIdentity("https://api.siliconflow.cn/v1/ ", ` ${MODEL} `),
      `https://api.siliconflow.cn/v1|${MODEL}`,
    );
  });

  it("round-trips a record", function () {
    const raw = record({
      ownedBy: "vllm",
      declaredImage: true,
      probe: { format: "vllm_messages", image: "supported", checkedAt: 1 },
    });
    assert.deepEqual(parseDetectionRecord(raw), {
      identity: buildDetectionIdentity(API_BASE, MODEL),
      ownedBy: "vllm",
      declaredImage: true,
      probe: { format: "vllm_messages", image: "supported", checkedAt: 1 },
    });
  });

  it("returns null for empty or malformed input", function () {
    assert.isNull(parseDetectionRecord(""));
    assert.isNull(parseDetectionRecord("{not json"));
    assert.isNull(parseDetectionRecord(JSON.stringify({ ownedBy: "vllm" })));
  });

  it("drops a probe with an unknown format", function () {
    const parsed = parseDetectionRecord(
      JSON.stringify({
        identity: "x",
        probe: { format: "grpc", image: "supported", checkedAt: 1 },
      }),
    );
    assert.deepEqual(parsed, { identity: "x" });
  });
});

describe("embedding settings resolution", function () {
  it("keeps non-custom providers text-only with legacy batching", function () {
    const settings = resolveMultimodalEmbeddingSettings(
      input({
        customProvider: false,
        imagesPref: "on",
        formatPref: "dashscope",
        batch: { maxItems: "4", maxImages: "", concurrency: "3" },
      }),
    );
    assert.isFalse(settings.imagesEnabled);
    assert.equal(settings.format, "openai_compat");
    assert.deepEqual(settings.limits, {
      maxItems: 16,
      maxImages: 4,
      concurrency: 1,
    });
  });

  it("defaults to no image support before any detection", function () {
    const settings = resolveMultimodalEmbeddingSettings(input());
    assert.isFalse(settings.imagesEnabled);
    assert.equal(settings.imageSource, "default");
    assert.equal(settings.format, "openai_compat");
  });

  it("uses the manual image choice", function () {
    const settings = resolveMultimodalEmbeddingSettings(
      input({ imagesPref: "on" }),
    );
    assert.isTrue(settings.imagesEnabled);
    assert.equal(settings.imageSource, "manual");
  });

  it("lets a manual off beat a declaration", function () {
    const settings = resolveMultimodalEmbeddingSettings(
      input({
        imagesPref: "off",
        detectionRecord: record({ declaredImage: true }),
      }),
    );
    assert.isFalse(settings.imagesEnabled);
    assert.equal(settings.imageSource, "manual");
  });

  it("prefers the API declaration over a probe", function () {
    const settings = resolveMultimodalEmbeddingSettings(
      input({
        detectionRecord: record({
          declaredImage: false,
          probe: { format: "openai_compat", image: "supported", checkedAt: 1 },
        }),
      }),
    );
    assert.isFalse(settings.imagesEnabled);
    assert.equal(settings.imageSource, "declared");
  });

  it("uses a probe made with the candidate format", function () {
    const settings = resolveMultimodalEmbeddingSettings(
      input({
        detectionRecord: record({
          probe: { format: "openai_compat", image: "supported", checkedAt: 1 },
        }),
      }),
    );
    assert.isTrue(settings.imagesEnabled);
    assert.equal(settings.imageSource, "probe");
    assert.equal(settings.format, "openai_compat");
  });

  it("ignores a probe made with a different format", function () {
    const settings = resolveMultimodalEmbeddingSettings(
      input({
        formatPref: "vllm_messages",
        detectionRecord: record({
          probe: { format: "openai_compat", image: "supported", checkedAt: 1 },
        }),
      }),
    );
    assert.isFalse(settings.imagesEnabled);
    assert.equal(settings.imageSource, "default");
  });

  it("ignores a record for another model", function () {
    const settings = resolveMultimodalEmbeddingSettings(
      input({
        model: "Qwen/Qwen3-Embedding-4B",
        detectionRecord: record({ declaredImage: true }),
      }),
    );
    assert.isFalse(settings.imagesEnabled);
  });

  it("detects vLLM from owned_by and uses it once images are on", function () {
    const settings = resolveMultimodalEmbeddingSettings(
      input({
        apiBase: "http://localhost:8000/v1",
        imagesPref: "on",
        detectionRecord: serializeDetectionRecord({
          identity: buildDetectionIdentity("http://localhost:8000/v1", MODEL),
          ownedBy: "vllm",
        }),
      }),
    );
    assert.equal(settings.candidateFormat, "vllm_messages");
    assert.equal(settings.candidateFormatSource, "owned_by");
    assert.equal(settings.format, "vllm_messages");
  });

  it("falls back to openai_compat while images are off", function () {
    const settings = resolveMultimodalEmbeddingSettings(
      input({ apiBase: "https://dashscope.aliyuncs.com/api/v1" }),
    );
    assert.equal(settings.candidateFormat, "dashscope");
    assert.equal(settings.format, "openai_compat");
  });

  it("reports the auto format even when a manual format is set", function () {
    const settings = resolveMultimodalEmbeddingSettings(
      input({
        apiBase: "https://dashscope.aliyuncs.com/api/v1",
        formatPref: "openai_compat",
      }),
    );
    assert.equal(settings.candidateFormat, "openai_compat");
    assert.equal(settings.autoFormat, "dashscope");
  });
});

describe("embedding candidate format", function () {
  it("recognizes DashScope native URLs but not compatible-mode", function () {
    assert.isTrue(
      isDashscopeNativeApiBase("https://dashscope.aliyuncs.com/api/v1"),
    );
    assert.isTrue(
      isDashscopeNativeApiBase("https://dashscope-intl.aliyuncs.com/api/v1"),
    );
    assert.isFalse(
      isDashscopeNativeApiBase(
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      ),
    );
    assert.isFalse(isDashscopeNativeApiBase("not a url"));
  });

  it("puts the manual format first", function () {
    assert.deepEqual(
      resolveCandidateFormat({
        formatPref: "openai_compat",
        apiBase: "https://dashscope.aliyuncs.com/api/v1",
        ownedBy: "vllm",
      }),
      { format: "openai_compat", source: "manual" },
    );
  });
});

describe("embedding batch limits", function () {
  it("uses each format's defaults for empty fields", function () {
    assert.deepEqual(
      resolveEmbeddingBatchLimits("openai_compat", EMPTY_BATCH).limits,
      { maxItems: 16, maxImages: 4, concurrency: 1 },
    );
    assert.deepEqual(
      resolveEmbeddingBatchLimits("dashscope", EMPTY_BATCH).limits,
      { maxItems: 20, maxImages: 5, concurrency: 1 },
    );
    assert.deepEqual(
      resolveEmbeddingBatchLimits("vllm_messages", EMPTY_BATCH).limits,
      { maxItems: 1, maxImages: 1, concurrency: 4 },
    );
  });

  it("uses explicit values and falls back on invalid ones", function () {
    const { limits } = resolveEmbeddingBatchLimits("openai_compat", {
      maxItems: "32",
      maxImages: "abc",
      concurrency: "0",
    });
    assert.deepEqual(limits, { maxItems: 32, maxImages: 4, concurrency: 1 });
  });

  it("clamps to the global ranges", function () {
    const { limits } = resolveEmbeddingBatchLimits("openai_compat", {
      maxItems: "1000",
      maxImages: "",
      concurrency: "50",
    });
    assert.equal(limits.maxItems, 256);
    assert.equal(limits.concurrency, 8);
  });

  it("caps DashScope values and reports the cap", function () {
    const result = resolveEmbeddingBatchLimits("dashscope", {
      maxItems: "30",
      maxImages: "9",
      concurrency: "",
    });
    assert.deepEqual(result.limits, {
      maxItems: 20,
      maxImages: 5,
      concurrency: 1,
    });
    assert.deepEqual(result.capped, { maxItems: 20, maxImages: 5 });
  });

  it("never allows more images than inputs per request", function () {
    const { limits } = resolveEmbeddingBatchLimits("openai_compat", {
      maxItems: "2",
      maxImages: "8",
      concurrency: "",
    });
    assert.equal(limits.maxImages, 2);
  });
});
