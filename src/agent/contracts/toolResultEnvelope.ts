const MAX_TOOL_RESULT_DEPTH = 3;

/**
 * Read the bounded `{ result: ... }` envelopes used by tool execution.
 *
 * This is intentionally shape-driven and bounded: action verification may
 * inspect known result wrappers, but it must not recursively search arbitrary
 * model-controlled objects for evidence.
 */
export function toolResultRecords(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const records: Record<string, unknown>[] = [];
  let current = value as Record<string, unknown>;
  records.push(current);
  for (let depth = 0; depth < MAX_TOOL_RESULT_DEPTH; depth += 1) {
    if (
      !current.result ||
      typeof current.result !== "object" ||
      Array.isArray(current.result)
    ) {
      break;
    }
    current = current.result as Record<string, unknown>;
    records.push(current);
  }
  return records;
}

export function innermostToolResult(value: unknown): Record<string, unknown> {
  return toolResultRecords(value).at(-1) || {};
}

export function toolResultString(
  value: unknown,
  keys: readonly string[],
): string | undefined {
  for (const record of toolResultRecords(value)) {
    for (const key of keys) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return undefined;
}
