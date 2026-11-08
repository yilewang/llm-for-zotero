import { assert } from "chai";
import {
  CONTENT_FLAT_SCOPE_CLASS,
  CONTENT_STANDALONE_SCOPE_CLASS,
  markStandaloneFlatScope,
} from "../src/modules/contextPanel/contentChrome";
import {
  attachFlatCodeBlockChrome,
  attachFlatMathChrome,
  attachFlatPreviewChrome,
  normalizeMermaidSourceForTheme,
  remapMermaidLightFillsForDark,
} from "../src/modules/contextPanel/renderedMarkdown";
import { createGeneratedImageFrame } from "../src/modules/contextPanel/generatedImageRender";
import {
  registerSidePanelItemHost,
  unregisterSidePanelItemHost,
} from "../src/modules/contextPanel/sidePanelItems";
import { FakeElement, fakeDocument } from "./helpers/fakeDom";

const asRoot = (el: FakeElement) => el as unknown as ParentNode;
const asEl = (el: FakeElement) => el as unknown as HTMLElement;

/** A side panel tab body: the flat scope plus the standalone marker. */
function tabBox(): FakeElement {
  const box = new FakeElement("div");
  box.className = "llm-standalone-side-panel-item-rendered";
  markStandaloneFlatScope(asEl(box));
  return box;
}

function codeBlock(box: FakeElement, lines: number) {
  const copyable = new FakeElement("div");
  copyable.className = "llm-copyable llm-copyable-code";
  copyable.dataset.llmCopySource = "```python\nprint(1)\n```";
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
  header.append(wrap, copy);
  const body = new FakeElement("div");
  body.className = "llm-codeblock-body";
  body.textContent = Array.from({ length: lines }, (_, i) => `l${i}`).join(
    "\n",
  );
  shell.append(header, body);
  copyable.appendChild(shell);
  box.appendChild(copyable);
  return { copyable, shell, wrap, copy };
}

const barOf = (block: FakeElement) =>
  block.children.find((c) => c.classList.contains("llm-content-bar"));

describe("flat style on a standalone reading surface", function () {
  it("marks a surface with both scope classes", function () {
    const box = tabBox();
    assert.isTrue(box.classList.contains(CONTENT_FLAT_SCOPE_CLASS));
    assert.isTrue(box.classList.contains(CONTENT_STANDALONE_SCOPE_CLASS));
  });

  it("gives a code tab a bar with wrap and copy, and never folds it", function () {
    const box = tabBox();
    const { copyable, shell, wrap, copy } = codeBlock(box, 60);
    attachFlatCodeBlockChrome(asRoot(box), fakeDocument);
    assert.deepEqual(barOf(copyable)?.children, [wrap, copy]);
    assert.isUndefined(
      copyable.children.find((c) =>
        c.classList.contains("llm-content-fold-btn"),
      ),
    );
    assert.isUndefined(shell.dataset.fold);
    assert.isTrue(shell.classList.contains("llm-codeblock-plain"));
  });

  it("folds the same long block in a chat answer", function () {
    const answer = new FakeElement("div");
    answer.className = CONTENT_FLAT_SCOPE_CLASS;
    const { copyable, shell } = codeBlock(answer, 60);
    attachFlatCodeBlockChrome(asRoot(answer), fakeDocument);
    assert.equal(shell.dataset.fold, "folded");
    assert.exists(
      copyable.children.find((c) =>
        c.classList.contains("llm-content-fold-btn"),
      ),
    );
  });

  it("copies by itself outside the chat box and stops the click", async function () {
    const copied: string[] = [];
    const globals = globalThis as unknown as Record<string, unknown>;
    const previous = globals.Components;
    globals.Components = {
      classes: {
        "@mozilla.org/widget/clipboardhelper;1": {
          getService: () => ({ copyString: (v: string) => copied.push(v) }),
        },
      },
      interfaces: { nsIClipboardHelper: {} },
    };
    try {
      const box = tabBox();
      const { copyable, copy } = codeBlock(box, 3);
      attachFlatCodeBlockChrome(asRoot(box), fakeDocument);
      const event = copy.dispatchFakeEvent("click");
      assert.isTrue(event.defaultPrevented);
      assert.equal(copyable.attributes["data-copy-feedback"], "copied");
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(copied, ["```python\nprint(1)\n```"]);
    } finally {
      globals.Components = previous;
    }
  });

  it("leaves copy to the chat's click handler in an answer", function () {
    const answer = new FakeElement("div");
    answer.className = CONTENT_FLAT_SCOPE_CLASS;
    const { copy } = codeBlock(answer, 3);
    attachFlatCodeBlockChrome(asRoot(answer), fakeDocument);
    const event = copy.dispatchFakeEvent("click");
    assert.isFalse(Boolean(event.defaultPrevented));
  });

  it("binds copy for an equation tab too", function () {
    const box = tabBox();
    const block = new FakeElement("div");
    block.className = "llm-copyable llm-copyable-math";
    block.dataset.llmCopySource = "$$x$$";
    const copy = new FakeElement("button");
    copy.className = "llm-render-copy-btn";
    block.appendChild(copy);
    box.appendChild(block);
    attachFlatMathChrome(asRoot(box), fakeDocument);
    assert.strictEqual(barOf(block)?.children[0], copy);
    assert.equal(copy.dataset.standaloneCopyBound, "true");
  });

  function previewBlock(box: FakeElement) {
    const copyable = new FakeElement("div");
    copyable.className = "llm-copyable llm-copyable-code";
    const shell = new FakeElement("div");
    shell.className = "llm-codeblock-shell";
    const header = new FakeElement("div");
    header.className = "llm-codeblock-header";
    const toggle = new FakeElement("button");
    toggle.className = "llm-codeblock-source-toggle";
    const copy = new FakeElement("button");
    copy.className = "llm-render-copy-btn llm-render-code-copy-btn";
    header.append(toggle, copy);
    const preview = new FakeElement("div");
    preview.className = "llm-mermaid-preview";
    preview.dataset.llmMermaidSource = "graph TD; A-->B";
    const body = new FakeElement("div");
    body.className = "llm-codeblock-body";
    shell.append(header, preview, body);
    copyable.appendChild(shell);
    box.appendChild(copyable);
    return { copyable };
  }

  it("has no Move to side panel button on a diagram tab, even with a host", function () {
    const host = { open: () => undefined };
    registerSidePanelItemHost(fakeDocument, host);
    try {
      const box = tabBox();
      const { copyable } = previewBlock(box);
      attachFlatPreviewChrome(asRoot(box), fakeDocument);
      assert.deepEqual(
        barOf(copyable)?.children.map((b) => b.attributes["aria-label"]),
        ["Show code", "Copy code", "Save as image", "Open full view"],
      );
      const answer = new FakeElement("div");
      answer.className = CONTENT_FLAT_SCOPE_CLASS;
      const chat = previewBlock(answer);
      attachFlatPreviewChrome(asRoot(answer), fakeDocument);
      assert.include(
        barOf(chat.copyable)?.children.map((b) => b.attributes["aria-label"]),
        "Move to side panel",
      );
    } finally {
      unregisterSidePanelItemHost(fakeDocument, host);
    }
  });

  it("puts Open full view in the figure tab bar although a click does not open it", function () {
    const box = tabBox();
    const frame = createGeneratedImageFrame(
      asEl(box),
      { id: "p", label: "A cat", path: "/tmp/cat.png" },
      fakeDocument,
      {
        flatChrome: true,
        zoomOnClick: false,
        fullViewInBar: true,
        allowMoveToSidePanel: false,
      },
    ) as unknown as FakeElement;
    const labels = barOf(frame)?.children.map(
      (b) => b.attributes["aria-label"],
    );
    assert.include(labels, "Open full view");
    assert.notInclude(labels, "Move to side panel");
  });
});

describe("dark theme Mermaid fills", function () {
  it("turns a light pastel fill into a dark tint of the same hue", function () {
    const out = remapMermaidLightFillsForDark(
      "flowchart TD\n  A-->B\n  classDef pink fill:#ffd6e0,stroke:#333,color:#000;\n  class A pink",
    );
    const line = out.split("\n").find((l) => l.includes("classDef")) || "";
    const fill = line.match(/fill:(#[0-9a-f]{6})/)?.[1] || "";
    const r = parseInt(fill.slice(1, 3), 16);
    const g = parseInt(fill.slice(3, 5), 16);
    assert.isBelow(r, 90);
    assert.isAbove(r, g, "keeps the rose hue");
    assert.match(line, /stroke:#[0-9a-f]{6}/);
    assert.notInclude(line, "stroke:#333");
    assert.include(line, "color:#e6e6e6");
    assert.isTrue(line.endsWith(";"));
    assert.include(out, "class A pink");
  });

  it("handles style lines, adds light text and keeps other properties", function () {
    const out = remapMermaidLightFillsForDark(
      "graph LR\n  style B fill:#fff9c4,stroke-width:2px\n",
    );
    assert.match(out, /style B fill:#[0-9a-f]{6},stroke-width:2px/);
    assert.include(out, "color:#e6e6e6");
    assert.match(out, /stroke:#[0-9a-f]{6}/);
  });

  it("leaves dark fills, no-fill lines and chart text alone", function () {
    const source =
      "graph TD\n  classDef dark fill:#1e293b,stroke:#94a3b8,color:#f8fafc\n  classDef keep stroke:#f00\n  A[fill:#ffffff in a label]-->B";
    assert.equal(remapMermaidLightFillsForDark(source), source);
  });

  it("keeps a deliberate coloured outline and an existing light text colour", function () {
    const out = remapMermaidLightFillsForDark(
      "classDef x fill:#e0f2fe,stroke:#0284c7,color:#f1f5f9",
    );
    assert.include(out, "stroke:#0284c7");
    assert.include(out, "color:#f1f5f9");
  });

  it("applies only in the dark theme", function () {
    const source =
      "graph TD\n  classDef pink fill:#ffd6e0,stroke:#333,color:#000";
    assert.include(normalizeMermaidSourceForTheme(source, "light"), "#ffd6e0");
    assert.notInclude(
      normalizeMermaidSourceForTheme(source, "dark"),
      "#ffd6e0",
    );
  });
});
