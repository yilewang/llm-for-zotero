import { config } from "../../package.json";
import { DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE } from "./llmDefaults";
import {
  normalizeMaxTokens,
  normalizeOptionalInputTokenCap,
  normalizeTemperature,
} from "./normalization";
import {
  isProviderProtocol,
  normalizeProviderProtocolForAuthMode,
  type ProviderProtocol,
} from "./providerProtocol";
import { detectProviderPreset, getProviderPreset } from "./providerPresets";
import type { ProviderPresetId } from "./providerPresets";

export type LegacyModelSlotKey =
  | "primary"
  | "secondary"
  | "tertiary"
  | "quaternary";

export type AdvancedModelConfig = {
  temperature: number;
  maxTokens: number;
  inputTokenCap?: number;
};

export type ModelProviderModel = AdvancedModelConfig & {
  id: string;
  model: string;
  /** Per-model protocol override. When set, overrides the group-level protocol. */
  providerProtocol?: ProviderProtocol;
};

export type ModelProviderAuthMode = "api_key" | "codex_auth" | "codex_app_server" | "copilot_auth" | "webchat"; // [webchat]

export type ModelProviderGroup = {
  id: string;
  apiBase: string;
  apiKey: string;
  authMode: ModelProviderAuthMode;
  providerProtocol: ProviderProtocol;
  models: ModelProviderModel[];
  /** When "customized", UI shows Customized and allows editing URL; when undefined, preset is derived from apiBase. */
  presetIdOverride?: ProviderPresetId;
};

export type RuntimeModelEntry = {
  entryId: string;
  groupId: string;
  model: string;
  apiBase: string;
  apiKey: string;
  authMode: ModelProviderAuthMode;
  providerProtocol: ProviderProtocol;
  providerLabel: string;
  providerOrder: number;
  displayModelLabel: string;
  advanced: AdvancedModelConfig;
};

export type LegacyModelSlot = AdvancedModelConfig & {
  key: LegacyModelSlotKey;
  apiBase: string;
  apiKey: string;
  model: string;
};

export type LegacyMigrationResult = {
  groups: ModelProviderGroup[];
  legacyToEntryId: Partial<Record<LegacyModelSlotKey, string>>;
};

type AdvancedModelConfigInput = {
  temperature?: number | string | null;
  maxTokens?: number | string | null;
  inputTokenCap?: number | string | null;
};

type ZoteroPrefsAPI = {
  get?: (key: string, global?: boolean) => unknown;
  set?: (key: string, value: unknown, global?: boolean) => void;
};

const MODEL_PROVIDER_GROUPS_PREF_KEY = "modelProviderGroups";
const MODEL_PROVIDER_GROUPS_MIGRATION_VERSION_PREF_KEY =
  "modelProviderGroupsMigrationVersion";
const LAST_USED_MODEL_ENTRY_ID_PREF_KEY = "lastUsedModelEntryId";
const LEGACY_LAST_MODEL_PROFILE_PREF_KEY = "lastUsedModelProfile";
const MODEL_PROVIDER_GROUPS_MIGRATION_VERSION = 3;

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

function getMigrationVersion(): number {
  const value = getZoteroPrefs()?.get?.(
    prefKey(MODEL_PROVIDER_GROUPS_MIGRATION_VERSION_PREF_KEY),
    true,
  );
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
}

function createId(prefix: "provider" | "model"): string {
  const token = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${token}`;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeApiBase(apiBase: string): string {
  return normalizeString(apiBase).replace(/\/+$/, "");
}

function normalizeProviderAuthMode(value: unknown): ModelProviderAuthMode {
  if (value === "codex_auth") return "codex_auth";
  if (value === "codex_app_server") return "codex_app_server";
  if (value === "copilot_auth") return "copilot_auth";
  if (value === "webchat") return "webchat"; // [webchat]
  return "api_key";
}

function normalizeAdvancedModelConfig(
  value?: AdvancedModelConfigInput | null,
): AdvancedModelConfig {
  return {
    temperature: normalizeTemperature(
      `${value?.temperature ?? DEFAULT_TEMPERATURE}`,
    ),
    maxTokens: normalizeMaxTokens(`${value?.maxTokens ?? DEFAULT_MAX_TOKENS}`),
    inputTokenCap: normalizeOptionalInputTokenCap(value?.inputTokenCap),
  };
}

export function deriveProviderLabel(
  apiBase: string,
  providerIndex?: number,
): string {
  const normalizedBase = normalizeApiBase(apiBase);
  if (!normalizedBase) {
    return `Provider ${providerIndex || 1}`;
  }

  const host = extractProviderHost(normalizedBase);
  if (!host) {
    return `Provider ${providerIndex || 1}`;
  }
  const presetId = detectProviderPreset(normalizedBase);
  if (presetId !== "customized") {
    return getProviderPreset(presetId).label;
  }
  const lowerHost = host.toLowerCase();

  if (
    lowerHost === "generativelanguage.googleapis.com" ||
    lowerHost.endsWith(".generativelanguage.googleapis.com") ||
    lowerHost.includes("gemini")
  ) {
    return "Gemini";
  }
  if (lowerHost.includes("githubcopilot.com")) return "GitHub Copilot";
  if (lowerHost.includes("openai.com") || lowerHost === "chatgpt.com") {
    return "OpenAI";
  }
  if (lowerHost.includes("anthropic.com")) return "Anthropic";
  if (lowerHost.includes("minimax")) return "MiniMax";
  if (lowerHost.includes("bigmodel.cn") || lowerHost.includes("z.ai")) {
    return "GLM";
  }
  if (lowerHost.includes("deepseek.com")) return "DeepSeek";
  if (lowerHost.includes("moonshot.ai") || lowerHost.includes("moonshot.cn")) {
    return "Kimi";
  }
  if (lowerHost.includes("together.ai") || lowerHost.includes("together.xyz")) {
    return "Together.ai";
  }
  if (lowerHost.includes("openrouter.ai")) return "OpenRouter";
  if (lowerHost === "x.ai" || lowerHost.endsWith(".x.ai")) return "Grok";
  if (lowerHost.includes("groq.com")) return "Groq";
  if (lowerHost.includes("dashscope") || lowerHost.includes("aliyuncs.com")) {
    return "Qwen";
  }

  return host;
}

function extractProviderHost(apiBase: string): string {
  const normalizedBase = normalizeApiBase(apiBase);
  if (!normalizedBase) return "";
  try {
    const parsed = new URL(normalizedBase);
    return parsed.hostname.trim().toLowerCase();
  } catch (_err) {
    const fallback = normalizedBase
      .replace(/^[a-z]+:\/\//i, "")
      .split("/")[0]
      .trim()
      .toLowerCase();
    return fallback;
  }
}

function normalizeGroup(group: unknown): ModelProviderGroup | null {
  if (!group || typeof group !== "object") return null;
  const rawGroup = group as {
    id?: unknown;
    apiBase?: unknown;
    apiKey?: unknown;
    authMode?: unknown;
    providerProtocol?: unknown;
    models?: unknown;
    presetIdOverride?: unknown;
  };

  const models = Array.isArray(rawGroup.models)
    ? rawGroup.models
        .map((entry) => normalizeGroupModel(entry))
        .filter((entry): entry is ModelProviderModel => Boolean(entry))
    : [];

  const authMode = normalizeProviderAuthMode(rawGroup.authMode);
  const apiBase = normalizeApiBase(normalizeString(rawGroup.apiBase));
  return {
    id:
      typeof rawGroup.id === "string" && rawGroup.id.trim()
        ? rawGroup.id.trim()
        : createId("provider"),
    apiBase,
    apiKey: normalizeString(rawGroup.apiKey),
    authMode,
    providerProtocol: normalizeProviderProtocolForAuthMode({
      protocol: rawGroup.providerProtocol,
      authMode,
      apiBase,
    }),
    models,
    presetIdOverride: normalizePresetIdOverride(rawGroup.presetIdOverride),
  };
}
function normalizePresetIdOverride(
  value: unknown,
): ProviderPresetId | undefined {
  if (value !== "customized") return undefined;
  return "customized";
}

function normalizeGroupModel(model: unknown): ModelProviderModel | null {
  if (!model || typeof model !== "object") return null;
  const rawModel = model as {
    id?: unknown;
    model?: unknown;
    temperature?: unknown;
    maxTokens?: unknown;
    inputTokenCap?: unknown;
    providerProtocol?: unknown;
  };
  const modelName = normalizeString(rawModel.model);
  const advanced = normalizeAdvancedModelConfig({
    temperature: Number(rawModel.temperature),
    maxTokens: Number(rawModel.maxTokens),
    inputTokenCap: rawModel.inputTokenCap as number | string | undefined,
  });
  const modelProtocol = isProviderProtocol(rawModel.providerProtocol)
    ? rawModel.providerProtocol
    : undefined;
  return {
    id:
      typeof rawModel.id === "string" && rawModel.id.trim()
        ? rawModel.id.trim()
        : createId("model"),
    model: modelName,
    ...advanced,
    ...(modelProtocol ? { providerProtocol: modelProtocol } : {}),
  };
}

export function normalizeModelProviderGroups(
  raw: unknown,
): ModelProviderGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((group) => normalizeGroup(group))
    .filter((group): group is ModelProviderGroup => Boolean(group));
}

function parseStoredModelProviderGroups(raw: string): ModelProviderGroup[] {
  if (!raw.trim()) return [];
  try {
    return normalizeModelProviderGroups(JSON.parse(raw));
  } catch (_err) {
    return [];
  }
}

function storeModelProviderGroups(groups: ModelProviderGroup[]): void {
  setPref(MODEL_PROVIDER_GROUPS_PREF_KEY, JSON.stringify(groups));
  setPref(
    MODEL_PROVIDER_GROUPS_MIGRATION_VERSION_PREF_KEY,
    MODEL_PROVIDER_GROUPS_MIGRATION_VERSION,
  );
}

function resolveLegacyModelSlot(
  key: LegacyModelSlotKey,
): LegacyModelSlot | null {
  const suffixMap: Record<
    LegacyModelSlotKey,
    "" | "Primary" | "Secondary" | "Tertiary" | "Quaternary"
  > = {
    primary: "Primary",
    secondary: "Secondary",
    tertiary: "Tertiary",
    quaternary: "Quaternary",
  };
  const suffix = suffixMap[key];
  const modelName =
    key === "primary"
      ? (
          getStringPref(`model${suffix}`) ||
          getStringPref("model") ||
          "gpt-4o-mini"
        ).trim()
      : getStringPref(`model${suffix}`).trim();
  const apiBase =
    key === "primary"
      ? normalizeApiBase(
          getStringPref(`apiBase${suffix}`) || getStringPref("apiBase") || "",
        )
      : normalizeApiBase(getStringPref(`apiBase${suffix}`));
  const apiKey =
    key === "primary"
      ? (
          getStringPref(`apiKey${suffix}`) ||
          getStringPref("apiKey") ||
          ""
        ).trim()
      : getStringPref(`apiKey${suffix}`).trim();
  const temperature = normalizeTemperature(
    getStringPref(`temperature${suffix}`) || `${DEFAULT_TEMPERATURE}`,
  );
  const maxTokens = normalizeMaxTokens(
    getStringPref(`maxTokens${suffix}`) || `${DEFAULT_MAX_TOKENS}`,
  );
  const inputTokenCap = normalizeOptionalInputTokenCap(
    getStringPref(`inputTokenCap${suffix}`),
  );

  if (!apiBase && !apiKey && !modelName) return null;

  return {
    key,
    apiBase,
    apiKey,
    model: modelName,
    temperature,
    maxTokens,
    inputTokenCap,
  };
}

export function buildModelProviderGroupsFromLegacySlots(
  legacySlots: LegacyModelSlot[],
): LegacyMigrationResult {
  const groups: ModelProviderGroup[] = [];
  const groupByCredentials = new Map<string, ModelProviderGroup>();
  const legacyToEntryId: Partial<Record<LegacyModelSlotKey, string>> = {};

  for (const slot of legacySlots) {
    const normalizedBase = normalizeApiBase(slot.apiBase);
    const normalizedKey = slot.apiKey.trim();
    const sharedKey =
      normalizedBase || normalizedKey
        ? `${normalizedBase}\u0000${normalizedKey}`
        : "";

    let group: ModelProviderGroup | undefined;
    if (sharedKey) {
      group = groupByCredentials.get(sharedKey);
    }
    if (!group) {
      group = {
        id: createId("provider"),
        apiBase: normalizedBase,
        apiKey: normalizedKey,
        authMode: "api_key",
        providerProtocol: normalizeProviderProtocolForAuthMode({
          authMode: "api_key",
          apiBase: normalizedBase,
        }),
        models: [],
      };
      groups.push(group);
      if (sharedKey) {
        groupByCredentials.set(sharedKey, group);
      }
    }

    if (!slot.model.trim()) continue;
    const entry: ModelProviderModel = {
      id: createId("model"),
      model: slot.model.trim(),
      ...normalizeAdvancedModelConfig(slot),
    };
    group.models.push(entry);
    legacyToEntryId[slot.key] = entry.id;
  }

  return { groups, legacyToEntryId };
}

function migrateLegacyModelProviderGroups(): ModelProviderGroup[] {
  const legacySlots = (
    ["primary", "secondary", "tertiary", "quaternary"] as LegacyModelSlotKey[]
  )
    .map((key) => resolveLegacyModelSlot(key))
    .filter((slot): slot is LegacyModelSlot => Boolean(slot));
  const migration = buildModelProviderGroupsFromLegacySlots(legacySlots);
  storeModelProviderGroups(migration.groups);

  const legacyLastUsedProfile = getStringPref(
    LEGACY_LAST_MODEL_PROFILE_PREF_KEY,
  )
    .trim()
    .toLowerCase();
  if (
    legacyLastUsedProfile &&
    legacyLastUsedProfile in migration.legacyToEntryId &&
    migration.legacyToEntryId[legacyLastUsedProfile as LegacyModelSlotKey]
  ) {
    setPref(
      LAST_USED_MODEL_ENTRY_ID_PREF_KEY,
      migration.legacyToEntryId[legacyLastUsedProfile as LegacyModelSlotKey],
    );
  }

  return migration.groups;
}

function ensureModelProviderGroups(): ModelProviderGroup[] {
  const raw = getStringPref(MODEL_PROVIDER_GROUPS_PREF_KEY);
  if (raw.trim()) {
    const parsed = parseStoredModelProviderGroups(raw);
    if (getMigrationVersion() < MODEL_PROVIDER_GROUPS_MIGRATION_VERSION) {
      storeModelProviderGroups(parsed);
    }
    return parsed;
  }
  if (getMigrationVersion() >= MODEL_PROVIDER_GROUPS_MIGRATION_VERSION) {
    return [];
  }
  return migrateLegacyModelProviderGroups();
}

export function getModelProviderGroups(): ModelProviderGroup[] {
  return ensureModelProviderGroups();
}

export function setModelProviderGroups(groups: ModelProviderGroup[]): void {
  storeModelProviderGroups(normalizeModelProviderGroups(groups));
}

export function createEmptyProviderGroup(): ModelProviderGroup {
  return {
    id: createId("provider"),
    apiBase: "",
    apiKey: "",
    authMode: "api_key",
    providerProtocol: "openai_chat_compat",
    models: [],
  };
}

export function createProviderModelEntry(
  model = "",
  advanced?: Partial<AdvancedModelConfig>,
  providerProtocol?: ProviderProtocol,
): ModelProviderModel {
  return {
    id: createId("model"),
    model: model.trim(),
    ...normalizeAdvancedModelConfig(advanced),
    ...(providerProtocol ? { providerProtocol } : {}),
  };
}

export function getRuntimeModelEntries(): RuntimeModelEntry[] {
  const groups = getModelProviderGroups();
  const entries: RuntimeModelEntry[] = [];

  for (const [groupIndex, group] of groups.entries()) {
    const authMode = normalizeProviderAuthMode(group.authMode);
    const baseProviderLabel = deriveProviderLabel(
      group.apiBase,
      groupIndex + 1,
    );
    // [webchat] Use "ChatGPT Web" (or target label) as provider label
    const providerLabel =
      authMode === "webchat"
        ? `${baseProviderLabel} (web)`
        : authMode === "codex_auth"
          ? `${baseProviderLabel} (codex auth, legacy)`
          : authMode === "codex_app_server"
            ? `${baseProviderLabel} (app server)`
            : authMode === "copilot_auth"
              ? `${baseProviderLabel} (copilot auth)`
              : baseProviderLabel;
    const normalizedCounts = new Map<string, number>();
    for (const modelEntry of group.models) {
      const modelName = modelEntry.model.trim();
      if (!modelName) continue;
      const normalizedModel = modelName.toLowerCase();
      const duplicateCount = (normalizedCounts.get(normalizedModel) || 0) + 1;
      normalizedCounts.set(normalizedModel, duplicateCount);
      // [webchat] Display as "web/chatgpt" etc.
      const baseModelLabel =
        authMode === "webchat"
          ? `web/${modelName}`
          : authMode === "codex_auth"
            ? `codex/${modelName}`
            : authMode === "codex_app_server"
              ? `codex-app/${modelName}`
              : authMode === "copilot_auth"
                ? `copilot/${modelName}`
                : modelName;
      entries.push({
        entryId: modelEntry.id,
        groupId: group.id,
        model: modelName,
        apiBase: normalizeApiBase(group.apiBase),
        apiKey: group.apiKey.trim(),
        authMode,
        providerProtocol: normalizeProviderProtocolForAuthMode({
          protocol: modelEntry.providerProtocol || group.providerProtocol,
          authMode,
          apiBase: group.apiBase,
        }),
        providerLabel,
        providerOrder: groupIndex,
        displayModelLabel:
          duplicateCount > 1
            ? `${baseModelLabel} #${duplicateCount}`
            : baseModelLabel,
        advanced: normalizeAdvancedModelConfig(modelEntry),
      });
    }
  }

  return entries;
}

export function getModelEntryById(
  entryId: string | undefined | null,
): RuntimeModelEntry | null {
  const normalizedId = normalizeString(entryId);
  if (!normalizedId) return null;
  return (
    getRuntimeModelEntries().find((entry) => entry.entryId === normalizedId) ||
    null
  );
}

export function getDefaultModelEntry(): RuntimeModelEntry | null {
  const entries = getRuntimeModelEntries();
  return entries[0] || null;
}

export function getDefaultProviderGroup(): ModelProviderGroup | null {
  const groups = getModelProviderGroups();
  return groups[0] || null;
}

export function getLastUsedModelEntryId(): string {
  return getStringPref(LAST_USED_MODEL_ENTRY_ID_PREF_KEY).trim();
}

export function setLastUsedModelEntryId(entryId: string): void {
  setPref(LAST_USED_MODEL_ENTRY_ID_PREF_KEY, entryId.trim());
}

export function getModelProviderGroupsPrefKey(): string {
  return MODEL_PROVIDER_GROUPS_PREF_KEY;
}
