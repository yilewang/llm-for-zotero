import { assert } from "chai";
import { createChatInputLock } from "../src/modules/contextPanel/chatInputLock";

describe("chatInputLock", function () {
  it("stops input only while locked", function () {
    const chatBox = new EventTarget();
    const lock = createChatInputLock(chatBox);
    const dispatch = (type: string) => {
      const event = new Event(type, { cancelable: true, bubbles: true });
      chatBox.dispatchEvent(event);
      return event.defaultPrevented;
    };
    assert.isFalse(lock.isLocked());
    assert.isFalse(dispatch("click"));
    lock.lock();
    assert.isTrue(lock.isLocked());
    for (const type of ["click", "mousedown", "contextmenu", "keydown"]) {
      assert.isTrue(dispatch(type), `${type} is stopped while locked`);
    }
    assert.isFalse(dispatch("wheel"), "scrolling stays available");
    lock.unlock();
    assert.isFalse(dispatch("click"));
  });
});
