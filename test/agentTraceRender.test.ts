import {
  renderPlanProgress,
  disposePlanProgress,
  isFloatingPlanExecutionStatus,
} from "../src/modules/contextPanel/agentTrace/planProgressView";
import { assert } from "chai";
import { createApplyTagsTool } from "../src/agent/tools/write/applyTags";
import type { AgentConfirmationResolution } from "../src/agent/types";
import { readFileSync } from "node:fs";
import {
  buildAgentTraceChipDetails,
  buildAgentTraceDisplayItems,
  buildAgentTraceMarkdownForRender,
  formatAgentActivityDuration,
  getPendingActionButtonLayout,
  renderAgentTrace,
  renderAgentTraceDetailsBodyForTests,
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
import {
  getStableAnimationDelay,
  STABLE_ANIMATION_DELAY_PROPERTY,
} from "../src/modules/contextPanel/stableAnimationPhase";

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

  remove(...classes: string[]) {
    for (const cls of classes) this.classes.delete(cls);
  }

  toggle(cls: string, force?: boolean): boolean {
    const enabled = force === undefined ? !this.classes.has(cls) : force;
    if (enabled) this.classes.add(cls);
    else this.classes.delete(cls);
    return enabled;
  }

  toString(): string {
    return Array.from(this.classes).join(" ");
  }
}

class FakeStyleDeclaration {
  [key: string]: string | ((name: string, value: string) => void);

  setProperty(name: string, value: string): void {
    this[name] = value;
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
  public style = new FakeStyleDeclaration();
  public offsetHeight = 0;
  public scrollHeight = 0;
  public offsetTop = 0;
  public offsetWidth = 0;
  private copyableChildren: FakeElement[] = [];
  private html = "";
  private listeners = new Map<string, Array<(event: any) => void>>();

  public parentElement: FakeElement | null = null;
  get childNodes() {
    return this.children;
  }
  get nodeType() {
    return 1;
  }
  get nodeName() {
    return this.tagName.toUpperCase();
  }
  get nextSibling(): FakeElement | null {
    const siblings = this.parentElement?.children || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get isConnected() {
    return false;
  }
  remove() {
    this.parentElement?.removeChild(this);
  }
  removeChild(child: FakeElement) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
    return child;
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  hasAttribute(name: string) {
    return name in this.attributes;
  }
  removeAttribute(name: string) {
    delete this.attributes[name];
  }
  constructor(public readonly tagName = "div") {
    const attributes = this.attributes;
    Object.defineProperty(attributes, Symbol.iterator, {
      value: function* () {
        for (const [name, value] of Object.entries(attributes))
          yield { name, value };
      },
    });
  }

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
    if (selector.startsWith(".")) return this.findByClass(selector.slice(1));
    if (selector === "summary") return this.findAllByTag("summary")[0] || null;
    return null;
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) || []).filter((fn) => fn !== listener),
    );
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
    if (child === before) return child;
    child.remove();
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    child.parentElement = this;
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  append(...children: FakeElement[]): void {
    for (const child of children) this.appendChild(child);
  }

  appendChild(child: FakeElement): FakeElement {
    return this.insertBefore(child, null);
  }

  replaceChildren(...children: FakeElement[]): void {
    for (const child of [...this.children]) this.removeChild(child);
    this.append(...children);
  }

  focus(): void {}

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
  querySelectorAll: () => [],
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

describe("native host authority trace", function () {
  it("loads durable history while retaining temporary native activity during the handoff", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "temporary",
        seq: 1,
        eventType: "status",
        createdAt: 1000,
        payload: { type: "status", text: "Verified native activity" },
      },
    ];
    const message: any = {
      role: "assistant",
      text: "Done",
      timestamp: 2000,
      runMode: "agent",
      agentRunId: "durable",
      streaming: false,
      pendingAgentTraceEvents: events,
    };
    let loads = 0;
    const first = renderAgentTrace({
      doc: fakeDocument,
      message,
      events,
      onTraceMissing: () => {
        loads++;
      },
    })!;
    assert.equal(
      loads,
      1,
      "temporary events must not prevent loading the durable run",
    );
    const next = renderAgentTrace({
      doc: fakeDocument,
      message,
      events: [],
      previous: first,
    }) as unknown as FakeElement;
    assert.notInclude(collectFakeText(next), "Loading agent activity");
    assert.lengthOf(next.findAllByClass("llm-agent-activity-details"), 1);
  });
  it("retains semantic events instead of discarding them as non-Plan events", function () {
    const message: any = { role: "assistant", text: "", timestamp: 1 };
    const trace = createCodexNativeActivityTraceControllerForTests(
      message,
      () => {},
    );
    trace.appendPlanEvent({
      type: "provider_event",
      providerType: "agent_semantic_intent",
      payload: { intent: { id: "intent-1" } },
    });
    assert.equal(
      message.pendingAgentTraceEvents?.[0].payload.providerType,
      "agent_semantic_intent",
    );
  });
});

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

  it("scopes SVG polish rules to the expanded Mermaid viewer", function () {
    const svg =
      '<svg viewBox="0 0 10 10"><g class="cluster"><rect /></g></svg>';

    for (const [theme, background] of [
      ["light", "#ffffff"],
      ["dark", "#151515"],
    ] as const) {
      const polished = polishRenderedMermaidSvg(svg, theme);

      assert.include(polished, 'data-llm-mermaid-polished="true"');
      assert.include(
        polished,
        `svg[data-llm-mermaid-polished]{background:${background}`,
      );
      assert.notMatch(polished, /<style>\s*svg\s*\{/);
    }

    const polished = polishRenderedMermaidSvg(svg, "light");
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
    assert.equal(toggle?.textContent, "");
    assert.equal(toggle?.title, "Show source");
    assert.equal(toggle?.attributes["aria-label"], "Show source");
    assert.isNotEmpty(body.id);

    toggle?.dispatchFakeEvent("click");

    assert.equal(shell.dataset.sourceCollapsed, "false");
    assert.equal(body.attributes["aria-hidden"], "false");
    assert.equal(toggle?.attributes["aria-expanded"], "true");
    assert.equal(toggle?.textContent, "");
    assert.equal(toggle?.title, "Hide source");
    assert.equal(toggle?.attributes["aria-label"], "Hide source");
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
    assert.equal(toggle?.textContent, "");
    assert.equal(toggle?.title, "Show source");
    assert.equal(toggle?.attributes["aria-label"], "Show source");
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
    assert.equal(toggle?.textContent, "");
    assert.equal(toggle?.title, "Hide source");
    assert.equal(toggle?.attributes["aria-label"], "Hide source");

    toggle?.dispatchFakeEvent("click");

    assert.equal(shell.dataset.sourceCollapsed, "true");
    assert.equal(body.attributes["aria-hidden"], "true");
    assert.equal(toggle?.attributes["aria-expanded"], "false");
    assert.equal(toggle?.textContent, "");
    assert.equal(toggle?.title, "Show source");
    assert.equal(toggle?.attributes["aria-label"], "Show source");
  });

  it("adds a per-block word-wrap toggle for code blocks", function () {
    const { root, shell, header } = createFakeCodeBlockShell({
      lang: "ts",
    });

    attachRenderedCodeBlockControls(
      root as unknown as ParentNode,
      fakeDocument,
    );

    const wrapToggle = header.findByClass("llm-codeblock-wrap-toggle");
    assert.exists(wrapToggle);
    assert.equal(shell.dataset.wordWrap, "false");
    assert.equal(wrapToggle?.attributes["aria-pressed"], "false");
    assert.equal(wrapToggle?.attributes["aria-label"], "Enable word wrap");
    assert.equal(wrapToggle?.title, "Enable word wrap");
    assert.equal(wrapToggle?.textContent, "");

    wrapToggle?.dispatchFakeEvent("click");

    assert.equal(shell.dataset.wordWrap, "true");
    assert.equal(wrapToggle?.attributes["aria-pressed"], "true");
    assert.equal(wrapToggle?.attributes["aria-label"], "Disable word wrap");
    assert.equal(wrapToggle?.title, "Disable word wrap");
    assert.equal(wrapToggle?.textContent, "");

    wrapToggle?.dispatchFakeEvent("click");

    assert.equal(shell.dataset.wordWrap, "false");
    assert.equal(wrapToggle?.attributes["aria-pressed"], "false");
    assert.equal(wrapToggle?.attributes["aria-label"], "Enable word wrap");
    assert.equal(wrapToggle?.title, "Enable word wrap");
    assert.equal(wrapToggle?.textContent, "");
  });

  it("wraps plain text fences by default while keeping the toggle reversible", function () {
    const { root, shell, header } = createFakeCodeBlockShell({
      lang: "text",
    });

    attachRenderedCodeBlockControls(
      root as unknown as ParentNode,
      fakeDocument,
    );

    const wrapToggle = header.findByClass("llm-codeblock-wrap-toggle");
    assert.exists(wrapToggle);
    assert.equal(shell.dataset.wordWrap, "true");
    assert.equal(wrapToggle?.attributes["aria-pressed"], "true");
    assert.equal(wrapToggle?.attributes["aria-label"], "Disable word wrap");
    assert.equal(wrapToggle?.title, "Disable word wrap");
    assert.equal(wrapToggle?.textContent, "");

    wrapToggle?.dispatchFakeEvent("click");

    assert.equal(shell.dataset.wordWrap, "false");
    assert.equal(wrapToggle?.attributes["aria-pressed"], "false");
    assert.equal(wrapToggle?.attributes["aria-label"], "Enable word wrap");
    assert.equal(wrapToggle?.title, "Enable word wrap");
    assert.equal(wrapToggle?.textContent, "");
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
  it("keeps continuous animation phase anchored to its lifecycle start", function () {
    assert.equal(getStableAnimationDelay(1_000, 1_000), "0ms");
    assert.equal(getStableAnimationDelay(1_000, 2_750), "-1750ms");
    assert.equal(getStableAnimationDelay(undefined, 2_750), "0ms");

    const originalNow = Date.now;
    Date.now = () => 5_000;
    try {
      const trace = renderAgentTrace({
        doc: fakeDocument,
        message: {
          role: "assistant",
          text: "",
          timestamp: 500,
          waitingAnimationStartedAt: 1_000,
          runMode: "agent",
          streaming: true,
        },
        events: [
          {
            runId: "run-stable-animation",
            seq: 1,
            eventType: "status",
            payload: {
              type: "status",
              text: "Planning the request and reviewing context",
            },
            createdAt: 1_000,
          },
        ],
      }) as unknown as FakeElement;
      assert.equal(trace.style[STABLE_ANIMATION_DELAY_PROPERTY], "-4000ms");
    } finally {
      Date.now = originalNow;
    }
  });

  it("phase-anchors every reconstructed continuous progress animation", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const relevantSelector =
      /(?:llm-at-(?:row-)?planning|llm-typing-dot|llm-plan-progress-trigger-dot|llm-plan-task-badge-in_progress|llm-compact-marker-pending)/;
    const infiniteRules = Array.from(
      css.matchAll(/animation:[^;]*\binfinite\b[^;]*;/g),
    ).flatMap((match) => {
      const declarationIndex = match.index || 0;
      const blockStart = css.lastIndexOf("{", declarationIndex);
      const previousBlockEnd = css.lastIndexOf("}", declarationIndex);
      const blockEnd = css.indexOf("}", declarationIndex);
      const selector = css.slice(previousBlockEnd + 1, blockStart).trim();
      if (!relevantSelector.test(selector)) return [];
      return [{ selector, body: css.slice(blockStart + 1, blockEnd) }];
    });

    assert.lengthOf(infiniteRules, 7);
    for (const { selector, body } of infiniteRules) {
      assert.include(
        body,
        "--llm-stable-animation-delay",
        `missing stable phase for ${selector.trim()}`,
      );
    }
  });

  it("floats only starting or running Plan execution states", function () {
    assert.isTrue(isFloatingPlanExecutionStatus("running"));
    assert.isFalse(isFloatingPlanExecutionStatus("interrupted"));
    assert.isFalse(isFloatingPlanExecutionStatus("waiting_for_user"));
    assert.isFalse(isFloatingPlanExecutionStatus("completed"));
    assert.isFalse(isFloatingPlanExecutionStatus("failed"));
  });

  it("formats compact Codex-style activity durations", function () {
    assert.equal(formatAgentActivityDuration(250), "1s");
    assert.equal(formatAgentActivityDuration(259_000), "4m 19s");
    assert.equal(formatAgentActivityDuration(3_661_000), "1h 1m 1s");
  });

  it("replaces planning activity with one question at a time", async function () {
    const action: AgentPendingAction = {
      toolName: "request_user_input",
      mode: "review",
      title: "Plan needs your input",
      confirmLabel: "Continue planning",
      cancelLabel: "Cancel plan",
      fields: [
        {
          type: "choice",
          id: "scope",
          label: "Which corpus should the review use?",
          allowCustom: true,
          customPlaceholder: "Something else…",
          requiredForActionIds: ["continue"],
          options: [
            {
              id: "collection",
              label: "Selected collection",
              description: "Use the current collection only.",
            },
            { id: "library", label: "Whole library" },
          ],
        },
        {
          type: "choice",
          id: "search",
          label: "Should external search be included?",
          allowCustom: true,
          requiredForActionIds: ["continue"],
          options: [
            { id: "no", label: "Zotero only" },
            { id: "yes", label: "Include external search" },
          ],
        },
      ],
      actions: [
        { id: "continue", label: "Continue planning", approved: true },
        { id: "cancel", label: "Cancel plan", approved: false },
      ],
      defaultActionId: "continue",
      cancelActionId: "cancel",
    };
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: {
        role: "assistant",
        text: "",
        timestamp: 1,
        runMode: "agent",
        streaming: true,
      },
      events: [
        {
          runId: "run-question-card",
          seq: 1,
          eventType: "status",
          payload: {
            type: "status",
            text: "Planning the request and reviewing context",
          },
          createdAt: 1,
        },
        {
          runId: "run-question-card",
          seq: 2,
          eventType: "confirmation_required",
          payload: {
            type: "confirmation_required",
            requestId: "question-card",
            action,
          },
          createdAt: 2,
        },
      ],
    }) as unknown as FakeElement;

    assert.equal(trace.dataset.llmAssistantTurnReplacement, "true");
    assert.isNull(trace.findByClass("llm-agent-activity-details"));
    assert.lengthOf(trace.findAllByClass("llm-planning-question-panel"), 1);
    assert.include(
      collectFakeText(trace.findByClass("llm-planning-question-panel")),
      "Which corpus should the review use?",
    );
    assert.include(
      collectFakeText(trace.findByClass("llm-planning-question-panel")),
      "Use the current collection only.",
    );

    const firstOption = trace.findAllByClass("llm-planning-question-option")[0];
    firstOption.dispatchFakeEvent("click");
    assert.isTrue(
      firstOption.classList.contains("llm-planning-question-option-selected"),
    );
    await new Promise((resolve) => setTimeout(resolve, 520));
    assert.include(
      collectFakeText(trace.findByClass("llm-planning-question-panel")),
      "Should external search be included?",
    );
    assert.equal(
      trace.findByClass("llm-planning-question-counter")?.textContent,
      "2 / 2",
    );

    const finalOption = trace.findAllByClass("llm-planning-question-option")[0];
    finalOption.dispatchFakeEvent("click");
    await new Promise((resolve) => setTimeout(resolve, 520));
    assert.include(
      collectFakeText(trace.findByClass("llm-planning-question-panel")),
      "Should external search be included?",
      "the final option waits for explicit submission",
    );

    const previous = trace.findAllByClass("llm-planning-question-nav-btn")[0];
    previous.dispatchFakeEvent("click");
    assert.include(
      collectFakeText(trace.findByClass("llm-planning-question-panel")),
      "Which corpus should the review use?",
    );
    assert.isTrue(
      trace
        .findAllByClass("llm-planning-question-option")[0]
        .classList.contains("llm-planning-question-option-selected"),
      "the earlier answer is retained",
    );
  });

  it("accepts a custom planning-question answer in the card", function () {
    const card = renderPendingActionCard(fakeDocument, {
      requestId: "custom-question-card",
      action: {
        toolName: "request_user_input",
        mode: "review",
        title: "Plan needs your input",
        confirmLabel: "Continue planning",
        cancelLabel: "Cancel plan",
        fields: [
          {
            type: "choice",
            id: "scope",
            label: "Which corpus?",
            allowCustom: true,
            options: [
              { id: "collection", label: "Collection" },
              { id: "library", label: "Library" },
            ],
            requiredForActionIds: ["continue"],
          },
        ],
        actions: [
          { id: "continue", label: "Continue planning", approved: true },
          { id: "cancel", label: "Cancel plan", approved: false },
        ],
        defaultActionId: "continue",
        cancelActionId: "cancel",
      },
    }) as unknown as FakeElement;
    const customInput = card.findByClass(
      "llm-planning-question-custom-input",
    ) as FakeElement & { value: string };
    const continueButton = card.findByClass("llm-planning-question-continue");
    assert.isTrue(continueButton?.disabled);
    customInput.value = "A curated paper list";
    customInput.dispatchFakeEvent("input");
    assert.isFalse(continueButton?.disabled);
    assert.isTrue(
      card
        .findByClass("llm-planning-question-custom")
        ?.classList.contains("llm-planning-question-custom-selected"),
    );
  });

  it("suppresses complete and partial web markers in streamed trace text", function () {
    assert.equal(
      buildAgentTraceMarkdownForRender(
        "First.<!--llm-web-source:web_abc1234-->\n\nSecond.<!--llm-web-source:web_",
      ),
      "First.\n\nSecond.",
    );
  });

  it("renders connected trace rows and launches their safe URLs", function () {
    const globalScope = globalThis as typeof globalThis & {
      Zotero?: { launchURL?: (url: string) => void };
    };
    const originalZotero = globalScope.Zotero;
    let launchedUrl = "";
    globalScope.Zotero = {
      ...(originalZotero || {}),
      launchURL: (url: string) => {
        launchedUrl = url;
      },
    };

    try {
      const body = renderAgentTraceDetailsBodyForTests(fakeDocument, [
        { label: "Query", value: "representational drift" },
        {
          label: "Depth",
          value: "Depth: basic",
          timeline: { icon: "brain" },
        },
        {
          label: "URL",
          value: "https://example.com/a/long/result/url",
          timeline: {
            icon: "website",
            href: "https://example.com/a/long/result/url",
            faviconUrl: "https://example.com/favicon.ico",
          },
        },
        {
          label: "Paper",
          value: "Alice Example, 2025, A useful paper",
          timeline: {
            icon: "paper",
            href: "https://doi.org/10.1000/example",
          },
        },
      ]) as unknown as FakeElement;

      assert.isTrue(
        body.classList.contains("llm-agent-process-details-with-timeline"),
      );
      assert.lengthOf(body.findAllByClass("llm-agent-trace-timeline"), 1);
      assert.lengthOf(body.findAllByClass("llm-agent-trace-timeline-row"), 3);
      assert.lengthOf(
        body.findAllByClass("llm-agent-trace-timeline-icon-brain"),
        1,
      );
      assert.lengthOf(
        body.findAllByClass("llm-agent-trace-timeline-icon-website"),
        1,
      );
      assert.lengthOf(
        body.findAllByClass("llm-agent-trace-timeline-icon-paper"),
        1,
      );
      const favicons = body.findAllByClass("llm-agent-trace-timeline-favicon");
      assert.lengthOf(favicons, 1);
      const websiteIcon = body.findAllByClass(
        "llm-agent-trace-timeline-icon-website",
      )[0];
      assert.isTrue(
        websiteIcon.classList.contains(
          "llm-agent-trace-timeline-icon-has-favicon",
        ),
      );
      assert.equal(
        (favicons[0] as unknown as HTMLImageElement).src,
        "https://example.com/favicon.ico",
      );
      favicons[0].dispatchFakeEvent("error");
      assert.isTrue((favicons[0] as unknown as HTMLImageElement).hidden);
      assert.isFalse(
        websiteIcon.classList.contains(
          "llm-agent-trace-timeline-icon-has-favicon",
        ),
      );
      assert.deepEqual(
        body
          .findAllByClass("llm-agent-trace-timeline-value")
          .map(collectFakeText),
        [
          "Depth: basic",
          "https://example.com/a/long/result/url",
          "Alice Example, 2025, A useful paper",
        ],
      );

      const links = body.findAllByClass("llm-agent-trace-timeline-row-link");
      assert.lengthOf(links, 2);
      links[0].dispatchFakeEvent("click");
      assert.equal(launchedUrl, "https://example.com/a/long/result/url");
    } finally {
      globalScope.Zotero = originalZotero;
    }
  });

  it("expands activity while streaming and collapses it when complete", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-activity-collapse",
        seq: 1,
        eventType: "message_delta",
        payload: { type: "message_delta", text: "Working" },
        createdAt: 1_000,
      },
      {
        runId: "run-activity-collapse",
        seq: 2,
        eventType: "final",
        payload: { type: "final", text: "Done" },
        createdAt: 260_000,
      },
    ];
    const message = {
      role: "assistant" as const,
      text: "",
      timestamp: 260_000,
      runMode: "agent" as const,
      modelProviderLabel: "Codex",
      streaming: true,
    };
    const workingTrace = renderAgentTrace({
      doc: fakeDocument,
      message,
      events: events.slice(0, 1),
    }) as unknown as FakeElement;
    assert.isTrue(
      (
        workingTrace.findByClass("llm-agent-activity-details") as
          | (FakeElement & {
              open?: boolean;
            })
          | null
      )?.open,
    );
    assert.equal(
      workingTrace.findByClass("llm-agent-activity-summary")?.textContent,
      "Working…",
    );

    message.streaming = false;
    const completedTrace = renderAgentTrace({
      doc: fakeDocument,
      message,
      events,
    }) as unknown as FakeElement;
    assert.isFalse(
      (
        completedTrace.findByClass("llm-agent-activity-details") as
          | (FakeElement & {
              open?: boolean;
            })
          | null
      )?.open,
    );
    assert.equal(
      completedTrace.findByClass("llm-agent-activity-summary")?.textContent,
      "Worked for 4m 19s",
    );
  });

  it("labels planning and approved execution in the activity disclosure", function () {
    const baseMessage = {
      role: "assistant" as const,
      text: "",
      timestamp: 2_000,
      runMode: "agent" as const,
      streaming: true,
    };
    const planning = renderAgentTrace({
      doc: fakeDocument,
      message: { ...baseMessage },
      events: [
        {
          runId: "run-planning-label",
          seq: 1,
          eventType: "status",
          payload: {
            type: "status",
            text: "Planning the request and reviewing context",
          },
          createdAt: 1_000,
        },
      ],
    }) as unknown as FakeElement;
    assert.equal(
      planning.findByClass("llm-agent-activity-summary")?.textContent,
      "Planning…",
    );
    const planningRow = planning.findByClass("llm-at-row-planning-active");
    assert.isNotNull(planningRow);
    assert.isTrue(
      planningRow?.children[0]?.classList.contains("llm-at-planning-drive"),
    );
    assert.lengthOf(planning.findAllByClass("llm-at-planning-drive-pixel"), 9);

    const executing = renderAgentTrace({
      doc: fakeDocument,
      message: { ...baseMessage },
      events: [
        {
          runId: "run-execution-label",
          seq: 1,
          eventType: "status",
          payload: { type: "status", text: "Executing the approved plan" },
          createdAt: 1_000,
        },
      ],
    }) as unknown as FakeElement;
    assert.equal(
      executing.findByClass("llm-agent-activity-summary")?.textContent,
      "Executing plan…",
    );
    assert.isNull(executing.findByClass("llm-at-planning-drive"));
  });

  it("renders execution progress as a compact accessible pill with the full ledger in a popover", function () {
    const makeTask = (
      id: string,
      status: "completed" | "in_progress" | "pending",
      content: string,
    ) => ({
      version: 1 as const,
      taskId: id,
      executionId: "execution-pill",
      planStepId: id,
      kind: "required_step" as const,
      content,
      activeForm: status === "in_progress" ? "Drafting the brief" : content,
      acceptanceCriteria: [`${content} is complete`],
      expectedEffect: "artifact" as const,
      obligationIds: [],
      status,
      attemptCount: status === "pending" ? 0 : 1,
      evidenceIds: status === "completed" ? [`evidence-${id}`] : [],
      failureReasons: [],
      createdAt: 1,
      updatedAt: 2,
    });
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-plan-pill",
        seq: 1,
        eventType: "plan_execution_updated",
        payload: {
          type: "plan_execution_updated",
          ledger: {
            version: 1,
            executionId: "execution-pill",
            planId: "plan-pill",
            revision: 1,
            planDigest: "digest",
            conversationKey: 1,
            attempt: 1,
            provider: "original",
            grant: {
              version: 1,
              planId: "plan-pill",
              revision: 1,
              planDigest: "digest",
              conversationKey: 1,
              conversationGeneration: 1,
              approvedAt: 1,
            },
            status: "running",
            activeTaskId: "step-2",
            tasks: [
              makeTask("step-1", "completed", "Search the library"),
              makeTask("step-2", "in_progress", "Draft the document"),
              makeTask("step-3", "pending", "Finalize references"),
            ],
            evidence: [],
            startedAt: 1,
            updatedAt: 2,
          },
        },
        createdAt: 2,
      },
    ];

    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: { role: "assistant", text: "", timestamp: 2, streaming: true },
      events,
    }) as unknown as FakeElement;
    assert.isNull(
      trace.findByClass("llm-plan-container-execution"),
      "even stale streaming history cannot mount progress",
    );
    const root = renderPlanProgress(
      fakeDocument,
      (events[0].payload as any).ledger,
      events,
    ) as unknown as FakeElement;
    const trigger = root?.findByClass("llm-plan-progress-trigger");
    const popover = root?.findByClass("llm-plan-progress-popover");

    assert.exists(root);
    assert.equal(root?.dataset.llmPlanExecutionId, "execution-pill");
    assert.equal(root?.dataset.llmPlanExecutionStatus, "running");
    assert.include(collectFakeText(trigger), "Task progress");
    assert.include(collectFakeText(trigger), "1/3");
    assert.notInclude(collectFakeText(trigger), "Drafting the brief");
    assert.include(collectFakeText(popover), "Drafting the brief");
    assert.include(collectFakeText(popover), "Search the library");
    assert.include(collectFakeText(popover), "Finalize references");
    assert.equal(trigger?.attributes["aria-expanded"], "false");
    assert.include(
      trigger?.attributes["aria-label"] || "",
      "1 of 3 required steps complete",
    );
    assert.exists(popover?.findByClass("llm-plan-task-list"));
    const progress = popover?.findByClass("llm-plan-progress");
    assert.equal(progress?.attributes.role, "progressbar");
    assert.equal(progress?.attributes["aria-valuemin"], "0");
    assert.equal(progress?.attributes["aria-valuemax"], "3");
    assert.equal(progress?.attributes["aria-valuenow"], "1");
    assert.notInclude(collectFakeText(progress), "steps complete");

    root?.dispatchFakeEvent("mouseenter");
    assert.isTrue(root?.classList.contains("llm-plan-progress-hover"));
    root?.dispatchFakeEvent("mouseleave");
    assert.isFalse(root?.classList.contains("llm-plan-progress-hover"));

    trigger?.dispatchFakeEvent("click");
    assert.isTrue(root?.classList.contains("llm-plan-progress-open"));
    assert.equal(trigger?.attributes["aria-expanded"], "true");
    assert.include(trigger?.attributes["aria-label"] || "", "Hide");
    trigger?.dispatchFakeEvent("click");
    assert.isFalse(root?.classList.contains("llm-plan-progress-open"));
  });

  it("keeps the task progress hover card compact without changing plan cards", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const popoverRule =
      css.match(/\.llm-plan-progress-popover\s*\{[\s\S]*?\}/)?.[0] || "";
    const compactTaskLineRule =
      css.match(
        /\.llm-plan-progress-popover\s+\.llm-plan-task-line\s*\{[\s\S]*?\}/,
      )?.[0] || "";
    const compactTaskBadgeRule =
      css.match(
        /\.llm-plan-progress-popover\s+\.llm-plan-task-badge\s*\{[\s\S]*?\}/,
      )?.[0] || "";
    const baseTaskLineRule =
      css.match(/(?<!popover )\.llm-plan-task-line\s*\{[\s\S]*?\}/)?.[0] || "";

    assert.include(popoverRule, "max-width: 420px");
    assert.include(popoverRule, "max-height: min(50vh, 360px)");
    assert.include(popoverRule, "padding: 8px");
    assert.include(popoverRule, "border-radius: 10px");
    assert.include(compactTaskLineRule, "min-height: 32px");
    assert.include(compactTaskLineRule, "padding: 5px 7px");
    assert.include(compactTaskBadgeRule, "flex-basis: 18px");
    assert.include(compactTaskBadgeRule, "width: 18px");
    assert.include(compactTaskBadgeRule, "height: 18px");
    assert.include(baseTaskLineRule, "min-height: 42px");
    assert.notInclude(css, ".llm-plan-progress-trigger-current");
  });

  it("keeps clicked task progress open across live execution rerenders", function () {
    const renderProgress = (
      status: "running" | "completed",
      updatedAt: number,
      previous?: FakeElement,
    ) =>
      (() => {
        const events: AgentRunEventRecord[] = [
          {
            runId: "run-stable-progress",
            seq: updatedAt,
            eventType: "plan_execution_updated",
            payload: {
              type: "plan_execution_updated",
              ledger: {
                version: 1,
                executionId: "execution-stable-progress",
                planId: "plan-stable-progress",
                revision: 1,
                planDigest: "digest",
                conversationKey: 1,
                attempt: 1,
                provider: "original",
                grant: {
                  version: 1,
                  planId: "plan-stable-progress",
                  revision: 1,
                  planDigest: "digest",
                  conversationKey: 1,
                  conversationGeneration: 1,
                  approvedAt: 1,
                },
                status,
                activeTaskId: status === "running" ? "step-1" : undefined,
                tasks: [
                  {
                    version: 1,
                    taskId: "step-1",
                    executionId: "execution-stable-progress",
                    planStepId: "step-1",
                    kind: "required_step",
                    content: "Draft the document",
                    activeForm: "Drafting the document",
                    acceptanceCriteria: ["The document is complete"],
                    expectedEffect: "artifact",
                    obligationIds: [],
                    status: status === "running" ? "in_progress" : "completed",
                    attemptCount: 1,
                    evidenceIds:
                      status === "completed" ? ["evidence-step-1"] : [],
                    failureReasons: [],
                    createdAt: 1,
                    updatedAt,
                  },
                ],
                evidence: [],
                startedAt: 1,
                completedAt: status === "completed" ? updatedAt : undefined,
                updatedAt,
              },
            },
            createdAt: updatedAt,
          },
        ];
        const trace = renderAgentTrace({
          doc: fakeDocument,
          message: {
            role: "assistant",
            text: "",
            timestamp: updatedAt,
            streaming: status === "running",
          },
          events,
        }) as unknown as FakeElement;
        assert.isNull(trace.findByClass("llm-plan-container-execution"));
        return renderPlanProgress(
          fakeDocument,
          (events[0].payload as any).ledger,
          events,
          previous as unknown as HTMLElement,
        ) as unknown as FakeElement;
      })();

    const first = renderProgress("running", 2);
    const firstRoot = first.findByClass("llm-plan-container-execution");
    firstRoot
      ?.findByClass("llm-plan-progress-trigger")
      ?.dispatchFakeEvent("click");
    assert.isTrue(firstRoot?.classList.contains("llm-plan-progress-open"));

    const updated = renderProgress("running", 3, first);
    const updatedRoot = updated.findByClass("llm-plan-container-execution");
    const updatedTrigger = updatedRoot?.findByClass(
      "llm-plan-progress-trigger",
    );
    assert.isTrue(updatedRoot?.classList.contains("llm-plan-progress-open"));
    assert.equal(updatedTrigger?.attributes["aria-expanded"], "true");
    assert.include(updatedTrigger?.attributes["aria-label"] || "", "Hide");

    disposePlanProgress(updated as unknown as HTMLElement);
    assert.isNull(updated.parentElement);
    const restarted = renderProgress("running", 5);
    const restartedRoot = restarted.findByClass("llm-plan-container-execution");
    assert.isFalse(restartedRoot?.classList.contains("llm-plan-progress-open"));
  });

  it("disposes progress observers and listeners when its live owner unmounts", function () {
    let observers = 0;
    const listeners = new Set<EventListener>();
    const doc = {
      ...fakeDocument,
      defaultView: {
        ResizeObserver: class {
          observe() {
            observers++;
          }
          disconnect() {
            observers--;
          }
        },
        addEventListener(_type: string, listener: EventListener) {
          listeners.add(listener);
        },
        removeEventListener(_type: string, listener: EventListener) {
          listeners.delete(listener);
        },
      },
    } as unknown as Document;
    const root = renderPlanProgress(
      doc,
      {
        executionId: "dispose",
        planId: "dispose",
        revision: 1,
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        tasks: [],
      } as any,
      [],
    ) as unknown as FakeElement;
    const trigger = root.findByClass("llm-plan-progress-trigger")!;
    assert.equal(observers, 1);
    assert.equal(listeners.size, 1);
    disposePlanProgress(root as unknown as HTMLElement);
    trigger.dispatchFakeEvent("click");
    assert.equal(observers, 0);
    assert.equal(listeners.size, 0);
    assert.equal(trigger.attributes["aria-expanded"], "false");
  });

  for (const status of [
    "pending",
    "running",
    "waiting_for_user",
    "blocked",
    "interrupted",
    "completed",
    "completed_with_exceptions",
    "failed",
    "cancelled",
    "superseded",
  ]) {
    it(`never projects ${status} historical ledgers as task progress`, function () {
      const trace = renderAgentTrace({
        doc: fakeDocument,
        message: {
          role: "assistant",
          text: "",
          timestamp: 2,
          streaming: true,
          runMode: "agent",
        },
        events: [
          {
            runId: "historical",
            seq: 1,
            eventType: "plan_execution_updated",
            createdAt: 1,
            payload: {
              type: "plan_execution_updated",
              ledger: { executionId: "historical", status, tasks: [] } as any,
            },
          },
        ],
      }) as unknown as FakeElement;
      assert.isNull(trace.findByClass("llm-plan-container-execution"));
      assert.isNull(trace.findByClass("llm-plan-progress-trigger"));
    });
  }

  it("keeps plan review actions centered in one row at narrow widths", function () {
    const source = readFileSync(
      "src/modules/contextPanel/agentTrace/render.ts",
      "utf8",
    );
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const actionsRule =
      css.match(/\.llm-plan-review-actions\s*\{[\s\S]*?\}/)?.[0] || "";
    const actionButtonRule =
      css.match(
        /\.llm-plan-review-actions\s+\.llm-plan-action\s*\{[\s\S]*?\}/,
      )?.[0] || "";
    const cancelRule =
      css.match(
        /\.llm-plan-review-actions\s+\.llm-plan-cancel\s*\{[\s\S]*?\}/,
      )?.[0] || "";
    const approveOpticalRule =
      css.match(
        /\.llm-plan-review-actions\s+\.llm-plan-approve\s+\.llm-plan-action-label-full,\s*\.llm-plan-review-actions\s+\.llm-plan-approve\s+\.llm-plan-action-label-compact\s*\{[\s\S]*?\}/,
      )?.[0] || "";

    assert.match(
      source,
      /actions\.className\s*=\s*"llm-plan-actions llm-plan-review-actions"/,
    );
    assert.include(source, "llm-plan-action-label-full");
    assert.include(source, "llm-plan-action-label-compact");
    assert.include(actionsRule, "display: grid");
    assert.include(
      actionsRule,
      "grid-template-columns: repeat(3, minmax(0, 1fr))",
    );
    assert.include(actionsRule, "align-items: stretch");
    assert.include(actionsRule, "width: 100%");
    assert.include(actionButtonRule, "justify-content: center");
    assert.include(actionButtonRule, "white-space: nowrap");
    assert.include(cancelRule, "margin-left: 0");
    assert.include(approveOpticalRule, "position: relative");
    assert.include(approveOpticalRule, "top: -1px");
    assert.include(css, "@container (max-width: 360px)");
  });

  it("normalizes coverage search and filter metrics in one aligned row", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const controlsRule =
      css.match(/\.llm-plan-document-coverage-controls\s*\{[\s\S]*?\}/)?.[0] ||
      "";
    const fieldsRule =
      css.match(
        /\.llm-plan-document-coverage-controls input,\s*\.llm-plan-document-coverage-controls select\s*\{[\s\S]*?\}/,
      )?.[0] || "";

    assert.include(controlsRule, "display: grid");
    assert.include(
      controlsRule,
      "grid-template-columns: minmax(0, 1fr) minmax(84px, auto)",
    );
    assert.include(controlsRule, "align-items: center");
    assert.include(fieldsRule, "box-sizing: border-box");
    assert.include(fieldsRule, "height: 28px");
    assert.include(fieldsRule, "margin: 0");
    assert.include(fieldsRule, "padding: 0 9px");
    assert.include(fieldsRule, "line-height: 1.2");
  });

  it("keeps host-owned plan bookkeeping out of the visible tool trace", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-plan-tools",
        seq: 1,
        eventType: "status",
        payload: {
          type: "status",
          text: "Planning the request and reviewing context",
        },
        createdAt: 1,
      },
      {
        runId: "run-plan-tools",
        seq: 2,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-plan",
          name: "update_plan",
          args: { ready: true, steps: [] },
        },
        createdAt: 2,
      },
      {
        runId: "run-plan-tools",
        seq: 3,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "call-plan",
          name: "update_plan",
          ok: true,
          content: { artifact: {} },
        },
        createdAt: 3,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const visible = items.map((item) =>
      item.type === "action"
        ? item.row.text
        : item.type === "message"
          ? item.text
          : "",
    );
    assert.include(
      visible,
      "Planning the request against the available context.",
    );
    assert.notMatch(visible.join("\n"), /update plan|using update/i);
  });

  it("rules off the activity trace once an answer follows it", function () {
    const baseEvents: AgentRunEventRecord[] = [
      {
        runId: "run-divider",
        seq: 1,
        eventType: "message_delta",
        payload: { type: "message_delta", text: "Searching" },
        createdAt: 1_000,
      },
    ];
    const settled = {
      role: "assistant" as const,
      text: "Representational drift is continuous.",
      timestamp: 9_000,
      runMode: "agent" as const,
      streaming: false,
    };

    // Replayed trace with no `final` marker still gets the rule, because the
    // settled message carries the answer that the rule separates.
    const replayed = renderAgentTrace({
      doc: fakeDocument,
      message: settled,
      events: baseEvents,
    }) as unknown as FakeElement;
    assert.isNotNull(replayed.findByClass("llm-agent-output-divider"));

    // Still working with nothing below yet — no dangling rule.
    const working = renderAgentTrace({
      doc: fakeDocument,
      message: { ...settled, text: "", streaming: true },
      events: baseEvents,
    }) as unknown as FakeElement;
    assert.isNull(working.findByClass("llm-agent-output-divider"));

    // Restored rows can retain a stale streaming flag. Visible answer text is
    // still sufficient because there is content below the rule to separate.
    const staleStreaming = renderAgentTrace({
      doc: fakeDocument,
      message: { ...settled, streaming: true },
      events: baseEvents,
    }) as unknown as FakeElement;
    assert.isNotNull(staleStreaming.findByClass("llm-agent-output-divider"));

    // A `final` event still drives the rule on its own.
    const finalized = renderAgentTrace({
      doc: fakeDocument,
      message: { ...settled, text: "", streaming: true },
      events: [
        ...baseEvents,
        {
          runId: "run-divider",
          seq: 2,
          eventType: "final",
          payload: { type: "final", text: "Done" },
          createdAt: 9_000,
        },
      ],
    }) as unknown as FakeElement;
    assert.isNotNull(finalized.findByClass("llm-agent-output-divider"));
  });

  it("keeps the rule last so it separates the trace from the answer", function () {
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: {
        role: "assistant" as const,
        text: "Answer text.",
        timestamp: 9_000,
        runMode: "agent" as const,
        streaming: false,
      },
      events: [
        {
          runId: "run-divider-order",
          seq: 1,
          eventType: "message_delta",
          payload: { type: "message_delta", text: "Searching" },
          createdAt: 1_000,
        },
      ],
    }) as unknown as FakeElement;
    const children = trace.children as FakeElement[];
    assert.isTrue(
      children[children.length - 1].classList.contains(
        "llm-agent-output-divider",
      ),
    );
    assert.isTrue(
      children[0].classList.contains("llm-agent-activity-details"),
      "disclosure stays above the rule",
    );
  });

  it("uses one scaled gap around the activity disclosure and answer divider", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const activityRule =
      css.match(/\.llm-agent-activity\s*\{[\s\S]*?\}/)?.[0] || "";
    const answerRule =
      css.match(
        /\.llm-bubble\.assistant\s*>\s*\.llm-agent-activity\s*\+\s*\*\s*\{[\s\S]*?\}/,
      )?.[0] || "";
    const dividerRule =
      css.match(/\.llm-agent-output-divider\s*\{[\s\S]*?\}/)?.[0] || "";

    assert.include(
      activityRule,
      "--llm-agent-activity-spacing: calc(10px * var(--llm-font-scale, 1))",
    );
    assert.include(
      activityRule,
      "margin-block: var(--llm-agent-activity-spacing)",
    );
    assert.include(activityRule, "gap: var(--llm-agent-activity-spacing)");
    assert.include(answerRule, "margin-top: 0");
    assert.include(dividerRule, "margin: 0");
    assert.include(
      dividerRule,
      "var(--stroke-secondary, rgba(120, 120, 120, 0.22))",
    );
  });

  it("keeps interleaved trace activity open until the final answer is ready", function () {
    const message = {
      role: "assistant" as const,
      text: "",
      timestamp: 260_000,
      runMode: "agent" as const,
      modelProviderLabel: "Codex",
      streaming: true,
      waitingAnimationStartedAt: 1_000,
    };
    const runningEvents: AgentRunEventRecord[] = [
      {
        runId: "run-interleaved-activity",
        seq: 1,
        eventType: "codex_progress",
        payload: {
          type: "codex_progress",
          itemId: "assistant-1",
          text: "I’m using the simple-paper-QA skill.",
          status: "running",
          kind: "assistant_message",
        },
        createdAt: 1_000,
      },
      {
        runId: "run-interleaved-activity",
        seq: 2,
        eventType: "codex_tool_activity",
        payload: {
          type: "codex_tool_activity",
          itemId: "tool-1",
          phase: "completed",
          toolName: "paper_read",
          toolLabel: "Read paper",
          ok: true,
          text: "Read paper",
        },
        createdAt: 5_000,
      },
      {
        runId: "run-interleaved-activity",
        seq: 3,
        eventType: "codex_progress",
        payload: {
          type: "codex_progress",
          itemId: "assistant-2",
          text: "This is the final answer.",
          status: "running",
          kind: "assistant_message",
        },
        createdAt: 6_000,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(runningEvents, null, message);
    const firstAgentIndex = items.findIndex(
      (item) =>
        item.type === "message" && item.text.includes("simple-paper-QA"),
    );
    const toolIndex = items.findIndex(
      (item) => item.type === "action" && item.detailKey === "codex:tool-1",
    );
    const secondAgentIndex = items.findIndex(
      (item) => item.type === "message" && item.text.includes("final answer"),
    );
    assert.isAtLeast(firstAgentIndex, 0);
    assert.isAbove(toolIndex, firstAgentIndex);
    assert.isAbove(secondAgentIndex, toolIndex);

    const workingTrace = renderAgentTrace({
      doc: fakeDocument,
      message,
      events: runningEvents,
    }) as unknown as FakeElement;
    const workingDetails = workingTrace.findByClass(
      "llm-agent-activity-details",
    ) as
      | (FakeElement & {
          open?: boolean;
        })
      | null;
    assert.isTrue(workingDetails?.open);
    assert.equal(
      workingTrace.findByClass("llm-agent-activity-summary")?.textContent,
      "Working…",
    );
    assert.deepEqual(
      (workingDetails?.findAllByClass("llm-agent-process-message") || [])
        .map((entry) => `${entry.textContent}${entry.innerHTML}`)
        .filter(
          (text) =>
            text.includes("simple-paper-QA") || text.includes("final answer"),
        ),
      [
        "<p>I’m using the simple-paper-QA skill.</p>",
        "<p>This is the final answer.</p>",
      ],
      "both agent messages stay inside the open activity container",
    );
    assert.isNotNull(
      workingDetails?.findByClass("llm-agent-process-action") || null,
      "the interleaved tool trace stays in the same container",
    );

    const completedEvents: AgentRunEventRecord[] = [
      ...runningEvents,
      {
        runId: "run-interleaved-activity",
        seq: 4,
        eventType: "final",
        payload: {
          type: "final",
          text: "This is the final answer.",
          answerStartedAt: 6_000,
        },
        createdAt: 260_000,
      },
    ];
    message.streaming = false;
    message.text = "This is the final answer.";
    let suppressFinalAnswer = false;
    const completedTrace = renderAgentTrace({
      doc: fakeDocument,
      message,
      events: completedEvents,
      onInterleavedText: () => {
        suppressFinalAnswer = true;
      },
    }) as unknown as FakeElement;
    const completedDetails = completedTrace.findByClass(
      "llm-agent-activity-details",
    ) as
      | (FakeElement & {
          open?: boolean;
        })
      | null;
    assert.isFalse(completedDetails?.open);
    assert.equal(
      completedTrace.findByClass("llm-agent-activity-summary")?.textContent,
      "Worked for 4m 19s",
    );
    assert.deepEqual(
      (completedDetails?.findAllByClass("llm-agent-process-message") || [])
        .map((entry) => `${entry.textContent}${entry.innerHTML}`)
        .filter(
          (text) =>
            text.includes("simple-paper-QA") || text.includes("final answer"),
        ),
      [
        "<p>I’m using the simple-paper-QA skill.</p>",
        "<p>This is the final answer.</p>",
      ],
      "collapsing the container must not dismiss its trace",
    );
    assert.isFalse(suppressFinalAnswer);
    assert.isNotNull(
      completedTrace.findByClass("llm-agent-output-divider"),
      "the canonical final answer is rendered below the completed trace",
    );
  });

  it("keeps native proposal and user-message items out of generic activity text", function () {
    const message: any = {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
    };
    const controller = createCodexNativeActivityTraceControllerForTests(
      message,
      () => {},
    );
    for (const type of ["plan", "userMessage"]) {
      controller.appendItemStatus(
        { id: type, type, details: "Already rendered by its owning view" },
        "started",
      );
      controller.appendItemStatus(
        { id: type, type, details: "Already rendered by its owning view" },
        "completed",
      );
    }
    assert.isUndefined(message.pendingAgentTraceEvents);
  });

  it("refreshes native checklist progress without creating a reviewable proposal", function () {
    const message: any = {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
    };
    let refreshes = 0;
    const controller = createCodexNativeActivityTraceControllerForTests(
      message,
      () => {
        refreshes += 1;
      },
    );
    controller.appendNativePlanProgress([
      { content: "Inspect the scope", status: "completed" },
    ]);
    assert.equal(refreshes, 1);
    assert.deepEqual(
      message.pendingAgentTraceEvents.map((e: any) => e.eventType),
      ["codex_progress"],
    );
  });

  it("preserves every native Codex agent message and tool trace after completion", function () {
    const message = {
      role: "assistant" as const,
      text: "",
      timestamp: 1,
      runMode: "agent" as const,
      modelProviderLabel: "Codex",
      streaming: true,
    };
    const controller = createCodexNativeActivityTraceControllerForTests(
      message,
      () => undefined,
    );

    controller.appendAgentMessageDelta({
      itemId: "assistant-commentary",
      delta: "I’m using the simple-paper-QA skill.",
    });
    controller.noteAgentMessageCompleted({
      id: "assistant-commentary",
      type: "agent_message",
      role: "assistant",
      details: "I’m using the simple-paper-QA skill.",
    });
    controller.appendItemStatus(
      {
        id: "tool-1",
        type: "command_execution",
        command: "paper_read --target current",
      },
      "started",
    );
    controller.appendItemStatus(
      {
        id: "tool-1",
        type: "command_execution",
        command: "paper_read --target current",
        exitCode: 0,
      },
      "completed",
    );
    controller.appendAgentMessageDelta({
      itemId: "assistant-answer",
      delta: "This is the final answer.",
    });
    controller.noteAgentMessageCompleted({
      id: "assistant-answer",
      type: "agent_message",
      role: "assistant",
      details: "This is the final answer.",
    });

    controller.finish("This is the final answer.");
    const events = message.pendingAgentTraceEvents || [];
    assert.deepEqual(
      events.map((entry) => entry.payload.type),
      ["codex_progress", "codex_tool_activity", "codex_progress", "final"],
    );
    assert.deepEqual(
      events
        .filter((entry) => entry.payload.type === "codex_progress")
        .map((entry) =>
          entry.payload.type === "codex_progress" ? entry.payload.text : "",
        ),
      ["I’m using the simple-paper-QA skill.", "This is the final answer."],
    );
  });

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

    assert.include(rendered, "[[quote-occurrence:");
    assert.notInclude(rendered, `[[quote:${quoteCitation!.id}]]`);
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

    assert.include(rendered, "]]\n\nSo **one");
    assert.notInclude(rendered, "]]\nSo **one");
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
    assert.include(rendered, "[[quote-occurrence:");
    assert.notInclude(rendered, "> 记忆痕迹在巩固过程中具有高度动态性。");
    assert.notInclude(rendered, "(Tomé, 2024)");
    assert.notInclude(rendered, "[[quote:");
  });

  it("renders a rejected quote card without source attribution in interleaved agent text", function () {
    const quote =
      "This model interpretation is not wording from the cited source.";
    const rendered = buildAgentTraceMarkdownForRender(
      `> ${quote}\n\n(Eppler et al., 2026, page 3)`,
      {
        text: `> ${quote}\n\n(Eppler et al., 2026, page 3)`,
        quoteCitations: [],
        quoteDisplayOverride: {
          markdown: `> ${quote}\n>\n> Not a source quote`,
        },
      },
    );

    assert.include(rendered, "[[quote-occurrence:");
    assert.notInclude(rendered, "Eppler");
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

  it("preserves all native note heading levels without allowing executable attributes", function () {
    for (let level = 1; level <= 6; level++) {
      const heading = createSanitizerElement(`h${level}`);
      assert.isTrue(
        isSafeRenderedMarkdownElementForTests(heading),
        `h${level}`,
      );
      assert.isFalse(
        isSafeRenderedMarkdownAttributeForTests(heading, "onclick", "alert(1)"),
      );
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
        "rm -- '/Users/example/Desktop/Screenshot.png' && test ! -e '/Users/example/Desktop/Screenshot.png'",
      cwd: "/Users/example/Documents/zotero-dev/agent-runtime/profile-example",
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

  it("renders one Codex MCP row when Zotero MCP server aliases differ", function () {
    const args = {
      mode: "overview",
      target: {
        paperContext: {
          itemId: 3485,
          contextItemId: 3484,
          title:
            "A stable brain from unstable components: Emerging concepts and implications for neural computation",
          firstCreator: "Chambers and Rumpel",
          year: "2017",
          attachmentTitle: "PDF",
          citationKey: "chambersStableBrainUnstable2017",
          contentSourceMode: "mineru",
          mineruCacheDir:
            "/Users/example/Documents/zotero-dev/llm-for-zotero-mineru/3484",
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
        toolName: "mcp__llm-for-zotero-profile-dev__paper_read",
        toolLabel: "Read Paper",
        serverName: "llm-for-zotero-profile-dev",
        args,
      }),
    ];

    assert.deepEqual(getCodexTraceActionTexts(events), [
      "Codex received the request",
      "Used Read Paper",
    ]);
  });

  it("keeps distinct Codex tools that emit the same visible text", function () {
    const events: AgentRunEventRecord[] = [
      codexToolActivityEvent(1, {
        type: "codex_tool_activity",
        itemId: "paper-read-1",
        phase: "completed",
        toolName: "paper_read",
        serverName: "llm_for_zotero",
        args: { mode: "overview" },
        text: "Completed",
      }),
      codexToolActivityEvent(2, {
        type: "codex_tool_activity",
        itemId: "library-search-1",
        phase: "completed",
        toolName: "library_search",
        serverName: "llm_for_zotero",
        args: { entity: "items" },
        text: "Completed",
      }),
    ];

    assert.deepEqual(getCodexTraceActionTexts(events), [
      "Codex received the request",
      "Completed",
      "Completed",
    ]);
  });

  it("keeps same Codex tool text when arguments differ", function () {
    const events: AgentRunEventRecord[] = [
      codexToolActivityEvent(1, {
        type: "codex_tool_activity",
        itemId: "paper-read-1",
        phase: "completed",
        toolName: "paper_read",
        serverName: "llm_for_zotero",
        args: { mode: "overview", itemId: 1 },
        text: "Completed",
      }),
      codexToolActivityEvent(2, {
        type: "codex_tool_activity",
        itemId: "paper-read-2",
        phase: "completed",
        toolName: "paper_read",
        serverName: "llm_for_zotero",
        args: { mode: "overview", itemId: 2 },
        text: "Completed",
      }),
    ];

    assert.deepEqual(getCodexTraceActionTexts(events), [
      "Codex received the request",
      "Completed",
      "Completed",
    ]);
  });

  it("dedupes same Codex tool text when identity and arguments match", function () {
    const events: AgentRunEventRecord[] = [
      codexToolActivityEvent(1, {
        type: "codex_tool_activity",
        itemId: "paper-read-1",
        phase: "completed",
        toolName: "paper_read",
        serverName: "llm_for_zotero",
        args: { mode: "overview", itemId: 1 },
        text: "Completed",
      }),
      codexToolActivityEvent(2, {
        type: "codex_tool_activity",
        itemId: "paper-read-2",
        phase: "completed",
        toolName: "mcp__llm_for_zotero__paper_read",
        args: { itemId: 1, mode: "overview" },
        text: "Completed",
      }),
    ];

    assert.deepEqual(getCodexTraceActionTexts(events), [
      "Codex received the request",
      "Completed",
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
            "/Users/example/Documents/zotero-dev/llm-for-zotero-mineru/3442",
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

  it("preserves host-verified Zotero receipts when native tool events coalesce", function () {
    const assistantMessage = {
      role: "assistant" as const,
      text: "",
      timestamp: 1,
      runMode: "agent" as const,
    };
    const controller = createCodexNativeActivityTraceControllerForTests(
      assistantMessage,
      () => undefined,
    );
    const receipt = {
      id: "host-receipt",
      operation: "move_to_collection",
      status: "applied",
    };
    controller.noteMcpToolActivity({
      requestId: "jsonrpc:filing",
      phase: "completed",
      toolName: "update_library",
      arguments: { kind: "collections", action: "add" },
      ok: true,
      actionReceipts: [receipt],
    } as any);
    controller.appendItemStatus(
      {
        id: "native-filing",
        type: "tool_call",
        name: "mcp__llm_for_zotero__update_library",
        arguments: { kind: "collections", action: "add" },
      },
      "completed",
    );
    const events = (assistantMessage as any).pendingAgentTraceEvents || [];
    assert.deepEqual(
      events
        .filter((entry: any) => entry.payload.type === "codex_tool_activity")
        .flatMap((entry: any) => entry.payload.actionReceipts || []),
      [receipt],
    );
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

  it("coalesces native and MCP activity when Zotero server names use different separators", function () {
    const args = {
      mode: "overview",
      target: {
        paperContext: {
          itemId: 3485,
          contextItemId: 3484,
          title:
            "A stable brain from unstable components: Emerging concepts and implications for neural computation",
        },
      },
      maxChars: 6000,
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
      serverName: "llm_for_zotero",
      arguments: args,
      ok: true,
    });
    controller.appendItemStatus(
      {
        id: "native-tool-item-1",
        type: "tool_call",
        name: "mcp__llm-for-zotero-profile-dev__paper_read",
        title: "Read Paper",
        serverName: "llm-for-zotero-profile-dev",
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

  it("preserves artifacts when duplicate Codex tool activity rows are compacted", function () {
    const args = { mode: "figures", query: "Figure 1" };
    const events: AgentRunEventRecord[] = [
      codexToolActivityEvent(
        1,
        {
          type: "codex_tool_activity",
          itemId: "native-tool-item-1",
          phase: "completed",
          toolName: "mcp__llm_for_zotero__paper_read",
          toolLabel: "Read Paper",
          serverName: "llm_for_zotero",
          args,
          ok: true,
        },
        1000,
      ),
      codexToolActivityEvent(
        2,
        {
          type: "codex_tool_activity",
          itemId: "mcp:jsonrpc:figures-1",
          phase: "completed",
          toolName: "paper_read",
          toolLabel: "Read Paper",
          serverName: "llm_for_zotero",
          args,
          ok: true,
          artifacts: [
            {
              kind: "image",
              mimeType: "image/png",
              storedPath: "/tmp/mineru-paper/figure_crops/figure-1.png",
              title: "Figure 1",
              pageLabel: "2",
            },
          ],
        },
        1001,
      ),
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

    const artifactHolder = trace.findByClass("llm-agent-image-artifacts");
    assert.exists(artifactHolder);
    assert.deepEqual(
      trace
        .findAllByClass("llm-assistant-generated-image-caption")
        .map(collectFakeText),
      ["Figure 1"],
    );
    assert.equal(
      (
        trace.findByClass("llm-assistant-generated-image") as
          | (FakeElement & { src?: string })
          | null
      )?.src,
      "file:///tmp/mineru-paper/figure_crops/figure-1.png",
    );
  });

  it("renders distinct image artifact paths even when content hashes match", function () {
    const events: AgentRunEventRecord[] = [
      codexToolActivityEvent(1, {
        type: "codex_tool_activity",
        itemId: "mcp:jsonrpc:figures-duplicate-hash",
        phase: "completed",
        toolName: "paper_read",
        toolLabel: "Read Paper",
        serverName: "llm_for_zotero",
        args: { mode: "figures", query: "Figure 1" },
        ok: true,
        artifacts: [
          {
            kind: "image",
            mimeType: "image/png",
            storedPath: "/tmp/mineru-paper/figure_crops/figure-1-a.png",
            contentHash: "same-image-bytes",
            title: "Figure 1A",
          },
          {
            kind: "image",
            mimeType: "image/png",
            storedPath: "/tmp/mineru-paper/figure_crops/figure-1-b.png",
            contentHash: "same-image-bytes",
            title: "Figure 1B",
          },
        ],
      }),
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

    assert.deepInclude(getCodexTraceActionTexts(events), "Extracted 2 figures");
    assert.deepEqual(
      trace
        .findAllByClass("llm-assistant-generated-image")
        .map((image) => (image as unknown as { src?: string }).src),
      [
        "file:///tmp/mineru-paper/figure_crops/figure-1-a.png",
        "file:///tmp/mineru-paper/figure_crops/figure-1-b.png",
      ],
    );
  });

  it("renders local image artifacts from successful built-in tool results", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "figures-1",
          name: "paper_read",
          ok: true,
          content: {
            mode: "figures",
            status: "ok",
            figures: [{ label: "Figure 1" }, { label: "Figure 2" }],
          },
          artifacts: [
            {
              kind: "image",
              mimeType: "image/png",
              storedPath: "/tmp/mineru-paper/figure_crops/figure-1.png",
              title: "Figure 1",
              pageLabel: "2",
            },
            {
              kind: "image",
              mimeType: "image/png",
              storedPath: "/tmp/mineru-paper/figure_crops/page-4.png",
              pageLabel: "4",
            },
          ],
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

    const artifactHolder = trace.findByClass("llm-agent-image-artifacts");
    assert.exists(artifactHolder);
    assert.isFalse(
      artifactHolder?.classList.contains("llm-agent-image-artifacts-multiple"),
    );
    const images = trace.findAllByClass("llm-assistant-generated-image");
    assert.lengthOf(images, 2);
    assert.deepEqual(
      images.map((image) => (image as unknown as { src?: string }).src),
      [
        "file:///tmp/mineru-paper/figure_crops/figure-1.png",
        "file:///tmp/mineru-paper/figure_crops/page-4.png",
      ],
    );
    const captions = trace
      .findAllByClass("llm-assistant-generated-image-caption")
      .map(collectFakeText);
    assert.deepEqual(captions, ["Figure 1", "page-4.png"]);
  });

  it("bottom-aligns trace images with persistent label rows", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const gridRule =
      css.match(
        /\.llm-agent-image-artifacts\s+\.llm-agent-image-artifacts-grid\s*\{[\s\S]*?\}/,
      )?.[0] || "";
    const frameRule =
      css.match(
        /\.llm-agent-image-artifacts\s+\.llm-agent-image-artifact-frame\s*\{[\s\S]*?\}/,
      )?.[0] || "";
    const imageRule =
      css.match(
        /\.llm-agent-image-artifacts\s+\.llm-assistant-generated-image\s*\{[\s\S]*?\}/,
      )?.[0] || "";
    const captionRule =
      css.match(
        /\.llm-agent-image-artifacts\s+\.llm-assistant-generated-image-caption\s*\{[\s\S]*?\}/,
      )?.[0] || "";

    assert.include(gridRule, "align-items: end");
    assert.include(frameRule, "display: grid");
    assert.include(frameRule, "grid-template-rows: auto auto");
    assert.include(frameRule, "align-items: end");
    assert.include(frameRule, "justify-items: center");
    assert.include(frameRule, "border: 0");
    assert.include(frameRule, "border-radius: 0");
    assert.include(frameRule, "background: transparent");
    assert.include(imageRule, "width: auto");
    assert.include(imageRule, "max-width: 100%");
    assert.include(imageRule, "height: auto");
    assert.include(imageRule, "background: transparent");
    assert.include(captionRule, "position: static");
    assert.include(captionRule, "justify-self: stretch");
    assert.include(captionRule, "padding: 6px 2px 0");
    assert.include(captionRule, "border: 0");
    assert.include(captionRule, "background: transparent");
    assert.include(captionRule, "opacity: 1");
    assert.include(captionRule, "visibility: visible");
    assert.include(captionRule, "transform: none");
    assert.include(captionRule, "text-align: center");
    assert.notInclude(css, ".llm-agent-image-artifact-frame:hover");
    assert.notInclude(css, ".llm-agent-image-artifacts-multiple");
  });

  it("preserves Codex MCP image artifacts through native tool activity coalescing", function () {
    const args = { mode: "visual", pages: [3] };
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
      requestId: "jsonrpc:visual-1",
      phase: "completed",
      toolName: "paper_read",
      toolLabel: "Read Paper",
      serverName: "llm_for_zotero",
      arguments: args,
      ok: true,
      artifacts: [
        {
          kind: "image",
          mimeType: "image/png",
          storedPath: "/tmp/pages/page-3.png",
          title: "Paper - page 3",
          pageLabel: "3",
        },
      ],
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
    const activityEvents = events.filter(
      (entry) => entry.payload.type === "codex_tool_activity",
    );
    assert.lengthOf(activityEvents, 1);
    assert.deepEqual(
      (
        activityEvents[0].payload as Extract<
          AgentRunEventRecord["payload"],
          { type: "codex_tool_activity" }
        > & { artifacts?: Array<{ storedPath?: string }> }
      ).artifacts?.map((artifact) => artifact.storedPath),
      ["/tmp/pages/page-3.png"],
    );

    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: assistantMessage,
      events,
    }) as unknown as FakeElement;

    assert.exists(trace.findByClass("llm-agent-image-artifacts"));
    const image = trace.findByClass("llm-assistant-generated-image") as
      | (FakeElement & { src?: string; alt?: string })
      | null;
    assert.equal(image?.src, "file:///tmp/pages/page-3.png");
    assert.equal(image?.alt, "Paper - page 3");
  });

  it("renders Claude bridge codex activity image artifacts", function () {
    const events: AgentRunEventRecord[] = [
      codexToolActivityEvent(1, {
        type: "codex_tool_activity",
        itemId: "mcp:claude-visual-1",
        phase: "completed",
        toolName: "view_pdf_pages",
        toolLabel: "View PDF Pages",
        serverName: "llm_for_zotero",
        args: { pages: [1] },
        ok: true,
        artifacts: [
          {
            kind: "image",
            mimeType: "image/png",
            storedPath: "/tmp/pages/page-1.png",
            title: "Page 1",
          },
        ],
      }),
    ];

    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: {
        role: "assistant",
        text: "",
        timestamp: 1,
        runMode: "agent",
        modelProviderLabel: "Claude Code",
      },
      events,
    }) as unknown as FakeElement;

    assert.exists(trace.findByClass("llm-agent-image-artifacts"));
    assert.equal(
      (
        trace.findByClass("llm-assistant-generated-image") as
          | (FakeElement & { src?: string })
          | null
      )?.src,
      "file:///tmp/pages/page-1.png",
    );
  });

  it("does not render image artifact holders for failed or non-image results", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "failed-image",
          name: "file_io",
          ok: false,
          content: { error: "Image file not found" },
          artifacts: [
            {
              kind: "image",
              mimeType: "image/png",
              storedPath: "/tmp/missing.png",
            },
          ],
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "pdf-file",
          name: "read_attachment",
          ok: true,
          content: { ok: true },
          artifacts: [
            {
              kind: "file_ref",
              mimeType: "application/pdf",
              storedPath: "/tmp/paper.pdf",
              name: "paper.pdf",
            },
          ],
        },
        createdAt: 2,
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

    assert.isNull(trace.findByClass("llm-agent-image-artifacts"));
    assert.isEmpty(trace.findAllByClass("llm-assistant-generated-image"));
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
    assert.equal(
      collectFakeText(
        savedPathRoot.findByClass(
          "llm-assistant-generated-image-caption",
        ) as FakeElement,
      ),
      "result.png",
    );
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

  it("reveals path-backed generated assistant images in the file browser", async function () {
    const globalScope = globalThis as typeof globalThis & {
      Components?: unknown;
      Zotero?: {
        File?: { reveal?: (path: string) => void };
        launchURL?: (url: string) => void;
      };
    };
    const originalComponents = globalScope.Components;
    const originalZotero = globalScope.Zotero;
    let revealedPath = "";
    let launchedUrl = "";
    globalScope.Components = undefined;
    globalScope.Zotero = {
      ...(originalZotero || {}),
      File: {
        reveal: (path: string) => {
          revealedPath = path;
        },
      },
      launchURL: (url: string) => {
        launchedUrl = url;
      },
    };

    try {
      const container = fakeDocument.createElement("div") as HTMLElement;
      const statuses: string[] = [];
      assert.isTrue(
        renderAssistantGeneratedImagesInto(
          container,
          [
            {
              id: "figure-1",
              label: "Figure 1",
              path: "/tmp/mineru-cache/paper-1/figure-crops/figure-1.png",
            },
          ],
          fakeDocument,
          {
            onImageActionStatus: (message) => statuses.push(message),
          },
        ),
      );
      const openButton = (container as unknown as FakeElement).findByClass(
        "llm-generated-image-action-open",
      ) as FakeElement;

      const openClick = await openButton.dispatchFakeEventAsync("click");

      assert.isTrue(openClick.defaultPrevented);
      assert.isTrue(openClick.propagationStopped);
      assert.equal(
        revealedPath,
        "/tmp/mineru-cache/paper-1/figure-crops/figure-1.png",
      );
      assert.equal(launchedUrl, "");
      assert.deepEqual(statuses, ["Showed image in folder"]);
      assert.equal(openButton.title, "Show image in folder");
      assert.equal(openButton.attributes["aria-label"], "Show image in folder");
    } finally {
      if (originalComponents) {
        globalScope.Components = originalComponents;
      } else {
        delete globalScope.Components;
      }
      if (originalZotero) {
        globalScope.Zotero = originalZotero;
      } else {
        delete globalScope.Zotero;
      }
    }
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

  it("makes Claude Read calls with empty arguments distinguishable and expandable", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "read-1",
          name: "Read",
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
          callId: "read-1",
          name: "",
          ok: true,
          content: [
            "1\t# Representational drift reflects ongoing balancing of stochastic changes by Hebbian learning",
            "2\t",
            "3\tRecent evidence discusses signal and noise correlations.",
            "200\t4. cortex. Nature 594, 541546 (2021).",
          ].join("\n"),
        },
        createdAt: 2,
      },
      {
        runId: "run-1",
        seq: 3,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "read-2",
          name: "Read",
          args: {},
        },
        createdAt: 3,
      },
      {
        runId: "run-1",
        seq: 4,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "read-2",
          name: "",
          ok: true,
          content: [
            "200\t4. cortex. Nature 594, 541546 (2021).",
            "201\t5. Lear-du bas ...",
            "220\tAckNowLEDGMENTs. We thank members of the Kaschube and Rumpel lab.",
          ].join("\n"),
        },
        createdAt: 4,
      },
      {
        runId: "run-1",
        seq: 5,
        eventType: "final",
        payload: { type: "final", text: "Done." },
        createdAt: 5,
      },
    ];

    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: {
        role: "assistant",
        text: "Done.",
        timestamp: 1,
        runMode: "agent",
        modelProviderLabel: "Claude Code",
      },
      events,
    }) as unknown as FakeElement;

    const actionTexts = trace
      .findAllByClass("llm-at-text")
      .map(collectFakeText);
    assert.include(actionTexts, "Using Read lines 1-200");
    assert.include(actionTexts, "Using Read lines 200-220");

    const expandableActions = trace.findAllByClass(
      "llm-agent-process-action-expandable",
    );
    assert.lengthOf(expandableActions, 2);

    const detailValues = trace
      .findAllByClass("llm-agent-process-detail-value")
      .map(collectFakeText);
    assert.include(detailValues, "Lines 1-200");
    assert.include(detailValues, "Lines 200-220");
    assert.isAtLeast(
      detailValues.filter((value) => /^\d+ chars$/.test(value)).length,
      2,
    );
    assert.isTrue(
      detailValues.some((value) =>
        value.includes(
          "Recent evidence discusses signal and noise correlations.",
        ),
      ),
    );
    assert.isTrue(
      detailValues.some((value) =>
        value.includes(
          "AckNowLEDGMENTs. We thank members of the Kaschube and Rumpel lab.",
        ),
      ),
    );
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

  it("uses the shared Paper chip structure across agent providers", function () {
    const providers = ["Claude Code", "Codex", "OpenAI", "Anthropic", "Gemini"];
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-provider-parity",
        seq: 1,
        eventType: "final",
        payload: { type: "final", text: "Done." },
        createdAt: 1,
      },
    ];

    for (const modelProviderLabel of providers) {
      const trace = renderAgentTrace({
        doc: fakeDocument,
        userMessage: {
          role: "user",
          text: "Use this paper.",
          timestamp: 1,
          paperContexts: [
            {
              itemId: 10,
              contextItemId: 11,
              title: "Provider parity paper",
            },
          ],
        },
        message: {
          role: "assistant",
          text: "Done.",
          timestamp: 2,
          runMode: "agent",
          modelProviderLabel,
        },
        events,
      }) as unknown as FakeElement;

      const chips = trace.findAllByClass("llm-agent-process-chip");
      assert.lengthOf(chips, 1, modelProviderLabel);
      const icon = chips[0].findByClass("llm-agent-process-chip-icon");
      const label = chips[0].findByClass("llm-agent-process-chip-label");
      assert.isNotNull(icon, modelProviderLabel);
      assert.isTrue(
        icon?.classList.contains("llm-context-svg-icon"),
        modelProviderLabel,
      );
      assert.isTrue(
        icon?.classList.contains("llm-context-icon-paper"),
        modelProviderLabel,
      );
      assert.equal(label ? collectFakeText(label) : "", "Paper");
    }
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

  it("keeps agent trace chip icons aligned to the first label line", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const chipRule =
      css.match(/\.llm-agent-process-chip\s*\{[\s\S]*?\}/)?.[0] || "";
    const chipIconRule =
      css.match(/\.llm-agent-process-chip-icon\s*\{[\s\S]*?\}/)?.[0] || "";
    const svgIconRule =
      css.match(
        /\.llm-agent-process-chip-icon\.llm-context-svg-icon\s*\{[\s\S]*?\}/,
      )?.[0] || "";
    const fallbackIconRule =
      css.match(
        /\.llm-agent-process-chip-icon:not\(\.llm-context-svg-icon\)\s*\{[\s\S]*?\}/,
      )?.[0] || "";
    assert.include(chipRule, "align-items: flex-start");
    assert.include(
      chipIconRule,
      "margin-block-start: calc(0.25px * var(--llm-font-scale, 1))",
    );
    assert.include(svgIconRule, "width: var(--llm-fs-12)");
    assert.include(svgIconRule, "height: var(--llm-fs-12)");
    assert.include(fallbackIconRule, "font-size: var(--llm-fs-12)");
    assert.include(fallbackIconRule, "line-height: 1");

    for (const fontScale of [0.8, 1.2, 1.8]) {
      const labelLineCenter = (10 * fontScale * 1.25) / 2;
      const iconCenter = 0.25 * fontScale + (12 * fontScale) / 2;
      assert.approximately(iconCenter, labelLineCenter, 1e-9);
    }
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

  it("splits one logical reasoning step around a visible agent message", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-reasoning-message-boundary",
        seq: 1,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          stepId: "reasoning-a",
          details: "Checked the first batch.",
        },
        createdAt: 1,
      },
      {
        runId: "run-reasoning-message-boundary",
        seq: 2,
        eventType: "codex_progress",
        payload: {
          type: "codex_progress",
          itemId: "message-1",
          text: "Classifications batch 3: 89 items reviewed.",
          kind: "assistant_message",
        },
        createdAt: 2,
      },
      {
        runId: "run-reasoning-message-boundary",
        seq: 3,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          stepId: "reasoning-a",
          details: "Continued with the remaining receipts.",
        },
        createdAt: 3,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null, {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
      modelProviderLabel: "Codex",
    });
    const reasoningItems = items.filter((item) => item.type === "reasoning");
    const messageIndex = items.findIndex(
      (item) =>
        item.type === "message" &&
        item.text === "Classifications batch 3: 89 items reviewed.",
    );

    assert.lengthOf(reasoningItems, 2);
    assert.equal(reasoningItems[0].logicalKey, reasoningItems[1].logicalKey);
    assert.notEqual(reasoningItems[0].key, reasoningItems[1].key);
    assert.equal(reasoningItems[0].summary, "Checked the first batch.");
    assert.equal(
      reasoningItems[1].summary,
      "Continued with the remaining receipts.",
    );
    assert.isBelow(items.indexOf(reasoningItems[0]), messageIndex);
    assert.isBelow(messageIndex, items.indexOf(reasoningItems[1]));
  });

  it("splits fallback reasoning around a visible agent message", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-fallback-reasoning-message-boundary",
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
        runId: "run-fallback-reasoning-message-boundary",
        seq: 2,
        eventType: "codex_progress",
        payload: {
          type: "codex_progress",
          itemId: "message-1",
          text: "The first pass is complete.",
          kind: "assistant_message",
        },
        createdAt: 2,
      },
      {
        runId: "run-fallback-reasoning-message-boundary",
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
    assert.deepEqual(
      reasoningItems.map((item) => item.summary),
      ["First thought.", "Second thought."],
    );
    assert.notEqual(reasoningItems[0].key, reasoningItems[1].key);
  });

  it("splits reasoning around visible status and confirmation-card activity", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-visible-boundaries",
        seq: 1,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          stepId: "shared-step",
          details: "Before status.",
        },
        createdAt: 1,
      },
      {
        runId: "run-visible-boundaries",
        seq: 2,
        eventType: "status",
        payload: {
          type: "status",
          text: "Reviewing classifications",
        },
        createdAt: 2,
      },
      {
        runId: "run-visible-boundaries",
        seq: 3,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          stepId: "shared-step",
          details: "Before confirmation.",
        },
        createdAt: 3,
      },
      {
        runId: "run-visible-boundaries",
        seq: 4,
        eventType: "confirmation_required",
        payload: {
          type: "confirmation_required",
          requestId: "confirmation-1",
          action: {
            toolName: "write_note",
            mode: "approval",
            title: "Approve note creation",
            confirmLabel: "Create note",
            cancelLabel: "Cancel",
            fields: [],
          },
        },
        createdAt: 4,
      },
      {
        runId: "run-visible-boundaries",
        seq: 5,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          stepId: "shared-step",
          details: "After confirmation.",
        },
        createdAt: 5,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const reasoningItems = items.filter((item) => item.type === "reasoning");

    assert.deepEqual(
      reasoningItems.map((item) => item.summary),
      ["Before status.", "Before confirmation.", "After confirmation."],
    );
    assert.equal(new Set(reasoningItems.map((item) => item.key)).size, 3);
  });

  it("keeps reasoning consecutive across hidden provider and usage events", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-hidden-boundaries",
        seq: 1,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          stepId: "shared-step",
          details: "First ",
        },
        createdAt: 1,
      },
      {
        runId: "run-hidden-boundaries",
        seq: 2,
        eventType: "provider_event",
        payload: {
          type: "provider_event",
          providerType: "openai_compatible",
          payload: { kind: "stream_tick" },
        },
        createdAt: 2,
      },
      {
        runId: "run-hidden-boundaries",
        seq: 3,
        eventType: "usage",
        payload: {
          type: "usage",
          round: 1,
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12,
        },
        createdAt: 3,
      },
      {
        runId: "run-hidden-boundaries",
        seq: 4,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          stepId: "shared-step",
          details: "second.",
        },
        createdAt: 4,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const reasoningItems = items.filter((item) => item.type === "reasoning");

    assert.lengthOf(reasoningItems, 1);
    assert.equal(reasoningItems[0].summary, "First second.");
  });

  it("keeps expansion state independent for split segments of one logical step", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-independent-reasoning-segments",
        seq: 1,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          stepId: "shared-step",
          details: "First segment.",
        },
        createdAt: 1,
      },
      {
        runId: "run-independent-reasoning-segments",
        seq: 2,
        eventType: "codex_progress",
        payload: {
          type: "codex_progress",
          itemId: "message-1",
          text: "Intermediate update.",
          kind: "assistant_message",
        },
        createdAt: 2,
      },
      {
        runId: "run-independent-reasoning-segments",
        seq: 3,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          stepId: "shared-step",
          details: "Second segment.",
        },
        createdAt: 3,
      },
    ];
    const message = {
      role: "assistant" as const,
      text: "",
      timestamp: 1,
      runMode: "agent" as const,
      modelProviderLabel: "Codex",
      streaming: true,
    };

    const firstRender = renderAgentTrace({
      doc: fakeDocument,
      message,
      events,
    }) as unknown as FakeElement;
    const firstSummaries = firstRender.findAllByClass(
      "llm-agent-reasoning-summary",
    );
    assert.lengthOf(firstSummaries, 2);
    firstSummaries[0].dispatchFakeEvent("pointerdown");

    const secondRender = renderAgentTrace({
      doc: fakeDocument,
      message,
      events,
    }) as unknown as FakeElement;
    const reasoningBlocks = secondRender.findAllByClass(
      "llm-agent-reasoning",
    ) as Array<FakeElement & { open?: boolean }>;

    assert.lengthOf(reasoningBlocks, 2);
    assert.isTrue(Boolean(reasoningBlocks[0].open));
    assert.isFalse(Boolean(reasoningBlocks[1].open));
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
          stepId: "shared-step",
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
          stepId: "shared-step",
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
      label: "Thinking for step 1",
    });
    assert.deepInclude(reasoningItems[1], {
      type: "reasoning",
      summary: "Second thought.",
      label: "Thinking for step 1",
    });
    assert.notEqual(reasoningItems[0].key, reasoningItems[1].key);
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
      showsFooterExecuteButton: true,
    });
  });

  it("promotes drawer alternatives without executing them immediately", function () {
    const action: AgentPendingAction = {
      toolName: "approve_research_expansion",
      mode: "review",
      title: "More scoped papers qualify for deep reading.",
      description: "Choose how the research should continue.",
      confirmLabel: "Continue research",
      cancelLabel: "Revise or cancel",
      actions: [
        {
          id: "expand_continue",
          label: "Expand and continue",
          style: "primary",
        },
        {
          id: "finish_limitations",
          label: "Finish with limitations",
          style: "secondary",
        },
        {
          id: "revise_cancel",
          label: "Revise or cancel",
          style: "secondary",
        },
      ],
      defaultActionId: "expand_continue",
      cancelActionId: "revise_cancel",
      fields: [],
    };

    const card = renderPendingActionCard(fakeDocument, {
      requestId: "research-expansion",
      action,
    }) as unknown as FakeElement;
    const content = card.findByClass("llm-agent-hitl-content");
    const drawer = card.findByClass("llm-agent-hitl-action-choices");
    const footer = card.findByClass("llm-agent-hitl-footer");
    const toggle = card
      .findAllByTag("button")
      .find((button) => button.dataset.kind === "alternatives");
    const execute = card
      .findAllByTag("button")
      .find((button) => button.dataset.kind === "save");
    const cancel = card
      .findAllByTag("button")
      .find((button) => button.dataset.kind === "cancel");
    const alternative = card
      .findAllByClass("llm-agent-hitl-alternative")
      .find((button) => button.dataset.actionChoice === "finish_limitations");

    assert.strictEqual(card.children[0], content);
    assert.exists(drawer);
    assert.exists(footer);
    assert.exists(toggle);
    assert.exists(execute);
    assert.exists(cancel);
    assert.equal(toggle?.attributes["aria-expanded"], "false");
    assert.equal(drawer?.dataset.open, "false");
    assert.equal(execute?.textContent, "Expand and continue");
    assert.equal(execute?.dataset.actionId, "expand_continue");

    toggle?.dispatchFakeEvent("click");
    assert.equal(toggle?.attributes["aria-expanded"], "true");
    assert.equal(drawer?.dataset.open, "true");

    assert.doesNotThrow(() => alternative?.dispatchFakeEvent("click"));
    assert.equal(card.dataset.activeActionId, "finish_limitations");
    assert.equal(drawer?.dataset.open, "false");
    assert.equal(execute?.textContent, "Finish with limitations");
    assert.equal(execute?.dataset.actionId, "finish_limitations");
    assert.isFalse(cancel?.disabled || false);
  });

  it("preserves the note diff subtree inside the redesigned card body", function () {
    const action: AgentPendingAction = {
      toolName: "edit_current_note",
      mode: "review",
      title: "Review note update",
      description: "Review the proposed note changes before applying them.",
      confirmLabel: "Apply edit",
      cancelLabel: "Cancel",
      fields: [
        {
          type: "diff_preview",
          id: "noteDiff",
          label: "Note changes",
          before: "Old claim\nShared context",
          after: "New claim\nShared context",
          contextLines: 0,
        },
      ],
    };

    const card = renderPendingActionCard(fakeDocument, {
      requestId: "note-edit-diff",
      action,
    }) as unknown as FakeElement;
    const content = card.findByClass("llm-agent-hitl-content");
    const diff = card.findByClass("llm-agent-hitl-diff");

    assert.strictEqual(card.children[0], content);
    assert.exists(diff?.findByClass("llm-agent-hitl-diff-body"));
    assert.exists(diff?.findByClass("llm-agent-hitl-diff-gutter"));
    assert.exists(diff?.findByClass("llm-agent-hitl-diff-line-remove"));
    assert.exists(diff?.findByClass("llm-agent-hitl-diff-line-add"));
    assert.exists(diff?.findByClass("llm-agent-hitl-diff-content"));
  });

  it("shows scoped fields for a promoted edit action and can return safely", function () {
    const action: AgentPendingAction = {
      toolName: "literature_search",
      mode: "review",
      title: "Review online literature results",
      confirmLabel: "Import selected",
      cancelLabel: "Cancel",
      actions: [
        { id: "import", label: "Import selected", style: "primary" },
        {
          id: "new_search",
          label: "Search again",
          style: "secondary",
          executionMode: "edit",
          submitLabel: "Confirm search",
          backLabel: "Get back",
        },
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

    const card = renderPendingActionCard(fakeDocument, {
      requestId: "search-again",
      action,
    }) as unknown as FakeElement;
    const field = card.findByClass(
      "llm-agent-hitl-field",
    ) as unknown as HTMLElement | null;
    const toggle = card
      .findAllByTag("button")
      .find((button) => button.dataset.kind === "alternatives") as unknown as
      | HTMLElement
      | undefined;
    const back = card
      .findAllByTag("button")
      .find((button) => button.dataset.kind === "back") as unknown as
      | HTMLElement
      | undefined;
    const execute = card
      .findAllByTag("button")
      .find((button) => button.dataset.kind === "save");
    const editAlternative = card
      .findAllByClass("llm-agent-hitl-alternative")
      .find((button) => button.dataset.actionChoice === "new_search");

    assert.isTrue(Boolean(field?.hidden));
    assert.isFalse(Boolean(toggle?.hidden));
    assert.isTrue(Boolean(back?.hidden));

    editAlternative?.dispatchFakeEvent("click");
    assert.isFalse(Boolean(field?.hidden));
    assert.isTrue(Boolean(toggle?.hidden));
    assert.isFalse(Boolean(back?.hidden));
    assert.equal(execute?.textContent, "Confirm search");

    (back as unknown as FakeElement | undefined)?.dispatchFakeEvent("click");
    assert.isTrue(Boolean(field?.hidden));
    assert.isFalse(Boolean(toggle?.hidden));
    assert.equal(execute?.textContent, "Import selected");
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

  it("renders a single-paper auto-tag review and regenerates before applying", function () {
    const tool = createApplyTagsTool({
      getPaperTargetsByItemIds: () => [
        {
          itemId: 7,
          title: "Distributed and drifting representations of working memory",
          firstCreator: "Adam et al.",
          year: "2025",
          tags: [],
        },
      ],
    } as never);
    const input = tool.validate({
      action: "add",
      id: "auto_tag:page:1:1:size:20:tags:5",
      assignments: [{ itemId: 7, tags: ["working memory", "fmri"] }],
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    const action = tool.createPendingAction!(input.value, {} as never);
    const resolutions: AgentConfirmationResolution[] = [];
    const card = renderPendingActionCard(
      fakeDocument,
      {
        requestId: "auto-tag-single",
        action,
      },
      (_requestId, resolution) => {
        resolutions.push(resolution);
      },
    ) as unknown as FakeElement;
    assert.equal(action.title, "Add tags to 1 item");
    assert.isNull(card.findByClass("llm-agent-hitl-page-indicator"));
    assert.isNull(card.findByClass("llm-agent-hitl-paged-footer-field"));
    assert.exists(card.findByClass("llm-agent-hitl-tag-assignment-table"));
    const controls = card.findByClass("llm-agent-hitl-paged-top-controls")!;
    assert.include(
      controls.findByClass("llm-agent-hitl-control-help")!.textContent,
      "regenerates",
    );
    const select = controls.findAllByTag("select")[0] as FakeElement & {
      value: string;
    };
    assert.equal(select.getAttribute("aria-label"), "Tags per paper");
    select.value = "3";
    select.dispatchFakeEvent("change");
    assert.lengthOf(resolutions, 1);
    assert.isFalse(resolutions[0].approved);
    assert.equal(resolutions[0].actionId, "refresh");
    assert.equal(resolutions[0].data?.tagsPerPaper, "3");
    assert.isTrue(select.disabled);
    assert.isTrue(
      card.findByClass("llm-agent-hitl-paged-confirm-btn")!.disabled,
    );
  });

  it("keeps auto-tag controls compact, tags readable, and actions separated", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const footer = css.match(
      /\.llm-agent-hitl-paged-actions\s*\{[\s\S]*?\}/,
    )![0];
    assert.notInclude(footer, "margin-top: 0");
    const controls = css.match(
      /\.llm-agent-hitl-paged-top-field,\s*\.llm-agent-hitl-paged-footer-field\s*\{[\s\S]*?\}/,
    )![0];
    assert.include(controls, "flex-direction: row");
    const numberControl = css.match(
      /\.llm-agent-hitl-paged-top-field \.llm-agent-hitl-page-input,\s*\.llm-agent-hitl-paged-footer-field \.llm-agent-hitl-page-input\s*\{[\s\S]*?\}/,
    )![0];
    assert.include(numberControl, "appearance: none");
    assert.include(numberControl, "text-align: center");
    assert.include(numberControl, "text-align-last: center");
    assert.include(numberControl, "width: 40px");
    assert.include(numberControl, "min-height: 26px");
    assert.notInclude(
      css,
      ".llm-agent-hitl-paged-footer-field .llm-agent-hitl-label {\n    display: none",
    );
    assert.match(
      css,
      /\.llm-agent-hitl-tag-assignment-table \.llm-agent-hitl-assignment-row\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/,
    );
    assert.match(
      css,
      /\.llm-agent-hitl-tag-chip-list\s*\{[^}]*flex-wrap: wrap/,
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
      card.findByClass("llm-plan-status")?.textContent,
      "Awaiting approval",
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
      "Tags per paper",
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

  it("keeps streamed text before reasoning inline and terminal text in the answer area", function () {
    const intermediateText = "I checked the first set of receipts.";
    const terminalText = "The receipt-backed classification is complete.";
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-message-reasoning-message",
        seq: 1,
        eventType: "message_delta",
        payload: { type: "message_delta", text: intermediateText },
        createdAt: 1,
      },
      {
        runId: "run-message-reasoning-message",
        seq: 2,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          details: "Verifying the remaining evidence.",
        },
        createdAt: 2,
      },
      {
        runId: "run-message-reasoning-message",
        seq: 3,
        eventType: "message_delta",
        payload: { type: "message_delta", text: terminalText },
        createdAt: 3,
      },
    ];

    const { items, isInterleaved, inlineTextReplacesAssistantText } =
      buildAgentTraceDisplayItems(events, null, {
        role: "assistant",
        text: terminalText,
        timestamp: 1,
        runMode: "agent",
        modelProviderLabel: "Gemini",
        streaming: true,
      });
    const inlineTexts = items
      .filter(
        (
          item,
        ): item is Extract<(typeof items)[number], { type: "inline_text" }> =>
          item.type === "inline_text",
      )
      .map((item) => item.text);
    const intermediateIndex = items.findIndex(
      (item) => item.type === "inline_text" && item.text === intermediateText,
    );
    const reasoningIndex = items.findIndex((item) => item.type === "reasoning");

    assert.isTrue(isInterleaved);
    assert.isFalse(inlineTextReplacesAssistantText);
    assert.deepEqual(inlineTexts, [intermediateText]);
    assert.isBelow(intermediateIndex, reasoningIndex);
  });

  it("deduplicates the final answer after interleaved reasoning activity", function () {
    const intermediateText = "I checked the first set of receipts.";
    const finalText = "The receipt-backed classification is complete.";
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-message-reasoning-final",
        seq: 1,
        eventType: "message_delta",
        payload: { type: "message_delta", text: intermediateText },
        createdAt: 1,
      },
      {
        runId: "run-message-reasoning-final",
        seq: 2,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          details: "Verifying the remaining evidence.",
        },
        createdAt: 2,
      },
      {
        runId: "run-message-reasoning-final",
        seq: 3,
        eventType: "message_delta",
        payload: { type: "message_delta", text: finalText },
        createdAt: 3,
      },
      {
        runId: "run-message-reasoning-final",
        seq: 4,
        eventType: "final",
        payload: { type: "final", text: finalText },
        createdAt: 4,
      },
    ];

    const { items, isInterleaved, inlineTextReplacesAssistantText } =
      buildAgentTraceDisplayItems(events, null, {
        role: "assistant",
        text: finalText,
        timestamp: 1,
        runMode: "agent",
        modelProviderLabel: "OpenAI",
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
    assert.deepEqual(inlineTexts, [intermediateText]);
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
            access: "library",
            effect: "read",
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

  it("labels a judgment write as the agent's own call", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-judgment",
        seq: 1,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "call-judgment",
          name: "judgment_tags",
          ok: true,
          actionReceipts: [],
          content: { tagged: 1 },
          authority: "yolo_judgment",
        },
        createdAt: 1,
      },
    ];
    const { items } = buildAgentTraceDisplayItems(events, null);
    const rows = items.flatMap((item) =>
      item.type === "action" ? [item.row.text] : [],
    );
    // The trace always opens with the request row; the judgment write must add
    // exactly one visible row after it.
    assert.deepEqual(rows, [
      "Request received",
      "Judgment Tags completed (agent's own call)",
    ]);
  });

  it("keeps the judgment label ahead of the merged-result shortcut", function () {
    // A tool whose result merges into the call row returns before any row is
    // built. Only a live agent runtime resolves tool presentation, which this
    // renderer harness has no way to provide, so the ordering is pinned at the
    // source instead of through a rendered event.
    const source = readFileSync(
      "src/modules/contextPanel/agentTrace/render.ts",
      "utf8",
    );
    const caseStart = source.indexOf('case "tool_result": {');
    assert.isAtLeast(caseStart, 0);
    const judgmentAt = source.indexOf(
      'const judgment = entry.payload.authority === "yolo_judgment";',
      caseStart,
    );
    const mergeAt = source.indexOf("mergeResultIntoCallTrace", caseStart);
    assert.isAtLeast(judgmentAt, 0, "the judgment check must exist");
    assert.isAtLeast(mergeAt, 0);
    assert.isBelow(
      judgmentAt,
      mergeAt,
      "a judgment write must be labelled before the merge shortcut returns",
    );
    assert.include(
      source.slice(judgmentAt, mergeAt),
      "!judgment &&",
      "the merge shortcut must not swallow a judgment write",
    );
  });
});

describe("new research progress presentation", function () {
  for (const fromToolResult of [false, true])
    it("maps known paper references without altering the progress layout", function () {
      const events = [
        fromToolResult
          ? {
              type: "tool_result",
              name: "update_plan",
              callId: "plan",
              ok: true,
              content: { displayLabels: { "1:AAAA1111": "(Smith, 2024)" } },
            }
          : {
              type: "provider_event",
              providerType: "paper_display_labels",
              payload: {
                version: 1,
                displayLabels: { "1:AAAA1111": "(Smith, 2024)" },
              },
            },
        { type: "message_delta", text: "Inspecting AAAA1111 after recovery." },
        {
          type: "message_rollback",
          text: "Inspecting AAAA1111 after recovery.",
          length: 39,
        },
        {
          type: "reasoning",
          round: 1,
          details: "Evidence for 1:AAAA1111 is retained.",
        },
      ].map((payload, index) => ({
        runId: "new-research",
        seq: index,
        eventType: payload.type,
        payload,
        createdAt: index,
      })) as AgentRunEventRecord[];
      const result = buildAgentTraceDisplayItems(events, null, {
        role: "assistant",
        text: "",
        timestamp: 1,
        runMode: "agent",
      });
      const serialized = JSON.stringify(result.items);
      assert.notInclude(serialized, "AAAA1111");
      assert.include(serialized, "(Smith, 2024)");
      assert.isTrue(result.items.some((item) => item.type === "inline_text"));
    });
});
