import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

type Node = DefaultTreeAdapterTypes.ChildNode;
const blocks = new Set([
  "div",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "hr",
]);

/** Compare HTML meaning without erasing structure, assets, or citation metadata. */
export function canonicalNoteHtml(html: string): string {
  function children(
    nodes: Node[],
    preserve: boolean,
    block: boolean,
  ): unknown[] {
    return nodes.flatMap((node, index): unknown[] => {
      if (node.nodeName === "#comment") return [];
      if (node.nodeName === "#text") {
        let value = (node as DefaultTreeAdapterTypes.TextNode).value;
        if (!preserve) {
          value = value.replace(/[\t\n\r\f ]+/g, " ");
          const before = nodes[index - 1];
          const after = nodes[index + 1];
          if ((!before && block) || (before && blocks.has(before.nodeName)))
            value = value.replace(/^ /, "");
          if ((!after && block) || (after && blocks.has(after.nodeName)))
            value = value.replace(/ $/, "");
        }
        return value ? [["text", value]] : [];
      }
      if (!("tagName" in node)) return [];
      const attrs = node.attrs
        .map(({ name, value, namespace }) => [namespace || "", name, value])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const verbatim =
        preserve ||
        node.tagName === "pre" ||
        node.tagName === "code" ||
        node.attrs.some(
          (a) => a.name === "class" && a.value.split(/\s+/).includes("math"),
        );
      return [
        [
          node.tagName,
          attrs,
          children(node.childNodes, verbatim, blocks.has(node.tagName)),
        ],
      ];
    });
  }
  let nodes = parseFragment(html).childNodes;
  const metadata: unknown[] = [];
  // Only root Zotero containers are representation wrappers. Ordinary divs and
  // all citation/asset metadata remain meaningful.
  for (;;) {
    const significant = nodes.filter(
      (n) =>
        n.nodeName !== "#text" ||
        (n as DefaultTreeAdapterTypes.TextNode).value.trim(),
    );
    const root = significant.length === 1 ? significant[0] : undefined;
    if (!root || !("tagName" in root) || root.tagName !== "div") break;
    const legacy = root.attrs.some(
      (a) => a.name === "class" && /^zotero-note znv\d+$/.test(a.value),
    );
    const schema = root.attrs.some((a) => a.name === "data-schema-version");
    if (!legacy && !schema) break;
    metadata.push(
      ...root.attrs
        .filter(
          (a) =>
            !(schema && a.name === "data-schema-version") &&
            !(legacy && a.name === "class"),
        )
        .map((a) => [a.name, a.value]),
    );
    nodes = root.childNodes;
  }
  return JSON.stringify([metadata.sort(), children(nodes, false, true)]);
}

export function noteHtmlMatches(actual: string, expected: string): boolean {
  return canonicalNoteHtml(actual) === canonicalNoteHtml(expected);
}
