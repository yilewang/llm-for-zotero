import { assert } from "chai";
import {
  buildChunkIndex,
  buildChunkMetadata,
  buildPaperRetrievalCandidates,
  selectStructuredCandidates,
} from "../src/services/paperContent/pdfContext";
import { buildRetrievalQueryPlan } from "../src/services/retrieval/retrievalQueryPlan";
import { tokenizeRetrievalText } from "../src/services/retrieval/retrievalTokenizer";
import {
  buildFixturePdfContext,
  restoreTestGlobals,
  snapshotTestGlobals,
  type TestGlobalSnapshot,
} from "./helpers/retrievalCorpus";
import type { PaperContextRef } from "../src/modules/contextPanel/types";
import type {
  ChunkStat,
  DocumentReferenceEvidence,
  PaperContextCandidate,
  PdfChunkKind,
  PdfChunkMeta,
  PdfContext,
} from "../src/services/paperContent/types";

const PAPER: PaperContextRef = {
  itemId: 1,
  contextItemId: 11,
  title: "Structure Paper",
  firstCreator: "Tester",
  year: "2026",
};

type FakeChunkSpec = {
  chunkIndex: number;
  sectionIndex?: number;
  text?: string;
  priorShift?: number;
};

/** Minimal candidate for the pure selection stage. */
function fakeCandidate(spec: FakeChunkSpec): PaperContextCandidate {
  return {
    paperKey: "paper",
    itemId: PAPER.itemId,
    contextItemId: PAPER.contextItemId,
    title: PAPER.title,
    chunkIndex: spec.chunkIndex,
    chunkText: spec.text || `chunk ${spec.chunkIndex}`,
    sectionIndex: spec.sectionIndex,
    sectionPath:
      spec.sectionIndex === undefined ? undefined : `s${spec.sectionIndex}`,
    estimatedTokens: 10,
    bm25Score: 1,
    embeddingScore: 0,
    hybridScore: 1 / (60 + spec.chunkIndex + 1),
    evidenceScore: 1 / (60 + spec.chunkIndex + 1),
    why: {
      bm25Rank: spec.chunkIndex + 1,
      priorShift: spec.priorShift ?? 0,
    },
  };
}

function sectionList(count: number, titles: Record<number, string> = {}) {
  return Array.from({ length: count }, (_value, index) => ({
    sectionId: `s${index}`,
    title: titles[index] || `Section ${index}`,
    index,
  }));
}

function indexesOf(candidates: PaperContextCandidate[]): number[] {
  return candidates.map((candidate) => candidate.chunkIndex);
}

// ── Synthetic PdfContext with controlled section metadata ────────────────────

type ChunkSpec = {
  text: string;
  chunkKind?: PdfChunkKind;
  kindSource?: "manifest" | "heuristic";
  sectionIndex?: number;
  sectionLabel?: string;
  references?: DocumentReferenceEvidence[];
};

function buildStructuredContext(specs: ChunkSpec[]): PdfContext {
  const chunks = specs.map((spec) => spec.text);
  const docFreq: Record<string, number> = {};
  const chunkStats: ChunkStat[] = chunks.map((chunk, index) => {
    const tf: Record<string, number> = {};
    for (const term of tokenizeRetrievalText(chunk)) {
      tf[term] = (tf[term] || 0) + 1;
    }
    const uniqueTerms = Object.keys(tf);
    for (const term of uniqueTerms) docFreq[term] = (docFreq[term] || 0) + 1;
    return {
      index,
      length: tokenizeRetrievalText(chunk).length,
      tf,
      uniqueTerms,
    };
  });
  const chunkMeta: PdfChunkMeta[] = specs.map((spec, index) => ({
    chunkIndex: index,
    text: spec.text,
    normalizedText: spec.text.toLocaleLowerCase(),
    sectionLabel: spec.sectionLabel,
    sectionIndex: spec.sectionIndex,
    sectionPath: spec.sectionLabel,
    sectionLevel: spec.sectionIndex === undefined ? undefined : 2,
    chunkKind: spec.chunkKind || "body",
    kindSource: spec.kindSource,
    anchorText: spec.text.slice(0, 40),
    references: spec.references,
    sourceType: "mineru",
  }));
  return {
    title: "Structure Paper",
    chunks,
    chunkMeta,
    chunkStats,
    docFreq,
    avgChunkLength: chunkStats.length
      ? chunkStats.reduce((sum, stat) => sum + stat.length, 0) /
        chunkStats.length
      : 0,
    fullLength: chunks.join("\n\n").length,
    sourceType: "mineru",
  };
}

const LONG_BODY =
  "The measured front position follows the predicted scaling law over the whole integration window and the residual stays bounded.";

describe("selectStructuredCandidates", function () {
  it("caps chunks per section and back-fills from other sections", function () {
    const ranked = [
      ...[0, 1, 2, 3, 4, 5].map((chunkIndex) =>
        fakeCandidate({ chunkIndex, sectionIndex: 0 }),
      ),
      fakeCandidate({ chunkIndex: 6, sectionIndex: 1 }),
      fakeCandidate({ chunkIndex: 7, sectionIndex: 2 }),
      fakeCandidate({ chunkIndex: 8, sectionIndex: 3 }),
      fakeCandidate({ chunkIndex: 9, sectionIndex: 4 }),
    ];

    const selected = selectStructuredCandidates({
      ranked,
      topK: 6,
      queryTerms: ["nothing"],
      sections: sectionList(5),
      hasSignal: true,
    });

    assert.lengthOf(selected, 6);
    const fromSectionZero = selected.filter(
      (candidate) => candidate.sectionIndex === 0,
    );
    assert.isAtMost(fromSectionZero.length, 2);
    assert.includeMembers(indexesOf(selected), [6, 7, 8]);
    assert.isTrue(
      selected.some(
        (candidate) => candidate.why?.structureRule === "section_cap",
      ),
      "a back-filled chunk is explained by the per-section cap",
    );
  });

  it("fills every requested slot when the cap empties the pool's big section", function () {
    // Three sections holding 1, 9 and 1 chunks: the per-section cap of two
    // leaves four candidates, two slots short of the requested six.
    const ranked = [
      fakeCandidate({ chunkIndex: 0, sectionIndex: 0 }),
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((chunkIndex) =>
        fakeCandidate({ chunkIndex, sectionIndex: 1 }),
      ),
      fakeCandidate({ chunkIndex: 10, sectionIndex: 2 }),
    ];

    const selected = selectStructuredCandidates({
      ranked,
      topK: 6,
      queryTerms: ["nothing"],
      sections: sectionList(3),
      hasSignal: true,
    });

    assert.lengthOf(selected, 6);
    assert.includeMembers(
      indexesOf(selected),
      [0, 1, 2, 10],
      "the capped selection is kept",
    );
    assert.includeMembers(
      indexesOf(selected),
      [3, 4],
      "the empty slots are back-filled in rank order, cap or no cap",
    );
  });

  it("skips the structure rules for a read of fewer than four chunks", function () {
    const ranked = [
      fakeCandidate({ chunkIndex: 0, sectionIndex: 0 }),
      fakeCandidate({ chunkIndex: 1, sectionIndex: 0 }),
      fakeCandidate({ chunkIndex: 9, sectionIndex: 2 }),
    ];

    const selected = selectStructuredCandidates({
      ranked,
      topK: 2,
      queryTerms: ["kinematic"],
      sections: sectionList(3, {
        0: "1 Introduction",
        1: "3 Examples",
        2: "2.2 Kinematic condition",
      }),
      hasSignal: true,
    });

    assert.deepEqual(
      indexesOf(selected),
      [0, 1],
      "a narrow read is plain ranked order",
    );
    assert.isTrue(
      selected.every((candidate) => !candidate.why?.structureRule),
      "no structure rule claims a slot in a narrow read",
    );
  });

  it("guarantees a slot for a section whose heading matches the query", function () {
    const ranked = [
      ...[0, 1, 2, 3, 4, 5].map((chunkIndex) =>
        fakeCandidate({ chunkIndex, sectionIndex: 0 }),
      ),
      fakeCandidate({ chunkIndex: 8, sectionIndex: 1 }),
      fakeCandidate({ chunkIndex: 9, sectionIndex: 2 }),
    ];

    const selected = selectStructuredCandidates({
      ranked,
      topK: 4,
      queryTerms: ["kinematic"],
      sections: sectionList(3, {
        0: "1 Introduction",
        1: "3 Examples",
        2: "2.2 Kinematic condition",
      }),
      hasSignal: true,
    });

    const named = selected.find((candidate) => candidate.chunkIndex === 9);
    assert.isDefined(named, "the named section keeps a slot");
    assert.equal(named?.why?.structureRule, "heading_match");
  });

  it("adds the next chunk of the rank-1 hit when topK >= 6", function () {
    const ranked = [
      fakeCandidate({ chunkIndex: 4, sectionIndex: 1 }),
      fakeCandidate({ chunkIndex: 10, sectionIndex: 2 }),
      fakeCandidate({ chunkIndex: 11, sectionIndex: 3 }),
      fakeCandidate({ chunkIndex: 12, sectionIndex: 4 }),
      fakeCandidate({ chunkIndex: 13, sectionIndex: 5 }),
      fakeCandidate({ chunkIndex: 14, sectionIndex: 6 }),
      fakeCandidate({ chunkIndex: 5, sectionIndex: 1 }),
    ];

    const selected = selectStructuredCandidates({
      ranked,
      topK: 6,
      queryTerms: ["nothing"],
      sections: sectionList(7),
      hasSignal: true,
    });

    assert.lengthOf(selected, 6);
    assert.include(indexesOf(selected), 5);
    const neighbour = selected.find((candidate) => candidate.chunkIndex === 5);
    assert.equal(neighbour?.why?.structureRule, "neighbour");
  });

  it("returns one chunk per section in document order when there is no signal", function () {
    const ranked = [
      ...[0, 1, 2, 3, 4, 5].map((chunkIndex) =>
        fakeCandidate({ chunkIndex, sectionIndex: 0 }),
      ),
      fakeCandidate({ chunkIndex: 6, sectionIndex: 1 }),
      fakeCandidate({ chunkIndex: 7, sectionIndex: 1 }),
      fakeCandidate({ chunkIndex: 8, sectionIndex: 2 }),
      fakeCandidate({ chunkIndex: 9, sectionIndex: 2 }),
      fakeCandidate({ chunkIndex: 10, sectionIndex: 3 }),
    ];

    const selected = selectStructuredCandidates({
      ranked,
      topK: 4,
      queryTerms: [],
      sections: sectionList(4),
      hasSignal: false,
    });

    assert.deepEqual(indexesOf(selected), [0, 6, 8, 10]);
    assert.isTrue(
      selected.every(
        (candidate) =>
          candidate.why?.structureRule === "section_diverse_fallback",
      ),
    );
  });

  it("restricts the pool to the requested section ids", function () {
    const ranked = [
      fakeCandidate({ chunkIndex: 0, sectionIndex: 0 }),
      fakeCandidate({ chunkIndex: 1, sectionIndex: 0 }),
      fakeCandidate({ chunkIndex: 2, sectionIndex: 1 }),
      fakeCandidate({ chunkIndex: 3, sectionIndex: 2 }),
    ];

    const selected = selectStructuredCandidates({
      ranked,
      topK: 3,
      queryTerms: ["nothing"],
      sections: sectionList(3),
      sectionIds: ["s1", "s2", "s404"],
      hasSignal: true,
    });

    assert.deepEqual(indexesOf(selected).sort(), [2, 3]);
  });

  it("selects nothing when no candidate is in the requested sections", function () {
    const selected = selectStructuredCandidates({
      ranked: [
        fakeCandidate({ chunkIndex: 0, sectionIndex: 0 }),
        fakeCandidate({ chunkIndex: 1, sectionIndex: 1 }),
      ],
      topK: 3,
      queryTerms: ["nothing"],
      sections: sectionList(2),
      sectionIds: ["s404"],
      hasSignal: true,
    });

    assert.isEmpty(selected, "an empty scope never widens to the document");
  });
});

describe("bounded section prior", function () {
  let globalsBefore: TestGlobalSnapshot;

  before(function () {
    globalsBefore = snapshotTestGlobals();
    (globalThis as unknown as { ztoolkit: unknown }).ztoolkit = {
      log: () => {},
    };
    (globalThis as unknown as { Zotero: unknown }).Zotero = {
      Prefs: { get: () => undefined, set: () => {} },
    };
  });

  after(function () {
    restoreTestGlobals(globalsBefore);
  });

  it("never moves a chunk more than two ranks up and only for manifest kinds", async function () {
    const context = buildStructuredContext([
      {
        text: `Gamma delta epsilon gamma delta epsilon together. ${LONG_BODY}`,
        chunkKind: "body",
        kindSource: "manifest",
        sectionIndex: 0,
        sectionLabel: "2 Numerical algorithm",
      },
      {
        text: `Gamma delta epsilon appear together here as well. ${LONG_BODY}`,
        chunkKind: "body",
        kindSource: "manifest",
        sectionIndex: 1,
        sectionLabel: "3 Examples",
      },
      {
        text: `Gamma delta are paired once in this paragraph. ${LONG_BODY}`,
        chunkKind: "body",
        kindSource: "manifest",
        sectionIndex: 2,
        sectionLabel: "4 Examples in 2D",
      },
      {
        text: `Gamma gamma closes the argument in summary. ${LONG_BODY}`,
        chunkKind: "conclusion",
        kindSource: "manifest",
        sectionIndex: 3,
        sectionLabel: "5 Conclusion",
      },
      {
        text: `Gamma is mentioned once in this closing paragraph. ${LONG_BODY}`,
        chunkKind: "conclusion",
        kindSource: "heuristic",
        sectionIndex: 4,
        sectionLabel: "Closing remarks",
      },
    ]);

    const candidates = await buildPaperRetrievalCandidates(
      PAPER,
      context,
      "gamma delta epsilon",
      undefined,
      { topK: 5, mode: "evidence", disableEmbeddings: true },
    );

    const order = indexesOf(candidates);
    const byIndex = new Map(
      candidates.map((candidate) => [candidate.chunkIndex, candidate]),
    );
    // The fixture is only meaningful if the fused order is 0,1,2,3,4.
    for (const chunkIndex of [0, 1, 2, 3, 4]) {
      assert.equal(
        byIndex.get(chunkIndex)?.why?.bm25Rank,
        chunkIndex + 1,
        `chunk ${chunkIndex} is the fused rank ${chunkIndex + 1} hit`,
      );
    }
    assert.equal(byIndex.get(3)?.why?.priorShift, -2);
    assert.equal(byIndex.get(4)?.why?.priorShift, 0);
    assert.equal(
      order[0],
      0,
      "a two-rank prior cannot displace the best lexical match",
    );
    assert.isBelow(
      order.indexOf(3),
      order.indexOf(2),
      "the manifest conclusion at fused rank 4 moves up to adjusted rank 2",
    );
    assert.isAbove(
      order.indexOf(3),
      order.indexOf(1),
      "and no further: the fused rank-2 hit keeps the tie",
    );
    assert.equal(order[order.length - 1], 4, "a heuristic kind never moves");
    assert.isTrue(
      candidates.every(
        (candidate) => typeof candidate.why?.bm25Rank === "number",
      ),
    );
  });

  it("keeps the fused rank-1 chunk first when the next chunk is boosted", async function () {
    const context = buildStructuredContext([
      {
        text: `Gamma delta epsilon gamma delta epsilon together. ${LONG_BODY}`,
        chunkKind: "body",
        kindSource: "manifest",
        sectionIndex: 0,
        sectionLabel: "2 Numerical algorithm",
      },
      {
        text: `Gamma delta epsilon close the argument in summary. ${LONG_BODY}`,
        chunkKind: "conclusion",
        kindSource: "manifest",
        sectionIndex: 1,
        sectionLabel: "5 Conclusion",
      },
    ]);

    const candidates = await buildPaperRetrievalCandidates(
      PAPER,
      context,
      "gamma delta epsilon",
      undefined,
      { topK: 2, mode: "evidence", disableEmbeddings: true },
    );

    const byIndex = new Map(
      candidates.map((candidate) => [candidate.chunkIndex, candidate]),
    );
    assert.equal(byIndex.get(0)?.why?.bm25Rank, 1);
    assert.equal(byIndex.get(1)?.why?.bm25Rank, 2);
    assert.equal(byIndex.get(1)?.why?.priorShift, -2);
    assert.deepEqual(
      indexesOf(candidates),
      [0, 1],
      "the boosted conclusion cannot take the top slot from the best match",
    );
  });

  it("returns a body passage that sits behind a figure caption", async function () {
    // PDF text runs a caption straight into the body paragraph after it, so a
    // chunk that starts "Figure 2:" is classified as a caption while holding
    // the answer. Demoting it skipped the top-ranked passage (SEVA, "3700
    // sentences"); a replay over QASPER-200 found more gold evidence with no
    // caption demotion at all.
    const chunks = [
      "We collect simplification pairs from news articles written for two reading levels. Each article is aligned at the paragraph level before sentence alignment.",
      "The annotators read every aligned paragraph and mark the sentences that keep the original meaning while using simpler words and shorter clauses.",
      "We compare the systems with automatic metrics and a small human study, reporting fluency, adequacy and simplicity on a five point scale.",
      "Figure 2: Distribution of sentence lengths in the corpus.\nThe final corpus contains 3700 sentences that were simplified by trained annotators, split into training, development and test portions.",
    ];
    const chunkMeta = buildChunkMetadata(chunks, "zotero-worker");
    // Flat PDF text has no manifest, so the kind is the text heuristic's.
    assert.equal(chunkMeta[3].chunkKind, "figure-caption");
    assert.notEqual(chunkMeta[3].kindSource, "manifest");
    const context: PdfContext = {
      title: "Structure Paper",
      chunks,
      chunkMeta,
      ...buildChunkIndex(chunks),
      fullLength: chunks.join("\n\n").length,
      sourceType: "zotero-worker",
    };

    const candidates = await buildPaperRetrievalCandidates(
      PAPER,
      context,
      "how many sentences does the corpus contain",
      undefined,
      { topK: 3, mode: "evidence", disableEmbeddings: true },
    );

    assert.include(indexesOf(candidates), 3);
    const captionLed = candidates.find(
      (candidate) => candidate.chunkIndex === 3,
    );
    assert.notEqual(captionLed?.why?.demoted, true);
  });

  it("demotes references and short chunks to the end, never captions", async function () {
    const context = buildStructuredContext([
      {
        text: `Gamma delta epsilon are analysed in the reference list below. ${LONG_BODY}`,
        chunkKind: "references",
        kindSource: "manifest",
        sectionIndex: 0,
        sectionLabel: "References",
      },
      {
        text: `Figure 2: gamma delta epsilon over time. ${LONG_BODY}`,
        chunkKind: "figure-caption",
        kindSource: "heuristic",
        sectionIndex: 1,
        sectionLabel: "4 Examples in 2D",
      },
      {
        text: "Gamma delta epsilon.",
        chunkKind: "body",
        kindSource: "manifest",
        sectionIndex: 2,
        sectionLabel: "2 Numerical algorithm",
      },
      {
        text: `Gamma delta epsilon govern the discrete flux on every boundary face. ${LONG_BODY}`,
        chunkKind: "body",
        kindSource: "manifest",
        sectionIndex: 3,
        sectionLabel: "2.2 Kinematic condition",
      },
      {
        text: `Appendix A: gamma delta epsilon on the coarse grid. ${LONG_BODY}`,
        chunkKind: "appendix",
        kindSource: "heuristic",
        sectionIndex: 4,
        sectionLabel: "Appendix A",
      },
      {
        text: `Table 3: gamma delta epsilon for each mesh. ${LONG_BODY}`,
        chunkKind: "table-caption",
        kindSource: "manifest",
        sectionIndex: 5,
        sectionLabel: "5 Results",
      },
    ]);

    const candidates = await buildPaperRetrievalCandidates(
      PAPER,
      context,
      "gamma delta epsilon",
      undefined,
      { topK: 6, mode: "evidence", disableEmbeddings: true },
    );

    const order = indexesOf(candidates);
    assert.sameMembers(
      order.slice(0, 4),
      [1, 3, 4, 5],
      "body, caption and appendix chunks rank on relevance alone",
    );
    assert.sameMembers(order.slice(4), [0, 2]);
    for (const chunkIndex of [1, 4, 5]) {
      const kept = candidates.find(
        (candidate) => candidate.chunkIndex === chunkIndex,
      );
      assert.notEqual(kept?.why?.demoted, true, `chunk ${chunkIndex}`);
    }
    for (const chunkIndex of [0, 2]) {
      const demoted = candidates.find(
        (candidate) => candidate.chunkIndex === chunkIndex,
      );
      assert.isTrue(
        demoted?.why?.demoted,
        `chunk ${chunkIndex} is demoted to the end`,
      );
      // The explanation travels to the model as JSON, where an infinite
      // rank shift would arrive as null.
      const serialized = JSON.parse(JSON.stringify(demoted?.why || {}));
      assert.equal(serialized.priorShift, 0);
      assert.isTrue(serialized.demoted);
    }
  });

  it("demotes real reference lists but not prose that cites sources", async function () {
    const context = buildStructuredContext([
      {
        text: `Gamma delta epsilon set the bed roughness (Smith et al., 2019). ${LONG_BODY} Received 8 October; accepted 26 November 2001.`,
        chunkKind: "body",
        kindSource: "manifest",
        sectionIndex: 0,
        sectionLabel: "Bed roughness",
      },
      {
        text: [
          "[1] J. Smith, Gamma delta epsilon over rough beds, J. Fluid Mech. 431, 2001.",
          "[2] R. Lee, Sediment transport in gravel rivers, Water Resour. Res. 38, 2002.",
          "[3] M. Novak, Roughness length of river beds, Earth Surf. Proc. 27, 2003.",
          "[4] T. Ibarra, Drag partition on mobile beds, J. Geophys. Res. 109, 2004.",
          "[5] K. Oyama, Bedload flux and shear stress, Sedimentology 52, 2005.",
          "[6] P. Duarte, Grain size and flow resistance, Geomorphology 71, 2006.",
        ].join("\n"),
        chunkKind: "body",
        kindSource: "heuristic",
        sectionIndex: 1,
        sectionLabel: "Works consulted",
      },
    ]);

    const candidates = await buildPaperRetrievalCandidates(
      PAPER,
      context,
      "gamma delta epsilon",
      undefined,
      { topK: 2, mode: "evidence", disableEmbeddings: true },
    );

    const byIndex = new Map(
      candidates.map((candidate) => [candidate.chunkIndex, candidate]),
    );
    assert.equal(
      byIndex.get(0)?.why?.priorShift,
      0,
      "prose with an inline citation and a received-date line keeps its rank",
    );
    assert.isTrue(
      byIndex.get(1)?.why?.demoted,
      "six numbered reference entries are a reference list",
    );
    assert.equal(indexesOf(candidates)[0], 0);
  });

  it("keeps a reference-locked caption first and a locked chunk present", async function () {
    const context = buildStructuredContext([
      {
        text: `Gamma delta epsilon govern the discrete flux on every boundary face. ${LONG_BODY}`,
        chunkKind: "body",
        kindSource: "manifest",
        sectionIndex: 0,
        sectionLabel: "2 Numerical algorithm",
      },
      {
        text: `Figure 1: the spreading drop at four times. ${LONG_BODY}`,
        chunkKind: "figure-caption",
        kindSource: "manifest",
        sectionIndex: 1,
        sectionLabel: "3 Examples in 1D",
        references: [
          {
            kind: "figure",
            id: "1",
            confidence: "high",
            provenance: ["caption-anchor"],
          },
        ],
      },
      {
        text: `The receding rim is measured over forty steps in this paragraph. ${LONG_BODY}`,
        chunkKind: "references",
        kindSource: "manifest",
        sectionIndex: 2,
        sectionLabel: "References",
      },
    ]);

    const candidates = await buildPaperRetrievalCandidates(
      PAPER,
      context,
      "explain Figure 1 and the gamma delta epsilon flux",
      undefined,
      {
        topK: 1,
        mode: "evidence",
        disableEmbeddings: true,
        preferredChunkIndexes: [2],
      },
    );

    assert.equal(
      candidates[0].chunkIndex,
      1,
      "a high-confidence figure match leads the read",
    );
    assert.equal(candidates[0].referenceConfidence, "high");
    assert.include(
      indexesOf(candidates),
      2,
      "a locked chunk stays in the set even when its kind is demoted",
    );
  });
});

describe("structure stage on the math fixture", function () {
  this.timeout(60000);

  let globalsBefore: TestGlobalSnapshot;

  before(function () {
    globalsBefore = snapshotTestGlobals();
  });

  after(function () {
    restoreTestGlobals(globalsBefore);
  });

  it("does not put the conclusion first for a body query", async function () {
    const ctx = await buildFixturePdfContext("mathDoubleHash", 9201);
    const paperRef: PaperContextRef = {
      itemId: 100,
      contextItemId: 9201,
      title: "Mock",
      firstCreator: "Tester",
      year: "2026",
    };
    const plan = buildRetrievalQueryPlan({
      query: "kinematic relation between film height and normal speed",
    });

    const out = await buildPaperRetrievalCandidates(
      paperRef,
      ctx,
      plan.originalQuery,
      { queryPlan: plan },
      { topK: 8, mode: "evidence", queryPlan: plan },
    );

    assert.include(out[0].sectionPath || "", "2.2 Kinematic condition");
    assert.isTrue(
      out.every((candidate) => typeof candidate.why?.bm25Rank === "number"),
    );
    assert.notEqual(out[0].chunkKind, "conclusion");
  });

  it("keeps a chunk-index scope: only those chunks, never the whole document", async function () {
    const ctx = await buildFixturePdfContext("mathDoubleHash", 9203);
    const paperRef: PaperContextRef = {
      itemId: 103,
      contextItemId: 9203,
      title: "Mock",
      firstCreator: "Tester",
      year: "2026",
    };
    const plan = buildRetrievalQueryPlan({
      query: "kinematic relation between film height and normal speed",
    });
    const read = (chunkIndexes: number[]) =>
      buildPaperRetrievalCandidates(
        paperRef,
        ctx,
        plan.originalQuery,
        { queryPlan: plan },
        { topK: 8, mode: "evidence", queryPlan: plan, chunkIndexes },
      );
    const scoped = await read([1, 3]);
    assert.isNotEmpty(scoped);
    for (const candidate of scoped)
      assert.include([1, 3], candidate.chunkIndex);
    assert.isEmpty(await read([99_999]), "an empty scope never widens");
  });

  it("returns nothing for a requested section that holds no passages", async function () {
    const ctx = await buildFixturePdfContext("mathDoubleHash", 9202);
    const paperRef: PaperContextRef = {
      itemId: 101,
      contextItemId: 9202,
      title: "Mock",
      firstCreator: "Tester",
      year: "2026",
    };
    const plan = buildRetrievalQueryPlan({
      query: "kinematic relation between film height and normal speed",
    });
    const readSection = async (
      sectionId: string,
    ): Promise<PaperContextCandidate[]> =>
      buildPaperRetrievalCandidates(
        paperRef,
        ctx,
        plan.originalQuery,
        { queryPlan: plan },
        {
          topK: 8,
          mode: "evidence",
          queryPlan: plan,
          sectionIds: [sectionId],
        },
      );

    // No chunk of the fixture carries section s999.
    assert.isEmpty(
      await readSection("s999"),
      "an empty scope never widens to the whole document",
    );

    const chunksPerSection = new Map<number, number>();
    for (const meta of ctx.chunkMeta) {
      if (meta.sectionIndex === undefined) continue;
      chunksPerSection.set(
        meta.sectionIndex,
        (chunksPerSection.get(meta.sectionIndex) || 0) + 1,
      );
    }
    const [populatedSectionIndex] = [...chunksPerSection.entries()].sort(
      (left, right) => right[1] - left[1] || left[0] - right[0],
    )[0];
    const inScope = await readSection(`s${populatedSectionIndex}`);
    assert.isNotEmpty(inScope, "a populated section still reads");
    for (const candidate of inScope) {
      assert.equal(
        candidate.sectionIndex,
        populatedSectionIndex,
        candidate.chunkText.slice(0, 60),
      );
    }
  });
});
