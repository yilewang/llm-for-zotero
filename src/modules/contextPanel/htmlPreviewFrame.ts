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
  const fitPart = fit
    ? `${buildHtmlPreviewFitSheet(previewSurfaceFor(source), fit.font)}${HTML_PREVIEW_HEIGHT_SCRIPT}`
    : "";
  return `${preamble}${HTML_PREVIEW_CSP_META}${sheet}${fitPart}${source.slice(preamble.length)}`;
}

/** A chat preview that takes its page's height and the chat's font. */
export type HtmlPreviewFit = {
  /** The chat's font as a CSS `font` value, for a page that sets none. */
  font?: string;
  /** Called with the page's height each time it changes. */
  onHeight?: (height: number) => void;
};

/** The one key the page may send: its own height in pixels. */
export const HTML_PREVIEW_HEIGHT_KEY = "llmHtmlPreviewHeight";

/** A page taller than this is cut there, whatever it reports. */
export const HTML_PREVIEW_MAX_FIT_HEIGHT = 4000;

/**
 * Runs inside the page, ahead of the model's markup: it reports the page's
 * height to the chat whenever the layout changes. It sends a number and
 * nothing else; the chat reads only that number (fitFrameToPage).
 */
export const HTML_PREVIEW_HEIGHT_SCRIPT = `<script>(()=>{let last=-1;const send=()=>{const d=document.documentElement,b=document.body;let h=d.getBoundingClientRect().height;if(b){const m=parseFloat(getComputedStyle(b).marginBottom)||0;h=Math.max(h,b.getBoundingClientRect().bottom+m);}h=Math.ceil(h);if(h===last)return;last=h;parent.postMessage({${HTML_PREVIEW_HEIGHT_KEY}:h},"*");};const ro=new ResizeObserver(send);ro.observe(document.documentElement);document.addEventListener("DOMContentLoaded",()=>{if(document.body)ro.observe(document.body);send();});addEventListener("load",send);})();</script>`;

/**
 * The page sits right on the chat: no outer margin on a themed page (its text
 * lines up with the answer), a little room on a white card, and the chat's
 * font until the page picks its own.
 */
function buildHtmlPreviewFitSheet(
  surface: ReturnType<typeof previewSurfaceFor>,
  font?: string,
): string {
  const safeFont = (font || "").replace(/[<>{};]/g, "").trim();
  const fontRule = safeFont ? `html{font:${safeFont}}` : "";
  const margin = surface === "themed" ? "0" : "12px 14px";
  return `<style>${fontRule}body{margin:${margin}}</style>`;
}

/**
 * The page reports its height (HTML_PREVIEW_HEIGHT_SCRIPT). Only a finite
 * number from this frame's own window is read; it sets the frame's height and
 * nothing else, so the page still has no way into the plugin.
 */
function fitFrameToPage(
  doc: Document,
  frame: HTMLIFrameElement,
  fit: HtmlPreviewFit,
): void {
  const win = doc.defaultView;
  if (!win) return;
  let seen = false;
  const onMessage = (event: MessageEvent) => {
    if (seen && !frame.isConnected) {
      win.removeEventListener("message", onMessage);
      return;
    }
    if (!frame.contentWindow || event.source !== frame.contentWindow) return;
    const data = event.data as Record<string, unknown> | null;
    const reported =
      data && typeof data === "object" ? data[HTML_PREVIEW_HEIGHT_KEY] : null;
    if (typeof reported !== "number" || !Number.isFinite(reported)) return;
    seen = true;
    const height = Math.max(
      1,
      Math.min(HTML_PREVIEW_MAX_FIT_HEIGHT, Math.ceil(reported)),
    );
    frame.style.height = `${height}px`;
    fit.onHeight?.(height);
  };
  win.addEventListener("message", onMessage);
}

export const HTML_PREVIEW_STOPPED_TEXT =
  "Preview stopped: the page tried to leave.";

/**
 * The CSP does not stop the page from navigating its own frame (for example
 * `location = "https://..."`). The first load is the srcdoc; any later load
 * means the frame left it, so the frame is removed and replaced by a note.
 * Returns the load handler so tests can drive it.
 */
export function guardHtmlPreviewNavigation(
  doc: Document,
  frame: HTMLIFrameElement,
): () => void {
  let loads = 0;
  const onLoad = () => {
    loads += 1;
    if (loads === 1) return;
    frame.removeEventListener("load", onLoad);
    frame.removeAttribute("srcdoc");
    const note = doc.createElementNS(XHTML_NS, "div") as HTMLElement;
    note.setAttribute("class", "llm-html-preview-stopped");
    note.textContent = t(HTML_PREVIEW_STOPPED_TEXT);
    const parent = frame.parentNode;
    if (parent) {
      parent.replaceChild(note, frame);
    }
  };
  frame.addEventListener("load", onLoad);
  return onLoad;
}

/**
 * The page is untrusted and must have no channel back into the plugin. The
 * one exception is its height (fitFrameToPage): a number, read only from this
 * frame, used only to size the frame. Never read anything else it sends.
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
  guardHtmlPreviewNavigation(doc, frame);
  if (fit) fitFrameToPage(doc, frame, fit);
  frame.setAttribute("srcdoc", buildHtmlPreviewSrcdoc(source, appTheme, fit));
  return frame;
}
