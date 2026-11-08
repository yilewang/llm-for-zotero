import { assert } from "chai";
import type { QuoteCitation } from "../src/shared/types";
import {
  TASK_ANSWER_CITATION_QUOTE_MAX_CHARS,
  buildTaskAnswerCitations,
  isTaskAnswerCitationOf,
  taskAnswerCitationDisplayQuote,
} from "../src/modules/contextPanel/taskProgress/answerCitations";
import {
  buildQuoteRenderPlan,
  paragraphCitationNumbers,
} from "../src/modules/contextPanel/quoteRenderPlan";

function citation(
  id: string,
  patch: Partial<QuoteCitation> = {},
): QuoteCitation {
  return {
    id,
    quoteText: `Passage ${id} says what it says.`,
    citationLabel: "(Smith, 2021)",
    itemId: 7,
    ...patch,
  };
}

describe("buildTaskAnswerCitations", function () {
  it("numbers the cited passages as the answer's marks do", function () {
    const quoteCitations = [
      citation("Q_a"),
      citation("Q_b"),
      citation("Q_c"),
      citation("Q_d"),
    ];
    const text = [
      "Drift grows [[cite:Q_c]]. It saturates [[cite:Q_a,Q_missing; Q_c]].",
      "",
      "- Both hold [[cite:Q_b]] [[cite:Q_a]].",
      "",
      "```",
      "[[cite:Q_d]]",
      "```",
    ].join("\n");
    const entries = buildTaskAnswerCitations({ text, quoteCitations });
    const marks = paragraphCitationNumbers(
      buildQuoteRenderPlan({ markdown: text, quoteCitations }),
    );
    assert.deepEqual(
      entries.map((entry) => [entry.id, entry.number]),
      [...marks.entries()],
      "the same ids and numbers as the rendered marks",
    );
    assert.deepEqual(
      entries.map((entry) => [entry.id, entry.number, entry.sentences]),
      [
        ["Q_c", 1, ["Drift grows.", "It saturates."]],
        ["Q_a", 2, ["It saturates.", "Both hold."]],
        ["Q_b", 3, ["Both hold."]],
      ],
      "an unknown id and a token in code are left out",
    );
    assert.isTrue(entries.every((entry) => entry.kind === "cite"));
  });

  it("lists a passage only quoted as a card without a number, and one both cited and quoted once", function () {
    const quoteCitations = [citation("Q_a"), citation("Q_b")];
    const text =
      "Drift grows [[cite:Q_a]].\n\n[[quote:Q_b]]\n\nAs quoted: [[quote:Q_a]]";
    const entries = buildTaskAnswerCitations({ text, quoteCitations });
    assert.deepEqual(
      entries.map((entry) => [entry.id, entry.number, entry.kind]),
      [
        ["Q_a", 1, "cite"],
        ["Q_b", undefined, "quote"],
      ],
    );
    assert.notProperty(entries[1], "number");
    assert.deepEqual(entries[1].sentences, []);
  });

  it("keeps where each passage is, and its words up to 600 characters", function () {
    const long = "word ".repeat(400);
    const entries = buildTaskAnswerCitations({
      text: "A claim [[cite:Q_a]]. Another [[cite:Q_b]].",
      quoteCitations: [
        citation("Q_a", {
          quoteText: long,
          displayQuoteText: "Shown words of the passage.",
          pageHintLabel: "12",
          pageHintIndex: 11,
          sourceSectionLabel: "Results",
          contextItemId: 70,
        }),
        citation("Q_b", { quoteText: long, itemId: undefined }),
      ],
    });
    assert.deepInclude(entries[0], {
      id: "Q_a",
      number: 1,
      quote: "Shown words of the passage.",
      pageLabel: "12",
      pageIndex: 11,
      section: "Results",
      itemId: 7,
      contextItemId: 70,
      kind: "cite",
    });
    assert.lengthOf(entries[1].quote, TASK_ANSWER_CITATION_QUOTE_MAX_CHARS);
    assert.isTrue(entries[1].quote.endsWith("…"));
    assert.notProperty(entries[1], "itemId");
    assert.notProperty(entries[1], "pageIndex");
  });

  it("clips a long passage outside its math, so no formula is cut open", function () {
    const head = "word ".repeat(116); // 580 characters before the formula
    const formula = "$1 \\% - 3 \\% + 4 \\%$";
    const [entry] = buildTaskAnswerCitations({
      text: "A claim [[cite:Q_a]].",
      quoteCitations: [
        citation("Q_a", {
          quoteText: `${head}${formula} and then more words.`,
        }),
      ],
    });
    assert.isAtMost(entry.quote.length, TASK_ANSWER_CITATION_QUOTE_MAX_CHARS);
    assert.isTrue(entry.quote.endsWith("…"));
    assert.equal(
      entry.quote.split("$").length % 2,
      1,
      `an even count of $: ${entry.quote.slice(-40)}`,
    );
    assert.equal(entry.quote, `${head.trimEnd()}…`);
  });

  it("keeps a clip of a passage that opens with a long formula from collapsing to an ellipsis", function () {
    const formula = `$${"a + ".repeat(150)}b$`; // starts at 0, ends past 600
    const [entry] = buildTaskAnswerCitations({
      text: "A claim [[cite:Q_a]].",
      quoteCitations: [
        citation("Q_a", { quoteText: `${formula} and then more words.` }),
      ],
    });
    assert.isAtMost(entry.quote.length, TASK_ANSWER_CITATION_QUOTE_MAX_CHARS);
    assert.isTrue(entry.quote.endsWith("…"));
    assert.isAbove(entry.quote.length, 500);
  });

  it("draws a legacy quote that starts with a heading marker as plain text, keeping the raw quote", function () {
    const [entry] = buildTaskAnswerCitations({
      text: "A claim [[cite:Q_a]].",
      quoteCitations: [
        citation("Q_a", { quoteText: "# Results\n\nNeurons fired in bursts." }),
      ],
    });
    assert.equal(entry.quote, "# Results Neurons fired in bursts.");
    assert.equal(
      taskAnswerCitationDisplayQuote(entry.quote),
      "Results Neurons fired in bursts.",
    );
    assert.equal(
      taskAnswerCitationDisplayQuote("Body # not a marker"),
      "Body # not a marker",
    );
  });

  it("reads the answer as it shows, after quote validation", function () {
    const message = {
      text: "Old [[cite:Q_a]].",
      quoteCitations: [citation("Q_a")],
      quoteDisplayOverride: {
        markdown: "New [[cite:Q_b]]. Old [[cite:Q_a]].",
        quoteCitations: [citation("Q_a"), citation("Q_b")],
      },
    };
    assert.deepEqual(
      buildTaskAnswerCitations(message).map((entry) => [
        entry.id,
        entry.number,
      ]),
      [
        ["Q_b", 1],
        ["Q_a", 2],
      ],
    );
  });

  it("reads a web-attributed answer from its own text, as it renders", function () {
    const message = {
      text: "Old [[cite:Q_a]].",
      quoteCitations: [citation("Q_a")],
      quoteDisplayOverride: {
        markdown: "New [[cite:Q_b]]. Old [[cite:Q_a]].",
        quoteCitations: [citation("Q_a"), citation("Q_b")],
      },
    };
    assert.deepEqual(
      buildTaskAnswerCitations(message, { hasWebSources: true }).map(
        (entry) => [entry.id, entry.number],
      ),
      [["Q_a", 1]],
    );
    // Its quoted lines stay quotes: no card is inferred from them.
    const quoted = {
      text: "> Passage Q_a says what it says.\n\n(Smith, 2021)",
      quoteCitations: [citation("Q_a")],
    };
    assert.deepEqual(
      buildTaskAnswerCitations(quoted).map((entry) => entry.kind),
      ["quote"],
    );
    assert.deepEqual(
      buildTaskAnswerCitations(quoted, { hasWebSources: true }),
      [],
    );
  });

  it("finds nothing without citations or text", function () {
    assert.deepEqual(buildTaskAnswerCitations({ text: "Plain." }), []);
    assert.deepEqual(
      buildTaskAnswerCitations({ text: "", quoteCitations: [citation("Q")] }),
      [],
    );
  });

  it("tells a paper's passages by its item, else by its attachment", function () {
    assert.isTrue(isTaskAnswerCitationOf({ itemId: 7 }, { itemId: 7 }));
    assert.isFalse(
      isTaskAnswerCitationOf(
        { itemId: 8, contextItemId: 70 },
        { itemId: 7, contextItemIds: [70] },
      ),
    );
    assert.isTrue(
      isTaskAnswerCitationOf(
        { contextItemId: 70 },
        { itemId: 7, contextItemIds: [70] },
      ),
    );
    assert.isFalse(isTaskAnswerCitationOf({}, { itemId: 7 }));
  });
});
