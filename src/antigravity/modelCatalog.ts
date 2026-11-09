import type { RuntimeModelEntry } from "../utils/modelProviders";
import { listAgyModels, type AgyModel } from "./agyProcess";

export const ANTIGRAVITY_RUNTIME_PROVIDER_LABEL = "Antigravity";
const ANTIGRAVITY_RUNTIME_GROUP_ID = "antigravity-runtime";
const ANTIGRAVITY_RUNTIME_ENTRY_PREFIX = "antigravity";

/**
 * The menu entry for "let agy pick": its `model` is this id, never a real
 * slug, and it maps to an empty pref (no `--model` flag).
 */
export const ANTIGRAVITY_DEFAULT_MODEL_ID = "default";

export function toAntigravityModelPref(entryModel: string): string {
  const model = entryModel.trim();
  return model === ANTIGRAVITY_DEFAULT_MODEL_ID ? "" : model;
}

function createRuntimeModelEntry(params: {
  model: string;
  displayName: string;
  providerOrder: number;
}): RuntimeModelEntry {
  return {
    entryId: `${ANTIGRAVITY_RUNTIME_ENTRY_PREFIX}::${params.model}`,
    groupId: ANTIGRAVITY_RUNTIME_GROUP_ID,
    model: params.model,
    // The send path needs a non-empty base; agy itself is a local process.
    apiBase: "antigravity-cli://local",
    apiKey: "",
    authMode: "api_key",
    providerProtocol: "openai_chat_compat",
    providerLabel: ANTIGRAVITY_RUNTIME_PROVIDER_LABEL,
    providerOrder: params.providerOrder,
    displayModelLabel: params.displayName || params.model,
    advanced: {
      temperature: 0.7,
      outputTokenLimit: { mode: "auto" },
    },
  };
}

/**
 * The Antigravity model menu: the CLI default first, then the models
 * `agy models` returned, with a saved model kept even when the catalog no
 * longer lists it.
 */
export function buildAntigravityRuntimeModelEntries(params: {
  models: AgyModel[];
  selectedModel: string;
}): RuntimeModelEntry[] {
  const entries: RuntimeModelEntry[] = [
    createRuntimeModelEntry({
      model: ANTIGRAVITY_DEFAULT_MODEL_ID,
      displayName: "Antigravity default",
      providerOrder: -2,
    }),
  ];
  const seen = new Set<string>([ANTIGRAVITY_DEFAULT_MODEL_ID]);
  const selected = params.selectedModel.trim();
  if (selected && !params.models.some((model) => model.id === selected)) {
    entries.push(
      createRuntimeModelEntry({
        model: selected,
        displayName: selected,
        providerOrder: -1,
      }),
    );
    seen.add(selected);
  }
  for (const [index, model] of params.models.entries()) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    entries.push(
      createRuntimeModelEntry({
        model: model.id,
        displayName: model.label,
        providerOrder: index,
      }),
    );
  }
  return entries;
}

export function selectAntigravityRuntimeEntry(
  entries: RuntimeModelEntry[],
  selectedModel: string,
): RuntimeModelEntry {
  const wanted = selectedModel.trim() || ANTIGRAVITY_DEFAULT_MODEL_ID;
  return entries.find((entry) => entry.model === wanted) || entries[0]!;
}

type CatalogState = {
  binaryPath: string;
  models: AgyModel[];
  status: "idle" | "loading" | "ready" | "error";
  error: string;
  inFlight: Promise<AgyModel[]> | null;
};

const catalog: CatalogState = {
  binaryPath: "",
  models: [],
  status: "idle",
  error: "",
  inFlight: null,
};

export function getAntigravityModelCatalogSnapshot(): {
  models: AgyModel[];
  status: CatalogState["status"];
  error: string;
} {
  return {
    models: catalog.models,
    status: catalog.status,
    error: catalog.error,
  };
}

/**
 * Reads `agy models` once per binary path and keeps the list for every
 * panel. A failure keeps the last known list, so a menu never empties.
 */
export function loadAntigravityModelCatalog(
  binaryPath: string,
  options: { force?: boolean; list?: typeof listAgyModels } = {},
): Promise<AgyModel[]> {
  const pathChanged = binaryPath !== catalog.binaryPath;
  if (!options.force && !pathChanged && catalog.status === "ready") {
    return Promise.resolve(catalog.models);
  }
  if (catalog.inFlight && !pathChanged) return catalog.inFlight;
  if (pathChanged) catalog.models = [];
  catalog.binaryPath = binaryPath;
  catalog.status = "loading";
  catalog.error = "";
  const list = options.list ?? listAgyModels;
  const request = list(binaryPath || undefined)
    .then((models) => {
      if (catalog.inFlight === request) {
        catalog.models = models;
        catalog.status = "ready";
      }
      return models;
    })
    .catch((error: unknown) => {
      if (catalog.inFlight === request) {
        catalog.status = "error";
        catalog.error = error instanceof Error ? error.message : String(error);
      }
      return catalog.models;
    })
    .finally(() => {
      if (catalog.inFlight === request) catalog.inFlight = null;
    });
  catalog.inFlight = request;
  return request;
}

export function resetAntigravityModelCatalogForTests(): void {
  catalog.binaryPath = "";
  catalog.models = [];
  catalog.status = "idle";
  catalog.error = "";
  catalog.inFlight = null;
}
