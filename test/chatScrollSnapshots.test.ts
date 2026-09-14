import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { describe, it } from "mocha";

import {
  applyChatScrollSnapshot,
  isScrollUpdateSuspended,
  cancelFollowBottomCatchup,
  setFollowBottomChatScrollSnapshot,
  clearChatScrollSnapshotsForTests,
  cancelChatNavigation,
  consumePendingChatScrollRestoreForTests,
  getActiveChatNavigationSnapshot,
  getChatScrollSnapshot,
  hasActiveFollowBottomCatchupRequest,
  isChatNavigationActive,
  navigateChatToMessage,
  persistPendingChatScrollRestoreForConversationKey,
  persistPendingChatScrollRestoreForElement,
  persistChatScrollSnapshotForConversationKey,
  requestFollowBottomCatchup,
  restoreChatScrollSnapshotForConversationKey,
  settleFollowBottomIntent,
} from "../src/modules/contextPanel/chatScrollSnapshots";

const here = dirname(fileURLToPath(import.meta.url));

class FakeClassList {
  private readonly tokens = new Set<string>();

  constructor(className = "") {
    this.set(className);
  }

  set(className: string): void {
    this.tokens.clear();
    for (const token of className.split(/\s+/)) {
      if (token) this.tokens.add(token);
    }
  }

  contains(token: string): boolean {
    return this.tokens.has(token);
  }
}

/** Layout reads made through the fake DOM; the anchor search must stay small. */
let rectReads = 0;

class FakeElement {
  readonly dataset: Record<string, string | undefined> = {};
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList();
  parentElement: FakeElement | null = null;
  id = "";
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  offsetTop = 0;
  offsetHeight = 0;
  isConnected = true;
  ownerDocument = { defaultView: null } as unknown as Document;
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(className = "") {
    this.className = className;
  }

  set className(value: string) {
    this.classList.set(value);
  }

  get childElementCount(): number {
    return this.children.length;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) || new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, init: Partial<KeyboardEvent> = {}): void {
    const event = { type, ...init } as Event;
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  scrollTo(options: ScrollToOptions): void {
    const target = Number(options.top || 0);
    this.scrollTop = options.behavior === "smooth" ? target / 2 : target;
  }

  closest(selector: string): FakeElement | null {
    let current: FakeElement | null = this;
    while (current) {
      if (matchesSelector(current, selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];
    const selectors = selector.split(",").map((entry) => entry.trim());
    for (const child of this.children) {
      if (selectors.some((entry) => matchesSelector(child, entry))) {
        matches.push(child);
      }
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }

  getClientRects(): Array<{ top: number; bottom: number }> {
    return [this.getBoundingClientRect()];
  }

  getBoundingClientRect(): {
    top: number;
    bottom: number;
    height: number;
    width: number;
    left: number;
    right: number;
  } {
    rectReads += 1;
    const chatBox = this.closest("#llm-chat-box");
    if (this === chatBox) {
      return {
        top: 0,
        bottom: this.clientHeight,
        height: this.clientHeight,
        width: 320,
        left: 0,
        right: 320,
      };
    }
    const scrollTop = chatBox?.scrollTop || 0;
    const top = this.offsetTop - scrollTop;
    return {
      top,
      bottom: top + this.offsetHeight,
      height: this.offsetHeight,
      width: 320,
      left: 0,
      right: 320,
    };
  }
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  if (selector.startsWith("#")) return element.id === selector.slice(1);
  if (selector.startsWith(".")) {
    return element.classList.contains(selector.slice(1));
  }
  const attrMatch = /^\[data-([a-z0-9-]+)\]$/i.exec(selector);
  if (attrMatch) {
    const key = attrMatch[1].replace(/-([a-z])/g, (_match, letter: string) =>
      letter.toUpperCase(),
    );
    return Boolean(element.dataset[key]);
  }
  // Like the DOM, an unparseable selector is a SyntaxError, not a miss.
  throw new SyntaxError(`'${selector}' is not a valid selector`);
}

function makeChatBox(params: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight?: number;
}): FakeElement {
  const chatBox = new FakeElement("llm-messages");
  chatBox.id = "llm-chat-box";
  chatBox.scrollTop = params.scrollTop;
  chatBox.scrollHeight = params.scrollHeight;
  chatBox.clientHeight = params.clientHeight ?? 100;
  chatBox.offsetHeight = chatBox.clientHeight;
  return chatBox;
}

function appendElement(
  parent: FakeElement,
  className: string,
  params: {
    offsetTop: number;
    offsetHeight: number;
    dataset?: Record<string, string>;
  },
): FakeElement {
  const element = new FakeElement(className);
  element.offsetTop = params.offsetTop;
  element.offsetHeight = params.offsetHeight;
  Object.assign(element.dataset, params.dataset || {});
  parent.appendChild(element);
  return element;
}

describe("chat scroll snapshots", function () {
  it("restores the quote card the reader was on, not the first card sharing its citation id", function () {
    clearChatScrollSnapshotsForTests();
    const chatBox = makeChatBox({
      scrollTop: 1000,
      scrollHeight: 2000,
      clientHeight: 100,
    });
    const wrapper = appendElement(chatBox, "llm-message-wrapper", {
      offsetTop: 0,
      offsetHeight: 2000,
      dataset: {
        messageRole: "assistant",
        messageTimestamp: "2",
        messageAnchorKey: "turn-2",
      },
    });
    // The same source quote is cited three times in one answer.
    const cards = [100, 500, 1000].map((offsetTop) =>
      appendElement(wrapper, "llm-quote-card", {
        offsetTop,
        offsetHeight: 40,
        dataset: { quoteCitationId: "Q_shared" },
      }),
    );
    persistChatScrollSnapshotForConversationKey(9, chatBox);
    const snapshot = getChatScrollSnapshot(9);
    assert.equal(snapshot?.anchor?.kind, "quote");
    assert.equal(snapshot?.anchor?.viewportOffsetTop, 0);

    // Content above the reader grows by 100px (a card above expands, a
    // message above re-renders), moving every card down.
    for (const card of cards) card.offsetTop += 100;
    applyChatScrollSnapshot(chatBox, snapshot!);

    assert.equal(
      chatBox.scrollTop,
      1100,
      "the third card must stay at the top of the viewport",
    );
  });

  it("restores a quote card whose sync key contains a double quote", function () {
    clearChatScrollSnapshotsForTests();
    const chatBox = makeChatBox({
      scrollTop: 500,
      scrollHeight: 2000,
      clientHeight: 100,
    });
    const wrapper = appendElement(chatBox, "llm-message-wrapper", {
      offsetTop: 0,
      offsetHeight: 2000,
      dataset: {
        messageRole: "assistant",
        messageTimestamp: "2",
        messageAnchorKey: "turn-2",
      },
    });
    // A card with no citation id, whose inline citation carries a sync key
    // built from the quoted prose itself — including its double quotes.
    const card = appendElement(wrapper, "llm-quote-card", {
      offsetTop: 500,
      offsetHeight: 40,
    });
    const button = appendElement(card, "llm-citation-button", {
      offsetTop: 510,
      offsetHeight: 10,
      dataset: {
        citationSyncKey: 'source\u241fthey called it a "null result" here',
      },
    });
    // The reader clicked that citation; it becomes the restore anchor.
    persistPendingChatScrollRestoreForConversationKey(
      11,
      chatBox,
      button as unknown as Element,
    );
    const snapshot = getChatScrollSnapshot(11);
    assert.equal(snapshot?.anchor?.kind, "quote");
    assert.equal(snapshot?.anchor?.quoteOrdinal, 0);
    assert.isUndefined(snapshot?.anchor?.quoteCitationId);

    card.offsetTop += 100;
    card.children[0].offsetTop += 100;
    assert.doesNotThrow(() => applyChatScrollSnapshot(chatBox, snapshot!));
    assert.equal(chatBox.scrollTop, 600, "the card must stay where it was");
  });

  describe("settleFollowBottomIntent", function () {
    function makeTwoTurnChat(scrollTop: number): FakeElement {
      const chatBox = makeChatBox({
        scrollTop,
        scrollHeight: 1000,
        clientHeight: 100,
      });
      appendElement(chatBox, "llm-message-wrapper", {
        offsetTop: 0,
        offsetHeight: 500,
        dataset: {
          messageRole: "user",
          messageTimestamp: "1",
          messageAnchorKey: "turn-1",
        },
      });
      appendElement(chatBox, "llm-message-wrapper", {
        offsetTop: 500,
        offsetHeight: 500,
        dataset: {
          messageRole: "assistant",
          messageTimestamp: "2",
          messageAnchorKey: "turn-2",
        },
      });
      return chatBox;
    }

    it("ends follow-bottom intent once a settled conversation is no longer at the bottom", function () {
      clearChatScrollSnapshotsForTests();
      const chatBox = makeTwoTurnChat(900);
      setFollowBottomChatScrollSnapshot(3, chatBox);
      // The reader pulled away (or opened something that grew the page).
      chatBox.scrollTop = 400;

      const settled = settleFollowBottomIntent(3, chatBox, {
        streaming: false,
      });

      assert.equal(settled?.mode, "manual");
      assert.equal(settled?.anchor?.kind, "message");
      assert.equal(settled?.anchor?.messageAnchorKey, "turn-1");
      assert.equal(getChatScrollSnapshot(3)?.mode, "manual");
    });

    it("keeps following while the answer is still streaming", function () {
      clearChatScrollSnapshotsForTests();
      const chatBox = makeTwoTurnChat(900);
      setFollowBottomChatScrollSnapshot(3, chatBox);
      chatBox.scrollTop = 400;

      const settled = settleFollowBottomIntent(3, chatBox, {
        streaming: true,
      });

      assert.equal(settled?.mode, "followBottom");
      assert.equal(getChatScrollSnapshot(3)?.mode, "followBottom");
    });

    it("keeps following while the reader is still at the bottom", function () {
      clearChatScrollSnapshotsForTests();
      const chatBox = makeTwoTurnChat(900);
      setFollowBottomChatScrollSnapshot(3, chatBox);

      const settled = settleFollowBottomIntent(3, chatBox, {
        streaming: false,
      });

      assert.equal(settled?.mode, "followBottom");
    });
  });

  it("locates the visible anchor without measuring every message of a long conversation", function () {
    clearChatScrollSnapshotsForTests();
    const chatBox = makeChatBox({
      scrollTop: 20_000,
      scrollHeight: 40_000,
      clientHeight: 100,
    });
    for (let index = 0; index < 400; index += 1) {
      const wrapper = appendElement(chatBox, "llm-message-wrapper", {
        offsetTop: index * 100,
        offsetHeight: 100,
        dataset: {
          messageRole: "assistant",
          messageTimestamp: `${index}`,
          messageAnchorKey: `message-${index}`,
        },
      });
      appendElement(wrapper, "llm-quote-card", {
        offsetTop: index * 100 + 10,
        offsetHeight: 40,
        dataset: { quoteCitationId: `quote-${index}` },
      });
    }

    rectReads = 0;
    persistChatScrollSnapshotForConversationKey(7, chatBox);

    const snapshot = getChatScrollSnapshot(7);
    assert.equal(snapshot?.mode, "manual");
    assert.equal(snapshot?.anchor?.kind, "quote");
    assert.equal(snapshot?.anchor?.quoteCitationId, "quote-200");
    assert.equal(snapshot?.anchor?.viewportOffsetTop, 10);
    assert.isBelow(
      rectReads,
      60,
      `anchor search measured ${rectReads} rects for 400 messages`,
    );
  });

  it("preserves follow intent when text grows before a pending scroll event", function () {
    clearChatScrollSnapshotsForTests();
    const element = makeChatBox({
      scrollTop: 400,
      scrollHeight: 1000,
      clientHeight: 600,
    });
    const box = element as unknown as HTMLDivElement;
    setFollowBottomChatScrollSnapshot(1, box);
    // One frame follows the text; its scroll event arrives after the next chunk.
    element.scrollHeight += 20;
    box.scrollTop = 420;
    element.scrollHeight += 20;
    persistChatScrollSnapshotForConversationKey(1, box);
    assert.equal(getChatScrollSnapshot(1, box)?.mode, "followBottom");
    restoreChatScrollSnapshotForConversationKey(1, box);
    assert.equal(box.scrollTop, box.scrollHeight);

    // Explicit user cancellation must still survive subsequent text growth.
    cancelFollowBottomCatchup(1, box);
    box.scrollTop = 400;
    element.scrollHeight += 100;
    persistChatScrollSnapshotForConversationKey(1, box);
    assert.equal(getChatScrollSnapshot(1, box)?.mode, "manual");
    restoreChatScrollSnapshotForConversationKey(1, box);
    assert.equal(box.scrollTop, 400);
  });

  it("keeps scrolling intent and programmatic-scroll suppression local to each panel", async function () {
    clearChatScrollSnapshotsForTests();
    const a = new FakeElement();
    const b = new FakeElement();
    a.scrollHeight = b.scrollHeight = 2000;
    a.clientHeight = b.clientHeight = 400;
    const boxA = a as unknown as HTMLDivElement;
    const boxB = b as unknown as HTMLDivElement;
    setFollowBottomChatScrollSnapshot(1, boxA);
    setFollowBottomChatScrollSnapshot(1, boxB);
    cancelFollowBottomCatchup(1, boxA);
    assert.equal(getChatScrollSnapshot(1, boxA)?.mode, "manual");
    assert.equal(getChatScrollSnapshot(1, boxB)?.mode, "followBottom");
    applyChatScrollSnapshot(boxA, {
      mode: "manual",
      scrollTop: 300,
      updatedAt: 1,
    });
    assert.isTrue(isScrollUpdateSuspended(boxA));
    assert.isFalse(isScrollUpdateSuspended(boxB));
    await Promise.resolve();
    assert.isFalse(isScrollUpdateSuspended(boxA));
  });

  it("rerenders only quote-validated assistant wrappers", function () {
    const chatSource = readFileSync(
      resolve(here, "../src/modules/contextPanel/chat.ts"),
      "utf8",
    );
    const validationRefreshStart = chatSource.indexOf(
      "function refreshConversationAfterQuoteValidation(",
    );
    const validationRefreshEnd = chatSource.indexOf(
      "function startConversationQuoteValidation(",
      validationRefreshStart,
    );
    const validationRefreshSource = chatSource.slice(
      validationRefreshStart,
      validationRefreshEnd,
    );
    const refreshChatStart = chatSource.indexOf("export function refreshChat(");
    const refreshChatEnd = chatSource.indexOf(
      "export function refreshConversationPanels(",
      refreshChatStart,
    );
    const refreshChatSource = chatSource.slice(
      refreshChatStart,
      refreshChatEnd,
    );
    const validationTaskStart = chatSource.indexOf(
      "function startConversationQuoteValidation(",
    );
    const validationTaskEnd = chatSource.indexOf(
      "function scheduleAssistantMessageQuoteValidation(",
      validationTaskStart,
    );
    const validationTaskSource = chatSource.slice(
      validationTaskStart,
      validationTaskEnd,
    );

    assert.include(
      validationRefreshSource,
      "rerenderAssistantMessages: changedMessages",
    );
    assert.notInclude(validationRefreshSource, "refreshConversationPanels(");
    // The validation task classifies on-screen messages first and flips each
    // one the moment it is classified (progressive refresh), instead of
    // accumulating a batch and refreshing once at the end.
    assert.include(
      validationTaskSource,
      "orderQuoteValidationBatchByViewportPriority(",
    );
    assert.include(
      validationTaskSource,
      "promptTimeoutMs: QUOTE_VALIDATION_PROMPT_IDLE_MS",
    );
    assert.equal(
      validationTaskSource.match(/for \(const request of batch\)/g)?.length,
      1,
    );
    assert.notInclude(validationTaskSource, "preparedEvidence");
    assert.isBelow(
      validationTaskSource.indexOf(
        "buildCachedQuoteSourceEvidenceForPaperContexts(",
      ),
      validationTaskSource.indexOf("applyAssistantMessageQuoteGate("),
    );
    assert.include(validationTaskSource, "new Set([assistantMessage])");
    assert.notInclude(validationTaskSource, "changedMessages.add(");
    assert.include(refreshChatSource, "targetedMessageWrappers");
    // Wrapper matching lives in the extracted targetedRerender module so it
    // stays unit-testable; refreshChat must route through it.
    assert.include(refreshChatSource, "resolveTargetedAssistantRerenders(");
    const targetedRerenderSource = readFileSync(
      resolve(here, "../src/modules/contextPanel/targetedRerender.ts"),
      "utf8",
    );
    assert.include(
      targetedRerenderSource,
      "candidate.dataset.messageIndex === `${messageIndex}`",
    );
    assert.include(
      refreshChatSource,
      "wrapper.dataset.messageIndex = `${index}`",
    );
    assert.include(refreshChatSource, "existingTargetedWrapper.replaceWith");
    assert.include(refreshChatSource, "if (!useTargetedRerender)");
    assert.include(
      refreshChatSource,
      "if (tokenUsageEl && !useTargetedRerender)",
    );
  });

  it("restores a quote anchor after rerendered message heights change", function () {
    clearChatScrollSnapshotsForTests();
    const conversationKey = 42;
    const before = makeChatBox({ scrollTop: 200, scrollHeight: 900 });
    const beforeMessage = appendElement(before, "llm-message-wrapper", {
      offsetTop: 0,
      offsetHeight: 800,
      dataset: { messageRole: "assistant", messageTimestamp: "1000" },
    });
    appendElement(beforeMessage, "llm-quote-card llm-quote-citation-anchor", {
      offsetTop: 230,
      offsetHeight: 40,
      dataset: { quoteCitationId: "quote-1" },
    });

    persistChatScrollSnapshotForConversationKey(
      conversationKey,
      before as unknown as HTMLDivElement,
    );

    const after = makeChatBox({ scrollTop: 0, scrollHeight: 1200 });
    const afterMessage = appendElement(after, "llm-message-wrapper", {
      offsetTop: 0,
      offsetHeight: 1100,
      dataset: { messageRole: "assistant", messageTimestamp: "1000" },
    });
    appendElement(afterMessage, "llm-quote-card llm-quote-citation-anchor", {
      offsetTop: 500,
      offsetHeight: 40,
      dataset: { quoteCitationId: "quote-1" },
    });

    const restored = restoreChatScrollSnapshotForConversationKey(
      conversationKey,
      after as unknown as HTMLDivElement,
    );

    assert.isTrue(restored);
    assert.equal(after.scrollTop, 470);
  });

  it("falls back to pixel scroll when the saved anchor is gone", function () {
    clearChatScrollSnapshotsForTests();
    const conversationKey = 43;
    const before = makeChatBox({ scrollTop: 200, scrollHeight: 900 });
    const beforeMessage = appendElement(before, "llm-message-wrapper", {
      offsetTop: 0,
      offsetHeight: 800,
      dataset: { messageRole: "assistant", messageTimestamp: "1000" },
    });
    appendElement(beforeMessage, "llm-quote-card llm-quote-citation-anchor", {
      offsetTop: 230,
      offsetHeight: 40,
      dataset: { quoteCitationId: "quote-1" },
    });
    persistChatScrollSnapshotForConversationKey(
      conversationKey,
      before as unknown as HTMLDivElement,
    );

    const after = makeChatBox({ scrollTop: 0, scrollHeight: 1200 });
    appendElement(after, "llm-message-wrapper", {
      offsetTop: 0,
      offsetHeight: 1100,
      dataset: { messageRole: "assistant", messageTimestamp: "1000" },
    });

    const restored = restoreChatScrollSnapshotForConversationKey(
      conversationKey,
      after as unknown as HTMLDivElement,
    );

    assert.isTrue(restored);
    assert.equal(after.scrollTop, 200);
  });

  it("uses message anchors when no quote anchor is visible", function () {
    clearChatScrollSnapshotsForTests();
    const conversationKey = 44;
    const before = makeChatBox({ scrollTop: 200, scrollHeight: 900 });
    appendElement(before, "llm-message-wrapper", {
      offsetTop: 250,
      offsetHeight: 120,
      dataset: { messageRole: "assistant", messageTimestamp: "2000" },
    });
    persistChatScrollSnapshotForConversationKey(
      conversationKey,
      before as unknown as HTMLDivElement,
    );

    const after = makeChatBox({ scrollTop: 0, scrollHeight: 1200 });
    appendElement(after, "llm-message-wrapper", {
      offsetTop: 600,
      offsetHeight: 120,
      dataset: { messageRole: "assistant", messageTimestamp: "2000" },
    });

    const restored = restoreChatScrollSnapshotForConversationKey(
      conversationKey,
      after as unknown as HTMLDivElement,
    );

    assert.isTrue(restored);
    assert.equal(after.scrollTop, 550);
  });

  it("prefers stable message keys when duplicate timestamps are rerendered", function () {
    clearChatScrollSnapshotsForTests();
    const conversationKey = 440;
    const before = makeChatBox({
      scrollTop: 190,
      scrollHeight: 900,
      clientHeight: 120,
    });
    appendElement(before, "llm-message-wrapper", {
      offsetTop: 100,
      offsetHeight: 60,
      dataset: {
        messageRole: "user",
        messageTimestamp: "2000",
        messageIndex: "0",
        messageAnchorKey: "user:2000:0",
      },
    });
    appendElement(before, "llm-message-wrapper", {
      offsetTop: 200,
      offsetHeight: 80,
      dataset: {
        messageRole: "user",
        messageTimestamp: "2000",
        messageIndex: "2",
        messageAnchorKey: "user:2000:2",
      },
    });
    persistChatScrollSnapshotForConversationKey(
      conversationKey,
      before as unknown as HTMLDivElement,
    );

    const after = makeChatBox({ scrollTop: 0, scrollHeight: 1200 });
    appendElement(after, "llm-message-wrapper", {
      offsetTop: 250,
      offsetHeight: 60,
      dataset: {
        messageRole: "user",
        messageTimestamp: "2000",
        messageIndex: "0",
        messageAnchorKey: "user:2000:0",
      },
    });
    appendElement(after, "llm-message-wrapper", {
      offsetTop: 700,
      offsetHeight: 80,
      dataset: {
        messageRole: "user",
        messageTimestamp: "2000",
        messageIndex: "2",
        messageAnchorKey: "user:2000:2",
      },
    });

    assert.isTrue(
      restoreChatScrollSnapshotForConversationKey(
        conversationKey,
        after as unknown as HTMLDivElement,
      ),
    );
    assert.equal(after.scrollTop, 690);
  });

  it("owns the destination snapshot throughout a smooth navigation", function () {
    clearChatScrollSnapshotsForTests();
    const conversationKey = 441;
    const chatBox = makeChatBox({
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 100,
    });
    const target = appendElement(chatBox, "llm-message-wrapper", {
      offsetTop: 600,
      offsetHeight: 80,
      dataset: {
        messageRole: "user",
        messageTimestamp: "3000",
        messageIndex: "4",
        messageAnchorKey: "id:99",
      },
    });
    requestFollowBottomCatchup(conversationKey);

    assert.isTrue(
      navigateChatToMessage({
        conversationKey,
        chatBox: chatBox as unknown as HTMLDivElement,
        targetElement: target as unknown as Element,
        behavior: "smooth",
        viewportOffsetTop: 12,
      }),
    );
    assert.isTrue(isChatNavigationActive(chatBox as unknown as HTMLDivElement));
    assert.isFalse(hasActiveFollowBottomCatchupRequest(conversationKey));
    assert.equal(
      getActiveChatNavigationSnapshot(chatBox as never)?.scrollTop,
      588,
    );

    persistChatScrollSnapshotForConversationKey(
      conversationKey,
      chatBox as unknown as HTMLDivElement,
    );
    assert.equal(getChatScrollSnapshot(conversationKey)?.scrollTop, 588);

    cancelChatNavigation(chatBox as unknown as HTMLDivElement, false);
    assert.isFalse(
      isChatNavigationActive(chatBox as unknown as HTMLDivElement),
    );
  });

  it("cancels smooth navigation on manual scrolling input", function () {
    clearChatScrollSnapshotsForTests();
    const conversationKey = 442;
    const chatBox = makeChatBox({
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 100,
    });
    const target = appendElement(chatBox, "llm-message-wrapper", {
      offsetTop: 600,
      offsetHeight: 80,
      dataset: {
        messageRole: "user",
        messageTimestamp: "3000",
        messageIndex: "4",
      },
    });
    navigateChatToMessage({
      conversationKey,
      chatBox: chatBox as unknown as HTMLDivElement,
      targetElement: target as unknown as Element,
      behavior: "smooth",
    });

    chatBox.dispatch("wheel");

    assert.isFalse(
      isChatNavigationActive(chatBox as unknown as HTMLDivElement),
    );
    assert.notEqual(getChatScrollSnapshot(conversationKey)?.scrollTop, 600);
  });

  it("uses an immediate reduced-motion jump and guards its trailing scroll event", function () {
    clearChatScrollSnapshotsForTests();
    const conversationKey = 443;
    const chatBox = makeChatBox({
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 100,
    });
    const target = appendElement(chatBox, "llm-message-wrapper", {
      offsetTop: 600,
      offsetHeight: 80,
      dataset: {
        messageRole: "user",
        messageTimestamp: "3000",
        messageIndex: "4",
        messageAnchorKey: "id:101",
      },
    });

    assert.isTrue(
      navigateChatToMessage({
        conversationKey,
        chatBox: chatBox as unknown as HTMLDivElement,
        targetElement: target as unknown as Element,
        behavior: "auto",
        viewportOffsetTop: 12,
      }),
    );
    assert.equal(chatBox.scrollTop, 588);
    assert.equal(getChatScrollSnapshot(conversationKey)?.scrollTop, 588);
    assert.isUndefined(
      getActiveChatNavigationSnapshot(chatBox as unknown as HTMLDivElement),
    );
    assert.isTrue(isChatNavigationActive(chatBox as unknown as HTMLDivElement));

    chatBox.scrollTop = 300;
    persistChatScrollSnapshotForConversationKey(
      conversationKey,
      chatBox as unknown as HTMLDivElement,
    );
    assert.equal(getChatScrollSnapshot(conversationKey)?.scrollTop, 588);
    chatBox.dispatch("wheel");
    assert.isFalse(
      isChatNavigationActive(chatBox as unknown as HTMLDivElement),
    );
    persistChatScrollSnapshotForConversationKey(
      conversationKey,
      chatBox as unknown as HTMLDivElement,
    );
    assert.equal(getChatScrollSnapshot(conversationKey)?.scrollTop, 300);
  });

  it("re-resolves a replacement wrapper during an active jump", function () {
    clearChatScrollSnapshotsForTests();
    const conversationKey = 444;
    const chatBox = makeChatBox({
      scrollTop: 0,
      scrollHeight: 1200,
      clientHeight: 100,
    });
    const original = appendElement(chatBox, "llm-message-wrapper", {
      offsetTop: 600,
      offsetHeight: 80,
      dataset: {
        messageRole: "user",
        messageTimestamp: "3000",
        messageIndex: "4",
        messageAnchorKey: "id:102",
      },
    });
    navigateChatToMessage({
      conversationKey,
      chatBox: chatBox as unknown as HTMLDivElement,
      targetElement: original as unknown as Element,
      behavior: "smooth",
      viewportOffsetTop: 12,
    });

    chatBox.children.splice(chatBox.children.indexOf(original), 1);
    const replacement = appendElement(chatBox, "llm-message-wrapper", {
      offsetTop: 800,
      offsetHeight: 100,
      dataset: {
        messageRole: "user",
        messageTimestamp: "3000",
        messageIndex: "4",
        messageAnchorKey: "id:102",
      },
    });
    assert.isOk(replacement);
    const destination = getActiveChatNavigationSnapshot(
      chatBox as unknown as HTMLDivElement,
    );
    assert.isOk(destination);
    applyChatScrollSnapshot(chatBox as unknown as HTMLDivElement, destination!);

    assert.equal(chatBox.scrollTop, 788);
    assert.equal(getChatScrollSnapshot(conversationKey)?.scrollTop, 588);
    cancelChatNavigation(chatBox as unknown as HTMLDivElement, false);
  });

  it("preserves follow-bottom snapshots", function () {
    clearChatScrollSnapshotsForTests();
    const conversationKey = 45;
    const before = makeChatBox({ scrollTop: 800, scrollHeight: 900 });
    appendElement(before, "llm-message-wrapper", {
      offsetTop: 780,
      offsetHeight: 80,
      dataset: { messageRole: "assistant", messageTimestamp: "3000" },
    });
    persistChatScrollSnapshotForConversationKey(
      conversationKey,
      before as unknown as HTMLDivElement,
    );

    const after = makeChatBox({ scrollTop: 0, scrollHeight: 1200 });
    appendElement(after, "llm-message-wrapper", {
      offsetTop: 1100,
      offsetHeight: 80,
      dataset: { messageRole: "assistant", messageTimestamp: "3000" },
    });

    const restored = restoreChatScrollSnapshotForConversationKey(
      conversationKey,
      after as unknown as HTMLDivElement,
    );

    assert.isTrue(restored);
    assert.equal(after.scrollTop, 1200);
  });

  it("keeps a pending restore when normal resize persistence updates the snapshot", function () {
    clearChatScrollSnapshotsForTests();
    const conversationKey = 46;
    const before = makeChatBox({ scrollTop: 200, scrollHeight: 900 });
    const beforeMessage = appendElement(before, "llm-message-wrapper", {
      offsetTop: 0,
      offsetHeight: 800,
      dataset: { messageRole: "assistant", messageTimestamp: "4000" },
    });
    appendElement(beforeMessage, "llm-quote-card llm-quote-citation-anchor", {
      offsetTop: 230,
      offsetHeight: 40,
      dataset: { quoteCitationId: "quote-pending" },
    });
    persistPendingChatScrollRestoreForConversationKey(
      conversationKey,
      before as unknown as HTMLDivElement,
    );

    const resized = makeChatBox({ scrollTop: 10, scrollHeight: 900 });
    const resizedMessage = appendElement(resized, "llm-message-wrapper", {
      offsetTop: 0,
      offsetHeight: 800,
      dataset: { messageRole: "assistant", messageTimestamp: "other" },
    });
    appendElement(resizedMessage, "llm-quote-card llm-quote-citation-anchor", {
      offsetTop: 20,
      offsetHeight: 40,
      dataset: { quoteCitationId: "other-quote" },
    });
    persistChatScrollSnapshotForConversationKey(
      conversationKey,
      resized as unknown as HTMLDivElement,
    );

    const pending = consumePendingChatScrollRestoreForTests(
      conversationKey,
      resized as unknown as Element,
    );
    assert.equal(pending?.anchor?.quoteCitationId, "quote-pending");
  });

  it("uses the clicked citation as the pending restore anchor instead of the top visible quote", function () {
    clearChatScrollSnapshotsForTests();
    const conversationKey = 48;
    const body = new FakeElement("panel-body");
    const root = appendElement(body, "llm-panel", {
      offsetTop: 0,
      offsetHeight: 0,
      dataset: { itemId: String(conversationKey) },
    });
    root.id = "llm-main";
    const chatBox = makeChatBox({
      scrollTop: 100,
      scrollHeight: 1000,
      clientHeight: 260,
    });
    body.appendChild(chatBox);

    const message = appendElement(chatBox, "llm-message-wrapper", {
      offsetTop: 0,
      offsetHeight: 900,
      dataset: { messageRole: "assistant", messageTimestamp: "6000" },
    });
    appendElement(message, "llm-quote-card llm-quote-citation-anchor", {
      offsetTop: 110,
      offsetHeight: 40,
      dataset: { quoteCitationId: "top-visible" },
    });
    const clickedQuote = appendElement(
      message,
      "llm-quote-card llm-quote-citation-anchor",
      {
        offsetTop: 300,
        offsetHeight: 40,
        dataset: { quoteCitationId: "clicked-target" },
      },
    );
    const clickedButton = appendElement(clickedQuote, "llm-citation-icon", {
      offsetTop: 310,
      offsetHeight: 20,
      dataset: { citationSyncKey: "Target Source\u241fquote" },
    });

    persistPendingChatScrollRestoreForElement(
      body as unknown as Element,
      clickedButton as unknown as Element,
    );

    const pending = consumePendingChatScrollRestoreForTests(
      conversationKey,
      body as unknown as Element,
    );
    assert.equal(pending?.anchor?.quoteCitationId, "clicked-target");
  });

  it("keeps a pending restore available for each panel rendering the same conversation", function () {
    clearChatScrollSnapshotsForTests();
    const conversationKey = 47;
    const before = makeChatBox({ scrollTop: 200, scrollHeight: 900 });
    const beforeMessage = appendElement(before, "llm-message-wrapper", {
      offsetTop: 0,
      offsetHeight: 800,
      dataset: { messageRole: "assistant", messageTimestamp: "5000" },
    });
    appendElement(beforeMessage, "llm-quote-card llm-quote-citation-anchor", {
      offsetTop: 230,
      offsetHeight: 40,
      dataset: { quoteCitationId: "quote-once" },
    });
    persistPendingChatScrollRestoreForConversationKey(
      conversationKey,
      before as unknown as HTMLDivElement,
    );

    const sourcePanel = new FakeElement("panel-body");
    const targetPanel = new FakeElement("panel-body");
    const sourcePending = consumePendingChatScrollRestoreForTests(
      conversationKey,
      sourcePanel as unknown as Element,
    );
    assert.equal(sourcePending?.anchor?.quoteCitationId, "quote-once");
    assert.isUndefined(
      consumePendingChatScrollRestoreForTests(
        conversationKey,
        sourcePanel as unknown as Element,
      ),
    );

    const targetPending = consumePendingChatScrollRestoreForTests(
      conversationKey,
      targetPanel as unknown as Element,
    );
    assert.equal(targetPending?.anchor?.quoteCitationId, "quote-once");
  });

  it("captures sidebar scroll before full panel rebuild destroys the chat DOM", function () {
    const source = readFileSync(
      resolve(here, "../src/modules/contextPanel/index.ts"),
      "utf8",
    );
    const capture = source.indexOf(
      "persistPendingChatScrollRestoreFromBody(body)",
    );
    const rebuild = source.indexOf(
      "buildUI(body, resolvedState.item)",
      capture,
    );

    assert.isAtLeast(capture, 0);
    assert.isAbove(rebuild, capture);
  });

  it("captures chat scroll before citation navigation opens another reader", function () {
    const source = readFileSync(
      resolve(here, "../src/modules/contextPanel/assistantCitationLinks.ts"),
      "utf8",
    );
    const capture = source.indexOf(
      "persistPendingChatScrollRestoreForElement(",
    );
    const navigate = source.indexOf(
      "resolveAndNavigateAssistantCitation",
      capture,
    );

    assert.isAtLeast(capture, 0);
    assert.isAbove(navigate, capture);
  });

  it("captures pending restore before same-owner context refresh", function () {
    const source = readFileSync(
      resolve(here, "../src/modules/contextPanel/index.ts"),
      "utf8",
    );
    const branch = source.indexOf("if (sameOwnerContextSourceChanged)");
    const capture = source.indexOf(
      "persistPendingChatScrollRestoreFromBody(body)",
      branch,
    );
    const refresh = source.indexOf(
      "__llmRefreshContextSourceForCurrentItem",
      branch,
    );

    assert.isAtLeast(branch, 0);
    assert.isAbove(capture, branch);
    assert.isAbove(refresh, capture);
  });

  it("refreshChat lets pending restores win before cached conversation snapshots", function () {
    const source = readFileSync(
      resolve(here, "../src/modules/contextPanel/chat.ts"),
      "utf8",
    );
    const pending = source.indexOf("consumePendingChatScrollRestore");
    const cached = source.indexOf("getChatScrollSnapshot", pending);

    assert.isAtLeast(pending, 0);
    assert.isAbove(cached, pending);
  });

  it("refreshChat prefers the conversation snapshot over existing local panel content", function () {
    const source = readFileSync(
      resolve(here, "../src/modules/contextPanel/chat.ts"),
      "utf8",
    );

    assert.notInclude(source, "!hasExistingRenderedContent && cachedSnapshot");
    assert.include(source, ": cachedSnapshot");
  });

  it("renders stable message anchors for scroll restoration", function () {
    const source = readFileSync(
      resolve(here, "../src/modules/contextPanel/chat.ts"),
      "utf8",
    );
    const wrapper = source.indexOf("wrapper.className = `llm-message-wrapper");
    const role = source.indexOf("wrapper.dataset.messageRole", wrapper);
    const timestamp = source.indexOf(
      "wrapper.dataset.messageTimestamp",
      wrapper,
    );

    assert.isAtLeast(wrapper, 0);
    assert.isAbove(role, wrapper);
    assert.isAbove(timestamp, role);
  });
});
