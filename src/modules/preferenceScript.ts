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
  createEmptyProviderGroup,
  createProviderModelEntry,
  getModelProviderGroups,
  setModelProviderGroups,
  type ModelProviderAuthMode,
  type ModelProviderGroup,
  type ModelProviderModel,
} from "../utils/modelProviders";
import {
  PROVIDER_PRESETS,
  detectProviderPreset,
  getProviderPreset,
  type ProviderPresetId,
} from "../utils/providerPresets";
import {
  PROVIDER_PROTOCOL_SPECS,
  normalizeProviderProtocolForAuthMode,
  getProviderProtocolSpec,
  type ProviderProtocol,
} from "../utils/providerProtocol";
import { runProviderConnectionTest } from "../utils/providerConnectionTest";
import {
  isMineruEnabled,
  getMineruApiKey,
  setMineruEnabled,
  setMineruApiKey,
} from "../utils/mineruConfig";
import { testMineruConnection } from "../utils/mineruClient";
import { registerMineruManagerScript } from "./mineruManagerScript";

type PrefKey = "systemPrompt";

const pref = (key: PrefKey) => `${config.prefsPrefix}.${key}`;

const getPref = (key: PrefKey): string => {
  const value = Zotero.Prefs.get(pref(key), true);
  return typeof value === "string" ? value : "";
};

const setPref = (key: PrefKey, value: string) =>
  Zotero.Prefs.set(pref(key), value, true);

const CUSTOMIZED_API_HELPER_TEXT =
  "Choose a preset above, or switch to Customized to enter a full base URL or endpoint manually.";
const CODEX_API_HELPER_TEXT =
  "codex auth usually uses https://chatgpt.com/backend-api/codex/responses";
const MAX_PROVIDER_COUNT = 10;
const INITIAL_PROVIDER_COUNT = 4;
const DEFAULT_CODEX_API_BASE = "https://chatgpt.com/backend-api/codex/responses";

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

function normalizeProviderPresetId(value: unknown): ProviderPresetId {
  if (typeof value !== "string") return "customized";
  return value === "customized" || PROVIDER_PRESETS.some((preset) => preset.id === value)
    ? (value as ProviderPresetId)
    : "customized";
}

function getPresetSelectHelperText(presetId: ProviderPresetId): string {
  if (presetId === "customized") {
    return CUSTOMIZED_API_HELPER_TEXT;
  }
  return `${getProviderPreset(presetId).helperText} Switch to Customized to edit the URL manually.`;
}

function getProtocolOptions(
  authMode: ModelProviderAuthMode,
  presetId: ProviderPresetId,
): ProviderProtocol[] {
  if (authMode === "codex_auth") return ["codex_responses"];
  if (presetId !== "customized") {
    return getProviderPreset(presetId).supportedProtocols.filter(
      (protocol) => protocol !== "codex_responses",
    );
  }
  return PROVIDER_PROTOCOL_SPECS.map((entry) => entry.id).filter(
    (protocol) => protocol !== "codex_responses",
  );
}

function resolveSelectedProtocol(
  group: ModelProviderGroup,
  presetId: ProviderPresetId,
): ProviderProtocol {
  const fallback =
    group.authMode === "codex_auth"
      ? "codex_responses"
      : presetId === "customized"
        ? "openai_chat_compat"
        : getProviderPreset(presetId).defaultProtocol;
  const allowed = getProtocolOptions(group.authMode, presetId);
  const normalized = normalizeProviderProtocolForAuthMode({
    protocol: group.providerProtocol,
    authMode: group.authMode,
    apiBase: group.apiBase,
    fallback,
  });
  return allowed.includes(normalized) ? normalized : allowed[0];
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

function normalizeAuthMode(value: unknown): ModelProviderAuthMode {
  return value === "codex_auth" ? "codex_auth" : "api_key";
}

type ProcessLike = { env?: Record<string, string | undefined> };
type PathUtilsLike = { homeDir?: string; join?: (...parts: string[]) => string };
type ServicesLike = {
  dirsvc?: {
    get?: (key: string, iface?: unknown) => { path?: string } | undefined;
  };
};
type OSLike = {
  Constants?: {
    Path?: {
      homeDir?: string;
    };
  };
};

function getProcess(): ProcessLike | undefined {
  const fromGlobal = (globalThis as { process?: ProcessLike }).process;
  if (fromGlobal?.env) return fromGlobal;
  const fromToolkit = ztoolkit.getGlobal("process") as ProcessLike | undefined;
  return fromToolkit?.env ? fromToolkit : undefined;
}

function getPathUtils(): PathUtilsLike | undefined {
  const fromGlobal = (globalThis as { PathUtils?: PathUtilsLike }).PathUtils;
  if (fromGlobal?.homeDir || fromGlobal?.join) return fromGlobal;
  return ztoolkit.getGlobal("PathUtils") as PathUtilsLike | undefined;
}

function getServices(): ServicesLike | undefined {
  const fromGlobal = (globalThis as { Services?: ServicesLike }).Services;
  if (fromGlobal?.dirsvc?.get) return fromGlobal;
  return ztoolkit.getGlobal("Services") as ServicesLike | undefined;
}

function getOS(): OSLike | undefined {
  const fromGlobal = (globalThis as { OS?: OSLike }).OS;
  if (fromGlobal?.Constants?.Path?.homeDir) return fromGlobal;
  return ztoolkit.getGlobal("OS") as OSLike | undefined;
}

function getNsIFile(): unknown {
  const ci = (globalThis as { Ci?: { nsIFile?: unknown } }).Ci;
  if (ci?.nsIFile) return ci.nsIFile;
  const components = (globalThis as {
    Components?: { interfaces?: { nsIFile?: unknown } };
  }).Components;
  return components?.interfaces?.nsIFile;
}

function joinPath(...parts: string[]): string {
  const pathUtils = getPathUtils();
  if (pathUtils?.join) return pathUtils.join(...parts);
  return parts
    .filter(Boolean)
    .map((part, index) =>
      index === 0
        ? part.replace(/[\\/]+$/, "")
        : part.replace(/^[\\/]+|[\\/]+$/g, ""),
    )
    .join("/");
}

function resolveCodexAuthPath(): string {
  const env = getProcess()?.env;
  const codexHome = env?.CODEX_HOME?.trim();
  if (codexHome) return joinPath(codexHome, "auth.json");
  const home =
    env?.HOME?.trim() ||
    env?.USERPROFILE?.trim() ||
    getPathUtils()?.homeDir?.trim() ||
    getOS()?.Constants?.Path?.homeDir?.trim() ||
    getServices()?.dirsvc?.get?.("Home", getNsIFile())?.path?.trim() ||
    (Zotero as unknown as { Profile?: { dir?: string } }).Profile?.dir?.trim();
  if (!home) throw new Error("Unable to resolve home directory for codex auth");
  return joinPath(home, ".codex", "auth.json");
}

async function readCodexAccessToken(): Promise<string> {
  const authPath = resolveCodexAuthPath();
  const io = ztoolkit.getGlobal("IOUtils") as
    | { read?: (path: string) => Promise<Uint8Array | ArrayBuffer> }
    | undefined;
  if (!io?.read) {
    throw new Error("IOUtils is unavailable; cannot read Codex auth file");
  }
  const data = await io.read(authPath);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const raw = new TextDecoder("utf-8").decode(bytes);
  const parsed = JSON.parse(raw) as {
    tokens?: { access_token?: string };
  };
  const token = parsed?.tokens?.access_token?.trim() || "";
  if (!token) {
    throw new Error("No access token found in ~/.codex/auth.json. Run `codex login` first.");
  }
  return token;
}

function extractTextFromCodexSSE(raw: string): string {
  const lines = raw.split(/\r?\n/);
  let out = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as {
        type?: string;
        delta?: string;
        response?: {
          output_text?: string;
          output?: Array<{
            content?: Array<{ type?: string; text?: string }>;
          }>;
        };
      };
      if (typeof parsed.delta === "string") {
        out += parsed.delta;
      }
      const completedText = parsed.response?.output_text;
      if (typeof completedText === "string" && completedText.trim()) {
        out += completedText;
      }
      const outputItems = parsed.response?.output || [];
      for (const item of outputItems) {
        const content = item.content || [];
        for (const part of content) {
          if (
            (part.type === "output_text" || part.type === "text") &&
            typeof part.text === "string"
          ) {
            out += part.text;
          }
        }
      }
    } catch (_err) {
      continue;
    }
  }
  return out.trim();
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

  // ── Tab bar switching ───────────────────────────────────────────
  const tabBar = doc.querySelector(`#${config.addonRef}-pref-tab-bar`) as HTMLElement | null;
  if (tabBar) {
    const switchTab = (tabId: string) => {
      // Hide all panels
      const panels = doc.querySelectorAll("[data-pref-panel]");
      for (let i = 0; i < panels.length; i++) {
        (panels[i] as HTMLElement).style.display = "none";
      }
      // Show target panel
      const target = doc.querySelector(`[data-pref-panel="${tabId}"]`) as HTMLElement | null;
      if (target) target.style.display = "flex";
      // Update tab button styles
      const tabs = tabBar.querySelectorAll("[data-pref-tab]");
      for (let i = 0; i < tabs.length; i++) {
        const btn = tabs[i] as HTMLElement;
        if (btn.getAttribute("data-pref-tab") === tabId) {
          btn.style.color = "FieldText";
          btn.style.background = "Field";
          btn.style.fontWeight = "600";
          btn.style.boxShadow = "0 1px 3px rgba(0,0,0,0.12)";
        } else {
          btn.style.color = "var(--fill-secondary, #888)";
          btn.style.background = "transparent";
          btn.style.fontWeight = "500";
          btn.style.boxShadow = "none";
        }
      }
    };
    // Wire click handlers
    const tabBtns = tabBar.querySelectorAll("[data-pref-tab]");
    for (let i = 0; i < tabBtns.length; i++) {
      const btn = tabBtns[i] as HTMLElement;
      btn.addEventListener("click", () => {
        switchTab(btn.getAttribute("data-pref-tab") || "models");
      });
    }
    // Activate first tab
    switchTab("models");
  }

  const modelSections = doc.querySelector(
    `#${config.addonRef}-model-sections`,
  ) as HTMLDivElement | null;
  const systemPromptInput = doc.querySelector(
    `#${config.addonRef}-system-prompt`,
  ) as HTMLTextAreaElement | null;
  const popupAddTextEnabledInput = doc.querySelector(
    `#${config.addonRef}-popup-add-text-enabled`,
  ) as HTMLInputElement | null;
  const enableAgentModeInput = doc.querySelector(
    `#${config.addonRef}-enable-agent-mode`,
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
        "Each provider has an auth mode, API URL, and one or more model variants.",
      ),
    );
    wrap.appendChild(headingLeft);

    // ── Per-provider cards ─────────────────────────────────────────

    groups.forEach((group, groupIndex) => {
      const profile = getProviderProfile(groupIndex);
      group.authMode = normalizeAuthMode(group.authMode);
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

      // ── Auth mode ────────────────────────────────────────────────
      const authModeWrap = el(doc, "div", "display: flex; flex-direction: column;");
      const authModeLabel = el(doc, "label", LABEL_STYLE, "Auth Mode");
      const authModeSelect = el(doc, "select", INPUT_STYLE) as HTMLSelectElement;
      authModeSelect.id = `${config.addonRef}-auth-mode-${group.id}`;
      authModeLabel.setAttribute("for", authModeSelect.id);
      const apiKeyOption = el(doc, "option") as HTMLOptionElement;
      apiKeyOption.value = "api_key";
      apiKeyOption.textContent = "API Key";
      const codexOption = el(doc, "option") as HTMLOptionElement;
      codexOption.value = "codex_auth";
      codexOption.textContent = "codex auth";
      authModeSelect.append(apiKeyOption, codexOption);
      authModeSelect.value = group.authMode;
      authModeSelect.addEventListener("change", () => {
        const nextAuthMode = normalizeAuthMode(authModeSelect.value);
        group.authMode = nextAuthMode;
        if (nextAuthMode === "codex_auth") {
          group.providerProtocol = "codex_responses";
        } else if (group.providerProtocol === "codex_responses") {
          group.providerProtocol =
            selectedPreset?.defaultProtocol || "openai_chat_compat";
        }
        if (nextAuthMode === "codex_auth" && !group.apiBase.trim()) {
          group.apiBase = DEFAULT_CODEX_API_BASE;
        }
        persistGroups(groups);
        setTimeout(() => rerender(), 0);
      });
      authModeWrap.append(
        authModeLabel,
        authModeSelect,
        el(
          doc,
          "span",
          HELPER_STYLE,
          "codex auth reuses local `codex login` credentials from ~/.codex/auth.json",
        ),
      );

      const selectedPresetId: ProviderPresetId =
        group.authMode === "codex_auth"
          ? "customized"
          : (group.presetIdOverride ?? detectProviderPreset(group.apiBase));
      const selectedPreset =
        selectedPresetId === "customized"
          ? null
          : getProviderPreset(selectedPresetId);
      const isCustomizedPreset =
        group.authMode !== "codex_auth" && selectedPresetId === "customized";
      group.providerProtocol = resolveSelectedProtocol(group, selectedPresetId);

      // ── Provider preset ─────────────────────────────────────────
      const providerPresetWrap = el(
        doc,
        "div",
        "display: flex; flex-direction: column;",
      );
      if (group.authMode !== "codex_auth") {
        const providerPresetLabel = el(doc, "label", LABEL_STYLE, "Provider");
        const providerPresetSelect = el(
          doc,
          "select",
          INPUT_STYLE,
        ) as HTMLSelectElement;
        providerPresetSelect.id = `${config.addonRef}-provider-preset-${group.id}`;
        providerPresetLabel.setAttribute("for", providerPresetSelect.id);

        for (const preset of PROVIDER_PRESETS) {
          const option = el(doc, "option") as HTMLOptionElement;
          option.value = preset.id;
          option.textContent = preset.label;
          providerPresetSelect.appendChild(option);
        }
        const customizedOption = el(doc, "option") as HTMLOptionElement;
        customizedOption.value = "customized";
        customizedOption.textContent = "Customized";
        providerPresetSelect.appendChild(customizedOption);

        providerPresetSelect.value = selectedPresetId;
        providerPresetSelect.addEventListener("change", () => {
          const nextPresetId = normalizeProviderPresetId(providerPresetSelect.value);
          if (nextPresetId === "customized") {
            group.presetIdOverride = "customized";
            // Keep existing apiBase so user can edit it
          } else {
            group.presetIdOverride = undefined;
            group.apiBase = getProviderPreset(nextPresetId).defaultApiBase;
            group.providerProtocol = getProviderPreset(nextPresetId).defaultProtocol;
          }
          persistGroups(groups);
          // Defer rerender so the browser can close the dropdown before we replace the DOM
          // (avoids "this.element is null" in Firefox's SelectChild.sys.mjs)
          setTimeout(() => rerender(), 0);
        });

        providerPresetWrap.append(providerPresetLabel, providerPresetSelect);
      }

      // ── Protocol ────────────────────────────────────────────────
      const protocolWrap = el(
        doc,
        "div",
        "display: flex; flex-direction: column;",
      );
      const protocolLabel = el(doc, "label", LABEL_STYLE, "Protocol");
      const protocolSelect = el(doc, "select", INPUT_STYLE) as HTMLSelectElement;
      protocolSelect.id = `${config.addonRef}-provider-protocol-${group.id}`;
      protocolLabel.setAttribute("for", protocolSelect.id);
      const protocolOptions = getProtocolOptions(group.authMode, selectedPresetId);
      for (const protocol of protocolOptions) {
        const option = el(doc, "option") as HTMLOptionElement;
        option.value = protocol;
        option.textContent = getProviderProtocolSpec(protocol).label;
        protocolSelect.appendChild(option);
      }
      protocolSelect.value = group.providerProtocol;
      protocolSelect.disabled = protocolOptions.length <= 1;
      protocolSelect.addEventListener("change", () => {
        group.providerProtocol = resolveSelectedProtocol(
          {
            ...group,
            providerProtocol: protocolSelect.value as ProviderProtocol,
          },
          selectedPresetId,
        );
        persistGroups(groups);
        setTimeout(() => rerender(), 0);
      });
      protocolWrap.append(
        protocolLabel,
        protocolSelect,
        el(
          doc,
          "span",
          HELPER_STYLE,
          getProviderProtocolSpec(group.providerProtocol).helperText,
        ),
      );

      // ── API URL ──────────────────────────────────────────────────
      const apiUrlWrap = el(doc, "div", "display: flex; flex-direction: column;");
      const apiUrlLabel = el(doc, "label", LABEL_STYLE, "API URL");
      const apiUrlInput = el(doc, "input", INPUT_STYLE) as HTMLInputElement;
      apiUrlInput.id = `${config.addonRef}-api-base-${group.id}`;
      apiUrlLabel.setAttribute("for", apiUrlInput.id);
      apiUrlInput.type = "text";
      apiUrlInput.placeholder =
        group.authMode === "codex_auth"
          ? DEFAULT_CODEX_API_BASE
          : selectedPreset?.defaultApiBase || "https://api.openai.com/v1";
      apiUrlInput.value = group.apiBase;
      apiUrlInput.readOnly = group.authMode !== "codex_auth" && !isCustomizedPreset;
      apiUrlInput.style.opacity = apiUrlInput.readOnly ? "0.85" : "1";
      apiUrlInput.style.cursor = apiUrlInput.readOnly ? "default" : "text";
      apiUrlInput.style.pointerEvents = apiUrlInput.readOnly ? "none" : "auto";
      apiUrlInput.title = apiUrlInput.readOnly
        ? "Switch Provider to Customized to edit this URL manually."
        : "";
      apiUrlInput.addEventListener("input", () => {
        group.apiBase = apiUrlInput.value;
        persistGroups(groups);
        syncAddProviderBtn();
      });
      const apiUrlHelper = el(
        doc,
        "span",
        HELPER_STYLE,
        group.authMode === "codex_auth"
          ? CODEX_API_HELPER_TEXT
          : getPresetSelectHelperText(selectedPresetId),
      );
      apiUrlWrap.append(
        apiUrlLabel,
        apiUrlInput,
        apiUrlHelper,
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
      if (group.authMode === "codex_auth") {
        apiKeyWrap.style.display = "none";
      }

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
            const authMode = normalizeAuthMode(group.authMode);
            const apiBase = (
              group.apiBase.trim() ||
              (authMode === "codex_auth" ? DEFAULT_CODEX_API_BASE : "")
            ).replace(/\/$/, "");
            const apiKey =
              authMode === "codex_auth"
                ? await readCodexAccessToken()
                : group.apiKey.trim();
            const modelName = (
              modelEntry.model || profile.defaultModel || "gpt-5.4"
            ).trim();
            const providerProtocol = resolveSelectedProtocol(group, selectedPresetId);

            if (!apiBase) throw new Error("API URL is required");
            if (!apiKey) {
              throw new Error(
                authMode === "codex_auth"
                  ? "codex token missing. Run `codex login` first."
                  : "API Key is required",
              );
            }

            const fetchFn = ztoolkit.getGlobal("fetch") as typeof fetch;
            const result = await runProviderConnectionTest({
              fetchFn,
              protocol: providerProtocol,
              authMode,
              apiBase,
              apiKey,
              modelName,
            });
            statusLine.textContent =
              `✓ Success — model says: "${result.reply}"\n` +
              `Agent capability: ${result.capabilityLabel}`;
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
      if (group.authMode === "codex_auth") {
        cardBody.append(
          authModeWrap,
          protocolWrap,
          apiUrlWrap,
          apiKeyWrap,
          divider,
          modelsWrap,
        );
      } else {
        cardBody.append(
          authModeWrap,
          providerPresetWrap,
          protocolWrap,
          apiUrlWrap,
          apiKeyWrap,
          divider,
          modelsWrap,
        );
      }
      card.append(cardHeader, cardBody);
      wrap.appendChild(card);
    });

    // ── Add Provider button ──────────────────────────────────────

    const addProviderBtn = el(
      doc,
      "button",
      PRIMARY_BTN_STYLE + " margin-top: 2px; font-size: 12.5px; text-align: center;",
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

  if (enableAgentModeInput) {
    const prefValue = Zotero.Prefs.get(
      `${config.prefsPrefix}.enableAgentMode`,
      true,
    );
    enableAgentModeInput.checked =
      prefValue === true || `${prefValue || ""}`.toLowerCase() === "true";
    enableAgentModeInput.addEventListener("change", () => {
      Zotero.Prefs.set(
        `${config.prefsPrefix}.enableAgentMode`,
        enableAgentModeInput.checked,
        true,
      );
    });
  }

  // ── MinerU settings ─────────────────────────────────────────────

  const mineruEnabledInput = doc.querySelector(
    `#${config.addonRef}-mineru-enabled`,
  ) as HTMLInputElement | null;
  const mineruSubSettings = doc.querySelector(
    `#${config.addonRef}-mineru-sub-settings`,
  ) as HTMLDivElement | null;
  const mineruApiKeyInput = doc.querySelector(
    `#${config.addonRef}-mineru-api-key`,
  ) as HTMLInputElement | null;
  const mineruTestBtn = doc.querySelector(
    `#${config.addonRef}-mineru-test`,
  ) as HTMLButtonElement | null;
  const mineruTestStatus = doc.querySelector(
    `#${config.addonRef}-mineru-test-status`,
  ) as HTMLSpanElement | null;
  if (mineruEnabledInput) {
    mineruEnabledInput.checked = isMineruEnabled();
    const syncSubVisibility = () => {
      if (mineruSubSettings) {
        mineruSubSettings.style.display = mineruEnabledInput.checked
          ? "flex"
          : "none";
      }
    };
    syncSubVisibility();
    mineruEnabledInput.addEventListener("change", () => {
      setMineruEnabled(mineruEnabledInput.checked);
      syncSubVisibility();
    });
  }

  if (mineruApiKeyInput) {
    mineruApiKeyInput.value = getMineruApiKey();
    mineruApiKeyInput.addEventListener("input", () => {
      setMineruApiKey(mineruApiKeyInput.value);
    });
  }

  if (mineruTestBtn && mineruTestStatus) {
    const runMineruTest = async () => {
      const apiKey = getMineruApiKey().trim();
      if (!apiKey) {
        mineruTestStatus.style.display = "inline";
        mineruTestStatus.textContent = "Enter an API key first";
        mineruTestStatus.style.color = "var(--fill-secondary, #888)";
        return;
      }
      mineruTestBtn.disabled = true;
      mineruTestStatus.style.display = "inline";
      mineruTestStatus.textContent = "Testing…";
      mineruTestStatus.style.color = "var(--fill-secondary, #888)";
      try {
        await testMineruConnection(apiKey);
        mineruTestStatus.textContent = "\u2713 Connection successful";
        mineruTestStatus.style.color = "green";
      } catch (error) {
        mineruTestStatus.textContent = `\u2717 ${(error as Error).message}`;
        mineruTestStatus.style.color = "red";
      } finally {
        mineruTestBtn.disabled = false;
      }
    };
    mineruTestBtn.addEventListener("click", () => void runMineruTest());
    mineruTestBtn.addEventListener("command", () => void runMineruTest());
  }

  // ── Embedded MinerU manager ──────────────────────────────────────
  const mineruMgrSidebar = doc.querySelector(
    `#${config.addonRef}-mineru-mgr-sidebar`,
  );
  if (mineruMgrSidebar && _window) {
    void registerMineruManagerScript(_window, config.addonRef);
  }
}
