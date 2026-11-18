/**
 * The Antigravity agent runtime: the shared external-runtime turn host
 * driving `agy acp` through the ACP client.
 *
 * A turn:
 * 1. starts (or reuses) the pooled agy process for the working folder and
 *    permission level;
 * 2. reuses the conversation's agy session when this process already has
 *    it, resumes the stored one otherwise, or starts a new one; the Zotero
 *    MCP server goes in with the session, under a conversation-stable scope
 *    token, so later turns keep the same server;
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
  type AcpMcpServer,
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
import { ZOTERO_MCP_SAFE_READ_TOOL_NAMES } from "../agent/mcp/server";
import { getZoteroAgentRuntimeRootDir } from "../agent/skills/nativeSkillPaths";
import {
  buildAcpZoteroMcpServerConfig,
  REQUIRED_CLAUDE_RAW_PDF_MCP_TOOL_NAMES,
  REQUIRED_CLAUDE_ZOTERO_MCP_TOOL_NAMES,
} from "../codexAppServer/mcpSetup";
import { withConversationWriteLock } from "../shared/conversationWriteFence";
import { JsonRpcResponseError } from "../utils/stdioJsonRpcConnection";
import { ensureDir } from "../utils/geckoFs";
import { joinLocalPath } from "../utils/localPath";
import { AcpClient } from "./acpClient";
import { getOrStartAgyClient, type AgyLaunchOptions } from "./agyProcess";
import { getAntigravityProfileSignature } from "./conversationKeys";
import {
  getAntigravityPermissionModePref,
  isAntigravityModeEnabled,
  type AntigravityPermissionMode,
} from "./prefs";
import { antigravityConversationStore } from "./store";

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
  cwd = getAntigravityRuntimeCwd(),
): AgyLaunchOptions {
  return { cwd, skipPermissions: mode === "full-access" };
}

/** The Zotero tool a tool call names, when it is one of this turn's. */
export function zoteroToolNameOf(
  call: Pick<AcpToolCall, "name">,
  serverName: string,
): string | null {
  const prefix = `mcp_${serverName}_`;
  return call.name && call.name.startsWith(prefix)
    ? call.name.slice(prefix.length)
    : null;
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

function toolArguments(call: AcpToolCall): unknown {
  return call.args ?? call.rawInput ?? {};
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
        if (isZoteroCall(update) || callNames.has(update.toolCallId)) return;
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
  /** The MCP servers the session was opened with, as JSON. */
  mcpSignature: string;
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
  launch: AgyLaunchOptions;
  sessionMode: string;
  rawPdfMode: boolean;
};

type AntigravityServers = {
  serverName: string;
  servers: AcpMcpServer[];
};

/** Opens the conversation's session on this client: reuse, resume, or new. */
async function openSession(params: {
  client: AcpClient;
  request: AgentRuntimeRequest;
  cwd: string;
  mcpServers: AcpMcpServer[];
}): Promise<{ sessionId: string; isNew: boolean; state: ClientSessionState }> {
  const { client, request, cwd, mcpServers } = params;
  const sessions = openSessions(client);
  const mcpSignature = JSON.stringify(mcpServers);
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
    if (open && open.mcpSignature === mcpSignature) {
      return { sessionId: stored, isNew: false, state: open };
    }
    try {
      const resumed: AcpSessionState = await client.resumeSession({
        sessionId: stored,
        cwd,
        mcpServers,
      });
      const state: ClientSessionState = {
        modeId: resumed?.modes?.currentModeId,
        mcpSignature,
      };
      sessions.set(stored, state);
      return { sessionId: stored, isNew: false, state };
    } catch (error) {
      if (!isSessionMissing(error)) throw error;
    }
  }
  const created = await client.newSession({ cwd, mcpServers });
  const state: ClientSessionState = {
    modeId: created.modes?.currentModeId,
    mcpSignature,
  };
  sessions.set(created.sessionId, state);
  return { sessionId: created.sessionId, isNew: true, state };
}

async function buildPromptBlocks(params: {
  request: AgentRuntimeRequest;
  isNewSession: boolean;
  rawPdfMode: boolean;
}): Promise<AcpContentBlock[]> {
  const { request } = params;
  const parts: string[] = [];
  if (params.isNewSession) {
    parts.push(buildAntigravityInstructions(params.rawPdfMode));
  }
  const context = renderTurnContextEnvelopeForModel(
    buildTurnContextEnvelope(request),
  );
  if (context) parts.push(context);
  parts.push(await buildExternalRuntimeUserText(request));
  return [{ type: "text", text: parts.filter(Boolean).join("\n\n") }];
}

function createAbortError(): Error {
  const error = new Error("Antigravity turn cancelled");
  error.name = "AbortError";
  return error;
}

/** Answers one agy permission request for the turn. */
function createPermissionHandler(
  ctx: ExternalTurnRunContext<AntigravityPrepared, AntigravityServers>,
  zoteroServerName: string | undefined,
  onDenied: () => void,
) {
  return async (
    params: AcpRequestPermissionParams,
    signal: AbortSignal,
  ): Promise<AcpRequestPermissionResult> => {
    const zoteroTool = zoteroServerName
      ? zoteroToolNameOf(params.toolCall, zoteroServerName)
      : null;
    // The Zotero MCP server reviews every write it runs; its reads are safe.
    if (
      zoteroTool &&
      (ZOTERO_MCP_SAFE_READ_TOOL_NAMES as readonly string[]).includes(
        zoteroTool,
      )
    ) {
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
  return {
    logLabel: "Antigravity",
    failureRunIdPrefix: "antigravity-error",
    prepare: async ({ request }) => {
      const mode = getAntigravityPermissionModePref();
      const launch = buildAgyLaunchOptions(mode);
      await ensureDir(launch.cwd);
      return {
        launch,
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
        const config = buildAcpZoteroMcpServerConfig({
          profileSignature,
          scopeToken,
          required: true,
          rawPdfMode,
        });
        return {
          serverName: config.serverName,
          servers: {
            serverName: config.serverName,
            servers: config.mcpServers,
          },
        };
      },
      requiredToolNames: (rawPdfMode) =>
        rawPdfMode
          ? REQUIRED_CLAUDE_RAW_PDF_MCP_TOOL_NAMES
          : REQUIRED_CLAUDE_ZOTERO_MCP_TOOL_NAMES,
    },
    run: async (ctx): Promise<ExternalTurnOutcome> => {
      const { request, prepared } = ctx;
      const signal = ctx.params.signal;
      if (signal?.aborted) throw createAbortError();
      const client = await startClient(prepared.launch);
      const zoteroServerName = ctx.zoteroMcp?.servers.serverName;
      const session = await openSession({
        client,
        request,
        cwd: prepared.launch.cwd,
        mcpServers: ctx.zoteroMcp?.servers.servers ?? [],
      });
      await rememberAntigravitySession(
        request,
        session.sessionId,
        prepared.launch.cwd,
        ctx.writeAllowed,
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
        emit: ctx.emit,
      });
      let mapping = Promise.resolve();
      const stopUpdates = client.onSessionUpdate(
        session.sessionId,
        (notification) => {
          if (notification.update.sessionUpdate === "current_mode_update") {
            session.state.modeId = notification.update.currentModeId;
          }
          // Keep updates in order; one slow emit must not reorder them.
          mapping = mapping.then(() => mapper.handle(notification));
        },
      );
      const stopPermissions = client.setPermissionHandler(
        session.sessionId,
        createPermissionHandler(ctx, zoteroServerName, () => {
          denied = true;
        }),
      );
      try {
        const blocks = await buildPromptBlocks({
          request,
          isNewSession: session.isNew,
          rawPdfMode: prepared.rawPdfMode,
        });
        const result = await client.prompt(session.sessionId, blocks, {
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
        fileInputs: false,
        reasoning: true,
      });
    },
    runTurn: (params: RunTurnParams): Promise<AgentRuntimeOutcome> =>
      runExternalRuntimeTurn(params, { coreRuntime, transport }),
    listExternalActionsSync: () => [],
    refreshExternalActions: async () => undefined,
    listSlashCommandsSync: () => [],
    refreshSlashCommands: async () => undefined,
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
