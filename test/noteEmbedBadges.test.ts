import { assert } from "chai";
import {
  decorateNoteEmbedBadges,
  splitNoteEmbedBadges,
} from "../src/modules/contextPanel/agentTrace/noteEmbedBadges";

describe("note placeholders in a review preview", function () {
  it("shows each placeholder as a badge with what the item shows", function () {
    assert.deepEqual(
      splitNoteEmbedBadges(
        'Drift {{citation:3fa9c1 ("Smith", 2020, p. 42)}} and {{image:77aa01}}.',
      ),
      [
        "Drift ",
        {
          kind: "citation",
          text: '("Smith", 2020, p. 42)',
          title: "Zotero citation, kept exactly as it is in the note",
        },
        " and ",
        {
          kind: "image",
          text: "Image",
          title: "Image, kept exactly as it is in the note",
        },
        ".",
      ],
    );
  });

  it("names the paper and page of a citation the change adds", function () {
    assert.deepEqual(splitNoteEmbedBadges("{{cite item=12 page=4}}"), [
      {
        kind: "citation",
        text: "New citation: item 12, p. 4",
        title: "A Zotero citation this change adds",
      },
    ]);
  });

  it("leaves text without placeholders alone", function () {
    assert.deepEqual(splitNoteEmbedBadges("Plain {{cite web|a}} text"), [
      "Plain {{cite web|a}} text",
    ]);
  });

  it("replaces placeholders in rendered text, but not inside code", function () {
    type Node = {
      nodeType: number;
      nodeValue?: string;
      tagName?: string;
      childNodes: Node[];
      parent?: Node;
      replaceWith?: (fragment: { childNodes: Node[] }) => void;
      className?: string;
      textContent?: string;
      title?: string;
      dataset?: Record<string, string>;
    };
    const text = (value: string): Node => ({
      nodeType: 3,
      nodeValue: value,
      childNodes: [],
    });
    const element = (tagName: string, children: Node[]): Node => {
      const node: Node = { nodeType: 1, tagName, childNodes: children };
      for (const child of children) {
        child.parent = node;
        child.replaceWith = (fragment) => {
          const index = node.childNodes.indexOf(child);
          node.childNodes.splice(index, 1, ...fragment.childNodes);
        };
      }
      return node;
    };
    const token = "{{citation:3fa9c1 (Smith, 2020)}}";
    const paragraph = element("p", [text(`See ${token}.`)]);
    const code = element("code", [text(token)]);
    const root = element("div", [paragraph, code]);
    const doc = {
      createDocumentFragment: () => {
        const fragment = { childNodes: [] as Node[] };
        return Object.assign(fragment, {
          append: (child: Node) => fragment.childNodes.push(child),
        });
      },
      createTextNode: text,
      createElement: (tagName: string) => ({
        nodeType: 1,
        tagName,
        childNodes: [],
        dataset: {},
      }),
    };
    decorateNoteEmbedBadges(root as never, doc as never);
    const [before, badge, after] = paragraph.childNodes;
    assert.equal(before.nodeValue, "See ");
    assert.equal(badge.className, "llm-note-embed-badge");
    assert.equal(badge.textContent, "(Smith, 2020)");
    assert.equal(badge.dataset?.kind, "citation");
    assert.equal(after.nodeValue, ".");
    assert.equal(code.childNodes[0].nodeValue, token);
  });
});
