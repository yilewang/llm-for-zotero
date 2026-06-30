import { assert } from "chai";
import { readFileSync } from "node:fs";
import {
  buildAgentTraceChipDetails,
  buildAgentTraceDisplayItems,
  buildAgentTraceMarkdownForRender,
  getPendingActionButtonLayout,
  renderAgentTrace,
  renderPendingActionCard,
} from "../src/modules/contextPanel/agentTrace/render";
import {
  createCodexNativeActivityTraceControllerForTests,
  resolveAssistantResponseMenuContent,
  renderAssistantMarkdownHtmlForChat,
  renderAssistantGeneratedImagesInto,
  shouldAttachAssistantResponseContextMenu,
  shouldDecorateInterleavedAgentTraceCitations,
  shouldSuppressAssistantResponseContextMenu,
} from "../src/modules/contextPanel/chat";
import {
  attachRenderedCodeBlockControls,
  attachRenderedCopyButtons,
  extractRenderedMermaidSvg,
  isSafeRenderedMarkdownAttributeForTests,
  isSafeRenderedMarkdownElementForTests,
  needsMermaidCytoscapeLayoutHost,
  normalizeMermaidFlowchartLabels,
  normalizeMermaidSourceForTheme,
  polishRenderedMermaidSvg,
  renderRenderedMarkdownInto,
  resolveMermaidThemeFromColors,
} from "../src/modules/contextPanel/renderedMarkdown";
import {
  sanitizeRenderedMermaidSvg,
  sanitizeRenderedMermaidSvgWithReason,
} from "../src/modules/contextPanel/mermaidSvg";
import type {
  AgentPendingAction,
  AgentRunEventRecord,
} from "../src/agent/types";
import { createMalformedToolArgumentsDiagnostic } from "../src/agent/toolArgumentDiagnostics";
import { buildQuoteCitation } from "../src/modules/contextPanel/quoteCitations";
import {
  isEmbeddableGeneratedImage,
  resolveGeneratedImageAsset,
} from "../src/modules/contextPanel/generatedImageAssets";

class FakeClassList {
  private readonly classes = new Set<string>();

  add(...classes: string[]) {
    for (const cls of classes) {
      if (cls) this.classes.add(cls);
    }
  }

  contains(cls: string): boolean {
    return this.classes.has(cls);
  }

  toString(): string {
    return Array.from(this.classes).join(" ");
  }
}

class FakeElement {
  public readonly classList = new FakeClassList();
  public readonly dataset: Record<string, string | undefined> = {};
  public readonly children: FakeElement[] = [];
  public id = "";
  public textContent = "";
  public type = "";
  public title = "";
  public disabled = false;
  public attributes: Record<string, string> = {};
  private copyableChildren: FakeElement[] = [];
  private html = "";
  private listeners = new Map<string, Array<(event: any) => void>>();

  constructor(public readonly tagName = "div") {}

  set className(value: string) {
    this.classList.add(...value.split(/\s+/).filter(Boolean));
  }

  get className(): string {
    return this.classList.toString();
  }

  set innerHTML(value: string) {
    this.html = value;
    this.copyableChildren = value.includes("llm-copyable")
      ? [new FakeCopyableElement()]
      : [];
  }

  get innerHTML(): string {
    return this.html;
  }

  get firstChild(): FakeElement | null {
    return this.children[0] || null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === ".llm-copyable[data-llm-copy-source]") {
      return [
        ...this.copyableChildren,
        ...this.findAllByClass("llm-copyable").filter(
          (element) => element.dataset.llmCopySource !== undefined,
        ),
      ];
    }
    if (selector === ".llm-codeblock-shell") {
      return this.findAllByClass("llm-codeblock-shell");
    }
    return [];
  }

  querySelector(selector: string): FakeElement | null {
    if (selector === ":scope > .llm-render-copy-btn") {
      return (
        this.children.find((child) =>
          child.classList.contains("llm-render-copy-btn"),
        ) || null
      );
    }
    if (selector === ":scope .llm-codeblock-shell") {
      return this.findByClass("llm-codeblock-shell");
    }
    return null;
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const existing = this.listeners.get(type) || [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  dispatchFakeEvent(type: string): {
    defaultPrevented: boolean;
    propagationStopped: boolean;
    immediatePropagationStopped: boolean;
  } {
    const event = {
      defaultPrevented: false,
      propagationStopped: false,
      immediatePropagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      stopImmediatePropagation() {
        this.immediatePropagationStopped = true;
      },
    };
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
    return event;
  }

  async dispatchFakeEventAsync(type: string): Promise<{
    defaultPrevented: boolean;
    propagationStopped: boolean;
    immediatePropagationStopped: boolean;
  }> {
    const event = {
      defaultPrevented: false,
      propagationStopped: false,
      immediatePropagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      stopImmediatePropagation() {
        this.immediatePropagationStopped = true;
      },
    };
    await Promise.all(
      (this.listeners.get(type) || []).map((listener) => listener(event)),
    );
    return event;
  }

  contains(node: unknown): boolean {
    return this.children.includes(node as FakeElement);
  }

  insertBefore(child: FakeElement, before: FakeElement | null): FakeElement {
    if (!before) {
      this.children.unshift(child);
      return child;
    }
    const index = this.children.indexOf(before);
    if (index < 0) {
      this.children.unshift(child);
      return child;
    }
    this.children.splice(index, 0, child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  findByClass(className: string): FakeElement | null {
    if (this.classList.contains(className)) return this;
    for (const child of this.children) {
      const match = child.findByClass(className);
      if (match) return match;
    }
    return null;
  }

  findAllByClass(className: string): FakeElement[] {
    const matches = this.classList.contains(className) ? [this] : [];
    for (const child of this.children) {
      matches.push(...child.findAllByClass(className));
    }
    return matches;
  }

  findAllByTag(tagName: string): FakeElement[] {
    const normalized = tagName.toLowerCase();
    const matches = this.tagName.toLowerCase() === normalized ? [this] : [];
    for (const child of this.children) {
      matches.push(...child.findAllByTag(normalized));
    }
    return matches;
  }

  getCopyableChildren(): FakeElement[] {
    return this.copyableChildren;
  }
}

class FakeCopyableElement extends FakeElement {
  constructor() {
    super("span");
    this.className = "llm-copyable llm-copyable-math";
    this.dataset.llmCopySource = "$$r(x)=g(Vx)$$";
  }
}

class ThrowingTemplateElement extends FakeElement {
  public readonly content = {
    querySelectorAll: () => [],
  };

  set innerHTML(_value: string) {
    throw new Error("template parser unavailable");
  }

  get innerHTML(): string {
    return "";
  }
}

class OneShotInnerHtmlFailureElement extends FakeElement {
  private htmlSetCount = 0;
  private storedHtml = "";

  set innerHTML(value: string) {
    this.htmlSetCount++;
    if (this.htmlSetCount === 1) {
      throw new Error("strict chrome innerHTML rejected fragment");
    }
    this.storedHtml = value;
  }

  get innerHTML(): string {
    return this.storedHtml;
  }

  getInnerHtmlSetCount(): number {
    return this.htmlSetCount;
  }
}

const fakeDocument = {
  createElement: (tagName: string) => new FakeElement(tagName),
  createElementNS: (_namespace: string, tagName: string) =>
    new FakeElement(tagName),
} as unknown as Document;

const throwingTemplateDocument = {
  createElement: (tagName: string) =>
    tagName === "template"
      ? new ThrowingTemplateElement(tagName)
      : new FakeElement(tagName),
  createElementNS: (_namespace: string, tagName: string) =>
    new FakeElement(tagName),
} as unknown as Document;

type CodexToolActivityTestPayload = Extract<
  AgentRunEventRecord["payload"],
  { type: "codex_tool_activity" }
>;

function codexToolActivityEvent(
  seq: number,
  payload: CodexToolActivityTestPayload,
  createdAt = seq,
): AgentRunEventRecord {
  return {
    runId: "run-1",
    seq,
    eventType: "codex_tool_activity",
    payload,
    createdAt,
  };
}

function getCodexTraceActionTexts(events: AgentRunEventRecord[]): string[] {
  const { items } = buildAgentTraceDisplayItems(events, null, {
    role: "assistant",
    text: "",
    timestamp: 1,
    runMode: "agent",
    modelProviderLabel: "Codex",
  });
  return items
    .filter(
      (item): item is Extract<(typeof items)[number], { type: "action" }> =>
        item.type === "action",
    )
    .map((item) => item.row.text);
}

function createFakeCodeBlockShell(options?: {
  lang?: string;
  previewClass?: string;
  previewSource?: string;
  renderedSvg?: string;
}): {
  root: FakeElement;
  shell: FakeElement;
  header: FakeElement;
  body: FakeElement;
} {
  const root = new FakeElement("div");
  const shell = new FakeElement("div");
  shell.className = "llm-codeblock-shell";
  shell.dataset.codeLang = options?.lang || "text";

  const header = new FakeElement("div");
  header.className = "llm-codeblock-header";

  const lang = new FakeElement("span");
  lang.className = "llm-codeblock-lang";
  lang.textContent = options?.lang || "text";
  header.appendChild(lang);

  const body = new FakeElement("div");
  body.className = "llm-codeblock-body";

  shell.appendChild(header);
  if (options?.previewClass) {
    const preview = new FakeElement("div");
    preview.className = options.previewClass;
    if (options.previewSource) {
      preview.dataset.llmSvgSource = options.previewSource;
    }
    if (options.renderedSvg) {
      preview.dataset.llmRenderedSvg = options.renderedSvg;
    }
    shell.appendChild(preview);
  }
  shell.appendChild(body);
  root.appendChild(shell);

  return { root, shell, header, body };
}

function collectFakeText(element: FakeElement | null | undefined): string {
  if (!element) return "";
  return [element.textContent, ...element.children.map(collectFakeText)].join(
    "",
  );
}

function createSanitizerElement(
  localName: string,
  classes: string[] = [],
  parent: Element | null = null,
): Element {
  return {
    localName,
    parentElement: parent,
    parentNode: parent,
    nodeType: 1,
    classList: {
      contains: (cls: string) => classes.includes(cls),
    },
  } as unknown as Element;
}

function createKatexSvgElement(localName: "svg" | "path" | "line"): Element {
  const katex = createSanitizerElement("span", ["katex"]);
  const svg = createSanitizerElement("svg", [], katex);
  return localName === "svg" ? svg : createSanitizerElement(localName, [], svg);
}

function extractKatexSvgTags(
  html: string,
): Array<{ tagName: "svg" | "path" | "line"; attrs: Array<[string, string]> }> {
  const tags: Array<{
    tagName: "svg" | "path" | "line";
    attrs: Array<[string, string]>;
  }> = [];
  for (const tagMatch of html.matchAll(/<(svg|path|line)\b([^>]*)>/gi)) {
    const attrs: Array<[string, string]> = [];
    for (const attrMatch of tagMatch[2].matchAll(
      /([A-Za-z_:][\w:.-]*)="([^"]*)"/g,
    )) {
      attrs.push([attrMatch[1], attrMatch[2]]);
    }
    tags.push({
      tagName: tagMatch[1].toLowerCase() as "svg" | "path" | "line",
      attrs,
    });
  }
  return tags;
}

const obsidianStyleMermaidFixture = [
  "flowchart TB",
  '    A["Main question<br/>Why are spatial maps and episodic memory both tied to hippocampal circuits?"]',
  "",
  '    B["Classic memory models<br/>content itself creates attractors"]',
  '    C["Memory cliff<br/>too many stored patterns can cause collapse"]',
  "",
  '    D["Vector-HaSH<br/>separate content storage from scaffold dynamics"]',
  "",
  "    A --> B --> C",
  "    A --> D",
  "",
  '    subgraph Scaffold["Grid-cell scaffold"]',
  '        G["Entorhinal grid-cell modules<br/>fixed recurrent structure"]',
  '        F["Stable scaffold states<br/>large error-correcting basins"]',
  '        V["Low-dimensional velocity shift<br/>moves between grid states"]',
  "        G --> F",
  "        V --> G",
  "    end",
  "",
  '    subgraph Content["Content pathway"]',
  '        S["Cortical / EC sensory input<br/>event details"]',
  '        H["Hippocampal state<br/>content-independent pointer or hash"]',
  '        R["Decoded cortical content<br/>recalled memory"]',
  "        S -- learned association --> H",
  "        H -- learned decoding --> R",
  "    end",
  "",
  "    D --> Scaffold",
  "    D --> Content",
  "    G <--> H",
  "",
  '    subgraph Store["Storage"]',
  '        I["Item memory<br/>bind content to scaffold state"]',
  '        SP["Spatial memory<br/>movement updates grid phase"]',
  '        EP["Episodic memory<br/>sequence becomes transitions through scaffold states"]',
  "    end",
  "",
  "    H --> I",
  "    V --> SP",
  "    H --> EP",
  "    EP --> V",
  "",
  '    subgraph Recall["Recall"]',
  '        Q["Partial or noisy cue"]',
  '        QH["Approximate hippocampal pointer"]',
  '        QG["Grid scaffold cleans up state"]',
  '        QR["Restored pointer"]',
  '        QC["Feedforward decode to content"]',
  "",
  "        Q --> QH --> QG --> QR --> QC",
  "    end",
  "",
  "    F --> QG",
  "",
  '    subgraph Payoff["Payoff"]',
  '        O1["Pattern completion"]',
  '        O2["Graceful loss of detail<br/>instead of all-or-none failure"]',
  '        O3["Long sequence recall<br/>learn next 2D transition, not next full event"]',
  '        O4["Unified account of<br/>item, spatial, and episodic memory"]',
  "    end",
  "",
  "    QC --> O1",
  "    QC --> O2",
  "    V --> O3",
  "    D --> O4",
].join("\n");

describe("Mermaid rendering helpers", function () {
  it("quotes flowchart labels with punctuation that Mermaid parses poorly", function () {
    const source = [
      "flowchart TD",
      "  A[Continuous experience] --> B[LEC population activity (time cells?)]",
      "  B --> C[Intrinsic drift: over time]",
    ].join("\n");

    const normalized = normalizeMermaidFlowchartLabels(source);

    assert.include(normalized, 'B["LEC population activity (time cells?)"]');
    assert.include(normalized, 'C["Intrinsic drift: over time"]');
    assert.include(normalized, "A[Continuous experience]");
  });

  it("preserves already quoted Mermaid labels", function () {
    const source =
      'flowchart TD\n  A["LEC population activity (time cells?)"] --> B[Done]';

    assert.equal(normalizeMermaidFlowchartLabels(source), source);
  });

  it("does not rewrite Mermaid edge labels while normalizing node labels", function () {
    const source = "flowchart TD\n  A[Bad label?] -->|question [yes?]| B[Done]";

    const normalized = normalizeMermaidFlowchartLabels(source);

    assert.include(normalized, 'A["Bad label?"]');
    assert.include(normalized, "-->|question [yes?]|");
    assert.include(normalized, "B[Done]");
  });

  it("removes hardcoded dark neutral styles for light Mermaid rendering", function () {
    const source =
      "flowchart TD\n  A[One]\n  classDef neutral fill:#2f2f2f,stroke:#52525b,color:#f8fafc;\n  class A neutral";

    const normalized = normalizeMermaidSourceForTheme(source, "light");

    assert.include(
      normalized,
      "classDef neutral fill:#f8fafc,stroke:#cbd5e1,color:#111827;",
    );
  });

  it("rewrites dark subgraph fills without changing normal node styles", function () {
    const source = [
      "flowchart TD",
      "  subgraph R[Recall process]",
      "    A[One]",
      "  end",
      "  style R fill:#151515,stroke:#333333",
      "  style A fill:#151515,stroke:#333333",
    ].join("\n");

    const normalized = normalizeMermaidSourceForTheme(source, "light");

    assert.include(
      normalized,
      "style R fill:#ffffff,stroke:#e5e7eb,color:#111827",
    );
    assert.include(normalized, "style A fill:#151515,stroke:#333333");
  });

  it("adds SVG polish rules for the expanded Mermaid viewer", function () {
    const svg =
      '<svg viewBox="0 0 10 10"><g class="cluster"><rect /></g></svg>';

    const polished = polishRenderedMermaidSvg(svg, "light");

    assert.include(polished, 'data-llm-mermaid-polished="true"');
    assert.include(polished, ".cluster rect{fill:#ffffff!important");
    assert.include(polished, ".flowchart-link{stroke:#6b7280!important");
  });

  it("preserves Obsidian-style HTML label breaks in complex flowcharts", function () {
    const normalized = normalizeMermaidSourceForTheme(
      obsidianStyleMermaidFixture,
      "light",
    );

    assert.include(
      normalized,
      'A["Main question<br/>Why are spatial maps and episodic memory both tied to hippocampal circuits?"]',
    );
    assert.include(normalized, "G <--> H");
    assert.include(normalized, 'subgraph Scaffold["Grid-cell scaffold"]');
  });

  it("normalizes Markdown-style flowchart labels for Mermaid HTML rendering", function () {
    const source = [
      "flowchart TD",
      '  A["**Problem** spatial mapping **and** episodic memory"]',
      '  B["Graceful memory `continuum` &amp; sequence scaffold"]',
      "  C[**Conclusion**]",
      "  A -->|edge **label** stays markdown source| B --> C",
    ].join("\n");

    const normalized = normalizeMermaidFlowchartLabels(source);

    assert.include(
      normalized,
      'A["<strong>Problem</strong> spatial mapping <strong>and</strong> episodic memory"]',
    );
    assert.include(
      normalized,
      'B["Graceful memory <code>continuum</code> & sequence scaffold"]',
    );
    assert.include(normalized, 'C["<strong>Conclusion</strong>"]');
    assert.include(normalized, "-->|edge **label** stays markdown source| B");
  });

  it("strips locked Mermaid init overrides while preserving safe directives", function () {
    const source = [
      '%%{init: {"securityLevel": "loose", "htmlLabels": false}}%%',
      '%%{init: {"sequence": {"showSequenceNumbers": true}}}%%',
      "flowchart TD",
      "  A --> B",
    ].join("\n");

    const normalized = normalizeMermaidSourceForTheme(source, "light");

    assert.notInclude(normalized, "securityLevel");
    assert.notInclude(normalized, "htmlLabels");
    assert.include(normalized, "showSequenceNumbers");
  });

  it("detects Mermaid mindmaps that need the Cytoscape layout host", function () {
    const mindmap = [
      '%%{init: {"theme": "base"}}%%',
      "%% generated summary",
      "mindmap",
      "  root((Spatial scaffolds))",
      "    Episodic memory",
    ].join("\n");

    assert.isTrue(needsMermaidCytoscapeLayoutHost(mindmap));
    assert.isFalse(
      needsMermaidCytoscapeLayoutHost(
        'flowchart TD\n  A["mindmap is just label text"] --> B',
      ),
    );
  });

  it("allows safe Mermaid foreignObject labels with HTML line breaks", function () {
    const svg = [
      '<svg viewBox="0 0 200 100">',
      "<style>.edgeLabel{background:url(#safe);}</style>",
      '<foreignObject width="180" height="60">',
      '<div xmlns="http://www.w3.org/1999/xhtml">',
      '<span class="nodeLabel">Main question<br>Why hippocampus?</span>',
      "</div>",
      "</foreignObject>",
      '<rect filter="url(#shadow)" width="10" height="10"/>',
      '<path marker-end="url(#arrow)" d="M0 0L10 10"/>',
      "</svg>",
    ].join("");

    const sanitized = sanitizeRenderedMermaidSvg(svg, 10_000);

    assert.isString(sanitized);
    assert.include(sanitized || "", "<foreignObject");
    assert.include(sanitized || "", "<br/>");
    assert.include(sanitized || "", 'xmlns="http://www.w3.org/2000/svg"');
  });

  it("extracts SVG markup from Mermaid sandbox iframe output", function () {
    const svg = [
      '<svg viewBox="0 0 100 60">',
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">',
      "one<br/>two",
      "</div></foreignObject>",
      "</svg>",
    ].join("");
    const encoded = Buffer.from(`<body>${svg}</body>`, "utf8").toString(
      "base64",
    );
    const sandboxOutput = `<iframe src="data:text/html;charset=UTF-8;base64,${encoded}" sandbox=""></iframe>`;

    const extracted = extractRenderedMermaidSvg(sandboxOutput);
    const sanitized = sanitizeRenderedMermaidSvg(extracted, 10_000);

    assert.equal(extracted, svg);
    assert.include(sanitized || "", "<foreignObject");
    assert.include(sanitized || "", "<br/>");
  });

  it("rejects unsafe Mermaid SVG output", function () {
    const unsafeFragments = [
      '<script>alert("x")</script>',
      '<foreignObject><div onclick="alert(1)">x</div></foreignObject>',
      '<foreignObject><img src="x"/></foreignObject>',
      '<path href="https://example.com/x" d="M0 0"/>',
      "<style>@import url(https://example.com/x.css);</style>",
      '<rect style="fill:url(https://example.com/x.svg)"/>',
      '<rect filter="url(https://example.com/f.svg#x)"/>',
      '<rect fill="url(data:image/svg+xml;base64,AAAA)"/>',
      '<use href="javascript:alert(1)"/>',
    ];

    for (const fragment of unsafeFragments) {
      assert.isNull(
        sanitizeRenderedMermaidSvg(`<svg>${fragment}</svg>`, 10_000),
        fragment,
      );
    }
  });

  it("reports why unsafe Mermaid SVG output was rejected", function () {
    const sanitized = sanitizeRenderedMermaidSvgWithReason(
      '<svg><foreignObject><img src="x"/></foreignObject></svg>',
      10_000,
    );

    assert.isFalse(sanitized.ok);
    if (!sanitized.ok) {
      assert.include(sanitized.reason, "unsupported SVG tag: img");
    }
  });

  it("lets visible light surfaces override stale dark theme hints", function () {
    assert.equal(
      resolveMermaidThemeFromColors(["rgb(245, 245, 245)"], ["#f8fafc"], true),
      "light",
    );
  });

  it("falls back to dark only when no visible surface color is available", function () {
    assert.equal(
      resolveMermaidThemeFromColors(["transparent"], [], true),
      "dark",
    );
  });
});

describe("rendered Markdown code block source controls", function () {
  it("collapses safe SVG source by default while keeping the preview shell visible", function () {
    const { root, shell, header, body } = createFakeCodeBlockShell({
      lang: "svg",
      previewClass: "llm-svg-preview",
      previewSource: '<svg width="10" height="10"></svg>',
    });

    attachRenderedCodeBlockControls(
      root as unknown as ParentNode,
      fakeDocument,
    );

    const toggle = header.findByClass("llm-codeblock-source-toggle");
    assert.exists(toggle);
    assert.equal(shell.dataset.sourceCollapsed, "true");
    assert.equal(body.attributes["aria-hidden"], "true");
    assert.equal(toggle?.attributes["aria-expanded"], "false");
    assert.equal(toggle?.textContent, "Show source");
    assert.isNotEmpty(body.id);

    toggle?.dispatchFakeEvent("click");

    assert.equal(shell.dataset.sourceCollapsed, "false");
    assert.equal(body.attributes["aria-hidden"], "false");
    assert.equal(toggle?.attributes["aria-expanded"], "true");
    assert.equal(toggle?.textContent, "Hide source");
  });

  it("adds a PNG figure-copy control for safe SVG previews", function () {
    const { root, header } = createFakeCodeBlockShell({
      lang: "svg",
      previewClass: "llm-svg-preview",
      previewSource: '<svg width="10" height="10"></svg>',
    });

    attachRenderedCodeBlockControls(
      root as unknown as ParentNode,
      fakeDocument,
    );

    const figureCopy = header.findByClass("llm-codeblock-figure-copy");
    assert.exists(figureCopy);
    assert.isFalse(Boolean(figureCopy?.disabled));
    assert.equal(figureCopy?.title, "Copy SVG figure as PNG");
    assert.equal(
      figureCopy?.attributes["aria-label"],
      "Copy SVG figure as PNG",
    );
  });

  it("collapses Mermaid source by default", function () {
    const { root, shell, header, body } = createFakeCodeBlockShell({
      lang: "mermaid",
      previewClass: "llm-mermaid-preview",
    });

    attachRenderedCodeBlockControls(
      root as unknown as ParentNode,
      fakeDocument,
    );

    const toggle = header.findByClass("llm-codeblock-source-toggle");
    assert.equal(shell.dataset.sourceCollapsed, "true");
    assert.equal(body.attributes["aria-hidden"], "true");
    assert.equal(toggle?.attributes["aria-expanded"], "false");
    assert.equal(toggle?.textContent, "Show source");
  });

  it("adds a disabled PNG figure-copy control for pending Mermaid previews", function () {
    const { root, header } = createFakeCodeBlockShell({
      lang: "mermaid",
      previewClass: "llm-mermaid-preview",
    });

    attachRenderedCodeBlockControls(
      root as unknown as ParentNode,
      fakeDocument,
    );

    const figureCopy = header.findByClass("llm-codeblock-figure-copy");
    assert.exists(figureCopy);
    assert.isTrue(Boolean(figureCopy?.disabled));
    assert.equal(figureCopy?.title, "Copy Mermaid diagram as PNG (rendering)");
  });

  it("keeps ordinary code source expanded by default but collapsible", function () {
    const { root, shell, header, body } = createFakeCodeBlockShell({
      lang: "ts",
    });

    attachRenderedCodeBlockControls(
      root as unknown as ParentNode,
      fakeDocument,
    );

    const toggle = header.findByClass("llm-codeblock-source-toggle");
    assert.equal(shell.dataset.sourceCollapsed, "false");
    assert.equal(body.attributes["aria-hidden"], "false");
    assert.equal(toggle?.attributes["aria-expanded"], "true");
    assert.equal(toggle?.textContent, "Hide source");

    toggle?.dispatchFakeEvent("click");

    assert.equal(shell.dataset.sourceCollapsed, "true");
    assert.equal(body.attributes["aria-hidden"], "true");
    assert.equal(toggle?.attributes["aria-expanded"], "false");
    assert.equal(toggle?.textContent, "Show source");
  });

  it("treats unsafe SVG without a preview like ordinary expanded code", function () {
    const { root, shell, header, body } = createFakeCodeBlockShell({
      lang: "svg",
    });

    attachRenderedCodeBlockControls(
      root as unknown as ParentNode,
      fakeDocument,
    );

    assert.equal(shell.dataset.sourceCollapsed, "false");
    assert.equal(body.attributes["aria-hidden"], "false");
    assert.isNull(header.findByClass("llm-codeblock-figure-copy"));
  });

  it("keeps copy controls bound to the original fenced source when source is collapsed", function () {
    const copySource = '```svg\n<svg width="10" height="10"></svg>\n```';
    const root = new FakeElement("div");
    const copyable = new FakeElement("div");
    copyable.className = "llm-copyable llm-copyable-code";
    copyable.dataset.llmCopySource = copySource;

    const { shell, header } = createFakeCodeBlockShell({
      lang: "svg",
      previewClass: "llm-svg-preview",
      previewSource: '<svg width="10" height="10"></svg>',
    });
    copyable.appendChild(shell);
    root.appendChild(copyable);

    attachRenderedCodeBlockControls(
      root as unknown as ParentNode,
      fakeDocument,
    );
    attachRenderedCopyButtons(root as unknown as ParentNode, fakeDocument);

    const copyButton = header.findByClass("llm-render-copy-btn");
    assert.exists(copyButton);
    assert.equal(copyable.dataset.llmCopySource, copySource);
    assert.equal(shell.dataset.sourceCollapsed, "true");
    assert.equal(copyButton?.attributes["aria-label"], "Copy SVG code");
    const sourceIndex = header.children.findIndex((child) =>
      child.classList.contains("llm-codeblock-source-toggle"),
    );
    const figureIndex = header.children.findIndex((child) =>
      child.classList.contains("llm-codeblock-figure-copy"),
    );
    const copyIndex = header.children.findIndex((child) =>
      child.classList.contains("llm-render-code-copy-btn"),
    );
    assert.isAtLeast(sourceIndex, 0);
    assert.isAtLeast(figureIndex, 0);
    assert.isAtLeast(copyIndex, 0);
    assert.isBelow(sourceIndex, figureIndex);
    assert.isBelow(figureIndex, copyIndex);
  });
});

describe("agentTrace render", function () {
  it("preserves known quote anchors before agent trace DOM decoration", function () {
    const quoteCitation = buildQuoteCitation({
      quoteText: "Interleaved trace quote anchors should not leak.",
      citationLabel: "(Chandra et al., 2025)",
      contextItemId: 51,
    });
    assert.isDefined(quoteCitation);

    const rendered = buildAgentTraceMarkdownForRender(
      `Evidence:\n\n[[quote:${quoteCitation!.id}]]`,
      { quoteCitations: [quoteCitation!] },
    );

    assert.include(rendered, `[[quote:${quoteCitation!.id}]]`);
    assert.notInclude(rendered, "> Interleaved trace quote anchors");
    assert.notInclude(rendered, "(Chandra et al., 2025)");
  });

  it("isolates preserved quote anchors before agent trace DOM decoration", function () {
    const quoteCitation = buildQuoteCitation({
      quoteText: "Interleaved trace quote boundaries should be stable.",
      citationLabel: "(Chandra et al., 2025)",
      contextItemId: 51,
    });
    assert.isDefined(quoteCitation);

    const rendered = buildAgentTraceMarkdownForRender(
      `Evidence:\n\n[[quote:${quoteCitation!.id}]]\nSo **one component** handles all angles.`,
      { quoteCitations: [quoteCitation!] },
    );

    assert.include(rendered, `[[quote:${quoteCitation!.id}]]\n\nSo **one`);
    assert.notInclude(rendered, `[[quote:${quoteCitation!.id}]]\nSo **one`);
    assert.notInclude(rendered, "> Interleaved trace quote boundaries");
  });

  it("omits unresolved quote anchors in agent trace markdown", function () {
    const rendered = buildAgentTraceMarkdownForRender(
      "Evidence:\n\n[[quote:Q_missing]]\n\nContinue.",
      { quoteCitations: [] },
    );

    assert.include(rendered, "Evidence");
    assert.include(rendered, "Continue.");
    assert.notInclude(rendered, "[[quote:");
    assert.notInclude(rendered, "[quote unavailable]");
  });

  it("preserves unmatched source-backed blockquotes in agent trace markdown", function () {
    const rendered = buildAgentTraceMarkdownForRender(
      "证据：\n\n> 记忆痕迹在巩固过程中具有高度动态性。\n\n(Tomé, 2024)\n\n继续。",
      {
        quoteCitations: [
          {
            id: "Q_trace",
            quoteText:
              "Memory engrams are highly dynamic during consolidation.",
            citationLabel: "(Tomé, 2024)",
            contextItemId: 51,
          },
        ],
      },
    );

    assert.include(rendered, "证据");
    assert.include(rendered, "继续");
    assert.include(rendered, "> 记忆痕迹在巩固过程中具有高度动态性。");
    assert.include(rendered, "(Tomé, 2024)");
    assert.notInclude(rendered, "[[quote:");
  });

  it("uses rendered Markdown HTML for streaming assistant text", function () {
    const html = renderAssistantMarkdownHtmlForChat(
      [
        "# Result",
        "",
        "- **Bold** [link](https://example.com)",
        "",
        "`code`",
        "",
        "| A | B |",
        "|---|---|",
        "| 1 | 2 |",
      ].join("\n"),
    );

    assert.include(html, "<h2");
    assert.include(html, "<strong>Bold</strong>");
    assert.include(html, "<a ");
    assert.include(html, "<code>code</code>");
    const tableHtml = renderAssistantMarkdownHtmlForChat(
      "| A | B |\n|---|---|\n| 1 | 2 |",
    );
    assert.include(tableHtml, "<table");
  });

  it("keeps rendered Markdown when template sanitizer parsing fails", function () {
    const target = new FakeElement("div") as unknown as HTMLElement;

    renderRenderedMarkdownInto(
      target,
      ["## Methodology Overview", "", "**Fiber photometry**", "", "---"].join(
        "\n",
      ),
      throwingTemplateDocument,
    );

    const html = (target as unknown as FakeElement).innerHTML;
    assert.include(html, "<h3>Methodology Overview</h3>");
    assert.include(html, "<strong>Fiber photometry</strong>");
    assert.include(html, "<hr");
    assert.notInclude(html, "## Methodology Overview");
    assert.isTrue(
      (target as unknown as FakeElement).classList.contains(
        "llm-rendered-markdown",
      ),
    );
  });

  it("falls back to the legacy renderer when chrome innerHTML rejects marked HTML", function () {
    const target = new OneShotInnerHtmlFailureElement(
      "div",
    ) as unknown as HTMLElement;

    renderRenderedMarkdownInto(
      target,
      ["## Methodology Overview", "", "The study used photometry."].join("\n"),
      throwingTemplateDocument,
    );

    const fakeTarget = target as unknown as OneShotInnerHtmlFailureElement;
    assert.equal(fakeTarget.getInnerHtmlSetCount(), 2);
    assert.include(fakeTarget.innerHTML, "<h3>Methodology Overview</h3>");
    assert.include(fakeTarget.innerHTML, "<p>The study used photometry.</p>");
    assert.notInclude(fakeTarget.innerHTML, "## Methodology Overview");
  });

  it("renders trace inline math through the shared Markdown surface", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "$$r(x)=g(Vx)$$",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "read_paper",
          args: { operation: "front_matter" },
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "final",
        payload: {
          type: "final",
          text: "Done.",
        },
        createdAt: 3,
      },
    ];

    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: {
        role: "assistant",
        text: "Done.",
        timestamp: 1,
        runMode: "agent",
        modelProviderLabel: "deepseek-v4-flash",
      },
      events,
    }) as unknown as FakeElement;
    const inline = trace.findByClass("llm-agent-inline-text");
    assert.exists(inline);
    assert.isTrue(inline?.classList.contains("llm-rendered-markdown"));
    assert.include(inline?.innerHTML || "", "math-display");
    assert.include(inline?.innerHTML || "", "katex");
    const copyable = inline?.getCopyableChildren()[0];
    const copyButton = copyable?.children.find((child) =>
      child.classList.contains("llm-render-copy-btn"),
    );

    assert.exists(copyable);
    assert.exists(copyButton);
    assert.equal(
      copyButton?.attributes["aria-label"],
      "Copy original markdown",
    );
  });

  it("renders tagged display math as KaTeX tag markup", function () {
    const html = renderAssistantMarkdownHtmlForChat(
      String.raw`$$ r(x)=g(Vx) \tag{1} $$`,
    );

    assert.include(html, "math-display");
    assert.include(html, 'class="tag"');
    assert.notInclude(html, "math-error");
  });

  it("allows the SVG tags and attributes emitted by KaTeX math", function () {
    const formulas = [
      String.raw`\sqrt{x+y}`,
      String.raw`\sqrt[3]{x}`,
      String.raw`\widehat{x}`,
      String.raw`\overrightarrow{AB}`,
      String.raw`\xrightarrow{n\to\infty}`,
      String.raw`\overbrace{x+y}`,
      String.raw`\underbrace{x+y}`,
      String.raw`\cancel{x+y}`,
    ];

    for (const formula of formulas) {
      const html = renderAssistantMarkdownHtmlForChat(
        String.raw`$$${formula}$$`,
      );
      const tags = extractKatexSvgTags(html);

      assert.isNotEmpty(tags, formula);
      assert.include(html, "katex", formula);
      assert.include(html, "<svg", formula);

      for (const tag of tags) {
        const element = createKatexSvgElement(tag.tagName);
        assert.isTrue(
          isSafeRenderedMarkdownElementForTests(element),
          `${formula} ${tag.tagName}`,
        );
        for (const [name, value] of tag.attrs) {
          assert.isTrue(
            isSafeRenderedMarkdownAttributeForTests(element, name, value),
            `${formula} ${tag.tagName}.${name}=${value}`,
          );
        }
      }
    }
  });

  it("keeps non-KaTeX and unsafe SVG blocked in rendered Markdown", function () {
    const rawSvg = createSanitizerElement("svg");
    const rawPath = createSanitizerElement("path");
    const rawLine = createSanitizerElement("line");

    assert.isFalse(isSafeRenderedMarkdownElementForTests(rawSvg));
    assert.isFalse(isSafeRenderedMarkdownElementForTests(rawPath));
    assert.isFalse(isSafeRenderedMarkdownElementForTests(rawLine));

    const katexSvg = createKatexSvgElement("svg");
    const katexPath = createKatexSvgElement("path");
    const katexLine = createKatexSvgElement("line");
    const unsafeAttrs: Array<[Element, string, string]> = [
      [katexSvg, "onload", "alert(1)"],
      [katexSvg, "href", "https://example.com/x.svg"],
      [katexSvg, "xlink:href", "https://example.com/x.svg"],
      [katexSvg, "style", "background:url(https://example.com/x.svg)"],
      [katexSvg, "filter", "url(https://example.com/filter.svg#x)"],
      [katexSvg, "clip-path", "url(https://example.com/clip.svg#x)"],
      [katexSvg, "width", "url(https://example.com/x.svg)"],
      [katexPath, "href", "https://example.com/x.svg"],
      [katexPath, "style", "stroke:url(https://example.com/x.svg)"],
      [katexPath, "d", "M0 0 L10 10 url(https://example.com/x.svg)"],
      [katexLine, "xlink:href", "https://example.com/x.svg"],
      [katexLine, "style", "stroke:url(https://example.com/x.svg)"],
      [katexLine, "x1", "url(https://example.com/x.svg)"],
    ];

    for (const [element, name, value] of unsafeAttrs) {
      assert.isFalse(
        isSafeRenderedMarkdownAttributeForTests(element, name, value),
        `${name}=${value}`,
      );
    }
  });

  it("allows base64 SVG preview image sources in rendered Markdown", function () {
    const img = createSanitizerElement("img");

    assert.isTrue(
      isSafeRenderedMarkdownAttributeForTests(
        img,
        "src",
        "data:image/svg+xml;base64,PHN2Zy8+",
      ),
    );
    assert.isFalse(
      isSafeRenderedMarkdownAttributeForTests(
        img,
        "src",
        "data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E",
      ),
    );
  });

  it("preserves whitespace when compacting reasoning deltas", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          details: "Let me ",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          details: "read the paper first.",
        },
        createdAt: 2,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const reasoningItem = items.find((item) => item.type === "reasoning");

    assert.deepInclude(reasoningItem, {
      type: "reasoning",
      summary: "Let me read the paper first.",
      label: "Thinking",
    });
  });

  it("renders app-server reasoning item IDs as separate thinking steps", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          stepId: "reasoning-a",
          details: "First thought.",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "file_io",
          args: { action: "read", filePath: "/tmp/manifest.json" },
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          stepId: "reasoning-b",
          details: "Second thought.",
        },
        createdAt: 3,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const reasoningItems = items.filter((item) => item.type === "reasoning");

    assert.deepEqual(
      reasoningItems.map((item) =>
        item.type === "reasoning"
          ? { label: item.label, summary: item.summary }
          : null,
      ),
      [
        { label: "Thinking for step 1", summary: "First thought." },
        { label: "Thinking for step 2", summary: "Second thought." },
      ],
    );
  });

  it("renders Codex progress messages as separate activity messages", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "codex_progress",
        payload: {
          type: "codex_progress",
          itemId: "msg-progress",
          text: "I'm searching the Zotero library.",
          status: "running",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "codex_progress",
        payload: {
          type: "codex_progress",
          itemId: "msg-next",
          text: "Next I'm opening the matching records.",
          status: "running",
        },
        createdAt: 2,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null, {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
      modelProviderLabel: "Codex",
    });
    const progressMessages = items
      .filter(
        (item): item is Extract<(typeof items)[number], { type: "message" }> =>
          item.type === "message",
      )
      .map((item) => item.text);
    const codexProgressMessages = items.filter(
      (item): item is Extract<(typeof items)[number], { type: "message" }> =>
        item.type === "message" && item.text !== "Request sent to Codex.",
    );

    assert.includeMembers(progressMessages, [
      "I'm searching the Zotero library.",
      "Next I'm opening the matching records.",
    ]);
    assert.isTrue(codexProgressMessages.every((item) => item.markdown));
  });

  it("renders concrete Codex MCP tool activity rows", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "codex_tool_activity",
        payload: {
          type: "codex_tool_activity",
          itemId: "tool-1",
          phase: "started",
          toolName: "query_library",
          serverName: "llm_for_zotero",
          args: { entity: "items" },
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "codex_tool_activity",
        payload: {
          type: "codex_tool_activity",
          itemId: "tool-1",
          phase: "completed",
          toolName: "query_library",
          serverName: "llm_for_zotero",
          args: { entity: "items" },
        },
        createdAt: 2,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null, {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
      modelProviderLabel: "Codex",
    });
    const actionTexts = items
      .filter(
        (item): item is Extract<(typeof items)[number], { type: "action" }> =>
          item.type === "action",
      )
      .map((item) => item.row.text);

    assert.notInclude(actionTexts, "Using Query Library");
    assert.include(actionTexts, "Used Query Library");
  });

  it("dedupes adjacent identical Codex tool activity rows with different item IDs", function () {
    const args = {
      command:
        "rm -- '/Users/yat-lok/Desktop/Screenshot.png' && test ! -e '/Users/yat-lok/Desktop/Screenshot.png'",
      cwd: "/Users/yat-lok/Documents/zotero-dev/agent-runtime/profile-79d985cc",
      timeoutMs: 30000,
    };
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "codex_tool_activity",
        payload: {
          type: "codex_tool_activity",
          itemId: "native-command-1",
          phase: "completed",
          toolName: "run_command",
          toolLabel: "Run Command",
          args,
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "codex_tool_activity",
        payload: {
          type: "codex_tool_activity",
          itemId: "mcp-command-1",
          phase: "completed",
          toolName: "run_command",
          toolLabel: "Run Command",
          args,
        },
        createdAt: 2,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null, {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
      modelProviderLabel: "Codex",
    });
    const actionTexts = items
      .filter(
        (item): item is Extract<(typeof items)[number], { type: "action" }> =>
          item.type === "action",
      )
      .map((item) => item.row.text);

    assert.equal(
      actionTexts.filter((text) => text === "Used Run Command").length,
      1,
    );
  });

  it("renders one Codex MCP row for duplicate visible tool activity", function () {
    const args = {
      mode: "overview",
      target: {
        paperContext: {
          itemId: 3542,
          contextItemId: 3541,
          title: "Subspace communication in the hippocampal-retrosplenial axis",
          firstCreator: "Gonzalez et al.",
          year: "2026",
          citationKey: "gonzalezSubspaceCommunicationHippocampal2026",
          attachmentTitle: "PDF",
          contentSourceMode: "text",
        },
      },
      maxChars: 12000,
    };
    const events: AgentRunEventRecord[] = [
      codexToolActivityEvent(1, {
        type: "codex_tool_activity",
        itemId: "mcp-jsonrpc-1",
        phase: "completed",
        toolName: "paper_read",
        toolLabel: "Read Paper",
        serverName: "llm_for_zotero",
        args,
        ok: true,
      }),
      {
        runId: "run-1",
        seq: 2,
        eventType: "status",
        payload: {
          type: "status",
          text: "Compacting context…",
        },
        createdAt: 2,
      },
      codexToolActivityEvent(3, {
        type: "codex_tool_activity",
        itemId: "native-tool-item-1",
        phase: "completed",
        toolName: "mcp__llm_for_zotero__paper_read",
        toolLabel: "Read Paper",
        args,
      }),
    ];

    assert.deepEqual(getCodexTraceActionTexts(events), [
      "Codex received the request",
      "Used Read Paper",
    ]);
  });

  it("renders one Codex MCP row when duplicate arguments are serialized differently", function () {
    const args = {
      mode: "overview",
      target: {
        paperContext: {
          itemId: 3441,
          contextItemId: 3442,
          title: "Recurrent Models of Visual Attention",
          firstCreator: "Mnih et al.",
          year: "2014",
          citationKey: "mnihRecurrentModelsVisual2014",
          attachmentTitle: "PDF",
          contentSourceMode: "mineru",
          mineruCacheDir:
            "/Users/yat-lok/Documents/zotero-dev/llm-for-zotero-mineru/3442",
        },
      },
      maxChars: 6000,
    };
    const events: AgentRunEventRecord[] = [
      codexToolActivityEvent(1, {
        type: "codex_tool_activity",
        itemId: "mcp-jsonrpc-1",
        phase: "completed",
        toolName: "paper_read",
        toolLabel: "Read Paper",
        serverName: "llm_for_zotero",
        args,
        ok: true,
      }),
      codexToolActivityEvent(2, {
        type: "codex_tool_activity",
        itemId: "native-tool-item-1",
        phase: "completed",
        toolName: "mcp__llm_for_zotero__paper_read",
        toolLabel: "Read Paper",
        args: JSON.stringify(args),
      }),
    ];

    assert.deepEqual(getCodexTraceActionTexts(events), [
      "Codex received the request",
      "Used Read Paper",
    ]);
  });

  it("renders one Codex MCP row when duplicate identity is label versus tool name", function () {
    const args = {
      mode: "overview",
      target: {
        paperContext: {
          itemId: 3597,
          contextItemId: 3598,
          title:
            "Stochastic Gradient Descent-Induced Drift of Representation in a Two-Layer Neural Network",
        },
      },
      maxChars: 6000,
    };
    const events: AgentRunEventRecord[] = [
      codexToolActivityEvent(1, {
        type: "codex_tool_activity",
        itemId: "mcp-jsonrpc-1",
        phase: "completed",
        toolName: "paper_read",
        toolLabel: "Read Paper",
        args,
      }),
      codexToolActivityEvent(2, {
        type: "codex_tool_activity",
        itemId: "native-tool-item-1",
        phase: "completed",
        toolName: "mcp__llm_for_zotero__paper_read",
        args,
      }),
    ];

    assert.deepEqual(getCodexTraceActionTexts(events), [
      "Codex received the request",
      "Used Read Paper",
    ]);
  });

  it("keeps repeated Codex tool activity outside the duplicate window", function () {
    const args = {
      mode: "overview",
      target: {
        paperContext: {
          itemId: 3542,
          contextItemId: 3541,
          title: "Subspace communication in the hippocampal-retrosplenial axis",
        },
      },
      maxChars: 12000,
    };
    const events: AgentRunEventRecord[] = [
      codexToolActivityEvent(1, {
        type: "codex_tool_activity",
        itemId: "mcp-jsonrpc-1",
        phase: "completed",
        toolName: "paper_read",
        toolLabel: "Read Paper",
        args,
      }),
      codexToolActivityEvent(
        2,
        {
          type: "codex_tool_activity",
          itemId: "mcp-jsonrpc-2",
          phase: "completed",
          toolName: "paper_read",
          toolLabel: "Read Paper",
          args,
        },
        9002,
      ),
    ];

    assert.deepEqual(getCodexTraceActionTexts(events), [
      "Codex received the request",
      "Used Read Paper",
      "Used Read Paper",
    ]);
  });

  it("coalesces duplicate Codex native and MCP activity before rendering", function () {
    const args = {
      mode: "overview",
      target: {
        paperContext: {
          itemId: 3542,
          contextItemId: 3541,
          title: "Subspace communication in the hippocampal-retrosplenial axis",
        },
      },
      maxChars: 12000,
    };
    const assistantMessage = {
      role: "assistant" as const,
      text: "",
      timestamp: 1,
      runMode: "agent" as const,
      modelProviderLabel: "Codex",
    };
    const controller = createCodexNativeActivityTraceControllerForTests(
      assistantMessage,
      () => undefined,
    );

    controller.noteMcpToolActivity({
      requestId: "jsonrpc:1",
      phase: "completed",
      toolName: "paper_read",
      toolLabel: "Read Paper",
      arguments: args,
      ok: true,
    });
    controller.appendItemStatus(
      {
        id: "native-tool-item-1",
        type: "tool_call",
        name: "mcp__llm_for_zotero__paper_read",
        title: "Read Paper",
        serverName: "llm_for_zotero",
        arguments: args,
      },
      "completed",
    );

    const events = assistantMessage.pendingAgentTraceEvents || [];
    assert.lengthOf(
      events.filter((entry) => entry.payload.type === "codex_tool_activity"),
      1,
    );

    assert.deepEqual(getCodexTraceActionTexts(events), [
      "Codex received the request",
      "Used Read Paper",
    ]);
  });

  it("renders generated assistant images outside user screenshot UI", function () {
    const savedPathContainer = fakeDocument.createElement("div") as unknown as
      | HTMLElement
      | FakeElement;
    const renderedSavedPath = renderAssistantGeneratedImagesInto(
      savedPathContainer as HTMLElement,
      [
        {
          id: "img-1",
          label: "result.png",
          path: "/tmp/result.png",
          revisedPrompt: "A concise chart",
        },
      ],
      fakeDocument,
    );
    assert.isTrue(renderedSavedPath);
    const savedPathRoot = savedPathContainer as FakeElement;
    const savedImg = savedPathRoot.findByClass(
      "llm-assistant-generated-image",
    ) as unknown as { src?: string; alt?: string; title?: string } | null;
    assert.equal(savedImg?.src, "file:///tmp/result.png");
    assert.equal(savedImg?.alt, "result.png");
    assert.equal(savedImg?.title, "A concise chart");
    assert.isNull(savedPathRoot.findByClass("llm-user-screenshots-preview"));
    const savedActions = savedPathRoot.findAllByClass(
      "llm-generated-image-action",
    );
    assert.lengthOf(savedActions, 3);
    assert.isFalse(
      (
        savedPathRoot.findByClass(
          "llm-generated-image-action-open",
        ) as FakeElement | null
      )?.disabled,
    );
    const openClick = (
      savedPathRoot.findByClass(
        "llm-generated-image-action-open",
      ) as FakeElement
    ).dispatchFakeEvent("click");
    assert.isTrue(openClick.defaultPrevented);
    assert.isTrue(openClick.propagationStopped);
    assert.isTrue(openClick.immediatePropagationStopped);

    const dataUrlContainer = fakeDocument.createElement("div") as HTMLElement;
    assert.isTrue(
      renderAssistantGeneratedImagesInto(
        dataUrlContainer,
        [{ id: "img-2", src: "data:image/png;base64,abc123" }],
        fakeDocument,
      ),
    );
    const dataImg = (dataUrlContainer as unknown as FakeElement).findByClass(
      "llm-assistant-generated-image",
    ) as unknown as { src?: string } | null;
    assert.equal(dataImg?.src, "data:image/png;base64,abc123");
    assert.isTrue(
      (
        (dataUrlContainer as unknown as FakeElement).findByClass(
          "llm-generated-image-action-open",
        ) as FakeElement | null
      )?.disabled,
    );

    const opaqueContainer = fakeDocument.createElement("div") as HTMLElement;
    assert.isFalse(
      renderAssistantGeneratedImagesInto(
        opaqueContainer,
        [{ id: "img-3", src: "opaque-result-id" }],
        fakeDocument,
      ),
    );
  });

  it("saves generated assistant images through the Zotero file picker", async function () {
    const globalScope = globalThis as typeof globalThis & {
      IOUtils?: {
        read?: (path: string) => Promise<Uint8Array>;
        copy?: (sourcePath: string, destPath: string) => Promise<void>;
      };
      Zotero?: {
        getMainWindow?: () => unknown;
        FilePicker?: new () => {
          modeSave: number;
          returnOK: number;
          returnReplace: number;
          filterAll: number;
          defaultString?: string;
          defaultExtension?: string;
          file?: string | { path?: string };
          init: (parent: unknown, title: string, mode: number) => void;
          appendFilter: (title: string, filter: string) => void;
          appendFilters: (filterMask: number) => void;
          show: () => Promise<number>;
        };
      };
      ztoolkit?: { log?: (...args: unknown[]) => void };
    };
    const originalIOUtils = globalScope.IOUtils;
    const originalZotero = globalScope.Zotero;
    const originalZtoolkit = globalScope.ztoolkit;
    const copied: Array<{ sourcePath: string; destPath: string }> = [];
    let pickerDefaultString = "";
    globalScope.IOUtils = {
      read: async (path: string) => {
        assert.equal(path, "/tmp/result.png");
        return new Uint8Array([7, 8, 9]);
      },
      copy: async (sourcePath: string, destPath: string) => {
        copied.push({ sourcePath, destPath });
      },
    };
    class FakeFilePicker {
      modeSave = 1;
      returnOK = 0;
      returnReplace = 1;
      filterAll = 2;
      file = "/tmp/saved-result.png";
      defaultExtension = "";
      set defaultString(value: string) {
        pickerDefaultString = value;
      }
      get defaultString() {
        return pickerDefaultString;
      }
      init(parent: unknown, title: string, mode: number) {
        assert.equal(parent, fakeMainWindow);
        assert.equal(title, "Save generated image");
        assert.equal(mode, 1);
      }
      appendFilter(_title: string, _filter: string) {}
      appendFilters(_filterMask: number) {}
      async show() {
        return 0;
      }
    }
    const fakeMainWindow = { browsingContext: { id: "main" } };
    globalScope.Zotero = {
      ...(originalZotero || {}),
      getMainWindow: () => fakeMainWindow,
      FilePicker: FakeFilePicker,
    };
    globalScope.ztoolkit = {
      ...(originalZtoolkit || {}),
      log: () => {},
    };

    try {
      const container = fakeDocument.createElement("div") as HTMLElement;
      const statuses: string[] = [];
      assert.isTrue(
        renderAssistantGeneratedImagesInto(
          container,
          [{ id: "img-save", label: "result.png", path: "/tmp/result.png" }],
          fakeDocument,
          {
            onImageActionStatus: (message) => statuses.push(message),
          },
        ),
      );
      const saveButton = (container as unknown as FakeElement).findByClass(
        "llm-generated-image-action-save",
      ) as FakeElement;

      const saveClick = await saveButton.dispatchFakeEventAsync("click");
      assert.isTrue(saveClick.defaultPrevented);
      assert.isTrue(saveClick.propagationStopped);
      assert.equal(pickerDefaultString, "result.png");
      assert.deepEqual(copied, [
        { sourcePath: "/tmp/result.png", destPath: "/tmp/saved-result.png" },
      ]);
      assert.deepEqual(statuses, ["Saved image"]);
    } finally {
      if (originalIOUtils) {
        globalScope.IOUtils = originalIOUtils;
      } else {
        delete globalScope.IOUtils;
      }
      if (originalZotero) {
        globalScope.Zotero = originalZotero;
      } else {
        delete globalScope.Zotero;
      }
      if (originalZtoolkit) {
        globalScope.ztoolkit = originalZtoolkit;
      } else {
        delete globalScope.ztoolkit;
      }
    }
  });

  it("passes browsingContext to the XPCOM generated-image save picker fallback", async function () {
    const globalScope = globalThis as typeof globalThis & {
      IOUtils?: {
        read?: (path: string) => Promise<Uint8Array>;
        copy?: (sourcePath: string, destPath: string) => Promise<void>;
      };
      Zotero?: {
        getMainWindow?: () => unknown;
        FilePicker?: unknown;
      };
      Components?: {
        classes?: Record<
          string,
          { createInstance?: (iface: unknown) => unknown }
        >;
        interfaces?: {
          nsIFilePicker?: {
            modeSave: number;
            returnOK: number;
            returnReplace: number;
            filterAll: number;
          };
        };
      };
      ChromeUtils?: {
        importESModule?: (url: string) => unknown;
      };
      ztoolkit?: { log?: (...args: unknown[]) => void };
    };
    const originalIOUtils = globalScope.IOUtils;
    const originalZotero = globalScope.Zotero;
    const originalComponents = globalScope.Components;
    const originalChromeUtils = globalScope.ChromeUtils;
    const originalZtoolkit = globalScope.ztoolkit;
    const browsingContext = { id: "main-browsing-context" };
    const copied: Array<{ sourcePath: string; destPath: string }> = [];
    let initParent: unknown = null;
    globalScope.IOUtils = {
      read: async () => new Uint8Array([7, 8, 9]),
      copy: async (sourcePath: string, destPath: string) => {
        copied.push({ sourcePath, destPath });
      },
    };
    globalScope.Zotero = {
      ...(originalZotero || {}),
      getMainWindow: () => ({ browsingContext }),
      FilePicker: undefined,
    };
    globalScope.ChromeUtils = {
      importESModule: () => {
        throw new Error("module import unavailable");
      },
    };
    const nsIFilePicker = {
      modeSave: 1,
      returnOK: 0,
      returnReplace: 2,
      filterAll: 1,
    };
    globalScope.Components = {
      classes: {
        "@mozilla.org/filepicker;1": {
          createInstance: () => ({
            file: { path: "/tmp/xpcom-saved-result.png" },
            set defaultString(_value: string) {
              throw new Error("defaultString unavailable");
            },
            init: (parent: unknown, title: string, mode: number) => {
              initParent = parent;
              assert.equal(title, "Save generated image");
              assert.equal(mode, nsIFilePicker.modeSave);
            },
            appendFilter: () => {},
            appendFilters: () => {},
            open: (callback: (result: number) => void) =>
              callback(nsIFilePicker.returnOK),
          }),
        },
      },
      interfaces: { nsIFilePicker },
    };
    globalScope.ztoolkit = {
      ...(originalZtoolkit || {}),
      log: () => {},
    };

    try {
      const container = fakeDocument.createElement("div") as HTMLElement;
      const statuses: string[] = [];
      assert.isTrue(
        renderAssistantGeneratedImagesInto(
          container,
          [{ id: "img-xpcom", label: "result.png", path: "/tmp/result.png" }],
          fakeDocument,
          {
            onImageActionStatus: (message) => statuses.push(message),
          },
        ),
      );
      const saveButton = (container as unknown as FakeElement).findByClass(
        "llm-generated-image-action-save",
      ) as FakeElement;

      await saveButton.dispatchFakeEventAsync("click");

      assert.equal(initParent, browsingContext);
      assert.deepEqual(copied, [
        {
          sourcePath: "/tmp/result.png",
          destPath: "/tmp/xpcom-saved-result.png",
        },
      ]);
      assert.deepEqual(statuses, ["Saved image"]);
    } finally {
      if (originalIOUtils) {
        globalScope.IOUtils = originalIOUtils;
      } else {
        delete globalScope.IOUtils;
      }
      if (originalZotero) {
        globalScope.Zotero = originalZotero;
      } else {
        delete globalScope.Zotero;
      }
      if (originalComponents) {
        globalScope.Components = originalComponents;
      } else {
        delete globalScope.Components;
      }
      if (originalChromeUtils) {
        globalScope.ChromeUtils = originalChromeUtils;
      } else {
        delete globalScope.ChromeUtils;
      }
      if (originalZtoolkit) {
        globalScope.ztoolkit = originalZtoolkit;
      } else {
        delete globalScope.ztoolkit;
      }
    }
  });

  it("treats image-only assistant responses as response-menu targets", function () {
    const imageOnly = {
      text: "",
      generatedImages: [
        {
          id: "img-only",
          label: "result.png",
          src: "file:///tmp/result.png",
        },
      ],
    };

    assert.isTrue(shouldAttachAssistantResponseContextMenu(imageOnly));
    const fullTarget = resolveAssistantResponseMenuContent(imageOnly);
    assert.deepEqual(fullTarget, {
      contentText: "",
      generatedImages: [
        {
          id: "img-only",
          label: "result.png",
          src: "file:///tmp/result.png",
        },
      ],
    });

    const selectedTarget = resolveAssistantResponseMenuContent(
      imageOnly,
      "selected words",
    );
    assert.deepEqual(selectedTarget, { contentText: "selected words" });
    assert.isFalse(shouldAttachAssistantResponseContextMenu({ text: "" }));
  });

  it("resolves generated image assets from paths, file URLs, and data URLs", async function () {
    const globalScope = globalThis as typeof globalThis & {
      IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
    };
    const originalIOUtils = globalScope.IOUtils;
    const readPaths: string[] = [];
    globalScope.IOUtils = {
      read: async (path: string) => {
        readPaths.push(path);
        assert.equal(path, "/tmp/result.png");
        return new Uint8Array([7, 8, 9]);
      },
    };
    try {
      const pathAsset = await resolveGeneratedImageAsset({
        id: "img-path",
        label: "result.png",
        path: "/tmp/result.png",
      });
      assert.deepEqual(Array.from(pathAsset?.bytes || []), [7, 8, 9]);
      assert.equal(pathAsset?.mimeType, "image/png");
      assert.equal(pathAsset?.fileName, "result.png");
      assert.equal(pathAsset?.fileUrl, "file:///tmp/result.png");

      const fileUrlImage = {
        id: "img-file-url",
        label: "result.png",
        src: "file:///tmp/result.png",
      };
      assert.isTrue(isEmbeddableGeneratedImage(fileUrlImage));
      const fileUrlAsset = await resolveGeneratedImageAsset(fileUrlImage);
      assert.deepEqual(Array.from(fileUrlAsset?.bytes || []), [7, 8, 9]);
      assert.equal(fileUrlAsset?.mimeType, "image/png");
      assert.equal(fileUrlAsset?.fileName, "result.png");
      assert.equal(fileUrlAsset?.path, "/tmp/result.png");
      assert.equal(fileUrlAsset?.fileUrl, "file:///tmp/result.png");

      const dataAsset = await resolveGeneratedImageAsset({
        id: "img-data",
        label: "inline",
        src: "data:image/png;base64,AQID",
      });
      assert.deepEqual(Array.from(dataAsset?.bytes || []), [1, 2, 3]);
      assert.equal(dataAsset?.mimeType, "image/png");
      assert.equal(dataAsset?.fileName, "inline.png");
      assert.deepEqual(readPaths, ["/tmp/result.png", "/tmp/result.png"]);
    } finally {
      if (originalIOUtils) {
        globalScope.IOUtils = originalIOUtils;
      } else {
        delete globalScope.IOUtils;
      }
    }
  });

  it("renders full expandable details for long Codex trace values", function () {
    const longQuery =
      "Anticevic Cole Repovs Savic Driesen connectivity pharmacology computational psychiatry";
    const longUrl =
      "https://www.frontiersin.org/journals/psychiatry/articles/10.3389/fpsyt.2013.00169/full";
    const longPath =
      "/tmp/codex/screenshots/frontiers-article-page-0001-full-width.png";
    const command = `python scripts/fetch.py --url ${longUrl}`;
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "codex_tool_activity",
        payload: {
          type: "codex_tool_activity",
          itemId: "web-1",
          phase: "completed",
          toolName: "codex_web_search",
          toolLabel: "Opened web page",
          args: {
            query: longQuery,
            url: longUrl,
            pattern: "connectivity pharmacology",
          },
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "codex_tool_activity",
        payload: {
          type: "codex_tool_activity",
          itemId: "image-1",
          phase: "completed",
          toolName: "image_view",
          toolLabel: "Viewed image",
          args: { path: longPath },
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "codex_tool_activity",
        payload: {
          type: "codex_tool_activity",
          itemId: "cmd-1",
          phase: "completed",
          toolName: "command",
          toolLabel: "Command",
          args: { status: "exit 0" },
          codeBlock: command,
        },
        createdAt: 3,
      },
    ];

    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: {
        role: "assistant",
        text: "",
        timestamp: 1,
        runMode: "agent",
        modelProviderLabel: "Codex",
      },
      events,
    }) as unknown as FakeElement;

    const values = trace
      .findAllByClass("llm-agent-process-detail-value")
      .map(collectFakeText);
    assert.include(values, longQuery);
    assert.include(values, longUrl);
    assert.include(values, "connectivity pharmacology");
    assert.include(values, longPath);
    assert.include(values, command);
    assert.isEmpty(trace.findAllByClass("llm-at-expand"));

    const chipLabels = trace
      .findAllByClass("llm-agent-process-chip-label")
      .map(collectFakeText);
    assert.includeMembers(chipLabels, [
      "Query",
      "URL",
      "Pattern",
      "Path",
      "Status",
    ]);
    assert.isFalse(chipLabels.some((label) => label.includes("...")));
  });

  it("renders full expandable details for request context chips", function () {
    const longPaperTitle =
      "A very long paper title about hippocampal attractor dynamics and entorhinal grid cell scaffolds across episodic memory";
    const longSelectedText = [
      "This is a long selected passage from the paper that should remain fully available",
      "inside the expanded agent trace details instead of disappearing behind a chip.",
    ].join(" ");
    const longFileName =
      "supplementary-analysis-notebook-with-long-descriptive-filename-and-version-history.md";
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "final",
        payload: { type: "final", text: "Done." },
        createdAt: 1,
      },
    ];

    const trace = renderAgentTrace({
      doc: fakeDocument,
      userMessage: {
        role: "user",
        text: "Use this context.",
        timestamp: 1,
        selectedTexts: [longSelectedText],
        selectedTextSources: ["pdf"],
        paperContexts: [
          {
            itemId: 10,
            contextItemId: 11,
            title: longPaperTitle,
          },
        ],
        attachments: [
          {
            id: "file-1",
            name: longFileName,
            mimeType: "text/markdown",
            sizeBytes: 42,
            category: "markdown",
          },
        ],
      },
      message: {
        role: "assistant",
        text: "Done.",
        timestamp: 2,
        runMode: "agent",
        modelProviderLabel: "OpenAI",
      },
      events,
    }) as unknown as FakeElement;

    const values = trace
      .findAllByClass("llm-agent-process-detail-value")
      .map(collectFakeText);
    assert.include(values, longPaperTitle);
    assert.include(values, longSelectedText);
    assert.include(values, longFileName);

    const chipLabels = trace
      .findAllByClass("llm-agent-process-chip-label")
      .map(collectFakeText);
    assert.includeMembers(chipLabels, ["Paper", "Selected text", "File"]);
    assert.isFalse(chipLabels.some((label) => label.includes("...")));
  });

  it("preserves custom chip title and long label values as details", function () {
    const longTitle =
      "https://example.org/articles/with/a/very/long/path/that/must/remain/recoverable";
    const longLabel =
      "Custom tool output with a long label that should become an expandable detail value";

    assert.deepEqual(
      buildAgentTraceChipDetails({ label: "URL", title: longTitle }),
      [{ label: "URL", value: longTitle, kind: "url" }],
    );
    assert.deepEqual(buildAgentTraceChipDetails({ label: longLabel }), [
      { label: "Detail", value: longLabel, kind: "text" },
    ]);
  });

  it("does not ellipsize agent trace chip labels in CSS", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const chipLabelRule =
      css.match(/\.llm-agent-process-chip-label\s*\{[\s\S]*?\}/)?.[0] || "";

    assert.include(chipLabelRule, "white-space: normal");
    assert.include(chipLabelRule, "overflow: visible");
    assert.include(chipLabelRule, "text-overflow: clip");
    assert.notInclude(chipLabelRule, "text-overflow: ellipsis");
  });

  it("falls back to a Zotero MCP tool label when Codex omits the exact tool name", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "codex_tool_activity",
        payload: {
          type: "codex_tool_activity",
          itemId: "tool-unknown",
          phase: "started",
          serverName: "llm_for_zotero",
        },
        createdAt: 1,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null, {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
      modelProviderLabel: "Codex",
    });
    const actionTexts = items
      .filter(
        (item): item is Extract<(typeof items)[number], { type: "action" }> =>
          item.type === "action",
      )
      .map((item) => item.row.text);

    assert.include(actionTexts, "Using Zotero MCP tool");
  });

  it("compacts same app-server reasoning item IDs into one thinking step", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          stepId: "reasoning-a",
          details: "Read ",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          stepId: "reasoning-a",
          details: "manifest.",
        },
        createdAt: 2,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const reasoningItems = items.filter((item) => item.type === "reasoning");

    assert.lengthOf(reasoningItems, 1);
    assert.deepInclude(reasoningItems[0], {
      type: "reasoning",
      label: "Thinking for step 1",
      summary: "Read manifest.",
    });
  });

  it("renders Codex traces around app-server concepts", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "status",
        payload: {
          type: "status",
          text: "Running agent",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          stepId: "reasoning-a",
          details: "Inspecting Zotero context.",
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "search_library",
          args: { query: "memory" },
        },
        createdAt: 3,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null, {
      role: "assistant",
      text: "Done.",
      timestamp: 10,
      modelProviderLabel: "Codex",
    });

    assert.deepInclude(items[0], {
      type: "message",
      tone: "neutral",
      text: "Request sent to Codex.",
    });
    assert.deepInclude(items[1], {
      type: "action",
      row: {
        kind: "plan",
        icon: "↳",
        text: "Codex received the request",
      },
      chips: [],
    });
    assert.deepInclude(
      items.find((item) => item.type === "reasoning"),
      {
        type: "reasoning",
        label: "Codex reasoning 1",
        summary: "Inspecting Zotero context.",
      },
    );
    assert.isFalse(
      items.some(
        (item) => item.type === "action" && item.row.text === "Running agent",
      ),
    );
  });

  it("splits reasoning into a new thinking block after a tool call", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          details: "First thought.",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "Read",
          args: {},
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          details: "Second thought.",
        },
        createdAt: 3,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const reasoningItems = items.filter((item) => item.type === "reasoning");

    assert.lengthOf(reasoningItems, 2);
    assert.deepInclude(reasoningItems[0], {
      type: "reasoning",
      summary: "First thought.",
      label: "Thinking",
    });
    assert.deepInclude(reasoningItems[1], {
      type: "reasoning",
      summary: "Second thought.",
      label: "Thinking",
    });
  });

  it("uses a single primary action surface for multi-action review cards", function () {
    const action: AgentPendingAction = {
      toolName: "search_literature_online",
      mode: "review",
      title: "Review online search results",
      actions: [
        { id: "import", label: "Import selected", style: "primary" },
        { id: "save_note", label: "Save selected as note", style: "secondary" },
        { id: "new_search", label: "Search again", style: "secondary" },
        { id: "cancel", label: "Cancel", style: "secondary" },
      ],
      defaultActionId: "import",
      cancelActionId: "cancel",
      fields: [],
    };

    assert.deepEqual(getPendingActionButtonLayout(action), {
      hasActionChooser: true,
      showsFooterExecuteButton: false,
    });
  });

  it("shows a footer execute button when a multi-action review needs extra input", function () {
    const action: AgentPendingAction = {
      toolName: "search_literature_online",
      mode: "review",
      title: "Review online literature results",
      actions: [
        { id: "import", label: "Import selected", style: "primary" },
        { id: "save_note", label: "Save selected as note", style: "secondary" },
        { id: "new_search", label: "Search again", style: "secondary" },
        { id: "cancel", label: "Cancel", style: "secondary" },
      ],
      defaultActionId: "import",
      cancelActionId: "cancel",
      fields: [
        {
          type: "text",
          id: "nextQuery",
          label: "Next search query",
          value: "plasticity",
          visibleForActionIds: ["new_search"],
          requiredForActionIds: ["new_search"],
        },
      ],
    };

    assert.deepEqual(getPendingActionButtonLayout(action), {
      hasActionChooser: true,
      showsFooterExecuteButton: true,
    });
  });

  it("keeps the footer execute button for legacy confirm-cancel cards", function () {
    const action: AgentPendingAction = {
      toolName: "update_metadata",
      title: "Confirm library change",
      confirmLabel: "Apply",
      cancelLabel: "Cancel",
      fields: [],
    };

    assert.deepEqual(getPendingActionButtonLayout(action), {
      hasActionChooser: false,
      showsFooterExecuteButton: true,
    });
  });

  it("renders run_command commands as a read-only code preview", function () {
    const command = 'python3 analyze.py --input "data set.csv"';
    const action: AgentPendingAction = {
      toolName: "run_command",
      title: "Run shell command",
      description: "Execute a command on your local machine.",
      confirmLabel: "Run",
      cancelLabel: "Cancel",
      fields: [
        {
          type: "code_preview",
          id: "command",
          label: "Command",
          value: command,
          language: "sh",
        },
        {
          type: "text",
          id: "cwd",
          label: "Working directory",
          value: "/tmp/project",
        },
      ],
    };

    const card = renderPendingActionCard(fakeDocument, {
      requestId: "run-command-preview",
      action,
    }) as unknown as FakeElement;
    const preview = card.findByClass("llm-agent-hitl-code-preview");
    const code = preview?.findAllByTag("code")[0];
    const inputs = card.findAllByTag("input");

    assert.exists(preview);
    assert.exists(code);
    assert.equal(code?.textContent, command);
    assert.equal(code?.attributes["data-language"], "sh");
    assert.lengthOf(inputs, 1);
    assert.equal(
      (inputs[0] as FakeElement & { value?: string }).value,
      "/tmp/project",
    );
  });

  it("renders paged review controls with refresh in the card header and navigation split across the footer", function () {
    const action: AgentPendingAction = {
      toolName: "move_to_collection",
      mode: "review",
      title: "Page 2 of 5: Add to collection",
      description: "Select the destination collection for each paper.",
      actions: [
        { id: "previous", label: "Previous page", style: "secondary" },
        { id: "confirm", label: "Confirm", style: "primary" },
        { id: "refresh", label: "Refresh", style: "secondary" },
        { id: "cancel", label: "Cancel", style: "secondary" },
        { id: "next", label: "Next page", style: "secondary" },
      ],
      defaultActionId: "next",
      cancelActionId: "cancel",
      fields: [
        {
          type: "select",
          id: "tagsPerPaper",
          label: "Tags per paper",
          value: "5",
          options: [
            { id: "1", label: "1" },
            { id: "2", label: "2" },
            { id: "3", label: "3" },
            { id: "4", label: "4" },
            { id: "5", label: "5" },
            { id: "6", label: "6" },
          ],
        },
        {
          type: "select",
          id: "pageSize",
          label: "Items on this page",
          value: "20",
          options: [
            { id: "10", label: "10" },
            { id: "20", label: "20" },
            { id: "50", label: "50" },
            { id: "100", label: "100" },
          ],
        },
      ],
    };

    const card = renderPendingActionCard(fakeDocument, {
      requestId: "paged-review",
      action,
    }) as unknown as FakeElement;

    assert.exists(card.findByClass("llm-agent-hitl-refresh-btn"));
    assert.isNull(card.findByClass("llm-agent-hitl-action-choices"));
    assert.equal(
      card.findByClass("llm-agent-hitl-header")?.textContent,
      "Action required",
    );
    const topControls = card.findByClass("llm-agent-hitl-paged-top-controls");
    assert.equal(
      (
        topControls
          ?.findByClass("llm-agent-hitl-paged-top-field")
          ?.findAllByTag("select")[0] as
          | (FakeElement & { value?: string })
          | undefined
      )?.value,
      "5",
    );
    assert.equal(
      topControls
        ?.findByClass("llm-agent-hitl-paged-top-field")
        ?.findAllByTag("label")[0]?.textContent,
      "of tags per paper",
    );

    const footer = card.findByClass("llm-agent-hitl-paged-actions");
    const left = footer?.findByClass("llm-agent-hitl-paged-actions-left");
    const center = footer?.findByClass("llm-agent-hitl-paged-actions-center");
    const right = footer?.findByClass("llm-agent-hitl-paged-actions-right");

    assert.exists(footer);
    assert.equal(left?.findAllByTag("button")[0]?.textContent, "Previous page");
    assert.equal(right?.findAllByTag("button")[0]?.textContent, "Next page");
    assert.equal(
      center?.findByClass("llm-agent-hitl-page-indicator")?.textContent,
      "Page 2 of 5",
    );
    assert.equal(
      center
        ?.findByClass("llm-agent-hitl-paged-footer-field")
        ?.findAllByTag("label")[0]?.textContent,
      "items on this page",
    );
    assert.equal(
      center
        ?.findByClass("llm-agent-hitl-paged-footer-field")
        ?.findAllByTag("label")[0]?.title,
      "Items on this page",
    );
    assert.equal(
      center
        ?.findByClass("llm-agent-hitl-paged-footer-field")
        ?.findAllByTag("select")[0]
        ?.findAllByTag("option")[1]?.textContent,
      "20",
    );
  });

  it("wraps pending review actions in a single filled shell", function () {
    const action: AgentPendingAction = {
      toolName: "move_to_collection",
      mode: "review",
      title: "Page 1 of 5: Add to collection",
      description: "Select the destination collection for each paper.",
      actions: [
        { id: "confirm", label: "Confirm", style: "primary" },
        { id: "cancel", label: "Cancel", style: "secondary" },
        { id: "next", label: "Next page", style: "secondary" },
      ],
      defaultActionId: "next",
      cancelActionId: "cancel",
      fields: [
        {
          type: "select",
          id: "pageSize",
          label: "Items on this page",
          value: "20",
          options: [{ id: "20", label: "20" }],
        },
      ],
    };
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "confirmation_required",
        payload: {
          type: "confirmation_required",
          requestId: "pending-review",
          action,
        },
        createdAt: 1,
      },
    ];

    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: {
        role: "assistant",
        text: "",
        timestamp: 1,
        runMode: "agent",
      },
      events,
    }) as unknown as FakeElement;
    const shell = trace.findByClass("llm-agent-pending-action-shell");

    assert.isTrue(
      trace.classList.contains("llm-agent-activity-with-pending-action"),
    );
    assert.exists(shell);
    assert.exists(shell?.findByClass("llm-agent-hitl-card"));
  });

  it("removes repetitive filler chatter between tool steps", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "read_paper",
          args: { operation: "front_matter" },
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "call-1",
          name: "read_paper",
          ok: true,
          content: { operation: "front_matter", results: [{}] },
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-2",
          name: "search_paper",
          args: { operation: "retrieve_evidence" },
        },
        createdAt: 3,
      },
      {
        runId: "run-1",
        seq: 4,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "Answer text",
        },
        createdAt: 4,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const messageTexts = items
      .filter(
        (item): item is Extract<(typeof items)[number], { type: "message" }> =>
          item.type === "message",
      )
      .map((item) => item.text);
    const actionTexts = items
      .filter(
        (item): item is Extract<(typeof items)[number], { type: "action" }> =>
          item.type === "action",
      )
      .map((item) => item.row.text);

    assert.notInclude(
      messageTexts.join("\n"),
      "I'm ready for the next step, so I'm using",
    );
    assert.notInclude(
      messageTexts.join("\n"),
      "I have enough grounded information now",
    );
    assert.include(actionTexts, "Drafting answer");
  });

  it("keeps original-agent tool then final answer owned by the assistant bubble", function () {
    const finalText = "The final answer has $r(x)=g(Vx)$.";
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "read_paper",
          args: { operation: "front_matter" },
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: finalText,
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "final",
        payload: {
          type: "final",
          text: finalText,
        },
        createdAt: 3,
      },
    ];

    const { items, isInterleaved, inlineTextReplacesAssistantText } =
      buildAgentTraceDisplayItems(events, null, {
        role: "assistant",
        text: finalText,
        timestamp: 1,
        runMode: "agent",
        modelProviderLabel: "deepseek-v4-flash",
      });

    assert.isFalse(isInterleaved);
    assert.isFalse(inlineTextReplacesAssistantText);
    assert.isFalse(items.some((item) => item.type === "inline_text"));
    assert.isTrue(
      shouldAttachAssistantResponseContextMenu({ text: finalText }),
    );
  });

  it("keeps unique original-agent interleaved text in trace and final answer in the assistant bubble", function () {
    const scratchText = "I need to read the theoretical section first.";
    const finalText = "The final answer has $r(x)=g(Vx)$.";
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: scratchText,
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "read_paper",
          args: { operation: "full_text" },
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: finalText,
        },
        createdAt: 3,
      },
      {
        runId: "run-1",
        seq: 4,
        eventType: "final",
        payload: {
          type: "final",
          text: finalText,
        },
        createdAt: 4,
      },
    ];

    const { items, isInterleaved, inlineTextReplacesAssistantText } =
      buildAgentTraceDisplayItems(events, null, {
        role: "assistant",
        text: finalText,
        timestamp: 1,
        runMode: "agent",
        modelProviderLabel: "deepseek-v4-flash",
      });
    const inlineTexts = items
      .filter(
        (
          item,
        ): item is Extract<(typeof items)[number], { type: "inline_text" }> =>
          item.type === "inline_text",
      )
      .map((item) => item.text);

    assert.isTrue(isInterleaved);
    assert.isFalse(inlineTextReplacesAssistantText);
    assert.deepEqual(inlineTexts, [scratchText]);
    assert.isTrue(
      shouldAttachAssistantResponseContextMenu({ text: finalText }),
    );
  });

  it("suppresses original-agent duplicate inline final text without suppressing the assistant bubble", function () {
    const finalText = "The final answer has $r(x)=g(Vx)$.";
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: finalText,
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "read_paper",
          args: { operation: "full_text" },
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "final",
        payload: {
          type: "final",
          text: finalText,
        },
        createdAt: 3,
      },
    ];

    const { items, isInterleaved, inlineTextReplacesAssistantText } =
      buildAgentTraceDisplayItems(events, null, {
        role: "assistant",
        text: finalText,
        timestamp: 1,
        runMode: "agent",
        modelProviderLabel: "deepseek-v4-flash",
      });

    assert.isTrue(isInterleaved);
    assert.isFalse(inlineTextReplacesAssistantText);
    assert.isFalse(items.some((item) => item.type === "inline_text"));
    assert.isTrue(
      shouldAttachAssistantResponseContextMenu({ text: finalText }),
    );
  });

  it("does not mark rolled-back scratch text as interleaved", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "Let me inspect this first.",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "message_rollback",
        payload: {
          type: "message_rollback",
          length: "Let me inspect this first.".length,
          text: "Let me inspect this first.",
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "read_paper",
          args: { operation: "front_matter" },
        },
        createdAt: 3,
      },
    ];

    const { items, isInterleaved } = buildAgentTraceDisplayItems(events, null);
    const messageTexts = items
      .filter(
        (item): item is Extract<(typeof items)[number], { type: "message" }> =>
          item.type === "message",
      )
      .map((item) => item.text);

    assert.isFalse(isInterleaved);
    assert.isFalse(items.some((item) => item.type === "inline_text"));
    assert.notInclude(messageTexts, "Let me inspect this first.");
  });

  it("shows rolled-back Codex scratch text inline before the tool call", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "I'm reading the parsed paper text.",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "message_rollback",
        payload: {
          type: "message_rollback",
          length: "I'm reading the parsed paper text.".length,
          text: "I'm reading the parsed paper text.",
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "read_paper",
          args: { operation: "full_text" },
        },
        createdAt: 3,
      },
      {
        runId: "run-1",
        seq: 4,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "call-1",
          name: "read_paper",
          ok: true,
          content: { ok: true, filePath: "/tmp/full.md", chars: 81283 },
        },
        createdAt: 4,
      },
      {
        runId: "run-1",
        seq: 5,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "This paper is about working memory.",
        },
        createdAt: 5,
      },
      {
        runId: "run-1",
        seq: 6,
        eventType: "final",
        payload: {
          type: "final",
          text: "This paper is about working memory.",
        },
        createdAt: 6,
      },
    ];

    const { items, isInterleaved, inlineTextReplacesAssistantText } =
      buildAgentTraceDisplayItems(events, null, {
        role: "assistant",
        text: "This paper is about working memory.",
        timestamp: 1,
        runMode: "agent",
        modelProviderLabel: "Codex",
      });
    const inlineTexts = items
      .filter(
        (
          item,
        ): item is Extract<(typeof items)[number], { type: "inline_text" }> =>
          item.type === "inline_text",
      )
      .map((item) => item.text);
    const scratchIndex = items.findIndex(
      (item) =>
        item.type === "inline_text" &&
        item.text === "I'm reading the parsed paper text.",
    );
    const toolIndex = items.findIndex(
      (item) => item.type === "action" && item.row.kind === "tool",
    );
    const finalIndex = items.findIndex(
      (item) =>
        item.type === "inline_text" &&
        item.text === "This paper is about working memory.",
    );
    const messageTexts = items
      .filter(
        (item): item is Extract<(typeof items)[number], { type: "message" }> =>
          item.type === "message",
      )
      .map((item) => item.text);
    const doneActions = items.filter(
      (item) => item.type === "action" && item.row.kind === "done",
    );

    assert.isTrue(isInterleaved);
    assert.isFalse(inlineTextReplacesAssistantText);
    assert.deepEqual(inlineTexts, ["I'm reading the parsed paper text."]);
    assert.isAtLeast(scratchIndex, 0);
    assert.isAtLeast(toolIndex, 0);
    assert.equal(finalIndex, -1);
    assert.isBelow(scratchIndex, toolIndex);
    assert.notInclude(messageTexts, "This paper is about working memory.");
    assert.lengthOf(doneActions, 1);
  });

  it("keeps the response menu available for Codex interleaved final text", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "I need to read the paper first.",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "read_paper",
          args: { operation: "full_text" },
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "The paper argues that context switching changes recall.",
        },
        createdAt: 3,
      },
      {
        runId: "run-1",
        seq: 4,
        eventType: "final",
        payload: {
          type: "final",
          text: "The paper argues that context switching changes recall.",
        },
        createdAt: 4,
      },
    ];

    const { isInterleaved, inlineTextReplacesAssistantText } =
      buildAgentTraceDisplayItems(events, null, {
        role: "assistant",
        text: "The paper argues that context switching changes recall.",
        timestamp: 1,
        runMode: "agent",
        modelProviderLabel: "Codex",
      });

    assert.isTrue(isInterleaved);
    assert.isFalse(inlineTextReplacesAssistantText);
    assert.isTrue(
      shouldAttachAssistantResponseContextMenu({
        text: "The paper argues that context switching changes recall.",
      }),
    );
  });

  it("uses the normal assistant bubble for completed interleaved final text", function () {
    const finalText =
      "Here is the paper evidence.\n\n" +
      "> The scaffold states can be used for content-addressable memory.\n\n" +
      "(Chandra et al., 2025)";
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "I need to read the paper section first.",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "file_io",
          args: {
            action: "read",
            filePath: "/tmp/llm-for-zotero-mineru/51/full.md",
          },
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: finalText,
        },
        createdAt: 3,
      },
      {
        runId: "run-1",
        seq: 4,
        eventType: "final",
        payload: {
          type: "final",
          text: finalText,
        },
        createdAt: 4,
      },
    ];

    const { items, isInterleaved, inlineTextReplacesAssistantText } =
      buildAgentTraceDisplayItems(events, null, {
        role: "assistant",
        text: finalText,
        timestamp: 1,
        runMode: "agent",
        modelProviderLabel: "Codex",
      });
    const finalInlineText = items.find(
      (item) => item.type === "inline_text" && item.text === finalText,
    );

    assert.isTrue(isInterleaved);
    assert.isFalse(inlineTextReplacesAssistantText);
    assert.notExists(finalInlineText);
    assert.isFalse(
      shouldDecorateInterleavedAgentTraceCitations({
        agentTraceEl: {} as Element,
        agentUsesInterleavedText: inlineTextReplacesAssistantText,
        streaming: false,
      }),
    );
    assert.isFalse(
      shouldDecorateInterleavedAgentTraceCitations({
        agentTraceEl: {} as Element,
        agentUsesInterleavedText: isInterleaved,
        streaming: true,
      }),
    );
  });

  it("does not open the response menu from action-card controls", function () {
    const controlTarget = {
      closest: (selector: string) =>
        selector.includes(".llm-agent-hitl-card") ? {} : null,
    } as unknown as EventTarget;
    const textTarget = {
      closest: () => null,
    } as unknown as EventTarget;

    assert.isTrue(shouldSuppressAssistantResponseContextMenu(controlTarget));
    assert.isFalse(shouldSuppressAssistantResponseContextMenu(textTarget));
  });

  it("keeps visible text before a tool call marked as interleaved", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "Working through the evidence.",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "read_paper",
          args: { operation: "front_matter" },
        },
        createdAt: 2,
      },
    ];

    const { items, isInterleaved } = buildAgentTraceDisplayItems(events, null);
    const inlineText = items.find((item) => item.type === "inline_text");

    assert.isTrue(isInterleaved);
    assert.deepEqual(inlineText, {
      type: "inline_text",
      text: "Working through the evidence.",
    });
  });

  it("joins streamed interleaved text across hidden provider events", function () {
    const sentence =
      "Now let me find the Obsidian vault location and look for any existing note for this paper.";
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "Now let me find",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "provider_event",
        payload: {
          type: "provider_event",
          providerType: "claude_code",
          payload: { kind: "stream_tick" },
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: " the Obsidian vault location and look for any existing note for this paper.",
        },
        createdAt: 3,
      },
      {
        runId: "run-1",
        seq: 4,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "Bash",
          args: { command: "pwd" },
        },
        createdAt: 4,
      },
    ];

    const { items, isInterleaved } = buildAgentTraceDisplayItems(events, null, {
      role: "assistant",
      text: sentence,
      timestamp: 1,
      runMode: "agent",
      modelProviderLabel: "Claude Code",
    });
    const inlineTexts = items
      .filter(
        (
          item,
        ): item is Extract<(typeof items)[number], { type: "inline_text" }> =>
          item.type === "inline_text",
      )
      .map((item) => item.text);

    assert.isTrue(isInterleaved);
    assert.deepEqual(inlineTexts, [sentence]);
  });

  it("deduplicates full assistant replays after streamed inline chunks", function () {
    const sentence =
      "Now let me find the Obsidian vault location and look for any existing note for this paper.";
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "Now let me find",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "provider_event",
        payload: {
          type: "provider_event",
          providerType: "claude_code",
          payload: { kind: "stream_tick" },
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: " the Obsidian vault location and look for any existing note for this paper.",
        },
        createdAt: 3,
      },
      {
        runId: "run-1",
        seq: 4,
        eventType: "provider_event",
        payload: {
          type: "provider_event",
          providerType: "claude_code",
          payload: { kind: "assistant_message" },
        },
        createdAt: 4,
      },
      {
        runId: "run-1",
        seq: 5,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: sentence,
        },
        createdAt: 5,
      },
      {
        runId: "run-1",
        seq: 6,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "Bash",
          args: { command: "pwd" },
        },
        createdAt: 6,
      },
    ];

    const { items, isInterleaved } = buildAgentTraceDisplayItems(events, null, {
      role: "assistant",
      text: sentence,
      timestamp: 1,
      runMode: "agent",
      modelProviderLabel: "Claude Code",
    });
    const inlineTexts = items
      .filter(
        (
          item,
        ): item is Extract<(typeof items)[number], { type: "inline_text" }> =>
          item.type === "inline_text",
      )
      .map((item) => item.text);

    assert.isTrue(isInterleaved);
    assert.deepEqual(inlineTexts, [sentence]);
  });

  it("keeps repeated words when a streamed continuation starts with whitespace", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "dog",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "provider_event",
        payload: {
          type: "provider_event",
          providerType: "claude_code",
          payload: { kind: "stream_tick" },
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: " dog",
        },
        createdAt: 3,
      },
      {
        runId: "run-1",
        seq: 4,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "Bash",
          args: { command: "pwd" },
        },
        createdAt: 4,
      },
    ];

    const { items, isInterleaved } = buildAgentTraceDisplayItems(events, null, {
      role: "assistant",
      text: "dog dog",
      timestamp: 1,
      runMode: "agent",
      modelProviderLabel: "Claude Code",
    });
    const inlineText = items.find((item) => item.type === "inline_text");

    assert.isTrue(isInterleaved);
    assert.deepEqual(inlineText, {
      type: "inline_text",
      text: "dog dog",
    });
  });

  it("deduplicates repeated interleaved text chunks around tool calls", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "Now I have everything I need. Let me compose\nand write the note.",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "TodoWrite",
          args: {},
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "message_delta",
        payload: {
          type: "message_delta",
          text: "Now I have everything I need. Let me compose and write the note.",
        },
        createdAt: 3,
      },
    ];

    const { items, isInterleaved } = buildAgentTraceDisplayItems(events, null);
    const inlineTexts = items
      .filter(
        (
          item,
        ): item is Extract<(typeof items)[number], { type: "inline_text" }> =>
          item.type === "inline_text",
      )
      .map((item) => item.text);

    assert.isTrue(isInterleaved);
    assert.lengthOf(inlineTexts, 1);
  });

  it("omits generic completed rows when a tool already has no specific success summary", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "unknown_tool",
          args: {},
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "call-1",
          name: "unknown_tool",
          ok: true,
          content: { ok: true },
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "final",
        payload: {
          type: "final",
          text: "Done",
        },
        createdAt: 3,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const actionTexts = items
      .filter(
        (item): item is Extract<(typeof items)[number], { type: "action" }> =>
          item.type === "action",
      )
      .map((item) => item.row.text);

    assert.notInclude(actionTexts, "Completed Unknown tool");
    assert.include(actionTexts, "Response ready");
  });

  it("summarizes file_io aliases and malformed actions without false write labels", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "file_io",
          args: {
            filePath: "/tmp/llm-for-zotero-mineru/51/full.md",
          },
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-2",
          name: "file_io",
          args: {
            mode: "read",
            path: "/tmp/llm-for-zotero-mineru/51/manifest.json",
          },
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-3",
          name: "file_io",
          args: {
            operation: "read_file",
            file_path: "/tmp/llm-for-zotero-mineru/51/full.md",
            offset: 64,
          },
        },
        createdAt: 3,
      },
      {
        runId: "run-1",
        seq: 4,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-4",
          name: "file_io",
          args: {
            action: "frobnicate",
            filePath: "/tmp/llm-for-zotero-mineru/51/full.md",
          },
        },
        createdAt: 4,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const rows = items
      .filter(
        (item): item is Extract<(typeof items)[number], { type: "action" }> =>
          item.type === "action",
      )
      .map((item) => item.row);
    const rowTexts = rows.map((row) => row.text);
    const codeBlocks = rows.map((row) => row.codeBlock);

    assert.include(rowTexts, "Reading full.md");
    assert.include(rowTexts, "Reading paper structure");
    assert.include(rowTexts, "Reading paper section");
    assert.include(rowTexts, "Accessing full.md");
    assert.notInclude(rowTexts, "Writing full.md");
    assert.include(
      codeBlocks,
      "read /tmp/llm-for-zotero-mineru/51/manifest.json",
    );
    assert.include(
      codeBlocks,
      "read_file /tmp/llm-for-zotero-mineru/51/full.md",
    );
  });

  it("redacts file_io trace details and surfaces malformed input diagnostics", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-write",
          name: "file_io",
          args: {
            action: "write",
            filePath: "/tmp/script.py",
            content: "super secret script body",
          },
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-write-array",
          name: "file_io",
          args: {
            action: "write",
            filePath: "/tmp/script-list.py",
            content: [
              "secret array script body",
              { nested: "secret nested script body" },
            ],
          },
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-bad",
          name: "file_io",
          args: createMalformedToolArgumentsDiagnostic(
            '{"action":"write","content":"secret malformed body"',
          ),
        },
        createdAt: 3,
      },
      {
        runId: "run-1",
        seq: 4,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "call-bad",
          name: "file_io",
          ok: false,
          content: {
            error:
              "Invalid tool input for file_io: file_io received malformed tool arguments from the model. Retry with valid JSON. Use file_io({ action:'write', filePath:'/absolute/path.py', content:'...' }).",
          },
        },
        createdAt: 3,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const actions = items.filter(
      (item): item is Extract<(typeof items)[number], { type: "action" }> =>
        item.type === "action",
    );
    const detailText = JSON.stringify(actions.map((item) => item.details));
    const rowText = actions.map((item) => item.row.text).join("\n");

    assert.include(detailText, "Argument keys");
    assert.include(detailText, "Action field (action)");
    assert.include(detailText, "Path field (filePath)");
    assert.include(detailText, "[redacted");
    assert.include(detailText, "Malformed input");
    assert.notInclude(detailText, "super secret script body");
    assert.notInclude(detailText, "secret array script body");
    assert.notInclude(detailText, "secret nested script body");
    assert.notInclude(detailText, "secret malformed body");
    assert.include(rowText, "action:'write'");
  });

  it("redacts content-like arguments for non-file tools", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-script",
          name: "zotero_script",
          args: {
            mode: "read",
            script: "const secretScript = 'do not show';",
            metadata: "public metadata should remain",
            nested: {
              body: "nested body should be hidden",
              source: "source text should be hidden",
            },
          },
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-bad-script",
          name: "zotero_script",
          args: createMalformedToolArgumentsDiagnostic(
            '{"mode":"read","script":"secret malformed script"',
          ),
        },
        createdAt: 2,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const actions = items.filter(
      (item): item is Extract<(typeof items)[number], { type: "action" }> =>
        item.type === "action",
    );
    const detailText = JSON.stringify(actions.map((item) => item.details));

    assert.include(detailText, "[redacted");
    assert.include(detailText, "Malformed input");
    assert.include(detailText, "public metadata should remain");
    assert.notInclude(detailText, "secretScript");
    assert.notInclude(detailText, "nested body should be hidden");
    assert.notInclude(detailText, "source text should be hidden");
    assert.notInclude(detailText, "secret malformed script");
    assert.notInclude(detailText, "Action field");
    assert.notInclude(detailText, "Path field");
  });

  it("shows concrete skill names instead of a generic skill label", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "Skill",
          args: { skill: "graphwalk" },
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-2",
          name: "Skill",
          args: { skill: "write-note" },
        },
        createdAt: 2,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const actionTexts = items
      .filter(
        (item): item is Extract<(typeof items)[number], { type: "action" }> =>
          item.type === "action",
      )
      .map((item) => item.row.text);

    assert.include(actionTexts, "Using Skill: graphwalk");
    assert.include(actionTexts, "Using Skill: write-note");
    assert.notInclude(actionTexts, "Using Skill");
    assert.isBelow(
      actionTexts.indexOf("Using Skill: graphwalk"),
      actionTexts.indexOf("Using Skill: write-note"),
    );
  });

  it("labels explicit Codex native slash skills as invoked", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "Skill",
          args: { skill: "evidence-based-qa", source: "codex-native-slash" },
        },
        createdAt: 1,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const actionTexts = items
      .filter(
        (item): item is Extract<(typeof items)[number], { type: "action" }> =>
          item.type === "action",
      )
      .map((item) => item.row.text);

    assert.include(actionTexts, "Invoked Skill: evidence-based-qa");
    assert.notInclude(actionTexts, "Using Skill: evidence-based-qa");
  });
});
