import { config } from "../../../package.json";
import { getClaudeRuntimeRootDir } from "../../claudeCode/projectSkills";
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
} from "../../shared/conversationWriteFence";
import type {
  AgentEvent,
  AgentRunEventRecord,
  AgentRunRecord,
  AgentRunStatus,
} from "../types";

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
const runConversationKeys = new Map<string, number>();
const deletedRunIDsByConversation = new Map<
  number,
  { runIDs: string[]; generation: number }
>();

type IOUtilsLike = {
  write?: (path: string, data: Uint8Array<ArrayBufferLike>) => Promise<unknown>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
  remove?: (path: string) => Promise<void>;
  getChildren?: (path: string) => Promise<string[]>;
};

type OSFileLike = {
  writeAtomic?: (
    path: string,
    data: Uint8Array<ArrayBufferLike>,
  ) => Promise<void>;
  makeDir?: (
    path: string,
    options?: { from?: string; ignoreExisting?: boolean },
  ) => Promise<void>;
  remove?: (path: string) => Promise<void>;
};

function getIOUtils(): IOUtilsLike | undefined {
  return (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils;
}

function isAgentTraceExportEnabled(): boolean {
  try {
    const raw = Zotero.Prefs.get(AGENT_TRACE_EXPORT_PREF_KEY, true);
    return raw === true || `${raw || ""}`.toLowerCase() === "true";
  } catch {
    return false;
  }
}

function getOSFile(): OSFileLike | undefined {
  return (globalThis as { OS?: { File?: OSFileLike } }).OS?.File;
}

async function ensureDir(path: string): Promise<void> {
  const io = getIOUtils();
  if (io?.makeDirectory) {
    await io.makeDirectory(path, {
      createAncestors: true,
      ignoreExisting: true,
    });
    return;
  }
  const osFile = getOSFile();
  if (osFile?.makeDir) {
    await osFile.makeDir(path, {
      from: getLocalParentPath(path),
      ignoreExisting: true,
    });
    return;
  }
  throw new Error("No directory API available for trace export");
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
        ztoolkit.log(
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

export async function initAgentTraceStore(): Promise<void> {
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
    await Zotero.DB.queryAsync(
      `UPDATE ${AGENT_RUNS_TABLE}
       SET status = ?, completed_at = ?, final_text = ?
       WHERE status = 'running'`,
      ["failed", Date.now(), INTERRUPTED_AGENT_RUN_MARKER],
    );
    await installConversationKeyLedgerAgentTriggers();
  });
  await sweepOrphanedAgentTraceExports();
}

/** Remove deterministic trace files whose manifest was deleted before the
 * process crashed.  Only files produced by this store are considered. */
export async function sweepOrphanedAgentTraceExports(): Promise<void> {
  const io = getIOUtils();
  if (!io?.getChildren || !io.remove) return;
  let manifestRows: Array<{ runId?: unknown }> = [];
  let cleanupRows: Array<{
    runId?: unknown;
    exportPath?: unknown;
  }> = [];
  try {
    manifestRows = (await Zotero.DB.queryAsync(
      `SELECT run_id AS runId FROM ${AGENT_TRACE_EXPORTS_TABLE}`,
    )) as Array<{ runId?: unknown }>;
    cleanupRows = (await Zotero.DB.queryAsync(
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
      await Zotero.DB.queryAsync(
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

export async function appendAgentRunEvent(
  runId: string,
  seq: number,
  event: AgentEvent,
): Promise<void> {
  const conversationKey = runConversationKeys.get(runId);
  if (conversationKey && isConversationKeyRetiredInMemory(conversationKey)) {
    return;
  }
  await Zotero.DB.queryAsync(
    `INSERT INTO ${AGENT_RUN_EVENTS_TABLE}
      (run_id, seq, event_type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [runId, seq, event.type, JSON.stringify(event), Date.now()],
  );
  scheduleAgentRunTraceExport(runId);
}

export async function listAgentRunEvents(
  runId: string,
): Promise<AgentRunEventRecord[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT run_id AS runId,
            seq,
            event_type AS eventType,
            payload_json AS payloadJson,
            created_at AS createdAt
     FROM ${AGENT_RUN_EVENTS_TABLE}
     WHERE run_id = ?
     ORDER BY seq ASC, id ASC`,
    [runId],
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

export async function getAgentRunTrace(runId: string): Promise<{
  run: AgentRunRecord | null;
  events: AgentRunEventRecord[];
}> {
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
  const run = toAgentRunRecord(rows?.[0]);
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
