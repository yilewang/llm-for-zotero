import { config } from "../../package.json";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
} from "../utils/llmDefaults";
import { HTML_NS } from "../utils/domHelpers";
import {
  normalizeMaxTokens,
  normalizeOptionalInputTokenCap,
  normalizeTemperature,
} from "../utils/normalization";
import {
  buildHeaders,
  isResponsesBase as checkIsResponsesBase,
  resolveEndpoint,
  usesMaxCompletionTokens,
} from "../utils/apiHelpers";
import {
  createEmptyProviderGroup,
  createProviderModelEntry,
  getModelProviderGroups,
  setModelProviderGroups,
  type ModelProviderGroup,
  type ModelProviderModel,
} from "../utils/modelProviders";

type PrefKey = "systemPrompt";

const pref = (key: PrefKey) => `${config.prefsPrefix}.${key}`;

const getPref = (key: PrefKey): string => {
  const value = Zotero.Prefs.get(pref(key), true);
  return typeof value === "string" ? value : "";
};

const setPref = (key: PrefKey, value: string) =>
  Zotero.Prefs.set(pref(key), value, true);

const API_HELPER_TEXT =
  "Base URL or full endpoint. E.g. https://api.openai.com";
const MAX_PROVIDER_COUNT = 10;
const INITIAL_PROVIDER_COUNT = 4;

type ProviderProfile = {
  label: string;
  modelPlaceholder: string;
  defaultModel: string;
};

const PROVIDER_PROFILES: ProviderProfile[] = [
  { label: "Provider A", modelPlaceholder: "gpt-4o-mini", defaultModel: "gpt-4o-mini" },
  { label: "Provider B", modelPlaceholder: "gpt-4o", defaultModel: "" },
  { label: "Provider C", modelPlaceholder: "gemini-2.5-pro", defaultModel: "" },
  { label: "Provider D", modelPlaceholder: "deepseek-reasoner", defaultModel: "" },
];

function getProviderProfile(index: number): ProviderProfile {
  if (index < PROVIDER_PROFILES.length) return PROVIDER_PROFILES[index];
  const letter = String.fromCharCode("A".charCodeAt(0) + index);
  return { label: `Provider ${letter}`, modelPlaceholder: "", defaultModel: "" };
}

// ── DOM helpers ────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  style?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (style) node.setAttribute("style", style);
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconBtn(doc: Document, label: string, title: string): HTMLButtonElement {
  const btn = el(
    doc,
    "button",
    "padding: 0; width: 22px; height: 22px; border: none; background: transparent;" +
    " color: var(--fill-secondary, #888); font-size: 16px; font-weight: 500;" +
    " display: inline-flex; align-items: center; justify-content: center;" +
    " cursor: pointer; flex-shrink: 0; border-radius: 4px; line-height: 1;",
    label,
  ) as HTMLButtonElement;
  btn.type = "button";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  return btn;
}

// ── Data helpers ───────────────────────────────────────────────────

function cloneGroups(groups: ModelProviderGroup[]): ModelProviderGroup[] {
  return groups.map((g) => ({ ...g, models: g.models.map((m) => ({ ...m })) }));
}

function persistGroups(groups: ModelProviderGroup[]) {
  setModelProviderGroups(cloneGroups(groups));
}

function ensureModels(
  group: ModelProviderGroup,
  profile: ProviderProfile,
): ModelProviderModel[] {
  if (group.models.length > 0) return group.models.map((m) => ({ ...m }));
  return [createProviderModelEntry(profile.defaultModel)];
}

function isProviderEmpty(group: ModelProviderGroup): boolean {
  return (
    !group.apiBase.trim() &&
    !group.apiKey.trim() &&
    group.models.every((m) => !m.model.trim())
  );
}

function hasEmptyModel(group: ModelProviderGroup): boolean {
  return group.models.some((m) => !m.model.trim());
}

// ── Style tokens ───────────────────────────────────────────────────

// Inputs use CSS system colors (Field / FieldText) so they automatically
// match Zotero's native input appearance in both light and dark mode.
// Borders use --stroke-secondary, the real Zotero border variable.
const INPUT_STYLE =
  "width: 100%; padding: 6px 10px; font-size: 13px;" +
  " border: 1px solid var(--stroke-secondary, #c8c8c8); border-radius: 6px;" +
  " box-sizing: border-box; background: Field; color: FieldText;";

const INPUT_SM_STYLE =
  "width: 88px; padding: 4px 7px; font-size: 12px;" +
  " border: 1px solid var(--stroke-secondary, #c8c8c8); border-radius: 5px;" +
  " box-sizing: border-box; background: Field; color: FieldText;";

const LABEL_STYLE =
  "display: block; font-weight: 600; font-size: 12px;" +
  " color: var(--fill-primary, inherit); margin-bottom: 4px;";

const HELPER_STYLE =
  "font-size: 11px; color: var(--fill-secondary, #888); margin-top: 3px; display: block;";

const SECTION_LABEL_STYLE =
  "font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase;" +
  " color: var(--fill-secondary, #888);";

const PRIMARY_BTN_STYLE =
  "padding: 5px 12px; font-size: 12px; font-weight: 600;" +
  " background: var(--color-accent, #2563eb); color: #fff;" +
  " border: none; border-radius: 6px; cursor: pointer; white-space: nowrap; flex-shrink: 0;";

const OUTLINE_BTN_STYLE =
  "padding: 4px 10px; font-size: 12px; font-weight: 500; white-space: nowrap; flex-shrink: 0;" +
  " background: transparent; color: var(--color-accent, #2563eb);" +
  " border: 1px solid var(--color-accent, #2563eb); border-radius: 5px; cursor: pointer;";

const CARD_STYLE =
  "border: 1px solid var(--stroke-secondary, #c8c8c8); border-radius: 8px; overflow: hidden;";

  const CARD_HEADER_STYLE =
  "display: flex; align-items: center; justify-content: space-between; padding: 8px 12px;" +
  " background: Field; color: FieldText;" +
  " border-bottom: 1px solid var(--stroke-secondary, #c8c8c8);";

const CARD_BODY_STYLE =
  "display: flex; flex-direction: column; gap: 12px; padding: 14px;";

const ADV_ROW_STYLE =
  "display: none; flex-direction: column; gap: 8px; padding: 10px 12px;" +
  " background: rgba(128,128,128,0.06);" +
  " border: 1px solid var(--stroke-secondary, #c8c8c8); border-radius: 6px; margin-top: 4px;";

// ── Main export ────────────────────────────────────────────────────

export async function registerPrefsScripts(_window: Window | undefined | null) {
  if (!_window) {
    ztoolkit.log("Preferences window not available");
    return;
  }

  const doc = _window.document;
  await new Promise((resolve) => setTimeout(resolve, 100));

  const modelSections = doc.querySelector(
    `#${config.addonRef}-model-sections`,
  ) as HTMLDivElement | null;
  const systemPromptInput = doc.querySelector(
    `#${config.addonRef}-system-prompt`,
  ) as HTMLTextAreaElement | null;
  const popupAddTextEnabledInput = doc.querySelector(
    `#${config.addonRef}-popup-add-text-enabled`,
  ) as HTMLInputElement | null;

  if (!modelSections) return;

  const storedGroupsRaw = Zotero.Prefs.get(
    `${config.prefsPrefix}.modelProviderGroups`,
    true,
  );
  const hasStoredConfig =
    typeof storedGroupsRaw === "string" && storedGroupsRaw.trim().length > 0;

  const groups: ModelProviderGroup[] = (() => {
    const parsed = getModelProviderGroups();
    if (hasStoredConfig) return parsed;
    const result = [...parsed];
    while (result.length < INITIAL_PROVIDER_COUNT) result.push(createEmptyProviderGroup());
    return result;
  })();

  // Mutable reference so input listeners inside rerender can update the
  // "Add Provider" button state without triggering a full rerender.
  let syncAddProviderBtn: () => void = () => undefined;

  // ── Render ────────────────────────────────────────────────────────

  const rerender = () => {
    modelSections.innerHTML = "";

    const wrap = el(doc, "div", "display: flex; flex-direction: column; gap: 10px;");

    // Section heading
    const headingLeft = el(doc, "div", "display: flex; flex-direction: column; gap: 2px; margin-bottom: 2px;");
    headingLeft.append(
      el(doc, "span", "font-size: 14px; font-weight: 800; color: var(--fill-primary, inherit);", "AI Providers"),
      el(
        doc,
        "span",
        "font-size: 11.5px; color: var(--fill-secondary, #888);",
        "Each provider shares an API URL and key, with one or more model variants.",
      ),
    );
    wrap.appendChild(headingLeft);

    // ── Per-provider cards ─────────────────────────────────────────

    groups.forEach((group, groupIndex) => {
      const profile = getProviderProfile(groupIndex);
      group.models = ensureModels(group, profile);

      const card = el(doc, "div", CARD_STYLE);

      // Card header: label + remove button
      const cardHeader = el(doc, "div", CARD_HEADER_STYLE);
      cardHeader.append(
        el(doc, "span", "font-weight: 700; font-size: 13px;", profile.label),
      );
      const removeProvBtn = iconBtn(doc, "×", "Remove provider");
      removeProvBtn.addEventListener("click", () => {
        groups.splice(groupIndex, 1);
        persistGroups(groups);
        rerender();
      });
      cardHeader.appendChild(removeProvBtn);

      // Card body
      const cardBody = el(doc, "div", CARD_BODY_STYLE);

      // ── API URL ──────────────────────────────────────────────────
      const apiUrlWrap = el(doc, "div", "display: flex; flex-direction: column;");
      const apiUrlLabel = el(doc, "label", LABEL_STYLE, "API URL");
      const apiUrlInput = el(doc, "input", INPUT_STYLE) as HTMLInputElement;
      apiUrlInput.id = `${config.addonRef}-api-base-${group.id}`;
      apiUrlLabel.setAttribute("for", apiUrlInput.id);
      apiUrlInput.type = "text";
      apiUrlInput.placeholder = "https://api.openai.com";
      apiUrlInput.value = group.apiBase;
      apiUrlInput.addEventListener("input", () => {
        group.apiBase = apiUrlInput.value;
        persistGroups(groups);
        syncAddProviderBtn();
      });
      apiUrlWrap.append(
        apiUrlLabel,
        apiUrlInput,
        el(doc, "span", HELPER_STYLE, API_HELPER_TEXT),
      );

      // ── API Key ──────────────────────────────────────────────────
      const apiKeyWrap = el(doc, "div", "display: flex; flex-direction: column;");
      const apiKeyLabel = el(doc, "label", LABEL_STYLE, "API Key");
      const apiKeyInput = el(doc, "input", INPUT_STYLE) as HTMLInputElement;
      apiKeyInput.id = `${config.addonRef}-api-key-${group.id}`;
      apiKeyLabel.setAttribute("for", apiKeyInput.id);
      apiKeyInput.type = "password";
      apiKeyInput.placeholder = "sk-…";
      apiKeyInput.value = group.apiKey;
      apiKeyInput.addEventListener("input", () => {
        group.apiKey = apiKeyInput.value;
        persistGroups(groups);
        syncAddProviderBtn();
      });
      apiKeyWrap.append(apiKeyLabel, apiKeyInput);

      // ── Models list ──────────────────────────────────────────────
      const modelsWrap = el(doc, "div", "display: flex; flex-direction: column; gap: 6px;");

      const modelsHeaderRow = el(
        doc,
        "div",
        "display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px;",
      );
      modelsHeaderRow.appendChild(el(doc, "span", SECTION_LABEL_STYLE, "Model names"));

      const addModelBtn = iconBtn(doc, "+", "Add model");
      addModelBtn.style.color = "var(--color-accent, #2563eb)";
      modelsHeaderRow.appendChild(addModelBtn);
      modelsWrap.appendChild(modelsHeaderRow);

      const syncAddModelBtn = () => {
        const canAdd = !hasEmptyModel(group);
        addModelBtn.disabled = !canAdd;
        addModelBtn.style.opacity = canAdd ? "1" : "0.35";
        addModelBtn.title = canAdd
          ? "Add model"
          : "Fill in the current model name first";
      };
      syncAddModelBtn();

      addModelBtn.addEventListener("click", () => {
        if (addModelBtn.disabled) return;
        group.models.push(createProviderModelEntry(""));
        persistGroups(groups);
        rerender();
      });

      // ── Per-model rows ───────────────────────────────────────────
      group.models.forEach((modelEntry, modelIndex) => {
        const rowWrap = el(doc, "div", "display: flex; flex-direction: column; gap: 0;");

        // Main row: [model input] [Test] [⚙] [×?]
        const mainRow = el(doc, "div", "display: flex; align-items: center; gap: 5px;");

        const modelInput = el(
          doc,
          "input",
          "flex: 1; min-width: 0; padding: 6px 10px; font-size: 13px;" +
          " border: 1px solid var(--stroke-secondary, #c8c8c8); border-radius: 6px;" +
          " box-sizing: border-box; background: Field; color: FieldText;",
        ) as HTMLInputElement;
        modelInput.type = "text";
        modelInput.value = modelEntry.model;
        modelInput.placeholder = modelIndex === 0 ? profile.modelPlaceholder : "";

        const testBtn = el(doc, "button", OUTLINE_BTN_STYLE, "Test") as HTMLButtonElement;
        testBtn.type = "button";

        const advGearBtn = iconBtn(doc, "⚙", "Advanced options");

        mainRow.append(modelInput, testBtn, advGearBtn);

        if (group.models.length > 1) {
          const removeModelBtn = iconBtn(doc, "×", "Remove model");
          removeModelBtn.addEventListener("click", () => {
            group.models = group.models.filter((e) => e.id !== modelEntry.id);
            if (!group.models.length) {
              group.models = [createProviderModelEntry(profile.defaultModel)];
            }
            persistGroups(groups);
            rerender();
          });
          mainRow.appendChild(removeModelBtn);
        }

        // Status line (hidden until test runs)
        const statusLine = el(
          doc,
          "span",
          "font-size: 11.5px; display: none; margin-top: 3px; white-space: pre-wrap; word-break: break-all;",
        );

        // ── Advanced section (hidden by default) ──────────────────
        const advRow = el(doc, "div", ADV_ROW_STYLE);

        const advFields = el(
          doc,
          "div",
          "display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end;",
        );

        const makeCompactField = (labelText: string, value: string, placeholder: string) => {
          const fieldWrap = el(doc, "div", "display: flex; flex-direction: column; gap: 3px;");
          const lbl = el(
            doc,
            "label",
            "font-size: 10.5px; font-weight: 600; color: var(--fill-primary, inherit);",
            labelText,
          );
          const input = el(doc, "input", INPUT_SM_STYLE) as HTMLInputElement;
          input.type = "text";
          input.value = value;
          input.placeholder = placeholder;
          fieldWrap.append(lbl, input);
          return { wrap: fieldWrap, input };
        };

        const tempField = makeCompactField(
          "Temperature",
          `${modelEntry.temperature ?? DEFAULT_TEMPERATURE}`,
          `${DEFAULT_TEMPERATURE}`,
        );
        const maxTokField = makeCompactField(
          "Max tokens",
          `${modelEntry.maxTokens ?? DEFAULT_MAX_TOKENS}`,
          `${DEFAULT_MAX_TOKENS}`,
        );
        const inputCapField = makeCompactField(
          "Input cap",
          modelEntry.inputTokenCap !== undefined ? `${modelEntry.inputTokenCap}` : "",
          "optional",
        );

        advFields.append(tempField.wrap, maxTokField.wrap, inputCapField.wrap);
        advRow.append(
          advFields,
          el(
            doc,
            "span",
            "font-size: 10.5px; color: var(--fill-secondary, #888); margin-top: 2px; display: block;",
            "Temperature: randomness (0–2)  ·  Max tokens: output limit  ·  Input cap: context limit (optional)",
          ),
        );

        const commitAdvanced = () => {
          modelEntry.temperature = normalizeTemperature(tempField.input.value);
          modelEntry.maxTokens = normalizeMaxTokens(maxTokField.input.value);
          modelEntry.inputTokenCap = normalizeOptionalInputTokenCap(inputCapField.input.value);
          tempField.input.value = `${modelEntry.temperature}`;
          maxTokField.input.value = `${modelEntry.maxTokens}`;
          inputCapField.input.value =
            modelEntry.inputTokenCap !== undefined ? `${modelEntry.inputTokenCap}` : "";
          persistGroups(groups);
        };
        for (const f of [tempField, maxTokField, inputCapField]) {
          f.input.addEventListener("change", commitAdvanced);
          f.input.addEventListener("blur", commitAdvanced);
        }

        const syncAdvAvailability = () => {
          const hasModel = Boolean(modelEntry.model.trim());
          advRow.style.opacity = hasModel ? "1" : "0.45";
          advRow.style.pointerEvents = hasModel ? "" : "none";
          for (const f of [tempField, maxTokField, inputCapField]) f.input.disabled = !hasModel;
        };
        syncAdvAvailability();

        let advOpen = false;
        advGearBtn.addEventListener("click", () => {
          advOpen = !advOpen;
          advRow.style.display = advOpen ? "flex" : "none";
          advGearBtn.style.color = advOpen
            ? "var(--color-accent, #2563eb)"
            : "var(--fill-secondary, #888)";
        });

        modelInput.addEventListener("input", () => {
          modelEntry.model = modelInput.value;
          persistGroups(groups);
          syncAddModelBtn();
          syncAddProviderBtn();
          syncAdvAvailability();
        });

        // ── Test connection ──────────────────────────────────────
        const runTest = async () => {
          testBtn.disabled = true;
          statusLine.style.display = "block";
          statusLine.textContent = "Testing…";
          statusLine.style.color = "var(--fill-secondary, #888)";

          try {
            const apiBase = group.apiBase.trim().replace(/\/$/, "");
            const apiKey = group.apiKey.trim();
            const modelName = (
              modelEntry.model || profile.defaultModel || "gpt-4o-mini"
            ).trim();

            if (!apiBase) throw new Error("API URL is required");

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
            statusLine.textContent = `✓ Success — model says: "${reply}"`;
            statusLine.style.color = "green";
          } catch (error) {
            statusLine.textContent = `✗ ${(error as Error).message}`;
            statusLine.style.color = "red";
          } finally {
            testBtn.disabled = false;
          }
        };

        testBtn.addEventListener("click", () => void runTest());
        testBtn.addEventListener("command", () => void runTest());

        rowWrap.append(mainRow, statusLine, advRow);
        modelsWrap.appendChild(rowWrap);
      });

      const divider = el(
        doc,
        "hr",
        "border: none; border-top: 1px solid var(--stroke-secondary, #c8c8c8); margin: 0;",
      );
      cardBody.append(apiUrlWrap, apiKeyWrap, divider, modelsWrap);
      card.append(cardHeader, cardBody);
      wrap.appendChild(card);
    });

    // ── Add Provider button ──────────────────────────────────────

    const addProviderBtn = el(
      doc,
      "button",
      PRIMARY_BTN_STYLE + " margin-top: 2px; font-size: 12.5px;",
      "+ Add Provider",
    ) as HTMLButtonElement;
    addProviderBtn.type = "button";

    const syncAddProviderBtnInner = () => {
      const atMax = groups.length >= MAX_PROVIDER_COUNT;
      const hasEmpty = groups.some(isProviderEmpty);
      const canAdd = !atMax && !hasEmpty;
      addProviderBtn.disabled = !canAdd;
      addProviderBtn.style.opacity = canAdd ? "1" : "0.4";
      addProviderBtn.style.cursor = canAdd ? "pointer" : "default";
      addProviderBtn.title = atMax
        ? `Maximum ${MAX_PROVIDER_COUNT} providers`
        : hasEmpty
          ? "Complete the empty provider first"
          : "Add provider";
    };
    syncAddProviderBtnInner();
    syncAddProviderBtn = syncAddProviderBtnInner;

    addProviderBtn.addEventListener("click", () => {
      if (addProviderBtn.disabled) return;
      groups.push(createEmptyProviderGroup());
      persistGroups(groups);
      rerender();
    });

    wrap.appendChild(addProviderBtn);
    modelSections.appendChild(wrap);
  };

  rerender();

  // ── Global settings ────────────────────────────────────────────

  if (systemPromptInput) {
    systemPromptInput.value = getPref("systemPrompt") || "";
    systemPromptInput.addEventListener("input", () => {
      setPref("systemPrompt", systemPromptInput.value);
    });
  }

  if (popupAddTextEnabledInput) {
    const prefValue = Zotero.Prefs.get(
      `${config.prefsPrefix}.showPopupAddText`,
      true,
    );
    popupAddTextEnabledInput.checked =
      prefValue !== false && `${prefValue || ""}`.toLowerCase() !== "false";
    popupAddTextEnabledInput.addEventListener("change", () => {
      Zotero.Prefs.set(
        `${config.prefsPrefix}.showPopupAddText`,
        popupAddTextEnabledInput.checked,
        true,
      );
    });
  }
}
