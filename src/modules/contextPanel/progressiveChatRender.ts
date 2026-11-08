/**
 * Progressive drawing of long conversations.
 *
 * A full chat render of a long conversation first draws the messages at the
 * reading position (the newest ones, or the ones around a restored scroll
 * anchor), enough to fill two viewports on each side, and adds the rest in
 * small pieces on later frames. This file holds the plan (which messages the
 * first pass draws) and the per-chat-box registry of the waiting messages,
 * so code that needs one of them in the DOM can draw it first.
 */

/** Conversations with at most this many messages are drawn in one pass. */
export const PROGRESSIVE_CHAT_RENDER_MIN_MESSAGES = 24;
/** Messages the first pass draws at the reading position before measuring. */
export const PROGRESSIVE_CHAT_RENDER_INITIAL_TAIL = 6;
/** Messages added per step while the first pass fills the viewports. */
export const PROGRESSIVE_CHAT_RENDER_FILL_STEP = 4;
/** Messages drawn above a restored scroll anchor before measuring. */
export const PROGRESSIVE_CHAT_RENDER_ANCHOR_MARGIN = 2;
/** Build time per frame for waiting messages; layout comes on top. */
export const PROGRESSIVE_CHAT_RENDER_FRAME_BUDGET_MS = 8;

export type ProgressiveAnchorLike = {
  messageAnchorKey?: string;
  messageRole?: string;
  messageTimestamp?: string;
  messageIndex?: string;
};

type MessageLike = {
  role: string;
  timestamp?: number;
  id?: number;
};

function floorTimestamp(message: MessageLike): string {
  return `${Math.floor(Number(message.timestamp) || 0)}`;
}

/**
 * Index in `history` of the message a scroll anchor names, or -1. The
 * identity matches the rendered wrapper's data attributes (see
 * chatScrollGeometry.findMessageWrapperForAnchor).
 */
export function resolveAnchorMessageIndex(
  history: readonly MessageLike[],
  anchor: ProgressiveAnchorLike | undefined,
): number {
  if (!anchor) return -1;
  const key = anchor.messageAnchorKey || "";
  const idMatch = /^id:(\d+)$/.exec(key);
  if (idMatch) {
    const id = Number(idMatch[1]);
    const index = history.findIndex(
      (message) => Math.floor(Number(message.id || 0)) === id,
    );
    if (index >= 0) return index;
  }
  const role = anchor.messageRole;
  const timestamp = anchor.messageTimestamp;
  if (!role || !timestamp) {
    const keyed = /^([a-z]+):(\d+):(\d+)$/.exec(key);
    if (!keyed) return -1;
    const index = Number(keyed[3]);
    const message = history[index];
    return message?.role === keyed[1] && floorTimestamp(message) === keyed[2]
      ? index
      : -1;
  }
  const hinted = Number(anchor.messageIndex);
  if (Number.isInteger(hinted) && hinted >= 0) {
    const message = history[hinted];
    if (message?.role === role && floorTimestamp(message) === timestamp)
      return hinted;
  }
  return history.findIndex(
    (message) => message.role === role && floorTimestamp(message) === timestamp,
  );
}

export type ProgressiveRenderPlanInput = {
  total: number;
  /** False when the render cannot be split (no item, panel extensions). */
  allowed: boolean;
  /**
   * The scroll position to restore. "followBottom" needs the newest
   * messages; "manual" needs its anchor message, or everything when the
   * position has no anchor in this history.
   */
  scrollMode: "followBottom" | "manual";
  anchorIndex: number;
  /** Messages that must be in the DOM now (for example an open edit). */
  requiredIndices?: readonly number[];
};

/** Messages [start, end) are drawn in the first pass; the rest later. */
export type ProgressiveRenderRange = { start: number; end: number };

/**
 * The messages drawn in the first pass: the newest ones, or the ones around
 * a restored scroll anchor. Everything when the render cannot be split.
 */
export function planProgressiveChatRenderRange(
  input: ProgressiveRenderPlanInput,
): ProgressiveRenderRange {
  const { total } = input;
  const all = { start: 0, end: total };
  if (!input.allowed || total <= PROGRESSIVE_CHAT_RENDER_MIN_MESSAGES)
    return all;
  let range = {
    start: Math.max(0, total - PROGRESSIVE_CHAT_RENDER_INITIAL_TAIL),
    end: total,
  };
  if (input.scrollMode === "manual") {
    if (input.anchorIndex < 0 || input.anchorIndex >= total) return all;
    range = {
      start: Math.max(
        0,
        input.anchorIndex - PROGRESSIVE_CHAT_RENDER_ANCHOR_MARGIN,
      ),
      end: Math.min(
        total,
        input.anchorIndex + PROGRESSIVE_CHAT_RENDER_INITIAL_TAIL,
      ),
    };
  }
  for (const index of input.requiredIndices || []) {
    if (!Number.isInteger(index) || index < 0 || index >= total) continue;
    range = {
      start: Math.min(range.start, index),
      end: Math.max(range.end, index + 1),
    };
  }
  return range;
}

export type PendingChatRender = {
  conversationKey: number;
  /** True while `message` is waiting to be drawn. */
  isPending(message: unknown): boolean;
  /** Draws every waiting message now. */
  flush(): void;
  /** Drops the waiting messages without drawing them. */
  cancel(): void;
};

const pendingChatRenders = new WeakMap<Element, PendingChatRender>();

export function setPendingChatRender(
  chatBox: Element,
  pending: PendingChatRender,
): void {
  const previous = pendingChatRenders.get(chatBox);
  if (previous && previous !== pending) previous.cancel();
  pendingChatRenders.set(chatBox, pending);
}

export function getPendingChatRender(
  chatBox: Element | null | undefined,
): PendingChatRender | undefined {
  return chatBox ? pendingChatRenders.get(chatBox) : undefined;
}

/** Called by a pending render once it is done or cancelled. */
export function clearPendingChatRender(
  chatBox: Element,
  pending: PendingChatRender,
): void {
  if (pendingChatRenders.get(chatBox) === pending)
    pendingChatRenders.delete(chatBox);
}

export function cancelPendingChatRender(
  chatBox: Element | null | undefined,
): void {
  getPendingChatRender(chatBox)?.cancel();
}

/**
 * Draws every message still waiting in this chat box. True when there was
 * something to draw. Call before reading an older message from the DOM.
 */
export function flushPendingChatRender(
  chatBox: Element | null | undefined,
): boolean {
  const pending = getPendingChatRender(chatBox);
  if (!pending) return false;
  pending.flush();
  return true;
}
