/**
 * Shared chrome for rich content in chat answers (the "flat" style): the
 * content sits directly in the answer, with one floating hover bar and an
 * optional caption line under it. Code blocks use the bar today; tables,
 * figures and previews use the same helpers later.
 */

export const CONTENT_BAR_CLASS = "llm-content-bar";
export const CONTENT_BAR_BUTTON_CLASS = "llm-content-bar-btn";
export const CONTENT_CAPTION_CLASS = "llm-content-caption";
/** Marks the root of rendered answer text that uses the flat style. */
export const CONTENT_FLAT_SCOPE_CLASS = "llm-content-flat";
/**
 * Marks a flat reading surface that is not the chat: a side panel tab, the
 * full-view Markdown window or a document window. There the bar has no
 * "Move to side panel" button, code blocks are not folded, and the bar's copy
 * button copies by itself (the chat's click handler does not reach it).
 */
export const CONTENT_STANDALONE_SCOPE_CLASS = "llm-content-standalone";

/**
 * Set on a side panel tab's rendering box for a diagram or drawing: the
 * rendered diagram then gets the figure tab's pan and zoom view.
 */
export const CONTENT_TAB_ZOOM_ATTRIBUTE = "data-llm-tab-zoom";

/** True when `element` sits in a tab box that zooms its diagram. */
export function isInTabZoomScope(element: Element): boolean {
  return Boolean(element.closest?.(`[${CONTENT_TAB_ZOOM_ATTRIBUTE}="true"]`));
}

/** Both scope classes, as one class list for a standalone reading surface. */
export const STANDALONE_FLAT_SCOPE_CLASSES = `${CONTENT_FLAT_SCOPE_CLASS} ${CONTENT_STANDALONE_SCOPE_CLASS}`;

/** Gives a standalone reading surface the flat style. */
export function markStandaloneFlatScope(element: Element): void {
  element.classList.add(
    CONTENT_FLAT_SCOPE_CLASS,
    CONTENT_STANDALONE_SCOPE_CLASS,
  );
}

/**
 * Copies the flat scope class(es) of `source`'s surroundings onto `target`.
 * For Markdown rendered off-DOM and moved into `source` later: the flat
 * hydrators look for the scope at render time, so the detached container must
 * carry it. Does nothing when `source` is not in a flat scope.
 */
export function copyFlatContentScope(source: Element, target: Element): void {
  if (!isInFlatContentScope(source)) return;
  target.classList.add(CONTENT_FLAT_SCOPE_CLASS);
  if (isInStandaloneContentScope(source)) {
    target.classList.add(CONTENT_STANDALONE_SCOPE_CLASS);
  }
}

export type ContentBarButtonSpec = {
  className: string;
  label: string;
  /** A CSS `url(...)` for the button's mask icon; classes may supply it instead. */
  icon?: string;
  onClick?: (event: Event) => void;
  pressed?: boolean;
};

export type ContentCaptionSpec = {
  /** Short kind label, such as "Table" or "Figure". */
  kind: string;
  text?: string;
  link?: { label: string; onClick: (event: Event) => void };
};

function findDirectChild(parent: Element, className: string): Element | null {
  for (const child of Array.from(parent.children)) {
    if (child.classList.contains(className)) return child;
  }
  return null;
}

/** True when `element` sits inside answer text that uses the flat style. */
export function isInFlatContentScope(element: Element): boolean {
  return Boolean(element.closest?.(`.${CONTENT_FLAT_SCOPE_CLASS}`));
}

/** True when `element` sits on a flat reading surface outside the chat. */
export function isInStandaloneContentScope(element: Element): boolean {
  return Boolean(element.closest?.(`.${CONTENT_STANDALONE_SCOPE_CLASS}`));
}

/** The block's hover bar, created as a direct child on first use. */
export function ensureContentBar(block: Element, doc: Document): HTMLElement {
  const existing = findDirectChild(block, CONTENT_BAR_CLASS);
  if (existing) return existing as HTMLElement;
  const bar = doc.createElement("div") as HTMLElement;
  bar.className = CONTENT_BAR_CLASS;
  block.appendChild(bar);
  return bar;
}

/** Puts a button that already exists (and keeps its listeners) into the bar. */
export function adoptContentBarButton(
  bar: Element,
  button: HTMLElement,
): HTMLElement {
  button.classList.add(CONTENT_BAR_BUTTON_CLASS);
  bar.appendChild(button);
  return button;
}

/** Adds a new button at the end of the bar. */
export function appendContentBarButton(
  bar: Element,
  spec: ContentBarButtonSpec,
  doc: Document = bar.ownerDocument as Document,
): HTMLButtonElement {
  const button = doc.createElement("button") as HTMLButtonElement;
  button.type = "button";
  button.className = `${CONTENT_BAR_BUTTON_CLASS} ${spec.className}`;
  button.title = spec.label;
  button.setAttribute("aria-label", spec.label);
  if (spec.pressed !== undefined) {
    button.setAttribute("aria-pressed", spec.pressed ? "true" : "false");
  }
  if (spec.icon) button.style.setProperty("--llm-content-bar-icon", spec.icon);
  if (spec.onClick) {
    const onClick = spec.onClick;
    button.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick(event);
    });
  }
  bar.appendChild(button);
  return button;
}

/**
 * The caption line under a block: kind label, optional text, optional accent
 * link. Replaces an earlier caption on the same block.
 */
export function appendContentCaption(
  block: Element,
  spec: ContentCaptionSpec,
  doc: Document = block.ownerDocument as Document,
): HTMLElement {
  const existing = findDirectChild(block, CONTENT_CAPTION_CLASS);
  if (existing) existing.remove();
  const caption = doc.createElement("div") as HTMLElement;
  caption.className = CONTENT_CAPTION_CLASS;
  const kind = doc.createElement("span") as HTMLElement;
  kind.className = "llm-content-caption-kind";
  kind.textContent = spec.kind;
  caption.appendChild(kind);
  if (spec.text) {
    const text = doc.createElement("span") as HTMLElement;
    text.className = "llm-content-caption-text";
    text.textContent = spec.text;
    caption.appendChild(text);
  }
  if (spec.link) {
    const link = doc.createElement("button") as HTMLButtonElement;
    link.type = "button";
    link.className = "llm-content-caption-link";
    link.textContent = spec.link.label;
    const onClick = spec.link.onClick;
    link.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick(event);
    });
    caption.appendChild(link);
  }
  block.appendChild(caption);
  return caption;
}

const CAPTION_TEXT_MAX_CHARS = 80;

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

/** Tags stripped, entities decoded, white space folded, cut to caption size. */
export function cleanCaptionText(raw: string): string {
  const text = decodeBasicEntities(
    raw
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim();
  if (text.length <= CAPTION_TEXT_MAX_CHARS) return text;
  return `${text.slice(0, CAPTION_TEXT_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * A diagram's own title: the front-matter `title:`, then `accTitle:`, then a
 * `title` line (gantt, journey, timeline) or `pie ... title X`.
 */
export function parseMermaidTitle(source: string): string {
  const text = (source || "").replace(/\r\n?/g, "\n");
  const frontMatter = text.match(
    /^\s*---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/,
  );
  if (frontMatter) {
    const title = frontMatter[1].match(/^[ \t]*title[ \t]*:[ \t]*(.+)$/m);
    if (title) return cleanCaptionText(title[1]);
  }
  const body = frontMatter ? text.slice(frontMatter[0].length) : text;
  const accTitle = body.match(/^[ \t]*accTitle[ \t]*:[ \t]*(.+)$/m);
  if (accTitle) return cleanCaptionText(accTitle[1]);
  const titleLine = body.match(
    /^[ \t]*(?:pie\b[^\n]*?[ \t])?title[ \t]+(.+)$/m,
  );
  return titleLine ? cleanCaptionText(titleLine[1]) : "";
}

/** The text of an SVG drawing's `<title>` element. */
export function parseSvgTitle(svgSource: string): string {
  const match = (svgSource || "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanCaptionText(match[1]) : "";
}

/** A page's `<title>`, or else the text of its first `<h1>`. */
export function parseHtmlTitle(html: string): string {
  const source = html || "";
  for (const pattern of [
    /<title\b[^>]*>([\s\S]*?)<\/title>/i,
    /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
  ]) {
    const match = source.match(pattern);
    const text = match ? cleanCaptionText(match[1]) : "";
    if (text) return text;
  }
  return "";
}

/** Marks a table column whose body cells are all numbers. */
export const NUMERIC_CELL_CLASS = "llm-num";

const NUMERIC_CELL_PATTERN = /^(?=.*\d)[−\-+]?[\d.,]+\s?(?:%|pts?|ms|s|x)?$/i;
const EMPTY_CELL_PATTERN = /^(?:|-|–|—|n\/a)$/i;

/** True for a number-ish cell: "12", "−3.4", "1,200", "85%", "40 ms", "2x". */
export function isNumericCellText(text: string): boolean {
  return NUMERIC_CELL_PATTERN.test((text || "").replace(/\s+/g, " ").trim());
}

/**
 * Which columns are numeric: every body cell is number-ish, and an empty or
 * dash cell does not count against it. A column with no number is not numeric.
 */
export function detectNumericColumns(bodyRows: string[][]): boolean[] {
  const width = bodyRows.reduce((max, row) => Math.max(max, row.length), 0);
  const result: boolean[] = [];
  for (let col = 0; col < width; col += 1) {
    let numbers = 0;
    let ok = true;
    for (const row of bodyRows) {
      const text = (row[col] ?? "").replace(/\s+/g, " ").trim();
      if (EMPTY_CELL_PATTERN.test(text)) continue;
      if (isNumericCellText(text)) numbers += 1;
      else {
        ok = false;
        break;
      }
    }
    result.push(ok && numbers > 0);
  }
  return result;
}

/** Rows of cell text as CSV (comma separated, quotes doubled, "\n" lines). */
export function tableRowsToCsv(rows: string[][]): string {
  const cell = (value: string): string => {
    const text = (value ?? "").replace(/\s+/g, " ").trim();
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => row.map(cell).join(",")).join("\n");
}
