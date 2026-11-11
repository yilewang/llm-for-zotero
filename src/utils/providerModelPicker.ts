/**
 * Decision logic for the preferences model dropdown (fetch & select).
 *
 * The preferences pane owns the DOM; everything that can be decided without a
 * document lives here so the dropdown behaves identically under unit tests
 * and in the Gecko preferences window.
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
 * Sentinel `<option>` value for the "Customized…" row. Choosing it reveals
 * the manual text input instead of writing a model name.
 */
export const CUSTOMIZED_MODEL_OPTION_VALUE = "__llm-for-zotero-customized__";

export type ProviderModelSelectRow =
  | { kind: "placeholder" }
  | { kind: "model"; id: string; fromCatalog: boolean }
  | { kind: "customized" };

/**
 * Rows for the model `<select>`: the sorted live catalog, plus a saved model
 * the catalog does not know (so an existing configuration never disappears),
 * plus the trailing "Customized…" row. While the manual input is active the
 * saved text lives in that input, so it is not duplicated as an option.
 */
export function buildProviderModelSelectRows(args: {
  savedModel: string;
  catalog: DiscoveredModel[];
  customizedActive: boolean;
}): ProviderModelSelectRow[] {
  const saved = args.savedModel.trim();
  const sorted = sortModelOptions(args.catalog);
  const rows: ProviderModelSelectRow[] = [];
  if (!saved && !args.customizedActive) rows.push({ kind: "placeholder" });
  if (
    saved &&
    !args.customizedActive &&
    !sorted.some((model) => model.id === saved)
  ) {
    rows.push({ kind: "model", id: saved, fromCatalog: false });
  }
  for (const model of sorted) {
    rows.push({ kind: "model", id: model.id, fromCatalog: true });
  }
  rows.push({ kind: "customized" });
  return rows;
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

/**
 * Which field the model row should present: the catalog dropdown or the plain
 * text input. Manual entry wins while the catalog is unavailable, while the
 * user explicitly chose "Customized…", and always while the input has focus —
 * a late catalog refresh must never yank the field out from under typing.
 */
export function resolveModelEntryMode(args: {
  status: ProviderModelFetchStatus;
  userCustomized: boolean;
  inputFocused: boolean;
}): "select" | "manual" {
  if (args.userCustomized || args.inputFocused) return "manual";
  if (args.status.kind === "manual_entry") return "manual";
  return "select";
}
