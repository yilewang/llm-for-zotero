/**
 * Reading values of unknown shape: stored rows, JSON payloads, preferences,
 * tool arguments.
 *
 * Each function is named for what it returns, so a call site says what
 * happens to a value of the wrong type. The module sits in the lowest layer
 * and imports nothing, so every other layer can use it.
 */

/** The value when it is a non-array object, otherwise an empty object. */
export function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The value when it is a non-array object, otherwise null. */
export function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Whether the value is a non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A string with its ends trimmed. Anything that is not a string gives "". */
export function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A string with its ends trimmed. A string that trims to nothing, or anything
 * that is not a string, gives undefined.
 */
export function trimmedStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * A string with its ends trimmed. A string that trims to nothing, or anything
 * that is not a string, gives null.
 */
export function trimmedStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** A string trimmed and lower-cased. Anything that is not a string gives "". */
export function lowerTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * The value as a number above zero, rounded down. Anything else gives
 * undefined. A value between 0 and 1 rounds down to 0.
 */
export function positiveIntOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

/**
 * The value as a number above zero, rounded down. Anything else gives null.
 * A value between 0 and 1 rounds down to 0.
 */
export function positiveIntOrNull(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

/** The value as a number above zero, rounded down. Anything else gives 0. */
export function positiveIntOrZero(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

/**
 * The value as text on one line: each run of whitespace becomes one space
 * and the ends are trimmed. null and undefined give "".
 */
export function collapseWhitespace(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim();
}

/** The text with every regular-expression metacharacter escaped. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
