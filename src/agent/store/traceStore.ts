import { appLogger } from "../../core/logging";
import {
  deleteIfPresent,
  isMissingTableError,
  type AgentPurgeDb,
} from "./inTransactionDelete";
import { config } from "../../../package.json";
import { getClaudeRuntimeRootDir } from "../../claudeCode/projectSkills";
import {
  ensureDirFromParent,
  getIOUtils,
  getOSFile,
} from "../../utils/geckoFs";
import { getLocalParentPath, joinLocalPath } from "../../utils/localPath";
import {
  getConversationKeyLedgerEntry,
  installConversationKeyLedgerAgentTriggers,
  isConversationKeyLedgerStoreInitialized,
  isConversationKeyRetiredInMemory,
} from "../../shared/conversationKeyLedger";
import {
  areConversationWritesFrozen,
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../../shared/conversationWriteFence";
import type {
  AgentEvent,
  AgentRunEventRecord,
  AgentRunRecord,
  AgentRunStatus,
} from "../types";
import { getMaintenanceQueryOptions } from "../../core/logging";
import type { RunEventRow } from "./runEventWriter";
import {
  buildToolResultPreview,
  isTruncatedToolResultContent,
  PERSISTED_TOOL_RESULT_MAX_BYTES,
  type TruncatedToolResultContent,
} from "./truncatedToolResult";

export {
  isTruncatedToolResultContent,
  PERSISTED_TOOL_RESULT_MAX_BYTES,
  type TruncatedToolResultContent,
};

const AGENT_RUNS_TABLE = "llm_for_zotero_agent_runs";
const AGENT_RUN_EVENTS_TABLE = "llm_for_zotero_agent_run_events";
const AGENT_TRACE_EXPORTS_TABLE = "llm_for_zotero_agent_trace_exports";
const AGENT_TRACE_FILE_CLEANUP_TABLE =
  "llm_for_zotero_agent_trace_file_cleanup";
const AGENT_RUN_EVENTS_INDEX = "llm_for_zotero_agent_run_events_run_idx";
const AGENT_TRACE_EXPORT_DIR_NAME = "trace-debug";
const AGENT_TRACE_EXPORT_PREF_KEY = `${config.prefsPrefix}.agentTraceExportEnabled`;
export const INTERRUPTED_AGENT_RUN_MARKER =
  "Agent run interrupted before completion.";

type AgentRunRow = {
  runId?: unknown;
  conversationKey?: unknown;
  mode?: unknown;
  modelName?: unknown;
  status?: unknown;
  createdAt?: unknown;
  completedAt?: unknown;
  finalText?: unknown;
};

const traceExportTimers = new Map<string, number>();
const traceExportInFlight = new Map<string, Promise<void>>();
let orphanedTraceSweepInFlight: Promise<void> | null = null;
const runConversationKeys = new Map<string, number>();
const deletedRunIDsByConversation = new Map<
  number,
  { runIDs: string[]; generation: number }
>();

function isAgentTraceExportEnabled(): boolean {
  try {
    const raw = Zotero.Prefs.get(AGENT_TRACE_EXPORT_PREF_KEY, true);
    return raw === true || `${raw || ""}`.toLowerCase() === "true";
  } catch {
    return false;
  }
}

async function ensureDir(path: string): Promise<void> {
  if (!(await ensureDirFromParent(path))) {
    throw new Error("No directory API available for trace export");
  }
}

async function writeUtf8File(path: string, content: string): Promise<void> {
  const bytes = new TextEncoder().encode(content);
  await ensureDir(getLocalParentPath(path));
  const io = getIOUtils();
  if (io?.write) {
    await io.write(path, bytes);
    return;
  }
  const osFile = getOSFile();
  if (osFile?.writeAtomic) {
    await osFile.writeAtomic(path, bytes);
    return;
  }
  throw new Error("No file write API available for trace export");
}

function getAgentTraceExportDir(): string {
  return joinLocalPath(
    getClaudeRuntimeRootDir(),
    ".debug",
    AGENT_TRACE_EXPORT_DIR_NAME,
  );
}

export function getAgentTraceExportPath(runId: string): string {
  const safeRunId = (runId || "unknown-run").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return joinLocalPath(getAgentTraceExportDir(), `${safeRunId}.json`);
}

function formatTraceClockTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad2 = (value: number) =>
    String(Math.max(0, Math.floor(value))).padStart(2, "0");
  const pad3 = (value: number) =>
    String(Math.max(0, Math.floor(value))).padStart(3, "0");
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${pad3(date.getMilliseconds())}`;
}

function stringifyTracePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload ?? "");
  }
}

function buildReadableTrace(events: AgentRunEventRecord[]): string {
  if (!events.length) return "";
  const firstTimestamp = events[0].createdAt;
  let previousTimestamp = firstTimestamp;
  return events
    .map((entry) => {
      const fromStart = Math.max(0, entry.createdAt - firstTimestamp);
      const fromPrevious = Math.max(0, entry.createdAt - previousTimestamp);
      previousTimestamp = entry.createdAt;
      return [
        `#${entry.seq} ${formatTraceClockTime(entry.createdAt)} +${fromStart}ms Δ${fromPrevious}ms ${entry.eventType}`,
        stringifyTracePayload(entry.payload),
      ].join("\n");
    })
    .join("\n\n");
}

async function exportAgentRunTrace(runId: string): Promise<void> {
  const trace = await getAgentRunTrace(runId);
  // A deletion can remove the run and its export manifest while an already
  // scheduled timer is waiting.  Never turn that missing witness into an
  // empty trace file after the conversation has been deleted.
  if (!trace.run) return;
  const ledger = await getConversationKeyLedgerEntry(trace.run.conversationKey);
  if (!ledger || ledger.retiredAt) return;
  const payload = {
    exportedAt: Date.now(),
    exportPath: getAgentTraceExportPath(runId),
    run: trace.run,
    events: trace.events,
    readable: buildReadableTrace(trace.events),
  };
  await writeUtf8File(payload.exportPath, JSON.stringify(payload, null, 2));
}

function scheduleAgentRunTraceExport(runId: string, delayMs = 250): void {
  if (!isAgentTraceExportEnabled()) return;
  const normalizedRunId = (runId || "").trim();
  if (!normalizedRunId) return;
  const existing = traceExportTimers.get(normalizedRunId);
  if (typeof existing === "number") {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    traceExportTimers.delete(normalizedRunId);
    const task = exportAgentRunTrace(normalizedRunId)
      .catch((error) => {
        appLogger.warn(
          "LLM: Failed to export agent trace",
          normalizedRunId,
          error,
        );
      })
      .finally(() => {
        traceExportInFlight.delete(normalizedRunId);
      });
    traceExportInFlight.set(normalizedRunId, task);
  }, delayMs) as unknown as number;
  traceExportTimers.set(normalizedRunId, timer);
}

/** Schema preparation is safe while other conversations are running. */
export async function ensureAgentTraceSchema(): Promise<void> {
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${AGENT_RUNS_TABLE} (
        run_id TEXT PRIMARY KEY,
        conversation_key INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('agent')),
        model_name TEXT,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        final_text TEXT
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${AGENT_RUN_EVENTS_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${AGENT_TRACE_EXPORTS_TABLE} (
        run_id TEXT PRIMARY KEY,
        conversation_key INTEGER NOT NULL,
        export_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${AGENT_TRACE_FILE_CLEANUP_TABLE} (
        run_id TEXT PRIMARY KEY,
        conversation_key INTEGER NOT NULL,
        export_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${AGENT_RUN_EVENTS_INDEX}
       ON ${AGENT_RUN_EVENTS_TABLE} (run_id, seq, id)`,
    );
    await installConversationKeyLedgerAgentTriggers();
  });
}

/** Startup recovery runs only before the new runtime is published. */
export async function initAgentTraceStore(): Promise<void> {
  await ensureAgentTraceSchema();
  await Zotero.DB.queryAsync(
    `UPDATE ${AGENT_RUNS_TABLE}
     SET status = ?, completed_at = ?, final_text = ?
     WHERE status = 'running'`,
    ["failed", Date.now(), INTERRUPTED_AGENT_RUN_MARKER],
  );
  await sweepOrphanedAgentTraceExports();
}

/** Remove deterministic trace files whose manifest was deleted before the
 * process crashed.  Only files produced by this store are considered. */
async function runOrphanedAgentTraceExportSweep(): Promise<void> {
  const io = getIOUtils();
  if (!io?.getChildren || !io.remove) return;
  let manifestRows: Array<{ runId?: unknown }> = [];
  let cleanupRows: Array<{
    runId?: unknown;
    exportPath?: unknown;
  }> = [];
  const queryMaintenance = (
    sql: string,
    params?: unknown[],
  ): Promise<unknown> =>
    (
      Zotero.DB.queryAsync as unknown as (
        sql: string,
        params?: unknown[],
        options?: { debug?: boolean },
      ) => Promise<unknown>
    )(sql, params, getMaintenanceQueryOptions());
  try {
    manifestRows = (await queryMaintenance(
      `SELECT run_id AS runId FROM ${AGENT_TRACE_EXPORTS_TABLE}`,
    )) as Array<{ runId?: unknown }>;
    cleanupRows = (await queryMaintenance(
      `SELECT run_id AS runId, export_path AS exportPath
       FROM ${AGENT_TRACE_FILE_CLEANUP_TABLE}`,
    )) as typeof cleanupRows;
  } catch {
    return;
  }
  for (const row of cleanupRows) {
    const runId = typeof row.runId === "string" ? row.runId.trim() : "";
    const path =
      typeof row.exportPath === "string" && row.exportPath.trim()
        ? row.exportPath.trim()
        : runId
          ? getAgentTraceExportPath(runId)
          : "";
    if (!runId || !path) continue;
    try {
      await io.remove(path);
      await queryMaintenance(
        `DELETE FROM ${AGENT_TRACE_FILE_CLEANUP_TABLE} WHERE run_id = ?`,
        [runId],
      );
    } catch {
      // Keep the durable row for the next startup/maintenance sweep.
    }
  }
  const live = new Set(
    manifestRows
      .map((row) => (typeof row.runId === "string" ? row.runId.trim() : ""))
      .filter(Boolean)
      .map((runId) => `${runId.replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`),
  );
  let children: string[];
  try {
    children = await io.getChildren(getAgentTraceExportDir());
  } catch {
    return;
  }
  for (const path of children) {
    const name = String(path).split(/[\\/]/).pop() || "";
    if (!/^(?:agent-|bridge-error-)[a-zA-Z0-9._-]+\.json$/u.test(name)) {
      continue;
    }
    if (live.has(name)) continue;
    await io.remove(path).catch(() => {});
  }
}

export function sweepOrphanedAgentTraceExports(): Promise<void> {
  if (orphanedTraceSweepInFlight) return orphanedTraceSweepInFlight;
  const task = runOrphanedAgentTraceExportSweep().finally(() => {
    if (orphanedTraceSweepInFlight === task) {
      orphanedTraceSweepInFlight = null;
    }
  });
  orphanedTraceSweepInFlight = task;
  return task;
}

/** Remember run IDs before the deletion transaction removes their rows. */
export function rememberAgentTraceRunIDsForDeletedConversation(
  conversationKey: number,
  runIDs: readonly string[],
): void {
  const key = Math.floor(Number(conversationKey));
  if (!Number.isFinite(key) || key <= 0) return;
  const normalized = Array.from(
    new Set(
      runIDs
        .map((runID) => (typeof runID === "string" ? runID.trim() : ""))
        .filter(Boolean),
    ),
  );
  if (normalized.length) {
    const previous = deletedRunIDsByConversation.get(key);
    deletedRunIDsByConversation.set(key, {
      runIDs: Array.from(new Set([...(previous?.runIDs || []), ...normalized])),
      generation: getConversationWriteGeneration(key),
    });
  }
}

/**
 * Roll back a pre-commit trace deletion marker when the owning transaction
 * fails.  The marker is intentionally process-local so late runs are rejected
 * between the durable DELETE and post-commit cache cleanup, but it must never
 * survive a rolled-back delete/Undo and suppress a legitimate new run.
 */
export function forgetAgentTraceRunIDsForDeletedConversation(
  conversationKey: number,
): void {
  const key = Math.floor(Number(conversationKey));
  if (!Number.isFinite(key) || key <= 0) return;
  deletedRunIDsByConversation.delete(key);
}

/** Queue trace files before their run/manifest rows are deleted. */
export async function queueAgentTraceFileCleanupInTransaction(
  conversationKey: number,
  runIDs: readonly string[],
): Promise<void> {
  const key = Math.floor(Number(conversationKey));
  if (!Number.isFinite(key) || key <= 0) return;
  for (const runID of Array.from(new Set(runIDs)).filter(Boolean)) {
    await Zotero.DB.queryAsync(
      `INSERT OR REPLACE INTO ${AGENT_TRACE_FILE_CLEANUP_TABLE}
        (run_id, conversation_key, export_path, created_at)
       VALUES (?, ?, ?, ?)`,
      [runID, key, getAgentTraceExportPath(runID), Date.now()],
    );
  }
}

export async function createAgentRun(record: AgentRunRecord): Promise<void> {
  if (isConversationKeyRetiredInMemory(record.conversationKey)) return;
  const ledgerInitialized = isConversationKeyLedgerStoreInitialized();
  if (ledgerInitialized) {
    const ledgerBeforeWrite = await getConversationKeyLedgerEntry(
      record.conversationKey,
    );
    if (!ledgerBeforeWrite || ledgerBeforeWrite.retiredAt) return;
  }
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${AGENT_RUNS_TABLE}
      (run_id, conversation_key, mode, model_name, status, created_at, completed_at, final_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.runId,
      record.conversationKey,
      record.mode,
      record.model || null,
      record.status,
      record.createdAt,
      record.completedAt || null,
      record.finalText || null,
    ],
  );
  const ledger = ledgerInitialized
    ? await getConversationKeyLedgerEntry(record.conversationKey)
    : null;
  if (
    (ledgerInitialized && (!ledger || ledger.retiredAt)) ||
    (() => {
      const marker = deletedRunIDsByConversation.get(record.conversationKey);
      return Boolean(
        marker &&
        (areConversationWritesFrozen(record.conversationKey) ||
          marker.generation ===
            getConversationWriteGeneration(record.conversationKey)),
      );
    })()
  ) {
    await Zotero.DB.queryAsync(
      `DELETE FROM ${AGENT_RUNS_TABLE} WHERE run_id = ?`,
      [record.runId],
    );
    runConversationKeys.delete(record.runId);
    return;
  }
  runConversationKeys.set(record.runId, record.conversationKey);
  if (!isAgentTraceExportEnabled()) return;
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${AGENT_TRACE_EXPORTS_TABLE}
      (run_id, conversation_key, export_path, created_at)
     VALUES (?, ?, ?, ?)`,
    [
      record.runId,
      record.conversationKey,
      getAgentTraceExportPath(record.runId),
      record.createdAt,
    ],
  );
  scheduleAgentRunTraceExport(record.runId, 0);
}

export async function finishAgentRun(
  runId: string,
  status: AgentRunStatus,
  finalText?: string,
): Promise<void> {
  const conversationKey = runConversationKeys.get(runId);
  if (conversationKey && isConversationKeyRetiredInMemory(conversationKey)) {
    return;
  }
  await Zotero.DB.queryAsync(
    `UPDATE ${AGENT_RUNS_TABLE}
     SET status = ?,
         completed_at = ?,
         final_text = ?
     WHERE run_id = ?`,
    [status, Date.now(), finalText || null, runId],
  );
  const trace = await getAgentRunTrace(runId);
  if (!trace.run) {
    runConversationKeys.delete(runId);
    return;
  }
  const ledger = await getConversationKeyLedgerEntry(trace.run.conversationKey);
  if (!ledger || ledger.retiredAt) {
    runConversationKeys.delete(runId);
    return;
  }
  scheduleAgentRunTraceExport(runId, 0);
}

function toAgentRunRecord(row: AgentRunRow | undefined): AgentRunRecord | null {
  return row &&
    typeof row.runId === "string" &&
    typeof row.mode === "string" &&
    typeof row.status === "string" &&
    Number.isFinite(Number(row.conversationKey)) &&
    Number.isFinite(Number(row.createdAt))
    ? {
        runId: row.runId,
        conversationKey: Math.floor(Number(row.conversationKey)),
        mode: "agent",
        model: typeof row.modelName === "string" ? row.modelName : undefined,
        status: row.status as AgentRunStatus,
        createdAt: Math.floor(Number(row.createdAt)),
        completedAt: Number.isFinite(Number(row.completedAt))
          ? Math.floor(Number(row.completedAt))
          : undefined,
        finalText:
          typeof row.finalText === "string" ? row.finalText : undefined,
      }
    : null;
}

export async function getLatestAgentRunForConversation(
  conversationKey: number,
): Promise<AgentRunRecord | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT run_id AS runId,
            conversation_key AS conversationKey,
            mode,
            model_name AS modelName,
            status,
            created_at AS createdAt,
            completed_at AS completedAt,
            final_text AS finalText
     FROM ${AGENT_RUNS_TABLE}
     WHERE conversation_key = ?
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1`,
    [conversationKey],
  )) as AgentRunRow[] | undefined;
  return toAgentRunRecord(rows?.[0]);
}

const AGENT_RUN_COLUMNS = `run_id AS runId,
            conversation_key AS conversationKey,
            mode,
            model_name AS modelName,
            status,
            created_at AS createdAt,
            completed_at AS completedAt,
            final_text AS finalText`;

/**
 * Every run of a conversation, oldest first; the flight report joins them to
 * an execution.  `limit` keeps only the newest N runs -- bounded in SQL, not
 * after the fact -- and still returns them oldest first.
 */
export async function listAgentRunsForConversation(
  conversationKey: number,
  options: { limit?: number } = {},
): Promise<AgentRunRecord[]> {
  const limit =
    options.limit === undefined
      ? undefined
      : Math.max(1, Math.floor(options.limit));
  const rows = (await Zotero.DB.queryAsync(
    limit === undefined
      ? `SELECT ${AGENT_RUN_COLUMNS}
     FROM ${AGENT_RUNS_TABLE}
     WHERE conversation_key = ?
     ORDER BY created_at ASC, rowid ASC`
      : `SELECT ${AGENT_RUN_COLUMNS}
     FROM ${AGENT_RUNS_TABLE}
     WHERE conversation_key = ?
     ORDER BY created_at DESC, rowid DESC
     LIMIT ?`,
    limit === undefined ? [conversationKey] : [conversationKey, limit],
  )) as AgentRunRow[] | undefined;
  const runs = (rows || [])
    .map((row) => toAgentRunRecord(row))
    .filter((run): run is AgentRunRecord => Boolean(run));
  return limit === undefined ? runs : runs.reverse();
}

/**
 * The form an event is persisted in. A successful tool result whose content
 * serializes above `PERSISTED_TOOL_RESULT_MAX_BYTES` and that names the
 * handle holding it is stored as a marker naming that handle, with a bounded
 * preview the trace row reads (`buildToolResultPreview`); a result
 * carrying action receipts is stored whole, since its receipts and content
 * are the record of a write. Every other event is stored as it is.
 */
export function compactRunEventForPersistence(event: AgentEvent): AgentEvent {
  if (event.type !== "tool_result" || !event.ok || event.actionReceipts?.length)
    return event;
  if (!event.toolResultHandle) return event;
  const bytes = JSON.stringify(event.content ?? null).length;
  if (bytes <= PERSISTED_TOOL_RESULT_MAX_BYTES) return event;
  const preview = buildToolResultPreview(event.content);
  const content: TruncatedToolResultContent = {
    truncated: true,
    handle: event.toolResultHandle,
    bytes,
    ...(preview !== undefined ? { preview } : {}),
  };
  return { ...event, content };
}

function isRunRetired(runId: string): boolean {
  const conversationKey = runConversationKeys.get(runId);
  return Boolean(
    conversationKey && isConversationKeyRetiredInMemory(conversationKey),
  );
}

/**
 * Inserts one event row. `event` is compacted here unless the caller passes
 * it already compacted (`compacted`), as a batch does before its transaction.
 */
async function insertAgentRunEvent(
  runId: string,
  seq: number,
  event: AgentEvent,
  createdAt: number,
  compacted = false,
): Promise<void> {
  const persisted = compacted ? event : compactRunEventForPersistence(event);
  await Zotero.DB.queryAsync(
    `INSERT INTO ${AGENT_RUN_EVENTS_TABLE}
      (run_id, seq, event_type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [runId, seq, persisted.type, JSON.stringify(persisted), createdAt],
  );
}

export async function appendAgentRunEvent(
  runId: string,
  seq: number,
  event: AgentEvent,
  createdAt = Date.now(),
): Promise<void> {
  if (isRunRetired(runId)) return;
  await insertAgentRunEvent(runId, seq, event, createdAt);
  scheduleAgentRunTraceExport(runId);
}

/**
 * Appends a batch of a run's events in one transaction, one row each, in the
 * order given; the trace export is scheduled once for the batch. A big
 * result's marker and preview are built before the transaction opens, so the
 * transaction only inserts rows.
 */
export async function appendAgentRunEvents(
  runId: string,
  rows: readonly RunEventRow[],
): Promise<void> {
  if (!rows.length || isRunRetired(runId)) return;
  const compacted = rows.map((row) => ({
    ...row,
    event: compactRunEventForPersistence(row.event),
  }));
  await Zotero.DB.executeTransaction(async () => {
    for (const row of compacted)
      await insertAgentRunEvent(runId, row.seq, row.event, row.createdAt, true);
  });
  scheduleAgentRunTraceExport(runId);
}

/** Save a provider's coalesced trace before publishing the message that refers to it. */
export async function saveAgentRunTraceSnapshot(
  record: AgentRunRecord,
  events: readonly AgentRunEventRecord[],
): Promise<void> {
  await Zotero.DB.executeTransaction(async () => {
    await createAgentRun(record);
    if (!runConversationKeys.has(record.runId)) return;
    await Zotero.DB.queryAsync(
      `DELETE FROM ${AGENT_RUN_EVENTS_TABLE} WHERE run_id = ?`,
      [record.runId],
    );
    for (const [index, event] of events.entries()) {
      await appendAgentRunEvent(
        record.runId,
        index + 1,
        event.payload,
        event.createdAt,
      );
    }
  });
}

export async function appendAgentRunEventAfterLatest(
  runId: string,
  event: AgentEvent,
): Promise<AgentRunEventRecord> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT COALESCE(MAX(seq), 0) AS maxSeq
     FROM ${AGENT_RUN_EVENTS_TABLE} WHERE run_id = ?`,
    [runId],
  )) as Array<{ maxSeq?: unknown }> | undefined;
  const seq = Math.max(0, Number(rows?.[0]?.maxSeq || 0)) + 1;
  const createdAt = Date.now();
  await Zotero.DB.queryAsync(
    `INSERT INTO ${AGENT_RUN_EVENTS_TABLE}
      (run_id, seq, event_type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [runId, seq, event.type, JSON.stringify(event), createdAt],
  );
  scheduleAgentRunTraceExport(runId);
  return { runId, seq, eventType: event.type, payload: event, createdAt };
}

/**
 * A run's persisted events, in order.  `eventTypes` narrows the read in SQL so
 * a caller that only needs a couple of event kinds does not pay to load and
 * parse the whole trace.
 */
export async function listAgentRunEvents(
  runId: string,
  options: { eventTypes?: readonly string[] } = {},
): Promise<AgentRunEventRecord[]> {
  const eventTypes = [...new Set(options.eventTypes || [])];
  if (options.eventTypes && !eventTypes.length) return [];
  const rows = (await Zotero.DB.queryAsync(
    `SELECT run_id AS runId,
            seq,
            event_type AS eventType,
            payload_json AS payloadJson,
            created_at AS createdAt
     FROM ${AGENT_RUN_EVENTS_TABLE}
     WHERE run_id = ?${
       eventTypes.length
         ? ` AND event_type IN (${eventTypes.map(() => "?").join(", ")})`
         : ""
     }
     ORDER BY seq ASC, id ASC`,
    [runId, ...eventTypes],
  )) as
    | Array<{
        runId?: unknown;
        seq?: unknown;
        eventType?: unknown;
        payloadJson?: unknown;
        createdAt?: unknown;
      }>
    | undefined;
  if (!rows?.length) return [];
  const out: AgentRunEventRecord[] = [];
  for (const row of rows) {
    if (typeof row.runId !== "string" || row.runId !== runId) continue;
    const seq = Number(row.seq);
    const createdAt = Number(row.createdAt);
    if (!Number.isFinite(seq) || !Number.isFinite(createdAt)) continue;
    let payload: AgentEvent | null = null;
    try {
      payload = JSON.parse(String(row.payloadJson || "")) as AgentEvent;
    } catch (_error) {
      payload = null;
    }
    if (!payload || typeof payload.type !== "string") continue;
    // Before interaction metadata existed, this persisted review action was
    // the native question contract. Upgrade only the decoded legacy record;
    // live renderers use explicit metadata and stored evidence stays intact.
    if (
      payload.type === "confirmation_required" &&
      payload.action?.interaction === undefined &&
      payload.action?.toolName === "request_user_input" &&
      payload.action.mode === "review" &&
      Array.isArray(payload.action.fields)
    ) {
      payload = {
        ...payload,
        action: { ...payload.action, interaction: "user_input" },
      };
    }
    out.push({
      runId,
      seq: Math.floor(seq),
      eventType: payload.type,
      payload,
      createdAt: Math.floor(createdAt),
    });
  }
  return out;
}

/**
 * Several runs' events of the given types, in one read: run order is the
 * caller's, events within a run by sequence. For a view that rebuilds a
 * conversation-wide summary from a few event kinds (Task progress).
 */
export async function listAgentRunEventsForRuns(
  runIds: readonly string[],
  eventTypes: readonly string[],
): Promise<AgentRunEventRecord[]> {
  const ids = [...new Set(runIds.map((id) => id.trim()).filter(Boolean))];
  const types = [...new Set(eventTypes)];
  if (!ids.length || !types.length) return [];
  const out: AgentRunEventRecord[] = [];
  // Bounded IN lists keep each statement well under SQLite's variable cap.
  for (let start = 0; start < ids.length; start += 200) {
    const chunk = ids.slice(start, start + 200);
    const rows = (await Zotero.DB.queryAsync(
      `SELECT run_id AS runId,
              seq,
              payload_json AS payloadJson,
              created_at AS createdAt
       FROM ${AGENT_RUN_EVENTS_TABLE}
       WHERE run_id IN (${chunk.map(() => "?").join(", ")})
         AND event_type IN (${types.map(() => "?").join(", ")})
       ORDER BY run_id, seq ASC, id ASC`,
      [...chunk, ...types],
    )) as
      | Array<{
          runId?: unknown;
          seq?: unknown;
          payloadJson?: unknown;
          createdAt?: unknown;
        }>
      | undefined;
    for (const row of rows || []) {
      if (typeof row.runId !== "string") continue;
      const seq = Number(row.seq);
      const createdAt = Number(row.createdAt);
      if (!Number.isFinite(seq) || !Number.isFinite(createdAt)) continue;
      let payload: AgentEvent | null = null;
      try {
        payload = JSON.parse(String(row.payloadJson || "")) as AgentEvent;
      } catch (_error) {
        payload = null;
      }
      if (!payload || typeof payload.type !== "string") continue;
      out.push({
        runId: row.runId,
        seq: Math.floor(seq),
        eventType: payload.type,
        payload,
        createdAt: Math.floor(createdAt),
      });
    }
  }
  return out;
}

/** A run's row, without its events. */
export async function getAgentRunRecord(
  runId: string,
): Promise<AgentRunRecord | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT run_id AS runId,
            conversation_key AS conversationKey,
            mode,
            model_name AS modelName,
            status,
            created_at AS createdAt,
            completed_at AS completedAt,
            final_text AS finalText
     FROM ${AGENT_RUNS_TABLE}
     WHERE run_id = ?
     LIMIT 1`,
    [runId],
  )) as AgentRunRow[] | undefined;
  return toAgentRunRecord(rows?.[0]);
}

export async function getAgentRunTrace(runId: string): Promise<{
  run: AgentRunRecord | null;
  events: AgentRunEventRecord[];
}> {
  const run = await getAgentRunRecord(runId);
  return {
    run,
    events: await listAgentRunEvents(runId),
  };
}

/** Delete every persisted trace row and export owned by a conversation. */
export async function clearAgentTraceState(
  conversationKey: number,
): Promise<string[]> {
  const normalizedKey = Math.floor(Number(conversationKey));
  if (!Number.isFinite(normalizedKey) || normalizedKey <= 0) return [];
  if (typeof Zotero?.DB?.executeTransaction !== "function") return [];
  const rows = (await Zotero.DB.queryAsync(
    `SELECT run_id AS runId
     FROM ${AGENT_RUNS_TABLE}
     WHERE conversation_key = ?`,
    [normalizedKey],
  )) as Array<{ runId?: unknown }> | undefined;
  const exportRows = (await Zotero.DB.queryAsync(
    `SELECT run_id AS runId
     FROM ${AGENT_TRACE_EXPORTS_TABLE}
     WHERE conversation_key = ?`,
    [normalizedKey],
  ).catch((error: unknown) => {
    if (/no such table|no table/i.test(String(error))) return [];
    throw error;
  })) as Array<{ runId?: unknown }> | undefined;
  const runIds = (rows || [])
    .map((row) => (typeof row.runId === "string" ? row.runId.trim() : ""))
    .filter(Boolean);
  const exportRunIDs = (exportRows || [])
    .map((row) => (typeof row.runId === "string" ? row.runId.trim() : ""))
    .filter(Boolean);
  const cleanupRows = (await Zotero.DB.queryAsync(
    `SELECT run_id AS runId
     FROM ${AGENT_TRACE_FILE_CLEANUP_TABLE}
     WHERE conversation_key = ?`,
    [normalizedKey],
  ).catch((error: unknown) => {
    if (/no such table|no table/i.test(String(error))) return [];
    throw error;
  })) as Array<{ runId?: unknown }> | undefined;
  const queuedRunIDs = (cleanupRows || [])
    .map((row) => (typeof row.runId === "string" ? row.runId.trim() : ""))
    .filter(Boolean);
  const rememberedRunIDs =
    deletedRunIDsByConversation.get(normalizedKey)?.runIDs || [];
  deletedRunIDsByConversation.delete(normalizedKey);
  const cleanupRunIDs = Array.from(
    new Set([...runIds, ...exportRunIDs, ...rememberedRunIDs, ...queuedRunIDs]),
  );
  await Zotero.DB.executeTransaction(async () => {
    if (runIds.length) {
      const placeholders = runIds.map(() => "?").join(", ");
      await Zotero.DB.queryAsync(
        `DELETE FROM ${AGENT_RUN_EVENTS_TABLE} WHERE run_id IN (${placeholders})`,
        runIds,
      );
      await Zotero.DB.queryAsync(
        `DELETE FROM ${AGENT_RUNS_TABLE} WHERE run_id IN (${placeholders})`,
        runIds,
      );
    }
  });
  let firstFileError: unknown;
  for (const runId of cleanupRunIDs) {
    runConversationKeys.delete(runId);
    const timer = traceExportTimers.get(runId);
    if (typeof timer === "number") {
      clearTimeout(timer);
      traceExportTimers.delete(runId);
    }
    const inFlight = traceExportInFlight.get(runId);
    if (inFlight) await inFlight.catch(() => {});
    traceExportInFlight.delete(runId);
    const path = getAgentTraceExportPath(runId);
    try {
      const io = getIOUtils();
      if (io?.remove) await io.remove(path);
      else await getOSFile()?.remove?.(path);
    } catch (error) {
      // Preserve the durable cleanup row and surface the failure so the
      // conversation deletion obligation remains pending.
      firstFileError ??= error;
      continue;
    }
    try {
      await Zotero.DB.queryAsync(
        `DELETE FROM ${AGENT_TRACE_EXPORTS_TABLE} WHERE run_id = ?`,
        [runId],
      );
      await Zotero.DB.queryAsync(
        `DELETE FROM ${AGENT_TRACE_FILE_CLEANUP_TABLE} WHERE run_id = ?`,
        [runId],
      );
    } catch (error) {
      if (!/no such table|no table/i.test(String(error))) throw error;
    }
  }
  if (firstFileError) throw firstFileError;
  return cleanupRunIDs;
}

/** Durable host events for provider-owned turns, using the existing run store. */
export type AgentRunEventJournal = {
  runId: string;
  append(event: AgentEvent): Promise<void>;
  finish(status: AgentRunStatus, text: string): Promise<void>;
};

export function createAgentRunEventJournal(params: {
  conversationKey: number;
  conversationGeneration: number;
  model?: string;
}): AgentRunEventJournal {
  const runId = `native-host:${params.conversationKey}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let started = false;
  let closed = false;
  let seq = 0;
  let queue = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(() =>
      withConversationWriteLock(params.conversationKey, async () => {
        if (
          areConversationWritesFrozen(params.conversationKey) ||
          !isConversationWriteGenerationCurrent(
            params.conversationKey,
            params.conversationGeneration,
          )
        )
          throw new Error(
            "The conversation changed; native execution authority is no longer current.",
          );
        if (!started) {
          await createAgentRun({
            runId,
            conversationKey: params.conversationKey,
            mode: "agent",
            model: params.model,
            status: "running",
            createdAt: Date.now(),
          });
          const trace = await getAgentRunTrace(runId);
          if (!trace.run)
            throw new Error(
              "The native turn could not persist its execution authority.",
            );
          started = true;
        }
        await task();
      }),
    );
    return queue;
  };
  return {
    runId,
    append(event) {
      if (closed)
        return Promise.reject(
          new Error("The native run is already finalized."),
        );
      const snapshot = JSON.parse(JSON.stringify(event)) as AgentEvent;
      return enqueue(() => appendAgentRunEvent(runId, ++seq, snapshot));
    },
    finish(status, text) {
      if (closed) return queue;
      closed = true;
      return enqueue(async () => {
        await appendAgentRunEvent(runId, ++seq, { type: "final", text });
        await finishAgentRun(runId, status, text);
      });
    },
  };
}

/**
 * The run IDs a conversation's trace rows name, read inside its deletion
 * transaction before the rows go: the runs, then the trace exports.  An
 * absent table names none.
 */
export async function listAgentTraceRunIDsInTransaction(
  db: AgentPurgeDb,
  conversationKey: number,
): Promise<{ runIds: string[]; exportRunIds: string[] }> {
  const runRows = (await db
    .queryAsync(
      `SELECT run_id AS runId FROM ${AGENT_RUNS_TABLE} WHERE conversation_key = ?`,
      [conversationKey],
    )
    .catch((error) => {
      if (isMissingTableError(error)) return [];
      throw error;
    })) as Array<{ runId?: unknown }>;
  const runIds = (runRows || [])
    .map((row) => (typeof row.runId === "string" ? row.runId.trim() : ""))
    .filter(Boolean);
  const exportRows = (await db
    .queryAsync(
      `SELECT run_id AS runId FROM ${AGENT_TRACE_EXPORTS_TABLE} WHERE conversation_key = ?`,
      [conversationKey],
    )
    .catch((error) => {
      if (isMissingTableError(error)) return [];
      throw error;
    })) as Array<{ runId?: unknown }>;
  const exportRunIds = (exportRows || [])
    .map((row) => (typeof row.runId === "string" ? row.runId.trim() : ""))
    .filter(Boolean);
  return { runIds, exportRunIds };
}

/**
 * Delete a conversation's trace rows inside its deletion transaction: the
 * events of its runs, the runs, then the trace exports.  Each statement
 * treats an absent table as no rows.
 */
export async function deleteAgentTraceRowsInTransaction(
  db: AgentPurgeDb,
  conversationKey: number,
  runIds: readonly string[],
): Promise<void> {
  if (runIds.length) {
    const placeholders = runIds.map(() => "?").join(", ");
    await deleteIfPresent(
      db,
      `DELETE FROM ${AGENT_RUN_EVENTS_TABLE} WHERE run_id IN (${placeholders})`,
      [...runIds],
    );
  }
  await deleteIfPresent(
    db,
    `DELETE FROM ${AGENT_RUNS_TABLE} WHERE conversation_key = ?`,
    [conversationKey],
  );
  await deleteIfPresent(
    db,
    `DELETE FROM ${AGENT_TRACE_EXPORTS_TABLE} WHERE conversation_key = ?`,
    [conversationKey],
  );
}
