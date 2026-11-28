/**
 * The floating close button of the inline cards (Inline Ask in the reader
 * and the note editor's inline writing popup): a small circle with an "×"
 * that sits on the card's top-left corner, half outside the card.
 *
 * It is hidden at rest and fades in while the pointer is near that corner
 * (or the button has keyboard focus). While hidden it takes no pointer
 * events, so the card under it keeps receiving the moves that reveal it.
 * The card must be positioned (fixed or absolute).
 */

import type { InlineAskPalette } from "./inlineAskPalette";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

/** The circle's diameter in px; its center is on the card's corner arc. */
const SIZE = 20;
/** How far from the card's top-left corner, in px, the pointer reveals it. */
const REVEAL_DISTANCE = 36;

export type InlineCardCloseButton = {
  button: HTMLButtonElement;
  /** Greys the button out while the card cannot be closed. */
  setDisabled(disabled: boolean): void;
  /** Starts and stops following the pointer over the card. */
  attach(): void;
  detach(): void;
};

export function createInlineCardCloseButton(
  doc: Document,
  card: HTMLElement,
  palette: InlineAskPalette,
  label: string,
): InlineCardCloseButton {
  const button = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  button.setAttribute(
    "style",
    [
      "position:absolute",
      "top:-8px",
      "left:-8px",
      "z-index:21",
      `width:${SIZE}px`,
      `height:${SIZE}px`,
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "padding:0",
      "margin:0",
      "box-sizing:border-box",
      "border-radius:999px",
      `border:1px solid ${palette.border}`,
      `background:${palette.bg}`,
      `color:${palette.labelFg}`,
      `box-shadow:${palette.menuShadow}`,
      "cursor:pointer",
      "opacity:0",
      "pointer-events:none",
      "transition:opacity 120ms ease, color 120ms ease",
    ].join(";"),
  );
  button.setAttribute("type", "button");
  button.setAttribute("title", label);
  button.setAttribute("aria-label", label);

  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "10");
  svg.setAttribute("height", "10");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("style", "display:block");
  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M4 4l8 8M12 4l-8 8");
  svg.appendChild(path);
  button.appendChild(svg);

  let near = false;
  let focused = false;
  let disabled = false;
  const sync = () => {
    const shown = near || focused;
    button.style.opacity = shown ? (disabled ? "0.45" : "1") : "0";
    button.style.pointerEvents = shown ? "auto" : "none";
    button.style.cursor = disabled ? "default" : "pointer";
    button.setAttribute("data-shown", shown ? "true" : "false");
  };

  const onCardPointerMove = (event: Event) => {
    const pointer = event as PointerEvent;
    const rect = card.getBoundingClientRect();
    const next =
      pointer.clientX - rect.left < REVEAL_DISTANCE &&
      pointer.clientY - rect.top < REVEAL_DISTANCE;
    if (next === near) return;
    near = next;
    sync();
  };
  const onCardPointerLeave = () => {
    if (!near) return;
    near = false;
    sync();
  };
  const onEnter = () => {
    if (!disabled) button.style.color = palette.fg;
  };
  const onLeave = () => {
    button.style.color = palette.labelFg;
  };
  const onFocus = () => {
    focused = true;
    sync();
  };
  const onBlur = () => {
    focused = false;
    sync();
  };
  // Pressing it keeps the focus (and the note's or page's selection) put.
  const onMouseDown = (event: Event) => event.preventDefault();

  const listeners: Array<[EventTarget, string, (event: Event) => void]> = [
    [card, "pointermove", onCardPointerMove],
    [card, "pointerleave", onCardPointerLeave],
    [button, "mouseenter", onEnter],
    [button, "mouseleave", onLeave],
    [button, "focus", onFocus],
    [button, "blur", onBlur],
    [button, "mousedown", onMouseDown],
  ];
  sync();

  return {
    button,
    setDisabled(next) {
      disabled = next;
      button.disabled = next;
      sync();
    },
    attach() {
      for (const [target, type, listener] of listeners)
        target.addEventListener(type, listener);
    },
    detach() {
      for (const [target, type, listener] of listeners)
        target.removeEventListener(type, listener);
    },
  };
}
