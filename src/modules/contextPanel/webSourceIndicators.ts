import { createSourcePopover } from "./sourcePopover";
import type { WebSourceAnchor } from "../../webAccess/types";
import { normalizePublicWebUrl } from "../../webAccess/tavilyClient";
import { t } from "../../utils/i18n";
import { createWebFaviconImage, normalizeWebFaviconUrl } from "./webFavicon";
import { outsideSourceKey } from "./taskProgress/outside";
import {
  getSidePanelWebHost,
  wantsDefaultBrowser,
  type SidePanelSourceTarget,
} from "./webSourcesSidePanel";

/** The marker shows at most this many site icons; "+N" counts the rest. */
export const WEB_SOURCE_MARKER_MAX_ICONS = 3;

const ANCHOR_TOKEN_PREFIX = "LLMWEBSOURCEANCHOR";

export type WebSourcePopoverRow = {
  organization: string;
  title: string;
  url: string;
  faviconUrl?: string;
  /** "paper" for a scholarly paper; a web page has none. */
  kind?: "paper";
  sourceId?: string;
};

function anchorToken(index: number): string {
  return `${ANCHOR_TOKEN_PREFIX}${index}END`;
}

function preserveAnchorParagraphBoundary(markdownAfterAnchor: string): string {
  if (
    !markdownAfterAnchor.startsWith("\n") ||
    markdownAfterAnchor.startsWith("\n\n")
  ) {
    return markdownAfterAnchor;
  }
  const nextLine = markdownAfterAnchor.slice(1).split("\n", 1)[0] || "";
  if (!nextLine.trim() || /^\s*(?:[-+*]|\d{1,9}[.)])\s+/.test(nextLine)) {
    return markdownAfterAnchor;
  }
  return `\n${markdownAfterAnchor}`;
}

/** The fence still open at the end of the markdown, if any. */
function openCodeFence(markdown: string): string | null {
  let fence: { character: "`" | "~"; length: number } | null = null;
  for (const line of markdown.split("\n")) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (!fenceMatch) continue;
    const token = fenceMatch[1];
    const character = token[0] as "`" | "~";
    if (!fence) fence = { character, length: token.length };
    else if (fence.character === character && token.length >= fence.length) {
      fence = null;
    }
  }
  return fence ? fence.character.repeat(fence.length) : null;
}

/**
 * The end chip is a paragraph of its own after the answer, before any host
 * notes. A code fence the answer left open is closed for display first.
 */
function insertEndAnchorToken(
  markdown: string,
  offset: number,
  token: string,
): string {
  const before = markdown.slice(0, offset).trimEnd();
  const after = markdown.slice(offset).trimStart();
  const fence = openCodeFence(before);
  const closedBefore = fence ? `${before}\n${fence}` : before;
  return `${closedBefore ? `${closedBefore}\n\n` : ""}${token}${after ? `\n\n${after}` : ""}`;
}

// A token glued to a bare URL would become part of its link.
const BARE_URL_AT_END_PATTERN = /(?<!\]\()https?:\/\/[^\s<>]+$/;

export function injectWebSourceAnchorTokens(
  markdown: string,
  anchors: readonly WebSourceAnchor[],
): string {
  let result = markdown;
  const sorted = anchors
    .map((anchor, index) => ({
      anchor,
      index,
      // A trimmed stored text can be shorter than the end chip's offset; the
      // chip still belongs at the end.
      offset:
        anchor.placement === "end"
          ? Math.min(anchor.offset, markdown.length)
          : anchor.offset,
    }))
    .filter(
      ({ anchor, offset }) =>
        Number.isInteger(offset) &&
        offset >= 0 &&
        offset <= markdown.length &&
        anchor.sources.length > 0,
    )
    // Later offsets first; at one offset the end chip goes in first, so a
    // paragraph chip there stays on its paragraph.
    .sort(
      (left, right) =>
        right.offset - left.offset ||
        Number(right.anchor.placement === "end") -
          Number(left.anchor.placement === "end"),
    );
  for (const { anchor, index, offset } of sorted) {
    result =
      anchor.placement === "end"
        ? insertEndAnchorToken(result, offset, anchorToken(index))
        : `${result.slice(0, offset)}${
            BARE_URL_AT_END_PATTERN.test(result.slice(0, offset)) ? " " : ""
          }${anchorToken(index)}${preserveAnchorParagraphBoundary(
            result.slice(offset),
          )}`;
  }
  return result;
}

function isMacRuntime(): boolean {
  return Boolean(
    (globalThis as { Zotero?: { isMac?: boolean } }).Zotero?.isMac,
  );
}

function launchWebSource(url: string): void {
  const safeUrl = normalizePublicWebUrl(url);
  Zotero.launchURL(safeUrl);
}

export function normalizeWebSourcePopoverRows(
  anchor: WebSourceAnchor,
): WebSourcePopoverRow[] {
  return anchor.sources.flatMap((source) => {
    try {
      const hostname =
        typeof source.hostname === "string" ? source.hostname.trim() : "";
      const organization =
        typeof source.organization === "string" && source.organization.trim()
          ? source.organization.trim().slice(0, 160)
          : hostname.slice(0, 160);
      const title =
        typeof source.title === "string" && source.title.trim()
          ? source.title.trim().slice(0, 500)
          : hostname.slice(0, 500);
      if (!organization || !title) return [];
      const faviconUrl = normalizeWebFaviconUrl(source.faviconUrl);
      return [
        {
          organization,
          title,
          url: normalizePublicWebUrl(source.url),
          ...(faviconUrl ? { faviconUrl } : {}),
          ...(source.kind === "paper" ? { kind: "paper" as const } : {}),
          ...(source.sourceId ? { sourceId: source.sourceId } : {}),
        },
      ];
    } catch {
      return [];
    }
  });
}

/** A row's key in Task progress (`outsideSourceKey`). */
export function webSourceRowKey(
  row: Pick<WebSourcePopoverRow, "kind" | "sourceId" | "url">,
): string {
  return outsideSourceKey(row);
}

/**
 * The marker's face: the first sites' icons, overlapping, and "+N" for the
 * sites past WEB_SOURCE_MARKER_MAX_ICONS. A site without an icon (or whose
 * icon fails to load) shows the globe in its place; a paper, a page.
 */
export function buildWebSourceMarkerFace(
  doc: Document,
  sources: readonly Pick<WebSourcePopoverRow, "faviconUrl" | "kind">[],
): HTMLElement {
  const face = doc.createElement("span");
  face.className = "llm-web-source-marker";
  face.setAttribute("aria-hidden", "true");
  const stack = doc.createElement("span");
  stack.className = "llm-web-source-marker-icons";
  const shown = sources.slice(0, WEB_SOURCE_MARKER_MAX_ICONS);
  shown.forEach((source, index) => {
    const icon = doc.createElement("span");
    icon.className =
      source.kind === "paper"
        ? "llm-web-source-marker-icon llm-web-source-marker-icon-paper"
        : "llm-web-source-marker-icon";
    // The first site sits on top.
    icon.style.zIndex = String(shown.length - index);
    const favicon = createWebFaviconImage(
      doc,
      source.faviconUrl,
      "llm-web-source-marker-favicon",
    );
    if (favicon) {
      icon.classList.add("llm-web-source-marker-icon-has-favicon");
      favicon.addEventListener("error", () => {
        icon.classList.remove("llm-web-source-marker-icon-has-favicon");
      });
      icon.appendChild(favicon);
    }
    stack.appendChild(icon);
  });
  face.appendChild(stack);
  const more = sources.length - shown.length;
  if (more > 0) {
    const label = doc.createElement("span");
    label.className = "llm-web-source-more";
    label.textContent = `+${more}`;
    face.appendChild(label);
  }
  return face;
}

const STATE_WORDS = {
  read: "read",
  skimmed: "skimmed",
  found: "found",
} as const;

function buildSourceIndicator(
  doc: Document,
  anchor: WebSourceAnchor,
  runId: string | undefined,
  anchorIndex: number,
): HTMLElement | null {
  const sources = normalizeWebSourcePopoverRows(anchor);
  if (!sources.length) return null;
  const keys = sources.map(webSourceRowKey);
  const target = (only?: string): SidePanelSourceTarget => ({
    ...(runId ? { runId } : {}),
    keys: only ? [only] : keys,
  });

  const indicator = createSourcePopover(doc, {
    label: t("View sources"),
    icon: buildWebSourceMarkerFace(doc, sources),
    chipClassName: "llm-web-source-chip-sites",
    // In the standalone window a marker shows its sources in Task progress,
    // under its question, with their rows lit.
    onChipClick: () => {
      const host = getSidePanelWebHost(doc);
      if (!host) return false;
      host.showSources(target());
      return true;
    },
    populate: (popover, close) => {
      const host = getSidePanelWebHost(doc);
      sources.forEach((source, index) => {
        const key = keys[index];
        const row = doc.createElement("button");
        row.type = "button";
        row.className = "llm-web-source-row";
        row.title = host
          ? `${t("Show in Task progress")}: ${source.title}`
          : `${t("Open web source")}: ${source.title}`;

        const siteIcon = doc.createElement("span");
        siteIcon.className =
          source.kind === "paper"
            ? "llm-web-source-site-icon llm-web-source-site-icon-paper"
            : "llm-web-source-site-icon";
        siteIcon.setAttribute("aria-hidden", "true");
        const favicon = createWebFaviconImage(
          doc,
          source.faviconUrl,
          "llm-web-source-favicon",
        );
        if (favicon) {
          siteIcon.classList.add("llm-web-source-site-icon-has-favicon");
          favicon.addEventListener("error", () => {
            siteIcon.classList.remove("llm-web-source-site-icon-has-favicon");
          });
          siteIcon.appendChild(favicon);
        }

        const content = doc.createElement("span");
        content.className = "llm-web-source-content";

        const organization = doc.createElement("span");
        organization.className = "llm-web-source-organization";
        organization.textContent = source.organization;

        const title = doc.createElement("span");
        title.className = "llm-web-source-title";
        title.textContent = source.title;

        content.append(organization, title);
        row.append(siteIcon, content);
        const state = host?.sourceState?.(target(key));
        if (state) {
          const word = doc.createElement("span");
          word.className = "llm-web-source-state";
          word.textContent = t(STATE_WORDS[state]);
          row.appendChild(word);
        }
        row.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          // Task progress when the window has a side panel; ⌘-click on a web
          // page, and the Zotero sidebar, open the default browser.
          if (
            host &&
            !(source.kind !== "paper" && wantsDefaultBrowser(event))
          ) {
            host.showSources(target(key));
          } else {
            launchWebSource(source.url);
          }
          row.blur();
          close();
        });
        popover.appendChild(row);
      });
      if (host) {
        const hint = doc.createElement("span");
        hint.className = "llm-web-source-hint";
        hint.textContent = t(
          "Click: show in Task progress · {key}-click a web page: your browser",
        ).replace("{key}", isMacRuntime() ? "⌘" : "Ctrl");
        popover.appendChild(hint);
      }
    },
  });
  indicator.classList.add("llm-web-source-indicator-sites");
  indicator.dataset.sourceKeys = keys.join(" ");
  if (runId) indicator.dataset.runId = runId;
  // Task progress's "Show in answer" finds a quote's own marker by it.
  indicator.dataset.anchorIndex = String(anchorIndex);
  if (anchor.placement === "end") indicator.dataset.placement = "end";
  if (anchor.placement === "inline")
    indicator.classList.add("llm-web-source-indicator-inline");
  return indicator;
}

export function decorateWebSourceIndicators(
  root: HTMLElement,
  doc: Document,
  anchors: readonly WebSourceAnchor[],
  /** The answer's run: a marker shows its question in Task progress. */
  runId?: string,
): void {
  if (!anchors.length) return;
  const tokenPattern = new RegExp(`${ANCHOR_TOKEN_PREFIX}(\\d+)END`, "g");
  const walker = doc.createTreeWalker(root, 4);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const textNode of textNodes) {
    const text = textNode.nodeValue || "";
    tokenPattern.lastIndex = 0;
    if (!tokenPattern.test(text)) continue;
    tokenPattern.lastIndex = 0;
    const fragment = doc.createDocumentFragment();
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = tokenPattern.exec(text))) {
      if (match.index > cursor) {
        fragment.appendChild(
          doc.createTextNode(text.slice(cursor, match.index)),
        );
      }
      const anchor = anchors[Number(match[1])];
      const indicator = anchor
        ? buildSourceIndicator(doc, anchor, runId, Number(match[1]))
        : null;
      if (indicator) fragment.appendChild(indicator);
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) {
      fragment.appendChild(doc.createTextNode(text.slice(cursor)));
    }
    textNode.parentNode?.replaceChild(fragment, textNode);
  }
}
