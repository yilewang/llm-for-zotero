import type {
  ResolvedSelectedTextAnchor,
  SelectedTextContext,
} from "../../shared/types";
import {
  normalizePositiveInt,
  normalizeSelectedTextUserQuery,
} from "./normalizers";

function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  let cleaned = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f)
    ) {
      continue;
    }
    cleaned += character;
  }
  return cleaned.trim();
}

/**
 * The line placed under a chip's closing quotes when the user attached a
 * question to it (D3), including its leading newline; "" without a question.
 */
export function formatSelectedTextQuestionSuffix(userQuery: unknown): string {
  const question = normalizeSelectedTextUserQuery(userQuery);
  return question ? `\nQuestion about this text:\n${question}` : "";
}

/** The chip questions in chip order, joined by blank lines; "" when none. */
export function joinSelectedTextQuestions(
  contexts: readonly Pick<SelectedTextContext, "userQuery">[] | undefined,
  sanitize?: (value: string) => string,
): string {
  return (contexts || [])
    .map((context) =>
      normalizeSelectedTextUserQuery(context?.userQuery, sanitize),
    )
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Closing line of a model prompt whose user prompt is only the chip
 * questions (an empty-composer send): each question already follows its own
 * quote, so the prompt does not repeat them.
 */
export const SELECTED_TEXT_QUESTIONS_INSTRUCTION =
  "Answer the question attached to each selected text above.";

/**
 * True when `prompt` is exactly the chip questions as joined by
 * joinSelectedTextQuestions, i.e. resolvePromptText's empty-composer result.
 */
export function isPromptOnlySelectedTextQuestions(
  prompt: string,
  contexts: readonly Pick<SelectedTextContext, "userQuery">[] | undefined,
  sanitize?: (value: string) => string,
): boolean {
  const questions = joinSelectedTextQuestions(contexts, sanitize);
  return Boolean(questions) && prompt.trim() === questions;
}

export function formatSelectedTextLocator(
  context: SelectedTextContext,
  anchor?: ResolvedSelectedTextAnchor,
): string {
  if (context.source !== "pdf") return "";
  const contextItemId =
    normalizePositiveInt(context.contextItemId) ||
    normalizePositiveInt(context.paperContext?.contextItemId) ||
    anchor?.contextItemId;
  const pageIndex = Number.isFinite(context.pageIndex)
    ? Math.floor(context.pageIndex as number)
    : anchor?.pageIndex;
  const pageLabel =
    cleanText(context.pageLabel || anchor?.pageLabel) ||
    (pageIndex !== undefined ? `${pageIndex + 1}` : "");
  const fields = [
    contextItemId ? `attachment_id=${contextItemId}` : "",
    pageLabel ? `page_label=${pageLabel}` : "",
    pageIndex !== undefined ? `page_index=${pageIndex}` : "",
    anchor ? `location_resolution=${anchor.resolution}` : "",
  ].filter(Boolean);
  return fields.length ? `[${fields.join(", ")}]` : "";
}

/**
 * The paper_read call that reads PDF page `page` (from 1) of a paper's
 * attachment with one neighboring page, as `paper_read {arguments}`.
 */
export function formatPageReadCall(params: {
  itemId: number;
  contextItemId: number;
  page: number;
}): string {
  return `paper_read ${JSON.stringify({
    mode: "targeted",
    target: { itemId: params.itemId, contextItemId: params.contextItemId },
    pages: [params.page],
    neighborPages: 1,
  })}`;
}

/**
 * Where the text around a selection is: its page and, when the selection's
 * paper is known and the model has tools (`readCalls`), the paper_read call
 * that reads it. Without tools the hint names the page and attachment.
 */
function selectionPageHint(
  anchor: ResolvedSelectedTextAnchor,
  readCalls: boolean,
): string {
  if (anchor.pageIndex === undefined) return "";
  const page = anchor.pageIndex + 1;
  if (!readCalls)
    return `If more context is required, read PDF page ${page} for attachment ${anchor.contextItemId} with one neighboring page.`;
  // Only a paper that owns the selection's attachment names the call.
  const paper =
    normalizePositiveInt(anchor.paperContext?.contextItemId) ===
    anchor.contextItemId
      ? anchor.paperContext
      : undefined;
  const itemId = normalizePositiveInt(paper?.itemId);
  const call = itemId
    ? `: ${formatPageReadCall({ itemId, contextItemId: anchor.contextItemId, page })}`
    : "";
  return `If more context is required, read PDF page ${page} with one neighboring page${call}.`;
}

export function renderSelectedTextAnchorContext(params: {
  selectedTextContexts: SelectedTextContext[];
  anchors: ResolvedSelectedTextAnchor[];
  /**
   * Guidance naming the map parts that hold a selection, by its index; it
   * replaces the page hint for that selection.
   */
  locations?: readonly { contextIndex: number; guidance: string }[];
  /** The model can call paper_read: the page hint names the call. */
  readCalls?: boolean;
}): string {
  const blocks: string[] = [];
  for (const anchor of params.anchors) {
    const context = params.selectedTextContexts[anchor.contextIndex];
    if (!context) continue;
    const locator = formatSelectedTextLocator(context, anchor);
    const header = `Selected text ${anchor.contextIndex + 1} local source ${locator}`;
    const location = params.locations?.find(
      (entry) => entry.contextIndex === anchor.contextIndex,
    );
    const guidance = location
      ? location.guidance
      : selectionPageHint(anchor, params.readCalls === true);
    blocks.push(
      [header, anchor.contextText, guidance].filter(Boolean).join("\n"),
    );
  }
  return blocks.length
    ? `Highlight-aware local context:\n\n${blocks.join("\n\n")}`
    : "";
}

/**
 * Render verified page text only when chunk mapping was inconclusive.
 *
 * Chunk-backed anchors enter the retrieval planner as locked candidates. Page
 * fallbacks have no durable chunk identity, so the planner must reserve and
 * inject their bounded text directly instead.
 */
export function renderSelectedTextPageFallbackContext(params: {
  anchors: ResolvedSelectedTextAnchor[];
  omitContextItemIds?: ReadonlySet<number>;
}): string {
  const blocks = params.anchors.flatMap((anchor) => {
    if (
      anchor.resolution !== "page" ||
      !anchor.contextText?.trim() ||
      params.omitContextItemIds?.has(anchor.contextItemId)
    ) {
      return [];
    }
    const pageLabel =
      cleanText(anchor.pageLabel) ||
      (anchor.pageIndex !== undefined ? `${anchor.pageIndex + 1}` : "");
    const fields = [
      `attachment_id=${anchor.contextItemId}`,
      pageLabel ? `page_label=${pageLabel}` : "",
      anchor.pageIndex !== undefined ? `page_index=${anchor.pageIndex}` : "",
      "location_resolution=page",
    ].filter(Boolean);
    const header = `Selected text ${anchor.contextIndex + 1} verified page fallback [${fields.join(", ")}]`;
    return [`${header}\n${anchor.contextText.trim()}`];
  });
  return blocks.length
    ? `Highlight-aware page fallback context:\n\n${blocks.join("\n\n")}`
    : "";
}
