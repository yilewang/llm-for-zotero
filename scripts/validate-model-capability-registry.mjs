import fs from "node:fs";
import path from "node:path";

const file = path.resolve("registry/model-capabilities.v1.json");
const maxTokens = 100_000_000;
const allowedRoots = new Set([
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
  // Ollama's native thinking switch. Keep in sync with ALLOWED_CONTROL_ROOTS
  // in src/modelCapabilities/registry.ts.
  "think",
]);
const allowedOmitRoots = new Set(["temperature", "top_p", ...allowedRoots]);
const allowedInputKeys = new Set(["text", "image", "video", "pdf"]);
const allowedFeatureKeys = new Set(["tools", "streaming", "promptCache"]);
const allowedSamplingKeys = new Set([
  "temperature",
  "minTemperature",
  "maxTemperature",
  "omitWhenReasoning",
]);

const fail = (message) => {
  throw new Error(`${file}: ${message}`);
};

const json = JSON.parse(fs.readFileSync(file, "utf8"));
if (!json || json.schemaVersion !== 1) fail("schemaVersion must be 1");
if (!Number.isSafeInteger(json.revision) || json.revision < 0) {
  fail("revision must be a non-negative safe integer");
}
if (!Array.isArray(json.models) || json.models.length > 4096) {
  fail("models must be an array with at most 4096 entries");
}

const validateValue = (value, depth = 0) => {
  if (depth > 8) fail("control nesting exceeds eight levels");
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      fail("control values must be finite");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) fail("control arrays may contain at most 64 values");
    value.forEach((entry) => validateValue(entry, depth + 1));
    return;
  }
  if (Object.keys(value).length > 32)
    fail("control objects may contain at most 32 keys");
  Object.entries(value).forEach(([key, entry]) => {
    if (key.length > 64) fail("control key is too long");
    validateValue(entry, depth + 1);
  });
};

const validateLimits = (limits) => {
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    fail("limits must be an object");
  }
  for (const [key, value] of Object.entries(limits)) {
    if (["contextWindowTokens", "inputTokens", "outputTokens"].includes(key)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maxTokens) {
        fail(`${key} must be an integer in [1, ${maxTokens}]`);
      }
    } else if (
      key !== "inputLimitIsAuthoritative" ||
      typeof value !== "boolean"
    ) {
      fail(`unknown limits field ${key}`);
    }
  }
};

for (const [index, entry] of json.models.entries()) {
  if (!entry || typeof entry !== "object" || !entry.match)
    fail(`models[${index}] has no match`);
  const matchKeys = ["exact", "prefix"].filter(
    (key) => typeof entry.match[key] === "string" && entry.match[key].trim(),
  );
  if (matchKeys.length !== 1)
    fail(`models[${index}] must define exactly one exact or prefix match`);
  if (entry.limits) validateLimits(entry.limits);
  for (const [section, allowedKeys] of [
    ["inputs", allowedInputKeys],
    ["features", allowedFeatureKeys],
  ]) {
    if (entry[section] !== undefined) {
      if (
        !entry[section] ||
        typeof entry[section] !== "object" ||
        Array.isArray(entry[section])
      ) {
        fail(`models[${index}] ${section} must be an object`);
      }
      for (const [key, value] of Object.entries(entry[section])) {
        if (!allowedKeys.has(key) || typeof value !== "boolean") {
          fail(`models[${index}] has an invalid ${section} field ${key}`);
        }
      }
    }
  }
  if (entry.sampling) {
    if (
      typeof entry.sampling !== "object" ||
      Array.isArray(entry.sampling) ||
      Object.keys(entry.sampling).some((key) => !allowedSamplingKeys.has(key))
    ) {
      fail(`models[${index}] has invalid sampling metadata`);
    }
  }
  if (entry.reasoning) {
    if (
      !["none", "server_default", "toggle", "fixed", "select"].includes(
        entry.reasoning.kind,
      )
    ) {
      fail(`models[${index}] has an invalid reasoning kind`);
    }
    if (
      !Array.isArray(entry.reasoning.options) ||
      entry.reasoning.options.length > 32
    ) {
      fail(
        `models[${index}] reasoning options must be an array with at most 32 entries`,
      );
    }
    for (const option of entry.reasoning.options) {
      if (
        !option ||
        typeof option.id !== "string" ||
        !option.id.trim() ||
        typeof option.label !== "string"
      )
        fail(`models[${index}] has an invalid reasoning option id`);
      if (option.controls) {
        if (
          typeof option.controls !== "object" ||
          Array.isArray(option.controls)
        ) {
          fail(`models[${index}] has invalid reasoning controls`);
        }
        validateValue(option.controls.body || {});
        for (const key of Object.keys(option.controls.body || {})) {
          if (!allowedRoots.has(key))
            fail(`models[${index}] control root ${key} is not allowlisted`);
        }
        if (option.controls.omit !== undefined) {
          if (
            !Array.isArray(option.controls.omit) ||
            option.controls.omit.some(
              (path) =>
                typeof path !== "string" ||
                !allowedOmitRoots.has(path.split(".")[0]),
            )
          ) {
            fail(`models[${index}] has an invalid reasoning omit path`);
          }
        }
        if (
          option.controls.omitTemperature !== undefined &&
          typeof option.controls.omitTemperature !== "boolean"
        ) {
          fail(`models[${index}] has an invalid omitTemperature flag`);
        }
      }
    }
  }
}

console.log(
  `Validated ${json.models.length} model capability entries (revision ${json.revision}).`,
);
