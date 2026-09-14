import type {
  ExecutionTask,
  PlanArtifact,
  PlanExecutionLedger,
  TaskEvidence,
} from "./types";
import {
  decodeExecutionTask,
  decodePlanArtifact,
  decodePlanExecutionLedger,
  decodeTaskEvidence,
} from "./decoders";
import {
  decodePlanAmendmentGrant,
  decodePlanAmendmentProposal,
  type PlanAmendmentGrant,
  type PlanAmendmentProposal,
} from "./planAmendmentTypes";

export const PLAN_ARTIFACTS_TABLE = "llm_for_zotero_plan_artifacts";
export const PLAN_EXECUTIONS_TABLE = "llm_for_zotero_plan_executions";
export const PLAN_EXECUTION_TASKS_TABLE = "llm_for_zotero_plan_execution_tasks";
export const PLAN_TASK_TRANSITIONS_TABLE =
  "llm_for_zotero_plan_task_transitions";
export const PLAN_TASK_EVIDENCE_TABLE = "llm_for_zotero_plan_task_evidence";
export const PLAN_AMENDMENTS_TABLE = "llm_for_zotero_plan_amendments";
export const PLAN_AMENDMENT_PROPOSALS_TABLE =
  "llm_for_zotero_plan_amendment_proposals";

type JsonRow = { payloadJson?: unknown };

function parsePayload<T>(
  row: JsonRow | undefined,
  decoder: (value: unknown) => T,
): T | null {
  if (!row || typeof row.payloadJson !== "string") return null;
  return decoder(JSON.parse(row.payloadJson));
}

export async function initAgentPlanStore(): Promise<void> {
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_ARTIFACTS_TABLE} (
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        conversation_key INTEGER NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        digest TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (plan_id, revision)
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_for_zotero_plan_artifacts_conversation_idx
       ON ${PLAN_ARTIFACTS_TABLE} (conversation_key, updated_at DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_EXECUTIONS_TABLE} (
        execution_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        conversation_key INTEGER NOT NULL,
        status TEXT NOT NULL,
        active_task_id TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_for_zotero_plan_executions_plan_idx
       ON ${PLAN_EXECUTIONS_TABLE} (plan_id, revision, updated_at DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_EXECUTION_TASKS_TABLE} (
        task_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        plan_step_id TEXT NOT NULL,
        parent_task_id TEXT,
        task_order INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_for_zotero_plan_tasks_execution_idx
       ON ${PLAN_EXECUTION_TASKS_TABLE} (execution_id, task_order)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_TASK_TRANSITIONS_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_for_zotero_plan_transitions_execution_idx
       ON ${PLAN_TASK_TRANSITIONS_TABLE} (execution_id, id)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_TASK_EVIDENCE_TABLE} (
        evidence_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        verified INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_for_zotero_plan_evidence_task_idx
       ON ${PLAN_TASK_EVIDENCE_TABLE} (execution_id, task_id, created_at)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_AMENDMENTS_TABLE} (
        grant_id TEXT PRIMARY KEY,
        proposal_digest TEXT NOT NULL UNIQUE,
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        execution_id TEXT NOT NULL,
        conversation_key INTEGER NOT NULL,
        kind TEXT NOT NULL,
        authority TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        authorized_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_for_zotero_plan_amendments_execution_idx
       ON ${PLAN_AMENDMENTS_TABLE} (execution_id, authorized_at ASC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_AMENDMENT_PROPOSALS_TABLE} (
        proposal_digest TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        execution_id TEXT NOT NULL,
        conversation_key INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    const interruptedAt = Date.now();
    const rows = (await Zotero.DB.queryAsync(
      `SELECT payload_json AS payloadJson FROM ${PLAN_EXECUTIONS_TABLE}
       WHERE status IN ('running', 'waiting_for_user')`,
    )) as JsonRow[] | undefined;
    for (const row of rows || []) {
      const ledger = parsePayload(row, decodePlanExecutionLedger);
      if (!ledger) continue;
      const tasks = ledger.tasks.map((task) =>
        task.status === "in_progress" || task.status === "waiting_for_user"
          ? {
              ...task,
              status: "interrupted" as const,
              updatedAt: interruptedAt,
            }
          : task,
      );
      await savePlanExecutionLedger(
        {
          ...ledger,
          status: "interrupted",
          activeTaskId: undefined,
          tasks,
          updatedAt: interruptedAt,
        },
        undefined,
        { alreadyInTransaction: true },
      );
    }
  });
}

export async function savePlanAmendmentProposal(
  proposal: PlanAmendmentProposal,
  status:
    | "awaiting_approval"
    | "authorized"
    | "applied"
    | "failed"
    | "superseded",
  now = Date.now(),
): Promise<void> {
  decodePlanAmendmentProposal(proposal);
  await Zotero.DB.queryAsync(
    `INSERT OR IGNORE INTO ${PLAN_AMENDMENT_PROPOSALS_TABLE}
      (proposal_digest, plan_id, revision, execution_id, conversation_key,
       kind, status, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      proposal.proposalDigest,
      proposal.planId,
      proposal.planRevision,
      proposal.executionId,
      proposal.conversationKey,
      proposal.kind,
      status,
      JSON.stringify(proposal),
      proposal.createdAt,
      now,
    ],
  );
}

export async function updatePlanAmendmentProposalStatus(
  proposalDigest: string,
  status:
    | "awaiting_approval"
    | "authorized"
    | "applied"
    | "failed"
    | "superseded",
  now = Date.now(),
): Promise<void> {
  await Zotero.DB.queryAsync(
    `UPDATE ${PLAN_AMENDMENT_PROPOSALS_TABLE}
     SET status = ?, updated_at = ? WHERE proposal_digest = ?`,
    [status, now, proposalDigest],
  );
}

export async function loadOpenContractRevisionProposal(
  planId: string,
): Promise<PlanAmendmentProposal | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson
     FROM ${PLAN_AMENDMENT_PROPOSALS_TABLE}
     WHERE plan_id = ? AND kind = 'contract_revision'
       AND status IN ('awaiting_approval', 'authorized', 'failed')
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [planId],
  )) as JsonRow[] | undefined;
  if (typeof rows?.[0]?.payloadJson !== "string") return null;
  return decodePlanAmendmentProposal(JSON.parse(rows[0].payloadJson));
}

export async function savePlanAmendmentGrant(
  grant: PlanAmendmentGrant,
): Promise<void> {
  decodePlanAmendmentGrant(grant);
  await Zotero.DB.queryAsync(
    `INSERT OR IGNORE INTO ${PLAN_AMENDMENTS_TABLE}
      (grant_id, proposal_digest, plan_id, revision, execution_id,
       conversation_key, kind, authority, status, payload_json, authorized_at,
       updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      grant.grantId,
      grant.proposal.proposalDigest,
      grant.proposal.planId,
      grant.proposal.planRevision,
      grant.proposal.executionId,
      grant.proposal.conversationKey,
      grant.proposal.kind,
      grant.authority,
      grant.status,
      JSON.stringify(grant),
      grant.authorizedAt,
      grant.appliedAt || grant.failedAt || grant.authorizedAt,
    ],
  );
}

export async function updatePlanAmendmentGrant(
  grant: PlanAmendmentGrant,
): Promise<void> {
  decodePlanAmendmentGrant(grant);
  await Zotero.DB.queryAsync(
    `UPDATE ${PLAN_AMENDMENTS_TABLE}
     SET status = ?, payload_json = ?, updated_at = ?
     WHERE grant_id = ? AND proposal_digest = ?`,
    [
      grant.status,
      JSON.stringify(grant),
      grant.appliedAt || grant.failedAt || grant.authorizedAt,
      grant.grantId,
      grant.proposal.proposalDigest,
    ],
  );
}

export async function loadPlanAmendmentGrantByProposalDigest(
  proposalDigest: string,
): Promise<PlanAmendmentGrant | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_AMENDMENTS_TABLE}
     WHERE proposal_digest = ? LIMIT 1`,
    [proposalDigest],
  )) as JsonRow[] | undefined;
  return parsePayload(rows?.[0], decodePlanAmendmentGrant);
}

export async function listPlanAmendmentGrants(
  executionId: string,
): Promise<PlanAmendmentGrant[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_AMENDMENTS_TABLE}
     WHERE execution_id = ? ORDER BY authorized_at ASC`,
    [executionId],
  )) as JsonRow[] | undefined;
  return (rows || [])
    .map((row) => parsePayload(row, decodePlanAmendmentGrant))
    .filter((grant): grant is PlanAmendmentGrant => Boolean(grant));
}

export async function savePlanArtifact(artifact: PlanArtifact): Promise<void> {
  decodePlanArtifact(artifact);
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${PLAN_ARTIFACTS_TABLE}
      (plan_id, revision, conversation_key, provider, status, digest,
       payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      artifact.planId,
      artifact.revision,
      artifact.conversationKey,
      artifact.provider,
      artifact.status,
      artifact.digest,
      JSON.stringify(artifact),
      artifact.createdAt,
      artifact.updatedAt,
    ],
  );
}

export async function loadPlanArtifact(
  planId: string,
  revision: number,
): Promise<PlanArtifact | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_ARTIFACTS_TABLE}
     WHERE plan_id = ? AND revision = ? LIMIT 1`,
    [planId, revision],
  )) as JsonRow[] | undefined;
  return parsePayload(rows?.[0], decodePlanArtifact);
}

export async function loadLatestPlanArtifactForConversation(
  conversationKey: number,
): Promise<PlanArtifact | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_ARTIFACTS_TABLE}
     WHERE conversation_key = ? ORDER BY updated_at DESC, revision DESC LIMIT 1`,
    [conversationKey],
  )) as JsonRow[] | undefined;
  return parsePayload(rows?.[0], decodePlanArtifact);
}

export async function savePlanExecutionLedger(
  ledger: PlanExecutionLedger,
  transition?: {
    taskId: string;
    fromStatus: string;
    toStatus: string;
    payload?: unknown;
    createdAt: number;
  },
  options: { alreadyInTransaction?: boolean } = {},
): Promise<void> {
  decodePlanExecutionLedger(ledger);
  const write = async () => {
    await Zotero.DB.queryAsync(
      `INSERT OR REPLACE INTO ${PLAN_EXECUTIONS_TABLE}
        (execution_id, plan_id, revision, conversation_key, status,
         active_task_id, payload_json, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ledger.executionId,
        ledger.planId,
        ledger.revision,
        ledger.conversationKey,
        ledger.status,
        ledger.activeTaskId || null,
        JSON.stringify(ledger),
        ledger.createdAt,
        ledger.updatedAt,
        ledger.completedAt || null,
      ],
    );
    for (let index = 0; index < ledger.tasks.length; index += 1) {
      const task = ledger.tasks[index];
      await Zotero.DB.queryAsync(
        `INSERT OR REPLACE INTO ${PLAN_EXECUTION_TASKS_TABLE}
          (task_id, execution_id, plan_step_id, parent_task_id, task_order,
           status, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          task.taskId,
          task.executionId,
          task.planStepId,
          task.parentTaskId || null,
          index,
          task.status,
          JSON.stringify(task),
          task.createdAt,
          task.updatedAt,
        ],
      );
    }
    if (transition) {
      await Zotero.DB.queryAsync(
        `INSERT INTO ${PLAN_TASK_TRANSITIONS_TABLE}
          (execution_id, task_id, from_status, to_status, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          ledger.executionId,
          transition.taskId,
          transition.fromStatus,
          transition.toStatus,
          JSON.stringify(transition.payload || {}),
          transition.createdAt,
        ],
      );
    }
  };
  if (options.alreadyInTransaction) {
    await write();
  } else {
    await Zotero.DB.executeTransaction(write);
  }
}

export async function loadPlanExecutionLedger(
  executionId: string,
): Promise<PlanExecutionLedger | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_EXECUTIONS_TABLE}
     WHERE execution_id = ? LIMIT 1`,
    [executionId],
  )) as JsonRow[] | undefined;
  const ledger = parsePayload(rows?.[0], decodePlanExecutionLedger);
  if (!ledger) return null;
  const taskRows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_EXECUTION_TASKS_TABLE}
     WHERE execution_id = ? ORDER BY task_order ASC`,
    [executionId],
  )) as JsonRow[] | undefined;
  const tasks = (taskRows || [])
    .map((row) => parsePayload(row, decodeExecutionTask))
    .filter((task): task is ExecutionTask => Boolean(task));
  return { ...ledger, tasks: tasks.length ? tasks : ledger.tasks };
}

export async function loadLatestPlanExecutionForPlan(
  planId: string,
  revision: number,
): Promise<PlanExecutionLedger | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT execution_id AS executionId FROM ${PLAN_EXECUTIONS_TABLE}
     WHERE plan_id = ? AND revision = ? ORDER BY updated_at DESC LIMIT 1`,
    [planId, revision],
  )) as Array<{ executionId?: unknown }> | undefined;
  const executionId =
    typeof rows?.[0]?.executionId === "string"
      ? rows[0].executionId.trim()
      : "";
  return executionId ? loadPlanExecutionLedger(executionId) : null;
}

export async function loadLatestResumablePlanExecutionForConversation(
  conversationKey: number,
): Promise<PlanExecutionLedger | null> {
  // Unit-test and non-Zotero utility callers can render/send without a host DB.
  // Production Zotero always supplies this global; absence means there cannot
  // be a durable execution to resume.
  if (typeof Zotero === "undefined") return null;
  const rows = (await Zotero.DB.queryAsync(
    `SELECT execution_id AS executionId FROM ${PLAN_EXECUTIONS_TABLE}
     WHERE conversation_key = ?
       AND status IN ('pending', 'running', 'waiting_for_user', 'interrupted')
     ORDER BY updated_at DESC LIMIT 1`,
    [conversationKey],
  )) as Array<{ executionId?: unknown }> | undefined;
  const executionId =
    typeof rows?.[0]?.executionId === "string"
      ? rows[0].executionId.trim()
      : "";
  return executionId ? loadPlanExecutionLedger(executionId) : null;
}

export async function saveTaskEvidence(evidence: TaskEvidence): Promise<void> {
  decodeTaskEvidence(evidence);
  await Zotero.DB.queryAsync(
    `INSERT OR IGNORE INTO ${PLAN_TASK_EVIDENCE_TABLE}
      (evidence_id, execution_id, task_id, kind, verified, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      evidence.evidenceId,
      evidence.executionId,
      evidence.taskId,
      evidence.kind,
      evidence.verified ? 1 : 0,
      JSON.stringify(evidence),
      evidence.createdAt,
    ],
  );
}

export async function listTaskEvidence(
  executionId: string,
  taskId: string,
): Promise<TaskEvidence[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_TASK_EVIDENCE_TABLE}
     WHERE execution_id = ? AND task_id = ? ORDER BY created_at ASC`,
    [executionId, taskId],
  )) as JsonRow[] | undefined;
  return (rows || [])
    .map((row) => parsePayload(row, decodeTaskEvidence))
    .filter((evidence): evidence is TaskEvidence => Boolean(evidence));
}

/**
 * Research provenance may be collected by a deep-read task and consumed by a
 * later synthesis task. Recover it from the approved execution boundary rather
 * than from whichever task owns the research job.
 */
export async function listExecutionTaskEvidence(
  executionId: string,
): Promise<TaskEvidence[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_TASK_EVIDENCE_TABLE}
     WHERE execution_id = ? ORDER BY created_at ASC`,
    [executionId],
  )) as JsonRow[] | undefined;
  return (rows || [])
    .map((row) => parsePayload(row, decodeTaskEvidence))
    .filter((evidence): evidence is TaskEvidence => Boolean(evidence));
}

export async function clearPlanConversationRowsInTransaction(
  conversationKey: number,
): Promise<void> {
  const executionRows = (await Zotero.DB.queryAsync(
    `SELECT execution_id AS executionId FROM ${PLAN_EXECUTIONS_TABLE}
     WHERE conversation_key = ?`,
    [conversationKey],
  ).catch((error) => {
    if (/no such table|no table/i.test(String(error))) return [];
    throw error;
  })) as Array<{ executionId?: unknown }>;
  const executionIds = executionRows
    .map((row) =>
      typeof row.executionId === "string" ? row.executionId.trim() : "",
    )
    .filter(Boolean);
  if (executionIds.length) {
    const placeholders = executionIds.map(() => "?").join(", ");
    for (const table of [
      PLAN_TASK_EVIDENCE_TABLE,
      PLAN_TASK_TRANSITIONS_TABLE,
      PLAN_EXECUTION_TASKS_TABLE,
    ]) {
      await Zotero.DB.queryAsync(
        `DELETE FROM ${table} WHERE execution_id IN (${placeholders})`,
        executionIds,
      );
    }
  }
  await Zotero.DB.queryAsync(
    `DELETE FROM ${PLAN_AMENDMENT_PROPOSALS_TABLE} WHERE conversation_key = ?`,
    [conversationKey],
  );
  await Zotero.DB.queryAsync(
    `DELETE FROM ${PLAN_AMENDMENTS_TABLE} WHERE conversation_key = ?`,
    [conversationKey],
  );
  await Zotero.DB.queryAsync(
    `DELETE FROM ${PLAN_EXECUTIONS_TABLE} WHERE conversation_key = ?`,
    [conversationKey],
  );
  await Zotero.DB.queryAsync(
    `DELETE FROM ${PLAN_ARTIFACTS_TABLE} WHERE conversation_key = ?`,
    [conversationKey],
  );
}
