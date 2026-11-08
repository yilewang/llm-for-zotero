import { assert } from "chai";
import {
  assessWebAttribution,
  parseWebSourceMarkerValue,
  stripWebSourceMarkersForDisplay,
  type WebToolExecutionRecord,
} from "../src/webAccess/attribution";
import { paperSourceId } from "../src/webAccess/paperSources";

describe("exact phrases with source markers", function () {
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
        {
          sourceId: "web_5",
          url: "https://example.org/review",
          hostname: "example.org",
          organization: "Example",
          title: "A review",
        },
      ],
    },
  };
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
        },
      ],
    },
  };
  const ardenId = paperSourceId("doi:10.1101/2025.01.01.000001");

  it("reads ids and their exact words, commas inside the words included", function () {
    assert.deepEqual(
      parseWebSourceMarkerValue(
        'web_3="drift rate, not the code",web_5, web_7 = “curly words”',
      ),
      {
        ids: ["web_3", "web_5", "web_7"],
        phrases: { web_3: "drift rate, not the code", web_7: "curly words" },
      },
    );
    assert.deepEqual(parseWebSourceMarkerValue("web_3,web_5"), {
      ids: ["web_3", "web_5"],
      phrases: {},
    });
  });

  it("keeps a paragraph marker's exact words on its anchor and out of the text", function () {
    const a = assessWebAttribution(
      'Drift continues even in a constant setting.<!--llm-web-source:web_3="does not detectably change drift rate",web_5-->',
      [webSearch],
    );
    assert.equal(a.status, "valid");
    if (a.status !== "valid") return;
    assert.equal(a.cleanText, "Drift continues even in a constant setting.");
    assert.lengthOf(a.anchors, 1);
    assert.deepEqual(
      a.anchors[0].sources.map((source) => source.sourceId),
      ["web_3", "web_5"],
    );
    assert.deepEqual(a.anchors[0].phrases, {
      web_3: "does not detectably change drift rate",
    });
  });

  it("takes a paper link's title as its exact words", function () {
    const a = assessWebAttribution(
      'The strongest test is [Arden et al. (2025)](https://doi.org/10.1101/2025.01.01.000001 "drift is intrinsic to the hippocampus"), who held behavior constant.',
      [paperSearch],
    );
    assert.equal(a.status, "valid");
    if (a.status !== "valid") return;
    assert.equal(
      a.cleanText,
      "The strongest test is Arden et al. (2025), who held behavior constant.",
    );
    assert.deepEqual(a.anchors[0].phrases, {
      [ardenId]: "drift is intrinsic to the hippocampus",
    });
  });

  it("shows a linked source once when the line's end marker repeats it for its words", function () {
    const earlierWeb = webSearch;
    const a = assessWebAttribution(
      'See [the overview](https://en.wikipedia.org/wiki/Representational_drift) for more.<!--llm-web-source:web_3="gradual change in neural representations"-->',
      [earlierWeb],
    );
    assert.equal(a.status, "valid");
    if (a.status !== "valid") return;
    assert.lengthOf(a.anchors, 1);
    assert.equal(a.anchors[0].placement, "inline");
    assert.deepEqual(a.anchors[0].phrases, {
      web_3: "gradual change in neural representations",
    });
  });

  it("hides a marker with exact words while it streams and once complete", function () {
    assert.equal(
      stripWebSourceMarkersForDisplay(
        'Done.<!--llm-web-source:web_3="some words"-->',
      ),
      "Done.",
    );
    assert.equal(
      stripWebSourceMarkersForDisplay('Done.<!--llm-web-source:web_3="some wo'),
      "Done.",
    );
  });
});
