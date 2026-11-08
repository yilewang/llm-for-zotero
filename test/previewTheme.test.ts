import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { buildSafeSvgMarkup, renderMarkdown } from "../src/utils/markdown";
import {
  PREVIEW_COLOR_INSTRUCTION,
  PREVIEW_COLOR_NAMES,
  PREVIEW_SURFACE_ATTRIBUTE,
  applySvgPreviewTheme,
  buildHtmlPreviewThemeSheet,
  buildSvgExportMarkup,
  buildSvgPreviewThemeCss,
  needsPreviewThemeSheet,
  previewSurfaceFor,
  previewThemeFor,
  usesPreviewTheme,
} from "../src/utils/previewTheme";
import { RESEARCH_RESPONSE_FORMAT_GUIDANCE } from "../src/shared/instructionContracts";
import { buildAgentFilesInstruction } from "../src/utils/agentFilesDirectory";
import {
  HTML_PREVIEW_CSP_META,
  buildHtmlPreviewSrcdoc,
  createSandboxedHtmlFrame,
} from "../src/modules/contextPanel/htmlPreviewFrame";
import { replaceVisualFigureFencesWithNoteImages } from "../src/modules/contextPanel/figureExport";

const here = dirname(fileURLToPath(import.meta.url));
const paneCss = () =>
  readFileSync(resolve(here, "../addon/content/zoteroPane.css"), "utf8");

/** Every rule whose selector list names `needle`, as "selector { body }". */
function rulesNaming(css: string, needle: string): string[] {
  const out: string[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    const selector = match[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (selector.includes(needle)) out.push(`${selector} {${match[2]}}`);
  }
  return out;
}

const WAYNE_SVG = [
  "```svg",
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">',
  '  <text x="10" y="20" fill="#111">Drawing</text>',
  '  <path d="M10 80 C60 10 140 10 190 80" stroke="#1e3a8a" fill="none"/>',
  "</svg>",
  "```",
].join("\n");

const THEMED_SVG = [
  "```svg",
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">',
  '  <text x="10" y="20">Drawing</text>',
  '  <path d="M10 80 L190 80" style="stroke:var(--llm-blue)" fill="none"/>',
  "</svg>",
  "```",
].join("\n");

describe("preview theme detection", function () {
  it("calls a source themed only when it uses a named color", function () {
    assert.isTrue(usesPreviewTheme('<path style="stroke:var(--llm-blue)"/>'));
    assert.isTrue(usesPreviewTheme("p{color:var( --llm-text )}"));
    assert.isFalse(usesPreviewTheme('<path stroke="#1e3a8a"/>'));
    assert.isFalse(usesPreviewTheme('<path stroke="currentColor"/>'));
    assert.isFalse(usesPreviewTheme("p{color:var(--fg)}"));
    assert.isFalse(usesPreviewTheme(""));
  });

  it("calls a source that declares a named color itself paper", function () {
    assert.isFalse(
      usesPreviewTheme(":root{--llm-text:#111} p{color:var(--llm-text)}"),
    );
    assert.equal(
      previewSurfaceFor(
        "<style>:root{--llm-blue: navy}</style>var(--llm-blue)",
      ),
      "paper",
    );
    assert.equal(previewSurfaceFor("color:var(--llm-red)"), "themed");
  });

  it("opens a paper source in the light viewer in every theme", function () {
    assert.equal(previewThemeFor('<path stroke="#111"/>', "dark"), "light");
    assert.equal(previewThemeFor('<path stroke="#111"/>', "light"), "light");
    assert.equal(previewThemeFor("stroke:var(--llm-blue)", "dark"), "dark");
    assert.equal(previewThemeFor("stroke:var(--llm-blue)", "light"), "light");
  });
});

describe("preview surface markers", function () {
  it("marks a drawing with fixed colors as paper", function () {
    const html = renderMarkdown(WAYNE_SVG);
    assert.match(
      html,
      new RegExp(
        `class="llm-svg-preview" ${PREVIEW_SURFACE_ATTRIBUTE}="paper"`,
      ),
    );
  });

  it("marks a drawing that uses the named colors as themed", function () {
    const html = renderMarkdown(THEMED_SVG);
    assert.include(html, `${PREVIEW_SURFACE_ATTRIBUTE}="themed"`);
    assert.notInclude(html, `${PREVIEW_SURFACE_ATTRIBUTE}="paper"`);
  });

  it("marks web pages by the same rule", function () {
    const paper = renderMarkdown(
      ["```html", '<p style="color:#333">x</p>', "```"].join("\n"),
    );
    assert.match(
      paper,
      new RegExp(
        `class="llm-html-preview" ${PREVIEW_SURFACE_ATTRIBUTE}="paper"`,
      ),
    );
    const themed = renderMarkdown(
      ["```html", '<p style="color:var(--llm-text)">x</p>', "```"].join("\n"),
    );
    assert.include(themed, `${PREVIEW_SURFACE_ATTRIBUTE}="themed"`);
  });
});

describe("paper card CSS", function () {
  const PAPER = `[${PREVIEW_SURFACE_ATTRIBUTE}="paper"]`;

  it("paints paper drawings and pages white in the bubble style", function () {
    const css = paneCss();
    for (const kind of ["llm-svg-preview", "llm-html-preview"]) {
      const rules = rulesNaming(css, `.llm-rendered-markdown .${kind}${PAPER}`);
      assert.isNotEmpty(rules, `${kind} has a bubble paper rule`);
      const body = rules.join("\n");
      assert.include(body, "--llm-mermaid-canvas-bg: #ffffff");
      assert.include(body, "color-scheme: light");
    }
  });

  it("gives the flat drawing a white card with the flat page's border and radius", function () {
    const css = paneCss();
    const rules = rulesNaming(css, `> .llm-svg-preview${PAPER}`).join("\n");
    assert.include(rules, ".llm-content-flat");
    assert.include(rules, "background: #ffffff");
    assert.include(rules, "border-radius: 10px");
    assert.include(
      rules,
      "border: 1px solid color-mix(in srgb, var(--stroke-secondary) 75%, transparent)",
    );
    assert.include(rules, "padding: 10px 12px");
  });

  it("gives the flat page a white card", function () {
    const css = paneCss();
    const rules = rulesNaming(css, `> .llm-html-preview${PAPER}`).join("\n");
    assert.include(rules, ".llm-content-flat");
    assert.include(rules, "background: #ffffff");
    assert.include(rules, "--llm-mermaid-canvas-bg: #ffffff");
  });

  it("keeps a saved drawing file on white", function () {
    const css = paneCss();
    const rules = rulesNaming(css, '[data-llm-image-kind="svg"]').join("\n");
    assert.include(rules, ".llm-saved-file-image");
    assert.include(rules, ".llm-saved-file-preview-image");
    assert.include(rules, "background: #ffffff");
  });
});

function decodeDataUri(uri: string): string {
  const base64 = uri.replace(/^data:image\/svg\+xml;base64,/, "");
  return new TextDecoder().decode(
    Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
  );
}

function namesDeclared(css: string): string[] {
  return Array.from(css.matchAll(/--llm-([a-z]+)\s*:/g), (m) => m[1]);
}

describe("preview color sheet", function () {
  it("gives every named color a light and a dark value", function () {
    for (const theme of ["light", "dark"] as const) {
      assert.sameOrderedMembers(namesDeclared(buildSvgPreviewThemeCss(theme)), [
        ...PREVIEW_COLOR_NAMES,
      ]);
      assert.sameOrderedMembers(
        namesDeclared(buildHtmlPreviewThemeSheet(theme, "themed")),
        [...PREVIEW_COLOR_NAMES],
      );
    }
    assert.notEqual(
      buildSvgPreviewThemeCss("light"),
      buildSvgPreviewThemeCss("dark"),
    );
  });

  it("scopes the drawing sheet to the themed drawing and keeps the model's fills", function () {
    const css = buildSvgPreviewThemeCss("dark");
    assert.include(css, 'svg[data-llm-theme="dark"]{color-scheme:dark;');
    assert.include(css, "color:var(--llm-text)");
    assert.include(
      css,
      'svg[data-llm-theme="dark"]:not([fill]){fill:currentColor}',
    );
    assert.notMatch(css, /(?:^|})\s*(?::root|text|path|\*)\s*[{,]/);
    assert.notInclude(css, "stroke:");
  });

  it("puts the sheet inside the drawing, before the model's content", function () {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text style="fill:var(--llm-red)">a</text></svg>';
    const themed = applySvgPreviewTheme(svg, "dark");
    assert.match(
      themed,
      /^<svg data-llm-theme="dark" xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 10 10"><style>svg\[data-llm-theme="dark"\]/,
    );
    assert.isBelow(themed.indexOf("</style>"), themed.indexOf("<text"));
    assert.include(themed, '<text style="fill:var(--llm-red)">a</text></svg>');
    // Still a safe drawing.
    assert.equal(buildSafeSvgMarkup(themed), themed);
    // A self-closing drawing has no content to color.
    assert.equal(applySvgPreviewTheme("<svg/>", "dark"), "<svg/>");
  });

  it("exports a drawing with the light sheet on white", function () {
    const themed = buildSvgExportMarkup(
      '<svg viewBox="0 0 1 1" style="opacity:1"><path style="stroke:var(--llm-blue)"/></svg>',
    );
    assert.include(themed, 'data-llm-theme="light"');
    assert.include(themed, 'style="background:#ffffff;opacity:1"');
    const paper = buildSvgExportMarkup(
      '<svg viewBox="0 0 1 1"><path stroke="#111"/></svg>',
    );
    assert.notInclude(paper, "data-llm-theme");
    assert.include(paper, '<svg style="background:#ffffff" viewBox="0 0 1 1">');
  });

  it("keeps the HTML sheet minimal for a paper page", function () {
    assert.equal(
      buildHtmlPreviewThemeSheet("light", "paper"),
      "<style>:root{color-scheme:light}</style>",
    );
    const dark = buildHtmlPreviewThemeSheet("dark", "themed");
    assert.match(dark, /^<style>:root\{color-scheme:dark;--llm-text:/);
    assert.include(dark, "color:var(--llm-text)");
  });
});

describe("themed preview rendering", function () {
  it("emits a themed drawing with the light sheet and records its theme", function () {
    const html = renderMarkdown(THEMED_SVG);
    assert.include(html, 'data-llm-preview-theme="light"');
    const src = html.match(/<img src="([^"]+)"/)?.[1] || "";
    const svg = decodeDataUri(src);
    assert.include(svg, 'data-llm-theme="light"');
    assert.include(svg, '<style>svg[data-llm-theme="light"]');
    // The source the other surfaces read stays the model's own.
    assert.notInclude(
      html.match(/data-llm-svg-source="([^"]*)"/)?.[1] || "",
      "data-llm-theme",
    );
  });

  it("leaves a paper drawing as the model wrote it", function () {
    const html = renderMarkdown(WAYNE_SVG);
    const src = html.match(/<img src="([^"]+)"/)?.[1] || "";
    assert.notInclude(decodeDataUri(src), "data-llm-theme");
    assert.notInclude(html, "data-llm-preview-theme");
  });
});

describe("HTML preview theme sheet", function () {
  it("keeps the CSP first and puts the sheet before the model's markup", function () {
    const source =
      "<!DOCTYPE html><html><head><style>p{color:var(--llm-text)}</style></head><body><script>1</script></body></html>";
    const srcdoc = buildHtmlPreviewSrcdoc(source, "dark");
    const sheet = buildHtmlPreviewThemeSheet("dark", "themed");
    assert.strictEqual(
      srcdoc,
      `<!DOCTYPE html><html><head>${HTML_PREVIEW_CSP_META}${sheet}<style>p{color:var(--llm-text)}</style></head><body><script>1</script></body></html>`,
    );
    const paper = buildHtmlPreviewSrcdoc('<p style="color:#333">x</p>', "dark");
    assert.strictEqual(
      paper,
      `${HTML_PREVIEW_CSP_META}<style>:root{color-scheme:light}</style><p style="color:#333">x</p>`,
    );
  });

  it("marks the frame with its surface and theme before srcdoc, after the sandbox", function () {
    const calls: Array<[string, string]> = [];
    const fakeDoc = {
      createElementNS() {
        return {
          setAttribute(name: string, value: string) {
            calls.push([name, value]);
          },
          addEventListener() {},
        };
      },
    } as unknown as Document;
    createSandboxedHtmlFrame(
      fakeDoc,
      '<p style="color:var(--llm-text)">x</p>',
      "f",
      "dark",
    );
    const attrs = new Map(calls);
    assert.equal(attrs.get(PREVIEW_SURFACE_ATTRIBUTE), "themed");
    assert.equal(attrs.get("data-llm-preview-theme"), "dark");
    assert.include(
      attrs.get("srcdoc"),
      buildHtmlPreviewThemeSheet("dark", "themed"),
    );
    const names = calls.map(([name]) => name);
    assert.equal(names[0], "sandbox");
    assert.equal(names[names.length - 1], "srcdoc");
  });

  it("frames a paper page in the light theme even in dark", function () {
    const calls: Array<[string, string]> = [];
    const fakeDoc = {
      createElementNS() {
        return {
          setAttribute(name: string, value: string) {
            calls.push([name, value]);
          },
          addEventListener() {},
        };
      },
    } as unknown as Document;
    createSandboxedHtmlFrame(fakeDoc, "<p>x</p>", "f", "dark");
    const attrs = new Map(calls);
    assert.equal(attrs.get(PREVIEW_SURFACE_ATTRIBUTE), "paper");
    assert.equal(attrs.get("data-llm-preview-theme"), "light");
  });
});

describe("preview color prompt", function () {
  function promptNames(): string[] {
    const list =
      PREVIEW_COLOR_INSTRUCTION.match(/NAME = ([a-z, ]+) \(/)?.[1] || "";
    return list
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
  }

  it("names exactly the colors the sheet defines", function () {
    assert.sameOrderedMembers(promptNames(), [...PREVIEW_COLOR_NAMES]);
    assert.sameOrderedMembers(
      promptNames(),
      namesDeclared(buildSvgPreviewThemeCss("dark")),
    );
    assert.include(PREVIEW_COLOR_INSTRUCTION, "var(--llm-NAME)");
    assert.include(PREVIEW_COLOR_INSTRUCTION, 'style="stroke:var(--llm-blue)"');
    assert.isBelow(PREVIEW_COLOR_INSTRUCTION.length, 260);
  });

  it("sits in the response format and in the html page rule", function () {
    assert.include(
      RESEARCH_RESPONSE_FORMAT_GUIDANCE,
      PREVIEW_COLOR_INSTRUCTION,
    );
    const files = buildAgentFilesInstruction(null);
    const htmlLine =
      files.split("\n").find((line) => line.includes("```html")) || "";
    assert.include(htmlLine, PREVIEW_COLOR_INSTRUCTION);
  });
});

describe("drawing export", function () {
  it("puts a themed drawing in a note with the light sheet on white", async function () {
    const seen: string[] = [];
    await replaceVisualFigureFencesWithNoteImages(THEMED_SVG, 7, {
      doc: {} as Document,
      rasterizeSvgToPngBytes: async (_doc, markup) => {
        seen.push(markup);
        return new Uint8Array([1]);
      },
      importer: { importNoteImage: async () => ({ key: "K" }) } as never,
    });
    assert.lengthOf(seen, 1);
    assert.include(seen[0], 'data-llm-theme="light"');
    assert.include(seen[0], "background:#ffffff");
  });
});

describe("themed frame CSS", function () {
  it("lets a themed page show the dark full-view window through", function () {
    const rules = rulesNaming(
      paneCss(),
      `.llm-viewer-window-frame[${PREVIEW_SURFACE_ATTRIBUTE}="themed"]`,
    ).join("\n");
    assert.include(rules, "background: transparent");
  });
});

describe("theme swap of mounted previews", function () {
  type FakeEl = {
    dataset: Record<string, string>;
    attrs: Record<string, string>;
    closest: () => null;
    querySelector: (sel: string) => unknown;
    replaceChild?: (next: unknown, old: unknown) => void;
    getAttribute: (name: string) => string | null;
    setAttribute: (name: string, value: string) => void;
  };

  function el(
    dataset: Record<string, string>,
    children: Record<string, unknown> = {},
  ): FakeEl {
    const attrs: Record<string, string> = {};
    return {
      dataset,
      attrs,
      closest: () => null,
      querySelector: (sel: string) => children[sel] ?? null,
      getAttribute: (name: string) => attrs[name] ?? null,
      setAttribute: (name: string, value: string) => {
        attrs[name] = value;
      },
    };
  }

  function fakeDoc(dark: boolean) {
    const created: FakeEl[] = [];
    const doc = {
      defaultView: null,
      body: null,
      documentElement: {
        classList: { contains: (c: string) => dark && c === "window-is-dark" },
        hasAttribute: () => false,
      },
      createElementNS() {
        const frame = el({});
        (
          frame as unknown as { addEventListener: () => void }
        ).addEventListener = () => {};
        created.push(frame);
        return frame;
      },
    };
    return { doc: doc as unknown as Document, created };
  }

  const THEMED_SOURCE =
    '<svg xmlns="http://www.w3.org/2000/svg"><path style="stroke:var(--llm-blue)"/></svg>';
  const PAGE_SOURCE = '<p style="color:var(--llm-text)">x</p>';

  function fakeRoot(drawing: FakeEl, page: FakeEl) {
    return {
      querySelectorAll(sel: string) {
        if (sel.startsWith(".llm-svg-preview")) return [drawing];
        if (sel.startsWith(".llm-html-preview")) return [page];
        return [];
      },
    } as unknown as ParentNode;
  }

  it("recolors a drawing and rebuilds a page's frame when the theme changes", async function () {
    const { syncPreviewThemesForTests } =
      await import("../src/modules/contextPanel/renderedMarkdown");
    const picture = el({});
    const drawing = el(
      { llmSvgSource: THEMED_SOURCE, llmPreviewTheme: "light" },
      { img: picture },
    );
    const oldFrame = el({});
    oldFrame.attrs.class = "llm-html-preview-frame";
    let replaced: [unknown, unknown] | null = null;
    const page = el(
      {
        llmHtmlSource: PAGE_SOURCE,
        llmHtmlHydrated: "true",
        llmPreviewTheme: "light",
      },
      { ":scope > iframe": oldFrame },
    );
    page.replaceChild = (next, old) => {
      replaced = [next, old];
    };
    const root = fakeRoot(drawing, page);

    const light = fakeDoc(false);
    assert.isTrue(syncPreviewThemesForTests(root, light.doc));
    assert.isUndefined(picture.attrs.src, "same theme: nothing redrawn");
    assert.isNull(replaced);

    const dark = fakeDoc(true);
    assert.isTrue(syncPreviewThemesForTests(root, dark.doc));
    assert.equal(drawing.dataset.llmPreviewTheme, "dark");
    assert.include(decodeDataUri(picture.attrs.src), 'data-llm-theme="dark"');
    assert.equal(page.dataset.llmPreviewTheme, "dark");
    assert.lengthOf(dark.created, 1, "a new frame, never a second srcdoc");
    assert.deepEqual(replaced, [dark.created[0], oldFrame]);
    const frame = dark.created[0];
    assert.equal(frame.attrs.sandbox, "allow-scripts");
    assert.equal(frame.attrs.class, "llm-html-preview-frame");
    assert.equal(frame.attrs["data-llm-preview-theme"], "dark");
    assert.include(
      frame.attrs.srcdoc,
      buildHtmlPreviewThemeSheet("dark", "themed"),
    );
    assert.isTrue(frame.attrs.srcdoc.startsWith(HTML_PREVIEW_CSP_META));
    assert.isUndefined(oldFrame.attrs.srcdoc, "the old frame is not reloaded");
  });

  it("leaves a page that was stopped for leaving", async function () {
    const { syncPreviewThemesForTests } =
      await import("../src/modules/contextPanel/renderedMarkdown");
    const drawing = el({ llmSvgSource: "", llmPreviewTheme: "dark" });
    const page = el({
      llmHtmlSource: PAGE_SOURCE,
      llmHtmlHydrated: "true",
      llmPreviewTheme: "light",
    });
    const dark = fakeDoc(true);
    syncPreviewThemesForTests(fakeRoot(drawing, page), dark.doc);
    assert.lengthOf(dark.created, 0);
    assert.equal(page.dataset.llmPreviewTheme, "light");
  });
});

describe("preview theme edge cases", function () {
  const MIXED_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="white"/><text style="fill:var(--llm-text)">x</text></svg>';

  it("keeps a themed root with a '>' in an attribute well formed", function () {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" aria-label="A -> B"><path style="stroke:var(--llm-blue)" d="M0 0L9 9"/></svg>';
    for (const out of [
      applySvgPreviewTheme(svg, "dark"),
      buildSvgExportMarkup(svg),
    ]) {
      const root = out.match(/^<svg\b(?:"[^"]*"|'[^']*'|[^>"'])*>/);
      assert.isNotNull(root);
      assert.include(root![0], 'aria-label="A -> B"');
      assert.include(root![0], "data-llm-theme=");
      assert.equal(out.match(/<svg\b/g)!.length, 1);
      assert.include(out, "><style>svg[data-llm-theme");
    }
  });

  it("calls a source with a fixed white background paper, with the light sheet", function () {
    assert.isTrue(needsPreviewThemeSheet(MIXED_SVG));
    assert.equal(previewSurfaceFor(MIXED_SVG), "paper");
    assert.equal(previewThemeFor(MIXED_SVG, "dark"), "light");
    assert.isFalse(
      usesPreviewTheme("body{background:#fff} p{color:var(--llm-text)}"),
    );
    assert.include(buildSvgExportMarkup(MIXED_SVG), "--llm-text:#1f2937");
    const page = buildHtmlPreviewSrcdoc(
      "body{background:#ffffff}<p style='color:var(--llm-text)'>",
      "dark",
    );
    assert.include(page, "--llm-text:#1f2937");
    assert.notInclude(page, "--llm-text:#e5e7eb");
  });

  it("keeps a themed source themed and a plain fixed-color source sheetless", function () {
    const themed = '<rect fill="var(--llm-bg)"/><text fill="var(--llm-text)"/>';
    assert.equal(previewSurfaceFor(themed), "themed");
    const plain =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="white"/></svg>';
    assert.equal(previewSurfaceFor(plain), "paper");
    assert.isFalse(needsPreviewThemeSheet(plain));
    assert.notInclude(buildHtmlPreviewSrcdoc("<p>x</p>", "dark"), "--llm-text");
  });
});
