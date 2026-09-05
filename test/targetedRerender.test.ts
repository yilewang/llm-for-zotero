import { assert } from "chai";
import { describe, it } from "mocha";

import { resolveTargetedAssistantRerenders } from "../src/modules/contextPanel/targetedRerender";

type FakeMessage = { role: string; text: string };
type FakeWrapper = { dataset: { messageRole?: string; messageIndex?: string } };

function wrapperFor(index: number, role = "assistant"): FakeWrapper {
  return { dataset: { messageRole: role, messageIndex: `${index}` } };
}

describe("resolveTargetedAssistantRerenders", function () {
  const user: FakeMessage = { role: "user", text: "question" };
  const assistant: FakeMessage = { role: "assistant", text: "answer" };

  it("does not target when no rerenders are requested", function () {
    for (const requested of [undefined, new Set<FakeMessage>()]) {
      const resolution = resolveTargetedAssistantRerenders(
        [user, assistant],
        requested,
        [wrapperFor(0, "user"), wrapperFor(1)],
      );
      assert.isFalse(resolution.useTargetedRerender);
      assert.strictEqual(resolution.targetedMessageWrappers.size, 0);
    }
  });

  it("targets a streaming assistant message whose wrapper is rendered", function () {
    const wrappers = [wrapperFor(0, "user"), wrapperFor(1)];
    const resolution = resolveTargetedAssistantRerenders(
      [user, assistant],
      new Set([assistant]),
      wrappers,
    );
    assert.isTrue(resolution.useTargetedRerender);
    assert.strictEqual(
      resolution.targetedMessageWrappers.get(assistant),
      wrappers[1],
    );
  });

  it("falls back to full render for user messages", function () {
    const resolution = resolveTargetedAssistantRerenders(
      [user, assistant],
      new Set([user]),
      [wrapperFor(0, "user"), wrapperFor(1)],
    );
    assert.isFalse(resolution.useTargetedRerender);
    assert.strictEqual(resolution.targetedMessageWrappers.size, 0);
  });

  it("falls back to full render when the message left the history", function () {
    const detached: FakeMessage = { role: "assistant", text: "gone" };
    const resolution = resolveTargetedAssistantRerenders(
      [user, assistant],
      new Set([detached]),
      [wrapperFor(0, "user"), wrapperFor(1)],
    );
    assert.isFalse(resolution.useTargetedRerender);
  });

  it("falls back to full render when the wrapper is not in the DOM yet", function () {
    // First streaming flush can fire before the assistant bubble is rendered.
    const resolution = resolveTargetedAssistantRerenders(
      [user, assistant],
      new Set([assistant]),
      [wrapperFor(0, "user")],
    );
    assert.isFalse(resolution.useTargetedRerender);
    assert.strictEqual(resolution.targetedMessageWrappers.size, 0);
  });

  it("falls back when the wrapper at the index is not an assistant wrapper", function () {
    const resolution = resolveTargetedAssistantRerenders(
      [user, assistant],
      new Set([assistant]),
      [wrapperFor(0, "user"), wrapperFor(1, "user")],
    );
    assert.isFalse(resolution.useTargetedRerender);
  });

  it("rejects the whole batch when any requested message is untargetable", function () {
    const second: FakeMessage = { role: "assistant", text: "second" };
    const history = [user, assistant, second];
    const wrappers = [wrapperFor(0, "user"), wrapperFor(1)]; // second not rendered
    const resolution = resolveTargetedAssistantRerenders(
      history,
      new Set([assistant, second]),
      wrappers,
    );
    assert.isFalse(resolution.useTargetedRerender);
    assert.strictEqual(resolution.targetedMessageWrappers.size, 0);
  });

  it("targets multiple assistant messages at once", function () {
    const second: FakeMessage = { role: "assistant", text: "second" };
    const history = [user, assistant, second];
    const wrappers = [wrapperFor(0, "user"), wrapperFor(1), wrapperFor(2)];
    const resolution = resolveTargetedAssistantRerenders(
      history,
      new Set([assistant, second]),
      wrappers,
    );
    assert.isTrue(resolution.useTargetedRerender);
    assert.strictEqual(resolution.targetedMessageWrappers.size, 2);
    assert.strictEqual(
      resolution.targetedMessageWrappers.get(second),
      wrappers[2],
    );
  });
});
