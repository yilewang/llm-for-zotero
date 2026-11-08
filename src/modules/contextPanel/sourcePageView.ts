/**
 * A source's page inside the side panel's Task progress tab (standalone
 * window): a web page or a scholarly paper's page, as the live page or as
 * "What the agent read" (the text the agent got for it), chosen with two
 * flat tabs under the title row.
 *
 * ← at the start of the title row goes back: inside the page first (a link
 * the reader followed there), then to the page shown before, then to Task
 * progress.
 *
 * The page runs in a content <browser> as in Zotero's own web viewer, never
 * with the plugin's privileges. It is not sandboxed, as Zotero's viewer is
 * not: publishers' pages (Elsevier, PubMed) refuse to load in a sandboxed
 * view. A pop-up it opens goes where Zotero sends its viewer's pop-ups.
 */
import { appLogger } from "../../core/logging";
import { createElement } from "../../utils/domHelpers";
import { t } from "../../utils/i18n";
import type { TaskOutsideSource } from "./taskProgress/outside";
import {
  cleanSourceTitle,
  createTaskSourceIcon,
} from "./taskProgress/outsideView";
import { webSourceKey } from "./webSourcesData";
import {
  launchInDefaultBrowser,
  toPublicWebUrl,
  type WebSourceLink,
} from "./webSourcesSidePanel";

export type SourcePageMode = "page" | "text";

/** A page to show, with what the chat knows about it. */
export type SourcePageEntry = {
  link: WebSourceLink;
  /** The source as Task progress lists it, when a question found it. */
  source?: TaskOutsideSource;
  /** The question that found or cited it. */
  turn?: number;
  /**
   * The exact words the answer took from it; its own quotes' when not given.
   * "What the agent read" highlights each where it appears word for word.
   */
  phrases?: string[];
};

type PageState = SourcePageEntry & { mode: SourcePageMode };

export type SourcePageViewDeps = {
  doc: Document;
  win: Window;
  /** The panel's title row (same row as the main chat's title). */
  createTitleRow: (title: string) => {
    row: HTMLElement;
    text: HTMLElement;
    actions: HTMLElement;
  };
  createIconButton: (iconClass: string, label: string) => HTMLButtonElement;
  copyText: (text: string) => Promise<void>;
  /** Back from the first page: Task progress again. */
  onClose: () => void;
};

export type SourcePageView = {
  root: HTMLElement;
  /** Show a page; the same page again keeps its place. */
  show: (entry: SourcePageEntry) => void;
  /** Forget every page (Task progress shows again). */
  reset: () => void;
  isShowing: () => boolean;
  dispose: () => void;
};

type BrowserElement = HTMLElement & {
  browsingContext?: {
    currentWindowGlobal?: { documentURI?: { spec?: string } };
  };
  loadURI?: (uri: unknown, params: Record<string, unknown>) => void;
  canGoBack?: boolean;
  goBack?: () => void;
  stop?: () => void;
  currentURI?: { spec?: string };
  contentTitle?: string;
};

/**
 * The text as passages: the web service sends the parts of a page that match
 * the agent's question, joined with "[...]"; blank lines split them too.
 */
export function splitAgentTextPassages(text: string): string[] {
  return text
    .split(/\s*\[(?:\.\.\.|…)\]\s*|\n\s*\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** One character as compared: one space, plain quotes and dashes, lower case. */
function foldChar(char: string): string {
  if (/\s/.test(char)) return " ";
  if (/[“”„‟"]/.test(char)) return '"';
  if (/[‘’‚‛']/.test(char)) return "'";
  if (/[‐‑‒–—]/.test(char)) return "-";
  return char.toLowerCase();
}

/**
 * The parts of `text` that are one of `phrases` word for word (spacing,
 * letter case, quote marks and dashes aside), as [start, end) ranges in
 * order. A phrase that is not there is not guessed at.
 */
export function findExactPhrases(
  text: string,
  phrases: readonly string[],
): Array<[number, number]> {
  let folded = "";
  const at: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = foldChar(text[index]);
    if (char === " " && (folded === "" || folded.endsWith(" "))) continue;
    folded += char;
    at.push(index);
  }
  const ranges: Array<[number, number]> = [];
  for (const phrase of phrases) {
    let wanted = "";
    for (const char of phrase.trim()) {
      const next = foldChar(char);
      if (next === " " && (wanted === "" || wanted.endsWith(" "))) continue;
      wanted += next;
    }
    wanted = wanted.trimEnd();
    // Too short to stand for what the answer took.
    if (wanted.length < 8) continue;
    let from = folded.indexOf(wanted);
    while (from >= 0) {
      ranges.push([at[from], at[from + wanted.length - 1] + 1]);
      from = folded.indexOf(wanted, from + wanted.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/** What the agent got of a source, as the note over its text says it. */
export function describeAgentCoverage(source: TaskOutsideSource): string {
  switch (source.coverage) {
    case "whole":
      return t("The agent read this whole page.");
    case "parts":
      return source.kind === "paper"
        ? t("The parts of this paper the agent read.")
        : t(
            "The parts of this page the agent read. It did not read the whole page.",
          );
    case "outline":
      return t("The agent only looked at this page's outline (its headings).");
    case "abstract":
      return t("The agent read this paper's abstract.");
    case "snippet":
      return source.kind === "paper"
        ? t(
            "The agent only saw this paper in search results. It did not open it.",
          )
        : t(
            "The agent only saw this short search result. It did not open the page.",
          );
    case "passages":
      return source.kind === "paper"
        ? t("The passages of this paper the agent read.")
        : t(
            "The parts of this page the agent got: the passages that matched its question, not the whole page.",
          );
    default:
      return t(
        "The agent did not read this page. It only appears as a link in the answer.",
      );
  }
}

export function mountSourcePageView(deps: SourcePageViewDeps): SourcePageView {
  const { doc, win } = deps;
  const root = createElement(
    doc,
    "div",
    "llm-standalone-side-panel-web llm-source-page",
  );
  root.hidden = true;

  const { row, text, actions } = deps.createTitleRow("");
  const back = deps.createIconButton(
    "llm-standalone-side-panel-item-action llm-standalone-side-panel-icon-back",
    t("Back to Task progress"),
  );
  back.dataset.webAction = "back";
  row.prepend(back);
  const titleIcon = createElement(doc, "span", "llm-web-sources-title-icon");
  const name = createElement(doc, "span", "llm-source-page-name");
  const sub = createElement(doc, "span", "llm-source-page-sub");
  text.replaceWith(name);
  name.append(text, sub);
  name.before(titleIcon);
  const copyButton = deps.createIconButton(
    "llm-standalone-side-panel-item-action llm-standalone-side-panel-icon-copy",
    t("Copy link"),
  );
  copyButton.dataset.webAction = "copy";
  const browserButton = deps.createIconButton(
    "llm-standalone-side-panel-item-action llm-standalone-side-panel-icon-web-browser",
    t("Open in default browser"),
  );
  browserButton.dataset.webAction = "browser";
  actions.append(copyButton, browserButton);

  const status = createElement(
    doc,
    "div",
    "llm-standalone-side-panel-item-status",
  );
  status.setAttribute("role", "status");
  status.hidden = true;

  // "Page | What the agent read": flat text tabs, underline on the chosen one.
  const modes = createElement(doc, "div", "llm-web-sources-modes");
  modes.setAttribute("role", "tablist");
  const makeMode = (mode: SourcePageMode, label: string) => {
    const button = createElement(doc, "button", "llm-web-sources-mode", {
      type: "button",
      textContent: label,
    });
    button.setAttribute("role", "tab");
    button.dataset.webMode = mode;
    button.addEventListener("click", () => setMode(mode));
    modes.appendChild(button);
    return button;
  };
  const pageModeButton = makeMode("page", t("Page"));
  const textModeButton = makeMode("text", t("What the agent read"));

  const pageHost = createElement(doc, "div", "llm-web-sources-page");
  const textHost = createElement(doc, "div", "llm-web-sources-text");
  root.append(row, status, modes, pageHost, textHost);

  let stack: PageState[] = [];
  let disposed = false;
  let browser: BrowserElement | null = null;
  let loadedUrl = "";
  /** A page the site refused to show here: its note shows instead. */
  let refusedUrl = "";
  let feedbackTimer: number | null = null;

  const current = () => stack[stack.length - 1] || null;

  const showFeedback = (message: string) => {
    status.textContent = message;
    status.hidden = false;
    if (feedbackTimer !== null) win.clearTimeout(feedbackTimer);
    feedbackTimer = win.setTimeout(() => {
      feedbackTimer = null;
      status.hidden = true;
    }, 2000);
  };

  /** The page the view shows now: where the reader is in the page. */
  const currentPageUrl = (): string => {
    const state = current();
    if (!state) return "";
    const spec = browser && !browser.hidden ? browser.currentURI?.spec : "";
    return toPublicWebUrl(spec) || state.link.url;
  };

  // -- The page ---------------------------------------------------------------
  const ensureBrowser = (): BrowserElement | null => {
    if (browser) return browser;
    const create = (
      doc as Document & { createXULElement?: (tag: string) => Element }
    ).createXULElement;
    if (typeof create !== "function") return null;
    try {
      const element = create.call(doc, "browser") as BrowserElement;
      // As Zotero's own web viewer: a content browser that moves to a web
      // content process when it loads a page, without global history.
      element.setAttribute("type", "content");
      element.setAttribute("remote", "false");
      element.setAttribute("maychangeremoteness", "true");
      element.setAttribute("disableglobalhistory", "true");
      element.setAttribute("messagemanagergroup", "llmWebSources");
      element.setAttribute("class", "llm-web-sources-browser");
      element.addEventListener("pagetitlechanged", () => {
        if (!noteRefusedPage()) render();
      });
      pageHost.appendChild(element);
      browser = element;
      return element;
    } catch (err) {
      appLogger.warn("LLM: web page view could not be created", err);
      return null;
    }
  };

  const dropBrowser = () => {
    if (!browser) return;
    try {
      browser.stop?.();
    } catch {
      /* ignore */
    }
    browser.remove();
    browser = null;
  };

  const showPageFallback = (url: string) => {
    pageHost.replaceChildren();
    browser = null;
    loadedUrl = "";
    const note = createElement(doc, "div", "llm-web-sources-page-note");
    note.append(
      createElement(doc, "div", "", {
        textContent: t("This page cannot be shown here."),
      }),
    );
    const open = createElement(doc, "button", "llm-web-sources-page-open", {
      type: "button",
      textContent: t("Open in default browser"),
    });
    open.addEventListener("click", () => launchInDefaultBrowser(url));
    note.append(open);
    pageHost.appendChild(note);
  };

  /**
   * A site that refuses to be shown here gets the browser's error page
   * ("Be careful. Something doesn't look right."): show the note with Open in
   * default browser instead.
   */
  const noteRefusedPage = (): boolean => {
    const view = browser;
    if (!view || disposed) return false;
    let documentUrl = "";
    try {
      documentUrl =
        view.browsingContext?.currentWindowGlobal?.documentURI?.spec || "";
    } catch {
      return false;
    }
    if (!/^about:(?:neterror|certerror)/i.test(documentUrl)) return false;
    const url = loadedUrl;
    const failed = toPublicWebUrl(view.currentURI?.spec) || url;
    dropBrowser();
    showPageFallback(failed);
    refusedUrl = url;
    return true;
  };

  const loadPage = (url: string) => {
    if (refusedUrl === url && !browser) {
      showPageFallback(url);
      refusedUrl = url;
      return;
    }
    if (loadedUrl === url && browser) return;
    // Each page gets a fresh view, so its Back history starts at that page:
    // Back never lands on the page shown before it.
    dropBrowser();
    const element = ensureBrowser();
    const services = (globalThis as { Services?: any }).Services;
    if (!element || !services?.io || typeof element.loadURI !== "function") {
      showPageFallback(url);
      return;
    }
    try {
      const uri = services.io.newURI(url);
      element.loadURI(uri, {
        triggeringPrincipal:
          services.scriptSecurityManager.createContentPrincipal(uri, {}),
      });
      loadedUrl = url;
      refusedUrl = "";
      // The error page may come without a new title: look again shortly.
      for (const delay of [1500, 5000]) {
        win.setTimeout(() => {
          if (browser === element) noteRefusedPage();
        }, delay);
      }
    } catch (err) {
      appLogger.warn("LLM: web page could not be loaded", err);
      showPageFallback(url);
    }
  };

  /** A paragraph, its exact phrases highlighted. */
  const paragraph = (text: string, phrases: readonly string[]) => {
    const node = createElement(doc, "p", "");
    let cursor = 0;
    for (const [start, end] of findExactPhrases(text, phrases)) {
      if (start > cursor)
        node.append(doc.createTextNode(text.slice(cursor, start)));
      node.append(
        createElement(doc, "mark", "llm-source-page-used", {
          textContent: text.slice(start, end),
        }),
      );
      cursor = end;
    }
    if (cursor < text.length)
      node.append(doc.createTextNode(text.slice(cursor)));
    return node;
  };

  const renderAgentText = (state: PageState) => {
    textHost.replaceChildren();
    const source = state.source;
    const phrases =
      state.phrases ||
      (source?.quotes || []).flatMap((quote) =>
        quote.phrase ? [quote.phrase] : [],
      );
    const note = createElement(doc, "div", "llm-web-sources-text-note");
    const body = createElement(doc, "div", "llm-web-sources-text-body");
    if (!source) {
      note.textContent = t(
        "The agent did not read this page. It only appears as a link in the answer.",
      );
    } else {
      if (source.reads.length && source.kind === "paper") {
        for (const read of source.reads) {
          body.append(
            createElement(doc, "h4", "llm-source-page-read-label", {
              textContent: t(read.label),
            }),
          );
          for (const text of splitAgentTextPassages(read.text)) {
            body.append(paragraph(text, phrases));
          }
        }
      } else {
        for (const text of splitAgentTextPassages(source.agentText)) {
          body.append(paragraph(text, phrases));
        }
      }
      const marked = body.querySelector(".llm-source-page-used");
      note.textContent = marked
        ? `${describeAgentCoverage(source)} ${t("Highlighted parts were used in the answer.")}`
        : describeAgentCoverage(source);
    }
    textHost.append(note, body);
  };

  const renderTitle = (state: PageState) => {
    const url = currentPageUrl();
    const onOriginal = webSourceKey(url) === webSourceKey(state.link.url);
    const liveTitle =
      state.mode === "page" && browser
        ? String(browser.contentTitle || "")
        : "";
    // The title as the agent found it, else the link's words, else the live
    // page's own title.
    const title =
      cleanSourceTitle(
        (onOriginal ? state.source?.title || state.link.title : "") ||
          liveTitle,
      ) || url;
    let hostname = "";
    try {
      hostname = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      hostname = state.link.hostname || "";
    }
    text.textContent = title;
    text.title = title;
    row.title = url;
    sub.textContent = hostname;
  };

  // -- Rendering ----------------------------------------------------------------
  const render = () => {
    if (disposed) return;
    const state = current();
    root.hidden = !state;
    if (!state) return;
    const canGoBackInPage =
      state.mode === "page" && Boolean(browser?.canGoBack) && loadedUrl !== "";
    const previous = stack[stack.length - 2];
    back.title =
      canGoBackInPage || previous
        ? t("Back to the previous page")
        : t("Back to Task progress");
    back.setAttribute("aria-label", back.title);
    titleIcon.replaceChildren(
      createTaskSourceIcon(
        doc,
        (state.source?.kind || state.link.kind) === "paper" ? "paper" : "web",
        state.source?.faviconUrl || state.link.faviconUrl,
      ),
    );
    pageModeButton.classList.toggle("active", state.mode === "page");
    pageModeButton.setAttribute("aria-selected", String(state.mode === "page"));
    textModeButton.classList.toggle("active", state.mode === "text");
    textModeButton.setAttribute("aria-selected", String(state.mode === "text"));
    pageHost.hidden = state.mode !== "page";
    textHost.hidden = state.mode !== "text";
    if (state.mode === "page") loadPage(state.link.url);
    else renderAgentText(state);
    renderTitle(state);
    alignModesWithTitle();
  };

  /** The flat tabs start where the title text starts. */
  const alignModesWithTitle = () => {
    const run = () => {
      const offset =
        name.getBoundingClientRect?.().left -
        root.getBoundingClientRect?.().left;
      if (Number.isFinite(offset) && offset > 0) {
        modes.style.paddingInlineStart = `${Math.round(offset)}px`;
      }
    };
    if (typeof win.requestAnimationFrame === "function") {
      win.requestAnimationFrame(run);
    } else {
      run();
    }
  };

  const show = (entry: SourcePageEntry) => {
    const url = toPublicWebUrl(entry.link.url);
    if (!url) return;
    const state = current();
    if (state && webSourceKey(state.link.url) === webSourceKey(url)) {
      state.source = entry.source || state.source;
      state.turn = entry.turn || state.turn;
      state.phrases = entry.phrases || state.phrases;
      state.mode = "page";
      render();
      return;
    }
    loadedUrl = "";
    stack.push({ ...entry, link: { ...entry.link, url }, mode: "page" });
    // Keep the trail short; the oldest steps drop off.
    if (stack.length > 30) stack = stack.slice(-30);
    render();
  };

  const setMode = (mode: SourcePageMode) => {
    const state = current();
    if (!state || state.mode === mode) return;
    state.mode = mode;
    render();
  };

  const reset = () => {
    stack = [];
    loadedUrl = "";
    dropBrowser();
    pageHost.replaceChildren();
    render();
  };

  /** Back in the view's own trail: the page before, else Task progress. */
  const goBackInView = () => {
    if (stack.length < 2) {
      reset();
      deps.onClose();
      return;
    }
    stack.pop();
    loadedUrl = "";
    render();
  };

  const goBack = () => {
    const state = current();
    const view = browser;
    if (
      state?.mode === "page" &&
      view?.canGoBack &&
      typeof view.goBack === "function"
    ) {
      const before = webSourceKey(view.currentURI?.spec || "");
      view.goBack();
      win.setTimeout(() => {
        if (disposed || current() !== state || browser !== view) return;
        // A page that sends Back straight forward again (a redirect) would
        // trap Back: leave it for the view's previous step instead.
        if (webSourceKey(view.currentURI?.spec || "") === before) {
          goBackInView();
        } else {
          render();
        }
      }, 700);
      return;
    }
    goBackInView();
  };

  back.addEventListener("click", goBack);
  copyButton.addEventListener("click", () => {
    const url = currentPageUrl();
    if (!url) return;
    void deps
      .copyText(url)
      .then(() => showFeedback(t("Link copied")))
      .catch((err) => appLogger.warn("LLM: copy web link failed", err));
  });
  browserButton.addEventListener("click", () => {
    const url = currentPageUrl();
    if (url) launchInDefaultBrowser(url);
  });

  return {
    root,
    show,
    reset,
    isShowing: () => Boolean(current()),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (feedbackTimer !== null) win.clearTimeout(feedbackTimer);
      dropBrowser();
      root.remove();
    },
  };
}
