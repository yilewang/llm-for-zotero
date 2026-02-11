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
  MAX_ALLOWED_TOKENS,
} from "./llmDefaults";

/** Clamp a temperature value to [0, 2], falling back to DEFAULT_TEMPERATURE. */
export function normalizeTemperature(value?: number | string): number {
  const parsed =
    typeof value === "string" ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TEMPERATURE;
  return Math.min(2, Math.max(0, parsed));
}

/** Clamp a max-tokens value to [1, MAX_ALLOWED_TOKENS], falling back to DEFAULT_MAX_TOKENS. */
export function normalizeMaxTokens(value?: number | string): number {
  const parsed =
    typeof value === "string" ? Number.parseInt(value, 10) : Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_TOKENS;
  return Math.min(parsed, MAX_ALLOWED_TOKENS);
}
