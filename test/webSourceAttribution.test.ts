import { assert } from "chai";
import {
  assessWebAttribution,
  getWebSourceAnchorsFromTrace,
  stripWebSourceMarkersForDisplay,
  type WebToolExecutionRecord,
} from "../src/webAccess/attribution";
import { injectWebSourceAnchorTokens } from "../src/modules/contextPanel/webSourceIndicators";

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

  it("rejects missing, unknown, failed, and unsafe sources", function () {
    assert.equal(
      assessWebAttribution("Unattributed claim.", records).status,
      "invalid",
    );
    assert.equal(
      assessWebAttribution("Claim.<!--llm-web-source:web_unknown-->", records)
        .status,
      "invalid",
    );
    assert.equal(
      assessWebAttribution("Claim.<!--llm-web-source:web_abc1234-->", [
        { name: "web_search", ok: false, content: { results: [source] } },
      ]).status,
      "invalid",
    );
    assert.equal(
      assessWebAttribution("Claim.<!--llm-web-source:web_abc1234-->", [
        {
          name: "web_search",
          ok: true,
          content: {
            results: [{ ...source, url: "http://127.0.0.1/private" }],
          },
        },
      ]).status,
      "invalid",
    );
  });

  it("rejects residual partial markers and multiple markers on one paragraph", function () {
    assert.equal(
      assessWebAttribution(
        "First.<!--llm-web-source:web_abc1234-->\n\nSecond.<!--llm-web-source:web_",
        records,
      ).status,
      "invalid",
    );
    assert.equal(
      assessWebAttribution(
        "Claim.<!--llm-web-source:web_abc1234--><!--llm-web-source:web_abc1234-->",
        records,
      ).status,
      "invalid",
    );
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
