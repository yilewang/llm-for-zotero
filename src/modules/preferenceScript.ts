import { config } from "../../package.json";
import { t } from "../utils/i18n";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_SYSTEM_PROMPT,
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
  isProviderProtocol,
  normalizeProviderProtocolForAuthMode,
  getProviderProtocolSpec,
  type ProviderProtocol,
} from "../utils/providerProtocol";
import { runProviderConnectionTest } from "../utils/providerConnectionTest";
import {
  startCopilotDeviceFlow,
  pollCopilotDeviceAuth,
  resolveCopilotAccessToken,
  fetchCopilotModelList,
} from "../utils/llmClient";
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
const COPILOT_API_HELPER_TEXT =
  "GitHub Copilot uses device-based login. Click Login to authenticate via GitHub.";
const DEFAULT_COPILOT_API_BASE = "https://api.githubcopilot.com";
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
  if (index < PROVIDER_PROFILES.length) {
    const p = PROVIDER_PROFILES[index];
    return { ...p, label: t(p.label) };
  }
  const letter = String.fromCharCode("A".charCodeAt(0) + index);
  return { label: t(`Provider ${letter}`), modelPlaceholder: "", defaultModel: "" };
}

function normalizeProviderPresetId(value: unknown): ProviderPresetId {
  if (typeof value !== "string") return "customized";
  return value === "customized" || PROVIDER_PRESETS.some((preset) => preset.id === value)
    ? (value as ProviderPresetId)
    : "customized";
}

function getPresetSelectHelperText(presetId: ProviderPresetId): string {
  if (presetId === "customized") {
    return t(CUSTOMIZED_API_HELPER_TEXT);
  }
  return `${getProviderPreset(presetId).helperText} ${t("Switch to Customized to edit the URL manually.")}`;
}

function getProtocolOptions(
  authMode: ModelProviderAuthMode,
  presetId: ProviderPresetId,
): ProviderProtocol[] {
  if (authMode === "codex_auth") return ["codex_responses"];
  if (authMode === "copilot_auth") return ["openai_chat_compat", "responses_api"];
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
  if (value === "codex_auth") return "codex_auth";
  if (value === "copilot_auth") return "copilot_auth";
  return "api_key";
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

  // ── Translate static XHTML text ────────────────────────────────
  // Tab buttons
  const tabButtons = doc.querySelectorAll("[data-pref-tab]");
  for (let i = 0; i < tabButtons.length; i++) {
    const btn = tabButtons[i] as HTMLElement;
    const text = btn.textContent?.trim();
    if (text) btn.textContent = t(text);
  }
  // Walk all labels, spans, and helper text in the preference panels
  // and translate their text content if it matches a known key.
  // Collapse multi-line whitespace into a single space for translation lookup
  const normalizeWs = (s: string): string => s.replace(/\s+/g, " ").trim();

  const translateTextNodes = (container: Element) => {
    const elements = container.querySelectorAll("label, span, div, summary");
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i] as HTMLElement;
      // For labels with inputs, translate the text node after the input
      if (el.tagName.toLowerCase() === "label" && el.querySelector("input")) {
        for (const child of Array.from(el.childNodes)) {
          if (child && child.nodeType === 3 /* TEXT_NODE */ && child.textContent && child.textContent.trim()) {
            const original = normalizeWs(child.textContent);
            const translated = t(original);
            if (translated !== original) {
              child.textContent = ` ${translated}`;
            }
          }
        }
        continue;
      }
      // For plain text elements (no children) — replace directly
      if (el.children.length === 0) {
        const text = normalizeWs(el.textContent || "");
        if (text) {
          const translated = t(text);
          if (translated !== text) {
            el.textContent = translated;
          }
        }
        continue;
      }
      // For elements with inline children (e.g., <a>, <br>, <strong>) —
      // translate each text node individually
      for (const child of Array.from(el.childNodes)) {
        if (child && child.nodeType === 3 /* TEXT_NODE */ && child.textContent && child.textContent.trim()) {
          const original = normalizeWs(child.textContent);
          const translated = t(original);
          if (translated !== original) {
            child.textContent = ` ${translated} `;
          }
        }
      }
    }
  };
  const prefPanels = doc.querySelectorAll("[data-pref-panel]");
  for (let i = 0; i < prefPanels.length; i++) {
    translateTextNodes(prefPanels[i]);
  }
  // Translate textarea placeholder
  const systemPrompt = doc.querySelector(`#${config.addonRef}-system-prompt`) as HTMLTextAreaElement | null;
  if (systemPrompt?.placeholder) {
    systemPrompt.placeholder = t(systemPrompt.placeholder);
  }
  const mineruApiKeyEl = doc.querySelector(`#${config.addonRef}-mineru-api-key`) as HTMLInputElement | null;
  if (mineruApiKeyEl?.placeholder) {
    mineruApiKeyEl.placeholder = t(mineruApiKeyEl.placeholder);
  }
  // Translate language dropdown options
  const localeSelectEl = doc.querySelector(`#${config.addonRef}-locale-select`) as HTMLSelectElement | null;
  if (localeSelectEl) {
    const autoOption = localeSelectEl.querySelector('option[value="auto"]') as HTMLOptionElement | null;
    if (autoOption) autoOption.textContent = t("Auto (follow Zotero)");
  }
  // Translate restart hint
  const restartHint = doc.querySelector(`#${config.addonRef}-locale-restart-hint`) as HTMLElement | null;
  if (restartHint) restartHint.textContent = t("Restart Zotero to apply language change.");

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
      el(doc, "span", "font-size: 14px; font-weight: 800; color: var(--fill-primary, inherit);", t("AI Providers")),
      el(
        doc,
        "span",
        "font-size: 11.5px; color: var(--fill-secondary, #888);",
        t("Each provider has an auth mode, API URL, and one or more model variants."),
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
      const removeProvBtn = iconBtn(doc, "×", t("Remove provider"));
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
      const authModeLabel = el(doc, "label", LABEL_STYLE, t("Auth Mode"));
      const authModeSelect = el(doc, "select", INPUT_STYLE) as HTMLSelectElement;
      authModeSelect.id = `${config.addonRef}-auth-mode-${group.id}`;
      authModeLabel.setAttribute("for", authModeSelect.id);
      const apiKeyOption = el(doc, "option") as HTMLOptionElement;
      apiKeyOption.value = "api_key";
      apiKeyOption.textContent = t("API Key");
      const codexOption = el(doc, "option") as HTMLOptionElement;
      codexOption.value = "codex_auth";
      codexOption.textContent = t("Codex Auth");
      const copilotOption = el(doc, "option") as HTMLOptionElement;
      copilotOption.value = "copilot_auth";
      copilotOption.textContent = t("GitHub Copilot");
      authModeSelect.append(apiKeyOption, codexOption, copilotOption);
      authModeSelect.value = group.authMode;
      authModeSelect.addEventListener("change", () => {
        const nextAuthMode = normalizeAuthMode(authModeSelect.value);
        group.authMode = nextAuthMode;
        if (nextAuthMode === "codex_auth") {
          group.providerProtocol = "codex_responses";
        } else if (nextAuthMode === "copilot_auth") {
          group.providerProtocol = "openai_chat_compat";
        } else if (group.providerProtocol === "codex_responses") {
          group.providerProtocol =
            selectedPreset?.defaultProtocol || "openai_chat_compat";
        }
        if (nextAuthMode === "codex_auth" && !group.apiBase.trim()) {
          group.apiBase = DEFAULT_CODEX_API_BASE;
        }
        if (nextAuthMode === "copilot_auth" && !group.apiBase.trim()) {
          group.apiBase = DEFAULT_COPILOT_API_BASE;
        }
        persistGroups(groups);
        setTimeout(() => rerender(), 0);
      });
      const authModeHelperText =
        group.authMode === "copilot_auth"
          ? t(COPILOT_API_HELPER_TEXT)
          : t("codex auth reuses local `codex login` credentials from ~/.codex/auth.json");
      authModeWrap.append(
        authModeLabel,
        authModeSelect,
        el(doc, "span", HELPER_STYLE, authModeHelperText),
      );

      const selectedPresetId: ProviderPresetId =
        group.authMode === "codex_auth" || group.authMode === "copilot_auth"
          ? "customized"
          : (group.presetIdOverride ?? detectProviderPreset(group.apiBase));
      const selectedPreset =
        selectedPresetId === "customized"
          ? null
          : getProviderPreset(selectedPresetId);
      const isCustomizedPreset =
        group.authMode !== "codex_auth" &&
        group.authMode !== "copilot_auth" &&
        selectedPresetId === "customized";
      group.providerProtocol = resolveSelectedProtocol(group, selectedPresetId);

      // ── Provider preset ─────────────────────────────────────────
      const providerPresetWrap = el(
        doc,
        "div",
        "display: flex; flex-direction: column;",
      );
      if (group.authMode !== "codex_auth" && group.authMode !== "copilot_auth") {
        const providerPresetLabel = el(doc, "label", LABEL_STYLE, t("Provider"));
        const providerPresetSelect = el(
          doc,
          "select",
          INPUT_STYLE,
        ) as HTMLSelectElement;
        providerPresetSelect.id = `${config.addonRef}-provider-preset-${group.id}`;
        providerPresetLabel.setAttribute("for", providerPresetSelect.id);

        for (const preset of PROVIDER_PRESETS) {
          // Copilot requires copilot_auth, not usable with API Key
          if (preset.id === "copilot") continue;
          const option = el(doc, "option") as HTMLOptionElement;
          option.value = preset.id;
          option.textContent = preset.label;
          providerPresetSelect.appendChild(option);
        }
        const customizedOption = el(doc, "option") as HTMLOptionElement;
        customizedOption.value = "customized";
        customizedOption.textContent = t("Customized");
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
      const protocolLabel = el(doc, "label", LABEL_STYLE, t("Protocol"));
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
      const apiUrlLabel = el(doc, "label", LABEL_STYLE, t("API URL"));
      const apiUrlInput = el(doc, "input", INPUT_STYLE) as HTMLInputElement;
      apiUrlInput.id = `${config.addonRef}-api-base-${group.id}`;
      apiUrlLabel.setAttribute("for", apiUrlInput.id);
      apiUrlInput.type = "text";
      apiUrlInput.placeholder =
        group.authMode === "codex_auth"
          ? DEFAULT_CODEX_API_BASE
          : group.authMode === "copilot_auth"
            ? DEFAULT_COPILOT_API_BASE
            : selectedPreset?.defaultApiBase || "https://api.openai.com/v1";
      apiUrlInput.value = group.apiBase;
      apiUrlInput.readOnly =
        group.authMode !== "codex_auth" &&
        group.authMode !== "copilot_auth" &&
        !isCustomizedPreset;
      apiUrlInput.style.opacity = apiUrlInput.readOnly ? "0.85" : "1";
      apiUrlInput.style.cursor = apiUrlInput.readOnly ? "default" : "text";
      apiUrlInput.style.pointerEvents = apiUrlInput.readOnly ? "none" : "auto";
      apiUrlInput.title = apiUrlInput.readOnly
        ? t("Switch Provider to Customized to edit this URL manually.")
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
          ? t(CODEX_API_HELPER_TEXT)
          : group.authMode === "copilot_auth"
            ? t(COPILOT_API_HELPER_TEXT)
            : getPresetSelectHelperText(selectedPresetId),
      );
      apiUrlWrap.append(
        apiUrlLabel,
        apiUrlInput,
        apiUrlHelper,
      );

      // ── API Key ──────────────────────────────────────────────────
      const apiKeyWrap = el(doc, "div", "display: flex; flex-direction: column;");
      const apiKeyLabel = el(doc, "label", LABEL_STYLE, t("API Key"));
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
      if (group.authMode === "codex_auth" || group.authMode === "copilot_auth") {
        apiKeyWrap.style.display = "none";
      }

      // ── Copilot Login ────────────────────────────────────────────
      const copilotLoginWrap = el(doc, "div", "display: flex; flex-direction: column; gap: 6px;");
      if (group.authMode === "copilot_auth") {
        const isLoggedIn = group.apiKey.startsWith("ghu_");
        const copilotStatus = el(
          doc,
          "span",
          HELPER_STYLE + " font-weight: 500;",
          isLoggedIn ? t("Logged in to GitHub Copilot") : "",
        );

        const copilotLoginBtn = el(
          doc,
          "button",
          PRIMARY_BTN_STYLE + " font-size: 12.5px;",
          isLoggedIn ? t("Re-login") : t("Login with GitHub Copilot"),
        ) as HTMLButtonElement;
        copilotLoginBtn.type = "button";

        const AbortControllerCtor =
          (ztoolkit.getGlobal("AbortController") as (new () => AbortController) | undefined) ||
          (globalThis as typeof globalThis & { AbortController?: new () => AbortController }).AbortController;
        let loginAbort: AbortController | null = null;

        copilotLoginBtn.addEventListener("click", async () => {
          if (loginAbort) {
            loginAbort.abort();
            loginAbort = null;
          }
          loginAbort = AbortControllerCtor ? new AbortControllerCtor() : null;
          const signal = loginAbort?.signal;

          copilotLoginBtn.disabled = true;
          copilotStatus.style.color = "var(--fill-secondary, #888)";
          copilotStatus.textContent = t("Requesting device code…");

          try {
            const device = await startCopilotDeviceFlow(signal);
            copilotStatus.textContent = `${t("Enter this code on GitHub:")} ${device.user_code}`;
            copilotStatus.style.color = "var(--color-accent, #2563eb)";

            // Show popup dialog with the device code
            const dialogOverlay = el(
              doc,
              "div",
              "position: fixed; inset: 0; z-index: 10000;" +
              " background: rgba(0,0,0,0.5);" +
              " display: flex; align-items: center; justify-content: center;",
            );
            const dialogBox = el(
              doc,
              "div",
              "background: var(--material-background, #fff); color: var(--fill-primary, #222);" +
              " border-radius: 12px; padding: 28px 36px; min-width: 340px; max-width: 420px;" +
              " box-shadow: 0 8px 32px rgba(0,0,0,0.25); text-align: center;" +
              " display: flex; flex-direction: column; gap: 16px; position: relative;",
            );
            const closeBtn = el(
              doc,
              "button",
              "position: absolute; top: 10px; right: 14px; background: none; border: none;" +
              " font-size: 20px; cursor: pointer; color: var(--fill-secondary, #888);" +
              " line-height: 1; padding: 2px 6px;",
              "\u00D7",
            ) as HTMLButtonElement;
            closeBtn.type = "button";
            closeBtn.title = t("Close");
            closeBtn.addEventListener("click", () => {
              try { dialogOverlay.remove(); } catch (_e) { /* ignore */ }
            });
            dialogBox.appendChild(closeBtn);
            dialogBox.appendChild(
              el(doc, "div", "font-size: 15px; font-weight: 600;", t("Enter this code on GitHub:")),
            );
            const codeDisplay = el(
              doc,
              "div",
              "font-size: 32px; font-weight: 700;" +
              " font-family: monospace; padding: 12px 0;" +
              " background: var(--material-sidepane, #f4f4f4); border-radius: 8px;" +
              " user-select: all; cursor: text;" +
              " display: flex; justify-content: center;",
            );
            codeDisplay.textContent = device.user_code;
            dialogBox.appendChild(codeDisplay);

            const copyBtn = el(
              doc,
              "button",
              PRIMARY_BTN_STYLE +
              " font-size: 13px; padding: 8px 20px; align-self: center;" +
              " display: flex; align-items: center; justify-content: center; line-height: 1.4;",
              t("Copy code & open GitHub"),
            ) as HTMLButtonElement;
            copyBtn.type = "button";
            copyBtn.addEventListener("click", () => {
              try {
                const clipHelper = (
                  globalThis as typeof globalThis & {
                    Components?: {
                      classes?: Record<string, { getService?: (iface: unknown) => { kSuppressClearClipboard?: unknown; copyString?: (text: string, ctx?: unknown) => void } }>;
                      interfaces?: Record<string, unknown>;
                    };
                  }
                ).Components;
                const svc = clipHelper?.classes?.["@mozilla.org/widget/clipboardhelper;1"]?.getService?.(
                  clipHelper?.interfaces?.nsIClipboardHelper,
                );
                if (svc?.copyString) {
                  svc.copyString(device.user_code, svc.kSuppressClearClipboard);
                }
              } catch (_e) { /* ignore */ }
              try {
                const launch = (Zotero as unknown as { launchURL?: (url: string) => void }).launchURL;
                if (typeof launch === "function") launch(device.verification_uri);
              } catch (_e) { /* ignore */ }
            });
            dialogBox.appendChild(copyBtn);

            const waitingText = el(
              doc,
              "div",
              "font-size: 12px; color: var(--fill-secondary, #888);",
              t("Waiting for authorization…"),
            );
            dialogBox.appendChild(waitingText);

            dialogOverlay.addEventListener("click", (e) => {
              if (e.target === dialogOverlay) {
                try { dialogOverlay.remove(); } catch (_e) { /* ignore */ }
              }
            });
            dialogOverlay.appendChild(dialogBox);
            const dialogParent = doc.body ?? doc.documentElement;
            if (dialogParent) dialogParent.appendChild(dialogOverlay);

            // Also open browser automatically
            try {
              const launch = (Zotero as unknown as { launchURL?: (url: string) => void }).launchURL;
              if (typeof launch === "function") launch(device.verification_uri);
            } catch (_err) { /* ignore */ }

            let dialogDismissed = false;
            const dismissDialog = (msg?: string, color?: string) => {
              if (dialogDismissed) return;
              dialogDismissed = true;
              try { dialogOverlay.remove(); } catch (_e) { /* ignore */ }
              if (msg) {
                copilotStatus.textContent = msg;
                copilotStatus.style.color = color || "green";
              }
            };

            try {
              const token = await pollCopilotDeviceAuth({
                deviceCode: device.device_code,
                interval: device.interval,
                expiresIn: device.expires_in,
                signal,
              });

              group.apiKey = token;
              persistGroups(groups);
              dismissDialog(t("Login successful!"), "green");
              setTimeout(() => rerender(), 500);
            } catch (innerErr) {
              dismissDialog();
              throw innerErr;
            }
          } catch (err) {
            if (!signal?.aborted) {
              copilotStatus.textContent = `✗ ${(err as Error).message}`;
              copilotStatus.style.color = "red";
            }
          } finally {
            copilotLoginBtn.disabled = false;
            loginAbort = null;
          }
        });

        const copilotLogoutBtn = el(
          doc,
          "button",
          OUTLINE_BTN_STYLE + " font-size: 11px; padding: 2px 8px;",
          t("Log out"),
        ) as HTMLButtonElement;
        copilotLogoutBtn.type = "button";
        copilotLogoutBtn.style.display = isLoggedIn ? "inline-block" : "none";
        copilotLogoutBtn.addEventListener("click", () => {
          group.apiKey = "";
          persistGroups(groups);
          rerender();
        });

        const copilotBtnRow = el(doc, "div", "display: flex; gap: 8px; align-items: center;");
        copilotBtnRow.append(copilotLoginBtn, copilotLogoutBtn);

        // ── Fetch models button ──
        const fetchModelsBtn = el(
          doc,
          "button",
          OUTLINE_BTN_STYLE + " font-size: 11px; padding: 3px 10px;",
          t("Fetch available models"),
        ) as HTMLButtonElement;
        fetchModelsBtn.type = "button";
        fetchModelsBtn.style.display = isLoggedIn ? "inline-block" : "none";
        const fetchModelsStatus = el(doc, "span", HELPER_STYLE, "");

        fetchModelsBtn.addEventListener("click", async () => {
          fetchModelsBtn.disabled = true;
          fetchModelsStatus.textContent = t("Fetching models…");
          fetchModelsStatus.style.color = "var(--fill-secondary, #888)";
          try {
            const models = await fetchCopilotModelList({
              githubToken: group.apiKey,
            });
            if (!models.length) {
              fetchModelsStatus.textContent = t("No models found");
              fetchModelsStatus.style.color = "red";
              return;
            }
            // Build a map of existing models to preserve user-customized advanced settings
            const existingAdvanced = new Map<string, ModelProviderModel>();
            for (const m of group.models) {
              existingAdvanced.set(m.model.trim().toLowerCase(), m);
            }
            // Replace the entire model list with fetched models
            group.models = models.map((m) => {
              const existing = existingAdvanced.get(m.id.toLowerCase());
              return createProviderModelEntry(
                m.id,
                existing ? { temperature: existing.temperature, maxTokens: existing.maxTokens, inputTokenCap: existing.inputTokenCap } : undefined,
                m.protocol,
              );
            });
            persistGroups(groups);
            fetchModelsStatus.textContent = t("Synced %n models").replace("%n", String(models.length));
            fetchModelsStatus.style.color = "green";
            setTimeout(() => rerender(), 300);
          } catch (err) {
            fetchModelsStatus.textContent = `✗ ${(err as Error).message}`;
            fetchModelsStatus.style.color = "red";
          } finally {
            fetchModelsBtn.disabled = false;
          }
        });

        const fetchModelsRow = el(doc, "div", "display: flex; gap: 8px; align-items: center;");
        fetchModelsRow.append(fetchModelsBtn, fetchModelsStatus);

        copilotLoginWrap.append(copilotBtnRow, copilotStatus, fetchModelsRow);
      }

      // ── Models list ──────────────────────────────────────────────
      const modelsWrap = el(doc, "div", "display: flex; flex-direction: column; gap: 6px;");

      const modelsHeaderRow = el(
        doc,
        "div",
        "display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px;",
      );
      modelsHeaderRow.appendChild(el(doc, "span", SECTION_LABEL_STYLE, t("Model names")));

      const addModelBtn = iconBtn(doc, "+", t("Add model"));
      addModelBtn.style.color = "var(--color-accent, #2563eb)";
      modelsHeaderRow.appendChild(addModelBtn);
      modelsWrap.appendChild(modelsHeaderRow);

      const syncAddModelBtn = () => {
        const canAdd = !hasEmptyModel(group);
        addModelBtn.disabled = !canAdd;
        addModelBtn.style.opacity = canAdd ? "1" : "0.35";
        addModelBtn.title = canAdd
          ? t("Add model")
          : t("Fill in the current model name first");
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

        const testBtn = el(doc, "button", OUTLINE_BTN_STYLE, t("Test")) as HTMLButtonElement;
        testBtn.type = "button";

        const advGearBtn = iconBtn(doc, "⚙", t("Advanced options"));

        mainRow.append(modelInput, testBtn, advGearBtn);

        if (group.models.length > 1) {
          const removeModelBtn = iconBtn(doc, "×", t("Remove model"));
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
          t("Temperature"),
          `${modelEntry.temperature ?? DEFAULT_TEMPERATURE}`,
          `${DEFAULT_TEMPERATURE}`,
        );
        const maxTokField = makeCompactField(
          t("Max tokens"),
          `${modelEntry.maxTokens ?? DEFAULT_MAX_TOKENS}`,
          `${DEFAULT_MAX_TOKENS}`,
        );
        const inputCapField = makeCompactField(
          t("Input cap"),
          modelEntry.inputTokenCap !== undefined ? `${modelEntry.inputTokenCap}` : "",
          "optional",
        );

        // ── Per-model protocol override ──
        const protocolFieldWrap = el(doc, "div", "display: flex; flex-direction: column; gap: 3px;");
        const protocolFieldLabel = el(
          doc,
          "label",
          "font-size: 10.5px; font-weight: 600; color: var(--fill-primary, inherit);",
          t("Protocol"),
        );
        const protocolFieldSelect = el(doc, "select", INPUT_SM_STYLE + " width: 120px;") as HTMLSelectElement;
        const autoOption = el(doc, "option") as HTMLOptionElement;
        autoOption.value = "";
        autoOption.textContent = t("auto");
        protocolFieldSelect.appendChild(autoOption);
        const allowedProtocols = getProtocolOptions(group.authMode, selectedPresetId);
        for (const proto of allowedProtocols) {
          const opt = el(doc, "option") as HTMLOptionElement;
          opt.value = proto;
          opt.textContent = getProviderProtocolSpec(proto).label;
          protocolFieldSelect.appendChild(opt);
        }
        protocolFieldSelect.value = modelEntry.providerProtocol || "";
        protocolFieldWrap.append(protocolFieldLabel, protocolFieldSelect);

        advFields.append(tempField.wrap, maxTokField.wrap, inputCapField.wrap, protocolFieldWrap);
        advRow.append(
          advFields,
          el(
            doc,
            "span",
            "font-size: 10.5px; color: var(--fill-secondary, #888); margin-top: 2px; display: block;",
            t("Temperature: randomness (0–2)  ·  Max tokens: output limit  ·  Input cap: context limit (optional)"),
          ),
        );

        const commitAdvanced = () => {
          modelEntry.temperature = normalizeTemperature(tempField.input.value);
          modelEntry.maxTokens = normalizeMaxTokens(maxTokField.input.value);
          modelEntry.inputTokenCap = normalizeOptionalInputTokenCap(inputCapField.input.value);
          modelEntry.providerProtocol = isProviderProtocol(protocolFieldSelect.value)
            ? protocolFieldSelect.value
            : undefined;
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
        protocolFieldSelect.addEventListener("change", commitAdvanced);

        const syncAdvAvailability = () => {
          const hasModel = Boolean(modelEntry.model.trim());
          advRow.style.opacity = hasModel ? "1" : "0.45";
          advRow.style.pointerEvents = hasModel ? "" : "none";
          for (const f of [tempField, maxTokField, inputCapField]) f.input.disabled = !hasModel;
          protocolFieldSelect.disabled = !hasModel;
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
          statusLine.textContent = t("Testing…");
          statusLine.style.color = "var(--fill-secondary, #888)";

          try {
            const authMode = normalizeAuthMode(group.authMode);
            const apiBase = (
              group.apiBase.trim() ||
              (authMode === "codex_auth"
                ? DEFAULT_CODEX_API_BASE
                : authMode === "copilot_auth"
                  ? DEFAULT_COPILOT_API_BASE
                  : "")
            ).replace(/\/$/, "");
            const apiKey =
              authMode === "codex_auth"
                ? await readCodexAccessToken()
                : authMode === "copilot_auth"
                  ? await resolveCopilotAccessToken({ githubToken: group.apiKey.trim() })
                  : group.apiKey.trim();
            const modelName = (
              modelEntry.model || profile.defaultModel || "gpt-5.4"
            ).trim();
            const providerProtocol = resolveSelectedProtocol(group, selectedPresetId);

            if (!apiBase) throw new Error(t("API URL is required"));
            if (!apiKey) {
              throw new Error(
                authMode === "codex_auth"
                  ? t("codex token missing. Run `codex login` first.")
                  : authMode === "copilot_auth"
                    ? t("Copilot token missing. Click Login first.")
                    : t("API Key is required"),
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
              `${t("✓ Success — model says: ")}"${result.reply}"\n` +
              `${t("Agent capability: ")}${result.capabilityLabel}`;
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
      if (group.authMode === "copilot_auth") {
        cardBody.append(
          authModeWrap,
          copilotLoginWrap,
          protocolWrap,
          apiUrlWrap,
          divider,
          modelsWrap,
        );
      } else if (group.authMode === "codex_auth") {
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
      t("+ Add Provider"),
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
          ? t("Complete the empty provider first")
          : t("Add provider");
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

    const defaultPromptPre = doc.querySelector(
      `#${config.addonRef}-default-system-prompt`,
    ) as HTMLPreElement | null;
    if (defaultPromptPre) {
      defaultPromptPre.textContent = DEFAULT_SYSTEM_PROMPT;
    }
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
        mineruTestStatus.textContent = t("Enter an API key first");
        mineruTestStatus.style.color = "var(--fill-secondary, #888)";
        return;
      }
      mineruTestBtn.disabled = true;
      mineruTestStatus.style.display = "inline";
      mineruTestStatus.textContent = t("Testing…");
      mineruTestStatus.style.color = "var(--fill-secondary, #888)";
      try {
        await testMineruConnection(apiKey);
        mineruTestStatus.textContent = t("✓ Connection successful");
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

  // ── Language selector ────────────────────────────────────────────
  const localeSelect = doc.querySelector(
    `#${config.addonRef}-locale-select`,
  ) as HTMLSelectElement | null;
  const localeRestartHint = doc.querySelector(
    `#${config.addonRef}-locale-restart-hint`,
  ) as HTMLSpanElement | null;
  if (localeSelect) {
    const prefsPrefix = config.prefsPrefix;
    const currentLocale = Zotero.Prefs.get(`${prefsPrefix}.locale`, true) as string || "auto";
    localeSelect.value = currentLocale;
    localeSelect.addEventListener("change", () => {
      Zotero.Prefs.set(`${prefsPrefix}.locale`, localeSelect.value, true);
      if (localeRestartHint) {
        localeRestartHint.style.display = "block";
      }
    });
  }

  // ── Embedded MinerU manager ──────────────────────────────────────
  const mineruMgrSidebar = doc.querySelector(
    `#${config.addonRef}-mineru-mgr-sidebar`,
  );
  if (mineruMgrSidebar && _window) {
    void registerMineruManagerScript(_window, config.addonRef);
  }
}
