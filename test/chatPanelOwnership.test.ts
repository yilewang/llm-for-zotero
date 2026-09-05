import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { readFileSync } from "node:fs";

import {
  ensureAgentRunTraceLoadedForTests,
  hasAgentRunTraceForTests,
  isPanelConversationCurrent,
  refreshChat,
  refreshConversationPanels,
  setAgentRunTraceLoaderForTests,
} from "../src/modules/contextPanel/chat";
import {
  activeContextPanels,
  activeContextPanelStateSync,
  clearAllState,
} from "../src/modules/contextPanel/state";
import {
  freezeConversationWrites,
  resetConversationWriteFenceForTests,
} from "../src/shared/conversationWriteFence";

function fakeItem(id: number): Zotero.Item {
  return {
    id,
    isAttachment: () => false,
  } as unknown as Zotero.Item;
}

function fakeBody(displayedConversationKey?: number): {
  body: Element;
  chatBox: { innerHTML: string };
} {
  const root = {
    dataset: {
      itemId: displayedConversationKey ? String(displayedConversationKey) : "",
    },
  };
  const chatBox = { innerHTML: "paper B remains rendered" };
  const body = {
    isConnected: true,
    querySelector: (selector: string) => {
      if (selector === "#llm-main") return root;
      if (selector === "#llm-chat-box") return chatBox;
      return null;
    },
  } as unknown as Element;
  return { body, chatBox };
}

describe("chat panel conversation ownership", function () {
  const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;

  beforeEach(() => {
    (globalThis as { Zotero?: unknown }).Zotero = {
      Prefs: { get: () => undefined },
      Items: { get: () => null },
      Libraries: { userLibraryID: 1 },
    };
  });

  afterEach(() => {
    setAgentRunTraceLoaderForTests();
    resetConversationWriteFenceForTests();
    clearAllState();
    if (originalZotero === undefined) {
      delete (globalThis as { Zotero?: unknown }).Zotero;
    } else {
      (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
    }
  });

  it("rejects stale item identity from either the rendered root or active panel", function () {
    const itemA = fakeItem(101);
    const itemB = fakeItem(202);
    const renderedB = fakeBody(202);
    activeContextPanels.set(renderedB.body, () => itemB);

    assert.isFalse(isPanelConversationCurrent(renderedB.body, itemA));
    assert.isTrue(isPanelConversationCurrent(renderedB.body, itemB));

    const activeBWithoutDataset = fakeBody();
    activeContextPanels.set(activeBWithoutDataset.body, () => itemB);
    assert.isFalse(
      isPanelConversationCurrent(activeBWithoutDataset.body, itemA),
    );
    assert.isTrue(
      isPanelConversationCurrent(activeBWithoutDataset.body, itemB),
    );
  });

  it("permits initial rendering before the panel has an established owner", function () {
    const unowned = fakeBody();
    assert.isTrue(isPanelConversationCurrent(unowned.body, fakeItem(101)));
  });

  it("makes a stale direct refreshChat call a complete no-op", function () {
    const itemA = fakeItem(101);
    const itemB = fakeItem(202);
    const renderedB = fakeBody(202);
    activeContextPanels.set(renderedB.body, () => itemB);

    refreshChat(renderedB.body, itemA);

    assert.equal(renderedB.chatBox.innerHTML, "paper B remains rendered");
  });

  it("refreshes only connected panels that own the target conversation", function () {
    const itemA = fakeItem(101);
    const itemB = fakeItem(202);
    const bodies = [
      fakeBody(101).body,
      fakeBody(101).body,
      fakeBody(202).body,
      fakeBody(101).body,
    ];
    Object.defineProperty(bodies[3], "isConnected", { value: false });
    const refreshCounts = [0, 0, 0, 0];
    bodies.forEach((body, index) => {
      const item = index === 2 ? itemB : itemA;
      activeContextPanels.set(body, () => item);
      activeContextPanelStateSync.set(body, () => {
        refreshCounts[index] += 1;
      });
    });

    refreshConversationPanels(bodies[0], itemA, {
      includeChat: false,
      includePanelState: true,
    });

    assert.deepEqual(refreshCounts, [1, 1, 0, 0]);
    assert.isFalse(activeContextPanels.has(bodies[3]));
  });

  it("caches a delayed A trace without repainting a body now owned by B", async function () {
    const itemA = fakeItem(101);
    const itemB = fakeItem(202);
    const renderedB = fakeBody(202);
    activeContextPanels.set(renderedB.body, () => itemB);

    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    let resolveTrace!: (value: { run: null; events: [] }) => void;
    const trace = new Promise<{ run: null; events: [] }>((resolve) => {
      resolveTrace = resolve;
    });
    setAgentRunTraceLoaderForTests(async () => {
      announceStarted();
      return trace;
    });

    const loading = ensureAgentRunTraceLoadedForTests(
      "agent-run-paper-a",
      renderedB.body,
      itemA,
    );
    await started;
    resolveTrace({ run: null, events: [] });
    await loading;

    assert.isTrue(hasAgentRunTraceForTests("agent-run-paper-a"));
    assert.equal(renderedB.chatBox.innerHTML, "paper B remains rendered");
  });

  it("does not cache or repaint a trace after the conversation is write-frozen", async function () {
    const itemA = fakeItem(101);
    const renderedA = fakeBody(101);
    activeContextPanels.set(renderedA.body, () => itemA);

    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    let resolveTrace!: (value: { run: null; events: [] }) => void;
    const trace = new Promise<{ run: null; events: [] }>((resolve) => {
      resolveTrace = resolve;
    });
    setAgentRunTraceLoaderForTests(async () => {
      announceStarted();
      return trace;
    });

    const loading = ensureAgentRunTraceLoadedForTests(
      "agent-run-frozen",
      renderedA.body,
      itemA,
    );
    await started;
    freezeConversationWrites(101);
    resolveTrace({ run: null, events: [] });
    await loading;

    assert.isFalse(hasAgentRunTraceForTests("agent-run-frozen"));
    assert.equal(renderedA.chatBox.innerHTML, "paper B remains rendered");
  });

  it("routes every delayed captured-item repaint through the guarded panel refresher", function () {
    const source = readFileSync("src/modules/contextPanel/chat.ts", "utf8");
    const traceLoader = source.slice(
      source.indexOf("async function ensureAgentRunTraceLoaded("),
      source.indexOf("function getCachedAgentRunEvents("),
    );
    assert.include(traceLoader, "refreshConversationPanels(body, item)");
    assert.notInclude(traceLoader, "refreshChat(body, item)");
    assert.notInclude(source, "setTimeout(() => refreshChat(body, item), 0)");

    const webChatRefresh = source.slice(
      source.indexOf('refreshBtn.addEventListener("click", async () =>'),
      source.indexOf("webchatStatusRow.appendChild(refreshBtn)"),
    );
    assert.include(webChatRefresh, "refreshConversationPanels(body, item)");
    assert.notInclude(webChatRefresh, "refreshChat(body, item)");
  });
});
