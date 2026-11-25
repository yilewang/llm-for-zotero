/**
 * The Antigravity agent runtime: the shared external-runtime turn host
 * driving `agy acp` through the ACP client.
 *
 * A turn:
 * 1. writes the conversation's agy config, which names the Zotero MCP server
 *    under a conversation-stable scope token (agyProfile.ts), and starts (or
 *    reuses) the pooled agy process for that config, the working folder, and
 *    the permission level;
 * 2. reuses the conversation's agy session when this process already has
 *    it, resumes the stored one otherwise, or starts a new one;
 * 3. sets the session's mode from the permission setting;
 * 4. sends the prompt and maps agy's updates to agent events;
 * 5. answers agy's permission requests: read-only Zotero tools are allowed
 *    (the Zotero MCP server reviews every write itself), everything else
 *    becomes a review card;
 * 6. saves the session id on the conversation.
 *
 * agy ends a turn with no text after a denied tool; the answer then says
 * the turn stopped at the denial instead of staying empty.
 */

import {
  ACP_METHOD_NOT_FOUND_ERROR_CODE,
  type AcpContentBlock,
  type AcpPermissionOption,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpSessionNotification,
  type AcpSessionState,
  type AcpToolCall,
} from "../shared/acpProtocol";
import type { AgentRuntime } from "../agent/runtime";
import type {
  AgentEvent,
  AgentPendingAction,
  AgentRuntimeOutcome,
  AgentRuntimeRequest,
} from "../agent/types";
import {
  buildExternalRuntimeUserText,
  buildExternalRuntimeZoteroMcpScope,
  resolveClaudeBridgeMcpScopeToken,
  type AgentRuntimeLike,
  type RunTurnParams,
} from "../agent/externalBackendBridge";
import {
  runExternalRuntimeTurn,
  type ExternalRuntimeTransport,
  type ExternalTurnOutcome,
  type ExternalTurnRunContext,
} from "../agent/externalRuntimeTurnHost";
import { buildAgentModelCapabilities } from "../agent/model/contentCapabilities";
import { AGENT_PERSONA_INSTRUCTIONS } from "../agent/model/agentPersona";
import {
  buildTurnContextEnvelope,
  renderTurnContextEnvelopeForModel,
} from "../agent/context/turnContextEnvelope";
import {
  ZOTERO_MCP_HOST_ACCESS_TOOL_NAMES,
  ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
} from "../agent/mcp/server";
import { getZoteroAgentRuntimeRootDir } from "../agent/skills/nativeSkillPaths";
import {
  buildAgyZoteroMcpServerConfig,
  REQUIRED_ANTIGRAVITY_RAW_PDF_MCP_TOOL_NAMES,
  REQUIRED_ANTIGRAVITY_ZOTERO_MCP_TOOL_NAMES,
} from "../codexAppServer/mcpSetup";
import { withConversationWriteLock } from "../shared/conversationWriteFence";
import { JsonRpcResponseError } from "../utils/stdioJsonRpcConnection";
import { ensureDir } from "../utils/geckoFs";
import { joinLocalPath } from "../utils/localPath";
import { AcpClient } from "./acpClient";
import {
  getOrStartAgyClient,
  holdAgyProcess,
  type AgyLaunchOptions,
} from "./agyProcess";
import {
  isAgyOwnFileRead,
  toolArguments,
  zoteroToolNameOf,
} from "./agyToolCalls";
import {
  ANTIGRAVITY_EAGER_ZOTERO_TOOL_NAMES,
  prepareAgyProfile,
  type AgyMcpServer,
  type AgyProfile,
} from "./agyProfile";
import { getAntigravityProfileSignature } from "./conversationKeys";
import {
  getAntigravityBinaryPathPref,
  getAntigravityPermissionModePref,
  isAntigravityModeEnabled,
  type AntigravityPermissionMode,
} from "./prefs";
import { antigravityConversationStore } from "./store";
import { buildAntigravityPromptInput } from "./promptInput";
import {
  listAntigravitySlashCommands,
  trackAntigravityCommands,
  waitForAntigravityCommands,
  type AntigravitySlashCommand,
} from "./commands";
import {
  ANTIGRAVITY_MODEL_OPTION_ID,
  ANTIGRAVITY_THOUGHT_LEVEL_OPTION_ID,
  getRememberedAntigravityModelCatalog,
  loadAntigravityModelCatalog,
  rememberAntigravityModelCatalog,
  resolveAntigravityModelChoice,
  type AntigravityModelCatalog,
} from "./modelCatalog";

/** The Zotero data folder (the library's files), or "" when unknown. */
function getZoteroDataDirectory(): string {
  try {
    return String(
      (Zotero as unknown as { DataDirectory?: { dir?: string } }).DataDirectory
        ?.dir || "",
    );
  } catch {
    return "";
  }
}

/** Every Antigravity conversation of a profile runs in this folder. */
export function getAntigravityRuntimeCwd(): string {
  return joinLocalPath(getZoteroAgentRuntimeRootDir(), "antigravity");
}

const DENIED_TURN_TEXT =
  "Antigravity stopped this turn because a tool request was declined. Allow the tool or rephrase the request to continue.";

const ANTIGRAVITY_SEARCH_ROUTES =
  "Search tools: the Zotero MCP tools read the turn's papers (paper_read), search the library (library_retrieve, library_search), search scholarly sources (literature_search), and read a found paper's abstract and open-access text (literature_read). Write web search queries in the user's language by default.";

/** The standing instructions sent once at the start of a session. */
export function buildAntigravityInstructions(rawPdfMode: boolean): string {
  return [
    "## Original agent-mode Zotero behavior",
    ...AGENT_PERSONA_INSTRUCTIONS,
    rawPdfMode
      ? "You receive Zotero MCP access for metadata and write operations. For raw-PDF identities, use the exact current-turn local paths instead of Zotero paper-content retrieval."
      : "You receive Zotero access through the scoped Zotero MCP tools. Use library_search, library_retrieve, library_read, and paper_read for Zotero library or paper-content questions before relying on filesystem exploration or conversation-visible snippets.",
    ANTIGRAVITY_SEARCH_ROUTES,
    'If the turn includes selected collection or tag scopes, resolve phrases like "this folder", "this collection", and "this tag" against those selected Zotero scopes.',
    "A note you are asked to write is a Zotero note: use the Zotero note_write tool, not a file-writing tool. note_write is the only note path Zotero can authorize, journal, and verify against the saved note.",
  ].join("\n\n");
}

/** The agy session mode for a permission setting (full access runs as default). */
export function resolveAntigravitySessionMode(
  mode: AntigravityPermissionMode,
): string {
  return mode === "full-access" ? "default" : mode;
}

export function buildAgyLaunchOptions(
  mode: AntigravityPermissionMode,
  profile: AgyProfile,
  cwd = getAntigravityRuntimeCwd(),
  agyPath = getAntigravityBinaryPathPref(),
): AgyLaunchOptions {
  return {
    cwd,
    skipPermissions: mode === "full-access",
    ...(agyPath ? { agyPath } : {}),
    profile,
  };
}

/**
 * The launch options of an agy that serves no conversation: the pickers'
 * model and command lists, and the settings test. It has no MCP server.
 */
export async function prepareAgyPickerLaunchOptions(
  mode = getAntigravityPermissionModePref(),
): Promise<AgyLaunchOptions> {
  const launch = buildAgyLaunchOptions(
    mode,
    await prepareAgyProfile({ servers: [] }),
  );
  await ensureDir(launch.cwd);
  return launch;
}

function chooseOption(
  options: AcpPermissionOption[],
  allow: boolean,
): AcpRequestPermissionResult {
  const kinds = allow
    ? ["allow_once", "allow_always"]
    : ["reject_once", "reject_always"];
  const option = options.find((entry) => kinds.includes(entry.kind));
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

function describeToolContent(call: AcpToolCall): unknown {
  if (call.rawOutput !== undefined) return call.rawOutput;
  const texts = (call.content || [])
    .map((entry) => {
      const record = entry as {
        type?: string;
        content?: { type?: string; text?: string };
        text?: string;
      };
      return record.content?.text ?? record.text ?? "";
    })
    .filter(Boolean);
  return texts.length ? texts.join("\n") : null;
}

export function buildAntigravityPermissionAction(
  params: AcpRequestPermissionParams,
): AgentPendingAction {
  const call = params.toolCall;
  const label = call.title || call.name || "a tool";
  return {
    toolName: call.name || call.title || "antigravity_tool",
    title: `Allow Antigravity to run ${label}?`,
    mode: "approval",
    confirmLabel: "Allow",
    cancelLabel: "Deny",
    description: call.kind ? `Tool kind: ${call.kind}.` : undefined,
    fields: [
      {
        type: "textarea",
        id: "args",
        label: "Arguments",
        value: JSON.stringify(toolArguments(call), null, 2),
        editorMode: "json",
        spellcheck: false,
      },
    ],
  } as AgentPendingAction;
}

/**
 * Turns one turn's ACP updates into agent events. Zotero MCP tool calls are
 * left out: the turn host reports them from the MCP server itself.
 */
export function createAcpEventMapper(options: {
  zoteroServerName?: string;
  /** agy's data folder (see isAgyOwnFileRead). */
  agyDataDir?: string;
  emit: (event: AgentEvent) => Promise<void>;
}) {
  let text = "";
  const finishedCalls = new Set<string>();
  const callNames = new Map<string, string>();
  const isZoteroCall = (call: AcpToolCall) =>
    Boolean(
      options.zoteroServerName &&
      zoteroToolNameOf(call, options.zoteroServerName),
    );
  const handle = async (notification: AcpSessionNotification) => {
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text" && update.content.text) {
          text += update.content.text;
          await options.emit({
            type: "message_delta",
            text: update.content.text,
          });
        }
        return;
      case "agent_thought_chunk":
        if (update.content.type === "text" && update.content.text) {
          await options.emit({
            type: "reasoning",
            round: 1,
            details: update.content.text,
          });
        }
        return;
      case "tool_call": {
        if (
          isZoteroCall(update) ||
          isAgyOwnFileRead(update, options.agyDataDir ?? "") ||
          callNames.has(update.toolCallId)
        )
          return;
        const name = update.name || update.title || "tool";
        callNames.set(update.toolCallId, name);
        await options.emit({
          type: "tool_call",
          callId: update.toolCallId,
          name,
          args: toolArguments(update),
          toolLabel: update.title,
        });
        return;
      }
      case "tool_call_update": {
        if (isZoteroCall(update)) return;
        const name = callNames.get(update.toolCallId);
        if (!name || finishedCalls.has(update.toolCallId)) return;
        if (update.status === "completed") {
          finishedCalls.add(update.toolCallId);
          await options.emit({
            type: "tool_result",
            callId: update.toolCallId,
            name,
            ok: true,
            toolLabel: update.title,
            actionReceipts: [],
            content: describeToolContent(update),
          });
        } else if (update.status === "failed") {
          finishedCalls.add(update.toolCallId);
          const detail = describeToolContent(update);
          await options.emit({
            type: "tool_error",
            callId: update.toolCallId,
            name,
            error:
              typeof detail === "string" && detail
                ? detail
                : "The tool did not complete.",
            round: 1,
            toolLabel: update.title,
          });
        }
        return;
      }
      case "usage_update":
        await options.emit({
          type: "usage",
          inputTokens: 0,
          outputTokens: 0,
          contextTokens: update.used,
          contextWindow: update.size,
          contextWindowIsAuthoritative: true,
          sessionId: notification.sessionId,
        });
        return;
      default:
        return;
    }
  };
  return { handle, text: () => text };
}

/** What a runtime keeps per agy process: the sessions it has open. */
type ClientSessionState = {
  modeId?: string;
  /** The session's config option values, such as `model`. */
  config: Record<string, string>;
};

const openSessionsByClient = new WeakMap<
  AcpClient,
  Map<string, ClientSessionState>
>();

function openSessions(client: AcpClient): Map<string, ClientSessionState> {
  let sessions = openSessionsByClient.get(client);
  if (!sessions) {
    sessions = new Map();
    openSessionsByClient.set(client, sessions);
  }
  return sessions;
}

function isSessionMissing(error: unknown): boolean {
  return (
    error instanceof JsonRpcResponseError &&
    (error.code === -32602 ||
      error.code === ACP_METHOD_NOT_FOUND_ERROR_CODE ||
      /not found/i.test(error.message))
  );
}

/** Saves the agy session on the conversation, if the turn may still write. */
async function rememberAntigravitySession(
  request: AgentRuntimeRequest,
  sessionId: string,
  cwd: string,
  writeAllowed: () => boolean,
): Promise<void> {
  if (!writeAllowed()) return;
  await withConversationWriteLock(request.conversationKey, async () => {
    if (!writeAllowed()) return;
    const summary = await antigravityConversationStore.getSummary(
      request.conversationKey,
    );
    if (!summary) return;
    if (summary.providerSessionId === sessionId && summary.cwd === cwd) return;
    await antigravityConversationStore.upsertSummary({
      conversationKey: summary.conversationKey,
      instanceID: summary.instanceID,
      libraryID: summary.libraryID,
      kind: summary.kind,
      paperItemID: summary.paperItemID,
      createdAt: summary.createdAt,
      updatedAt: Date.now(),
      title: summary.title,
      providerSessionId: sessionId,
      cwd,
      model: summary.model,
      effort: summary.effort,
    });
  });
}

type AntigravityPrepared = {
  mode: AntigravityPermissionMode;
  cwd: string;
  sessionMode: string;
  rawPdfMode: boolean;
};

/** The turn's Zotero MCP server, as agy's config names it. */
type AntigravityServers = AgyMcpServer;

function readConfigValues(
  state: Pick<AcpSessionState, "configOptions"> | null | undefined,
): Record<string, string> {
  return Object.fromEntries(
    (state?.configOptions ?? []).map((option) => [
      option.id,
      option.currentValue,
    ]),
  );
}

/**
 * The model and thinking level the turn's chat surface picked: the request's
 * model (an agy `model` value; empty for agy's own) and reasoning level.
 */
export function readAntigravityModelPicks(
  request: Pick<AgentRuntimeRequest, "model" | "reasoning">,
): { model: string; thoughtLevel: string } {
  const level = String(request.reasoning?.level || "").trim();
  return {
    model: String(request.model || "").trim(),
    thoughtLevel: level === "default" ? "" : level,
  };
}

/** Applies the turn's model and thinking level to the session. */
async function applyModelChoice(
  client: AcpClient,
  sessionId: string,
  state: ClientSessionState,
  picks: { model: string; thoughtLevel: string },
): Promise<void> {
  const catalog = getRememberedAntigravityModelCatalog();
  if (!catalog) return;
  const choice = resolveAntigravityModelChoice(catalog, picks);
  if (!choice.model) return;
  const current = {
    model: state.config[ANTIGRAVITY_MODEL_OPTION_ID] || "",
    thoughtLevel: state.config[ANTIGRAVITY_THOUGHT_LEVEL_OPTION_ID] || "",
  };
  // A model with a level is one model id in agy's list
  // (`gemini-4-hydrogen-xhigh`); session/set_model takes it in one call.
  const levelledId = choice.thoughtLevel
    ? `${choice.model}-${choice.thoughtLevel}`
    : "";
  if (levelledId && catalog.modelIds.includes(levelledId)) {
    if (
      current.model === choice.model &&
      current.thoughtLevel === choice.thoughtLevel
    ) {
      return;
    }
    await client.setModel(sessionId, levelledId);
    state.config[ANTIGRAVITY_MODEL_OPTION_ID] = choice.model;
    state.config[ANTIGRAVITY_THOUGHT_LEVEL_OPTION_ID] = choice.thoughtLevel;
    return;
  }
  if (current.model !== choice.model) {
    await client.setConfigOption(
      sessionId,
      ANTIGRAVITY_MODEL_OPTION_ID,
      choice.model,
    );
    state.config[ANTIGRAVITY_MODEL_OPTION_ID] = choice.model;
  }
}

/** Opens the conversation's session on this client: reuse, resume, or new. */
async function openSession(params: {
  client: AcpClient;
  request: AgentRuntimeRequest;
  cwd: string;
  /** The standing instructions; a new session takes them as its system prompt. */
  instructions: string;
}): Promise<{ sessionId: string; isNew: boolean; state: ClientSessionState }> {
  const { client, request, cwd } = params;
  const sessions = openSessions(client);
  // agy takes its MCP servers from its own config, not from the session.
  const mcpServers: [] = [];
  const forceFresh = request.metadata?.forceFreshSession === true;
  const summary = await antigravityConversationStore.getSummary(
    request.conversationKey,
  );
  const stored =
    !forceFresh && summary?.providerSessionId && summary.cwd === cwd
      ? summary.providerSessionId
      : "";
  if (stored) {
    const open = sessions.get(stored);
    if (open) {
      return { sessionId: stored, isNew: false, state: open };
    }
    const target = { sessionId: stored, cwd, mcpServers };
    let resumed: AcpSessionState | null = null;
    try {
      resumed = await client.resumeSession(target);
    } catch (error) {
      if (!isSessionMissing(error)) {
        // agy answers a resume it cannot serve with a general error that
        // points to session/load, and session/load says whether agy's data
        // holds the session at all. It does not for a chat from before the
        // plugin ran agy on its own data folder (agyProfile.ts).
        try {
          resumed = await client.loadSession(target);
        } catch (loadError) {
          if (!isSessionMissing(loadError)) throw error;
        }
      }
    }
    if (resumed) {
      const state: ClientSessionState = {
        modeId: resumed.modes?.currentModeId,
        config: readConfigValues(resumed),
      };
      rememberAntigravityModelCatalog(resumed);
      sessions.set(stored, state);
      return { sessionId: stored, isNew: false, state };
    }
  }
  const created = await client.newSession({
    cwd,
    mcpServers,
    _meta: { antigravity: { systemPrompt: { append: params.instructions } } },
  });
  const state: ClientSessionState = {
    modeId: created.modes?.currentModeId,
    config: readConfigValues(created),
  };
  rememberAntigravityModelCatalog(created);
  sessions.set(created.sessionId, state);
  return { sessionId: created.sessionId, isNew: true, state };
}

function createAbortError(): Error {
  const error = new Error("Antigravity turn cancelled");
  error.name = "AbortError";
  return error;
}

/** True for a read-only agy tool call that touches only attached files. */
/**
 * True for a read-only agy tool call that touches only files the turn may
 * read freely: files attached to the turn, and anything inside a readable
 * root (the Zotero data folder: the library's PDFs, and the page images and
 * attachments the Zotero tools save there). agy asks before reading any
 * file outside its own folder, in every mode, so without this a paper
 * question raised a card for each PDF or page image it opened.
 */
export function isFreeFileRead(
  toolCall: AcpToolCall,
  allowed: {
    attachedPaths: readonly string[];
    readableRoots: readonly string[];
  },
): boolean {
  if (toolCall.kind !== "read") return false;
  const paths = (toolCall.locations ?? []).map((location) => location.path);
  const roots = allowed.readableRoots
    .filter(Boolean)
    .map((root) => (/[\\/]$/.test(root) ? root : `${root}/`));
  return (
    paths.length > 0 &&
    paths.every(
      (path) =>
        typeof path === "string" &&
        (allowed.attachedPaths.includes(path) ||
          (!/(^|[\\/])\.\.([\\/]|$)/.test(path) &&
            roots.some((root) => path.startsWith(root)))),
    )
  );
}

/** Answers one agy permission request for the turn. */
function createPermissionHandler(options: {
  ctx: ExternalTurnRunContext<AntigravityPrepared, AntigravityServers>;
  zoteroServerName: string | undefined;
  /**
   * The chip's mode lets Zotero writes run without asking (Accept edits,
   * Auto). agy asks before every MCP tool in every mode, so the chip's
   * meaning is applied here, as Codex and Claude Code apply it. The tools
   * that reach the computer itself (commands, files, scripts) are not
   * library writes: outside full access they always ask.
   */
  allowZoteroWrites: boolean;
  /** Files agy reads without asking (see isFreeFileRead). */
  freeReads: {
    attachedPaths: readonly string[];
    readableRoots: readonly string[];
  };
  onDenied: () => void;
}) {
  const { ctx, zoteroServerName, onDenied, freeReads, allowZoteroWrites } =
    options;
  return async (
    params: AcpRequestPermissionParams,
    signal: AbortSignal,
  ): Promise<AcpRequestPermissionResult> => {
    const zoteroTool = zoteroServerName
      ? zoteroToolNameOf(params.toolCall, zoteroServerName)
      : null;
    // The Zotero tools' reads are safe; their writes follow the chip.
    if (
      zoteroTool &&
      ((ZOTERO_MCP_SAFE_READ_TOOL_NAMES as readonly string[]).includes(
        zoteroTool,
      ) ||
        (allowZoteroWrites &&
          !(ZOTERO_MCP_HOST_ACCESS_TOOL_NAMES as readonly string[]).includes(
            zoteroTool,
          )))
    ) {
      return chooseOption(params.options, true);
    }
    if (isFreeFileRead(params.toolCall, freeReads)) {
      return chooseOption(params.options, true);
    }
    const resolution = await ctx.requestInteraction(
      buildAntigravityPermissionAction(params),
      signal,
    );
    if (!resolution.approved) onDenied();
    return chooseOption(params.options, Boolean(resolution.approved));
  };
}

export type AntigravityTransportOptions = {
  /** Starts or reuses the agy client; tests pass a fake agy. */
  startClient?: (launch: AgyLaunchOptions) => Promise<AcpClient>;
};

export function createAntigravityTransport(
  options: AntigravityTransportOptions = {},
): ExternalRuntimeTransport<AntigravityPrepared, AntigravityServers> {
  const startClient = options.startClient ?? getOrStartAgyClient;

  async function runTurnOnAgy(
    ctx: ExternalTurnRunContext<AntigravityPrepared, AntigravityServers>,
    launch: AgyLaunchOptions,
  ): Promise<ExternalTurnOutcome> {
    const { request, prepared } = ctx;
    const signal = ctx.params.signal;
    const client = await startClient(launch);
    trackAntigravityCommands(client);
    const zoteroServerName = ctx.zoteroMcp?.servers.name;
    const session = await openSession({
      client,
      request,
      cwd: launch.cwd,
      instructions: buildAntigravityInstructions(prepared.rawPdfMode),
    });
    await rememberAntigravitySession(
      request,
      session.sessionId,
      launch.cwd,
      ctx.writeAllowed,
    );
    await applyModelChoice(
      client,
      session.sessionId,
      session.state,
      readAntigravityModelPicks(request),
    );
    if (session.state.modeId !== prepared.sessionMode) {
      await client.setMode(session.sessionId, prepared.sessionMode);
      session.state.modeId = prepared.sessionMode;
    }
    const runId = `antigravity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await ctx.onStart(runId);

    let denied = false;
    const mapper = createAcpEventMapper({
      zoteroServerName,
      agyDataDir: launch.profile.dataDir,
      emit: ctx.emit,
    });
    let mapping = Promise.resolve();
    const stopUpdates = client.onSessionUpdate(
      session.sessionId,
      (notification) => {
        const update = notification.update;
        if (update.sessionUpdate === "current_mode_update") {
          session.state.modeId = update.currentModeId;
        } else if (update.sessionUpdate === "config_option_update") {
          Object.assign(session.state.config, readConfigValues(update));
        }
        // Keep updates in order; one slow emit must not reorder them.
        mapping = mapping.then(() => mapper.handle(notification));
      },
    );
    const input = await buildAntigravityPromptInput(request);
    const stopPermissions = client.setPermissionHandler(
      session.sessionId,
      createPermissionHandler({
        ctx,
        zoteroServerName,
        allowZoteroWrites:
          prepared.sessionMode === "auto" ||
          prepared.sessionMode === "accept-edits",
        freeReads: {
          attachedPaths: input.attachedPaths,
          readableRoots: [getZoteroDataDirectory()],
        },
        onDenied: () => {
          denied = true;
        },
      }),
    );
    try {
      const result = await client.prompt(session.sessionId, input.blocks, {
        signal,
      });
      await mapping;
      if (result.stopReason === "cancelled" && signal?.aborted) {
        throw createAbortError();
      }
      let text = mapper.text();
      if (!text.trim() && denied) {
        text = DENIED_TURN_TEXT;
        await ctx.emit({ type: "message_delta", text });
      }
      if (!text.trim()) {
        return {
          kind: "fallback",
          runId,
          reason: `Antigravity ended the turn without an answer (${result.stopReason}).`,
          usedFallback: true,
        };
      }
      return { kind: "completed", runId, text, usedFallback: false };
    } finally {
      stopPermissions();
      stopUpdates();
    }
  }

  return {
    logLabel: "Antigravity",
    failureRunIdPrefix: "antigravity-error",
    prepare: async ({ request }) => {
      const mode = getAntigravityPermissionModePref();
      const cwd = getAntigravityRuntimeCwd();
      await ensureDir(cwd);
      return {
        mode,
        cwd,
        sessionMode: resolveAntigravitySessionMode(mode),
        rawPdfMode: Boolean(request.localDocuments?.length),
      };
    },
    zoteroMcp: {
      profileSignature: getAntigravityProfileSignature,
      buildScope: (request, profileSignature) =>
        buildExternalRuntimeZoteroMcpScope(request, profileSignature, {
          runtimeAuthority: "antigravity",
          // agy cannot be called for a sub-read; a full read needs the
          // reader model the user picked for Antigravity.
          exhaustiveReadBackend: "unavailable",
        }),
      scopeToken: resolveClaudeBridgeMcpScopeToken,
      buildServerConfig: ({ profileSignature, scopeToken, rawPdfMode }) => {
        const config = buildAgyZoteroMcpServerConfig({
          profileSignature,
          scopeToken,
          required: true,
          rawPdfMode,
        });
        return {
          serverName: config.serverName,
          servers: {
            name: config.serverName,
            url: config.url,
            headers: config.headers,
            eagerTools: ANTIGRAVITY_EAGER_ZOTERO_TOOL_NAMES,
          },
        };
      },
      requiredToolNames: (rawPdfMode) =>
        rawPdfMode
          ? REQUIRED_ANTIGRAVITY_RAW_PDF_MCP_TOOL_NAMES
          : REQUIRED_ANTIGRAVITY_ZOTERO_MCP_TOOL_NAMES,
    },
    run: async (ctx): Promise<ExternalTurnOutcome> => {
      const { request, prepared } = ctx;
      const signal = ctx.params.signal;
      if (signal?.aborted) throw createAbortError();
      const zoteroServer = ctx.zoteroMcp?.servers;
      const profile = await prepareAgyProfile({
        conversationKey: request.conversationKey,
        servers: zoteroServer ? [zoteroServer] : [],
      });
      const launch = buildAgyLaunchOptions(
        prepared.mode,
        profile,
        prepared.cwd,
      );
      const releaseProcess = holdAgyProcess(launch);
      try {
        return await runTurnOnAgy(ctx, launch);
      } finally {
        releaseProcess();
      }
    },
    describeFailure: (error) =>
      `Antigravity is unavailable: ${error instanceof Error ? error.message : String(error)}`,
  };
}

/**
 * The Antigravity runtime over a core runtime: tools, confirmations, and
 * traces come from the core; turns go to agy through the shared turn host.
 */
export function createAntigravityRuntime(
  coreRuntime: AgentRuntime,
  transport = createAntigravityTransport(),
): AgentRuntimeLike {
  return {
    listTools: () => coreRuntime.listTools(),
    prepareExecutionRequest: (request, options) =>
      coreRuntime.prepareExecutionRequest(request, options),
    getToolDefinition: (name: string) => coreRuntime.getToolDefinition(name),
    unregisterTool: (name: string) => coreRuntime.unregisterTool(name),
    registerTool: (tool) => coreRuntime.registerTool(tool),
    registerPendingConfirmation: (requestId, resolve) =>
      coreRuntime.registerPendingConfirmation(requestId, resolve),
    resolveConfirmation: (requestId, approvedOrResolution, data) =>
      coreRuntime.resolveConfirmation(requestId, approvedOrResolution, data),
    getRunTrace: (runId: string) => coreRuntime.getRunTrace(runId),
    // The engine picks this runtime only for an Antigravity turn.
    getCapabilities: (request) => {
      if (!isAntigravityModeEnabled()) {
        return coreRuntime.getCapabilities(request);
      }
      // Images, PDFs, and files reach agy in a later phase.
      return buildAgentModelCapabilities({
        streaming: true,
        toolCalls: true,
        // Images go inline; other files go as links agy reads (promptInput.ts).
        fileInputs: true,
        reasoning: true,
      });
    },
    runTurn: (params: RunTurnParams): Promise<AgentRuntimeOutcome> =>
      runExternalRuntimeTurn(params, { coreRuntime, transport }),
    listExternalActionsSync: () => [],
    refreshExternalActions: async () => undefined,
    listSlashCommandsSync: () =>
      listAntigravitySlashCommands().map((command) => ({
        ...command,
        source: "sdk" as const,
      })),
    refreshSlashCommands: async () => {
      await loadAntigravityPickerSlashCommands();
    },
    listEfforts: async () => [],
    listModels: async () => ({ models: [], legacy: false }),
    updateRuntimeRetention: async () => null,
    invalidateSession: async () => null,
    invalidateSessionWithinWriteLock: async () => null,
    invalidateAllHotRuntimes: async () => null,
    runExternalAction: async () => ({
      ok: false,
      error: "Antigravity has no external actions.",
    }),
  };
}

let cachedRuntime: AgentRuntimeLike | null = null;
let cachedCore: AgentRuntime | null = null;

/** The Antigravity runtime for this core runtime, created once. */
export function getAntigravityRuntime(
  coreRuntime: AgentRuntime,
): AgentRuntimeLike {
  if (!cachedRuntime || cachedCore !== coreRuntime) {
    cachedRuntime = createAntigravityRuntime(coreRuntime);
    cachedCore = coreRuntime;
  }
  return cachedRuntime;
}

/**
 * The model catalog for the pickers: the remembered one, or one loaded from
 * the pooled agy for the current permission setting.
 */
export async function loadAntigravityPickerModelCatalog(
  force = false,
): Promise<AntigravityModelCatalog> {
  const launch = await prepareAgyPickerLaunchOptions();
  return loadAntigravityModelCatalog({
    launch,
    startClient: async (next) => {
      const client = await getOrStartAgyClient(next);
      trackAntigravityCommands(client);
      return client;
    },
    force,
  });
}

/** How long the slash menu waits for agy to announce its commands. */
const COMMAND_ANNOUNCEMENT_WAIT_MS = 3000;

/**
 * agy's slash commands for the menu: the remembered list, or, when none is
 * known yet, the list agy announces for a session opened (and closed) now.
 */
export async function loadAntigravityPickerSlashCommands(
  options: AntigravityTransportOptions = {},
): Promise<AntigravitySlashCommand[]> {
  const known = listAntigravitySlashCommands();
  if (known.length) return known;
  const startClient = options.startClient ?? getOrStartAgyClient;
  const launch = await prepareAgyPickerLaunchOptions();
  const client = await startClient(launch);
  const announced = waitForAntigravityCommands(
    client,
    COMMAND_ANNOUNCEMENT_WAIT_MS,
  );
  await loadAntigravityModelCatalog({
    launch,
    startClient: async () => client,
    force: true,
  });
  return announced;
}
