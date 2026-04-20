declare const Zotero: any;

import { config } from "../../package.json";
import type { ConversationSystem } from "../shared/types";
import {
  CLAUDE_MODEL_OPTIONS,
  CLAUDE_REASONING_OPTIONS,
  type ClaudeReasoningMode,
  type ClaudeRuntimeModel,
} from "./constants";

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

export function getConversationSystemPref(): ConversationSystem {
  const raw = getStringPref("conversationSystem").trim().toLowerCase();
  return raw === "claude_code" ? "claude_code" : "upstream";
}

export function setConversationSystemPref(system: ConversationSystem): void {
  setPref("conversationSystem", system === "claude_code" ? "claude_code" : "upstream");
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
  return getStringPref("agentBackendBridgeUrl").trim();
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

function buildPaperConversationMapKey(
  libraryID: number,
  paperItemID: number,
): string {
  return `${Math.floor(libraryID)}:${Math.floor(paperItemID)}`;
}

export function getLastUsedClaudeGlobalConversationKey(
  libraryID: number,
): number | null {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return null;
  const map = getJsonPref("claudeCodeGlobalConversationMap");
  const value = Number(map[String(Math.floor(libraryID))]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

export function setLastUsedClaudeGlobalConversationKey(
  libraryID: number,
  conversationKey: number,
): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  const map = getJsonPref("claudeCodeGlobalConversationMap");
  map[String(Math.floor(libraryID))] = Math.floor(conversationKey);
  setJsonPref("claudeCodeGlobalConversationMap", map);
}

export function removeLastUsedClaudeGlobalConversationKey(libraryID: number): void {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return;
  const map = getJsonPref("claudeCodeGlobalConversationMap");
  delete map[String(Math.floor(libraryID))];
  setJsonPref("claudeCodeGlobalConversationMap", map);
}

export function getLastUsedClaudePaperConversationKey(
  libraryID: number,
  paperItemID: number,
): number | null {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return null;
  if (!Number.isFinite(paperItemID) || paperItemID <= 0) return null;
  const map = getJsonPref("claudeCodePaperConversationMap");
  const value = Number(map[buildPaperConversationMapKey(libraryID, paperItemID)]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
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
