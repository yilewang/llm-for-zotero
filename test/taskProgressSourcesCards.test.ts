import { assert } from "chai";
import {
  answerSectionAt,
  sourceDoi,
  sourcePii,
} from "../src/modules/contextPanel/taskProgress/outside";
import {
  buildTaskCitedModel,
  cleanSourceTitle,
  findLibraryPaperInAnswer,
  findNamedInAnswer,
  formatTaskCitedLabel,
  formatTaskGroupCounts,
  hasTaskCitedContent,
  isTaskReadCited,
  mergeSameWork,
  workTitleKey,
  type TaskSourceRow,
} from "../src/modules/contextPanel/taskProgress/outsideView";
import type { TaskPaperReadEvent } from "../src/agent/context/taskPaperLedger";
import type { TaskAnswerCitation } from "../src/modules/contextPanel/taskProgress/answerCitations";
import { formatTaskPaperChatCounts } from "../src/modules/contextPanel/taskProgress/view";
import { findExactPhrases } from "../src/modules/contextPanel/sourcePageView";
import {
  findQuoteAroundGaps,
  foldAnswerWords,
  sentenceClosingIndexes,
} from "../src/modules/contextPanel/answerQuoteHighlight";

const row = (
  key: string,
  kind: "paper" | "web",
  title: string,
  url: string,
  extra: Partial<TaskSourceRow> = {},
): TaskSourceRow => ({
  key,
  keys: [key],
  kind,
  title,
  sub: "",
  url,
  state: "found",
  cited: false,
  reads: [],
  quotes: [],
  ...extra,
});

describe("task progress: sources as cards", function () {
  it("keeps one row for one work found in several places", function () {
    const paper = row(
      "paper_1",
      "paper",
      "Tracking imagined movement codes over many days in a sample study",
      "https://doi.org/10.1016/j.sample.2025.02.001",
      {
        cited: true,
        quotes: [{ text: "Human BCI evidence.", anchor: 0 }],
      },
    );
    const merged = mergeSameWork(
      [paper],
      [
        // Its DOI in the link.
        row(
          "web:a",
          "web",
          "Full text",
          "https://www.example-journal.com/fulltext/10.1016/j.sample.2025.02.001",
          { state: "read" },
        ),
        // Its title, with the site's name after it.
        row(
          "web:b",
          "web",
          "Tracking imagined movement codes over many days in a sample study - ScienceDirect",
          "https://www.sciencedirect.com/science/article/pii/S1234",
          { quotes: [{ text: "Stable control for weeks.", anchor: 2 }] },
        ),
        // Two pages of another work become one row.
        row(
          "web:c",
          "web",
          "Why habits last while cells change in a memory area",
          "https://x.org/1",
        ),
        row(
          "web:d",
          "web",
          "Why habits last while cells change in a memory area | Journal",
          "https://y.org/2",
        ),
        row("web:e", "web", "Short", "https://z.org/3"),
      ],
    );
    assert.lengthOf(merged.scholarly, 1);
    const one = merged.scholarly[0];
    assert.deepEqual(one.keys, ["paper_1", "web:a", "web:b"]);
    assert.deepEqual(
      one.quotes.map((quote) => quote.text),
      ["Human BCI evidence.", "Stable control for weeks."],
    );
    // It opens where the agent read most of it.
    assert.equal(one.state, "read");
    assert.equal(
      one.url,
      "https://www.example-journal.com/fulltext/10.1016/j.sample.2025.02.001",
    );
    assert.deepEqual(
      merged.web.map((entry) => entry.keys),
      [["web:c", "web:d"], ["web:e"]],
    );
  });

  it("knows one work by its PII, and by any title one of its places has", function () {
    const merged = mergeSameWork(
      [],
      [
        // A PDF's first line for a title, its PII in the link.
        row(
          "web:pdf",
          "web",
          "How do these sample findings fit with earlier signals",
          "https://www.example-journal.com/action/showPdf?pii=S1234-5678%2825%2900042-0",
        ),
        row(
          "web:sd",
          "web",
          "Tracking imagined movement codes over many days - Skip to main content",
          "https://www.sciencedirect.com/science/article/pii/S1234567825000420",
        ),
        row(
          "web:pm",
          "web",
          "Tracking imagined movement codes over many days - PubMed - doi: 10.1016/j.sample.2025.02.001.",
          "https://pubmed.ncbi.nlm.nih.gov/40000001/",
        ),
      ],
    );
    assert.lengthOf(merged.web, 1);
    assert.deepEqual(merged.web[0].keys, ["web:pdf", "web:sd", "web:pm"]);
    // The page's own title, not the PDF's first line, and it opens there.
    assert.equal(
      merged.web[0].title,
      "Tracking imagined movement codes over many days - Skip to main content",
    );
    assert.equal(
      merged.web[0].url,
      "https://www.sciencedirect.com/science/article/pii/S1234567825000420",
    );
    assert.equal(
      sourcePii(
        "https://www.example-journal.com/action/showPdf?pii=S1234-5678%2825%2900042-0",
      ),
      "1234567825000420",
    );
    assert.equal(
      sourceDoi({
        url: "https://rd.springer.com/article/10.1038/s00000-025-00001-x",
      }),
      "10.1038/s00000-025-00001-x",
    );
    assert.equal(
      sourceDoi({
        url: "https://x.org",
        title: "A - PubMed - doi: 10.1016/AB.C.",
      }),
      "10.1016/ab.c",
    );
    assert.equal(
      cleanSourceTitle(
        "Representational drift - Skip to main contentSkip to article",
      ),
      "Representational drift",
    );
    assert.equal(
      cleanSourceTitle("Why habits last - Customise Consent Preferences"),
      "Why habits last",
    );
  });

  it("compares titles without the site's name, and not when too short", function () {
    assert.equal(
      workTitleKey("A long enough title about drift - ScienceDirect"),
      "alongenoughtitleaboutdrift",
    );
    assert.equal(workTitleKey("Drift - Wikipedia"), "");
  });

  it("finds where the answer names a library paper by its author and year", function () {
    const answer = [
      "Several reviews frame drift as a feature.",
      "",
      "| Paper | Claim |",
      "|---|---|",
      "| Dunmore et al. 2022 | Drift is structured |",
      "",
      "The strongest test is **Kendrick et al. (2026)**, who measured redundancy. Others agree.",
    ].join("\n");
    assert.equal(
      findNamedInAnswer(answer, {
        creator: "Kendrick et al.",
        year: "2026",
        title: "Redundancy and drift",
      }),
      "The strongest test is Kendrick et al. (2026), who measured redundancy.",
    );
    assert.equal(
      findNamedInAnswer(answer, {
        creator: "Dunmore and Elsworth",
        year: "2022",
        title: "Representational drift",
      }),
      "Dunmore et al. 2022 — Drift is structured",
    );
    // Its surname with its title, the year far after them.
    assert.equal(
      findNamedInAnswer(
        "| E/I plasticity | ✓ | Hollis & Ingram, *Code change from balanced learning rules in a sample network* (2026) — a journal article |",
        {
          creator: "Hollis and Ingram",
          year: "2026",
          title: "Code change from balanced learning rules in a sample network",
        },
      ),
      "E/I plasticity — ✓ — Hollis & Ingram, Code change from balanced learning rules in a sample network (2026) — a journal article",
    );
    // The surname alone, or another year, is not the paper.
    assert.isNull(
      findNamedInAnswer(answer, {
        creator: "Kendrick",
        year: "2019",
        title: "Another paper",
      }),
    );
    assert.isNull(
      findNamedInAnswer("Reviews frame drift as a feature.", {
        creator: "Frame",
        year: "",
        title: "Short",
      }),
    );
  });

  it("counts a group as used and not used", function () {
    assert.equal(formatTaskGroupCounts(3, 12), "3 used · 12 not used");
    assert.equal(formatTaskGroupCounts(2, 0), "2 used");
    assert.equal(formatTaskGroupCounts(0, 5), "none used · 5 found");
  });

  it("highlights only the agent's exact words in what it read", function () {
    const text =
      "Differences in sensory environment or behavior  do not detectably change drift rate. Other text.";
    const ranges = findExactPhrases(text, [
      "do not detectably change drift rate",
      "a paraphrase that is not there",
      "short",
    ]);
    assert.deepEqual(
      ranges.map(([start, end]) => text.slice(start, end)),
      ["do not detectably change drift rate"],
    );
    // Spacing, letter case and quote marks aside.
    const curly = "The “place cell” code drifts";
    assert.deepEqual(
      findExactPhrases(curly, ['the "place cell" code']).map(([a, b]) =>
        curly.slice(a, b),
      ),
      ["The “place cell” code"],
    );
  });

  it("compares the answer's words with one space and plain quotes", function () {
    assert.equal(foldAnswerWords("  A “B”\n\tC — D "), 'a "b" c - d');
  });

  it("finds a named sentence whose author-year citations show as chips", function () {
    const answer =
      "So the loop closes [[cite:Q_04j56kf]]. Homeostatic and predictive-plasticity mechanisms supply the feedback term: Hollis & Ingram (2026) derive drift as an intrinsic consequence of predictive excitatory–inhibitory plasticity, and Bexley & Corwin (2025) show drift arising from changes in neuronal excitability in a spike-coding autoencoder, without invoking synaptic weight change at all. So the slow variable can live anywhere.";
    const quote = findNamedInAnswer(answer, {
      creator: "Bexley",
      year: "2025",
      title: "Code change without weight updates",
    })!;
    assert.match(quote, /^Homeostatic.*…$/);
    // The chat leaves the chips' words out of the sentence...
    const chips = foldAnswerWords(
      "So the loop closes. Homeostatic and predictive-plasticity mechanisms supply the feedback term:  derive drift as an intrinsic consequence of predictive excitatory–inhibitory plasticity, and  show drift arising from changes in neuronal excitability in a spike-coding autoencoder, without invoking synaptic weight change at all. So the slow variable can live anywhere.",
    );
    assert.notInclude(chips, foldAnswerWords(quote.replace(/…$/, "")));
    const span = findQuoteAroundGaps(chips, quote)!;
    assert.isOk(span);
    assert.match(
      chips.slice(...span),
      /^homeostatic and .* show drift arising fr/,
    );
    // ...or shows them under another label.
    const relabeled = chips
      .replace("term: derive", "term: (hollis and ingram, 2026) derive")
      .replace("and show", "and (bexley and corwin, 2025) show");
    assert.isOk(findQuoteAroundGaps(relabeled, quote));
    // A different sentence with the same pieces far apart is not it.
    assert.isNull(
      findQuoteAroundGaps(
        "homeostatic and predictive-plasticity mechanisms supply the feedback term: and many more words here that go on and on for a long while before derive drift as an intrinsic consequence",
        "Homeostatic and predictive-plasticity mechanisms supply the feedback term: Hollis & Ingram (2026) derive drift as an intrinsic consequence",
      ),
    );
    // A quote with no citation is left to the plain search.
    assert.isNull(findQuoteAroundGaps(chips, "Homeostatic and predictive"));
  });

  it("finds a named sentence around maths, a cut citation and a chip-only cell", function () {
    // Typeset maths is not compared: "$J_{ij}$" stands for a gap.
    assert.isOk(
      findQuoteAroundGaps(
        "in clark's model the connections are a weight matrix , where is the connection from neuron to neuron .",
        "In Clark's model the connections are a weight matrix $J$, where $J_{ij}$ is the connection from neuron $j$ to neuron $i$.",
      ),
    );
    // A long quote cut inside its last citation lights up to the cut.
    const text =
      "population dissimilarities among stimuli remained stable . this is important";
    const span = findQuoteAroundGaps(
      text,
      "Population dissimilarities among stimuli remained stable (Roth & Merr…",
    )!;
    assert.equal(
      text.slice(...span),
      "population dissimilarities among stimuli remained stable",
    );
    assert.isOk(
      findQuoteAroundGaps(
        "and comparable to ewc whose curve the authors replotted from in their figure",
        "And comparable to EWC whose curve the authors replotted from Kirkpatrick et al.,…",
      ),
    );
    // A heading that is short around its chip is found as a whole block
    // only.
    assert.deepEqual(
      findQuoteAroundGaps(
        "methodology of",
        "Methodology of Garnett et al. (2024)",
        { whole: true },
      ),
      [0, 14],
    );
    assert.isNull(
      findQuoteAroundGaps(
        "the methodology of this field",
        "Methodology of Garnett et al. (2024)",
        { whole: true },
      ),
    );
    assert.isNull(
      findQuoteAroundGaps(
        "the methodology of this field",
        "Methodology of Garnett et al. (2024)",
      ),
    );
  });

  it("quotes a named paper's sentence with the answer's own symbols", function () {
    const paper = { creator: "Dunmore", year: "2017", title: "Dynamic" };
    assert.equal(
      findNamedInAnswer(
        "- **Dunmore et al. (2017)** — mice above >90% correct, still drifting\n",
        paper,
      ),
      "Dunmore et al. (2017) — mice above >90% correct, still drifting",
    );
    assert.equal(
      findNamedInAnswer(
        "> The weights $W_{ij}$ change (Dunmore et al., 2017).",
        paper,
      ),
      "The weights $W_{ij}$ change (Dunmore et al., 2017).",
    );
    // A citation alone after its sentence names the paper with it.
    assert.equal(
      findNamedInAnswer(
        "Drift continues after learning. (Dunmore et al., 2017)",
        paper,
      ),
      "Drift continues after learning. (Dunmore et al., 2017)",
    );
  });

  it("does not take a word for a surname", function () {
    const long = { creator: "Long", year: "2020", title: "Something else" };
    assert.isNull(
      findNamedInAnswer("Long-term recordings since 2020 show drift.", long),
    );
    assert.isNull(
      findNamedInAnswer("Recordings this long, since 2020, show drift.", long),
    );
    assert.equal(
      findNamedInAnswer("As Long (2020) showed, drift is slow.", long),
      "As Long (2020) showed, drift is slow.",
    );
    assert.equal(
      findNamedInAnswer("Pell & Marlow (2023) review it.", {
        creator: "Marlow",
        year: "2023",
        title: "Code change as a window",
      }),
      "Pell & Marlow (2023) review it.",
    );
    // A few words around a chip are not a heading of their own.
    assert.isNull(
      findQuoteAroundGaps("results", "Smith (2020) results", { whole: true }),
    );
  });

  describe("findLibraryPaperInAnswer", function () {
    const paper = {
      creator: "Quill",
      year: "2021",
      title: "Drift study one",
    };

    it("finds the sentence holding a quote card of the paper", function () {
      const answer =
        "## Drift\n\nDrift grows with time [[cite:Q_1]]. Other work differs [[cite:Q_9]].";
      assert.deepEqual(findLibraryPaperInAnswer(answer, paper, ["Q_1"]), [
        { text: "Drift grows with time.", anchor: -1, section: "Drift" },
      ]);
      assert.lengthOf(
        findLibraryPaperInAnswer(
          answer.replace("cite:Q_1", "quote:Q_1"),
          paper,
          ["Q_1"],
        ),
        1,
        "a quote token counts as a cite token",
      );
    });

    it("takes the sentence before a quote card on a line of its own", function () {
      const answer =
        "## Drift\n\nDrift grows with time.\n\n[[quote:Q_1]]\n\nMore.";
      assert.deepEqual(findLibraryPaperInAnswer(answer, paper, ["Q_1"]), [
        { text: "Drift grows with time.", anchor: -1, section: "Drift" },
      ]);
    });

    it("finds a sentence that names the paper", function () {
      const answer = "## Notes\n\nQuill et al. (2021) saw slow drift.";
      assert.deepEqual(findLibraryPaperInAnswer(answer, paper, []), [
        {
          text: "Quill et al. (2021) saw slow drift.",
          anchor: -1,
          section: "Notes",
        },
      ]);
    });

    it("lists every quoting and naming sentence in answer order", function () {
      const answer = [
        "## First",
        "",
        "Quill et al. (2021) opened the field. Drift grows [[cite:Q_1]].",
        "",
        "## Second",
        "",
        "Unrelated claim.",
        "",
        "Drift saturates [[quote:Q_2]].",
        "",
        "## Third",
        "",
        "As Quill (2021) argued, drift is slow.",
      ].join("\n");
      const found = findLibraryPaperInAnswer(answer, paper, ["Q_1", "Q_2"]);
      assert.deepEqual(
        found.map((quote) => [quote.section, quote.text]),
        [
          ["First", "Quill et al. (2021) opened the field."],
          ["First", "Drift grows."],
          ["Second", "Drift saturates."],
          ["Third", "As Quill (2021) argued, drift is slow."],
        ],
      );
    });

    it("finds nothing when the answer neither quotes nor names the paper", function () {
      assert.deepEqual(
        findLibraryPaperInAnswer("Drift is slow [[cite:Q_9]].", paper, ["Q_1"]),
        [],
      );
      assert.deepEqual(findLibraryPaperInAnswer("", paper, ["Q_1"]), []);
    });

    it("reads a table row that names the paper as its cells", function () {
      const answer =
        "| Study | Result |\n| --- | --- |\n| Quill et al. (2021) | Slow drift |";
      assert.deepEqual(
        findLibraryPaperInAnswer(answer, paper, []).map((quote) => quote.text),
        ["Quill et al. (2021) — Slow drift"],
      );
    });

    it("finds a sentence whose citation names the paper among other ids", function () {
      for (const token of [
        "[[cite:Q_9,Q_1]]",
        "[[cite:Q_9; Q_1]]",
        "[[cite:Q_9 Q_1]]",
        "[[cite:Q_9]] [[cite:Q_1]]",
      ]) {
        assert.deepEqual(
          findLibraryPaperInAnswer(
            `Drift grows with time ${token}. Other work differs.`,
            paper,
            ["Q_1"],
          ).map((quote) => quote.text),
          ["Drift grows with time."],
          token,
        );
      }
    });

    it("takes the sentence a citation after its period closes", function () {
      assert.deepEqual(
        findLibraryPaperInAnswer(
          "Drift grows with time. [[cite:Q_1]] Other work differs.",
          paper,
          ["Q_1"],
        ).map((quote) => quote.text),
        ["Drift grows with time."],
      );
    });

    it("lists a sentence once, whether it quotes or names the paper", function () {
      const answer =
        "Quill et al. (2021) saw drift [[cite:Q_1]]. Quill et al. (2021) saw drift [[cite:Q_1]].";
      const found = findLibraryPaperInAnswer(answer, paper, ["Q_1"]);
      assert.deepEqual(
        found.map((quote) => quote.text),
        ["Quill et al. (2021) saw drift."],
      );
      assert.notProperty(found[0], "section");
    });
  });

  describe("a library paper's Cited list", function () {
    const paper = {
      itemId: 7,
      contextItemIds: [70],
      creator: "Quill",
      year: "2021",
      title: "Drift study one",
    };
    const read = (patch: Partial<TaskPaperReadEvent>): TaskPaperReadEvent => ({
      key: "1:7",
      callId: "c",
      toolName: "paper_read",
      granularity: "passage",
      ...patch,
    });
    const passage = (
      patch: Partial<TaskAnswerCitation> = {},
    ): TaskAnswerCitation => ({
      id: "Q_1",
      number: 1,
      sentences: ["Drift grows with time."],
      quote:
        "Place cell maps drift steadily over days even in a familiar environment.",
      itemId: 7,
      kind: "cite",
      ...patch,
    });

    it("treats a read on the cited page, or holding the cited words, as cited", function () {
      const cited = [passage({ pageIndex: 4, contextItemId: 70 })];
      assert.isTrue(isTaskReadCited(read({ pageIndex: 4 }), cited, paper));
      assert.isFalse(isTaskReadCited(read({ pageIndex: 5 }), cited, paper));
      assert.isTrue(
        isTaskReadCited(
          read({
            snippet:
              "## Results\nPlace cell maps drift steadily over days even in a familiar environment. More text follows.",
          }),
          cited,
          paper,
        ),
        "the passage inside the read's words",
      );
      assert.isTrue(
        isTaskReadCited(
          read({ snippet: "Place cell maps drift steadily over days…" }),
          cited,
          paper,
        ),
        "the read's clipped words inside the passage",
      );
      assert.isFalse(
        isTaskReadCited(read({ snippet: "Drift" }), cited, paper),
        "a few words could sit in any passage",
      );
      // With two attachments a page names a place only in the citation's own.
      assert.isFalse(
        isTaskReadCited(
          read({ pageIndex: 4 }),
          [passage({ pageIndex: 4, contextItemId: 71 })],
          { contextItemIds: [70, 71] },
        ),
      );
    });

    it("lists the paper's passages, the sentences only naming it, and the reads it did not cite", function () {
      const answer = [
        "## Drift",
        "",
        "Drift grows with time [[cite:Q_1]]. Quill et al. (2021) saw it first.",
        "",
        "Quill (2021) shows drift [[cite:Q_1]].",
      ].join("\n");
      const model = buildTaskCitedModel({
        answerCitations: [
          passage({
            sentences: ["Drift grows with time.", "Quill (2021) shows drift."],
          }),
          passage({ id: "Q_2", number: 2, itemId: 8 }),
        ],
        reads: [
          read({ snippet: passage().quote }),
          read({
            snippet: "Methods recorded 400 neurons in CA1 over many sessions.",
          }),
        ],
        droppedReads: 2,
        answer,
        paper,
      });
      assert.deepEqual(
        model.cited.map((entry) => entry.id),
        ["Q_1"],
        "only this paper's",
      );
      assert.deepEqual(
        model.named.map((quote) => [quote.section, quote.text]),
        [["Drift", "Quill et al. (2021) saw it first."]],
        "a sentence holding its passage is not named only",
      );
      assert.deepEqual(
        model.uncited.map((entry) => entry.snippet),
        ["Methods recorded 400 neurons in CA1 over many sessions."],
      );
      assert.equal(model.droppedReads, 2);
      assert.isTrue(hasTaskCitedContent(model));
      assert.isFalse(
        hasTaskCitedContent({
          cited: [],
          named: [],
          uncited: [],
          droppedReads: 0,
        }),
      );
    });

    it("numbers a record's ledger citations from the answer when it kept no list", function () {
      const model = buildTaskCitedModel({
        ledgerCitations: [
          {
            citationId: "Q_1",
            turnIndex: 1,
            quote: "Kept words",
            pageLabel: "3",
          },
          { citationId: "Q_3", turnIndex: 1 },
          { citationId: "D_1", turnIndex: 1, source: "document" },
        ],
        questionCitationIds: ["Q_0", "Q_1", "Q_3"],
        reads: [],
        answer: "First [[cite:Q_0]]. Then [[cite:Q_1]].\n\n[[quote:Q_3]]",
        paper,
      });
      assert.deepEqual(
        model.cited.map((entry) => [entry.id, entry.number, entry.kind]),
        [
          ["Q_1", 2, "cite"],
          ["Q_3", undefined, "quote"],
        ],
      );
      assert.deepEqual(model.cited[0].sentences, ["Then."]);
      assert.equal(model.cited[0].pageLabel, "3");
    });

    it("labels a passage by its page and section, either alone, or as a passage", function () {
      assert.equal(
        formatTaskCitedLabel({ pageLabel: "7", section: "Results" }),
        "p. 7 · Results",
      );
      assert.equal(formatTaskCitedLabel({ section: "Results" }), "Results");
      assert.equal(formatTaskCitedLabel({ pageLabel: "iv" }), "p. iv");
      assert.equal(formatTaskCitedLabel({}), "Passage");
    });

    it("counts a paper chat's question by the passages its answer cites", function () {
      const question = { turn: 1, checklist: null };
      assert.equal(
        formatTaskPaperChatCounts(null, {
          ...question,
          answerCitations: [passage(), passage({ id: "Q_2", number: 2 })],
        }),
        "2 cited",
      );
      assert.equal(
        formatTaskPaperChatCounts(null, { ...question, answerCitations: [] }),
        "",
      );
    });
  });

  it("names the part of the answer a quote sits in by its heading", function () {
    const answer =
      "Intro line.\n\n## The **objection** has weakened\n\nArden et al. found it.\n\n### Mechanisms ##\n\nFarrow et al. show it.";
    assert.equal(answerSectionAt(answer, answer.indexOf("Intro")), "");
    assert.equal(
      answerSectionAt(answer, answer.indexOf("Arden")),
      "The objection has weakened",
    );
    assert.equal(
      answerSectionAt(answer, answer.indexOf("Farrow")),
      "Mechanisms",
    );
  });

  describe("sentenceClosingIndexes", function () {
    it("pairs each citing sentence with the mark that closes it", function () {
      // "A [1] and B [1]. C [1].": two marks in the first sentence, one in
      // the second; the passage lists two sentences.
      assert.deepEqual(sentenceClosingIndexes(["0:0", "0:0", "0:17"]), [1, 2]);
    });

    it("keeps one mark per sentence, across blocks, and a mark in none alone", function () {
      assert.deepEqual(sentenceClosingIndexes(["0:0", "1:0", "1:0"]), [0, 2]);
      assert.deepEqual(sentenceClosingIndexes([null, null, "2:4"]), [0, 1, 2]);
      assert.deepEqual(sentenceClosingIndexes([]), []);
    });
  });
});
