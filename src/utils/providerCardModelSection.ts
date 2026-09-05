import { el, iconBtn } from "./domHelpers";

export const PROVIDER_MODEL_CONTROL_STYLE =
  "flex: 1; min-width: 0; padding: 6px 10px; font-size: 13px;" +
  " border: 1px solid var(--stroke-secondary, #c8c8c8); border-radius: 6px;" +
  " box-sizing: border-box; background: Field; color: FieldText;";

const PROVIDER_MODEL_STATUS_STYLE =
  "font-size: 11.5px; display: none; margin-top: 3px; line-height: 1.45;" +
  " white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal;";

export function createProviderModelSectionBlueprint(params: {
  doc: Document;
  sectionLabelStyle: string;
  title: string;
  addTitle: string;
}): {
  section: HTMLDivElement;
  header: HTMLDivElement;
  addButton: HTMLButtonElement;
} {
  const section = el(
    params.doc,
    "div",
    "display: flex; flex-direction: column; gap: 6px;",
  );
  const header = el(
    params.doc,
    "div",
    "display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px;",
  );
  header.appendChild(
    el(params.doc, "span", params.sectionLabelStyle, params.title),
  );
  const addButton = iconBtn(params.doc, "+", params.addTitle);
  addButton.style.color = "var(--color-accent, #2563eb)";
  header.appendChild(addButton);
  section.appendChild(header);
  return { section, header, addButton };
}

export function createProviderModelRowBlueprint(params: {
  doc: Document;
  outlineButtonStyle: string;
  testLabel: string;
}): {
  row: HTMLDivElement;
  controls: HTMLDivElement;
  testButton: HTMLButtonElement;
  status: HTMLSpanElement;
} {
  const row = el(
    params.doc,
    "div",
    "display: flex; flex-direction: column; gap: 0;",
  );
  const controls = el(
    params.doc,
    "div",
    "display: flex; align-items: center; gap: 5px;",
  );
  const testButton = el(
    params.doc,
    "button",
    params.outlineButtonStyle,
    params.testLabel,
  ) as HTMLButtonElement;
  testButton.type = "button";
  const status = el(
    params.doc,
    "span",
    PROVIDER_MODEL_STATUS_STYLE,
  ) as HTMLSpanElement;
  row.appendChild(controls);
  return { row, controls, testButton, status };
}

export function createProviderCardSectionDivider(doc: Document): HTMLHRElement {
  return el(
    doc,
    "hr",
    "border: none; border-top: 1px solid var(--stroke-secondary, #c8c8c8); margin: 0;",
  ) as HTMLHRElement;
}
