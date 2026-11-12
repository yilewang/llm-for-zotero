import { markStandaloneFlatScope } from "./contentChrome";
import { config } from "../../../package.json";
import { installStandaloneWindowTitlebar } from "./standaloneWindowTitlebar";
import { HTML_NS } from "../../utils/domHelpers";
import { pluginStylesheetHref } from "../../utils/pluginReload";
import { createInlineSvgElement } from "./mermaidSvg";
import { createSandboxedHtmlFrame } from "./htmlPreviewFrame";
import { ZOOM_BUTTON_STEP } from "./wheelZoom";
import { attachFigurePanZoom, inlineSvgNaturalSize } from "./figureViewer";

type MermaidThemeKey = "light" | "dark";

export type StandaloneMermaidPayload = {
  svgMarkup: string;
  source: string;
  themeKey: MermaidThemeKey;
  title?: string;
};

export type StandaloneSvgPayload = {
  svgMarkup: string;
  themeKey: MermaidThemeKey;
  title?: string;
  ariaLabel?: string;
  toolbarLabel?: string;
  zoomTargetLabel?: string;
};

export type StandaloneViewerPayload =
  | ({ kind: "svg" } & StandaloneSvgPayload)
  | {
      kind: "image";
      src: string;
      title?: string;
      alt?: string;
      /** Shown as the window title and as a line under the picture. */
      caption?: string;
      themeKey?: MermaidThemeKey;
      /**
       * Adds buttons to the toolbar before the close button. They must build
       * with the target document they are given.
       */
      appendActions?: (parent: HTMLElement, targetDoc: Document) => void;
    }
  | {
      kind: "html";
      source: string;
      title?: string;
      themeKey?: MermaidThemeKey;
    }
  | {
      kind: "markdown";
      markdown: string;
      title?: string;
      themeKey?: MermaidThemeKey;
      /** Draws into the target; it must use the target's own document. */
      renderMarkdown: (target: HTMLElement, markdown: string) => void;
    };

type ViewerContent = {
  /** What the toolbar shows before the close button. */
  buttons: HTMLElement[];
  body: HTMLElement;
  /** Runs once the window is laid out and the stylesheet is in. */
  afterMount?: (css: HTMLLinkElement) => void;
};

const MERMAID_WINDOW_MIN_WIDTH_PX = 640;
const MERMAID_WINDOW_MIN_HEIGHT_PX = 420;
const MERMAID_WINDOW_ROOT_ID = "llmforzotero-standalone-mermaid-root";
const MERMAID_WINDOW_FEATURES =
  "chrome,extrachrome,menubar,resizable,scrollbars,status,centerscreen,dialog=no,dependent=no";

const DEFAULT_TITLES: Record<StandaloneViewerPayload["kind"], string> = {
  svg: "SVG Preview",
  image: "Picture",
  html: "Web page",
  markdown: "Markdown note",
};

type OpenDialogWindow = Window & {
  openDialog?: (...args: unknown[]) => Window | null;
};

function createButton(
  doc: Document,
  label: string,
  title: string,
): HTMLButtonElement {
  const button = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  button.type = "button";
  button.className = "llm-mermaid-window-btn";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  return button;
}

function syncThemeVariables(sourceDoc: Document, targetDoc: Document): void {
  const sourceWin = sourceDoc.defaultView;
  if (!sourceWin) return;
  const computed = sourceWin.getComputedStyle(sourceDoc.documentElement);
  if (!computed) return;
  const vars = [
    "--fill-primary",
    "--fill-secondary",
    "--fill-tertiary",
    "--stroke-secondary",
    "--material-background",
    "--material-sidepane",
    "--color-accent",
  ];
  const decls = vars
    .map((name) => {
      const value = computed.getPropertyValue(name).trim();
      return value ? `${name}: ${value};` : "";
    })
    .filter(Boolean)
    .join("\n  ");
  if (!decls) return;
  const style = targetDoc.createElementNS(HTML_NS, "style") as HTMLStyleElement;
  style.textContent = `:root {\n  ${decls}\n}`;
  targetDoc.documentElement?.prepend(style);
}

/** The chat's own theme, for a viewer kind that carries no theme key. */
function detectThemeKey(sourceDoc: Document): MermaidThemeKey {
  // The chat window records the theme it copied from Zotero on its root.
  const standaloneTheme = sourceDoc
    .getElementById("llmforzotero-standalone-chat-root")
    ?.getAttribute("data-standalone-theme");
  if (standaloneTheme === "dark" || standaloneTheme === "light") {
    return standaloneTheme;
  }
  const root = sourceDoc.documentElement;
  const dark =
    root?.hasAttribute("lwtheme-brighttext") ||
    root?.classList.contains("window-is-dark") ||
    Boolean(sourceDoc.querySelector(".window-is-dark"));
  return dark ? "dark" : "light";
}

/**
 * Pan and zoom for the svg and image kinds, the same as the old figure view:
 * wheel or pinch zooms around the pointer, a drag moves, a double click fits.
 * The toolbar shows − percent + fit.
 */
function buildZoomContent(
  doc: Document,
  targetWin: Window,
  root: HTMLElement,
  media: HTMLElement | SVGElement,
  zoomTargetLabel: string,
  extras: { caption?: string; actions?: HTMLElement[] } = {},
): ViewerContent {
  const zoomOut = createButton(doc, "−", `Zoom out ${zoomTargetLabel}`);
  const zoomIn = createButton(doc, "+", `Zoom in ${zoomTargetLabel}`);
  const fit = createButton(doc, "⛶", `Fit ${zoomTargetLabel} to window`);
  const percent = doc.createElementNS(HTML_NS, "span") as HTMLSpanElement;
  percent.className = "llm-figure-viewer-percent llm-mermaid-window-percent";

  const viewport = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  viewport.className = "llm-mermaid-window-viewport";
  const stage = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  stage.className = "llm-mermaid-window-stage";
  if (extras.caption) stage.classList.add("llm-mermaid-window-stage-captioned");
  stage.appendChild(media);
  viewport.appendChild(stage);
  if (extras.caption) {
    const caption = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
    caption.className = "llm-mermaid-window-caption";
    caption.textContent = extras.caption;
    viewport.appendChild(caption);
  }

  const isImage = media.localName.toLowerCase() === "img";
  const panZoom = attachFigurePanZoom({
    stage,
    image: media,
    naturalSize: isImage
      ? undefined
      : () => inlineSvgNaturalSize(media as SVGElement),
    stateRoot: root,
    percent,
  });
  stage.addEventListener("dblclick", () => panZoom.fit());
  zoomOut.addEventListener("click", () =>
    panZoom.zoomTo(panZoom.scale() - ZOOM_BUTTON_STEP),
  );
  zoomIn.addEventListener("click", () =>
    panZoom.zoomTo(panZoom.scale() + ZOOM_BUTTON_STEP),
  );
  fit.addEventListener("click", () => panZoom.fit());
  targetWin.addEventListener("resize", () => panZoom.relayout());

  return {
    buttons: [zoomOut, percent, zoomIn, fit, ...(extras.actions || [])],
    body: viewport,
    afterMount: (css) => {
      css.addEventListener("load", () => panZoom.relayout(), { once: true });
      panZoom.relayout();
      targetWin.requestAnimationFrame?.(() => panZoom.relayout());
    },
  };
}

function buildViewerContent(
  doc: Document,
  targetWin: Window,
  root: HTMLElement,
  payload: StandaloneViewerPayload,
  themeKey: MermaidThemeKey,
): { content: ViewerContent; label: string } | null {
  if (payload.kind === "svg") {
    const zoomTargetLabel = payload.zoomTargetLabel || "SVG preview";
    const svg = createInlineSvgElement(
      doc,
      payload.svgMarkup,
      "llm-mermaid-window-media",
      payload.ariaLabel || "SVG preview",
    );
    if (!svg) return null;
    // Diagram SVGs carry an inline max-width that would stop the zoom.
    svg.style.maxWidth = "none";
    return {
      content: buildZoomContent(doc, targetWin, root, svg, zoomTargetLabel),
      label: zoomTargetLabel,
    };
  }
  if (payload.kind === "image") {
    const img = doc.createElementNS(HTML_NS, "img") as HTMLImageElement;
    img.className = "llm-mermaid-window-media";
    img.alt = payload.alt || payload.title || payload.caption || "";
    img.src = payload.src;
    const actionHost = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
    payload.appendActions?.(actionHost, doc);
    return {
      content: buildZoomContent(doc, targetWin, root, img, "picture", {
        caption: payload.caption,
        actions: Array.from(actionHost.children) as HTMLElement[],
      }),
      label: "picture",
    };
  }
  if (payload.kind === "html") {
    const frame = createSandboxedHtmlFrame(
      doc,
      payload.source,
      "llm-viewer-window-frame",
      themeKey,
    );
    return { content: { buttons: [], body: frame }, label: "page" };
  }
  const scroller = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  scroller.className = "llm-viewer-window-document";
  const article = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  article.className =
    "llm-viewer-window-markdown llm-standalone-side-panel-item-rendered";
  markStandaloneFlatScope(article);
  scroller.appendChild(article);
  payload.renderMarkdown(article, payload.markdown);
  return { content: { buttons: [], body: scroller }, label: "note" };
}

function initializeStandaloneViewerWindow(
  sourceDoc: Document,
  targetWin: Window,
  payload: StandaloneViewerPayload,
): boolean {
  if (targetWin.closed) return false;
  const doc = targetWin.document;
  const root = doc.getElementById(MERMAID_WINDOW_ROOT_ID) as HTMLElement | null;
  if (!root) return false;

  const themeKey =
    ("themeKey" in payload && payload.themeKey) || detectThemeKey(sourceDoc);
  doc.title =
    payload.title ||
    (payload.kind === "image" && payload.caption) ||
    DEFAULT_TITLES[payload.kind];
  doc.documentElement?.setAttribute(
    "minwidth",
    `${MERMAID_WINDOW_MIN_WIDTH_PX}`,
  );
  doc.documentElement?.setAttribute(
    "minheight",
    `${MERMAID_WINDOW_MIN_HEIGHT_PX}`,
  );
  syncThemeVariables(sourceDoc, doc);

  const css = doc.createElementNS(HTML_NS, "link") as HTMLLinkElement;
  css.rel = "stylesheet";
  css.type = "text/css";
  css.href = pluginStylesheetHref("zoteroPane.css");
  doc.documentElement?.appendChild(css);

  root.className = [
    "llm-mermaid-window-root",
    themeKey === "dark" ? "llm-mermaid-theme-dark" : "llm-mermaid-theme-light",
    `llm-viewer-window-${payload.kind}`,
  ].join(" ");
  root.dataset.llmMermaidTheme = themeKey;

  const built = buildViewerContent(doc, targetWin, root, payload, themeKey);
  if (!built) return false;
  const { content, label } = built;

  const toolbar = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  toolbar.className = "llm-mermaid-window-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute(
    "aria-label",
    (payload.kind === "svg" && payload.toolbarLabel) ||
      `${label} window controls`,
  );
  const close = createButton(doc, "×", `Close ${label} window`);
  toolbar.append(...content.buttons, close);

  root.replaceChildren(toolbar, content.body);
  // Inside the root, so the strip inherits the canvas surface colour.
  installStandaloneWindowTitlebar(doc, root);

  const closeWindow = () => targetWin.close();
  close.addEventListener("click", closeWindow);
  doc.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      closeWindow();
      return;
    }
    const isMac = (Zotero as any).isMac;
    if ((isMac ? event.metaKey : event.ctrlKey) && event.key === "w") {
      event.preventDefault();
      closeWindow();
    }
  });
  content.afterMount?.(css);
  return true;
}

/**
 * The one full-view window for what the chat makes: a diagram, an SVG, a web
 * page, a Markdown note or a picture. Returns false when the host cannot open
 * a dialog, so the caller can fall back.
 */
export function openStandaloneViewerWindow(
  doc: Document,
  payload: StandaloneViewerPayload,
): boolean {
  const opener = doc.defaultView as OpenDialogWindow | null;
  const openDialog = opener?.openDialog;
  if (!opener || typeof openDialog !== "function") return false;

  const newWin = openDialog.call(
    opener,
    `chrome://${config.addonRef}/content/standaloneMermaid.xhtml`,
    `llmforzotero-standalone-${payload.kind}-${Date.now()}`,
    MERMAID_WINDOW_FEATURES,
  ) as Window | null;
  if (!newWin) return false;

  let attempts = 0;
  let initialized = false;
  const tryInitialize = () => {
    if (initialized || newWin.closed) return;
    if (initializeStandaloneViewerWindow(doc, newWin, payload)) {
      initialized = true;
      return;
    }
    attempts += 1;
    if (attempts < 40) {
      newWin.setTimeout(tryInitialize, 25);
    }
  };
  newWin.addEventListener("load", tryInitialize, { once: true });
  newWin.setTimeout(tryInitialize, 0);
  return true;
}

export function openStandaloneSvgWindow(
  doc: Document,
  payload: StandaloneSvgPayload,
): boolean {
  return openStandaloneViewerWindow(doc, { kind: "svg", ...payload });
}

export function openStandaloneMermaidWindow(
  doc: Document,
  payload: StandaloneMermaidPayload,
): boolean {
  return openStandaloneSvgWindow(doc, {
    ...payload,
    title: payload.title || "Mermaid Diagram",
    ariaLabel: "Mermaid diagram",
    toolbarLabel: "Mermaid diagram controls",
    zoomTargetLabel: "diagram",
  });
}
