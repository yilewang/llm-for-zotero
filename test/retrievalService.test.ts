import { assert } from "chai";
import type {
  PaperContextCandidate,
  PaperContextRef,
  PdfContext,
} from "../src/modules/contextPanel/types";
import { RetrievalService } from "../src/agent/services/retrievalService";

describe("RetrievalService", function () {
  it("keeps evidence-mode ordering instead of re-sorting by raw hybrid score", async function () {
    const paper: PaperContextRef = {
      itemId: 1,
      contextItemId: 11,
      title: "TEM",
      firstCreator: "Muller",
      year: "2020",
    };
    const pdfContext = {
      title: "Mock Paper",
      chunks: [],
      chunkMeta: [],
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 0,
      fullLength: 0,
    } as PdfContext;
    const abstractCandidate: PaperContextCandidate = {
      paperKey: "1:11",
      itemId: 1,
      contextItemId: 11,
      title: "TEM",
      firstCreator: "Muller",
      year: "2020",
      chunkIndex: 0,
      chunkText:
        "Abstract\nThe paper introduces the Tolman-Eichenbaum Machine and shows it generalizes structural maps across tasks.",
      chunkKind: "abstract",
      sourceStart: 100,
      sourceEnd: 310,
      sourceFingerprint: "fnv1a32-test",
      pageStart: 5,
      pageEnd: 5,
      estimatedTokens: 18,
      bm25Score: 0.2,
      embeddingScore: 0,
      hybridScore: 0.2,
      evidenceScore: 1.1,
    };
    const captionCandidate: PaperContextCandidate = {
      paperKey: "1:11",
      itemId: 1,
      contextItemId: 11,
      title: "TEM",
      firstCreator: "Muller",
      year: "2020",
      chunkIndex: 1,
      chunkText:
        "Figure S7. The main contribution finding generalizes structural maps across tasks and environments.",
      chunkKind: "figure-caption",
      estimatedTokens: 14,
      bm25Score: 0.9,
      embeddingScore: 0,
      hybridScore: 0.9,
      evidenceScore: -0.2,
    };
    const retrieval = new RetrievalService(
      {
        ensurePaperContext: async () => pdfContext,
      } as any,
      async (_paperContext, _pdfContext, _question, _apiOverrides, options) => {
        assert.equal(options?.mode, "evidence");
        assert.equal(options?.topK, 2);
        return [captionCandidate, abstractCandidate];
      },
    );

    const results = await retrieval.retrieveEvidence({
      papers: [paper],
      question:
        "Summarize the paper in one sentence with the main contribution and finding.",
      topK: 2,
      perPaperTopK: 2,
    });

    assert.lengthOf(results, 2);
    assert.equal(results[0].chunkIndex, 0);
    assert.equal(results[0].chunkKind, "abstract");
    assert.equal(results[0].score, abstractCandidate.evidenceScore);
    assert.equal(results[0].sourceStart, 100);
    assert.equal(results[0].sourceEnd, 310);
    assert.equal(results[0].sourceFingerprint, "fnv1a32-test");
    assert.equal(results[0].pageStart, 5);
    assert.equal(results[0].pageEnd, 5);
    assert.equal(results[1].chunkIndex, 1);
    assert.equal(results[1].chunkKind, "figure-caption");
    assert.equal(results[1].score, captionCandidate.evidenceScore);
    assert.isAbove(results[0].score, results[1].score);
  });

  it("passes query variants through the shared paper retrieval query plan", async function () {
    const paper: PaperContextRef = {
      itemId: 2,
      contextItemId: 22,
      title: "Variant Paper",
      firstCreator: "Chen",
      year: "2026",
    };
    const pdfContext = {
      title: "Mock Paper",
      chunks: [],
      chunkMeta: [],
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 0,
      fullLength: 0,
    } as PdfContext;
    const retrieval = new RetrievalService(
      {
        ensurePaperContext: async () => pdfContext,
      } as any,
      async (_paperContext, _pdfContext, _question, _apiOverrides, options) => {
        assert.include(options?.queryPlan?.variants || [], "calcium imaging");
        assert.include(options?.queryPlan?.lexicalTerms || [], "calcium");
        assert.include(
          options?.queryPlan?.semanticQuery || "",
          "calcium imaging",
        );
        return [
          {
            paperKey: "2:22",
            itemId: 2,
            contextItemId: 22,
            title: "Variant Paper",
            chunkIndex: 0,
            chunkText: "The paper uses calcium imaging.",
            estimatedTokens: 8,
            bm25Score: 1,
            embeddingScore: 0,
            hybridScore: 1,
            evidenceScore: 1,
            matchedQueryVariant: "calcium imaging",
            matchedQueryVariants: ["calcium imaging"],
          },
        ];
      },
    );

    const results = await retrieval.retrieveEvidence({
      papers: [paper],
      question: "钙成像",
      queryVariants: ["calcium imaging"],
      topK: 1,
      perPaperTopK: 1,
    });

    assert.lengthOf(results, 1);
    assert.equal(results[0].text, "The paper uses calcium imaging.");
  });
});
