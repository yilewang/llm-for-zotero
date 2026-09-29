import { config } from "../../../package.json";
import {
  buildDetectionIdentity,
  parseDetectionRecord,
} from "./detectionRecord";
import { getEmbeddingFormatAdapter } from "./formats";
import {
  MAX_EMBEDDING_BATCH_ITEMS,
  MAX_EMBEDDING_CONCURRENCY,
  isEmbeddingRequestFormat,
  type EmbeddingBatchLimits,
  type EmbeddingRequestFormat,
} from "./types";

export const EMBEDDING_PREF_KEYS = {
  supportsImages: "embeddingSupportsImages",
  requestFormat: "embeddingRequestFormat",
  capabilityDetection: "embeddingCapabilityDetection",
  batchMaxItems: "embeddingBatchMaxItems",
  batchMaxImages: "embeddingBatchMaxImages",
  concurrency: "embeddingConcurrency",
} as const;

export const EMBEDDING_BATCH_PREF_KEYS = [
  EMBEDDING_PREF_KEYS.batchMaxItems,
  EMBEDDING_PREF_KEYS.batchMaxImages,
  EMBEDDING_PREF_KEYS.concurrency,
] as const;

export type EmbeddingImagesPref = "" | "on" | "off";
export type EmbeddingFormatSource = "manual" | "url" | "owned_by" | "default";
export type EmbeddingImageSource = "manual" | "declared" | "probe" | "default";
export type EmbeddingBatchPrefs = {
  maxItems: string;
  maxImages: string;
  concurrency: string;
};

export type MultimodalSettingsInput = {
  customProvider: boolean;
  apiBase: string;
  model: string;
  imagesPref: string;
  formatPref: string;
  detectionRecord: string;
  batch: EmbeddingBatchPrefs;
};

export type MultimodalEmbeddingSettings = {
  imagesPref: EmbeddingImagesPref;
  formatPref: EmbeddingRequestFormat | "";
  /** Format the auto rules pick, ignoring a manual choice (for the "Auto (…)" label). */
  autoFormat: EmbeddingRequestFormat;
  candidateFormat: EmbeddingRequestFormat;
  candidateFormatSource: EmbeddingFormatSource;
  imagesEnabled: boolean;
  imageSource: EmbeddingImageSource;
  /** Format actually used: the candidate while images are on, else openai_compat. */
  format: EmbeddingRequestFormat;
  limits: EmbeddingBatchLimits;
  cappedLimits: { maxItems?: number; maxImages?: number };
};

const EMPTY_BATCH_PREFS: EmbeddingBatchPrefs = {
  maxItems: "",
  maxImages: "",
  concurrency: "",
};

function parsePositiveInt(raw: string): number | null {
  const trimmed = String(raw ?? "").trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeImagesPref(raw: string): EmbeddingImagesPref {
  return raw === "on" || raw === "off" ? raw : "";
}

export function isDashscopeNativeApiBase(apiBase: string): boolean {
  try {
    const url = new URL(apiBase.trim());
    if (!/(^|\.)dashscope(-intl|-us)?\.aliyuncs\.com$/i.test(url.hostname)) {
      return false;
    }
    return !url.pathname.toLowerCase().includes("compatible-mode");
  } catch {
    return false;
  }
}

export function resolveCandidateFormat(params: {
  formatPref: EmbeddingRequestFormat | "";
  apiBase: string;
  ownedBy?: string;
}): { format: EmbeddingRequestFormat; source: EmbeddingFormatSource } {
  if (params.formatPref) return { format: params.formatPref, source: "manual" };
  if (isDashscopeNativeApiBase(params.apiBase)) {
    return { format: "dashscope", source: "url" };
  }
  if ((params.ownedBy || "").trim().toLowerCase() === "vllm") {
    return { format: "vllm_messages", source: "owned_by" };
  }
  return { format: "openai_compat", source: "default" };
}

export function resolveEmbeddingBatchLimits(
  format: EmbeddingRequestFormat,
  batch: EmbeddingBatchPrefs,
): {
  limits: EmbeddingBatchLimits;
  capped: { maxItems?: number; maxImages?: number };
} {
  const adapter = getEmbeddingFormatAdapter(format);
  const capped: { maxItems?: number; maxImages?: number } = {};

  const explicitItems = parsePositiveInt(batch.maxItems);
  let maxItems = clamp(
    explicitItems ?? adapter.defaults.maxItems,
    1,
    MAX_EMBEDDING_BATCH_ITEMS,
  );
  if (maxItems > adapter.hardLimits.maxItems) {
    maxItems = adapter.hardLimits.maxItems;
    if (explicitItems !== null) capped.maxItems = maxItems;
  }

  const explicitImages = parsePositiveInt(batch.maxImages);
  let maxImages = explicitImages ?? adapter.defaults.maxImages;
  if (maxImages > adapter.hardLimits.maxImages) {
    maxImages = adapter.hardLimits.maxImages;
    if (explicitImages !== null) capped.maxImages = maxImages;
  }
  maxImages = clamp(maxImages, 1, maxItems);

  const concurrency = clamp(
    parsePositiveInt(batch.concurrency) ?? adapter.defaults.concurrency,
    1,
    MAX_EMBEDDING_CONCURRENCY,
  );
  return { limits: { maxItems, maxImages, concurrency }, capped };
}

export function resolveMultimodalEmbeddingSettings(
  input: MultimodalSettingsInput,
): MultimodalEmbeddingSettings {
  const imagesPref = normalizeImagesPref(input.imagesPref);
  const formatPref = isEmbeddingRequestFormat(input.formatPref)
    ? input.formatPref
    : "";
  if (!input.customProvider) {
    return {
      imagesPref,
      formatPref,
      autoFormat: "openai_compat",
      candidateFormat: "openai_compat",
      candidateFormatSource: "default",
      imagesEnabled: false,
      imageSource: "default",
      format: "openai_compat",
      limits: resolveEmbeddingBatchLimits("openai_compat", EMPTY_BATCH_PREFS)
        .limits,
      cappedLimits: {},
    };
  }

  const identity = buildDetectionIdentity(input.apiBase, input.model);
  const record = parseDetectionRecord(input.detectionRecord);
  const matched = record && record.identity === identity ? record : null;
  const candidate = resolveCandidateFormat({
    formatPref,
    apiBase: input.apiBase,
    ownedBy: matched?.ownedBy,
  });
  const autoFormat = resolveCandidateFormat({
    formatPref: "",
    apiBase: input.apiBase,
    ownedBy: matched?.ownedBy,
  }).format;

  let imagesEnabled = false;
  let imageSource: EmbeddingImageSource = "default";
  if (imagesPref) {
    imagesEnabled = imagesPref === "on";
    imageSource = "manual";
  } else if (typeof matched?.declaredImage === "boolean") {
    imagesEnabled = matched.declaredImage;
    imageSource = "declared";
  } else if (matched?.probe && matched.probe.format === candidate.format) {
    imagesEnabled = matched.probe.image === "supported";
    imageSource = "probe";
  }

  const format: EmbeddingRequestFormat = imagesEnabled
    ? candidate.format
    : "openai_compat";
  const { limits, capped } = resolveEmbeddingBatchLimits(format, input.batch);
  return {
    imagesPref,
    formatPref,
    autoFormat,
    candidateFormat: candidate.format,
    candidateFormatSource: candidate.source,
    imagesEnabled,
    imageSource,
    format,
    limits,
    cappedLimits: capped,
  };
}

function readEmbeddingPref(key: string): string {
  const value = Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true);
  return value == null ? "" : String(value);
}

export function readEmbeddingBatchPrefs(): EmbeddingBatchPrefs {
  return {
    maxItems: readEmbeddingPref(EMBEDDING_PREF_KEYS.batchMaxItems),
    maxImages: readEmbeddingPref(EMBEDDING_PREF_KEYS.batchMaxImages),
    concurrency: readEmbeddingPref(EMBEDDING_PREF_KEYS.concurrency),
  };
}

export function readMultimodalEmbeddingSettings(params: {
  provider: string;
  apiBase: string;
  model: string;
}): MultimodalEmbeddingSettings {
  return resolveMultimodalEmbeddingSettings({
    customProvider: params.provider === "custom",
    apiBase: params.apiBase,
    model: params.model,
    imagesPref: readEmbeddingPref(EMBEDDING_PREF_KEYS.supportsImages),
    formatPref: readEmbeddingPref(EMBEDDING_PREF_KEYS.requestFormat),
    detectionRecord: readEmbeddingPref(EMBEDDING_PREF_KEYS.capabilityDetection),
    batch: readEmbeddingBatchPrefs(),
  });
}

export const RETRIEVAL_PREF_KEYS = {
  textTopK: "retrievalTextTopK",
  imageTopK: "retrievalImageTopK",
  imageOutstandingPercent: "retrievalImageOutstandingPercent",
} as const;

export type RetrievalSettings = {
  textTopK: number;
  imageTopK: number;
  imageOutstandingPercent: number;
};

export const RETRIEVAL_DEFAULTS: RetrievalSettings = {
  textTopK: 4,
  imageTopK: 2,
  imageOutstandingPercent: 80,
};

export const RETRIEVAL_RANGES: Record<
  keyof RetrievalSettings,
  { min: number; max: number }
> = {
  textTopK: { min: 1, max: 24 },
  imageTopK: { min: 0, max: 6 },
  imageOutstandingPercent: { min: 0, max: 200 },
};

function parseNonNegativeInt(raw: string): number | null {
  const trimmed = String(raw ?? "").trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

export function resolveRetrievalSettings(
  raw: Record<keyof RetrievalSettings, string>,
): RetrievalSettings {
  const pick = (key: keyof RetrievalSettings): number => {
    const range = RETRIEVAL_RANGES[key];
    const parsed = parseNonNegativeInt(raw[key]);
    if (parsed === null || parsed < range.min) return RETRIEVAL_DEFAULTS[key];
    return Math.min(range.max, parsed);
  };
  return {
    textTopK: pick("textTopK"),
    imageTopK: pick("imageTopK"),
    imageOutstandingPercent: pick("imageOutstandingPercent"),
  };
}

export function readRetrievalSettings(): RetrievalSettings {
  return resolveRetrievalSettings({
    textTopK: readEmbeddingPref(RETRIEVAL_PREF_KEYS.textTopK),
    imageTopK: readEmbeddingPref(RETRIEVAL_PREF_KEYS.imageTopK),
    imageOutstandingPercent: readEmbeddingPref(
      RETRIEVAL_PREF_KEYS.imageOutstandingPercent,
    ),
  });
}
