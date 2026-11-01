/**
 * The one place that builds a frame for model-written HTML.
 *
 * Model output is untrusted. The frame runs it with scripts but without a
 * same-origin principal, so it cannot reach the chrome document, Zotero, the
 * network, or open windows. Keep every HTML-preview frame on this helper so
 * the sandbox and the content security policy cannot drift between callers.
 */

import { t } from "../../utils/i18n";
import {
  PREVIEW_SURFACE_ATTRIBUTE,
  PREVIEW_THEME_ATTRIBUTE,
  buildHtmlPreviewThemeSheet,
  needsPreviewThemeSheet,
  previewSurfaceFor,
  previewThemeFor,
  type PreviewThemeKey,
} from "../../utils/previewTheme";

const XHTML_NS = "http://www.w3.org/1999/xhtml";

/** The only sandbox token the preview frame gets. */
export const HTML_PREVIEW_SANDBOX = "allow-scripts";

/** No network; inline script and style plus data/blob media only. */
export const HTML_PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

export const HTML_PREVIEW_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`;

/**
 * Leading tags that may stay ahead of the CSP meta: a doctype (so the page
 * keeps standards mode), then an opening <html> and <head>. None of them can
 * run script, so the meta is still parsed before any of the model's content.
 */
const SRCDOC_PREAMBLE_PATTERN =
  /^(\s*<!doctype[^>]*>)?(\s*<html(?:\s[^>]*)?>)?(\s*<head(?:\s[^>]*)?>)?/i;

/**
 * The frame document: the CSP meta first, so it is parsed before the markup.
 * With an app theme, the theme sheet (previewTheme.ts) follows the meta, still
 * ahead of the model's own markup.
 */
export function buildHtmlPreviewSrcdoc(
  source: string,
  appTheme?: PreviewThemeKey,
  fit?: HtmlPreviewFit,
): string {
  const preamble = source.match(SRCDOC_PREAMBLE_PATTERN)?.[0] ?? "";
  const sheet = appTheme
    ? buildHtmlPreviewThemeSheet(
        previewThemeFor(source, appTheme),
        previewSurfaceFor(source),
        needsPreviewThemeSheet(source),
      )
    : "";
  const fitSheet = fit
    ? buildHtmlPreviewFitSheet(previewSurfaceFor(source))
    : "";
  return `${preamble}${HTML_PREVIEW_CSP_META}${sheet}${fitSheet}${source.slice(preamble.length)}`;
}

/** A chat preview that takes its page's height and the chat's font. */
export type HtmlPreviewFit = {
  /** The chat's font as a CSS `font` value, read when the page loads. */
  readFont?: () => string | undefined;
  /**
   * The chat's background color, read when the page loads. A themed page
   * that paints `var(--llm-bg)` then paints the chat's own color, not a box.
   */
  readBackground?: () => string | undefined;
  /** Called with the page's height each time it changes. */
  onHeight?: (height: number) => void;
};

/** A page taller than this is cut there. */
export const HTML_PREVIEW_MAX_FIT_HEIGHT = 4000;

/** Late layout (fonts, images, the page's own scripts) is measured again. */
const FIT_RECHECK_DELAYS_MS = [100, 400, 1200, 3000];

/**
 * The page sits right on the chat: no outer margin on a themed page (its text
 * lines up with the answer), a little room on a white card.
 */
function buildHtmlPreviewFitSheet(
  surface: ReturnType<typeof previewSurfaceFor>,
): string {
  const margin = surface === "themed" ? "0" : "12px 14px";
  return `<style>body{margin:${margin}}</style>`;
}

/** The page's height as laid out, including the body's bottom margin. */
function measurePageHeight(page: Document): number {
  const root = page.documentElement;
  if (!root) return 0;
  let height = root.getBoundingClientRect().height;
  const body = page.body;
  if (body) {
    const style = page.defaultView?.getComputedStyle(body);
    const margin = parseFloat(style?.marginBottom || "") || 0;
    height = Math.max(height, body.getBoundingClientRect().bottom + margin);
  }
  return height;
}

/** Keeps a value read from the chat from adding rules of its own. */
function cssValue(value: string | undefined): string {
  return (value || "").replace(/[<>{};]/g, "").trim();
}

/**
 * The chat's font, under the page's own rules, and the chat's background as
 * `--llm-bg`. `html:root` outranks the theme sheet's `:root`; a themed page
 * declares no `--llm-` colors of its own (previewTheme.ts).
 */
function buildChatMatchRules(fit: HtmlPreviewFit): string {
  const font = cssValue(fit.readFont?.());
  const background = cssValue(fit.readBackground?.());
  return `${font ? `html{font:${font}}` : ""}${background ? `html:root{--llm-bg:${background}}` : ""}`;
}

/**
 * In Zotero's chrome windows a frame's load event reaches only capture
 * listeners on the frame, so every load listener here uses capture.
 */
const FRAME_LOAD_OPTIONS = { capture: true } as const;

/** The frame shows its own srcdoc (a first load, or a reload after a move). */
function showsOwnSrcdoc(frame: HTMLIFrameElement): boolean {
  return frame.contentDocument?.URL === "about:srcdoc";
}

/**
 * The plugin runs with chrome rights, so it can read the page's layout
 * itself: the page sends nothing and has no channel into the plugin. Each
 * time the page loads (moving a frame reloads it), the chat's font goes in
 * ahead of the page's own styles (the page's rules still win), then the frame
 * takes the page's height and follows it as the page's layout changes.
 */
function fitFrameToPage(
  doc: Document,
  frame: HTMLIFrameElement,
  fit: HtmlPreviewFit,
): void {
  let last = -1;
  const measure = () => {
    const page = frame.contentDocument;
    if (!page || !showsOwnSrcdoc(frame)) return;
    const height = Math.max(
      1,
      Math.min(HTML_PREVIEW_MAX_FIT_HEIGHT, Math.ceil(measurePageHeight(page))),
    );
    if (height === last) return;
    last = height;
    frame.style.height = `${height}px`;
    fit.onHeight?.(height);
  };
  const onLoad = () => {
    const page = frame.contentDocument;
    const pageWindow = frame.contentWindow;
    if (!page || !pageWindow || !showsOwnSrcdoc(frame)) return;
    const rules = buildChatMatchRules(fit);
    if (rules) {
      const style = page.createElement("style");
      style.textContent = rules;
      const head = page.head || page.documentElement;
      head?.insertBefore(style, head.firstChild);
    }
    last = -1;
    measure();
    try {
      const PageResizeObserver = (
        pageWindow as unknown as { ResizeObserver: typeof ResizeObserver }
      ).ResizeObserver;
      const observer = new PageResizeObserver(() => measure());
      if (page.documentElement) observer.observe(page.documentElement);
      if (page.body) observer.observe(page.body);
    } catch (_error) {
      // The timed checks below still fit the page.
    }
    for (const delay of FIT_RECHECK_DELAYS_MS) {
      doc.defaultView?.setTimeout(measure, delay);
    }
  };
  frame.addEventListener("load", onLoad, FRAME_LOAD_OPTIONS);
}

export const HTML_PREVIEW_STOPPED_TEXT =
  "Preview stopped: the page tried to leave.";

/**
 * The CSP does not stop the page from navigating its own frame (for example
 * `location = "https://..."`). A load that shows anything but the frame's own
 * srcdoc means the frame left it, so the frame is removed and replaced by a
 * note. A move in the chat reloads the srcdoc, which is fine.
 * Returns the load handler so tests can drive it.
 */
export function guardHtmlPreviewNavigation(
  doc: Document,
  frame: HTMLIFrameElement,
): () => void {
  const onLoad = () => {
    if (showsOwnSrcdoc(frame)) return;
    frame.removeEventListener("load", onLoad, FRAME_LOAD_OPTIONS);
    frame.removeAttribute("srcdoc");
    const note = doc.createElementNS(XHTML_NS, "div") as HTMLElement;
    note.setAttribute("class", "llm-html-preview-stopped");
    note.textContent = t(HTML_PREVIEW_STOPPED_TEXT);
    const parent = frame.parentNode;
    if (parent) {
      parent.replaceChild(note, frame);
    }
  };
  frame.addEventListener("load", onLoad, FRAME_LOAD_OPTIONS);
  return onLoad;
}

/**
 * Never add a message listener for the frame's postMessage: the page is
 * untrusted and must have no channel back into the plugin.
 */
export function createSandboxedHtmlFrame(
  doc: Document,
  source: string,
  className = "llm-html-preview-frame",
  appTheme?: PreviewThemeKey,
  fit?: HtmlPreviewFit,
): HTMLIFrameElement {
  const frame = doc.createElementNS(XHTML_NS, "iframe") as HTMLIFrameElement;
  // The sandbox must be in place before srcdoc is set and before the frame
  // is inserted, so the document never loads without it.
  frame.setAttribute("sandbox", HTML_PREVIEW_SANDBOX);
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("title", t("HTML preview"));
  frame.setAttribute("class", className);
  if (appTheme) {
    // A page's colors are fixed when its frame is built: a theme change
    // builds a new frame (srcdoc is never set twice, see the guard below).
    frame.setAttribute(PREVIEW_SURFACE_ATTRIBUTE, previewSurfaceFor(source));
    frame.setAttribute(
      PREVIEW_THEME_ATTRIBUTE,
      previewThemeFor(source, appTheme),
    );
  }
  if (fit) fitFrameToPage(doc, frame, fit);
  guardHtmlPreviewNavigation(doc, frame);
  frame.setAttribute("srcdoc", buildHtmlPreviewSrcdoc(source, appTheme, fit));
  return frame;
}
