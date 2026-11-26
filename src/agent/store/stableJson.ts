/**
 * JSON text that does not depend on the order an object's keys were added,
 * so two equal values always give the same string.
 */

/** A copy of the value with object keys sorted and undefined values dropped. */
export function stabilizeForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stabilizeForJson);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const child = record[key];
    if (child === undefined) continue;
    out[key] = stabilizeForJson(child);
  }
  return out;
}

/** The value as JSON text with its object keys in sorted order. */
export function stableJson(value: unknown): string {
  return JSON.stringify(stabilizeForJson(value));
}
