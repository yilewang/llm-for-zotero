import { assert } from "chai";
import {
  looseWebUrlKey,
  translateWebSourceLinks,
} from "../src/webAccess/sourceLinks";
import type { WebSourceDisplay } from "../src/webAccess/types";

describe("web source links", function () {
  function display(sourceId: string, url: string): WebSourceDisplay {
    const hostname = new URL(url).hostname;
    return {
      sourceId,
      url,
      hostname,
      organization: hostname,
      title: hostname,
    };
  }
  const sources = new Map<string, WebSourceDisplay>([
    ["web_1", display("web_1", "https://sharing.nih.gov/dms")],
    ["web_2", display("web_2", "https://example.org/releases")],
  ]);
  const M = (ids: string) => `<!--llm-web-source:${ids}-->`;

  it("turns a markdown link to a found page into its text plus a marker", function () {
    assert.equal(
      translateWebSourceLinks(
        "The [NIH policy](https://sharing.nih.gov/dms) took effect.",
        sources,
      ),
      `The NIH policy took effect.${M("web_1")}`,
    );
  });

  it("matches across http/https, www, trailing slash and utm parameters", function () {
    assert.equal(
      looseWebUrlKey("http://www.sharing.nih.gov/dms/?utm_source=x"),
      looseWebUrlKey("https://sharing.nih.gov/dms"),
    );
    assert.equal(
      looseWebUrlKey("https://Example.org/a?b=1&utm_medium=y&c=2#part"),
      "example.org/a?b=1&c=2",
    );
    assert.isUndefined(looseWebUrlKey("not a url"));
    assert.equal(
      translateWebSourceLinks(
        "The [policy](http://www.sharing.nih.gov/dms/?utm_source=x) applies.",
        sources,
      ),
      `The policy applies.${M("web_1")}`,
    );
  });

  it("removes a bare or angle-bracket URL to a found page", function () {
    assert.equal(
      translateWebSourceLinks("See (https://sharing.nih.gov/dms).", sources),
      `See.${M("web_1")}`,
    );
    assert.equal(
      translateWebSourceLinks("See <https://sharing.nih.gov/dms>.", sources),
      `See.${M("web_1")}`,
    );
    assert.equal(
      translateWebSourceLinks(
        "Read [https://sharing.nih.gov/dms](https://sharing.nih.gov/dms) now.",
        sources,
      ),
      `Read now.${M("web_1")}`,
    );
  });

  it("leaves links to pages not found in this run unchanged", function () {
    const text =
      "See [other](https://other.example/page), <https://other.example/x> and https://other.example/y.";
    assert.equal(translateWebSourceLinks(text, sources), text);
  });

  it("leaves links in fenced code, inline code and table rows unchanged", function () {
    const text = [
      "```",
      "[policy](https://sharing.nih.gov/dms)",
      "```",
      "",
      "Use `https://sharing.nih.gov/dms` as the base.",
      "",
      "| Name | Link |",
      "|---|---|",
      "| NIH | [policy](https://sharing.nih.gov/dms) |",
    ].join("\n");
    assert.equal(translateWebSourceLinks(text, sources), text);
  });

  it("leaves reference-style links unchanged", function () {
    const text = "The [policy][1] applies.\n\n[1]: https://sharing.nih.gov/dms";
    assert.equal(translateWebSourceLinks(text, sources), text);
  });

  it("puts the marker at the end of a compact list item", function () {
    const result = translateWebSourceLinks(
      "- [A](https://sharing.nih.gov/dms)\n- B",
      sources,
    );
    assert.equal(result, `- A${M("web_1")}\n- B`);
    assert.equal(result.split("\n").length, 2);
  });

  it("lists IDs in link order without duplicates", function () {
    assert.equal(
      translateWebSourceLinks(
        "Both https://example.org/releases and [NIH](https://sharing.nih.gov/dms) and [again](https://example.org/releases/).",
        sources,
      ),
      `Both and NIH and again.${M("web_2,web_1")}`,
    );
  });

  it("keeps a bare URL that is the whole list item text", function () {
    const bullets = translateWebSourceLinks(
      "Sources:\n- https://sharing.nih.gov/dms\n- https://example.org/page",
      sources,
    );
    assert.equal(
      bullets,
      `Sources:\n- https://sharing.nih.gov/dms${M("web_1")}\n- https://example.org/page`,
    );
    assert.equal(
      translateWebSourceLinks("1. https://sharing.nih.gov/dms", sources),
      `1. https://sharing.nih.gov/dms${M("web_1")}`,
    );
    assert.equal(
      translateWebSourceLinks("- <https://sharing.nih.gov/dms>", sources),
      `- <https://sharing.nih.gov/dms>${M("web_1")}`,
    );
  });

  it("leaves link syntax it does not parse as written, without a marker", function () {
    for (const text of [
      "Look![chart](https://sharing.nih.gov/dms) here.",
      "See [NIH](https://sharing.nih.gov/dms 'title') now.",
      "See [NIH [2023]](https://sharing.nih.gov/dms) now.",
    ]) {
      assert.equal(translateWebSourceLinks(text, sources), text);
    }
  });

  it("keeps a link whose text is its own URL when removal would empty the item", function () {
    const result = translateWebSourceLinks(
      "- [https://sharing.nih.gov/dms](https://sharing.nih.gov/dms)\n- B",
      sources,
    );
    assert.equal(
      result,
      `- [https://sharing.nih.gov/dms](https://sharing.nih.gov/dms)${M("web_1")}\n- B`,
    );
  });
});
