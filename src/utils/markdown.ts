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
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { Marked, Renderer, type Tokens } from "marked";

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
let activeImageResolver: ((src: string) => string | null) | null = null;
let markedMarkdownDisabled = false;
let markedMarkdownFailureReported = false;

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

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

const HARD_BREAK_TOKEN = "@@LLMHARDBREAK@@";
const SVG_PREVIEW_MAX_CHARS = 80_000;
const MERMAID_PREVIEW_MAX_CHARS = 50_000;

// =============================================================================
// Utility Functions
// =============================================================================

/** Escape HTML special characters */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (m) => HTML_ESCAPE_MAP[m]);
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/\r/g, "&#13;").replace(/\n/g, "&#10;");
}

type MarkdownRenderTarget = "chat" | "zotero-note";

type MarkdownMathToken = Tokens.Generic & {
  type: "llmMathBlock" | "llmInlineMath";
  raw: string;
  text: string;
  display: boolean;
  block: boolean;
};

function stripMarkdownUrlControls(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\s]+/g, "");
}

function sanitizeMarkdownUrl(
  rawUrl: string,
  kind: "link" | "image",
): string | null {
  const trimmed = (rawUrl || "").trim();
  if (!trimmed) return null;

  const compact = stripMarkdownUrlControls(trimmed);
  if (!compact || compact.startsWith("//")) return null;
  if (compact.startsWith("#")) return trimmed;

  const protocolMatch = compact.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!protocolMatch) return trimmed;

  const protocol = protocolMatch[1].toLowerCase();
  if (kind === "link") {
    return ["http", "https", "mailto", "zotero"].includes(protocol)
      ? trimmed
      : null;
  }

  if (["http", "https", "file"].includes(protocol)) return trimmed;
  if (
    protocol === "data" &&
    /^data:image\/[a-z0-9.+-]+;base64,/i.test(compact)
  ) {
    return trimmed;
  }
  return null;
}

const SAFE_RAW_HTML_TAG_ALIASES: Record<string, string> = {
  b: "strong",
  blockquote: "blockquote",
  br: "br",
  code: "code",
  del: "del",
  em: "em",
  h1: "h2",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  h5: "h5",
  h6: "h5",
  hr: "hr",
  i: "em",
  img: "img",
  li: "li",
  ol: "ol",
  p: "p",
  s: "del",
  strike: "del",
  strong: "strong",
  sub: "sub",
  sup: "sup",
  table: "table",
  tbody: "tbody",
  td: "td",
  th: "th",
  thead: "thead",
  tr: "tr",
  ul: "ul",
  a: "a",
};

const VOID_RAW_HTML_TAGS = new Set(["br", "hr", "img"]);
const RAW_HTML_SINGLE_TAG_PATTERN =
  /^<\s*\/?\s*[a-z][a-z0-9-]*(?:"[^"]*"|'[^']*'|[^'">])*>$/i;
const ESCAPED_RAW_HTML_TAG_PATTERN =
  /&lt;\s*(\/?)\s*([a-z][a-z0-9-]*)([\s\S]*?)(\/?)\s*&gt;/gi;

type RawHtmlRenderState = {
  stack: string[];
};

function readRawHtmlAttributes(rawAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern =
    /([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rawAttrs)) !== null) {
    const name = match[1]?.toLowerCase();
    if (!name || name.startsWith("on")) continue;
    attrs[name] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function renderSafeRawHtmlAttributes(
  tagName: string,
  rawAttrs: string,
): string | null {
  const attrs = readRawHtmlAttributes(rawAttrs);

  if (tagName === "a") {
    const safeHref = attrs.href
      ? sanitizeMarkdownUrl(attrs.href, "link")
      : null;
    const hrefAttr = safeHref ? ` href="${escapeAttribute(safeHref)}"` : "";
    const titleAttr = attrs.title
      ? ` title="${escapeAttribute(attrs.title)}"`
      : "";
    return `${hrefAttr}${titleAttr} target="_blank" rel="noopener"`;
  }

  if (tagName === "img") {
    const alt = attrs.alt || "";
    const attachmentKey = attrs["data-attachment-key"] || "";
    if (attachmentKey && /^[A-Za-z0-9_-]+$/.test(attachmentKey)) {
      return ` data-attachment-key="${escapeAttribute(attachmentKey)}" alt="${escapeAttribute(alt)}"`;
    }
    const safeSrc = attrs.src ? sanitizeMarkdownUrl(attrs.src, "image") : null;
    if (!safeSrc) return null;
    return ` src="${escapeAttribute(safeSrc)}" alt="${escapeAttribute(alt)}" class="llm-chat-inline-figure"`;
  }

  if (tagName === "ol" && attrs.start) {
    const start = Number.parseInt(attrs.start, 10);
    return Number.isFinite(start) && start > 1 ? ` start="${start}"` : "";
  }

  return "";
}

function renderSafeRawHtmlTag(
  rawTag: string,
  state: RawHtmlRenderState,
): string | null {
  const tagMatch = rawTag.match(
    /^<\s*(\/?)\s*([a-z][a-z0-9-]*)([\s\S]*?)(\/?)\s*>$/i,
  );
  if (!tagMatch) return null;

  const tagName = SAFE_RAW_HTML_TAG_ALIASES[tagMatch[2].toLowerCase()] || null;
  if (!tagName) return null;

  if (tagMatch[1]) {
    if (VOID_RAW_HTML_TAGS.has(tagName)) return "";
    const last = state.stack[state.stack.length - 1];
    if (last !== tagName) return null;
    state.stack.pop();
    return `</${tagName}>`;
  }

  const attrs = renderSafeRawHtmlAttributes(tagName, tagMatch[3] || "");
  if (attrs === null) return null;

  if (VOID_RAW_HTML_TAGS.has(tagName) || tagMatch[4]) {
    return tagName === "br" || tagName === "hr"
      ? `<${tagName}/>`
      : `<${tagName}${attrs} />`;
  }

  state.stack.push(tagName);
  return `<${tagName}${attrs}>`;
}

function renderSafeRawHtmlFragment(rawHtml: string): string {
  const state: RawHtmlRenderState = { stack: [] };
  const tagPattern = /<(?:"[^"]*"|'[^']*'|[^'">])*>/g;
  let result = "";
  let lastEnd = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(rawHtml)) !== null) {
    if (match.index > lastEnd) {
      result += escapeHtml(rawHtml.slice(lastEnd, match.index));
    }

    const safeTag = renderSafeRawHtmlTag(match[0], state);
    result += safeTag === null ? escapeHtml(match[0]) : safeTag;
    lastEnd = match.index + match[0].length;
  }

  if (lastEnd < rawHtml.length) {
    result += escapeHtml(rawHtml.slice(lastEnd));
  }

  while (state.stack.length) {
    result += `</${state.stack.pop()}>`;
  }

  return result;
}

function renderSafeRawHtml(
  rawHtml: string,
  rawHtmlState?: RawHtmlRenderState,
): string {
  const html = rawHtml.trim();

  if (RAW_HTML_SINGLE_TAG_PATTERN.test(html)) {
    const state = rawHtmlState || { stack: [] };
    const safeTag = renderSafeRawHtmlTag(html, state);
    if (safeTag !== null) return safeTag;
  }

  if (/<[^>]*>/.test(rawHtml)) {
    return renderSafeRawHtmlFragment(rawHtml);
  }

  return escapeHtml(rawHtml);
}

function decodeEscapedRawHtmlTagEntities(text: string): string {
  return text
    .replace(/&(quot|#34|#x22);/gi, '"')
    .replace(/&(apos|#39|#x27);/gi, "'");
}

function restoreEscapedSafeRawHtmlTagsInSegment(text: string): string {
  const state: RawHtmlRenderState = { stack: [] };
  return text.replace(
    ESCAPED_RAW_HTML_TAG_PATTERN,
    (
      match,
      closingSlash: string,
      tagName: string,
      rawAttrs: string,
      selfClosingSlash: string,
    ) => {
      const decodedAttrs = decodeEscapedRawHtmlTagEntities(rawAttrs || "");
      const rawTag = `<${closingSlash}${tagName}${decodedAttrs}${selfClosingSlash}>`;
      return renderSafeRawHtmlTag(rawTag, state) ?? match;
    },
  );
}

function restoreEscapedSafeRawHtmlTags(text: string): string {
  if (!/&lt;\s*\/?\s*[a-z][a-z0-9-]*[\s\S]*?&gt;/i.test(text)) {
    return text;
  }

  if (!hasBalancedCodeBlocks(text)) {
    return restoreEscapedSafeRawHtmlTagsInSegment(text);
  }

  const codeBlockRegex = /```[ \t]*([^\s`]*)[^\n`]*\n?([\s\S]*?)```/g;
  let result = "";
  let lastEnd = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastEnd) {
      result += restoreEscapedSafeRawHtmlTagsInSegment(
        text.slice(lastEnd, match.index),
      );
    }
    result += match[0];
    lastEnd = match.index + match[0].length;
  }

  if (lastEnd < text.length) {
    result += restoreEscapedSafeRawHtmlTagsInSegment(text.slice(lastEnd));
  }

  return result;
}

function wrapCopyable(
  html: string,
  copySource: string,
  kind: "code" | "math" | "table",
  display: "block" | "inline" = "block",
): string {
  const className =
    display === "inline"
      ? `llm-copyable llm-copyable-${kind} llm-copyable-inline`
      : `llm-copyable llm-copyable-${kind}`;
  const tag = display === "inline" ? "span" : "div";
  return `<${tag} class="${className}" data-llm-copy-source="${escapeAttribute(copySource)}">${html}</${tag}>`;
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

function normalizeFenceLanguage(raw: string | undefined): string {
  return (raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_+#.-]/g, "")
    .slice(0, 32);
}

function highlightLanguageForFence(lang: string): string | null {
  const normalized = normalizeFenceLanguage(lang);
  const aliases: Record<string, string> = {
    "": "",
    bash: "bash",
    css: "css",
    html: "xml",
    javascript: "javascript",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    markdown: "markdown",
    md: "markdown",
    py: "python",
    python: "python",
    shell: "shell",
    sh: "shell",
    sql: "sql",
    svg: "xml",
    ts: "typescript",
    tsx: "typescript",
    typescript: "typescript",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
  };
  const language = aliases[normalized] || "";
  return language && hljs.getLanguage(language) ? language : null;
}

function isMermaidFenceLanguage(lang: string): boolean {
  return lang === "mermaid" || lang === "mmd";
}

function renderCodeHtml(code: string, lang: string): string {
  const trimmedCode = code.trim();
  const langClass = lang ? ` class="lang-${lang}"` : "";
  const highlightLanguage = highlightLanguageForFence(lang);
  if (!highlightLanguage) {
    return `<pre${langClass}><code>${escapeHtml(trimmedCode)}</code></pre>`;
  }
  try {
    const highlighted = hljs.highlight(trimmedCode, {
      language: highlightLanguage,
      ignoreIllegals: true,
    }).value;
    return `<pre${langClass}><code class="hljs language-${highlightLanguage}">${highlighted}</code></pre>`;
  } catch {
    return `<pre${langClass}><code>${escapeHtml(trimmedCode)}</code></pre>`;
  }
}

function trimSvgLeadingMetadata(svg: string): string {
  let result = svg.trim().replace(/^\uFEFF/, "");
  let previous = "";
  while (previous !== result) {
    previous = result;
    result = result
      .replace(/^<\?xml[\s\S]*?\?>\s*/i, "")
      .replace(/^<!--[\s\S]*?-->\s*/i, "");
  }
  return result;
}

function hasUnsafeSvgUrl(svg: string): boolean {
  const attrPattern = /\b(?:href|src|xlink:href)\s*=\s*(["'])([\s\S]*?)\1/gi;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrPattern.exec(svg)) !== null) {
    const value = attrMatch[2].trim();
    if (value && !value.startsWith("#")) return true;
  }

  const cssUrlPattern = /url\(\s*(["']?)([^)"']+)\1\s*\)/gi;
  let cssMatch: RegExpExecArray | null;
  while ((cssMatch = cssUrlPattern.exec(svg)) !== null) {
    const value = cssMatch[2].trim();
    if (value && !value.startsWith("#")) return true;
  }

  return false;
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

export function buildSafeSvgMarkup(
  code: string,
  maxChars = SVG_PREVIEW_MAX_CHARS,
): string | null {
  if (!code || code.length > maxChars) return null;

  let svg = trimSvgLeadingMetadata(code);
  if (!/^<svg\b[\s\S]*(?:<\/svg>|\/>)\s*$/i.test(svg)) return null;

  const unsafePatterns = [
    /<!doctype\b/i,
    /<!entity\b/i,
    /<\s*(?:script|foreignObject|iframe|object|embed|link|meta|base)\b/i,
    /\bon[a-z]+\s*=/i,
    /\bjavascript\s*:/i,
    /@import\b/i,
  ];
  if (unsafePatterns.some((pattern) => pattern.test(svg))) return null;
  if (hasUnsafeSvgUrl(svg)) return null;

  const openingTag = svg.match(/^<svg\b[^>]*>/i)?.[0] || "";
  if (!/\sxmlns\s*=/.test(openingTag)) {
    svg = svg.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  return svg;
}

export function buildSafeSvgDataUri(
  code: string,
  maxChars = SVG_PREVIEW_MAX_CHARS,
): string | null {
  const svg = buildSafeSvgMarkup(code, maxChars);
  if (!svg) return null;
  return `data:image/svg+xml;base64,${encodeBase64Utf8(svg)}`;
}

function renderMermaidPreview(code: string): string {
  const source = code.trim();
  if (!source || source.length > MERMAID_PREVIEW_MAX_CHARS) return "";
  return [
    `<div class="llm-mermaid-preview" data-mermaid-state="pending" data-llm-mermaid-source="${escapeAttribute(source)}" role="img" aria-label="Mermaid diagram preview">`,
    `<div class="llm-mermaid-status">Rendering diagram...</div>`,
    `</div>`,
  ].join("");
}

function hasUnescapedPipe(text: string, start: number, end: number): boolean {
  for (
    let index = Math.max(0, start);
    index < Math.min(text.length, end);
    index++
  ) {
    if (text[index] !== "|") continue;
    let slashCount = 0;
    for (let prev = index - 1; prev >= 0 && text[prev] === "\\"; prev--) {
      slashCount++;
    }
    if (slashCount % 2 === 0) return true;
  }
  return false;
}

function isInsidePipeTableCell(text: string, markerIndex: number): boolean {
  const lineStart = text.lastIndexOf("\n", markerIndex - 1) + 1;
  const nextNewline = text.indexOf("\n", markerIndex);
  const lineEnd = nextNewline === -1 ? text.length : nextNewline;
  return (
    hasUnescapedPipe(text, lineStart, markerIndex) &&
    hasUnescapedPipe(text, markerIndex, lineEnd)
  );
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
    if (rhsTerms.length < 2) return null;
    const lines = [
      `${lhs} &= ${rhsTerms[0]}`,
      ...rhsTerms.slice(1).map((term) => `& ${term}`),
    ];
    return `\\begin{aligned}${lines.join(" \\\\ ")}\\end{aligned}`;
  }

  const terms = splitTopLevelAdditiveTerms(math);
  if (terms.length < 3) return null;
  const lines = [`& ${terms[0]}`, ...terms.slice(1).map((term) => `& ${term}`)];
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

function isEscapedDelimiter(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function canOpenInlineDollarMath(text: string, index: number): boolean {
  if (text[index] !== "$") return false;
  if (isEscapedDelimiter(text, index)) return false;
  if (text[index + 1] === "$") return false;
  const next = text[index + 1] || "";
  return Boolean(next && !/\s/.test(next));
}

function canCloseInlineDollarMath(text: string, index: number): boolean {
  if (text[index] !== "$") return false;
  if (isEscapedDelimiter(text, index)) return false;
  if (text[index - 1] === "$") return false;
  const previous = text[index - 1] || "";
  const next = text[index + 1] || "";
  if (!previous || /\s/.test(previous)) return false;
  // In prose, a dollar sign followed by a digit is almost always another
  // currency amount, not the closing delimiter for math.
  if (/\d/.test(next)) return false;
  return true;
}

function findClosingInlineDollarMath(text: string, openIndex: number): number {
  for (let index = openIndex + 1; index < text.length; index++) {
    if (text[index] !== "$") continue;
    if (canCloseInlineDollarMath(text, index)) return index;
  }
  return -1;
}

function findClosingEscapedMathDelimiter(
  text: string,
  openIndex: number,
  closeDelimiter: "\\)" | "\\]",
): number {
  for (let index = openIndex + 2; index < text.length - 1; index++) {
    if (text.slice(index, index + 2) !== closeDelimiter) continue;
    if (!isEscapedDelimiter(text, index)) return index;
  }
  return -1;
}

function renderInlineMathToken(
  math: string,
  copySource: string,
  display: boolean,
): string {
  const trimmed = math.trim();
  if (!trimmed) return escapeHtml(copySource);

  if (zoteroNoteMode) {
    return `<span class="math">$${escapeHtml(trimmed)}$</span>`;
  }

  if (display) {
    return wrapCopyable(
      `<span class="math-display-inline">${renderDisplayLatex(trimmed)}</span>`,
      copySource,
      "math",
      "inline",
    );
  }

  return wrapCopyable(
    `<span class="math-inline">${renderLatex(trimmed, false)}</span>`,
    copySource,
    "math",
    "inline",
  );
}

function createMathExtensions() {
  return [
    {
      name: "llmMathBlock",
      level: "block" as const,
      start(src: string) {
        const dollar = src.indexOf("$$");
        const bracket = src.indexOf("\\[");
        if (dollar < 0) return bracket >= 0 ? bracket : undefined;
        if (bracket < 0) return dollar;
        return Math.min(dollar, bracket);
      },
      tokenizer(src: string) {
        const dollarMatch = src.match(
          /^\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$(?:[ \t]*(?:\n+|$))/,
        );
        if (dollarMatch) {
          return {
            type: "llmMathBlock",
            raw: dollarMatch[0],
            text: dollarMatch[1],
            display: true,
            block: true,
          } satisfies MarkdownMathToken;
        }

        const bracketMatch = src.match(
          /^\\\[[ \t]*\n?([\s\S]+?)\n?[ \t]*\\\](?:[ \t]*(?:\n+|$))/,
        );
        if (bracketMatch) {
          return {
            type: "llmMathBlock",
            raw: bracketMatch[0],
            text: bracketMatch[1],
            display: true,
            block: true,
          } satisfies MarkdownMathToken;
        }

        return undefined;
      },
      renderer(token: MarkdownMathToken) {
        return renderMathBlock(token.raw);
      },
    },
    {
      name: "llmInlineMath",
      level: "inline" as const,
      start(src: string) {
        const candidates = ["$", "\\(", "\\["]
          .map((needle) => src.indexOf(needle))
          .filter((index) => index >= 0);
        return candidates.length ? Math.min(...candidates) : undefined;
      },
      tokenizer(src: string) {
        if (src.startsWith("\\(")) {
          const closeIndex = findClosingEscapedMathDelimiter(src, 0, "\\)");
          if (closeIndex > 2) {
            const raw = src.slice(0, closeIndex + 2);
            return {
              type: "llmInlineMath",
              raw,
              text: src.slice(2, closeIndex),
              display: false,
              block: false,
            } satisfies MarkdownMathToken;
          }
        }

        if (src.startsWith("\\[")) {
          const closeIndex = findClosingEscapedMathDelimiter(src, 0, "\\]");
          if (closeIndex > 2) {
            const raw = src.slice(0, closeIndex + 2);
            return {
              type: "llmInlineMath",
              raw,
              text: src.slice(2, closeIndex),
              display: true,
              block: false,
            } satisfies MarkdownMathToken;
          }
        }

        if (canOpenInlineDollarMath(src, 0)) {
          const closeIndex = findClosingInlineDollarMath(src, 0);
          if (closeIndex > 0) {
            const raw = src.slice(0, closeIndex + 1);
            return {
              type: "llmInlineMath",
              raw,
              text: src.slice(1, closeIndex),
              display: false,
              block: false,
            } satisfies MarkdownMathToken;
          }
        }

        return undefined;
      },
      renderer(token: MarkdownMathToken) {
        return renderInlineMathToken(token.text, token.raw, token.display);
      },
    },
  ];
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
  const codeBlockRegex = /```[ \t]*([^\s`]*)[^\n`]*\n?([\s\S]*?)```/g;
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

/**
 * Pre-process raw markdown to insert line breaks before block-level markers
 * (headers, blockquotes) that the model emitted mid-line —
 * e.g. `...drift. (Zheng et al., 2026) ### 2. In the Results`
 *
 * For headers (`#{1,4} `): triggers whenever the marker appears mid-line
 * after any non-newline character followed by whitespace.  Multi-hash
 * headers (`## `, `### `, `#### `) are unambiguous markers that virtually
 * never appear as legitimate inline text.
 *
 * For blockquotes (`> `): triggers only after sentence-ending or
 * citation-ending punctuation ( `.` `!` `?` `:` `)` `]` `"` ) to avoid
 * splitting comparison operators like `x > 5`.
 */
export function normalizeBlockBoundaries(text: string): string {
  let result = text;

  // Header markers (#{1,4} ) mid-line after any content + whitespace.
  // Safe because #{1,4} followed by a space is an unambiguous header marker
  // and almost never appears as inline text outside code blocks (which are
  // already extracted before this function is called).
  result = result.replace(
    /([^\n])([ \t]+)(#{1,4} )/g,
    (match, before: string, spaces: string, marker: string, offset: number) => {
      const markerIndex = offset + before.length + spaces.length;
      return isInsidePipeTableCell(result, markerIndex)
        ? match
        : `${before}\n\n${marker}`;
    },
  );

  // Blockquote markers (> ) after sentence / citation-ending punctuation.
  // More conservative than headers because `>` is common in comparisons.
  result = result.replace(
    /([.!?:)\]"])([ \t]+)(> )/g,
    (match, before: string, spaces: string, marker: string, offset: number) => {
      const markerIndex = offset + before.length + spaces.length;
      return isInsidePipeTableCell(result, markerIndex)
        ? match
        : `${before}\n\n${marker}`;
    },
  );

  // Ordered-list markers after citation-like parentheticals. Models often emit
  // source labels such as `(Methods, "...") 4. **Next step**` immediately after
  // a quote block; CommonMark treats that as paragraph text unless we create a
  // block boundary first.
  result = result.replace(
    /(\([^()\n]{2,240}\))([ \t]+)(\d{1,3}\.\s+(?=\S))/g,
    (match, before: string, spaces: string, marker: string, offset: number) => {
      const markerIndex = offset + before.length + spaces.length;
      return isInsidePipeTableCell(result, markerIndex)
        ? match
        : `${before}\n\n${marker}`;
    },
  );

  // Unordered-list markers after source-like parentheticals hit the same
  // failure mode as ordered lists, but `-` and `*` are common prose
  // characters, so only split after labels that look like paper sources.
  result = result.replace(
    /(\([^()\n]{2,240}\))([ \t]+)([-*]\s+(?=\S))/g,
    (match, before: string, spaces: string, marker: string, offset: number) => {
      const markerIndex = offset + before.length + spaces.length;
      if (
        !isLikelySourceParenthetical(before) ||
        isInsidePipeTableCell(result, markerIndex)
      ) {
        return match;
      }
      return `${before}\n\n${marker}`;
    },
  );

  // Some model outputs start the next section as emphasized text instead of a
  // markdown heading, e.g. `(Smith, 2026) *Environment Classification:* ...`.
  // Split only heading-like emphasized labels with a trailing colon.
  result = result.replace(
    /(\([^()\n]{2,240}\))([ \t]+)((?:\*\*[^*\n]{2,120}(?::|：)\*\*|\*\*[^*\n]{2,120}\*\*(?::|：)|\*[^*\n]{2,120}(?::|：)\*|\*[^*\n]{2,120}\*(?::|：))[ \t]+(?=\S))/g,
    (match, before: string, spaces: string, marker: string, offset: number) => {
      const markerIndex = offset + before.length + spaces.length;
      if (
        !isLikelySourceParenthetical(before) ||
        isInsidePipeTableCell(result, markerIndex)
      ) {
        return match;
      }
      return `${before}\n\n${marker}`;
    },
  );

  const lines = result.split(/\r?\n/);
  const normalizedLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const previous = normalizedLines[normalizedLines.length - 1] || "";
    const previousTrimmed = previous.trim();
    const previousIsParenthetical = /^\([^()\n]{2,240}\)$/.test(
      previousTrimmed,
    );
    if (
      trimmed &&
      previousIsParenthetical &&
      previousTrimmed &&
      !isOrderedListLine(previousTrimmed) &&
      (isOrderedListLine(trimmed) ||
        (isLikelySourceParenthetical(previousTrimmed) &&
          (isUnorderedListLine(trimmed) || isEmphasizedHeadingLine(trimmed))))
    ) {
      normalizedLines.push("");
    }
    normalizedLines.push(line);
  }

  result = normalizedLines.join("\n");

  return result;
}

function isOrderedListLine(trimmed: string): boolean {
  return /^\d+\.\s+/.test(trimmed);
}

function isUnorderedListLine(trimmed: string): boolean {
  return /^[-*]\s+/.test(trimmed);
}

function isLikelySourceParenthetical(value: string): boolean {
  const inner = value.replace(/^\(|\)$/g, "").trim();
  if (!inner) return false;
  return (
    /\b(?:19|20)\d{2}[a-z]?\b/i.test(inner) ||
    /\bet\s+al\.?\b/i.test(inner) ||
    /\[[^\]]+\]/.test(inner) ||
    /\battachment\s+under\b/i.test(inner) ||
    /^paper(?:\s+\d+)?$/i.test(inner) ||
    /^[\p{L}][\p{L}'’.-]+(?:\s+(?:and|&)\s+[\p{L}][\p{L}'’.-]+)?$/u.test(inner)
  );
}

function isEmphasizedHeadingLine(trimmed: string): boolean {
  return /^(?:\*\*[^*\n]{2,120}(?::|：)\*\*|\*\*[^*\n]{2,120}\*\*(?::|：)|\*[^*\n]{2,120}(?::|：)\*|\*[^*\n]{2,120}\*(?::|：))(?:\s+|$)/.test(
    trimmed,
  );
}

function isTableDividerLine(trimmed: string): boolean {
  return /^\|?[\s:-]+(?:\|[\s:-]+)+\|?$/.test(trimmed) && trimmed.includes("-");
}

function readTableCells(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of row) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  cells.push(current.trim());
  return cells.filter((cell, idx, arr) => {
    const isEdge = (idx === 0 || idx === arr.length - 1) && cell === "";
    return !isEdge;
  });
}

function findTableDividerIndex(lines: string[], index: number): number {
  const first = lines[index]?.trim() || "";
  if (!first.includes("|")) return -1;
  for (
    let candidate = index + 1;
    candidate < lines.length && candidate <= index + 3;
    candidate++
  ) {
    const trimmed = lines[candidate]?.trim() || "";
    if (!trimmed) return -1;
    if (isTableDividerLine(trimmed)) return candidate;
  }
  return -1;
}

function isTableStart(lines: string[], index: number): boolean {
  return findTableDividerIndex(lines, index) >= 0;
}

function hasExpectedTableCells(row: string, expectedCells: number): boolean {
  return readTableCells(row).length >= expectedCells;
}

function normalizeTableLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

function collectTableBlock(
  lines: string[],
  startIndex: number,
): { raw: string; nextIndex: number } | null {
  const dividerIndex = findTableDividerIndex(lines, startIndex);
  if (dividerIndex < 0) return null;

  const header = normalizeTableLine(
    lines.slice(startIndex, dividerIndex).join(" "),
  );
  const divider = normalizeTableLine(lines[dividerIndex] || "");
  const expectedCells = Math.max(
    readTableCells(header).length,
    readTableCells(divider).length,
  );
  if (expectedCells < 2) return null;

  const tableLines = [header, divider];
  let currentRow = "";
  let i = dividerIndex + 1;

  while (i < lines.length) {
    const trimmed = normalizeTableLine(lines[i] || "");
    if (!trimmed) break;
    if (
      !currentRow &&
      (/^#{1,4}\s+/.test(trimmed) ||
        /^>/.test(trimmed) ||
        /^---+$/.test(trimmed) ||
        /^\$\$/.test(trimmed) ||
        /^\\\[/.test(trimmed) ||
        isOrderedListLine(trimmed) ||
        isUnorderedListLine(trimmed))
    ) {
      break;
    }

    if (currentRow && hasExpectedTableCells(currentRow, expectedCells)) {
      if (trimmed.startsWith("|")) {
        tableLines.push(currentRow);
        currentRow = trimmed;
      } else if (currentRow.trim().endsWith("|")) {
        break;
      } else {
        currentRow = `${currentRow} ${trimmed}`;
      }
    } else {
      currentRow = currentRow ? `${currentRow} ${trimmed}` : trimmed;
    }
    i++;
  }

  if (currentRow && currentRow.includes("|")) {
    tableLines.push(currentRow);
  }

  return { raw: tableLines.join("\n"), nextIndex: i };
}

function isStructuralBlockStart(lines: string[], index: number): boolean {
  const trimmed = lines[index]?.trim() || "";
  return (
    /^#{1,4}\s+/.test(trimmed) ||
    /^>/.test(trimmed) ||
    /^---+$/.test(trimmed) ||
    /^\$\$/.test(trimmed) ||
    /^\\\[/.test(trimmed) ||
    isTableStart(lines, index)
  );
}

function collectListBlock(
  lines: string[],
  startIndex: number,
  ordered: boolean,
): { raw: string; nextIndex: number } {
  const listLines: string[] = [];
  const isSameListLine = ordered ? isOrderedListLine : isUnorderedListLine;
  const isOtherListLine = ordered ? isUnorderedListLine : isOrderedListLine;
  let i = startIndex;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    // Allow blank lines between list items when the next non-empty line is
    // still the same list kind, matching the previous behavior.
    if (!trimmed) {
      let next = i + 1;
      while (next < lines.length && !lines[next].trim()) {
        next++;
      }
      if (next < lines.length && isSameListLine(lines[next].trim())) {
        i = next;
        continue;
      }
      break;
    }

    if (
      listLines.length > 0 &&
      !isSameListLine(trimmed) &&
      (isOtherListLine(trimmed) || isStructuralBlockStart(lines, i))
    ) {
      break;
    }

    listLines.push(lines[i]);
    i++;
  }

  return { raw: listLines.join("\n"), nextIndex: i };
}

/** Split non-code text into blocks by blank lines and structure */
function splitTextBlocks(text: string): TextBlock[] {
  const normalized = normalizeBlockBoundaries(text);
  const blocks: TextBlock[] = [];
  const lines = normalized.split(/\r?\n/);

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

    // Table
    const tableBlock = collectTableBlock(lines, i);
    if (tableBlock) {
      const { raw, nextIndex } = tableBlock;
      i = nextIndex;
      blocks.push({ type: "table", content: raw, raw });
      continue;
    }

    // Ordered list
    if (isOrderedListLine(trimmed)) {
      const { raw, nextIndex } = collectListBlock(lines, i, true);
      i = nextIndex;
      blocks.push({ type: "list", content: raw, raw });
      continue;
    }

    // Unordered list
    if (isUnorderedListLine(trimmed)) {
      const { raw, nextIndex } = collectListBlock(lines, i, false);
      i = nextIndex;
      blocks.push({ type: "list", content: raw, raw });
      continue;
    }

    // Paragraph (collect until blank line or structural element)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^#{1,4}\s+/.test(lines[i].trim()) &&
      !isUnorderedListLine(lines[i].trim()) &&
      !isOrderedListLine(lines[i].trim()) &&
      !/^>/.test(lines[i].trim()) &&
      !/^---+$/.test(lines[i].trim()) &&
      !/^\$\$/.test(lines[i].trim()) &&
      !/^\\\[/.test(lines[i].trim()) &&
      !isTableStart(lines, i)
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

function normalizeHardWrappedTables(text: string): string {
  const lines = text.split(/\r?\n/);
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const tableBlock = collectTableBlock(lines, i);
    if (tableBlock) {
      result.push(tableBlock.raw);
      i = tableBlock.nextIndex;
      if (i < lines.length && lines[i].trim()) {
        result.push("");
      }
      continue;
    }
    result.push(lines[i]);
    i++;
  }

  return result.join("\n");
}

function normalizeMarkdownSegmentForMarked(text: string): string {
  return normalizeHardWrappedTables(normalizeBlockBoundaries(text));
}

function normalizeMarkdownForMarked(text: string): string {
  if (!hasBalancedCodeBlocks(text)) return text;

  const codeBlockRegex = /```[ \t]*([^\s`]*)[^\n`]*\n?([\s\S]*?)```/g;
  let result = "";
  let lastEnd = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastEnd) {
      result += normalizeMarkdownSegmentForMarked(
        text.slice(lastEnd, match.index),
      );
    }
    result += match[0];
    lastEnd = match.index + match[0].length;
  }

  if (lastEnd < text.length) {
    result += normalizeMarkdownSegmentForMarked(text.slice(lastEnd));
  }

  return result;
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
  const langMatch = raw.match(/^```[ \t]*([^\s`]*)/);
  const lang = normalizeFenceLanguage(langMatch?.[1]);
  const label = lang || "text";
  if (zoteroNoteMode) {
    const langClass = lang ? ` class="lang-${lang}"` : "";
    return `<pre${langClass}><code>${escapeHtml(code.trim())}</code></pre>`;
  }
  const codeHtml = renderCodeHtml(code, lang);

  const safeSvgMarkup = lang === "svg" ? buildSafeSvgMarkup(code) : null;
  const svgPreviewUri = safeSvgMarkup
    ? buildSafeSvgDataUri(safeSvgMarkup)
    : null;
  const svgPreview =
    safeSvgMarkup && svgPreviewUri
      ? `<div class="llm-svg-preview" data-llm-svg-source="${escapeAttribute(safeSvgMarkup)}" aria-label="SVG preview"><img src="${escapeAttribute(svgPreviewUri)}" alt="SVG preview" /></div>`
      : "";
  const mermaidPreview = isMermaidFenceLanguage(lang)
    ? renderMermaidPreview(code)
    : "";
  const html = [
    `<div class="llm-codeblock-shell" data-code-lang="${escapeAttribute(label)}">`,
    `<div class="llm-codeblock-header"><span class="llm-codeblock-lang">${escapeHtml(label)}</span></div>`,
    svgPreview,
    mermaidPreview,
    `<div class="llm-codeblock-body">${codeHtml}</div>`,
    `</div>`,
  ].join("");
  return wrapCopyable(html, raw.trim(), "code");
}

/** Render display math block */
function renderMathBlock(content: string): string {
  // Remove $$ or \[...\] delimiters
  const copySource = content.trim();
  let math = copySource;
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
  return wrapCopyable(
    `<div class="math-display">${rendered}</div>`,
    copySource,
    "math",
  );
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

function normalizeSoftBreaks(content: string): string {
  const lines = content.split(/\r?\n/);
  let result = "";
  let previousLineHadHardBreak = false;

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    const hardBreak = / {2,}$/.test(rawLine) || /\\$/.test(rawLine);
    const lineText = rawLine
      .replace(/\\$/, "")
      .replace(/[ \t]+$/, "")
      .trim();

    if (index > 0) {
      if (previousLineHadHardBreak) {
        result += HARD_BREAK_TOKEN;
      } else if (!/^[,.;:!?%)}\]"'’”]/.test(lineText)) {
        result += " ";
      }
    }
    result += lineText;
    previousLineHadHardBreak = hardBreak;
  }

  return result;
}

function renderInlineWithSoftBreaks(content: string): string {
  return renderInline(normalizeSoftBreaks(content))
    .split(HARD_BREAK_TOKEN)
    .join("<br/>");
}

function normalizeInlineTextToken(text: string): string {
  if (!/[\r\n]/.test(text)) return text;

  const lines = text.split(/\r?\n/);
  let result = lines[0].replace(/[ \t]+$/, "");
  let previousLineHadHardBreak =
    / {2,}$/.test(lines[0]) || /\\$/.test(lines[0]);

  for (let index = 1; index < lines.length; index++) {
    const rawLine = lines[index];
    const hardBreak = / {2,}$/.test(rawLine) || /\\$/.test(rawLine);
    const lineText = rawLine
      .replace(/\\$/, "")
      .replace(/[ \t]+$/, "")
      .trim();

    if (previousLineHadHardBreak) {
      result += HARD_BREAK_TOKEN;
    } else if (!/^[,.;:!?%)}\]"'’”]/.test(lineText)) {
      result += " ";
    }
    result += lineText;
    previousLineHadHardBreak = hardBreak;
  }

  if (/[ \t]$/.test(text) && result && !/[ \t]$/.test(result)) {
    return `${result} `;
  }
  return result;
}

/** Render list (ordered or unordered) */
function renderList(content: string): string {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  const orderedMatch = lines[0]?.trim().match(/^(\d+)\.\s+/);
  const isOrdered = Boolean(orderedMatch);
  const tag = isOrdered ? "ol" : "ul";
  const start = orderedMatch ? parseInt(orderedMatch[1], 10) : 1;
  const itemLines: string[][] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const markerMatch = isOrdered
      ? trimmed.match(/^\d+\.\s+/)
      : trimmed.match(/^[-*]\s+/);
    if (markerMatch) {
      itemLines.push([
        line.trimStart().replace(isOrdered ? /^\d+\.\s+/ : /^[-*]\s+/, ""),
      ]);
    } else if (itemLines.length) {
      itemLines[itemLines.length - 1].push(line.trimStart());
    }
  }

  const items = itemLines.map(
    (item) => `<li>${renderInlineWithSoftBreaks(item.join("\n"))}</li>`,
  );

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
  // Rejoin and recursively parse through block pipeline so that multi-line
  // constructs (display math, code blocks, etc.) inside blockquotes work.
  const innerText = innerLines.join("\n");
  const innerBlocks = splitTextBlocks(innerText);
  const innerHtml = innerBlocks
    .map((block) => {
      try {
        return renderBlock(block);
      } catch {
        return `<div class="render-fallback">${escapeHtml(block.raw)}</div>`;
      }
    })
    .join("\n");
  return `<blockquote>${innerHtml}</blockquote>`;
}

/** Render table */
function renderTable(content: string): string {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    return `<p>${escapeHtml(content)}</p>`;
  }

  const headerCells = readTableCells(lines[0]);
  // Skip divider line (lines[1])
  const bodyRows = lines.slice(2).map((line) => readTableCells(line));

  const headerHtml = `<tr>${headerCells.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr>`;
  const bodyHtml = bodyRows
    .map(
      (cells) =>
        `<tr>${cells.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`,
    )
    .join("");

  const html = `<div class="llm-table-scroll"><table><thead>${headerHtml}</thead><tbody>${bodyHtml}</tbody></table></div>`;
  if (zoteroNoteMode) return html;
  return wrapCopyable(html, content.trim(), "table");
}

/** Render paragraph */
function renderParagraph(content: string): string {
  return `<p>${renderInlineWithSoftBreaks(content)}</p>`;
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

  // 2. Inline math ($...$). Parse valid delimiter pairs instead of relying on
  // a global "$" count so one prose currency amount cannot disable all math.
  // Display math first ($$...$$)
  result = result.replace(/\$\$([^$]+?)\$\$/g, (_match, math) => {
    const copySource = `$$${math}$$`;
    if (zoteroNoteMode) {
      // Zotero note-editor: <span class="math">$LaTeX$</span>
      return protect(`<span class="math">$${escapeHtml(math.trim())}$</span>`);
    }
    const rendered = renderDisplayLatex(math.trim());
    return protect(
      wrapCopyable(
        `<span class="math-display-inline">${rendered}</span>`,
        copySource,
        "math",
        "inline",
      ),
    );
  });

  let mathRendered = "";
  let mathCursor = 0;
  for (let index = 0; index < result.length; index++) {
    if (!canOpenInlineDollarMath(result, index)) continue;
    const closeIndex = findClosingInlineDollarMath(result, index);
    if (closeIndex < 0) continue;

    const inner = result.slice(index + 1, closeIndex);
    const trimmed = inner.trim();
    if (!trimmed) continue;

    mathRendered += result.slice(mathCursor, index);
    if (zoteroNoteMode) {
      // Zotero note-editor: <span class="math">$LaTeX$</span>
      mathRendered += protect(
        `<span class="math">$${escapeHtml(trimmed)}$</span>`,
      );
    } else {
      const rendered = renderLatex(trimmed, false);
      mathRendered += protect(
        wrapCopyable(
          `<span class="math-inline">${rendered}</span>`,
          `$${inner}$`,
          "math",
          "inline",
        ),
      );
    }
    mathCursor = closeIndex + 1;
    index = closeIndex;
  }
  if (mathCursor > 0) {
    mathRendered += result.slice(mathCursor);
    result = mathRendered;
  }

  // 3. Inline code - only if balanced
  if (hasBalancedInlineDelimiter(result, "`")) {
    result = result.replace(/`([^`]+)`/g, (_match, code) => {
      return protect(`<code>${escapeHtml(code)}</code>`);
    });
  }

  // 3b. Protect <img> tags (embedded figures, data URLs, Zotero attachment keys)
  result = result.replace(
    /<img\s+[^>]*(?:src|data-attachment-key)\s*=\s*"[^"]*"[^>]*\/?>/gi,
    (match) => protect(renderSafeRawHtml(match)),
  );

  // 4. HTML escape (after protecting code, math, and images)
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

  // 10. Images ![alt](src)
  result = result.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_match, alt: string, src: string) => {
      const trimmedSrc = src.trim();
      // Try resolver first for callers that provide a safe image mapping.
      if (activeImageResolver) {
        const resolved = activeImageResolver(trimmedSrc);
        if (resolved) {
          return protect(
            `<img src="${escapeHtml(resolved)}" alt="${escapeHtml(alt)}" class="llm-chat-inline-figure" style="max-width:100%; border-radius:4px; margin:4px 0;" />`,
          );
        }
      }
      const safeSrc = sanitizeMarkdownUrl(trimmedSrc, "image");
      if (!safeSrc) return escapeHtml(alt || trimmedSrc);
      // Always render as <img> — works for file://, data:, and http(s):// URLs
      return protect(
        `<img src="${escapeAttribute(safeSrc)}" alt="${escapeAttribute(alt)}" style="max-width:100%; border-radius:4px; margin:4px 0;" />`,
      );
    },
  );

  // 11. Links [text](url)
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, text: string, href: string) => {
      const safeHref = sanitizeMarkdownUrl(href.trim(), "link");
      if (!safeHref) return text;
      return `<a href="${escapeAttribute(safeHref)}" target="_blank" rel="noopener">${text}</a>`;
    },
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

function renderMarkdownImage(
  alt: string,
  href: string,
  title: string | null | undefined,
  target: MarkdownRenderTarget,
): string {
  let resolvedSrc: string | null = null;
  const trimmedHref = href.trim();
  if (activeImageResolver) {
    resolvedSrc = activeImageResolver(trimmedHref);
  }
  const safeSrc = sanitizeMarkdownUrl(resolvedSrc || trimmedHref, "image");
  if (!safeSrc) return escapeHtml(alt || trimmedHref);

  const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
  const classAttr = target === "chat" ? ' class="llm-chat-inline-figure"' : "";
  return `<img src="${escapeAttribute(safeSrc)}" alt="${escapeAttribute(alt)}"${titleAttr}${classAttr} />`;
}

function createMarkedRenderer(
  target: MarkdownRenderTarget,
): Renderer<string, string> {
  const renderer = new Renderer<string, string>();
  const rawHtmlRenderState: RawHtmlRenderState = { stack: [] };
  const parseInlineTokens = (
    parser: { parseInline: (tokens: Tokens.Generic[]) => string },
    tokens: Tokens.Generic[],
  ): string => {
    const stackStart = rawHtmlRenderState.stack.length;
    const html = parser.parseInline(tokens);
    const danglingTags = rawHtmlRenderState.stack.splice(stackStart);
    if (!danglingTags.length) return html;
    return `${html}${danglingTags
      .reverse()
      .map((tagName) => `</${tagName}>`)
      .join("")}`;
  };

  renderer.code = function (token: Tokens.Code): string {
    return renderCodeBlock(token.text, token.raw);
  };

  renderer.html = function (token: Tokens.HTML | Tokens.Tag): string {
    return renderSafeRawHtml(token.text, rawHtmlRenderState);
  };

  renderer.heading = function (token: Tokens.Heading): string {
    if (
      !/^#{1,6}(?:\s|$)/.test(token.raw) &&
      /\n[ \t]*-{3,}[ \t]*(?:\n|$)/.test(token.raw)
    ) {
      return `<p>${parseInlineTokens(this.parser, token.tokens)}</p><hr/>`;
    }
    const level = Math.min(5, Math.max(2, token.depth + 1));
    return `<h${level}>${parseInlineTokens(this.parser, token.tokens)}</h${level}>`;
  };

  renderer.hr = function (): string {
    return "<hr/>";
  };

  renderer.blockquote = function (token: Tokens.Blockquote): string {
    return `<blockquote>${this.parser.parse(token.tokens)}</blockquote>`;
  };

  renderer.list = function (token: Tokens.List): string {
    const tag = token.ordered ? "ol" : "ul";
    const startAttr =
      token.ordered && token.start !== "" && token.start !== 1
        ? ` start="${token.start}"`
        : "";
    const items = token.items.map((item) => this.listitem(item)).join("");
    return `<${tag}${startAttr}>${items}</${tag}>`;
  };

  renderer.listitem = function (token: Tokens.ListItem): string {
    const renderChildToken = (child: Tokens.Generic): string => {
      if (child.type === "text") {
        const textToken = child as Tokens.Text;
        const inlineHtml =
          "tokens" in textToken && textToken.tokens?.length
            ? parseInlineTokens(this.parser, textToken.tokens)
            : escapeHtml(normalizeInlineTextToken(textToken.text || ""))
                .split(HARD_BREAK_TOKEN)
                .join("<br/>");
        return token.loose ? `<p>${inlineHtml}</p>` : inlineHtml;
      }
      return this.parser.parse([child], Boolean(token.loose));
    };
    let body = token.tokens.map(renderChildToken).join("");
    if (token.task) {
      const checkbox = this.checkbox({ checked: Boolean(token.checked) });
      body = body.startsWith("<p>")
        ? body.replace(/^<p>/, `<p>${checkbox} `)
        : `${checkbox} ${body}`;
    }
    return `<li>${body}</li>`;
  };

  renderer.checkbox = function (token: Tokens.Checkbox): string {
    const checked = token.checked ? ' checked="checked"' : "";
    return `<input type="checkbox" disabled="disabled"${checked} />`;
  };

  renderer.paragraph = function (token: Tokens.Paragraph): string {
    return `<p>${parseInlineTokens(this.parser, token.tokens)}</p>`;
  };

  renderer.table = function (token: Tokens.Table): string {
    const headerHtml = `<tr>${token.header
      .map((cell) => `<th>${parseInlineTokens(this.parser, cell.tokens)}</th>`)
      .join("")}</tr>`;
    const bodyHtml = token.rows
      .map(
        (row) =>
          `<tr>${row
            .map(
              (cell) =>
                `<td>${parseInlineTokens(this.parser, cell.tokens)}</td>`,
            )
            .join("")}</tr>`,
      )
      .join("");
    const html = `<div class="llm-table-scroll"><table><thead>${headerHtml}</thead><tbody>${bodyHtml}</tbody></table></div>`;
    if (zoteroNoteMode) return html;
    return wrapCopyable(html, token.raw.trim(), "table");
  };

  renderer.codespan = function (token: Tokens.Codespan): string {
    return `<code>${escapeHtml(token.text)}</code>`;
  };

  renderer.br = function (): string {
    return "<br/>";
  };

  renderer.text = function (token: Tokens.Text | Tokens.Escape): string {
    if ("tokens" in token && token.tokens?.length) {
      return parseInlineTokens(this.parser, token.tokens);
    }
    return escapeHtml(normalizeInlineTextToken(token.text))
      .split(HARD_BREAK_TOKEN)
      .join("<br/>");
  };

  renderer.link = function (token: Tokens.Link): string {
    const body = parseInlineTokens(this.parser, token.tokens);
    const safeHref = sanitizeMarkdownUrl(token.href, "link");
    if (!safeHref) return body;
    const titleAttr = token.title
      ? ` title="${escapeAttribute(token.title)}"`
      : "";
    return `<a href="${escapeAttribute(safeHref)}"${titleAttr} target="_blank" rel="noopener">${body}</a>`;
  };

  renderer.image = function (token: Tokens.Image): string {
    return renderMarkdownImage(token.text, token.href, token.title, target);
  };

  return renderer;
}

function createMarkedMarkdownRenderer(target: MarkdownRenderTarget): Marked {
  return new Marked({
    async: false,
    breaks: false,
    gfm: true,
    renderer: createMarkedRenderer(target),
    extensions: createMathExtensions(),
  });
}

export function renderMarkdownWithLegacyParser(
  text: string,
  options?: { resolveImage?: (src: string) => string | null },
): string {
  const prevResolver = activeImageResolver;
  if (options?.resolveImage) activeImageResolver = options.resolveImage;
  try {
    const blocks = splitIntoBlocks(restoreEscapedSafeRawHtmlTags(text));
    return blocks
      .map((block) => {
        try {
          return renderBlock(block);
        } catch (err) {
          console.warn("Markdown block render error:", err);
          return `<div class="render-fallback">${escapeHtml(block.raw)}</div>`;
        }
      })
      .join("\n")
      .trim();
  } catch (err) {
    console.warn("Markdown legacy render error:", err);
    return `<div class="render-fallback">${escapeHtml(text)}</div>`;
  } finally {
    activeImageResolver = prevResolver;
  }
}

function reportMarkedMarkdownFailure(err: unknown): void {
  markedMarkdownDisabled = true;
  if (markedMarkdownFailureReported) return;
  markedMarkdownFailureReported = true;
  console.warn(
    "Markdown parser failed; falling back to Zotero-compatible renderer:",
    err,
  );
}

export function __setMarkdownParserDisabledForTest(disabled: boolean): void {
  markedMarkdownDisabled = disabled;
  markedMarkdownFailureReported = false;
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
export function renderMarkdown(
  text: string,
  options?: { resolveImage?: (src: string) => string | null },
): string {
  // Handle empty input
  if (!text || !text.trim()) {
    return "";
  }

  const prevResolver = activeImageResolver;
  if (options?.resolveImage) activeImageResolver = options.resolveImage;

  try {
    if (markedMarkdownDisabled) {
      return renderMarkdownWithLegacyParser(text);
    }

    const normalized = normalizeMarkdownForMarked(
      restoreEscapedSafeRawHtmlTags(text),
    );
    const target: MarkdownRenderTarget = zoteroNoteMode
      ? "zotero-note"
      : "chat";
    const rendered = createMarkedMarkdownRenderer(target).parse(normalized);
    if (typeof rendered === "string") {
      return rendered.trim();
    }
    reportMarkedMarkdownFailure(
      new Error("Markdown parser returned non-string output"),
    );
    return renderMarkdownWithLegacyParser(text);
  } catch (err) {
    reportMarkedMarkdownFailure(err);
    return renderMarkdownWithLegacyParser(text);
  } finally {
    activeImageResolver = prevResolver;
  }
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
