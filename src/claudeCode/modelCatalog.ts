import type { RuntimeModelEntry } from "../utils/modelProviders";

const CLAUDE_RUNTIME_GROUP_ID = "claude-runtime";
const CLAUDE_RUNTIME_ENTRY_PREFIX = "claude_runtime";
const CLAUDE_RUNTIME_PROVIDER_LABEL = "Claude Code";
export const CLAUDE_CUSTOMIZED_MODEL_OPTION_KEY = "customized";

// The bridge answers GET /models by spawning an SDK session and asking the
// Claude CLI for its catalog, so a cold start can legitimately take several
// seconds; the bound is generous on purpose. It exists only so a wedged CLI
// (stale auth is the realistic trigger) cannot pin the request — and with it
// the preferences model picker and the panel model menu, both of which disable
// their controls for the duration — forever.
export const CLAUDE_MODEL_CATALOG_REQUEST_TIMEOUT_MS = 20_000;

export type ClaudeModelCatalogEntry = {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels: string[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
};

export type ClaudeModelCatalog = {
  models: ClaudeModelCatalogEntry[];
  legacy: boolean;
};

export type ClaudeModelCatalogRequestContext = {
  conversationKey: string | number;
  scopeType: "paper" | "open";
  scopeId: string;
  scopeLabel?: string;
};

export type FetchClaudeModelCatalogParams = {
  bridgeUrl: string;
  settingSources: readonly string[] | string;
  context?: ClaudeModelCatalogRequestContext;
  forceRefresh?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type ClaudeModelPreferenceOption = {
  key: string;
  model: string;
  label: string;
  description: string;
};

export type ClaudeModelPreferenceSelection = {
  selectedKey: string;
  customized: boolean;
  customValue: string;
};

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  return typeof record[key] === "boolean"
    ? (record[key] as boolean)
    : undefined;
}

function normalizeEffortLevels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const levels: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const level =
      typeof raw === "string"
        ? raw.trim()
        : raw && typeof raw === "object"
          ? normalizeString(
              (raw as Record<string, unknown>).value ??
                (raw as Record<string, unknown>).level ??
                (raw as Record<string, unknown>).effort,
            )
          : "";
    if (!level || seen.has(level)) continue;
    seen.add(level);
    levels.push(level);
  }
  return levels;
}

function normalizeStructuredModel(
  value: unknown,
): ClaudeModelCatalogEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const modelValue = normalizeString(record.value);
  if (!modelValue) return null;
  const resolvedModel = normalizeString(record.resolvedModel);
  const supportsEffort = normalizeBoolean(record, "supportsEffort");
  const supportsAdaptiveThinking = normalizeBoolean(
    record,
    "supportsAdaptiveThinking",
  );
  const supportsFastMode = normalizeBoolean(record, "supportsFastMode");
  const supportsAutoMode = normalizeBoolean(record, "supportsAutoMode");
  return {
    value: modelValue,
    ...(resolvedModel ? { resolvedModel } : {}),
    displayName: normalizeString(record.displayName) || modelValue,
    description: normalizeString(record.description),
    ...(supportsEffort === undefined ? {} : { supportsEffort }),
    supportedEffortLevels: normalizeEffortLevels(record.supportedEffortLevels),
    ...(supportsAdaptiveThinking === undefined
      ? {}
      : { supportsAdaptiveThinking }),
    ...(supportsFastMode === undefined ? {} : { supportsFastMode }),
    ...(supportsAutoMode === undefined ? {} : { supportsAutoMode }),
  };
}

function dedupeModels(
  models: ClaudeModelCatalogEntry[],
): ClaudeModelCatalogEntry[] {
  const result: ClaudeModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.value)) continue;
    seen.add(model.value);
    result.push(model);
  }
  return result;
}

export function normalizeClaudeModelCatalog(
  value: unknown,
): ClaudeModelCatalog {
  if (!value || typeof value !== "object") {
    return { models: [], legacy: true };
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.modelInfos)) {
    return {
      models: dedupeModels(
        record.modelInfos
          .map((model) => normalizeStructuredModel(model))
          .filter((model): model is ClaudeModelCatalogEntry => Boolean(model)),
      ),
      legacy: false,
    };
  }

  const rawModels = Array.isArray(record.models) ? record.models : [];
  return {
    models: dedupeModels(
      rawModels
        .map((model) => normalizeString(model))
        .filter(Boolean)
        .map((model) => ({
          value: model,
          displayName: model,
          description: "",
          supportedEffortLevels: [],
        })),
    ),
    legacy: true,
  };
}

function normalizeBridgeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export async function fetchClaudeModelCatalog({
  bridgeUrl,
  settingSources,
  context,
  forceRefresh = false,
  timeoutMs = CLAUDE_MODEL_CATALOG_REQUEST_TIMEOUT_MS,
  fetchImpl = fetch,
}: FetchClaudeModelCatalogParams): Promise<ClaudeModelCatalog> {
  const baseUrl = normalizeBridgeUrl(bridgeUrl);
  if (!baseUrl) {
    throw new Error("Claude Code bridge URL is not configured");
  }
  const sources =
    typeof settingSources === "string"
      ? settingSources
      : Array.from(settingSources).join(",");
  const query = new URLSearchParams({ settingSources: sources });
  const conversationKey =
    context === undefined ? "" : String(context.conversationKey).trim();
  const scopeId = context?.scopeId.trim() || "";
  if (context && conversationKey && scopeId) {
    query.set("conversationKey", conversationKey);
    query.set("scopeType", context.scopeType);
    query.set("scopeId", scopeId);
    const scopeLabel = context.scopeLabel?.trim();
    if (scopeLabel) query.set("scopeLabel", scopeLabel);
  }
  if (forceRefresh) query.set("refresh", "1");
  // Gecko has no dependable AbortController, so the whole request is bounded
  // the way the rest of the codebase bounds work (runCommand, zoteroScript,
  // codexAppServerProcess): race it against a timer and clear the timer on
  // settle. The body read is inside the race too — a bridge that sends headers
  // but never finishes the body is the same hang to the caller.
  const requestPromise = (async () => {
    const response = await fetchImpl(`${baseUrl}/models?${query}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Bridge HTTP ${response.status}`);
    }
    return normalizeClaudeModelCatalog(await response.json());
  })();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  let raceResult: ClaudeModelCatalog | "timeout";
  try {
    raceResult = await Promise.race([requestPromise, timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
  if (raceResult === "timeout") {
    // Kept free of the network-error tokens formatBridgeUserError matches on
    // (fetch failed / NetworkError / ECONNREFUSED / ETIMEDOUT / aborted):
    // those cases drop the message and show only the generic "bridge not
    // running" hint, which is the wrong diagnosis for a bridge that accepted
    // the connection but never answered.
    throw new Error(
      `Claude Code bridge did not return the model list within ${timeoutMs}ms. Make sure the bridge service is running and your Claude Code login is still valid, then retry.`,
    );
  }
  return raceResult;
}

export function buildClaudeModelPreferenceOptions(
  models: ClaudeModelCatalogEntry[],
): ClaudeModelPreferenceOption[] {
  return models.map((model, index) => {
    const detail =
      model.resolvedModel && model.resolvedModel !== model.value
        ? model.resolvedModel
        : model.value;
    const displayName = model.displayName.trim() || model.value;
    return {
      key: `catalog:${index}`,
      model: model.value,
      label:
        displayName === detail ? displayName : `${displayName} — ${detail}`,
      description: model.description,
    };
  });
}

export function resolveClaudeModelPreferenceSelection(params: {
  options: ClaudeModelPreferenceOption[];
  selectedModel: string;
}): ClaudeModelPreferenceSelection {
  const selectedModel = params.selectedModel.trim();
  const matched = params.options.find(
    (option) => option.model === selectedModel,
  );
  return matched
    ? {
        selectedKey: matched.key,
        customized: false,
        customValue: "",
      }
    : {
        selectedKey: CLAUDE_CUSTOMIZED_MODEL_OPTION_KEY,
        customized: true,
        customValue: selectedModel,
      };
}

export function shouldPreserveClaudeCustomModelDraft(params: {
  customized: boolean;
  draftValue: string;
  selectedModel: string;
  focused: boolean;
}): boolean {
  // An empty unfocused draft carries no user input worth preserving; treating
  // it as preservable would freeze the pre-initialization "Customized" DOM
  // default before the first catalog sync runs.
  const draft = params.draftValue.trim();
  return (
    params.customized &&
    (params.focused || (draft !== "" && draft !== params.selectedModel.trim()))
  );
}

function createRuntimeModelEntry(params: {
  model: string;
  displayName: string;
  providerOrder: number;
}): RuntimeModelEntry {
  return {
    entryId: `${CLAUDE_RUNTIME_ENTRY_PREFIX}::${params.model}`,
    groupId: CLAUDE_RUNTIME_GROUP_ID,
    model: params.model,
    apiBase: "",
    apiKey: "",
    authMode: "api_key",
    providerProtocol: "anthropic_messages",
    providerLabel: CLAUDE_RUNTIME_PROVIDER_LABEL,
    providerOrder: params.providerOrder,
    displayModelLabel: params.displayName || params.model,
    advanced: {
      temperature: 0.7,
      maxTokens: 8192,
    },
  };
}

export function buildClaudeRuntimeModelEntries(params: {
  models: ClaudeModelCatalogEntry[];
  selectedModel: string;
}): RuntimeModelEntry[] {
  const selectedModel = params.selectedModel.trim();
  const entries: RuntimeModelEntry[] = [];
  const seen = new Set<string>();

  if (
    selectedModel &&
    !params.models.some((model) => model.value === selectedModel)
  ) {
    const resolvedCatalogModel = params.models.find(
      (model) => model.resolvedModel === selectedModel,
    );
    entries.push(
      createRuntimeModelEntry({
        model: selectedModel,
        displayName: resolvedCatalogModel
          ? `${resolvedCatalogModel.displayName} (${selectedModel})`
          : selectedModel,
        providerOrder: -1,
      }),
    );
    seen.add(selectedModel);
  }

  for (const [index, model] of params.models.entries()) {
    if (seen.has(model.value)) continue;
    seen.add(model.value);
    entries.push(
      createRuntimeModelEntry({
        model: model.value,
        displayName: model.displayName,
        providerOrder: index,
      }),
    );
  }

  if (!entries.length && selectedModel) {
    entries.push(
      createRuntimeModelEntry({
        model: selectedModel,
        displayName: selectedModel,
        providerOrder: 0,
      }),
    );
  }

  return entries;
}
