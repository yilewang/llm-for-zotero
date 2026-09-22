import { assert } from "chai";
import { describe, it } from "mocha";
import { marked } from "marked";
import { parseFragment } from "parse5";
import {
  findBestVisibleChatAnchor,
  findElementForAnchor,
} from "../src/modules/contextPanel/chatScrollGeometry";

type ParsedNode = {
  nodeName: string;
  tagName?: string;
  value?: string;
  childNodes?: ParsedNode[];
};

type ReadingBlock = {
  itemOrdinal: number;
  tagName: string;
  textContent: string;
  parentElement: ReadingBlock | null;
  children: ReadingBlock[];
  closest: (selector: string) => unknown;
  querySelectorAll: (selector: string) => ReadingBlock[];
  getBoundingClientRect: () => DOMRect;
};

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    height: bottom - top,
    width: 300,
    left: 0,
    right: 300,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function fixture() {
  let blocks: ReadingBlock[] = [];
  const section = { querySelectorAll: () => blocks };
  const wrapper = {
    dataset: {
      messageRole: "assistant",
      messageTimestamp: "1",
      messageAnchorKey: "streaming-list",
    },
    getBoundingClientRect: () => rect(-200, 800),
    closest: () => wrapper,
    querySelectorAll: (selector: string) =>
      selector.includes(".llm-assistant-answer") ? [section] : [],
  };
  const box = {
    getBoundingClientRect: () => rect(100, 280),
    querySelectorAll: (selector: string) =>
      selector === ".llm-message-wrapper" ? [wrapper] : [],
  } as unknown as HTMLDivElement;
  const textContent = (node: ParsedNode): string =>
    node.nodeName === "#text"
      ? node.value || ""
      : (node.childNodes || []).map(textContent).join("");

  function render(source: string) {
    // Real marked output changes a tight list's li nodes into li > p when a
    // streamed blank line makes it loose. Geometry is held constant so this
    // test isolates wrong identity matching from any browser margin changes.
    const parsed = parseFragment(marked.parse(source) as string);
    let ordinal = 0;
    blocks = [];
    const visit = (
      node: ParsedNode,
      itemOrdinal: number,
      parent: ReadingBlock | null,
    ) => {
      if (node.tagName === "li") itemOrdinal = ++ordinal;
      let currentParent = parent;
      if (["li", "p"].includes(node.tagName || "")) {
        const block: ReadingBlock = {
          itemOrdinal,
          tagName: node.tagName!.toUpperCase(),
          textContent: textContent(node),
          parentElement: parent,
          children: [],
          closest: () => wrapper,
          querySelectorAll: (selector) =>
            block.children.filter(
              (child) => child.tagName.toLowerCase() === selector,
            ),
          getBoundingClientRect: () =>
            rect(100 + (itemOrdinal - 4) * 60, 150 + (itemOrdinal - 4) * 60),
        };
        blocks.push(block);
        parent?.children.push(block);
        currentParent = block;
      }
      for (const child of node.childNodes || [])
        visit(child, itemOrdinal, currentParent);
    };
    visit(parsed, 0, null);
  }
  return { box, render };
}

describe("streaming list reading anchors", function () {
  for (const ordered of [false, true]) {
    for (const commonPrefix of [false, true]) {
      it(`preserves item four when a ${ordered ? "numbered" : "bullet"} list becomes loose (${commonPrefix ? "shared long prefix" : "repeated text"})`, function () {
        const view = fixture();
        const prefix = "The shared explanation of the same equation. ".repeat(
          5,
        );
        const source = Array.from({ length: 8 }, (_, index) => {
          const marker = ordered ? `${index + 1}.` : "-";
          const text = commonPrefix
            ? `${prefix}Distinct result ${index + 1}.`
            : "The same repeated action.";
          return `${marker} ${text}`;
        }).join("\n");
        view.render(source);
        const anchor = findBestVisibleChatAnchor(view.box)!;
        const before = findElementForAnchor(
          view.box,
          anchor,
        ) as unknown as ReadingBlock;
        assert.equal(before.itemOrdinal, 4, "the reader is on the fourth item");

        // This is an append-only stream update, with no reset or disclosure.
        view.render(source + `\n\n${ordered ? "9." : "-"} Another result.`);
        const after = findElementForAnchor(
          view.box,
          anchor,
        ) as unknown as ReadingBlock;
        assert.isOk(after, "the original list item remains available");
        assert.equal(
          after.itemOrdinal,
          4,
          "li and its new p must not shift the saved item identity",
        );
        assert.equal(
          after.getBoundingClientRect().top,
          before.getBoundingClientRect().top,
        );
      });
    }
  }
});
