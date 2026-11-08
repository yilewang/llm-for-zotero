/**
 * Which model Inline Ask uses (plan items 5 and D).
 *
 * - API runtime: the sidebar's selected model entry.
 * - Claude Code, or a WebChat entry: these run only in the sidebar, so the
 *   first API model entry.
 * - Codex app-server: Codex Direct (`codex_auth`) with the same runtime
 *   model; without a Codex Direct provider or a concrete, listed runtime
 *   model, the first API model entry.
 *
 * "API model entry" means an entry the direct chat transport can call: not
 * WebChat, not the Codex app server, and not a Codex Direct model the live
 * catalog no longer lists.
 */
import { CODEX_DIRECT_RESPONSES_URL } from "../../../codexAuth/auth";
import type { AdvancedModelParams } from "../../../shared/types";
import type {
  ModelProviderAuthMode,
  RuntimeModelEntry,
} from "../../../utils/modelProviders";
import type { ProviderProtocol } from "../../../utils/providerProtocol";

export type InlineAskModelRuleInput = {
  /** The reader surface's conversation system ("upstream" is the API). */
  conversationSystem: string;
  /** The sidebar's selected model entry. */
  sidebarEntry: RuntimeModelEntry | null;
  /** Every configured model entry, in settings order. */
  entries: RuntimeModelEntry[];
  codexDirect: {
    /** A Codex Direct provider group with at least one model exists. */
    configured: boolean;
    /** The Codex app-server runtime model the sidebar selected. */
    runtimeModel: string;
    /** False when the loaded Codex Direct catalog does not list the model. */
    isModelAvailable: (model: string) => boolean;
  };
};

export type InlineAskModelTarget = {
  source: "sidebar" | "first_api" | "codex_runtime";
  entryId?: string;
  model: string;
  apiBase: string;
  apiKey: string;
  authMode: Exclude<ModelProviderAuthMode, "webchat" | "codex_app_server">;
  providerProtocol: ProviderProtocol;
  providerLabel: string;
  displayLabel: string;
  advanced?: AdvancedModelParams;
};

export function isInlineAskApiEntry(
  entry: RuntimeModelEntry | null | undefined,
): entry is RuntimeModelEntry {
  if (!entry || !entry.model.trim()) return false;
  if (entry.authMode === "webchat" || entry.authMode === "codex_app_server") {
    return false;
  }
  return entry.catalogAvailability !== "saved-unavailable";
}

function fromEntry(
  entry: RuntimeModelEntry,
  source: InlineAskModelTarget["source"],
): InlineAskModelTarget {
  return {
    source,
    entryId: entry.entryId,
    model: entry.model,
    apiBase: entry.apiBase,
    apiKey: entry.apiKey,
    authMode: entry.authMode as InlineAskModelTarget["authMode"],
    providerProtocol: entry.providerProtocol,
    providerLabel: entry.providerLabel,
    displayLabel: entry.displayModelLabel || entry.model,
    advanced: entry.advanced as AdvancedModelParams | undefined,
  };
}

function firstApiTarget(
  entries: RuntimeModelEntry[],
): InlineAskModelTarget | null {
  const first = entries.find((entry) => isInlineAskApiEntry(entry));
  return first ? fromEntry(first, "first_api") : null;
}

function isConcreteRuntimeModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return Boolean(normalized) && normalized !== "auto";
}

function codexRuntimeTarget(
  input: InlineAskModelRuleInput,
  runtimeModel: string,
): InlineAskModelTarget | null {
  const model = runtimeModel.trim();
  if (
    !input.codexDirect.configured ||
    !isConcreteRuntimeModel(model) ||
    !input.codexDirect.isModelAvailable(model)
  ) {
    return null;
  }
  const saved = input.entries.find(
    (entry) =>
      entry.authMode === "codex_auth" &&
      entry.model.trim().toLowerCase() === model.toLowerCase() &&
      isInlineAskApiEntry(entry),
  );
  if (saved) return fromEntry(saved, "codex_runtime");
  return {
    source: "codex_runtime",
    model,
    apiBase: CODEX_DIRECT_RESPONSES_URL,
    apiKey: "",
    authMode: "codex_auth",
    providerProtocol: "codex_responses",
    providerLabel: "Codex Direct",
    displayLabel: model,
  };
}

export function resolveInlineAskModelTarget(
  input: InlineAskModelRuleInput,
): InlineAskModelTarget | null {
  const sidebar = input.sidebarEntry;
  if (input.conversationSystem === "codex") {
    return (
      codexRuntimeTarget(input, input.codexDirect.runtimeModel) ||
      firstApiTarget(input.entries)
    );
  }
  if (input.conversationSystem === "claude_code") {
    return firstApiTarget(input.entries);
  }
  if (sidebar?.authMode === "codex_app_server") {
    return (
      codexRuntimeTarget(input, sidebar.model) || firstApiTarget(input.entries)
    );
  }
  if (isInlineAskApiEntry(sidebar)) return fromEntry(sidebar, "sidebar");
  return firstApiTarget(input.entries);
}
