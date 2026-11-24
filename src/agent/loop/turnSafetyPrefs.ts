import { config } from "../../../package.json";
import { TURN_SAFETY_LIMITS, type TurnSafetyLimits } from "./turnBoundary";

/**
 * The user-facing copy of Rule 3's per-turn safety limits. The UI stores one
 * number per pref, in the unit named here; `readTurnSafetyLimits` translates
 * them into the milliseconds and counts the boundary uses.
 */
export type TurnSafetyPrefKey =
  | "modelCalls"
  | "inputTokens"
  | "wallClockMinutes";

export type TurnSafetyPrefSpec = {
  key: TurnSafetyPrefKey;
  pref: string;
  min: number;
  max: number;
  defaultValue: number;
  elementSuffix: string;
};

const WALL_CLOCK_MINUTE_MS = 60_000;

export const TURN_SAFETY_PREF_SPECS: readonly TurnSafetyPrefSpec[] =
  Object.freeze([
    Object.freeze({
      key: "modelCalls" as const,
      pref: "agentTurnSafetyModelCalls",
      min: 1,
      max: 100_000,
      defaultValue: TURN_SAFETY_LIMITS.modelCalls,
      elementSuffix: "original-agent-model-calls-limit",
    }),
    Object.freeze({
      key: "inputTokens" as const,
      pref: "agentTurnSafetyInputTokens",
      min: 1,
      max: 1_000_000_000,
      defaultValue: TURN_SAFETY_LIMITS.inputTokens,
      elementSuffix: "original-agent-input-tokens-limit",
    }),
    Object.freeze({
      key: "wallClockMinutes" as const,
      pref: "agentTurnSafetyWallClockMinutes",
      min: 1,
      max: 10_080,
      defaultValue: Math.round(
        TURN_SAFETY_LIMITS.wallClockMs / WALL_CLOCK_MINUTE_MS,
      ),
      elementSuffix: "original-agent-wall-clock-limit",
    }),
  ]);

type ZoteroLike = {
  Prefs?: {
    get?: (key: string, global?: boolean) => unknown;
    set?: (key: string, value: number, global?: boolean) => void;
  };
};

function zotero(): ZoteroLike | undefined {
  return (globalThis as { Zotero?: ZoteroLike }).Zotero;
}

/** The full preference key, from the plugin's configured prefix. */
export function turnSafetyPrefKey(spec: TurnSafetyPrefSpec): string {
  return `${config.prefsPrefix}.${spec.pref}`;
}

/** An absent or malformed value uses the shipped default; a number is clamped. */
export function normalizeTurnSafetyPref(
  spec: TurnSafetyPrefSpec,
  raw: unknown,
): number {
  const value = typeof raw === "string" && !raw.trim() ? NaN : Number(raw);
  if (!Number.isFinite(value)) return spec.defaultValue;
  return Math.min(spec.max, Math.max(spec.min, Math.round(value)));
}

export function readTurnSafetyPref(spec: TurnSafetyPrefSpec): number {
  try {
    return normalizeTurnSafetyPref(
      spec,
      zotero()?.Prefs?.get?.(turnSafetyPrefKey(spec), true),
    );
  } catch {
    return spec.defaultValue;
  }
}

/** Returns the normalized number actually written, for the settings pane. */
export function writeTurnSafetyPref(
  spec: TurnSafetyPrefSpec,
  value: unknown,
): number {
  const normalized = normalizeTurnSafetyPref(spec, value);
  try {
    zotero()?.Prefs?.set?.(turnSafetyPrefKey(spec), normalized, true);
  } catch {
    /* A preference failure must not fail the settings pane. */
  }
  return normalized;
}

/**
 * The limits the runtime is built with. A fresh install, and a broken pref,
 * both resolve to `TURN_SAFETY_LIMITS` rather than an unbounded turn.
 */
export function readTurnSafetyLimits(): TurnSafetyLimits {
  const values = new Map<TurnSafetyPrefKey, number>();
  for (const spec of TURN_SAFETY_PREF_SPECS)
    values.set(spec.key, readTurnSafetyPref(spec));
  return {
    modelCalls: values.get("modelCalls") ?? TURN_SAFETY_LIMITS.modelCalls,
    inputTokens: values.get("inputTokens") ?? TURN_SAFETY_LIMITS.inputTokens,
    wallClockMs:
      (values.get("wallClockMinutes") ??
        TURN_SAFETY_LIMITS.wallClockMs / WALL_CLOCK_MINUTE_MS) *
      WALL_CLOCK_MINUTE_MS,
  };
}
