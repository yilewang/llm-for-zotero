/**
 * Keeps a chat box's messages from taking input while the panel switches to
 * another conversation in place.
 *
 * The `inert` attribute does this too, but it changes the style of every
 * message under the chat box: setting and clearing it restyled a long
 * conversation twice per switch (two long frames). Capture listeners on the
 * chat box stop the same input without any style change.
 */

const LOCKED_INPUT_EVENTS = [
  "click",
  "dblclick",
  "auxclick",
  "mousedown",
  "mouseup",
  "pointerdown",
  "pointerup",
  "contextmenu",
  "keydown",
  "keypress",
  "beforeinput",
  "dragstart",
  "drop",
] as const;

export type ChatInputLock = {
  lock(): void;
  unlock(): void;
  isLocked(): boolean;
};

export function createChatInputLock(chatBox: EventTarget): ChatInputLock {
  let locked = false;
  const blockInput = (event: Event) => {
    if (!locked) return;
    event.preventDefault();
    event.stopPropagation();
  };
  for (const type of LOCKED_INPUT_EVENTS) {
    chatBox.addEventListener(type, blockInput, true);
  }
  return {
    lock: () => {
      locked = true;
    },
    unlock: () => {
      locked = false;
    },
    isLocked: () => locked,
  };
}
