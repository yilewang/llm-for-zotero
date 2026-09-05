/**
 * Capability discovery for locally-hosted models.
 *
 * Ollama exposes richer metadata than any hosted `/v1/models`: `/api/tags`
 * lists what is installed and `/api/show` reports, per model, the real trained
 * context window and a `capabilities` array covering vision, tools and
 * thinking. Feeding that into the shared `DiscoveredModel` shape means the rest
 * of the capability pipeline needs no special-casing.
 *
 * Only cheap, reliable signals are read here. Anything the server does not
 * state plainly is left for the user to set in the per-model parameter editor
 * rather than guessed from the model name.
 */

// apiHelpers is a leaf module; importing the transport layer here would close
// a cycle back through modelProviders into modelCapabilities.
import {
  getAbortController,
  resolveOllamaNativeApiRoot,
} from "../utils/apiHelpers";
import { MODEL_CAPABILITY_MAX_TOKEN_LIMIT } from "./registry";
import type { DiscoveredModel, ModelCapabilityLimits } from "./types";

/** Values Ollama reports in `/api/show` → `capabilities`. */
const CAPABILITY_VISION = "vision";
const CAPABILITY_TOOLS = "tools";
const CAPABILITY_THINKING = "thinking";

/**
 * Ollama names every tag explicitly — `/api/tags` reports `qwen3:latest`
 * while the same weights answer to plain `qwen3` on every endpoint. Compare
 * ids with the implicit `:latest` stripped so a hand-typed short name still
 * finds the catalog row (and its context window and thinking capability).
 * Hosted ids never contain `:latest`, so exact matching stays authoritative
 * everywhere else.
 */
export function stripImplicitLatestTag(id: string): string {
  return id.endsWith(":latest") ? id.slice(0, -":latest".length) : id;
}

type OllamaTagsResponse = {
  models?: Array<{
    name?: unknown;
    model?: unknown;
    modified_at?: unknown;
    details?: {
      family?: unknown;
      parameter_size?: unknown;
      quantization_level?: unknown;
    };
  }>;
};

type OllamaShowResponse = {
  capabilities?: unknown;
  details?: { family?: unknown; parameter_size?: unknown };
  model_info?: Record<string, unknown>;
};

export type OllamaModelSummary = {
  id: string;
  /** Changes when the model is re-pulled, so it doubles as a cache key. */
  modifiedAt?: string;
  family?: string;
  parameterSize?: string;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * `undefined` when the server said nothing — distinct from `[]`, which is the
 * server stating this model has no special capabilities.  Only a stated answer
 * may become a `false` in the catalog.
 */
function asCapabilityList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry) => asString(entry).toLowerCase())
    .filter((entry) => Boolean(entry));
}

/**
 * The trained context window lives under an architecture-prefixed key, e.g.
 * `qwen3.context_length`. Read `general.architecture` to find it, and fall back
 * to any `*.context_length` key so an unfamiliar architecture still resolves.
 */
export function readContextLength(
  modelInfo: Record<string, unknown> | undefined,
): number | undefined {
  if (!modelInfo) return undefined;
  const architecture = asString(modelInfo["general.architecture"]);
  const candidates = architecture
    ? [`${architecture}.context_length`]
    : ([] as string[]);
  for (const key of Object.keys(modelInfo)) {
    if (key.endsWith(".context_length") && !candidates.includes(key)) {
      candidates.push(key);
    }
  }
  for (const key of candidates) {
    const value = Number(modelInfo[key]);
    if (
      Number.isSafeInteger(value) &&
      value > 0 &&
      value <= MODEL_CAPABILITY_MAX_TOKEN_LIMIT
    ) {
      return value;
    }
  }
  return undefined;
}

export function readArchitecture(
  modelInfo: Record<string, unknown> | undefined,
): string {
  return asString(modelInfo?.["general.architecture"]);
}

/** Map one `/api/show` payload onto the shared discovered-model shape. */
export function buildDiscoveredModelFromShow(params: {
  id: string;
  show: OllamaShowResponse;
}): DiscoveredModel {
  const capabilities = asCapabilityList(params.show.capabilities);
  const limits: ModelCapabilityLimits = {};
  const contextLength = readContextLength(params.show.model_info);
  if (contextLength) limits.contextWindowTokens = contextLength;

  return {
    id: params.id,
    ...(Object.keys(limits).length ? { limits } : {}),
    // A stated capability list is authoritative for the artifact actually
    // loaded: a model name may look like a reasoning model while this
    // particular GGUF is a non-thinking variant, and vice versa.  An absent
    // list is not an answer — older servers and proxies simply do not report
    // one — so the fields stay unset and the optimistic defaults survive.
    ...(capabilities
      ? {
          inputs: { image: capabilities.includes(CAPABILITY_VISION) },
          features: { tools: capabilities.includes(CAPABILITY_TOOLS) },
          reasoningSupported: capabilities.includes(CAPABILITY_THINKING),
        }
      : {}),
    source: "live",
  };
}

async function fetchJson(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const AbortControllerCtor = getAbortController();
  const controller = AbortControllerCtor
    ? new AbortControllerCtor()
    : undefined;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const response = await fetchFn(url, {
      ...init,
      headers: { Accept: "application/json", ...(init.headers || {}) },
      signal: controller?.signal,
    });
    if (!response.ok) {
      throw new Error(`${url} responded ${response.status}`);
    }
    return await response.json();
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** `GET /api/tags` — the installed model list. */
export async function fetchOllamaModelList(params: {
  fetchFn: typeof fetch;
  apiBase: string;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<OllamaModelSummary[]> {
  const root = resolveOllamaNativeApiRoot(params.apiBase);
  const payload = (await fetchJson(
    params.fetchFn,
    `${root}/tags`,
    { headers: authHeaders(params.apiKey) },
    params.timeoutMs ?? 10_000,
  )) as OllamaTagsResponse;
  const rows = Array.isArray(payload?.models) ? payload.models : [];
  const models: OllamaModelSummary[] = [];
  for (const row of rows) {
    if (models.length >= 4096) break;
    const id = asString(row?.name) || asString(row?.model);
    if (!id || id.length > 256) continue;
    models.push({
      id,
      ...(asString(row?.modified_at)
        ? { modifiedAt: asString(row.modified_at) }
        : {}),
      ...(asString(row?.details?.family)
        ? { family: asString(row.details?.family) }
        : {}),
      ...(asString(row?.details?.parameter_size)
        ? { parameterSize: asString(row.details?.parameter_size) }
        : {}),
    });
  }
  return models;
}

/** `POST /api/show` — per-model capabilities and the real context window. */
export async function fetchOllamaModelDetail(params: {
  fetchFn: typeof fetch;
  apiBase: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<DiscoveredModel | null> {
  const root = resolveOllamaNativeApiRoot(params.apiBase);
  try {
    const payload = (await fetchJson(
      params.fetchFn,
      `${root}/show`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(params.apiKey),
        },
        body: JSON.stringify({ model: params.model }),
      },
      params.timeoutMs ?? 10_000,
    )) as OllamaShowResponse;
    return buildDiscoveredModelFromShow({ id: params.model, show: payload });
  } catch (_error) {
    // A model that cannot be described still belongs in the picker; the user
    // can fill in its parameters by hand.
    return null;
  }
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Build the catalog for an Ollama server.
 *
 * `/api/tags` is one request and gives every installed model. `/api/show` is
 * one request *per model*, so it is issued only for the model the user has
 * actually selected — a sixty-model library must not fire sixty POSTs when the
 * panel opens.
 */
export async function fetchOllamaCatalog(params: {
  fetchFn: typeof fetch;
  apiBase: string;
  apiKey?: string;
  /** Model to describe in detail; others are returned as bare ids. */
  detailModel?: string;
  timeoutMs?: number;
}): Promise<DiscoveredModel[]> {
  const summaries = await fetchOllamaModelList(params);
  const detailId = (params.detailModel || "").trim();
  const detail = detailId
    ? await fetchOllamaModelDetail({
        fetchFn: params.fetchFn,
        apiBase: params.apiBase,
        model: detailId,
        apiKey: params.apiKey,
        timeoutMs: params.timeoutMs,
      })
    : null;

  // Merge by tag-normalized id but keep the catalog's canonical name: the
  // user may have typed `qwen3` while the server lists `qwen3:latest`, and
  // the /api/show detail must not be discarded over the implicit tag.
  const detailKey = detail ? stripImplicitLatestTag(detail.id) : null;
  return summaries.map((summary) =>
    detail && detailKey === stripImplicitLatestTag(summary.id)
      ? { ...detail, id: summary.id }
      : ({ id: summary.id, source: "live" } as DiscoveredModel),
  );
}

/** True when this identity should be served by the Ollama probe. */
export function usesOllamaCatalog(protocol: string | undefined): boolean {
  return protocol === "ollama_native";
}
