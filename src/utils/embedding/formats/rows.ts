/**
 * Orders embedding rows by `index` when every row carries one, otherwise
 * keeps the response order, and returns each row's vector (`[]` when missing).
 */
export function orderEmbeddingRows(rows: unknown): number[][] {
  if (!Array.isArray(rows)) return [];
  const typed = rows as Array<{ index?: unknown; embedding?: unknown } | null>;
  const hasIndices =
    typed.length > 0 && typed.every((row) => typeof row?.index === "number");
  const ordered = hasIndices
    ? [...typed].sort((a, b) => (a!.index as number) - (b!.index as number))
    : typed;
  return ordered.map((row) =>
    Array.isArray(row?.embedding) ? (row!.embedding as number[]) : [],
  );
}
