import { t } from "../../utils/i18n";

/**
 * Fills a selected-text chip's expanded card: a "Selected text" label and the
 * selected text (dimmed, clamped), then, when the chip carries a question, a
 * divider, a "Your question" label and the question in the primary text
 * color. The composer chip preview and the sent message's chip
 * card share this layout. The question block has its own class, so lookups of
 * `.llm-selected-context-text` find the chip text only. An optional leading
 * node (the sent card's source icon) goes before the "Selected text" label
 * text on one row. Returns the selected-text block.
 */
export function appendSelectedTextSections(
  doc: Document,
  container: Element,
  text: string,
  userQuery?: string | null,
  options: { leading?: Node } = {},
): HTMLElement {
  // A label and its text travel as one section, so the pair stays tight
  // while the card's own gap separates the sections and the divider.
  const createSection = (
    label: string,
    block: HTMLElement,
    leading?: Node,
  ): HTMLElement => {
    const section = doc.createElement("div") as HTMLElement;
    section.className = "llm-selected-context-section";
    const labelNode = doc.createElement("div") as HTMLElement;
    if (leading) {
      labelNode.className =
        "llm-selected-context-label llm-selected-context-label-row";
      const labelText = doc.createElement("span") as HTMLElement;
      labelText.className = "llm-selected-context-label-text";
      labelText.textContent = label;
      labelNode.append(leading, labelText);
    } else {
      labelNode.className = "llm-selected-context-label";
      labelNode.textContent = label;
    }
    section.append(labelNode, block);
    return section;
  };
  const textBlock = doc.createElement("div") as HTMLElement;
  textBlock.className = "llm-selected-context-text";
  textBlock.textContent = text;
  container.append(
    createSection(t("Selected text"), textBlock, options.leading),
  );

  const question = (userQuery || "").trim();
  if (question) {
    const divider = doc.createElement("div") as HTMLElement;
    divider.className = "llm-agent-output-divider";
    const questionBlock = doc.createElement("div") as HTMLElement;
    questionBlock.className = "llm-selected-context-question";
    questionBlock.textContent = question;
    container.append(divider, createSection(t("Your question"), questionBlock));
  }
  return textBlock;
}
