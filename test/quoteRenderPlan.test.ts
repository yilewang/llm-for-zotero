import { assert } from "chai";
import {
  buildQuoteDisplayMarkdown,
  buildQuoteExpandedMarkdown,
  buildQuoteRenderPlan,
  QUOTE_RENDER_OCCURRENCE_PATTERN,
} from "../src/modules/contextPanel/quoteRenderPlan";
import { buildQuoteCitation } from "../src/modules/contextPanel/quoteCitations";

describe("quoteRenderPlan", function () {
  it("converts legacy markdown blockquotes with adjacent citation labels into render occurrences", function () {
    const markdown = [
      "The old assistant answer said:",
      "",
      "> Here, we advocate for modeling approaches that replace unmodeled variability with mechanisms supporting efficiency, robustness, and flexibility.",
      ">",
      "> (Rentzeperis et al., 2026)",
      "",
      "Then it continued.",
    ].join("\n");

    const plan = buildQuoteRenderPlan({ markdown });

    assert.lengthOf(plan.occurrences, 1);
    assert.equal(plan.occurrences[0].trust, "legacy-inferred");
    assert.equal(plan.occurrences[0].source, "legacy-markdown");
    assert.equal(
      plan.occurrences[0].citationLabel,
      "(Rentzeperis et al., 2026)",
    );
    assert.include(
      plan.occurrences[0].displayText,
      "replace unmodeled variability",
    );
    assert.notInclude(plan.displayMarkdown, "(Rentzeperis et al., 2026)");
    assert.match(plan.displayMarkdown, QUOTE_RENDER_OCCURRENCE_PATTERN);
    assert.include(plan.displayMarkdown, "Then it continued.");
  });

  it("marks legacy markdown blockquotes as verified when quote metadata matches", function () {
    const citation = buildQuoteCitation({
      quoteText: "Verified legacy quote text should keep trusted navigation.",
      citationLabel: "(Ibrahim, 2026)",
      contextItemId: 77,
      sourceMatchKind: "trusted",
      sourceMatchSource: "context-text",
    });
    assert.isDefined(citation);

    const plan = buildQuoteRenderPlan({
      markdown: [
        "> Verified legacy quote text should keep trusted navigation.",
        ">",
        "> (Ibrahim, 2026)",
      ].join("\n"),
      quoteCitations: [citation!],
    });

    assert.lengthOf(plan.occurrences, 1);
    assert.equal(plan.occurrences[0].trust, "verified-source");
    assert.equal(plan.occurrences[0].source, "verified-markdown");
    assert.equal(plan.occurrences[0].quoteCitationId, citation!.id);
    assert.equal(plan.occurrences[0].contextItemId, 77);
    assert.equal(plan.diagnostics[0].kind, "verified-source");
  });

  it("leaves a deferred source-labelled quote unchanged", function () {
    const quote =
      "Among neuron pairs, does noise correlation change more favorably for high signal correlation?";
    const citationLabel = "(Eppler et al., 2026, page 3)";
    const markdown = `> ${quote}\n>\n> ${citationLabel}`;
    const plan = buildQuoteRenderPlan({ markdown });

    assert.lengthOf(plan.occurrences, 1);
    assert.equal(plan.occurrences[0].trust, "legacy-inferred");
    assert.equal(plan.occurrences[0].citationLabel, citationLabel);
    assert.match(plan.displayMarkdown, QUOTE_RENDER_OCCURRENCE_PATTERN);
    assert.equal(buildQuoteExpandedMarkdown({ markdown }), markdown);
  });

  it("does not alter an unresolved historical quote card", function () {
    const quote =
      "A historical quotation remains visible until complete evidence rejects it.";
    const citationLabel = "(Legacy et al., 2024)";
    const plan = buildQuoteRenderPlan({
      markdown: `> ${quote}\n>\n> ${citationLabel}`,
    });

    assert.lengthOf(plan.occurrences, 1);
    assert.equal(plan.occurrences[0].trust, "legacy-inferred");
    assert.equal(plan.occurrences[0].citationLabel, citationLabel);
  });

  it("renders a rejected quote as a non-source quote card", function () {
    const quote =
      "This model interpretation has no searchable wording in the complete source.";
    const markdown = `> ${quote}\n>\n> Not a source quote`;
    const plan = buildQuoteRenderPlan({ markdown });
    assert.lengthOf(plan.occurrences, 1);
    assert.equal(plan.occurrences[0].trust, "not-source-quote");
    assert.equal(plan.occurrences[0].citationLabel, "Not a source quote");
    assert.equal(buildQuoteDisplayMarkdown({ markdown }), plan.displayMarkdown);
    assert.equal(
      buildQuoteExpandedMarkdown({ markdown }),
      `> ${quote}\n>\n> Not a source quote`,
    );
  });

  it("renders a unique partial source as an ordinary trusted quote", function () {
    const quote =
      "A source-heavy summary adds wording that does not appear in the paper.";
    const citation = buildQuoteCitation({
      quoteText:
        "A source-heavy summary contains a uniquely searchable source passage.",
      displayQuoteText: quote,
      citationLabel: "(Eppler et al., 2026)",
      sourceMatchKind: "raw-prefix",
      sourceMatchSource: "pdf-page-text",
      contextItemId: 81,
      itemId: 80,
    });
    assert.isDefined(citation);
    const markdown = `[[quote:${citation!.id}]]`;
    const plan = buildQuoteRenderPlan({
      markdown,
      quoteCitations: [citation!],
    });

    assert.lengthOf(plan.occurrences, 1);
    assert.equal(plan.occurrences[0].trust, "trusted-anchor");
    assert.equal(plan.occurrences[0].citationLabel, "(Eppler et al., 2026)");
    assert.equal(plan.occurrences[0].contextItemId, 81);
    assert.equal(
      buildQuoteExpandedMarkdown({
        markdown,
        quoteCitations: [citation!],
      }),
      `> ${quote}\n>\n> (Eppler et al., 2026)`,
    );
  });

  it("keeps adjacent and repeated structured quote anchors as separate render occurrences", function () {
    const citation = buildQuoteCitation({
      quoteText: "The same source quote can be useful twice.",
      citationLabel: "(Lee, 2026)",
      contextItemId: 42,
      sourceMatchKind: "trusted",
      sourceMatchSource: "context-text",
    });
    assert.isDefined(citation);

    const plan = buildQuoteRenderPlan({
      markdown: `[[quote:${citation!.id}]]\n[[quote:${citation!.id}]]`,
      quoteCitations: [citation!],
    });

    assert.lengthOf(plan.occurrences, 2);
    assert.notEqual(
      plan.occurrences[0].occurrenceId,
      plan.occurrences[1].occurrenceId,
    );
    assert.deepEqual(
      plan.occurrences.map((occurrence) => occurrence.trust),
      ["trusted-anchor", "trusted-anchor"],
    );
    assert.equal(
      (plan.displayMarkdown.match(QUOTE_RENDER_OCCURRENCE_PATTERN) || [])
        .length,
      2,
    );
    assert.notInclude(plan.displayMarkdown, "[[quote:");
  });

  it("uses full structured quote text for lookup when sourceMatchText is only a terminal locator", function () {
    const quoteText = [
      "## 3 Discussion",
      "In this study, we showed that representational similarity is preserved as a generic mathematical consequence of random connectivity: in random networks, pairwise similarities between inputs are largely reflected in the outputs, independent of the specific connectivity pattern.",
      "Drift, whether random synaptic turnover or Hebbian plasticity, merely transitions the network between random instantiations, leaving this similarity intact.",
    ].join("\n\n");
    const citation = buildQuoteCitation({
      quoteText,
      citationLabel: "(Eppler et al., 2026)",
      sourceMatchText: "this similarity intact",
      sourceMatchKind: "raw-middle",
      sourceMatchSource: "context-text",
      contextItemId: 14,
    });
    assert.isDefined(citation);

    const plan = buildQuoteRenderPlan({
      markdown: `[[quote:${citation!.id}]]`,
      quoteCitations: [citation!],
    });

    assert.lengthOf(plan.occurrences, 1);
    assert.notEqual(plan.occurrences[0].lookupText, "this similarity intact");
    assert.match(plan.occurrences[0].lookupText, /^In this study/);
    assert.notInclude(plan.occurrences[0].lookupText, "##");
    assert.notInclude(plan.occurrences[0].lookupText, "3 Discussion");
    assert.include(
      plan.occurrences[0].lookupText,
      "leaving this similarity intact",
    );
  });

  it("preserves ordinary fenced-code markdown when no quote conversion is needed", function () {
    const markdown = [
      "Before",
      "",
      "```text",
      "line 1",
      "",
      "",
      "line 4",
      "```",
      "",
      "After",
      "",
    ].join("\n");

    assert.equal(buildQuoteDisplayMarkdown({ markdown }), markdown);
  });

  it("preserves fenced-code blank lines near structured quote occurrences", function () {
    const citation = buildQuoteCitation({
      quoteText: "The same source quote can be useful twice.",
      citationLabel: "(Lee, 2026)",
      contextItemId: 42,
      sourceMatchKind: "trusted",
      sourceMatchSource: "context-text",
    });
    assert.isDefined(citation);
    const markdown = [
      `[[quote:${citation!.id}]]`,
      "",
      "```text",
      "line 1",
      "",
      "",
      "line 4",
      "```",
      "",
    ].join("\n");

    const plan = buildQuoteRenderPlan({
      markdown,
      quoteCitations: [citation!],
    });

    assert.equal(
      plan.displayMarkdown,
      [
        "[[quote-occurrence:QO_0]]",
        "",
        "```text",
        "line 1",
        "",
        "",
        "line 4",
        "```",
        "",
      ].join("\n"),
    );
  });

  it("converts blockquote-wrapped structured anchors into render occurrences", function () {
    const citation = buildQuoteCitation({
      quoteText:
        "Structured anchors must not leak when wrapped as blockquotes.",
      citationLabel: "(Nguyen, 2026)",
      contextItemId: 44,
      sourceMatchKind: "trusted",
      sourceMatchSource: "context-text",
    });
    assert.isDefined(citation);

    const plan = buildQuoteRenderPlan({
      markdown: `> [[quote:${citation!.id}]]\n\nAfterward.`,
      quoteCitations: [citation!],
    });

    assert.lengthOf(plan.occurrences, 1);
    assert.equal(plan.occurrences[0].trust, "trusted-anchor");
    assert.include(plan.displayMarkdown, "[[quote-occurrence:");
    assert.notInclude(plan.displayMarkdown, `[[quote:${citation!.id}]]`);
    assert.notInclude(plan.displayMarkdown, "> [[quote:");
    assert.include(plan.displayMarkdown, "Afterward.");
  });

  it("does not create legacy quote occurrences from fenced blockquote examples", function () {
    const markdown = [
      "```mermaid",
      "> This is not a quote.",
      ">",
      "> (Example, 2026)",
      "```",
      "",
      "> Actual evidence text belongs in a quote card.",
      ">",
      "> (Real, 2026)",
    ].join("\n");

    const plan = buildQuoteRenderPlan({ markdown });

    assert.lengthOf(plan.occurrences, 1);
    assert.equal(plan.occurrences[0].citationLabel, "(Real, 2026)");
    assert.notInclude(plan.occurrences[0].displayText, "This is not a quote");
    assert.include(plan.displayMarkdown, "```mermaid");
  });

  it("repairs the historical author-plus-anchor shape to the exact displayed subspan", function () {
    const visibleQuote =
      "Consistently, pattern identity remained perfectly decodable from population activity throughout the drift period. Together, these results show that local predictive plasticity generates drifting but organized assemblies. Individual neurons gradually changed their assembly membership, yet the population retained a structured assembly organization throughout.";
    const chunk = `${"Earlier retrieval evidence context. ".repeat(28)}${visibleQuote} ${"Later retrieval evidence context. ".repeat(25)}`;
    const citation = buildQuoteCitation({
      id: "Q_1f7prrm",
      quoteText: chunk,
      citationLabel: "(Asabuki and Clopath)",
      contextItemId: 3617,
      itemId: 3618,
    })!;

    const plan = buildQuoteRenderPlan({
      markdown: `> ${visibleQuote}\n> (Asabuki and Clopath) [[quote:${citation.id}]]`,
      quoteCitations: [citation],
    });

    assert.isAbove(chunk.length, 2_000);
    assert.lengthOf(plan.occurrences, 1);
    assert.equal(plan.occurrences[0].displayText, visibleQuote);
    assert.equal(plan.occurrences[0].lookupText, visibleQuote);
    assert.equal(plan.occurrences[0].quoteCitation?.quoteText, visibleQuote);
    assert.equal(
      plan.occurrences[0].quoteCitation?.sourceMatchText,
      visibleQuote,
    );
    assert.notInclude(plan.occurrences[0].lookupText, "Earlier retrieval");
  });

  it("keeps an exact displayed quote above 10,000 characters intact", function () {
    const quote = `${"A complete source span remains fully searchable. ".repeat(240)}Final source sentence.`;
    const citation = buildQuoteCitation({
      id: "Q_long_complete",
      quoteText: quote,
      citationLabel: "(Long Quote, 2026)",
      contextItemId: 42,
    })!;
    const plan = buildQuoteRenderPlan({
      markdown: `> ${quote}\n> (Long Quote, 2026) [[quote:${citation.id}]]`,
      quoteCitations: [citation],
    });

    assert.isAbove(quote.length, 10_000);
    assert.lengthOf(plan.occurrences, 1);
    assert.equal(plan.occurrences[0].lookupText, quote);
  });

  it("splits a historical ellipsized quote into complete contiguous occurrences", function () {
    const first =
      "The previous assembly representation declined before the stable neuronal reassignment.";
    const second =
      "The new assembly representation rose before the change and became dominant afterward.";
    const citation = buildQuoteCitation({
      id: "Q_historical_ellipsis",
      quoteText: `${first} Omitted source wording. ${second}`,
      citationLabel: "(Asabuki and Clopath)",
      contextItemId: 3617,
    })!;
    const plan = buildQuoteRenderPlan({
      markdown: `> ${first} ... ${second}\n> (Asabuki and Clopath) [[quote:${citation.id}]]`,
      quoteCitations: [citation],
    });

    assert.lengthOf(plan.occurrences, 2);
    assert.deepEqual(
      plan.occurrences.map((occurrence) => occurrence.lookupText),
      [first, second],
    );
  });
});
