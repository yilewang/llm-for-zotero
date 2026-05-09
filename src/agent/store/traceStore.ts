import { config } from "../../../package.json";
import { getClaudeRuntimeRootDir } from "../../claudeCode/projectSkills";
import { getLocalParentPath, joinLocalPath } from "../../utils/localPath";
import type {
  AgentEvent,
  AgentRunEventRecord,
  AgentRunRecord,
  AgentRunStatus,
} from "../types";

const AGENT_RUNS_TABLE = "llm_for_zotero_agent_runs";
const AGENT_RUN_EVENTS_TABLE = "llm_for_zotero_agent_run_events";
const AGENT_RUN_EVENTS_INDEX = "llm_for_zotero_agent_run_events_run_idx";
const AGENT_TRACE_EXPORT_DIR_NAME = "trace-debug";
const AGENT_TRACE_EXPORT_PREF_KEY = `${config.prefsPrefix}.agentTraceExportEnabled`;

const traceExportTimers = new Map<string, number>();
const traceExportInFlight = new Map<string, Promise<void>>();

type IOUtilsLike = {
  write?: (path: string, data: Uint8Array<ArrayBufferLike>) => Promise<unknown>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
};

type OSFileLike = {
  writeAtomic?: (path: string, data: Uint8Array<ArrayBufferLike>) => Promise<void>;
  makeDir?: (
    path: string,
    options?: { from?: string; ignoreExisting?: boolean },
  ) => Promise<void>;
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
    await io.makeDirectory(path, { createAncestors: true, ignoreExisting: true });
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
  return joinLocalPath(getClaudeRuntimeRootDir(), ".debug", AGENT_TRACE_EXPORT_DIR_NAME);
}

export function getAgentTraceExportPath(runId: string): string {
  const safeRunId = (runId || "unknown-run").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return joinLocalPath(getAgentTraceExportDir(), `${safeRunId}.json`);
}

function formatTraceClockTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad2 = (value: number) => String(Math.max(0, Math.floor(value))).padStart(2, "0");
  const pad3 = (value: number) => String(Math.max(0, Math.floor(value))).padStart(3, "0");
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
        ztoolkit.log("LLM: Failed to export agent trace", normalizedRunId, error);
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
      `CREATE INDEX IF NOT EXISTS ${AGENT_RUN_EVENTS_INDEX}
       ON ${AGENT_RUN_EVENTS_TABLE} (run_id, seq, id)`,
    );
  });
}

export async function createAgentRun(record: AgentRunRecord): Promise<void> {
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
  scheduleAgentRunTraceExport(record.runId, 0);
}

export async function finishAgentRun(
  runId: string,
  status: AgentRunStatus,
  finalText?: string,
): Promise<void> {
  await Zotero.DB.queryAsync(
    `UPDATE ${AGENT_RUNS_TABLE}
     SET status = ?,
         completed_at = ?,
         final_text = ?
     WHERE run_id = ?`,
    [status, Date.now(), finalText || null, runId],
  );
  scheduleAgentRunTraceExport(runId, 0);
}

export async function appendAgentRunEvent(
  runId: string,
  seq: number,
  event: AgentEvent,
): Promise<void> {
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
  )) as
    | Array<{
        runId?: unknown;
        conversationKey?: unknown;
        mode?: unknown;
        modelName?: unknown;
        status?: unknown;
        createdAt?: unknown;
        completedAt?: unknown;
        finalText?: unknown;
      }>
    | undefined;
  const row = rows?.[0];
  const run =
    row &&
    typeof row.runId === "string" &&
    typeof row.mode === "string" &&
    typeof row.status === "string" &&
    Number.isFinite(Number(row.conversationKey)) &&
    Number.isFinite(Number(row.createdAt))
      ? {
          runId: row.runId,
          conversationKey: Math.floor(Number(row.conversationKey)),
          mode: "agent" as const,
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
  return {
    run,
    events: await listAgentRunEvents(runId),
  };
}
