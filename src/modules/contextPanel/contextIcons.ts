import { createElement } from "../../utils/domHelpers";
import type { SelectedTextSource } from "./types";

export const CONTEXT_ICON_NAMES = [
  "paper",
  "pdf",
  "note",
  "image",
  "file",
  "collection",
  "tag",
  "text",
  "model",
  "model-chip",
  "papers",
] as const;

export type ContextIconName = (typeof CONTEXT_ICON_NAMES)[number];

export const NOTE_EDIT_PENCIL_ICON = "✎";

const CONTEXT_ICON_NAME_SET = new Set<string>(CONTEXT_ICON_NAMES);

export function isContextIconName(value: unknown): value is ContextIconName {
  return typeof value === "string" && CONTEXT_ICON_NAME_SET.has(value);
}

export function getContextIconClassName(iconName: ContextIconName): string {
  return `llm-context-icon-${iconName}`;
}

export function createContextIcon(
  ownerDoc: Document,
  iconName: ContextIconName,
  className = "",
): HTMLSpanElement {
  const icon = createElement(
    ownerDoc,
    "span",
    ["llm-context-svg-icon", getContextIconClassName(iconName), className]
      .filter(Boolean)
      .join(" "),
  );
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

export function getSelectedTextSourceIconName(
  source: SelectedTextSource,
): ContextIconName {
  if (source === "model") return "model";
  if (source === "note") return "note";
  return "text";
}

export function createSelectedTextSourceIcon(
  ownerDoc: Document,
  source: SelectedTextSource,
  className = "",
): HTMLSpanElement {
  if (source === "note-edit") {
    const icon = createElement(
      ownerDoc,
      "span",
      ["llm-context-glyph-icon", "llm-context-icon-note-edit", className]
        .filter(Boolean)
        .join(" "),
      { textContent: NOTE_EDIT_PENCIL_ICON },
    );
    icon.setAttribute("aria-hidden", "true");
    return icon;
  }
  return createContextIcon(
    ownerDoc,
    getSelectedTextSourceIconName(source),
    className,
  );
}
