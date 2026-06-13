import { config } from "../../../package.json";
import {
  buildSafeSvgMarkup,
  renderMarkdown,
  renderMarkdownWithLegacyParser,
} from "../../utils/markdown";
import {
  createInlineSvgElement,
  createInlineMermaidSvgElement,
  sanitizeRenderedMermaidSvgWithReason,
} from "./mermaidSvg";
import {
  openStandaloneMermaidWindow,
  openStandaloneSvgWindow,
} from "./standaloneMermaidWindow";
import { sanitizeText } from "./textUtils";
import {
  copySvgFigureAsPngToClipboard,
  isMermaidFigureFenceLanguage,
} from "./figureExport";

export type RenderedMarkdownOptions = {
  resolveImage?: (src: string) => string | null;
  onAsyncContentRendered?: () => void;
};

type MermaidRenderOptions = {
  onContentRendered?: (preview: HTMLElement) => void;
};

const MERMAID_RENDERED_SVG_MAX_CHARS = 300_000;
const MERMAID_ERROR_MESSAGE_MAX_CHARS = 220;
const MERMAID_ZOOM_MIN = 0.5;
const MERMAID_ZOOM_MAX = 4;
const MERMAID_ZOOM_STEP = 0.25;
const MERMAID_WHEEL_ZOOM_DELTA_MAX = 24;
const MERMAID_WHEEL_ZOOM_SENSITIVITY = 0.002;
type MermaidThemeKey = "light" | "dark";
const MERMAID_RENDER_VERSION = "3";
const MERMAID_VENDOR_SCRIPT_URL = `chrome://${config.addonRef}/content/vendor/mermaid/mermaid.min.js`;

const MERMAID_THEME_VARIABLES: Record<
  MermaidThemeKey,
  Record<string, string>
> = {
  light: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: "15px",
    background: "#ffffff",
    mainBkg: "#dbeafe",
    primaryColor: "#dbeafe",
    primaryTextColor: "#111827",
    primaryBorderColor: "#3b82f6",
    secondaryColor: "#dcfce7",
    secondaryTextColor: "#111827",
    secondaryBorderColor: "#22c55e",
    tertiaryColor: "#fef3c7",
    tertiaryTextColor: "#111827",
    tertiaryBorderColor: "#f59e0b",
    lineColor: "#4b5563",
    defaultLinkColor: "#4b5563",
    edgeLabelBackground: "#ffffff",
    clusterBkg: "#ffffff",
    clusterBorder: "#e5e7eb",
    nodeBkg: "#dbeafe",
    nodeBorder: "#3b82f6",
    nodeTextColor: "#111827",
    titleColor: "#111827",
    textColor: "#111827",
  },
  dark: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: "15px",
    background: "#151515",
    mainBkg: "#dbeafe",
    primaryColor: "#dbeafe",
    primaryTextColor: "#111827",
    primaryBorderColor: "#60a5fa",
    secondaryColor: "#dcfce7",
    secondaryTextColor: "#111827",
    secondaryBorderColor: "#34d399",
    tertiaryColor: "#fef3c7",
    tertiaryTextColor: "#111827",
    tertiaryBorderColor: "#f59e0b",
    lineColor: "#d4d4d8",
    defaultLinkColor: "#d4d4d8",
    edgeLabelBackground: "#151515",
    clusterBkg: "#171717",
    clusterBorder: "#3f3f46",
    nodeBkg: "#dbeafe",
    nodeBorder: "#60a5fa",
    nodeTextColor: "#111827",
    titleColor: "#f8fafc",
    textColor: "#f8fafc",
  },
};

let renderedCodeBlockSourceIdCounter = 0;

const MERMAID_FLOWCHART_CONFIG = {
  htmlLabels: true,
  useMaxWidth: true,
  diagramPadding: 24,
  nodeSpacing: 70,
  rankSpacing: 88,
  padding: 12,
  curve: "basis" as const,
};

const MERMAID_BASE_CONFIG = {
  startOnLoad: false,
  securityLevel: "sandbox" as const,
  secure: [
    "securityLevel",
    "htmlLabels",
    "maxTextSize",
    "maxEdges",
    "startOnLoad",
    "theme",
    "themeVariables",
    "themeCSS",
    "secure",
  ],
  htmlLabels: true,
  maxTextSize: 50_000,
  maxEdges: 1_000,
  theme: "base" as const,
  flowchart: MERMAID_FLOWCHART_CONFIG,
};

function getMermaidConfig(themeKey: MermaidThemeKey) {
  return {
    ...MERMAID_BASE_CONFIG,
    themeVariables: MERMAID_THEME_VARIABLES[themeKey],
  };
}

function parseCssColorChannel(channel: string): number | null {
  const value = channel.trim();
  if (!value) return null;
  if (value.endsWith("%")) {
    const percent = Number.parseFloat(value.slice(0, -1));
    if (!Number.isFinite(percent)) return null;
    return Math.min(255, Math.max(0, (percent / 100) * 255));
  }
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? Math.min(255, Math.max(0, number)) : null;
}

function parseCssColor(value: string): [number, number, number] | null {
  const trimmed = value.trim();
  const hex = trimmed.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (hex) {
    const raw = hex[1];
    const expanded =
      raw.length === 3
        ? raw
            .split("")
            .map((char) => `${char}${char}`)
            .join("")
        : raw;
    return [
      Number.parseInt(expanded.slice(0, 2), 16),
      Number.parseInt(expanded.slice(2, 4), 16),
      Number.parseInt(expanded.slice(4, 6), 16),
    ];
  }

  const rgb = trimmed.match(/^rgba?\((.+)\)$/i);
  if (!rgb) return null;
  const parts = rgb[1]
    .replace(/\s*\/\s*[\d.]+%?\s*$/, "")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (parts.length < 3) return null;
  const channels = parts.slice(0, 3).map(parseCssColorChannel);
  if (channels.some((channel) => channel === null)) return null;
  return channels as [number, number, number];
}

function getCssColorLuminance(color: [number, number, number]): number {
  const [red, green, blue] = color.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function isLightCssColor(value: string): boolean {
  const color = parseCssColor(value);
  return color ? getCssColorLuminance(color) > 0.5 : false;
}

function isDarkCssColor(value: string): boolean {
  const color = parseCssColor(value);
  return color ? getCssColorLuminance(color) < 0.35 : false;
}

function isTransparentCssColor(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "transparent") return true;
  if (!/^rgba?\(/.test(normalized)) return false;
  return /[,/]\s*0(?:\.0+)?%?\s*\)?$/.test(normalized);
}

function getCssColorTheme(value: string): MermaidThemeKey | null {
  if (!value || isTransparentCssColor(value)) return null;
  if (isLightCssColor(value)) return "light";
  if (isDarkCssColor(value)) return "dark";
  return null;
}

export function resolveMermaidThemeFromColors(
  backgrounds: string[],
  foregrounds: string[],
  darkHint = false,
): MermaidThemeKey {
  for (const background of backgrounds) {
    const theme = getCssColorTheme(background);
    if (theme) return theme;
  }

  for (const foreground of foregrounds) {
    if (!foreground || isTransparentCssColor(foreground)) continue;
    if (isDarkCssColor(foreground)) return "light";
    if (isLightCssColor(foreground)) return "dark";
  }

  return darkHint ? "dark" : "light";
}

function getMermaidThemeElements(
  doc: Document,
  anchor?: HTMLElement,
): HTMLElement[] {
  const elements: HTMLElement[] = [];
  const add = (element: Element | null | undefined) => {
    if (
      element &&
      element.nodeType === 1 &&
      !elements.includes(element as HTMLElement)
    ) {
      elements.push(element as HTMLElement);
    }
  };
  add(anchor?.closest(".llm-panel"));
  add(anchor?.closest(".llm-rendered-markdown"));
  add(doc.body);
  add(doc.documentElement);
  return elements;
}

function getMermaidThemeKey(
  doc: Document,
  anchor?: HTMLElement,
): MermaidThemeKey {
  const root = doc.documentElement;
  const body = doc.body;
  const darkHint = Boolean(
    anchor?.closest(".window-is-dark") ||
    root?.classList.contains("window-is-dark") ||
    body?.classList.contains("window-is-dark") ||
    root?.hasAttribute("lwtheme-brighttext"),
  );

  const win = doc.defaultView;
  if (!win) return darkHint ? "dark" : "light";
  const backgrounds: string[] = [];
  const foregrounds: string[] = [];
  for (const element of getMermaidThemeElements(doc, anchor)) {
    const computed = win.getComputedStyle(element);
    if (!computed) continue;
    backgrounds.push(
      computed.backgroundColor,
      computed.getPropertyValue("--material-sidepane").trim(),
      computed.getPropertyValue("--material-background").trim(),
    );
    foregrounds.push(
      computed.getPropertyValue("--fill-primary").trim(),
      computed.color,
    );
  }

  return resolveMermaidThemeFromColors(
    backgrounds.filter(Boolean),
    foregrounds.filter(Boolean),
    darkHint,
  );
}

async function initializeMermaidRenderer(
  mermaid: Mermaid,
  doc: Document,
  themeKey: MermaidThemeKey,
): Promise<void> {
  await withDocumentGlobals(doc, async () => {
    mermaid.initialize(getMermaidConfig(themeKey));
  });
}

const MERMAID_VIEWER_FIT_ICON = "⛶";
const MERMAID_VIEWER_CLOSE_ICON = "×";
const MERMAID_VIEWER_ZOOM_OUT_ICON = "−";
const MERMAID_VIEWER_ZOOM_IN_ICON = "+";

const MERMAID_PREVIEW_OPEN_ICON = "⛶";
const FIGURE_COPY_RESET_DELAY_MS = 1400;
const MERMAID_CYTOSCAPE_STYLESHEET_ID = "__________cytoscape_stylesheet";
const MERMAID_CYTOSCAPE_CONTAINER_CLASS = "__________cytoscape_container";

const MERMAID_THEME_DATASET_KEY = "llmMermaidTheme";

const MERMAID_THEME_CLASS_BY_KEY: Record<MermaidThemeKey, string> = {
  light: "llm-mermaid-theme-light",
  dark: "llm-mermaid-theme-dark",
};

function setMermaidThemeDataset(
  element: HTMLElement,
  themeKey: MermaidThemeKey,
): void {
  element.dataset[MERMAID_THEME_DATASET_KEY] = themeKey;
  element.dataset.llmMermaidRenderVersion = MERMAID_RENDER_VERSION;
  element.classList.remove(
    MERMAID_THEME_CLASS_BY_KEY.light,
    MERMAID_THEME_CLASS_BY_KEY.dark,
  );
  element.classList.add(MERMAID_THEME_CLASS_BY_KEY[themeKey]);
}

function getRenderedMermaidTheme(preview: HTMLElement): MermaidThemeKey | null {
  if (preview.dataset.llmMermaidRenderVersion !== MERMAID_RENDER_VERSION) {
    return null;
  }
  const theme = preview.dataset[MERMAID_THEME_DATASET_KEY];
  return theme === "light" || theme === "dark" ? theme : null;
}

type MermaidRenderResult = {
  svg: string;
  bindFunctions?: (element: Element) => void;
};

type Mermaid = {
  initialize: (config: ReturnType<typeof getMermaidConfig>) => void;
  render: (
    id: string,
    definition: string,
    container?: Element,
  ) => Promise<MermaidRenderResult> | MermaidRenderResult;
};

const mermaidPromises = new WeakMap<Window, Promise<Mermaid>>();
let mermaidRenderQueue: Promise<void> = Promise.resolve();
let mermaidRenderCounter = 0;

type MermaidThemeWatcher = {
  observedElements: WeakSet<Element>;
  observers: MutationObserver[];
  scheduled: boolean;
  mediaQuery?: MediaQueryList;
};

const mermaidThemeWatchers = new WeakMap<Document, MermaidThemeWatcher>();

function ensureMermaidThemeWatcher(doc: Document, root?: ParentNode): void {
  const win = doc.defaultView;
  if (!win) return;

  let watcher = mermaidThemeWatchers.get(doc);
  if (!watcher) {
    watcher = {
      observedElements: new WeakSet<Element>(),
      observers: [],
      scheduled: false,
    };
    mermaidThemeWatchers.set(doc, watcher);
  }

  const scheduleRerender = () => {
    if (!watcher || watcher.scheduled) return;
    watcher.scheduled = true;
    const run = () => {
      if (!watcher) return;
      watcher.scheduled = false;
      void renderMermaidBlocks(doc, doc);
    };
    if (typeof win.requestAnimationFrame === "function") {
      win.requestAnimationFrame(run);
    } else {
      win.setTimeout(run, 0);
    }
  };

  const observeElement = (element: Element | null | undefined) => {
    if (!element || !watcher || watcher.observedElements.has(element)) return;
    const MutationObserverCtor = win.MutationObserver;
    if (!MutationObserverCtor) return;
    const observer = new MutationObserverCtor(scheduleRerender);
    observer.observe(element, {
      attributes: true,
      attributeFilter: ["class", "style", "lwtheme-brighttext"],
    });
    watcher.observers.push(observer);
    watcher.observedElements.add(element);
  };

  observeElement(doc.documentElement);
  observeElement(doc.body);
  if (root && root.nodeType === 1) {
    const element = root as Element;
    observeElement(element.closest(".llm-panel"));
    observeElement(element.closest(".llm-rendered-markdown"));
  }

  if (!watcher.mediaQuery) {
    const media = win.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
    if (media) {
      watcher.mediaQuery = media;
      media.addEventListener?.("change", scheduleRerender);
    }
  }
}

export function renderAssistantMarkdownHtmlForChat(
  text: string,
  options?: RenderedMarkdownOptions,
): string {
  return renderMarkdown(sanitizeText(text), options);
}

const SAFE_RENDERED_MARKDOWN_TAGS = new Set([
  "a",
  "annotation",
  "blockquote",
  "br",
  "code",
  "del",
  "div",
  "em",
  "h2",
  "h3",
  "h4",
  "h5",
  "hr",
  "img",
  "input",
  "li",
  "math",
  "menclose",
  "mfenced",
  "mfrac",
  "mi",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mroot",
  "mrow",
  "mspace",
  "msqrt",
  "mstyle",
  "msub",
  "msubsup",
  "msup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
  "ol",
  "p",
  "pre",
  "semantics",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

const SAFE_GLOBAL_MARKDOWN_ATTRS = new Set([
  "aria-hidden",
  "aria-label",
  "class",
  "data-code-lang",
  "data-copy-feedback",
  "data-llm-copy-source",
  "data-llm-mermaid-render-version",
  "data-llm-mermaid-source",
  "data-llm-mermaid-theme",
  "data-mermaid-state",
  "role",
  "style",
  "title",
]);

const KATEX_SVG_TAGS = new Set(["svg", "path", "line"]);

function compactRenderedUrl(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\s]+/g, "");
}

function isSafeRenderedMarkdownUrl(
  value: string,
  kind: "href" | "src",
): boolean {
  const compact = compactRenderedUrl(value.trim());
  if (!compact || compact.startsWith("//")) return false;
  if (compact.startsWith("#")) return true;

  const match = compact.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!match) return true;
  const protocol = match[1].toLowerCase();
  if (kind === "href")
    return ["http", "https", "mailto", "zotero"].includes(protocol);
  if (["http", "https", "file"].includes(protocol)) return true;
  return (
    protocol === "data" && /^data:image\/[a-z0-9.+-]+;base64,/i.test(compact)
  );
}

function getRenderedMarkdownTagName(element: Element): string {
  return element.localName.toLowerCase();
}

function getRenderedMarkdownParentElement(element: Element): Element | null {
  const parentElement = element.parentElement;
  if (parentElement) return parentElement;
  const parentNode = element.parentNode;
  return parentNode && parentNode.nodeType === 1
    ? (parentNode as Element)
    : null;
}

function hasRenderedMarkdownAncestorClass(
  element: Element,
  className: string,
): boolean {
  let parent = getRenderedMarkdownParentElement(element);
  while (parent) {
    if (parent.classList?.contains(className)) return true;
    parent = getRenderedMarkdownParentElement(parent);
  }
  return false;
}

function isSafeKatexSvgElement(element: Element): boolean {
  return (
    KATEX_SVG_TAGS.has(getRenderedMarkdownTagName(element)) &&
    hasRenderedMarkdownAncestorClass(element, "katex")
  );
}

function isSafeRenderedMarkdownElement(element: Element): boolean {
  const tagName = getRenderedMarkdownTagName(element);
  return (
    SAFE_RENDERED_MARKDOWN_TAGS.has(tagName) || isSafeKatexSvgElement(element)
  );
}

function isKatexSvgNumber(value: string): boolean {
  return /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value);
}

function isKatexSvgLength(value: string): boolean {
  return /^(?:\d+(?:\.\d+)?|\.\d+)(?:em|%)?$/i.test(value.trim());
}

function isKatexSvgViewBox(value: string): boolean {
  const parts = value.trim().split(/[\s,]+/);
  return (
    parts.length === 4 &&
    parts.every((part) => part !== "" && isKatexSvgNumber(part))
  );
}

function isKatexSvgPreserveAspectRatio(value: string): boolean {
  return /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/.test(
    value.trim(),
  );
}

function isKatexSvgPathData(value: string): boolean {
  return /^[MmZzLlHhVvCcSsQqTtAaEe0-9,.\s+-]+$/.test(value.trim());
}

function isSafeKatexSvgAttribute(
  tagName: string,
  attrName: string,
  attrValue: string,
): boolean {
  if (tagName === "svg") {
    if (attrName === "xmlns") return attrValue === "http://www.w3.org/2000/svg";
    if (attrName === "width" || attrName === "height")
      return isKatexSvgLength(attrValue);
    if (attrName === "viewbox") return isKatexSvgViewBox(attrValue);
    if (attrName === "preserveaspectratio")
      return isKatexSvgPreserveAspectRatio(attrValue);
    return false;
  }
  if (tagName === "path") {
    return attrName === "d" && isKatexSvgPathData(attrValue);
  }
  if (tagName === "line") {
    if (attrName === "x1" || attrName === "y1")
      return isKatexSvgLength(attrValue);
    if (attrName === "x2" || attrName === "y2")
      return isKatexSvgLength(attrValue);
    return attrName === "stroke-width" && isKatexSvgLength(attrValue);
  }
  return false;
}

function isSafeRenderedMarkdownAttribute(
  element: Element,
  attrName: string,
  attrValue: string,
): boolean {
  const tagName = getRenderedMarkdownTagName(element);
  if (!attrName || attrName.startsWith("on")) return false;
  if (isSafeKatexSvgElement(element)) {
    return isSafeKatexSvgAttribute(tagName, attrName, attrValue);
  }
  if (SAFE_GLOBAL_MARKDOWN_ATTRS.has(attrName)) return true;
  if (attrName.startsWith("data-llm-")) return true;

  if (tagName === "a") {
    if (attrName === "href")
      return isSafeRenderedMarkdownUrl(attrValue, "href");
    return attrName === "target" || attrName === "rel";
  }
  if (tagName === "img") {
    if (attrName === "src") return isSafeRenderedMarkdownUrl(attrValue, "src");
    return attrName === "alt" || attrName === "data-attachment-key";
  }
  if (tagName === "ol") return attrName === "start";
  if (tagName === "input") {
    return (
      attrName === "type" || attrName === "disabled" || attrName === "checked"
    );
  }
  if (tagName === "math") return attrName === "xmlns" || attrName === "display";
  if (tagName === "annotation") return attrName === "encoding";
  return false;
}

export function isSafeRenderedMarkdownElementForTests(
  element: Element,
): boolean {
  return isSafeRenderedMarkdownElement(element);
}

export function isSafeRenderedMarkdownAttributeForTests(
  element: Element,
  attrName: string,
  attrValue: string,
): boolean {
  return isSafeRenderedMarkdownAttribute(
    element,
    attrName.toLowerCase(),
    attrValue,
  );
}

function sanitizeRenderedMarkdownFragment(
  fragment: ParentNode,
  doc: Document,
): void {
  const elements = Array.from(
    fragment.querySelectorAll("*") as any,
  ) as Element[];
  for (const element of elements) {
    const tagName = getRenderedMarkdownTagName(element);
    if (!isSafeRenderedMarkdownElement(element)) {
      element.parentNode?.replaceChild(
        doc.createTextNode(element.textContent || ""),
        element,
      );
      continue;
    }

    for (const attr of Array.from(element.attributes)) {
      const attrName = attr.name.toLowerCase();
      if (!isSafeRenderedMarkdownAttribute(element, attrName, attr.value)) {
        element.removeAttribute(attr.name);
      }
    }

    if (tagName === "a") {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener");
    } else if (tagName === "input") {
      const input = element as HTMLInputElement;
      if (input.type !== "checkbox") {
        element.parentNode?.replaceChild(doc.createTextNode(""), element);
      } else {
        input.disabled = true;
      }
    }
  }
}

function setRenderedMarkdownHtml(
  target: HTMLElement,
  html: string,
  doc: Document,
): boolean {
  const setDirectHtml = () => {
    target.innerHTML = html;
  };

  try {
    const template = doc.createElement("template") as HTMLTemplateElement;
    if (
      !template.content ||
      typeof template.content.querySelectorAll !== "function"
    ) {
      setDirectHtml();
      return true;
    }
    template.innerHTML = html;
    sanitizeRenderedMarkdownFragment(template.content, doc);
    while (target.firstChild) target.removeChild(target.firstChild);
    target.appendChild(template.content);
    return true;
  } catch (_err) {
    // Zotero chrome documents may expose partial HTMLTemplateElement support.
    // Direct innerHTML is the pre-sanitizer compatibility path for rendered HTML.
    try {
      setDirectHtml();
      return true;
    } catch (_directErr) {
      return false;
    }
  }
}

function formatCodeCopyButtonLabel(rawLang: string): string {
  const lang = sanitizeText(rawLang || "")
    .trim()
    .toLowerCase();
  const labels: Record<string, string> = {
    bash: "Bash",
    css: "CSS",
    html: "HTML",
    javascript: "JavaScript",
    js: "JavaScript",
    json: "JSON",
    jsx: "JSX",
    markdown: "Markdown",
    md: "Markdown",
    mermaid: "Mermaid",
    mmd: "Mermaid",
    plaintext: "text",
    py: "Python",
    python: "Python",
    shell: "Shell",
    sh: "Shell",
    sql: "SQL",
    svg: "SVG",
    text: "text",
    ts: "TypeScript",
    tsx: "TSX",
    typescript: "TypeScript",
    xml: "XML",
    yaml: "YAML",
    yml: "YAML",
  };
  if (labels[lang]) return labels[lang];
  if (!lang) return "text";
  return lang
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

type MutableDomGlobal = typeof globalThis & {
  console?: Console;
  document?: Document;
  window?: Window;
};

type ScopedGlobalRestore = {
  target: object;
  key: string;
  previousValue: unknown;
  hadValue: boolean;
  changed: boolean;
};

type CssRuleLike = {
  cssText: string;
};

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

class MermaidFallbackCSSStyleSheet {
  cssRules: CssRuleLike[] = [];

  insertRule(rule: string, index = this.cssRules.length): number {
    const safeIndex = Math.max(0, Math.min(index, this.cssRules.length));
    this.cssRules.splice(safeIndex, 0, { cssText: rule });
    return safeIndex;
  }

  replaceSync(cssText: string): void {
    const trimmed = cssText.trim();
    this.cssRules = trimmed ? [{ cssText: trimmed }] : [];
  }
}

const fallbackMermaidCss = {
  escape: (value: string) => String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&"),
};

const noopMermaidConsole = {
  assert: () => undefined,
  clear: () => undefined,
  count: () => undefined,
  countReset: () => undefined,
  debug: () => undefined,
  dir: () => undefined,
  dirxml: () => undefined,
  error: () => undefined,
  group: () => undefined,
  groupCollapsed: () => undefined,
  groupEnd: () => undefined,
  info: () => undefined,
  log: () => undefined,
  table: () => undefined,
  time: () => undefined,
  timeEnd: () => undefined,
  timeLog: () => undefined,
  trace: () => undefined,
  warn: () => undefined,
} as unknown as Console;

const MERMAID_BROWSER_GLOBAL_KEYS = [
  "CSSStyleSheet",
  "DOMParser",
  "XMLSerializer",
  "DocumentFragment",
  "Element",
  "HTMLElement",
  "HTMLTemplateElement",
  "Node",
  "NodeFilter",
  "SVGElement",
  "NamedNodeMap",
  "MozNamedAttrMap",
  "HTMLFormElement",
  "getComputedStyle",
  "navigator",
  "performance",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "setTimeout",
  "clearTimeout",
  "btoa",
  "atob",
  "TextDecoder",
  "TextEncoder",
  "CSS",
  "location",
  "screen",
] as const;

const MERMAID_BROWSER_GLOBAL_METHODS = new Set<string>([
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "setTimeout",
  "clearTimeout",
  "btoa",
  "atob",
]);

function setScopedGlobalValue(
  target: object,
  key: string,
  value: unknown,
): boolean {
  const record = target as Record<string, unknown>;
  try {
    record[key] = value;
    if (record[key] === value) return true;
  } catch {
    // Some Zotero globals are accessor-backed; defineProperty is the fallback.
  }

  try {
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      value,
    });
    return record[key] === value;
  } catch {
    return false;
  }
}

function restoreScopedGlobalValue(restore: ScopedGlobalRestore): void {
  const { target, key, previousValue, hadValue, changed } = restore;
  if (!changed) return;
  if (!hadValue) {
    Reflect.deleteProperty(target, key);
    return;
  }
  setScopedGlobalValue(target, key, previousValue);
}

function addScopedGlobalValue(
  restores: ScopedGlobalRestore[],
  target: object,
  key: string,
  value: unknown,
): void {
  if (typeof value === "undefined") return;
  const record = target as Record<string, unknown>;
  const restore: ScopedGlobalRestore = {
    target,
    key,
    previousValue: record[key],
    hadValue: key in record,
    changed: setScopedGlobalValue(target, key, value),
  };
  restores.push(restore);
}

function getWindowGlobalValue(win: Window, key: string): unknown {
  const windowRecord = win as unknown as Record<string, unknown>;
  if (key === "CSSStyleSheet") {
    return windowRecord.CSSStyleSheet || MermaidFallbackCSSStyleSheet;
  }
  if (key === "CSS") {
    return windowRecord.CSS || fallbackMermaidCss;
  }

  const value = windowRecord[key];
  if (typeof value === "function" && MERMAID_BROWSER_GLOBAL_METHODS.has(key)) {
    return value.bind(win);
  }
  return value;
}

function escapeCssStringLiteral(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function stripMermaidLeadingDirectivesAndComments(source: string): string {
  let text = source.trimStart();
  let previous = "";
  while (text !== previous) {
    previous = text;
    text = text
      .replace(/^%%\{[\s\S]*?\}%%\s*/i, "")
      .replace(/^%%(?!\{)[^\n\r]*(?:\r?\n|$)\s*/i, "");
  }
  return text;
}

export function needsMermaidCytoscapeLayoutHost(source: string): boolean {
  return /^mindmap(?:\b|-)/i.test(
    stripMermaidLeadingDirectivesAndComments(source),
  );
}

function createMermaidDocumentFacade(
  doc: Document,
  body: HTMLElement,
): Document {
  const proxy = new Proxy(doc, {
    get(target, property, receiver) {
      if (property === "body") return body;
      if (property === "querySelector") {
        return (selector: string) => {
          if (selector === "body") return body;
          return body.querySelector(selector) || target.querySelector(selector);
        };
      }
      if (property === "querySelectorAll") {
        return (selector: string) => {
          if (selector === "body") return [body];
          const scoped = body.querySelectorAll(selector);
          return scoped.length ? scoped : target.querySelectorAll(selector);
        };
      }
      if (property === "getElementById") {
        return (id: string) =>
          body.querySelector(`[id="${escapeCssStringLiteral(id)}"]`) ||
          target.getElementById(id);
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return proxy as Document;
}

type MermaidRenderTarget = {
  container: HTMLElement;
  documentBody: HTMLElement;
  cleanup: () => void;
};

function createMermaidRenderHost(
  doc: Document,
  preview: HTMLElement,
): HTMLElement {
  const host = doc.createElementNS(HTML_NAMESPACE, "div") as HTMLElement;
  host.setAttribute("aria-hidden", "true");
  host.style.position = "absolute";
  host.style.left = "-10000px";
  host.style.top = "0";
  host.style.width = "800px";
  host.style.height = "1px";
  host.style.overflow = "hidden";
  preview.appendChild(host);
  return host;
}

function removeMermaidRenderNode(node: HTMLElement): void {
  if (typeof node.remove === "function") {
    node.remove();
  } else {
    node.parentNode?.removeChild(node);
  }
}

function createMermaidCytoscapeLayoutHost(doc: Document): HTMLElement {
  const host = doc.createElementNS(HTML_NAMESPACE, "div") as HTMLElement;
  // Mermaid's cose-bilkent layout asks Cytoscape for document.getElementById("cy").
  host.id = "cy";
  host.className = MERMAID_CYTOSCAPE_CONTAINER_CLASS;
  host.setAttribute("aria-hidden", "true");
  host.style.position = "absolute";
  host.style.left = "-10000px";
  host.style.top = "0";
  host.style.width = "1px";
  host.style.height = "1px";
  host.style.overflow = "hidden";
  return host;
}

function createMermaidCytoscapeStylesheetSentinel(
  doc: Document,
): HTMLStyleElement {
  const style = doc.createElementNS(
    HTML_NAMESPACE,
    "style",
  ) as HTMLStyleElement;
  // Cytoscape otherwise tries document.head.insertBefore(...), but Zotero
  // windows do not always expose a browser-like head element on this path.
  style.id = MERMAID_CYTOSCAPE_STYLESHEET_ID;
  style.textContent = `.${MERMAID_CYTOSCAPE_CONTAINER_CLASS} { position: relative; }`;
  return style;
}

function createMermaidRenderTarget(
  doc: Document,
  preview: HTMLElement,
  source: string,
): MermaidRenderTarget {
  if (!needsMermaidCytoscapeLayoutHost(source)) {
    const container = createMermaidRenderHost(doc, preview);
    return {
      container,
      documentBody: container,
      cleanup: () => removeMermaidRenderNode(container),
    };
  }

  const wrapper = createMermaidRenderHost(doc, preview);
  const styleSentinel = createMermaidCytoscapeStylesheetSentinel(doc);
  const layoutHost = createMermaidCytoscapeLayoutHost(doc);
  const container = doc.createElementNS(HTML_NAMESPACE, "div") as HTMLElement;
  wrapper.append(styleSentinel, layoutHost, container);
  return {
    container,
    documentBody: wrapper,
    cleanup: () => removeMermaidRenderNode(wrapper),
  };
}

async function withDocumentGlobals<T>(
  doc: Document,
  action: () => Promise<T>,
): Promise<T> {
  const win = doc.defaultView;
  if (!win) return action();

  const globalObject = globalThis as MutableDomGlobal;
  const windowObject = win as Window & { console?: Console };
  const scopedConsole =
    globalObject.console || windowObject.console || noopMermaidConsole;
  const restores: ScopedGlobalRestore[] = [];

  addScopedGlobalValue(restores, globalObject, "console", scopedConsole);
  addScopedGlobalValue(restores, globalObject, "document", doc);
  addScopedGlobalValue(restores, globalObject, "window", win);
  addScopedGlobalValue(restores, windowObject, "console", scopedConsole);
  for (const key of MERMAID_BROWSER_GLOBAL_KEYS) {
    addScopedGlobalValue(
      restores,
      globalObject,
      key,
      getWindowGlobalValue(win, key),
    );
  }

  try {
    return await action();
  } finally {
    for (const restore of restores.reverse()) {
      restoreScopedGlobalValue(restore);
    }
  }
}

function getMermaidGlobal(win: Window): Mermaid | null {
  return (win as unknown as { mermaid?: Mermaid }).mermaid || null;
}

function getMermaidScriptMount(doc: Document): Node | null {
  const htmlDoc = doc as Document & {
    head?: HTMLHeadElement | null;
    body?: HTMLElement | null;
  };
  return htmlDoc.head || htmlDoc.body || doc.documentElement;
}

function getMermaidRenderer(doc: Document): Promise<Mermaid> {
  const win = doc.defaultView;
  if (!win) {
    return Promise.reject(
      new Error("Unable to load Mermaid without a window."),
    );
  }

  const existing = getMermaidGlobal(win);
  if (existing) return Promise.resolve(existing);

  const activeLoad = mermaidPromises.get(win);
  if (activeLoad) return activeLoad;

  const load = new Promise<Mermaid>((resolve, reject) => {
    const mount = getMermaidScriptMount(doc);
    if (!mount) {
      reject(new Error("Unable to attach Mermaid loader script."));
      return;
    }

    const script = doc.createElementNS(
      HTML_NAMESPACE,
      "script",
    ) as HTMLScriptElement;
    script.async = true;
    script.src = MERMAID_VENDOR_SCRIPT_URL;
    script.addEventListener(
      "load",
      () => {
        const mermaid = getMermaidGlobal(win);
        if (mermaid) {
          resolve(mermaid);
        } else {
          reject(new Error("Mermaid loaded without exposing a renderer."));
        }
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => reject(new Error("Unable to load Mermaid renderer.")),
      { once: true },
    );
    mount.appendChild(script);
  }).catch((error) => {
    mermaidPromises.delete(win);
    throw error;
  });

  mermaidPromises.set(win, load);
  return load;
}

function enqueueMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const run = mermaidRenderQueue.then(task, task);
  mermaidRenderQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function isStillInRenderedRoot(
  root: ParentNode,
  element: HTMLElement,
): boolean {
  if (root === element) return true;
  const contains = (root as { contains?: (node: Node) => boolean }).contains;
  return typeof contains === "function" ? contains.call(root, element) : true;
}

function getMermaidErrorReason(error: unknown): string {
  const raw = getMermaidErrorText(error);
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MERMAID_ERROR_MESSAGE_MAX_CHARS);
}

function getMermaidErrorText(error: unknown, depth = 0): string {
  if (!error || depth > 3) return "";
  if (error instanceof Error) return error.message || String(error);
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);

  const record = error as Record<string, unknown>;
  for (const key of ["message", "str", "reason"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }

  const nested = getMermaidErrorText(record.error, depth + 1);
  if (nested) return nested;

  try {
    const json = JSON.stringify(error);
    return json && json !== "{}" ? json : "";
  } catch {
    return "";
  }
}

function setMermaidPreviewError(preview: HTMLElement, error?: unknown): void {
  const reason = getMermaidErrorReason(error);
  preview.dataset.mermaidState = "error";
  delete preview.dataset.mermaidZoom;
  delete preview.dataset.llmRenderedSvg;
  preview.textContent = reason
    ? `Unable to render Mermaid diagram: ${reason}`
    : "Unable to render Mermaid diagram.";
  if (reason) preview.title = reason;
}

function clampMermaidZoom(scale: number): number {
  return Math.min(MERMAID_ZOOM_MAX, Math.max(MERMAID_ZOOM_MIN, scale));
}

function getMermaidWheelZoomScale(scale: number, deltaY: number): number {
  const boundedDelta = Math.min(
    MERMAID_WHEEL_ZOOM_DELTA_MAX,
    Math.max(-MERMAID_WHEEL_ZOOM_DELTA_MAX, deltaY),
  );
  return scale * Math.exp(-boundedDelta * MERMAID_WHEEL_ZOOM_SENSITIVITY);
}

function formatMermaidZoomLabel(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

function createMermaidZoomButton(
  doc: Document,
  label: string,
  title: string,
): HTMLButtonElement {
  const button = doc.createElement("button") as HTMLButtonElement;
  button.type = "button";
  button.className = "llm-mermaid-zoom-btn";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  return button;
}

function getMermaidViewerMount(doc: Document, fallback: HTMLElement): Node {
  return doc.body || doc.documentElement || fallback;
}

type SvgViewerOptions = {
  ariaLabel: string;
  toolbarLabel: string;
  zoomTargetLabel: string;
  closeTitle: string;
};

function openSvgViewer(
  doc: Document,
  svgMarkup: string,
  fallbackMount: HTMLElement,
  themeKey: MermaidThemeKey,
  options: SvgViewerOptions,
): void {
  const viewer = doc.createElement("div");
  viewer.className = "llm-mermaid-viewer";
  viewer.tabIndex = -1;
  setMermaidThemeDataset(viewer, themeKey);

  const panel = doc.createElement("div");
  panel.className = "llm-mermaid-viewer-panel";

  const toolbar = doc.createElement("div");
  toolbar.className = "llm-mermaid-viewer-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", options.toolbarLabel);

  const zoomOut = createMermaidZoomButton(
    doc,
    MERMAID_VIEWER_ZOOM_OUT_ICON,
    `Zoom out ${options.zoomTargetLabel}`,
  );
  const zoomIn = createMermaidZoomButton(
    doc,
    MERMAID_VIEWER_ZOOM_IN_ICON,
    `Zoom in ${options.zoomTargetLabel}`,
  );
  const resetZoom = createMermaidZoomButton(
    doc,
    MERMAID_VIEWER_FIT_ICON,
    `Fit ${options.zoomTargetLabel} to width`,
  );
  const close = createMermaidZoomButton(
    doc,
    MERMAID_VIEWER_CLOSE_ICON,
    options.closeTitle,
  );
  close.classList.add("llm-mermaid-viewer-close");
  toolbar.append(zoomOut, zoomIn, resetZoom, close);

  const viewport = doc.createElement("div");
  viewport.className = "llm-mermaid-viewer-viewport";

  const svg = createInlineSvgElement(
    doc,
    svgMarkup,
    "llm-mermaid-viewer-svg",
    options.ariaLabel,
  );
  if (!svg) return;
  viewport.appendChild(svg);
  panel.append(toolbar, viewport);
  viewer.appendChild(panel);

  let scale = 1;
  const applyZoom = (nextScale: number) => {
    scale = clampMermaidZoom(nextScale);
    const label = formatMermaidZoomLabel(scale);
    viewer.dataset.mermaidZoom = label;
    svg.style.width = label;
    zoomOut.disabled = scale <= MERMAID_ZOOM_MIN;
    zoomIn.disabled = scale >= MERMAID_ZOOM_MAX;
  };
  const closeViewer = () => {
    doc.removeEventListener("keydown", handleKeyDown);
    if (typeof viewer.remove === "function") {
      viewer.remove();
    } else {
      viewer.parentNode?.removeChild(viewer);
    }
  };
  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") closeViewer();
  }

  zoomOut.addEventListener("click", () => applyZoom(scale - MERMAID_ZOOM_STEP));
  zoomIn.addEventListener("click", () => applyZoom(scale + MERMAID_ZOOM_STEP));
  resetZoom.addEventListener("click", () => {
    applyZoom(1);
    viewport.scrollTop = 0;
    viewport.scrollLeft = 0;
  });
  close.addEventListener("click", closeViewer);
  viewer.addEventListener("click", (event: MouseEvent) => {
    if (event.target === viewer) closeViewer();
  });
  viewport.addEventListener("wheel", (event: WheelEvent) => {
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    applyZoom(getMermaidWheelZoomScale(scale, event.deltaY));
  });
  doc.addEventListener("keydown", handleKeyDown);

  applyZoom(1);
  getMermaidViewerMount(doc, fallbackMount).appendChild(viewer);
  viewer.focus();
}

function openMermaidViewer(
  doc: Document,
  svgMarkup: string,
  fallbackMount: HTMLElement,
  themeKey: MermaidThemeKey,
): void {
  openSvgViewer(doc, svgMarkup, fallbackMount, themeKey, {
    ariaLabel: "Mermaid diagram",
    toolbarLabel: "Mermaid diagram viewer controls",
    zoomTargetLabel: "diagram",
    closeTitle: "Close diagram viewer",
  });
}

function renderMermaidImagePreview(
  preview: HTMLElement,
  doc: Document,
  svgMarkup: string,
  themeKey: MermaidThemeKey,
  source: string,
): void {
  const viewport = doc.createElement("div");
  viewport.className = "llm-mermaid-static-viewport";

  const svg = createInlineMermaidSvgElement(
    doc,
    svgMarkup,
    "llm-mermaid-static-svg",
  );
  if (!svg) {
    setMermaidPreviewError(preview);
    return;
  }
  viewport.appendChild(svg);

  const openButton = createMermaidZoomButton(
    doc,
    MERMAID_PREVIEW_OPEN_ICON,
    "Open Mermaid diagram viewer",
  );
  openButton.classList.add("llm-mermaid-open-btn");
  openButton.addEventListener("click", () => {
    const currentThemeKey = getMermaidThemeKey(doc, preview);
    if (currentThemeKey !== themeKey) {
      preview.dataset.mermaidState = "pending";
      void renderMermaidBlocks(
        preview.closest(".llm-rendered-markdown") || doc,
        doc,
      );
      return;
    }
    const opened = openStandaloneMermaidWindow(doc, {
      svgMarkup,
      source,
      themeKey,
    });
    if (!opened) openMermaidViewer(doc, svgMarkup, preview, themeKey);
  });

  delete preview.dataset.mermaidZoom;
  preview.dataset.llmRenderedSvg = svgMarkup;
  preview.replaceChildren(viewport, openButton);
  syncFigureCopyButtonStateForShell(
    preview.closest(".llm-codeblock-shell") as HTMLElement | null,
  );
}

function attachRenderedSvgPreviewButtons(
  root: ParentNode,
  doc: Document,
): void {
  const previews = Array.from(
    root.querySelectorAll(".llm-svg-preview[data-llm-svg-source]"),
  ) as HTMLElement[];
  for (const preview of previews) {
    if (preview.querySelector(":scope > .llm-svg-open-btn")) continue;
    const svgMarkup = buildSafeSvgMarkup(preview.dataset.llmSvgSource || "");
    if (!svgMarkup) continue;

    const openButton = createMermaidZoomButton(
      doc,
      MERMAID_PREVIEW_OPEN_ICON,
      "Open SVG preview viewer",
    );
    openButton.classList.add("llm-mermaid-open-btn", "llm-svg-open-btn");
    openButton.addEventListener("click", () => {
      const themeKey = getMermaidThemeKey(doc, preview);
      const opened = openStandaloneSvgWindow(doc, {
        svgMarkup,
        themeKey,
        title: "SVG Preview",
        ariaLabel: "SVG preview",
        toolbarLabel: "SVG preview controls",
        zoomTargetLabel: "SVG preview",
      });
      if (!opened) {
        openSvgViewer(doc, svgMarkup, preview, themeKey, {
          ariaLabel: "SVG preview",
          toolbarLabel: "SVG preview viewer controls",
          zoomTargetLabel: "SVG preview",
          closeTitle: "Close SVG preview viewer",
        });
      }
    });
    preview.appendChild(openButton);
  }
}

export function normalizeMermaidFlowchartLabels(source: string): string {
  const firstContentLine = source
    .split(/\r?\n/)
    .find((line) => line.trim() && !line.trimStart().startsWith("%%"));
  if (
    !firstContentLine ||
    !/^\s*(?:flowchart|graph)\b/i.test(firstContentLine)
  ) {
    return source;
  }

  return source
    .split(/(\r?\n)/)
    .map((part) =>
      /\r?\n/.test(part) ? part : normalizeMermaidFlowchartLabelsInLine(part),
    )
    .join("");
}

function isEscapedMermaidPipe(text: string, index: number): boolean {
  let slashCount = 0;
  for (let prev = index - 1; prev >= 0 && text[prev] === "\\"; prev--) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function findNextUnescapedMermaidPipe(text: string, start: number): number {
  for (let index = start; index < text.length; index++) {
    if (text[index] === "|" && !isEscapedMermaidPipe(text, index)) {
      return index;
    }
  }
  return -1;
}

function maskMermaidEdgeLabels(line: string): {
  masked: string;
  labels: string[];
} {
  const labels: string[] = [];
  let masked = "";
  let lastIndex = 0;
  for (let index = 0; index < line.length; index++) {
    if (line[index] !== "|" || isEscapedMermaidPipe(line, index)) continue;
    const closeIndex = findNextUnescapedMermaidPipe(line, index + 1);
    if (closeIndex < 0) break;
    const token = `__LLM_MERMAID_EDGE_LABEL_${labels.length}__`;
    masked += line.slice(lastIndex, index) + token;
    labels.push(line.slice(index, closeIndex + 1));
    lastIndex = closeIndex + 1;
    index = closeIndex;
  }
  return { masked: masked + line.slice(lastIndex), labels };
}

function restoreMermaidEdgeLabels(line: string, labels: string[]): string {
  return labels.reduce(
    (current, label, index) =>
      current.replace(`__LLM_MERMAID_EDGE_LABEL_${index}__`, label),
    line,
  );
}

function decodeMermaidLabelHtmlEntities(label: string): string {
  return label.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi,
    (entity, body: string) => {
      const lower = body.toLowerCase();
      if (lower === "amp") return "&";
      if (lower === "lt") return "<";
      if (lower === "gt") return ">";
      if (lower === "quot") return '"';
      if (lower === "apos" || lower === "#39") return "'";
      const codePoint = lower.startsWith("#x")
        ? Number.parseInt(lower.slice(2), 16)
        : lower.startsWith("#")
          ? Number.parseInt(lower.slice(1), 10)
          : Number.NaN;
      if (!Number.isFinite(codePoint)) return entity;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return entity;
      }
    },
  );
}

function normalizeMermaidLabelMarkdown(label: string): string {
  let normalized = decodeMermaidLabelHtmlEntities(label);
  if (/^\s*`[\s\S]*`\s*$/.test(normalized)) return normalized;
  normalized = normalized
    .replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+?)`/g, "<code>$1</code>");
  return normalized;
}

function escapeMermaidQuotedLabel(label: string): string {
  return label.replace(/"/g, "#quot;");
}

function shouldQuoteMermaidFlowchartLabel(label: string): boolean {
  return /[()?:;]/.test(label) || /<\/?(?:strong|code)\b/i.test(label);
}

function normalizeMermaidFlowchartLabelsInLine(line: string): string {
  const { masked, labels } = maskMermaidEdgeLabels(line);
  const quotedNormalized = masked.replace(
    /(\b[A-Za-z][\w-]*\s*)\["((?:[^"\\]|\\.)*)"\]/g,
    (match, prefix: string, label: string) => {
      const normalizedLabel = normalizeMermaidLabelMarkdown(label);
      if (normalizedLabel === label) return match;
      return `${prefix}["${escapeMermaidQuotedLabel(normalizedLabel)}"]`;
    },
  );
  const normalized = quotedNormalized
    .replace(
      /(\b[A-Za-z][\w-]*\s*)\[(?!\[)([^\]\n]*[()?:;][^\]\n]*)\]/g,
      (match, prefix: string, label: string) => {
        const trimmed = label.trim();
        if (!trimmed || trimmed.startsWith('"') || trimmed.startsWith("'")) {
          return match;
        }
        const normalizedLabel = normalizeMermaidLabelMarkdown(label);
        const escapedLabel = escapeMermaidQuotedLabel(normalizedLabel);
        return `${prefix}["${escapedLabel}"]`;
      },
    )
    .replace(
      /(\b[A-Za-z][\w-]*\s*)\[(?!\[)([^\]"\n]*)\]/g,
      (match, prefix: string, label: string) => {
        const normalizedLabel = normalizeMermaidLabelMarkdown(label);
        if (normalizedLabel === label) return match;
        if (!shouldQuoteMermaidFlowchartLabel(normalizedLabel)) {
          return `${prefix}[${normalizedLabel}]`;
        }
        return `${prefix}["${escapeMermaidQuotedLabel(normalizedLabel)}"]`;
      },
    );
  return restoreMermaidEdgeLabels(normalized, labels);
}

function getMermaidStyleFill(definition: string): string | null {
  const match = definition.match(/(?:^|[,;])\s*fill\s*:\s*([^,;]+)/i);
  return match?.[1]?.trim() || null;
}

function hasDarkMermaidFill(definition: string): boolean {
  const fill = getMermaidStyleFill(definition);
  return fill ? isDarkCssColor(fill) : false;
}

function hasMermaidStyleProperty(
  definition: string,
  property: string,
): boolean {
  return new RegExp(`(?:^|[,;])\\s*${property}\\s*:`, "i").test(definition);
}

function getMermaidSubgraphIds(source: string): Set<string> {
  const ids = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*subgraph\s+([A-Za-z][\w-]*)\b/);
    if (match?.[1]) ids.add(match[1]);
  }
  return ids;
}

const MERMAID_LOCKED_INIT_DIRECTIVE_KEYS =
  /\b(?:securityLevel|secure|htmlLabels|maxTextSize|maxEdges|startOnLoad|theme|themeVariables|themeCSS)\b/i;

function normalizeMermaidStyleDefinitionForTheme(
  definition: string,
  themeKey: MermaidThemeKey,
): string {
  const trimmed = definition.trim().replace(/;+\s*$/, "");
  if (!hasDarkMermaidFill(trimmed)) return definition;
  if (themeKey === "light") {
    return "fill:#ffffff,stroke:#e5e7eb,color:#111827";
  }
  if (hasMermaidStyleProperty(trimmed, "color")) return definition;
  return `${trimmed},color:#f8fafc`;
}

export function normalizeMermaidSourceForTheme(
  source: string,
  themeKey: MermaidThemeKey,
): string {
  const subgraphIds = getMermaidSubgraphIds(source);
  return source
    .replace(/^\s*%%\{\s*init\s*:[^\n]*\}%%\s*\r?\n?/gim, (directive) =>
      MERMAID_LOCKED_INIT_DIRECTIVE_KEYS.test(directive) ? "" : directive,
    )
    .replace(/^(\s*classDef\s+neutral\s+)([^\n]+)$/gim, (line, prefix, def) =>
      hasDarkMermaidFill(def)
        ? `${prefix}${
            themeKey === "light"
              ? "fill:#f8fafc,stroke:#cbd5e1,color:#111827;"
              : "fill:#2f2f2f,stroke:#52525b,color:#f8fafc;"
          }`
        : line,
    )
    .replace(
      /^(\s*style\s+([A-Za-z][\w-]*)\s+)([^\n]+)$/gim,
      (line, prefix, id, def) => {
        if (!subgraphIds.has(id) || !hasDarkMermaidFill(def)) return line;
        return `${prefix}${normalizeMermaidStyleDefinitionForTheme(
          def,
          themeKey,
        )}`;
      },
    );
}

function getMermaidSvgPolishCss(themeKey: MermaidThemeKey): string {
  if (themeKey === "dark") {
    return [
      "svg{background:#151515;color:#f8fafc;color-scheme:dark;}",
      ".cluster rect{fill:#171717!important;stroke:#3f3f46!important;}",
      ".cluster text,.cluster span,.cluster .nodeLabel{fill:#f8fafc!important;color:#f8fafc!important;}",
      ".edgeLabel,.edgeLabel p{background-color:#151515!important;color:#f8fafc!important;}",
      ".flowchart-link{stroke:#d4d4d8!important;}",
      ".marker{fill:#d4d4d8!important;stroke:#d4d4d8!important;}",
    ].join("\n");
  }
  return [
    "svg{background:#ffffff;color:#111827;color-scheme:light;}",
    ".cluster rect{fill:#ffffff!important;stroke:#e5e7eb!important;}",
    ".cluster text,.cluster span,.cluster .nodeLabel{fill:#111827!important;color:#111827!important;}",
    ".edgeLabel,.edgeLabel p{background-color:#ffffff!important;color:#374151!important;}",
    ".flowchart-link{stroke:#6b7280!important;}",
    ".marker{fill:#6b7280!important;stroke:#6b7280!important;}",
  ].join("\n");
}

export function polishRenderedMermaidSvg(
  svg: string,
  themeKey: MermaidThemeKey,
): string {
  const css = getMermaidSvgPolishCss(themeKey);
  return svg.replace(/<svg\b([^>]*)>/i, (opening) => {
    if (opening.includes("data-llm-mermaid-polished")) {
      return opening;
    }
    const background = themeKey === "dark" ? "#151515" : "#ffffff";
    const nextOpening = /\sstyle\s*=/.test(opening)
      ? opening.replace(
          /\sstyle\s*=\s*(["'])([\s\S]*?)\1/i,
          ` style="$2; background: ${background};"`,
        )
      : opening.replace(/^<svg\b/i, `<svg style="background: ${background};"`);
    return `${nextOpening.replace(
      /<svg\b/i,
      '<svg data-llm-mermaid-polished="true"',
    )}<style>${css}</style>`;
  });
}

function decodeMermaidSandboxDataUri(src: string): string | null {
  const dataUri = src
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .trim();
  const match = dataUri.match(
    /^data:text\/html(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i,
  );
  if (!match) return null;

  try {
    const data = decodeURIComponent(match[2]);
    if (!match[1]) return data;
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function extractRenderedMermaidSvg(markup: string): string {
  const trimmed = markup.trim();
  if (/^<svg\b/i.test(trimmed)) return trimmed;

  const iframeSrc = trimmed.match(
    /<iframe\b[^>]*\bsrc\s*=\s*(["'])([\s\S]*?)\1/i,
  )?.[2];
  if (!iframeSrc) return trimmed;

  const html = decodeMermaidSandboxDataUri(iframeSrc);
  const svg = html?.match(/<svg\b[\s\S]*<\/svg>/i)?.[0];
  return svg || trimmed;
}

async function renderMermaidSvg(
  mermaid: Mermaid,
  doc: Document,
  source: string,
  preview: HTMLElement,
): Promise<string> {
  const renderTarget = createMermaidRenderTarget(doc, preview, source);
  const renderDoc = createMermaidDocumentFacade(doc, renderTarget.documentBody);
  const renderId = `llmMermaid${Date.now()}${++mermaidRenderCounter}`;
  try {
    const { svg } = await withDocumentGlobals(renderDoc, () =>
      Promise.resolve(mermaid.render(renderId, source, renderTarget.container)),
    );
    return svg;
  } finally {
    renderTarget.cleanup();
  }
}

async function renderMermaidSvgWithRetry(
  mermaid: Mermaid,
  doc: Document,
  source: string,
  preview: HTMLElement,
  themeKey: MermaidThemeKey,
): Promise<string> {
  const themedSource = normalizeMermaidSourceForTheme(source, themeKey);
  const normalizedSource = normalizeMermaidFlowchartLabels(themedSource);
  try {
    const svg = await renderMermaidSvg(mermaid, doc, normalizedSource, preview);
    return polishRenderedMermaidSvg(extractRenderedMermaidSvg(svg), themeKey);
  } catch (firstError) {
    if (normalizedSource === themedSource) throw firstError;
    try {
      const svg = await renderMermaidSvg(mermaid, doc, themedSource, preview);
      return polishRenderedMermaidSvg(extractRenderedMermaidSvg(svg), themeKey);
    } catch {
      throw firstError;
    }
  }
}

async function renderMermaidBlocksNow(
  root: ParentNode,
  doc: Document,
  options?: MermaidRenderOptions,
): Promise<void> {
  const previews = Array.from(
    root.querySelectorAll(".llm-mermaid-preview[data-llm-mermaid-source]"),
  ) as HTMLElement[];
  if (!previews.length) return;
  ensureMermaidThemeWatcher(doc, root);

  let mermaid: Mermaid;
  try {
    mermaid = await getMermaidRenderer(doc);
  } catch (error) {
    for (const preview of previews) setMermaidPreviewError(preview, error);
    return;
  }

  for (const preview of previews) {
    const themeKey = getMermaidThemeKey(doc, preview);
    if (
      preview.dataset.mermaidState === "rendered" &&
      getRenderedMermaidTheme(preview) === themeKey
    ) {
      continue;
    }
    if (!isStillInRenderedRoot(root, preview)) continue;
    const source = preview.dataset.llmMermaidSource || "";
    if (!source.trim()) continue;

    preview.dataset.mermaidState = "rendering";
    setMermaidThemeDataset(preview, themeKey);
    try {
      await initializeMermaidRenderer(mermaid, doc, themeKey);
      const svg = await renderMermaidSvgWithRetry(
        mermaid,
        doc,
        source,
        preview,
        themeKey,
      );
      const sanitizedSvg = sanitizeRenderedMermaidSvgWithReason(
        svg,
        MERMAID_RENDERED_SVG_MAX_CHARS,
      );
      if (!sanitizedSvg.ok) {
        if (isStillInRenderedRoot(root, preview)) {
          setMermaidPreviewError(preview, sanitizedSvg.reason);
        }
        continue;
      }
      if (!isStillInRenderedRoot(root, preview)) continue;
      renderMermaidImagePreview(
        preview,
        doc,
        sanitizedSvg.svg,
        themeKey,
        source,
      );
      preview.dataset.mermaidState = "rendered";
      try {
        options?.onContentRendered?.(preview);
      } catch {
        // Async layout hooks should not turn a successful Mermaid render into
        // an error preview.
      }
    } catch (error) {
      if (isStillInRenderedRoot(root, preview)) {
        setMermaidPreviewError(preview, error);
      }
    }
  }
}

export async function renderMermaidSourceToSvg(
  source: string,
  doc: Document,
  anchor?: HTMLElement,
): Promise<string | null> {
  const normalizedSource = source.trim();
  if (!normalizedSource) return null;
  const preview = doc.createElement("div") as HTMLElement;
  preview.setAttribute("aria-hidden", "true");
  preview.style.position = "absolute";
  preview.style.left = "-10000px";
  preview.style.top = "0";
  preview.style.width = "1px";
  preview.style.height = "1px";
  preview.style.overflow = "hidden";
  const mount =
    anchor || (doc.body as HTMLElement | null) || doc.documentElement;
  mount?.appendChild(preview);
  try {
    const themeKey = getMermaidThemeKey(doc, anchor || preview);
    const mermaid = await getMermaidRenderer(doc);
    await initializeMermaidRenderer(mermaid, doc, themeKey);
    const svg = await renderMermaidSvgWithRetry(
      mermaid,
      doc,
      normalizedSource,
      preview,
      themeKey,
    );
    const sanitized = sanitizeRenderedMermaidSvgWithReason(
      svg,
      MERMAID_RENDERED_SVG_MAX_CHARS,
    );
    return sanitized.ok ? sanitized.svg : null;
  } finally {
    removeMermaidRenderNode(preview);
  }
}

export function renderMermaidBlocks(
  root: ParentNode,
  doc: Document,
  options?: MermaidRenderOptions,
): Promise<void> {
  return enqueueMermaidRender(() => renderMermaidBlocksNow(root, doc, options));
}

function getDirectChildWithClass(
  element: Element,
  className: string,
): HTMLElement | null {
  for (const child of Array.from(element.children)) {
    if (child.classList.contains(className)) {
      return child as HTMLElement;
    }
  }
  return null;
}

function setCodeBlockSourceCollapsed(
  shell: HTMLElement,
  body: HTMLElement,
  button: HTMLButtonElement,
  collapsed: boolean,
): void {
  shell.dataset.sourceCollapsed = collapsed ? "true" : "false";
  body.setAttribute("aria-hidden", collapsed ? "true" : "false");
  button.setAttribute("aria-expanded", collapsed ? "false" : "true");
  const label = collapsed ? "Show source" : "Hide source";
  button.textContent = label;
  button.title = label;
  button.setAttribute("aria-label", label);
}

function getVisualCodeBlockPreview(shell: HTMLElement): HTMLElement | null {
  return (
    getDirectChildWithClass(shell, "llm-svg-preview") ||
    getDirectChildWithClass(shell, "llm-mermaid-preview")
  );
}

function getVisualCodeBlockSvgMarkup(shell: HTMLElement): string | null {
  const svgPreview = getDirectChildWithClass(shell, "llm-svg-preview");
  if (svgPreview) {
    return buildSafeSvgMarkup(svgPreview.dataset.llmSvgSource || "");
  }
  const mermaidPreview = getDirectChildWithClass(shell, "llm-mermaid-preview");
  const renderedSvg = mermaidPreview?.dataset.llmRenderedSvg || "";
  return renderedSvg.trim() || null;
}

function syncFigureCopyButtonStateForShell(shell: HTMLElement | null): void {
  if (!shell) return;
  const button = getDirectChildWithClass(
    getDirectChildWithClass(shell, "llm-codeblock-header") || shell,
    "llm-codeblock-figure-copy",
  ) as HTMLButtonElement | null;
  if (!button) return;
  const available = Boolean(getVisualCodeBlockSvgMarkup(shell));
  button.disabled = !available;
  const lang = shell.dataset.codeLang || "";
  const isMermaid = isMermaidFigureFenceLanguage(lang);
  const label = isMermaid
    ? "Copy Mermaid diagram as PNG"
    : "Copy SVG figure as PNG";
  button.title = available ? label : `${label} (rendering)`;
  button.setAttribute("aria-label", label);
}

function attachCodeBlockFigureCopyButton(
  shell: HTMLElement,
  header: HTMLElement,
  doc: Document,
): void {
  if (!getVisualCodeBlockPreview(shell)) return;
  let button = getDirectChildWithClass(
    header,
    "llm-codeblock-figure-copy",
  ) as HTMLButtonElement | null;
  if (!button) {
    button = doc.createElement("button") as HTMLButtonElement;
    button.type = "button";
    button.className = "llm-codeblock-figure-copy";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      const svgMarkup = getVisualCodeBlockSvgMarkup(shell);
      if (!svgMarkup) {
        button!.dataset.figureCopyState = "unavailable";
        syncFigureCopyButtonStateForShell(shell);
        return;
      }
      button!.disabled = true;
      delete button!.dataset.figureCopyState;
      void copySvgFigureAsPngToClipboard(doc, svgMarkup)
        .then((copied) => {
          button!.dataset.figureCopyState = copied ? "copied" : "failed";
        })
        .catch(() => {
          button!.dataset.figureCopyState = "failed";
        })
        .finally(() => {
          const win = doc.defaultView;
          win?.setTimeout?.(() => {
            delete button!.dataset.figureCopyState;
            syncFigureCopyButtonStateForShell(shell);
          }, FIGURE_COPY_RESET_DELAY_MS);
          if (!win) syncFigureCopyButtonStateForShell(shell);
        });
    });
    header.appendChild(button);
  }
  syncFigureCopyButtonStateForShell(shell);
}

export function attachRenderedCodeBlockControls(
  root: ParentNode,
  doc: Document,
): void {
  const shells = Array.from(
    root.querySelectorAll(".llm-codeblock-shell"),
  ) as HTMLElement[];
  for (const shell of shells) {
    const header = getDirectChildWithClass(shell, "llm-codeblock-header");
    const body = getDirectChildWithClass(shell, "llm-codeblock-body");
    if (!header || !body) continue;

    const hasVisualPreview = Boolean(getVisualCodeBlockPreview(shell));
    const initialCollapsed =
      shell.dataset.sourceCollapsed === undefined
        ? hasVisualPreview
        : shell.dataset.sourceCollapsed === "true";

    if (!body.id) {
      body.id = `llm-codeblock-source-${++renderedCodeBlockSourceIdCounter}`;
    }

    let button = getDirectChildWithClass(
      header,
      "llm-codeblock-source-toggle",
    ) as HTMLButtonElement | null;
    if (!button) {
      const createdButton = doc.createElement("button") as HTMLButtonElement;
      createdButton.type = "button";
      createdButton.className = "llm-codeblock-source-toggle";
      createdButton.setAttribute("aria-controls", body.id);
      createdButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setCodeBlockSourceCollapsed(
          shell,
          body,
          createdButton,
          shell.dataset.sourceCollapsed !== "true",
        );
      });
      header.appendChild(createdButton);
      button = createdButton;
    }

    button.setAttribute("aria-controls", body.id);
    setCodeBlockSourceCollapsed(shell, body, button, initialCollapsed);
    attachCodeBlockFigureCopyButton(shell, header, doc);
  }
}

export function attachRenderedCopyButtons(
  root: ParentNode,
  doc: Document,
): void {
  const copyables = Array.from(
    root.querySelectorAll(".llm-copyable[data-llm-copy-source]"),
  ) as HTMLElement[];
  for (const copyable of copyables) {
    if (copyable.classList.contains("llm-copyable-inline")) continue;
    if (!copyable.dataset.copyFeedbackBound) {
      copyable.dataset.copyFeedbackBound = "true";
      const clearCopyFeedback = () => {
        delete copyable.dataset.copyFeedback;
      };
      copyable.addEventListener("mouseleave", clearCopyFeedback);
      copyable.addEventListener("focusout", (event: FocusEvent) => {
        const next = event.relatedTarget as Node | null;
        if (!next || !copyable.contains(next)) {
          clearCopyFeedback();
        }
      });
    }
    const existing = copyable.querySelector(
      ":scope > .llm-render-copy-btn",
    ) as HTMLButtonElement | null;
    if (existing) continue;
    const codeShell = copyable.querySelector(
      ":scope .llm-codeblock-shell",
    ) as HTMLElement | null;
    const codeHeader = codeShell
      ? getDirectChildWithClass(codeShell, "llm-codeblock-header")
      : null;
    if (
      codeHeader &&
      getDirectChildWithClass(codeHeader, "llm-render-copy-btn")
    ) {
      continue;
    }
    const button = doc.createElement("button") as HTMLButtonElement;
    button.type = "button";
    button.className = "llm-render-copy-btn";
    if (codeShell) {
      button.classList.add("llm-render-code-copy-btn");
      button.textContent = "⧉";
      const codeLangLabel = formatCodeCopyButtonLabel(
        codeShell.dataset.codeLang || "",
      );
      button.title = `Copy ${codeLangLabel} code`;
      button.setAttribute("aria-label", `Copy ${codeLangLabel} code`);
    } else {
      button.textContent = "⧉";
      button.title = "Copy original markdown";
      button.setAttribute("aria-label", "Copy original markdown");
    }
    if (codeHeader) {
      codeHeader.appendChild(button);
    } else {
      copyable.insertBefore(button, copyable.firstChild);
    }
  }
}

export function renderRenderedMarkdownInto(
  target: HTMLElement,
  text: string,
  doc: Document,
  options?: RenderedMarkdownOptions,
): void {
  target.classList.add("llm-rendered-markdown");
  const html = renderAssistantMarkdownHtmlForChat(text, options);
  if (!setRenderedMarkdownHtml(target, html, doc)) {
    const legacyHtml = renderMarkdownWithLegacyParser(
      sanitizeText(text),
      options,
    );
    if (!setRenderedMarkdownHtml(target, legacyHtml, doc)) {
      target.textContent = sanitizeText(text);
    }
  }
  attachRenderedCodeBlockControls(target, doc);
  attachRenderedCopyButtons(target, doc);
  attachRenderedSvgPreviewButtons(target, doc);
  void renderMermaidBlocks(
    target,
    doc,
    options?.onAsyncContentRendered
      ? {
          onContentRendered: options.onAsyncContentRendered,
        }
      : undefined,
  );
}
