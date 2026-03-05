import { assert } from "chai";
import { buildChunkMetadata } from "../src/modules/contextPanel/pdfContext";
import { executeFindClaimEvidenceCall } from "../src/modules/contextPanel/Agent/Tools/findClaimEvidence";
import { pdfTextCache } from "../src/modules/contextPanel/state";
import type {
  ChunkStat,
  PaperContextRef,
  PdfContext,
} from "../src/modules/contextPanel/types";

describe("findClaimEvidence", function () {
  const paper: PaperContextRef = {
    itemId: 1,
    contextItemId: 100,
    title: "Evidence Paper",
    firstCreator: "Kim",
    year: "2025",
  };
  const contextItem = {
    id: 100,
    isAttachment: () => true,
    attachmentContentType: "application/pdf",
  } as unknown as Zotero.Item;

  beforeEach(function () {
    pdfTextCache.clear();
  });

  function tokenize(text: string): string[] {
    return (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
      (token) => token.length >= 3,
    );
  }

  function buildPdfContext(
    chunks: string[],
    chunkStats?: ChunkStat[],
  ): PdfContext {
    const resolvedChunkStats =
      chunkStats ||
      chunks.map((chunk, index) => {
        const tf: Record<string, number> = {};
        const terms = tokenize(chunk);
        for (const term of terms) {
          tf[term] = (tf[term] || 0) + 1;
        }
        return {
          index,
          length: terms.length,
          tf,
          uniqueTerms: Object.keys(tf),
        };
      });
    const docFreq: Record<string, number> = {};
    let totalLength = 0;
    for (const chunk of resolvedChunkStats) {
      totalLength += chunk.length;
      for (const term of chunk.uniqueTerms) {
        docFreq[term] = (docFreq[term] || 0) + 1;
      }
    }
    return {
      title: paper.title,
      chunks,
      chunkMeta: buildChunkMetadata(chunks),
      chunkStats: resolvedChunkStats,
      docFreq,
      avgChunkLength: resolvedChunkStats.length
        ? totalLength / resolvedChunkStats.length
        : 0,
      fullLength: chunks.join("\n\n").length,
      embeddingFailed: true,
    };
  }

  it("retrieves matching evidence snippets for the current question", async function () {
    pdfTextCache.set(
      contextItem.id,
      buildPdfContext(
        [
          "This paper claims that diffusion policy improves manipulation success.",
          "The experiments show strong gains over baseline imitation learning.",
          "The appendix lists extra implementation details.",
        ],
        [
          {
            index: 0,
            length: 8,
            tf: {
              paper: 1,
              claims: 1,
              diffusion: 1,
              policy: 1,
              improves: 1,
              manipulation: 1,
              success: 1,
            },
            uniqueTerms: [
              "paper",
              "claims",
              "diffusion",
              "policy",
              "improves",
              "manipulation",
              "success",
            ],
          },
          {
            index: 1,
            length: 9,
            tf: {
              experiments: 1,
              show: 1,
              strong: 1,
              gains: 1,
              over: 1,
              baseline: 1,
              imitation: 1,
              learning: 1,
            },
            uniqueTerms: [
              "experiments",
              "show",
              "strong",
              "gains",
              "over",
              "baseline",
              "imitation",
              "learning",
            ],
          },
          {
            index: 2,
            length: 6,
            tf: {
              appendix: 1,
              lists: 1,
              extra: 1,
              implementation: 1,
              details: 1,
            },
            uniqueTerms: [
              "appendix",
              "lists",
              "extra",
              "implementation",
              "details",
            ],
          },
        ],
      ),
    );

    const result = await executeFindClaimEvidenceCall(
      {
        question: "What evidence shows diffusion policy improves results over baseline?",
        libraryID: 5,
        conversationMode: "open",
        selectedPaperContexts: [],
        pinnedPaperContexts: [],
        recentPaperContexts: [],
        retrievedPaperContexts: [],
        toolTokenCap: 1500,
      },
      {
        name: "find_claim_evidence",
        target: { scope: "retrieved-paper", index: 1 },
      },
      {
        paperContext: paper,
        contextItem,
        targetLabel: "Evidence Paper",
        resolvedKey: "1:100",
      },
    );

    assert.isTrue(result.ok);
    assert.include(result.groundingText, "- Tool: find_claim_evidence");
    assert.include(result.groundingText, "Claim Evidence:");
    assert.include(result.groundingText, "Evidence snippet 1");
    assert.include(result.groundingText, "Source label: (Kim et al., 2025)");
    assert.include(result.groundingText, "Quoted evidence:");
    assert.include(result.groundingText, "diffusion policy improves");
    assert.include(result.groundingText, "baseline imitation learning");
    assert.notInclude(result.groundingText, "appendix lists extra implementation details");
    assert.deepEqual(result.addedPaperContexts, [paper]);
  });

  it("filters references and figure captions for generic claims and cleans noisy anchors", async function () {
    pdfTextCache.set(
      contextItem.id,
      buildPdfContext([
        "References\n\nAbraham, N. M., Egger, V., Shimshek, D. R., and Seeburg, P. H. (2010). Olfactory bulb circuitry.",
        "Figure 4. Representational drift across days in principal component space.",
        "Results\n\n23 activity. Representational drift increases over days and reduces cross-day decoding accuracy.",
        "Discussion\n\nThis suggests the encoding plane rotates progressively over time.",
      ]),
    );

    const result = await executeFindClaimEvidenceCall(
      {
        question: "What evidence shows representational drift in the olfactory bulb?",
        libraryID: 5,
        conversationMode: "open",
        selectedPaperContexts: [],
        pinnedPaperContexts: [],
        recentPaperContexts: [],
        retrievedPaperContexts: [],
        toolTokenCap: 1500,
      },
      {
        name: "find_claim_evidence",
        target: { scope: "retrieved-paper", index: 1 },
      },
      {
        paperContext: paper,
        contextItem,
        targetLabel: "Evidence Paper",
        resolvedKey: "1:100",
      },
    );

    assert.isTrue(result.ok);
    assert.include(result.groundingText, "Section: Results");
    assert.include(
      result.groundingText,
      "Representational drift increases over days and reduces cross-day decoding accuracy.",
    );
    assert.notInclude(result.groundingText, "Abraham, N. M.");
    assert.notInclude(result.groundingText, "Figure 4.");
    assert.notInclude(result.groundingText, '"23 activity.');
  });

  it("keeps figure captions when the query explicitly asks about figures", async function () {
    pdfTextCache.set(
      contextItem.id,
      buildPdfContext([
        "Figure 4. Representational drift across days in principal component space.",
        "Results\n\nCross-day decoding accuracy declines as the encoding subspace rotates.",
      ]),
    );

    const result = await executeFindClaimEvidenceCall(
      {
        question: "What does Figure 4 show about representational drift?",
        libraryID: 5,
        conversationMode: "open",
        selectedPaperContexts: [],
        pinnedPaperContexts: [],
        recentPaperContexts: [],
        retrievedPaperContexts: [],
        toolTokenCap: 1500,
      },
      {
        name: "find_claim_evidence",
        target: { scope: "retrieved-paper", index: 1 },
      },
      {
        paperContext: paper,
        contextItem,
        targetLabel: "Evidence Paper",
        resolvedKey: "1:100",
      },
    );

    assert.isTrue(result.ok);
    assert.include(
      result.groundingText,
      "> Representational drift across days in principal component space.",
    );
  });

  it("returns a graceful message when the paper text is unavailable", async function () {
    pdfTextCache.set(
      contextItem.id,
      buildPdfContext([]),
    );

    const result = await executeFindClaimEvidenceCall(
      {
        question: "Does the paper support the claim?",
        libraryID: 5,
        conversationMode: "open",
        selectedPaperContexts: [],
        pinnedPaperContexts: [],
        recentPaperContexts: [],
        retrievedPaperContexts: [],
      },
      {
        name: "find_claim_evidence",
        target: { scope: "retrieved-paper", index: 1 },
      },
      {
        paperContext: paper,
        contextItem,
        targetLabel: "Evidence Paper",
        resolvedKey: "1:100",
      },
    );

    assert.isTrue(result.ok);
    assert.include(result.groundingText, "Extractable full text available: no");
    assert.include(result.groundingText, "Evidence lookup could not inspect the paper body");
  });

  it("uses the planner-supplied query override when provided", async function () {
    pdfTextCache.set(
      contextItem.id,
      buildPdfContext([
        "Odour cues were absent in one task and informative in another.",
      ]),
    );

    const result = await executeFindClaimEvidenceCall(
      {
        question: "This broad question should be overridden by call.query",
        libraryID: 5,
        conversationMode: "open",
        selectedPaperContexts: [],
        pinnedPaperContexts: [],
        recentPaperContexts: [],
        retrievedPaperContexts: [],
      },
      {
        name: "find_claim_evidence",
        target: { scope: "retrieved-paper", index: 1 },
        query: "olfactory stimulus use in mice",
      },
      {
        paperContext: paper,
        contextItem,
        targetLabel: "Evidence Paper",
        resolvedKey: "1:100",
      },
    );

    assert.isTrue(result.ok);
    assert.include(
      result.groundingText,
      "- Claim or query: olfactory stimulus use in mice",
    );
    assert.notInclude(
      result.groundingText,
      "This broad question should be overridden",
    );
  });
});
