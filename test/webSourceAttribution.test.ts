import { assert } from "chai";
import {
  assessWebAttribution,
  getWebSourceAnchorsFromTrace,
  stripWebSourceMarkersForDisplay,
  type WebToolExecutionRecord,
} from "../src/webAccess/attribution";
import { injectWebSourceAnchorTokens } from "../src/modules/contextPanel/webSourceIndicators";
import { buildAssistantDisplayMarkdownForRender } from "../src/modules/contextPanel/assistantRichText";
import { renderMarkdown } from "../src/utils/markdown";

describe("web source attribution", function () {
  const source = {
    sourceId: "web_abc1234",
    url: "https://example.com/report",
    hostname: "example.com",
    organization: "Example Organization",
    title: "Annual report",
    faviconUrl: "https://example.com/favicon.ico",
    snippet: "Result snippet",
  };
  const records: WebToolExecutionRecord[] = [
    {
      name: "web_search",
      ok: true,
      content: { results: [source] },
    },
  ];

  it("removes markers and records clean paragraph insertion offsets", function () {
    const first = "The reported value is current.";
    const second = "A second paragraph repeats that source.";
    const text =
      `${first}<!--llm-web-source:web_abc1234,web_abc1234-->\n\n` +
      `${second}<!--llm-web-source:web_abc1234-->`;
    const assessment = assessWebAttribution(text, records);
    assert.equal(assessment.status, "valid");
    if (assessment.status !== "valid") return;
    assert.equal(assessment.cleanText, `${first}\n\n${second}`);
    assert.lengthOf(assessment.anchors, 2);
    assert.equal(assessment.anchors[0].offset, first.length);
    assert.equal(assessment.anchors[1].offset, `${first}\n\n${second}`.length);
    assert.lengthOf(assessment.anchors[0].sources, 1);
    assert.deepInclude(assessment.anchors[0].sources[0], {
      sourceId: "web_abc1234",
      organization: "Example Organization",
      title: "Annual report",
      faviconUrl: "https://example.com/favicon.ico",
    });
  });

  it("allows an explicit no-web-use marker without creating a chip", function () {
    const assessment = assessWebAttribution(
      "The answer does not rely on the search.\n\n<!--llm-web-source:none-->",
      records,
    );
    assert.equal(assessment.status, "valid");
    if (assessment.status === "valid") {
      assert.deepEqual(assessment.anchors, []);
      assert.equal(
        assessment.cleanText,
        "The answer does not rely on the search.",
      );
    }
  });

  it("preserves a paragraph break declared by a source marker", function () {
    const first = "A web-supported paragraph.";
    const second = "**A separate paragraph.** More text.";
    const assessment = assessWebAttribution(
      `${first}<!--llm-web-source:web_abc1234-->\n${second}`,
      records,
    );
    assert.equal(assessment.status, "valid");
    if (assessment.status !== "valid") return;
    assert.equal(assessment.cleanText, `${first}\n\n${second}`);
    assert.equal(assessment.anchors[0].offset, first.length);
  });

  it("keeps a compact list compact while anchoring the preceding item", function () {
    const first = "- First sourced item.";
    const second = "- Second item.";
    const assessment = assessWebAttribution(
      `${first}<!--llm-web-source:web_abc1234-->\n${second}`,
      records,
    );
    assert.equal(assessment.status, "valid");
    if (assessment.status !== "valid") return;
    assert.equal(assessment.cleanText, `${first}\n${second}`);
    assert.equal(assessment.anchors[0].offset, first.length);
  });

  it("falls back to an end chip for missing and unknown sources, and to no chip when no source is usable", function () {
    const missing = assessWebAttribution("Unattributed claim.", records);
    assert.equal(missing.status, "valid");
    if (missing.status !== "valid") return;
    assert.equal(missing.cleanText, "Unattributed claim.");
    assert.lengthOf(missing.anchors, 1);
    assert.equal(missing.anchors[0].placement, "end");
    assert.equal(missing.anchors[0].offset, missing.cleanText.length);
    assert.deepEqual(
      missing.anchors[0].sources.map((item) => item.sourceId),
      ["web_abc1234"],
    );

    const unknown = assessWebAttribution(
      "Claim.<!--llm-web-source:web_unknown-->",
      records,
    );
    assert.equal(unknown.status, "valid");
    if (unknown.status !== "valid") return;
    assert.equal(unknown.cleanText, "Claim.");
    assert.lengthOf(unknown.anchors, 1);
    assert.equal(unknown.anchors[0].placement, "end");
    assert.deepEqual(unknown.dropped, ["web_unknown"]);

    const failed = assessWebAttribution(
      "Claim.<!--llm-web-source:web_abc1234-->",
      [{ name: "web_search", ok: false, content: { results: [source] } }],
    );
    assert.equal(failed.status, "valid");
    if (failed.status !== "valid") return;
    assert.equal(failed.cleanText, "Claim.");
    assert.deepEqual(failed.anchors, []);

    const unsafe = assessWebAttribution(
      "Claim.<!--llm-web-source:web_abc1234-->",
      [
        {
          name: "web_search",
          ok: true,
          content: {
            results: [{ ...source, url: "http://127.0.0.1/private" }],
          },
        },
      ],
    );
    assert.equal(unsafe.status, "valid");
    if (unsafe.status !== "valid") return;
    assert.equal(unsafe.cleanText, "Claim.");
    assert.deepEqual(unsafe.anchors, []);
  });

  it("strips a residual partial marker and adds the end chip", function () {
    const other = {
      ...source,
      sourceId: "web_def5678",
      url: "https://example.org/other",
    };
    const a = assessWebAttribution(
      "First.<!--llm-web-source:web_abc1234-->\n\nSecond.<!-- LLM-web-source:web_",
      [{ name: "web_search", ok: true, content: { results: [source, other] } }],
    );
    assert.equal(a.status, "valid");
    if (a.status !== "valid") return;
    assert.equal(a.cleanText, "First.\n\nSecond.");
    assert.notMatch(a.cleanText, /llm-web-source/i);
    assert.lengthOf(a.anchors, 2);
    assert.equal(a.anchors[0].offset, "First.".length);
    assert.isUndefined(a.anchors[0].placement);
    assert.equal(a.anchors[1].placement, "end");
    assert.deepEqual(
      a.anchors[1].sources.map((item) => item.sourceId),
      ["web_def5678"],
    );
  });

  it("merges adjacent markers on one line", function () {
    const merged = assessWebAttribution(
      "Claim.<!--llm-web-source:web_abc1234--><!--llm-web-source:web_abc1234-->",
      records,
    );
    assert.equal(merged.status, "valid");
    if (merged.status !== "valid") return;
    assert.lengthOf(merged.anchors, 1);
    assert.lengthOf(merged.anchors[0].sources, 1);
  });

  describe("end chip fallback", function () {
    const numbered = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...source,
        sourceId: `web_${index + 1}`,
        url: `https://example.com/page-${index + 1}`,
      }));
    const ids = (anchor: { sources: { sourceId: string }[] } | undefined) =>
      (anchor?.sources || []).map((item) => item.sourceId);

    it("lists read pages first, or search results when nothing was read", function () {
      const results = numbered(3);
      const search: WebToolExecutionRecord = {
        name: "web_search",
        ok: true,
        content: { results },
      };
      const read: WebToolExecutionRecord = {
        name: "web_read",
        ok: true,
        content: { pages: [results[1]] },
      };
      const withRead = assessWebAttribution("An answer.", [search, read]);
      assert.equal(withRead.status, "valid");
      if (withRead.status !== "valid") return;
      assert.lengthOf(withRead.anchors, 1);
      assert.equal(withRead.anchors[0].placement, "end");
      assert.deepEqual(ids(withRead.anchors[0]), ["web_2"]);

      const searchOnly = assessWebAttribution("An answer.", [search]);
      assert.equal(searchOnly.status, "valid");
      if (searchOnly.status !== "valid") return;
      assert.deepEqual(ids(searchOnly.anchors[0]), ["web_1", "web_2", "web_3"]);
    });

    it("lists all 10 search results when there are no reads and no markers", function () {
      const a = assessWebAttribution("An answer.", [
        { name: "web_search", ok: true, content: { results: numbered(10) } },
      ]);
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.lengthOf(a.anchors, 1);
      assert.deepEqual(
        ids(a.anchors[0]),
        numbered(10).map((item) => item.sourceId),
      );
    });

    it("keeps valid paragraph anchors and adds only unshown sources to the end chip", function () {
      const a = assessWebAttribution(
        "A.<!--llm-web-source:web_1-->\n\nB.<!--llm-web-source:web_9-->",
        [{ name: "web_search", ok: true, content: { results: numbered(2) } }],
      );
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.equal(a.cleanText, "A.\n\nB.");
      assert.lengthOf(a.anchors, 2);
      assert.equal(a.anchors[0].offset, "A.".length);
      assert.deepEqual(ids(a.anchors[0]), ["web_1"]);
      assert.equal(a.anchors[1].placement, "end");
      assert.equal(a.anchors[1].offset, a.cleanText.length);
      assert.deepEqual(ids(a.anchors[1]), ["web_2"]);
    });

    it("a sole none marker gives no chips", function () {
      const a = assessWebAttribution("Answer.<!--llm-web-source:none-->", [
        { name: "web_search", ok: true, content: { results: numbered(2) } },
      ]);
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.equal(a.cleanText, "Answer.");
      assert.deepEqual(a.anchors, []);
    });
  });

  describe("mid-line markers", function () {
    const sourceB = {
      ...source,
      sourceId: "web_def5678",
      url: "https://example.org/releases",
      hostname: "example.org",
      organization: "Example Org",
      title: "Release list",
    };
    const two: WebToolExecutionRecord[] = [
      { name: "web_search", ok: true, content: { results: [source, sourceB] } },
    ];
    const M = (ids: string) => `<!--llm-web-source:${ids}-->`;

    it("merges mid-line markers into one end-of-line anchor", function () {
      const text = `Intro defaults.${M("web_abc1234")} The release list...${M("web_def5678")} So: done.`;
      const clean = "Intro defaults. The release list... So: done.";
      const a = assessWebAttribution(text, two);
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.equal(a.cleanText, clean);
      assert.lengthOf(a.anchors, 1);
      assert.equal(a.anchors[0].offset, clean.length);
      assert.deepEqual(
        a.anchors[0].sources.map((s) => s.sourceId),
        ["web_abc1234", "web_def5678"],
      );
    });

    it("drops the space a marker left before punctuation", function () {
      const a = assessWebAttribution(
        `On the page ${M("web_abc1234")}, while the list ${M("web_def5678")}. Done 完成 ${M("web_abc1234")}。`,
        two,
      );
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.equal(a.cleanText, "On the page, while the list. Done 完成。");
    });

    it("de-duplicates repeated IDs across markers on one line", function () {
      const a = assessWebAttribution(
        `A.${M("web_abc1234")} B.${M("web_def5678,web_abc1234")} C.`,
        two,
      );
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.deepEqual(
        a.anchors[0].sources.map((s) => s.sourceId),
        ["web_abc1234", "web_def5678"],
      );
    });

    it("anchors each paragraph at its own end", function () {
      const p1 = "First paragraph.";
      const p2 = "Second one. More text.";
      const a = assessWebAttribution(
        `${p1}${M("web_abc1234")}\n\nSecond one.${M("web_def5678")} More text.`,
        two,
      );
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.equal(a.cleanText, `${p1}\n\n${p2}`);
      assert.lengthOf(a.anchors, 2);
      assert.equal(a.anchors[0].offset, p1.length);
      assert.equal(a.anchors[1].offset, `${p1}\n\n${p2}`.length);
    });

    it("accepts a marker at the start of a line", function () {
      const a = assessWebAttribution(`${M("web_abc1234")} Claim text.`, two);
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.equal(a.cleanText, "Claim text.");
      assert.equal(a.anchors[0].offset, a.cleanText.length);
    });

    it("leaves one space where a mid-line marker sat between words", function () {
      const a = assessWebAttribution(
        `A ${M("web_abc1234")} B ${M("web_def5678")} C.`,
        two,
      );
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.equal(a.cleanText, "A B C.");
      const nested = assessWebAttribution(
        `- Item\n  ${M("web_abc1234")} continued text.`,
        two,
      );
      assert.equal(nested.status, "valid");
      if (nested.status !== "valid") return;
      assert.equal(nested.cleanText, "- Item\n  continued text.");
    });

    it("drops a table-row marker, keeps the row, and moves its sources to the end chip", function () {
      const row = `| GPT-4 ${M("web_abc1234")} | 2023 |`;
      const text = `| Model | Year |\n|---|---|\n${row}\n| Claude | 2024 |`;
      const a = assessWebAttribution(text, two);
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.equal(
        a.cleanText,
        "| Model | Year |\n|---|---|\n| GPT-4  | 2023 |\n| Claude | 2024 |",
      );
      assert.lengthOf(a.anchors, 1);
      assert.equal(a.anchors[0].placement, "end");
      assert.deepEqual(
        a.anchors[0].sources.map((s) => s.sourceId),
        ["web_abc1234", "web_def5678"],
      );
      const header = assessWebAttribution(
        `| Model ${M("web_abc1234")} | Year |\n|---|---|\n| A | 1 |`,
        two,
      );
      assert.equal(header.status, "valid");
      if (header.status !== "valid") return;
      assert.equal(header.cleanText, "| Model  | Year |\n|---|---|\n| A | 1 |");
      assert.equal(header.anchors[0]?.placement, "end");
    });

    it("inserts no blank line inside a table for an end-of-row marker", function () {
      const a = assessWebAttribution(
        `| Model | Year |\n|---|---|\n| GPT-4 | 2023 |${M("web_abc1234")}\n| Claude | 2024 |`,
        two,
      );
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.equal(
        a.cleanText,
        "| Model | Year |\n|---|---|\n| GPT-4 | 2023 |\n| Claude | 2024 |",
      );
    });

    it("moves a marker at the end of a table row to the end chip", function () {
      const table = "| a | b |\n|---|---|\n| x | y |";
      const a = assessWebAttribution(`${table}${M("web_abc1234")}`, two);
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.equal(a.cleanText, table);
      assert.lengthOf(a.anchors, 1);
      assert.equal(a.anchors[0].placement, "end");
      assert.include(
        a.anchors[0].sources.map((s) => s.sourceId),
        "web_abc1234",
      );
    });

    it("keeps an ID with conflicting URLs out of the end chip", function () {
      const a = assessWebAttribution("Claim.", [
        {
          name: "web_search",
          ok: true,
          content: { results: [source, sourceB] },
        },
        {
          name: "web_search",
          ok: true,
          content: {
            results: [{ ...source, url: "http://127.0.0.1/private" }],
          },
        },
      ]);
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.lengthOf(a.anchors, 1);
      assert.deepEqual(
        a.anchors[0].sources.map((s) => s.sourceId),
        ["web_def5678"],
      );
    });

    it("falls back to the end chip for unrepairable lines", function () {
      const unknown = assessWebAttribution(
        `Text ${M("web_unknown")} more text here.`,
        two,
      );
      assert.equal(unknown.status, "valid");
      if (unknown.status !== "valid") return;
      assert.equal(unknown.cleanText, "Text more text here.");
      assert.lengthOf(unknown.anchors, 1);
      assert.equal(unknown.anchors[0].placement, "end");
      assert.deepEqual(
        unknown.anchors[0].sources.map((s) => s.sourceId),
        ["web_abc1234", "web_def5678"],
      );

      const none = assessWebAttribution(`Text ${M("none")} more text.`, two);
      assert.equal(none.status, "valid");
      if (none.status !== "valid") return;
      assert.notInclude(none.cleanText, "llm-web-source");
      assert.lengthOf(none.anchors, 1);
      assert.equal(none.anchors[0].placement, "end");

      const mixed = assessWebAttribution(
        `Text ${M("none")} more ${M("web_def5678")} text.`,
        two,
      );
      assert.equal(mixed.status, "valid");
      if (mixed.status !== "valid") return;
      assert.notInclude(mixed.cleanText, "llm-web-source");
      assert.lengthOf(mixed.anchors, 1);
      assert.equal(mixed.anchors[0].placement, "end");
      assert.deepEqual(
        mixed.anchors[0].sources.map((s) => s.sourceId),
        ["web_def5678", "web_abc1234"],
      );
    });

    it("keeps a link's marker where the link was, beside the paragraph's marker", function () {
      const a = assessWebAttribution(
        `Per [the report](https://example.com/report), it holds.${M("web_def5678")}`,
        two,
      );
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.equal(a.cleanText, "Per the report, it holds.");
      assert.deepEqual(
        a.anchors.map((anchor) => [
          anchor.offset,
          anchor.placement,
          anchor.sources.map((s) => s.sourceId),
        ]),
        [
          ["Per the report".length, "inline", ["web_abc1234"]],
          ["Per the report, it holds.".length, undefined, ["web_def5678"]],
        ],
      );
    });

    it("leaves fenced marker-like text untouched", function () {
      const fenced = `\`\`\`html\nx ${M("web_abc1234")} y\n\`\`\``;
      const a = assessWebAttribution(
        `${fenced}\n\nProse.${M("web_abc1234")} More.`,
        two,
      );
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.include(a.cleanText, fenced);
      assert.lengthOf(a.anchors, 1);
    });
  });

  describe("marker variants", function () {
    const first = {
      ...source,
      sourceId: "web_1",
      url: "https://example.com/first",
    };
    const second = {
      ...source,
      sourceId: "web_2",
      url: "https://example.org/second",
      hostname: "example.org",
    };
    const numbered: WebToolExecutionRecord[] = [
      {
        name: "web_search",
        ok: true,
        content: { results: [first, second] },
      },
    ];

    it("accepts markers with spaces, upper case, and wrapping backticks", function () {
      const text = [
        "A.<!-- llm-web-source: web_1 -->",
        "B.<!--LLM-WEB-SOURCE:WEB_2-->",
        "C.`<!--llm-web-source:web_1, web_2-->`",
      ].join("\n");
      const a = assessWebAttribution(text, numbered);
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.lengthOf(a.anchors, 3);
      assert.deepEqual(
        a.anchors.map((anchor) => anchor.sources.map((item) => item.sourceId)),
        [["web_1"], ["web_2"], ["web_1", "web_2"]],
      );
      assert.notMatch(a.cleanText, /llm-web-source/i);
      assert.notInclude(a.cleanText, "`");
    });

    it("hides a spaced marker while it streams", function () {
      assert.equal(
        stripWebSourceMarkersForDisplay("Fact. <!-- llm-web"),
        "Fact. ",
      );
    });

    it("leaves an ordinary HTML comment and code marker text unchanged", function () {
      assert.equal(
        stripWebSourceMarkersForDisplay("Note <!-- draft"),
        "Note <!-- draft",
      );
      const fenced = "```\nUse `<!--llm-web-source:x-->` literally\n```";
      assert.include(
        assessWebAttribution(
          `${fenced}\n\nProse.<!--llm-web-source:web_1-->`,
          numbered,
        ).cleanText,
        fenced,
      );
      const inline = "Type `see <!--llm-web-source:x--> here` to cite.";
      assert.include(
        assessWebAttribution(
          `${inline}\n\nProse.<!--llm-web-source:web_1-->`,
          numbered,
        ).cleanText,
        inline,
      );
      assert.equal(stripWebSourceMarkersForDisplay(inline), inline);
      assert.equal(
        stripWebSourceMarkersForDisplay("Type `see <!--llm-web"),
        "Type `see <!--llm-web",
      );
    });
  });

  it("ignores marker-like text inside fenced code", function () {
    const text = [
      "```html",
      "<!--llm-web-source:web_abc1234-->",
      "```",
      "",
      "Supported prose.<!--llm-web-source:web_abc1234-->",
    ].join("\n");
    const assessment = assessWebAttribution(text, records);
    assert.equal(assessment.status, "valid");
    if (assessment.status !== "valid") return;
    assert.include(
      assessment.cleanText,
      "```html\n<!--llm-web-source:web_abc1234-->\n```",
    );
    assert.lengthOf(assessment.anchors, 1);
  });

  it("suppresses full and partial markers while streaming", function () {
    assert.equal(
      stripWebSourceMarkersForDisplay(
        "First.<!--llm-web-source:web_abc1234-->\n\nSecond.<!--llm-web-source:web_",
      ),
      "First.\n\nSecond.",
    );
    assert.equal(
      stripWebSourceMarkersForDisplay("Streaming claim.<!--llm-web"),
      "Streaming claim.",
    );
    assert.equal(
      stripWebSourceMarkersForDisplay(
        "```html\n<!--llm-web-source:web_abc1234-->\n```",
      ),
      "```html\n<!--llm-web-source:web_abc1234-->\n```",
    );
  });

  it("keeps the text after a mid-line marker visible while streaming", function () {
    // The repair moves mid-line markers only when the answer ends; until
    // then the rest of the line was cut off at the marker (2026-10-21).
    assert.equal(
      stripWebSourceMarkersForDisplay(
        "Claim <!--llm-web-source:web_abc1234--> and more, cited <!--llm-web-source:web_def5678-->. Next <!--llm-web",
      ),
      "Claim  and more, cited. Next ",
    );
  });

  it("restores anchors from terminal trace metadata and injects display tokens", function () {
    const anchors = [
      {
        offset: 6,
        sources: [source],
      },
    ];
    const restored = getWebSourceAnchorsFromTrace([
      {
        runId: "run-1",
        seq: 1,
        eventType: "final",
        payload: { type: "final", text: "Answer", webSourceAnchors: anchors },
        createdAt: 1,
      },
    ]);
    assert.deepEqual(restored, anchors);
    assert.equal(
      injectWebSourceAnchorTokens("Answer", restored),
      "AnswerLLMWEBSOURCEANCHOR0END",
    );
    // An end chip is a paragraph of its own; the renderer keeps it so the
    // indicator pass can swap the token for the chip.
    const endAnchors = [
      {
        offset: "Answer.".length,
        placement: "end" as const,
        sources: [source],
      },
    ];
    const restoredEnd = getWebSourceAnchorsFromTrace([
      {
        runId: "run-2",
        seq: 1,
        eventType: "final",
        payload: {
          type: "final",
          text: "Answer.",
          webSourceAnchors: endAnchors,
        },
        createdAt: 1,
      },
    ]);
    assert.deepEqual(restoredEnd, endAnchors);
    const markdown = buildAssistantDisplayMarkdownForRender(
      { text: "Answer." },
      restoredEnd,
    );
    assert.equal(markdown, "Answer.\n\nLLMWEBSOURCEANCHOR0END");
    assert.include(renderMarkdown(markdown), "<p>LLMWEBSOURCEANCHOR0END</p>");
  });

  it("keeps restored paragraph anchors separated without loosening lists", function () {
    const anchors = [
      {
        offset: "First paragraph.".length,
        sources: [source],
      },
    ];
    assert.equal(
      injectWebSourceAnchorTokens("First paragraph.\n**Second.**", anchors),
      "First paragraph.LLMWEBSOURCEANCHOR0END\n\n**Second.**",
    );
    assert.equal(
      injectWebSourceAnchorTokens("- First item.\n- Second item.", [
        { offset: "- First item.".length, sources: [source] },
      ]),
      "- First item.LLMWEBSOURCEANCHOR0END\n- Second item.",
    );
  });

  it("keeps a bare URL's link intact before its source chip", function () {
    const nih = {
      ...source,
      sourceId: "web_1",
      url: "https://sharing.nih.gov/dms",
      hostname: "sharing.nih.gov",
    };
    const nihRecords: WebToolExecutionRecord[] = [
      { name: "web_search", ok: true, content: { results: [nih] } },
    ];
    // The second URL is not a found page, so the model's own marker stays.
    for (const [text, url] of [
      [
        "Sources:\n- https://sharing.nih.gov/dms",
        "https://sharing.nih.gov/dms",
      ],
      [
        "See https://example.org/elsewhere<!--llm-web-source:web_1-->",
        "https://example.org/elsewhere",
      ],
      [
        "See https://en.wikipedia.org/wiki/Foo_(bar)<!--llm-web-source:web_1-->",
        "https://en.wikipedia.org/wiki/Foo_(bar)",
      ],
    ]) {
      const a = assessWebAttribution(text, nihRecords);
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      const html = renderMarkdown(
        injectWebSourceAnchorTokens(a.cleanText, a.anchors),
      );
      const href = html.match(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/s);
      assert.equal(href?.[1], url, html);
      assert.notInclude(href?.[2] || "", "LLMWEBSOURCEANCHOR");
      assert.include(html, "LLMWEBSOURCEANCHOR0END");
    }
  });

  it("adds no space after a markdown link before the chip token", function () {
    const text = "See [t](https://example.org/x).";
    const offset = "See [t](https://example.org/x)".length;
    assert.equal(
      injectWebSourceAnchorTokens(text, [{ offset, sources: [source] }]),
      "See [t](https://example.org/x)LLMWEBSOURCEANCHOR0END.",
    );
  });

  it("does not create attribution when web tools never ran", function () {
    const assessment = assessWebAttribution("Plain response.", [
      { name: "library_read", ok: true, content: {} },
    ]);
    assert.deepEqual(assessment, {
      status: "not_used",
      cleanText: "Plain response.",
      anchors: [],
    });
  });
});
