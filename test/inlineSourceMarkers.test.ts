import { assert } from "chai";
import {
  assessWebAttribution,
  buildSourceCatalog,
  type WebToolExecutionRecord,
} from "../src/webAccess/attribution";
import {
  buildEarlierSourcesBlock,
  earlierSourceCatalog,
} from "../src/webAccess/earlierSources";
import { paperSourceId } from "../src/webAccess/paperSources";

describe("inline source markers", function () {
  const paperSearch: WebToolExecutionRecord = {
    name: "literature_search",
    ok: true,
    content: {
      results: [
        {
          title: "Sample VR study shows cell change is intrinsic",
          authors: ["Ann Arden", "Bo Lee"],
          year: 2025,
          doi: "10.1101/2025.01.01.000001",
          sourceUrl:
            "https://www.biorxiv.org/content/10.1101/2025.01.01.000001",
        },
      ],
    },
  };
  const webSearch: WebToolExecutionRecord = {
    name: "web_search",
    ok: true,
    content: {
      results: [
        {
          sourceId: "web_3",
          url: "https://en.wikipedia.org/wiki/Representational_drift",
          hostname: "en.wikipedia.org",
          organization: "Wikipedia",
          title: "Representational drift",
        },
      ],
    },
  };
  const ardenId = paperSourceId("doi:10.1101/2025.01.01.000001");

  it("turns a link to a scholarly paper into a marker where the link was", function () {
    const a = assessWebAttribution(
      "The strongest test is [Arden et al. (2025)](https://doi.org/10.1101/2025.01.01.000001), who held behavior constant.",
      [paperSearch],
    );
    assert.equal(a.status, "valid");
    if (a.status !== "valid") return;
    assert.equal(
      a.cleanText,
      "The strongest test is Arden et al. (2025), who held behavior constant.",
    );
    assert.lengthOf(a.anchors, 1);
    assert.equal(a.anchors[0].placement, "inline");
    assert.equal(
      a.anchors[0].offset,
      "The strongest test is Arden et al. (2025)".length,
    );
    const source = a.anchors[0].sources[0];
    assert.equal(source.sourceId, ardenId);
    assert.equal(source.kind, "paper");
    assert.equal(source.faviconUrl, "https://www.biorxiv.org/favicon.ico");
    assert.include(source.organization, "bioRxiv");
  });

  it("matches a DOI link in another letter case or through dx.doi.org", function () {
    const a = assessWebAttribution(
      "Drift is intrinsic (https://dx.doi.org/10.1101/2025.01.01.000001).",
      [paperSearch],
    );
    assert.equal(a.status, "valid");
    if (a.status !== "valid") return;
    assert.equal(a.cleanText, "Drift is intrinsic.");
    assert.equal(a.anchors[0].offset, "Drift is intrinsic".length);
    assert.equal(a.anchors[0].sources[0].sourceId, ardenId);
  });

  it("lets a follow-up cite what an earlier question found", function () {
    const earlier = buildSourceCatalog([paperSearch, webSearch]);
    const a = assessWebAttribution(
      "De Snoo changed experience on purpose; [Arden et al.](https://doi.org/10.1101/2025.01.01.000001) held it constant.\n\nAn overview agrees.<!--llm-web-source:web_3-->",
      [],
      { earlier },
    );
    assert.equal(a.status, "valid");
    if (a.status !== "valid") return;
    assert.deepEqual(
      a.anchors.map((anchor) => [
        anchor.placement || "paragraph",
        anchor.sources.map((s) => s.sourceId),
      ]),
      [
        ["inline", [ardenId]],
        ["paragraph", ["web_3"]],
      ],
    );
    assert.notInclude(a.cleanText, "llm-web-source");
    assert.notInclude(a.cleanText, "doi.org");
  });

  it("leaves an answer with no known sources as written", function () {
    const text = "See [the docs](https://example.org/docs) for more.";
    const a = assessWebAttribution(text, []);
    assert.equal(a.status, "not_used");
    assert.equal(a.cleanText, text);
  });

  it("keeps a link to an unknown page as a link", function () {
    const a = assessWebAttribution(
      "Arden et al. (2025) agree; see also [a blog](https://example.org/blog).",
      [paperSearch],
    );
    assert.equal(a.status, "not_used");
    assert.include(a.cleanText, "(https://example.org/blog)");
  });

  it("leaves a follow-up that uses no earlier source as written", function () {
    const earlier = buildSourceCatalog([paperSearch, webSearch]);
    const text =
      "From your library: the paper reports drift.\n\n- One point\n- Another";
    const a = assessWebAttribution(text, [], { earlier });
    assert.equal(a.status, "not_used");
    assert.equal(a.cleanText, text);
  });

  it("tells a follow-up which sources earlier questions found", function () {
    const catalog = earlierSourceCatalog([
      { toolName: "web_search", content: webSearch.content, createdAt: 2 },
      {
        toolName: "literature_search",
        content: paperSearch.content,
        createdAt: 1,
      },
    ]);
    const block = buildEarlierSourcesBlock(catalog) || "";
    assert.include(block, `- ${ardenId}: Sample VR`);
    assert.include(block, "- web_3: Representational drift");
    assert.include(block, "<!--llm-web-source:SOURCE_ID-->");
    assert.isUndefined(
      buildEarlierSourcesBlock({ sources: new Map(), linkIds: new Map() }),
    );
  });
});
