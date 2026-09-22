import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
  bindChatLatestButton,
  createChatLatestButton,
} from "../src/modules/contextPanel/chatLatestButton";
import {
  clearAllState,
  finishRequest,
  tryBeginRequest,
} from "../src/modules/contextPanel/state";
import { t } from "../src/utils/i18n";
import { fakeDocument, FakeElement } from "./helpers/fakeDom";

describe("chat latest message button", function () {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    clearAllState();
  });

  function fixture() {
    let key: number | null = 101;
    let jumps = 0;
    let handle = 0;
    const frames = new Map<number, FrameRequestCallback>();
    const timers = new Map<number, () => void>();
    let onMutation: (records: MutationRecord[]) => void = () => {};
    let onResize: () => void = () => {};
    const observed = new Set<Element>();
    let mutationDisconnected = false;
    const win = {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frames.set(++handle, callback);
        return handle;
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
      setTimeout: (callback: () => void) => {
        timers.set(++handle, callback);
        return handle;
      },
      clearTimeout: (id: number) => timers.delete(id),
      MutationObserver: class {
        constructor(callback: typeof onMutation) {
          onMutation = callback;
        }
        observe() {}
        disconnect() {
          mutationDisconnected = true;
        }
      },
      ResizeObserver: class {
        constructor(callback: () => void) {
          onResize = callback;
        }
        observe(element: Element) {
          observed.add(element);
        }
        unobserve(element: Element) {
          observed.delete(element);
        }
        disconnect() {
          observed.clear();
        }
      },
    };
    const chatBox = Object.assign(new EventTarget(), {
      ownerDocument: { defaultView: win },
      scrollTop: 600,
      scrollHeight: 800,
      clientHeight: 200,
      children: [new FakeElement("div")],
    }) as unknown as HTMLDivElement;
    const button = createChatLatestButton(fakeDocument);
    const dispose = bindChatLatestButton({
      button,
      chatBox,
      getConversationKey: () => key,
      onJumpToLatest: () => {
        jumps++;
        chatBox.scrollTop = chatBox.scrollHeight - chatBox.clientHeight;
        chatBox.dispatchEvent(new Event("scroll"));
      },
    });
    disposers.push(dispose);
    return {
      button,
      chatBox,
      dispose,
      frames,
      timers,
      observed,
      get jumps() {
        return jumps;
      },
      get mutationDisconnected() {
        return mutationDisconnected;
      },
      setKey: (value: number | null) => {
        key = value;
      },
      mutate: () =>
        onMutation([{ target: chatBox } as unknown as MutationRecord]),
      resize: () => onResize(),
      click: () =>
        (button as unknown as FakeElement).dispatchFakeEvent("click"),
      flush: () => {
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback(0);
      },
    };
  }

  it("shows generation while reading older messages and keeps a way back after completion", function () {
    const view = fixture();
    assert.isTrue(view.button.hidden);
    assert.equal(view.button.type, "button");
    assert.isTrue(tryBeginRequest(101, 1, new AbortController()));
    view.flush();
    assert.isTrue(view.button.hidden);

    view.chatBox.scrollTop = 200;
    view.chatBox.dispatchEvent(new Event("scroll"));
    view.flush();
    assert.isFalse(view.button.hidden);
    assert.equal(view.button.dataset.pending, "true");
    assert.equal(
      view.button.getAttribute("aria-label"),
      t("Response in progress. Jump to latest message"),
    );
    view.chatBox.scrollHeight = 1200;
    view.mutate();
    view.flush();
    assert.equal(view.chatBox.scrollTop, 200);
    assert.equal(view.jumps, 0);

    assert.isTrue(finishRequest(101, 1));
    view.flush();
    assert.isFalse(view.button.hidden);
    assert.equal(view.button.dataset.pending, "false");
    assert.equal(view.button.title, t("Jump to latest message"));
    view.click();
    view.flush();
    assert.equal(view.jumps, 1);
    assert.equal(view.chatBox.scrollTop, 1000);
    assert.isTrue(view.button.hidden);
    assert.isEmpty([...view.frames]);
    assert.isEmpty([...view.timers]);
  });

  it("uses the current conversation's activity when a panel switches conversations", function () {
    const view = fixture();
    view.chatBox.scrollTop = 200;
    view.chatBox.dispatchEvent(new Event("scroll"));
    view.flush();
    tryBeginRequest(202, 2, new AbortController());
    assert.isEmpty([...view.frames]);
    assert.equal(view.button.dataset.pending, "false");
    view.setKey(202);
    view.mutate();
    view.flush();
    assert.isFalse(view.button.hidden);
    assert.equal(view.button.dataset.pending, "true");
    view.setKey(null);
    view.mutate();
    view.flush();
    assert.isTrue(view.button.hidden);
    view.click();
    assert.equal(view.jumps, 0);
  });

  it("updates for media growth and viewport resize without moving the reading position", function () {
    const view = fixture();
    const oldMessage = view.chatBox.children[0];
    const replacement = new FakeElement("div") as unknown as Element;
    Object.assign(view.chatBox, { children: [replacement] });
    view.mutate();
    view.flush();
    assert.isFalse(view.observed.has(oldMessage));
    assert.isTrue(view.observed.has(replacement));

    view.chatBox.scrollHeight = 900;
    view.resize();
    view.flush();
    assert.isFalse(view.button.hidden);
    assert.equal(view.chatBox.scrollTop, 600);
    Object.assign(view.chatBox, { clientHeight: 300 });
    view.resize();
    view.flush();
    assert.isTrue(view.button.hidden);
    assert.equal(view.chatBox.scrollTop, 600);
  });

  it("removes observers, request subscriptions, clicks, and queued updates on disposal", function () {
    const view = fixture();
    view.chatBox.scrollTop = 200;
    view.mutate();
    assert.equal(view.frames.size, 1);
    view.dispose();
    assert.isTrue(view.mutationDisconnected);
    assert.isEmpty([...view.observed]);
    assert.isEmpty([...view.frames]);
    assert.isEmpty([...view.timers]);
    view.click();
    view.chatBox.dispatchEvent(new Event("scroll"));
    tryBeginRequest(101, 1, new AbortController());
    view.flush();
    assert.isEmpty([...view.frames]);
    assert.equal(view.jumps, 0);
    assert.isTrue(view.button.hidden);
  });
});
