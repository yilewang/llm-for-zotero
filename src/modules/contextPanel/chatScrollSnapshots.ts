import { AUTO_SCROLL_BOTTOM_THRESHOLD } from "./constants";

type ChatScrollMode = "followBottom" | "manual";

type ChatScrollAnchor = {
  kind: "quote" | "message";
  quoteCitationId?: string;
  citationSyncKey?: string;
  /**
   * Position of the card among its message's quote cards. A citation id is
   * not unique — one answer can cite the same source quote several times —
   * so identity is "the Nth card of this message", with the id as a check.
   */
  quoteOrdinal?: number;
  messageAnchorKey?: string;
  messageRole?: string;
  messageTimestamp?: string;
  messageIndex?: string;
  viewportOffsetTop: number;
};

export interface ChatScrollSnapshot {
  mode: ChatScrollMode;
  scrollTop: number;
  updatedAt: number;
  anchor?: ChatScrollAnchor;
}

type ScrollGuardRestoreMode = "absolute" | "relative" | "anchor";

type ActiveChatNavigation = {
  conversationKey: number;
  chatBox: HTMLDivElement;
  snapshot: ChatScrollSnapshot;
  anchor: ChatScrollAnchor;
  stableFrames: number;
  rafId: number | null;
  timeoutId: number | null;
  removeInputListeners: () => void;
};

type RecentChatNavigationSuppression = {
  conversationKey: number;
  expiresAt: number;
  timeoutId: number;
  removeInputListeners: () => void;
};

const chatScrollSnapshots = new Map<number, ChatScrollSnapshot>();
let panelScrollSnapshots = new WeakMap<
  HTMLDivElement,
  { key: number; snapshot: ChatScrollSnapshot }
>();
const pendingChatScrollRestores = new Map<
  number,
  {
    snapshot: ChatScrollSnapshot;
    expiresAt: number;
    appliedBodies: WeakSet<Element>;
  }
>();
const followBottomCatchupRequests = new Map<number, number>();
const FOLLOW_BOTTOM_CATCHUP_GRACE_MS = 1200;
const PENDING_RESTORE_TTL_MS = 3000;
const NAVIGATION_SETTLE_TOLERANCE_PX = 1;
const NAVIGATION_SETTLE_FRAMES = 2;
const NAVIGATION_TIMEOUT_MS = 1200;
const NAVIGATION_SCROLL_EVENT_GRACE_MS = 150;

let activeChatNavigations = new WeakMap<HTMLDivElement, ActiveChatNavigation>();
let recentChatNavigationSuppressions = new WeakMap<
  HTMLDivElement,
  RecentChatNavigationSuppression
>();
const liveNavigationBoxes = new Set<HTMLDivElement>();
const liveNavigationSuppressionBoxes = new Set<HTMLDivElement>();

let suspendedScrollBoxes = new WeakMap<HTMLDivElement, number>();
let suspendedScrollCount = 0;
function suspendChatScrollUpdates(box: HTMLDivElement): void {
  suspendedScrollBoxes.set(box, (suspendedScrollBoxes.get(box) || 0) + 1);
  suspendedScrollCount++;
  const active = suspendedScrollBoxes;
  Promise.resolve().then(() => {
    if (active !== suspendedScrollBoxes) return;
    const remaining = (active.get(box) || 1) - 1;
    if (remaining) active.set(box, remaining);
    else active.delete(box);
    suspendedScrollCount--;
  });
}

export function isScrollUpdateSuspended(box?: HTMLDivElement): boolean {
  return box ? suspendedScrollBoxes.has(box) : suspendedScrollCount > 0;
}

function normalizeConversationKey(conversationKey: number): number | null {
  const normalized = Math.floor(Number(conversationKey || 0));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function getMaxScrollTop(chatBox: HTMLDivElement): number {
  return Math.max(0, chatBox.scrollHeight - chatBox.clientHeight);
}

function isChatViewportVisible(chatBox: HTMLDivElement): boolean {
  return chatBox.clientHeight > 0 && chatBox.getClientRects().length > 0;
}

function clampScrollTop(chatBox: HTMLDivElement, scrollTop: number): number {
  return Math.max(0, Math.min(getMaxScrollTop(chatBox), scrollTop));
}

function isNearBottom(chatBox: HTMLDivElement): boolean {
  const distanceFromBottom =
    chatBox.scrollHeight - chatBox.clientHeight - chatBox.scrollTop;
  return distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD;
}

function getElementRect(element: Element): DOMRect | null {
  const rect = element.getBoundingClientRect?.();
  if (!rect) return null;
  if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) {
    return null;
  }
  return rect;
}

function isRectVisibleInViewport(rect: DOMRect, viewport: DOMRect): boolean {
  return rect.bottom > viewport.top && rect.top < viewport.bottom;
}

function datasetValue(element: Element | null, key: string): string {
  const value = (element as HTMLElement | null)?.dataset?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function closestElement(
  element: Element | null,
  selector: string,
): Element | null {
  if (!element || typeof element.closest !== "function") return null;
  try {
    return element.closest(selector);
  } catch (_err) {
    return null;
  }
}

function queryElements(root: Element, selector: string): Element[] {
  try {
    return Array.from(
      root.querySelectorAll(selector) as unknown as ArrayLike<Element>,
    );
  } catch (_err) {
    return [];
  }
}

function getMessageAnchorForElement(element: Element): {
  messageAnchorKey?: string;
  messageRole?: string;
  messageTimestamp?: string;
  messageIndex?: string;
} {
  const wrapper = closestElement(element, ".llm-message-wrapper");
  const anchorKey = datasetValue(wrapper, "messageAnchorKey");
  const role = datasetValue(wrapper, "messageRole");
  const timestamp = datasetValue(wrapper, "messageTimestamp");
  const index = datasetValue(wrapper, "messageIndex");
  return {
    messageAnchorKey: anchorKey || undefined,
    messageRole: role || undefined,
    messageTimestamp: timestamp || undefined,
    messageIndex: index || undefined,
  };
}

function buildQuoteAnchor(
  element: Element,
  viewport: DOMRect,
): ChatScrollAnchor | null {
  const quoteCard = closestElement(element, ".llm-quote-card") || element;
  const quoteCitationId = datasetValue(quoteCard, "quoteCitationId");
  const citationSyncKey =
    datasetValue(element, "citationSyncKey") ||
    datasetValue(
      closestElement(element, "[data-citation-sync-key]"),
      "citationSyncKey",
    );
  if (!quoteCitationId && !citationSyncKey) return null;
  const rect = getElementRect(quoteCard);
  if (!rect || !isRectVisibleInViewport(rect, viewport)) return null;
  const wrapper = closestElement(quoteCard, ".llm-message-wrapper");
  const ordinal = wrapper
    ? queryElements(wrapper, ".llm-quote-card").indexOf(quoteCard)
    : -1;
  return {
    kind: "quote",
    quoteCitationId: quoteCitationId || undefined,
    citationSyncKey: citationSyncKey || undefined,
    quoteOrdinal: ordinal >= 0 ? ordinal : undefined,
    ...getMessageAnchorForElement(quoteCard),
    viewportOffsetTop: rect.top - viewport.top,
  };
}

function buildMessageAnchor(
  element: Element,
  viewport: DOMRect,
): ChatScrollAnchor | null {
  const messageRole = datasetValue(element, "messageRole");
  const messageTimestamp = datasetValue(element, "messageTimestamp");
  if (!messageRole || !messageTimestamp) return null;
  const rect = getElementRect(element);
  if (!rect || !isRectVisibleInViewport(rect, viewport)) return null;
  return {
    kind: "message",
    ...getMessageAnchorForElement(element),
    viewportOffsetTop: rect.top - viewport.top,
  };
}

function scoreVisibleAnchor(element: Element, viewport: DOMRect): number {
  const rect = getElementRect(element);
  if (!rect) return Number.POSITIVE_INFINITY;
  if (rect.top <= viewport.top && rect.bottom > viewport.top) {
    return Math.max(0, viewport.top - rect.top) / 1000;
  }
  return Math.abs(rect.top - viewport.top) + 1;
}

function isEmptyRect(rect: DOMRect): boolean {
  return rect.top === rect.bottom && rect.width === 0;
}

/**
 * Message wrappers are the chat box's vertical sequence, so the ones that
 * intersect the viewport form one contiguous run. Find that run with a binary
 * search over wrapper geometry instead of measuring every message: a long
 * conversation is scrolled many times a second, and each scroll must stay
 * cheap. Hidden wrappers measure as empty rects and are stepped over.
 */
function findVisibleMessageWrappers(
  chatBox: HTMLDivElement,
  viewport: DOMRect,
): { wrappers: Element[]; visible: Element[] } {
  const wrappers = queryElements(chatBox, ".llm-message-wrapper");
  if (!wrappers.length) return { wrappers, visible: [] };
  const measuredRects = new Map<number, DOMRect | null>();
  const rectAt = (index: number): DOMRect | null => {
    if (measuredRects.has(index)) return measuredRects.get(index) || null;
    const rect = getElementRect(wrappers[index]);
    const usable = rect && !isEmptyRect(rect) ? rect : null;
    measuredRects.set(index, usable);
    return usable;
  };
  // Probe the nearest measurable wrapper at or after `index`, staying within
  // [index, limit].
  const probeForward = (
    index: number,
    limit: number,
  ): { index: number; rect: DOMRect } | null => {
    for (let cursor = index; cursor <= limit; cursor += 1) {
      const rect = rectAt(cursor);
      if (rect) return { index: cursor, rect };
    }
    return null;
  };

  // First wrapper whose bottom edge lies below the viewport top.
  let low = 0;
  let high = wrappers.length - 1;
  let first = wrappers.length;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const probe = probeForward(mid, high);
    if (!probe) {
      high = mid - 1;
      continue;
    }
    if (probe.rect.bottom > viewport.top) {
      first = probe.index;
      high = mid - 1;
    } else {
      low = probe.index + 1;
    }
  }

  const visible: Element[] = [];
  for (let index = first; index < wrappers.length; index += 1) {
    const rect = rectAt(index);
    if (!rect) continue;
    if (rect.top >= viewport.bottom) break;
    if (isRectVisibleInViewport(rect, viewport)) visible.push(wrappers[index]);
  }
  return { wrappers, visible };
}

function findBestVisibleChatAnchor(
  chatBox: HTMLDivElement,
): ChatScrollAnchor | undefined {
  const viewport = getElementRect(chatBox);
  if (!viewport) return undefined;

  const { wrappers, visible: visibleWrappers } = findVisibleMessageWrappers(
    chatBox,
    viewport,
  );
  // Quote cards live inside message wrappers; content without wrappers keeps
  // the chat-wide scan.
  const quoteScopes: Element[] = wrappers.length ? visibleWrappers : [chatBox];
  const quoteCandidates = quoteScopes.flatMap((scope) => [
    ...queryElements(scope, ".llm-quote-card"),
    ...queryElements(scope, "[data-citation-sync-key]"),
  ]);
  let bestQuote: {
    element: Element;
    anchor: ChatScrollAnchor;
    score: number;
  } | null = null;
  const seenQuoteCandidates = new Set<Element>();
  for (const candidate of quoteCandidates) {
    const quoteCard = closestElement(candidate, ".llm-quote-card") || candidate;
    if (seenQuoteCandidates.has(quoteCard)) continue;
    seenQuoteCandidates.add(quoteCard);
    const anchor = buildQuoteAnchor(candidate, viewport);
    if (!anchor) continue;
    const score = scoreVisibleAnchor(quoteCard, viewport);
    if (!bestQuote || score < bestQuote.score) {
      bestQuote = { element: quoteCard, anchor, score };
    }
  }
  if (bestQuote) return bestQuote.anchor;

  let bestMessage: { anchor: ChatScrollAnchor; score: number } | null = null;
  for (const candidate of visibleWrappers) {
    const anchor = buildMessageAnchor(candidate, viewport);
    if (!anchor) continue;
    const score = scoreVisibleAnchor(candidate, viewport);
    if (!bestMessage || score < bestMessage.score) {
      bestMessage = { anchor, score };
    }
  }
  return bestMessage?.anchor;
}

function findChatAnchorForElement(
  chatBox: HTMLDivElement,
  element: Element | null | undefined,
): ChatScrollAnchor | undefined {
  if (!element) return undefined;
  const viewport = getElementRect(chatBox);
  if (!viewport) return undefined;
  const quoteAnchor = buildQuoteAnchor(element, viewport);
  if (quoteAnchor) return quoteAnchor;
  const messageElement = closestElement(element, ".llm-message-wrapper");
  if (messageElement) {
    const messageAnchor = buildMessageAnchor(messageElement, viewport);
    if (messageAnchor) return messageAnchor;
  }
  return undefined;
}

function findMessageWrapperForAnchor(
  chatBox: HTMLDivElement,
  anchor: ChatScrollAnchor,
): Element | null {
  const wrappers = queryElements(chatBox, ".llm-message-wrapper");
  if (anchor.messageAnchorKey) {
    const keyed = wrappers.find(
      (element) =>
        datasetValue(element, "messageAnchorKey") === anchor.messageAnchorKey,
    );
    if (keyed) return keyed;
  }
  if (!anchor.messageRole || !anchor.messageTimestamp) return null;
  if (anchor.messageIndex) {
    const indexed = wrappers.find(
      (element) =>
        datasetValue(element, "messageRole") === anchor.messageRole &&
        datasetValue(element, "messageTimestamp") === anchor.messageTimestamp &&
        datasetValue(element, "messageIndex") === anchor.messageIndex,
    );
    if (indexed) return indexed;
  }
  return (
    wrappers.find(
      (element) =>
        datasetValue(element, "messageRole") === anchor.messageRole &&
        datasetValue(element, "messageTimestamp") === anchor.messageTimestamp,
    ) || null
  );
}

function findQuoteElementForAnchor(
  chatBox: HTMLDivElement,
  anchor: ChatScrollAnchor,
): Element | null {
  const messageScope = findMessageWrapperForAnchor(chatBox, anchor);
  const roots = messageScope ? [messageScope] : [chatBox];
  if (messageScope && anchor.quoteOrdinal !== undefined) {
    const card = queryElements(messageScope, ".llm-quote-card")[
      anchor.quoteOrdinal
    ];
    // Sync keys carry raw quote prose, so compare them in JS rather than
    // interpolating them into a selector.
    const sameQuote =
      card &&
      (anchor.quoteCitationId
        ? datasetValue(card, "quoteCitationId") === anchor.quoteCitationId
        : Boolean(anchor.citationSyncKey) &&
          queryElements(card, "[data-citation-sync-key]").some(
            (element) =>
              datasetValue(element, "citationSyncKey") ===
              anchor.citationSyncKey,
          ));
    if (sameQuote) return card;
  }
  if (anchor.quoteCitationId) {
    for (const root of roots) {
      const match = queryElements(root, ".llm-quote-card").find(
        (element) =>
          datasetValue(element, "quoteCitationId") === anchor.quoteCitationId,
      );
      if (match) return match;
    }
  }
  if (anchor.citationSyncKey) {
    for (const root of roots) {
      const match = queryElements(root, "[data-citation-sync-key]").find(
        (element) =>
          datasetValue(element, "citationSyncKey") === anchor.citationSyncKey,
      );
      if (match) return closestElement(match, ".llm-quote-card") || match;
    }
  }
  return null;
}

function findElementForAnchor(
  chatBox: HTMLDivElement,
  anchor: ChatScrollAnchor,
): Element | null {
  if (anchor.kind === "quote") {
    return findQuoteElementForAnchor(chatBox, anchor);
  }
  return findMessageWrapperForAnchor(chatBox, anchor);
}

function restoreChatScrollAnchor(
  chatBox: HTMLDivElement,
  anchor: ChatScrollAnchor | undefined,
): boolean {
  if (!anchor) return false;
  const target = findElementForAnchor(chatBox, anchor);
  if (!target) return false;
  const viewport = getElementRect(chatBox);
  const targetRect = getElementRect(target);
  if (!viewport || !targetRect) return false;
  const currentOffset = targetRect.top - viewport.top;
  const delta = currentOffset - anchor.viewportOffsetTop;
  chatBox.scrollTop = clampScrollTop(chatBox, chatBox.scrollTop + delta);
  return true;
}

export function buildChatScrollSnapshot(
  chatBox: HTMLDivElement,
  preferredAnchorElement?: Element | null,
): ChatScrollSnapshot {
  const mode: ChatScrollMode = preferredAnchorElement
    ? "manual"
    : isNearBottom(chatBox)
      ? "followBottom"
      : "manual";
  const anchor =
    mode === "manual"
      ? findChatAnchorForElement(chatBox, preferredAnchorElement) ||
        findBestVisibleChatAnchor(chatBox)
      : undefined;
  return {
    mode,
    scrollTop: clampScrollTop(chatBox, chatBox.scrollTop),
    updatedAt: Date.now(),
    anchor,
  };
}

export function buildAnchoredChatScrollSnapshot(
  chatBox: HTMLDivElement,
): ChatScrollSnapshot {
  return {
    mode: "manual",
    scrollTop: clampScrollTop(chatBox, chatBox.scrollTop),
    updatedAt: Date.now(),
    anchor: findBestVisibleChatAnchor(chatBox),
  };
}

/**
 * Follow-bottom is how the panel tracks an answer while it streams. Once the
 * answer has settled, the reader owns the viewport: if it is no longer at the
 * bottom — they scrolled, or opened something that grew the page — the intent
 * ends and the current view is anchored instead, so later content changes
 * (quote validation, diagrams finishing) keep their place rather than yanking
 * the reader to the bottom.
 */
export function settleFollowBottomIntent(
  conversationKey: number,
  chatBox: HTMLDivElement,
  options: { streaming: boolean },
): ChatScrollSnapshot | undefined {
  const normalized = normalizeConversationKey(conversationKey);
  if (!normalized) return undefined;
  const snapshot = getChatScrollSnapshot(normalized, chatBox);
  if (!snapshot || snapshot.mode !== "followBottom") return snapshot;
  if (options.streaming || isNearBottom(chatBox)) return snapshot;
  followBottomCatchupRequests.delete(normalized);
  const settled = buildAnchoredChatScrollSnapshot(chatBox);
  panelScrollSnapshots.set(chatBox, { key: normalized, snapshot: settled });
  chatScrollSnapshots.set(normalized, settled);
  return settled;
}

export function buildFollowBottomScrollSnapshot(
  chatBox: HTMLDivElement,
): ChatScrollSnapshot {
  return {
    mode: "followBottom",
    scrollTop: clampScrollTop(chatBox, chatBox.scrollHeight),
    updatedAt: Date.now(),
  };
}

export function hasActiveFollowBottomCatchupRequest(
  conversationKey: number,
): boolean {
  const normalized = normalizeConversationKey(conversationKey);
  if (!normalized) return false;
  const expiresAt = followBottomCatchupRequests.get(normalized);
  if (!expiresAt) return false;
  if (expiresAt > Date.now()) return true;
  followBottomCatchupRequests.delete(normalized);
  return false;
}

export function requestFollowBottomCatchup(conversationKey: number): void {
  const normalized = normalizeConversationKey(conversationKey);
  if (!normalized) return;
  followBottomCatchupRequests.set(
    normalized,
    Date.now() + FOLLOW_BOTTOM_CATCHUP_GRACE_MS,
  );
}

export function cancelFollowBottomCatchup(
  conversationKey: number,
  chatBox?: HTMLDivElement,
): void {
  const normalized = normalizeConversationKey(conversationKey);
  if (!normalized) return;
  followBottomCatchupRequests.delete(normalized);
  if (chatBox) {
    const snapshot: ChatScrollSnapshot = {
      mode: "manual",
      scrollTop: chatBox.scrollTop,
      updatedAt: Date.now(),
    };
    panelScrollSnapshots.set(chatBox, { key: normalized, snapshot });
    chatScrollSnapshots.set(normalized, snapshot);
  }
}

export function getChatScrollSnapshot(
  conversationKey: number,
  chatBox?: HTMLDivElement,
): ChatScrollSnapshot | undefined {
  const normalized = normalizeConversationKey(conversationKey);
  const local = chatBox && panelScrollSnapshots.get(chatBox);
  if (local && local.key === normalized) return local.snapshot;
  return normalized ? chatScrollSnapshots.get(normalized) : undefined;
}

export function setFollowBottomChatScrollSnapshot(
  conversationKey: number,
  chatBox: HTMLDivElement,
): void {
  const normalized = normalizeConversationKey(conversationKey);
  if (!normalized) return;
  pendingChatScrollRestores.delete(normalized);
  const snapshot = buildFollowBottomScrollSnapshot(chatBox);
  panelScrollSnapshots.set(chatBox, { key: normalized, snapshot });
  chatScrollSnapshots.set(normalized, snapshot);
}

export function persistChatScrollSnapshotForConversationKey(
  conversationKey: number,
  chatBox: HTMLDivElement,
): void {
  const normalized = normalizeConversationKey(conversationKey);
  if (!normalized) return;
  if (!isChatViewportVisible(chatBox)) return;
  const activeNavigation = activeChatNavigations.get(chatBox);
  if (activeNavigation?.conversationKey === normalized) return;
  const suppression = recentChatNavigationSuppressions.get(chatBox);
  if (
    suppression?.conversationKey === normalized &&
    suppression.expiresAt > Date.now()
  ) {
    return;
  }
  // Content can grow between an automatic scroll and its scroll event.
  // Persisting geometry must not cancel this panel's established follow intent;
  // user scrolling and explicit navigation cancel it through their owners.
  const previous = panelScrollSnapshots.get(chatBox);
  const snapshot =
    previous?.key === normalized && previous.snapshot.mode === "followBottom"
      ? buildFollowBottomScrollSnapshot(chatBox)
      : buildChatScrollSnapshot(chatBox);
  panelScrollSnapshots.set(chatBox, { key: normalized, snapshot });
  chatScrollSnapshots.set(normalized, snapshot);
}

function buildNavigationAnchor(
  targetElement: Element,
  viewportOffsetTop: number,
): ChatScrollAnchor | null {
  const wrapper = closestElement(targetElement, ".llm-message-wrapper");
  if (!wrapper) return null;
  const identity = getMessageAnchorForElement(wrapper);
  if (!identity.messageRole || !identity.messageTimestamp) return null;
  return {
    kind: "message",
    ...identity,
    viewportOffsetTop,
  };
}

function getNavigationTargetScrollTop(
  chatBox: HTMLDivElement,
  anchor: ChatScrollAnchor,
): number | null {
  const target = findElementForAnchor(chatBox, anchor);
  const viewport = getElementRect(chatBox);
  const targetRect = target ? getElementRect(target) : null;
  if (!target || !viewport || !targetRect) return null;
  return clampScrollTop(
    chatBox,
    chatBox.scrollTop +
      targetRect.top -
      viewport.top -
      anchor.viewportOffsetTop,
  );
}

function getNavigationWindow(chatBox: HTMLDivElement): Window | null {
  return chatBox.ownerDocument?.defaultView || null;
}

function requestNavigationFrame(
  chatBox: HTMLDivElement,
  callback: FrameRequestCallback,
): number {
  const win = getNavigationWindow(chatBox);
  if (win?.requestAnimationFrame) return win.requestAnimationFrame(callback);
  return Number(setTimeout(() => callback(Date.now()), 16));
}

function cancelNavigationFrame(
  chatBox: HTMLDivElement,
  frameId: number | null,
): void {
  if (frameId === null) return;
  const win = getNavigationWindow(chatBox);
  if (win?.cancelAnimationFrame) {
    win.cancelAnimationFrame(frameId);
  } else {
    clearTimeout(frameId);
  }
}

function clearNavigationTimeout(
  chatBox: HTMLDivElement,
  timeoutId: number | null,
): void {
  if (timeoutId === null) return;
  const win = getNavigationWindow(chatBox);
  if (win) win.clearTimeout(timeoutId);
  else clearTimeout(timeoutId);
}

function setNavigationTimeout(
  chatBox: HTMLDivElement,
  callback: () => void,
  delayMs: number,
): number {
  const win = getNavigationWindow(chatBox);
  return win
    ? win.setTimeout(callback, delayMs)
    : Number(setTimeout(callback, delayMs));
}

function cleanupActiveNavigation(navigation: ActiveChatNavigation): void {
  cancelNavigationFrame(navigation.chatBox, navigation.rafId);
  clearNavigationTimeout(navigation.chatBox, navigation.timeoutId);
  navigation.rafId = null;
  navigation.timeoutId = null;
  navigation.removeInputListeners();
  if (activeChatNavigations.get(navigation.chatBox) === navigation) {
    activeChatNavigations.delete(navigation.chatBox);
  }
  liveNavigationBoxes.delete(navigation.chatBox);
}

function clearRecentNavigationSuppression(chatBox: HTMLDivElement): void {
  const suppression = recentChatNavigationSuppressions.get(chatBox);
  if (!suppression) return;
  clearNavigationTimeout(chatBox, suppression.timeoutId);
  suppression.removeInputListeners();
  recentChatNavigationSuppressions.delete(chatBox);
  liveNavigationSuppressionBoxes.delete(chatBox);
}

function startRecentNavigationSuppression(
  chatBox: HTMLDivElement,
  conversationKey: number,
): void {
  clearRecentNavigationSuppression(chatBox);
  const clear = () => {
    if (recentChatNavigationSuppressions.get(chatBox) === suppression) {
      clearRecentNavigationSuppression(chatBox);
    }
  };
  const suppression: RecentChatNavigationSuppression = {
    conversationKey,
    expiresAt: Date.now() + NAVIGATION_SCROLL_EVENT_GRACE_MS,
    timeoutId: 0,
    removeInputListeners: installNavigationInputCancellation(chatBox, clear),
  };
  suppression.timeoutId = setNavigationTimeout(
    chatBox,
    clear,
    NAVIGATION_SCROLL_EVENT_GRACE_MS,
  );
  recentChatNavigationSuppressions.set(chatBox, suppression);
  liveNavigationSuppressionBoxes.add(chatBox);
}

function persistNavigationDestination(navigation: ActiveChatNavigation): void {
  const targetScrollTop = getNavigationTargetScrollTop(
    navigation.chatBox,
    navigation.anchor,
  );
  if (targetScrollTop !== null) {
    navigation.chatBox.scrollTop = targetScrollTop;
  }
  const finalSnapshot: ChatScrollSnapshot = {
    mode: "manual",
    scrollTop: clampScrollTop(
      navigation.chatBox,
      targetScrollTop ?? navigation.chatBox.scrollTop,
    ),
    updatedAt: Date.now(),
    anchor: navigation.anchor,
  };
  panelScrollSnapshots.set(navigation.chatBox, {
    key: navigation.conversationKey,
    snapshot: finalSnapshot,
  });
  chatScrollSnapshots.set(navigation.conversationKey, finalSnapshot);
  cleanupActiveNavigation(navigation);
  startRecentNavigationSuppression(
    navigation.chatBox,
    navigation.conversationKey,
  );
}

function installNavigationInputCancellation(
  chatBox: HTMLDivElement,
  cancel: () => void,
): () => void {
  const inputTarget =
    typeof chatBox.ownerDocument?.addEventListener === "function"
      ? chatBox.ownerDocument
      : chatBox;
  const scrollingKeys = new Set([
    "ArrowUp",
    "ArrowDown",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    " ",
  ]);
  const onPointerInput = () => cancel();
  const onKeyDown = (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (scrollingKeys.has(key)) cancel();
  };
  inputTarget.addEventListener("wheel", onPointerInput, true);
  inputTarget.addEventListener("pointerdown", onPointerInput, true);
  inputTarget.addEventListener("touchstart", onPointerInput, true);
  inputTarget.addEventListener("keydown", onKeyDown, true);
  return () => {
    inputTarget.removeEventListener("wheel", onPointerInput, true);
    inputTarget.removeEventListener("pointerdown", onPointerInput, true);
    inputTarget.removeEventListener("touchstart", onPointerInput, true);
    inputTarget.removeEventListener("keydown", onKeyDown, true);
  };
}

export function getActiveChatNavigationSnapshot(
  chatBox: HTMLDivElement,
): ChatScrollSnapshot | undefined {
  return activeChatNavigations.get(chatBox)?.snapshot;
}

export function isChatNavigationActive(chatBox: HTMLDivElement): boolean {
  if (activeChatNavigations.has(chatBox)) return true;
  const suppression = recentChatNavigationSuppressions.get(chatBox);
  if (!suppression) return false;
  if (suppression.expiresAt > Date.now()) return true;
  clearRecentNavigationSuppression(chatBox);
  return false;
}

export function cancelChatNavigation(
  chatBox: HTMLDivElement,
  persistCurrentPosition = true,
): void {
  clearRecentNavigationSuppression(chatBox);
  const navigation = activeChatNavigations.get(chatBox);
  if (!navigation) return;
  cleanupActiveNavigation(navigation);
  if (persistCurrentPosition && isChatViewportVisible(chatBox)) {
    chatScrollSnapshots.set(
      navigation.conversationKey,
      buildChatScrollSnapshot(chatBox),
    );
  }
}

export function navigateChatToMessage(params: {
  conversationKey: number;
  chatBox: HTMLDivElement;
  targetElement: Element;
  behavior: ScrollBehavior;
  viewportOffsetTop?: number;
}): boolean {
  const conversationKey = normalizeConversationKey(params.conversationKey);
  if (!conversationKey || !isChatViewportVisible(params.chatBox)) return false;
  const viewportOffsetTop = Math.max(0, Number(params.viewportOffsetTop || 0));
  const anchor = buildNavigationAnchor(params.targetElement, viewportOffsetTop);
  if (!anchor) return false;
  const targetScrollTop = getNavigationTargetScrollTop(params.chatBox, anchor);
  if (targetScrollTop === null) return false;

  cancelChatNavigation(params.chatBox, false);
  cancelFollowBottomCatchup(conversationKey, params.chatBox);
  const snapshot: ChatScrollSnapshot = {
    mode: "manual",
    scrollTop: targetScrollTop,
    updatedAt: Date.now(),
    anchor,
  };
  panelScrollSnapshots.set(params.chatBox, { key: conversationKey, snapshot });
  chatScrollSnapshots.set(conversationKey, snapshot);

  const cancelFromInput = () => cancelChatNavigation(params.chatBox, true);
  const navigation: ActiveChatNavigation = {
    conversationKey,
    chatBox: params.chatBox,
    snapshot,
    anchor,
    stableFrames: 0,
    rafId: null,
    timeoutId: null,
    removeInputListeners: installNavigationInputCancellation(
      params.chatBox,
      cancelFromInput,
    ),
  };
  activeChatNavigations.set(params.chatBox, navigation);
  liveNavigationBoxes.add(params.chatBox);

  const finish = () => {
    if (activeChatNavigations.get(params.chatBox) !== navigation) return;
    persistNavigationDestination(navigation);
  };
  if (params.behavior !== "smooth") {
    params.chatBox.scrollTop = targetScrollTop;
    finish();
    return true;
  }

  const settle = () => {
    if (activeChatNavigations.get(params.chatBox) !== navigation) return;
    const currentTarget = getNavigationTargetScrollTop(
      params.chatBox,
      navigation.anchor,
    );
    if (
      currentTarget !== null &&
      Math.abs(params.chatBox.scrollTop - currentTarget) <=
        NAVIGATION_SETTLE_TOLERANCE_PX
    ) {
      navigation.stableFrames += 1;
    } else {
      navigation.stableFrames = 0;
    }
    if (navigation.stableFrames >= NAVIGATION_SETTLE_FRAMES) {
      finish();
      return;
    }
    navigation.rafId = requestNavigationFrame(params.chatBox, settle);
  };

  try {
    params.chatBox.scrollTo({ top: targetScrollTop, behavior: "smooth" });
  } catch (_err) {
    params.chatBox.scrollTop = targetScrollTop;
  }
  navigation.timeoutId = setNavigationTimeout(
    params.chatBox,
    finish,
    NAVIGATION_TIMEOUT_MS,
  );
  navigation.rafId = requestNavigationFrame(params.chatBox, settle);
  return true;
}

export function persistPendingChatScrollRestoreForConversationKey(
  conversationKey: number,
  chatBox: HTMLDivElement,
  preferredAnchorElement?: Element | null,
): void {
  const normalized = normalizeConversationKey(conversationKey);
  if (!normalized) return;
  if (!isChatViewportVisible(chatBox)) return;
  const snapshot = buildChatScrollSnapshot(chatBox, preferredAnchorElement);
  chatScrollSnapshots.set(normalized, snapshot);
  panelScrollSnapshots.set(chatBox, { key: normalized, snapshot });
  pendingChatScrollRestores.set(normalized, {
    snapshot,
    expiresAt: Date.now() + PENDING_RESTORE_TTL_MS,
    appliedBodies: new WeakSet<Element>(),
  });
}

export function persistChatScrollSnapshotFromBody(body: Element): void {
  const root = body.querySelector("#llm-main") as HTMLElement | null;
  const conversationKey = normalizeConversationKey(
    Number(root?.dataset?.itemId || 0),
  );
  if (!conversationKey) return;
  const chatBox = body.querySelector("#llm-chat-box") as HTMLDivElement | null;
  if (!chatBox || !chatBox.childElementCount) return;
  persistChatScrollSnapshotForConversationKey(conversationKey, chatBox);
}

export function persistPendingChatScrollRestoreFromBody(body: Element): void {
  const root = body.querySelector("#llm-main") as HTMLElement | null;
  const conversationKey = normalizeConversationKey(
    Number(root?.dataset?.itemId || 0),
  );
  if (!conversationKey) return;
  const chatBox = body.querySelector("#llm-chat-box") as HTMLDivElement | null;
  if (!chatBox || !chatBox.childElementCount) return;
  persistPendingChatScrollRestoreForConversationKey(conversationKey, chatBox);
}

export function persistPendingChatScrollRestoreForElement(
  body: Element,
  targetElement: Element | null | undefined,
): void {
  const root = body.querySelector("#llm-main") as HTMLElement | null;
  const conversationKey = normalizeConversationKey(
    Number(root?.dataset?.itemId || 0),
  );
  if (!conversationKey) return;
  const chatBox = body.querySelector("#llm-chat-box") as HTMLDivElement | null;
  if (!chatBox || !chatBox.childElementCount) return;
  persistPendingChatScrollRestoreForConversationKey(
    conversationKey,
    chatBox,
    targetElement,
  );
}

export function consumePendingChatScrollRestore(
  conversationKey: number,
  body?: Element | null,
): ChatScrollSnapshot | undefined {
  const normalized = normalizeConversationKey(conversationKey);
  if (!normalized) return undefined;
  const pending = pendingChatScrollRestores.get(normalized);
  if (!pending) return undefined;
  if (pending.expiresAt < Date.now()) {
    pendingChatScrollRestores.delete(normalized);
    return undefined;
  }
  if (body) {
    if (pending.appliedBodies.has(body)) return undefined;
    pending.appliedBodies.add(body);
  }
  return pending.snapshot;
}

export const consumePendingChatScrollRestoreForTests =
  consumePendingChatScrollRestore;

export function applyChatScrollSnapshot(
  chatBox: HTMLDivElement,
  snapshot: ChatScrollSnapshot,
): void {
  suspendChatScrollUpdates(chatBox);
  if (snapshot.mode === "followBottom") {
    chatBox.scrollTop = chatBox.scrollHeight;
  } else if (!restoreChatScrollAnchor(chatBox, snapshot.anchor)) {
    chatBox.scrollTop = clampScrollTop(chatBox, snapshot.scrollTop);
  }
}

export function restoreChatScrollSnapshotForConversationKey(
  conversationKey: number,
  chatBox: HTMLDivElement,
): boolean {
  const snapshot = getChatScrollSnapshot(conversationKey);
  if (!snapshot) return false;
  applyChatScrollSnapshot(chatBox, snapshot);
  persistChatScrollSnapshotForConversationKey(conversationKey, chatBox);
  return true;
}

export function withScrollGuard(
  chatBox: HTMLDivElement | null,
  conversationKey: number | null,
  fn: () => void,
  restoreMode: ScrollGuardRestoreMode = "absolute",
): void {
  if (!chatBox || conversationKey === null) {
    fn();
    return;
  }
  const wasNearBottom = isNearBottom(chatBox);
  const savedScrollTop = chatBox.scrollTop;
  const savedMaxScrollTop = getMaxScrollTop(chatBox);
  const anchoredSnapshot =
    restoreMode === "anchor" ? buildAnchoredChatScrollSnapshot(chatBox) : null;

  suspendChatScrollUpdates(chatBox);
  try {
    fn();
  } finally {
    if (anchoredSnapshot) {
      applyChatScrollSnapshot(chatBox, anchoredSnapshot);
    } else if (wasNearBottom) {
      chatBox.scrollTop = chatBox.scrollHeight;
    } else if (restoreMode === "relative" && savedMaxScrollTop > 0) {
      const nextMaxScrollTop = getMaxScrollTop(chatBox);
      const progress = Math.min(
        1,
        Math.max(0, savedScrollTop / savedMaxScrollTop),
      );
      chatBox.scrollTop = Math.round(nextMaxScrollTop * progress);
    } else {
      chatBox.scrollTop = savedScrollTop;
    }
    persistChatScrollSnapshotForConversationKey(conversationKey, chatBox);
  }
}

export function clearChatScrollSnapshotsForTests(): void {
  for (const chatBox of liveNavigationBoxes) {
    cancelChatNavigation(chatBox, false);
  }
  liveNavigationBoxes.clear();
  for (const chatBox of liveNavigationSuppressionBoxes) {
    clearRecentNavigationSuppression(chatBox);
  }
  liveNavigationSuppressionBoxes.clear();
  chatScrollSnapshots.clear();
  pendingChatScrollRestores.clear();
  followBottomCatchupRequests.clear();
  activeChatNavigations = new WeakMap<HTMLDivElement, ActiveChatNavigation>();
  recentChatNavigationSuppressions = new WeakMap<
    HTMLDivElement,
    RecentChatNavigationSuppression
  >();
  panelScrollSnapshots = new WeakMap();
  suspendedScrollBoxes = new WeakMap();
  suspendedScrollCount = 0;
}
