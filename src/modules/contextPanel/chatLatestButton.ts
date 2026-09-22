import { createElement } from "../../utils/domHelpers";
import { t } from "../../utils/i18n";
import { AUTO_SCROLL_BOTTOM_THRESHOLD } from "./constants";
import { isRequestPending, subscribeRequestActivity } from "./state";
import { createCoalescedFrameScheduler } from "./setupHandlers/controllers/uiSchedulingController";

const LATEST_LABEL = "Jump to latest message";
const STREAMING_LABEL = "Response in progress. Jump to latest message";

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
    button.hidden =
      key === null ||
      chatBox.clientHeight <= 0 ||
      remaining <= AUTO_SCROLL_BOTTOM_THRESHOLD;
    const pending = key !== null && isRequestPending(key);
    const label = t(pending ? STREAMING_LABEL : LATEST_LABEL);
    button.dataset.pending = String(pending);
    button.title = label;
    button.setAttribute("aria-label", label);
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
