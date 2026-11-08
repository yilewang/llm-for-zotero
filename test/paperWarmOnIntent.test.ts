import { assert } from "chai";
import {
  installPaperWarmOnIntent,
  type PaperWarmTarget,
} from "../src/modules/contextPanel/paperWarmOnIntent";

type Listener = (event: Event) => void;

function createFakeBody() {
  const listeners = new Map<string, Listener[]>();
  return {
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    },
    dispatch(type: string, insideComposer: boolean) {
      const target = {
        closest: (selector: string) =>
          insideComposer && selector === "#llm-input" ? {} : null,
      };
      for (const listener of listeners.get(type) || []) {
        listener({ type, target } as unknown as Event);
      }
    },
    listenerCount(type: string) {
      return (listeners.get(type) || []).length;
    },
  };
}

describe("paperWarmOnIntent", function () {
  it("does not read the paper until the user reaches for the composer", function () {
    const body = createFakeBody();
    const warmed: PaperWarmTarget[] = [];
    installPaperWarmOnIntent(
      body,
      () => ({ contextItemId: 7, conversationKey: 70 }),
      (target) => warmed.push(target),
    );
    assert.deepEqual(warmed, []);

    body.dispatch("focusin", false);
    assert.deepEqual(warmed, [], "focus outside the composer is not intent");

    body.dispatch("focusin", true);
    assert.deepEqual(warmed, [{ contextItemId: 7, conversationKey: 70 }]);
  });

  it("warms each paper once per panel, and the paper shown at that moment", function () {
    const body = createFakeBody();
    const warmed: number[] = [];
    let contextItemId = 1;
    installPaperWarmOnIntent(
      body,
      () => ({ contextItemId, conversationKey: 0 }),
      (target) => warmed.push(target.contextItemId),
    );
    body.dispatch("focusin", true);
    body.dispatch("input", true);
    body.dispatch("input", true);
    assert.deepEqual(warmed, [1], "typing does not re-warm per key");

    contextItemId = 2;
    body.dispatch("input", true);
    assert.deepEqual(warmed, [1, 2]);
  });

  it("skips panels with no paper and installs only once per body", function () {
    const body = createFakeBody();
    const warmed: number[] = [];
    const resolve = () => null;
    installPaperWarmOnIntent(body, resolve, (t) =>
      warmed.push(t.contextItemId),
    );
    installPaperWarmOnIntent(body, resolve, (t) =>
      warmed.push(t.contextItemId),
    );
    assert.equal(body.listenerCount("focusin"), 1);
    body.dispatch("focusin", true);
    assert.deepEqual(warmed, []);
  });
});
