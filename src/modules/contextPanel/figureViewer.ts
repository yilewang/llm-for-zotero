import { HTML_NS } from "../../utils/domHelpers";
import { registerAddonInPanelDialog } from "../../utils/dialogRegistry";
import { ZOOM_BUTTON_STEP, getWheelZoomScale } from "./wheelZoom";

/**
 * The large figure view. A click on a figure in the chat opens it over the
 * plugin — the chat panel in Zotero's sidebar, the whole standalone window —
 * fitted to the space. A click on the picture switches to actual size (and
 * back), a drag moves it, the wheel and + / − zoom, and ×, Esc or a click
 * beside the picture closes it.
 */

export type FigureViewSize = { width: number; height: number };
export type FigureViewTransform = { scale: number; x: number; y: number };

export const FIGURE_VIEW_MAX_SCALE = 4;
const FIGURE_VIEW_PADDING = 16;
/** Below this width the bar keeps only zoom and close. */
const FIGURE_VIEW_NARROW_WIDTH = 480;
/** A press that moves less than this is a click, not a drag. */
const FIGURE_VIEW_CLICK_SLOP = 4;
const STANDALONE_ROOT_ID = "llmforzotero-standalone-chat-root";

/** The scale that fits the whole picture in the stage, never above 100%. */
export function fitFigureScale(
  natural: FigureViewSize,
  stage: FigureViewSize,
  padding = FIGURE_VIEW_PADDING,
): number {
  if (!(natural.width > 0 && natural.height > 0)) return 1;
  const scale = Math.min(
    (stage.width - padding * 2) / natural.width,
    (stage.height - padding * 2) / natural.height,
    1,
  );
  return scale > 0 ? scale : 0.01;
}

/**
 * Keeps the picture in view: centred along a side where it is smaller than
 * the stage, and with no empty gap along a side where it is larger.
 */
export function clampFigurePan(
  view: FigureViewTransform,
  natural: FigureViewSize,
  stage: FigureViewSize,
): FigureViewTransform {
  const clampAxis = (offset: number, size: number, room: number) =>
    size <= room
      ? (room - size) / 2
      : Math.min(0, Math.max(room - size, offset));
  return {
    scale: view.scale,
    x: clampAxis(view.x, natural.width * view.scale, stage.width),
    y: clampAxis(view.y, natural.height * view.scale, stage.height),
  };
}

/** Zooms so the point under the pointer stays where it is. */
export function zoomFigureAround(
  view: FigureViewTransform,
  nextScale: number,
  point: { x: number; y: number },
  minScale: number,
  natural: FigureViewSize,
  stage: FigureViewSize,
): FigureViewTransform {
  const scale = Math.max(
    minScale,
    Math.min(FIGURE_VIEW_MAX_SCALE, Number.isFinite(nextScale) ? nextScale : 1),
  );
  const ratio = scale / view.scale;
  return clampFigurePan(
    {
      scale,
      x: point.x - (point.x - view.x) * ratio,
      y: point.y - (point.y - view.y) * ratio,
    },
    natural,
    stage,
  );
}

export type FigureViewerOptions = {
  src: string;
  alt: string;
  /** "Figure 1 · p. 3"; the bar shows it and the dialog is named by it. */
  caption: string;
  /**
   * Adds the figure box's own buttons (jump, copy, save, folder, →|) to the
   * bar. Jump and →| close the view after they run.
   */
  appendActions?: (parent: HTMLElement) => void;
};

function htmlEl<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  node.className = className;
  return node;
}

/**
 * Where the view goes: the standalone window's root (the view covers the
 * window), else the chat panel the figure sits in (the view covers the
 * panel), else the document.
 */
function resolveFigureViewerHost(anchor: Element): {
  host: Element;
  coversWindow: boolean;
} | null {
  const doc = anchor.ownerDocument;
  if (!doc) return null;
  const standaloneRoot = doc.getElementById(STANDALONE_ROOT_ID);
  if (standaloneRoot) return { host: standaloneRoot, coversWindow: true };
  const panel = anchor.closest(".llm-panel");
  if (panel) return { host: panel, coversWindow: false };
  const fallback = doc.body ?? doc.documentElement;
  return fallback ? { host: fallback, coversWindow: true } : null;
}

export type FigurePanZoom = {
  fit: () => void;
  zoomTo: (scale: number, clientX?: number, clientY?: number) => void;
  /** Reads the stage size again: refits when fitted, else keeps the zoom. */
  relayout: () => void;
  scale: () => number;
  isZoomed: () => boolean;
};

/**
 * Natural size of an inline SVG: its viewBox, else its width and height
 * attributes, else its bounding box, else 800 x 600.
 */
export function inlineSvgNaturalSize(svg: SVGElement): FigureViewSize {
  const box = (svg as SVGSVGElement).viewBox?.baseVal;
  if (box && box.width > 0 && box.height > 0) {
    return { width: box.width, height: box.height };
  }
  const width = Number.parseFloat(svg.getAttribute("width") || "");
  const height = Number.parseFloat(svg.getAttribute("height") || "");
  if (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    !svg.getAttribute("width")?.includes("%") &&
    !svg.getAttribute("height")?.includes("%")
  ) {
    return { width, height };
  }
  try {
    const bbox = (svg as SVGGraphicsElement).getBBox();
    if (bbox.width > 0 && bbox.height > 0) {
      return { width: bbox.width, height: bbox.height };
    }
  } catch {
    // getBBox throws when the element is not rendered.
  }
  return { width: 800, height: 600 };
}

/**
 * Wheel / pinch zoom and drag-to-move for a picture in a stage. The large
 * view and the side panel figure tab both use it, so they zoom alike (at the
 * Mermaid window's speed, see wheelZoom.ts).
 */
export function attachFigurePanZoom(params: {
  stage: HTMLElement;
  /** A picture, or another element (an inline SVG) given `naturalSize`. */
  image: HTMLElement | SVGElement;
  /** Size of a non-picture element; null while it is not known yet. */
  naturalSize?: () => FigureViewSize | null;
  /** Gets the zoomed / dragging classes for the cursors. */
  stateRoot: HTMLElement;
  percent?: HTMLElement;
  /** A press that did not move: on the picture or beside it. */
  onClick?: (onImage: boolean, clientX: number, clientY: number) => void;
}): FigurePanZoom {
  const { stage, stateRoot, percent, naturalSize } = params;
  const image = params.image as HTMLElement & Partial<HTMLImageElement>;
  let natural: FigureViewSize = { width: 0, height: 0 };
  let view: FigureViewTransform = { scale: 1, x: 0, y: 0 };
  let minScale = 1;

  const stageSize = (): FigureViewSize => ({
    width: stage.clientWidth,
    height: stage.clientHeight,
  });
  const isZoomed = () => view.scale > minScale + 0.001;
  const paint = () => {
    image.style.width = `${natural.width}px`;
    image.style.height = `${natural.height}px`;
    image.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    if (percent) percent.textContent = `${Math.round(view.scale * 100)}%`;
    stateRoot.classList.toggle("llm-figure-viewer-zoomed", isZoomed());
  };
  const fit = () => {
    if (!natural.width) return;
    minScale = fitFigureScale(natural, stageSize());
    view = clampFigurePan(
      { scale: minScale, x: 0, y: 0 },
      natural,
      stageSize(),
    );
    paint();
  };
  const zoomTo = (scale: number, clientX?: number, clientY?: number) => {
    if (!natural.width) return;
    const rect = stage.getBoundingClientRect();
    const point = {
      x: clientX === undefined ? rect.width / 2 : clientX - rect.left,
      y: clientY === undefined ? rect.height / 2 : clientY - rect.top,
    };
    view = zoomFigureAround(view, scale, point, minScale, natural, stageSize());
    paint();
  };
  const relayout = () => {
    if (!natural.width && naturalSize) onImageReady();
    if (!natural.width) return;
    if (!isZoomed()) {
      fit();
      return;
    }
    minScale = fitFigureScale(natural, stageSize());
    view = clampFigurePan(
      { ...view, scale: Math.max(view.scale, minScale) },
      natural,
      stageSize(),
    );
    paint();
  };

  const onImageReady = () => {
    if (naturalSize) {
      const size = naturalSize();
      if (!size || !(size.width > 0) || !(size.height > 0)) return;
      natural = size;
    } else {
      natural = {
        width: image.naturalWidth || 800,
        height: image.naturalHeight || 600,
      };
    }
    fit();
  };
  image.draggable = false;
  if (naturalSize) {
    onImageReady();
  } else {
    image.addEventListener("load", onImageReady);
    if (image.complete && image.naturalWidth) onImageReady();
  }

  let press: {
    x: number;
    y: number;
    viewX: number;
    viewY: number;
    onImage: boolean;
    moved: boolean;
  } | null = null;
  stage.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    press = {
      x: event.clientX,
      y: event.clientY,
      viewX: view.x,
      viewY: view.y,
      onImage: image.contains(event.target as Node | null),
      moved: false,
    };
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      // Capture only keeps a drag alive outside the stage.
    }
  });
  stage.addEventListener("pointermove", (event: PointerEvent) => {
    if (!press) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (Math.abs(dx) + Math.abs(dy) > FIGURE_VIEW_CLICK_SLOP)
      press.moved = true;
    if (!press.moved || !isZoomed()) return;
    stateRoot.classList.add("llm-figure-viewer-dragging");
    view = clampFigurePan(
      { scale: view.scale, x: press.viewX + dx, y: press.viewY + dy },
      natural,
      stageSize(),
    );
    paint();
  });
  const endPress = (event: PointerEvent) => {
    const current = press;
    press = null;
    stateRoot.classList.remove("llm-figure-viewer-dragging");
    if (!current || current.moved || event.type !== "pointerup") return;
    params.onClick?.(current.onImage, event.clientX, event.clientY);
  };
  stage.addEventListener("pointerup", endPress);
  stage.addEventListener("pointercancel", endPress);
  stage.addEventListener(
    "wheel",
    (event: WheelEvent) => {
      event.preventDefault();
      zoomTo(
        getWheelZoomScale(view.scale, event.deltaY),
        event.clientX,
        event.clientY,
      );
    },
    { passive: false },
  );

  return { fit, zoomTo, relayout, scale: () => view.scale, isZoomed };
}

/** Opens the large view of a figure; returns a function that closes it. */
export function openFigureViewer(
  anchor: Element,
  options: FigureViewerOptions,
): () => void {
  const resolved = resolveFigureViewerHost(anchor);
  const doc = anchor.ownerDocument;
  const win = doc?.defaultView;
  if (!resolved || !doc || !win) return () => {};
  const { host, coversWindow } = resolved;
  const previousActiveElement = doc.activeElement as HTMLElement | null;

  const overlay = htmlEl(doc, "div", "llm-figure-viewer");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", options.caption || options.alt);
  overlay.tabIndex = -1;

  const bar = htmlEl(doc, "div", "llm-figure-viewer-bar");
  const title = htmlEl(doc, "span", "llm-figure-viewer-title");
  title.textContent = options.caption;
  title.title = options.caption;

  const barButton = (className: string, label: string) => {
    const button = htmlEl(
      doc,
      "button",
      `llm-generated-image-action llm-figure-viewer-button ${className}`,
    );
    button.type = "button";
    button.setAttribute("aria-label", label);
    return button;
  };
  const zoomGroup = htmlEl(doc, "span", "llm-figure-viewer-group");
  const zoomOut = barButton("llm-figure-viewer-zoom-out", "Zoom out");
  const percent = htmlEl(doc, "span", "llm-figure-viewer-percent");
  const zoomIn = barButton("llm-figure-viewer-zoom-in", "Zoom in");
  const fitButton = barButton("llm-figure-viewer-fit", "Fit to window");
  zoomGroup.append(zoomOut, percent, zoomIn, fitButton);

  const actionGroup = htmlEl(
    doc,
    "span",
    "llm-figure-viewer-group llm-figure-viewer-actions",
  );
  options.appendActions?.(actionGroup);
  const closeButton = barButton("llm-figure-viewer-close", "Close (Esc)");
  bar.append(title, zoomGroup);
  if (actionGroup.childElementCount) bar.append(actionGroup);
  bar.append(closeButton);

  const stage = htmlEl(doc, "div", "llm-figure-viewer-stage");
  const image = htmlEl(doc, "img", "llm-figure-viewer-image");
  image.alt = options.alt;
  stage.appendChild(image);

  const hint = htmlEl(doc, "div", "llm-figure-viewer-hint");
  hint.textContent =
    "Click the figure for actual size · Scroll to zoom · Drag to move · Esc or click outside to close";
  overlay.append(bar, stage, hint);

  let closed = false;
  const panZoom = attachFigurePanZoom({
    stage,
    image,
    stateRoot: overlay,
    percent,
    onClick: (onImage, clientX, clientY) => {
      if (!onImage) close();
      else if (panZoom.isZoomed()) panZoom.fit();
      else panZoom.zoomTo(1, clientX, clientY);
    },
  });
  const { fit, zoomTo } = panZoom;
  const currentScale = () => panZoom.scale();

  // The panel can move or resize (the sidebar is dragged) while the view is
  // open, so its box is read again on every resize.
  const placeOverlay = () => {
    if (coversWindow) return;
    const rect = host.getBoundingClientRect();
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  };
  const relayout = () => {
    placeOverlay();
    overlay.classList.toggle(
      "llm-figure-viewer-narrow",
      overlay.getBoundingClientRect().width < FIGURE_VIEW_NARROW_WIDTH,
    );
    fit();
  };

  const stopButtonEvent = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  zoomIn.addEventListener("click", (event: Event) => {
    stopButtonEvent(event);
    zoomTo(currentScale() + ZOOM_BUTTON_STEP);
  });
  zoomOut.addEventListener("click", (event: Event) => {
    stopButtonEvent(event);
    zoomTo(currentScale() - ZOOM_BUTTON_STEP);
  });
  fitButton.addEventListener("click", (event: Event) => {
    stopButtonEvent(event);
    fit();
  });
  closeButton.addEventListener("click", (event: Event) => {
    stopButtonEvent(event);
    close();
  });
  // Jump opens the paper and →| opens the side panel: the view gets out of
  // the way once they have run (capture sees the click before the button).
  actionGroup.addEventListener(
    "click",
    (event: Event) => {
      const target = event.target as Element | null;
      if (
        target?.closest?.(
          ".llm-generated-image-action-jump, .llm-side-move-btn",
        )
      ) {
        win.setTimeout(() => close(), 0);
      }
    },
    true,
  );
  // Clicks inside the view never reach the chat underneath.
  overlay.addEventListener("click", (event: Event) => event.stopPropagation());

  const onKeydown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    let handled = true;
    if (event.key === "Escape") close();
    else if (event.key === "+" || event.key === "=")
      zoomTo(currentScale() + ZOOM_BUTTON_STEP);
    else if (event.key === "-") zoomTo(currentScale() - ZOOM_BUTTON_STEP);
    else if (event.key === "0") fit();
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  doc.addEventListener("keydown", onKeydown, true);

  const ResizeObserverCtor = (
    win as unknown as {
      ResizeObserver?: typeof ResizeObserver;
    }
  ).ResizeObserver;
  const resizeObserver = ResizeObserverCtor
    ? new ResizeObserverCtor(() => relayout())
    : null;
  const onWindowResize = () => relayout();

  let unregisterDialog = () => {};
  function close(): void {
    if (closed) return;
    closed = true;
    unregisterDialog();
    doc!.removeEventListener("keydown", onKeydown, true);
    win!.removeEventListener("resize", onWindowResize);
    resizeObserver?.disconnect();
    overlay.remove();
    try {
      previousActiveElement?.focus?.({ preventScroll: true });
    } catch {
      // The element that had focus may be gone after a re-render.
    }
  }
  unregisterDialog = registerAddonInPanelDialog(doc, close);

  if (coversWindow) overlay.classList.add("llm-figure-viewer-window");
  host.appendChild(overlay);
  placeOverlay();
  resizeObserver?.observe(host);
  win.addEventListener("resize", onWindowResize);
  image.src = options.src;
  relayout();
  // The view itself takes focus (for Esc and the zoom keys); focusing the
  // close button would show its ring and label before anything is pressed.
  try {
    overlay.focus({ preventScroll: true });
  } catch {
    overlay.focus();
  }
  return close;
}

/**
 * Fills a stage in a side panel tab with a zoomable view of `media`: scroll
 * or pinch zooms around the pointer, a drag moves it, a double click (or the
 * fit button) fits it again, and a small - % + fit pill sits in the stage's
 * corner. The caller has already put `stage` in place; `stateRoot` gets the
 * zoomed / dragging classes.
 */
function fillTabZoomStage(
  stateRoot: HTMLElement,
  stage: HTMLElement,
  media: HTMLElement | SVGElement,
  naturalSize?: () => FigureViewSize | null,
): FigurePanZoom | null {
  const doc = stage.ownerDocument;
  const win = doc?.defaultView;
  if (!doc || !win) return null;
  stage.appendChild(media);

  const button = (className: string, label: string) => {
    const node = htmlEl(
      doc,
      "button",
      `llm-generated-image-action llm-figure-viewer-button ${className}`,
    );
    node.type = "button";
    node.setAttribute("aria-label", label);
    return node;
  };
  const controls = htmlEl(doc, "div", "llm-figure-tab-zoom");
  const zoomOut = button("llm-figure-viewer-zoom-out", "Zoom out");
  const percent = htmlEl(doc, "span", "llm-figure-viewer-percent");
  const zoomIn = button("llm-figure-viewer-zoom-in", "Zoom in");
  const fitButton = button("llm-figure-viewer-fit", "Fit to tab");
  controls.append(zoomOut, percent, zoomIn, fitButton);
  stage.appendChild(controls);

  const panZoom = attachFigurePanZoom({
    stage,
    image: media,
    naturalSize,
    stateRoot,
    percent,
  });
  // The controls sit inside the stage: their presses are not drags.
  controls.addEventListener("pointerdown", (event: Event) =>
    event.stopPropagation(),
  );
  controls.addEventListener("wheel", (event: Event) => event.stopPropagation());
  const onButton = (target: HTMLElement, run: () => void) =>
    target.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      run();
    });
  onButton(zoomIn, () => panZoom.zoomTo(panZoom.scale() + ZOOM_BUTTON_STEP));
  onButton(zoomOut, () => panZoom.zoomTo(panZoom.scale() - ZOOM_BUTTON_STEP));
  onButton(fitButton, () => panZoom.fit());
  stage.addEventListener("dblclick", (event: Event) => {
    if (controls.contains(event.target as Node)) return;
    event.preventDefault();
    panZoom.fit();
  });

  const ResizeObserverCtor = (
    win as unknown as { ResizeObserver?: typeof ResizeObserver }
  ).ResizeObserver;
  if (ResizeObserverCtor) {
    new ResizeObserverCtor(() => panZoom.relayout()).observe(stage);
  }
  return panZoom;
}

/**
 * Turns a figure box in a side panel tab into a zoomable view: the picture
 * fits the tab, scroll or pinch zooms around the pointer, a drag moves it,
 * and a double click (or the fit button) fits it again.
 */
export function mountFigureTabZoom(
  frame: HTMLElement,
  image: HTMLImageElement,
): FigurePanZoom | null {
  const doc = frame.ownerDocument;
  if (!doc?.defaultView) return null;
  frame.classList.add("llm-figure-tab-frame");
  const stage = htmlEl(doc, "div", "llm-figure-tab-stage");
  image.replaceWith(stage);
  image.classList.add("llm-figure-tab-image");
  image.removeAttribute("title");
  return fillTabZoomStage(frame, stage, image);
}

/**
 * The same zoomable view for a diagram or drawing tab. `preview` is the
 * element that held the rendered diagram (its children are replaced); `media`
 * is the inline SVG or the picture. The view fills the preview.
 */
export function mountDiagramTabZoom(
  preview: HTMLElement,
  media: HTMLElement | SVGElement,
): FigurePanZoom | null {
  const doc = preview.ownerDocument;
  if (!doc?.defaultView) return null;
  preview.classList.add("llm-figure-tab-frame", "llm-diagram-tab-frame");
  const stage = htmlEl(doc, "div", "llm-figure-tab-stage");
  preview.replaceChildren(stage);
  media.classList.add("llm-figure-tab-image", "llm-diagram-tab-media");
  media.removeAttribute("title");
  const isImage = media.localName.toLowerCase() === "img";
  if (!isImage) {
    // Diagram SVGs carry an inline max-width that would stop the zoom.
    (media as SVGElement).style.maxWidth = "none";
  }
  return fillTabZoomStage(
    preview,
    stage,
    media,
    isImage ? undefined : () => inlineSvgNaturalSize(media as SVGElement),
  );
}
