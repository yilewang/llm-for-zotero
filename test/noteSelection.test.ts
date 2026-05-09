import { assert } from "chai";
import { getEditableSelectionFromDocument } from "../src/modules/contextPanel/noteSelection";

class FakeElement {
  id = "";
  closestResult: unknown = null;
  parentElement: FakeElement | null = null;
  nodeType = 1;

  closest(_selector: string): unknown {
    return this.closestResult;
  }
}

class FakeTextArea extends FakeElement {
  value: string;
  selectionStart: number;
  selectionEnd: number;

  constructor(value: string, selectionStart: number, selectionEnd: number) {
    super();
    this.value = value;
    this.selectionStart = selectionStart;
    this.selectionEnd = selectionEnd;
  }
}

class FakeInput extends FakeElement {
  value = "";
  type = "text";
  selectionStart = 0;
  selectionEnd = 0;
}

class FakeHTMLElement extends FakeElement {
  isContentEditable = false;
}

class FakeTextNode {
  nodeType = 3;
  parentElement: FakeHTMLElement | null;

  constructor(parentElement: FakeHTMLElement) {
    this.parentElement = parentElement;
  }
}

describe("noteSelection", function () {
  function buildDocument(
    activeElement: FakeElement | null,
    selectionOverride?: {
      toString: () => string;
      isCollapsed: boolean;
      anchorNode: FakeHTMLElement | FakeTextNode;
      focusNode: FakeHTMLElement | FakeTextNode;
    } | null,
  ): Document {
    return {
      activeElement,
      body: { isContentEditable: false },
      defaultView: {
        HTMLTextAreaElement: FakeTextArea,
        HTMLInputElement: FakeInput,
        HTMLElement: FakeHTMLElement,
        Node: { ELEMENT_NODE: 1 },
        getSelection: () => selectionOverride || null,
      },
    } as unknown as Document;
  }

  it("reads the selected text from a focused textarea", function () {
    const textarea = new FakeTextArea("Alpha beta   gamma delta", 6, 18);
    const selectedText = getEditableSelectionFromDocument(
      buildDocument(textarea),
    );
    assert.equal(selectedText, "beta gamma");
  });

  it("ignores selections inside the llm panel textarea", function () {
    const textarea = new FakeTextArea("Prompt being edited", 0, 6);
    textarea.closestResult = {};
    const selectedText = getEditableSelectionFromDocument(
      buildDocument(textarea),
    );
    assert.equal(selectedText, "");
  });

  it("reads a DOM selection inside a contenteditable note surface", function () {
    const editable = new FakeHTMLElement();
    editable.isContentEditable = true;
    const textNode = new FakeTextNode(editable);
    const selectedText = getEditableSelectionFromDocument(
      buildDocument(null, {
        toString: () => "Selected from note surface",
        isCollapsed: false,
        anchorNode: textNode,
        focusNode: textNode,
      }),
    );
    assert.equal(selectedText, "Selected from note surface");
  });
});
