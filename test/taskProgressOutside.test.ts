import { assert } from "chai";
import type { AgentEvent } from "../src/agent/types";
import {
  buildTaskOutsideTurn,
  movesTaskOutside,
  outsideSourceKey,
  quoteAroundOffset,
} from "../src/modules/contextPanel/taskProgress/outside";
import {
  buildTaskOutsideGroups,
  countTaskOutside,
  findTaskSource,
} from "../src/modules/contextPanel/taskProgress/outsideView";
import {
  applyTaskOutsideEvent,
  beginTaskRun,
  clearAllTaskProgress,
  getTaskProgress,
} from "../src/modules/contextPanel/taskProgress/store";
import { paperSourceId } from "../src/webAccess/paperSources";

const ev = (payload: Record<string, unknown>) => payload as AgentEvent;
const wrap = (events: AgentEvent[]) => events.map((payload) => ({ payload }));

const arden = {
  title: "Sample VR study shows cell change is intrinsic",
  authors: ["Ann Arden", "Bo Lee"],
  year: 2025,
  doi: "10.1101/2025.01.01.000001",
  sourceUrl: "https://www.biorxiv.org/content/10.1101/2025.01.01.000001",
};
const ardenId = paperSourceId("doi:10.1101/2025.01.01.000001");
const page = (n: number, extra: Record<string, unknown> = {}) => ({
  sourceId: `web_${n}`,
  url: `https://site${n}.example.org/page`,
  hostname: `site${n}.example.org`,
  organization: `Site ${n}`,
  title: `Page ${n}`,
  snippet: `Snippet ${n}`,
  ...extra,
});
const anchorSource = (n: number) => {
  const { snippet: _snippet, ...source } = page(n);
  return source;
};

const turnEvents = (): AgentEvent[] => [
  ev({
    type: "tool_call",
    name: "library_search",
    callId: "c0",
    args: { query: "drift" },
  }),
  ev({
    type: "tool_call",
    name: "literature_search",
    callId: "c1",
    args: { query: "drift", need: "not_in_scope_or_library" },
  }),
  ev({
    type: "tool_result",
    name: "literature_search",
    callId: "c1",
    ok: true,
    content: {
      results: [{ ...arden, abstract: "We held behavior constant." }],
    },
  }),
  ev({
    type: "tool_result",
    name: "literature_read",
    callId: "c2",
    ok: true,
    content: {
      paper: arden,
      abstract: "We held behavior constant.",
      passages: [{ section: "Results", text: "Drift persisted." }],
    },
  }),
  ev({
    type: "tool_call",
    name: "web_search",
    callId: "c3",
    args: { query: "drift review", need: "current_or_public_facts" },
  }),
  ev({
    type: "tool_result",
    name: "web_search",
    callId: "c3",
    ok: true,
    content: { results: [page(1), page(2)] },
  }),
  ev({
    type: "tool_result",
    name: "web_read",
    callId: "c4",
    ok: true,
    content: { pages: [{ ...page(2), content: "Full text of page 2." }] },
  }),
  ev({
    type: "final",
    text: "Drift is intrinsic. Arden et al. held behavior constant. A review agrees.",
    webSourceAnchors: [
      {
        offset: "Drift is intrinsic. Arden et al.".length,
        placement: "inline",
        sources: [
          {
            sourceId: ardenId,
            kind: "paper",
            url: arden.sourceUrl,
            hostname: "www.biorxiv.org",
            organization: "bioRxiv",
            title: arden.title,
          },
        ],
      },
      {
        offset:
          "Drift is intrinsic. Arden et al. held behavior constant. A review agrees."
            .length,
        sources: [anchorSource(2), anchorSource(9)],
      },
    ],
  }),
];

describe("task progress: sources from outside the library", function () {
  afterEach(function () {
    clearAllTaskProgress();
  });

  it("folds a run's papers and pages, how far it read them, and why", function () {
    const turn = buildTaskOutsideTurn("run-a", wrap(turnEvents()));
    assert.isNotNull(turn);
    if (!turn) return;
    assert.isTrue(turn.librarySearched);
    assert.sameMembers(turn.searched, ["paper", "web"]);
    assert.isString(turn.why.paper);
    assert.isString(turn.why.web);
    const [paper, one, two] = turn.sources;
    assert.equal(paper.key, ardenId);
    assert.equal(paper.kind, "paper");
    // An abstract and a passage: read, not only skimmed.
    assert.equal(paper.state, "read");
    assert.deepEqual(
      paper.reads.map((read) => read.label),
      ["Abstract", "Results"],
    );
    assert.isTrue(paper.cited);
    assert.deepEqual(paper.quotes, [
      { text: "Arden et al. held behavior constant.", anchor: 0 },
    ]);
    assert.equal(one.state, "found");
    assert.isFalse(one.cited);
    assert.equal(two.state, "read");
    assert.isTrue(two.cited);
    // A page the answer cites that this run never found came from earlier.
    assert.deepEqual(
      turn.earlier.map((source) => source.key),
      [outsideSourceKey({ url: page(9).url })],
    );
  });

  it("keeps only the answer of a run that searched nowhere, and nothing without one", function () {
    const turn = buildTaskOutsideTurn(
      "run-x",
      wrap([ev({ type: "final", text: "Hello." })]),
    );
    assert.equal(turn?.answer, "Hello.");
    assert.isEmpty(turn?.sources);
    assert.isEmpty(turn?.searched);
    assert.isFalse(turn?.librarySearched);
    assert.isNull(buildTaskOutsideTurn("run-y", wrap([])));
    assert.isFalse(
      movesTaskOutside(ev({ type: "tool_call", name: "read_paper", args: {} })),
    );
    assert.isTrue(
      movesTaskOutside(ev({ type: "tool_call", name: "web_read", args: {} })),
    );
  });

  it("counts a source the answer links, by its page or its DOI", function () {
    const events = turnEvents().slice(0, -1);
    events.push(
      ev({
        type: "tool_result",
        name: "web_search",
        callId: "c5",
        ok: true,
        content: {
          results: [
            page(3, {
              title:
                "A BCI study - PubMed - doi: 10.1016/j.sample.2025.02.001.",
            }),
          ],
        },
      }),
      ev({
        type: "final",
        text: [
          "Drift is intrinsic, as Arden showed ([link](https://doi.org/10.1101/2025.01.01.000001)).",
          'A page says so too ([see](https://site1.example.org/page/ "exact words")).',
          "Humans too ([link](https://doi.org/10.1016/J.SAMPLE.2025.02.001)).",
        ].join(" "),
      }),
    );
    const turn = buildTaskOutsideTurn("run-l", wrap(events));
    const [paper, one, , three] = turn!.sources;
    assert.deepEqual(paper.quotes, [
      { text: "Drift is intrinsic, as Arden showed.", anchor: -1 },
    ]);
    assert.deepEqual(one.quotes, [
      { text: "A page says so too (see).", anchor: -1, phrase: "exact words" },
    ]);
    assert.isTrue(three.cited);
    assert.equal(three.quotes[0].text, "Humans too.");
  });

  it("quotes the answer's sentence around a marker, as plain words", function () {
    const text =
      "First point. The **second** one [cites](https://x.org) it. Third.";
    assert.equal(
      quoteAroundOffset(text, text.indexOf(" it.")),
      "The second one cites it.",
    );
    assert.equal(quoteAroundOffset("- A list item\n- Next", 5), "A list item");
    // A ">" or "_" in the words stays, as the chat shows them.
    const marks =
      "Over >90% of $J_{ij}$ drift_rate units _moved_ [x](https://x.org).";
    assert.equal(
      quoteAroundOffset(marks, marks.indexOf(" [x]")),
      "Over >90% of $J_{ij}$ drift_rate units moved x.",
    );
    // The bare "(link)" after a citation goes, with its "; ".
    const link =
      "A test (Arden et al., 2025, *Neuron*; [link](https://doi.org/10.1/x)) holds.";
    assert.equal(
      quoteAroundOffset(link, link.indexOf("[link]")),
      "A test (Arden et al., 2025, Neuron) holds.",
    );
  });

  it("files live events under their question and groups a follow-up's reuse", function () {
    beginTaskRun(7, { runId: "run-a" });
    for (const event of turnEvents()) applyTaskOutsideEvent(7, "run-a", event);
    beginTaskRun(7, { runId: "run-b" });
    applyTaskOutsideEvent(
      7,
      "run-b",
      ev({
        type: "final",
        text: "As before, page 2 says so.",
        webSourceAnchors: [{ offset: 25, sources: [anchorSource(2)] }],
      }),
    );
    const record = getTaskProgress(7);
    assert.deepEqual(Object.keys(record?.outside || {}), ["1", "2"]);
    const passageLabel = () => "Passage";
    const first = buildTaskOutsideGroups(record, 1, {
      completed: true,
      passageLabel,
    });
    assert.lengthOf(first?.scholarly.used || [], 1);
    // Page 2 is used, and page 9 the answer cites from before; page 1 was
    // only found.
    assert.deepEqual(
      first?.web.used.map((row) => row.key),
      [
        outsideSourceKey({ url: page(9).url }),
        outsideSourceKey({ url: page(2).url }),
      ],
    );
    assert.lengthOf(first?.web.unused || [], 1);
    assert.isFalse(first?.offer);
    assert.deepEqual(countTaskOutside(record, 1), {
      total: 3,
      read: 2,
      found: 1,
      cited: 3,
    });
    const second = buildTaskOutsideGroups(record, 2, {
      completed: true,
      passageLabel,
    });
    assert.lengthOf(second?.scholarly.used || [], 0);
    assert.lengthOf(second?.web.unused || [], 0);
    // The reused page is used, under Web, with the first question's reads
    // and its number.
    const reused = second?.web.used || [];
    assert.lengthOf(reused, 1);
    assert.equal(reused[0].fromTurn, 1);
    assert.equal(reused[0].state, "read");
    assert.deepEqual(reused[0].quotes, [
      { text: "As before, page 2 says so.", anchor: 0 },
    ]);
    assert.equal(
      findTaskSource(record, (source) => source.url === page(2).url, 2)?.turn,
      2,
    );
  });

  it("offers to search further when only the library was searched", function () {
    beginTaskRun(8, { runId: "run-l" });
    applyTaskOutsideEvent(
      8,
      "run-l",
      ev({ type: "tool_call", name: "library_search", callId: "c", args: {} }),
    );
    applyTaskOutsideEvent(8, "run-l", ev({ type: "final", text: "Done." }));
    const options = { completed: true, passageLabel: () => "" };
    const groups = buildTaskOutsideGroups(getTaskProgress(8), 1, options);
    assert.isTrue(groups?.offer);
    assert.isFalse(
      buildTaskOutsideGroups(getTaskProgress(8), 1, {
        ...options,
        completed: false,
      })?.offer,
    );
  });
});
