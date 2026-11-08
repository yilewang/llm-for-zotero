/**
 * Web pages in the standalone window's side panel.
 *
 * A source the agent used (a marker, a marker's row, or a link in an answer)
 * shows in the side panel's Task progress tab: a marker lights its rows under
 * its question, a link opens its page there. The window registers a host for
 * its document; with no host (the Zotero item-pane sidebar) a page opens in
 * the default browser, as before. ⌘-click (Ctrl-click off macOS) on a web
 * page always opens the default browser.
 */
import { normalizePublicWebUrl } from "../../webAccess/tavilyClient";

/** One web page to show, with what the chat knows about it. */
export type WebSourceLink = {
  url: string;
  title?: string;
  organization?: string;
  hostname?: string;
  faviconUrl?: string;
  /** "paper" for a scholarly paper. */
  kind?: "paper";
  /** The answer's run that cites it, when known. */
  runId?: string;
};

/** The sources a marker (or one of its rows) names, in its answer's run. */
export type SidePanelSourceTarget = {
  /** The answer's run; its question is the one shown. */
  runId?: string;
  /** Row keys (`outsideSourceKey`). */
  keys: string[];
};

export type SidePanelWebHost = {
  /** Shows the sources in Task progress: their question open, rows lit. */
  showSources: (target: SidePanelSourceTarget) => void;
  /** Opens one page in the Task progress tab. */
  openPage: (link: WebSourceLink) => void;
  /** How far the agent got with a source, for a marker's card. */
  sourceState?: (
    target: SidePanelSourceTarget,
  ) => "read" | "skimmed" | "found" | null;
};

const hosts = new WeakMap<Document, SidePanelWebHost>();

export function registerSidePanelWebHost(
  doc: Document,
  host: SidePanelWebHost,
): void {
  hosts.set(doc, host);
}

export function unregisterSidePanelWebHost(
  doc: Document,
  host: SidePanelWebHost,
): void {
  if (hosts.get(doc) === host) hosts.delete(doc);
}

/** The document's host; null in the Zotero item-pane sidebar. */
export function getSidePanelWebHost(
  doc: Document | null | undefined,
): SidePanelWebHost | null {
  return (doc && hosts.get(doc)) || null;
}

function isMacRuntime(): boolean {
  return Boolean(
    (globalThis as { Zotero?: { isMac?: boolean } }).Zotero?.isMac,
  );
}

/** ⌘-click on macOS, Ctrl-click elsewhere: open in the default browser. */
export function wantsDefaultBrowser(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey"> | null | undefined,
): boolean {
  if (!event) return false;
  return isMacRuntime() ? Boolean(event.metaKey) : Boolean(event.ctrlKey);
}

/** A public http(s) URL, or null (local, private, or not a web address). */
export function toPublicWebUrl(value: unknown): string | null {
  try {
    return normalizePublicWebUrl(value);
  } catch {
    return null;
  }
}

export function launchInDefaultBrowser(url: string): boolean {
  try {
    const launch = (
      globalThis as { Zotero?: { launchURL?: (url: string) => void } }
    ).Zotero?.launchURL;
    if (typeof launch === "function") {
      launch(url);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Opens a web page where the click asks: the side panel when the window has
 * one, otherwise (or on ⌘-click) the default browser. Returns false when the
 * URL is not a public web page, so the caller can handle it its own way.
 */
export function openWebSourceLink(
  doc: Document | null | undefined,
  link: WebSourceLink,
  event?: Pick<MouseEvent, "metaKey" | "ctrlKey"> | null,
): boolean {
  const url = toPublicWebUrl(link.url);
  if (!url) return false;
  const host = getSidePanelWebHost(doc);
  if (host && !wantsDefaultBrowser(event)) {
    host.openPage({ ...link, url });
    return true;
  }
  return launchInDefaultBrowser(url);
}
