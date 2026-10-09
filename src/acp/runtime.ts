import type { AgentRuntime } from "../agent/runtime";
import type {
  AgentEvent,
  AgentModelCapabilities,
  AgentRuntimeOutcome,
} from "../agent/types";
import type { RunTurnParams } from "../agent/externalBackendBridge";
import {
  appendAgentRunEvent,
  createAgentRun,
  finishAgentRun,
} from "../agent/store/traceStore";
import { appLogger } from "../core/logging";
import { resolveCodexNativeRuntimeCwd } from "../codexAppServer/runtimeCwd";
import {
  acpUpdateToAgentEvents,
  isAcpStopReasonComplete,
} from "./events";
import {
  ACP_PROTOCOL_VERSION,
  buildInitializeParams,
  buildNewSessionParams,
  buildPromptParams,
  parsePermissionRequest,
  parseSessionUpdate,
  pickDenyOption,
  readInitializeResult,
  readNewSessionResult,
} from "./protocol";
import { getAcpAgentCommand, getAcpWorkingDirectory } from "./prefs";
import { spawnAcpAgent, type AcpAgentProcess } from "./transport";

/**
 * Runs agent turns on any ACP (Agent Client Protocol) agent.
 *
 * This is a *backend*, not a conversation system. ACP-run conversations are
 * still this plugin's own conversations: they keep the upstream storage,
 * history and conversation keys, and only the thing answering the turn
 * changes. That is deliberate — the alternative (a fourth conversation system
 * with its own keys, store, provisioning, deletion and search plumbing)
 * touches ~44 files of this codebase for behaviour a first cut does not need.
 * What it defers, in exchange: ACP conversations cannot be cleared, forked or
 * searched as their own silo, and the panel's runtime toggle keeps switching
 * the conversation system rather than the backend.
 *
 * The turn itself is the real thing: initialize → session/new → session/prompt
 * over stdio, with `session/update` mapped onto the panel's own `AgentEvent`s
 * and the run recorded in the same trace store the other runtimes use.
 */

const ACP_INITIALIZE_TIMEOUT_MS = 60_000;
/** A cold `session/new` builds an agent and discovers its tools; the Hermes
 *  ACP server takes ~17s on the first call. */
const ACP_SESSION_TIMEOUT_MS = 180_000;

export type AcpRuntime = Pick<
  AgentRuntime,
  | "listTools"
  | "getToolDefinition"
  | "registerTool"
  | "unregisterTool"
  | "registerPendingConfirmation"
  | "resolveConfirmation"
  | "prepareExecutionRequest"
> & {
  getCapabilities(): AgentModelCapabilities;
  runTurn(params: RunTurnParams): Promise<AgentRuntimeOutcome>;
};

let agentProcess: AcpAgentProcess | null = null;
let startingAgent: Promise<AcpAgentProcess> | null = null;
/** One ACP session per conversation, so a follow-up keeps its agent context. */
const sessionIdByConversation = new Map<number, string>();

/** Working directory for `session/new`; the protocol requires one. */
export function resolveAcpWorkingDirectory(): string | undefined {
  const configured = getAcpWorkingDirectory();
  if (configured) return configured;
  return resolveCodexNativeRuntimeCwd();
}

export function resetAcpRuntime(): void {
  const process = agentProcess;
  agentProcess = null;
  startingAgent = null;
  sessionIdByConversation.clear();
  process?.destroy();
}

async function ensureAgentProcess(): Promise<AcpAgentProcess> {
  if (agentProcess?.isAlive()) return agentProcess;
  if (startingAgent) return startingAgent;
  const command = getAcpAgentCommand();
  const task = (async (): Promise<AcpAgentProcess> => {
    const agent = await spawnAcpAgent({ command });
    agent.onClose(() => {
      if (agentProcess === agent) agentProcess = null;
      sessionIdByConversation.clear();
    });
    try {
      const result = await agent.protocol.request(
        "initialize",
        buildInitializeParams({
          name: "llm-for-zotero",
          title: "LLM for Zotero",
          version: "1.0",
        }),
        ACP_INITIALIZE_TIMEOUT_MS,
      );
      const info = readInitializeResult(result);
      if (!info) {
        throw new Error("the agent did not answer `initialize`");
      }
      if (info.protocolVersion !== ACP_PROTOCOL_VERSION) {
        appLogger.warn(
          `[llm-for-zotero] acp: agent speaks protocol v${info.protocolVersion}, this build speaks v${ACP_PROTOCOL_VERSION}`,
        );
      }
      agentProcess = agent;
      return agent;
    } catch (error) {
      agent.destroy();
      const tail = agent.diagnostics();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} (command: ${command})${tail ? ` — agent said: ${tail}` : ""}`,
      );
    }
  })();
  startingAgent = task;
  try {
    return await task;
  } finally {
    if (startingAgent === task) startingAgent = null;
  }
}

async function ensureSessionId(
  agent: AcpAgentProcess,
  conversationKey: number,
): Promise<string> {
  const existing = sessionIdByConversation.get(conversationKey);
  if (existing) return existing;
  const cwd = resolveAcpWorkingDirectory();
  if (!cwd) {
    throw new Error(
      "ACP agent working directory is not set, and this plugin has no runtime directory to use instead.",
    );
  }
  // MCP is untouched by this backend: the session is created without servers.
  const result = await agent.protocol.request(
    "session/new",
    buildNewSessionParams({ cwd, mcpServers: [] }),
    ACP_SESSION_TIMEOUT_MS,
  );
  const session = readNewSessionResult(result);
  if (!session) {
    throw new Error("the agent did not return a session id for `session/new`");
  }
  sessionIdByConversation.set(conversationKey, session.sessionId);
  return session.sessionId;
}

export function getAcpRuntime(coreRuntime: AgentRuntime): AcpRuntime {
  const runtime: AcpRuntime = {
    listTools: () => coreRuntime.listTools(),
    getToolDefinition: (name: string) => coreRuntime.getToolDefinition(name),
    registerTool: (tool) => coreRuntime.registerTool(tool),
    unregisterTool: (name: string) => coreRuntime.unregisterTool(name),
    registerPendingConfirmation: (requestId, resolve) =>
      coreRuntime.registerPendingConfirmation(requestId, resolve),
    resolveConfirmation: (requestId, approved, data) =>
      coreRuntime.resolveConfirmation(requestId, approved, data),
    prepareExecutionRequest: (request, options) =>
      coreRuntime.prepareExecutionRequest(request, options),
    /**
     * Nothing to advertise: this build gives the ACP agent no plugin tools and
     * no Zotero context, so claiming PDF or image input would be a lie the
     * composer acts on.
     */
    getCapabilities: () => ({
      streaming: true,
      toolCalls: true,
      multimodal: false,
      fileInputs: false,
      reasoning: true,
      contentInputs: {
        images: false,
        pdfDocuments: false,
        nativeFiles: false,
      },
    }),

    runTurn: async (params: RunTurnParams): Promise<AgentRuntimeOutcome> => {
      const request = params.request;
      const conversationKey = Number(request.conversationKey) || 0;
      const userText =
        typeof request.userText === "string" ? request.userText.trim() : "";
      const runId = `acp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      let seq = 0;
      let runPersisted = false;
      let text = "";
      // One serial chain: the panel's own event order is the order it renders.
      let chain: Promise<void> = Promise.resolve();

      const doEmit = async (event: AgentEvent): Promise<void> => {
        if (event.type === "message_delta") text += event.text;
        try {
          if (!runPersisted) {
            await createAgentRun({
              runId,
              conversationKey,
              mode: "agent",
              model: request.model,
              status: "running",
              createdAt: Date.now(),
            });
            runPersisted = true;
          }
          seq += 1;
          await appendAgentRunEvent(runId, seq, event);
        } catch (error) {
          appLogger.debug(
            `[llm-for-zotero] acp: could not record the run event: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        await params.onEvent?.(event);
      };
      const emit = (event: AgentEvent): Promise<void> => {
        chain = chain.then(() => doEmit(event)).catch(() => undefined);
        return chain;
      };
      const finish = async (
        status: "completed" | "failed" | "cancelled",
        finalText: string,
      ): Promise<void> => {
        if (!runPersisted) return;
        try {
          await finishAgentRun(runId, status, finalText);
        } catch {
          /* the trace is a record, not the turn's result */
        }
      };

      await params.onStart?.(runId);
      let unsubscribeUpdate = () => {};
      let unsubscribePermission = () => {};
      try {
        if (!userText) throw new Error("Nothing to send to the ACP agent.");
        const agent = await ensureAgentProcess();
        const sessionId = await ensureSessionId(agent, conversationKey);

        unsubscribeUpdate = agent.protocol.onNotification(
          "session/update",
          (raw) => {
            const payload = parseSessionUpdate(raw);
            if (!payload || payload.sessionId !== sessionId) return;
            for (const event of acpUpdateToAgentEvents(payload.update)) {
              void emit(event);
            }
          },
        );
        unsubscribePermission = agent.protocol.onRequest(
          "session/request_permission",
          async (raw) => {
            const permission = parsePermissionRequest(raw);
            await emit({
              type: "status",
              text: `The ACP agent asked for permission to run ${
                permission.title ? `“${permission.title}”` : "a tool"
              }; this build refuses ACP permission requests.`,
            });
            const deny = pickDenyOption(permission.options);
            return deny
              ? { outcome: { outcome: "selected", optionId: deny.optionId } }
              : { outcome: { outcome: "cancelled" } };
          },
        );

        const prompt = agent.protocol.request(
          "session/prompt",
          buildPromptParams({ sessionId, text: userText }),
          // A turn has no protocol deadline of its own; Stop cancels it.
          0,
        );
        const abort = new Promise<never>((_, reject) => {
          if (params.signal?.aborted) {
            reject(new Error("Aborted"));
            return;
          }
          params.signal?.addEventListener(
            "abort",
            () => {
              agent.protocol.notify("session/cancel", { sessionId });
              reject(new Error("Aborted"));
            },
            { once: true },
          );
        });

        const result = (await Promise.race([prompt, abort])) as
          | { stopReason?: unknown }
          | null
          | undefined;
        const stopReason =
          typeof result?.stopReason === "string" ? result.stopReason : undefined;
        await chain;
        if (!isAcpStopReasonComplete(stopReason)) {
          await emit({
            type: "status",
            text: `The ACP agent ended the turn: ${stopReason}`,
          });
        }
        await finish("completed", text);
        return { kind: "completed", runId, text, usedFallback: false };
      } catch (error) {
        const aborted =
          params.signal?.aborted === true ||
          (error instanceof Error && error.message === "Aborted");
        await chain;
        if (aborted) {
          await emit({ type: "status", text: "Stopped." });
          await finish("cancelled", text);
          return { kind: "cancelled", runId, text };
        }
        const message = error instanceof Error ? error.message : String(error);
        await emit({ type: "status", text: message });
        await finish("failed", message);
        return {
          kind: "failed",
          runId,
          message,
          // Not resumable on "continue": nothing streamed is re-attachable.
          interrupted: false,
        };
      } finally {
        unsubscribeUpdate();
        unsubscribePermission();
      }
    },
  };
  return runtime;
}
