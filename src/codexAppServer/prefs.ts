declare const Services:
  | {
      prefs?: { prefHasUserValue?: (key: string) => boolean };
    }
  | undefined;

import {
  isRuntimeConversationSystemEnabled,
  setRuntimeConversationSystemEnabled,
} from "../shared/conversationSystemPrefs";
import {
  DEFAULT_CODEX_RUNTIME_MODEL,
  getCodexAllocatedConversationKeyRange,
  getCodexGlobalConversationKeyRange,
  getCodexPaperConversationKeyRange,
  getCodexProfileSignature,
  type CodexReasoningMode,
  type CodexRuntimeModel,
} from "./constants";
import { buildCodexLibraryStateKey } from "./state";
import {
  forgetPaperRestoreTarget,
  getPaperRestoreTarget,
  rememberPaperRestoreTarget,
} from "../shared/paperConversationRestore";
import {
  CODEX_ASK_PERMISSION_STATE,
  cloneCodexPermissionState,
  deserializeCodexPermissionState,
  serializeCodexPermissionState,
  type CodexPermissionState,
} from "./permissionState";
import {
  getZoteroPrefs,
  prefKey,
  readPositiveIntMapPref,
  readPositiveIntPref,
  readStringMapPref,
  readStringPref,
  writePref,
} from "../utils/pluginPrefs";

export type CodexNativeSkillMode = "native" | "legacy" | "off";

export function codexPrefHasUserValue(key: string): boolean {
  try {
    if (getZoteroPrefs()?.prefHasUserValue) {
      return Boolean(getZoteroPrefs()?.prefHasUserValue?.(prefKey(key)));
    }
    if (typeof Services !== "undefined" && Services?.prefs?.prefHasUserValue) {
      return Boolean(Services.prefs.prefHasUserValue(prefKey(key)));
    }
  } catch {
    return false;
  }
  return false;
}

function setJsonPref(key: string, value: Record<string, number>): void {
  writePref(key, JSON.stringify(value));
}

function setJsonStringPref(key: string, value: Record<string, string>): void {
  writePref(key, JSON.stringify(value));
}

export function isCodexAppServerModeEnabled(): boolean {
  return isRuntimeConversationSystemEnabled("codex");
}

export function setCodexAppServerModeEnabled(enabled: boolean): void {
  setRuntimeConversationSystemEnabled("codex", enabled);
}

export function getCodexRuntimeModelPref(): CodexRuntimeModel {
  return (
    readStringPref("codexAppServerModel").trim() || DEFAULT_CODEX_RUNTIME_MODEL
  );
}

export function setCodexRuntimeModelPref(model: string): void {
  const normalized = model.trim() || DEFAULT_CODEX_RUNTIME_MODEL;
  writePref("codexAppServerModel", normalized);
}

export function getCodexReasoningModePref(): CodexReasoningMode {
  const raw = readStringPref("codexAppServerReasoning").trim();
  return !raw || raw.toLowerCase() === "auto" ? "auto" : raw;
}

export function setCodexReasoningModePref(mode: CodexReasoningMode): void {
  const normalized = mode.trim();
  writePref(
    "codexAppServerReasoning",
    !normalized || normalized.toLowerCase() === "auto" ? "auto" : normalized,
  );
}

export function getCodexBinaryPathPref(): string {
  return readStringPref("codexAppServerPath").trim();
}

export function setCodexBinaryPathPref(path: string): void {
  writePref("codexAppServerPath", String(path || "").trim());
}

export { getCodexHomePref } from "../utils/codexHomePref";

export function setCodexHomePref(path: string): void {
  writePref("codexHome", String(path || "").trim());
}

export type CodexPermissionStatePreference = {
  state: CodexPermissionState;
  hasUserValue: boolean;
  error?: string;
  raw?: string;
};

export function readCodexPermissionStatePref(): CodexPermissionStatePreference {
  const hasUserValue = codexPrefHasUserValue("codexAppServerPermissionState");
  const raw = readStringPref("codexAppServerPermissionState").trim();
  if (!raw) {
    return {
      state: cloneCodexPermissionState(CODEX_ASK_PERMISSION_STATE),
      hasUserValue,
      ...(hasUserValue
        ? {
            error:
              "The saved Codex permission state is empty. Choose a Codex permission mode.",
          }
        : {}),
    };
  }
  const state = deserializeCodexPermissionState(raw);
  if (!state) {
    return {
      state: cloneCodexPermissionState(CODEX_ASK_PERMISSION_STATE),
      hasUserValue,
      raw,
      error:
        "The saved Codex permission state is invalid. Choose a Codex permission mode.",
    };
  }
  return { state, hasUserValue, raw };
}

export function setCodexPermissionStatePref(state: CodexPermissionState): void {
  writePref(
    "codexAppServerPermissionState",
    serializeCodexPermissionState(state),
  );
}

export function isCodexZoteroMcpToolsEnabled(): boolean {
  const value = getZoteroPrefs()?.get?.(
    prefKey("codexAppServerZoteroMcpToolsEnabled"),
    true,
  );
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return true;
}

export function setCodexZoteroMcpToolsEnabled(enabled: boolean): void {
  writePref("codexAppServerZoteroMcpToolsEnabled", Boolean(enabled));
}

export function isNativeZoteroMcpToolsEnabled(): boolean {
  return isCodexZoteroMcpToolsEnabled();
}

export function setNativeZoteroMcpToolsEnabled(enabled: boolean): void {
  setCodexZoteroMcpToolsEnabled(enabled);
}

export function getCodexNativeSkillModePref(): CodexNativeSkillMode {
  const raw = readStringPref("codexNativeSkillMode").trim().toLowerCase();
  if (raw === "legacy" || raw === "off") return raw;
  return "native";
}

export function getLastUsedCodexConversationMode(
  libraryID: number,
): "global" | "paper" | null {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return null;
  const map = readStringMapPref("codexAppServerConversationModeMap");
  const value = map[buildGlobalConversationMapKey(libraryID)];
  return value === "global" || value === "paper" ? value : null;
}

export function setLastUsedCodexConversationMode(
  libraryID: number,
  mode: "global" | "paper",
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const map = readStringMapPref("codexAppServerConversationModeMap");
  map[buildGlobalConversationMapKey(libraryID)] =
    mode === "paper" ? "paper" : "global";
  setJsonStringPref("codexAppServerConversationModeMap", map);
}

export function removeLastUsedCodexConversationMode(libraryID: number): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const map = readStringMapPref("codexAppServerConversationModeMap");
  delete map[buildGlobalConversationMapKey(libraryID)];
  setJsonStringPref("codexAppServerConversationModeMap", map);
}

function buildGlobalConversationMapKey(libraryID: number): string {
  return buildCodexLibraryStateKey(libraryID);
}

export function isConversationKeyInRange(
  value: number,
  kind: "global" | "paper",
): boolean {
  if (!Number.isFinite(value) || value <= 0) return false;
  const range =
    kind === "global"
      ? getCodexGlobalConversationKeyRange()
      : getCodexPaperConversationKeyRange();
  return value >= range.start && value < range.endExclusive;
}

function isConversationKeyInAllocatedRange(
  value: number,
  kind: "global" | "paper",
): boolean {
  if (!Number.isFinite(value) || value <= 0) return false;
  const range = getCodexAllocatedConversationKeyRange(kind);
  return value >= range.start && value < range.endExclusive;
}

export function getLastUsedCodexGlobalConversationKey(
  libraryID: number,
): number | null {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return null;
  const map = readPositiveIntMapPref("codexAppServerGlobalConversationMap");
  const value = Number(map[buildGlobalConversationMapKey(libraryID)]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return isConversationKeyInRange(value, "global") ? Math.floor(value) : null;
}

export function setLastUsedCodexGlobalConversationKey(
  libraryID: number,
  conversationKey: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  if (!isConversationKeyInRange(conversationKey, "global")) return;
  const map = readPositiveIntMapPref("codexAppServerGlobalConversationMap");
  map[buildGlobalConversationMapKey(libraryID)] = Math.floor(conversationKey);
  setJsonPref("codexAppServerGlobalConversationMap", map);
}

export function removeLastUsedCodexGlobalConversationKey(
  libraryID: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const map = readPositiveIntMapPref("codexAppServerGlobalConversationMap");
  delete map[buildGlobalConversationMapKey(libraryID)];
  setJsonPref("codexAppServerGlobalConversationMap", map);
}

export function getLastUsedCodexPaperConversationKey(
  libraryID: number,
  paperItemID: number,
): number | null {
  return getPaperRestoreTarget({
    system: "codex",
    libraryID,
    paperItemID,
  });
}

export function setLastUsedCodexPaperConversationKey(
  libraryID: number,
  paperItemID: number,
  conversationKey: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  if (!Number.isFinite(paperItemID) || paperItemID <= 0) return;
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  if (!isConversationKeyInRange(conversationKey, "paper")) return;
  rememberPaperRestoreTarget(
    { system: "codex", libraryID, paperItemID },
    conversationKey,
  );
}

export function removeLastUsedCodexPaperConversationKey(
  libraryID: number,
  paperItemID: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  if (!Number.isFinite(paperItemID) || paperItemID <= 0) return;
  forgetPaperRestoreTarget({ system: "codex", libraryID, paperItemID });
}

function buildLastAllocatedMapKey(kind: "global" | "paper"): string {
  return `${getCodexProfileSignature()}:${kind}`;
}

function getScopedLegacyAllocatedConversationKey(
  kind: "global" | "paper",
): number | null {
  const value = readPositiveIntPref(
    kind === "global"
      ? "codexAppServerLastAllocatedGlobalConversationKey"
      : "codexAppServerLastAllocatedPaperConversationKey",
  );
  return value && isConversationKeyInAllocatedRange(value, kind) ? value : null;
}

export function getLastAllocatedCodexGlobalConversationKey(): number | null {
  const map = readPositiveIntMapPref(
    "codexAppServerLastAllocatedConversationKeyMap",
  );
  const value = Number(map[buildLastAllocatedMapKey("global")]);
  if (
    Number.isFinite(value) &&
    isConversationKeyInAllocatedRange(value, "global")
  ) {
    return Math.floor(value);
  }
  return getScopedLegacyAllocatedConversationKey("global");
}

export function setLastAllocatedCodexGlobalConversationKey(
  conversationKey: number,
): void {
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  if (!isConversationKeyInAllocatedRange(conversationKey, "global")) return;
  const current = getLastAllocatedCodexGlobalConversationKey() || 0;
  const normalized = Math.floor(conversationKey);
  if (normalized <= current) return;
  const map = readPositiveIntMapPref(
    "codexAppServerLastAllocatedConversationKeyMap",
  );
  map[buildLastAllocatedMapKey("global")] = normalized;
  setJsonPref("codexAppServerLastAllocatedConversationKeyMap", map);
  writePref("codexAppServerLastAllocatedGlobalConversationKey", normalized);
}

export function getLastAllocatedCodexPaperConversationKey(): number | null {
  const map = readPositiveIntMapPref(
    "codexAppServerLastAllocatedConversationKeyMap",
  );
  const value = Number(map[buildLastAllocatedMapKey("paper")]);
  if (
    Number.isFinite(value) &&
    isConversationKeyInAllocatedRange(value, "paper")
  ) {
    return Math.floor(value);
  }
  return getScopedLegacyAllocatedConversationKey("paper");
}

export function setLastAllocatedCodexPaperConversationKey(
  conversationKey: number,
): void {
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  if (!isConversationKeyInAllocatedRange(conversationKey, "paper")) return;
  const current = getLastAllocatedCodexPaperConversationKey() || 0;
  const normalized = Math.floor(conversationKey);
  if (normalized <= current) return;
  const map = readPositiveIntMapPref(
    "codexAppServerLastAllocatedConversationKeyMap",
  );
  map[buildLastAllocatedMapKey("paper")] = normalized;
  setJsonPref("codexAppServerLastAllocatedConversationKeyMap", map);
  writePref("codexAppServerLastAllocatedPaperConversationKey", normalized);
}
