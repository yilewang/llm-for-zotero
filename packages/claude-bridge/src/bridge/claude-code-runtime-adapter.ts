import type {
  ClaudeCodeRuntimeClient,
  RuntimeAccountQuota,
  RuntimeAccountQuotaOptions,
  RuntimeModelInfo,
  RuntimePermissionModeCatalog,
} from "../runtime.js";
import type { SessionMapper } from "../session-link/session-mapper.js";
import type { TraceStore } from "../trace-store/trace-store.js";
import type {
  AgentEvent,
  RunTurnHooks,
  RunTurnOutcome,
  RunTurnRequest,
} from "../types.js";
import { mapProviderEvent } from "../event-mapper/map-provider-event.js";
import {
  collectLocalPdfs,
  LocalPdfOutputStreamSanitizer,
  sanitizeLocalPdfOutput,
} from "../local-pdf.js";

export interface ClaudeCodeRuntimeAdapterOptions {
  runtimeClient: ClaudeCodeRuntimeClient;
  sessionMapper: SessionMapper;
  traceStore?: TraceStore;
}

type ResumeSource =
  | "map"
  | "legacy_provider_map"
  | "request_hint"
  | "none"
  | "force_fresh"
  | "history_gap"
  | "local_pdf";

export class ClaudeCodeRuntimeAdapter {
  get supportsStructuredCompletion(): boolean {
    return typeof this.runtimeClient.completeStructured === "function";
  }

  async completeStructured(
    request: import("../runtime.js").StructuredCompletionRequest,
  ): Promise<import("../runtime.js").StructuredCompletionResult> {
    if (!this.runtimeClient.completeStructured)
      throw new Error("structured_completion_v1 is unavailable");
    return this.runtimeClient.completeStructured(request);
  }

  private readonly runtimeClient: ClaudeCodeRuntimeClient;
  private readonly sessionMapper: SessionMapper;
  private readonly traceStore?: TraceStore;
  /**
   * Local lifecycle fence for provider work.  The host can invalidate a
   * conversation while a provider request is still awaiting its first
   * response; a late response must not repopulate the session mapper, hot
   * runtime, or trace file that Clear/delete just removed.
   */
  private readonly lifecycleEpochByConversation = new Map<string, number>();
  private readonly lifecycleLocks = new Map<string, Promise<void>>();

  constructor(options: ClaudeCodeRuntimeAdapterOptions) {
    this.runtimeClient = options.runtimeClient;
    this.sessionMapper = options.sessionMapper;
    this.traceStore = options.traceStore;
  }

  private isStreamingDebugEnabled(): boolean {
    return process.env.LLM4ZOTERO_BRIDGE_DEBUG_STREAMING === "1";
  }

  private logStreamingTiming(
    stage: string,
    details: {
      conversationKey: string;
      runId: string;
      textLength?: number;
      eventTs?: number;
    },
  ): void {
    if (!this.isStreamingDebugEnabled()) return;
    const now = Date.now();
    console.log(
      "[STREAMING]",
      JSON.stringify({
        stage,
        conversationKey: details.conversationKey,
        runId: details.runId,
        textLength: details.textLength,
        eventTs: details.eventTs,
        localTs: now,
        lagMs:
          typeof details.eventTs === "number"
            ? Math.max(0, now - details.eventTs)
            : undefined,
      }),
    );
  }

  async getRuntimeAccountQuota(
    options: RuntimeAccountQuotaOptions,
  ): Promise<RuntimeAccountQuota | null> {
    try {
      return (await this.runtimeClient.getAccountQuota?.(options)) ?? null;
    } catch {
      return null;
    }
  }

  async listRuntimeModels(options?: {
    settingSources?: Array<"user" | "project" | "local">;
    runtimeCwdRelative?: string;
    forceRefresh?: boolean;
  }): Promise<RuntimeModelInfo[]> {
    if (typeof this.runtimeClient.listModels !== "function") {
      throw new Error("Claude Code runtime model catalog is unavailable");
    }
    const entries = await this.runtimeClient.listModels(options);
    const modelInfos: RuntimeModelInfo[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const value =
        typeof entry === "string" ? entry.trim() : entry.value.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      modelInfos.push(
        typeof entry === "string" ? { value } : { ...entry, value },
      );
    }
    return modelInfos;
  }

  async listRuntimeCommands(options?: {
    settingSources?: Array<"user" | "project" | "local">;
  }): Promise<
    Array<{ name: string; description: string; argumentHint: string }>
  > {
    if (typeof this.runtimeClient.listCommands !== "function") {
      return [];
    }
    try {
      return await this.runtimeClient.listCommands(options);
    } catch {
      return [];
    }
  }

  async listRuntimeEfforts(options?: {
    model?: string;
    settingSources?: Array<"user" | "project" | "local">;
    runtimeCwdRelative?: string;
  }): Promise<string[]> {
    if (typeof this.runtimeClient.listEfforts !== "function") {
      return ["default", "low", "medium", "high"];
    }
    try {
      return await this.runtimeClient.listEfforts(options);
    } catch {
      return ["default", "low", "medium", "high"];
    }
  }

  async listRuntimePermissionModes(options?: {
    settingSources?: Array<"user" | "project" | "local">;
    runtimeCwdRelative?: string;
  }): Promise<RuntimePermissionModeCatalog> {
    if (typeof this.runtimeClient.listPermissionModes !== "function") {
      throw new Error(
        "Claude Code runtime permission mode catalog is unavailable",
      );
    }
    return this.runtimeClient.listPermissionModes(options);
  }

  async listRuntimeMcpServers(options?: {
    settingSources?: Array<"user" | "project" | "local">;
  }) {
    if (typeof this.runtimeClient.listMcpServers !== "function") {
      return [];
    }
    try {
      return await this.runtimeClient.listMcpServers(options);
    } catch {
      return [];
    }
  }

  private buildSessionMapKey(
    requestOrConversationKey: RunTurnRequest | string,
  ): string {
    if (typeof requestOrConversationKey === "string") {
      return requestOrConversationKey;
    }
    return requestOrConversationKey.conversationKey;
  }

  private buildLocalPdfHistoryGapKey(conversationKey: string): string {
    return `${conversationKey}::local-pdf-history-gap`;
  }

  private buildLegacyProviderSessionMapKey(
    requestOrConversationKey:
      | RunTurnRequest
      | {
          conversationKey: string;
          metadata?: Record<string, unknown>;
        },
  ): string | undefined {
    const metadata =
      requestOrConversationKey.metadata &&
      typeof requestOrConversationKey.metadata === "object"
        ? (requestOrConversationKey.metadata as Record<string, unknown>)
        : {};
    const providerIdentity =
      typeof metadata.providerIdentity === "string" &&
      metadata.providerIdentity.trim()
        ? metadata.providerIdentity.trim()
        : "";
    return providerIdentity
      ? `${requestOrConversationKey.conversationKey}::provider:${providerIdentity}`
      : undefined;
  }

  private normalizeProviderSessionId(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private lifecycleEpoch(conversationKey: string): number {
    return this.lifecycleEpochByConversation.get(conversationKey) || 0;
  }

  private bumpLifecycleEpoch(conversationKey: string): number {
    const next = this.lifecycleEpoch(conversationKey) + 1;
    this.lifecycleEpochByConversation.set(conversationKey, next);
    return next;
  }

  private async withLifecycleLock<T>(
    conversationKey: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.lifecycleLocks.get(conversationKey) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.lifecycleLocks.set(conversationKey, current);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.lifecycleLocks.get(conversationKey) === current) {
        this.lifecycleLocks.delete(conversationKey);
      }
    }
  }

  private async setSessionMappingIfCurrent(
    conversationKey: string,
    sessionMapKey: string,
    providerSessionId: string,
    expectedEpoch: number,
  ): Promise<boolean> {
    return this.withLifecycleLock(conversationKey, async () => {
      if (this.lifecycleEpoch(conversationKey) !== expectedEpoch) return false;
      await this.sessionMapper.set(sessionMapKey, providerSessionId);
      if (this.lifecycleEpoch(conversationKey) === expectedEpoch) return true;
      // Unreachable while the only bump site (invalidateConversationSession)
      // also holds this lock, so the epoch cannot move under us. Kept as a
      // backstop for a future bump site outside the lock: remove only the
      // value we just wrote, so a newer turn's mapping is never clobbered.
      if ((await this.sessionMapper.get(sessionMapKey)) === providerSessionId) {
        await this.sessionMapper.delete(sessionMapKey);
      }
      return false;
    });
  }

  private async resolveProviderSessionId(
    requestOrConversationKey: RunTurnRequest | string,
  ): Promise<{ providerSessionId?: string; source: ResumeSource }> {
    // The conversation key and the canonical session-map key are the same
    // value; keeping two names for it invited reading them as distinct.
    const sessionMapKey = this.buildSessionMapKey(requestOrConversationKey);
    const conversationKey = sessionMapKey;
    const expectedEpoch = this.lifecycleEpoch(conversationKey);
    const mapped = await this.sessionMapper.get(sessionMapKey);
    if (mapped) {
      return { providerSessionId: mapped, source: "map" };
    }

    if (typeof requestOrConversationKey !== "string") {
      const legacyMapKey = this.buildLegacyProviderSessionMapKey(
        requestOrConversationKey,
      );
      if (legacyMapKey) {
        const legacyMapped = await this.sessionMapper.get(legacyMapKey);
        if (legacyMapped) {
          if (
            !(await this.setSessionMappingIfCurrent(
              conversationKey,
              sessionMapKey,
              legacyMapped,
              expectedEpoch,
            ))
          ) {
            return { source: "none" };
          }
          return {
            providerSessionId: legacyMapped,
            source: "legacy_provider_map",
          };
        }
      }
    }

    const legacyByPrefix = await this.sessionMapper.getByPrefix(
      `${sessionMapKey}::provider:`,
    );
    if (legacyByPrefix) {
      if (
        !(await this.setSessionMappingIfCurrent(
          conversationKey,
          sessionMapKey,
          legacyByPrefix,
          expectedEpoch,
        ))
      ) {
        return { source: "none" };
      }
      return {
        providerSessionId: legacyByPrefix,
        source: "legacy_provider_map",
      };
    }

    if (typeof requestOrConversationKey !== "string") {
      const hinted = this.normalizeProviderSessionId(
        requestOrConversationKey.providerSessionId,
      );
      if (hinted) {
        if (
          !(await this.setSessionMappingIfCurrent(
            conversationKey,
            sessionMapKey,
            hinted,
            expectedEpoch,
          ))
        ) {
          return { source: "none" };
        }
        return { providerSessionId: hinted, source: "request_hint" };
      }
    }

    return { source: "none" };
  }

  async getMappedProviderSessionId(
    conversationKey: string,
  ): Promise<string | undefined> {
    const { providerSessionId } =
      await this.resolveProviderSessionId(conversationKey);
    return providerSessionId;
  }

  async invalidateConversationSession(
    requestOrConversationKey:
      | RunTurnRequest
      | {
          conversationKey: string;
          metadata?: Record<string, unknown>;
        }
      | string,
  ): Promise<void> {
    const baseConversationKey =
      typeof requestOrConversationKey === "string"
        ? requestOrConversationKey
        : requestOrConversationKey.conversationKey;
    const metadata =
      typeof requestOrConversationKey === "string"
        ? undefined
        : requestOrConversationKey.metadata;
    const expectedProviderSessionId =
      metadata && typeof metadata.providerSessionId === "string"
        ? metadata.providerSessionId.trim()
        : "";
    await this.withLifecycleLock(baseConversationKey, async () => {
      if (expectedProviderSessionId) {
        const currentProviderSessionId =
          (await this.sessionMapper.get(baseConversationKey)) ||
          (await this.sessionMapper.getByPrefix(
            `${baseConversationKey}::provider:`,
          ));
        // A recycled conversation key may already belong to a new provider
        // session. An old cleanup job must never remove that newer mapping.
        if (
          currentProviderSessionId &&
          currentProviderSessionId !== expectedProviderSessionId
        ) {
          return;
        }
      }
      this.bumpLifecycleEpoch(baseConversationKey);
      await this.sessionMapper.delete(baseConversationKey);
      await this.sessionMapper.deleteByPrefix(
        `${baseConversationKey}::provider:`,
      );
      await this.sessionMapper.delete(
        this.buildLocalPdfHistoryGapKey(baseConversationKey),
      );
      await this.runtimeClient.invalidateHotRuntime?.(baseConversationKey);
      await this.traceStore?.clear(baseConversationKey);
    });
  }

  async retainHotRuntime(
    request: RunTurnRequest,
    mountId: string,
  ): Promise<{
    conversationKey: string;
    mountId: string;
    retained: boolean;
    probeId?: string;
  } | void> {
    await this.runtimeClient.retainHotRuntime?.(request, mountId);
    const metadata =
      request.metadata && typeof request.metadata === "object"
        ? (request.metadata as Record<string, unknown>)
        : {};
    if (collectLocalPdfs(request.runtimeRequest).length === 0) {
      const { providerSessionId } =
        await this.resolveProviderSessionId(request);
      await this.runtimeClient.warmHotRuntime?.({
        conversationKey: request.conversationKey,
        userMessage: "",
        providerSessionId,
        allowedTools: request.allowedTools,
        runtimeRequest: request.runtimeRequest,
        mcpServers: request.mcpServers,
        metadata: request.metadata,
      });
    }
    return {
      conversationKey: request.conversationKey,
      mountId,
      retained: true,
      probeId:
        typeof metadata.retentionProbeId === "string"
          ? metadata.retentionProbeId
          : undefined,
    };
  }

  async releaseHotRuntime(
    conversationKey: string,
    mountId: string,
  ): Promise<void> {
    await this.runtimeClient.releaseHotRuntime?.(conversationKey, mountId);
  }

  async invalidateAllHotRuntimes(): Promise<void> {
    await this.runtimeClient.invalidateAllHotRuntimes?.();
  }

  async runTurn(
    request: RunTurnRequest,
    hooks: RunTurnHooks = {},
  ): Promise<RunTurnOutcome> {
    const signal = hooks.signal ?? request.signal;
    const localPdfs = collectLocalPdfs(request.runtimeRequest);
    const isLocalPdfTurn = localPdfs.length > 0;
    if (hooks.onEvent) {
      await hooks.onEvent({
        type: "provider_event",
        ts: Date.now(),
        payload: {
          providerType: "profiling",
          stage: "adapter.run_turn.enter",
        },
      });
    }
    const forceFreshSession = Boolean(
      request.metadata &&
      typeof request.metadata === "object" &&
      (request.metadata as Record<string, unknown>).forceFreshSession === true,
    );
    const sessionMapKey = this.buildSessionMapKey(request);
    const historyGapKey = this.buildLocalPdfHistoryGapKey(
      request.conversationKey,
    );
    let lifecycleEpoch = this.lifecycleEpoch(request.conversationKey);
    if (forceFreshSession) {
      await this.invalidateConversationSession(request);
      lifecycleEpoch = this.lifecycleEpoch(request.conversationKey);
    }
    const hasHistoryGap =
      !forceFreshSession &&
      !isLocalPdfTurn &&
      Boolean(await this.sessionMapper.get(historyGapKey));
    const resolvedResume = forceFreshSession
      ? { providerSessionId: undefined, source: "force_fresh" as ResumeSource }
      : isLocalPdfTurn
        ? { providerSessionId: undefined, source: "local_pdf" as ResumeSource }
        : hasHistoryGap
          ? {
              providerSessionId: undefined,
              source: "history_gap" as ResumeSource,
            }
          : await this.resolveProviderSessionId(request);
    const initialSessionId = resolvedResume.providerSessionId;
    if (hooks.onEvent) {
      await hooks.onEvent({
        type: "provider_event",
        ts: Date.now(),
        payload: {
          providerType: "profiling",
          stage: "adapter.session_lookup.ready",
          forceFreshSession,
          hasInitialSessionId: Boolean(initialSessionId),
          resumeSource: resolvedResume.source,
        },
      });
    }
    const providerSessionId = initialSessionId;
    if (this.lifecycleEpoch(request.conversationKey) !== lifecycleEpoch) {
      throw new Error("Conversation lifecycle changed before provider start");
    }
    const effectiveRequest =
      isLocalPdfTurn || hasHistoryGap
        ? this.withResumeFallbackHistory(request)
        : request;

    let firstOutcome: RunTurnOutcome;
    try {
      firstOutcome = await this.runTurnOnce(
        effectiveRequest,
        hooks,
        signal,
        providerSessionId,
        lifecycleEpoch,
      );
    } catch (error) {
      const originalMessage =
        error instanceof Error ? error.message : String(error);
      const err = new Error(sanitizeLocalPdfOutput(originalMessage, localPdfs));
      if (
        providerSessionId &&
        this.isInvalidThinkingSignatureError(err.message)
      ) {
        if (this.lifecycleEpoch(request.conversationKey) !== lifecycleEpoch) {
          throw new Error(
            "Conversation lifecycle changed during provider retry",
          );
        }
        await this.withLifecycleLock(request.conversationKey, () =>
          this.sessionMapper.delete(sessionMapKey),
        );
        hooks.onEvent?.({
          type: "status",
          ts: Date.now(),
          payload: {
            text: "Claude session resume failed. Retrying with a fresh Claude session and local Zotero history.",
          },
        });
        return this.runTurnOnce(
          this.withResumeFallbackHistory(request),
          hooks,
          signal,
          undefined,
          lifecycleEpoch,
        );
      }
      throw err;
    }
    if (this.lifecycleEpoch(request.conversationKey) !== lifecycleEpoch) {
      return { ...firstOutcome, providerSessionId: undefined };
    }
    if (this.shouldRetryForThinkingSignature(providerSessionId, firstOutcome)) {
      if (this.lifecycleEpoch(request.conversationKey) !== lifecycleEpoch) {
        return { ...firstOutcome, providerSessionId: undefined };
      }
      await this.withLifecycleLock(request.conversationKey, () =>
        this.sessionMapper.delete(sessionMapKey),
      );
      hooks.onEvent?.({
        type: "status",
        ts: Date.now(),
        payload: {
          text: "Claude session resume failed. Retrying with a fresh Claude session and local Zotero history.",
        },
      });
      firstOutcome = await this.runTurnOnce(
        this.withResumeFallbackHistory(request),
        hooks,
        signal,
        undefined,
        lifecycleEpoch,
      );
    }
    if (isLocalPdfTurn && firstOutcome.status === "completed") {
      if (this.lifecycleEpoch(request.conversationKey) !== lifecycleEpoch) {
        return { ...firstOutcome, providerSessionId: undefined };
      }
      await this.withLifecycleLock(request.conversationKey, async () => {
        if (this.lifecycleEpoch(request.conversationKey) !== lifecycleEpoch) {
          return;
        }
        await this.sessionMapper.delete(sessionMapKey);
        await this.sessionMapper.deleteByPrefix(`${sessionMapKey}::provider:`);
        await this.sessionMapper.set(historyGapKey, "1");
      });
      return { ...firstOutcome, providerSessionId: undefined };
    }
    if (
      hasHistoryGap &&
      firstOutcome.status === "completed" &&
      firstOutcome.providerSessionId
    ) {
      if (this.lifecycleEpoch(request.conversationKey) !== lifecycleEpoch) {
        return { ...firstOutcome, providerSessionId: undefined };
      }
      await this.withLifecycleLock(request.conversationKey, async () => {
        if (this.lifecycleEpoch(request.conversationKey) === lifecycleEpoch) {
          await this.sessionMapper.delete(historyGapKey);
        }
      });
    }
    return firstOutcome;
  }

  private withResumeFallbackHistory(request: RunTurnRequest): RunTurnRequest {
    return {
      ...request,
      providerSessionId: undefined,
      metadata: {
        ...(request.metadata || {}),
        claudeResumeFallbackHistory: true,
      },
    };
  }

  private async runTurnOnce(
    request: RunTurnRequest,
    hooks: RunTurnHooks,
    signal: AbortSignal | undefined,
    providerSessionId: string | undefined,
    lifecycleEpoch: number,
  ): Promise<RunTurnOutcome> {
    const sessionMapKey = this.buildSessionMapKey(request);
    const localPdfs = collectLocalPdfs(request.runtimeRequest);
    const persistProviderSession = localPdfs.length === 0;
    const outputStreamSanitizer = new LocalPdfOutputStreamSanitizer(localPdfs);
    const stream = await this.runtimeClient.startTurn({
      conversationKey: request.conversationKey,
      userMessage: request.userMessage,
      providerSessionId,
      allowedTools: request.allowedTools,
      runtimeRequest: request.runtimeRequest,
      mcpServers: request.mcpServers,
      metadata: request.metadata,
      signal,
    });

    let resolvedSessionId = providerSessionId;
    if (persistProviderSession && stream.providerSessionId) {
      resolvedSessionId = stream.providerSessionId;
      const mappingWritten = await this.setSessionMappingIfCurrent(
        request.conversationKey,
        sessionMapKey,
        stream.providerSessionId,
        lifecycleEpoch,
      );
      if (!mappingWritten) resolvedSessionId = undefined;
    }

    // The provider response may arrive after Clear/delete invalidated this
    // lifecycle epoch.  Session writes above are fenced, but the host's
    // onStart callback also mutates run/UI state and must not repopulate the
    // cleared generation.
    if (this.lifecycleEpoch(request.conversationKey) === lifecycleEpoch) {
      hooks.onStart?.({
        runId: stream.runId,
        conversationKey: request.conversationKey,
        providerSessionId: persistProviderSession
          ? (stream.providerSessionId ?? providerSessionId)
          : undefined,
      });
    }

    let finalText = "";
    let pendingTextDelta = "";
    let lastTextDeltaTs: number | undefined;
    let lastReasoningRound = 1;
    let lastReasoningTs: number | undefined;

    const sanitizeReasoningEvent = (event: AgentEvent): AgentEvent => {
      const sanitized = sanitizeLocalPdfOutput(event, localPdfs);
      if (event.type !== "reasoning") return sanitized;
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : {};
      const sanitizedPayload =
        sanitized.payload && typeof sanitized.payload === "object"
          ? (sanitized.payload as Record<string, unknown>)
          : {};
      if (typeof payload.details !== "string") return sanitized;
      if (typeof payload.round === "number" && Number.isFinite(payload.round)) {
        lastReasoningRound = payload.round;
      }
      lastReasoningTs = event.ts;
      return {
        ...sanitized,
        payload: {
          ...sanitizedPayload,
          details: outputStreamSanitizer.pushText("reasoning", payload.details),
        },
      };
    };

    const emitTextDelta = async (
      redactedDelta: string,
      eventTs: number | undefined,
    ): Promise<void> => {
      if (!redactedDelta) return;
      const mergedEvent: AgentEvent = {
        type: "message_delta",
        ts: Date.now(),
        payload: {
          delta: redactedDelta,
        },
      };
      this.logStreamingTiming("emit_merged_message_delta", {
        conversationKey: request.conversationKey,
        runId: stream.runId,
        textLength: redactedDelta.length,
        eventTs,
      });
      await this.emitEvent(
        stream.runId,
        request.conversationKey,
        mergedEvent,
        hooks,
        lifecycleEpoch,
      );
    };

    const flushPendingTextDelta = async (): Promise<void> => {
      if (!pendingTextDelta) return;
      const redactedDelta = outputStreamSanitizer.pushText(
        "message_delta",
        pendingTextDelta,
      );
      const eventTs = lastTextDeltaTs;
      pendingTextDelta = "";
      lastTextDeltaTs = undefined;
      await emitTextDelta(redactedDelta, eventTs);
    };

    const flushHeldTextDelta = async (): Promise<void> => {
      await emitTextDelta(
        outputStreamSanitizer.flushText("message_delta"),
        lastTextDeltaTs,
      );
    };

    const flushHeldReasoning = async (): Promise<void> => {
      const details = outputStreamSanitizer.flushText("reasoning");
      if (!details) return;
      await this.emitEvent(
        stream.runId,
        request.conversationKey,
        {
          type: "reasoning",
          ts: lastReasoningTs ?? Date.now(),
          payload: {
            round: lastReasoningRound,
            details,
          },
        },
        hooks,
        lifecycleEpoch,
      );
    };

    try {
      for await (const providerEvent of stream.events) {
        const mappedEvent = mapProviderEvent(providerEvent);
        const mappedProviderType =
          mappedEvent.type === "provider_event" &&
          mappedEvent.payload &&
          typeof mappedEvent.payload === "object"
            ? (mappedEvent.payload as Record<string, unknown>).providerType
            : undefined;
        const event =
          mappedEvent.type === "message_delta"
            ? mappedEvent
            : mappedEvent.type === "reasoning"
              ? sanitizeReasoningEvent(mappedEvent)
              : mappedProviderType === "stream_event"
                ? outputStreamSanitizer.sanitizeChunk(
                    "provider_event:stream_event",
                    mappedEvent,
                  )
                : sanitizeLocalPdfOutput(mappedEvent, localPdfs);
        const eventSessionId = this.extractSessionId(event.payload);
        const providerType =
          event.type === "provider_event" &&
          event.payload &&
          typeof event.payload === "object"
            ? (event.payload as Record<string, unknown>).providerType
            : undefined;
        const canAdoptSessionId =
          providerType === "assistant" ||
          providerType === "user" ||
          providerType === "result" ||
          event.type === "tool_call" ||
          event.type === "tool_result" ||
          event.type === "message_delta" ||
          event.type === "final";
        if (
          persistProviderSession &&
          canAdoptSessionId &&
          eventSessionId &&
          eventSessionId !== resolvedSessionId
        ) {
          resolvedSessionId = eventSessionId;
          const mappingWritten = await this.setSessionMappingIfCurrent(
            request.conversationKey,
            sessionMapKey,
            eventSessionId,
            lifecycleEpoch,
          );
          if (!mappingWritten) resolvedSessionId = undefined;
        }
        if (event.type === "message_delta") {
          const delta = event.payload.delta;
          if (typeof delta === "string") {
            pendingTextDelta += delta;
            finalText += delta;
            lastTextDeltaTs = event.ts;
            continue;
          }
        }

        await flushPendingTextDelta();
        if (event.type === "final") {
          await flushHeldTextDelta();
          await flushHeldReasoning();
        }
        if (event.type === "final") {
          const output = event.payload.output;
          this.logStreamingTiming("emit_final", {
            conversationKey: request.conversationKey,
            runId: stream.runId,
            textLength:
              typeof output === "string" ? output.length : finalText.length,
            eventTs: event.ts,
          });
        }
        await this.emitEvent(
          stream.runId,
          request.conversationKey,
          event,
          hooks,
          lifecycleEpoch,
        );

        if (event.type === "final") {
          const output = event.payload.output;
          if (typeof output === "string" && output.length > 0) {
            finalText = output;
          }
        }
      }

      await flushPendingTextDelta();
      await flushHeldTextDelta();
      await flushHeldReasoning();
      outputStreamSanitizer.discardAll();
      this.logStreamingTiming("return_outcome", {
        conversationKey: request.conversationKey,
        runId: stream.runId,
        textLength: finalText.length,
      });

      return {
        runId: stream.runId,
        conversationKey: request.conversationKey,
        providerSessionId: persistProviderSession
          ? resolvedSessionId
          : undefined,
        status: signal?.aborted ? "cancelled" : "completed",
        finalText: sanitizeLocalPdfOutput(finalText, localPdfs),
      };
    } catch (error) {
      outputStreamSanitizer.discardAll();
      const originalMessage =
        error instanceof Error ? error.message : String(error);
      const err = new Error(sanitizeLocalPdfOutput(originalMessage, localPdfs));
      const fallbackEvent: AgentEvent = {
        type: "fallback",
        ts: Date.now(),
        payload: {
          reason: "runtime_error",
          message: err.message,
        },
      };
      await this.emitEvent(
        stream.runId,
        request.conversationKey,
        fallbackEvent,
        hooks,
        lifecycleEpoch,
      );

      return {
        runId: stream.runId,
        conversationKey: request.conversationKey,
        providerSessionId: persistProviderSession
          ? resolvedSessionId
          : undefined,
        status: signal?.aborted ? "cancelled" : "failed",
        finalText: sanitizeLocalPdfOutput(finalText, localPdfs),
        error: err.message,
      };
    }
  }

  private async emitEvent(
    runId: string,
    conversationKey: string,
    event: AgentEvent,
    hooks: RunTurnHooks,
    lifecycleEpoch: number,
  ): Promise<void> {
    if (this.lifecycleEpoch(conversationKey) !== lifecycleEpoch) return;
    hooks.onEvent?.(event);
    if (this.traceStore) {
      await this.traceStore.append({ runId, conversationKey, event });
    }
  }

  private extractSessionId(payload: unknown): string | undefined {
    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      if (typeof record.sessionId === "string") {
        return record.sessionId;
      }
      if (typeof record.session_id === "string") {
        return record.session_id;
      }
    }
    return undefined;
  }

  private isInvalidThinkingSignatureError(
    message: string | undefined,
  ): boolean {
    if (!message) return false;
    const normalized = message.toLowerCase();
    return (
      normalized.includes("invalid signature in thinking block") ||
      (normalized.includes("thinking block") &&
        normalized.includes("invalid signature"))
    );
  }

  private shouldRetryForThinkingSignature(
    initialSessionId: string | undefined,
    outcome: RunTurnOutcome,
  ): boolean {
    if (!initialSessionId) return false;
    if (
      outcome.status === "failed" &&
      this.isInvalidThinkingSignatureError(outcome.error)
    ) {
      return true;
    }
    if (
      outcome.status === "completed" &&
      this.isInvalidThinkingSignatureError(outcome.finalText)
    ) {
      return true;
    }
    return false;
  }
}
