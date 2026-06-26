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

  it("keeps wrongly labeled Chinese quotes plain without dropping attribution", function () {
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

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.lengthOf(finalized.quoteCitations, 0);
    assert.include(finalized.markdown, `> ${quote}`);
    assert.include(finalized.markdown, "(王, 2024)");
  });

  it("keeps quotes unanchored when the source label points to the wrong paper", function () {
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

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.lengthOf(finalized.quoteCitations, 0);
    assert.include(finalized.markdown, "> Paper A reports");
    assert.notInclude(finalized.markdown, "(Paper B, 2024)");
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

  it("drops publisher DOI boilerplate quote blocks inside prose parentheticals", function () {
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
    assert.notInclude(display, boilerplate);
    assert.notInclude(display, "(Liu et al., 2026)");
    assert.notInclude(display, "Science (");
    assert.notInclude(display, "), the study");
    assert.include(
      display,
      "Published in Science, the study challenges decades of conventional wisdom.",
    );
    assert.notInclude(rendered, "<blockquote>");
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

  it("keeps unmatched canonical quote labels plain and unclickable", function () {
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
    assert.notInclude(finalized.markdown, "(Smith et al., 2024)");
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
