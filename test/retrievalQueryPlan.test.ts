import { assert } from "chai";
import {
  buildRetrievalPlannerPrompt,
  buildRetrievalQueryPlan,
  callLLMWithTimeout,
  generateRetrievalProbeReformulation,
  RETRIEVAL_QUERY_PLAN_TIMEOUT_MS,
  RETRIEVAL_QUERY_VARIANT_DEFAULT_LIMIT,
  resolveRetrievalQueryPlan,
  shouldAutoGenerateQueryVariants,
} from "../src/modules/contextPanel/retrievalQueryPlan";

describe("retrievalQueryPlan", function () {
  it("dedupes and caps query variants while preserving the original query", function () {
    const plan = buildRetrievalQueryPlan({
      query: "哪些论文使用钙成像研究表征漂移？",
      queryVariants: [
        "calcium imaging representational drift",
        "calcium imaging representational drift",
        "Ca2+ imaging representational drift",
        "two-photon imaging representational drift",
        "one-photon miniscope representational drift",
        "GCaMP representational drift",
        "chronic calcium imaging neural drift",
        "extra variant beyond default cap",
      ],
    });

    assert.equal(plan.originalQuery, "哪些论文使用钙成像研究表征漂移？");
    assert.lengthOf(plan.variants, RETRIEVAL_QUERY_VARIANT_DEFAULT_LIMIT);
    assert.isTrue(plan.variantLimitHit);
    assert.equal(plan.effectiveQueries[0], plan.originalQuery);
    assert.include(
      plan.effectiveQueries,
      "Ca2+ imaging representational drift",
    );
    assert.include(plan.lexicalTerms, "calcium");
    assert.include(plan.semanticQuery, plan.originalQuery);
  });

  it("skips automatic planning only for literal DOI syntax", function () {
    assert.isFalse(
      shouldAutoGenerateQueryVariants({
        query: "10.1101/2024.01.01.123456",
        hasRetrievalContext: true,
      }),
    );
    assert.isTrue(
      shouldAutoGenerateQueryVariants({
        query: "find the exact quote 'calcium imaging'",
        hasRetrievalContext: true,
      }),
    );
    assert.isTrue(
      shouldAutoGenerateQueryVariants({
        query: "how did they measure representational stability?",
        hasRetrievalContext: true,
      }),
    );
  });

  it("resolves caller-provided variants without requiring model planning", async function () {
    const plan = await resolveRetrievalQueryPlan({
      query: "表征漂移",
      queryVariants: ["representational drift"],
      hasRetrievalContext: true,
    });

    assert.deepEqual(plan.variants, ["representational drift"]);
    assert.include(plan.notes.join("\n"), "provided by the caller");
  });

  it("falls back to original-only planning when no model config is available", async function () {
    const plan = await resolveRetrievalQueryPlan({
      query: "how did they measure representational stability?",
      hasRetrievalContext: true,
    });

    assert.deepEqual(plan.variants, []);
    assert.deepEqual(plan.effectiveQueries, [
      "how did they measure representational stability?",
    ]);
    assert.include(plan.notes.join("\n"), "No query variants were used");
  });

  it("query expansion cannot override the shared reading decision", async function () {
    const plan = await resolveRetrievalQueryPlan({
      query: "read the whole paper",
      hasRetrievalContext: true,
      readIntent: "targeted",
      apiBase: "https://example.test/v1",
      model: "test",
      llmCall: async () => ({
        text: JSON.stringify({
          readIntent: "full-once",
          variants: ["paper methods"],
        }),
        completion: { status: "complete" as const },
      }),
    });
    assert.equal(plan.readIntent, "targeted");
    assert.deepEqual(plan.variants, ["paper methods"]);
  });

  it("takes full reading only from its structured input", function () {
    assert.equal(
      buildRetrievalQueryPlan({ query: "Read every page" }).readIntent,
      "targeted",
    );
    assert.equal(
      buildRetrievalQueryPlan({
        query: "Read every page",
        readIntent: "full-once",
      }).readIntent,
      "full-once",
    );
  });
});

describe("retrieval planner prompt", function () {
  it("includes bounded source samples and the bilingual-probe instruction", function () {
    const prompt = buildRetrievalPlannerPrompt({
      query: "哪些论文讨论了表征漂移？",
      sourceSamples: [
        "Representational drift in neocortex\nNeurons change tuning across days.",
      ],
    });

    assert.include(prompt, "Representational drift in neocortex");
    assert.include(prompt, "include at least one probe in each language");
    assert.include(prompt, "哪些论文讨论了表征漂移？");
  });

  it("omits the samples block when no samples are supplied", function () {
    const prompt = buildRetrievalPlannerPrompt({ query: "calcium imaging" });

    assert.notInclude(prompt, "Bounded document samples:");
  });

  it("uses a ten second default planner timeout", function () {
    assert.equal(RETRIEVAL_QUERY_PLAN_TIMEOUT_MS, 10_000);
  });
});

describe("probe reformulation", function () {
  it("degrades to empty variants with a note when no model config is available", async function () {
    const result = await generateRetrievalProbeReformulation({
      query: "neuromorphic hardware",
      triedProbes: ["neuromorphic hardware"],
      matchedProbes: [],
      scopeTitles: [],
    });

    assert.deepEqual(result.variants, []);
    assert.isTrue(
      result.notes.some((note) => note.includes("Probe reformulation failed")),
    );
  });

  it("uses the profile on a provider-safe planner call without inheriting main reasoning", async function () {
    let captured: Record<string, unknown> = {};
    const plan = await resolveRetrievalQueryPlan({
      query: "How does representational drift change across development?",
      hasRetrievalContext: true,
      model: "gpt-5.4",
      apiBase: "https://api.openai.com/v1",
      apiKey: "key",
      providerProtocol: "openai_chat_compat",
      profileOverride: {
        forModel: "gpt-5.4",
        limits: { outputTokens: 2_000 },
      },
      llmCall: async (params) => {
        captured = params as unknown as Record<string, unknown>;
        return {
          text: '{"readIntent":"targeted","variants":["developmental representational drift"]}',
          completion: { status: "complete" as const },
        };
      },
    });

    assert.deepEqual(plan.variants, ["developmental representational drift"]);
    assert.deepEqual(captured.reasoning, {
      provider: "openai",
      level: "low",
    });
    assert.deepEqual(captured.outputTokenLimit, {
      mode: "custom",
      tokens: 1_284,
    });
    assert.deepEqual(captured.profileOverride, {
      forModel: "gpt-5.4",
      limits: { outputTokens: 2_000 },
    });
  });

  it("re-prompts once when the planner's first response comes back blank", async function () {
    let calls = 0;
    const plan = await resolveRetrievalQueryPlan({
      query: "How does representational drift change across development?",
      hasRetrievalContext: true,
      model: "gpt-5.4",
      apiBase: "https://api.openai.com/v1",
      apiKey: "key",
      providerProtocol: "openai_chat_compat",
      llmCall: async () => {
        calls += 1;
        // A budget-truncated first response is exactly what the second
        // attempt exists for; treating it as terminal wastes the retry.
        return {
          text:
            calls === 1
              ? "   "
              : '{"readIntent":"targeted","variants":["developmental representational drift"]}',
          completion: { status: "complete" as const },
        };
      },
    });

    assert.equal(calls, 2);
    assert.deepEqual(plan.variants, ["developmental representational drift"]);
  });

  it("does not burn the second attempt on a transport failure", async function () {
    let calls = 0;
    const plan = await resolveRetrievalQueryPlan({
      query: "How does representational drift change across development?",
      hasRetrievalContext: true,
      model: "gpt-5.4",
      apiBase: "https://api.openai.com/v1",
      apiKey: "key",
      providerProtocol: "openai_chat_compat",
      llmCall: async () => {
        calls += 1;
        throw new Error("401 Unauthorized - bad key");
      },
    });

    assert.equal(calls, 1);
    assert.deepEqual(plan.variants, []);
  });
});

describe("callLLMWithTimeout runtime safety", function () {
  it("enforces the timeout even when AbortController is unavailable", async function () {
    const globalRef = globalThis as {
      AbortController?: typeof AbortController;
    };
    const originalCtor = globalRef.AbortController;
    delete globalRef.AbortController;
    try {
      const started = Date.now();
      let timedOut = false;
      try {
        await callLLMWithTimeout({
          prompt: "x",
          model: "m",
          apiBase: "https://example.invalid",
          apiKey: "k",
          timeoutMs: 40,
          llmCall: () => new Promise<never>(() => {}),
        });
      } catch {
        timedOut = true;
      }
      assert.isTrue(timedOut);
      assert.isBelow(Date.now() - started, 2000);
    } finally {
      globalRef.AbortController = originalCtor;
    }
  });

  it("passes an abort signal to the call when AbortController exists", async function () {
    let receivedSignal: unknown = null;
    const result = await callLLMWithTimeout({
      prompt: "x",
      model: "m",
      apiBase: "https://example.invalid",
      apiKey: "k",
      timeoutMs: 5000,
      llmCall: async (params: { signal?: AbortSignal }) => {
        receivedSignal = params.signal;
        return {
          text: "ok",
          completion: { status: "complete" as const },
        };
      },
    });

    assert.equal(result.text, "ok");
    assert.isOk(receivedSignal);
  });
});
