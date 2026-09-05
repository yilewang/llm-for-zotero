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
  detectProviderPreset,
  providerPresetRequiresApiKey,
} from "./providerPresets";
import type { ProviderPresetId } from "./providerPresets";

export type ProviderModelPickerGroup = Pick<ModelProviderGroup, "authMode"> &
  Partial<Pick<ModelProviderGroup, "apiBase" | "presetIdOverride">>;

/**
 * Preset the picker should treat the group as. Non-API-key auth modes (codex,
 * copilot, webchat) keep their dedicated model flows, so they resolve to
 * "customized" here regardless of the stored API base.
 */
export function resolveProviderPickerPresetId(
  group: ProviderModelPickerGroup,
): ProviderPresetId {
  if (group.authMode !== "api_key") return "customized";
  return group.presetIdOverride ?? detectProviderPreset(group.apiBase || "");
}

/** Fetch-and-select is offered only for preset (non-customized) API-key providers. */
export function canFetchProviderModels(
  group: ProviderModelPickerGroup,
): boolean {
  return resolveProviderPickerPresetId(group) !== "customized";
}

/**
 * Whether this group must have an API key before its catalog can be fetched.
 * Local runtimes serve unauthenticated, so their dropdown populates with the
 * key field left blank.
 */
export function providerGroupRequiresApiKey(
  group: ProviderModelPickerGroup,
): boolean {
  return providerPresetRequiresApiKey(resolveProviderPickerPresetId(group));
}

export function sortModelOptions(models: DiscoveredModel[]): DiscoveredModel[] {
  return [...models].sort((left, right) =>
    left.id.localeCompare(right.id, undefined, { sensitivity: "base" }),
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
   * This is deliberately silent: no error line is shown and the row falls
   * back to the plain text input so the user simply types the model name.
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
