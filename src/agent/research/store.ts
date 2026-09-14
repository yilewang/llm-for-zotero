import type {
  PaperFinding,
  ResearchCorpusItem,
  ResearchEvidenceRecord,
  ResearchJob,
  ResearchScopeSnapshotItem,
  ResearchScopeSnapshotRef,
  ResearchWorkItem,
  ThemeFinding,
  ResearchMutationApprovalGrant,
  ResearchRecallProbe,
  ResearchEdge,
  ResearchOpenQuestion,
} from "./types";
import { decodeResearchEdge, decodeResearchOpenQuestion } from "./graphSchema";
import {
  decodePaperFinding,
  decodeResearchCorpusItem,
  decodeResearchEvidenceRecord,
  decodeResearchJob,
  decodeResearchWorkItem,
  decodeScopeSnapshotItem,
  decodeThemeFinding,
  decodeResearchMutationApprovalGrant,
  decodeResearchRecallProbe,
} from "./decoders";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";

export const PLAN_SCOPE_SNAPSHOTS_TABLE = "llm_for_zotero_plan_scope_snapshots";
export const PLAN_SCOPE_SNAPSHOT_ITEMS_TABLE =
  "llm_for_zotero_plan_scope_snapshot_items";
export const RESEARCH_JOBS_TABLE = "llm_for_zotero_research_jobs";
export const RESEARCH_CORPUS_ITEMS_TABLE =
  "llm_for_zotero_research_corpus_items";
export const RESEARCH_WORK_ITEMS_TABLE = "llm_for_zotero_research_work_items";
export const RESEARCH_EVIDENCE_TABLE = "llm_for_zotero_research_evidence";
export const RESEARCH_RECALL_PROBES_TABLE =
  "llm_for_zotero_research_recall_probes";
export const RESEARCH_PAPER_FINDINGS_TABLE =
  "llm_for_zotero_research_paper_findings";
export const RESEARCH_THEME_FINDINGS_TABLE =
  "llm_for_zotero_research_theme_findings";
export const RESEARCH_MUTATION_APPROVALS_TABLE =
  "llm_for_zotero_research_mutation_approvals";
export const RESEARCH_EDGES_TABLE = "llm_for_zotero_research_edges";
export const RESEARCH_OPEN_QUESTIONS_TABLE =
  "llm_for_zotero_research_open_questions";

type JsonRow = { payloadJson?: unknown };

function parse<T>(
  row: JsonRow | undefined,
  decoder: (value: unknown) => T,
): T | null {
  if (typeof row?.payloadJson !== "string") return null;
  return decoder(JSON.parse(row.payloadJson));
}

export async function initResearchStore(): Promise<void> {
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_SCOPE_SNAPSHOTS_TABLE} (
        snapshot_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        conversation_key INTEGER NOT NULL,
        digest TEXT NOT NULL,
        item_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_plan_scope_snapshot_conversation_idx
       ON ${PLAN_SCOPE_SNAPSHOTS_TABLE} (conversation_key, created_at DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_SCOPE_SNAPSHOT_ITEMS_TABLE} (
        snapshot_id TEXT NOT NULL,
        library_id INTEGER NOT NULL,
        item_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, library_id, item_key)
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_plan_scope_snapshot_items_order_idx
       ON ${PLAN_SCOPE_SNAPSHOT_ITEMS_TABLE} (snapshot_id, ordinal)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_JOBS_TABLE} (
        research_job_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        parent_task_id TEXT NOT NULL,
        conversation_key INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_research_jobs_execution_idx
       ON ${RESEARCH_JOBS_TABLE} (execution_id, updated_at DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_CORPUS_ITEMS_TABLE} (
        research_job_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        parent_task_id TEXT NOT NULL,
        library_id INTEGER NOT NULL,
        item_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        screening_status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (research_job_id, library_id, item_key)
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_research_corpus_status_idx
       ON ${RESEARCH_CORPUS_ITEMS_TABLE}
       (research_job_id, screening_status, ordinal)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_WORK_ITEMS_TABLE} (
        work_item_id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        parent_task_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_research_work_claim_idx
       ON ${RESEARCH_WORK_ITEMS_TABLE}
       (research_job_id, stage, status, updated_at)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_PAPER_FINDINGS_TABLE} (
        finding_id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        parent_task_id TEXT NOT NULL,
        library_id INTEGER NOT NULL,
        item_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_EVIDENCE_TABLE} (
        evidence_ref TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        parent_task_id TEXT NOT NULL,
        library_id INTEGER NOT NULL,
        item_key TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_research_evidence_job_idx
       ON ${RESEARCH_EVIDENCE_TABLE}
       (research_job_id, library_id, item_key, created_at)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_RECALL_PROBES_TABLE} (
        probe_id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        parent_task_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_research_recall_probe_job_idx
       ON ${RESEARCH_RECALL_PROBES_TABLE} (research_job_id, created_at)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE UNIQUE INDEX IF NOT EXISTS llm_research_paper_finding_item_idx
       ON ${RESEARCH_PAPER_FINDINGS_TABLE}
       (research_job_id, library_id, item_key)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_THEME_FINDINGS_TABLE} (
        theme_finding_id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        parent_task_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_MUTATION_APPROVALS_TABLE} (
        grant_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        conversation_key INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        approved_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_research_mutation_approval_execution_idx
       ON ${RESEARCH_MUTATION_APPROVALS_TABLE} (execution_id, approved_at DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_EDGES_TABLE} (
        edge_id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        parent_task_id TEXT NOT NULL,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_research_edges_job_idx
       ON ${RESEARCH_EDGES_TABLE} (research_job_id, lifecycle, created_at)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_OPEN_QUESTIONS_TABLE} (
        question_id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        parent_task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_research_open_questions_job_idx
       ON ${RESEARCH_OPEN_QUESTIONS_TABLE} (research_job_id, lifecycle, created_at)`,
    );
  });
}

export async function saveScopeSnapshot(params: {
  planId: string;
  revision: number;
  conversationKey: number;
  ref: ResearchScopeSnapshotRef;
  items: readonly ResearchScopeSnapshotItem[];
  alreadyInTransaction?: boolean;
}): Promise<void> {
  if (
    params.items.length !== params.ref.itemCount ||
    params.items.some((item) => item.snapshotId !== params.ref.snapshotId)
  ) {
    throw new Error(
      "Scope snapshot items do not match their snapshot reference",
    );
  }
  const write = async () => {
    if (params.ref.parentSnapshotId) {
      const existing = await loadScopeSnapshotRef(params.ref.snapshotId);
      if (existing) {
        const existingItems = await listScopeSnapshotItems(
          params.ref.snapshotId,
        );
        const sameReference =
          existing.digest === params.ref.digest &&
          existing.itemCount === params.ref.itemCount &&
          existing.policyVersion === params.ref.policyVersion &&
          existing.parentSnapshotId === params.ref.parentSnapshotId &&
          existing.scopeLineageDigest === params.ref.scopeLineageDigest;
        if (
          sameReference &&
          canonicalJson(existingItems) === canonicalJson(params.items)
        ) {
          return;
        }
        throw new Error(
          `Effective scope snapshot ${params.ref.snapshotId} is immutable`,
        );
      }
      await Zotero.DB.queryAsync(
        `INSERT INTO ${PLAN_SCOPE_SNAPSHOTS_TABLE}
         (snapshot_id, plan_id, revision, conversation_key, digest, item_count,
          created_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          params.ref.snapshotId,
          params.planId,
          params.revision,
          params.conversationKey,
          params.ref.digest,
          params.ref.itemCount,
          params.ref.createdAt,
          JSON.stringify(params.ref),
        ],
      );
      for (const item of params.items) {
        await Zotero.DB.queryAsync(
          `INSERT INTO ${PLAN_SCOPE_SNAPSHOT_ITEMS_TABLE}
           (snapshot_id, library_id, item_key, ordinal, payload_json)
           VALUES (?, ?, ?, ?, ?)`,
          [
            item.snapshotId,
            item.libraryID,
            item.itemKey,
            item.ordinal,
            JSON.stringify(item),
          ],
        );
      }
      return;
    }
    await Zotero.DB.queryAsync(
      `INSERT OR REPLACE INTO ${PLAN_SCOPE_SNAPSHOTS_TABLE}
       (snapshot_id, plan_id, revision, conversation_key, digest, item_count,
        created_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.ref.snapshotId,
        params.planId,
        params.revision,
        params.conversationKey,
        params.ref.digest,
        params.ref.itemCount,
        params.ref.createdAt,
        JSON.stringify(params.ref),
      ],
    );
    await Zotero.DB.queryAsync(
      `DELETE FROM ${PLAN_SCOPE_SNAPSHOT_ITEMS_TABLE} WHERE snapshot_id = ?`,
      [params.ref.snapshotId],
    );
    for (const item of params.items) {
      await Zotero.DB.queryAsync(
        `INSERT INTO ${PLAN_SCOPE_SNAPSHOT_ITEMS_TABLE}
         (snapshot_id, library_id, item_key, ordinal, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
        [
          item.snapshotId,
          item.libraryID,
          item.itemKey,
          item.ordinal,
          JSON.stringify(item),
        ],
      );
    }
  };
  if (params.alreadyInTransaction) await write();
  else await Zotero.DB.executeTransaction(write);
}

export async function listScopeSnapshotItems(
  snapshotId: string,
): Promise<ResearchScopeSnapshotItem[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson
     FROM ${PLAN_SCOPE_SNAPSHOT_ITEMS_TABLE}
     WHERE snapshot_id = ? ORDER BY ordinal ASC`,
    [snapshotId],
  )) as JsonRow[] | undefined;
  return (rows || [])
    .map((row) => parse(row, decodeScopeSnapshotItem))
    .filter((item): item is ResearchScopeSnapshotItem => Boolean(item));
}

export async function loadScopeSnapshotRef(
  snapshotId: string,
): Promise<ResearchScopeSnapshotRef | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_SCOPE_SNAPSHOTS_TABLE}
     WHERE snapshot_id = ? LIMIT 1`,
    [snapshotId],
  )) as JsonRow[] | undefined;
  if (typeof rows?.[0]?.payloadJson !== "string") return null;
  const value = JSON.parse(rows[0].payloadJson) as ResearchScopeSnapshotRef;
  return value?.snapshotId === snapshotId ? value : null;
}

export async function saveResearchJob(
  job: ResearchJob,
  conversationKey: number,
): Promise<void> {
  const decoded = decodeResearchJob(job);
  // Version 3 only carries the network fields; a job without them stays
  // readable by builds that predate the research graph.
  const usesGraphFields =
    decoded.frame !== undefined ||
    decoded.synthesisPhase !== undefined ||
    decoded.nodeCapacity !== undefined ||
    decoded.qualityReport !== undefined;
  const stored: ResearchJob = {
    ...decoded,
    version: usesGraphFields ? 3 : 2,
    baseSnapshotId: decoded.baseSnapshotId || decoded.snapshotId,
    scopeLineageDigest:
      decoded.scopeLineageDigest || `legacy:${decoded.snapshotId}`,
  };
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${RESEARCH_JOBS_TABLE}
     (research_job_id, execution_id, parent_task_id, conversation_key, status,
      payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      stored.researchJobId,
      stored.executionId,
      stored.parentTaskId,
      conversationKey,
      stored.status,
      JSON.stringify(stored),
      stored.createdAt,
      stored.updatedAt,
    ],
  );
}

export async function loadResearchJob(
  researchJobId: string,
): Promise<ResearchJob | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${RESEARCH_JOBS_TABLE}
     WHERE research_job_id = ? LIMIT 1`,
    [researchJobId],
  )) as JsonRow[] | undefined;
  return parse(rows?.[0], decodeResearchJob);
}

export async function loadResearchJobForExecution(
  executionId: string,
): Promise<ResearchJob | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${RESEARCH_JOBS_TABLE}
     WHERE execution_id = ? ORDER BY updated_at DESC LIMIT 1`,
    [executionId],
  )) as JsonRow[] | undefined;
  return parse(rows?.[0], decodeResearchJob);
}

export async function interruptResearchExecution(params: {
  executionId: string;
  conversationKey: number;
  now?: number;
}): Promise<ResearchJob | null> {
  const job = await loadResearchJobForExecution(params.executionId);
  if (!job) return null;
  if (["completed", "failed", "cancelled"].includes(job.status)) return job;
  const now = params.now ?? Date.now();
  const interrupted: ResearchJob = {
    ...job,
    status: "interrupted",
    updatedAt: now,
    completedAt: undefined,
  };
  await Zotero.DB.executeTransaction(async () => {
    await saveResearchJob(interrupted, params.conversationKey);
    const issued = await listResearchWorkItems({
      researchJobId: job.researchJobId,
      statuses: ["in_progress"],
    });
    for (const item of issued) {
      await saveResearchWorkItem({
        ...item,
        status: "interrupted",
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
      });
    }
  });
  return interrupted;
}

export async function saveResearchCorpusItem(
  item: ResearchCorpusItem,
): Promise<void> {
  decodeResearchCorpusItem(item);
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${RESEARCH_CORPUS_ITEMS_TABLE}
     (research_job_id, execution_id, parent_task_id, library_id, item_key,
      ordinal, screening_status, payload_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      item.researchJobId,
      item.executionId,
      item.parentTaskId,
      item.libraryID,
      item.itemKey,
      item.ordinal,
      item.screeningStatus,
      JSON.stringify(item),
      item.updatedAt,
    ],
  );
}

export async function appendResearchCorpusItem(
  item: ResearchCorpusItem,
): Promise<void> {
  decodeResearchCorpusItem(item);
  await Zotero.DB.queryAsync(
    `INSERT OR IGNORE INTO ${RESEARCH_CORPUS_ITEMS_TABLE}
     (research_job_id, execution_id, parent_task_id, library_id, item_key,
      ordinal, screening_status, payload_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      item.researchJobId,
      item.executionId,
      item.parentTaskId,
      item.libraryID,
      item.itemKey,
      item.ordinal,
      item.screeningStatus,
      JSON.stringify(item),
      item.updatedAt,
    ],
  );
}

export async function listResearchCorpusItems(params: {
  researchJobId: string;
  statuses?: readonly ResearchCorpusItem["screeningStatus"][];
}): Promise<ResearchCorpusItem[]> {
  const statuses = params.statuses?.length ? [...params.statuses] : [];
  const where = statuses.length
    ? `research_job_id = ? AND screening_status IN (${statuses.map(() => "?").join(", ")})`
    : "research_job_id = ?";
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${RESEARCH_CORPUS_ITEMS_TABLE}
     WHERE ${where} ORDER BY ordinal ASC`,
    [params.researchJobId, ...statuses],
  )) as JsonRow[] | undefined;
  return (rows || [])
    .map((row) => parse(row, decodeResearchCorpusItem))
    .filter((item): item is ResearchCorpusItem => Boolean(item));
}

export async function saveResearchWorkItem(
  item: ResearchWorkItem,
): Promise<void> {
  decodeResearchWorkItem(item);
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${RESEARCH_WORK_ITEMS_TABLE}
     (work_item_id, research_job_id, execution_id, parent_task_id, stage,
      status, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      item.workItemId,
      item.researchJobId,
      item.executionId,
      item.parentTaskId,
      item.stage,
      item.status,
      JSON.stringify(item),
      item.createdAt,
      item.updatedAt,
    ],
  );
}

export async function listResearchWorkItems(params: {
  researchJobId: string;
  stage?: ResearchWorkItem["stage"];
  statuses?: readonly ResearchWorkItem["status"][];
}): Promise<ResearchWorkItem[]> {
  const values: unknown[] = [params.researchJobId];
  const clauses = ["research_job_id = ?"];
  if (params.stage) {
    clauses.push("stage = ?");
    values.push(params.stage);
  }
  if (params.statuses?.length) {
    clauses.push(`status IN (${params.statuses.map(() => "?").join(", ")})`);
    values.push(...params.statuses);
  }
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${RESEARCH_WORK_ITEMS_TABLE}
     WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC`,
    values,
  )) as JsonRow[] | undefined;
  return (rows || [])
    .map((row) => parse(row, decodeResearchWorkItem))
    .filter((item): item is ResearchWorkItem => Boolean(item));
}

export async function claimResearchWorkItems(params: {
  researchJobId: string;
  stage: ResearchWorkItem["stage"];
  leaseOwner: string;
  limit: number;
  now?: number;
  leaseMs?: number;
}): Promise<ResearchWorkItem[]> {
  const now = params.now ?? Date.now();
  const leaseExpiresAt = now + Math.max(1, params.leaseMs ?? 60_000);
  const claimed: ResearchWorkItem[] = [];
  await Zotero.DB.executeTransaction(async () => {
    const expired = (await Zotero.DB.queryAsync(
      `SELECT payload_json AS payloadJson
       FROM ${RESEARCH_WORK_ITEMS_TABLE}
       WHERE research_job_id = ? AND stage = ? AND status = 'in_progress'`,
      [params.researchJobId, params.stage],
    )) as JsonRow[] | undefined;
    for (const row of expired || []) {
      const item = parse(row, decodeResearchWorkItem);
      if (!item || !item.leaseExpiresAt || item.leaseExpiresAt > now) continue;
      await saveResearchWorkItem({
        ...item,
        status: "interrupted",
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
      });
    }
    const rows = (await Zotero.DB.queryAsync(
      `SELECT payload_json AS payloadJson
       FROM ${RESEARCH_WORK_ITEMS_TABLE}
       WHERE research_job_id = ? AND stage = ?
         AND (status = 'pending' OR status = 'interrupted')
       ORDER BY created_at ASC LIMIT ?`,
      [params.researchJobId, params.stage, Math.max(1, params.limit)],
    )) as JsonRow[] | undefined;
    for (const row of rows || []) {
      const item = parse(row, decodeResearchWorkItem);
      if (!item) continue;
      const next: ResearchWorkItem = {
        ...item,
        status: "in_progress",
        attemptCount: item.attemptCount + 1,
        leaseOwner: params.leaseOwner,
        leaseExpiresAt,
        updatedAt: now,
      };
      await saveResearchWorkItem(next);
      claimed.push(next);
    }
  });
  return claimed;
}

export async function loadResearchWorkItem(
  workItemId: string,
): Promise<ResearchWorkItem | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${RESEARCH_WORK_ITEMS_TABLE}
     WHERE work_item_id = ? LIMIT 1`,
    [workItemId],
  )) as JsonRow[] | undefined;
  return parse(rows?.[0], decodeResearchWorkItem);
}

export async function savePaperFinding(finding: PaperFinding): Promise<void> {
  decodePaperFinding(finding);
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${RESEARCH_PAPER_FINDINGS_TABLE}
     (finding_id, research_job_id, execution_id, parent_task_id, library_id,
      item_key, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      finding.findingId,
      finding.researchJobId,
      finding.executionId,
      finding.parentTaskId,
      finding.libraryID,
      finding.itemKey,
      JSON.stringify(finding),
      finding.createdAt,
    ],
  );
}

export async function saveResearchEvidence(
  evidence: ResearchEvidenceRecord,
): Promise<void> {
  decodeResearchEvidenceRecord(evidence);
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${RESEARCH_EVIDENCE_TABLE}
     (evidence_ref, research_job_id, execution_id, parent_task_id, library_id,
      item_key, source_kind, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      evidence.evidenceRef,
      evidence.researchJobId,
      evidence.executionId,
      evidence.parentTaskId,
      evidence.libraryID,
      evidence.itemKey,
      evidence.sourceKind,
      JSON.stringify(evidence),
      evidence.createdAt,
    ],
  );
}

export async function listResearchEvidence(
  researchJobId: string,
): Promise<ResearchEvidenceRecord[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${RESEARCH_EVIDENCE_TABLE}
     WHERE research_job_id = ? ORDER BY created_at ASC`,
    [researchJobId],
  )) as JsonRow[] | undefined;
  return (rows || [])
    .map((row) => parse(row, decodeResearchEvidenceRecord))
    .filter((evidence): evidence is ResearchEvidenceRecord =>
      Boolean(evidence),
    );
}

export async function loadResearchEvidence(
  evidenceRef: string,
): Promise<ResearchEvidenceRecord | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${RESEARCH_EVIDENCE_TABLE}
     WHERE evidence_ref = ? LIMIT 1`,
    [evidenceRef],
  )) as JsonRow[] | undefined;
  return parse(rows?.[0], decodeResearchEvidenceRecord);
}

export async function saveResearchRecallProbe(
  probe: ResearchRecallProbe,
): Promise<void> {
  decodeResearchRecallProbe(probe);
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${RESEARCH_RECALL_PROBES_TABLE}
     (probe_id, research_job_id, execution_id, parent_task_id, payload_json,
      created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      probe.probeId,
      probe.researchJobId,
      probe.executionId,
      probe.parentTaskId,
      JSON.stringify(probe),
      probe.createdAt,
    ],
  );
}

export async function listResearchRecallProbes(
  researchJobId: string,
): Promise<ResearchRecallProbe[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${RESEARCH_RECALL_PROBES_TABLE}
     WHERE research_job_id = ? ORDER BY created_at ASC`,
    [researchJobId],
  )) as JsonRow[] | undefined;
  return (rows || [])
    .map((row) => parse(row, decodeResearchRecallProbe))
    .filter((probe): probe is ResearchRecallProbe => Boolean(probe));
}

export async function listPaperFindings(
  researchJobId: string,
): Promise<PaperFinding[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${RESEARCH_PAPER_FINDINGS_TABLE}
     WHERE research_job_id = ? ORDER BY created_at ASC`,
    [researchJobId],
  )) as JsonRow[] | undefined;
  return (rows || [])
    .map((row) => parse(row, decodePaperFinding))
    .filter((finding): finding is PaperFinding => Boolean(finding));
}

export async function saveThemeFinding(finding: ThemeFinding): Promise<void> {
  decodeThemeFinding(finding);
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${RESEARCH_THEME_FINDINGS_TABLE}
     (theme_finding_id, research_job_id, execution_id, parent_task_id,
      payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      finding.themeFindingId,
      finding.researchJobId,
      finding.executionId,
      finding.parentTaskId,
      JSON.stringify(finding),
      finding.createdAt,
    ],
  );
}

export async function listThemeFindings(
  researchJobId: string,
  scopeLineageDigest?: string,
): Promise<ThemeFinding[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${RESEARCH_THEME_FINDINGS_TABLE}
     WHERE research_job_id = ? ORDER BY created_at ASC`,
    [researchJobId],
  )) as JsonRow[] | undefined;
  return (rows || [])
    .map((row) => parse(row, decodeThemeFinding))
    .filter((finding): finding is ThemeFinding =>
      Boolean(
        finding &&
        finding.status !== "invalidated" &&
        (!scopeLineageDigest ||
          !finding.scopeLineageDigest ||
          finding.scopeLineageDigest === scopeLineageDigest),
      ),
    );
}

export async function invalidateThemeFindings(
  researchJobId: string,
  now = Date.now(),
): Promise<void> {
  const findings = await listThemeFindings(researchJobId);
  for (const finding of findings) {
    const invalidated: ThemeFinding = {
      ...finding,
      version: 2,
      status: "invalidated",
      invalidatedAt: now,
    };
    await saveThemeFinding(invalidated);
  }
}

export async function saveResearchEdge(edge: ResearchEdge): Promise<void> {
  decodeResearchEdge(edge);
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${RESEARCH_EDGES_TABLE}
     (edge_id, research_job_id, execution_id, parent_task_id, source, target,
      type, status, lifecycle, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      edge.edgeId,
      edge.researchJobId,
      edge.executionId,
      edge.parentTaskId,
      edge.source,
      edge.target,
      edge.type,
      edge.status,
      edge.lifecycle,
      JSON.stringify(edge),
      edge.createdAt,
      edge.updatedAt,
    ],
  );
}

export async function listResearchEdges(
  researchJobId: string,
  options: { includeInvalidated?: boolean } = {},
): Promise<ResearchEdge[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${RESEARCH_EDGES_TABLE}
     WHERE research_job_id = ?${
       options.includeInvalidated ? "" : " AND lifecycle = 'valid'"
     } ORDER BY created_at ASC, edge_id ASC`,
    [researchJobId],
  )) as JsonRow[] | undefined;
  return (rows || [])
    .map((row) => parse(row, decodeResearchEdge))
    .filter((edge): edge is ResearchEdge => Boolean(edge));
}

export async function saveResearchOpenQuestion(
  question: ResearchOpenQuestion,
): Promise<void> {
  decodeResearchOpenQuestion(question);
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${RESEARCH_OPEN_QUESTIONS_TABLE}
     (question_id, research_job_id, execution_id, parent_task_id, status,
      lifecycle, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      question.questionId,
      question.researchJobId,
      question.executionId,
      question.parentTaskId,
      question.status,
      question.lifecycle,
      JSON.stringify(question),
      question.createdAt,
      question.updatedAt,
    ],
  );
}

export async function listResearchOpenQuestions(
  researchJobId: string,
  options: { includeInvalidated?: boolean } = {},
): Promise<ResearchOpenQuestion[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${RESEARCH_OPEN_QUESTIONS_TABLE}
     WHERE research_job_id = ?${
       options.includeInvalidated ? "" : " AND lifecycle = 'valid'"
     } ORDER BY created_at ASC, question_id ASC`,
    [researchJobId],
  )) as JsonRow[] | undefined;
  return (rows || [])
    .map((row) => parse(row, decodeResearchOpenQuestion))
    .filter((question): question is ResearchOpenQuestion => Boolean(question));
}

/**
 * A superseded scope lineage invalidates every cross-paper reduction at once:
 * themes, edges and open questions. Per-paper nodes stay; their fingerprints
 * are re-checked at finalization.
 */
export async function invalidateResearchGraph(
  researchJobId: string,
  now = Date.now(),
): Promise<void> {
  await invalidateThemeFindings(researchJobId, now);
  for (const edge of await listResearchEdges(researchJobId)) {
    await saveResearchEdge({
      ...edge,
      lifecycle: "invalidated",
      invalidatedAt: now,
      updatedAt: now,
    });
  }
  for (const question of await listResearchOpenQuestions(researchJobId)) {
    await saveResearchOpenQuestion({
      ...question,
      lifecycle: "invalidated",
      invalidatedAt: now,
      updatedAt: now,
    });
  }
}

export async function saveResearchMutationApprovalGrant(
  grant: ResearchMutationApprovalGrant,
): Promise<void> {
  decodeResearchMutationApprovalGrant(grant);
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${RESEARCH_MUTATION_APPROVALS_TABLE}
     (grant_id, execution_id, conversation_key, status, payload_json, approved_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      grant.grantId,
      grant.executionId,
      grant.conversationKey,
      grant.status,
      JSON.stringify(grant),
      grant.approvedAt,
    ],
  );
}

export async function loadLatestResearchMutationApprovalGrant(
  executionId: string,
): Promise<ResearchMutationApprovalGrant | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson
     FROM ${RESEARCH_MUTATION_APPROVALS_TABLE}
     WHERE execution_id = ? ORDER BY approved_at DESC LIMIT 1`,
    [executionId],
  )) as JsonRow[] | undefined;
  if (typeof rows?.[0]?.payloadJson !== "string") return null;
  const value = decodeResearchMutationApprovalGrant(
    JSON.parse(rows[0].payloadJson),
  );
  if (value.executionId !== executionId) {
    throw new Error("Research mutation approval belongs to another execution");
  }
  return value;
}

export async function invalidateLatestResearchMutationApprovalGrant(
  executionId: string,
  now = Date.now(),
): Promise<void> {
  const grant = await loadLatestResearchMutationApprovalGrant(executionId);
  if (!grant || grant.status !== "approved") return;
  await saveResearchMutationApprovalGrant({
    ...grant,
    status: "invalidated",
    invalidatedAt: now,
  });
}

export async function clearResearchConversationRowsInTransaction(
  conversationKey: number,
): Promise<void> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT research_job_id AS researchJobId FROM ${RESEARCH_JOBS_TABLE}
     WHERE conversation_key = ?`,
    [conversationKey],
  ).catch((error) => {
    if (/no such table|no table/i.test(String(error))) return [];
    throw error;
  })) as Array<{ researchJobId?: unknown }>;
  const jobIds = rows
    .map((row) =>
      typeof row.researchJobId === "string" ? row.researchJobId : "",
    )
    .filter(Boolean);
  if (jobIds.length) {
    const placeholders = jobIds.map(() => "?").join(", ");
    for (const table of [
      RESEARCH_EDGES_TABLE,
      RESEARCH_OPEN_QUESTIONS_TABLE,
      RESEARCH_THEME_FINDINGS_TABLE,
      RESEARCH_PAPER_FINDINGS_TABLE,
      RESEARCH_RECALL_PROBES_TABLE,
      RESEARCH_EVIDENCE_TABLE,
      RESEARCH_WORK_ITEMS_TABLE,
      RESEARCH_CORPUS_ITEMS_TABLE,
    ]) {
      await Zotero.DB.queryAsync(
        `DELETE FROM ${table} WHERE research_job_id IN (${placeholders})`,
        jobIds,
      );
    }
  }
  await Zotero.DB.queryAsync(
    `DELETE FROM ${RESEARCH_MUTATION_APPROVALS_TABLE}
     WHERE conversation_key = ?`,
    [conversationKey],
  );
  await Zotero.DB.queryAsync(
    `DELETE FROM ${RESEARCH_JOBS_TABLE} WHERE conversation_key = ?`,
    [conversationKey],
  );
  const snapshots = (await Zotero.DB.queryAsync(
    `SELECT snapshot_id AS snapshotId FROM ${PLAN_SCOPE_SNAPSHOTS_TABLE}
     WHERE conversation_key = ?`,
    [conversationKey],
  ).catch((error) => {
    if (/no such table|no table/i.test(String(error))) return [];
    throw error;
  })) as Array<{ snapshotId?: unknown }>;
  const snapshotIds = snapshots
    .map((row) => (typeof row.snapshotId === "string" ? row.snapshotId : ""))
    .filter(Boolean);
  if (snapshotIds.length) {
    const placeholders = snapshotIds.map(() => "?").join(", ");
    await Zotero.DB.queryAsync(
      `DELETE FROM ${PLAN_SCOPE_SNAPSHOT_ITEMS_TABLE}
       WHERE snapshot_id IN (${placeholders})`,
      snapshotIds,
    );
  }
  await Zotero.DB.queryAsync(
    `DELETE FROM ${PLAN_SCOPE_SNAPSHOTS_TABLE} WHERE conversation_key = ?`,
    [conversationKey],
  );
}
