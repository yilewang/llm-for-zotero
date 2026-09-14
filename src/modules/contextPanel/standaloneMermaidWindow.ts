import { config } from "../../../package.json";
import { installStandaloneWindowTitlebar } from "./standaloneWindowTitlebar";
import { HTML_NS } from "../../utils/domHelpers";
import { createInlineSvgElement } from "./mermaidSvg";

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

const MERMAID_WINDOW_MIN_WIDTH_PX = 640;
const MERMAID_WINDOW_MIN_HEIGHT_PX = 420;
const MERMAID_WINDOW_ZOOM_MIN = 0.5;
const MERMAID_WINDOW_ZOOM_MAX = 4;
const MERMAID_WINDOW_ZOOM_STEP = 0.25;
const MERMAID_WINDOW_WHEEL_ZOOM_DELTA_MAX = 24;
const MERMAID_WINDOW_WHEEL_ZOOM_SENSITIVITY = 0.002;
const MERMAID_WINDOW_ROOT_ID = "llmforzotero-standalone-mermaid-root";
const MERMAID_WINDOW_FEATURES =
  "chrome,extrachrome,menubar,resizable,scrollbars,status,centerscreen,dialog=no,dependent=no";

type OpenDialogWindow = Window & {
  openDialog?: (...args: unknown[]) => Window | null;
};

function clampZoom(scale: number): number {
  return Math.min(
    MERMAID_WINDOW_ZOOM_MAX,
    Math.max(MERMAID_WINDOW_ZOOM_MIN, scale),
  );
}

function getWheelZoomScale(scale: number, deltaY: number): number {
  const boundedDelta = Math.min(
    MERMAID_WINDOW_WHEEL_ZOOM_DELTA_MAX,
    Math.max(-MERMAID_WINDOW_WHEEL_ZOOM_DELTA_MAX, deltaY),
  );
  return (
    scale * Math.exp(-boundedDelta * MERMAID_WINDOW_WHEEL_ZOOM_SENSITIVITY)
  );
}

function formatZoom(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

function parsePixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getViewportContentWidth(win: Window, viewport: HTMLElement): number {
  const computed = win.getComputedStyle(viewport);
  const horizontalPadding = computed
    ? parsePixelValue(computed.paddingLeft) +
      parsePixelValue(computed.paddingRight)
    : 0;
  return Math.max(1, viewport.clientWidth - horizontalPadding);
}

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

function initializeStandaloneSvgWindow(
  sourceDoc: Document,
  targetWin: Window,
  payload: StandaloneSvgPayload,
): boolean {
  if (targetWin.closed) return false;
  const doc = targetWin.document;
  const root = doc.getElementById(MERMAID_WINDOW_ROOT_ID) as HTMLElement | null;
  if (!root) return false;

  doc.title = payload.title || "SVG Preview";
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
  css.href = `chrome://${config.addonRef}/content/zoteroPane.css`;
  doc.documentElement?.appendChild(css);

  root.className = [
    "llm-mermaid-window-root",
    payload.themeKey === "dark"
      ? "llm-mermaid-theme-dark"
      : "llm-mermaid-theme-light",
  ].join(" ");
  root.dataset.llmMermaidTheme = payload.themeKey;

  const toolbar = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  toolbar.className = "llm-mermaid-window-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute(
    "aria-label",
    payload.toolbarLabel || "SVG preview controls",
  );

  const zoomTargetLabel = payload.zoomTargetLabel || "SVG preview";
  const zoomOut = createButton(doc, "−", `Zoom out ${zoomTargetLabel}`);
  const zoomIn = createButton(doc, "+", `Zoom in ${zoomTargetLabel}`);
  const fit = createButton(doc, "⛶", `Fit ${zoomTargetLabel} to window`);
  const close = createButton(doc, "×", `Close ${zoomTargetLabel} window`);
  toolbar.append(zoomOut, zoomIn, fit, close);

  const viewport = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  viewport.className = "llm-mermaid-window-viewport";

  const stage = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  stage.className = "llm-mermaid-window-stage";

  const svg = createInlineSvgElement(
    doc,
    payload.svgMarkup,
    "llm-mermaid-window-svg",
    payload.ariaLabel || "SVG preview",
  );
  if (!svg) return false;
  stage.appendChild(svg);
  viewport.appendChild(stage);
  root.replaceChildren(toolbar, viewport);
  // Inside the root, so the strip inherits the canvas surface colour.
  installStandaloneWindowTitlebar(doc, root);

  let scale = 1;
  let baseFitWidth = 0;
  const getBaseFitWidth = () => {
    const nextWidth = getViewportContentWidth(targetWin, viewport);
    if (nextWidth > 0) baseFitWidth = nextWidth;
    return baseFitWidth || 1;
  };
  const applyZoom = (nextScale: number) => {
    const previousWidth = stage.scrollWidth || stage.clientWidth || 1;
    const centerX = viewport.scrollLeft + viewport.clientWidth / 2;
    const centerRatio = previousWidth > 0 ? centerX / previousWidth : 0.5;
    scale = clampZoom(nextScale);
    const baseWidth = getBaseFitWidth();
    const displayWidth = Math.max(1, Math.round(baseWidth * scale));
    const stageWidth = Math.max(baseWidth, displayWidth);
    stage.style.width = `${stageWidth}px`;
    svg.style.width = `${displayWidth}px`;
    root.dataset.mermaidZoom = formatZoom(scale);
    zoomOut.disabled = scale <= MERMAID_WINDOW_ZOOM_MIN;
    zoomIn.disabled = scale >= MERMAID_WINDOW_ZOOM_MAX;
    targetWin.requestAnimationFrame?.(() => {
      viewport.scrollLeft = Math.max(
        0,
        Math.round(stage.scrollWidth * centerRatio - viewport.clientWidth / 2),
      );
    });
  };
  const closeWindow = () => targetWin.close();

  zoomOut.addEventListener("click", () =>
    applyZoom(scale - MERMAID_WINDOW_ZOOM_STEP),
  );
  zoomIn.addEventListener("click", () =>
    applyZoom(scale + MERMAID_WINDOW_ZOOM_STEP),
  );
  fit.addEventListener("click", () => {
    applyZoom(1);
    viewport.scrollTop = 0;
    viewport.scrollLeft = 0;
  });
  close.addEventListener("click", closeWindow);
  viewport.addEventListener("wheel", (event: WheelEvent) => {
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    applyZoom(getWheelZoomScale(scale, event.deltaY));
  });
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
  css.addEventListener("load", () => applyZoom(scale), { once: true });
  targetWin.addEventListener("resize", () => applyZoom(scale));

  applyZoom(1);
  targetWin.requestAnimationFrame?.(() => applyZoom(scale));
  return true;
}

export function openStandaloneSvgWindow(
  doc: Document,
  payload: StandaloneSvgPayload,
): boolean {
  const opener = doc.defaultView as OpenDialogWindow | null;
  const openDialog = opener?.openDialog;
  if (!opener || typeof openDialog !== "function") return false;

  const newWin = openDialog.call(
    opener,
    `chrome://${config.addonRef}/content/standaloneMermaid.xhtml`,
    `llmforzotero-standalone-svg-${Date.now()}`,
    MERMAID_WINDOW_FEATURES,
  ) as Window | null;
  if (!newWin) return false;

  let attempts = 0;
  let initialized = false;
  const tryInitialize = () => {
    if (initialized || newWin.closed) return;
    if (initializeStandaloneSvgWindow(doc, newWin, payload)) {
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
