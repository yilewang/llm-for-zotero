/**
 * A quotation's text rendered as Markdown with math, the way a quote card's
 * body shows it. Shared by the answer's quote cards and Task progress's
 * cited passages, so a passage reads the same in both.
 */
import { sanitizeText } from "../../utils/textSanitization";
import { copyFlatContentScope } from "./contentChrome";
import { renderRenderedMarkdownInto } from "./renderedMarkdown";

export function renderQuoteCardMarkdownInto(
  target: HTMLElement,
  quoteText: string,
  ownerDoc: Document,
  scopeSource?: Element,
): void {
  const safeText = sanitizeText(quoteText || "").trim();
  if (!safeText) return;
  const container = ownerDoc.createElement("div");
  if (scopeSource) copyFlatContentScope(scopeSource, container);
  renderRenderedMarkdownInto(container, safeText, ownerDoc);
  if (!appendQuoteCardBodyContent(target, container)) {
    target.textContent = safeText;
  }
}

// Markdown that sanitizes down to nothing still leaves nodes behind: the
// renderer swaps a disallowed element for an empty text node rather than
// dropping it. Node presence therefore proves nothing about what the reader
// will see, so ask for text or for an element that paints on its own. A lone
// <br> is deliberately absent — it occupies no visible space, and the caller's
// raw-text fallback shows more than an empty card would.
const QUOTE_CARD_SELF_RENDERING_SELECTOR = "img, svg, hr, input";

function hasRenderableQuoteCardContent(source: ParentNode): boolean {
  if ((source.textContent || "").trim()) return true;
  return Boolean(source.querySelector?.(QUOTE_CARD_SELF_RENDERING_SELECTOR));
}

export function appendQuoteCardBodyContent(
  body: HTMLElement,
  quoteContent: ParentNode | null | undefined,
): boolean {
  if (!quoteContent?.firstChild) return false;
  const firstElement =
    "firstElementChild" in quoteContent ? quoteContent.firstElementChild : null;
  const hasSingleParagraph =
    quoteContent.childNodes.length === 1 &&
    firstElement?.tagName.toLowerCase() === "p";
  const moveSource =
    hasSingleParagraph && firstElement ? firstElement : quoteContent;
  // Decide before mutating. Rolling back after the move would strand the
  // caller's nodes and leave `quoteContent` unusable for the fallback render.
  if (!hasRenderableQuoteCardContent(moveSource)) return false;
  body.classList.add("llm-rendered-markdown");
  while (moveSource.firstChild) {
    body.appendChild(moveSource.firstChild);
  }
  return true;
}
