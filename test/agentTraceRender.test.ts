import {
  renderPlanProgress,
  disposePlanProgress,
  isFloatingPlanExecutionStatus,
} from "../src/modules/contextPanel/agentTrace/planProgressView";
import { assert } from "chai";
import { createApplyTagsTool } from "../src/agent/tools/write/applyTags";
import { createFileIOTool } from "../src/agent/tools/write/fileIO";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import { createRunCommandTool } from "../src/agent/tools/write/runCommand";
import { setAgentToolPresentationResolverForTests } from "../src/modules/contextPanel/agentTrace/toolPresentation";
import type { AgentConfirmationResolution } from "../src/agent/types";
import { readFileSync } from "node:fs";
import {
  buildAgentTraceChipDetails,
  buildAgentTraceDisplayItems,
  buildAgentTraceMarkdownForRender,
  formatAgentActivityDuration,
  disposeAgentTrace,
  getPendingActionButtonLayout,
  renderAgentTrace,
  renderAgentTraceDetailsBodyForTests,
  renderPendingActionCard,
  selectToolResultTraceCards,
} from "../src/modules/contextPanel/agentTrace/render";
import { buildNoteChangeResultCards } from "../src/agent/tools/write/noteChangePresentation";
import { buildClaudeMcpToolActivityEvent } from "../src/agent/externalBackendBridge";
import { buildCodexNativeEffectActivityEvent } from "../src/codexAppServer/nativeClient";
import { externalRuntimeCommandEffect } from "../src/agent/contracts/externalRuntimeEffects";
import { mergeToolActivityPayload } from "../src/modules/contextPanel/agentTrace/toolActivityDedupe";
import { createCodexNativeActivityTraceControllerForTests } from "../src/modules/contextPanel/codexNativeTrace/controller";
import {
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
  ActionCardEntry,
  AgentActionSummaryResultCard,
  AgentNoteChangeResultCard,
  AgentPendingAction,
  AgentRunEventRecord,
  AgentSavedNoteResultCard,
} from "../src/agent/types";
import { renderActionCardDetail } from "../src/modules/contextPanel/agentTrace/actionCardNoteDetail";
import { renderActionSummaryCard } from "../src/modules/contextPanel/agentTrace/actionSummaryCard";
import type { NavigationHost } from "../src/modules/contextPanel/agentTrace/actionCardNavigation";
import { createMalformedToolArgumentsDiagnostic } from "../src/agent/toolArgumentDiagnostics";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";
import {
  isEmbeddableGeneratedImage,
  resolveGeneratedImageAsset,
} from "../src/services/images/generatedImageAssets";
import {
  getStableAnimationDelay,
  STABLE_ANIMATION_DELAY_PROPERTY,
} from "../src/modules/contextPanel/stableAnimationPhase";
import {
  collectFakeText,
  fakeDocument,
  FakeElement,
  ThrowingTemplateElement,
} from "./helpers/fakeDom";

/** The result shape a failed note write journals, as the note tool writes it. */
function failedNoteChangeContent(): Record<string, unknown> {
  return {
    actionId: "journal-action-1",
    status: "failed",
    noteChange: {
      title: "Representational drift",
      note: { itemId: 77, libraryID: 1, key: "ABCD1234" },
      conversationKey: 5,
      state: "failed",
      before: { checksum: "sha256:before", recoveryId: "recovery-before" },
      after: { checksum: "sha256:after", recoveryId: "recovery-after" },
      description: "Zotero refused the note save.",
    },
  };
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

type AgentTraceTestItem = ReturnType<
  typeof buildAgentTraceDisplayItems
>["items"][number];

/**
 * Every display item in reading order, stage groups opened out.
 *
 * A stage nests the rows it produced, so an assertion about the rows reads
 * this view; the stage's own heading stays in the list where it sits.
 */
function flattenTraceItems(
  items: readonly AgentTraceTestItem[],
): AgentTraceTestItem[] {
  const flat: AgentTraceTestItem[] = [];
  for (const item of items) {
    flat.push(item);
    if (item.type === "stage") flat.push(...flattenTraceItems(item.children));
  }
  return flat;
}

/** Every action row, inside a stage group or not. */
function traceActionItems(
  items: readonly AgentTraceTestItem[],
): Extract<AgentTraceTestItem, { type: "action" }>[] {
  return flattenTraceItems(items).filter(
    (item): item is Extract<AgentTraceTestItem, { type: "action" }> =>
      item.type === "action",
  );
}

/**
 * Every chip the reader sees, in order.
 *
 * A stage heading carries the aggregate of what its rows proved and the rows
 * carry only what it does not, so reading both never double-counts a verdict.
 */
function traceChipLabelsOf(items: readonly AgentTraceTestItem[]): string[] {
  return flattenTraceItems(items).flatMap((item) =>
    item.type === "action" || item.type === "stage"
      ? (item.chips || []).map((chip) => chip.label)
      : [],
  );
}

/** What the reader reads, top to bottom: stage headings and their rows. */
function traceRowTexts(items: readonly AgentTraceTestItem[]): string[] {
  return flattenTraceItems(items)
    .filter(
      (
        item,
      ): item is Extract<AgentTraceTestItem, { type: "action" | "stage" }> =>
        item.type === "action" || item.type === "stage",
    )
    .map((item) => (item.type === "stage" ? item.label : item.row.text));
}

type TestToolPresentations = Record<
  string,
  NonNullable<ReturnType<typeof createFileIOTool>["presentation"]> | undefined
>;

/**
 * Answer the trace's presentation lookups from the specs under test.
 *
 * The renderer asks the live tool registry how a tool presents itself, and a
 * unit test has no way to stand that registry up, so a test that asserts a
 * tool's own presentation installs the specs it is asserting about.
 */
function withToolPresentations(
  presentations: TestToolPresentations,
  run: () => void,
): void {
  withToolPresentationsReturning(presentations, run);
}

function withToolPresentationsReturning<T>(
  presentations: TestToolPresentations,
  run: () => T,
): T {
  setAgentToolPresentationResolverForTests((name) => presentations[name]);
  try {
    return run();
  } finally {
    setAgentToolPresentationResolverForTests(null);
  }
}

/** The real paper tool's presentation, built without its runtime services. */
function paperReadPresentation() {
  return createPaperReadTool(
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  ).presentation;
}

/**
 * A template whose parsed content can be walked, as chrome's parser gives it.
 *
 * A note preview renders the note's own sanitized HTML, so a test that asserts
 * what the reader sees of a note has to let that parse produce elements.
 */
class ParsingTemplateElement extends FakeElement {
  public readonly content = new FakeElement("div");

  constructor() {
    super("template");
  }

  set innerHTML(value: string) {
    for (const [, tag, text] of value.matchAll(/<(\w+)>([^<]*)<\/\1>/g)) {
      const node = new FakeElement(tag);
      node.textContent = text;
      this.content.appendChild(node);
    }
  }

  get innerHTML(): string {
    return "";
  }
}

/** The document the note surfaces are rendered into. */
const noteDocument = {
  createElement: (tagName: string) =>
    tagName === "template"
      ? new ParsingTemplateElement()
      : new FakeElement(tagName),
  createElementNS: (_namespace: string, tagName: string) =>
    new FakeElement(tagName),
  createTextNode: (text: string) => {
    const node = new FakeElement("span");
    node.textContent = text;
    return node;
  },
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
  return traceRowTexts(items);
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
  it("flushes a resolved native question without waiting for the origin window", function () {
    const message: any = { role: "assistant", text: "", timestamp: 1 };
    const refreshes: string[] = [];
    const queueRefresh = Object.assign(() => refreshes.push("scheduled"), {
      flush: () => refreshes.push("flushed"),
    });
    const trace = createCodexNativeActivityTraceControllerForTests(
      message,
      queueRefresh,
    );
    const action: AgentPendingAction = {
      toolName: "request_user_input",
      title: "Plan needs your input",
      mode: "review",
      confirmLabel: "Continue planning",
      cancelLabel: "Cancel plan",
      fields: [],
    };

    trace.noteMcpConfirmationRequired("question-1", action);
    refreshes.length = 0;
    trace.noteMcpConfirmationResolved("question-1", {
      approved: true,
      actionId: "continue",
      data: {},
    });

    assert.deepEqual(
      refreshes,
      ["scheduled", "flushed"],
      "settlement must synchronously flush the trace instead of relying on a throttled background frame or timer",
    );
  });

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
  it("hides internal round and segment bookkeeping during streaming and history replay", function () {
    const statusTexts = [
      "Running agent",
      "Continuing agent (2/24)",
      "Checkpointed agent segment 1; continuing",
      "Continuing agent (segment 2, 6/32)",
      "Continuing agent (segment 2, 7/32)",
      "Reading the methods section",
    ];
    const events: AgentRunEventRecord[] = statusTexts.map((text, index) => ({
      runId: "segment-progress",
      seq: index + 1,
      eventType: "status",
      payload: { type: "status", text },
      createdAt: index + 1,
    }));
    for (const streaming of [true, false]) {
      const trace = renderAgentTrace({
        doc: fakeDocument,
        message: {
          role: "assistant",
          text: "",
          timestamp: 1,
          runMode: "agent",
          streaming,
        },
        events,
      }) as unknown as FakeElement;
      const visible = collectFakeText(trace);
      for (const internal of statusTexts.slice(0, -1)) {
        assert.notInclude(visible, internal);
      }
      assert.include(visible, "Reading the methods section");
    }
  });

  it("hides internal Claude runtime rebuild statuses across adapter rewordings", function () {
    const statusTexts = [
      "Checking the request against the attached context.",
      "Initializing Claude session",
      "Rebuilding Claude session after runtime change",
      "Session signature mismatch detected. Retrying with a fresh Claude session.",
      // Current adapter wording (cc-llm4zotero-adapter "Reform Claude session
      // continuity").
      "Claude runtime changed. Rebuilding runtime and resuming the existing Claude session.",
      // Legacy adapter wording, kept in case an older bridge is still running.
      "Claude runtime changed. Rebuilding this conversation on the new runtime while keeping local context.",
      // The adapter has reworded this status once already; any future
      // rewording with the same prefix must stay hidden too.
      "Claude runtime changed. Recreating the runtime for this conversation.",
      "Reading the methods section",
    ];
    const events: AgentRunEventRecord[] = statusTexts.map((text, index) => ({
      runId: "claude-runtime-status",
      seq: index + 1,
      eventType: "status",
      payload: { type: "status", text },
      createdAt: index + 1,
    }));
    for (const streaming of [true, false]) {
      const trace = renderAgentTrace({
        doc: fakeDocument,
        message: {
          role: "assistant",
          text: "",
          timestamp: 1,
          runMode: "agent",
          streaming,
        },
        events,
      }) as unknown as FakeElement;
      const visible = collectFakeText(trace);
      for (const internal of statusTexts.slice(0, -1)) {
        assert.notInclude(visible, internal);
      }
      assert.include(visible, "Reading the methods section");
    }
  });

  it("uses the established Plan button shape and centered label for Resume execution", function () {
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: { role: "assistant", text: "", timestamp: 1, runMode: "agent" },
      allowPlanRecovery: true,
      events: [
        {
          runId: "interrupted-plan",
          seq: 1,
          eventType: "plan_execution_updated",
          createdAt: 1,
          payload: {
            type: "plan_execution_updated",
            ledger: {
              executionId: "interrupted-plan",
              status: "interrupted",
              tasks: [],
            } as any,
          },
        },
      ],
    }) as unknown as FakeElement;
    const recovery = trace.findByClass("llm-plan-recovery-card");
    assert.exists(recovery);
    assert.include(
      collectFakeText(recovery),
      "Plan execution was interrupted.",
    );
    assert.equal(
      recovery?.findByClass("llm-plan-action-label-full")?.textContent,
      "Resume execution",
    );
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const rule =
      css.match(
        /\.llm-plan-recovery-card \.llm-plan-action\s*\{[^}]*\}/,
      )?.[0] || "";
    assert.include(rule, "appearance: none");
    assert.include(rule, "align-items: center");
    assert.include(rule, "justify-content: center");
  });

  it("projects authoritative work categories without inferring from tool names", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-category",
        seq: 1,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "category-call",
          name: "paper_read",
          args: {},
          workCategory: "generation",
        },
        createdAt: 1,
      },
    ];
    const projection = buildAgentTraceDisplayItems(events);
    const action = flattenTraceItems(projection.items).find(
      (item) =>
        item.type === "action" && item.detailKey === "tool-call:category-call",
    );
    assert.equal(
      action?.type === "action" ? action.workCategory : undefined,
      "generation",
    );

    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: { role: "assistant", text: "", timestamp: 1, runMode: "agent" },
      events,
    }) as unknown as FakeElement;
    const categorized = trace
      .findAllByClass("llm-agent-process-action")
      .find((entry) => entry.attributes["data-work-category"] === "generation");
    assert.exists(categorized);
  });
  it("preserves authoritative work categories from provider-native tool activity", function () {
    const events: AgentRunEventRecord[] = [
      codexToolActivityEvent(1, {
        type: "codex_tool_activity",
        itemId: "native-category-call",
        phase: "completed",
        toolName: "paper_read",
        ok: true,
        workCategory: "external_system",
      }),
    ];

    const projection = buildAgentTraceDisplayItems(events, null, {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
      modelProviderLabel: "Codex",
    });
    const action = flattenTraceItems(projection.items).find(
      (item) =>
        item.type === "action" &&
        item.detailKey === "codex:native-category-call",
    );
    assert.equal(
      action?.type === "action" ? action.workCategory : undefined,
      "external_system",
    );
  });
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
      /(?:llm-at-(?:row-)?planning|llm-text-shimmer|llm-typing-dot|llm-plan-progress-trigger-dot|llm-plan-task-badge-in_progress|llm-compact-marker-pending)/;
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

  it("reads the question card from the action's interaction, not its tool name", function () {
    const base: AgentPendingAction = {
      toolName: "request_user_input",
      mode: "review",
      title: "Plan needs your input",
      confirmLabel: "Continue",
      cancelLabel: "Cancel",
      fields: [
        {
          type: "choice",
          id: "scope",
          label: "Which corpus?",
          options: [
            { id: "collection", label: "Collection" },
            { id: "library", label: "Library" },
          ],
        },
      ],
    };
    const render = (action: AgentPendingAction) =>
      renderAgentTrace({
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
            runId: "run-interaction",
            seq: 1,
            eventType: "confirmation_required",
            payload: {
              type: "confirmation_required",
              requestId: "interaction-card",
              action,
            },
            createdAt: 1,
          },
        ],
      }) as unknown as FakeElement;

    assert.lengthOf(
      render({ ...base, interaction: "user_input" }).findAllByClass(
        "llm-planning-question-panel",
      ),
      1,
    );
    assert.lengthOf(
      render(base).findAllByClass("llm-planning-question-panel"),
      0,
      "the name alone no longer makes a card a planning question",
    );
  });

  it("replaces planning activity with one question at a time", async function () {
    const action: AgentPendingAction = {
      toolName: "request_user_input",
      interaction: "user_input",
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

  it("keeps planning-question actions on one readable line", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const actionRule =
      css.match(
        /\.llm-planning-question-actions\s+\.llm-agent-hitl-btn\s*\{[\s\S]*?\}/,
      )?.[0] || "";

    assert.include(actionRule, "white-space: nowrap");
    assert.include(actionRule, "flex: 0 0 auto");
  });

  it("keeps resolved planning questions and answers in one expandable trace row", function () {
    const action: AgentPendingAction = {
      toolName: "custom_question_tool",
      interaction: "user_input",
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
          options: [
            { id: "collection", label: "Selected collection" },
            { id: "library", label: "Whole library" },
          ],
        },
        {
          type: "choice",
          id: "focus",
          label: "Which scientific focus matters most?",
          allowCustom: true,
          options: [],
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
          runId: "run-question-history",
          seq: 1,
          eventType: "confirmation_required",
          payload: {
            type: "confirmation_required",
            requestId: "question-history",
            action,
          },
          createdAt: 1,
        },
        {
          runId: "run-question-history",
          seq: 2,
          eventType: "confirmation_resolved",
          payload: {
            type: "confirmation_resolved",
            requestId: "question-history",
            approved: true,
            actionId: "continue",
            data: {
              scope: { kind: "option", optionId: "collection" },
              focus: { kind: "custom", text: "Representational drift" },
            },
          },
          createdAt: 2,
        },
      ],
    }) as unknown as FakeElement;

    assert.isNull(trace.findByClass("llm-planning-question-card"));
    const questionRows = trace
      .findAllByClass("llm-agent-process-action")
      .filter((entry) =>
        collectFakeText(entry).includes("Answered 2 planning questions"),
      );
    assert.lengthOf(questionRows, 1);
    const resolved = questionRows[0];
    assert.isNotNull(resolved);
    const text = collectFakeText(resolved);
    assert.include(text, "Answered 2 planning questions");
    assert.include(text, "Which corpus should the review use?");
    assert.include(text, "Selected collection");
    assert.include(text, "Which scientific focus matters most?");
    assert.include(text, "Representational drift");
  });

  it("accepts a custom planning-question answer in the card", function () {
    const card = renderPendingActionCard(fakeDocument, {
      requestId: "custom-question-card",
      action: {
        toolName: "request_user_input",
        interaction: "user_input",
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

  it("renders trace JSON in a highlighted code card and contains embedded fences", function () {
    const body = renderAgentTraceDetailsBodyForTests(fakeDocument, [
      {
        label: "Arguments",
        kind: "json",
        value: JSON.stringify({ operation: "next_work", ok: true }, null, 2),
      },
      {
        label: "Output",
        kind: "code",
        value: "```\n<img src=x onerror=alert(1)>\n```",
      },
    ]) as unknown as FakeElement;
    const cards = body.findAllByClass("llm-agent-trace-code");
    assert.lengthOf(cards, 2);
    assert.include(cards[0].innerHTML, "llm-codeblock-shell");
    assert.include(cards[0].innerHTML, "hljs-attr");
    assert.include(cards[0].innerHTML, "next_work");
    assert.notInclude(cards[1].innerHTML, "<img");
    assert.include(cards[1].innerHTML, "&lt;img");
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

  it("counts wall-clock elapsed time without trace events and disposes its timer", function () {
    let now = 71_000;
    const originalNow = Date.now;
    Date.now = () => now;
    const callbacks = new Map<number, () => void>();
    let nextTimer = 0;
    const doc = {
      ...fakeDocument,
      defaultView: {
        setInterval: (callback: () => void, delay: number) => {
          assert.equal(delay, 1000);
          callbacks.set(++nextTimer, callback);
          return nextTimer;
        },
        clearInterval: (id: number) => callbacks.delete(id),
      },
    } as unknown as Document;
    const message = {
      role: "assistant" as const,
      text: "",
      timestamp: 71_000,
      waitingAnimationStartedAt: 11_100,
      streaming: true,
      runMode: "agent" as const,
    };
    const events: AgentRunEventRecord[] = [
      {
        runId: "elapsed-clock",
        seq: 1,
        createdAt: 20_000,
        eventType: "status",
        payload: { type: "status", text: "Reading the paper" },
      },
    ];
    let trace: HTMLElement | null = null;
    try {
      trace = renderAgentTrace({ doc, message, events })!;
      const root = trace as unknown as FakeElement;
      const elapsed = root.findByClass("llm-agent-activity-elapsed")!;
      assert.isNotNull(elapsed);
      Object.defineProperty(elapsed, "isConnected", { get: () => true });
      assert.equal(elapsed.textContent, "59s");
      now += 100;
      for (const tick of callbacks.values()) tick();
      assert.equal(elapsed.textContent, "1m 00s");
      now += 2_300; // A delayed/background callback must catch up to real time.
      for (const tick of callbacks.values()) tick();
      assert.equal(elapsed.textContent, "1m 02s");
      now += 600;
      for (const tick of callbacks.values()) tick();
      assert.equal(
        elapsed.textContent,
        "1m 02s",
        "fractional seconds stay hidden",
      );
      renderAgentTrace({ doc, message, events, previous: trace });
      assert.strictEqual(
        root.findByClass("llm-agent-activity-elapsed"),
        elapsed,
      );
      assert.equal(callbacks.size, 1);
      message.streaming = false;
      message.timestamp = now;
      renderAgentTrace({ doc, message, events, previous: trace });
      assert.equal(callbacks.size, 0, "completion stops ticking");
      assert.match(
        root.findByClass("llm-agent-activity-summary")!.textContent,
        /^Worked for /,
      );
      disposeAgentTrace(trace);
      trace = renderAgentTrace({
        doc,
        message: { ...message, streaming: true },
        events,
      })!;
      assert.equal(callbacks.size, 1);
      disposeAgentTrace(trace);
      assert.equal(callbacks.size, 0, "disposing the view clears the timer");
    } finally {
      if (trace) disposeAgentTrace(trace);
      Date.now = originalNow;
    }
  });

  it("shimmers only the active status words and stops on the retained completed header", function () {
    const message = {
      role: "assistant" as const,
      text: "",
      timestamp: 2_000,
      runMode: "agent" as const,
      streaming: true,
    };
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-working-shimmer",
        seq: 1,
        eventType: "status",
        payload: { type: "status", text: "Reading the paper" },
        createdAt: 1_000,
      },
    ];
    const trace = renderAgentTrace({ doc: fakeDocument, message, events })!;
    const rendered = trace as unknown as FakeElement;
    const summary = rendered.findByClass("llm-agent-activity-summary")!;
    assert.equal(
      summary.findByClass("llm-agent-activity-label")?.textContent,
      "Working",
    );
    assert.isTrue(
      summary
        .findByClass("llm-agent-activity-label")!
        .classList.contains("llm-text-shimmer"),
    );
    assert.lengthOf(summary.findAllByClass("llm-at-planning-drive-pixel"), 0);

    message.streaming = false;
    const completed = renderAgentTrace({
      doc: fakeDocument,
      message,
      events,
      previous: trace,
    }) as unknown as FakeElement;
    assert.strictEqual(
      completed.findByClass("llm-agent-activity-summary"),
      summary,
    );
    assert.isFalse(summary.classList.contains("llm-text-shimmer"));
    assert.match(summary.textContent, /^Worked for /);
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    assert.match(css, /\.llm-text-shimmer\s*\{[^}]*llm-planning-text-shimmer/);
    assert.match(
      css,
      /prefers-reduced-motion: reduce[\s\S]*\.llm-text-shimmer/,
    );
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
      workingTrace.findByClass("llm-agent-activity-label")?.textContent,
      "Working",
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
    const planningMessage = { ...baseMessage };
    const planningEvents: AgentRunEventRecord[] = [
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
    ];
    const planning = renderAgentTrace({
      doc: fakeDocument,
      message: planningMessage,
      events: planningEvents,
    }) as unknown as FakeElement;
    const planningLabel = planning.findByClass("llm-agent-activity-label")!;
    assert.equal(planningLabel.textContent, "Planning");
    assert.isTrue(planningLabel.classList.contains("llm-text-shimmer"));
    const planningRow = planning.findByClass("llm-at-row-planning-active");
    assert.isNotNull(planningRow);
    const planningText = planningRow!.children[1];
    assert.equal(
      planningText.textContent,
      "Planning the request and reviewing context",
    );
    assert.isFalse(planningText.classList.contains("llm-text-shimmer"));
    assert.isTrue(
      planningRow?.children[0]?.classList.contains("llm-at-planning-drive"),
    );
    assert.lengthOf(planning.findAllByClass("llm-at-planning-drive-pixel"), 9);

    const streamingRerender = renderAgentTrace({
      doc: fakeDocument,
      message: planningMessage,
      events: planningEvents,
      previous: planning as unknown as HTMLElement,
    }) as unknown as FakeElement;
    const rerenderedPlanningRow = streamingRerender.findByClass(
      "llm-at-row-planning-active",
    )!;
    assert.isFalse(
      rerenderedPlanningRow.children[1].classList.contains("llm-text-shimmer"),
    );
    assert.lengthOf(
      streamingRerender.findAllByClass("llm-at-planning-drive-pixel"),
      9,
    );
    assert.isTrue(
      streamingRerender
        .findByClass("llm-agent-activity-label")!
        .classList.contains("llm-text-shimmer"),
    );

    planningMessage.streaming = false;
    const completedPlanning = renderAgentTrace({
      doc: fakeDocument,
      message: planningMessage,
      events: planningEvents,
      previous: streamingRerender as unknown as HTMLElement,
    }) as unknown as FakeElement;
    const completedSummary = completedPlanning.findByClass(
      "llm-agent-activity-summary",
    )!;
    assert.equal(completedSummary.textContent, "Planned in 1s");
    assert.isFalse(completedSummary.classList.contains("llm-text-shimmer"));

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
      executing.findByClass("llm-agent-activity-label")?.textContent,
      "Executing plan",
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

    withToolPresentations({ update_plan: { hiddenInTrace: true } }, () => {
      const { items } = buildAgentTraceDisplayItems(events, null);
      const visible = flattenTraceItems(items).map((item) =>
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
    const ordered = flattenTraceItems(items);
    const firstAgentIndex = ordered.findIndex(
      (item) =>
        item.type === "message" && item.text.includes("simple-paper-QA"),
    );
    const toolIndex = ordered.findIndex(
      (item) => item.type === "action" && item.detailKey === "codex:tool-1",
    );
    const secondAgentIndex = ordered.findIndex(
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
      workingTrace.findByClass("llm-agent-activity-label")?.textContent,
      "Working",
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
      [
        "codex_progress",
        // The bridge brackets the command with the stage it resolved.
        "agent_stage",
        "codex_tool_activity",
        "codex_progress",
        "final",
      ],
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

  it("classifies structured Codex-native work from protocol event kinds", function () {
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

    controller.appendItemStatus(
      { id: "web-1", type: "web_search", query: "evidence" },
      "started",
    );
    controller.appendItemStatus(
      { id: "command-1", type: "command_execution", command: "pwd" },
      "started",
    );

    const activities = (message.pendingAgentTraceEvents || [])
      .map((entry) => entry.payload)
      .filter(
        (
          payload,
        ): payload is Extract<AgentEvent, { type: "codex_tool_activity" }> =>
          payload.type === "codex_tool_activity",
      );
    assert.deepEqual(
      activities.map((activity) => activity.workCategory),
      ["retrieval", "external_system"],
    );
  });

  it("brackets native structured work with the stage the bridge resolved", function () {
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

    controller.appendItemStatus(
      { id: "command-1", type: "command_execution", command: "pwd" },
      "started",
    );
    assert.deepEqual(
      (message.pendingAgentTraceEvents || []).map((entry) => entry.eventType),
      ["agent_stage", "codex_tool_activity"],
      "the stage opens immediately before the row it describes",
    );

    controller.appendItemStatus(
      {
        id: "command-1",
        type: "command_execution",
        command: "pwd",
        exitCode: 0,
      },
      "completed",
    );
    const events = message.pendingAgentTraceEvents || [];
    assert.deepEqual(
      events.map((entry) => entry.eventType),
      ["agent_stage", "codex_tool_activity"],
      "the completed phase updates the pair in place, as the row always did",
    );
    const stage = events[0].payload;
    assert.equal(stage.type, "agent_stage");
    assert.deepEqual(stage, {
      type: "agent_stage",
      stage: "external_system",
      status: "completed",
      toolName: "command",
      toolLabel: "Command",
    });
  });

  it("brackets a native Zotero MCP call with the stage its category declares", function () {
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

    controller.noteMcpToolActivity({
      requestId: "jsonrpc:7",
      phase: "started",
      toolName: "library_search",
      toolLabel: "Search library",
      serverName: "llm_for_zotero",
      workCategory: "retrieval",
    });
    controller.noteMcpToolActivity({
      requestId: "jsonrpc:7",
      phase: "completed",
      toolName: "library_search",
      toolLabel: "Search library",
      serverName: "llm_for_zotero",
      workCategory: "retrieval",
      ok: true,
    });

    const events = message.pendingAgentTraceEvents || [];
    assert.deepEqual(
      events.map((entry) => entry.eventType),
      ["agent_stage", "codex_tool_activity"],
    );
    assert.deepEqual(events[0].payload, {
      type: "agent_stage",
      stage: "retrieval",
      status: "completed",
      toolName: "library_search",
      toolLabel: "Search library",
    });
  });

  it("merges a native MCP call with its item row by the key the bridge paired", function () {
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

    // The Zotero MCP server reports the call under its own request id, with
    // the key the client paired it to.
    controller.noteMcpToolActivity({
      requestId: "jsonrpc:11",
      correlationId: "codex-call:1",
      phase: "started",
      toolName: "query_library",
      toolLabel: "Search library",
      serverName: "llm_for_zotero",
      workCategory: "retrieval",
    });
    controller.noteMcpToolActivity({
      requestId: "jsonrpc:11",
      correlationId: "codex-call:1",
      phase: "completed",
      toolName: "query_library",
      toolLabel: "Search library",
      serverName: "llm_for_zotero",
      workCategory: "retrieval",
      ok: true,
    });
    // The app server then announces the same call as an item of its own,
    // named by the model's call id and carrying different arguments.
    controller.appendItemStatus(
      {
        id: "call_A",
        correlationId: "codex-call:1",
        type: "mcp_tool_call",
        toolName: "query_library",
        serverName: "llm_for_zotero_profile_abc",
        arguments: { entity: "items", libraryID: 1 },
      },
      "completed",
    );

    const events = message.pendingAgentTraceEvents || [];
    const activities = events.filter(
      (entry) => entry.eventType === "codex_tool_activity",
    );
    assert.lengthOf(activities, 1, "one call is one row");
    const activity = activities[0].payload;
    assert.equal(activity.type, "codex_tool_activity");
    if (activity.type !== "codex_tool_activity") return;
    assert.equal(activity.itemId, "codex-call:1");
    assert.equal(activity.workCategory, "retrieval");
    assert.deepEqual(
      events.map((entry) => entry.eventType),
      ["agent_stage", "codex_tool_activity"],
      "the stage the MCP row opened still brackets the merged row",
    );
  });

  it("brackets a row that only gets its category from the later of two reports", function () {
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

    // The item arrives first and states no category; the Zotero MCP report
    // for the same visible work states one. The row must still be bracketed.
    controller.appendItemStatus(
      {
        id: "call_A",
        type: "mcp_tool_call",
        toolName: "query_library",
        serverName: "llm_for_zotero_profile_abc",
      },
      "completed",
    );
    controller.noteMcpToolActivity({
      requestId: "jsonrpc:11",
      phase: "completed",
      toolName: "query_library",
      serverName: "llm_for_zotero",
      workCategory: "retrieval",
      ok: true,
    });

    const events = message.pendingAgentTraceEvents || [];
    assert.deepEqual(
      events.map((entry) => entry.eventType),
      ["agent_stage", "codex_tool_activity"],
    );
    assert.deepEqual(events[0].payload, {
      type: "agent_stage",
      stage: "retrieval",
      status: "completed",
      toolName: "query_library",
    });
  });

  it("keeps two concurrent calls of one tool as two rows", function () {
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

    // Both calls are open at once, so the bridge paired neither: each row
    // keeps its own key rather than one row carrying A's arguments with B's
    // receipts.
    for (const call of ["a", "b"] as const) {
      controller.noteMcpToolActivity({
        requestId: `jsonrpc:${call}`,
        phase: "completed",
        toolName: "query_library",
        toolLabel: "Search library",
        serverName: "llm_for_zotero",
        workCategory: "retrieval",
        arguments: { text: call },
        actionReceipts: [
          {
            id: `receipt-${call}`,
            operation: "note_create",
            status: "applied",
            verification: "verified",
          } as never,
        ],
        ok: true,
      });
    }
    controller.appendItemStatus(
      {
        id: "call_A",
        type: "mcp_tool_call",
        toolName: "query_library",
        serverName: "llm_for_zotero_profile_abc",
        arguments: { text: "a" },
      },
      "completed",
    );
    controller.appendItemStatus(
      {
        id: "call_B",
        type: "mcp_tool_call",
        toolName: "query_library",
        serverName: "llm_for_zotero_profile_abc",
        arguments: { text: "b" },
      },
      "completed",
    );

    const activities = (message.pendingAgentTraceEvents || [])
      .map((entry) => entry.payload)
      .filter(
        (
          payload,
        ): payload is Extract<AgentEvent, { type: "codex_tool_activity" }> =>
          payload.type === "codex_tool_activity",
      );
    for (const activity of activities) {
      const args = activity.args as { text?: string } | undefined;
      const receiptIds = (activity.actionReceipts || []).map(
        (receipt) => receipt.id,
      );
      if (!receiptIds.length) continue;
      assert.deepEqual(
        receiptIds,
        [`receipt-${args?.text}`],
        "no row may carry one call's arguments with another call's receipts",
      );
    }
    assert.lengthOf(
      activities.filter((activity) => activity.actionReceipts?.length),
      2,
      "both calls' receipts survive on their own rows",
    );
  });

  it("stops adopting a nameless row just because it went past recently", function () {
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

    // A tool item the protocol named nothing in: the deleted heuristic let
    // any named MCP activity within eight seconds claim it as the same work.
    controller.appendItemStatus({ id: "item-1", type: "tool_call" }, "started");
    controller.noteMcpToolActivity({
      requestId: "jsonrpc:11",
      phase: "started",
      toolName: "query_library",
      toolLabel: "Search library",
      serverName: "llm_for_zotero",
      workCategory: "retrieval",
    });

    const activities = (message.pendingAgentTraceEvents || []).filter(
      (entry) => entry.eventType === "codex_tool_activity",
    );
    assert.lengthOf(
      activities,
      2,
      "two rows nothing paired stay two, rather than merging on recency",
    );
  });

  it("reports a skill activation as planning work, not as a tool named Skill", function () {
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

    controller.noteSkillActivated("graphwalk");
    controller.noteSkillActivated("evidence-based-qa", {
      source: "codex-native-slash",
    });

    const events = message.pendingAgentTraceEvents || [];
    assert.deepEqual(
      events.map((entry) => entry.eventType),
      [
        "agent_stage",
        "codex_tool_activity",
        "agent_stage",
        "codex_tool_activity",
      ],
      "a skill activation is a stage and its row, never a synthetic tool call",
    );
    assert.deepEqual(events[0].payload, {
      type: "agent_stage",
      stage: "planning",
      status: "completed",
      toolLabel: "Skill",
    });
    const activity = events[1].payload;
    assert.equal(activity.type, "codex_tool_activity");
    if (activity.type !== "codex_tool_activity") return;
    assert.equal(activity.toolLabel, "Skill");
    assert.isUndefined(activity.toolName);
    assert.deepEqual(activity.args, { skill: "graphwalk" });
    assert.equal(activity.workCategory, "planning");

    const explicit = events[3].payload;
    assert.equal(explicit.type, "codex_tool_activity");
    if (explicit.type !== "codex_tool_activity") return;
    assert.deepEqual(explicit.args, {
      skill: "evidence-based-qa",
      source: "codex-native-slash",
    });
  });

  it("names an activated skill from a relayed activity's own fields", function () {
    const activity = (args: Record<string, unknown>): AgentRunEventRecord => ({
      runId: "run-skill",
      seq: 1,
      eventType: "codex_tool_activity",
      payload: {
        type: "codex_tool_activity",
        itemId: `skill:${String(args.skill)}`,
        phase: "completed",
        toolLabel: "Skill",
        args,
        workCategory: "planning",
      },
      createdAt: 1,
    });

    assert.include(
      traceRowTexts(
        buildAgentTraceDisplayItems([activity({ skill: "graphwalk" })], null)
          .items,
      ),
      "Using Skill: graphwalk",
    );
    assert.include(
      traceRowTexts(
        buildAgentTraceDisplayItems(
          [
            activity({
              skill: "evidence-based-qa",
              source: "codex-native-slash",
            }),
          ],
          null,
        ).items,
      ),
      "Invoked Skill: evidence-based-qa",
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

  it("renders a trace whose event log announces finalized material", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-1",
        seq: 1,
        eventType: "reasoning",
        payload: {
          type: "reasoning",
          round: 1,
          details: "Drafting the guide.",
        },
        createdAt: 1,
      },
      {
        runId: "run-1",
        seq: 2,
        eventType: "material_finalized",
        payload: {
          type: "material_finalized",
          callId: "submit-1",
          materialRef: {
            documentId: "run-1:document:1",
            documentVersion: 1,
            contentHash: "sha256:material",
          },
          materialKind: "guide",
          materialTitle: "Representational drift",
        },
        createdAt: 2,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    assert.isTrue(
      items.some((item) => item.type === "reasoning"),
      "surrounding rows must still render beside a material event",
    );
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: { role: "assistant", text: "", timestamp: 1, runMode: "agent" },
      events,
    }) as unknown as FakeElement;
    assert.isNotEmpty(
      trace.findAllByClass("llm-plan-document-completion-caption"),
      "the announced material is the document the trace offers to open",
    );
  });

  it("names the finalized material in a journey row", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-journey",
        seq: 1,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "submit-1",
          name: "submit_document",
          args: { title: "Representational drift" },
        },
        createdAt: 1,
      },
      {
        runId: "run-journey",
        seq: 2,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "submit-1",
          name: "submit_document",
          ok: true,
          actionReceipts: [],
          content: { documentId: "run-journey:document:1" },
        },
        createdAt: 2,
      },
      {
        runId: "run-journey",
        seq: 3,
        eventType: "material_finalized",
        payload: {
          type: "material_finalized",
          callId: "submit-1",
          materialRef: {
            documentId: "run-journey:document:1",
            documentVersion: 1,
            contentHash: "sha256:material",
          },
          materialKind: "summary",
          materialTitle: "Representational drift",
        },
        createdAt: 3,
      },
    ];

    withToolPresentations({ submit_document: { hiddenInTrace: true } }, () => {
      const actionTexts = traceRowTexts(
        buildAgentTraceDisplayItems(events, null).items,
      );

      assert.include(actionTexts, "Generated summary: Representational drift");
      assert.notMatch(
        actionTexts.join("\n"),
        /submit document|using submit/i,
        "the finalizing tool call and result stay suppressed",
      );
    });
  });

  it("falls back to a document label when the material names no kind", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-journey",
        seq: 1,
        eventType: "material_finalized",
        payload: {
          type: "material_finalized",
          materialRef: {
            documentId: "run-journey:document:1",
            documentVersion: 1,
            contentHash: "sha256:material",
          },
          materialTitle: "Untitled draft",
        },
        createdAt: 1,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const actionTexts = traceRowTexts(items);

    assert.include(actionTexts, "Generated document: Untitled draft");
  });

  /** One `batch_item_outcome` event, as the runtime persists it. */
  function batchItemEvent(
    seq: number,
    payload: {
      itemKey: string;
      status: "pending" | "saved" | "failed";
      written?: boolean;
      noteId?: number;
      error?: string;
    },
  ): AgentRunEventRecord {
    return {
      runId: "run-batch",
      seq,
      eventType: "batch_item_outcome",
      payload: {
        type: "batch_item_outcome",
        batchId: "batch-note_write_batch-1",
        itemKey: payload.itemKey,
        materialRef: {
          documentId: `run-batch:document:${seq}`,
          documentVersion: 1,
          contentHash: `sha256:note-${seq}`,
        },
        status: payload.status,
        noteId: payload.noteId,
        error: payload.error,
        callId: "note-batch-1",
      } as AgentRunEventRecord["payload"],
      createdAt: seq,
    };
  }

  /** Adds `written` the way the runtime does; older events simply lack it. */
  function withWritten(
    entry: AgentRunEventRecord,
    written: boolean,
  ): AgentRunEventRecord {
    return {
      ...entry,
      payload: { ...entry.payload, written } as AgentRunEventRecord["payload"],
    };
  }

  function traceActionTexts(events: AgentRunEventRecord[]): string[] {
    return traceRowTexts(buildAgentTraceDisplayItems(events, null).items);
  }

  it("names every item a note batch reported", function () {
    const events = [
      withWritten(
        batchItemEvent(1, { itemKey: "item:1", status: "saved", noteId: 501 }),
        true,
      ),
      withWritten(
        batchItemEvent(2, {
          itemKey: "item:2",
          status: "failed",
          error: "Zotero refused the note write",
        }),
        false,
      ),
      withWritten(
        batchItemEvent(3, { itemKey: "item:3", status: "saved", noteId: 503 }),
        true,
      ),
    ];

    const actionTexts = traceActionTexts(events);

    assert.deepEqual(actionTexts.slice(-3), [
      "Saved note for item 1",
      "Note write failed for item 2",
      "Saved note for item 3",
    ]);
  });

  it("separates a note this call wrote from one it found already saved", function () {
    // What a resumed batch announces: every row it holds, only one of which
    // this call actually wrote.
    const events = [
      withWritten(
        batchItemEvent(1, { itemKey: "item:1", status: "saved", noteId: 501 }),
        false,
      ),
      withWritten(
        batchItemEvent(2, { itemKey: "item:2", status: "saved", noteId: 502 }),
        true,
      ),
      withWritten(
        batchItemEvent(3, { itemKey: "item:3", status: "pending" }),
        false,
      ),
    ];

    const actionTexts = traceActionTexts(events);

    assert.deepEqual(actionTexts.slice(-3), [
      "Already saved: item 1",
      "Saved note for item 2",
      "Note not written yet for item 3",
    ]);
  });

  it("does not claim a note was just written when the event predates the field", function () {
    // Events persisted before the batch reported `written` say only that the
    // row is saved. Reading a missing field as false would relabel every note
    // of an old run as one the call skipped, and reading it as true would
    // claim a write that may have happened turns earlier.
    const events = [
      batchItemEvent(1, { itemKey: "item:1", status: "saved", noteId: 501 }),
      batchItemEvent(2, { itemKey: "item:2#2", status: "saved", noteId: 502 }),
    ];

    const actionTexts = traceActionTexts(events);

    assert.deepEqual(actionTexts.slice(-2), [
      "Note recorded for item 1",
      "Note recorded for item 2 (note 2)",
    ]);
  });

  it("names a batch item the row key does not describe", function () {
    const events = [
      withWritten(
        batchItemEvent(1, { itemKey: "standalone-7", status: "saved" }),
        true,
      ),
    ];

    assert.deepEqual(traceActionTexts(events).slice(-1), [
      "Saved note for standalone-7",
    ]);
  });

  it("renders the batch item rows into the trace", function () {
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: { role: "assistant", text: "", timestamp: 1, runMode: "agent" },
      events: [
        withWritten(
          batchItemEvent(1, {
            itemKey: "item:1",
            status: "saved",
            noteId: 501,
          }),
          true,
        ),
        withWritten(
          batchItemEvent(2, {
            itemKey: "item:2",
            status: "failed",
            error: "Zotero refused the note write",
          }),
          false,
        ),
      ],
    }) as unknown as FakeElement;

    const text = collectFakeText(trace);
    assert.include(text, "Saved note for item 1");
    assert.include(text, "Note write failed for item 2");
  });

  it("asks for permission to save the named material as a note", function () {
    const action: AgentPendingAction = {
      toolName: "edit_current_note",
      mode: "review",
      title: "Review new note",
      confirmLabel: "Create note",
      cancelLabel: "Cancel",
      fields: [],
      material: {
        operation: "note_create",
        ref: {
          documentId: "run-journey:document:1",
          documentVersion: 1,
          contentHash: "sha256:material",
        },
      },
    };
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-journey",
        seq: 1,
        eventType: "material_finalized",
        payload: {
          type: "material_finalized",
          materialRef: {
            documentId: "run-journey:document:1",
            documentVersion: 1,
            contentHash: "sha256:material",
          },
          materialKind: "summary",
          materialTitle: "Representational drift",
        },
        createdAt: 1,
      },
      {
        runId: "run-journey",
        seq: 2,
        eventType: "confirmation_required",
        payload: {
          type: "confirmation_required",
          requestId: "confirm-1",
          action,
        },
        createdAt: 2,
      },
      {
        runId: "run-journey",
        seq: 3,
        eventType: "confirmation_resolved",
        payload: {
          type: "confirmation_resolved",
          requestId: "confirm-1",
          approved: true,
        },
        createdAt: 3,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const actionTexts = traceRowTexts(items);

    assert.include(
      actionTexts,
      "Waiting for permission to save Representational drift as a note",
    );
    assert.include(
      actionTexts,
      'Review received - selected "Create note" for Edit Current Note',
      "the resolved row keeps its current text",
    );
  });

  it("names the material by document id when no announcement precedes the request", function () {
    const action: AgentPendingAction = {
      toolName: "edit_current_note",
      mode: "review",
      title: "Review new note",
      confirmLabel: "Create note",
      cancelLabel: "Cancel",
      fields: [],
      material: {
        operation: "note_create",
        ref: {
          documentId: "run-earlier:document:1",
          documentVersion: 1,
          contentHash: "sha256:material",
        },
      },
    };
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-save",
        seq: 1,
        eventType: "confirmation_required",
        payload: {
          type: "confirmation_required",
          requestId: "confirm-1",
          action,
        },
        createdAt: 1,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const actionTexts = traceRowTexts(items);

    assert.include(
      actionTexts,
      "Waiting for permission to save run-earlier:document:1 as a note",
    );
  });

  it("reports a verified note write as saved with its Zotero evidence", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-save",
        seq: 1,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "note-1",
          name: "note_write",
          ok: true,
          actionReceipts: [
            {
              version: 2,
              id: "note_create:new:unmatched:result",
              proposalId: "note_create:new",
              proofDomain: "zotero_state",
              capability: "zotero.notes",
              operation: "note_create",
              verification: "verified",
              status: "applied",
              requestedTargets: ["item:41"],
              appliedTargets: ["item:41"],
              alreadySatisfiedTargets: [],
              rejectedTargets: [],
              reasons: [],
              verifiedFacts: [
                "created_note:item:77",
                "native_note:77:html_sha256:abc123",
              ],
              materialRef: {
                documentId: "run-earlier:document:1",
                documentVersion: 1,
                contentHash: "sha256:material",
              },
            },
          ],
          content: { noteId: 77, documentId: "run-earlier:document:1" },
        },
        createdAt: 1,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const actionTexts = traceRowTexts(items);

    assert.include(actionTexts, "Saved note");
    assert.include(actionTexts, "Zotero state verified");
    assert.isAbove(
      actionTexts.indexOf("Zotero state verified"),
      actionTexts.indexOf("Saved note"),
      "the evidence row follows the row it qualifies",
    );
  });

  it("marks the weaker text-match evidence differently", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-save",
        seq: 1,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "note-1",
          name: "note_write",
          ok: true,
          actionReceipts: [
            {
              version: 2,
              id: "note_create:new:unmatched:result",
              proposalId: "note_create:new",
              proofDomain: "zotero_state",
              capability: "zotero.notes",
              operation: "note_create",
              verification: "verified",
              status: "applied",
              requestedTargets: ["item:41"],
              appliedTargets: ["item:41"],
              alreadySatisfiedTargets: [],
              rejectedTargets: [],
              reasons: [],
              verifiedFacts: ["native_note:77:text_match"],
              materialRef: {
                documentId: "run-earlier:document:1",
                documentVersion: 1,
                contentHash: "sha256:material",
              },
            },
          ],
          content: { noteId: 77, documentId: "run-earlier:document:1" },
        },
        createdAt: 1,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const actionTexts = traceRowTexts(items);

    assert.include(actionTexts, "Saved note");
    assert.include(actionTexts, "Zotero state checked (text match)");
    assert.notInclude(actionTexts, "Zotero state verified");
  });

  it("reports a failed note write without claiming Zotero evidence", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-save",
        seq: 1,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "note-1",
          name: "note_write",
          ok: false,
          actionReceipts: [
            {
              version: 2,
              id: "note_create:new:unmatched:result",
              proposalId: "note_create:new",
              proofDomain: "zotero_state",
              capability: "zotero.notes",
              operation: "note_create",
              verification: "unverified",
              status: "failed",
              requestedTargets: ["item:41"],
              appliedTargets: [],
              alreadySatisfiedTargets: [],
              rejectedTargets: [],
              reasons: ["Zotero refused the note save"],
              verifiedFacts: [],
              materialRef: {
                documentId: "run-earlier:document:1",
                documentVersion: 1,
                contentHash: "sha256:material",
              },
            },
          ],
          content: { error: "Zotero refused the note save" },
        },
        createdAt: 1,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const actionTexts = traceRowTexts(items);

    assert.include(actionTexts, "Note write failed");
    assert.notInclude(actionTexts, "Zotero state verified");
    assert.notInclude(actionTexts, "Zotero state checked (text match)");
  });

  it("keeps a cancelled note write reading as a cancellation", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-save",
        seq: 1,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "note-1",
          name: "note_write",
          ok: false,
          actionReceipts: [
            {
              version: 2,
              id: "note_create:new:unmatched:result",
              proposalId: "note_create:new",
              proofDomain: "zotero_state",
              capability: "zotero.notes",
              operation: "note_create",
              verification: "not_applicable",
              status: "cancelled",
              requestedTargets: ["item:41"],
              appliedTargets: [],
              alreadySatisfiedTargets: [],
              rejectedTargets: [],
              reasons: ["User denied action"],
              verifiedFacts: [],
              materialRef: {
                documentId: "run-earlier:document:1",
                documentVersion: 1,
                contentHash: "sha256:material",
              },
            },
          ],
          content: { error: "User denied action" },
        },
        createdAt: 1,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const actionTexts = traceRowTexts(items);

    assert.notInclude(actionTexts, "Note write failed");
  });

  type TraceReceipt = import("../src/agent/contracts/types").AgentActionReceipt;

  function verificationReceipt(
    overrides: Partial<TraceReceipt> = {},
  ): TraceReceipt {
    return {
      version: 2,
      id: "apply_tags:unmatched:result",
      proposalId: "apply_tags:proposal",
      proofDomain: "zotero_state",
      capability: "zotero.tags",
      operation: "apply_tags",
      verification: "verified",
      status: "applied",
      requestedTargets: ["item:41"],
      appliedTargets: ["item:41"],
      alreadySatisfiedTargets: [],
      rejectedTargets: [],
      reasons: [],
      verifiedFacts: [],
      ...overrides,
    } as TraceReceipt;
  }

  /**
   * One tool result carrying receipts.
   *
   * The content is deliberately an empty result set: tool presentation
   * summaries are unavailable outside Zotero, and an empty result is what
   * still produces a row here, which is what the chip attaches to.
   */
  function receiptResultEvents(
    receipts: TraceReceipt[],
    name = "apply_tags",
  ): AgentRunEventRecord[] {
    return [
      {
        runId: "run-verification",
        seq: 1,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "call-1",
          name,
          ok: true,
          actionReceipts: receipts,
          content: { results: [] },
        },
        createdAt: 1,
      },
    ] as unknown as AgentRunEventRecord[];
  }

  function traceChipLabels(events: AgentRunEventRecord[]): string[] {
    const { items } = buildAgentTraceDisplayItems(events, null);
    return traceChipLabelsOf(items);
  }

  it("names what a result's receipts proved, one chip per result", function () {
    assert.deepEqual(
      traceChipLabels(receiptResultEvents([verificationReceipt()])),
      ["Verified"],
    );
    assert.deepEqual(
      traceChipLabels(
        receiptResultEvents([
          verificationReceipt({ verification: "execution_only" }),
        ]),
      ),
      ["Ran (no state proof)"],
    );
    assert.deepEqual(
      traceChipLabels(
        receiptResultEvents([
          verificationReceipt({ verification: "unverified" }),
        ]),
      ),
      ["Unverified"],
    );
  });

  it("leaves an action that claimed nothing unchipped", function () {
    assert.deepEqual(
      traceChipLabels(
        receiptResultEvents([
          verificationReceipt({
            verification: "not_applicable",
            status: "cancelled",
            appliedTargets: [],
          }),
        ]),
      ),
      [],
    );
  });

  it("shows the weakest proof when one result carries several receipts", function () {
    assert.deepEqual(
      traceChipLabels(
        receiptResultEvents([
          verificationReceipt(),
          verificationReceipt({ id: "second", verification: "execution_only" }),
        ]),
      ),
      ["Ran (no state proof)"],
    );
    assert.deepEqual(
      traceChipLabels(
        receiptResultEvents([
          verificationReceipt({ verification: "execution_only" }),
          verificationReceipt({ id: "second", verification: "unverified" }),
        ]),
      ),
      ["Unverified"],
    );
    // A cancelled receipt claims nothing, so it never hides a real proof.
    assert.deepEqual(
      traceChipLabels(
        receiptResultEvents([
          verificationReceipt({
            verification: "not_applicable",
            status: "cancelled",
          }),
          verificationReceipt({ id: "second" }),
        ]),
      ),
      ["Verified"],
    );
  });

  it("says when the effect ran under a connected client's authorization", function () {
    assert.deepEqual(
      traceChipLabels(
        receiptResultEvents([
          verificationReceipt({
            verification: "execution_only",
            executionAuthority: "external_runtime",
          }),
        ]),
      ),
      ["Ran (no state proof)", "Authorized by connected client"],
    );
  });

  it("claims nothing for a receipt journaled before verification existed", function () {
    const legacy = verificationReceipt();
    delete (legacy as { verification?: unknown }).verification;
    assert.deepEqual(traceChipLabels(receiptResultEvents([legacy])), []);
  });

  it("reads the chip from the receipts and never from the tool name", function () {
    assert.deepEqual(
      traceChipLabels(
        receiptResultEvents(
          [verificationReceipt({ verification: "unverified" })],
          "some_unregistered_tool",
        ),
      ),
      ["Unverified"],
    );
  });

  it("lets the Zotero evidence row speak for a verified note write", function () {
    const events = [
      {
        runId: "run-save",
        seq: 1,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "note-1",
          name: "note_write",
          ok: true,
          actionReceipts: [
            verificationReceipt({
              capability: "zotero.notes",
              operation: "note_create",
              verifiedFacts: ["native_note:77:html_sha256:abc123"],
              materialRef: {
                documentId: "run-earlier:document:1",
                documentVersion: 1,
                contentHash: "sha256:material",
              },
            }),
          ],
          content: { noteId: 77, documentId: "run-earlier:document:1" },
        },
        createdAt: 1,
      },
    ] as unknown as AgentRunEventRecord[];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const actions = traceActionItems(items);
    assert.include(
      actions.map((item) => item.row.text),
      "Zotero state verified",
    );
    assert.deepEqual(
      actions.flatMap((item) => (item.chips || []).map((chip) => chip.label)),
      [],
      "the evidence row already says the state was verified",
    );
  });

  it("still names a weaker proof beside the Zotero evidence row", function () {
    const events = [
      {
        runId: "run-save",
        seq: 1,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "note-1",
          name: "note_write",
          ok: true,
          actionReceipts: [
            verificationReceipt({
              capability: "zotero.notes",
              operation: "note_create",
              verifiedFacts: ["native_note:77:html_sha256:abc123"],
              materialRef: {
                documentId: "run-earlier:document:1",
                documentVersion: 1,
                contentHash: "sha256:material",
              },
            }),
            verificationReceipt({
              id: "attachment",
              capability: "zotero.items",
              operation: "attachment_link",
              verification: "unverified",
            }),
          ],
          content: { noteId: 77, documentId: "run-earlier:document:1" },
        },
        createdAt: 1,
      },
    ] as unknown as AgentRunEventRecord[];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const actions = traceActionItems(items);
    assert.include(
      actions.map((item) => item.row.text),
      "Zotero state verified",
    );
    // The write's own row heads its stage, so its weaker proof is named there.
    assert.deepEqual(
      flattenTraceItems(items).flatMap((item) =>
        item.type === "stage"
          ? (item.chips || []).map((chip) => chip.label)
          : [],
      ),
      ["Unverified"],
    );
  });

  it("names the proof of a write a connected client ran over MCP", function () {
    const events = [
      {
        runId: "run-mcp",
        seq: 1,
        eventType: "codex_tool_activity",
        payload: {
          type: "codex_tool_activity",
          itemId: "mcp-1",
          phase: "completed",
          toolName: "note_write",
          ok: true,
          args: {},
          actionReceipts: [
            verificationReceipt({
              capability: "zotero.notes",
              operation: "note_create",
              executionAuthority: "external_runtime",
            }),
          ],
        },
        createdAt: 1,
      },
    ] as unknown as AgentRunEventRecord[];

    assert.deepEqual(traceChipLabels(events), [
      "Verified",
      "Authorized by connected client",
    ]);
  });

  it("carries a Claude-driven MCP write's receipts to its trace row", function () {
    // The Claude bridge builds this row itself instead of reusing the Codex
    // builder, so the receipts have to be forwarded explicitly or a write the
    // connected client ran over MCP reaches the trace with no verdict at all.
    const event = buildClaudeMcpToolActivityEvent({
      requestId: "mcp-claude-1",
      phase: "completed",
      toolName: "note_write",
      serverName: "llm_for_zotero_profile_test",
      ok: true,
      timestamp: 1,
      actionReceipts: [
        verificationReceipt({
          capability: "zotero.notes",
          operation: "note_create",
          executionAuthority: "external_runtime",
        }),
      ],
    });
    assert.deepEqual(
      traceChipLabels([
        {
          runId: "run-claude-mcp",
          seq: 1,
          eventType: "codex_tool_activity",
          payload: event,
          createdAt: 1,
        },
      ] as unknown as AgentRunEventRecord[]),
      ["Verified", "Authorized by connected client"],
    );
  });

  it("names the server and the mutability of a Claude-driven MCP call", function () {
    // The trace must not re-derive which server ran a call from its tool name:
    // the bridge is the only place that knows, so it stamps both facts.
    const event = buildClaudeMcpToolActivityEvent({
      requestId: "mcp-claude-2",
      phase: "completed",
      toolName: "note_write",
      toolLabel: "Write note",
      serverName: "llm_for_zotero",
      mutability: "write",
      ok: true,
      timestamp: 1,
    });
    assert.equal(event.type, "codex_tool_activity");
    if (event.type !== "codex_tool_activity") return;
    assert.equal(event.serverName, "llm_for_zotero");
    assert.equal(event.mutability, "write");
    assert.equal(event.toolLabel, "Write note");
  });

  it("keeps two connected-client effects apart instead of collapsing them into one row", function () {
    // Every effect row carries the same constant tool name and one of four
    // fixed sentences, so without a distinct identity per effect the visible
    // dedupe key is identical and two approvals seconds apart merge into one
    // row — with one of the two receipts silently dropped.
    const events = [
      buildCodexNativeEffectActivityEvent({
        effect: externalRuntimeCommandEffect("codex_native", "npm test"),
        outcome: "executed",
        callId: "cmd-1",
        receipt: verificationReceipt({
          id: "receipt-npm-test",
          verification: "execution_only",
          status: "observed",
          executionAuthority: "external_runtime",
        }),
      }),
      buildCodexNativeEffectActivityEvent({
        effect: externalRuntimeCommandEffect("codex_native", "git status"),
        outcome: "executed",
        callId: "cmd-2",
        receipt: verificationReceipt({
          id: "receipt-git-status",
          verification: "execution_only",
          status: "observed",
          executionAuthority: "external_runtime",
        }),
      }),
    ].map((payload, index) => ({
      runId: "run-two-effects",
      seq: index + 1,
      eventType: "codex_tool_activity",
      payload,
      createdAt: 1_000 + index * 3_000,
    })) as unknown as AgentRunEventRecord[];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const effectRows = traceActionItems(items).filter(
      (item) => item.row.kind === "tool",
    );
    assert.lengthOf(
      effectRows,
      2,
      `two approved commands are two effects: ${JSON.stringify(effectRows.map((item) => item.row))}`,
    );
    // Each effect keeps its own row; their shared verdict is reported once, on
    // the stage heading that covers both.
    assert.deepEqual(traceChipLabelsOf(items), [
      "Ran (no state proof)",
      "Authorized by connected client",
    ]);
  });

  it("keeps every receipt when two activity rows do merge", function () {
    const merged = mergeToolActivityPayload(
      {
        type: "codex_tool_activity",
        itemId: "codex-effect:cmd-1",
        phase: "completed",
        actionReceipts: [verificationReceipt({ id: "first" })],
      } as never,
      {
        type: "codex_tool_activity",
        itemId: "codex-effect:cmd-1",
        phase: "completed",
        actionReceipts: [
          verificationReceipt({ id: "second", verification: "unverified" }),
          // The same receipt arriving twice — a started/completed pair for one
          // call — must not be counted twice.
          verificationReceipt({ id: "first" }),
        ],
      } as never,
    );
    assert.deepEqual(
      (merged.actionReceipts || []).map((receipt) => receipt.id),
      ["first", "second"],
    );
  });

  it("keeps both proofs when the same command is approved twice in a row", function () {
    // Two identical approvals are genuinely one visible activity, so the rows
    // merge — but they are two effects, and the surviving chip must speak for
    // the weaker of the two rather than for whichever arrived last.
    const events = [
      { id: "receipt-first", verification: "execution_only" as const },
      { id: "receipt-second", verification: "unverified" as const },
    ].map((receipt, index) => ({
      runId: "run-same-command",
      seq: index + 1,
      eventType: "codex_tool_activity",
      payload: buildCodexNativeEffectActivityEvent({
        effect: externalRuntimeCommandEffect("codex_native", "npm test"),
        outcome: "executed",
        callId: `cmd-${index}`,
        receipt: verificationReceipt({
          ...receipt,
          status: "observed",
          executionAuthority: "external_runtime",
        }),
      }),
      createdAt: 1_000 + index * 3_000,
    })) as unknown as AgentRunEventRecord[];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const effectRows = traceActionItems(items).filter(
      (item) => item.row.kind === "tool",
    );
    assert.lengthOf(effectRows, 1);
    assert.deepEqual(traceChipLabelsOf(items), [
      "Unverified",
      "Authorized by connected client",
    ]);
  });

  it("renders a verification chip as text, not markup", function () {
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: {
        role: "assistant",
        text: "Done.",
        timestamp: 2,
        runMode: "agent",
      },
      events: receiptResultEvents([
        verificationReceipt({ verification: "unverified" }),
      ]),
    }) as unknown as FakeElement;

    const chipLabels = trace
      .findAllByClass("llm-agent-process-chip-label")
      .map(collectFakeText);
    assert.include(chipLabels, "Unverified");
  });

  it("closes a run that generated material but failed to save it", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-mixed",
        seq: 1,
        eventType: "material_finalized",
        payload: {
          type: "material_finalized",
          callId: "submit-1",
          materialRef: {
            documentId: "run-mixed:document:1",
            documentVersion: 1,
            contentHash: "sha256:material",
          },
          materialKind: "summary",
          materialTitle: "Representational drift",
        },
        createdAt: 1,
      },
      {
        runId: "run-mixed",
        seq: 2,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "note-1",
          name: "note_write",
          ok: false,
          actionReceipts: [
            {
              version: 2,
              id: "note_create:new:unmatched:result",
              proposalId: "note_create:new",
              proofDomain: "zotero_state",
              capability: "zotero.notes",
              operation: "note_create",
              verification: "unverified",
              status: "failed",
              requestedTargets: ["item:41"],
              appliedTargets: [],
              alreadySatisfiedTargets: [],
              rejectedTargets: [],
              reasons: ["Zotero refused the note save"],
              verifiedFacts: [],
              materialRef: {
                documentId: "run-mixed:document:1",
                documentVersion: 1,
                contentHash: "sha256:material",
              },
            },
          ],
          content: { error: "Zotero refused the note save" },
        },
        createdAt: 2,
      },
      {
        runId: "run-mixed",
        seq: 3,
        eventType: "final",
        payload: { type: "final", text: "I could not save the note." },
        createdAt: 3,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const actionTexts = traceRowTexts(items);

    assert.include(
      actionTexts,
      "Generated summary: complete · Note write: failed · Retry available using the same material",
    );
    assert.equal(
      actionTexts[actionTexts.length - 1],
      "Generated summary: complete · Note write: failed · Retry available using the same material",
      "the mixed outcome closes the trace",
    );
  });

  it("does not close a saved material with a mixed-outcome row", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-clean",
        seq: 1,
        eventType: "material_finalized",
        payload: {
          type: "material_finalized",
          callId: "submit-1",
          materialRef: {
            documentId: "run-clean:document:1",
            documentVersion: 1,
            contentHash: "sha256:material",
          },
          materialKind: "summary",
          materialTitle: "Representational drift",
        },
        createdAt: 1,
      },
      {
        runId: "run-clean",
        seq: 2,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "note-1",
          name: "note_write",
          ok: true,
          actionReceipts: [
            {
              version: 2,
              id: "note_create:new:unmatched:result",
              proposalId: "note_create:new",
              proofDomain: "zotero_state",
              capability: "zotero.notes",
              operation: "note_create",
              verification: "verified",
              status: "applied",
              requestedTargets: ["item:41"],
              appliedTargets: ["item:41"],
              alreadySatisfiedTargets: [],
              rejectedTargets: [],
              reasons: [],
              verifiedFacts: ["native_note:77:html_sha256:abc123"],
              materialRef: {
                documentId: "run-clean:document:1",
                documentVersion: 1,
                contentHash: "sha256:material",
              },
            },
          ],
          content: { noteId: 77, documentId: "run-clean:document:1" },
        },
        createdAt: 2,
      },
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const actionTexts = traceRowTexts(items);

    assert.notMatch(actionTexts.join("\n"), /Retry available/);
  });

  it("keeps a streamed draft collapsed when the run announces its material", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-stream",
        seq: 1,
        eventType: "message_delta",
        payload: { type: "message_delta", text: "Drafting the guide." },
        createdAt: 1,
      },
      {
        runId: "run-stream",
        seq: 2,
        eventType: "material_finalized",
        payload: {
          type: "material_finalized",
          callId: "submit-1",
          materialRef: {
            documentId: "run-stream:document:1",
            documentVersion: 1,
            contentHash: "sha256:material",
          },
          materialKind: "guide",
          materialTitle: "Representational drift",
        },
        createdAt: 2,
      },
    ];

    const { items, isInterleaved } = buildAgentTraceDisplayItems(events, null);
    const actionTexts = traceRowTexts(items);

    assert.isFalse(
      isInterleaved,
      "announcing material is not a step taken between drafts",
    );
    assert.isEmpty(
      items.filter((item) => item.type === "inline_text"),
      "the intermediate draft stays collapsed",
    );
    assert.include(actionTexts, "Drafting answer");
    assert.include(actionTexts, "Generated guide: Representational drift");
  });

  it("does not hand the answer area to the trace when material is announced mid-run", function () {
    const events: AgentRunEventRecord[] = [
      {
        runId: "run-stream",
        seq: 1,
        eventType: "message_delta",
        payload: { type: "message_delta", text: "Drafting the guide." },
        createdAt: 1,
      },
      {
        runId: "run-stream",
        seq: 2,
        eventType: "material_finalized",
        payload: {
          type: "material_finalized",
          callId: "submit-1",
          materialRef: {
            documentId: "run-stream:document:1",
            documentVersion: 1,
            contentHash: "sha256:material",
          },
          materialKind: "guide",
          materialTitle: "Representational drift",
        },
        createdAt: 2,
      },
    ];

    const { inlineTextReplacesAssistantText } = buildAgentTraceDisplayItems(
      events,
      null,
    );

    assert.isFalse(
      inlineTextReplacesAssistantText,
      "no final event yet must not promote the draft to the answer",
    );
  });

  it("keeps the note diff card for a failed write that produced a receipt", function () {
    const cards = selectToolResultTraceCards(
      {
        type: "tool_result",
        callId: "note-1",
        name: "note_write",
        ok: false,
        actionReceipts: [
          {
            version: 2,
            id: "note_edit:41:unmatched:result",
            proposalId: "note_edit:41",
            proofDomain: "zotero_state",
            capability: "zotero.notes",
            operation: "note_edit",
            verification: "unverified",
            status: "failed",
            requestedTargets: ["item:41"],
            appliedTargets: [],
            alreadySatisfiedTargets: [],
            rejectedTargets: [],
            reasons: ["Zotero refused the note save"],
            verifiedFacts: [],
          },
        ],
        content: failedNoteChangeContent(),
      },
      buildNoteChangeResultCards,
    );

    assert.lengthOf(cards, 1);
    assert.equal(cards[0].kind, "note_change");
  });

  it("keeps the note diff card for a legacy result that journaled no receipts", function () {
    const cards = selectToolResultTraceCards(
      {
        type: "tool_result",
        callId: "note-1",
        name: "note_write",
        ok: false,
        actionReceipts: [],
        content: failedNoteChangeContent(),
      },
      buildNoteChangeResultCards,
    );

    assert.lengthOf(cards, 1);
    assert.equal(cards[0].kind, "note_change");
  });

  it("keeps an unrelated failed result from contributing cards", function () {
    const cards = selectToolResultTraceCards(
      {
        type: "tool_result",
        callId: "note-1",
        name: "note_write",
        ok: false,
        actionReceipts: [],
        content: { error: "The finalized document could not be resolved." },
      },
      buildNoteChangeResultCards,
    );

    assert.isEmpty(cards);
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
    const actionTexts = traceRowTexts(items);

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
    const actionTexts = traceRowTexts(items);

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
      "Agent activity",
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
      "Agent activity",
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
      "Agent activity",
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
      "Agent activity",
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
      "Agent activity",
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
      "Agent activity",
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
        // Both bridges stamp the server on every row they relay.
        serverName: "llm_for_zotero",
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
      "Agent activity",
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
      "Agent activity",
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
      serverName: "llm_for_zotero",
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
      "Agent activity",
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
      "Agent activity",
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

    assert.deepInclude(
      withToolPresentationsReturning(
        { paper_read: paperReadPresentation() },
        () => getCodexTraceActionTexts(events),
      ),
      "Extracted 2 figures",
    );
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
    assert.isTrue(
      trace
        .findAllByClass("llm-agent-trace-code")
        .some((entry) => entry.innerHTML.includes("python scripts/fetch.py")),
    );
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
    const actionTexts = traceRowTexts(items);

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
      flattenTraceItems(items).some(
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
    const actionTexts = traceRowTexts(items);

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
    const toolIndex = flattenTraceItems(items).findIndex(
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
    const doneActions = traceActionItems(items).filter(
      (item) => item.row.kind === "done",
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
    const actionTexts = traceRowTexts(items);

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

    const rows = withToolPresentationsReturning(
      { file_io: createFileIOTool().presentation },
      () =>
        traceActionItems(buildAgentTraceDisplayItems(events, null).items).map(
          (item) => item.row,
        ),
    );
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

    const actions = withToolPresentationsReturning(
      { file_io: createFileIOTool().presentation },
      () => traceActionItems(buildAgentTraceDisplayItems(events, null).items),
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
    const actions = traceActionItems(items);
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
    const actionTexts = traceRowTexts(items);

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
    const actionTexts = traceRowTexts(items);

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
    const rows = traceRowTexts(items);
    // The trace always opens with the request row; the judgment write must add
    // exactly one visible row after it.
    assert.deepEqual(rows, [
      "Request received",
      "Agent activity",
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
  it("reads paper labels from the field that carries them, not the tool name", function () {
    // Any result that resolved paper identities reports them under
    // `displayLabels`. A trace that had to know which tools do that would
    // lose the labels the day one is renamed or a new one starts reporting.
    const events = [
      {
        type: "tool_result",
        name: "a_tool_this_trace_has_never_heard_of",
        callId: "call-1",
        ok: true,
        content: { displayLabels: { "1:AAAA1111": "(Smith, 2024)" } },
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
      runId: "labels-by-field",
      seq: index,
      eventType: payload.type,
      payload,
      createdAt: index,
    })) as AgentRunEventRecord[];
    const serialized = JSON.stringify(
      buildAgentTraceDisplayItems(events, null, {
        role: "assistant",
        text: "",
        timestamp: 1,
        runMode: "agent",
      }).items,
    );
    assert.notInclude(serialized, "AAAA1111");
    assert.include(
      serialized,
      "(Smith, 2024)",
      "a result carrying display labels names its papers however it is called",
    );
  });

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

describe("agent trace stage grouping", function () {
  type StageTestItem = ReturnType<
    typeof buildAgentTraceDisplayItems
  >["items"][number];

  const noteReceipt = {
    version: 2,
    id: "note_create:new:unmatched:result",
    proposalId: "note_create:new",
    proofDomain: "zotero_state",
    capability: "zotero.notes",
    operation: "note_create",
    verification: "verified",
    status: "applied",
    requestedTargets: ["item:41"],
    appliedTargets: ["item:41"],
    alreadySatisfiedTargets: [],
    rejectedTargets: [],
    reasons: [],
    verifiedFacts: ["created_note:item:77", "native_note:77:html_sha256:abc"],
    materialRef: {
      documentId: "run-journey:document:1",
      documentVersion: 1,
      contentHash: "sha256:material",
    },
  } as unknown as Extract<
    AgentRunEventRecord["payload"],
    { type: "tool_result" }
  >["actionReceipts"][number];

  function stageEvent(
    seq: number,
    payload: Extract<AgentRunEventRecord["payload"], { type: "agent_stage" }>,
  ): AgentRunEventRecord {
    return {
      runId: "run-journey",
      seq,
      eventType: "agent_stage",
      payload,
      createdAt: seq,
    };
  }

  function event(
    seq: number,
    payload: AgentRunEventRecord["payload"],
  ): AgentRunEventRecord {
    return {
      runId: "run-journey",
      seq,
      eventType: payload.type,
      payload,
      createdAt: seq,
    };
  }

  function stages(items: readonly StageTestItem[]) {
    return items.filter(
      (item): item is Extract<StageTestItem, { type: "stage" }> =>
        item.type === "stage",
    );
  }

  function rowTexts(items: readonly StageTestItem[]): string[] {
    return items
      .filter(
        (item): item is Extract<StageTestItem, { type: "action" }> =>
          item.type === "action",
      )
      .map((item) => item.row.text);
  }

  /** The Phase 1 journey: read the paper, write the summary, save the note. */
  function journeyEvents(): AgentRunEventRecord[] {
    return [
      stageEvent(1, {
        type: "agent_stage",
        stage: "retrieval",
        status: "started",
        callId: "r1",
        toolName: "paper_read",
        toolLabel: "Read Paper",
      }),
      event(2, {
        type: "tool_call",
        callId: "r1",
        name: "paper_read",
        args: { itemId: 5 },
        toolLabel: "Read Paper",
        workCategory: "retrieval",
      }),
      stageEvent(3, {
        type: "agent_stage",
        stage: "retrieval",
        status: "completed",
        callId: "r1",
        toolName: "paper_read",
        toolLabel: "Read Paper",
      }),
      event(4, {
        type: "tool_result",
        callId: "r1",
        name: "paper_read",
        ok: true,
        actionReceipts: [],
        content: { sections: [] },
        toolLabel: "Read Paper",
        workCategory: "retrieval",
      }),
      stageEvent(5, {
        type: "agent_stage",
        stage: "generation",
        status: "completed",
        materialRef: {
          documentId: "run-journey:document:1",
          documentVersion: 1,
          contentHash: "sha256:material",
        },
      }),
      event(6, {
        type: "material_finalized",
        materialRef: {
          documentId: "run-journey:document:1",
          documentVersion: 1,
          contentHash: "sha256:material",
        },
        materialKind: "summary",
        materialTitle: "Representational drift",
      }),
      stageEvent(7, {
        type: "agent_stage",
        stage: "zotero_action",
        status: "started",
        callId: "w1",
        toolName: "note_write",
        toolLabel: "Note Write",
      }),
      event(8, {
        type: "tool_call",
        callId: "w1",
        name: "note_write",
        args: { documentId: "run-journey:document:1" },
        toolLabel: "Note Write",
        workCategory: "zotero_action",
      }),
      stageEvent(9, {
        type: "agent_stage",
        stage: "zotero_action",
        status: "completed",
        callId: "w1",
        toolName: "note_write",
        toolLabel: "Note Write",
        receiptIds: [noteReceipt.id],
      }),
      event(10, {
        type: "tool_result",
        callId: "w1",
        name: "note_write",
        ok: true,
        actionReceipts: [noteReceipt],
        content: { noteId: 77, documentId: "run-journey:document:1" },
        toolLabel: "Note Write",
        workCategory: "zotero_action",
      }),
    ];
  }

  it("groups the journey's rows under the stage that produced them", function () {
    const { items } = buildAgentTraceDisplayItems(journeyEvents(), null);
    const groups = stages(items);

    assert.deepEqual(
      groups.map((group) => group.label),
      [
        "Read evidence",
        "Generated summary: Representational drift",
        "Saved note",
      ],
    );
    assert.deepEqual(
      groups.map((group) => group.stage),
      ["retrieval", "generation", "zotero_action"],
    );
    assert.include(rowTexts(groups[0].children), "Using Read Paper");
    assert.include(rowTexts(groups[2].children), "Zotero state verified");
    assert.notInclude(
      rowTexts(items),
      "Generated summary: Representational drift",
      "the material announcement heads its stage instead of repeating inside it",
    );
  });

  it("reports the worst verification its children proved on the stage itself", function () {
    const { items } = buildAgentTraceDisplayItems(journeyEvents(), null);
    const zoteroStage = stages(items).find(
      (group) => group.stage === "zotero_action",
    );

    assert.deepEqual(
      (zoteroStage?.chips || []).map((chip) => chip.label),
      ["Verified"],
    );
  });

  it("reports a run recorded before work categories as one agent activity group", function () {
    const events: AgentRunEventRecord[] = [
      event(1, {
        type: "tool_call",
        callId: "old-1",
        name: "query_library",
        args: { query: "drift" },
      }),
      event(2, {
        type: "tool_call",
        callId: "old-2",
        name: "read_paper",
        args: { itemId: 3 },
      }),
    ];

    const groups = stages(buildAgentTraceDisplayItems(events, null).items);

    assert.lengthOf(groups, 1);
    assert.equal(groups[0].label, "Agent activity");
    assert.isTrue(groups[0].projected);
    assert.deepEqual(rowTexts(groups[0].children), [
      "Using Query Library",
      "Using Read Paper",
    ]);
  });

  it("keeps consecutive calls of one stage in a single group", function () {
    const events: AgentRunEventRecord[] = [
      stageEvent(1, {
        type: "agent_stage",
        stage: "retrieval",
        status: "started",
        callId: "a",
      }),
      event(2, {
        type: "tool_call",
        callId: "a",
        name: "query_library",
        args: {},
        workCategory: "retrieval",
      }),
      stageEvent(3, {
        type: "agent_stage",
        stage: "retrieval",
        status: "completed",
        callId: "a",
      }),
      event(4, {
        type: "tool_result",
        callId: "a",
        name: "query_library",
        ok: true,
        actionReceipts: [],
        content: {},
        workCategory: "retrieval",
      }),
      stageEvent(5, {
        type: "agent_stage",
        stage: "retrieval",
        status: "started",
        callId: "b",
      }),
      event(6, {
        type: "tool_call",
        callId: "b",
        name: "search_paper",
        args: {},
        workCategory: "retrieval",
      }),
      stageEvent(7, {
        type: "agent_stage",
        stage: "retrieval",
        status: "completed",
        callId: "b",
      }),
      event(8, {
        type: "tool_result",
        callId: "b",
        name: "search_paper",
        ok: true,
        actionReceipts: [],
        content: {},
        workCategory: "retrieval",
      }),
    ];

    const groups = stages(buildAgentTraceDisplayItems(events, null).items);

    assert.lengthOf(groups, 1);
    assert.equal(groups[0].status, "completed");
    assert.deepEqual(rowTexts(groups[0].children), [
      "Using Query Library",
      "Using Search Paper",
    ]);
  });

  it("leaves a stage nothing closed open", function () {
    const events: AgentRunEventRecord[] = [
      stageEvent(1, {
        type: "agent_stage",
        stage: "planning",
        status: "started",
      }),
      event(2, {
        type: "tool_call",
        callId: "p1",
        name: "amend_plan",
        args: {},
        workCategory: "planning",
      }),
    ];

    const groups = stages(buildAgentTraceDisplayItems(events, null).items);

    assert.lengthOf(groups, 1);
    assert.equal(groups[0].status, "started");
    assert.equal(groups[0].label, "Planning");
  });

  it("merges repeated planning starts into one open planning stage", function () {
    const events: AgentRunEventRecord[] = [
      stageEvent(1, {
        type: "agent_stage",
        stage: "planning",
        status: "started",
      }),
      event(2, {
        type: "plan_scope_amended",
        mode: "plan",
        amendmentId: "amend-1",
        authority: "user",
        previousItemCount: 2,
        newItemCount: 3,
        rationale: "one more paper",
      } as AgentRunEventRecord["payload"]),
      stageEvent(3, {
        type: "agent_stage",
        stage: "planning",
        status: "started",
      }),
      event(4, {
        type: "plan_scope_amended",
        mode: "plan",
        amendmentId: "amend-2",
        authority: "user",
        previousItemCount: 3,
        newItemCount: 4,
        rationale: "one more still",
      } as AgentRunEventRecord["payload"]),
    ];

    const groups = stages(buildAgentTraceDisplayItems(events, null).items);

    assert.lengthOf(groups, 1);
    assert.equal(groups[0].status, "started");
    assert.lengthOf(groups[0].children, 2);
  });

  it("keeps reasoning and streamed text outside stage groups and in order", function () {
    const events: AgentRunEventRecord[] = [
      stageEvent(1, {
        type: "agent_stage",
        stage: "retrieval",
        status: "started",
        callId: "a",
      }),
      event(2, {
        type: "tool_call",
        callId: "a",
        name: "query_library",
        args: {},
        workCategory: "retrieval",
      }),
      event(3, {
        type: "reasoning",
        round: 1,
        stepId: "step-1",
        stepLabel: "Thinking",
        summary: "Looking at the library",
      }),
      stageEvent(4, {
        type: "agent_stage",
        stage: "retrieval",
        status: "started",
        callId: "b",
      }),
      event(5, {
        type: "tool_call",
        callId: "b",
        name: "search_paper",
        args: {},
        workCategory: "retrieval",
      }),
    ];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const shape = items.map((item) => item.type);

    assert.deepEqual(shape.slice(2), ["stage", "reasoning", "stage"]);
  });

  it("keeps streamed prose in one block across a stage that shows nothing", function () {
    const events: AgentRunEventRecord[] = [
      event(1, { type: "message_delta", text: "Looking at" }),
      stageEvent(2, {
        type: "agent_stage",
        stage: "planning",
        status: "started",
      }),
      // The plan machinery asked to stay out of the trace, so this stage has
      // no row to show and must not come between the two halves of the answer.
      event(3, {
        type: "tool_call",
        callId: "p1",
        name: "update_plan",
        args: {},
        workCategory: "planning",
      }),
      event(4, { type: "message_delta", text: " the library." }),
      stageEvent(5, {
        type: "agent_stage",
        stage: "retrieval",
        status: "started",
        callId: "r1",
      }),
      event(6, {
        type: "tool_call",
        callId: "r1",
        name: "query_library",
        args: {},
        workCategory: "retrieval",
      }),
    ];

    withToolPresentations({ update_plan: { hiddenInTrace: true } }, () => {
      const { items } = buildAgentTraceDisplayItems(events, null);
      const inline = flattenTraceItems(items).filter(
        (item) => item.type === "inline_text",
      );
      assert.lengthOf(inline, 1);
      assert.equal(
        inline[0].type === "inline_text" ? inline[0].text : "",
        "Looking at the library.",
      );
    });
  });

  it("shows a child's verification chip only when it differs from its stage's", function () {
    const receipt = (
      id: string,
      verification: string,
    ): Extract<
      AgentRunEventRecord["payload"],
      { type: "tool_result" }
    >["actionReceipts"][number] =>
      ({
        version: 2,
        id,
        proposalId: id,
        proofDomain: "zotero_state",
        capability: "zotero.items",
        operation: "tag_add",
        verification,
        status: "applied",
        requestedTargets: ["item:1"],
        appliedTargets: ["item:1"],
        alreadySatisfiedTargets: [],
        rejectedTargets: [],
        reasons: [],
      }) as never;
    const write = (
      seq: number,
      callId: string,
      receipts: Extract<
        AgentRunEventRecord["payload"],
        { type: "tool_result" }
      >["actionReceipts"],
    ): AgentRunEventRecord[] => [
      stageEvent(seq, {
        type: "agent_stage",
        stage: "zotero_action",
        status: "completed",
        callId,
      }),
      event(seq + 1, {
        type: "tool_result",
        callId,
        name: "apply_tags",
        ok: true,
        actionReceipts: receipts,
        content: { tagged: 1 },
        toolLabel: "Apply Tags",
        workCategory: "zotero_action",
      }),
    ];

    const tagPresentation = {
      apply_tags: {
        label: "Apply Tags",
        summaries: { onSuccess: "Tags applied" },
      },
    };
    const agreeing = withToolPresentationsReturning(
      tagPresentation,
      () =>
        buildAgentTraceDisplayItems(
          write(1, "a", [receipt("a", "verified")]),
          null,
        ).items,
    );
    const agreeingStage = stages(agreeing)[0];
    assert.deepEqual(
      (agreeingStage.chips || []).map((chip) => chip.label),
      ["Verified"],
    );
    assert.deepEqual(
      traceActionItems(agreeing).flatMap((item) =>
        (item.chips || []).map((chip) => chip.label),
      ),
      [],
      "a row that proved exactly what its stage reports does not repeat it",
    );

    const differing = withToolPresentationsReturning(
      tagPresentation,
      () =>
        buildAgentTraceDisplayItems(
          [
            ...write(1, "a", [receipt("a", "verified")]),
            ...write(3, "b", [receipt("b", "unverified")]),
          ],
          null,
        ).items,
    );
    const differingStage = stages(differing)[0];
    assert.deepEqual(
      (differingStage.chips || []).map((chip) => chip.label),
      ["Unverified"],
    );
    assert.deepEqual(
      traceActionItems(differing).flatMap((item) =>
        (item.chips || []).map((chip) => chip.label),
      ),
      ["Verified"],
      "only the row whose proof differs from the stage's keeps its chip",
    );
  });

  it("renders each stage as one disclosure holding its rows", function () {
    const message = {
      role: "assistant" as const,
      text: "",
      timestamp: 1,
      runMode: "agent" as const,
      agentRunId: "run-journey",
      streaming: false,
    };
    const root = renderAgentTrace({
      doc: fakeDocument,
      message,
      events: journeyEvents(),
    }) as unknown as FakeElement;

    const stageNodes = root.findAllByClass("llm-agent-process-stage");
    assert.lengthOf(stageNodes, 3);
    assert.deepEqual(
      stageNodes.map((node) => node.getAttribute("data-stage")),
      ["retrieval", "generation", "zotero_action"],
    );
    assert.deepEqual(
      stageNodes.map(
        (node) =>
          node.findByClass("llm-agent-process-stage-label")?.textContent,
      ),
      [
        "Read evidence",
        "Generated summary: Representational drift",
        "Saved note",
      ],
    );
    assert.equal(stageNodes[0].tagName, "details");
    const evidenceRows = stageNodes[2]
      .findAllByClass("llm-at-text")
      .map((node) => node.textContent);
    assert.include(evidenceRows, "Zotero state verified");
    disposeAgentTrace(root as unknown as HTMLElement);
  });

  it("keeps a stage's node across an incremental re-render", function () {
    const message = {
      role: "assistant" as const,
      text: "",
      timestamp: 1,
      runMode: "agent" as const,
      agentRunId: "run-journey",
      streaming: false,
    };
    const events = journeyEvents();
    const first = renderAgentTrace({
      doc: fakeDocument,
      message,
      events: events.slice(0, 4),
    }) as unknown as FakeElement;
    const firstStage = first.findByClass("llm-agent-process-stage");
    const second = renderAgentTrace({
      doc: fakeDocument,
      message,
      events,
      previous: first as unknown as HTMLElement,
    }) as unknown as FakeElement;

    assert.strictEqual(
      second.findByClass("llm-agent-process-stage"),
      firstStage,
      "the retrieval stage keeps its node when later stages arrive",
    );
    disposeAgentTrace(second as unknown as HTMLElement);
  });

  /**
   * The same journey as a run recorded before stage events existed: work
   * categories on the tool events, a finalized material, a batch row, and no
   * `agent_stage` anywhere. The compatibility projection has to carry it all
   * the way to the DOM, not only to the display items.
   */
  function phase3Events(): AgentRunEventRecord[] {
    return [
      event(1, {
        type: "tool_call",
        callId: "r1",
        name: "paper_read",
        args: { itemId: 5 },
        workCategory: "retrieval",
      }),
      event(2, {
        type: "tool_result",
        callId: "r1",
        name: "paper_read",
        ok: true,
        actionReceipts: [],
        content: { sections: [] },
        workCategory: "retrieval",
      }),
      event(3, {
        type: "material_finalized",
        materialRef: {
          documentId: "run-journey:document:1",
          documentVersion: 1,
          contentHash: "sha256:material",
        },
        materialKind: "summary",
        materialTitle: "Representational drift",
      }),
      event(4, {
        type: "tool_call",
        callId: "w1",
        name: "note_write",
        args: { documentId: "run-journey:document:1" },
        workCategory: "zotero_action",
      }),
      event(5, {
        type: "tool_result",
        callId: "w1",
        name: "note_write",
        ok: true,
        actionReceipts: [noteReceipt],
        content: { noteId: 77, documentId: "run-journey:document:1" },
        workCategory: "zotero_action",
      }),
      event(6, {
        type: "batch_item_outcome",
        batchId: "batch-1",
        itemKey: "item:91",
        materialRef: {
          documentId: "run-journey:document:2",
          documentVersion: 1,
          contentHash: "sha256:batch",
        },
        status: "saved",
        written: true,
        noteId: 78,
        callId: "w1",
      }),
    ];
  }

  /** A run older than work categories: tool calls and nothing else to read. */
  function prePhase0Events(): AgentRunEventRecord[] {
    return [
      event(1, {
        type: "tool_call",
        callId: "old-1",
        name: "query_library",
        args: { query: "drift" },
      }),
      event(2, {
        type: "tool_call",
        callId: "old-2",
        name: "read_paper",
        args: { itemId: 3 },
      }),
    ];
  }

  function renderStages(events: AgentRunEventRecord[]): {
    root: FakeElement;
    labels: string[];
    kinds: (string | null)[];
    rows: string[][];
  } {
    const root = renderAgentTrace({
      doc: fakeDocument,
      message: {
        role: "assistant" as const,
        text: "",
        timestamp: 1,
        runMode: "agent" as const,
        agentRunId: "run-journey",
        streaming: false,
      },
      events,
    }) as unknown as FakeElement;
    const nodes = root.findAllByClass("llm-agent-process-stage");
    return {
      root,
      labels: nodes.map(
        (node) =>
          node.findByClass("llm-agent-process-stage-label")?.textContent || "",
      ),
      kinds: nodes.map((node) => node.getAttribute("data-stage")),
      rows: nodes.map(
        (node) =>
          node
            .findByClass("llm-agent-process-stage-body")
            ?.findAllByClass("llm-at-text")
            .map((row) => row.textContent) || [],
      ),
    };
  }

  it("renders a trace recorded before stage events as the same stages", function () {
    const historical = renderStages(phase3Events());
    const live = renderStages(journeyEvents());

    assert.deepEqual(historical.kinds, [
      "retrieval",
      "generation",
      "zotero_action",
    ]);
    assert.deepEqual(
      historical.labels,
      live.labels,
      "a projected run reads like the live run it predates",
    );
    assert.include(
      historical.rows[2].join(" | "),
      "Zotero state verified",
      "the receipt row still lands inside the action stage it proved",
    );
    disposeAgentTrace(historical.root as unknown as HTMLElement);
    disposeAgentTrace(live.root as unknown as HTMLElement);
  });

  it("renders a trace recorded before work categories as one activity group", function () {
    const { root, labels, rows } = renderStages(prePhase0Events());

    assert.deepEqual(labels, ["Agent activity"]);
    assert.deepEqual(rows[0], ["Using Query Library", "Using Read Paper"]);
    disposeAgentTrace(root as unknown as HTMLElement);
  });

  /**
   * A template whose parsed content can be walked, as chrome's parser gives it.
   *
   * The saved-note card renders the note's own sanitized HTML, so a test that
   * asserts the card exists has to let that parse succeed.
   */
  class FakeTemplateElement extends FakeElement {
    public readonly content = new FakeElement("div");

    constructor() {
      super("template");
    }

    set innerHTML(_value: string) {}

    get innerHTML(): string {
      return "";
    }
  }

  const noteCardDocument = {
    createElement: (tagName: string) =>
      tagName === "template"
        ? new FakeTemplateElement()
        : new FakeElement(tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      new FakeElement(tagName),
    createTextNode: (text: string) => {
      const node = new FakeElement("span");
      node.textContent = text;
      return node;
    },
    querySelectorAll: () => [],
  } as unknown as Document;

  /** The deliverable a successful note creation owes the reader. */
  const savedNoteCard = {
    kind: "saved_note" as const,
    actionId: "note-create-1",
    title: "Representational drift",
    destination: "Zotero",
    bodyHtml: "<p>What the note says.</p>",
    note: { itemId: 77, libraryID: 1, key: "ABCD1234" },
  };

  /** The deliverable a successful note edit owes the reader. */
  const noteChangeCard = {
    kind: "note_change" as const,
    actionId: "note-edit-1",
    title: "Representational drift",
    description: "Rewrote the discussion section.",
    note: { itemId: 77, libraryID: 1, key: "ABCD1234" },
    conversationKey: 5,
    state: "applied" as const,
    afterVerified: true,
    before: { checksum: "sha256:before", recoveryId: "recovery-before" },
    after: { checksum: "sha256:after", recoveryId: "recovery-after" },
  };

  /** One note write, with or without the stage events the runtime emits. */
  function noteWriteEvents(declaresStages: boolean): AgentRunEventRecord[] {
    const events = [
      stageEvent(1, {
        type: "agent_stage",
        stage: "zotero_action",
        status: "started",
        callId: "w1",
        toolName: "note_write",
        toolLabel: "Note Write",
      }),
      event(2, {
        type: "tool_call",
        callId: "w1",
        name: "note_write",
        args: { noteId: 77 },
        toolLabel: "Note Write",
        workCategory: "zotero_action",
      }),
      stageEvent(3, {
        type: "agent_stage",
        stage: "zotero_action",
        status: "completed",
        callId: "w1",
        toolName: "note_write",
        toolLabel: "Note Write",
        receiptIds: [noteReceipt.id],
      }),
      event(4, {
        type: "tool_result",
        callId: "w1",
        name: "note_write",
        ok: true,
        actionReceipts: [noteReceipt],
        content: { noteId: 77 },
        toolLabel: "Note Write",
        workCategory: "zotero_action",
      }),
    ];
    return declaresStages
      ? events
      : events.filter((entry) => entry.payload.type !== "agent_stage");
  }

  /** Render the note write with the card its own presentation produces. */
  function renderNoteWriteTrace(
    card: typeof savedNoteCard | typeof noteChangeCard,
    declaresStages: boolean,
  ): FakeElement {
    const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };
    const originalZotero = globalScope.Zotero;
    globalScope.Zotero = {
      ...((originalZotero as Record<string, unknown>) || {}),
      Libraries: { userLibraryID: 1, get: () => undefined },
    };
    try {
      return withToolPresentationsReturning(
        {
          note_write: {
            label: "Note Write",
            summaries: { onSuccess: "Note saved" },
            buildResultCards: () => [card],
          },
        },
        () =>
          renderAgentTrace({
            doc: noteCardDocument,
            message: {
              role: "assistant" as const,
              text: "",
              timestamp: 1,
              runMode: "agent" as const,
              agentRunId: "run-journey",
              streaming: false,
            },
            events: noteWriteEvents(declaresStages),
          }) as unknown as FakeElement,
      );
    } finally {
      globalScope.Zotero = originalZotero;
    }
  }

  for (const declaresStages of [true, false]) {
    const route = declaresStages
      ? "the run's own stage events"
      : "stages projected for a run that emitted none";

    it(`shows the saved note below the activity with ${route}`, function () {
      const root = renderNoteWriteTrace(savedNoteCard, declaresStages);
      const disclosure = root.findByClass("llm-agent-activity-details");
      const cards = root.findAllByClass("llm-saved-note-card");

      assert.exists(disclosure, "the activity disclosure must still render");
      assert.lengthOf(
        cards,
        1,
        "grouping the row into a stage must not lose the saved note",
      );
      assert.lengthOf(
        disclosure!.findAllByClass("llm-saved-note-card"),
        0,
        "the deliverable belongs below the disclosure, not inside it",
      );
      // The write journaled a receipt, so the note is the action card's note
      // mode rather than a second card beside it.
      assert.equal(cards[0].dataset.mode, "note");
      assert.equal(
        cards[0].findByClass("llm-plan-title")!.textContent,
        "Representational drift",
      );
      assert.include(
        cards[0]
          .findAllByClass("llm-plan-action")
          .map((button) => button.textContent)
          .join(" "),
        "Open note",
        "the reader must keep the way into the note that was saved",
      );
      disposeAgentTrace(root as unknown as HTMLElement);
    });

    it(`shows the note change below the activity with ${route}`, function () {
      const root = renderNoteWriteTrace(noteChangeCard, declaresStages);
      const disclosure = root.findByClass("llm-agent-activity-details");
      const cards = root.findAllByClass("llm-note-change-card");

      assert.exists(disclosure, "the activity disclosure must still render");
      assert.lengthOf(
        cards,
        1,
        "grouping the row into a stage must not lose the note change",
      );
      assert.lengthOf(
        disclosure!.findAllByClass("llm-note-change-card"),
        0,
        "the deliverable belongs below the disclosure, not inside it",
      );
      // The write journaled a receipt, so the change is the action card's note
      // mode rather than a second card beside it.
      assert.equal(cards[0].dataset.mode, "note");
      assert.equal(
        cards[0].findByClass("llm-plan-title")!.textContent,
        "Changed ‘Representational drift’",
      );
      assert.include(
        cards[0]
          .findAllByTag("button")
          .map((button) => button.textContent)
          .join(" "),
        "Undo",
        "the reader must keep the control that reverses the change",
      );
      disposeAgentTrace(root as unknown as HTMLElement);
    });
  }
});

describe("agent trace presentation without tool names", function () {
  function callEvent(
    name: string,
    args: unknown,
    extra: Record<string, unknown> = {},
  ): AgentRunEventRecord {
    return {
      runId: "run-presentation",
      seq: 1,
      eventType: "tool_call",
      payload: {
        type: "tool_call",
        callId: "call-1",
        name,
        args,
        ...extra,
      } as AgentRunEventRecord["payload"],
      createdAt: 1,
    };
  }

  function firstToolRow(items: readonly AgentTraceTestItem[]) {
    return traceActionItems(items).find((item) => item.row.kind === "tool")
      ?.row;
  }

  it("shows a file operation's code block only because its tool asks for one", function () {
    const events = [
      callEvent("file_io", { mode: "read", path: "/tmp/notes/paper.md" }),
    ];

    const withoutRegistry = firstToolRow(
      buildAgentTraceDisplayItems(events, null).items,
    );
    assert.isUndefined(withoutRegistry?.codeBlock);

    withToolPresentations({ file_io: createFileIOTool().presentation }, () => {
      const row = firstToolRow(buildAgentTraceDisplayItems(events, null).items);
      assert.equal(row?.codeBlock, "read /tmp/notes/paper.md");
      assert.equal(row?.text, "Reading paper.md");
    });
  });

  it("shows a shell command's code block and its tool's label", function () {
    const events = [callEvent("run_command", { command: "ls ~/Desktop" })];

    assert.isUndefined(
      firstToolRow(buildAgentTraceDisplayItems(events, null).items)?.codeBlock,
    );

    withToolPresentations(
      { run_command: createRunCommandTool().presentation },
      () => {
        const row = firstToolRow(
          buildAgentTraceDisplayItems(events, null).items,
        );
        assert.equal(row?.codeBlock, "ls ~/Desktop");
        assert.equal(row?.text, "Run Command");
      },
    );
  });

  it("takes a call's argument details from the tool that declared them", function () {
    const events = [
      callEvent("file_io", {
        action: "write",
        filePath: "/tmp/script.py",
        content: "secret script body",
      }),
    ];

    const detailsWithoutRegistry = JSON.stringify(
      traceActionItems(buildAgentTraceDisplayItems(events, null).items).map(
        (item) => item.details,
      ),
    );
    assert.notInclude(detailsWithoutRegistry, "Argument keys");

    withToolPresentations({ file_io: createFileIOTool().presentation }, () => {
      const details = JSON.stringify(
        traceActionItems(buildAgentTraceDisplayItems(events, null).items).map(
          (item) => item.details,
        ),
      );
      assert.include(details, "Argument keys");
      assert.include(details, "Action field (action)");
      assert.include(details, "Path field (filePath)");
      assert.notInclude(details, "secret script body");
    });
  });

  it("substitutes the request's own chips only when a tool asks for them", function () {
    const userMessage = {
      role: "user" as const,
      text: "summarize",
      timestamp: 1,
      paperContexts: [
        { itemId: 7, contextItemId: 8, title: "Representational drift" },
      ],
    };
    const events = [callEvent("get_active_context", {})];

    const chipsWithoutHook = traceActionItems(
      buildAgentTraceDisplayItems(events, userMessage).items,
    )
      .filter((item) => item.row.kind === "tool")
      .flatMap((item) => item.chips || []);
    assert.lengthOf(chipsWithoutHook, 0);

    withToolPresentations(
      {
        get_active_context: {
          buildChips: ({ request }) =>
            (request?.paperTitles || []).map((title) => ({
              iconName: "paper" as const,
              label: "Paper",
              title,
            })),
        },
      },
      () => {
        const chips = traceActionItems(
          buildAgentTraceDisplayItems(events, userMessage).items,
        )
          .filter((item) => item.row.kind === "tool")
          .flatMap((item) => item.chips || []);
        assert.deepEqual(
          chips.map((chip) => chip.title),
          ["Representational drift"],
        );
      },
    );
  });

  it("reads a result's line range from its numbered lines, not its tool name", function () {
    const events: AgentRunEventRecord[] = [
      callEvent("host_file_reader", { path: "/tmp/x.ts" }),
      {
        runId: "run-presentation",
        seq: 2,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "call-1",
          name: "host_file_reader",
          ok: true,
          actionReceipts: [],
          content: "  12\tconst a = 1;\n  13\tconst b = 2;",
        },
        createdAt: 2,
      },
    ];

    const row = firstToolRow(buildAgentTraceDisplayItems(events, null).items);

    assert.equal(row?.text, "Using Host File Reader lines 12-13");
  });

  it("asks the paper tool how to name a relayed figure extraction", function () {
    const events = [
      codexToolActivityEvent(1, {
        type: "codex_tool_activity",
        itemId: "figures-1",
        phase: "completed",
        toolName: "mcp__llm_for_zotero__paper_read",
        toolLabel: "Read Paper",
        ok: true,
        args: { mode: "figures" },
        artifacts: [
          {
            kind: "image",
            mimeType: "image/png",
            storedPath: "/tmp/figure-1.png",
          },
          {
            kind: "image",
            mimeType: "image/png",
            storedPath: "/tmp/figure-2.png",
          },
        ],
      }),
    ];

    assert.deepEqual(getCodexTraceActionTexts(events), [
      "Codex received the request",
      "Agent activity",
      "Used Read Paper",
    ]);

    withToolPresentations(
      {
        paper_read: createPaperReadTool(
          undefined as never,
          undefined as never,
          undefined as never,
          undefined as never,
        ).presentation,
      },
      () => {
        assert.deepEqual(getCodexTraceActionTexts(events), [
          "Codex received the request",
          "Agent activity",
          "Extracted 2 figures",
        ]);
      },
    );
  });

  it("keeps the plan's own tools out of the trace because they say so", function () {
    const events: AgentRunEventRecord[] = [
      callEvent("update_plan", { ready: true, steps: [] }),
    ];

    withToolPresentations({ update_plan: { hiddenInTrace: true } }, () => {
      assert.deepEqual(
        traceRowTexts(buildAgentTraceDisplayItems(events, null).items),
        ["Request received"],
      );
    });
    withToolPresentations({ update_plan: { label: "Update Plan" } }, () => {
      assert.include(
        traceRowTexts(buildAgentTraceDisplayItems(events, null).items),
        "Using Update Plan",
      );
    });
  });

  it("names a tool by the label its own event carried", function () {
    const labelled = firstToolRow(
      buildAgentTraceDisplayItems(
        [callEvent("paper_read", {}, { toolLabel: "Read Paper" })],
        null,
      ).items,
    );
    assert.equal(labelled?.text, "Using Read Paper");

    const unlabelled = firstToolRow(
      buildAgentTraceDisplayItems([callEvent("paper_read", {})], null).items,
    );
    assert.equal(unlabelled?.text, "Using Paper Read");

    withToolPresentations({ paper_read: { label: "Read Paper" } }, () => {
      const fromRegistry = firstToolRow(
        buildAgentTraceDisplayItems([callEvent("paper_read", {})], null).items,
      );
      assert.equal(fromRegistry?.text, "Using Read Paper");
    });
  });

  it("names an activated skill from the event's label and arguments", function () {
    const using = firstToolRow(
      buildAgentTraceDisplayItems(
        [
          callEvent(
            "skill:graphwalk",
            { skill: "graphwalk" },
            { toolLabel: "Skill" },
          ),
        ],
        null,
      ).items,
    );
    assert.equal(using?.text, "Using Skill: graphwalk");

    const invoked = firstToolRow(
      buildAgentTraceDisplayItems(
        [
          callEvent(
            "skill:evidence-based-qa",
            { skill: "evidence-based-qa", source: "codex-native-slash" },
            { toolLabel: "Skill" },
          ),
        ],
        null,
      ).items,
    );
    assert.equal(invoked?.text, "Invoked Skill: evidence-based-qa");
  });
});

/**
 * What the turn actually did, said once, for the reader.
 *
 * The machine-readable action-status block no longer reaches the answer
 * bubble, so the receipts it stated have to reach the reader somewhere. They
 * reach it here: one line per receipt at the end of the trace, named by the
 * operation catalog and verified in the same words the row chips use.
 */
describe("agent trace action summary card", function () {
  type SummaryTestItem = ReturnType<
    typeof buildAgentTraceDisplayItems
  >["items"][number];

  function event(
    seq: number,
    payload: AgentRunEventRecord["payload"],
  ): AgentRunEventRecord {
    return {
      runId: "run-summary",
      seq,
      eventType: payload.type,
      payload,
      createdAt: seq,
    };
  }

  const materialRef = {
    documentId: "run-summary:document:1",
    documentVersion: 1,
    contentHash: "sha256:material",
  };

  function receipt(
    overrides: Record<string, unknown>,
  ): Extract<
    AgentRunEventRecord["payload"],
    { type: "tool_result" }
  >["actionReceipts"][number] {
    return {
      version: 2,
      id: "receipt-1",
      proposalId: "proposal-1",
      proofDomain: "zotero_state",
      capability: "zotero.notes",
      operation: "note_create",
      verification: "verified",
      status: "applied",
      requestedTargets: ["item:41"],
      appliedTargets: ["item:41"],
      alreadySatisfiedTargets: [],
      rejectedTargets: [],
      reasons: [],
      verifiedFacts: [],
      ...overrides,
    } as unknown as Extract<
      AgentRunEventRecord["payload"],
      { type: "tool_result" }
    >["actionReceipts"][number];
  }

  function summaryCard(items: readonly SummaryTestItem[]) {
    const lists = items.filter(
      (item): item is Extract<SummaryTestItem, { type: "card_list" }> =>
        item.type === "card_list",
    );
    const cards = lists.flatMap((item) =>
      item.cards.filter((card) => card.kind === "action_summary"),
    );
    return cards[0] as
      | Extract<(typeof cards)[number], { kind: "action_summary" }>
      | undefined;
  }

  const effectEvents: AgentRunEventRecord[] = [
    event(1, {
      type: "material_finalized",
      materialRef,
      materialKind: "summary",
      materialTitle: "Attention in transformers",
    }),
    event(2, {
      type: "tool_result",
      callId: "call-note",
      name: "note_write",
      ok: true,
      actionReceipts: [
        receipt({
          id: "note-1",
          materialRef,
          verifiedFacts: ["native_note:77:text_match"],
        }),
      ],
      content: { noteId: 77 },
    }),
    event(3, {
      type: "tool_result",
      callId: "call-tags",
      name: "library_update",
      ok: true,
      actionReceipts: [
        receipt({
          id: "tags-1",
          capability: "zotero.tags",
          operation: "apply_tags",
          verification: "execution_only",
          status: "partial",
          executionAuthority: "external_runtime",
          requestedTargets: ["item:41", "item:42"],
          appliedTargets: ["item:41"],
          normalizedParameters: { tags: ["attention", "transformers"] },
        }),
      ],
      content: {},
    }),
    event(4, { type: "final", text: "Saved the summary.", materialRef }),
  ];

  it("lists one row per target set, named by the operation catalog", function () {
    const card = summaryCard(
      buildAgentTraceDisplayItems(effectEvents, null).items,
    );

    assert.exists(card, "the run's effects are summarized");
    assert.deepEqual(
      card!.entries.map((entry) => entry.effects.map((effect) => effect.label)),
      [["Created note"], ["Added tags"]],
    );
    assert.deepEqual(
      card!.entries.map((entry) => entry.targets.map((target) => target.label)),
      [["Item 41"], ["Item 41", "Item 42"]],
      "each row names the items its receipts covered",
    );
    assert.deepEqual(card!.entries[0].badges, ["Verified"]);
    assert.deepEqual(card!.entries[1].badges, [
      "Ran (no state proof)",
      "Authorized by connected client",
    ]);
    assert.equal(card!.answerMaterial, "Attention in transformers");
  });

  it("closes the trace with the card, after the last stage", function () {
    const { items } = buildAgentTraceDisplayItems(effectEvents, null);
    const last = items[items.length - 1];

    assert.equal(last.type, "card_list");
    assert.equal(
      last.type === "card_list" ? last.cards[0].kind : "",
      "action_summary",
    );
  });

  it("states each receipt once however many events carry it", function () {
    const card = summaryCard(
      buildAgentTraceDisplayItems(
        [
          event(1, {
            type: "tool_result",
            callId: "call-note",
            name: "note_write",
            ok: true,
            actionReceipts: [receipt({ id: "note-1" })],
            content: {},
          }),
          event(2, {
            type: "codex_tool_activity",
            itemId: "item-1",
            phase: "completed",
            toolName: "note_write",
            actionReceipts: [receipt({ id: "note-1" })],
          }),
        ],
        null,
      ).items,
    );

    assert.equal(card?.actionCount, 1);
    assert.deepEqual(
      card?.entries.map((entry) => entry.effects.map((effect) => effect.label)),
      [["Created note"]],
    );
  });

  const readReceiptEvents: AgentRunEventRecord[] = [
    event(1, {
      type: "tool_result",
      callId: "call-read",
      name: "paper_read",
      ok: true,
      actionReceipts: [
        receipt({
          id: "read_full:fallback",
          capability: "zotero.read",
          operation: "read_full",
          status: "observed",
          requestedTargets: [],
          appliedTargets: [],
        }),
      ],
      content: {},
    }),
  ];

  it("does not call reading the paper an action the turn took", function () {
    assert.isUndefined(
      summaryCard(buildAgentTraceDisplayItems(readReceiptEvents, null).items),
      "a read-and-answer turn changed nothing and has nothing to summarize",
    );
  });

  it("leaves the DOM of a read-only turn without a card", function () {
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: { role: "assistant", text: "Here is the answer.", timestamp: 1 },
      events: readReceiptEvents,
    }) as unknown as FakeElement;

    assert.isNull(trace.findByClass("llm-agent-action-summary-card"));
  });

  it("states an observed effect that changed nothing it could read back", function () {
    const card = summaryCard(
      buildAgentTraceDisplayItems(
        [
          event(1, {
            type: "tool_result",
            callId: "call-command",
            name: "run_command",
            ok: true,
            actionReceipts: [
              receipt({
                id: "command_execute:fallback",
                capability: "command.execute",
                proofDomain: "execution",
                operation: "command_execute",
                verification: "execution_only",
                status: "observed",
                requestedTargets: [],
                appliedTargets: [],
              }),
            ],
            content: {},
          }),
        ],
        null,
      ).items,
    );

    assert.deepEqual(
      card?.entries.map((entry) => entry.effects.map((effect) => effect.label)),
      [["Ran command"]],
      "an executed effect states itself",
    );
    assert.deepEqual(
      card?.entries[0].targets,
      [],
      "and states no targets it re-read",
    );
    assert.deepEqual(card?.entries[0].badges, ["Ran (no state proof)"]);
  });

  it("shows no card when the run changed nothing", function () {
    const { items } = buildAgentTraceDisplayItems(
      [
        event(1, {
          type: "tool_result",
          callId: "call-read",
          name: "paper_read",
          ok: true,
          actionReceipts: [],
          content: {},
        }),
        event(2, {
          type: "tool_result",
          callId: "call-tags",
          name: "library_update",
          ok: false,
          actionReceipts: [
            receipt({
              id: "tags-failed",
              operation: "apply_tags",
              capability: "zotero.tags",
              status: "failed",
              verification: "unverified",
            }),
          ],
          content: {},
        }),
      ],
      null,
    );

    assert.isUndefined(summaryCard(items));
  });

  it("renders the card at the end of the trace DOM", function () {
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: { role: "assistant", text: "Saved.", timestamp: 1 },
      events: effectEvents,
    }) as unknown as FakeElement;

    const card = trace.findByClass("llm-agent-action-summary-card");
    assert.exists(card);
    assert.equal(
      card!.findByClass("llm-plan-title")!.textContent,
      "What this turn did",
    );
    const icon = card!.findByClass("llm-agent-action-summary-icon");
    assert.exists(icon, "the outcome heading starts with the action icon");
    assert.strictEqual(
      icon!.parentElement,
      card!.findByClass("llm-plan-title"),
    );
    assert.equal(icon!.getAttribute("aria-hidden"), "true");
    assert.equal(
      card!.findByClass("llm-plan-status")!.textContent,
      "2 actions",
    );
    const rows = card!.findAllByClass("llm-agent-action-summary-item");
    assert.lengthOf(rows, 2, "one row per target set");
    assert.exists(
      rows[0].findByClass("llm-paper-context-chip"),
      "the paper is the row's subject",
    );
    assert.exists(
      rows[0].findByClass("llm-note-context-chip"),
      "a note effect shows the note chip",
    );
    assert.isNull(
      rows[0].findByClass("llm-context-glyph-icon"),
      "a note effect has no glyph",
    );
    assert.equal(
      rows[1].findByClass("llm-context-glyph-icon")!.textContent,
      "+",
      "tagging shows the + glyph",
    );
    assert.deepEqual(
      rows[1]
        .findAllByClass("llm-tag-chip-title")
        .map((tag) => tag.textContent),
      ["attention", "transformers"],
    );
    assert.include(
      collectFakeText(card),
      "Authorized by connected client",
      "the connected client's authority stays visible",
    );
    assert.include(collectFakeText(card), "Attention in transformers");
  });

  it("places the action card in the supplied conversation footer after the answer", function () {
    const bubble = new FakeElement("div");
    const answer = new FakeElement("div");
    answer.textContent = "Here is the final answer.";
    const actionSummaryHost = new FakeElement("div");
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: { role: "assistant", text: answer.textContent, timestamp: 1 },
      events: effectEvents,
      actionSummaryHost: actionSummaryHost as unknown as HTMLElement,
    }) as unknown as FakeElement;
    bubble.append(trace, answer, actionSummaryHost);

    assert.isNull(trace.findByClass("llm-agent-action-summary-card"));
    assert.lengthOf(
      actionSummaryHost.findAllByClass("llm-agent-action-summary-card"),
      1,
    );
    assert.equal(bubble.children[2], actionSummaryHost);

    renderAgentTrace({
      doc: fakeDocument,
      message: { role: "assistant", text: answer.textContent, timestamp: 1 },
      events: readReceiptEvents,
      previous: trace as unknown as HTMLElement,
      actionSummaryHost: actionSummaryHost as unknown as HTMLElement,
    });
    assert.lengthOf(
      actionSummaryHost.children,
      0,
      "refresh removes an obsolete card",
    );
  });

  for (const useFooter of [true, false]) {
    it(`reveals the action card only after streaming ends (${useFooter ? "conversation footer" : "trace surface"})`, function () {
      const footer = useFooter ? new FakeElement("div") : undefined;
      const message = {
        role: "assistant" as const,
        text: "The answer is still arriving.",
        timestamp: 1,
        streaming: true,
      };
      const events = [...effectEvents];
      let trace: FakeElement | undefined;
      const refresh = () => {
        trace = renderAgentTrace({
          doc: fakeDocument,
          message,
          events,
          previous: trace as unknown as HTMLElement,
          actionSummaryHost: footer as unknown as HTMLElement,
        }) as unknown as FakeElement;
        return (footer || trace).findAllByClass(
          "llm-agent-action-summary-card",
        );
      };
      assert.isEmpty(
        refresh(),
        "completed actions do not interrupt the answer",
      );
      events.push(event(events.length + 1, { type: "final", text: "Done." }));
      assert.isEmpty(
        refresh(),
        "a final event cannot reveal a still-streaming answer's card",
      );
      message.text = "Done.";
      message.streaming = false;
      assert.lengthOf(refresh(), 1, "completion reveals exactly one card");
      message.streaming = true;
      events.push(
        event(events.length + 1, { type: "message_delta", text: "More." }),
      );
      assert.isEmpty(refresh(), "resumed streaming clears a retained card");
      events.push(
        event(events.length + 1, { type: "message_delta", text: " text." }),
      );
      assert.isEmpty(
        refresh(),
        "incremental text refreshes keep the card hidden",
      );
    });
  }

  it("opens the exact executed command as literal code and can fold it again", function () {
    const command = "printf '%s\\n' '<script> & ```'\n  printf 'second line'";
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: { role: "assistant", text: "Done.", timestamp: 1 },
      events: [
        event(1, {
          type: "tool_result",
          callId: "command",
          name: "run_command",
          ok: true,
          content: { command },
          actionReceipts: [
            receipt({
              id: "command",
              capability: "command.execute",
              proofDomain: "execution",
              operation: "command_execute",
              verification: "execution_only",
              status: "observed",
              requestedTargets: [],
              appliedTargets: [],
            }),
          ],
        }),
      ],
    }) as unknown as FakeElement;
    const card = trace.findByClass("llm-agent-action-summary-card")!;
    const row = card.findByClass("llm-agent-action-row");
    assert.exists(row, "the command row must be a disclosure");
    assert.equal(row!.tagName, "details");
    assert.equal(row!.children[0].tagName, "summary");
    assert.isFalse(row!.open);
    row!.open = true;
    row!.dispatchFakeEvent("toggle");
    const pre = row!.findByClass("llm-agent-action-command")!;
    assert.exists(pre);
    assert.equal(pre.tagName, "pre");
    assert.equal(pre.children[0].tagName, "code");
    assert.equal(pre.children[0].textContent, command);
    assert.equal(
      pre.children[0].innerHTML,
      "",
      "source is not parsed as markup",
    );
    row!.open = false;
    row!.dispatchFakeEvent("toggle");
    row!.open = true;
    row!.dispatchFakeEvent("toggle");
    assert.lengthOf(row!.findAllByClass("llm-agent-action-command"), 1);
  });

  it("names a glyph-less effect on the effect itself, with no empty verb node", function () {
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: { role: "assistant", text: "Saved.", timestamp: 1 },
      events: effectEvents,
    }) as unknown as FakeElement;

    const card = trace.findByClass("llm-agent-action-summary-card")!;
    const note = card.findAllByClass("llm-agent-action-effect")[0];
    assert.equal(
      note.getAttribute("title"),
      "Created note",
      "the operation's word is reachable even where it has no glyph to hang on",
    );
    assert.isNull(
      note.findByClass("llm-agent-action-verb"),
      "an empty verb node is a gap in the row with a tooltip nobody can reach",
    );
    const tagged = card.findAllByClass("llm-agent-action-effect")[1];
    assert.equal(tagged.getAttribute("title"), "Added tags");
    assert.equal(
      tagged.findByClass("llm-agent-action-verb")!.getAttribute("title"),
      "Added tags",
      "the glyph keeps the tooltip the reader points at",
    );
  });

  it("states an effect that named no object in words", function () {
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: { role: "assistant", text: "Filed.", timestamp: 1 },
      events: [
        event(1, {
          type: "tool_result",
          callId: "call-file",
          name: "library_update",
          ok: true,
          actionReceipts: [
            receipt({
              id: "file-1",
              capability: "zotero.collections",
              operation: "move_to_collection",
            }),
          ],
          content: {},
        }),
      ],
    }) as unknown as FakeElement;

    const effect = trace
      .findByClass("llm-agent-action-summary-card")!
      .findByClass("llm-agent-action-effect")!;
    const word = effect.findByClass("llm-agent-action-verb-word")!;
    assert.equal(
      word.textContent,
      "Moved to collection",
      "a glyph with nothing after it says nothing; the word is shown instead",
    );
    assert.include(word.className, "llm-agent-action-verb-word-inline");
    assert.include(collectFakeText(effect), "Moved to collection");
  });

  /** A stand-in library window, recording where the card sent the reader. */
  function navigationHost(
    pane: () => Record<string, unknown> | null,
  ): NavigationHost & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      pane: pane as NavigationHost["pane"],
      openNote: async () => {
        calls.push("note");
        return true;
      },
      revealFile: async () => {
        calls.push("file");
        return true;
      },
      focusMainWindow: () => calls.push("focus"),
    };
  }

  it("sends the reader to the paper a chip names", async function () {
    const host = navigationHost(() => ({
      selectItems: async (ids: number[]) => {
        host.calls.push(`items:${ids.join(",")}`);
        return true;
      },
    }));
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: { role: "assistant", text: "Saved.", timestamp: 1 },
      events: effectEvents,
      actionCardNavigation: host,
    }) as unknown as FakeElement;

    const card = trace.findByClass("llm-agent-action-summary-card")!;
    const chip = card.findByClass("llm-paper-context-chip")!;
    assert.include(chip.className, "llm-agent-action-link");
    const event = await card.dispatchFakeEventAsync("click", {
      target: chip.findByClass("llm-paper-context-chip-text")!,
    });

    assert.deepEqual(host.calls, ["items:41", "focus"]);
    assert.isTrue(
      event.propagationStopped,
      "clicking a chip inside a row does not fold the row",
    );
  });

  it("says in the card's pill when it could not open what a chip names", async function () {
    // The pane is there when the card is drawn and refuses the selection when
    // the reader clicks, the way an item deleted since the turn behaves.
    const host = navigationHost(() => ({ selectItems: async () => false }));
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: { role: "assistant", text: "Saved.", timestamp: 1 },
      events: effectEvents,
      actionCardNavigation: host,
    }) as unknown as FakeElement;

    const card = trace.findByClass("llm-agent-action-summary-card")!;
    const status = card.findByClass("llm-plan-status")!;
    await card.dispatchFakeEventAsync("click", {
      target: card.findByClass("llm-paper-context-chip")!,
    });

    assert.equal(status.textContent, "Item 41 is unavailable");
    assert.equal(status.dataset.status, "error");
  });

  it("says so when the collection a chip names is gone from the tree", async function () {
    const host = navigationHost(() => ({
      selectItems: async () => true,
      // The tree answers `false` for a row it no longer has, the way a
      // collection deleted since the turn behaves.
      collectionsView: { selectByID: async () => false },
    }));
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: { role: "assistant", text: "Filed.", timestamp: 1 },
      events: [
        event(1, {
          type: "tool_result",
          callId: "call-file",
          name: "library_update",
          ok: true,
          actionReceipts: [
            receipt({
              id: "file-1",
              capability: "zotero.collections",
              operation: "move_to_collection",
              normalizedParameters: {
                destinationCollectionId: 7,
                collectionName: "Reviews",
              },
            }),
          ],
          content: {},
        }),
      ],
      actionCardNavigation: host,
    }) as unknown as FakeElement;

    const card = trace.findByClass("llm-agent-action-summary-card")!;
    const chip = card.findByClass("llm-collection-context-chip")!;
    assert.include(chip.className, "llm-agent-action-link");
    await card.dispatchFakeEventAsync("click", { target: chip });

    const status = card.findByClass("llm-plan-status")!;
    assert.equal(status.textContent, "Reviews is unavailable");
    assert.equal(status.dataset.status, "error");
    assert.notInclude(host.calls, "focus", "the reader was taken nowhere");
  });

  it("does not draw a chip as a link when there is nowhere to send the reader", function () {
    const host = navigationHost(() => ({
      selectItems: async () => true,
      tagSelector: null,
    }));
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: { role: "assistant", text: "Saved.", timestamp: 1 },
      events: effectEvents,
      actionCardNavigation: host,
    }) as unknown as FakeElement;

    const card = trace.findByClass("llm-agent-action-summary-card")!;
    const tag = card.findByClass("llm-tag-context-chip")!;
    assert.notInclude(tag.className, "llm-agent-action-link");
    assert.isNull(tag.getAttribute("role"));
    assert.isNull(tag.getAttribute("tabindex"));
    assert.isNull(
      tag.findByClass("llm-citation-icon"),
      "a chip that opens nothing shows no jump glyph",
    );
    assert.isUndefined(
      tag.dataset.llmNav,
      "a chip that opens nothing claims no destination either",
    );
    assert.include(
      card.findByClass("llm-paper-context-chip")!.className,
      "llm-agent-action-link",
      "the papers the pane can still select stay links",
    );
  });

  it("turns the pill amber and adds a skip row when a target was rejected", function () {
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: { role: "assistant", text: "Moved.", timestamp: 1 },
      events: [
        event(1, {
          type: "tool_result",
          callId: "call-move",
          name: "library_update",
          ok: true,
          content: {},
          actionReceipts: [
            receipt({
              id: "move-1",
              operation: "move_to_collection",
              capability: "zotero.collections",
              status: "partial",
              verification: "verified",
              requestedTargets: ["item:1", "item:2"],
              appliedTargets: ["item:1"],
              rejectedTargets: ["item:2"],
              reasons: ["already in Reviews"],
              normalizedParameters: { collectionName: "Reviews" },
            }),
          ],
        }),
      ],
    }) as unknown as FakeElement;

    const card = trace.findByClass("llm-agent-action-summary-card")!;
    assert.equal(
      card.findByClass("llm-plan-status")!.dataset.status,
      "partial",
    );
    const row = card.findByClass("llm-agent-action-summary-item")!;
    assert.include(
      collectFakeText(row.findByClass("llm-at-row-skip")!),
      "Skipped Item 2 · already in Reviews",
      "the refusal is stated under the row that owns it",
    );
  });

  it("keeps the card outside the collapsed activity disclosure", function () {
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: { role: "assistant", text: "Saved.", timestamp: 1 },
      events: effectEvents,
    }) as unknown as FakeElement;

    const disclosure = trace.findByClass("llm-agent-activity-details");
    assert.exists(disclosure, "a finished run collapses its activity list");
    assert.isNull(
      disclosure!.findByClass("llm-agent-action-summary-card"),
      "the summary is not hidden behind the disclosure the reader must open",
    );
    assert.exists(trace.findByClass("llm-agent-action-summary-card"));
  });

  it("states the turn once across a re-render of the same trace", function () {
    const message = {
      role: "assistant",
      text: "Saved.",
      timestamp: 1,
    } as const;
    const first = renderAgentTrace({
      doc: fakeDocument,
      message,
      events: effectEvents,
    })!;
    const next = renderAgentTrace({
      doc: fakeDocument,
      message,
      events: effectEvents,
      previous: first,
    }) as unknown as FakeElement;

    assert.lengthOf(next.findAllByClass("llm-agent-action-summary-card"), 1);
  });
  it("marks a row partial when a receipt landed only part of what it asked", function () {
    const card = summaryCard(
      buildAgentTraceDisplayItems(
        [
          event(1, {
            type: "tool_result",
            callId: "call-tags",
            name: "library_update",
            ok: true,
            actionReceipts: [
              receipt({
                id: "tags-partial",
                capability: "zotero.tags",
                operation: "apply_tags",
                status: "partial",
                requestedTargets: ["item:41", "item:42"],
                appliedTargets: ["item:41"],
                normalizedParameters: { tags: ["attention"] },
              }),
            ],
            content: {},
          }),
        ],
        null,
      ).items,
    );

    assert.isTrue(
      card?.entries[0].partial,
      "a partial receipt states the row did less than it asked, with nothing refused",
    );
  });

  it("turns the pill amber when a receipt landed only part of what it asked", function () {
    const trace = renderAgentTrace({
      doc: fakeDocument,
      message: { role: "assistant", text: "Tagged.", timestamp: 1 },
      events: [
        event(1, {
          type: "tool_result",
          callId: "call-tags",
          name: "library_update",
          ok: true,
          actionReceipts: [
            receipt({
              id: "tags-partial",
              capability: "zotero.tags",
              operation: "apply_tags",
              status: "partial",
              requestedTargets: ["item:41", "item:42"],
              appliedTargets: ["item:41"],
              normalizedParameters: { tags: ["attention"] },
            }),
          ],
          content: {},
        }),
      ],
    }) as unknown as FakeElement;

    assert.equal(
      trace
        .findByClass("llm-agent-action-summary-card")!
        .findByClass("llm-plan-status")!.dataset.status,
      "partial",
    );
  });
});

describe("end-of-turn card precedence", function () {
  const savedNote: AgentSavedNoteResultCard = {
    kind: "saved_note",
    actionId: "note-create-1",
    title: "Attention in transformers",
    destination: "Zotero",
    bodyHtml: "<h1>Attention in transformers</h1><p>What the note says.</p>",
    note: { itemId: 99, libraryID: 1, key: "N99" },
  };

  const noteChange: AgentNoteChangeResultCard = {
    kind: "note_change",
    actionId: "note-edit-1",
    title: "Attention in transformers",
    description: "Rewrote the discussion section.",
    note: { itemId: 99, libraryID: 1, key: "N99" },
    conversationKey: 5,
    state: "applied",
    afterVerified: true,
    before: { checksum: "sha256:before", recoveryId: "before" } as never,
    after: { checksum: "sha256:after", recoveryId: "after" } as never,
  };

  function event(
    seq: number,
    payload: AgentRunEventRecord["payload"],
  ): AgentRunEventRecord {
    return {
      runId: "run-precedence",
      seq,
      eventType: payload.type,
      payload,
      createdAt: seq,
    };
  }

  type TestReceipt = Extract<
    AgentRunEventRecord["payload"],
    { type: "tool_result" }
  >["actionReceipts"][number];

  /** What a note write journals: the note the read-back proved it landed on. */
  function noteReceipt(operation: string, noteId: number): TestReceipt {
    return {
      version: 2,
      id: `${operation}:${noteId}`,
      proposalId: `${operation}:${noteId}`,
      proofDomain: "zotero_state",
      capability: "zotero.notes",
      operation,
      verification: "verified",
      status: "applied",
      requestedTargets: ["item:41"],
      appliedTargets: ["item:41"],
      alreadySatisfiedTargets: [],
      rejectedTargets: [],
      reasons: [],
      verifiedFacts: [`native_note:${noteId}:text_match`],
    } as unknown as TestReceipt;
  }

  /** The note write, with the receipt that claims the note it wrote. */
  function noteWriteEvents(receipts: TestReceipt[]): AgentRunEventRecord[] {
    return [
      event(1, {
        type: "tool_call",
        callId: "w1",
        name: "note_write",
        args: { noteId: 99 },
        toolLabel: "Note Write",
        workCategory: "zotero_action",
      }),
      event(2, {
        type: "tool_result",
        callId: "w1",
        name: "note_write",
        ok: true,
        actionReceipts: receipts,
        content: { noteId: 99 },
        toolLabel: "Note Write",
        workCategory: "zotero_action",
      }),
    ];
  }

  const savedNoteEventsWithReceipt = () =>
    noteWriteEvents([noteReceipt("note_create", 99)]);
  const noteChangeEventsWithReceipt = () =>
    noteWriteEvents([noteReceipt("note_edit", 99)]);
  const savedNoteEventsWithoutReceipt = () => noteWriteEvents([]);

  /** A second effect, on another paper, so the turn did more than the note. */
  function tagReceiptEvent(itemId: number): AgentRunEventRecord {
    return event(3, {
      type: "tool_result",
      callId: "t1",
      name: "library_update",
      ok: true,
      actionReceipts: [
        {
          version: 2,
          id: "tags-1",
          proposalId: "tags-1",
          proofDomain: "zotero_state",
          capability: "zotero.tags",
          operation: "apply_tags",
          verification: "verified",
          status: "applied",
          requestedTargets: [`item:${itemId}`],
          appliedTargets: [`item:${itemId}`],
          alreadySatisfiedTargets: [],
          rejectedTargets: [],
          reasons: [],
          verifiedFacts: [],
          normalizedParameters: { tags: ["attention"] },
        } as unknown as TestReceipt,
      ],
      content: {},
    });
  }

  /** The turn that finalized a document the trace offers to open. */
  const planDocumentEvents = (): AgentRunEventRecord[] => [
    event(1, {
      type: "material_finalized",
      callId: "submit-1",
      materialRef: {
        documentId: "run-precedence:document:1",
        documentVersion: 1,
        contentHash: "sha256:material",
      },
      materialKind: "guide",
      materialTitle: "Attention in transformers",
    }),
  ];

  /** The assistant turn the trace belongs to, as the panel holds it. */
  const turnMessage = (text: string) => ({
    role: "assistant" as const,
    text,
    timestamp: 1,
    runMode: "agent" as const,
    agentRunId: "run-precedence",
    streaming: false,
  });

  function renderTurn(params: {
    cards: (AgentSavedNoteResultCard | AgentNoteChangeResultCard)[];
    events: AgentRunEventRecord[];
    message: ReturnType<typeof turnMessage>;
    previous?: FakeElement;
  }): FakeElement {
    const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };
    const originalZotero = globalScope.Zotero;
    globalScope.Zotero = {
      ...((originalZotero as Record<string, unknown>) || {}),
      Libraries: { userLibraryID: 1, get: () => undefined },
    };
    try {
      return withToolPresentationsReturning(
        {
          note_write: {
            label: "Note Write",
            summaries: { onSuccess: "Note saved" },
            buildResultCards: () => params.cards,
          },
        },
        () =>
          renderAgentTrace({
            doc: noteDocument,
            message: params.message,
            events: params.events,
            previous: params.previous as unknown as HTMLElement | undefined,
          }) as unknown as FakeElement,
      );
    } finally {
      globalScope.Zotero = originalZotero;
    }
  }

  it("shows a lone new note as the note mode of the action card, once", function () {
    const trace = renderTurn({
      cards: [savedNote],
      events: savedNoteEventsWithReceipt(),
      message: turnMessage("Saved."),
    });
    const cards = trace.findAllByClass("llm-agent-action-summary-card");

    assert.lengthOf(cards, 1);
    assert.equal(cards[0].dataset.mode, "note");
    assert.include(cards[0].className, "llm-saved-note-card");
    assert.equal(
      cards[0].findByClass("llm-plan-title")!.textContent,
      "Attention in transformers",
    );
    assert.equal(cards[0].findByClass("llm-plan-status")!.textContent, "Saved");
    assert.isTrue(
      cards[0].findByClass("llm-agent-action-row")!.open,
      "the note the reader came for is open",
    );
    assert.include(
      collectFakeText(cards[0].findByClass("llm-note-preview")),
      "What the note says.",
    );
    assert.lengthOf(
      trace.findAllByClass("llm-saved-note-destination"),
      0,
      "the standalone saved-note card is not rendered again",
    );
    disposeAgentTrace(trace as unknown as HTMLElement);
  });

  it("shows a lone note edit as note mode with the diff and Undo", function () {
    const trace = renderTurn({
      cards: [noteChange],
      events: noteChangeEventsWithReceipt(),
      message: turnMessage("Updated."),
    });
    const card = trace.findByClass("llm-agent-action-summary-card")!;

    assert.equal(card.dataset.mode, "note");
    assert.include(card.className, "llm-note-change-card");
    assert.equal(
      card.findByClass("llm-plan-title")!.textContent,
      "Changed ‘Attention in transformers’",
    );
    assert.equal(card.findByClass("llm-plan-status")!.textContent, "Applied");
    assert.deepEqual(
      card.findAllByClass("llm-plan-action").map((b) => b.textContent),
      ["Open note", "Undo"],
    );
    assert.lengthOf(
      trace.findAllByClass("llm-note-review-card"),
      0,
      "the standalone note-change card is not rendered again",
    );
    disposeAgentTrace(trace as unknown as HTMLElement);
  });

  it("folds a note into the action card when other receipts exist", function () {
    const trace = renderTurn({
      cards: [noteChange],
      events: [...noteChangeEventsWithReceipt(), tagReceiptEvent(5)],
      message: turnMessage("Done."),
    });
    const card = trace.findByClass("llm-agent-action-summary-card")!;

    assert.equal(card.dataset.mode, "action");
    assert.equal(card.findByClass("llm-plan-status")!.textContent, "2 actions");
    const row = card.findByClass("llm-agent-action-row")!;
    assert.isFalse(row.open, "the note row starts collapsed");
    assert.lengthOf(
      collectFakeText(row).match(/Undo/g) || [],
      0,
      "a collapsed row does no work until the reader opens it",
    );
    assert.lengthOf(trace.findAllByClass("llm-note-review-card"), 0);
    row.open = true;
    row.dispatchFakeEvent("toggle");
    assert.deepEqual(
      row.findAllByClass("llm-plan-action").map((b) => b.textContent),
      ["Open note", "Undo"],
      "opening the row renders the note it wrote",
    );
    disposeAgentTrace(trace as unknown as HTMLElement);
  });

  it("folds in the note of a write that could not read the note back", function () {
    // The receipt proved nothing about which note it wrote, so the row names a
    // note without an id. One row and one card are left, and they are the same
    // write.
    const blindReceipt = {
      ...(noteReceipt("note_create", 99) as unknown as Record<string, unknown>),
      verifiedFacts: [],
    } as unknown as TestReceipt;
    const trace = renderTurn({
      cards: [savedNote],
      events: noteWriteEvents([blindReceipt]),
      message: turnMessage("Saved."),
    });
    const cards = trace.findAllByClass("llm-agent-action-summary-card");

    assert.lengthOf(cards, 1);
    assert.equal(cards[0].dataset.mode, "note");
    assert.include(
      collectFakeText(cards[0].findByClass("llm-note-preview")),
      "What the note says.",
      "the note the row could not name is still the note it opens",
    );
    assert.lengthOf(
      trace.findAllByClass("llm-saved-note-destination"),
      0,
      "the standalone saved-note card is not rendered beside it",
    );
    disposeAgentTrace(trace as unknown as HTMLElement);
  });

  it("shows the last thing that happened to a note, not both", function () {
    // The run saved the note and then edited it. Both cards name the same
    // action, and the change is what the note ended up as.
    const trace = renderTurn({
      cards: [
        { ...savedNote, actionId: "note-1" },
        { ...noteChange, actionId: "note-1" },
      ],
      events: noteChangeEventsWithReceipt(),
      message: turnMessage("Updated."),
    });
    const cards = trace.findAllByClass("llm-agent-action-summary-card");

    assert.lengthOf(cards, 1);
    assert.equal(
      cards[0].findByClass("llm-plan-title")!.textContent,
      "Changed \u2018Attention in transformers\u2019",
    );
    assert.lengthOf(trace.findAllByClass("llm-note-review-card"), 0);
    assert.lengthOf(trace.findAllByClass("llm-saved-note-destination"), 0);
    disposeAgentTrace(trace as unknown as HTMLElement);
  });

  it("keeps rendering a note card that no receipt claims", function () {
    const trace = renderTurn({
      cards: [savedNote],
      events: savedNoteEventsWithoutReceipt(),
      message: turnMessage("Saved."),
    });

    assert.lengthOf(trace.findAllByClass("llm-saved-note-card"), 1);
    assert.lengthOf(trace.findAllByClass("llm-saved-note-destination"), 1);
    assert.isNull(trace.findByClass("llm-agent-action-summary-card"));
    disposeAgentTrace(trace as unknown as HTMLElement);
  });

  it("places the action card after the plan and document cards", function () {
    const message = turnMessage("Done.");
    const events = [...planDocumentEvents(), tagReceiptEvent(5)];
    const cardOrder = (trace: FakeElement) => {
      const order = trace.children.map((child) => child.className);
      return {
        document: order.findIndex((name) =>
          name.includes("llm-plan-document-card"),
        ),
        action: order.findIndex((name) =>
          name.includes("llm-agent-action-summary-card"),
        ),
      };
    };
    const trace = renderTurn({ cards: [], events, message });
    const first = cardOrder(trace);

    assert.isAtLeast(first.document, 0, "the document card is rendered");
    assert.isAtLeast(first.action, 0, "the action card is rendered");
    assert.isBelow(first.document, first.action);

    // A re-render keeps the document card and rebuilds the action card, so the
    // reader must not end up with two of them, or with them the other way up.
    const again = renderTurn({ cards: [], events, message, previous: trace });
    const second = cardOrder(again);

    assert.lengthOf(again.findAllByClass("llm-agent-action-summary-card"), 1);
    assert.lengthOf(again.findAllByClass("llm-plan-document-card"), 1);
    assert.isBelow(second.document, second.action);
    disposeAgentTrace(again as unknown as HTMLElement);
  });
});

describe("action card note detail", function () {
  const savedNote: AgentSavedNoteResultCard = {
    kind: "saved_note",
    actionId: "a1",
    title: "Summary",
    destination: "My Library › Paper",
    bodyHtml: "<h1>Summary</h1><p>Body.</p>",
    note: { itemId: 99, libraryID: 1, key: "N99" },
  };
  const entry: ActionCardEntry = {
    targets: [{ kind: "item", itemId: 11, label: "Smith, 2021" }],
    effects: [
      {
        receiptId: "n",
        operation: "note_create",
        verb: { word: "wrote" },
        label: "Created note",
        objects: [{ kind: "note", label: "Summary", noteId: 99 }],
      },
    ],
    verification: "verified",
    badges: ["Verified"],
    rejected: [],
    detail: { kind: "saved_note", card: savedNote },
  };

  it("renders a created note's preview and an Open note action", function () {
    const status = noteDocument.createElement("span");
    const detail = renderActionCardDetail(
      noteDocument,
      entry,
      status,
    ) as unknown as FakeElement;
    assert.exists(detail.findByClass("llm-note-preview"));
    assert.include(
      collectFakeText(detail.findByClass("llm-note-preview")!),
      "Body.",
    );
    assert.deepEqual(
      detail.findAllByClass("llm-plan-action").map((b) => b.textContent),
      ["Open note"],
    );
  });

  it("renders an edited note's diff container, Open note and Undo", function () {
    const change: AgentNoteChangeResultCard = {
      kind: "note_change",
      title: "Reading notes",
      description: "The note was updated and verified in Zotero.",
      note: { itemId: 99, libraryID: 1, key: "N99" },
      conversationKey: 1,
      actionId: "a2",
      state: "applied",
      before: { checksum: "b" } as never,
      after: { checksum: "a" } as never,
    };
    const status = noteDocument.createElement("span");
    const detail = renderActionCardDetail(
      noteDocument,
      { ...entry, detail: { kind: "note_change", card: change } },
      status,
    ) as unknown as FakeElement;
    assert.equal(
      detail.findByClass("llm-note-review-description")!.textContent,
      change.description,
    );
    assert.deepEqual(
      detail.findAllByClass("llm-plan-action").map((b) => b.textContent),
      ["Open note", "Undo"],
    );
    assert.isFalse(
      detail.findAllByClass("llm-plan-action")[1].disabled,
      "an applied change keeps the control that reverses it",
    );
    assert.exists(
      detail.findByClass("llm-agent-action-diff"),
      "the diff loads asynchronously into a container the row already holds",
    );
  });

  it("returns null for a row without a note detail", function () {
    assert.isNull(
      renderActionCardDetail(
        noteDocument,
        { ...entry, detail: undefined },
        noteDocument.createElement("span"),
      ),
    );
  });
});

describe("action card row detail wiring", function () {
  const savedNote: AgentSavedNoteResultCard = {
    kind: "saved_note",
    actionId: "a1",
    title: "Summary",
    destination: "My Library › Paper",
    bodyHtml: "<h1>Summary</h1><p>Body.</p>",
    note: { itemId: 99, libraryID: 1, key: "N99" },
  };

  const card: AgentActionSummaryResultCard = {
    kind: "action_summary",
    actionCount: 1,
    entries: [
      {
        targets: [{ kind: "item", itemId: 11, label: "Smith, 2021" }],
        effects: [
          {
            receiptId: "n",
            operation: "note_create",
            verb: {},
            label: "Created note",
            objects: [{ kind: "note", label: "Summary", noteId: 99 }],
          },
        ],
        verification: "verified",
        badges: ["Verified"],
        rejected: [],
        detail: { kind: "saved_note", card: savedNote },
      },
    ],
  };

  /** Render the card, recording every `status` element a row detail was given. */
  function renderWithSpy(mode: "action" | "note") {
    const given: FakeElement[] = [];
    const node = renderActionSummaryCard(noteDocument, card, {
      mode,
      ...(mode === "note"
        ? {
            header: {
              title: "Summary",
              status: "Saved",
              statusKind: "completed",
              extraClass: "llm-saved-note-card",
            },
          }
        : {}),
      renderDetail: (doc, _entry, status) => {
        given.push(status as unknown as FakeElement);
        const body = doc.createElement("div");
        body.className = "llm-spy-detail";
        return body;
      },
    }) as unknown as FakeElement;
    return { node, given };
  }

  it("builds a folded row's body once, when the reader opens it", function () {
    const { node, given } = renderWithSpy("action");
    const row = node.findByClass("llm-agent-action-row")!;

    assert.lengthOf(given, 0, "a folded row does no work until it is opened");
    assert.isNull(node.findByClass("llm-spy-detail"));

    row.dispatchFakeEvent("toggle");
    assert.lengthOf(given, 0, "a toggle that closed the row builds nothing");

    row.open = true;
    row.dispatchFakeEvent("toggle");
    assert.lengthOf(given, 1);
    assert.exists(node.findByClass("llm-spy-detail"));

    row.dispatchFakeEvent("toggle");
    assert.lengthOf(given, 1, "the body is built once, not once per toggle");
    assert.lengthOf(node.findAllByClass("llm-spy-detail"), 1);
  });

  it("gives a folded row a pill of its own, not the card's", function () {
    const { node, given } = renderWithSpy("action");
    const row = node.findByClass("llm-agent-action-row")!;
    row.open = true;
    row.dispatchFakeEvent("toggle");
    const status = given[0];
    const body = node.findByClass("llm-agent-action-row-body")!;
    const headerPill = node
      .findByClass("llm-plan-header")!
      .findByClass("llm-plan-status")!;

    assert.equal(status.tagName, "span");
    assert.equal(status.className, "llm-plan-status");
    assert.equal(status.textContent, "");
    assert.strictEqual(
      body.children[0],
      status,
      "the row's pill is the first thing in the body it belongs to",
    );
    assert.notStrictEqual(
      status,
      headerPill,
      "a row's failure must not overwrite what the card says about the turn",
    );
  });

  it("gives the note mode's only row the card's own pill, at once", function () {
    const { node, given } = renderWithSpy("note");
    assert.isNull(node.findByClass("llm-agent-action-summary-icon"));
    const headerPill = node
      .findByClass("llm-plan-header")!
      .findByClass("llm-plan-status")!;

    assert.lengthOf(given, 1, "the note is rendered without being asked for");
    assert.strictEqual(given[0], headerPill);
    assert.equal(headerPill.textContent, "Saved");
    assert.isTrue(node.findByClass("llm-agent-action-row")!.open);
    assert.exists(node.findByClass("llm-spy-detail"));
  });
});
