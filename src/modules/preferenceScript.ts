import { config } from "../../package.json";
import { DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE } from "../utils/llmDefaults";
import { HTML_NS } from "../utils/domHelpers";
import {
  normalizeTemperature,
  normalizeMaxTokens,
} from "../utils/normalization";
import {
  resolveEndpoint,
  buildHeaders,
  usesMaxCompletionTokens,
  isResponsesBase as checkIsResponsesBase,
} from "../utils/apiHelpers";

type PrefKey =
  | "apiBase"
  | "apiKey"
  | "model"
  | "apiBasePrimary"
  | "apiKeyPrimary"
  | "modelPrimary"
  | "apiBaseSecondary"
  | "apiKeySecondary"
  | "modelSecondary"
  | "apiBaseTertiary"
  | "apiKeyTertiary"
  | "modelTertiary"
  | "apiBaseQuaternary"
  | "apiKeyQuaternary"
  | "modelQuaternary"
  | "systemPrompt"
  | "temperaturePrimary"
  | "maxTokensPrimary"
  | "temperatureSecondary"
  | "maxTokensSecondary"
  | "temperatureTertiary"
  | "maxTokensTertiary"
  | "temperatureQuaternary"
  | "maxTokensQuaternary";

type ProfileKind = "primary" | "secondary" | "tertiary" | "quaternary";
type ProfileConfig = {
  key: ProfileKind;
  prefSuffix: "Primary" | "Secondary" | "Tertiary" | "Quaternary";
  title: string;
  modelPlaceholder: string;
  modelSuffixLabel: string;
  defaultModel: string;
  useLegacyFallback?: boolean;
};

const pref = (key: PrefKey) => `${config.prefsPrefix}.${key}`;

const getPref = (key: PrefKey): string => {
  const value = Zotero.Prefs.get(pref(key), true);
  return typeof value === "string" ? value : "";
};

const setPref = (key: PrefKey, value: string) =>
  Zotero.Prefs.set(pref(key), value, true);

const PROFILE_CONFIGS: ProfileConfig[] = [
  {
    key: "primary",
    prefSuffix: "Primary",
    title: "Model A",
    modelPlaceholder: "gpt-4o-mini",
    modelSuffixLabel: "Model A",
    defaultModel: "gpt-4o-mini",
    useLegacyFallback: true,
  },
  {
    key: "secondary",
    prefSuffix: "Secondary",
    title: "Model B",
    modelPlaceholder: "gpt-4o",
    modelSuffixLabel: "Model B",
    defaultModel: "",
  },
  {
    key: "tertiary",
    prefSuffix: "Tertiary",
    title: "Model C",
    modelPlaceholder: "gemini-2.5-pro",
    modelSuffixLabel: "Model C",
    defaultModel: "",
  },
  {
    key: "quaternary",
    prefSuffix: "Quaternary",
    title: "Model D",
    modelPlaceholder: "deepseek-reasoner",
    modelSuffixLabel: "Model D",
    defaultModel: "",
  },
];
const API_HELPER_TEXT =
  "API base URL or full endpoint URL. Examples: https://api.openai.com | https://api.openai.com/v1/chat/completions | https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

function createNode<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  style?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (style) el.setAttribute("style", style);
  if (text !== undefined) el.textContent = text;
  return el;
}

function createLabeledInputBlock(
  doc: Document,
  params: {
    id: string;
    label: string;
    type: string;
    placeholder?: string;
    helper: string;
    inputMode?: string;
    compact?: boolean;
  },
) {
  const block = createNode(
    doc,
    "div",
    "display: flex; flex-direction: column; gap: 4px",
  );
  const label = createNode(doc, "label", "font-weight: 600; font-size: 13px");
  label.setAttribute("for", params.id);
  label.textContent = params.label;

  const input = createNode(
    doc,
    "input",
    params.compact
      ? "width: 64px; padding: 4px 8px; font-size: 13px; border: 1px solid #c8c8c8; border-radius: 4px; box-sizing: border-box;"
      : "width: 100%; padding: 8px 12px; font-size: 13px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box;",
  );
  input.id = params.id;
  input.type = params.type;
  if (params.placeholder) input.placeholder = params.placeholder;
  if (params.inputMode) input.setAttribute("inputmode", params.inputMode);

  const helper = createNode(doc, "span", "font-size: 11px; color: #666");
  helper.textContent = params.helper;
  block.append(label, input, helper);
  return block;
}

function createModelSection(
  doc: Document,
  profile: ProfileConfig,
): HTMLElement {
  const suffix = profile.key;
  const section = createNode(
    doc,
    "div",
    "display: flex; flex-direction: column; gap: 10px",
  );

  section.append(
    createNode(doc, "div", "font-weight: 700; font-size: 13px", profile.title),
  );
  section.append(
    createLabeledInputBlock(doc, {
      id: `${config.addonRef}-api-base-${suffix}`,
      label: "API URL",
      type: "text",
      placeholder: "https://api.openai.com",
      helper: API_HELPER_TEXT,
    }),
  );
  section.append(
    createLabeledInputBlock(doc, {
      id: `${config.addonRef}-api-key-${suffix}`,
      label: "API Key / Secret Key",
      type: "password",
      placeholder: "sk-...",
      helper: "Your API key for authentication",
    }),
  );
  section.append(
    createLabeledInputBlock(doc, {
      id: `${config.addonRef}-model-${suffix}`,
      label: "Model Name",
      type: "text",
      placeholder: profile.modelPlaceholder,
      helper: `The model to use for ${profile.modelSuffixLabel}`,
    }),
  );

  const details = createNode(
    doc,
    "details",
    "display: flex; flex-direction: column; gap: 6px",
  );
  const summary = createNode(
    doc,
    "summary",
    "font-size: 13px; cursor: pointer; line-height: 1.2; font-weight: 600;",
    "Advanced Options",
  );
  const advancedWrap = createNode(
    doc,
    "div",
    "display: flex; flex-direction: column; gap: 8px; margin-top: 6px;",
  );
  advancedWrap.append(
    createLabeledInputBlock(doc, {
      id: `${config.addonRef}-temperature-${suffix}`,
      label: "Temperature",
      type: "text",
      inputMode: "decimal",
      helper:
        "Temperature controls the randomness or creativity generated by LLMs during inference.",
      compact: true,
    }),
  );
  advancedWrap.append(
    createLabeledInputBlock(doc, {
      id: `${config.addonRef}-max-tokens-${suffix}`,
      label: "Max_tokens",
      type: "text",
      inputMode: "numeric",
      helper:
        "Max_tokens only specifies the max number of tokens to generate in the completion",
      compact: true,
    }),
  );
  details.append(summary, advancedWrap);
  section.append(details);

  const actions = createNode(
    doc,
    "div",
    "display: flex; align-items: flex-start; gap: 12px; margin-top: 4px; flex-wrap: wrap;",
  );
  const testBtn = createNode(
    doc,
    "button",
    "padding: 8px 20px; font-size: 13px; font-weight: 600; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; text-align: center;",
    "Test Connection",
  );
  testBtn.id = `${config.addonRef}-test-button-${suffix}`;
  testBtn.type = "button";
  const testStatus = createNode(
    doc,
    "span",
    "font-size: 13px; display: block; flex: 1 0 100%; max-width: 100%; min-width: 0; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; user-select: text; cursor: text;",
  );
  testStatus.id = `${config.addonRef}-test-status-${suffix}`;
  actions.append(testBtn, testStatus);
  section.append(actions);
  return section;
}

function renderModelSections(doc: Document) {
  const modelSections = doc.querySelector(
    `#${config.addonRef}-model-sections`,
  ) as HTMLDivElement | null;
  if (!modelSections) return;
  modelSections.innerHTML = "";
  for (const profile of PROFILE_CONFIGS) {
    modelSections.appendChild(createModelSection(doc, profile));
  }
}

// normalizeTemperature and normalizeMaxTokens imported from ../utils/normalization

type ProfileInputRefs = {
  apiBaseInput: HTMLInputElement | null;
  apiKeyInput: HTMLInputElement | null;
  modelInput: HTMLInputElement | null;
  temperatureInput: HTMLInputElement | null;
  maxTokensInput: HTMLInputElement | null;
  testButton: HTMLButtonElement | null;
  testStatus: HTMLElement | null;
};

function getProfilePrefKey(
  profile: ProfileConfig,
  field: "apiBase" | "apiKey" | "model" | "temperature" | "maxTokens",
): PrefKey {
  return `${field}${profile.prefSuffix}` as PrefKey;
}

export async function registerPrefsScripts(_window: Window | undefined | null) {
  if (!_window) {
    ztoolkit.log("Preferences window not available");
    return;
  }

  const doc = _window.document;

  // Wait a bit for DOM to be ready
  await new Promise((resolve) => setTimeout(resolve, 100));
  renderModelSections(doc);

  // Populate fields with saved values
  const systemPromptInput = doc.querySelector(
    `#${config.addonRef}-system-prompt`,
  ) as HTMLTextAreaElement | null;
  const profileInputs = new Map<ProfileKind, ProfileInputRefs>();

  for (const profile of PROFILE_CONFIGS) {
    const refs: ProfileInputRefs = {
      apiBaseInput: doc.querySelector(
        `#${config.addonRef}-api-base-${profile.key}`,
      ) as HTMLInputElement | null,
      apiKeyInput: doc.querySelector(
        `#${config.addonRef}-api-key-${profile.key}`,
      ) as HTMLInputElement | null,
      modelInput: doc.querySelector(
        `#${config.addonRef}-model-${profile.key}`,
      ) as HTMLInputElement | null,
      temperatureInput: doc.querySelector(
        `#${config.addonRef}-temperature-${profile.key}`,
      ) as HTMLInputElement | null,
      maxTokensInput: doc.querySelector(
        `#${config.addonRef}-max-tokens-${profile.key}`,
      ) as HTMLInputElement | null,
      testButton: doc.querySelector(
        `#${config.addonRef}-test-button-${profile.key}`,
      ) as HTMLButtonElement | null,
      testStatus: doc.querySelector(
        `#${config.addonRef}-test-status-${profile.key}`,
      ) as HTMLElement | null,
    };
    profileInputs.set(profile.key, refs);

    const apiBaseKey = getProfilePrefKey(profile, "apiBase");
    const apiKeyKey = getProfilePrefKey(profile, "apiKey");
    const modelKey = getProfilePrefKey(profile, "model");

    if (refs.apiBaseInput) {
      refs.apiBaseInput.value = profile.useLegacyFallback
        ? getPref(apiBaseKey) || getPref("apiBase") || ""
        : getPref(apiBaseKey) || "";
      refs.apiBaseInput.addEventListener("input", () => {
        setPref(apiBaseKey, refs.apiBaseInput?.value || "");
      });
    }

    if (refs.apiKeyInput) {
      refs.apiKeyInput.value = profile.useLegacyFallback
        ? getPref(apiKeyKey) || getPref("apiKey") || ""
        : getPref(apiKeyKey) || "";
      refs.apiKeyInput.addEventListener("input", () => {
        setPref(apiKeyKey, refs.apiKeyInput?.value || "");
      });
    }

    if (refs.modelInput) {
      refs.modelInput.value = profile.useLegacyFallback
        ? getPref(modelKey) || getPref("model") || profile.defaultModel
        : getPref(modelKey) || profile.defaultModel;
      refs.modelInput.addEventListener("input", () => {
        setPref(modelKey, refs.modelInput?.value || "");
      });
    }
  }

  if (systemPromptInput) {
    systemPromptInput.value = getPref("systemPrompt") || "";
    systemPromptInput.addEventListener("input", () => {
      setPref("systemPrompt", systemPromptInput.value);
    });
  }

  const setupAdvancedOptions = (
    profile: ProfileConfig,
    temperatureInput: HTMLInputElement | null,
    maxTokensInput: HTMLInputElement | null,
  ) => {
    if (!temperatureInput || !maxTokensInput) return;

    const temperatureKey = getProfilePrefKey(profile, "temperature");
    const maxTokensKey = getProfilePrefKey(profile, "maxTokens");

    let savedTemperature = String(
      normalizeTemperature(getPref(temperatureKey) || `${DEFAULT_TEMPERATURE}`),
    );
    let savedMaxTokens = String(
      normalizeMaxTokens(getPref(maxTokensKey) || `${DEFAULT_MAX_TOKENS}`),
    );
    setPref(temperatureKey, savedTemperature);
    setPref(maxTokensKey, savedMaxTokens);
    temperatureInput.value = savedTemperature;
    maxTokensInput.value = savedMaxTokens;

    const commitTemperature = () => {
      savedTemperature = String(normalizeTemperature(temperatureInput.value));
      setPref(temperatureKey, savedTemperature);
      temperatureInput.value = savedTemperature;
    };

    const commitMaxTokens = () => {
      savedMaxTokens = String(normalizeMaxTokens(maxTokensInput.value));
      setPref(maxTokensKey, savedMaxTokens);
      maxTokensInput.value = savedMaxTokens;
    };

    temperatureInput.addEventListener("change", commitTemperature);
    temperatureInput.addEventListener("blur", commitTemperature);
    maxTokensInput.addEventListener("change", commitMaxTokens);
    maxTokensInput.addEventListener("blur", commitMaxTokens);
  };

  for (const profile of PROFILE_CONFIGS) {
    const refs = profileInputs.get(profile.key);
    setupAdvancedOptions(
      profile,
      refs?.temperatureInput || null,
      refs?.maxTokensInput || null,
    );
  }

  const attachTestHandler = (
    button: HTMLButtonElement | null,
    status: HTMLElement | null,
    getValues: () => { base: string; key: string; model: string },
  ) => {
    if (!button || !status) return;

    const runTest = async () => {
      status.textContent = "Testing...";
      status.style.color = "#666";

      try {
        const { base, key, model } = getValues();
        const apiBase = base.trim().replace(/\/$/, "");
        const apiKey = key.trim();
        const modelName = (model || "gpt-4o-mini").trim();

        if (!apiBase) {
          throw new Error("API URL is required");
        }

        const headers = buildHeaders(apiKey);

        const isResponsesBase = checkIsResponsesBase(apiBase);
        const testUrl = resolveEndpoint(
          apiBase,
          isResponsesBase ? "/v1/responses" : "/v1/chat/completions",
        );

        const tokenParam = isResponsesBase
          ? { max_output_tokens: 16 }
          : usesMaxCompletionTokens(modelName)
            ? { max_completion_tokens: 5 }
            : { max_tokens: 5 };

        const testPayload = isResponsesBase
          ? {
              model: modelName,
              input: [{ role: "user", content: "Say OK" }],
              ...tokenParam,
            }
          : {
              model: modelName,
              messages: [{ role: "user", content: "Say OK" }],
              ...tokenParam,
            };

        const fetchFn = ztoolkit.getGlobal("fetch") as typeof fetch;
        const response = await fetchFn(testUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(testPayload),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const reply = data?.choices?.[0]?.message?.content || "OK";

        status.textContent = `Success! Model says: "${reply}"`;
        status.style.color = "green";
      } catch (error) {
        status.textContent = `Failed: ${(error as Error).message}`;
        status.style.color = "red";
      }
    };

    button.addEventListener("click", runTest);
    button.addEventListener("command", runTest);
  };

  for (const profile of PROFILE_CONFIGS) {
    const refs = profileInputs.get(profile.key);
    attachTestHandler(
      refs?.testButton || null,
      refs?.testStatus || null,
      () => ({
        base: refs?.apiBaseInput?.value || "",
        key: refs?.apiKeyInput?.value || "",
        model:
          refs?.modelInput?.value ||
          (profile.useLegacyFallback ? profile.defaultModel : ""),
      }),
    );
  }
}
