/**
 * Antigravity's models and thinking levels, as agy reports them.
 *
 * ACP has no model-list call: agy describes its models in each session's
 * state. The `model` option names the base models; `models.availableModels`
 * lists every model with its thinking level as a suffix
 * (`gemini-4-argon-medium`), which tells which levels each base model has.
 * The catalog is remembered from every session a turn opens; the picker can
 * also load it by opening a session and closing it at once.
 */

import type { AcpSessionState } from "../shared/acpProtocol";
import type { AcpClient } from "./acpClient";
import type { AgyLaunchOptions } from "./agyProcess";

export type AntigravityThoughtLevel = { value: string; name: string };

export type AntigravityModelEntry = {
  /** agy's `model` option value, such as `gemini-4-argon`. */
  id: string;
  name: string;
  /** The levels this model accepts; empty when it has none. */
  thoughtLevels: AntigravityThoughtLevel[];
};

export type AntigravityModelCatalog = {
  models: AntigravityModelEntry[];
  /** Every model id agy runs, level included (`gemini-4-argon-high`). */
  modelIds: string[];
  /** agy's own choice for a new session. */
  defaultModel: string;
  defaultThoughtLevel: string;
};

export const ANTIGRAVITY_MODEL_OPTION_ID = "model";
export const ANTIGRAVITY_THOUGHT_LEVEL_OPTION_ID = "thought_level";

const LEVEL_NAMES: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** The catalog a session state describes, or null if it names no models. */
export function buildAntigravityModelCatalog(
  state: AcpSessionState | null | undefined,
): AntigravityModelCatalog | null {
  const options = state?.configOptions ?? [];
  const modelOption = options.find(
    (option) => option.id === ANTIGRAVITY_MODEL_OPTION_ID,
  );
  if (!modelOption?.options?.length) return null;
  const levelOption = options.find(
    (option) => option.id === ANTIGRAVITY_THOUGHT_LEVEL_OPTION_ID,
  );
  const levelNames = new Map(
    (levelOption?.options ?? []).map((entry) => [entry.value, entry.name]),
  );
  const available = (state?.models?.availableModels ?? []).map(
    (model) => model.modelId,
  );
  const models = modelOption.options.map((option) => {
    const prefix = `${option.value}-`;
    const levels: AntigravityThoughtLevel[] = [];
    for (const id of available) {
      if (!id.startsWith(prefix)) continue;
      const value = id.slice(prefix.length);
      if (!/^[a-z]+$/.test(value) || !(value in LEVEL_NAMES)) continue;
      if (levels.some((level) => level.value === value)) continue;
      levels.push({
        value,
        name: levelNames.get(value) || LEVEL_NAMES[value],
      });
    }
    const order = Object.keys(LEVEL_NAMES);
    levels.sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value));
    return {
      id: option.value,
      name: option.name || option.value,
      thoughtLevels: levels,
    };
  });
  return {
    models,
    modelIds: available,
    defaultModel: modelOption.currentValue,
    defaultThoughtLevel: levelOption?.currentValue || "",
  };
}

/**
 * The model and level to apply for the user's picks: an unknown model falls
 * back to agy's own, and a level the model lacks to agy's own for it.
 */
export function resolveAntigravityModelChoice(
  catalog: AntigravityModelCatalog,
  picked: { model: string; thoughtLevel: string },
): { model: string; thoughtLevel: string } {
  const model =
    catalog.models.find((entry) => entry.id === picked.model) ??
    catalog.models.find((entry) => entry.id === catalog.defaultModel);
  if (!model) return { model: "", thoughtLevel: "" };
  const levels = model.thoughtLevels.map((level) => level.value);
  const thoughtLevel = levels.includes(picked.thoughtLevel)
    ? picked.thoughtLevel
    : levels.includes(catalog.defaultThoughtLevel)
      ? catalog.defaultThoughtLevel
      : "";
  return { model: model.id, thoughtLevel };
}

let rememberedCatalog: AntigravityModelCatalog | null = null;

/** Keeps the catalog from a session agy opened. */
export function rememberAntigravityModelCatalog(
  state: AcpSessionState | null | undefined,
): AntigravityModelCatalog | null {
  const catalog = buildAntigravityModelCatalog(state);
  if (catalog) rememberedCatalog = catalog;
  return catalog;
}

export function getRememberedAntigravityModelCatalog(): AntigravityModelCatalog | null {
  return rememberedCatalog;
}

/** Sets (or, with null, forgets) the remembered catalog, for tests. */
export function setAntigravityModelCatalogForTests(
  catalog: AntigravityModelCatalog | null,
): void {
  rememberedCatalog = catalog;
}

/**
 * The catalog, remembered or loaded by opening a session (closed at once)
 * on the pooled agy for `launch`.
 */
export async function loadAntigravityModelCatalog(params: {
  launch: AgyLaunchOptions;
  startClient: (launch: AgyLaunchOptions) => Promise<AcpClient>;
  force?: boolean;
}): Promise<AntigravityModelCatalog> {
  if (!params.force && rememberedCatalog) return rememberedCatalog;
  const client = await params.startClient(params.launch);
  const session = await client.newSession({
    cwd: params.launch.cwd,
    mcpServers: [],
  });
  await client.closeSession(session.sessionId).catch(() => undefined);
  const catalog = rememberAntigravityModelCatalog(session);
  if (!catalog) throw new Error("Antigravity reported no models.");
  return catalog;
}
