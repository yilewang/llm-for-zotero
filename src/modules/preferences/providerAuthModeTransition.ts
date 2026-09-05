import { WEBCHAT_TARGETS } from "../../webchat/types";
import { CODEX_DIRECT_RESPONSES_URL } from "../../codexAuth/auth";
import {
  createCodexDirectModelRow,
  createProviderModelEntry,
  migrateApiBaseForAuthModeChange,
  type CodexDirectProviderGroup,
  type ConfigurableModelProviderAuthMode,
  type ModelProviderAuthMode,
  type ModelProviderGroup,
  type ModelProviderModel,
  type StandardModelProviderGroup,
  type WebChatProviderGroup,
} from "../../utils/modelProviders";
import {
  detectProviderPreset,
  getProviderPreset,
} from "../../utils/providerPresets";

export const DEFAULT_COPILOT_API_BASE = "https://api.githubcopilot.com";

function directRows(group: ModelProviderGroup) {
  const rows = group.models.map((row) => ({
    id: row.id,
    model: row.model.trim(),
  }));
  return rows.length ? rows : [createCodexDirectModelRow()];
}

function configurableRows(group: ModelProviderGroup): ModelProviderModel[] {
  const rows =
    group.authMode === "api_key" ||
    group.authMode === "codex_app_server" ||
    group.authMode === "copilot_auth"
      ? group.models.map((row) => ({ ...row }))
      : group.models.map((row) => ({
          ...createProviderModelEntry(row.model),
          id: row.id,
        }));
  return rows.length ? rows : [createProviderModelEntry()];
}

function webChatRows(group: ModelProviderGroup) {
  if (group.authMode === "webchat") {
    return group.models.map((row) => ({ ...row }));
  }
  const validModels = new Set<string>(
    WEBCHAT_TARGETS.map((target) => target.modelName),
  );
  const selected = group.models.find((row) => validModels.has(row.model));
  const source = selected || group.models[0];
  return [
    {
      id: source?.id || createProviderModelEntry().id,
      model: selected?.model || "chatgpt.com",
    },
  ];
}

function defaultApiKeyProtocol(group: ModelProviderGroup) {
  if (group.authMode === "codex_auth" || group.authMode === "webchat") {
    return "openai_chat_compat" as const;
  }
  const presetId =
    group.presetIdOverride ?? detectProviderPreset(group.apiBase);
  return presetId === "customized"
    ? "openai_chat_compat"
    : getProviderPreset(presetId).defaultProtocol;
}

export function transitionProviderAuthMode(
  group: ModelProviderGroup,
  nextAuthMode: ModelProviderAuthMode,
): ModelProviderGroup {
  if (nextAuthMode === "codex_auth") {
    const next: CodexDirectProviderGroup = {
      id: group.id,
      apiBase: CODEX_DIRECT_RESPONSES_URL,
      apiKey: "",
      authMode: "codex_auth",
      providerProtocol: "codex_responses",
      models: directRows(group),
    };
    return next;
  }

  if (nextAuthMode === "webchat") {
    const next: WebChatProviderGroup = {
      id: group.id,
      authMode: "webchat",
      providerProtocol: "web_sync",
      models: webChatRows(group),
    };
    return next;
  }

  const configurableAuthMode: ConfigurableModelProviderAuthMode = nextAuthMode;
  const apiBase = migrateApiBaseForAuthModeChange(
    group.authMode,
    configurableAuthMode,
    group.authMode === "webchat" ? "" : group.apiBase,
  );
  const next: StandardModelProviderGroup = {
    id: group.id,
    apiBase,
    apiKey:
      group.authMode === "codex_auth" || group.authMode === "webchat"
        ? ""
        : group.apiKey,
    authMode: configurableAuthMode,
    providerProtocol:
      configurableAuthMode === "codex_app_server"
        ? "codex_responses"
        : configurableAuthMode === "copilot_auth"
          ? "openai_chat_compat"
          : defaultApiKeyProtocol(group),
    models: configurableRows(group),
    ...(group.authMode === "codex_auth" || group.authMode === "webchat"
      ? {}
      : { presetIdOverride: group.presetIdOverride }),
  };

  if (configurableAuthMode === "copilot_auth" && !next.apiBase.trim()) {
    next.apiBase = DEFAULT_COPILOT_API_BASE;
  }

  return next;
}
