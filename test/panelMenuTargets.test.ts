import { assert } from "chai";
import { describe, it } from "mocha";
import {
  clearConversationOwnedRuntimeState,
  clearPromptMenuTargetsContaining,
  clearResponseMenuTargetsContaining,
  getPromptMenuTarget,
  getResponseMenuTarget,
  releaseMenuTargets,
  setPromptMenuTarget,
  setResponseMenuTarget,
  type ResponseActionTarget,
} from "../src/modules/contextPanel/state";

class FakePanel {
  parentElement: FakePanel | null = null;
}

const item = { id: 1, libraryID: 1 } as unknown as Zotero.Item;
const responseTarget = (conversationKey: number): ResponseActionTarget => ({
  item,
  contentText: "",
  queryText: "q",
  modelName: "m",
  conversationKey,
  userTimestamp: 1,
  assistantTimestamp: 2,
});
const promptTarget = (conversationKey: number) => ({
  item,
  conversationKey,
  userTimestamp: 1,
  assistantTimestamp: 2,
});

describe("response and prompt menu targets are per panel", function () {
  it("one panel's menu target does not replace another panel's", function () {
    const windowBody = new FakePanel() as unknown as Element;
    const sidebarBody = new FakePanel() as unknown as Element;
    setResponseMenuTarget(windowBody, responseTarget(1));
    setPromptMenuTarget(windowBody, promptTarget(1));
    setResponseMenuTarget(sidebarBody, responseTarget(2));
    setPromptMenuTarget(sidebarBody, promptTarget(2));
    assert.equal(getResponseMenuTarget(windowBody)?.conversationKey, 1);
    assert.equal(getPromptMenuTarget(windowBody)?.conversationKey, 1);
    setResponseMenuTarget(sidebarBody, null);
    assert.isNull(getResponseMenuTarget(sidebarBody));
    assert.equal(getResponseMenuTarget(windowBody)?.conversationKey, 1);
    releaseMenuTargets(windowBody);
    releaseMenuTargets(sidebarBody);
    assert.isNull(getPromptMenuTarget(windowBody));
  });

  it("closing a panel's menu clears only the target of the panel that holds it", function () {
    const bodyA = new FakePanel();
    const bodyB = new FakePanel();
    const menuA = new FakePanel();
    menuA.parentElement = bodyA;
    setResponseMenuTarget(bodyA as unknown as Element, responseTarget(1));
    setResponseMenuTarget(bodyB as unknown as Element, responseTarget(2));
    setPromptMenuTarget(bodyA as unknown as Element, promptTarget(1));
    clearResponseMenuTargetsContaining(menuA as unknown as Element);
    assert.isNull(getResponseMenuTarget(bodyA as unknown as Element));
    assert.equal(
      getResponseMenuTarget(bodyB as unknown as Element)?.conversationKey,
      2,
    );
    assert.equal(
      getPromptMenuTarget(bodyA as unknown as Element)?.conversationKey,
      1,
    );
    clearPromptMenuTargetsContaining(menuA as unknown as Element);
    assert.isNull(getPromptMenuTarget(bodyA as unknown as Element));
    releaseMenuTargets(bodyB as unknown as Element);
  });

  it("deleting a conversation clears every panel's menu target for it", function () {
    const bodyA = new FakePanel() as unknown as Element;
    const bodyB = new FakePanel() as unknown as Element;
    setResponseMenuTarget(bodyA, responseTarget(41));
    setPromptMenuTarget(bodyB, promptTarget(41));
    setResponseMenuTarget(bodyB, responseTarget(42));
    clearConversationOwnedRuntimeState(41);
    assert.isNull(getResponseMenuTarget(bodyA));
    assert.isNull(getPromptMenuTarget(bodyB));
    assert.equal(getResponseMenuTarget(bodyB)?.conversationKey, 42);
    releaseMenuTargets(bodyB);
  });
});
