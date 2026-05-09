import type {
  AgentEvent,
  AgentRunEventRecord,
  AgentRunRecord,
  AgentRunStatus,
} from "../types";

const AGENT_RUNS_TABLE = "llm_for_zotero_agent_runs";
const AGENT_RUN_EVENTS_TABLE = "llm_for_zotero_agent_run_events";
const AGENT_RUN_EVENTS_INDEX = "llm_for_zotero_agent_run_events_run_idx";

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
