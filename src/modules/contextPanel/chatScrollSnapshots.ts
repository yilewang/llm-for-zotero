import { AUTO_SCROLL_BOTTOM_THRESHOLD } from "./constants";
import {
  type ChatScrollAnchor,
  closestElement,
  getElementRect,
  getMessageAnchorForElement,
  findBestVisibleChatAnchor,
  findChatAnchorForElement,
  findElementForAnchor,
} from "./chatScrollGeometry";
import { createCoalescedFrameScheduler } from "./setupHandlers/controllers/uiSchedulingController";

type ChatScrollMode = "followBottom" | "manual";

export interface ChatScrollSnapshot {
  mode: ChatScrollMode;
  scrollTop: number;
  updatedAt: number;
  anchor?: ChatScrollAnchor;
}

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
const PENDING_RESTORE_TTL_MS = 3000;
const NAVIGATION_SETTLE_TOLERANCE_PX = 1;
const NAVIGATION_SETTLE_FRAMES = 2;
const NAVIGATION_TIMEOUT_MS = 1200;

let activeChatNavigations = new WeakMap<HTMLDivElement, ActiveChatNavigation>();
const liveNavigationBoxes = new Set<HTMLDivElement>();

type ViewportPosition = { top: number; max: number };
let viewportPositions = new WeakMap<HTMLDivElement, ViewportPosition>();
const reconciliationStates = new WeakMap<
  HTMLDivElement,
  {
    key: number;
    scheduler: ReturnType<typeof createCoalescedFrameScheduler>;
  }
>();
const liveReconciliationBoxes = new Set<HTMLDivElement>();

function captureViewportPosition(chatBox: HTMLDivElement): void {
  viewportPositions.set(chatBox, {
    top: chatBox.scrollTop,
    max: getMaxScrollTop(chatBox),
  });
}

/** All immediate chat viewport writes pass here, including restoration. */
export function writeChatScrollTop(chatBox: HTMLDivElement, top: number): void {
  const target = clampScrollTop(chatBox, top);
  if (chatBox.scrollTop !== target) chatBox.scrollTop = target;
  // Scroll events are asynchronous and coalesced. Record the applied position
  // now; a later scrollbar drag must be compared with this write, not an event.
  captureViewportPosition(chatBox);
}

export function initializeChatScrollViewport(
  key: number,
  chatBox: HTMLDivElement,
): void {
  const local = panelScrollSnapshots.get(chatBox);
  if (local?.key === key && viewportPositions.has(chatBox)) return;
  disposeChatScrollViewport(chatBox);
  captureViewportPosition(chatBox);
  // A reused shell can still contain the previous conversation while loading.
  // Restore the new conversation's saved intent, never seed it from that DOM.
  const snapshot =
    local?.key === key
      ? local.snapshot
      : chatScrollSnapshots.get(key) ||
        (local
          ? buildFollowBottomScrollSnapshot(chatBox)
          : buildChatScrollSnapshot(chatBox));
  panelScrollSnapshots.set(chatBox, { key, snapshot });
  chatScrollSnapshots.set(key, snapshot);
}

export function cancelChatScrollReconciliation(chatBox: HTMLDivElement): void {
  reconciliationStates.get(chatBox)?.scheduler.cancel();
}

export function disposeChatScrollViewport(chatBox: HTMLDivElement): void {
  cancelChatScrollReconciliation(chatBox);
  reconciliationStates.delete(chatBox);
  liveReconciliationBoxes.delete(chatBox);
  cancelChatNavigation(chatBox, false);
  viewportPositions.delete(chatBox);
}

/** Geometry persistence never changes intent; only an observed user move does. */
export function observeChatScroll(key: number, chatBox: HTMLDivElement): void {
  if (!isCurrentChatViewport(key, chatBox) || !isChatViewportVisible(chatBox))
    return;
  const previous = viewportPositions.get(chatBox);
  if (isChatNavigationActive(chatBox)) {
    captureViewportPosition(chatBox);
    return;
  }
  if (previous) {
    const delta = chatBox.scrollTop - previous.top;
    const max = getMaxScrollTop(chatBox);
    const clampedByLayout =
      max < previous.max &&
      previous.top > max &&
      Math.abs(chatBox.scrollTop - max) <= 1;
    if (delta !== 0 && !clampedByLayout) {
      if (delta > 0 && isNearBottom(chatBox)) {
        setFollowBottomChatScrollSnapshot(key, chatBox);
      } else {
        cancelChatScrollFollow(key, chatBox);
      }
      persistChatScrollSnapshotForConversationKey(key, chatBox);
    }
  } else {
    persistChatScrollSnapshotForConversationKey(key, chatBox);
  }
  captureViewportPosition(chatBox);
}

function isCurrentChatViewport(key: number, chatBox: HTMLDivElement): boolean {
  if (!chatBox.isConnected) return false;
  const root = closestElement(chatBox, "#llm-main") as HTMLElement | null;
  return !root || Number(root.dataset.itemId) === key;
}

export function reconcileChatScroll(
  key: number,
  chatBox: HTMLDivElement,
): void {
  if (!isCurrentChatViewport(key, chatBox) || !isChatViewportVisible(chatBox))
    return;
  // User input can precede its scroll event or this queued layout callback.
  observeChatScroll(key, chatBox);
  if (isChatNavigationActive(chatBox)) return;
  const snapshot = getChatScrollSnapshot(key, chatBox);
  if (!snapshot) return;
  applyChatScrollSnapshot(chatBox, snapshot);
  persistChatScrollSnapshotForConversationKey(key, chatBox);
}

/** One pending layout reconciliation per mounted viewport; read intent at execution. */
export function scheduleChatScrollReconciliation(
  key: number,
  chatBox: HTMLDivElement,
): void {
  if (!isCurrentChatViewport(key, chatBox)) return;
  let state = reconciliationStates.get(chatBox);
  if (state?.key !== key) {
    cancelChatScrollReconciliation(chatBox);
    const next = {
      key,
      scheduler: createCoalescedFrameScheduler({
        getWindow: () => chatBox.ownerDocument?.defaultView,
        run: () => {
          if (reconciliationStates.get(chatBox) === next)
            reconcileChatScroll(key, chatBox);
        },
      }),
    };
    reconciliationStates.set(chatBox, next);
    liveReconciliationBoxes.add(chatBox);
    state = next;
  }
  state.scheduler.schedule();
}

export function scheduleChatContentScroll(target: Element): void {
  const box = closestElement(target, "#llm-chat-box") as HTMLDivElement | null;
  if (!box) return;
  const root = closestElement(box, "#llm-main") as HTMLElement | null;
  const key =
    Number(root?.dataset.itemId) || panelScrollSnapshots.get(box)?.key;
  if (key) scheduleChatScrollReconciliation(key, box);
}

/** Guard the actual mutation, including work deferred to a renderer's frame. */
export function withChatContentScrollGuard(
  target: Element,
  mutate: () => void,
): void {
  const box = closestElement(target, "#llm-chat-box") as HTMLDivElement | null;
  const root = box && (closestElement(box, "#llm-main") as HTMLElement | null);
  const key =
    Number(root?.dataset.itemId) || (box && panelScrollSnapshots.get(box)?.key);
  withScrollGuard(box, key || null, mutate);
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
  // At Windows display scaling, the compositor can finish a wheel gesture a
  // fraction of a CSS pixel after its last scroll event. Do not turn that
  // harmless difference into an integer scroll write that moves the text.
  if (Math.abs(delta) <= 1) return true;
  // Gecko truncates fractional scrollTop writes even when layout has subpixel
  // coordinates (e.g. Windows display scaling). Round once so repeated guards
  // do not keep biasing the restored reading position upwards.
  writeChatScrollTop(chatBox, Math.round(chatBox.scrollTop + delta));
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

export function buildFollowBottomScrollSnapshot(
  chatBox: HTMLDivElement,
): ChatScrollSnapshot {
  return {
    mode: "followBottom",
    scrollTop: clampScrollTop(chatBox, chatBox.scrollHeight),
    updatedAt: Date.now(),
  };
}

export function cancelChatScrollFollow(
  conversationKey: number,
  chatBox?: HTMLDivElement,
): void {
  const normalized = normalizeConversationKey(conversationKey);
  if (!normalized) return;
  pendingChatScrollRestores.delete(normalized);
  if (chatBox) {
    cancelChatScrollReconciliation(chatBox);
    const snapshot = buildAnchoredChatScrollSnapshot(chatBox);
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
  cancelChatNavigation(chatBox, false);
  captureViewportPosition(chatBox);
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
  // Snapshot persistence records geometry, never user intent. Both manual and
  // follow modes survive content growth, collapse, and delayed scroll events.
  const previous = panelScrollSnapshots.get(chatBox);
  const snapshot =
    previous?.key === normalized
      ? previous.snapshot.mode === "followBottom"
        ? buildFollowBottomScrollSnapshot(chatBox)
        : buildAnchoredChatScrollSnapshot(chatBox)
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

function persistNavigationDestination(navigation: ActiveChatNavigation): void {
  const targetScrollTop = getNavigationTargetScrollTop(
    navigation.chatBox,
    navigation.anchor,
  );
  if (targetScrollTop !== null) {
    writeChatScrollTop(navigation.chatBox, targetScrollTop);
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
}

function installNavigationInputCancellation(
  chatBox: HTMLDivElement,
  cancel: () => void,
): () => void {
  const inputTarget = chatBox;
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
  return activeChatNavigations.has(chatBox);
}

export function cancelChatNavigation(
  chatBox: HTMLDivElement,
  persistCurrentPosition = true,
): void {
  const navigation = activeChatNavigations.get(chatBox);
  if (!navigation) return;
  cleanupActiveNavigation(navigation);
  // Stop a native smooth animation as well as our destination-settle loop.
  try {
    chatBox.scrollTo({ top: chatBox.scrollTop, behavior: "instant" });
  } catch {
    /* older/fake DOM */
  }
  captureViewportPosition(chatBox);
  if (persistCurrentPosition && isChatViewportVisible(chatBox)) {
    const snapshot = buildAnchoredChatScrollSnapshot(chatBox);
    panelScrollSnapshots.set(chatBox, {
      key: navigation.conversationKey,
      snapshot,
    });
    chatScrollSnapshots.set(navigation.conversationKey, snapshot);
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
  cancelChatScrollFollow(conversationKey, params.chatBox);
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
    writeChatScrollTop(params.chatBox, targetScrollTop);
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
    writeChatScrollTop(params.chatBox, targetScrollTop);
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

/** The same precedence applies to full redraws and targeted renderer fallback. */
export function captureChatScrollForRender(
  key: number,
  chatBox: HTMLDivElement,
  body?: Element,
): ChatScrollSnapshot {
  initializeChatScrollViewport(key, chatBox);
  observeChatScroll(key, chatBox);
  return (
    getActiveChatNavigationSnapshot(chatBox) ||
    consumePendingChatScrollRestore(key, body) ||
    getChatScrollSnapshot(key, chatBox) ||
    buildChatScrollSnapshot(chatBox)
  );
}

export function restoreChatScrollAfterRender(
  key: number,
  chatBox: HTMLDivElement,
  snapshot: ChatScrollSnapshot,
): void {
  applyChatScrollSnapshot(chatBox, snapshot);
  panelScrollSnapshots.set(chatBox, { key, snapshot });
  persistChatScrollSnapshotForConversationKey(key, chatBox);
  scheduleChatScrollReconciliation(key, chatBox);
}

export function applyChatScrollSnapshot(
  chatBox: HTMLDivElement,
  snapshot: ChatScrollSnapshot,
): void {
  if (snapshot.mode === "followBottom") {
    writeChatScrollTop(chatBox, chatBox.scrollHeight);
  } else if (!restoreChatScrollAnchor(chatBox, snapshot.anchor)) {
    writeChatScrollTop(chatBox, snapshot.scrollTop);
  }
}

export function restoreChatScrollSnapshotForConversationKey(
  conversationKey: number,
  chatBox: HTMLDivElement,
): boolean {
  const snapshot = getChatScrollSnapshot(conversationKey, chatBox);
  if (!snapshot) return false;
  applyChatScrollSnapshot(chatBox, snapshot);
  persistChatScrollSnapshotForConversationKey(conversationKey, chatBox);
  return true;
}

export function withScrollGuard(
  chatBox: HTMLDivElement | null,
  conversationKey: number | null,
  fn: () => void,
): void {
  if (!chatBox || conversationKey === null) {
    fn();
    return;
  }
  if (isChatNavigationActive(chatBox)) {
    fn();
    return;
  }
  observeChatScroll(conversationKey, chatBox);
  const snapshot =
    getChatScrollSnapshot(conversationKey, chatBox) ||
    buildChatScrollSnapshot(chatBox);
  try {
    fn();
  } finally {
    applyChatScrollSnapshot(chatBox, snapshot);
    // Save the chosen intent as well as its new geometry, including first mount.
    panelScrollSnapshots.set(chatBox, { key: conversationKey, snapshot });
    persistChatScrollSnapshotForConversationKey(conversationKey, chatBox);
  }
}

export function clearChatScrollSnapshotsForTests(): void {
  for (const chatBox of liveNavigationBoxes) {
    cancelChatNavigation(chatBox, false);
  }
  liveNavigationBoxes.clear();
  chatScrollSnapshots.clear();
  pendingChatScrollRestores.clear();
  activeChatNavigations = new WeakMap<HTMLDivElement, ActiveChatNavigation>();
  panelScrollSnapshots = new WeakMap();
  viewportPositions = new WeakMap();
  for (const box of liveReconciliationBoxes) disposeChatScrollViewport(box);
}
