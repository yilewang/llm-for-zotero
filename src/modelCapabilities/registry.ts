import type {
  ModelCapabilityRegistry,
  ModelControlPatch,
  ModelReasoningCapability,
  RegistryModelEntry,
} from "./types";

export const MODEL_CAPABILITY_REGISTRY_URL =
  "https://raw.githubusercontent.com/yilewang/llm-for-zotero/main/registry/model-capabilities.v1.json";
export const MODEL_CAPABILITY_REGISTRY_MAX_BYTES = 512 * 1024;
export const MODEL_CAPABILITY_MAX_TOKEN_LIMIT = 100_000_000;

const ALLOWED_CONTROL_ROOTS = new Set([
  "reasoning",
  "reasoning_effort",
  "thinking",
  "thinking_config",
  "thinkingConfig",
  "generation_config",
  "generationConfig",
  "output_config",
  "enable_thinking",
  "chat_template_kwargs",
  "extra_body",
  // Ollama's native thinking switch: false | true | "low".."max".
  "think",
]);

const ALLOWED_OMIT_ROOTS = new Set([
  "temperature",
  "top_p",
  "reasoning",
  "reasoning_effort",
  "thinking",
  "thinking_config",
  "generation_config",
  "output_config",
  "enable_thinking",
  "chat_template_kwargs",
  "extra_body",
  "think",
]);
const ALLOWED_INPUT_KEYS = new Set(["text", "image", "video", "pdf"]);
const ALLOWED_FEATURE_KEYS = new Set(["tools", "streaming", "promptCache"]);
const ALLOWED_SAMPLING_KEYS = new Set([
  "temperature",
  "minTemperature",
  "maxTemperature",
  "omitWhenReasoning",
]);

/** The plugin's one plain-object guard; import it rather than re-typing it. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeTokenLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MODEL_CAPABILITY_MAX_TOKEN_LIMIT
  );
}

function validateJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return (
      value.length <= 64 &&
      value.every((entry) => validateJsonValue(entry, depth + 1))
    );
  }
  if (!isRecord(value) || Object.keys(value).length > 32) return false;
  return Object.entries(value).every(([key, entry]) => {
    if (key.length > 64) return false;
    return validateJsonValue(entry, depth + 1);
  });
}

function validateControlPatch(value: unknown): value is ModelControlPatch {
  if (!isRecord(value)) return false;
  if (value.body !== undefined) {
    if (!isRecord(value.body) || !validateJsonValue(value.body)) return false;
    for (const key of Object.keys(value.body)) {
      if (!ALLOWED_CONTROL_ROOTS.has(key)) return false;
    }
  }
  if (value.omit !== undefined) {
    if (
      !Array.isArray(value.omit) ||
      value.omit.length > 16 ||
      !value.omit.every(
        (entry) =>
          typeof entry === "string" &&
          entry.length <= 64 &&
          ALLOWED_OMIT_ROOTS.has(entry.split(".")[0]),
      )
    ) {
      return false;
    }
  }
  if (
    value.omitTemperature !== undefined &&
    typeof value.omitTemperature !== "boolean"
  ) {
    return false;
  }
  return true;
}

function validateReasoning(value: unknown): value is ModelReasoningCapability {
  if (!isRecord(value)) return false;
  if (
    value.kind !== "none" &&
    value.kind !== "server_default" &&
    value.kind !== "toggle" &&
    value.kind !== "fixed" &&
    value.kind !== "select"
  ) {
    return false;
  }
  if (!Array.isArray(value.options) || value.options.length > 32) return false;
  if (
    value.defaultOptionId !== undefined &&
    (typeof value.defaultOptionId !== "string" ||
      value.defaultOptionId.length > 64)
  ) {
    return false;
  }
  if (value.controls !== undefined && !validateControlPatch(value.controls)) {
    return false;
  }
  return value.options.every((option) => {
    if (!isRecord(option)) return false;
    if (
      typeof option.id !== "string" ||
      !option.id.trim() ||
      option.id.length > 64 ||
      typeof option.label !== "string" ||
      option.label.length > 128
    ) {
      return false;
    }
    if (option.enabled !== undefined && typeof option.enabled !== "boolean") {
      return false;
    }
    return (
      option.controls === undefined || validateControlPatch(option.controls)
    );
  });
}

function validateLimits(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, entry]) => {
    if (
      key === "contextWindowTokens" ||
      key === "inputTokens" ||
      key === "outputTokens"
    ) {
      return isSafeTokenLimit(entry);
    }
    if (key === "inputLimitIsAuthoritative") return typeof entry === "boolean";
    return false;
  });
}

function validateSampling(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !ALLOWED_SAMPLING_KEYS.has(key))) {
    return false;
  }
  if (
    value.temperature !== undefined &&
    value.temperature !== "configurable" &&
    value.temperature !== "fixed" &&
    value.temperature !== "unsupported"
  ) {
    return false;
  }
  for (const key of ["minTemperature", "maxTemperature"]) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" ||
        !Number.isFinite(value[key]) ||
        value[key] < 0 ||
        value[key] > 2)
    ) {
      return false;
    }
  }
  return (
    value.omitWhenReasoning === undefined ||
    typeof value.omitWhenReasoning === "boolean"
  );
}

function validateBooleanSection(
  value: unknown,
  allowedKeys: Set<string>,
): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) => allowedKeys.has(key) && typeof entry === "boolean",
  );
}

function validateEntry(value: unknown): value is RegistryModelEntry {
  if (!isRecord(value) || !isRecord(value.match)) return false;
  const match = value.match;
  const hasExact =
    typeof match.exact === "string" && Boolean(match.exact.trim());
  const hasPrefix =
    typeof match.prefix === "string" && Boolean(match.prefix.trim());
  if (hasExact === hasPrefix) return false;
  if (
    match.provider !== undefined &&
    (typeof match.provider !== "string" || match.provider.length > 64)
  ) {
    return false;
  }
  if (
    value.displayName !== undefined &&
    typeof value.displayName !== "string"
  ) {
    return false;
  }
  if (value.limits !== undefined && !validateLimits(value.limits)) return false;
  if (value.reasoning !== undefined && !validateReasoning(value.reasoning))
    return false;
  if (value.sampling !== undefined && !validateSampling(value.sampling)) {
    return false;
  }
  if (
    value.inputs !== undefined &&
    !validateBooleanSection(value.inputs, ALLOWED_INPUT_KEYS)
  ) {
    return false;
  }
  if (
    value.features !== undefined &&
    !validateBooleanSection(value.features, ALLOWED_FEATURE_KEYS)
  ) {
    return false;
  }
  return true;
}

export function cloneRegistry(
  registry: ModelCapabilityRegistry,
): ModelCapabilityRegistry {
  return JSON.parse(JSON.stringify(registry)) as ModelCapabilityRegistry;
}

export function validateRegistry(
  value: unknown,
): ModelCapabilityRegistry | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0)
    return null;
  if (!Array.isArray(value.models) || value.models.length > 4096) return null;
  if (!value.models.every(validateEntry)) return null;
  return cloneRegistry(value as ModelCapabilityRegistry);
}

function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function matchesPrefix(value: string, prefix: string): boolean {
  if (!value.startsWith(prefix)) return false;
  const next = value[prefix.length];
  return !next || /[._:/-]/.test(next);
}

export function findRegistryEntry(
  registry: ModelCapabilityRegistry,
  provider: string,
  model: string,
): RegistryModelEntry | null {
  const providerName = normalized(provider);
  const modelName = normalized(model);
  const modelCandidates = [modelName];
  for (let index = 0; index < modelName.length - 1; index += 1) {
    if (
      modelName[index] === "/" ||
      modelName[index] === ":" ||
      modelName[index] === "."
    ) {
      modelCandidates.push(modelName.slice(index + 1));
    }
  }
  let best: { entry: RegistryModelEntry; score: number } | null = null;
  for (const entry of registry.models) {
    const matchProvider = normalized(entry.match.provider);
    if (matchProvider && matchProvider !== providerName) continue;
    const providerSpecificity = matchProvider ? 100 : 0;
    const exact = normalized(entry.match.exact);
    const prefix = normalized(entry.match.prefix);
    let score = -1;
    if (exact && modelCandidates.includes(exact)) {
      score = providerSpecificity + 100000 + exact.length;
    } else if (
      prefix &&
      modelCandidates.some((candidate) => matchesPrefix(candidate, prefix))
    ) {
      score = providerSpecificity + 1000 + prefix.length;
    }
    if (score < 0) continue;
    if (!best || score > best.score) best = { entry, score };
  }
  return best?.entry || null;
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function mergeCapabilitySection<T extends Record<string, unknown>>(
  base: T,
  overlay: Partial<T> | undefined,
): T {
  return { ...base, ...(overlay ? cloneValue(overlay) : {}) };
}

function mergeNested(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (isRecord(value) && isRecord(result[key])) {
      result[key] = mergeNested(result[key] as Record<string, unknown>, value);
    } else {
      result[key] = cloneValue(value);
    }
  }
  return result;
}

export function applyControlPatch(
  target: Record<string, unknown>,
  patch: ModelControlPatch | undefined,
): Record<string, unknown> {
  if (!patch?.body) return target;
  return mergeNested(target, patch.body);
}

export function removeControlRoots(
  target: Record<string, unknown>,
  patch: ModelControlPatch | undefined,
): void {
  for (const path of patch?.omit || []) {
    const parts = path.split(".").filter(Boolean);
    if (!parts.length) continue;
    let current: Record<string, unknown> | null = target;
    for (let index = 0; index < parts.length - 1 && current; index++) {
      const next: unknown = current[parts[index]];
      current = isRecord(next) ? next : null;
    }
    if (current) delete current[parts[parts.length - 1]];
  }
}
