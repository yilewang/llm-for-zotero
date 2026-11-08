import { assert } from "chai";
import {
  allocateTornSurface,
  findTornWindowForConversation,
  getTornChatWindows,
  registerTornChatWindow,
  setTornWindowConversation,
} from "../src/modules/contextPanel/tornChatWindows";

/** A stand-in for a chat window: the registry reads only `closed`. */
function fakeWindow(): Window {
  return { closed: false, close() {} } as unknown as Window;
}

describe("tornChatWindows: one window per chat", function () {
  const disposers: Array<() => void> = [];

  /** A registered follower, unregistered after the case. */
  function openFake(): { win: Window; dispose: () => void } {
    const win = fakeWindow();
    const dispose = registerTornChatWindow(win, allocateTornSurface());
    disposers.push(dispose);
    return { win, dispose };
  }

  afterEach(function () {
    for (const dispose of disposers.splice(0)) dispose();
  });

  it("finds the follower that holds a chat", function () {
    const { win } = openFake();
    setTornWindowConversation(win, 101);
    assert.isTrue(findTornWindowForConversation(101) === win);
    assert.isNull(findTornWindowForConversation(102));
  });

  it("matches a key given as a number or as a string", function () {
    const { win } = openFake();
    setTornWindowConversation(win, "103");
    assert.isTrue(findTornWindowForConversation(103) === win);
    setTornWindowConversation(win, 104);
    assert.isTrue(findTornWindowForConversation("104") === win);
  });

  it("moves a follower's entry when it switches chats in place", function () {
    const { win } = openFake();
    setTornWindowConversation(win, 105);
    setTornWindowConversation(win, 106);
    assert.isNull(
      findTornWindowForConversation(105),
      "the chat the follower left is free",
    );
    assert.isTrue(findTornWindowForConversation(106) === win);
  });

  it("tells two followers apart", function () {
    const first = openFake();
    const second = openFake();
    setTornWindowConversation(first.win, 107);
    setTornWindowConversation(second.win, 108);
    assert.isTrue(findTornWindowForConversation(107) === first.win);
    assert.isTrue(findTornWindowForConversation(108) === second.win);
  });

  it("forgets a follower when its window unloads", function () {
    const { win, dispose } = openFake();
    setTornWindowConversation(win, 109);
    dispose();
    assert.isNull(findTornWindowForConversation(109));
    assert.notInclude(getTornChatWindows(), win);
  });

  it("never returns a closed window", function () {
    const { win } = openFake();
    setTornWindowConversation(win, 110);
    (win as unknown as { closed: boolean }).closed = true;
    assert.isNull(findTornWindowForConversation(110));
  });

  it("ignores a window that is not a registered follower", function () {
    const stray = fakeWindow();
    setTornWindowConversation(stray, 111);
    assert.isNull(findTornWindowForConversation(111));
  });

  it("finds nothing for an empty or invalid key", function () {
    const { win } = openFake();
    setTornWindowConversation(win, 112);
    assert.isNull(findTornWindowForConversation(0));
    assert.isNull(findTornWindowForConversation(""));
    assert.isNull(findTornWindowForConversation("not-a-key"));
  });
});
