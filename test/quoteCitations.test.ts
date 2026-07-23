import { assert } from "chai";
import {
  buildQuoteAnchorPromptBlock,
  buildQuoteCitation,
  buildQuoteSourceIndex,
  buildSelectedTextQuoteCitations,
  extractQuoteCitationsFromToolContent,
  finalizeAssistantQuoteCitations,
  finalizeAssistantQuoteCitationsCooperatively,
  findUnresolvedQuoteCitationPlaceholderIds,
  isCanonicalQuoteSourceLabel,
  isNonSourceQuoteLabel,
  isQuoteWorthySourceText,
  isSectionOnlyCitationLabel,
  mergeQuoteCitations,
  normalizeQuoteCitationPlaceholdersForDisplay,
  replaceQuoteCitationPlaceholdersForMarkdown,
  sanitizeInvalidStructuredSourceMarkers,
} from "../src/modules/contextPanel/quoteCitations";
import { stripLeadingCitationSeparators } from "../src/modules/contextPanel/citationText";
import { buildQuoteTextIndex } from "../src/modules/contextPanel/quoteTextNormalization";
import { renderMarkdown } from "../src/utils/markdown";

describe("quoteCitations", function () {
  function countOccurrences(value: string, needle: string): number {
    if (!needle) return 0;
    return value.split(needle).length - 1;
  }

  it("reuses the immutable page-text index supplied by extraction", function () {
    const sourceText =
      "A prepared source index must be reused instead of normalized again for each assistant message.";
    const textIndex = buildQuoteTextIndex(sourceText);

    const sourceIndex = buildQuoteSourceIndex({
      sourceTexts: [
        {
          sourceText,
          textIndex,
          sourceLabel: "(Cache et al., 2026)",
          sourceMatchSource: "pdf-page-text",
          contextItemId: 22,
          itemId: 11,
        },
      ],
    });

    assert.lengthOf(sourceIndex.sources, 1);
    assert.strictEqual(sourceIndex.sources[0].textIndex, textIndex);
  });

  it("verifies fifty quote cards across a ten-paper source scope cooperatively", async function () {
    this.timeout(10_000);
    const sourceTexts = Array.from({ length: 10 }, (_paper, paperIndex) => {
      const quotes = Array.from(
        { length: 5 },
        (_quote, quoteIndex) =>
          `Paper ${paperIndex + 1} source result ${quoteIndex + 1} reports a distinct longitudinal neural population observation for validation.`,
      );
      return {
        quotes,
        source: {
          sourceText: quotes.join(" "),
          sourceLabel: `(Author${paperIndex + 1} et al., 2026)`,
          sourceMatchSource: "pdf-page-text",
          contextItemId: 1_000 + paperIndex,
          itemId: 2_000 + paperIndex,
          pageHintIndex: 0,
          sourceFingerprint: `paper-${paperIndex + 1}`,
        },
      };
    });
    const markdown = sourceTexts
      .flatMap((entry) => entry.quotes)
      .map((quote) => `> ${quote}`)
      .join("\n\n");

    let yields = 0;
    const sliceDurations: number[] = [];
    const finalized = await finalizeAssistantQuoteCitationsCooperatively(
      {
        markdown,
        sourceIndex: buildQuoteSourceIndex({
          sourceTexts: sourceTexts.map((entry) => entry.source),
        }),
        quoteSourceReview: { sourceEvidenceComplete: true },
      },
      {
        yieldToMain: async () => {
          yields += 1;
        },
        onSliceComplete: (elapsedMs) => {
          sliceDurations.push(elapsedMs);
        },
      },
    );

    assert.isNotNull(finalized);
    assert.equal(countOccurrences(finalized!.markdown, "[[quote:"), 50);
    assert.lengthOf(finalized!.quoteCitations, 50);
    assert.notInclude(finalized!.markdown, "Not a source quote");
    assert.isAtLeast(yields, 5);
    assert.isBelow(Math.max(...sliceDurations), 50);
  });

  it("cancels cooperative quote matching before stale results can be returned", async function () {
    const quote =
      "A cooperative provenance match must stop when its conversation generation becomes stale.";
    let current = true;
    let yields = 0;
    let now = 0;

    const finalized = await finalizeAssistantQuoteCitationsCooperatively(
      {
        markdown: `> ${quote}`,
        sourceIndex: buildQuoteSourceIndex({
          sourceTexts: [
            {
              sourceText: quote,
              sourceLabel: "(Cancellation et al., 2026)",
              sourceMatchSource: "pdf-page-text",
              contextItemId: 31,
              itemId: 30,
              pageHintIndex: 0,
              sourceFingerprint: "cancel-source",
            },
          ],
        }),
        quoteSourceReview: { sourceEvidenceComplete: true },
      },
      {
        now: () => {
          now += 7;
          return now;
        },
        shouldContinue: () => current,
        yieldToMain: async () => {
          yields += 1;
          current = false;
        },
      },
    );

    assert.isNull(finalized);
    assert.equal(yields, 1);
  });

  it("rejects publication metadata and front-matter boilerplate as quote-worthy text", function () {
    const cases = [
      "Changes in perceptual sampling contribute to representational drift Yixin Yuan1, Mikio C.",
      "University of Cambridge, Department of Psychology, Cambridge CB2 3EB, United Kingdom",
      "Department of Neuroscience, University of Example, 1 Institute Road, Boston, MA 02115",
      "Correspondence should be addressed to the lead author at author@example.edu",
      "Highlights - Neural responses were recorded over repeated sessions - Calcium imaging was used",
    ];

    for (const text of cases) {
      assert.isFalse(isQuoteWorthySourceText(text), text);
      assert.isUndefined(
        buildQuoteCitation({
          quoteText: text,
          citationLabel: "(Metadata et al., 2026)",
          sourceMatchKind: "trusted",
          sourceMatchSource: "context-text",
          contextItemId: 12,
          itemId: 11,
        }),
        text,
      );
    }
  });

  it("rejects blockquotes made only from extracted Markdown images", function () {
    assert.isFalse(
      isQuoteWorthySourceText(
        "![](images/figure-a.jpg) h ![](images/figure-b.jpg) i",
      ),
    );
  });

  it("keeps substantive scientific spans quote-worthy", function () {
    const text =
      "Despite global representational drift, the relative geometry of population responses remained stable across repeated conditions.";

    assert.isTrue(isQuoteWorthySourceText(text));
    assert.exists(
      buildQuoteCitation({
        quoteText: text,
        citationLabel: "(Zheng et al., 2026)",
        sourceMatchKind: "trusted",
        sourceMatchSource: "context-text",
        contextItemId: 12,
        itemId: 11,
      }),
    );
  });

  it("generates stable ids from quote text, citation label, and context item", function () {
    const first = buildQuoteCitation({
      quoteText: "The models will offer a set of categories.",
      citationLabel: "(Montague et al., 2012)",
      contextItemId: 123,
    });
    const second = buildQuoteCitation({
      quoteText: "The models will offer a set of categories.",
      citationLabel: "(Montague et al., 2012)",
      contextItemId: 123,
    });

    assert.isDefined(first);
    assert.equal(first?.id, second?.id);
    assert.match(first?.id || "", /^Q_[a-z0-9]+$/);
  });

  it("preserves valid citation page hints without including them in stable ids", function () {
    const first = buildQuoteCitation({
      quoteText:
        "Stable readout can persist even when the underlying population representation drifts over days.",
      citationLabel: "(Hint et al., 2026)",
      contextItemId: 123,
      pageHintIndex: 4.8,
      pageHintLabel: " v ",
    });
    const second = buildQuoteCitation({
      quoteText:
        "Stable readout can persist even when the underlying population representation drifts over days.",
      citationLabel: "(Hint et al., 2026)",
      contextItemId: 123,
      pageHintIndex: 10,
      pageHintLabel: "11",
    });

    assert.equal(first?.pageHintIndex, 4);
    assert.equal(first?.pageHintLabel, "v");
    assert.equal(first?.id, second?.id);
  });

  it("drops invalid citation page hints while preserving old records", function () {
    const citation = buildQuoteCitation({
      quoteText:
        "The verified quote citation shape must remain backward compatible when stored records lack page hints.",
      citationLabel: "(Compat et al., 2026)",
      contextItemId: 123,
      pageHintIndex: -1,
      pageHintLabel: "   ",
    });

    assert.isDefined(citation);
    assert.isUndefined(citation?.pageHintIndex);
    assert.isUndefined(citation?.pageHintLabel);
  });

  it("preserves source page hints through trusted quote finalization", function () {
    const quote =
      "A stable readout can be maintained despite substantial representational drift in the recorded population.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}\n\n(Model et al., 2026)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: quote,
            sourceLabel: "(Source et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 22,
            itemId: 11,
            pageHintIndex: 6,
            pageHintLabel: "S7",
          },
        ],
      }),
    });

    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(
      finalized.quoteCitations[0].citationLabel,
      "(Source et al., 2026)",
    );
    assert.equal(finalized.quoteCitations[0].pageHintIndex, 6);
    assert.equal(finalized.quoteCitations[0].pageHintLabel, "S7");
  });

  it("keeps the first non-empty page hints when duplicate quote citations merge", function () {
    const base = {
      id: "Q_duplicate_hint",
      quoteText:
        "Duplicate quote anchors should retain the first useful page hint found during finalization.",
      citationLabel: "(Merge et al., 2026)",
      contextItemId: 123,
    };
    const first = buildQuoteCitation(base);
    const second = buildQuoteCitation({
      ...base,
      pageHintIndex: 8,
      pageHintLabel: "9",
    });
    const third = buildQuoteCitation({
      ...base,
      pageHintIndex: 12,
      pageHintLabel: "13",
    });

    const merged = mergeQuoteCitations([first!, second!, third!]);

    assert.lengthOf(merged, 1);
    assert.equal(merged[0].pageHintIndex, 8);
    assert.equal(merged[0].pageHintLabel, "9");
  });

  it("strips nested quote anchors from display quote text", function () {
    const citation = buildQuoteCitation({
      quoteText:
        "Note that high signal correlations between pairs of neurons at a given imaging time point do not necessarily indicate high noise correlations and vice versa.",
      displayQuoteText:
        "Note that high signal correlations between pairs of neurons at a given imaging time point do not necessarily indicate high noise correlations and vice versa. [[quote:Q_1b7wj09]]",
      citationLabel: "(Eppler et al., 2026)",
      contextItemId: 3097,
      itemId: 3096,
    });

    assert.isDefined(citation);
    assert.isUndefined(citation!.displayQuoteText);
    assert.notInclude(citation!.displayQuoteText || "", "[[quote:");
  });

  it("builds selected PDF text anchors and prompt tokens", function () {
    const anchors = buildSelectedTextQuoteCitations(
      ["quoted PDF passage", "note text"],
      ["pdf", "note"],
      [
        {
          itemId: 10,
          contextItemId: 11,
          title: "Paper",
          firstCreator: "Smith",
          year: "2024",
        },
        undefined,
      ],
    );

    assert.lengthOf(anchors, 1);
    assert.equal(anchors[0].citationLabel, "(Smith, 2024)");
    const prompt = buildQuoteAnchorPromptBlock(anchors).join("\n");
    assert.include(prompt, `[[quote:${anchors[0].id}]]`);
    assert.include(prompt, "quoteText");
    assert.include(prompt, "sourceLabel");
    assert.notInclude(prompt, "citationLabel");
  });

  it("frames prompt quote anchors as verified exact-wording affordances", function () {
    const citation = buildQuoteCitation({
      quoteText:
        "Representational drift changed the neural response pattern across repeated sessions.",
      citationLabel: "(Anchor et al., 2026)",
      sourceMatchKind: "trusted",
      sourceMatchSource: "context-text",
      contextItemId: 123,
      itemId: 456,
    });

    const prompt = buildQuoteAnchorPromptBlock([citation!]).join("\n");

    assert.include(prompt, "Verified quote anchors");
    assert.include(prompt, "only when exact wording");
    assert.notInclude(prompt, "Quote anchors for direct evidence:");
  });

  it("can omit unverified generated quote placeholders during live finalization", function () {
    const unverified = buildQuoteCitation({
      quoteText:
        "This unverified retrieved snippet should not become a live quote card.",
      citationLabel: "(Snippet et al., 2026)",
      contextItemId: 123,
      itemId: 456,
    });

    const finalized = finalizeAssistantQuoteCitations({
      markdown: `Claim [[quote:${unverified!.id}]]`,
      quoteCitations: [unverified!],
      requireVerifiedQuoteCitations: true,
    });

    assert.equal(finalized.markdown, "Claim");
    assert.lengthOf(finalized.quoteCitations, 0);
  });

  it("does not let unverified generated quote candidates self-verify raw blockquotes", function () {
    const unverified = buildQuoteCitation({
      quoteText:
        "This unverified retrieved snippet should not become a live quote card.",
      citationLabel: "(Snippet et al., 2026)",
      contextItemId: 123,
      itemId: 456,
    });

    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "> This unverified retrieved snippet should not become a live quote card.\n\n(Snippet et al., 2026)",
      quoteCitations: [unverified!],
      requireVerifiedQuoteCitations: true,
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.lengthOf(finalized.quoteCitations, 0);
  });

  it("preserves verified generated quote placeholders during live finalization", function () {
    const verified = buildQuoteCitation({
      quoteText:
        "This verified retrieved snippet can become a live quote card.",
      citationLabel: "(Verified et al., 2026)",
      sourceMatchKind: "trusted",
      sourceMatchSource: "context-text",
      contextItemId: 123,
      itemId: 456,
    });

    const finalized = finalizeAssistantQuoteCitations({
      markdown: `Claim [[quote:${verified!.id}]]`,
      quoteCitations: [verified!],
      requireVerifiedQuoteCitations: true,
    });

    assert.include(finalized.markdown, `[[quote:${verified!.id}]]`);
    assert.lengthOf(finalized.quoteCitations, 1);
  });

  it("replaces known markdown placeholders with canonical blockquote citations", function () {
    const citation = buildQuoteCitation({
      quoteText: "A stable quote.",
      citationLabel: "(Lee, 2025)",
      contextItemId: 22,
    });
    assert.isDefined(citation);

    const rendered = replaceQuoteCitationPlaceholdersForMarkdown(
      `Evidence:\n\n[[quote:${citation!.id}]]`,
      [citation!],
    );

    assert.include(rendered, "> A stable quote.");
    assert.include(rendered, "> (Lee, 2025)");
    assert.include(rendered, "(Lee, 2025)");
    assert.notInclude(rendered, "[[quote:");
  });

  it("isolates preserved quote placeholders from following prose for display", function () {
    const normalized = normalizeQuoteCitationPlaceholdersForDisplay(
      "Evidence: [[quote:Q_stable]]\nSo **one component** handles all angles.",
    );

    assert.equal(
      normalized,
      "Evidence:\n\n[[quote:Q_stable]]\n\nSo **one component** handles all angles.",
    );
  });

  it("renders anchored quotes in the original source language inside Chinese answers", function () {
    const citation = buildQuoteCitation({
      quoteText: "Memory engrams are highly dynamic during consolidation.",
      citationLabel: "(Tomé, 2024)",
      contextItemId: 22,
    });
    assert.isDefined(citation);

    const rendered = replaceQuoteCitationPlaceholdersForMarkdown(
      `中文解释：\n\n[[quote:${citation!.id}]]\n\n这说明记忆痕迹会变化。`,
      [citation!],
    );

    assert.include(
      rendered,
      "> Memory engrams are highly dynamic during consolidation.",
    );
    assert.include(rendered, "中文解释");
    assert.notInclude(rendered, "> 记忆痕迹");
  });

  it("preserves Chinese quotes when Chinese is the original source text", function () {
    const citation = buildQuoteCitation({
      quoteText: "记忆痕迹在巩固过程中具有高度动态性。",
      citationLabel: "(王, 2024)",
      contextItemId: 22,
    });
    assert.isDefined(citation);

    const rendered = replaceQuoteCitationPlaceholdersForMarkdown(
      `证据：\n\n[[quote:${citation!.id}]]`,
      [citation!],
    );

    assert.include(rendered, "> 记忆痕迹在巩固过程中具有高度动态性。");
    assert.include(rendered, "(王, 2024)");
  });

  it("preserves unmatched source-backed blockquotes as plain quoted text", function () {
    const citation = buildQuoteCitation({
      quoteText: "Memory engrams are highly dynamic during consolidation.",
      citationLabel: "(Tomé, 2024)",
      contextItemId: 22,
    });
    assert.isDefined(citation);

    const rendered = replaceQuoteCitationPlaceholdersForMarkdown(
      "解释：\n\n> 记忆痕迹在巩固过程中具有高度动态性。\n\n(Tomé, 2024)\n\n继续。",
      [citation!],
    );

    assert.include(rendered, "解释");
    assert.include(rendered, "继续");
    assert.include(rendered, "> 记忆痕迹在巩固过程中具有高度动态性。");
    assert.include(rendered, "(Tomé, 2024)");
    assert.notInclude(rendered, "[[quote:");
  });

  it("uses canonical same-line parsing on rendered source-backed blocks", function () {
    const quote =
      "The water-restricted mice received water rewards 2.25 m down a 3-m visual virtual track.";
    const citation = buildQuoteCitation({
      quoteText: quote,
      citationLabel: "(Climer et al., 2025)",
      sourceMatchKind: "exact",
      sourceMatchSource: "pdf-page-text",
      contextItemId: 2442,
      itemId: 2443,
      pageHintIndex: 0,
    });
    assert.isDefined(citation);

    const rendered = replaceQuoteCitationPlaceholdersForMarkdown(
      `> ${quote} (Climer et al., 2025)\nFollowing prose remains visible.`,
      [citation!],
    );

    assert.include(rendered, `> ${quote}`);
    assert.include(rendered, "> (Climer et al., 2025)");
    assert.include(rendered, "Following prose remains visible.");
    assert.notInclude(rendered, `${quote} (Climer et al., 2025)`);
  });

  it("does not consume a citation-shaped prefix from following prose", function () {
    const quote =
      "The water-restricted mice received water rewards at a stable location.";
    const citation = buildQuoteCitation({
      quoteText: quote,
      citationLabel: "(Climer et al., 2025)",
      sourceMatchKind: "exact",
      sourceMatchSource: "pdf-page-text",
      contextItemId: 2442,
      itemId: 2443,
      pageHintIndex: 0,
    });
    assert.isDefined(citation);
    const followingProse =
      "(Climer et al., 2025) This discussion sentence is not a citation line.";

    const rendered = replaceQuoteCitationPlaceholdersForMarkdown(
      `> ${quote}\n\n${followingProse}`,
      [citation!],
    );

    assert.include(rendered, followingProse);
  });

  it("keeps translated quotes unanchored when only the original source text exists", function () {
    const finalized = finalizeAssistantQuoteCitations({
      markdown: "> 记忆痕迹在巩固过程中具有高度动态性。\n\n(Tomé, 2024)",
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "Memory engrams are highly dynamic during consolidation.",
            sourceLabel: "(Tomé, 2024)",
            contextItemId: 22,
          },
        ],
      }),
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.lengthOf(finalized.quoteCitations, 0);
    assert.include(
      finalized.markdown,
      "> 记忆痕迹在巩固过程中具有高度动态性。",
    );
    assert.include(finalized.markdown, "(Tomé, 2024)");
  });

  it("repairs exact Chinese source blockquotes through unique source matches", function () {
    const quote = "记忆痕迹在巩固过程中具有高度动态性。";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}\n\n(王, 2024)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: quote,
            sourceLabel: "(王, 2024)",
            contextItemId: 22,
          },
        ],
      }),
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(finalized.quoteCitations[0].citationLabel, "(王, 2024)");
    assert.equal(finalized.quoteCitations[0].quoteText, quote);
  });

  it("repairs wrongly labeled quotes when exactly one source text matches", function () {
    const quote = "记忆痕迹在巩固过程中具有高度动态性。";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}\n\n(王, 2024)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: quote,
            sourceLabel: "(李, 2024)",
            contextItemId: 22,
          },
        ],
      }),
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(finalized.quoteCitations[0].quoteText, quote);
    assert.equal(finalized.quoteCitations[0].citationLabel, "(李, 2024)");
    assert.equal(finalized.quoteCitations[0].contextItemId, 22);
  });

  it("repairs stale model labels to the verified source paper", function () {
    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "> Paper A reports that the intervention improved recall accuracy.\n\n(Paper B, 2024)",
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "Paper A reports that the intervention improved recall accuracy.",
            sourceLabel: "(Paper A, 2024)",
            contextItemId: 1,
          },
          {
            sourceText:
              "Paper B reports no reliable change in recall accuracy.",
            sourceLabel: "(Paper B, 2024)",
            contextItemId: 2,
          },
        ],
      }),
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(finalized.quoteCitations[0].citationLabel, "(Paper A, 2024)");
    assert.equal(finalized.quoteCitations[0].contextItemId, 1);
  });

  it("preserves raw Claude source labels when quote verification does not resolve", function () {
    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "As the authors demonstrate:\n\n" +
        "> Although this learning rule only explicitly stabilizes zSt for the observed stimulus set S,\n" +
        "> which does not include the target stimulus x*, we find that the SNR of the readout is very stable.\n" +
        "> Strikingly, this is despite the representation of every stimulus, including the target stimulus, changing entirely.\n\n" +
        "(Zaid & Schaffer, 2026, page 5)\n\n" +
        "### Is it biologically plausible?",
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.lengthOf(finalized.quoteCitations, 0);
    assert.include(finalized.markdown, "(Zaid & Schaffer, 2026, page 5)");
    assert.include(finalized.markdown, "### Is it biologically plausible?");
  });

  it("keeps duplicate same-label source quotes unanchored without unique context", function () {
    const duplicatedQuote =
      "The same author-year label appears on two candidate source passages.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${duplicatedQuote}\n\n(Smith, 2024)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: duplicatedQuote,
            sourceLabel: "(Smith, 2024)",
            contextItemId: 1,
          },
          {
            sourceText: duplicatedQuote,
            sourceLabel: "(Smith, 2024)",
            contextItemId: 2,
          },
        ],
      }),
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.lengthOf(finalized.quoteCitations, 0);
    assert.include(finalized.markdown, `> ${duplicatedQuote}`);
  });

  it("repairs the Eppler paper quote when Claude emits a stale Aschauer label", function () {
    const quote =
      "data acquired from a mature and apparently stable brain on a given day, merely reflect a snapshot of two counterbalancing dynamic processes safeguarding functionality in an inherently unstable network.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}\n\n(Aschauer et al., 2025, Discussion)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: quote,
            sourceLabel: "(Eppler et al., 2026)",
            contextItemId: 3097,
            itemId: 3096,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 5,
            sourceFingerprint: "pdfjs:eppler-test",
          },
        ],
      }),
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(
      finalized.quoteCitations[0].citationLabel,
      "(Eppler et al., 2026)",
    );
    assert.equal(finalized.quoteCitations[0].contextItemId, 3097);
    assert.equal(finalized.quoteCitations[0].itemId, 3096);
    assert.equal(
      finalized.quoteCitations[0].sourceMatchSource,
      "pdf-page-text",
    );
  });

  it("drops paper-title blockquotes and their dangling title lead-ins", function () {
    const title =
      "Representational drift reflects ongoing balancing of stochastic changes by Hebbian learning";
    const finding =
      "Signal correlations at one time point are predictive of noise correlations in the future.";
    const sourceLabel = "(Eppler et al., 2026, page 1)";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: [
        "The central finding is that Hebbian-like plasticity and stochastic change jointly maintain functional stability. As the paper's title puts it,",
        "",
        `> ${title}`,
        "",
        sourceLabel,
      ].join("\n"),
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: `${title}\n\n${finding}`,
            sourceLabel,
            contextItemId: 3097,
            itemId: 3096,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 0,
            metadataTexts: [title],
          },
        ],
      }),
    });

    assert.equal(
      finalized.markdown,
      "The central finding is that Hebbian-like plasticity and stochastic change jointly maintain functional stability.",
    );
    assert.lengthOf(finalized.quoteCitations, 0);
    assert.notInclude(finalized.markdown, title);
    assert.notInclude(finalized.markdown, "paper's title puts it");
    assert.notInclude(finalized.markdown, "[[quote:");
  });

  it("filters preexisting paper-title quote placeholders", function () {
    const title =
      "Representational drift reflects ongoing balancing of stochastic changes by Hebbian learning";
    const sourceLabel = "(Eppler et al., 2026, page 1)";
    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "The paper argues [[quote:Q_title]] that functional stability is actively maintained.",
      quoteCitations: [
        {
          id: "Q_title",
          quoteText: title,
          citationLabel: sourceLabel,
          contextItemId: 3097,
          itemId: 3096,
        },
      ],
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "Signal correlations at one time point are predictive of noise correlations in the future.",
            sourceLabel,
            contextItemId: 3097,
            itemId: 3096,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 0,
            metadataTexts: [title],
          },
        ],
      }),
    });

    assert.equal(
      finalized.markdown,
      "The paper argues that functional stability is actively maintained.",
    );
    assert.lengthOf(finalized.quoteCitations, 0);
    assert.notInclude(finalized.markdown, title);
    assert.notInclude(finalized.markdown, "[[quote:");
  });

  it("keeps substantive first-page quotes eligible when title metadata is filtered", function () {
    const title =
      "Representational drift reflects ongoing balancing of stochastic changes by Hebbian learning";
    const quote =
      "Signal correlations at one time point are predictive of noise correlations in the future.";
    const sourceLabel = "(Eppler et al., 2026, page 1)";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}\n\n${sourceLabel}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: `${title}\n\n${quote}`,
            sourceLabel,
            contextItemId: 3097,
            itemId: 3096,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 0,
            metadataTexts: [title],
          },
        ],
      }),
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(finalized.quoteCitations[0].quoteText, quote);
    assert.equal(finalized.quoteCitations[0].citationLabel, sourceLabel);
  });

  it("keeps quote lead-ins from becoming blank when a manual quote is unmatched", function () {
    const rendered = replaceQuoteCitationPlaceholdersForMarkdown(
      "CNNs apply the same computation across every pixel in an image — as the authors put it:\n\n> This is prohibitively expensive for large images or video.\n\n(Mnih et al., 2014)\n\nThis motivates recurrent attention.",
      [],
      { resolved: "preserve", unresolved: "omit" },
    );

    assert.include(rendered, "as the authors put it:");
    assert.include(
      rendered,
      "> This is prohibitively expensive for large images or video.",
    );
    assert.include(rendered, "(Mnih et al., 2014)");
    assert.include(rendered, "This motivates recurrent attention.");
  });

  it("canonicalizes exact manual source-backed blockquotes through trusted anchors", function () {
    const citation = buildQuoteCitation({
      quoteText: "Memory engrams are highly dynamic during consolidation.",
      citationLabel: "(Tomé, 2024)",
      contextItemId: 22,
    });
    assert.isDefined(citation);

    const display = replaceQuoteCitationPlaceholdersForMarkdown(
      "Evidence:\n\n> Memory engrams are highly dynamic during consolidation.\n\n(Tomé, 2024)",
      [citation!],
      { resolved: "preserve" },
    );
    const exported = replaceQuoteCitationPlaceholdersForMarkdown(
      "Evidence:\n\n> Memory engrams are highly dynamic during consolidation.\n\n(Tomé, 2024)",
      [citation!],
    );

    assert.include(display, `[[quote:${citation!.id}]]`);
    assert.notInclude(display, "> Memory engrams");
    assert.include(exported, "> Memory engrams are highly dynamic");
    assert.include(exported, "(Tomé, 2024)");
  });

  it("rejects section-only labels and accepts canonical source labels", function () {
    for (const label of [
      "(Abstract)",
      "(Method)",
      "(Methods)",
      "(Methods, Defining manifold components)",
      "(Results)",
      "(Discussion)",
      "(Supplementary Table 1)",
      "(Supplementary Fig. 2)",
      "(Supplementary Fig. 2 caption)",
      "(Table 1)",
      "(Figure 3)",
      "(Fig. 1b caption)",
      "(Figure caption)",
      "(Caption)",
    ]) {
      assert.isTrue(isSectionOnlyCitationLabel(label), label);
      assert.isTrue(isNonSourceQuoteLabel(label), label);
      assert.isFalse(isCanonicalQuoteSourceLabel(label), label);
    }

    assert.isTrue(isCanonicalQuoteSourceLabel("(Smith et al., 2024)"));
    assert.isTrue(
      isCanonicalQuoteSourceLabel(
        "(translation.md, attachment under Rivera, 2024)",
      ),
    );
  });

  it("rejects locator fragments that do not carry a complete quote claim", function () {
    const cases = [
      "we demonstrate that changes",
      "a neuron's tuning stability.",
      "this similarity intact",
    ];

    for (const text of cases) {
      assert.isFalse(isQuoteWorthySourceText(text), text);
      assert.isUndefined(
        buildQuoteCitation({
          quoteText: text,
          citationLabel: "(Fragment et al., 2026)",
          sourceMatchKind: "raw-prefix",
          sourceMatchSource: "context-text",
          contextItemId: 12,
          itemId: 11,
        }),
        text,
      );
    }
  });

  it("repairs unlabeled exact paper blockquotes through unique source matches", function () {
    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "> The amount of neural realignment was comparable between IM and WMP components.",
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "The amount of neural realignment was comparable between IM and WMP components.",
            sourceLabel: "(Busch et al., 2026)",
            contextItemId: 22,
          },
        ],
      }),
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(
      finalized.quoteCitations[0].citationLabel,
      "(Busch et al., 2026)",
    );
    assert.equal(finalized.quoteCitations[0].sourceMatchKind, "exact");
  });

  it("keeps abstract quote cards allowed when body-evidence gating is not requested", function () {
    const quoteText =
      "The abstract summarizes the main representational drift finding.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quoteText}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: quoteText,
            sourceLabel: "(Smith et al., 2026)",
            contextItemId: 22,
            itemId: 21,
            sectionLabel: "Abstract",
            chunkKind: "abstract",
          },
          {
            sourceText:
              "The results explain the body-level mechanism behind the representational drift finding.",
            sourceLabel: "(Smith et al., 2026)",
            contextItemId: 22,
            itemId: 21,
            sectionLabel: "Results",
            chunkKind: "results",
          },
        ],
      }),
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(finalized.quoteCitations[0].quoteText, quoteText);
  });

  it("does not verify abstract quote cards for body-evidence turns when body source text is available", function () {
    const quoteText =
      "The abstract summarizes the main representational drift finding.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quoteText}`,
      requireBodyEvidenceQuotes: true,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: quoteText,
            sourceLabel: "(Smith et al., 2026)",
            contextItemId: 22,
            itemId: 21,
            sectionLabel: "Abstract",
            chunkKind: "abstract",
          },
          {
            sourceText:
              "The results explain the body-level mechanism behind the representational drift finding.",
            sourceLabel: "(Smith et al., 2026)",
            contextItemId: 22,
            itemId: 21,
            sectionLabel: "Results",
            chunkKind: "results",
          },
        ],
      }),
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.lengthOf(finalized.quoteCitations, 0);
    assert.include(finalized.markdown, quoteText);
  });

  it("retains full PDF page text during scoped body-evidence verification", function () {
    const quote =
      "The complete page text contains the only exact wording for this reported result.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "A body evidence chunk discusses a different reported result.",
            sourceLabel: "(Eppler et al., 2026)",
            sourceMatchSource: "context-text",
            chunkKind: "results",
            contextItemId: 81,
            itemId: 80,
          },
          {
            sourceText: quote,
            sourceLabel: "(Eppler et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 81,
            itemId: 80,
            pageHintIndex: 2,
            pageHintIndex: 2,
          },
        ],
      }),
      requireVerifiedQuoteCitations: true,
      requireBodyEvidenceQuotes: true,
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.equal(
      finalized.quoteCitations[0]?.sourceMatchSource,
      "pdf-page-text",
    );
  });

  it("does not let a same-label body source suppress another paper's abstract quote", function () {
    const abstractQuoteText =
      "The abstract summarizes a separate representational drift result from the second same-label paper.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${abstractQuoteText}`,
      requireBodyEvidenceQuotes: true,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "The results explain the body-level mechanism from the first same-label paper.",
            sourceLabel: "(Smith et al., 2026)",
            contextItemId: 22,
            itemId: 21,
            sectionLabel: "Results",
            chunkKind: "results",
          },
          {
            sourceText: abstractQuoteText,
            sourceLabel: "(Smith et al., 2026)",
            contextItemId: 23,
            itemId: 24,
            sectionLabel: "Abstract",
            chunkKind: "abstract",
          },
        ],
      }),
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(finalized.quoteCitations[0].quoteText, abstractQuoteText);
    assert.equal(finalized.quoteCitations[0].contextItemId, 23);
  });

  it("keeps an unsupported-tail blockquote unverified despite a large source span", function () {
    const sourceText =
      "We hypothesized that some brain states are easier for people to generate, and that tailoring training to these brain states will facilitate BCI learning.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "> We hypothesized that some brain states are easier for people to generate, and that tailoring training to these brain states will facilitate BCI learning. This added sentence is not source text.",
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText,
            sourceLabel: "(Busch et al., 2026)",
            contextItemId: 22,
          },
        ],
      }),
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.lengthOf(finalized.quoteCitations, 0);
    assert.include(
      finalized.markdown,
      "This added sentence is not source text",
    );
  });

  it("keeps a blockquote unverified when only an interior span is sourced", function () {
    const sourceText =
      "The encoder learned a nonlinear mapping from brain activity to the manifold in real time.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "> The assistant starts with unsupported wording. The encoder learned a nonlinear mapping from brain activity to the manifold in real time. Then it adds unsupported wording.",
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText,
            sourceLabel: "(Busch et al., 2026)",
            contextItemId: 22,
          },
        ],
      }),
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.lengthOf(finalized.quoteCitations, 0);
    assert.include(finalized.markdown, "unsupported wording");
  });

  it("splits ordered ellipsized source fragments into page-bounded cards", function () {
    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "> “The amount of neural realignment was comparable between IM and WMP components ... and greater than for the OMP component. ... This realignment was possible, given that WMP was on the intrinsic manifold.”",
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "The amount of neural realignment was comparable between IM and WMP components during the task, and greater than for the OMP component. These results indicate a structured change. This realignment was possible, given that WMP was on the intrinsic manifold.",
            sourceLabel: "(Busch et al., 2026)",
            contextItemId: 22,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 2,
          },
        ],
      }),
    });

    assert.equal(countOccurrences(finalized.markdown, "[[quote:"), 3);
    assert.lengthOf(finalized.quoteCitations, 3);
    assert.deepEqual(
      finalized.quoteCitations.map((citation) => citation.pageHintIndex),
      [2, 2, 2],
    );
  });

  it("keeps ellipsized cards in displayed order when extraction order differs", function () {
    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "> Multi-voxel fMRI patterns were extracted during this task ... These patterns were then embedded into a low-dimensional manifold using the T-PHATE algorithm. ... T-PHATE learns a lower dimensional manifold for each participant.",
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "T-PHATE learns a lower dimensional manifold for each participant. Figure 1 caption text follows later in the extracted PDF stream. Multi-voxel fMRI patterns were extracted during this task from a network of brain regions implicated in spatial navigation. These patterns were then embedded into a low-dimensional manifold using the T-PHATE algorithm.",
            sourceLabel: "(Busch et al., 2026)",
            contextItemId: 22,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 2,
          },
        ],
      }),
    });

    assert.equal(countOccurrences(finalized.markdown, "[[quote:"), 3);
    assert.deepEqual(
      finalized.quoteCitations.map((citation) => citation.quoteText),
      [
        "Multi-voxel fMRI patterns were extracted during this task",
        "These patterns were then embedded into a low-dimensional manifold using the T-PHATE algorithm.",
        "T-PHATE learns a lower dimensional manifold for each participant.",
      ],
    );
  });

  it("splits page-bounded ellipsized cards across hyphenation differences", function () {
    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "> The encoder learned a nonlinear mapping ... projected the embedded data onto C_OMP.",
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "The encoder learned a non-linear mapping from brain activity to the manifold. We then projected the embedded data onto C-OMP.",
            sourceLabel: "(Busch et al., 2026)",
            contextItemId: 22,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 2,
          },
        ],
      }),
    });

    assert.equal(countOccurrences(finalized.markdown, "[[quote:"), 2);
    assert.lengthOf(finalized.quoteCitations, 2);
  });

  it("keeps ambiguous ellipsized quotes unanchored", function () {
    const sourceText =
      "The amount of neural realignment was comparable between IM and WMP components during the task, and greater than for the OMP component.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "> The amount of neural realignment was comparable ... greater than for the OMP component.",
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          { sourceText, sourceLabel: "(One, 2024)", contextItemId: 1 },
          { sourceText, sourceLabel: "(Two, 2024)", contextItemId: 2 },
        ],
      }),
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.lengthOf(finalized.quoteCitations, 0);
    assert.include(finalized.markdown, "> The amount of neural realignment");
  });

  it("keeps short generic quote snippets unanchored", function () {
    const finalized = finalizeAssistantQuoteCitations({
      markdown: "> BCI learning",
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "BCI learning improves when participants can generate reliable neural activity patterns.",
            sourceLabel: "(Busch et al., 2026)",
            contextItemId: 22,
          },
        ],
      }),
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.lengthOf(finalized.quoteCitations, 0);
    assert.include(finalized.markdown, "> BCI learning");
  });

  it("does not verify a displayed quote with an unsupported supplementary-table tail", function () {
    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "> ...successful learning occurred without explicit awareness and using highly idiosyncratic mental strategies across participants (Supplementary Table 1).",
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "The authors report that successful learning occurred without explicit awareness and using highly idiosyncratic mental strategies across participants.",
            sourceLabel: "(Busch et al., 2026)",
            contextItemId: 22,
          },
        ],
      }),
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.lengthOf(finalized.quoteCitations, 0);
    assert.include(finalized.markdown, "Supplementary Table 1");
  });

  it("does not verify a displayed quote with an unsupported figure-caption tail", function () {
    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "> T-PHATE embeddings of fMRI data show the correspondence between brain activity and the video game arena environment. (Fig. 1b caption)",
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "T-PHATE embeddings of fMRI data show the correspondence between brain activity and the video game arena environment.",
            sourceLabel: "(Busch et al., 2026)",
            contextItemId: 22,
          },
        ],
      }),
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.lengthOf(finalized.quoteCitations, 0);
    assert.include(finalized.markdown, "Fig. 1b caption");
  });

  it("preserves citation-shaped prose following an authenticated quote", function () {
    const citation = buildQuoteCitation({
      quoteText: "Participants gained control by realigning brain activity.",
      citationLabel: "(Busch et al., 2026)",
      contextItemId: 22,
    });
    assert.isDefined(citation);

    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "The paper states:\n\n> Participants gained control by realigning brain activity.\n\n(Busch et al., 2026) And this explains why learning succeeded.",
      quoteCitations: [citation!],
    });

    assert.include(finalized.markdown, `[[quote:${citation!.id}]]`);
    assert.include(
      finalized.markdown,
      "And this explains why learning succeeded.",
    );
    assert.include(finalized.markdown, "(Busch et al., 2026) And");
  });

  it("uses the shared citation separator helper", function () {
    assert.equal(
      stripLeadingCitationSeparators("; and this separator should not remain."),
      "and this separator should not remain.",
    );
  });

  it("collapses duplicate unlabeled manual quotes when the same quote anchor is already present", function () {
    const quoteText =
      "Humans and animals excel at generalizing from limited data, a capability yet to be fully replicated in artificial intelligence.";
    const citation = buildQuoteCitation({
      quoteText,
      citationLabel: "(Li et al., 2024)",
      contextItemId: 22,
    });
    assert.isDefined(citation);
    const sourceIndex = buildQuoteSourceIndex({
      quoteCitations: [citation!],
      sourceTexts: [
        {
          sourceText: quoteText,
          sourceLabel: "(Li et al., 2024)",
          contextItemId: 22,
        },
      ],
    });

    const finalized = finalizeAssistantQuoteCitations({
      markdown: [
        "Overview -- (Li et al., 2024)",
        "",
        `> ${quoteText}`,
        "",
        `[[quote:${citation!.id}]]`,
        "",
        "This Perspective paper asks how neural representations shape generalization.",
      ].join("\n"),
      quoteCitations: [citation!],
      sourceIndex,
    });

    assert.equal(
      countOccurrences(finalized.markdown, `[[quote:${citation!.id}]]`),
      1,
    );
    const display = replaceQuoteCitationPlaceholdersForMarkdown(
      finalized.markdown,
      finalized.quoteCitations,
    );
    assert.equal(countOccurrences(display, `> ${quoteText}`), 1);
  });

  it("collapses duplicate unlabeled and source-labeled manual quotes that resolve to the same anchor", function () {
    const quoteText =
      "Humans and animals excel at generalizing from limited data, a capability yet to be fully replicated in artificial intelligence.";
    const citation = buildQuoteCitation({
      quoteText,
      citationLabel: "(Li et al., 2024)",
      contextItemId: 22,
    });
    assert.isDefined(citation);
    const sourceIndex = buildQuoteSourceIndex({
      quoteCitations: [citation!],
      sourceTexts: [
        {
          sourceText: quoteText,
          sourceLabel: "(Li et al., 2024)",
          contextItemId: 22,
        },
      ],
    });

    const finalized = finalizeAssistantQuoteCitations({
      markdown: [
        "Overview -- (Li et al., 2024)",
        "",
        `> ${quoteText}`,
        "",
        `> ${quoteText}`,
        ">",
        "> (Li et al., 2024)",
        "",
        "This Perspective paper asks how neural representations shape generalization.",
      ].join("\n"),
      quoteCitations: [citation!],
      sourceIndex,
    });

    assert.equal(
      countOccurrences(finalized.markdown, `[[quote:${citation!.id}]]`),
      1,
    );
    const display = replaceQuoteCitationPlaceholdersForMarkdown(
      finalized.markdown,
      finalized.quoteCitations,
    );
    assert.equal(countOccurrences(display, `> ${quoteText}`), 1);
  });

  it("collapses an adjacent manual quote and contained source anchor into one verified quote", function () {
    const anchorQuote =
      "To describe the probabilistic response of an entire population, we need to make assumptions about the joint responses of neurons.";
    const displayedQuote = `${anchorQuote} The simplest assumption is that all neurons respond independently from each other.`;
    const sourceText = `${displayedQuote} Then, the population response distribution is the product of the response distributions of the neurons in the population.`;
    const citation = buildQuoteCitation({
      quoteText: anchorQuote,
      citationLabel: "(Ma, 2009)",
      sourceMatchText: anchorQuote,
      sourceMatchKind: "exact",
      sourceMatchSource: "context-text",
      contextItemId: 3852,
      itemId: 3853,
      sourceFingerprint: "fnv1a32-b7e96541",
    });
    assert.isDefined(citation);
    const sourceIndex = buildQuoteSourceIndex({
      quoteCitations: [citation!],
      sourceTexts: [
        {
          sourceText,
          sourceLabel: "(Ma, 2009)",
          sourceMatchSource: "context-text",
          contextItemId: 3852,
          itemId: 3853,
          sourceFingerprint: "fnv1a32-b7e96541",
        },
      ],
    });

    for (const anchorLine of [
      `[[quote:${citation!.id}]]`,
      `> [[quote:${citation!.id}]]`,
    ]) {
      const finalized = finalizeAssistantQuoteCitations({
        markdown: `> ${displayedQuote}\n${anchorLine}`,
        quoteCitations: [citation!],
        sourceIndex,
        quoteSourceReview: { sourceEvidenceComplete: true },
      });

      assert.equal(
        countOccurrences(finalized.markdown, "[[quote:"),
        1,
        anchorLine,
      );
      assert.lengthOf(finalized.quoteCitations, 1, anchorLine);
      assert.equal(finalized.quoteCitations[0].quoteText, displayedQuote);
      assert.notEqual(finalized.quoteCitations[0].id, citation!.id);
    }
  });

  it("collapses an adjacent manual-anchor pair when current evidence has a newer fingerprint for the same attachment", function () {
    const anchorQuote =
      "To describe the probabilistic response of an entire population, we need to make assumptions about the joint responses of neurons.";
    const displayedQuote = `${anchorQuote} The simplest assumption is that all neurons respond independently from each other.`;
    const citation = buildQuoteCitation({
      id: "Q_07qwnp0",
      quoteText: anchorQuote,
      citationLabel: "(Ma, 2009)",
      sourceMatchText: anchorQuote,
      sourceMatchKind: "exact",
      sourceMatchSource: "context-text",
      contextItemId: 3852,
      itemId: 3853,
      sourceFingerprint: "fnv1a32-b7e96541",
    });
    assert.isDefined(citation);
    const sourceIndex = buildQuoteSourceIndex({
      quoteCitations: [citation!],
      sourceTexts: [
        {
          sourceText: displayedQuote,
          sourceLabel: "(Ma, 2009)",
          sourceMatchSource: "pdf-page-text",
          contextItemId: 3852,
          itemId: 3853,
          sourceFingerprint: "pdfjs:newer-source",
          pageHintIndex: 2,
          pageHintLabel: "751",
        },
      ],
    });

    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${displayedQuote}\n> [[quote:${citation!.id}]]`,
      quoteCitations: [citation!],
      sourceIndex,
      quoteSourceReview: { sourceEvidenceComplete: true },
    });

    assert.equal(countOccurrences(finalized.markdown, "[[quote:"), 1);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(finalized.quoteCitations[0].quoteText, displayedQuote);
    assert.equal(
      finalized.quoteCitations[0].sourceFingerprint,
      "pdfjs:newer-source",
    );
    assert.equal(finalized.quoteCitations[0].pageHintIndex, 2);
  });

  it("does not collapse an adjacent manual-anchor pair across attachments", function () {
    const anchorQuote =
      "To describe the probabilistic response of an entire population, we need to make assumptions about the joint responses of neurons.";
    const displayedQuote = `${anchorQuote} The simplest assumption is that all neurons respond independently from each other.`;
    const citation = buildQuoteCitation({
      id: "Q_07qwnp0",
      quoteText: anchorQuote,
      citationLabel: "(Ma, 2009)",
      sourceMatchText: anchorQuote,
      sourceMatchKind: "exact",
      sourceMatchSource: "context-text",
      contextItemId: 3852,
      itemId: 3853,
      sourceFingerprint: "fnv1a32-b7e96541",
    });
    assert.isDefined(citation);
    const sourceIndex = buildQuoteSourceIndex({
      quoteCitations: [citation!],
      sourceTexts: [
        {
          sourceText: displayedQuote,
          sourceLabel: "(Ma, 2009)",
          sourceMatchSource: "pdf-page-text",
          contextItemId: 9002,
          itemId: 9003,
          sourceFingerprint: "pdfjs:different-attachment",
          pageHintIndex: 2,
          pageHintLabel: "751",
        },
      ],
    });

    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${displayedQuote}\n> [[quote:${citation!.id}]]`,
      quoteCitations: [citation!],
      sourceIndex,
      quoteSourceReview: { sourceEvidenceComplete: true },
    });

    assert.equal(countOccurrences(finalized.markdown, "[[quote:"), 2);
    assert.lengthOf(finalized.quoteCitations, 2);
  });

  it("preserves non-adjacent repetitions while collapsing each local manual-anchor pair", function () {
    const anchorQuote =
      "To describe the probabilistic response of an entire population, we need to make assumptions about the joint responses of neurons.";
    const displayedQuote = `${anchorQuote} The simplest assumption is that all neurons respond independently from each other.`;
    const citation = buildQuoteCitation({
      quoteText: anchorQuote,
      citationLabel: "(Ma, 2009)",
      sourceMatchText: anchorQuote,
      sourceMatchKind: "exact",
      sourceMatchSource: "context-text",
      contextItemId: 3852,
      itemId: 3853,
      sourceFingerprint: "fnv1a32-b7e96541",
    });
    assert.isDefined(citation);
    const sourceIndex = buildQuoteSourceIndex({
      quoteCitations: [citation!],
      sourceTexts: [
        {
          sourceText: displayedQuote,
          sourceLabel: "(Ma, 2009)",
          sourceMatchSource: "context-text",
          contextItemId: 3852,
          itemId: 3853,
          sourceFingerprint: "fnv1a32-b7e96541",
        },
      ],
    });
    const finalized = finalizeAssistantQuoteCitations({
      markdown: [
        `> ${displayedQuote}`,
        `> [[quote:${citation!.id}]]`,
        "",
        "The answer returns to the same evidence after substantive explanation.",
        "",
        `> ${displayedQuote}`,
        `> [[quote:${citation!.id}]]`,
      ].join("\n"),
      quoteCitations: [citation!],
      sourceIndex,
      quoteSourceReview: { sourceEvidenceComplete: true },
    });

    assert.lengthOf(finalized.quoteCitations, 1);
    const reboundId = finalized.quoteCitations[0].id;
    assert.notEqual(reboundId, citation!.id);
    assert.equal(
      countOccurrences(finalized.markdown, `[[quote:${reboundId}]]`),
      2,
    );
    assert.include(
      finalized.markdown,
      "The answer returns to the same evidence after substantive explanation.",
    );
  });

  it("preserves adjacent distinct quotes from the same source", function () {
    const manualQuote =
      "The simplest assumption is that all neurons respond independently from each other.";
    const anchorQuote =
      "This is also called the likelihood function of the stimulus.";
    const citation = buildQuoteCitation({
      quoteText: anchorQuote,
      citationLabel: "(Ma, 2009)",
      sourceMatchText: anchorQuote,
      sourceMatchKind: "exact",
      sourceMatchSource: "context-text",
      contextItemId: 3852,
      itemId: 3853,
      sourceFingerprint: "fnv1a32-b7e96541",
    });
    assert.isDefined(citation);
    const sourceIndex = buildQuoteSourceIndex({
      quoteCitations: [citation!],
      sourceTexts: [
        {
          sourceText: `${manualQuote} ${anchorQuote}`,
          sourceLabel: "(Ma, 2009)",
          sourceMatchSource: "context-text",
          contextItemId: 3852,
          itemId: 3853,
          sourceFingerprint: "fnv1a32-b7e96541",
        },
      ],
    });
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${manualQuote}\n> [[quote:${citation!.id}]]`,
      quoteCitations: [citation!],
      sourceIndex,
      quoteSourceReview: { sourceEvidenceComplete: true },
    });

    assert.equal(countOccurrences(finalized.markdown, "[[quote:"), 2);
    assert.lengthOf(finalized.quoteCitations, 2);
  });

  it("preserves repeated use of the same quote when real prose separates the anchors", function () {
    const quoteText =
      "The amount of neural realignment was comparable between IM and WMP components.";
    const sourceIndex = buildQuoteSourceIndex({
      sourceTexts: [
        {
          sourceText: quoteText,
          sourceLabel: "(Busch et al., 2026)",
          contextItemId: 22,
        },
      ],
    });

    const finalized = finalizeAssistantQuoteCitations({
      markdown: [
        "First point:",
        "",
        `> ${quoteText}`,
        "",
        "Second point returns to the same evidence:",
        "",
        `> ${quoteText}`,
      ].join("\n"),
      sourceIndex,
    });
    const anchorId = finalized.quoteCitations[0]?.id || "";

    assert.match(anchorId, /^Q_[a-z0-9]+$/);
    assert.equal(
      countOccurrences(finalized.markdown, `[[quote:${anchorId}]]`),
      2,
    );
  });

  it("preserves punctuation in citation-shaped following prose", function () {
    const quoteText = "This quote supports the mechanistic account.";
    const citation = buildQuoteCitation({
      quoteText,
      citationLabel: "(Anticevic et al., 2013)",
      contextItemId: 33,
    });
    assert.isDefined(citation);

    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        `The paper says:\n\n> ${quoteText}\n\n` +
        "(Anticevic et al., 2013), pushing the field toward a mechanistic, multilevel account.",
      quoteCitations: [citation!],
    });

    assert.include(finalized.markdown, `[[quote:${citation!.id}]]`);
    assert.include(
      finalized.markdown,
      "pushing the field toward a mechanistic, multilevel account.",
    );
    assert.notInclude(finalized.markdown, "\n\n, pushing");
    assert.include(finalized.markdown, "(Anticevic et al., 2013),");
  });

  it("preserves non-quote-worthy blockquotes as plain quoted text", function () {
    const boilerplate =
      "Full article and list of author affiliations: https://doi.org/10.1126/science.adw7707";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: [
        "Published in Science (",
        "",
        `> ${boilerplate}`,
        "",
        "(Liu et al., 2026)",
        "",
        "), the study challenges decades of conventional wisdom.",
      ].join("\n"),
      quoteCitations: [
        {
          id: "Q_bad_doi",
          quoteText: boilerplate,
          citationLabel: "(Liu et al., 2026)",
          contextItemId: 22,
        },
      ],
    });
    const display = replaceQuoteCitationPlaceholdersForMarkdown(
      finalized.markdown,
      finalized.quoteCitations,
    );
    const rendered = renderMarkdown(display);

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.include(display, boilerplate);
    assert.include(display, "(Liu et al., 2026)");
    assert.include(display, "Science (");
    assert.include(display, "), the study");
    assert.include(
      display,
      "> Full article and list of author affiliations: https://doi.org/10.1126/science.adw7707",
    );
    assert.include(rendered, "<blockquote>");
  });

  it("counts overlapping DOI URLs once when deciding quote worthiness", function () {
    const quoteText =
      "Representational drift persisted across sessions after matching stimulus identity and behavioral context carefully. " +
      "https://doi.org/10.1234/abcdefghijklmnopqrstuv";

    assert.isTrue(isQuoteWorthySourceText(quoteText));
  });

  it("preserves non-quote-worthy blockquotes with continuation text", function () {
    const boilerplate = "Copyright 2026 Example Publisher.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: [
        `> ${boilerplate}`,
        "",
        "(Liu et al., 2026), followed by a plain continuation.",
      ].join("\n"),
      quoteCitations: [
        {
          id: "Q_bad_copyright",
          quoteText: boilerplate,
          citationLabel: "(Liu et al., 2026)",
          contextItemId: 22,
        },
      ],
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.include(finalized.markdown, `> ${boilerplate}`);
    assert.include(finalized.markdown, "followed by a plain continuation.");
    assert.include(finalized.markdown, "(Liu et al., 2026)");
  });

  it("cleans publisher DOI quote placeholders inside prose parentheticals", function () {
    const boilerplate =
      "Full article and list of author affiliations: https://doi.org/10.1126/science.adw7707";
    const display = replaceQuoteCitationPlaceholdersForMarkdown(
      "Published in Science ([[quote:Q_bad_doi]]), the study challenges decades.",
      [
        {
          id: "Q_bad_doi",
          quoteText: boilerplate,
          citationLabel: "(Liu et al., 2026)",
          contextItemId: 22,
        },
      ],
    );

    assert.notInclude(display, boilerplate);
    assert.notInclude(display, "[[quote:");
    assert.notInclude(display, "Science (");
    assert.notInclude(display, "), the study");
    assert.include(
      display,
      "Published in Science, the study challenges decades.",
    );
  });

  it("drops publisher DOI quote placeholders inside prose parentheticals", function () {
    const boilerplate =
      "Full article and list of author affiliations: https://doi.org/10.1126/science.adw7707";
    const display = replaceQuoteCitationPlaceholdersForMarkdown(
      "Published in Science ([[quote:Q_bad_doi]]), the study challenges decades.",
      [
        {
          id: "Q_bad_doi",
          quoteText: boilerplate,
          citationLabel: "(Liu et al., 2026)",
          contextItemId: 22,
        },
      ],
    );

    assert.notInclude(display, boilerplate);
    assert.notInclude(display, "[[quote:");
    assert.notInclude(display, "Science (");
    assert.notInclude(display, "), the study");
    assert.include(
      display,
      "Published in Science, the study challenges decades.",
    );
  });

  it("repairs section labels to canonical source labels when one source matches", function () {
    const sourceText =
      "Abstract\nParticipants gained control by realigning brain activity along these directions.";
    const sourceIndex = buildQuoteSourceIndex({
      sourceTexts: [
        {
          sourceText,
          sourceLabel: "(Busch et al., 2026)",
          contextItemId: 22,
          itemId: 11,
        },
      ],
    });

    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "> Participants gained control by realigning brain activity along these directions.\n\n(Abstract)",
      sourceIndex,
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(
      finalized.quoteCitations[0].citationLabel,
      "(Busch et al., 2026)",
    );
    const exported = replaceQuoteCitationPlaceholdersForMarkdown(
      finalized.markdown,
      finalized.quoteCitations,
    );
    assert.include(exported, "(Busch et al., 2026)");
    assert.notInclude(exported, "(Abstract)");
  });

  it("keeps ambiguous or unmatched section-labeled quotes unanchored", function () {
    const sourceIndex = buildQuoteSourceIndex({
      sourceTexts: [
        {
          sourceText: "The same sentence appears in paper one.",
          sourceLabel: "(One, 2024)",
          contextItemId: 1,
        },
        {
          sourceText: "The same sentence appears in paper one.",
          sourceLabel: "(Two, 2024)",
          contextItemId: 2,
        },
      ],
    });

    const ambiguous = finalizeAssistantQuoteCitations({
      markdown: "> The same sentence appears in paper one.\n\n(Methods)",
      sourceIndex,
    });
    assert.notInclude(ambiguous.markdown, "[[quote:");
    assert.include(ambiguous.markdown, "> The same sentence appears");
    assert.notInclude(ambiguous.markdown, "(Methods)");

    const unmatched = finalizeAssistantQuoteCitations({
      markdown: "> This sentence is not in the source.\n\n(Abstract)",
      sourceIndex,
    });
    assert.notInclude(unmatched.markdown, "[[quote:");
    assert.include(unmatched.markdown, "> This sentence is not in the source.");
    assert.notInclude(unmatched.markdown, "(Abstract)");
  });

  it("keeps citation-shaped follow-up prose after an unmatched blockquote", function () {
    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "> This source-like sentence is not verified exactly but was emitted with a section label.\n\n(Abstract) Follow-up prose remains.",
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: "The active paper discusses a related result.",
            sourceLabel: "(Single, 2024)",
            contextItemId: 101,
          },
        ],
      }),
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.include(
      finalized.markdown,
      "> This source-like sentence is not verified exactly but was emitted with a section label.",
    );
    assert.include(finalized.markdown, "(Single, 2024)");
    assert.include(finalized.markdown, "Follow-up prose remains.");
    assert.include(finalized.markdown, "(Abstract) Follow-up prose remains.");
    assert.lengthOf(finalized.quoteCitations, 0);
  });

  it("keeps unmatched canonical quote labels visible and unclickable", function () {
    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "> This sentence is not present in the current source.\n\n(Smith et al., 2024) Follow-up prose remains.",
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: "Different source text.",
            sourceLabel: "(Smith et al., 2024)",
            contextItemId: 1,
          },
        ],
      }),
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.include(
      finalized.markdown,
      "> This sentence is not present in the current source.",
    );
    assert.include(finalized.markdown, "Follow-up prose remains.");
    assert.include(finalized.markdown, "(Smith et al., 2024)");
  });

  it("stores the completely verified displayed quote despite PDF hyphenation", function () {
    const cleanQuote =
      "Although this learning rule only explicitly stabilizes zSt for the observed stimulus set S, which does not include the target stimulus x*, we find that the SNR of the readout is very stable.";
    const damagedPdfText =
      "Al-\nthough this learning rule only explicitly stabilizes zSt for the observed stimulus set S, which does not include the target stimulus x*, we find that the SNR of the readout is very stable.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${cleanQuote}\n\n(Zaid & Schaffer, 2026, page 5)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: damagedPdfText,
            sourceLabel: "(Zaid and Schaffer, 2026)",
            contextItemId: 3629,
            itemId: 3630,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 4,
          },
        ],
      }),
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.isUndefined(finalized.quoteCitations[0].displayQuoteText);
    assert.equal(finalized.quoteCitations[0].quoteText, cleanQuote);
    assert.equal(finalized.quoteCitations[0].sourceMatchText, cleanQuote);
    assert.equal(
      finalized.quoteCitations[0].citationLabel,
      "(Zaid and Schaffer, 2026)",
    );
    assert.equal(
      finalized.quoteCitations[0].sourceMatchSource,
      "pdf-page-text",
    );
  });

  it("keeps a full model quote unanchored when source verification only finds a short locator overlap", function () {
    const fullQuote =
      "A neuron's tuning stability is positively correlated with the strength of its average pairwise redundancy with the population.";
    const truncatedSource =
      "Abstract\nWe investigate how a neuron's tuning stability relates to other measurements collected from the same population.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${fullQuote}\n\n(Example et al., 2026)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: truncatedSource,
            sourceLabel: "(Example et al., 2026)",
            contextItemId: 22,
            itemId: 11,
            sourceMatchSource: "context-text",
          },
        ],
      }),
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.lengthOf(finalized.quoteCitations, 0);
    assert.include(finalized.markdown, `> ${fullQuote}`);
    assert.include(finalized.markdown, "(Example et al., 2026)");
  });

  it("prefers PDF page text over snippet quote-citation sources for the same paper", function () {
    const fullQuote =
      "We demonstrate that changes in the encoding map dominate drift while the downstream behavioral map remains stable over years.";
    const snippetCitation = buildQuoteCitation({
      quoteText: "We demonstrate that changes",
      citationLabel: "(Example et al., 2026)",
      sourceMatchKind: "raw-prefix",
      sourceMatchSource: "context-text",
      sourceSectionLabel: "Abstract",
      sourceChunkKind: "abstract",
      contextItemId: 22,
      itemId: 11,
    });
    assert.isUndefined(
      snippetCitation,
      "weak snippet citations should not be trusted source entries",
    );
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${fullQuote}\n\n(Example et al., 2026)`,
      quoteCitations: snippetCitation ? [snippetCitation] : [],
      sourceIndex: buildQuoteSourceIndex({
        quoteCitations: snippetCitation ? [snippetCitation] : [],
        sourceTexts: [
          {
            sourceText: fullQuote,
            sourceLabel: "(Example et al., 2026)",
            contextItemId: 22,
            itemId: 11,
            sourceMatchSource: "context-text",
            chunkKind: "body",
          },
          {
            sourceText: fullQuote,
            sourceLabel: "(Example et al., 2026)",
            contextItemId: 22,
            itemId: 11,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 3,
            chunkKind: "body",
          },
        ],
      }),
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(finalized.quoteCitations[0].quoteText, fullQuote);
    assert.equal(
      finalized.quoteCitations[0].sourceMatchSource,
      "pdf-page-text",
    );
    assert.equal(finalized.quoteCitations[0].sourceChunkKind, "body");
  });

  it("does not verify a displayed quote that starts inside a source token", function () {
    const quote = "Dynamic states are controlled by training across sessions.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}\n\n(Smith et al., 2024)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "Neurodynamic states are controlled by training across sessions.",
            sourceLabel: "(Smith et al., 2024)",
            contextItemId: 1,
          },
        ],
      }),
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.lengthOf(finalized.quoteCitations, 0);
    assert.include(finalized.markdown, quote);
  });

  it("preserves displayed typography after verifying the complete source span", function () {
    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "> The model's accuracy dropped sharply.\n\n(Smith et al., 2024)",
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: "The model’s accuracy dropped sharply!",
            sourceLabel: "(Smith et al., 2024)",
            contextItemId: 1,
          },
        ],
      }),
    });

    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(
      finalized.quoteCitations[0].quoteText,
      "The model's accuracy dropped sharply.",
    );
    assert.equal(
      finalized.quoteCitations[0].sourceMatchText,
      "The model's accuracy dropped sharply.",
    );
    assert.isUndefined(finalized.quoteCitations[0].displayQuoteText);
  });

  it("repairs normalized math and hyphenation blockquotes without truncating display text", function () {
    const displayQuote =
      "the model's goodness-of-fit, measured by cross-validated R² (cvR²), dropped with the number of sessions intervening between train and test sessions";
    const mineruText =
      "But we found, on the contrary, that the model’s goodness-of-fit, measured by crossvalidated $\\textstyle \\mathbf { R } ^ { 2 }$ (cvR2 ), dropped with the number of sessions intervening between train and test sessions (Fig. 1C, D).";
    const pdfText =
      "But we found, on the contrary, that the model’s goodness-of-fit, measured by cross- validated R2 (cvR2), dropped with the number of sessions intervening between train and test sessions (Fig. 1C, D).";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> "${displayQuote}"`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: mineruText,
            sourceLabel: "(Roth and Merriam, 2023)",
            contextItemId: 220,
            itemId: 20,
            sourceMatchSource: "context-text",
          },
          {
            sourceText: pdfText,
            sourceLabel: "(Roth and Merriam, 2023)",
            contextItemId: 220,
            itemId: 20,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 2,
          },
        ],
      }),
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(
      finalized.quoteCitations[0].citationLabel,
      "(Roth and Merriam, 2023)",
    );
    assert.equal(
      finalized.quoteCitations[0].sourceMatchKind,
      "normalized-span",
    );
    assert.equal(
      finalized.quoteCitations[0].displayQuoteText,
      `"${displayQuote}"`,
    );
    assert.equal(finalized.quoteCitations[0].quoteText, displayQuote);
    assert.equal(finalized.quoteCitations[0].sourceMatchText, displayQuote);
    assert.equal(finalized.quoteCitations[0].pageHintIndex, 2);

    const rendered = replaceQuoteCitationPlaceholdersForMarkdown(
      finalized.markdown,
      finalized.quoteCitations,
    );

    assert.include(rendered, displayQuote);
    assert.include(rendered, "(Roth and Merriam, 2023)");
    assert.include(
      rendered,
      "dropped with the number of sessions intervening between train and test sessions",
    );
    assert.notInclude(rendered, "the model’s goodness-of-fit, measured by");
  });

  it("anchors the largest unique prose span when PDF math cannot be completely aligned", function () {
    const displayQuote =
      "Recall that the readout weights $w$ are proportional to $y_{*0}^\\top y_0$ through Hebbian plasticity.";
    const sourceQuote =
      "Recall that the readout weights w are proportional to y*0|\\mathbf{y}{*0}y*0 through Hebbian plasticity.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${displayQuote}\n\n(Zaid & Schaffer, 2026, page 5)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: sourceQuote,
            sourceLabel: "(Zaid and Schaffer, 2026)",
            contextItemId: 3629,
            itemId: 3630,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 4,
          },
        ],
      }),
    });

    assert.include(finalized.markdown, "[[quote:");
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(finalized.quoteCitations[0].quoteText, displayQuote);
    assert.equal(
      finalized.quoteCitations[0].sourceMatchText,
      "Recall that the readout weights w are proportional to y*0",
    );
    assert.equal(finalized.quoteCitations[0].sourceMatchKind, "raw-prefix");
    assert.equal(finalized.quoteCitations[0].pageHintIndex, 4);
    const display = replaceQuoteCitationPlaceholdersForMarkdown(
      finalized.markdown,
      finalized.quoteCitations,
    );
    assert.include(display, displayQuote);
    assert.notInclude(display, "y*0|\\mathbf");

    const html = renderMarkdown(display);
    assert.include(html, "math-inline");
    assert.include(html, "katex");
    assert.notInclude(html, "y*0|\\mathbf");
  });

  it("anchors the database propensity-function quote by its unique searchable prose prefix", function () {
    const displayQuote =
      "We modeled the propensity function to be weight-dependent $\\rho(w)=\\tanh(10w)$ based on experimental observations.";
    const pdfText =
      "We modeled the propensity function to be weight-dependent ρðwÞ ¼ tanhð10wÞ based on experimental observations.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${displayQuote}\n\n(Bauer et al., 2024)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: pdfText,
            sourceLabel: "(Bauer et al., 2024)",
            contextItemId: 2505,
            itemId: 2504,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 9,
          },
        ],
      }),
    });

    assert.lengthOf(finalized.quoteCitations, 1);
    assert.include(finalized.markdown, "[[quote:");
    assert.notInclude(finalized.markdown, "Not a source quote");
    assert.equal(finalized.quoteCitations[0].quoteText, displayQuote);
    assert.equal(
      finalized.quoteCitations[0].sourceMatchText,
      "We modeled the propensity function to be weight-dependent",
    );
    assert.equal(finalized.quoteCitations[0].sourceMatchKind, "raw-prefix");
    assert.equal(finalized.quoteCitations[0].pageHintIndex, 9);
  });

  it("does not verify CJK text with unsupported model prefixes and suffixes", function () {
    const displayQuote =
      "模型补充开头。Eisenberger 等发现自我报告疼痛程度与 dACC 激活强度成正相关关系，与 RVPFC 激活强度成负相关关系；模型补充结尾。";
    const sourceText =
      "Eisenberger 等[12]发现，自我报告疼痛程度与 dACC 激活强度成正相关关系，与 RVPFC 激活强度成负相关关系。";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${displayQuote}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText,
            sourceLabel: "(Eisenberger et al., 2026)",
            contextItemId: 166,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 3,
          },
        ],
      }),
    });

    assert.lengthOf(finalized.quoteCitations, 0);
    assert.notInclude(finalized.markdown, "[[quote:");
    assert.include(finalized.markdown, displayQuote);
  });

  it("does not treat a non-letter symbol as a CJK partial-search signal", function () {
    const displayQuote =
      "Ji Xia 1 ✉, Tyler D. Marks are followed by model-added explanatory prose that is not part of the source byline.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${displayQuote}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: "Ji Xia 1✉, Tyler D. Marks",
            sourceLabel: "(Xia and Marks, 2026)",
            contextItemId: 566,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 0,
          },
        ],
      }),
    });

    assert.isEmpty(finalized.quoteCitations);
    assert.notInclude(finalized.markdown, "[[quote:");
  });

  it("does not leak model-provided quote anchors when verified PDF text preserves display text", function () {
    const displayQuote =
      "Note that high signal correlations between pairs of neurons at a given imaging time point do not necessarily indicate high noise correlations and vice versa. [[quote:Q_1b7wj09]]";
    const sourceQuote =
      "Note that high signal correlations between pairs of neurons at a given imaging time point do not necessarily indicate high noise correlations and vice versa.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${displayQuote}\n\n(Eppler et al., 2026)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: sourceQuote,
            sourceLabel: "(Eppler et al., 2026)",
            contextItemId: 3097,
            itemId: 3096,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 5,
            sourceFingerprint: "pdfjs:eppler-display-test",
          },
        ],
      }),
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.notInclude(
      finalized.quoteCitations[0].displayQuoteText || "",
      "[[quote:",
    );
    assert.isUndefined(finalized.quoteCitations[0].displayQuoteText);

    const rendered = replaceQuoteCitationPlaceholdersForMarkdown(
      finalized.markdown,
      finalized.quoteCitations,
    );

    assert.include(rendered, sourceQuote);
    assert.include(rendered, "(Eppler et al., 2026)");
    assert.notInclude(rendered, "[[quote:Q_1b7wj09]]");
    assert.notInclude(rendered, finalized.markdown);
    assert.notInclude(rendered, "[[quote:");
  });

  it("keeps a degraded visible source label for unmatched single-source blockquotes", function () {
    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "> This source-like sentence is not verified exactly but belongs to the active paper context.",
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: "The active paper discusses a related result.",
            sourceLabel: "(Single, 2024)",
            contextItemId: 101,
          },
        ],
      }),
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.include(
      finalized.markdown,
      "> This source-like sentence is not verified exactly but belongs to the active paper context.",
    );
    assert.include(finalized.markdown, "(Single, 2024)");
    assert.lengthOf(finalized.quoteCitations, 0);
  });

  it("does not infer a degraded source label for ambiguous multi-source blockquotes", function () {
    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "> This source-like sentence is not verified exactly but may belong to more than one paper.",
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: "Paper one discusses a related result.",
            sourceLabel: "(One, 2024)",
            contextItemId: 101,
          },
          {
            sourceText: "Paper two discusses a related result.",
            sourceLabel: "(Two, 2024)",
            contextItemId: 102,
          },
        ],
      }),
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.include(
      finalized.markdown,
      "> This source-like sentence is not verified exactly but may belong to more than one paper.",
    );
    assert.notInclude(finalized.markdown, "(One, 2024)");
    assert.notInclude(finalized.markdown, "(Two, 2024)");
    assert.lengthOf(finalized.quoteCitations, 0);
  });

  it("converts obvious non-source blockquotes to fenced text blocks", function () {
    const finalized = finalizeAssistantQuoteCitations({
      markdown: "> Interpretation: this means the model is probably unstable.",
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: "The active paper discusses model stability.",
            sourceLabel: "(Single, 2024)",
            contextItemId: 101,
          },
        ],
      }),
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.include(
      finalized.markdown,
      "```text\nInterpretation: this means the model is probably unstable.\n```",
    );
    assert.notInclude(finalized.markdown, "(Single, 2024)");
  });

  it("converts note-edit generated blockquotes with source labels to fenced text", function () {
    const revisedText =
      "Panel A uses a cartoon neural network to show the stability-plasticity dilemma: practice tunes the weights so the input pattern produces the target output.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: [
        `Updated the sentence:`,
        "",
        `> ${revisedText}`,
        "",
        "(Ajemian et al., 2013)",
      ].join("\n"),
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "Panel A illustrates the stability-plasticity dilemma in a cartoon neural network. An input pattern must be transformed into an output.",
            sourceLabel: "(Ajemian et al., 2013)",
            contextItemId: 3612,
          },
        ],
      }),
      fenceUnverifiedBlockquotes: true,
    });

    assert.notInclude(finalized.markdown, "\n> ");
    assert.notInclude(finalized.markdown, "(Ajemian et al., 2013)");
    assert.include(finalized.markdown, `\`\`\`text\n${revisedText}\n\`\`\``);
    assert.lengthOf(finalized.quoteCitations, 0);
  });

  it("keeps an unconfirmed quote visible when source evidence is incomplete", function () {
    const quote =
      "Among neuron pairs, does noise correlation change more favorably for high signal correlation?";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}\n>\n> (Eppler et al., 2026, page 3)`,
      sourceIndex: buildQuoteSourceIndex({ sourceTexts: [] }),
      quoteSourceReview: {
        sourceEvidenceComplete: false,
      },
    });

    assert.include(finalized.markdown, `> ${quote}`);
    assert.notInclude(finalized.markdown, "```text");
    assert.notInclude(finalized.markdown, "[[quote:");
    assert.include(finalized.markdown, "(Eppler et al., 2026, page 3)");
  });

  it("keeps a registered normalized-span quote anchor trusted", function () {
    const quote =
      "This historical interpretation was previously mislabeled as source wording.";
    const legacyCitation = buildQuoteCitation({
      quoteText: quote,
      citationLabel: "(Eppler et al., 2026)",
      sourceMatchKind: "normalized-span",
      sourceMatchSource: "context-text",
      contextItemId: 81,
      itemId: 80,
    });
    assert.isDefined(legacyCitation);

    const finalized = finalizeAssistantQuoteCitations({
      markdown: `[[quote:${legacyCitation!.id}]]`,
      quoteCitations: [legacyCitation!],
      quoteSourceReview: {
        sourceEvidenceComplete: false,
      },
    });

    assert.equal(finalized.markdown, `[[quote:${legacyCitation!.id}]]`);
    assert.deepEqual(finalized.quoteCitations, [legacyCitation!]);
  });

  it("keeps real source text when it duplicates an untrusted legacy record", function () {
    const quote =
      "This exact source sentence remains independently verifiable from cached paper text.";
    const legacyCitation = buildQuoteCitation({
      quoteText: quote,
      citationLabel: "(Eppler et al., 2026)",
      sourceMatchKind: "normalized-span",
      sourceMatchSource: "context-text",
      contextItemId: 81,
      itemId: 80,
    });
    assert.isDefined(legacyCitation);
    const sourceIndex = buildQuoteSourceIndex({
      quoteCitations: [legacyCitation!],
      sourceTexts: [
        {
          sourceText: quote,
          sourceLabel: "(Eppler et al., 2026)",
          sourceMatchSource: "context-text",
          contextItemId: 81,
          itemId: 80,
        },
      ],
    });

    const finalized = finalizeAssistantQuoteCitations({
      markdown: `[[quote:${legacyCitation!.id}]]`,
      quoteCitations: [legacyCitation!],
      sourceIndex,
      quoteSourceReview: {
        sourceEvidenceComplete: false,
      },
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
  });

  it("keeps quote-card text after complete source evidence has zero match", function () {
    const quote =
      "Among neuron pairs, does noise correlation change more favorably for high signal correlation?";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}\n>\n> (Eppler et al., 2026, page 3)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "The complete paper text contains no wording from the assistant interpretation.",
            sourceLabel: "(Eppler et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 81,
            itemId: 80,
            pageHintIndex: 2,
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.equal(finalized.markdown, `> ${quote}\n>\n> Not a source quote`);
    assert.notInclude(finalized.markdown, "Eppler");
    assert.lengthOf(finalized.quoteCitations, 0);
  });

  it("rejects the Eppler paraphrase despite an incidental four-token source overlap", function () {
    const quote =
      "Among neuron pairs that begin with roughly similar noise correlation, does noise correlation change more favorably for pairs with high signal correlation than for pairs with low signal correlation?";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}\n>\n> (Eppler et al., 2026)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "The least reduction of noise correlations was observed for pairs with high signal correlations in the first interval.",
            sourceLabel: "(Eppler et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 3097,
            itemId: 3096,
            pageHintIndex: 2,
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.equal(finalized.markdown, `> ${quote}\n>\n> Not a source quote`);
    assert.notInclude(finalized.markdown, "Eppler");
    assert.lengthOf(finalized.quoteCitations, 0);
  });

  it("rejects the persisted I-k paraphrase despite related notation in the paper", function () {
    const quote =
      "**Iₖ = the set of neuron-pair indices that fall into the k-th SC bin on day t.**";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}\n>\n> (Eppler et al., 2026)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "For each SC bin k, we computed the mean across pairwise NC Yi. Where Ik is the set of pairs in bin k.",
            sourceLabel: "(Eppler et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 3097,
            itemId: 3096,
            pageHintIndex: 9,
            pageHintLabel: "10",
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.equal(finalized.markdown, `> ${quote}\n>\n> Not a source quote`);
    assert.notInclude(finalized.markdown, "Eppler");
    assert.lengthOf(finalized.quoteCitations, 0);
  });

  it("rejects an ambiguous partial quote after exhaustive complete-text review", function () {
    const sharedSourceText =
      "Noise correlations remained stable for neuron pairs with consistently high signal correlations";
    const quote = `${sharedSourceText} because the model imposed a causal balancing mechanism.`;
    const markdown = `> ${quote}\n>\n> (Eppler et al., 2026)`;
    const finalized = finalizeAssistantQuoteCitations({
      markdown,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [1, 2].map((pageHintIndex) => ({
          sourceText: `${sharedSourceText} in this experimental condition.`,
          sourceLabel: "(Eppler et al., 2026)",
          sourceMatchSource: "pdf-page-text",
          contextItemId: 3097,
          itemId: 3096,
          pageHintIndex,
        })),
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.equal(finalized.markdown, `> ${quote}\n>\n> Not a source quote`);
    assert.notInclude(finalized.markdown, "Eppler");
    assert.lengthOf(finalized.quoteCitations, 0);
  });

  it("rejects a unique partial PDF match when the complete displayed wording is absent", function () {
    const sourceSentence =
      "Noise correlation changed more favorably for neuron pairs with high signal correlation.";
    const quote = `${sourceSentence} This interpretation was added by the model and is not source wording.`;
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: sourceSentence,
            sourceLabel: "(Eppler et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 81,
            itemId: 80,
            pageHintIndex: 2,
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.equal(finalized.markdown, `> ${quote}\n>\n> Not a source quote`);
    assert.lengthOf(finalized.quoteCitations, 0);
  });

  it("defers a unique near-complete source location instead of declaring it absent", function () {
    const source =
      "The population response remained stable across every repeated recording session despite substantial changes in individual neuronal tuning patterns.";
    const quote = source.replace("patterns", "preferences");
    const markdown = `> ${quote}\n\n(Example et al., 2026)`;
    const finalized = finalizeAssistantQuoteCitations({
      markdown,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: source,
            sourceLabel: "(Example et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 81,
            itemId: 80,
            pageHintIndex: 2,
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.equal(finalized.markdown, markdown);
    assert.notInclude(finalized.markdown, "Not a source quote");
    assert.isEmpty(finalized.quoteCitations);
  });

  it("defers a unique seven-of-eight-token source location", function () {
    const source =
      "We therefore employed intracranial electroencephalography in 28 neurosurgical patients";
    const quote =
      "We employed intracranial electroencephalography in 28 neurosurgical patients";
    const markdown = `> ${quote}`;
    const finalized = finalizeAssistantQuoteCitations({
      markdown,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: source,
            sourceLabel: "(Example et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 81,
            itemId: 80,
            pageHintIndex: 2,
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.equal(finalized.markdown, markdown);
    assert.notInclude(finalized.markdown, "Not a source quote");
    assert.isEmpty(finalized.quoteCitations);
  });

  it("defers a unique extraction-sensitive math partial instead of declaring it absent", function () {
    const quote =
      "We modeled the propensity function to be weight-dependent \\(\\rho(w) = \\tanh(10w)\\) based on experimental observations.";
    const source = [
      "We modeled the propensity function to be",
      "weight-dependent ρðwÞ = tanhð10wÞ based on experimental",
      "observations47,50–53.",
    ].join("\n");
    const markdown = `> ${quote}`;
    const finalized = finalizeAssistantQuoteCitations({
      markdown,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: source,
            sourceLabel: "(Bauer et al., 2024)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 2505,
            itemId: 2504,
            pageHintIndex: 9,
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.equal(finalized.markdown, markdown);
    assert.notInclude(finalized.markdown, "Not a source quote");
    assert.isEmpty(finalized.quoteCitations);
  });

  it("defers an ellipsized quote when every displayed segment has unique source support", function () {
    const quote =
      "We modeled the change in feedforward synaptic weights … as the sum of \\(H\\) and \\(\\xi\\) scaled by a synaptic weight-dependent propensity function (\\(\\rho(w)\\)): \\(\\Delta w = \\rho(w)(k H + \\xi)\\) (Fig. 3b). This propensity function was inspired by experimental results showing that the magnitudes of changes in spine size—commonly considered a proxy for synaptic strength—is proportional to the initial size of the spines.";
    const source =
      "We modeled the change in feedforward synaptic weights from a cortical layer of presynaptic neurons to a cortical layer of postsynaptic neurons as the sum of H and ξ scaled by a synaptic weight-dependent propensity function (ρðwÞ): Δw = ρðwÞðkH + ξÞ (Fig. 3b). This propensity function was inspired by experimental results showing that the magnitudes of changes in spine size—commonly considered a proxy for synaptic strength—is proportional to the initial size of the spines47,50–53.";
    const markdown = `> ${quote}`;
    const finalized = finalizeAssistantQuoteCitations({
      markdown,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: source,
            sourceLabel: "(Bauer et al., 2024)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 2505,
            itemId: 2504,
            pageHintIndex: 4,
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.equal(finalized.markdown, markdown);
    assert.notInclude(finalized.markdown, "Not a source quote");
    assert.isEmpty(finalized.quoteCitations);
  });

  it("defers a unique math-heavy caption when the exact prose anchor is interior", function () {
    const quote =
      "$\\mathbf{U}_{\\text{base}} \\mathbf{O}_{\\text{readout}}$ is the fixed initial $D$-dimensional subspace in $\\mathbb{R}^N$. $\\mathbf{z}^{(k)}$ captures the rotation at trial $k$ relative to this, resulting in the rotated emission subspace $\\mathbf{C}^{(k)} = \\mathbf{U}_{\\text{base}} f(\\mathbf{B}^{(k)}) \\mathbf{O}_{\\text{readout}}$.";
    const source =
      "UbaseOreadout is the fixed initial D−dimensional subspace in RN. z(k) captures the rotation at trial k relative to this, resulting in the rotated emission subspace C(k) = Ubase f (B(k))Oreadout.";
    const markdown = `> ${quote}`;
    const finalized = finalizeAssistantQuoteCitations({
      markdown,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: source,
            sourceLabel: "(Lee et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 3042,
            itemId: 3043,
            pageHintIndex: 4,
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.equal(finalized.markdown, markdown);
    assert.notInclude(finalized.markdown, "Not a source quote");
    assert.isEmpty(finalized.quoteCitations);
  });

  it("does not declare a formula-dominated block absent from text extraction alone", function () {
    const quote =
      "$$ \\mathbf{y}_t^{(k)} = \\mathbf{C}^{(k)} \\mathbf{x}_t^{(k)} + \\boldsymbol{\\epsilon}_t^{(k)}, \\quad \\boldsymbol{\\epsilon}_t^{(k)} \\sim \\mathcal{N}(0, \\mathbf{R}) $$";
    const markdown = `> ${quote}`;
    const finalized = finalizeAssistantQuoteCitations({
      markdown,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "The extracted page contains prose but its equation glyphs were not preserved.",
            sourceLabel: "(Lee et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 3042,
            itemId: 3043,
            pageHintIndex: 4,
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.equal(finalized.markdown, markdown);
    assert.notInclude(finalized.markdown, "Not a source quote");
    assert.isEmpty(finalized.quoteCitations);
  });

  it("authenticates the Kriegeskorte and Wei quote through fused reference markers", function () {
    const quote =
      "the noise correlation for a pair of neurons is proportional to the product of the derivatives of their tuning curves at the stimulus value. As information already missing from the input cannot possibly be recovered from the code, such so-called differential noise correlations limit the FI that the code can achieve, no matter how many neurons we allow.";
    const source = [
      "There is evidence for related effects in frontal cortex194,195.",
      "In this scenario, the noise correlation for a pair of neurons is proportional to the product of the derivatives of their tuning curves at the stimulus value.",
      "As information already missing from the input cannot possibly be recovered from the code, such so-called differential noise correlations limit the FI that the code can achieve, no matter how many neurons we allow135.",
    ].join(" ");
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}\n\n(Kriegeskorte & Wei, 2021, page 7)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: source,
            sourceLabel: "(Kriegeskorte & Wei, 2021)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 1567,
            itemId: 4,
            pageHintIndex: 6,
            pageHintLabel: "7",
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.notInclude(finalized.markdown, "Not a source quote");
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(finalized.quoteCitations[0]?.pageHintLabel, "7");
  });

  it("keeps exact unique source navigation even when prose heuristics reject the display text", function () {
    const quote =
      "Summary of task settings utilized at each training stage. Performance criteria indicate the behavioral performance necessary to graduate to the next training stage.";
    assert.isFalse(isQuoteWorthySourceText(quote));

    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: quote,
            sourceLabel: "(Example et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 81,
            itemId: 80,
            pageHintIndex: 2,
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.equal(finalized.quoteCitations[0]?.sourceMatchText, quote);
  });

  it("rejects a page-backed partial when unsupported math wording remains", function () {
    const quote =
      "The baseline F₀ used to compute the ΔF/F₀ was defined as a moving rank order filter, the 30th percentile of the 200 surrounding frames (100 before and 100 after). This ΔF/F₀ was then deconvolved using the algorithm published by Vogelstein et al. (2010).";
    const source =
      "Methods used a rank order filter, the 30th percentile of the 200 surrounding frames (100 before and 100 after). This procedure was applied before deconvolution.";
    assert.isFalse(isQuoteWorthySourceText(quote));

    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: source,
            sourceLabel: "(Example et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 81,
            itemId: 80,
            pageHintIndex: 4,
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.equal(finalized.markdown, `> ${quote}\n>\n> Not a source quote`);
    assert.lengthOf(finalized.quoteCitations, 0);
  });

  it("fails closed when the complete quote appears on multiple PDF pages", function () {
    const quote = "The same source sentence appears on two pages of one paper.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: quote,
            sourceLabel: "(Example et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 81,
            itemId: 80,
            pageHintIndex: 2,
            pageHintLabel: "3",
          },
          {
            sourceText: quote,
            sourceLabel: "(Example et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 82,
            itemId: 80,
            pageHintIndex: 8,
            pageHintLabel: "9",
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.isEmpty(finalized.quoteCitations);
  });

  it("fails closed when the complete quote repeats on one page without an occurrence", function () {
    const quote = "The same source sentence repeats on one identifiable page.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: Array.from(
              { length: 10 },
              () => `${quote} Additional text.`,
            ).join(" "),
            sourceLabel: "(Example et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 81,
            itemId: 80,
            pageHintIndex: 4,
            pageHintLabel: "5",
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.isEmpty(finalized.quoteCitations);
  });

  it("canonicalizes equivalent Climer citation layouts before provenance search", function () {
    const displayedQuote =
      "The water-restricted mice received water rewards $2 . 2 5 \\mathsf { m }$ down a 3-m visual virtual track";
    const sourceText =
      "The water-restricted mice received water rewards 2.25 m down a 3-m visual virtual track, a track length resembling those in other studies.";
    const sourceIndex = buildQuoteSourceIndex({
      sourceTexts: [
        {
          sourceText,
          sourceLabel: "(Climer et al., 2025)",
          sourceMatchSource: "pdf-page-text",
          contextItemId: 2442,
          itemId: 2443,
          pageHintIndex: 0,
          pageHintLabel: "1",
        },
      ],
    });
    const layouts = [
      `> “${displayedQuote}” (Climer et al., 2025)`,
      `> “${displayedQuote}” (Climer et al., 2025) [climer2025]`,
      `> “${displayedQuote}”\n> (Climer et al., 2025)`,
      `> “${displayedQuote}”\n\n(Climer et al., 2025)`,
    ];

    const finalized = layouts.map((markdown) =>
      finalizeAssistantQuoteCitations({
        markdown,
        sourceIndex,
        quoteSourceReview: { sourceEvidenceComplete: true },
      }),
    );

    for (const result of finalized) {
      assert.match(result.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
      assert.notInclude(result.markdown, "Not a source quote");
      assert.lengthOf(result.quoteCitations, 1);
      assert.equal(result.quoteCitations[0]?.pageHintIndex, 0);
      assert.equal(result.quoteCitations[0]?.pageHintLabel, "1");
      assert.equal(
        result.quoteCitations[0]?.citationLabel,
        "(Climer et al., 2025)",
      );
    }
    assert.deepEqual(
      finalized.map((result) => result.quoteCitations[0]?.id),
      Array.from(
        { length: layouts.length },
        () => finalized[0].quoteCitations[0]?.id,
      ),
    );
  });

  it("authenticates the Climer methods quote after removing its same-line citation", function () {
    const displayedQuote =
      "Mice received $4 \\mu \\mathrm { l }$ water reward $2 / 3 ( 2 . 2 5 \\mathsf { m } )$ of the way along the $3 { \\cdot } \\mathsf { m }$ virtual track.";
    const sourceText =
      "Mice received 4 μl water reward 2/3 (2.25 m) of the way along the 3 m virtual track.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> “${displayedQuote}” (Climer et al., 2025)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText,
            sourceLabel: "(Climer et al., 2025)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 2442,
            itemId: 2443,
            pageHintIndex: 9,
            pageHintLabel: "10",
          },
        ],
      }),
      quoteSourceReview: { sourceEvidenceComplete: true },
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.notInclude(finalized.markdown, "Not a source quote");
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(finalized.quoteCitations[0]?.quoteText, displayedQuote);
    assert.equal(finalized.quoteCitations[0]?.pageHintIndex, 9);
    assert.equal(finalized.quoteCitations[0]?.pageHintLabel, "10");
    assert.equal(
      finalized.quoteCitations[0]?.sourceMatchKind,
      "normalized-span",
    );
  });

  it("uses canonical same-line quote parsing during cooperative validation", async function () {
    const quote =
      "The water-restricted mice received water rewards 2.25 m down a 3-m visual virtual track";
    const finalized = await finalizeAssistantQuoteCitationsCooperatively(
      {
        markdown: `> “${quote}” (Climer et al., 2025)`,
        sourceIndex: buildQuoteSourceIndex({
          sourceTexts: [
            {
              sourceText: `${quote}, followed by stable behavioral training.`,
              sourceLabel: "(Climer et al., 2025)",
              sourceMatchSource: "pdf-page-text",
              contextItemId: 2442,
              itemId: 2443,
              pageHintIndex: 0,
            },
          ],
        }),
        quoteSourceReview: { sourceEvidenceComplete: true },
      },
      { yieldToMain: async () => undefined },
    );

    assert.isNotNull(finalized);
    assert.match(finalized!.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.notInclude(finalized!.markdown, "Not a source quote");
    assert.lengthOf(finalized!.quoteCitations, 1);
  });

  it("repairs a stale same-line label from the unique authenticated source", function () {
    const quote =
      "The water-restricted mice received water rewards 2.25 m down a 3-m visual virtual track";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> “${quote}” (Wrong et al., 2024)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: `${quote}, followed by stable behavioral training.`,
            sourceLabel: "(Climer et al., 2025)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 2442,
            itemId: 2443,
            pageHintIndex: 0,
          },
        ],
      }),
      quoteSourceReview: { sourceEvidenceComplete: true },
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.equal(
      finalized.quoteCitations[0]?.citationLabel,
      "(Climer et al., 2025)",
    );
    assert.notInclude(finalized.markdown, "Wrong et al.");
  });

  it("keeps strict absence decisions after splitting a valid same-line citation", function () {
    const sourceSentence =
      "The complete paper reports a stable reward location across sessions.";
    const quotes = [
      "This complete invented quote is absent from every page in the authenticated paper.",
      `${sourceSentence} This explanatory sentence was added by the model.`,
    ];

    for (const quote of quotes) {
      const finalized = finalizeAssistantQuoteCitations({
        markdown: `> “${quote}” (Climer et al., 2025)`,
        sourceIndex: buildQuoteSourceIndex({
          sourceTexts: [
            {
              sourceText: sourceSentence,
              sourceLabel: "(Climer et al., 2025)",
              sourceMatchSource: "pdf-page-text",
              contextItemId: 2442,
              itemId: 2443,
              pageHintIndex: 0,
            },
          ],
        }),
        quoteSourceReview: { sourceEvidenceComplete: true },
      });

      assert.equal(finalized.markdown, `> “${quote}”\n>\n> Not a source quote`);
      assert.isEmpty(finalized.quoteCitations);
    }
  });

  it("defers ambiguous citation-shaped decoration instead of declaring absence", function () {
    const quote =
      "This source sentence remains searchable when its presentation syntax is uncertain.";
    const markdown = `> “${quote}” [Climer et al., 2025]`;
    const finalized = finalizeAssistantQuoteCitations({
      markdown,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: quote,
            sourceLabel: "(Climer et al., 2025)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 2442,
            itemId: 2443,
            pageHintIndex: 0,
          },
        ],
      }),
      quoteSourceReview: { sourceEvidenceComplete: true },
    });

    assert.equal(finalized.markdown, markdown);
    assert.notInclude(finalized.markdown, "Not a source quote");
    assert.isEmpty(finalized.quoteCitations);
  });

  it("keeps semantic parentheticals in the canonical quote body", function () {
    const quote =
      "The reward remained at two thirds of the virtual track (2.25 m)";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> “${quote}”`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: `Methods. ${quote}.`,
            sourceLabel: "(Climer et al., 2025)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 2442,
            itemId: 2443,
            pageHintIndex: 9,
          },
        ],
      }),
      quoteSourceReview: { sourceEvidenceComplete: true },
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.include(finalized.quoteCitations[0]?.quoteText || "", "(2.25 m)");
  });

  it("authenticates source wording that ends in an author-year parenthetical", function () {
    const quote =
      "The same spatial code was reported in a previous experiment (Ziv et al., 2013)";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: `Results. ${quote}.`,
            sourceLabel: "(Climer et al., 2025)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 2442,
            itemId: 2443,
            pageHintIndex: 9,
          },
        ],
      }),
      quoteSourceReview: { sourceEvidenceComplete: true },
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.include(
      finalized.quoteCitations[0]?.quoteText || "",
      "(Ziv et al., 2013)",
    );
  });

  it("authenticates quotes with short and nested citation-only blockquote lines", function () {
    const quote =
      "Stable source wording should authenticate independently of its display label.";
    const sourceIndex = buildQuoteSourceIndex({
      sourceTexts: [
        {
          sourceText: quote,
          sourceLabel: "(Yao, 2024)",
          sourceMatchSource: "pdf-page-text",
          contextItemId: 2442,
          itemId: 2443,
          pageHintIndex: 2,
        },
      ],
    });

    for (const citationLine of ["(Yao)", "(Yao (2024))"]) {
      const finalized = finalizeAssistantQuoteCitations({
        markdown: `> ${quote}\n> ${citationLine}`,
        sourceIndex,
        quoteSourceReview: { sourceEvidenceComplete: true },
      });

      assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
      assert.notInclude(finalized.markdown, "Not a source quote");
      assert.lengthOf(finalized.quoteCitations, 1);
    }
  });

  it("keeps a same-line source candidate deferred while page coverage is incomplete", function () {
    const quote =
      "This historical quote cannot be rejected before page coverage is complete.";
    const markdown = `> “${quote}” (Climer et al., 2025)`;
    const finalized = finalizeAssistantQuoteCitations({
      markdown,
      sourceIndex: buildQuoteSourceIndex({ sourceTexts: [] }),
      quoteSourceReview: { sourceEvidenceComplete: false },
    });

    assert.equal(finalized.markdown, markdown);
    assert.notInclude(finalized.markdown, "Not a source quote");
    assert.isEmpty(finalized.quoteCitations);
  });

  it("verifies full-span source wording in the quote gate", function () {
    const quote =
      "Noise correlation changed more favorably for neuron pairs with high signal correlation.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: `Results. ${quote} The next sentence follows.`,
            sourceLabel: "(Eppler et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 81,
            itemId: 80,
            pageHintIndex: 2,
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.equal(finalized.quoteCitations[0]?.quoteText, quote);
  });

  it("uses full-span evidence instead of a stale provider label", function () {
    const quote =
      "Noise correlation changed more favorably for neuron pairs with high signal correlation.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}\n\n(Wrong et al., 2025)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "Noise correlation changed for a subset of recorded neuron pairs.",
            sourceLabel: "(Wrong et al., 2025)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 71,
            itemId: 70,
            pageHintIndex: 1,
          },
          {
            sourceText: `Results. ${quote} The next sentence follows.`,
            sourceLabel: "(Eppler et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 81,
            itemId: 80,
            pageHintIndex: 2,
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.equal(
      finalized.quoteCitations[0]?.citationLabel,
      "(Eppler et al., 2026)",
    );
  });

  it("accepts a unique source match with changed punctuation", function () {
    const source =
      "The population geometry remained stable; individual neurons continued to drift.";
    const quote =
      "The population geometry remained stable: individual neurons continued to drift.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: source,
            sourceLabel: "(Example et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 81,
            itemId: 80,
            pageHintIndex: 2,
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.equal(
      finalized.quoteCitations[0]?.citationLabel,
      "(Example et al., 2026)",
    );
  });

  it("authenticates the searchable Asabuki page-4 quote across its ellipsis", function () {
    const quote =
      "For excitatory synapses, errors between excitatory drive and the output of the cell provide feedback to the synapses... All excitatory connections seek to minimize these errors. For inhibitory synapses, the error between excitatory and inhibitory drive must be minimized to maintain excitation–inhibition balance.";
    const pageText =
      "For excitatory synapses, errors between the excitatory drive and the output of the cell provide feedback to the synapses (dashed arrow) and modulate plasticity (blue square; exc. error). All excitatory connections seek to minimize these errors. For inhibitory synapses, the error between excitatory and inhibitory drive must be minimized to maintain excitation-inhibition balance (orange square; inh. error).";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}\n> (Asabuki and Clopath, page 4)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: pageText,
            sourceLabel: "(Asabuki and Clopath)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 3617,
            itemId: 3618,
            pageHintIndex: 3,
            pageHintLabel: "4",
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.notInclude(finalized.markdown, "Not a source quote");
    assert.isNotEmpty(finalized.quoteCitations);
    assert.equal(finalized.quoteCitations[0]?.pageHintLabel, "4");
  });

  it("strips an author-only citation with a page suffix after exhaustive absence", function () {
    const quote =
      "This complete invented quote is absent from every page in the authenticated paper.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}\n> (Asabuki and Clopath, page 4)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "The complete paper instead contains unrelated source wording.",
            sourceLabel: "(Asabuki and Clopath)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 3617,
            itemId: 3618,
            pageHintIndex: 3,
            pageHintLabel: "4",
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.equal(finalized.markdown, `> ${quote}\n>\n> Not a source quote`);
    assert.notInclude(finalized.markdown, "Asabuki");
    assert.isEmpty(finalized.quoteCitations);
  });

  it("splits exact ellipsis segments and uses the largest unique span when another segment is invented", function () {
    const first =
      "Representational geometry remained stable across repeated recording sessions";
    const second =
      "individual neurons nevertheless changed their preferred responses over time";
    const sourceIndex = buildQuoteSourceIndex({
      sourceTexts: [
        {
          sourceText: `${first}, while ${second}.`,
          sourceLabel: "(Example et al., 2026)",
          sourceMatchSource: "pdf-page-text",
          contextItemId: 81,
          itemId: 80,
          pageHintIndex: 2,
        },
      ],
    });
    const ordered = finalizeAssistantQuoteCitations({
      markdown: `> ${first} ... ${second}`,
      sourceIndex,
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });
    const reordered = finalizeAssistantQuoteCitations({
      markdown: `> ${second} ... ${first}`,
      sourceIndex,
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });
    const inventedShortSegment = finalizeAssistantQuoteCitations({
      markdown: `> ${first} ... definitely causal`,
      sourceIndex,
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.equal(countOccurrences(ordered.markdown, "[[quote:"), 2);
    assert.deepEqual(
      ordered.quoteCitations.map((citation) => citation.quoteText),
      [`${first},`, `${second}.`],
    );
    assert.equal(countOccurrences(reordered.markdown, "[[quote:"), 2);
    assert.deepEqual(
      reordered.quoteCitations.map((citation) => citation.quoteText),
      [`${second}.`, `${first},`],
    );
    assert.notInclude(inventedShortSegment.markdown, "[[quote:");
    assert.include(inventedShortSegment.markdown, "Not a source quote");
    assert.lengthOf(inventedShortSegment.quoteCitations, 0);
  });

  it("accepts line-wrap hyphenation as full-span normalization", function () {
    const quote =
      "Noise correlation remained stable across repeated recording sessions.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText:
              "Noise corre-\nlation remained stable across repeated recording sessions.",
            sourceLabel: "(Example et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 81,
            itemId: 80,
            pageHintIndex: 2,
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
  });

  it("reconstructs a uniquely grounded sentence split across adjacent PDF pages", function () {
    const prefix =
      "We then down-sampled the epoched data to 100 Hz, and we selected";
    const suffix =
      "17 channels overlying occipital and parietal cortex for further analysis (O1, Oz, O2, PO7, PO3, POz, PO4, PO8, P7, P5, P3, P1, Pz, P2, P4, P6, P8).";
    const quote = `${prefix} ${suffix}`;
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: `Earlier methods text. ${prefix}\n2`,
            sourceLabel: "(Gifford et al., 2022)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 72,
            itemId: 71,
            sourceFingerprint: "pdfjs:gifford",
            pageHintIndex: 1,
            pageHintLabel: "2",
          },
          {
            sourceText: `Article header. Figure 1 caption with experimental paradigm details. ${suffix} Later methods text.`,
            sourceLabel: "(Gifford et al., 2022)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 72,
            itemId: 71,
            sourceFingerprint: "pdfjs:gifford",
            pageHintIndex: 2,
            pageHintLabel: "3",
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.equal(countOccurrences(finalized.markdown, "[[quote:"), 2);
    assert.notInclude(finalized.markdown, "Not a source quote");
    assert.deepEqual(
      finalized.quoteCitations.map((citation) => citation.pageHintIndex),
      [1, 2],
    );
    assert.deepEqual(
      finalized.quoteCitations.map((citation) => citation.quoteText),
      [prefix, suffix],
    );
  });

  it("reconstructs a five-token continuation after intervening page extraction text", function () {
    const prefix =
      "Taken together, we propose that co-tuned subnetworks of neurons can preserve fundamental tuning properties while allowing for more flexible";
    const suffix = "responses to complex naturalistic stimuli.";
    const interveningCaption = Array(250).fill("caption").join(" ");
    const interveningFigure = Array(300).fill("figure").join(" ");
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${prefix} ${suffix}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: `${prefix}\n${interveningCaption}`,
            sourceLabel: "(Marks and Goard, 2021)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 2250,
            itemId: 2251,
            sourceFingerprint: "pdfjs:marks-goard",
            pageHintIndex: 11,
            pageHintLabel: "12",
          },
          {
            sourceText: `${interveningFigure}\n${suffix} Later discussion.`,
            sourceLabel: "(Marks and Goard, 2021)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 2250,
            itemId: 2251,
            sourceFingerprint: "pdfjs:marks-goard",
            pageHintIndex: 12,
            pageHintLabel: "13",
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.equal(countOccurrences(finalized.markdown, "[[quote:"), 2);
    assert.notInclude(finalized.markdown, "Not a source quote");
    assert.deepEqual(
      finalized.quoteCitations.map((citation) => citation.quoteText),
      [prefix, suffix],
    );
  });

  it("preserves a comma at an adjacent-page sentence split", function () {
    const prefix =
      "An influential hypothesis states that experiences are initially encoded in the hippocampus,";
    const suffix = "and subsequently, during sleep, replayed to the neocortex.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${prefix} ${suffix}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: `Earlier text. ${prefix}\n${Array(100).fill("caption").join(" ")}`,
            sourceLabel: "(Kudithipudi et al., 2022)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 3806,
            itemId: 3807,
            sourceFingerprint: "pdfjs:kudithipudi",
            pageHintIndex: 1,
          },
          {
            sourceText: `${Array(300).fill("figure").join(" ")}\n${suffix} Later text.`,
            sourceLabel: "(Kudithipudi et al., 2022)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 3806,
            itemId: 3807,
            sourceFingerprint: "pdfjs:kudithipudi",
            pageHintIndex: 2,
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.equal(countOccurrences(finalized.markdown, "[[quote:"), 2);
    assert.notInclude(finalized.markdown, "Not a source quote");
    assert.equal(finalized.quoteCitations[0]?.quoteText, prefix);
    assert.equal(finalized.quoteCitations[1]?.quoteText, suffix);
  });

  it("does not reconstruct an adjacent-page quote with an unsupported bridge word", function () {
    const prefix =
      "We then down-sampled the epoched data to 100 Hz, and we selected";
    const suffix =
      "17 channels overlying occipital and parietal cortex for further analysis.";
    const quote = `${prefix} invented ${suffix}`;
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: prefix,
            sourceLabel: "(Gifford et al., 2022)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 72,
            itemId: 71,
            sourceFingerprint: "pdfjs:gifford",
            pageHintIndex: 1,
          },
          {
            sourceText: suffix,
            sourceLabel: "(Gifford et al., 2022)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 72,
            itemId: 71,
            sourceFingerprint: "pdfjs:gifford",
            pageHintIndex: 2,
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.include(finalized.markdown, "Not a source quote");
    assert.isEmpty(finalized.quoteCitations);
  });

  it("does not stitch exact fragments across nonadjacent PDF pages", function () {
    const prefix =
      "We then down-sampled the epoched data to 100 Hz, and we selected";
    const suffix =
      "17 channels overlying occipital and parietal cortex for further analysis.";
    const quote = `${prefix} ${suffix}`;
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: prefix,
            sourceLabel: "(Gifford et al., 2022)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 72,
            itemId: 71,
            sourceFingerprint: "pdfjs:gifford",
            pageHintIndex: 1,
          },
          {
            sourceText: suffix,
            sourceLabel: "(Gifford et al., 2022)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 72,
            itemId: 71,
            sourceFingerprint: "pdfjs:gifford",
            pageHintIndex: 3,
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.include(finalized.markdown, "Not a source quote");
    assert.isEmpty(finalized.quoteCitations);
  });

  it("keeps cross-paper full-span matches ambiguous", function () {
    const quote =
      "The same substantive sentence appears in both candidate source papers.";
    const markdown = `> ${quote}
>
> (First et al., 2025)`;
    const finalized = finalizeAssistantQuoteCitations({
      markdown,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: quote,
            sourceLabel: "(First et al., 2025)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 71,
            itemId: 70,
            pageHintIndex: 1,
          },
          {
            sourceText: quote,
            sourceLabel: "(Second et al., 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 81,
            itemId: 80,
            pageHintIndex: 2,
          },
        ],
      }),
      quoteSourceReview: {
        sourceEvidenceComplete: true,
      },
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.notInclude(finalized.markdown, "```text");
    assert.equal(finalized.markdown, markdown);
  });

  it("does not double-blockquote anchored quotes already wrapped in quote syntax", function () {
    const citation = buildQuoteCitation({
      quoteText: "First source paragraph.\n\nSecond source paragraph.",
      citationLabel: "(Lee, 2025)",
      contextItemId: 22,
    });
    assert.isDefined(citation);

    const rendered = replaceQuoteCitationPlaceholdersForMarkdown(
      `Evidence:\n\n> [[quote:${citation!.id}]]`,
      [citation!],
    );
    const html = renderMarkdown(rendered);

    assert.notInclude(rendered, "> >");
    assert.notInclude(html, "<blockquote><blockquote>");
    assert.include(html, "<p>First source paragraph.</p>");
    assert.include(html, "<p>Second source paragraph.</p>");
  });

  it("keeps expanded quote anchors from absorbing the next unordered list item", function () {
    const citation = buildQuoteCitation({
      quoteText: "The absolute change in preferred direction was measured.",
      citationLabel: "(Carrasco et al., 2026)",
      contextItemId: 22,
    });
    assert.isDefined(citation);

    const rendered = replaceQuoteCitationPlaceholdersForMarkdown(
      [
        "- **Stability Metrics:** Primary measures were compared.",
        "",
        `  [[quote:${citation!.id}]]`,
        "- **Decoding and Classification:** Models transferred across sessions.",
      ].join("\n"),
      [citation!],
    );
    const html = renderMarkdown(rendered);

    assert.include(html, "<blockquote>");
    assert.include(html, "<strong>Stability Metrics:</strong>");
    assert.include(html, "<strong>Decoding and Classification:</strong>");
    assert.notInclude(html, "(Carrasco et al., 2026) -");
    assert.notInclude(html, "(Carrasco et al., 2026) *");
  });

  it("keeps adjacent manual blockquotes separate from rendered quote anchors", function () {
    const first = buildQuoteCitation({
      quoteText: "Trusted quote text from the paper.",
      citationLabel: "(Trusted, 2026)",
      contextItemId: 22,
    });
    const second = buildQuoteCitation({
      quoteText: "Second trusted quote with Unicode punctuation: alpha-beta.",
      citationLabel: "(Second, 2026)",
      contextItemId: 23,
    });
    assert.isDefined(first);
    assert.isDefined(second);

    const cases = [
      {
        name: "bare anchor after manual quote",
        markdown: `> Unresolved manual quote.\n[[quote:${first!.id}]]`,
        expectedBlockquotes: 2,
      },
      {
        name: "blockquote-wrapped anchor after manual quote",
        markdown: `> Unresolved manual quote.\n> [[quote:${first!.id}]]`,
        expectedBlockquotes: 2,
      },
      {
        name: "manual quote after anchor",
        markdown: `[[quote:${first!.id}]]\n> Unresolved manual quote.`,
        expectedBlockquotes: 2,
      },
      {
        name: "two adjacent anchors",
        markdown: `[[quote:${first!.id}]]\n[[quote:${second!.id}]]`,
        expectedBlockquotes: 2,
      },
      {
        name: "paragraph and heading around anchor",
        markdown: `Intro paragraph.\n[[quote:${first!.id}]]\n## Next finding`,
        expectedBlockquotes: 1,
      },
      {
        name: "list items around indented anchor",
        markdown: [
          "- **Metric:** compared across sessions.",
          `  [[quote:${first!.id}]]`,
          "- **Decoder:** transferred across sessions.",
        ].join("\n"),
        expectedBlockquotes: 1,
      },
    ];

    for (const testCase of cases) {
      const rendered = replaceQuoteCitationPlaceholdersForMarkdown(
        testCase.markdown,
        [first!, second!],
      );
      const html = renderMarkdown(rendered);

      assert.equal(
        countOccurrences(html, "<blockquote>"),
        testCase.expectedBlockquotes,
        testCase.name,
      );
      assert.notInclude(
        rendered,
        "> Unresolved manual quote.\n> Trusted quote text from the paper.",
        testCase.name,
      );
      assert.notInclude(html, "<blockquote><blockquote>", testCase.name);
    }
  });

  it("does not expand quote anchors inside fenced code examples", function () {
    const citation = buildQuoteCitation({
      quoteText: "Trusted quote text from the paper.",
      citationLabel: "(Trusted, 2026)",
      contextItemId: 22,
    });
    assert.isDefined(citation);

    const rendered = replaceQuoteCitationPlaceholdersForMarkdown(
      ["```text", `[[quote:${citation!.id}]]`, "```"].join("\n"),
      [citation!],
    );

    assert.include(rendered, `[[quote:${citation!.id}]]`);
    assert.notInclude(rendered, "> Trusted quote text from the paper.");
  });

  it("finalizes blockquote-wrapped quote anchors without swallowing the preceding quote", function () {
    const citation = buildQuoteCitation({
      quoteText: "Trusted quote text from the paper.",
      citationLabel: "(Trusted, 2026)",
      contextItemId: 22,
    });
    assert.isDefined(citation);

    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> Unresolved manual quote.\n> [[quote:${citation!.id}]]`,
      quoteCitations: [citation!],
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: "Trusted quote text from the paper.",
            sourceLabel: "(Trusted, 2026)",
            contextItemId: 22,
          },
          {
            sourceText: "Another source text from a different paper.",
            sourceLabel: "(Other, 2025)",
            contextItemId: 23,
          },
        ],
      }),
    });
    const rendered = replaceQuoteCitationPlaceholdersForMarkdown(
      finalized.markdown,
      finalized.quoteCitations,
    );
    const html = renderMarkdown(rendered);

    assert.include(finalized.markdown, "> Unresolved manual quote.");
    assert.notInclude(finalized.markdown, "Unresolved manual quote.\n[[quote:");
    assert.equal(countOccurrences(html, "<blockquote>"), 2);
    assert.notInclude(
      rendered,
      "> Unresolved manual quote.\n> Trusted quote text from the paper.",
    );
  });

  it("omits unresolved placeholders on external text surfaces", function () {
    const preserved = replaceQuoteCitationPlaceholdersForMarkdown(
      "Evidence: [[quote:Q_missing]]",
      [],
    );
    const omitted = replaceQuoteCitationPlaceholdersForMarkdown(
      "Evidence: [[quote:Q_missing]]",
      [],
      { unresolved: "omit" },
    );
    const legacyOmitted = replaceQuoteCitationPlaceholdersForMarkdown(
      "Evidence: [[quote:Q_missing]]",
      [],
      { unresolved: "unavailable" },
    );

    assert.include(preserved, "[[quote:Q_missing]]");
    assert.equal(omitted, "Evidence: ");
    assert.equal(legacyOmitted, "Evidence: ");
    assert.notInclude(omitted, "[[quote:");
    assert.notInclude(omitted, "[quote unavailable]");
  });

  it("detects unresolved quote placeholders before omission", function () {
    const citation = buildQuoteCitation({
      quoteText: "Resolved quote.",
      citationLabel: "(Lee, 2025)",
      contextItemId: 22,
    });
    assert.isDefined(citation);

    const unresolved = findUnresolvedQuoteCitationPlaceholderIds(
      `[[quote:${citation!.id}]] [[quote:Q_missing]] [[quote:Q_missing]]`,
      [citation!],
    );

    assert.deepEqual(unresolved, ["Q_missing"]);
  });

  it("repairs leaked source metadata markers into plain quote citations", function () {
    const leaked =
      '    "our model predicted that memory engrams are highly dynamic, with neurons being removed from and added to the engram over the course of memory consolidation" [[source=(Tomé, 2024), section=Dynamic and selective engrams emerge with memory consolidation, chunk=8]]\n\n' +
      "Critically, they show that dynamic engrams explain behavior.";

    const sanitized = sanitizeInvalidStructuredSourceMarkers(leaked);

    assert.include(sanitized, "> our model predicted");
    assert.include(sanitized, "(Tomé, 2024)");
    assert.notInclude(sanitized, "[[source=");
    assert.notInclude(sanitized, "section=");
    assert.notInclude(sanitized, "chunk=");
  });

  it("preserves leaked source metadata quotes after full quote sanitization", function () {
    const rendered = replaceQuoteCitationPlaceholdersForMarkdown(
      '"our results provide evidence that the activity of dynamic engrams..." [[source=(Tomé, 2024), section=Dynamic and selective engrams emerge with memory consolidation, chunk=28]]',
      [],
      { resolved: "preserve", unresolved: "omit" },
    );

    assert.include(
      rendered,
      "> our results provide evidence that the activity of dynamic engrams...",
    );
    assert.include(rendered, "(Tomé, 2024)");
    assert.notInclude(rendered, "[[source=");
    assert.notInclude(rendered, "section=");
    assert.notInclude(rendered, "chunk=");
  });

  it("extracts quote citations from nested tool content and JSON text payloads", function () {
    const citation = buildQuoteCitation({
      quoteText: "Tool quote.",
      citationLabel: "(Patel, 2026)",
      contextItemId: 33,
      itemId: 3,
    });
    assert.isDefined(citation);
    const content = [
      {
        type: "text",
        text: JSON.stringify({
          result: {
            quoteCitations: [citation],
          },
        }),
      },
    ];

    const extracted = extractQuoteCitationsFromToolContent(content);

    assert.lengthOf(extracted, 1);
    assert.equal(extracted[0].id, citation!.id);
    assert.equal(extracted[0].citationLabel, "(Patel, 2026)");
  });

  it("binds an author-labelled same-line anchor to the exact displayed quote instead of its retrieval chunk", function () {
    const visibleQuote =
      "Consistently, pattern identity remained perfectly decodable from population activity throughout the drift period. Together, these results show that local predictive plasticity generates drifting but organized assemblies.";
    const retrievalChunk = [
      "Earlier retrieval context that must never become the navigation query.",
      visibleQuote,
      "Later retrieval context that must never become the navigation query either.",
    ].join(" ");
    const evidence = buildQuoteCitation({
      quoteText: retrievalChunk,
      citationLabel: "(Asabuki and Clopath)",
      contextItemId: 3617,
      itemId: 3618,
    });
    assert.isDefined(evidence);

    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${visibleQuote}\n> (Asabuki and Clopath) [[quote:${evidence!.id}]]`,
      quoteCitations: [evidence!],
      sourceIndex: buildQuoteSourceIndex({
        quoteCitations: [evidence!],
        sourceTexts: [
          {
            sourceText: retrievalChunk,
            sourceLabel: "(Asabuki and Clopath)",
            contextItemId: 3617,
          },
          {
            sourceText: visibleQuote,
            sourceLabel: "(Asabuki and Clopath)",
            contextItemId: 3617,
            sourceMatchSource: "pdf-page-text",
            sourceFingerprint: "pdfjs:asabuki-test",
            pageHintIndex: 5,
          },
        ],
      }),
    });

    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(finalized.quoteCitations[0].quoteText, visibleQuote);
    assert.equal(finalized.quoteCitations[0].sourceMatchText, visibleQuote);
    assert.equal(finalized.quoteCitations[0].pageHintIndex, 5);
    assert.equal(
      finalized.quoteCitations[0].sourceFingerprint,
      "pdfjs:asabuki-test",
    );
    assert.notInclude(
      finalized.quoteCitations[0].quoteText,
      "Earlier retrieval context",
    );
  });

  it("repairs row 604 to one complete page-bounded source span including the omitted figure locator", function () {
    const visibleQuote =
      "Neurons undergoing a preference change showed a stereotyped transition in net E/I drive. The net drive associated with the previously preferred pattern was dominant before the change but declined and dropped sharply around reassignment. Concurrently, the net drive associated with the newly preferred pattern began rising before the change and became dominant afterward.";
    const pageSource = [
      "151 Neurons undergoing a preference change showed a stereotyped transition in net E/I drive.",
      "152 The net drive associated with the previously preferred pattern was dominant before the",
      "153 change but declined and dropped sharply around reassignment. Concurrently, the net drive",
      "154 associated with the newly preferred pattern began rising before the change and became",
      "155 dominant afterward (Fig. 3B).",
    ].join("\n");
    const retrievalChunk = [
      "Earlier retrieval text that is evidence only.",
      pageSource,
      "Later retrieval text that is evidence only.",
    ].join("\n");
    const evidence = buildQuoteCitation({
      id: "Q_1f7prrm",
      quoteText: retrievalChunk,
      citationLabel: "(Asabuki and Clopath)",
      contextItemId: 3617,
      itemId: 3618,
    });
    assert.isDefined(evidence);

    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${visibleQuote}\n> (Asabuki and Clopath) [[quote:${evidence!.id}]]`,
      quoteCitations: [evidence!],
      sourceIndex: buildQuoteSourceIndex({
        quoteCitations: [evidence!],
        sourceTexts: [
          {
            sourceText: pageSource,
            sourceLabel: "(Asabuki and Clopath)",
            contextItemId: 3617,
            itemId: 3618,
            sourceMatchSource: "pdf-page-text",
            sourceFingerprint: "pdfjs:asabuki-row-604",
            pageHintIndex: 5,
          },
        ],
      }),
    });

    assert.lengthOf(finalized.quoteCitations, 1);
    const citation = finalized.quoteCitations[0];
    assert.equal(citation.displayQuoteText, visibleQuote);
    assert.equal(citation.pageHintIndex, 5);
    assert.equal(citation.contextItemId, 3617);
    assert.equal(citation.sourceFingerprint, "pdfjs:asabuki-row-604");
    assert.match(citation.quoteText, /^Neurons undergoing/);
    assert.notMatch(citation.quoteText, /(?:^|\n)\s*15[2-5]\b/);
    assert.include(citation.quoteText, "The net drive");
    assert.match(citation.quoteText, /\(Fig\. 3B\)\.$/);
    assert.match(citation.sourceMatchText || "", /\(Fig\. 3B\)\.$/);
    assert.notInclude(citation.quoteText, "Earlier retrieval text");
    assert.notInclude(citation.quoteText, "Later retrieval text");
  });

  it("binds an exact quote repeated across PDF pages to the first single occurrence", function () {
    const quote =
      "Prior to conditioning the response was absent, whereas afterward it resembled the conditioned response.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}\n\n(Aschauer et al., 2022)`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: quote,
            sourceLabel: "(Aschauer et al., 2022)",
            contextItemId: 3610,
            itemId: 3609,
            sourceMatchSource: "pdf-page-text",
            sourceFingerprint: "pdfjs:aschauer",
            pageHintIndex: 5,
          },
          {
            sourceText: quote,
            sourceLabel: "(Aschauer et al., 2022)",
            contextItemId: 3610,
            itemId: 3609,
            sourceMatchSource: "pdf-page-text",
            sourceFingerprint: "pdfjs:aschauer",
            pageHintIndex: 11,
          },
        ],
      }),
    });

    assert.lengthOf(finalized.quoteCitations, 1);
    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.equal(finalized.quoteCitations[0].pageHintIndex, 5);
    assert.equal(finalized.quoteCitations[0].sourceMatchPageOccurrence, 0);
    assert.equal(finalized.quoteCitations[0].sourceMatchKind, "exact");
  });

  it("fails closed when the complete displayed quote is ambiguous on its PDF page", function () {
    const quote =
      "The complete displayed source quote is repeated verbatim and therefore needs an occurrence.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}\n> (Repeated, 2026) [[quote:Q_evidence]]`,
      quoteCitations: [
        buildQuoteCitation({
          id: "Q_evidence",
          quoteText: `${quote}\nIntervening text.\n${quote}`,
          citationLabel: "(Repeated, 2026)",
          contextItemId: 77,
        })!,
      ],
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: `${quote}\nIntervening text.\n${quote}`,
            sourceLabel: "(Repeated, 2026)",
            contextItemId: 77,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 2,
          },
        ],
      }),
    });

    assert.isEmpty(finalized.quoteCitations);
    assert.notInclude(finalized.markdown, "[[quote:");
    assert.include(finalized.markdown, quote);
  });

  it("splits an ellipsized displayed quote into separate page-bounded quote cards", function () {
    const first =
      "The first complete source sentence establishes the old assembly representation before reassignment.";
    const second =
      "The second complete source sentence establishes the new assembly representation after reassignment.";
    const evidence = buildQuoteCitation({
      id: "Q_cross_page_ellipsis",
      quoteText: `${first} Omitted source material. ${second}`,
      citationLabel: "(Asabuki and Clopath)",
      contextItemId: 3617,
    })!;
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${first} ... ${second}\n> (Asabuki and Clopath) [[quote:${evidence.id}]]`,
      quoteCitations: [evidence],
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: first,
            sourceLabel: "(Asabuki and Clopath)",
            contextItemId: 3617,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 5,
          },
          {
            sourceText: second,
            sourceLabel: "(Asabuki and Clopath)",
            contextItemId: 3617,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 6,
          },
        ],
      }),
    });

    assert.lengthOf(finalized.quoteCitations, 2);
    assert.deepEqual(
      finalized.quoteCitations.map((citation) => citation.quoteText),
      [first, second],
    );
    assert.deepEqual(
      finalized.quoteCitations.map((citation) => citation.pageHintIndex),
      [5, 6],
    );
    assert.equal(countOccurrences(finalized.markdown, "[[quote:"), 2);
  });

  it("splits a genuinely cross-page quote at complete sentence boundaries", function () {
    const first =
      "The prior assembly drive declined sharply around neuronal reassignment.";
    const second =
      "The newly preferred assembly drive rose before the change and dominated afterward.";
    const evidence = buildQuoteCitation({
      id: "Q_cross_page_sentences",
      quoteText: `${first} ${second}`,
      citationLabel: "(Asabuki and Clopath)",
      contextItemId: 3617,
    })!;
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${first} ${second}\n> (Asabuki and Clopath) [[quote:${evidence.id}]]`,
      quoteCitations: [evidence],
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: first,
            sourceLabel: "(Asabuki and Clopath)",
            contextItemId: 3617,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 5,
          },
          {
            sourceText: second,
            sourceLabel: "(Asabuki and Clopath)",
            contextItemId: 3617,
            sourceMatchSource: "pdf-page-text",
            pageHintIndex: 6,
          },
        ],
      }),
    });

    assert.lengthOf(finalized.quoteCitations, 2);
    assert.deepEqual(
      finalized.quoteCitations.map((citation) => citation.pageHintIndex),
      [5, 6],
    );
    assert.equal(countOccurrences(finalized.markdown, "[[quote:"), 2);
  });
});
