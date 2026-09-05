/**
 * User-authored per-model capability overrides.
 *
 * Every heuristic for inferring what a model can do — name regexes, hosted
 * profiles, what a server volunteers — goes stale as models ship. Rather than
 * chase that, the user gets the last word: an override sits on top of the
 * detected profile and wins. The customization surface is deliberately small
 * and maps to what actually changes when a provider ships a new model:
 * reasoning levels (a new effort such as `ultra`), the context window, and a
 * raw request-parameter escape hatch. Feature flags like tools or streaming
 * are the plugin's job to detect, never the user's to declare.
 *
 * The shape deliberately reuses `RegistryModelEntry` fields, so there is no
 * second schema to maintain and the same merge machinery applies.
 *
 * **Trust boundary.** The registry allowlist in `registry.ts` exists because
 * the remote registry is fetched over the network. A user editing their own
 * provider is a different domain: local-model users need `top_k`,
 * `repeat_penalty`, `stop` and friends, all of which that allowlist blocks. So
 * arbitrary keys are permitted here — but keys that would let a value escape
 * into the prototype chain are not.
 */

import type { ModelCapabilityLimits, ModelReasoningCapability } from "./types";
import { isRecord, MODEL_CAPABILITY_MAX_TOKEN_LIMIT } from "./registry";

export type ModelProfileOverride = {
  /**
   * The model name this override was authored for. Parameters are tuned to
   * one specific model, so when the entry is pointed at a different model the
   * override goes dormant instead of being applied — or destroyed. Renaming
   * back restores it. Absent on overrides written before this field existed;
   * those apply unconditionally.
   */
  forModel?: string;
  limits?: ModelCapabilityLimits;
  reasoning?: ModelReasoningCapability;
  /** Extra request-body parameters, merged into every request to this model. */
  extraBody?: Record<string, unknown>;
};

/**
 * Path segments that must never be walked when expanding a dot-path, and keys
 * that must never appear in a stored request body.
 *
 * A naive walker resolves `__proto__` to `Object.prototype` and then writes
 * through it, which mutates every object in the runtime. `constructor` and
 * `prototype` reach the same place by a longer route. The symptom — a global
 * built-in quietly disappearing — is impossible to trace back to a parameter
 * the user typed, so it is refused rather than debugged later.
 */
const FORBIDDEN_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export function isForbiddenPathSegment(segment: string): boolean {
  return FORBIDDEN_PATH_SEGMENTS.has(segment);
}

/**
 * The shape a reasoning level id must have to survive the pref store.
 *
 * The editor warns on ids outside this shape and the pref-store validator in
 * prefHelpers drops them — one pattern, imported by both, so the warning and
 * the store can never disagree about what "will be remembered" means.
 */
export const REASONING_LEVEL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isValidReasoningLevelId(value: string): boolean {
  return REASONING_LEVEL_ID_PATTERN.test(value);
}

/** Serialized size ceiling; the override is read on every capability resolve. */
export const MAX_PROFILE_OVERRIDE_BYTES = 16 * 1024;

/**
 * Request-envelope keys a user parameter must never occupy.
 *
 * Payload builders spread the user's extra parameters into the request body,
 * most of them before the envelope, so a parameter named `messages`, `tools`
 * or `stream` would collide with the conversation, the tool definitions, or
 * the streaming switch. `temperature` and the max-token keys are refused for a
 * different reason: dedicated fields for them already exist in the same
 * advanced panel, and a copy here would be silently outranked by the envelope
 * — failing in a way that looks nothing like "the parameter I typed was
 * wrong". The editor refuses all of them with a visible message.
 */
const RESERVED_REQUEST_KEYS = new Set([
  "model",
  "messages",
  "input",
  "instructions",
  "contents",
  "system",
  "prompt",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "temperature",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
]);

export function isReservedRequestKey(key: string): boolean {
  return RESERVED_REQUEST_KEYS.has(key);
}

export type DotPathEntry = { key: string; value: unknown };

/**
 * Expand `{"a.b.c": v}` into `{a: {b: {c: v}}}`.
 *
 * Intermediates are created with a null prototype so there is nothing to walk
 * into even if a guard is ever missed; the result is round-tripped through
 * JSON at the end so consumers receive ordinary objects.
 */
export function expandDotPaths(
  entries: DotPathEntry[],
): Record<string, unknown> {
  const root: Record<string, unknown> = Object.create(null);
  for (const entry of entries) {
    const key = (entry.key || "").trim();
    if (!key) continue;
    const segments = key.split(".").filter(Boolean);
    if (!segments.length) continue;
    if (segments.some(isForbiddenPathSegment)) continue;
    let cursor = root;
    let usable = true;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      const next = cursor[segment];
      if (next === undefined || next === null) {
        const created: Record<string, unknown> = Object.create(null);
        cursor[segment] = created;
        cursor = created;
        continue;
      }
      if (typeof next !== "object" || Array.isArray(next)) {
        // A scalar already occupies this path; a deeper write would silently
        // discard it, so drop the conflicting entry instead.
        usable = false;
        break;
      }
      cursor = next as Record<string, unknown>;
    }
    if (!usable) continue;
    cursor[segments[segments.length - 1]] = entry.value;
  }
  return JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
}

/** Flatten a nested body back into dot-path rows for the editor. */
export function flattenToDotPaths(
  value: Record<string, unknown> | undefined,
  prefix = "",
): DotPathEntry[] {
  if (!value) return [];
  const rows: DotPathEntry[] = [];
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      rows.push(...flattenToDotPaths(entry as Record<string, unknown>, path));
      continue;
    }
    rows.push({ key: path, value: entry });
  }
  return rows;
}

/**
 * Infer a scalar's type from the text the user typed, so a simple
 * `key=value` field needs no separate type picker. The value is trimmed:
 * `think= high` must send `"high"`, not `" high"` — a leading space survives
 * to the wire otherwise, and the provider's rejection of it looks nothing
 * like a typo.
 */
export function coerceParameterValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return trimmed;
}

/**
 * Parse a comma-separated `key=value` list into a request-body patch.
 *
 * Used for the reasoning-level parameter field, which is nearly always a
 * single short pair such as `think=high` — JSON braces there would be noise.
 * Nested keys still work through dot paths (`chat_template_kwargs.enable_thinking=true`).
 */
export function parseKeyValueField(raw: string): {
  value: Record<string, unknown>;
  rejected: string[];
} {
  const entries: DotPathEntry[] = [];
  const rejected: string[] = [];
  for (const pair of (raw || "").split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    const key = separator > 0 ? trimmed.slice(0, separator).trim() : "";
    if (
      !key ||
      key.split(".").some(isForbiddenPathSegment) ||
      isReservedRequestKey(key)
    ) {
      rejected.push(trimmed);
      continue;
    }
    entries.push({
      key,
      value: coerceParameterValue(trimmed.slice(separator + 1)),
    });
  }
  return { value: expandDotPaths(entries), rejected };
}

/** Render a request-body patch back into the `key=value` field. */
export function stringifyKeyValueField(
  value: Record<string, unknown> | undefined,
): string {
  return flattenToDotPaths(value)
    .map((entry) => `${entry.key}=${String(entry.value)}`)
    .join(", ");
}

/**
 * Parse a JSON object the user typed into a parameter field.
 *
 * Blank is not an error — it means "no parameters" — so the caller can tell an
 * empty field from a malformed one and report only the latter. The parsed
 * object is run through the same sanitizer as stored input, because
 * `JSON.parse` happily creates an own `__proto__` key that a later deep merge
 * would walk into.
 */
export function parseJsonObjectField(raw: string): {
  value?: Record<string, unknown>;
  error?: string;
} {
  const trimmed = (raw || "").trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!isRecord(parsed)) {
    return { error: "expected a JSON object" };
  }
  const reserved = Object.keys(parsed).filter(isReservedRequestKey);
  if (reserved.length) {
    return {
      error: `${reserved.join(", ")} cannot be set here — the request builds these`,
    };
  }
  return { value: sanitizeUserRequestBody(parsed) || {} };
}

/** Render a parameter object back into the editor's JSON field. */
export function stringifyJsonObjectField(
  value: Record<string, unknown> | undefined,
): string {
  if (!value || !Object.keys(value).length) return "";
  return JSON.stringify(value, null, 2);
}

/**
 * Drop empty sections so an override is never stored as `{}`.
 *
 * Absent and empty must stay distinguishable: an empty object would read as
 * "override every field to nothing", which is exactly what a user pressing
 * Reset does not mean. `forModel` alone does not keep an override alive — it
 * is provenance, not a customization.
 */
export function pruneProfileOverride(
  override: ModelProfileOverride | undefined,
): ModelProfileOverride | undefined {
  if (!override) return undefined;
  const pruned: ModelProfileOverride = {};
  if (override.limits && Object.keys(override.limits).length) {
    pruned.limits = { ...override.limits };
  }
  if (override.reasoning?.options?.length || override.reasoning?.kind) {
    pruned.reasoning = override.reasoning;
  }
  if (override.extraBody && Object.keys(override.extraBody).length) {
    pruned.extraBody = override.extraBody;
  }
  if (!Object.keys(pruned).length) return undefined;
  if (override.forModel?.trim()) {
    pruned.forModel = override.forModel.trim();
  }
  return pruned;
}

/**
 * Whether a stored override belongs to the model an entry currently points
 * at. Overrides written before `forModel` existed apply unconditionally.
 */
export function profileOverrideAppliesTo(
  override: ModelProfileOverride | undefined,
  model: string,
): boolean {
  if (!override) return false;
  if (!override.forModel) return true;
  return override.forModel === model.trim();
}

/**
 * Deep-copy a request body, dropping any key that could reach the prototype
 * chain — at every level, inside arrays included. Unlike a dot-path
 * round-trip, this preserves the user's structure exactly: a literal `"a.b"`
 * key stays `"a.b"` rather than being rewritten into nesting.
 */
export function sanitizeUserRequestBody(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const cleaned = sanitizeRecord(value, true);
  return Object.keys(cleaned).length ? cleaned : undefined;
}

function sanitizeRecord(
  value: Record<string, unknown>,
  stripReservedRoots = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isForbiddenPathSegment(key)) continue;
    if (stripReservedRoots && isReservedRequestKey(key)) continue;
    out[key] = sanitizeValue(entry);
  }
  return out;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isRecord(value)) return sanitizeRecord(value);
  return value;
}

function sanitizeTokenLimit(value: unknown): number | undefined {
  const parsed = Math.floor(Number(value));
  return Number.isSafeInteger(parsed) &&
    parsed > 0 &&
    parsed <= MODEL_CAPABILITY_MAX_TOKEN_LIMIT
    ? parsed
    : undefined;
}

/**
 * Validate a stored override. Unknown body keys are allowed (that is the
 * point); structurally impossible values are dropped so a corrupt pref can
 * never break request building. Sections this schema no longer supports
 * (feature and input flags from earlier builds) are dropped the same way —
 * per-model feature toggles are the plugin's job to detect, not the user's
 * to declare.
 */
export function normalizeProfileOverride(
  value: unknown,
): ModelProfileOverride | undefined {
  if (!isRecord(value)) return undefined;
  if (JSON.stringify(value).length > MAX_PROFILE_OVERRIDE_BYTES) {
    return undefined;
  }
  const result: ModelProfileOverride = {};

  if (typeof value.forModel === "string" && value.forModel.trim()) {
    const forModel = value.forModel.trim();
    if (forModel.length <= 256) result.forModel = forModel;
  }

  if (isRecord(value.limits)) {
    const limits: ModelCapabilityLimits = {};
    const context = sanitizeTokenLimit(value.limits.contextWindowTokens);
    const input = sanitizeTokenLimit(value.limits.inputTokens);
    const output = sanitizeTokenLimit(value.limits.outputTokens);
    if (context !== undefined) limits.contextWindowTokens = context;
    if (input !== undefined) limits.inputTokens = input;
    if (output !== undefined) limits.outputTokens = output;
    if (Object.keys(limits).length) result.limits = limits;
  }

  if (isRecord(value.reasoning) && Array.isArray(value.reasoning.options)) {
    const options = value.reasoning.options
      .filter(isRecord)
      .map((option) => {
        const id = String(option.id || "").trim();
        const body = sanitizeUserRequestBody(
          isRecord(option.controls) ? option.controls.body : undefined,
        );
        return {
          id,
          label: String(option.label || option.id || "").trim(),
          enabled: option.enabled !== false,
          ...(body ? { controls: { body } } : {}),
        };
      })
      .filter((option) => isValidReasoningLevelId(option.id));
    if (options.length) {
      result.reasoning = {
        kind: "select",
        options,
        ...(typeof value.reasoning.defaultOptionId === "string"
          ? { defaultOptionId: value.reasoning.defaultOptionId }
          : {}),
      };
    } else if (value.reasoning.kind === "none") {
      result.reasoning = { kind: "none", options: [] };
    }
  }

  const extraBody = sanitizeUserRequestBody(value.extraBody);
  if (extraBody) result.extraBody = extraBody;

  return pruneProfileOverride(result);
}
