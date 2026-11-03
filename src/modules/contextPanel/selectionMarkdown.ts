/**
 * Turns a selected part of a rendered answer back into Markdown.
 *
 * The answer's DOM has hover bars, header labels and buttons that the user did
 * not select as content. `stripSelectionChrome` removes them from a cloned
 * fragment, and `selectionFragmentToMarkdown` walks what remains.
 */

/** Controls and labels that are interface, not answer content. */
export const SELECTION_CHROME_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "script",
  "style",
  ".katex-mathml",
  ".llm-content-bar",
  ".llm-content-caption",
  ".llm-codeblock-header",
  ".llm-render-copy-btn",
  ".llm-mermaid-viewer",
  ".llm-svg-preview",
  ".llm-mermaid-preview",
  ".llm-html-preview",
].join(", ");

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "dd",
  "dt",
  "fieldset",
  "figure",
  "figcaption",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "ul",
]);

/** Replaces KaTeX output with its LaTeX source, then removes UI chrome. */
export function stripSelectionChrome(root: Element): void {
  const doc = root.ownerDocument;
  for (const el of queryAll(root, ".katex")) {
    const ann = el.querySelector('annotation[encoding="application/x-tex"]');
    if (!ann) continue;
    const latex = (ann.textContent || "").trim();
    const isDisplay =
      ann.closest("math")?.getAttribute("display") === "block" ||
      Boolean(el.closest(".katex-display"));
    el.replaceWith(
      doc.createTextNode(isDisplay ? `$$${latex}$$` : `$${latex}$`),
    );
  }
  for (const el of queryAll(root, SELECTION_CHROME_SELECTOR)) {
    el.remove();
  }
}

function queryAll(root: Element, selector: string): Element[] {
  return Array.from(root.querySelectorAll(selector)) as Element[];
}

function childNodesOf(node: Node): Node[] {
  return Array.from(node.childNodes) as Node[];
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function tagOf(el: Element): string {
  return el.tagName.toLowerCase();
}

function fenceFor(text: string, minLength: number): string {
  let longest = 0;
  for (const run of text.match(/`+/g) || []) {
    longest = Math.max(longest, run.length);
  }
  return "`".repeat(Math.max(minLength, longest + 1));
}

function collapseSpace(text: string): string {
  return text.replace(/[ \t\r\n\f]+/g, " ");
}

/** Language word after the opening fence of a copy source, or "". */
function languageFromCopySource(source: string): string {
  const match = /^\s*(`{3,}|~{3,})[ \t]*([^\s`]*)/.exec(source);
  return match ? match[2] : "";
}

function renderInline(node: Node): string {
  if (node.nodeType === 3) return collapseSpace(node.nodeValue || "");
  if (!isElement(node)) return "";
  const tag = tagOf(node);
  if (tag === "br") return "\n";
  if (tag === "code") {
    const text = collapseSpace(node.textContent || "");
    if (!text.trim()) return text;
    const fence = fenceFor(text, 1);
    const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
    return `${fence}${pad}${text}${pad}${fence}`;
  }
  const inner = () => renderInlineChildren(node);
  const wrap = (mark: string) => {
    const text = inner();
    const core = text.trim();
    if (!core) return text;
    const lead = text.slice(0, text.indexOf(core));
    const trail = text.slice(lead.length + core.length);
    return `${lead}${mark}${core}${mark}${trail}`;
  };
  switch (tag) {
    case "strong":
    case "b":
      return wrap("**");
    case "em":
    case "i":
      return wrap("*");
    case "del":
    case "s":
    case "strike":
      return wrap("~~");
    case "a": {
      const href = (node.getAttribute("href") || "").trim();
      const text = inner();
      if (/^(https?:|mailto:)/i.test(href) && text.trim()) {
        return `[${text.trim()}](${href})`;
      }
      return text;
    }
    case "img": {
      const alt = node.getAttribute("alt") || "";
      const src = (node.getAttribute("src") || "").trim();
      return /^https?:/i.test(src) ? `![${alt}](${src})` : alt;
    }
    default:
      return inner();
  }
}

function renderInlineChildren(el: Node): string {
  let out = "";
  for (const child of childNodesOf(el)) out += renderInline(child);
  return out;
}

/** Trims each line and the whole text; keeps line breaks from `<br>`. */
function tidyInline(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function renderCode(el: Element): string {
  const copyBlock = el.closest(".llm-copyable");
  const source = copyBlock?.getAttribute("data-llm-copy-source") || "";
  // The source fence is exact; the shell's label says "text" for no language.
  const shellLang =
    (el.closest("[data-code-lang]") || el).getAttribute("data-code-lang") || "";
  const info = source
    ? languageFromCopySource(source)
    : /^(text|plain|plaintext)$/i.test(shellLang)
      ? ""
      : shellLang;
  const body = el.matches(".llm-codeblock-body, pre")
    ? el
    : el.querySelector(".llm-codeblock-body, pre") || el;
  const code = (body.textContent || "").replace(/\r\n?/g, "\n");
  const text = code.replace(/^\n+|\n+$/g, "");
  const fence = fenceFor(text, 3);
  return `${fence}${info}\n${text}\n${fence}`;
}

function cellText(cell: Element): string {
  return tidyInline(renderInlineChildren(cell))
    .replace(/\n+/g, " ")
    .replace(/\|/g, "\\|");
}

function renderTable(table: Element): string {
  const rows = queryAll(table, "tr")
    .map((tr) =>
      (Array.from(tr.children) as Element[])
        .filter((c) => /^t[hd]$/.test(tagOf(c)))
        .map(cellText),
    )
    .filter((cells) => cells.length > 0);
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => {
    const cells = r.slice();
    while (cells.length < width) cells.push("");
    return `| ${cells.join(" | ")} |`;
  };
  const sep = `| ${Array(width).fill("---").join(" | ")} |`;
  return [pad(rows[0]), sep, ...rows.slice(1).map(pad)].join("\n");
}

function renderList(list: Element, depth: number): string {
  const ordered = tagOf(list) === "ol";
  const startAttr = parseInt(list.getAttribute("start") || "", 10);
  let n = Number.isFinite(startAttr) ? startAttr : 1;
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  for (const child of Array.from(list.children) as Element[]) {
    if (tagOf(child) !== "li") continue;
    const marker = ordered ? `${n++}. ` : "- ";
    const nested: string[] = [];
    let inlineText = "";
    for (const part of childNodesOf(child)) {
      if (isElement(part) && /^(ul|ol)$/.test(tagOf(part))) {
        nested.push(renderList(part, depth + 1));
      } else if (isElement(part) && isBlock(part)) {
        const block = renderBlocks(part, depth + 1);
        if (block) inlineText += (inlineText ? "\n" : "") + block;
      } else {
        inlineText += renderInline(part);
      }
    }
    const text = tidyInline(inlineText).replace(
      /\n/g,
      `\n${indent}${" ".repeat(marker.length)}`,
    );
    lines.push(`${indent}${marker}${text}`);
    lines.push(...nested);
  }
  return lines.join("\n");
}

function isBlock(el: Element): boolean {
  return (
    BLOCK_TAGS.has(tagOf(el)) ||
    el.classList.contains("llm-copyable") ||
    el.classList.contains("llm-quote-card")
  );
}

/** Renders a block element into Markdown paragraphs. */
function renderBlocks(el: Element, depth = 0): string {
  const tag = tagOf(el);
  if (el.classList.contains("llm-copyable-code")) return renderCode(el);
  if (el.classList.contains("llm-codeblock-shell") || tag === "pre") {
    return renderCode(el);
  }
  if (el.classList.contains("llm-copyable-table") || tag === "table") {
    const table = tag === "table" ? el : el.querySelector("table");
    return table ? renderTable(table) : tidyInline(renderInlineChildren(el));
  }
  if (/^h[1-6]$/.test(tag)) {
    const text = tidyInline(renderInlineChildren(el)).replace(/\n+/g, " ");
    return text ? `${"#".repeat(Number(tag[1]))} ${text}` : "";
  }
  if (tag === "hr") return "---";
  if (tag === "ul" || tag === "ol") return renderList(el, depth);
  if (tag === "blockquote") {
    const inner = walkChildren(el, depth);
    return inner
      .split("\n")
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
  }
  if (tag === "p" || tag === "li" || tag === "summary") {
    return tidyInline(renderInlineChildren(el));
  }
  // Block-level containers (div, section, copyable math, quote cards ...).
  return walkChildren(el, depth);
}

/** Renders the children of a container: block children split paragraphs. */
function walkChildren(parent: Node, depth: number): string {
  const parts: string[] = [];
  let run = "";
  const flush = () => {
    const text = tidyInline(run);
    if (text) parts.push(text);
    run = "";
  };
  for (const child of childNodesOf(parent)) {
    if (isElement(child) && isBlock(child)) {
      flush();
      const block = renderBlocks(child, depth);
      if (block) parts.push(block);
    } else {
      run += renderInline(child);
    }
  }
  flush();
  return parts.join("\n\n");
}

/**
 * Markdown for a chrome-free fragment. A selection of plain text inside one
 * paragraph comes back unchanged.
 */
export function selectionFragmentToMarkdown(root: Element): string {
  return walkChildren(root, 0)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
