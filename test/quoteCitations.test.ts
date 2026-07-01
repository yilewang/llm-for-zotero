import { assert } from "chai";
import {
  buildQuoteAnchorPromptBlock,
  buildQuoteCitation,
  buildQuoteSourceIndex,
  buildSelectedTextQuoteCitations,
  extractQuoteCitationsFromToolContent,
  finalizeAssistantQuoteCitations,
  findUnresolvedQuoteCitationPlaceholderIds,
  isCanonicalQuoteSourceLabel,
  isNonSourceQuoteLabel,
  isQuoteWorthySourceText,
  isSectionOnlyCitationLabel,
  normalizeQuoteCitationPlaceholdersForDisplay,
  replaceQuoteCitationPlaceholdersForMarkdown,
  sanitizeInvalidStructuredSourceMarkers,
} from "../src/modules/contextPanel/quoteCitations";
import { stripLeadingCitationSeparators } from "../src/modules/contextPanel/citationText";
import { renderMarkdown } from "../src/utils/markdown";

describe("quoteCitations", function () {
  function countOccurrences(value: string, needle: string): number {
    if (!needle) return 0;
    return value.split(needle).length - 1;
  }

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

  it("repairs incomplete paper blockquotes through unique source snippets", function () {
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

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(
      finalized.quoteCitations[0].citationLabel,
      "(Busch et al., 2026)",
    );
    assert.include(
      finalized.quoteCitations[0].sourceMatchText || "",
      "we hypothesized that some brain states are easier",
    );
    assert.equal(finalized.quoteCitations[0].quoteText, sourceText);
    assert.notInclude(
      finalized.quoteCitations[0].quoteText,
      "This added sentence is not source text",
    );
    assert.notInclude(
      replaceQuoteCitationPlaceholdersForMarkdown(
        finalized.markdown,
        finalized.quoteCitations,
      ),
      "This added sentence is not source text",
    );
  });

  it("repairs blockquotes when only an interior source snippet matches", function () {
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

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.oneOf(finalized.quoteCitations[0].sourceMatchKind, [
      "raw-middle",
      "progressive",
    ]);
    assert.equal(finalized.quoteCitations[0].quoteText, sourceText);
    assert.notInclude(
      finalized.quoteCitations[0].quoteText,
      "unsupported wording",
    );
  });

  it("repairs ellipsized paper blockquotes through ordered source fragments", function () {
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
  });

  it("repairs ellipsized paper blockquotes when extracted fragment order differs", function () {
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
  });

  it("repairs ellipsized paper blockquotes across hyphenation differences", function () {
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

  it("strips supplementary table labels from quote tails before matching", function () {
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

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.notInclude(
      finalized.quoteCitations[0].quoteText,
      "Supplementary Table",
    );
    const exported = replaceQuoteCitationPlaceholdersForMarkdown(
      finalized.markdown,
      finalized.quoteCitations,
    );
    assert.notInclude(exported, "Supplementary Table");
    assert.include(exported, "(Busch et al., 2026)");
  });

  it("strips figure caption labels from quote tails before matching", function () {
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

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.notInclude(finalized.quoteCitations[0].quoteText, "Fig. 1b");
    const exported = replaceQuoteCitationPlaceholdersForMarkdown(
      finalized.markdown,
      finalized.quoteCitations,
    );
    assert.include(exported, "(Busch et al., 2026)");
    assert.notInclude(exported, "Fig. 1b caption");
  });

  it("finalizes same-line citation commentary by splitting the citation label", function () {
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
    assert.notInclude(finalized.markdown, "(Busch et al., 2026) And");
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

  it("strips leading punctuation from consumed citation continuation text", function () {
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
    assert.notInclude(finalized.markdown, "(Anticevic et al., 2013),");
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

  it("keeps the active source label for unmatched section-labeled single-source blockquotes", function () {
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
    assert.notInclude(finalized.markdown, "(Abstract)");
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

  it("trusts clean model quotes from PDF page text without degrading display text", function () {
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
          },
        ],
      }),
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(finalized.quoteCitations[0].quoteText, cleanQuote);
    assert.equal(
      finalized.quoteCitations[0].citationLabel,
      "(Zaid and Schaffer, 2026)",
    );
    assert.equal(
      finalized.quoteCitations[0].sourceMatchSource,
      "pdf-page-text",
    );
  });

  it("does not anchor quotes that start inside a source token", function () {
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
    assert.include(finalized.markdown, `> ${quote}`);
  });

  it("preserves source punctuation when normalizing quote spans", function () {
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
      "The model’s accuracy dropped sharply!",
    );
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
    assert.notEqual(finalized.quoteCitations[0].quoteText, displayQuote);
    assert.include(
      finalized.quoteCitations[0].quoteText,
      "dropped with the number of sessions intervening between train and test sessions",
    );
    assert.equal(finalized.quoteCitations[0].displayQuoteText, displayQuote);

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

  it("keeps model math markdown as display text when PDF text verifies a quote", function () {
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
          },
        ],
      }),
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.notEqual(finalized.quoteCitations[0].quoteText, displayQuote);
    assert.include(finalized.quoteCitations[0].quoteText, "y*0");
    assert.equal(finalized.quoteCitations[0].displayQuoteText, displayQuote);
    assert.equal(
      finalized.quoteCitations[0].sourceMatchSource,
      "pdf-page-text",
    );

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
});
