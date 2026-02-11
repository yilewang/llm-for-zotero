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
