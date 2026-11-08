/**
 * Which model reads a paper for the host, and through which runtime.
 *
 * Per-paper reading (digests now; full-read batches and a user-chosen reader
 * model later) calls one `ReaderCompletion`. This module picks it from the
 * request: by default the main model of the current runtime, through that
 * runtime's own tool-free route.
 *
 * - Plugin Agent: the turn's provider, through `callUtilityLLM`.
 * - Codex: the Codex Responses endpoint, with the chat's model.
 * - Claude Code: the bridge's structured completion, with the chat's model.
 *
 * An explicit `choice` overrides the default; it is the seam a reader picker
 * plugs into. Nothing here reads preferences.
 */
import type {
  ReaderCompletion,
  ReaderRoute,
} from "../../shared/readerCompletion";
import {
  createUtilityReaderCompletion,
  utilityReaderOutputCeiling,
  type UtilityReaderConfig,
} from "../../utils/utilityReaderCompletion";
import { createCodexResponsesCompletion } from "../../codexAppServer/readerCompletion";
import { createClaudeBridgeCompletion } from "../../claudeCode/structuredCompletion";
import { resolveModelInputTokenLimit } from "../../utils/modelInputCap";
import { DEFAULT_INPUT_TOKEN_CAP } from "../../utils/llmDefaults";
import type { AgentRuntimeRequest } from "../types";

/** The placeholder model name of a Codex chat with no model picked. */
const CODEX_PLACEHOLDER_MODEL = "codex-app-server";

/** An explicit reader, as a picker would name it. */
export type ReaderChoice =
  | ({
      route: "turn_model";
      model: string;
    } & Omit<UtilityReaderConfig, "llmCall">)
  | { route: "codex_responses"; model: string }
  | { route: "claude_bridge"; model: string };

export type ResolvedReader = {
  route: ReaderRoute;
  /** The concrete model that reads; recorded on each digest. */
  model: string;
  complete: ReaderCompletion;
  /** The reader model's context window in tokens, for batch sizing. */
  windowTokens: number;
  /**
   * The most output tokens one call may ask for, when the route honors an
   * output budget (the turn model); undefined otherwise.
   */
  maxOutputTokens?: number;
};

export type ReaderResolution =
  | { ok: true; reader: ResolvedReader }
  | {
      ok: false;
      /** Why no reader could be picked; shown to the model as given. */
      detail: string;
    };

/** The request fields the resolver reads. */
export type ReaderRequest = Pick<
  AgentRuntimeRequest,
  | "model"
  | "apiBase"
  | "apiKey"
  | "authMode"
  | "providerProtocol"
  | "advanced"
  | "runtimeContextBudget"
  | "exhaustiveReadBackend"
>;

/** Test seams: each route's adapter factory. */
export type ReaderAdapterFactories = {
  turnModel?: (config: UtilityReaderConfig) => ReaderCompletion;
  codexResponses?: () => ReaderCompletion;
  claudeBridge?: () => ReaderCompletion;
};

/** The route a request reads through when no reader is chosen. */
export function defaultReaderRoute(request: ReaderRequest): ReaderRoute {
  if (request.exhaustiveReadBackend === "claude_bridge") return "claude_bridge";
  if (
    request.exhaustiveReadBackend === "codex_responses" ||
    request.authMode === "codex_app_server"
  )
    return "codex_responses";
  return "turn_model";
}

type RegistryIdentity = NonNullable<
  Parameters<typeof resolveModelInputTokenLimit>[2]
>;

function registryWindowTokens(
  model: string,
  identity: RegistryIdentity,
  inputTokenCap?: number,
): number {
  return (
    resolveModelInputTokenLimit(model, inputTokenCap, identity).limitTokens ||
    DEFAULT_INPUT_TOKEN_CAP
  );
}

/** The request's own registry identity, as paper_read's full mode sizes it. */
function requestIdentity(request: ReaderRequest): RegistryIdentity {
  return {
    apiBase: request.apiBase,
    protocol: request.providerProtocol,
    authMode: request.authMode,
    profileOverride: request.advanced?.profileOverride,
  };
}

/**
 * The reader for one request. `choice`, when given, names the reader
 * outright; otherwise the request's runtime picks it. Fails, never
 * defaults, when the route has no concrete model or (MCP without a native
 * runtime) no reader at all.
 */
export function resolveReaderCompletion(params: {
  request: ReaderRequest;
  choice?: ReaderChoice;
  /** Test seam forwarded to the turn-model adapter. */
  llmCall?: UtilityReaderConfig["llmCall"];
  factories?: ReaderAdapterFactories;
}): ReaderResolution {
  const { request, choice } = params;
  const factories = params.factories || {};
  if (
    !choice &&
    request.exhaustiveReadBackend === "unavailable" &&
    request.authMode !== "codex_app_server"
  ) {
    return {
      ok: false,
      detail:
        "No reader model is available for this MCP client; per-paper reading runs only inside a Codex or Claude Code chat in Zotero.",
    };
  }
  const route = choice?.route || defaultReaderRoute(request);
  const model = `${choice?.model ?? request.model ?? ""}`.trim();

  if (route === "codex_responses") {
    if (!model || model === CODEX_PLACEHOLDER_MODEL) {
      return {
        ok: false,
        detail: "The Codex reader has no selected model.",
      };
    }
    return {
      ok: true,
      reader: {
        route,
        model,
        complete: factories.codexResponses
          ? factories.codexResponses()
          : createCodexResponsesCompletion({
              profileOverride: choice
                ? undefined
                : request.advanced?.profileOverride,
            }),
        windowTokens: choice
          ? registryWindowTokens(model, {
              authMode: "codex_auth",
              protocol: "codex_responses",
            })
          : registryWindowTokens(
              model,
              requestIdentity(request),
              request.advanced?.inputTokenCap,
            ),
      },
    };
  }

  if (route === "claude_bridge") {
    if (!model) {
      return { ok: false, detail: "The Claude reader has no selected model." };
    }
    return {
      ok: true,
      reader: {
        route,
        model,
        complete: factories.claudeBridge
          ? factories.claudeBridge()
          : createClaudeBridgeCompletion(),
        windowTokens: choice
          ? registryWindowTokens(model, { protocol: "anthropic_messages" })
          : registryWindowTokens(
              model,
              requestIdentity(request),
              request.advanced?.inputTokenCap,
            ),
      },
    };
  }

  // The turn's own provider, or a chosen API model entry's.
  const config: UtilityReaderConfig =
    choice && choice.route === "turn_model"
      ? {
          apiBase: choice.apiBase,
          apiKey: choice.apiKey,
          authMode: choice.authMode,
          providerProtocol: choice.providerProtocol,
          profileOverride: choice.profileOverride,
          llmCall: params.llmCall,
        }
      : {
          apiBase: request.apiBase,
          apiKey: request.apiKey,
          authMode: request.authMode,
          providerProtocol: request.providerProtocol,
          profileOverride: request.advanced?.profileOverride,
          llmCall: params.llmCall,
        };
  const windowTokens = choice
    ? registryWindowTokens(model, {
        apiBase: config.apiBase,
        protocol: config.providerProtocol,
        authMode: config.authMode,
        profileOverride: config.profileOverride,
      })
    : request.runtimeContextBudget?.contextWindowTokens ||
      DEFAULT_INPUT_TOKEN_CAP;
  const maxOutputTokens = model
    ? utilityReaderOutputCeiling({ ...config, model })
    : undefined;
  // An unconfigured turn model still resolves: the utility layer reports it
  // as not configured on the first call, as digests always have.
  return {
    ok: true,
    reader: {
      route: "turn_model",
      model,
      complete: factories.turnModel
        ? factories.turnModel(config)
        : createUtilityReaderCompletion(config),
      windowTokens,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    },
  };
}

/**
 * The same reader behind another completion (a call limiter, a retry). It
 * keeps the reader's own properties live: a reader that changes its model
 * (the chosen reader falling back to the main model) is still read at the
 * time of use, not copied once.
 */
export function mapReaderCompletion(
  reader: ResolvedReader,
  map: (complete: ReaderCompletion) => ReaderCompletion,
): ResolvedReader {
  return Object.create(reader, {
    complete: { value: map(reader.complete), enumerable: true },
  }) as ResolvedReader;
}
