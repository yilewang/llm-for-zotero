import type { ModelProviderAuthMode } from "../../../utils/modelProviders";

export type ProviderCardKind =
  | "api_key"
  | "codex_app_server"
  | "codex_direct"
  | "copilot"
  | "webchat";

export type ProviderCardModeSpec = Readonly<{
  kind: ProviderCardKind;
  showProviderPreset: boolean;
  showApiKey: boolean;
  showCopilotLogin: boolean;
  compactBody: boolean;
}>;

type ProviderCardModeFactory = () => ProviderCardModeSpec;

const PROVIDER_CARD_FACTORIES = {
  api_key: () => ({
    kind: "api_key",
    showProviderPreset: true,
    showApiKey: true,
    showCopilotLogin: false,
    compactBody: false,
  }),
  codex_app_server: () => ({
    kind: "codex_app_server",
    showProviderPreset: false,
    showApiKey: false,
    showCopilotLogin: false,
    compactBody: true,
  }),
  codex_auth: () => ({
    kind: "codex_direct",
    showProviderPreset: false,
    showApiKey: false,
    showCopilotLogin: false,
    compactBody: true,
  }),
  copilot_auth: () => ({
    kind: "copilot",
    showProviderPreset: false,
    showApiKey: false,
    showCopilotLogin: true,
    compactBody: false,
  }),
  webchat: () => ({
    kind: "webchat",
    showProviderPreset: false,
    showApiKey: false,
    showCopilotLogin: false,
    compactBody: true,
  }),
} satisfies Record<ModelProviderAuthMode, ProviderCardModeFactory>;

export function createProviderCardModeSpec(
  authMode: ModelProviderAuthMode,
): ProviderCardModeSpec {
  return Object.freeze(PROVIDER_CARD_FACTORIES[authMode]());
}
