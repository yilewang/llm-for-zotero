import { config } from "../../../package.json";
import {
  buildSafeSvgMarkup,
  svgMarkupToDataUri,
  renderMathPreviewHtml,
  renderMarkdown,
  renderMarkdownMemoized,
  renderMarkdownWithLegacyParser,
} from "../../utils/markdown";
import {
  createInlineSvgElement,
  createInlineMermaidSvgElement,
  sanitizeRenderedMermaidSvgWithReason,
} from "./mermaidSvg";
import {
  buildMermaidSvgCacheKey,
  cacheMermaidSvg,
  getCachedMermaidSvg,
  invalidateMermaidSvg,
} from "./mermaidSvgCache";
import { mountDiagramTabZoom } from "./figureViewer";
import {
  openStandaloneMermaidWindow,
  openStandaloneSvgWindow,
  openStandaloneViewerWindow,
} from "./standaloneMermaidWindow";
import { sanitizeText } from "../../utils/textSanitization";
import {
  createSandboxedHtmlFrame,
  type HtmlPreviewFit,
} from "./htmlPreviewFrame";
import { t } from "../../utils/i18n";
import {
  PREVIEW_SURFACE_ATTRIBUTE,
  applySvgPreviewTheme,
  buildSvgExportMarkup,
  previewThemeFor,
  needsPreviewThemeSheet,
  usesPreviewTheme,
} from "../../utils/previewTheme";
import {
  adoptContentBarButton,
  appendContentBarButton,
  appendContentCaption,
  detectNumericColumns,
  ensureContentBar,
  isInFlatContentScope,
  isInStandaloneContentScope,
  isInTabZoomScope,
  NUMERIC_CELL_CLASS,
  parseHtmlTitle,
  parseMermaidTitle,
  parseSvgTitle,
  tableRowsToCsv,
} from "./contentChrome";
import {
  copyGeneratedImageToClipboard,
  pickGeneratedImageSavePath,
} from "./generatedImageRender";
import { openFigureViewer } from "./figureViewer";
import { copyTextToClipboard } from "./clipboard";
import { saveGeneratedImageAssetToPath } from "../../services/images/generatedImageAssets";
import {
  NO_SIDE_ITEMS_ATTRIBUTE,
  SIDE_ITEM_KIND_ATTRIBUTE,
  appendMoveToSidePanelButton,
  getSidePanelItemHost,
  getSideItemRequestBuilder,
  isOutsideAnswerContent,
  registerSideItemRequest,
  splitCodeFence,
} from "./sidePanelItems";
import {
  copySvgFigureAsPngToClipboard,
  defaultRasterizeSvgToPngBytes,
  isMermaidFigureFenceLanguage,
} from "./figureExport";

export type RenderedMarkdownOptions = {
  deferEnrichment?: boolean;
  resolveImage?: (src: string) => string | null;
  onAsyncContentRendered?: () => void;
  /**
   * False for content that is not part of the answer (the agent trace): its
   * blocks get no "Move to side panel" button and no Miscellaneous row.
   */
  sideItems?: boolean;
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
// Bumped when the palette changes so cached SVGs (keyed by version, theme
// and source) and rendered previews are drawn again.
const MERMAID_RENDER_VERSION = "5";
const MERMAID_VENDOR_SCRIPT_URL = `chrome://${config.addonRef}/content/vendor/mermaid/mermaid.min.js`;

/**
 * Diagram colours that sit on the chat background instead of in a box: quiet
 * tinted nodes with a hue-matched outline, plain text, grey edges, and a
 * transparent canvas. Outlines are the accent hues blended to about 70% over
 * the background, as plain hex (the renderer's colour maths rejects some
 * alpha forms). A diagram's own classDef or style lines still win.
 */
const MERMAID_THEME_VARIABLES: Record<
  MermaidThemeKey,
  Record<string, string>
> = {
  light: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: "15px",
    background: "transparent",
    mainBkg: "#e8effd",
    primaryColor: "#e8effd",
    primaryTextColor: "#1d1d1f",
    primaryBorderColor: "#80a5f4",
    secondaryColor: "#fdeee6",
    secondaryTextColor: "#1d1d1f",
    secondaryBorderColor: "#ef9e76",
    tertiaryColor: "#e5f4ec",
    tertiaryTextColor: "#1d1d1f",
    tertiaryBorderColor: "#6dbf9a",
    lineColor: "#8a8a8a",
    defaultLinkColor: "#8a8a8a",
    edgeLabelBackground: "#ffffff",
    clusterBkg: "#fafafa",
    clusterBorder: "#e5e5e5",
    nodeBkg: "#e8effd",
    nodeBorder: "#80a5f4",
    nodeTextColor: "#1d1d1f",
    titleColor: "#1d1d1f",
    textColor: "#1d1d1f",
  },
  dark: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: "15px",
    background: "transparent",
    mainBkg: "#1f2a3d",
    primaryColor: "#1f2a3d",
    primaryTextColor: "#e6e6e6",
    primaryBorderColor: "#3d61b1",
    secondaryColor: "#33261f",
    secondaryTextColor: "#e6e6e6",
    secondaryBorderColor: "#ab5a32",
    tertiaryColor: "#1d2f27",
    tertiaryTextColor: "#e6e6e6",
    tertiaryBorderColor: "#2a7b57",
    lineColor: "#8a8a8a",
    defaultLinkColor: "#8a8a8a",
    edgeLabelBackground: "#1e1e1e",
    clusterBkg: "#262626",
    clusterBorder: "#3a3a3a",
    nodeBkg: "#1f2a3d",
    nodeBorder: "#3d61b1",
    nodeTextColor: "#e6e6e6",
    titleColor: "#e6e6e6",
    textColor: "#e6e6e6",
  },
};

let renderedCodeBlockSourceIdCounter = 0;
const WORD_WRAP_DEFAULT_CODE_LANGS = new Set([
  "plain",
  "plaintext",
  "text",
  "txt",
]);

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

/**
 * The standalone window copies Zotero's theme a moment after the switch and
 * records it on its root; that record is the window's theme.
 */
const STANDALONE_CHAT_ROOT_ID = "llmforzotero-standalone-chat-root";
const STANDALONE_THEME_ATTRIBUTE = "data-standalone-theme";

function getMermaidThemeKey(
  doc: Document,
  anchor?: HTMLElement,
): MermaidThemeKey {
  const standaloneTheme = doc
    .getElementById?.(STANDALONE_CHAT_ROOT_ID)
    ?.getAttribute(STANDALONE_THEME_ATTRIBUTE);
  if (standaloneTheme === "light" || standaloneTheme === "dark") {
    return standaloneTheme;
  }
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

type MermaidThemeObservation = {
  target: Element;
  observer: MutationObserver;
};

type MermaidThemeWatcher = {
  observations: MermaidThemeObservation[];
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
      observations: [],
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

  // A panel root is recreated when its host is rebuilt (the item pane, or a
  // standalone window), so stale observations are released before a new one is
  // added: without this the list would keep one live observer - and the
  // detached subtree it pins - per rebuilt panel.
  const releaseDetachedObservations = () => {
    if (!watcher) return;
    watcher.observations = watcher.observations.filter((observation) => {
      if (observation.target.isConnected !== false) return true;
      observation.observer.disconnect();
      return false;
    });
  };

  const observeElement = (element: Element | null | undefined) => {
    if (!element || !watcher) return;
    releaseDetachedObservations();
    if (watcher.observations.some((entry) => entry.target === element)) return;
    const MutationObserverCtor = win.MutationObserver;
    if (!MutationObserverCtor) return;
    const observer = new MutationObserverCtor(scheduleRerender);
    observer.observe(element, {
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "lwtheme-brighttext",
        STANDALONE_THEME_ATTRIBUTE,
      ],
    });
    watcher.observations.push({ target: element, observer });
  };

  // Only elements that outlive a single render are observed. The rendered
  // markdown root is replaced on every render, and the theme re-render walks
  // the whole document anyway, so observing it would grow the list without
  // catching any theme change these do not already catch.
  observeElement(doc.documentElement);
  observeElement(doc.body);
  // The standalone window: its copy of Zotero's theme lands after the
  // prefers-color-scheme change, so the switch is caught here.
  observeElement(doc.getElementById?.(STANDALONE_CHAT_ROOT_ID));
  if (root && root.nodeType === 1) {
    observeElement((root as Element).closest(".llm-panel"));
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
  const safeText = sanitizeText(text);
  // Settled text renders through the output cache; a streaming tail
  // (deferEnrichment) changes every frame, and an image resolver makes the
  // output depend on more than the text.
  if (!options?.deferEnrichment && !options?.resolveImage) {
    return renderMarkdownMemoized(safeText);
  }
  return renderMarkdown(safeText, options);
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
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
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
const RENDERED_URL_WHITESPACE = /\s/;

function compactRenderedUrl(value: string): string {
  let compact = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      RENDERED_URL_WHITESPACE.test(char)
    ) {
      continue;
    }
    compact += char;
  }
  return compact;
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

export function sanitizeRenderedMarkdownFragment(
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

/** Inert parsing is mandatory for supplied HTML, unlike renderer-owned HTML. */
export function parseSanitizedRenderedHtml(
  html: string,
  doc: Document,
): DocumentFragment {
  const template = doc.createElement("template") as HTMLTemplateElement;
  template.innerHTML = html;
  sanitizeRenderedMarkdownFragment(template.content, doc);
  return template.content;
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
  syncFlatPreviewBarState(preview);
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
  const svg = createInlineSvgElement(
    doc,
    svgMarkup,
    "llm-mermaid-viewer-svg",
    options.ariaLabel,
  );
  if (!svg) return;
  openPreviewViewer(doc, svg, fallbackMount, themeKey, options, true);
}

/**
 * The full-window viewer shell shared by SVG, Mermaid, and HTML previews.
 * `zoomable` adds the zoom controls, which scale the content's width.
 */
function openPreviewViewer(
  doc: Document,
  content: HTMLElement | SVGElement,
  fallbackMount: HTMLElement,
  themeKey: MermaidThemeKey,
  options: SvgViewerOptions,
  zoomable: boolean,
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
  if (zoomable) {
    toolbar.append(zoomOut, zoomIn, resetZoom, close);
  } else {
    toolbar.append(close);
  }

  const viewport = doc.createElement("div");
  viewport.className = "llm-mermaid-viewer-viewport";

  viewport.appendChild(content);
  panel.append(toolbar, viewport);
  viewer.appendChild(panel);

  let scale = 1;
  const applyZoom = (nextScale: number) => {
    if (!zoomable) return;
    scale = clampMermaidZoom(nextScale);
    const label = formatMermaidZoomLabel(scale);
    viewer.dataset.mermaidZoom = label;
    content.style.width = label;
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
    if (!zoomable) return;
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

  delete preview.dataset.mermaidZoom;
  preview.dataset.llmRenderedSvg = svgMarkup;
  if (isInFlatContentScope(preview)) {
    // The flat style has no corner buttons: the hover bar built beside the
    // preview opens the full view and the side panel.
    preview.replaceChildren(viewport);
    // A side panel tab zooms the diagram like a figure tab does.
    if (isInTabZoomScope(preview)) mountDiagramTabZoom(preview, svg);
    syncFlatPreviewBarState(preview);
  } else {
    const openButton = createMermaidZoomButton(
      doc,
      MERMAID_PREVIEW_OPEN_ICON,
      "Open Mermaid diagram viewer",
    );
    openButton.classList.add("llm-mermaid-open-btn");
    openButton.addEventListener("click", () =>
      openMermaidPreviewFullView(doc, preview, svgMarkup, themeKey, source),
    );
    preview.replaceChildren(viewport, openButton);
    attachSideItemMoveButton(doc, preview, "mermaid", source);
  }
  syncFigureCopyButtonStateForShell(
    preview.closest(".llm-codeblock-shell") as HTMLElement | null,
  );
}

/** A rendered diagram in the shared full-view window (or the overlay). */
function openMermaidPreviewFullView(
  doc: Document,
  preview: HTMLElement,
  svgMarkup: string,
  themeKey: MermaidThemeKey,
  source: string,
): void {
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
}

/** A drawing in the shared full-view window (or the overlay). */
function openSvgPreviewFullView(
  doc: Document,
  preview: HTMLElement,
  svgMarkup: string,
): void {
  // A paper drawing opens on the white (light) viewer in every theme; a
  // themed one carries its sheet into the viewer.
  const themeKey = previewThemeFor(svgMarkup, getMermaidThemeKey(doc, preview));
  const viewerMarkup = needsPreviewThemeSheet(svgMarkup)
    ? applySvgPreviewTheme(svgMarkup, themeKey)
    : svgMarkup;
  const opened = openStandaloneSvgWindow(doc, {
    svgMarkup: viewerMarkup,
    themeKey,
    title: "SVG Preview",
    ariaLabel: "SVG preview",
    toolbarLabel: "SVG preview controls",
    zoomTargetLabel: "SVG preview",
  });
  if (!opened) {
    openSvgViewer(doc, viewerMarkup, preview, themeKey, {
      ariaLabel: "SVG preview",
      toolbarLabel: "SVG preview viewer controls",
      zoomTargetLabel: "SVG preview",
      closeTitle: "Close SVG preview viewer",
    });
  }
}

/** A web page in the shared full-view window (or the overlay). */
function openHtmlPreviewFullView(
  doc: Document,
  preview: HTMLElement,
  source: string,
): void {
  const opened = openStandaloneViewerWindow(doc, {
    kind: "html",
    source,
    title: t("HTML preview"),
    themeKey: previewThemeFor(source, getMermaidThemeKey(doc, preview)),
  });
  if (!opened) openHtmlPreviewViewer(doc, source, preview);
}

function attachRenderedSvgPreviewButtons(
  root: ParentNode,
  doc: Document,
): void {
  const previews = Array.from(
    root.querySelectorAll(".llm-svg-preview[data-llm-svg-source]"),
  ) as HTMLElement[];
  for (const preview of previews) {
    // The flat style builds its own hover bar (attachFlatPreviewChrome).
    if (isInFlatContentScope(preview)) continue;
    if (preview.querySelector(":scope > .llm-svg-open-btn")) continue;
    const svgMarkup = buildSafeSvgMarkup(preview.dataset.llmSvgSource || "");
    if (!svgMarkup) continue;

    const openButton = createMermaidZoomButton(
      doc,
      MERMAID_PREVIEW_OPEN_ICON,
      "Open SVG preview viewer",
    );
    openButton.classList.add("llm-mermaid-open-btn", "llm-svg-open-btn");
    openButton.addEventListener("click", () =>
      openSvgPreviewFullView(doc, preview, svgMarkup),
    );
    preview.appendChild(openButton);
    attachSideItemMoveButton(doc, preview, "svg", svgMarkup);
  }
}

/** An HTML page in the full-window viewer, in the same safe box. */
export function openHtmlPreviewViewer(
  doc: Document,
  source: string,
  anchor: HTMLElement,
): void {
  const appTheme = getMermaidThemeKey(doc, anchor);
  const viewerFrame = createSandboxedHtmlFrame(
    doc,
    source,
    "llm-html-preview-viewer-frame",
    appTheme,
  );
  openPreviewViewer(
    doc,
    viewerFrame,
    anchor,
    previewThemeFor(source, appTheme),
    {
      ariaLabel: t("HTML preview"),
      toolbarLabel: t("HTML preview viewer controls"),
      zoomTargetLabel: t("HTML preview"),
      closeTitle: t("Close HTML preview viewer"),
    },
    false,
  );
}

/** Past this height a chat page folds, with "Show the whole page" under it. */
const FLAT_HTML_FOLD_HEIGHT = 420;
const FLAT_HTML_TALL_ATTRIBUTE = "data-llm-html-tall";

/**
 * A page in a chat answer is as tall as its content and uses the chat's font.
 * A side panel tab fills its tab instead, so it does not fit.
 */
function htmlPreviewFitFor(
  doc: Document,
  preview: HTMLElement,
): HtmlPreviewFit | undefined {
  if (!isInFlatContentScope(preview)) return undefined;
  if (isInStandaloneContentScope(preview)) return undefined;
  const style = doc.defaultView?.getComputedStyle?.(preview);
  const font = style?.fontFamily
    ? `${style.fontSize}/${style.lineHeight} ${style.fontFamily}`
    : undefined;
  return {
    font,
    onHeight: (height) =>
      preview.setAttribute(
        FLAT_HTML_TALL_ATTRIBUTE,
        height > FLAT_HTML_FOLD_HEIGHT ? "true" : "false",
      ),
  };
}

function attachRenderedHtmlPreviews(root: ParentNode, doc: Document): void {
  const previews = Array.from(
    root.querySelectorAll(".llm-html-preview[data-llm-html-source]"),
  ) as HTMLElement[];
  for (const preview of previews) {
    if (preview.dataset.llmHtmlHydrated === "true") continue;
    const source = preview.dataset.llmHtmlSource || "";
    if (!source.trim()) continue;
    preview.dataset.llmHtmlHydrated = "true";

    const appTheme = getMermaidThemeKey(doc, preview);
    const frame = createSandboxedHtmlFrame(
      doc,
      source,
      undefined,
      appTheme,
      htmlPreviewFitFor(doc, preview),
    );
    if (usesPreviewTheme(source)) preview.dataset.llmPreviewTheme = appTheme;
    if (isInFlatContentScope(preview)) {
      // Only the page: the hover bar (attachFlatPreviewChrome) has the rest.
      preview.replaceChildren(frame);
      continue;
    }
    const openButton = createMermaidZoomButton(
      doc,
      MERMAID_PREVIEW_OPEN_ICON,
      t("Open HTML preview viewer"),
    );
    openButton.classList.add("llm-mermaid-open-btn", "llm-html-open-btn");
    openButton.addEventListener("click", () =>
      openHtmlPreviewFullView(doc, preview, source),
    );
    preview.replaceChildren(frame, openButton);
    attachSideItemMoveButton(doc, preview, "html", source);
  }
}

/**
 * Recolors themed drawings and pages for the current theme. A drawing gets a
 * new picture; a page gets a new frame, because its srcdoc must load only once
 * (guardHtmlPreviewNavigation). Paper previews never change. Returns whether
 * the root holds a themed preview, so the theme watcher is installed for it.
 */
function syncPreviewThemes(root: ParentNode, doc: Document): boolean {
  const themed = `[${PREVIEW_SURFACE_ATTRIBUTE}="themed"]`;
  const drawings = Array.from(
    root.querySelectorAll(`.llm-svg-preview${themed}[data-llm-svg-source]`),
  ) as HTMLElement[];
  const pages = Array.from(
    root.querySelectorAll(`.llm-html-preview${themed}[data-llm-html-source]`),
  ) as HTMLElement[];
  for (const preview of drawings) {
    const theme = getMermaidThemeKey(doc, preview);
    if (preview.dataset.llmPreviewTheme === theme) continue;
    const svgMarkup = buildSafeSvgMarkup(preview.dataset.llmSvgSource || "");
    // The picture may have moved into a tab's zoom stage.
    const picture = preview.querySelector("img");
    if (!svgMarkup || !picture) continue;
    picture.setAttribute(
      "src",
      svgMarkupToDataUri(applySvgPreviewTheme(svgMarkup, theme)),
    );
    preview.dataset.llmPreviewTheme = theme;
  }
  for (const preview of pages) {
    if (preview.dataset.llmHtmlHydrated !== "true") continue;
    const theme = getMermaidThemeKey(doc, preview);
    if (preview.dataset.llmPreviewTheme === theme) continue;
    // A page that tried to leave was replaced by a note: leave it.
    const oldFrame = preview.querySelector(":scope > iframe");
    if (!oldFrame) continue;
    const frame = createSandboxedHtmlFrame(
      doc,
      preview.dataset.llmHtmlSource || "",
      oldFrame.getAttribute("class") || undefined,
      theme,
      htmlPreviewFitFor(doc, preview),
    );
    preview.replaceChild(frame, oldFrame);
    preview.dataset.llmPreviewTheme = theme;
  }
  return drawings.length > 0 || pages.length > 0;
}

export function syncPreviewThemesForTests(
  root: ParentNode,
  doc: Document,
): boolean {
  return syncPreviewThemes(root, doc);
}

/**
 * True where "Move to side panel" does not belong: inside a block that opted
 * out of side items, and on flat reading surfaces outside the chat (a side
 * panel tab is already the side panel).
 */
function hasNoSideItems(element: Element): boolean {
  return isOutsideAnswerContent(element) || isInStandaloneContentScope(element);
}

/**
 * The chat answers copy through a click handler on the chat box. A bar copy
 * button on a standalone reading surface sits outside it, so it copies the
 * block's source itself. It stops the click, so the chat's handler never runs
 * for it twice.
 */
function bindStandaloneCopyButton(button: HTMLElement): void {
  if (!isInStandaloneContentScope(button)) return;
  if (button.dataset.standaloneCopyBound === "true") return;
  button.dataset.standaloneCopyBound = "true";
  button.addEventListener("click", (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    const copyable = button.closest(".llm-copyable") as HTMLElement | null;
    const source = copyable?.dataset.llmCopySource || "";
    if (!source) return;
    copyable?.setAttribute("data-copy-feedback", "copied");
    void copyTextToClipboard(button, source).catch(() => undefined);
  });
}

/**
 * "Move to side panel" next to the open button, in the same corner. It exists
 * only where the document has a side panel (the standalone window).
 */
function attachSideItemMoveButton(
  doc: Document,
  preview: HTMLElement,
  kind: "mermaid" | "svg" | "html",
  source: string,
): void {
  if (hasNoSideItems(preview)) return;
  preview.setAttribute(SIDE_ITEM_KIND_ATTRIBUTE, kind);
  appendMoveToSidePanelButton({
    doc,
    parent: preview,
    className: "llm-mermaid-open-btn llm-side-move-glyph",
    buildRequest: () => ({ kind, source, element: preview }),
  });
}

/** "Move to side panel" in the header of a plain code block. */
function attachRenderedCodeBlockMoveButtons(
  root: ParentNode,
  doc: Document,
): void {
  if (!getSidePanelItemHost(doc)) return;
  const shells = Array.from(
    root.querySelectorAll(".llm-codeblock-shell"),
  ) as HTMLElement[];
  for (const shell of shells) {
    // Preview blocks carry their own →| beside ⛶ and are listed by kind.
    if (
      getVisualCodeBlockPreview(shell) ||
      getDirectChildWithClass(shell, "llm-html-preview")
    ) {
      continue;
    }
    const header = getDirectChildWithClass(shell, "llm-codeblock-header");
    const body = getDirectChildWithClass(shell, "llm-codeblock-body");
    if (!header || !body || hasNoSideItems(shell)) continue;
    shell.setAttribute(SIDE_ITEM_KIND_ATTRIBUTE, "code");
    appendMoveToSidePanelButton({
      doc,
      parent: header,
      className: "llm-render-code-move-btn llm-side-move-glyph",
      buildRequest: () => {
        // The copy source is the whole fence; the tab wants the inner code.
        const copySource = (
          shell.closest(".llm-copyable") as HTMLElement | null
        )?.dataset.llmCopySource;
        const { code, lang } = copySource
          ? splitCodeFence(copySource)
          : { code: body.textContent || "", lang: "" };
        return { kind: "code", source: code, lang, element: shell };
      },
    });
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

type Rgb = { r: number; g: number; b: number };

function parseMermaidColor(value: string): Rgb | null {
  const text = value
    .trim()
    .replace(/\s*!important\s*$/i, "")
    .toLowerCase();
  if (text === "white") return { r: 255, g: 255, b: 255 };
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const digits =
      hex[1].length === 3
        ? hex[1]
            .split("")
            .map((c) => c + c)
            .join("")
        : hex[1];
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
    };
  }
  const rgb = text.match(
    /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/,
  );
  if (rgb) {
    return { r: +rgb[1], g: +rgb[2], b: +rgb[3] };
  }
  return null;
}

/** Hue (degrees), saturation and lightness (0..1) of an sRGB colour. */
function rgbToHsl(color: Rgb): { h: number; s: number; l: number } {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const hex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

const MERMAID_LIGHT_FILL_MIN_LIGHTNESS = 0.62;
const MERMAID_DARK_TEXT = "#e6e6e6";

function isLightMermaidFill(color: Rgb): boolean {
  return rgbToHsl(color).l >= MERMAID_LIGHT_FILL_MIN_LIGHTNESS;
}

/**
 * One classDef or style definition ("fill:#ffd6e0,stroke:#333,color:#000")
 * for the dark theme: a light fill becomes a dark tint of the same hue, the
 * outline turns into a mid-light tone of that hue (a deliberate coloured
 * outline stays), and dark or missing text turns light. A definition with a
 * dark or no fill stays as it is.
 */
function darkenMermaidDefinition(definition: string): string {
  const fillMatch = definition.match(/(^|[,;\s])fill\s*:\s*([^,;]+)/i);
  if (!fillMatch) return definition;
  const fill = parseMermaidColor(fillMatch[2]);
  if (!fill || !isLightMermaidFill(fill)) return definition;
  const { h, s } = rgbToHsl(fill);
  const chromatic = s >= 0.12;
  const darkFill = chromatic ? hslToHex(h, 0.22, 0.19) : "#2b2b2b";
  const outline = chromatic ? hslToHex(h, 0.45, 0.62) : "#71717a";
  const important = /!important/i.test(fillMatch[2]) ? " !important" : "";
  let result = definition.replace(
    /(^|[,;\s])fill\s*:\s*[^,;]+/i,
    (_all, lead) => `${lead}fill:${darkFill}${important}`,
  );
  const strokeMatch = result.match(/(^|[,;\s])stroke\s*:\s*([^,;]+)/i);
  if (strokeMatch) {
    const stroke = parseMermaidColor(strokeMatch[2]);
    const hsl = stroke ? rgbToHsl(stroke) : null;
    const deliberate =
      hsl && hsl.s >= 0.3 && hsl.l >= 0.35 && hsl.l <= 0.8 ? true : false;
    if (!deliberate) {
      result = result.replace(
        /(^|[,;\s])stroke\s*:\s*[^,;]+/i,
        (_all, lead) => `${lead}stroke:${outline}${important}`,
      );
    }
  } else {
    result = `${result.replace(/[;\s]+$/, "")},stroke:${outline}${
      /;\s*$/.test(definition) ? ";" : ""
    }`;
  }
  const colorMatch = result.match(/(^|[,;\s])color\s*:\s*([^,;]+)/i);
  const text = colorMatch ? parseMermaidColor(colorMatch[2]) : null;
  if (!colorMatch) {
    const trailing = /;\s*$/.test(result);
    result = `${result.replace(/[;\s]+$/, "")},color:${MERMAID_DARK_TEXT}${
      trailing ? ";" : ""
    }`;
  } else if (!text || rgbToHsl(text).l < 0.5) {
    result = result.replace(
      /(^|[,;\s])color\s*:\s*[^,;]+/i,
      (_all, lead) => `${lead}color:${MERMAID_DARK_TEXT}`,
    );
  }
  return result;
}

/**
 * Dark theme only: a diagram's own `classDef` and `style` lines often use
 * light pastel fills that glare on a dark page. Each light fill becomes a dark
 * tint that keeps its hue, with a matching outline and light text. The
 * theme's own node colours are not in the source and are not touched.
 */
export function remapMermaidLightFillsForDark(source: string): string {
  return source
    .replace(
      /^(\s*classDef\s+[^\s]+\s+)([^\n]+)$/gim,
      (_line, prefix, def) => `${prefix}${darkenMermaidDefinition(def)}`,
    )
    .replace(
      /^(\s*style\s+[^\s]+\s+)([^\n]+)$/gim,
      (_line, prefix, def) => `${prefix}${darkenMermaidDefinition(def)}`,
    );
}

export function normalizeMermaidSourceForTheme(
  source: string,
  themeKey: MermaidThemeKey,
): string {
  const subgraphIds = getMermaidSubgraphIds(source);
  const normalized = source
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
  return themeKey === "dark"
    ? remapMermaidLightFillsForDark(normalized)
    : normalized;
}

function getMermaidSvgPolishCss(themeKey: MermaidThemeKey): string {
  if (themeKey === "dark") {
    return [
      "svg[data-llm-mermaid-polished]{background:#151515;color:#f8fafc;color-scheme:dark;}",
      ".cluster rect{fill:#171717!important;stroke:#3f3f46!important;}",
      ".cluster text,.cluster span,.cluster .nodeLabel{fill:#f8fafc!important;color:#f8fafc!important;}",
      ".edgeLabel,.edgeLabel p{background-color:#151515!important;color:#f8fafc!important;}",
      ".flowchart-link{stroke:#d4d4d8!important;}",
      ".marker{fill:#d4d4d8!important;stroke:#d4d4d8!important;}",
    ].join("\n");
  }
  return [
    "svg[data-llm-mermaid-polished]{background:#ffffff;color:#111827;color-scheme:light;}",
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
  // The theme watcher re-runs this pass on every theme change; themed
  // drawings and pages follow it here too.
  if (syncPreviewThemes(root, doc)) ensureMermaidThemeWatcher(doc, root);
  const previews = Array.from(
    root.querySelectorAll(".llm-mermaid-preview[data-llm-mermaid-source]"),
  ) as HTMLElement[];
  if (!previews.length) return;
  ensureMermaidThemeWatcher(doc, root);

  // First pass: previews whose (version, theme, source) SVG is already cached
  // are filled synchronously; chat rebuilds discard element state, so without
  // this every refresh would re-invoke the Mermaid renderer per diagram. Only
  // cache misses need the renderer at all.
  const pendingPreviews: HTMLElement[] = [];
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
    const cacheKey = buildMermaidSvgCacheKey(
      MERMAID_RENDER_VERSION,
      themeKey,
      source,
    );
    const cachedSvg = getCachedMermaidSvg(cacheKey);
    if (cachedSvg === undefined) {
      pendingPreviews.push(preview);
      continue;
    }
    try {
      setMermaidThemeDataset(preview, themeKey);
      renderMermaidImagePreview(preview, doc, cachedSvg, themeKey, source);
      preview.dataset.mermaidState = "rendered";
    } catch (error) {
      // Per-preview isolation, like the miss path: a cached SVG that throws
      // on insertion (strict-XML innerHTML) must not stall the rest of the
      // batch, and its entry must not be replayed on the next rebuild.
      invalidateMermaidSvg(cacheKey);
      setMermaidPreviewError(preview, error);
      continue;
    }
    try {
      options?.onContentRendered?.(preview);
    } catch {
      // Async layout hooks should not turn a successful Mermaid render into
      // an error preview.
    }
  }
  if (!pendingPreviews.length) return;

  let mermaid: Mermaid;
  try {
    mermaid = await getMermaidRenderer(doc);
  } catch (error) {
    for (const preview of pendingPreviews) {
      setMermaidPreviewError(preview, error);
    }
    return;
  }

  for (const preview of pendingPreviews) {
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
    const cacheKey = buildMermaidSvgCacheKey(
      MERMAID_RENDER_VERSION,
      themeKey,
      source,
    );
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
      cacheMermaidSvg(cacheKey, sanitizedSvg.svg);
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
      // An entry cached just before a failed insertion is suspect — drop it
      // so the failure cannot replay from cache on the next rebuild. Reaching
      // this loop implies the key missed in pass 1, so a render error before
      // caching makes this a no-op.
      invalidateMermaidSvg(cacheKey);
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
  /** Forces a theme (a note is read on a light page whatever the chat is). */
  forcedThemeKey?: MermaidThemeKey,
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
    const themeKey =
      forcedThemeKey || getMermaidThemeKey(doc, anchor || preview);
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
  button.textContent = "";
  button.title = label;
  button.setAttribute("aria-label", label);
}

function setCodeBlockWordWrap(
  shell: HTMLElement,
  button: HTMLButtonElement,
  enabled: boolean,
): void {
  shell.dataset.wordWrap = enabled ? "true" : "false";
  button.setAttribute("aria-pressed", enabled ? "true" : "false");
  // A toggle in the flat style's hover bar shows its state by colour, so the
  // label names the action and stays the same.
  const ariaLabel = isInFlatContentScope(shell)
    ? t("Wrap long lines")
    : enabled
      ? "Disable word wrap"
      : "Enable word wrap";
  button.textContent = "";
  button.title = ariaLabel;
  button.setAttribute("aria-label", ariaLabel);
}

function shouldDefaultCodeBlockWordWrap(shell: HTMLElement): boolean {
  return WORD_WRAP_DEFAULT_CODE_LANGS.has(
    (shell.dataset.codeLang || "").trim().toLowerCase(),
  );
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
    // The copied PNG leaves the plugin: light sheet on white.
    const svgMarkup = buildSafeSvgMarkup(svgPreview.dataset.llmSvgSource || "");
    return svgMarkup ? buildSvgExportMarkup(svgMarkup) : null;
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

/** A button the flat style moved into the hover bar of `scope`'s block. */
function findFlatBarButton(
  scope: HTMLElement,
  className: string,
): HTMLElement | null {
  const block = scope.classList.contains("llm-copyable")
    ? scope
    : (scope.parentElement as HTMLElement | null);
  const bar = block ? getDirectChildWithClass(block, "llm-content-bar") : null;
  return bar ? getDirectChildWithClass(bar, className) : null;
}

const FLAT_CODE_FOLD_MIN_LINES = 16;

function countCodeLines(text: string): number {
  const trimmed = text.replace(/\n+$/, "");
  return trimmed ? trimmed.split("\n").length : 0;
}

function setFlatCodeFolded(
  shell: HTMLElement,
  button: HTMLButtonElement,
  lineCount: number,
  folded: boolean,
): void {
  shell.dataset.fold = folded ? "folded" : "expanded";
  button.setAttribute("aria-expanded", folded ? "false" : "true");
  button.textContent = folded
    ? t("Show all {count} lines").replace("{count}", String(lineCount))
    : t("Show fewer lines");
}

/**
 * The flat answer style for plain code blocks: the copy, wrap and move
 * buttons go into one hover bar, and a long block is folded behind a
 * "Show all N lines" pill. Runs once per block, after the header controls
 * exist; blocks outside a flat scope are left as they are.
 */
export function attachFlatCodeBlockChrome(
  root: ParentNode,
  doc: Document,
): void {
  const shells = Array.from(
    root.querySelectorAll(".llm-codeblock-shell"),
  ) as HTMLElement[];
  for (const shell of shells) {
    if (shell.dataset.flatChrome === "true") continue;
    if (!isInFlatContentScope(shell)) continue;
    if (
      getVisualCodeBlockPreview(shell) ||
      getDirectChildWithClass(shell, "llm-html-preview")
    ) {
      continue;
    }
    const block = shell.parentElement as HTMLElement | null;
    const header = getDirectChildWithClass(shell, "llm-codeblock-header");
    const body = getDirectChildWithClass(shell, "llm-codeblock-body");
    if (!block || !block.classList.contains("llm-copyable")) continue;
    if (!header || !body) continue;
    shell.dataset.flatChrome = "true";
    shell.classList.add("llm-codeblock-plain");

    const bar = ensureContentBar(block, doc);
    const wrapButton = getDirectChildWithClass(
      header,
      "llm-codeblock-wrap-toggle",
    ) as HTMLButtonElement | null;
    if (wrapButton) {
      adoptContentBarButton(bar, wrapButton);
      setCodeBlockWordWrap(
        shell,
        wrapButton,
        shell.dataset.wordWrap === "true",
      );
    }
    const copyButton = getDirectChildWithClass(
      header,
      "llm-render-copy-btn",
    ) as HTMLButtonElement | null;
    if (copyButton) {
      copyButton.textContent = "";
      const label = t("Copy code");
      copyButton.title = label;
      copyButton.setAttribute("aria-label", label);
      adoptContentBarButton(bar, copyButton);
      bindStandaloneCopyButton(copyButton);
    }
    const moveButton = getDirectChildWithClass(
      header,
      "llm-side-move-btn",
    ) as HTMLButtonElement | null;
    if (moveButton) {
      // collectMadeItems looks for the builder on the marked element's own
      // button; the button now sits outside the shell, so register it there.
      const build = getSideItemRequestBuilder(moveButton);
      if (build) registerSideItemRequest(shell, build);
      adoptContentBarButton(bar, moveButton);
    }

    const lineCount = countCodeLines(body.textContent || "");
    // A reading surface outside the chat (a side panel tab) shows it all.
    if (
      lineCount >= FLAT_CODE_FOLD_MIN_LINES &&
      !isInStandaloneContentScope(shell)
    ) {
      const foldButton = doc.createElement("button") as HTMLButtonElement;
      foldButton.type = "button";
      foldButton.className = "llm-content-fold-btn";
      foldButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setFlatCodeFolded(
          shell,
          foldButton,
          lineCount,
          shell.dataset.fold !== "folded",
        );
      });
      block.appendChild(foldButton);
      setFlatCodeFolded(shell, foldButton, lineCount, true);
    }
  }
}

type FlatPreviewKind = "mermaid" | "svg" | "html";

const FLAT_HTML_EXPAND_ATTRIBUTE = "data-expanded";
const FLAT_SAVE_RESET_DELAY_MS = 1600;

function getFlatPreview(
  shell: HTMLElement,
): { kind: FlatPreviewKind; preview: HTMLElement } | null {
  const mermaid = getDirectChildWithClass(shell, "llm-mermaid-preview");
  if (mermaid) return { kind: "mermaid", preview: mermaid };
  const svg = getDirectChildWithClass(shell, "llm-svg-preview");
  if (svg) return { kind: "svg", preview: svg };
  const html = getDirectChildWithClass(shell, "llm-html-preview");
  if (html) return { kind: "html", preview: html };
  return null;
}

function getFlatPreviewBar(preview: HTMLElement): HTMLElement | null {
  const block = preview.closest(".llm-copyable") as HTMLElement | null;
  return block ? getDirectChildWithClass(block, "llm-content-bar") : null;
}

/**
 * Buttons that need a finished diagram stay off until the renderer has
 * produced the SVG (and after an error).
 */
function syncFlatPreviewBarState(preview: HTMLElement): void {
  const bar = getFlatPreviewBar(preview);
  if (!bar) return;
  const ready = Boolean(preview.dataset.llmRenderedSvg);
  for (const button of Array.from(bar.children) as HTMLButtonElement[]) {
    if (button.dataset?.needsRender === "true") button.disabled = !ready;
  }
}

function setFlatSourceShown(
  shell: HTMLElement,
  body: HTMLElement,
  toggle: HTMLElement | null,
  barButton: HTMLElement,
  shown: boolean,
): void {
  shell.dataset.sourceCollapsed = shown ? "false" : "true";
  body.setAttribute("aria-hidden", shown ? "false" : "true");
  if (toggle) toggle.setAttribute("aria-expanded", shown ? "true" : "false");
  const label = shown ? t("Hide code") : t("Show code");
  barButton.title = label;
  barButton.setAttribute("aria-label", label);
  barButton.setAttribute("aria-pressed", shown ? "true" : "false");
}

/** The PNG's backdrop: the diagram text colours assume the chat background. */
function getFlatSaveBackground(
  kind: FlatPreviewKind,
  doc: Document,
  preview: HTMLElement,
): string {
  if (kind !== "mermaid") return "#ffffff";
  const themeKey =
    getRenderedMermaidTheme(preview) || getMermaidThemeKey(doc, preview);
  return themeKey === "dark" ? "#1e1e1e" : "#ffffff";
}

/** "Save as image": a PNG of the drawing, written where the user picks. */
async function saveFlatPreviewAsImage(
  doc: Document,
  kind: FlatPreviewKind,
  preview: HTMLElement,
  svgMarkup: string,
): Promise<"saved" | "cancelled" | "failed"> {
  try {
    const bytes = await defaultRasterizeSvgToPngBytes(doc, svgMarkup, {
      background: getFlatSaveBackground(kind, doc, preview),
    });
    if (!bytes?.length) return "failed";
    const fileName = kind === "mermaid" ? "diagram.png" : "drawing.png";
    const target = await pickGeneratedImageSavePath(doc, fileName);
    if (target.status === "cancelled") return "cancelled";
    if (target.status !== "selected") return "failed";
    await saveGeneratedImageAssetToPath(
      {
        image: { id: fileName },
        bytes,
        mimeType: "image/png",
        fileName,
      },
      target.path,
    );
    return "saved";
  } catch {
    return "failed";
  }
}

/**
 * The flat answer style for diagrams, drawings and web pages: no header or
 * corner buttons. One hover bar (Show code, Copy, Save as image, Full view,
 * Side panel), a caption under the content, and the source folded away until
 * "Show code". Runs once per block, after the other controls exist; blocks
 * outside a flat scope are left as they are.
 */
export function attachFlatPreviewChrome(root: ParentNode, doc: Document): void {
  const shells = Array.from(
    root.querySelectorAll(".llm-codeblock-shell"),
  ) as HTMLElement[];
  for (const shell of shells) {
    if (shell.dataset.flatChrome === "true") continue;
    if (!isInFlatContentScope(shell)) continue;
    const found = getFlatPreview(shell);
    if (!found) continue;
    const { kind, preview } = found;
    const block = shell.parentElement as HTMLElement | null;
    const header = getDirectChildWithClass(shell, "llm-codeblock-header");
    const body = getDirectChildWithClass(shell, "llm-codeblock-body");
    if (!block || !block.classList.contains("llm-copyable")) continue;
    if (!header || !body) continue;
    shell.dataset.flatChrome = "true";
    shell.classList.add("llm-codeblock-flat-preview");
    if (kind === "svg" && isInTabZoomScope(preview)) {
      const picture = preview.querySelector("img") as HTMLElement | null;
      if (picture) mountDiagramTabZoom(preview, picture);
    }
    block.classList.add("llm-copyable-flat-preview");
    if (!body.id) {
      body.id = `llm-codeblock-source-${++renderedCodeBlockSourceIdCounter}`;
    }

    const bar = ensureContentBar(block, doc);
    const sourceToggle = getDirectChildWithClass(
      header,
      "llm-codeblock-source-toggle",
    );

    // 1. The content's own actions.
    const showCode = appendContentBarButton(
      bar,
      {
        className: "llm-content-bar-source",
        label: t("Show code"),
        pressed: false,
        onClick: () =>
          setFlatSourceShown(
            shell,
            body,
            sourceToggle,
            showCode,
            shell.dataset.sourceCollapsed === "true",
          ),
      },
      doc,
    );
    showCode.setAttribute("aria-controls", body.id);
    // Source starts folded away for every kind in the flat style.
    setFlatSourceShown(shell, body, sourceToggle, showCode, false);

    const copyButton = getDirectChildWithClass(
      header,
      "llm-render-copy-btn",
    ) as HTMLButtonElement | null;
    if (copyButton) {
      copyButton.textContent = "";
      const label =
        kind === "svg"
          ? t("Copy SVG")
          : kind === "html"
            ? t("Copy HTML")
            : t("Copy code");
      copyButton.title = label;
      copyButton.setAttribute("aria-label", label);
      adoptContentBarButton(bar, copyButton);
      bindStandaloneCopyButton(copyButton);
    }

    const readSvgMarkup = (): string | null =>
      kind === "svg"
        ? buildSafeSvgMarkup(preview.dataset.llmSvgSource || "")
        : preview.dataset.llmRenderedSvg || null;

    if (kind !== "html") {
      const saveButton = appendContentBarButton(
        bar,
        {
          className: "llm-content-bar-save",
          label: t("Save as image"),
          onClick: () => {
            const svgMarkup = readSvgMarkup();
            if (!svgMarkup) return;
            saveButton.disabled = true;
            // A saved drawing leaves the plugin: light sheet on white.
            const imageMarkup =
              kind === "svg" ? buildSvgExportMarkup(svgMarkup) : svgMarkup;
            void saveFlatPreviewAsImage(doc, kind, preview, imageMarkup).then(
              (result) => {
                saveButton.disabled = false;
                if (result === "cancelled") return;
                saveButton.dataset.saveState = result;
                doc.defaultView?.setTimeout?.(() => {
                  delete saveButton.dataset.saveState;
                }, FLAT_SAVE_RESET_DELAY_MS);
              },
            );
          },
        },
        doc,
      );
      if (kind === "mermaid") saveButton.dataset.needsRender = "true";
    }

    // 2. The shared full-view window.
    const fullViewButton = appendContentBarButton(
      bar,
      {
        className: "llm-content-bar-fullview",
        label: t("Open full view"),
        onClick: () => {
          if (kind === "html") {
            openHtmlPreviewFullView(
              doc,
              preview,
              preview.dataset.llmHtmlSource || "",
            );
            return;
          }
          const svgMarkup = readSvgMarkup();
          if (!svgMarkup) return;
          if (kind === "svg") {
            openSvgPreviewFullView(doc, preview, svgMarkup);
            return;
          }
          const themeKey = getRenderedMermaidTheme(preview);
          if (!themeKey) return;
          openMermaidPreviewFullView(
            doc,
            preview,
            svgMarkup,
            themeKey,
            preview.dataset.llmMermaidSource || "",
          );
        },
      },
      doc,
    );
    if (kind === "mermaid") fullViewButton.dataset.needsRender = "true";

    // 3. The side panel (standalone window only).
    if (!hasNoSideItems(preview)) {
      const sideSource =
        kind === "mermaid"
          ? preview.dataset.llmMermaidSource || ""
          : kind === "svg"
            ? buildSafeSvgMarkup(preview.dataset.llmSvgSource || "") || ""
            : preview.dataset.llmHtmlSource || "";
      const buildRequest = () => ({
        kind,
        source: sideSource,
        element: preview,
      });
      const moveButton = appendMoveToSidePanelButton({
        doc,
        parent: bar,
        className: "llm-side-move-glyph",
        buildRequest,
      });
      if (moveButton) {
        preview.setAttribute(SIDE_ITEM_KIND_ATTRIBUTE, kind);
        // collectMadeItems finds the builder on the marked element.
        registerSideItemRequest(preview, buildRequest);
        adoptContentBarButton(bar, moveButton);
      }
    }

    // The caption sits under the content, above the folded source.
    const captionText =
      kind === "mermaid"
        ? parseMermaidTitle(preview.dataset.llmMermaidSource || "")
        : kind === "svg"
          ? parseSvgTitle(preview.dataset.llmSvgSource || "")
          : parseHtmlTitle(preview.dataset.llmHtmlSource || "");
    const caption = appendContentCaption(
      shell,
      {
        kind:
          kind === "mermaid"
            ? t("Diagram")
            : kind === "svg"
              ? t("Drawing")
              : t("Web page"),
        text: captionText || undefined,
      },
      doc,
    );
    shell.insertBefore(caption, body);

    if (kind === "html") {
      preview.setAttribute(FLAT_HTML_EXPAND_ATTRIBUTE, "false");
      const expand = doc.createElement("button") as HTMLButtonElement;
      expand.type = "button";
      expand.className = "llm-content-fold-btn llm-content-expand-btn";
      const setExpanded = (expanded: boolean) => {
        preview.setAttribute(
          FLAT_HTML_EXPAND_ATTRIBUTE,
          expanded ? "true" : "false",
        );
        expand.setAttribute("aria-expanded", expanded ? "true" : "false");
        expand.textContent = expanded
          ? t("Show less")
          : t("Show the whole page");
      };
      expand.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setExpanded(
          preview.getAttribute(FLAT_HTML_EXPAND_ATTRIBUTE) !== "true",
        );
      });
      preview.appendChild(expand);
      setExpanded(false);
    }

    syncFlatPreviewBarState(preview);
  }
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

    let wrapButton = (getDirectChildWithClass(
      header,
      "llm-codeblock-wrap-toggle",
    ) ||
      findFlatBarButton(
        shell,
        "llm-codeblock-wrap-toggle",
      )) as HTMLButtonElement | null;
    const initialWordWrap =
      shell.dataset.wordWrap === undefined
        ? shouldDefaultCodeBlockWordWrap(shell)
        : shell.dataset.wordWrap === "true";
    if (!wrapButton) {
      const createdWrapButton = doc.createElement(
        "button",
      ) as HTMLButtonElement;
      createdWrapButton.type = "button";
      createdWrapButton.className = "llm-codeblock-wrap-toggle";
      createdWrapButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setCodeBlockWordWrap(
          shell,
          createdWrapButton,
          shell.dataset.wordWrap !== "true",
        );
      });
      header.insertBefore(createdWrapButton, button);
      wrapButton = createdWrapButton;
    }
    setCodeBlockWordWrap(shell, wrapButton, initialWordWrap);
    attachCodeBlockFigureCopyButton(shell, header, doc);
  }
}

const FLAT_TABLE_CSV_NAME = "table.csv";
const UTF8_BOM = "\uFEFF";

function readTableRows(table: HTMLElement): {
  header: HTMLElement[][];
  body: HTMLElement[][];
} {
  const header: HTMLElement[][] = [];
  const body: HTMLElement[][] = [];
  for (const row of Array.from(table.querySelectorAll("tr")) as HTMLElement[]) {
    const cells = Array.from(row.children) as HTMLElement[];
    const isHeader =
      cells.length > 0 &&
      cells.every((cell) => (cell.tagName || "").toLowerCase() === "th");
    (isHeader ? header : body).push(cells);
  }
  return { header, body };
}

const cellText = (cell: HTMLElement): string =>
  (cell.textContent || "").replace(/\s+/g, " ").trim();

/** "Save as CSV": the table as text, written where the user picks. */
async function saveFlatTableAsCsv(
  doc: Document,
  table: HTMLElement,
): Promise<"saved" | "cancelled" | "failed"> {
  try {
    const { header, body } = readTableRows(table);
    const csv = tableRowsToCsv(
      [...header, ...body].map((row) => row.map(cellText)),
    );
    const target = await pickGeneratedImageSavePath(doc, FLAT_TABLE_CSV_NAME, {
      title: t("Save as CSV"),
      filter: { label: "CSV", pattern: "*.csv" },
    });
    if (target.status === "cancelled") return "cancelled";
    if (target.status !== "selected") return "failed";
    // The byte order mark lets Excel read non-English text as UTF-8.
    const bytes = new TextEncoder().encode(`${UTF8_BOM}${csv}\n`);
    await saveGeneratedImageAssetToPath(
      {
        image: { id: FLAT_TABLE_CSV_NAME },
        bytes,
        mimeType: "text/csv",
        fileName: FLAT_TABLE_CSV_NAME,
      },
      target.path,
    );
    return "saved";
  } catch {
    return "failed";
  }
}

/**
 * The flat answer style for tables: no outer box (CSS), numeric columns marked
 * for right alignment, and a hover bar with Copy table and Save as CSV. Runs
 * once per table, after the copy button exists; tables outside a flat scope
 * are left as they are.
 */
export function attachFlatTableChrome(root: ParentNode, doc: Document): void {
  const blocks = Array.from(
    root.querySelectorAll(".llm-copyable-table"),
  ) as HTMLElement[];
  for (const block of blocks) {
    if (block.dataset.flatChrome === "true") continue;
    if (!isInFlatContentScope(block)) continue;
    const table = (
      Array.from(block.querySelectorAll("table")) as HTMLElement[]
    )[0];
    if (!table) continue;
    block.dataset.flatChrome = "true";
    block.classList.add("llm-copyable-flat-table");

    const { header, body } = readTableRows(table);
    const numeric = detectNumericColumns(body.map((row) => row.map(cellText)));
    for (const row of [...header, ...body]) {
      row.forEach((cell, index) => {
        if (numeric[index]) cell.classList.add(NUMERIC_CELL_CLASS);
      });
    }

    const bar = ensureContentBar(block, doc);
    const copyButton = getDirectChildWithClass(
      block,
      "llm-render-copy-btn",
    ) as HTMLButtonElement | null;
    if (copyButton) {
      copyButton.textContent = "";
      const label = t("Copy table");
      copyButton.title = label;
      copyButton.setAttribute("aria-label", label);
      adoptContentBarButton(bar, copyButton);
      bindStandaloneCopyButton(copyButton);
    }
    const csvButton = appendContentBarButton(
      bar,
      {
        className: "llm-content-bar-save llm-content-bar-csv",
        label: t("Save as CSV"),
        onClick: () => {
          csvButton.disabled = true;
          void saveFlatTableAsCsv(doc, table).then((result) => {
            csvButton.disabled = false;
            if (result === "cancelled") return;
            csvButton.dataset.saveState = result;
            doc.defaultView?.setTimeout?.(() => {
              delete csvButton.dataset.saveState;
            }, FLAT_SAVE_RESET_DELAY_MS);
          });
        },
      },
      doc,
    );
  }
}

/**
 * The flat answer style for display equations: no tinted box (CSS) and a
 * hover bar with one button, Copy LaTeX. Inline math is left alone.
 */
export function attachFlatMathChrome(root: ParentNode, doc: Document): void {
  const blocks = Array.from(
    root.querySelectorAll(".llm-copyable-math"),
  ) as HTMLElement[];
  for (const block of blocks) {
    if (block.dataset.flatChrome === "true") continue;
    if (block.classList.contains("llm-copyable-inline")) continue;
    if (!isInFlatContentScope(block)) continue;
    const copyButton = getDirectChildWithClass(
      block,
      "llm-render-copy-btn",
    ) as HTMLButtonElement | null;
    if (!copyButton) continue;
    block.dataset.flatChrome = "true";
    block.classList.add("llm-copyable-flat-math");
    const bar = ensureContentBar(block, doc);
    copyButton.textContent = "";
    const label = t("Copy LaTeX");
    copyButton.title = label;
    copyButton.setAttribute("aria-label", label);
    adoptContentBarButton(bar, copyButton);
    bindStandaloneCopyButton(copyButton);
  }
}

/**
 * The flat answer style for plain Markdown pictures: the image sits in a
 * wrapper with a hover bar (Copy image, Open full view). Pictures with no
 * address (note attachments) are left alone.
 */
export function attachFlatInlineImageChrome(
  root: ParentNode,
  doc: Document,
): void {
  const images = Array.from(
    root.querySelectorAll(".llm-chat-inline-figure"),
  ) as HTMLImageElement[];
  for (const img of images) {
    if (img.dataset.flatChrome === "true") continue;
    if (!isInFlatContentScope(img)) continue;
    const src = (img.getAttribute("src") || "").trim();
    const parent = img.parentElement;
    if (!src || !parent) continue;
    img.dataset.flatChrome = "true";
    const wrapper = doc.createElement("span") as HTMLElement;
    wrapper.className = "llm-flat-inline-figure";
    parent.insertBefore(wrapper, img);
    wrapper.appendChild(img);

    const bar = ensureContentBar(wrapper, doc);
    appendContentBarButton(
      bar,
      {
        className: "llm-content-bar-copy-image",
        label: t("Copy image"),
        onClick: () => {
          void copyGeneratedImageToClipboard(wrapper, {
            id: "inline-image",
            src,
          }).catch(() => undefined);
        },
      },
      doc,
    );
    appendContentBarButton(
      bar,
      {
        className: "llm-content-bar-fullview",
        label: t("Open full view"),
        onClick: () => {
          const alt = img.getAttribute("alt") || "";
          const opened = openStandaloneViewerWindow(doc, {
            kind: "image",
            src: img.src || src,
            alt,
            caption: alt,
          });
          if (!opened) {
            openFigureViewer(wrapper, {
              src: img.src || src,
              alt,
              caption: alt,
            });
          }
        },
      },
      doc,
    );
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
    if (findFlatBarButton(copyable, "llm-render-copy-btn")) continue;
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

export function renderRenderedMathPreviewInto(
  target: HTMLElement,
  text: string,
  doc: Document,
): void {
  const safeText = sanitizeText(text);
  if (!setRenderedMarkdownHtml(target, renderMathPreviewHtml(safeText), doc)) {
    target.textContent = safeText;
  }
}

/**
 * Gives a streaming tail (rendered with deferEnrichment) the same flat chrome
 * as settled text, so code, tables and math do not show the old boxed look
 * while they stream. Diagrams and web pages are not drawn: their source is
 * still growing, so they wait until their block settles.
 */
export function attachStreamingTailChrome(
  target: HTMLElement,
  doc: Document,
): void {
  attachRenderedCodeBlockControls(target, doc);
  attachRenderedCopyButtons(target, doc);
  attachRenderedCodeBlockMoveButtons(target, doc);
  attachFlatCodeBlockChrome(target, doc);
  attachFlatPreviewChrome(target, doc);
  attachFlatTableChrome(target, doc);
  attachFlatMathChrome(target, doc);
  attachFlatInlineImageChrome(target, doc);
}

export function renderRenderedMarkdownInto(
  target: HTMLElement,
  text: string,
  doc: Document,
  options?: RenderedMarkdownOptions,
): void {
  target.classList.add("llm-rendered-markdown");
  if (options?.sideItems === false) {
    target.setAttribute(NO_SIDE_ITEMS_ATTRIBUTE, "true");
  }
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
  if (options?.deferEnrichment) return;
  attachRenderedCodeBlockControls(target, doc);
  attachRenderedCopyButtons(target, doc);
  attachRenderedCodeBlockMoveButtons(target, doc);
  attachFlatCodeBlockChrome(target, doc);
  attachRenderedSvgPreviewButtons(target, doc);
  attachRenderedHtmlPreviews(target, doc);
  syncPreviewThemes(target, doc);
  attachFlatPreviewChrome(target, doc);
  attachFlatTableChrome(target, doc);
  attachFlatMathChrome(target, doc);
  attachFlatInlineImageChrome(target, doc);
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
