export type ChatScrollAnchor = {
  kind: "quote" | "message" | "answerBlock";
  blockOrdinal?: number;
  blockText?: string;
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

export function getElementRect(element: Element): DOMRect | null {
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

export function closestElement(
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

export function getMessageAnchorForElement(element: Element): {
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
  if (!hasLayoutBox(quoteCard)) return null;
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

function answerBlocks(wrapper: Element): Element[] {
  // Native agent text can be interleaved with tools inside the activity trace.
  // Its wrapper stays put while content above the paragraph grows, so anchoring
  // only the wrapper cannot keep that paragraph still during output.
  const textSections = queryElements(
    wrapper,
    ".llm-assistant-answer, .llm-agent-inline-text, .llm-agent-process-message-markdown",
  );
  return textSections
    .flatMap((section) =>
      queryElements(section, "p, pre, table, li, h1, h2, h3, h4, h5, h6"),
    )
    .filter(
      (block) =>
        // Appending a blank line can turn a tight list's li into li > p.
        // Count the readable paragraph once so this does not renumber every
        // later anchor, especially when list items share the same text.
        block.tagName.toLowerCase() !== "li" ||
        !Array.from(block.children).some(
          (child) => child.tagName.toLowerCase() === "p",
        ),
    );
}

function blockText(element: Element): string {
  return (element.textContent || "").trim().slice(0, 160);
}

function findVisibleAnswerAnchor(
  wrapper: Element,
  viewport: DOMRect,
): ChatScrollAnchor | undefined {
  const blocks = answerBlocks(wrapper);
  let best: { anchor: ChatScrollAnchor; score: number } | undefined;
  for (const block of findVisibleFlowElements(blocks, viewport)) {
    const index = blocks.indexOf(block);
    const rect = getElementRect(block);
    if (!rect || !isRectVisibleInViewport(rect, viewport)) continue;
    // Prefer the block beginning nearest the reading edge. A two-pixel tail
    // of the preceding paragraph must not win over a paragraph starting just
    // below the edge: reflow changes that tail's height independently.
    const score = Math.abs(rect.top - viewport.top);
    if (!best || score < best.score)
      best = {
        score,
        anchor: {
          kind: "answerBlock",
          ...getMessageAnchorForElement(wrapper),
          blockOrdinal: index,
          blockText: blockText(blocks[index]),
          viewportOffsetTop: rect.top - viewport.top,
        },
      };
  }
  return best?.anchor;
}

function isEmptyRect(rect: DOMRect): boolean {
  return rect.top === rect.bottom && rect.width === 0;
}

function hasLayoutBox(element: Element): boolean {
  // Gecko can retain nonzero descendant rects inside a closed details element.
  // Those cached boxes are not usable reading anchors; only its summary shows.
  for (
    let parent: Element | null = element;
    parent;
    parent = parent.parentElement
  ) {
    if ((parent as HTMLElement).hidden) return false;
    if (
      parent.tagName?.toLowerCase() === "details" &&
      !(parent as HTMLDetailsElement).open
    ) {
      const summary = Array.from(parent.children).find(
        (child) => child.tagName.toLowerCase() === "summary",
      );
      if (!summary?.contains(element)) return false;
    }
  }
  const rect = getElementRect(element);
  return Boolean(rect && !isEmptyRect(rect));
}

/**
 * Messages and answer blocks form a vertical flow. Locate the visible run
 * with binary search so scrolling long histories or long answers does not
 * measure every offscreen block. Step over hidden nodes with empty rects.
 */
function findVisibleFlowElements(
  wrappers: Element[],
  viewport: DOMRect,
): Element[] {
  if (!wrappers.length) return [];
  const measuredRects = new Map<number, DOMRect | null>();
  const rectAt = (index: number): DOMRect | null => {
    if (measuredRects.has(index)) return measuredRects.get(index) || null;
    const rect = hasLayoutBox(wrappers[index])
      ? getElementRect(wrappers[index])
      : null;
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
  return visible;
}

export function findBestVisibleChatAnchor(
  chatBox: HTMLDivElement,
): ChatScrollAnchor | undefined {
  const viewport = getElementRect(chatBox);
  if (!viewport) return undefined;

  const wrappers = queryElements(chatBox, ".llm-message-wrapper");
  const visibleWrappers = findVisibleFlowElements(wrappers, viewport);
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
  // A wrapper's top does not move when its thinking section collapses. Anchor
  // the answer block itself so the paragraph being read keeps its offset.
  let bestContent = bestQuote;
  for (const wrapper of visibleWrappers) {
    const anchor = findVisibleAnswerAnchor(wrapper, viewport);
    if (!anchor) continue;
    const score = Math.abs(anchor.viewportOffsetTop);
    // A citation barely visible at the bottom must not pull the paragraph at
    // the reading edge along when output above that citation grows.
    if (!bestContent || score < bestContent.score)
      bestContent = { element: wrapper, anchor, score };
  }
  if (bestContent) return bestContent.anchor;

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

export function findChatAnchorForElement(
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
    if (sameQuote && hasLayoutBox(card)) return card;
  }
  if (anchor.quoteCitationId) {
    for (const root of roots) {
      const match = queryElements(root, ".llm-quote-card").find(
        (element) =>
          datasetValue(element, "quoteCitationId") === anchor.quoteCitationId &&
          hasLayoutBox(element),
      );
      if (match) return match;
    }
  }
  if (anchor.citationSyncKey) {
    for (const root of roots) {
      const match = queryElements(root, "[data-citation-sync-key]").find(
        (element) =>
          datasetValue(element, "citationSyncKey") === anchor.citationSyncKey &&
          hasLayoutBox(element),
      );
      if (match) return closestElement(match, ".llm-quote-card") || match;
    }
  }
  return null;
}

export function findElementForAnchor(
  chatBox: HTMLDivElement,
  anchor: ChatScrollAnchor,
): Element | null {
  if (anchor.kind === "quote") {
    return findQuoteElementForAnchor(chatBox, anchor);
  }
  if (anchor.kind === "answerBlock") {
    const wrapper = findMessageWrapperForAnchor(chatBox, anchor);
    const blocks = wrapper ? answerBlocks(wrapper) : [];
    const indexed = blocks[anchor.blockOrdinal ?? -1];
    if (
      indexed &&
      hasLayoutBox(indexed) &&
      (!anchor.blockText || blockText(indexed).startsWith(anchor.blockText))
    )
      return indexed;
    return (
      blocks.find(
        (block) =>
          anchor.blockText &&
          blockText(block).startsWith(anchor.blockText) &&
          hasLayoutBox(block),
      ) || null
    );
  }
  const wrapper = findMessageWrapperForAnchor(chatBox, anchor);
  return wrapper && hasLayoutBox(wrapper) ? wrapper : null;
}
