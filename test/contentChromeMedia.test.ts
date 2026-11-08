import { assert } from "chai";
import {
  detectNumericColumns,
  isNumericCellText,
  tableRowsToCsv,
} from "../src/modules/contextPanel/contentChrome";
import {
  buildFlatFigureCaption,
  createGeneratedImageFrame,
  renderAssistantGeneratedImagesInto,
  splitFigureLabel,
} from "../src/modules/contextPanel/generatedImageRender";
import {
  attachFlatInlineImageChrome,
  attachFlatMathChrome,
  attachFlatTableChrome,
} from "../src/modules/contextPanel/renderedMarkdown";
import {
  registerSidePanelItemHost,
  unregisterSidePanelItemHost,
} from "../src/modules/contextPanel/sidePanelItems";
import { FakeElement, fakeDocument } from "./helpers/fakeDom";

const asEl = (el: FakeElement) => el as unknown as HTMLElement;
const asRoot = (el: FakeElement) => el as unknown as ParentNode;

const labelsOf = (block: FakeElement) =>
  block.children
    .find((c) => c.classList.contains("llm-content-bar"))
    ?.children.map((b) => b.attributes["aria-label"]);

const captionOf = (block: FakeElement) =>
  block.children.find((c) => c.classList.contains("llm-content-caption"));

const PAPER_FIGURE = {
  id: "fig-3",
  label: "Figure 3. Firing rate by arm",
  path: "/tmp/llm-figure-3.png",
  figure: {
    pageIndex: 5,
    pageLabel: "6",
    paper: { itemId: 1, contextItemId: 2, title: "Paper" },
  },
};

describe("figure and picture captions", function () {
  it("splits a figure name from its caption text", function () {
    assert.deepEqual(splitFigureLabel("Figure 3. Firing rate by arm"), {
      name: "Figure 3",
      rest: "Firing rate by arm",
    });
    assert.deepEqual(splitFigureLabel("Supplementary Figure S2"), {
      name: "Supplementary Figure S2",
      rest: "",
    });
    assert.deepEqual(splitFigureLabel("Paper - page 3"), {
      name: "",
      rest: "Paper - page 3",
    });
  });

  it("builds kind and text for paper figures and pictures", function () {
    assert.deepEqual(buildFlatFigureCaption(PAPER_FIGURE), {
      kind: "Figure 3 · p. 6",
      text: "Firing rate by arm",
    });
    assert.deepEqual(
      buildFlatFigureCaption({
        id: "x",
        label: "Paper - page 6",
        figure: { pageLabel: "6" },
      }),
      { kind: "Figure · p. 6", text: "" },
    );
    assert.deepEqual(
      buildFlatFigureCaption({
        id: "p",
        label: "A cat",
        path: "/home/me/out/cat.png",
      }),
      { kind: "Picture", text: "cat.png" },
    );
    assert.deepEqual(
      buildFlatFigureCaption({ id: "p", label: "A cat", src: "data:x" }),
      { kind: "Picture", text: "A cat" },
    );
  });
});

describe("flat figure frame", function () {
  const root = () => new FakeElement("div");

  it("puts copy, save, folder, full view and the side button in the bar", function () {
    const doc = fakeDocument;
    const host = { open: () => undefined };
    registerSidePanelItemHost(doc, host);
    try {
      const frame = createGeneratedImageFrame(asEl(root()), PAPER_FIGURE, doc, {
        flatChrome: true,
      }) as unknown as FakeElement;
      assert.exists(frame);
      assert.isTrue(frame.classList.contains("llm-flat-figure"));
      assert.deepEqual(labelsOf(frame), [
        "Copy image",
        "Save image",
        "Show in folder",
        "Open full view",
        "Move to side panel",
      ]);
      // No old action row and no old figcaption.
      assert.isUndefined(
        frame.children.find((c) =>
          c.classList.contains("llm-assistant-generated-image-actions"),
        ),
      );
      assert.isUndefined(
        frame.children.find((c) => c.tagName === "figcaption"),
      );
      const caption = captionOf(frame);
      assert.equal(caption?.children[0].textContent, "Figure 3 · p. 6");
      assert.equal(caption?.children[1].textContent, "Firing rate by arm");
      assert.equal(caption?.children[2].textContent, "Go to page");
      assert.equal(caption?.children[2].className, "llm-content-caption-link");
      assert.equal(frame.attributes["data-side-item-kind"], "figure");
    } finally {
      unregisterSidePanelItemHost(doc, host);
    }
  });

  it("gives an agent picture a Picture caption, no link and no side button", function () {
    const frame = createGeneratedImageFrame(
      asEl(root()),
      { id: "p", label: "A cat", path: "/tmp/cat.png" },
      fakeDocument,
      { flatChrome: true },
    ) as unknown as FakeElement;
    assert.deepEqual(labelsOf(frame), [
      "Copy image",
      "Save image",
      "Show in folder",
      "Open full view",
    ]);
    const caption = captionOf(frame);
    assert.equal(caption?.children[0].textContent, "Picture");
    assert.equal(caption?.children[1].textContent, "cat.png");
    assert.lengthOf(caption!.children, 2);
  });

  it("keeps the old box when the flat style is off", function () {
    const frame = createGeneratedImageFrame(
      asEl(root()),
      PAPER_FIGURE,
      fakeDocument,
      {},
    ) as unknown as FakeElement;
    assert.isFalse(frame.classList.contains("llm-flat-figure"));
    assert.isUndefined(
      frame.children.find((c) => c.classList.contains("llm-content-bar")),
    );
    const actions = frame.children.find((c) =>
      c.classList.contains("llm-assistant-generated-image-actions"),
    );
    assert.exists(actions);
    assert.include(
      actions!.children.map((b) => b.className.split(" ")[1]),
      "llm-generated-image-action-jump",
    );
    assert.exists(frame.children.find((c) => c.tagName === "figcaption"));
  });

  it("marks the wrapper with the flat scope only in the flat style", function () {
    const flatHost = root();
    renderAssistantGeneratedImagesInto(
      asEl(flatHost),
      [PAPER_FIGURE],
      fakeDocument,
      { flatChrome: true },
    );
    assert.isTrue(flatHost.children[0].classList.contains("llm-content-flat"));
    const plainHost = root();
    renderAssistantGeneratedImagesInto(
      asEl(plainHost),
      [PAPER_FIGURE],
      fakeDocument,
      {},
    );
    assert.isFalse(
      plainHost.children[0].classList.contains("llm-content-flat"),
    );
  });
});

describe("table helpers", function () {
  it("recognises number-ish cells", function () {
    for (const text of [
      "12",
      "−3.4",
      "-3",
      "+0.5",
      "1,200",
      "85%",
      "40 ms",
      "2x",
      "7pts",
    ]) {
      assert.isTrue(isNumericCellText(text), text);
    }
    for (const text of ["", "abc", "12 apples", ".", "3-4", "n/a", "v2"]) {
      assert.isFalse(isNumericCellText(text), text);
    }
  });

  it("marks a column numeric when every body cell is a number", function () {
    assert.deepEqual(
      detectNumericColumns([
        ["Arm A", "12", "3 ms", "x1"],
        ["Arm B", "1,200", "—", "2"],
        ["Arm C", "", "5 ms", "3"],
      ]),
      [false, true, true, false],
    );
    assert.deepEqual(detectNumericColumns([["-", "-"]]), [false, false]);
    assert.deepEqual(detectNumericColumns([]), []);
  });

  it("writes CSV with quotes only where needed", function () {
    assert.equal(
      tableRowsToCsv([
        ["Name", "Note"],
        ["Ann", 'said "hi", left'],
        ["Bo", "two\nlines"],
      ]),
      'Name,Note\nAnn,"said ""hi"", left"\nBo,two lines',
    );
  });
});

function cell(tag: "th" | "td", text: string): FakeElement {
  const el = new FakeElement(tag);
  el.textContent = text;
  return el;
}

function buildTable(flat: boolean) {
  const root = new FakeElement("div");
  if (flat) root.className = "llm-content-flat";
  const block = new FakeElement("div");
  block.className = "llm-copyable llm-copyable-table";
  block.dataset.llmCopySource = "| a | b |";
  const copy = new FakeElement("button");
  copy.className = "llm-render-copy-btn";
  copy.textContent = "⧉";
  const scroll = new FakeElement("div");
  scroll.className = "llm-table-scroll";
  const table = new FakeElement("table");
  const head = new FakeElement("thead");
  const headRow = new FakeElement("tr");
  headRow.append(cell("th", "Arm"), cell("th", "Rate"));
  head.appendChild(headRow);
  const body = new FakeElement("tbody");
  const rows = [
    [cell("td", "A"), cell("td", "12")],
    [cell("td", "B"), cell("td", "7.5")],
  ];
  for (const cells of rows) {
    const row = new FakeElement("tr");
    row.append(...cells);
    body.appendChild(row);
  }
  table.append(head, body);
  scroll.appendChild(table);
  block.append(copy, scroll);
  root.appendChild(block);
  return { root, block, copy, headRow, rows };
}

describe("flat table chrome", function () {
  it("marks numeric columns and builds the Copy table / Save as CSV bar", function () {
    const { root, block, copy, headRow, rows } = buildTable(true);
    attachFlatTableChrome(asRoot(root), fakeDocument);
    assert.isTrue(block.classList.contains("llm-copyable-flat-table"));
    assert.deepEqual(labelsOf(block), ["Copy table", "Save as CSV"]);
    const bar = block.children.find((c) =>
      c.classList.contains("llm-content-bar"),
    );
    assert.strictEqual(bar?.children[0], copy);
    assert.equal(copy.textContent, "");
    // No full view, no side button, no caption.
    assert.isUndefined(captionOf(block));
    assert.isFalse(headRow.children[0].classList.contains("llm-num"));
    assert.isTrue(headRow.children[1].classList.contains("llm-num"));
    for (const cells of rows) {
      assert.isFalse(cells[0].classList.contains("llm-num"));
      assert.isTrue(cells[1].classList.contains("llm-num"));
    }
    attachFlatTableChrome(asRoot(root), fakeDocument);
    assert.lengthOf(bar!.children, 2);
  });

  it("leaves a table outside the flat scope as it is", function () {
    const { root, block, copy, headRow } = buildTable(false);
    attachFlatTableChrome(asRoot(root), fakeDocument);
    assert.isUndefined(
      block.children.find((c) => c.classList.contains("llm-content-bar")),
    );
    assert.strictEqual(block.children[0], copy);
    assert.isFalse(headRow.children[1].classList.contains("llm-num"));
  });
});

function buildMath(options: { flat: boolean; inline?: boolean }) {
  const root = new FakeElement("div");
  if (options.flat) root.className = "llm-content-flat";
  const block = new FakeElement(options.inline ? "span" : "div");
  block.className = `llm-copyable llm-copyable-math${options.inline ? " llm-copyable-inline" : ""}`;
  block.dataset.llmCopySource = "$$E=mc^2$$";
  const copy = new FakeElement("button");
  copy.className = "llm-render-copy-btn";
  copy.textContent = "⧉";
  const math = new FakeElement("div");
  math.className = "math-display";
  block.append(copy, math);
  root.appendChild(block);
  return { root, block, copy };
}

describe("flat math chrome", function () {
  it("gives a display equation only Copy LaTeX", function () {
    const { root, block, copy } = buildMath({ flat: true });
    attachFlatMathChrome(asRoot(root), fakeDocument);
    assert.deepEqual(labelsOf(block), ["Copy LaTeX"]);
    assert.isTrue(block.classList.contains("llm-copyable-flat-math"));
    assert.equal(copy.textContent, "");
    assert.isUndefined(captionOf(block));
    attachFlatMathChrome(asRoot(root), fakeDocument);
    assert.lengthOf(
      block.children.filter((c) => c.classList.contains("llm-content-bar")),
      1,
    );
  });

  it("leaves inline math and out-of-scope equations alone", function () {
    const inline = buildMath({ flat: true, inline: true });
    attachFlatMathChrome(asRoot(inline.root), fakeDocument);
    assert.isUndefined(
      inline.block.children.find((c) =>
        c.classList.contains("llm-content-bar"),
      ),
    );
    const outside = buildMath({ flat: false });
    attachFlatMathChrome(asRoot(outside.root), fakeDocument);
    assert.isUndefined(
      outside.block.children.find((c) =>
        c.classList.contains("llm-content-bar"),
      ),
    );
    assert.strictEqual(outside.block.children[0], outside.copy);
  });
});

describe("flat inline Markdown picture", function () {
  function build(flat: boolean) {
    const root = new FakeElement("div");
    if (flat) root.className = "llm-content-flat";
    const p = new FakeElement("p");
    const img = new FakeElement("img");
    img.className = "llm-chat-inline-figure";
    img.setAttribute("src", "https://example.com/a.png");
    p.appendChild(img);
    root.appendChild(p);
    return { root, p, img };
  }

  it("wraps the picture with Copy image and Open full view", function () {
    const { root, p, img } = build(true);
    attachFlatInlineImageChrome(asRoot(root), fakeDocument);
    const wrapper = p.children[0];
    assert.isTrue(wrapper.classList.contains("llm-flat-inline-figure"));
    assert.strictEqual(wrapper.children[0], img);
    assert.deepEqual(labelsOf(wrapper), ["Copy image", "Open full view"]);
    attachFlatInlineImageChrome(asRoot(root), fakeDocument);
    assert.lengthOf(p.children, 1);
  });

  it("leaves a picture outside the flat scope as it is", function () {
    const { root, p, img } = build(false);
    attachFlatInlineImageChrome(asRoot(root), fakeDocument);
    assert.strictEqual(p.children[0], img);
  });
});
