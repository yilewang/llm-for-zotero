/**
 * The turn host for external agent runtimes (Claude Code through its bridge,
 * Antigravity through ACP): everything a turn needs from the plugin that
 * does not depend on how the runtime is reached.
 *
 * For one turn it:
 * - prepares the request under the external runtime's permission owner;
 * - holds the local-document path lease for the turn;
 * - guards every delivery and write on the conversation's write generation,
 *   so a Clear mid-turn stops the turn from touching the conversation;
 * - records the run and its events (events before the run id is known wait,
 *   then land in order), redacting local paths;
 * - opens the per-turn Zotero MCP scope: review cards for the tools that ask
 *   the user, tool activity rows, read evidence, paper-ledger updates, and
 *   the scope's closing when the turn ends;
 * - settles the answer against the run's finalized document;
 * - reports a failure as a status and a fallback, and a stop as cancelled.
 *
 * The runtime supplies an `ExternalRuntimeTransport`: how to check and build
 * its request, the Zotero MCP server config it hands its agent, and the call
 * that runs the turn.
 */

import { appLogger } from "../core/logging";
import { resolveAgentRuntimeRequest } from "./context/resolvedAgentRequest";
import { validateLocalPdfDocumentBatch } from "./context/localDocumentBatch";
import { loadLatestDocumentForRun } from "./documents/store";
import { rememberOutsidePapers } from "./context/outsidePaperRecords";
import { paperLedgerUpdateFromMcpActivity } from "./context/taskPaperLedgerRecorder";
import {
  listTurnPapersWithRoles,
  type TurnPaperRole,
} from "./context/turnPaperScope";
import { settleExternalTurn } from "./execution/externalTurnSettlement";
import {
  addZoteroMcpToolActivityObserver,
  registerScopedZoteroMcpScope,
  updateScopedZoteroMcpScope,
  type ZoteroMcpActiveScope,
} from "./mcp/server";
import type { ZoteroMcpToolActivityEvent } from "./mcp/activityTypes";
import {
  AgentEventLocalDocumentStreamRedactor,
  acquireLocalDocumentPathLease,
  LocalDocumentPathStreamRedactor,
} from "./privacy/localDocumentPathRedaction";
import {
  appendAgentRunEvent,
  createAgentRun,
  finishAgentRun,
} from "./store/traceStore";
import type { AgentRuntime } from "./runtime";
import type {
  AgentConfirmationResolution,
  AgentEvent,
  AgentRuntimeOutcome,
  AgentRuntimeRequest,
  AgentRuntimeRequestInput,
} from "./types";
import type { LocalDocumentResource, PaperContextRef } from "../shared/types";
import type { AgentActionReceipt } from "./contracts/types";
import {
  areConversationWritesFrozen,
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../shared/conversationWriteFence";
import { isNativeZoteroMcpToolsEnabled } from "../codexAppServer/prefs";
import {
  assertRequiredCodexZoteroMcpToolsReady,
  preflightCodexZoteroMcpServer,
} from "../codexAppServer/mcpSetup";

export type ExternalRunTurnParams = {
  request: AgentRuntimeRequestInput;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  onStart?: (runId: string) => void | Promise<void>;
  /** As for the in-plugin runtime; an external turn never waits, so never called. */
  onWaiting?: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
};

export type ResolvedExternalRunTurnParams = Omit<
  ExternalRunTurnParams,
  "request"
> & { request: AgentRuntimeRequest };

/** How an external runtime answers: Claude answered or fell back. */
export type ExternalTurnOutcome = Extract<
  AgentRuntimeOutcome,
  { kind: "completed" | "fallback" }
>;

export function makeProfilingEvent(
  stage: string,
  payload?: Record<string, unknown>,
): AgentEvent {
  return {
    type: "provider_event",
    providerType: "profiling",
    ts: Date.now(),
    payload: {
      stage,
      ...(payload || {}),
    },
  };
}

export function requestPaperRefs(
  request: AgentRuntimeRequest,
  roles: readonly TurnPaperRole[],
): PaperContextRef[] {
  return [...listTurnPapersWithRoles(request.turnPaperScope, roles)];
}

export function requestLocalDocuments(
  request: AgentRuntimeRequest,
): readonly LocalDocumentResource[] {
  return (request.localDocuments || []).map((entry) => entry.resource);
}

/**
 * Copies what a successful Zotero MCP call an external runtime made attested
 * back into the run's request: its read observations and the outside papers
 * it returned.
 */
export function copyMcpCallEvidenceToRequest(
  request: AgentRuntimeRequest,
  event: ZoteroMcpToolActivityEvent,
): void {
  if (event.phase !== "completed" || !event.ok) return;
  if (event.readObservations?.length) {
    const merged = new Map(
      (request.documentReadObservations || []).map((entry) => [
        entry.observationId,
        entry,
      ]),
    );
    for (const observation of event.readObservations) {
      merged.set(observation.observationId, observation);
    }
    request.documentReadObservations = [...merged.values()];
  }
  rememberOutsidePapers(request, event.outsidePapers || []);
}

/**
 * The trace row for a Zotero MCP call an external runtime made.
 *
 * The receipts travel with the row: they are what the verification chip reads,
 * so a write the connected client ran over MCP would otherwise reach the trace
 * with no verdict at all — indistinguishable from one nobody verified.
 *
 * A completed call's passage citations travel with it too, so the panel adds
 * them to the answer's citations as the Codex panel does, whatever text the
 * client relays as the tool's result.
 */
export function buildMcpToolActivityEvent(
  event: ZoteroMcpToolActivityEvent,
): AgentEvent {
  const quoteCitations =
    event.phase === "completed" && event.ok && event.quoteCitations?.length
      ? event.quoteCitations
      : undefined;
  return {
    type: "codex_tool_activity",
    itemId: `mcp:${event.requestId || `${event.toolName}:${event.timestamp}`}`,
    phase: event.phase,
    toolName: event.toolName,
    toolLabel: event.toolLabel,
    serverName: event.serverName,
    args: event.arguments,
    ok: event.ok,
    text: event.error,
    artifacts: event.artifacts,
    actionReceipts: event.actionReceipts,
    workCategory: event.workCategory,
    mutability: event.mutability,
    ...(quoteCitations ? { quoteCitations } : {}),
  };
}

/** What the host hands a transport while it prepares the turn. */
export type ExternalTurnPrepareContext = {
  request: AgentRuntimeRequest;
  /** Records and delivers a profiling stage before the run exists. */
  recordProfiling(stage: string): Promise<void>;
  writeAllowed(): boolean;
};

/** The Zotero MCP server config a runtime hands its agent for one turn. */
export type ExternalTurnZoteroMcp<TServers> = {
  profileSignature(): string;
  buildScope(
    request: AgentRuntimeRequest,
    profileSignature: string,
  ): ZoteroMcpActiveScope;
  /** A conversation-stable token, so a hot runtime keeps its MCP config. */
  scopeToken(request: AgentRuntimeRequest, profileSignature: string): string;
  buildServerConfig(params: {
    profileSignature: string;
    scopeToken: string;
    rawPdfMode: boolean;
  }): { serverName: string; servers: TServers; allowedTools?: string[] };
  requiredToolNames(rawPdfMode: boolean): readonly string[];
};

/** What the host hands a transport to run the turn. */
export type ExternalTurnRunContext<TPrepared, TServers> = {
  params: ResolvedExternalRunTurnParams;
  request: AgentRuntimeRequest;
  prepared: TPrepared;
  /** The turn's Zotero MCP servers, when the native tools are on. */
  zoteroMcp?: { servers: TServers; allowedTools?: string[] };
  /** Records the run and tells the panel the turn started. */
  onStart(runId: string): Promise<void>;
  /** Delivers and records one event (staged and redacted). */
  emit(event: AgentEvent): Promise<void>;
  registerPendingConfirmation(
    requestId: string,
    resolve: (resolution: AgentConfirmationResolution) => void,
  ): void;
  writeAllowed(): boolean;
};

export type ExternalRuntimeTransport<TPrepared, TServers> = {
  /** Names the runtime in logs. */
  logLabel: string;
  /** The run id a failure is recorded under when no run started. */
  failureRunIdPrefix: string;
  /** Adjusts the prepared request before anything else runs. */
  adjustRequest?(request: AgentRuntimeRequest): Promise<AgentRuntimeRequest>;
  /**
   * Checks the runtime is reachable and builds what its turn needs. A throw
   * here fails `runTurn` itself, before any run is recorded.
   */
  prepare(ctx: ExternalTurnPrepareContext): Promise<TPrepared>;
  /** Brackets tool calls with trace stages; one event in, events out. */
  createStageTracker?(): (event: AgentEvent) => AgentEvent[];
  zoteroMcp?: ExternalTurnZoteroMcp<TServers>;
  run(
    ctx: ExternalTurnRunContext<TPrepared, TServers>,
  ): Promise<ExternalTurnOutcome>;
  /** The user-facing message for a failed turn. */
  describeFailure(error: unknown, prepared: TPrepared | undefined): string;
};

export async function runExternalRuntimeTurn<TPrepared, TServers>(
  rawParams: ExternalRunTurnParams,
  options: {
    coreRuntime: AgentRuntime;
    transport: ExternalRuntimeTransport<TPrepared, TServers>;
  },
): Promise<AgentRuntimeOutcome> {
  const { coreRuntime, transport } = options;
  const params: ResolvedExternalRunTurnParams = {
    ...rawParams,
    request:
      "turnPaperScope" in rawParams.request
        ? (rawParams.request as AgentRuntimeRequest)
        : resolveAgentRuntimeRequest(rawParams.request),
  };
  params.request.conversationGeneration ??= getConversationWriteGeneration(
    params.request.conversationKey,
  );
  params.request = await coreRuntime.prepareExecutionRequest(params.request, {
    signal: params.signal,
    permissionOwner: "external_runtime",
  });
  if (transport.adjustRequest) {
    params.request = await transport.adjustRequest(params.request);
  }
  validateLocalPdfDocumentBatch({
    pdfPaperContexts: requestPaperRefs(params.request, ["raw_pdf"]),
    localDocuments: requestLocalDocuments(params.request),
  });
  const pathLease = acquireLocalDocumentPathLease(
    params.request.conversationKey,
    requestLocalDocuments(params.request),
  );
  try {
    const writeAllowed = () =>
      !areConversationWritesFrozen(params.request.conversationKey) &&
      (params.request.conversationGeneration === undefined ||
        isConversationWriteGenerationCurrent(
          params.request.conversationKey,
          params.request.conversationGeneration,
        ));
    const persistIfLive = async <T>(task: () => Promise<T>) => {
      if (!writeAllowed()) return undefined;
      return withConversationWriteLock(
        params.request.conversationKey,
        async () => {
          if (!writeAllowed()) return undefined;
          return task();
        },
      );
    };
    const notifyIfLive = async (event: AgentEvent): Promise<void> => {
      if (writeAllowed()) await params.onEvent?.(event);
    };
    let persistedRunId = "";
    let persistedRunCreated = false;
    let persistedSeq = 0;
    const pendingEventsBeforeRunId: AgentEvent[] = [];
    const eventStreamRedactor = new AgentEventLocalDocumentStreamRedactor(
      params.request.conversationKey,
    );
    const turnPathRedactor = new LocalDocumentPathStreamRedactor(
      params.request.conversationKey,
    );
    const ensurePersistedRun = async (runId: string): Promise<void> => {
      const normalized = (runId || "").trim();
      if (!normalized) return;
      if (!writeAllowed()) return;
      if (!persistedRunCreated || persistedRunId !== normalized) {
        persistedRunId = normalized;
        persistedSeq = 0;
        await persistIfLive(() =>
          createAgentRun({
            runId: persistedRunId,
            conversationKey: params.request.conversationKey,
            mode: "agent",
            model: params.request.model,
            status: "running",
            createdAt: Date.now(),
          }),
        );
        persistedRunCreated = writeAllowed();
        if (!persistedRunCreated) return;
        if (pendingEventsBeforeRunId.length) {
          for (const event of pendingEventsBeforeRunId.splice(0)) {
            persistedSeq += 1;
            await persistIfLive(() =>
              appendAgentRunEvent(persistedRunId, persistedSeq, event),
            );
          }
        }
      }
    };
    const appendPersistedEvent = async (event: AgentEvent): Promise<void> => {
      const redactedEvent = turnPathRedactor.redactTerminalValue(event);
      if (!persistedRunCreated || !persistedRunId) {
        pendingEventsBeforeRunId.push(redactedEvent);
        return;
      }
      persistedSeq += 1;
      await persistIfLive(() =>
        appendAgentRunEvent(persistedRunId, persistedSeq, redactedEvent),
      );
    };
    const recordProfiling = async (stage: string): Promise<void> => {
      const event = makeProfilingEvent(stage);
      await appendPersistedEvent(event);
      await notifyIfLive(makeProfilingEvent(stage));
    };
    await recordProfiling("frontend.run_turn.enter");
    const prepared = await transport.prepare({
      request: params.request,
      recordProfiling,
      writeAllowed,
    });
    const stageTurnEvent =
      transport.createStageTracker?.() ?? ((event: AgentEvent) => [event]);
    const emitTurnEvent = async (event: AgentEvent): Promise<void> => {
      for (const staged of stageTurnEvent(event)) {
        for (const redactedEvent of eventStreamRedactor.process(staged)) {
          await appendPersistedEvent(redactedEvent);
          await notifyIfLive(redactedEvent);
        }
      }
    };
    const pendingMcpActivity: Promise<void>[] = [];
    let zoteroMcp: ExternalTurnRunContext<TPrepared, TServers>["zoteroMcp"];
    let clearScopedMcpScope: () => void = () => undefined;
    let unregisterMcpToolActivity: () => void = () => undefined;
    let scopedMcpToken = "";
    const hostReceipts: AgentActionReceipt[] = [];
    try {
      if (transport.zoteroMcp && isNativeZoteroMcpToolsEnabled()) {
        const mcp = transport.zoteroMcp;
        const rawPdfMode = requestLocalDocuments(params.request).length > 0;
        const profileSignature = mcp.profileSignature();
        const mcpScope = mcp.buildScope(params.request, profileSignature);
        mcpScope.publishHostEvent = emitTurnEvent;
        mcpScope.requestInteraction = async (action) => {
          if (!writeAllowed() || params.signal?.aborted)
            return { approved: false };
          const requestId = `host-review-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const pending = new Promise<AgentConfirmationResolution>((resolve) =>
            coreRuntime.registerPendingConfirmation(requestId, resolve),
          );
          const abort = () => coreRuntime.resolveConfirmation(requestId, false);
          params.signal?.addEventListener("abort", abort, { once: true });
          try {
            const event: AgentEvent = {
              type: "confirmation_required",
              requestId,
              action,
            };
            await appendPersistedEvent(event);
            await notifyIfLive(event);
            const resolution = await pending;
            const settled: AgentEvent = {
              type: "confirmation_resolved",
              requestId,
              ...resolution,
            };
            await appendPersistedEvent(settled);
            await notifyIfLive(settled);
            return writeAllowed() ? resolution : { approved: false };
          } finally {
            params.signal?.removeEventListener("abort", abort);
            coreRuntime.resolveConfirmation(requestId, false);
          }
        };
        const scopedMcp = registerScopedZoteroMcpScope(mcpScope, {
          token: mcp.scopeToken(params.request, profileSignature),
        });
        scopedMcpToken = scopedMcp.token;
        clearScopedMcpScope = scopedMcp.clear;
        unregisterMcpToolActivity = addZoteroMcpToolActivityObserver(
          (event) => {
            if (
              event.conversationKey !== params.request.conversationKey ||
              event.profileSignature !== profileSignature ||
              event.runId !== persistedRunId ||
              event.conversationGeneration !==
                params.request.conversationGeneration
            )
              return;
            if (event.phase === "completed")
              hostReceipts.push(...(event.actionReceipts || []));
            copyMcpCallEvidenceToRequest(params.request, event);
            const pending = (async () => {
              await emitTurnEvent(buildMcpToolActivityEvent(event));
              // What the read read from each paper, persisted right after
              // its row like the in-plugin runtime's tool_result.
              const ledgerUpdate = paperLedgerUpdateFromMcpActivity(event);
              if (ledgerUpdate) await emitTurnEvent(ledgerUpdate);
            })();
            pendingMcpActivity.push(pending);
            // Observe rejection immediately, but retain the original promise until
            // the turn drains all evidence before reporting completion.
            void pending.catch(() => undefined);
          },
        );
        const mcpConfig = mcp.buildServerConfig({
          profileSignature,
          scopeToken: scopedMcp.token,
          rawPdfMode,
        });
        const mcpStatus = await preflightCodexZoteroMcpServer({
          serverName: mcpConfig.serverName,
          scopeToken: scopedMcp.token,
          required: true,
          rawPdfMode,
        });
        assertRequiredCodexZoteroMcpToolsReady(
          mcpStatus,
          mcp.requiredToolNames(rawPdfMode),
        );
        zoteroMcp = {
          servers: mcpConfig.servers,
          allowedTools: mcpConfig.allowedTools,
        };
        await emitTurnEvent(
          makeProfilingEvent("frontend.zotero_mcp.ready", {
            serverName: mcpConfig.serverName,
            toolNames: mcpStatus.toolNames,
          }),
        );
      }

      let outcome: ExternalTurnOutcome = await transport.run({
        params,
        request: params.request,
        prepared,
        zoteroMcp,
        onStart: async (runId) => {
          if (scopedMcpToken) {
            updateScopedZoteroMcpScope(scopedMcpToken, { runId });
          }
          await ensurePersistedRun(runId);
          if (writeAllowed()) await params.onStart?.(runId);
        },
        emit: emitTurnEvent,
        registerPendingConfirmation: (requestId, resolve) =>
          coreRuntime.registerPendingConfirmation(requestId, resolve),
        writeAllowed,
      });
      await Promise.all(pendingMcpActivity);
      // Only an answered turn has a finalized document, and it is keyed by
      // the persisted run.
      const finalizedDocument =
        outcome.kind === "completed"
          ? await loadLatestDocumentForRun(persistedRunId)
          : null;
      const settlement = settleExternalTurn({
        answerText:
          outcome.kind === "completed" ? outcome.text : outcome.reason,
        answered: outcome.kind === "completed",
        document: finalizedDocument,
        hostReceipts,
      });
      const terminalRunStatus = settlement.status;
      if (settlement.unverified !== undefined) {
        await emitTurnEvent({
          type: "provider_event",
          providerType: "agent_completion_unverified",
          payload: { reason: settlement.unverified },
        });
        // The report replaces the outcome, a fallback included.
        outcome = {
          kind: "completed",
          runId: outcome.runId,
          text: settlement.text,
          documentId: settlement.documentId,
          usedFallback: false,
          ...(terminalRunStatus === "failed"
            ? { runStatus: "failed" as const }
            : {}),
        };
      } else if (outcome.kind === "completed" && finalizedDocument) {
        outcome = {
          ...outcome,
          text: settlement.text,
          documentId: settlement.documentId,
        };
      }

      for (const redactedEvent of eventStreamRedactor.flush()) {
        await appendPersistedEvent(redactedEvent);
        await notifyIfLive(redactedEvent);
      }
      const safeOutcome: ExternalTurnOutcome =
        outcome.kind === "completed"
          ? {
              ...outcome,
              text: turnPathRedactor.redactTerminalText(outcome.text),
            }
          : {
              ...outcome,
              reason: turnPathRedactor.redactTerminalText(outcome.reason),
            };
      const finalRunId = persistedRunId || safeOutcome.runId;
      if (finalRunId) {
        await ensurePersistedRun(finalRunId);
        await persistIfLive(() =>
          finishAgentRun(
            finalRunId,
            terminalRunStatus,
            safeOutcome.kind === "completed"
              ? safeOutcome.text
              : safeOutcome.reason,
          ),
        );
      }
      return safeOutcome;
    } catch (error) {
      const failedRunStatus = params.signal?.aborted ? "cancelled" : "failed";
      if (persistedRunId) {
        await persistIfLive(() =>
          finishAgentRun(
            persistedRunId,
            failedRunStatus,
            turnPathRedactor.redactTerminalText(
              error instanceof Error ? error.message : String(error),
            ),
          ),
        );
      }
      const rawErrorMessage =
        error instanceof Error ? error.message : String(error);
      const safeErrorMessage =
        turnPathRedactor.redactTerminalText(rawErrorMessage);
      const safeError =
        error instanceof Error ? new Error(safeErrorMessage) : safeErrorMessage;
      const message = turnPathRedactor.redactTerminalText(
        transport.describeFailure(safeError, prepared),
      );
      const fallbackRunId =
        persistedRunId || `${transport.failureRunIdPrefix}-${Date.now()}`;
      if (!persistedRunCreated) {
        await ensurePersistedRun(fallbackRunId);
        if (writeAllowed()) await params.onStart?.(fallbackRunId);
      }
      const statusEvent: AgentEvent = {
        type: "status",
        text: message,
      };
      await appendPersistedEvent(statusEvent);
      await notifyIfLive(statusEvent);
      const fallbackEvent: AgentEvent = {
        type: "fallback",
        reason: message,
      };
      await appendPersistedEvent(fallbackEvent);
      await notifyIfLive(fallbackEvent);
      await persistIfLive(() =>
        finishAgentRun(fallbackRunId, failedRunStatus, message),
      );
      appLogger.warn(`LLM Agent: ${transport.logLabel} unavailable`, message);
      // The throwing public runTurn rethrows the report as it always has.
      const cause = new Error(message);
      return failedRunStatus === "cancelled"
        ? { kind: "cancelled", runId: fallbackRunId, cause }
        : {
            kind: "failed",
            runId: fallbackRunId,
            message,
            interrupted: false,
            cause,
          };
    } finally {
      unregisterMcpToolActivity();
      clearScopedMcpScope();
    }
  } finally {
    pathLease.release();
  }
}
