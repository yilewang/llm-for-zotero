import type {
  ResolvedSelectedTextAnchor,
  SelectedTextContext,
} from "../../shared/types";
import { normalizePositiveInt } from "./normalizers";

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

export function renderSelectedTextAnchorContext(params: {
  selectedTextContexts: SelectedTextContext[];
  anchors: ResolvedSelectedTextAnchor[];
}): string {
  const blocks: string[] = [];
  for (const anchor of params.anchors) {
    const context = params.selectedTextContexts[anchor.contextIndex];
    if (!context) continue;
    const locator = formatSelectedTextLocator(context, anchor);
    const header = `Selected text ${anchor.contextIndex + 1} local source ${locator}`;
    const guidance =
      anchor.pageIndex !== undefined
        ? `If more context is required, read PDF page ${anchor.pageIndex + 1} for attachment ${anchor.contextItemId} with one neighboring page.`
        : "";
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
