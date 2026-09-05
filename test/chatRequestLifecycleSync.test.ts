import { assert } from "chai";
import { describe, it, afterEach } from "mocha";
import { readFileSync } from "node:fs";

import {
  clearPendingRequestIdAndSync,
  finishPanelRequest,
} from "../src/modules/contextPanel/chat";
import {
  activeContextPanels,
  activeContextPanelStateSync,
  clearAllState,
  finishRequest,
  getAbortController,
  getPendingRequestId,
  isRequestOwner,
  isRequestPending,
  setPendingRequestId,
  transferRequest,
  tryBeginRequest,
} from "../src/modules/contextPanel/state";

function fakeItem(id: number): Zotero.Item {
  return {
    id,
    isAttachment: () => false,
  } as unknown as Zotero.Item;
}

function fakePanelBody(conversationKey: number): Element {
  const root = {
    dataset: { itemId: String(conversationKey) },
  };
  return {
    isConnected: true,
    querySelector: (selector: string) =>
      selector === "#llm-main" ? root : null,
  } as unknown as Element;
}

describe("chat request lifecycle sync", function () {
  afterEach(() => {
    clearAllState();
  });

  it("resyncs another live panel when a shared conversation finishes", function () {
    const conversationKey = 101;
    const sourceBody = fakePanelBody(conversationKey);
    const standaloneBody = fakePanelBody(conversationKey);
    const unrelatedBody = fakePanelBody(202);
    const synced: number[] = [];

    activeContextPanels.set(standaloneBody, () => fakeItem(conversationKey));
    activeContextPanels.set(unrelatedBody, () => fakeItem(202));
    activeContextPanelStateSync.set(standaloneBody, () =>
      synced.push(conversationKey),
    );
    activeContextPanelStateSync.set(unrelatedBody, () => synced.push(202));

    setPendingRequestId(conversationKey, 7);
    assert.isTrue(isRequestPending(conversationKey));

    clearPendingRequestIdAndSync(
      conversationKey,
      sourceBody,
      fakeItem(conversationKey),
    );

    assert.isFalse(isRequestPending(conversationKey));
    assert.deepEqual(synced, [conversationKey]);
  });

  it("admits only one synchronous owner for a conversation", function () {
    const firstController = new AbortController();
    const secondController = new AbortController();

    assert.isTrue(tryBeginRequest(101, 7, firstController));
    assert.isFalse(tryBeginRequest(101, 8, secondController));
    assert.equal(getPendingRequestId(101), 7);
    assert.strictEqual(getAbortController(101), firstController);
    assert.isTrue(isRequestOwner(101, 7));
    assert.isFalse(isRequestOwner(101, 8));
  });

  it("does not let a stale completion release a newer request", function () {
    assert.isTrue(tryBeginRequest(101, 7, new AbortController()));
    assert.isTrue(finishRequest(101, 7));
    assert.isTrue(tryBeginRequest(101, 8, new AbortController()));

    assert.isFalse(finishRequest(101, 7));
    assert.isTrue(isRequestOwner(101, 8));
  });

  it("does not resync or restore a panel for a stale finalizer", function () {
    const body = fakePanelBody(101);
    let syncCalls = 0;
    activeContextPanelStateSync.set(body, () => {
      syncCalls += 1;
    });
    assert.isTrue(tryBeginRequest(101, 8, new AbortController()));

    assert.isFalse(finishPanelRequest(body, fakeItem(101), 101, 7));
    assert.equal(syncCalls, 0);
    assert.isTrue(isRequestOwner(101, 8));
  });

  it("moves ownership without opening a concurrent admission window", function () {
    const controller = new AbortController();
    assert.isTrue(tryBeginRequest(101, 7, controller));

    assert.isTrue(transferRequest(101, 202, 7));
    assert.isFalse(isRequestPending(101));
    assert.isTrue(isRequestOwner(202, 7));
    assert.strictEqual(getAbortController(202), controller);
  });

  it("claims an inline edit before asynchronous context preparation", function () {
    const source = readFileSync(
      "src/modules/contextPanel/setupHandlers.ts",
      "utf8",
    );
    const inlineStart = source.indexOf("if (inlineEditTarget && item) {");
    const inlineEnd = source.indexOf(
      "if (isQueuedFollowUpSendAvailable())",
      inlineStart,
    );
    const inlineBlock = source.slice(inlineStart, inlineEnd);
    const admission = inlineBlock.indexOf("beginPanelRequest(");
    const contextPreparation = inlineBlock.indexOf(
      "await resolveAutoLoadedContextSourceAsync()",
    );
    const pdfPreparation = inlineBlock.indexOf(
      "await resolvePdfModeModelInputs(",
    );

    assert.isAtLeast(admission, 0);
    assert.isBelow(admission, contextPreparation);
    assert.isBelow(admission, pdfPreparation);
    assert.include(
      inlineBlock,
      "!newText && isRequestPending(getConversationKey(currentItem))",
    );
  });
});
