import { assert } from "chai";
import { renderMarkdown, renderMarkdownForNote } from "../src/utils/markdown";
import {
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_SANDBOX,
  buildHtmlPreviewSrcdoc,
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
    let capture: unknown = null;
    let removedSrcdoc = false;
    let replaced: [unknown, unknown] | null = null;
    const parent = {
      replaceChild(next: unknown, old: unknown) {
        replaced = [next, old];
      },
    };
    const frame = {
      parentNode: parent,
      contentDocument: { URL: "about:srcdoc" },
      addEventListener(
        type: string,
        fn: () => void,
        options?: { capture?: boolean },
      ) {
        if (type === "load") {
          handler = fn;
          capture = options?.capture;
        }
      },
      removeEventListener() {},
      removeAttribute(name: string) {
        if (name === "srcdoc") removedSrcdoc = true;
      },
    } as unknown as HTMLIFrameElement & { contentDocument: { URL: string } };
    const note = { setAttribute() {}, textContent: "" };
    const fakeDoc = {
      createElementNS: () => note,
    } as unknown as Document;

    const onLoad = guardHtmlPreviewNavigation(fakeDoc, frame);
    assert.strictEqual(onLoad, handler);
    // Zotero's chrome windows deliver a frame's load only to capture listeners.
    assert.isTrue(capture);
    onLoad();
    assert.isNull(replaced, "the first load is the srcdoc itself");
    onLoad();
    assert.isNull(replaced, "a move in the chat reloads the srcdoc");
    frame.contentDocument.URL = "https://example.com/";
    onLoad();
    assert.isTrue(removedSrcdoc);
    assert.deepEqual(replaced, [note, frame]);
    assert.strictEqual(note.textContent, HTML_PREVIEW_STOPPED_TEXT);
  });
});

describe("chat HTML preview sized to its page", function () {
  it("adds only a margin sheet after the CSP, before the page", function () {
    const srcdoc = buildHtmlPreviewSrcdoc("<p>x</p>", undefined, {});
    assert.strictEqual(
      srcdoc,
      `${EXACT_CSP_META}<style>body{margin:12px 14px}</style><p>x</p>`,
    );
    assert.notInclude(srcdoc, "<script");
  });

  it("adds nothing without fit", function () {
    assert.strictEqual(
      buildHtmlPreviewSrcdoc("<p>x</p>"),
      `${EXACT_CSP_META}<p>x</p>`,
    );
  });

  type Listener = () => void;

  function fakeFrameSetup(font?: string, background?: string) {
    const loadListeners: Listener[] = [];
    const timers: Listener[] = [];
    let pageHeight = 180.2;
    let observed: Listener | null = null;
    const inserted: Array<{ textContent: string }> = [];
    const head = {
      firstChild: null,
      insertBefore(node: { textContent: string }) {
        inserted.push(node);
      },
    };
    const page = {
      URL: "about:srcdoc",
      head,
      body: null,
      documentElement: {
        getBoundingClientRect: () => ({ height: pageHeight }),
      },
      createElement: () => ({ textContent: "" }),
    };
    const pageWindow = {
      ResizeObserver: class {
        constructor(callback: Listener) {
          observed = callback;
        }
        observe() {}
      },
    };
    const style: Record<string, string> = {};
    const frame = {
      contentDocument: page,
      contentWindow: pageWindow,
      style,
      setAttribute() {},
      addEventListener(
        type: string,
        fn: Listener,
        options?: { capture?: boolean },
      ) {
        if (type === "load" && options?.capture) loadListeners.push(fn);
      },
      removeEventListener() {},
    };
    const fakeDoc = {
      createElementNS: () => frame,
      defaultView: {
        setTimeout(fn: Listener) {
          timers.push(fn);
        },
      },
    } as unknown as Document;
    const heights: number[] = [];
    createSandboxedHtmlFrame(fakeDoc, "<p>x</p>", undefined, undefined, {
      readFont: () => font,
      readBackground: () => background,
      onHeight: (h) => heights.push(h),
    });
    return {
      load: () => loadListeners[0](),
      resize: (height: number) => {
        pageHeight = height;
        observed?.();
      },
      runTimers: () => timers.forEach((fn) => fn()),
      style,
      heights,
      inserted,
      hasObserver: () => observed !== null,
    };
  }

  it("measures the page itself when it loads and follows its layout", function () {
    const setup = fakeFrameSetup();
    assert.isUndefined(setup.style.height);
    setup.load();
    assert.strictEqual(setup.style.height, "181px");
    assert.isTrue(setup.hasObserver());
    setup.resize(260);
    assert.strictEqual(setup.style.height, "260px");
    setup.resize(1e9);
    assert.strictEqual(setup.style.height, `${HTML_PREVIEW_MAX_FIT_HEIGHT}px`);
    setup.runTimers();
    assert.deepEqual(setup.heights, [181, 260, HTML_PREVIEW_MAX_FIT_HEIGHT]);
  });

  it("puts the chat font ahead of the page's own styles", function () {
    const setup = fakeFrameSetup('16px/24px -apple-system, "Segoe UI"');
    setup.load();
    assert.deepEqual(
      setup.inserted.map((node) => node.textContent),
      ['html{font:16px/24px -apple-system, "Segoe UI"}'],
    );
  });

  it("gives a themed page the chat's background as --llm-bg", function () {
    const setup = fakeFrameSetup(undefined, "rgb(48, 48, 48)");
    setup.load();
    assert.deepEqual(
      setup.inserted.map((node) => node.textContent),
      ["html:root{--llm-bg:rgb(48, 48, 48)}"],
    );
  });

  it("keeps a font value from adding rules", function () {
    const setup = fakeFrameSetup("16px serif}body{display:none");
    setup.load();
    assert.notInclude(setup.inserted[0].textContent, "}body{");
  });
});
