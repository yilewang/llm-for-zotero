import type { WebSourceAnchor } from "../../webAccess/types";
import { normalizePublicWebUrl } from "../../webAccess/tavilyClient";
import { t } from "../../utils/i18n";
import { createWebFaviconImage, normalizeWebFaviconUrl } from "./webFavicon";

const ANCHOR_TOKEN_PREFIX = "LLMWEBSOURCEANCHOR";

export type WebSourcePopoverRow = {
  organization: string;
  title: string;
  url: string;
  faviconUrl?: string;
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

export function injectWebSourceAnchorTokens(
  markdown: string,
  anchors: readonly WebSourceAnchor[],
): string {
  let result = markdown;
  const sorted = anchors
    .map((anchor, index) => ({ anchor, index }))
    .filter(
      ({ anchor }) =>
        Number.isInteger(anchor.offset) &&
        anchor.offset >= 0 &&
        anchor.offset <= markdown.length &&
        anchor.sources.length > 0,
    )
    .sort((left, right) => right.anchor.offset - left.anchor.offset);
  for (const { anchor, index } of sorted) {
    result = `${result.slice(0, anchor.offset)}${anchorToken(index)}${preserveAnchorParagraphBoundary(
      result.slice(anchor.offset),
    )}`;
  }
  return result;
}

function positionSourceCard(wrapper: HTMLElement, popover: HTMLElement): void {
  const doc = wrapper.ownerDocument;
  const win = doc.defaultView;
  if (!win) return;
  popover.classList.remove("llm-web-source-popover-below");
  popover.style.top = "0px";
  popover.style.left = "0px";
  popover.style.width = "";
  popover.style.maxHeight = "";
  const anchorRect = wrapper.getBoundingClientRect();
  const messageViewport = wrapper.closest(
    ".llm-messages",
  ) as HTMLElement | null;
  const viewportRect = messageViewport?.getBoundingClientRect();
  const viewportPadding = 12;
  const viewportLeft = Math.max(0, viewportRect?.left ?? 0);
  const viewportTop = Math.max(0, viewportRect?.top ?? 0);
  const viewportRight =
    viewportRect?.right || doc.documentElement.clientWidth || win.innerWidth;
  const viewportBottom =
    viewportRect?.bottom || doc.documentElement.clientHeight || win.innerHeight;
  const availableWidth = Math.max(
    0,
    viewportRight - viewportLeft - viewportPadding * 2,
  );
  const cardWidth = Math.min(360, availableWidth);
  popover.style.width = `${Math.floor(cardWidth)}px`;
  const cardRect = popover.getBoundingClientRect();
  const desiredLeft = anchorRect.right - cardWidth;
  const clampedLeft = Math.min(
    Math.max(viewportLeft + viewportPadding, desiredLeft),
    Math.max(
      viewportLeft + viewportPadding,
      viewportRight - cardWidth - viewportPadding,
    ),
  );
  popover.style.left = `${Math.floor(clampedLeft)}px`;
  const availableAbove = Math.max(
    0,
    anchorRect.top - viewportTop - viewportPadding - 8,
  );
  const availableBelow = Math.max(
    0,
    viewportBottom - anchorRect.bottom - viewportPadding - 8,
  );
  const placeBelow =
    availableAbove < cardRect.height && availableBelow > availableAbove;
  if (placeBelow) {
    popover.classList.add("llm-web-source-popover-below");
  }
  const availableHeight = placeBelow ? availableBelow : availableAbove;
  popover.style.maxHeight = `${Math.floor(availableHeight)}px`;
  const renderedHeight = Math.min(cardRect.height, availableHeight);
  popover.style.top = `${Math.floor(
    placeBelow
      ? anchorRect.bottom + 8
      : Math.max(
          viewportTop + viewportPadding,
          anchorRect.top - renderedHeight - 8,
        ),
  )}px`;
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
        },
      ];
    } catch {
      return [];
    }
  });
}

function buildSourceIndicator(
  doc: Document,
  anchor: WebSourceAnchor,
): HTMLElement | null {
  const sources = normalizeWebSourcePopoverRows(anchor);
  if (!sources.length) return null;

  const wrapper = doc.createElement("span");
  wrapper.className = "llm-web-source-indicator";
  let pinned = false;
  let indicatorHovered = false;
  let popoverHovered = false;
  let closeTimer: number | undefined;
  let removeOpenListeners: (() => void) | null = null;

  const chip = doc.createElement("button");
  chip.type = "button";
  chip.className = "llm-web-source-chip";
  chip.setAttribute("aria-label", t("View web sources"));
  chip.setAttribute("aria-haspopup", "dialog");
  chip.setAttribute("aria-expanded", "false");

  const globe = doc.createElement("span");
  globe.className = "llm-web-source-globe";
  globe.setAttribute("aria-hidden", "true");
  chip.appendChild(globe);

  const popover = doc.createElement("span");
  popover.className = "llm-web-source-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", t("Web sources"));

  const clearCloseTimer = () => {
    if (closeTimer === undefined) return;
    doc.defaultView?.clearTimeout(closeTimer);
    closeTimer = undefined;
  };

  const close = () => {
    clearCloseTimer();
    wrapper.classList.remove("expanded");
    popover.classList.remove("llm-web-source-popover-visible");
    chip.setAttribute("aria-expanded", "false");
    removeOpenListeners?.();
    removeOpenListeners = null;
    popover.remove();
  };

  const focusIsInside = () =>
    wrapper.contains(doc.activeElement) || popover.contains(doc.activeElement);

  const scheduleClose = () => {
    clearCloseTimer();
    closeTimer = doc.defaultView?.setTimeout(() => {
      closeTimer = undefined;
      if (pinned || indicatorHovered || popoverHovered || focusIsInside()) {
        return;
      }
      close();
    }, 120);
  };

  const open = () => {
    clearCloseTimer();
    if (!popover.isConnected) {
      (doc.body || doc.documentElement).appendChild(popover);
    }
    popover.classList.add("llm-web-source-popover-visible");
    chip.setAttribute("aria-expanded", "true");
    positionSourceCard(wrapper, popover);
    if (removeOpenListeners) return;

    const reposition = () => {
      if (!wrapper.isConnected) {
        pinned = false;
        close();
        return;
      }
      positionSourceCard(wrapper, popover);
    };
    const onOutsideMouseDown = (event: Event) => {
      if (
        event.target &&
        (wrapper.contains(event.target as Node) ||
          popover.contains(event.target as Node))
      ) {
        return;
      }
      pinned = false;
      close();
    };
    const scrollHost = wrapper.closest(".llm-messages");
    doc.addEventListener("mousedown", onOutsideMouseDown, true);
    scrollHost?.addEventListener("scroll", reposition, { passive: true });
    doc.defaultView?.addEventListener("resize", reposition);
    const MutationObserverCtor = doc.defaultView?.MutationObserver;
    const connectionObserver = MutationObserverCtor
      ? new MutationObserverCtor(() => {
          if (!wrapper.isConnected) {
            pinned = false;
            close();
          }
        })
      : null;
    connectionObserver?.observe(doc.documentElement, {
      childList: true,
      subtree: true,
    });
    removeOpenListeners = () => {
      doc.removeEventListener("mousedown", onOutsideMouseDown, true);
      scrollHost?.removeEventListener("scroll", reposition);
      doc.defaultView?.removeEventListener("resize", reposition);
      connectionObserver?.disconnect();
    };
  };

  for (const source of sources) {
    const row = doc.createElement("button");
    row.type = "button";
    row.className = "llm-web-source-row";
    row.title = `${t("Open web source")}: ${source.title}`;

    const siteIcon = doc.createElement("span");
    siteIcon.className = "llm-web-source-site-icon";
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
    row.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      launchWebSource(source.url);
      row.blur();
      pinned = false;
      close();
    });
    popover.appendChild(row);
  }

  const handleFocusOut = () => {
    doc.defaultView?.setTimeout(() => {
      if (focusIsInside()) return;
      pinned = false;
      scheduleClose();
    }, 0);
  };
  const handleEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    pinned = false;
    chip.focus();
    close();
  };
  wrapper.addEventListener("mouseenter", () => {
    indicatorHovered = true;
    open();
  });
  wrapper.addEventListener("mouseleave", () => {
    indicatorHovered = false;
    scheduleClose();
  });
  popover.addEventListener("mouseenter", () => {
    popoverHovered = true;
    clearCloseTimer();
  });
  popover.addEventListener("mouseleave", () => {
    popoverHovered = false;
    scheduleClose();
  });
  wrapper.addEventListener("focusin", open);
  popover.addEventListener("focusin", open);
  wrapper.addEventListener("focusout", handleFocusOut);
  popover.addEventListener("focusout", handleFocusOut);
  wrapper.addEventListener("keydown", handleEscape);
  popover.addEventListener("keydown", handleEscape);
  chip.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    pinned = !pinned;
    wrapper.classList.toggle("expanded", pinned);
    if (!pinned) {
      close();
      return;
    }
    open();
  });

  wrapper.appendChild(chip);
  return wrapper;
}

export function decorateWebSourceIndicators(
  root: HTMLElement,
  doc: Document,
  anchors: readonly WebSourceAnchor[],
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
      const indicator = anchor ? buildSourceIndicator(doc, anchor) : null;
      if (indicator) fragment.appendChild(indicator);
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) {
      fragment.appendChild(doc.createTextNode(text.slice(cursor)));
    }
    textNode.parentNode?.replaceChild(fragment, textNode);
  }
}
