/**
 * Per-panel extensions for the chat renderer and composer.
 *
 * A panel body can register optional behavior that refreshChat and the "/"
 * menu read on every render: a read-only flag, extra footer actions on
 * finished assistant messages, a post-render decorator, the provider for
 * the "Add side chat" slash item, and the target of "Quote in side chat". A body with nothing registered renders
 * exactly as before; the lookup is one WeakMap read.
 */

export type ChatPanelAssistantActionInfo = {
  contentText: string;
  conversationKey: number;
  timestamp?: number;
};

export type ChatPanelAssistantAction = {
  /** Stable id; the button also gets the class `llm-message-action-<id>`. */
  id: string;
  /** Tooltip and accessible label (already translated). */
  label: string;
  run(info: ChatPanelAssistantActionInfo): void;
};

export type ChatPanelSideChatSlashItem = {
  /** `title` names the side chat that "Add side chat" would attach. */
  getState(): { available: boolean; title?: string };
  attach(): void;
};

export type ChatPanelSideChatQuote = {
  /**
   * Quotes `text` into the shown side chat, or a new one when none is shown;
   * `question` becomes the chip's question.
   */
  quote(text: string, question?: string): void;
};

export type ChatPanelExtensions = {
  /**
   * Render without any control that writes to the conversation or starts an
   * edit: no inline edit, Continue, retry, delete, fork, prompt or response
   * context menu, or webchat re-fetch. Copy, note, and expand stay.
   */
  readOnly?: boolean;
  /**
   * The window's temporary side chat: its turns live in memory only, so no
   * control that rewrites a stored turn (inline edit, retry, fork). Delete,
   * copy, and the rest stay.
   */
  sideChat?: boolean;
  /** Extra footer buttons on finished assistant messages. */
  extraAssistantActions?: readonly ChatPanelAssistantAction[];
  /** Called at the end of every refreshChat for this body. */
  afterRender?: (chatBox: HTMLElement) => void;
  /** Provider for the "Add side chat" item in this body's "/" menu. */
  sideChatSlashItem?: ChatPanelSideChatSlashItem;
  /** Target of "Quote in side chat" in this body's selection popup. */
  sideChatQuote?: ChatPanelSideChatQuote;
};

const chatPanelExtensions = new WeakMap<Element, ChatPanelExtensions>();

/** Replaces the body's extensions; null or an empty object clears them. */
export function setChatPanelExtensions(
  body: Element,
  extensions: ChatPanelExtensions | null,
): void {
  const next = extensions ? compactChatPanelExtensions(extensions) : null;
  if (next) {
    chatPanelExtensions.set(body, next);
  } else {
    chatPanelExtensions.delete(body);
  }
}

/**
 * Merges a patch into the body's extensions. A key set to undefined in the
 * patch is removed, so separate owners can register their own keys.
 */
export function updateChatPanelExtensions(
  body: Element,
  patch: ChatPanelExtensions,
): void {
  setChatPanelExtensions(
    body,
    mergeChatPanelExtensions(chatPanelExtensions.get(body) || null, patch),
  );
}

export function getChatPanelExtensions(
  body: Element,
): ChatPanelExtensions | null {
  return chatPanelExtensions.get(body) || null;
}

export function clearChatPanelExtensions(body: Element): void {
  chatPanelExtensions.delete(body);
}

export function isChatPanelReadOnly(body: Element): boolean {
  return chatPanelExtensions.get(body)?.readOnly === true;
}

/** No inline edit, retry, or fork: a read-only body or a side chat. */
export function isChatPanelTurnRewriteDisabled(body: Element): boolean {
  const extensions = chatPanelExtensions.get(body);
  return extensions?.readOnly === true || extensions?.sideChat === true;
}

export function mergeChatPanelExtensions(
  current: ChatPanelExtensions | null,
  patch: ChatPanelExtensions,
): ChatPanelExtensions | null {
  const merged: Record<string, unknown> = { ...(current || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return compactChatPanelExtensions(merged as ChatPanelExtensions);
}

function compactChatPanelExtensions(
  extensions: ChatPanelExtensions,
): ChatPanelExtensions | null {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extensions)) {
    if (value !== undefined) compact[key] = value;
  }
  return Object.keys(compact).length ? (compact as ChatPanelExtensions) : null;
}
