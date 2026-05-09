import { sanitizeText } from "./textUtils";

function collapseWhitespace(text: string): string {
  return sanitizeText(text).replace(/\s+/g, " ").trim();
}

function escapeMarkdownTableCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function extractNodeText(node: Element): string {
  const htmlNode = node as HTMLElement;
  return sanitizeText(
    (htmlNode.innerText || htmlNode.textContent || "").trim(),
  );
}

function extractKatexLatex(node: Element): string {
  const annotations = Array.from(
    node.querySelectorAll('annotation[encoding="application/x-tex"]'),
  ) as Element[];
  const latex = annotations
    .map((annotation) => sanitizeText((annotation.textContent || "").trim()))
    .filter(Boolean)
    .join("\n");
  return latex;
}

function cloneAndClean(node: Element): Element {
  const cloned = node.cloneNode(true) as Element;
  const removableNodes = Array.from(
    cloned.querySelectorAll(".llm-rich-block-copy-btn, .katex-mathml"),
  ) as Element[];
  for (const removableNode of removableNodes) {
    removableNode.remove();
  }
  const katexNodes = Array.from(cloned.querySelectorAll(".katex")) as Element[];
  for (const katexEl of katexNodes) {
    const latex = extractKatexLatex(katexEl);
    const replacement = latex || extractNodeText(katexEl);
    const ownerDoc = katexEl.ownerDocument;
    if (!ownerDoc) {
      katexEl.remove();
      continue;
    }
    katexEl.replaceWith(ownerDoc.createTextNode(replacement || ""));
  }
  return cloned;
}

function cloneTableCellForMarkdown(cell: Element): Element {
  const cloned = cell.cloneNode(true) as Element;
  const removableNodes = Array.from(
    cloned.querySelectorAll(".llm-rich-block-copy-btn"),
  ) as Element[];
  for (const removableNode of removableNodes) {
    removableNode.remove();
  }
  const katexNodes = Array.from(cloned.querySelectorAll(".katex")) as Element[];
  for (const katexEl of katexNodes) {
    const latex = extractKatexLatex(katexEl).trim();
    const replacement = latex ? `$${latex}$` : extractNodeText(katexEl);
    const ownerDoc = katexEl.ownerDocument;
    if (!ownerDoc) {
      katexEl.remove();
      continue;
    }
    katexEl.replaceWith(ownerDoc.createTextNode(replacement || ""));
  }
  const leftoverMathMl = Array.from(
    cloned.querySelectorAll(".katex-mathml"),
  ) as Element[];
  for (const mathMlNode of leftoverMathMl) {
    mathMlNode.remove();
  }
  return cloned;
}

export function buildMarkdownTableFromRows(rows: string[][]): string {
  if (!rows.length) return "";
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => {
    const padded = row.slice();
    while (padded.length < columnCount) padded.push("");
    return padded.map((cell) =>
      escapeMarkdownTableCell(collapseWhitespace(cell)),
    );
  });
  const header = normalizedRows[0];
  const divider = new Array(columnCount).fill("---");
  const body = normalizedRows.slice(1);
  return [
    `| ${header.join(" | ")} |`,
    `| ${divider.join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function extractTableMarkdown(table: Element): string {
  const rows = Array.from(
    table.querySelectorAll("tr"),
  ) as HTMLTableRowElement[];
  const matrix = rows
    .map((row) =>
      (Array.from(row.querySelectorAll("th, td")) as Element[]).map((cell) => {
        const cleanedCell = cloneTableCellForMarkdown(cell);
        return extractNodeText(cleanedCell);
      }),
    )
    .filter((cells) => cells.length > 0);
  return buildMarkdownTableFromRows(matrix);
}

function extractFormulaText(block: Element): string {
  const katexRoots = Array.from(block.querySelectorAll(".katex")) as Element[];
  const latexChunks = katexRoots
    .map((root) => extractKatexLatex(root).trim())
    .filter(Boolean);
  const normalizedLatex = latexChunks.join("\n\n").trim();
  if (normalizedLatex) return formatDisplayLatex(normalizedLatex);
  const directLatex = extractKatexLatex(block).trim();
  if (directLatex) return formatDisplayLatex(directLatex);
  const cleaned = cloneAndClean(block);
  const fallback = extractNodeText(cleaned);
  if (!fallback) return "";
  return formatDisplayLatex(fallback);
}

export function getCopyableBlockText(block: Element): string {
  if (block.matches("pre")) {
    const codeEl = (block.querySelector(":scope > code") ||
      block) as HTMLElement;
    return codeEl.textContent || "";
  }
  if (block.matches("table")) {
    return extractTableMarkdown(block);
  }
  if (block.matches(".katex-display")) {
    return extractFormulaText(block);
  }
  return extractNodeText(cloneAndClean(block));
}

export function formatDisplayLatex(latex: string): string {
  return `$$${sanitizeText(latex).trim()}$$`;
}
