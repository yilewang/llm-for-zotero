/**
 * Shared DOM helpers used across UI modules.
 */

export const HTML_NS = "http://www.w3.org/1999/xhtml";

/** Create an HTML element with optional class and properties. */
export function createElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  props?: Partial<HTMLElementTagNameMap[K]>,
): HTMLElementTagNameMap[K] {
  const el = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (className) el.className = className;
  if (props) Object.assign(el, props);
  return el;
}

/** Create an HTML element with an inline style string and optional text. */
export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  style?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (style) node.setAttribute("style", style);
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The 22×22 borderless icon button (×, ⟳, …) used across the settings UI.
 * One definition so every instance renders identically and carries the
 * accessible label.
 */
export function iconBtn(
  doc: Document,
  label: string,
  title: string,
): HTMLButtonElement {
  const btn = el(
    doc,
    "button",
    "padding: 0; width: 22px; height: 22px; border: none; background: transparent;" +
      " color: var(--fill-secondary, #888); font-size: 16px; font-weight: 500;" +
      " display: inline-flex; align-items: center; justify-content: center;" +
      " cursor: pointer; flex-shrink: 0; border-radius: 4px; line-height: 1;",
    label,
  ) as HTMLButtonElement;
  btn.type = "button";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  return btn;
}
