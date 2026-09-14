import { t } from "../../utils/i18n";
import { stripWebSourceMarkersForDisplay } from "../../webAccess/attribution";
import { stripQuoteCitationAnchorsFromDisplayText } from "./quoteCitations";
import { getMessageQuoteDisplay } from "./quoteRenderPlan";
import {
  cancelChatNavigation,
  navigateChatToMessage,
  withScrollGuard,
} from "./chatScrollSnapshots";
import { sanitizeText } from "./textUtils";
import type { Message } from "./types";

export const SIDEBAR_TURN_NAVIGATOR_MIN_WIDTH_PX = 400;
export const STANDALONE_TURN_NAVIGATOR_MIN_WIDTH_PX = 540;
const CONVERSATION_TURN_NAVIGATOR_OVERFLOW_TOLERANCE_PX = 1;
const RAIL_BROWSE_IDLE_MS = 750;
const PREVIEW_TEXT_MAX_LENGTH = 600;

export type ConversationTurnProjection = {
  key: string;
  userKey: string;
  assistantKey?: string;
  userMessageIndex: number;
  assistantMessageIndex?: number;
  queryText: string;
  answerText: string;
  answerStatus?: string;
};

export type SyncConversationTurnNavigatorOptions = {
  targetedMessages?: ReadonlySet<Message>;
  conversationKey?: number | null;
};

type DirtyFlags = {
  reconcile: boolean;
  geometry: boolean;
  active: boolean;
  eligibility: boolean;
};

type ConversationTurnNavigatorController = {
  updateAssistant: (message: Message) => void;
  sync: (
    messages: readonly Message[],
    options?: SyncConversationTurnNavigatorOptions,
  ) => void;
  dispose: () => void;
};

type MarkerRecord = {
  button: HTMLButtonElement;
  dash: HTMLSpanElement;
};

let navigatorSequence = 0;
const controllers = new WeakMap<Element, ConversationTurnNavigatorController>();

function formatTemplate(
  template: string,
  replacements: Record<string, string | number>,
): string {
  let output = t(template);
  for (const [key, value] of Object.entries(replacements)) {
    output = output.replaceAll(`{${key}}`, String(value));
  }
  return output;
}

function truncatePreviewText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= PREVIEW_TEXT_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, PREVIEW_TEXT_MAX_LENGTH - 1).trimEnd()}…`;
}

function projectMarkdownToPlainText(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  return truncatePreviewText(
    stripQuoteCitationAnchorsFromDisplayText(
      stripWebSourceMarkersForDisplay(sanitizeText(value)),
    )
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}(?:#{1,6}|>|[-+*])\s+/gm, "")
      .replace(/^\s{0,3}\d+[.)]\s+/gm, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/```|~~~/g, " ")
      .replace(/[*_~`]+/g, " "),
  );
}

function hasQueryContext(message: Message): boolean {
  return [
    message.attachments,
    message.modelAttachments,
    message.screenshotImages,
    message.paperContexts,
    message.pdfPaperContexts,
    message.fullTextPaperContexts,
    message.selectedTexts,
    message.selectedTextContexts,
    message.selectedCollectionContexts,
    message.selectedTagContexts,
  ].some((value) => Array.isArray(value) && value.length > 0);
}

function projectQueryPreview(message: Message): string {
  const text = projectMarkdownToPlainText(message.text);
  if (text) return text;
  return hasQueryContext(message)
    ? t("Query with attached content")
    : t("Empty query");
}

function projectAnswerPreview(message: Message | undefined): {
  text: string;
  status?: string;
} {
  if (!message) return { text: t("No answer yet") };
  const display = getMessageQuoteDisplay(message);
  const text = projectMarkdownToPlainText(display.markdown);
  const status = message.interrupted
    ? t("Interrupted response")
    : message.streaming
      ? t("Answer in progress")
      : undefined;
  if (text) return { text, status };
  if (
    Array.isArray(message.generatedImages) &&
    message.generatedImages.length
  ) {
    return { text: t("Generated image response"), status };
  }
  if (message.streaming) return { text: t("Answer in progress"), status };
  if (message.interrupted) return { text: t("Interrupted response"), status };
  return { text: t("Response contains no text") };
}

function isTurnMarkerMessage(message: Message): boolean {
  return Boolean(
    message.compactMarker ||
    message.runtimeMarkerText ||
    message.modelSwitchMarkerText,
  );
}

export function getConversationMessageAnchorKey(
  message: Message,
  renderedIndex: number,
): string {
  const id = Math.floor(Number(message.id || 0));
  if (Number.isFinite(id) && id > 0) return `id:${id}`;
  const timestamp = Math.floor(Number(message.timestamp || 0));
  return `${message.role}:${Number.isFinite(timestamp) ? timestamp : 0}:${renderedIndex}`;
}

export function buildConversationTurnProjection(
  messages: readonly Message[],
): ConversationTurnProjection[] {
  const turns: ConversationTurnProjection[] = [];
  for (let userIndex = 0; userIndex < messages.length; userIndex += 1) {
    const userMessage = messages[userIndex];
    if (userMessage?.role !== "user") continue;
    let assistantIndex: number | undefined;
    for (
      let candidateIndex = userIndex + 1;
      candidateIndex < messages.length;
      candidateIndex += 1
    ) {
      const candidate = messages[candidateIndex];
      if (!candidate || candidate.role === "user") break;
      if (candidate.role === "assistant" && !isTurnMarkerMessage(candidate)) {
        assistantIndex = candidateIndex;
        break;
      }
    }
    const assistantMessage =
      assistantIndex === undefined ? undefined : messages[assistantIndex];
    const userKey = getConversationMessageAnchorKey(userMessage, userIndex);
    const answer = projectAnswerPreview(assistantMessage);
    turns.push({
      key: userKey,
      userKey,
      assistantKey:
        assistantIndex === undefined || !assistantMessage
          ? undefined
          : getConversationMessageAnchorKey(assistantMessage, assistantIndex),
      userMessageIndex: userIndex,
      assistantMessageIndex: assistantIndex,
      queryText: projectQueryPreview(userMessage),
      answerText: answer.text,
      answerStatus: answer.status,
    });
  }
  return turns;
}

export function getConversationTurnDashWidth(queryText: string): number {
  const length = Array.from(queryText.trim()).length;
  if (length <= 40) return 7;
  if (length <= 120) return 9;
  if (length <= 240) return 11;
  return 13;
}

export function isConversationTurnNavigatorEligible(params: {
  shellWidth: number;
  scrollHeight: number;
  clientHeight: number;
  turnCount: number;
  minimumWidthPx: number;
}): boolean {
  return (
    params.shellWidth >= params.minimumWidthPx &&
    params.turnCount >= 2 &&
    params.clientHeight > 0 &&
    params.scrollHeight - params.clientHeight >
      CONVERSATION_TURN_NAVIGATOR_OVERFLOW_TOLERANCE_PX
  );
}

export function findActiveConversationTurnIndex(
  turnStarts: readonly number[],
  viewportCenter: number,
): number {
  if (!turnStarts.length) return -1;
  let low = 0;
  let high = turnStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (turnStarts[middle] <= viewportCenter) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, Math.min(turnStarts.length - 1, low - 1));
}

function elementFromEventTarget(target: EventTarget | null): Element | null {
  return target && (target as Element).nodeType === 1
    ? (target as Element)
    : null;
}

function markerButtonFromTarget(
  target: EventTarget | null,
): HTMLButtonElement | null {
  const element = elementFromEventTarget(target);
  return (element?.closest?.(".llm-turn-navigator-marker") ||
    null) as HTMLButtonElement | null;
}

export function createConversationTurnNavigator(params: {
  body: Element;
  chatShell: HTMLDivElement;
  chatBox: HTMLDivElement;
  conversationKey: number | null;
  minimumWidthPx: number;
}): void {
  disposeConversationTurnNavigator(params.body);

  const { body, chatShell, chatBox } = params;
  let conversationKey = params.conversationKey;
  const minimumWidthPx = Math.max(0, params.minimumWidthPx);
  const doc = body.ownerDocument;
  const win = doc?.defaultView;
  if (!doc || !win) return;
  const ownerWindow = win as Window;

  const nav = doc.createElement("nav") as HTMLElement;
  nav.className = "llm-turn-navigator";
  nav.hidden = true;
  nav.setAttribute("aria-label", t("Conversation query navigator"));

  const railViewport = doc.createElement("div") as HTMLDivElement;
  railViewport.className = "llm-turn-navigator-viewport";
  const markerList = doc.createElement("div") as HTMLDivElement;
  markerList.className = "llm-turn-navigator-list";
  railViewport.appendChild(markerList);
  nav.appendChild(railViewport);

  const preview = doc.createElement("div") as HTMLDivElement;
  preview.className = "llm-turn-navigator-preview";
  preview.hidden = true;
  preview.setAttribute("role", "tooltip");
  preview.id = `llm-turn-navigator-preview-${++navigatorSequence}`;
  const previewMeta = doc.createElement("div") as HTMLDivElement;
  previewMeta.className = "llm-turn-navigator-preview-meta";
  const previewQuery = doc.createElement("div") as HTMLDivElement;
  previewQuery.className = "llm-turn-navigator-preview-query";
  const previewAnswer = doc.createElement("div") as HTMLDivElement;
  previewAnswer.className = "llm-turn-navigator-preview-answer";
  const previewStatus = doc.createElement("div") as HTMLDivElement;
  previewStatus.className = "llm-turn-navigator-preview-status";
  preview.append(previewMeta, previewQuery, previewAnswer, previewStatus);
  chatShell.append(nav, preview);

  let disposed = false;
  let visible = false;
  let entries: ConversationTurnProjection[] = [];
  let geometryFrom = 0;
  const assistantEntries = new Map<Message, ConversationTurnProjection>();
  let structureSignature = "";
  let contentSignature = "";
  let contentMagnitude = 0;
  let markerOrderDirty = false;
  const dirtyMarkerKeys = new Set<string>();
  let activeIndex = -1;
  let previewIndex = -1;
  let turnStarts: number[] = [];
  let scheduledFrame: number | null = null;
  let railBrowseTimer: number | null = null;
  let railBrowseUntil = 0;
  const dirty: DirtyFlags = {
    reconcile: false,
    geometry: false,
    active: false,
    eligibility: false,
  };
  const markers = new Map<string, MarkerRecord>();
  const wrapperByTurnKey = new Map<string, HTMLElement>();
  const observedWrappers = new Set<Element>();
  const observedSizes = new WeakMap<
    Element,
    { width: number; height: number }
  >();
  const cleanupListeners: Array<() => void> = [];

  const listen = (
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ) => {
    target.addEventListener(type, listener, options);
    cleanupListeners.push(() =>
      target.removeEventListener(type, listener, options),
    );
  };

  const requestFrame = (callback: FrameRequestCallback): number =>
    win.requestAnimationFrame
      ? win.requestAnimationFrame(callback)
      : win.setTimeout(() => callback(Date.now()), 16);
  const cancelFrame = (frameId: number) => {
    if (win.cancelAnimationFrame) win.cancelAnimationFrame(frameId);
    else win.clearTimeout(frameId);
  };

  const isKeyboardBrowsing = (): boolean => {
    const activeElement = doc.activeElement as Element | null;
    const button = markerButtonFromTarget(activeElement);
    if (!button) return false;
    const focusedIndex = Number(button.dataset.turnIndex);
    return Number.isFinite(focusedIndex) && focusedIndex !== activeIndex;
  };

  const isAutoRevealSuspended = (): boolean =>
    Date.now() < railBrowseUntil || isKeyboardBrowsing();

  const revealActiveMarker = () => {
    if (!visible || activeIndex < 0 || isAutoRevealSuspended()) return;
    const entry = entries[activeIndex];
    const button = entry ? markers.get(entry.key)?.button : null;
    if (!button) return;
    try {
      button.scrollIntoView({ block: "nearest" });
    } catch (_err) {
      const top = button.offsetTop;
      const bottom = top + button.offsetHeight;
      if (top < railViewport.scrollTop) railViewport.scrollTop = top;
      else if (bottom > railViewport.scrollTop + railViewport.clientHeight) {
        railViewport.scrollTop = bottom - railViewport.clientHeight;
      }
    }
  };

  const scheduleRailRevealAfterIdle = () => {
    railBrowseUntil = Date.now() + RAIL_BROWSE_IDLE_MS;
    if (railBrowseTimer !== null) win.clearTimeout(railBrowseTimer);
    railBrowseTimer = win.setTimeout(() => {
      railBrowseTimer = null;
      if (!isKeyboardBrowsing()) revealActiveMarker();
    }, RAIL_BROWSE_IDLE_MS);
  };

  const hidePreview = () => {
    if (previewIndex >= 0) {
      const entry = entries[previewIndex];
      const button = entry ? markers.get(entry.key)?.button : null;
      button?.removeAttribute("aria-describedby");
    }
    previewIndex = -1;
    preview.hidden = true;
  };

  const positionPreview = () => {
    if (preview.hidden || previewIndex < 0) return;
    const entry = entries[previewIndex];
    const button = entry ? markers.get(entry.key)?.button : null;
    if (!button) {
      hidePreview();
      return;
    }
    const shellRect = chatShell.getBoundingClientRect();
    const markerRect = button.getBoundingClientRect();
    const previewHeight = preview.getBoundingClientRect().height;
    const desiredTop =
      markerRect.top -
      shellRect.top +
      markerRect.height / 2 -
      previewHeight / 2;
    const maxTop = Math.max(8, shellRect.height - previewHeight - 8);
    preview.style.top = `${Math.max(8, Math.min(maxTop, desiredTop))}px`;
  };

  const showPreview = (index: number) => {
    if (!visible || index < 0 || index >= entries.length) return;
    if (previewIndex >= 0 && previewIndex !== index) {
      const previous = entries[previewIndex];
      markers
        .get(previous?.key || "")
        ?.button.removeAttribute("aria-describedby");
    }
    previewIndex = index;
    const entry = entries[index];
    previewMeta.textContent = formatTemplate("Query {current} of {total}", {
      current: index + 1,
      total: entries.length,
    });
    previewQuery.textContent = entry.queryText;
    previewAnswer.textContent = entry.answerText;
    previewStatus.textContent = entry.answerStatus || "";
    previewStatus.hidden = !entry.answerStatus;
    preview.hidden = false;
    markers.get(entry.key)?.button.setAttribute("aria-describedby", preview.id);
    positionPreview();
  };

  const updateRovingTabIndex = () => {
    const focused = markerButtonFromTarget(doc.activeElement);
    const focusedIndex = Number(focused?.dataset.turnIndex);
    const tabbableIndex =
      focused && Number.isFinite(focusedIndex) ? focusedIndex : activeIndex;
    for (const [index, entry] of entries.entries()) {
      const marker = markers.get(entry.key);
      if (!marker) continue;
      marker.button.tabIndex = index === Math.max(0, tabbableIndex) ? 0 : -1;
    }
  };

  const updateActiveMarker = () => {
    const nextIndex = findActiveConversationTurnIndex(
      turnStarts,
      chatBox.scrollTop + chatBox.clientHeight / 2,
    );
    if (nextIndex === activeIndex) return;
    const previousEntry = entries[activeIndex];
    if (previousEntry) {
      const previousButton = markers.get(previousEntry.key)?.button;
      previousButton?.classList.remove("is-active");
      previousButton?.removeAttribute("aria-current");
    }
    activeIndex = nextIndex;
    const activeEntry = entries[activeIndex];
    if (activeEntry) {
      const activeButton = markers.get(activeEntry.key)?.button;
      activeButton?.classList.add("is-active");
      activeButton?.setAttribute("aria-current", "true");
    }
    updateRovingTabIndex();
    revealActiveMarker();
  };

  const measureTurnGeometry = () => {
    const viewportRect = chatBox.getBoundingClientRect();
    let lastStart = 0;
    turnStarts = entries.map((entry, index) => {
      if (index < geometryFrom && turnStarts[index] !== undefined) {
        lastStart = turnStarts[index];
        return lastStart;
      }
      const wrapper = wrapperByTurnKey.get(entry.key);
      if (!wrapper) return lastStart;
      const rect = wrapper.getBoundingClientRect();
      const nextStart = chatBox.scrollTop + rect.top - viewportRect.top;
      lastStart = Math.max(lastStart, nextStart);
      return lastStart;
    });
    geometryFrom = entries.length;
    dirty.active = true;
    if (!preview.hidden) positionPreview();
  };

  const updateMarker = (
    marker: MarkerRecord,
    entry: ConversationTurnProjection,
    index: number,
  ) => {
    marker.button.dataset.turnKey = entry.key;
    marker.button.dataset.turnIndex = `${index}`;
    marker.button.setAttribute(
      "aria-label",
      formatTemplate("Jump to query {number}: {query}", {
        number: index + 1,
        query: entry.queryText.slice(0, 160),
      }),
    );
    marker.dash.style.setProperty(
      "--llm-turn-dash-width",
      `${getConversationTurnDashWidth(entry.queryText)}px`,
    );
    marker.button.classList.toggle("is-active", index === activeIndex);
    if (index === activeIndex)
      marker.button.setAttribute("aria-current", "true");
    else marker.button.removeAttribute("aria-current");
  };

  const reconcileMarkers = () => {
    if (markerOrderDirty) {
      const nextKeys = new Set(entries.map((entry) => entry.key));
      for (const [key, marker] of markers) {
        if (nextKeys.has(key)) continue;
        marker.button.remove();
        markers.delete(key);
      }
    }
    for (const [index, entry] of entries.entries()) {
      let marker = markers.get(entry.key);
      if (!marker) {
        const button = doc.createElement("button") as HTMLButtonElement;
        button.type = "button";
        button.className = "llm-turn-navigator-marker";
        const dash = doc.createElement("span") as HTMLSpanElement;
        dash.className = "llm-turn-navigator-dash";
        dash.setAttribute("aria-hidden", "true");
        button.appendChild(dash);
        marker = { button, dash };
        markers.set(entry.key, marker);
      }
      if (markerOrderDirty || dirtyMarkerKeys.has(entry.key)) {
        updateMarker(marker, entry, index);
      }
      if (markerOrderDirty) markerList.appendChild(marker.button);
    }
    markerOrderDirty = false;
    dirtyMarkerKeys.clear();
    if (activeIndex >= entries.length) activeIndex = entries.length - 1;
    updateRovingTabIndex();
    if (previewIndex >= 0) showPreview(previewIndex);
  };

  const applyEligibility = () => {
    const previousVisible = visible;
    withScrollGuard(
      chatBox,
      conversationKey,
      () => {
        chatShell.classList.remove("llm-turn-navigator-visible");
        nav.hidden = true;
        void chatBox.offsetWidth;
        const shellWidth =
          chatShell.getBoundingClientRect().width || chatShell.clientWidth || 0;
        const eligible = isConversationTurnNavigatorEligible({
          shellWidth,
          scrollHeight: chatBox.scrollHeight,
          clientHeight: chatBox.clientHeight,
          turnCount: entries.length,
          minimumWidthPx,
        });
        visible = eligible;
        nav.hidden = !eligible;
        chatShell.classList.toggle("llm-turn-navigator-visible", eligible);
      },
      "anchor",
    );
    if (!visible) hidePreview();
    if (visible !== previousVisible) {
      dirty.geometry = true;
      dirty.active = true;
    }
  };

  const runScheduledWork = () => {
    scheduledFrame = null;
    if (disposed) return;
    if (dirty.reconcile) {
      dirty.reconcile = false;
      reconcileMarkers();
    }
    if (dirty.eligibility) {
      dirty.eligibility = false;
      applyEligibility();
    }
    if (dirty.geometry) {
      dirty.geometry = false;
      measureTurnGeometry();
    }
    if (dirty.active) {
      dirty.active = false;
      updateActiveMarker();
    }
  };

  const schedule = (flags: Partial<DirtyFlags>) => {
    if (disposed) return;
    Object.assign(dirty, flags);
    if (scheduledFrame !== null) return;
    scheduledFrame = requestFrame(runScheduledWork);
  };

  const ResizeObserverCtor = win.ResizeObserver;
  const resizeObserver = ResizeObserverCtor
    ? new ResizeObserverCtor((resizeEntries) => {
        let eligibilityChanged = false;
        for (const resizeEntry of resizeEntries) {
          if (resizeEntry.target === chatShell) {
            geometryFrom = 0;
            eligibilityChanged = true;
            continue;
          }
          const messageIndex = Number(
            (resizeEntry.target as HTMLElement).dataset.messageIndex,
          );
          const affected = entries.findIndex(
            (entry) => entry.userMessageIndex >= messageIndex,
          );
          geometryFrom = Math.min(
            geometryFrom,
            affected < 0 ? entries.length : affected,
          );
          const previousSize = observedSizes.get(resizeEntry.target);
          const nextSize = {
            width: resizeEntry.contentRect.width,
            height: resizeEntry.contentRect.height,
          };
          observedSizes.set(resizeEntry.target, nextSize);
          const widthChanged =
            previousSize !== undefined &&
            Math.abs(previousSize.width - nextSize.width) > 1;
          // Applying the gutter resizes wrappers by design. The outer shell
          // callback owns width eligibility, so a wrapper width change must
          // not feed the gutter mutation back into eligibility.
          if (
            !widthChanged &&
            (!visible ||
              (previousSize?.height ?? nextSize.height) - nextSize.height > 1)
          ) {
            eligibilityChanged = true;
          }
        }
        schedule({
          geometry: true,
          active: true,
          eligibility: eligibilityChanged,
        });
      })
    : null;
  resizeObserver?.observe(chatShell);

  const refreshObservedWrappers = (nextWrappers: Set<Element>) => {
    if (!resizeObserver) return;
    for (const wrapper of observedWrappers) {
      if (nextWrappers.has(wrapper)) continue;
      resizeObserver.unobserve(wrapper);
      observedWrappers.delete(wrapper);
    }
    for (const wrapper of nextWrappers) {
      if (observedWrappers.has(wrapper)) continue;
      observedWrappers.add(wrapper);
      const rect = wrapper.getBoundingClientRect();
      observedSizes.set(wrapper, { width: rect.width, height: rect.height });
      resizeObserver.observe(wrapper);
    }
  };

  const activateMarker = (index: number) => {
    const entry = entries[index];
    const wrapper = entry ? wrapperByTurnKey.get(entry.key) : null;
    if (!entry || !wrapper || !conversationKey) return;
    const paddingTop = Number.parseFloat(
      ownerWindow.getComputedStyle(chatBox)?.paddingTop || "0",
    );
    const reduceMotion = ownerWindow.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    )?.matches;
    hidePreview();
    navigateChatToMessage({
      conversationKey,
      chatBox,
      targetElement: wrapper,
      behavior: reduceMotion ? "auto" : "smooth",
      viewportOffsetTop: Number.isFinite(paddingTop) ? paddingTop : 0,
    });
  };

  listen(chatBox, "scroll", () => schedule({ active: true }), {
    passive: true,
  });
  listen(railViewport, "scroll", () => {
    if (!preview.hidden) positionPreview();
  });
  listen(railViewport, "wheel", scheduleRailRevealAfterIdle as EventListener, {
    passive: true,
  });
  listen(markerList, "pointerover", (event) => {
    const button = markerButtonFromTarget(event.target);
    const index = Number(button?.dataset.turnIndex);
    if (button && Number.isFinite(index)) showPreview(index);
  });
  listen(markerList, "pointerout", (event) => {
    const relatedButton = markerButtonFromTarget(
      (event as PointerEvent).relatedTarget,
    );
    if (relatedButton) return;
    if (!markerButtonFromTarget(doc.activeElement)) hidePreview();
  });
  listen(markerList, "focusin", (event) => {
    const button = markerButtonFromTarget(event.target);
    const index = Number(button?.dataset.turnIndex);
    if (button && Number.isFinite(index)) showPreview(index);
  });
  listen(markerList, "focusout", () => {
    Promise.resolve().then(() => {
      if (!markerButtonFromTarget(doc.activeElement)) {
        hidePreview();
        revealActiveMarker();
      }
    });
  });
  listen(markerList, "click", (event) => {
    const button = markerButtonFromTarget(event.target);
    const index = Number(button?.dataset.turnIndex);
    if (!button || !Number.isFinite(index)) return;
    event.preventDefault();
    activateMarker(index);
  });
  listen(markerList, "keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    const button = markerButtonFromTarget(event.target);
    const currentIndex = Number(button?.dataset.turnIndex);
    if (!button || !Number.isFinite(currentIndex)) return;
    if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
      keyboardEvent.preventDefault();
      activateMarker(currentIndex);
      return;
    }
    let nextIndex = currentIndex;
    if (keyboardEvent.key === "ArrowUp") nextIndex = currentIndex - 1;
    else if (keyboardEvent.key === "ArrowDown") nextIndex = currentIndex + 1;
    else if (keyboardEvent.key === "Home") nextIndex = 0;
    else if (keyboardEvent.key === "End") nextIndex = entries.length - 1;
    else return;
    keyboardEvent.preventDefault();
    nextIndex = Math.max(0, Math.min(entries.length - 1, nextIndex));
    const nextEntry = entries[nextIndex];
    const nextButton = nextEntry ? markers.get(nextEntry.key)?.button : null;
    nextButton?.focus();
    updateRovingTabIndex();
  });

  const controller: ConversationTurnNavigatorController = {
    updateAssistant(message) {
      if (disposed) return;
      const entry = assistantEntries.get(message);
      if (!entry) return;
      const answer = projectAnswerPreview(message);
      if (
        entry.answerText === answer.text &&
        entry.answerStatus === answer.status
      )
        return;
      entry.answerText = answer.text;
      entry.answerStatus = answer.status;
      if (entries[previewIndex] === entry) schedule({ reconcile: true });
    },
    sync(messages, options) {
      if (disposed) return;
      if (options && "conversationKey" in options) {
        conversationKey = options.conversationKey ?? null;
      }
      const nextEntries = buildConversationTurnProjection(messages);
      const previousEntriesByKey = new Map(
        entries.map((entry) => [entry.key, entry] as const),
      );
      const nextStructureSignature = nextEntries
        .map((entry) => `${entry.userKey}:${entry.assistantKey || ""}`)
        .join("|");
      const nextContentSignature = nextEntries
        .map(
          (entry) =>
            `${entry.key}:${entry.queryText}:${entry.answerText}:${entry.answerStatus || ""}`,
        )
        .join("|");
      const nextMagnitude = nextEntries.reduce(
        (sum, entry) => sum + entry.queryText.length + entry.answerText.length,
        0,
      );
      const structureChanged = nextStructureSignature !== structureSignature;
      const contentChanged = nextContentSignature !== contentSignature;
      const contentShrank = nextMagnitude < contentMagnitude;
      for (const entry of nextEntries) {
        const previousEntry = previousEntriesByKey.get(entry.key);
        if (!previousEntry || previousEntry.queryText !== entry.queryText) {
          dirtyMarkerKeys.add(entry.key);
        }
      }
      structureSignature = nextStructureSignature;
      contentSignature = nextContentSignature;
      contentMagnitude = nextMagnitude;
      entries = nextEntries;
      geometryFrom = 0;
      assistantEntries.clear();
      for (const entry of entries) {
        const assistant =
          entry.assistantMessageIndex === undefined
            ? undefined
            : messages[entry.assistantMessageIndex];
        if (assistant) assistantEntries.set(assistant, entry);
      }
      markerOrderDirty = markerOrderDirty || structureChanged;

      const wrappers = Array.from(
        chatBox.querySelectorAll(".llm-message-wrapper[data-message-index]"),
      ) as HTMLElement[];
      const wrapperByIndex = new Map<number, HTMLElement>();
      for (const wrapper of wrappers) {
        const index = Number(wrapper.dataset.messageIndex);
        if (Number.isFinite(index)) wrapperByIndex.set(index, wrapper);
      }
      wrapperByTurnKey.clear();
      const nextObservedWrappers = new Set<Element>();
      for (const [index, message] of messages.entries()) {
        const wrapper = wrapperByIndex.get(index);
        if (!wrapper) continue;
        wrapper.dataset.messageAnchorKey = getConversationMessageAnchorKey(
          message,
          index,
        );
      }
      for (const entry of entries) {
        const userWrapper = wrapperByIndex.get(entry.userMessageIndex);
        if (userWrapper) {
          wrapperByTurnKey.set(entry.key, userWrapper);
          nextObservedWrappers.add(userWrapper);
        }
        if (entry.assistantMessageIndex !== undefined) {
          const assistantWrapper = wrapperByIndex.get(
            entry.assistantMessageIndex,
          );
          if (assistantWrapper) nextObservedWrappers.add(assistantWrapper);
        }
      }
      refreshObservedWrappers(nextObservedWrappers);

      schedule({
        reconcile:
          structureChanged ||
          dirtyMarkerKeys.size > 0 ||
          (contentChanged && previewIndex >= 0),
        geometry: true,
        active: true,
        eligibility: structureChanged || contentShrank || !visible,
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelChatNavigation(chatBox, false);
      if (scheduledFrame !== null) cancelFrame(scheduledFrame);
      if (railBrowseTimer !== null) win.clearTimeout(railBrowseTimer);
      resizeObserver?.disconnect();
      for (const cleanup of cleanupListeners.splice(0)) cleanup();
      chatShell.classList.remove("llm-turn-navigator-visible");
      nav.remove();
      preview.remove();
      if (controllers.get(body) === controller) controllers.delete(body);
    },
  };
  controllers.set(body, controller);
}

export function syncConversationTurnNavigator(
  body: Element,
  messages: readonly Message[],
  options: SyncConversationTurnNavigatorOptions = {},
): void {
  controllers.get(body)?.sync(messages, options);
}

export function disposeConversationTurnNavigator(body: Element): void {
  controllers.get(body)?.dispose();
}

export function updateStreamingTurnNavigator(
  body: Element,
  message: Message,
): void {
  controllers.get(body)?.updateAssistant(message);
}
