declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero";

export type LiveAgentCredentials = {
  model: string;
  apiBase: string;
  apiKey: string;
  providerProtocol: string;
  reasoningLevel?: string;
};

function environmentValue(key: string): string {
  try {
    return String(
      (
        globalThis as unknown as {
          Services?: { env?: { get?: (name: string) => string } };
        }
      ).Services?.env?.get?.(key) || "",
    ).trim();
  } catch {
    return "";
  }
}

function stringPrefFromContents(contents: string, key: string): string {
  const escaped = key.replace(/\./g, "\\.");
  const match = contents.match(
    new RegExp(`user_pref\\("${escaped}",\\s*("(?:\\\\.|[^"\\\\])*")\\);`),
  );
  if (!match) return "";
  try {
    return String(JSON.parse(match[1]));
  } catch {
    return "";
  }
}

function credentialsFromProviderGroups(
  serialized: string,
  requestedModel: string,
): LiveAgentCredentials | null {
  if (!serialized || !requestedModel) return null;
  try {
    const groups = JSON.parse(serialized) as Array<{
      apiBase?: unknown;
      apiKey?: unknown;
      providerProtocol?: unknown;
      models?: Array<{ model?: unknown }>;
    }>;
    for (const group of groups) {
      const model = group.models?.find(
        (entry) => String(entry.model || "") === requestedModel,
      );
      const apiBase = String(group.apiBase || "").trim();
      const apiKey = String(group.apiKey || "").trim();
      const providerProtocol = String(group.providerProtocol || "").trim();
      if (model && apiBase && apiKey && providerProtocol) {
        const reasoningLevel = environmentValue(
          "LLM_FOR_ZOTERO_LIVE_REASONING",
        );
        return {
          model: requestedModel,
          apiBase,
          apiKey,
          providerProtocol,
          ...(reasoningLevel ? { reasoningLevel } : {}),
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function legacyCredentials(readPref: (key: string) => string) {
  const apiKey = readPref("apiKey");
  const apiBase = readPref("apiBase");
  const model = readPref("model");
  return apiKey && apiBase && model
    ? {
        model,
        apiBase,
        apiKey,
        providerProtocol: "openai_chat_compat",
      }
    : null;
}

export async function resolveLiveAgentCredentials(): Promise<LiveAgentCredentials | null> {
  const requestedModel = environmentValue("LLM_FOR_ZOTERO_LIVE_MODEL");
  const activeRead = (key: string) =>
    String(Zotero.Prefs.get(`${PREF_PREFIX}.${key}`, true) || "");
  if (requestedModel) {
    const active = credentialsFromProviderGroups(
      activeRead("modelProviderGroups"),
      requestedModel,
    );
    if (active) return active;
  } else {
    const legacy = legacyCredentials(activeRead);
    if (legacy) return legacy;
  }

  const profilePath = environmentValue("LLM_FOR_ZOTERO_LIVE_PROFILE_PATH");
  if (!profilePath) return null;
  try {
    const contents = await Zotero.File.getContentsAsync(profilePath);
    if (typeof contents !== "string") return null;
    const readFilePref = (key: string) =>
      stringPrefFromContents(contents, `${PREF_PREFIX}.${key}`);
    if (requestedModel) {
      return credentialsFromProviderGroups(
        readFilePref("modelProviderGroups"),
        requestedModel,
      );
    }
    return legacyCredentials(readFilePref);
  } catch {
    return null;
  }
}
