import type { RuntimeModelEntry } from "../utils/modelProviders";
import { DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE } from "../utils/llmDefaults";
import { CODEX_REASONING_OPTIONS } from "./constants";
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
};

export type CodexAppServerModelCatalog = {
  models: CodexAppServerModelCatalogEntry[];
};

export type CodexAppServerReasoningChoice = {
  value: string;
  label: string;
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

export function formatCodexAppServerReasoningLabel(value: string): string {
  const normalized = value.trim();
  if (normalized.toLowerCase() === "xhigh") return "XHigh";
  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getCodexAppServerReasoningChoices(params: {
  models: CodexAppServerModelCatalogEntry[];
  selectedModel: string;
}): CodexAppServerReasoningChoice[] {
  const selectedModel = params.selectedModel.trim().toLowerCase();
  const catalogModel = params.models.find(
    (model) => model.model.toLowerCase() === selectedModel,
  );
  const efforts = catalogModel
    ? catalogModel.supportedReasoningEfforts
    : CODEX_REASONING_OPTIONS;
  const choices: CodexAppServerReasoningChoice[] = [
    { value: "auto", label: "Auto" },
  ];
  const seen = new Set<string>(["auto"]);

  for (const effort of efforts) {
    const value = effort.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    choices.push({
      value,
      label: formatCodexAppServerReasoningLabel(value),
    });
  }

  return choices;
}

export function reconcileCodexAppServerReasoningMode(
  mode: string,
  choices: CodexAppServerReasoningChoice[],
): string {
  const normalized = mode.trim();
  if (!normalized || normalized.toLowerCase() === "auto") return "auto";
  return (
    choices.find(
      (choice) => choice.value.toLowerCase() === normalized.toLowerCase(),
    )?.value || "auto"
  );
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
