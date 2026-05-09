import { normalizeSelectedText } from "./textUtils";

function isSelectionInsideEditableSurface(
  node: Node | null | undefined,
  doc: Document,
): boolean {
  if (!node) return false;
  const HTMLElementCtor = doc.defaultView?.HTMLElement;
  const elementNodeType = doc.defaultView?.Node?.ELEMENT_NODE ?? 1;
  let el: Element | null =
    node.nodeType === elementNodeType ? (node as Element) : node.parentElement;
  while (el) {
    if (el.id === "llm-main" || el.closest?.("#llm-main")) {
      return false;
    }
    const htmlEl =
      HTMLElementCtor && el instanceof HTMLElementCtor
        ? (el as HTMLElement)
        : null;
    if (htmlEl?.isContentEditable) {
      return true;
    }
    el = el.parentElement;
  }
  return Boolean(doc.body?.isContentEditable);
}

function isEditableTextControlElement(
  el: Element | null | undefined,
  doc: Document,
): el is HTMLTextAreaElement | HTMLInputElement {
  if (!el || el.id === "llm-main" || el.closest?.("#llm-main")) {
    return false;
  }
  const HTMLTextAreaCtor = doc.defaultView?.HTMLTextAreaElement;
  if (HTMLTextAreaCtor && el instanceof HTMLTextAreaCtor) {
    return true;
  }
  const HTMLInputCtor = doc.defaultView?.HTMLInputElement;
  if (!(HTMLInputCtor && el instanceof HTMLInputCtor)) {
    return false;
  }
  const inputEl = el as HTMLInputElement;
  const inputType = `${inputEl.type || "text"}`.trim().toLowerCase();
  return (
    !inputType ||
    inputType === "text" ||
    inputType === "search" ||
    inputType === "url" ||
    inputType === "tel" ||
    inputType === "email" ||
    inputType === "password"
  );
}

function getEditableTextControlSelectionFromDocument(doc: Document): string {
  const activeEl = doc.activeElement;
  if (!isEditableTextControlElement(activeEl, doc)) {
    return "";
  }
  const selectionStart =
    typeof activeEl.selectionStart === "number" ? activeEl.selectionStart : -1;
  const selectionEnd =
    typeof activeEl.selectionEnd === "number" ? activeEl.selectionEnd : -1;
  if (
    selectionStart < 0 ||
    selectionEnd < 0 ||
    selectionStart === selectionEnd
  ) {
    return "";
  }
  return normalizeSelectedText(
    activeEl.value.slice(
      Math.min(selectionStart, selectionEnd),
      Math.max(selectionStart, selectionEnd),
    ),
  );
}

export function getEditableSelectionFromDocument(doc: Document): string {
  const fromTextControl = getEditableTextControlSelectionFromDocument(doc);
  if (fromTextControl) {
    return fromTextControl;
  }
  const selection = doc.defaultView?.getSelection?.() || null;
  const selectedText = normalizeSelectedText(selection?.toString() || "");
  if (!selection || !selectedText || selection.isCollapsed) {
    return "";
  }
  if (
    !isSelectionInsideEditableSurface(selection.anchorNode, doc) ||
    !isSelectionInsideEditableSurface(selection.focusNode, doc)
  ) {
    return "";
  }
  return selectedText;
}
