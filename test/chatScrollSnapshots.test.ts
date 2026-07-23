import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { describe, it } from "mocha";

import {
  clearChatScrollSnapshotsForTests,
  consumePendingChatScrollRestoreForTests,
  persistPendingChatScrollRestoreForConversationKey,
  persistPendingChatScrollRestoreForElement,
  persistChatScrollSnapshotForConversationKey,
  restoreChatScrollSnapshotForConversationKey,
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
  return false;
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
    assert.include(validationTaskSource, "new Set([assistantMessage])");
    assert.notInclude(validationTaskSource, "changedMessages.add(");
    assert.include(refreshChatSource, "targetedMessageWrappers");
    assert.include(
      refreshChatSource,
      "candidate.dataset.messageIndex === `${messageIndex}`",
    );
    assert.include(
      refreshChatSource,
      "wrapper.dataset.messageIndex = `${index}`",
    );
    assert.include(refreshChatSource, "existingTargetedWrapper.replaceWith");
    assert.include(refreshChatSource, "if (!useTargetedRerender)");
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
