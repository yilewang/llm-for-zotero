import { assert } from "chai";
import {
  renderStreamingMarkdownInto,
  disposeStreamingMarkdown,
} from "../src/modules/contextPanel/streamingMarkdown";
import { renderRenderedMarkdownInto } from "../src/modules/contextPanel/renderedMarkdown";

describe("workflow: incremental Markdown presentation", function () {
  this.timeout(30000);
  it("retains completed blocks, handles rollback, and resolves the canonical final Markdown", async function () {
    const doc = Zotero.getMainWindow().document;
    const host = doc.createElement("div") as HTMLElement;
    doc.documentElement.appendChild(host);
    const source = "# Review\n\nFirst paragraph.\n\nSecond paragraph.";
    try {
      renderStreamingMarkdownInto(host, source, doc, () => {});
      await Zotero.Promise.delay(120);
      const first = host.querySelector("h1, h2, h3, h4");
      assert.exists(first, host.innerHTML);
      renderStreamingMarkdownInto(
        host,
        `${source} More evidence.\n\n- A\n- B`,
        doc,
        () => {},
      );
      await Zotero.Promise.delay(120);
      assert.strictEqual(host.querySelector("h1, h2, h3, h4"), first);
      assert.include(host.textContent || "", "More evidence.");
      assert.lengthOf(host.querySelectorAll("li"), 2);
      const final =
        "# Revised\n\nA [source][ref].\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[ref]: https://example.org/paper";
      renderStreamingMarkdownInto(host, final, doc, () => {});
      await Zotero.Promise.delay(120);
      assert.notInclude(host.textContent || "", "First paragraph");
      disposeStreamingMarkdown(host);
      renderRenderedMarkdownInto(host, final, doc);
      assert.equal(
        host.querySelector("a")?.getAttribute("href"),
        "https://example.org/paper",
      );
      assert.exists(host.querySelector("table"));
      assert.equal(
        host.querySelector("h1, h2, h3, h4")?.textContent,
        "Revised",
      );
    } finally {
      disposeStreamingMarkdown(host);
      host.remove();
    }
  });

  it("discards queued work when its view is disposed", async function () {
    const doc = Zotero.getMainWindow().document;
    const host = doc.createElement("div") as HTMLElement;
    doc.documentElement.appendChild(host);
    try {
      renderStreamingMarkdownInto(host, "Queued **text**", doc, () => {});
      disposeStreamingMarkdown(host);
      host.textContent = "New view";
      await Zotero.Promise.delay(120);
      assert.equal(host.textContent, "New view");
    } finally {
      host.remove();
    }
  });
});
