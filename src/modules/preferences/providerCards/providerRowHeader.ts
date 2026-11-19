import { t } from "../../../utils/i18n";
import type { ModelProviderGroup } from "../../../utils/modelProviders";
import {
  getProviderPreset,
  providerPresetRequiresApiKey,
  resolveProviderPresetId,
  type SupportedProviderPresetId,
} from "../../../utils/providerPresets";
import { getWebChatTargetByModelName } from "../../../webchat/types";

/**
 * A provider card is the same collapsible row the Agent tab uses for its
 * runtimes, so its collapsed head has to answer "is this set up, and as
 * what?" without being opened. This module is the single owner of that
 * answer: the icon, the right-hand tag, the summary line and the state dot.
 */

/** Suffix of the `.llm-pref-row-icon--*` class the row wears. */
export type ProviderRowIconModifier =
  | "provider"
  | "codex"
  | "webchat"
  | `preset-${Exclude<SupportedProviderPresetId, "local_openai">}`;

export type ProviderRowDescription = {
  iconModifier: ProviderRowIconModifier;
  /** Short auth-family label shown at the right edge of the head. */
  tag: string;
  /** One line under the provider name: what it is, and what it holds. */
  summary: string;
  /** Whether the row's state dot is green — the provider can answer a turn. */
  configured: boolean;
};

type AuthFamily = {
  iconModifier: ProviderRowIconModifier;
  tag: string;
  name: string;
};

function namedModels(group: ModelProviderGroup): string[] {
  return group.models
    .map((entry) => entry.model.trim())
    .filter((model) => model.length > 0);
}

function describeAuthFamily(group: ModelProviderGroup): AuthFamily {
  switch (group.authMode) {
    case "codex_auth":
      return {
        iconModifier: "codex",
        tag: t("Codex CLI"),
        name: t("Codex Direct"),
      };
    case "codex_app_server":
      return {
        iconModifier: "codex",
        tag: t("Codex CLI"),
        name: t("Codex App Server"),
      };
    case "copilot_auth":
      return {
        iconModifier: "preset-copilot",
        tag: t("GitHub Copilot"),
        name: t("GitHub Copilot"),
      };
    case "webchat": {
      const targets = namedModels(group).map(getWebChatTargetByModelName);
      const target = targets[0];
      // A mixed or custom group has no single provider identity.
      if (target && targets.every((entry) => entry?.id === target.id)) {
        const iconModifier = {
          chatgpt: "preset-openai",
          deepseek: "preset-deepseek",
          gemini: "preset-gemini",
          yuanbao: "webchat",
        } as const;
        return {
          iconModifier: iconModifier[target.id as keyof typeof iconModifier],
          tag: t("Browser extension"),
          name: target.label,
        };
      }
      return {
        iconModifier: "webchat",
        tag: t("Browser extension"),
        name: t("WebChat"),
      };
    }
    default: {
      const presetId = resolveProviderPresetId(group);
      return {
        iconModifier:
          presetId === "customized" || presetId === "local_openai"
            ? "provider"
            : `preset-${presetId}`,
        tag: t("API Key"),
        name:
          presetId === "customized"
            ? t("Customized")
            : getProviderPreset(presetId).label,
      };
    }
  }
}

/**
 * Whether the provider holds the credentials its auth mode needs. Local
 * runtimes serve unauthenticated, so an empty key is a complete setup there;
 * Copilot only counts once its device login has returned a `ghu_` token.
 */
function hasCredentials(group: ModelProviderGroup): boolean {
  switch (group.authMode) {
    // Codex and WebChat authenticate outside the plugin — through `codex
    // login` and through the browser extension's own session — so there is
    // nothing here to check.
    case "codex_auth":
    case "codex_app_server":
    case "webchat":
      return true;
    case "copilot_auth":
      return group.apiKey.trim().startsWith("ghu_");
    default: {
      if (!group.apiBase.trim()) return false;
      if (!providerPresetRequiresApiKey(resolveProviderPresetId(group))) {
        return true;
      }
      return Boolean(group.apiKey.trim());
    }
  }
}

/** True when nothing at all has been filled in — a freshly added provider. */
function isUntouched(group: ModelProviderGroup): boolean {
  if (group.authMode !== "api_key") return false;
  return (
    !group.apiBase.trim() && !group.apiKey.trim() && !namedModels(group).length
  );
}

/**
 * How much of the summary line the model list may occupy. The summary sits in
 * the head's 1fr column at 10.5px, which holds roughly 75 characters before it
 * wraps and grows the row; 60 leaves room for the "+n more" suffix.
 */
const MODEL_LIST_BUDGET = 60;

/**
 * The names themselves, since the head has room for them and they say far
 * more than a count. Names are dropped from the end once the line would run
 * long, and what was dropped is stated rather than silently hidden — but at
 * least one name always survives, however long it is on its own.
 */
function describeModelList(names: string[]): string {
  if (!names.length) return t("no models yet");

  const shown: string[] = [];
  let width = 0;
  for (const name of names) {
    const cost = shown.length ? name.length + 2 : name.length;
    if (shown.length && width + cost > MODEL_LIST_BUDGET) break;
    shown.push(name);
    width += cost;
  }

  const hidden = names.length - shown.length;
  const list = shown.join(", ");
  return hidden
    ? `${list} ${t("+%n more").replace("%n", String(hidden))}`
    : list;
}

export function describeProviderRow(
  group: ModelProviderGroup,
): ProviderRowDescription {
  const family = describeAuthFamily(group);
  const models = namedModels(group);
  const configured = models.length > 0 && hasCredentials(group);

  if (isUntouched(group)) {
    return { ...family, summary: t("Not configured"), configured: false };
  }

  if (group.authMode === "webchat" && family.iconModifier !== "webchat") {
    return {
      ...family,
      summary: `${family.name} · ${t("WebChat")}`,
      configured,
    };
  }

  // WebChat targets carry friendlier names than their model ids.
  const display =
    group.authMode === "webchat"
      ? models.map(
          (model) => getWebChatTargetByModelName(model)?.label || model,
        )
      : models;

  return {
    ...family,
    summary: `${family.name}${group.authMode === "api_key" ? ` · ${t("API")}` : ""} · ${describeModelList(display)}`,
    configured,
  };
}
