import type { LibraryMutationOperation } from "./contracts";
import type { MutationStateView } from "./stateView";
import { renderMarkdownForNote } from "../../../utils/markdown";
import { normalizeNotePlainText, stripNoteHtml } from "../../../utils/noteText";
import {
  citationSignatures,
  newCitationRequestsExpected,
} from "../../../services/notes/noteCitations";
import { hasNewCitationTokens } from "../../../utils/noteCitations";

export const resultCount = (result: unknown, key: string): number => {
  const value = (result || {}) as Record<string, unknown>;
  return Math.max(0, Math.floor(Number(value[key]) || 0));
};

export const resultStatus = (result: unknown, status: string): number =>
  (result as { status?: unknown } | null)?.status === status ? 1 : 0;

export function resultId(result: unknown, key: string): number[] {
  const value =
    result && typeof result === "object"
      ? Number((result as Record<string, unknown>)[key])
      : 0;
  return Number.isInteger(value) && value > 0 ? [value] : [];
}

export function resultIds(result: unknown, key: string): number[] {
  if (!result || typeof result !== "object") return [];
  const values = (result as Record<string, unknown>)[key];
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .map(Number)
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ];
}

export function resultRowIds(params: {
  result: unknown;
  rowsKey: string;
  idKey: string;
  status?: string;
}): number[] {
  if (!params.result || typeof params.result !== "object") return [];
  const rows = (params.result as Record<string, unknown>)[params.rowsKey];
  if (!Array.isArray(rows)) return [];
  const ids: number[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (params.status && record.status !== params.status) continue;
    const id = Number(record[params.idKey]);
    if (Number.isInteger(id) && id > 0) ids.push(id);
  }
  return [...new Set(ids)];
}

export const noteContentMatches = (
  actual: string | undefined,
  expected: string,
): boolean => {
  const actualText = normalizeNotePlainText(stripNoteHtml(actual || ""));
  const expectedText = normalizeNotePlainText(
    stripNoteHtml(renderMarkdownForNote(expected)),
  );
  return Boolean(
    expectedText &&
    (actualText === expectedText || actualText.includes(expectedText)),
  );
};

/**
 * Whether a stored note holds a batch body. A body's `{{cite item=…}}`
 * request is stored as a citation chip, so the stored note is compared with
 * the chips' text and must cite the same items at the same locators: two
 * works can share a label. Items named by key are looked up in the library
 * of the item the note was written for. A body whose requests cannot be
 * expanded is compared as written. A body without a request is compared as
 * written and looks nothing up.
 */
export function batchNoteMatcher(
  content: string,
  targetItemId: number,
): (actualHtml: string | undefined) => boolean {
  if (!hasNewCitationTokens(content))
    return (actualHtml) => noteContentMatches(actualHtml, content);
  let expected: { text: string; citations: string[] };
  try {
    expected = newCitationRequestsExpected(content, (itemRef) =>
      /^\d+$/.test(itemRef)
        ? Zotero.Items.get(Number(itemRef)) || null
        : (() => {
            const libraryID = Zotero.Items.get(targetItemId)?.libraryID;
            return libraryID
              ? Zotero.Items.getByLibraryAndKey(
                  libraryID,
                  itemRef.toUpperCase(),
                ) || null
              : null;
          })(),
    );
  } catch {
    return (actualHtml) => noteContentMatches(actualHtml, content);
  }
  return (actualHtml) => {
    if (!noteContentMatches(actualHtml, expected.text)) return false;
    const stored = citationSignatures(actualHtml || "");
    return expected.citations.every((signature) => {
      const at = stored.indexOf(signature);
      if (at < 0) return false;
      stored.splice(at, 1);
      return true;
    });
  };
}

export function onePer<Operation extends LibraryMutationOperation, Value>(
  operation: Operation,
  values: readonly Value[] | undefined,
  build: (value: Value) => Operation,
): LibraryMutationOperation[] {
  return values && values.length > 1 ? values.map(build) : [operation];
}

export const restoreTagState = (state: MutationStateView) => ({
  inverseOperations: [
    {
      type: "set_item_tags" as const,
      assignments: (state.items || [])
        .filter((item) => item.exists)
        .map((item) => ({ itemId: item.itemId, tags: item.tags || [] })),
    },
  ],
});

export const restoreCollectionState = (state: MutationStateView) => ({
  inverseOperations: [
    {
      type: "set_item_collections" as const,
      assignments: (state.items || [])
        .filter((item) => item.exists)
        .map((item) => ({
          itemId: item.itemId,
          collectionIds: item.collectionIds || [],
        })),
    },
  ],
});

/** Item ids as a reason names them: "item 8", "items 8 and 9", "items 8, 9 and 12". */
export function describeItemIds(itemIds: readonly number[]): string {
  const ids = itemIds.map(String);
  const list =
    ids.length > 1
      ? `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`
      : ids.join("");
  return `${ids.length === 1 ? "item" : "items"} ${list}`;
}

export const sameMembers = <T>(
  left: readonly T[],
  right: readonly T[],
): boolean => {
  const normalize = (values: readonly T[]) =>
    [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b)));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
};
