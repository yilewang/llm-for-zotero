import type {
  AgentPendingAction,
  AgentRunEventRecord,
} from "../../../agent/types";
import { sanitizeText } from "../../../utils/textSanitization";
import {
  readStoredPlanEvent,
  type StoredPlanArtifact,
  type StoredPlanExecution,
} from "./storedPlanEvents";
import { isRecord } from "../../../core/values";

/**
 * Everything the trace reads from a run by looking across all of its events,
 * folded one event at a time.
 *
 * Each field is the answer the matching whole-list scan gives, so a live run
 * can keep one of these up to date with only the events that arrived since
 * the last refresh, and a finished run gets the same answers from one pass.
 */
export type AgentTraceEventScan = {
  /** What the last plan or plan-status event said the run was doing. */
  planPhase: "planning" | "executing" | null;
  /** Confirmations still waiting, in the order they were first requested. */
  pending: Map<string, AgentPendingAction>;
  /** Whether the run recorded a final answer. */
  hasFinal: boolean;
  /** The last final answer's text, sanitized and trimmed. */
  finalText: string;
  /** The last paper display labels the run resolved, if it resolved any. */
  labels: Map<string, string> | undefined;
  /** Whether the run reports its own stages. */
  hasAgentStage: boolean;
  /**
   * Whether the run holds an event a stage could be reconstructed from. A
   * run with neither stages nor such an event projects to itself.
   */
  hasStageSource: boolean;
  /** An old plan run's last artifact and ledger. */
  planArtifact?: StoredPlanArtifact;
  planLedger?: StoredPlanExecution;
  /** The document the run last finalized. */
  planDocumentId: string | null;
  /** Whether the run ever asked for a discovery review. */
  hasDiscovery: boolean;
  /** The earliest positive event timestamp, or 0 when none has one. */
  minCreatedAt: number;
  /** The latest positive event timestamp, or 0 when none has one. */
  maxCreatedAt: number;
};

/**
 * Events `projectStageEvents` reconstructs a stage from. A new trigger added
 * to that projection needs a matching entry here, or a live run holding only
 * that event would skip the reconstruction its replay performs.
 */
const STAGE_SOURCE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "plan_updated",
  "plan_ready",
  "tool_call",
  "tool_result",
  "tool_error",
  "codex_tool_activity",
  "material_finalized",
  "batch_item_outcome",
]);

/** The plan phase one event announces, or null when it announces none. */
export function readTracePlanPhase(
  payload: AgentRunEventRecord["payload"] | undefined,
): "planning" | "executing" | null {
  const planEvent = readStoredPlanEvent(payload);
  if (planEvent?.type === "plan_execution_updated") return "executing";
  if (planEvent?.type === "plan_ready" || planEvent?.type === "plan_updated")
    return "planning";
  if (payload?.type === "status") {
    const text = payload.text.trim().toLowerCase();
    if (text.startsWith("executing the approved plan")) return "executing";
    if (text.startsWith("planning the request")) return "planning";
  }
  return null;
}

/**
 * The paper display labels one event reports, or undefined.
 *
 * A result that resolved paper identities to reader-facing labels reports
 * them under `displayLabels`; which tool produced it is not read.
 */
export function readTraceDisplayLabels(
  payload: AgentRunEventRecord["payload"],
): Map<string, string> | undefined {
  const values =
    payload.type === "provider_event" &&
    payload.providerType === "paper_display_labels" &&
    payload.payload?.version === 1
      ? payload.payload.displayLabels
      : payload.type === "tool_result" && payload.ok
        ? isRecord(payload.content)
          ? payload.content.displayLabels
          : undefined
        : undefined;
  if (!values || typeof values !== "object") return undefined;
  return new Map(
    Object.entries(values).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function createAgentTraceEventScan(): AgentTraceEventScan {
  return {
    planPhase: null,
    pending: new Map(),
    hasFinal: false,
    finalText: "",
    labels: undefined,
    hasAgentStage: false,
    hasStageSource: false,
    planDocumentId: null,
    hasDiscovery: false,
    minCreatedAt: 0,
    maxCreatedAt: 0,
  };
}

export function applyAgentTraceEventToScan(
  scan: AgentTraceEventScan,
  entry: AgentRunEventRecord,
): void {
  const payload = entry.payload;
  const createdAt = Number(entry.createdAt);
  if (
    Number.isFinite(createdAt) &&
    createdAt > 0 &&
    (!scan.minCreatedAt || createdAt < scan.minCreatedAt)
  )
    scan.minCreatedAt = createdAt;
  if (Number.isFinite(createdAt) && createdAt > scan.maxCreatedAt)
    scan.maxCreatedAt = createdAt;
  const phase = readTracePlanPhase(payload);
  if (phase) scan.planPhase = phase;
  const labels = readTraceDisplayLabels(payload);
  if (labels) scan.labels = labels;
  if (STAGE_SOURCE_EVENT_TYPES.has(payload.type)) scan.hasStageSource = true;
  const planEvent = readStoredPlanEvent(payload);
  if (planEvent?.type === "plan_execution_updated")
    scan.planLedger = planEvent.ledger;
  else if (
    planEvent?.type === "plan_ready" ||
    planEvent?.type === "plan_updated"
  )
    scan.planArtifact = planEvent.artifact;
  switch (payload.type) {
    case "agent_stage":
      scan.hasAgentStage = true;
      return;
    case "confirmation_required":
      scan.pending.set(payload.requestId, payload.action);
      if (payload.action.discovery) scan.hasDiscovery = true;
      return;
    case "confirmation_resolved":
      scan.pending.delete(payload.requestId);
      return;
    case "final":
      scan.hasFinal = true;
      scan.finalText = sanitizeText(payload.text || "").trim();
      return;
    case "material_finalized":
      scan.planDocumentId = payload.materialRef.documentId;
      return;
    default:
      return;
  }
}

export function scanAgentTraceEvents(
  events: readonly AgentRunEventRecord[],
): AgentTraceEventScan {
  const scan = createAgentTraceEventScan();
  for (const entry of events) applyAgentTraceEventToScan(scan, entry);
  return scan;
}

/** The confirmation the reader still has to answer: the latest one asked. */
export function readPendingConfirmation(
  scan: AgentTraceEventScan,
): { requestId: string; action: AgentPendingAction } | null {
  let last: { requestId: string; action: AgentPendingAction } | null = null;
  for (const [requestId, action] of scan.pending) last = { requestId, action };
  return last;
}
