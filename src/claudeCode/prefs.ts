declare const Zotero: any;

import { config } from "../../package.json";
import type { ConversationSystem } from "../shared/types";
import {
  CLAUDE_MODEL_OPTIONS,
  CLAUDE_REASONING_OPTIONS,
  getClaudeGlobalConversationKeyRange,
  getClaudePaperConversationKeyRange,
  type ClaudeReasoningMode,
  type ClaudeRuntimeModel,
} from "./constants";
import { buildClaudeLibraryStateKey, buildClaudePaperStateKey } from "./state";
import { getClaudeProfileSignature } from "./projectSkills";

type ZoteroPrefsAPI = {
  get?: (key: string, global?: boolean) => unknown;
  set?: (key: string, value: unknown, global?: boolean) => void;
};

function getZoteroPrefs(): ZoteroPrefsAPI | null {
  return (
    (Zotero as unknown as { Prefs?: ZoteroPrefsAPI } | undefined)?.Prefs || null
  );
}

function prefKey(key: string): string {
  return `${config.prefsPrefix}.${key}`;
}

function getStringPref(key: string): string {
  const value = getZoteroPrefs()?.get?.(prefKey(key), true);
  return typeof value === "string" ? value : "";
}

function getNumberPref(key: string): number | null {
  const value = getZoteroPrefs()?.get?.(prefKey(key), true);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function setPref(key: string, value: unknown): void {
  getZoteroPrefs()?.set?.(prefKey(key), value, true);
}

function getJsonPref(key: string): Record<string, number> {
  const raw = getStringPref(key).trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const normalized: Record<string, number> = {};
    for (const [entryKey, entryValue] of Object.entries(parsed)) {
      const n = Number(entryValue);
      if (!Number.isFinite(n) || n <= 0) continue;
      normalized[entryKey] = Math.floor(n);
    }
    return normalized;
  } catch {
    return {};
  }
}

function setJsonPref(key: string, value: Record<string, number>): void {
  setPref(key, JSON.stringify(value));
}

function getJsonStringPref(key: string): Record<string, string> {
  const raw = getStringPref(key).trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const normalized: Record<string, string> = {};
    for (const [entryKey, entryValue] of Object.entries(parsed)) {
      if (typeof entryValue !== "string") continue;
      const trimmed = entryValue.trim();
      if (!trimmed) continue;
      normalized[entryKey] = trimmed;
    }
    return normalized;
  } catch {
    return {};
  }
}

function setJsonStringPref(key: string, value: Record<string, string>): void {
  setPref(key, JSON.stringify(value));
}

export function getConversationSystemPref(): ConversationSystem {
  return getStoredConversationSystemPref() || "upstream";
}

export function getStoredConversationSystemPref(): ConversationSystem | null {
  const raw = getStringPref("conversationSystem").trim().toLowerCase();
  if (raw === "claude_code") return "claude_code";
  if (raw === "codex") return "codex";
  if (raw === "upstream") return "upstream";
  return null;
}

export function setConversationSystemPref(system: ConversationSystem): void {
  if (system === "claude_code" || system === "codex") {
    setPref("conversationSystem", system);
    return;
  }
  setPref("conversationSystem", "upstream");
}

export function getLastUsedClaudeConversationMode(
  libraryID: number,
): "global" | "paper" | null {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return null;
  const map = getJsonStringPref("claudeCodeConversationModeMap");
  const value = map[buildGlobalConversationMapKey(libraryID)];
  return value === "global" || value === "paper" ? value : null;
}

export function setLastUsedClaudeConversationMode(
  libraryID: number,
  mode: "global" | "paper",
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const normalizedMode = mode === "global" ? "global" : "paper";
  const map = getJsonStringPref("claudeCodeConversationModeMap");
  map[buildGlobalConversationMapKey(libraryID)] = normalizedMode;
  setJsonStringPref("claudeCodeConversationModeMap", map);
}

export function removeLastUsedClaudeConversationMode(libraryID: number): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const map = getJsonStringPref("claudeCodeConversationModeMap");
  delete map[buildGlobalConversationMapKey(libraryID)];
  setJsonStringPref("claudeCodeConversationModeMap", map);
}

export function isClaudeCodeModeEnabled(): boolean {
  const value = getZoteroPrefs()?.get?.(prefKey("enableClaudeCodeMode"), true);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return false;
}

export function setClaudeCodeModeEnabled(enabled: boolean): void {
  setPref("enableClaudeCodeMode", Boolean(enabled));
}

export function getClaudeBridgeUrl(): string {
  const raw = getStringPref("agentBackendBridgeUrl").trim();
  if (!raw) return "http://127.0.0.1:19787";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `http://${raw}`;
}

export function setClaudeBridgeUrl(url: string): void {
  setPref("agentBackendBridgeUrl", url.trim());
}

export function getClaudeCustomInstructionPref(): string {
  return getStringPref("systemPrompt").trim();
}

export function getClaudeConfigSourcePref(): "default" | "user-only" | "zotero-only" {
  const raw = getStringPref("agentClaudeConfigSource").trim().toLowerCase();
  if (raw === "user-level" || raw === "user-only") return "user-only";
  if (raw === "zotero-specific" || raw === "zotero-only") return "zotero-only";
  return "default";
}

export function getClaudeSettingSourcesByPref(): Array<"user" | "project" | "local"> {
  const source = getClaudeConfigSourcePref();
  if (source === "user-only") return ["user"];
  if (source === "zotero-only") return ["project", "local"];
  return ["user", "project", "local"];
}

export function getClaudeSettingSourcesCsvByPref(): string {
  return getClaudeSettingSourcesByPref().join(",");
}

export function getClaudePermissionModePref(): "safe" | "yolo" {
  return getStringPref("agentPermissionMode").trim().toLowerCase() === "yolo"
    ? "yolo"
    : "safe";
}

export function setClaudePermissionModePref(mode: "safe" | "yolo"): void {
  setPref("agentPermissionMode", mode === "yolo" ? "yolo" : "safe");
}

export function getClaudeRuntimeModelPref(): ClaudeRuntimeModel {
  const raw = getStringPref("claudeCodeModel").trim().toLowerCase();
  return CLAUDE_MODEL_OPTIONS.includes(raw as ClaudeRuntimeModel)
    ? (raw as ClaudeRuntimeModel)
    : "sonnet";
}

export function setClaudeRuntimeModelPref(model: string): void {
  const normalized = model.trim().toLowerCase();
  if (!CLAUDE_MODEL_OPTIONS.includes(normalized as ClaudeRuntimeModel)) return;
  setPref("claudeCodeModel", normalized);
}

export function getClaudeReasoningModePref(): ClaudeReasoningMode {
  const raw = getStringPref("claudeCodeReasoning").trim().toLowerCase();
  return CLAUDE_REASONING_OPTIONS.includes(raw as ClaudeReasoningMode)
    ? (raw as ClaudeReasoningMode)
    : "auto";
}

export function setClaudeReasoningModePref(mode: ClaudeReasoningMode): void {
  if (!CLAUDE_REASONING_OPTIONS.includes(mode)) return;
  setPref("claudeCodeReasoning", mode);
}

export function isClaudeBlockStreamingEnabled(): boolean {
  const value = getZoteroPrefs()?.get?.(prefKey("claudeCodeBlockStreaming"), true);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return false;
}

export function setClaudeBlockStreamingEnabled(enabled: boolean): void {
  setPref("claudeCodeBlockStreaming", Boolean(enabled));
}

export function isClaudeAutoCompactEnabled(): boolean {
  const value = getZoteroPrefs()?.get?.(prefKey("claudeCodeAutoCompact"), true);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return false;
}

export function setClaudeAutoCompactEnabled(enabled: boolean): void {
  setPref("claudeCodeAutoCompact", Boolean(enabled));
}

export function getClaudeAutoCompactThresholdPercent(): number {
  const value = getZoteroPrefs()?.get?.(prefKey("claudeCodeAutoCompactThreshold"), true);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(80, Math.max(30, Math.round(parsed)));
}

export function setClaudeAutoCompactThresholdPercent(value: number): void {
  const normalized = Math.min(80, Math.max(30, Math.round(value)));
  setPref("claudeCodeAutoCompactThreshold", normalized);
}

export function getClaudeManagedInstructionTemplatePref(): string {
  return getStringPref("claudeCodeManagedInstructionTemplate").replace(/\r\n?/g, "\n");
}

export function setClaudeManagedInstructionTemplatePref(value: string): string {
  const normalized = String(value || "").replace(/\r\n?/g, "\n").trim();
  setPref("claudeCodeManagedInstructionTemplate", normalized);
  return normalized;
}

function buildLegacyPaperConversationMapKey(
  libraryID: number,
  paperItemID: number,
): string {
  return `${Math.floor(libraryID)}:${Math.floor(paperItemID)}`;
}

function buildPaperConversationMapKey(
  libraryID: number,
  paperItemID: number,
): string {
  return buildClaudePaperStateKey(libraryID, paperItemID);
}

function buildLegacyGlobalConversationMapKey(libraryID: number): string {
  return String(Math.floor(libraryID));
}

function buildGlobalConversationMapKey(libraryID: number): string {
  return buildClaudeLibraryStateKey(libraryID);
}

export function isConversationKeyInRange(
  value: number,
  kind: "global" | "paper",
): boolean {
  if (!Number.isFinite(value) || value <= 0) return false;
  const range = kind === "global"
    ? getClaudeGlobalConversationKeyRange()
    : getClaudePaperConversationKeyRange();
  return value >= range.start && value < range.endExclusive;
}

function getScopedLegacyAllocatedConversationKey(kind: "global" | "paper"): number | null {
  const value = getNumberPref(
    kind === "global"
      ? "claudeCodeLastAllocatedGlobalConversationKey"
      : "claudeCodeLastAllocatedPaperConversationKey",
  );
  return value && isConversationKeyInRange(value, kind) ? value : null;
}

export function getLastUsedClaudeGlobalConversationKey(
  libraryID: number,
): number | null {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return null;
  const map = getJsonPref("claudeCodeGlobalConversationMap");
  const scopedValue = Number(map[buildGlobalConversationMapKey(libraryID)]);
  if (Number.isFinite(scopedValue) && scopedValue > 0) return Math.floor(scopedValue);
  const legacyValue = Number(map[buildLegacyGlobalConversationMapKey(libraryID)]);
  if (!Number.isFinite(legacyValue) || legacyValue <= 0) return null;
  return isConversationKeyInRange(legacyValue, "global") ? Math.floor(legacyValue) : null;
}

export function setLastUsedClaudeGlobalConversationKey(
  libraryID: number,
  conversationKey: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  const map = getJsonPref("claudeCodeGlobalConversationMap");
  map[buildGlobalConversationMapKey(libraryID)] = Math.floor(conversationKey);
  setJsonPref("claudeCodeGlobalConversationMap", map);
}

export function removeLastUsedClaudeGlobalConversationKey(libraryID: number): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const map = getJsonPref("claudeCodeGlobalConversationMap");
  delete map[buildGlobalConversationMapKey(libraryID)];
  setJsonPref("claudeCodeGlobalConversationMap", map);
}

export function getLastUsedClaudePaperConversationKey(
  libraryID: number,
  paperItemID: number,
): number | null {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return null;
  if (!Number.isFinite(paperItemID) || paperItemID <= 0) return null;
  const map = getJsonPref("claudeCodePaperConversationMap");
  const scopedValue = Number(map[buildPaperConversationMapKey(libraryID, paperItemID)]);
  if (Number.isFinite(scopedValue) && scopedValue > 0) return Math.floor(scopedValue);
  const legacyValue = Number(map[buildLegacyPaperConversationMapKey(libraryID, paperItemID)]);
  if (!Number.isFinite(legacyValue) || legacyValue <= 0) return null;
  return isConversationKeyInRange(legacyValue, "paper") ? Math.floor(legacyValue) : null;
}

export function setLastUsedClaudePaperConversationKey(
  libraryID: number,
  paperItemID: number,
  conversationKey: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  if (!Number.isFinite(paperItemID) || paperItemID <= 0) return;
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  const map = getJsonPref("claudeCodePaperConversationMap");
  map[buildPaperConversationMapKey(libraryID, paperItemID)] = Math.floor(conversationKey);
  setJsonPref("claudeCodePaperConversationMap", map);
}

export function removeLastUsedClaudePaperConversationKey(
  libraryID: number,
  paperItemID: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  if (!Number.isFinite(paperItemID) || paperItemID <= 0) return;
  const map = getJsonPref("claudeCodePaperConversationMap");
  delete map[buildPaperConversationMapKey(libraryID, paperItemID)];
  setJsonPref("claudeCodePaperConversationMap", map);
}

function buildLastAllocatedMapKey(kind: "global" | "paper"): string {
  return `${getClaudeProfileSignature()}:${kind}`;
}

export function getLastAllocatedClaudeGlobalConversationKey(): number | null {
  const map = getJsonPref("claudeCodeLastAllocatedConversationKeyMap");
  const value = Number(map[buildLastAllocatedMapKey("global")]);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return getScopedLegacyAllocatedConversationKey("global");
}

export function setLastAllocatedClaudeGlobalConversationKey(conversationKey: number): void {
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  const current = getLastAllocatedClaudeGlobalConversationKey() || 0;
  const normalized = Math.floor(conversationKey);
  if (normalized <= current) return;
  const map = getJsonPref("claudeCodeLastAllocatedConversationKeyMap");
  map[buildLastAllocatedMapKey("global")] = normalized;
  setJsonPref("claudeCodeLastAllocatedConversationKeyMap", map);
  setPref("claudeCodeLastAllocatedGlobalConversationKey", normalized);
}

export function getLastAllocatedClaudePaperConversationKey(): number | null {
  const map = getJsonPref("claudeCodeLastAllocatedConversationKeyMap");
  const value = Number(map[buildLastAllocatedMapKey("paper")]);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return getScopedLegacyAllocatedConversationKey("paper");
}

export function setLastAllocatedClaudePaperConversationKey(conversationKey: number): void {
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  const current = getLastAllocatedClaudePaperConversationKey() || 0;
  const normalized = Math.floor(conversationKey);
  if (normalized <= current) return;
  const map = getJsonPref("claudeCodeLastAllocatedConversationKeyMap");
  map[buildLastAllocatedMapKey("paper")] = normalized;
  setJsonPref("claudeCodeLastAllocatedConversationKeyMap", map);
  setPref("claudeCodeLastAllocatedPaperConversationKey", normalized);
}
