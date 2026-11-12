/**
 * Lightweight on-demand model discovery architecture and SiliconFlow adapter.
 *
 * Attribution & Third-Party Notices:
 * - Architectural patterns for on-demand provider model discovery and
 *   preference-time selector refresh adapted from `Visterainer/aidea-zotero`
 *   (licensed under AGPL-3.0-or-later).
 * - SiliconFlow `/v1/models?sub_type=chat` endpoint convention and chat-model
 *   filtering adapted from `siliconflow/dsh-llm-siliconflow`
 *   (MIT License, Copyright (c) 2026 SiliconFlow).
 */

import { detectProviderPreset } from "../utils/providerPresets";
import type { DiscoveredModel } from "./types";

/** 30-minute in-memory TTL for on-demand discovered model lists. */
export const MODEL_DISCOVERY_CACHE_TTL_MS = 30 * 60 * 1000;

export type ModelDiscoveryErrorCode =
  | "missing_api_key"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "timeout"
  | "invalid_json"
  | "empty_list"
  | "http_error"
  | "network_error";

export interface ModelDiscoveryAdapter {
  readonly providerId: string;
  matches(identity: { provider?: string; apiBase?: string }): boolean;
  buildEndpoint(apiBase: string): string;
  filterAndSortModels(models: DiscoveredModel[]): DiscoveredModel[];
}

const DEFAULT_SILICONFLOW_API_BASE = "https://api.siliconflow.cn/v1";

const NON_CHAT_MODEL_TYPES = new Set([
  "embedding",
  "embeddings",
  "rerank",
  "reranker",
  "image",
  "text-to-image",
  "image-to-image",
  "audio",
  "speech",
  "speech-to-text",
  "text-to-speech",
  "tts",
  "asr",
  "video",
  "text-to-video",
  "image-to-video",
  "moderation",
]);

const NON_CHAT_MODEL_ID_PATTERN =
  /(?:^|[/:_-])(?:embedding|embeddings|rerank|reranker|bge-(?:large|base|small|m3|reranker)|bce-(?:embedding|reranker)|flux\.1|stable-diffusion|sdxl|kolors|cosyvoice\d*|sensevoice\w*|fish-speech|chattts|whisper|paraformer|wan2\.\d+-[ti]2v|hunyuanvideo|mochi-1|cogvideox|ltx-video)(?:$|[/:_-])/i;

/**
 * Determine whether a raw model record from a provider catalog represents a
 * chat/text-generation model rather than an embedding, reranker, image, audio,
 * or video model.
 */
export function isDiscoveredChatModel(
  row: Record<string, unknown>,
  id: string,
): boolean {
  const subType =
    typeof row.sub_type === "string"
      ? row.sub_type.trim().toLowerCase()
      : typeof row.subType === "string"
        ? row.subType.trim().toLowerCase()
        : "";
  if (subType && subType !== "chat") {
    return false;
  }
  const modelType =
    typeof row.type === "string"
      ? row.type.trim().toLowerCase()
      : typeof row.model_type === "string"
        ? row.model_type.trim().toLowerCase()
        : "";
  if (modelType && NON_CHAT_MODEL_TYPES.has(modelType)) {
    return false;
  }
  if (NON_CHAT_MODEL_ID_PATTERN.test(id)) {
    return false;
  }
  return true;
}

/**
 * Deduplicate discovered models by exact trimmed `id` and stably sort them
 * case-insensitively while preserving vendor-prefixed IDs verbatim.
 */
export function deduplicateAndSortDiscoveredModels(
  models: DiscoveredModel[],
): DiscoveredModel[] {
  const seen = new Set<string>();
  const unique: DiscoveredModel[] = [];
  for (const model of models) {
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id === model.id ? model : { ...model, id });
  }
  return unique.sort(
    (left, right) =>
      left.id.localeCompare(right.id, undefined, { sensitivity: "base" }) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
}

export class SiliconFlowModelDiscoveryAdapter implements ModelDiscoveryAdapter {
  readonly providerId = "siliconflow";

  matches(identity: { provider?: string; apiBase?: string }): boolean {
    if (identity.provider?.trim().toLowerCase() === "siliconflow") {
      return true;
    }
    return detectProviderPreset(identity.apiBase || "") === "siliconflow";
  }

  buildEndpoint(apiBase: string): string {
    const rawBase = apiBase.trim() || DEFAULT_SILICONFLOW_API_BASE;
    const url = new URL(rawBase);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`Unsupported protocol: ${url.protocol}`);
    }
    let path = url.pathname.replace(/\/+$/, "");
    if (!path) {
      path = "/v1";
    }
    if (!path.endsWith("/models")) {
      const marker = ["/chat/completions", "/responses", "/embeddings"].find(
        (suffix) => path.endsWith(suffix),
      );
      const basePath = marker ? path.slice(0, -marker.length) : path;
      path = `${basePath || "/v1"}/models`;
    }
    url.pathname = path.replace(/\/\/+/g, "/");
    if (!url.searchParams.has("sub_type") && !url.searchParams.has("type")) {
      url.searchParams.set("sub_type", "chat");
    }
    return url.toString();
  }

  filterAndSortModels(models: DiscoveredModel[]): DiscoveredModel[] {
    const filtered = models.filter((model) => {
      const id = typeof model.id === "string" ? model.id.trim() : "";
      return Boolean(id) && isDiscoveredChatModel({}, id);
    });
    return deduplicateAndSortDiscoveredModels(filtered);
  }
}

const discoveryAdapters = new Map<string, ModelDiscoveryAdapter>();

export function registerModelDiscoveryAdapter(
  adapter: ModelDiscoveryAdapter,
): void {
  discoveryAdapters.set(adapter.providerId.trim().toLowerCase(), adapter);
}

export function getModelDiscoveryAdapter(identity: {
  provider?: string;
  apiBase?: string;
}): ModelDiscoveryAdapter | null {
  for (const adapter of discoveryAdapters.values()) {
    if (adapter.matches(identity)) {
      return adapter;
    }
  }
  return null;
}

export function hasModelDiscoveryAdapter(identity: {
  provider?: string;
  apiBase?: string;
}): boolean {
  return getModelDiscoveryAdapter(identity) !== null;
}

export function listModelDiscoveryProviders(): string[] {
  return Array.from(discoveryAdapters.keys());
}

export function classifyModelDiscoveryHttpError(status: number): {
  code: ModelDiscoveryErrorCode;
  message: string;
} {
  if (status === 401) {
    return {
      code: "unauthorized",
      message: "API key is invalid or unauthorized (HTTP 401).",
    };
  }
  if (status === 403) {
    return {
      code: "forbidden",
      message: "Access forbidden for this API key (HTTP 403).",
    };
  }
  if (status === 429) {
    return {
      code: "rate_limited",
      message: "Rate limit exceeded when fetching models (HTTP 429).",
    };
  }
  return {
    code: "http_error",
    message: `catalog request failed: ${status}`,
  };
}

// Phase 1 registration: SiliconFlow only.
registerModelDiscoveryAdapter(new SiliconFlowModelDiscoveryAdapter());
