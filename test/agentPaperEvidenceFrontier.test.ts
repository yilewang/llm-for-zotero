import { assert } from "chai";
import {
  isPaperEvidenceFrontierEligible,
  PaperEvidenceFrontier,
} from "../src/agent/context/paperEvidenceFrontier";

function passage(params: {
  itemId?: number;
  contextItemId?: number;
  text?: string;
  chunkIndex?: number;
  pageIndex?: number;
  sourceStart?: number;
  sourceEnd?: number;
  sourceFingerprint?: string;
  quoteCitationId?: string;
}) {
  return {
    paperContext: {
      itemId: params.itemId ?? 1,
      contextItemId: params.contextItemId ?? 11,
    },
    text: params.text ?? "Elastic weight consolidation protects old tasks.",
    chunkIndex: params.chunkIndex,
    pageIndex: params.pageIndex,
    sourceStart: params.sourceStart,
    sourceEnd: params.sourceEnd,
    sourceFingerprint: params.sourceFingerprint ?? "source-a",
    sourceKind: "paper_text",
    quoteCitationIds: params.quoteCitationId
      ? [params.quoteCitationId]
      : undefined,
  };
}

function progress(content: unknown) {
  return (
    content as {
      paperEvidenceProgress: {
        frontier: string;
        newOccurrenceIds: string[];
        repeatedOccurrenceIds: string[];
        cumulativeOccurrenceCount: number;
      };
    }
  ).paperEvidenceProgress;
}

describe("PaperEvidenceFrontier", function () {
  it("retains readable labels in references for a reused paper read", async function () {
    const frontier = new PaperEvidenceFrontier();
    const input = { mode: "overview" };
    await frontier.processResult({
      input,
      toolCallId: "first",
      content: {
        results: [{ ...passage({}), displayLabel: "(Smith, 2024)" }],
      },
    });
    const reused = await frontier.readCached({ input, toolCallId: "second" });
    assert.equal(
      (reused?.content as any).paperEvidenceReferences[0].displayLabel,
      "(Smith, 2024)",
    );
  });
  it("keeps occurrence identities stable across result ordering", async function () {
    const first = new PaperEvidenceFrontier();
    const second = new PaperEvidenceFrontier();
    const entries = [
      passage({ chunkIndex: 2, quoteCitationId: "quote-a" }),
      passage({ chunkIndex: 8, quoteCitationId: "quote-b" }),
    ];

    const left = await first.processResult({
      input: { mode: "targeted", query: "method" },
      content: { mode: "targeted", results: entries },
      toolCallId: "left",
      resourceSignature: "turn-source",
    });
    const right = await second.processResult({
      input: { mode: "targeted", query: "method" },
      content: { mode: "targeted", results: [...entries].reverse() },
      toolCallId: "right",
      resourceSignature: "turn-source",
    });

    assert.deepEqual(
      [...progress(left.content).newOccurrenceIds].sort(),
      [...progress(right.content).newOccurrenceIds].sort(),
    );
  });

  it("suppresses an already delivered occurrence and keeps a rehydration reference", async function () {
    const frontier = new PaperEvidenceFrontier();
    const result = passage({ chunkIndex: 4, quoteCitationId: "quote-ewc" });
    const first = await frontier.processResult({
      input: { mode: "targeted", query: "forgetting" },
      content: {
        mode: "targeted",
        results: [result],
        quoteCitations: [{ id: "quote-ewc", quoteText: result.text }],
      },
      toolCallId: "read-1",
      resourceSignature: "turn-source",
      persistOriginal: async () => "trh-first",
    });
    const second = await frontier.processResult({
      input: { mode: "targeted", query: "catastrophic forgetting" },
      content: {
        mode: "targeted",
        results: [result],
        quoteCitations: [{ id: "quote-ewc", quoteText: result.text }],
      },
      toolCallId: "read-2",
      resourceSignature: "turn-source",
    });

    assert.equal(progress(first.content).frontier, "advanced");
    assert.equal(progress(second.content).frontier, "unchanged");
    assert.lengthOf((second.content as { results: unknown[] }).results, 0);
    assert.lengthOf(
      (second.content as { quoteCitations: unknown[] }).quoteCitations,
      0,
    );
    assert.deepInclude(
      (second.content as { paperEvidenceReferences: unknown[] })
        .paperEvidenceReferences[0] as Record<string, unknown>,
      {
        sourceToolCallId: "read-1",
        quoteCitationIds: ["quote-ewc"],
        toolResultHandle: "trh-first",
      },
    );
  });

  it("delivers matching text at independent source occurrences", async function () {
    const frontier = new PaperEvidenceFrontier();
    const text = "The Fisher penalty protects important parameters.";
    const first = await frontier.processResult({
      input: { mode: "targeted", query: "penalty" },
      content: {
        mode: "targeted",
        results: [passage({ itemId: 1, chunkIndex: 3, text })],
      },
      toolCallId: "read-a",
      resourceSignature: "turn-source",
    });
    const second = await frontier.processResult({
      input: { mode: "targeted", query: "same wording elsewhere" },
      content: {
        mode: "targeted",
        results: [passage({ itemId: 2, chunkIndex: 3, text })],
      },
      toolCallId: "read-b",
      resourceSignature: "turn-source",
    });

    assert.equal(progress(first.content).frontier, "advanced");
    assert.equal(progress(second.content).frontier, "advanced");
    assert.lengthOf((second.content as { results: unknown[] }).results, 1);
    assert.lengthOf(progress(second.content).newOccurrenceIds, 1);
    assert.deepEqual(progress(second.content).repeatedOccurrenceIds, []);
    const reference = (
      second.content as {
        paperEvidenceReferences: Array<{
          repeatedContentOccurrenceIds?: string[];
        }>;
      }
    ).paperEvidenceReferences[0];
    assert.deepEqual(
      reference.repeatedContentOccurrenceIds,
      progress(first.content).newOccurrenceIds,
    );
  });

  it("keeps matching text deliverable at different pages, chunks, and source offsets", async function () {
    const frontier = new PaperEvidenceFrontier();
    const text = "The same sentence can occur at independent source locations.";
    const locations = [
      { chunkIndex: 1, pageIndex: 2, sourceStart: 10, sourceEnd: 80 },
      { chunkIndex: 2, pageIndex: 2, sourceStart: 10, sourceEnd: 80 },
      { chunkIndex: 1, pageIndex: 3, sourceStart: 10, sourceEnd: 80 },
      { chunkIndex: 1, pageIndex: 2, sourceStart: 90, sourceEnd: 160 },
    ];
    const deliveredIds: string[] = [];

    for (const [index, location] of locations.entries()) {
      const result = await frontier.processResult({
        input: { mode: "targeted", query: `location-${index}` },
        content: {
          mode: "targeted",
          results: [passage({ ...location, text })],
        },
        toolCallId: `read-${index}`,
        resourceSignature: "turn-source",
      });
      assert.equal(progress(result.content).frontier, "advanced");
      assert.lengthOf((result.content as { results: unknown[] }).results, 1);
      deliveredIds.push(...progress(result.content).newOccurrenceIds);
    }

    assert.lengthOf(new Set(deliveredIds), locations.length);
  });

  it("fails open when provenance cannot identify the occurrence", async function () {
    const frontier = new PaperEvidenceFrontier();
    const content = {
      mode: "targeted",
      results: [{ text: "Evidence without stable source provenance." }],
    };
    const first = await frontier.processResult({
      input: { mode: "targeted", query: "first" },
      content,
      toolCallId: "read-1",
      resourceSignature: "turn-source",
    });
    const second = await frontier.processResult({
      input: { mode: "targeted", query: "second" },
      content,
      toolCallId: "read-2",
      resourceSignature: "turn-source",
    });

    assert.equal(progress(first.content).frontier, "advanced");
    assert.equal(progress(second.content).frontier, "advanced");
    assert.lengthOf((second.content as { results: unknown[] }).results, 1);
    assert.deepEqual(progress(second.content).newOccurrenceIds, []);
  });

  it("reuses an unidentified identical backend result without suppressing its text", async function () {
    const frontier = new PaperEvidenceFrontier();
    const input = { mode: "targeted", query: "unidentified" };
    const content = {
      mode: "targeted",
      results: [{ text: "Evidence without stable source provenance." }],
    };
    await frontier.processResult({
      input,
      content,
      toolCallId: "read-1",
      resourceSignature: "turn-source",
      persistOriginal: async () => "trh-unidentified",
    });

    const cached = await frontier.readCached({
      input,
      toolCallId: "read-2",
      resourceSignature: "turn-source",
    });

    assert.equal(cached?.frontier, "advanced");
    assert.deepEqual(
      (cached?.content as { results: unknown[] }).results,
      content.results,
    );
    assert.equal(
      (cached?.content as { toolResultHandle?: string }).toolResultHandle,
      "trh-unidentified",
    );
  });

  it("reuses an identical call only while its resource signature is unchanged", async function () {
    const frontier = new PaperEvidenceFrontier();
    const input = {
      mode: "targeted",
      query: "method",
      targets: [
        { itemId: 2, contextItemId: 12 },
        { itemId: 1, contextItemId: 11 },
      ],
    };
    await frontier.processResult({
      input,
      content: {
        mode: "targeted",
        results: [passage({ chunkIndex: 3 })],
      },
      toolCallId: "read-1",
      resourceSignature: "source-v1",
      persistOriginal: async () => "trh-source-v1",
    });

    const cached = await frontier.readCached({
      input: {
        ...input,
        targets: [...input.targets].reverse(),
      },
      toolCallId: "read-2",
      resourceSignature: "source-v1",
    });
    const invalidated = await frontier.readCached({
      input,
      toolCallId: "read-3",
      resourceSignature: "source-v2",
    });

    assert.isNotNull(cached);
    assert.equal(cached?.frontier, "unchanged");
    assert.equal(
      (cached?.content as { cacheStatus?: string }).cacheStatus,
      "identical_call_reused",
    );
    assert.isNull(invalidated);
  });

  it("distinguishes explicit nested paper-context targets in call caching", async function () {
    const frontier = new PaperEvidenceFrontier();
    const firstInput = {
      mode: "targeted",
      query: "method",
      target: { paperContext: { itemId: 1, contextItemId: 11 } },
    };
    await frontier.processResult({
      input: firstInput,
      content: {
        mode: "targeted",
        results: [passage({ itemId: 1, contextItemId: 11, chunkIndex: 3 })],
      },
      toolCallId: "read-1",
      resourceSignature: "turn-source",
    });

    assert.isNull(
      await frontier.readCached({
        input: {
          ...firstInput,
          target: { paperContext: { itemId: 2, contextItemId: 22 } },
        },
        toolCallId: "read-2",
        resourceSignature: "turn-source",
      }),
    );
  });

  it("delivers only new passages from a mixed new and repeated result", async function () {
    const frontier = new PaperEvidenceFrontier();
    const repeated = passage({ chunkIndex: 1 });
    const fresh = passage({ chunkIndex: 2, text: "A newly retrieved result." });
    await frontier.processResult({
      input: { mode: "targeted", query: "first" },
      content: { mode: "targeted", results: [repeated] },
      toolCallId: "read-1",
      resourceSignature: "turn-source",
    });
    const mixed = await frontier.processResult({
      input: { mode: "targeted", query: "second" },
      content: { mode: "targeted", results: [repeated, fresh] },
      toolCallId: "read-2",
      resourceSignature: "turn-source",
    });

    assert.equal(progress(mixed.content).frontier, "advanced");
    assert.lengthOf(progress(mixed.content).newOccurrenceIds, 1);
    assert.lengthOf(progress(mixed.content).repeatedOccurrenceIds, 1);
    assert.deepEqual((mixed.content as { results: unknown[] }).results, [
      fresh,
    ]);
  });

  it("reports unavailable textual evidence compactly", async function () {
    const frontier = new PaperEvidenceFrontier();
    const result = await frontier.processResult({
      input: { mode: "overview" },
      content: { mode: "overview", results: [] },
      toolCallId: "read-1",
      resourceSignature: "turn-source",
    });

    assert.equal(progress(result.content).frontier, "unavailable");
    assert.equal(
      (result.content as { paperEvidenceProgress: { recommendation: string } })
        .paperEvidenceProgress.recommendation,
      "answer_with_source_limitation",
    );
  });

  it("includes overview and explicit page text but excludes non-textual and full modes", function () {
    assert.isTrue(isPaperEvidenceFrontierEligible({ mode: "overview" }));
    assert.isTrue(
      isPaperEvidenceFrontierEligible({ mode: "targeted", pages: [0] }),
    );
    for (const mode of ["full", "figures", "visual", "capture"]) {
      assert.isFalse(isPaperEvidenceFrontierEligible({ mode }));
    }
  });
});

describe("PaperEvidenceFrontier stop guidance by requested coverage", function () {
  it("tells a targeted question to answer now when a repeated read adds nothing", async function () {
    const frontier = new PaperEvidenceFrontier({
      evidencePolicy: { coverage: "targeted", readBudget: 2 },
    });
    const input = { mode: "targeted", query: "cross-day decoding" };
    const first = await frontier.processResult({
      input,
      toolCallId: "first",
      content: { results: [passage({ chunkIndex: 4 })] },
    });
    assert.equal(
      (first.content as any).paperEvidenceProgress.recommendation,
      "answer_or_self_check",
    );
    assert.equal((first.content as any).paperEvidenceProgress.readsThisTurn, 1);
    const reused = await frontier.readCached({ input, toolCallId: "second" });
    assert.equal(reused?.frontier, "unchanged");
    assert.equal(
      (reused?.content as any).paperEvidenceProgress.recommendation,
      "answer_now",
    );
    assert.include(
      (reused?.content as any).paperEvidenceProgress.reason,
      "do not retrieve again",
    );
  });

  it("tells a targeted question to answer once the read budget is used even when text is new", async function () {
    const frontier = new PaperEvidenceFrontier({
      evidencePolicy: { coverage: "targeted", readBudget: 2 },
    });
    await frontier.processResult({
      input: { mode: "targeted", query: "one" },
      toolCallId: "first",
      content: { results: [passage({ chunkIndex: 1 })] },
    });
    const second = await frontier.processResult({
      input: { mode: "targeted", query: "two" },
      toolCallId: "second",
      content: { results: [passage({ chunkIndex: 2 })] },
    });
    assert.equal(second.frontier, "advanced");
    assert.equal(
      (second.content as any).paperEvidenceProgress.recommendation,
      "answer_now",
    );
    assert.equal(
      (second.content as any).paperEvidenceProgress.readsThisTurn,
      2,
    );
    assert.equal((second.content as any).paperEvidenceProgress.readBudget, 2);
  });

  it("keeps missing-dimension guidance for exhaustive coverage and by default", async function () {
    for (const frontier of [
      new PaperEvidenceFrontier(),
      new PaperEvidenceFrontier({
        evidencePolicy: {
          coverage: "exhaustive",
          readBudget: Number.POSITIVE_INFINITY,
        },
      }),
    ]) {
      const input = { mode: "targeted", query: "method" };
      await frontier.processResult({
        input,
        toolCallId: "first",
        content: { results: [passage({ chunkIndex: 4 })] },
      });
      const reused = await frontier.readCached({ input, toolCallId: "second" });
      assert.equal(
        (reused?.content as any).paperEvidenceProgress.recommendation,
        "name_a_specific_missing_dimension",
      );
    }
  });
});

describe("PaperEvidenceFrontier inside plan execution", function () {
  it("tells the model to continue the plan instead of chat stop guidance", async function () {
    const { PaperEvidenceFrontier } =
      await import("../src/agent/context/paperEvidenceFrontier");
    const frontier = new PaperEvidenceFrontier({
      evidencePolicy: null,
      planExecuting: true,
    });
    const processed = await frontier.processResult({
      input: { mode: "overview", targets: [{ itemId: 1 }] },
      content: {
        mode: "overview",
        results: [
          {
            text: "Body text of the paper.",
            paperContext: { itemId: 1, contextItemId: 2 },
            sourceFingerprint: "fp",
          },
        ],
      },
      toolCallId: "call-1",
    });
    const progress = (processed.content as any).paperEvidenceProgress;
    assert.equal(progress.recommendation, "continue_plan");
    assert.notMatch(progress.reason, /answer/i);
  });
});
