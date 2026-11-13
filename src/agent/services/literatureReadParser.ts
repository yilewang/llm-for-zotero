/**
 * Pure parsers for literature_read: JATS XML (Europe PMC, PubMed Central),
 * arXiv LaTeXML HTML and the arXiv export Atom feed.
 *
 * A small tag tokenizer builds a tolerant element tree; format walkers then
 * turn it into an abstract and numbered sections of plain paragraphs. No
 * DOMParser, so the parsers run in Node unit tests. References, tables,
 * formulas, footnotes and page chrome are dropped; figure and table captions
 * stay. Fetched paper text is untrusted data.
 */

export type MarkupNode = {
  name: string;
  attrs: Record<string, string>;
  children: Array<MarkupNode | string>;
};

export type ParsedPaperSection = {
  /**
   * The paper's own section label when it has one ("2", "3.2", "Appendix A").
   * Without labels: the nesting number ("2.1"). Without a label in a labeled
   * paper: "u1", "u2". Text outside any headed section: "main", "main-2".
   */
  number: string;
  title: string;
  level: number;
  paragraphs: string[];
};

export type ParsedPaperText = {
  title?: string;
  abstract: string;
  sections: ParsedPaperSection[];
};

export type ParsedJatsArticle = ParsedPaperText & {
  authors: string[];
  year?: number;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  license?: string;
};

export type ParsedArxivEntry = {
  title: string;
  abstract: string;
  authors: string[];
  year?: number;
  doi?: string;
  pdfUrl?: string;
};

const HTML_VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const HTML_RAW_TEXT_ELEMENTS = new Set(["script", "style"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  zwnj: "",
  zwj: "",
  lrm: "",
  rlm: "",
  shy: "",
  ndash: "–",
  mdash: "—",
  minus: "−",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  prime: "′",
  Prime: "″",
  deg: "°",
  micro: "µ",
  plusmn: "±",
  times: "×",
  divide: "÷",
  le: "≤",
  ge: "≥",
  ne: "≠",
  asymp: "≈",
  approx: "≈",
  infin: "∞",
  sim: "∼",
  rarr: "→",
  larr: "←",
  harr: "↔",
  copy: "©",
  reg: "®",
  trade: "™",
  sect: "§",
  para: "¶",
  dagger: "†",
  Dagger: "‡",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
};

/** Decodes named and numeric character references; unknown ones stay. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g,
    (match, body: string) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)
        ? NAMED_ENTITIES[body]
        : match;
    },
  );
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern =
    /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    attrs[match[1].toLowerCase()] = decodeEntities(
      match[2] ?? match[3] ?? match[4] ?? "",
    );
  }
  return attrs;
}

function element(name: string, attrs: Record<string, string> = {}) {
  return { name, attrs, children: [] } as MarkupNode;
}

/**
 * Tokenizes markup into a tolerant tree: unmatched closing tags are ignored,
 * and a closing tag closes every element opened inside it. In HTML mode void
 * elements never open, and script/style bodies are skipped.
 */
export function parseMarkup(
  source: string,
  options: { html?: boolean } = {},
): MarkupNode {
  const root = element("#root");
  const stack: MarkupNode[] = [root];
  const length = source.length;
  let lowerSource: string | undefined;
  const pushText = (text: string, decode = true) => {
    if (!text) return;
    stack[stack.length - 1].children.push(decode ? decodeEntities(text) : text);
  };
  let index = 0;
  while (index < length) {
    const open = source.indexOf("<", index);
    if (open < 0) {
      pushText(source.slice(index));
      break;
    }
    if (open > index) pushText(source.slice(index, open));
    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      index = end < 0 ? length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open + 9);
      pushText(source.slice(open + 9, end < 0 ? length : end), false);
      index = end < 0 ? length : end + 3;
      continue;
    }
    const next = source[open + 1] || "";
    if (next === "!" || next === "?") {
      const end = source.indexOf(">", open);
      index = end < 0 ? length : end + 1;
      continue;
    }
    if (next === "/") {
      const end = source.indexOf(">", open);
      const name = source
        .slice(open + 2, end < 0 ? length : end)
        .trim()
        .toLowerCase();
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].name === name) {
          stack.length = depth;
          break;
        }
      }
      index = end < 0 ? length : end + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(next)) {
      pushText("<");
      index = open + 1;
      continue;
    }
    let cursor = open + 1;
    let quote = "";
    while (cursor < length) {
      const char = source[cursor];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
      cursor += 1;
    }
    const raw = source.slice(open + 1, cursor);
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const name = (/^[^\s/>]+/.exec(body)?.[0] || "").toLowerCase();
    const node = element(name, parseAttributes(body.slice(name.length)));
    stack[stack.length - 1].children.push(node);
    index = cursor + 1;
    if (selfClosing || (options.html && HTML_VOID_ELEMENTS.has(name))) continue;
    if (options.html && HTML_RAW_TEXT_ELEMENTS.has(name)) {
      lowerSource ??= source.toLowerCase();
      const end = lowerSource.indexOf(`</${name}`, index);
      const close = end < 0 ? length : source.indexOf(">", end);
      index = close < 0 ? length : close + 1;
      continue;
    }
    stack.push(node);
  }
  return root;
}

function isElement(value: MarkupNode | string): value is MarkupNode {
  return typeof value !== "string";
}

function hasClass(node: MarkupNode, name: string): boolean {
  const value = node.attrs.class;
  return Boolean(value) && value.split(/\s+/).includes(name);
}

function findFirst(
  node: MarkupNode,
  match: (candidate: MarkupNode) => boolean,
): MarkupNode | null {
  for (const child of node.children) {
    if (!isElement(child)) continue;
    if (match(child)) return child;
    const found = findFirst(child, match);
    if (found) return found;
  }
  return null;
}

function findAll(
  node: MarkupNode,
  match: (candidate: MarkupNode) => boolean,
  found: MarkupNode[] = [],
): MarkupNode[] {
  for (const child of node.children) {
    if (!isElement(child)) continue;
    if (match(child)) found.push(child);
    else findAll(child, match, found);
  }
  return found;
}

function childElements(node: MarkupNode, name?: string): MarkupNode[] {
  return node.children.filter(
    (child): child is MarkupNode =>
      isElement(child) && (!name || child.name === name),
  );
}

function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** All text below a node, minus the subtrees `skip` rejects. */
function plainText(
  node: MarkupNode | null | undefined,
  skip: (candidate: MarkupNode) => boolean = () => false,
): string {
  if (!node) return "";
  const parts: string[] = [];
  const visit = (current: MarkupNode) => {
    for (const child of current.children) {
      if (!isElement(child)) parts.push(child);
      else if (!skip(child)) visit(child);
    }
  };
  visit(node);
  return normalizeSpace(parts.join(""));
}

type CollectedSection = {
  title: string;
  level: number;
  paragraphs: string[];
  /** The paper's own label for the section, such as "3.2". */
  label?: string;
  /** Text outside any headed section. */
  loose?: boolean;
};

/** "3.2. " -> "3.2"; "§2" -> "2"; empty when nothing is left. */
function normalizeSectionLabel(value: string): string {
  return normalizeSpace(value)
    .replace(/^§\s*/, "")
    .replace(/[.:]+$/, "")
    .trim();
}

/** Gathers inline text into paragraphs of the section being walked. */
class SectionCollector {
  readonly sections: CollectedSection[] = [];
  private readonly path: CollectedSection[] = [];
  private loose: CollectedSection | null = null;
  private buffer: string[] = [];

  constructor(private readonly looseTitle: string) {}

  text(value: string): void {
    this.buffer.push(value);
  }

  flush(): void {
    const paragraph = normalizeSpace(this.buffer.join(""));
    this.buffer = [];
    if (!paragraph) return;
    let target = this.path[this.path.length - 1];
    if (!target) {
      if (!this.loose) {
        this.loose = {
          title: this.looseTitle,
          level: 1,
          paragraphs: [],
          loose: true,
        };
        this.sections.push(this.loose);
      }
      target = this.loose;
    }
    target.paragraphs.push(paragraph);
  }

  open(): void {
    this.flush();
    const section = {
      title: "",
      level: this.path.length + 1,
      paragraphs: [],
    };
    this.sections.push(section);
    this.path.push(section);
    this.loose = null;
  }

  title(value: string): void {
    const section = this.path[this.path.length - 1];
    if (section && !section.title) section.title = value;
  }

  label(value: string): void {
    const section = this.path[this.path.length - 1];
    const label = normalizeSectionLabel(value);
    if (section && !section.label && label) section.label = label;
  }

  close(): void {
    this.flush();
    this.path.pop();
  }
}

/**
 * Drops sections without text in their subtree and numbers the rest. A paper
 * that labels its sections keeps its own labels, so a lookup by number
 * matches the paper's "3.2". Otherwise sections are numbered by nesting
 * ("1", "1.1", ...). Loose text never shifts a number: it is "main" only.
 */
function numberSections(sections: CollectedSection[]): ParsedPaperSection[] {
  const keep = sections.map((section, index) => {
    if (section.paragraphs.length) return true;
    for (let next = index + 1; next < sections.length; next += 1) {
      if (sections[next].level <= section.level) break;
      if (sections[next].paragraphs.length) return true;
    }
    return false;
  });
  const labeled = sections.some(
    (section, index) => keep[index] && !section.loose && section.label,
  );
  const counters: number[] = [];
  const result: ParsedPaperSection[] = [];
  let previousLevel = 0;
  let unlabeled = 0;
  let loose = 0;
  sections.forEach((section, index) => {
    if (!keep[index]) return;
    // A dropped parent must not leave a gap in the numbering depth.
    const level = Math.min(section.level, previousLevel + 1);
    previousLevel = level;
    let number: string;
    if (section.loose) {
      loose += 1;
      number = loose === 1 ? "main" : `main-${loose}`;
    } else if (labeled) {
      unlabeled += section.label ? 0 : 1;
      number = section.label || `u${unlabeled}`;
    } else {
      counters.length = level;
      counters[level - 1] = (counters[level - 1] || 0) + 1;
      for (let depth = 0; depth < level - 1; depth += 1) {
        counters[depth] ||= 1;
      }
      number = counters.join(".");
    }
    result.push({
      number,
      title: section.title || "Untitled section",
      level,
      paragraphs: section.paragraphs,
    });
  });
  return result;
}

// --- JATS ---------------------------------------------------------------

const JATS_SKIPPED = new Set([
  "ref-list",
  "disp-formula",
  "disp-formula-group",
  "tex-math",
  "fn-group",
  "fn",
  "supplementary-material",
  "graphic",
  "inline-graphic",
  "media",
  "table",
  "table-wrap-foot",
  "object-id",
  "glossary",
  "processing-meta",
  "permissions",
  "alt-text",
]);

const JATS_BLOCKS = new Set([
  "p",
  "list-item",
  "def-item",
  "disp-quote",
  "statement",
  "verse-group",
]);

const REFERENCE_SECTION_TITLE =
  /^(references?|bibliography|literature cited|works cited|reference list|references and notes)$/i;

function isJatsReferenceSection(node: MarkupNode): boolean {
  const type = (node.attrs["sec-type"] || "").toLowerCase();
  if (type === "ref-list" || type === "references" || type === "bibliography")
    return true;
  const title = childElements(node, "title")[0];
  return REFERENCE_SECTION_TITLE.test(plainText(title));
}

function captionParagraph(node: MarkupNode): string {
  const label = plainText(childElements(node, "label")[0]);
  const caption = childElements(node, "caption")[0];
  if (!caption) return "";
  // Caption title and paragraphs are blocks: keep a space between them.
  const out = new SectionCollector("");
  walkJats(caption, out);
  out.flush();
  const text = out.sections.flatMap((section) => section.paragraphs).join(" ");
  if (!text) return "";
  return label ? `${label.replace(/[.:]$/, "")}: ${text}` : text;
}

/** The alttext, or the MathML's own text when the markup has no alttext. */
function mathAltText(node: MarkupNode): string {
  const alt =
    normalizeSpace(node.attrs.alttext || "") ||
    plainText(node, (child) =>
      /^(?:mml:)?annotation(?:-xml)?$/.test(child.name),
    );
  return alt ? ` ${alt} ` : "";
}

function walkJats(node: MarkupNode, out: SectionCollector): void {
  for (const child of node.children) {
    if (!isElement(child)) {
      out.text(child);
      continue;
    }
    const name = child.name;
    if (JATS_SKIPPED.has(name) || name === "label") continue;
    if (name === "mml:math" || name === "math") {
      out.text(mathAltText(child));
      continue;
    }
    if (
      name === "sec" ||
      name === "ack" ||
      name === "app" ||
      name === "notes" ||
      name === "bio"
    ) {
      if (isJatsReferenceSection(child)) continue;
      out.open();
      const title = childElements(child, "title")[0];
      out.label(plainText(childElements(child, "label")[0]));
      out.title(
        plainText(title) ||
          (name === "ack"
            ? "Acknowledgments"
            : name === "app"
              ? "Appendix"
              : ""),
      );
      walkJats(
        {
          ...child,
          children: child.children.filter((entry) => entry !== title),
        },
        out,
      );
      out.close();
      continue;
    }
    if (name === "fig" || name === "table-wrap" || name === "boxed-text") {
      out.flush();
      if (name === "boxed-text") {
        walkJats(child, out);
      } else {
        out.text(captionParagraph(child));
      }
      out.flush();
      continue;
    }
    if (name === "title" || JATS_BLOCKS.has(name)) {
      out.flush();
      walkJats(child, out);
      out.flush();
      continue;
    }
    if (name === "break") {
      out.text(" ");
      continue;
    }
    walkJats(child, out);
  }
}

function jatsAbstract(abstract: MarkupNode | undefined): string {
  if (!abstract) return "";
  const out = new SectionCollector("");
  const children = abstract.children.filter(
    (child) =>
      !(
        isElement(child) &&
        child.name === "title" &&
        /^(abstract|summary)$/i.test(plainText(child))
      ),
  );
  walkJats({ ...abstract, children }, out);
  out.flush();
  return out.sections
    .map((section) => {
      const text = section.paragraphs.join(" ");
      return section.title && !/^(abstract|summary)$/i.test(section.title)
        ? `${section.title.replace(/[.:]$/, "")}: ${text}`
        : section.paragraphs.join("\n\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function jatsAuthors(meta: MarkupNode): string[] {
  const authors: string[] = [];
  for (const contrib of findAll(meta, (node) => node.name === "contrib")) {
    const type = contrib.attrs["contrib-type"];
    if (type && type !== "author") continue;
    const name = findFirst(contrib, (node) => node.name === "name");
    if (name) {
      const surname = plainText(childElements(name, "surname")[0]);
      const given = plainText(childElements(name, "given-names")[0]);
      const full = [given, surname].filter(Boolean).join(" ");
      if (full) authors.push(full);
      continue;
    }
    const collab = plainText(
      findFirst(contrib, (node) => node.name === "collab"),
    );
    if (collab) authors.push(collab);
  }
  return authors;
}

function jatsLicense(meta: MarkupNode): string | undefined {
  const license = findFirst(meta, (node) => node.name === "license");
  if (!license) return undefined;
  const href =
    license.attrs["xlink:href"] ||
    plainText(findFirst(license, (node) => node.name === "ali:license_ref"));
  if (href) return href;
  const text = plainText(license);
  // A license stated only in prose usually still names its URL.
  const url = /https?:\/\/[^\s"<>]+[^\s"<>.,;)]/.exec(text)?.[0];
  return url || (text ? text.slice(0, 200) : undefined);
}

/**
 * Parses a JATS article, from Europe PMC fullTextXML or NCBI efetch (where
 * the article sits in a pmc-articleset). Null when there is no article.
 */
export function parseJatsArticle(xml: string): ParsedJatsArticle | null {
  const root = parseMarkup(xml);
  const article = findFirst(root, (node) => node.name === "article");
  if (!article) return null;
  const front = childElements(article, "front")[0];
  const meta =
    (front && findFirst(front, (node) => node.name === "article-meta")) ||
    element("article-meta");
  const abstracts = findAll(meta, (node) => node.name === "abstract");
  const abstract =
    abstracts.find((node) => !node.attrs["abstract-type"]) || abstracts[0];
  const out = new SectionCollector("Main text");
  const body = childElements(article, "body")[0];
  if (body) walkJats(body, out);
  out.flush();
  const back = childElements(article, "back")[0];
  if (back) walkJats(back, out);
  out.flush();
  const ids: Record<string, string> = {};
  for (const id of childElements(meta, "article-id")) {
    const type = id.attrs["pub-id-type"];
    if (type && !ids[type]) ids[type] = plainText(id);
  }
  const yearText = plainText(
    findFirst(meta, (node) => node.name === "pub-date")?.children.find(
      (child): child is MarkupNode => isElement(child) && child.name === "year",
    ),
  );
  const year = parseInt(yearText, 10);
  return {
    title:
      plainText(findFirst(meta, (node) => node.name === "article-title")) ||
      undefined,
    abstract: jatsAbstract(abstract),
    sections: numberSections(out.sections),
    authors: jatsAuthors(meta),
    ...(Number.isFinite(year) ? { year } : {}),
    ...(ids.doi ? { doi: ids.doi } : {}),
    ...(ids.pmid ? { pmid: ids.pmid } : {}),
    ...(ids.pmcid || ids.pmc
      ? {
          pmcid: (ids.pmcid || ids.pmc).replace(/^(?!PMC)/i, "PMC"),
        }
      : {}),
    ...(jatsLicense(meta) ? { license: jatsLicense(meta) } : {}),
  };
}

// --- arXiv LaTeXML HTML -------------------------------------------------

const HTML_SKIPPED_ELEMENTS = new Set([
  "script",
  "style",
  "nav",
  "header",
  "footer",
  "button",
  "form",
  "svg",
  "img",
  "noscript",
  "iframe",
]);

const HTML_SKIPPED_CLASSES = [
  "ltx_authors",
  "ltx_bibliography",
  "ltx_TOC",
  "ltx_page_navbar",
  "ltx_note",
  "ltx_dates",
  "ltx_abstract",
  "ltx_title_document",
  "ltx_pagination",
];

const HTML_SECTION_CLASSES = [
  "ltx_section",
  "ltx_subsection",
  "ltx_subsubsection",
  "ltx_appendix",
  "ltx_chapter",
  "ltx_part",
];

const HTML_BLOCKS = new Set([
  "p",
  "li",
  "dd",
  "dt",
  "blockquote",
  "figcaption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

function isHeading(node: MarkupNode): boolean {
  return /^h[1-6]$/.test(node.name);
}

function isEquationTable(node: MarkupNode): boolean {
  return (
    node.name === "table" &&
    (hasClass(node, "ltx_equation") || hasClass(node, "ltx_equationgroup"))
  );
}

function headingText(node: MarkupNode): string {
  return plainText(
    node,
    (child) => hasClass(child, "ltx_tag") || child.name === "math",
  );
}

function walkHtml(node: MarkupNode, out: SectionCollector): void {
  for (const child of node.children) {
    if (!isElement(child)) {
      out.text(child);
      continue;
    }
    const name = child.name;
    if (
      HTML_SKIPPED_ELEMENTS.has(name) ||
      HTML_SKIPPED_CLASSES.some((entry) => hasClass(child, entry)) ||
      (name === "table" && !isEquationTable(child))
    ) {
      continue;
    }
    if (name === "math") {
      out.text(mathAltText(child));
      continue;
    }
    if (
      name === "section" &&
      HTML_SECTION_CLASSES.some((entry) => hasClass(child, entry))
    ) {
      out.open();
      const heading = childElements(child).find(isHeading);
      out.title(heading ? headingText(heading) : "");
      const tag = heading
        ? findFirst(heading, (entry) => hasClass(entry, "ltx_tag"))
        : null;
      if (tag) out.label(plainText(tag));
      walkHtml(
        {
          ...child,
          children: child.children.filter((entry) => entry !== heading),
        },
        out,
      );
      out.close();
      continue;
    }
    if (name === "br") {
      out.text(" ");
      continue;
    }
    if (
      HTML_BLOCKS.has(name) ||
      hasClass(child, "ltx_para") ||
      isEquationTable(child)
    ) {
      out.flush();
      walkHtml(child, out);
      out.flush();
      continue;
    }
    if (name === "figure") {
      // Only the caption of a figure or a table figure is text.
      out.flush();
      for (const caption of findAll(
        child,
        (entry) => entry.name === "figcaption",
      )) {
        walkHtml(caption, out);
        out.flush();
      }
      continue;
    }
    if (name === "td" || name === "th") out.text(" ");
    walkHtml(child, out);
  }
}

/**
 * Parses an arXiv LaTeXML HTML paper. Null when the page has no LaTeXML
 * document (an error or "no HTML" page).
 */
export function parseArxivHtml(html: string): ParsedPaperText | null {
  const root = parseMarkup(html, { html: true });
  const document =
    findFirst(
      root,
      (node) => node.name === "article" && hasClass(node, "ltx_document"),
    ) ||
    findFirst(
      root,
      (node) =>
        hasClass(node, "ltx_document") || hasClass(node, "ltx_page_main"),
    );
  if (!document) return null;
  const abstractNode = findFirst(document, (node) =>
    hasClass(node, "ltx_abstract"),
  );
  const abstractOut = new SectionCollector("");
  if (abstractNode) {
    walkHtml(
      {
        ...abstractNode,
        children: abstractNode.children.filter(
          (child) => !(isElement(child) && isHeading(child)),
        ),
      },
      abstractOut,
    );
    abstractOut.flush();
  }
  const out = new SectionCollector("Main text");
  walkHtml(document, out);
  out.flush();
  const titleNode = findFirst(document, (node) =>
    hasClass(node, "ltx_title_document"),
  );
  return {
    title: headingText(titleNode || element("h1")) || undefined,
    abstract: abstractOut.sections
      .flatMap((section) => section.paragraphs)
      .join("\n\n"),
    sections: numberSections(out.sections),
  };
}

// --- arXiv export Atom --------------------------------------------------

/** The first entry of an arXiv export API feed; null for none or an error. */
export function parseArxivAtom(xml: string): ParsedArxivEntry | null {
  const root = parseMarkup(xml);
  const entry = findFirst(root, (node) => node.name === "entry");
  if (!entry) return null;
  const title = plainText(childElements(entry, "title")[0]);
  const id = plainText(childElements(entry, "id")[0]);
  if (!title || (title === "Error" && !/arxiv\.org\/abs\//.test(id))) {
    return null;
  }
  const published = plainText(childElements(entry, "published")[0]);
  const year = parseInt(published.slice(0, 4), 10);
  const pdf = childElements(entry, "link").find(
    (link) =>
      link.attrs.title === "pdf" || link.attrs.type === "application/pdf",
  );
  const doi = plainText(childElements(entry, "arxiv:doi")[0]);
  return {
    title,
    abstract: plainText(childElements(entry, "summary")[0]),
    authors: childElements(entry, "author")
      .map((author) => plainText(childElements(author, "name")[0]))
      .filter(Boolean),
    ...(Number.isFinite(year) ? { year } : {}),
    ...(doi ? { doi } : {}),
    ...(pdf?.attrs.href ? { pdfUrl: pdf.attrs.href } : {}),
  };
}

/** Plain text of an HTML fragment (such as a Europe PMC abstract), by block. */
export function htmlFragmentToText(html: string): string {
  if (!html.includes("<")) return normalizeSpace(decodeEntities(html));
  const out = new SectionCollector("");
  walkHtml(parseMarkup(html, { html: true }), out);
  out.flush();
  return out.sections.flatMap((section) => section.paragraphs).join("\n\n");
}
