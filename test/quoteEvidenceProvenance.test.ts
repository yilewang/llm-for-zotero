import { assert } from "chai";
import {
  clearQuoteEvidenceProvenanceCacheForTests,
  resolveQuoteEvidenceProvenance,
} from "../src/modules/contextPanel/quoteEvidenceProvenance";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: any;
  ztoolkit?: any;
};

const KEINATH_PASSAGE =
  "long-timescale changes in population activity occur orthogonally to the representation of context in network space, allowing for consistent readout of contextual information across weeks";
const RULE_PASSAGE =
  "to what extent can ongoing drift in task representations be confined to a null coding space over extended periods while maintaining an accurate readout";

/** The shape a real `library_retrieve` result has. */
function libraryRetrieveEvent(
  snippets: Array<Record<string, unknown>>,
  options?: { ok?: boolean },
) {
  return {
    type: "tool_result",
    callId: "call_1",
    name: "library_retrieve",
    ok: options?.ok ?? true,
    content: {
      queryPlan: { originalQuery: "drift in the null space" },
      candidates: [{ itemId: "52", title: "Stable task information" }],
      snippets,
    },
  };
}

const DEFAULT_SNIPPETS = [
  {
    snippetId: "lr_52_205_2_exact",
    itemId: "52",
    contextItemId: "205",
    title: "Stable task information from an unstable neural population",
    citationLabel: "Rule et al., 2020",
    snippet: `Introduction. ${RULE_PASSAGE} of behavioral variables.`,
  },
  {
    snippetId: "lr_2242_2241_0_exact",
    itemId: "2242",
    contextItemId: "2241",
    title: "The representation of context in mouse hippocampus",
    citationLabel: "Keinath et al., 2022",
    snippet: `Abstract. We show that ${KEINATH_PASSAGE}.`,
  },
];

function installRun(events: unknown[], options?: { fail?: boolean }): void {
  globalScope.ztoolkit = { log: () => undefined };
  globalScope.Zotero = {
    DB: {
      queryAsync: async () => {
        if (options?.fail) throw new Error("database is unavailable");
        return events.map((payload, index) => ({
          runId: "run-1",
          seq: index + 1,
          eventType: "tool_result",
          payloadJson: JSON.stringify(payload),
          createdAt: 1,
        }));
      },
    },
  };
  clearQuoteEvidenceProvenanceCacheForTests();
}

describe("quote evidence provenance", function () {
  afterEach(function () {
    delete globalScope.Zotero;
    delete globalScope.ztoolkit;
    clearQuoteEvidenceProvenanceCacheForTests();
  });

  it("resolves a quote to the paper the agent actually read it from", async function () {
    installRun([libraryRetrieveEvent(DEFAULT_SNIPPETS)]);

    const resolved = await resolveQuoteEvidenceProvenance({
      agentRunId: "run-1",
      quoteText: `"${KEINATH_PASSAGE}."`,
    });

    assert.deepEqual(
      resolved.map((entry) => [entry.itemId, entry.contextItemId]),
      [[2242, 2241]],
    );
  });

  it("returns every paper that accounts for the quote, best first", async function () {
    // A library holding a preprint and the published copy records the same
    // text twice; the caller breaks the tie with the citation label, so both
    // have to come back rather than whichever the retrieval returned first.
    installRun([
      libraryRetrieveEvent([
        {
          itemId: "900",
          contextItemId: "901",
          title: "Preprint copy",
          snippet: `Abstract. We show that ${KEINATH_PASSAGE}.`,
        },
        ...DEFAULT_SNIPPETS,
      ]),
    ]);

    const resolved = await resolveQuoteEvidenceProvenance({
      agentRunId: "run-1",
      quoteText: `"${KEINATH_PASSAGE}."`,
    });

    assert.sameMembers(
      resolved.map((entry) => entry.contextItemId),
      [901, 2241],
      "both copies are offered to the caller",
    );
  });

  it("finds passages whose ids sit on a parent rather than beside the text", async function () {
    // paper_read nests the ids under paperContext and puts the text on a
    // sibling; library_retrieve puts both on one record.
    installRun([
      {
        type: "tool_result",
        callId: "call_2",
        name: "paper_read",
        ok: true,
        content: {
          results: [
            {
              paperContext: {
                itemId: 2242,
                contextItemId: 2241,
                title: "The representation of context in mouse hippocampus",
              },
              passages: [{ text: `Results. We show that ${KEINATH_PASSAGE}.` }],
            },
          ],
        },
      },
    ]);

    const resolved = await resolveQuoteEvidenceProvenance({
      agentRunId: "run-1",
      quoteText: `"${KEINATH_PASSAGE}."`,
    });

    assert.deepEqual(
      resolved.map((entry) => entry.contextItemId),
      [2241],
    );
  });

  it("credits the paper holding both halves of a stitched quote", async function () {
    installRun([
      libraryRetrieveEvent([
        {
          itemId: "3603",
          contextItemId: "3604",
          title: "Coordinated representational drift",
          snippet:
            "One solution might be that target networks are relatively unaffected by drift if it occurs in a null-space",
        },
        {
          itemId: "3603",
          contextItemId: "3604",
          title: "Coordinated representational drift",
          snippet:
            "spatial map drift in the posterior parietal cortex occurs in part outside of null-space dimensions",
        },
      ]),
    ]);

    const resolved = await resolveQuoteEvidenceProvenance({
      agentRunId: "run-1",
      quoteText:
        '"One solution might be that target networks are relatively unaffected by drift if it occurs in a null-space… spatial map drift in the posterior parietal cortex occurs in part outside of null-space dimensions."',
    });

    assert.deepEqual(
      resolved.map((entry) => entry.contextItemId),
      [3604],
    );
    assert.isAtLeast(resolved[0].coverage, 0.8);
  });

  it("resolves nothing for a quote the run never recorded", async function () {
    installRun([libraryRetrieveEvent(DEFAULT_SNIPPETS)]);

    const resolved = await resolveQuoteEvidenceProvenance({
      agentRunId: "run-1",
      quoteText:
        '"The hippocampus encodes grocery lists in a dedicated shopping subspace that is stable across decades."',
    });

    assert.isEmpty(resolved);
  });

  it("does not trust the result of a failed tool call", async function () {
    installRun([libraryRetrieveEvent(DEFAULT_SNIPPETS, { ok: false })]);

    const resolved = await resolveQuoteEvidenceProvenance({
      agentRunId: "run-1",
      quoteText: `"${KEINATH_PASSAGE}."`,
    });

    assert.isEmpty(resolved);
  });

  it("degrades quietly when the run trace cannot be read", async function () {
    installRun([], { fail: true });

    const resolved = await resolveQuoteEvidenceProvenance({
      agentRunId: "run-1",
      quoteText: `"${KEINATH_PASSAGE}."`,
    });

    assert.isEmpty(resolved, "the caller falls back to searching");
  });

  it("retries after a transient database failure instead of giving up for good", async function () {
    let shouldFail = true;
    globalScope.ztoolkit = { log: () => undefined };
    globalScope.Zotero = {
      DB: {
        queryAsync: async () => {
          if (shouldFail) throw new Error("database is locked");
          return [
            {
              runId: "run-1",
              seq: 1,
              eventType: "tool_result",
              payloadJson: JSON.stringify(
                libraryRetrieveEvent(DEFAULT_SNIPPETS),
              ),
              createdAt: 1,
            },
          ];
        },
      },
    };
    clearQuoteEvidenceProvenanceCacheForTests();

    const quoteText = `"${KEINATH_PASSAGE}."`;
    assert.isEmpty(
      await resolveQuoteEvidenceProvenance({ agentRunId: "run-1", quoteText }),
    );

    // A locked database during sync is transient; caching that failure would
    // disable provenance for the rest of the session.
    shouldFail = false;
    const recovered = await resolveQuoteEvidenceProvenance({
      agentRunId: "run-1",
      quoteText,
    });

    assert.deepEqual(
      recovered.map((entry) => entry.contextItemId),
      [2241],
    );
  });

  it("resolves nothing without a run to ask", async function () {
    installRun([libraryRetrieveEvent(DEFAULT_SNIPPETS)]);

    assert.isEmpty(
      await resolveQuoteEvidenceProvenance({
        agentRunId: "",
        quoteText: `"${KEINATH_PASSAGE}."`,
      }),
    );
    assert.isEmpty(
      await resolveQuoteEvidenceProvenance({
        agentRunId: "run-1",
        quoteText: "   ",
      }),
    );
  });

  it("skips records that cannot name an attachment to open", async function () {
    installRun([
      libraryRetrieveEvent([
        {
          itemId: "2242",
          title: "The representation of context in mouse hippocampus",
          snippet: `Abstract. We show that ${KEINATH_PASSAGE}.`,
        },
      ]),
    ]);

    const resolved = await resolveQuoteEvidenceProvenance({
      agentRunId: "run-1",
      quoteText: `"${KEINATH_PASSAGE}."`,
    });

    assert.isEmpty(resolved);
  });

  it("reads the run once and reuses it for later clicks", async function () {
    let reads = 0;
    globalScope.ztoolkit = { log: () => undefined };
    globalScope.Zotero = {
      DB: {
        queryAsync: async () => {
          reads += 1;
          return [
            {
              runId: "run-1",
              seq: 1,
              eventType: "tool_result",
              payloadJson: JSON.stringify(
                libraryRetrieveEvent(DEFAULT_SNIPPETS),
              ),
              createdAt: 1,
            },
          ];
        },
      },
    };
    clearQuoteEvidenceProvenanceCacheForTests();

    await resolveQuoteEvidenceProvenance({
      agentRunId: "run-1",
      quoteText: `"${KEINATH_PASSAGE}."`,
    });
    await resolveQuoteEvidenceProvenance({
      agentRunId: "run-1",
      quoteText: `"${RULE_PASSAGE} of behavioral variables."`,
    });

    assert.equal(reads, 1);
  });
});
