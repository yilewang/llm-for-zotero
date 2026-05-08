import { config } from "../../package.json";
import { t, setLocale } from "../utils/i18n";
import { WEBCHAT_TARGETS } from "../webchat/types";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TEMPERATURE,
} from "../utils/llmDefaults";
import { HTML_NS } from "../utils/domHelpers";
import {
  normalizeMaxTokensForModel,
  normalizeOptionalInputTokenCap,
  normalizeTemperature,
} from "../utils/normalization";
import {
  createEmptyProviderGroup,
  createProviderModelEntry,
  getModelProviderGroups,
  migrateApiBaseForAuthModeChange,
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
import {
  runProviderConnectionTest,
  runCodexAppServerConnectionTest,
} from "../utils/providerConnectionTest";
import {
  startCopilotDeviceFlow,
  pollCopilotDeviceAuth,
  resolveCopilotAccessToken,
  fetchCopilotModelList,
  callEmbeddings,
} from "../utils/llmClient";
import { resetEmbeddingFailedFlags } from "./contextPanel/pdfContext";
import { clearRetrievalCandidateCache } from "./contextPanel/multiContextPlanner";
import { getAgentTraceExportPath } from "../agent/store/traceStore";
import { joinLocalPath } from "../utils/localPath";
import {
  isMineruEnabled,
  getMineruApiKey,
  getMineruLocalApiBase,
  getMineruLocalBackend,
  getMineruMode,
  type MineruLocalBackend,
  type MineruMode,
  normalizeMineruLocalBackend,
  setMineruEnabled,
  setMineruApiKey,
  setMineruLocalApiBase,
  setMineruLocalBackend,
  setMineruMode,
  isGlobalAutoParseEnabled,
  setGlobalAutoParseEnabled,
  isMineruSyncEnabled,
  setMineruSyncEnabled,
  getMineruExcludePatterns,
  setMineruExcludePatterns,
} from "../utils/mineruConfig";
import {
  getNotesDirectoryPath,
  setNotesDirectoryPath,
  getNotesDirectoryFolder,
  setNotesDirectoryFolder,
  getNotesDirectoryAttachmentsFolder,
  setNotesDirectoryAttachmentsFolder,
  getNotesDirectoryNickname,
  setNotesDirectoryNickname,
} from "../utils/notesDirectoryConfig";
import {
  testMineruConnection,
  testMineruLocalConnection,
  testProxyConnection,
} from "../utils/mineruClient";
import { registerMineruManagerScript } from "./mineruManagerScript";
import {
  cleanSyncedMineruPackages,
  repairMineruSyncPackages,
} from "./contextPanel/mineruSync";
import { getRuntimePlatformInfo } from "../utils/runtimePlatform";
import {
  getClaudeAutoCompactThresholdPercent,
  getClaudeBridgeUrl,
  getClaudeConfigSourcePref,
  getClaudeManagedInstructionTemplatePref,
  getClaudePermissionModePref,
  getClaudeReasoningModePref,
  getClaudeRuntimeModelPref,
  isClaudeAutoCompactEnabled,
  isClaudeBlockStreamingEnabled,
  getConversationSystemPref,
  getLastUsedClaudeGlobalConversationKey,
  getLastUsedClaudePaperConversationKey,
  isClaudeCodeModeEnabled,
  setClaudeAutoCompactEnabled,
  setClaudeAutoCompactThresholdPercent,
  setClaudeBridgeUrl,
  setClaudeCodeModeEnabled,
  setClaudeManagedInstructionTemplatePref,
  setConversationSystemPref,
  setClaudePermissionModePref,
  setClaudeReasoningModePref,
  setClaudeRuntimeModelPref,
  setClaudeBlockStreamingEnabled,
} from "../claudeCode/prefs";
import {
  getCodexReasoningModePref,
  getCodexRuntimeModelPref,
  isCodexZoteroMcpToolsEnabled,
  isCodexAppServerModeEnabled,
  setCodexAppServerModeEnabled,
  setCodexZoteroMcpToolsEnabled,
  setCodexReasoningModePref,
  setCodexRuntimeModelPref,
} from "../codexAppServer/prefs";
import {
  installOrUpdateCodexZoteroMcpConfig,
  readCodexNativeMcpSetupStatus,
} from "../codexAppServer/mcpSetup";
import type { CodexReasoningMode } from "../codexAppServer/constants";
import { getClaudeProfileSignature } from "../claudeCode/projectSkills";
import {
  getDefaultClaudeManagedInstructionBlock,
  readClaudeProjectManagedInstructionBlock,
  updateClaudeProjectManagedInstructionBlock,
} from "../claudeCode/bootstrap";

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
const LEGACY_CODEX_AUTH_HELPER_TEXT =
  "Legacy direct ChatGPT/Codex backend mode. Existing users can keep using it in this release. New users should use Codex App Server. Planned for deprecation in a future release after app-server validation.";
const CODEX_APP_SERVER_HELPER_TEXT =
  "Recommended official Codex integration. Runs the local `codex app-server` CLI as the native Codex runtime. Run `codex login` first.";
const LEGACY_CODEX_API_HELPER_TEXT =
  "Legacy direct backend URL. Usually uses https://chatgpt.com/backend-api/codex/responses. Existing users can keep it in this release, but new users should use Codex App Server. Planned for deprecation in a future release after app-server validation.";
const CODEX_APP_SERVER_PROTOCOL_HELPER_TEXT =
  "Uses Codex responses with the local codex app-server transport.";
const CODEX_APP_SERVER_PATH_HELPER_TEXT_WINDOWS =
  "Optional. Leave blank to auto-detect native Windows Codex. WSL Codex is not supported because Zotero MCP uses Windows-local loopback. Or enter a native path such as C:\\nvm4w\\nodejs\\codex.cmd or C:\\Users\\<user>\\AppData\\Roaming\\npm\\codex.cmd.";
const CODEX_APP_SERVER_PATH_HELPER_TEXT_MACOS =
  "Optional. Leave blank to auto-detect. Or enter an absolute path such as /opt/homebrew/bin/codex or /usr/local/bin/codex.";
const CODEX_APP_SERVER_PATH_HELPER_TEXT_LINUX =
  "Optional. Leave blank to auto-detect. Or enter an absolute path such as /usr/local/bin/codex or ~/.local/bin/codex.";

function getCodexAppServerPathHelperText(): string {
  const platform = getRuntimePlatformInfo().platform;
  if (platform === "windows") return CODEX_APP_SERVER_PATH_HELPER_TEXT_WINDOWS;
  if (platform === "macos") return CODEX_APP_SERVER_PATH_HELPER_TEXT_MACOS;
  return CODEX_APP_SERVER_PATH_HELPER_TEXT_LINUX;
}
const LEGACY_CODEX_AUTH_PROTOCOL_HELPER_TEXT =
  "Uses Codex responses with the legacy direct backend transport.";
const COPILOT_API_HELPER_TEXT =
  "GitHub Copilot uses device-based login. Click Login to authenticate via GitHub.";
const DEFAULT_COPILOT_API_BASE = "https://api.githubcopilot.com";
const MAX_PROVIDER_COUNT = 10;
const INITIAL_PROVIDER_COUNT = 4;
const DEFAULT_CODEX_API_BASE =
  "https://chatgpt.com/backend-api/codex/responses";

type ProviderProfile = {
  label: string;
  modelPlaceholder: string;
  defaultModel: string;
};

const PROVIDER_PROFILES: ProviderProfile[] = [
  {
    label: "Provider A",
    modelPlaceholder: "gpt-4o-mini",
    defaultModel: "gpt-4o-mini",
  },
  { label: "Provider B", modelPlaceholder: "gpt-4o", defaultModel: "" },
  { label: "Provider C", modelPlaceholder: "gemini-2.5-pro", defaultModel: "" },
  {
    label: "Provider D",
    modelPlaceholder: "deepseek-v4-flash",
    defaultModel: "",
  },
];

function getProviderProfile(index: number): ProviderProfile {
  if (index < PROVIDER_PROFILES.length) {
    const p = PROVIDER_PROFILES[index];
    return { ...p, label: t(p.label) };
  }
  const letter = String.fromCharCode("A".charCodeAt(0) + index);
  return {
    label: t(`Provider ${letter}`),
    modelPlaceholder: "",
    defaultModel: "",
  };
}

type AgentPermissionMode = "safe" | "yolo";

function normalizeAgentPermissionMode(value: unknown): AgentPermissionMode {
  return value === "yolo" ? "yolo" : "safe";
}

const DEFAULT_AGENT_BRIDGE_URL = "http://127.0.0.1:19787";

function normalizeProviderPresetId(value: unknown): ProviderPresetId {
  if (typeof value !== "string") return "customized";
  return value === "customized" ||
    PROVIDER_PRESETS.some((preset) => preset.id === value)
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
  if (authMode === "webchat") return ["web_sync"]; // [webchat]
  if (authMode === "codex_auth" || authMode === "codex_app_server")
    return ["codex_responses"];
  if (authMode === "copilot_auth")
    return ["openai_chat_compat", "responses_api"];
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
    group.authMode === "codex_auth" || group.authMode === "codex_app_server"
      ? "codex_responses"
      : presetId === "customized"
        ? undefined
        : getProviderPreset(presetId).defaultProtocol;
  const allowed = getProtocolOptions(group.authMode, presetId);
  const shouldInferCustomizedProtocol =
    presetId === "customized" &&
    group.providerProtocol === "openai_chat_compat";
  const normalized = normalizeProviderProtocolForAuthMode({
    protocol: shouldInferCustomizedProtocol ? undefined : group.providerProtocol,
    authMode: group.authMode,
    apiBase: group.apiBase,
    ...(fallback ? { fallback } : {}),
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

function iconBtn(
  doc: Document,
  label: string,
  title: string,
): HTMLButtonElement {
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
  if (value === "webchat") return "webchat"; // [webchat]
  if (value === "codex_auth") return "codex_auth";
  if (value === "codex_app_server") return "codex_app_server";
  if (value === "copilot_auth") return "copilot_auth";
  return "api_key";
}

type ProcessLike = { env?: Record<string, string | undefined> };
type PathUtilsLike = {
  homeDir?: string;
  join?: (...parts: string[]) => string;
};
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
  const components = (
    globalThis as {
      Components?: { interfaces?: { nsIFile?: unknown } };
    }
  ).Components;
  return components?.interfaces?.nsIFile;
}

function resolveCodexAuthPath(): string {
  const env = getProcess()?.env;
  const codexHome = env?.CODEX_HOME?.trim();
  if (codexHome) return joinLocalPath(codexHome, "auth.json");
  const home =
    env?.HOME?.trim() ||
    env?.USERPROFILE?.trim() ||
    getPathUtils()?.homeDir?.trim() ||
    getOS()?.Constants?.Path?.homeDir?.trim() ||
    getServices()?.dirsvc?.get?.("Home", getNsIFile())?.path?.trim() ||
    (Zotero as unknown as { Profile?: { dir?: string } }).Profile?.dir?.trim();
  if (!home) throw new Error("Unable to resolve home directory for codex auth");
  return joinLocalPath(home, ".codex", "auth.json");
}

async function readCodexAccessToken(): Promise<string> {
  const authPath = resolveCodexAuthPath();
  const io = ztoolkit.getGlobal("IOUtils") as
    | { read?: (path: string) => Promise<Uint8Array<ArrayBufferLike> | ArrayBuffer> }
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
    throw new Error(
      "No access token found in ~/.codex/auth.json. Run `codex login` first.",
    );
  }
  return token;
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

const PROTOCOL_SELECT_SM_STYLE = INPUT_SM_STYLE + " width: 135px;";

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

async function confirmMineruSyncPackageDeletion(
  disableSync: boolean,
): Promise<boolean> {
  const dialogData: { [key: string]: unknown } = {
    loadCallback: () => {
      return;
    },
    unloadCallback: () => {
      return;
    },
  };
  const message = disableSync
    ? t(
        "Synced MinerU ZIP packages are Zotero attachment items. MinerU sync will be disabled, then those package attachments will be deleted. Zotero may show sync conflicts while it syncs these deletions. If that happens, choose the local/deleted version to remove already-uploaded packages from Zotero sync.",
      )
    : t(
        "Synced MinerU ZIP packages are Zotero attachment items. Those package attachments will be deleted. Zotero may show sync conflicts while it syncs these deletions. If that happens, choose the local/deleted version to remove already-uploaded packages from Zotero sync.",
      );

  new ztoolkit.Dialog(1, 1)
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      properties: { textContent: message },
      styles: {
        width: "420px",
        lineHeight: "1.45",
        whiteSpace: "pre-line",
      },
    })
    .addButton(
      t(disableSync ? "Disable sync and delete" : "Delete packages"),
      "delete",
    )
    .addButton(t("Cancel"), "cancel")
    .setDialogData(dialogData)
    .open(t("Delete MinerU sync packages?"));
  await (dialogData as { unloadLock: { promise: Promise<void> } }).unloadLock
    .promise;
  return (dialogData as { _lastButtonId?: string })._lastButtonId === "delete";
}

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
    const elements = container.querySelectorAll("label, span, div, summary, option");
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i] as HTMLElement;
      // For option elements (simple text)
      if (el.tagName.toLowerCase() === "option") {
        const text = normalizeWs(el.textContent || "");
        if (text) {
          const translated = t(text);
          if (translated !== text) {
            el.textContent = translated;
          }
        }
        continue;
      }
      // For labels with inputs, translate the text node after the input
      if (el.tagName.toLowerCase() === "label" && el.querySelector("input")) {
        for (const child of Array.from(el.childNodes)) {
          if (
            child &&
            child.nodeType === 3 /* TEXT_NODE */ &&
            child.textContent &&
            child.textContent.trim()
          ) {
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
        if (
          child &&
          child.nodeType === 3 /* TEXT_NODE */ &&
          child.textContent &&
          child.textContent.trim()
        ) {
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
  const systemPrompt = doc.querySelector(
    `#${config.addonRef}-system-prompt`,
  ) as HTMLTextAreaElement | null;
  if (systemPrompt?.placeholder) {
    systemPrompt.placeholder = t(systemPrompt.placeholder);
  }
  const mineruApiKeyEl = doc.querySelector(
    `#${config.addonRef}-mineru-api-key`,
  ) as HTMLInputElement | null;
  if (mineruApiKeyEl?.placeholder) {
    mineruApiKeyEl.placeholder = t(mineruApiKeyEl.placeholder);
  }
  const mineruLocalApiBaseEl = doc.querySelector(
    `#${config.addonRef}-mineru-local-api-base`,
  ) as HTMLInputElement | null;
  if (mineruLocalApiBaseEl?.placeholder) {
    mineruLocalApiBaseEl.placeholder = t(mineruLocalApiBaseEl.placeholder);
  }
  // Translate language dropdown options
  const localeSelectEl = doc.querySelector(
    `#${config.addonRef}-locale-select`,
  ) as HTMLSelectElement | null;
  if (localeSelectEl) {
    const autoOption = localeSelectEl.querySelector(
      'option[value="auto"]',
    ) as HTMLOptionElement | null;
    if (autoOption) autoOption.textContent = t("Auto (follow Zotero)");
    const enOption = localeSelectEl.querySelector(
      'option[value="en-US"]',
    ) as HTMLOptionElement | null;
    if (enOption) enOption.textContent = t("English");
    const zhOption = localeSelectEl.querySelector(
      'option[value="zh-CN"]',
    ) as HTMLOptionElement | null;
    if (zhOption) zhOption.textContent = t("中文 (简体)");
  }
  // Translate restart hint
  const restartHint = doc.querySelector(
    `#${config.addonRef}-locale-restart-hint`,
  ) as HTMLElement | null;
  if (restartHint)
    restartHint.textContent = t("Restart Zotero to apply language change.");

  // Translate Codex App Server and Claude Code buttons and inputs
  const codexTestBtn = doc.querySelector(
    `#${config.addonRef}-codex-app-server-test`,
  ) as HTMLButtonElement | null;
  if (codexTestBtn) {
    codexTestBtn.textContent = t("Test connection");
  }
  const codexMcpSetupBtn = doc.querySelector(
    `#${config.addonRef}-codex-app-server-mcp-setup`,
  ) as HTMLButtonElement | null;
  if (codexMcpSetupBtn) {
    codexMcpSetupBtn.textContent = t("Install/update Zotero MCP config");
  }
  const codexModelInput = doc.querySelector(
    `#${config.addonRef}-codex-app-server-model`,
  ) as HTMLInputElement | null;
  if (codexModelInput?.placeholder) {
    codexModelInput.placeholder = t(codexModelInput.placeholder);
  }
  const agentBridgeUrlInputLocal = doc.querySelector(
    `#${config.addonRef}-agent-bridge-url`,
  ) as HTMLInputElement | null;
  if (agentBridgeUrlInputLocal?.placeholder) {
    agentBridgeUrlInputLocal.placeholder = t(agentBridgeUrlInputLocal.placeholder);
  }

  // Translate Agent Mode (Beta) section
  const agentModeLabel = Array.from(doc.querySelectorAll('label') as unknown as HTMLElement[]).find(
    (el: HTMLElement) => el.textContent?.includes('Enable Agent Mode')
  ) as HTMLElement | null;
  if (agentModeLabel) {
    agentModeLabel.textContent = t('Enable Agent Mode (Beta)');
  }
  const agentModeHint = Array.from(doc.querySelectorAll('span') as unknown as HTMLElement[]).find(
    (el: HTMLElement) => el.textContent?.includes('Shows the "Agent (beta)" toggle')
  ) as HTMLElement | null;
  if (agentModeHint) {
    agentModeHint.textContent = t('Shows the "Agent (beta)" toggle in the context bar, enabling the agentic multi-step assistant. Off by default — enable only if you want to experiment with the beta feature.');
  }

  // Translate Codex App Server section
  const codexAppServerTitle = Array.from(doc.querySelectorAll('span') as unknown as HTMLElement[]).find(
    (el: HTMLElement) => el.textContent?.trim() === 'Codex App Server'
  ) as HTMLElement | null;
  // (Keep Codex App Server as is - brand name)
  const codexAppServerDesc = Array.from(doc.querySelectorAll('span') as unknown as HTMLElement[]).find(
    (el: HTMLElement) => el.textContent?.includes('First-class Codex runtime integration')
  ) as HTMLElement | null;
  if (codexAppServerDesc) {
    codexAppServerDesc.textContent = t('First-class Codex runtime integration. Run codex login before enabling it; Zotero keeps local tool approvals in its own confirmation cards.');
  }
  const codexAppServerEnableLabel = Array.from(doc.querySelectorAll('label') as unknown as HTMLElement[]).find(
    (el: HTMLElement) => el.textContent?.includes('Enable Codex App Server integration')
  ) as HTMLElement | null;
  if (codexAppServerEnableLabel) {
    codexAppServerEnableLabel.textContent = t('Enable Codex App Server integration');
  }
  const codexAppServerEnableDesc = Array.from(doc.querySelectorAll('span') as unknown as HTMLElement[]).find(
    (el: HTMLElement) => el.textContent?.includes('When enabled, Zotero shows the Codex button')
  ) as HTMLElement | null;
  if (codexAppServerEnableDesc) {
    codexAppServerEnableDesc.textContent = t('When enabled, Zotero shows the Codex button in the chat header so you can switch between upstream chat and Codex.');
  }
  // codexAppServerEnableSelect is declared later, so translate it there or later

  const codexAppServerRuntimeDefaults = Array.from(doc.querySelectorAll('span') as unknown as HTMLElement[]).find(
    (el: HTMLElement) => el.textContent?.trim() === 'Runtime defaults'
  ) as HTMLElement | null;
  if (codexAppServerRuntimeDefaults) {
    codexAppServerRuntimeDefaults.textContent = t('Runtime defaults');
  }
  const codexAppServerRuntimeDesc = Array.from(doc.querySelectorAll('span') as unknown as HTMLElement[]).find(
    (el: HTMLElement) => el.textContent?.includes('These values control how Codex runs')
  ) as HTMLElement | null;
  if (codexAppServerRuntimeDesc) {
    codexAppServerRuntimeDesc.textContent = t('These values control how Codex runs inside Zotero by default.');
  }
  const codexAppServerModelLabel = Array.from(doc.querySelectorAll('label') as unknown as HTMLElement[]).find(
    (el: HTMLElement) => el.textContent?.trim() === 'Model'
  ) as HTMLElement | null;
  if (codexAppServerModelLabel) {
    codexAppServerModelLabel.textContent = t('Model');
  }
  const codexAppServerReasoningLabel = Array.from(doc.querySelectorAll('label') as unknown as HTMLElement[]).find(
    (el: HTMLElement) => el.textContent?.trim() === 'Reasoning'
  ) as HTMLElement | null;
  if (codexAppServerReasoningLabel) {
    codexAppServerReasoningLabel.textContent = t('Reasoning');
  }

  // Translate Notes Directory description
  const notesDirectoryDesc = Array.from(doc.querySelectorAll('span') as unknown as HTMLElement[]).find(
    (el: HTMLElement) => el.textContent?.includes('Configure a local directory for saving notes')
  ) as HTMLElement | null;
  if (notesDirectoryDesc) {
    notesDirectoryDesc.textContent = t('Configure a local directory for saving notes as files. Note format and templates are managed through skills — type `/` in chat to see available skills, or edit skill files directly.');
  }

  // Translate Test Write Access button
  const testWriteAccessBtn = Array.from(doc.querySelectorAll('button') as unknown as HTMLButtonElement[]).find(
    (el: HTMLButtonElement) => el.textContent?.trim() === 'Test Write Access'
  ) as HTMLButtonElement | null;
  if (testWriteAccessBtn) {
    testWriteAccessBtn.textContent = t('Test Write Access');
  }

  // Translate Sync existing MinerU caches now button
  const syncMinerUCachesBtn = Array.from(doc.querySelectorAll('button') as unknown as HTMLButtonElement[]).find(
    (el: HTMLButtonElement) => el.textContent?.trim() === 'Sync existing MinerU caches now'
  ) as HTMLButtonElement | null;
  if (syncMinerUCachesBtn) {
    syncMinerUCachesBtn.textContent = t('Sync existing MinerU caches now');
  }

  // ── Tab bar switching ───────────────────────────────────────────
  const tabBar = doc.querySelector(
    `#${config.addonRef}-pref-tab-bar`,
  ) as HTMLElement | null;
  if (tabBar) {
    const switchTab = (tabId: string) => {
      // Hide all panels
      const panels = doc.querySelectorAll("[data-pref-panel]");
      for (let i = 0; i < panels.length; i++) {
        (panels[i] as HTMLElement).style.display = "none";
      }
      // Show target panel
      const target = doc.querySelector(
        `[data-pref-panel="${tabId}"]`,
      ) as HTMLElement | null;
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
  const codexAppServerEnableSelect = doc.querySelector(
    `#${config.addonRef}-codex-app-server-enable`,
  ) as HTMLSelectElement | null;
  // Translate Codex App Server enable select options
  if (codexAppServerEnableSelect) {
    const offOption = codexAppServerEnableSelect.querySelector('option[value="disabled"]');
    if (offOption) offOption.textContent = t('Off');
    const onOption = codexAppServerEnableSelect.querySelector('option[value="enabled"]');
    if (onOption) onOption.textContent = t('On');
  }
  const codexAppServerSettingsWrap = doc.querySelector(
    `#${config.addonRef}-codex-app-server-settings`,
  ) as HTMLDivElement | null;
  const codexAppServerModelInput = doc.querySelector(
    `#${config.addonRef}-codex-app-server-model`,
  ) as HTMLInputElement | null;
  const codexAppServerReasoningSelect = doc.querySelector(
    `#${config.addonRef}-codex-app-server-reasoning`,
  ) as HTMLSelectElement | null;
  // Translate Codex App Server reasoning select options
  if (codexAppServerReasoningSelect) {
    const autoOpt = codexAppServerReasoningSelect.querySelector('option[value="auto"]');
    if (autoOpt) autoOpt.textContent = t('Auto');
    const lowOpt = codexAppServerReasoningSelect.querySelector('option[value="low"]');
    if (lowOpt) lowOpt.textContent = t('Low');
    const medOpt = codexAppServerReasoningSelect.querySelector('option[value="medium"]');
    if (medOpt) medOpt.textContent = t('Medium');
    const highOpt = codexAppServerReasoningSelect.querySelector('option[value="high"]');
    if (highOpt) highOpt.textContent = t('High');
    const xhighOpt = codexAppServerReasoningSelect.querySelector('option[value="xhigh"]');
    if (xhighOpt) xhighOpt.textContent = t('XHigh');
  }
  const codexAppServerTestBtn = doc.querySelector(
    `#${config.addonRef}-codex-app-server-test`,
  ) as HTMLButtonElement | null;
  const codexAppServerStatus = doc.querySelector(
    `#${config.addonRef}-codex-app-server-status`,
  ) as HTMLSpanElement | null;
  const codexAppServerMcpEnableInput = doc.querySelector(
    `#${config.addonRef}-codex-app-server-mcp-enable`,
  ) as HTMLInputElement | null;
  const codexAppServerMcpSetupBtn = doc.querySelector(
    `#${config.addonRef}-codex-app-server-mcp-setup`,
  ) as HTMLButtonElement | null;
  const codexAppServerMcpStatus = doc.querySelector(
    `#${config.addonRef}-codex-app-server-mcp-status`,
  ) as HTMLSpanElement | null;

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
    while (result.length < INITIAL_PROVIDER_COUNT)
      result.push(createEmptyProviderGroup());
    return result;
  })();

  // Mutable reference so input listeners inside rerender can update the
  // "Add Provider" button state without triggering a full rerender.
  let syncAddProviderBtn: () => void = () => undefined;

  // ── Render ────────────────────────────────────────────────────────

  const rerender = () => {
    modelSections.innerHTML = "";

    const wrap = el(
      doc,
      "div",
      "display: flex; flex-direction: column; gap: 10px;",
    );

    // Section heading
    const headingLeft = el(
      doc,
      "div",
      "display: flex; flex-direction: column; gap: 2px; margin-bottom: 2px;",
    );
    headingLeft.append(
      el(
        doc,
        "span",
        "font-size: 14px; font-weight: 800; color: var(--fill-primary, inherit);",
        t("AI Providers"),
      ),
      el(
        doc,
        "span",
        "font-size: 11.5px; color: var(--fill-secondary, #888);",
        t(
          "Each provider has an auth mode, API URL, and one or more model variants.",
        ),
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
      const authModeWrap = el(
        doc,
        "div",
        "display: flex; flex-direction: column;",
      );
      const authModeLabel = el(doc, "label", LABEL_STYLE, t("Auth Mode"));
      const authModeSelect = el(
        doc,
        "select",
        INPUT_STYLE,
      ) as HTMLSelectElement;
      authModeSelect.id = `${config.addonRef}-auth-mode-${group.id}`;
      authModeLabel.setAttribute("for", authModeSelect.id);
      const apiKeyOption = el(doc, "option") as HTMLOptionElement;
      apiKeyOption.value = "api_key";
      apiKeyOption.textContent = t("API Key");
      apiKeyOption.selected = group.authMode === "api_key";
      const codexAppServerOption = el(doc, "option") as HTMLOptionElement;
      codexAppServerOption.value = "codex_app_server";
      codexAppServerOption.textContent = t("Codex App Server (native runtime settings)");
      codexAppServerOption.selected = group.authMode === "codex_app_server";
      const codexOption = el(doc, "option") as HTMLOptionElement;
      codexOption.value = "codex_auth";
      codexOption.textContent = t("Codex Auth (Legacy)");
      codexOption.selected = group.authMode === "codex_auth";
      const copilotOption = el(doc, "option") as HTMLOptionElement;
      copilotOption.value = "copilot_auth";
      copilotOption.textContent = t("GitHub Copilot");
      copilotOption.selected = group.authMode === "copilot_auth";
      // [webchat] Add webchat option
      const webchatOption = el(doc, "option") as HTMLOptionElement;
      webchatOption.value = "webchat";
      webchatOption.textContent = t("WebChat");
      webchatOption.selected = group.authMode === "webchat";
      authModeSelect.append(apiKeyOption);
      if (group.authMode === "codex_app_server") {
        authModeSelect.append(codexAppServerOption);
      }
      authModeSelect.append(codexOption, copilotOption, webchatOption);
      authModeSelect.addEventListener("change", () => {
        const previousAuthMode = group.authMode;
        const nextAuthMode = normalizeAuthMode(authModeSelect.value);
        group.authMode = nextAuthMode;
        group.apiBase = migrateApiBaseForAuthModeChange(
          previousAuthMode,
          nextAuthMode,
          group.apiBase,
        );
        if (nextAuthMode === "webchat") {
          group.providerProtocol = "web_sync";
          // Set default webchat model to chatgpt.com (user can change it)
          const webchatModelNames: string[] = WEBCHAT_TARGETS.map(
            (wt) => wt.modelName,
          );
          if (
            !group.models[0]?.model ||
            !webchatModelNames.includes(group.models[0].model)
          ) {
            group.models = [{ ...group.models[0], model: "chatgpt.com" }];
          }
        } else if (
          nextAuthMode === "codex_auth" ||
          nextAuthMode === "codex_app_server"
        ) {
          group.providerProtocol = "codex_responses";
        } else if (nextAuthMode === "copilot_auth") {
          group.providerProtocol = "openai_chat_compat";
        } else if (
          group.providerProtocol === "codex_responses" ||
          group.providerProtocol === "web_sync"
        ) {
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
        group.authMode === "webchat"
          ? t(
              `Relay questions to ${WEBCHAT_TARGETS.map((wt) => wt.label).join(" / ")} via the Sync for Zotero browser extension. ` +
                "Download extension: github.com/yilewang/sync-for-zotero → Releases. " +
                'Unzip, open chrome://extensions, enable Developer Mode, click "Load unpacked", select the extension folder. ' +
                "Keep the corresponding chat tab open while using WebChat mode.",
            )
          : group.authMode === "copilot_auth"
            ? t(COPILOT_API_HELPER_TEXT)
            : group.authMode === "codex_auth"
              ? t(LEGACY_CODEX_AUTH_HELPER_TEXT)
              : group.authMode === "codex_app_server"
                ? t(CODEX_APP_SERVER_HELPER_TEXT)
                : "";
      authModeWrap.append(
        authModeLabel,
        authModeSelect,
        el(doc, "span", HELPER_STYLE, authModeHelperText),
      );

      const selectedPresetId: ProviderPresetId =
        group.authMode === "codex_auth" ||
        group.authMode === "codex_app_server" ||
        group.authMode === "copilot_auth"
          ? "customized"
          : (group.presetIdOverride ?? detectProviderPreset(group.apiBase));
      const selectedPreset =
        selectedPresetId === "customized"
          ? null
          : getProviderPreset(selectedPresetId);
      const isCustomizedPreset =
        group.authMode !== "codex_auth" &&
        group.authMode !== "codex_app_server" &&
        group.authMode !== "copilot_auth" &&
        selectedPresetId === "customized";
      group.providerProtocol = resolveSelectedProtocol(group, selectedPresetId);

      // ── Provider preset ─────────────────────────────────────────
      const providerPresetWrap = el(
        doc,
        "div",
        "display: flex; flex-direction: column;",
      );
      if (
        group.authMode !== "codex_auth" &&
        group.authMode !== "codex_app_server" &&
        group.authMode !== "copilot_auth"
      ) {
        const providerPresetLabel = el(
          doc,
          "label",
          LABEL_STYLE,
          t("Provider"),
        );
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
          option.selected = preset.id === selectedPresetId;
          providerPresetSelect.appendChild(option);
        }
        const customizedOption = el(doc, "option") as HTMLOptionElement;
        customizedOption.value = "customized";
        customizedOption.textContent = t("Customized");
        customizedOption.selected = selectedPresetId === "customized";
        providerPresetSelect.appendChild(customizedOption);
        providerPresetSelect.addEventListener("change", () => {
          const nextPresetId = normalizeProviderPresetId(
            providerPresetSelect.value,
          );
          if (nextPresetId === "customized") {
            group.presetIdOverride = "customized";
            // Keep existing apiBase so user can edit it
          } else {
            group.presetIdOverride = undefined;
            group.apiBase = getProviderPreset(nextPresetId).defaultApiBase;
            group.providerProtocol =
              getProviderPreset(nextPresetId).defaultProtocol;
          }
          persistGroups(groups);
          // Defer rerender so the browser can close the dropdown before we replace the DOM
          // (avoids "this.element is null" in Firefox's SelectChild.sys.mjs)
          setTimeout(() => rerender(), 0);
        });

        providerPresetWrap.append(providerPresetLabel, providerPresetSelect);
      }

      // ── API URL ──────────────────────────────────────────────────
      const apiUrlWrap = el(
        doc,
        "div",
        "display: flex; flex-direction: column;",
      );
      const apiUrlLabel = el(
        doc,
        "label",
        LABEL_STYLE,
        group.authMode === "codex_app_server"
          ? t("Codex CLI Path")
          : t("API URL"),
      );
      const apiUrlInput = el(doc, "input", INPUT_STYLE) as HTMLInputElement;
      apiUrlInput.id = `${config.addonRef}-api-base-${group.id}`;
      apiUrlLabel.setAttribute("for", apiUrlInput.id);
      apiUrlInput.type = "text";
      apiUrlInput.placeholder =
        group.authMode === "codex_auth"
          ? DEFAULT_CODEX_API_BASE
          : group.authMode === "codex_app_server"
            ? "Optional absolute path to codex executable"
            : group.authMode === "copilot_auth"
              ? DEFAULT_COPILOT_API_BASE
              : selectedPreset?.defaultApiBase || "https://api.openai.com/v1";
      apiUrlInput.value = group.apiBase;
      apiUrlInput.readOnly =
        group.authMode !== "codex_auth" &&
        group.authMode !== "codex_app_server" &&
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
          ? t(LEGACY_CODEX_API_HELPER_TEXT)
          : group.authMode === "codex_app_server"
            ? t(getCodexAppServerPathHelperText())
            : group.authMode === "copilot_auth"
              ? t(COPILOT_API_HELPER_TEXT)
              : getPresetSelectHelperText(selectedPresetId),
      );
      apiUrlWrap.append(apiUrlLabel, apiUrlInput, apiUrlHelper);

      // ── API Key ──────────────────────────────────────────────────
      const apiKeyWrap = el(
        doc,
        "div",
        "display: flex; flex-direction: column;",
      );
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
      if (
        group.authMode === "codex_auth" ||
        group.authMode === "codex_app_server" ||
        group.authMode === "copilot_auth"
      ) {
        apiKeyWrap.style.display = "none";
      }

      // ── Copilot Login ────────────────────────────────────────────
      const copilotLoginWrap = el(
        doc,
        "div",
        "display: flex; flex-direction: column; gap: 6px;",
      );
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
          (ztoolkit.getGlobal("AbortController") as
            | (new () => AbortController)
            | undefined) ||
          (
            globalThis as typeof globalThis & {
              AbortController?: new () => AbortController;
            }
          ).AbortController;
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
              try {
                dialogOverlay.remove();
              } catch (_e) {
                /* ignore */
              }
            });
            dialogBox.appendChild(closeBtn);
            dialogBox.appendChild(
              el(
                doc,
                "div",
                "font-size: 15px; font-weight: 600;",
                t("Enter this code on GitHub:"),
              ),
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
                      classes?: Record<
                        string,
                        {
                          getService?: (iface: unknown) => {
                            kSuppressClearClipboard?: unknown;
                            copyString?: (text: string, ctx?: unknown) => void;
                          };
                        }
                      >;
                      interfaces?: Record<string, unknown>;
                    };
                  }
                ).Components;
                const svc = clipHelper?.classes?.[
                  "@mozilla.org/widget/clipboardhelper;1"
                ]?.getService?.(clipHelper?.interfaces?.nsIClipboardHelper);
                if (svc?.copyString) {
                  svc.copyString(device.user_code, svc.kSuppressClearClipboard);
                }
              } catch (_e) {
                /* ignore */
              }
              try {
                const launch = (
                  Zotero as unknown as { launchURL?: (url: string) => void }
                ).launchURL;
                if (typeof launch === "function")
                  launch(device.verification_uri);
              } catch (_e) {
                /* ignore */
              }
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
                try {
                  dialogOverlay.remove();
                } catch (_e) {
                  /* ignore */
                }
              }
            });
            dialogOverlay.appendChild(dialogBox);
            const dialogParent = doc.body ?? doc.documentElement;
            if (dialogParent) dialogParent.appendChild(dialogOverlay);

            // Also open browser automatically
            try {
              const launch = (
                Zotero as unknown as { launchURL?: (url: string) => void }
              ).launchURL;
              if (typeof launch === "function") launch(device.verification_uri);
            } catch (_err) {
              /* ignore */
            }

            let dialogDismissed = false;
            const dismissDialog = (msg?: string, color?: string) => {
              if (dialogDismissed) return;
              dialogDismissed = true;
              try {
                dialogOverlay.remove();
              } catch (_e) {
                /* ignore */
              }
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

        const copilotBtnRow = el(
          doc,
          "div",
          "display: flex; gap: 8px; align-items: center;",
        );
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
                existing
                  ? {
                      temperature: existing.temperature,
                      maxTokens: existing.maxTokens,
                      inputTokenCap: existing.inputTokenCap,
                    }
                  : undefined,
                m.protocol,
              );
            });
            persistGroups(groups);
            fetchModelsStatus.textContent = t("Synced %n models").replace(
              "%n",
              String(models.length),
            );
            fetchModelsStatus.style.color = "green";
            setTimeout(() => rerender(), 300);
          } catch (err) {
            fetchModelsStatus.textContent = `✗ ${(err as Error).message}`;
            fetchModelsStatus.style.color = "red";
          } finally {
            fetchModelsBtn.disabled = false;
          }
        });

        const fetchModelsRow = el(
          doc,
          "div",
          "display: flex; gap: 8px; align-items: center;",
        );
        fetchModelsRow.append(fetchModelsBtn, fetchModelsStatus);

        copilotLoginWrap.append(copilotBtnRow, copilotStatus, fetchModelsRow);
      }

      // ── Models list ──────────────────────────────────────────────
      const modelsWrap = el(
        doc,
        "div",
        "display: flex; flex-direction: column; gap: 6px;",
      );

      const modelsHeaderRow = el(
        doc,
        "div",
        "display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px;",
      );
      modelsHeaderRow.appendChild(
        el(doc, "span", SECTION_LABEL_STYLE, t("Model names")),
      );

      const addModelBtn = iconBtn(doc, "+", t("Add model"));
      addModelBtn.style.color = "var(--color-accent, #2563eb)";
      if (group.authMode === "webchat") {
        // [webchat] Replace "+" with a "Fetch Models" button that adds all webchat targets
        addModelBtn.style.display = "none";
        const fetchModelsBtn = el(
          doc,
          "button",
          OUTLINE_BTN_STYLE,
          t("Fetch Models"),
        ) as HTMLButtonElement;
        fetchModelsBtn.type = "button";
        fetchModelsBtn.style.fontSize = "11px";
        fetchModelsBtn.style.padding = "2px 8px";
        fetchModelsBtn.addEventListener("click", () => {
          const allTargets = WEBCHAT_TARGETS.map((wt) => wt.modelName);
          const existing = new Set(
            group.models.map((m: { model: string }) => m.model),
          );
          let added = false;
          for (const target of allTargets) {
            if (!existing.has(target)) {
              group.models.push(createProviderModelEntry(target));
              added = true;
            }
          }
          if (added) {
            persistGroups(groups);
            rerender();
          }
        });
        modelsHeaderRow.appendChild(fetchModelsBtn);
      }
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
        const rowWrap = el(
          doc,
          "div",
          "display: flex; flex-direction: column; gap: 0;",
        );

        // Main row: [model input] [Test] [⚙] [×?]
        const mainRow = el(
          doc,
          "div",
          "display: flex; align-items: center; gap: 5px;",
        );

        const modelInput = el(
          doc,
          "input",
          "flex: 1; min-width: 0; padding: 6px 10px; font-size: 13px;" +
            " border: 1px solid var(--stroke-secondary, #c8c8c8); border-radius: 6px;" +
            " box-sizing: border-box; background: Field; color: FieldText;",
        ) as HTMLInputElement;
        modelInput.type = "text";
        if (group.authMode !== "webchat") {
          modelInput.value = modelEntry.model;
        }
        modelInput.placeholder =
          modelIndex === 0 ? profile.modelPlaceholder : "";

        const testBtn = el(
          doc,
          "button",
          OUTLINE_BTN_STYLE,
          t("Test"),
        ) as HTMLButtonElement;
        testBtn.type = "button";

        const advGearBtn = iconBtn(doc, "⚙", t("Advanced options"));

        // [webchat] Replace text input with a dropdown for webchat model selection
        if (group.authMode === "webchat") {
          const validWebchatModels = WEBCHAT_TARGETS.map((wt) => ({
            value: wt.modelName,
            label: `${wt.modelName} (${wt.label})`,
          }));
          if (!validWebchatModels.some((m) => m.value === modelEntry.model)) {
            modelEntry.model = "chatgpt.com";
          }
          modelInput.style.display = "none";
          testBtn.style.display = "none";
          advGearBtn.style.display = "none";

          const modelSelect = el(
            doc,
            "select",
            "flex: 1; min-width: 0; padding: 6px 10px; font-size: 13px;" +
              " border: 1px solid var(--stroke-secondary, #c8c8c8); border-radius: 6px;" +
              " box-sizing: border-box; background: Field; color: FieldText;",
          ) as HTMLSelectElement;
          for (const opt of validWebchatModels) {
            const option = doc.createElement("option");
            option.value = opt.value;
            option.textContent = opt.label;
            if (opt.value === modelEntry.model) option.selected = true;
            modelSelect.appendChild(option);
          }
          modelSelect.addEventListener("change", () => {
            modelEntry.model = modelSelect.value;
            persistGroups(groups);
          });
          mainRow.append(modelInput, modelSelect);
        } else {
          mainRow.append(modelInput, testBtn, advGearBtn);
        }

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

        const makeCompactField = (
          labelText: string,
          value: string,
          placeholder: string,
        ) => {
          const fieldWrap = el(
            doc,
            "div",
            "display: flex; flex-direction: column; gap: 3px;",
          );
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
          modelEntry.inputTokenCap !== undefined
            ? `${modelEntry.inputTokenCap}`
            : "",
          "optional",
        );

        // ── Per-model protocol override ──
        const protocolFieldWrap = el(
          doc,
          "div",
          "display: flex; flex-direction: column; gap: 3px;",
        );
        const protocolFieldLabel = el(
          doc,
          "label",
          "font-size: 10.5px; font-weight: 600; color: var(--fill-primary, inherit);",
          t("API protocol override"),
        );
        const protocolFieldSelect = el(
          doc,
          "select",
          PROTOCOL_SELECT_SM_STYLE,
        ) as HTMLSelectElement;
        const autoOption = el(doc, "option") as HTMLOptionElement;
        autoOption.value = "";
        autoOption.textContent = t("auto");
        protocolFieldSelect.appendChild(autoOption);
        const allowedProtocols = getProtocolOptions(
          group.authMode,
          selectedPresetId,
        );
        for (const proto of allowedProtocols) {
          const opt = el(doc, "option") as HTMLOptionElement;
          opt.value = proto;
          opt.textContent = getProviderProtocolSpec(proto).label;
          protocolFieldSelect.appendChild(opt);
        }
        protocolFieldSelect.value = modelEntry.providerProtocol || "";
        protocolFieldWrap.append(protocolFieldLabel, protocolFieldSelect);
        if (allowedProtocols.length <= 1) {
          protocolFieldWrap.style.display = "none";
        }

        advFields.append(
          tempField.wrap,
          maxTokField.wrap,
          inputCapField.wrap,
          protocolFieldWrap,
        );
        advRow.append(
          advFields,
          el(
            doc,
            "span",
            "font-size: 10.5px; color: var(--fill-secondary, #888); margin-top: 2px; display: block;",
            t(
              "Temperature: randomness (0–2)  ·  Max tokens: output limit  ·  Input cap: context limit (optional)",
            ),
          ),
        );

        const commitAdvanced = () => {
          modelEntry.temperature = normalizeTemperature(tempField.input.value);
          modelEntry.maxTokens = normalizeMaxTokensForModel(
            maxTokField.input.value,
            modelEntry.model,
          );
          modelEntry.inputTokenCap = normalizeOptionalInputTokenCap(
            inputCapField.input.value,
          );
          modelEntry.providerProtocol = isProviderProtocol(
            protocolFieldSelect.value,
          )
            ? protocolFieldSelect.value
            : undefined;
          tempField.input.value = `${modelEntry.temperature}`;
          maxTokField.input.value = `${modelEntry.maxTokens}`;
          inputCapField.input.value =
            modelEntry.inputTokenCap !== undefined
              ? `${modelEntry.inputTokenCap}`
              : "";
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
          for (const f of [tempField, maxTokField, inputCapField])
            f.input.disabled = !hasModel;
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
            if (authMode === "codex_app_server") {
              const modelName = (
                modelEntry.model ||
                profile.defaultModel ||
                ""
              ).trim();
              const result = await runCodexAppServerConnectionTest({
                modelName,
                codexPath: group.apiBase.trim(),
              });
              statusLine.textContent =
                `${t("✓ Success — model says: ")}"${result.reply}"\n` +
                `${t("Agent capability: ")}${result.capabilityLabel}`;
              statusLine.style.color = "green";
              return;
            }
            const apiKey =
              authMode === "codex_auth"
                ? await readCodexAccessToken()
                : authMode === "copilot_auth"
                  ? await resolveCopilotAccessToken({
                      githubToken: group.apiKey.trim(),
                    })
                  : group.apiKey.trim();
            const modelName = (
              modelEntry.model ||
              profile.defaultModel ||
              "gpt-5.4"
            ).trim();
            const providerProtocol = resolveSelectedProtocol(
              group,
              selectedPresetId,
            );

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
      if (group.authMode === "webchat") {
        // [webchat] Minimal layout: only auth mode + model names (webchat target selector)
        cardBody.append(authModeWrap, divider, modelsWrap);
      } else if (group.authMode === "copilot_auth") {
        cardBody.append(
          authModeWrap,
          copilotLoginWrap,
          apiUrlWrap,
          divider,
          modelsWrap,
        );
      } else if (group.authMode === "codex_app_server") {
        cardBody.append(
          authModeWrap,
          apiUrlWrap,
          divider,
          modelsWrap,
        );
      } else if (group.authMode === "codex_auth") {
        cardBody.append(
          authModeWrap,
          apiUrlWrap,
          apiKeyWrap,
          divider,
          modelsWrap,
        );
      } else {
        cardBody.append(
          authModeWrap,
          providerPresetWrap,
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
      PRIMARY_BTN_STYLE +
        " margin-top: 2px; font-size: 12.5px; text-align: center;",
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

  const agentBackendModeSelect = doc.querySelector(
    `#${config.addonRef}-agent-backend-mode`,
  ) as HTMLSelectElement | null;
  const agentBridgeSettingsWrap = doc.querySelector(
    `#${config.addonRef}-agent-bridge-settings`,
  ) as HTMLDivElement | null;
  const agentBridgeUrlInput = doc.querySelector(
    `#${config.addonRef}-agent-bridge-url`,
  ) as HTMLInputElement | null;
  const agentClaudeConfigSourceSelect = doc.querySelector(
    `#${config.addonRef}-agent-claude-config-source`,
  ) as HTMLSelectElement | null;
  const agentPermissionModeSelect = doc.querySelector(
    `#${config.addonRef}-agent-permission-mode`,
  ) as HTMLSelectElement | null;
  const claudeConfigPathsWrap = doc.querySelector(
    `#${config.addonRef}-claude-config-paths`,
  ) as HTMLDivElement | null;
  const claudeCodeModelSelect = doc.querySelector(
    `#${config.addonRef}-claude-code-model`,
  ) as HTMLSelectElement | null;
  const claudeCodeReasoningSelect = doc.querySelector(
    `#${config.addonRef}-claude-code-reasoning`,
  ) as HTMLSelectElement | null;
  const claudeCodeBlockStreamingInput = doc.querySelector(
    `#${config.addonRef}-claude-code-block-streaming`,
  ) as HTMLInputElement | null;
  const claudeCodeAutoCompactInput = doc.querySelector(
    `#${config.addonRef}-claude-code-auto-compact`,
  ) as HTMLInputElement | null;
  const claudeCodeAutoCompactThresholdInput = doc.querySelector(
    `#${config.addonRef}-claude-code-auto-compact-threshold`,
  ) as HTMLInputElement | null;
  const claudeCodeAutoCompactThresholdValue = doc.querySelector(
    `#${config.addonRef}-claude-code-auto-compact-threshold-value`,
  ) as HTMLSpanElement | null;
  const claudeConfigDocLink = doc.querySelector(
    `#${config.addonRef}-claude-config-doc-link`,
  ) as HTMLAnchorElement | null;
  const claudeTraceEnabledInput = doc.querySelector(
    `#${config.addonRef}-claude-trace-enabled`,
  ) as HTMLInputElement | null;
  const claudeTracePathEl = doc.querySelector(
    `#${config.addonRef}-claude-trace-path`,
  ) as HTMLDivElement | null;
  const claudeTraceCopyBtn = doc.querySelector(
    `#${config.addonRef}-claude-trace-copy-path`,
  ) as HTMLButtonElement | null;
  const claudeManagedInstructionTemplateInput = doc.querySelector(
    `#${config.addonRef}-claude-managed-instruction-template`,
  ) as HTMLTextAreaElement | null;
  const claudeManagedInstructionUpdateBtn = doc.querySelector(
    `#${config.addonRef}-claude-managed-instruction-update`,
  ) as HTMLButtonElement | null;
  const claudeManagedInstructionResetBtn = doc.querySelector(
    `#${config.addonRef}-claude-managed-instruction-reset`,
  ) as HTMLButtonElement | null;
  const claudeManagedInstructionStatus = doc.querySelector(
    `#${config.addonRef}-claude-managed-instruction-status`,
  ) as HTMLSpanElement | null;

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

  if (codexAppServerEnableSelect) {
    const applyCodexAppServerUi = (enabled: boolean) => {
      codexAppServerEnableSelect.value = enabled ? "enabled" : "disabled";
      if (codexAppServerSettingsWrap) {
        codexAppServerSettingsWrap.style.display = enabled ? "flex" : "none";
      }
    };
    applyCodexAppServerUi(isCodexAppServerModeEnabled());
    codexAppServerEnableSelect.addEventListener("change", () => {
      const enabled = codexAppServerEnableSelect.value === "enabled";
      applyCodexAppServerUi(enabled);
      setCodexAppServerModeEnabled(enabled);
      if (enabled) {
        setConversationSystemPref("codex");
      } else if (getConversationSystemPref() === "codex") {
        setConversationSystemPref("upstream");
      }
    });
  }

  if (codexAppServerModelInput) {
    codexAppServerModelInput.value = getCodexRuntimeModelPref();
    const commitCodexModel = () => {
      setCodexRuntimeModelPref(codexAppServerModelInput.value);
      codexAppServerModelInput.value = getCodexRuntimeModelPref();
    };
    codexAppServerModelInput.addEventListener("change", commitCodexModel);
    codexAppServerModelInput.addEventListener("blur", commitCodexModel);
    codexAppServerModelInput.addEventListener("input", () => {
      setCodexRuntimeModelPref(codexAppServerModelInput.value);
    });
  }

  if (codexAppServerReasoningSelect) {
    codexAppServerReasoningSelect.value = getCodexReasoningModePref();
    codexAppServerReasoningSelect.addEventListener("change", () => {
      setCodexReasoningModePref(
        codexAppServerReasoningSelect.value as CodexReasoningMode,
      );
    });
  }

  if (codexAppServerTestBtn && codexAppServerStatus) {
    codexAppServerTestBtn.addEventListener("click", () => {
      void (async () => {
        codexAppServerTestBtn.disabled = true;
        codexAppServerStatus.style.display = "inline";
        codexAppServerStatus.style.color = "var(--fill-secondary, #888)";
        codexAppServerStatus.textContent = t("Testing…");
        try {
          const result = await runCodexAppServerConnectionTest({
            modelName:
              codexAppServerModelInput?.value || getCodexRuntimeModelPref(),
            codexPath: "",
          });
          codexAppServerStatus.textContent =
            `${t("✓ Success — model says: ")}"${result.reply}"`;
          codexAppServerStatus.style.color = "green";
        } catch (err) {
          codexAppServerStatus.textContent = `${t("Test failed: ")}${
            err instanceof Error ? err.message : String(err)
          }`;
          codexAppServerStatus.style.color = "red";
        } finally {
          codexAppServerTestBtn.disabled = false;
        }
      })();
    });
  }

  const renderCodexMcpStatus = (
    message: string,
    color = "var(--fill-secondary, #888)",
  ) => {
    if (!codexAppServerMcpStatus) return;
    codexAppServerMcpStatus.style.display = "inline";
    codexAppServerMcpStatus.style.color = color;
    codexAppServerMcpStatus.textContent = message;
  };

  if (codexAppServerMcpEnableInput) {
    codexAppServerMcpEnableInput.checked = isCodexZoteroMcpToolsEnabled();
    codexAppServerMcpEnableInput.addEventListener("change", () => {
      setCodexZoteroMcpToolsEnabled(codexAppServerMcpEnableInput.checked);
      renderCodexMcpStatus(
        codexAppServerMcpEnableInput.checked
          ? t("Zotero MCP tools will be configured before native Codex turns.")
          : t("Zotero MCP tools disabled for native Codex turns."),
      );
    });
  }

  if (codexAppServerMcpSetupBtn) {
    codexAppServerMcpSetupBtn.addEventListener("click", () => {
      void (async () => {
        codexAppServerMcpSetupBtn.disabled = true;
        renderCodexMcpStatus(t("Configuring Zotero MCP tools…"));
        try {
          const status = await installOrUpdateCodexZoteroMcpConfig({
            codexPath: "",
          });
          setCodexZoteroMcpToolsEnabled(true);
          if (codexAppServerMcpEnableInput) {
            codexAppServerMcpEnableInput.checked = true;
          }
          const toolCount = status.toolNames.length;
          renderCodexMcpStatus(
            toolCount > 0
              ? t(`Zotero MCP connected with ${toolCount} tools.`)
              : t("Zotero MCP config written. Codex is reloading tools."),
            "green",
          );
        } catch (error) {
          renderCodexMcpStatus(
            `${t("Zotero MCP setup failed: ")}${
              error instanceof Error ? error.message : String(error)
            }`,
            "red",
          );
        } finally {
          codexAppServerMcpSetupBtn.disabled = false;
        }
      })();
    });
  }

  if (codexAppServerMcpStatus && isCodexZoteroMcpToolsEnabled()) {
    renderCodexMcpStatus(t("Checking Zotero MCP setup…"));
    void readCodexNativeMcpSetupStatus({ codexPath: "" })
      .then((status) => {
        renderCodexMcpStatus(
          status.connected === true
            ? t(`Zotero MCP connected with ${status.toolNames.length} tools.`)
            : status.configured
              ? t("Zotero MCP configured. Use setup if tools do not appear.")
              : t("Zotero MCP tools enabled but not configured yet."),
          status.connected === true ? "green" : "var(--fill-secondary, #888)",
        );
      })
      .catch((error) => {
        renderCodexMcpStatus(
          `${t("Could not read Codex MCP status: ")}${
            error instanceof Error ? error.message : String(error)
          }`,
          "red",
        );
      });
  }

  if (agentBackendModeSelect) {
    const applyAgentBackendUi = (enabled: boolean) => {
      agentBackendModeSelect.value = enabled ? "claude_bridge" : "disabled";
      if (agentBridgeSettingsWrap) {
        agentBridgeSettingsWrap.style.display = enabled ? "flex" : "none";
      }
    };
    applyAgentBackendUi(isClaudeCodeModeEnabled());
    agentBackendModeSelect.addEventListener("change", () => {
      const enabled = agentBackendModeSelect.value === "claude_bridge";
      applyAgentBackendUi(enabled);
      setClaudeCodeModeEnabled(enabled);
      if (!enabled && getConversationSystemPref() === "claude_code") {
        setConversationSystemPref("upstream");
      }
    });
  }

  if (codexAppServerEnableSelect && agentBackendModeSelect) {
    const codexEnableCard =
      codexAppServerEnableSelect.parentElement as HTMLElement | null;
    const claudeEnableCard =
      agentBackendModeSelect.parentElement as HTMLElement | null;
    const applyDisabledStyling = (
      card: HTMLElement | null,
      select: HTMLSelectElement,
      disabled: boolean,
    ) => {
      if (card) {
        card.style.opacity = disabled ? "0.4" : "";
        card.style.cursor = disabled ? "not-allowed" : "";
      }
      select.style.cursor = disabled ? "not-allowed" : "";
    };
    const syncModeMutualExclusion = () => {
      const codexOn = codexAppServerEnableSelect.value === "enabled";
      const claudeOn = agentBackendModeSelect.value === "claude_bridge";
      const claudeShouldDisable = codexOn && !claudeOn;
      const codexShouldDisable = claudeOn && !codexOn;
      agentBackendModeSelect.disabled = claudeShouldDisable;
      codexAppServerEnableSelect.disabled = codexShouldDisable;
      agentBackendModeSelect.title = claudeShouldDisable
        ? "Disable Codex App Server first to switch on Claude Code."
        : "";
      codexAppServerEnableSelect.title = codexShouldDisable
        ? "Disable Claude Code first to switch on Codex App Server."
        : "";
      applyDisabledStyling(
        claudeEnableCard,
        agentBackendModeSelect,
        claudeShouldDisable,
      );
      applyDisabledStyling(
        codexEnableCard,
        codexAppServerEnableSelect,
        codexShouldDisable,
      );
    };
    syncModeMutualExclusion();
    codexAppServerEnableSelect.addEventListener(
      "change",
      syncModeMutualExclusion,
    );
    agentBackendModeSelect.addEventListener(
      "change",
      syncModeMutualExclusion,
    );
  }

  if (agentBridgeUrlInput) {
    agentBridgeUrlInput.value = getClaudeBridgeUrl() || DEFAULT_AGENT_BRIDGE_URL;
    const commitBridgeUrl = () => {
      setClaudeBridgeUrl(agentBridgeUrlInput.value);
    };
    agentBridgeUrlInput.addEventListener("change", commitBridgeUrl);
    agentBridgeUrlInput.addEventListener("blur", commitBridgeUrl);
  }

  const copyTextToClipboard = async (text: string) => {
    const value = text.trim();
    if (!value) return;
    const win = doc.defaultView;
    if (win?.navigator?.clipboard?.writeText) {
      try {
        await win.navigator.clipboard.writeText(value);
        return;
      } catch {
        /* ignore */
      }
    }
    try {
      const helper = (globalThis as any).Components;
      const svc = helper?.classes?.[
        "@mozilla.org/widget/clipboardhelper;1"
      ]?.getService?.(helper?.interfaces?.nsIClipboardHelper) as
        | { copyString?: (v: string) => void }
        | undefined;
      svc?.copyString?.(value);
    } catch {
      /* ignore */
    }
  };

  const ensureDirectory = async (dirPath: string) => {
    const IOUtils = (globalThis as any).IOUtils as
      | {
          exists?: (path: string) => Promise<boolean>;
          makeDirectory?: (
            path: string,
            options?: { ignoreExisting?: boolean; createAncestors?: boolean },
          ) => Promise<void>;
        }
      | undefined;
    if (IOUtils?.exists && IOUtils?.makeDirectory) {
      const exists = await IOUtils.exists(dirPath);
      if (!exists) {
        await IOUtils.makeDirectory(dirPath, {
          ignoreExisting: true,
          createAncestors: true,
        });
      }
    }
  };

  const ensureFileIfMissing = async (filePath: string, content: string) => {
    const IOUtils = (globalThis as any).IOUtils as
      | {
          exists?: (path: string) => Promise<boolean>;
          write?: (path: string, data: Uint8Array<ArrayBufferLike>) => Promise<unknown>;
        }
      | undefined;
    if (!IOUtils?.exists || !IOUtils?.write) return;
    const exists = await IOUtils.exists(filePath).catch(() => false);
    if (exists) return;
    await IOUtils.write(filePath, new TextEncoder().encode(content));
  };

  const openDirectory = async (dirPath: string) => {
    await ensureDirectory(dirPath);
    try {
      const Cc = (
        globalThis as unknown as { Components?: { classes?: Record<string, { createInstance?: (iface: unknown) => unknown }>; interfaces?: Record<string, unknown> } }
      ).Components?.classes;
      const Ci = (
        globalThis as unknown as { Components?: { interfaces?: Record<string, unknown> } }
      ).Components?.interfaces;
      if (Cc && Ci && typeof Cc["@mozilla.org/file/local;1"]?.createInstance === "function") {
        const f = Cc["@mozilla.org/file/local;1"].createInstance(
          Ci.nsIFile as unknown,
        ) as
          | { initWithPath?: (p: string) => void; reveal?: () => void }
          | undefined;
        if (f?.initWithPath) {
          f.initWithPath(dirPath);
          f.reveal?.();
          return;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      (Zotero as unknown as { launchFile?: (p: string) => void }).launchFile?.(dirPath);
    } catch {
      /* ignore */
    }
  };

  const getCurrentClaudeLocalDir = (): string => {
    const env = getProcess()?.env;
    const home =
      env?.HOME?.trim() ||
      env?.USERPROFILE?.trim() ||
      getPathUtils()?.homeDir?.trim() ||
      getOS()?.Constants?.Path?.homeDir?.trim() ||
      getServices()?.dirsvc?.get?.("Home", getNsIFile())?.path?.trim() ||
      (Zotero as unknown as { Profile?: { dir?: string } }).Profile?.dir?.trim() ||
      ".";
    const runtimeRoot = joinLocalPath(home, "Zotero", "agent-runtime", getClaudeProfileSignature());
    const scopesRoot = joinLocalPath(runtimeRoot, "scopes");
    const conversationSystem = getConversationSystemPref();
    if (conversationSystem !== "claude_code") {
      return scopesRoot;
    }
    const pane = Zotero.getMainWindow?.()?.LLMForZoteroPane;
    const paneItem = pane?.item;
    const libraryID = Number(paneItem?.libraryID);
    const itemID = Number(paneItem?.id);
    const isPaper = Number.isFinite(itemID) && itemID > 0;
    const scope = isPaper ? "paper" : "open";
    const scopeId = isPaper && Number.isFinite(libraryID) && libraryID > 0
      ? `${Math.floor(libraryID)}:${Math.floor(itemID)}`
      : `${Number.isFinite(libraryID) && libraryID > 0 ? Math.floor(libraryID) : 1}`;
    const conversationKey = isPaper && Number.isFinite(libraryID) && libraryID > 0
      ? getLastUsedClaudePaperConversationKey(Math.floor(libraryID), Math.floor(itemID))
      : Number.isFinite(libraryID) && libraryID > 0
        ? getLastUsedClaudeGlobalConversationKey(Math.floor(libraryID))
        : null;
    if (!conversationKey) {
      return joinLocalPath(scopesRoot, scope, scopeId);
    }
    return joinLocalPath(
      scopesRoot,
      scope,
      scopeId,
      "conversations",
      String(conversationKey),
      ".claude",
    );
  };

  const renderClaudeConfigPaths = () => {
    if (!claudeConfigPathsWrap) return;
    claudeConfigPathsWrap.replaceChildren();
    const env = getProcess()?.env;
    const home =
      env?.HOME?.trim() ||
      env?.USERPROFILE?.trim() ||
      getPathUtils()?.homeDir?.trim() ||
      getOS()?.Constants?.Path?.homeDir?.trim() ||
      getServices()?.dirsvc?.get?.("Home", getNsIFile())?.path?.trim() ||
      (Zotero as unknown as { Profile?: { dir?: string } }).Profile?.dir?.trim() ||
      "";
    const runtimeRoot = joinLocalPath(home || ".", "Zotero", "agent-runtime", getClaudeProfileSignature());
    const projectClaudeDir = joinLocalPath(runtimeRoot, ".claude");
    const localConversationDir = joinLocalPath(
      runtimeRoot,
      "scopes",
      "<scope>",
      "<scope-id>",
      "conversations",
      "<conversation-key>",
      ".claude",
    );
    const rows = [
      {
        label: "User",
        path: home ? joinLocalPath(home, ".claude") : "~/.claude",
        openPath: home ? joinLocalPath(home, ".claude") : "~/.claude",
        description: "Global defaults shared across Claude Code on this machine.",
      },
      {
        label: "Project",
        path: projectClaudeDir,
        openPath: projectClaudeDir,
        description: "Shared settings for all Claude runtimes launched by Zotero.",
      },
      {
        label: "Local",
        path: localConversationDir,
        openPath: localConversationDir,
        description: "Each conversation stores its own override folder under the scopes tree.",
      },
    ];
    for (const row of rows) {
      const wrap = el(
        doc,
        "div",
        "display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 10px; border:1px solid var(--stroke-secondary, #c8c8c8); border-radius:8px; background: rgba(255,255,255,0.02);",
      );
      const textWrap = el(
        doc,
        "div",
        "display:flex; flex-direction:column; gap:2px; min-width:0;",
      );
      const label = el(
        doc,
        "div",
        "font-size:11px; font-weight:600; color: var(--fill-secondary, #666);",
        row.label,
      );
      const description = el(
        doc,
        "div",
        "font-size:10.5px; color: var(--fill-secondary, #666);",
        row.description,
      );
      const path = el(
        doc,
        "div",
        "font-size:11px; color: var(--fill-secondary, #666); word-break: break-all;",
        row.path,
      );
      const openBtn = el(
        doc,
        "button",
        "padding:4px 10px; font-size:11px; border:1px solid var(--stroke-secondary, #c8c8c8); border-radius:6px; background: Field; color: FieldText; cursor:pointer; flex:0 0 auto;",
        "Open folder",
      ) as HTMLButtonElement;
      openBtn.type = "button";
      openBtn.addEventListener("click", () => {
        if (row.label === "Local") {
          void (async () => {
            const localDir = getCurrentClaudeLocalDir();
            const localSettingsPath = joinLocalPath(localDir, "settings.local.json");
            await ensureDirectory(localDir);
            await ensureFileIfMissing(localSettingsPath, "{}\n");
            await openDirectory(localDir);
          })();
          return;
        }
        void openDirectory(row.openPath || row.path);
      });
      textWrap.append(label, description, path);
      wrap.append(textWrap, openBtn);
      claudeConfigPathsWrap.appendChild(wrap);
    }
  };

  if (agentClaudeConfigSourceSelect) {
    agentClaudeConfigSourceSelect.value = getClaudeConfigSourcePref();
    agentClaudeConfigSourceSelect.addEventListener("change", () => {
      const next =
        agentClaudeConfigSourceSelect.value === "user-only" ||
        agentClaudeConfigSourceSelect.value === "zotero-only"
          ? agentClaudeConfigSourceSelect.value
          : "default";
      Zotero.Prefs.set(`${config.prefsPrefix}.agentClaudeConfigSource`, next, true);
      renderClaudeConfigPaths();
    });
  }
  renderClaudeConfigPaths();

  if (claudeConfigDocLink) {
    claudeConfigDocLink.addEventListener("click", (event) => {
      event.preventDefault();
      const launch = (Zotero as unknown as { launchURL?: (url: string) => void }).launchURL;
      launch?.("https://code.claude.com/docs/en/settings");
    });
  }

  if (claudeTracePathEl) {
    claudeTracePathEl.textContent = getAgentTraceExportPath("latest-run").replace(/[\\/]latest-run\.json$/i, "");
  }
  if (claudeTraceEnabledInput) {
    const raw = Zotero.Prefs.get(`${config.prefsPrefix}.agentTraceExportEnabled`, true);
    claudeTraceEnabledInput.checked = raw === true || `${raw || ""}`.toLowerCase() === "true";
    claudeTraceEnabledInput.addEventListener("change", () => {
      Zotero.Prefs.set(
        `${config.prefsPrefix}.agentTraceExportEnabled`,
        claudeTraceEnabledInput.checked,
        true,
      );
    });
  }
  if (claudeTraceCopyBtn) {
    claudeTraceCopyBtn.addEventListener("click", () => {
      void copyTextToClipboard(
        getAgentTraceExportPath("latest-run").replace(/[\\/]latest-run\.json$/i, ""),
      );
    });
  }

  if (claudeManagedInstructionTemplateInput) {
    const defaultManagedBlock = getDefaultClaudeManagedInstructionBlock();
    const syncManagedInstructionStatus = (message: string, color: string) => {
      if (!claudeManagedInstructionStatus) return;
      claudeManagedInstructionStatus.style.display = "inline";
      claudeManagedInstructionStatus.style.color = color;
      claudeManagedInstructionStatus.textContent = message;
    };
    const loadManagedInstructionTemplate = () => {
      const saved = getClaudeManagedInstructionTemplatePref();
      claudeManagedInstructionTemplateInput.value = saved || defaultManagedBlock;
      if (!saved.trim()) {
        void (async () => {
          const onDisk = await readClaudeProjectManagedInstructionBlock();
          if (!onDisk) return;
          claudeManagedInstructionTemplateInput.value = onDisk;
          setClaudeManagedInstructionTemplatePref(onDisk);
        })();
      }
    };
    loadManagedInstructionTemplate();
    claudeManagedInstructionTemplateInput.addEventListener("input", () => {
      setClaudeManagedInstructionTemplatePref(claudeManagedInstructionTemplateInput.value);
      if (claudeManagedInstructionStatus?.style.display !== "none") {
        syncManagedInstructionStatus(t("Template updated locally"), "var(--fill-secondary, #888)");
      }
    });
    if (claudeManagedInstructionResetBtn) {
      claudeManagedInstructionResetBtn.addEventListener("click", () => {
        claudeManagedInstructionTemplateInput.value = defaultManagedBlock;
        setClaudeManagedInstructionTemplatePref(defaultManagedBlock);
        syncManagedInstructionStatus(t("Reset to default template"), "var(--fill-secondary, #888)");
      });
    }
    if (claudeManagedInstructionUpdateBtn) {
      claudeManagedInstructionUpdateBtn.addEventListener("click", async () => {
        const template = setClaudeManagedInstructionTemplatePref(
          claudeManagedInstructionTemplateInput.value,
        ) || defaultManagedBlock;
        claudeManagedInstructionUpdateBtn.disabled = true;
        syncManagedInstructionStatus(t("Updating CLAUDE.md…"), "var(--fill-secondary, #888)");
        try {
          await updateClaudeProjectManagedInstructionBlock(template);
          syncManagedInstructionStatus(t("Managed block updated"), "green");
        } catch (error) {
          syncManagedInstructionStatus(
            `${t("Failed to update CLAUDE.md")}: ${(error as Error).message}`,
            "red",
          );
        } finally {
          claudeManagedInstructionUpdateBtn.disabled = false;
        }
      });
    }
  }

  if (agentPermissionModeSelect) {
    agentPermissionModeSelect.value = getClaudePermissionModePref();
    agentPermissionModeSelect.addEventListener("change", () => {
      setClaudePermissionModePref(
        normalizeAgentPermissionMode(agentPermissionModeSelect.value),
      );
    });
  }

  if (claudeCodeModelSelect) {
    claudeCodeModelSelect.value = getClaudeRuntimeModelPref();
    claudeCodeModelSelect.addEventListener("change", () => {
      setClaudeRuntimeModelPref(claudeCodeModelSelect.value);
    });
  }

  if (claudeCodeReasoningSelect) {
    claudeCodeReasoningSelect.value = getClaudeReasoningModePref();
    claudeCodeReasoningSelect.addEventListener("change", () => {
      const next =
        claudeCodeReasoningSelect.value === "low" ||
        claudeCodeReasoningSelect.value === "medium" ||
        claudeCodeReasoningSelect.value === "high" ||
        claudeCodeReasoningSelect.value === "xhigh" ||
        claudeCodeReasoningSelect.value === "max"
          ? claudeCodeReasoningSelect.value
          : "auto";
      setClaudeReasoningModePref(next);
    });
  }

  if (claudeCodeBlockStreamingInput) {
    claudeCodeBlockStreamingInput.checked = isClaudeBlockStreamingEnabled();
    claudeCodeBlockStreamingInput.addEventListener("change", () => {
      setClaudeBlockStreamingEnabled(claudeCodeBlockStreamingInput.checked);
    });
  }

  if (claudeCodeAutoCompactInput) {
    claudeCodeAutoCompactInput.checked = isClaudeAutoCompactEnabled();
    claudeCodeAutoCompactInput.addEventListener("change", () => {
      setClaudeAutoCompactEnabled(claudeCodeAutoCompactInput.checked);
    });
  }
  if (claudeCodeAutoCompactThresholdInput) {
    const syncThresholdLabel = (value: number) => {
      if (claudeCodeAutoCompactThresholdValue) {
        claudeCodeAutoCompactThresholdValue.textContent = `${value}%`;
      }
    };
    const persistThreshold = () => {
      setClaudeAutoCompactThresholdPercent(
        Number(claudeCodeAutoCompactThresholdInput.value),
      );
      syncThresholdLabel(getClaudeAutoCompactThresholdPercent());
    };
    const initialValue = getClaudeAutoCompactThresholdPercent();
    claudeCodeAutoCompactThresholdInput.value = String(initialValue);
    syncThresholdLabel(initialValue);
    claudeCodeAutoCompactThresholdInput.addEventListener("input", () => {
      persistThreshold();
    });
    claudeCodeAutoCompactThresholdInput.addEventListener("change", () => {
      persistThreshold();
    });
  }

  // ── Notes Directory settings ─────────────────────────────────────
  {
    const notesDirNicknameInput = doc.querySelector(
      `#${config.addonRef}-notes-dir-nickname`,
    ) as HTMLInputElement | null;
    const notesDirPathInput = doc.querySelector(
      `#${config.addonRef}-obsidian-vault-path`,
    ) as HTMLInputElement | null;
    const notesDirFolderInput = doc.querySelector(
      `#${config.addonRef}-obsidian-target-folder`,
    ) as HTMLInputElement | null;
    const notesDirTestBtn = doc.querySelector(
      `#${config.addonRef}-obsidian-test`,
    ) as HTMLButtonElement | null;
    const notesDirTestStatus = doc.querySelector(
      `#${config.addonRef}-obsidian-test-status`,
    ) as HTMLSpanElement | null;

    if (notesDirNicknameInput) {
      notesDirNicknameInput.value = getNotesDirectoryNickname();
      notesDirNicknameInput.addEventListener("input", () => {
        setNotesDirectoryNickname(notesDirNicknameInput.value);
      });
    }
    if (notesDirPathInput) {
      notesDirPathInput.value = getNotesDirectoryPath();
      notesDirPathInput.addEventListener("input", () => {
        setNotesDirectoryPath(notesDirPathInput.value);
      });
    }
    if (notesDirFolderInput) {
      notesDirFolderInput.value = getNotesDirectoryFolder();
      notesDirFolderInput.addEventListener("input", () => {
        setNotesDirectoryFolder(notesDirFolderInput.value);
      });
    }
    const notesDirAttachmentsInput = doc.querySelector(
      `#${config.addonRef}-obsidian-attachments-folder`,
    ) as HTMLInputElement | null;
    if (notesDirAttachmentsInput) {
      notesDirAttachmentsInput.value = getNotesDirectoryAttachmentsFolder();
      notesDirAttachmentsInput.addEventListener("input", () => {
        setNotesDirectoryAttachmentsFolder(notesDirAttachmentsInput.value);
      });
    }
    if (notesDirTestBtn && notesDirTestStatus) {
      notesDirTestBtn.addEventListener("click", async () => {
        const dirPath = (notesDirPathInput?.value || "").trim();
        if (!dirPath) {
          notesDirTestStatus.style.display = "inline";
          notesDirTestStatus.style.color = "#dc2626";
          notesDirTestStatus.textContent = t("Enter a directory path first");
          return;
        }
        const targetFolder = (notesDirFolderInput?.value || "").trim();
        const fullPath = targetFolder
          ? joinLocalPath(dirPath, targetFolder)
          : dirPath;

        notesDirTestBtn.disabled = true;
        notesDirTestStatus.style.display = "inline";
        notesDirTestStatus.style.color = "var(--fill-secondary, #888)";
        notesDirTestStatus.textContent = "Testing...";

        try {
          const IOUtils = (globalThis as any).IOUtils;
          if (!IOUtils?.exists || !IOUtils?.write || !IOUtils?.remove) {
            throw new Error("File I/O not available");
          }
          const exists = await IOUtils.exists(fullPath);
          if (!exists) {
            throw new Error(`Directory not found: ${fullPath}`);
          }
          const testFile = joinLocalPath(fullPath, ".llm-for-zotero-test");
          const bytes = new TextEncoder().encode("test");
          await IOUtils.write(testFile, bytes);
          await IOUtils.remove(testFile);
          notesDirTestStatus.style.color = "#16a34a";
          notesDirTestStatus.textContent = t("Write access verified");
        } catch (err) {
          notesDirTestStatus.style.color = "#dc2626";
          notesDirTestStatus.textContent =
            err instanceof Error ? err.message : String(err);
        } finally {
          notesDirTestBtn.disabled = false;
        }
      });
    }
  }

  // ── Semantic Search settings ───────────────────────────────────
  // Follows the same toggle + sub-settings pattern as MinerU.

  const semanticSearchToggle = doc.querySelector(
    `#${config.addonRef}-enable-semantic-search`,
  ) as HTMLInputElement | null;
  const semanticSearchSubSettings = doc.querySelector(
    `#${config.addonRef}-semantic-search-sub-settings`,
  ) as HTMLDivElement | null;
  const semanticSearchMount = doc.querySelector(
    `#${config.addonRef}-semantic-search-mount`,
  ) as HTMLDivElement | null;

  if (
    semanticSearchToggle &&
    semanticSearchSubSettings &&
    semanticSearchMount
  ) {
    const EMBEDDING_PRESETS: Record<
      string,
      {
        apiBase: string;
        defaultModel: string;
        models: { value: string; label: string; pricing: string }[];
      }
    > = {
      openai: {
        apiBase: "https://api.openai.com/v1",
        defaultModel: "text-embedding-3-small",
        models: [
          {
            value: "text-embedding-3-small",
            label: "text-embedding-3-small",
            pricing: "$0.02 / 1M tokens",
          },
          {
            value: "text-embedding-3-large",
            label: "text-embedding-3-large",
            pricing: "$0.13 / 1M tokens",
          },
          {
            value: "text-embedding-ada-002",
            label: "text-embedding-ada-002 (legacy)",
            pricing: "$0.10 / 1M tokens",
          },
        ],
      },
      gemini: {
        apiBase: "https://generativelanguage.googleapis.com/v1beta/openai",
        defaultModel: "gemini-embedding-001",
        models: [
          {
            value: "gemini-embedding-001",
            label: "gemini-embedding-001",
            pricing: "Free tier available · $0.15 / 1M tokens",
          },
          {
            value: "text-embedding-004",
            label: "text-embedding-004",
            pricing: "$0.10 / 1M tokens",
          },
        ],
      },
    };

    // Find an API key from configured provider groups matching a preset ID
    const findProviderApiKey = (targetPresetId: string): string => {
      const groups = getModelProviderGroups();
      for (const group of groups) {
        if (!group.apiKey.trim() || group.authMode !== "api_key") continue;
        if (detectProviderPreset(group.apiBase) === targetPresetId) {
          return group.apiKey;
        }
      }
      return "";
    };

    const readEmbPref = (key: string): string =>
      (Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true) || "").toString();
    const writeEmbPref = (key: string, val: string | boolean) =>
      Zotero.Prefs.set(`${config.prefsPrefix}.${key}`, val, true);

    // Read the current embedding provider; migrates legacy or unset
    // values to a concrete provider on first open.
    const resolveEmbeddingProvider = (): string => {
      const stored = readEmbPref("embeddingProvider");
      if (stored === "openai" || stored === "gemini" || stored === "custom") {
        return stored;
      }
      if (stored === "ollama") {
        writeEmbPref("embeddingProvider", "custom");
        return "custom";
      }
      // "main", empty, or unset → default to "gemini" (free tier available)
      writeEmbPref("embeddingProvider", "gemini");
      writeEmbPref("embeddingApiBase", EMBEDDING_PRESETS.gemini.apiBase);
      if (!readEmbPref("embeddingModel")) {
        writeEmbPref("embeddingModel", EMBEDDING_PRESETS.gemini.defaultModel);
      }
      return "gemini";
    };

    // Toggle visibility (same pattern as MinerU)
    const syncSemanticVisibility = () => {
      semanticSearchSubSettings.style.display = semanticSearchToggle.checked
        ? "flex"
        : "none";
    };

    const enabledRaw = Zotero.Prefs.get(
      `${config.prefsPrefix}.enableSemanticSearch`,
      true,
    );
    const enabled = enabledRaw === true || enabledRaw === "true";
    semanticSearchToggle.checked = enabled;
    syncSemanticVisibility();

    semanticSearchToggle.addEventListener("change", () => {
      writeEmbPref("enableSemanticSearch", semanticSearchToggle.checked);
      syncSemanticVisibility();
    });

    // Render the embedding config card inside sub-settings
    const renderEmbeddingCard = () => {
      semanticSearchMount.innerHTML = "";

      const provider = resolveEmbeddingProvider();
      const preset = EMBEDDING_PRESETS[provider];
      const isCustom = provider === "custom";

      const card = el(doc, "div", CARD_STYLE);

      // Card header
      const cardHeader = el(doc, "div", CARD_HEADER_STYLE);
      cardHeader.appendChild(
        el(
          doc,
          "span",
          "font-weight: 700; font-size: 13px;",
          t("Embedding Provider"),
        ),
      );
      card.appendChild(cardHeader);

      // Card body
      const cardBody = el(doc, "div", CARD_BODY_STYLE);

      // Provider selector
      const providerWrap = el(
        doc,
        "div",
        "display: flex; flex-direction: column;",
      );
      providerWrap.appendChild(el(doc, "label", LABEL_STYLE, t("Provider")));
      const providerSelect = el(
        doc,
        "select",
        INPUT_STYLE,
      ) as HTMLSelectElement;
      const providerOptions: [string, string][] = [
        ["openai", "OpenAI"],
        ["gemini", "Google"],
        ["custom", t("Customized")],
      ];
      for (const [val, label] of providerOptions) {
        const opt = el(doc, "option") as HTMLOptionElement;
        opt.value = val;
        opt.textContent = label;
        providerSelect.appendChild(opt);
      }
      providerSelect.value = provider;
      providerSelect.addEventListener("change", () => {
        const selected = providerSelect.value;
        writeEmbPref("embeddingProvider", selected);
        const p = EMBEDDING_PRESETS[selected];
        if (p) {
          writeEmbPref("embeddingApiBase", p.apiBase);
          writeEmbPref("embeddingModel", p.defaultModel);
          // Clear dedicated key — runtime will auto-detect from provider groups
          writeEmbPref("embeddingApiKey", "");
        }
        // Reset failed-embedding flags so queries retry with the new config
        resetEmbeddingFailedFlags();
        // Cached retrieval candidates carry scores from the old provider
        clearRetrievalCandidateCache();
        // Defer re-render so Gecko finishes processing the select change event
        // before we destroy the element (avoids "this.element is null" error).
        doc.defaultView?.setTimeout(() => renderEmbeddingCard(), 0);
      });
      providerWrap.appendChild(providerSelect);
      cardBody.appendChild(providerWrap);

      // Custom mode: show API URL + API Key fields
      if (isCustom) {
        const apiBaseWrap = el(
          doc,
          "div",
          "display: flex; flex-direction: column;",
        );
        apiBaseWrap.appendChild(el(doc, "label", LABEL_STYLE, t("API URL")));
        const apiBaseInput = el(doc, "input", INPUT_STYLE) as HTMLInputElement;
        apiBaseInput.type = "text";
        apiBaseInput.placeholder = "https://api.openai.com/v1";
        apiBaseInput.value = readEmbPref("embeddingApiBase");
        apiBaseInput.addEventListener("change", () => {
          writeEmbPref("embeddingApiBase", apiBaseInput.value.trim());
        });
        apiBaseWrap.appendChild(apiBaseInput);
        cardBody.appendChild(apiBaseWrap);

        const apiKeyWrap = el(
          doc,
          "div",
          "display: flex; flex-direction: column;",
        );
        apiKeyWrap.appendChild(el(doc, "label", LABEL_STYLE, t("API Key")));
        const apiKeyInput = el(doc, "input", INPUT_STYLE) as HTMLInputElement;
        apiKeyInput.type = "password";
        apiKeyInput.value = readEmbPref("embeddingApiKey");
        apiKeyInput.addEventListener("change", () => {
          writeEmbPref("embeddingApiKey", apiKeyInput.value.trim());
          resetEmbeddingFailedFlags();
          clearRetrievalCandidateCache();
        });
        apiKeyWrap.appendChild(apiKeyInput);
        cardBody.appendChild(apiKeyWrap);
      }

      // OpenAI / Google: API key status hint (auto-reuse from provider groups)
      if (!isCustom) {
        const autoKey = findProviderApiKey(provider);
        const explicitKey = readEmbPref("embeddingApiKey");
        if (autoKey || explicitKey) {
          const providerLabel = provider === "openai" ? "OpenAI" : "Google";
          const hint =
            autoKey && !explicitKey
              ? t("Using API key from your %provider% provider").replace(
                  "%provider%",
                  providerLabel,
                )
              : t("API key configured");
          cardBody.appendChild(
            el(
              doc,
              "span",
              "font-size: 11px; color: green; display: block;",
              `✓ ${hint}`,
            ),
          );
        } else {
          // No matching key found — show API key input with guidance
          const apiKeyWrap = el(
            doc,
            "div",
            "display: flex; flex-direction: column;",
          );
          apiKeyWrap.appendChild(el(doc, "label", LABEL_STYLE, t("API Key")));
          const apiKeyInput = el(doc, "input", INPUT_STYLE) as HTMLInputElement;
          apiKeyInput.type = "password";
          apiKeyInput.placeholder = "sk-…";
          apiKeyInput.value = "";
          apiKeyInput.addEventListener("change", () => {
            writeEmbPref("embeddingApiKey", apiKeyInput.value.trim());
            resetEmbeddingFailedFlags();
            clearRetrievalCandidateCache();
            doc.defaultView?.setTimeout(() => renderEmbeddingCard(), 0);
          });
          apiKeyWrap.appendChild(apiKeyInput);
          const providerLabel = provider === "openai" ? "OpenAI" : "Google";
          apiKeyWrap.appendChild(
            el(
              doc,
              "span",
              HELPER_STYLE,
              t(
                "No %provider% provider found. Enter an API key for embeddings.",
              ).replace("%provider%", providerLabel),
            ),
          );
          cardBody.appendChild(apiKeyWrap);
        }
      }

      // Model + Test button (same row, consistent with AI provider layout)
      const modelWrap = el(
        doc,
        "div",
        "display: flex; flex-direction: column;",
      );
      modelWrap.appendChild(el(doc, "label", LABEL_STYLE, t("Model")));

      const INLINE_INPUT_STYLE =
        "flex: 1; min-width: 0; padding: 6px 10px; font-size: 13px;" +
        " border: 1px solid var(--stroke-secondary, #c8c8c8); border-radius: 6px;" +
        " box-sizing: border-box; background: Field; color: FieldText;";

      const modelRow = el(
        doc,
        "div",
        "display: flex; align-items: center; gap: 5px;",
      );

      // Pricing hint (shown below model row for preset providers)
      const pricingHint = el(doc, "span", HELPER_STYLE);

      const updatePricingHint = (modelValue: string) => {
        if (!preset) return;
        const entry = preset.models.find((m) => m.value === modelValue);
        pricingHint.textContent = entry?.pricing
          ? `${t("Estimated cost")}: ${entry.pricing}`
          : "";
      };

      if (preset) {
        // Dropdown for known providers
        const modelSelect = el(
          doc,
          "select",
          INLINE_INPUT_STYLE,
        ) as HTMLSelectElement;
        const currentModel =
          readEmbPref("embeddingModel") || preset.defaultModel;
        for (const opt of preset.models) {
          const option = el(doc, "option") as HTMLOptionElement;
          option.value = opt.value;
          option.textContent = opt.label;
          if (opt.value === currentModel) option.selected = true;
          modelSelect.appendChild(option);
        }
        // Preserve a previously set model that's not in the preset list
        if (
          !preset.models.some((m) => m.value === currentModel) &&
          currentModel
        ) {
          const customOpt = el(doc, "option") as HTMLOptionElement;
          customOpt.value = currentModel;
          customOpt.textContent = currentModel;
          customOpt.selected = true;
          modelSelect.appendChild(customOpt);
        }
        modelSelect.addEventListener("change", () => {
          writeEmbPref("embeddingModel", modelSelect.value);
          resetEmbeddingFailedFlags();
          clearRetrievalCandidateCache();
          updatePricingHint(modelSelect.value);
        });
        modelRow.appendChild(modelSelect);
        updatePricingHint(currentModel);
      } else {
        // Text input for custom mode
        const modelInput = el(
          doc,
          "input",
          INLINE_INPUT_STYLE,
        ) as HTMLInputElement;
        modelInput.type = "text";
        modelInput.placeholder = "text-embedding-3-small";
        modelInput.value = readEmbPref("embeddingModel");
        modelInput.addEventListener("change", () => {
          writeEmbPref("embeddingModel", modelInput.value.trim());
        });
        modelRow.appendChild(modelInput);
      }

      // Test button on same row as model
      const testBtn = el(
        doc,
        "button",
        OUTLINE_BTN_STYLE,
        t("Test"),
      ) as HTMLButtonElement;
      testBtn.type = "button";
      modelRow.appendChild(testBtn);

      modelWrap.appendChild(modelRow);

      // Pricing hint (only for preset providers)
      if (preset) {
        modelWrap.appendChild(pricingHint);
      }

      // Test status line (below model row, same pattern as AI provider)
      const testStatus = el(
        doc,
        "span",
        "font-size: 11.5px; display: none; margin-top: 3px; white-space: pre-wrap; word-break: break-all;",
      );
      const runEmbeddingTest = async () => {
        testBtn.disabled = true;
        testStatus.style.display = "inline";
        testStatus.textContent = t("Testing…");
        testStatus.style.color = "var(--fill-secondary, #888)";
        try {
          await callEmbeddings(["test"]);
          testStatus.textContent = t("✓ Connection successful");
          testStatus.style.color = "green";
        } catch (error) {
          testStatus.textContent = `✗ ${(error as Error).message}`.slice(
            0,
            120,
          );
          testStatus.style.color = "red";
        } finally {
          testBtn.disabled = false;
        }
      };
      testBtn.addEventListener("click", () => void runEmbeddingTest());
      testBtn.addEventListener("command", () => void runEmbeddingTest());
      modelWrap.appendChild(testStatus);

      cardBody.appendChild(modelWrap);

      card.appendChild(cardBody);
      semanticSearchMount.appendChild(card);
    };

    renderEmbeddingCard();
  }

  // ── MinerU settings ─────────────────────────────────────────────

  const mineruEnabledInput = doc.querySelector(
    `#${config.addonRef}-mineru-enabled`,
  ) as HTMLInputElement | null;
  const mineruSubSettings = doc.querySelector(
    `#${config.addonRef}-mineru-sub-settings`,
  ) as HTMLDivElement | null;
  const mineruLocalModeInput = doc.querySelector(
    `#${config.addonRef}-mineru-local-mode`,
  ) as HTMLInputElement | null;
  const mineruCloudInfo = doc.querySelector(
    `#${config.addonRef}-mineru-cloud-info`,
  ) as HTMLDivElement | null;
  const mineruApiKeySection = doc.querySelector(
    `#${config.addonRef}-mineru-api-key-section`,
  ) as HTMLDivElement | null;
  const mineruApiKeyInput = doc.querySelector(
    `#${config.addonRef}-mineru-api-key`,
  ) as HTMLInputElement | null;
  const mineruLocalSection = doc.querySelector(
    `#${config.addonRef}-mineru-local-section`,
  ) as HTMLDivElement | null;
  const mineruLocalApiBaseInput = doc.querySelector(
    `#${config.addonRef}-mineru-local-api-base`,
  ) as HTMLInputElement | null;
  const mineruLocalBackendSelect = doc.querySelector(
    `#${config.addonRef}-mineru-local-backend`,
  ) as HTMLSelectElement | null;
  const mineruTestBtn = doc.querySelector(
    `#${config.addonRef}-mineru-test`,
  ) as HTMLButtonElement | null;
  const mineruTestStatus = doc.querySelector(
    `#${config.addonRef}-mineru-test-status`,
  ) as HTMLSpanElement | null;
  const mineruSyncEnabledInput = doc.querySelector(
    `#${config.addonRef}-mineru-sync-enabled`,
  ) as HTMLInputElement | null;
  const mineruSyncPrepareBtn = doc.querySelector(
    `#${config.addonRef}-mineru-sync-prepare`,
  ) as HTMLButtonElement | null;
  const mineruSyncCleanBtn = doc.querySelector(
    `#${config.addonRef}-mineru-sync-clean`,
  ) as HTMLButtonElement | null;
  const mineruSyncStatus = doc.querySelector(
    `#${config.addonRef}-mineru-sync-status`,
  ) as HTMLSpanElement | null;

  const getSelectedMineruMode = (): MineruMode =>
    mineruLocalModeInput?.checked ? "local" : "cloud";
  const clearMineruTestStatus = () => {
    if (!mineruTestStatus) return;
    mineruTestStatus.style.display = "none";
    mineruTestStatus.textContent = "";
  };
  const syncMineruModeVisibility = () => {
    const mode = getSelectedMineruMode();
    if (mineruCloudInfo) {
      mineruCloudInfo.style.display = mode === "cloud" ? "block" : "none";
    }
    if (mineruApiKeySection) {
      mineruApiKeySection.style.display =
        mode === "cloud" ? "flex" : "none";
    }
    if (mineruLocalSection) {
      mineruLocalSection.style.display = mode === "local" ? "flex" : "none";
    }
  };

  if (mineruEnabledInput) {
    mineruEnabledInput.checked = isMineruEnabled();
    const syncSubVisibility = () => {
      if (mineruSubSettings) {
        mineruSubSettings.style.display = mineruEnabledInput.checked
          ? "flex"
          : "none";
      }
      syncMineruModeVisibility();
    };
    syncSubVisibility();
    mineruEnabledInput.addEventListener("change", () => {
      setMineruEnabled(mineruEnabledInput.checked);
      syncSubVisibility();
    });
  }

  const isMineruSyncChecked = () =>
    mineruSyncEnabledInput
      ? mineruSyncEnabledInput.checked
      : isMineruSyncEnabled();
  const updateMineruSyncCleanupLabel = () => {
    if (!mineruSyncCleanBtn) return;
    mineruSyncCleanBtn.textContent = t(
      isMineruSyncChecked()
        ? "Disable MinerU sync and delete packages"
        : "Delete synced MinerU packages",
    );
  };
  const syncMineruSyncControls = () => {
    const enabled = isMineruSyncChecked();
    if (mineruSyncPrepareBtn) {
      mineruSyncPrepareBtn.disabled = !enabled;
    }
    updateMineruSyncCleanupLabel();
  };

  if (mineruSyncEnabledInput) {
    mineruSyncEnabledInput.checked = isMineruSyncEnabled();
    syncMineruSyncControls();
    mineruSyncEnabledInput.addEventListener("change", () => {
      const enabled = mineruSyncEnabledInput.checked;
      setMineruSyncEnabled(enabled);
      syncMineruSyncControls();
      if (!mineruSyncStatus) return;
      mineruSyncStatus.style.display = "block";
      mineruSyncStatus.style.color = "var(--fill-secondary, #888)";
      if (!enabled) {
        mineruSyncStatus.textContent = t(
          "MinerU sync disabled. Existing synced packages are kept until deleted.",
        );
        return;
      }
      mineruSyncStatus.textContent = t(
        "MinerU sync enabled. Existing local caches sync only when requested.",
      );
    });
  } else {
    syncMineruSyncControls();
  }

  if (mineruSyncPrepareBtn && mineruSyncStatus) {
    mineruSyncPrepareBtn.addEventListener("click", () => {
      if (!isMineruSyncEnabled()) {
        mineruSyncStatus.style.display = "block";
        mineruSyncStatus.style.color = "#b45309";
        mineruSyncStatus.textContent = t(
          "Enable MinerU sync before preparing packages.",
        );
        return;
      }

      mineruSyncPrepareBtn.disabled = true;
      if (mineruSyncCleanBtn) mineruSyncCleanBtn.disabled = true;
      mineruSyncStatus.style.display = "block";
      mineruSyncStatus.style.color = "var(--fill-secondary, #888)";
      mineruSyncStatus.textContent = t("Syncing existing MinerU caches…");
      void (async () => {
        try {
          const result = await repairMineruSyncPackages({
            onProgress: (progress) => {
              mineruSyncStatus.textContent =
                t("Syncing existing MinerU caches") +
                `: ${progress.scanned} scanned, ` +
                `${progress.published} package(s), ` +
                `${progress.restored} restored.`;
            },
          });
          mineruSyncStatus.textContent =
            t("Existing MinerU caches synced") +
            `: ${result.published} package(s), ` +
            `${result.restored} restored, ${result.upToDate} up to date, ` +
            `${result.skipped} skipped.`;
          mineruSyncStatus.style.color =
            result.failed > 0 || result.diverged > 0 ? "#b45309" : "green";
        } catch (error) {
          mineruSyncStatus.textContent = `\u2717 ${
            error instanceof Error ? error.message : String(error)
          }`;
          mineruSyncStatus.style.color = "red";
        } finally {
          mineruSyncPrepareBtn.disabled = !isMineruSyncEnabled();
          if (mineruSyncCleanBtn) mineruSyncCleanBtn.disabled = false;
        }
      })();
    });
  }

  if (mineruSyncCleanBtn && mineruSyncStatus) {
    const runMineruSyncCleanup = async () => {
      const shouldDisableSync = isMineruSyncChecked();
      const confirmed = await confirmMineruSyncPackageDeletion(
        shouldDisableSync,
      );
      if (!confirmed) return;

      mineruSyncCleanBtn.disabled = true;
      if (shouldDisableSync) {
        setMineruSyncEnabled(false);
        if (mineruSyncEnabledInput) {
          mineruSyncEnabledInput.checked = false;
        }
        syncMineruSyncControls();
      }
      mineruSyncStatus.style.display = "block";
      mineruSyncStatus.style.color = "var(--fill-secondary, #888)";
      mineruSyncStatus.textContent = shouldDisableSync
        ? t("MinerU sync disabled. Deleting synced MinerU packages…")
        : t("Deleting synced MinerU packages…");
      try {
        const result = await cleanSyncedMineruPackages();
        const deletedPrefix = shouldDisableSync
          ? t("MinerU sync disabled. Deleted synced MinerU packages")
          : t("Deleted synced MinerU packages");
        mineruSyncStatus.textContent =
          result.failed > 0
            ? `${deletedPrefix}: ${result.deleted}, ${result.failed} failed.`
            : `${deletedPrefix}: ${result.deleted}.`;
        mineruSyncStatus.style.color = result.failed > 0 ? "#b45309" : "green";
      } catch (error) {
        mineruSyncStatus.textContent = `\u2717 ${
          error instanceof Error ? error.message : String(error)
        }`;
        mineruSyncStatus.style.color = "red";
      } finally {
        mineruSyncCleanBtn.disabled = false;
        syncMineruSyncControls();
      }
    };
    mineruSyncCleanBtn.addEventListener("click", () =>
      void runMineruSyncCleanup(),
    );
    mineruSyncCleanBtn.addEventListener("command", () =>
      void runMineruSyncCleanup(),
    );
  }

  const mineruGlobalAutoParseInput = doc.querySelector(
    `#${config.addonRef}-mineru-global-auto-parse`,
  ) as HTMLInputElement | null;
  if (mineruGlobalAutoParseInput) {
    mineruGlobalAutoParseInput.checked = isGlobalAutoParseEnabled();
    mineruGlobalAutoParseInput.addEventListener("change", () => {
      setGlobalAutoParseEnabled(mineruGlobalAutoParseInput.checked);
    });
  }

  if (mineruLocalModeInput) {
    mineruLocalModeInput.checked = getMineruMode() === "local";
    syncMineruModeVisibility();
    mineruLocalModeInput.addEventListener("change", () => {
      setMineruMode(getSelectedMineruMode());
      syncMineruModeVisibility();
      clearMineruTestStatus();
    });
  } else {
    syncMineruModeVisibility();
  }

  if (mineruApiKeyInput) {
    mineruApiKeyInput.value = getMineruApiKey();
    mineruApiKeyInput.addEventListener("input", () => {
      setMineruApiKey(mineruApiKeyInput.value);
    });
  }

  if (mineruLocalApiBaseInput) {
    mineruLocalApiBaseInput.value = getMineruLocalApiBase();
    const commitMineruLocalApiBase = () => {
      setMineruLocalApiBase(mineruLocalApiBaseInput.value);
      mineruLocalApiBaseInput.value = getMineruLocalApiBase();
    };
    mineruLocalApiBaseInput.addEventListener("change", commitMineruLocalApiBase);
    mineruLocalApiBaseInput.addEventListener("blur", commitMineruLocalApiBase);
  }

  if (mineruLocalBackendSelect) {
    mineruLocalBackendSelect.value = getMineruLocalBackend();
    mineruLocalBackendSelect.addEventListener("change", () => {
      const next: MineruLocalBackend = normalizeMineruLocalBackend(
        mineruLocalBackendSelect.value,
      );
      setMineruLocalBackend(next);
      mineruLocalBackendSelect.value = next;
      clearMineruTestStatus();
    });
  }

  if (mineruTestBtn && mineruTestStatus) {
    const runMineruTest = async () => {
      const mode = getSelectedMineruMode();
      if (mode === "local" && mineruLocalApiBaseInput) {
        setMineruLocalApiBase(mineruLocalApiBaseInput.value);
        mineruLocalApiBaseInput.value = getMineruLocalApiBase();
      }
      mineruTestBtn.disabled = true;
      mineruTestStatus.style.display = "inline";
      mineruTestStatus.textContent = t("Testing…");
      mineruTestStatus.style.color = "var(--fill-secondary, #888)";
      try {
        if (mode === "local") {
          await testMineruLocalConnection(getMineruLocalApiBase());
        } else {
          const apiKey = getMineruApiKey().trim();
          if (apiKey) {
            await testMineruConnection(apiKey);
          } else {
            await testProxyConnection();
          }
        }
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

  // ── Filename exclusion patterns ────────────────────────────────
  const mineruExcludePatternsInput = doc.querySelector(
    `#${config.addonRef}-mineru-exclude-patterns`,
  ) as HTMLInputElement | null;
  if (mineruExcludePatternsInput) {
    const patterns = getMineruExcludePatterns();
    mineruExcludePatternsInput.value = patterns.join(", ");
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    mineruExcludePatternsInput.addEventListener("input", () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const parsed = mineruExcludePatternsInput.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        setMineruExcludePatterns(parsed);
      }, 500);
    });
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
    const currentLocale =
      (Zotero.Prefs.get(`${prefsPrefix}.locale`, true) as string) || "auto";
    localeSelect.value = currentLocale;
    localeSelect.addEventListener("change", () => {
      // Use the new runtime locale switch
      setLocale(localeSelect.value);
      // Optionally, you can still show a hint for clarity
      if (localeRestartHint) {
        localeRestartHint.style.display = "none"; // No need for restart
      }
      // Re-translate the preferences page
      if (doc.defaultView) {
        registerPrefsScripts(doc.defaultView);
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
