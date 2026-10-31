import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTENT_FLAT_SCOPE_CLASS,
  CONTENT_STANDALONE_SCOPE_CLASS,
  CONTENT_TAB_ZOOM_ATTRIBUTE,
  copyFlatContentScope,
  isInTabZoomScope,
  markStandaloneFlatScope,
} from "../src/modules/contextPanel/contentChrome";
import { mountDiagramTabZoom } from "../src/modules/contextPanel/figureViewer";
import { renderPlanDocumentFigures } from "../src/modules/contextPanel/planDocumentPresentation";
import {
  disposeStreamingMarkdown,
  renderStreamingMarkdownInto,
} from "../src/modules/contextPanel/streamingMarkdown";
import type { PlanDocument } from "../src/agent/documents/types";
import { FakeElement, fakeDocument } from "./helpers/fakeDom";

const here = dirname(fileURLToPath(import.meta.url));
const asEl = (el: FakeElement) => el as unknown as HTMLElement;
const read = (path: string) => readFileSync(resolve(here, "..", path), "utf8");

class StreamingElement extends FakeElement {
  get isConnected() {
    return true;
  }
  replaceWith(...elements: StreamingElement[]) {
    const parent = this.parentElement;
    if (!parent) return;
    for (const element of elements) parent.insertBefore(element, this);
    parent.removeChild(this);
  }
}

describe("copyFlatContentScope", function () {
  it("copies the flat class, and the standalone class when present", function () {
    const chat = new FakeElement("div");
    chat.className = CONTENT_FLAT_SCOPE_CLASS;
    const standalone = new FakeElement("div");
    markStandaloneFlatScope(asEl(standalone));
    const plain = new FakeElement("div");

    const a = new FakeElement("div");
    copyFlatContentScope(asEl(chat), asEl(a));
    assert.isTrue(a.classList.contains(CONTENT_FLAT_SCOPE_CLASS));
    assert.isFalse(a.classList.contains(CONTENT_STANDALONE_SCOPE_CLASS));

    const b = new FakeElement("div");
    const inner = new FakeElement("div");
    standalone.appendChild(inner);
    copyFlatContentScope(asEl(inner), asEl(b));
    assert.isTrue(b.classList.contains(CONTENT_FLAT_SCOPE_CLASS));
    assert.isTrue(b.classList.contains(CONTENT_STANDALONE_SCOPE_CLASS));

    const c = new FakeElement("div");
    copyFlatContentScope(asEl(plain), asEl(c));
    assert.isFalse(c.classList.contains(CONTENT_FLAT_SCOPE_CLASS));
  });
});

describe("streaming answer blocks", function () {
  const targets: HTMLElement[] = [];
  afterEach(function () {
    for (const target of targets.splice(0)) disposeStreamingMarkdown(target);
  });

  function stream(targetClass: string) {
    const created: StreamingElement[] = [];
    const frames = new Map<number, FrameRequestCallback>();
    let handle = 0;
    const doc = {
      createElement: (tag: string) => {
        const el = new StreamingElement(tag);
        created.push(el);
        return el;
      },
      querySelectorAll: () => [],
      defaultView: {
        performance: { now: () => 0 },
        requestAnimationFrame: (cb: FrameRequestCallback) => {
          frames.set(++handle, cb);
          return handle;
        },
        cancelAnimationFrame: (id: number) => frames.delete(id),
        setTimeout: () => ++handle,
        clearTimeout: () => undefined,
      },
    } as unknown as Document;
    const target = new StreamingElement("div");
    target.className = targetClass;
    targets.push(asEl(target));
    renderStreamingMarkdownInto(
      asEl(target),
      "First block\n\nSecond block\n\nTail",
      doc,
      () => undefined,
    );
    for (const cb of [...frames.values()]) cb(0);
    return created.filter((el) => el.style.display === "contents");
  }

  it("gives each settled block the answer's flat scope before it renders", function () {
    const blocks = stream(CONTENT_FLAT_SCOPE_CLASS);
    assert.isAtLeast(blocks.length, 1);
    for (const block of blocks) {
      assert.isTrue(block.classList.contains(CONTENT_FLAT_SCOPE_CLASS));
      assert.isFalse(block.classList.contains(CONTENT_STANDALONE_SCOPE_CLASS));
    }
  });

  it("copies the standalone class too, and leaves other targets alone", function () {
    const standalone = stream(
      `${CONTENT_FLAT_SCOPE_CLASS} ${CONTENT_STANDALONE_SCOPE_CLASS}`,
    );
    for (const block of standalone) {
      assert.isTrue(block.classList.contains(CONTENT_STANDALONE_SCOPE_CLASS));
    }
    for (const block of stream("llm-agent-inline-text")) {
      assert.isFalse(block.classList.contains(CONTENT_FLAT_SCOPE_CLASS));
    }
  });
});

describe("quote bodies and citation text", function () {
  it("copy the answer's flat scope onto the container they render in", function () {
    // The lazily rendered card body's renderer is shared with Task progress.
    const source =
      read("src/modules/contextPanel/assistantCitationLinks.ts") +
      read("src/modules/contextPanel/quoteCardMarkdown.ts");
    // Replacement text, the lazily rendered card body and the batch of
    // immediate bodies each render into a detached container.
    assert.include(source, "copyFlatContentScope(element, container)");
    assert.include(source, "copyFlatContentScope(scopeSource, container)");
    assert.include(source, "copyFlatContentScope(scopeSource, batchContainer)");
  });
});

describe("document figure gallery", function () {
  const document = {
    assets: [
      {
        assetId: "a1",
        contentHash: "h",
        mimeType: "image/png",
        byteLength: 1,
        caption: "Reaction time by group",
        durablePath: "/tmp/llm-doc/figure-1.png",
        provenance: { origin: "generated", generator: "plot" },
      },
    ],
  } as unknown as PlanDocument;

  it("uses flat figure frames with a hover bar and the document's caption", function () {
    const gallery = renderPlanDocumentFigures(
      fakeDocument,
      document,
    ) as unknown as FakeElement;
    assert.isOk(gallery);
    assert.isTrue(gallery.classList.contains(CONTENT_FLAT_SCOPE_CLASS));
    const frames = gallery.findAllByClass("llm-flat-figure");
    assert.lengthOf(frames, 1);
    assert.isOk(frames[0].findByClass("llm-content-bar"));
    const caption = frames[0].findByClass("llm-content-caption-text");
    assert.include(caption?.textContent || "", "Reaction time by group");
    assert.include(caption?.textContent || "", "Generated asset");
    assert.isNull(gallery.findByClass("llm-side-move-btn"));
  });

  it("returns null without assets", function () {
    assert.isNull(
      renderPlanDocumentFigures(fakeDocument, { assets: [] } as never),
    );
  });
});

describe("diagram tab zoom", function () {
  it("fills the preview with a stage, the media and a zoom pill", function () {
    const win = {};
    const doc = {
      defaultView: win,
      createElementNS: (_ns: string, tag: string) => {
        const el = new FakeElement(tag);
        (el as unknown as { ownerDocument: unknown }).ownerDocument = doc;
        return el;
      },
    };
    const preview = new FakeElement("div");
    (preview as unknown as { ownerDocument: unknown }).ownerDocument = doc;
    const viewport = new FakeElement("div");
    const svg = new FakeElement("svg");
    svg.setAttribute("width", "400");
    svg.setAttribute("height", "200");
    (svg as unknown as { localName: string }).localName = "svg";
    viewport.appendChild(svg);
    preview.appendChild(viewport);

    const panZoom = mountDiagramTabZoom(asEl(preview), svg as never);
    assert.isOk(panZoom);
    assert.isTrue(preview.classList.contains("llm-figure-tab-frame"));
    assert.lengthOf(preview.children, 1);
    const stage = preview.children[0];
    assert.isTrue(stage.classList.contains("llm-figure-tab-stage"));
    assert.isTrue(svg.classList.contains("llm-figure-tab-image"));
    assert.equal(svg.parentElement, stage);
    const pill = stage.findByClass("llm-figure-tab-zoom");
    assert.isOk(pill);
    for (const name of ["zoom-out", "zoom-in", "fit"]) {
      assert.isOk(pill!.findByClass(`llm-figure-viewer-${name}`), name);
    }
    assert.equal(svg.style.maxWidth, "none");
    // The same gestures as a figure tab: wheel, drag and double-click-to-fit.
    const hasListener = (type: string) =>
      (
        (
          stage as unknown as { listeners: Map<string, unknown[]> }
        ).listeners.get(type) || []
      ).length > 0;
    for (const type of ["wheel", "pointerdown", "pointermove", "dblclick"]) {
      assert.isTrue(hasListener(type), type);
    }
  });

  it("finds the tab marker through an ancestor", function () {
    const box = {
      closest: (selector: string) =>
        selector === `[${CONTENT_TAB_ZOOM_ATTRIBUTE}="true"]` ? box : null,
    };
    assert.isTrue(isInTabZoomScope(box as unknown as Element));
    assert.isFalse(
      isInTabZoomScope({ closest: () => null } as unknown as Element),
    );
  });
});
