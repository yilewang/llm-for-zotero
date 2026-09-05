import { assert } from "chai";
import { extractPaperContextCandidatesFromToolContentForTests as extractPaperContextCandidatesFromToolContent } from "../src/modules/contextPanel/agentMode/agentEngine";
import { normalizePaperContextRefs } from "../src/modules/contextPanel/normalizers";

function paperRefs(content: unknown) {
  return normalizePaperContextRefs(
    extractPaperContextCandidatesFromToolContent(content),
  );
}

/**
 * Shape of a real `library_retrieve` result: the papers the answer is grounded
 * in are only identifiable through `snippets`, which is the sole place where
 * both itemId and contextItemId appear.
 */
const LIBRARY_RETRIEVE_RESULT = {
  queryPlan: { originalQuery: "drift in the null space" },
  intent: "enumerate",
  depth: "evidence",
  candidates: [
    { itemId: "52", title: "Stable task information", score: 12 },
    { itemId: "2242", title: "The representation of context", score: 9 },
  ],
  paperMatches: [
    { itemId: "52", title: "Stable task information", matchStatus: "strong" },
  ],
  coverageReceipt: { scanned: 131 },
  snippets: [
    {
      snippetId: "lr_52_205_2_exact",
      itemId: "52",
      contextItemId: "205",
      title: "Stable task information from an unstable neural population",
      citationLabel: "Rule et al., 2020",
      sourceLabel: "(Rule et al., 2020)",
      snippet: "to what extent can ongoing drift be confined to a null space",
    },
    {
      snippetId: "lr_2242_2241_0_exact",
      itemId: "2242",
      contextItemId: "2241",
      title: "The representation of context in mouse hippocampus",
      citationLabel: "Keinath et al., 2022",
      sourceLabel: "(Keinath et al., 2022)",
      snippet: "long-timescale changes occur orthogonally to context",
    },
    {
      snippetId: "lr_2242_2241_3_exact",
      itemId: "2242",
      contextItemId: "2241",
      title: "The representation of context in mouse hippocampus",
      citationLabel: "Keinath et al., 2022",
      snippet: "a second passage from the same paper",
    },
  ],
  warnings: [],
};

describe("agent evidence paper contexts", function () {
  it("recovers the papers a library retrieval actually quoted from", function () {
    const refs = paperRefs(LIBRARY_RETRIEVE_RESULT);

    assert.deepEqual(
      refs.map((ref) => [ref.itemId, ref.contextItemId]),
      [
        [52, 205],
        [2242, 2241],
      ],
    );
    assert.equal(
      refs[1].title,
      "The representation of context in mouse hippocampus",
    );
  });

  it("keeps recovering papers from tool shapes it already understood", function () {
    const refs = paperRefs({
      results: [
        {
          paperContext: {
            itemId: 3603,
            contextItemId: 3604,
            title: "Coordinated representational drift",
          },
          passages: [{ text: "..." }],
        },
      ],
    });

    assert.deepEqual(
      refs.map((ref) => [ref.itemId, ref.contextItemId]),
      [[3603, 3604]],
    );
  });

  it("finds evidence papers nested under keys nobody enumerated in advance", function () {
    const refs = paperRefs({
      evidencePack: {
        groupedByPaper: {
          "3603": {
            passages: [
              {
                itemId: 3603,
                contextItemId: 3604,
                title: "Coordinated representational drift",
              },
            ],
          },
        },
      },
    });

    assert.deepEqual(
      refs.map((ref) => [ref.itemId, ref.contextItemId]),
      [[3603, 3604]],
    );
  });

  it("ignores records that cannot identify an attachment", function () {
    const refs = paperRefs({
      candidates: [{ itemId: 52, title: "No attachment here" }],
      paperMatches: [{ itemId: 52, contextItemId: 205 }],
      other: [{ contextItemId: 205, title: "No item id" }],
    });

    assert.lengthOf(refs, 0);
  });

  it("does not recurse without bound", function () {
    const deep: Record<string, unknown> = {
      itemId: 7,
      contextItemId: 8,
      title: "Deep paper",
    };
    let root: Record<string, unknown> = deep;
    for (let index = 0; index < 40; index += 1) {
      root = { nested: root };
    }

    assert.lengthOf(paperRefs(root), 0);
  });

  it("survives cyclic tool content", function () {
    const cyclic: Record<string, unknown> = {
      snippets: [
        {
          itemId: 2242,
          contextItemId: 2241,
          title: "The representation of context",
        },
      ],
    };
    cyclic.self = cyclic;

    assert.deepEqual(
      paperRefs(cyclic).map((ref) => ref.itemId),
      [2242],
    );
  });
});
