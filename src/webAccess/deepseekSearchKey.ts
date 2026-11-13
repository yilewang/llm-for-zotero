import { config } from "../../package.json";
import { getModelProviderGroups } from "../utils/modelProviders";

export const DEEPSEEK_SEARCH_ORIGIN = "https://api.deepseek.com";
const MODEL_PROVIDER_GROUPS_PREF = `${config.prefsPrefix}.modelProviderGroups`;

type ProviderGroupLike = {
  id: string;
  authMode: string;
  apiBase?: string;
  apiKey?: string;
  models?: ReadonlyArray<{ model?: string }>;
};

export type DeepSeekSearchCredential = {
  groupId: string;
  apiKey: string;
  /** First model of the group, which tells two official profiles apart. */
  label: string;
};

/**
 * Same rule as resolveQuotaTarget: only DeepSeek's own host receives the key.
 * A relay's key never reaches DeepSeek, even when the model or preset is named
 * DeepSeek.
 */
export function isOfficialDeepSeekApiBase(apiBase: string): boolean {
  try {
    const url = new URL(apiBase);
    return (
      url.protocol === "https:" &&
      !url.port &&
      !url.username &&
      !url.password &&
      url.origin === DEEPSEEK_SEARCH_ORIGIN
    );
  } catch {
    return false;
  }
}

/** Official DeepSeek API-key groups with a key, in profile order. */
export function listOfficialDeepSeekGroups<T extends ProviderGroupLike>(
  groups: readonly T[],
): T[] {
  return groups.filter(
    (group) =>
      group.authMode === "api_key" &&
      typeof group.apiKey === "string" &&
      Boolean(group.apiKey.trim()) &&
      typeof group.apiBase === "string" &&
      isOfficialDeepSeekApiBase(group.apiBase),
  );
}

/** The first qualifying group wins; there is no separate search key. */
export function resolveDeepSeekSearchCredential(
  groups: readonly ProviderGroupLike[],
): DeepSeekSearchCredential | null {
  const group = listOfficialDeepSeekGroups(groups)[0];
  return group
    ? {
        groupId: group.id,
        apiKey: String(group.apiKey).trim(),
        label: String(group.models?.[0]?.model || "").trim(),
      }
    : null;
}

/** Shows enough of a key to tell two keys apart, e.g. sk-…1234. */
export function maskApiKey(apiKey: string): string {
  const key = apiKey.trim();
  return key.length > 8 ? `${key.slice(0, 3)}…${key.slice(-4)}` : "…";
}

function readRawProviderGroups(): string {
  try {
    const value = Zotero.Prefs.get(MODEL_PROVIDER_GROUPS_PREF, true);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

// Validators, schema getters, and trace re-renders all ask for the chosen
// provider, so the profile parse is reused while the stored value is unchanged.
let cached: { raw: string; credential: DeepSeekSearchCredential | null } = {
  raw: "",
  credential: null,
};

/** Reads the official DeepSeek key from saved model profiles, not the chat model. */
export function getDeepSeekSearchCredential(): DeepSeekSearchCredential | null {
  const raw = readRawProviderGroups();
  // No saved profiles: skip the read, which would migrate legacy prefs.
  if (!raw.trim()) return null;
  if (raw === cached.raw) return cached.credential;
  let credential: DeepSeekSearchCredential | null = null;
  try {
    credential = resolveDeepSeekSearchCredential(getModelProviderGroups());
  } catch {
    credential = null;
  }
  // A migration may have rewritten the stored value; key on what is stored now.
  cached = {
    raw: readRawProviderGroups(),
    credential: credential ? Object.freeze(credential) : null,
  };
  return cached.credential;
}
