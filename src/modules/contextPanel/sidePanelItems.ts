/**
 * Items that move from the main chat into a side panel tab: a Mermaid
 * diagram, an SVG figure, a paper figure crop, an HTML page, a code block, a
 * plan document, or a file the agent saved to disk.
 *
 * Only the standalone window has a side panel, and only its panel registers an
 * item host for its document. A renderer that wants a "Move to side panel"
 * button asks `getSidePanelItemHost(doc)`: no host (the Zotero item-pane
 * sidebar, a separate document) means no button. This is the same rule as
 * "Quote in side chat", which exists only when the standalone panel registers
 * its target.
 */

import { t } from "../../utils/i18n";

export type SidePanelItemKind =
  | "mermaid"
  | "svg"
  | "html"
  | "code"
  | "plan"
  | "figure"
  | "file";

/** What a renderer hands over when its button is clicked. */
export type SidePanelItemRequest = {
  kind: SidePanelItemKind;
  /** A better title than the kind's default (a plan's title, a code language). */
  title?: string;
  /** Fence source, code, or markdown: what Copy puts on the clipboard. */
  source: string;
  /** Code language label, for a code block. */
  lang?: string;
  /** The rendered item in the main chat; the host locates its message from it. */
  element?: Element | null;
  /** A plan document's id. */
  documentId?: string;
  /** A saved file's path; the tab reads the file from disk each time. */
  filePath?: string;
  /** Draws the tab body (a plan, a paper figure); default is rendered Markdown. */
  renderBody?: (doc: Document, root: HTMLElement) => void;
  /** Saves a plan as a Zotero note; resolves to a status line. */
  saveAsNote?: () => Promise<string>;
  /** Opens a plan document in its own window; false when it could not. */
  openOwnWindow?: () => boolean;
};

export type SidePanelItemHost = {
  /** Opens the panel if closed, then opens or switches to the item's tab. */
  open(request: SidePanelItemRequest): void;
};

const hosts = new WeakMap<Document, SidePanelItemHost>();

export function registerSidePanelItemHost(
  doc: Document,
  host: SidePanelItemHost,
): void {
  hosts.set(doc, host);
}

export function unregisterSidePanelItemHost(
  doc: Document,
  host: SidePanelItemHost,
): void {
  if (hosts.get(doc) === host) hosts.delete(doc);
}

/** The document's host; null in the Zotero item-pane sidebar. */
export function getSidePanelItemHost(
  doc: Document | null | undefined,
): SidePanelItemHost | null {
  return (doc && hosts.get(doc)) || null;
}

export const SIDE_PANEL_ITEM_KINDS: readonly SidePanelItemKind[] = [
  "mermaid",
  "svg",
  "html",
  "code",
  "plan",
  "figure",
  "file",
];

/** The renderer marks the element it moves, so its position can be counted. */
export const SIDE_ITEM_KIND_ATTRIBUTE = "data-side-item-kind";

/**
 * Set on a rendered block whose content is not part of the answer (the agent
 * trace's tool inputs, tool results and process messages). Nothing inside it
 * gets a →| button or a Miscellaneous row.
 */
export const NO_SIDE_ITEMS_ATTRIBUTE = "data-llm-no-side-items";

/** True when `element` sits inside a block marked NO_SIDE_ITEMS_ATTRIBUTE. */
export function isOutsideAnswerContent(element: Element): boolean {
  return Boolean(element.closest?.(`[${NO_SIDE_ITEMS_ATTRIBUTE}]`));
}

export const SIDE_ITEM_FLASH_CLASS = "llm-side-item-flash";
export const SIDE_ITEM_FLASH_MS = 1200;

export const MOVE_TO_SIDE_PANEL_TITLE = "Move to side panel";

/** The item's identity in the main chat. */
export type SidePanelItemIdentity = {
  conversationKey: number;
  /** The source message's index in the chat; -1 when it is not known. */
  messageIndex: number;
  kind: SidePanelItemKind;
  /** Position among items of this kind in the message. */
  ordinal: number;
  documentId?: string;
};

/**
 * Same source message, same kind, same position: the same item. A plan
 * document keeps its document id, so it stays the same item if the message
 * index moves.
 */
export function buildSidePanelItemKey(identity: SidePanelItemIdentity): string {
  const where =
    identity.kind === "plan" && identity.documentId
      ? `doc=${identity.documentId}`
      : `msg=${identity.messageIndex}:${identity.ordinal}`;
  return `${identity.conversationKey}|${identity.kind}|${where}`;
}

/** The message wrapper that holds `element`, and its index in the chat. */
export function findSourceMessage(
  element: Element | null | undefined,
): { wrapper: Element; messageIndex: number } | null {
  const wrapper = element?.closest?.(
    ".llm-message-wrapper[data-message-index]",
  );
  if (!wrapper) return null;
  const index = Number((wrapper as HTMLElement).dataset?.messageIndex);
  return Number.isInteger(index) && index >= 0
    ? { wrapper, messageIndex: index }
    : null;
}

/**
 * The item's source message index and identity key in the main chat. The
 * →| button and the Miscellaneous list both use it, so an item has the same
 * key whichever way it is opened.
 */
export function resolveSidePanelItemIdentity(
  request: SidePanelItemRequest,
  conversationKey: number,
): { messageIndex: number; itemKey: string } {
  const source = findSourceMessage(request.element);
  const messageIndex = source ? source.messageIndex : -1;
  const ordinal =
    source && request.element
      ? findItemOrdinal(source.wrapper, request.element, request.kind)
      : 0;
  return {
    messageIndex,
    itemKey: buildSidePanelItemKey({
      conversationKey,
      messageIndex,
      kind: request.kind,
      ordinal,
      documentId: request.documentId,
    }),
  };
}

/** Position of `element` among the marked items of its kind in `wrapper`. */
export function findItemOrdinal(
  wrapper: Element,
  element: Element,
  kind: SidePanelItemKind,
): number {
  const marked = Array.from(
    wrapper.querySelectorAll(`[${SIDE_ITEM_KIND_ATTRIBUTE}="${kind}"]`),
  );
  const index = marked.indexOf(element);
  return index >= 0 ? index : 0;
}

/** The tab title: the item's own title, else a short label for its kind. */
export function resolveItemTabTitle(
  request: Pick<SidePanelItemRequest, "kind" | "title" | "lang">,
  translate: (text: string) => string = (text) => text,
): string {
  const own = String(request.title || "").trim();
  switch (request.kind) {
    case "mermaid":
      return own || translate("Mermaid diagram");
    case "svg":
      return own || translate("Figure");
    case "html":
      return own || translate("HTML page");
    case "code":
      return own || String(request.lang || "").trim() || translate("Code");
    case "plan":
      return own || translate("Document");
    case "figure":
      return own || translate("Figure");
    case "file":
      return own || translate("File");
  }
}

/**
 * A fenced code block's inner code and language. The chat's copy source keeps
 * the fence lines (```python … ```, ~~~ … ~~~, ```python title=x); a code tab
 * wants only the code between them. Text without an opening fence is returned
 * as it is, with no language.
 */
export function splitCodeFence(source: string): { code: string; lang: string } {
  const text = String(source || "").replace(/\r\n?/g, "\n");
  const opener = text.match(/^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)/);
  if (!opener) return { code: text, lang: "" };
  const fence = opener[1];
  const info = opener[2].trim();
  // A backtick fence's info string cannot contain a backtick.
  if (fence[0] === "`" && info.includes("`")) return { code: text, lang: "" };
  const lang = (info.split(/[\s{]/)[0] || "")
    .toLowerCase()
    .replace(/[^a-z0-9_+#.-]/g, "")
    .slice(0, 32);
  const lines = text.slice(opener[0].length).split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const last = (lines[lines.length - 1] || "").trim();
  if (
    lines.length &&
    last.length >= fence.length &&
    last.split("").every((char) => char === fence[0])
  ) {
    lines.pop();
  }
  return { code: lines.join("\n"), lang };
}

/** A code fence that no backtick run in `source` can close early. */
export function fenceAround(lang: string, source: string): string {
  const longest = Math.max(
    0,
    ...(source.match(/`+/g) || []).map((run) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${source}\n${fence}`;
}

/**
 * The Markdown a code, Mermaid, or SVG tab renders: the inner code in one
 * fence with its real language, so the chat's code block renderer labels and
 * highlights it the same way. A code source handed over with no language may
 * still carry its own fence; it is unwrapped first, so the tab never shows the
 * fence lines as code. Code with a language is already the inner code (a
 * Markdown block's code may itself start with a fence).
 */
export function buildItemFenceMarkdown(
  request: Pick<SidePanelItemRequest, "kind" | "source" | "lang">,
): string {
  if (request.kind !== "code") {
    return fenceAround(request.kind, request.source);
  }
  const given = String(request.lang || "").trim();
  const { code, lang } = given
    ? { code: request.source, lang: given }
    : splitCodeFence(request.source);
  return fenceAround(lang.replace(/[^\w+#.-]/g, ""), code);
}

/** Plans can be saved as a note; the other kinds cannot. */
export function canSaveItemAsNote(kind: SidePanelItemKind): boolean {
  return kind === "plan";
}

/** A page runs again; a saved file loads again from disk. */
export function canRunItemAgain(kind: SidePanelItemKind): boolean {
  return kind === "html" || kind === "file";
}

/**
 * Scrolls the chat to a message and flashes it. Returns the wrapper, or null
 * when the message is not on screen. The flash class goes away after
 * SIDE_ITEM_FLASH_MS.
 */
export function flashSourceMessage(params: {
  container: ParentNode;
  messageIndex: number;
  setTimeout: (callback: () => void, ms: number) => unknown;
}): Element | null {
  if (!(params.messageIndex >= 0)) return null;
  const wrapper = params.container.querySelector(
    `.llm-message-wrapper[data-message-index="${params.messageIndex}"]`,
  );
  if (!wrapper) return null;
  (wrapper as HTMLElement).scrollIntoView?.({
    block: "center",
    behavior: "smooth",
  });
  wrapper.classList.add(SIDE_ITEM_FLASH_CLASS);
  params.setTimeout(
    () => wrapper.classList.remove(SIDE_ITEM_FLASH_CLASS),
    SIDE_ITEM_FLASH_MS,
  );
  return wrapper;
}

/** The request builder behind each →| button, so a list can reuse it. */
const requestBuilders = new WeakMap<
  Element,
  () => SidePanelItemRequest | null
>();

/** One thing the model made in the main chat, for the Miscellaneous list. */
export type MadeItem = {
  kind: SidePanelItemKind;
  request: SidePanelItemRequest;
  /** The source message's index in the chat; -1 when it is not known. */
  messageIndex: number;
  /** The source message's time (ms); 0 when it is not known. */
  timestamp: number;
};

/** A made item and the chat it was made in. */
export type ChatMadeItem = MadeItem & { conversationKey: number };

/**
 * One list from several chats' lists (each newest first): newest first by
 * message time. Items with the same time keep their chat's order, and the
 * lists' order between chats.
 */
export function mergeChatMadeItems(
  lists: readonly (readonly ChatMadeItem[])[],
): ChatMadeItem[] {
  const ranked = lists.flatMap((list, listIndex) =>
    list.map((made, index) => ({ made, listIndex, index })),
  );
  ranked.sort(
    (a, b) =>
      b.made.timestamp - a.made.timestamp ||
      a.listIndex - b.listIndex ||
      a.index - b.index,
  );
  return ranked.map((entry) => entry.made);
}

/**
 * Everything movable in the rendered main chat (diagrams, figures, pages,
 * code blocks, plan documents, saved files) in the answers, never in the agent trace,
 * newest first. Items come
 * from the same markers and request builders the →| buttons use, so identity
 * and content match what the button would open.
 */
export function collectMadeItems(container: ParentNode): MadeItem[] {
  const items: MadeItem[] = [];
  const marked = Array.from(
    container.querySelectorAll(
      `[${SIDE_ITEM_KIND_ATTRIBUTE}]`,
    ) as unknown as ArrayLike<Element>,
  );
  for (const element of marked) {
    const kind = element.getAttribute(
      SIDE_ITEM_KIND_ATTRIBUTE,
    ) as SidePanelItemKind | null;
    if (
      !kind ||
      !SIDE_PANEL_ITEM_KINDS.includes(kind) ||
      isOutsideAnswerContent(element)
    ) {
      continue;
    }
    // The element's own button, not one that belongs to an item inside it.
    const button = Array.from(
      element.querySelectorAll(
        ".llm-side-move-btn",
      ) as unknown as ArrayLike<Element>,
    ).find(
      (candidate) =>
        candidate.closest(`[${SIDE_ITEM_KIND_ATTRIBUTE}]`) === element,
    );
    const build =
      requestBuilders.get(element) ||
      (button ? requestBuilders.get(button) : undefined);
    const request = build ? build() : null;
    if (!request) continue;
    const source = findSourceMessage(element);
    const timestamp = Number(
      (source?.wrapper as HTMLElement | undefined)?.dataset?.messageTimestamp,
    );
    items.push({
      kind,
      request,
      messageIndex: source ? source.messageIndex : -1,
      timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0,
    });
  }
  return items.reverse();
}

/** The request builder behind a →| button, for a caller that re-homes it. */
export function getSideItemRequestBuilder(
  button: Element,
): (() => SidePanelItemRequest | null) | undefined {
  return requestBuilders.get(button);
}

/**
 * Registers what opening `element` in the side panel means, for an item
 * that opens itself on click instead of having a →| button (a file card).
 */
export function registerSideItemRequest(
  element: Element,
  buildRequest: () => SidePanelItemRequest | null,
): void {
  requestBuilders.set(element, buildRequest);
}

/**
 * Adds a "Move to side panel" button to `parent` when this document has a
 * side panel. Returns the button, or null in the sidebar.
 */
export function appendMoveToSidePanelButton(params: {
  doc: Document;
  parent: Element;
  className: string;
  /** Builds the request at click time (the source may have changed). */
  buildRequest: () => SidePanelItemRequest | null;
}): HTMLButtonElement | null {
  const host = getSidePanelItemHost(params.doc);
  if (!host) return null;
  if (params.parent.querySelector(":scope > .llm-side-move-btn")) return null;
  const title = t(MOVE_TO_SIDE_PANEL_TITLE);
  const button = params.doc.createElement("button") as HTMLButtonElement;
  button.type = "button";
  button.className = `llm-side-move-btn ${params.className}`;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    // The host is read again: the panel may have closed since the render.
    const current = getSidePanelItemHost(params.doc);
    const request = params.buildRequest();
    if (current && request) current.open(request);
  });
  requestBuilders.set(button, params.buildRequest);
  params.parent.appendChild(button);
  return button;
}
