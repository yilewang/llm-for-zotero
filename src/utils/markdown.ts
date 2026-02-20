/**
 * Markdown to HTML renderer for chat messages
 *
 * Features:
 * - Block-level isolation: errors in one block don't affect others
 * - Delimiter validation: incomplete patterns are left as raw text
 * - Graceful degradation: failed blocks show as escaped text
 *
 * Supports:
 * - Headers (h1-h4)
 * - Bold, italic, bold+italic
 * - Code blocks and inline code
 * - Links
 * - Ordered and unordered lists
 * - Tables
 * - Blockquotes
 * - Horizontal rules
 * - LaTeX math (via KaTeX)
 */

import katex from "katex";

// =============================================================================
// Types
// =============================================================================

interface TextBlock {
  type:
    | "codeblock"
    | "mathblock"
    | "header"
    | "list"
    | "blockquote"
    | "table"
    | "hr"
    | "paragraph";
  content: string;
  raw: string;
}

// =============================================================================
// Module State
// =============================================================================

/**
 * When true, math blocks are rendered as Zotero note-editor native format
 * (<pre class="math">$$...$$</pre> and <span class="math">$...$</span>)
 * instead of KaTeX HTML. This is needed because note.setNote() loads HTML
 * through ProseMirror's schema parser which only recognises these tags,
 * unlike the paste handler which can transform KaTeX/MathML on the fly.
 */
let zoteroNoteMode = false;

// =============================================================================
// Constants
// =============================================================================

const KATEX_OPTIONS: katex.KatexOptions = {
  throwOnError: false,
  errorColor: "#cc0000",
  strict: false,
  trust: true,
  macros: {
    "\\R": "\\mathbb{R}",
    "\\N": "\\mathbb{N}",
    "\\Z": "\\mathbb{Z}",
  },
};

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;",
};

// =============================================================================
// Utility Functions
// =============================================================================

/** Escape HTML special characters */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (m) => HTML_ESCAPE_MAP[m]);
}

/** Count non-overlapping occurrences of a pattern */
function countOccurrences(text: string, pattern: string | RegExp): number {
  const regex =
    typeof pattern === "string"
      ? new RegExp(escapeRegex(pattern), "g")
      : pattern;
  return (text.match(regex) || []).length;
}

/** Escape special regex characters */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Render LaTeX to HTML using KaTeX */
function renderLatex(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, { ...KATEX_OPTIONS, displayMode });
  } catch {
    return `<span class="math-error" title="LaTeX error">${escapeHtml(latex)}</span>`;
  }
}

function findPreviousNonSpace(text: string, index: number): string {
  for (let i = index - 1; i >= 0; i--) {
    const ch = text[i];
    if (!/\s/.test(ch)) return ch;
  }
  return "";
}

function findNextNonSpace(text: string, index: number): string {
  for (let i = index + 1; i < text.length; i++) {
    const ch = text[i];
    if (!/\s/.test(ch)) return ch;
  }
  return "";
}

function findTopLevelEqualsIndex(text: string): number {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (
      ch === "=" &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      parenDepth === 0
    ) {
      return i;
    }
  }
  return -1;
}

function splitTopLevelAdditiveTerms(text: string): string[] {
  const terms: string[] = [];
  let start = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  const isBinaryAdditiveOperator = (index: number): boolean => {
    const ch = text[index];
    if (ch !== "+" && ch !== "-") return false;
    const prev = findPreviousNonSpace(text, index);
    const next = findNextNonSpace(text, index);
    if (!prev || !next) return false;
    if ("=+-*/^_({[,".includes(prev)) return false;
    if ("=+-*/^_)}],".includes(next)) return false;
    return true;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);

    if (
      braceDepth === 0 &&
      bracketDepth === 0 &&
      parenDepth === 0 &&
      isBinaryAdditiveOperator(i)
    ) {
      const term = text.slice(start, i).trim();
      if (term) terms.push(term);
      start = i;
    }
  }

  const last = text.slice(start).trim();
  if (last) terms.push(last);
  return terms;
}

const WRAP_BREAK_COMMANDS = new Set([
  "sum",
  "prod",
  "coprod",
  "int",
  "iint",
  "iiint",
  "oint",
  "lim",
]);

function readCommandName(text: string, start: number): {
  name: string;
  end: number;
} {
  let end = start + 1;
  while (end < text.length && /[A-Za-z]/.test(text[end])) {
    end += 1;
  }
  return { name: text.slice(start + 1, end), end };
}

function findTopLevelCommandBreakPoints(text: string): number[] {
  const points: number[] = [];
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      const { name, end } = readCommandName(text, i);
      if (
        name &&
        braceDepth === 0 &&
        bracketDepth === 0 &&
        parenDepth === 0 &&
        WRAP_BREAK_COMMANDS.has(name)
      ) {
        points.push(i);
      }
      i = Math.max(i + 1, end - 1);
      continue;
    }
    if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
  }

  return points;
}

function splitLongTermByTopLevelCommands(
  term: string,
  maxTermLength = 95,
): string[] {
  const source = term.trim();
  if (source.length <= maxTermLength) return [source];

  const breakPoints = findTopLevelCommandBreakPoints(source);
  if (breakPoints.length < 2) return [source];

  const chunks: string[] = [];
  let chunkStart = 0;
  for (let i = 1; i < breakPoints.length; i++) {
    const point = breakPoints[i];
    const currentLength = point - chunkStart;
    if (currentLength < Math.floor(maxTermLength * 0.7)) continue;
    const chunk = source.slice(chunkStart, point).trim();
    if (chunk) chunks.push(chunk);
    chunkStart = point;
  }

  const tail = source.slice(chunkStart).trim();
  if (tail) chunks.push(tail);
  return chunks.length > 1 ? chunks : [source];
}

function expandTermsForAlignment(terms: string[]): string[] {
  return terms.flatMap((term) => splitLongTermByTopLevelCommands(term));
}

function shouldAttemptDisplayWrap(math: string): boolean {
  const compact = math.replace(/\s+/g, " ").trim();
  if (compact.length < 120) return false;
  if (/\\begin\{[^}]+\}/.test(compact)) return false;
  if (/\\\\/.test(compact)) return false;
  if (/\\tag\{/.test(compact)) return false;
  return true;
}

function buildWrappedDisplayMath(math: string): string | null {
  if (!shouldAttemptDisplayWrap(math)) return null;

  const eqIndex = findTopLevelEqualsIndex(math);
  if (eqIndex >= 0) {
    const lhs = math.slice(0, eqIndex).trim();
    const rhs = math.slice(eqIndex + 1).trim();
    if (!lhs || !rhs) return null;
    const rhsTerms = splitTopLevelAdditiveTerms(rhs);
    const rhsExpandedTerms = expandTermsForAlignment(rhsTerms);
    if (rhsExpandedTerms.length < 2) return null;
    const lines = [
      `${lhs} &= ${rhsExpandedTerms[0]}`,
      ...rhsExpandedTerms.slice(1).map((term) => `&\\quad ${term}`),
    ];
    return `\\begin{aligned}${lines.join(" \\\\ ")}\\end{aligned}`;
  }

  const terms = expandTermsForAlignment(splitTopLevelAdditiveTerms(math));
  if (terms.length < 3) return null;
  const lines = [
    `& ${terms[0]}`,
    ...terms.slice(1).map((term) => `&\\quad ${term}`),
  ];
  return `\\begin{aligned}${lines.join(" \\\\ ")}\\end{aligned}`;
}

function renderDisplayLatex(latex: string): string {
  const wrapped = buildWrappedDisplayMath(latex);
  if (wrapped) {
    const wrappedHtml = renderLatex(wrapped, true);
    if (!wrappedHtml.includes('class="math-error"')) {
      return wrappedHtml;
    }
  }
  return renderLatex(latex, true);
}

// =============================================================================
// Delimiter Validation
// =============================================================================

/** Check if paired delimiters are balanced */
function isDelimiterBalanced(text: string, delimiter: string): boolean {
  return countOccurrences(text, delimiter) % 2 === 0;
}

/** Check if code block delimiters are balanced */
function hasBalancedCodeBlocks(text: string): boolean {
  return countOccurrences(text, "```") % 2 === 0;
}

/** Check if inline delimiters are balanced (for $, `, **, etc.) */
function hasBalancedInlineDelimiter(text: string, delimiter: string): boolean {
  // For single-char delimiters, count them
  // For multi-char like **, count occurrences
  return isDelimiterBalanced(text, delimiter);
}

// =============================================================================
// Block Splitting
// =============================================================================

/** Split text into independent blocks for isolated rendering */
function splitIntoBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const remaining = text;

  // First, extract fenced code blocks (they're atomic)
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  const codeBlockMatches: {
    match: string;
    index: number;
    lang: string;
    code: string;
  }[] = [];

  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    codeBlockMatches.push({
      match: match[0],
      index: match.index,
      lang: match[1],
      code: match[2],
    });
  }

  // If we have unbalanced code blocks, treat entire text as one paragraph
  if (!hasBalancedCodeBlocks(text)) {
    return [{ type: "paragraph", content: text, raw: text }];
  }

  // Split around code blocks
  let lastEnd = 0;
  for (const cb of codeBlockMatches) {
    // Text before this code block
    if (cb.index > lastEnd) {
      const beforeText = text.slice(lastEnd, cb.index);
      blocks.push(...splitTextBlocks(beforeText));
    }
    // The code block itself
    blocks.push({
      type: "codeblock",
      content: cb.code,
      raw: cb.match,
    });
    lastEnd = cb.index + cb.match.length;
  }

  // Text after last code block
  if (lastEnd < text.length) {
    const afterText = text.slice(lastEnd);
    blocks.push(...splitTextBlocks(afterText));
  }

  return blocks;
}

/** Split non-code text into blocks by blank lines and structure */
function splitTextBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const lines = text.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) {
      i++;
      continue;
    }

    // Display math block ($$...$$)
    if (trimmed.startsWith("$$") || /^\$\$/.test(trimmed)) {
      const mathLines: string[] = [line];
      i++;

      // If $$ is on its own line, collect until closing $$
      if (trimmed === "$$" || !trimmed.endsWith("$$")) {
        while (i < lines.length) {
          mathLines.push(lines[i]);
          if (lines[i].trim().endsWith("$$")) {
            i++;
            break;
          }
          i++;
        }
      }

      const raw = mathLines.join("\n");
      blocks.push({ type: "mathblock", content: raw, raw });
      continue;
    }

    // Display math block (\[...\])
    if (trimmed.startsWith("\\[")) {
      const mathLines: string[] = [line];
      i++;

      // If \[ is on its own line, collect until closing \]
      if (trimmed === "\\[" || !trimmed.endsWith("\\]")) {
        while (i < lines.length) {
          mathLines.push(lines[i]);
          if (lines[i].trim().endsWith("\\]")) {
            i++;
            break;
          }
          i++;
        }
      }

      const raw = mathLines.join("\n");
      blocks.push({ type: "mathblock", content: raw, raw });
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      blocks.push({ type: "hr", content: trimmed, raw: line });
      i++;
      continue;
    }

    // Header
    if (/^#{1,4}\s+/.test(trimmed)) {
      blocks.push({ type: "header", content: trimmed, raw: line });
      i++;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i]);
        i++;
      }
      const raw = quoteLines.join("\n");
      blocks.push({ type: "blockquote", content: raw, raw });
      continue;
    }

    // Table (starts with |)
    if (trimmed.includes("|") && i + 1 < lines.length) {
      const nextTrimmed = lines[i + 1]?.trim() || "";
      if (/^[\s|:-]+$/.test(nextTrimmed) && nextTrimmed.includes("-")) {
        const tableLines: string[] = [line, lines[i + 1]];
        i += 2;
        while (i < lines.length && lines[i].trim().includes("|")) {
          tableLines.push(lines[i]);
          i++;
        }
        const raw = tableLines.join("\n");
        blocks.push({ type: "table", content: raw, raw });
        continue;
      }
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const listLines: string[] = [];
      while (i < lines.length) {
        const listLine = lines[i].trim();
        if (/^\d+\.\s+/.test(listLine)) {
          listLines.push(lines[i]);
          i++;
          continue;
        }

        // Allow blank lines between list items when the next non-empty line
        // is still an ordered list item.
        if (!listLine) {
          let next = i + 1;
          while (next < lines.length && !lines[next].trim()) {
            next++;
          }
          if (next < lines.length && /^\d+\.\s+/.test(lines[next].trim())) {
            i = next;
            continue;
          }
        }
        break;
      }
      const raw = listLines.join("\n");
      blocks.push({ type: "list", content: raw, raw });
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(trimmed)) {
      const listLines: string[] = [];
      while (i < lines.length) {
        const listLine = lines[i].trim();
        if (/^[-*]\s+/.test(listLine)) {
          listLines.push(lines[i]);
          i++;
          continue;
        }

        // Allow blank lines between list items when the next non-empty line
        // is still an unordered list item.
        if (!listLine) {
          let next = i + 1;
          while (next < lines.length && !lines[next].trim()) {
            next++;
          }
          if (next < lines.length && /^[-*]\s+/.test(lines[next].trim())) {
            i = next;
            continue;
          }
        }
        break;
      }
      const raw = listLines.join("\n");
      blocks.push({ type: "list", content: raw, raw });
      continue;
    }

    // Paragraph (collect until blank line or structural element)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^#{1,4}\s+/.test(lines[i].trim()) &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !/^>/.test(lines[i].trim()) &&
      !/^---+$/.test(lines[i].trim()) &&
      !/^\$\$/.test(lines[i].trim()) &&
      !/^\\\[/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }

    if (paraLines.length > 0) {
      const raw = paraLines.join("\n");
      blocks.push({ type: "paragraph", content: raw, raw });
    }
  }

  return blocks;
}

// =============================================================================
// Block Rendering
// =============================================================================

/** Render a single block to HTML */
function renderBlock(block: TextBlock): string {
  switch (block.type) {
    case "codeblock":
      return renderCodeBlock(block.content, block.raw);
    case "mathblock":
      return renderMathBlock(block.content);
    case "header":
      return renderHeader(block.content);
    case "list":
      return renderList(block.content);
    case "blockquote":
      return renderBlockquote(block.content);
    case "table":
      return renderTable(block.content);
    case "hr":
      return "<hr/>";
    case "paragraph":
      return renderParagraph(block.content);
    default:
      return `<p>${escapeHtml(block.raw)}</p>`;
  }
}

/** Render fenced code block */
function renderCodeBlock(code: string, raw: string): string {
  // Extract language from raw if present
  const langMatch = raw.match(/^```(\w*)/);
  const lang = langMatch?.[1] || "";
  const langClass = lang ? ` class="lang-${lang}"` : "";
  return `<pre${langClass}><code>${escapeHtml(code.trim())}</code></pre>`;
}

/** Render display math block */
function renderMathBlock(content: string): string {
  // Remove $$ or \[...\] delimiters
  let math = content.trim();
  if (math.startsWith("$$") && math.endsWith("$$")) {
    math = math.slice(2, -2);
  } else {
    if (math.startsWith("\\[")) math = math.slice(2);
    if (math.endsWith("\\]")) math = math.slice(0, -2);
  }
  math = math.trim();

  if (zoteroNoteMode) {
    // Zotero note-editor expects <pre class="math">$$LaTeX$$</pre>
    return `<pre class="math">$$${escapeHtml(math)}$$</pre>`;
  }

  const rendered = renderDisplayLatex(math);
  return `<div class="math-display">${rendered}</div>`;
}

/** Render header */
function renderHeader(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("#### ")) {
    return `<h5>${renderInline(trimmed.slice(5))}</h5>`;
  }
  if (trimmed.startsWith("### ")) {
    return `<h4>${renderInline(trimmed.slice(4))}</h4>`;
  }
  if (trimmed.startsWith("## ")) {
    return `<h3>${renderInline(trimmed.slice(3))}</h3>`;
  }
  if (trimmed.startsWith("# ")) {
    return `<h2>${renderInline(trimmed.slice(2))}</h2>`;
  }
  return `<p>${renderInline(trimmed)}</p>`;
}

/** Render list (ordered or unordered) */
function renderList(content: string): string {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  const orderedMatch = lines[0]?.trim().match(/^(\d+)\.\s+/);
  const isOrdered = Boolean(orderedMatch);
  const tag = isOrdered ? "ol" : "ul";
  const start = orderedMatch ? parseInt(orderedMatch[1], 10) : 1;

  const items = lines.map((line) => {
    const text = line.trim().replace(/^(\d+\.)\s+|^[-*]\s+/, "");
    return `<li>${renderInline(text)}</li>`;
  });

  if (isOrdered && Number.isFinite(start) && start > 1) {
    return `<${tag} start="${start}">${items.join("")}</${tag}>`;
  }
  return `<${tag}>${items.join("")}</${tag}>`;
}

/** Render blockquote */
function renderBlockquote(content: string): string {
  const lines = content.split(/\r?\n/);
  const innerLines = lines.map((l) => {
    const trimmed = l.trim();
    return trimmed.startsWith(">") ? trimmed.slice(1).trim() : trimmed;
  });
  return `<blockquote>${innerLines.map((l) => renderInline(l)).join("<br/>")}</blockquote>`;
}

/** Render table */
function renderTable(content: string): string {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    return `<p>${escapeHtml(content)}</p>`;
  }

  const readCells = (row: string) =>
    row
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell, idx, arr) => {
        const isEdge = (idx === 0 || idx === arr.length - 1) && cell === "";
        return !isEdge;
      });

  const headerCells = readCells(lines[0]);
  // Skip divider line (lines[1])
  const bodyRows = lines.slice(2).map((line) => readCells(line));

  const headerHtml = `<tr>${headerCells.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr>`;
  const bodyHtml = bodyRows
    .map(
      (cells) =>
        `<tr>${cells.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`,
    )
    .join("");

  return `<table><thead>${headerHtml}</thead><tbody>${bodyHtml}</tbody></table>`;
}

/** Render paragraph */
function renderParagraph(content: string): string {
  const lines = content.split(/\r?\n/);
  const rendered = lines.map((l) => renderInline(l)).join("<br/>");
  return `<p>${rendered}</p>`;
}

// =============================================================================
// Inline Rendering (with delimiter validation)
// =============================================================================

/** Render inline elements within a line/block */
function renderInline(text: string): string {
  let result = text;

  // Store protected content
  const protectedBlocks: string[] = [];
  const protect = (html: string): string => {
    protectedBlocks.push(html);
    return `@@PROTECTED${protectedBlocks.length - 1}@@`;
  };

  // 1. Normalize math delimiters \(...\) and \[...\] to $...$ and $$...$$
  result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner) => `$${inner}$`);
  result = result.replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner) => `$$${inner}$$`);

  // 2. Inline math ($...$) - only if balanced
  if (hasBalancedInlineDelimiter(result, "$")) {
    // Display math first ($$...$$)
    result = result.replace(/\$\$([^$]+?)\$\$/g, (_match, math) => {
      if (zoteroNoteMode) {
        // Zotero note-editor: <span class="math">$LaTeX$</span>
        return protect(
          `<span class="math">$${escapeHtml(math.trim())}$</span>`,
        );
      }
      const rendered = renderDisplayLatex(math.trim());
      return protect(`<span class="math-display-inline">${rendered}</span>`);
    });

    // Inline math ($...$)
    result = result.replace(/\$([^$\n]+?)\$/g, (_match, inner) => {
      const trimmed = inner.trim();
      // Skip currency-like patterns
      if (!trimmed || /^\d+([.,]\d+)?$/.test(trimmed)) {
        return `$${inner}$`;
      }
      if (zoteroNoteMode) {
        // Zotero note-editor: <span class="math">$LaTeX$</span>
        return protect(`<span class="math">$${escapeHtml(trimmed)}$</span>`);
      }
      const rendered = renderLatex(trimmed, false);
      return protect(`<span class="math-inline">${rendered}</span>`);
    });
  }

  // 3. Inline code - only if balanced
  if (hasBalancedInlineDelimiter(result, "`")) {
    result = result.replace(/`([^`]+)`/g, (_match, code) => {
      return protect(`<code>${escapeHtml(code)}</code>`);
    });
  }

  // 4. HTML escape (after protecting code and math)
  result = escapeHtml(result);

  // 5. Bold+Italic (***...***)  - only if balanced
  if (hasBalancedInlineDelimiter(result, "***")) {
    result = result.replace(/\*\*\*(.+?)\*\*\*/g, (_m, inner) => {
      return protect(`<strong><em>${inner}</em></strong>`);
    });
  }

  // 6. Bold (**...**) - only if balanced
  if (hasBalancedInlineDelimiter(result, "**")) {
    result = result.replace(/\*\*(.+?)\*\*/g, (_m, inner) => {
      return protect(`<strong>${inner}</strong>`);
    });
  }

  // 7. Bold (__...__) - only if balanced
  if (hasBalancedInlineDelimiter(result, "__")) {
    result = result.replace(/__(.+?)__/g, (_m, inner) => {
      return protect(`<strong>${inner}</strong>`);
    });
  }

  // 8. Italic (*...* but not inside words)
  // Only apply if there are potential matches (avoid false positives)
  result = result.replace(
    /(^|[\s(])\*([^\s*][^*]*?[^\s*])\*(?=[\s).,!?:;]|$)/g,
    "$1<em>$2</em>",
  );
  result = result.replace(
    /(^|[\s(])\*([^\s*])\*(?=[\s).,!?:;]|$)/g,
    "$1<em>$2</em>",
  );

  // 9. Italic (_..._ but not inside words)
  result = result.replace(
    /(^|[\s(])_([^\s_][^_]*?[^\s_])_(?=[\s).,!?:;]|$)/g,
    "$1<em>$2</em>",
  );
  result = result.replace(
    /(^|[\s(])_([^\s_])_(?=[\s).,!?:;]|$)/g,
    "$1<em>$2</em>",
  );

  // 10. Links [text](url)
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );

  // 11. Restore protected blocks.
  // Reverse order is important for nested placeholders such as **$x$**:
  // bold wrapping can protect a token that itself points to rendered math.
  for (let i = protectedBlocks.length - 1; i >= 0; i--) {
    const token = `@@PROTECTED${i}@@`;
    if (result.includes(token)) {
      result = result.split(token).join(protectedBlocks[i]);
    }
  }

  return result;
}

// =============================================================================
// Main Export
// =============================================================================

/**
 * Convert markdown text to HTML with LaTeX math support
 *
 * Features graceful degradation:
 * - Each block is rendered independently
 * - Failed blocks show as escaped text
 * - Incomplete delimiters are left as raw text
 */
export function renderMarkdown(text: string): string {
  // Handle empty input
  if (!text || !text.trim()) {
    return "";
  }

  // Split into blocks
  const blocks = splitIntoBlocks(text);

  // Render each block independently (errors isolated)
  const renderedBlocks = blocks.map((block) => {
    try {
      return renderBlock(block);
    } catch (err) {
      // Graceful fallback: show raw text
      console.warn("Markdown block render error:", err);
      return `<div class="render-fallback">${escapeHtml(block.raw)}</div>`;
    }
  });

  return renderedBlocks.join("\n");
}

/**
 * Render markdown to HTML suitable for Zotero note-editor.
 *
 * Math is emitted as the editor's native format
 * (`<pre class="math">$$…$$</pre>` for display,
 *  `<span class="math">$…$</span>` for inline)
 * so that `note.setNote(html)` loads correctly through ProseMirror's
 * schema parser, matching what happens when the user pastes into a note.
 */
export function renderMarkdownForNote(text: string): string {
  zoteroNoteMode = true;
  try {
    return renderMarkdown(text);
  } finally {
    zoteroNoteMode = false;
  }
}
