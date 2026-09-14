import type { VerifiedReadSource } from "./types";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getItem(itemId: number | undefined): Zotero.Item | null {
  if (!itemId) return null;
  return Zotero.Items.get(itemId) || null;
}

/**
 * Project only source identities and trusted locators from a host-produced
 * read result. Paper text itself is deliberately not copied into the plan
 * ledger.
 */
export function extractVerifiedReadSources(
  value: unknown,
): VerifiedReadSource[] {
  const sources: VerifiedReadSource[] = [];
  const seenObjects = new WeakSet<object>();
  const visit = (
    current: unknown,
    inherited?: Readonly<{ itemId?: number; contextItemId?: number }>,
    depth = 0,
  ): void => {
    if (depth > 12 || current === null || current === undefined) return;
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry, inherited, depth + 1);
      return;
    }
    const input = record(current);
    if (!input || seenObjects.has(input)) return;
    seenObjects.add(input);
    const paperContext = record(input.paperContext);
    const itemId =
      positiveInteger(paperContext?.itemId) ||
      positiveInteger(input.itemId) ||
      inherited?.itemId;
    const contextItemId =
      positiveInteger(paperContext?.contextItemId) ||
      positiveInteger(input.contextItemId) ||
      inherited?.contextItemId;
    const bibliographicItem = getItem(itemId);
    const attachmentItem = getItem(contextItemId);
    const parentItem = attachmentItem?.parentID
      ? getItem(Number(attachmentItem.parentID))
      : null;
    const sourceItem = bibliographicItem || parentItem;
    const itemKey = text(sourceItem?.key);
    const libraryID = positiveInteger(sourceItem?.libraryID);
    if (itemKey && libraryID) {
      const pageIndex =
        nonNegativeInteger(input.pageIndex) ??
        nonNegativeInteger(input.pageHintIndex);
      const sourceFingerprint =
        text(input.sourceFingerprint) || text(input.documentFingerprint);
      sources.push({
        libraryID,
        itemKey,
        attachmentItemKey: text(attachmentItem?.key),
        pageIndex,
        sourceFingerprint,
      });
    }
    const nextInherited = { itemId, contextItemId };
    for (const nested of Object.values(input)) {
      if (nested === paperContext) continue;
      if (nested && typeof nested === "object") {
        visit(nested, nextInherited, depth + 1);
      }
    }
  };
  visit(value);
  const unique = new Map<string, VerifiedReadSource>();
  for (const source of sources) {
    const key = [
      source.libraryID,
      source.itemKey,
      source.attachmentItemKey || "",
      source.pageIndex ?? "",
      source.sourceFingerprint || "",
    ].join(":");
    unique.set(key, source);
  }
  return [...unique.values()];
}
