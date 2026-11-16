/**
 * Decision logic for the preferences model field (fetch & search).
 *
 * The preferences pane owns the DOM; everything that can be decided without a
 * document lives here so the field behaves the same in every host window.
 */

import type { DiscoveredModel } from "../modelCapabilities";
import type { ModelProviderGroup } from "./modelProviders";
import {
  resolveProviderPresetId,
  providerPresetCatalogRequiresApiKey,
} from "./providerPresets";

export type ProviderModelPickerGroup = Pick<ModelProviderGroup, "authMode"> &
  Partial<Pick<ModelProviderGroup, "apiBase" | "presetIdOverride">>;

/**
 * Fetch-and-select is offered for every API-key provider, including
 * "customized" ones (a remote Base URL that matches no preset). Other auth
 * modes (Codex, Copilot, webchat) have their own catalog flows.
 */
export function canFetchProviderModels(
  group: ProviderModelPickerGroup,
): boolean {
  return group.authMode === "api_key";
}

/**
 * Whether this group must have an API key before its catalog can be fetched.
 * Local runtimes and some gateways list models unauthenticated, so their
 * dropdown populates with the key field left blank.
 */
export function providerGroupRequiresApiKey(
  group: ProviderModelPickerGroup,
): boolean {
  return providerPresetCatalogRequiresApiKey(resolveProviderPresetId(group));
}

export function sortModelOptions(models: DiscoveredModel[]): DiscoveredModel[] {
  const seen = new Set<string>();
  const unique: DiscoveredModel[] = [];
  for (const model of models) {
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id === model.id ? model : { ...model, id });
  }
  return unique.sort(
    (left, right) =>
      left.id.localeCompare(right.id, undefined, { sensitivity: "base" }) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
}

/**
 * Suggestions for the searchable model field. `sortedIds` is the catalog
 * already ordered by `sortModelOptions`. The query is split on whitespace and
 * every word must occur in the ID (substring, case-insensitive). An empty
 * query matches everything. `offerCustom` is true when the trimmed query is
 * not itself a catalog ID, so the list can offer to use the typed text.
 */
export function filterModelSuggestions(
  sortedIds: readonly string[],
  query: string,
): {
  matches: string[];
  total: number;
  matchCount: number;
  offerCustom: boolean;
} {
  const trimmed = query.trim();
  const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = tokens.length
    ? sortedIds.filter((id) => {
        const lower = id.toLowerCase();
        return tokens.every((token) => lower.includes(token));
      })
    : [...sortedIds];
  return {
    matches,
    total: sortedIds.length,
    matchCount: matches.length,
    offerCustom: Boolean(trimmed) && !sortedIds.includes(trimmed),
  };
}

/**
 * Character ranges `[start, end)` of `id` to highlight for `query`: the first
 * case-insensitive occurrence of each whitespace-separated word, sorted, with
 * overlapping or touching ranges merged.
 */
export function highlightRanges(
  id: string,
  query: string,
): Array<[number, number]> {
  const lower = id.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const token of query.toLowerCase().split(/\s+/)) {
    if (!token) continue;
    const start = lower.indexOf(token);
    if (start >= 0) ranges.push([start, start + token.length]);
  }
  ranges.sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/**
 * Rewriting a native `<select>`'s options while its dropdown popup is open
 * crashes Gecko's popup helper ("this.element is null" in SelectChild.sys.mjs)
 * and can close the popup under the user. Content code cannot observe the
 * popup directly, so this gate tracks it conservatively: from the interaction
 * that can open it (mousedown/keydown) until it has provably closed (change,
 * blur). Rebuilds requested inside that window are deferred and flushed at the
 * next safe moment — when the popup closes, or right before it opens again.
 */
export function createSelectRebuildGate(rebuild: () => void): {
  /** Rebuild now if safe, otherwise once the popup is provably closed. */
  requestRebuild: () => void;
  /** Call on mousedown/keydown — runs before the popup opens, so it first flushes any pending rebuild. */
  popupMayOpen: () => void;
  /** Call on change/blur — the popup cannot still be open. */
  popupClosed: () => void;
} {
  let mayBeOpen = false;
  let pending = false;
  const flush = () => {
    if (!pending) return;
    pending = false;
    rebuild();
  };
  return {
    requestRebuild: () => {
      if (mayBeOpen) {
        pending = true;
        return;
      }
      rebuild();
    },
    popupMayOpen: () => {
      flush();
      mayBeOpen = true;
    },
    popupClosed: () => {
      mayBeOpen = false;
      flush();
    },
  };
}

/**
 * Run change-listener work AFTER Gecko's select-popup teardown finishes.
 *
 * When a dropdown pick closes the popup, SelectChild.sys.mjs dispatches the
 * `change` event from inside its `Forms:DismissedDropDown` handler and calls
 * the popup helper's `uninit()` right after the dispatch returns. Change-
 * listener work that destroys the select's frame (hiding it, replacing the
 * card) makes `HTMLSelectEventListener::Detach` fire `mozhidedropdown`, which
 * uninits the helper early — the trailing `uninit()` then crashes with
 * "this.element is null". A microtask runs once the actor's `receiveMessage`
 * fully returns (the entry-script stack must empty first) and before the next
 * paint, so the deferred work is re-entrancy-safe and visually seamless.
 */
export function runAfterSelectChangeDispatch(work: () => void): void {
  void Promise.resolve().then(work);
}

export type ProviderModelFetchStatus =
  | { kind: "needs_api_key" }
  | { kind: "loading" }
  /**
   * The catalog is unavailable (fetch failed, no endpoint, or an empty list).
   * The row falls back to the plain text input so the user types the model
   * name; `formatModelDiscoveryStatusHint` explains why in the status line.
   */
  | { kind: "manual_entry" }
  | { kind: "ready"; total: number; stale: boolean };

/** Status line shown under the model row while the catalog loads. */
export function resolveProviderModelFetchStatus(args: {
  apiKey: string;
  loading: boolean;
  snapshot: { models: DiscoveredModel[]; error?: string } | null;
  /** Absent means required, matching the preset default. */
  requiresApiKey?: boolean;
}): ProviderModelFetchStatus {
  const keyRequired = args.requiresApiKey !== false;
  if (keyRequired && !args.apiKey.trim()) return { kind: "needs_api_key" };
  const models = args.snapshot?.models || [];
  if (!models.length) {
    if (args.loading) return { kind: "loading" };
    return { kind: "manual_entry" };
  }
  return {
    kind: "ready",
    total: models.length,
    stale: Boolean(args.snapshot?.error),
  };
}

/** Shown when the provider gives no usable model list and no specific error applies. */
export const MODEL_LIST_UNAVAILABLE_HINT =
  "This provider did not return a model list; enter the model name manually.";

/** Error codes whose own message tells the user what to fix. */
const SPECIFIC_ERROR_CODES = new Set([
  "unauthorized",
  "forbidden",
  "rate_limited",
  "timeout",
  "missing_api_key",
]);

/**
 * Status line for the model row of every provider with a model picker.
 * It reports the missing API key, loading, and fetch failures, and always
 * leaves manual entry available. `detail` carries the raw error for a tooltip.
 */
export function formatModelDiscoveryStatusHint(args: {
  apiKey: string;
  requiresApiKey?: boolean;
  loading: boolean;
  snapshot: {
    models: DiscoveredModel[];
    error?: string;
    errorCode?: string;
  } | null;
}): { text: string; isError: boolean; detail?: string } | null {
  const keyRequired = args.requiresApiKey !== false;
  if (keyRequired && !args.apiKey.trim()) {
    return {
      text: "Enter the API key above to fetch this provider's models.",
      isError: false,
    };
  }
  const snapshot = args.snapshot;
  const hasModels = Boolean(snapshot?.models.length);
  if (args.loading && !hasModels) {
    return {
      text: "Fetching models…",
      isError: false,
    };
  }
  if (snapshot?.error) {
    if (snapshot.errorCode && SPECIFIC_ERROR_CODES.has(snapshot.errorCode)) {
      return { text: snapshot.error, isError: true, detail: snapshot.error };
    }
    if (!hasModels) {
      return {
        text: MODEL_LIST_UNAVAILABLE_HINT,
        isError: true,
        detail: snapshot.error,
      };
    }
    return null;
  }
  if (snapshot && !args.loading && !hasModels) {
    return { text: MODEL_LIST_UNAVAILABLE_HINT, isError: true };
  }
  return null;
}
