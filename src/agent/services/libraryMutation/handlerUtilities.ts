import type { LibraryMutationOperation } from "./contracts";
import type { MutationStateView } from "./stateView";

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

const normalizedNoteText = (value: string): string =>
  value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();

export const noteContentMatches = (
  actual: string | undefined,
  expected: string,
): boolean => {
  const actualText = normalizedNoteText(actual || "");
  const expectedText = normalizedNoteText(expected);
  return Boolean(
    expectedText &&
    (actualText === expectedText || actualText.includes(expectedText)),
  );
};

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

export const sameMembers = <T>(
  left: readonly T[],
  right: readonly T[],
): boolean => {
  const normalize = (values: readonly T[]) =>
    [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b)));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
};
