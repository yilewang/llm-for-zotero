import { createElement } from "../../utils/domHelpers";
import { t } from "../../utils/i18n";
import { AUTO_SCROLL_BOTTOM_THRESHOLD } from "./constants";
import { isRequestPending, subscribeRequestActivity } from "./state";
import { createCoalescedFrameScheduler } from "./setupHandlers/controllers/uiSchedulingController";
import { ANSWER_LIGHT_SELECTOR } from "./answerQuoteHighlight";

const LATEST_LABEL = "Jump to latest message";
// The chat fades out over this height at an edge with more text past it.
const EDGE_FADE_PX = 10;
const STREAMING_LABEL = "Response in progress. Jump to latest message";

/**
 * Whether the button sits on words lit by "Show in answer": then it steps
 * aside (kept in place, unseen) until they scroll away or the light goes.
 */
function coversLitWords(button: HTMLElement, chatBox: HTMLElement): boolean {
  if (button.hidden) return false;
  const lit = chatBox.querySelectorAll?.(ANSWER_LIGHT_SELECTOR);
  if (!lit?.length) return false;
  const own = button.getBoundingClientRect?.();
  if (!own || own.width <= 0) return false;
  const gap = 4;
  for (const node of Array.from(lit) as Element[]) {
    for (const rect of Array.from(node.getClientRects?.() || []) as DOMRect[]) {
      if (
        rect.width > 0 &&
        rect.left < own.right + gap &&
        rect.right > own.left - gap &&
        rect.top < own.bottom + gap &&
        rect.bottom > own.top - gap
      )
        return true;
    }
  }
  return false;
}

export function createChatLatestButton(doc: Document): HTMLButtonElement {
  const button = createElement(doc, "button", "llm-chat-latest", {
    id: "llm-chat-latest",
    type: "button",
    hidden: true,
    title: t(LATEST_LABEL),
  });
  button.setAttribute("aria-label", t(LATEST_LABEL));
  const dots = createElement(doc, "span", "llm-chat-latest-dots");
  dots.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i++) {
    dots.appendChild(createElement(doc, "span"));
  }
  const arrow = createElement(doc, "span", "llm-chat-latest-arrow", {
    textContent: "↓",
  });
  arrow.setAttribute("aria-hidden", "true");
  button.append(dots, arrow);
  return button;
}

export function bindChatLatestButton({
  button,
  chatBox,
  getConversationKey,
  onJumpToLatest,
}: {
  button: HTMLButtonElement;
  chatBox: HTMLDivElement;
  getConversationKey: () => number | null;
  onJumpToLatest: () => void;
}): () => void {
  const win = chatBox.ownerDocument.defaultView as
    | (Window & typeof globalThis)
    | null;
  const sync = () => {
    const key = getConversationKey();
    const remaining =
      chatBox.scrollHeight - chatBox.clientHeight - chatBox.scrollTop;
    const hidden =
      key === null ||
      chatBox.clientHeight <= 0 ||
      remaining <= AUTO_SCROLL_BOTTOM_THRESHOLD;
    const pending = key !== null && isRequestPending(key);
    const label = t(pending ? STREAMING_LABEL : LATEST_LABEL);
    // Write only what changed: this runs on every scroll and resize, and
    // each attribute write is a mutation other observers react to.
    if (button.hidden !== hidden) button.hidden = hidden;
    const aside = coversLitWords(button, chatBox);
    if ((button.dataset.aside === "true") !== aside)
      button.dataset.aside = String(aside);
    if (button.dataset.pending !== String(pending))
      button.dataset.pending = String(pending);
    if (button.title !== label) button.title = label;
    if (button.getAttribute("aria-label") !== label)
      button.setAttribute("aria-label", label);
    // The fade grows with the distance to the edge, so it eases in as the
    // chat leaves the top or bottom instead of appearing at once.
    const top = `${Math.round(Math.min(Math.max(chatBox.scrollTop, 0), EDGE_FADE_PX))}px`;
    const bottom = `${Math.round(Math.min(Math.max(remaining, 0), EDGE_FADE_PX))}px`;
    const style = chatBox.style;
    if (style.getPropertyValue("--llm-edge-fade-top") !== top)
      style.setProperty("--llm-edge-fade-top", top);
    if (style.getPropertyValue("--llm-edge-fade-bottom") !== bottom)
      style.setProperty("--llm-edge-fade-bottom", bottom);
  };
  const scheduler = createCoalescedFrameScheduler({
    getWindow: () => win,
    run: sync,
  });
  const schedule = scheduler.schedule;
  const onClick = () => {
    if (getConversationKey() === null) return;
    onJumpToLatest();
    schedule();
  };
  button.addEventListener("click", onClick);
  chatBox.addEventListener("scroll", schedule, { passive: true });
  chatBox.addEventListener("load", schedule, true);
  const unsubscribeActivity = subscribeRequestActivity((key) => {
    if (key === getConversationKey()) schedule();
  });

  // Watch message size as well as the viewport: loaded media and disclosures
  // can change the distance to the latest message without a scroll event.
  const resizedChildren = new Set<Element>();
  const resizeObserver = win?.ResizeObserver
    ? new win.ResizeObserver(schedule)
    : null;
  resizeObserver?.observe(chatBox);
  const observeChildren = () => {
    const current = new Set(Array.from(chatBox.children));
    for (const child of resizedChildren) {
      if (!current.has(child)) {
        resizeObserver?.unobserve(child);
        resizedChildren.delete(child);
      }
    }
    for (const child of current) {
      if (!resizedChildren.has(child)) {
        resizeObserver?.observe(child);
        resizedChildren.add(child);
      }
    }
  };
  observeChildren();
  const mutationObserver = win?.MutationObserver
    ? new win.MutationObserver((records) => {
        if (records.some((record) => record.target === chatBox)) {
          observeChildren();
        }
        schedule();
      })
    : null;
  mutationObserver?.observe(chatBox, {
    childList: true,
    subtree: true,
    characterData: true,
    // A quote card or table row lit, or its light gone, changes only a class.
    attributes: true,
    attributeFilter: ["class"],
  });
  sync();

  return () => {
    button.removeEventListener("click", onClick);
    chatBox.removeEventListener("scroll", schedule);
    chatBox.removeEventListener("load", schedule, true);
    unsubscribeActivity();
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
    resizedChildren.clear();
    scheduler.dispose();
  };
}
