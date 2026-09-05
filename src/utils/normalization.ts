/**
 * Shared normalization helpers for temperature and max-tokens values.
 *
 * Accepts both `number` and `string` inputs so the same function can be used
 * by the LLM client (numbers), the preferences UI (strings), and the context
 * panel (strings).
 */

import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_INPUT_TOKEN_CAP,
  MAX_ALLOWED_TOKENS,
  MAX_ALLOWED_INPUT_TOKEN_CAP,
} from "./llmDefaults";
import {
  getModelOutputTokenLimit as getCatalogOutputTokenLimit,
  type ModelCapabilityIdentity,
} from "../modelCapabilities";

export function getModelOutputTokenLimit(
  modelName?: string,
  identity?: Omit<ModelCapabilityIdentity, "model">,
): number {
  return getCatalogOutputTokenLimit(modelName || "", identity);
}

/** Clamp a temperature value to [0, 2], falling back to DEFAULT_TEMPERATURE. */
export function normalizeTemperature(value?: number | string): number {
  const parsed =
    typeof value === "string" ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TEMPERATURE;
  return Math.min(2, Math.max(0, parsed));
}

/**
 * Resolve the temperature to send to a Gemini model, or undefined to omit it.
 *
 * Google's Gemini 3 guidance is to leave temperature at its server-side
 * default of 1.0 — lower values cause looping and degraded reasoning — so for
 * Gemini 3+ models an unset temperature is omitted from the payload instead
 * of falling back to DEFAULT_TEMPERATURE.  Explicit user values are always
 * respected, and older Gemini generations keep the existing default.
 */
export function resolveGeminiTemperature(
  model: string | undefined,
  value?: number | string,
): number | undefined {
  const parsed =
    typeof value === "string" ? Number.parseFloat(value) : Number(value);
  if (Number.isFinite(parsed)) return Math.min(2, Math.max(0, parsed));
  const generation = /(^|[/:@])gemini-(\d+)/i.exec(model || "");
  if (generation && Number.parseInt(generation[2], 10) >= 3) return undefined;
  return DEFAULT_TEMPERATURE;
}

/** Clamp a max-tokens value to [1, MAX_ALLOWED_TOKENS], falling back to DEFAULT_MAX_TOKENS. */
export function normalizeMaxTokens(value?: number | string): number {
  const parsed =
    typeof value === "string"
      ? Number.parseInt(value, 10)
      : Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_TOKENS;
  return Math.min(parsed, MAX_ALLOWED_TOKENS);
}

/** Clamp max-tokens using a model-specific output limit when known. */
export function normalizeMaxTokensForModel(
  value?: number | string,
  modelName?: string,
  identity?: Omit<ModelCapabilityIdentity, "model">,
): number {
  const parsed =
    typeof value === "string"
      ? Number.parseInt(value, 10)
      : Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_TOKENS;
  return Math.min(
    parsed,
    getCatalogOutputTokenLimit(modelName || "", identity),
  );
}

/** Clamp an input-token-cap value to [1, MAX_ALLOWED_INPUT_TOKEN_CAP], with configurable fallback. */
export function normalizeInputTokenCap(
  value?: number | string,
  fallback: number = DEFAULT_INPUT_TOKEN_CAP,
): number {
  const parsed =
    typeof value === "string"
      ? Number.parseInt(value, 10)
      : Math.floor(Number(value));
  const fallbackFloor = Math.floor(Number(fallback));
  const normalizedFallback =
    Number.isFinite(fallbackFloor) && fallbackFloor >= 1
      ? Math.min(fallbackFloor, MAX_ALLOWED_INPUT_TOKEN_CAP)
      : DEFAULT_INPUT_TOKEN_CAP;
  if (!Number.isFinite(parsed) || parsed < 1) return normalizedFallback;
  return Math.min(parsed, MAX_ALLOWED_INPUT_TOKEN_CAP);
}

/** Clamp an optional input-token-cap value to [1, MAX_ALLOWED_INPUT_TOKEN_CAP], returning undefined when blank/invalid. */
export function normalizeOptionalInputTokenCap(
  value?: number | string | null,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed =
    typeof value === "string"
      ? Number.parseInt(value, 10)
      : Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.min(parsed, MAX_ALLOWED_INPUT_TOKEN_CAP);
}
