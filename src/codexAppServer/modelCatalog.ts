import type { RuntimeModelEntry } from "../utils/modelProviders";
import { DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE } from "../utils/llmDefaults";
import { listCodexAppServerModels } from "./nativeClient";

const DEFAULT_MODEL_LIST_LIMIT = 100;
const CODEX_APP_SERVER_GROUP_ID = "codex_app_server";
const CODEX_APP_SERVER_PROVIDER_LABEL = "Codex";

export type CodexAppServerModelCatalogEntry = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
  inputModalities: string[];
};

export type CodexAppServerModelCatalog = {
  models: CodexAppServerModelCatalogEntry[];
};

export type ListCodexAppServerModelsParams = {
  codexPath?: string;
  includeHidden?: boolean;
  cursor?: string;
  limit?: number;
  processKey?: string;
};

export type ListCodexAppServerModelsFn = (
  params: ListCodexAppServerModelsParams,
) => Promise<unknown>;

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized: string[] = [];
  for (const entry of value) {
    const text = normalizeString(entry);
    if (text) normalized.push(text);
  }
  return normalized;
}

function normalizeReasoningEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const efforts: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const effort = entry.trim();
      if (effort) efforts.push(effort);
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const effort = normalizeString(
      (entry as Record<string, unknown>).reasoningEffort,
    );
    if (effort) efforts.push(effort);
  }
  return efforts;
}

function normalizeCatalogModel(
  value: unknown,
): CodexAppServerModelCatalogEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const model = normalizeString(record.model);
  if (!model) return null;
  const displayName = normalizeString(record.displayName) || model;
  const id = normalizeString(record.id) || model;
  const defaultReasoningEffort = normalizeString(record.defaultReasoningEffort);
  return {
    id,
    model,
    displayName,
    description: normalizeString(record.description),
    hidden: record.hidden === true,
    supportedReasoningEfforts: normalizeReasoningEfforts(
      record.supportedReasoningEfforts,
    ),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    inputModalities: normalizeStringArray(record.inputModalities),
  };
}

function normalizeCatalogPage(value: unknown): {
  models: CodexAppServerModelCatalogEntry[];
  nextCursor?: string;
} {
  if (!value || typeof value !== "object") {
    return { models: [] };
  }
  const record = value as Record<string, unknown>;
  const rawData = Array.isArray(record.data) ? record.data : [];
  const models = rawData
    .map((entry) => normalizeCatalogModel(entry))
    .filter((entry): entry is CodexAppServerModelCatalogEntry =>
      Boolean(entry),
    );
  const nextCursor = normalizeString(record.nextCursor);
  return {
    models,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

export async function loadCodexAppServerModelCatalog(params: {
  codexPath?: string;
  includeHidden?: boolean;
  limit?: number;
  processKey?: string;
  listModels?: ListCodexAppServerModelsFn;
}): Promise<CodexAppServerModelCatalog> {
  const listModels = params.listModels || listCodexAppServerModels;
  const includeHidden = params.includeHidden === true;
  const limit = params.limit ?? DEFAULT_MODEL_LIST_LIMIT;
  const models: CodexAppServerModelCatalogEntry[] = [];
  const seenModels = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const page = normalizeCatalogPage(
      await listModels({
        codexPath: params.codexPath,
        includeHidden,
        limit,
        cursor,
        processKey: params.processKey,
      }),
    );
    for (const model of page.models) {
      if (!includeHidden && model.hidden) continue;
      const key = model.model.toLowerCase();
      if (seenModels.has(key)) continue;
      seenModels.add(key);
      models.push(model);
    }
    if (!page.nextCursor || seenCursors.has(page.nextCursor)) break;
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  return { models };
}

function createRuntimeModelEntry(params: {
  model: string;
  displayModelLabel: string;
  codexPath?: string;
}): RuntimeModelEntry {
  return {
    entryId: `${CODEX_APP_SERVER_GROUP_ID}::${params.model}`,
    groupId: CODEX_APP_SERVER_GROUP_ID,
    model: params.model,
    apiBase: params.codexPath || "",
    apiKey: "",
    authMode: "codex_app_server",
    providerProtocol: "codex_responses",
    providerLabel: CODEX_APP_SERVER_PROVIDER_LABEL,
    providerOrder: -1,
    displayModelLabel: params.displayModelLabel,
    advanced: {
      temperature: DEFAULT_TEMPERATURE,
      maxTokens: DEFAULT_MAX_TOKENS,
    },
  };
}

export function buildCodexRuntimeModelEntries(params: {
  models: CodexAppServerModelCatalogEntry[];
  selectedModel: string;
  codexPath?: string;
}): RuntimeModelEntry[] {
  const selectedModel = params.selectedModel.trim();
  const entries: RuntimeModelEntry[] = [];
  const seenModels = new Set<string>();

  if (selectedModel) {
    const hasSelectedModel = params.models.some(
      (model) => model.model.toLowerCase() === selectedModel.toLowerCase(),
    );
    if (!hasSelectedModel) {
      entries.push(
        createRuntimeModelEntry({
          model: selectedModel,
          displayModelLabel: selectedModel,
          codexPath: params.codexPath,
        }),
      );
      seenModels.add(selectedModel.toLowerCase());
    }
  }

  for (const model of params.models) {
    const key = model.model.toLowerCase();
    if (seenModels.has(key)) continue;
    seenModels.add(key);
    entries.push(
      createRuntimeModelEntry({
        model: model.model,
        displayModelLabel: model.displayName || model.model,
        codexPath: params.codexPath,
      }),
    );
  }

  return entries;
}
