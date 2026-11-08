import { assert } from "chai";
import {
  adoptContentBarButton,
  appendContentBarButton,
  appendContentCaption,
  ensureContentBar,
  parseHtmlTitle,
  parseMermaidTitle,
  parseSvgTitle,
} from "../src/modules/contextPanel/contentChrome";
import {
  attachFlatCodeBlockChrome,
  attachFlatPreviewChrome,
} from "../src/modules/contextPanel/renderedMarkdown";
import { renderMarkdown } from "../src/utils/markdown";
import { FakeElement, fakeDocument } from "./helpers/fakeDom";

const asEl = (el: FakeElement) => el as unknown as HTMLElement;

describe("contentChrome helper", function () {
  it("creates one hover bar per block, as a direct child", function () {
    const block = new FakeElement("div");
    const first = ensureContentBar(asEl(block), fakeDocument);
    const second = ensureContentBar(asEl(block), fakeDocument);
    assert.strictEqual(first, second);
    assert.equal(block.children.length, 1);
    assert.isTrue(block.children[0].classList.contains("llm-content-bar"));
  });

  it("keeps buttons in the order they were added and labels them", function () {
    const block = new FakeElement("div");
    const bar = asEl(ensureContentBar(asEl(block), fakeDocument) as never);
    const clicks: string[] = [];
    appendContentBarButton(
      bar,
      { className: "a", label: "Wrap long lines", pressed: true },
      fakeDocument,
    );
    appendContentBarButton(
      bar,
      {
        className: "b",
        label: "Copy code",
        icon: "url(x.svg)",
        onClick: () => clicks.push("b"),
      },
      fakeDocument,
    );
    const buttons = (bar as unknown as FakeElement).children;
    assert.deepEqual(
      buttons.map((b) => b.attributes["aria-label"]),
      ["Wrap long lines", "Copy code"],
    );
    assert.isTrue(buttons[0].classList.contains("llm-content-bar-btn"));
    assert.equal(buttons[0].attributes["aria-pressed"], "true");
    assert.isUndefined(buttons[1].attributes["aria-pressed"]);
    assert.equal(buttons[1].style["--llm-content-bar-icon"], "url(x.svg)");
    const event = buttons[1].dispatchFakeEvent("click");
    assert.deepEqual(clicks, ["b"]);
    assert.isTrue(event.defaultPrevented);
  });

  it("adopts an existing button without replacing it", function () {
    const block = new FakeElement("div");
    const bar = ensureContentBar(asEl(block), fakeDocument);
    const button = new FakeElement("button");
    adoptContentBarButton(bar, asEl(button));
    assert.strictEqual((bar as unknown as FakeElement).children[0], button);
    assert.isTrue(button.classList.contains("llm-content-bar-btn"));
  });

  it("builds a caption with kind, text and an accent link", function () {
    const block = new FakeElement("div");
    let opened = 0;
    const caption = appendContentCaption(
      asEl(block),
      {
        kind: "Table",
        text: "Results by arm",
        link: { label: "Open", onClick: () => (opened += 1) },
      },
      fakeDocument,
    ) as unknown as FakeElement;
    assert.isTrue(caption.classList.contains("llm-content-caption"));
    assert.deepEqual(
      caption.children.map((c) => c.className),
      [
        "llm-content-caption-kind",
        "llm-content-caption-text",
        "llm-content-caption-link",
      ],
    );
    assert.equal(caption.children[0].textContent, "Table");
    caption.children[2].dispatchFakeEvent("click");
    assert.equal(opened, 1);
    // A second caption replaces the first.
    appendContentCaption(asEl(block), { kind: "Figure" }, fakeDocument);
    assert.equal(
      block.children.filter((c) => c.classList.contains("llm-content-caption"))
        .length,
      1,
    );
  });
});

function buildCodeBlock(options: { flat: boolean; lines: number }) {
  const root = new FakeElement("div");
  if (options.flat) root.className = "llm-content-flat";
  const copyable = new FakeElement("div");
  copyable.className = "llm-copyable llm-copyable-code";
  const shell = new FakeElement("div");
  shell.className = "llm-codeblock-shell";
  shell.dataset.codeLang = "python";
  shell.dataset.wordWrap = "false";
  const header = new FakeElement("div");
  header.className = "llm-codeblock-header";
  const wrap = new FakeElement("button");
  wrap.className = "llm-codeblock-wrap-toggle";
  const copy = new FakeElement("button");
  copy.className = "llm-render-copy-btn llm-render-code-copy-btn";
  copy.textContent = "⧉";
  const move = new FakeElement("button");
  move.className = "llm-side-move-btn";
  header.append(wrap, copy, move);
  const body = new FakeElement("div");
  body.className = "llm-codeblock-body";
  body.textContent = Array.from(
    { length: options.lines },
    (_, i) => `line ${i}`,
  ).join("\n");
  shell.append(header, body);
  copyable.appendChild(shell);
  root.appendChild(copyable);
  return { root, copyable, shell, header, wrap, copy, move };
}

describe("flat code block chrome", function () {
  it("moves wrap, copy and move buttons into the bar in order", function () {
    const { root, copyable, header, wrap, copy, move } = buildCodeBlock({
      flat: true,
      lines: 3,
    });
    attachFlatCodeBlockChrome(root as unknown as ParentNode, fakeDocument);
    const bar = copyable.children.find((c) =>
      c.classList.contains("llm-content-bar"),
    );
    assert.exists(bar);
    assert.deepEqual(bar?.children, [wrap, copy, move]);
    assert.notInclude(header.children, wrap);
    assert.equal(copy.textContent, "");
    assert.equal(copy.attributes["aria-label"], "Copy code");
    assert.equal(wrap.attributes["aria-label"], "Wrap long lines");
    assert.equal(wrap.attributes["aria-pressed"], "false");
    // No fold under 16 lines.
    assert.isUndefined(
      copyable.children.find((c) =>
        c.classList.contains("llm-content-fold-btn"),
      ),
    );
    // Running again does not duplicate anything.
    attachFlatCodeBlockChrome(root as unknown as ParentNode, fakeDocument);
    assert.equal(bar?.children.length, 3);
  });

  it("folds a long block behind a Show all N lines button", function () {
    const { root, copyable, shell } = buildCodeBlock({ flat: true, lines: 40 });
    attachFlatCodeBlockChrome(root as unknown as ParentNode, fakeDocument);
    const fold = copyable.children.find((c) =>
      c.classList.contains("llm-content-fold-btn"),
    );
    assert.exists(fold);
    assert.equal(fold?.textContent, "Show all 40 lines");
    assert.equal(shell.dataset.fold, "folded");
    fold?.dispatchFakeEvent("click");
    assert.equal(shell.dataset.fold, "expanded");
    assert.equal(fold?.textContent, "Show fewer lines");
    fold?.dispatchFakeEvent("click");
    assert.equal(shell.dataset.fold, "folded");
  });

  it("leaves a block outside the flat scope with its header buttons", function () {
    const { root, copyable, header, wrap, copy, move } = buildCodeBlock({
      flat: false,
      lines: 40,
    });
    attachFlatCodeBlockChrome(root as unknown as ParentNode, fakeDocument);
    assert.deepEqual(header.children, [wrap, copy, move]);
    assert.isUndefined(
      copyable.children.find((c) => c.classList.contains("llm-content-bar")),
    );
    assert.isUndefined(
      copyable.children.find((c) =>
        c.classList.contains("llm-content-fold-btn"),
      ),
    );
  });

  it("marks plain fences, and only plain fences, for the flat style", function () {
    const plain = renderMarkdown("```python\nprint(1)\n```");
    assert.include(plain, "llm-codeblock-plain");
    assert.include(plain, "llm-copyable-plain-code");
    const svg = renderMarkdown(
      '```svg\n<svg width="10" height="10"></svg>\n```',
    );
    assert.notInclude(svg, "llm-codeblock-plain");
  });
});

function buildPreviewBlock(options: {
  flat: boolean;
  kind: "mermaid" | "svg" | "html";
  source: string;
}) {
  const root = new FakeElement("div");
  if (options.flat) root.className = "llm-content-flat";
  const copyable = new FakeElement("div");
  copyable.className = "llm-copyable llm-copyable-code";
  const shell = new FakeElement("div");
  shell.className = "llm-codeblock-shell";
  const header = new FakeElement("div");
  header.className = "llm-codeblock-header";
  const sourceToggle = new FakeElement("button");
  sourceToggle.className = "llm-codeblock-source-toggle";
  const copy = new FakeElement("button");
  copy.className = "llm-render-copy-btn llm-render-code-copy-btn";
  const corner = new FakeElement("button");
  corner.className = "llm-mermaid-open-btn";
  header.append(sourceToggle, copy);
  const preview = new FakeElement("div");
  preview.className = `llm-${options.kind}-preview`;
  const dataKey = {
    mermaid: "llmMermaidSource",
    svg: "llmSvgSource",
    html: "llmHtmlSource",
  }[options.kind];
  preview.dataset[dataKey] = options.source;
  preview.appendChild(corner);
  const body = new FakeElement("div");
  body.className = "llm-codeblock-body";
  shell.append(header, preview, body);
  copyable.appendChild(shell);
  root.appendChild(copyable);
  return { root, copyable, shell, header, preview, body, copy, corner };
}

const barLabels = (copyable: FakeElement) =>
  copyable.children
    .find((c) => c.classList.contains("llm-content-bar"))
    ?.children.map((b) => b.attributes["aria-label"]);

const captionOf = (shell: FakeElement) =>
  shell.children.find((c) => c.classList.contains("llm-content-caption"));

describe("flat preview chrome", function () {
  it("gives a diagram its bar, caption and folded source", function () {
    const { root, copyable, shell, body, copy } = buildPreviewBlock({
      flat: true,
      kind: "mermaid",
      source: "---\ntitle: Release flow\n---\nflowchart TD\n A-->B",
    });
    attachFlatPreviewChrome(root as unknown as ParentNode, fakeDocument);
    assert.deepEqual(barLabels(copyable), [
      "Show code",
      "Copy code",
      "Save as image",
      "Open full view",
    ]);
    const bar = copyable.children.find((c) =>
      c.classList.contains("llm-content-bar"),
    );
    assert.strictEqual(bar?.children[1], copy);
    // Needs a rendered diagram first.
    assert.isTrue(
      Boolean((bar?.children[2] as unknown as { disabled: boolean }).disabled),
    );
    const caption = captionOf(shell);
    assert.equal(caption?.children[0].textContent, "Diagram");
    assert.equal(caption?.children[1].textContent, "Release flow");
    // The caption sits above the folded source.
    assert.isBelow(
      shell.children.indexOf(caption!),
      shell.children.indexOf(body),
    );
    assert.equal(shell.dataset.sourceCollapsed, "true");
    // Show code toggles the source and the label.
    const showCode = bar!.children[0];
    assert.equal(showCode.attributes["aria-pressed"], "false");
    showCode.dispatchFakeEvent("click");
    assert.equal(shell.dataset.sourceCollapsed, "false");
    assert.equal(showCode.attributes["aria-label"], "Hide code");
    assert.equal(showCode.attributes["aria-pressed"], "true");
    showCode.dispatchFakeEvent("click");
    assert.equal(showCode.attributes["aria-label"], "Show code");
    // Running again does not duplicate anything.
    attachFlatPreviewChrome(root as unknown as ParentNode, fakeDocument);
    assert.equal(bar?.children.length, 4);
  });

  it("shows only the kind when a diagram has no title", function () {
    const { root, shell } = buildPreviewBlock({
      flat: true,
      kind: "mermaid",
      source: "graph TD; A-->B",
    });
    attachFlatPreviewChrome(root as unknown as ParentNode, fakeDocument);
    const caption = captionOf(shell);
    assert.equal(caption?.children[0].textContent, "Diagram");
    assert.lengthOf(caption!.children, 1);
  });

  it("labels a drawing and reads its title", function () {
    const { root, copyable, shell } = buildPreviewBlock({
      flat: true,
      kind: "svg",
      source:
        '<svg width="10" height="10"><title>Neuron &amp; axon</title></svg>',
    });
    attachFlatPreviewChrome(root as unknown as ParentNode, fakeDocument);
    assert.deepEqual(barLabels(copyable), [
      "Show code",
      "Copy SVG",
      "Save as image",
      "Open full view",
    ]);
    const caption = captionOf(shell);
    assert.equal(caption?.children[0].textContent, "Drawing");
    assert.equal(caption?.children[1].textContent, "Neuron & axon");
  });

  it("gives a web page a bar, a caption and a show-the-whole-page pill", function () {
    const { root, copyable, shell, preview } = buildPreviewBlock({
      flat: true,
      kind: "html",
      source:
        "<html><head><title>Pricing page</title></head><body></body></html>",
    });
    attachFlatPreviewChrome(root as unknown as ParentNode, fakeDocument);
    assert.deepEqual(barLabels(copyable), [
      "Show code",
      "Copy HTML",
      "Open full view",
    ]);
    const caption = captionOf(shell);
    assert.equal(caption?.children[0].textContent, "Web page");
    assert.equal(caption?.children[1].textContent, "Pricing page");
    assert.equal(shell.dataset.sourceCollapsed, "true");
    const pill = preview.children.find((c) =>
      c.classList.contains("llm-content-expand-btn"),
    );
    assert.equal(pill?.textContent, "Show the whole page");
    assert.equal(preview.attributes["data-expanded"], "false");
    pill?.dispatchFakeEvent("click");
    assert.equal(preview.attributes["data-expanded"], "true");
    assert.equal(pill?.textContent, "Show less");
    pill?.dispatchFakeEvent("click");
    assert.equal(preview.attributes["data-expanded"], "false");
  });

  it("leaves a preview outside the flat scope with its header and corner button", function () {
    const { root, copyable, header, preview, corner, copy } = buildPreviewBlock(
      {
        flat: false,
        kind: "mermaid",
        source: "graph TD; A-->B",
      },
    );
    attachFlatPreviewChrome(root as unknown as ParentNode, fakeDocument);
    assert.isUndefined(
      copyable.children.find((c) => c.classList.contains("llm-content-bar")),
    );
    assert.include(header.children, copy);
    assert.include(preview.children, corner);
  });
});

describe("content title parsers", function () {
  it("reads a Mermaid title from front matter, accTitle or a title line", function () {
    assert.equal(
      parseMermaidTitle('---\ntitle: "Sprint plan"\n---\ngantt\n'),
      "Sprint plan",
    );
    assert.equal(
      parseMermaidTitle("flowchart TD\n accTitle: Login steps\n A-->B"),
      "Login steps",
    );
    assert.equal(
      parseMermaidTitle("gantt\n  title Roadmap 2027\n  section A"),
      "Roadmap 2027",
    );
    assert.equal(
      parseMermaidTitle('pie showData title Pets\n  "Dogs" : 3'),
      "Pets",
    );
    assert.equal(parseMermaidTitle("flowchart TD\n A[title here]-->B"), "");
    assert.equal(parseMermaidTitle(""), "");
  });

  it("reads an SVG title and an HTML title or first heading", function () {
    assert.equal(
      parseSvgTitle("<svg><title> A &lt;b&gt; </title></svg>"),
      "A <b>",
    );
    assert.equal(parseSvgTitle("<svg></svg>"), "");
    assert.equal(parseHtmlTitle("<title>Home</title><h1>Other</h1>"), "Home");
    assert.equal(
      parseHtmlTitle("<body><h1 class=x>Big <em>news</em>\n today</h1></body>"),
      "Big news today",
    );
    assert.equal(parseHtmlTitle("<p>none</p>"), "");
  });

  it("cuts long titles to about 80 characters", function () {
    const text = parseHtmlTitle(`<title>${"word ".repeat(40)}</title>`);
    assert.isAtMost(text.length, 80);
    assert.isTrue(text.endsWith("\u2026"));
  });
});
