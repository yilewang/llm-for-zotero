/**
 * The Task progress button: left of Export in the standalone window's title
 * bar, and left of Open in Window in the sidebar header. A click shows the
 * row for the conversation on screen, or hides it; `panel.ts` keeps that
 * choice and binds the button to its chat panel. The button is pressed while the row shows, whether the user or the
 * automatic rule showed it, and is out of the title bar where the row never
 * shows (WebChat, a note chat, no conversation). The Stacked sidebar header
 * also drops it below its compact width (CSS).
 */
import { HTML_NS } from "../../../utils/domHelpers";
import { t } from "../../../utils/i18n";

export type TaskProgressToggleState = {
  /** The row can show in this panel's conversation and mode. */
  applies: boolean;
  /** The row shows (its target; it may still be moving). */
  shown: boolean;
};

export function createTaskProgressToggleButton(
  doc: Document,
  className = "llm-standalone-title-action llm-standalone-icon-task-progress",
): HTMLButtonElement {
  const button = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  button.className = className;
  button.type = "button";
  applyTaskProgressToggleState(button, { applies: false, shown: false });
  return button;
}

/** Write only what changed: a repaint during an answer causes no mutation. */
export function applyTaskProgressToggleState(
  button: HTMLButtonElement,
  state: TaskProgressToggleState,
): void {
  const display = state.applies ? "" : "none";
  if (button.style.display !== display) button.style.display = display;
  const pressed = state.applies && state.shown;
  const pressedAttr = pressed ? "true" : "false";
  if (button.getAttribute("aria-pressed") !== pressedAttr)
    button.setAttribute("aria-pressed", pressedAttr);
  const label = t(pressed ? "Hide task progress" : "Show task progress");
  if (button.title !== label) button.title = label;
  if (button.getAttribute("aria-label") !== label)
    button.setAttribute("aria-label", label);
}
