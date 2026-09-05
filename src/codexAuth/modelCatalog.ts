import {
  buildCodexReasoningConfig,
  buildCodexReasoningChoices,
  reconcileCodexReasoningChoice,
  type CodexReasoningChoice,
  type CodexReasoningEffort,
} from "../codex/catalogSelection";
import type { ReasoningConfig } from "../shared/llm";
import {
  MODEL_CAPABILITY_MAX_TOKEN_LIMIT,
  publishModelCapabilityCatalog,
} from "../modelCapabilities";
import {
  CODEX_DIRECT_RESPONSES_URL,
  CODEX_DIRECT_MODELS_URL,
  fetchWithCodexAuth,
  type CodexAuthDependencies,
} from "./auth";

const CATALOG_TTL_MS = 60_000;
const CATALOG_TIMEOUT_MS = 5_000;
const CODEX_DIRECT_CAPABILITY_IDENTITY = {
  provider: "openai",
  model: "",
  apiBase: CODEX_DIRECT_RESPONSES_URL,
  protocol: "codex_responses",
  authMode: "codex_auth",
} as const;

export type CodexDirectCatalogModel = {
  model: string;
  displayName: string;
  description: string;
  priority: number;
  contextWindow?: number;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: CodexReasoningEffort[];
};

export type CodexDirectCatalogSnapshot = {
  status: "idle" | "loading" | "ready" | "error";
  models: CodexDirectCatalogModel[];
  fetchedAt?: number;
  error?: string;
};

export type LoadCodexDirectCatalogOptions = CodexAuthDependencies & {
  force?: boolean;
  timeoutMs?: number;
  now?: () => number;
};

const EMPTY_SNAPSHOT: CodexDirectCatalogSnapshot = {
  status: "idle",
  models: [],
};

let catalogSnapshot = EMPTY_SNAPSHOT;
let catalogRequest: Promise<CodexDirectCatalogSnapshot> | null = null;
const catalogSubscribers = new Set<
  (snapshot: CodexDirectCatalogSnapshot) => void
>();

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeReasoningEfforts(value: unknown): CodexReasoningEffort[] {
  if (!Array.isArray(value)) return [];
  const efforts: CodexReasoningEffort[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record =
      item && typeof item === "object"
        ? (item as Record<string, unknown>)
        : undefined;
    const effort =
      typeof item === "string"
        ? item.trim()
        : normalizeString(
            record?.effort ??
              record?.reasoning_level ??
              record?.reasoningLevel ??
              record?.value,
          );
    const key = effort.toLowerCase();
    if (!effort || seen.has(key)) continue;
    seen.add(key);
    const description = normalizeString(record?.description);
    efforts.push({
      value: effort,
      ...(description ? { description } : {}),
    });
  }
  return efforts;
}

function normalizeCatalogModel(
  value: unknown,
  serverOrder: number,
): (CodexDirectCatalogModel & { serverOrder: number }) | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (normalizeString(record.visibility).toLowerCase() !== "list") return null;
  const model = normalizeString(record.slug);
  if (!model) return null;
  const priority = normalizeNumber(record.priority) ?? 0;
  const contextWindow = normalizeNumber(record.context_window);
  const defaultReasoningEffort = normalizeString(
    record.default_reasoning_level,
  );
  return {
    model,
    displayName: normalizeString(record.display_name) || model,
    description: normalizeString(record.description),
    priority,
    supportedReasoningEfforts: normalizeReasoningEfforts(
      record.supported_reasoning_levels,
    ),
    ...(contextWindow !== undefined &&
    Number.isSafeInteger(contextWindow) &&
    contextWindow > 0 &&
    contextWindow <= MODEL_CAPABILITY_MAX_TOKEN_LIMIT
      ? { contextWindow }
      : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    serverOrder,
  };
}

export function normalizeCodexDirectCatalog(
  payload: unknown,
): CodexDirectCatalogModel[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const rawModels = Array.isArray(record.models)
    ? record.models
    : Array.isArray(record.data)
      ? record.data
      : [];
  const normalized = rawModels
    .map((model, index) => normalizeCatalogModel(model, index))
    .filter(
      (model): model is CodexDirectCatalogModel & { serverOrder: number } =>
        Boolean(model),
    );
  const seen = new Set<string>();
  const unique: Array<CodexDirectCatalogModel & { serverOrder: number }> = [];
  for (const model of normalized) {
    const key = model.model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(model);
  }
  unique.sort(
    (left, right) =>
      right.priority - left.priority || left.serverOrder - right.serverOrder,
  );
  const models: CodexDirectCatalogModel[] = [];
  for (const { serverOrder: _serverOrder, ...model } of unique) {
    models.push(model);
  }
  return models;
}

function publishCatalogSnapshot(snapshot: CodexDirectCatalogSnapshot): void {
  catalogSnapshot = snapshot;
  for (const subscriber of catalogSubscribers) subscriber(snapshot);
}

export function getCodexDirectCatalogSnapshot(): CodexDirectCatalogSnapshot {
  return catalogSnapshot;
}

export function subscribeToCodexDirectCatalog(
  subscriber: (snapshot: CodexDirectCatalogSnapshot) => void,
): () => void {
  catalogSubscribers.add(subscriber);
  return () => catalogSubscribers.delete(subscriber);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Codex Direct model catalog timed out")),
      timeoutMs,
    );
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export async function loadCodexDirectCatalog(
  options: LoadCodexDirectCatalogOptions = {},
): Promise<CodexDirectCatalogSnapshot> {
  const now = options.now || Date.now;
  if (
    !options.force &&
    catalogSnapshot.status === "ready" &&
    catalogSnapshot.fetchedAt !== undefined &&
    now() - catalogSnapshot.fetchedAt < CATALOG_TTL_MS
  ) {
    return catalogSnapshot;
  }
  if (catalogRequest) return catalogRequest;

  publishCatalogSnapshot({ status: "loading", models: [] });
  catalogRequest = withTimeout(
    (async () => {
      const response = await fetchWithCodexAuth(
        CODEX_DIRECT_MODELS_URL,
        { headers: { Accept: "application/json" } },
        options,
      );
      if (!response.ok) {
        throw new Error(
          `Codex Direct catalog failed: ${response.status} ${response.statusText} - ${await response.text()}`,
        );
      }
      const models = normalizeCodexDirectCatalog(
        (await response.json()) as unknown,
      );
      return models;
    })(),
    options.timeoutMs ?? CATALOG_TIMEOUT_MS,
  )
    .then((models) => {
      publishModelCapabilityCatalog(
        CODEX_DIRECT_CAPABILITY_IDENTITY,
        models.map((model) => ({
          id: model.model,
          displayName: model.displayName,
          source: "live" as const,
          ...(model.contextWindow
            ? { limits: { contextWindowTokens: model.contextWindow } }
            : {}),
        })),
      );
      const snapshot: CodexDirectCatalogSnapshot = {
        status: "ready",
        models,
        fetchedAt: now(),
      };
      publishCatalogSnapshot(snapshot);
      return snapshot;
    })
    .catch((error: unknown) => {
      const snapshot: CodexDirectCatalogSnapshot = {
        status: "error",
        models: [],
        error: error instanceof Error ? error.message : String(error),
      };
      publishCatalogSnapshot(snapshot);
      throw error;
    })
    .finally(() => {
      catalogRequest = null;
    });

  return catalogRequest;
}

export function getCodexDirectCatalogModel(
  model: string,
): CodexDirectCatalogModel | undefined {
  const key = model.trim().toLowerCase();
  if (!key || catalogSnapshot.status !== "ready") return undefined;
  return catalogSnapshot.models.find(
    (candidate) => candidate.model.toLowerCase() === key,
  );
}

export function assertCodexDirectModelAvailable(model: string): void {
  if (catalogSnapshot.status !== "ready") return;
  if (getCodexDirectCatalogModel(model)) return;
  throw new Error(
    `The Codex Direct model "${model}" is not available in the current catalog. Select another model before sending.`,
  );
}

export function getCodexDirectReasoningChoices(
  model: string,
): CodexReasoningChoice[] {
  const catalogModel = getCodexDirectCatalogModel(model);
  if (!catalogModel) {
    return buildCodexReasoningChoices({
      efforts: [],
      excludedEfforts: ["ultra"],
      showDefaultInAutoLabel: true,
    });
  }
  return buildCodexReasoningChoices({
    efforts: catalogModel.supportedReasoningEfforts,
    defaultEffort: catalogModel.defaultReasoningEffort,
    excludedEfforts: ["ultra"],
    showDefaultInAutoLabel: true,
  });
}

export function reconcileCodexDirectReasoningChoice(
  model: string,
  selection: string,
): string {
  if (catalogSnapshot.status !== "ready") return "auto";
  return reconcileCodexReasoningChoice(
    selection,
    getCodexDirectReasoningChoices(model),
  );
}

export function sanitizeCodexDirectReasoningConfig(
  model: string,
  reasoning: ReasoningConfig | undefined,
): ReasoningConfig | undefined {
  if (!reasoning?.effort) return undefined;
  return buildCodexReasoningConfig(
    reconcileCodexDirectReasoningChoice(model, reasoning.effort),
  );
}

export function resetCodexDirectCatalogForTests(): void {
  catalogRequest = null;
  publishModelCapabilityCatalog(CODEX_DIRECT_CAPABILITY_IDENTITY, []);
  publishCatalogSnapshot(EMPTY_SNAPSHOT);
}
