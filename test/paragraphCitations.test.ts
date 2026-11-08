import { assert } from "chai";
import {
  buildQuoteCitation,
  selectUsedQuoteCitations,
  finalizeAssistantQuoteCitations,
} from "../src/services/quotes/quoteCitations";
import {
  buildQuoteRenderPlan,
  buildQuoteExpandedMarkdown,
  createCitationNumberer,
  getMessageQuoteDisplay,
  PARAGRAPH_CITATION_TOKEN_PATTERN,
  paragraphCitationNumbers,
  paragraphCitationPlaceholder,
  paragraphCitationPlaceholderIds,
} from "../src/modules/contextPanel/quoteRenderPlan";
import {
  indexAnswerCitations,
  iterateCitationRuns,
  paragraphCitationIds,
  normalizeParagraphCitations,
  stripPartialTrailingCitationToken,
} from "../src/services/quotes/paragraphCitations";
import { buildAssistantDisplayMarkdownForRender } from "../src/modules/contextPanel/assistantRichText";
import { buildTaskAnswerCitations } from "../src/modules/contextPanel/taskProgress/answerCitations";
import { leadingSentenceClose } from "../src/services/quotes/answerSentence";

const a = buildQuoteCitation({
  quoteText:
    "The methods measured neural activity across twelve recording sessions in five animals.",
  citationLabel: "(Kim, 2026)",
  contextItemId: 21,
  itemId: 20,
  sourceMatchText:
    "The methods measured neural activity across twelve recording sessions in five animals.",
  sourceMatchKind: "exact",
  sourceMatchSource: "context-text",
})!;
const b = buildQuoteCitation({
  ...a,
  id: undefined,
  citationLabel: "(Lee, 2025)",
  contextItemId: 31,
  itemId: 30,
})!;

describe("paragraph evidence citations", function () {
  it("keeps a multi-source paragraph compact and a separate reading recommendation visible", function () {
    const text = `The experiments recorded multiple sessions. [[cite:${a.id},${b.id},${a.id}]]\n\nRead this passage for the protocol:\n\n[[quote:${a.id}]]`;
    const plan = buildQuoteRenderPlan({
      markdown: text,
      quoteCitations: [a, b],
    });
    assert.lengthOf(plan.occurrences, 1);
    assert.lengthOf(plan.paragraphCitations, 1);
    assert.deepEqual(
      plan.paragraphCitations[0].map((citation) => citation.id),
      [a.id, b.id],
    );
    assert.include(
      plan.displayMarkdown,
      `sessions. ${paragraphCitationPlaceholder([a.id, b.id])}`,
    );
    assert.deepEqual(
      selectUsedQuoteCitations({ text, quoteCitations: [a, b] }),
      [a, b],
    );
    const expanded = buildQuoteExpandedMarkdown({
      markdown: text,
      quoteCitations: [a, b],
    });
    assert.include(expanded, b.citationLabel);
    assert.notInclude(expanded, "LLMPAPERCITE");
    assert.notInclude(expanded, "[[cite:");
  });

  it("persists inline-only evidence through quote finalization and drops invented IDs", function () {
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `This protocol spans multiple sessions. [[cite:${a.id},invented]]`,
      quoteCitations: [a, b],
    });
    assert.deepEqual(
      finalized.quoteCitations.map((citation) => citation.id),
      [a.id],
    );
    assert.include(finalized.markdown, `[[cite:${a.id}]]`);
    assert.notInclude(finalized.markdown, "invented");
  });

  it("does not expose malformed or made-up citation markers", function () {
    const plan = buildQuoteRenderPlan({
      markdown: "Claim. [[cite:chunk 0]] [[cite:bad?]]",
      quoteCitations: [a],
    });
    assert.isEmpty(plan.paragraphCitations);
    assert.notInclude(plan.displayMarkdown, "[[cite:");
  });

  it("leaves code examples and escaped markers literal, combines adjacent footers, and strips unknown evidence", function () {
    const text = `Example \`[[cite:${a.id}]]\`\n\n\`\`\`text\n[[cite:${b.id}]]\n\`\`\`\n\nA claim. [[cite:${a.id}]] [[cite:${b.id}]]\n\nUnknown. [[cite:invented]]`;
    const plan = buildQuoteRenderPlan({
      markdown: text,
      quoteCitations: [a, b],
    });
    assert.lengthOf(plan.paragraphCitations, 1);
    assert.lengthOf(plan.paragraphCitations[0], 2);
    assert.notInclude(plan.displayMarkdown, "invented");
    assert.include(plan.displayMarkdown, `\`[[cite:${a.id}]]\``);
    assert.isEmpty(paragraphCitationIds(`\\[[cite:${a.id}]]`));
    assert.equal(
      normalizeParagraphCitations("No source. [[cite:bad]]", new Set()),
      "No source.",
    );
    assert.equal(
      normalizeParagraphCitations("x [[cite:bad id]]", new Set([a.id])),
      "x",
    );
  });
  it("keeps paragraph citation ids that contain '.' or ':'", function () {
    assert.deepEqual(
      [...paragraphCitationIds("A claim. [[cite:x.y, p:1]] [[cite:bad?]]")],
      ["x.y", "p:1"],
    );
    assert.equal(
      normalizeParagraphCitations(
        "A claim. [[cite:x.y,p:1]]",
        new Set(["p:1"]),
      ),
      "A claim. [[cite:p:1]]",
    );
  });

  it("keeps every id of a semicolon- or space-separated citation list", function () {
    // Live failure: [[cite:A;B]] was read as one malformed id, so both valid
    // passages vanished from the paragraph footer.
    for (const separator of [";", "; ", " ", ",;"]) {
      const markdown = `Drift is slow. [[cite:${a.id}${separator}${b.id}]]`;
      assert.deepEqual(
        [...paragraphCitationIds(markdown)],
        [a.id, b.id],
        separator,
      );
      const plan = buildQuoteRenderPlan({
        markdown,
        quoteCitations: [a, b],
      });
      assert.deepEqual(
        plan.paragraphCitations[0]?.map((citation) => citation.id),
        [a.id, b.id],
        separator,
      );
      assert.equal(
        normalizeParagraphCitations(markdown, new Set([a.id, b.id])),
        `Drift is slow. [[cite:${a.id},${b.id}]]`,
        separator,
      );
    }
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `This protocol spans multiple sessions. [[cite:${a.id};${b.id}]]`,
      quoteCitations: [a, b],
    });
    assert.deepEqual(
      finalized.quoteCitations.map((citation) => citation.id),
      [a.id, b.id],
    );
  });

  it("records removed unknown citation ids instead of dropping them silently", function () {
    const plan = buildQuoteRenderPlan({
      markdown: `A claim. [[cite:${a.id},Q_20_dummy]]\n\nAnother. [[cite:bad?]]`,
      quoteCitations: [a],
    });
    assert.deepEqual(
      plan.paragraphCitations.map((group) => group.map((c) => c.id)),
      [[a.id]],
    );
    assert.notInclude(plan.displayMarkdown, "Q_20_dummy");
    assert.notInclude(plan.displayMarkdown, "bad?");
    assert.deepEqual(
      plan.diagnostics
        .filter((entry) => entry.kind === "unresolved-anchor")
        .map((entry) => entry.quoteCitationId),
      ["Q_20_dummy", "bad?"],
    );
    const dropped: string[] = [];
    assert.equal(
      normalizeParagraphCitations(
        `A claim. [[cite:${a.id};Q_20_dummy]]`,
        new Set([a.id]),
        (ids) => dropped.push(...ids),
      ),
      `A claim. [[cite:${a.id}]]`,
    );
    assert.deepEqual(dropped, ["Q_20_dummy"]);
  });
});

describe("per-sentence citation runs", function () {
  const valid = new Set(["Q_a", "Q_b", "Q_c"]);

  it("finds each run with its offsets and ids, whatever the separator", function () {
    const text =
      "One [[cite:Q_a,Q_b]]. Two [[cite:Q_b;Q_c]]. Three [[cite:Q_a Q_c]] [[cite:Q_b]].";
    const runs = iterateCitationRuns(text);
    assert.deepEqual(
      runs.map((run) => run.ids),
      [
        ["Q_a", "Q_b"],
        ["Q_b", "Q_c"],
        ["Q_a", "Q_c", "Q_b"],
      ],
    );
    assert.equal(
      text.slice(runs[2].start, runs[2].end),
      "[[cite:Q_a Q_c]] [[cite:Q_b]]",
      "adjacent tokens are one run",
    );
    assert.deepEqual(
      iterateCitationRuns("Bad [[cite:bad?, Q_a, Q_a]].")[0].ids,
      ["Q_a"],
      "only well-formed ids, deduplicated",
    );
  });

  it("ignores fenced, indented, inline-code and escaped tokens", function () {
    const text =
      "```\n[[cite:Q_a]]\n```\n    [[cite:Q_a]]\nSee `[[cite:Q_a]]` and \\[[cite:Q_a]]. Real [[cite:Q_b]].";
    const runs = iterateCitationRuns(text);
    assert.lengthOf(runs, 1);
    assert.deepEqual(runs[0].ids, ["Q_b"]);
    assert.equal(text.slice(runs[0].start, runs[0].end), "[[cite:Q_b]]");
  });

  it("numbers passages by first appearance and skips ids without a record", function () {
    const text =
      "First [[cite:Q_x,Q_b]]. Second [[cite:Q_a;Q_b]].\n\nThird [[cite:Q_b]].";
    assert.deepEqual(indexAnswerCitations(text, valid), [
      { id: "Q_b", number: 1, sentences: ["First.", "Second.", "Third."] },
      { id: "Q_a", number: 2, sentences: ["Second."] },
    ]);
    assert.deepEqual(
      indexAnswerCitations("Twice [[cite:Q_a]] here [[cite:Q_a]].", valid),
      [{ id: "Q_a", number: 1, sentences: ["Twice here."] }],
      "one sentence cited twice is listed once",
    );
    assert.isEmpty(indexAnswerCitations("No [[cite:Q_z]].", valid));
  });

  it("resolves a token before or after the period to the sentence it closes", function () {
    const before = "Drift is slow **at 0.46** [[cite:Q_a]]. Next one.";
    const after = "Drift is slow at 0.46. [[cite:Q_a]] Next one.";
    const glued = "Drift is slow at 0.46.[[cite:Q_a]] Next one.";
    const softBreak = "Drift is slow at 0.46.\n[[cite:Q_a]] Next one.";
    for (const text of [before, after, glued, softBreak]) {
      assert.deepEqual(
        indexAnswerCitations(text, valid)[0].sentences,
        ["Drift is slow at 0.46."],
        text,
      );
    }
    assert.deepEqual(
      indexAnswerCitations(
        "## Results\n\nOne thing. Smith et al. [[cite:Q_a]] found it.",
        valid,
      )[0].sentences,
      ["Smith et al. found it."],
      "an abbreviation does not close the sentence",
    );
    assert.deepEqual(
      indexAnswerCitations(
        "- A list item [[cite:Q_a]]\n- Next [[cite:Q_b]].",
        valid,
      ).map((entry) => entry.sentences),
      [["A list item"], ["Next."]],
    );
  });

  it("removes a dropped run together with the space before it", function () {
    assert.equal(
      normalizeParagraphCitations("Drift is 0.46 [[cite:bad]].", new Set()),
      "Drift is 0.46.",
    );
    assert.equal(
      normalizeParagraphCitations("A [[cite:bad]] [[cite:x]] B", new Set()),
      "A B",
    );
    assert.equal(
      normalizeParagraphCitations("Kept [[cite:Q_a]].", valid),
      "Kept [[cite:Q_a]].",
    );
    const plan = buildQuoteRenderPlan({
      markdown: "Drift is 0.46 [[cite:invented]].",
      quoteCitations: [a],
    });
    assert.equal(plan.displayMarkdown, "Drift is 0.46.");
  });

  it("gives the renderer's marks the same numbers as the answer index", function () {
    const text = `Methods first [[cite:${b.id}]]. Both [[cite:${a.id};${b.id},invented]].\n\nOld style. [[cite:${a.id}]]`;
    const message = { text, quoteCitations: [a, b] };
    const display = getMessageQuoteDisplay(message);
    const plan = buildQuoteRenderPlan(display);
    const index = indexAnswerCitations(
      display.markdown,
      new Set((display.quoteCitations || []).map((citation) => citation.id)),
    );
    assert.deepEqual(
      [...paragraphCitationNumbers(plan)],
      index.map((entry) => [entry.id, entry.number]),
    );
    assert.deepEqual(
      index.map((entry) => entry.id),
      [b.id, a.id],
    );
  });
});

describe("paragraph citations when an answer is copied, saved or streamed", function () {
  const plan = (markdown: string) => ({
    markdown,
    quoteCitations: [a, b],
  });

  it("copy and notes: runs go in place and each line ends with its labels", function () {
    const text = `Methods measured sessions [[cite:${a.id}]]. Replication agrees [[cite:${b.id},${a.id}]].\n\n- Item one [[cite:${b.id}]].\n\n| Claim | Source |\n| --- | --- |\n| Drift [[cite:${a.id}]] | x |`;
    assert.equal(
      buildQuoteExpandedMarkdown(plan(text), {
        paragraphCitations: "line-labels",
      }),
      [
        "Methods measured sessions. Replication agrees. (Kim, 2026); (Lee, 2025)",
        "",
        "- Item one. (Lee, 2025)",
        "",
        "| Claim | Source |",
        "| --- | --- |",
        "| Drift (Kim, 2026) | x |",
      ].join("\n"),
    );
  });

  it("copy keeps quote cards as quoted passages with their label", function () {
    const expanded = buildQuoteExpandedMarkdown(
      plan(`Claim [[cite:${b.id}]].\n\n[[quote:${a.id}]]`),
      { paragraphCitations: "line-labels" },
    );
    assert.include(expanded, "Claim. (Lee, 2025)");
    assert.include(expanded, `> ${a.quoteText}\n>\n> ${a.citationLabel}`);
  });

  it("streaming shows no citation run and no token still being written", function () {
    assert.equal(
      buildQuoteExpandedMarkdown(plan(`Drift is 0.46 [[cite:${a.id}]].`), {
        paragraphCitations: "omit",
      }),
      "Drift is 0.46.",
    );
    for (const tail of [
      " [[",
      " [[ci",
      " [[cite:",
      " [[cite:Q_1",
      " [[cite:Q_1]",
      " [[quo",
      " [[quote:Q_1",
    ]) {
      assert.equal(
        stripPartialTrailingCitationToken(`Drift is 0.46${tail}`),
        "Drift is 0.46",
        tail,
      );
    }
    assert.equal(
      stripPartialTrailingCitationToken("Done [[cite:Q_1]]"),
      "Done [[cite:Q_1]]",
    );
    assert.equal(
      buildAssistantDisplayMarkdownForRender({
        text: `Drift is slow [[cite:${a.id}]]. Next [[cite:${b.id}`,
        quoteCitations: [a, b],
        streaming: true,
      }),
      "Drift is slow. Next",
    );
  });

  it("the quote gate keeps raw citation tokens", function () {
    assert.equal(
      buildQuoteExpandedMarkdown(plan(`Drift [[cite:${a.id};invented]].`), {
        paragraphCitations: "preserve",
      }),
      `Drift [[cite:${a.id}]].`,
    );
  });
});

describe("citation marks outside the answer's own plan", function () {
  /** The ids of each placeholder in a display markdown, in order. */
  const placeholderIds = (markdown: string) =>
    [...markdown.matchAll(PARAGRAPH_CITATION_TOKEN_PATTERN)].map((match) =>
      paragraphCitationPlaceholderIds(match[1]),
    );

  it("a placeholder carries its own ids", function () {
    for (const ids of [["Q_a"], ["Q1.a", "p:1", "x-y"], [a.id, b.id]]) {
      const token = paragraphCitationPlaceholder(ids);
      assert.match(token, /^LLMPAPERCITE[0-9a-f]+END$/);
      assert.deepEqual(placeholderIds(`x ${token}.`), [ids], ids.join(" "));
    }
  });

  it("a trace segment's mark resolves to the segment's own citations", function () {
    // Live review: "Step found X [[cite:Q_z]]." in trace text showed the
    // answer's first passage, because its placeholder index restarted at 0.
    const c = buildQuoteCitation({
      ...a,
      id: undefined,
      citationLabel: "(Park, 2024)",
      contextItemId: 41,
      itemId: 40,
    })!;
    const message = {
      text: `Answer one [[cite:${a.id}]]. Answer two [[cite:${b.id}]].`,
      quoteCitations: [a, b, c],
    };
    const segment = buildAssistantDisplayMarkdownForRender({
      ...message,
      text: `Step found X [[cite:${c.id}]]. And again [[cite:${b.id}]].`,
    });
    assert.deepEqual(placeholderIds(segment), [[c.id], [b.id]]);
    const numberOf = createCitationNumberer(
      paragraphCitationNumbers(
        buildQuoteRenderPlan(getMessageQuoteDisplay(message)),
      ),
    );
    assert.equal(numberOf(b.id), 2, "an answer id keeps its answer number");
    assert.equal(numberOf(c.id), 3, "a trace-only id continues after them");
    assert.equal(numberOf(c.id), 3);
    assert.equal(numberOf("Q_other"), 4);
    const later = createCitationNumberer(
      paragraphCitationNumbers(
        buildQuoteRenderPlan(getMessageQuoteDisplay(message)),
      ),
      [
        [c.id, 3],
        [a.id, 9],
      ],
    );
    assert.equal(later(a.id), 1, "an answer number wins over a stale mark");
    assert.equal(later(c.id), 3, "a shown trace-only number is kept");
    assert.equal(later("Q_new"), 4);
  });

  it("a web answer's marks and Task progress use the answer's own text", function () {
    const text = `Drift is slow [[cite:${a.id}]]<!--llm-web-source:web_1-->[[cite:${b.id}]].`;
    const message = {
      text,
      quoteCitations: [a, b],
      // A display override that the web answer never shows.
      quoteDisplayOverride: {
        markdown: `Drift is slow [[cite:${b.id}]].`,
        quoteCitations: [b],
      },
    };
    const markdown = buildAssistantDisplayMarkdownForRender(message, [
      {
        offset: 0,
        placement: "end",
        sources: [{ id: "web_1", title: "Web", url: "https://example.org" }],
      } as any,
    ]);
    const shownIds = placeholderIds(markdown).flat();
    assert.includeMembers(shownIds, [a.id, b.id], "both passages get a mark");
    const listed = buildTaskAnswerCitations(message, { hasWebSources: true });
    assert.deepEqual(
      listed.map((entry) => [entry.id, entry.number]),
      [
        [a.id, 1],
        [b.id, 2],
      ],
    );
    assert.deepEqual(
      buildTaskAnswerCitations(message).map((entry) => [
        entry.id,
        entry.number,
      ]),
      [[b.id, 1]],
      "without web sources the override is the answer",
    );
  });

  it("drops an escaped token's backslash from a cited sentence", function () {
    assert.deepEqual(
      indexAnswerCitations(
        "Write \\[[cite:Q_b]] literally [[cite:Q_a]].",
        new Set(["Q_a", "Q_b"]),
      ),
      [{ id: "Q_a", number: 1, sentences: ["Write literally."] }],
    );
  });

  it("leaves web-source markers and anchor tokens out of a cited sentence", function () {
    const valid = new Set(["Q_a", "Q_b", "Q_c"]);
    assert.deepEqual(
      indexAnswerCitations(
        "Drift is slow <!--llm-web-source:web_1--> [[cite:Q_a]]. Activity is stable.<!-- llm-web-source: web_2 --> [[cite:Q_b]] Next LLMWEBSOURCEANCHOR0END one [[cite:Q_c]].",
        valid,
      ).map((entry) => entry.sentences),
      [["Drift is slow."], ["Activity is stable."], ["Next one."]],
    );
  });

  it("keeps a hard line break after the labels a line ends with", function () {
    assert.equal(
      buildQuoteExpandedMarkdown(
        {
          markdown: `First line [[cite:${a.id}]].  \nSecond line.`,
          quoteCitations: [a],
        },
        { paragraphCitations: "line-labels" },
      ),
      "First line. (Kim, 2026)  \nSecond line.",
    );
  });

  it("treats an ellipsis as one closing punctuation run before a mark", function () {
    assert.equal(leadingSentenceClose("... and more"), "...");
    assert.equal(leadingSentenceClose("…"), "…");
    assert.equal(leadingSentenceClose("?!” Next"), "?!”");
    assert.equal(leadingSentenceClose(".) Next"), ".)");
    assert.equal(leadingSentenceClose(", and"), "");
  });
});
