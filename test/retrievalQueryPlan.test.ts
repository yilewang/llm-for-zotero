import { assert } from "chai";
import {
  buildRetrievalPlannerPrompt,
  buildRetrievalQueryPlan,
  callLLMWithTimeout,
  generateRetrievalProbeReformulation,
  classifyPaperReadIntent,
  detectExplicitFullReadIntent,
  RETRIEVAL_QUERY_PLAN_TIMEOUT_MS,
  RETRIEVAL_QUERY_VARIANT_DEFAULT_LIMIT,
  reconcilePlannerReadIntent,
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

  it("skips automatic planning for exact lookup-style queries", function () {
    assert.isFalse(
      shouldAutoGenerateQueryVariants({
        query: "find DOI 10.1101/2024.01.01.123456",
        hasRetrievalContext: true,
      }),
    );
    assert.isFalse(
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

  it("recognizes explicit full-reading intent without treating ordinary summaries as full reads", function () {
    assert.isFalse(
      detectExplicitFullReadIntent("Read the full text before answering."),
    );
    assert.isTrue(
      detectExplicitFullReadIntent("Read the complete second selected paper."),
    );
    assert.isTrue(detectExplicitFullReadIntent("Read the entire Lee paper."));
    assert.isTrue(detectExplicitFullReadIntent("Read the full paper."));
    assert.isTrue(detectExplicitFullReadIntent("Read the full article."));
    assert.isTrue(
      detectExplicitFullReadIntent(
        "Do not read the abstract; read the full paper.",
      ),
    );
    assert.isTrue(
      detectExplicitFullReadIntent("Read all selected papers in full."),
    );
    assert.isTrue(
      detectExplicitFullReadIntent(
        "Read the second of the selected papers in full.",
      ),
    );
    assert.isTrue(
      detectExplicitFullReadIntent("Read both selected papers cover to cover."),
    );
    for (const query of [
      "Fully read the paper.",
      "Completely read the article.",
      "Read the full paper first, then answer.",
      "Read the full paper now.",
      "Read the complete paper while focusing on methods.",
      "Read the first two selected papers in full.",
      "Read selected papers 1 and 2 in full.",
      "Read it cover to cover.",
      "Read it from start to finish.",
      "Read the entire Analysis of Neural Drift paper.",
      "Read the whole Review of Representational Drift article.",
      "Read the full Methods for Longitudinal Imaging paper.",
      "Read the entire Introduction to Machine Learning text.",
      "Read the complete Critique of Pure Reason text.",
    ]) {
      assert.isTrue(detectExplicitFullReadIntent(query), query);
    }
    assert.isTrue(
      detectExplicitFullReadIntent("请先通读整篇论文，再回答问题。"),
    );
    for (const query of [
      "不要通读第一篇论文。请通读第二篇论文。",
      "不要通读第一篇论文，但请通读第二篇论文。",
      "不要从头到尾阅读第一篇论文，但要从头到尾阅读第二篇论文。",
    ]) {
      assert.isTrue(detectExplicitFullReadIntent(query), query);
    }
    for (const query of [
      "请阅读完整论文。",
      "请阅读完整文章。",
      "请阅读完整文档。",
      "请阅读全部论文。",
      "请阅读这篇论文的完整内容。",
    ]) {
      assert.isTrue(detectExplicitFullReadIntent(query), query);
    }
    assert.isFalse(detectExplicitFullReadIntent("Summarize this paper."));
    assert.isFalse(
      detectExplicitFullReadIntent(
        "Use the actual PDF/full text to explain the method.",
      ),
    );
    assert.isFalse(
      detectExplicitFullReadIntent(
        "Provide a complete explanation of Figure 2.",
      ),
    );
    assert.isFalse(
      detectExplicitFullReadIntent(
        "Analyze the entire mechanism described in this paragraph.",
      ),
    );
    assert.isFalse(
      detectExplicitFullReadIntent(
        "Provide a complete explanation of Figure 2 in the paper.",
      ),
    );
    assert.isFalse(
      detectExplicitFullReadIntent(
        "Review the whole argument critically in the paper.",
      ),
    );
    assert.isFalse(
      detectExplicitFullReadIntent(
        "Provide a complete and accurate explanation of Figure 2 in the paper.",
      ),
    );
    assert.isFalse(
      detectExplicitFullReadIntent(
        "Review a complete critical analysis of the paper.",
      ),
    );
    assert.isFalse(
      detectExplicitFullReadIntent("Read the entire paper's Methods section."),
    );
    assert.isFalse(
      detectExplicitFullReadIntent(
        "Read the complete article's Figure 2 caption.",
      ),
    );
    for (const query of [
      "Provide a complete critique of the paper.",
      "Provide a complete list of limitations in the paper.",
      "Read the complete paper's abstract.",
      "Read the full article's conclusion.",
      "Analyze the entire paper's introduction.",
    ]) {
      assert.isFalse(detectExplicitFullReadIntent(query), query);
    }
    assert.isFalse(
      detectExplicitFullReadIntent("Explain every section of Figure 2."),
    );
    for (const query of [
      "Analyze every section of the Methods.",
      "Review every page of the appendix.",
      "Read every section of the supplementary analysis.",
      "Analyze every section of the results.",
      "Analyze full text classification in this paper.",
      "Review the full-text retrieval method in this paper.",
      "Analyze the full text search approach used by the paper.",
      "Provide a complete text classification analysis of the paper.",
      "Review the complete document retrieval pipeline.",
      "Analyze the full PDF parsing method.",
      "Review the entire article selection process.",
      "Analyze the full paper recommendation method.",
      "Provide a complete explanation of the Lee paper.",
      "Read the whole argument in the Smith paper.",
      "Review a complete critical analysis of Lee's article.",
      "Do not read the full paper; summarize the abstract.",
      "Rather than read the full paper, summarize the abstract.",
      "Do anything but read the full paper.",
      "Read anything except the full paper.",
      "You do not need to read the paper in full.",
    ]) {
      assert.isFalse(detectExplicitFullReadIntent(query), query);
    }
    assert.isFalse(
      detectExplicitFullReadIntent(
        "Walk me through the experiment from start to finish.",
      ),
    );
    assert.isFalse(detectExplicitFullReadIntent("请从头到尾解释这个机制。"));
    assert.isFalse(
      detectExplicitFullReadIntent(
        "このメカニズムを最初から最後まで説明して。",
      ),
    );
    assert.isFalse(
      detectExplicitFullReadIntent("이 메커니즘을 처음부터 끝까지 설명해 줘."),
    );
    for (const query of [
      "不要从头到尾阅读这篇论文。",
      "无需从头到尾阅读这篇论文。",
      "不必从头到尾阅读这篇论文。",
      "不用从头到尾阅读这篇论文。",
      "请勿从头到尾阅读这篇论文。",
      "别从头到尾阅读这篇论文。",
      "别通读整篇论文。",
      "不需要阅读全文。",
      "无须阅读全文。",
      "没必要通读整篇论文。",
      "我没有必要阅读全文，只要摘要。",
      "我不想阅读全文，只要摘要。",
      "不能通读整篇论文，只看摘要。",
      "이 논문을 처음부터 끝까지 읽지 마세요.",
      "이 논문을 처음부터 끝까지 읽지 않아도 됩니다.",
      "이 논문을 전문으로 읽지 말고 초록만 요약해 주세요.",
      "이 논문 전체를 읽지 말고 초록만 요약해 주세요.",
      "이 논문 전체를 읽으면 안 됩니다.",
      "이 논문 전체를 읽을 필요가 없습니다.",
      "この論文の全文を読むな。",
      "この論文の全文を読む必要はありません。",
      "全文を読むのは避けてください。",
      "全文を読まずに要約してください。",
      "이 논문 전문을 읽는 것은 피하세요.",
      "전문을 읽을 필요가 전혀 없습니다.",
      "전문을 읽어선 안 돼요.",
      "전문을 읽고 싶지 않습니다.",
      "この論文の全文を読んではいけません。",
      "この論文の全文を読むべきではありません。",
      "全文を読んでほしくない。",
    ]) {
      assert.isFalse(detectExplicitFullReadIntent(query), query);
    }
    for (const query of [
      "图2如何概括整篇论文的论点？",
      "論文全体の主張を要約して。",
      "전체 논문의 주장을 요약해 줘.",
      "请阅读完整的论文摘要。",
      "请阅读完整的论文结论。",
      "请完整阅读论文的方法部分。",
      "この論文の全文要約を読んでください。",
      "논문의 전체 초록을 읽어 주세요.",
    ]) {
      assert.isFalse(detectExplicitFullReadIntent(query), query);
    }
    assert.equal(
      buildRetrievalQueryPlan({ query: "请阅读完整全文" }).readIntent,
      "full-once",
    );
  });

  it("classifies paper evidence source independently from read coverage", function () {
    assert.deepEqual(
      classifyPaperReadIntent(
        "Use the actual PDF/full text to explain the method.",
      ),
      { source: "document_text", coverage: "targeted" },
    );
    assert.deepEqual(classifyPaperReadIntent("Summarize the actual PDF."), {
      source: "document_text",
      coverage: "overview",
    });
    assert.deepEqual(classifyPaperReadIntent("Read the entire actual PDF."), {
      source: "document_text",
      coverage: "exhaustive",
    });
    assert.deepEqual(classifyPaperReadIntent("Inspect the layout of page 5."), {
      source: "rendered_pages",
      coverage: "targeted",
    });
  });

  it("does not let model planning promote a non-explicit request to a full read", function () {
    assert.equal(
      reconcilePlannerReadIntent(
        "Rather than read the full paper, summarize the abstract.",
        "full-once",
      ),
      "targeted",
    );
    assert.equal(
      reconcilePlannerReadIntent(
        "Provide a complete explanation of the Lee paper.",
        "full-once",
      ),
      "targeted",
    );
    assert.equal(
      reconcilePlannerReadIntent("Read the complete Lee paper.", "full-once"),
      "full-once",
    );
    assert.equal(
      reconcilePlannerReadIntent("Read the complete Lee paper.", "targeted"),
      "targeted",
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
        return '{"readIntent":"targeted","variants":["developmental representational drift"]}';
      },
    });

    assert.deepEqual(plan.variants, ["developmental representational drift"]);
    assert.deepEqual(captured.reasoning, {
      provider: "openai",
      level: "low",
    });
    assert.equal(captured.maxTokens, 1_284);
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
        return calls === 1
          ? "   "
          : '{"readIntent":"targeted","variants":["developmental representational drift"]}';
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
          llmCall: () => new Promise<string>(() => {}),
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
        return "ok";
      },
    });

    assert.equal(result, "ok");
    assert.isOk(receivedSignal);
  });
});
