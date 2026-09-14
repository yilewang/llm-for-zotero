import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";

const here = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(here, "..", path), "utf8");
}

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`))?.[0] || "";
}

describe("standalone plan document window", function () {
  it("uses one canonical visible document title", function () {
    const windowSource = source(
      "src/modules/contextPanel/standalonePlanDocumentWindow.ts",
    );

    assert.include(windowSource, "/^h[1-6]$/.test(firstElement.localName)");
    assert.include(
      windowSource,
      'classList.add("llm-plan-document-window-title")',
    );
    assert.include(windowSource, "article.prepend(title)");
    assert.include(windowSource, "root.replaceChildren(article)");
    assert.notInclude(windowSource, "llm-plan-document-window-header");
  });

  it("opens at a useful reading size", function () {
    const markup = source("addon/content/standalonePlanDocument.xhtml");

    assert.match(markup, /\bwidth="980"/);
    assert.match(markup, /\bheight="900"/);
  });

  it("uses chat-consistent sans-serif document typography", function () {
    const css = source("addon/content/zoteroPane.css");
    const root = cssRule(css, ".llm-plan-document-window-root");
    const content = cssRule(css, ".llm-plan-document-window-content");
    const title = cssRule(
      css,
      ".llm-plan-document-window-content > .llm-plan-document-window-title",
    );
    const heading = cssRule(css, ".llm-plan-document-window-content h2");

    assert.include(
      root,
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    );
    assert.include(root, "font-size: var(--llm-document-font-size, 15.5px)");
    assert.include(content, "width: min(100%, 1120px)");
    assert.include(content, "padding: 30px clamp(38px, 5vw, 72px) 92px");
    assert.include(title, "font-size: clamp(1.871em, 3.2vw, 2.452em)");
    assert.include(heading, "font-size: 1.806em");
  });

  it("keeps citations compact and blue until interaction", function () {
    const css = source("addon/content/zoteroPane.css");

    assert.match(
      css,
      /\.llm-plan-document-window-content a,\s*\.llm-plan-document-window-content \.llm-plan-document-citation-cluster\s*\{[^}]*color: var\(--color-accent\);[^}]*text-decoration: none;/s,
    );
  });
});
