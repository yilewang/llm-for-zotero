import { appLogger } from "../core/logging";
import { createProviderRequestScope } from "../utils/providerTransport";
import {
  getSidebarLayout,
  SIDEBAR_LAYOUT_PREF,
} from "./contextPanel/sidebarLayout";
import { config } from "../../package.json";
import { t } from "../utils/i18n";
import { WEBCHAT_TARGETS } from "../webchat/types";
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TEMPERATURE,
} from "../utils/llmDefaults";
import { HTML_NS, createElement, el, iconBtn } from "../utils/domHelpers";
import { registerAddonDialog } from "../utils/dialogRegistry";
import {
  normalizeMaxTokens,
  normalizeOptionalInputTokenCap,
  normalizeTemperature,
} from "../utils/normalization";
import {
  getModelInputModeLabel,
  getModelInputModeOptionsForRuntime,
  normalizeModelInputModeForRuntime,
  resolveModelInputMode,
} from "../utils/modelInputMode";
import {
  buildProviderCatalogIdentity,
  consumeOutputTokenAutoMigrationNotice,
  createCodexDirectModelRow,
  createEmptyProviderGroup,
  createProviderModelEntry,
  createWebChatTargetRow,
  getFirstSelectableModelEntryId,
  getLastUsedModelEntryId,
  getModelProviderGroups,
  setModelProviderGroups,
  setLastUsedModelEntryId,
  type ModelProviderAuthMode,
  type CodexDirectProviderGroup,
  type ModelProviderGroup,
  type ModelProviderModel,
  type WebChatProviderGroup,
} from "../utils/modelProviders";
import {
  CUSTOMIZED_MODEL_OPTION_VALUE,
  buildProviderModelSelectRows,
  canFetchProviderModels,
  providerGroupRequiresApiKey,
  createSelectRebuildGate,
  resolveModelEntryMode,
  resolveProviderModelFetchStatus,
  runAfterSelectChangeDispatch,
} from "../utils/providerModelPicker";
import {
  attachCodexDirectCatalogInteractions,
  canOfferCodexDirectAuthMode,
} from "../utils/codexDirectProviderCard";
import {
  PROVIDER_MODEL_INPUT_CLASS,
  PROVIDER_MODEL_SELECT_CLASS,
  PROVIDER_MODEL_SLOT_CLASS,
  createProviderModelRowBlueprint,
  createProviderModelSectionBlueprint,
} from "../utils/providerCardModelSection";
import { describeProviderRow } from "./preferences/providerCards/providerRowHeader";
import { registerUsagePreferencePanel } from "./preferences/usagePanel";
import {
  getModelCapabilities,
  getModelCatalogStatus,
  refreshModelCatalog,
  subscribeModelCapabilities,
  type ModelProfileOverride,
} from "../modelCapabilities";
import { createModelProfileEditor } from "./modelProfileEditor";
import {
  PROVIDER_PRESETS,
  detectProviderPreset,
  getProviderPreset,
  getProviderPresetProtocolOptions,
  providerPresetRequiresApiKey,
  normalizeProviderPresetId,
  resolveProviderPresetId,
  type ProviderPresetId,
} from "../utils/providerPresets";
import {
  isProviderProtocol,
  normalizeProviderProtocolForAuthMode,
  getProviderProtocolSpec,
  type ProviderProtocol,
} from "../utils/providerProtocol";
import {
  runProviderConnectionTest,
  runProviderSettingsChecks,
  runCodexAppServerConnectionTest,
} from "../utils/providerConnectionTest";
import { normalizeClaudePermissionMode } from "../shared/claudePermissionMode";
import {
  getOriginalPermissionOptions,
  type PermissionOption,
} from "../shared/permissionOptions";
import { normalizeOriginalAgentPermissionMode } from "../shared/originalAgentPermissionMode";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../agent/originalAgentPermissionMode";
import {
  startCopilotDeviceFlow,
  pollCopilotDeviceAuth,
  resolveCopilotAccessToken,
  fetchCopilotModelList,
  callEmbeddings,
  getAutoEmbeddingProviderSummary,
  resolveSemanticSearchState,
} from "../utils/llmClient";
import { resetEmbeddingFailedFlags } from "../services/paperContent/pdfContext";
import { clearRetrievalCandidateCache } from "./contextPanel/multiContextPlanner";
import {
  DEFAULT_COPILOT_API_BASE,
  transitionProviderAuthMode,
} from "./preferences/providerAuthModeTransition";
import {
  createCodexDirectProviderCardController,
  type CodexDirectProviderCardController,
} from "./preferences/providerCards/codexDirectProviderCardController";
import { createProviderCardModeSpec } from "./preferences/providerCards/providerCardFactory";
import {
  FONT_SCALE_DEFAULT_PERCENT,
  FONT_SCALE_MAX_PERCENT,
  FONT_SCALE_MIN_PERCENT,
  MESSAGE_LINE_SPACING_DEFAULT_PERCENT,
  MESSAGE_LINE_SPACING_MAX_PERCENT,
  MESSAGE_LINE_SPACING_MIN_PERCENT,
  MESSAGE_PARAGRAPH_SPACING_DEFAULT_PX,
  MESSAGE_PARAGRAPH_SPACING_MAX_PX,
  MESSAGE_PARAGRAPH_SPACING_MIN_PX,
  MESSAGE_WORD_SPACING_DEFAULT_PX,
  MESSAGE_WORD_SPACING_MAX_PX,
  MESSAGE_WORD_SPACING_MIN_PX,
} from "./contextPanel/constants";
import {
  applyPanelFontScale,
  getFontScalePref,
  getMessageFontFamilyPref,
  getMessageLineSpacingPref,
  getMessageParagraphSpacingPref,
  getMessageWordSpacingPref,
  setFontScalePref,
  setMessageFontFamilyPref,
  setMessageLineSpacingPref,
  setMessageParagraphSpacingPref,
  setMessageWordSpacingPref,
} from "./contextPanel/prefHelpers";
import {
  setPanelFontScalePercent,
  setMessageFontFamily,
  setMessageLineSpacingPercent,
  setMessageParagraphSpacingPx,
  setMessageWordSpacingPx,
} from "./contextPanel/state";
import { getAgentTraceExportPath } from "../agent/store/traceStore";
import { joinLocalPath } from "../utils/localPath";
import {
  isMineruEnabled,
  getMineruApiKey,
  getMineruCloudModel,
  isMineruForceOcrEnabled,
  getMineruLocalApiBase,
  getMineruLocalBackend,
  getMineruMode,
  type MineruCloudModel,
  type MineruLocalBackend,
  type MineruMode,
  normalizeMineruCloudModel,
  normalizeMineruLocalBackend,
  setMineruEnabled,
  setMineruApiKey,
  setMineruCloudModel,
  setMineruForceOcrEnabled,
  setMineruLocalApiBase,
  setMineruLocalBackend,
  setMineruMode,
  isGlobalAutoParseEnabled,
  setGlobalAutoParseEnabled,
  isMineruSyncEnabled,
  setMineruSyncEnabled,
  getMineruMaxAutoPages,
  normalizeMineruMaxAutoPages,
  setMineruMaxAutoPages,
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
} from "../utils/mineruClient";
import {
  MINERU_PARSE_FILTERS_CHANGED_EVENT,
  registerMineruManagerScript,
} from "./mineruManagerScript";
import {
  cleanSyncedMineruPackages,
  repairMineruSyncPackages,
} from "../services/mineru/sync";
import { getRuntimePlatformInfo } from "../utils/runtimePlatform";
import {
  getClaudeAutoCompactThresholdPercent,
  getClaudeBridgeUrl,
  getClaudeConfigSourcePref,
  getClaudeManagedInstructionTemplatePref,
  getClaudePermissionModePref,
  getClaudeReasoningModePref,
  getClaudeRuntimeModelPref,
  getClaudeSettingSourcesByPref,
  isClaudeAutoCompactEnabled,
  isClaudeBlockStreamingEnabled,
  getConversationSystemPref,
  getLastUsedClaudeGlobalConversationKey,
  getLastUsedClaudePaperConversationKey,
  isClaudeCodeModeEnabled,
  setClaudeAutoCompactEnabled,
  setClaudeAutoCompactThresholdPercent,
  setClaudeBridgeUrl,
  setClaudeManagedInstructionTemplatePref,
  setClaudePermissionModePref,
  setClaudeReasoningModePref,
  setClaudeRuntimeModelPref,
  setClaudeBlockStreamingEnabled,
} from "../claudeCode/prefs";
import {
  buildClaudeModelPreferenceOptions,
  CLAUDE_CUSTOMIZED_MODEL_OPTION_KEY,
  fetchClaudeModelCatalog,
  resolveClaudeModelPreferenceSelection,
  shouldPreserveClaudeCustomModelDraft,
  type ClaudeModelPreferenceOption,
} from "../claudeCode/modelCatalog";
import {
  fetchClaudePermissionModeCatalog,
  reconcileClaudePermissionMode,
} from "../claudeCode/permissionModes";
import {
  getCodexBinaryPathPref,
  getCodexReasoningModePref,
  getCodexRuntimeModelPref,
  isCodexAppServerModeEnabled,
  isNativeZoteroMcpToolsEnabled,
  setCodexBinaryPathPref,
  setNativeZoteroMcpToolsEnabled,
  setCodexReasoningModePref,
  setCodexPermissionStatePref,
  setCodexRuntimeModelPref,
} from "../codexAppServer/prefs";
import {
  getCodexPermissionOptionCatalog,
  getCodexPermissionStatusText,
  subscribeCodexPermissionProcessChanges,
  type CodexPermissionOptionCatalog,
} from "../codexAppServer/permissionProfiles";
import { applyCodexPermissionChoice } from "../codexAppServer/permissionState";
import { applyCodexAppServerModePreferenceChange } from "../codexAppServer/modePreference";
import { getConfiguredCodexAppServerBinaryPath } from "../codexAppServer/binaryPath";
import {
  getCodexAppServerReasoningChoices,
  CODEX_CUSTOMIZED_MODEL_OPTION_KEY,
  loadCodexAppServerModelCatalog,
  resolveCodexAppServerReasoningSelection,
  type CodexAppServerModelCatalogEntry,
} from "../codexAppServer/modelCatalog";
import {
  installOrUpdateCodexZoteroMcpConfig,
  probeCodexZoteroMcpThroughAppServer,
  readCodexNativeMcpSetupStatus,
} from "../codexAppServer/mcpSetup";
import {
  describeCodexZoteroMcpFailure,
  formatCodexZoteroMcpError,
} from "../codexAppServer/mcpErrors";
import {
  getClaudeRuntimeRootDir,
  getClaudeUserHomeDir,
} from "../claudeCode/projectSkills";
import { applyClaudeCodeModePreferenceChange } from "../claudeCode/bootstrapGate";
import {
  getTavilyApiKey,
  setTavilyApiKey,
  getWebAccessProvider,
} from "../webAccess/prefs";
import { registerWebAccessPreferences } from "./preferences/webAccessPanel";
import { TavilyClient } from "../webAccess/tavilyClient";
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
  "Uses credentials from `codex login` to call the Codex backend directly through the llm-for-zotero harness. This convenient legacy mode does not provide App Server sessions, MCP or runtime management, sandbox controls, approvals, or permission settings. Use Codex App Server for the full Codex runtime experience.";
const CODEX_APP_SERVER_HELPER_TEXT =
  "Recommended official Codex integration. Runs the local `codex app-server` CLI as the native Codex runtime. Run `codex login` first.";
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
const MAX_PROVIDER_COUNT = 10;
const INITIAL_PROVIDER_COUNT = 4;

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
    modelPlaceholder: "deepseek-flash",
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

const DEFAULT_AGENT_BRIDGE_URL = "http://127.0.0.1:19787";

function getPresetSelectHelperText(presetId: ProviderPresetId): string {
  if (presetId === "customized") {
    return t(CUSTOMIZED_API_HELPER_TEXT);
  }
  return `${t(getProviderPreset(presetId).helperText)} ${t("Switch to Customized to edit the URL manually.")}`;
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
  return getProviderPresetProtocolOptions(presetId).filter(
    (protocol) => protocol !== "codex_responses" && protocol !== "web_sync",
  );
}

function resolveSelectedProtocol(
  group: ModelProviderGroup,
  presetId: ProviderPresetId,
): ProviderProtocol {
  const allowed = getProtocolOptions(group.authMode, presetId);
  if (presetId !== "customized") {
    const defaultProtocol =
      group.authMode === "codex_auth" || group.authMode === "codex_app_server"
        ? "codex_responses"
        : group.authMode === "webchat"
          ? "web_sync"
          : group.authMode === "copilot_auth"
            ? "openai_chat_compat"
            : getProviderPreset(presetId).defaultProtocol;
    return allowed.includes(defaultProtocol) ? defaultProtocol : allowed[0];
  }
  const fallback =
    group.authMode === "codex_auth" || group.authMode === "codex_app_server"
      ? "codex_responses"
      : undefined;
  const shouldInferCustomizedProtocol =
    presetId === "customized" &&
    group.providerProtocol === "openai_chat_compat";
  const normalized = normalizeProviderProtocolForAuthMode({
    protocol: shouldInferCustomizedProtocol
      ? undefined
      : group.providerProtocol,
    authMode: group.authMode,
    apiBase: group.apiBase,
    ...(fallback ? { fallback } : {}),
  });
  return allowed.includes(normalized) ? normalized : allowed[0];
}

function resolveModelSelectedProtocol(
  group: ModelProviderGroup,
  presetId: ProviderPresetId,
  modelEntry: ModelProviderModel,
): ProviderProtocol {
  const allowed = getProtocolOptions(group.authMode, presetId);
  if (modelEntry.providerProtocol) {
    const normalized = normalizeProviderProtocolForAuthMode({
      protocol: modelEntry.providerProtocol,
      authMode: group.authMode,
      apiBase: group.apiBase,
      ...(presetId === "customized"
        ? {}
        : { fallback: getProviderPreset(presetId).defaultProtocol }),
    });
    if (allowed.includes(normalized)) return normalized;
  }
  return resolveSelectedProtocol(group, presetId);
}

// ── DOM helpers ────────────────────────────────────────────────────
// `el` and `iconBtn` live in utils/domHelpers so the profile editor and this
// pane render identical controls from one definition.

// ── Live profile editors ───────────────────────────────────────────
// Capability data (context window, thinking support) arrives asynchronously
// from the model catalog, so profile editors repaint when it lands instead of
// freezing whatever was cached when the pane mounted. One shared subscription
// serves every editor; disconnected editors are pruned on each notify, and
// the subscription retires itself when the last one is gone — the pane has no
// teardown hook, so lifecycle is keyed to the DOM. An editor the user is
// typing in is skipped: a repaint would eat the in-progress edit.

type LiveProfileEditor = { element: HTMLElement; refresh: () => void };
const liveProfileEditors: LiveProfileEditor[] = [];
let unsubscribeCapabilityUpdates: (() => void) | null = null;

function registerLiveProfileEditor(entry: LiveProfileEditor) {
  liveProfileEditors.push(entry);
  if (unsubscribeCapabilityUpdates) return;
  unsubscribeCapabilityUpdates = subscribeModelCapabilities(() => {
    for (let index = liveProfileEditors.length - 1; index >= 0; index -= 1) {
      if (!liveProfileEditors[index].element.isConnected) {
        liveProfileEditors.splice(index, 1);
      }
    }
    if (!liveProfileEditors.length) {
      unsubscribeCapabilityUpdates?.();
      unsubscribeCapabilityUpdates = null;
      return;
    }
    for (const editor of liveProfileEditors) {
      const active = editor.element.ownerDocument?.activeElement;
      if (active && editor.element.contains(active)) continue;
      editor.refresh();
    }
  });
}

// ── Provider model select (fetch & choose) ─────────────────────────

/**
 * Replace a provider-card model input with a native dropdown listing the
 * provider's live model catalog plus a trailing "Customized…" option.
 * Choosing "Customized…" reveals the classic text input for manual entry;
 * choosing a model from the list hides it again. The text input element is
 * the caller's — its existing listeners keep persisting typed values.
 *
 * Returns the row container and the status line to place under the row.
 */
function attachProviderModelSelect(args: {
  doc: Document;
  input: HTMLInputElement;
  group: Exclude<ModelProviderGroup, WebChatProviderGroup>;
  modelEntry: ModelProviderModel;
  onModelPicked: (modelId: string) => void;
}): { container: HTMLElement; statusEl: HTMLElement; refresh: () => void } {
  const { doc, input, group, modelEntry } = args;

  const container = createElement(doc, "div", PROVIDER_MODEL_SLOT_CLASS);
  const select = createElement(doc, "select", PROVIDER_MODEL_SELECT_CLASS);
  container.append(select, input);

  const statusEl = createElement(doc, "span", "llm-pref-hint");
  statusEl.style.display = "none";

  let userCustomized = false;
  let loading = false;
  let fetchToken = 0;

  const readSnapshot = () =>
    getModelCatalogStatus(buildProviderCatalogIdentity(group));

  const requiresApiKey = providerGroupRequiresApiKey(group);

  const currentStatus = () =>
    resolveProviderModelFetchStatus({
      apiKey: group.apiKey,
      loading,
      snapshot: readSnapshot(),
      requiresApiKey,
    });

  // The manual text input takes over while the catalog is unavailable, while
  // "Customized…" is explicitly active, and while the input has focus; the
  // dropdown returns once a catalog exists and the input is idle.
  const currentMode = () =>
    resolveModelEntryMode({
      status: currentStatus(),
      userCustomized,
      inputFocused: doc.activeElement === input,
    });

  const syncModes = () => {
    const manual = currentMode() === "manual";
    input.style.display = manual ? "" : "none";
    select.style.display = manual ? "none" : "";
  };

  let renderedOptionsSignature = "";
  const rewriteOptions = () => {
    const manual = currentMode() === "manual";
    const rows = buildProviderModelSelectRows({
      savedModel: modelEntry.model,
      catalog: readSnapshot()?.models || [],
      customizedActive: manual,
    });
    const desiredValue = manual
      ? CUSTOMIZED_MODEL_OPTION_VALUE
      : modelEntry.model.trim();
    // Skip the DOM rewrite when nothing changed: a TTL-cached refresh resolves
    // right after mousedown, and replacing options under the just-opened
    // native popup can flicker or close it.
    const signature =
      rows
        .map((row) => `${row.kind}:${row.kind === "model" ? row.id : ""}`)
        .join("\n") + `\u0000${desiredValue}`;
    if (signature === renderedOptionsSignature) return;
    renderedOptionsSignature = signature;
    select.textContent = "";
    for (const row of rows) {
      const option = el(doc, "option") as HTMLOptionElement;
      if (row.kind === "placeholder") {
        option.value = "";
        option.textContent = t("Select a model…");
        option.disabled = true;
      } else if (row.kind === "model") {
        option.value = row.id;
        option.textContent = row.id;
      } else {
        option.value = CUSTOMIZED_MODEL_OPTION_VALUE;
        option.textContent = t("Customized…");
      }
      select.appendChild(option);
    }
    select.value = desiredValue;
  };
  // Rewriting the options while the native popup is open crashes Gecko's
  // popup helper (SelectChild "this.element is null"), so rebuilds triggered
  // by an async catalog refresh wait until the popup is provably closed.
  const rebuildGate = createSelectRebuildGate(rewriteOptions);
  const rebuildOptions = rebuildGate.requestRebuild;

  const updateStatus = () => {
    const status = currentStatus();
    if (status.kind === "needs_api_key") {
      statusEl.textContent = t(
        "Enter the API key above to fetch this provider's models.",
      );
      statusEl.style.color = "var(--fill-secondary, #888)";
      statusEl.style.display = "block";
    } else if (status.kind === "loading") {
      statusEl.textContent = t("Fetching models…");
      statusEl.style.color = "var(--fill-secondary, #888)";
      statusEl.style.display = "block";
    } else {
      // "manual_entry" is deliberately silent: the row already fell back to
      // the plain text input, so an error line would only add noise.
      statusEl.style.display = "none";
    }
    syncModes();
  };

  const refreshCatalog = async () => {
    if (requiresApiKey && !group.apiKey.trim()) {
      updateStatus();
      return;
    }
    const token = ++fetchToken;
    loading = true;
    updateStatus();
    try {
      await refreshModelCatalog(buildProviderCatalogIdentity(group));
    } finally {
      if (token === fetchToken) {
        loading = false;
        rebuildOptions();
        updateStatus();
      }
    }
  };

  // The refresh is TTL-cached, so re-checking on every open stays cheap and
  // picks up an API key the user pasted since the card rendered. Both
  // handlers run before the popup opens, so the gate can still flush a
  // pending rebuild into the popup the user is about to see.
  attachCodexDirectCatalogInteractions({
    target: select,
    popupMayOpen: () => rebuildGate.popupMayOpen(),
    refreshCatalog: () => void refreshCatalog(),
  });
  select.addEventListener("blur", () => rebuildGate.popupClosed());
  const applyModelChoice = (chosenValue: string) => {
    rebuildGate.popupClosed();
    if (chosenValue === CUSTOMIZED_MODEL_OPTION_VALUE) {
      userCustomized = true;
      input.value = modelEntry.model;
      syncModes();
      rebuildOptions();
      input.focus();
      return;
    }
    userCustomized = false;
    input.value = chosenValue;
    args.onModelPicked(chosenValue);
    syncModes();
    rebuildOptions();
  };
  select.addEventListener("change", () => {
    // Hiding the select (Customized…) or rewriting its options inside the
    // change dispatch re-enters Gecko's popup teardown and crashes it
    // ("this.element is null" in SelectChild.sys.mjs) — same invariant as the
    // deferred rerender() in the auth-mode/preset selects below.
    const chosenValue = select.value;
    runAfterSelectChangeDispatch(() => applyModelChoice(chosenValue));
  });

  const exitCustomized = () => {
    userCustomized = false;
    // With the catalog still unavailable the mode stays manual, so the typed
    // value keeps its field; otherwise the dropdown returns with it listed.
    syncModes();
    rebuildOptions();
  };
  input.addEventListener("blur", exitCustomized);
  input.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") input.blur();
  });

  syncModes();
  rebuildOptions();
  updateStatus();
  void refreshCatalog();

  return {
    container,
    statusEl,
    refresh: () => void refreshCatalog(),
  };
}

// ── Data helpers ───────────────────────────────────────────────────

function cloneGroups(groups: ModelProviderGroup[]): ModelProviderGroup[] {
  return groups.map((group) => {
    if (group.authMode === "codex_auth") {
      return { ...group, models: group.models.map((model) => ({ ...model })) };
    }
    if (group.authMode === "webchat") {
      return { ...group, models: group.models.map((model) => ({ ...model })) };
    }
    return { ...group, models: group.models.map((model) => ({ ...model })) };
  });
}

function persistGroups(groups: ModelProviderGroup[]) {
  setModelProviderGroups(cloneGroups(groups));
}

function ensureModels(
  group: Exclude<
    ModelProviderGroup,
    CodexDirectProviderGroup | WebChatProviderGroup
  >,
  profile: ProviderProfile,
): ModelProviderModel[] {
  if (group.models.length > 0) return group.models.map((m) => ({ ...m }));
  return [createProviderModelEntry(profile.defaultModel)];
}

function isProviderEmpty(group: ModelProviderGroup): boolean {
  if (group.authMode === "codex_auth" || group.authMode === "webchat") {
    return false;
  }
  return (
    !group.apiBase.trim() &&
    !group.apiKey.trim() &&
    group.models.every((m) => !m.model.trim())
  );
}

function hasEmptyModel(group: ModelProviderGroup): boolean {
  return group.models.some((m) => !m.model.trim());
}

function syncProviderAddModelButton(
  button: HTMLButtonElement,
  group: ModelProviderGroup,
): void {
  const canAdd = !hasEmptyModel(group);
  button.disabled = !canAdd;
  button.style.opacity = canAdd ? "1" : "0.35";
  button.title = canAdd
    ? t("Add model")
    : t("Fill in the current model name first");
}

function normalizeAuthMode(value: unknown): ModelProviderAuthMode {
  if (value === "webchat") return "webchat"; // [webchat]
  if (value === "codex_auth") return "codex_auth";
  if (value === "codex_app_server") return "codex_app_server";
  if (value === "copilot_auth") return "copilot_auth";
  return "api_key";
}

// ── Style tokens ───────────────────────────────────────────────────

// The AI Providers tab renders from the shared `.llm-pref-*` stylesheet in
// preferences.xhtml. These inline tokens are what is left for the surfaces
// that stylesheet does not reach: the Embedding Provider card on the
// Customization tab, and the GitHub device-code dialog, which mounts on
// document.body outside any panel.
//
// Inputs use CSS system colors (Field / FieldText) so they automatically
// match Zotero's native input appearance in both light and dark mode.
// Borders use --llm-pref-stroke, defined on the prefs root: Zotero never
// defines --stroke-secondary, so that fell back to a light #c8c8c8.
const INPUT_STYLE =
  "width: 100%; padding: 6px 10px; font-size: 13px;" +
  " border: 1px solid var(--llm-pref-stroke); border-radius: 6px;" +
  " box-sizing: border-box;";

const LABEL_STYLE =
  "display: block; font-weight: 600; font-size: 12px;" +
  " color: var(--fill-primary, inherit); margin-bottom: 4px;";

const HELPER_STYLE =
  "font-size: 11px; color: var(--fill-secondary, #888); margin-top: 3px; display: block;";

const PRIMARY_BTN_STYLE =
  "padding: 5px 12px; font-size: 12px; font-weight: 600;" +
  " background: var(--color-accent, #2563eb); color: #fff;" +
  " border: none; border-radius: 6px; cursor: pointer; white-space: nowrap; flex-shrink: 0;";

const OUTLINE_BTN_STYLE =
  "padding: 4px 10px; font-size: 12px; font-weight: 500; white-space: nowrap; flex-shrink: 0;" +
  " background: transparent; color: var(--color-accent, #2563eb);" +
  " border: 1px solid var(--color-accent, #2563eb); border-radius: 5px; cursor: pointer;";

// The Embedding Provider card mirrors a provider row: a head in the chrome
// colour over a body in the card surface, from the same tokens.
const CARD_STYLE =
  "border: 1px solid var(--llm-pref-stroke); border-radius: 10px;" +
  " background: var(--llm-pref-surface); overflow: hidden;";

const CARD_HEADER_STYLE =
  "display: flex; align-items: center; justify-content: space-between;" +
  " min-height: 42px; padding: 0 12px; background: var(--llm-pref-head);" +
  " color: FieldText; border-bottom: 1px solid var(--llm-pref-stroke);";

const CARD_BODY_STYLE =
  "display: flex; flex-direction: column; gap: 12px; padding: 14px;";

/**
 * The card's first block: how this provider authenticates and where it lives.
 * `.llm-pref-section` supplies its own separator from the next section, so
 * the old hand-drawn divider between connection and models is gone.
 */
function connectionSection(
  doc: Document,
  fields: HTMLElement[],
): HTMLDivElement {
  const section = createElement(doc, "div", "llm-pref-section");
  section.appendChild(
    createElement(doc, "span", "llm-pref-section-title", {
      textContent: t("Connection"),
    }),
  );
  section.append(...fields);
  return section;
}

/**
 * One row of the provider card's fixed label column — the same
 * `.llm-pref-field` grid the Agent tab uses, so labels line up down the whole
 * tab. Controls are appended to `control`; hints go there too.
 */
function prefField(
  doc: Document,
  labelText: string,
): { wrap: HTMLDivElement; label: HTMLLabelElement; control: HTMLDivElement } {
  const wrap = createElement(doc, "div", "llm-pref-field");
  const label = createElement(doc, "label", undefined, {
    textContent: labelText,
  });
  const control = createElement(doc, "div", "llm-pref-control");
  wrap.append(label, control);
  return { wrap, label, control };
}

/** A hint line under a control. */
function prefHint(doc: Document, text: string): HTMLSpanElement {
  return createElement(doc, "span", "llm-pref-hint", { textContent: text });
}

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

  const dialog = new ztoolkit.Dialog(1, 1)
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
  const unregisterDialog = registerAddonDialog(dialog);
  try {
    await (dialogData as { unloadLock: { promise: Promise<void> } }).unloadLock
      .promise;
  } finally {
    unregisterDialog();
  }
  return (dialogData as { _lastButtonId?: string })._lastButtonId === "delete";
}

async function confirmCodexFullAccess(): Promise<boolean> {
  const dialogData: { [key: string]: unknown } = {
    loadCallback: () => {
      return;
    },
    unloadCallback: () => {
      return;
    },
  };
  const dialog = new ztoolkit.Dialog(1, 1)
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      properties: {
        textContent: t(
          "Codex will have unrestricted access to the internet and any file available to Codex.",
        ),
      },
      styles: {
        width: "420px",
        lineHeight: "1.45",
        whiteSpace: "pre-line",
      },
    })
    .addButton(t("Enable full access"), "enable")
    .addButton(t("Cancel"), "cancel")
    .setDialogData(dialogData)
    .open(t("Enable Codex full access?"));
  const unregisterDialog = registerAddonDialog(dialog);
  try {
    await (dialogData as { unloadLock: { promise: Promise<void> } }).unloadLock
      .promise;
  } finally {
    unregisterDialog();
  }
  return (dialogData as { _lastButtonId?: string })._lastButtonId === "enable";
}

// ── Main export ────────────────────────────────────────────────────

export async function registerPrefsScripts(_window: Window | undefined | null) {
  if (!_window) {
    appLogger.debug("Preferences window not available");
    return;
  }

  const doc = _window.document;
  const notifyMineruParseFiltersChanged = () => {
    _window.dispatchEvent(
      new _window.CustomEvent(MINERU_PARSE_FILTERS_CHANGED_EVENT),
    );
  };
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Loading the provider groups runs preference migrations before the notice
  // is consumed. Keep this informational and nonblocking.
  getModelProviderGroups();
  if (consumeOutputTokenAutoMigrationNotice()) {
    try {
      const notice = new (
        Zotero as unknown as {
          ProgressWindow: new () => {
            changeHeadline: (text: string) => void;
            addDescription: (text: string) => void;
            show: () => void;
            close: () => void;
          };
        }
      ).ProgressWindow();
      notice.changeHeadline(t("Output limits updated"));
      notice.addDescription(
        t(
          "Output limits were reset to Auto in this update. You can set a custom per-response limit in Advanced settings.",
        ),
      );
      notice.show();
      setTimeout(() => notice.close(), 6000);
    } catch (err) {
      appLogger.warn("LLM: failed to show output-limit migration notice", err);
    }
  }

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
    const elements = container.querySelectorAll(
      "label, span, div, summary, button, option, a",
    );
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i] as HTMLElement;
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
  const translateAttributes = (container: Element) => {
    const elements = container.querySelectorAll(
      "[placeholder], [title], [aria-label]",
    );
    const attrs = ["placeholder", "title", "aria-label"] as const;
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      for (const attr of attrs) {
        const value = el.getAttribute(attr);
        if (!value?.trim()) continue;
        const translated = t(normalizeWs(value));
        if (translated !== value) el.setAttribute(attr, translated);
      }
    }
  };
  const prefPanels = doc.querySelectorAll("[data-pref-panel]");
  for (let i = 0; i < prefPanels.length; i++) {
    translateTextNodes(prefPanels[i]);
    translateAttributes(prefPanels[i]);
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
  }
  // Translate restart hint
  const restartHint = doc.querySelector(
    `#${config.addonRef}-locale-restart-hint`,
  ) as HTMLElement | null;
  if (restartHint)
    restartHint.textContent = t("Restart Zotero to apply language change.");

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
  const tavilyApiKeyInput = doc.querySelector(
    `#${config.addonRef}-tavily-api-key`,
  ) as HTMLInputElement | null;
  const tavilyTestButton = doc.querySelector(
    `#${config.addonRef}-tavily-test`,
  ) as HTMLButtonElement | null;
  const tavilyStatus = doc.querySelector(
    `#${config.addonRef}-tavily-status`,
  ) as HTMLSpanElement | null;
  const tavilyKeyLink = doc.querySelector(
    `#${config.addonRef}-tavily-key-link`,
  ) as HTMLAnchorElement | null;
  const codexAppServerEnableToggle = doc.querySelector(
    `#${config.addonRef}-codex-app-server-enable`,
  ) as HTMLInputElement | null;
  const codexAppServerSettingsWrap = doc.querySelector(
    `#${config.addonRef}-codex-app-server-settings`,
  ) as HTMLDivElement | null;
  const codexAppServerModelSelect = doc.querySelector(
    `#${config.addonRef}-codex-app-server-model`,
  ) as HTMLSelectElement | null;
  const codexAppServerCustomModelWrap = doc.querySelector(
    `#${config.addonRef}-codex-app-server-custom-model-wrap`,
  ) as HTMLDivElement | null;
  const codexAppServerCustomModelInput = doc.querySelector(
    `#${config.addonRef}-codex-app-server-custom-model`,
  ) as HTMLInputElement | null;
  const codexAppServerModelStatus = doc.querySelector(
    `#${config.addonRef}-codex-app-server-model-status`,
  ) as HTMLSpanElement | null;
  const codexAppServerModelRefreshButton = doc.querySelector(
    `#${config.addonRef}-codex-app-server-model-refresh`,
  ) as HTMLButtonElement | null;
  // The Codex model is whatever the catalog select names, unless the user
  // picked "Customized" and typed one the installed CLI knows about.
  const resolveCodexModelValue = (): string =>
    codexAppServerModelSelect?.value === CODEX_CUSTOMIZED_MODEL_OPTION_KEY
      ? codexAppServerCustomModelInput?.value.trim() || ""
      : codexAppServerModelSelect?.value.trim() || "";
  const codexAppServerReasoningSelect = doc.querySelector(
    `#${config.addonRef}-codex-app-server-reasoning`,
  ) as HTMLSelectElement | null;
  const codexPermissionProfileSelect = doc.querySelector(
    `#${config.addonRef}-codex-app-server-permission-profile`,
  ) as HTMLSelectElement | null;
  const codexPermissionProfileStatus = doc.querySelector(
    `#${config.addonRef}-codex-app-server-permission-status`,
  ) as HTMLSpanElement | null;
  const codexPermissionProfileRefresh = doc.querySelector(
    `#${config.addonRef}-codex-app-server-permission-refresh`,
  ) as HTMLButtonElement | null;
  const codexAppServerPathInput = doc.querySelector(
    `#${config.addonRef}-codex-app-server-path`,
  ) as HTMLInputElement | null;
  const codexAppServerPathHelper = doc.querySelector(
    `#${config.addonRef}-codex-app-server-path-helper`,
  ) as HTMLSpanElement | null;
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

  // Which provider rows are expanded. `rerender` rebuilds the whole list, so
  // the open set lives outside it — otherwise adding a model or switching an
  // auth mode would slam the row shut under the user's hands. Seeded once:
  // a provider that still needs setting up starts open, a finished one starts
  // closed, and from then on only the user's clicks move it.
  const openProviderIds = new Set<string>(
    groups
      .filter((group) => !describeProviderRow(group).configured)
      .map((group) => group.id),
  );

  // Mutable reference so input listeners inside rerender can update the
  // "Add Provider" button state without triggering a full rerender.
  let syncAddProviderBtn: () => void = () => undefined;
  let directCardControllers: CodexDirectProviderCardController[] = [];
  const disposeDirectCardControllers = () => {
    directCardControllers.forEach((controller) => controller.dispose());
    directCardControllers = [];
  };
  _window.addEventListener("unload", disposeDirectCardControllers, {
    once: true,
  });

  // ── Render ────────────────────────────────────────────────────────

  const rerender = () => {
    disposeDirectCardControllers();
    modelSections.innerHTML = "";

    modelSections.appendChild(
      createElement(doc, "p", "llm-pref-intro", {
        textContent: t(
          "Each provider has an auth mode, an endpoint, and one or more model variants. Open a provider to configure it; the model you pick in the chat header answers a given turn.",
        ),
      }),
    );

    const wrap = createElement(doc, "div", "llm-pref-group");
    wrap.appendChild(
      createElement(doc, "span", "llm-pref-group-title", {
        textContent: t("Providers"),
      }),
    );
    modelSections.appendChild(wrap);

    // ── Per-provider cards ─────────────────────────────────────────

    groups.forEach((group, groupIndex) => {
      const profile = getProviderProfile(groupIndex);
      const cardMode = createProviderCardModeSpec(group.authMode);
      if (group.authMode === "codex_auth") {
        if (!group.models.length) {
          group.models = [createCodexDirectModelRow()];
        }
      } else if (group.authMode === "webchat") {
        if (!group.models.length) {
          group.models = [createWebChatTargetRow()];
        }
      } else {
        group.models = ensureModels(group, profile);
      }

      // ── Row shell ────────────────────────────────────────────────
      // A provider is the same collapsible row as a runtime on the Agent
      // tab: the head answers "is this set up, and as what?" while closed.
      const description = describeProviderRow(group);
      const card = createElement(doc, "div", "llm-pref-row");
      const open = openProviderIds.has(group.id);
      card.setAttribute("data-open", String(open));
      card.setAttribute("data-llm-provider-row", group.id);

      const cardHeader = createElement(
        doc,
        "div",
        "llm-pref-row-head llm-pref-row-head--plain",
      );
      cardHeader.appendChild(
        createElement(
          doc,
          "span",
          `llm-pref-row-icon llm-pref-row-icon--${description.iconModifier}`,
        ),
      );
      const cardToggle = createElement(doc, "button", "llm-pref-row-toggle", {
        type: "button",
      });
      cardToggle.setAttribute("aria-expanded", String(open));
      cardToggle.appendChild(
        createElement(doc, "span", "llm-pref-row-name", {
          textContent: profile.label,
        }),
      );
      const cardSub = createElement(doc, "span", "llm-pref-row-sub");
      const cardDot = createElement(doc, "span", "llm-pref-row-dot");
      cardDot.setAttribute("data-on", String(description.configured));
      cardSub.append(
        cardDot,
        createElement(doc, "span", "llm-pref-row-summary", {
          textContent: description.summary,
        }),
      );
      cardToggle.appendChild(cardSub);
      cardHeader.appendChild(cardToggle);
      cardHeader.appendChild(
        createElement(doc, "span", "llm-pref-row-tag", {
          textContent: description.tag,
        }),
      );
      cardHeader.appendChild(
        createElement(doc, "span", "llm-pref-row-chevron", {
          textContent: "\u203A",
        }),
      );

      // Card body
      const cardBody = createElement(doc, "div", "llm-pref-row-body");
      cardBody.hidden = !open;
      const cardBodyId = `${config.addonRef}-provider-row-${group.id}-body`;
      cardBody.id = cardBodyId;
      cardToggle.setAttribute("aria-controls", cardBodyId);
      cardToggle.addEventListener("click", () => {
        const nextOpen = !openProviderIds.has(group.id);
        if (nextOpen) openProviderIds.add(group.id);
        else openProviderIds.delete(group.id);
        card.setAttribute("data-open", String(nextOpen));
        cardToggle.setAttribute("aria-expanded", String(nextOpen));
        cardBody.hidden = !nextOpen;
      });

      // Removing a provider is destructive, so it lives at the foot of the
      // open body rather than in the head, where the Agent tab puts a switch.
      const removeProvBtn = createElement(
        doc,
        "button",
        "llm-pref-button llm-pref-button--danger",
        { type: "button", textContent: t("Remove provider") },
      );
      removeProvBtn.addEventListener("click", () => {
        const removesSelectedModel = group.models.some(
          (model) => model.id === getLastUsedModelEntryId(),
        );
        const nextGroups = groups.filter((_, index) => index !== groupIndex);
        if (removesSelectedModel) {
          setLastUsedModelEntryId(getFirstSelectableModelEntryId(nextGroups));
        }
        openProviderIds.delete(group.id);
        groups.splice(groupIndex, 1);
        persistGroups(groups);
        rerender();
      });

      /** Assemble the row: every auth mode finishes the same way. */
      const finishProviderRow = () => {
        const footer = createElement(
          doc,
          "div",
          "llm-pref-section llm-pref-section--footer",
        );
        footer.appendChild(removeProvBtn);
        cardBody.appendChild(footer);
        card.append(cardHeader, cardBody);
        wrap.appendChild(card);
      };

      // ── Auth mode ────────────────────────────────────────────────
      const {
        wrap: authModeWrap,
        label: authModeLabel,
        control: authModeControl,
      } = prefField(doc, t("Auth mode"));
      const authModeSelect = createElement(doc, "select", "llm-pref-select");
      authModeSelect.id = `${config.addonRef}-auth-mode-${group.id}`;
      authModeLabel.setAttribute("for", authModeSelect.id);
      const apiKeyOption = el(doc, "option") as HTMLOptionElement;
      apiKeyOption.value = "api_key";
      apiKeyOption.textContent = t("API Key");
      apiKeyOption.selected = group.authMode === "api_key";
      const codexAppServerOption = el(doc, "option") as HTMLOptionElement;
      codexAppServerOption.value = "codex_app_server";
      codexAppServerOption.textContent = t(
        "Codex App Server (native runtime settings)",
      );
      codexAppServerOption.selected = group.authMode === "codex_app_server";
      const codexOption = el(doc, "option") as HTMLOptionElement;
      codexOption.value = "codex_auth";
      codexOption.textContent = t("Codex Direct (Legacy)");
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
      if (
        group.authMode === "codex_auth" ||
        canOfferCodexDirectAuthMode(groups, group.id)
      ) {
        authModeSelect.append(codexOption);
      }
      authModeSelect.append(copilotOption, webchatOption);
      authModeSelect.addEventListener("change", () => {
        const nextAuthMode = normalizeAuthMode(authModeSelect.value);
        groups[groupIndex] = transitionProviderAuthMode(group, nextAuthMode);
        persistGroups(groups);
        setTimeout(() => rerender(), 0);
      });
      const authModeHelperText =
        group.authMode === "webchat"
          ? t(
              'Relay questions to %targets% via the Sync for Zotero browser extension. Download extension: github.com/yilewang/sync-for-zotero → Releases. Unzip, open chrome://extensions, enable Developer Mode, click "Load unpacked", select the extension folder. Keep the corresponding chat tab open while using WebChat mode.',
            ).replace(
              "%targets%",
              WEBCHAT_TARGETS.map((wt) => wt.label).join(" / "),
            )
          : group.authMode === "copilot_auth"
            ? t(COPILOT_API_HELPER_TEXT)
            : group.authMode === "codex_auth"
              ? t(LEGACY_CODEX_AUTH_HELPER_TEXT)
              : group.authMode === "codex_app_server"
                ? t(CODEX_APP_SERVER_HELPER_TEXT)
                : "";
      authModeControl.append(authModeSelect);
      if (authModeHelperText) {
        authModeControl.append(prefHint(doc, authModeHelperText));
      }

      const selectedPresetId = resolveProviderPresetId(group);
      const selectedPreset =
        selectedPresetId === "customized"
          ? null
          : getProviderPreset(selectedPresetId);
      const isCustomizedPreset =
        group.authMode !== "codex_auth" &&
        group.authMode !== "codex_app_server" &&
        group.authMode !== "copilot_auth" &&
        selectedPresetId === "customized";
      // Local runtimes serve unauthenticated, so the key field, the connection
      // test and the model catalog must all work with the key left blank.
      const presetRequiresApiKey =
        group.authMode !== "api_key" ||
        providerPresetRequiresApiKey(selectedPresetId);
      group.providerProtocol = resolveSelectedProtocol(group, selectedPresetId);

      if (group.authMode === "codex_auth") {
        const controller = createCodexDirectProviderCardController({
          doc,
          group,
          onGroupChange: (next) => {
            groups[groupIndex] = next;
            persistGroups(groups);
            rerender();
          },
          getFetch: () =>
            ztoolkit.getGlobal("fetch") as typeof fetch | undefined,
        });
        directCardControllers.push(controller);

        cardBody.append(
          connectionSection(doc, [authModeWrap]),
          controller.element,
        );
        finishProviderRow();
        return;
      }

      // ── Provider preset ─────────────────────────────────────────
      const {
        wrap: providerPresetWrap,
        label: providerPresetLabel,
        control: providerPresetControl,
      } = prefField(doc, t("Provider"));
      if (cardMode.showProviderPreset) {
        const providerPresetSelect = createElement(
          doc,
          "select",
          "llm-pref-select",
        );
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
          const nextPresetId =
            normalizeProviderPresetId(providerPresetSelect.value) ??
            "customized";
          group.presetIdOverride = nextPresetId;
          // Customized keeps the existing URL so the user can edit it.
          if (nextPresetId !== "customized") {
            group.apiBase = getProviderPreset(nextPresetId).defaultApiBase;
            group.providerProtocol =
              getProviderPreset(nextPresetId).defaultProtocol;
          }
          persistGroups(groups);
          // Defer rerender so the browser can close the dropdown before we replace the DOM
          // (avoids "this.element is null" in Firefox's SelectChild.sys.mjs)
          setTimeout(() => rerender(), 0);
        });

        providerPresetControl.append(providerPresetSelect);
      }

      // ── API URL ──────────────────────────────────────────────────
      const {
        wrap: apiUrlWrap,
        label: apiUrlLabel,
        control: apiUrlControl,
      } = prefField(
        doc,
        group.authMode === "codex_app_server"
          ? t("Codex CLI path")
          : t("API URL"),
      );
      const apiUrlInput = createElement(doc, "input", "llm-pref-input");
      apiUrlInput.id = `${config.addonRef}-api-base-${group.id}`;
      apiUrlLabel.setAttribute("for", apiUrlInput.id);
      apiUrlInput.type = "text";
      apiUrlInput.placeholder =
        group.authMode === "codex_app_server"
          ? t("Optional absolute path to codex executable")
          : group.authMode === "copilot_auth"
            ? DEFAULT_COPILOT_API_BASE
            : selectedPreset?.defaultApiBase || "https://api.openai.com/v1";
      apiUrlInput.value = group.apiBase || "";
      apiUrlInput.readOnly =
        group.authMode !== "codex_app_server" &&
        group.authMode !== "copilot_auth" &&
        !isCustomizedPreset &&
        // Local presets ship a default host and port, but the server may run on
        // another port or another machine on the LAN, so the URL stays editable.
        presetRequiresApiKey;
      apiUrlInput.style.opacity = apiUrlInput.readOnly ? "0.85" : "1";
      apiUrlInput.style.cursor = apiUrlInput.readOnly ? "default" : "text";
      apiUrlInput.style.pointerEvents = apiUrlInput.readOnly ? "none" : "auto";
      apiUrlInput.title = apiUrlInput.readOnly
        ? t("Switch Provider to Customized to edit this URL manually.")
        : "";
      apiUrlInput.addEventListener("input", () => {
        if (group.authMode === "webchat") return;
        group.apiBase = apiUrlInput.value;
        persistGroups(groups);
        syncAddProviderBtn();
      });
      const apiUrlHelper = prefHint(
        doc,
        group.authMode === "codex_app_server"
          ? t(getCodexAppServerPathHelperText())
          : group.authMode === "copilot_auth"
            ? t(COPILOT_API_HELPER_TEXT)
            : getPresetSelectHelperText(selectedPresetId),
      );
      apiUrlControl.append(apiUrlInput, apiUrlHelper);

      // ── API Key ──────────────────────────────────────────────────
      const {
        wrap: apiKeyWrap,
        label: apiKeyLabel,
        control: apiKeyControl,
      } = prefField(
        doc,
        presetRequiresApiKey ? t("API key") : t("API key (optional)"),
      );
      const apiKeyInput = createElement(doc, "input", "llm-pref-input");
      apiKeyInput.id = `${config.addonRef}-api-key-${group.id}`;
      apiKeyLabel.setAttribute("for", apiKeyInput.id);
      apiKeyInput.type = "password";
      apiKeyInput.placeholder = presetRequiresApiKey
        ? "sk-…"
        : t("Leave blank unless your server requires auth");
      apiKeyInput.value = group.apiKey || "";
      // Model dropdowns register here so a freshly pasted key refetches their
      // catalogs without reopening the pane. Debounced to sit out keystrokes.
      const modelPickerRefreshers: Array<() => void> = [];
      let modelPickerRefreshTimer: ReturnType<typeof setTimeout> | null = null;
      apiKeyInput.addEventListener("input", () => {
        if (group.authMode === "webchat") return;
        group.apiKey = apiKeyInput.value;
        persistGroups(groups);
        syncAddProviderBtn();
        if (modelPickerRefreshTimer !== null)
          clearTimeout(modelPickerRefreshTimer);
        modelPickerRefreshTimer = setTimeout(() => {
          modelPickerRefreshTimer = null;
          if (!apiKeyInput.value.trim()) return;
          for (const refresh of modelPickerRefreshers) refresh();
        }, 800);
      });
      apiKeyControl.append(apiKeyInput);
      if (
        group.authMode === "codex_app_server" ||
        group.authMode === "copilot_auth"
      ) {
        apiKeyWrap.style.display = "none";
      }

      // ── Copilot Login ────────────────────────────────────────────
      const { wrap: copilotLoginWrap, control: copilotLoginControl } =
        prefField(doc, t("Sign-in"));
      if (group.authMode === "copilot_auth") {
        const isLoggedIn = group.apiKey.startsWith("ghu_");
        const copilotStatus = prefHint(
          doc,
          isLoggedIn ? t("Logged in to GitHub Copilot") : "",
        );

        const copilotLoginBtn = createElement(
          doc,
          "button",
          "llm-pref-button llm-pref-button--primary",
          {
            type: "button",
            textContent: isLoggedIn
              ? t("Re-login")
              : t("Login with GitHub Copilot"),
          },
        );

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

        const copilotLogoutBtn = createElement(
          doc,
          "button",
          "llm-pref-button",
          { type: "button", textContent: t("Log out") },
        );
        copilotLogoutBtn.style.display = isLoggedIn ? "inline-block" : "none";
        copilotLogoutBtn.addEventListener("click", () => {
          group.apiKey = "";
          persistGroups(groups);
          rerender();
        });

        const copilotBtnRow = createElement(doc, "div", "llm-pref-line");
        copilotBtnRow.append(copilotLoginBtn, copilotLogoutBtn);

        // ── Fetch models button ──
        const fetchModelsBtn = createElement(
          doc,
          "button",
          "llm-pref-button llm-pref-button--accent",
          { type: "button", textContent: t("Fetch available models") },
        );
        fetchModelsBtn.style.display = isLoggedIn ? "inline-block" : "none";
        const fetchModelsStatus = prefHint(doc, "");

        fetchModelsBtn.addEventListener("click", async () => {
          fetchModelsBtn.disabled = true;
          fetchModelsStatus.textContent = t("Fetching models…");
          fetchModelsStatus.style.color = "var(--fill-secondary, #888)";
          try {
            const models = await fetchCopilotModelList({
              githubToken: group.apiKey,
            });
            if (!models.length) {
              fetchModelsStatus.textContent = t(
                "No models found — type the model name instead.",
              );
              fetchModelsStatus.style.color = "var(--fill-secondary, #888)";
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
                      outputTokenLimit: existing.outputTokenLimit,
                      inputTokenCap: existing.inputTokenCap,
                      inputMode: existing.inputMode,
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
          } catch (_err) {
            // Keep fetch failures quiet: manual model entry still works.
            fetchModelsStatus.textContent = t(
              "Couldn't fetch models — type the model name instead.",
            );
            fetchModelsStatus.style.color = "var(--fill-secondary, #888)";
          } finally {
            fetchModelsBtn.disabled = false;
          }
        });

        const fetchModelsRow = createElement(doc, "div", "llm-pref-line");
        fetchModelsRow.append(fetchModelsBtn, fetchModelsStatus);

        copilotLoginControl.append(
          copilotBtnRow,
          copilotStatus,
          fetchModelsRow,
        );
      }

      // ── Models list ──────────────────────────────────────────────
      const {
        section: modelsWrap,
        header: modelsHeaderRow,
        addButton: addModelBtn,
      } = createProviderModelSectionBlueprint({
        doc,
        title: t("Models"),
        addTitle: t("Add model"),
      });
      if (group.authMode === "webchat") {
        // [webchat] Replace "+" with a "Fetch Models" button that adds all webchat targets
        addModelBtn.style.display = "none";
        const fetchModelsBtn = createElement(
          doc,
          "button",
          "llm-pref-button llm-pref-button--accent",
          { type: "button", textContent: t("Fetch Models") },
        );
        fetchModelsBtn.addEventListener("click", () => {
          const allTargets = WEBCHAT_TARGETS.map((wt) => wt.modelName);
          const existing = new Set(
            group.models.map((m: { model: string }) => m.model),
          );
          let added = false;
          for (const target of allTargets) {
            if (!existing.has(target)) {
              group.models.push(createWebChatTargetRow(target));
              added = true;
            }
          }
          if (added) {
            persistGroups(groups);
            rerender();
          }
        });
        modelsHeaderRow.insertBefore(fetchModelsBtn, addModelBtn);
      }

      const syncAddModelBtn = () =>
        syncProviderAddModelButton(addModelBtn, group);
      syncAddModelBtn();

      addModelBtn.addEventListener("click", () => {
        if (addModelBtn.disabled) return;
        if (group.authMode === "webchat") return;
        group.models.push(createProviderModelEntry(""));
        persistGroups(groups);
        rerender();
      });

      // ── Per-model rows ───────────────────────────────────────────
      if (group.authMode === "webchat") {
        group.models.forEach((modelEntry) => {
          const {
            row: rowWrap,
            controls: mainRow,
            testButton: testBtn,
            status: statusLine,
          } = createProviderModelRowBlueprint({
            doc,
            testLabel: t("Test"),
          });
          testBtn.style.display = "none";
          statusLine.style.display = "none";
          rowWrap.appendChild(
            prefHint(doc, t("Per-response output limit: Managed by runtime")),
          );
          const modelSelect = createElement(
            doc,
            "select",
            PROVIDER_MODEL_SELECT_CLASS,
          );
          for (const target of WEBCHAT_TARGETS) {
            const option = doc.createElement("option");
            option.value = target.modelName;
            option.textContent = `${target.modelName} (${target.label})`;
            option.selected = target.modelName === modelEntry.model;
            modelSelect.appendChild(option);
          }
          modelSelect.addEventListener("change", () => {
            modelEntry.model = modelSelect.value;
            persistGroups(groups);
          });
          mainRow.append(modelSelect);
          if (group.models.length > 1) {
            const removeModelBtn = iconBtn(doc, "×", t("Remove model"));
            removeModelBtn.addEventListener("click", () => {
              const wasLastUsed = getLastUsedModelEntryId() === modelEntry.id;
              group.models = group.models.filter(
                (entry) => entry.id !== modelEntry.id,
              );
              if (!group.models.length) {
                group.models = [createWebChatTargetRow()];
              }
              if (wasLastUsed) {
                setLastUsedModelEntryId(getFirstSelectableModelEntryId(groups));
              }
              persistGroups(groups);
              rerender();
            });
            mainRow.appendChild(removeModelBtn);
          }
          modelsWrap.appendChild(rowWrap);
        });
        cardBody.append(connectionSection(doc, [authModeWrap]), modelsWrap);
        finishProviderRow();
        return;
      }

      group.models.forEach((modelEntry, modelIndex) => {
        const {
          row: rowWrap,
          controls: mainRow,
          testButton: testBtn,
          status: statusLine,
        } = createProviderModelRowBlueprint({
          doc,
          testLabel: t("Test"),
        });

        const modelInput = createElement(
          doc,
          "input",
          PROVIDER_MODEL_INPUT_CLASS,
        );
        modelInput.type = "text";
        modelInput.value = modelEntry.model;
        modelInput.placeholder =
          modelIndex === 0 ? profile.modelPlaceholder : "";

        const advGearBtn = iconBtn(doc, "⚙", t("Advanced options"));

        // Status line owned by the fetch-and-select model dropdown, when used.
        let pickerStatusEl: HTMLElement | null = null;

        if (canFetchProviderModels(group)) {
          const picker = attachProviderModelSelect({
            doc,
            input: modelInput,
            group,
            modelEntry,
            onModelPicked: (modelId) => {
              const previousModel = modelEntry.model;
              modelEntry.model = modelId;
              onSelectedModelChanged(previousModel);
              persistGroups(groups);
              syncAddModelBtn();
              syncAddProviderBtn();
              syncAdvAvailability();
            },
          });
          pickerStatusEl = picker.statusEl;
          modelPickerRefreshers.push(picker.refresh);
          mainRow.append(picker.container, testBtn, advGearBtn);
        } else {
          mainRow.append(modelInput, testBtn, advGearBtn);
        }

        if (group.models.length > 1) {
          const removeModelBtn = iconBtn(doc, "×", t("Remove model"));
          removeModelBtn.addEventListener("click", () => {
            const wasLastUsed = getLastUsedModelEntryId() === modelEntry.id;
            group.models = group.models.filter((e) => e.id !== modelEntry.id);
            if (!group.models.length) {
              group.models = [createProviderModelEntry(profile.defaultModel)];
            }
            if (wasLastUsed) {
              setLastUsedModelEntryId(getFirstSelectableModelEntryId(groups));
            }
            persistGroups(groups);
            rerender();
          });
          mainRow.appendChild(removeModelBtn);
        }

        // ── Advanced section (hidden by default) ──────────────────
        const advRow = createElement(doc, "div", "llm-pref-advanced-panel");
        advRow.setAttribute("data-open", "false");

        const advFields = createElement(doc, "div", "llm-pref-compact-fields");

        const makeCompactField = (
          labelText: string,
          value: string,
          placeholder: string,
        ) => {
          const fieldWrap = createElement(doc, "div", "llm-pref-compact-field");
          const lbl = createElement(doc, "label", undefined, {
            textContent: labelText,
          });
          const input = createElement(
            doc,
            "input",
            "llm-pref-input llm-pref-input--sm",
          );
          input.type = "text";
          input.value = value;
          input.placeholder = t(placeholder);
          fieldWrap.append(lbl, input);
          return { wrap: fieldWrap, input };
        };

        const tempField = makeCompactField(
          t("Temperature"),
          `${modelEntry.temperature ?? DEFAULT_TEMPERATURE}`,
          `${DEFAULT_TEMPERATURE}`,
        );
        const resolveDetectedProfile = () =>
          getModelCapabilities({
            model: modelEntry.model,
            apiBase: group.apiBase,
            protocol: resolveModelSelectedProtocol(
              group,
              selectedPresetId,
              modelEntry,
            ),
            authMode: group.authMode,
            scope: group.id,
          });
        const outputLimitField = createElement(
          doc,
          "div",
          "llm-pref-compact-field",
        );
        const outputLimitLabel = createElement(doc, "label", undefined, {
          textContent: t("Per-response output limit"),
        });
        const outputLimitControls = createElement(doc, "div", "llm-pref-line");
        const outputLimitSelect = createElement(
          doc,
          "select",
          "llm-pref-select llm-pref-input--sm llm-pref-input--mode",
        );
        const outputLimitIsRuntimeManaged =
          group.authMode === "codex_app_server";
        for (const option of outputLimitIsRuntimeManaged
          ? [{ value: "managed", label: "Managed by runtime" }]
          : [
              { value: "auto", label: "Auto" },
              { value: "custom", label: "Custom" },
            ]) {
          const element = el(doc, "option") as HTMLOptionElement;
          element.value = option.value;
          element.textContent = t(option.label);
          outputLimitSelect.appendChild(element);
        }
        const outputLimitInput = createElement(
          doc,
          "input",
          "llm-pref-input llm-pref-input--sm",
        );
        outputLimitInput.type = "number";
        outputLimitInput.min = "1";
        outputLimitInput.step = "1";
        outputLimitInput.placeholder = "8192";
        const detectedOutputMaximum =
          resolveDetectedProfile().limits.outputTokens;
        if (detectedOutputMaximum) {
          outputLimitInput.max = `${detectedOutputMaximum}`;
        }
        outputLimitInput.value =
          modelEntry.outputTokenLimit.mode === "custom"
            ? `${modelEntry.outputTokenLimit.tokens}`
            : "";
        outputLimitSelect.value = outputLimitIsRuntimeManaged
          ? "managed"
          : modelEntry.outputTokenLimit.mode;
        const syncOutputLimitField = () => {
          const custom = outputLimitSelect.value === "custom";
          outputLimitInput.style.display = custom ? "" : "none";
          outputLimitInput.disabled = !custom;
        };
        syncOutputLimitField();
        outputLimitControls.append(outputLimitSelect, outputLimitInput);
        outputLimitField.append(outputLimitLabel, outputLimitControls);
        const inputCapField = makeCompactField(
          t("Input cap"),
          modelEntry.inputTokenCap !== undefined
            ? `${modelEntry.inputTokenCap}`
            : "",
          "optional",
        );

        const inputModeOptions = getModelInputModeOptionsForRuntime(
          group.authMode,
        );
        let inputModeFieldWrap: HTMLDivElement | null = null;
        let inputModeSelect: HTMLSelectElement | null = null;
        if (inputModeOptions.length > 0) {
          inputModeFieldWrap = createElement(
            doc,
            "div",
            "llm-pref-compact-field",
          );
          const inputModeFieldLabel = createElement(doc, "label", undefined, {
            textContent: t("Input mode"),
          });
          inputModeSelect = createElement(
            doc,
            "select",
            "llm-pref-select llm-pref-input--sm llm-pref-input--mode",
          );
          for (const mode of inputModeOptions) {
            const opt = el(doc, "option") as HTMLOptionElement;
            opt.value = mode;
            opt.textContent = t(getModelInputModeLabel(mode));
            inputModeSelect.appendChild(opt);
          }
          inputModeSelect.value = resolveModelInputMode(
            normalizeModelInputModeForRuntime(
              modelEntry.inputMode,
              group.authMode,
            ),
          );
          inputModeFieldWrap.append(inputModeFieldLabel, inputModeSelect);
        }

        // ── Per-model protocol override ──
        const protocolFieldWrap = createElement(
          doc,
          "div",
          "llm-pref-compact-field",
        );
        const protocolFieldLabel = createElement(doc, "label", undefined, {
          textContent: t("API protocol override"),
        });
        const protocolFieldSelect = createElement(
          doc,
          "select",
          "llm-pref-select llm-pref-input--sm llm-pref-input--protocol",
        );
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

        advFields.append(tempField.wrap, outputLimitField, inputCapField.wrap);
        if (inputModeFieldWrap) advFields.append(inputModeFieldWrap);
        advFields.append(protocolFieldWrap);
        const inputModeHelpText = inputModeFieldWrap
          ? "Temperature: randomness (0–2)  ·  Output limit applies to one response, including hidden reasoning on some APIs; it does not limit total Agent duration  ·  Input mode: auto/text-only/vision"
          : "Temperature: randomness (0–2)  ·  Output limit applies to one response, including hidden reasoning on some APIs; it does not limit total Agent duration";
        advRow.append(advFields, prefHint(doc, t(inputModeHelpText)));

        // ── Capability, reasoning and extra-parameter controls ───────────
        // Part of the same advanced panel rather than a nested disclosure:
        // one place lists everything customizable for this model, and the
        // fields above (temperature, max tokens, input cap, input mode) are
        // not repeated here.
        const profileEditor = createModelProfileEditor({
          doc,
          t,
          getOverride: () => modelEntry.profileOverride,
          getDetected: resolveDetectedProfile,
          getModelName: () => modelEntry.model,
          onChange: (next: ModelProfileOverride | undefined) => {
            if (next) {
              modelEntry.profileOverride = next;
            } else {
              delete modelEntry.profileOverride;
            }
            persistGroups(groups);
          },
          classes: {
            input: "llm-pref-input",
            inputSm: "llm-pref-input llm-pref-input--sm",
            helper: "llm-pref-hint",
            sectionLabel: "llm-pref-section-title",
            outlineBtn: "llm-pref-button",
          },
        });
        advRow.append(
          createElement(doc, "div", "llm-pref-advanced-rule"),
          profileEditor.element,
        );
        // The detected profile arrives asynchronously (catalog fetch), so the
        // editor repaints when capability data lands rather than seeding once
        // from whatever was cached at mount time.
        registerLiveProfileEditor({
          element: profileEditor.element,
          refresh: () => profileEditor.refresh(resolveDetectedProfile()),
        });

        /**
         * Parameters are tuned for one specific model, so pointing this entry
         * at a different one must not apply them there — the override carries
         * the model it was authored for and goes dormant on a mismatch (see
         * `forModel`), so a rename never destroys it and renaming back
         * restores it. The repaint swaps the panel to the new model's
         * detected profile.
         */
        function onSelectedModelChanged(previousModel: string) {
          if (previousModel.trim() === modelEntry.model.trim()) return;
          profileEditor.refresh(resolveDetectedProfile());
        }

        const commitAdvanced = () => {
          modelEntry.temperature = normalizeTemperature(tempField.input.value);
          modelEntry.outputTokenLimit =
            !outputLimitIsRuntimeManaged && outputLimitSelect.value === "custom"
              ? {
                  mode: "custom",
                  tokens: Math.min(
                    normalizeMaxTokens(outputLimitInput.value),
                    resolveDetectedProfile().limits.outputTokens ||
                      Number.MAX_SAFE_INTEGER,
                  ),
                }
              : { mode: "auto" };
          modelEntry.inputTokenCap = normalizeOptionalInputTokenCap(
            inputCapField.input.value,
          );
          const nextInputMode = inputModeSelect
            ? normalizeModelInputModeForRuntime(
                inputModeSelect.value,
                group.authMode,
              )
            : undefined;
          if (nextInputMode) {
            modelEntry.inputMode = nextInputMode;
          } else {
            delete modelEntry.inputMode;
          }
          modelEntry.providerProtocol = isProviderProtocol(
            protocolFieldSelect.value,
          )
            ? protocolFieldSelect.value
            : undefined;
          tempField.input.value = `${modelEntry.temperature}`;
          outputLimitSelect.value = outputLimitIsRuntimeManaged
            ? "managed"
            : modelEntry.outputTokenLimit.mode;
          outputLimitInput.value =
            modelEntry.outputTokenLimit.mode === "custom"
              ? `${modelEntry.outputTokenLimit.tokens}`
              : "";
          syncOutputLimitField();
          inputCapField.input.value =
            modelEntry.inputTokenCap !== undefined
              ? `${modelEntry.inputTokenCap}`
              : "";
          if (inputModeSelect) {
            inputModeSelect.value = resolveModelInputMode(
              normalizeModelInputModeForRuntime(
                modelEntry.inputMode,
                group.authMode,
              ),
            );
          }
          persistGroups(groups);
        };
        for (const f of [tempField, inputCapField]) {
          f.input.addEventListener("change", () => commitAdvanced());
          f.input.addEventListener("blur", () => commitAdvanced());
        }
        outputLimitSelect.addEventListener("change", () => commitAdvanced());
        outputLimitInput.addEventListener("change", () => commitAdvanced());
        outputLimitInput.addEventListener("blur", () => commitAdvanced());
        inputModeSelect?.addEventListener("change", () => commitAdvanced());
        protocolFieldSelect.addEventListener("change", () => commitAdvanced());

        const syncAdvAvailability = () => {
          const hasModel = Boolean(modelEntry.model.trim());
          advGearBtn.disabled = !hasModel;
          advGearBtn.style.opacity = hasModel ? "1" : "0.45";
          for (const f of [tempField, inputCapField])
            f.input.disabled = !hasModel;
          outputLimitSelect.disabled = !hasModel || outputLimitIsRuntimeManaged;
          outputLimitInput.disabled =
            !hasModel ||
            outputLimitIsRuntimeManaged ||
            outputLimitSelect.value !== "custom";
          if (inputModeSelect) inputModeSelect.disabled = !hasModel;
          protocolFieldSelect.disabled = !hasModel;
        };
        syncAdvAvailability();

        advGearBtn.addEventListener("click", () => {
          if (advGearBtn.disabled) return;
          const advOpen = advRow.getAttribute("data-open") !== "true";
          advRow.setAttribute("data-open", String(advOpen));
          advGearBtn.style.color = advOpen
            ? "var(--color-accent, #2563eb)"
            : "var(--fill-secondary, #888)";
        });

        modelInput.addEventListener("input", () => {
          const previousModel = modelEntry.model;
          modelEntry.model = modelInput.value;
          onSelectedModelChanged(previousModel);
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
              (authMode === "copilot_auth" ? DEFAULT_COPILOT_API_BASE : "")
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
                testZoteroMcp: isNativeZoteroMcpToolsEnabled(),
              });
              statusLine.textContent =
                `${t("Model connection: ")}✓ "${result.reply}"\n` +
                `${t("Agent capability: ")}${result.capabilityLabel}` +
                (result.mcpConnected
                  ? `\n${t("Zotero MCP connection verified through Codex.")}`
                  : "");
              statusLine.style.color = "green";
              return;
            }
            const apiKey =
              authMode === "copilot_auth"
                ? await resolveCopilotAccessToken({
                    githubToken: group.apiKey.trim(),
                  })
                : group.apiKey.trim();
            const modelName = (
              modelEntry.model ||
              profile.defaultModel ||
              "gpt-5.4"
            ).trim();
            const providerProtocol = resolveModelSelectedProtocol(
              group,
              selectedPresetId,
              modelEntry,
            );

            if (!apiBase) throw new Error(t("API URL is required"));
            if (!apiKey && presetRequiresApiKey) {
              throw new Error(
                authMode === "copilot_auth"
                  ? t("Copilot token missing. Click Login first.")
                  : t("API Key is required"),
              );
            }

            const fetchFn = ztoolkit.getGlobal("fetch") as typeof fetch;
            const requestScope = createProviderRequestScope();
            const result = await runProviderConnectionTest({
              requestScope,
              fetchFn,
              protocol: providerProtocol,
              authMode,
              apiBase,
              apiKey,
              modelName,
            });
            // The editor validates nothing about a level's meaning — the
            // model is the judge — so the test also tries every customized
            // setting and shows the server's verdict per item.
            statusLine.textContent = t("Testing custom settings…");
            statusLine.style.color = "";
            const settingsChecks = await runProviderSettingsChecks({
              requestScope,
              fetchFn,
              protocol: providerProtocol,
              authMode,
              apiBase,
              apiKey,
              modelName,
              profileOverride: modelEntry.profileOverride,
            });
            const settingsLines = settingsChecks.map((check) => {
              const label =
                check.kind === "extra"
                  ? t("extra parameters")
                  : `${t("level")} ${check.id}`;
              return check.ok
                ? `✓ ${label}`
                : `✗ ${label} — ${check.error || t("rejected")}`;
            });
            const settingsFailed = settingsChecks.some((check) => !check.ok);
            const settingsSuffix = settingsLines.length
              ? `\n${settingsLines.join("\n")}`
              : "";
            if (result.warning) {
              statusLine.textContent =
                `${t("⚠ Connected, but no answer — ")}${t(result.warning)}\n` +
                `${t("Agent capability: ")}${result.capabilityLabel}` +
                settingsSuffix;
              statusLine.style.color = "darkorange";
            } else {
              statusLine.textContent =
                `${t("✓ Success — model says: ")}"${result.reply}"\n` +
                `${t("Agent capability: ")}${result.capabilityLabel}` +
                settingsSuffix;
              statusLine.style.color = settingsFailed ? "darkorange" : "green";
            }
          } catch (error) {
            const mcpFailure = describeCodexZoteroMcpFailure(error);
            const mcpConnectedBeforeModelFailure =
              (error as { mcpConnected?: unknown })?.mcpConnected === true;
            statusLine.textContent = mcpConnectedBeforeModelFailure
              ? `${t("Zotero MCP connection verified through Codex.")}\n${t("Model connection: ")}✗ ${error instanceof Error ? error.message : String(error)}`
              : group.authMode === "codex_app_server" &&
                  isNativeZoteroMcpToolsEnabled() &&
                  mcpFailure
                ? `${t("Zotero MCP connection: ")}✗ ${formatCodexZoteroMcpError(error, "Codex provider connection test failed")}\n${t("Model connection was not tested.")}`
                : `✗ ${error instanceof Error ? error.message : String(error)}`;
            statusLine.style.color = "red";
          } finally {
            testBtn.disabled = false;
          }
        };

        testBtn.addEventListener("click", () => void runTest());
        testBtn.addEventListener("command", () => void runTest());

        if (pickerStatusEl) rowWrap.append(pickerStatusEl);
        rowWrap.append(statusLine, advRow);
        modelsWrap.appendChild(rowWrap);
      });

      if (group.authMode === "copilot_auth") {
        cardBody.append(
          connectionSection(doc, [authModeWrap, copilotLoginWrap, apiUrlWrap]),
          modelsWrap,
        );
      } else if (group.authMode === "codex_app_server") {
        cardBody.append(
          connectionSection(doc, [authModeWrap, apiUrlWrap]),
          modelsWrap,
        );
      } else {
        cardBody.append(
          connectionSection(doc, [
            authModeWrap,
            providerPresetWrap,
            apiUrlWrap,
            apiKeyWrap,
          ]),
          modelsWrap,
        );
      }
      finishProviderRow();
    });

    // ── Add Provider button ──────────────────────────────────────

    const addCard = createElement(doc, "div", "llm-pref-row llm-pref-add-card");
    // A div, not a <button>: Gecko gives a button an anonymous inner box it
    // will not stretch to its parent, which left this label 8px above centre
    // (measured in the real pane, 25px tall inside a 44px slot). role and
    // tabindex restore everything the element type provided.
    const addProviderBtn = createElement(doc, "div", "llm-pref-add-card-btn", {
      tabIndex: 0,
    });
    addProviderBtn.setAttribute("role", "button");
    addProviderBtn.append(
      createElement(doc, "span", "llm-pref-add-card-plus", {
        textContent: "+",
      }),
      createElement(doc, "span", "llm-pref-add-card-label", {
        textContent: t("Add provider"),
      }),
    );
    addCard.appendChild(addProviderBtn);

    const syncAddProviderBtnInner = () => {
      const atMax = groups.length >= MAX_PROVIDER_COUNT;
      const hasEmpty = groups.some(isProviderEmpty);
      const canAdd = !atMax && !hasEmpty;
      addCard.setAttribute("data-disabled", String(!canAdd));
      addProviderBtn.setAttribute("aria-disabled", String(!canAdd));
      addProviderBtn.tabIndex = canAdd ? 0 : -1;
      addProviderBtn.title = atMax
        ? `Maximum ${MAX_PROVIDER_COUNT} providers`
        : hasEmpty
          ? t("Complete the empty provider first")
          : t("Add provider");
    };
    syncAddProviderBtnInner();
    syncAddProviderBtn = syncAddProviderBtnInner;

    const addProvider = () => {
      if (addProviderBtn.getAttribute("aria-disabled") === "true") return;
      const added = createEmptyProviderGroup();
      groups.push(added);
      openProviderIds.add(added.id);
      persistGroups(groups);
      rerender();
    };
    addProviderBtn.addEventListener("click", addProvider);
    // A div gets no implicit keyboard activation, so restore what a button had.
    addProviderBtn.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key !== "Enter" && key !== " ") return;
      event.preventDefault();
      addProvider();
    });

    wrap.appendChild(addCard);
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

  const sidebarLayoutSelect = doc.querySelector(
    `#${config.addonRef}-sidebar-layout`,
  ) as HTMLSelectElement | null;
  if (sidebarLayoutSelect) {
    const label = doc.querySelector(
      `label[for="${config.addonRef}-sidebar-layout"]`,
    );
    if (label) label.textContent = t("Sidebar layout");
    const hint = doc.getElementById(`${config.addonRef}-sidebar-layout-hint`);
    if (hint)
      hint.textContent = t(
        "Show chat in its own sidebar or alongside Zotero’s other item sections. Changes apply immediately.",
      );
    for (const option of Array.from(sidebarLayoutSelect.options)) {
      option.textContent = t(
        option.getAttribute("value") === "stacked"
          ? "Stacked (default)"
          : "Independent",
      );
    }
    sidebarLayoutSelect.value = getSidebarLayout();
    sidebarLayoutSelect.addEventListener("change", () => {
      Zotero.Prefs.set(
        SIDEBAR_LAYOUT_PREF,
        sidebarLayoutSelect.value === "stacked" ? "stacked" : "independent",
        true,
      );
    });
    sidebarLayoutSelect.dataset.preferenceBound = "true";
  }

  const fontScaleSlider = doc.querySelector(
    `#${config.addonRef}-panel-font-scale`,
  ) as HTMLInputElement | null;
  const fontScaleReadout = doc.querySelector(
    `#${config.addonRef}-panel-font-scale-readout`,
  ) as HTMLSpanElement | null;
  const fontScaleResetBtn = doc.querySelector(
    `#${config.addonRef}-panel-font-scale-reset`,
  ) as HTMLButtonElement | null;
  const messageLineSpacingSlider = doc.querySelector(
    `#${config.addonRef}-message-line-spacing`,
  ) as HTMLInputElement | null;
  const messageLineSpacingReadout = doc.querySelector(
    `#${config.addonRef}-message-line-spacing-readout`,
  ) as HTMLSpanElement | null;
  const messageLineSpacingResetBtn = doc.querySelector(
    `#${config.addonRef}-message-line-spacing-reset`,
  ) as HTMLButtonElement | null;
  const messageParagraphSpacingSlider = doc.querySelector(
    `#${config.addonRef}-message-paragraph-spacing`,
  ) as HTMLInputElement | null;
  const messageParagraphSpacingReadout = doc.querySelector(
    `#${config.addonRef}-message-paragraph-spacing-readout`,
  ) as HTMLSpanElement | null;
  const messageParagraphSpacingResetBtn = doc.querySelector(
    `#${config.addonRef}-message-paragraph-spacing-reset`,
  ) as HTMLButtonElement | null;
  const messageWordSpacingSlider = doc.querySelector(
    `#${config.addonRef}-message-word-spacing`,
  ) as HTMLInputElement | null;
  const messageWordSpacingReadout = doc.querySelector(
    `#${config.addonRef}-message-word-spacing-readout`,
  ) as HTMLSpanElement | null;
  const messageWordSpacingResetBtn = doc.querySelector(
    `#${config.addonRef}-message-word-spacing-reset`,
  ) as HTMLButtonElement | null;
  const messageFontFamilyInput = doc.querySelector(
    `#${config.addonRef}-message-font-family`,
  ) as HTMLInputElement | null;
  const messageFontFamilyResetBtn = doc.querySelector(
    `#${config.addonRef}-message-font-family-reset`,
  ) as HTMLButtonElement | null;

  const collectTypographyTargets = (): HTMLElement[] => {
    const targets: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();
    const push = (el: HTMLElement | null) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      targets.push(el);
    };
    const wins = ((
      Zotero as unknown as { getMainWindows?: () => Window[] }
    ).getMainWindows?.() || []) as Window[];
    for (const w of wins) {
      const d = w?.document;
      if (!d) continue;
      d.querySelectorAll("#llm-main").forEach((n: Element) =>
        push(n as HTMLElement),
      );
      push(
        d.getElementById(
          "llmforzotero-standalone-chat-root",
        ) as HTMLElement | null,
      );
    }
    const standaloneWin = addon?.data?.standaloneWindow as Window | undefined;
    if (standaloneWin && standaloneWin.document) {
      standaloneWin.document
        .querySelectorAll("#llm-main")
        .forEach((n: Element) => push(n as HTMLElement));
      push(
        standaloneWin.document.getElementById(
          "llmforzotero-standalone-chat-root",
        ) as HTMLElement | null,
      );
    }
    return targets;
  };

  const applyTypographyTargets = () => {
    for (const target of collectTypographyTargets()) {
      applyPanelFontScale(target);
    }
  };

  if (fontScaleSlider) {
    const applyFontScale = (value: number) => {
      const clamped = Math.max(
        FONT_SCALE_MIN_PERCENT,
        Math.min(value, FONT_SCALE_MAX_PERCENT),
      );
      setPanelFontScalePercent(clamped);
      setFontScalePref(clamped);
      applyTypographyTargets();
      fontScaleSlider.value = String(clamped);
      if (fontScaleReadout) fontScaleReadout.textContent = `${clamped}%`;
    };

    const initial = getFontScalePref();
    fontScaleSlider.value = String(initial);
    if (fontScaleReadout) fontScaleReadout.textContent = `${initial}%`;

    fontScaleSlider.addEventListener("input", () => {
      const next = Number(fontScaleSlider.value);
      if (!Number.isFinite(next)) return;
      applyFontScale(next);
    });

    if (fontScaleResetBtn) {
      fontScaleResetBtn.addEventListener("click", () => {
        applyFontScale(FONT_SCALE_DEFAULT_PERCENT);
      });
    }
  }

  if (messageLineSpacingSlider) {
    const applyMessageLineSpacing = (value: number) => {
      const clamped = Math.max(
        MESSAGE_LINE_SPACING_MIN_PERCENT,
        Math.min(value, MESSAGE_LINE_SPACING_MAX_PERCENT),
      );
      setMessageLineSpacingPercent(clamped);
      setMessageLineSpacingPref(clamped);
      applyTypographyTargets();
      messageLineSpacingSlider.value = String(clamped);
      if (messageLineSpacingReadout) {
        messageLineSpacingReadout.textContent = `${clamped}%`;
      }
    };

    const initial = getMessageLineSpacingPref();
    messageLineSpacingSlider.value = String(initial);
    if (messageLineSpacingReadout) {
      messageLineSpacingReadout.textContent = `${initial}%`;
    }

    messageLineSpacingSlider.addEventListener("input", () => {
      const next = Number(messageLineSpacingSlider.value);
      if (!Number.isFinite(next)) return;
      applyMessageLineSpacing(next);
    });

    if (messageLineSpacingResetBtn) {
      messageLineSpacingResetBtn.addEventListener("click", () => {
        applyMessageLineSpacing(MESSAGE_LINE_SPACING_DEFAULT_PERCENT);
      });
    }
  }

  if (messageParagraphSpacingSlider) {
    const formatParagraphSpacing = (value: number) =>
      `${Number.isInteger(value) ? String(value) : value.toFixed(1)}px`;
    const applyMessageParagraphSpacing = (value: number) => {
      const clamped = Math.max(
        MESSAGE_PARAGRAPH_SPACING_MIN_PX,
        Math.min(value, MESSAGE_PARAGRAPH_SPACING_MAX_PX),
      );
      setMessageParagraphSpacingPx(clamped);
      setMessageParagraphSpacingPref(clamped);
      applyTypographyTargets();
      messageParagraphSpacingSlider.value = String(clamped);
      if (messageParagraphSpacingReadout) {
        messageParagraphSpacingReadout.textContent =
          formatParagraphSpacing(clamped);
      }
    };

    const initial = getMessageParagraphSpacingPref();
    messageParagraphSpacingSlider.value = String(initial);
    if (messageParagraphSpacingReadout) {
      messageParagraphSpacingReadout.textContent =
        formatParagraphSpacing(initial);
    }

    messageParagraphSpacingSlider.addEventListener("input", () => {
      const next = Number(messageParagraphSpacingSlider.value);
      if (!Number.isFinite(next)) return;
      applyMessageParagraphSpacing(next);
    });

    if (messageParagraphSpacingResetBtn) {
      messageParagraphSpacingResetBtn.addEventListener("click", () => {
        applyMessageParagraphSpacing(MESSAGE_PARAGRAPH_SPACING_DEFAULT_PX);
      });
    }
  }

  if (messageWordSpacingSlider) {
    const formatWordSpacing = (value: number) =>
      `${Number.isInteger(value) ? String(value) : value.toFixed(1)}px`;
    const applyMessageWordSpacing = (value: number) => {
      const clamped = Math.max(
        MESSAGE_WORD_SPACING_MIN_PX,
        Math.min(value, MESSAGE_WORD_SPACING_MAX_PX),
      );
      setMessageWordSpacingPx(clamped);
      setMessageWordSpacingPref(clamped);
      applyTypographyTargets();
      messageWordSpacingSlider.value = String(clamped);
      if (messageWordSpacingReadout) {
        messageWordSpacingReadout.textContent = formatWordSpacing(clamped);
      }
    };

    const initial = getMessageWordSpacingPref();
    messageWordSpacingSlider.value = String(initial);
    if (messageWordSpacingReadout) {
      messageWordSpacingReadout.textContent = formatWordSpacing(initial);
    }

    messageWordSpacingSlider.addEventListener("input", () => {
      const next = Number(messageWordSpacingSlider.value);
      if (!Number.isFinite(next)) return;
      applyMessageWordSpacing(next);
    });

    if (messageWordSpacingResetBtn) {
      messageWordSpacingResetBtn.addEventListener("click", () => {
        applyMessageWordSpacing(MESSAGE_WORD_SPACING_DEFAULT_PX);
      });
    }
  }

  if (messageFontFamilyInput) {
    const applyMessageFontFamily = (value: string) => {
      setMessageFontFamily(value);
      setMessageFontFamilyPref(value);
      applyTypographyTargets();
      messageFontFamilyInput.value = value;
    };

    messageFontFamilyInput.value = getMessageFontFamilyPref();
    messageFontFamilyInput.addEventListener("input", () => {
      applyMessageFontFamily(messageFontFamilyInput.value);
    });

    if (messageFontFamilyResetBtn) {
      messageFontFamilyResetBtn.addEventListener("click", () => {
        applyMessageFontFamily("");
      });
    }
  }

  // Every collapsed Agent row carries a summary line, so the tab answers "how
  // is this set up?" without opening anything. The real implementation is
  // installed once every control exists; the async catalog refreshes defined
  // above call through this holder.
  let refreshAgentRowSummaries: () => void = () => undefined;

  const claudeCodeEnableToggle = doc.querySelector(
    `#${config.addonRef}-agent-backend-mode`,
  ) as HTMLInputElement | null;
  const agentBridgeSettingsWrap = doc.querySelector(
    `#${config.addonRef}-agent-bridge-settings`,
  ) as HTMLDivElement | null;
  const agentBridgeUrlInput = doc.querySelector(
    `#${config.addonRef}-agent-bridge-url`,
  ) as HTMLInputElement | null;
  const agentClaudeConfigSourceSelect = doc.querySelector(
    `#${config.addonRef}-agent-claude-config-source`,
  ) as HTMLSelectElement | null;
  const originalAgentPermissionModeSelect = doc.querySelector(
    `#${config.addonRef}-original-agent-permission-mode`,
  ) as HTMLSelectElement | null;
  const originalAgentPermissionModeDescription = doc.querySelector(
    `#${config.addonRef}-original-agent-permission-mode-description`,
  ) as HTMLSpanElement | null;
  const agentPermissionModeSelect = doc.querySelector(
    `#${config.addonRef}-agent-permission-mode`,
  ) as HTMLSelectElement | null;
  const claudePermissionModeStatus = doc.querySelector(
    `#${config.addonRef}-claude-code-permission-status`,
  ) as HTMLSpanElement | null;
  const claudePermissionModeRefresh = doc.querySelector(
    `#${config.addonRef}-claude-code-permission-refresh`,
  ) as HTMLButtonElement | null;
  const claudeConfigPathsWrap = doc.querySelector(
    `#${config.addonRef}-claude-config-paths`,
  ) as HTMLDivElement | null;
  const claudeCodeModelSelect = doc.querySelector(
    `#${config.addonRef}-claude-code-model`,
  ) as HTMLSelectElement | null;
  const claudeCodeCustomModelWrap = doc.querySelector(
    `#${config.addonRef}-claude-code-custom-model-wrap`,
  ) as HTMLDivElement | null;
  const claudeCodeCustomModelInput = doc.querySelector(
    `#${config.addonRef}-claude-code-custom-model`,
  ) as HTMLInputElement | null;
  const claudeCodeModelStatus = doc.querySelector(
    `#${config.addonRef}-claude-code-model-status`,
  ) as HTMLSpanElement | null;
  const claudeCodeModelRefreshButton = doc.querySelector(
    `#${config.addonRef}-claude-code-model-refresh`,
  ) as HTMLButtonElement | null;
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

  registerWebAccessPreferences(doc);

  if (tavilyApiKeyInput) {
    tavilyApiKeyInput.value = getTavilyApiKey();
    const commitTavilyKey = () => {
      setTavilyApiKey(tavilyApiKeyInput.value);
      tavilyApiKeyInput.value = getTavilyApiKey();
      if (tavilyStatus) {
        tavilyStatus.style.display = "none";
        tavilyStatus.textContent = "";
      }
    };
    tavilyApiKeyInput.addEventListener("change", commitTavilyKey);
    tavilyApiKeyInput.addEventListener("blur", commitTavilyKey);
  }

  if (tavilyKeyLink) {
    tavilyKeyLink.addEventListener("click", (event) => {
      event.preventDefault();
      Zotero.launchURL("https://app.tavily.com");
    });
  }

  if (tavilyTestButton && tavilyStatus) {
    tavilyTestButton.addEventListener("click", () => {
      void (async () => {
        const key = tavilyApiKeyInput?.value.trim() || getTavilyApiKey();
        tavilyStatus.style.display = "inline";
        if (!key) {
          tavilyStatus.style.color = "red";
          tavilyStatus.textContent = t("Enter a Tavily API key first.");
          return;
        }
        setTavilyApiKey(key);
        if (tavilyApiKeyInput) tavilyApiKeyInput.value = key;
        tavilyTestButton.disabled = true;
        tavilyStatus.style.color = "var(--fill-secondary, #888)";
        tavilyStatus.textContent = t("Testing…");
        try {
          const usage = await new TavilyClient(key).getUsage();
          tavilyStatus.style.color = "green";
          tavilyStatus.textContent = `${t("Connected")} · ${usage.plan}`;
        } catch (error) {
          tavilyStatus.style.color = "red";
          tavilyStatus.textContent = t(
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          tavilyTestButton.disabled = false;
        }
      })();
    });
  }

  const renderPermissionPreferenceOptions = (params: {
    select: HTMLSelectElement;
    options: PermissionOption[];
    selectedKey: string;
  }): boolean => {
    const optionElements = params.options.map((entry) => {
      const option = el(doc, "option") as HTMLOptionElement;
      option.value = entry.selectionKey;
      option.textContent = entry.fullLabel;
      option.title = entry.description;
      option.disabled = !entry.available;
      return option;
    });
    const selectedOption = params.options.find(
      (entry) => entry.selectionKey === params.selectedKey,
    );
    if (!selectedOption) {
      const invalid = el(doc, "option") as HTMLOptionElement;
      invalid.value = params.selectedKey;
      invalid.textContent = "Unavailable";
      invalid.disabled = true;
      optionElements.push(invalid);
    }
    params.select.replaceChildren(...optionElements);
    params.select.value = params.selectedKey;
    return selectedOption?.available === true;
  };

  let claudePermissionRefreshId = 0;
  const refreshClaudePermissionOptions = async () => {
    if (!agentPermissionModeSelect) return;
    const refreshId = ++claudePermissionRefreshId;
    agentPermissionModeSelect.disabled = true;
    if (claudePermissionModeRefresh) {
      claudePermissionModeRefresh.disabled = true;
    }
    if (claudePermissionModeStatus) {
      claudePermissionModeStatus.textContent =
        "Loading Claude Code permission modes…";
      claudePermissionModeStatus.style.color = "var(--fill-secondary, #777)";
    }
    try {
      const catalog = await fetchClaudePermissionModeCatalog({
        bridgeUrl: getClaudeBridgeUrl(),
        settingSources: getClaudeSettingSourcesByPref(),
      });
      if (refreshId !== claudePermissionRefreshId) return;
      const reconciliation = reconcileClaudePermissionMode({
        selectedId: getClaudePermissionModePref(),
        options: catalog.options,
      });
      if (reconciliation.selectedId !== getClaudePermissionModePref()) {
        setClaudePermissionModePref(reconciliation.selectedId);
      }
      renderPermissionPreferenceOptions({
        select: agentPermissionModeSelect,
        options: catalog.options,
        selectedKey: `claude:${reconciliation.selectedId}`,
      });
      agentPermissionModeSelect.disabled = false;
      if (claudePermissionModeStatus) {
        const selected = catalog.options.find(
          (option) =>
            option.selectionKey === `claude:${reconciliation.selectedId}`,
        );
        const selectedDescription = selected
          ? `${selected.fullLabel}: ${selected.description} `
          : "";
        const configured = catalog.configuredDefaultMode
          ? ` Claude configuration default: ${catalog.configuredDefaultMode}.`
          : "";
        claudePermissionModeStatus.textContent = `${reconciliation.warning ? `${reconciliation.warning} ` : ""}${selectedDescription}Descriptions and availability come from the active Claude Code settings.${configured}`;
        claudePermissionModeStatus.style.color = reconciliation.warning
          ? "#f39c12"
          : "var(--fill-secondary, #777)";
      }
    } catch (error) {
      if (refreshId !== claudePermissionRefreshId) return;
      agentPermissionModeSelect.replaceChildren();
      agentPermissionModeSelect.disabled = true;
      if (claudePermissionModeStatus) {
        claudePermissionModeStatus.textContent =
          error instanceof Error ? error.message : String(error);
        claudePermissionModeStatus.style.color = "#e74c3c";
      }
    } finally {
      if (
        refreshId === claudePermissionRefreshId &&
        claudePermissionModeRefresh
      ) {
        claudePermissionModeRefresh.disabled = false;
      }
      refreshAgentRowSummaries();
    }
  };

  let currentCodexPermissionCatalog: CodexPermissionOptionCatalog | null = null;
  let codexPermissionRefreshId = 0;
  const refreshCodexPermissionOptions = async () => {
    if (!codexPermissionProfileSelect) return;
    const refreshId = ++codexPermissionRefreshId;
    codexPermissionProfileSelect.disabled = true;
    if (codexPermissionProfileRefresh) {
      codexPermissionProfileRefresh.disabled = true;
    }
    if (codexPermissionProfileStatus) {
      codexPermissionProfileStatus.textContent =
        "Loading Codex permission profiles…";
      codexPermissionProfileStatus.style.color = "var(--fill-secondary, #777)";
    }
    try {
      const catalog = await getCodexPermissionOptionCatalog({
        codexPath: getConfiguredCodexAppServerBinaryPath(),
        fresh: true,
      });
      if (refreshId !== codexPermissionRefreshId) return;
      currentCodexPermissionCatalog = catalog;
      const selectedAvailable = renderPermissionPreferenceOptions({
        select: codexPermissionProfileSelect,
        options: catalog.options,
        selectedKey: catalog.selectedKey,
      });
      codexPermissionProfileSelect.disabled = false;
      if (codexPermissionProfileStatus) {
        const selected = catalog.options.find(
          (option) => option.selectionKey === catalog.selectedKey,
        );
        const boundary = catalog.state.boundary;
        const providerDescription =
          boundary.kind === "profile"
            ? catalog.capabilities.profiles.find(
                (profile) => profile.id === boundary.profileId,
              )?.description
            : selected?.description;
        const selectedDescription = selected
          ? `${getCodexPermissionStatusText(catalog.state)}.${providerDescription ? ` ${providerDescription}` : ""} ${selected.disabledReason || ""}`
          : `${catalog.selectedKey}: Unavailable. `;
        codexPermissionProfileStatus.textContent = `${catalog.preferenceError ? `${catalog.preferenceError} ` : ""}${selectedDescription}${
          selectedAvailable
            ? catalog.capabilities.protocol === "legacy"
              ? "Update Codex to use named permission profiles."
              : "Profiles and managed availability come from Codex."
            : "Choose an allowed Codex permission mode before sending."
        }`;
        codexPermissionProfileStatus.style.color = selectedAvailable
          ? "var(--fill-secondary, #777)"
          : "#e74c3c";
      }
    } catch (error) {
      if (refreshId !== codexPermissionRefreshId) return;
      currentCodexPermissionCatalog = null;
      codexPermissionProfileSelect.replaceChildren();
      codexPermissionProfileSelect.disabled = true;
      if (codexPermissionProfileStatus) {
        codexPermissionProfileStatus.textContent =
          error instanceof Error ? error.message : String(error);
        codexPermissionProfileStatus.style.color = "#e74c3c";
      }
    } finally {
      if (
        refreshId === codexPermissionRefreshId &&
        codexPermissionProfileRefresh
      ) {
        codexPermissionProfileRefresh.disabled = false;
      }
      refreshAgentRowSummaries();
    }
  };

  agentPermissionModeSelect?.addEventListener("change", () => {
    setClaudePermissionModePref(
      normalizeClaudePermissionMode(
        agentPermissionModeSelect.value.replace(/^claude:/, ""),
      ),
    );
  });
  claudePermissionModeRefresh?.addEventListener("click", () => {
    void refreshClaudePermissionOptions();
  });
  codexPermissionProfileSelect?.addEventListener("change", () => {
    const catalog = currentCodexPermissionCatalog;
    const selectedKey = codexPermissionProfileSelect.value;
    const choice = catalog?.choices.get(selectedKey);
    if (!catalog || !choice) return;
    void (async () => {
      if (choice.kind === "preset" && choice.preset === "full") {
        codexPermissionProfileSelect.disabled = true;
        const confirmed = await confirmCodexFullAccess();
        if (catalog !== currentCodexPermissionCatalog) return;
        codexPermissionProfileSelect.disabled = false;
        if (codexPermissionProfileSelect.value !== selectedKey) return;
        if (!confirmed) {
          codexPermissionProfileSelect.value = catalog.selectedKey;
          return;
        }
      }
      setCodexPermissionStatePref(
        applyCodexPermissionChoice({ current: catalog.state, choice }),
      );
    })();
  });
  codexPermissionProfileRefresh?.addEventListener("click", () => {
    void refreshCodexPermissionOptions();
  });
  const permissionPreferenceObserverIds: symbol[] = [];
  const observePermissionPreference = (
    key: string,
    refresh: () => void,
  ): void => {
    try {
      permissionPreferenceObserverIds.push(
        (Zotero as any).Prefs.registerObserver(key, refresh, true),
      );
    } catch {
      // Preference observers are available in Zotero but not every test DOM.
    }
  };
  observePermissionPreference(
    `${config.prefsPrefix}.claudeCodePermissionMode`,
    () => void refreshClaudePermissionOptions(),
  );
  observePermissionPreference(
    `${config.prefsPrefix}.codexAppServerPermissionState`,
    () => void refreshCodexPermissionOptions(),
  );
  const unsubscribeCodexPermissionProcessChanges =
    subscribeCodexPermissionProcessChanges(
      () => void refreshCodexPermissionOptions(),
    );
  _window.addEventListener(
    "unload",
    () => {
      unsubscribeCodexPermissionProcessChanges();
      for (const observerId of permissionPreferenceObserverIds.splice(0)) {
        try {
          (Zotero as any).Prefs.unregisterObserver(observerId);
        } catch {
          void 0;
        }
      }
    },
    { once: true },
  );
  void refreshClaudePermissionOptions();
  void refreshCodexPermissionOptions();

  // ── Agent tab rows: disclosure + summary lines ───────────────────
  const selectedOptionLabel = (select: HTMLSelectElement | null): string => {
    if (!select || select.selectedIndex < 0) return "";
    return select.options[select.selectedIndex]?.textContent?.trim() || "";
  };
  const inputValue = (selector: string): string => {
    const element = doc.querySelector(
      `#${config.addonRef}-${selector}`,
    ) as HTMLInputElement | null;
    return element?.value.trim() || "";
  };

  const setAgentRowSummary = (
    row: string,
    on: boolean,
    parts: string[],
  ): void => {
    const dot = doc.querySelector(
      `[data-llm-row-dot="${row}"]`,
    ) as HTMLElement | null;
    if (dot) dot.setAttribute("data-on", String(on));
    const target = doc.querySelector(
      `[data-llm-row-summary="${row}"]`,
    ) as HTMLElement | null;
    if (!target) return;
    target.textContent = parts.filter((part) => part.length > 0).join(" · ");
  };

  refreshAgentRowSummaries = () => {
    const originalOn = !!enableAgentModeInput?.checked;
    setAgentRowSummary(
      "original",
      originalOn,
      originalOn
        ? [
            selectedOptionLabel(originalAgentPermissionModeSelect),
            getWebAccessProvider() === "anysearch" ||
            tavilyApiKeyInput?.value.trim()
              ? t("Web search on")
              : t("Web search off"),
          ]
        : [t("Off")],
    );
    const codexOn = !!codexAppServerEnableToggle?.checked;
    setAgentRowSummary(
      "codex",
      codexOn,
      codexOn
        ? [
            resolveCodexModelValue() || t("Default model"),
            selectedOptionLabel(codexPermissionProfileSelect),
          ]
        : [t("Off")],
    );
    const claudeOn = !!claudeCodeEnableToggle?.checked;
    // "Customized" names the entry mode, not the model — show what was typed.
    const claudeModel =
      claudeCodeModelSelect?.value === CLAUDE_CUSTOMIZED_MODEL_OPTION_KEY
        ? claudeCodeCustomModelInput?.value.trim() ||
          selectedOptionLabel(claudeCodeModelSelect)
        : selectedOptionLabel(claudeCodeModelSelect);
    setAgentRowSummary(
      "claude",
      claudeOn,
      claudeOn
        ? [claudeModel, selectedOptionLabel(agentPermissionModeSelect)]
        : [t("Off")],
    );
    const notesPath = inputValue("obsidian-vault-path");
    setAgentRowSummary(
      "notes",
      !!notesPath,
      notesPath
        ? [inputValue("notes-dir-nickname") || t("Notes"), notesPath]
        : [t("Not set")],
    );
  };

  for (const row of Array.from(
    doc.querySelectorAll(
      `#${config.addonRef}-pref-panel-agent [data-llm-agent-row]`,
    ),
  ) as HTMLElement[]) {
    const toggle = row.querySelector(
      ".llm-pref-row-toggle",
    ) as HTMLButtonElement | null;
    const bodyId = toggle?.getAttribute("aria-controls");
    const body = bodyId
      ? (doc.getElementById(bodyId) as HTMLElement | null)
      : null;
    if (!toggle || !body) continue;
    toggle.addEventListener("click", () => {
      const open = row.getAttribute("data-open") !== "true";
      row.setAttribute("data-open", String(open));
      toggle.setAttribute("aria-expanded", String(open));
      body.hidden = !open;
    });
  }

  // One delegated listener keeps every summary honest without threading a
  // refresh call through each control's own handler.
  const agentPanel = doc.querySelector(
    `#${config.addonRef}-pref-panel-agent`,
  ) as HTMLElement | null;
  if (agentPanel) {
    const onAgentPanelEdit = () => refreshAgentRowSummaries();
    agentPanel.addEventListener("change", onAgentPanelEdit);
    agentPanel.addEventListener("input", onAgentPanelEdit);
  }
  refreshAgentRowSummaries();

  if (codexAppServerEnableToggle) {
    const applyCodexAppServerUi = (enabled: boolean) => {
      codexAppServerEnableToggle.checked = enabled;
      if (codexAppServerSettingsWrap) {
        codexAppServerSettingsWrap.style.display = enabled ? "flex" : "none";
      }
      refreshAgentRowSummaries();
    };
    applyCodexAppServerUi(isCodexAppServerModeEnabled());
    codexAppServerEnableToggle.addEventListener("change", () => {
      const enabled = codexAppServerEnableToggle.checked;
      applyCodexAppServerUi(enabled);
      applyCodexAppServerModePreferenceChange(enabled);
      if (enabled) {
        void refreshCodexCatalog();
        void refreshCodexPermissionOptions();
      }
    });
  }

  let codexReasoningCatalogRefreshId = 0;
  // The Codex CLI is the only authority on which models it accepts, so the
  // picker is filled from its own catalog rather than typed by hand.
  const renderCodexModelOptions = (
    models: CodexAppServerModelCatalogEntry[],
    catalogReady: boolean,
  ) => {
    if (!codexAppServerModelSelect) return;
    const stored = getCodexRuntimeModelPref().trim();
    const options = models.map((entry) => {
      const option = el(doc, "option") as HTMLOptionElement;
      option.value = entry.model;
      option.textContent = entry.displayName || entry.model;
      if (entry.description) option.title = entry.description;
      return option;
    });
    const customized = el(doc, "option") as HTMLOptionElement;
    customized.value = CODEX_CUSTOMIZED_MODEL_OPTION_KEY;
    customized.textContent = t("Customized");
    options.push(customized);
    codexAppServerModelSelect.replaceChildren(...options);
    codexAppServerModelSelect.removeAttribute("aria-busy");

    const known = models.some((entry) => entry.model === stored);
    if (known) {
      codexAppServerModelSelect.value = stored;
    } else {
      codexAppServerModelSelect.value = CODEX_CUSTOMIZED_MODEL_OPTION_KEY;
      if (codexAppServerCustomModelInput && stored) {
        codexAppServerCustomModelInput.value = stored;
      }
    }
    const customizedSelected =
      codexAppServerModelSelect.value === CODEX_CUSTOMIZED_MODEL_OPTION_KEY;
    if (codexAppServerCustomModelWrap) {
      codexAppServerCustomModelWrap.hidden = !customizedSelected;
    }
    if (codexAppServerCustomModelInput) {
      codexAppServerCustomModelInput.disabled = !customizedSelected;
    }
    if (codexAppServerModelStatus) {
      codexAppServerModelStatus.textContent = catalogReady
        ? ""
        : t(
            "Could not read models from the Codex CLI. Use Customized to enter one manually.",
          );
    }
  };
  const renderCodexReasoningOptions = (
    models: CodexAppServerModelCatalogEntry[],
    catalogReady: boolean,
  ) => {
    if (!codexAppServerReasoningSelect) return;
    const currentMode = getCodexReasoningModePref();
    const selection = resolveCodexAppServerReasoningSelection({
      mode: currentMode,
      choices: getCodexAppServerReasoningChoices({
        models,
        selectedModel: resolveCodexModelValue() || getCodexRuntimeModelPref(),
      }),
      catalogReady,
    });
    if (catalogReady && selection.mode !== currentMode) {
      setCodexReasoningModePref(selection.mode);
    }
    const options = selection.choices.map((choice) => {
      const option = el(doc, "option") as HTMLOptionElement;
      option.value = choice.value;
      option.textContent = choice.label;
      return option;
    });
    codexAppServerReasoningSelect.replaceChildren(...options);
    codexAppServerReasoningSelect.value = selection.mode;
  };
  // One catalog read fills both the model picker and the reasoning levels it
  // supports; they come from the same Codex response.
  const refreshCodexCatalog = async () => {
    if (!isCodexAppServerModeEnabled()) return;
    const refreshId = ++codexReasoningCatalogRefreshId;
    if (codexAppServerModelRefreshButton) {
      codexAppServerModelRefreshButton.disabled = true;
    }
    if (codexAppServerModelStatus) {
      codexAppServerModelStatus.textContent = t("Reading models…");
    }
    try {
      const catalog = await loadCodexAppServerModelCatalog({
        codexPath: getConfiguredCodexAppServerBinaryPath(),
      });
      if (refreshId !== codexReasoningCatalogRefreshId) return;
      renderCodexModelOptions(catalog.models, true);
      renderCodexReasoningOptions(catalog.models, true);
    } catch (error) {
      if (refreshId !== codexReasoningCatalogRefreshId) return;
      appLogger.warn(
        "Codex app-server: failed to load the model catalog in preferences",
        error,
      );
      renderCodexModelOptions([], false);
      renderCodexReasoningOptions([], false);
    } finally {
      if (refreshId === codexReasoningCatalogRefreshId) {
        if (codexAppServerModelRefreshButton) {
          codexAppServerModelRefreshButton.disabled = false;
        }
        refreshAgentRowSummaries();
      }
    }
  };

  if (codexAppServerModelSelect) {
    const syncCodexCustomModelVisibility = () => {
      const customized =
        codexAppServerModelSelect.value === CODEX_CUSTOMIZED_MODEL_OPTION_KEY;
      if (codexAppServerCustomModelWrap) {
        codexAppServerCustomModelWrap.hidden = !customized;
      }
      if (codexAppServerCustomModelInput) {
        codexAppServerCustomModelInput.disabled = !customized;
      }
    };
    const commitCodexModel = () => {
      const model = resolveCodexModelValue();
      if (!model) return;
      setCodexRuntimeModelPref(model);
      void refreshCodexCatalog();
      void refreshCodexPermissionOptions();
    };
    codexAppServerModelSelect.addEventListener("change", () => {
      syncCodexCustomModelVisibility();
      commitCodexModel();
    });
    codexAppServerCustomModelInput?.addEventListener(
      "change",
      commitCodexModel,
    );
    codexAppServerCustomModelInput?.addEventListener("blur", commitCodexModel);
    codexAppServerModelRefreshButton?.addEventListener("click", () => {
      void refreshCodexCatalog();
    });
    renderCodexModelOptions([], false);
    syncCodexCustomModelVisibility();
  }

  if (codexAppServerReasoningSelect) {
    codexAppServerReasoningSelect.value = getCodexReasoningModePref();
    void refreshCodexCatalog();
    codexAppServerReasoningSelect.addEventListener("change", () => {
      setCodexReasoningModePref(codexAppServerReasoningSelect.value);
    });
  }

  if (codexAppServerPathInput) {
    codexAppServerPathInput.value = getCodexBinaryPathPref();
    const commitCodexPath = () => {
      setCodexBinaryPathPref(codexAppServerPathInput.value);
      codexAppServerPathInput.value = getCodexBinaryPathPref();
      void refreshCodexCatalog();
      void refreshCodexPermissionOptions();
    };
    codexAppServerPathInput.addEventListener("change", commitCodexPath);
    codexAppServerPathInput.addEventListener("blur", commitCodexPath);
    codexAppServerPathInput.addEventListener("input", () => {
      setCodexBinaryPathPref(codexAppServerPathInput.value);
    });
  }

  if (codexAppServerPathHelper) {
    codexAppServerPathHelper.textContent = t(getCodexAppServerPathHelperText());
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
            modelName: resolveCodexModelValue() || getCodexRuntimeModelPref(),
            codexPath: getConfiguredCodexAppServerBinaryPath(),
            testZoteroMcp: isNativeZoteroMcpToolsEnabled(),
          });
          codexAppServerStatus.textContent =
            `${t("Model connection: ")}✓ "${result.reply}"` +
            (result.mcpConnected
              ? `\n${t("Zotero MCP connection verified through Codex.")}`
              : "");
          codexAppServerStatus.style.color = "green";
        } catch (err) {
          const mcpFailure = describeCodexZoteroMcpFailure(err);
          const mcpConnectedBeforeModelFailure =
            (err as { mcpConnected?: unknown })?.mcpConnected === true;
          codexAppServerStatus.textContent = mcpConnectedBeforeModelFailure
            ? `${t("Zotero MCP connection verified through Codex.")}\n${t("Model connection: ")}✗ ${err instanceof Error ? err.message : String(err)}`
            : isNativeZoteroMcpToolsEnabled() && mcpFailure
              ? `${t("Zotero MCP connection: ")}✗ ${formatCodexZoteroMcpError(err, "Codex connection test failed")}\n${t("Model connection was not tested.")}`
              : `${t("Test failed: ")}${err instanceof Error ? err.message : String(err)}`;
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
    codexAppServerMcpEnableInput.checked = isNativeZoteroMcpToolsEnabled();
    codexAppServerMcpEnableInput.addEventListener("change", () => {
      setNativeZoteroMcpToolsEnabled(codexAppServerMcpEnableInput.checked);
      renderCodexMcpStatus(
        codexAppServerMcpEnableInput.checked
          ? t(
              "Zotero MCP tools enabled for native Codex and Claude Code turns.",
            )
          : t(
              "Zotero MCP tools disabled for native Codex and Claude Code turns.",
            ),
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
            codexPath: getConfiguredCodexAppServerBinaryPath(),
          });
          setNativeZoteroMcpToolsEnabled(true);
          if (codexAppServerMcpEnableInput) {
            codexAppServerMcpEnableInput.checked = true;
          }
          const toolCount = status.toolNames.length;
          renderCodexMcpStatus(
            toolCount > 0
              ? t("Zotero MCP connected with %n tools.").replace(
                  "%n",
                  String(toolCount),
                )
              : t("Zotero MCP connection verified through Codex."),
            "green",
          );
        } catch (error) {
          renderCodexMcpStatus(
            `${t("Zotero MCP setup failed: ")}${formatCodexZoteroMcpError(error, "Zotero MCP setup failed")}`,
            "red",
          );
        } finally {
          codexAppServerMcpSetupBtn.disabled = false;
        }
      })();
    });
  }

  if (
    codexAppServerMcpStatus &&
    isCodexAppServerModeEnabled() &&
    isNativeZoteroMcpToolsEnabled()
  ) {
    renderCodexMcpStatus(t("Checking Zotero MCP setup…"));
    void readCodexNativeMcpSetupStatus({
      codexPath: getConfiguredCodexAppServerBinaryPath(),
    })
      .then(async (status) => {
        if (status.configured) {
          await probeCodexZoteroMcpThroughAppServer({
            codexPath: getConfiguredCodexAppServerBinaryPath(),
          });
        }
        renderCodexMcpStatus(
          status.configured
            ? status.toolNames.length > 0
              ? t("Zotero MCP connected with %n tools.").replace(
                  "%n",
                  String(status.toolNames.length),
                )
              : t("Zotero MCP connection verified through Codex.")
            : t("Zotero MCP tools enabled but not configured yet."),
          status.configured ? "green" : "var(--fill-secondary, #888)",
        );
      })
      .catch((error) => {
        renderCodexMcpStatus(
          `${t("Could not read Codex MCP status: ")}${formatCodexZoteroMcpError(error, "Could not verify Codex MCP status")}`,
          "red",
        );
      });
  }

  let claudeModelCatalogRequestId = 0;
  let claudeModelPreferenceOptions: ClaudeModelPreferenceOption[] = [];
  const renderClaudeModelCatalogStatus = (
    message: string,
    color = "var(--fill-secondary, #777)",
  ) => {
    if (!claudeCodeModelStatus) return;
    claudeCodeModelStatus.textContent = message;
    claudeCodeModelStatus.style.color = color;
  };
  const setClaudeCustomModelVisible = (visible: boolean) => {
    if (claudeCodeCustomModelWrap) {
      claudeCodeCustomModelWrap.hidden = !visible;
      claudeCodeCustomModelWrap.style.display = visible ? "flex" : "none";
    }
    if (claudeCodeCustomModelInput) {
      claudeCodeCustomModelInput.disabled = !visible;
    }
  };
  const syncClaudeModelPreferenceUi = (preserveCustomDraft = false) => {
    if (!claudeCodeModelSelect) return;
    const customDraft = claudeCodeCustomModelInput?.value ?? "";
    const selection = resolveClaudeModelPreferenceSelection({
      options: claudeModelPreferenceOptions,
      selectedModel: getClaudeRuntimeModelPref(),
    });
    claudeCodeModelSelect.replaceChildren();
    for (const model of claudeModelPreferenceOptions) {
      const option = doc.createElementNS(
        HTML_NS,
        "option",
      ) as HTMLOptionElement;
      option.value = model.key;
      option.textContent = model.label;
      option.title = model.description;
      claudeCodeModelSelect.appendChild(option);
    }
    const customizedOption = doc.createElementNS(
      HTML_NS,
      "option",
    ) as HTMLOptionElement;
    customizedOption.value = CLAUDE_CUSTOMIZED_MODEL_OPTION_KEY;
    customizedOption.textContent = t("Customized");
    claudeCodeModelSelect.appendChild(customizedOption);

    const customized = preserveCustomDraft || selection.customized;
    claudeCodeModelSelect.value = customized
      ? CLAUDE_CUSTOMIZED_MODEL_OPTION_KEY
      : selection.selectedKey;
    if (claudeCodeCustomModelInput) {
      claudeCodeCustomModelInput.value = preserveCustomDraft
        ? customDraft
        : selection.customValue;
    }
    setClaudeCustomModelVisible(customized);
    const selectedOption = claudeModelPreferenceOptions.find(
      (option) => option.key === claudeCodeModelSelect.value,
    );
    claudeCodeModelSelect.title =
      selectedOption?.description || selectedOption?.model || "";
  };
  const refreshClaudeModelSuggestions = async (
    forceRefresh = false,
    clearExisting = false,
  ) => {
    if (!claudeCodeModelSelect) return;
    const requestId = ++claudeModelCatalogRequestId;
    const preserveCustomDraft = shouldPreserveClaudeCustomModelDraft({
      customized:
        claudeCodeModelSelect.value === CLAUDE_CUSTOMIZED_MODEL_OPTION_KEY,
      draftValue: claudeCodeCustomModelInput?.value ?? "",
      selectedModel: getClaudeRuntimeModelPref(),
      focused: doc.activeElement === claudeCodeCustomModelInput,
    });
    if (clearExisting) {
      claudeModelPreferenceOptions = [];
    }
    claudeCodeModelSelect.disabled = true;
    claudeCodeModelSelect.setAttribute("aria-busy", "true");
    if (claudeCodeModelRefreshButton) {
      claudeCodeModelRefreshButton.disabled = true;
    }
    renderClaudeModelCatalogStatus(t("Loading available models…"));
    try {
      const catalog = await fetchClaudeModelCatalog({
        bridgeUrl: getClaudeBridgeUrl(),
        settingSources: getClaudeSettingSourcesByPref(),
        forceRefresh,
      });
      if (requestId !== claudeModelCatalogRequestId) return;
      if (claudeCodeModelStatus) claudeCodeModelStatus.title = "";
      claudeModelPreferenceOptions = buildClaudeModelPreferenceOptions(
        catalog.models,
      );
      syncClaudeModelPreferenceUi(preserveCustomDraft);
      if (!catalog.models.length) {
        renderClaudeModelCatalogStatus(
          t(
            "Claude Code did not return any available models. Use Customized to enter one.",
          ),
        );
      } else if (catalog.legacy) {
        renderClaudeModelCatalogStatus(
          t(
            "Using a legacy adapter model list. Update the adapter for model details.",
          ),
        );
      } else {
        renderClaudeModelCatalogStatus(
          t("%n models available.").replace(
            "%n",
            String(catalog.models.length),
          ),
        );
      }
    } catch (error) {
      if (requestId !== claudeModelCatalogRequestId) return;
      const message = error instanceof Error ? error.message : String(error);
      if (!claudeModelPreferenceOptions.length) {
        syncClaudeModelPreferenceUi(preserveCustomDraft);
      }
      renderClaudeModelCatalogStatus(
        t("Could not load models. Use Customized to enter one manually."),
        "var(--fill-secondary, #777)",
      );
      if (claudeCodeModelStatus) claudeCodeModelStatus.title = message;
    } finally {
      if (requestId === claudeModelCatalogRequestId) {
        claudeCodeModelSelect.disabled = false;
        claudeCodeModelSelect.setAttribute("aria-busy", "false");
        if (claudeCodeModelRefreshButton) {
          claudeCodeModelRefreshButton.disabled = false;
        }
        // The row summary names the customized model, which only exists once
        // the catalog has settled and filled the custom field.
        refreshAgentRowSummaries();
      }
    }
  };

  if (claudeCodeEnableToggle) {
    const applyAgentBackendUi = (enabled: boolean) => {
      claudeCodeEnableToggle.checked = enabled;
      if (agentBridgeSettingsWrap) {
        agentBridgeSettingsWrap.style.display = enabled ? "flex" : "none";
      }
      refreshAgentRowSummaries();
    };
    applyAgentBackendUi(isClaudeCodeModeEnabled());
    claudeCodeEnableToggle.addEventListener("change", () => {
      const enabled = claudeCodeEnableToggle.checked;
      void applyClaudeCodeModePreferenceChange(enabled, applyAgentBackendUi);
    });
  }

  if (agentBridgeUrlInput) {
    agentBridgeUrlInput.value =
      getClaudeBridgeUrl() || DEFAULT_AGENT_BRIDGE_URL;
    const commitBridgeUrl = () => {
      setClaudeBridgeUrl(agentBridgeUrlInput.value);
      void refreshClaudeModelSuggestions(true, true);
      void refreshClaudePermissionOptions();
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
          write?: (
            path: string,
            data: Uint8Array<ArrayBufferLike>,
          ) => Promise<unknown>;
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
        globalThis as unknown as {
          Components?: {
            classes?: Record<
              string,
              { createInstance?: (iface: unknown) => unknown }
            >;
            interfaces?: Record<string, unknown>;
          };
        }
      ).Components?.classes;
      const Ci = (
        globalThis as unknown as {
          Components?: { interfaces?: Record<string, unknown> };
        }
      ).Components?.interfaces;
      if (
        Cc &&
        Ci &&
        typeof Cc["@mozilla.org/file/local;1"]?.createInstance === "function"
      ) {
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
      (Zotero as unknown as { launchFile?: (p: string) => void }).launchFile?.(
        dirPath,
      );
    } catch {
      /* ignore */
    }
  };

  const getCurrentClaudeLocalDir = (): string => {
    const runtimeRoot = getClaudeRuntimeRootDir();
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
    const scopeId =
      isPaper && Number.isFinite(libraryID) && libraryID > 0
        ? `${Math.floor(libraryID)}:${Math.floor(itemID)}`
        : `${Number.isFinite(libraryID) && libraryID > 0 ? Math.floor(libraryID) : 1}`;
    const conversationKey =
      isPaper && Number.isFinite(libraryID) && libraryID > 0
        ? getLastUsedClaudePaperConversationKey(
            Math.floor(libraryID),
            Math.floor(itemID),
          )
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
    let home = "";
    try {
      home = getClaudeUserHomeDir();
    } catch {
      home = "";
    }
    let runtimeRoot = "";
    try {
      runtimeRoot = getClaudeRuntimeRootDir();
    } catch {
      runtimeRoot = joinLocalPath(".", "Zotero", "agent-runtime", "<profile>");
    }
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
        id: "user",
        label: t("User"),
        path: home ? joinLocalPath(home, ".claude") : "~/.claude",
        openPath: home ? joinLocalPath(home, ".claude") : "~/.claude",
        description: t(
          "Global defaults shared across Claude Code on this machine.",
        ),
      },
      {
        id: "project",
        label: t("Project"),
        path: projectClaudeDir,
        openPath: projectClaudeDir,
        description: t(
          "Shared settings for all Claude runtimes launched by Zotero.",
        ),
      },
      {
        id: "local",
        label: t("Local"),
        path: localConversationDir,
        openPath: localConversationDir,
        description: t(
          "Each conversation stores its own override folder under the scopes tree.",
        ),
      },
    ];
    for (const row of rows) {
      const wrap = el(
        doc,
        "div",
        "display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 10px; border:1px solid var(--llm-pref-stroke); border-radius:8px; background: rgba(255,255,255,0.02);",
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
        "padding:4px 10px; font-size:11px; border:1px solid var(--llm-pref-stroke); border-radius:6px; cursor:pointer; flex:0 0 auto;",
        t("Open folder"),
      ) as HTMLButtonElement;
      openBtn.type = "button";
      openBtn.addEventListener("click", () => {
        if (row.id === "local") {
          void (async () => {
            const localDir = getCurrentClaudeLocalDir();
            const localSettingsPath = joinLocalPath(
              localDir,
              "settings.local.json",
            );
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
      Zotero.Prefs.set(
        `${config.prefsPrefix}.agentClaudeConfigSource`,
        next,
        true,
      );
      renderClaudeConfigPaths();
      void refreshClaudeModelSuggestions(true, true);
      void refreshClaudePermissionOptions();
    });
  }
  renderClaudeConfigPaths();

  if (claudeConfigDocLink) {
    claudeConfigDocLink.addEventListener("click", (event) => {
      event.preventDefault();
      const launch = (
        Zotero as unknown as { launchURL?: (url: string) => void }
      ).launchURL;
      launch?.("https://code.claude.com/docs/en/settings");
    });
  }

  if (claudeTracePathEl) {
    claudeTracePathEl.textContent = getAgentTraceExportPath(
      "latest-run",
    ).replace(/[\\/]latest-run\.json$/i, "");
  }
  if (claudeTraceEnabledInput) {
    const raw = Zotero.Prefs.get(
      `${config.prefsPrefix}.agentTraceExportEnabled`,
      true,
    );
    claudeTraceEnabledInput.checked =
      raw === true || `${raw || ""}`.toLowerCase() === "true";
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
        getAgentTraceExportPath("latest-run").replace(
          /[\\/]latest-run\.json$/i,
          "",
        ),
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
      claudeManagedInstructionTemplateInput.value =
        saved || defaultManagedBlock;
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
      setClaudeManagedInstructionTemplatePref(
        claudeManagedInstructionTemplateInput.value,
      );
      if (claudeManagedInstructionStatus?.style.display !== "none") {
        syncManagedInstructionStatus(
          t("Template updated locally"),
          "var(--fill-secondary, #888)",
        );
      }
    });
    if (claudeManagedInstructionResetBtn) {
      claudeManagedInstructionResetBtn.addEventListener("click", () => {
        claudeManagedInstructionTemplateInput.value = defaultManagedBlock;
        setClaudeManagedInstructionTemplatePref(defaultManagedBlock);
        syncManagedInstructionStatus(
          t("Reset to default template"),
          "var(--fill-secondary, #888)",
        );
      });
    }
    if (claudeManagedInstructionUpdateBtn) {
      claudeManagedInstructionUpdateBtn.addEventListener("click", async () => {
        const template =
          setClaudeManagedInstructionTemplatePref(
            claudeManagedInstructionTemplateInput.value,
          ) || defaultManagedBlock;
        claudeManagedInstructionUpdateBtn.disabled = true;
        syncManagedInstructionStatus(
          t("Updating CLAUDE.md…"),
          "var(--fill-secondary, #888)",
        );
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

  if (originalAgentPermissionModeSelect) {
    const originalPermissionOptions = getOriginalPermissionOptions();
    const updateOriginalPermissionDescription = () => {
      if (!originalAgentPermissionModeDescription) return;
      const selected = originalPermissionOptions.find(
        (option) =>
          option.selectionKey ===
          `original:${originalAgentPermissionModeSelect.value.replace(/^original:/, "")}`,
      );
      originalAgentPermissionModeDescription.textContent = selected
        ? `${selected.fullLabel}: ${t(selected.description)}`
        : "";
    };
    renderPermissionPreferenceOptions({
      select: originalAgentPermissionModeSelect,
      options: originalPermissionOptions,
      selectedKey: `original:${getOriginalAgentPermissionMode()}`,
    });
    updateOriginalPermissionDescription();
    observePermissionPreference(
      `${config.prefsPrefix}.originalAgentPermissionMode`,
      () => {
        originalAgentPermissionModeSelect.value = `original:${getOriginalAgentPermissionMode()}`;
        updateOriginalPermissionDescription();
      },
    );
    originalAgentPermissionModeSelect.addEventListener("change", () => {
      setOriginalAgentPermissionMode(
        normalizeOriginalAgentPermissionMode(
          originalAgentPermissionModeSelect.value.replace(/^original:/, ""),
        ),
      );
      updateOriginalPermissionDescription();
    });
  }
  if (claudeCodeModelSelect) {
    claudeCodeModelSelect.addEventListener("change", () => {
      const selectedKey = claudeCodeModelSelect.value;
      if (selectedKey === CLAUDE_CUSTOMIZED_MODEL_OPTION_KEY) {
        setClaudeCustomModelVisible(true);
        if (
          claudeCodeCustomModelInput &&
          !claudeCodeCustomModelInput.value.trim()
        ) {
          claudeCodeCustomModelInput.value = getClaudeRuntimeModelPref();
        }
        doc.defaultView?.setTimeout(() => {
          claudeCodeCustomModelInput?.focus();
          claudeCodeCustomModelInput?.select();
        }, 0);
        return;
      }
      const selected = claudeModelPreferenceOptions.find(
        (option) => option.key === selectedKey,
      );
      if (!selected) return;
      setClaudeRuntimeModelPref(selected.model);
      setClaudeCustomModelVisible(false);
      claudeCodeModelSelect.title =
        selected.description || selected.model || "";
    });
    void refreshClaudeModelSuggestions(true);
  }

  if (claudeCodeCustomModelInput) {
    const commitClaudeCustomModel = () => {
      const model = claudeCodeCustomModelInput.value.trim();
      if (!model) {
        claudeCodeCustomModelInput.value = getClaudeRuntimeModelPref();
        return;
      }
      setClaudeRuntimeModelPref(model);
      claudeCodeCustomModelInput.value = getClaudeRuntimeModelPref();
      if (claudeCodeModelSelect) {
        claudeCodeModelSelect.value = CLAUDE_CUSTOMIZED_MODEL_OPTION_KEY;
      }
    };
    claudeCodeCustomModelInput.addEventListener(
      "change",
      commitClaudeCustomModel,
    );
    claudeCodeCustomModelInput.addEventListener(
      "blur",
      commitClaudeCustomModel,
    );
    claudeCodeCustomModelInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      commitClaudeCustomModel();
    });
  }

  if (claudeCodeModelRefreshButton) {
    claudeCodeModelRefreshButton.addEventListener("click", () => {
      void refreshClaudeModelSuggestions(true);
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
        notesDirTestStatus.textContent = t("Testing…");

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
        if (group.authMode !== "api_key" || !group.apiKey.trim()) continue;
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
      // "main", empty, or unset → adopt the provider semantic search already
      // resolves automatically, so the card shows the configuration in force.
      // With nothing to reuse, fall back to "gemini" (free tier available).
      const auto = getAutoEmbeddingProviderSummary();
      const provider =
        auto && EMBEDDING_PRESETS[auto.providerId] ? auto.providerId : "gemini";
      writeEmbPref("embeddingProvider", provider);
      writeEmbPref("embeddingApiBase", EMBEDDING_PRESETS[provider].apiBase);
      if (!readEmbPref("embeddingModel")) {
        writeEmbPref(
          "embeddingModel",
          EMBEDDING_PRESETS[provider].defaultModel,
        );
      }
      return provider;
    };

    // Toggle visibility (same pattern as MinerU)
    const syncSemanticVisibility = () => {
      semanticSearchSubSettings.style.display = semanticSearchToggle.checked
        ? "flex"
        : "none";
    };

    // Show the stored choice, not the resolved outcome: a user who turned
    // semantic search on keeps the switch on — and the embedding card in
    // view — while no provider is available yet. With nothing stored, the
    // switch shows what semantic search resolves to on its own.
    const semanticSearchState = resolveSemanticSearchState();
    semanticSearchToggle.checked =
      semanticSearchState.source === "pref" ||
      (semanticSearchState.source === "auto" && semanticSearchState.enabled);
    syncSemanticVisibility();

    semanticSearchToggle.addEventListener("change", () => {
      writeEmbPref("enableSemanticSearch", semanticSearchToggle.checked);
      syncSemanticVisibility();
    });

    // Render the embedding config card inside sub-settings
    const renderEmbeddingCard = () => {
      semanticSearchMount.innerHTML = "";

      // Semantic search is on by choice but nothing can run it yet: say so,
      // instead of leaving the card to explain itself.
      if (
        semanticSearchState.source === "pref" &&
        !semanticSearchState.enabled
      ) {
        semanticSearchMount.appendChild(
          el(
            doc,
            "div",
            `${HELPER_STYLE} margin-bottom: 8px;`,
            t("No embedding provider is available yet; configure one below."),
          ),
        );
      }

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
        " border: 1px solid var(--llm-pref-stroke); border-radius: 6px;" +
        " box-sizing: border-box;";

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
  const mineruCloudModeButton = doc.querySelector(
    `#${config.addonRef}-mineru-mode-cloud`,
  ) as HTMLButtonElement | null;
  const mineruLocalModeButton = doc.querySelector(
    `#${config.addonRef}-mineru-mode-local`,
  ) as HTMLButtonElement | null;
  const mineruApiKeySection = doc.querySelector(
    `#${config.addonRef}-mineru-api-key-section`,
  ) as HTMLDivElement | null;
  const mineruApiKeyInput = doc.querySelector(
    `#${config.addonRef}-mineru-api-key`,
  ) as HTMLInputElement | null;
  const mineruCloudModelSection = doc.querySelector(
    `#${config.addonRef}-mineru-cloud-model-section`,
  ) as HTMLDivElement | null;
  const mineruCloudModelSelect = doc.querySelector(
    `#${config.addonRef}-mineru-cloud-model`,
  ) as HTMLSelectElement | null;
  const mineruLocalSection = doc.querySelector(
    `#${config.addonRef}-mineru-local-section`,
  ) as HTMLDivElement | null;
  const mineruLocalApiBaseInput = doc.querySelector(
    `#${config.addonRef}-mineru-local-api-base`,
  ) as HTMLInputElement | null;
  const mineruLocalBackendSelect = doc.querySelector(
    `#${config.addonRef}-mineru-local-backend`,
  ) as HTMLSelectElement | null;
  const mineruForceOcrInput = doc.querySelector(
    `#${config.addonRef}-mineru-force-ocr`,
  ) as HTMLInputElement | null;
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

  let selectedMineruMode: MineruMode = getMineruMode();
  const getSelectedMineruMode = (): MineruMode => selectedMineruMode;
  const clearMineruTestStatus = () => {
    if (!mineruTestStatus) return;
    mineruTestStatus.style.display = "none";
    mineruTestStatus.textContent = "";
  };
  const applyMineruModeButtonState = () => {
    const updateButton = (
      button: HTMLButtonElement | null,
      buttonMode: MineruMode,
    ) => {
      if (!button) return;
      const isActive = selectedMineruMode === buttonMode;
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
      button.style.color = isActive
        ? "FieldText"
        : "var(--fill-secondary, #888)";
      button.style.background = isActive ? "Field" : "transparent";
      button.style.fontWeight = isActive ? "600" : "500";
      button.style.boxShadow = isActive ? "0 1px 3px rgba(0,0,0,0.12)" : "none";
    };
    updateButton(mineruCloudModeButton, "cloud");
    updateButton(mineruLocalModeButton, "local");
  };
  const syncMineruModeVisibility = () => {
    const mode = getSelectedMineruMode();
    if (mineruApiKeySection) {
      mineruApiKeySection.style.display = mode === "cloud" ? "flex" : "none";
    }
    if (mineruCloudModelSection) {
      mineruCloudModelSection.style.display =
        mode === "cloud" ? "flex" : "none";
    }
    if (mineruLocalSection) {
      mineruLocalSection.style.display = mode === "local" ? "flex" : "none";
    }
  };
  const selectMineruMode = (mode: MineruMode) => {
    selectedMineruMode = mode;
    setMineruMode(mode);
    applyMineruModeButtonState();
    syncMineruModeVisibility();
    clearMineruTestStatus();
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
      const confirmed =
        await confirmMineruSyncPackageDeletion(shouldDisableSync);
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
    mineruSyncCleanBtn.addEventListener(
      "click",
      () => void runMineruSyncCleanup(),
    );
    mineruSyncCleanBtn.addEventListener(
      "command",
      () => void runMineruSyncCleanup(),
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

  if (mineruCloudModeButton || mineruLocalModeButton) {
    selectedMineruMode = getMineruMode();
    applyMineruModeButtonState();
    syncMineruModeVisibility();

    mineruCloudModeButton?.addEventListener("click", () => {
      selectMineruMode("cloud");
    });
    mineruLocalModeButton?.addEventListener("click", () => {
      selectMineruMode("local");
    });
  } else {
    syncMineruModeVisibility();
  }

  if (mineruApiKeyInput) {
    mineruApiKeyInput.value = getMineruApiKey();
    const getSelectedMineruApiKeyText = () => {
      const start = mineruApiKeyInput.selectionStart;
      const end = mineruApiKeyInput.selectionEnd;
      if (typeof start === "number" && typeof end === "number") {
        if (start === end) return "";
        return mineruApiKeyInput.value.slice(
          Math.min(start, end),
          Math.max(start, end),
        );
      }
      return mineruApiKeyInput.value;
    };
    const copySelectedMineruApiKeyText = (event?: ClipboardEvent) => {
      const text = getSelectedMineruApiKeyText();
      if (!text) return false;
      const clipboardData = event?.clipboardData;
      if (clipboardData) {
        clipboardData.setData("text/plain", text);
        event.preventDefault();
        return true;
      }
      void copyTextToClipboard(text);
      return true;
    };
    mineruApiKeyInput.addEventListener("input", () => {
      setMineruApiKey(mineruApiKeyInput.value);
    });
    mineruApiKeyInput.addEventListener("copy", (event) => {
      copySelectedMineruApiKeyText(event);
    });
    mineruApiKeyInput.addEventListener("keydown", (event) => {
      if (
        event.key.toLowerCase() !== "c" ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      if (copySelectedMineruApiKeyText()) {
        event.preventDefault();
      }
    });
  }

  if (mineruCloudModelSelect) {
    mineruCloudModelSelect.value = getMineruCloudModel();
    mineruCloudModelSelect.addEventListener("change", () => {
      const next: MineruCloudModel = normalizeMineruCloudModel(
        mineruCloudModelSelect.value,
      );
      setMineruCloudModel(next);
      mineruCloudModelSelect.value = next;
      clearMineruTestStatus();
    });
  }

  if (mineruLocalApiBaseInput) {
    mineruLocalApiBaseInput.value = getMineruLocalApiBase();
    const commitMineruLocalApiBase = () => {
      setMineruLocalApiBase(mineruLocalApiBaseInput.value);
      mineruLocalApiBaseInput.value = getMineruLocalApiBase();
    };
    mineruLocalApiBaseInput.addEventListener(
      "change",
      commitMineruLocalApiBase,
    );
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

  if (mineruForceOcrInput) {
    mineruForceOcrInput.checked = isMineruForceOcrEnabled();
    mineruForceOcrInput.addEventListener("change", () => {
      setMineruForceOcrEnabled(mineruForceOcrInput.checked);
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
            mineruTestStatus.textContent = t("Enter your MinerU API key first");
            mineruTestStatus.style.color = "#b45309";
            return;
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

  // ── MinerU advanced parse filters ──────────────────────────────
  const mineruMaxAutoPagesPreset = doc.querySelector(
    `#${config.addonRef}-mineru-max-auto-pages-preset`,
  ) as HTMLSelectElement | null;
  const mineruMaxAutoPagesInput = doc.querySelector(
    `#${config.addonRef}-mineru-max-auto-pages`,
  ) as HTMLInputElement | null;
  if (mineruMaxAutoPagesPreset && mineruMaxAutoPagesInput) {
    let editingPageLimit = false;
    const showSavedPageLimit = () => {
      editingPageLimit = false;
      const maxPages = getMineruMaxAutoPages();
      let savedOption = mineruMaxAutoPagesPreset.querySelector(
        'option[value="saved-custom"]',
      ) as HTMLOptionElement | null;
      if (savedOption) savedOption.remove();
      if ([0, 100, 200, 500, 1000].includes(maxPages)) {
        mineruMaxAutoPagesPreset.value = String(maxPages);
      } else {
        savedOption = doc.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "option",
        ) as HTMLOptionElement;
        savedOption.value = "saved-custom";
        savedOption.textContent = String(maxPages);
        mineruMaxAutoPagesPreset.prepend(savedOption);
        mineruMaxAutoPagesPreset.value = "saved-custom";
      }
      mineruMaxAutoPagesInput.value = String(maxPages || 100);
      mineruMaxAutoPagesInput.hidden = true;
      mineruMaxAutoPagesPreset.hidden = false;
    };
    const finishPageLimitEdit = (save: boolean, restoreFocus: boolean) => {
      if (!editingPageLimit) return;
      // Hiding the input can fire blur; finish this edit only once.
      editingPageLimit = false;
      if (save) {
        setMineruMaxAutoPages(
          normalizeMineruMaxAutoPages(mineruMaxAutoPagesInput.value),
        );
        notifyMineruParseFiltersChanged();
      }
      showSavedPageLimit();
      if (restoreFocus) mineruMaxAutoPagesPreset.focus();
    };
    showSavedPageLimit();
    mineruMaxAutoPagesPreset.addEventListener("change", () => {
      if (mineruMaxAutoPagesPreset.value === "custom") {
        editingPageLimit = true;
        mineruMaxAutoPagesPreset.hidden = true;
        mineruMaxAutoPagesInput.hidden = false;
        mineruMaxAutoPagesInput.focus();
        mineruMaxAutoPagesInput.select();
      } else if (mineruMaxAutoPagesPreset.value !== "saved-custom") {
        setMineruMaxAutoPages(Number(mineruMaxAutoPagesPreset.value));
        showSavedPageLimit();
        notifyMineruParseFiltersChanged();
      }
    });
    mineruMaxAutoPagesInput.addEventListener("input", () => {
      mineruMaxAutoPagesInput.value = mineruMaxAutoPagesInput.value.replace(
        /[^\d]/g,
        "",
      );
    });
    mineruMaxAutoPagesInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        finishPageLimitEdit(event.key === "Enter", true);
      }
    });
    mineruMaxAutoPagesInput.addEventListener("blur", () => {
      finishPageLimitEdit(true, false);
    });
  }

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
        notifyMineruParseFiltersChanged();
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

  // ── Usage tab ────────────────────────────────────────────────────
  // Registration only wires the tab; the ledger is read the first time the
  // tab is opened, so the preferences window still opens immediately.
  if (_window) {
    registerUsagePreferencePanel(_window);
  }
}
