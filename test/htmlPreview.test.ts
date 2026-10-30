import { assert } from "chai";
import { renderMarkdown, renderMarkdownForNote } from "../src/utils/markdown";
import {
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_SANDBOX,
  buildHtmlPreviewSrcdoc,
  HTML_PREVIEW_HEIGHT_KEY,
  HTML_PREVIEW_HEIGHT_SCRIPT,
  HTML_PREVIEW_MAX_FIT_HEIGHT,
  HTML_PREVIEW_STOPPED_TEXT,
  createSandboxedHtmlFrame,
  guardHtmlPreviewNavigation,
} from "../src/modules/contextPanel/htmlPreviewFrame";

const EXACT_CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:">`;

describe("HTML fence preview", function () {
  const source = `<p title="a&b">x > y</p>\n<script>alert("hi")</script>`;
  const complete = ["```html", source, "```"].join("\n");

  it("emits an escaped preview box for a complete html fence", function () {
    const html = renderMarkdown(complete);
    assert.include(html, 'class="llm-html-preview"');
    assert.include(
      html,
      'data-llm-html-source="&lt;p title=&quot;a&amp;b&quot;&gt;x &gt; y&lt;/p&gt;&#10;&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt;"',
    );
    assert.notInclude(html, "<script>");
    assert.notInclude(html, '<p title="a&b">');
    assert.isBelow(
      html.indexOf("llm-html-preview"),
      html.indexOf("llm-codeblock-body"),
    );
  });

  it("accepts the htm alias", function () {
    const html = renderMarkdown(["```htm", "<b>x</b>", "```"].join("\n"));
    assert.include(html, 'class="llm-html-preview"');
  });

  it("renders code only while the fence is still open", function () {
    const html = renderMarkdown(["```html", source].join("\n"));
    assert.include(html, "llm-codeblock-body");
    assert.notInclude(html, "llm-html-preview");
  });

  it("adds no preview in Zotero note rendering", function () {
    assert.notInclude(renderMarkdownForNote(complete), "llm-html-preview");
  });

  it("leaves other fences unchanged", function () {
    const html = renderMarkdown(
      ["```js", "const a = '<b>';", "```"].join("\n"),
    );
    assert.notInclude(html, "llm-html-preview");
  });
});

describe("sandboxed HTML preview frame", function () {
  it("uses the exact sandbox and CSP", function () {
    assert.strictEqual(HTML_PREVIEW_SANDBOX, "allow-scripts");
    assert.strictEqual(
      HTML_PREVIEW_CSP,
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:",
    );
  });

  it("puts the CSP meta first in the srcdoc", function () {
    assert.strictEqual(
      buildHtmlPreviewSrcdoc("<p>x</p><script>1</script>"),
      `${EXACT_CSP_META}<p>x</p><script>1</script>`,
    );
  });

  it("keeps a leading doctype, html and head ahead of the CSP meta", function () {
    assert.strictEqual(
      buildHtmlPreviewSrcdoc("<!doctype html><p>x</p>"),
      `<!doctype html>${EXACT_CSP_META}<p>x</p>`,
    );
    assert.strictEqual(
      buildHtmlPreviewSrcdoc(
        '<!DOCTYPE html>\n<html lang="en">\n<head>\n<script>1</script></head>',
      ),
      `<!DOCTYPE html>\n<html lang="en">\n<head>${EXACT_CSP_META}\n<script>1</script></head>`,
    );
    // A <header> element is not <head>; the meta goes before it.
    assert.strictEqual(
      buildHtmlPreviewSrcdoc("<header>x</header>"),
      `${EXACT_CSP_META}<header>x</header>`,
    );
  });

  it("sets the sandbox before srcdoc on an XHTML iframe", function () {
    const calls: Array<[string, string]> = [];
    let created: [string, string] | null = null;
    const fakeDoc = {
      createElementNS(ns: string, tag: string) {
        created = [ns, tag];
        return {
          setAttribute(name: string, value: string) {
            calls.push([name, value]);
          },
          addEventListener() {},
        };
      },
    } as unknown as Document;

    createSandboxedHtmlFrame(fakeDoc, "<p>x</p>");

    assert.deepEqual(created, ["http://www.w3.org/1999/xhtml", "iframe"]);
    const attrs = new Map(calls);
    assert.strictEqual(attrs.get("sandbox"), "allow-scripts");
    assert.strictEqual(attrs.get("referrerpolicy"), "no-referrer");
    assert.strictEqual(attrs.get("srcdoc"), `${EXACT_CSP_META}<p>x</p>`);
    const names = calls.map(([name]) => name);
    assert.isBelow(names.indexOf("sandbox"), names.indexOf("srcdoc"));
    assert.strictEqual(names.filter((n) => n === "sandbox").length, 1);
  });

  it("replaces the frame with a note when the page navigates away", function () {
    let handler: (() => void) | null = null;
    let removedSrcdoc = false;
    let replaced: [unknown, unknown] | null = null;
    const parent = {
      replaceChild(next: unknown, old: unknown) {
        replaced = [next, old];
      },
    };
    const frame = {
      parentNode: parent,
      addEventListener(type: string, fn: () => void) {
        if (type === "load") handler = fn;
      },
      removeEventListener() {},
      removeAttribute(name: string) {
        if (name === "srcdoc") removedSrcdoc = true;
      },
    } as unknown as HTMLIFrameElement;
    const note = { setAttribute() {}, textContent: "" };
    const fakeDoc = {
      createElementNS: () => note,
    } as unknown as Document;

    const onLoad = guardHtmlPreviewNavigation(fakeDoc, frame);
    assert.strictEqual(onLoad, handler);
    onLoad();
    assert.isNull(replaced, "the first load is the srcdoc itself");
    onLoad();
    assert.isTrue(removedSrcdoc);
    assert.deepEqual(replaced, [note, frame]);
    assert.strictEqual(note.textContent, HTML_PREVIEW_STOPPED_TEXT);
  });
});

describe("chat HTML preview sized to its page", function () {
  it("adds the chat font and the height report after the CSP, before the page", function () {
    const srcdoc = buildHtmlPreviewSrcdoc("<p>x</p>", undefined, {
      font: '16px/24px -apple-system, "Segoe UI"',
    });
    assert.isTrue(srcdoc.startsWith(EXACT_CSP_META));
    assert.include(
      srcdoc,
      '<style>html{font:16px/24px -apple-system, "Segoe UI"}body{margin:12px 14px}</style>',
    );
    assert.include(srcdoc, HTML_PREVIEW_HEIGHT_SCRIPT);
    assert.isTrue(srcdoc.endsWith(`${HTML_PREVIEW_HEIGHT_SCRIPT}<p>x</p>`));
  });

  it("keeps a font value from closing the sheet", function () {
    const srcdoc = buildHtmlPreviewSrcdoc("<p>x</p>", undefined, {
      font: "16px serif}</style><script>alert(1)</script>",
    });
    assert.notInclude(srcdoc, "alert(1)</script>");
    assert.notInclude(srcdoc, "serif}");
  });

  it("adds nothing without fit", function () {
    assert.strictEqual(
      buildHtmlPreviewSrcdoc("<p>x</p>"),
      `${EXACT_CSP_META}<p>x</p>`,
    );
  });

  it("reads only a height number from its own frame", function () {
    let onMessage: ((event: unknown) => void) | null = null;
    const ownWindow = {};
    const style: Record<string, string> = {};
    const frame = {
      contentWindow: ownWindow,
      isConnected: true,
      style,
      setAttribute() {},
      addEventListener() {},
    };
    const fakeDoc = {
      createElementNS: () => frame,
      defaultView: {
        addEventListener(type: string, fn: (event: unknown) => void) {
          if (type === "message") onMessage = fn;
        },
        removeEventListener() {},
      },
    } as unknown as Document;
    const heights: number[] = [];
    createSandboxedHtmlFrame(fakeDoc, "<p>x</p>", undefined, undefined, {
      onHeight: (h) => heights.push(h),
    });
    assert.isNotNull(onMessage);
    const send = (source: unknown, data: unknown) =>
      onMessage!({ source, data });

    send({}, { [HTML_PREVIEW_HEIGHT_KEY]: 200 });
    send(ownWindow, { [HTML_PREVIEW_HEIGHT_KEY]: "200" });
    send(ownWindow, { [HTML_PREVIEW_HEIGHT_KEY]: Number.NaN });
    send(ownWindow, "200");
    assert.deepEqual(heights, []);
    assert.isUndefined(style.height);

    send(ownWindow, { [HTML_PREVIEW_HEIGHT_KEY]: 180.2 });
    assert.strictEqual(style.height, "181px");
    send(ownWindow, { [HTML_PREVIEW_HEIGHT_KEY]: 1e9 });
    assert.strictEqual(style.height, `${HTML_PREVIEW_MAX_FIT_HEIGHT}px`);
    assert.deepEqual(heights, [181, HTML_PREVIEW_MAX_FIT_HEIGHT]);
  });
});
