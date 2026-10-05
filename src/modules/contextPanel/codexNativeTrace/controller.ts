/**
 * The Codex native activity trace controller.
 *
 * A native Codex turn reports its work as items, deltas and MCP requests.
 * This owner turns that stream into the panel's agent-run trace, keeps the
 * assistant message's pending events in step with it, and persists the
 * finished trace. One controller belongs to one assistant message: every
 * map, set and counter below lives in that controller's own closure, so two
 * live turns never share trace state.
 */
import {
  buildAgentStageEvent,
  type AgentStageEvent,
} from "../../../agent/stageEvents";
import { saveAgentRunTraceSnapshot } from "../../../agent/store/traceStore";
import type { TaskPaperLedgerDelta } from "../../../agent/context/taskPaperLedger";
import { paperLedgerUpdateFromMcpActivity } from "../../../agent/context/taskPaperLedgerRecorder";
import { CODEX_PLAN_CHECKLIST_ITEM_ID } from "../taskProgress/codexPlan";
import type {
  AgentConfirmationResolution,
  AgentEvent,
  AgentPendingAction,
  AgentRunEventRecord,
  AgentToolArtifact,
  AgentWorkCategory,
} from "../../../agent/types";
import {
  humanizeCodexNativeItemType,
  isCodexNativeItemType,
  mapCodexNativeItemToEvents,
  mapCodexNativeSkillActivationToEvents,
  normalizeCodexNativeItemTypeKey,
  readCodexNativeRawField,
  resolveCodexNativeStageStatus,
  type CodexNativeActivityItem,
} from "../../../codexAppServer/nativeActivityStages";
import { withConversationWriteLock } from "../../../shared/conversationWriteFence";
import { normalizeGeneratedChatImages } from "../../../shared/generatedImages";
import type { GeneratedChatImage, QuoteCitation } from "../../../shared/types";
import { sanitizeText } from "../../../utils/textSanitization";
import { agentRunTraceCache } from "../agentState";
import {
  TOOL_ACTIVITY_VISIBLE_DEDUPE_WINDOW_MS,
  hasSameToolActivityVisibleIdentity,
  mergeToolActivityPayload,
} from "../agentTrace/toolActivityDedupe";
import {
  createBlockStreamCoalescer,
  type BlockStreamCoalescer,
} from "../blockStreamCoalescer";
import {
  areConversationWritesFrozen,
  isConversationWriteGenerationCurrent,
} from "../state";
import type { Message } from "../types";

/**
 * One item of a native Codex turn, as the app-server client reports it.
 *
 * The shape is the client's; the panel only routes it. The alias keeps the
 * panel's own callbacks readable without restating the protocol here.
 */
type CodexNativeTraceItemEvent = CodexNativeActivityItem;

type CodexNativeTraceDeltaEvent = {
  itemId?: string;
  delta: string;
};

type CodexNativeMcpToolActivityEvent = {
  requestId: string;
  phase: "started" | "completed";
  toolName: string;
  toolLabel?: string;
  serverName?: string;
  arguments?: unknown;
  ok?: boolean;
  error?: string;
  quoteCitations?: QuoteCitation[];
  artifacts?: AgentToolArtifact[];
  actionReceipts?: import("../../../agent/contracts/types").AgentActionReceipt[];
  workCategory?: AgentWorkCategory;
  /**
   * The native item this MCP request belongs to, as the Codex client paired
   * them inside the turn. Two identity spaces describe one call; this is the
   * key that joins them, so the panel merges on a fact instead of a clock.
   */
  correlationId?: string;
  /** What a successful read call read from each paper, for Task progress. */
  paperLedgerDelta?: TaskPaperLedgerDelta;
};

type CodexToolActivityEventPayload = Extract<
  AgentEvent,
  { type: "codex_tool_activity" }
>;

export function isCodexNativeAgentMessageItem(
  event: CodexNativeTraceItemEvent,
): boolean {
  const itemType = (event.type || "").replace(/[-_\s]+/g, "").toLowerCase();
  const role = (event.role || "").replace(/[-_\s]+/g, "").toLowerCase();
  return (
    itemType === "agentmessage" ||
    itemType === "assistantmessage" ||
    (itemType === "message" && (role === "assistant" || role === "agent"))
  );
}

function isCodexNativeToolItem(event: CodexNativeTraceItemEvent): boolean {
  const itemType = (event.type || "").replace(/[-_\s]+/g, "").toLowerCase();
  return (
    itemType.includes("toolcall") ||
    itemType.includes("tooluse") ||
    itemType.includes("mcptool")
  );
}

function readCodexNativeRawName(value: unknown): string {
  if (typeof value === "string") return sanitizeText(value).trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  for (const key of ["name", "toolName", "tool_name", "title", "id"]) {
    const text = sanitizeText(String(record[key] || "")).trim();
    if (text) return text;
  }
  return "";
}

function looksLikeCodexNativeToolName(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_./:-]*$/.test(value.trim());
}

function resolveCodexNativeToolName(
  event: CodexNativeTraceItemEvent,
): string | undefined {
  const candidates = [
    event.toolName,
    readCodexNativeRawName(
      readCodexNativeRawField(event, ["toolName", "tool_name", "tool"]),
    ),
    event.name && looksLikeCodexNativeToolName(event.name) ? event.name : "",
    readCodexNativeRawName(readCodexNativeRawField(event, ["name"])),
  ];
  for (const candidate of candidates) {
    const text = sanitizeText(candidate || "").trim();
    if (text && looksLikeCodexNativeToolName(text)) return text;
  }
  return undefined;
}

function resolveCodexNativeToolLabel(
  event: CodexNativeTraceItemEvent,
): string | undefined {
  const name = sanitizeText(event.name || "").trim();
  const title = sanitizeText(event.title || "").trim();
  const rawTitle = sanitizeText(
    String(readCodexNativeRawField(event, ["title"]) || ""),
  ).trim();
  for (const candidate of [title, rawTitle, name]) {
    if (candidate && !looksLikeCodexNativeToolName(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveCodexNativeToolServerName(
  event: CodexNativeTraceItemEvent,
): string | undefined {
  return (
    sanitizeText(event.serverName || "").trim() ||
    readCodexNativeRawName(
      readCodexNativeRawField(event, [
        "serverName",
        "server_name",
        "mcpServerName",
        "server",
      ]),
    ) ||
    undefined
  );
}

function resolveCodexNativeToolArguments(
  event: CodexNativeTraceItemEvent,
): unknown {
  return (
    event.arguments ??
    readCodexNativeRawField(event, ["arguments", "args", "input"])
  );
}

function compactCodexNativeTraceLine(
  text: string,
  maxLength = Number.MAX_SAFE_INTEGER,
): string {
  const clean = sanitizeText(text).replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function createCodexNativeActivityTraceController(
  assistantMessage: Message,
  queueRefresh: (() => void) & { flush?: () => void },
) {
  const runId =
    assistantMessage.agentRunId?.trim() ||
    `codex-native-${Math.floor(assistantMessage.timestamp || Date.now())}`;
  assistantMessage.agentRunId = runId;
  /**
   * The message this controller writes to, until the turn ends.
   *
   * `dispose` drops it so nothing arriving late -- a coalescer timer, a
   * provider event after the panel moved on -- can rewrite a message the
   * panel has already finalized and persisted.
   */
  let boundMessage: Message | null = assistantMessage;
  const events: AgentRunEventRecord[] = [];
  const progressEventIndexes = new Map<string, number>();
  const toolEventIndexes = new Map<string, number>();
  const stageEventIndexes = new Map<string, number>();
  const mcpRequestToolItemIds = new Map<string, string>();
  /** MCP requests whose paper ledger update this trace already holds. */
  const mcpPaperLedgerRequestIds = new Set<string>();
  const activatedSkillIds = new Set<string>();
  const progressCoalescers = new Map<string, BlockStreamCoalescer>();
  let seq = 0;

  const createEvent = (payload: AgentEvent): AgentRunEventRecord => ({
    runId,
    seq: ++seq,
    eventType: payload.type,
    payload,
    createdAt: Date.now(),
  });

  const snapshotEvents = () =>
    events.map((entry, index) => ({
      ...entry,
      seq: index + 1,
      payload: { ...entry.payload } as AgentEvent,
    }));
  const sync = (flush = false) => {
    if (!boundMessage) return;
    boundMessage.pendingAgentTraceEvents = events.length
      ? snapshotEvents()
      : undefined;
    queueRefresh();
    if (flush) queueRefresh.flush?.();
  };

  const upsertProgressText = (
    itemId: string,
    text: string,
    mode: "replace" | "append",
    status: "running" | "completed",
  ): boolean => {
    const cleanItemId = sanitizeText(itemId).trim();
    const cleanText = sanitizeText(text);
    if (!cleanItemId || !cleanText) return false;
    const existingIndex = progressEventIndexes.get(cleanItemId);
    if (existingIndex !== undefined) {
      const existing = events[existingIndex];
      if (existing?.payload.type !== "codex_progress") return false;
      const nextText =
        mode === "append"
          ? `${existing.payload.text || ""}${cleanText}`
          : cleanText;
      events[existingIndex] = {
        ...existing,
        payload: {
          type: "codex_progress",
          itemId: cleanItemId,
          text: nextText,
          status,
        },
      };
      return true;
    }
    progressEventIndexes.set(cleanItemId, events.length);
    events.push(
      createEvent({
        type: "codex_progress",
        itemId: cleanItemId,
        text: cleanText,
        status,
      }),
    );
    return true;
  };

  const getProgressCoalescer = (itemId: string): BlockStreamCoalescer => {
    let coalescer = progressCoalescers.get(itemId);
    if (coalescer) return coalescer;
    coalescer = createBlockStreamCoalescer({
      onBlock: (block) => {
        const changed = upsertProgressText(itemId, block, "append", "running");
        if (changed) sync();
      },
    });
    progressCoalescers.set(itemId, coalescer);
    return coalescer;
  };

  const flushProgressCoalescer = (
    itemId: string,
    reason: "event" | "final" | "cancel" | "error",
  ): void => {
    progressCoalescers.get(itemId)?.flushNow(reason);
  };

  const flushAllProgressCoalescers = (
    reason: "event" | "final" | "cancel" | "error",
  ): void => {
    for (const coalescer of progressCoalescers.values()) {
      coalescer.flushNow(reason);
    }
  };

  /**
   * Deliver everything the agent-message coalescers still hold.
   *
   * `finish` does this for a turn that completes. A turn that is cancelled or
   * fails never reaches `finish`, and what the coalescers hold is commentary
   * the model already sent -- so those paths call this immediately before they
   * persist the turn, and the rendered trace and the stored trace end up
   * saying the same thing.
   */
  const flushBufferedProgress = (
    reason: "event" | "final" | "cancel" | "error",
  ): void => {
    flushAllProgressCoalescers(reason);
  };

  /**
   * End this controller's life with the turn that created it.
   *
   * Each progress coalescer holds a pending flush timer; cancelling them
   * stops a delivery that would land after the panel finalized and persisted
   * the message. By this point every path that persists has already flushed
   * what it wanted to keep, so this is the safety net rather than the place
   * text is decided. Dropping the message binding then makes every later call
   * a no-op.
   */
  const dispose = (): void => {
    for (const coalescer of progressCoalescers.values()) coalescer.cancel();
    progressCoalescers.clear();
    boundMessage = null;
  };

  const findRecentVisibleDuplicateToolActivity = (
    payload: CodexToolActivityEventPayload,
  ): string | null => {
    const now = Date.now();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const entry = events[index];
      if (now - entry.createdAt > TOOL_ACTIVITY_VISIBLE_DEDUPE_WINDOW_MS) {
        break;
      }
      if (entry?.payload.type !== "codex_tool_activity") continue;
      if (hasSameToolActivityVisibleIdentity(entry.payload, payload)) {
        return entry.payload.itemId;
      }
    }
    return null;
  };

  /** Splice one event in, keeping every remembered position honest. */
  const insertEventAt = (index: number, payload: AgentEvent): void => {
    events.splice(index, 0, createEvent(payload));
    for (const indexes of [
      progressEventIndexes,
      toolEventIndexes,
      stageEventIndexes,
    ]) {
      for (const [key, position] of indexes) {
        if (position >= index) indexes.set(key, position + 1);
      }
    }
  };

  /**
   * Keep one stage event beside the activity row it brackets.
   *
   * A native row is upserted as its phases arrive, so its stage is upserted
   * with it: the trace holds one stage per row, in the status the latest
   * phase reported. A row whose category only arrives with a later report --
   * the app server's item and the Zotero server's own report of one call --
   * gets its stage opened then, still immediately before the row.
   */
  const upsertStageEvent = (
    itemId: string,
    stage: AgentStageEvent | undefined,
  ): void => {
    if (!stage) return;
    const existingIndex = stageEventIndexes.get(itemId);
    if (existingIndex === undefined) {
      const activityIndex = toolEventIndexes.get(itemId);
      if (activityIndex === undefined) return;
      insertEventAt(activityIndex, stage);
      stageEventIndexes.set(itemId, activityIndex);
      return;
    }
    const existing = events[existingIndex];
    if (existing?.payload.type !== "agent_stage") return;
    events[existingIndex] = { ...existing, payload: stage };
  };

  const upsertToolActivity = (
    activity: {
      itemId: string;
      phase: "started" | "completed";
      toolName?: string;
      toolLabel?: string;
      serverName?: string;
      args?: unknown;
      ok?: boolean;
      text?: string;
      codeBlock?: string;
      artifacts?: AgentToolArtifact[];
      actionReceipts?: import("../../../agent/contracts/types").AgentActionReceipt[];
      workCategory?: AgentWorkCategory;
    },
    options: { stage?: AgentStageEvent } = {},
  ): string | null => {
    const cleanItemId = sanitizeText(activity.itemId || "").trim();
    if (!cleanItemId) return null;
    const cleanToolName = sanitizeText(activity.toolName || "").trim();
    const cleanToolLabel = sanitizeText(activity.toolLabel || "").trim();
    const cleanServerName = sanitizeText(activity.serverName || "").trim();
    const buildPayload = (itemId: string): CodexToolActivityEventPayload => ({
      type: "codex_tool_activity",
      itemId,
      phase: activity.phase,
      ...(cleanToolName ? { toolName: cleanToolName } : {}),
      ...(cleanToolLabel ? { toolLabel: cleanToolLabel } : {}),
      ...(cleanServerName ? { serverName: cleanServerName } : {}),
      ...(activity.args !== undefined ? { args: activity.args } : {}),
      ...(typeof activity.ok === "boolean" ? { ok: activity.ok } : {}),
      ...(activity.text ? { text: activity.text } : {}),
      ...(activity.codeBlock ? { codeBlock: activity.codeBlock } : {}),
      ...(activity.artifacts?.length ? { artifacts: activity.artifacts } : {}),
      ...(activity.actionReceipts?.length
        ? { actionReceipts: activity.actionReceipts }
        : {}),
      ...(activity.workCategory ? { workCategory: activity.workCategory } : {}),
    });
    let itemId = cleanItemId;
    let payload = buildPayload(itemId);
    const visibleDuplicate = findRecentVisibleDuplicateToolActivity(payload);
    if (visibleDuplicate) {
      itemId = visibleDuplicate;
      payload = buildPayload(itemId);
    }
    const existingIndex = toolEventIndexes.get(itemId);
    if (existingIndex !== undefined) {
      const existing = events[existingIndex];
      if (existing?.payload.type !== "codex_tool_activity") return null;
      events[existingIndex] = {
        ...existing,
        payload: mergeToolActivityPayload(existing.payload, payload),
        createdAt: Date.now(),
      };
      upsertStageEvent(itemId, options.stage);
      return itemId;
    }
    // The stage opens immediately before the row it brackets, which is the
    // order the runtime emits in and the order the compatibility projection
    // reconstructs; a later phase replaces both in place, so one call stays
    // one pair of events however many phases it reports.
    if (options.stage) {
      stageEventIndexes.set(itemId, events.length);
      events.push(createEvent(options.stage));
    }
    toolEventIndexes.set(itemId, events.length);
    events.push(createEvent(payload));
    return itemId;
  };

  const appendStatus = (text: string): boolean => {
    const clean = compactCodexNativeTraceLine(text);
    if (!clean) return false;
    const previous = events[events.length - 1];
    if (
      previous?.payload.type === "status" &&
      previous.payload.text === clean
    ) {
      return false;
    }
    events.push(createEvent({ type: "status", text: clean }));
    return true;
  };

  const addGeneratedImage = (image: GeneratedChatImage | null): boolean => {
    if (!boundMessage) return false;
    const normalized = normalizeGeneratedChatImages(image ? [image] : []);
    const next = normalized[0];
    if (!next) return false;
    const existing = normalizeGeneratedChatImages(boundMessage.generatedImages);
    const index = existing.findIndex((entry) => entry.id === next.id);
    if (index >= 0) {
      existing[index] = { ...existing[index], ...next };
    } else {
      existing.push(next);
    }
    boundMessage.generatedImages = existing.length ? existing : undefined;
    return true;
  };

  /**
   * Append the bridge's reading of one native item.
   *
   * The Codex client owns what a native item means; this appends the stage
   * and the row it was handed, and takes the generated image the mapping
   * carried because only the panel owns the assistant message.
   */
  const appendStructuredOperationStatus = (
    event: CodexNativeTraceItemEvent,
    phase: "started" | "completed",
  ): boolean => {
    const mapped = mapCodexNativeItemToEvents(
      event,
      phase,
      `codex-${normalizeCodexNativeItemTypeKey(event.type) || "item"}-${phase}-${seq + 1}`,
    );
    if (!mapped?.activity) return false;
    const changedImage = addGeneratedImage(mapped.generatedImage || null);
    const updated = upsertToolActivity(mapped.activity, {
      stage: mapped.stage,
    });
    return Boolean(updated) || changedImage;
  };

  const noteSkillActivated = (
    skillId: string,
    options: { source?: "codex-native-slash" } = {},
  ): void => {
    const cleanSkillId = sanitizeText(skillId || "").trim();
    if (!cleanSkillId || activatedSkillIds.has(cleanSkillId)) return;
    flushAllProgressCoalescers("event");
    activatedSkillIds.add(cleanSkillId);
    // Activating a skill is planning work the connected runtime did, not a
    // call to a registered tool. The bridge says so; this appends it.
    const mapped = mapCodexNativeSkillActivationToEvents(cleanSkillId, options);
    if (!mapped?.activity) return;
    upsertToolActivity(mapped.activity, { stage: mapped.stage });
    sync();
  };

  const appendItemStatus = (
    event: CodexNativeTraceItemEvent,
    phase: "started" | "completed",
  ): void => {
    if (isCodexNativeAgentMessageItem(event)) return;
    // Proposals and user inputs have their own views and must not be repeated
    // as generic tool/status text in the persisted assistant trace.
    if (isCodexNativeItemType(event, ["plan", "usermessage"])) return;
    flushAllProgressCoalescers("event");
    if (appendStructuredOperationStatus(event, phase)) {
      sync();
      return;
    }
    if (isCodexNativeToolItem(event)) {
      // When the bridge paired this item with the MCP request it was made
      // through, both rows carry that key and become one row.
      const itemId =
        sanitizeText(event.correlationId || "").trim() ||
        sanitizeText(event.id || "").trim() ||
        `codex-tool-${phase}-${seq + 1}`;
      const failureText = compactCodexNativeTraceLine(
        event.error || event.summary || event.details || "",
      );
      const failed =
        Boolean(event.error) ||
        /failed|error|cancelled|denied|rejected/i.test(
          sanitizeText(event.summary || event.details || ""),
        );
      const updatedItemId = upsertToolActivity({
        itemId,
        phase,
        toolName: resolveCodexNativeToolName(event),
        toolLabel: resolveCodexNativeToolLabel(event),
        serverName: resolveCodexNativeToolServerName(event),
        args: resolveCodexNativeToolArguments(event),
        ok: phase === "completed" ? !failed : undefined,
        text: phase === "completed" && failed ? failureText : undefined,
        artifacts:
          phase === "completed"
            ? ((event.raw as { artifacts?: AgentToolArtifact[] } | undefined)
                ?.artifacts ?? undefined)
            : undefined,
      });
      if (updatedItemId) sync();
      return;
    }
    const itemType = humanizeCodexNativeItemType(event.type);
    if (!itemType || itemType === "reasoning") return;
    const summary =
      phase === "completed"
        ? compactCodexNativeTraceLine(event.summary || event.details || "")
        : "";
    const text = summary || `Codex ${itemType} ${phase}`;
    if (appendStatus(text)) sync();
  };

  const appendAgentMessageDelta = (
    event: CodexNativeTraceDeltaEvent,
  ): boolean => {
    const itemId = sanitizeText(event.itemId || "").trim();
    if (!itemId) return false;
    getProgressCoalescer(itemId).pushText(event.delta);
    return true;
  };

  const noteMcpToolActivity = (
    event: CodexNativeMcpToolActivityEvent,
  ): void => {
    flushAllProgressCoalescers("event");
    const requestId = sanitizeText(event.requestId || "").trim();
    // The bridge says which native item this request belongs to; the panel
    // merges on that key and never on how recently something that looked
    // similar went past.
    const correlationId = sanitizeText(event.correlationId || "").trim();
    const existingItemId = requestId
      ? mcpRequestToolItemIds.get(requestId)
      : undefined;
    const itemId =
      correlationId ||
      existingItemId ||
      (requestId ? `mcp:${requestId}` : `mcp-tool-${event.phase}-${seq + 1}`);
    const updatedItemId = upsertToolActivity(
      {
        itemId,
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
      },
      {
        stage: event.workCategory
          ? buildAgentStageEvent({
              stage: event.workCategory,
              status: resolveCodexNativeStageStatus(event.phase, event.ok),
              toolName: event.toolName,
              toolLabel: event.toolLabel,
              receiptIds: event.actionReceipts?.length
                ? event.actionReceipts.map((receipt) => receipt.id)
                : undefined,
            })
          : undefined,
      },
    );
    if (requestId && updatedItemId) {
      mcpRequestToolItemIds.set(requestId, updatedItemId);
    }
    // The read's ledger update rides beside its row, once per request, so the
    // live trace and the snapshot the store keeps both carry it.
    const ledgerUpdate = paperLedgerUpdateFromMcpActivity(event);
    const ledgerKey = requestId || itemId;
    if (ledgerUpdate && !mcpPaperLedgerRequestIds.has(ledgerKey)) {
      mcpPaperLedgerRequestIds.add(ledgerKey);
      events.push(createEvent(ledgerUpdate));
      sync();
      return;
    }
    if (updatedItemId) sync();
  };

  const noteMcpConfirmationRequired = (
    requestId: string,
    action: AgentPendingAction,
  ): void => {
    const cleanRequestId = sanitizeText(requestId || "").trim();
    if (!cleanRequestId) return;
    flushAllProgressCoalescers("event");
    events.push(
      createEvent({
        type: "confirmation_required",
        requestId: cleanRequestId,
        action,
      }),
    );
    sync();
  };

  const noteMcpConfirmationResolved = (
    requestId: string,
    resolution: AgentConfirmationResolution,
  ): void => {
    const cleanRequestId = sanitizeText(requestId || "").trim();
    if (!cleanRequestId) return;
    flushAllProgressCoalescers("event");
    events.push(
      createEvent({
        type: "confirmation_resolved",
        requestId: cleanRequestId,
        approved: Boolean(resolution.approved),
        actionId: resolution.actionId,
        data: resolution.data,
      }),
    );
    // A resolved question must disappear even when its origin window is
    // backgrounded and frame callbacks are throttled.
    sync(true);
  };

  const noteAgentMessageCompleted = (
    event: CodexNativeTraceItemEvent,
  ): void => {
    if (!isCodexNativeAgentMessageItem(event)) return;
    const itemId = sanitizeText(event.id || "").trim();
    if (!itemId) return;
    flushProgressCoalescer(itemId, "event");
    const completedText = event.details || event.summary || "";
    if (completedText && !progressEventIndexes.has(itemId)) {
      if (upsertProgressText(itemId, completedText, "replace", "completed")) {
        sync();
      }
    }
  };

  const finish = (finalText: string): void => {
    flushAllProgressCoalescers("final");
    const alreadyFinal = events.some((entry) => entry.payload.type === "final");
    if (!alreadyFinal) {
      // The terminal marker closes the activity lifecycle. Do not prune any
      // preceding agent-message or tool events from the interleaved trace.
      events.push(createEvent({ type: "final", text: finalText }));
      sync();
    }
  };

  /** A host event the turn published: its provider events join the trace. */
  const appendHostEvent = (event: AgentEvent): void => {
    if (event.type !== "provider_event") return;
    events.push(createEvent(event));
    sync();
  };

  return {
    /** The turn's run: the message's, Task progress's, and the stored trace's. */
    runId,
    persist: async (
      conversationKey: number,
      generation: number,
      status?: import("../../../agent/types").AgentRunStatus,
    ) => {
      const message = boundMessage;
      if (!events.length || !message) return;
      await withConversationWriteLock(conversationKey, async () => {
        if (
          areConversationWritesFrozen(conversationKey) ||
          !isConversationWriteGenerationCurrent(conversationKey, generation)
        )
          return;
        const snapshot = snapshotEvents();
        await saveAgentRunTraceSnapshot(
          {
            runId,
            conversationKey,
            mode: "agent",
            model: message.modelName,
            status:
              status ||
              (events.some((entry) => entry.payload.type === "final")
                ? "completed"
                : "failed"),
            createdAt: events[0].createdAt,
            completedAt: Date.now(),
            finalText: message.text,
          },
          snapshot,
        );
        message.agentRunId = runId;
        agentRunTraceCache.set(runId, snapshot);
        // Restore and paint the full Q&A trace after the native host journal
        // temporarily replaces the message's presentation identity.
        sync(true);
      });
    },
    appendAgentMessageDelta,
    appendHostEvent,
    /**
     * Keep Codex's own checklist as the run's one plan event. It is
     * persisted with the run for Task progress (live and reopened) and never
     * renders as a trace row.
     */
    appendNativePlanProgress: (
      steps: Array<{ content: string; status?: string }>,
    ) => {
      if (!boundMessage) return;
      const clean = steps
        .map((step) => ({
          content: sanitizeText(step.content || "").trim(),
          ...(step.status ? { status: sanitizeText(step.status).trim() } : {}),
        }))
        .filter((step) => step.content);
      if (!clean.length) return;
      const payload: AgentEvent = {
        type: "codex_progress",
        itemId: CODEX_PLAN_CHECKLIST_ITEM_ID,
        // The text form older builds read; the steps are what Task progress reads.
        text: clean
          .map(
            (step) =>
              `${step.status === "completed" ? "✓" : "•"} ${step.content}`,
          )
          .join("\n"),
        status: clean.every((step) => step.status === "completed")
          ? "completed"
          : "running",
        steps: clean,
      };
      const index = progressEventIndexes.get(CODEX_PLAN_CHECKLIST_ITEM_ID);
      const existing = index === undefined ? undefined : events[index];
      if (existing) {
        if (JSON.stringify(existing.payload) === JSON.stringify(payload))
          return;
        events[index!] = { ...existing, payload };
      } else {
        progressEventIndexes.set(CODEX_PLAN_CHECKLIST_ITEM_ID, events.length);
        events.push(createEvent(payload));
      }
      sync();
    },
    appendItemStatus,
    finish,
    noteSkillActivated,
    noteMcpConfirmationRequired,
    noteMcpConfirmationResolved,
    noteMcpToolActivity,
    noteAgentMessageCompleted,
    flushBufferedProgress,
    dispose,
  };
}

export type CodexNativeActivityTraceController = ReturnType<
  typeof createCodexNativeActivityTraceController
>;

export const createCodexNativeActivityTraceControllerForTests =
  createCodexNativeActivityTraceController;

export function noteExplicitCodexNativeSkillInvocations(
  trace: CodexNativeActivityTraceController | null,
  skillIds?: string[],
): void {
  if (!trace?.noteSkillActivated || !skillIds?.length) return;
  for (const skillId of skillIds) {
    trace.noteSkillActivated(skillId, { source: "codex-native-slash" });
  }
}
